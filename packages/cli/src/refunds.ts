/**
 * `keeta-checkout refunds init` and `keeta-checkout refunds serve`.
 *
 * These are the only commands that touch a key. `init` runs once, on the
 * merchant's own machine, with the merchant's seed from the environment: it builds
 * the refund vault and a dedicated signer, delegates the signer, and prints what to
 * put in the server's environment and how much to fund. `serve` runs next to the
 * checkout server, holds only the signer's seed, and publishes refunds the ledger
 * has been told to pay. See docs/decisions/0014.
 *
 * The checkout server itself never loads either of these: it stays watch-only.
 */
import * as KeetaNet from '@keetanetwork/keetanet-client';
import {
  SqliteSessionStore,
  MemorySessionStore,
  TokenRegistry,
  configFromEnv,
  enqueueRefundChange,
  REFUND_REASONS,
  type CheckoutConfig,
  type RefundReason,
  type SessionStore
} from '@keeta-checkout/server';
import {
  RefundProcess,
  createRefundVault,
  inspectRefundVault,
  sdkVaultSigner,
  type RefundLimits
} from '@keeta-checkout/refunds';
import { flagString, resolveValue, type ParsedArgs } from './options.ts';

const { Account } = KeetaNet.lib;

type Log = (line: string) => void;

export interface RefundsIO {
  log: Log;
}

/** The subcommand router: `refunds init` and `refunds serve`. */
export async function runRefunds(args: ParsedArgs, env: NodeJS.ProcessEnv, io: RefundsIO): Promise<number> {
  const sub = args.positionals[0];
  switch (sub) {
    case 'init':
      return runRefundsInit(args, env, io);
    case 'serve':
      return runRefundsServe(args, env, io);
    default:
      io.log(`Unknown refunds command ${JSON.stringify(sub ?? '')}. Use "refunds init" or "refunds serve".`);
      return 1;
  }
}

/**
 * Create the vault and the signer, with the merchant's key, and say what to do next.
 *
 * The merchant's seed comes from `KEETA_CHECKOUT_REFUND_OWNER_SEED` and never from
 * a flag, so it does not land in shell history. It is used only here, only to sign
 * the setup, and is never written anywhere.
 */
export async function runRefundsInit(args: ParsedArgs, env: NodeJS.ProcessEnv, io: RefundsIO): Promise<number> {
  const network = flagString(args, 'network') ?? env.KEETA_NETWORK ?? 'test';
  if (network !== 'test' && network !== 'main') {
    io.log(`The network must be "test" or "main", not ${JSON.stringify(network)}.`);
    return 1;
  }

  const ownerSeed = env.KEETA_CHECKOUT_REFUND_OWNER_SEED;
  if (ownerSeed === undefined || ownerSeed.trim() === '') {
    io.log('Set KEETA_CHECKOUT_REFUND_OWNER_SEED to the seed of the account that owns the refund float.');
    io.log('It is used once, here, to create the vault, and is never written anywhere or sent to the server.');
    io.log('Pass it in the environment, not on a flag, so it stays out of your shell history.');
    return 1;
  }

  const tokenInput = flagString(args, 'token') ?? env.KEETA_CHECKOUT_REFUND_TOKEN;
  if (tokenInput === undefined || tokenInput.trim() === '') {
    io.log('Pass the token to refund in with --token (a ticker like $USDC, or a keeta_ address).');
    return 1;
  }

  let owner: InstanceType<typeof KeetaNet.UserClient> | undefined;
  try {
    owner = KeetaNet.UserClient.fromNetwork(network, Account.fromSeed(ownerSeed.trim(), 0));
  } catch (error) {
    io.log(`That owner seed is not usable: ${message(error)}`);
    return 1;
  }

  try {
    const token = await new TokenRegistry({ client: owner }).resolve(tokenInput.trim());
    io.log(`Refund token: ${token.ticker ?? token.address} (${token.decimals} decimals)`);

    // A fresh signer. Its seed is shown once and then only the server holds it.
    const signerSeed = Account.generateRandomSeed({ asString: true });
    const signerAddress = Account.fromSeed(signerSeed, 0).publicKeyString.get();

    io.log('Creating the vault and delegating to the signer. This publishes two blocks.');
    const created = await createRefundVault(owner, { token: token.address, signer: signerAddress });

    const verdict = await inspectRefundVault(owner, { vault: created.vault, token: token.address, signer: signerAddress });
    if (!verdict.ready) {
      io.log('The vault was created but its permissions are not what they should be:');
      for (const problem of verdict.problems) io.log(`  - ${problem}`);
      io.log('This should not happen; do not use this vault. Please report it.');
      return 1;
    }

    io.log('');
    io.log('Vault created and verified. The three permission rows on it are exactly as designed.');
    io.log('');
    io.log('Add these to the server environment (the same .env the checkout server reads):');
    io.log('');
    io.log(`  KEETA_CHECKOUT_REFUND_VAULT=${created.vault}`);
    io.log(`  KEETA_CHECKOUT_REFUND_TOKEN=${token.address}`);
    io.log(`  KEETA_CHECKOUT_REFUND_SIGNER_SEED=${signerSeed}`);
    io.log('');
    io.log('The signer seed is shown once. Put it in your secret store now; it is nowhere else.');
    io.log('It can spend only the refund float, only in that one token, and nothing else.');
    io.log('');
    io.log('Then fund two accounts from your wallet:');
    io.log(`  the vault   ${created.vault}`);
    io.log('    with the refund float, in the refund token (top it up as it runs down)');
    io.log(`  the signer  ${signerAddress}`);
    io.log('    with a little KTA, which pays the network fee for each refund');
    io.log('');
    io.log('To stop refunds at any time, revoke the delegation from your wallet:');
    io.log(`  the owner account removes SEND_ON_BEHALF from ${signerAddress} on the vault.`);
    io.log('');
    io.log('Then run `keeta-checkout refunds serve` next to your checkout server.');

    if (network === 'main') {
      io.log('');
      io.log('This is the main network. The float is real money.');
    }
    return 0;
  } catch (error) {
    io.log(`Could not set up refunds: ${message(error)}`);
    return 1;
  } finally {
    await owner.destroy();
  }
}

export interface RefundsServeHandle {
  /** Resolves when the process has been told to stop and has drained. */
  done: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Run the refund process. Holds the signer's seed and nothing else.
 *
 * Returns once the process is running; the caller keeps the process alive and
 * calls `stop()` on a signal. Separated this way so a test can start and stop it
 * without a real signal. Refuses to start against a vault whose permissions are
 * not exactly as designed: an extra delegation is how a float leaks.
 */
export async function startRefundsServe(
  env: NodeJS.ProcessEnv,
  args: ParsedArgs,
  io: RefundsIO
): Promise<RefundsServeHandle | number> {
  let config: CheckoutConfig;
  try {
    config = configFromEnv(env);
  } catch (error) {
    io.log(`The configuration is not usable: ${message(error)}`);
    io.log('Run `keeta-checkout init` first, then `keeta-checkout refunds init`.');
    return 1;
  }

  const signerSeed = env.KEETA_CHECKOUT_REFUND_SIGNER_SEED;
  const vault = env.KEETA_CHECKOUT_REFUND_VAULT;
  const tokenInput = env.KEETA_CHECKOUT_REFUND_TOKEN;
  if (!signerSeed || !vault || !tokenInput) {
    io.log('Refunds are not configured. Run `keeta-checkout refunds init`, then set its three variables:');
    io.log('  KEETA_CHECKOUT_REFUND_VAULT, KEETA_CHECKOUT_REFUND_TOKEN, KEETA_CHECKOUT_REFUND_SIGNER_SEED');
    return 1;
  }

  // Validate everything that is only configuration before the key is touched, so a
  // typo is caught without loading a seed.
  const limits = readLimits(env, io);
  if (limits === undefined) return 1;
  const autoRefund = readAutoRefund(env, io);
  if (autoRefund === undefined) return 1;

  let signerClient: InstanceType<typeof KeetaNet.UserClient>;
  try {
    signerClient = KeetaNet.UserClient.fromNetwork(config.network, Account.fromSeed(signerSeed.trim(), 0));
  } catch (error) {
    io.log(`The signer seed is not usable: ${message(error)}`);
    return 1;
  }

  try {
    const token = tokenInput.trim().startsWith('keeta_')
      ? tokenInput.trim()
      : (await new TokenRegistry({ client: signerClient }).resolve(tokenInput.trim())).address;

    const verdict = await inspectRefundVault(signerClient, { vault: vault.trim(), token, signer: signerClient.account.publicKeyString.get() });
    if (!verdict.ready) {
      io.log('Refusing to start: the vault is not exactly as designed, and a wrong permission leaks the float.');
      for (const problem of verdict.problems) io.log(`  - ${problem}`);
      io.log('Re-run `keeta-checkout refunds init` to create a fresh vault, or revoke the stray grant.');
      await signerClient.destroy();
      return 1;
    }

    const database = resolveValue(args, 'database', 'KEETA_CHECKOUT_DATABASE', env, './keeta-checkout.sqlite');
    const store: SessionStore = database === ':memory:' ? new MemorySessionStore() : new SqliteSessionStore({ filename: database });
    const signer = sdkVaultSigner(signerClient, vault.trim());
    const process_ = new RefundProcess({ store, signer, vault: vault.trim(), token, limits, autoRefund, log: console });

    // Webhook writes in progress, so shutdown can wait for them before closing the
    // store they write to.
    const pending = new Set<Promise<unknown>>();
    const unsubscribe = process_.onChange(({ refund }) => {
      const work = enqueueRefundChange(store, config, refund).catch((error: unknown) => {
        io.log(`Could not enqueue a refund webhook: ${message(error)}`);
      });
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });

    const intervalMs = Number(env.KEETA_CHECKOUT_REFUND_INTERVAL_MS ?? 10_000);
    process_.start(Number.isInteger(intervalMs) && intervalMs > 0 ? intervalMs : 10_000);

    for (const line of describeRefunds({ network: config.network, vault: vault.trim(), token, database, limits, autoRefund })) io.log(line);

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      // Drain first, still subscribed: a refund that completes during shutdown must
      // still reach the merchant as a webhook. Then wait for those writes, and only
      // then close the store they go into.
      await process_.stop();
      await Promise.all([...pending]);
      unsubscribe();
      await store.close();
      await signerClient.destroy();
      resolveDone();
    };
    return { done, stop };
  } catch (error) {
    io.log(`Could not start refunds: ${message(error)}`);
    await signerClient.destroy();
    return 1;
  }
}

/** The command wrapper: start, wait on signals, drain, exit. */
export async function runRefundsServe(args: ParsedArgs, env: NodeJS.ProcessEnv, io: RefundsIO): Promise<number> {
  const handle = await startRefundsServe(env, args, io);
  if (typeof handle === 'number') return handle;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    io.log('');
    io.log(`${signal} received; finishing the refund in flight and shutting down.`);
    void handle
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`Shutdown failed: ${String(error)}\n`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await handle.done;
  return 0;
}

/**
 * The dispositions to refund without being asked. A misspelt one would match no
 * payment and switch automatic refunds off without a word, so it is refused. Empty
 * means none: every refund then waits to be requested.
 */
function readAutoRefund(env: NodeJS.ProcessEnv, io: RefundsIO): RefundReason[] | undefined {
  const items = (env.KEETA_CHECKOUT_REFUND_AUTO ?? 'duplicate')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const known = new Set<string>(REFUND_REASONS);
  const unknown = items.filter((item) => !known.has(item));
  if (unknown.length > 0) {
    io.log(`KEETA_CHECKOUT_REFUND_AUTO names ${unknown.map((item) => JSON.stringify(item)).join(', ')}, which is not a refund reason.`);
    io.log(`Use a comma-separated list of: ${REFUND_REASONS.join(', ')}. Leave it empty to refund only on request.`);
    return undefined;
  }
  return items as RefundReason[];
}

/** Read and validate the advisory limits. `undefined` means a bad value was given. */
function readLimits(env: NodeJS.ProcessEnv, io: Log | RefundsIO): RefundLimits | undefined {
  const log = typeof io === 'function' ? io : io.log;
  const bigintEnv = (name: string): bigint | undefined | null => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    if (!/^\d+$/.test(raw.trim())) {
      log(`${name} must be a whole number of base units, not ${JSON.stringify(raw)}.`);
      return null;
    }
    return BigInt(raw.trim());
  };

  const perRefund = bigintEnv('KEETA_CHECKOUT_REFUND_MAX_PER_REFUND');
  const perDay = bigintEnv('KEETA_CHECKOUT_REFUND_MAX_PER_DAY');
  const reserveRaw = bigintEnv('KEETA_CHECKOUT_REFUND_KTA_RESERVE');
  if (perRefund === null || perDay === null || reserveRaw === null) return undefined;

  return {
    ...(perRefund === undefined ? {} : { maxPerRefund: perRefund }),
    ...(perDay === undefined ? {} : { maxPerDay: perDay }),
    // 0.02 KTA. A refund's fee measured on the test network was around 1e-11 KTA,
    // so this is far more head-room than fees need, while still a trivial sum.
    ktaReserve: reserveRaw ?? 2n * 10n ** 16n
  };
}

function describeRefunds(info: {
  network: string;
  vault: string;
  token: string;
  database: string;
  limits: RefundLimits;
  autoRefund: readonly string[];
}): string[] {
  return [
    'Keeta Checkout refunds are running.',
    `  network       ${info.network}`,
    `  vault         ${info.vault}`,
    `  token         ${info.token}`,
    `  database      ${info.database}`,
    `  per refund    ${info.limits.maxPerRefund === undefined ? 'no cap' : `${info.limits.maxPerRefund} base units`}`,
    `  per day       ${info.limits.maxPerDay === undefined ? "the vault's balance" : `${info.limits.maxPerDay} base units`}`,
    `  KTA reserve   ${info.limits.ktaReserve} base units, held by the signer for fees`,
    `  auto-refund   ${info.autoRefund.length === 0 ? 'nothing; every refund is requested' : info.autoRefund.join(', ')}`,
    '',
    'The checkout server stays watch-only. This process holds only the signer key,',
    'which can spend the float and nothing else. Revoke it from your wallet to stop.'
  ];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error);
}
