/**
 * The session store contract.
 *
 * Two implementations ship: {@link MemorySessionStore} for tests and single-process
 * development, and `SqliteSessionStore` for everything else. A Postgres adapter is
 * the same interface.
 *
 * Status transitions are enforced here rather than in the service, because they are
 * an integrity property of the stored record: whatever calls the store, a paid
 * session must not quietly become expired, and a session must not be paid twice.
 * The watcher (step 5) calls {@link SessionStore.markPaid} and
 * {@link SessionStore.markUnmatched}; this contract is what makes those calls safe
 * to retry.
 *
 * Every method is `async`, so every failure arrives as a rejected promise. A
 * promise-returning method that threw synchronously would blow past a caller's
 * `.catch()`, which is exactly the kind of surprise a payment path cannot afford.
 *
 * Alongside sessions the store keeps a **payments ledger**: one row per inbound
 * send the watcher has ever seen, whether or not it could be credited. A session's
 * status is the summary; the ledger is the record a merchant reconciles and refunds
 * from, and its uniqueness on (block hash, operation index) is what makes
 * re-scanning the chain after a restart harmless.
 */
import type { DeliveriesQuery, DeliveryStatus, WebhookDelivery } from '../webhooks/types.ts';
import type { NewRefund, Refund, RefundResultUpdate, RefundsQuery } from '../refunds/types.ts';
import type { Session, SessionStatus } from './types.ts';

export type StoreErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'DUPLICATE_ID'
  | 'DUPLICATE_REFERENCE'
  | 'INVALID_TRANSITION'
  | 'DELIVERY_NOT_FOUND'
  | 'REFUND_NOT_FOUND';

/** What one delivery attempt changed. */
export interface DeliveryResultUpdate {
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  lastStatusCode: number | null;
  /** When the attempt finished. */
  at: number;
  /** Only for a `pending` result: when to try again. */
  nextAttemptAt?: number;
  /** Only for a `delivered` result. */
  deliveredAt?: number;
}

export class StoreError extends Error {
  override readonly name = 'StoreError';

  constructor(
    readonly code: StoreErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** What the watcher observed about a settled payment that is being credited to a session. */
export interface PaymentRecord {
  /** `keeta_…` account the payment came from. */
  paidBy: string;
  /** Hash of the block carrying the `SEND`. */
  blockHash: string;
  /** Index of the `SEND` within that block. With `blockHash`, the idempotency key. */
  operationIndex: number;
  /** Base units actually received. May exceed the session amount. */
  received: bigint;
  /**
   * When the block settled, from the block itself. Used for the grace-window check
   * and recorded as `paidAt`. Chain time, never the watcher's clock: a watcher
   * catching up after an outage must judge a payment by when it happened.
   */
  blockDate: number;
}

/** One inbound `SEND` to the receiving address, exactly as read off the chain. */
export interface ObservedPayment {
  blockHash: string;
  operationIndex: number;
  /** The payer: the account that published the block. */
  from: string;
  /** The recipient named by the operation. Always the receiving address, by construction. */
  to: string;
  tokenAddress: string;
  amount: bigint;
  /** The operation's `external` field, or `null` when absent or empty. */
  external: string | null;
  /** Block settlement time, milliseconds since the epoch. */
  blockDate: number;
}

/**
 * What an inbound send turned out to be.
 *
 * - `matched`, `overpaid`: credited; the session is paid.
 * - `underpaid`: less than owed; the session stays open and the merchant refunds this.
 * - `late`: settled after the grace window; the session is unmatched.
 * - `duplicate`: a second send to a session already paid or already unmatched.
 * - `cancelled`: the session was cancelled before this settled.
 * - `wrong_token`, `wrong_recipient`: the reference matched but the send does not fit it.
 * - `unknown_reference`: no session has this reference.
 * - `no_reference`: the send carries none.
 */
export type PaymentDisposition =
  | 'matched'
  | 'overpaid'
  | 'underpaid'
  | 'late'
  | 'duplicate'
  | 'cancelled'
  | 'wrong_token'
  | 'wrong_recipient'
  | 'unknown_reference'
  | 'no_reference';

/** Dispositions where money sits with the merchant and should go back. */
export const REFUNDABLE_DISPOSITIONS: ReadonlySet<PaymentDisposition> = new Set<PaymentDisposition>([
  'underpaid',
  'late',
  'duplicate',
  'cancelled',
  'wrong_token',
  'wrong_recipient',
  'unknown_reference',
  'no_reference'
]);

/** A ledger row: the observed send plus what was decided about it. */
export interface PaymentRow extends ObservedPayment {
  sessionId: string | null;
  disposition: PaymentDisposition;
  /** Wall-clock time the watcher recorded it. */
  observedAt: number;
}

export interface PaymentsQuery {
  dispositions?: readonly PaymentDisposition[];
  sessionId?: string;
  limit?: number;
}

export interface SessionStore {
  /**
   * Persist a new session. Rejects with `DUPLICATE_ID` or `DUPLICATE_REFERENCE` if
   * either identifier is taken, so a collision can never overwrite a live session.
   */
  create(session: Session): Promise<Session>;

  /** The session with this id, or `undefined`. */
  get(id: string): Promise<Session | undefined>;

  /**
   * The session with this payment reference, or `undefined`. The watcher's lookup:
   * it reads a reference off the chain and needs the session it belongs to.
   */
  getByReference(reference: string): Promise<Session | undefined>;

  /**
   * Credit a payment to a session and move it to `paid`.
   *
   * Allowed from `open`, and from `expired` when the block settled inside the grace
   * window. A block that settled after `graceUntil` is refused whatever the current
   * status, because an unswept session can still read `open` long after its
   * deadline.
   *
   * Idempotent on (`blockHash`, `operationIndex`): the same send again returns the
   * stored session unchanged, so a watcher that re-observes a block or restarts
   * mid-write does not double-handle it.
   *
   * Rejects with `INVALID_TRANSITION` otherwise, including for a session already
   * paid by a *different* send. That is the caller's cue to record it as unmatched.
   */
  markPaid(id: string, payment: PaymentRecord): Promise<Session>;

  /**
   * Mark that money arrived which cannot be credited: a send after the grace window,
   * or a second send to a paid session. Allowed from `expired` and from `paid`
   * (which keeps the original payment fields and only changes the status), and
   * idempotent once already `unmatched`.
   */
  markUnmatched(id: string, payment: PaymentRecord): Promise<Session>;

  /**
   * Cancel an `open` session. Idempotent if already `cancelled`. Rejects with
   * `INVALID_TRANSITION` for a session that is paid, expired or unmatched, because
   * cancelling those would hide a real outcome.
   */
  cancel(id: string): Promise<Session>;

  /**
   * Move every `open` session whose `expiresAt` has passed to `expired`, and return
   * them. Safe to call as often as you like; it only ever acts on sessions that are
   * genuinely past their deadline.
   */
  expireDue(now?: number): Promise<Session[]>;

  /** Sessions in these statuses, newest first. For the watcher's startup scan and for tests. */
  listByStatus(statuses: readonly SessionStatus[], limit?: number): Promise<Session[]>;

  /**
   * Append an inbound send to the ledger. Idempotent on (`blockHash`,
   * `operationIndex`): a second call with the same send returns the existing row and
   * `inserted: false`, and never overwrites the first decision.
   */
  recordPayment(row: Omit<PaymentRow, 'observedAt'> & { observedAt?: number }): Promise<{ inserted: boolean; payment: PaymentRow }>;

  /** One ledger row, or `undefined`. */
  getPayment(blockHash: string, operationIndex: number): Promise<PaymentRow | undefined>;

  /** Ledger rows, newest block first. */
  listPayments(query?: PaymentsQuery): Promise<PaymentRow[]>;

  /** Small durable key-value slots, for the watcher's cursor. */
  getMeta(key: string): Promise<string | undefined>;
  setMeta(key: string, value: string): Promise<void>;

  /** Queue one webhook delivery. */
  enqueueDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery>;

  /**
   * Take up to `limit` deliveries that are `pending` and due, pushing each one's
   * next attempt to `leaseUntil` so a second dispatcher process will not pick up
   * the same row while this one is sending it. A lease that expires without a
   * result simply becomes due again, which at-least-once delivery tolerates.
   */
  claimDueDeliveries(now: number, limit: number, leaseUntil: number): Promise<WebhookDelivery[]>;

  /** Record the outcome of one attempt. */
  recordDeliveryResult(id: string, result: DeliveryResultUpdate): Promise<WebhookDelivery>;

  getDelivery(id: string): Promise<WebhookDelivery | undefined>;

  /** Deliveries, newest first. */
  listDeliveries(query?: DeliveriesQuery): Promise<WebhookDelivery[]>;

  // ---- the refund ledger (docs/decisions/0014) -------------------------------

  /**
   * Create a refund for a payment. One refund per payment: if one already exists
   * the existing row comes back with `created: false` and nothing is written, so
   * a repeated request, an API retry and the auto-refund path cannot between them
   * produce two.
   */
  createRefund(refund: NewRefund): Promise<{ created: boolean; refund: Refund }>;

  getRefund(id: string): Promise<Refund | undefined>;

  getRefundForPayment(blockHash: string, operationIndex: number): Promise<Refund | undefined>;

  /** Refunds, newest first. */
  listRefunds(query?: RefundsQuery): Promise<Refund[]>;

  /**
   * The next refund to publish, under the one-at-a-time rule.
   *
   * If any refund is already `publishing`, that row is returned with
   * `claimed: false` and nothing changes: the caller must reconcile it against the
   * chain before anything else is sent. Otherwise the oldest `requested` refund is
   * moved to `publishing` with its attempt time set, in one transaction, and
   * returned with `claimed: true`. Nothing to do returns undefined.
   */
  claimNextRefund(now: number): Promise<{ refund: Refund; claimed: boolean } | undefined>;

  /**
   * Record where a refund ended up. From `publishing` a refund may become
   * `published`, `failed`, or `requested` again after reconciliation found nothing
   * on chain; from `requested` it may only become `refused`. Anything else is an
   * `INVALID_TRANSITION`.
   */
  recordRefundResult(id: string, result: RefundResultUpdate): Promise<Refund>;

  /**
   * Base units of one token that are `published` or `publishing` and whose attempt
   * began at or after `since`. The daily-cap check counts money in flight as spent,
   * because a refund that is publishing may land.
   */
  sumRefundedSince(tokenAddress: string, since: number): Promise<bigint>;

  /** Release any held resources. Safe to call twice. */
  close(): Promise<void>;
}

/** Which status changes the refund ledger accepts. */
export function refundTransitionAllowed(from: Refund['status'], to: RefundResultUpdate['status']): boolean {
  // `refused` from `publishing`: the row is claimed before the limits run, and a
  // limit that says no does so before anything is sent.
  if (from === 'publishing') return to === 'published' || to === 'failed' || to === 'requested' || to === 'refused';
  if (from === 'requested') return to === 'refused';
  return false;
}

/** Apply a recorded result to a refund row. Shared by every store so the rules live once. */
export function applyRefundResult(refund: Refund, result: RefundResultUpdate): Refund {
  if (!refundTransitionAllowed(refund.status, result.status)) {
    throw new StoreError('INVALID_TRANSITION', `refund ${refund.id} cannot go from ${refund.status} to ${result.status}`);
  }
  const next: Refund = {
    ...refund,
    status: result.status,
    updatedAt: result.at,
    lastError: result.lastError === undefined ? refund.lastError : result.lastError
  };
  if (result.status === 'published') {
    if (result.blockHash === undefined || result.blockHash === '') {
      throw new StoreError('INVALID_TRANSITION', `refund ${refund.id} cannot be published without a block hash`);
    }
    next.blockHash = result.blockHash;
    next.publishedAt = result.at;
  }
  if (result.status === 'requested') next.attemptStartedAt = null;
  return next;
}

/** Copy a session so a caller cannot mutate what the store holds. */
export function cloneSession(session: Session): Session {
  return { ...session };
}

function clonePayment(row: PaymentRow): PaymentRow {
  return { ...row };
}

export function paymentKey(blockHash: string, operationIndex: number): string {
  return `${blockHash}:${operationIndex}`;
}

/**
 * The `markPaid` rule, shared by every store so it cannot drift between them.
 * Mutates `session` into its paid state, or leaves it alone for an idempotent
 * replay, or throws.
 */
export function applyMarkPaid(session: Session, payment: PaymentRecord): { changed: boolean } {
  if (session.status === 'paid') {
    if (session.blockHash === payment.blockHash && session.operationIndex === payment.operationIndex) {
      return { changed: false };
    }
    throw new StoreError(
      'INVALID_TRANSITION',
      `session ${session.id} is already paid by block ${session.blockHash ?? 'unknown'} operation ${session.operationIndex ?? '?'}, not ${payment.blockHash}:${payment.operationIndex}`
    );
  }
  if (session.status !== 'open' && session.status !== 'expired') {
    throw new StoreError('INVALID_TRANSITION', `session ${session.id} is ${session.status}, so it cannot be paid`);
  }
  if (payment.blockDate > session.graceUntil) {
    throw new StoreError(
      'INVALID_TRANSITION',
      `session ${session.id}: the payment settled at ${new Date(payment.blockDate).toISOString()}, after the grace window closed at ${new Date(session.graceUntil).toISOString()}`
    );
  }

  const overpaid = payment.received - session.amount;
  session.status = 'paid';
  session.paidBy = payment.paidBy;
  session.blockHash = payment.blockHash;
  session.operationIndex = payment.operationIndex;
  session.paidAt = payment.blockDate;
  session.overpaidBy = overpaid > 0n ? overpaid : null;
  session.updatedAt = payment.blockDate;
  return { changed: true };
}

/** The `markUnmatched` rule, likewise shared. */
export function applyMarkUnmatched(session: Session, payment: PaymentRecord): { changed: boolean } {
  if (session.status === 'unmatched') return { changed: false };
  if (session.status === 'open' || session.status === 'cancelled') {
    throw new StoreError(
      'INVALID_TRANSITION',
      `session ${session.id} is ${session.status}; a payment to it is matched or cancelled, not unmatched`
    );
  }
  session.status = 'unmatched';
  session.updatedAt = Math.max(session.updatedAt, payment.blockDate);
  return { changed: true };
}

/**
 * In-memory store. Everything is lost when the process exits, so it is for tests and
 * for trying the server out, never for a shop taking real orders.
 */
export class MemorySessionStore implements SessionStore {
  readonly #byId = new Map<string, Session>();
  readonly #byReference = new Map<string, string>();
  readonly #payments = new Map<string, PaymentRow>();
  readonly #meta = new Map<string, string>();
  readonly #deliveries = new Map<string, WebhookDelivery>();
  readonly #refunds = new Map<string, Refund>();

  async create(session: Session): Promise<Session> {
    if (this.#byId.has(session.id)) {
      throw new StoreError('DUPLICATE_ID', `session ${session.id} already exists`);
    }
    if (this.#byReference.has(session.reference)) {
      throw new StoreError('DUPLICATE_REFERENCE', `payment reference for ${session.id} is already in use`);
    }
    this.#byId.set(session.id, cloneSession(session));
    this.#byReference.set(session.reference, session.id);
    return cloneSession(session);
  }

  async get(id: string): Promise<Session | undefined> {
    const found = this.#byId.get(id);
    return found === undefined ? undefined : cloneSession(found);
  }

  async getByReference(reference: string): Promise<Session | undefined> {
    const id = this.#byReference.get(reference);
    return id === undefined ? undefined : this.get(id);
  }

  #require(id: string): Session {
    const session = this.#byId.get(id);
    if (session === undefined) {
      throw new StoreError('SESSION_NOT_FOUND', `no session ${id}`);
    }
    return session;
  }

  async markPaid(id: string, payment: PaymentRecord): Promise<Session> {
    const session = this.#require(id);
    applyMarkPaid(session, payment);
    return cloneSession(session);
  }

  async markUnmatched(id: string, payment: PaymentRecord): Promise<Session> {
    const session = this.#require(id);
    applyMarkUnmatched(session, payment);
    return cloneSession(session);
  }

  async cancel(id: string): Promise<Session> {
    const session = this.#require(id);

    if (session.status === 'cancelled') return cloneSession(session);
    if (session.status !== 'open') {
      throw new StoreError('INVALID_TRANSITION', `session ${id} is ${session.status}, so it cannot be cancelled`);
    }

    session.status = 'cancelled';
    session.updatedAt = Date.now();
    return cloneSession(session);
  }

  async expireDue(now = Date.now()): Promise<Session[]> {
    const expired: Session[] = [];
    for (const session of this.#byId.values()) {
      if (session.status === 'open' && session.expiresAt <= now) {
        session.status = 'expired';
        session.updatedAt = now;
        expired.push(cloneSession(session));
      }
    }
    return expired;
  }

  async listByStatus(statuses: readonly SessionStatus[], limit = 100): Promise<Session[]> {
    const wanted = new Set(statuses);
    return [...this.#byId.values()]
      .filter((session) => wanted.has(session.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(cloneSession);
  }

  async recordPayment(
    row: Omit<PaymentRow, 'observedAt'> & { observedAt?: number }
  ): Promise<{ inserted: boolean; payment: PaymentRow }> {
    const key = paymentKey(row.blockHash, row.operationIndex);
    const existing = this.#payments.get(key);
    if (existing !== undefined) return { inserted: false, payment: clonePayment(existing) };

    const stored: PaymentRow = { ...row, observedAt: row.observedAt ?? Date.now() };
    this.#payments.set(key, stored);
    return { inserted: true, payment: clonePayment(stored) };
  }

  async getPayment(blockHash: string, operationIndex: number): Promise<PaymentRow | undefined> {
    const found = this.#payments.get(paymentKey(blockHash, operationIndex));
    return found === undefined ? undefined : clonePayment(found);
  }

  async listPayments(query: PaymentsQuery = {}): Promise<PaymentRow[]> {
    const wanted = query.dispositions === undefined ? undefined : new Set(query.dispositions);
    return [...this.#payments.values()]
      .filter((row) => wanted === undefined || wanted.has(row.disposition))
      .filter((row) => query.sessionId === undefined || row.sessionId === query.sessionId)
      .sort((a, b) => b.blockDate - a.blockDate || b.operationIndex - a.operationIndex)
      .slice(0, query.limit ?? 100)
      .map(clonePayment);
  }

  async getMeta(key: string): Promise<string | undefined> {
    return this.#meta.get(key);
  }

  async setMeta(key: string, value: string): Promise<void> {
    this.#meta.set(key, value);
  }

  async enqueueDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    this.#deliveries.set(delivery.id, { ...delivery });
    return { ...delivery };
  }

  async claimDueDeliveries(now: number, limit: number, leaseUntil: number): Promise<WebhookDelivery[]> {
    const due = [...this.#deliveries.values()]
      .filter((delivery) => delivery.status === 'pending' && delivery.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt)
      .slice(0, limit);

    return due.map((delivery) => {
      delivery.nextAttemptAt = leaseUntil;
      return { ...delivery };
    });
  }

  async recordDeliveryResult(id: string, result: DeliveryResultUpdate): Promise<WebhookDelivery> {
    const delivery = this.#deliveries.get(id);
    if (delivery === undefined) throw new StoreError('DELIVERY_NOT_FOUND', `no webhook delivery ${id}`);

    delivery.status = result.status;
    delivery.attempts = result.attempts;
    delivery.lastError = result.lastError;
    delivery.lastStatusCode = result.lastStatusCode;
    delivery.updatedAt = result.at;
    if (result.nextAttemptAt !== undefined) delivery.nextAttemptAt = result.nextAttemptAt;
    if (result.deliveredAt !== undefined) delivery.deliveredAt = result.deliveredAt;
    return { ...delivery };
  }

  async getDelivery(id: string): Promise<WebhookDelivery | undefined> {
    const found = this.#deliveries.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async createRefund(refund: NewRefund): Promise<{ created: boolean; refund: Refund }> {
    const existing = await this.getRefundForPayment(refund.paymentBlockHash, refund.paymentOperationIndex);
    if (existing !== undefined) return { created: false, refund: existing };
    if (this.#refunds.has(refund.id)) throw new StoreError('DUPLICATE_ID', `refund ${refund.id} already exists`);
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
    this.#refunds.set(row.id, row);
    return { created: true, refund: { ...row } };
  }

  async getRefund(id: string): Promise<Refund | undefined> {
    const found = this.#refunds.get(id);
    return found === undefined ? undefined : { ...found };
  }

  async getRefundForPayment(blockHash: string, operationIndex: number): Promise<Refund | undefined> {
    for (const refund of this.#refunds.values()) {
      if (refund.paymentBlockHash === blockHash && refund.paymentOperationIndex === operationIndex) return { ...refund };
    }
    return undefined;
  }

  async listRefunds(query: RefundsQuery = {}): Promise<Refund[]> {
    const wanted = query.statuses === undefined ? undefined : new Set(query.statuses);
    if (wanted?.size === 0) return [];
    return [...this.#refunds.values()]
      .filter((refund) => wanted === undefined || wanted.has(refund.status))
      .filter((refund) => query.sessionId === undefined || refund.sessionId === query.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, query.limit ?? 100)
      .map((refund) => ({ ...refund }));
  }

  async claimNextRefund(now: number): Promise<{ refund: Refund; claimed: boolean } | undefined> {
    const inFlight = [...this.#refunds.values()].find((refund) => refund.status === 'publishing');
    if (inFlight !== undefined) return { refund: { ...inFlight }, claimed: false };

    const next = [...this.#refunds.values()]
      .filter((refund) => refund.status === 'requested')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next === undefined) return undefined;

    next.status = 'publishing';
    next.attempts += 1;
    next.attemptStartedAt = now;
    next.updatedAt = now;
    return { refund: { ...next }, claimed: true };
  }

  async recordRefundResult(id: string, result: RefundResultUpdate): Promise<Refund> {
    const refund = this.#refunds.get(id);
    if (refund === undefined) throw new StoreError('REFUND_NOT_FOUND', `no refund ${id}`);
    const next = applyRefundResult(refund, result);
    this.#refunds.set(id, next);
    return { ...next };
  }

  async sumRefundedSince(tokenAddress: string, since: number): Promise<bigint> {
    let total = 0n;
    for (const refund of this.#refunds.values()) {
      if (refund.tokenAddress !== tokenAddress) continue;
      if (refund.status !== 'published' && refund.status !== 'publishing') continue;
      if ((refund.attemptStartedAt ?? refund.createdAt) < since) continue;
      total += refund.amount;
    }
    return total;
  }

  async listDeliveries(query: DeliveriesQuery = {}): Promise<WebhookDelivery[]> {
    const wanted = query.statuses === undefined ? undefined : new Set(query.statuses);
    if (wanted?.size === 0) return [];
    return [...this.#deliveries.values()]
      .filter((delivery) => wanted === undefined || wanted.has(delivery.status))
      .filter((delivery) => query.eventId === undefined || delivery.eventId === query.eventId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, query.limit ?? 100)
      .map((delivery) => ({ ...delivery }));
  }

  async close(): Promise<void> {
    this.#byId.clear();
    this.#byReference.clear();
    this.#payments.clear();
    this.#meta.clear();
    this.#deliveries.clear();
  }
}
