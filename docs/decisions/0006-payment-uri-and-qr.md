# 0006. The payment URI, the QR code, and who may see a reference

Date: 2026-10-30
Status: accepted

## Context

Step 4 of the build order: turn a session into something a payer's wallet can act
on. Checked in the anchor SDK source first, because the amount crosses a boundary
here:

- `encodeKeetaURI` writes the value with `String(bigint)` and `parseKeetaURI` reads
  it back with `BigInt(...)`. There is no notion of decimal places anywhere in the
  URI layer, so the round trip is lossless and nothing can rescale an amount.
- `external` is a `string[]`, and the encoder appends **each** entry as its own
  query parameter. Keeta's convention is that the first entry becomes the `external`
  field of the `SEND` operation.

## Decisions

1. **The `external` array carries exactly one item: the session reference.** More
   than one would make it ambiguous which the watcher should match on, and the
   watcher's rule (step 5) is an exact equality test.
2. **No conversion happens here.** The session already holds a validated `bigint`;
   it goes into the URI untouched. A test walks the whole chain, from the merchant's
   decimal string through `parseDecimalAmount` into the URI and back out of
   `parseKeetaURI`, including 10^18 and 2^128 − 1.
3. **A reference that is not valid on-chain fails at build time.** Better than a
   payer scanning a code and the publish being rejected minutes later.
4. **The QR code is served from its own route, `GET /api/sessions/:id/qr.svg`**, as
   an `image/svg+xml` response rather than a field in the session JSON. The SVG is
   about 6 KB; putting it in the view would repeat it on every status poll and every
   server-sent event. A route also lets a pay page use a plain
   `<img src="…/qr.svg">` with no JavaScript. Cached `private, max-age=300,
   immutable`: the URI never changes for a session, and the URL embeds a capability.
5. **Byte mode, not alphanumeric.** A Keeta URI mixes case, because base32 addresses
   are lower case and the base64url reference is not. Alphanumeric mode would
   upper-case everything and destroy both. A test asserts an upper-cased URI fails
   to parse.
6. **Error correction `M`.** About 15% recovery, and a ~200-character URI still
   produces a code that scans comfortably on a phone.
7. **`qrSvgUrl` is absolute when `publicUrl` is configured, relative otherwise.** A
   pay button usually runs on the merchant's domain, not the checkout server's, so a
   relative path would break cross-origin.
8. **No `hostedUrl` yet.** README section 5 lists it, but the hosted pay page is
   step 8. Returning a link to a route that 404s is worse than omitting the field;
   it arrives with the page.

## The reference is payer-visible, and that is correct

ADR 0004 decision 10 said the payment reference "must never reach anyone but that
session's payer", and the payer view omitted it. The URI necessarily embeds it, so
the payer view now contains it.

This is not a weakening. Holding a session's id is precisely what entitles someone
to pay that session, and the reference is the instruction for doing so. The property
that matters is unchanged: **holding session A's id reveals nothing about session
B.** Tests assert that in the status route, the event stream, and the service view.

Nor is attaching a payment to someone else's session a useful attack. The money
moves to the merchant's account either way, the matching rule requires the amount to
be at least the session amount so an underpayment lands in `unmatched` and marks
nothing paid, and whoever did it has paid for an order that is not theirs.

The bare `reference` field stays in the merchant view only. It is a convenience for
reconciling against the chain, not a secret the public view withholds.

## Verified end to end

On 2026-10-30, against the live test network, a session priced at `12.50 $USDC`
produced `value=12500000` with 6 decimals read from the token's on-chain metadata,
parsed back to the identical `bigint`, and resolved to the merchant account and the
real test USDC token. The QR rendered at 5951 bytes.

## Consequences

- Step 5's watcher matches on the single `external` value and the token and amount
  from this same URI. The two must stay in step; both read the session record.
- Step 8's button can use `uri` for the deep link and `qrSvgUrl` for an `<img>`, and
  needs no Keeta code of its own.
- `buildPaymentUri` parses two addresses on every view render. Measured in
  microseconds and not cached, because a stored URI could go stale against a changed
  builder, and derived data in the store is a liability.
- **Still unverified:** whether any wallet registers the `keeta://` scheme, and
  whether Keeta Personal renders a pre-filled send from one. That needs a person
  with a phone, not more code. It remains an open question in README section 14, and
  the copy-the-address fallback in step 8 exists because of it.
