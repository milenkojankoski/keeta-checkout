# Development setup

Steps 0 to 9 of the build order in `README.md` are done, so the server runs:
`packages/server` has the amount math, token registry, session store, HTTP API,
payment requests, chain watcher, payments ledger, signed webhooks and hosted pay
page; `packages/button` has the `<keeta-pay-button>` element; `packages/cli` has
`keeta-checkout init`, `check` and `serve`. 416 tests pass, and the end-to-end suite
pays real sessions on the test network. The decisions behind all of it are in
`docs/decisions/0003` through `0011`.

`pnpm test` runs the token registry's network tests when `.env.test` is present and
skips them, visibly, when it is not. Everything else runs offline.

## What the server does today

```
packages/server/src/
  amounts.ts          decimal string <-> bigint base units, exact or it fails
  tokens.ts           ticker/address -> address + decimals, from the resolver
  config.ts           validated configuration; refuses to start on anything wrong
  errors.ts           Stripe-shaped error bodies
  payment-request.ts  session -> keeta:// URI, and the QR as SVG
  sessions/
    types.ts          Session, status state machine, payer and merchant views
    refs.ts           session ids and on-chain payment references
    store.ts          the store contract, plus the in-memory implementation
    sqlite-store.ts   the default store, on node:sqlite
    service.ts        create / read / cancel, expiry, change events
  http/
    auth.ts           bearer API key, timing-safe
    app.ts            the express app
    pay-page.ts       the hosted pay page; escaping and the CSP nonce live here
  watcher/
    matcher.ts        the matching rule: one send + one session -> a disposition (pure)
    history-source.ts reading inbound SENDs out of vote staples
    watcher.ts        polling getHistory with a persisted cursor, oldest-first
  webhooks/
    signature.ts      sign and verify; verifyWebhookSignature is for merchants
    types.ts          event types and the delivery row
    dispatcher.ts     enqueue, send, retry for ~24h, then exhaust
```

The webhook dispatcher runs alongside it:

```ts
const dispatcher = new WebhookDispatcher({ service, config });
dispatcher.start(10_000);   // subscribe, and retry due deliveries every 10s
```

Configure endpoints with `KEETA_CHECKOUT_WEBHOOKS='url|secret[|event,event]'`,
several separated by `;`. A merchant's handler should look like
`examples/express-shop/verify-webhook.mjs`: verify the **raw** body, dedupe on
`event.id`, and answer 2xx fast.

The watcher runs against a **key-less** client:

```ts
const client = KeetaNet.UserClient.fromNetwork(config.network, null); // no signer
const watcher = new PaymentWatcher({ service, history: client.client, receivingAddress: config.receivingAddress });
watcher.start(5_000);
```

Routes:

| Route | Who may call it |
| --- | --- |
| `POST /api/sessions` | merchant API key |
| `GET /api/sessions/:id` | anyone holding the session id |
| `GET /api/sessions/:id?view=merchant` | merchant API key |
| `POST /api/sessions/:id/cancel` | anyone holding the session id |
| `GET /api/sessions/:id/events` | anyone holding the session id |
| `GET /api/sessions/:id/qr.svg` | anyone holding the session id |
| `GET /api/payments` | merchant API key |
| `GET /api/webhook-deliveries` | merchant API key |
| `GET /api/tokens` | merchant API key |
| `GET /pay/:id` | anyone holding the session id |
| `POST /pay/:id/cancel` | anyone holding the session id |
| `GET /health` | open |

A session response carries `uri` (the `keeta://` payment request), `qrSvgUrl` (where
to fetch the QR image) and `hostedUrl` (the hosted pay page, absolute, or `null`
when `publicUrl` is unset). Nothing else about the response shape is expected to
change.

## The shopper-facing pieces

Two ways to take a payment, and a merchant picks one:

- **Redirect to the hosted page.** Create a session, send the shopper to its
  `hostedUrl`, done. The page works with JavaScript switched off, and needs no
  merchant key and no webhooks.
- **Embed the button.** Keep the shopper on your own checkout:

  ```html
  <script type="module">
    import { defineKeetaPayButton } from '@keeta-checkout/button';
    defineKeetaPayButton();
  </script>
  <keeta-pay-button session-id="cs_…" base-url="https://pay.example"></keeta-pay-button>
  ```

  It emits `keeta-paid` and friends, bubbling, with the session in `detail`. React
  shops import `KeetaPayButton` from `@keeta-checkout/button/react` instead; React
  is an optional peer dependency.

Both offer the address, token, base-unit amount and reference to copy, because
`keeta://` deep-link support is still unverified.

A real example, generated against the test network on 2026-10-30 for 12.50 USDC:

```
keeta://actions/send
  ?to=keeta_aabvt3ni7qohr2agcfypfjc4jaupt3i5lfyf53buw45t6btjuehjxhkqfr5u2fi
  &token=keeta_aosjk5tgpgxr3qazd2abxyhj4srqua5c3xgz4lmgxuyrrwzryiqng4vacgwai
  &value=12500000
  &external=kc_G9HLnBJwGHYfLaB-BqPWxg
```

`value` is always base units. 12.50 at the 6 decimals USDC declares on-chain is
12500000, and `parseKeetaURI` reads that back as the identical `bigint`.

## Running it

```bash
pnpm build                                   # esbuild bundles for the CLI and the button
pnpm cli -- init --network test --receiving-address keeta_…
pnpm cli -- check
pnpm cli -- serve --port 3000 --database ./dev.sqlite
```

`pnpm cli` runs the TypeScript through tsx. In production the entry point is
`packages/cli/bin/keeta-checkout.js`, which runs the built bundle.

`packages/cli/src/runtime.ts` is the wiring, and is what to read or reuse to embed
the server in a host application. The shutdown order in it is deliberate: HTTP
first, then the watcher, then the dispatcher so queued webhooks flush, then the
store.

Two facts worth knowing before you do:

- The server holds **no signing key**. It needs only the merchant's public
  `keeta_…` address, so an API key that leaks cannot move money.
- A session can only be priced in a token whose ledger ACL is open to any holder.
  `GET /api/tokens` shows `openToAnyHolder` for each one.
- A session's `reference` goes on-chain in the payer's `SEND`, and it is inside the
  payment URI, so that session's payer does see it. That is what lets them pay. What
  no payer can learn is another session's reference or id.

## Requirements

- **Node.** `.node-version` pins 24.14.1, which is what Keeta's anchor SDK declares
  and what CI runs. Node 22.13.1 also works today; see
  `docs/decisions/0001-node-24-via-pnpm.md`. Every pnpm command on Node 22 prints an
  unsupported-engine warning, which is expected.
- **pnpm** 11.5.2 or later.
- **Network access** to the Keeta test network and `faucet.test.keeta.com`.

## First run

```bash
pnpm install          # approves three build scripts via pnpm-workspace.yaml
pnpm wallets:create   # generates .env.test with the merchant and payer seeds
pnpm wallets:fund     # asks the test faucet for 10 KTA each, then polls
pnpm wallets:status   # addresses, balances, and the tokens the resolver lists
```

`pnpm wallets:create` refuses to overwrite an existing `.env.test`. Use `--force`
only if you accept losing whatever test funds the old wallets hold.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test             # 416 tests; the network ones skip without .env.test
pnpm fixtures         # regenerate the PHP suite's cross-language signature fixtures
pnpm test:php         # 122 PHP assertions in a php:8.3-cli container (needs Docker)
```

## The development wallets

Two accounts, both on the **test network only**. The tools refuse to run if
`KEETA_NETWORK` is anything but `test`.

| Role | Purpose |
| --- | --- |
| `merchant` | Receives checkout payments. The checkout server itself needs only this account's public address, never its seed. |
| `payer` | Stands in for a customer's wallet and pays checkout sessions in tests. |

Seeds live in `.env.test`, which is gitignored. They are written there by
`pnpm wallets:create` and are never printed by any tool, logged, or committed. These
wallets hold only test-network value, but a seed is still a key: never reuse one on
the main network.

Addresses are public and safe to share. `pnpm wallets:status` prints them with
explorer links.

## What the test network actually offers

Measured on 2026-10-29 with `pnpm wallets:status`. Token addresses always come from
the resolver at runtime, never from this table.

| Ticker | Note |
| --- | --- |
| `$KTA` | Base token, 18 decimals, pays fees |
| `$USDC` | The likely default for checkout sessions in tests |
| `$EURC` | |
| `$CBBTC` | |
| `$KUSD`, `$KEUR` | Abstract currency tokens |
| `$RUSD` | Listed on test but not named in Keeta's own `keeta-rails` reference |

Every token the test network lists is open to any holder, so any of them can price a
session. On main that is not true: the bare-ISO-code fiat tokens (`USD`, `EUR`, …)
are permit lists and the server refuses them. See
`docs/decisions/0005-fiat-tokens-and-permit-lists.md`.

The faucet gives **KTA only**, so the end-to-end suite prices its sessions in KTA.
One run publishes nine blocks from the payer wallet, moves 0.009 KTA to the merchant
wallet, and pays about 0.0000000004 KTA in fees in total, so the 10 KTA each wallet
holds lasts indefinitely. The suite refuses to start if the payer holds less than
0.02 KTA and tells you to run `pnpm wallets:fund`. Without `.env.test` it skips,
which is what CI does.

## Repository layout

```
packages/server    the checkout server library
packages/cli       the `keeta-checkout` command: init, check, serve
packages/button    the pay button web component, and its browser bundle
packages/sdk       typed client for the REST API (not built yet)
packages/refunds   refunds: vault setup, the publishing process, the SDK signer (step 13)
plugins/woocommerce  the WooCommerce gateway (PHP); dev/ brings up a real WordPress
plugins/shopify      not started (step 14)
examples/          reference integrations, including a webhook handler
docker/            Dockerfile and compose file
tools/             development wallet scripts, not shipped
docs/decisions/    architecture decision records
```

`tools/` and `packages/cli` are not in the layout sketched in `README.md`
section 15. `tools/` holds dev-only scripts outside the published packages;
`packages/cli` exists so `npx keeta-checkout` works and the server package can stay
a library.

## Conventions

- **Money is `bigint` base units** end to end. Decimal strings appear only at an API
  boundary. `formatBaseUnits` in `tools/keeta.ts` is display-only and must not be
  imported from `packages/`; the tested one is `packages/server/src/amounts.ts`.
- **Decimals are read from on-chain metadata**, never hardcoded.
- **Token addresses come from the resolver**, never from memory.
- **A token must be open to any holder to price a session.** Checked from its ledger
  `defaultPermission`, failing closed.
- **One publish at a time per account.** Vitest runs with `fileParallelism: false`
  for this reason.
- **A decision that was not obvious gets a record** in `docs/decisions/`, per the
  model-switching rule in `README.md` section 13.
