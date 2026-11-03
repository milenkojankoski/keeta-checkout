/**
 * The refund vault on the real test network.
 *
 * Creates a vault with the merchant test wallet, reads its ACLs back and asserts
 * they are exactly the three designed rows, then proves the boundary the design
 * rests on: the signer cannot move a token it was not delegated, and a key-less
 * client can run the inspection.
 *
 * Publishes real blocks and spends a little test KTA. Skipped without the seeds.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as KeetaNet from '@keetanetwork/keetanet-client';
import * as KeetaAnchor from '@keetanetwork/anchor';
import { getDefaultResolverConfig } from '@keetanetwork/anchor/config.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRefundVault, inspectRefundVault } from '../src/vault.ts';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const merchantSeed = process.env.KEETA_MERCHANT_SEED;
const payerSeed = process.env.KEETA_PAYER_SEED;
const canRun = Boolean(merchantSeed && payerSeed) && (process.env.KEETA_NETWORK ?? 'test') === 'test';
const LONG = 180_000;

type UserClient = InstanceType<typeof KeetaNet.UserClient>;

describe.skipIf(!canRun)('refund vault on the Keeta test network', () => {
  const { Account } = KeetaNet.lib;
  let merchant: UserClient;
  let payer: UserClient;
  let signer: UserClient;
  let watch: UserClient;
  let usdc: string;
  let vault: string;
  let signerAddress: string;

  beforeAll(async () => {
    const merchantAccount = Account.fromSeed(merchantSeed as string, 0);
    merchant = KeetaNet.UserClient.fromNetwork('test', merchantAccount);
    payer = KeetaNet.UserClient.fromNetwork('test', Account.fromSeed(payerSeed as string, 0));
    const signerAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
    signerAddress = signerAccount.publicKeyString.get();
    signer = KeetaNet.UserClient.fromNetwork('test', signerAccount);
    watch = KeetaNet.UserClient.fromNetwork('test', null);

    const resolver = new KeetaAnchor.lib.Resolver({
      ...getDefaultResolverConfig(merchant),
      metadataConfig: { signing: { account: merchantAccount } }
    });
    const hit = await resolver.lookupToken('$USDC');
    if (!hit) throw new Error('no $USDC on test');
    usdc = hit.token;
  }, LONG);

  afterAll(async () => {
    await Promise.all([merchant?.destroy(), payer?.destroy(), signer?.destroy(), watch?.destroy()]);
  });

  it(
    'creates a vault and the ledger carries exactly the three designed rows',
    async () => {
      const created = await createRefundVault(merchant, { token: usdc, signer: signerAddress });
      vault = created.vault;
      expect(vault.startsWith('keeta_')).toBe(true);
      expect(created.token).toBe(usdc);
      expect(created.signer).toBe(signerAddress);

      // A key-less client is enough to inspect: the refund process does this at
      // start-up without any seed.
      const verdict = await inspectRefundVault(watch, { vault, token: usdc, signer: signerAddress });
      expect(verdict.problems).toEqual([]);
      expect(verdict.ready).toBe(true);
      expect(verdict.owner).toBe(merchant.account.publicKeyString.get());
      expect(verdict.rows).toHaveLength(3);

      const info = await watch.client.getAccountInfo(Account.fromPublicKeyString(vault));
      expect(info.info.name).toBe('KC_REFUND_VAULT');
    },
    LONG
  );

  it(
    'is judged not ready when inspected for a different signer or token',
    async () => {
      const otherSigner = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0).publicKeyString.get();
      const wrongSigner = await inspectRefundVault(watch, { vault, token: usdc, signer: otherSigner });
      expect(wrongSigner.ready).toBe(false);
      expect(wrongSigner.problems).toContain('the refund signer has no SEND_ON_BEHALF on the vault');

      const kta = merchant.baseToken.publicKeyString.get();
      const wrongToken = await inspectRefundVault(watch, { vault, token: kta, signer: signerAddress });
      expect(wrongToken.ready).toBe(false);
    },
    LONG
  );

  it(
    'the network, not our code, stops the signer moving a token it was not delegated',
    async () => {
      const vaultAccount = Account.fromPublicKeyString(vault);
      const kta = merchant.baseToken;
      // KTA is not delegated, and the vault cannot even hold it: refused at the
      // network with a permissions error, long before any balance is considered.
      await expect(signer.send(payer.account, 1n, kta, 'must be refused', { account: vaultAccount })).rejects.toThrow(
        /does not have required permissions/
      );
      // The delegated token with no balance is refused on balance, which proves the
      // delegation itself was accepted.
      await expect(
        signer.send(
          payer.account,
          1n,
          Account.fromPublicKeyString(usdc).assertKeyType(Account.AccountKeyAlgorithm.TOKEN),
          'must be refused',
          { account: vaultAccount }
        )
      ).rejects.toThrow(/negative/);
    },
    LONG
  );
});
