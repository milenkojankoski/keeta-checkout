/**
 * Measure how a delegated send from the refund vault pays its network fee.
 *
 * Run: pnpm tsx tools/refund-fee-spike.ts
 *
 * The live refund test failed with "Votes require fees but generateFeeBlock was
 * not defined". Three ways to pay the fee are tried, in order, and whichever works
 * decides docs/decisions/0014 decision 2 and 3:
 *
 *   A. the SDK default, from the signer's client, with `{ account: vault }`;
 *   B. an explicit fee block built for the vault (needs KTA delegation);
 *   C. an explicit fee block built for the signer's own account, funded with a
 *      little KTA (keeps the vault single-token and the delegation single-token).
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { clientFor, loadTestEnv, requireTestNetwork, accountFor } from './keeta.ts';
import { createRefundVault, inspectRefundVault } from '../packages/refunds/src/vault.ts';

const { Account } = KeetaNet.lib;

loadTestEnv();
requireTestNetwork();

const merchant = clientFor('merchant');
const payer = clientFor('payer');
const payerAddress = accountFor('payer').publicKeyString.get();

const first = (e: unknown): string => String(e instanceof Error ? e.message : e).split('\n')[0] ?? '';

try {
  const kta = merchant.baseToken;
  const signerAccount = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
  const signer = KeetaNet.UserClient.fromNetwork('test', signerAccount);
  const signerAddress = signerAccount.publicKeyString.get();

  const { vault } = await createRefundVault(merchant, { token: kta.publicKeyString.get(), signer: signerAddress });
  const vaultAccount = Account.fromPublicKeyString(vault);
  const verdict = await inspectRefundVault(merchant, { vault, token: kta.publicKeyString.get(), signer: signerAddress });
  console.log('vault', vault, 'ready:', verdict.ready, verdict.problems);

  await merchant.send(vaultAccount, 5n * 10n ** 16n, kta, 'fee spike float');
  console.log('vault KTA:', await merchant.balance(kta, { account: vaultAccount }));

  const attempt = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
    console.log(`\n${label}`);
    try {
      const result = await run();
      const staple = (result as { voteStaple?: { blocks?: Array<{ account: { publicKeyString: { get(): string } }; hash: { toString(): string } }> } }).voteStaple;
      console.log('  PUBLISHED. blocks:', staple?.blocks?.map((b) => `${b.account.publicKeyString.get().slice(0, 14)}…:${b.hash.toString().slice(0, 10)}`));
      console.log('  vault KTA now:', await merchant.balance(kta, { account: vaultAccount }), ' signer KTA:', await signer.balance(kta));
      return true;
    } catch (error) {
      console.log('  refused:', first(error));
      return false;
    }
  };

  const amount = 10n ** 15n;

  await attempt('A. SDK default fee handling, delegated send with { account: vault }', () =>
    signer.send(payerAddress, amount, kta, 'spike A', { account: vaultAccount })
  );

  await attempt('B. explicit fee block built for the VAULT (fee paid by the vault)', () =>
    signer.send(payerAddress, amount, kta, 'spike B', {
      account: vaultAccount,
      generateFeeBlock: async (staple, options) => signer.initBuilder({ ...options, account: vaultAccount }).computeFeeBlock(staple)
    })
  );

  await merchant.send(signerAccount, 2n * 10n ** 16n, kta, 'signer fee budget');
  console.log('\nfunded the signer with 0.02 KTA for fees. signer KTA:', await signer.balance(kta));

  await attempt('C. explicit fee block built for the SIGNER (fee paid by the signer itself)', () =>
    signer.send(payerAddress, amount, kta, 'spike C', {
      account: vaultAccount,
      generateFeeBlock: async (staple) => signer.initBuilder({ account: signerAccount }).computeFeeBlock(staple)
    })
  );

  console.log('\npayer KTA delta check done; cleaning up');
  const left = await merchant.balance(kta, { account: vaultAccount });
  if (left > 10n ** 15n) await merchant.send(merchant.account, left - 10n ** 15n, kta, 'spike cleanup', { account: vaultAccount });
  await signer.destroy();
} finally {
  await merchant.destroy();
  await payer.destroy();
}
