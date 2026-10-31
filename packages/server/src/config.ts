/**
 * Server configuration, validated once at startup.
 *
 * A misconfigured checkout server takes money to the wrong place, so every field is
 * checked here and the server refuses to start rather than guess. Nothing in this
 * file reads `process.env`: the host application decides where values come from, and
 * `configFromEnv` is offered as one convenience.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from './webhooks/types.ts';

const { Account } = KeetaNet.lib;

export type KeetaNetworkName = 'test' | 'main';

export const EXPLORER_URL: Record<KeetaNetworkName, string> = {
  test: 'https://explorer.test.keeta.com',
  main: 'https://explorer.keeta.com'
};

export interface CheckoutConfig {
  /** Which Keeta network this server operates on. Always explicit, never inferred. */
  network: KeetaNetworkName;

  /**
   * `keeta_…` account that receives payments. The server only ever needs this
   * public address: it holds no key and cannot move the funds that arrive.
   */
  receivingAddress: string;

  /**
   * Tokens a session may be priced in: resolver tickers (`$USDC`) or `keeta_…`
   * token addresses. Empty means every token the resolver lists is accepted.
   */
  acceptedTokens: string[];

  /**
   * Bearer keys that authorise creating sessions and reading the merchant view.
   * Secrets: load them from a secret store, never from source. They cannot move
   * funds, only create and read sessions.
   */
  apiKeys: string[];

  /** How long a new session stays open when the request does not say. */
  defaultExpiresSeconds: number;
  /** Bounds on a caller-supplied `expiresIn`. */
  minExpiresSeconds: number;
  maxExpiresSeconds: number;

  /**
   * Extra time after `expiresAt` during which a payment is still credited to the
   * session. A payer who opened the wallet a second before the deadline still pays
   * successfully. See the open question in README section 14.
   */
  graceSeconds: number;

  /**
   * Public base URL of this server, with no trailing slash. Used to build the
   * hosted pay-page link. `undefined` omits that link.
   */
  publicUrl?: string | undefined;

  /** Where to send webhooks. Empty means the server sends none. */
  webhookEndpoints: WebhookEndpoint[];
}

/** One place to notify, and what to notify it about. */
export interface WebhookEndpoint {
  /** An absolute http or https URL. */
  url: string;
  /**
   * The signing secret for this endpoint. A secret: load it from a secret store and
   * never log it. It proves a delivery came from this server; it grants nothing.
   */
  secret: string;
  /**
   * Which events to send here. Defaults to all of them. Narrow it when one endpoint
   * only cares about, say, refundable payments.
   */
  events: WebhookEventType[];
}

export interface CheckoutConfigInput
  extends Partial<Omit<CheckoutConfig, 'network' | 'receivingAddress' | 'webhookEndpoints'>> {
  network: KeetaNetworkName;
  receivingAddress: string;
  /** `events` may be omitted per endpoint to mean every event. */
  webhookEndpoints?: readonly Partial<WebhookEndpoint>[] | undefined;
}

function invalid(field: string, message: string): never {
  throw new Error(`checkout config: ${field} ${message}`);
}

function parseAccount(address: string): ReturnType<typeof Account.fromPublicKeyString> {
  try {
    return Account.fromPublicKeyString(address);
  } catch (error) {
    invalid('receivingAddress', `is not a valid Keeta address: ${String(error)}`);
  }
}

function parseHttpUrl(field: string, value: string): URL {
  try {
    return new URL(value);
  } catch {
    invalid(field, `is not a valid URL: ${value}`);
  }
}

/**
 * Parse `url|secret|event,event` triples, one endpoint per entry.
 *
 * The separator is `|` because a URL can contain almost anything else, and the
 * events list is comma-separated inside its own field.
 */
function parseWebhookEndpointSpecs(specs: readonly string[]): Partial<WebhookEndpoint>[] {
  return specs.map((spec, index) => {
    const parts = spec.split('|');
    if (parts.length < 2 || parts.length > 3) {
      invalid(
        `KEETA_CHECKOUT_WEBHOOKS[${index}]`,
        `must be "url|secret" or "url|secret|event,event", got ${JSON.stringify(spec)}`
      );
    }
    const [url, secret, events] = parts as [string, string, string | undefined];
    return {
      url: url.trim(),
      secret: secret.trim(),
      ...(events === undefined || events.trim() === ''
        ? {}
        : { events: events.split(',').map((event) => event.trim()).filter(Boolean) as WebhookEventType[] })
    };
  });
}

/** Validate and fill in a configuration. Throws on anything that would misroute money. */
export function resolveConfig(input: CheckoutConfigInput): CheckoutConfig {
  if (input.network !== 'test' && input.network !== 'main') {
    invalid('network', `must be "test" or "main", got ${JSON.stringify(input.network)}`);
  }

  const receivingAddress = (input.receivingAddress ?? '').trim();
  if (receivingAddress === '') invalid('receivingAddress', 'is required');
  const account = parseAccount(receivingAddress);
  if (account.isToken()) {
    invalid('receivingAddress', 'is a token address, not an account that can receive payments');
  }

  const apiKeys = (input.apiKeys ?? []).map((key) => key.trim()).filter((key) => key !== '');
  if (apiKeys.length === 0) invalid('apiKeys', 'needs at least one key, or no one can create a session');
  for (const key of apiKeys) {
    if (key.length < 16) invalid('apiKeys', 'each key must be at least 16 characters');
  }

  const defaultExpiresSeconds = input.defaultExpiresSeconds ?? 1800;
  const minExpiresSeconds = input.minExpiresSeconds ?? 60;
  const maxExpiresSeconds = input.maxExpiresSeconds ?? 86_400;
  const graceSeconds = input.graceSeconds ?? 600;

  for (const [field, value] of Object.entries({
    defaultExpiresSeconds,
    minExpiresSeconds,
    maxExpiresSeconds,
    graceSeconds
  })) {
    if (!Number.isInteger(value) || value < 0) invalid(field, `must be a whole number of seconds, got ${value}`);
  }
  if (minExpiresSeconds < 1) invalid('minExpiresSeconds', 'must be at least 1');
  if (minExpiresSeconds > maxExpiresSeconds) {
    invalid('minExpiresSeconds', `(${minExpiresSeconds}) cannot exceed maxExpiresSeconds (${maxExpiresSeconds})`);
  }
  if (defaultExpiresSeconds < minExpiresSeconds || defaultExpiresSeconds > maxExpiresSeconds) {
    invalid(
      'defaultExpiresSeconds',
      `(${defaultExpiresSeconds}) must be between minExpiresSeconds (${minExpiresSeconds}) and maxExpiresSeconds (${maxExpiresSeconds})`
    );
  }

  const publicUrlInput = input.publicUrl?.trim();
  let publicUrl: string | undefined;
  if (publicUrlInput !== undefined && publicUrlInput !== '') {
    const parsed = parseHttpUrl('publicUrl', publicUrlInput);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid('publicUrl', `must be http or https, got ${parsed.protocol}`);
    }
    publicUrl = publicUrlInput.replace(/\/+$/, '');
  }

  return {
    network: input.network,
    receivingAddress,
    acceptedTokens: (input.acceptedTokens ?? []).map((token) => token.trim()).filter((token) => token !== ''),
    apiKeys,
    defaultExpiresSeconds,
    minExpiresSeconds,
    maxExpiresSeconds,
    graceSeconds,
    publicUrl,
    webhookEndpoints: resolveWebhookEndpoints(input.webhookEndpoints ?? [])
  };
}

function resolveWebhookEndpoints(input: readonly Partial<WebhookEndpoint>[]): WebhookEndpoint[] {
  const endpoints: WebhookEndpoint[] = [];

  for (const [index, candidate] of input.entries()) {
    const field = `webhookEndpoints[${index}]`;
    const url = (candidate.url ?? '').trim();
    if (url === '') invalid(`${field}.url`, 'is required');
    const parsed = parseHttpUrl(`${field}.url`, url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      invalid(`${field}.url`, `must be http or https, got ${parsed.protocol}`);
    }

    const secret = (candidate.secret ?? '').trim();
    if (secret === '') invalid(`${field}.secret`, 'is required: an unsigned webhook cannot be trusted by its receiver');
    if (secret.length < 16) invalid(`${field}.secret`, 'must be at least 16 characters');

    const events = candidate.events === undefined ? [...WEBHOOK_EVENT_TYPES] : [...candidate.events];
    if (events.length === 0) invalid(`${field}.events`, 'must list at least one event, or be omitted for all of them');
    for (const event of events) {
      if (!WEBHOOK_EVENT_TYPES.includes(event)) {
        invalid(`${field}.events`, `has unknown event "${event}"; known: ${WEBHOOK_EVENT_TYPES.join(', ')}`);
      }
    }

    if (endpoints.some((existing) => existing.url === url)) {
      invalid(`${field}.url`, `is listed twice (${url}); give one endpoint one entry with all its events`);
    }

    endpoints.push({ url, secret, events });
  }

  return endpoints;
}

/**
 * Read a configuration out of environment variables.
 *
 * | Variable | Meaning |
 * | --- | --- |
 * | `KEETA_NETWORK` | `test` (default) or `main` |
 * | `KEETA_CHECKOUT_RECEIVING_ADDRESS` | required `keeta_…` account |
 * | `KEETA_CHECKOUT_API_KEYS` | comma-separated bearer keys |
 * | `KEETA_CHECKOUT_ACCEPTED_TOKENS` | comma-separated tickers or addresses |
 * | `KEETA_CHECKOUT_PUBLIC_URL` | public base URL of this server |
 * | `KEETA_CHECKOUT_EXPIRES_SECONDS` | default session lifetime |
 * | `KEETA_CHECKOUT_GRACE_SECONDS` | late-payment grace window |
 * | `KEETA_CHECKOUT_WEBHOOKS` | `url\|secret[\|event,event]`, several separated by `;` |
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CheckoutConfig {
  const list = (value: string | undefined): string[] =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '');

  const number = (value: string | undefined, field: string): number | undefined => {
    if (value === undefined || value.trim() === '') return undefined;
    if (!/^\d+$/.test(value.trim())) invalid(field, `must be a whole number of seconds, got ${JSON.stringify(value)}`);
    return Number(value.trim());
  };

  const network = (env.KEETA_NETWORK ?? 'test') as KeetaNetworkName;

  const expires = number(env.KEETA_CHECKOUT_EXPIRES_SECONDS, 'KEETA_CHECKOUT_EXPIRES_SECONDS');
  const grace = number(env.KEETA_CHECKOUT_GRACE_SECONDS, 'KEETA_CHECKOUT_GRACE_SECONDS');

  const webhookSpecs = (env.KEETA_CHECKOUT_WEBHOOKS ?? '')
    .split(';')
    .map((spec) => spec.trim())
    .filter((spec) => spec !== '');

  // Absent variables are left out rather than passed as `undefined`, so
  // `resolveConfig` applies its own defaults.
  return resolveConfig({
    webhookEndpoints: parseWebhookEndpointSpecs(webhookSpecs),
    network,
    receivingAddress: env.KEETA_CHECKOUT_RECEIVING_ADDRESS ?? '',
    apiKeys: list(env.KEETA_CHECKOUT_API_KEYS),
    acceptedTokens: list(env.KEETA_CHECKOUT_ACCEPTED_TOKENS),
    ...(env.KEETA_CHECKOUT_PUBLIC_URL === undefined ? {} : { publicUrl: env.KEETA_CHECKOUT_PUBLIC_URL }),
    ...(expires === undefined ? {} : { defaultExpiresSeconds: expires }),
    ...(grace === undefined ? {} : { graceSeconds: grace })
  });
}
