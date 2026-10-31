/**
 * `CheckoutService.processPayment`: the matcher's verdict applied to a real store,
 * with the ledger and the events that result.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutService } from '../src/sessions/service.ts';
import { MemorySessionStore, StoreError, type ObservedPayment, type PaymentRecord } from '../src/sessions/store.ts';
import type { Session } from '../src/sessions/types.ts';
import { EURC, FakeClock, PAYER_ADDRESS, USDC, fakeRegistry, testConfig } from './support/fakes.ts';

function build() {
  const clock = new FakeClock();
  const store = new MemorySessionStore();
  const errors: string[] = [];
  const service = new CheckoutService({
    config: testConfig(),
    store,
    tokens: fakeRegistry(),
    now: clock.now,
    log: { error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')) }
  });
  const create = (amount = '12.50', expiresIn = 1800) =>
    service.createSession({
      amount,
      currency: '$USDC',
      orderId: 'o',
      successUrl: 'https://s.example/ok',
      cancelUrl: 'https://s.example/no',
      expiresIn
    });
  return { clock, store, service, create, errors };
}

let counter = 0;
function sendTo(session: Session, overrides: Partial<ObservedPayment> = {}): ObservedPayment {
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

describe('processPayment', () => {
  it('credits an exact payment, records it, and announces it', async () => {
    const { service, store, create } = build();
    const session = await create();
    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: s }) => seen.push(s.status));

    const result = await service.processPayment(sendTo(session));

    expect(result.inserted).toBe(true);
    expect(result.classification.disposition).toBe('matched');
    expect(result.session?.status).toBe('paid');
    expect(result.session?.paidBy).toBe(PAYER_ADDRESS);
    expect(result.session?.operationIndex).toBe(0);
    expect(seen).toEqual(['paid']);

    const row = await store.getPayment(result.payment.blockHash, 0);
    expect(row?.disposition).toBe('matched');
    expect(row?.sessionId).toBe(session.id);
  });

  it('records an overpayment on both the session and the ledger', async () => {
    const { service, create } = build();
    const session = await create();
    const result = await service.processPayment(sendTo(session, { amount: session.amount + 250n }));
    expect(result.classification.disposition).toBe('overpaid');
    expect(result.session?.status).toBe('paid');
    expect(result.session?.overpaidBy).toBe(250n);
    expect(result.payment.disposition).toBe('overpaid');
  });

  it('leaves an underpaid session open, then matches the full payment', async () => {
    const { service, create } = build();
    const session = await create();
    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: s }) => seen.push(s.status));

    const partial = await service.processPayment(sendTo(session, { amount: session.amount - 1n }));
    expect(partial.classification.disposition).toBe('underpaid');
    expect(partial.session?.status).toBe('open');
    expect(seen).toEqual([]);

    const full = await service.processPayment(sendTo(session));
    expect(full.classification.disposition).toBe('matched');
    expect(full.session?.status).toBe('paid');
    expect(seen).toEqual(['paid']);

    const rows = await service.store.listPayments({ sessionId: session.id });
    expect(rows.map((r) => r.disposition).sort()).toEqual(['matched', 'underpaid']);
  });

  it('is idempotent: the same send twice changes nothing and inserts nothing', async () => {
    const { service, create } = build();
    const session = await create();
    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: s }) => seen.push(s.status));

    const observed = sendTo(session);
    const first = await service.processPayment(observed);
    const again = await service.processPayment(observed);

    expect(first.inserted).toBe(true);
    expect(again.inserted).toBe(false);
    expect(again.classification.reason).toBe('already recorded');
    expect(again.session?.status).toBe('paid');
    expect(seen).toEqual(['paid']);
    expect(await service.store.listPayments()).toHaveLength(1);
  });

  it('survives a crash between the transition and the ledger write', async () => {
    // Simulate: markPaid committed, process died before recordPayment.
    const { service, store, create } = build();
    const session = await create();
    const observed = sendTo(session);
    await store.markPaid(session.id, {
      paidBy: observed.from,
      blockHash: observed.blockHash,
      operationIndex: observed.operationIndex,
      received: observed.amount,
      blockDate: observed.blockDate
    });
    expect(await store.getPayment(observed.blockHash, 0)).toBeUndefined();

    // Next scan re-reads the block.
    const result = await service.processPayment(observed);
    expect(result.inserted).toBe(true);
    expect(result.classification.disposition).toBe('matched');
    expect(result.classification.action).toBe('none'); // a replay, not a second credit
    expect(result.session?.status).toBe('paid');
    expect((await store.getPayment(observed.blockHash, 0))?.disposition).toBe('matched');
  });

  it('marks a second, different send to a paid session as duplicate and the session unmatched', async () => {
    const { service, create } = build();
    const session = await create();
    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: s }) => seen.push(s.status));

    await service.processPayment(sendTo(session, { blockHash: 'FIRST' }));
    const second = await service.processPayment(sendTo(session, { blockHash: 'SECOND' }));

    expect(second.classification.disposition).toBe('duplicate');
    expect(second.session?.status).toBe('unmatched');
    expect(second.session?.blockHash).toBe('FIRST'); // the original payment is kept
    expect(seen).toEqual(['paid', 'unmatched']);
  });

  it('treats two sends in one block as two payments', async () => {
    const { service, create } = build();
    const session = await create();
    const a = await service.processPayment(sendTo(session, { blockHash: 'SAME', operationIndex: 0 }));
    const b = await service.processPayment(sendTo(session, { blockHash: 'SAME', operationIndex: 1 }));
    expect(a.classification.disposition).toBe('matched');
    expect(b.classification.disposition).toBe('duplicate');
    expect(await service.store.listPayments()).toHaveLength(2);
  });

  it('credits a payment that settled inside the grace window of an expired session', async () => {
    const { service, create, clock } = build();
    const session = await create('12.50', 60);
    clock.advance(61_000);
    expect((await service.getSession(session.id)).status).toBe('expired');

    const result = await service.processPayment(sendTo(session, { blockDate: session.expiresAt + 1_000 }));
    expect(result.classification.disposition).toBe('matched');
    expect(result.session?.status).toBe('paid');
  });

  it('marks a payment after the grace window as late and the session unmatched', async () => {
    const { service, create, clock } = build();
    const session = await create('12.50', 60);
    clock.advance(61_000 + 600_000 + 1);
    const seen: string[] = [];
    service.onSessionChange(session.id, ({ session: s }) => seen.push(s.status));

    const result = await service.processPayment(sendTo(session, { blockDate: session.graceUntil + 1 }));
    expect(result.classification.disposition).toBe('late');
    expect(result.session?.status).toBe('unmatched');
    // The sweep inside processPayment expired it first; both changes are announced.
    expect(seen).toEqual(['expired', 'unmatched']);
  });

  it('sweeps expiry by the clock before judging, so a stale open session is handled correctly', async () => {
    const { service, store, create, clock } = build();
    const session = await create('12.50', 60);
    clock.advance(61_000 + 600_000 + 1);
    expect((await store.get(session.id))?.status).toBe('open'); // nobody read it

    const result = await service.processPayment(sendTo(session, { blockDate: session.graceUntil + 1 }));
    expect(result.classification.disposition).toBe('late');
    expect((await store.get(session.id))?.status).toBe('unmatched');
  });

  it('records a payment to a cancelled session without reopening it', async () => {
    const { service, create } = build();
    const session = await create();
    await service.cancelSession(session.id);
    const result = await service.processPayment(sendTo(session));
    expect(result.classification.disposition).toBe('cancelled');
    expect(result.session?.status).toBe('cancelled');
    expect(result.payment.sessionId).toBe(session.id);
  });

  it('records a wrong-token send against the session without touching it', async () => {
    const { service, create } = build();
    const session = await create();
    const result = await service.processPayment(sendTo(session, { tokenAddress: EURC }));
    expect(result.classification.disposition).toBe('wrong_token');
    expect(result.session?.status).toBe('open');
  });

  it('records sends with unknown or missing references with no session', async () => {
    const { service, create } = build();
    const session = await create();
    const unknown = await service.processPayment(sendTo(session, { external: 'kc_NOBODY' }));
    const none = await service.processPayment(sendTo(session, { external: null }));
    expect(unknown.classification).toMatchObject({ disposition: 'unknown_reference', sessionId: null });
    expect(none.classification).toMatchObject({ disposition: 'no_reference', sessionId: null });
    expect(unknown.session).toBeUndefined();
    expect((await service.getSession(session.id)).status).toBe('open');
  });

  it('lists refundable payments for the merchant', async () => {
    const { service, create } = build();
    const session = await create();
    await service.processPayment(sendTo(session, { amount: 1n }));
    await service.processPayment(sendTo(session));
    await service.processPayment(sendTo(session, { external: null }));

    const refundable = await service.store.listPayments({ dispositions: ['underpaid', 'no_reference'] });
    expect(refundable.map((r) => r.disposition).sort()).toEqual(['no_reference', 'underpaid']);
  });

  it('logs and still records when the store refuses a transition the matcher asked for', async () => {
    // The matcher and the store apply the same rule, so they cannot disagree in
    // practice. This covers the defensive path with a store that refuses anyway.
    class RefusingStore extends MemorySessionStore {
      override markPaid(_id: string, _payment: PaymentRecord): Promise<Session> {
        return Promise.reject(new StoreError('INVALID_TRANSITION', 'forced'));
      }
    }
    const clock = new FakeClock();
    const errors: string[] = [];
    const service = new CheckoutService({
      config: testConfig(),
      store: new RefusingStore(),
      tokens: fakeRegistry(),
      now: clock.now,
      log: { error: (...args: unknown[]) => void errors.push(args.map(String).join(' ')) }
    });
    const session = await service.createSession({
      amount: '1',
      currency: USDC,
      orderId: 'o',
      successUrl: 'https://s.example/ok',
      cancelUrl: 'https://s.example/no'
    });

    const result = await service.processPayment(sendTo(session));
    expect(result.classification.disposition).toBe('matched');
    expect(result.inserted).toBe(true); // the ledger still says the money arrived
    expect(result.session?.status).toBe('open'); // the store refused, so nothing moved
    expect(errors.some((line) => line.includes('mark-paid refused'))).toBe(true);
  });
});
