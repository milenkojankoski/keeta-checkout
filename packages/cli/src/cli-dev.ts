/**
 * The development entry point: `pnpm cli -- serve`, which runs the TypeScript
 * through tsx rather than the built bundle.
 *
 * The published entry is `bin/keeta-checkout.js`, which runs `dist/index.mjs`.
 */
import { main } from './index.ts';

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  });
