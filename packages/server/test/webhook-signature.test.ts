import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_HEADER,
  WebhookSignatureError,
  signWebhook,
  signedPayload,
  verifyWebhookSignature
} from '../src/webhooks/signature.ts';

const SECRET = 'whsec_test_000000000000';
const BODY = '{"id":"evt_1","type":"checkout.session.paid"}';
const T = 1_762_000_000;

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof WebhookSignatureError) return error.reason;
    throw error;
  }
  return undefined;
}

describe('signWebhook', () => {
  it('produces a Stripe-shaped header', () => {
    const header = signWebhook({ rawBody: BODY, secret: SECRET, timestampSeconds: T });
    expect(header).toMatch(/^t=1762000000,v1=[0-9a-f]{64}$/);
  });

  it('signs the timestamp and the body together, as "t.body"', () => {
    const header = signWebhook({ rawBody: BODY, secret: SECRET, timestampSeconds: T });
    const expected = createHmac('sha256', SECRET).update(`${T}.${BODY}`, 'utf8').digest('hex');
    expect(header).toContain(expected);
    expect(signedPayload(T, BODY)).toBe(`${T}.${BODY}`);
  });

  it('changes when the timestamp changes, so a captured body cannot be restamped', () => {
    const a = signWebhook({ rawBody: BODY, secret: SECRET, timestampSeconds: T });
    const b = signWebhook({ rawBody: BODY, secret: SECRET, timestampSeconds: T + 1 });
    expect(a.split('v1=')[1]).not.toBe(b.split('v1=')[1]);
  });

  it('changes when the body or the secret changes', () => {
    const base = signWebhook({ rawBody: BODY, secret: SECRET, timestampSeconds: T });
    expect(signWebhook({ rawBody: `${BODY} `, secret: SECRET, timestampSeconds: T })).not.toBe(base);
    expect(signWebhook({ rawBody: BODY, secret: `${SECRET}x`, timestampSeconds: T })).not.toBe(base);
  });
});

describe('verifyWebhookSignature', () => {
  const header = signWebhook({ rawBody: BODY, secret: SECRET, timestampSeconds: T });

  it('accepts a delivery it just signed', () => {
    const result = verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: T });
    expect(result.timestampSeconds).toBe(T);
  });

  it('accepts within the tolerance and rejects outside it, in both directions', () => {
    const edge = DEFAULT_TOLERANCE_SECONDS;
    expect(verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: T + edge }).timestampSeconds).toBe(T);
    expect(verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: T - edge }).timestampSeconds).toBe(T);

    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: T + edge + 1 }))).toBe(
      'TIMESTAMP_OUT_OF_TOLERANCE'
    );
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: T - edge - 1 }))).toBe(
      'TIMESTAMP_OUT_OF_TOLERANCE'
    );
  });

  it('honours a custom tolerance', () => {
    expect(
      verifyWebhookSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: T + 3600, toleranceSeconds: 7200 })
        .timestampSeconds
    ).toBe(T);
  });

  it('rejects a tampered body', () => {
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: `${BODY}x`, header, secret: SECRET, nowSeconds: T }))).toBe('NO_MATCH');
    // Even a re-serialisation with different spacing fails, which is why handlers
    // must verify the raw body and not a parsed-then-restringified object.
    const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: reserialised, header, secret: SECRET, nowSeconds: T }))).toBe('NO_MATCH');
  });

  it('rejects the wrong secret', () => {
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header, secret: 'whsec_other_00000000', nowSeconds: T }))).toBe(
      'NO_MATCH'
    );
  });

  it('accepts any of several secrets, for a rotation', () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      header,
      secret: ['whsec_new_000000000000', SECRET],
      nowSeconds: T
    });
    expect(result.timestampSeconds).toBe(T);
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header, secret: ['a_wrong_secret_0000', 'b_wrong_secret_0000'], nowSeconds: T }))).toBe('NO_MATCH');
  });

  it('accepts a header carrying several signatures if one matches', () => {
    const multi = `t=${T},v1=${'0'.repeat(64)},v1=${header.split('v1=')[1] as string}`;
    expect(verifyWebhookSignature({ rawBody: BODY, header: multi, secret: SECRET, nowSeconds: T }).timestampSeconds).toBe(T);
  });

  it('ignores unknown scheme keys, so a future v2 does not break a v1 handler', () => {
    const withFuture = `${header},v2=deadbeef,foo=bar`;
    expect(verifyWebhookSignature({ rawBody: BODY, header: withFuture, secret: SECRET, nowSeconds: T }).timestampSeconds).toBe(T);
  });

  it('rejects a missing, empty or malformed header', () => {
    for (const bad of [undefined, null, '', '   ']) {
      expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header: bad, secret: SECRET, nowSeconds: T }))).toBe(
        'MALFORMED_HEADER'
      );
    }
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header: 'garbage', secret: SECRET, nowSeconds: T }))).toBe(
      'MALFORMED_HEADER'
    );
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header: 't=notanumber,v1=abc', secret: SECRET, nowSeconds: T }))).toBe(
      'MALFORMED_HEADER'
    );
    // A timestamp with no signature.
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header: `t=${T}`, secret: SECRET, nowSeconds: T }))).toBe(
      'NO_SIGNATURES'
    );
    // A signature with no timestamp.
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header: 'v1=abc', secret: SECRET, nowSeconds: T }))).toBe(
      'MALFORMED_HEADER'
    );
  });

  it('tolerates whitespace around the parts', () => {
    const spaced = ` t = ${T} , v1 = ${header.split('v1=')[1] as string} `.replace(' = ', '=').replace(' = ', '=');
    expect(verifyWebhookSignature({ rawBody: BODY, header: spaced, secret: SECRET, nowSeconds: T }).timestampSeconds).toBe(T);
  });

  it('rejects a signature of the right length but wrong value', () => {
    expect(reasonOf(() => verifyWebhookSignature({ rawBody: BODY, header: `t=${T},v1=${'a'.repeat(64)}`, secret: SECRET, nowSeconds: T }))).toBe(
      'NO_MATCH'
    );
  });

  it('names the header in its errors, so a merchant can find the problem', () => {
    try {
      verifyWebhookSignature({ rawBody: BODY, header: undefined, secret: SECRET, nowSeconds: T });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(SIGNATURE_HEADER);
    }
  });
});
