/**
 * The checkout HTTP API.
 *
 * Routes, and who may call them:
 *
 * | Route | Auth |
 * | --- | --- |
 * | `POST /api/sessions` | merchant API key |
 * | `GET /api/sessions/:id` | session id (payer-safe view) |
 * | `GET /api/sessions/:id?view=merchant` | merchant API key (adds the reference) |
 * | `POST /api/sessions/:id/cancel` | session id |
 * | `GET /api/sessions/:id/events` | session id (server-sent events) |
 * | `GET /api/tokens` | merchant API key |
 * | `GET /health` | open |
 *
 * `uri`, `qrSvg` and `hostedUrl` join the session response in step 4. The shape of
 * everything else is settled here, so the button and the plugins can be written
 * against it.
 */
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { EXPLORER_URL } from '../config.ts';
import { CheckoutError } from '../errors.ts';
import { PaymentRequestError, renderQrSvg } from '../payment-request.ts';
import type { CheckoutService } from '../sessions/service.ts';
import { REFUNDABLE_DISPOSITIONS, type PaymentDisposition } from '../sessions/store.ts';
import { generateRefundId } from '../sessions/refs.ts';
import type { NewRefund, RefundReason, RefundStatus } from '../refunds/types.ts';
import { toRefundView } from '../webhooks/types.ts';
import type { DeliveryStatus } from '../webhooks/types.ts';
import { newNonce, payPageCsp, renderPayPage } from './pay-page.ts';
import { FONTS } from './fonts.generated.ts';
import type { Session } from '../sessions/types.ts';
import { requireApiKey } from './auth.ts';

/** Largest JSON body accepted. A session request is a few hundred bytes. */
const BODY_LIMIT = '16kb';

/** Comment sent down an idle event stream, to stop proxies closing it. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Concurrent event streams allowed per session.
 *
 * A held stream costs a socket and about 12 KB, measured, and the server stays
 * responsive with thousands open, so this is not a cliff being guarded. It is a
 * bound: without one, the number of streams a single session id can pin open is
 * limited only by the attacker's own sockets, and a session id is something anyone
 * who can reach a shop's checkout can mint.
 *
 * Twenty is far above honest use. A shopper has one pay page, perhaps a few tabs,
 * and `EventSource` reconnects rather than stacking connections, with `req.on`
 * `('close')` releasing a slot as soon as a socket drops.
 *
 * This is a backstop, not a substitute for a rate limit at the edge. See
 * `docs/decisions/0013-security-review.md`.
 */
const MAX_STREAMS_PER_SESSION = 20;

export interface CreateAppOptions {
  service: CheckoutService;
  /**
   * Sweep expired sessions on this interval, so a session nobody reads still
   * expires and still fires its event. `0` disables the timer; tests drive
   * `sweepExpired()` directly.
   */
  sweepIntervalMs?: number;
  /** Where to log unexpected failures. Defaults to `console`. */
  log?: Pick<Console, 'error'>;
  /** Shown as the heading on the hosted pay page. Defaults to "Pay with Keeta". */
  merchantName?: string | undefined;
}

export interface CheckoutApp {
  app: Express;
  /** Stop the sweep timer. Call before letting the process exit. */
  close(): void;
}

export function createApp(options: CreateAppOptions): CheckoutApp {
  const { service } = options;
  const log = options.log ?? console;
  const app = express();

  app.disable('x-powered-by');

  // Applied to every response, including the JSON API and the error paths. The pay
  // page sets a full CSP of its own on top of this; these two are the ones that
  // matter for an API, so they belong where no route can forget them.
  app.use((_req, res, next) => {
    // A JSON body a browser decides to sniff as HTML is an XSS in waiting.
    res.set('X-Content-Type-Options', 'nosniff');
    // Session ids live in these URLs. None of them should travel in a Referer.
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  // `strict: false` so a body that is valid JSON but not an object (a bare string,
  // a number, `null`) reaches our own validator and gets the same BODY_INVALID code
  // as any other wrong shape, instead of body-parser's generic parse failure.
  app.use(express.json({ limit: BODY_LIMIT, strict: false }));

  const merchantOnly = requireApiKey({ apiKeys: service.config.apiKeys });

  // The pay page's typefaces. Embedded rather than read from disk, so the bundled
  // CLI and the container carry them with no extra files; versioned names, so they
  // can be cached for a year.
  const fontBytes = new Map(Object.entries(FONTS).map(([name, base64]) => [name, Buffer.from(base64, 'base64')]));
  app.get('/assets/fonts/:name', (req, res, next) => {
    const bytes = fontBytes.get(param(req, 'name'));
    if (bytes === undefined) {
      next();
      return;
    }
    res.type('font/woff2');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(bytes);
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', network: service.config.network });
  });

  app.get('/api/tokens', merchantOnly, async (_req, res, next) => {
    try {
      const tokens = await service.acceptedTokens();
      res.json({
        network: service.config.network,
        tokens: tokens.map((token) => ({
          ticker: token.ticker,
          address: token.address,
          decimals: token.decimals,
          name: token.name,
          openToAnyHolder: token.openToAnyHolder
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // The payments ledger: every inbound send the watcher has seen and what it was.
  // `?disposition=underpaid,late` narrows to what needs refunding.
  app.get('/api/payments', merchantOnly, async (req, res, next) => {
    try {
      const dispositionParam = typeof req.query.disposition === 'string' ? req.query.disposition : undefined;
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      if (limitParam !== undefined && (!Number.isInteger(limitParam) || limitParam < 1 || limitParam > 1000)) {
        throw CheckoutError.invalid('LIMIT_INVALID', 'limit must be a whole number from 1 to 1000', 'limit');
      }

      const payments = await service.store.listPayments({
        ...(dispositionParam === undefined ? {} : { dispositions: dispositionParam.split(',').map((d) => d.trim()).filter(Boolean) as PaymentDisposition[] }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(limitParam === undefined ? {} : { limit: limitParam })
      });

      res.json({
        payments: payments.map((payment) => ({
          blockHash: payment.blockHash,
          operationIndex: payment.operationIndex,
          from: payment.from,
          to: payment.to,
          tokenAddress: payment.tokenAddress,
          amount: payment.amount.toString(),
          external: payment.external,
          blockDate: new Date(payment.blockDate).toISOString(),
          sessionId: payment.sessionId,
          disposition: payment.disposition,
          refundable: REFUNDABLE_DISPOSITIONS.has(payment.disposition),
          observedAt: new Date(payment.observedAt).toISOString(),
          explorerUrl: `${EXPLORER_URL[service.config.network]}/block/${payment.blockHash}`
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  // Create a refund for a recorded payment. The refund can only go back to the
  // payer, in the token they paid, for at most what they paid: none of that is a
  // parameter. The refund process, running separately, publishes it from the vault;
  // this route only writes the row. One refund per payment (see the store), so a
  // retry or a double click returns the existing one with 200 rather than 201.
  app.post('/api/payments/:blockHash/refund', merchantOnly, async (req, res, next) => {
    try {
      const blockHash = param(req, 'blockHash');
      const body = asRecord(req.body as unknown);
      const operationIndex = body.operationIndex === undefined ? 0 : asOperationIndex(body.operationIndex);

      const payment = await service.store.getPayment(blockHash, operationIndex);
      if (payment === undefined) {
        throw CheckoutError.notFound(`no payment ${blockHash}:${operationIndex}`);
      }

      let reason: RefundReason;
      let amount: bigint;
      if (payment.disposition === 'overpaid') {
        // The excess, read from the session, is the only refundable part of an
        // overpayment: the rest paid the order.
        const session = payment.sessionId === null ? undefined : await service.getSession(payment.sessionId).catch(() => undefined);
        const excess = session?.overpaidBy ?? null;
        if (excess === null || excess <= 0n) {
          throw CheckoutError.invalid('NOTHING_TO_REFUND', 'this payment has no overpaid excess to refund');
        }
        reason = 'overpaid';
        amount = excess;
      } else if (REFUNDABLE_DISPOSITIONS.has(payment.disposition)) {
        reason = payment.disposition as RefundReason;
        amount = payment.amount;
      } else {
        throw CheckoutError.invalid('NOT_REFUNDABLE', `a ${payment.disposition} payment is not refundable`, 'disposition');
      }

      const request: NewRefund = {
        id: generateRefundId(),
        paymentBlockHash: payment.blockHash,
        paymentOperationIndex: payment.operationIndex,
        sessionId: payment.sessionId,
        to: payment.from,
        tokenAddress: payment.tokenAddress,
        amount,
        reason,
        origin: 'api',
        createdAt: Date.now()
      };
      const { created, refund } = await service.store.createRefund(request);
      const session = payment.sessionId === null ? undefined : await service.store.get(payment.sessionId);
      res.status(created ? 201 : 200).json(toRefundView(refund, service.config.network, session));
    } catch (error) {
      next(error);
    }
  });

  // The refund ledger. `?status=published,failed` and `?sessionId=` narrow it.
  app.get('/api/refunds', merchantOnly, async (req, res, next) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      if (limitParam !== undefined && (!Number.isInteger(limitParam) || limitParam < 1 || limitParam > 1000)) {
        throw CheckoutError.invalid('LIMIT_INVALID', 'limit must be a whole number from 1 to 1000', 'limit');
      }
      const refunds = await service.store.listRefunds({
        ...(statusParam === undefined ? {} : { statuses: statusParam.split(',').map((status) => status.trim()).filter(Boolean) as RefundStatus[] }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(limitParam === undefined ? {} : { limit: limitParam })
      });
      // One session read per distinct session, not per refund.
      const sessions = new Map<string, Session | undefined>();
      const views = [];
      for (const refund of refunds) {
        let session: Session | undefined;
        if (refund.sessionId !== null) {
          if (!sessions.has(refund.sessionId)) sessions.set(refund.sessionId, await service.store.get(refund.sessionId));
          session = sessions.get(refund.sessionId);
        }
        views.push(toRefundView(refund, service.config.network, session));
      }
      res.json({ refunds: views });
    } catch (error) {
      next(error);
    }
  });

  // Webhook delivery history, so a merchant can see what was sent, what failed, and
  // what gave up. Payloads and signing secrets are not included: the payload may be
  // large and the merchant already received it, and the secret is never echoed.
  app.get('/api/webhook-deliveries', merchantOnly, async (req, res, next) => {
    try {
      const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
      const eventId = typeof req.query.eventId === 'string' ? req.query.eventId : undefined;
      const limitParam = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      if (limitParam !== undefined && (!Number.isInteger(limitParam) || limitParam < 1 || limitParam > 1000)) {
        throw CheckoutError.invalid('LIMIT_INVALID', 'limit must be a whole number from 1 to 1000', 'limit');
      }

      const deliveries = await service.store.listDeliveries({
        ...(statusParam === undefined
          ? {}
          : { statuses: statusParam.split(',').map((s) => s.trim()).filter(Boolean) as DeliveryStatus[] }),
        ...(eventId === undefined ? {} : { eventId }),
        ...(limitParam === undefined ? {} : { limit: limitParam })
      });

      res.json({
        deliveries: deliveries.map((delivery) => ({
          id: delivery.id,
          eventId: delivery.eventId,
          eventType: delivery.eventType,
          endpointUrl: delivery.endpointUrl,
          status: delivery.status,
          attempts: delivery.attempts,
          nextAttemptAt: delivery.status === 'pending' ? new Date(delivery.nextAttemptAt).toISOString() : null,
          lastError: delivery.lastError,
          lastStatusCode: delivery.lastStatusCode,
          createdAt: new Date(delivery.createdAt).toISOString(),
          updatedAt: new Date(delivery.updatedAt).toISOString(),
          deliveredAt: delivery.deliveredAt === null ? null : new Date(delivery.deliveredAt).toISOString()
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sessions', merchantOnly, async (req, res, next) => {
    try {
      const body = asRecord(req.body as unknown);
      const session = await service.createSession({
        amount: asString(body.amount),
        currency: asString(body.currency),
        orderId: asString(body.orderId),
        successUrl: asString(body.successUrl),
        cancelUrl: asString(body.cancelUrl),
        ...(body.expiresIn === undefined ? {} : { expiresIn: asExpiresIn(body.expiresIn) })
      });
      res.status(201).json(service.toMerchantView(session));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sessions/:id', async (req, res, next) => {
    try {
      const session = await service.getSession(param(req, 'id'));
      if (req.query.view === 'merchant') {
        // The merchant view carries the payment reference, so it needs the key.
        merchantOnly(req, res, (error?: unknown) => {
          if (error !== undefined) {
            next(error);
            return;
          }
          res.json(service.toMerchantView(session));
        });
        return;
      }
      res.json(service.toPublicView(session));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sessions/:id/cancel', async (req, res, next) => {
    try {
      const session = await service.cancelSession(param(req, 'id'));
      res.json(service.toPublicView(session));
    } catch (error) {
      next(error);
    }
  });

  // Served as an image so a pay page can use `<img src="…/qr.svg">` with no
  // JavaScript, and so a ~6 KB SVG is fetched once instead of riding along on every
  // status payload and every event.
  app.get('/api/sessions/:id/qr.svg', async (req, res, next) => {
    try {
      const session = await service.getSession(param(req, 'id'));
      const svg = await renderQrSvg(service.paymentUriFor(session));
      res.type('image/svg+xml');
      // The URI is fixed for the life of the session, so the image is immutable.
      // `private` because the URL embeds a session capability.
      res.set('Cache-Control', 'private, max-age=300, immutable');
      res.send(svg);
    } catch (error) {
      next(error);
    }
  });

  // The hosted pay page. Public by session id, like the other payer routes, and
  // built to work with JavaScript switched off.
  app.get('/pay/:id', async (req, res, next) => {
    try {
      const session = await service.getSession(param(req, 'id'));
      const nonce = newNonce();
      res.type('html');
      res.set('Content-Security-Policy', payPageCsp(nonce));
      res.set('Referrer-Policy', 'no-referrer');
      res.set('X-Content-Type-Options', 'nosniff');
      // A pay page must never be cached: its status changes.
      res.set('Cache-Control', 'no-store');
      res.send(
        renderPayPage({
          session: service.toPublicView(session),
          nonce,
          ...(options.merchantName === undefined ? {} : { merchantName: options.merchantName })
        })
      );
    } catch (error) {
      next(error);
    }
  });

  // The no-JavaScript cancel path: a form POST, then back to the shop. Separate
  // from the JSON route so a browser without fetch still lands somewhere useful.
  app.post('/pay/:id/cancel', express.urlencoded({ extended: false }), async (req, res, next) => {
    try {
      const id = param(req, 'id');
      // Read first, so an already-paid session returns the shopper to the success
      // page rather than showing them an error they cannot act on.
      const before = await service.getSession(id);
      const session = before.status === 'open' ? await service.cancelSession(id) : before;
      res.redirect(303, session.status === 'paid' ? session.successUrl : session.cancelUrl);
    } catch (error) {
      next(error);
    }
  });

  // One entry per session with at least one stream open; deleted on the last close,
  // so an idle server holds nothing.
  const openStreams = new Map<string, number>();

  app.get('/api/sessions/:id/events', async (req, res, next) => {
    try {
      await streamSessionEvents(service, req, res, openStreams);
    } catch (error) {
      next(error);
    }
  });

  app.use((req, res, next) => {
    if (res.headersSent) {
      next();
      return;
    }
    res.status(404).json(CheckoutError.notFound(`no route ${req.method} ${req.path}`).toJSON());
  });

  // Four parameters: express identifies an error handler by arity, so `_next` must
  // stay in the signature even though it is never called.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      // An event stream already started; nothing useful can be sent now.
      res.end();
      return;
    }

    if (error instanceof CheckoutError) {
      res.status(error.status).json(error.toJSON());
      return;
    }

    // A session whose URI or QR cannot be built is a server-side problem: the
    // address and amount were validated when the session was created.
    if (error instanceof PaymentRequestError) {
      log.error('[keeta-checkout] payment request failed', error);
      const failed = CheckoutError.internal('could not build this payment request');
      res.status(failed.status).json(failed.toJSON());
      return;
    }

    // A malformed JSON body surfaces as a SyntaxError from express.json().
    if (error instanceof SyntaxError && 'body' in error) {
      const bad = CheckoutError.invalid('MALFORMED_JSON', 'the request body is not valid JSON');
      res.status(bad.status).json(bad.toJSON());
      return;
    }

    // Anything else is a bug or an outage. Log it in full, tell the client nothing.
    log.error('[keeta-checkout] unhandled error', error);
    const internal = CheckoutError.internal();
    res.status(internal.status).json(internal.toJSON());
  });

  const sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
  const sweepTimer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          void service.sweepExpired().catch((error: unknown) => {
            log.error('[keeta-checkout] sweep failed', error);
          });
        }, sweepIntervalMs)
      : undefined;
  // Never hold the process open just to sweep.
  sweepTimer?.unref();

  return {
    app,
    close(): void {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
    }
  };
}

/**
 * Stream one session's status as server-sent events.
 *
 * Sends the current state immediately, so a client that connects after the payment
 * still learns it is paid, then one event per change.
 *
 * The stream closes as soon as the session stops being `open`, which is a different
 * question from whether its status is terminal in the state machine. An `expired`
 * session may still become `unmatched` if a late payment turns up, but the payer
 * watching this stream has nothing further to learn, and holding the connection
 * open for an outcome only the merchant acts on would leak a socket per dead
 * session.
 */
async function streamSessionEvents(
  service: CheckoutService,
  req: Request,
  res: Response,
  openStreams: Map<string, number>
): Promise<void> {
  const id = param(req, 'id');
  const session = await service.getSession(id); // 404s before any stream starts

  const held = openStreams.get(id) ?? 0;
  if (held >= MAX_STREAMS_PER_SESSION) {
    // 429 rather than 503: the limit is per session, so it is this caller's own
    // doing, and the right response is for them to use the stream they already have.
    throw CheckoutError.tooManyRequests(
      'TOO_MANY_STREAMS',
      `this session already has ${MAX_STREAMS_PER_SESSION} event streams open; close one before opening another`
    );
  }
  openStreams.set(id, held + 1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer text/event-stream unless told otherwise.
    'X-Accel-Buffering': 'no'
  });

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    // Release the slot before ending the response, so a client that reconnects the
    // instant it sees the stream close never races its own old connection.
    const remaining = (openStreams.get(id) ?? 1) - 1;
    if (remaining > 0) openStreams.set(id, remaining);
    else openStreams.delete(id);
    res.end();
  };

  const heartbeat = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const unsubscribe = service.onSessionChange(id, ({ session: changed }) => {
    send('session', service.toPublicView(changed));
    if (!awaitingPayment(changed)) finish();
  });

  req.on('close', finish);
  // The session lookup above awaited, and a client can drop the socket during it.
  // Node emits 'close' once; if that happened before the listener existed, nothing
  // would ever release this stream's slot or its listener. Not reproduced under
  // 400 open-and-abort attempts against the live server, but the guard costs one
  // property read and the failure it prevents would be permanent.
  if (req.destroyed || res.destroyed) {
    finish();
    return;
  }

  send('session', service.toPublicView(session));
  if (!awaitingPayment(session)) finish();
}

/**
 * A required path parameter. Express types `req.params` with an index signature, so
 * under `noUncheckedIndexedAccess` every lookup is possibly `undefined`; a route that
 * declares `:id` always has one, and a missing one is a routing bug, not bad input.
 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  // Express types a parameter as `string | string[]`, the array form being for
  // repeated patterns. Our routes declare `:id` once, so anything else is a
  // routing bug rather than bad input.
  /* c8 ignore next -- unreachable while the route pattern declares one `:id`. */
  if (typeof value !== 'string') throw CheckoutError.internal(`route parameter ${name} is missing`);
  return value;
}

/** Whether a payer watching this session can still expect it to be paid. */
function awaitingPayment(session: Session): boolean {
  return session.status === 'open';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw CheckoutError.invalid('BODY_INVALID', 'the request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/**
 * Pass strings through and reject everything else. A number for `amount` is refused
 * rather than coerced: `12.10` as JSON is a float, and the point of taking a string
 * is that the merchant's exact digits survive the trip.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOperationIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw CheckoutError.invalid('OPERATION_INDEX_INVALID', 'operationIndex must be a whole number of 0 or more', 'operationIndex');
  }
  return value;
}

function asExpiresIn(value: unknown): number {
  if (typeof value !== 'number') {
    throw CheckoutError.invalid('EXPIRES_IN_INVALID', 'expiresIn must be a number of seconds', 'expiresIn');
  }
  return value;
}
