/**
 * Everything needed to turn a configuration into a running checkout server.
 *
 * Kept apart from the command that calls it so a host application can embed the
 * same wiring, and so the start-up and shutdown order is written down in one place.
 *
 * The order matters on the way down. Stop accepting new requests first, then stop
 * the watcher so it is not mid-scan, then the dispatcher, which flushes the
 * deliveries it has already queued, and only then close the store. Closing the
 * store first would make everything above it fail on its way out.
 */
import { createServer, type Server } from 'node:http';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import {
  CheckoutService,
  MemorySessionStore,
  PaymentWatcher,
  SqliteSessionStore,
  TokenRegistry,
  WebhookDispatcher,
  createApp,
  type CheckoutConfig,
  type SessionStore
} from '@keeta-checkout/server';

export interface RuntimeOptions {
  config: CheckoutConfig;
  /** SQLite file, or `:memory:` for a store that is lost on exit. */
  database: string;
  host: string;
  port: number;
  /** Shown as the heading on the hosted pay page. */
  merchantName?: string | undefined;
  /** How often to poll the chain, in milliseconds. */
  watchIntervalMs?: number;
  /** How often to retry due webhook deliveries, in milliseconds. */
  webhookIntervalMs?: number;
  log?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface Runtime {
  /** The port actually bound, which differs from the requested one when that was 0. */
  port: number;
  store: SessionStore;
  service: CheckoutService;
  watcher: PaymentWatcher;
  dispatcher: WebhookDispatcher;
  server: Server;
  /** Shut everything down in the right order. Safe to call twice. */
  stop(): Promise<void>;
}

export async function startRuntime(options: RuntimeOptions): Promise<Runtime> {
  const log = options.log ?? console;
  const { config } = options;

  // Watch-only: no signer anywhere on the server. It cannot move the funds that
  // arrive, which is the point. `UserClient.account` throws on such a client, and
  // the token registry is built to cope with that.
  const client = KeetaNet.UserClient.fromNetwork(config.network, null);

  const store: SessionStore =
    options.database === ':memory:'
      ? new MemorySessionStore()
      : new SqliteSessionStore({ filename: options.database });

  const tokens = new TokenRegistry({ client });
  const service = new CheckoutService({ config, store, tokens, log });

  const watcher = new PaymentWatcher({
    service,
    history: client.client,
    receivingAddress: config.receivingAddress,
    log
  });

  const dispatcher = new WebhookDispatcher({ service, config, log });

  // Kept whole rather than destructured: pulling `close` off the object would
  // detach it from its receiver.
  const checkoutApp = createApp({
    service,
    log,
    ...(options.merchantName === undefined ? {} : { merchantName: options.merchantName })
  });

  const server = createServer(checkoutApp.app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : options.port;

  watcher.start(options.watchIntervalMs ?? 5_000);
  dispatcher.start(options.webhookIntervalMs ?? 10_000);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    checkoutApp.close();
    await watcher.stop();
    await dispatcher.stop();
    await store.close();
    await client.destroy();
  };

  return { port, store, service, watcher, dispatcher, server, stop };
}

/** What a merchant sees on start-up. Never prints a secret. */
export function describeRuntime(options: RuntimeOptions, port: number, endpointCount: number): string[] {
  const lines = [
    `Keeta Checkout is listening on http://${options.host}:${port}`,
    `  network            ${options.config.network}`,
    `  receiving address  ${options.config.receivingAddress}`,
    `  accepted tokens    ${options.config.acceptedTokens.length === 0 ? 'every open token the resolver lists' : options.config.acceptedTokens.join(', ')}`,
    `  database           ${options.database}`,
    `  API keys           ${options.config.apiKeys.length} configured`,
    `  webhooks           ${endpointCount === 0 ? 'none configured' : `${endpointCount} endpoint(s)`}`
  ];

  if (options.config.publicUrl === undefined) {
    lines.push(
      '',
      'No public URL is set, so sessions carry no hostedUrl and QR links are relative.',
      'Set KEETA_CHECKOUT_PUBLIC_URL to the address shoppers reach this server on.'
    );
  } else {
    lines.push('', `Pay pages are at ${options.config.publicUrl}/pay/<session id>`);
  }

  if (options.config.network === 'main') {
    lines.push('', 'This is the MAIN network. Payments are real money.');
  }

  return lines;
}
