/**
 * The SDK behind `VaultSigner`.
 *
 * A refund is published *from the vault* (`{ account: vault }`) and signed by the
 * refund signer under its `SEND_ON_BEHALF` delegation. The network fee is paid by
 * the signer, not the vault: `generateFeeBlock` builds the fee block against the
 * signer's own account. Measured on the test network, this is the combination that
 * publishes cleanly; letting the vault pay its own fee lands the block but then
 * throws a spurious balance error on a fee retry (docs/decisions/0014, decision 3).
 *
 * So the vault holds only the refund token, and the signer holds a little KTA.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import type { HistoryEntryLike } from '@keeta-checkout/server';
import type { VaultSigner } from './process.ts';

const { Account } = KeetaNet.lib;
type UserClient = InstanceType<typeof KeetaNet.UserClient>;

export function sdkVaultSigner(client: UserClient, vaultAddress: string): VaultSigner {
  const vault = Account.fromPublicKeyString(vaultAddress);
  const token = (address: string) => Account.fromPublicKeyString(address).assertKeyType(Account.AccountKeyAlgorithm.TOKEN);
  const signerAccount = client.account;

  return {
    async send(to, amount, tokenAddress, external) {
      const published = await client.send(Account.fromPublicKeyString(to), amount, token(tokenAddress), external, {
        account: vault,
        // The fee block is the signer's own, so the fee comes from the signer's KTA.
        generateFeeBlock: (staple, options) => client.initBuilder({ ...options, account: signerAccount }).computeFeeBlock(staple)
      });
      return { blockHash: blockHashFor(published, vaultAddress) };
    },
    balance: (tokenAddress) => client.balance(token(tokenAddress), { account: vault }),
    /** The signer's own KTA, which pays the fees. */
    feeBalance: () => client.balance(client.baseToken),
    hasPendingBlock: async () => (await client.pendingBlock({ account: vault })) !== null,
    async recover() {
      await client.recover(true, { account: vault });
    },
    history: async () => (await client.history({ pageSize: 50 }, { account: vault })).map((entry) => entry as unknown as HistoryEntryLike)
  };
}

/**
 * The hash of the vault's block inside a publish result. A refund is the vault's
 * send block in the staple, alongside the signer's fee block; pick the vault's, or
 * say so rather than record a wrong hash against a refund.
 */
function blockHashFor(published: unknown, vaultAddress: string): string {
  const result = published as {
    voteStaple?: { blocks?: Array<{ hash: { toString(): string }; account: { publicKeyString: { get(): string } } }> };
    blocks?: Array<{ hash: { toString(): string }; account: { publicKeyString: { get(): string } } }>;
  };
  const blocks = result.voteStaple?.blocks ?? result.blocks ?? [];
  const own = blocks.find((block) => block.account.publicKeyString.get() === vaultAddress);
  if (own === undefined) throw new Error('the publish result carries no block from the vault');
  return own.hash.toString();
}
