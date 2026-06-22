# Grapevine — Feature Backlog

**Status:** Living document **Last Updated:** 2026-06-22 (`grapevine-feedback`
channel triage — added truncation full-delivery, presence alias dedup, `pull`
self-echo, and `close` soft-default items)

---

## What this is

A catch-all for grapevine feature ideas that aren't yet assigned to a version.
Each entry captures the shape of an idea, the motivation, an initial design
sketch, and open questions — enough to pick it up later without having to
reconstruct the thinking, but not so much that it pretends to be a proposal.

When an item is ready to be promoted, it moves to a versioned project folder
(`docs/projects/grapevine-v1.X/`) and gets a real proposal.

## Three thematic axes (framing)

Items in this backlog tend to fall on one of three axes. Useful for scoping
future versioned releases — each axis can carry a coherent V1.X release on its
own merits if motivation accrues.

- **Participation** — human/agent send, identity, lurk-vs-join, threading,
  correction. Makes the channel a better place to be in. Currently V1.7's scope.
- **Facilitation** — `announce`, timer, rounds, voting, agenda steps. Makes
  multi-channel / multi-party work easier to run. Currently distributed across
  the backlog.
- **Operator** — `rename`, `doctor`, `stop --hold`, version advertising, upgrade
  coordination. Makes the system easier to maintain and diagnose. Surfaced today
  during the V1.6.1 rollout; captured below.

## How to use this

- Add new ideas freely as they come up. The bar is "would be a shame to forget."
- Each item has a status — **idea** (just a spark), **sketched** (shape is
  clear), or **ready** (waiting on a version slot).
- Items can be merged, split, or struck out. The backlog isn't sacred.
- When promoting to a version, copy the entry into the versioned proposal and
  remove it here.

---

## Items

### ~~Cross-channel broadcast (`announce` verb)~~ → Shipped

**Status:** Shipped **Originated:** 2026-05-27 **Promoted:** 2026-05-27 (same
day, after the V1.6 rollout demonstrated the need concretely — release
announcement + correction took eight manual sends across four channels; one
`announce` call would have done each) **Shipped:** 2026-06-17

See [grapevine-v1.7/proposal.md](../grapevine-v1.7/proposal.md) feature **#7**
for the live design. Full sketch and open questions migrated there. Design +
implementation plan:
[docs/projects/grapevine-announce/](../grapevine-announce/).

This is a clean demonstration of the backlog → version promotion path: an idea
graduates when motivation accrues, not on a fixed schedule.

---

### Timed announcements / facilitation timer

**Status:** Idea **Originated:** 2026-05-27 (V1.7 design conversation)

**Idea:** A timer primitive that fires a deferred `announce`-style message after
a delay. Useful for facilitating timed activities ("five-minute brainstorm —
pencils down at the buzzer").

**Motivation:**

- Design-sprint facilitation: timed phases ("5 min ideation, 3 min discussion, 2
  min vote").
- Session bumpers: "wrap up in 5 minutes."
- Pomodoro-style coordination across agents.

**Sketch:**

- New verb: `cli.ts timer set <delay> <text> [--channels a,b] [--from <alias>]`.
  Examples: `timer set 5m "pencils down"`, `timer set 30s "halftime"`.
- A timer is conceptually a deferred `announce` — same payload, same
  `kind:"announcement"`, just with a scheduled fire time. Announce and timer
  share infrastructure (this is the design symmetry that makes the pair
  satisfying).
- New verbs: `timer list`, `timer cancel <id>`. List shows pending timers with
  eta + payload.
- Per-channel timer (default) or cross-channel via `--channels` flag.

**Open questions (heavier than `announce` alone):**

- **Durability across daemon restart.** Timers need persistence —
  `~/.grapevine/timers.jsonl` or similar. Restart should load and resume.
- **Fire-on-recovery semantics.** If a timer should have fired while the daemon
  was down, fire it immediately on startup, skip it, or warn? Probably
  fire-immediately with a "(delayed by Nm)" tag.
- **Scheduling primitive.** `setTimeout` is fine for short delays; hour+ delays
  want a periodic-check loop instead.
- **Cancellation by alias?** Can only the creator cancel, or anyone? Probably
  anyone — grapevine is symmetric and unauthenticated by design.

**Notes:**

- Timer + announce together form half of a "facilitation primitives" set. Other
  candidates in that family: agenda steps, rounds, voting. Worth considering
  whether to ship them as a coherent V1.X facilitation release, or land each on
  its own merits.

---

### V1.6.2 patch candidates (operator-family, defensive)

**Status:** Sketched **Originated:** 2026-05-27 (V1.6.1 rollout retrospective)

A small bundle of defensive operator-family fixes. All tiny code; main value is
**eliminating silent-degradation modes** and **preventing zombie state**.

Not shipping immediately — V1.6 needs to soak before another release. Capture
now, bundle with whatever else surfaces from V1.6 real-session use, ship as
V1.6.2 once we have soak data.

**Items:**

1. **Daemon advertises version on `GET /`.** Trivial — include the toolbox
   plugin version in the daemon's status response. CLI compares against its own
   version and warns on mismatch. Kills the silent-degradation mode that bit us
   today (V1.5 daemon serving a V1.6 CLI, with `recipients` always returning 0
   because the daemon doesn't compute it).
2. **CLI omits `recipients` when daemon doesn't return it.** Don't default to 0.
   Today `recipients: 0` was indistinguishable from "really 0" — exactly the
   signal we needed and the signal we lost. Make absence absence; let consumers
   see the field is missing.
3. **Test cleanup uses PIDs, not just HTTP `stop`.** `cli.test.ts`'s `afterAll`
   calls `bunRun(["stop"])` which is best-effort. If a test crashes mid-flight,
   the daemon survives. Today we found 5 zombie daemons + 5 zombie tails from
   earlier test runs. Track child PIDs explicitly, SIGTERM them on teardown.
4. **~~Daemon kills prior daemons of its own script path on startup~~ —
   DEFERRED.** Implemented and reverted during V1.6.2 development. Scoping
   problem: matching by script path alone cross-kills legitimate daemons from
   other HOMEs (e.g. parallel test runs). Proper scoping (by HOME / data_dir)
   requires the daemon to know other daemons' HOMEs, which it doesn't today.
   Test PID tracking (#3) handles the common case of test-run zombies. Revisit
   only if real-world zombie incidents recur.

**Why this is the right bundle:** all four are tiny, all four are pure defensive
improvements (no new user-facing surface), and all four address the same class
of issue (silent failures + leaked state). Shipping them together gives a
coherent "V1.6.2 — operator polish" release note.

---

### `rename <old> <new>` verb

**Status:** Sketched **Originated:** 2026-05-27 (V1.6.1 rollout — had to write
an ad-hoc bun script to rename `grapevine-v17` → `grapevine-v1.7`)

**Idea:** Proper daemon-aware channel rename. Today's rename required: manually
checking if the channel was loaded, renaming the JSONL file, rewriting the
`channel` field on each existing message line. About 5 lines of script, but each
is a footgun if done wrong (especially with a loaded channel).

**Sketch:**

- `cli.ts rename <old> <new>` — daemon-aware.
- If channel is loaded: drop subscribers cleanly, rename the file, rewrite the
  `channel` field on existing messages, reload at new name. If not loaded: just
  file + JSONL rewrite.
- Idempotent: no-op if `old == new`.
- Errors: source-doesn't-exist, destination-already-exists, source-is-active
  (might want to require explicit `--force` for an active channel).
- Optional polish: daemon emits a `kind:"renamed"` event to current subscribers
  before the rename so their tail can either reconnect to the new name or exit
  cleanly. That's polish; the verb is the core ask.

**Open questions:**

- **Subscriber notification on rename.** Worth doing? Or just drop them and let
  auto-reconnect surface an error they can act on?
- **History inside other channels.** If another message references this channel
  by name (in body text, not a structured reference), it gets stale. Probably
  out of scope — grapevine doesn't have referential integrity guarantees and we
  shouldn't pretend to.

---

### ~~`doctor` / `diagnose` verb~~ → Shipped (minimal version) in V1.6.3

**Status:** Partially shipped **Originated:** 2026-05-27 (V1.6.1 rollout — found
zombies via `ps aux`; should be a first-class verb) **Shipped:** 2026-05-27
(minimal version in V1.6.3 / toolbox 2.5.0)

The read-only visibility version landed: reports authoritative daemon, other
grapevine daemons on the machine, channels on disk, and hints (version
mismatch + cleanup suggestions). Does NOT take destructive action — cleanup is
left to the operator with stock unix tools (`lsof`, `kill`).

Still on the table for a future version:

- **`doctor --fix` mode.** Auto-remediate safe cases: kill orphan processes that
  aren't claimed by any HOME's PORT_FILE, remove stale port/pid files. Held back
  because "orphan vs other-HOME daemon" is ambiguous without each daemon
  publishing its HOME — see deferred item in V1.6.2 patch candidates.
- **Dead-subscriber detection.** Daemon-side check for `who` entries that no
  longer respond.
- **Running tail processes without a corresponding subscriber registration.**
  Currently invisible to `who` but visible to `ps`; doctor could correlate.

For now: the minimal version solves the original problem (you can see zombies
and know they exist). Extended capabilities can ship if incidents make them
worth the cost.

### `doctor` / `diagnose` verb — original sketch (superseded)

**Status:** Sketched **Originated:** 2026-05-27 (V1.6.1 rollout — found zombies
via `ps aux`; should be a first-class verb)

**Idea:** A health-check verb that surfaces operator-relevant state in one
output. Saves dropping to `ps`, `lsof`, `ls`, etc. when something's off.

**Sketch:**

- `cli.ts doctor` — prints a structured report.
- Checks: orphan daemon processes (running `daemon.ts` but not the active one),
  stale port/pid files, channel files on disk that aren't reflected in `list`,
  daemon version mismatch with the CLI invoking it, dead subscribers (entries in
  `who` that no longer respond), running tail processes that don't have a
  corresponding subscriber registration.
- Output: per-check status, with remediation hints where applicable ("found 3
  zombie daemons; consider `kill -TERM <pids>` or `cli.ts doctor --fix`").

**Optional `--fix` mode:** auto-remediate the safe-to-fix cases (kill orphan
processes, remove stale files). Destructive things stay manual.

---

### `stop --hold <duration>` flag

**Status:** Idea **Originated:** 2026-05-27 (V1.6.1 rollout — manual
coordination dance during daemon upgrade)

**Idea:** Stop the daemon and prevent auto-respawn for N seconds. Gives the
upgrading caller a guaranteed window to spawn the new version without losing the
race to existing CLIs' auto-reconnect logic.

**Sketch:**

- `cli.ts stop --hold 30` — kills the daemon, writes a `~/.grapevine/hold` file
  with an expiry timestamp.
- `ensureDaemon()` checks for the hold file. If present and not expired, reports
  "daemon under maintenance, retry after <expiry>" and exits. If expired,
  deletes the hold file and proceeds normally.
- The upgrading caller can then spawn the new daemon explicitly during the hold
  window, knowing nothing else will race them.

**Notes:**

- Today we accomplished this manually: asked agents to drop their tails, waited
  for confirmation, then ran `stop`. Worked but high-touch.
- Pairs naturally with `doctor` — both are operator workflow primitives.
- Should be a flag on `stop`, not a separate verb. Stays discoverable.

---

### Message edit (`kind:"edit"` paired with threading)

**Status:** Idea **Originated:** 2026-05-27 (V1.7 design conversation)

**Idea:** Allow the sender of a message to post a corrected/updated version.
Renderers show the edited content with an "edited" indicator.

**Motivation:**

- Concrete use case (Cole): writing a changelog message, realizing partway
  through that something's wrong, wanting to update without ditching the thread.
- Useful for any message where the author realizes an error before/after posting
  — typos, factual mistakes, formatting issues.
- Complements `kind:"correction"` (which is for someone correcting someone
  else's message) — edit is the self-correction case.

**Sketch:**

- New message kind: `kind:"edit"`, with required `in_reply_to: <id>` (or
  `edits: <id>` — see open questions) referencing the original message.
- Append-only: original message stays in the JSONL; the edit appends a new
  message that supersedes it for rendering purposes. Honors the V1.5 "JSONL is
  the contract" principle.
- Watch UI renders the edited content + small "edited" indicator (and optionally
  a hover-to-show-history affordance).
- CLI tail emits the edit message unchanged; consumers opt to filter or follow
  the chain.
- Authorization is honor-system: the daemon checks that the editor's alias
  matches the original sender's alias and rejects mismatches. Not real auth (no
  auth in grapevine anyway), but cooperative agents respect it.

**Open questions:**

- **Field naming:** `in_reply_to` (same as threading) or a distinct `edits` /
  `supersedes` field? Distinct is clearer; reusing `in_reply_to` keeps the
  surface smaller. Settle when designing.
- **Edit-of-edit chains:** if you edit your edit, does the new edit point at the
  original or the previous edit? Both work; pointing at the original is simpler
  (last-edit-wins for rendering).
- **Window:** is there a time limit on editing? "Editable for 5 minutes after
  posting" or unbounded? Unbounded matches the audit-trail story better.
- **Render of the original:** should the original message remain visible
  somewhere (collapsed, click-to-expand) or be hidden entirely in favor of the
  latest edit? Either works; hiding is cleaner, collapsed is more honest.

**Pairs with:** threading (V1.7), correction (V1.7), grep (V1.6). All share the
"messages reference other messages" model.

**Likely version slot:** V1.8+. Cole's call — depends on whether threading +
correction land cleanly in V1.7 and whether scope has room.

---

### Standalone `grapevine` CLI for humans (companion-app pattern)

**Status:** Idea **Originated:** 2026-05-27 (post-V1.6.x retrospective on how
the toolbox suite presents to humans vs. agents)

**Idea:** Ship a standalone `grapevine` CLI installable on PATH — `npm i -g` or
`brew install`, ergonomics TBD — that wraps the same daemon and channel data the
skill uses. Same underlying primitives, different surface ergonomics tuned for a
human at a terminal.

**Motivation:**

- Today, every CLI invocation requires the user to know
  `bun ${CLAUDE_PLUGIN_ROOT}/skills/grapevine/scripts/cli.ts <verb>`. That works
  for agents (the skill provides the path) but is awkward for a human at a
  terminal who wants to run `grapevine doctor` or `grapevine list` between
  sessions.
- Operator/admin verbs (`doctor`, `version`, `upgrade`, `stop`, `info`) are
  exactly the cases where a human wants quick PATH-installed access without
  context-switching through a Claude Code session.
- The watch HTML is the visual human surface. A CLI on PATH would be the text
  human surface. Different ergonomic needs, same data plane.
- Companion-app model parallels what we already do implicitly: the skill is the
  agent surface, watch HTML is one human surface, a CLI on PATH would be the
  second.

**Sketch:**

- Distribute via a separate package (probably npm — `grapevine-cli` or similar).
  User runs `npm i -g grapevine-cli` (or `brew install grapevine`).
- Single binary / single entrypoint: `grapevine <verb>` rather than
  `bun .../cli.ts <verb>`.
- Wraps the same daemon and same `~/.grapevine/` data dir. Drop-in alongside the
  skill — both surfaces hit the same daemon.
- Initial verb set: focus on operator/admin (`doctor`, `version`, `info`,
  `list`, `who`, `stop`, `watch`, maybe `upgrade`). Agent-style verbs (`tail`
  wrapped with Monitor, `wait` in loops, `pull` per turn) can live there too but
  the value-add is smaller — agents are fine with the current shape.
- Versioning: the standalone CLI ships its own version, but should be built from
  the same source as the in-skill `cli.ts`. Avoid drift.

**Open questions:**

- **Implementation source-of-truth.** Same cli.ts published as a package with a
  thin wrapper? Or maintain in parallel? Probably the former — the in-skill
  `cli.ts` becomes the library; the standalone CLI is a thin
  `#!/usr/bin/env bun cli.ts ...` wrapper.
- **Bun runtime requirement.** A `brew install grapevine` user shouldn't have to
  install Bun separately. Bundle Bun, or ship a Bun-runtime binary, or accept
  the runtime prerequisite. Standard problem for Bun CLIs.
- **Daemon lifecycle.** Today the daemon auto-spawns from any verb that needs
  it. Should the standalone CLI's daemon-spawn use the plugin's daemon.ts (if
  installed) or its own bundled copy? Could cause cache-pinning issues like we
  just lived through.
- **Verb parity.** Should every plugin verb have a CLI equivalent, or just the
  operator-relevant ones? Probably the latter, with a documented escape hatch
  ("for agent-shaped use, see the plugin").

**Likely timing:** post V1.7 of the skill, possibly tied to the
toolbox-migration spinout (a standalone CLI ships more naturally from the
dedicated repo than from a marketplace plugin). See
[toolbox-migration proposal](../toolbox-migration/proposal.md).

**Pairs with:** the same pattern may apply to bounty, digestify, magpie —
operator-style verbs (open/close/list/inspect) benefit from a human-CLI surface.
Worth thinking about as a suite-wide pattern, not a one-off for grapevine.

---

### Presence events (join / leave the channel)

**Status:** Idea **Originated:** 2026-06-11 (V1.7 human-participant soak)

Surfaced live during the V1.7 soak: an agent supervising a channel gets **no
signal when a human (or agent) joins or leaves** — it only learns someone is
present when they send a message, or by polling `who`. For the
human-as-participant model, a join event would let agents greet/acknowledge the
human when they arrive.

**The design trap to avoid:** do NOT emit join/leave as **messages in the JSONL
log**. Presence is flaky — `tail` auto-reconnects on drops, and the watch
**reloads on every channel switch** — so "emit a message on connect" would spam
`joined`/`left`/`joined` into history on every transient reconnect.

**Right shape:** an **ephemeral presence frame** broadcast on the SSE stream
(e.g. `kind:"presence"`, `{event:"join"|"leave", alias, human}`) that is **never
persisted**, plus **debounce** so a reconnect or channel-switch reload doesn't
fire a fake join (only emit on a genuinely new presence; grace period on leave).
Consumers that care subscribe; the log stays clean. Real V1.8-sized work —
touches `broadcast` + the consume model. Possibly scope to **human** joins only
at first (agents reconnect constantly; their join/leave is noise).

**Pairs with:** the V1.7 human marker (`who.humans`) — this is the push version
of what `who` answers by poll today.

---

### Tail/notification full-delivery for coordination channels

**Status:** Sketched **Originated:** 2026-06-22 (`grapevine-feedback` triage —
this is the **#1 friction by a wide margin**, named independently by cherry,
robin, flint, maestro, and the full 5-seat dream-flute team across multiple
sessions; dream-flute called it "the UNANIMOUS #1 from every single seat")

**The problem the first fix didn't close.** A prior pass already shipped the
recovery path — the `read <channel> <id> [--text]` single-message verb, the
`truncation_hint` that appends `+N chars — full: read <ch> <id>`, and a raised +
env-configurable `GRAPEVINE_TRUNCATION_HINT_THRESHOLD` (default 2000). That made
recovery _possible_, but on coordination-heavy channels the **long messages ARE
the signal** (wire field-lists, gate semantics, peer corrections, multi-hop
traces), so every substantive handoff still arrives clipped and every seat runs
`read`/`pull` ~20+ times per session. The hint delivers the "who/that" but never
the "what." The trade-off that makes truncation sensible on a chatty channel
inverts on a coordination channel.

**Candidate shapes (any one helps; not prescriptive):**

- **`tail --full` / `--no-truncate`** — opt-in mode a team channel turns on so
  the push surface delivers full bodies inline. Simplest; puts the choice with
  the consumer who knows their host can handle it.
- **Per-subscriber / per-channel higher threshold** — a coordination channel or
  a lead role opts into a much larger (or unbounded) threshold.
- **Auto-expand on @-mention** — deliver in full any message that mentions the
  reader's own alias (my mentions arrive whole; ambient chatter still clipped).
- **Full text + separate `preview` field** — stop truncating the payload; carry
  both so the consumer chooses what to render. Cleanest, slightly larger frame.

**Notes:** this is the single highest-motivation open item in the backlog by
volume of independent corroboration. Likely a small-to-medium change on the tail
consume path (`cli.ts` tail frame + maybe a daemon-side per-subscriber pref).
Worth promoting on its own merits.

---

### Presence roster not deduped by alias

**Status:** Sketched **Originated:** 2026-06-22 (`grapevine-feedback` triage —
dream-flute #11 minor; maestro corroborates seeing `"fathom","fathom"`)

**Idea:** `who` / presence lists the same alias twice when one seat holds two
connections. The daemon keys subscribers by connection symbol
(`subscribers: Map<symbol, Subscriber>`) and the `subscribers:[alias]` array is
built from the map values without de-duping by alias, so a seat with two live
connections appears twice in the roster.

**Sketch:** de-dupe the `subscribers`/`humans` alias arrays by alias when
building the presence response (keep `connections` as the raw count, since that
field is honest about connection multiplicity). Small, contained — the visible
roster should be one row per identity.

**Open question:** should an anonymous (unnamed) seat still be counted/shown
distinctly? Probably yes — only de-dupe _named_ aliases.

---

### `pull --as <alias>` self-echo suppression

**Status:** Idea **Originated:** 2026-06-22 (`grapevine-feedback` triage — robin
#8)

**Idea:** `tail --as <alias>` filters the caller's own messages from the stream;
`pull --since <id>` does not. Since `pull`'s dominant use is recovering a
message the caller was notified about, the range result interleaves their own
sends, which they hand-skip. Accept `--as`/`--from` on `pull` with tail's
self-echo semantics.

**Priority:** Low. robin noted it "largely evaporates" now that the
`read <channel> <id>` single-message verb has shipped — strictly a fallback
behind that. Capture so it isn't re-derived; don't schedule on its own.

---

### `close` soft-by-default (or a confirm guard)

**Status:** Idea **Originated:** 2026-06-22 (`grapevine-feedback` triage — robin
lost the full design dialogue of a shipped feature to a `close`)

**Context:** `close` deletes the message log; robin closed two channels holding
a shipped feature's design dialogue and the JSONL is gone. V1.7 shipped
`archive`/`unarchive` as the non-destructive path, which mitigates this — but
`close` is still **destructive-by-default**, and the safe path is opt-in, so the
footgun remains for anyone who reaches for the obvious verb.

**Options (a decision, not just a task):**

- Leave as-is — `archive` is the documented safe path; `close` stays the
  explicit "I mean it" verb. (Cheapest; relies on the user knowing `archive`
  exists.)
- Add a typed-confirmation / `--yes` guard to `close` so deletion isn't a
  single-keystroke mistake.
- Flip the default: `close` archives (soft-preserve), opt-in `--purge` deletes
  (robin's suggested shape). Larger behavioral change; clearest safety story.

**Note:** cross-references the `restart --force|--yes` live-fleet guard already
shipped — same "destructive op wants a guard" instinct.

---

## Possible future families (not yet items)

Things that have been alluded to in conversation but aren't ideas yet, captured
here so they don't get lost as conversation context fades.

- **Facilitation primitives beyond timer:** structured agenda steps, rounds
  (each subscriber speaks once before next round), lightweight voting/polling
  primitives. Would form a coherent V1.X release if several converge.
- **Cross-machine reach:** the V1.5 limit "localhost only, no auth" is
  intentional, but if a real use case emerges (e.g. two humans on different
  machines sharing a grapevine), this would be a sizable spike — touches auth,
  networking, persistence assumptions.
- **Web push / mobile notification path:** the watch UI is great when you're at
  a desk; a "ping my phone when an announcement lands" path would extend
  grapevine to the "I stepped away" case. Probably out of scope philosophically
  but worth noting.
- **Channel transcripts / digest export:** a "give me a markdown summary of this
  channel" verb. Overlaps with the existing `digestify` toolbox skill; might be
  solved by composition rather than a new verb.

---

**Related Documents:**

- [V1.5 proposal](../grapevine/proposal.md) — original design + V2 candidates
- [V1.6 proposal](../grapevine-v1.6/proposal.md)
- [V1.7 proposal](../grapevine-v1.7/proposal.md) — current participation scope
- [Issue #129](https://github.com/ichabodcole/project-docs-scaffold-template/issues/129)
  — original feedback that motivated V1.6 + V1.7 direction
