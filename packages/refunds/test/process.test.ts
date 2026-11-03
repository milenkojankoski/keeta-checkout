/**
 * The refund process against a fake vault and the in-memory store.
 *
 * What is pinned here is the order of decisions and the money rules from
 * docs/decisions/0014: reconcile before anything else, every limit fails closed,
 * permanent refusals are `refused`, transient ones hold the queue, an unknown
 * publish outcome is never retried blind, and a refund the merchant did not ask
 * for is created only for the dispositions they turned on.
 */
import { describe, expect, it } from 'vitest';
import {
  MemorySessionStore,
  SEND_OPERATION_TYPE,
  refundExternal,
  type HistoryEntryLike,
  type NewRefund,
  type PaymentRow,
  type Session
} from '@keeta-checkout/server';
import { RefundProcess, isCleanRejection, type VaultSigner } from '../src/process.ts';

const VAULT = 'keeta_vault';
const USDC = 'keeta_usdc';
const KTA = 'keeta_kta';
const PAYER = 'keeta_payer';
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

/** A vault whose balances, history and publish behaviour a test sets directly. */
class FakeVault implements VaultSigner {
  balances = new Map<string, bigint>([
    [USDC, 10_000_000n],
    [KTA, 10n ** 18n]
  ]);
  pending = false;
  recovered = 0;
  sends: Array<{ to: string; amount: bigint; token: string; external: string }> = [];
  chain: HistoryEntryLike[] = [];
  /** What the next send does: publish, reject cleanly, or vanish. */
  nextSend: 'publish' | 'reject' | 'vanish' | 'reject-balance' = 'publish';
  balanceError: Error | undefined;
  #seq = 0;

  send(to: string, amount: bigint, token: string, external: string): Promise<{ blockHash: string }> {
    this.sends.push({ to, amount, token, external });
    if (this.nextSend === 'reject') {
      return Promise.reject(
        Object.assign(new Error(`${VAULT} does not have required permissions to perform action`), { code: 'PERMISSIONS', type: 'PERMISSIONS' })
      );
    }
    if (this.nextSend === 'reject-balance') {
      return Promise.reject(new Error('Resulting balance becomes negative at one+ point(s) during this transaction'));
    }
    if (this.nextSend === 'vanish') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve({ blockHash: this.publishOnChain(external, to, amount, token) });
  }

  /** Put a send from the vault on the chain, as the network would have. */
  publishOnChain(external: string, to = PAYER, amount = 1n, token = USDC): string {
    this.#seq += 1;
    const blockHash = `RB${this.#seq}`;
    this.chain.unshift({
      voteStaple: {
        blocksHash: { toString: () => `RS${this.#seq}` },
        blocks: [
          {
            hash: { toString: () => blockHash },
            account: { publicKeyString: { get: () => VAULT } },
            date: new Date(T0),
            operations: [{ type: SEND_OPERATION_TYPE, to: addr(to), token: addr(token), amount, external }]
          }
        ]
      }
    });
    this.balances.set(token, (this.balances.get(token) ?? 0n) - amount);
    return blockHash;
  }

  feeKta = 10n ** 18n;
  feeBalanceError: Error | undefined;

  balance(token: string): Promise<bigint> {
    if (this.balanceError !== undefined) return Promise.reject(this.balanceError);
    return Promise.resolve(this.balances.get(token) ?? 0n);
  }
  feeBalance(): Promise<bigint> {
    if (this.feeBalanceError !== undefined) return Promise.reject(this.feeBalanceError);
    return Promise.resolve(this.feeKta);
  }
  hasPendingBlock(): Promise<boolean> {
    return Promise.resolve(this.pending);
  }
  recover(): Promise<void> {
    this.recovered += 1;
    this.pending = false;
    return Promise.resolve();
  }
  history(): Promise<readonly HistoryEntryLike[]> {
    return Promise.resolve(this.chain);
  }
}

const addr = (value: string) => ({ publicKeyString: { get: () => value } });

function request(overrides: Partial<NewRefund> = {}): NewRefund {
  return {
    id: 'rf_a',
    paymentBlockHash: 'B1',
    paymentOperationIndex: 0,
    sessionId: 'cs_1',
    to: PAYER,
    tokenAddress: USDC,
    amount: 1_500_000n,
    reason: 'duplicate',
    origin: 'api',
    createdAt: T0,
    ...overrides
  };
}

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    blockHash: 'PB1',
    operationIndex: 0,
    from: PAYER,
    to: 'keeta_merchant',
    tokenAddress: USDC,
    amount: 2_000_000n,
    external: 'kc_x',
    blockDate: T0,
    sessionId: null,
    disposition: 'duplicate',
    observedAt: T0 + 1,
    ...overrides
  };
}

function build(options: { autoRefund?: Array<NewRefund['reason']>; maxPerRefund?: bigint; maxPerDay?: bigint; ktaReserve?: bigint } = {}) {
  const store = new MemorySessionStore();
  const vault = new FakeVault();
  let now = T0 + 10_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const logged: string[] = [];
  const log = {
    error: (...a: unknown[]) => void logged.push(`E ${a.map(String).join(' ')}`),
    warn: (...a: unknown[]) => void logged.push(`W ${a.map(String).join(' ')}`),
    info: (...a: unknown[]) => void logged.push(`I ${a.map(String).join(' ')}`)
  };
  const changes: string[] = [];
  const process = new RefundProcess({
    store,
    signer: vault,
    vault: VAULT,
    token: USDC,
    limits: { maxPerRefund: options.maxPerRefund, maxPerDay: options.maxPerDay, ktaReserve: options.ktaReserve ?? 10n ** 16n },
    autoRefund: options.autoRefund ?? [],
    reconcileGraceMs: 60_000,
    holdMs: 30_000,
    log,
    now: clock.now
  });
  process.onChange(({ refund }) => void changes.push(`${refund.id}:${refund.status}`));
  return { store, vault, clock, process, logged, changes };
}

describe('RefundProcess', () => {
  it('does nothing when nothing is requested', async () => {
    const { process } = build();
    expect(await process.runOnce()).toEqual({ did: 'nothing' });
  });

  it('publishes a requested refund from the vault to the payer, in kind, with the refund id on chain', async () => {
    const { store, vault, process, changes } = build();
    await store.createRefund(request());

    const outcome = await process.runOnce();
    expect(outcome.did).toBe('published');
    expect(vault.sends).toEqual([{ to: PAYER, amount: 1_500_000n, token: USDC, external: refundExternal('rf_a') }]);

    const refund = await store.getRefund('rf_a');
    expect(refund?.status).toBe('published');
    expect(refund?.blockHash).toBe('RB1');
    expect(refund?.attempts).toBe(1);
    expect(changes).toEqual(['rf_a:published']);
  });

  it('refuses, permanently, a payment in a token the vault does not hold', async () => {
    const { store, vault, process } = build();
    await store.createRefund(request({ tokenAddress: 'keeta_other' }));
    const outcome = await process.runOnce();
    expect(outcome.did).toBe('refused');
    expect(vault.sends).toEqual([]);
    expect((await store.getRefund('rf_a'))?.status).toBe('refused');
    expect((await store.getRefund('rf_a'))?.lastError).toContain('the vault pays');
  });

  it('refuses, permanently, a refund over the per-refund cap', async () => {
    const { store, vault, process } = build({ maxPerRefund: 1_000_000n });
    await store.createRefund(request({ amount: 1_000_001n }));
    expect((await process.runOnce()).did).toBe('refused');
    expect(vault.sends).toEqual([]);
  });

  it('holds the queue, not the refund, when the float is too low, and pays once it is topped up', async () => {
    const { store, vault, process, clock } = build();
    vault.balances.set(USDC, 100n);
    await store.createRefund(request());

    const held = await process.runOnce();
    expect(held.did).toBe('held');
    expect((await store.getRefund('rf_a'))?.status).toBe('requested');
    expect(vault.sends).toEqual([]);

    // Still held: the queue waits, the row is untouched.
    expect((await process.runOnce()).did).toBe('waiting');

    clock.advance(31_000);
    vault.balances.set(USDC, 10_000_000n);
    expect((await process.runOnce()).did).toBe('published');
  });

  it('holds when the signer cannot pay the fee', async () => {
    const { store, vault, process } = build({ ktaReserve: 10n ** 17n });
    vault.feeKta = 10n ** 16n;
    await store.createRefund(request());
    const outcome = await process.runOnce();
    expect(outcome.did).toBe('held');
    expect(outcome.did === 'held' && outcome.reason).toContain('fee account');
    expect(vault.sends).toEqual([]);
  });

  it('holds when the fee balance cannot be read', async () => {
    const { store, vault, process } = build();
    vault.feeBalanceError = new Error('node unreachable');
    await store.createRefund(request());
    expect((await process.runOnce()).did).toBe('held');
    expect(vault.sends).toEqual([]);
  });

  it('holds when a balance cannot be read: an unknown balance is not a yes', async () => {
    const { store, vault, process } = build();
    vault.balanceError = new Error('node unreachable');
    await store.createRefund(request());
    expect((await process.runOnce()).did).toBe('held');
    expect(vault.sends).toEqual([]);
  });

  it('holds at the daily cap, counting money already in flight', async () => {
    const { store, process, clock } = build({ maxPerDay: 2_000_000n });
    await store.createRefund(request({ id: 'rf_a', paymentBlockHash: 'B1', amount: 1_500_000n }));
    await store.createRefund(request({ id: 'rf_b', paymentBlockHash: 'B2', amount: 600_000n, createdAt: T0 + 1 }));
    expect((await process.runOnce()).did).toBe('published');
    const second = await process.runOnce();
    expect(second.did).toBe('held');
    expect(second.did === 'held' && second.reason).toContain('daily cap');
    // A day later the window has moved on.
    clock.advance(24 * 60 * 60 * 1000 + 1);
    expect((await process.runOnce()).did).toBe('published');
  });

  it('records a clean rejection as failed and never retries it', async () => {
    const { store, vault, process, changes } = build();
    vault.nextSend = 'reject';
    await store.createRefund(request());
    expect((await process.runOnce()).did).toBe('failed');
    expect((await store.getRefund('rf_a'))?.status).toBe('failed');
    expect((await store.getRefund('rf_a'))?.lastError).toContain('permissions');
    expect(changes).toEqual(['rf_a:failed']);
    expect((await process.runOnce()).did).toBe('nothing');
    expect(vault.sends).toHaveLength(1);
  });

  it('leaves an unknown outcome in publishing and reconciles it from the chain, never sending twice', async () => {
    const { store, vault, process, clock } = build();
    vault.nextSend = 'vanish';
    await store.createRefund(request());

    const first = await process.runOnce();
    expect(first.did).toBe('ambiguous');
    expect((await store.getRefund('rf_a'))?.status).toBe('publishing');

    // It did land, the process just never heard. The next step finds it.
    vault.nextSend = 'publish';
    const landed = vault.publishOnChain(refundExternal('rf_a'), PAYER, 1_500_000n);
    clock.advance(1_000);
    const second = await process.runOnce();
    expect(second).toMatchObject({ did: 'reconciled', found: true });
    const refund = await store.getRefund('rf_a');
    expect(refund?.status).toBe('published');
    expect(refund?.blockHash).toBe(landed);
    expect(vault.sends).toHaveLength(1);
  });

  it('retries an unknown outcome only after the grace window, and only if the chain has nothing', async () => {
    const { store, vault, process, clock } = build();
    vault.nextSend = 'vanish';
    await store.createRefund(request());
    await process.runOnce();

    vault.nextSend = 'publish';
    clock.advance(30_000);
    expect((await process.runOnce()).did).toBe('waiting'); // inside the grace window: no retry
    expect(vault.sends).toHaveLength(1);

    clock.advance(31_000);
    expect(await process.runOnce()).toMatchObject({ did: 'reconciled', found: false });
    expect((await store.getRefund('rf_a'))?.status).toBe('requested');

    expect((await process.runOnce()).did).toBe('published');
    expect((await store.getRefund('rf_a'))?.attempts).toBe(2);
    expect(vault.sends).toHaveLength(2);
  });

  it('recovers a pending block before anything else when one is in flight', async () => {
    const { store, vault, process } = build();
    vault.nextSend = 'vanish';
    await store.createRefund(request());
    await process.runOnce();
    vault.pending = true;
    await process.runOnce();
    expect(vault.recovered).toBe(1);
    expect(vault.pending).toBe(false);
  });

  it('does not mistake another account\'s send, or another refund\'s, for this one', async () => {
    const { store, vault, process, clock } = build();
    vault.nextSend = 'vanish';
    await store.createRefund(request());
    await process.runOnce();
    vault.publishOnChain(refundExternal('rf_zzz'), PAYER, 1_500_000n);
    vault.chain.unshift({
      voteStaple: {
        blocksHash: { toString: () => 'X' },
        blocks: [
          {
            hash: { toString: () => 'OTHER' },
            account: addr('keeta_someone_else'),
            date: new Date(T0),
            operations: [{ type: SEND_OPERATION_TYPE, to: addr(PAYER), token: addr(USDC), amount: 1n, external: refundExternal('rf_a') }]
          }
        ]
      }
    });
    clock.advance(1_000);
    expect((await process.runOnce()).did).toBe('waiting');
    expect((await store.getRefund('rf_a'))?.status).toBe('publishing');
  });

  it('creates refunds automatically only for the dispositions the merchant turned on, once each', async () => {
    const { store, vault, process, changes } = build({ autoRefund: ['duplicate'] });
    await store.recordPayment(payment({ blockHash: 'PB1', disposition: 'duplicate', amount: 700n }));
    await store.recordPayment(payment({ blockHash: 'PB2', disposition: 'late', amount: 800n, observedAt: T0 + 2 }));
    await store.recordPayment(payment({ blockHash: 'PB3', disposition: 'matched', amount: 900n, observedAt: T0 + 3 }));

    const outcome = await process.runOnce();
    expect(outcome.did).toBe('auto-requested');
    const refunds = await store.listRefunds();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ paymentBlockHash: 'PB1', to: PAYER, tokenAddress: USDC, amount: 700n, reason: 'duplicate', origin: 'auto', status: 'requested' });
    expect(changes).toEqual([`${refunds[0]?.id}:requested`]);

    // The next step pays it; the one after finds nothing new to request.
    expect((await process.runOnce()).did).toBe('published');
    expect(vault.sends[0]).toMatchObject({ amount: 700n, to: PAYER });
    expect((await process.runOnce()).did).toBe('nothing');
    expect(await store.listRefunds()).toHaveLength(1);
  });

  it('refunds exactly the excess of an overpayment, read from the session', async () => {
    const { store, process } = build({ autoRefund: ['overpaid'] });
    const session: Session = {
      id: 'cs_over',
      reference: 'kc_over',
      orderId: 'o',
      amount: 1_000n,
      tokenAddress: USDC,
      tokenTicker: '$USDC',
      tokenDecimals: 6,
      receivingAddress: 'keeta_merchant',
      network: 'test',
      status: 'paid',
      createdAt: T0,
      expiresAt: T0 + 1,
      graceUntil: T0 + 2,
      successUrl: 'https://s/ok',
      cancelUrl: 'https://s/no',
      paidBy: PAYER,
      blockHash: 'PB9',
      operationIndex: 0,
      paidAt: T0,
      overpaidBy: 250n,
      updatedAt: T0
    };
    await store.create(session);
    await store.recordPayment(payment({ blockHash: 'PB9', disposition: 'overpaid', amount: 1_250n, sessionId: 'cs_over' }));

    expect((await process.runOnce()).did).toBe('auto-requested');
    const [refund] = await store.listRefunds();
    expect(refund).toMatchObject({ amount: 250n, reason: 'overpaid', sessionId: 'cs_over' });
  });

  it('serialises steps: a second runOnce during the first returns the same promise', async () => {
    const { store, process } = build();
    await store.createRefund(request());
    const a = process.runOnce();
    const b = process.runOnce();
    expect(b).toBe(a);
    await a;
  });

  it('a scheduled step that throws does not end the process', async () => {
    const { store, process } = build();
    // A store that explodes on claim.
    store.claimNextRefund = () => Promise.reject(new Error('disk gone'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    globalThis.process.on('unhandledRejection', onUnhandled);
    try {
      process.start(60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await process.stop();
      await expect(process.runOnce()).rejects.toThrow('disk gone');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      globalThis.process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('isCleanRejection', () => {
  it('recognises the network saying no, and nothing else', () => {
    expect(isCleanRejection(Object.assign(new Error('x'), { code: 'PERMISSIONS_DENIED', type: 'PERMISSIONS' }))).toBe(true);
    expect(isCleanRejection(new Error('keeta_x does not have required permissions to perform action'))).toBe(true);
    expect(isCleanRejection(new Error('Resulting balance becomes negative at one+ point(s)'))).toBe(true);
    expect(isCleanRejection(new TypeError('fetch failed'))).toBe(false);
    expect(isCleanRejection(new Error('socket hang up'))).toBe(false);
    expect(isCleanRejection('timeout')).toBe(false);
    expect(isCleanRejection(undefined)).toBe(false);
  });
});
