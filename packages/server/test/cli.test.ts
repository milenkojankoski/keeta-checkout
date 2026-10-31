/**
 * The command-line tool: argument parsing, `init`, `check` and the runtime's
 * start-up and shutdown.
 *
 * `init` and the parser run offline. `check` and the runtime reach the test
 * network, so they are skipped without `.env.test`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCheck } from '../../cli/src/check.ts';
import { main } from '../../cli/src/index.ts';
import { runInit } from '../../cli/src/init.ts';
import { parseArgs } from '../../cli/src/options.ts';
import { describeRuntime, startRuntime, type Runtime } from '../../cli/src/runtime.ts';
import { resolveConfig } from '../src/config.ts';
import { MERCHANT_ADDRESS, USDC } from './support/fakes.ts';

const ENV_FILE = resolve(import.meta.dirname, '..', '..', '..', '.env.test');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const canRunNetwork = (process.env.KEETA_MERCHANT_SEED ?? '') !== '' && (process.env.KEETA_NETWORK ?? 'test') === 'test';

let directory: string;
const lines: string[] = [];
const io = { log: (line: string) => void lines.push(line) };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'keeta-cli-'));
  lines.length = 0;
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('reads a command, flags with values, and positionals', () => {
    const args = parseArgs(['serve', '--port', '4000', '--host=0.0.0.0', 'extra']);
    expect(args.command).toBe('serve');
    expect(args.flags.get('port')).toBe('4000');
    expect(args.flags.get('host')).toBe('0.0.0.0');
    expect(args.positionals).toEqual(['extra']);
  });

  it('treats a trailing flag as true', () => {
    expect(parseArgs(['init', '--force']).flags.get('force')).toBe(true);
  });

  it('never lets a boolean flag swallow the next word', () => {
    // `init --force` must not read "init" or a following command as the value.
    const args = parseArgs(['--force', 'init']);
    expect(args.flags.get('force')).toBe(true);
    expect(args.command).toBe('init');

    const help = parseArgs(['--help', 'serve']);
    expect(help.flags.get('help')).toBe(true);
    expect(help.command).toBe('serve');
  });

  it('accepts a value that looks like a flag only via =', () => {
    expect(parseArgs(['init', '--accept=--odd']).flags.get('accept')).toBe('--odd');
    // Without `=`, a `-`-prefixed token is a separate flag, not a value.
    const args = parseArgs(['init', '--accept', '--force']);
    expect(args.flags.get('accept')).toBe(true);
    expect(args.flags.get('force')).toBe(true);
  });

  it('copes with no arguments at all', () => {
    expect(parseArgs([])).toEqual({ command: undefined, flags: new Map(), positionals: [] });
  });
});

describe('main', () => {
  it('prints the version for --version, not the usage', async () => {
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };

    try {
      expect(await main(['--version'])).toBe(0);
      expect(await main(['version'])).toBe(0);
      expect(written.join('')).not.toContain('Usage:');
      expect(written.join('')).toContain('keeta-checkout 0.0.0');

      written.length = 0;
      expect(await main(['--help'])).toBe(0);
      expect(written.join('')).toContain('Usage:');

      written.length = 0;
      // No arguments is a usage error, so the exit code says so.
      expect(await main([])).toBe(1);
      expect(written.join('')).toContain('Usage:');
    } finally {
      process.stdout.write = write;
    }
  });
});

describe('init', () => {
  const run = (extra: string[] = []): Promise<number> =>
    runInit(
      parseArgs(['init', '--out', join(directory, '.env'), '--receiving-address', MERCHANT_ADDRESS, ...extra]),
      {},
      io
    );

  it('writes a configuration and generates both secrets', async () => {
    expect(await run(['--network', 'test', '--accept', '$USDC'])).toBe(0);

    const written = readFileSync(join(directory, '.env'), 'utf8');
    expect(written).toContain(`KEETA_CHECKOUT_RECEIVING_ADDRESS=${MERCHANT_ADDRESS}`);
    expect(written).toContain('KEETA_NETWORK=test');
    expect(written).toContain('KEETA_CHECKOUT_ACCEPTED_TOKENS=$USDC');
    expect(written).toMatch(/KEETA_CHECKOUT_API_KEYS=kck_[A-Za-z0-9_-]{32,}/);
    expect(written).toContain('whsec_');
  });

  it('writes a configuration the server actually accepts', async () => {
    await run(['--accept', '$USDC', '--public-url', 'https://pay.example', '--webhook-url', 'https://shop.example/hooks']);

    const env: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(join(directory, '.env'), 'utf8').split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      if (key !== undefined) env[key] = rest.join('=');
    }

    // The real validator, on the real file. An init that writes something the
    // server rejects is worse than no init at all.
    const config = resolveConfig({
      network: 'test',
      receivingAddress: env.KEETA_CHECKOUT_RECEIVING_ADDRESS ?? '',
      apiKeys: (env.KEETA_CHECKOUT_API_KEYS ?? '').split(','),
      acceptedTokens: (env.KEETA_CHECKOUT_ACCEPTED_TOKENS ?? '').split(','),
      publicUrl: env.KEETA_CHECKOUT_PUBLIC_URL,
      webhookEndpoints: [
        {
          url: (env.KEETA_CHECKOUT_WEBHOOKS ?? '').split('|')[0] ?? '',
          secret: (env.KEETA_CHECKOUT_WEBHOOKS ?? '').split('|')[1] ?? ''
        }
      ]
    });
    expect(config.receivingAddress).toBe(MERCHANT_ADDRESS);
    expect(config.webhookEndpoints[0]?.url).toBe('https://shop.example/hooks');
  });

  it('comments the webhook line out when no endpoint is given', async () => {
    await run();
    const written = readFileSync(join(directory, '.env'), 'utf8');
    expect(written).toContain('# KEETA_CHECKOUT_WEBHOOKS=');
  });

  it('never asks for or writes a seed', async () => {
    await run();
    const written = readFileSync(join(directory, '.env'), 'utf8');
    expect(written).not.toContain('SEED');
    expect(written).not.toContain('PRIVATE');
    expect(written).toContain('no seed, no private key');
  });

  it('refuses to overwrite, unless forced', async () => {
    await run();
    const first = readFileSync(join(directory, '.env'), 'utf8');

    lines.length = 0;
    expect(await run()).toBe(1);
    expect(lines.join('\n')).toContain('already exists');
    expect(readFileSync(join(directory, '.env'), 'utf8')).toBe(first);

    expect(await run(['--force'])).toBe(0);
    expect(readFileSync(join(directory, '.env'), 'utf8')).not.toBe(first); // new secrets
  });

  it('rejects a bad network, a missing address and a token address', async () => {
    expect(await run(['--network', 'staging'])).toBe(1);
    expect(lines.join('\n')).toContain('test" or "main');

    lines.length = 0;
    expect(
      await runInit(parseArgs(['init', '--out', join(directory, 'a.env'), '--receiving-address', 'not-an-address']), {}, io)
    ).toBe(1);
    expect(lines.join('\n')).toContain('not a valid Keeta address');

    lines.length = 0;
    expect(
      await runInit(parseArgs(['init', '--out', join(directory, 'b.env'), '--receiving-address', USDC]), {}, io)
    ).toBe(1);
    expect(lines.join('\n')).toContain('token address');

    lines.length = 0;
    expect(await runInit(parseArgs(['init', '--out', join(directory, 'c.env')]), {}, io)).toBe(1);
    expect(lines.join('\n')).toContain('receiving address is required');
  });

  it('warns loudly about the main network', async () => {
    await run(['--network', 'main']);
    expect(lines.join('\n')).toContain('real money');
  });

  it('takes values from the environment when no flag is given', async () => {
    const code = await runInit(
      parseArgs(['init', '--out', join(directory, '.env')]),
      { KEETA_NETWORK: 'test', KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS },
      io
    );
    expect(code).toBe(0);
    expect(readFileSync(join(directory, '.env'), 'utf8')).toContain(MERCHANT_ADDRESS);
  });
});

describe('check', () => {
  it('reports an unusable configuration without touching the network', async () => {
    expect(await runCheck({}, io)).toBe(1);
    expect(lines.join('\n')).toContain('not usable');
    expect(lines.join('\n')).toContain('keeta-checkout init');
  });

  it.skipIf(!canRunNetwork)('validates a good configuration against the test network', async () => {
    const code = await runCheck(
      {
        KEETA_NETWORK: 'test',
        KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS,
        KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20),
        KEETA_CHECKOUT_ACCEPTED_TOKENS: '$USDC,$KTA'
      },
      io
    );

    const output = lines.join('\n');
    expect(output).toContain('ok    configuration');
    expect(output).toContain('ok    receiving account');
    expect(output).toContain('ok    resolver');
    expect(output).toContain('ok    token $USDC');
    expect(output).toContain('ok    token $KTA');
    expect(output).not.toContain('FAIL');
    expect(code).toBe(0);
  }, 60_000);

  it.skipIf(!canRunNetwork)('fails on a token that does not exist', async () => {
    const code = await runCheck(
      {
        KEETA_NETWORK: 'test',
        KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS,
        KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20),
        KEETA_CHECKOUT_ACCEPTED_TOKENS: '$NOPE'
      },
      io
    );
    expect(lines.join('\n')).toContain('FAIL  token $NOPE');
    expect(code).toBe(1);
  }, 60_000);

  it.skipIf(!canRunNetwork)('notes a missing public URL and the absence of webhooks', async () => {
    await runCheck(
      {
        KEETA_NETWORK: 'test',
        KEETA_CHECKOUT_RECEIVING_ADDRESS: MERCHANT_ADDRESS,
        KEETA_CHECKOUT_API_KEYS: 'k'.repeat(20)
      },
      io
    );
    const output = lines.join('\n');
    expect(output).toContain('note  No public URL');
    expect(output).toContain('note  No webhook endpoints');
  }, 60_000);
});

describe('describeRuntime', () => {
  const options = {
    config: resolveConfig({
      network: 'test' as const,
      receivingAddress: MERCHANT_ADDRESS,
      apiKeys: ['k'.repeat(20)],
      acceptedTokens: ['$USDC']
    }),
    database: ':memory:',
    host: '127.0.0.1',
    port: 3000
  };

  it('says where it is listening and what it will accept, and names no secret', () => {
    const output = describeRuntime(options, 3000, 0).join('\n');
    expect(output).toContain('http://127.0.0.1:3000');
    expect(output).toContain(MERCHANT_ADDRESS);
    expect(output).toContain('$USDC');
    expect(output).toContain('1 configured');
    expect(output).not.toContain('k'.repeat(20));
  });

  it('warns when no public URL is set', () => {
    expect(describeRuntime(options, 3000, 0).join('\n')).toContain('No public URL is set');
  });

  it('warns that the main network is real money', () => {
    const main = { ...options, config: { ...options.config, network: 'main' as const } };
    expect(describeRuntime(main, 3000, 1).join('\n')).toContain('MAIN network');
  });
});

describe.skipIf(!canRunNetwork)('the runtime', () => {
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  const start = async (database: string): Promise<Runtime> =>
    startRuntime({
      config: resolveConfig({
        network: 'test',
        receivingAddress: MERCHANT_ADDRESS,
        apiKeys: ['k'.repeat(20)],
        acceptedTokens: ['$KTA']
      }),
      database,
      host: '127.0.0.1',
      port: 0, // let the OS pick, so parallel runs cannot collide
      log: { log: () => undefined, warn: () => undefined, error: () => undefined }
    });

  it('starts, serves health, and stops cleanly', async () => {
    runtime = await start(':memory:');
    expect(runtime.port).toBeGreaterThan(0);

    const health = await fetch(`http://127.0.0.1:${runtime.port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', network: 'test' });

    await runtime.stop();
    await expect(fetch(`http://127.0.0.1:${runtime.port}/health`)).rejects.toThrow();
  }, 60_000);

  it('is safe to stop twice', async () => {
    runtime = await start(':memory:');
    await runtime.stop();
    await runtime.stop();
  }, 60_000);

  it('persists sessions across a restart when given a file', async () => {
    const file = join(directory, 'sessions.sqlite');

    runtime = await start(file);
    const created = await fetch(`http://127.0.0.1:${runtime.port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'k'.repeat(20)}` },
      body: JSON.stringify({
        amount: '0.001',
        currency: '$KTA',
        orderId: 'restart-1',
        successUrl: 'https://shop.example/ok',
        cancelUrl: 'https://shop.example/no'
      })
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as { id: string };
    await runtime.stop();

    runtime = await start(file);
    const after = await fetch(`http://127.0.0.1:${runtime.port}/api/sessions/${session.id}`);
    expect(after.status).toBe(200);
    expect((await after.json()).orderId).toBe('restart-1');
  }, 90_000);
});
