/**
 * Ask the Keeta test faucet for KTA for both development wallets, then wait for it
 * to arrive.
 *
 * Run: pnpm wallets:fund
 *      pnpm wallets:fund --amount 5
 *      pnpm wallets:fund --role payer
 *
 * The faucet sends in batches and replies with an HTML page, so the reply is ignored
 * and the balance is polled instead. It exists only on the test network, is rate
 * limited, and may be empty: this script reports that rather than looping.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FAUCET_URL,
  WALLET_ROLES,
  addressFor,
  clientFor,
  decimalsOf,
  explorerAccountUrl,
  formatBaseUnits,
  loadTestEnv,
  requireTestNetwork,
  type WalletRole
} from './keeta.ts';

loadTestEnv();
requireTestNetwork();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const amount = flag('amount') ?? '10';
if (!/^\d+$/.test(amount)) throw new Error(`--amount must be a whole number of test KTA, got "${amount}"`);

const roleArg = flag('role');
if (roleArg !== undefined && !WALLET_ROLES.includes(roleArg as WalletRole)) {
  throw new Error(`--role must be one of ${WALLET_ROLES.join(', ')}, got "${roleArg}"`);
}
const roles = roleArg === undefined ? WALLET_ROLES : [roleArg as WalletRole];

const POLL_INTERVAL_MS = 15_000;
const POLL_ATTEMPTS = 20; // about five minutes

async function requestFromFaucet(address: string): Promise<void> {
  const response = await fetch(FAUCET_URL, {
    method: 'POST',
    // Exactly this header: the faucet rejects a ";charset" suffix.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ address, amount })
  });
  await response.text(); // An HTML page. Nothing useful to parse.
  if (!response.ok) {
    throw new Error(`faucet replied ${response.status} ${response.statusText} for ${address}`);
  }
}

// Ask for every wallet first, so the batches are already in flight while we wait.
const starting = new Map<WalletRole, bigint>();
for (const role of roles) {
  const address = addressFor(role);
  const client = clientFor(role);
  try {
    starting.set(role, await client.balance(client.baseToken));
    await requestFromFaucet(address);
    console.log(`Asked the faucet for ${amount} KTA for ${role} (${address}).`);
  } finally {
    await client.destroy();
  }
}

console.log('\nThe faucet sends in batches. Polling for arrival.\n');

for (const role of roles) {
  const client = clientFor(role);
  try {
    const before = starting.get(role) ?? 0n;
    const decimals = await decimalsOf(client, client.baseToken);
    let balance = before;

    for (let attempt = 0; attempt < POLL_ATTEMPTS && balance <= before; attempt++) {
      if (attempt > 0) await sleep(POLL_INTERVAL_MS);
      balance = await client.balance(client.baseToken);
    }

    const address = addressFor(role);
    if (balance > before) {
      console.log(`${role.padEnd(9)} ${formatBaseUnits(balance, decimals)} KTA (${balance} base units)`);
    } else {
      console.log(`${role.padEnd(9)} still ${formatBaseUnits(balance, decimals)} KTA: nothing arrived yet.`);
      console.log(`${''.padEnd(9)} The faucet may be rate limited or empty. Check ${explorerAccountUrl(address)}`);
      console.log(`${''.padEnd(9)} and run \`pnpm wallets:status\` again in a few minutes. Do not loop on the faucet.`);
    }
  } finally {
    await client.destroy();
  }
}
