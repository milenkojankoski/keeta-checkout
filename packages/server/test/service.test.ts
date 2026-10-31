import { describe, expect, it } from 'vitest';
import { CheckoutError } from '../src/errors.ts';
import { CheckoutService } from '../src/sessions/service.ts';
import { MemorySessionStore } from '../src/sessions/store.ts';
import { isValidExternal } from '../src/sessions/refs.ts';
import { API_KEY, EURC, FIAT_USD, FakeClock, KTA, MERCHANT_ADDRESS, USDC, fakeRegistry, testConfig } from './support/fakes.ts';
import type { CheckoutConfigInput } from '../src/config.ts';

function build(configOverrides: Partial<CheckoutConfigInput> = {}) {
  const clock = new FakeClock();
  const store = new MemorySessionStore();
  const service = new CheckoutService({
    config: testConfig(configOverrides),
    store,
    tokens: fakeRegistry(),
    now: clock.now
  });
  return { clock, store, service };
}

const VALID = {
  amount: '12.50',
  currency: '$USDC',
  orderId: 'order-1001',
  successUrl: 'https://shop.example/thanks',
  cancelUrl: 'https://shop.example/cart'
};

async function expectInvalid(promise: Promise<unknown>, code: string, param?: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error, `expected ${code}`).toBeInstanceOf(CheckoutError);
  const checkoutError = error as CheckoutError;
  expect(checkoutError.code).toBe(code);
  expect(checkoutError.type).toBe('invalid_request_error');
  if (param !== undefined) expect(checkoutError.param).toBe(param);
}

describe('createSession', () => {
  it('prices the session in the resolved token, in base units', async () => {
    const { service, clock } = build();
    const session = await service.createSession(VALID);

    expect(session.amount).toBe(12_500_000n); // 12.50 at 6 decimals
    expect(session.tokenAddress).toBe(USDC);
    expect(session.tokenTicker).toBe('$USDC');
    expect(session.tokenDecimals).toBe(6);
    expect(session.status).toBe('open');
    expect(session.receivingAddress).toBe(MERCHANT_ADDRESS);
    expect(session.network).toBe('test');
    expect(session.orderId).toBe('order-1001');
    expect(session.createdAt).toBe(clock.now());
    expect(session.expiresAt).toBe(clock.now() + 1_800_000);
    expect(session.graceUntil).toBe(session.expiresAt + 600_000);
    expect(session.paidBy).toBeNull();
    expect(session.blockHash).toBeNull();
  });

  it('gives every session an unguessable id and a chain-safe reference', async () => {
    const { service } = build();
    const a = await service.createSession(VALID);
    const b = await service.createSession(VALID);

    expect(a.id).toMatch(/^cs_[A-Za-z0-9_-]{22}$/);
    expect(a.reference).toMatch(/^kc_[A-Za-z0-9_-]{22}$/);
    expect(a.id).not.toBe(b.id);
    expect(a.reference).not.toBe(b.reference);
    expect(isValidExternal(a.reference)).toBe(true);
  });

  it('never puts the merchant order id into the on-chain reference', async () => {
    const { service } = build();
    const session = await service.createSession({ ...VALID, orderId: 'order-1001' });
    expect(session.reference).not.toContain('order-1001');
  });

  it('trims surrounding whitespace before parsing', async () => {
    const { service } = build();
    const session = await service.createSession({
      amount: '  12.50  ',
      currency: '  $USDC ',
      orderId: '  order-2  ',
      successUrl: ' https://shop.example/thanks ',
      cancelUrl: ' https://shop.example/cart '
    });
    expect(session.amount).toBe(12_500_000n);
    expect(session.orderId).toBe('order-2');
    expect(session.successUrl).toBe('https://shop.example/thanks');
  });

  it('is exact at 18 decimals', async () => {
    const { service } = build();
    const session = await service.createSession({ ...VALID, amount: '0.000000000000000001', currency: '$KTA' });
    expect(session.amount).toBe(1n);
    expect(session.tokenAddress).toBe(KTA);
  });

  it('rejects a zero amount', async () => {
    const { service } = build();
    await expectInvalid(service.createSession({ ...VALID, amount: '0' }), 'AMOUNT_NOT_POSITIVE', 'amount');
    await expectInvalid(service.createSession({ ...VALID, amount: '0.00' }), 'AMOUNT_NOT_POSITIVE', 'amount');
    await expectInvalid(service.createSession({ ...VALID, amount: '0.0000000' }), 'AMOUNT_NOT_POSITIVE', 'amount');
  });

  it('rejects an amount finer than the token allows, rather than rounding it', async () => {
    const { service } = build();
    await expectInvalid(service.createSession({ ...VALID, amount: '1.0000001' }), 'TOO_MANY_DECIMALS', 'amount');
  });

  it('rejects a malformed amount', async () => {
    const { service } = build();
    for (const amount of ['-1', '1e3', '1,50', 'abc', '.5', '']) {
      const code = amount === '' ? 'FIELD_REQUIRED' : 'INVALID_FORMAT';
      await expectInvalid(service.createSession({ ...VALID, amount }), code, 'amount');
    }
  });

  it('rejects an unknown token and names what is available', async () => {
    const { service } = build();
    const error = await service.createSession({ ...VALID, currency: '$NOPE' }).catch((e: unknown) => e);
    expect((error as CheckoutError).code).toBe('TOKEN_NOT_FOUND');
    expect((error as CheckoutError).param).toBe('currency');
    expect((error as CheckoutError).message).toContain('$USDC');
  });

  it('accepts a ticker case-insensitively and with or without the $', async () => {
    const { service } = build();
    for (const currency of ['$USDC', 'usdc', '$usdc', 'USDC']) {
      expect((await service.createSession({ ...VALID, currency })).tokenAddress).toBe(USDC);
    }
  });

  it('accepts a token address directly', async () => {
    const { service } = build();
    expect((await service.createSession({ ...VALID, currency: USDC })).tokenAddress).toBe(USDC);
  });

  it('enforces the merchant accepted-token list', async () => {
    const { service } = build({ acceptedTokens: ['$USDC'] });
    expect((await service.createSession({ ...VALID, currency: '$USDC' })).tokenAddress).toBe(USDC);

    const error = await service.createSession({ ...VALID, currency: '$EURC' }).catch((e: unknown) => e);
    expect((error as CheckoutError).code).toBe('TOKEN_NOT_ACCEPTED');
    expect((error as CheckoutError).message).toContain('$USDC');
  });

  it('accepts anything the resolver lists when no list is configured', async () => {
    const { service } = build({ acceptedTokens: [] });
    expect((await service.createSession({ ...VALID, currency: '$EURC' })).tokenAddress).toBe(EURC);
  });

  it('requires every mandatory field', async () => {
    const { service } = build();
    for (const field of ['amount', 'currency', 'orderId', 'successUrl', 'cancelUrl'] as const) {
      await expectInvalid(service.createSession({ ...VALID, [field]: '' }), 'FIELD_REQUIRED', field);
      await expectInvalid(service.createSession({ ...VALID, [field]: '   ' }), 'FIELD_REQUIRED', field);
    }
  });

  it('requires absolute http or https return URLs', async () => {
    const { service } = build();
    for (const url of ['/thanks', 'shop.example/thanks', 'javascript:alert(1)', 'ftp://shop.example']) {
      await expectInvalid(service.createSession({ ...VALID, successUrl: url }), 'URL_INVALID', 'successUrl');
      await expectInvalid(service.createSession({ ...VALID, cancelUrl: url }), 'URL_INVALID', 'cancelUrl');
    }
    // http is allowed, for local development.
    await expect(service.createSession({ ...VALID, successUrl: 'http://localhost:3000/ok' })).resolves.toBeDefined();
  });

  it('rejects an over-long order id', async () => {
    const { service } = build();
    await expectInvalid(
      service.createSession({ ...VALID, orderId: 'x'.repeat(256) }),
      'ORDER_ID_TOO_LONG',
      'orderId'
    );
    await expect(service.createSession({ ...VALID, orderId: 'x'.repeat(255) })).resolves.toBeDefined();
  });

  describe('expiresIn', () => {
    it('defaults to the configured lifetime', async () => {
      const { service, clock } = build({ defaultExpiresSeconds: 900 });
      const session = await service.createSession(VALID);
      expect(session.expiresAt).toBe(clock.now() + 900_000);
    });

    it('honours a caller value inside the allowed range', async () => {
      const { service, clock } = build();
      const session = await service.createSession({ ...VALID, expiresIn: 120 });
      expect(session.expiresAt).toBe(clock.now() + 120_000);
    });

    it('rejects a value outside the range or not a whole number', async () => {
      const { service } = build({ minExpiresSeconds: 60, maxExpiresSeconds: 3600 });
      await expectInvalid(service.createSession({ ...VALID, expiresIn: 59 }), 'EXPIRES_IN_OUT_OF_RANGE', 'expiresIn');
      await expectInvalid(service.createSession({ ...VALID, expiresIn: 3601 }), 'EXPIRES_IN_OUT_OF_RANGE', 'expiresIn');
      await expectInvalid(service.createSession({ ...VALID, expiresIn: 90.5 }), 'EXPIRES_IN_INVALID', 'expiresIn');
    });
  });
});

describe('getSession', () => {
  it('reports a missing session as not found', async () => {
    const { service } = build();
    const error = await service.getSession('cs_nope').catch((e: unknown) => e);
    expect((error as CheckoutError).type).toBe('not_found_error');
    expect((error as CheckoutError).status).toBe(404);
  });

  it('expires a session on read once its deadline passes', async () => {
    const { service, clock } = build();
    const session = await service.createSession({ ...VALID, expiresIn: 60 });
    expect((await service.getSession(session.id)).status).toBe('open');

    clock.advance(59_000);
    expect((await service.getSession(session.id)).status).toBe('open');

    clock.advance(1_001);
    expect((await service.getSession(session.id)).status).toBe('expired');
  });

  it('persists the expiry, so a later read agrees', async () => {
    const { service, clock, store } = build();
    const session = await service.createSession({ ...VALID, expiresIn: 60 });
    clock.advance(61_000);
    await service.getSession(session.id);
    expect((await store.get(session.id))?.status).toBe('expired');
  });

  it('leaves a paid session alone after its deadline', async () => {
    const { service, clock, store } = build();
    const session = await service.createSession({ ...VALID, expiresIn: 60 });
    await store.markPaid(session.id, {
      paidBy: 'keeta_payer',
      blockHash: 'b1',
      operationIndex: 0,
      received: session.amount,
      blockDate: Date.UTC(2026, 9, 30, 12, 0, 1)
    });

    clock.advance(600_000);
    expect((await service.getSession(session.id)).status).toBe('paid');
  });
});

describe('cancelSession', () => {
  it('cancels an open session and is idempotent', async () => {
    const { service } = build();
    const session = await service.createSession(VALID);
    expect((await service.cancelSession(session.id)).status).toBe('cancelled');
    expect((await service.cancelSession(session.id)).status).toBe('cancelled');
  });

  it('refuses to cancel a paid session, as a conflict', async () => {
    const { service, store } = build();
    const session = await service.createSession(VALID);
    await store.markPaid(session.id, {
      paidBy: 'keeta_payer',
      blockHash: 'b1',
      operationIndex: 0,
      received: session.amount,
      blockDate: Date.UTC(2026, 9, 30, 12, 0, 1)
    });

    const error = await service.cancelSession(session.id).catch((e: unknown) => e);
    expect((error as CheckoutError).type).toBe('conflict_error');
    expect((error as CheckoutError).code).toBe('NOT_CANCELLABLE');
    expect((error as CheckoutError).status).toBe(409);
  });

  it('refuses to cancel a session that already expired', async () => {
    const { service, clock } = build();
    const session = await service.createSession({ ...VALID, expiresIn: 60 });
    clock.advance(61_000);

    const error = await service.cancelSession(session.id).catch((e: unknown) => e);
    expect((error as CheckoutError).code).toBe('NOT_CANCELLABLE');
    expect((error as CheckoutError).message).toContain('expired');
  });

  it('reports a missing session', async () => {
    const { service } = build();
    await expect(service.cancelSession('cs_nope')).rejects.toMatchObject({ type: 'not_found_error' });
  });
});

describe('change events', () => {
  it('announces a cancellation to a subscriber', async () => {
    const { service } = build();
    const session = await service.createSession(VALID);

    const seen: string[] = [];
    const unsubscribe = service.onSessionChange(session.id, ({ session: changed }) => seen.push(changed.status));

    await service.cancelSession(session.id);
    expect(seen).toEqual(['cancelled']);

    unsubscribe();
    await service.cancelSession(session.id);
    expect(seen).toEqual(['cancelled']);
  });

  it('announces an expiry found by the sweeper', async () => {
    const { service, clock } = build();
    const session = await service.createSession({ ...VALID, expiresIn: 60 });

    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: changed }) => seen.push(changed.status));

    clock.advance(61_000);
    expect(await service.sweepExpired()).toBe(1);
    expect(seen).toEqual(['expired']);

    // A second sweep finds nothing and announces nothing.
    expect(await service.sweepExpired()).toBe(0);
    expect(seen).toEqual(['expired']);
  });

  it('announces an expiry found on read', async () => {
    const { service, clock } = build();
    const session = await service.createSession({ ...VALID, expiresIn: 60 });
    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: changed }) => seen.push(changed.status));

    clock.advance(61_000);
    await service.getSession(session.id);
    expect(seen).toEqual(['expired']);
  });

  it('keeps one session’s events away from another', async () => {
    const { service } = build();
    const a = await service.createSession(VALID);
    const b = await service.createSession(VALID);

    const seen: string[] = [];
    service.onSessionChange(a.id, () => seen.push('a'));
    service.onSessionChange(b.id, () => seen.push('b'));

    await service.cancelSession(b.id);
    expect(seen).toEqual(['b']);
  });
});

describe('views', () => {
  it('omits the bare reference field from the payer view', async () => {
    const { service } = build();
    const session = await service.createSession(VALID);
    const view = service.toPublicView(session);

    expect(Object.keys(view)).not.toContain('reference');
  });

  it('carries this session’s reference in its payment URI, and no other session’s', async () => {
    // The payer must have their own reference: it is the instruction their wallet
    // puts on-chain. What must never happen is one payer seeing another's.
    const { service } = build();
    const mine = await service.createSession(VALID);
    const theirs = await service.createSession(VALID);

    const view = service.toPublicView(mine);
    expect(view.uri).toContain(mine.reference);
    expect(JSON.stringify(view)).not.toContain(theirs.reference);
  });

  it('gives the payer a payment URI and a QR link', async () => {
    const { service } = build();
    const session = await service.createSession(VALID);
    const view = service.toPublicView(session);

    expect(view.uri).toMatch(/^keeta:\/\//);
    expect(view.uri).toContain(`value=${session.amount}`);
    expect(view.qrSvgUrl).toBe(`https://shop.example/api/sessions/${session.id}/qr.svg`);
  });

  it('includes the reference in the merchant view', async () => {
    const { service } = build();
    const session = await service.createSession(VALID);
    expect(service.toMerchantView(session).reference).toBe(session.reference);
  });

  it('renders amounts as base units and as a readable decimal', async () => {
    const { service } = build();
    const session = await service.createSession({ ...VALID, amount: '12.50' });
    const view = service.toPublicView(session);

    expect(view.amount).toBe('12500000');
    expect(view.amountDecimal).toBe('12.5');
    expect(view.tokenDecimals).toBe(6);
  });

  it('serialises timestamps as ISO strings', async () => {
    const { service } = build();
    const session = await service.createSession(VALID);
    const view = service.toPublicView(session);

    expect(view.createdAt).toBe(new Date(session.createdAt).toISOString());
    expect(view.expiresAt).toBe(new Date(session.expiresAt).toISOString());
    expect(view.paidAt).toBeNull();
  });

  it('links to the paying block on the right explorer once paid', async () => {
    const { service, store } = build();
    const session = await service.createSession(VALID);
    expect(service.toPublicView(session).explorerUrl).toBeNull();

    const paid = await store.markPaid(session.id, {
      paidBy: 'keeta_payer',
      blockHash: 'abc123',
      operationIndex: 0,
      received: session.amount + 1n,
      blockDate: Date.UTC(2026, 9, 30, 12, 0, 1)
    });
    const view = service.toPublicView(paid);
    expect(view.explorerUrl).toBe('https://explorer.test.keeta.com/block/abc123');
    expect(view.overpaidBy).toBe('1');
    expect(view.paidBy).toBe('keeta_payer');
  });

  it('uses the main-network explorer when configured for main', async () => {
    const { service, store } = build({ network: 'main' });
    const session = await service.createSession(VALID);
    const paid = await store.markPaid(session.id, {
      paidBy: 'p',
      blockHash: 'xyz',
      operationIndex: 0,
      received: session.amount,
      blockDate: Date.UTC(2026, 9, 30, 12, 0, 1)
    });
    expect(service.toPublicView(paid).explorerUrl).toBe('https://explorer.keeta.com/block/xyz');
  });
});

describe('permit-listed tokens', () => {
  it('refuses to price a session in a token only approved accounts may hold', async () => {
    const { service } = build();
    const error = await service.createSession({ ...VALID, currency: 'USD' }).catch((e: unknown) => e);

    expect((error as CheckoutError).code).toBe('TOKEN_NOT_TRANSFERABLE');
    expect((error as CheckoutError).param).toBe('currency');
    expect((error as CheckoutError).message).toContain('payout');
  });

  it('refuses it by address too, not just by ticker', async () => {
    const { service } = build();
    const error = await service.createSession({ ...VALID, currency: FIAT_USD }).catch((e: unknown) => e);
    expect((error as CheckoutError).code).toBe('TOKEN_NOT_TRANSFERABLE');
  });

  it('says it is not transferable even when the merchant configured it', async () => {
    // The merchant asked for it, so "not accepted" would be a misleading answer.
    const { service } = build({ acceptedTokens: ['USD'] });
    const error = await service.createSession({ ...VALID, currency: 'USD' }).catch((e: unknown) => e);
    expect((error as CheckoutError).code).toBe('TOKEN_NOT_TRANSFERABLE');
  });

  it('leaves it out of the default accepted list', async () => {
    const { service } = build({ acceptedTokens: [] });
    const tickers = (await service.acceptedTokens()).map((token) => token.ticker);
    expect(tickers).not.toContain('USD');
  });
});

describe('acceptedTokens', () => {
  it('returns every open resolver token when unconfigured, and no permit-listed one', async () => {
    const { service } = build({ acceptedTokens: [] });
    expect((await service.acceptedTokens()).map((token) => token.ticker)).toEqual(['$USDC', '$KTA', '$EURC']);
  });

  it('returns the configured subset, in configured order, deduplicated', async () => {
    const { service } = build({ acceptedTokens: ['$EURC', 'usdc', USDC] });
    expect((await service.acceptedTokens()).map((token) => token.ticker)).toEqual(['$EURC', '$USDC']);
  });

  it('skips a configured token the resolver cannot place', async () => {
    const { service } = build({ acceptedTokens: ['$USDC', '$NOPE'] });
    expect((await service.acceptedTokens()).map((token) => token.ticker)).toEqual(['$USDC']);
  });
});

describe('API key configuration', () => {
  it('is required and must be long enough', () => {
    expect(() => testConfig({ apiKeys: [] })).toThrow(/at least one key/);
    expect(() => testConfig({ apiKeys: ['short'] })).toThrow(/at least 16 characters/);
    expect(() => testConfig({ apiKeys: [API_KEY] })).not.toThrow();
  });
});
