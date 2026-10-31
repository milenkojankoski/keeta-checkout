/**
 * The checkout session: what a merchant creates, what a payer pays, what the
 * watcher marks settled.
 *
 * Amounts are always `bigint` base units of `tokenAddress`. Timestamps are
 * milliseconds since the epoch, as `Date.now()` returns.
 */

/**
 * Where a session is in its life.
 *
 * ```
 *  open ──pay──▶ paid
 *   │
 *   ├──expiry──▶ expired ──late pay──▶ unmatched
 *   │
 *   └──cancel──▶ cancelled
 * ```
 *
 * - `open`      waiting for a payment, and not yet past `expiresAt`
 * - `paid`      a matching send was observed and the order can be fulfilled
 * - `expired`   `expiresAt` passed with no matching send
 * - `cancelled` the merchant or the payer gave up before paying
 * - `unmatched` money arrived that cannot be credited to an open session: a send
 *               after expiry, or a second send to an already-paid session. The
 *               merchant should refund it. Set by the watcher (step 5).
 */
export type SessionStatus = 'open' | 'paid' | 'expired' | 'cancelled' | 'unmatched';

/** Statuses that never change again on their own. */
export const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>([
  'paid',
  'cancelled',
  'unmatched'
]);

export function isTerminal(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Everything stored about one session. */
export interface Session {
  /** Public capability. Appears in URLs and is safe to show a payer. */
  readonly id: string;
  /**
   * Goes into the `external` field of the payer's `SEND` operation and is how the
   * watcher ties a payment to this session. Random and unguessable, never the
   * merchant's own order number.
   */
  readonly reference: string;
  /** The merchant's own order identifier, for their reconciliation. Opaque here. */
  readonly orderId: string;

  /** Amount owed, in base units of `tokenAddress`. Always greater than zero. */
  readonly amount: bigint;
  /** `keeta_…` address of the token this session is priced in. */
  readonly tokenAddress: string;
  /** The resolver's ticker for that token, or `null` if it lists none. */
  readonly tokenTicker: string | null;
  /** Decimals as read from the token's on-chain metadata when the session was created. */
  readonly tokenDecimals: number;

  /** `keeta_…` account the payer must send to. */
  readonly receivingAddress: string;
  /** Network the session lives on: `test` or `main`. */
  readonly network: string;

  status: SessionStatus;

  readonly createdAt: number;
  readonly expiresAt: number;
  /**
   * Until when a late payment is still treated as this session's rather than as a
   * stray send. Always at or after `expiresAt`. The watcher uses it; the store only
   * records it.
   */
  readonly graceUntil: number;

  /** Where to send the payer after a successful payment. */
  readonly successUrl: string;
  /** Where to send the payer if they back out. */
  readonly cancelUrl: string;

  /** `keeta_…` account the payment actually came from. Set when paid. */
  paidBy: string | null;
  /** Hash of the block carrying the payment. With `operationIndex`, the watcher's idempotency key. */
  blockHash: string | null;
  /**
   * Index of the paying `SEND` inside that block. One block can carry several sends,
   * including two to the same merchant, so the hash alone does not identify a payment.
   */
  operationIndex: number | null;
  /** When the payment was observed. */
  paidAt: number | null;
  /** Base units received beyond `amount`, when the payer overpaid. */
  overpaidBy: bigint | null;

  /** Last change to `status` or any of the payment fields. */
  updatedAt: number;
}

/** What a merchant's backend supplies to create a session. All strings untrimmed. */
export interface CreateSessionInput {
  /** Decimal string, such as `"12.50"`. Converted to base units exactly, never rounded. */
  amount: string;
  /** A ticker the merchant accepts (`"$USDC"`, `"usdc"`) or a `keeta_…` token address. */
  currency: string;
  /** The merchant's order identifier. */
  orderId: string;
  successUrl: string;
  cancelUrl: string;
  /** Seconds the session stays open. Defaults to the server's configured value. */
  expiresIn?: number;
}

/**
 * The session as the payer's browser may see it: everything needed to pay and to
 * show progress, and nothing else. Returned by the public status and event routes.
 *
 * It carries `uri`, which necessarily embeds the session's payment reference. That
 * is correct rather than a leak: holding a session's id is exactly what entitles
 * someone to pay that session, and the reference is the instruction for doing so.
 * What stays impossible is learning a *different* session's reference. See
 * `docs/decisions/0006-payment-uri-and-qr.md`.
 */
export interface PublicSessionView {
  id: string;
  status: SessionStatus;
  /** The `keeta://` payment request a wallet acts on. */
  uri: string;
  /** Where to fetch this session's QR code as an SVG image. */
  qrSvgUrl: string;
  /**
   * The hosted pay page for this session, when the server knows its own public URL.
   * `null` otherwise, because a relative link would be wrong in the merchant's
   * redirect and in an email.
   */
  hostedUrl: string | null;
  /** Base units as a decimal string, because JSON has no `bigint`. */
  amount: string;
  /** Human-readable amount, for display only. */
  amountDecimal: string;
  tokenAddress: string;
  tokenTicker: string | null;
  tokenDecimals: number;
  receivingAddress: string;
  network: string;
  orderId: string;
  createdAt: string;
  expiresAt: string;
  successUrl: string;
  cancelUrl: string;
  /** Explorer link for the paying block, once paid. */
  explorerUrl: string | null;
  paidBy: string | null;
  blockHash: string | null;
  operationIndex: number | null;
  paidAt: string | null;
  overpaidBy: string | null;
}

/**
 * The merchant's view: the public fields plus the bare payment reference and the
 * session's internal timings.
 *
 * The reference is also inside `uri`, which payers see, so this field is a
 * convenience for a merchant reconciling against the chain rather than a secret the
 * public view withholds.
 */
export interface MerchantSessionView extends PublicSessionView {
  reference: string;
  graceUntil: string;
  updatedAt: string;
}
