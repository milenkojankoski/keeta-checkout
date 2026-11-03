/**
 * The refund process: the one part of Keeta Checkout that publishes blocks.
 *
 * It runs on its own, next to the checkout server, sharing its database. Each tick
 * it does at most one of three things, in this order:
 *
 *   1. If a refund is already `publishing`, reconcile it against the chain and do
 *      nothing else. A row in that state means a publish was started and this
 *      process does not know how it ended; sending anything before finding out
 *      is how a refund goes out twice.
 *   2. Otherwise create refunds for payments the merchant asked to be returned
 *      automatically (`autoRefund`), reading the payments ledger, not events, so
 *      it works across processes and after a restart.
 *   3. Otherwise claim the oldest `requested` refund, run every limit, and publish
 *      exactly one send from the vault.
 *
 * Every limit fails closed: an unreadable balance, an unknown token, a store error
 * or a missing config value is a refusal, logged, never a default. Permanent
 * refusals (over the per-refund cap, a token the vault does not hold) are
 * recorded as `refused`. Transient ones (float too low, daily cap reached, KTA
 * reserve) put the row back to `requested` and hold the queue for a while, because
 * the float is shared and the merchant will top it up.
 *
 * See docs/decisions/0014.
 */
import { EventEmitter } from 'node:events';
import {
  REFUNDABLE_DISPOSITIONS,
  type SessionStore,
  type PaymentRow,
  type Refund,
  type RefundReason,
  type NewRefund,
  refundExternal,
  generateRefundId,
  type HistoryEntryLike,
  SEND_OPERATION_TYPE
} from '@keeta-checkout/server';

/**
 * What the process needs from the chain, for the vault. The SDK adapter in
 * `signer.ts` satisfies it; a test satisfies it with a few lines.
 */
export interface VaultSigner {
  /** Publish one send from the vault. Resolves with the block that carried it. */
  send(to: string, amount: bigint, token: string, external: string): Promise<{ blockHash: string }>;
  /** The vault's balance of a token: the refund float. */
  balance(token: string): Promise<bigint>;
  /** The fee payer's KTA balance. The signer pays fees, not the vault. */
  feeBalance(): Promise<bigint>;
  /** Whether the vault has a side-ledger block that never finished publishing. */
  hasPendingBlock(): Promise<boolean>;
  /** Push any such block through. */
  recover(): Promise<void>;
  /** The vault's recent history, newest first. */
  history(): Promise<readonly HistoryEntryLike[]>;
}

export interface RefundLimits {
  /** Base units of the refund token. Undefined means no per-refund cap. */
  maxPerRefund?: bigint | undefined;
  /**
   * Base units in any rolling 24 hours, counting money in flight. Undefined means
   * the vault's balance is the cap, which the float check already enforces.
   */
  maxPerDay?: bigint | undefined;
  /** Base units of KTA the signer must hold to pay fees before a refund is published. */
  ktaReserve: bigint;
}

export interface RefundProcessOptions {
  store: SessionStore;
  signer: VaultSigner;
  /** The vault's address, so reconciliation can tell its own blocks from others'. */
  vault: string;
  /** The one token the vault pays in. */
  token: string;
  limits: RefundLimits;
  /** Dispositions to refund without being asked. */
  autoRefund: readonly RefundReason[];
  /**
   * Where automatic refunds start, the first time they run against a database:
   * payments observed after this time. Defaults to the moment they first run.
   *
   * Not zero, deliberately. Before refunds existed, merchants were told to send
   * duplicates back by hand; scanning the whole ledger on first start would pay
   * every one of those shoppers a second time. Older payments can still be refunded
   * on purpose through `POST /api/payments/:blockHash/refund`.
   */
  autoRefundFrom?: number | undefined;
  /** How long a `publishing` row may stay unresolved before it is retried. */
  reconcileGraceMs?: number;
  /** How long to hold the queue after a transient refusal. */
  holdMs?: number;
  log?: Pick<Console, 'error' | 'warn' | 'info'>;
  now?: () => number;
}

export type RefundProcessOutcome =
  | { did: 'nothing' }
  | { did: 'reconciled'; refund: Refund; found: boolean }
  | { did: 'waiting'; refund?: Refund }
  | { did: 'auto-requested'; refunds: Refund[] }
  | { did: 'refused'; refund: Refund; reason: string }
  | { did: 'held'; refund: Refund; reason: string }
  | { did: 'published'; refund: Refund }
  | { did: 'failed'; refund: Refund; reason: string }
  | { did: 'ambiguous'; refund: Refund; reason: string };

export interface RefundChangeEvent {
  refund: Refund;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_SCAN_META_KEY = 'refunds.autoScanObservedAt';

export class RefundProcess {
  readonly #store: SessionStore;
  readonly #signer: VaultSigner;
  readonly #vault: string;
  readonly #token: string;
  readonly #limits: RefundLimits;
  readonly #autoRefund: ReadonlySet<RefundReason>;
  readonly #autoRefundFrom: number | undefined;
  readonly #graceMs: number;
  readonly #holdMs: number;
  readonly #log: Pick<Console, 'error' | 'warn' | 'info'>;
  readonly #now: () => number;
  readonly #events = new EventEmitter();

  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<RefundProcessOutcome> | undefined;
  #heldUntil = 0;

  constructor(options: RefundProcessOptions) {
    this.#store = options.store;
    this.#signer = options.signer;
    this.#vault = options.vault;
    this.#token = options.token;
    this.#limits = options.limits;
    this.#autoRefund = new Set(options.autoRefund);
    this.#autoRefundFrom = options.autoRefundFrom;
    this.#graceMs = options.reconcileGraceMs ?? 60_000;
    this.#holdMs = options.holdMs ?? 60_000;
    this.#log = options.log ?? console;
    this.#now = options.now ?? Date.now;
  }

  onChange(listener: (event: RefundChangeEvent) => void): () => void {
    this.#events.on('change', listener);
    return () => {
      this.#events.off('change', listener);
    };
  }

  start(intervalMs = 10_000): void {
    if (this.#timer !== undefined) return;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), intervalMs);
    this.#timer.unref();
  }

  /** The scheduled path swallows what `runOnce()` rethrows; see the watcher for why. */
  #tick(): void {
    this.runOnce().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight?.catch(() => undefined);
  }

  /** One step. Never two at once. */
  runOnce(): Promise<RefundProcessOutcome> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    this.#inFlight = this.#runOnce()
      .catch((error: unknown) => {
        this.#log.error('[keeta-checkout] refund process step failed', error);
        throw error;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  async #runOnce(): Promise<RefundProcessOutcome> {
    const now = this.#now();

    // A transient refusal holds the queue. Nothing can be in flight while it does:
    // a hold is only set by a claim that sent nothing, and this process is the only
    // writer of `publishing`. So there is nothing to reconcile either, and the step
    // waits without claiming instead of churning a row every tick.
    if (now < this.#heldUntil) return { did: 'waiting' };

    // 1. Anything in flight comes first, and alone.
    const claim = await this.#store.claimNextRefund(now);
    if (claim !== undefined && !claim.claimed) return this.#reconcile(claim.refund, now);

    // The claim above may already have taken a requested row. If it did, honour
    // it; auto-requests can wait a tick.
    if (claim === undefined) {
      const created = await this.#autoRequest(now);
      if (created.length > 0) return { did: 'auto-requested', refunds: created };
      return { did: 'nothing' };
    }

    const refund = claim.refund;
    const verdict = await this.#checkLimits(refund, now);
    if (verdict.kind === 'refused') {
      const updated = await this.#store.recordRefundResult(refund.id, {
        status: 'refused',
        at: now,
        lastError: verdict.reason,
        notAttempted: true
      });
      this.#log.warn(`[keeta-checkout] refund ${refund.id} refused: ${verdict.reason}`);
      this.#emit(updated);
      return { did: 'refused', refund: updated, reason: verdict.reason };
    }
    if (verdict.kind === 'held') {
      const updated = await this.#store.recordRefundResult(refund.id, {
        status: 'requested',
        at: now,
        lastError: verdict.reason,
        notAttempted: true
      });
      this.#heldUntil = now + this.#holdMs;
      this.#log.warn(`[keeta-checkout] refund ${refund.id} held: ${verdict.reason}`);
      return { did: 'held', refund: updated, reason: verdict.reason };
    }

    // 3. Publish. The row is already `publishing` with its attempt time persisted.
    try {
      const { blockHash } = await this.#signer.send(refund.to, refund.amount, refund.tokenAddress, refundExternal(refund.id));
      const updated = await this.#store.recordRefundResult(refund.id, { status: 'published', at: this.#now(), blockHash, lastError: null });
      this.#log.info(`[keeta-checkout] refund ${refund.id} published in ${blockHash}: ${refund.amount} to ${refund.to}`);
      this.#emit(updated);
      return { did: 'published', refund: updated };
    } catch (error) {
      const reason = describe(error);
      if (isCleanRejection(error)) {
        // The network answered no. But an SDK retry can throw after the block has
        // already landed (measured: a fee retry did exactly this), and a wrong
        // "failed" invites a second refund. So look before saying so.
        const landed = await this.#findOnChain(refund).catch(() => undefined);
        if (landed !== undefined) {
          const updated = await this.#store.recordRefundResult(refund.id, { status: 'published', at: this.#now(), blockHash: landed, lastError: null });
          this.#log.warn(`[keeta-checkout] refund ${refund.id} reported "${reason}" but is on chain in ${landed}; recorded as published`);
          this.#emit(updated);
          return { did: 'published', refund: updated };
        }
        const updated = await this.#store.recordRefundResult(refund.id, { status: 'failed', at: this.#now(), lastError: reason });
        this.#log.error(`[keeta-checkout] refund ${refund.id} failed: ${reason}`);
        this.#emit(updated);
        return { did: 'failed', refund: updated, reason };
      }
      // A timeout, a dropped socket, an unreadable answer: it may or may not have
      // landed. Leave the row `publishing`; the next tick reconciles it.
      this.#log.warn(`[keeta-checkout] refund ${refund.id} outcome unknown, will reconcile: ${reason}`);
      return { did: 'ambiguous', refund, reason };
    }
  }

  /**
   * A `publishing` row of unknown outcome. Push any half-published block through,
   * then look for our own send in the vault's history. Found: it is published.
   * Not found and older than the grace window: it is requested again. Otherwise
   * leave it; a slow node may still be indexing it.
   */
  async #reconcile(refund: Refund, now: number): Promise<RefundProcessOutcome> {
    if (await this.#signer.hasPendingBlock()) {
      this.#log.warn(`[keeta-checkout] the vault has a pending block; recovering before anything else`);
      await this.#signer.recover();
    }

    const blockHash = await this.#findOnChain(refund);
    if (blockHash !== undefined) {
      const updated = await this.#store.recordRefundResult(refund.id, { status: 'published', at: now, blockHash, lastError: null });
      this.#log.info(`[keeta-checkout] refund ${refund.id} found on chain in ${blockHash} after an unknown outcome`);
      this.#emit(updated);
      return { did: 'reconciled', refund: updated, found: true };
    }

    const startedAt = refund.attemptStartedAt ?? refund.updatedAt;
    if (now - startedAt < this.#graceMs) return { did: 'waiting', refund };

    const updated = await this.#store.recordRefundResult(refund.id, {
      status: 'requested',
      at: now,
      lastError: `attempt ${refund.attempts} was not found on chain after ${Math.round(this.#graceMs / 1000)}s`
    });
    this.#log.warn(`[keeta-checkout] refund ${refund.id} not found on chain; it will be tried again`);
    return { did: 'reconciled', refund: updated, found: false };
  }

  async #findOnChain(refund: Refund): Promise<string | undefined> {
    const wanted = refundExternal(refund.id);
    const entries = await this.#signer.history();
    for (const entry of entries) {
      for (const block of entry.voteStaple.blocks) {
        if (block.account.publicKeyString.get() !== this.#vault) continue;
        for (const operation of block.operations) {
          if (operation.type !== SEND_OPERATION_TYPE) continue;
          if (operation.external === wanted) return block.hash.toString();
        }
      }
    }
    return undefined;
  }

  async #checkLimits(refund: Refund, now: number): Promise<{ kind: 'ok' } | { kind: 'refused' | 'held'; reason: string }> {
    if (refund.tokenAddress !== this.#token) {
      return { kind: 'refused', reason: `the vault pays ${this.#token}, and this payment was in ${refund.tokenAddress}` };
    }
    if (refund.amount <= 0n) return { kind: 'refused', reason: 'nothing to refund' };
    if (this.#limits.maxPerRefund !== undefined && refund.amount > this.#limits.maxPerRefund) {
      return { kind: 'refused', reason: `${refund.amount} is over the per-refund cap of ${this.#limits.maxPerRefund}` };
    }

    let float: bigint;
    let feeKta: bigint;
    try {
      float = await this.#signer.balance(this.#token);
      feeKta = await this.#signer.feeBalance();
    } catch (error) {
      return { kind: 'held', reason: `could not read a balance: ${describe(error)}` };
    }
    if (refund.amount > float) return { kind: 'held', reason: `the vault holds ${float}, less than the ${refund.amount} needed` };
    if (feeKta < this.#limits.ktaReserve) {
      return { kind: 'held', reason: `the fee account holds ${feeKta} KTA, below the reserve of ${this.#limits.ktaReserve}` };
    }

    if (this.#limits.maxPerDay !== undefined) {
      // The claimed row is already `publishing`, so it is in the sum. Subtract it.
      const inWindow = (await this.#store.sumRefundedSince(this.#token, now - DAY_MS)) - refund.amount;
      if (inWindow + refund.amount > this.#limits.maxPerDay) {
        return { kind: 'held', reason: `${inWindow} already refunded in the last 24h; this one would pass the daily cap of ${this.#limits.maxPerDay}` };
      }
    }
    return { kind: 'ok' };
  }

  /** Turn the merchant's `autoRefund` setting into rows, reading the ledger. */
  async #autoRequest(now: number): Promise<Refund[]> {
    if (this.#autoRefund.size === 0) return [];
    let since: number;
    const stored = await this.#store.getMeta(AUTO_SCAN_META_KEY);
    if (stored === undefined) {
      // First run against this database: start now, not at the beginning of the
      // ledger. See `autoRefundFrom`.
      since = this.#autoRefundFrom ?? now;
      await this.#store.setMeta(AUTO_SCAN_META_KEY, String(since));
    } else {
      since = Number(stored);
    }
    const dispositions = [...this.#autoRefund].filter((reason): reason is Exclude<RefundReason, 'overpaid'> => reason !== 'overpaid');
    const created: Refund[] = [];
    let newest = since;

    if (dispositions.length > 0) {
      const payments = await this.#store.listPayments({ dispositions, limit: 200 });
      for (const payment of payments.filter((p) => p.observedAt > since).sort((a, b) => a.observedAt - b.observedAt)) {
        const refund = await this.#requestFor(payment, payment.disposition as RefundReason, payment.amount, now);
        if (refund !== undefined) created.push(refund);
        newest = Math.max(newest, payment.observedAt);
      }
    }
    if (this.#autoRefund.has('overpaid')) {
      const overpaid = await this.#store.listPayments({ dispositions: ['overpaid'], limit: 200 });
      for (const payment of overpaid.filter((p) => p.observedAt > since).sort((a, b) => a.observedAt - b.observedAt)) {
        const session = payment.sessionId === null ? undefined : await this.#store.get(payment.sessionId);
        const excess = session?.overpaidBy ?? 0n;
        if (excess > 0n) {
          const refund = await this.#requestFor(payment, 'overpaid', excess, now);
          if (refund !== undefined) created.push(refund);
        }
        newest = Math.max(newest, payment.observedAt);
      }
    }
    if (newest > since) await this.#store.setMeta(AUTO_SCAN_META_KEY, String(newest));
    return created;
  }

  async #requestFor(payment: PaymentRow, reason: RefundReason, amount: bigint, now: number): Promise<Refund | undefined> {
    if (reason !== 'overpaid' && !REFUNDABLE_DISPOSITIONS.has(payment.disposition)) return undefined;
    const request: NewRefund = {
      id: newRefundId(),
      paymentBlockHash: payment.blockHash,
      paymentOperationIndex: payment.operationIndex,
      sessionId: payment.sessionId,
      to: payment.from,
      tokenAddress: payment.tokenAddress,
      amount,
      reason,
      origin: 'auto',
      createdAt: now
    };
    const { created, refund } = await this.#store.createRefund(request);
    if (!created) return undefined;
    this.#log.info(`[keeta-checkout] refund ${refund.id} requested automatically: ${reason} payment of ${amount} from ${payment.from}`);
    this.#emit(refund);
    return refund;
  }

  #emit(refund: Refund): void {
    this.#events.emit('change', { refund } satisfies RefundChangeEvent);
  }
}

/** The refund id generator, shared with the server so there is one source of it. */
export const newRefundId = generateRefundId;

/**
 * Whether a publish error means "the network said no" rather than "nobody knows".
 * The SDK raises `KeetaNetError` with a code when a representative rejected the
 * block; a transport failure has none. Anything we cannot classify is treated as
 * unknown, because the cost of a wrong "failed" is a double refund.
 */
export function isCleanRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, type } = error as { code?: unknown; type?: unknown };
  if (typeof code === 'string' && code !== '' && typeof type === 'string') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && (/does not have required permissions/.test(message) || /balance becomes negative/.test(message));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}
