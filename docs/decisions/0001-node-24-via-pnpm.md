# 0001. Target Node 24 in CI, tolerate Node 22 locally

Date: 2026-10-29
Status: accepted

## Context

`@keetanetwork/anchor` declares `"engines": { "node": "24.14.1" }`, an exact patch
pin rather than a range. The development machine runs Node 22.13.1 globally, and
other projects on it depend on that version. Replacing the global install would
affect every unrelated project and is not reversible in one step.

Two things were tried and measured rather than assumed.

**pnpm's Node management does not work here.** Setting `use-node-version=24.14.1`
in `.npmrc`, and `useNodeVersion: 24.14.1` in `pnpm-workspace.yaml`, are both read by
pnpm 11.5.2 (`pnpm config get use-node-version` returns `24.14.1`) but neither is
applied: `pnpm node --version` and every `pnpm run` script still execute on the
global Node 22.13.1. The version itself is available (`pnpm env list --remote 24`
lists 24.14.1), so this is not a missing-release problem.

**The SDK runs correctly on Node 22.13.1.** A smoke test on 2026-10-29 generated a
seed, derived an account, connected a `UserClient` to the test network, read KTA's
decimals from on-chain metadata (18), fetched a balance, and listed 7 tokens through
a signed resolver. All of it succeeded. The engine pin is advisory in practice.

## Decision

- `.node-version` holds `24.14.1`. CI uses it through `actions/setup-node` with
  `node-version-file`, so the supported runtime is exercised on every push.
- Root `package.json` keeps `"engines": { "node": ">=24.14.1" }`, which is the
  runtime this project supports.
- `engine-strict` stays `false`, so local development on Node 22.13.1 proceeds with
  a warning instead of a failed install.
- The machine's global Node install is not changed, and no version manager is
  installed, until something actually fails on Node 22.

## Consequences

- Every pnpm command prints `[WARN] Unsupported engine: wanted: {"node":">=24.14.1"}`
  on this machine. That warning is accurate and is left in place as a reminder.
- Local development and CI run on different Node majors, so a Node-24-only API or a
  behaviour difference would be caught in CI, not locally. Anything that fails
  locally but passes in CI, or the reverse, should be suspected of being this.
- If a real incompatibility appears, install Node 24 side by side with fnm rather
  than replacing the global install, and revisit this record.
