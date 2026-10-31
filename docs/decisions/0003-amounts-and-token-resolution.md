# 0003. Exact amounts, resolver-sourced tokens

Date: 2026-10-30
Status: accepted

## Context

A checkout session is priced in one token. The amount arrives as a decimal string
from a merchant's backend and must become `bigint` base units for a `SEND`. The
token arrives as a ticker or an address. Both conversions are where quiet money bugs
live: a float, a rounding step, or a stale decimals table can underpay a merchant
for months before anyone notices.

Facts checked against `@keetanetwork/anchor` 0.0.105 source and the test network:

- `Resolver.listTokens()` returns `{ token, currency }[]`; the ticker field is
  `currency`, and tickers are passed through verbatim with no case folding.
- Token decimals live in each token account's metadata as `decimalPlaces`, which
  the SDK accepts as an integer from 0 to 1024. KTA has 18 on test.
- `UserClient.account` is typed as any account kind, but only a key pair can sign
  resolver metadata requests. `Account.isIdentifier()` separates the two.

## Decisions

**Amounts (`packages/server/src/amounts.ts`)**

1. No rounding, ever. `parseDecimalAmount("1.005", 2)` throws `TOO_MANY_DECIMALS`.
   A price that cannot be represented exactly is rejected, not adjusted.
2. Excess fraction digits are accepted only when they are all zeros, because the
   value is still exact: `"1.500"` at 2 decimals is `150n`.
3. The accepted grammar is strict ASCII: `^[0-9]+(\.[0-9]+)?$`. No sign, exponent,
   separators, whitespace, or Unicode digits. Trimming is the HTTP layer's job.
4. `"0"` parses to `0n`. Whether zero is a valid session amount is decided where
   sessions are created, not in the parser.
5. `formatBaseUnits` trims trailing zeros by default and pads with `{ fixed: true }`.
   It is the exact inverse of the parser; the test suite round-trips fixed and
   pseudo-random values up to 2^128 across 0 to 30 decimals.
6. `decimals` is validated against the same 0..1024 range the SDK enforces.

**Tokens (`packages/server/src/tokens.ts`)**

7. Addresses and decimals come from the resolver and on-chain metadata at runtime.
   There is no token table in the repository.
8. Ticker lookup tries the exact resolver spelling first, then a case-insensitive
   match with the `$` optional. If the loose match hits more than one token the call
   fails with `TOKEN_AMBIGUOUS`; the registry never picks one.
9. A `keeta_…` address is accepted even when the resolver does not list it, provided
   the account is a token with readable metadata. Its `ticker` is then `null`.
10. Listings and per-address lookups are cached for the registry's lifetime and
    deduplicated in flight. Failures are not cached. `refresh()` drops everything.
11. A token with missing or malformed metadata is skipped from `list()` and reported
    through a callback, so one bad entry does not break pricing in every other token.
12. The default resolver signer is the client's own account, after a runtime
    `isIdentifier()` check. A non-key-pair account is a configuration error and
    throws at construction.

## Consequences

- `tools/keeta.ts` keeps its own display-only formatter so dev scripts do not depend
  on `packages/server`. It must not be imported from `packages/`.
- The session API (step 3) must reject `0n` itself and trim input before parsing.
- The watcher (step 5) compares `bigint` to `bigint`. It never formats and reparses.
- When Keeta publishes a resolver listing with two tickers that differ only in case
  or `$`, loose lookups for that pair start failing loudly. That is intended.
