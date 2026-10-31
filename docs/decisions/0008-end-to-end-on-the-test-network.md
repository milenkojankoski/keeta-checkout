# 0008. End to end on the test network

Date: 2026-10-30
Status: accepted

## Context

Step 6: pay real sessions from the payer wallet and watch the watcher credit them.
This is the acceptance bar for everything built so far, and the first time a block
is published rather than read.

## What runs

`packages/server/test/e2e.live.test.ts`, skipped unless both dev-wallet seeds are in
`.env.test`. The server side runs exactly as production will: a key-less
`UserClient.fromNetwork('test', null)`, a `TokenRegistry` over it, a
`CheckoutService` on a store, and a `PaymentWatcher` polling the merchant's history.
Only the payer side holds a key. Every send is awaited before the next, because an
account is an ordered chain, and every assertion waits for the watcher to observe
the block rather than assuming timing.

Nine real sends on 2026-10-30, all credited or refused as the matching rule says:

| Case | Result on chain and in the store |
| --- | --- |
| exact payment | `paid`; `paidBy` is the payer; block hash equals the one `send` returned; ledger `matched`; **merchant balance rose by exactly the price** |
| overpayment by 7 base units | `paid`, `overpaidBy = 7n`, ledger `overpaid` |
| underpay, then pay in full | ledger `underpaid` with the session still `open`; then `paid` with ledger `matched` |
| send with no reference | ledger `no_reference`; no session touched |
| second payment to a paid session | session `unmatched`, original block hash kept, ledger `duplicate` |
| payment to a cancelled session | ledger `cancelled`, session stays `cancelled` |
| payment six seconds after a one-second session with no grace | `unmatched`, ledger `late`, block date after `graceUntil` |
| a fresh watcher over the same store | zero new ledger rows, no status changed |

Cost of a run: 9 sends, 0.009 KTA transferred (which lands back in the merchant
wallet), and **0.00000000038 KTA in fees** in total, about 4.2 × 10⁻¹¹ KTA per send.
The 10 KTA each dev wallet holds covers this indefinitely.

## Decisions

1. **Price the end-to-end test in KTA.** The faucet gives nothing else, and KTA's 18
   decimals are the hardest case for the amount code anyway. Acquiring test USDC
   through the Base bridge can wait until something needs a second token.
2. **The registry must work on a key-less client.** `UserClient.account` on a
   read-only client throws "No signer available in a read-only UserClient", which
   made `new TokenRegistry({ client })` fail the way production constructs it. It
   now builds an unsigned resolver when the client has no signer. Token listings and
   metadata are public, and the live test confirms an unsigned resolver returns
   `$KTA` with the right address, decimals and open ACL. Signing matters only for
   provider routes published to signed requests, which the registry never reads.
3. **`HistorySource.getHistory` takes a string address.** The SDK accepts account
   objects and `null` as well; declaring only the string is what lets the SDK's
   `Client` be passed as a `HistorySource` without a cast.
4. **`send` returns a union.** Published directly it carries `voteStaple`; through
   the publish aid it carries bare `blocks`. The test handles both; anything that
   reads a publish result must too.
5. **Clock skew margin.** The late-payment case uses a one-second session with no
   grace and waits six seconds before paying, so a few seconds of difference between
   this host's clock and the node's cannot flip the verdict.

## Consequences

- Steps 0 to 6 are done and the server's core is exercised against the real network
  from session creation to a settled, credited block.
- `pnpm test` publishes blocks when `.env.test` is present. That is the intent, and
  the cost is negligible, but CI must not be given main-network seeds. It runs with
  no seeds and skips these tests.
- A wallet with less than 0.02 KTA fails the suite with a message to run
  `pnpm wallets:fund`.
- The watcher's first scan on a fresh store with live sessions stopped at the lower
  bound, not by walking back to the faucet block from the day before. The bound
  works as designed.
