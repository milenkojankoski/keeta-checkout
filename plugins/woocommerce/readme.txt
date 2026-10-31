=== Keeta Checkout for WooCommerce ===
Contributors: keetacheckout
Tags: woocommerce, payment gateway, keeta, stablecoin, crypto
Requires at least: 7.0
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 0.1.0
License: Apache-2.0
License URI: https://www.apache.org/licenses/LICENSE-2.0

Accept Keeta payments in WooCommerce. Settles to your own Keeta account in about 400 ms, with no processor fee.

== Description ==

Customers pay from a Keeta wallet. The money goes straight from them to your own
Keeta account, with no processor in between and no percentage taken.

**Your keys stay yours.** This plugin talks to a Keeta Checkout server that you
run. That server holds no seed and no private key: it needs only your account's
public address, so nothing in this setup can move your funds, including the plugin
and including a stolen API key.

= What you need =

1. A Keeta account, and its public address.
2. A Keeta Checkout server, which is one command: `npx keeta-checkout init` then
   `npx keeta-checkout serve`. It can run on the same host as your shop.
3. The API key and webhook secret that `init` generates.

= How a payment goes =

1. The customer picks Keeta at checkout.
2. The plugin creates a payment request on your server and sends them to its pay
   page, where they scan a QR code or tap through to their wallet.
3. The payment settles on the Keeta network in about 400 ms.
4. Your server notices it and tells this plugin, which marks the order paid.

The order is completed from a signed webhook, never from the customer's browser.
If they close the tab after paying, the order still completes.

= What it does not do =

* **No conversion.** An order of 12.50 is charged as 12.50 of the token you choose,
  so that token has to be worth the same as your store currency. The settings
  screen warns you if the pairing looks wrong.
* **No refunds yet.** Send money back from your own wallet. The server's
  `/api/payments` endpoint lists what needs refunding and to whom, including
  underpayments and late payments that could not be credited.
* **Works with both checkouts.** The classic shortcode and the Checkout block.
* **No tax calculation.** WooCommerce already does your tax; this plugin passes the
  total it is given.

== Installation ==

1. Install and activate the plugin.
2. Go to WooCommerce → Settings → Payments → Keeta Checkout.
3. Fill in your server URL, API key and webhook secret, and pick a token.
4. Copy the webhook URL shown on that screen into your server's
   `KEETA_CHECKOUT_WEBHOOKS` setting, with the same secret.
5. Enable the method.

Run `npx keeta-checkout check` on your server first. It confirms your address and
token actually work on the network you chose, which is cheaper than finding out
from a customer who cannot pay.

== Frequently Asked Questions ==

= Do I need to verify my identity? =

Not to receive payments. Keeta needs no KYC for an account to be paid in open
tokens such as $USDC. You would only need verification later, to move money from
Keeta into a bank account.

= Which token should I use? =

One worth the same as your store currency: $USDC for a USD store, $EURC for a EUR
store. Avoid the `$KB` tokens for a public shop: they are open at the ledger but
need provider onboarding to obtain, so almost no customer holds one.

= What happens if a customer pays the wrong amount? =

An underpayment leaves the order unpaid and the money recorded, so you can refund
it; the customer can still pay in full. An overpayment completes the order and
notes the excess so you can return it. Both appear as order notes.

= What if the webhook does not arrive? =

Deliveries are retried for about 24 hours. As a second safety net, when a customer
lands back on your thank-you page the plugin asks the server directly whether the
session was paid, so a missed webhook does not leave a paid order stuck.

= Can I use this with Shopify instead? =

Not with this plugin. See the project's own documentation; Shopify requires approval
to act as a payment method.

== Changelog ==

= 0.1.0 =
* First release: redirect-based gateway, signed webhooks, order notes for payments
  that need refunding, and a warning when the token and store currency disagree.
* Pressing the pay button again returns the shopper to the request they already
  have instead of creating a second one, and a payment on any request an order has
  ever had is credited to that order.
* Orders stay pending while awaiting payment, so the pay page's cancel button works.
* A payment whose amount no longer matches the order total puts the order on hold
  for review instead of completing it; a second payment on a paid order is noted.
