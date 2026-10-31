import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
// Type-only: the SDK ships this module's declarations but bundles its code into
// the package entry, so there is no runtime file at this path to import.
import type { OperationType } from '@keetanetwork/keetanet-client/lib/block/operations.js';
import { describe, expect, it } from 'vitest';
import {
  SEND_OPERATION_TYPE,
  extractInboundSends,
  type HistoryEntryLike,
  type OperationLike
} from '../src/watcher/history-source.ts';
import { KTA, MERCHANT_ADDRESS, PAYER_ADDRESS, USDC } from './support/fakes.ts';

const addr = (value: string) => ({ publicKeyString: { get: () => value } });
const hash = (value: string) => ({ toString: () => value });

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

function sendOp(to: string, amount: bigint, external?: string, token = USDC): OperationLike {
  return { type: SEND_OPERATION_TYPE, to: addr(to), token: addr(token), amount, ...(external === undefined ? {} : { external }) };
}

function entry(blocksHash: string, blocks: Array<{ hash: string; from: string; date?: number; ops: OperationLike[] }>): HistoryEntryLike {
  return {
    voteStaple: {
      blocksHash: hash(blocksHash),
      blocks: blocks.map((b) => ({ hash: hash(b.hash), account: addr(b.from), date: new Date(b.date ?? T0), operations: b.ops }))
    }
  };
}

describe('SEND_OPERATION_TYPE', () => {
  it('is the SDK value, so a renumbering upstream fails here and not silently in production', () => {
    // Checked by the compiler: a numeric literal is assignable to a numeric enum
    // member type only when it is that member's value. If the SDK renumbers SEND,
    // `pnpm typecheck` fails on this line. The live test below checks it at runtime
    // against a real block.
    const tag: OperationType.SEND = SEND_OPERATION_TYPE;
    expect(tag).toBe(0);
  });
});

describe('extractInboundSends', () => {
  it('picks out the sends to the receiving address and nothing else', () => {
    const e = entry('S1', [
      {
        hash: 'B1',
        from: PAYER_ADDRESS,
        ops: [
          sendOp('keeta_someoneelse', 5n, 'kc_x'),
          sendOp(MERCHANT_ADDRESS, 7n, 'kc_y'),
          { type: 1 /* RECEIVE */, amount: 7n },
          sendOp(MERCHANT_ADDRESS, 9n)
        ]
      }
    ]);

    const found = extractInboundSends(e, MERCHANT_ADDRESS);
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      blockHash: 'B1',
      operationIndex: 1,
      from: PAYER_ADDRESS,
      to: MERCHANT_ADDRESS,
      tokenAddress: USDC,
      amount: 7n,
      external: 'kc_y',
      blockDate: T0
    });
    expect(found[1]).toMatchObject({ operationIndex: 3, amount: 9n, external: null });
  });

  it('keeps the original operation index, not a position among the matches', () => {
    const e = entry('S1', [{ hash: 'B1', from: PAYER_ADDRESS, ops: [sendOp('keeta_other', 1n), sendOp('keeta_other', 1n), sendOp(MERCHANT_ADDRESS, 1n)] }]);
    expect(extractInboundSends(e, MERCHANT_ADDRESS)[0]?.operationIndex).toBe(2);
  });

  it('treats an empty external as none', () => {
    const e = entry('S1', [{ hash: 'B1', from: PAYER_ADDRESS, ops: [sendOp(MERCHANT_ADDRESS, 1n, '')] }]);
    expect(extractInboundSends(e, MERCHANT_ADDRESS)[0]?.external).toBeNull();
  });

  it('walks every block in a staple and attributes each send to its own block', () => {
    const e = entry('S1', [
      { hash: 'B1', from: PAYER_ADDRESS, date: T0, ops: [sendOp(MERCHANT_ADDRESS, 1n, 'kc_a')] },
      { hash: 'B2', from: 'keeta_payer2', date: T0 + 1, ops: [sendOp(MERCHANT_ADDRESS, 2n, 'kc_b', KTA)] }
    ]);
    const found = extractInboundSends(e, MERCHANT_ADDRESS);
    expect(found.map((f) => [f.blockHash, f.from, f.tokenAddress, f.blockDate])).toEqual([
      ['B1', PAYER_ADDRESS, USDC, T0],
      ['B2', 'keeta_payer2', KTA, T0 + 1]
    ]);
  });

  it('ignores a send-typed operation that is missing its fields', () => {
    const e = entry('S1', [{ hash: 'B1', from: PAYER_ADDRESS, ops: [{ type: SEND_OPERATION_TYPE, to: addr(MERCHANT_ADDRESS) }] }]);
    expect(extractInboundSends(e, MERCHANT_ADDRESS)).toEqual([]);
  });

  it('returns nothing for a staple with no sends to us', () => {
    const e = entry('S1', [{ hash: 'B1', from: PAYER_ADDRESS, ops: [sendOp('keeta_other', 1n)] }]);
    expect(extractInboundSends(e, MERCHANT_ADDRESS)).toEqual([]);
  });
});

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const seed = process.env.KEETA_MERCHANT_SEED;
const canRun = seed !== undefined && seed !== '' && (process.env.KEETA_NETWORK ?? 'test') === 'test';

describe.skipIf(!canRun)('extractInboundSends on the real test network', () => {
  it('finds the faucet send in the merchant history, from a key-less client', async () => {
    const { Account } = KeetaNet.lib;
    const merchant = Account.fromSeed(seed as string, 0).publicKeyString.get();
    // Watch-only, as the server runs: no signer at all.
    const client = KeetaNet.UserClient.fromNetwork('test', null);
    try {
      // Deep enough to reach the faucet's send from 2026-10-29 however many
      // end-to-end payments have landed on this wallet since.
      const history = await client.client.getHistory(Account.fromPublicKeyString(merchant), { depth: 500 });
      expect(history.length).toBeGreaterThan(0);

      const found = history.flatMap((e) => extractInboundSends(e as HistoryEntryLike, merchant));
      const kta = client.baseToken.publicKeyString.get();
      const faucet = found.find((f) => f.tokenAddress === kta && f.amount === 10n * 10n ** 18n && f.external === null);
      expect(faucet, 'the 10 KTA the faucet sent').toBeDefined();
      expect(faucet?.to).toBe(merchant);
      expect(faucet?.amount).toBe(10n * 10n ** 18n);
      expect(faucet?.external).toBeNull();
      expect(faucet?.blockHash).toMatch(/^[0-9A-F]{64}$/);
      expect(faucet?.from).toMatch(/^keeta_/);
      expect(faucet?.from).not.toBe(merchant);
      expect(faucet?.blockDate).toBeGreaterThan(Date.UTC(2026, 0, 1));
    } finally {
      await client.destroy();
    }
  });
});
