/**
 * The refund ledger.
 *
 * A refund is a row that points at a payment. Everything that decides where the
 * money goes is derived from that payment and frozen here when the row is created:
 * the recipient is the payer, the token is the one they paid in, the amount is the
 * whole payment or exactly the overpaid excess. There is no field a caller can set
 * to send a different amount somewhere else. See docs/decisions/0014, decision 6.
 *
 * The status machine is the one from decision 9:
 *
 *   requested -> publishing -> published
 *                    |
 *                    +-> requested   (reconciled: nothing on chain, try again)
 *                    +-> failed      (the network refused it, for a person)
 *                    +-> refused     (a limit said no, before anything was sent)
 *   requested -> refused             (the same, decided without a claim)
 *
 * `publishing` is written before the send is attempted and carries the time it
 * started, so a process that dies between the write and the publish leaves a row
 * that the next run reconciles against the chain instead of retrying blind.
 */

export const REFUND_STATUSES = ['requested', 'publishing', 'published', 'failed', 'refused'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * Why this money is going back: the payment's disposition, or `overpaid` for the
 * excess on a paid session. Every refundable disposition is a valid reason at the
 * ledger; whether the vault can actually pay it (it holds one token) is the
 * process's decision, made when the refund is claimed, and recorded as `refused`.
 */
export const REFUND_REASONS = [
  'underpaid',
  'late',
  'duplicate',
  'cancelled',
  'wrong_token',
  'wrong_recipient',
  'unknown_reference',
  'no_reference',
  'overpaid'
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** Who asked. `auto` is the process acting on the merchant's `autoRefund` setting. */
export type RefundOrigin = 'api' | 'auto';

export interface Refund {
  /** `rf_` plus 128 random bits. Travels on-chain as `kcr_<id>` in the send's `external`. */
  id: string;
  /** The payment being returned, by its ledger key. One refund per payment, enforced by the store. */
  paymentBlockHash: string;
  paymentOperationIndex: number;
  /** The session that payment was matched to, if any. */
  sessionId: string | null;
  /** The payer's address: the only place a refund can go. */
  to: string;
  /** The token they paid in: the only token a refund can be in. */
  tokenAddress: string;
  /** Base units. The whole payment, or for `overpaid` exactly the excess. */
  amount: bigint;
  reason: RefundReason;
  origin: RefundOrigin;
  status: RefundStatus;
  /** How many times a publish has been started. */
  attempts: number;
  /** When the current or last `publishing` began, for the reconciliation window. */
  attemptStartedAt: number | null;
  /** The block that carried it, once published. */
  blockHash: string | null;
  /** The last network or limit message, for a person. */
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
}

/** What `POST /api/payments/{id}/refund` and the auto-refund path hand to the store. */
export type NewRefund = Omit<
  Refund,
  'status' | 'attempts' | 'attemptStartedAt' | 'blockHash' | 'lastError' | 'updatedAt' | 'publishedAt'
>;

export interface RefundsQuery {
  statuses?: readonly RefundStatus[];
  sessionId?: string;
  limit?: number;
}

/** The outcome of one publish attempt, or of a limit check, recorded against the row. */
export interface RefundResultUpdate {
  status: Exclude<RefundStatus, 'publishing'>;
  at: number;
  blockHash?: string;
  lastError?: string | null;
}

/** The on-chain `external` for a refund, so the ledger can be reconciled from history alone. */
export function refundExternal(refundId: string): string {
  return `kcr_${refundId.replace(/^rf_/, '')}`;
}

/** The inverse: the refund id a block's `external` names, or undefined. */
export function refundIdFromExternal(external: string | null | undefined): string | undefined {
  if (external === null || external === undefined) return undefined;
  const match = /^kcr_([A-Za-z0-9_-]{22})$/.exec(external);
  return match === null ? undefined : `rf_${match[1]}`;
}
