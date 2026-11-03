/**
 * Identifier generation for sessions.
 *
 * Two identifiers, with different jobs:
 *
 * - The **session id** is a public capability. It appears in the pay-page URL and in
 *   the status and event routes, which are not behind the merchant's API key, so
 *   holding the id is what authorises reading and cancelling that one session.
 * - The **reference** goes into the `external` field of the payer's `SEND` and is
 *   how the watcher ties a payment to a session. It must never reach anyone but the
 *   payer of that session: knowing it would let someone attach their own payment to
 *   a session they did not create.
 *
 * Both carry 128 bits from `crypto.randomBytes`, so neither can be guessed or
 * enumerated, and collisions do not happen in practice. The store still enforces
 * uniqueness on both.
 */
import { randomBytes } from 'node:crypto';

/**
 * Characters the Keeta network accepts in a block's `external` field, per
 * `BLOCK_EXTERNAL_INVALID`: at most 1024 of `[-_A-Za-z0-9+/= ]`.
 *
 * base64url uses `A-Z a-z 0-9 - _`, every one of which is in that set, so a
 * base64url reference needs no escaping on the way to the chain.
 */
export const EXTERNAL_MAX_LENGTH = 1024;
const EXTERNAL_ALLOWED = /^[-_A-Za-z0-9+/= ]*$/;

/** True when a string is safe to put in a block's `external` field. */
export function isValidExternal(value: string): boolean {
  return value.length <= EXTERNAL_MAX_LENGTH && EXTERNAL_ALLOWED.test(value);
}

const ID_BYTES = 16; // 128 bits, 22 base64url characters

function randomToken(): string {
  return randomBytes(ID_BYTES).toString('base64url');
}

/** `cs_` for "checkout session", echoing the shape merchants know from Stripe. */
export function generateSessionId(): string {
  return `cs_${randomToken()}`;
}

/**
 * `kc_` for "Keeta Checkout". Kept short deliberately: it travels on-chain in every
 * payment, and the 1024-character budget is shared with nothing else today but may
 * later carry anchor-chaining fields.
 */
export function generatePaymentReference(): string {
  const reference = `kc_${randomToken()}`;
  /* c8 ignore next 3 -- unreachable: base64url is always external-safe. */
  if (!isValidExternal(reference)) {
    throw new Error(`generated reference "${reference}" is not valid for a Keeta external field`);
  }
  return reference;
}

/**
 * `rf_` for a refund. Like the others it is 128 random bits; it travels on-chain as
 * `kcr_<id>` in the refund send's `external`, which `refundExternal` builds.
 */
export function generateRefundId(): string {
  return `rf_${randomToken()}`;
}
