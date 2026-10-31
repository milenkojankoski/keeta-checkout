/**
 * Argument and environment handling, shared by the commands.
 *
 * Flags beat environment variables, which beat defaults. That order is what lets a
 * Docker image carry an environment and still be overridden by a one-off argument.
 */

export interface ParsedArgs {
  command: string | undefined;
  flags: Map<string, string | true>;
  positionals: string[];
}

/**
 * Flags that never take a value.
 *
 * Without this, `keeta-checkout init --force` would read `init` as the value of
 * `--force` and then find no command, which is exactly the kind of thing that
 * looks like the tool is broken.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['force', 'help', 'version']);

/**
 * Parse `--flag value`, `--flag=value` and `--flag` (true), plus positionals.
 *
 * Deliberately small: a payment server's entry point should not pull in an argument
 * parser with its own dependency tree.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === undefined) continue;

    if (argument.startsWith('--')) {
      const body = argument.slice(2);
      const equals = body.indexOf('=');
      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (!BOOLEAN_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (command === undefined) command = argument;
    else positionals.push(argument);
  }

  return { command, flags, positionals };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name) && args.flags.get(name) !== 'false';
}

/** A whole number from a flag, or `undefined`. Throws on anything else. */
export function flagNumber(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a whole number, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** Flag, then environment variable, then default. */
export function resolveValue(
  args: ParsedArgs,
  flag: string,
  envName: string,
  env: NodeJS.ProcessEnv,
  fallback: string
): string {
  return flagString(args, flag) ?? env[envName] ?? fallback;
}
