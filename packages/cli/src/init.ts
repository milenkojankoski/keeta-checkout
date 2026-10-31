/**
 * `keeta-checkout init`: write a configuration a merchant can actually start from.
 *
 * It generates the two secrets rather than asking for them, because a human asked
 * to invent an API key invents a weak one. Everything else it either takes from a
 * flag or asks for, and it refuses to overwrite an existing file.
 *
 * It never asks for a seed or a private key. The server does not have one and
 * cannot use one: it needs only the merchant's public receiving address.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { flagBoolean, flagString, type ParsedArgs } from './options.ts';

const { Account } = KeetaNet.lib;

export interface InitIO {
  log: (line: string) => void;
  /** Ask a question. `undefined` when there is no terminal to ask on. */
  ask?: ((question: string, fallback?: string) => Promise<string>) | undefined;
}

/** A readline-backed asker, used when the process has a terminal. */
export function terminalAsker(): (question: string, fallback?: string) => Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return async (question: string, fallback?: string): Promise<string> => {
    const suffix = fallback === undefined ? '' : ` [${fallback}]`;
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === '' ? (fallback ?? '') : answer;
  };
}

export async function runInit(args: ParsedArgs, env: NodeJS.ProcessEnv, io: InitIO): Promise<number> {
  const path = flagString(args, 'out') ?? '.env';
  const force = flagBoolean(args, 'force');

  if (existsSync(path) && !force) {
    io.log(`${path} already exists. Pass --force to replace it, or --out to write somewhere else.`);
    return 1;
  }

  // With no terminal there is nobody to ask, so every answer has to come from a
  // flag, the environment, or the default.
  const ask =
    io.ask ?? ((_question: string, fallback?: string): Promise<string> => Promise.resolve(fallback ?? ''));

  const network = flagString(args, 'network') ?? env.KEETA_NETWORK ?? (await ask('Network, test or main', 'test'));
  if (network !== 'test' && network !== 'main') {
    io.log(`The network must be "test" or "main", not ${JSON.stringify(network)}.`);
    return 1;
  }

  const address =
    flagString(args, 'receiving-address') ??
    env.KEETA_CHECKOUT_RECEIVING_ADDRESS ??
    (await ask('Your Keeta receiving address (keeta_…)'));

  if (address === '') {
    io.log('A receiving address is required: it is where payments land.');
    io.log('Create one in the Keeta wallet, then paste its public address here.');
    return 1;
  }
  try {
    const account = Account.fromPublicKeyString(address);
    if (account.isToken()) {
      io.log('That is a token address, not an account that can receive payments.');
      return 1;
    }
  } catch {
    io.log(`${address} is not a valid Keeta address.`);
    return 1;
  }

  const tokens = flagString(args, 'accept') ?? (await ask('Tokens to accept, comma separated', '$USDC'));
  const publicUrl = flagString(args, 'public-url') ?? (await ask('Public URL of this server, blank for none', ''));
  const webhookUrl = flagString(args, 'webhook-url') ?? (await ask('Webhook URL, blank for none', ''));

  const apiKey = `kck_${randomBytes(24).toString('base64url')}`;
  const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;

  const lines = [
    '# Keeta Checkout configuration.',
    `# Written by \`keeta-checkout init\` on ${new Date().toISOString()}.`,
    '#',
    '# This file holds secrets. Keep it out of version control.',
    '#',
    '# Note what is NOT here: no seed, no private key. The server only ever needs the',
    '# public receiving address, so a leak of this file cannot move your funds.',
    '',
    `KEETA_NETWORK=${network}`,
    `KEETA_CHECKOUT_RECEIVING_ADDRESS=${address}`,
    '',
    '# Bearer keys your backend uses to create sessions. They cannot move money.',
    `KEETA_CHECKOUT_API_KEYS=${apiKey}`,
    '',
    '# Tokens a session may be priced in. Blank means every open token the resolver',
    '# lists. Permit-listed tokens are refused whatever you put here.',
    `KEETA_CHECKOUT_ACCEPTED_TOKENS=${tokens}`,
    '',
    '# Where shoppers reach this server. Needed for hostedUrl and absolute QR links.',
    `KEETA_CHECKOUT_PUBLIC_URL=${publicUrl}`,
    '',
    '# Where the session database lives. A path, or :memory: to keep nothing.',
    'KEETA_CHECKOUT_DATABASE=./keeta-checkout.sqlite',
    '',
    '# Webhooks, as url|secret[|event,event], several separated by a semicolon.',
    webhookUrl === ''
      ? `# KEETA_CHECKOUT_WEBHOOKS=https://your-shop.example/hooks/keeta|${webhookSecret}`
      : `KEETA_CHECKOUT_WEBHOOKS=${webhookUrl}|${webhookSecret}`,
    ''
  ];

  writeFileSync(path, lines.join('\n'), { encoding: 'utf8', mode: 0o600 });

  io.log(`Wrote ${path}.`);
  io.log('');
  io.log('Two secrets were generated. They are in that file and nowhere else:');
  io.log('  an API key, for your backend to create sessions');
  io.log(`  a webhook signing secret${webhookUrl === '' ? ', ready for when you add an endpoint' : ''}`);
  io.log('');
  io.log('Next:');
  io.log(`  keeta-checkout check    # confirm the address and tokens resolve on ${network}`);
  io.log('  keeta-checkout serve    # start taking payments');

  if (network === 'main') {
    io.log('');
    io.log('This is the main network. Payments will be real money.');
  }

  return 0;
}
