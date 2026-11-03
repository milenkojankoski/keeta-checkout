# 0014. Refunds

Date: 2026-11-03
Status: proposed, for review before any code

## Context

Step 13. Today the server records every payment it cannot credit (`underpaid`,
`late`, `duplicate`) and every overpayment, and the WooCommerce plugin leaves a note
on the order saying the money must go back by hand. That is honest, and it is also
the single most visible gap in the product.

This is the first step in which any part of Keeta Checkout holds a key. Everything
before it was watch-only by construction: a compromise of the server could read the
merchant's history and forge nothing. Refunds change that, and the design has to
keep the change as small as the network allows. Rule 1 in README section 11 says
the checkout server is watch-only; rule 2 says keys, when refunds are enabled, come
from a secret store; rule 6 says one publish at a time per signing account, with
`recover()` after any ambiguous failure. This record is how those three rules are
met.

## What the network enforces, and what it does not

Keeta enforces balances, permissions and signatures. A `SEND_ON_BEHALF` delegation
can be limited to one token, and revoking it takes effect when published. The
network enforces **no** amount cap, rate limit, recipient allowlist or expiry on a
delegation: a principal with `SEND_ON_BEHALF` on an account can move all of that
token the account holds, to anyone, as often as it likes. Every limit beyond "which
account, which token" is advisory and lives in our code, which means the design
must make the on-chain boundary small enough that the advisory limits are a
convenience rather than the last line of defence.

## Decisions

**1. Refunds are paid from a vault, never from the receiving account.**

The merchant's receiving account holds everything they have ever been paid. No key
with any power over it ever reaches a server. Instead the merchant creates a
storage account, the *refund vault*, funds it with a small float, and the float is
the blast radius. If the refund signer's key leaks, the attacker can empty the
vault and nothing else.

The alternative, `SEND_ON_BEHALF` on the receiving account itself, was rejected
without much discussion. It would make the refund signer a full-balance key with
an advisory cap in front of it, and advisory caps are exactly what a compromised
process does not run.

**2. The vault holds one token. It does not pay its own fees.**

A storage account's `defaultPermission` is `STORAGE_DEPOSIT` alone, so anyone can
pay into it but nothing can be held unless named. `STORAGE_CAN_HOLD` is granted to
exactly one principal, the refund token. A send of any other token from the vault
fails at the network, whatever our code says. One vault per accepted token; v1 of
refunds supports the one configured token, and a second token means a second vault.

*Measured on the test network, 2026-11-03* (`tools/refund-vault-spike.ts`,
`tools/refund-fee-spike.ts`):

- Granting `STORAGE_CAN_HOLD` with `AdjustMethod.ADD` is refused by the network
  with `PERMISSIONS_CANNOT_MIX_FLAGS_AND_TYPES`; `SET` is what works. The published
  reference uses `ADD`, and is wrong for this version.
- After setup the vault carries exactly three ACL rows: the owner with `OWNER`; the
  refund token with `STORAGE_CAN_HOLD` (the ledger adds `ACCESS` to every explicit
  grant); and the signer with `SEND_ON_BEHALF` targeted at the refund token.
  `refunds init` is tested against this list and refuses to report success if any
  other row is present.
- The signer's attempt to send a token it was not delegated was refused by the
  network with `needs [SEND_ON_BEHALF, ACCESS]`, before any balance check. The
  delegated token with no balance was refused on balance. The owner could spend.
- A vault whose default is `STORAGE_DEPOSIT` only, without `ACCESS`, accepted a
  deposit from an unrelated account. That answers open question 1: `ACCESS` is not
  needed in the default, so it is left out.

**3. A dedicated refund signer, delegated for one token, that also pays the fee.**

A new key-pair account, the *refund signer*, gets `SEND_ON_BEHALF` on the vault
with the refund token as target, and has no permission anywhere else. The merchant's
own account is the vault's `OWNER` and is the only thing that can widen or revoke
that delegation. Revocation is one `updatePermissions` with `SUBTRACT`, published
from the merchant's wallet, and is the emergency stop.

The signer holds a little KTA and pays the network fee for every refund, through a
fee block built against its own account. This was not the first plan. The first
plan let the vault pay its own fee from a KTA balance it also held, and it was
measured to fail in a way that matters: the delegated send landed on chain and then
threw `Resulting balance becomes negative` on a fee retry. A thrown balance error is
exactly what this process treats as a clean rejection, so the refund would have been
marked `failed` while the money had in fact gone out. Paying the fee from the signer
publishes cleanly, with no retry and no throw, and it keeps the vault genuinely
single-token. The cost is that the signer now holds value: a small KTA fee budget,
topped up like the float.

**4. The refund signer runs in its own process. The checkout server stays keyless.**

`keeta-checkout refunds serve` is a separate process holding
`KEETA_CHECKOUT_REFUND_SIGNER_SEED`. The HTTP server, the watcher and the webhook
dispatcher are unchanged and still construct a `UserClient` with no signer. The two
processes share the SQLite database: the refund process is a new singleton, like
the watcher and the dispatcher, and the rule "one of each per database" extends to
it. Claims use `BEGIN IMMEDIATE`, as everything else in the store does.

A flag that turns refunds on inside the main server was considered and rejected.
It would be one line easier to run and would put a seed in the process that faces
the internet.

**5. Setup is done once, by the merchant, with their own key, never on the server.**

`keeta-checkout refunds init` runs on the merchant's machine with their seed from a
secret store. It creates the vault, sets its permissions, creates the refund
signer, delegates, prints the vault address, prints the signer's seed once for the
secret store, and writes nothing to disk but the public addresses. It then tells
the merchant to fund two accounts: the vault with the refund float, and the signer
with a little KTA for fees. Funding is a plain `send` from the merchant's wallet,
which they can do from any Keeta wallet at any time; there is no funding command, so
no code path with the merchant's seed ever moves money.

**6. A refund can only ever go to the payer, in kind, for at most what they paid.**

The refund process never takes a recipient, a token or a free amount as input. A
refund is a row that points at a payment in the ledger, and from that row the
process derives all three: the recipient is the payment's `from` address, the token
is the payment's token, and the amount is either the whole payment or, for an
overpayment, exactly the excess. The API accepts a payment identifier and, for
overpayments, nothing else. There is no way to express "send X to Y" through this
system at all, which removes the whole class of mis-targeted and mis-sized refunds
before any policy check runs.

**7. Advisory limits, all of which fail closed.**

In config, in base units of the refund token:

- `maxPerRefund`: refuse any single refund above it.
- `maxPerDay`: refuse when the sum of refunds published or in flight in the last
  24 hours plus this one would exceed it. Its default is not a number but the
  vault's own balance, read fresh before each refund: a configured cap drifts out
  of step with the funding, the balance never does. A merchant who wants a tighter
  line than the float sets a number.
- `ktaReserve`: refuse to publish when the signer's KTA balance (which pays the
  fee) is below it, so a refund can never fail half-way for lack of fee.

Every check reads fresh state. A store error, an unreadable balance, an unknown
token decimal or a missing config value is a refusal, logged, never a default.
These limits are the second line; the float in the vault is the first.

**8. Underpaid and late refunds are requested; duplicates go back automatically.**

The three dispositions are not alike. Underpaid and late each have a legitimate
"keep it" case: a merchant may choose to fulfil an underpaid order, or has already
fulfilled a late one, so those are created by `POST /api/payments/{id}/refund` with
the merchant API key and nothing moves until then. A duplicate has no such case:
the shopper paid the same order twice, and holding their money until a merchant
gets round to a button is what produces support tickets and disputes, which is a
reputation cost for Keeta as a payment method and not only for the shop. So
`autoRefund` ships as `['duplicate']`. A merchant who wants every refund to be a
decision sets it to `[]`; one who trusts the limits can add `late` or `underpaid`.

Automatic refunds apply from the first time the process runs against a database,
not from the start of the ledger. The first version scanned from zero, which a
review caught: 0.1.0 told merchants to send duplicates back by hand, so turning
refunds on would have paid every one of those shoppers twice. Older payments are
refunded deliberately, through the API or the order screen.

**9. One publish at a time per account, with an idempotency key on the chain.**

The refund process holds a single in-flight publish for the vault at any time.
A refund row moves `requested` to `publishing` *before* the send is attempted,
with the attempt time persisted, and to `published` with the block hash after.
Every refund's `external` field carries `kcr_<refund id>`, so the chain itself
records which refund a block was.

After any failure that is not a clean rejection, the process assumes nothing. It
calls `pendingBlock()`, calls `recover()`, then walks the vault's `history()`
looking for a block whose `external` matches the refund in `publishing`. If it
finds one, the refund is `published` and was never retried. If it finds none, and
the row's attempt time is older than a grace window, the refund returns to
`requested` and is tried again. A `publishing` row younger than the window is left
alone. This is rule 6 exactly, and the live test for this step exercises it by
killing the process between the state write and the publish.

**10. Refunds are idempotent per payment.**

The refund ledger has a unique constraint on the payment it refunds. A second
request for the same payment returns the existing refund. An overpayment that was
refunded in part cannot be refunded again for the remainder through this system;
that is deliberate, because a second row would need a free amount, which decision
6 forbids.

**11. The plugin gets one button.**

In the WooCommerce order screen, a payment the server marked refundable shows a
"Refund via Keeta" action that calls the API with the payment id and nothing else.
The order note records the refund id and, when the webhook `refund.published`
arrives, the block hash and explorer link. The plugin never sees a key, a vault or
an amount it could edit.

## What a merchant sees

```
keeta-checkout refunds init          # once, on your own machine, with your seed
  vault         keeta_...            # send your refund float here, plus a little KTA
  signer        keeta_...            # put the printed seed in your secret store
keeta-checkout refunds serve         # on the server, next to `serve`
```

Then: `GET /api/payments?disposition=underpaid,late,duplicate` to see what needs
refunding, `POST /api/payments/{id}/refund` to refund one, `GET /api/refunds` to
watch them go out, and a `refund.published` or `refund.failed` webhook when they
do. The float runs down; the merchant tops it up from their wallet when the
process warns that the next refund would not clear.

## Failure modes, and what each one costs

| Failure | Cost | Why no worse |
| --- | --- | --- |
| Refund signer seed leaks | The vault's float, plus the signer's small KTA fee budget | The signer has no other permission anywhere; the receiving account is untouched; the merchant revokes with one block |
| Refund process bug sends twice | Nothing | The unique constraint, the `publishing` state and the `external` reconciliation each independently stop it |
| Refund process bug sends to the wrong address | Impossible by construction | There is no recipient input; the address is read from the payment row |
| Node outage mid-publish | A delay | Reconcile from history after the grace window; never retry blind |
| Signer runs out of KTA | Refunds stop | `ktaReserve` is checked before every publish, and the merchant is warned |
| Payer's address cannot hold the token | That one refund fails | Marked `failed` with the network's reason, for a person; the money stays in the vault |
| Store unavailable | Refunds stop | Every limit reads fresh state and fails closed |

## Alternatives considered

- **Multisig with a human co-signer on the vault.** Stronger, and the right answer
  for a large float. For a shop whose float is a day's refunds it turns every
  refund into a manual step, which is what we are trying to remove. Not in v1.
  The design keeps the door open: `SEND_ON_BEHALF` can be granted to a multisig
  account instead of a key pair with no other change, so a merchant can adopt it
  later without moving the vault. Documented as the upgrade for a large float.
- **Refund from the receiving account, cap in software.** Rejected; see decision 1.
- **Refunds inside the main server behind a flag.** Rejected; see decision 4.
- **Free-form refund amounts.** Rejected; see decision 6. A merchant who needs to
  send an arbitrary amount to a customer has a wallet for that.

## Open questions for the review

1. ~~Is `ACCESS` plus `STORAGE_DEPOSIT` as the vault's default the minimum?~~
   Measured: `STORAGE_DEPOSIT` alone works. See decision 2.
2. Whether a storage account can be the `from` of a shopper's payment and, if so,
   whether a send back to it needs anything beyond its own `STORAGE_DEPOSIT`. To
   be measured.
3. The grace window in decision 9. Settlement is about 400 ms; a node that is
   slow to index may take longer. Starting point: 60 seconds.
4. ~~How a delegated send from the vault pays its fee.~~ Measured: the vault paying
   its own fee lands the block and then throws a spurious balance error, so the
   signer pays instead. See decision 3.
5. Whether a USD-denominated refund (vault sends USDC, signer pays a KTA fee) is
   accepted the same way. Expected from the KTA case and the mixed-token spike, but
   not measured directly, because the faucet issues only KTA and the test wallets
   hold no USDC. Flagged for the first main-network trial.

## Build order for this step

1. This record, reviewed.
2. `refunds init` against the test network, with a test that reads the ACLs back
   and asserts exactly the permissions above and no others.
3. The refund ledger and the state machine in the store, with the unique
   constraint and the `BEGIN IMMEDIATE` claim.
4. The process: limits, publish, reconcile. Unit tests with a fake client; then
   the live test, including the kill-between-write-and-publish case.
5. The API routes and the two webhook events.
6. The plugin button, last.
