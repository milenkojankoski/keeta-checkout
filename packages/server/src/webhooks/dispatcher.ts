/**
 * Telling merchants what happened.
 *
 * The dispatcher subscribes to the service, writes a delivery row per endpoint per
 * event, and then sends them. Writing first and sending second is deliberate: the
 * watcher must never wait on a merchant's HTTP server, and an event that was
 * recorded but not yet sent is recoverable, while one that was never recorded is
 * lost.
 *
 * Guarantees, and the limits worth stating plainly:
 *
 * - **At least once.** A delivery that times out after the endpoint already
 *   processed it will be retried. Handlers must dedupe on `event.id`.
 * - **Not ordered.** Retries interleave, so `session.paid` can arrive after
 *   `session.unmatched` for the same session. The event body carries the session's
 *   state at the time of the event, and `created` says when that was.
 * - **Retried for about 24 hours**, then marked `exhausted` and left for a human.
 */
import { randomBytes } from 'node:crypto';
import { EXPLORER_URL, type CheckoutConfig, type WebhookEndpoint } from '../config.ts';
import type { CheckoutService, ProcessedPayment, SessionChangeEvent } from '../sessions/service.ts';
import { REFUNDABLE_DISPOSITIONS, type PaymentRow, type SessionStore } from '../sessions/store.ts';
import { SIGNATURE_HEADER, signWebhook } from './signature.ts';
import {
  EVENT_TYPE_BY_REFUND_STATUS,
  EVENT_TYPE_BY_STATUS,
  toRefundView,
  type DeliveryAttemptResult,
  type WebhookDelivery,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookPaymentView
} from './types.ts';
import type { Refund } from '../refunds/types.ts';

/**
 * Delay before each retry, in milliseconds, after the attempt that just failed.
 * Ten retries after the first attempt, summing to a little under 24 hours.
 */
export const RETRY_SCHEDULE_MS: readonly number[] = [
  10_000, // 10s
  30_000, // 30s
  120_000, // 2m
  600_000, // 10m
  1_800_000, // 30m
  3_600_000, // 1h
  7_200_000, // 2h
  14_400_000, // 4h
  28_800_000, // 8h
  28_800_000 // 8h
] as const;

export const MAX_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;

/** Delivery attempts are abandoned after this long, whatever the response. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Longest error text kept on a delivery row. */
const MAX_ERROR_LENGTH = 500;

export interface WebhookDispatcherOptions {
  service: CheckoutService;
  config: CheckoutConfig;
  /** Injected so tests can answer without a network. Defaults to `fetch`. */
  fetchImpl?: typeof fetch;
  /** How many due deliveries to attempt per pass. */
  batchSize?: number;
  now?: () => number;
  log?: Pick<Console, 'error' | 'warn'>;
  /** Jitter fraction applied to each retry delay, to spread a thundering herd. Default 0.1. */
  jitter?: number;
  /** Deterministic jitter for tests. */
  random?: () => number;
}

export class WebhookDispatcher {
  readonly #service: CheckoutService;
  readonly #store: SessionStore;
  readonly #config: CheckoutConfig;
  readonly #fetch: typeof fetch;
  readonly #batchSize: number;
  readonly #now: () => number;
  readonly #log: Pick<Console, 'error' | 'warn'>;
  readonly #jitter: number;
  readonly #random: () => number;

  #unsubscribe: Array<() => void> = [];
  #subscribed = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<number> | undefined;
  /** Enqueue work started by an event, so `stop()` can wait for it. */
  #pending = new Set<Promise<unknown>>();

  constructor(options: WebhookDispatcherOptions) {
    this.#service = options.service;
    this.#store = options.service.store;
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#batchSize = options.batchSize ?? 20;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? console;
    this.#jitter = options.jitter ?? 0.1;
    this.#random = options.random ?? Math.random;
  }

  get endpoints(): readonly WebhookEndpoint[] {
    return this.#config.webhookEndpoints;
  }

  /**
   * Subscribe to the service and start the retry timer.
   *
   * Does nothing useful with no endpoints configured, so it says so rather than
   * quietly running a timer that will never have work.
   *
   * `retryIntervalMs` of `0` subscribes without a timer, for a caller that drives
   * {@link flush} itself.
   */
  start(retryIntervalMs = 10_000): void {
    if (this.#subscribed) return;
    if (this.endpoints.length === 0) {
      this.#log.warn('[keeta-checkout] webhook dispatcher started with no endpoints configured; no events will be sent');
    }

    this.#subscribed = true;
    this.#unsubscribe.push(
      this.#service.onAnyChange((event) => this.#track(this.enqueueSessionChange(event))),
      this.#service.onPaymentRecorded((event) => this.#track(this.enqueuePaymentRecorded(event)))
    );

    if (retryIntervalMs > 0) {
      void this.flush();
      this.#timer = setInterval(() => void this.flush(), retryIntervalMs);
      this.#timer.unref();
    }
  }

  /**
   * Wait for the enqueue work that events have already started.
   *
   * A session change fires synchronously but its delivery rows are written
   * asynchronously, so anything that needs those rows to exist, a graceful shutdown
   * or a test, has to wait for this first.
   */
  async settled(): Promise<void> {
    // An enqueue can itself emit nothing further, but awaiting the set while it is
    // being drained means re-checking until it is empty.
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
    await this.#inFlight;
  }

  /** Unsubscribe, stop the timer, and wait for work already in progress. */
  async stop(): Promise<void> {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#subscribed = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.settled();
  }

  #track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.#log.error('[keeta-checkout] could not enqueue a webhook', error);
    });
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }

  /** A session status change, when it maps to an event merchants care about. */
  async enqueueSessionChange(event: SessionChangeEvent): Promise<WebhookDelivery[]> {
    const type = EVENT_TYPE_BY_STATUS[event.session.status];
    if (type === undefined) return []; // `open` is not news
    return this.#enqueue(type, { session: this.#service.toMerchantView(event.session) });
  }

  /**
   * A newly recorded inbound send.
   *
   * Only the refundable dispositions are sent: a `matched` or `overpaid` payment
   * already produced `checkout.session.paid`, and sending both would have merchants
   * handling the same money twice.
   */
  async enqueuePaymentRecorded(event: ProcessedPayment): Promise<WebhookDelivery[]> {
    if (!event.inserted) return []; // a re-read of a send already handled
    if (!REFUNDABLE_DISPOSITIONS.has(event.payment.disposition)) return [];

    return this.#enqueue('checkout.payment.recorded', {
      payment: this.toPaymentView(event.payment),
      ...(event.session === undefined ? {} : { session: this.#service.toMerchantView(event.session) })
    });
  }

  toPaymentView(payment: PaymentRow): WebhookPaymentView {
    return {
      blockHash: payment.blockHash,
      operationIndex: payment.operationIndex,
      from: payment.from,
      to: payment.to,
      tokenAddress: payment.tokenAddress,
      amount: payment.amount.toString(),
      external: payment.external,
      blockDate: new Date(payment.blockDate).toISOString(),
      sessionId: payment.sessionId,
      disposition: payment.disposition,
      refundable: REFUNDABLE_DISPOSITIONS.has(payment.disposition),
      explorerUrl: `${EXPLORER_URL[this.#config.network]}/block/${payment.blockHash}`
    };
  }

  #enqueue(type: WebhookEventType, data: WebhookEvent['data']): Promise<WebhookDelivery[]> {
    return enqueueWebhookEvent(this.#store, this.#config, type, data, this.#now());
  }

  /** Attempt every delivery that is due. Returns how many were attempted. */
  flush(): Promise<number> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    this.#inFlight = this.#flush()
      .catch((error: unknown) => {
        this.#log.error('[keeta-checkout] webhook flush failed', error);
        return 0;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  async #flush(): Promise<number> {
    const now = this.#now();
    // Claiming pushes each row's next attempt forward, so a second dispatcher
    // process does not pick up the same delivery while this one is sending it.
    const due = await this.#store.claimDueDeliveries(now, this.#batchSize, now + REQUEST_TIMEOUT_MS * 2);
    for (const delivery of due) await this.#attempt(delivery);
    return due.length;
  }

  async #attempt(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    const endpoint = this.endpoints.find((candidate) => candidate.url === delivery.endpointUrl);
    if (endpoint === undefined) {
      // The endpoint was removed from the configuration after this was queued.
      this.#log.warn(`[keeta-checkout] dropping webhook ${delivery.id}: ${delivery.endpointUrl} is no longer configured`);
      return this.#store.recordDeliveryResult(delivery.id, {
        status: 'exhausted',
        attempts: delivery.attempts,
        lastError: 'the endpoint is no longer configured',
        lastStatusCode: null,
        at: this.#now()
      });
    }

    const result = await this.#send(endpoint, delivery);
    const attempts = delivery.attempts + 1;
    const at = this.#now();

    if (result.ok) {
      return this.#store.recordDeliveryResult(delivery.id, {
        status: 'delivered',
        attempts,
        lastError: null,
        lastStatusCode: result.statusCode ?? null,
        at,
        deliveredAt: at
      });
    }

    const delay = RETRY_SCHEDULE_MS[attempts - 1];
    if (delay === undefined) {
      this.#log.error(
        `[keeta-checkout] webhook ${delivery.id} (${delivery.eventType}) gave up after ${attempts} attempts to ${endpoint.url}: ${result.error ?? 'unknown'}`
      );
      return this.#store.recordDeliveryResult(delivery.id, {
        status: 'exhausted',
        attempts,
        lastError: truncate(result.error),
        lastStatusCode: result.statusCode ?? null,
        at
      });
    }

    return this.#store.recordDeliveryResult(delivery.id, {
      status: 'pending',
      attempts,
      lastError: truncate(result.error),
      lastStatusCode: result.statusCode ?? null,
      at,
      nextAttemptAt: at + this.#withJitter(delay)
    });
  }

  #withJitter(delay: number): number {
    if (this.#jitter <= 0) return delay;
    const spread = delay * this.#jitter;
    return Math.max(0, Math.round(delay - spread + this.#random() * spread * 2));
  }

  async #send(endpoint: WebhookEndpoint, delivery: WebhookDelivery): Promise<DeliveryAttemptResult> {
    const timestampSeconds = Math.floor(this.#now() / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.#fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'keeta-checkout-webhooks/1',
          [SIGNATURE_HEADER]: signWebhook({ rawBody: delivery.payload, secret: endpoint.secret, timestampSeconds }),
          'Keeta-Checkout-Event-Id': delivery.eventId,
          'Keeta-Checkout-Event-Type': delivery.eventType,
          'Keeta-Checkout-Attempt': String(delivery.attempts + 1)
        },
        body: delivery.payload,
        signal: controller.signal,
        // A merchant endpoint that redirects is a misconfiguration, and following a
        // redirect would resend a signed body to a URL the merchant did not name.
        redirect: 'manual'
      });

      if (response.ok) return { ok: true, statusCode: response.status };
      return { ok: false, statusCode: response.status, error: `the endpoint answered ${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: controller.signal.aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : message };
    } finally {
      clearTimeout(timer);
    }
  }
}

function truncate(value: string | undefined): string | null {
  if (value === undefined) return null;
  return value.length <= MAX_ERROR_LENGTH ? value : `${value.slice(0, MAX_ERROR_LENGTH)}…`;
}

/**
 * Write the deliveries for one event, one per endpoint that wants it.
 *
 * A function rather than a method so that a process which has no dispatcher of
 * its own can still raise an event: the refund process writes `refund.*` rows into
 * the shared store this way, and the checkout server's dispatcher sends them. The
 * store is the queue; which process wrote a row does not matter to it.
 */
export async function enqueueWebhookEvent(
  store: Pick<SessionStore, 'enqueueDelivery'>,
  config: Pick<CheckoutConfig, 'network' | 'webhookEndpoints'>,
  type: WebhookEventType,
  data: WebhookEvent['data'],
  now: number = Date.now()
): Promise<WebhookDelivery[]> {
  const endpoints = config.webhookEndpoints.filter((endpoint) => endpoint.events.includes(type));
  if (endpoints.length === 0) return [];

  const event: WebhookEvent = {
    id: `evt_${randomBytes(16).toString('base64url')}`,
    type,
    created: new Date(now).toISOString(),
    network: config.network,
    data
  };
  // Serialised once. Every endpoint and every retry sends these exact bytes, which
  // is what the signature covers.
  const payload = JSON.stringify(event);

  const created: WebhookDelivery[] = [];
  for (const endpoint of endpoints) {
    created.push(
      await store.enqueueDelivery({
        id: `whd_${randomBytes(12).toString('base64url')}`,
        eventId: event.id,
        eventType: type,
        endpointUrl: endpoint.url,
        payload,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        lastStatusCode: null,
        createdAt: now,
        updatedAt: now,
        deliveredAt: null
      })
    );
  }
  return created;
}

/** A refund status change, when it maps to an event. Used by the refund process. */
export function enqueueRefundChange(
  store: Pick<SessionStore, 'enqueueDelivery'>,
  config: Pick<CheckoutConfig, 'network' | 'webhookEndpoints'>,
  refund: Refund,
  now: number = Date.now()
): Promise<WebhookDelivery[]> {
  const type = EVENT_TYPE_BY_REFUND_STATUS[refund.status];
  if (type === undefined) return Promise.resolve([]);
  return enqueueWebhookEvent(store, config, type, { refund: toRefundView(refund, config.network) }, now);
}
