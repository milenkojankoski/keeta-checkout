# 0002. Pin the Keeta SDK versions exactly, and track git against npm

Date: 2026-10-29
Status: accepted

## Context

The design document (`README.md`, section 10) named `@keetanetwork/anchor` 0.0.106,
taken from the upstream git repository, which tagged "Release v0.0.106" on
2026-10-28. The npm registry's latest published version on 2026-10-29 is **0.0.105**.
A git tag and an npm release are not the same event for this package.

`@keetanetwork/keetanet-client` 0.18.8 is published and matches upstream.

The anchor package also moves weekly, and recent releases changed behaviour this
project depends on: 0.0.105 added `KYCPendingReview` and the register-of-UBOs
attribute, and 0.0.106 added per-step `timeoutMs` / `intervalMs` on
`AnchorChainingPath.execute` plus retries for transient status-poll failures.

## Decision

Pin both SDKs to exact versions, no `^` range:

- `@keetanetwork/anchor` **0.0.105** (latest published)
- `@keetanetwork/keetanet-client` **0.18.8**

Bump anchor to 0.0.106 once it appears on npm. Treat every anchor bump as a change
that needs its own commit and a read of the upstream diff, not a routine dependency
update.

## Consequences

- The README's version table is ahead of what is installable. It stays as the
  intent; this record is the source of truth for what is pinned today.
- Dependabot or Renovate must not auto-merge anchor bumps.
- The local clone at `C:\Users\milen_1oh1\dev\keeta-reference` is the place to read
  the SDK source when published types and documentation disagree.
