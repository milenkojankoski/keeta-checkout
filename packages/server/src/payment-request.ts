/**
 * Turning a session into something a payer's wallet can act on.
 *
 * A Keeta payment request is a `keeta://` URI carrying the recipient, the token,
 * the amount in base units and the session's reference. The wallet reads it, shows
 * the payer exactly what will move, and publishes the send when they approve.
 *
 * Nothing here converts an amount. The session already holds a `bigint` in the
 * token's base units, and `encodeKeetaURI` writes it with `String(value)` while
 * `parseKeetaURI` reads it back with `BigInt(...)`. That round trip is lossless and
 * has no notion of decimal places, so the digits the merchant priced in are the
 * digits the wallet is asked to send.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import QRCode from 'qrcode';
import type { CheckoutConfig } from './config.ts';
import { isValidExternal } from './sessions/refs.ts';
import type { Session } from './sessions/types.ts';

const { Account } = KeetaNet.lib;
const { encodeKeetaURI, parseKeetaURI } = KeetaAnchor.lib.URI;

export type PaymentRequestErrorCode = 'URI_BUILD_FAILED' | 'QR_RENDER_FAILED';

export class PaymentRequestError extends Error {
  override readonly name = 'PaymentRequestError';

  constructor(
    readonly code: PaymentRequestErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * The `keeta://` URI for a session.
 *
 * The `external` array holds **exactly one** item, the session reference. Keeta's
 * convention is that the first entry becomes the `external` field of the `SEND`
 * operation, and the encoder appends each entry as its own query parameter; adding
 * anything else would make it ambiguous which one the watcher should match on.
 */
export function buildPaymentUri(session: Session): string {
  if (!isValidExternal(session.reference)) {
    throw new PaymentRequestError(
      'URI_BUILD_FAILED',
      `session ${session.id} has a reference that is not valid for a Keeta external field`
    );
  }

  try {
    const to = Account.fromPublicKeyString(session.receivingAddress);
    const token = Account.fromPublicKeyString(session.tokenAddress).assertKeyType(
      Account.AccountKeyAlgorithm.TOKEN
    );
    return encodeKeetaURI({
      type: 'send',
      to,
      token,
      value: session.amount,
      external: [session.reference]
    });
  } catch (error) {
    if (error instanceof PaymentRequestError) throw error;
    throw new PaymentRequestError(
      'URI_BUILD_FAILED',
      `could not build a payment URI for session ${session.id}: ${String(error)}`
    );
  }
}

/**
 * Read a payment URI back. Exported so a merchant, a test, or a wallet-side tool can
 * confirm what a URI actually asks for rather than trusting how it was built.
 */
export function parsePaymentUri(uri: string): ReturnType<typeof parseKeetaURI> {
  return parseKeetaURI(uri);
}

export interface QrOptions {
  /**
   * Error-correction level. `M` recovers about 15% damage and keeps the code small
   * enough to scan comfortably on a phone screen; a payment URI is around 200
   * characters, which fits well inside the version this produces.
   */
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  /** Quiet-zone width in modules. The spec asks for 4; 1 suits an already-padded card. */
  margin?: number;
  /** Rendered width in pixels. Omit for a viewBox-only SVG that scales to its container. */
  width?: number;
}

/**
 * Render a payment URI as an SVG QR code.
 *
 * Byte mode, not alphanumeric: a Keeta URI mixes cases, because base32 addresses are
 * lower case and the base64url reference is not, and alphanumeric mode would
 * upper-case everything and break both.
 *
 * The result is around 6 KB, which is why it is served from its own route rather
 * than embedded in every session payload and repeated on every status event.
 */
export async function renderQrSvg(uri: string, options: QrOptions = {}): Promise<string> {
  try {
    return await QRCode.toString(uri, {
      type: 'svg',
      errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
      margin: options.margin ?? 1,
      ...(options.width === undefined ? {} : { width: options.width })
    });
  } catch (error) {
    throw new PaymentRequestError('QR_RENDER_FAILED', `could not render a QR code: ${String(error)}`);
  }
}

/** Path of the QR route for a session, relative to the server root. */
export function qrPath(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/qr.svg`;
}

/**
 * Where a payer's browser can fetch this session's QR code.
 *
 * Absolute when the server knows its own public URL, because a pay button is
 * usually served from the merchant's domain rather than the checkout server's.
 * Relative otherwise, which still works same-origin.
 */
export function qrSvgUrlFor(session: Session, config: CheckoutConfig): string {
  const path = qrPath(session.id);
  return config.publicUrl === undefined ? path : `${config.publicUrl}${path}`;
}
