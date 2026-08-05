# Dev Kickoff: Spell Hardening — fix the shipped spells, then release

**Branch:** cut `feature/spell-hardening` off `develop` **Created:** 2026-08-05
**Strategy:** in-repo branch, anthill team (not a worktree)

---

## Mission

`bounty` and `grapevine` are the most-used spells, and ten open issues say they
are getting things wrong — five filed on 2026-08-05 alone. **Three of them
actively mislead rather than merely annoy**: they return plausible, well-formed,
wrong results and exit 0.

Fix them in harm order and cut a release, so the teams already depending on
these spells get the benefit now instead of waiting on a feature round.

**This is not a feature project.** Everything traces to a filed issue or an
existing backlog item. If you find yourself designing something new, stop and
route it to Cole through the lead.

## Source Documents

**Project:** `spell-hardening`

- [Proposal](docs/projects/spell-hardening/proposal.md) — scope, the harm
  ordering, and the **two decisions that need a ruling** (D1 snapshot semantics,
  D2 heartbeat card model)
- [Plan](docs/projects/spell-hardening/plan.md) — four phases with owners,
  verified file refs, and a cold gate per phase

**The triage these came from** (read the ones for your phase — they carry the
reproduction and the measured evidence, and are more detailed than the plan):

- `docs/backlog/2026-08-05-cli-stdout-truncation-on-pipe.md` — **P0**
- `docs/backlog/2026-08-05-bounty-snapshot-clobber-data-loss.md` +
  `docs/backlog/2026-07-16-bounty-daemon-idle-death.md` +
  `docs/backlog/2026-06-15-bounty-daemon-robustness-nits.md` — **P1**
- `docs/backlog/2026-08-05-grapevine-bounded-tail.md` +
  `docs/backlog/2026-06-15-bounty-tail-drain.md` — **P2**
- `docs/backlog/2026-08-05-bounty-list-lists-boards-not-tasks.md` +
  `docs/backlog/2026-08-05-bounty-heartbeat-session-length-cards.md` +
  `docs/backlog/2026-06-22-bounty-heartbeat-skip-blocked.md` +
  `docs/backlog/2026-07-16-bounty-board-ui-polish.md` — **P3**

**Background:** `AGENTS.md`, `grimoire/house-style.md`,
`docs/PROJECT_MANIFESTO.md`, `.anthill/README.md` (the SOP),
`.anthill/dev/seams.md`

## How to start

1. **Convene the team** — `/anthill:convene`. The invoking agent becomes the
   lead. Seats: `daedalus` (CLI/daemon — most of this), `circe` (board surface,
   P3), `cassandra` (cold gate, every phase).
2. **Run `/anthill:plan`** before building. This spans seats, so the lead
   scaffolds the skeleton and the owning seats **ratify or falsify** the seams
   they touch. Which of the plan's refs are verified and which are claims is
   spelled out under Constraints — check before you build on one.
3. **Get D1 and D2 ruled** (proposal). Both change behaviour teams have habits
   around, both are Cole's call, and both block their phase. Route through the
   lead.
4. Work P0 → P1 → P2 → P3, cold-gating each.

## Constraints

**Binding — do not relitigate:**

- **P0 goes first, and P2 waits on it.** A bounded `tail --no-follow` is a
  print-then-exit command — the exact shape that loses its tail to P0's bug.
  Shipping P2 first would deliver a new way to silently lose history.
- **P0's fix is a drained exit.** Not pagination, not a `--complete` flag. The
  payloads are already complete; only the write is lost.
- **Fix the shape, not the two call sites.** The prep grep already found the
  same `main → process.exit(code)` in **seven** files — the two reported plus
  `astrolabe`, `glamour`, `imago`, `magpie`, and grapevine's `daemon.ts`.
  Confirm per site (not all can emit an over-buffer payload) and **record the
  ones you rule out** — a silent skip is indistinguishable from a miss.
- **Regression tests must read through a pipe.** These bugs are invisible at a
  TTY; a test that doesn't pipe cannot catch them.
- **Scope is closed.** The ten issues plus exactly three named fold-ins
  (`bounty-tail-drain`, `daemon-robustness-nits`, `heartbeat-skip-blocked`).
  Anything else is a new decision.
- **Additive only.** No snapshot format break; a new layout must still read an
  old snapshot.
- **release-please owns versions.** Conventional commits; never hand-edit a
  version.
- **Cole pushes and releases.** The team merges to `develop` locally and stops.

**Know which plan refs are checked and which aren't.** P0's three line refs were
re-verified against the source on 2026-08-05 and are marked as facts. Everything
else — the P1/P3 line numbers carried over from backlog items, the seven-file
audit list — is a **claim**, and R12's lesson stands: a claim in a skeleton is a
hypothesis until the owning seat confirms it. Falsify and say so.

**⚠ The bounty surface mirror has no test guarding it.** Every `server.ts`
derivation has a hand-written Alpine twin in `template.html`. P3 touches these.
Change both in the same commit and name both paths in the land.

**⚠ `#40`'s load-bearing part is the `SKILL.md` nudge, not the code.**
Blocked-skip only bites if waits are modeled as block edges, and the team that
reported it never ran `bounty block`. Without the nudge it passes its tests and
changes nothing in a real session.

## Done when

All ten issues closed or deferred-with-reason; no spell CLI retains the
undrained exit; a `close` cannot silently destroy a non-empty snapshot; blocked
and session-length cards produce no false pokes while genuinely stalled ones
still do; `bun run check && bun test` green; cold gate passed; both `SKILL.md`
files true; closed backlog items moved to `docs/backlog/_archive/`.

Then hand back to Cole for the release.
