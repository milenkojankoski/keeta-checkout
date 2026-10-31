import { describe, expect, it } from 'vitest';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import {
  PaymentRequestError,
  buildPaymentUri,
  parsePaymentUri,
  qrPath,
  qrSvgUrlFor,
  renderQrSvg
} from '../src/payment-request.ts';
import { parseDecimalAmount } from '../src/amounts.ts';
import type { Session } from '../src/sessions/types.ts';
import { KTA, MERCHANT_ADDRESS, PAYER_ADDRESS, USDC, testConfig } from './support/fakes.ts';

const BASE_TIME = Date.UTC(2026, 9, 30, 12, 0, 0);

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'cs_AAAAAAAAAAAAAAAAAAAAAA',
    reference: 'kc_BBBBBBBBBBBBBBBBBBBBBB',
    orderId: 'order-1001',
    amount: 12_500_000n,
    tokenAddress: USDC,
    tokenTicker: '$USDC',
    tokenDecimals: 6,
    receivingAddress: MERCHANT_ADDRESS,
    network: 'test',
    status: 'open',
    createdAt: BASE_TIME,
    expiresAt: BASE_TIME + 1_800_000,
    graceUntil: BASE_TIME + 2_400_000,
    successUrl: 'https://shop.example/thanks',
    cancelUrl: 'https://shop.example/cart',
    paidBy: null,
    blockHash: null,
    operationIndex: null,
    paidAt: null,
    overpaidBy: null,
    updatedAt: BASE_TIME,
    ...overrides
  };
}

describe('buildPaymentUri', () => {
  it('encodes recipient, token, base-unit amount and the reference', () => {
    const session = makeSession();
    const uri = buildPaymentUri(session);

    expect(uri.startsWith('keeta://')).toBe(true);

    const url = new URL(uri);
    expect(url.pathname).toBe('/send');
    expect(url.searchParams.get('to')).toBe(MERCHANT_ADDRESS);
    expect(url.searchParams.get('token')).toBe(USDC);
    expect(url.searchParams.get('value')).toBe('12500000');
    expect(url.searchParams.getAll('external')).toEqual([session.reference]);
  });

  it('carries exactly one external item, so the watcher has one thing to match', () => {
    const uri = buildPaymentUri(makeSession());
    expect(new URL(uri).searchParams.getAll('external')).toHaveLength(1);
  });

  it('sends the payer to the configured receiving account, not the payer address', () => {
    const uri = buildPaymentUri(makeSession());
    expect(uri).toContain(MERCHANT_ADDRESS);
    expect(uri).not.toContain(PAYER_ADDRESS);
  });

  it('does not leak the merchant order id', () => {
    const uri = buildPaymentUri(makeSession({ orderId: 'order-SECRET-1001' }));
    expect(uri).not.toContain('SECRET');
  });

  it('rejects a reference that would be invalid on-chain', () => {
    // A reference outside the network's `external` charset would be rejected at
    // publish time, long after the payer scanned the code.
    const error = (() => {
      try {
        buildPaymentUri(makeSession({ reference: 'kc_bad!reference' }));
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(PaymentRequestError);
    expect((error as PaymentRequestError).code).toBe('URI_BUILD_FAILED');
  });

  it('rejects a token address that is not a token', () => {
    expect(() => buildPaymentUri(makeSession({ tokenAddress: MERCHANT_ADDRESS }))).toThrow(PaymentRequestError);
  });

  it('rejects a malformed receiving address', () => {
    expect(() => buildPaymentUri(makeSession({ receivingAddress: 'keeta_nonsense' }))).toThrow(PaymentRequestError);
  });
});

describe('round trip through parseKeetaURI', () => {
  it('returns the same recipient, token and amount', () => {
    const session = makeSession();
    const parsed = parsePaymentUri(buildPaymentUri(session));

    expect(parsed.type).toBe('send');
    expect(parsed.to?.publicKeyString.get()).toBe(session.receivingAddress);
    expect(parsed.token?.publicKeyString.get()).toBe(session.tokenAddress);
    expect(parsed.value).toBe(session.amount);
    expect(parsed.external).toEqual([session.reference]);
  });

  it('preserves amounts exactly, including ones no float could hold', () => {
    const amounts = [
      1n,
      12_500_000n,
      10n ** 18n,
      BigInt(Number.MAX_SAFE_INTEGER),
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      123_456_789_123_456_789_123_456_789n,
      2n ** 128n - 1n
    ];

    for (const amount of amounts) {
      const parsed = parsePaymentUri(buildPaymentUri(makeSession({ amount })));
      expect(parsed.value, `${amount}`).toBe(amount);
    }
  });

  it('carries the amount the merchant priced, end to end', () => {
    // The whole chain: merchant's decimal string, to base units, into the URI, and
    // back out as what the wallet will be asked to send.
    for (const [decimal, decimals] of [
      ['12.50', 6],
      ['0.000001', 6],
      ['1', 18],
      ['0.000000000000000001', 18],
      ['999999.999999', 6]
    ] as const) {
      const amount = parseDecimalAmount(decimal, decimals);
      const session = makeSession({
        amount,
        tokenDecimals: decimals,
        tokenAddress: decimals === 18 ? KTA : USDC
      });
      expect(parsePaymentUri(buildPaymentUri(session)).value, decimal).toBe(amount);
    }
  });

  it('survives a URI that went through a QR-sized string and back', () => {
    const session = makeSession();
    const uri = buildPaymentUri(session);
    // Case must be preserved: base32 addresses are lower case, the reference is not.
    expect(parsePaymentUri(uri.normalize()).value).toBe(session.amount);
    expect(() => parsePaymentUri(uri.toUpperCase())).toThrow();
  });

  it('rejects a tampered amount that is not a whole number', () => {
    const uri = buildPaymentUri(makeSession()).replace('value=12500000', 'value=12.5');
    expect(() => parsePaymentUri(uri)).toThrow();
  });

  it('parses a URI built by the SDK directly, not just by us', () => {
    const { Account } = KeetaNet.lib;
    const native = `keeta://actions/send?to=${MERCHANT_ADDRESS}&token=${USDC}&value=5&external=kc_x`;
    const parsed = parsePaymentUri(native);
    expect(parsed.value).toBe(5n);
    expect(parsed.to?.publicKeyString.get()).toBe(Account.fromPublicKeyString(MERCHANT_ADDRESS).publicKeyString.get());
  });
});

describe('renderQrSvg', () => {
  it('produces a scalable SVG of the URI', async () => {
    const svg = await renderQrSvg(buildPaymentUri(makeSession()));

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox');
    expect(svg).toContain('</svg>');
    expect(svg.length).toBeGreaterThan(500);
  });

  it('honours an explicit width', async () => {
    const svg = await renderQrSvg(buildPaymentUri(makeSession()), { width: 256 });
    expect(svg).toContain('width="256"');
  });

  it('grows the code when error correction is raised', async () => {
    const uri = buildPaymentUri(makeSession());
    const low = await renderQrSvg(uri, { errorCorrectionLevel: 'L' });
    const high = await renderQrSvg(uri, { errorCorrectionLevel: 'H' });
    expect(high.length).toBeGreaterThan(low.length);
  });

  it('refuses something too long to encode', async () => {
    // Beyond QR's capacity even at the lowest correction level.
    await expect(renderQrSvg('k'.repeat(10_000))).rejects.toBeInstanceOf(PaymentRequestError);
  });
});

describe('qr links', () => {
  it('builds a relative path from the session id', () => {
    expect(qrPath('cs_abc')).toBe('/api/sessions/cs_abc/qr.svg');
  });

  it('escapes an id that would otherwise alter the path', () => {
    expect(qrPath('cs_a/../b')).toBe('/api/sessions/cs_a%2F..%2Fb/qr.svg');
  });

  it('is absolute when the server knows its public URL', () => {
    const session = makeSession();
    expect(qrSvgUrlFor(session, testConfig({ publicUrl: 'https://pay.example' }))).toBe(
      `https://pay.example/api/sessions/${session.id}/qr.svg`
    );
  });

  it('falls back to a same-origin path with no public URL', () => {
    const session = makeSession();
    const config = testConfig();
    const withoutPublicUrl = { ...config, publicUrl: undefined };
    expect(qrSvgUrlFor(session, withoutPublicUrl)).toBe(`/api/sessions/${session.id}/qr.svg`);
  });
});
