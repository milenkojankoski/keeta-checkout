/**
 * The refunds package: the only part of Keeta Checkout that ever signs.
 *
 * See docs/decisions/0014. The checkout server does not depend on this package;
 * the refund process and the `refunds` CLI commands do.
 */
export {
  VAULT_NAME,
  createRefundVault,
  inspectRefundVault,
  judgeVaultRows,
  type CreateRefundVaultOptions,
  type InspectRefundVaultOptions,
  type RefundVault,
  type VaultAclRow,
  type VaultInspection
} from './vault.ts';

export {
  RefundProcess,
  isCleanRejection,
  newRefundId,
  type RefundChangeEvent,
  type RefundLimits,
  type RefundProcessOptions,
  type RefundProcessOutcome,
  type VaultSigner
} from './process.ts';
export { sdkVaultSigner } from './signer.ts';
