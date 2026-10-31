/**
 * Network tests for the token registry, against the Keeta test network.
 *
 * They need the merchant dev wallet from `.env.test` (see docs/development.md). When
 * it is absent, for example in CI before wallets are provisioned, the whole suite is
 * skipped and says so. Nothing here publishes a block or moves value.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenError, TokenRegistry, normalizeTicker } from '../src/tokens.ts';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const seed = process.env.KEETA_MERCHANT_SEED;
const network = process.env.KEETA_NETWORK ?? 'test';
const canRun = seed !== undefined && seed !== '' && network === 'test';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;

describe('normalizeTicker', () => {
  it('strips one leading $ and upper-cases', () => {
    expect(normalizeTicker('$USDC')).toBe('USDC');
    expect(normalizeTicker('usdc')).toBe('USDC');
    expect(normalizeTicker('$usdc')).toBe('USDC');
    expect(normalizeTicker('EUR')).toBe('EUR');
    expect(normalizeTicker('$$X')).toBe('$X');
  });
});

describe.skipIf(!canRun)('TokenRegistry on the test network', () => {
  let client: UserClient;
  let registry: TokenRegistry;

  beforeAll(() => {
    const account = KeetaNet.lib.Account.fromSeed(seed as string, 0);
    client = KeetaNet.UserClient.fromNetwork('test', account);
    registry = new TokenRegistry({ client });
  });

  afterAll(async () => {
    await client.destroy();
  });

  it('lists tokens with decimals from on-chain metadata', async () => {
    const skipped: string[] = [];
    const tokens = await registry.list((address) => skipped.push(address));

    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(token.ticker).not.toBeNull();
      expect(token.address).toMatch(/^keeta_/);
      expect(token.account.isToken()).toBe(true);
      expect(Number.isInteger(token.decimals)).toBe(true);
      expect(token.decimals).toBeGreaterThanOrEqual(0);
    }
    expect(skipped, 'tokens without readable metadata').toEqual([]);

    const kta = tokens.find((token) => token.address === client.baseToken.publicKeyString.get());
    expect(kta?.ticker).toBe('$KTA');
    expect(kta?.decimals).toBe(18);

    // Every token the test network lists is open to any holder, so a shopper's
    // wallet can send it. Permit-listed tokens exist only on main today.
    expect(kta?.openToAnyHolder).toBe(true);
    for (const token of tokens) {
      expect(token.openToAnyHolder, `${token.ticker ?? token.address} default permission`).toBe(true);
    }

    expect(tokens.map((token) => token.ticker)).toContain('$USDC');
  });

  it('resolves a ticker exactly, case-insensitively, and without the $', async () => {
    const exact = await registry.resolve('$USDC');
    expect(exact.ticker).toBe('$USDC');

    for (const spelling of ['usdc', 'USDC', '$usdc', ' $USDC ']) {
      const token = await registry.resolve(spelling);
      expect(token.address, spelling).toBe(exact.address);
      expect(token.decimals, spelling).toBe(exact.decimals);
    }
  });

  it('resolves the base token by address and finds its ticker', async () => {
    const address = client.baseToken.publicKeyString.get();
    const token = await registry.resolve(address);
    expect(token.ticker).toBe('$KTA');
    expect(token.decimals).toBe(18);
    expect(await registry.decimals(address)).toBe(18);
    expect(await registry.decimals(client.baseToken)).toBe(18);
  });

  it('returns the same object for repeated lookups (cached)', async () => {
    const first = await registry.resolve('$USDC');
    const second = await registry.resolve('$usdc');
    const third = await registry.byAddress(first.address);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('fails clearly for an unknown ticker and names what exists', async () => {
    const error = await registry.resolve('$NOPE').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe('TOKEN_NOT_FOUND');
    expect((error as TokenError).message).toContain('$USDC');
  });

  it('refuses a key-pair account address: it is not a token', async () => {
    const merchantAddress = client.account.publicKeyString.get();
    const error = await registry.resolve(merchantAddress).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe('NOT_A_TOKEN');
  });

  it('refuses a malformed address', async () => {
    const error = await registry.resolve('keeta_notarealaddress').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe('NOT_A_TOKEN');
  });

  it('rejects empty input', async () => {
    const error = await registry.resolve('   ').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).code).toBe('TOKEN_NOT_FOUND');
  });

  it('refresh() drops the cache and refetches the same data', async () => {
    const before = await registry.resolve('$USDC');
    registry.refresh();
    const after = await registry.resolve('$USDC');
    expect(after).not.toBe(before);
    expect(after.address).toBe(before.address);
    expect(after.decimals).toBe(before.decimals);
  });
});

if (!canRun) {
  describe('TokenRegistry on the test network', () => {
    it.skip('skipped: no KEETA_MERCHANT_SEED in .env.test (run `pnpm wallets:create`)', () => {});
  });
}
