/**
 * Measure the refund-vault design (docs/decisions/0014) on the test network.
 *
 * Run: pnpm tsx tools/refund-vault-spike.ts
 *
 * Publishes real blocks from the merchant test wallet and spends a little test KTA
 * on fees. What it measures:
 *
 *   1. The exact ACL rows a vault carries after setup, read back from the ledger,
 *      so `refunds init` can be tested against them.
 *   2. That a signer delegated for one token cannot move another token from the
 *      vault, enforced by the network and not by our code.
 *   3. Open question 1 in the record: whether a vault whose default permission is
 *      only STORAGE_DEPOSIT (no ACCESS) can still receive a deposit.
 *
 * Nothing here is reused by the product; it exists to turn assumptions into
 * observations before the real code is written.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import { clientFor, loadTestEnv, requireTestNetwork, signedResolver, accountFor } from './keeta.ts';

const { Account, Permissions, Block } = KeetaNet.lib;

loadTestEnv();
requireTestNetwork();

const merchant = clientFor('merchant');
const merchantAccount = accountFor('merchant');
const payer = clientFor('payer');

const json = (value: unknown): string =>
  JSON.stringify(value, (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);

async function aclRows(vault: InstanceType<typeof Account>): Promise<unknown[]> {
  const rows = await merchant.client.listACLsByEntity(vault);
  return rows.map((row) => {
    const r = row as unknown as Record<string, unknown>;
    const principal = r.principal as { publicKeyString?: { get(): string } } | undefined;
    const target = r.target as { publicKeyString?: { get(): string } } | null | undefined;
    const permissions = r.permissions as InstanceType<typeof Permissions> | undefined;
    return {
      principal: principal?.publicKeyString?.get() ?? json(principal),
      target: target?.publicKeyString?.get() ?? null,
      permissions: json(permissions?.toJSON?.() ?? permissions),
      has: {
        OWNER: permissions?.has(['OWNER']) ?? null,
        SEND_ON_BEHALF: permissions?.has(['SEND_ON_BEHALF']) ?? null,
        STORAGE_CAN_HOLD: permissions?.has(['STORAGE_CAN_HOLD']) ?? null,
        STORAGE_DEPOSIT: permissions?.has(['STORAGE_DEPOSIT']) ?? null,
        ACCESS: permissions?.has(['ACCESS']) ?? null
      }
    };
  });
}

try {
  const resolver = signedResolver(merchant, merchantAccount);
  const usdcHit = await resolver.lookupToken('$USDC');
  if (!usdcHit) throw new Error('no $USDC on test');
  const usdc = Account.fromPublicKeyString(usdcHit.token);
  const kta = merchant.baseToken;

  // A throwaway refund signer. Its seed is never printed.
  const signerSeed = Account.generateRandomSeed({ asString: true });
  const signerAccount = Account.fromSeed(signerSeed, 0);
  const signer = KeetaNet.UserClient.fromNetwork('test', signerAccount);

  console.log('merchant', merchantAccount.publicKeyString.get());
  console.log('signer  ', signerAccount.publicKeyString.get());

  // ---- 1. the vault, exactly as decision 2 and 3 describe --------------------
  const { account: vault } = await merchant.generateIdentifier(Account.AccountKeyAlgorithm.STORAGE);
  console.log('vault   ', vault.publicKeyString.get());

  const setup = merchant.initBuilder();
  setup.setInfo(
    {
      name: 'KC_REFUND_VAULT',
      description: 'Keeta Checkout refund float',
      metadata: '',
      defaultPermission: new Permissions(['ACCESS', 'STORAGE_DEPOSIT'])
    },
    { account: vault }
  );
  setup.updatePermissions(usdc, new Permissions(['STORAGE_CAN_HOLD']), undefined, Block.AdjustMethod.SET, { account: vault });
  setup.updatePermissions(kta, new Permissions(['STORAGE_CAN_HOLD']), undefined, Block.AdjustMethod.SET, { account: vault });
  setup.updatePermissions(signerAccount, new Permissions(['SEND_ON_BEHALF']), usdc, Block.AdjustMethod.SET, { account: vault });
  await setup.publish();
  console.log('\nvault configured. ACL rows read back from the ledger:');
  console.log(json(await aclRows(vault)));

  const info = await merchant.client.getAccountInfo(vault);
  console.log('\naccount info:', json({ name: info.info.name, defaultPermission: info.info.defaultPermission }));

  // ---- 2. the boundary: KTA is held but not delegated ------------------------
  const feeFloat = 10n ** 17n; // 0.1 KTA
  await merchant.send(vault, feeFloat, kta, 'spike fee float');
  console.log('\nfunded the vault with 0.1 KTA for fees. vault KTA:', await merchant.balance(kta, { account: vault }));

  console.log('signer tries to send KTA from the vault (not delegated for KTA):');
  try {
    await signer.send(payer.account, 1n, kta, 'must fail', { account: vault });
    console.log('  !! SENT. The boundary does not hold. Stop and re-read the design.');
  } catch (error) {
    console.log('  refused:', String(error).split('\n')[0]);
  }

  console.log('signer tries to send USDC from the vault (delegated, but the vault holds none):');
  try {
    await signer.send(payer.account, 1n, usdc, 'must fail on balance', { account: vault });
    console.log('  !! SENT with no balance?');
  } catch (error) {
    console.log('  refused:', String(error).split('\n')[0]);
  }

  console.log('merchant (owner) sends the KTA float back to itself:');
  await merchant.send(merchantAccount, feeFloat / 2n, kta, 'spike cleanup', { account: vault });
  console.log('  ok; owner can spend from the vault. vault KTA now:', await merchant.balance(kta, { account: vault }));

  // ---- 3. open question 1: is ACCESS needed for deposits? --------------------
  const { account: vault2 } = await merchant.generateIdentifier(Account.AccountKeyAlgorithm.STORAGE);
  const setup2 = merchant.initBuilder();
  setup2.setInfo(
    { name: 'KC_SPIKE_NO_ACCESS', description: 'default STORAGE_DEPOSIT only', metadata: '', defaultPermission: new Permissions(['STORAGE_DEPOSIT']) },
    { account: vault2 }
  );
  setup2.updatePermissions(kta, new Permissions(['STORAGE_CAN_HOLD']), undefined, Block.AdjustMethod.SET, { account: vault2 });
  await setup2.publish();
  console.log('\nvault2 (default STORAGE_DEPOSIT only, no ACCESS):', vault2.publicKeyString.get());
  console.log('payer deposits 0.001 KTA into vault2:');
  try {
    await payer.send(vault2, 10n ** 15n, kta, 'spike deposit');
    console.log('  ok; deposit works without ACCESS. vault2 KTA:', await merchant.balance(kta, { account: vault2 }));
  } catch (error) {
    console.log('  refused:', String(error).split('\n')[0]);
  }
} finally {
  await merchant.destroy();
  await payer.destroy();
}
