# Dev Kickoff: Bounty — modernize to the house agent-interface pattern

**Branch:** `feature/bounty-agent-usable`\
**Created:** 2026-06-15\
**Strategy:** Worktree

---

## Mission

Bounty is the last Spellbook spell still on the old agent-interface substrate
(the agent drives the board through `bg.ts`'s file-pump + a `tail -F | grep`
Monitor; state is in-memory only; no readback, no persistence; the documented
`bun -e` snippet breaks on apostrophes). Migrate it onto the **house pattern**
that Grapevine and Imago converged on: a **persistent daemon** holding canonical
state, a **thin stateless `cli.ts`** verb wrapper, `POST /cmd` (write) +
`GET /state[?lean=1]` (readback) + `GET /events?since=<id>` (SSE tail wrapped by
Monitor), plus debounced snapshot/`--restore`. The five filed issues (#6–#10)
are **not patched individually — they fall out of the migration.** Surface ports
to Alpine-over-CDN (the Grapevine tier, not React) before the ownership/blocked
views land.

## Source Documents

**Project:** `bounty-agent-usable`

- [Proposal](docs/projects/bounty-agent-usable/proposal.md) — decision-complete;
  see **Resolved Decisions**
- [Plan](docs/projects/bounty-agent-usable/plan.md) — phased (A→D + Alpine
  port), grounded with file:line refs to the code to change and the siblings to
  mirror
- [Test Plan](docs/projects/bounty-agent-usable/test-plan.md) — 3 smoke + 11
  critical-path (one per success criterion) + 5 deferred

**Reference implementations to mirror (read while implementing):**

- `plugins/spellbook/skills/imago/scripts/{server.ts,cli.ts}` — the target
  daemon + thin-CLI architecture (`/cmd`, `/state` lean, `/events?since=`,
  snapshot, `--restore` merge-over-defaults, detached `node:child_process`
  spawn)
- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — the refined agent CLI
  (`--stdin`, stdout/stderr discipline, self-echo suppression, scoped reads,
  `--as` identity, exit codes)
- `plugins/spellbook/skills/grapevine/scripts/watch.html` — the Alpine-over-CDN
  no-build surface pattern (target for the surface port)

**Background context:**

- [Project Manifesto](docs/PROJECT_MANIFESTO.md) — design principles
- `grimoire/house-style.md` — see the new rule **"Drive a conjuration through a
  daemon + thin CLI"** (this project is its first adopter)

## Constraints

The proposal's **Resolved Decisions** are binding — do not relitigate:

- **Transport:** full daemon + SSE `/events?since=`, **retire `bg.ts` +
  `watch-events.sh`**. The Monitor workflow is preserved by wrapping
  `cli.ts tail` (not `tail -F | grep`).
- **CLI:** **copy-and-adapt** grapevine + imago; do **not** factor a shared lib
  yet (premature abstraction across differing domains).
- **#6:** agent-activity idle-touch (free with the daemon) + snapshot/restore;
  **defer** the `closing_soon` warning.
- **#9 ownership:** assignment-first (lead sets `owner`), `--mine` +
  `--owner <name>`, light self-claim secondary; **`review` is the human-facing
  handoff cue**.
- **Surface:** Alpine tier, **not** React; no bundler — single static file the
  daemon serves.
- **Migration safety net (every phase):**
  `bun test plugins/spellbook/skills/bounty` stays green; `join.ts` keeps
  working (preserve the WS `init`-on-open frame at `server.ts:377` —
  `join.ts:221` keys its handshake off it); do **not** delete file mode until
  the `cli.ts`+`/cmd`+`/events` path is proven at parity (end of Phase A).
- House conventions: Bun only (`bun test`, `Bun.serve`, no Vite/webpack);
  detached daemon via `node:child_process` (not `Bun.spawn`); honor the
  exit-code contract (0 submit/close, 2 bad args, 124 idle, 130 cancel); format
  changed `.ts`/`.tsx` with `bunx biome check --write` (biome, not prettier).

## Your Workflow

Discovery, plan, and test plan are **already done** — start at implementation.

1. `bun install` in this worktree.
2. Read the Proposal, Plan, and Test Plan above, plus the three reference
   implementations.
3. **Implement Phase A first** (the riskiest, most concrete — daemon + `cli.ts`,
   retire `bg.ts`). Follow the plan's per-phase Key Changes + Validation, TDD
   against `scripts/server.test.ts`. Then B → Alpine port → C → D, per the plan.
4. Verify each phase against the Test Plan scenarios (record results in the test
   plan's Results Addendum; screenshots to `artifacts/screenshots/`).
5. Commit per phase with clear messages; keep `bun test` green at every
   boundary.
6. Update the Completion Status checklist below.

## Completion Status

- [x] Discovery complete (plan is code-grounded; formal discovery skipped)
- [x] Plan created and user-reviewed
- [x] Test plan created
- [x] Phase A — substrate core (daemon + cli.ts; retire bg.ts) — closes #7, #8
- [ ] Phase B — durability (snapshot + restore) — closes #6
- [ ] Surface — Alpine port
- [ ] Phase C — ownership + scoping — closes #9
- [ ] Phase D — dependencies — closes #10
- [ ] Tests passing (full test plan executed)
- [ ] Ready for merge

## Completion

**Worktree strategy:** When implementation is complete and all tests pass:

1. Run `/project-docs:finalize-branch` to perform code review, create a session
   document, and prepare the branch for merge.
2. Do NOT merge or remove the worktree — the orchestrator handles integration
   back into `develop`.

## Notes

- The base branch is `develop` (this worktree branched from it at `ba5e389`,
  which already carries the proposal/plan/test-plan commits).
- The five GitHub issues (#6–#10) are labeled `area: bounty` with
  bug/enhancement
  - priority; each plan phase notes which it closes — reference them in commits.
- Phase A is the **parity gate**: new subprocess E2E must prove `/cmd` (incl.
  `--stdin` quoting), `/state` ack, and `/events` tail-with-resume **before**
  `bg.ts`/`watch-events.sh` and their tests are deleted in the same commit.
- The stray `e2e-1-baseline.png` in the main checkout is unrelated (imago) — not
  part of this work.
