/**
 * The refund vault: a storage account that holds the refund float and nothing else.
 *
 * Everything here was measured on the test network before it was written; see
 * docs/decisions/0014, decision 2. The shape that works:
 *
 *   - the vault's default permission is STORAGE_DEPOSIT alone, so anyone can pay
 *     in but nothing can be held unless named;
 *   - STORAGE_CAN_HOLD is granted, with SET (ADD is refused by the network), to
 *     exactly one principal: the refund token;
 *   - the refund signer gets SEND_ON_BEHALF targeted at that token, and nothing
 *     else anywhere.
 *
 * The vault does not hold KTA and does not pay its own fees. A send that pays its
 * fee from the vault was measured to land on chain and then throw a spurious
 * "balance becomes negative" on a fee retry, which a caller cannot tell from a
 * real rejection. The signer pays the fee from its own KTA instead, which
 * publishes cleanly; see `signer.ts` and decision 3.
 *
 * After setup the ledger carries exactly three ACL rows, and `inspectRefundVault`
 * refuses to call a vault ready if it carries any other.
 *
 * `createRefundVault` is the only function in the refunds package that needs the
 * merchant's own key. It runs once, on the merchant's machine, never on a server.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';

const { Account, Permissions, Block } = KeetaNet.lib;

type UserClient = InstanceType<typeof KeetaNet.UserClient>;
type GenericAccount = ReturnType<typeof Account.fromPublicKeyString>;

/** The vault's name on chain, so a merchant can recognise it in an explorer. */
export const VAULT_NAME = 'KC_REFUND_VAULT';

export interface CreateRefundVaultOptions {
  /** The token refunds will be paid in. Must match what the checkout accepts. */
  token: GenericAccount | string;
  /** The refund signer's public address. Its seed never comes here. */
  signer: GenericAccount | string;
  /** Overrides the on-chain name. */
  name?: string;
}

export interface RefundVault {
  vault: string;
  token: string;
  signer: string;
  /** The staple that configured it, for the explorer. */
  blocksHash: string | undefined;
}

/**
 * Create and configure a refund vault, owned by `owner`'s account.
 *
 * Two publishes: the identifier itself, then one staple that sets the default
 * permission and the two grants, so the vault is never observable half-configured
 * with a permissive default.
 */
export async function createRefundVault(owner: UserClient, options: CreateRefundVaultOptions): Promise<RefundVault> {
  const token = asAccount(options.token);
  const signer = asAccount(options.signer);

  const { account: vault } = await owner.generateIdentifier(Account.AccountKeyAlgorithm.STORAGE);

  const setup = owner.initBuilder();
  setup.setInfo(
    {
      name: options.name ?? VAULT_NAME,
      description: 'Keeta Checkout refund float. Holds one token; the signer pays fees.',
      metadata: '',
      defaultPermission: new Permissions(['STORAGE_DEPOSIT'])
    },
    { account: vault }
  );
  setup.updatePermissions(token, new Permissions(['STORAGE_CAN_HOLD']), undefined, Block.AdjustMethod.SET, { account: vault });
  setup.updatePermissions(signer, new Permissions(['SEND_ON_BEHALF']), token, Block.AdjustMethod.SET, { account: vault });
  const published = await setup.publish();

  return {
    vault: vault.publicKeyString.get(),
    token: token.publicKeyString.get(),
    signer: signer.publicKeyString.get(),
    blocksHash: stapleHash(published)
  };
}

/** One ACL row as this module reasons about it, with addresses as strings. */
export interface VaultAclRow {
  principal: string;
  target: string | null;
  has: (flag: 'OWNER' | 'SEND_ON_BEHALF' | 'STORAGE_CAN_HOLD' | 'STORAGE_DEPOSIT' | 'ACCESS') => boolean;
}

export interface VaultInspection {
  ready: boolean;
  /** Every reason it is not ready, in plain words. Empty when ready. */
  problems: string[];
  /** The rows as read, for the CLI to print. */
  rows: Array<{ principal: string; target: string | null; flags: string[] }>;
  owner: string | undefined;
}

export interface InspectRefundVaultOptions {
  vault: GenericAccount | string;
  token: GenericAccount | string;
  signer: GenericAccount | string;
}

/**
 * Read a vault's ACLs from the ledger and judge them.
 *
 * Any client will do, including a key-less one: this reads, it does not sign. The
 * refund process runs it at start-up and refuses to publish anything from a vault
 * that is not exactly as designed, because an extra SEND_ON_BEHALF row is how a
 * float walks out of the door.
 */
export async function inspectRefundVault(client: UserClient, options: InspectRefundVaultOptions): Promise<VaultInspection> {
  const vault = asAccount(options.vault);
  const rows = await client.client.listACLsByEntity(vault);
  return judgeVaultRows(rows.map(toVaultAclRow), {
    token: asAccount(options.token).publicKeyString.get(),
    signer: asAccount(options.signer).publicKeyString.get()
  });
}

/** The pure judgement, separated so it can be tested without a network. */
export function judgeVaultRows(rows: VaultAclRow[], expected: { token: string; signer: string }): VaultInspection {
  const problems: string[] = [];
  const owners = rows.filter((row) => row.has('OWNER'));
  const senders = rows.filter((row) => row.has('SEND_ON_BEHALF') && !row.has('OWNER'));
  const holders = rows.filter((row) => row.has('STORAGE_CAN_HOLD') && !row.has('OWNER'));

  if (owners.length !== 1) problems.push(`expected exactly one owner, found ${owners.length}`);

  for (const holder of holders) {
    if (holder.principal !== expected.token) problems.push(`token ${holder.principal} may be held but is not the refund token`);
  }
  if (!holders.some((row) => row.principal === expected.token)) problems.push(`the refund token ${expected.token} cannot be held by the vault`);

  for (const sender of senders) {
    if (sender.principal !== expected.signer) {
      problems.push(`${sender.principal} can send from the vault and is not the refund signer`);
    } else if (sender.target !== expected.token) {
      problems.push(`the refund signer's delegation targets ${sender.target ?? 'every token'}, not the refund token`);
    }
  }
  if (!senders.some((row) => row.principal === expected.signer)) problems.push('the refund signer has no SEND_ON_BEHALF on the vault');

  for (const row of rows) {
    if (row.has('OWNER') || row.has('SEND_ON_BEHALF') || row.has('STORAGE_CAN_HOLD')) continue;
    problems.push(`${row.principal} has a permission row on the vault that the design does not include`);
  }

  return {
    ready: problems.length === 0,
    problems,
    rows: rows.map((row) => ({
      principal: row.principal,
      target: row.target,
      flags: (['OWNER', 'SEND_ON_BEHALF', 'STORAGE_CAN_HOLD', 'STORAGE_DEPOSIT', 'ACCESS'] as const).filter((flag) => row.has(flag))
    })),
    owner: owners[0]?.principal
  };
}

function toVaultAclRow(row: unknown): VaultAclRow {
  const r = row as { principal?: unknown; target?: unknown; permissions?: unknown };
  const permissions = r.permissions as { has(flags: string[]): boolean } | undefined;
  return {
    principal: addressOf(r.principal) ?? '(not an account)',
    target: addressOf(r.target),
    has: (flag) => permissions?.has([flag]) ?? false
  };
}

function addressOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = (value as { publicKeyString?: { get(): string } }).publicKeyString;
  return candidate === undefined ? null : candidate.get();
}

function asAccount(value: GenericAccount | string): GenericAccount {
  return typeof value === 'string' ? Account.fromPublicKeyString(value) : value;
}

function stapleHash(published: unknown): string | undefined {
  const staple = (published as { voteStaple?: { blocksHash?: { toString(): string } } } | undefined)?.voteStaple;
  return staple?.blocksHash?.toString();
}
