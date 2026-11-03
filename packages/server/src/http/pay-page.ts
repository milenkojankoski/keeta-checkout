/**
 * The hosted pay page: what a shopper sees when they click "Pay with Keeta".
 *
 * Two rules shape every decision here.
 *
 * **It works with no JavaScript.** The QR is an `<img>` pointing at the QR route,
 * the deep link is an `<a href>`, the address and amount are selectable text, and
 * cancelling is a form POST. A shopper with a locked-down browser can still pay.
 * JavaScript then upgrades the page: a live countdown, and the status flipping to
 * paid over the event stream without a refresh.
 *
 * **Everything interpolated is escaped.** `orderId` is a string the merchant chose
 * and the server stores verbatim, so it reaches this page as untrusted text. So do
 * the token ticker and the return URLs. One missed escape here is a cross-site
 * scripting hole on a payment page, which is the worst place to have one.
 *
 * The look follows keeta.com, so a shopper paying a shop with Keeta sees Keeta:
 * an off-white ground framed by hairlines, Geist and Geist Mono, a light large
 * amount, small uppercase mono labels, a near-black button, and the coral to
 * periwinkle gradient on the ring that confirms a payment. The typefaces are served by this server
 * (`/assets/fonts/…`), because the policy below admits nothing from elsewhere.
 */
import { randomBytes } from 'node:crypto';
import type { PublicSessionView } from '../sessions/types.ts';

/** Escape for an HTML text node or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serialise a value for embedding inside a `<script>` block.
 *
 * `JSON.stringify` alone is not safe here. A string containing `</script>` would
 * end the block early, `<!--` can start an HTML comment that swallows the rest,
 * and U+2028 and U+2029 are legal inside a JSON string but are line terminators
 * in JavaScript source.
 *
 * Rather than enumerate those cases, every character outside printable ASCII is
 * emitted as a \uXXXX escape, along with the three that can break out of the
 * block. The JSON stays valid and renders identically; the script cannot be
 * escaped from.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]|[<>&]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}

export interface PayPageOptions {
  /** The payer-safe view. Never pass the merchant view: it carries no secret the payer needs. */
  session: PublicSessionView;
  /** Shown in the page's header. Defaults to a neutral label. */
  merchantName?: string | undefined;
  /** Per-request nonce, so the inline script can run under a strict CSP. */
  nonce: string;
}

/** A fresh CSP nonce. One per response, never reused. */
export function newNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * The Content-Security-Policy for this page.
 *
 * Everything is inline or same-origin: no CDN, no font service, no analytics. The
 * nonce is what lets the one inline style and script run while anything injected
 * cannot; fonts come only from this server.
 */
export function payPageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

const STATUS_COPY: Record<string, { title: string; detail: string }> = {
  open: { title: 'Waiting for payment', detail: 'Approve the payment in your Keeta wallet. This page updates by itself.' },
  paid: { title: 'Paid', detail: 'Thank you. Your payment has settled on the Keeta network.' },
  expired: { title: 'This payment request expired', detail: 'Go back to the shop and start again.' },
  cancelled: { title: 'Payment cancelled', detail: 'Nothing was charged.' },
  unmatched: {
    title: 'This payment needs attention',
    detail: 'Money arrived that could not be matched to this order. The shop has been notified.'
  }
};

/** Keeta's mark. Its fills follow `currentColor`; the gradient ids are this page's own. */
const KEETA_MARK = `<svg class="mark" viewBox="0 0 50 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill-rule="evenodd" clip-rule="evenodd" d="M41.1644 3.72272c.0065-.03834.0139-.07668.0218-.11409.0555-.26146.1447-.50998.2627-.74187.1535-.30072.3556-.57234.5961-.80469.0518-.05035.1341-.05035.1859 0 .2404.23282.4425.5049.5956.80561.1179.23143.2072.47995.2622.74095.0079.03787.0153.07575.0218.11363.0148.08685.0263.17507.0333.26469.0009.01155.0018.02356.0027.03511.019-.00139.0384-.00277.0569-.00416 1.3841-.08869 2.2475.449 2.7609.99685l2.1064 2.70647c.0995.12703.0726.31135-.0587.40512l-2.0662 1.4805c-.0861.06189-.1994.07021-.2951.02494-1.5127-.71507-3.6242-.98946-6.8364.26885-4.1802 1.63757-8.6049 3.66447-8.6049 3.66447s-5.746 2.7601-11.1799 3.9611l.4038 1.8233c2.8565-.6315 5.7561-1.6621 7.9144-2.5189 1.0854-.431 1.9973-.8237 2.6397-1.1096.3214-.1432.5762-.2596.7519-.3414.0879-.0406.1563-.073.2035-.0951.0097-.0047.019-.0088.0268-.0125.0111-.0051.0204-.0097.0278-.0134l.0028-.0014h.0014s0-.0009.0004-.0009c.0079-.0037.0194-.0088.0347-.0157.0324-.0148.0809-.037.1443-.0656.1272-.0578.314-.1423.5517-.249.4754-.2134 1.1529-.5155 1.9603-.868 1.6177-.7067 3.7445-1.6121 5.8034-2.4187 2.8205-1.1044 4.3868-.7769 5.3543-.3196.6849.3238 1.5242.2776 2.1846-.1954l2.0663-1.48051c.9928-.71138 1.1949-2.10503.4448-3.06863l-2.1592-2.77391-.0582-.06236c-.6174-.65918-1.5187-1.26293-2.7308-1.4962-.2576-.57557-.6225-1.09109-1.066-1.52115-.7769-.7529515-2.0112-.7534135-2.7886-.001385-.6086.588965-1.0678 1.336835-1.3069 2.178475-1.1631.40789-2.1111.51691-2.925.47533-1.0354-.05312-1.9862-.35661-3.0508-.81623-.3667-.15845-.7571-.34368-1.1728-.54139C30.4202 1.12943 28.0428 0 25.0188 0c-3.8046 0-6.4656 1.22181-8.7048 2.24962-.1004.04619-.2002.09192-.2992.13719-2.2776 1.04212-4.1265 1.80847-6.83924 1.49436-1.42852-.16538-2.23273-.39265-3.2395-.87629-.83796-.40235-1.77721-.9599-3.23579-1.82649C2.18695.873517 1.60888.5303.948031.142276L0 1.75211c.617377.36308 1.17093.69152 1.67316.98993C5.16561 4.81658 6.17007 5.4134 8.96005 5.73629c3.37865.39126 5.67845-.66333 8.09115-1.7692 2.2405-1.02734 4.5783-2.09949 7.9676-2.09949 2.5601 0 4.4802.90493 6.3342 1.7789 2.7673 1.30451 5.3871 2.53925 9.768.59082 0-.17554.0148-.34738.0434-.51413v-.00047Z" fill="url(#kp-mark-a)"/><path fill-rule="evenodd" clip-rule="evenodd" d="M24.6215 7.30052c-.2146-.56078-.6632-1.18809-1.5016-1.81632l1.1219-1.49389c1.0623.79591 1.7619 1.69114 2.1264 2.64318.3658.9562.3709 1.91102.1355 2.77853-.4416 1.62428-1.7223 2.94248-3.0899 3.55338-.0376.0168-.0478.0656-.0184.0946.4314.4251 1.2722.9793 2.4294 1.6042 2.4695 1.3331 5.881 2.7319 8.0291 3.6063L33.1487 20c-2.1282-.8661-5.6378-2.3027-8.2128-3.6927-1.256-.6781-2.4218-1.4121-3.054-2.1286-.2978-.3377-.6738-.8897-.5619-1.5604.1212-.7252.7182-1.1105 1.2218-1.3114.9425-.3765 1.8656-1.30961 2.1574-2.3836.1406-.51737.1355-1.06522-.0773-1.62231l-.0004-.00047Z" fill="url(#kp-mark-b)"/><defs><radialGradient id="kp-mark-a" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(-18.11083 18.02505 -46.52506 -46.74645 32.6041 0)"><stop offset=".5625" stop-color="currentColor"/><stop offset=".990797" stop-color="currentColor" stop-opacity="0"/></radialGradient><linearGradient id="kp-mark-b" x1="21.8392" y1="10.7338" x2="20.0498" y2="6.47924" gradientUnits="userSpaceOnUse"><stop stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs></svg>`;

/** Keeta's brand gradient, for the ring shown once a payment has settled. */
const BRAND_STOPS = `<stop offset="0" stop-color="#ff886d"/><stop offset=".3" stop-color="#7091df"/><stop offset=".55" stop-color="#e3e9fa"/><stop offset=".72" stop-color="#ff886d"/><stop offset="1" stop-color="#ff886d"/>`;


const RING = `<svg class="ring" viewBox="0 0 200 200" aria-hidden="true" focusable="false"><defs><linearGradient id="kp-ring" x1="0" y1="0" x2="1" y2="1">${BRAND_STOPS}</linearGradient></defs><circle class="ring-track" cx="100" cy="100" r="88" fill="none"/><circle class="ring-brand" cx="100" cy="100" r="88" fill="none" stroke="url(#kp-ring)" transform="rotate(-90 100 100)"/></svg>`;

const GLYPHS = `<svg class="glyph glyph-paid" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 12.5l4 4 8.5-9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><svg class="glyph glyph-expired" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><svg class="glyph glyph-cancelled" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><svg class="glyph glyph-unmatched" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 6.5v7.5M12 17.5v.01" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

const ARROW = `<svg class="arrow" viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3.5 8.5l5-5M4.5 3.5h4v4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const MARKER_RING = `<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`;
const MARKER_DOT = `<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><circle cx="5" cy="5" r="3.6" fill="currentColor"/></svg>`;
const MARKER_TRIANGLE = `<svg viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="M5 1.5l4 7H1z" fill="currentColor"/></svg>`;

const STYLES = `
  @font-face {
    font-family: 'Geist'; src: url('/assets/fonts/geist-v5.woff2') format('woff2');
    font-weight: 300 600; font-style: normal; font-display: swap;
  }
  @font-face {
    font-family: 'Geist Mono'; src: url('/assets/fonts/geist-mono-v6.woff2') format('woff2');
    font-weight: 400 500; font-style: normal; font-display: swap;
  }
  :root {
    color-scheme: light;
    --ground: #f8f8f8; --paper: #ffffff; --ink: #2c2a2a; --ink-2: #565555;
    --muted: #807f7f; --faint: #abaaaa; --line: #dddddd; --line-soft: #ececec;
    --coral: #ff886d; --blue: #7091df; --ok: #2b8a57;
    --btn: linear-gradient(#3a3738, #2c292b); --btn-ink: #ffffff;
    --card-shadow: 0 1px 1px rgba(44, 42, 42, .04), 0 24px 48px -20px rgba(44, 42, 42, .22);
    --sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
    --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --ground: #0d0c0c; --paper: #151414; --ink: #f2f0f0; --ink-2: #c8c5c5;
      --muted: #8f8d8d; --faint: #5f5d5d; --line: #2c2a2a; --line-soft: #211f1f;
      --btn: linear-gradient(#ffffff, #ecebeb); --btn-ink: #2c2a2a;
      --card-shadow: 0 24px 60px -24px rgba(0, 0, 0, .8);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; min-height: 100vh; background: var(--ground); color: var(--ink);
    font: 400 15px/1.55 var(--sans); letter-spacing: -0.005em;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  a { color: inherit; }
  .frame {
    max-width: 1040px; min-height: 100vh; margin: 0 auto;
    border-left: 1px solid var(--line); border-right: 1px solid var(--line);
    background: linear-gradient(180deg, var(--paper) 0, var(--ground) 560px);
    display: flex; flex-direction: column;
  }

  /* Header: the mark, the shop, the network. */
  .bar {
    display: flex; align-items: center; gap: 16px; height: 64px; padding: 0 32px;
    border-bottom: 1px solid var(--line);
  }
  .bar .mark { display: block; width: 46px; height: auto; color: var(--ink); flex: none; }
  .bar .rule { width: 1px; height: 22px; background: var(--line); flex: none; }
  .merchant { margin: 0; font-size: 15px; font-weight: 500; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .tag {
    margin-left: auto; display: inline-flex; align-items: center; gap: 8px; flex: none;
    font: 500 11px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
    padding: 7px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--paper);
  }
  .tag::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--coral); }

  /* Two columns on a wide screen, one on a phone. */
  .grid {
    flex: 1; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 440px);
    grid-template-areas: "summary scan" "more scan"; grid-template-rows: auto 1fr;
  }
  .summary { grid-area: summary; padding: 64px 40px 36px; }
  .more { grid-area: more; padding: 28px 40px 40px; border-top: 1px solid var(--line); }
  .scan {
    grid-area: scan; position: relative; overflow: hidden; border-left: 1px solid var(--line);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 56px 32px 48px; min-height: 520px;
  }

  .eyebrow {
    margin: 0 0 22px; display: flex; flex-wrap: wrap; gap: 6px 10px;
    font: 500 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
  }
  .eyebrow .sep { color: var(--faint); }
  .eyebrow .order { color: var(--ink-2); overflow-wrap: anywhere; }
  .amount {
    margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px;
    font-weight: 300; font-size: clamp(52px, 7.4vw, 84px); line-height: 1; letter-spacing: -0.045em;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }
  .unit { font: 500 15px/1 var(--mono); letter-spacing: .06em; color: var(--muted); }

  .status { display: flex; gap: 14px; align-items: flex-start; margin: 40px 0 0; }
  .status .pulse { position: relative; width: 10px; height: 10px; margin-top: 7px; flex: none; border-radius: 50%; background: var(--coral); }
  .status .pulse::after {
    content: ""; position: absolute; inset: -5px; border-radius: 50%; border: 1px solid var(--coral);
    opacity: 0; animation: ripple 2.2s ease-out infinite;
  }
  .status[data-state="paid"] .pulse { background: var(--ok); }
  .status[data-state="expired"] .pulse, .status[data-state="cancelled"] .pulse { background: var(--faint); }
  .status:not([data-state="open"]) .pulse::after { display: none; }
  .status-title { margin: 0; font-size: 17px; font-weight: 500; letter-spacing: -0.015em; }
  .status-detail { margin: 3px 0 0; color: var(--ink-2); font-size: 14px; max-width: 420px; }

  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 22px; margin: 36px 0 0; }
  .button {
    display: inline-flex; align-items: center; justify-content: center; gap: 10px;
    min-height: 48px; padding: 0 22px; border-radius: 10px;
    background: var(--btn); color: var(--btn-ink); text-decoration: none;
    font-size: 15px; font-weight: 500; letter-spacing: -0.01em;
    box-shadow: 0 1px 0 rgba(255, 255, 255, .08) inset, 0 8px 20px -10px rgba(44, 42, 42, .55);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .button:hover { transform: translateY(-1px); box-shadow: 0 1px 0 rgba(255, 255, 255, .08) inset, 0 14px 28px -12px rgba(44, 42, 42, .6); }
  .button:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
  .button .arrow { width: 12px; height: 12px; }
  .countdown {
    margin: 0; font: 500 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase;
    color: var(--muted); font-variant-numeric: tabular-nums;
  }
  .countdown:empty { display: none; }
  .hint { margin: 18px 0 0; color: var(--muted); font-size: 13px; max-width: 440px; }
  .leave { margin-top: 36px; }

  /* Paying by hand. */
  details summary {
    list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between;
    font: 500 12px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2);
  }
  details summary::-webkit-details-marker { display: none; }
  details summary::after { content: "+"; font: 300 20px/1 var(--sans); color: var(--muted); transition: transform .2s ease; }
  details[open] summary::after { transform: rotate(45deg); }
  dl { margin: 18px 0 0; }
  .row { padding: 12px 0; border-top: 1px solid var(--line-soft); }
  dt { font: 500 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  dd { margin: 4px 0 0; font: 400 12.5px/1.5 var(--mono); color: var(--ink); word-break: break-all; user-select: all; }
  .must { margin: 4px 0 0; color: var(--muted); font-size: 12.5px; }
  .more form { margin: 24px 0 0; }
  .more form button {
    padding: 0; border: 0; background: none; cursor: pointer; color: var(--muted);
    font: inherit; font-size: 13px; text-decoration: underline; text-decoration-color: var(--line);
    text-underline-offset: 3px;
  }
  .more form button:hover { color: var(--ink); text-decoration-color: currentColor; }

  /* The code, framed by the arc. */
  .qr-card {
    position: relative; z-index: 1; padding: 18px; border-radius: 20px; background: #ffffff;
    border: 1px solid var(--line-soft); box-shadow: var(--card-shadow);
  }
  .qr { display: block; width: 232px; height: 232px; }
  .caption {
    position: relative; z-index: 1; margin: 22px 0 0;
    font: 500 11px/1.4 var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--muted);
  }

  /* After the request: a ring, and what happened. */
  .result { position: relative; width: 200px; height: 200px; display: grid; place-items: center; }
  .ring { position: absolute; inset: 0; width: 100%; height: 100%; }
  .ring-track { stroke: var(--line); stroke-width: 2; }
  .ring-brand { stroke-width: 6; stroke-linecap: round; stroke-dasharray: 553; stroke-dashoffset: 0; display: none; }
  body[data-state="paid"] .ring-brand { display: inline; animation: ring-in 1.2s cubic-bezier(.2, .7, .2, 1) backwards; }
  .glyph { display: none; width: 56px; height: 56px; color: var(--faint); }
  body[data-state="paid"] .glyph-paid { display: block; color: var(--ink); }
  body[data-state="expired"] .glyph-expired,
  body[data-state="cancelled"] .glyph-cancelled { display: block; }
  body[data-state="unmatched"] .glyph-unmatched { display: block; color: var(--coral); }

  /* What shows when, so a page that changes state live still makes sense. */
  body[data-state="open"] .scan-done, body:not([data-state="open"]) .scan-live,
  body:not([data-state="open"]) .live-only { display: none; }
  body[data-state="open"] .leave, body[data-state="paid"] .leave-cart { display: none; }
  body:not([data-state="paid"]) .leave-paid { display: none; }

  .foot {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px;
    padding: 18px 32px; border-top: 1px solid var(--line);
    font: 500 11px/1.4 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted);
  }
  .legend { display: flex; flex-wrap: wrap; gap: 8px 18px; }
  body:not([data-state="open"]) .legend { display: none; }
  .legend span { display: inline-flex; align-items: center; gap: 7px; }
  .legend svg { width: 9px; height: 9px; color: var(--faint); }
  .foot a { text-decoration: none; display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); }
  .foot a .arrow { width: 10px; height: 10px; }
  .foot a:hover { color: var(--ink); }

  @keyframes ring-in { from { stroke-dashoffset: 553; } }
  @keyframes ripple { 0% { transform: scale(.6); opacity: .7; } 100% { transform: scale(1.8); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    body[data-state="paid"] .ring-brand { animation: none; }
    .status .pulse::after { animation: none; }
    .button { transition: none; }
  }

  /* A phone: one column, the wallet button first, the code after it. */
  @media (max-width: 820px) {
    .frame { border: 0; }
    .bar { padding: 0 20px; height: 58px; }
    .grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: "summary" "scan" "more"; grid-template-rows: auto; align-content: start; }
    .summary { padding: 40px 20px 28px; }
    .scan { padding: 40px 20px 36px; min-height: 0; border-left: 0; border-top: 1px solid var(--line); }
    .more { padding: 24px 20px 32px; }
    .qr { width: 200px; height: 200px; }
    .status { margin-top: 30px; }
    .actions { margin-top: 28px; }
    .button { width: 100%; }
    .foot { padding: 16px 20px; }
  }
`;

const SCRIPT_BODY = `
  var statusBox = document.getElementById('status');
  var title = document.getElementById('status-title');
  var detail = document.getElementById('status-detail');
  var countdown = document.getElementById('countdown');
  var done = false;

  function show(status) {
    if (done) return;
    var text = copy[status] || copy.open;
    statusBox.setAttribute('data-state', status);
    document.body.setAttribute('data-state', status);
    title.textContent = text.title;
    detail.textContent = text.detail;

    if (status === 'paid') {
      done = true;
      if (countdown) countdown.textContent = '';
      // A moment to see the confirmation, then back to the shop.
      setTimeout(function () { window.location.href = s.successUrl; }, 1800);
    } else if (status === 'expired' || status === 'cancelled' || status === 'unmatched') {
      done = true;
      if (countdown) countdown.textContent = '';
    }
  }

  function tick() {
    if (done || !countdown) return;
    var left = Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 1000);
    if (left <= 0) { countdown.textContent = 'Request expired'; return; }
    var m = Math.floor(left / 60), sec = left % 60;
    countdown.textContent = 'Expires in ' + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  if (s.status === 'open') {
    tick();
    setInterval(tick, 1000);

    // The event stream is the fast path. Polling covers a proxy that buffers it.
    try {
      var stream = new EventSource(s.eventsPath);
      stream.addEventListener('session', function (event) {
        try { show(JSON.parse(event.data).status); } catch (_) { /* ignore a partial frame */ }
      });
    } catch (_) { /* no EventSource: polling alone */ }

    setInterval(function () {
      if (done) return;
      fetch(s.statusPath, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (body) { if (body) show(body.status); })
        .catch(function () { /* offline; the next tick retries */ });
    }, 5000);
  }
`;

export function renderPayPage(options: PayPageOptions): string {
  const { session, nonce } = options;
  const heading = options.merchantName ?? 'Pay with Keeta';
  const copy = STATUS_COPY[session.status] ?? STATUS_COPY.open;
  const ticker = session.tokenTicker ?? 'tokens';
  const figure = displayAmount(session.amountDecimal, session.tokenDecimals);
  const isOpen = session.status === 'open';
  const leaveUrl = session.status === 'paid' ? session.successUrl : session.cancelUrl;

  // The client script needs these; it must not receive the whole view, and in
  // particular nothing that is not already on this page.
  const bootstrap = {
    id: session.id,
    status: session.status,
    expiresAt: session.expiresAt,
    successUrl: session.successUrl,
    cancelUrl: session.cancelUrl,
    eventsPath: `/api/sessions/${encodeURIComponent(session.id)}/events`,
    statusPath: `/api/sessions/${encodeURIComponent(session.id)}`
  };

  // The code and the wallet link exist only while the request can be paid.
  const live = isOpen
    ? `
      <div class="actions live-only">
        <a class="button" id="pay" href="${escapeHtml(session.uri)}">Open in Keeta wallet ${ARROW}</a>
        <p class="countdown" id="countdown"></p>
      </div>
      <p class="hint live-only">On a computer, scan the code with your phone. On a phone, open the wallet straight from here.</p>
      <a class="button leave leave-cart" href="${escapeHtml(session.cancelUrl)}">Return to the shop ${ARROW}</a>`
    : `
      <div class="actions">
        <a class="button" href="${escapeHtml(leaveUrl)}">Return to the shop ${ARROW}</a>
      </div>`;

  const scanLive = isOpen
    ? `
    <section class="scan scan-live" aria-label="Scan to pay">
      <div class="qr-card">
        <img class="qr" id="qr" width="232" height="232"
             src="${escapeHtml(`/api/sessions/${encodeURIComponent(session.id)}/qr.svg`)}"
             alt="QR code for this payment request">
      </div>
      <p class="caption">Scan with your phone</p>
    </section>`
    : '';

  const more = isOpen
    ? `
    <section class="more live-only">
      <details>
        <summary>Pay manually</summary>
        <dl>
          <div class="row"><dt>Send to</dt><dd>${escapeHtml(session.receivingAddress)}</dd></div>
          <div class="row"><dt>Token</dt><dd>${escapeHtml(session.tokenAddress)}</dd></div>
          <div class="row"><dt>Amount, in base units</dt><dd>${escapeHtml(session.amount)}</dd></div>
          <div class="row"><dt>Reference, in the send's external field</dt><dd>${escapeHtml(referenceFromUri(session.uri))}</dd></div>
        </dl>
        <p class="must">All four must match, or the payment will not be credited automatically.</p>
      </details>
      <form method="post" action="${escapeHtml(`/pay/${encodeURIComponent(session.id)}/cancel`)}">
        <button type="submit">Cancel and return to the shop</button>
      </form>
    </section>`
    : '';

  const explorer =
    session.explorerUrl === null
      ? ''
      : `<a class="leave-paid" href="${escapeHtml(session.explorerUrl)}">View the transaction ${ARROW}</a>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#f8f8f8">
<title>${escapeHtml(heading)} &middot; ${escapeHtml(session.amountDecimal)} ${escapeHtml(ticker)}</title>
<style nonce="${escapeHtml(nonce)}">${STYLES}</style>
</head>
<body data-state="${escapeHtml(session.status)}">
<div class="frame">
  <header class="bar">
    ${KEETA_MARK}
    <span class="rule" aria-hidden="true"></span>
    <h1 class="merchant">${escapeHtml(heading)}</h1>
    ${session.network === 'main' ? '' : `<span class="tag">${escapeHtml(session.network)} network</span>`}
  </header>

  <main class="grid">
    <section class="summary">
      <p class="eyebrow"><span>Payment request</span><span class="sep" aria-hidden="true">/</span><span class="order">Order ${escapeHtml(session.orderId)}</span></p>
      <p class="amount">${escapeHtml(figure)}<span class="unit">${escapeHtml(ticker)}</span></p>

      <div class="status" id="status" data-state="${escapeHtml(session.status)}" role="status" aria-live="polite">
        <span class="pulse" aria-hidden="true"></span>
        <div>
          <p class="status-title" id="status-title">${escapeHtml(copy?.title ?? '')}</p>
          <p class="status-detail" id="status-detail">${escapeHtml(copy?.detail ?? '')}</p>
        </div>
      </div>
${live}
    </section>
${scanLive}
    <section class="scan scan-done" aria-hidden="true">
      <div class="result">${RING}${GLYPHS}</div>
    </section>
${more}
  </main>

  <footer class="foot">
    <span>Settles on the Keeta <span class="net">${escapeHtml(session.network)}</span> network</span>
    <span class="legend">
      <span>${MARKER_RING}Scan</span><span>${MARKER_DOT}Approve in wallet</span><span>${MARKER_TRIANGLE}Settles in seconds</span>
    </span>
    ${explorer}
  </footer>
</div>

<script nonce="${escapeHtml(nonce)}">
(function () {
  var s = ${jsonForScript(bootstrap)};
  var copy = ${jsonForScript(STATUS_COPY)};
${SCRIPT_BODY}
})();
</script>
</body>
</html>`;
}

/**
 * The amount as money is usually read: `129.5` shows as `129.50`, `7` as `7.00`.
 *
 * Only ever adds zeros, never removes a digit, so the figure is still exactly what
 * the request asks for. A token with fewer than two decimals is left alone.
 */
export function displayAmount(decimal: string, tokenDecimals: number): string {
  if (tokenDecimals < 2 || !/^\d+(\.\d+)?$/.test(decimal)) return decimal;
  const [whole, fraction = ''] = decimal.split('.');
  return fraction.length >= 2 ? decimal : `${whole}.${fraction.padEnd(2, '0')}`;
}

/**
 * Pull the `external` value back out of the payment URI, so the manual-payment
 * panel can show it without the payer view needing a separate field for it.
 */
function referenceFromUri(uri: string): string {
  try {
    return new URL(uri).searchParams.get('external') ?? '';
  } catch {
    return '';
  }
}
