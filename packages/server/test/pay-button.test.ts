/**
 * The pay button, in a real DOM.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeetaPayButton, defineKeetaPayButton, type PayButtonSession } from '../../button/src/pay-button.ts';
import { MERCHANT_ADDRESS, USDC } from './support/fakes.ts';

const SESSION: PayButtonSession = {
  id: 'cs_AAAAAAAAAAAAAAAAAAAAAA',
  status: 'open',
  uri: `keeta://actions/send?to=${MERCHANT_ADDRESS}&token=${USDC}&value=12500000&external=kc_REF`,
  qrSvgUrl: '/api/sessions/cs_AAAAAAAAAAAAAAAAAAAAAA/qr.svg',
  hostedUrl: null,
  amount: '12500000',
  amountDecimal: '12.5',
  tokenAddress: USDC,
  tokenTicker: '$USDC',
  tokenDecimals: 6,
  receivingAddress: MERCHANT_ADDRESS,
  network: 'test',
  orderId: 'order-1001',
  expiresAt: '2026-10-30T12:30:00.000Z',
  successUrl: 'https://shop.example/thanks',
  cancelUrl: 'https://shop.example/cart',
  explorerUrl: null
};

/** Requests the fake server saw, and what it answers next. */
let requests: string[] = [];
let answer: PayButtonSession | { status: number } = SESSION;

function mountFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      requests.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if ('status' in answer && typeof answer.status === 'number') {
        return Promise.resolve(new Response(null, { status: answer.status }));
      }
      return Promise.resolve(
        new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } })
      );
    })
  );
}

/** happy-dom has no EventSource; the component must fall back to polling. */
function removeEventSource(): void {
  vi.stubGlobal('EventSource', undefined);
}

async function mount(attributes: Record<string, string>): Promise<KeetaPayButton> {
  const element = document.createElement('keeta-pay-button') as KeetaPayButton;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  // `refresh()` is kicked off by connectedCallback; let its promise settle.
  await vi.waitFor(() => expect(element.shadowRoot?.textContent).not.toContain('Loading'));
  return element;
}

const shadow = (element: KeetaPayButton): ShadowRoot => {
  const root = element.shadowRoot;
  if (root === null) throw new Error('the component has no shadow root');
  return root;
};

beforeEach(() => {
  defineKeetaPayButton();
  requests = [];
  answer = SESSION;
  mountFetch();
  removeEventSource();
  vi.useRealTimers();
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registration', () => {
  it('defines the element once and tolerates being called again', () => {
    defineKeetaPayButton();
    defineKeetaPayButton();
    expect(customElements.get('keeta-pay-button')).toBe(KeetaPayButton);
  });
});

describe('an open session', () => {
  it('fetches the session from the configured base URL', async () => {
    await mount({ 'session-id': SESSION.id, 'base-url': 'https://pay.example' });
    expect(requests[0]).toBe(`https://pay.example/api/sessions/${SESSION.id}`);
  });

  it('uses a same-origin path when no base URL is given', async () => {
    await mount({ 'session-id': SESSION.id });
    expect(requests[0]).toBe(`/api/sessions/${SESSION.id}`);
  });

  it('shows the amount and the token on the button', async () => {
    const element = await mount({ 'session-id': SESSION.id });
    const button = shadow(element).querySelector('button.pay');
    expect(button?.textContent).toBe('Pay with Keeta · 12.5 $USDC');
  });

  it('honours a custom label', async () => {
    const element = await mount({ 'session-id': SESSION.id, label: 'Checkout' });
    expect(shadow(element).querySelector('button.pay')?.textContent).toContain('Checkout');
  });

  it('keeps the payment panel hidden until the button is clicked', async () => {
    const element = await mount({ 'session-id': SESSION.id });
    const panel = shadow(element).querySelector<HTMLElement>('.panel');
    expect(panel?.hidden).toBe(true);

    shadow(element).querySelector<HTMLButtonElement>('button.pay')?.click();
    expect(panel?.hidden).toBe(false);
  });

  it('offers the QR, the deep link, and the details to pay by hand', async () => {
    const element = await mount({ 'session-id': SESSION.id, 'base-url': 'https://pay.example' });
    shadow(element).querySelector<HTMLButtonElement>('button.pay')?.click();

    const root = shadow(element);
    expect(root.querySelector('img.qr')?.getAttribute('src')).toBe(`https://pay.example${SESSION.qrSvgUrl}`);
    expect(root.querySelector('a.open')?.getAttribute('href')).toBe(SESSION.uri);

    const manual = root.querySelector('details')?.textContent ?? '';
    expect(manual).toContain(MERCHANT_ADDRESS);
    expect(manual).toContain(USDC);
    expect(manual).toContain('12500000');
    expect(manual).toContain('kc_REF');
  });

  it('leaves an absolute QR URL alone', async () => {
    answer = { ...SESSION, qrSvgUrl: 'https://cdn.example/qr.svg' };
    const element = await mount({ 'session-id': SESSION.id, 'base-url': 'https://pay.example' });
    shadow(element).querySelector<HTMLButtonElement>('button.pay')?.click();
    expect(shadow(element).querySelector('img.qr')?.getAttribute('src')).toBe('https://cdn.example/qr.svg');
  });

  it('renders untrusted values as text, never as markup', async () => {
    answer = { ...SESSION, tokenTicker: '<img src=x onerror=alert(1)>', orderId: '<script>alert(1)</script>' };
    const element = await mount({ 'session-id': SESSION.id });

    const root = shadow(element);
    expect(root.querySelector('img:not(.qr)')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('button.pay')?.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('a session that is already closed', () => {
  it('says it is paid and offers no payment controls', async () => {
    answer = { ...SESSION, status: 'paid' };
    const element = await mount({ 'session-id': SESSION.id });

    const root = shadow(element);
    expect(root.querySelector('.state.paid')?.textContent).toBe('Paid 12.5 $USDC');
    expect(root.querySelector('button.pay')).toBeNull();
    expect(root.querySelector('img.qr')).toBeNull();
  });

  it('reports expired, cancelled and unmatched plainly', async () => {
    for (const status of ['expired', 'cancelled', 'unmatched'] as const) {
      answer = { ...SESSION, status };
      const element = await mount({ 'session-id': SESSION.id });
      expect(shadow(element).querySelector('.state')?.textContent).toBe(`This payment request is ${status}.`);
      element.remove();
    }
  });
});

describe('events', () => {
  it('emits keeta-paid once, with the session, and it bubbles out of the shadow root', async () => {
    const seen: PayButtonSession[] = [];
    document.addEventListener('keeta-paid', (event) => seen.push((event as CustomEvent<PayButtonSession>).detail));

    const element = await mount({ 'session-id': SESSION.id });
    expect(seen).toHaveLength(0); // still open

    answer = { ...SESSION, status: 'paid' };
    await element.refresh();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(SESSION.id);

    // A second observation of the same status announces nothing further.
    await element.refresh();
    expect(seen).toHaveLength(1);
  });

  it('emits the matching event for each terminal status', async () => {
    for (const status of ['expired', 'cancelled', 'unmatched'] as const) {
      const seen: string[] = [];
      document.addEventListener(`keeta-${status}`, () => seen.push(status));

      const element = await mount({ 'session-id': SESSION.id });
      answer = { ...SESSION, status };
      await element.refresh();

      expect(seen).toEqual([status]);
      element.remove();
      answer = SESSION;
    }
  });

  it('emits keeta-error when the server refuses, and shows the shopper something', async () => {
    const seen: Array<{ message: string }> = [];
    document.addEventListener('keeta-error', (event) => seen.push((event as CustomEvent<{ message: string }>).detail));

    answer = { status: 503 };
    const element = await mount({ 'session-id': SESSION.id });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toContain('503');
    expect(shadow(element).textContent).toContain('Payment unavailable');
  });

  it('refuses to start with no session id', async () => {
    const seen: Array<{ message: string }> = [];
    document.addEventListener('keeta-error', (event) => seen.push((event as CustomEvent<{ message: string }>).detail));

    const element = document.createElement('keeta-pay-button') as KeetaPayButton;
    document.body.append(element);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.message).toContain('no session-id');
    expect(requests).toEqual([]);
  });
});

describe('watching for settlement', () => {
  it('polls while the session is open, and stops once it settles', async () => {
    vi.useFakeTimers();
    await mount({ 'session-id': SESSION.id });
    const afterMount = requests.length;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(requests.length).toBeGreaterThan(afterMount);

    answer = { ...SESSION, status: 'paid' };
    await vi.advanceTimersByTimeAsync(5_000);
    const afterPaid = requests.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests.length).toBe(afterPaid);
  });

  it('stops polling when the element is removed from the page', async () => {
    vi.useFakeTimers();
    const element = await mount({ 'session-id': SESSION.id });
    element.remove();
    const afterRemoval = requests.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(requests.length).toBe(afterRemoval);
  });

  it('subscribes to the event stream when the browser has one', async () => {
    const listeners: Record<string, (event: MessageEvent<string>) => void> = {};
    const closed = vi.fn();
    class FakeEventSource {
      constructor(readonly url: string) {}
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
        listeners[type] = listener;
      }
      close = closed;
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const seen: string[] = [];
    document.addEventListener('keeta-paid', () => seen.push('paid'));
    const element = await mount({ 'session-id': SESSION.id, 'base-url': 'https://pay.example' });

    // Settlement arrives over the stream, with no further polling.
    const before = requests.length;
    listeners.session?.(new MessageEvent('session', { data: JSON.stringify({ ...SESSION, status: 'paid' }) }));

    expect(seen).toEqual(['paid']);
    expect(requests.length).toBe(before);
    expect(closed).toHaveBeenCalled();
    expect(shadow(element).querySelector('.state.paid')).not.toBeNull();
  });

  it('survives a malformed frame on the stream', async () => {
    const listeners: Record<string, (event: MessageEvent<string>) => void> = {};
    class FakeEventSource {
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
        listeners[type] = listener;
      }
      close = (): void => undefined;
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const element = await mount({ 'session-id': SESSION.id });
    listeners.session?.(new MessageEvent('session', { data: '{not json' }));
    // Still showing the pay button, not an error.
    expect(shadow(element).querySelector('button.pay')).not.toBeNull();
  });
});

describe('changing attributes', () => {
  it('reloads when the session id changes', async () => {
    const element = await mount({ 'session-id': SESSION.id });
    const nextId = 'cs_BBBBBBBBBBBBBBBBBBBBBB';
    answer = { ...SESSION, id: nextId };

    element.setAttribute('session-id', nextId);
    // Wait for the new session to be applied, not merely requested: the fetch is
    // issued first and the state lands a microtask later.
    await vi.waitFor(() => expect(element.session?.id).toBe(nextId));
    expect(requests.some((url) => url.includes(nextId))).toBe(true);
  });

  it('re-renders on a label change without refetching', async () => {
    const element = await mount({ 'session-id': SESSION.id });
    const before = requests.length;

    element.setAttribute('label', 'Pay now');
    expect(shadow(element).querySelector('button.pay')?.textContent).toContain('Pay now');
    expect(requests.length).toBe(before);
  });
});
