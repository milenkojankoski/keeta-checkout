/**
 * The dispatcher against a fake endpoint: enqueueing, signing, retry backoff,
 * exhaustion, and which events reach which endpoint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv, resolveConfig, type CheckoutConfigInput } from '../src/config.ts';
import { CheckoutService } from '../src/sessions/service.ts';
import { MemorySessionStore, type ObservedPayment } from '../src/sessions/store.ts';
import { MAX_ATTEMPTS, RETRY_SCHEDULE_MS, WebhookDispatcher } from '../src/webhooks/dispatcher.ts';
import { SIGNATURE_HEADER, verifyWebhookSignature } from '../src/webhooks/signature.ts';
import { WEBHOOK_EVENT_TYPES, type WebhookEvent } from '../src/webhooks/types.ts';
import { FakeClock, MERCHANT_ADDRESS, PAYER_ADDRESS, USDC, fakeRegistry, testConfig } from './support/fakes.ts';

const SECRET = 'whsec_test_000000000000';
const URL_A = 'https://shop.example/hooks/keeta';
const URL_B = 'https://ops.example/hooks';

interface Received {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** A fake endpoint whose answer each test controls. */
class FakeEndpoint {
  received: Received[] = [];
  /** Queued responses; when empty, answers 200. */
  answers: Array<{ status?: number; throw?: string }> = [];

  fetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    this.received.push({ url, body: typeof init?.body === 'string' ? init.body : '', headers });

    const answer = this.answers.shift() ?? {};
    if (answer.throw !== undefined) return Promise.reject(new Error(answer.throw));
    const status = answer.status ?? 200;
    return Promise.resolve(new Response(null, { status }));
  };

  signatureHeader(index = 0): string | undefined {
    return this.received[index]?.headers[SIGNATURE_HEADER.toLowerCase()];
  }

  event(index = 0): WebhookEvent {
    const body = this.received[index]?.body;
    if (body === undefined) throw new Error(`no delivery at index ${index}`);
    return JSON.parse(body) as WebhookEvent;
  }
}

let dispatcher: WebhookDispatcher | undefined;

/**
 * Events enqueue their delivery rows asynchronously, so a test has to wait for that
 * before anything has been sent. `settled()` then `flush()` is what a caller does.
 */
async function drain(d: WebhookDispatcher): Promise<void> {
  await d.settled();
  await d.flush();
}

function build(overrides: Partial<CheckoutConfigInput> = {}) {
  const clock = new FakeClock();
  const store = new MemorySessionStore();
  const config = testConfig({
    webhookEndpoints: [{ url: URL_A, secret: SECRET }],
    ...overrides
  });
  const service = new CheckoutService({ config, store, tokens: fakeRegistry(), now: clock.now });
  const endpoint = new FakeEndpoint();
  dispatcher = new WebhookDispatcher({
    service,
    config,
    fetchImpl: endpoint.fetch,
    now: clock.now,
    jitter: 0,
    log: { error: () => undefined, warn: () => undefined }
  });

  const create = (amount = '12.50', expiresIn = 1800) =>
    service.createSession({
      amount,
      currency: '$USDC',
      orderId: 'order-1',
      successUrl: 'https://shop.example/thanks',
      cancelUrl: 'https://shop.example/cart',
      expiresIn
    });

  return { clock, store, service, config, endpoint, dispatcher, create };
}

afterEach(async () => {
  await dispatcher?.stop();
  dispatcher = undefined;
});

let counter = 0;
function sendTo(session: { receivingAddress: string; tokenAddress: string; amount: bigint; reference: string; createdAt: number }, overrides: Partial<ObservedPayment> = {}): ObservedPayment {
  counter += 1;
  return {
    blockHash: `BLOCK${counter}`,
    operationIndex: 0,
    from: PAYER_ADDRESS,
    to: session.receivingAddress,
    tokenAddress: session.tokenAddress,
    amount: session.amount,
    external: session.reference,
    blockDate: session.createdAt + 30_000,
    ...overrides
  };
}

describe('enqueue and send', () => {
  it('sends checkout.session.paid when a payment is credited', async () => {
    const { service, endpoint, dispatcher: d, create } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    expect(endpoint.received).toHaveLength(1);
    const event = endpoint.event();
    expect(event.type).toBe('checkout.session.paid');
    expect(event.id).toMatch(/^evt_/);
    expect(event.network).toBe('test');
    expect(event.data.session?.id).toBe(session.id);
    expect(event.data.session?.status).toBe('paid');
    expect(event.data.session?.reference).toBe(session.reference);
  });

  it('signs every delivery so the merchant helper verifies it', async () => {
    const { service, endpoint, clock, dispatcher: d, create } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    const received = endpoint.received[0];
    expect(received).toBeDefined();
    const result = verifyWebhookSignature({
      rawBody: received?.body ?? '',
      header: endpoint.signatureHeader(),
      secret: SECRET,
      nowSeconds: Math.floor(clock.now() / 1000)
    });
    expect(result.timestampSeconds).toBe(Math.floor(clock.now() / 1000));
    expect(received?.headers['content-type']).toBe('application/json');
    expect(received?.headers['keeta-checkout-event-type']).toBe('checkout.session.paid');
    expect(received?.headers['keeta-checkout-attempt']).toBe('1');
  });

  it('never puts the signing secret in the body or the headers', async () => {
    const { service, endpoint, dispatcher: d, create } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    const received = endpoint.received[0];
    expect(received?.body).not.toContain(SECRET);
    expect(JSON.stringify(received?.headers)).not.toContain(SECRET);
  });

  it('sends expired and cancelled, and nothing for a session that is merely open', async () => {
    const { service, endpoint, clock, dispatcher: d, create } = build();
    d.start(0);

    const toCancel = await create();
    await service.cancelSession(toCancel.id);

    await create('12.50', 60);
    clock.advance(61_000);
    await service.sweepExpired();

    await drain(d);
    const types = endpoint.received.map((r) => (JSON.parse(r.body) as WebhookEvent).type).sort();
    expect(types).toEqual(['checkout.session.cancelled', 'checkout.session.expired']);
  });

  it('sends session.unmatched for a duplicate payment', async () => {
    const { service, endpoint, dispatcher: d, create } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session, { blockHash: 'FIRST' }));
    await service.processPayment(sendTo(session, { blockHash: 'SECOND' }));
    await drain(d);

    const types = endpoint.received.map((r) => (JSON.parse(r.body) as WebhookEvent).type);
    expect(types).toContain('checkout.session.paid');
    expect(types).toContain('checkout.session.unmatched');
  });

  describe('checkout.payment.recorded', () => {
    it('is sent for money that could not be credited, with the refundable flag', async () => {
      const { service, endpoint, dispatcher: d, create } = build();
      d.start(0);
      const session = await create();
      await service.processPayment(sendTo(session, { amount: session.amount - 1n }));
      await drain(d);

      const event = endpoint.event();
      expect(event.type).toBe('checkout.payment.recorded');
      expect(event.data.payment?.disposition).toBe('underpaid');
      expect(event.data.payment?.refundable).toBe(true);
      expect(event.data.payment?.amount).toBe(String(session.amount - 1n));
      expect(event.data.payment?.explorerUrl).toContain('/block/');
      // The session is included when the reference named one.
      expect(event.data.session?.id).toBe(session.id);
    });

    it('is sent for a send with no reference, with no session attached', async () => {
      const { service, endpoint, dispatcher: d, create } = build();
      d.start(0);
      const session = await create();
      await service.processPayment(sendTo(session, { external: null }));
      await drain(d);

      const event = endpoint.event();
      expect(event.type).toBe('checkout.payment.recorded');
      expect(event.data.payment?.disposition).toBe('no_reference');
      expect(event.data.session).toBeUndefined();
    });

    it('is not sent for a credited payment, which already produced session.paid', async () => {
      const { service, endpoint, dispatcher: d, create } = build();
      d.start(0);
      const session = await create();
      await service.processPayment(sendTo(session));
      await drain(d);

      const types = endpoint.received.map((r) => (JSON.parse(r.body) as WebhookEvent).type);
      expect(types).toEqual(['checkout.session.paid']);
    });

    it('is not sent again when the watcher re-reads a send it already handled', async () => {
      const { service, endpoint, dispatcher: d, create } = build();
      d.start(0);
      const session = await create();
      const observed = sendTo(session, { amount: 1n });
      await service.processPayment(observed);
      await service.processPayment(observed);
      await drain(d);

      expect(endpoint.received).toHaveLength(1);
    });
  });

  it('fans one event out to every subscribed endpoint, with the same event id', async () => {
    const { service, endpoint, dispatcher: d, create } = build({
      webhookEndpoints: [
        { url: URL_A, secret: SECRET },
        { url: URL_B, secret: 'whsec_other_0000000000' }
      ]
    });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    expect(endpoint.received.map((r) => r.url).sort()).toEqual([URL_A, URL_B].sort());
    const ids = endpoint.received.map((r) => (JSON.parse(r.body) as WebhookEvent).id);
    expect(new Set(ids).size).toBe(1);
    // Each endpoint is signed with its own secret.
    const forB = endpoint.received.findIndex((r) => r.url === URL_B);
    expect(() =>
      verifyWebhookSignature({
        rawBody: endpoint.received[forB]?.body ?? '',
        header: endpoint.signatureHeader(forB),
        secret: 'whsec_other_0000000000',
        nowSeconds: Math.floor(Date.UTC(2026, 9, 30, 12, 0, 0) / 1000)
      })
    ).not.toThrow();
  });

  it('respects a narrowed event list per endpoint', async () => {
    const { service, endpoint, dispatcher: d, create } = build({
      webhookEndpoints: [
        { url: URL_A, secret: SECRET, events: ['checkout.payment.recorded'] },
        { url: URL_B, secret: 'whsec_other_0000000000', events: ['checkout.session.paid'] }
      ]
    });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session, { amount: 1n })); // underpaid
    await service.processPayment(sendTo(session)); // paid
    await drain(d);

    const byUrl = new Map(endpoint.received.map((r) => [r.url, (JSON.parse(r.body) as WebhookEvent).type]));
    expect(byUrl.get(URL_A)).toBe('checkout.payment.recorded');
    expect(byUrl.get(URL_B)).toBe('checkout.session.paid');
    expect(endpoint.received).toHaveLength(2);
  });

  it('sends nothing with no endpoints configured, and still records nothing', async () => {
    const { service, endpoint, store, dispatcher: d, create } = build({ webhookEndpoints: [] });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    expect(endpoint.received).toEqual([]);
    expect(await store.listDeliveries()).toEqual([]);
  });
});

describe('retries', () => {
  it('marks a 2xx delivered on the first attempt', async () => {
    const { service, store, dispatcher: d, create, clock } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    const [delivery] = await store.listDeliveries();
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastStatusCode).toBe(200);
    expect(delivery?.deliveredAt).toBe(clock.now());
    expect(delivery?.lastError).toBeNull();
  });

  it('accepts any 2xx, including 204', async () => {
    const { service, endpoint, store, dispatcher: d, create } = build();
    endpoint.answers.push({ status: 204 });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    expect((await store.listDeliveries())[0]?.status).toBe('delivered');
  });

  it('retries a 500 on the scheduled backoff, then succeeds', async () => {
    const { service, endpoint, store, clock, dispatcher: d, create } = build();
    endpoint.answers.push({ status: 500 });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    let [delivery] = await store.listDeliveries();
    expect(delivery?.status).toBe('pending');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastStatusCode).toBe(500);
    expect(delivery?.lastError).toContain('500');
    expect(delivery?.nextAttemptAt).toBe(clock.now() + (RETRY_SCHEDULE_MS[0] as number));

    // Not due yet.
    expect(await d.flush()).toBe(0);
    expect(endpoint.received).toHaveLength(1);

    clock.advance(RETRY_SCHEDULE_MS[0] as number);
    expect(await d.flush()).toBe(1);
    [delivery] = await store.listDeliveries();
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempts).toBe(2);
    expect(endpoint.received[1]?.headers['keeta-checkout-attempt']).toBe('2');
  });

  it('retries a thrown network error', async () => {
    const { service, endpoint, store, dispatcher: d, create } = build();
    endpoint.answers.push({ throw: 'ECONNREFUSED' });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    const [delivery] = await store.listDeliveries();
    expect(delivery?.status).toBe('pending');
    expect(delivery?.lastError).toContain('ECONNREFUSED');
    expect(delivery?.lastStatusCode).toBeNull();
  });

  it('sends the identical bytes on every retry, so the signature stays valid', async () => {
    const { service, endpoint, clock, dispatcher: d, create } = build();
    endpoint.answers.push({ status: 500 });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    clock.advance(RETRY_SCHEDULE_MS[0] as number);
    await d.flush();

    expect(endpoint.received[1]?.body).toBe(endpoint.received[0]?.body);
    // A new timestamp, so a new signature, over the same body.
    expect(endpoint.signatureHeader(1)).not.toBe(endpoint.signatureHeader(0));
    expect(() =>
      verifyWebhookSignature({
        rawBody: endpoint.received[1]?.body ?? '',
        header: endpoint.signatureHeader(1),
        secret: SECRET,
        nowSeconds: Math.floor(clock.now() / 1000)
      })
    ).not.toThrow();
  });

  it('gives up after the full schedule and marks the delivery exhausted', async () => {
    const { service, endpoint, store, clock, dispatcher: d, create } = build();
    for (let i = 0; i < MAX_ATTEMPTS; i++) endpoint.answers.push({ status: 503 });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    for (const delay of RETRY_SCHEDULE_MS) {
      clock.advance(delay);
      await d.flush();
    }

    const [delivery] = await store.listDeliveries();
    expect(delivery?.status).toBe('exhausted');
    expect(delivery?.attempts).toBe(MAX_ATTEMPTS);
    expect(endpoint.received).toHaveLength(MAX_ATTEMPTS);

    // And it is not tried again.
    clock.advance(86_400_000);
    expect(await d.flush()).toBe(0);
  });

  it('spans about 24 hours across the whole schedule', () => {
    const total = RETRY_SCHEDULE_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThan(20 * 3_600_000);
    expect(total).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('leases a claimed delivery so a concurrent dispatcher does not resend it', async () => {
    const { service, store, clock, dispatcher: d, create } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await d.settled(); // queued, not yet sent

    // One dispatcher claims it and has not reported a result yet.
    const claimed = await store.claimDueDeliveries(clock.now(), 10, clock.now() + 60_000);
    expect(claimed).toHaveLength(1);

    // A second claim in the same moment finds nothing: the lease pushed it out.
    expect(await store.claimDueDeliveries(clock.now(), 10, clock.now() + 60_000)).toEqual([]);
    // So a flush by the other dispatcher sends nothing.
    expect(await d.flush()).toBe(0);

    // Once the lease expires without a result, it becomes due again. At-least-once
    // delivery is what makes that safe.
    clock.advance(60_001);
    expect(await d.flush()).toBe(1);
  });

  it('drops a delivery whose endpoint was removed from the configuration', async () => {
    const { store, config, dispatcher: d, create } = build();
    const session = await create();
    // Enqueue while the endpoint exists, then remove it before sending.
    const [queued] = await d.enqueueSessionChange({ session: { ...session, status: 'paid' } });
    expect(queued).toBeDefined();
    config.webhookEndpoints.length = 0;

    await d.flush();
    const delivery = await store.getDelivery(queued?.id as string);
    expect(delivery?.status).toBe('exhausted');
    expect(delivery?.lastError).toContain('no longer configured');
  });

  it('runs one flush at a time', async () => {
    const { service, dispatcher: d, create } = build();
    const session = await create();
    await service.processPayment(sendTo(session));

    const a = d.flush();
    const b = d.flush();
    expect(b).toBe(a);
    await Promise.all([a, b]);
  });
});

describe('the delivery log', () => {
  it('records one row per endpoint and exposes the attempt history', async () => {
    const { service, store, dispatcher: d, create } = build({
      webhookEndpoints: [
        { url: URL_A, secret: SECRET },
        { url: URL_B, secret: 'whsec_other_0000000000' }
      ]
    });
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await drain(d);

    const deliveries = await store.listDeliveries();
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((row) => row.eventId)).size).toBe(1);
    expect(deliveries.map((row) => row.endpointUrl).sort()).toEqual([URL_A, URL_B].sort());

    const byEvent = await store.listDeliveries({ eventId: deliveries[0]?.eventId as string });
    expect(byEvent).toHaveLength(2);
    expect(await store.listDeliveries({ statuses: ['delivered'] })).toHaveLength(2);
    expect(await store.listDeliveries({ statuses: ['exhausted'] })).toEqual([]);
    expect(await store.listDeliveries({ statuses: [] })).toEqual([]);
    expect(await store.listDeliveries({ limit: 1 })).toHaveLength(1);
  });

  it('keeps the payload so a retry is byte-identical', async () => {
    const { service, store, dispatcher: d, create } = build();
    d.start(0);
    const session = await create();
    await service.processPayment(sendTo(session));
    await d.settled();

    const [delivery] = await store.listDeliveries();
    const parsed = JSON.parse(delivery?.payload ?? '{}') as WebhookEvent;
    expect(parsed.data.session?.id).toBe(session.id);
    expect(parsed.data.session?.status).toBe('paid');
  });
});

describe('endpoint configuration', () => {
  it('requires an absolute http or https url and a long enough secret', () => {
    const base = { network: 'test' as const, receivingAddress: MERCHANT_ADDRESS, apiKeys: ['k'.repeat(20)] };
    expect(() => resolveConfig({ ...base, webhookEndpoints: [{ url: '/hooks', secret: SECRET }] })).toThrow(/not a valid URL/);
    expect(() => resolveConfig({ ...base, webhookEndpoints: [{ url: 'ftp://x.example', secret: SECRET }] })).toThrow(/http or https/);
    expect(() => resolveConfig({ ...base, webhookEndpoints: [{ url: URL_A, secret: '' }] })).toThrow(/secret is required/);
    expect(() => resolveConfig({ ...base, webhookEndpoints: [{ url: URL_A, secret: 'short' }] })).toThrow(/16 characters/);
    expect(() => resolveConfig({ ...base, webhookEndpoints: [{ url: URL_A, secret: SECRET, events: [] }] })).toThrow(/at least one event/);
    expect(() =>
      resolveConfig({ ...base, webhookEndpoints: [{ url: URL_A, secret: SECRET, events: ['nope' as never] }] })
    ).toThrow(/unknown event/);
    expect(() =>
      resolveConfig({ ...base, webhookEndpoints: [{ url: URL_A, secret: SECRET }, { url: URL_A, secret: SECRET }] })
    ).toThrow(/listed twice/);
  });

  it('defaults an endpoint to every event', () => {
    const config = testConfig({ webhookEndpoints: [{ url: URL_A, secret: SECRET }] });
    expect(config.webhookEndpoints[0]?.events).toContain('checkout.session.paid');
    expect(config.webhookEndpoints[0]?.events).toContain('checkout.payment.recorded');
  });

  it('reads endpoints from the environment as url|secret|events, separated by semicolons', () => {
    const env: NodeJS.ProcessEnv = {
      KEETA_NETWORK: 'test',
      KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS,
      KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20),
      KEETA_CHECKOUT_WEBHOOKS: `${URL_A}|${SECRET}|checkout.session.paid,checkout.payment.recorded; ${URL_B}|whsec_other_0000000000`
    };
    const config = configFromEnv(env);

    expect(config.webhookEndpoints).toEqual([
      { url: URL_A, secret: SECRET, events: ['checkout.session.paid', 'checkout.payment.recorded'] },
      { url: URL_B, secret: 'whsec_other_0000000000', events: [...WEBHOOK_EVENT_TYPES] }
    ]);
  });

  it('rejects a malformed environment spec', () => {
    const base: NodeJS.ProcessEnv = {
      KEETA_NETWORK: 'test',
      KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS,
      KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20)
    };
    expect(() => configFromEnv({ ...base, KEETA_CHECKOUT_WEBHOOKS: URL_A })).toThrow(/url\|secret/);
    expect(() => configFromEnv({ ...base, KEETA_CHECKOUT_WEBHOOKS: `${URL_A}|s|a|b` })).toThrow(/url\|secret/);
    expect(() => configFromEnv({ ...base, KEETA_CHECKOUT_WEBHOOKS: `${URL_A}|tooshort` })).toThrow(/16 characters/);
  });

  it('sends no webhooks when the environment names none', () => {
    const config = configFromEnv({
      KEETA_NETWORK: 'test',
      KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS,
      KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20)
    });
    expect(config.webhookEndpoints).toEqual([]);
  });

  it('accepts no endpoints at all', () => {
    expect(testConfig({ webhookEndpoints: [] }).webhookEndpoints).toEqual([]);
    expect(testConfig().webhookEndpoints).toEqual([]);
  });
});

describe('the token used for pricing is irrelevant to webhooks', () => {
  it('carries the token address and decimals through to the event', async () => {
    const { service, endpoint, dispatcher: d } = build();
    d.start(0);
    const session = await service.createSession({
      amount: '1',
      currency: USDC,
      orderId: 'o',
      successUrl: 'https://s.example/ok',
      cancelUrl: 'https://s.example/no'
    });
    await service.processPayment(sendTo(session));
    await drain(d);

    const view = endpoint.event().data.session;
    expect(view?.tokenAddress).toBe(USDC);
    expect(view?.tokenDecimals).toBe(6);
    expect(view?.amount).toBe('1000000');
    expect(view?.amountDecimal).toBe('1');
  });
});
