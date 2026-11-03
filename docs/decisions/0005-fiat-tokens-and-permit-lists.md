# 0005. Fiat tokens: two different gates, only one of them on-chain

Date: 2026-10-30
Status: accepted

## Context

The working assumption was that Keeta's fiat tokens (`$KBUSD`, `$KBEUR`, …) require
a KYC or KYB certificate attached to the account before they can be held. That is
true in practice but **not** as a ledger permission, and the difference decides what
the checkout server can enforce.

Measured on 2026-10-30 by reading every resolver-listed token's
`defaultPermission` on both networks:

| Network | Tokens | Ledger ACL |
| --- | --- | --- |
| test | `$KTA` `$USDC` `$EURC` `$CBBTC` `$KUSD` `$KEUR` `$RUSD` | all `["ACCESS"]`, open to any holder |
| main | `$KTA` `$USDC` `$EURC` `$cbBTC` | `["ACCESS"]` |
| main | `$KBUSD` `$KBEUR` `$KBGBP` `$KBJPY` `$KBCAD` `$KBMXN` `$KBAED` | `["ACCESS"]` — **open at the ledger** |
| main | `$KUSD` `$KEUR` `$KGBP` `$KJPY` `$KCAD` `$KMXN` `$KCNY` `$KHKD` `$KAED` | `["ACCESS"]` |
| main | `USD` `EUR` `GBP` `JPY` `CAD` `MXN` `CNY` `HKD` `AED` | `[]` — **permit list** |

So there are two distinct classes, and they fail differently:

1. **Permit-listed tokens** are Bivo's original bare-ISO-code fiat tokens (`USD`,
   `EUR`, …). Their default permission is empty, so only accounts the issuer granted
   `ACCESS` to, directly or through an attached certificate, can hold or send them.
   Anyone else gets `LEDGER_INVALID_PERMISSIONS`. This is detectable from the chain.
2. **Open-but-KYC-acquired tokens** are the `$KB` stablecoins Bivo is migrating to.
   The ledger lets anybody hold them. The gate is upstream: the only way to *get*
   `$KBUSD` is a bank deposit, card pull or conversion through Bivo, all of which
   need Bivo KYC. Nothing on-chain reveals this.

Keeta's `keeta-rails` reference describes exactly this migration ("USD on main, moving to `$KBUSD`"), and
separately warn that "fiat tokens issued by a provider can carry transfer rules set
by their issuer. To pay someone in fiat, use a payout rather than sending the token
directly."

## Decision

**Price checkout sessions only in tokens whose ledger ACL is open to any holder.**

- `ResolvedToken` gains `openToAnyHolder`, read from the token account's
  `defaultPermission` and **failing closed**: a token whose default permission cannot
  be read counts as restricted. Believing a restricted token is open produces a
  checkout page that silently cannot be paid, which is the worst outcome available.
- `CheckoutService` rejects a restricted token at session creation with
  `TOKEN_NOT_TRANSFERABLE`, naming payouts as the way to settle in fiat. The check
  runs *before* the merchant's accepted-token list, so a merchant who configured one
  by mistake is told the real reason rather than "not accepted".
- With no configured list, `acceptedTokens()` returns only open tokens, so a default
  install never offers something a shopper cannot pay with.
- `GET /api/tokens` reports `openToAnyHolder` per token.

**The second class is handled by documentation, not validation.** `$KBUSD` passes
every on-chain check and a send would succeed, so the server cannot and should not
refuse it. What makes it a poor choice for checkout is that essentially no shopper
holds it: acquiring it requires Bivo onboarding. A merchant who deliberately
configures `acceptedTokens: ['$KBUSD']`, perhaps for business-to-business invoicing
between two onboarded parties, is allowed to.

## Consequences

- On the test network nothing changes: every listed token is open.
- On main the nine bare-ISO-code fiat tokens can no longer be used to price a
  session. That is a feature; a session priced in them was never payable by a
  shopper.
- The recommended pricing token stays `$USDC`, with `$EURC` for euro pricing.
- Settling in real fiat is a separate step from checkout: take `$USDC`, then use a
  Keeta payout to a bank account, which is where KYC or KYB legitimately belongs.
  That path needs the merchant verified, and for a business it needs KYB, which the
  v2 cash-out work in README section 12 already covers.
- `openToAnyHolder` is read once per token and cached with the rest of the token
  record. An issuer who later changes a token's default permission is not noticed
  until `refresh()`. Acceptable: the value changes approximately never, and a stale
  *open* reading can only cause the failure we would have had anyway.
- Should Keeta add the certificate-based transfer rules its docs describe as a
  roadmap item, a token could become unpayable without its default permission
  changing. Revisit this record then.
