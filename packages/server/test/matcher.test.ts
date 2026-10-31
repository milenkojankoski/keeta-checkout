/**
 * The matching rule, branch by branch. Pure function, so every case is a literal.
 */
import { describe, expect, it } from 'vitest';
import type { ObservedPayment } from '../src/sessions/store.ts';
import type { Session } from '../src/sessions/types.ts';
import { classifyPayment } from '../src/watcher/matcher.ts';
import { EURC, MERCHANT_ADDRESS, PAYER_ADDRESS, USDC } from './support/fakes.ts';

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const EXPIRES = T0 + 1_800_000;
const GRACE = EXPIRES + 600_000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'cs_A',
    reference: 'kc_REF_A',
    orderId: 'order-1',
    amount: 1_000_000n,
    tokenAddress: USDC,
    tokenTicker: '$USDC',
    tokenDecimals: 6,
    receivingAddress: MERCHANT_ADDRESS,
    network: 'test',
    status: 'open',
    createdAt: T0,
    expiresAt: EXPIRES,
    graceUntil: GRACE,
    successUrl: 'https://s.example/ok',
    cancelUrl: 'https://s.example/no',
    paidBy: null,
    blockHash: null,
    operationIndex: null,
    paidAt: null,
    overpaidBy: null,
    updatedAt: T0,
    ...overrides
  };
}

function send(overrides: Partial<ObservedPayment> = {}): ObservedPayment {
  return {
    blockHash: 'BLOCK1',
    operationIndex: 0,
    from: PAYER_ADDRESS,
    to: MERCHANT_ADDRESS,
    tokenAddress: USDC,
    amount: 1_000_000n,
    external: 'kc_REF_A',
    blockDate: T0 + 60_000,
    ...overrides
  };
}

describe('classifyPayment', () => {
  describe('sends that name no usable session', () => {
    it('no reference', () => {
      for (const external of [null, '']) {
        const c = classifyPayment(send({ external }), undefined);
        expect(c).toMatchObject({ disposition: 'no_reference', action: 'none', sessionId: null });
      }
    });

    it('no reference even when a session is somehow supplied', () => {
      const c = classifyPayment(send({ external: null }), session());
      expect(c.disposition).toBe('no_reference');
      expect(c.sessionId).toBeNull();
    });

    it('unknown reference', () => {
      const c = classifyPayment(send({ external: 'kc_NOBODY' }), undefined);
      expect(c).toMatchObject({ disposition: 'unknown_reference', action: 'none', sessionId: null });
      expect(c.reason).toContain('kc_NOBODY');
    });
  });

  describe('sends that do not fit the session they name', () => {
    it('wrong token', () => {
      const c = classifyPayment(send({ tokenAddress: EURC }), session());
      expect(c).toMatchObject({ disposition: 'wrong_token', action: 'none', sessionId: 'cs_A' });
    });

    it('wrong recipient', () => {
      const c = classifyPayment(send({ to: PAYER_ADDRESS }), session());
      expect(c).toMatchObject({ disposition: 'wrong_recipient', action: 'none', sessionId: 'cs_A' });
    });

    it('checks the token before the status, so a wrong-token send never touches a paid session', () => {
      const paid = session({ status: 'paid', blockHash: 'OTHER', operationIndex: 0 });
      const c = classifyPayment(send({ tokenAddress: EURC }), paid);
      expect(c.disposition).toBe('wrong_token');
      expect(c.action).toBe('none');
    });
  });

  describe('closed sessions', () => {
    it('cancelled stays cancelled', () => {
      const c = classifyPayment(send(), session({ status: 'cancelled' }));
      expect(c).toMatchObject({ disposition: 'cancelled', action: 'none' });
    });

    it('a paid session seeing its own send again is a replay, not a duplicate', () => {
      const paid = session({ status: 'paid', blockHash: 'BLOCK1', operationIndex: 0, overpaidBy: null });
      const c = classifyPayment(send({ blockHash: 'BLOCK1', operationIndex: 0 }), paid);
      expect(c).toMatchObject({ disposition: 'matched', action: 'none' });
    });

    it('a replay of an overpayment reports overpaid', () => {
      const paid = session({ status: 'paid', blockHash: 'BLOCK1', operationIndex: 0, overpaidBy: 5n });
      expect(classifyPayment(send(), paid).disposition).toBe('overpaid');
    });

    it('a paid session seeing a different send is a duplicate and goes unmatched', () => {
      const paid = session({ status: 'paid', blockHash: 'BLOCK1', operationIndex: 0 });
      expect(classifyPayment(send({ blockHash: 'BLOCK2' }), paid)).toMatchObject({
        disposition: 'duplicate',
        action: 'mark-unmatched'
      });
      // Same block, next operation: still a different send.
      expect(classifyPayment(send({ blockHash: 'BLOCK1', operationIndex: 1 }), paid)).toMatchObject({
        disposition: 'duplicate',
        action: 'mark-unmatched'
      });
    });

    it('an unmatched session absorbs further sends as duplicates with no action', () => {
      const c = classifyPayment(send({ blockHash: 'BLOCK9' }), session({ status: 'unmatched' }));
      expect(c).toMatchObject({ disposition: 'duplicate', action: 'none' });
    });
  });

  describe('time', () => {
    it('inside the deadline is matched', () => {
      expect(classifyPayment(send({ blockDate: EXPIRES - 1 }), session()).action).toBe('mark-paid');
    });

    it('between the deadline and the grace window is still matched, open or expired', () => {
      const t = EXPIRES + 1;
      expect(classifyPayment(send({ blockDate: t }), session()).action).toBe('mark-paid');
      expect(classifyPayment(send({ blockDate: t }), session({ status: 'expired' })).action).toBe('mark-paid');
    });

    it('exactly at the end of grace is inside', () => {
      expect(classifyPayment(send({ blockDate: GRACE }), session({ status: 'expired' })).disposition).toBe('matched');
    });

    it('one millisecond after grace is late and goes unmatched', () => {
      const c = classifyPayment(send({ blockDate: GRACE + 1 }), session({ status: 'expired' }));
      expect(c).toMatchObject({ disposition: 'late', action: 'mark-unmatched' });
    });

    it('judges by block time, so a stale open session is still late', () => {
      // The sweeper has not run; the store still says open. The block says otherwise.
      const c = classifyPayment(send({ blockDate: GRACE + 1 }), session({ status: 'open' }));
      expect(c.disposition).toBe('late');
    });

    it('time beats amount: a late underpayment is late', () => {
      const c = classifyPayment(send({ blockDate: GRACE + 1, amount: 1n }), session());
      expect(c.disposition).toBe('late');
    });
  });

  describe('amount', () => {
    it('exact is matched', () => {
      const c = classifyPayment(send({ amount: 1_000_000n }), session());
      expect(c).toMatchObject({ disposition: 'matched', action: 'mark-paid', sessionId: 'cs_A' });
    });

    it('more is overpaid and still paid', () => {
      const c = classifyPayment(send({ amount: 1_000_001n }), session());
      expect(c).toMatchObject({ disposition: 'overpaid', action: 'mark-paid' });
      expect(c.reason).toContain('1 more');
    });

    it('less is underpaid and the session is left alone', () => {
      const c = classifyPayment(send({ amount: 999_999n }), session());
      expect(c).toMatchObject({ disposition: 'underpaid', action: 'none', sessionId: 'cs_A' });
    });

    it('compares as bigint, beyond float precision', () => {
      const big = 10n ** 30n;
      const s = session({ amount: big });
      expect(classifyPayment(send({ amount: big }), s).disposition).toBe('matched');
      expect(classifyPayment(send({ amount: big - 1n }), s).disposition).toBe('underpaid');
      expect(classifyPayment(send({ amount: big + 1n }), s).disposition).toBe('overpaid');
    });
  });

  it('every disposition names the session it concerns, or null', () => {
    const cases: Array<[ObservedPayment, Session | undefined, string | null]> = [
      [send({ external: null }), undefined, null],
      [send(), undefined, null],
      [send({ tokenAddress: EURC }), session(), 'cs_A'],
      [send(), session({ status: 'cancelled' }), 'cs_A'],
      [send({ blockDate: GRACE + 1 }), session(), 'cs_A'],
      [send({ amount: 1n }), session(), 'cs_A'],
      [send(), session(), 'cs_A']
    ];
    for (const [payment, s, expected] of cases) {
      expect(classifyPayment(payment, s).sessionId).toBe(expected);
    }
  });
});
