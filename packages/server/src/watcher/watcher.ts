/**
 * The payment watcher: reads the merchant account's history and hands every inbound
 * send to the service, which decides what it was.
 *
 * Design, and the reasons:
 *
 * - **Polling `getHistory`, not a subscription.** The server is watch-only and holds
 *   no key, so its client has no signing account. `UserClient.on('change')` is a
 *   websocket filtered to the client's *own* account, which a key-less client does
 *   not have. Polling needs only a public address, and its cost is bounded by the
 *   cursor below.
 * - **Correctness comes from the store, not from this file.** `recordPayment` is
 *   unique on (block hash, operation index) and the status transitions are
 *   idempotent, so re-reading a block the watcher has already handled changes
 *   nothing. Everything here about cursors and bounds is for *efficiency*; if the
 *   cursor were lost or wrong, the result would be a slower scan, not a wrong one.
 * - **Pages are collected first, then processed oldest-first.** History arrives
 *   newest-first. If an underpayment and then a full payment landed in two staples
 *   and were processed in arrival order, the full payment would be credited and the
 *   earlier underpayment then read as a duplicate, flipping the session to
 *   unmatched. Chronological order gives: underpaid, then matched.
 * - **One scan at a time.** A tick that fires while a scan is running is skipped,
 *   so a slow node cannot pile up overlapping scans that race on the same sends.
 */
import type { CheckoutService, ProcessedPayment } from '../sessions/service.ts';
import type { ObservedPayment } from '../sessions/store.ts';
import { extractInboundSends, type HistoryEntryLike, type HistorySource } from './history-source.ts';

/** Where the newest fully processed staple is remembered between scans and restarts. */
export const CURSOR_META_KEY = 'watcher:newestBlocksHash';

export interface PaymentWatcherOptions {
  service: CheckoutService;
  history: HistorySource;
  /** The `keeta_…` account to watch. Always the configured receiving address. */
  receivingAddress: string;
  /** Staples per request. */
  pageSize?: number;
  /** Hard cap on requests per scan, so a corrupt cursor cannot walk the whole chain. */
  maxPages?: number;
  /**
   * How far before the oldest live session's creation a scan may stop looking, to
   * absorb clock skew between this host and the node that stamped the block.
   */
  lowerBoundSkewMs?: number;
  log?: Pick<Console, 'error' | 'warn'>;
  now?: () => number;
}

export interface ScanResult {
  /** History requests made. */
  pages: number;
  /** Inbound sends found in this scan, before dedup by the ledger. */
  observed: number;
  /** Of those, how many were new to the ledger. */
  recorded: number;
  /** Why the scan stopped walking back. */
  stoppedBecause: 'cursor' | 'lower-bound' | 'end-of-history' | 'page-cap' | 'nothing-to-watch';
  /** The newest staple seen, now the cursor. */
  newestBlocksHash: string | undefined;
  results: ProcessedPayment[];
}

export class PaymentWatcher {
  readonly #service: CheckoutService;
  readonly #history: HistorySource;
  readonly #address: string;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #skewMs: number;
  readonly #log: Pick<Console, 'error' | 'warn'>;
  readonly #now: () => number;

  #timer: ReturnType<typeof setInterval> | undefined;
  #inFlight: Promise<ScanResult> | undefined;

  constructor(options: PaymentWatcherOptions) {
    this.#service = options.service;
    this.#history = options.history;
    this.#address = options.receivingAddress;
    this.#pageSize = options.pageSize ?? 50;
    this.#maxPages = options.maxPages ?? 40;
    this.#skewMs = options.lowerBoundSkewMs ?? 10 * 60 * 1000;
    this.#log = options.log ?? console;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Poll on an interval. The first scan runs immediately. A tick during a running
   * scan is skipped rather than queued.
   */
  start(intervalMs = 5_000): void {
    if (this.#timer !== undefined) return;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), intervalMs);
    this.#timer.unref();
  }

  /**
   * One scheduled scan.
   *
   * `scan()` rethrows after logging, so that a direct caller (the CLI's `check`,
   * a test) sees the failure. The schedule must swallow it: a rejected promise
   * nobody awaits ends a Node process, and that is exactly what happened when a
   * representative on the test network answered "not ok" for fifteen seconds. A
   * node that is briefly down must cost a missed poll, not the server.
   */
  #tick(): void {
    this.scan().catch(() => undefined);
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    // A scan that is failing right now has already been logged; stopping is not
    // the place to hear about it a second time.
    await this.#inFlight?.catch(() => undefined);
  }

  /** Run one scan now. If one is already running, returns its result instead of starting another. */
  scan(): Promise<ScanResult> {
    if (this.#inFlight !== undefined) return this.#inFlight;
    this.#inFlight = this.#scan()
      .catch((error: unknown) => {
        this.#log.error('[keeta-checkout] watcher scan failed', error);
        throw error;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  async #scan(): Promise<ScanResult> {
    const now = this.#now();
    // Statuses are judged against chain time by the matcher, but a session that
    // nobody read since its deadline still says `open`; sweep so the store agrees
    // with the clock before any transition is attempted.
    await this.#service.sweepExpired();

    const cursor = await this.#service.store.getMeta(CURSOR_META_KEY);
    const lowerBound = await this.#lowerBound(now);

    const collected: ObservedPayment[] = [];
    let pages = 0;
    let newest: string | undefined;
    let startBlocksHash: string | undefined;
    let stoppedBecause: ScanResult['stoppedBecause'] = 'end-of-history';

    // A watcher with no live sessions and no cursor has nothing to look back for;
    // it only needs to learn where "now" is so later scans start from here.
    const firstEverWithNothingLive = cursor === undefined && lowerBound === undefined;

    scanning: while (pages < this.#maxPages) {
      const entries = await this.#history.getHistory(this.#address, {
        pageSize: this.#pageSize,
        depth: this.#pageSize,
        ...(startBlocksHash === undefined ? {} : { startBlocksHash })
      });
      pages += 1;
      if (entries.length === 0) break;

      for (const entry of entries) {
        const blocksHash = entry.voteStaple.blocksHash.toString();
        newest ??= blocksHash;

        if (blocksHash === cursor) {
          stoppedBecause = 'cursor';
          break scanning;
        }
        if (firstEverWithNothingLive) {
          stoppedBecause = 'nothing-to-watch';
          break scanning;
        }
        if (lowerBound !== undefined && stapleDate(entry) < lowerBound) {
          stoppedBecause = 'lower-bound';
          break scanning;
        }

        collected.push(...extractInboundSends(entry, this.#address));
        startBlocksHash = blocksHash;
      }

      if (entries.length < this.#pageSize) break;
    }
    if (pages >= this.#maxPages && stoppedBecause === 'end-of-history') {
      stoppedBecause = 'page-cap';
      this.#log.warn(
        `[keeta-checkout] watcher hit the page cap (${this.#maxPages} × ${this.#pageSize}); the cursor is set, the next scan continues from the newest staple`
      );
    }

    // Oldest first, and within a block in operation order, so a sequence of sends
    // to one session is judged in the order it happened.
    collected.sort((a, b) => a.blockDate - b.blockDate || a.blockHash.localeCompare(b.blockHash) || a.operationIndex - b.operationIndex);

    const results: ProcessedPayment[] = [];
    let recorded = 0;
    for (const observed of collected) {
      const result = await this.#service.processPayment(observed);
      results.push(result);
      if (result.inserted) recorded += 1;
    }

    // Only after every collected send is processed. A crash before this line means
    // the next scan re-reads the same staples, which the ledger makes harmless.
    if (newest !== undefined && newest !== cursor) {
      await this.#service.store.setMeta(CURSOR_META_KEY, newest);
    }

    return { pages, observed: collected.length, recorded, stoppedBecause, newestBlocksHash: newest ?? cursor, results };
  }

  /**
   * The earliest block time still worth reading: a little before the oldest session
   * that could still be affected by a payment. `undefined` when no such session
   * exists.
   */
  async #lowerBound(now: number): Promise<number | undefined> {
    const live = await this.#service.store.listByStatus(['open', 'expired'], 10_000);
    if (live.length === 0) return undefined;
    // `expired` sessions matter only until their grace window closes.
    const relevant = live.filter((session) => session.status === 'open' || session.graceUntil >= now - this.#skewMs);
    if (relevant.length === 0) return undefined;
    return Math.min(...relevant.map((session) => session.createdAt)) - this.#skewMs;
  }
}

/** A staple's time, taken from its oldest block. */
function stapleDate(entry: HistoryEntryLike): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const block of entry.voteStaple.blocks) earliest = Math.min(earliest, block.date.getTime());
  return earliest;
}
