/**
 * Webhook signatures, in the shape merchants already handle from Stripe.
 *
 * Every delivery carries:
 *
 * ```
 * Keeta-Checkout-Signature: t=1762000000,v1=9f86d08...
 * ```
 *
 * The signed value is `${t}.${rawBody}`, HMAC-SHA256 with the endpoint's secret,
 * hex-encoded. The timestamp is inside the signature, so an attacker cannot replay
 * a captured delivery with a fresh timestamp.
 *
 * `verifyWebhookSignature` is exported for merchants to use in their own handler.
 * It is the one function in this package their code is expected to call.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Keeta-Checkout-Signature';

/** The current signature scheme. A future scheme would add `v2=…` alongside. */
export const SIGNATURE_SCHEME = 'v1';

/** How much clock difference between sender and receiver is tolerated, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureFailureReason =
  | 'MALFORMED_HEADER'
  | 'NO_SIGNATURES'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'NO_MATCH';

export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';

  constructor(
    readonly reason: SignatureFailureReason,
    message: string
  ) {
    super(message);
  }
}

/** The exact bytes that get signed: the timestamp, a dot, then the body verbatim. */
export function signedPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/** Build the header value for one delivery. */
export function signWebhook(options: {
  rawBody: string;
  secret: string;
  timestampSeconds: number;
}): string {
  const signature = hmacHex(options.secret, signedPayload(options.timestampSeconds, options.rawBody));
  return `t=${options.timestampSeconds},${SIGNATURE_SCHEME}=${signature}`;
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

function parseHeader(header: string): ParsedHeader {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      if (!/^\d+$/.test(value)) {
        throw new WebhookSignatureError('MALFORMED_HEADER', `the timestamp "${value}" is not a whole number of seconds`);
      }
      timestamp = Number(value);
    } else if (key === SIGNATURE_SCHEME) {
      signatures.push(value);
    }
    // Unknown keys are ignored, so a future `v2=` can be added without breaking
    // handlers written against v1.
  }

  if (timestamp === undefined) {
    throw new WebhookSignatureError('MALFORMED_HEADER', `the ${SIGNATURE_HEADER} header has no t= timestamp`);
  }
  if (signatures.length === 0) {
    throw new WebhookSignatureError('NO_SIGNATURES', `the ${SIGNATURE_HEADER} header has no ${SIGNATURE_SCHEME}= signature`);
  }
  return { timestamp, signatures };
}

export interface VerifyOptions {
  /**
   * The request body **exactly as received**, before any JSON parsing. A
   * re-serialised object will not match: key order and spacing are part of what was
   * signed.
   */
  rawBody: string;
  /** The `Keeta-Checkout-Signature` header value. */
  header: string | undefined | null;
  /**
   * The endpoint's signing secret, or several during a rotation. Any match passes.
   */
  secret: string | readonly string[];
  /** Reject a delivery whose timestamp is further away than this. Default 300s. */
  toleranceSeconds?: number;
  /** Current time in seconds, for tests. */
  nowSeconds?: number;
}

/**
 * Verify a delivery. Returns the signature timestamp, or throws
 * {@link WebhookSignatureError}.
 *
 * Every candidate is compared even after a match, so the time taken does not reveal
 * which secret or which signature matched.
 */
export function verifyWebhookSignature(options: VerifyOptions): { timestampSeconds: number } {
  if (options.header === undefined || options.header === null || options.header.trim() === '') {
    throw new WebhookSignatureError('MALFORMED_HEADER', `the ${SIGNATURE_HEADER} header is missing`);
  }

  const { timestamp, signatures } = parseHeader(options.header);

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new WebhookSignatureError(
      'TIMESTAMP_OUT_OF_TOLERANCE',
      `the delivery is timestamped ${Math.abs(now - timestamp)}s away, outside the ${tolerance}s tolerance`
    );
  }

  const secrets = typeof options.secret === 'string' ? [options.secret] : options.secret;
  const value = signedPayload(timestamp, options.rawBody);

  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(hmacHex(secret, value), 'utf8');
    for (const candidate of signatures) {
      const given = Buffer.from(candidate, 'utf8');
      if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
    }
  }

  if (!matched) {
    throw new WebhookSignatureError('NO_MATCH', 'no signature in the header matches the body and secret');
  }
  return { timestampSeconds: timestamp };
}
