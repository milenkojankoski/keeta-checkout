#!/usr/bin/env node
/**
 * The published entry point. Thin on purpose: it runs the bundle and turns the
 * command's exit code into the process's.
 */
import { main } from '../dist/index.mjs';

main(process.argv.slice(2))
  .then((code) => {
    // `serve` only resolves once the server has closed, so reaching here means the
    // command is genuinely finished.
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
