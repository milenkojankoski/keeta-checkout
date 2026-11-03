/**
 * SQLite session store, on Node's built-in `node:sqlite`.
 *
 * No native dependency and no build step, which matters for a package merchants are
 * meant to self-host in an afternoon. On Node 22 the module prints an
 * `ExperimentalWarning` once at startup; on Node 24, the version this project
 * targets, it does not.
 *
 * Three things in here exist because money does:
 *
 * - **Amounts are stored as TEXT.** SQLite's INTEGER is 64-bit, and a token with 18
 *   decimals (KTA) passes 2^63 base units at about 9.2 whole units. Text holds any
 *   `bigint` exactly, and `BigInt()` reads it back without loss.
 * - **Every transition runs inside `BEGIN IMMEDIATE`.** The read and the write of a
 *   status change are one unit, so two watcher processes cannot both see an `open`
 *   session and both pay it.
 * - **The payments ledger is keyed on (block hash, operation index).** Re-scanning
 *   the chain after a restart finds the row already there and changes nothing.
 */
import { DatabaseSync } from 'node:sqlite';
import type { DeliveriesQuery, DeliveryStatus, WebhookDelivery, WebhookEventType } from '../webhooks/types.ts';
import type { NewRefund, Refund, RefundOrigin, RefundReason, RefundResultUpdate, RefundStatus, RefundsQuery } from '../refunds/types.ts';
import {
  applyRefundResult,
  applyMarkPaid,
  applyMarkUnmatched,
  cloneSession,
  StoreError,
  type DeliveryResultUpdate,
  type PaymentDisposition,
  type PaymentRecord,
  type PaymentRow,
  type PaymentsQuery,
  type SessionStore
} from './store.ts';
import type { Session, SessionStatus } from './types.ts';

interface SessionRowShape {
  id: string;
  reference: string;
  order_id: string;
  amount: string;
  token_address: string;
  token_ticker: string | null;
  token_decimals: number;
  receiving_address: string;
  network: string;
  status: string;
  created_at: number;
  expires_at: number;
  grace_until: number;
  success_url: string;
  cancel_url: string;
  paid_by: string | null;
  block_hash: string | null;
  operation_index: number | null;
  paid_at: number | null;
  overpaid_by: string | null;
  updated_at: number;
}

interface PaymentRowShape {
  block_hash: string;
  operation_index: number;
  from_address: string;
  to_address: string;
  token_address: string;
  amount: string;
  external: string | null;
  block_date: number;
  session_id: string | null;
  disposition: string;
  observed_at: number;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  reference         TEXT NOT NULL UNIQUE,
  order_id          TEXT NOT NULL,
  amount            TEXT NOT NULL,
  token_address     TEXT NOT NULL,
  token_ticker      TEXT,
  token_decimals    INTEGER NOT NULL,
  receiving_address TEXT NOT NULL,
  network           TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  grace_until       INTEGER NOT NULL,
  success_url       TEXT NOT NULL,
  cancel_url        TEXT NOT NULL,
  paid_by           TEXT,
  block_hash        TEXT,
  paid_at           INTEGER,
  overpaid_by       TEXT,
  updated_at        INTEGER NOT NULL
);

-- The sweeper's query: open sessions whose deadline has passed.
CREATE INDEX IF NOT EXISTS sessions_status_expires ON sessions(status, expires_at);
-- Listings, newest first.
CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at DESC);
`;

/** Version 2: the operation index on sessions, the payments ledger, and the meta slots. */
const MIGRATION_V2 = `
ALTER TABLE sessions ADD COLUMN operation_index INTEGER;

CREATE TABLE IF NOT EXISTS payments (
  block_hash      TEXT NOT NULL,
  operation_index INTEGER NOT NULL,
  from_address    TEXT NOT NULL,
  to_address      TEXT NOT NULL,
  token_address   TEXT NOT NULL,
  amount          TEXT NOT NULL,
  external        TEXT,
  block_date      INTEGER NOT NULL,
  session_id      TEXT,
  disposition     TEXT NOT NULL,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (block_hash, operation_index)
);

CREATE INDEX IF NOT EXISTS payments_disposition_date ON payments(disposition, block_date DESC);
CREATE INDEX IF NOT EXISTS payments_session ON payments(session_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Version 3: the webhook delivery queue. */
const MIGRATION_V3 = `
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               TEXT PRIMARY KEY,
  event_id         TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  endpoint_url     TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL,
  next_attempt_at  INTEGER NOT NULL,
  last_error       TEXT,
  last_status_code INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  delivered_at     INTEGER
);

-- The dispatcher's query: pending deliveries that are due.
CREATE INDEX IF NOT EXISTS webhook_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS webhook_event ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS webhook_created ON webhook_deliveries(created_at DESC);
`;

/**
 * Version 4: the refund ledger (docs/decisions/0014).
 *
 * The unique index on the payment key is what makes "one refund per payment" a
 * property of the data rather than of the code that writes it. Amounts are TEXT,
 * as in `payments`, so a bigint survives untouched.
 */
const MIGRATION_V4 = `
CREATE TABLE IF NOT EXISTS refunds (
  id                      TEXT PRIMARY KEY,
  payment_block_hash      TEXT NOT NULL,
  payment_operation_index INTEGER NOT NULL,
  session_id              TEXT,
  to_address              TEXT NOT NULL,
  token_address           TEXT NOT NULL,
  amount                  TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  origin                  TEXT NOT NULL,
  status                  TEXT NOT NULL,
  attempts                INTEGER NOT NULL,
  attempt_started_at      INTEGER,
  block_hash              TEXT,
  last_error              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  published_at            INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS refunds_payment ON refunds(payment_block_hash, payment_operation_index);
CREATE INDEX IF NOT EXISTS refunds_status_created ON refunds(status, created_at);
CREATE INDEX IF NOT EXISTS refunds_created ON refunds(created_at DESC);
CREATE INDEX IF NOT EXISTS refunds_token_attempt ON refunds(token_address, attempt_started_at);
`;

const CURRENT_VERSION = 4;

function toSession(row: SessionRowShape): Session {
  return {
    id: row.id,
    reference: row.reference,
    orderId: row.order_id,
    amount: BigInt(row.amount),
    tokenAddress: row.token_address,
    tokenTicker: row.token_ticker,
    tokenDecimals: row.token_decimals,
    receivingAddress: row.receiving_address,
    network: row.network,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    graceUntil: row.grace_until,
    successUrl: row.success_url,
    cancelUrl: row.cancel_url,
    paidBy: row.paid_by,
    blockHash: row.block_hash,
    operationIndex: row.operation_index,
    paidAt: row.paid_at,
    overpaidBy: row.overpaid_by === null ? null : BigInt(row.overpaid_by),
    updatedAt: row.updated_at
  };
}

function toPayment(row: PaymentRowShape): PaymentRow {
  return {
    blockHash: row.block_hash,
    operationIndex: row.operation_index,
    from: row.from_address,
    to: row.to_address,
    tokenAddress: row.token_address,
    amount: BigInt(row.amount),
    external: row.external,
    blockDate: row.block_date,
    sessionId: row.session_id,
    disposition: row.disposition as PaymentDisposition,
    observedAt: row.observed_at
  };
}

interface DeliveryRowShape {
  id: string;
  event_id: string;
  event_type: string;
  endpoint_url: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  last_status_code: number | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

function toDelivery(row: DeliveryRowShape): WebhookDelivery {
  return {
    id: row.id,
    eventId: row.event_id,
    eventType: row.event_type as WebhookEventType,
    endpointUrl: row.endpoint_url,
    payload: row.payload,
    status: row.status as DeliveryStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    lastStatusCode: row.last_status_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at
  };
}

interface RefundRowShape {
  id: string;
  payment_block_hash: string;
  payment_operation_index: number;
  session_id: string | null;
  to_address: string;
  token_address: string;
  amount: string;
  reason: string;
  origin: string;
  status: string;
  attempts: number;
  attempt_started_at: number | null;
  block_hash: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
}

function toRefund(row: RefundRowShape): Refund {
  return {
    id: row.id,
    paymentBlockHash: row.payment_block_hash,
    paymentOperationIndex: row.payment_operation_index,
    sessionId: row.session_id,
    to: row.to_address,
    tokenAddress: row.token_address,
    amount: BigInt(row.amount),
    reason: row.reason as RefundReason,
    origin: row.origin as RefundOrigin,
    status: row.status as RefundStatus,
    attempts: row.attempts,
    attemptStartedAt: row.attempt_started_at,
    blockHash: row.block_hash,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at
  };
}

const REFUND_COLUMNS = `id, payment_block_hash, payment_operation_index, session_id, to_address, token_address,
  amount, reason, origin, status, attempts, attempt_started_at, block_hash, last_error, created_at, updated_at, published_at`;

export interface SqliteSessionStoreOptions {
  /** File path, or `:memory:` for a throwaway database. */
  filename: string;
}

export class SqliteSessionStore implements SessionStore {
  readonly #db: DatabaseSync;
  #closed = false;

  constructor(options: SqliteSessionStoreOptions) {
    this.#db = new DatabaseSync(options.filename);
    // Readers do not block the writer, which keeps the pay page responsive while
    // the watcher writes. Harmless on an in-memory database.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    // Wait rather than fail when another process holds the write lock.
    this.#db.exec('PRAGMA busy_timeout = 5000');
    try {
      this.#migrate();
    } catch (error) {
      // Do not leave an open file handle behind a failed construction: on Windows
      // it keeps the database locked for the rest of the process.
      this.#db.close();
      throw error;
    }
  }

  #migrate(): void {
    this.#db.exec(SCHEMA_V1);

    const row = this.#db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;

    let version: number;
    if (row === undefined) {
      // A fresh database starts at version 1 and takes the same migration path as
      // an upgraded one, so there is only one path to test.
      this.#db.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
      version = 1;
    } else {
      version = row.version;
    }

    if (version > CURRENT_VERSION) {
      throw new Error(
        `this database is at schema version ${version} but this build understands ${CURRENT_VERSION}; upgrade the server`
      );
    }

    if (version < 2) {
      this.#transact(() => {
        this.#db.exec(MIGRATION_V2);
        this.#db.prepare('UPDATE schema_version SET version = 2').run();
      });
    }
    if (version < 3) {
      this.#transact(() => {
        this.#db.exec(MIGRATION_V3);
        this.#db.prepare('UPDATE schema_version SET version = 3').run();
      });
    }
    if (version < 4) {
      this.#transact(() => {
        this.#db.exec(MIGRATION_V4);
        this.#db.prepare('UPDATE schema_version SET version = 4').run();
      });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('session store is closed');
  }

  /** Run `fn` inside an immediate transaction, rolling back if it throws. */
  #transact<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async create(session: Session): Promise<Session> {
    this.#assertOpen();

    const existingId = this.#db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session.id);
    if (existingId !== undefined) {
      throw new StoreError('DUPLICATE_ID', `session ${session.id} already exists`);
    }
    const existingReference = this.#db.prepare('SELECT 1 FROM sessions WHERE reference = ?').get(session.reference);
    if (existingReference !== undefined) {
      throw new StoreError('DUPLICATE_REFERENCE', `payment reference for ${session.id} is already in use`);
    }

    this.#db
      .prepare(
        `INSERT INTO sessions (
           id, reference, order_id, amount, token_address, token_ticker, token_decimals,
           receiving_address, network, status, created_at, expires_at, grace_until,
           success_url, cancel_url, paid_by, block_hash, operation_index, paid_at, overpaid_by, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.reference,
        session.orderId,
        session.amount.toString(),
        session.tokenAddress,
        session.tokenTicker,
        session.tokenDecimals,
        session.receivingAddress,
        session.network,
        session.status,
        session.createdAt,
        session.expiresAt,
        session.graceUntil,
        session.successUrl,
        session.cancelUrl,
        session.paidBy,
        session.blockHash,
        session.operationIndex,
        session.paidAt,
        session.overpaidBy === null ? null : session.overpaidBy.toString(),
        session.updatedAt
      );

    return cloneSession(session);
  }

  async get(id: string): Promise<Session | undefined> {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRowShape | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  async getByReference(reference: string): Promise<Session | undefined> {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM sessions WHERE reference = ?').get(reference) as unknown as
      | SessionRowShape
      | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  #requireRow(id: string): Session {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as SessionRowShape | undefined;
    if (row === undefined) throw new StoreError('SESSION_NOT_FOUND', `no session ${id}`);
    return toSession(row);
  }

  #writePaymentFields(session: Session): void {
    this.#db
      .prepare(
        `UPDATE sessions
            SET status = ?, paid_by = ?, block_hash = ?, operation_index = ?, paid_at = ?, overpaid_by = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        session.status,
        session.paidBy,
        session.blockHash,
        session.operationIndex,
        session.paidAt,
        session.overpaidBy === null ? null : session.overpaidBy.toString(),
        session.updatedAt,
        session.id
      );
  }

  async markPaid(id: string, payment: PaymentRecord): Promise<Session> {
    this.#assertOpen();
    return this.#transact(() => {
      const session = this.#requireRow(id);
      const { changed } = applyMarkPaid(session, payment);
      if (changed) this.#writePaymentFields(session);
      return session;
    });
  }

  async markUnmatched(id: string, payment: PaymentRecord): Promise<Session> {
    this.#assertOpen();
    return this.#transact(() => {
      const session = this.#requireRow(id);
      const { changed } = applyMarkUnmatched(session, payment);
      if (changed) {
        this.#db
          .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
          .run(session.status, session.updatedAt, id);
      }
      return session;
    });
  }

  async cancel(id: string): Promise<Session> {
    this.#assertOpen();
    return this.#transact(() => {
      const session = this.#requireRow(id);

      if (session.status === 'cancelled') return session;
      if (session.status !== 'open') {
        throw new StoreError('INVALID_TRANSITION', `session ${id} is ${session.status}, so it cannot be cancelled`);
      }

      session.status = 'cancelled';
      session.updatedAt = Date.now();
      this.#db
        .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
        .run(session.status, session.updatedAt, id);
      return session;
    });
  }

  async expireDue(now = Date.now()): Promise<Session[]> {
    this.#assertOpen();
    return this.#transact(() => {
      const rows = this.#db
        .prepare("SELECT * FROM sessions WHERE status = 'open' AND expires_at <= ?")
        .all(now) as unknown as SessionRowShape[];
      if (rows.length === 0) return [];

      this.#db
        .prepare("UPDATE sessions SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at <= ?")
        .run(now, now);

      return rows.map((row) => toSession({ ...row, status: 'expired', updated_at: now }));
    });
  }

  async listByStatus(statuses: readonly SessionStatus[], limit = 100): Promise<Session[]> {
    this.#assertOpen();
    if (statuses.length === 0) return [];

    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.#db
      .prepare(`SELECT * FROM sessions WHERE status IN (${placeholders}) ORDER BY created_at DESC LIMIT ?`)
      .all(...statuses, limit) as unknown as SessionRowShape[];
    return rows.map(toSession);
  }

  async recordPayment(
    row: Omit<PaymentRow, 'observedAt'> & { observedAt?: number }
  ): Promise<{ inserted: boolean; payment: PaymentRow }> {
    this.#assertOpen();
    return this.#transact(() => {
      const existing = this.#db
        .prepare('SELECT * FROM payments WHERE block_hash = ? AND operation_index = ?')
        .get(row.blockHash, row.operationIndex) as unknown as PaymentRowShape | undefined;
      if (existing !== undefined) return { inserted: false, payment: toPayment(existing) };

      const stored: PaymentRow = { ...row, observedAt: row.observedAt ?? Date.now() };
      this.#db
        .prepare(
          `INSERT INTO payments (
             block_hash, operation_index, from_address, to_address, token_address, amount,
             external, block_date, session_id, disposition, observed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          stored.blockHash,
          stored.operationIndex,
          stored.from,
          stored.to,
          stored.tokenAddress,
          stored.amount.toString(),
          stored.external,
          stored.blockDate,
          stored.sessionId,
          stored.disposition,
          stored.observedAt
        );
      return { inserted: true, payment: stored };
    });
  }

  async getPayment(blockHash: string, operationIndex: number): Promise<PaymentRow | undefined> {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM payments WHERE block_hash = ? AND operation_index = ?')
      .get(blockHash, operationIndex) as unknown as PaymentRowShape | undefined;
    return row === undefined ? undefined : toPayment(row);
  }

  async listPayments(query: PaymentsQuery = {}): Promise<PaymentRow[]> {
    this.#assertOpen();
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (query.dispositions !== undefined) {
      if (query.dispositions.length === 0) return [];
      where.push(`disposition IN (${query.dispositions.map(() => '?').join(', ')})`);
      params.push(...query.dispositions);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }

    const sql = `SELECT * FROM payments${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY block_date DESC, operation_index DESC LIMIT ?`;
    const rows = this.#db.prepare(sql).all(...params, query.limit ?? 100) as unknown as PaymentRowShape[];
    return rows.map(toPayment);
  }

  async getMeta(key: string): Promise<string | undefined> {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#assertOpen();
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  async createRefund(refund: NewRefund): Promise<{ created: boolean; refund: Refund }> {
    this.#assertOpen();
    return this.#transact(() => {
      const existing = this.#db
        .prepare('SELECT * FROM refunds WHERE payment_block_hash = ? AND payment_operation_index = ?')
        .get(refund.paymentBlockHash, refund.paymentOperationIndex) as unknown as RefundRowShape | undefined;
      if (existing !== undefined) return { created: false, refund: toRefund(existing) };

      const row: Refund = {
        ...refund,
        status: 'requested',
        attempts: 0,
        attemptStartedAt: null,
        blockHash: null,
        lastError: null,
        updatedAt: refund.createdAt,
        publishedAt: null
      };
      this.#db
        .prepare(`INSERT INTO refunds (${REFUND_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          row.id,
          row.paymentBlockHash,
          row.paymentOperationIndex,
          row.sessionId,
          row.to,
          row.tokenAddress,
          row.amount.toString(),
          row.reason,
          row.origin,
          row.status,
          row.attempts,
          row.attemptStartedAt,
          row.blockHash,
          row.lastError,
          row.createdAt,
          row.updatedAt,
          row.publishedAt
        );
      return { created: true, refund: row };
    });
  }

  async getRefund(id: string): Promise<Refund | undefined> {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM refunds WHERE id = ?').get(id) as unknown as RefundRowShape | undefined;
    return row === undefined ? undefined : toRefund(row);
  }

  async getRefundForPayment(blockHash: string, operationIndex: number): Promise<Refund | undefined> {
    this.#assertOpen();
    const row = this.#db
      .prepare('SELECT * FROM refunds WHERE payment_block_hash = ? AND payment_operation_index = ?')
      .get(blockHash, operationIndex) as unknown as RefundRowShape | undefined;
    return row === undefined ? undefined : toRefund(row);
  }

  async listRefunds(query: RefundsQuery = {}): Promise<Refund[]> {
    this.#assertOpen();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return [];
      where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
      params.push(...query.statuses);
    }
    if (query.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(query.sessionId);
    }
    const sql = `SELECT * FROM refunds${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    const rows = this.#db.prepare(sql).all(...params, query.limit ?? 100) as unknown as RefundRowShape[];
    return rows.map(toRefund);
  }

  async claimNextRefund(now: number): Promise<{ refund: Refund; claimed: boolean } | undefined> {
    this.#assertOpen();
    return this.#transact(() => {
      const inFlight = this.#db
        .prepare(`SELECT * FROM refunds WHERE status = 'publishing' ORDER BY attempt_started_at ASC LIMIT 1`)
        .get() as unknown as RefundRowShape | undefined;
      if (inFlight !== undefined) return { refund: toRefund(inFlight), claimed: false };

      const next = this.#db
        .prepare(`SELECT * FROM refunds WHERE status = 'requested' ORDER BY created_at ASC LIMIT 1`)
        .get() as unknown as RefundRowShape | undefined;
      if (next === undefined) return undefined;

      this.#db
        .prepare(
          `UPDATE refunds SET status = 'publishing', attempts = attempts + 1, attempt_started_at = ?, updated_at = ? WHERE id = ?`
        )
        .run(now, now, next.id);
      return {
        refund: toRefund({ ...next, status: 'publishing', attempts: next.attempts + 1, attempt_started_at: now, updated_at: now }),
        claimed: true
      };
    });
  }

  async recordRefundResult(id: string, result: RefundResultUpdate): Promise<Refund> {
    this.#assertOpen();
    return this.#transact(() => {
      const row = this.#db.prepare('SELECT * FROM refunds WHERE id = ?').get(id) as unknown as RefundRowShape | undefined;
      if (row === undefined) throw new StoreError('REFUND_NOT_FOUND', `no refund ${id}`);
      const next = applyRefundResult(toRefund(row), result);
      this.#db
        .prepare(
          `UPDATE refunds SET status = ?, attempts = ?, attempt_started_at = ?, block_hash = ?, last_error = ?, updated_at = ?, published_at = ? WHERE id = ?`
        )
        .run(next.status, next.attempts, next.attemptStartedAt, next.blockHash, next.lastError, next.updatedAt, next.publishedAt, id);
      return next;
    });
  }

  async sumRefundedSince(tokenAddress: string, since: number): Promise<bigint> {
    this.#assertOpen();
    // Summed here rather than in SQL: the amounts are TEXT on purpose, and SQLite
    // would add them as floats.
    const rows = this.#db
      .prepare(
        `SELECT amount FROM refunds
          WHERE token_address = ? AND status IN ('published', 'publishing')
            AND COALESCE(attempt_started_at, created_at) >= ?`
      )
      .all(tokenAddress, since) as unknown as Array<{ amount: string }>;
    let total = 0n;
    for (const row of rows) total += BigInt(row.amount);
    return total;
  }

  async enqueueDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    this.#assertOpen();
    this.#db
      .prepare(
        `INSERT INTO webhook_deliveries (
           id, event_id, event_type, endpoint_url, payload, status, attempts,
           next_attempt_at, last_error, last_status_code, created_at, updated_at, delivered_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        delivery.id,
        delivery.eventId,
        delivery.eventType,
        delivery.endpointUrl,
        delivery.payload,
        delivery.status,
        delivery.attempts,
        delivery.nextAttemptAt,
        delivery.lastError,
        delivery.lastStatusCode,
        delivery.createdAt,
        delivery.updatedAt,
        delivery.deliveredAt
      );
    return { ...delivery };
  }

  async claimDueDeliveries(now: number, limit: number, leaseUntil: number): Promise<WebhookDelivery[]> {
    this.#assertOpen();
    return this.#transact(() => {
      const rows = this.#db
        .prepare(
          `SELECT * FROM webhook_deliveries
            WHERE status = 'pending' AND next_attempt_at <= ?
            ORDER BY next_attempt_at ASC, created_at ASC
            LIMIT ?`
        )
        .all(now, limit) as unknown as DeliveryRowShape[];
      if (rows.length === 0) return [];

      const lease = this.#db.prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?');
      for (const row of rows) lease.run(leaseUntil, row.id);

      return rows.map((row) => toDelivery({ ...row, next_attempt_at: leaseUntil }));
    });
  }

  async recordDeliveryResult(id: string, result: DeliveryResultUpdate): Promise<WebhookDelivery> {
    this.#assertOpen();
    return this.#transact(() => {
      const row = this.#db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as unknown as
        | DeliveryRowShape
        | undefined;
      if (row === undefined) throw new StoreError('DELIVERY_NOT_FOUND', `no webhook delivery ${id}`);

      const next = result.nextAttemptAt ?? row.next_attempt_at;
      const deliveredAt = result.deliveredAt ?? row.delivered_at;
      this.#db
        .prepare(
          `UPDATE webhook_deliveries
              SET status = ?, attempts = ?, last_error = ?, last_status_code = ?,
                  next_attempt_at = ?, updated_at = ?, delivered_at = ?
            WHERE id = ?`
        )
        .run(result.status, result.attempts, result.lastError, result.lastStatusCode, next, result.at, deliveredAt, id);

      return toDelivery({
        ...row,
        status: result.status,
        attempts: result.attempts,
        last_error: result.lastError,
        last_status_code: result.lastStatusCode,
        next_attempt_at: next,
        updated_at: result.at,
        delivered_at: deliveredAt
      });
    });
  }

  async getDelivery(id: string): Promise<WebhookDelivery | undefined> {
    this.#assertOpen();
    const row = this.#db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as unknown as
      | DeliveryRowShape
      | undefined;
    return row === undefined ? undefined : toDelivery(row);
  }

  async listDeliveries(query: DeliveriesQuery = {}): Promise<WebhookDelivery[]> {
    this.#assertOpen();
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return [];
      where.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
      params.push(...query.statuses);
    }
    if (query.eventId !== undefined) {
      where.push('event_id = ?');
      params.push(query.eventId);
    }

    const sql = `SELECT * FROM webhook_deliveries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    const rows = this.#db.prepare(sql).all(...params, query.limit ?? 100) as unknown as DeliveryRowShape[];
    return rows.map(toDelivery);
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }
}
