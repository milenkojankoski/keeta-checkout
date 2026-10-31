# 0007. The watcher, the matching rule, and the payments ledger

Date: 2026-10-30
Status: accepted

## Context

Step 5: notice a payment on the chain and credit the right session. A mistake here
marks an unpaid order as paid, or a paid one as not, so the SDK's behaviour was
measured before anything was designed.

Measured on the test network on 2026-10-30:

- `getHistory(merchantAccount)` returns vote staples **newest first**, and a staple's
  blocks belong to whoever published them. The faucet's block appeared in the
  merchant's history because one of its two `SEND` operations targeted the merchant;
  the other targeted the payer wallet. So a payment lives in the **payer's** block,
  one block can carry sends to several accounts, and the unit to reason about is the
  individual operation, identified by block hash **and** operation index.
- The pagination cursor `startBlocksHash` is **exclusive**: the next page begins
  after it. `depth` auto-pages across `pageSize`.
- `UserClient.fromNetwork(network, account)` refuses an account without a private
  key, but accepts `null` as the signer. `client.client.getHistory` and `getBalance`
  then work for any public address. That is the watch-only client the server runs.
- `UserClient.on('change')` is "a websocket filtered to our account only". A client
  with a `null` signer has no account, so the subscription cannot serve a key-less
  watcher.
- `OperationType.SEND` is `0`. The SDK ships the enum's type declarations at
  `lib/block/operations.d.ts` but bundles the code into the package entry, so that
  path cannot be imported at runtime.

## Decisions

**Mechanism**

1. **Polling `getHistory`, no subscription.** The only option for a key-less client,
   and its cost is bounded by the cursor. Default interval five seconds.
2. **Correctness comes from the store, not from the watcher.** The payments ledger is
   keyed on (block hash, operation index) and both status transitions are
   idempotent, so re-reading a block changes nothing. The cursor and the lower bound
   exist for efficiency; losing the cursor means a slower scan, never a wrong one. A
   test deletes the cursor and asserts exactly that.
3. **Collect, then process oldest-first.** History arrives newest-first. Processing
   in that order would credit a full payment and then read an earlier underpayment
   as a duplicate, flipping the session to unmatched. Sorting by block date, hash
   and operation index first gives the chronological answer.
4. **The cursor is written only after every collected send is processed**, so a
   crash mid-scan re-reads the same staples next time, which decision 2 makes
   harmless.
5. **The lower bound** on a scan with no cursor is a little before the oldest
   session that could still be affected, with a ten-minute allowance for clock skew
   against the node. With no live sessions and no cursor the watcher reads one page,
   learns where "now" is, and stops.
6. **One scan at a time.** A tick during a running scan is answered with the
   in-flight promise, not a second scan.
7. **A page cap** (40 pages of 50) stops a corrupt cursor from walking the whole
   chain, with a warning. The cursor still advances, so the next scan resumes from
   the newest staple.

**The matching rule** (`watcher/matcher.ts`, a pure function)

8. In order: no reference → `no_reference`; unknown reference →
   `unknown_reference`; wrong token → `wrong_token`; wrong recipient →
   `wrong_recipient`; then by session status: `cancelled` stays cancelled; `paid`
   treats the identical (hash, index) as a replay and any other send as a
   `duplicate` that makes the session `unmatched`; `unmatched` absorbs further sends;
   then for `open` or `expired`: a block after `graceUntil` is `late` and makes the
   session `unmatched`; less than owed is `underpaid` and the session **stays
   open**; otherwise `matched` or `overpaid` and the session is `paid`.
9. **Time is judged by the block's date, never the watcher's clock.** A watcher
   catching up after an outage must classify by when a payment settled.
10. **Time beats amount.** A late underpayment is late.
11. **Underpayment does not close the session.** The payer sent 12.49 instead of
    12.50; they can still pay in full, and the partial is in the ledger for the
    merchant to refund. The earlier design said underpayments make a session
    `unmatched`; that would have forced a refund and a new session for a typo.

**The store**

12. **A payments ledger**: one row per inbound send ever observed, with its
    disposition and the session it was attributed to. The session status is the
    summary; the ledger is what a merchant reconciles and refunds from. Exposed to
    merchants at `GET /api/payments`, with a `refundable` flag.
13. **`markPaid` is allowed from `expired` inside the grace window**, and refuses
    any payment whose block settled after `graceUntil` regardless of the stored
    status. An unswept session can still read `open` long after its deadline; the
    block date is the truth. The same rule lives in `applyMarkPaid`, shared by both
    store implementations, so the stores cannot drift.
14. **Schema version 2**: `operation_index` on sessions, the `payments` table, a
    `meta` table for the cursor. A test builds a version 1 file by hand, opens it,
    and checks the upgrade keeps the old session and pays it with an index.

**Crash safety in `processPayment`**

15. **Transition first, ledger row second.** Both transitions are idempotent. If the
    process dies between them, the next scan re-reads the block, the matcher sees
    the session already paid by this exact send, calls it a replay, and the row is
    written then. Recording first and dying would leave a "paid" row beside an
    "open" session, and the dedup would then skip the fix forever. A test simulates
    the half-applied state and asserts recovery.
16. **A refused transition is logged loudly and the send is still recorded.** The
    matcher and the store apply the same rule, so this should not happen; if it
    does, the ledger must still say the money arrived.

## Consequences

- Step 6's end-to-end test pays a real session from the payer wallet and watches the
  watcher credit it. It should price in KTA: the faucet gives nothing else.
- Step 7's webhooks hang off the same `onSessionChange` events `processPayment`
  emits, including the `expired` that a sweep inside `processPayment` can announce
  just before an `unmatched`.
- The README's section 7 was corrected: it said underpayments make a session
  `unmatched` and that the block hash alone is the idempotency key. Neither
  survived contact with the chain.
- `SEND_OPERATION_TYPE` is pinned as the value `0` and checked two ways: the
  compiler asserts it against the SDK's enum type, and a live test extracts the real
  faucet send from the real history. If the SDK renumbers, `pnpm typecheck` fails.
- The watcher polls one account. A merchant with several receiving addresses runs
  one watcher each, sharing a store.
