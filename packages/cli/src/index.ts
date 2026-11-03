/**
 * `keeta-checkout`: the command a merchant runs.
 *
 * ```
 * keeta-checkout init      write a configuration, generating the secrets
 * keeta-checkout check     confirm the address, tokens and network actually work
 * keeta-checkout serve     take payments
 * ```
 *
 * The commands are deliberately in that order: a merchant who runs them in sequence
 * finds out about a bad address before a shopper does.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { configFromEnv } from '@keeta-checkout/server';
import { runCheck } from './check.ts';
import { runInit, terminalAsker } from './init.ts';
import { flagBoolean, flagNumber, flagString, parseArgs, resolveValue, type ParsedArgs } from './options.ts';
import { describeRuntime, startRuntime } from './runtime.ts';
import { runRefunds } from './refunds.ts';

const USAGE = `keeta-checkout — accept Keeta payments on your website

Usage:
  keeta-checkout init [options]     Write a configuration file and generate secrets
  keeta-checkout check             Validate the configuration against the network
  keeta-checkout serve [options]   Start the checkout server
  keeta-checkout refunds init      Create the refund vault and signer (uses your seed)
  keeta-checkout refunds serve     Run the refund process (holds only the signer key)

Options for init:
  --out <path>                 Where to write the configuration (default: .env)
  --force                      Replace an existing file
  --network <test|main>        Which Keeta network (default: test)
  --receiving-address <addr>   The keeta_… account that receives payments
  --accept <list>              Tokens to accept, comma separated (default: $USDC)
  --public-url <url>           Where shoppers reach this server
  --webhook-url <url>          An endpoint to notify

Options for serve:
  --port <number>              Port to listen on (default: 3000, or PORT)
  --host <address>             Address to bind (default: 127.0.0.1, or HOST)
  --database <path>            SQLite file, or :memory: (default: ./keeta-checkout.sqlite)
  --merchant-name <name>       Heading on the hosted pay page
  --env-file <path>            Read this file before starting (default: .env, if present)

Every option can also come from an environment variable; see the configuration
file that \`init\` writes. Flags win over the environment.
`;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv);

  // Version before help: `--version` carries no command, and the help branch would
  // otherwise claim it.
  if (flagBoolean(args, 'version') || args.command === 'version') {
    process.stdout.write(`keeta-checkout ${cliVersion()}
`);
    return 0;
  }
  const askedForHelp = flagBoolean(args, 'help') || args.command === 'help';
  if (askedForHelp || args.command === undefined) {
    process.stdout.write(USAGE);
    // Asking for help succeeded. Running with no arguments at all did not.
    return askedForHelp ? 0 : 1;
  }

  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  switch (args.command) {
    case 'init':
      return runInit(args, env, {
        log,
        // Only prompt when there is a terminal to prompt on. In a container or a
        // script, every answer must come from a flag or the environment.
        ask: process.stdin.isTTY === true ? terminalAsker() : undefined
      });

    case 'check':
      loadEnvFile(args, env, log);
      return runCheck(env, { log });

    case 'serve':
      return runServe(args, env, log);

    case 'refunds':
      // `refunds serve` reads the shared .env; `refunds init` does not need it.
      if (args.positionals[0] === 'serve') loadEnvFile(args, env, log);
      return runRefunds(args, env, { log });

    default:
      process.stderr.write(`Unknown command ${JSON.stringify(args.command)}.\n\n${USAGE}`);
      return 1;
  }
}

/**
 * Read a configuration file into the environment before anything looks at it.
 *
 * Silent when the default file is simply absent, loud when a file was named and is
 * missing: the first is an ordinary container deployment, the second is a typo.
 */
function loadEnvFile(args: ParsedArgs, env: NodeJS.ProcessEnv, log: (line: string) => void): void {
  const named = flagString(args, 'env-file');
  const path = named ?? '.env';

  if (!existsSync(path)) {
    if (named !== undefined) log(`Warning: ${path} does not exist; using the environment as it is.`);
    return;
  }
  process.loadEnvFile(path);
  // `loadEnvFile` populates `process.env`; mirror it when a caller passed a
  // different object, so tests and embedders see the same values.
  if (env !== process.env) Object.assign(env, process.env);
}

async function runServe(args: ParsedArgs, env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<number> {
  loadEnvFile(args, env, log);

  const config = (() => {
    try {
      return configFromEnv(env);
    } catch (error) {
      log(`The configuration is not usable: ${error instanceof Error ? error.message : String(error)}`);
      log('');
      log('Run `keeta-checkout init` to write one, then `keeta-checkout check`.');
      return undefined;
    }
  })();
  if (config === undefined) return 1;

  const options = {
    config,
    database: resolveValue(args, 'database', 'KEETA_CHECKOUT_DATABASE', env, './keeta-checkout.sqlite'),
    host: resolveValue(args, 'host', 'HOST', env, '127.0.0.1'),
    port: flagNumber(args, 'port') ?? Number(env.PORT ?? 3000),
    ...(flagString(args, 'merchant-name') ?? env.KEETA_CHECKOUT_MERCHANT_NAME
      ? { merchantName: flagString(args, 'merchant-name') ?? env.KEETA_CHECKOUT_MERCHANT_NAME }
      : {}),
    log: console
  };

  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    log(`The port must be a whole number from 0 to 65535, not ${String(options.port)}.`);
    return 1;
  }

  const runtime = await startRuntime(options);
  for (const line of describeRuntime(options, runtime.port, config.webhookEndpoints.length)) log(line);

  // A container stops with SIGTERM and a terminal with SIGINT. Both must drain the
  // watcher and the webhook queue rather than cut them off mid-write.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('');
    log(`${signal} received; finishing in-flight work and shutting down.`);
    void runtime
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`Shutdown failed: ${String(error)}\n`);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Resolve only when the server stops, so the process stays up.
  await new Promise<void>((resolve) => runtime.server.once('close', () => resolve()));
  return 0;
}

export { startRuntime, describeRuntime, type Runtime, type RuntimeOptions } from './runtime.ts';
export { runCheck, type CheckResult } from './check.ts';
export { runInit } from './init.ts';
export { runRefunds, runRefundsInit, startRefundsServe } from './refunds.ts';
export { parseArgs } from './options.ts';

/**
 * The version from this package's own manifest, read when asked rather than baked
 * in at build time. `dist/index.mjs` and `src/index.ts` both sit one level below
 * `package.json`, so the same relative path serves the bundle and the dev runner.
 */
function cliVersion(): string {
  const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}
