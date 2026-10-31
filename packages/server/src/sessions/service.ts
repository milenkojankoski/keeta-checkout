/**
 * Checkout session logic: validate a request, price it in a real token, store it,
 * and tell anyone watching when it changes.
 *
 * This layer owns the two rules inherited from the amount module's decision record
 * (`docs/decisions/0003`): input is trimmed before parsing, and a zero amount is
 * rejected here rather than in the parser, because whether zero is meaningful is a
 * checkout question, not an arithmetic one.
 */
import { EventEmitter } from 'node:events';
import { AmountError, formatBaseUnits, parseDecimalAmount } from '../amounts.ts';
import { EXPLORER_URL, type CheckoutConfig } from '../config.ts';
import { CheckoutError } from '../errors.ts';
import { buildPaymentUri, qrSvgUrlFor } from '../payment-request.ts';
import { TokenError, type ResolvedToken, type TokenRegistry } from '../tokens.ts';
import { classifyPayment, type Classification } from '../watcher/matcher.ts';
import { generatePaymentReference, generateSessionId } from './refs.ts';
import { StoreError, type ObservedPayment, type PaymentRecord, type PaymentRow, type SessionStore } from './store.ts';
import type { CreateSessionInput, MerchantSessionView, PublicSessionView, Session } from './types.ts';

/** How many times to retry when a generated identifier collides. */
const ID_RETRIES = 3;

export interface CheckoutServiceOptions {
  config: CheckoutConfig;
  store: SessionStore;
  tokens: TokenRegistry;
  /** Injectable clock, so tests can expire a session without waiting. */
  now?: () => number;
  log?: Pick<Console, 'error'>;
}

/** Emitted whenever a session's status changes. The SSE route is the main consumer. */
export interface SessionChangeEvent {
  session: Session;
}

/** What became of one inbound send. */
export interface ProcessedPayment {
  payment: PaymentRow;
  classification: Classification;
  /** `false` when the ledger already held this send: nothing was changed. */
  inserted: boolean;
  /** The session after any transition, when one was named. */
  session: Session | undefined;
}

export class CheckoutService {
  readonly #config: CheckoutConfig;
  readonly #store: SessionStore;
  readonly #tokens: TokenRegistry;
  readonly #now: () => number;
  readonly #log: Pick<Console, 'error'>;
  readonly #events = new EventEmitter({ captureRejections: true });

  constructor(options: CheckoutServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#tokens = options.tokens;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? console;
    // A busy pay page can hold many listeners on one session; the default cap of 10
    // would log a false leak warning.
    this.#events.setMaxListeners(0);
  }

  get config(): CheckoutConfig {
    return this.#config;
  }

  get store(): SessionStore {
    return this.#store;
  }

  /** Subscribe to one session's changes. Returns an unsubscribe function. */
  onSessionChange(id: string, listener: (event: SessionChangeEvent) => void): () => void {
    this.#events.on(`session:${id}`, listener);
    return () => {
      this.#events.off(`session:${id}`, listener);
    };
  }

  /**
   * Subscribe to *every* session's changes. The webhook dispatcher's hook; the
   * per-session stream uses {@link onSessionChange} instead.
   */
  onAnyChange(listener: (event: SessionChangeEvent) => void): () => void {
    this.#events.on('change', listener);
    return () => {
      this.#events.off('change', listener);
    };
  }

  /**
   * Subscribe to every inbound send the watcher processes, including the ones that
   * change no session. Money that arrived and could not be credited is exactly what
   * a merchant needs told about, and it produces no status change to hang off.
   */
  onPaymentRecorded(listener: (event: ProcessedPayment) => void): () => void {
    this.#events.on('payment', listener);
    return () => {
      this.#events.off('payment', listener);
    };
  }

  #emit(session: Session): void {
    const event: SessionChangeEvent = { session };
    this.#events.emit(`session:${session.id}`, event);
    this.#events.emit('change', event);
  }

  #emitPayment(event: ProcessedPayment): void {
    this.#events.emit('payment', event);
  }

  /**
   * The tokens a session may be priced in.
   *
   * With no configured list, this is every token the resolver lists whose ledger ACL
   * is open to any holder. Permit-listed tokens are left out: a shopper's wallet
   * cannot send one, so offering it would produce a checkout page that cannot be
   * paid. A merchant who names a restricted token explicitly gets an error at
   * session creation rather than a silent omission.
   */
  async acceptedTokens(): Promise<ResolvedToken[]> {
    const listed = await this.#tokens.list();
    if (this.#config.acceptedTokens.length === 0) {
      return listed.filter((token) => token.openToAnyHolder);
    }

    const accepted: ResolvedToken[] = [];
    for (const wanted of this.#config.acceptedTokens) {
      // A configured token that the resolver cannot place is a configuration error,
      // but it must not take down the whole token listing.
      const token = await this.#tokens.resolve(wanted).catch(() => undefined);
      if (token !== undefined && !accepted.some((existing) => existing.address === token.address)) {
        accepted.push(token);
      }
    }
    return accepted;
  }

  async #resolveRequestedToken(currency: string): Promise<ResolvedToken> {
    let token: ResolvedToken;
    try {
      token = await this.#tokens.resolve(currency);
    } catch (error) {
      if (error instanceof TokenError) {
        throw CheckoutError.invalid(error.code, error.message, 'currency');
      }
      throw error;
    }

    // Checked before the merchant's own list, so a misconfigured restricted token
    // reports the real reason rather than "not accepted".
    if (!token.openToAnyHolder) {
      throw CheckoutError.invalid(
        'TOKEN_NOT_TRANSFERABLE',
        `${token.ticker ?? token.address} is a permit-listed token: only accounts its issuer has approved can hold or send it, ` +
          'so a shopper cannot pay with it. Price the session in an open token such as $USDC, and use a Keeta payout to settle in fiat.',
        'currency'
      );
    }

    if (this.#config.acceptedTokens.length > 0) {
      const accepted = await this.acceptedTokens();
      if (!accepted.some((candidate) => candidate.address === token.address)) {
        throw CheckoutError.invalid(
          'TOKEN_NOT_ACCEPTED',
          `this merchant does not accept ${token.ticker ?? token.address}; accepted: ${accepted
            .map((candidate) => candidate.ticker ?? candidate.address)
            .join(', ')}`,
          'currency'
        );
      }
    }

    return token;
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const amountInput = requireString(input.amount, 'amount').trim();
    const currency = requireString(input.currency, 'currency').trim();
    const orderId = requireString(input.orderId, 'orderId').trim();
    const successUrl = requireUrl(input.successUrl, 'successUrl');
    const cancelUrl = requireUrl(input.cancelUrl, 'cancelUrl');

    if (orderId.length > 255) {
      throw CheckoutError.invalid('ORDER_ID_TOO_LONG', 'orderId must be at most 255 characters', 'orderId');
    }

    const expiresIn = this.#resolveExpiresIn(input.expiresIn);
    const token = await this.#resolveRequestedToken(currency);

    let amount: bigint;
    try {
      amount = parseDecimalAmount(amountInput, token.decimals);
    } catch (error) {
      if (error instanceof AmountError) {
        throw CheckoutError.invalid(error.code, error.message, 'amount');
      }
      throw error;
    }
    if (amount <= 0n) {
      throw CheckoutError.invalid('AMOUNT_NOT_POSITIVE', 'amount must be greater than zero', 'amount');
    }

    const createdAt = this.#now();
    const expiresAt = createdAt + expiresIn * 1000;

    let lastError: unknown;
    for (let attempt = 0; attempt < ID_RETRIES; attempt++) {
      const session: Session = {
        id: generateSessionId(),
        reference: generatePaymentReference(),
        orderId,
        amount,
        tokenAddress: token.address,
        tokenTicker: token.ticker,
        tokenDecimals: token.decimals,
        receivingAddress: this.#config.receivingAddress,
        network: this.#config.network,
        status: 'open',
        createdAt,
        expiresAt,
        graceUntil: expiresAt + this.#config.graceSeconds * 1000,
        successUrl,
        cancelUrl,
        paidBy: null,
        blockHash: null,
        operationIndex: null,
        paidAt: null,
        overpaidBy: null,
        updatedAt: createdAt
      };

      try {
        return await this.#store.create(session);
      } catch (error) {
        // A 128-bit collision does not happen in practice; retrying is cheap
        // insurance against a weak random source or a store that reuses ids.
        if (error instanceof StoreError && (error.code === 'DUPLICATE_ID' || error.code === 'DUPLICATE_REFERENCE')) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw CheckoutError.internal(
      `could not allocate a unique session identifier after ${ID_RETRIES} attempts: ${String(lastError)}`
    );
  }

  #resolveExpiresIn(requested: number | undefined): number {
    if (requested === undefined) return this.#config.defaultExpiresSeconds;
    if (!Number.isInteger(requested)) {
      throw CheckoutError.invalid('EXPIRES_IN_INVALID', 'expiresIn must be a whole number of seconds', 'expiresIn');
    }
    const { minExpiresSeconds, maxExpiresSeconds } = this.#config;
    if (requested < minExpiresSeconds || requested > maxExpiresSeconds) {
      throw CheckoutError.invalid(
        'EXPIRES_IN_OUT_OF_RANGE',
        `expiresIn must be between ${minExpiresSeconds} and ${maxExpiresSeconds} seconds`,
        'expiresIn'
      );
    }
    return requested;
  }

  /**
   * Fetch a session, expiring it first if its deadline has passed.
   *
   * Expiry is applied on read so a status is never stale to whoever is looking, and
   * the sweeper in {@link CheckoutService.sweepExpired} covers sessions nobody reads.
   */
  async getSession(id: string): Promise<Session> {
    const session = await this.#store.get(id);
    if (session === undefined) throw CheckoutError.notFound(`no session ${id}`);

    if (session.status === 'open' && session.expiresAt <= this.#now()) {
      const expired = await this.#store.expireDue(this.#now());
      const self = expired.find((candidate) => candidate.id === id);
      if (self !== undefined) {
        for (const other of expired) this.#emit(other);
        return self;
      }
      // Something else expired or paid it between the two reads; report what is stored.
      return (await this.#store.get(id)) ?? session;
    }

    return session;
  }

  async cancelSession(id: string): Promise<Session> {
    // Read through getSession first so an already-expired session reports `expired`
    // rather than being cancelled after the fact.
    const current = await this.getSession(id);
    if (current.status === 'cancelled') return current;

    try {
      const cancelled = await this.#store.cancel(id);
      this.#emit(cancelled);
      return cancelled;
    } catch (error) {
      if (error instanceof StoreError) {
        if (error.code === 'SESSION_NOT_FOUND') throw CheckoutError.notFound(`no session ${id}`);
        if (error.code === 'INVALID_TRANSITION') {
          throw CheckoutError.conflict('NOT_CANCELLABLE', `session ${id} is ${current.status} and cannot be cancelled`);
        }
      }
      throw error;
    }
  }

  /**
   * Decide what an inbound send is, apply it, and record it.
   *
   * Order matters for crash safety. The status transition goes **first** because
   * both transitions are idempotent, and the ledger row **second**. If the process
   * dies between them, the next scan re-reads the block: the session is already
   * paid by this exact send, the matcher reads that as a replay, and the ledger row
   * is written then. Recording first and dying would leave a row that says "paid"
   * beside a session that still says "open", and the dedup would then skip the fix.
   */
  async processPayment(observed: ObservedPayment, now: number = this.#now()): Promise<ProcessedPayment> {
    // Already in the ledger: this send has been judged, and the judgement stands.
    const existing = await this.#store.getPayment(observed.blockHash, observed.operationIndex);
    if (existing !== undefined) {
      const session = existing.sessionId === null ? undefined : await this.#store.get(existing.sessionId);
      return {
        payment: existing,
        classification: {
          disposition: existing.disposition,
          action: 'none',
          sessionId: existing.sessionId,
          reason: 'already recorded'
        },
        inserted: false,
        session
      };
    }

    // Make the stored status agree with the clock before judging anything against it.
    await this.sweepExpired(now);

    const session = observed.external === null ? undefined : await this.#store.getByReference(observed.external);
    const classification = classifyPayment(observed, session);

    let after = session;
    if (session !== undefined && classification.action !== 'none') {
      const record: PaymentRecord = {
        paidBy: observed.from,
        blockHash: observed.blockHash,
        operationIndex: observed.operationIndex,
        received: observed.amount,
        blockDate: observed.blockDate
      };
      try {
        after =
          classification.action === 'mark-paid'
            ? await this.#store.markPaid(session.id, record)
            : await this.#store.markUnmatched(session.id, record);
        if (after.status !== session.status || after.blockHash !== session.blockHash) this.#emit(after);
      } catch (error) {
        // The store's own rule disagreed with the matcher. That is a bug worth a
        // loud log, but the money is real and the ledger must still say it arrived.
        if (!(error instanceof StoreError)) throw error;
        this.#log.error(
          `[keeta-checkout] ${classification.action} refused for session ${session.id} (${classification.disposition}): ${error.message}`
        );
      }
    }

    const { inserted, payment } = await this.#store.recordPayment({
      ...observed,
      sessionId: classification.sessionId,
      disposition: classification.disposition,
      observedAt: now
    });

    const result: ProcessedPayment = { payment, classification, inserted, session: after };
    if (inserted) this.#emitPayment(result);
    return result;
  }

  /** Expire every session past its deadline and announce each one. Returns how many. */
  async sweepExpired(now: number = this.#now()): Promise<number> {
    const expired = await this.#store.expireDue(now);
    for (const session of expired) this.#emit(session);
    return expired.length;
  }

  /**
   * The hosted pay page's absolute URL, or `null` when `publicUrl` is unset.
   *
   * This is the link a merchant redirects a shopper to. It has to be absolute, so a
   * server that does not know where it is publicly reachable cannot offer one.
   */
  hostedUrlFor(session: Session): string | null {
    if (this.#config.publicUrl === undefined) return null;
    return `${this.#config.publicUrl}/pay/${encodeURIComponent(session.id)}`;
  }

  /** The `keeta://` payment request for a session, for a caller that wants only that. */
  paymentUriFor(session: Session): string {
    return buildPaymentUri(session);
  }

  /** The explorer link for a session's paying block, once there is one. */
  explorerUrlFor(session: Session): string | null {
    if (session.blockHash === null) return null;
    const base = EXPLORER_URL[this.#config.network];
    return `${base}/block/${session.blockHash}`;
  }

  /**
   * The payer-safe projection.
   *
   * It carries no `reference` field, but it is not reference-free: `uri` is the
   * `keeta://` request, and the reference is its `external` parameter. That is not a
   * leak, it is the mechanism. The payer has to put the reference in their own SEND,
   * so a payer who cannot see it cannot pay.
   *
   * What actually protects a session is the session id, which is 128 random bits and
   * is the capability for this route, the event stream and cancellation alike. Anyone
   * who can read the reference already holds the id, and so can already do everything
   * the reference would let them do. Treat the id as the secret; see `refs.ts`.
   */
  toPublicView(session: Session): PublicSessionView {
    return {
      id: session.id,
      status: session.status,
      uri: buildPaymentUri(session),
      qrSvgUrl: qrSvgUrlFor(session, this.#config),
      hostedUrl: this.hostedUrlFor(session),
      amount: session.amount.toString(),
      amountDecimal: formatBaseUnits(session.amount, session.tokenDecimals),
      tokenAddress: session.tokenAddress,
      tokenTicker: session.tokenTicker,
      tokenDecimals: session.tokenDecimals,
      receivingAddress: session.receivingAddress,
      network: session.network,
      orderId: session.orderId,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      successUrl: session.successUrl,
      cancelUrl: session.cancelUrl,
      explorerUrl: this.explorerUrlFor(session),
      paidBy: session.paidBy,
      blockHash: session.blockHash,
      operationIndex: session.operationIndex,
      paidAt: session.paidAt === null ? null : new Date(session.paidAt).toISOString(),
      overpaidBy: session.overpaidBy === null ? null : session.overpaidBy.toString()
    };
  }

  /**
   * The merchant projection.
   *
   * It lifts the reference out of the URI into a field of its own, and adds the two
   * timestamps a merchant reconciles against. None of it is secret from the payer,
   * who can read the reference off the URI; it is here because a merchant matching
   * their own records should not have to parse a payment URI to do it.
   */
  toMerchantView(session: Session): MerchantSessionView {
    return {
      ...this.toPublicView(session),
      reference: session.reference,
      graceUntil: new Date(session.graceUntil).toISOString(),
      updatedAt: new Date(session.updatedAt).toISOString()
    };
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw CheckoutError.invalid('FIELD_REQUIRED', `${field} is required and must be a non-empty string`, field);
  }
  return value;
}

function requireUrl(value: unknown, field: string): string {
  const raw = requireString(value, field).trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw CheckoutError.invalid('URL_INVALID', `${field} must be an absolute http or https URL`, field);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw CheckoutError.invalid('URL_INVALID', `${field} must use http or https, got ${parsed.protocol}`, field);
  }
  return raw;
}
