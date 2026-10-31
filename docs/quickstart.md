# Quickstart

Take your first Keeta payment. On the test network this costs nothing and risks
nothing.

## 1. Get a receiving address

Open the Keeta wallet, [wallet.test.keeta.com](https://wallet.test.keeta.com) for
the test network, and copy your account's public address. It starts with `keeta_`.

That public address is all the checkout server ever needs. It holds no seed and no
private key, so it cannot move the money that arrives.

## 2. Configure

```bash
npx keeta-checkout init
```

It asks for the network, the receiving address, and which tokens to accept, then
generates an API key and a webhook signing secret and writes everything to `.env`.

Non-interactively, for a script or a container:

```bash
npx keeta-checkout init \
  --network test \
  --receiving-address keeta_… \
  --accept '$USDC' \
  --public-url https://pay.your-shop.example
```

## 3. Check it

```bash
npx keeta-checkout check
```

```
ok    configuration        valid, for the test network
ok    receiving account    reachable, holding 0 base units of KTA for fees it will never need
ok    resolver             lists 7 tokens, 7 of them payable by a shopper
ok    token $USDC          $USDC, 6 decimals

Everything checks out. `keeta-checkout serve` is ready.
```

Worth running before you ship. Every failure it catches would otherwise surface as a
shopper who cannot pay.

## 4. Serve

```bash
npx keeta-checkout serve
```

Or with Docker, from the published image:

```bash
docker run --rm -p 3000:3000 -v keeta-checkout-data:/data --env-file .env \
  ghcr.io/milenkojankoski/keeta-checkout:0.1.0
```

Or build it yourself from a checkout:

```bash
docker build -f docker/Dockerfile -t keeta-checkout .
docker run --rm -p 3000:3000 -v keeta-checkout-data:/data --env-file .env keeta-checkout
```

## 5. Create a session from your backend

```bash
curl -sS http://localhost:3000/api/sessions \
  -H "Authorization: Bearer $KEETA_CHECKOUT_API_KEYS" \
  -H 'Content-Type: application/json' \
  -d '{
    "amount": "12.50",
    "currency": "$USDC",
    "orderId": "order-1001",
    "successUrl": "https://your-shop.example/thanks",
    "cancelUrl": "https://your-shop.example/cart"
  }'
```

The response carries everything the shopper needs:

| Field | What it is for |
| --- | --- |
| `hostedUrl` | Redirect the shopper here and you are done |
| `uri` | The `keeta://` request, for your own pay button |
| `qrSvgUrl` | The QR code as an image |
| `reference` | What appears on-chain. Keep it away from other shoppers |

**`amount` is a string, always.** `12.50` as a JSON number is a float, and the point
of a string is that your exact digits survive the trip. An amount finer than the
token allows is rejected rather than rounded.

## 6. Take the payment

Either redirect:

```js
res.redirect(session.hostedUrl);
```

Or keep the shopper on your own page:

```html
<script src="/keeta-pay-button.js" defer></script>
<keeta-pay-button session-id="cs_…" base-url="https://pay.your-shop.example"></keeta-pay-button>
```

```js
document.querySelector('keeta-pay-button')
  .addEventListener('keeta-paid', (event) => {
    window.location.href = event.detail.successUrl;
  });
```

React:

```tsx
import { KeetaPayButton } from '@keeta-checkout/button/react';

<KeetaPayButton sessionId={session.id} baseUrl="https://pay.your-shop.example" onPaid={finish} />
```

## 7. Learn that it was paid

The button and the pay page notice settlement on their own. Your **backend** should
learn from a webhook, because a browser can close:

```
KEETA_CHECKOUT_WEBHOOKS=https://your-shop.example/hooks/keeta|whsec_…
```

`examples/express-shop/verify-webhook.mjs` is a complete handler. Four things in it
are not optional:

1. Verify against the **raw** body. Parsing and re-serialising breaks the signature.
2. Dedupe on `event.id`. Delivery is at-least-once.
3. Do not assume event order. Retries interleave.
4. Answer 2xx quickly. Anything else is retried for about 24 hours.

Handle `checkout.payment.recorded` too, not just `checkout.session.paid`. It is how
you hear about money that arrived and could **not** be credited: short, late,
unreferenced, or in the wrong token. Nothing changes a session's status in those
cases, so without it that money sits unnoticed. `GET /api/payments` lists it all
with a `refundable` flag.

## What to know before the main network

- **Tokens a shopper cannot pay with are refused.** On main, Bivo's original fiat
  tokens (`USD`, `EUR`, `GBP`, …) are permit lists: only accounts their issuer
  approved can hold them. Price in `$USDC` or `$EURC` and use a Keeta payout to
  settle in fiat afterwards.
- **`$KBUSD` and the other `$KB` stablecoins are open at the ledger** but need Bivo
  KYC to acquire, so almost no shopper holds one. They suit invoicing between two
  onboarded businesses, not a public shop.
- **There are no refunds yet.** Send money back by hand from your wallet until the
  refunds process lands. `GET /api/payments?disposition=underpaid,late,duplicate`
  tells you what to send and to whom.
- **Back up the database.** It is the record of which orders were paid.
- **One server per database.** The watcher and the webhook dispatcher each expect to
  be the only one of their kind.
- **Rate limit the payer routes at your proxy.** `/pay/:id`, `/api/sessions/:id` and
  `/qr.svg` are authorised by the session id alone, which is how a shopper can open a
  pay page without logging in, and which also means anyone who can reach your
  checkout can mint one. The server caps event streams at 20 per session but ships no
  rate limiter of its own, on purpose: a limit inside the application tempts you into
  thinking you do not need one in front of it. Put a modest per-IP limit on those
  three paths wherever you terminate TLS.
