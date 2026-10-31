/**
 * Shared helpers for the development wallet tools.
 *
 * Test network only: every entry point here refuses to run against `main`.
 * Seeds are read from `.env.test` and never printed, logged or returned to a caller
 * that could print them. Only public `keeta_…` addresses leave this module.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';

const { Account } = KeetaNet.lib;

export const ENV_FILE = resolve(import.meta.dirname, '..', '.env.test');

export type WalletRole = 'merchant' | 'payer';

export const WALLET_ROLES: readonly WalletRole[] = ['merchant', 'payer'] as const;

/** Which variable in `.env.test` holds each role's seed. */
export const SEED_VAR: Record<WalletRole, string> = {
  merchant: 'KEETA_MERCHANT_SEED',
  payer: 'KEETA_PAYER_SEED'
};

export const EXPLORER: Record<'test' | 'main', string> = {
  test: 'https://explorer.test.keeta.com',
  main: 'https://explorer.keeta.com'
};

export const FAUCET_URL = 'https://faucet.test.keeta.com/';

/** Load `.env.test` into `process.env` if it exists. Missing values are reported later. */
export function loadTestEnv(): void {
  if (!existsSync(ENV_FILE)) return;
  process.loadEnvFile(ENV_FILE);
}

/**
 * The network these tools operate on. Always `test`: the development wallets are
 * disposable, so pointing them at `main` is a mistake, never an intention.
 */
export function requireTestNetwork(): 'test' {
  const network = process.env.KEETA_NETWORK ?? 'test';
  if (network !== 'test') {
    throw new Error(
      `these tools only run on the test network, but KEETA_NETWORK is "${network}". ` +
        'Use the main network from the checkout server with its own configuration, not from dev tooling.'
    );
  }
  return 'test';
}

export function explorerAccountUrl(address: string, network: 'test' | 'main' = 'test'): string {
  return `${EXPLORER[network]}/account/${address}`;
}

/** The seed for one role, or a clear error naming what to run. */
export function seedFor(role: WalletRole): string {
  const seed = process.env[SEED_VAR[role]];
  if (!seed) {
    throw new Error(
      `${SEED_VAR[role]} is not set in ${ENV_FILE}. Run \`pnpm wallets:create\` to generate the dev wallets.`
    );
  }
  return seed;
}

/** The account for one role, derived from its seed at index 0. */
export function accountFor(role: WalletRole) {
  return Account.fromSeed(seedFor(role), 0);
}

export function addressFor(role: WalletRole): string {
  return accountFor(role).publicKeyString.get();
}

/** A client bound to one role's account, on the test network. */
export function clientFor(role: WalletRole) {
  return KeetaNet.UserClient.fromNetwork(requireTestNetwork(), accountFor(role));
}

/**
 * A resolver that signs its metadata requests with the given account, as the Keeta
 * wallet does. Some providers publish routes only to signed requests, so an unsigned
 * resolver silently sees fewer of them.
 */
export function signedResolver(
  client: ReturnType<typeof clientFor>,
  account: ReturnType<typeof accountFor>
) {
  return new KeetaAnchor.lib.Resolver({
    ...getDefaultResolverConfig(client),
    metadataConfig: { signing: { account } }
  });
}

/**
 * A token's decimals, read from its on-chain metadata. Never hardcode these: the
 * published KTA decimals have differed between Keeta's own docs and tools.
 */
export async function decimalsOf(
  client: ReturnType<typeof clientFor>,
  token: TokenAddress
): Promise<number> {
  const { info } = await client.client.getAccountInfo(token);
  if (!info.metadata) {
    throw new Error(`${token.publicKeyString.get()} has no metadata, so its decimals are unknown`);
  }
  return decodeTokenMetadata(info.metadata).decimalPlaces;
}

/**
 * Format base units for a human reading a terminal. Display only.
 *
 * The canonical decimal-to-base-unit conversion used by the checkout server is a
 * separate, tested module (step 2). Do not import this one from `packages/`.
 */
export function formatBaseUnits(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export { Account, KeetaNet, KeetaAnchor };
