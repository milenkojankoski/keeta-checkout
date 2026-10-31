# 0009. Webhooks: events, signing, and retries

Date: 2026-10-30
Status: accepted

## Context

Step 7: tell a merchant's backend what happened, so it can fulfil an order without
polling. The shape to copy is Stripe's, because that is what the merchants this
targets already have a handler for.

## Decisions

**The event set**

1. Five event types, not the four the README listed:

   | Event | When |
   | --- | --- |
   | `checkout.session.paid` | a payment was credited; fulfil the order |
   | `checkout.session.expired` | the deadline passed unpaid; release the stock |
   | `checkout.session.cancelled` | the merchant or payer gave up |
   | `checkout.session.unmatched` | money arrived that cannot be credited to this session |
   | `checkout.payment.recorded` | an inbound send was recorded and **not** credited |

   `cancelled` was added because the service already emits it and a merchant
   holding stock needs it. `refund.sent` stays for v2 with the refunds process.

2. **`checkout.payment.recorded` is the one that earns its place.** An underpayment,
   a send with no reference, a send in the wrong token: none of those change a
   session status, so without this event the money would sit with the merchant
   unnoticed. It carries `refundable`, which is true for every disposition where
   money is owed back. It is **not** sent for `matched` or `overpaid`, which already
   produced `session.paid`; sending both would have merchants handling the same
   money twice.

**Signing**

3. `Keeta-Checkout-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over `${t}.${rawBody}`.
   The timestamp is inside the signature, so a captured delivery cannot be replayed
   with a fresh one.
4. **`verifyWebhookSignature` is exported for merchants**, accepts an array of
   secrets for rotation, compares every candidate even after a match so timing
   reveals nothing, and rejects a timestamp outside a 300-second default tolerance.
5. **Unknown header keys are ignored**, so adding a `v2=` scheme later will not
   break a handler written against v1. A test asserts this.
6. Verification must run against the **raw body**. A test proves a re-serialised
   body fails, because that is the mistake every webhook integration makes once.

**Delivery**

7. **Write the delivery row first, send second.** The watcher must never wait on a
   merchant's HTTP server, and an event recorded but unsent is recoverable while one
   never recorded is lost.
8. **The payload is frozen at enqueue and never re-serialised.** An event is a record
   of what happened, not a view of what is true now; a retry two hours later must
   still say what the first attempt said. A test asserts the bytes are identical
   across retries, with only the signature timestamp differing.
9. **At least once, and not ordered.** Both are stated in the module docs, in the
   README, and in the worked example, because a handler that assumes either is
   broken in a way that only shows up in production. Handlers dedupe on `event.id`.
10. **Retry schedule**: 10s, 30s, 2m, 10m, 30m, 1h, 2h, 4h, 8h, 8h, so eleven
    attempts over a little under 24 hours, then `exhausted` and left for a human.
    Ten percent jitter by default.
11. **Claiming leases a row.** `claimDueDeliveries` pushes each claimed row's next
    attempt forward, so two dispatcher processes do not send the same delivery at
    once. A lease that expires without a result simply becomes due again, which
    at-least-once delivery already tolerates.
12. **`redirect: 'manual'`.** Following a redirect would resend a signed body to a
    URL the merchant did not configure.
13. **A ten-second timeout** per attempt, and the error text is truncated to 500
    characters on the row.
14. An endpoint removed from the configuration while deliveries are queued marks
    them `exhausted` rather than retrying a URL nobody listens on.

**Configuration**

15. Endpoints are `{ url, secret, events }`; `events` defaults to all of them. The
    secret is required and must be at least 16 characters, because an unsigned
    webhook cannot be trusted by its receiver. A duplicate URL is a configuration
    error rather than two sets of retries.
16. From the environment: `KEETA_CHECKOUT_WEBHOOKS='url|secret[|event,event]'`,
    several separated by `;`.

**Inspection**

17. `GET /api/webhook-deliveries` lists the attempt history for the merchant's
    dashboard. It returns neither the payload (large, and the merchant already
    received it) nor anything about secrets. A test asserts the secret appears
    nowhere in the response.

## Bugs this step found

- **`start(0)` created a hot-loop timer.** `setInterval(fn, 0)` rather than "no
  timer". Now a non-positive interval subscribes without one, matching the
  convention the app's sweeper already used.
- **No way to await event-driven enqueues.** A session change fires synchronously but
  writes its rows asynchronously, so a graceful shutdown or a test could observe a
  moment where the event had happened and no delivery existed. `settled()` now
  exposes that wait, and `stop()` uses it.

## Consequences

- 333 tests pass. The webhook layer adds 47 of them plus the delivery-store contract
  across both store implementations.
- Schema version 3 adds `webhook_deliveries`. A test downgrades a database to
  version 2 and asserts the upgrade keeps the watcher's cursor.
- `examples/express-shop/verify-webhook.mjs` is the handler to copy: raw body,
  dedupe on `event.id`, 400 on a bad signature rather than 500, and an explicit note
  that event order is not guaranteed.
- The dispatcher is standalone, like the watcher. A deployment runs one.
- Step 8's button does not need webhooks; it uses the event stream. Webhooks are for
  the merchant's backend, which is the only side that can fulfil an order.
