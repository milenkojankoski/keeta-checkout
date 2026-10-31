# 0010. The hosted pay page and the pay button

Date: 2026-10-30
Status: accepted

## Context

Step 8: the two things a shopper actually sees. A hosted page at `/pay/:id` for
merchants who want to redirect, and a `<keeta-pay-button>` element for merchants who
want to stay on their own checkout.

Both are public by session id, like the other payer routes: a browser cannot keep a
secret, and the id's 128 random bits are the capability.

## Decisions

**The hosted pay page**

1. **It works with JavaScript switched off.** The QR is an `<img>` pointing at the QR
   route, the deep link is an `<a href>`, the address, token, base-unit amount and
   reference are selectable text, and cancelling is a form POST to
   `/pay/:id/cancel` which cancels and then 303s back to the shop. JavaScript only
   upgrades the page: a live countdown, and the status flipping over the event
   stream. A payment page that needs a bundle to execute before money can move is a
   payment page that fails for someone.
2. **Everything interpolated is escaped.** `orderId` is a string the merchant chose
   and the server stores verbatim, so it arrives here as untrusted text; so do the
   token ticker and the return URLs. Seven tests push script and markup through
   those fields and assert the page has exactly one `<script` in it.
3. **A nonce-based Content-Security-Policy**, fresh per response:
   `default-src 'none'`, and the one inline style and script allowed by nonce. No
   `unsafe-inline`, no CDN, no font service, no analytics. A test asserts two
   requests get different nonces and that the nonce in the header is the one on the
   blocks.
4. **`Cache-Control: no-store`** and `noindex, nofollow`. The URL is a payment
   capability and the page's content changes.
5. **The bootstrap object is minimal.** The inline script receives only what it
   needs, and nothing that is not already visible on the page.
6. **Cancelling an already-paid session redirects to the success page**, not an
   error. The shopper clicked a button that is no longer true; sending them somewhere
   useful beats showing them a conflict they cannot act on.

**The button**

7. **A custom element with a shadow root, no dependencies.** A shop's stylesheet
   cannot restyle a payment control by accident, and the component cannot leak
   styles into the shop. It reads the session from the public status route and
   renders what that returns, so the browser never converts an amount or builds a
   payment request.
8. **Event stream first, polling underneath, always both.** `EventSource` is the
   fast path; a five-second poll covers a proxy that buffers the stream or a browser
   without `EventSource`. Whichever notices settlement first wins, and the poll
   stops when the session closes or the element is removed.
9. **Everything is set with `textContent`, never `innerHTML`.** Nothing from the
   server is ever parsed as markup. A test feeds a hostile ticker and order id
   through and asserts no element was created from them.
10. **`keeta-paid`, `keeta-expired`, `keeta-cancelled`, `keeta-unmatched`,
    `keeta-error`**, bubbling and composed so they escape the shadow root, each
    fired once with the session in `detail`.
11. **The copy-the-details fallback is always present**, not a last resort shown
    after a failure. Deep-link support for `keeta://` is still unverified (README
    section 14), so the address, token, base-unit amount and reference are always
    one tap away.
12. **React is an optional peer dependency.** The wrapper lives in its own module, so
    a plain-HTML shop never pays for React. It exists because React needs help with
    two things on a custom element: custom event names are not props, and attributes
    must be strings.

**`hostedUrl`**

13. It is absolute when `publicUrl` is configured and `null` otherwise. A merchant
    redirects a shopper to it or puts it in an email, so a relative path would be
    wrong. Deferred from step 4 precisely because the page did not exist yet.

## Two things that bit, both recorded because they will recur

- **` ` in TypeScript source became the literal character.** The escaping
  helper originally used `/ /g` regex literals; written to disk, those became
  the actual U+2028 characters, which are JavaScript line terminators and cannot
  appear in a regex literal. The file stopped parsing. The fix removes the need for
  them: `jsonForScript` now escapes **every** character outside printable ASCII as
  `\uXXXX`, which is stricter, needs no non-ASCII source, and a test asserts the
  output is pure ASCII and round-trips through `JSON.parse`.
- **jsdom 30 does not load on Node 22.** It pulls `undici` 8, which calls a
  `zlib` API that Node 22.13 does not have, and the test file failed at import with
  `Cannot read properties of undefined (reading 'bind')`. This is exactly the
  local-versus-CI Node gap ADR 0001 said to watch for. Switched to `happy-dom`,
  which has no undici, is smaller, and handles custom elements and shadow roots
  fine.

## Consequences

- 392 tests pass, 49 of them new: 28 for the page and 21 for the button in a real
  DOM.
- The root `tsconfig.json` now sets `jsx: react-jsx` and includes DOM types and
  `.tsx`, since the workspace holds browser code for the first time.
- The button is source-only, like the rest of the workspace. Step 9's packaging
  decides how a merchant gets a single file to drop in a `<script src>`.
- The pay page needs no webhooks and no merchant key. A merchant can use the hosted
  page alone, with no backend integration beyond creating the session.
