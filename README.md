# Keeta Checkout

**A free, open-source "accept Keeta payments on your website" layer.**
Stripe-shaped API, drop-in pay button, hosted pay page, webhooks, and e-commerce plugins, all settling directly to the merchant's own Keeta account in about 400 ms with no processor fee.

Status: 2026-10-30. **v1 is runnable.** Steps 0 to 9 of the build order (section 13)
are done, so a merchant can go from nothing to a paid order with four commands:

```bash
npx keeta-checkout init     # configure, and generate the secrets
npx keeta-checkout check    # confirm the address and tokens work on this network
npx keeta-checkout serve    # take payments
```

416 tests pass, ten of them publishing real blocks on the Keeta test network and
watching them get credited. Start at [`docs/quickstart.md`](docs/quickstart.md), or
[`docs/development.md`](docs/development.md) to work on it.

There is a **WooCommerce plugin** in `plugins/woocommerce/`, and any shop with a
backend can integrate directly with a session, a script tag and the pay button.

Published as **v0.1.0**: `npx keeta-checkout` on npm, the image
`ghcr.io/milenkojankoski/keeta-checkout`, and the WooCommerce plugin zip on the
[GitHub release](https://github.com/milenkojankoski/keeta-checkout/releases).

Still to come: the reference integration (step 10),
refunds (step 13), and the Shopify app (step 14).

---

## 1. Why this exists

Keeta already has every rail a merchant needs: one account that holds USDC, EURC, fiat tokens and KTA, sub-second settlement, native tokens, permissions, identity certificates, and anchors to banks, cards, FX and other chains. What it does not have is the thin layer every web merchant actually integrates against:

| Stripe gives merchants | Keeta gives merchants today |
| --- | --- |
| `stripe.checkout.sessions.create()` | `encodeKeetaURI({ type: 'send', ... })` and a raw SDK |
| Hosted Checkout page | Nothing |
| Webhook with signature verification | `client.on('change')` on your own account, or polling `getHistory()` |
| WooCommerce / Shopify / Magento plugins | Nothing |
| Refund API | `client.send()` back to the payer, by hand |
| Dashboard with orders | The block explorer |

Keeta Checkout fills that gap. It is deliberately boring: it looks like the Stripe integration developers already know, so switching a shop from "Pay by card" to "Pay with Keeta" is one afternoon, not a project.

**As a Keeta incentive.** Merchants get a zero-fee, instantly settled payment method they can switch on with a public address and no onboarding. That seeds acceptance on the merchant side before the consumer side (wallet adoption) has caught up, which is the chicken-and-egg problem the network needs solved.

## 2. What it is not

- **Not a card acquirer.** Keeta's only card rail is Bivo's Visa Direct `CARD_PULL`, which charges a KYC'd user's *own* card into *their own* balance. There is no "charge a stranger's card, credit the merchant" primitive on Keeta, so Keeta Checkout cannot replace Stripe for buyers who only have a card. It is an additional payment method, not a replacement.
- **Not a custodian.** The checkout server never holds the merchant's funds. Payments go straight from the payer's account to the merchant's account on the network.
- **Not a tax engine.** Prices, VAT and invoices stay the merchant's job. The package only requests and detects exact amounts.

## 3. Who it is for

- **Merchants:** any site that can run a small Node service or install a plugin. They need a Keeta account (a seed in a secret store) and nothing else. No KYC is needed to *receive* tokens. KYB (Keeta's business verification, 33 countries) is only needed later for bank cash-out through business-capable providers such as HopNow.
- **Payers:** anyone with a funded Keeta wallet (Keeta Personal at <https://wallet.keeta.com>, or any app built on the SDK). They scan a QR or tap a `keeta://` deep link, see the pre-filled amount, token and recipient, and approve.
- **Agents:** an agent with a Keeta wallet can pay a checkout URI programmatically, which makes this the simplest "agent buys a thing from a shop" rail there is.

## 4. Components

```
+----------------------+   create session    +-------------------------+
| Merchant backend     | ------------------> | keeta-checkout (server) |
| (shop, booking app)  | <------------------ |  - sessions store       |
|                      |   webhook: paid     |  - URI / QR builder     |
+----------------------+                     |  - account watcher      |
            |                                |  - hosted pay page      |
            | embeds                         +-----------+-------------+
            v                                            | watches
+----------------------+                     +-----------v-------------+
| <keeta-pay-button>   |   pays keeta:// URI | Keeta network           |
| (browser component)  | ------------------> | merchant account        |
+----------------------+   via wallet / QR   +-------------------------+
```

### 4.1 `@keeta-checkout/server` (Node 24, ESM, TypeScript)

- Creates **checkout sessions**: amount, token, order reference, success and cancel URLs, expiry.
- Builds the **payment request** as a `keeta://` URI with `encodeKeetaURI` from `@keetanetwork/anchor`, and renders it as a QR code.
- **Watches the merchant account** for the matching incoming send and marks the session `paid`.
- Emits **webhooks** (HMAC-signed, retried) and exposes a small REST API.
- Serves an optional **hosted pay page** (`/pay/:sessionId`) for merchants who do not want to embed anything.
- Runs in **watch-only mode** by default: it needs only the merchant's *public* address. No key ever touches the checkout server unless the merchant enables refunds.

### 4.2 `@keeta-checkout/button` (browser)

- A web component `<keeta-pay-button session-id="…" base-url="…">`, and a React wrapper with React as an optional peer dependency.
- Shows the amount and token ticker; opens a panel with the QR, the deep link and the details to pay by hand.
- Subscribes to the event stream **and** polls every five seconds, so a buffering proxy or a browser without `EventSource` still notices settlement.
- Emits `keeta-paid`, `keeta-expired`, `keeta-cancelled`, `keeta-unmatched` and `keeta-error`, bubbling out of the shadow root with the session in `detail`.
- Shadow DOM, no dependencies, and everything set with `textContent`: a shop cannot restyle a payment control by accident, and nothing from the server is ever parsed as markup.

### 4.3 Plugins

- **WooCommerce** (PHP): a redirect gateway that creates a session, sends the customer to the hosted pay page, and completes the order from the signed webhook. Dedupes on `event.id`, verifies against the raw body, and checks the stored session id so a forged order id cannot complete the wrong order. Warns when the chosen token and the store currency disagree, since no conversion is performed.
- **Shopify**: an app using Shopify's payments-app flow or a manual-payment-plus-redirect flow, depending on what the store tier allows.
- Others later (Medusa, Saleor, PrestaShop) once the REST contract is stable.

### 4.4 `@keeta-checkout/refunds` (optional, separate process)

- Holds a **delegated signing account**, not the merchant's main key: the merchant grants that account `SEND_ON_BEHALF` scoped to the payout token on the receiving account or vault.
- Exposes `refund(sessionId, amount?)`, which sends back to the original payer address recorded on the session.
- Kept separate so a compromised checkout server cannot move funds.

## 5. Payment flow

1. **Merchant backend** calls `POST /api/sessions` with `{ amount, currency, orderId, successUrl, cancelUrl, expiresIn }`.
2. **Server** resolves `currency` to a token address through the resolver (`resolver.lookupToken('$USDC')`, `'EUR'`, ...), reads the token's `decimalPlaces` from on-chain metadata, converts the decimal amount to `bigint` base units, and stores the session as `open`.
3. **Server** returns the session plus `uri`, `qrSvgUrl` and `hostedUrl`. The QR
   itself is served from its own route rather than inlined, because the SVG is
   around 6 KB and would otherwise repeat on every status poll and every event.
   `hostedUrl` is absolute when the server knows its own public URL, and `null`
   otherwise. The URI is:

   ```ts
   KeetaAnchor.lib.URI.encodeKeetaURI({
     type: 'send',
     to: merchantAccount,            // or the merchant's receive vault (storage account)
     token: tokenAddress,
     value: baseUnits,               // bigint
     external: [sessionRef]          // first item lands in the SEND operation's `external` field
   });
   ```

   `sessionRef` is at most 1024 characters from `[-_A-Za-z0-9+/= ]`, which is the network's `external` constraint. We use a short random ID, never the merchant's own order number, so that references cannot be guessed and replayed.
4. **Payer** opens the link or scans the QR in a wallet, sees recipient, token and amount pre-filled, and approves. The send settles in about 400 ms. Incoming sends on Keeta need no `receive` action by the merchant.
5. **Watcher** sees a new block on the merchant account, finds a `SEND` to the merchant with matching token, value and `external`, and marks the session `paid` with the payer's address and the block hash. See section 7 for the exact matching rule.
6. **Server** fires the `checkout.session.paid` webhook. The merchant backend fulfils the order. The button or hosted page shows **Paid** and redirects to `successUrl`.
7. If no matching send arrives before `expiresAt`, the session becomes `expired` and a `checkout.session.expired` webhook fires. A late payment to an expired session is recorded as `unmatched` so the merchant can refund it (section 4.4).

## 6. REST API (Stripe-shaped)

| Method and path | Purpose |
| --- | --- |
| `POST /api/sessions` | Create a session. Body: `amount` (decimal string), `currency` (`$USDC`, `$EURC`, `EUR`, ...), `orderId`, `successUrl`, `cancelUrl`, `expiresIn` (seconds, default 1800). |
| `GET /api/sessions/:id` | Status: `open`, `paid`, `expired`, `cancelled`, `unmatched`. Includes `uri`, `qrSvg`, `hostedUrl`, `paidBy`, `blockHash`, `explorerUrl`. |
| `POST /api/sessions/:id/cancel` | Merchant or payer cancelled. |
| `GET /api/sessions/:id/events` | Server-sent events for the button. |
| `GET /api/sessions/:id/qr.svg` | The payment QR as an SVG image, for `<img src>`. |
| `GET /api/payments` | The payments ledger: every inbound send seen and what it was. `?disposition=underpaid,late` narrows to what needs refunding. |
| `GET /api/webhook-deliveries` | Webhook attempt history: what was sent, what failed, what gave up. |
| `GET /pay/:id` | The hosted pay page. Works with JavaScript switched off. |
| `POST /pay/:id/cancel` | The no-JavaScript cancel path: cancels, then redirects to the shop. |
| `POST /api/refunds` | Only if the refunds process is enabled. |
| `GET /api/tokens` | Tokens the merchant accepts, with ticker, address and decimals, from the resolver. |

**Webhook events.** `checkout.session.paid`, `checkout.session.expired`, `checkout.session.cancelled`, `checkout.session.unmatched`, and `checkout.payment.recorded`. (`refund.sent` arrives with the refunds process in v2.)

`checkout.payment.recorded` is the one not to skip: an underpayment, a send with no reference, or one in the wrong token changes no session status, so without it that money sits with the merchant unnoticed. It carries a `refundable` flag. It is not sent for a credited payment, which already produced `checkout.session.paid`.

Each delivery carries a `Keeta-Checkout-Signature: t=<unix>,v1=<hex>` header, HMAC-SHA256 over `${t}.${rawBody}`, and is retried on a backoff that spans a little under 24 hours before the delivery is marked exhausted. `verifyWebhookSignature` is exported for merchants to use in their handler; `examples/express-shop/verify-webhook.mjs` is a complete one.

**Delivery is at-least-once and not ordered.** Dedupe on `event.id`, and decide from the session state in the body rather than from arrival order. The payload is frozen when the event is created, so a retry carries the identical bytes.

Authentication for the merchant backend is a bearer API key issued by the checkout server. That key authorises *creating sessions and reading status*; it can never move funds.

## 7. Settlement detection

**Polling `getHistory`.** The server is watch-only and holds no key, so its client has no signing account, and `client.on('change')` is a websocket filtered to the client's own account. Polling `client.getHistory(receivingAddress, { pageSize, startBlocksHash })` needs only the public address. History arrives newest-first with an exclusive cursor; the watcher pages back to the last staple it processed (persisted in the store), collects every inbound `SEND`, and processes them **oldest-first**. Measured against the test network, not assumed; see `docs/decisions/0007`.

**A payment is one `SEND` operation**, identified by block hash **and** operation index. A payment lives in the payer's block, and one block can carry several sends to several accounts, so the block hash alone identifies nothing.

**Matching rule.** For a `SEND` whose recipient is the receiving account, in this order:

- no `external`, or one no session has → recorded, nothing credited;
- token differs from the session's → recorded as `wrong_token`, nothing credited;
- session already `cancelled` → recorded, stays cancelled;
- session already `paid`: the identical send is a replay; any other send is a `duplicate` and the session becomes `unmatched`;
- block settled after the session's grace window → `late`, session becomes `unmatched`;
- amount **less than** owed → `underpaid`, **session stays open** so the payer can still pay in full;
- otherwise `matched` or `overpaid`, and the session is `paid` with `overpaidBy` set when there is excess.

Time is judged by the block's date, never the watcher's clock, and time beats amount. Amounts are compared as `bigint`.

**The payments ledger.** Every inbound send is recorded with its disposition, whether or not it was credited, and `GET /api/payments` lists them with a `refundable` flag. The ledger is keyed on (block hash, operation index), which is what makes re-scanning after a restart harmless: correctness lives in the store, the cursor is only for speed.

**Finality.** Keeta blocks are final once published with a vote staple, so one observation is enough. There is no confirmation count.

## 8. Where the money lands

Default: the merchant's key-pair account, identified only by its public `keeta_...` address.

Recommended for anything beyond a hobby shop: a **storage account** (a generated vault) as the receiving address, with the merchant's cold key as `OWNER`, deposits allowed, and a separate low-privilege account delegated `SEND_ON_BEHALF` for refunds only. The checkout server then holds no key at all, and the refund process holds a key that can only move the payout token. The network enforces balances, ACL flags and signatures; it does **not** enforce spending caps, so the refund process adds an application-level daily cap that fails closed.

## 9. Tokens and currencies

The checkout server never hardcodes token addresses. On startup it builds a signed resolver and lists what the network offers:

```ts
const resolver = new KeetaAnchor.lib.Resolver({
  ...getDefaultResolverConfig(client),
  metadataConfig: { signing: { account } }
});
const tokens = await resolver.listTokens();
// main: USD, EUR, $USDC, $EURC, $KBUSD, $KBEUR, $KUSD, $KEUR, $cbBTC, ...
// test: $USDC, $EURC, $KUSD, $KEUR, ...
```

Merchants pick which tickers to accept in config. A session is priced in one token; multi-token pricing (quote once, accept any) is a later feature built on the FX anchors (`KeetaAnchor.FX.Client.getQuotes`).

**Not every listed token can be used for checkout.** A session may only be priced in a token whose ledger ACL is open to any holder, because a shopper's wallet has to be able to send it. On main, Bivo's original fiat tokens (`USD`, `EUR`, `GBP`, …) are permit lists: only accounts their issuer approved can hold or send them, so a session priced in one would never be payable. The server reads each token's `defaultPermission` and refuses those with `TOKEN_NOT_TRANSFERABLE`.

Bivo's newer `$KB` stablecoins (`$KBUSD`, `$KBEUR`, …) are open at the ledger, so they pass that check, but acquiring them requires Bivo KYC. They are therefore a poor default for a public shop and a reasonable choice only for invoicing between two onboarded parties. Settling in real fiat belongs in a payout after checkout, not in the token a shopper pays with. See `docs/decisions/0005-fiat-tokens-and-permit-lists.md`.

Decimals are always read from the token's on-chain metadata with `decodeTokenMetadata(info.metadata).decimalPlaces`, because published KTA decimals have differed between docs and tools.

## 10. Stack and versions

Pinned to what Keeta has published as of 2026-10-29:

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | 24.14.1 in CI | The exact version `@keetanetwork/anchor` pins. Node 22.13.1 works locally; see `docs/decisions/0001-node-24-via-pnpm.md` |
| `@keetanetwork/keetanet-client` | 0.18.8 | Network client: `UserClient.fromNetwork`, `send`, `getHistory`, `on('change')` |
| `@keetanetwork/anchor` | **0.0.105** | Latest version published to npm on 2026-10-29. Upstream git tagged 0.0.106 on 2026-10-28 but has not published it; see `docs/decisions/0002-pinned-sdk-versions.md`. Provides `lib.URI.encodeKeetaURI` / `parseKeetaURI`, `lib.Resolver`, `lib.BlockListener`, `lib/history` enrichment, token metadata decoder, FX and KYC clients |
| `@x402/keeta`, `@x402/core`, `@x402/express`, `@x402/fetch` | 2.28.0 | Optional: a per-request "pay-per-call" mode for APIs, reusing the same session store |
| `qrcode` | latest | QR rendering as SVG |
| TypeScript, `tsx`, `vitest` | latest | Build and tests |
| Storage | SQLite by default, Postgres adapter | Sessions, events, webhook deliveries |

Browser without a bundler: load `https://static.test.keeta.com/keetanet-browser.js` (test) for the button's optional "pay from this browser" mode. The default button needs no Keeta code at all; it only renders a URI and polls.

Networks: `test` (ID 1413829460, faucet at <https://faucet.test.keeta.com>) for development and CI; `main` (ID 21378) for real value. The network is an explicit config value, never inferred from an address.

## 11. Security rules (non-negotiable)

1. The checkout server runs **watch-only** by default and stores no seed or private key.
2. Keys, when the refunds process is enabled, come from a secret store and are never logged, printed or committed. Only public `keeta_...` addresses appear in output.
3. Amounts are `bigint` base units end to end. Decimal strings appear only at the API boundary.
4. Session references are random and unguessable; the merchant's order ID is stored alongside, never in `external`.
5. Webhooks are signed; the merchant's example code verifies the signature before trusting `paid`.
6. One publish at a time per signing account in the refunds process, with `recover()` and a `getHistory()` check after any ambiguous failure.
7. The pay page shows network, token, recipient and amount before the wallet is opened, so the payer confirms exactly what moves.
8. **The operator rate limits at the edge.** The payer routes are authorised by the session id alone, and on a live shop anyone who can reach a checkout can mint one. The server bounds what it can (20 event streams per session) but deliberately ships no rate limiter, because one inside the application invites operators to believe they do not need one in front of it. Put a limit on `/pay/`, `/api/sessions/` and `/qr.svg` at the proxy that already terminates TLS.

Reviewed against the code on 2026-10-31: `docs/decisions/0013-security-review.md` records the evidence for each rule, what was fixed, and what was investigated and found not to be a problem.

## 12. Scope

**v1 (the giveaway)**

- Server with sessions, URI and QR, watcher, webhooks, hosted pay page, SQLite.
- Web component button and React wrapper.
- WooCommerce plugin.
- Docker image and `npx keeta-checkout init`, which asks for network, receiving address and accepted tickers, then writes config.
- Reference integration: the Austrian holiday-rental webapp in `Documents/Airbnb/Webapp`, which already has a hold-then-confirm booking state machine and a Stripe Checkout path. "Mit Keeta bezahlen" becomes a second button next to "Sofort buchen", and the Keeta watcher replaces the Stripe webhook for that path.

**v2**

- Refunds process with delegated `SEND_ON_BEHALF` account and daily cap.
- Shopify app.
- Multi-token acceptance with FX quotes.
- x402 mode for APIs and paid content.
- Merchant dashboard: sessions, payers, explorer links, CSV export.
- "Cash out to bank" guidance using the new business features: Keeta KYB certificate (UBO attributes and register of UBOs, added in anchor 0.0.105 and 0.0.106) and business-capable payout providers such as HopNow, where listed.

**Out of scope**

- Card acceptance from unverified payers (not possible on Keeta today).
- Custody, escrow or holding funds on behalf of merchants.
- Tax calculation and invoicing.

## 13. Build order

Each step ends with a check that must pass before the next starts. Steps marked for independent review are the ones where a subtle mistake moves or loses money, or where the SDK's behaviour has to be read from source rather than docs; they get a second pair of eyes before release.

Setup instructions and the current state of the test wallets are in
[`docs/development.md`](docs/development.md).

| Step | What gets built | Review | Why |
| --- | --- | --- | --- |
| 0 | Monorepo scaffold: pnpm workspaces, TypeScript, ESLint, vitest, Node 24 pin, CI on test network |  | Boilerplate. **Done 2026-10-29** |
| 1 | Test wallet setup: two seeds in a local secret store (merchant and payer), faucet funding script, explorer links |  | Follows the quickstart verbatim. **Done 2026-10-29**: both wallets hold 10 test KTA |
| 2 | Token resolution: signed resolver, `listTokens`, `lookupToken`, decimals from on-chain metadata, decimal-string to `bigint` conversion with tests | independent | Decimals and base units are where money math goes wrong; KTA decimals have differed between docs and tools. **Done 2026-10-30**: `packages/server/src/{amounts,tokens}.ts`, 28 tests, `docs/decisions/0003` |
| 3 | Session store and REST API: SQLite schema, create / get / cancel, API-key auth, server-sent events |  | Standard CRUD. **Done 2026-10-30**: `packages/server/src/{config,errors,sessions/*,http/*}.ts`, 151 tests, `docs/decisions/0004` |
| 4 | URI and QR: `encodeKeetaURI`, random session reference within the `external` constraints, QR as SVG, `parseKeetaURI` round-trip tests |  | Thin wrapper over one SDK call. **Done 2026-10-30**: `packages/server/src/payment-request.ts`, 185 tests, `docs/decisions/0006` |
| 5 | **Watcher and matching rule:** `BlockListener` or `getHistory` cursor, `on('change')` path, exact token / value / `external` match, overpaid and unmatched states, block-hash idempotency, restart safety | independent | The core correctness risk: a cursor or comparison bug marks unpaid orders as paid. **Done 2026-10-30**: `packages/server/src/watcher/*`, payments ledger, 261 tests, `docs/decisions/0007` |
| 6 | End-to-end test: create session, pay it from the payer account, see it flip to `paid`; plus underpay, wrong token, missing reference, duplicate send, and expiry cases | independent | Defines the acceptance bar for everything after it. **Done 2026-10-30**: `test/e2e.live.test.ts`, nine real blocks on the test network, `docs/decisions/0008` |
| 7 | Webhooks: HMAC signing, delivery log, retry with backoff, verification helper for merchants |  | Well-trodden pattern. **Done 2026-10-30**: `packages/server/src/webhooks/*`, 333 tests, `docs/decisions/0009` |
| 8 | Hosted pay page and `<keeta-pay-button>` web component, React wrapper, polling and SSE, copy-address fallback |  | UI work. **Done 2026-10-30**: `packages/server/src/http/pay-page.ts`, `packages/button/src/*`, 392 tests, `docs/decisions/0010` |
| 9 | `npx keeta-checkout init`, Docker image, docs site |  | Tooling. **Done 2026-10-30**: `packages/cli`, esbuild bundles, `docker/`, `docs/quickstart.md`, 416 tests, `docs/decisions/0011`. No generated docs site; see that record |
| 10 | Reference integration into the Airbnb webapp: "Mit Keeta bezahlen" next to "Sofort buchen", watcher replaces the Stripe webhook for that path | independent | The booking state machine already exists; the review checks the hold-and-expiry interaction |
| 11 | WooCommerce plugin |  | PHP gateway against the stable REST contract. **Done 2026-10-30**: `plugins/woocommerce/`, 122 PHP assertions including 12 cross-language signature fixtures, `docs/decisions/0012`. Run inside WordPress 7.1.4 with WooCommerce 11.2.1; the block checkout needed its own `AbstractPaymentMethodType` registration. Re-reviewed in step 12: a dropped-payment path and a broken cancel button found and fixed, see `docs/decisions/0013` |
| 12 | **Security review** of the whole v1 against section 11, and a review of SDK usage against the current anchor source | independent | **Done 2026-10-31**, two passes: a first pass (rules verified, advisories 8 down to 2, stream cap, API headers) and an independent second pass that found the server dying on a Keeta node outage and a plugin path that dropped a real payment; both fixed, `docs/decisions/0013` |
| 13 | **Refunds process (v2):** storage-account vault, `SEND_ON_BEHALF` delegation scoped to the payout token, signer-paid fees, daily cap that fails closed, `recover()` after ambiguous failures | independent | Wrong ACLs leak the merchant's funds. **In progress 2026-11-03**: `packages/refunds` (vault, process, SDK signer), ledger and API in `packages/server`, proven on the test network, `docs/decisions/0014`. Remaining: the `refunds` CLI commands and the plugin button |
| 14 | Shopify app, multi-token acceptance with FX quotes, dashboard |  | Product work on top of a proven core |
| 15 | x402 mode | independent | The `@x402/keeta` facilitator flow is new and thinly documented |

**Review rules during any step**

- Stop and write the decision down in `docs/decisions/` when the SDK's types or runtime behaviour disagree with Keeta's documentation, when a test fails for a reason you cannot explain in one sentence, or when touching anything that signs and publishes a block. Carry on only once the record exists and the tests for it pass.
- Every pull request that touches `packages/server/src/watcher`, `packages/refunds`, or amount conversion gets an independent review, regardless of who wrote it.

## 14. Open questions

- **Payer attribution.** The payer's address is recorded, but a wallet may pay from a different account than the one the user expects. The refund flow should let the merchant override the refund address with explicit confirmation.
- **Expired-then-paid.** Sessions expire at a fixed time, but a payer who scanned the QR a second before expiry still pays. We hold `expired` sessions for 10 more minutes in a grace state before treating late sends as `unmatched`.
- **Wallet deep-link support.** `keeta://` URIs currently support only the `send` action. We should confirm which wallets register the scheme on mobile and desktop before promising one-tap payment.
- **Shopify constraints.** Whether a third-party payment method can be a first-class checkout option depends on Shopify plan and region. The manual-payment-plus-redirect fallback may be what most stores get.

## 15. Repository layout (planned)

```
keeta-checkout/
  packages/
    server/        @keeta-checkout/server
    button/        @keeta-checkout/button
    refunds/       @keeta-checkout/refunds
    sdk/           @keeta-checkout/sdk      (typed client for the REST API)
  plugins/
    woocommerce/
    shopify/
  examples/
    express-shop/
    airbnb-webapp/ (patch against the reference booking app)
  docs/
  docker/
```

License: Apache-2.0, matching Keeta's own published reference material.

## 16. Sources checked for this design

- Keeta's published `keeta-rails` reference pack: overview, card payments, send and receive tokens, KYB, bank deposits.
- `@keetanetwork/anchor` at v0.0.106: `src/lib/uri.ts`, `src/lib/block-listener.ts`, `src/lib/history.ts`, `src/lib/resolver.ts`, and commits through 2026-10-28.
- `@keetanetwork/keetanet-client` at v0.18.8: `getHistory`, `on('change')`, `send`, `external` constraints.
- Docs: <https://docs.keeta.com>, API reference <https://static.test.keeta.com/docs/>, examples <https://github.com/KeetaNetwork/keetanet-examples>.
