/**
 * Test doubles, so the session and HTTP suites run with no network and no wallet.
 *
 * The token registry is faked rather than stubbed at the network layer: its real
 * behaviour is covered against the live test network in `tokens.test.ts`, and what
 * the session layer needs from it is just "resolve a name to an address and a number
 * of decimals".
 */
import { TokenError, type ResolvedToken, type TokenRegistry } from '../../src/tokens.ts';
import { normalizeTicker } from '../../src/tokens.ts';
import { resolveConfig, type CheckoutConfig, type CheckoutConfigInput } from '../../src/config.ts';

/** A valid test-network account address, used as the merchant's receiving account. */
export const MERCHANT_ADDRESS = 'keeta_aabvt3ni7qohr2agcfypfjc4jaupt3i5lfyf53buw45t6btjuehjxhkqfr5u2fi';
/** A second valid account address, standing in for a payer. */
export const PAYER_ADDRESS = 'keeta_aaba3ymbcosy6iyatjhociuj7uiprjqqp4mivysmh256sy7l5hdmhcxczf4ii4i';

/** Real test-network token addresses, so nothing here is a made-up identifier. */
export const USDC = 'keeta_aosjk5tgpgxr3qazd2abxyhj4srqua5c3xgz4lmgxuyrrwzryiqng4vacgwai';
export const KTA = 'keeta_anyiff4v34alvumupagmdyosydeq24lc4def5mrpmmyhx3j6vj2uucckeqn52';
export const EURC = 'keeta_aogdlknya2kklogum3uwblyeycc6dwtygzu77gdnip2nfsqcfmirvqklrdmes';

export const API_KEY = 'test_key_000000000000000000';

/**
 * Bivo's original USD token on main, read from the resolver on 2026-10-30. Its
 * ledger default permission is empty, so it is a permit list. Used here to exercise
 * the restricted-token path with a real identifier rather than an invented one.
 */
export const FIAT_USD = 'keeta_aonxxqry6rknxyb6c5q2ybxk2gt776xlchhcohhyla5kqvinnaduevuxyx3tc';
/** Bivo's newer open stablecoin on main, for contrast. Default permission is ACCESS. */
export const KBUSD = 'keeta_amg5vtcaylfhat3icwosxnibxf3ndimxnxfu3txbrwhra6ry75muct7d3lxwa';

export const FAKE_TOKENS: ResolvedToken[] = [
  { ticker: '$USDC', address: USDC, decimals: 6, name: 'USDC', openToAnyHolder: true },
  { ticker: '$KTA', address: KTA, decimals: 18, name: 'KTA', openToAnyHolder: true },
  { ticker: '$EURC', address: EURC, decimals: 6, name: 'EURC', openToAnyHolder: true },
  // A permit-listed token, as Bivo's original fiat tokens are on main: the ledger
  // only lets accounts its issuer approved hold or send it.
  { ticker: 'USD', address: FIAT_USD, decimals: 2, name: 'USD', openToAnyHolder: false }
].map((token) => ({ ...token, account: undefined as never }));

/**
 * A token registry over a fixed list. Mirrors the real one's contract: exact ticker
 * first, then a case-insensitive match with the `$` optional, then address lookup,
 * and the same {@link TokenError} codes.
 */
export class FakeTokenRegistry implements Pick<TokenRegistry, 'list' | 'resolve' | 'byAddress' | 'decimals' | 'refresh'> {
  constructor(private readonly tokens: ResolvedToken[] = FAKE_TOKENS) {}

  refresh(): void {
    /* nothing cached */
  }

  list(): Promise<ResolvedToken[]> {
    return Promise.resolve([...this.tokens]);
  }

  resolve(input: string): Promise<ResolvedToken> {
    const trimmed = input.trim();
    if (trimmed === '') {
      return Promise.reject(new TokenError('TOKEN_NOT_FOUND', 'token is empty'));
    }
    if (/^keeta_[a-z0-9]+$/i.test(trimmed)) return this.byAddress(trimmed);

    const exact = this.tokens.find((token) => token.ticker === trimmed);
    if (exact !== undefined) return Promise.resolve(exact);

    const wanted = normalizeTicker(trimmed);
    const loose = this.tokens.filter((token) => token.ticker !== null && normalizeTicker(token.ticker) === wanted);
    if (loose.length === 1) return Promise.resolve(loose[0] as ResolvedToken);
    if (loose.length > 1) {
      return Promise.reject(new TokenError('TOKEN_AMBIGUOUS', `"${input}" matches ${loose.length} tokens`));
    }
    return Promise.reject(
      new TokenError(
        'TOKEN_NOT_FOUND',
        `no token "${input}" on this network; the resolver lists: ${this.tokens.map((t) => t.ticker).join(', ')}`
      )
    );
  }

  byAddress(address: string): Promise<ResolvedToken> {
    const found = this.tokens.find((token) => token.address === address);
    if (found === undefined) {
      return Promise.reject(new TokenError('NOT_A_TOKEN', `${address} is not a known token`));
    }
    return Promise.resolve(found);
  }

  async decimals(token: string): Promise<number> {
    return (await this.byAddress(token)).decimals;
  }
}

/** A valid configuration with sensible defaults, overridable per test. */
export function testConfig(overrides: Partial<CheckoutConfigInput> = {}): CheckoutConfig {
  return resolveConfig({
    network: 'test',
    receivingAddress: MERCHANT_ADDRESS,
    apiKeys: [API_KEY],
    acceptedTokens: [],
    publicUrl: 'https://shop.example',
    ...overrides
  });
}

/** A clock the test moves by hand, so expiry needs no waiting. */
export class FakeClock {
  constructor(private current = Date.UTC(2026, 9, 30, 12, 0, 0)) {}

  now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

/** The registry fake, typed as the real thing for the service constructor. */
export function fakeRegistry(tokens?: ResolvedToken[]): TokenRegistry {
  return new FakeTokenRegistry(tokens) as unknown as TokenRegistry;
}
