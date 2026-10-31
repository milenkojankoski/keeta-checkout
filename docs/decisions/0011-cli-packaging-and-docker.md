# 0011. The command-line tool, the bundles, and the container

Date: 2026-10-30
Status: accepted

## Context

Step 9: make the thing runnable. Until now the project was a library with tests and
no way to start a server, which is the gap that mattered most: none of the previous
eight steps could actually be used by a merchant.

## Decisions

**A separate `keeta-checkout` package, not a bin on the server package**

1. `npx keeta-checkout init` is the interface the design promised, so the package a
   merchant installs is named `keeta-checkout` and depends on
   `@keeta-checkout/server`. The server package stays a library. This adds
   `packages/cli` to the layout in README section 15.

**Three commands, in the order a merchant should run them**

2. `init` writes a configuration and **generates both secrets itself**, because a
   human asked to invent an API key invents a weak one. It refuses to overwrite
   without `--force`.
3. `check` validates the configuration and then reaches the network to confirm what
   a merchant cannot verify by reading their own file: that the receiving account is
   readable, that the resolver answers, and that every accepted token resolves and
   is payable by a shopper. It earns its own command because each of those failures
   otherwise appears as a shopper who cannot pay.
4. `serve` starts everything. It prints what it will accept and where, and warns
   when the public URL is missing or the network is `main`.
5. **`init` never asks for a seed**, and the file it writes says so. The server
   holds no signing key, so a leak of that file cannot move the merchant's funds.
   Saying it in the file is how the merchant learns it.

**Shutdown order is part of the design**

6. Stop the HTTP server, then the watcher so it is not mid-scan, then the
   dispatcher, which flushes the deliveries it has already queued, and only then the
   store. Closing the store first would make everything above it fail on the way
   out. Both `SIGINT` and `SIGTERM` take that path, so a container stop drains
   rather than cuts off.

**Builds, now that something has to ship**

7. The workspace had no build step: every package pointed `main` at `src/*.ts`.
   That is fine for tests and impossible for a published CLI. esbuild now produces:
   - `packages/cli/dist/index.mjs`, 113 KB. The **workspace** server package is
     bundled in; the four npm dependencies are external and declared on the CLI
     package itself.
   - `packages/button/dist/keeta-pay-button.js`, **6.1 KB minified**, an IIFE that
     registers the element as a side effect, for a plain `<script src>`.
   - `packages/button/dist/index.mjs` for bundlers.

   Getting that split right took three attempts, and the failures are worth
   recording because each produced a CLI that built cleanly and would not run:
   - `--packages=external` leaves the *workspace* server external too, so the
     binary tried to import `packages/server/src/index.ts` and Node refused the
     `.ts` extension.
   - Externalising the npm packages without declaring them on the CLI left them
     unresolvable: under pnpm they live in the server package's own
     `node_modules`, where the CLI's bundle cannot see them.
   - Bundling everything hit `qrcode`, whose CommonJS does a dynamic
     `require('fs')` that an ESM bundle cannot perform, and inflated the output to
     1.4 MB.

   So: bundle the workspace, externalise the npm packages, and declare those on the
   package that actually imports them.
8. `src/browser.ts` is separate from `src/index.ts` because importing a module
   should not define a custom element, while loading a script tag should.

**The container**

9. Multi-stage on `node:24-bookworm-slim`. The builder carries python3, make and g++
   for the native `secp256k1` build; the runtime carries none of it. Debian rather
   than Alpine to avoid a musl build of those bindings.
10. Runs as the unprivileged `node` user, binds `0.0.0.0` because loopback is
    useless in a container, and keeps the database on a `/data` volume rather than
    in an image layer.
11. `ENTRYPOINT` in exec form so the process is PID 1 and gets `SIGTERM` directly,
    with a 30-second `stop_grace_period` in compose to let the drain finish.

## Verified end to end, not just unit tested

On 2026-10-30, through the CLI against the live test network: `init` wrote a
configuration, `check` passed every probe, `serve` started, a session was created
over the API, the hosted pay page rendered with its nonce policy, the QR route
served 5910 bytes of SVG, a **real** send was published from the payer wallet, the
watcher credited it, the pay page showed Paid, and the payments ledger recorded it
as `matched`. The runtime test also stops and restarts against the same SQLite file
and finds the session still there.

## Two bugs this step found

**A boolean flag swallowed the next word.** `parseArgs` took the following token as
a value whenever it did not start with `-`, so `keeta-checkout init --force` read
`init` as the value of `--force` and then found no command, printing usage as if the
tool were broken. `--force`, `--help` and `--version` are now declared value-less. A
test asserts `['--force', 'init']` parses as the flag plus the command.

**`--help` exited 1, and `--version` printed the usage.** Both because neither
carries a command, and the no-command branch claimed them. Version is now checked
first, and the usage branch exits 0 when help was asked for and 1 only when there
were no arguments at all. A scripted `keeta-checkout --help` in a CI check would
have failed on the exit code alone.

## What was not built

The build-order line for this step also said "docs site". There is
`docs/quickstart.md` and the decision records, but no generated static site. A site
generator is a dependency and a deployment to maintain, and nothing is published
yet, so it would be maintained for no reader. Worth revisiting when the packages go
to npm.

## Consequences

- 416 tests pass. The CLI adds 23, several of which start a real server on an
  OS-assigned port.
- `pnpm build` builds every package. `pnpm cli -- serve` runs the TypeScript through
  tsx for development; `bin/keeta-checkout.js` runs the bundle in production.
- A merchant can now go from nothing to a paid order with four commands and no
  TypeScript.
- Horizontal scaling is still out: the watcher and the dispatcher each assume they
  are the only one of their kind against a database. The compose file says so.
