# 0013. Security review before publishing

Date: 2026-10-31
Status: accepted

## Context

Step 12, the last gate before v1 is published. Two questions: does the code honour
the seven rules in README section 11, and is the SDK still used the way the anchor
source says it should be.

The SDK has not moved since step 2. `@keetanetwork/anchor` is still 0.0.105 and
`@keetanetwork/keetanet-client` still 0.18.8, so the second question is a review
against the same source already read, not a new one. 0.0.106 is tagged in the anchor
repository but has never been published to npm.

One caveat on this review that a reader should weigh: the same model wrote most of
the code it audits. Three findings below came from measurement rather than reading,
which is the part self-review is worst at, but an independent pass would still be
worth more than this one.

## The seven rules

| Rule | Verdict | Evidence |
| --- | --- | --- |
| 1. Watch-only server, no signing key anywhere | holds | No `fromSeed`, no `privateKey`, no `.sign(` outside the webhook HMAC. `UserClient.fromNetwork(network, null)`, whose `account` getter throws by construction. |
| 2. Keys from a secret store, never logged | holds | No log, error or response path mentions a secret or an API key. Webhook delivery history deliberately omits payloads and secrets. |
| 3. Random unguessable references, never containing the orderId | holds | 128 bits of `crypto.randomBytes` for both the session id and the reference, base64url, uniqueness also enforced by the store. Neither derives from the order. |
| 4. Bigint base units end to end | holds | Amounts are `bigint` in memory and TEXT in SQLite. Decimals are read from `decimalPlaces` in on-chain metadata, never hardcoded; a token without metadata is refused rather than guessed. |
| 5. Signed webhooks | holds | HMAC-SHA256 over the `t=...,v1=...` header, compared with `timingSafeEqual`, 300-second tolerance. Twelve cross-language fixtures pin the TypeScript signer against the PHP verifier. |
| 6. One publish at a time per account | not yet exercised | v1 never publishes a block. It becomes real in refunds, which are a v2 stub. |
| 7. Pay page shows network, token, recipient and amount | holds | Recipient address, token address, base-unit amount, reference and network all rendered, every one HTML-escaped. |

API keys are compared with `timingSafeEqual` over SHA-256 digests. Query parameters
that reach SQL are bound, never interpolated: the `IN (...)` clauses build their
placeholders from the array length, so the unvalidated disposition and status strings
from `/api/payments` and `/api/webhook-deliveries` cannot inject. `successUrl` and
`cancelUrl` are restricted to http and https at session creation and escaped at
render, so neither the pay page link nor the scripted redirect can carry a
`javascript:` URL.

## What was fixed

**Dependency advisories, eight down to two.** `pnpm audit` reported 1 low, 5 moderate
and 2 critical. Both criticals were prototype-pollution-to-RCE gadgets in `tinypool`,
reached only through `vitest`; two moderates were path traversal and code injection in
`vitest` and `@vitest/mocker`; one was a glob-amplification denial of service in
`minimatch`, reached only through `eslint`. All five are devDependencies that never
ship: the container and the published CLI install production dependencies only, and
the built image contains none of that tooling.

They were fixed anyway, because a public repository's audit output is read as a
statement about the project. `vitest` 3.2 to 5.0 removes `tinypool` from the tree
entirely and clears four advisories; `eslint` 9 to 10 plus an override pinning
`minimatch` to `^11.0.1` clears the fifth. All 418 tests, the typecheck and the lint
pass on the new versions. The override lives in `pnpm-workspace.yaml`, because
pnpm 11 no longer reads `pnpm.overrides` from `package.json`.

**The two that remain are inside Keeta's own dependency tree** and cannot be patched
from here, so they were measured for reachability instead:

- `uuid` (moderate): a missing buffer bounds check in v3, v5 and v6 when a `buf`
  argument is passed. It arrives through `keetanet-client` to `@google-cloud/logging`
  to `gaxios`. Nothing in that chain calls v3, v5 or v6 at all; `gaxios` uses v4,
  which is unaffected and takes no buffer. Not reachable.
- `elliptic` (low): a risky cryptographic primitive, reached through
  `keetanet-client` to `secp256k1`. The server holds no key and signs nothing, so the
  primitive is never exercised. Not reachable.

Both are worth re-checking whenever the Keeta SDK is bumped.

**Two comments asserted a security property the code does not have.** `toPublicView`
was documented as never including the payment reference, and the route table
described the merchant view as the thing that adds it. The public view has no
`reference` field, but it does carry `uri`, and the reference is that URI's
`external` parameter. That is not a leak, it is the mechanism: a payer who cannot
read the reference cannot pay. The session id is the actual secret, and anyone who
can read the reference already holds the id. The tests always encoded this correctly,
asserting that a payer sees their own reference and never another session's. Only the
prose was wrong, which is the kind of wrong a later contributor builds on. Both
comments now say what is true and why.

**No bound on concurrent event streams.** `/api/sessions/:id/events` added one
listener and held one socket per connection with no cap, and
`#events.setMaxListeners(0)` had removed the only thing that would have warned about
it. Measured against the running container: 300 streams on a single session were all
accepted, and 1800 cost about 12 KB each, 22 MiB over a 221 MiB baseline, with the
file descriptor limit at roughly a million and nowhere near binding.

There is now a cap of 20 streams per session, releasing a slot on close and answering
429 `TOO_MANY_STREAMS` above it. Twenty is far above honest use, where a shopper has
one pay page and `EventSource` reconnects rather than stacking connections.

**No security headers on the JSON API.** Only the pay page set any. `nosniff` and
`no-referrer` now go on in middleware, covering every route and every error path,
because session ids travel in these URLs and a JSON body a browser sniffs as HTML is
an XSS in waiting.

## What was investigated and is not a finding

**Webhook SSRF.** The dispatcher POSTs to a merchant-named URL, which looks like an
SSRF primitive. It is not a privilege boundary: endpoints are set by the operator from
`KEETA_CHECKOUT_WEBHOOKS` at boot, not by a merchant at runtime, and anyone who can
set that variable already runs the process. The scheme is restricted to http and
https, the secret must be at least 16 characters, and `redirect: 'manual'` stops a
signed body following a redirect to a host the operator did not name.

**A denial of service that turned out to be mine.** At about 1970 streams the probe
reported the server unreachable. It was the probe running out of ephemeral ports.
Re-tested with 1800 streams held by one process and `/health` requested from a fresh
`curl` and from inside the container, the server answered in 27 ms both times. Had
this not been checked from a second socket pool it would have been published as a
fatal availability bug. The cap above is justified as a bound, not as a fix for a
cliff.

## What is accepted, and where it belongs

**No rate limiting in the server.** Public routes are reachable by anyone holding a
session id, which on a live shop is anyone who can reach a checkout. `/qr.svg`
renders a roughly 6 KB SVG per request. None of this is bounded in application code,
and the right place for it is the reverse proxy that is already terminating TLS in any
real deployment. Shipping a rate limiter inside the server would invite operators to
believe they do not need one at the edge, which is worse. This belongs in the
deployment notes, not in `app.ts`.

**No CSRF token on the no-JavaScript cancel form.** A cross-site POST to
`/pay/:id/cancel` could cancel a shopper's open session. It needs the session id, it
moves no money, and the shopper can simply check out again. Fixing it costs a token
and a second round trip on the one path that exists to work without JavaScript. Noted
and left.

**One server per database.** Only the memory and SQLite stores exist, so horizontal
scaling waits for a Postgres adapter.

## Independent re-review

Same day, by a different model, at the user's request, because the pass above
reviewed code its own author had written. Everything below was reproduced against
the running development stack before it was changed and verified there afterwards.
The pass above was checked too: the signature verifier, the stream cap, the headers,
the SQL binding, the URL scheme checks and the dependency reachability argument all
hold as described. What it missed was behavioural, and two of the three were only
visible by driving the system rather than reading it.

**The server died when a Keeta node did** (critical, server). During the plugin
probes a test-network representative answered "not ok" for fifteen seconds. The
watcher's `scan()` logs a failure and rethrows, so that a direct caller such as the
CLI's `check` command hears about it. `start()` scheduled it with `void`, which
discards the promise, and a rejected promise nobody awaits ends a Node process. The
container had restarted four times in an hour; under `npx keeta-checkout serve`
with no supervisor it would have stayed dead and credited nothing until someone
noticed. The scheduled path now swallows what `scan()` rethrows, `stop()` no longer
rethrows a failing scan either, and a test drives a watcher against a source that
always rejects and asserts that no unhandled rejection reaches the process. The
test failed against the old code with exactly the error from the log.

**A payment on a superseded request was dropped** (high, plugin, money). Pressing
the pay button a second time, which a shopper who goes back and forth does, created
a second session and overwrote the one the order pointed at. A payment on the first
request, from the tab the shopper kept open, arrived as a signed `paid` event for a
session the order no longer named, and the webhook answered `matched: false` and did
nothing. Money taken, order never completed, and logged only when debug logging was
on. Reproduced with a forged, correctly signed event. Three changes: the gateway now
reads the existing session back and sends the shopper to it when it is still open
for what the order costs now, cancelling it on the server instead when the total
has changed; the order keeps a list of every session it has ever had and the
webhook matches against all of them; and a second `paid` through a different block
on an already paid order adds a note saying the customer paid twice and one payment
must go back.

**The pay page's cancel button produced an error** (medium, plugin). Orders went to
`on-hold`, and WooCommerce's own cancel link acts only on `pending` and `failed`.
The shopper landed on the cart with "Your order can no longer be cancelled. Please
contact us if you need assistance", and the order sat on hold until the `cancelled`
webhook arrived twenty seconds later. Orders now stay `pending`, which is also what
WooCommerce's stock hold and unpaid-order cleanup key on. Reproduced before and
verified after: the same click now lands on "Your order was cancelled" with the
order already cancelled.

**Hardening in the webhook handler** (plugin). Each of these was a path the code
allowed and should not have: an `expired` for a superseded request cancelled the
order even though a newer request was open, so cancellation now requires the event
to name the order's current session; the shopper may have switched to another
payment method on the order-pay page, so it also requires the order's payment
method to still be Keeta; a `paid` event completed the order without comparing the
session's amount to the order total, so a total edited after the request was
priced now puts the order on hold with a note for a person instead of completing
it; a `paid` event type was trusted without checking that the session itself says
`paid`; and an order with no Keeta session at all could be matched by `orderId`
alone, so a signed event could in principle touch an order from another gateway.
An order is now matched only through a session it created. All seven scenarios,
including the three above, were driven against the live shop with forged signed
events and behaved as intended.

**Smaller.** The shopper saw the checkout server's own error text, which for a
transport failure names an internal host and port; they now see a generic message
and the detail goes to the log. The event stream registers its close handler after
an `await`, and if the client dropped the socket during that wait Node would
already have emitted `close` once and the slot and listener would never be
released; not reproduced under 400 open-and-abort attempts, but the guard is one
property read.

**Two amounts, one comparison.** WooCommerce says `12.50`, the server says `12.5`
because it strips trailing zeros. A small canonical-form comparison was added to
the plugin's amount helper, with sixteen assertions, so the gateway and the webhook
never compare money as floats or as raw strings.

**Worth knowing for a merchant.** A `pending` order holds its stock only for
WooCommerce's hold-stock minutes, sixty by default. A session lifetime longer than
that can let stock be released while the request is still payable, and the amount
check above is then what keeps a late payment from completing an order that can no
longer be fulfilled as priced. Set the session lifetime no longer than the hold.

Two live end-to-end tests failed once during this pass and passed on the rerun,
with the test network's outage in between. They are recorded here rather than
smoothed over.

## Still unverified by anyone

Whether any wallet registers the `keeta://` scheme, which needs a person with a
phone. Everything else in this review was executed, not read.
