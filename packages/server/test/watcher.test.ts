/**
 * The watcher against a fake chain: paging, the cursor, the lower bound, ordering,
 * restarts, and the one-scan-at-a-time guard.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutService } from '../src/sessions/service.ts';
import { MemorySessionStore } from '../src/sessions/store.ts';
import type { Session } from '../src/sessions/types.ts';
import {
  SEND_OPERATION_TYPE,
  type HistoryEntryLike,
  type HistoryQuery,
  type HistorySource,
  type OperationLike
} from '../src/watcher/history-source.ts';
import { CURSOR_META_KEY, PaymentWatcher } from '../src/watcher/watcher.ts';
import { FakeClock, MERCHANT_ADDRESS, PAYER_ADDRESS, USDC, fakeRegistry, testConfig } from './support/fakes.ts';

const addr = (value: string) => ({ publicKeyString: { get: () => value } });
const hash = (value: string) => ({ toString: () => value });

/**
 * A chain that only ever gets newer. Entries are kept newest-first, as the node
 * returns them, and the cursor is exclusive, as measured against the real node.
 */
class FakeChain implements HistorySource {
  entries: HistoryEntryLike[] = [];
  calls: HistoryQuery[] = [];
  #seq = 0;

  /** Append a staple newer than everything so far. */
  addStaple(date: number, blocks: Array<{ from: string; ops: OperationLike[] }>): string {
    this.#seq += 1;
    const blocksHash = `STAPLE${this.#seq}`;
    this.entries.unshift({
      voteStaple: {
        blocksHash: hash(blocksHash),
        blocks: blocks.map((b, i) => ({
          hash: hash(`${blocksHash}-B${i}`),
          account: addr(b.from),
          date: new Date(date),
          operations: b.ops
        }))
      }
    });
    return blocksHash;
  }

  getHistory(_account: unknown, query: HistoryQuery = {}): Promise<readonly HistoryEntryLike[]> {
    this.calls.push(query);
    const pageSize = query.pageSize ?? 200;
    let start = 0;
    if (query.startBlocksHash !== undefined) {
      const index = this.entries.findIndex((e) => e.voteStaple.blocksHash.toString() === query.startBlocksHash);
      start = index === -1 ? this.entries.length : index + 1; // exclusive
    }
    return Promise.resolve(this.entries.slice(start, start + pageSize));
  }
}

function send(session: Session, amount = session.amount, external: string | null = session.reference): OperationLike {
  return {
    type: SEND_OPERATION_TYPE,
    to: addr(session.receivingAddress),
    token: addr(session.tokenAddress),
    amount,
    ...(external === null ? {} : { external })
  };
}

function build(options: { pageSize?: number; maxPages?: number } = {}) {
  const clock = new FakeClock();
  const store = new MemorySessionStore();
  const service = new CheckoutService({ config: testConfig(), store, tokens: fakeRegistry(), now: clock.now });
  const chain = new FakeChain();
  const warnings: string[] = [];
  const watcher = new PaymentWatcher({
    service,
    history: chain,
    receivingAddress: MERCHANT_ADDRESS,
    pageSize: options.pageSize ?? 3,
    maxPages: options.maxPages ?? 10,
    now: clock.now,
    log: { error: () => undefined, warn: (...args: unknown[]) => void warnings.push(args.map(String).join(' ')) }
  });
  const create = (amount = '1') =>
    service.createSession({ amount, currency: USDC, orderId: 'o', successUrl: 'https://s.example/ok', cancelUrl: 'https://s.example/no' });
  return { clock, store, service, chain, watcher, create, warnings };
}

describe('PaymentWatcher.scan', () => {
  it('with nothing to watch, learns where now is and reads one page', async () => {
    const { chain, watcher, store } = build();
    chain.addStaple(Date.UTC(2026, 9, 30, 11, 0, 0), [{ from: PAYER_ADDRESS, ops: [] }]);

    const result = await watcher.scan();
    expect(result.stoppedBecause).toBe('nothing-to-watch');
    expect(result.pages).toBe(1);
    expect(result.observed).toBe(0);
    expect(await store.getMeta(CURSOR_META_KEY)).toBe('STAPLE1');
  });

  it('pays a session from a send on the chain', async () => {
    const { chain, watcher, create, clock, service } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);

    const result = await watcher.scan();
    expect(result.observed).toBe(1);
    expect(result.recorded).toBe(1);
    expect((await service.getSession(session.id)).status).toBe('paid');
  });

  it('stops at the cursor and never reprocesses what it already saw', async () => {
    const { chain, watcher, create, clock, store } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);
    await watcher.scan();
    chain.calls.length = 0;

    // Nothing new on the chain.
    const second = await watcher.scan();
    expect(second.stoppedBecause).toBe('cursor');
    expect(second.observed).toBe(0);
    expect(chain.calls).toHaveLength(1);
    expect(await store.listPayments()).toHaveLength(1);
  });

  it('pages back with an exclusive cursor until it meets the last cursor', async () => {
    const { chain, watcher, create, clock, store } = build({ pageSize: 2 });
    const first = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(first)] }]);
    await watcher.scan(); // cursor = STAPLE1

    // Five newer staples, paying one new session among noise.
    const second = await create();
    chain.addStaple(clock.now() + 2_000, [{ from: PAYER_ADDRESS, ops: [] }]);
    chain.addStaple(clock.now() + 3_000, [{ from: PAYER_ADDRESS, ops: [send(second)] }]);
    chain.addStaple(clock.now() + 4_000, [{ from: PAYER_ADDRESS, ops: [] }]);
    chain.addStaple(clock.now() + 5_000, [{ from: PAYER_ADDRESS, ops: [] }]);
    chain.addStaple(clock.now() + 6_000, [{ from: PAYER_ADDRESS, ops: [] }]);
    chain.calls.length = 0;

    const result = await watcher.scan();
    expect(result.stoppedBecause).toBe('cursor');
    expect(result.pages).toBe(3); // 2 + 2 + (2, meeting STAPLE1)
    expect(chain.calls[1]?.startBlocksHash).toBe('STAPLE5');
    expect(chain.calls[2]?.startBlocksHash).toBe('STAPLE3');
    expect(result.observed).toBe(1);
    expect((await store.get(second.id))?.status).toBe('paid');
    expect(await store.getMeta(CURSOR_META_KEY)).toBe('STAPLE6');
  });

  it('processes sends oldest-first even though the chain serves newest-first', async () => {
    // An underpayment and then the full payment, in two staples. Newest-first would
    // credit the full payment and then read the underpayment as a duplicate.
    const { chain, watcher, create, clock, store } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session, session.amount - 1n)] }]);
    chain.addStaple(clock.now() + 2_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);

    const result = await watcher.scan();
    expect(result.results.map((r) => r.classification.disposition)).toEqual(['underpaid', 'matched']);
    expect((await store.get(session.id))?.status).toBe('paid');
  });

  it('stops at the lower bound when there is no cursor yet', async () => {
    const { chain, watcher, create, clock } = build({ pageSize: 2 });
    // Old history long before any session existed.
    for (let i = 0; i < 6; i++) chain.addStaple(clock.now() - 86_400_000 + i, [{ from: PAYER_ADDRESS, ops: [] }]);
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);

    const result = await watcher.scan();
    expect(result.stoppedBecause).toBe('lower-bound');
    expect(result.observed).toBe(1);
    expect(result.pages).toBeLessThan(4); // did not walk the whole day
  });

  it('survives a restart: a new watcher continues from the persisted cursor', async () => {
    const { chain, watcher, create, clock, store, service } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);
    await watcher.scan();

    const again = new PaymentWatcher({ service, history: chain, receivingAddress: MERCHANT_ADDRESS, pageSize: 3, now: clock.now, log: { error: () => undefined, warn: () => undefined } });
    const result = await again.scan();
    expect(result.stoppedBecause).toBe('cursor');
    expect(result.recorded).toBe(0);
    expect(await store.listPayments()).toHaveLength(1);
  });

  it('re-reads safely when the cursor is lost: the ledger dedups', async () => {
    const { chain, watcher, create, clock, store } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);
    await watcher.scan();
    await store.setMeta(CURSOR_META_KEY, 'GONE');

    const result = await watcher.scan();
    expect(result.observed).toBe(1);
    expect(result.recorded).toBe(0);
    expect((await store.get(session.id))?.status).toBe('paid');
    expect(await store.listPayments()).toHaveLength(1);
  });

  it('caps the pages it will walk and warns', async () => {
    const { chain, watcher, create, clock, warnings } = build({ pageSize: 1, maxPages: 2 });
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);
    chain.addStaple(clock.now() + 2_000, [{ from: PAYER_ADDRESS, ops: [] }]);
    chain.addStaple(clock.now() + 3_000, [{ from: PAYER_ADDRESS, ops: [] }]);

    const result = await watcher.scan();
    expect(result.stoppedBecause).toBe('page-cap');
    expect(result.pages).toBe(2);
    expect(warnings[0]).toContain('page cap');
  });

  it('ignores sends to other accounts and non-send operations', async () => {
    const { chain, watcher, create, clock } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [
      { from: PAYER_ADDRESS, ops: [{ ...send(session), to: addr('keeta_other') }, { type: 1, amount: 1n }] }
    ]);
    const result = await watcher.scan();
    expect(result.observed).toBe(0);
  });

  it('runs one scan at a time', async () => {
    const { chain, watcher, create, clock } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);

    const a = watcher.scan();
    const b = watcher.scan();
    expect(b).toBe(a);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe(rb);
    expect(chain.calls).toHaveLength(1);
  });

  it('start() scans immediately and stop() waits for the scan in flight', async () => {
    const { chain, watcher, create, clock, store } = build();
    const session = await create();
    chain.addStaple(clock.now() + 1_000, [{ from: PAYER_ADDRESS, ops: [send(session)] }]);

    watcher.start(60_000);
    await watcher.stop();
    expect((await store.get(session.id))?.status).toBe('paid');
  });

  it('a node that is down does not end the process', async () => {
    // Seen on the live test network: rep2 answered "not ok" for fifteen seconds,
    // scan() logged it and rethrew, start() had discarded the promise, and the
    // unhandled rejection took the whole server down. Four restarts in an hour.
    const { service, clock } = build();
    const broken: HistorySource = {
      getHistory: () => Promise.reject(new Error('Failed to make API call (not ok)'))
    };
    const logged: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const watcher = new PaymentWatcher({
      service,
      history: broken,
      receivingAddress: MERCHANT_ADDRESS,
      now: clock.now,
      log: { error: (...args: unknown[]) => void logged.push(args), warn: () => undefined }
    });

    try {
      watcher.start(60_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await watcher.stop(); // must not throw either, even while a scan is failing

      // A direct caller, such as the CLI's check command, still hears about it.
      await expect(watcher.scan()).rejects.toThrow('not ok');
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(unhandled).toEqual([]);
  });
});
