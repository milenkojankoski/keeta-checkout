/**
 * `<keeta-pay-button>`: a drop-in pay button for a merchant's own checkout page.
 *
 * ```html
 * <script type="module" src="/keeta-pay-button.js"></script>
 * <keeta-pay-button session-id="cs_…" base-url="https://pay.example"></keeta-pay-button>
 * ```
 *
 * What it does, and why it is built this way:
 *
 * - **No Keeta code, no dependencies.** It reads the session from the checkout
 *   server's public status route and renders what that returns. The amount, the
 *   token, the URI and the QR all come from the server, so the browser never
 *   converts an amount or builds a payment request.
 * - **Shadow DOM.** A shop's stylesheet cannot accidentally restyle a payment
 *   control, and this component cannot leak styles into the shop.
 * - **Event stream, with polling underneath.** `EventSource` is the fast path;
 *   a five-second poll covers a proxy that buffers the stream or a browser that
 *   has no `EventSource`. Whichever notices first wins.
 * - **A copy-the-details fallback.** Deep-link support for `keeta://` is not
 *   universal, so the address, token, base-unit amount and reference are always
 *   available to copy.
 *
 * It emits `keeta-paid`, `keeta-expired`, `keeta-cancelled`, `keeta-unmatched` and
 * `keeta-error`, each bubbling and composed, with the session view in `detail`.
 */

/** The payer-safe session shape, as the status route returns it. */
export interface PayButtonSession {
  id: string;
  status: 'open' | 'paid' | 'expired' | 'cancelled' | 'unmatched';
  uri: string;
  qrSvgUrl: string;
  hostedUrl: string | null;
  amount: string;
  amountDecimal: string;
  tokenAddress: string;
  tokenTicker: string | null;
  tokenDecimals: number;
  receivingAddress: string;
  network: string;
  orderId: string;
  expiresAt: string;
  successUrl: string;
  cancelUrl: string;
  explorerUrl: string | null;
}

const POLL_INTERVAL_MS = 5_000;

const STYLES = `
  :host {
    --kc-accent: #1c6ef2;
    --kc-accent-ink: #fff;
    --kc-ink: #11161c;
    --kc-muted: #5b6673;
    --kc-line: #e3e7ec;
    --kc-card: #fff;
    --kc-ok-bg: #e7f6ec;
    --kc-ok-ink: #0f6b33;
    --kc-radius: 10px;
    display: block;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: var(--kc-ink);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --kc-ink: #e8ecf1; --kc-muted: #9aa5b3; --kc-line: #28303a; --kc-card: #171c23;
      --kc-accent: #4f8dfb; --kc-accent-ink: #08111f; --kc-ok-bg: #11291b; --kc-ok-ink: #5fd98c;
    }
  }
  * { box-sizing: border-box; }
  button.pay {
    width: 100%; padding: 13px 16px; border: 0; border-radius: var(--kc-radius);
    background: var(--kc-accent); color: var(--kc-accent-ink);
    font: inherit; font-weight: 600; cursor: pointer;
  }
  button.pay:disabled { opacity: 0.6; cursor: default; }
  .panel {
    margin-top: 12px; padding: 16px; text-align: center;
    background: var(--kc-card); border: 1px solid var(--kc-line); border-radius: var(--kc-radius);
  }
  img.qr {
    display: block; width: 200px; height: 200px; margin: 0 auto 12px;
    background: #fff; padding: 8px; border-radius: 8px;
  }
  a.open {
    display: block; padding: 11px 14px; border-radius: var(--kc-radius);
    background: var(--kc-accent); color: var(--kc-accent-ink);
    font-weight: 600; text-decoration: none;
  }
  .note { margin: 10px 0 0; font-size: 13px; color: var(--kc-muted); }
  .state { padding: 10px 12px; border-radius: var(--kc-radius); font-size: 14px; }
  .state.paid { background: var(--kc-ok-bg); color: var(--kc-ok-ink); font-weight: 600; }
  details { margin-top: 12px; text-align: left; }
  summary { cursor: pointer; font-size: 13px; color: var(--kc-muted); }
  dl { margin: 10px 0 0; font-size: 12px; }
  dt { color: var(--kc-muted); margin-top: 8px; }
  dd {
    margin: 2px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-all; user-select: all;
  }
  button.copy {
    margin-top: 10px; padding: 7px 10px; border: 1px solid var(--kc-line);
    border-radius: 8px; background: none; color: inherit; font: inherit; font-size: 13px; cursor: pointer;
  }
  [hidden] { display: none !important; }
`;

export class KeetaPayButton extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['session-id', 'base-url', 'label'];
  }

  #root: ShadowRoot;
  #session: PayButtonSession | undefined;
  #stream: EventSource | undefined;
  #poll: ReturnType<typeof setInterval> | undefined;
  #settled = false;
  #connected = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  get sessionId(): string {
    return this.getAttribute('session-id') ?? '';
  }

  /** Where the checkout server is. Empty means same origin. */
  get baseUrl(): string {
    return (this.getAttribute('base-url') ?? '').replace(/\/+$/, '');
  }

  get label(): string {
    return this.getAttribute('label') ?? 'Pay with Keeta';
  }

  /** The session as last seen, or `undefined` before it loads. */
  get session(): PayButtonSession | undefined {
    return this.#session;
  }

  connectedCallback(): void {
    this.#connected = true;
    this.#render();
    void this.refresh();
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#stopWatching();
  }

  attributeChangedCallback(name: string, before: string | null, after: string | null): void {
    if (before === after || !this.#connected) return;
    if (name === 'session-id' || name === 'base-url') {
      this.#stopWatching();
      this.#session = undefined;
      this.#settled = false;
      void this.refresh();
    } else {
      this.#render();
    }
  }

  /** Fetch the session once and render it. */
  async refresh(): Promise<void> {
    if (this.sessionId === '') {
      this.#fail('no session-id was given');
      return;
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}`, {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        this.#fail(`the checkout server answered ${response.status}`);
        return;
      }
      this.#apply((await response.json()) as PayButtonSession);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  #apply(session: PayButtonSession): void {
    const changed = this.#session?.status !== session.status;
    this.#session = session;
    this.#render();

    if (session.status === 'open') {
      this.#startWatching();
      return;
    }

    this.#stopWatching();
    if (!this.#settled && changed) {
      this.#settled = true;
      this.dispatchEvent(new CustomEvent(`keeta-${session.status}`, { detail: session, bubbles: true, composed: true }));
    }
  }

  #startWatching(): void {
    if (this.#poll !== undefined) return;

    if (typeof EventSource !== 'undefined') {
      try {
        const stream = new EventSource(`${this.baseUrl}/api/sessions/${encodeURIComponent(this.sessionId)}/events`);
        stream.addEventListener('session', (event) => {
          try {
            this.#apply(JSON.parse((event as MessageEvent<string>).data) as PayButtonSession);
          } catch {
            // A partial frame; the poll below is the safety net.
          }
        });
        // An error on the stream is not fatal: polling carries on.
        stream.addEventListener('error', () => undefined);
        this.#stream = stream;
      } catch {
        // No EventSource in this browser, or blocked. Polling alone.
      }
    }

    this.#poll = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
  }

  #stopWatching(): void {
    this.#stream?.close();
    this.#stream = undefined;
    if (this.#poll !== undefined) {
      clearInterval(this.#poll);
      this.#poll = undefined;
    }
  }

  #fail(message: string): void {
    this.#stopWatching();
    this.#root.replaceChildren(this.#style(), el('div', { class: 'state' }, `Payment unavailable: ${message}`));
    this.dispatchEvent(new CustomEvent('keeta-error', { detail: { message }, bubbles: true, composed: true }));
  }

  #style(): HTMLStyleElement {
    const style = document.createElement('style');
    style.textContent = STYLES;
    return style;
  }

  #render(): void {
    const session = this.#session;
    const nodes: Node[] = [this.#style()];

    if (session === undefined) {
      nodes.push(el('button', { class: 'pay', disabled: 'true', type: 'button' }, 'Loading…'));
      this.#root.replaceChildren(...nodes);
      return;
    }

    if (session.status !== 'open') {
      const detail =
        session.status === 'paid'
          ? `Paid ${session.amountDecimal} ${session.tokenTicker ?? ''}`.trim()
          : `This payment request is ${session.status}.`;
      nodes.push(el('div', { class: `state ${session.status}` }, detail));
      this.#root.replaceChildren(...nodes);
      return;
    }

    // Open: the button, and a panel that opens on click.
    const trigger = el('button', { class: 'pay', type: 'button' }, `${this.label} · ${session.amountDecimal} ${session.tokenTicker ?? ''}`.trim());
    const panel = el('div', { class: 'panel', hidden: 'true' });

    const qr = el('img', {
      class: 'qr',
      width: '200',
      height: '200',
      alt: 'QR code for this payment request',
      src: absolute(this.baseUrl, session.qrSvgUrl)
    });

    const open = el('a', { class: 'open', href: session.uri }, 'Open in Keeta wallet');
    const note = el('p', { class: 'note' }, 'Scan with your phone, or tap to open a wallet on this device.');

    const manual = el('details', {});
    manual.append(
      el('summary', {}, 'Pay manually'),
      rows([
        ['Send to', session.receivingAddress],
        ['Token', session.tokenAddress],
        ['Amount, in base units', session.amount],
        ["Reference, in the send's external field", referenceFromUri(session.uri)]
      ])
    );

    const copy = el('button', { class: 'copy', type: 'button' }, 'Copy the payment link');
    copy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(session.uri).then(
        () => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy the payment link'), 1500);
        },
        () => (copy.textContent = 'Could not copy; select the details above')
      );
    });

    panel.append(qr, open, note, manual, copy);
    trigger.addEventListener('click', () => {
      panel.hidden = false;
      trigger.hidden = true;
    });

    nodes.push(trigger, panel);
    this.#root.replaceChildren(...nodes);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'hidden' || name === 'disabled') {
      node.toggleAttribute(name, true);
    } else {
      node.setAttribute(name, value);
    }
  }
  // textContent, never innerHTML: nothing from the server is ever parsed as markup.
  if (text !== undefined) node.textContent = text;
  return node;
}

function rows(pairs: Array<[string, string]>): HTMLDListElement {
  const list = document.createElement('dl');
  for (const [term, value] of pairs) {
    list.append(el('dt', {}, term), el('dd', {}, value));
  }
  return list;
}

function absolute(baseUrl: string, path: string): string {
  if (baseUrl === '' || /^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path}`;
}

function referenceFromUri(uri: string): string {
  try {
    return new URL(uri).searchParams.get('external') ?? '';
  } catch {
    return '';
  }
}

/** Register the element. Safe to call more than once. */
export function defineKeetaPayButton(tagName = 'keeta-pay-button'): void {
  if (typeof customElements === 'undefined') return;
  if (customElements.get(tagName) !== undefined) return;
  customElements.define(tagName, KeetaPayButton);
}
