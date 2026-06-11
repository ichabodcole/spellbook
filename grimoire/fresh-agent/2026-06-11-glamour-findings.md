---
date: 2026-06-11
spell: glamour
spell_version: post-rebuild (Plans 1–4 + dry-run v3), SKILL.md first edition
agent:
  general-purpose subagent, cold (no build-time context), hard-restricted to the
  shipped skill folder per the marketplace-isolation constraint
task:
  serve "I've got reference images + a short world doc — help me nail down the
  visual style" using only what ships in the glamour skill folder; operate the
  spell as far as a solo agent can with --no-open; log all friction + questions
---

# Fresh-Agent Findings — glamour (2026-06-11)

The cold pass that the 3-reviewer panel couldn't substitute for: a panel _reads_
the SKILL, this agent _operated_ the spell. The real gaps only showed up under
operation.

## Setup

Cold agent given only the user scenario (reference images + world doc → nail
down a style). Pointed at `plugins/spellbook/skills/glamour/` and told an
installed user has **only** that folder — read nothing in grimoire/docs/git.
Environment had Bun 1.3.14 + a healthy `media-forge`, but `CLAUDE_PLUGIN_ROOT`
and `GLAMOUR_HOME` were both **empty** (a realistic harness). It ran real verbs
(`help`, `open --no-open`, `state`, `narrate`, `direction`, `prompts`,
`variant --src`, `spec`, `tail`) and one real media-forge generation, then
cleaned up.

## Friction log

- **`CLAUDE_PLUGIN_ROOT` empty** → the literal copy-paste verb
  (`bun ${CLAUDE_PLUGIN_ROOT}/skills/...`) expands to a broken `/skills/...`
  path. SKILL.md's own callout warned about exactly this and said to substitute
  the absolute path — so the mitigation worked, but the out-of-the-box command
  is broken in this harness.
- **Hard wall at `gather`.** There is no agent verb to add an influence (only
  `read`, which needs a pre-existing `influenceId`) — by design (the user drops
  them in the browser). With `--no-open` and no human, the agent was blocked at
  the first phase with no guidance on what to do or wait for.
- **`read inf-1 "…"` on a session with zero influences returned `{"ok":true}`**
  but silently no-op'd (phase stayed `gather`, influences still `[]`). A success
  response for a no-op is a trap.
- **"no running session" while the daemon was alive.** After ~6 successful
  default-session commands, later verbs failed with `no running glamour session`
  even though the daemon (PID 2288) was still listening. Cause: the CLI resolves
  the default session via a `glamour-latest.json` pointer in `os.tmpdir()`
  (separate from `$GLAMOUR_HOME` and from the daemon); that pointer was dropped
  (a second daemon's shutdown-cleanup racing it). Opaque, no recovery hint.
- **`--session <id>` placement.** Recovery via
  `cli.ts --session <id> direction …` failed with `unknown verb "--session"` —
  the CLI reads the verb from the first raw arg before flag parsing, so
  `--session` must come **after** the verb. SKILL.md said "Add `--session <id>`"
  without saying where; the natural (flag-first) reading fails. With it placed
  after the verb, the full agent-side chain
  (`direction → prompts → variant → spec`) worked and phase auto-advanced.
- **`serviceJobId` not where documented.** mediaforge.md listed it under the
  per-output group (`data.outputs[].serviceJobId`); the real klein-9b response
  had `presignedUrl` + `mimeType` per output but no `serviceJobId` there. It's a
  **job-level** field (confirmed via `generate image --help`: `--no-wait`
  "returns the job id", `--timeout` "exits 124 with the serviceJobId").
- **Snapshot handoff verified solid.** `$GLAMOUR_HOME/snapshots/<id>.json`
  live-updated through the whole chain and matched state — the documented
  recover-from-snapshot handoff is real and reliable.
- Minor: `files_dir` lives under the **system temp dir**, not `$GLAMOUR_HOME`
  (undocumented split); `direction.revision` only bumps with `--revision`;
  `timeout` isn't on macOS PATH (bites anyone scripting around `tail`).

## The questions (the gold)

- **"How do I get the user's reference images into the session at all?"** → gap:
  the author always had a human in the browser; the SKILL never told a
  headless/solo agent to _wait at gather_ and how to detect arrivals.
- **"My daemon is alive but the CLI says no running session — what now?"** →
  gap: the `glamour-latest.json` tmpdir pointer mechanics + the `--session`
  recovery were entirely in the author's head, exposed nowhere in the folder.
- **"Where exactly does `--session` go?"** → gap: the positional-verb parser
  contract wasn't stated; "Add `--session <id>`" reads as a free-floating flag.
- **"Where's the per-image `serviceJobId` for `jobs get`?"** → gap: doc/live
  shape mismatch (job-level vs per-output).
- **"What does `read` do for an unknown influenceId?"** → gap: the validation
  contract (silent `ok:true` no-op) wasn't stated.

## Marketplace-isolation check

**No dead file references** — `references/mediaforge.md` ships in-folder, is
self-contained, and was praised as genuinely good for routing/prompting. The
"full evidence lives in the source repo" lines are honest framing, not links you
must open. The only external dependency is the `media-forge` binary (declared as
a prerequisite; degrades gracefully if absent). The isolation rewrite held up.

## What worked well (keep)

The `CLAUDE_PLUGIN_ROOT`-empty warning ("saved me"); `mediaforge.md`'s
two-paradigm framing + content-type→model matrix + explore-cheap/spend-on-finals
routing; lean `state` by default; the snapshot-as-handoff design; phase
auto-advance; the style-capture vs asset-board distinction.

## Disposition

| Finding                                             | On the route?          | Action                                                                                                       |
| --------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Agent stalls at `gather`, no wait-for-user guidance | **yes, every session** | **fixed SKILL.md** — gather bullet now says wait, watch `state`/`note`, don't `read` before influences exist |
| `--session` must follow the verb                    | likely (any targeting) | **fixed SKILL.md** — explicit `cli.ts <verb> [args] --session <id>`                                          |
| "no running session" while daemon alive             | likely (multi-session) | **fixed SKILL.md** — recovery note (lost tmpdir pointer → `--session`)                                       |
| `serviceJobId` documented at wrong path             | yes (cost reporting)   | **fixed mediaforge.md** — it's job-level, not per-output                                                     |
| `read` unknown id silent `ok:true` no-op            | possible               | **documented** in the gather bullet (CLI hardening deferred)                                                 |
| media-forge external dep, no install pointer        | yes (fresh installs)   | **softened SKILL.md** — confirm with `status`/`ping`; install is the user's                                  |
| `${CLAUDE_PLUGIN_ROOT}` empty breaks literal cmd    | yes (some harnesses)   | already mitigated by the SKILL callout — keep                                                                |
| `files_dir` (tmpdir) vs snapshots (`$GLAMOUR_HOME`) | edge (restore churn)   | accept — server re-materializes on restore                                                                   |
| orphaned `glamour-*.json` pointers left in tmpdir   | low (cosmetic cruft)   | accept — optional `sessions`/`close` prune later                                                             |

## Decay signals

No over-explanation to retire — the opposite: the cold pass restored
load-bearing guidance (gather-wait, session-recovery, `--session` placement)
that subtraction had left implicit. This is the empirical half of **"Start
minimal; subtract before you test"** working exactly as intended: the cold
agent's stumbles defined precisely what to add back, and nothing more.

## Meta

The methodology earned its keep again: three on-route gaps the read-only
reviewer panel never surfaced fell out the moment a cold agent _operated_ the
spell. Reinforces the dry-run lesson ("bun test + bundle checks don't catch
operational gaps — you must run it") and "Architect for the reader's context"
(the reader here being a headless installed agent, not just a browser user). The
two deferred items (CLI validation on unknown `read` id; tmpdir pointer
self-healing/pruning) are optional server hardening, logged for a future
revision.
