/**
 * The store contract, run twice: once against the in-memory store and once against
 * the SQLite one. Both must behave identically, because the only difference a
 * merchant should notice is whether sessions survive a restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySessionStore, StoreError, type PaymentRecord, type SessionStore } from '../src/sessions/store.ts';
import { SqliteSessionStore } from '../src/sessions/sqlite-store.ts';
import type { Session } from '../src/sessions/types.ts';
import type { WebhookDelivery } from '../src/webhooks/types.ts';
import type { NewRefund } from '../src/refunds/types.ts';
import { KTA, MERCHANT_ADDRESS, PAYER_ADDRESS, USDC } from './support/fakes.ts';

const BASE_TIME = Date.UTC(2026, 9, 30, 12, 0, 0);

let counter = 0;

function makeSession(overrides: Partial<Session> = {}): Session {
  counter += 1;
  return {
    id: `cs_test_${counter}`,
    reference: `kc_test_${counter}`,
    orderId: `order-${counter}`,
    amount: 1_500_000n,
    tokenAddress: USDC,
    tokenTicker: '$USDC',
    tokenDecimals: 6,
    receivingAddress: MERCHANT_ADDRESS,
    network: 'test',
    status: 'open',
    createdAt: BASE_TIME,
    expiresAt: BASE_TIME + 1_800_000,
    graceUntil: BASE_TIME + 2_400_000,
    successUrl: 'https://shop.example/thanks',
    cancelUrl: 'https://shop.example/cart',
    paidBy: null,
    blockHash: null,
    operationIndex: null,
    paidAt: null,
    overpaidBy: null,
    updatedAt: BASE_TIME,
    ...overrides
  };
}

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    paidBy: PAYER_ADDRESS,
    blockHash: 'block-hash-1',
    operationIndex: 0,
    received: 1_500_000n,
    blockDate: BASE_TIME + 60_000,
    ...overrides
  };
}

const implementations: Array<[string, () => SessionStore]> = [
  ['MemorySessionStore', () => new MemorySessionStore()],
  ['SqliteSessionStore', () => new SqliteSessionStore({ filename: ':memory:' })]
];

describe.each(implementations)('%s', (_name, makeStore) => {
  let store: SessionStore;

  const open = (): SessionStore => {
    store = makeStore();
    return store;
  };

  afterEach(async () => {
    await store?.close();
  });

  it('stores and reads a session back unchanged', async () => {
    const session = makeSession();
    const created = await open().create(session);
    expect(created).toEqual(session);

    const fetched = await store.get(session.id);
    expect(fetched).toEqual(session);
  });

  it('preserves bigint amounts beyond 2^63', async () => {
    // 18 decimals: a token amount this size is why amounts are not stored as INTEGER.
    const huge = 123_456_789_000_000_000_000_000_000n;
    const session = makeSession({ amount: huge, tokenAddress: KTA, tokenTicker: '$KTA', tokenDecimals: 18 });
    await open().create(session);

    const fetched = await store.get(session.id);
    expect(fetched?.amount).toBe(huge);
  });

  it('finds a session by its payment reference', async () => {
    const session = makeSession();
    await open().create(session);
    expect((await store.getByReference(session.reference))?.id).toBe(session.id);
    expect(await store.getByReference('kc_nothing')).toBeUndefined();
  });

  it('returns undefined for an unknown id', async () => {
    expect(await open().get('cs_nope')).toBeUndefined();
  });

  it('refuses a duplicate id and a duplicate reference', async () => {
    const first = makeSession();
    await open().create(first);

    await expect(store.create(makeSession({ id: first.id }))).rejects.toMatchObject({ code: 'DUPLICATE_ID' });
    await expect(store.create(makeSession({ reference: first.reference }))).rejects.toMatchObject({
      code: 'DUPLICATE_REFERENCE'
    });
  });

  it('does not let a caller mutate what the store holds', async () => {
    const session = makeSession();
    const created = await open().create(session);
    created.status = 'paid';
    created.paidBy = 'tampered';

    const fetched = await store.get(session.id);
    expect(fetched?.status).toBe('open');
    expect(fetched?.paidBy).toBeNull();
  });

  describe('markPaid', () => {
    it('records the payment and flips to paid', async () => {
      const session = makeSession();
      await open().create(session);

      const paid = await store.markPaid(session.id, payment({ operationIndex: 3 }));
      expect(paid.status).toBe('paid');
      expect(paid.paidBy).toBe(PAYER_ADDRESS);
      expect(paid.blockHash).toBe('block-hash-1');
      expect(paid.operationIndex).toBe(3);
      expect(paid.paidAt).toBe(BASE_TIME + 60_000);
      expect(paid.overpaidBy).toBeNull();
      expect(paid.updatedAt).toBe(BASE_TIME + 60_000);

      expect((await store.get(session.id))?.status).toBe('paid');
    });

    it('records an overpayment as the difference', async () => {
      const session = makeSession({ amount: 1_000_000n });
      await open().create(session);

      const paid = await store.markPaid(session.id, payment({ received: 1_250_000n }));
      expect(paid.overpaidBy).toBe(250_000n);
      expect((await store.get(session.id))?.overpaidBy).toBe(250_000n);
    });

    it('treats an exact payment as no overpayment', async () => {
      const session = makeSession({ amount: 1_000_000n });
      await open().create(session);
      expect((await store.markPaid(session.id, payment({ received: 1_000_000n }))).overpaidBy).toBeNull();
    });

    it('is idempotent for the same block', async () => {
      const session = makeSession();
      await open().create(session);

      const first = await store.markPaid(session.id, payment());
      const again = await store.markPaid(session.id, payment());
      expect(again).toEqual(first);
    });

    it('refuses a second payment from a different block', async () => {
      const session = makeSession();
      await open().create(session);
      await store.markPaid(session.id, payment({ blockHash: 'block-a' }));

      await expect(store.markPaid(session.id, payment({ blockHash: 'block-b' }))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      });
      expect((await store.get(session.id))?.blockHash).toBe('block-a');
    });

    it('refuses to pay a cancelled session', async () => {
      const cancelled = makeSession();
      await open().create(cancelled);
      await store.cancel(cancelled.id);
      await expect(store.markPaid(cancelled.id, payment())).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    it('credits an expired session when the block settled inside the grace window', async () => {
      // Deadline passed, but the payer had opened the wallet in time.
      const expired = makeSession({ expiresAt: BASE_TIME - 1, graceUntil: BASE_TIME + 600_000 });
      await open().create(expired);
      await store.expireDue(BASE_TIME);
      expect((await store.get(expired.id))?.status).toBe('expired');

      const paid = await store.markPaid(expired.id, payment({ blockDate: BASE_TIME + 60_000 }));
      expect(paid.status).toBe('paid');
      expect(paid.paidAt).toBe(BASE_TIME + 60_000);
    });

    it('refuses a payment that settled after the grace window, whatever the stored status', async () => {
      const graceUntil = BASE_TIME + 600_000;

      // Swept: reads `expired`.
      const expired = makeSession({ expiresAt: BASE_TIME - 1, graceUntil });
      await open().create(expired);
      await store.expireDue(BASE_TIME);
      await expect(store.markPaid(expired.id, payment({ blockDate: graceUntil + 1 }))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      });

      // Not swept: still reads `open`, but the block date tells the truth.
      const stale = makeSession({ expiresAt: BASE_TIME - 1, graceUntil });
      await store.create(stale);
      expect((await store.get(stale.id))?.status).toBe('open');
      await expect(store.markPaid(stale.id, payment({ blockDate: graceUntil + 1 }))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      });
      expect((await store.get(stale.id))?.status).toBe('open');

      // Exactly at the boundary is still inside.
      const edge = makeSession({ graceUntil });
      await store.create(edge);
      expect((await store.markPaid(edge.id, payment({ blockDate: graceUntil }))).status).toBe('paid');
    });

    it('treats the same block but a different operation as a different payment', async () => {
      // One block can carry two sends to the same merchant with the same reference.
      // The second is money that arrived, not a replay of the first.
      const session = makeSession();
      await open().create(session);
      await store.markPaid(session.id, payment({ blockHash: 'block-a', operationIndex: 0 }));

      await expect(store.markPaid(session.id, payment({ blockHash: 'block-a', operationIndex: 1 }))).rejects.toMatchObject({
        code: 'INVALID_TRANSITION'
      });
      const stored = await store.get(session.id);
      expect(stored?.operationIndex).toBe(0);
    });

    it('reports a missing session', async () => {
      await expect(open().markPaid('cs_nope', payment())).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });
  });

  describe('markUnmatched', () => {
    it('marks a late payment on an expired session', async () => {
      const session = makeSession({ expiresAt: BASE_TIME - 1 });
      await open().create(session);
      await store.expireDue(BASE_TIME);

      const unmatched = await store.markUnmatched(session.id, payment());
      expect(unmatched.status).toBe('unmatched');
      expect((await store.get(session.id))?.status).toBe('unmatched');
    });

    it('marks a second payment on a paid session, keeping the original payment', async () => {
      const session = makeSession();
      await open().create(session);
      await store.markPaid(session.id, payment({ blockHash: 'block-a' }));

      const unmatched = await store.markUnmatched(session.id, payment({ blockHash: 'block-b' }));
      expect(unmatched.status).toBe('unmatched');
      expect(unmatched.blockHash).toBe('block-a');
      expect(unmatched.paidBy).toBe(PAYER_ADDRESS);
    });

    it('is idempotent', async () => {
      const session = makeSession({ expiresAt: BASE_TIME - 1 });
      await open().create(session);
      await store.expireDue(BASE_TIME);
      const first = await store.markUnmatched(session.id, payment());
      expect(await store.markUnmatched(session.id, payment())).toEqual(first);
    });

    it('refuses an open or cancelled session', async () => {
      const session = makeSession();
      await open().create(session);
      await expect(store.markUnmatched(session.id, payment())).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

      await store.cancel(session.id);
      await expect(store.markUnmatched(session.id, payment())).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });
  });

  describe('cancel', () => {
    it('cancels an open session and is idempotent', async () => {
      const session = makeSession();
      await open().create(session);

      expect((await store.cancel(session.id)).status).toBe('cancelled');
      expect((await store.cancel(session.id)).status).toBe('cancelled');
    });

    it('refuses to cancel a paid session', async () => {
      const session = makeSession();
      await open().create(session);
      await store.markPaid(session.id, payment());
      await expect(store.cancel(session.id)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    });

    it('reports a missing session', async () => {
      await expect(open().cancel('cs_nope')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });
  });

  describe('expireDue', () => {
    it('expires only sessions past their deadline', async () => {
      const due = makeSession({ expiresAt: BASE_TIME - 1 });
      const exactlyNow = makeSession({ expiresAt: BASE_TIME });
      const later = makeSession({ expiresAt: BASE_TIME + 1 });
      const store0 = open();
      await store0.create(due);
      await store0.create(exactlyNow);
      await store0.create(later);

      const expired = await store.expireDue(BASE_TIME);
      expect(expired.map((session) => session.id).sort()).toEqual([due.id, exactlyNow.id].sort());
      for (const session of expired) {
        expect(session.status).toBe('expired');
        expect(session.updatedAt).toBe(BASE_TIME);
      }
      expect((await store.get(later.id))?.status).toBe('open');
    });

    it('leaves paid and cancelled sessions alone', async () => {
      const paid = makeSession({ expiresAt: BASE_TIME - 1 });
      const cancelled = makeSession({ expiresAt: BASE_TIME - 1 });
      const store0 = open();
      await store0.create(paid);
      await store0.create(cancelled);
      await store.markPaid(paid.id, payment());
      await store.cancel(cancelled.id);

      expect(await store.expireDue(BASE_TIME)).toEqual([]);
      expect((await store.get(paid.id))?.status).toBe('paid');
      expect((await store.get(cancelled.id))?.status).toBe('cancelled');
    });

    it('returns nothing on a second sweep', async () => {
      await open().create(makeSession({ expiresAt: BASE_TIME - 1 }));
      expect((await store.expireDue(BASE_TIME)).length).toBe(1);
      expect(await store.expireDue(BASE_TIME)).toEqual([]);
    });
  });

  describe('listByStatus', () => {
    it('filters by status, newest first, and honours the limit', async () => {
      const store0 = open();
      const older = makeSession({ createdAt: BASE_TIME - 1000 });
      const newer = makeSession({ createdAt: BASE_TIME });
      const cancelled = makeSession();
      await store0.create(older);
      await store0.create(newer);
      await store0.create(cancelled);
      await store.cancel(cancelled.id);

      const openOnes = await store.listByStatus(['open']);
      expect(openOnes.map((session) => session.id)).toEqual([newer.id, older.id]);

      expect((await store.listByStatus(['open'], 1)).map((s) => s.id)).toEqual([newer.id]);
      expect((await store.listByStatus(['cancelled'])).map((s) => s.id)).toEqual([cancelled.id]);
      expect(await store.listByStatus([])).toEqual([]);
      expect((await store.listByStatus(['open', 'cancelled'])).length).toBe(3);
    });
  });

  it('close() is safe to call twice', async () => {
    open();
    await store.close();
    await store.close();
  });
});

describe('SqliteSessionStore on disk', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'keeta-checkout-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps sessions across a restart, amounts and all', async () => {
    const file = join(directory, 'sessions.db');
    const session = makeSession({ amount: 2n ** 70n, tokenDecimals: 18 });

    const first = new SqliteSessionStore({ filename: file });
    await first.create(session);
    await first.markPaid(session.id, payment({ received: 2n ** 70n + 5n }));
    await first.close();

    const second = new SqliteSessionStore({ filename: file });
    try {
      const restored = await second.get(session.id);
      expect(restored?.status).toBe('paid');
      expect(restored?.amount).toBe(2n ** 70n);
      expect(restored?.overpaidBy).toBe(5n);
      expect(restored?.reference).toBe(session.reference);
    } finally {
      await second.close();
    }
  });

  it('refuses a database written by a newer schema version', async () => {
    const file = join(directory, 'future.db');
    const store = new SqliteSessionStore({ filename: file });
    await store.close();

    const db = new DatabaseSync(file);
    db.exec('UPDATE schema_version SET version = 99');
    db.close();

    expect(() => new SqliteSessionStore({ filename: file })).toThrow(/schema version 99/);
  });

  it('refuses use after close', async () => {
    const store = new SqliteSessionStore({ filename: ':memory:' });
    await store.close();
    await expect(store.get('cs_anything')).rejects.toThrow(/closed/);
  });
});

describe.each(implementations)('%s payments ledger and meta', (_name, makeStore) => {
  let store: SessionStore;
  const open = (): SessionStore => (store = makeStore());
  afterEach(async () => {
    await store?.close();
  });

  const row = (overrides: Partial<Parameters<SessionStore['recordPayment']>[0]> = {}) => ({
    blockHash: 'BLOCK1',
    operationIndex: 0,
    from: PAYER_ADDRESS,
    to: MERCHANT_ADDRESS,
    tokenAddress: USDC,
    amount: 1_500_000n,
    external: 'kc_x',
    blockDate: BASE_TIME + 60_000,
    sessionId: null,
    disposition: 'unknown_reference' as const,
    observedAt: BASE_TIME + 61_000,
    ...overrides
  });

  it('records a payment once and returns the first decision on repeats', async () => {
    const first = await open().recordPayment(row());
    expect(first.inserted).toBe(true);
    expect(first.payment.amount).toBe(1_500_000n);

    const again = await store.recordPayment(row({ disposition: 'matched', amount: 1n }));
    expect(again.inserted).toBe(false);
    expect(again.payment.disposition).toBe('unknown_reference');
    expect(again.payment.amount).toBe(1_500_000n);
  });

  it('keys on block hash and operation index together', async () => {
    await open().recordPayment(row({ operationIndex: 0 }));
    expect((await store.recordPayment(row({ operationIndex: 1 }))).inserted).toBe(true);
    expect((await store.recordPayment(row({ blockHash: 'BLOCK2' }))).inserted).toBe(true);
    expect(await store.listPayments()).toHaveLength(3);
  });

  it('round-trips bigint amounts and a null external', async () => {
    const huge = 2n ** 90n;
    await open().recordPayment(row({ amount: huge, external: null }));
    const got = await store.getPayment('BLOCK1', 0);
    expect(got?.amount).toBe(huge);
    expect(got?.external).toBeNull();
    expect(await store.getPayment('BLOCK1', 7)).toBeUndefined();
  });

  it('lists newest block first and filters by disposition and session', async () => {
    const s = open();
    await s.recordPayment(row({ blockHash: 'A', blockDate: BASE_TIME + 1, disposition: 'matched', sessionId: 'cs_1' }));
    await s.recordPayment(row({ blockHash: 'B', blockDate: BASE_TIME + 3, disposition: 'underpaid', sessionId: 'cs_1' }));
    await s.recordPayment(row({ blockHash: 'C', blockDate: BASE_TIME + 2, disposition: 'no_reference' }));

    expect((await store.listPayments()).map((r) => r.blockHash)).toEqual(['B', 'C', 'A']);
    expect((await store.listPayments({ dispositions: ['underpaid', 'no_reference'] })).map((r) => r.blockHash)).toEqual(['B', 'C']);
    expect((await store.listPayments({ sessionId: 'cs_1' })).map((r) => r.blockHash)).toEqual(['B', 'A']);
    expect((await store.listPayments({ limit: 1 })).map((r) => r.blockHash)).toEqual(['B']);
    expect(await store.listPayments({ dispositions: [] })).toEqual([]);
  });

  const delivery = (overrides: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
    id: 'whd_1',
    eventId: 'evt_1',
    eventType: 'checkout.session.paid',
    endpointUrl: 'https://shop.example/hooks',
    payload: '{"id":"evt_1"}',
    status: 'pending',
    attempts: 0,
    nextAttemptAt: BASE_TIME,
    lastError: null,
    lastStatusCode: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    deliveredAt: null,
    ...overrides
  });

  // ---- the refund ledger (docs/decisions/0014) -------------------------------

  const refundRequest = (overrides: Partial<NewRefund> = {}): NewRefund => ({
    id: 'rf_one',
    paymentBlockHash: 'B1',
    paymentOperationIndex: 0,
    sessionId: 'cs_1',
    to: PAYER_ADDRESS,
    tokenAddress: USDC,
    amount: 1_500_000n,
    reason: 'duplicate',
    origin: 'auto',
    createdAt: BASE_TIME,
    ...overrides
  });

  it('creates a refund as requested, with nothing attempted yet', async () => {
    const { created, refund } = await open().createRefund(refundRequest());
    expect(created).toBe(true);
    expect(refund).toEqual({
      ...refundRequest(),
      status: 'requested',
      attempts: 0,
      attemptStartedAt: null,
      blockHash: null,
      lastError: null,
      updatedAt: BASE_TIME,
      publishedAt: null
    });
    expect(await store.getRefund('rf_one')).toEqual(refund);
    expect(await store.getRefundForPayment('B1', 0)).toEqual(refund);
    expect(await store.getRefund('rf_nope')).toBeUndefined();
  });

  it('allows one refund per payment, whoever asks second', async () => {
    // The API retrying, the merchant clicking twice and the auto-refund path all
    // land here; whichever came second gets the first row back, unchanged.
    const first = await open().createRefund(refundRequest());
    const second = await store.createRefund(refundRequest({ id: 'rf_two', origin: 'api', amount: 999n, createdAt: BASE_TIME + 5 }));
    expect(second.created).toBe(false);
    expect(second.refund).toEqual(first.refund);
    expect(await store.listRefunds()).toHaveLength(1);
  });

  it('keeps bigint refund amounts beyond 2^63', async () => {
    const huge = 987_654_321_000_000_000_000_000_000n;
    await open().createRefund(refundRequest({ amount: huge, tokenAddress: KTA }));
    expect((await store.getRefund('rf_one'))?.amount).toBe(huge);
  });

  it('claims the oldest requested refund and marks it publishing with its attempt time', async () => {
    const s = open();
    await s.createRefund(refundRequest({ id: 'rf_newer', paymentBlockHash: 'B2', createdAt: BASE_TIME + 10 }));
    await s.createRefund(refundRequest({ id: 'rf_older', paymentBlockHash: 'B1', createdAt: BASE_TIME }));

    const claim = await s.claimNextRefund(BASE_TIME + 100);
    expect(claim?.claimed).toBe(true);
    expect(claim?.refund.id).toBe('rf_older');
    expect(claim?.refund.status).toBe('publishing');
    expect(claim?.refund.attempts).toBe(1);
    expect(claim?.refund.attemptStartedAt).toBe(BASE_TIME + 100);
    expect((await s.getRefund('rf_older'))?.status).toBe('publishing');
    expect((await s.getRefund('rf_newer'))?.status).toBe('requested');
  });

  it('refuses to claim a second refund while one is publishing', async () => {
    // Rule 6: one publish at a time per account. A row left in `publishing` by a
    // crash is handed back unclaimed, so the process reconciles it first.
    const s = open();
    await s.createRefund(refundRequest({ id: 'rf_a', paymentBlockHash: 'B1' }));
    await s.createRefund(refundRequest({ id: 'rf_b', paymentBlockHash: 'B2', createdAt: BASE_TIME + 1 }));
    await s.claimNextRefund(BASE_TIME + 100);

    const blocked = await s.claimNextRefund(BASE_TIME + 200);
    expect(blocked?.claimed).toBe(false);
    expect(blocked?.refund.id).toBe('rf_a');
    expect((await s.getRefund('rf_b'))?.status).toBe('requested');
    expect((await s.getRefund('rf_a'))?.attempts).toBe(1);
  });

  it('returns undefined when nothing is waiting', async () => {
    expect(await open().claimNextRefund(BASE_TIME)).toBeUndefined();
  });

  it('records a publish, a failure, and a reconciliation back to requested', async () => {
    const s = open();
    await s.createRefund(refundRequest({ id: 'rf_a', paymentBlockHash: 'B1' }));
    await s.claimNextRefund(BASE_TIME + 100);
    const published = await s.recordRefundResult('rf_a', { status: 'published', at: BASE_TIME + 150, blockHash: 'RB1' });
    expect(published.status).toBe('published');
    expect(published.blockHash).toBe('RB1');
    expect(published.publishedAt).toBe(BASE_TIME + 150);
    expect(published.updatedAt).toBe(BASE_TIME + 150);

    await s.createRefund(refundRequest({ id: 'rf_b', paymentBlockHash: 'B2', createdAt: BASE_TIME + 1 }));
    await s.claimNextRefund(BASE_TIME + 200);
    const failed = await s.recordRefundResult('rf_b', { status: 'failed', at: BASE_TIME + 250, lastError: 'permissions' });
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('permissions');

    await s.createRefund(refundRequest({ id: 'rf_c', paymentBlockHash: 'B3', createdAt: BASE_TIME + 2 }));
    await s.claimNextRefund(BASE_TIME + 300);
    const back = await s.recordRefundResult('rf_c', { status: 'requested', at: BASE_TIME + 400, lastError: 'nothing on chain' });
    expect(back.status).toBe('requested');
    expect(back.attemptStartedAt).toBeNull();
    expect(back.attempts).toBe(1);
    // and it can be claimed again, counting a second attempt
    const again = await s.claimNextRefund(BASE_TIME + 500);
    expect(again?.refund.id).toBe('rf_c');
    expect(again?.refund.attempts).toBe(2);
  });

  it('refuses transitions the state machine does not allow', async () => {
    const s = open();
    await s.createRefund(refundRequest({ id: 'rf_a', paymentBlockHash: 'B1' }));
    // requested -> published, skipping publishing
    await expect(s.recordRefundResult('rf_a', { status: 'published', at: BASE_TIME, blockHash: 'X' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // requested -> refused is the one allowed exit without a publish
    const refused = await s.recordRefundResult('rf_a', { status: 'refused', at: BASE_TIME + 1, lastError: 'over the daily cap' });
    expect(refused.status).toBe('refused');
    // refused is final
    await expect(s.recordRefundResult('rf_a', { status: 'requested', at: BASE_TIME + 2 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // published needs a block hash
    await s.createRefund(refundRequest({ id: 'rf_b', paymentBlockHash: 'B2' }));
    await s.claimNextRefund(BASE_TIME + 10);
    await expect(s.recordRefundResult('rf_b', { status: 'published', at: BASE_TIME + 11 })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // unknown id
    await expect(s.recordRefundResult('rf_nope', { status: 'failed', at: BASE_TIME })).rejects.toMatchObject({ code: 'REFUND_NOT_FOUND' });
  });

  it('sums what went out, counting money in flight, per token, since a time', async () => {
    const s = open();
    await s.createRefund(refundRequest({ id: 'rf_a', paymentBlockHash: 'B1', amount: 100n }));
    await s.createRefund(refundRequest({ id: 'rf_b', paymentBlockHash: 'B2', amount: 20n, createdAt: BASE_TIME + 1 }));
    await s.createRefund(refundRequest({ id: 'rf_c', paymentBlockHash: 'B3', amount: 3n, tokenAddress: KTA, createdAt: BASE_TIME + 2 }));
    await s.createRefund(refundRequest({ id: 'rf_d', paymentBlockHash: 'B4', amount: 1_000n, createdAt: BASE_TIME + 3 }));

    await s.claimNextRefund(BASE_TIME + 1_000); // rf_a
    await s.recordRefundResult('rf_a', { status: 'published', at: BASE_TIME + 1_100, blockHash: 'R1' });
    await s.claimNextRefund(BASE_TIME + 2_000); // rf_b, left publishing: in flight counts
    // rf_c is KTA, rf_d is still requested: neither counts for USDC
    expect(await s.sumRefundedSince(USDC, BASE_TIME)).toBe(120n);
    expect(await s.sumRefundedSince(USDC, BASE_TIME + 1_500)).toBe(20n);
    expect(await s.sumRefundedSince(USDC, BASE_TIME + 2_500)).toBe(0n);
    expect(await s.sumRefundedSince(KTA, BASE_TIME)).toBe(0n);
  });

  it('lists refunds newest first, filtered by status and session', async () => {
    const s = open();
    await s.createRefund(refundRequest({ id: 'rf_a', paymentBlockHash: 'B1', sessionId: 'cs_1', createdAt: BASE_TIME }));
    await s.createRefund(refundRequest({ id: 'rf_b', paymentBlockHash: 'B2', sessionId: 'cs_2', createdAt: BASE_TIME + 1 }));
    await s.createRefund(refundRequest({ id: 'rf_c', paymentBlockHash: 'B3', sessionId: 'cs_1', createdAt: BASE_TIME + 2 }));
    await s.claimNextRefund(BASE_TIME + 10); // rf_a -> publishing

    expect((await s.listRefunds()).map((r) => r.id)).toEqual(['rf_c', 'rf_b', 'rf_a']);
    expect((await s.listRefunds({ statuses: ['requested'] })).map((r) => r.id)).toEqual(['rf_c', 'rf_b']);
    expect((await s.listRefunds({ sessionId: 'cs_1' })).map((r) => r.id)).toEqual(['rf_c', 'rf_a']);
    expect((await s.listRefunds({ statuses: [] }))).toEqual([]);
    expect((await s.listRefunds({ limit: 1 })).map((r) => r.id)).toEqual(['rf_c']);
  });

  it('queues a delivery and reads it back whole', async () => {
    await open().enqueueDelivery(delivery());
    const got = await store.getDelivery('whd_1');
    expect(got).toEqual(delivery());
    expect(await store.getDelivery('whd_nope')).toBeUndefined();
  });

  it('claims only due pending deliveries, and leases them forward', async () => {
    const s = open();
    await s.enqueueDelivery(delivery({ id: 'whd_due', nextAttemptAt: BASE_TIME }));
    await s.enqueueDelivery(delivery({ id: 'whd_later', eventId: 'evt_2', nextAttemptAt: BASE_TIME + 60_000 }));
    await s.enqueueDelivery(delivery({ id: 'whd_done', eventId: 'evt_3', status: 'delivered' }));
    await s.enqueueDelivery(delivery({ id: 'whd_dead', eventId: 'evt_4', status: 'exhausted' }));

    const claimed = await store.claimDueDeliveries(BASE_TIME, 10, BASE_TIME + 20_000);
    expect(claimed.map((row) => row.id)).toEqual(['whd_due']);
    expect(claimed[0]?.nextAttemptAt).toBe(BASE_TIME + 20_000);

    // Leased: a second claim at the same moment gets nothing.
    expect(await store.claimDueDeliveries(BASE_TIME, 10, BASE_TIME + 20_000)).toEqual([]);
    // And the lease is persisted, not just returned.
    expect((await store.getDelivery('whd_due'))?.nextAttemptAt).toBe(BASE_TIME + 20_000);
  });

  it('claims oldest-due first and honours the limit', async () => {
    const s = open();
    await s.enqueueDelivery(delivery({ id: 'whd_b', nextAttemptAt: BASE_TIME - 1_000 }));
    await s.enqueueDelivery(delivery({ id: 'whd_a', eventId: 'evt_2', nextAttemptAt: BASE_TIME - 2_000 }));

    const claimed = await store.claimDueDeliveries(BASE_TIME, 1, BASE_TIME + 1_000);
    expect(claimed.map((row) => row.id)).toEqual(['whd_a']);
  });

  it('records an attempt result', async () => {
    await open().enqueueDelivery(delivery());

    const failed = await store.recordDeliveryResult('whd_1', {
      status: 'pending',
      attempts: 1,
      lastError: 'the endpoint answered 500',
      lastStatusCode: 500,
      at: BASE_TIME + 1_000,
      nextAttemptAt: BASE_TIME + 11_000
    });
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500, nextAttemptAt: BASE_TIME + 11_000 });
    expect(failed.deliveredAt).toBeNull();

    const delivered = await store.recordDeliveryResult('whd_1', {
      status: 'delivered',
      attempts: 2,
      lastError: null,
      lastStatusCode: 200,
      at: BASE_TIME + 12_000,
      deliveredAt: BASE_TIME + 12_000
    });
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2, deliveredAt: BASE_TIME + 12_000, lastError: null });
    expect((await store.getDelivery('whd_1'))?.status).toBe('delivered');
  });

  it('reports a missing delivery', async () => {
    await expect(
      open().recordDeliveryResult('whd_nope', { status: 'delivered', attempts: 1, lastError: null, lastStatusCode: 200, at: BASE_TIME })
    ).rejects.toMatchObject({ code: 'DELIVERY_NOT_FOUND' });
  });

  it('lists deliveries newest first, filtered by status and event', async () => {
    const s = open();
    await s.enqueueDelivery(delivery({ id: 'whd_old', createdAt: BASE_TIME }));
    await s.enqueueDelivery(delivery({ id: 'whd_new', eventId: 'evt_2', createdAt: BASE_TIME + 1_000, status: 'exhausted' }));

    expect((await store.listDeliveries()).map((row) => row.id)).toEqual(['whd_new', 'whd_old']);
    expect((await store.listDeliveries({ statuses: ['exhausted'] })).map((row) => row.id)).toEqual(['whd_new']);
    expect((await store.listDeliveries({ eventId: 'evt_2' })).map((row) => row.id)).toEqual(['whd_new']);
    expect((await store.listDeliveries({ limit: 1 })).map((row) => row.id)).toEqual(['whd_new']);
    expect(await store.listDeliveries({ statuses: [] })).toEqual([]);
  });

  it('stores and overwrites meta values', async () => {
    expect(await open().getMeta('cursor')).toBeUndefined();
    await store.setMeta('cursor', 'ONE');
    expect(await store.getMeta('cursor')).toBe('ONE');
    await store.setMeta('cursor', 'TWO');
    expect(await store.getMeta('cursor')).toBe('TWO');
  });
});

describe('SqliteSessionStore schema migration', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'keeta-checkout-mig-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('upgrades a version 1 database in place and keeps its sessions', async () => {
    const file = join(directory, 'v1.db');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version (version) VALUES (1);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, order_id TEXT NOT NULL, amount TEXT NOT NULL,
        token_address TEXT NOT NULL, token_ticker TEXT, token_decimals INTEGER NOT NULL, receiving_address TEXT NOT NULL,
        network TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        grace_until INTEGER NOT NULL, success_url TEXT NOT NULL, cancel_url TEXT NOT NULL, paid_by TEXT, block_hash TEXT,
        paid_at INTEGER, overpaid_by TEXT, updated_at INTEGER NOT NULL
      );
      INSERT INTO sessions VALUES ('cs_old','kc_old','o','1500000','${USDC}','$USDC',6,'${MERCHANT_ADDRESS}','test','open',
        ${BASE_TIME},${BASE_TIME + 1_800_000},${BASE_TIME + 2_400_000},'https://s/ok','https://s/no',NULL,NULL,NULL,NULL,${BASE_TIME});
    `);
    db.close();

    const store = new SqliteSessionStore({ filename: file });
    try {
      const old = await store.get('cs_old');
      expect(old?.status).toBe('open');
      expect(old?.operationIndex).toBeNull();
      // The new tables exist and work.
      await store.setMeta('k', 'v');
      expect(await store.getMeta('k')).toBe('v');
      expect((await store.recordPayment({ blockHash: 'B', operationIndex: 0, from: PAYER_ADDRESS, to: MERCHANT_ADDRESS, tokenAddress: USDC, amount: 1n, external: null, blockDate: BASE_TIME, sessionId: null, disposition: 'no_reference' })).inserted).toBe(true);
      // And the old session can now be paid with an operation index.
      const paid = await store.markPaid('cs_old', payment({ operationIndex: 2 }));
      expect(paid.operationIndex).toBe(2);
      // Version 4 added the refund ledger.
      expect((await store.createRefund({ id: 'rf_mig', paymentBlockHash: 'B', paymentOperationIndex: 0, sessionId: null, to: PAYER_ADDRESS, tokenAddress: USDC, amount: 1n, reason: 'late', origin: 'api', createdAt: BASE_TIME })).created).toBe(true);
    } finally {
      await store.close();
    }

    const check = new DatabaseSync(file);
    expect((check.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(4);
    check.close();
  });

  it('upgrades a version 2 database to the webhook queue', async () => {
    const file = join(directory, 'v2.db');
    // Build it the way version 2 shipped: sessions, payments, meta, no deliveries.
    const first = new SqliteSessionStore({ filename: file });
    await first.setMeta('watcher:newestBlocksHash', 'STAPLE1');
    await first.close();

    const down = new DatabaseSync(file);
    down.exec('DROP TABLE webhook_deliveries');
    down.exec('UPDATE schema_version SET version = 2');
    down.close();

    const upgraded = new SqliteSessionStore({ filename: file });
    try {
      // The cursor survived, and the new table works.
      expect(await upgraded.getMeta('watcher:newestBlocksHash')).toBe('STAPLE1');
      await upgraded.enqueueDelivery({
        id: 'whd_after_migration',
        eventId: 'evt_1',
        eventType: 'checkout.session.paid',
        endpointUrl: 'https://shop.example/hooks',
        payload: '{}',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: BASE_TIME,
        lastError: null,
        lastStatusCode: null,
        createdAt: BASE_TIME,
        updatedAt: BASE_TIME,
        deliveredAt: null
      });
      expect((await upgraded.listDeliveries()).map((row) => row.id)).toEqual(['whd_after_migration']);
    } finally {
      await upgraded.close();
    }
  });
});

describe('StoreError', () => {
  it('carries a machine-readable code', () => {
    const error = new StoreError('SESSION_NOT_FOUND', 'nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StoreError');
    expect(error.code).toBe('SESSION_NOT_FOUND');
  });
});
