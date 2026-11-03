/**
 * The hosted pay page. Two things matter most and are tested hardest: that it is
 * usable with no JavaScript, and that nothing a merchant or payer supplies can
 * become markup or script.
 */
import { describe, expect, it } from 'vitest';
import { displayAmount, escapeHtml, jsonForScript, newNonce, payPageCsp, renderPayPage } from '../src/http/pay-page.ts';
import type { PublicSessionView } from '../src/sessions/types.ts';
import { MERCHANT_ADDRESS, USDC } from './support/fakes.ts';

const BASE: PublicSessionView = {
  id: 'cs_AAAAAAAAAAAAAAAAAAAAAA',
  status: 'open',
  uri: `keeta://actions/send?to=${MERCHANT_ADDRESS}&token=${USDC}&value=12500000&external=kc_REF`,
  qrSvgUrl: '/api/sessions/cs_AAAAAAAAAAAAAAAAAAAAAA/qr.svg',
  hostedUrl: 'https://pay.example/pay/cs_AAAAAAAAAAAAAAAAAAAAAA',
  amount: '12500000',
  amountDecimal: '12.5',
  tokenAddress: USDC,
  tokenTicker: '$USDC',
  tokenDecimals: 6,
  receivingAddress: MERCHANT_ADDRESS,
  network: 'test',
  orderId: 'order-1001',
  createdAt: '2026-10-30T12:00:00.000Z',
  expiresAt: '2026-10-30T12:30:00.000Z',
  successUrl: 'https://shop.example/thanks',
  cancelUrl: 'https://shop.example/cart',
  explorerUrl: null,
  paidBy: null,
  blockHash: null,
  operationIndex: null,
  paidAt: null,
  overpaidBy: null
};

const render = (session: Partial<PublicSessionView> = {}, merchantName?: string): string =>
  renderPayPage({
    session: { ...BASE, ...session },
    nonce: 'test-nonce',
    ...(merchantName === undefined ? {} : { merchantName })
  });

describe('escapeHtml', () => {
  it('neutralises every character that can change markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
    );
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes the ampersand first, so an entity is not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('order-1001')).toBe('order-1001');
  });
});

describe('jsonForScript', () => {
  it('escapes the sequences that can break out of a script block', () => {
    const encoded = jsonForScript({ note: '</script><script>alert(1)</script>' });
    expect(encoded).not.toContain('</script>');
    expect(encoded).not.toContain('<');
    expect(encoded).not.toContain('>');
    expect(encoded).toContain('\\u003c');
  });

  it('escapes an HTML comment opener', () => {
    expect(jsonForScript({ note: '<!--' })).not.toContain('<!--');
  });

  it('escapes the JavaScript line terminators that are legal inside JSON', () => {
    const encoded = jsonForScript({ note: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c` });
    expect(encoded).toContain('\\u2028');
    expect(encoded).toContain('\\u2029');
    expect(encoded).not.toContain(String.fromCharCode(0x2028));
    expect(encoded).not.toContain(String.fromCharCode(0x2029));
  });

  it('round-trips through JSON.parse unchanged', () => {
    const value = { a: '</script>', b: 'héllo', c: `x${String.fromCharCode(0x2028)}y`, d: 1, e: null };
    expect(JSON.parse(jsonForScript(value))).toEqual(value);
  });

  it('produces pure ASCII, so no encoding assumption can break it', () => {
    const encoded = jsonForScript({ a: 'héllo 😀 日本' });
    expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
    expect(JSON.parse(encoded)).toEqual({ a: 'héllo 😀 日本' });
  });
});

describe('the Content-Security-Policy', () => {
  it('allows only the page itself, with a nonce for the inline style and script', () => {
    const csp = payPageCsp('abc123');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'nonce-abc123'");
    expect(csp).toContain("style-src 'nonce-abc123'");
    expect(csp).toContain("img-src 'self'");
    // The typefaces come from this server and nowhere else.
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('issues a different nonce every time', () => {
    expect(newNonce()).not.toBe(newNonce());
    expect(newNonce().length).toBeGreaterThan(16);
  });
});

describe('what an open session renders', () => {
  const html = render();

  it('shows money with at least two decimals, and never drops a digit', () => {
    expect(displayAmount('129.5', 6)).toBe('129.50');
    expect(displayAmount('7', 6)).toBe('7.00');
    expect(displayAmount('0.000001', 6)).toBe('0.000001');
    expect(displayAmount('12.345', 6)).toBe('12.345');
    expect(displayAmount('5', 0)).toBe('5');
    expect(displayAmount('1.5', 1)).toBe('1.5');
  });

  it('states the amount, the token and the order', () => {
    expect(html).toContain('12.5');
    expect(html).toContain('$USDC');
    expect(html).toContain('order-1001');
  });

  it('works with no JavaScript: a QR image, a deep link and a cancel form', () => {
    expect(html).toContain(`src="/api/sessions/${BASE.id}/qr.svg"`);
    expect(html).toContain(`href="keeta://actions/send?to=${MERCHANT_ADDRESS}&amp;token=`);
    expect(html).toContain(`<form method="post" action="/pay/${BASE.id}/cancel">`);
  });

  it('shows everything needed to pay by hand', () => {
    expect(html).toContain(MERCHANT_ADDRESS);
    expect(html).toContain(USDC);
    expect(html).toContain('12500000');
    expect(html).toContain('kc_REF');
  });

  it('carries the nonce on both inline blocks', () => {
    expect(html).toContain('<style nonce="test-nonce">');
    expect(html).toContain('<script nonce="test-nonce">');
  });

  it('asks not to be indexed, since the URL is a payment capability', () => {
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });

  it('is responsive and declares a charset', () => {
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('width=device-width');
  });

  it('uses the merchant name when given', () => {
    expect(render({}, 'Alpine Chalet')).toContain('Alpine Chalet');
    expect(render()).toContain('Pay with Keeta');
  });
});

describe('what a closed session renders', () => {
  it('tells a paid payer they are done, and links back to the shop', () => {
    const html = render({ status: 'paid', explorerUrl: 'https://explorer.test.keeta.com/block/ABC' });
    expect(html).toContain('Paid');
    expect(html).toContain('href="https://shop.example/thanks"');
    expect(html).toContain('https://explorer.test.keeta.com/block/ABC');
    // No point showing a QR for something already settled.
    expect(html).not.toContain('qr.svg');
    expect(html).not.toContain('/cancel');
  });

  it('sends an expired or cancelled payer back to the cart', () => {
    for (const status of ['expired', 'cancelled'] as const) {
      const html = render({ status });
      expect(html).toContain('href="https://shop.example/cart"');
      expect(html).not.toContain('qr.svg');
    }
  });

  it('explains an unmatched session without blaming the payer', () => {
    const html = render({ status: 'unmatched' });
    expect(html).toContain('needs attention');
    expect(html).toContain('The shop has been notified');
  });
});

describe('untrusted input cannot become markup', () => {
  it('escapes a malicious order id', () => {
    const html = render({ orderId: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a malicious token ticker', () => {
    const html = render({ tokenTicker: '</title><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</title><');
  });

  it('escapes the return URLs, which are merchant-supplied', () => {
    const html = render({
      status: 'paid',
      successUrl: 'https://shop.example/thanks?a=1&b="><script>alert(1)</script>'
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&amp;b=&quot;&gt;');
  });

  it('escapes a payment URI that somehow carries a quote', () => {
    const html = render({ uri: 'keeta://actions/send?external="><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('cannot be broken out of the bootstrap script block', () => {
    const html = render({ successUrl: 'https://shop.example/</script><script>alert(1)</script>' });
    // Exactly two script-ish openings: the style block is not one, and the one
    // inline script is ours.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain('</script><script>alert(1)');
  });

  it('escapes the nonce itself, defensively', () => {
    const html = renderPayPage({ session: BASE, nonce: '"><script>alert(1)</script>' });
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('what the page does not contain', () => {
  it('never shows another session, and never names a secret', () => {
    const html = render();
    expect(html).not.toContain('apiKey');
    expect(html).not.toContain('Bearer');
    expect(html).not.toContain('whsec_');
    expect(html).not.toContain('KEETA_MERCHANT_SEED');
  });

  it('loads nothing from another origin', () => {
    const html = render();
    // No absolute URL in a src or a stylesheet link.
    expect(html).not.toMatch(/src="https?:\/\//);
    expect(html).not.toContain('<link');
    expect(html).not.toContain('cdn.');
  });
});
