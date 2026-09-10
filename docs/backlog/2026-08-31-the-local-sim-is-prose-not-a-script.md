# The local-sim is the only check that sees a port's real failure, and it is still prose

**Added:** 2026-08-31 · **Found by:** `thoth`, auditing what the port playbook
could and could not source from the tree · **Scope:** `scripts/`, one file ·
**Severity:** medium — **the check works; nothing makes it repeatable**

## The gap

Every sprint-01 and sprint-02 phase plan says some version of:

> The local-sim is not optional here and **it is not automated — write it down
> as a procedure or it will not be run twice.**

**It was never written down as one.** `scripts/` holds `land-check.ts`,
`bounty-preflight` and `instruments/`; there is no local-sim script. The
playbook's Phase 3 is now the closest thing to a procedure, which is thin cover
for **the only check that sees the failure a port actually produces.**

## Why it matters more than a convenience

The gate is structurally blind here and always will be: `bun test` runs in-repo
with the full tree and root `node_modules` present, so **every emission option
passes the suite regardless of whether the installed artifact works.** The
local-sim is what discriminates, and it has caught things nothing else could — a
daemon that could not boot offline, a wrong cwd serving one Tailwind marker
instead of 213, a bundle whose launcher printed silence.

Four ports have now been verified this way **by hand, each time reconstructed
from prose.** Five spells remain. The reconstruction cost is paid per port, and
the risk is not that it is slow — it is that a step gets dropped and the run
still looks like a pass.

## What it should do

Take a spell name. Copy **only** what ships (`SKILL.md`, `scripts/`, `dist/`,
plus `shared/` where it exists) to a scratch path, **walk every parent to `/`
asserting no `node_modules`, no `package.json`, no `bunfig.toml` — and the
global `~/.bunfig.toml`, which a parent-directory walk cannot see.** Then boot
the daemon, assert the emitted mode is `release`, drive the CLI's contract
surface, and tear down.

**It cannot replace the browser drive** — a served 200 is not a working board,
and the obvious automated forms of that check _prefer the broken artifact_. See
[`no-instrument-asserts-a-board-works`](./2026-08-31-no-instrument-asserts-a-board-works.md).
This script covers the deps-free half only, and should say so when it passes.

## Acceptance

- [ ] `bun scripts/local-sim.ts <spell>` exists and is cited from the playbook's
      Phase 3 rather than described there.
- [ ] It **reports what it copied and what it walked**, so a pass names its own
      scope. Per Contract 18's corollary, an empty or unresolvable set is **NO
      VERDICT**, never a pass.
- [ ] It leaves no daemon running and no scratch tree behind.
