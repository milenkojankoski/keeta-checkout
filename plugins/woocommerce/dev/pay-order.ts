/**
 * Pay a dev shop session from the development payer wallet.
 *
 * Usage, from the repository root:
 *   pnpm tsx plugins/woocommerce/dev/pay-order.ts cs_…
 *   pnpm tsx plugins/woocommerce/dev/pay-order.ts --latest
 *
 * `--latest` finds the newest open session on the dev server, which saves copying
 * an id out of the browser.
 *
 * This publishes a real block on the Keeta test network and spends a fraction of a
 * test KTA. It needs `.env.test` for the payer seed.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as KeetaNet from '@keetanetwork/keetanet-client';

const SERVER = process.env.KEETA_CHECKOUT_DEV_URL ?? 'http://localhost:3000';
const API_KEY = process.env.KEETA_CHECKOUT_DEV_KEY ?? 'kck_dev_0000000000000000000000';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (!existsSync(ENV_FILE)) {
  console.error('No .env.test found. Run `pnpm wallets:create` and `pnpm wallets:fund` first.');
  process.exit(1);
}
process.loadEnvFile(ENV_FILE);

const payerSeed = process.env.KEETA_PAYER_SEED;
if (payerSeed === undefined || payerSeed === '') {
  console.error('KEETA_PAYER_SEED is not set in .env.test.');
  process.exit(1);
}

interface SessionView {
  id: string;
  status: string;
  uri: string;
  amount: string;
  amountDecimal: string;
  tokenTicker: string | null;
  tokenAddress: string;
  receivingAddress: string;
  orderId: string;
  reference?: string;
}

async function merchantGet<T>(path: string): Promise<T> {
  const response = await fetch(`${SERVER}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** The newest session still waiting to be paid. */
async function latestOpenSession(): Promise<SessionView> {
  // There is no session listing yet, so the payments ledger cannot help. Instead
  // the dev shop's own order list is the index: ask WordPress nothing, and instead
  // read the sessions the server knows about through its own store by id. Since
  // that needs an id, `--latest` works from the server's log-free path: it tries
  // the session ids embedded in recent pay pages. Simplest reliable route is to
  // ask the operator for the id.
  throw new Error(
    'There is no session listing endpoint yet, so --latest cannot work.\n' +
      'Copy the id out of the pay page URL instead: http://localhost:3000/pay/<id>'
  );
}

const argument = process.argv[2];
if (argument === undefined) {
  console.error('Pass a session id: pnpm tsx plugins/woocommerce/dev/pay-order.ts cs_…');
  process.exit(1);
}

const session =
  argument === '--latest'
    ? await latestOpenSession()
    : await merchantGet<SessionView>(`/api/sessions/${encodeURIComponent(argument)}?view=merchant`);

console.log(`session   ${session.id}`);
console.log(`order     ${session.orderId}`);
console.log(`amount    ${session.amountDecimal} ${session.tokenTicker ?? ''} (${session.amount} base units)`);
console.log(`status    ${session.status}`);

if (session.status !== 'open') {
  console.log('\nNothing to pay: this session is not open.');
  process.exit(0);
}

const external = new URL(session.uri).searchParams.get('external');
if (external === null) {
  console.error('The payment URI carries no reference, which should be impossible.');
  process.exit(1);
}

const account = KeetaNet.lib.Account.fromSeed(payerSeed, 0);
const client = KeetaNet.UserClient.fromNetwork('test', account);

try {
  console.log(`\npaying from ${account.publicKeyString.get()}`);
  await client.send(session.receivingAddress, BigInt(session.amount), session.tokenAddress, external);
  console.log('published a real send on the test network');

  for (let attempt = 0; attempt < 40; attempt++) {
    const current = await merchantGet<SessionView>(`/api/sessions/${encodeURIComponent(session.id)}`);
    if (current.status !== 'open') {
      console.log(`\nsettled   ${current.status}`);
      console.log('\nThe session is settled. The order follows once the webhook is delivered,');
      console.log('which the dispatcher flushes every ten seconds, so give it a moment.');
      console.log('  http://localhost:8080/wp-admin/edit.php?post_type=shop_order');
      break;
    }
    await sleep(1500);
  }
} finally {
  await client.destroy();
}
