/**
 * Webhook events and deliveries.
 *
 * An **event** is something that happened: a session was paid, money arrived that
 * cannot be credited. A **delivery** is one attempt to tell one endpoint about one
 * event. Two endpoints means two deliveries of the same event, each with its own
 * retry state, and each carrying the same `event.id` so a merchant can dedupe.
 */
import type { MerchantSessionView, Session, SessionStatus } from '../sessions/types.ts';
import { formatBaseUnits } from '../amounts.ts';
import type { PaymentDisposition } from '../sessions/store.ts';
import type { Refund, RefundOrigin, RefundReason, RefundStatus } from '../refunds/types.ts';
import { EXPLORER_URL, type KeetaNetworkName } from '../config.ts';

/**
 * What a merchant can be told about.
 *
 * The session events cover the status changes a merchant acts on: fulfil the order,
 * release the inventory, refund the money.
 *
 * `checkout.payment.recorded` is the one that is easy to forget and expensive to
 * miss: money that arrived and was **not** credited to a session, because it was
 * short, late, unreferenced, or in the wrong token. Nothing changes a session
 * status in those cases, so without this event the money would sit unnoticed.
 */
export type WebhookEventType =
  | 'checkout.session.paid'
  | 'checkout.session.expired'
  | 'checkout.session.cancelled'
  | 'checkout.session.unmatched'
  | 'checkout.payment.recorded'
  | 'refund.requested'
  | 'refund.published'
  | 'refund.failed'
  | 'refund.refused';

export const WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  'checkout.session.paid',
  'checkout.session.expired',
  'checkout.session.cancelled',
  'checkout.session.unmatched',
  'checkout.payment.recorded',
  'refund.requested',
  'refund.published',
  'refund.failed',
  'refund.refused'
] as const;

/**
 * The refund states a merchant is told about. `publishing` is not one: it is a
 * moment inside the process, not an outcome, and a merchant acting on it would
 * be acting on something that may still go either way.
 */
export const EVENT_TYPE_BY_REFUND_STATUS: Partial<Record<RefundStatus, WebhookEventType>> = {
  requested: 'refund.requested',
  published: 'refund.published',
  failed: 'refund.failed',
  refused: 'refund.refused'
};

/** A refund as a merchant sees it. Amounts are strings; see the payment view. */
export interface WebhookRefundView {
  id: string;
  paymentBlockHash: string;
  paymentOperationIndex: number;
  sessionId: string | null;
  to: string;
  tokenAddress: string;
  amount: string;
  reason: RefundReason;
  origin: RefundOrigin;
  status: RefundStatus;
  attempts: number;
  /** The block that carried it, once published. */
  blockHash: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  explorerUrl: string | null;
  /** The order the refunded payment belongs to, when it was matched to a session. */
  orderId: string | null;
  /**
   * The amount as a decimal, and the token's ticker, when the session says what the
   * token is. Null for a payment in a different token from its session's, whose
   * decimals this server cannot vouch for; the base-unit `amount` is always there.
   */
  amountDecimal: string | null;
  tokenTicker: string | null;
}

/**
 * A refund as a merchant sees it. Pass the refunded payment's session, when there is
 * one, so the view can name the order and show the amount in the token's own units.
 */
export function toRefundView(refund: Refund, network: KeetaNetworkName, session?: Session): WebhookRefundView {
  const sameToken = session !== undefined && session.tokenAddress === refund.tokenAddress ? session : undefined;
  return {
    id: refund.id,
    paymentBlockHash: refund.paymentBlockHash,
    paymentOperationIndex: refund.paymentOperationIndex,
    sessionId: refund.sessionId,
    to: refund.to,
    tokenAddress: refund.tokenAddress,
    amount: refund.amount.toString(),
    reason: refund.reason,
    origin: refund.origin,
    status: refund.status,
    attempts: refund.attempts,
    blockHash: refund.blockHash,
    lastError: refund.lastError,
    createdAt: new Date(refund.createdAt).toISOString(),
    updatedAt: new Date(refund.updatedAt).toISOString(),
    publishedAt: refund.publishedAt === null ? null : new Date(refund.publishedAt).toISOString(),
    explorerUrl: refund.blockHash === null ? null : `${EXPLORER_URL[network]}/block/${refund.blockHash}`,
    orderId: session?.orderId ?? null,
    amountDecimal: sameToken === undefined ? null : formatBaseUnits(refund.amount, sameToken.tokenDecimals),
    tokenTicker: sameToken === undefined ? null : sameToken.tokenTicker
  };
}

/** The status changes that map to an event, and which one. */
export const EVENT_TYPE_BY_STATUS: Partial<Record<SessionStatus, WebhookEventType>> = {
  paid: 'checkout.session.paid',
  expired: 'checkout.session.expired',
  cancelled: 'checkout.session.cancelled',
  unmatched: 'checkout.session.unmatched'
};

/** The payment as a merchant sees it in an event body. */
export interface WebhookPaymentView {
  blockHash: string;
  operationIndex: number;
  from: string;
  to: string;
  tokenAddress: string;
  /** Base units, as a decimal string: JSON has no bigint. */
  amount: string;
  external: string | null;
  blockDate: string;
  sessionId: string | null;
  disposition: PaymentDisposition;
  /** Whether this money is sitting with the merchant and should go back. */
  refundable: boolean;
  explorerUrl: string;
}

/**
 * The JSON body of a delivery.
 *
 * Shaped so a handler can switch on `type` and read `data.session` or
 * `data.payment`. A session event always carries the session; a payment event
 * carries the payment and, when the reference named one, the session too.
 */
export interface WebhookEvent {
  /** Stable across retries and across endpoints. Dedupe on this. */
  id: string;
  type: WebhookEventType;
  /** When the event happened, ISO-8601. */
  created: string;
  /** `test` or `main`, so a handler cannot confuse the two. */
  network: string;
  data: {
    session?: MerchantSessionView;
    payment?: WebhookPaymentView;
    refund?: WebhookRefundView;
  };
}

export type DeliveryStatus =
  /** Waiting for its first attempt, or for a retry. */
  | 'pending'
  /** The endpoint answered 2xx. */
  | 'delivered'
  /** Out of attempts. A merchant must reconcile this one by hand. */
  | 'exhausted';

/** One endpoint's attempt history for one event. */
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: WebhookEventType;
  /** Which endpoint, by URL. */
  endpointUrl: string;
  /**
   * The exact body to send, frozen at enqueue.
   *
   * Never re-serialised on a retry: the signature covers these bytes, and an event
   * is a record of what happened, not a view of what is true now. A retry two hours
   * later must still say what the first attempt said.
   */
  payload: string;
  status: DeliveryStatus;
  /** How many HTTP attempts have been made. */
  attempts: number;
  /** When the next attempt is due. Meaningless once not `pending`. */
  nextAttemptAt: number;
  /** The last failure, for the merchant's dashboard. Never contains the secret. */
  lastError: string | null;
  /** The last HTTP status seen, when there was a response at all. */
  lastStatusCode: number | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}

export interface DeliveriesQuery {
  statuses?: readonly DeliveryStatus[];
  eventId?: string;
  limit?: number;
}

/** What happened on one attempt. */
export interface DeliveryAttemptResult {
  ok: boolean;
  statusCode?: number | undefined;
  error?: string | undefined;
}
