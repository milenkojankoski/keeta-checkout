/**
 * Token resolution for Keeta Checkout.
 *
 * A checkout session is priced in one token. Merchants and API callers name that
 * token by ticker (`$USDC`, `usdc`, `EUR`) or by its `keeta_…` address. This module
 * turns either into a {@link ResolvedToken} whose address and decimals come from
 * the network, never from a table in this repository.
 *
 * - Tickers come from the resolver's signed currency map (`listTokens`).
 * - Decimals come from the token account's on-chain metadata (`decimalPlaces`).
 * - Both are cached for the registry's lifetime; call {@link TokenRegistry.refresh}
 *   to drop the caches.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { decodeTokenMetadata } from '@keetanetwork/anchor/lib/token-metadata.js';
import type { TokenAddress } from '@keetanetwork/keetanet-client/lib/account.js';
import { assertDecimals } from './amounts.ts';

type UserClient = InstanceType<typeof KeetaNet.UserClient>;
type Resolver = InstanceType<typeof KeetaAnchor.lib.Resolver>;
type SigningAccount = NonNullable<
  NonNullable<ConstructorParameters<typeof KeetaAnchor.lib.Resolver>[0]['metadataConfig']>['signing']
>['account'];

const { Account } = KeetaNet.lib;

export type TokenErrorCode =
  | 'TOKEN_NOT_FOUND'
  | 'TOKEN_AMBIGUOUS'
  | 'NOT_A_TOKEN'
  | 'TOKEN_METADATA_MISSING';

export class TokenError extends Error {
  override readonly name = 'TokenError';

  constructor(
    readonly code: TokenErrorCode,
    message: string
  ) {
    super(message);
  }
}

export interface ResolvedToken {
  /** The resolver's canonical ticker, such as `$USDC` or `EUR`. `null` for a token the resolver does not list. */
  ticker: string | null;
  /** The token account's `keeta_…` public key string. */
  address: string;
  /** The same token as an SDK account object, ready for `send` and balance calls. */
  account: TokenAddress;
  /** From on-chain metadata. Never hardcoded. */
  decimals: number;
  /** The on-chain token name, or an empty string. */
  name: string;
  /**
   * Whether the token's ledger ACL lets *any* account hold and transfer it, read
   * from the token account's `defaultPermission`.
   *
   * `false` means the token is a permit list: only accounts the issuer has granted
   * `ACCESS` to, directly or through an attached certificate, can hold or send it.
   * A send by anyone else fails with `LEDGER_INVALID_PERMISSIONS`. On main this is
   * how Bivo's original fiat tokens (`USD`, `EUR`, `GBP`, …) are configured.
   *
   * Fails closed: a token whose default permission cannot be read is reported as
   * restricted, because wrongly believing a token is open produces a checkout page
   * that silently cannot be paid.
   */
  openToAnyHolder: boolean;
}

export interface TokenRegistryOptions {
  /** A connected client. Its network decides which tokens exist. */
  client: UserClient;
  /**
   * Account used to sign resolver metadata requests, as the Keeta wallet does. Some
   * providers publish routes only to signed requests. Defaults to the client's own
   * account. Signing a metadata request moves no value.
   */
  signer?: SigningAccount;
  /** Supply your own resolver (tests, custom roots). Overrides `signer`. */
  resolver?: Resolver;
}

/** Strip a leading `$` and upper-case, so `$usdc`, `usdc` and `$USDC` compare equal. */
export function normalizeTicker(input: string): string {
  return input.replace(/^\$/, '').toUpperCase();
}

/**
 * The client's own account as a resolver signer, when it has one.
 *
 * The checkout server runs **key-less**: `UserClient.fromNetwork(network, null)`,
 * whose `account` getter throws "No signer available in a read-only UserClient".
 * Such a client gets an unsigned resolver. Token listings and token metadata are
 * public, so that is enough for pricing; signing matters only for provider routes
 * that are published to signed requests, which the registry does not read.
 *
 * `UserClient.account` is also typed as any kind of account, but only a key pair can
 * sign; a token, storage, multisig or network account (an "identifier") cannot.
 */
function defaultSigner(client: UserClient): SigningAccount | undefined {
  let account: UserClient['account'];
  try {
    account = client.account;
  } catch {
    return undefined;
  }
  if (account.isIdentifier()) {
    throw new TokenError(
      'NOT_A_TOKEN',
      `the client's account ${account.publicKeyString.get()} cannot sign resolver requests; pass a key-pair \`signer\``
    );
  }
  // Narrowed at runtime above; the SDK's negative narrowing does not reach this exact type.
  return account as SigningAccount;
}

/** True when the string parses as a Keeta account address of any kind. */
function looksLikeAddress(input: string): boolean {
  return /^keeta_[a-z0-9]+$/i.test(input);
}

export class TokenRegistry {
  readonly #client: UserClient;
  readonly #resolver: Resolver;
  #listing: Promise<ResolvedToken[]> | undefined;
  readonly #byAddress = new Map<string, Promise<ResolvedToken>>();

  constructor(options: TokenRegistryOptions) {
    this.#client = options.client;
    const signer = options.signer ?? defaultSigner(options.client);
    this.#resolver =
      options.resolver ??
      new KeetaAnchor.lib.Resolver({
        ...getDefaultResolverConfig(options.client),
        ...(signer === undefined ? {} : { metadataConfig: { signing: { account: signer } } })
      });
  }

  /** Drop every cached listing and token. The next call fetches again. */
  refresh(): void {
    this.#listing = undefined;
    this.#byAddress.clear();
  }

  /**
   * Every token the resolver lists on this network, with decimals read from each
   * token's metadata. Cached after the first call. A token whose metadata is missing
   * or malformed is left out of the list and reported through `onSkipped`, so one
   * bad entry cannot take the whole listing down.
   */
  async list(onSkipped?: (address: string, error: unknown) => void): Promise<ResolvedToken[]> {
    this.#listing ??= this.#fetchListing(onSkipped).catch((error: unknown) => {
      // Do not cache a failure: the next caller should retry the network.
      this.#listing = undefined;
      throw error;
    });
    return this.#listing;
  }

  async #fetchListing(onSkipped?: (address: string, error: unknown) => void): Promise<ResolvedToken[]> {
    const entries = await this.#resolver.listTokens();
    const settled = await Promise.allSettled(
      entries.map(async ({ token, currency }) => this.#describe(token, String(currency)))
    );

    const tokens: ResolvedToken[] = [];
    settled.forEach((result, index) => {
      const entry = entries[index];
      if (result.status === 'fulfilled') {
        tokens.push(result.value);
      } else if (entry !== undefined) {
        onSkipped?.(String(entry.token), result.reason);
      }
    });
    return tokens;
  }

  /**
   * Resolve a ticker or a `keeta_…` token address.
   *
   * Tickers match the resolver's canonical form first (`$USDC`), then
   * case-insensitively with or without the `$` (`usdc`, `$usdc`). If that looser
   * match hits more than one listed token the call fails with `TOKEN_AMBIGUOUS`
   * rather than guessing. Addresses are accepted even when the resolver does not
   * list them, as long as the account is a token with readable metadata.
   */
  async resolve(input: string): Promise<ResolvedToken> {
    const trimmed = input.trim();
    if (trimmed === '') {
      throw new TokenError('TOKEN_NOT_FOUND', 'token is empty');
    }

    if (looksLikeAddress(trimmed)) {
      return this.byAddress(trimmed);
    }

    const tokens = await this.list();

    const exact = tokens.find((token) => token.ticker === trimmed);
    if (exact !== undefined) return exact;

    const wanted = normalizeTicker(trimmed);
    const loose = tokens.filter((token) => token.ticker !== null && normalizeTicker(token.ticker) === wanted);

    if (loose.length === 1) return loose[0] as ResolvedToken;
    if (loose.length > 1) {
      throw new TokenError(
        'TOKEN_AMBIGUOUS',
        `"${input}" matches ${loose.length} tokens (${loose.map((token) => token.ticker).join(', ')}); use the exact ticker or the token address`
      );
    }

    throw new TokenError(
      'TOKEN_NOT_FOUND',
      `no token "${input}" on this network; the resolver lists: ${tokens.map((token) => token.ticker).join(', ')}`
    );
  }

  /** Resolve by `keeta_…` address. Cached per address. */
  async byAddress(address: string): Promise<ResolvedToken> {
    let pending = this.#byAddress.get(address);
    if (pending === undefined) {
      pending = this.#resolveAddress(address).catch((error: unknown) => {
        this.#byAddress.delete(address);
        throw error;
      });
      this.#byAddress.set(address, pending);
    }
    return pending;
  }

  async #resolveAddress(address: string): Promise<ResolvedToken> {
    // The resolver's listing already carries the ticker; prefer it when present.
    const listed = (await this.list().catch(() => [] as ResolvedToken[])).find((token) => token.address === address);
    if (listed !== undefined) return listed;
    return this.#describe(address, null);
  }

  /** Decimals for a token, by address or account. Same cache as {@link byAddress}. */
  async decimals(token: string | TokenAddress): Promise<number> {
    const address = typeof token === 'string' ? token : token.publicKeyString.get();
    return (await this.byAddress(address)).decimals;
  }

  /**
   * Read a token's name and decimals from the chain. The one place in the server
   * that touches token metadata.
   */
  async #describe(address: string, ticker: string | null): Promise<ResolvedToken> {
    let account;
    try {
      account = Account.fromPublicKeyString(address);
    } catch (error) {
      throw new TokenError('NOT_A_TOKEN', `"${address}" is not a valid Keeta address: ${String(error)}`);
    }
    if (!account.isToken()) {
      throw new TokenError('NOT_A_TOKEN', `${address} is a Keeta account but not a token`);
    }
    const tokenAccount = account.assertKeyType(Account.AccountKeyAlgorithm.TOKEN);

    const { info } = await this.#client.client.getAccountInfo(tokenAccount);
    if (!info.metadata) {
      throw new TokenError(
        'TOKEN_METADATA_MISSING',
        `${address} has no on-chain metadata, so its decimals are unknown and it cannot be priced`
      );
    }

    let decimals: number;
    try {
      decimals = decodeTokenMetadata(info.metadata).decimalPlaces;
    } catch (error) {
      throw new TokenError('TOKEN_METADATA_MISSING', `${address} has unreadable metadata: ${String(error)}`);
    }
    assertDecimals(decimals);

    // A token account carries its ACL default. `ACCESS` in it means anyone may hold
    // and transfer the token; its absence means a permit list. Absent entirely, we
    // assume restricted rather than open.
    const defaultPermission = 'defaultPermission' in info ? info.defaultPermission : undefined;
    const openToAnyHolder = defaultPermission?.has(['ACCESS']) ?? false;

    return {
      ticker,
      address,
      account: tokenAccount,
      decimals,
      name: info.name ?? '',
      openToAnyHolder
    };
  }
}
