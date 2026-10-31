/**
 * End to end on the real Keeta test network.
 *
 * The payer wallet publishes real blocks; the server side runs exactly as it would
 * in production: a key-less client, a token registry over an unsigned resolver, and
 * the watcher polling the merchant's history. Each case waits for the watcher to
 * notice the block rather than assuming timing.
 *
 * Sessions are priced in KTA because the faucet gives nothing else. Amounts are
 * 0.001 KTA, so the 10 KTA each wallet holds lasts for many runs. Every send is
 * awaited before the next, because an account is an ordered chain.
 *
 * Skipped without both seeds in `.env.test`.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatBaseUnits } from '../src/amounts.ts';
import { resolveConfig } from '../src/config.ts';
import { parsePaymentUri } from '../src/payment-request.ts';
import { CheckoutService } from '../src/sessions/service.ts';
import { MemorySessionStore } from '../src/sessions/store.ts';
import type { Session } from '../src/sessions/types.ts';
import { TokenRegistry, type ResolvedToken } from '../src/tokens.ts';
import { PaymentWatcher } from '../src/watcher/watcher.ts';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const merchantSeed = process.env.KEETA_MERCHANT_SEED;
const payerSeed = process.env.KEETA_PAYER_SEED;
const canRun = Boolean(merchantSeed && payerSeed) && (process.env.KEETA_NETWORK ?? 'test') === 'test';

const LONG = 120_000;
const API_KEY = 'e2e_key_000000000000000000';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;

describe.skipIf(!canRun)('end to end on the Keeta test network', () => {
  const { Account } = KeetaNet.lib;
  let merchantAddress: string;
  let payerAddress: string;
  let payerClient: UserClient;
  let watchClient: UserClient;
  let store: MemorySessionStore;
  let service: CheckoutService;
  let watcher: PaymentWatcher;
  let kta: ResolvedToken;
  let price: bigint;
  let payerStart: bigint;
  let totalSent = 0n;
  let sends = 0;

  const merchantBalance = (): Promise<bigint> =>
    watchClient.client.getBalance(Account.fromPublicKeyString(merchantAddress), kta.account);
  const payerBalance = (): Promise<bigint> => payerClient.balance(kta.account);

  /** Publish one send from the payer and return the block it landed in. */
  async function pay(amount: bigint, external?: string): Promise<{ blockHash: string | undefined }> {
    const result = await payerClient.send(merchantAddress, amount, kta.account, external);
    totalSent += amount;
    sends += 1;
    // Published directly, the result carries the vote staple; through the publish
    // aid, the bare blocks. Either way the first block is the payment.
    const first: unknown = 'voteStaple' in result ? result.voteStaple.blocks[0] : result.blocks[0];
    const blockHash = typeof first === 'object' && first !== null && 'hash' in first ? String(first.hash) : undefined;
    return { blockHash };
  }

  /** Scan until the predicate holds, or fail with what was seen. */
  async function settle(what: string, predicate: () => Promise<boolean>, attempts = 40): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      const result = await watcher.scan();
      if (await predicate()) return;
      if (i === attempts - 1) {
        throw new Error(`${what} did not happen in time; last scan: ${JSON.stringify({ ...result, results: result.results.length })}`);
      }
      await sleep(1000);
    }
  }

  const createSession = (amount: bigint, svc = service): Promise<Session> =>
    svc.createSession({
      amount: formatBaseUnits(amount, kta.decimals),
      currency: '$KTA',
      orderId: `e2e-${Date.now()}`,
      successUrl: 'https://shop.example/thanks',
      cancelUrl: 'https://shop.example/cart'
    });

  beforeAll(async () => {
    merchantAddress = Account.fromSeed(merchantSeed as string, 0).publicKeyString.get();
    const payer = Account.fromSeed(payerSeed as string, 0);
    payerAddress = payer.publicKeyString.get();
    payerClient = KeetaNet.UserClient.fromNetwork('test', payer);
    // As production: no key anywhere on the server side.
    watchClient = KeetaNet.UserClient.fromNetwork('test', null);

    const tokens = new TokenRegistry({ client: watchClient });
    kta = await tokens.resolve('$KTA');
    price = 10n ** BigInt(kta.decimals - 3); // 0.001 KTA

    store = new MemorySessionStore();
    service = new CheckoutService({
      config: resolveConfig({ network: 'test', receivingAddress: merchantAddress, apiKeys: [API_KEY], acceptedTokens: ['$KTA'] }),
      store,
      tokens
    });
    watcher = new PaymentWatcher({
      service,
      history: watchClient.client,
      receivingAddress: merchantAddress,
      pageSize: 20,
      log: { error: () => undefined, warn: () => undefined }
    });

    payerStart = await payerBalance();
    if (payerStart < price * 20n) {
      throw new Error(`payer wallet holds ${formatBaseUnits(payerStart, kta.decimals)} KTA; run \`pnpm wallets:fund\` first`);
    }
  }, LONG);

  afterAll(async () => {
    await watcher?.stop();
    await payerClient?.destroy();
    await watchClient?.destroy();
  });

  it('resolves tokens through an unsigned resolver on a key-less client', () => {
    expect(kta.address).toBe(watchClient.baseToken.publicKeyString.get());
    expect(kta.ticker).toBe('$KTA');
    expect(kta.decimals).toBe(18);
    expect(kta.openToAnyHolder).toBe(true);
  });

  it(
    'credits an exact payment, and the merchant balance moves by exactly the price',
    async () => {
      const before = await merchantBalance();
      const session = await createSession(price);
      expect(parsePaymentUri(service.toPublicView(session).uri).value).toBe(price);

      const { blockHash } = await pay(price, session.reference);
      await settle('exact payment', async () => (await store.get(session.id))?.status === 'paid');

      const paid = await service.getSession(session.id);
      expect(paid.paidBy).toBe(payerAddress);
      expect(paid.operationIndex).toBe(0);
      expect(paid.blockHash).toMatch(/^[0-9A-F]{64}$/);
      if (blockHash !== undefined) expect(paid.blockHash).toBe(blockHash);
      expect(paid.overpaidBy).toBeNull();
      expect(paid.paidAt).toBeGreaterThan(session.createdAt - 10 * 60 * 1000);

      const row = await store.getPayment(paid.blockHash as string, 0);
      expect(row?.disposition).toBe('matched');
      expect(row?.sessionId).toBe(session.id);
      expect(row?.external).toBe(session.reference);

      expect((await merchantBalance()) - before).toBe(price);
    },
    LONG
  );

  it(
    'credits an overpayment and records the excess',
    async () => {
      const session = await createSession(price);
      await pay(price + 7n, session.reference);
      await settle('overpayment', async () => (await store.get(session.id))?.status === 'paid');

      const paid = await service.getSession(session.id);
      expect(paid.overpaidBy).toBe(7n);
      expect((await store.listPayments({ sessionId: session.id }))[0]?.disposition).toBe('overpaid');
    },
    LONG
  );

  it(
    'leaves an underpaid session open, then credits the full payment',
    async () => {
      const session = await createSession(price);
      await pay(price - 1n, session.reference);
      await settle(
        'underpayment to be recorded',
        async () => (await store.listPayments({ sessionId: session.id })).some((r) => r.disposition === 'underpaid')
      );
      expect((await service.getSession(session.id)).status).toBe('open');

      await pay(price, session.reference);
      await settle('full payment', async () => (await store.get(session.id))?.status === 'paid');

      const dispositions = (await store.listPayments({ sessionId: session.id })).map((r) => r.disposition).sort();
      expect(dispositions).toEqual(['matched', 'underpaid']);
    },
    LONG
  );

  it(
    'records a send with no reference and credits nothing',
    async () => {
      const openBefore = (await store.listByStatus(['open'])).map((s) => s.id);
      await pay(price, undefined);
      await settle(
        'no-reference send to be recorded',
        async () =>
          (await store.listPayments({ dispositions: ['no_reference'] })).some((r) => r.from === payerAddress && r.amount === price)
      );
      for (const id of openBefore) expect((await store.get(id))?.status).toBe('open');
    },
    LONG
  );

  it(
    'marks a second payment to a paid session as a duplicate and the session unmatched',
    async () => {
      const session = await createSession(price);
      await pay(price, session.reference);
      await settle('first payment', async () => (await store.get(session.id))?.status === 'paid');
      const original = (await store.get(session.id))?.blockHash;

      await pay(price, session.reference);
      await settle('duplicate', async () => (await store.get(session.id))?.status === 'unmatched');

      const after = await service.getSession(session.id);
      expect(after.blockHash).toBe(original); // the first payment is kept
      const dispositions = (await store.listPayments({ sessionId: session.id })).map((r) => r.disposition).sort();
      expect(dispositions).toEqual(['duplicate', 'matched']);
    },
    LONG
  );

  it(
    'records a payment to a cancelled session without reopening it',
    async () => {
      const session = await createSession(price);
      await service.cancelSession(session.id);
      await pay(price, session.reference);
      await settle(
        'payment to cancelled session',
        async () => (await store.listPayments({ sessionId: session.id })).some((r) => r.disposition === 'cancelled')
      );
      expect((await service.getSession(session.id)).status).toBe('cancelled');
    },
    LONG
  );

  it(
    'treats a payment after the grace window as late',
    async () => {
      // A second service on the same store, with a one-second lifetime and no grace.
      const strict = new CheckoutService({
        config: resolveConfig({
          network: 'test',
          receivingAddress: merchantAddress,
          apiKeys: [API_KEY],
          acceptedTokens: ['$KTA'],
          minExpiresSeconds: 1,
          defaultExpiresSeconds: 1,
          graceSeconds: 0
        }),
        store,
        tokens: new TokenRegistry({ client: watchClient })
      });
      const session = await createSession(price, strict);
      expect(session.graceUntil).toBe(session.expiresAt);

      // Well past the window, with margin for clock skew against the node.
      await sleep(6_000);
      await pay(price, session.reference);
      await settle('late payment', async () => (await store.get(session.id))?.status === 'unmatched');

      const rows = await store.listPayments({ sessionId: session.id });
      expect(rows.map((r) => r.disposition)).toEqual(['late']);
      expect(rows[0]?.blockDate).toBeGreaterThan(session.graceUntil);
    },
    LONG
  );

  it(
    'a fresh watcher over the same store re-scans without changing anything',
    async () => {
      const ledgerBefore = await store.listPayments({ limit: 1000 });
      const statusesBefore = new Map((await store.listByStatus(['open', 'paid', 'expired', 'cancelled', 'unmatched'], 1000)).map((s) => [s.id, s.status]));

      const again = new PaymentWatcher({
        service,
        history: watchClient.client,
        receivingAddress: merchantAddress,
        pageSize: 20,
        log: { error: () => undefined, warn: () => undefined }
      });
      const result = await again.scan();
      expect(result.recorded).toBe(0);

      expect(await store.listPayments({ limit: 1000 })).toHaveLength(ledgerBefore.length);
      for (const [id, status] of statusesBefore) expect((await store.get(id))?.status).toBe(status);
    },
    LONG
  );

  it('spent what it sent, plus fees', async () => {
    const payerEnd = await payerBalance();
    const spent = payerStart - payerEnd;
    const fees = spent - totalSent;
    expect(spent).toBeGreaterThanOrEqual(totalSent);
    expect(fees).toBeGreaterThanOrEqual(0n);
    // Visible in the run log, for the decision record.
    console.log(
      `e2e: ${sends} sends, ${formatBaseUnits(totalSent, kta.decimals)} KTA sent, ${formatBaseUnits(fees, kta.decimals)} KTA in fees (${formatBaseUnits(sends === 0 ? 0n : fees / BigInt(sends), kta.decimals)} per send)`
    );
  });
});
