/**
 * Receiving Keeta Checkout webhooks: a complete, correct handler.
 *
 * Run it:
 *   node examples/express-shop/verify-webhook.mjs
 *
 * Then point an endpoint at it:
 *   KEETA_CHECKOUT_WEBHOOKS='http://localhost:4000/hooks/keeta|whsec_dev_0000000000000000'
 *
 * Four things here are not optional, and each one has bitten somebody:
 *
 *  1. **Verify against the raw body.** `express.raw()`, not `express.json()`. The
 *     signature covers the exact bytes that were sent; parsing and re-serialising
 *     changes spacing and key order and the check fails.
 *  2. **Dedupe on `event.id`.** Delivery is at-least-once. A handler that already
 *     shipped the order must not ship it twice when a retry arrives.
 *  3. **Do not trust the order of events.** Retries interleave, so
 *     `session.unmatched` can arrive before `session.paid` for the same session.
 *     Decide from the session's state in the body, or read the session back.
 *  4. **Answer 2xx quickly.** Any other status is retried for about 24 hours. Queue
 *     the slow work and return, rather than holding the request open.
 */
import express from 'express';
import { verifyWebhookSignature, WebhookSignatureError } from '@keeta-checkout/server';

const SECRET = process.env.KEETA_CHECKOUT_WEBHOOK_SECRET ?? 'whsec_dev_0000000000000000';
const PORT = Number(process.env.PORT ?? 4000);

const app = express();

/** Event ids already handled. A real shop uses its database, not a Set. */
const handled = new Set();

app.post('/hooks/keeta', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const rawBody = req.body.toString('utf8');

  try {
    verifyWebhookSignature({
      rawBody,
      header: req.get('Keeta-Checkout-Signature'),
      // An array here instead of a string lets you rotate the secret without
      // dropping deliveries signed with the old one.
      secret: SECRET
    });
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      // 400, not 500: a bad signature will never become good, so there is no point
      // in the server retrying it.
      console.warn(`rejected a delivery: ${error.reason}`);
      return res.status(400).json({ error: error.reason });
    }
    throw error;
  }

  const event = JSON.parse(rawBody);

  if (handled.has(event.id)) {
    // Already done. Still answer 2xx, or it will be retried forever.
    return res.status(200).json({ received: true, duplicate: true });
  }
  handled.add(event.id);

  switch (event.type) {
    case 'checkout.session.paid': {
      const { orderId, amountDecimal, tokenTicker, overpaidBy, explorerUrl } = event.data.session;
      console.log(`order ${orderId} is paid: ${amountDecimal} ${tokenTicker ?? ''} (${explorerUrl})`);
      if (overpaidBy !== null) console.log(`  overpaid by ${overpaidBy} base units; refund the difference`);
      // Fulfil the order here, or enqueue the fulfilment and return.
      break;
    }

    case 'checkout.session.expired':
    case 'checkout.session.cancelled':
      console.log(`order ${event.data.session.orderId} will not be paid (${event.type}); release the stock`);
      break;

    case 'checkout.session.unmatched':
      // Money arrived that cannot be credited to this session: a late payment, or a
      // second one. The payments ledger says which.
      console.log(`order ${event.data.session.orderId} needs attention: ${event.type}`);
      break;

    case 'checkout.payment.recorded': {
      const { disposition, amount, from, refundable, explorerUrl } = event.data.payment;
      console.log(`a payment was recorded as ${disposition}: ${amount} base units from ${from} (${explorerUrl})`);
      if (refundable) console.log('  this money is sitting with you and should go back');
      break;
    }

    default:
      // An unknown type is a newer server, not an error. Accept it.
      console.log(`ignoring unknown event type ${event.type}`);
  }

  res.status(200).json({ received: true });
});

app.listen(PORT, () => {
  console.log(`listening for Keeta Checkout webhooks on http://localhost:${PORT}/hooks/keeta`);
});
