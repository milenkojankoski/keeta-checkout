/**
 * The `refunds` CLI, end to end on the Keeta test network.
 *
 * `refunds init` creates a real vault and prints the three environment variables.
 * Those variables, a funded vault and signer, and a duplicate payment written into
 * a shared SQLite file drive `startRefundsServe`, which refunds the payment back to
 * the payer. The shared file is the design from docs/decisions/0014: the checkout
 * server and the refund process are two processes over one database.
 *
 * Publishes real blocks and spends a little test KTA. Skipped without the seeds.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SqliteSessionStore, type PaymentRow } from '../src/index.ts';
import { parseArgs } from '../../cli/src/options.ts';
import { runRefundsInit, startRefundsServe } from '../../cli/src/refunds.ts';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const merchantSeed = process.env.KEETA_MERCHANT_SEED;
const payerSeed = process.env.KEETA_PAYER_SEED;
const canRun = Boolean(merchantSeed && payerSeed) && (process.env.KEETA_NETWORK ?? 'test') === 'test';
const LONG = 240_000;

type UserClient = InstanceType<typeof KeetaNet.UserClient>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!canRun)('refunds CLI on the Keeta test network', () => {
  const { Account } = KeetaNet.lib;
  let merchant: UserClient;
  let payer: UserClient;
  let payerAddress: string;
  let directory: string;
  const lines: string[] = [];
  const io = { log: (line: string) => void lines.push(line) };

  beforeAll(() => {
    merchant = KeetaNet.UserClient.fromNetwork('test', Account.fromSeed(merchantSeed as string, 0));
    payer = KeetaNet.UserClient.fromNetwork('test', Account.fromSeed(payerSeed as string, 0));
    payerAddress = payer.account.publicKeyString.get();
    directory = mkdtempSync(join(tmpdir(), 'keeta-refunds-cli-'));
  });

  afterAll(async () => {
    await Promise.all([merchant?.destroy(), payer?.destroy()]);
    rmSync(directory, { recursive: true, force: true });
  });

  function printed(name: string): string {
    const line = lines.find((entry) => entry.trim().startsWith(`${name}=`));
    if (line === undefined) throw new Error(`refunds init did not print ${name}`);
    return line.trim().slice(name.length + 1);
  }

  it(
    'inits a vault, then the served process refunds a recorded duplicate to the payer',
    async () => {
      const kta = merchant.baseToken.publicKeyString.get();

      // 1. refunds init, merchant seed in the environment, KTA as the refund token.
      lines.length = 0;
      const initCode = await runRefundsInit(
        parseArgs(['refunds', 'init', '--token', kta]),
        { KEETA_NETWORK: 'test', KEETA_CHECKOUT_REFUND_OWNER_SEED: merchantSeed },
        io
      );
      expect(initCode).toBe(0);
      const vault = printed('KEETA_CHECKOUT_REFUND_VAULT');
      const token = printed('KEETA_CHECKOUT_REFUND_TOKEN');
      const signerSeed = printed('KEETA_CHECKOUT_REFUND_SIGNER_SEED');
      expect(token).toBe(kta);

      // 2. Fund the vault and the signer, as init's guidance says to.
      const signerAddress = Account.fromSeed(signerSeed, 0).publicKeyString.get();
      await merchant.send(Account.fromPublicKeyString(vault), 5n * 10n ** 16n, merchant.baseToken, 'cli float');
      await merchant.send(Account.fromPublicKeyString(signerAddress), 3n * 10n ** 16n, merchant.baseToken, 'cli fees');

      // 3. Write a duplicate payment into the shared database, then close it so the
      // served process can open the same file without a lock fight.
      const dbFile = join(directory, 'shared.sqlite');
      const seed = new SqliteSessionStore({ filename: dbFile });
      const payment: PaymentRow = {
        blockHash: 'CLI_DUP',
        operationIndex: 0,
        from: payerAddress,
        to: merchant.account.publicKeyString.get(),
        tokenAddress: kta,
        amount: 10n ** 15n,
        external: 'kc_cli',
        blockDate: Date.now(),
        sessionId: null,
        disposition: 'duplicate',
        observedAt: Date.now()
      };
      await seed.recordPayment(payment);
      await seed.close();

      // 4. Start the served process against that file and let its timer run.
      const env: NodeJS.ProcessEnv = {
        KEETA_NETWORK: 'test',
        KEETA_CHECKOUT_RECEIVING_ADDRESS: merchant.account.publicKeyString.get(),
        KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20),
        KEETA_CHECKOUT_REFUND_VAULT: vault,
        KEETA_CHECKOUT_REFUND_TOKEN: token,
        KEETA_CHECKOUT_REFUND_SIGNER_SEED: signerSeed,
        KEETA_CHECKOUT_REFUND_AUTO: 'duplicate',
        KEETA_CHECKOUT_REFUND_KTA_RESERVE: '1000000000000000',
        KEETA_CHECKOUT_REFUND_INTERVAL_MS: '2000',
        KEETA_CHECKOUT_DATABASE: dbFile
      };
      const payerBefore = await payer.balance(payer.baseToken);
      const handle = await startRefundsServe(env, parseArgs(['refunds', 'serve']), io);
      expect(typeof handle).not.toBe('number');
      if (typeof handle === 'number') return;

      try {
        // The timer auto-requests, then publishes. Wait for the payer to be paid.
        let paid = false;
        for (let attempt = 0; attempt < 40 && !paid; attempt++) {
          await sleep(2_000);
          paid = (await payer.balance(payer.baseToken)) === payerBefore + payment.amount;
        }
        expect(paid).toBe(true);
      } finally {
        await handle.stop();
      }

      // 5. The shared database records the refund as published, with a block hash.
      const after = new SqliteSessionStore({ filename: dbFile });
      try {
        const refunds = await after.listRefunds();
        expect(refunds).toHaveLength(1);
        expect(refunds[0]?.status).toBe('published');
        expect(refunds[0]?.to).toBe(payerAddress);
        expect(refunds[0]?.blockHash).toMatch(/^[0-9A-F]+$/i);
      } finally {
        await after.close();
      }
    },
    LONG
  );
});
