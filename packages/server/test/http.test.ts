import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { formatBaseUnits } from '../src/amounts.ts';
import { createApp, type CheckoutApp } from '../src/http/app.ts';
import { CheckoutService } from '../src/sessions/service.ts';
import { MemorySessionStore } from '../src/sessions/store.ts';
import { WebhookDispatcher } from '../src/webhooks/dispatcher.ts';
import { WEBHOOK_EVENT_TYPES } from '../src/webhooks/types.ts';
import { API_KEY, FakeClock, MERCHANT_ADDRESS, USDC, fakeRegistry, testConfig } from './support/fakes.ts';
import type { CheckoutConfigInput } from '../src/config.ts';

const VALID = {
  amount: '12.50',
  currency: '$USDC',
  orderId: 'order-1001',
  successUrl: 'https://shop.example/thanks',
  cancelUrl: 'https://shop.example/cart'
};

const auth = { Authorization: `Bearer ${API_KEY}` };

let harness: {
  app: CheckoutApp;
  service: CheckoutService;
  store: MemorySessionStore;
  clock: FakeClock;
};

function build(configOverrides: Partial<CheckoutConfigInput> = {}): typeof harness {
  const clock = new FakeClock();
  const store = new MemorySessionStore();
  const service = new CheckoutService({
    config: testConfig(configOverrides),
    store,
    tokens: fakeRegistry(),
    now: clock.now
  });
  // No sweep timer: the tests drive the clock and call sweepExpired themselves.
  const app = createApp({ service, sweepIntervalMs: 0, log: { error: () => undefined } });
  return { app, service, store, clock };
}

beforeEach(() => {
  harness = build();
});

afterEach(() => {
  harness.app.close();
});

const server = (): request.Agent => request(harness.app.app);

async function createSession(body: Record<string, unknown> = VALID): Promise<request.Response> {
  return server().post('/api/sessions').set(auth).send(body);
}

describe('GET /health', () => {
  it('is open and names the network', async () => {
    const response = await server().get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', network: 'test' });
  });
});

describe('authentication', () => {
  it('refuses a session request with no key', async () => {
    const response = await server().post('/api/sessions').send(VALID);
    expect(response.status).toBe(401);
    expect(response.body.error.type).toBe('authentication_error');
  });

  it('refuses a wrong key, a wrong scheme and an empty bearer', async () => {
    for (const header of ['Bearer wrong_key_0000000000', `Basic ${API_KEY}`, 'Bearer ', API_KEY]) {
      const response = await server().post('/api/sessions').set('Authorization', header).send(VALID);
      expect(response.status, header).toBe(401);
    }
  });

  it('accepts the configured key, case-insensitively on the scheme', async () => {
    const response = await server().post('/api/sessions').set('Authorization', `bearer ${API_KEY}`).send(VALID);
    expect(response.status).toBe(201);
  });

  it('protects the token listing', async () => {
    expect((await server().get('/api/tokens')).status).toBe(401);
    expect((await server().get('/api/tokens').set(auth)).status).toBe(200);
  });
});

describe('POST /api/sessions', () => {
  it('creates a session and returns the merchant view', async () => {
    const response = await createSession();
    expect(response.status).toBe(201);

    const body = response.body;
    expect(body.id).toMatch(/^cs_/);
    expect(body.reference).toMatch(/^kc_/);
    expect(body.status).toBe('open');
    expect(body.amount).toBe('12500000');
    expect(body.amountDecimal).toBe('12.5');
    expect(body.tokenTicker).toBe('$USDC');
    expect(body.tokenAddress).toBe(USDC);
    expect(body.receivingAddress).toBe(MERCHANT_ADDRESS);
    expect(body.network).toBe('test');
    expect(body.orderId).toBe('order-1001');
    expect(body.explorerUrl).toBeNull();
    expect(body.uri).toContain(body.reference);
    expect(body.qrSvgUrl).toContain('/qr.svg');
  });

  it('reports a validation failure with the field at fault', async () => {
    const response = await createSession({ ...VALID, amount: '0' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      type: 'invalid_request_error',
      code: 'AMOUNT_NOT_POSITIVE',
      param: 'amount'
    });
  });

  it('rejects a numeric amount, so the merchant digits survive the trip', async () => {
    const response = await createSession({ ...VALID, amount: 12.5 });
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('amount');
  });

  it('rejects a non-object body', async () => {
    for (const body of ['"a string"', '[1,2]', '42']) {
      const response = await server()
        .post('/api/sessions')
        .set(auth)
        .set('Content-Type', 'application/json')
        .send(body);
      expect(response.status, body).toBe(400);
      expect(response.body.error.code, body).toBe('BODY_INVALID');
    }
  });

  it('rejects malformed JSON', async () => {
    const response = await server()
      .post('/api/sessions')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send('{ not json');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MALFORMED_JSON');
  });

  it('400s a permit-listed currency with an explanation', async () => {
    const response = await createSession({ ...VALID, currency: 'USD' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('TOKEN_NOT_TRANSFERABLE');
    expect(response.body.error.param).toBe('currency');
  });

  it('rejects a non-numeric expiresIn', async () => {
    const response = await createSession({ ...VALID, expiresIn: '600' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('EXPIRES_IN_INVALID');
  });
});

describe('GET /api/sessions/:id', () => {
  it('serves the payer view without a key, with no bare reference field', async () => {
    const created = await createSession();
    const response = await server().get(`/api/sessions/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.body.id).toBe(created.body.id);
    expect(response.body.reference).toBeUndefined();
  });

  it('gives the payer the payment URI and QR link they need', async () => {
    const created = await createSession();
    const response = await server().get(`/api/sessions/${created.body.id}`);

    expect(response.body.uri).toMatch(/^keeta:\/\/actions\/send\?/);
    expect(response.body.uri).toContain('value=12500000');
    expect(response.body.qrSvgUrl).toContain(`/api/sessions/${created.body.id}/qr.svg`);
  });

  it('shows one payer nothing of another session', async () => {
    const mine = await createSession();
    const theirs = await createSession();
    const response = await server().get(`/api/sessions/${mine.body.id}`);

    expect(JSON.stringify(response.body)).not.toContain(theirs.body.reference);
    expect(JSON.stringify(response.body)).not.toContain(theirs.body.id);
  });

  it('serves the merchant view only with a key', async () => {
    const created = await createSession();
    const url = `/api/sessions/${created.body.id}?view=merchant`;

    expect((await server().get(url)).status).toBe(401);

    const authorised = await server().get(url).set(auth);
    expect(authorised.status).toBe(200);
    expect(authorised.body.reference).toBe(created.body.reference);
    expect(authorised.body.graceUntil).toBeDefined();
  });

  it('404s an unknown session', async () => {
    const response = await server().get('/api/sessions/cs_nope');
    expect(response.status).toBe(404);
    expect(response.body.error.type).toBe('not_found_error');
  });

  it('reports expired once the deadline passes', async () => {
    const created = await createSession({ ...VALID, expiresIn: 60 });
    expect((await server().get(`/api/sessions/${created.body.id}`)).body.status).toBe('open');

    harness.clock.advance(61_000);
    expect((await server().get(`/api/sessions/${created.body.id}`)).body.status).toBe('expired');
  });
});

describe('GET /api/sessions/:id/qr.svg', () => {
  it('serves an SVG image of the payment URI, with no key', async () => {
    const created = await createSession();
    const response = await server().get(`/api/sessions/${created.body.id}/qr.svg`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    expect(response.headers['cache-control']).toContain('private');

    // Superagent buffers an image content type into `body`, not `text`.
    const svg = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.text);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });

  it('404s an unknown session', async () => {
    const response = await server().get('/api/sessions/cs_nope/qr.svg');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('still serves a code for an expired session, so the page can show what was asked', async () => {
    const created = await createSession({ ...VALID, expiresIn: 60 });
    harness.clock.advance(61_000);
    expect((await server().get(`/api/sessions/${created.body.id}/qr.svg`)).status).toBe(200);
  });
});

describe('POST /api/sessions/:id/cancel', () => {
  it('cancels with only the session id, because a browser cannot hold a key', async () => {
    const created = await createSession();
    const response = await server().post(`/api/sessions/${created.body.id}/cancel`);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('cancelled');
    expect(response.body.reference).toBeUndefined();
  });

  it('is idempotent', async () => {
    const created = await createSession();
    await server().post(`/api/sessions/${created.body.id}/cancel`);
    const again = await server().post(`/api/sessions/${created.body.id}/cancel`);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('cancelled');
  });

  it('409s a paid session', async () => {
    const created = await createSession();
    await harness.store.markPaid(created.body.id, {
      paidBy: 'keeta_payer',
      blockHash: 'b1',
      operationIndex: 0,
      received: 12_500_000n,
      blockDate: harness.clock.now() + 1_000
    });

    const response = await server().post(`/api/sessions/${created.body.id}/cancel`);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NOT_CANCELLABLE');
  });

  it('404s an unknown session', async () => {
    expect((await server().post('/api/sessions/cs_nope/cancel')).status).toBe(404);
  });
});

describe('GET /api/tokens', () => {
  it('lists the accepted tokens with their decimals', async () => {
    const response = await server().get('/api/tokens').set(auth);
    expect(response.status).toBe(200);
    expect(response.body.network).toBe('test');
    expect(response.body.tokens).toEqual([
      { ticker: '$USDC', address: USDC, decimals: 6, name: 'USDC', openToAnyHolder: true },
      expect.objectContaining({ ticker: '$KTA', decimals: 18 }),
      expect.objectContaining({ ticker: '$EURC', decimals: 6 })
    ]);
  });

  it('does not offer a permit-listed token a shopper could not pay with', async () => {
    const response = await server().get('/api/tokens').set(auth);
    const tickers = response.body.tokens.map((token: { ticker: string }) => token.ticker);
    expect(tickers).not.toContain('USD');
  });

  it('narrows to the configured list', async () => {
    harness.app.close();
    harness = build({ acceptedTokens: ['$USDC'] });
    const response = await server().get('/api/tokens').set(auth);
    expect(response.body.tokens.map((token: { ticker: string }) => token.ticker)).toEqual(['$USDC']);
  });
});

/**
 * The event stream is tested against a real listening server and `fetch`, not
 * supertest: superagent buffers a response until it ends, so it cannot observe
 * events as they arrive and a long-lived stream simply hangs.
 */
describe('GET /api/sessions/:id/events', () => {
  let httpServer: Server;
  let origin: string;

  beforeEach(async () => {
    httpServer = harness.app.app.listen(0);
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind a port');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    httpServer.close();
    await once(httpServer, 'close');
  });

  /** Read an event stream to its end, failing fast rather than hanging. */
  async function readStream(id: string, timeoutMs = 5000): Promise<{ response: Response; events: EventPayload[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${origin}/api/sessions/${id}/events`, { signal: controller.signal });
      if (response.body === null) return { response, events: [] };

      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return { response, events: parseEvents(text) };
    } finally {
      clearTimeout(timer);
    }
  }

  it('404s an unknown session before opening a stream', async () => {
    const response = await fetch(`${origin}/api/sessions/cs_nope/events`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    await response.body?.cancel();
  });

  it('sends the current state and closes immediately on a terminal status', async () => {
    const created = await createSession();
    const id = created.body.id as string;
    await server().post(`/api/sessions/${id}/cancel`);

    const { response, events } = await readStream(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('cancelled');
    expect(events[0]?.id).toBe(id);
    expect(events[0]?.reference).toBeUndefined();
  });

  it('streams a later cancellation, then closes', async () => {
    const created = await createSession();
    const id = created.body.id as string;

    const pending = readStream(id);
    setTimeout(() => void harness.service.cancelSession(id), 100);

    const { events } = await pending;
    expect(events.map((event) => event.status)).toEqual(['open', 'cancelled']);
  });

  it('streams an expiry announced by the sweeper', async () => {
    const created = await createSession({ ...VALID, expiresIn: 60 });
    const id = created.body.id as string;

    const pending = readStream(id);
    setTimeout(() => {
      harness.clock.advance(61_000);
      void harness.service.sweepExpired();
    }, 100);

    const { events } = await pending;
    expect(events.map((event) => event.status)).toEqual(['open', 'expired']);
  });

  it('never leaks another session’s reference into the stream', async () => {
    // A payer's own reference is in their payment URI, which is exactly where they
    // need it. No part of another session may appear.
    const mine = await createSession();
    const theirs = await createSession();
    const id = mine.body.id as string;

    const pending = readStream(id);
    setTimeout(() => void harness.service.cancelSession(id), 100);
    const { events } = await pending;

    const payload = JSON.stringify(events);
    expect(payload).toContain(mine.body.reference);
    expect(payload).not.toContain(theirs.body.reference);
    expect(payload).not.toContain(theirs.body.id);
  });

  it('caps concurrent streams per session and releases a slot on close', async () => {
    // A session id is something anyone who reaches a checkout can mint, so the
    // number of sockets one can pin open has to be bounded somewhere.
    const created = await createSession();
    const id = created.body.id as string;

    const controllers: AbortController[] = [];
    const open = async (): Promise<Response> => {
      const controller = new AbortController();
      controllers.push(controller);
      return fetch(`${origin}/api/sessions/${id}/events`, { signal: controller.signal });
    };

    try {
      const accepted = await Promise.all(Array.from({ length: 20 }, open));
      expect(accepted.every((response) => response.status === 200)).toBe(true);

      const refused = await open();
      expect(refused.status).toBe(429);
      const body = (await refused.json()) as { error: { type: string; code: string } };
      expect(body.error.type).toBe('rate_limit_error');
      expect(body.error.code).toBe('TOO_MANY_STREAMS');

      // Dropping one must free exactly one, or a shopper reloading their pay page
      // twenty times would lock themselves out of their own session for good.
      controllers[0]?.abort();
      await vi.waitFor(async () => {
        const retry = await open();
        expect(retry.status).toBe(200);
        await retry.body?.cancel();
      });
    } finally {
      for (const controller of controllers) controller.abort();
    }
  });

  it('sets nosniff and no-referrer on the JSON API, not just the pay page', async () => {
    // Session ids travel in these URLs, and a JSON body a browser sniffs as HTML is
    // an XSS in waiting. Checked on an error response too: the headers go on in
    // middleware precisely so no route or error path can forget them.
    const ok = await server().get('/health');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');

    const missing = await server().get('/api/sessions/cs_nope');
    expect(missing.status).toBe(404);
    expect(missing.headers['x-content-type-options']).toBe('nosniff');
    expect(missing.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('GET /api/payments', () => {
  it('needs the merchant key', async () => {
    expect((await server().get('/api/payments')).status).toBe(401);
  });

  it('creates a refund for a refundable payment, once per payment, then lists it', async () => {
    const created = await createSession();
    const session = await harness.service.getSession(created.body.id as string);
    const base = {
      from: 'keeta_payer',
      to: session.receivingAddress,
      tokenAddress: session.tokenAddress,
      external: session.reference,
      blockDate: harness.clock.now() + 1_000
    };
    await harness.service.processPayment({ ...base, blockHash: 'RB1', operationIndex: 0, amount: 1n }); // underpaid

    const made = await server().post('/api/payments/RB1/refund').set(auth).send({});
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      paymentBlockHash: 'RB1',
      paymentOperationIndex: 0,
      to: 'keeta_payer',
      tokenAddress: session.tokenAddress,
      amount: '1',
      reason: 'underpaid',
      origin: 'api',
      status: 'requested',
      sessionId: session.id,
      blockHash: null
    });
    expect(made.body.id).toMatch(/^rf_/);
    // Placed on its order, and readable without knowing the token's decimals.
    expect(made.body.orderId).toBe(session.orderId);
    expect(made.body.tokenTicker).toBe(session.tokenTicker);
    expect(made.body.amountDecimal).toBe(formatBaseUnits(1n, session.tokenDecimals));

    // A second request for the same payment returns the same row, with 200.
    const again = await server().post('/api/payments/RB1/refund').set(auth).send({});
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(made.body.id);

    const list = await server().get('/api/refunds').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.refunds).toHaveLength(1);
    expect(list.body.refunds[0].id).toBe(made.body.id);

    const bySession = await server().get(`/api/refunds?sessionId=${session.id}`).set(auth);
    expect(bySession.body.refunds.map((r: { id: string }) => r.id)).toEqual([made.body.id]);
    const byStatus = await server().get('/api/refunds?status=published').set(auth);
    expect(byStatus.body.refunds).toEqual([]);
  });

  it('refuses to refund a matched payment, an unknown one, and needs the key', async () => {
    const created = await createSession();
    const session = await harness.service.getSession(created.body.id as string);
    await harness.service.processPayment({
      from: 'keeta_payer',
      to: session.receivingAddress,
      tokenAddress: session.tokenAddress,
      external: session.reference,
      blockDate: harness.clock.now() + 1_000,
      blockHash: 'RBM',
      operationIndex: 0,
      amount: session.amount // exact: matched, not refundable
    });

    const matched = await server().post('/api/payments/RBM/refund').set(auth).send({});
    expect(matched.status).toBe(400);
    expect(matched.body.error.code).toBe('NOT_REFUNDABLE');

    const missing = await server().post('/api/payments/NOPE/refund').set(auth).send({});
    expect(missing.status).toBe(404);

    const noKey = await server().post('/api/payments/RBM/refund').send({});
    expect(noKey.status).toBe(401);

    const badIndex = await server().post('/api/payments/RBM/refund').set(auth).send({ operationIndex: -1 });
    expect(badIndex.status).toBe(400);
    expect(badIndex.body.error.code).toBe('OPERATION_INDEX_INVALID');
  });

  it('lists the ledger with amounts as strings and a refundable flag', async () => {
    const created = await createSession();
    const session = await harness.service.getSession(created.body.id as string);
    const base = {
      from: 'keeta_payer',
      to: session.receivingAddress,
      tokenAddress: session.tokenAddress,
      external: session.reference,
      blockDate: harness.clock.now() + 1_000
    };
    await harness.service.processPayment({ ...base, blockHash: 'B1', operationIndex: 0, amount: 1n });
    await harness.service.processPayment({ ...base, blockHash: 'B2', operationIndex: 0, amount: session.amount });

    const all = await server().get('/api/payments').set(auth);
    expect(all.status).toBe(200);
    expect(all.body.payments).toHaveLength(2);
    const underpaid = all.body.payments.find((p: { blockHash: string }) => p.blockHash === 'B1');
    expect(underpaid).toMatchObject({ disposition: 'underpaid', refundable: true, amount: '1', sessionId: session.id });
    expect(underpaid.explorerUrl).toBe('https://explorer.test.keeta.com/block/B1');

    const only = await server().get('/api/payments?disposition=underpaid').set(auth);
    expect(only.body.payments.map((p: { blockHash: string }) => p.blockHash)).toEqual(['B1']);

    const bad = await server().get('/api/payments?limit=0').set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe('limit');
  });
});

describe('GET /pay/:id', () => {
  it('serves the pay page to anyone holding the session id', async () => {
    const created = await createSession();
    const response = await server().get(`/pay/${created.body.id}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('12.5');
    expect(response.text).toContain('$USDC');
    expect(response.text).toContain('order-1001');
  });

  it('sets a nonce-based policy and no-store, and never reuses a nonce', async () => {
    const created = await createSession();
    const first = await server().get(`/pay/${created.body.id}`);
    const second = await server().get(`/pay/${created.body.id}`);

    const csp = first.headers['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    expect(first.headers['x-content-type-options']).toBe('nosniff');

    const nonceOf = (value: string): string => /'nonce-([^']+)'/.exec(value)?.[1] ?? '';
    expect(nonceOf(csp)).not.toBe('');
    expect(nonceOf(csp)).not.toBe(nonceOf(second.headers['content-security-policy'] ?? ''));
    // The nonce in the header is the one on the inline blocks.
    expect(first.text).toContain(`<script nonce="${nonceOf(csp)}">`);
  });

  it('404s an unknown session', async () => {
    expect((await server().get('/pay/cs_nope')).status).toBe(404);
  });

  it('reflects the status, so a paid session shows as paid', async () => {
    const created = await createSession();
    await harness.store.markPaid(created.body.id, {
      paidBy: 'keeta_payer',
      blockHash: 'b1',
      operationIndex: 0,
      received: 12_500_000n,
      blockDate: harness.clock.now() + 1_000
    });

    const response = await server().get(`/pay/${created.body.id}`);
    expect(response.text).toContain('Paid');
    expect(response.text).not.toContain('qr.svg');
  });

  it('does not escape into markup with a hostile order id', async () => {
    const created = await createSession({ ...VALID, orderId: '"><script>alert(1)</script>' });
    const response = await server().get(`/pay/${created.body.id}`);

    expect(response.text).not.toContain('<script>alert(1)</script>');
    expect(response.text.match(/<script/g)).toHaveLength(1);
  });
});

describe('POST /pay/:id/cancel', () => {
  it('cancels and sends the shopper back to the cart, with no JavaScript', async () => {
    const created = await createSession();
    const response = await server().post(`/pay/${created.body.id}/cancel`).send('');

    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('https://shop.example/cart');
    expect((await harness.service.getSession(created.body.id as string)).status).toBe('cancelled');
  });

  it('sends an already-paid shopper to the success page instead of erroring', async () => {
    const created = await createSession();
    await harness.store.markPaid(created.body.id, {
      paidBy: 'keeta_payer',
      blockHash: 'b1',
      operationIndex: 0,
      received: 12_500_000n,
      blockDate: harness.clock.now() + 1_000
    });

    const response = await server().post(`/pay/${created.body.id}/cancel`).send('');
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe('https://shop.example/thanks');
  });

  it('404s an unknown session', async () => {
    expect((await server().post('/pay/cs_nope/cancel').send('')).status).toBe(404);
  });
});

describe('hostedUrl', () => {
  it('is absolute when the server knows its public URL', async () => {
    const created = await createSession();
    expect(created.body.hostedUrl).toBe(`https://shop.example/pay/${created.body.id}`);
  });

  it('is null when it does not', async () => {
    harness.app.close();
    harness = build({ publicUrl: undefined });
    const created = await createSession();
    expect(created.body.hostedUrl).toBeNull();
  });
});

describe('GET /api/webhook-deliveries', () => {
  it('needs the merchant key', async () => {
    expect((await server().get('/api/webhook-deliveries')).status).toBe(401);
  });

  it('lists what was sent, without the payload or any secret', async () => {
    const created = await createSession();
    const session = await harness.service.getSession(created.body.id as string);
    const dispatcher = new WebhookDispatcher({
      service: harness.service,
      config: {
        ...harness.service.config,
        webhookEndpoints: [{ url: 'https://shop.example/hooks', secret: 'whsec_http_000000000000', events: [...WEBHOOK_EVENT_TYPES] }]
      },
      fetchImpl: () => Promise.resolve(new Response(null, { status: 500 })),
      now: harness.clock.now,
      jitter: 0,
      log: { error: () => undefined, warn: () => undefined }
    });
    dispatcher.start(0);
    try {
      await harness.service.cancelSession(session.id);
      await dispatcher.settled();
      await dispatcher.flush();
    } finally {
      await dispatcher.stop();
    }

    const response = await server().get('/api/webhook-deliveries').set(auth);
    expect(response.status).toBe(200);
    expect(response.body.deliveries).toHaveLength(1);

    const delivery = response.body.deliveries[0];
    expect(delivery).toMatchObject({
      eventType: 'checkout.session.cancelled',
      endpointUrl: 'https://shop.example/hooks',
      status: 'pending',
      attempts: 1,
      lastStatusCode: 500
    });
    expect(delivery.nextAttemptAt).toEqual(expect.any(String));
    expect(delivery.payload).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('whsec_http');

    expect((await server().get('/api/webhook-deliveries?status=delivered').set(auth)).body.deliveries).toEqual([]);
    expect((await server().get(`/api/webhook-deliveries?eventId=${delivery.eventId}`).set(auth)).body.deliveries).toHaveLength(1);

    const bad = await server().get('/api/webhook-deliveries?limit=0').set(auth);
    expect(bad.status).toBe(400);
    expect(bad.body.error.param).toBe('limit');
  });
});

describe('unknown routes', () => {
  it('404s with the standard error shape', async () => {
    const response = await server().get('/api/nothing-here');
    expect(response.status).toBe(404);
    expect(response.body.error.type).toBe('not_found_error');
    expect(response.body.error.message).toContain('/api/nothing-here');
  });

  it('does not advertise the server technology', async () => {
    const response = await server().get('/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

interface EventPayload {
  id: string;
  status: string;
  reference?: string;
}

function parseEvents(text: string): EventPayload[] {
  return text
    .split('\n\n')
    .map((block) => /^data: (.*)$/m.exec(block)?.[1])
    .filter((data): data is string => data !== undefined)
    .map((data) => JSON.parse(data) as EventPayload);
}

