/**
 * A real refund on the Keeta test network.
 *
 * Creates a KTA vault with the merchant wallet, funds the vault with a refund float
 * and the signer with a KTA fee budget, records a duplicate payment from the payer
 * in an in-memory ledger, and lets the refund process send it back from the vault
 * through the delegated signer. Then the case decision 9 of docs/decisions/0014
 * exists for: a publish whose result the process never sees, reconciled from the
 * chain, with no second send.
 *
 * Publishes real blocks and spends a little test KTA. Skipped without the seeds.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemorySessionStore, refundExternal, type PaymentRow } from '@keeta-checkout/server';
import { RefundProcess, type VaultSigner } from '../src/process.ts';
import { sdkVaultSigner } from '../src/signer.ts';
import { createRefundVault, inspectRefundVault } from '../src/vault.ts';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const merchantSeed = process.env.KEETA_MERCHANT_SEED;
const payerSeed = process.env.KEETA_PAYER_SEED;
const canRun = Boolean(merchantSeed && payerSeed) && (process.env.KEETA_NETWORK ?? 'test') === 'test';
const LONG = 240_000;

type UserClient = InstanceType<typeof KeetaNet.UserClient>;

const REFUND = 10n ** 15n; // 0.001 KTA
const FLOAT = 5n * 10n ** 16n; // 0.05 KTA of refund float in the vault
const FEE_BUDGET = 3n * 10n ** 16n; // 0.03 KTA for the signer to pay fees

describe.skipIf(!canRun)('refund process on the Keeta test network', () => {
  const { Account } = KeetaNet.lib;
  let merchant: UserClient;
  let payer: UserClient;
  let signerClient: UserClient;
  let watch: UserClient;
  let kta: string;
  let vault: string;
  let payerAddress: string;
  let signer: VaultSigner;
  const quiet = { error: () => undefined, warn: () => undefined, info: () => undefined };

  beforeAll(async () => {
    merchant = KeetaNet.UserClient.fromNetwork('test', Account.fromSeed(merchantSeed as string, 0));
    payer = KeetaNet.UserClient.fromNetwork('test', Account.fromSeed(payerSeed as string, 0));
    const signerAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
    signerClient = KeetaNet.UserClient.fromNetwork('test', signerAccount);
    watch = KeetaNet.UserClient.fromNetwork('test', null);
    kta = merchant.baseToken.publicKeyString.get();
    payerAddress = payer.account.publicKeyString.get();

    const created = await createRefundVault(merchant, { token: kta, signer: signerAccount.publicKeyString.get() });
    vault = created.vault;
    const verdict = await inspectRefundVault(watch, { vault, token: kta, signer: signerAccount.publicKeyString.get() });
    if (!verdict.ready) throw new Error(`vault not ready: ${verdict.problems.join('; ')}`);

    // The vault gets the refund float; the signer gets its own KTA to pay fees.
    await merchant.send(Account.fromPublicKeyString(vault), FLOAT, merchant.baseToken, 'refund float for the live test');
    await merchant.send(signerAccount, FEE_BUDGET, merchant.baseToken, 'signer fee budget for the live test');
    signer = sdkVaultSigner(signerClient, vault);
  }, LONG);

  afterAll(async () => {
    // Return what is left to the merchant wallet: test KTA, but tidy anyway.
    try {
      const left = await watch.client.getBalance(Account.fromPublicKeyString(vault), merchant.baseToken);
      if (left > REFUND) {
        await merchant.send(merchant.account, left - REFUND, merchant.baseToken, 'live test cleanup', { account: Account.fromPublicKeyString(vault) });
      }
      const signerLeft = await signerClient.balance(signerClient.baseToken);
      if (signerLeft > REFUND) await signerClient.send(merchant.account, signerLeft - REFUND, signerClient.baseToken, 'live test cleanup');
    } catch {
      // Best effort.
    }
    await Promise.all([merchant?.destroy(), payer?.destroy(), signerClient?.destroy(), watch?.destroy()]);
  });

  function duplicatePayment(blockHash: string): PaymentRow {
    return {
      blockHash,
      operationIndex: 0,
      from: payerAddress,
      to: merchant.account.publicKeyString.get(),
      tokenAddress: kta,
      amount: REFUND,
      external: 'kc_live',
      blockDate: Date.now(),
      sessionId: null,
      disposition: 'duplicate',
      observedAt: Date.now()
    };
  }

  function makeProcess(store: MemorySessionStore, overrideSigner?: VaultSigner, now?: () => number): RefundProcess {
    return new RefundProcess({
      store,
      signer: overrideSigner ?? signer,
      vault,
      token: kta,
      limits: { ktaReserve: 10n ** 15n },
      autoRefund: ['duplicate'],
      // These payments are written before the process starts.
      autoRefundFrom: 0,
      reconcileGraceMs: 60_000,
      log: quiet,
      ...(now === undefined ? {} : { now })
    });
  }

  it(
    'sends a duplicate payment back to the payer from the vault, with the fee paid by the signer',
    async () => {
      const store = new MemorySessionStore();
      await store.recordPayment(duplicatePayment('LIVE_DUP_1'));
      const process = makeProcess(store);

      const payerBefore = await payer.balance(payer.baseToken);
      const signerBefore = await signerClient.balance(signerClient.baseToken);

      expect((await process.runOnce()).did).toBe('auto-requested');
      const outcome = await process.runOnce();
      expect(outcome.did).toBe('published');
      if (outcome.did !== 'published') return;

      expect(outcome.refund.blockHash).toMatch(/^[0-9A-F]+$/i);
      expect(outcome.refund.to).toBe(payerAddress);
      expect(await payer.balance(payer.baseToken)).toBe(payerBefore + REFUND);

      // The block is the vault's and carries the refund id; the signer paid the fee.
      const own = (await signer.history())
        .flatMap((e) => e.voteStaple.blocks)
        .find((b) => b.hash.toString() === outcome.refund.blockHash);
      expect(own?.account.publicKeyString.get()).toBe(vault);
      expect(own?.operations.some((op) => op.external === refundExternal(outcome.refund.id))).toBe(true);
      expect(await signerClient.balance(signerClient.baseToken)).toBeLessThan(signerBefore);
    },
    LONG
  );

  it(
    'reconciles a publish whose outcome it never saw, from the chain, without sending twice',
    async () => {
      const store = new MemorySessionStore();
      await store.recordPayment(duplicatePayment('LIVE_DUP_2'));

      // The real SDK publishes; the process is told the connection dropped.
      let realSends = 0;
      const flaky: VaultSigner = {
        ...signer,
        async send(to, amount, token, external) {
          realSends += 1;
          await signer.send(to, amount, token, external);
          throw new TypeError('fetch failed');
        }
      };
      let now = Date.now();
      const process = makeProcess(store, flaky, () => now);

      const payerBefore = await payer.balance(payer.baseToken);
      await process.runOnce(); // auto-request
      expect((await process.runOnce()).did).toBe('ambiguous');
      expect((await store.listRefunds())[0]?.status).toBe('publishing');

      now += 2_000;
      const outcome = await process.runOnce();
      expect(outcome).toMatchObject({ did: 'reconciled', found: true });
      const [refund] = await store.listRefunds();
      expect(refund?.status).toBe('published');
      expect(refund?.blockHash).toMatch(/^[0-9A-F]+$/i);
      expect(realSends).toBe(1);
      expect(await payer.balance(payer.baseToken)).toBe(payerBefore + REFUND);
    },
    LONG
  );
});
