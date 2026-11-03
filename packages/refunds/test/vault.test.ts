/**
 * The vault judgement, against hand-built ACL rows. The rows mirror what the test
 * network returns for a vault configured by `createRefundVault` (docs/decisions/
 * 0014, decision 2): owner, one token holder, one delegated signer. Three rows.
 */
import { describe, expect, it } from 'vitest';
import { judgeVaultRows, type VaultAclRow } from '../src/vault.ts';

const OWNER = 'keeta_owner';
const SIGNER = 'keeta_signer';
const USDC = 'keeta_usdc';
const KTA = 'keeta_kta';
const STRANGER = 'keeta_stranger';

type Flag = Parameters<VaultAclRow['has']>[0];

function row(principal: string, flags: Flag[], target: string | null = null): VaultAclRow {
  // The ledger adds ACCESS to every explicit grant, as measured.
  const set = new Set<Flag>([...flags, 'ACCESS']);
  return { principal, target, has: (flag) => set.has(flag) };
}

const expected = { token: USDC, signer: SIGNER };

const asMeasured = (): VaultAclRow[] => [
  row(OWNER, ['OWNER', 'SEND_ON_BEHALF', 'STORAGE_CAN_HOLD', 'STORAGE_DEPOSIT']),
  row(USDC, ['STORAGE_CAN_HOLD']),
  row(SIGNER, ['SEND_ON_BEHALF'], USDC)
];

describe('judgeVaultRows', () => {
  it('accepts exactly the measured shape', () => {
    const verdict = judgeVaultRows(asMeasured(), expected);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ready).toBe(true);
    expect(verdict.owner).toBe(OWNER);
    expect(verdict.rows).toHaveLength(3);
  });

  it('accepts a KTA-denominated vault', () => {
    const rows = [row(OWNER, ['OWNER']), row(KTA, ['STORAGE_CAN_HOLD']), row(SIGNER, ['SEND_ON_BEHALF'], KTA)];
    expect(judgeVaultRows(rows, { token: KTA, signer: SIGNER }).ready).toBe(true);
  });

  it('refuses a second sender: that is how a float walks out', () => {
    const verdict = judgeVaultRows([...asMeasured(), row(STRANGER, ['SEND_ON_BEHALF'], USDC)], expected);
    expect(verdict.ready).toBe(false);
    expect(verdict.problems).toEqual([`${STRANGER} can send from the vault and is not the refund signer`]);
  });

  it('refuses a signer delegated for every token, or for the wrong one', () => {
    const everyToken = asMeasured().map((r) => (r.principal === SIGNER ? row(SIGNER, ['SEND_ON_BEHALF'], null) : r));
    expect(judgeVaultRows(everyToken, expected).problems).toEqual([
      "the refund signer's delegation targets every token, not the refund token"
    ]);
    const wrongToken = asMeasured().map((r) => (r.principal === SIGNER ? row(SIGNER, ['SEND_ON_BEHALF'], KTA) : r));
    expect(judgeVaultRows(wrongToken, expected).problems).toEqual([
      `the refund signer's delegation targets ${KTA}, not the refund token`
    ]);
  });

  it('refuses a vault that can hold a token other than the refund token, KTA included', () => {
    // The vault does not pay fees, so it has no reason to hold KTA, and a KTA
    // holder row here would be an unexplained grant.
    const verdict = judgeVaultRows([...asMeasured(), row(KTA, ['STORAGE_CAN_HOLD'])], expected);
    expect(verdict.problems).toEqual([`token ${KTA} may be held but is not the refund token`]);
  });

  it('refuses a vault that cannot hold the refund token', () => {
    const noHolder = asMeasured().filter((r) => r.principal !== USDC);
    expect(judgeVaultRows(noHolder, expected).problems).toEqual([`the refund token ${USDC} cannot be held by the vault`]);
  });

  it('refuses a missing signer, a missing owner, and two owners', () => {
    expect(judgeVaultRows(asMeasured().filter((r) => r.principal !== SIGNER), expected).problems).toEqual([
      'the refund signer has no SEND_ON_BEHALF on the vault'
    ]);
    expect(judgeVaultRows(asMeasured().filter((r) => r.principal !== OWNER), expected).problems).toEqual([
      'expected exactly one owner, found 0'
    ]);
    expect(judgeVaultRows([...asMeasured(), row(STRANGER, ['OWNER'])], expected).problems).toEqual([
      'expected exactly one owner, found 2'
    ]);
  });

  it('refuses any row the design does not include, even a harmless-looking one', () => {
    const verdict = judgeVaultRows([...asMeasured(), row(STRANGER, ['STORAGE_DEPOSIT'])], expected);
    expect(verdict.problems).toEqual([`${STRANGER} has a permission row on the vault that the design does not include`]);
  });

  it('reports every problem at once, not just the first', () => {
    const rows = [row(STRANGER, ['SEND_ON_BEHALF'], USDC), row(STRANGER, ['STORAGE_CAN_HOLD'])];
    const verdict = judgeVaultRows(rows, expected);
    expect(verdict.ready).toBe(false);
    expect(verdict.problems.length).toBeGreaterThanOrEqual(4);
  });
});
