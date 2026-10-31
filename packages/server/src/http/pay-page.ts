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
  /** Shown as the page heading. Defaults to a neutral label. */
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
 * Everything is inline and same-origin: no CDN, no font service, no analytics. The
 * nonce is what lets the one inline script run while anything injected cannot.
 */
export function payPageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

const STATUS_COPY: Record<string, { title: string; detail: string }> = {
  open: { title: 'Waiting for payment', detail: 'Scan the code or open it in your Keeta wallet.' },
  paid: { title: 'Paid', detail: 'Thank you. Your payment has settled on the Keeta network.' },
  expired: { title: 'This payment request expired', detail: 'Go back to the shop and start again.' },
  cancelled: { title: 'Payment cancelled', detail: 'Nothing was charged.' },
  unmatched: {
    title: 'This payment needs attention',
    detail: 'Money arrived that could not be matched to this order. The shop has been notified.'
  }
};

export function renderPayPage(options: PayPageOptions): string {
  const { session, nonce } = options;
  const heading = options.merchantName ?? 'Pay with Keeta';
  const copy = STATUS_COPY[session.status] ?? STATUS_COPY.open;
  const ticker = session.tokenTicker ?? 'tokens';
  const isOpen = session.status === 'open';

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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(heading)} &middot; ${escapeHtml(session.amountDecimal)} ${escapeHtml(ticker)}</title>
<style nonce="${escapeHtml(nonce)}">
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #ffffff; --ink: #11161c; --muted: #5b6673;
    --line: #e3e7ec; --accent: #1c6ef2; --accent-ink: #ffffff;
    --ok-bg: #e7f6ec; --ok-ink: #0f6b33; --warn-bg: #fdf0e3; --warn-ink: #8a4b08;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e1116; --card: #171c23; --ink: #e8ecf1; --muted: #9aa5b3;
      --line: #28303a; --accent: #4f8dfb; --accent-ink: #08111f;
      --ok-bg: #11291b; --ok-ink: #5fd98c; --warn-bg: #2a1f10; --warn-ink: #e0a860;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; min-height: 100vh;
    background: var(--bg); color: var(--ink);
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; align-items: flex-start; justify-content: center;
  }
  .card {
    width: 100%; max-width: 420px; background: var(--card);
    border: 1px solid var(--line); border-radius: 14px; padding: 24px;
  }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .order { margin: 0 0 20px; color: var(--muted); font-size: 13px; word-break: break-word; }
  .amount { font-size: 30px; font-weight: 650; letter-spacing: -0.02em; }
  .amount span { font-size: 16px; font-weight: 500; color: var(--muted); }
  .status {
    margin: 18px 0; padding: 12px 14px; border-radius: 10px;
    background: var(--warn-bg); color: var(--warn-ink); font-size: 14px;
  }
  .status[data-state="paid"] { background: var(--ok-bg); color: var(--ok-ink); }
  .status strong { display: block; font-size: 15px; }
  .qr {
    display: block; width: 220px; height: 220px; margin: 20px auto;
    background: #fff; padding: 10px; border-radius: 10px; border: 1px solid var(--line);
  }
  a.pay {
    display: block; text-align: center; padding: 13px 16px; border-radius: 10px;
    background: var(--accent); color: var(--accent-ink);
    font-weight: 600; text-decoration: none;
  }
  .hint { margin: 12px 0 0; color: var(--muted); font-size: 13px; text-align: center; }
  details { margin-top: 20px; border-top: 1px solid var(--line); padding-top: 16px; }
  summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  dl { margin: 14px 0 0; font-size: 13px; }
  dt { color: var(--muted); margin-top: 12px; }
  dd {
    margin: 4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; word-break: break-all; user-select: all;
  }
  form { margin: 18px 0 0; text-align: center; }
  button.cancel {
    background: none; border: 0; padding: 6px; cursor: pointer;
    color: var(--muted); font: inherit; font-size: 13px; text-decoration: underline;
  }
  footer { margin: 18px 0 0; text-align: center; color: var(--muted); font-size: 12px; }
  .net { text-transform: uppercase; letter-spacing: 0.06em; }
</style>
</head>
<body>
<main class="card">
  <h1>${escapeHtml(heading)}</h1>
  <p class="order">Order ${escapeHtml(session.orderId)}</p>

  <div class="amount">${escapeHtml(session.amountDecimal)} <span>${escapeHtml(ticker)}</span></div>

  <div class="status" id="status" data-state="${escapeHtml(session.status)}">
    <strong id="status-title">${escapeHtml(copy?.title ?? '')}</strong>
    <span id="status-detail">${escapeHtml(copy?.detail ?? '')}</span>
  </div>

${
  isOpen
    ? `  <img class="qr" id="qr" width="220" height="220"
       src="${escapeHtml(`/api/sessions/${encodeURIComponent(session.id)}/qr.svg`)}"
       alt="QR code for this payment request">

  <a class="pay" id="pay" href="${escapeHtml(session.uri)}">Open in Keeta wallet</a>
  <p class="hint" id="countdown">Scan the code with your phone, or tap to open a wallet on this device.</p>

  <details>
    <summary>Pay manually</summary>
    <dl>
      <dt>Send to</dt><dd>${escapeHtml(session.receivingAddress)}</dd>
      <dt>Token</dt><dd>${escapeHtml(session.tokenAddress)}</dd>
      <dt>Amount, in base units</dt><dd>${escapeHtml(session.amount)}</dd>
      <dt>Reference, in the send's external field</dt><dd>${escapeHtml(referenceFromUri(session.uri))}</dd>
    </dl>
    <p class="hint">All four must match, or the payment will not be credited automatically.</p>
  </details>

  <form method="post" action="${escapeHtml(`/pay/${encodeURIComponent(session.id)}/cancel`)}">
    <button class="cancel" type="submit">Cancel and return to the shop</button>
  </form>`
    : `  <p class="hint"><a href="${escapeHtml(session.status === 'paid' ? session.successUrl : session.cancelUrl)}">Return to the shop</a></p>`
}

  <footer>
    Settles on the Keeta <span class="net">${escapeHtml(session.network)}</span> network.
    ${session.explorerUrl === null ? '' : `<a href="${escapeHtml(session.explorerUrl)}">View the transaction</a>.`}
  </footer>
</main>

<script nonce="${escapeHtml(nonce)}">
(function () {
  var s = ${jsonForScript(bootstrap)};
  var statusBox = document.getElementById('status');
  var title = document.getElementById('status-title');
  var detail = document.getElementById('status-detail');
  var countdown = document.getElementById('countdown');
  var copy = ${jsonForScript(STATUS_COPY)};
  var done = false;

  function show(status) {
    if (done) return;
    var text = copy[status] || copy.open;
    statusBox.setAttribute('data-state', status);
    title.textContent = text.title;
    detail.textContent = text.detail;

    if (status === 'paid') {
      done = true;
      if (countdown) countdown.textContent = '';
      // A moment to read the confirmation, then back to the shop.
      setTimeout(function () { window.location.href = s.successUrl; }, 1500);
    } else if (status === 'expired' || status === 'cancelled' || status === 'unmatched') {
      done = true;
      if (countdown) countdown.textContent = '';
    }
  }

  function tick() {
    if (done || !countdown) return;
    var left = Math.floor((new Date(s.expiresAt).getTime() - Date.now()) / 1000);
    if (left <= 0) { countdown.textContent = 'This request has expired.'; return; }
    var m = Math.floor(left / 60), sec = left % 60;
    countdown.textContent = 'Expires in ' + m + ':' + (sec < 10 ? '0' : '') + sec + '.';
  }

  if (s.status === 'open') {
    tick();
    setInterval(tick, 1000);

    // The event stream is the fast path. Polling covers a proxy that buffers it.
    var stream = null;
    try {
      stream = new EventSource(s.eventsPath);
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
})();
</script>
</body>
</html>`;
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
