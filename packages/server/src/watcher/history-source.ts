/**
 * Reading inbound sends off the chain.
 *
 * Keeta's `getHistory(account)` returns vote staples, newest first, and a staple's
 * blocks belong to whoever *published* them. A payment to the merchant lives in the
 * **payer's** block, which appears in the merchant's history because one of its
 * operations targets the merchant. One block can carry several sends to several
 * accounts, so the unit of interest is the individual `SEND` operation whose `to`
 * is the receiving address, identified by its block hash and its index in that
 * block.
 *
 * The narrow structural types here are what the watcher reads. The SDK's
 * `VoteStaple` satisfies them, and so does a small hand-built object in a test.
 */
import type { ObservedPayment } from '../sessions/store.ts';

/** `BufferStorage`-style hashes stringify to upper-case hex. */
interface Stringable {
  toString(): string;
}

interface AddressLike {
  publicKeyString: { get(): string };
}

/** Whatever shape an operation has, this is what we look at. */
export interface OperationLike {
  type: number;
  to?: AddressLike;
  token?: AddressLike;
  amount?: bigint;
  external?: string | undefined;
}

export interface BlockLike {
  hash: Stringable;
  account: AddressLike;
  date: Date;
  operations: readonly OperationLike[];
}

export interface StapleLike {
  blocksHash: Stringable;
  blocks: readonly BlockLike[];
}

export interface HistoryEntryLike {
  voteStaple: StapleLike;
}

export interface HistoryQuery {
  startBlocksHash?: string;
  depth?: number;
  pageSize?: number;
}

/**
 * The one thing the watcher needs from the network. `UserClient.client` satisfies
 * it directly; tests supply a fake.
 *
 * The account is a `keeta_…` string. The SDK also accepts account objects and
 * `null` (meaning every account), and declaring the narrower type here is what lets
 * the SDK's method be assigned to this interface without a cast.
 */
export interface HistorySource {
  getHistory(account: string, query?: HistoryQuery): Promise<readonly HistoryEntryLike[]>;
}

/**
 * The numeric tag the SDK gives a `SEND` operation. It is `OperationType.SEND` in
 * `@keetanetwork/keetanet-client`; pinned here as a value and asserted against the
 * SDK in a test, so a renumbering upstream fails loudly rather than silently
 * matching nothing.
 */
export const SEND_OPERATION_TYPE = 0;

function isSend(operation: OperationLike): operation is OperationLike & {
  to: AddressLike;
  token: AddressLike;
  amount: bigint;
} {
  return (
    operation.type === SEND_OPERATION_TYPE &&
    operation.to !== undefined &&
    operation.token !== undefined &&
    typeof operation.amount === 'bigint'
  );
}

/**
 * Every `SEND` in a staple whose recipient is `receivingAddress`, oldest block first
 * and in operation order within a block. Sends to anyone else, and every other kind
 * of operation, are ignored.
 */
export function extractInboundSends(entry: HistoryEntryLike, receivingAddress: string): ObservedPayment[] {
  const found: ObservedPayment[] = [];

  for (const block of entry.voteStaple.blocks) {
    const blockHash = block.hash.toString();
    const from = block.account.publicKeyString.get();
    const blockDate = block.date.getTime();

    block.operations.forEach((operation, operationIndex) => {
      if (!isSend(operation)) return;
      const to = operation.to.publicKeyString.get();
      if (to !== receivingAddress) return;

      found.push({
        blockHash,
        operationIndex,
        from,
        to,
        tokenAddress: operation.token.publicKeyString.get(),
        amount: operation.amount,
        external: operation.external === undefined || operation.external === '' ? null : operation.external,
        blockDate
      });
    });
  }

  return found;
}
