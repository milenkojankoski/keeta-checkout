# 0004. Session store, state machine and HTTP API

Date: 2026-10-30
Status: accepted

## Context

Step 3 of the build order: somewhere to keep checkout sessions and an API merchants
can call. Two audiences touch the same session with very different trust: a
merchant's backend, which holds an API key, and a payer's browser, which can hold no
secret at all.

## Decisions

**Storage**

1. **`node:sqlite`, not `better-sqlite3`.** Node's built-in SQLite is available
   unflagged on both Node 22.13.1 (with an `ExperimentalWarning`) and Node 24, so
   the default store needs no native dependency and no build toolchain. For a
   package meant to be self-hosted in an afternoon that matters more than the
   warning does.
2. **Amounts are stored as TEXT.** SQLite's INTEGER is 64-bit and a token with 18
   decimals passes 2^63 base units at about 9.2 whole units. Text round-trips any
   `bigint` exactly. A test asserts this with 2^70.
3. **One `SessionStore` interface, three implementations eventually.** In-memory for
   tests, SQLite for real use, Postgres later. The contract test suite runs against
   every implementation, so they cannot drift.
4. **Every store method is `async`.** The backends are synchronous, so this earns an
   eslint exception for `require-await`. It is deliberate: a promise-returning method
   that throws synchronously sails straight past a caller's `.catch()`. This was
   found by the tests rather than reasoned about in advance, and the first version of
   both stores had the bug.
5. **Status transitions are enforced in the store, not the service.** Whoever calls
   it, a paid session must not become expired and must not be paid twice. `markPaid`
   is idempotent on `blockHash`, so the watcher in step 5 can retry or restart
   mid-write safely. Every transition runs inside `BEGIN IMMEDIATE`.

**The state machine**

```
 open ──pay──▶ paid
  │
  ├──expiry──▶ expired ──late pay──▶ unmatched
  │
  └──cancel──▶ cancelled
```

6. `unmatched` means money arrived that cannot be credited: a send after the grace
   window, or a second send to a paid session. It keeps the original payment fields
   so the merchant can see both.
7. **Expiry is applied on read and by a sweeper.** On read, so a status is never
   stale to whoever is looking; by a 30-second timer, so a session nobody reads still
   expires and still fires its event.

**Identity and secrets**

8. **Two identifiers, with different exposure.** The session id (`cs_…`) is a public
   capability that appears in URLs. The payment reference (`kc_…`) goes into the
   `SEND` operation's `external` field and must never reach anyone but that session's
   payer, because knowing it would let someone attach their payment to a session they
   did not create. Both carry 128 bits from `crypto.randomBytes`; both are unique in
   the store.
9. **base64url for both**, because every character it uses is inside the network's
   `external` charset `[-_A-Za-z0-9+/= ]`, so a reference needs no escaping on its
   way to the chain.
10. **Two projections, enforced by tests.** `PublicSessionView` omits the reference;
    `MerchantSessionView` adds it. Tests assert the reference appears in no payer
    response and in no event payload.

**Authorisation**

11. **Merchant routes need a bearer API key; payer routes are authorised by holding
    the session id.** A browser cannot keep a secret, so the pay button could not use
    a key. The id's 128 bits are the capability.
12. **Cancel is a payer route.** Both the merchant (abandoning an order) and the payer
    (backing out of the pay page) need it, and the payer has only the id. The worst a
    leaked id allows is closing one session the merchant can recreate.
13. **Keys are compared as SHA-256 digests under `timingSafeEqual`,** and every
    configured key is compared even after a match, so neither the key's length nor
    which key matched leaks through timing.
14. **An API key cannot move money.** The server holds no signing key at all; the
    receiving address is a public address.

**HTTP**

15. **Express 5.** Familiar to the merchants this targets, and the stack already
    anticipates `@x402/express` for step 15.
16. **Stripe-shaped errors**: `{ error: { type, code, message, param } }`. Every
    client-visible error goes through `CheckoutError`, so no stack trace or SQL
    fragment is ever serialised. Unexpected failures log in full and return a bare
    `api_error`.
17. **`express.json({ strict: false })`**, so a body that is valid JSON but not an
    object reaches our own validator and gets the same `BODY_INVALID` code as any
    other wrong shape.
18. **A numeric `amount` is rejected, not coerced.** `12.10` as JSON is a float; the
    whole point of taking a string is that the merchant's exact digits survive.
19. **The event stream closes when a session stops being `open`,** which is a
    different question from whether the status is terminal in the state machine. An
    `expired` session may still become `unmatched`, but the payer watching has
    nothing more to learn, and holding the socket open for an outcome only the
    merchant acts on leaks a connection per dead session. This was a real bug: the
    first version used `isTerminal`, which excludes `expired`, and the stream hung.

## Consequences

- Step 4 adds `uri`, `qrSvg` and `hostedUrl` to the session response. Everything
  else in the response shape is settled, so the button and the plugins can be built
  against it now.
- Step 5's watcher calls `getByReference`, `markPaid` and `markUnmatched`. It must
  treat `graceUntil` as the cutoff between a credited payment and an unmatched one.
- Step 7's webhooks hang off the same `onSessionChange` emitter the event stream uses.
- **Server-sent events cannot be tested with supertest.** Superagent buffers a
  response until it ends, so a live stream simply hangs. Those tests run against a
  real `app.listen(0)` with `fetch`, which is closer to what a browser does anyway.
- The in-memory store is single-process only. A deployment running more than one
  server process must use SQLite on shared storage, or wait for the Postgres adapter.
