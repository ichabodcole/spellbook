<!-- DRAFT — NOT SHIPPED. Reconstructed 2026-09-09 from the tree by a fresh
     agent (land skill §3): named merge bodies, docs/projects/*/,
     docs/investigations/, and the backend-convergence decision log D1–D54.

     THIS REPLACES THE 2026-09-02 DRAFT, WHICH WAS 181 COMMITS STALE and
     asserted three things that are now false (see the register, section D1).
     Corrected here rather than deleted:
       - glamour "does not pass" acc → glamour is CONFORMANT L0 (7c09d76,
         written the day AFTER that draft; re-run and held through its port).
       - "four spells still do not build … bounty and grapevine need a rewrite
         first" → all eight build. bounty, grapevine and digestify were
         rewritten, not deferred.
       - grapevine's SKILL.md "carries a V2.0 banner" → it carries V2.2, and
         the breaking item is a different one (a read verb no longer creates a
         channel).

     THE HOLD HAS OUTGROWN ITS REASON. The 2026-09-02 draft recorded that Cole
     held the release so that spell-hardening sprints 05 and 06 could ship
     together, per sprint 05's own merge commit. Sprint 06 is still 🟡 SCAFFOLD,
     not ratified, no branch cut (docs/projects/spell-hardening/roadmap.md), and
     in the meantime two further projects landed on develop in full. The promise
     is now holding an eight-spell port and a backend convergence hostage to a
     sprint that has not started. That is a decision for Cole, and it is stated
     here because the cost of keeping the promise has changed by an order of
     magnitude since it was made.

     ⚠ EVERY NUMBER BELOW DECAYS. Re-measure before shipping; do not inherit.
     Ruling 2026-09-02 (Cole): size figures are ROUNDED on purpose — a number
     should be sized to the decision it informs, and no one installs or declines
     over bytes. Exact where something re-runs it, rounded where a human reads
     it. The measurements here were taken at 3755635 on 2026-09-09; the method
     is stated inline wherever a figure appears.

     Corrections carried forward from the 2026-09-02 cold read, still applying:
       - `acc` is NOT an external or independent standard. It is
         git+github.com/ichabodcole/agent-cli-conformance — the same author's
         repo. A cold reader took it as third-party validation, unprompted.
       - NOTHING RE-RUNS acc. Not package.json, not .github/workflows/ci.yml.
         Four of eight spells carry an acc.config.json. Any phrasing that
         implies an ongoing property is wrong.
-->

Every spell now runs where nothing is installed — and their refusals became
routable

## Read this first if you drive a spell from a script

Three spells changed the exit code they use for **"no session"**, and the change
is the same on all three. A script that branches on `exit == 2` for that case is
now wrong on **glamour, imago and bounty** as well as on magpie and mind-mapper,
which already moved.

| spell                      | situation                                            | v2.2.0 (`main`)                                        | this release                                                |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| **glamour** (`7c09d76`)    | no running session                                   | prose on stderr, **exit 2**                            | one JSON envelope on stderr, `kind:"not_found"`, **exit 5** |
| **imago** (`96b3ab7`, D38) | `info` / `state`, no running session                 | `imago: <msg>` prose on stderr, **exit 2**             | envelope, `kind:"not_found"`, with `hint`, **exit 5**       |
| **bounty** (D45)           | `state` / `message`, no or stale session pointer     | `bounty: <msg>` prose on stderr, **exit 2**            | envelope, `kind:"not_found"`, **exit 5**                    |
| **bounty `join.ts`** (D52) | no discovery file, `--id` with no session, dead port | prose on stderr (two lines at a dead port), **exit 2** | one envelope, `kind:"not_found"`, **exit 5**                |
| magpie, mind-mapper        | no running session                                   | already **5**                                          | unchanged                                                   |

**bounty's cooperative refusals moved too** (D51), and they moved off exit `1`,
which under the house taxonomy means _the spell broke_ — the wrong signal for a
duplicate id. Before, each printed prose to stderr, put legacy JSON
(`{"ok":false,"applied":false,…}`) on **stdout**, and exited `1`. Now stdout is
empty, one envelope is on stderr, and `applied:false` lives inside
`error.server`.

| bounty situation                                                | v2.2.0 | this release                    |
| --------------------------------------------------------------- | ------ | ------------------------------- |
| `add` with a duplicate `--id`                                   | 1      | **6** `conflict`                |
| `claim` a task someone else owns                                | 1      | **6** `conflict`                |
| `block` that would form a cycle                                 | 1      | **6** `conflict`                |
| `block --on <ghost id>`, `update`/`remove`/`unblock` a ghost id | 1      | **5** `not_found`               |
| `init` / `close` refused by the daemon                          | 1      | **6**, or the daemon's own kind |

A refusal that arrives with no `kind` degrades to `conflict` — the genus — never
to `internal`. **One deliberate exception:** `bounty open`'s attach refusal
keeps **exit 2** and keeps printing the live board's discovery JSON (`url`,
`port`, `session_id`, `restoreSkipped`) on **stdout**. It is the one refusal
carrying a data payload; recognise it by `restoreSkipped.requested`.

**imago against an unreachable daemon** stopped crashing. It used to die with a
raw Bun `TypeError` and a stack trace at exit 1; it now answers
`kind:"internal"` at exit 1 — same number, now routable.

### `--timeout 0` reversed meaning (D24, D47)

| input                                                                          | v2.2.0                                                                                                                                      | this release                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **`magpie --timeout 0`**                                                       | exits **124 `"timeout"` on the first tick** — even with a live `/events` tail attached, because magpie's idle check had no subscriber guard | daemon **never** idle-closes              |
| **`bounty --timeout 0`**                                                       | closes an **unwatched** board on the first tick; a watched board survived                                                                   | daemon **never** idle-closes              |
| any **negative** `--timeout`                                                   | same as `0` above — `idleMs >= -5` is always true                                                                                           | never idle-closes                         |
| **`ASTROLABE_IDLE_TIMEOUT=-5`** (a different knob — Bun's socket idle timeout) | clamped to **1 second**                                                                                                                     | rejected; falls back to the 255 s default |

Both old behaviours were accidents of a `>=` comparison, not intended semantics
— "close the daemon instantly" is not a plausible reading of `--timeout 0`.
Nothing documented `0` as a value; defaults are 1800 s and 255 s, so nothing in
documented use moves. Accepted rather than restored, and recorded as an
unreconciled divergence (register A7).

**And `--timeout` changed meaning inside its documented range on magpie.** It
used to mean _"the longest this daemon may sit idle while connected"_; it now
means _"linger this long after the last subscriber leaves"_ (`shouldIdleClose`
returns false whenever `subscriberCount > 0`). An agent holding a tail on a
quiet magpie session used to be killed at the 30-minute floor. It is not any
more. This is the same guard that stops a daemon being killed under a live
listener, so it is the fix and the semantic change at once.

⛔ **Neither magpie's nor bounty's `SKILL.md` documents what `--timeout 0`
means, before or after.** The reversal is real and is currently invisible to a
caller reading the shipped contract. Either the SKILLs gain a line or this note
is the only place it is written down.

### grapevine: a read verb no longer creates a channel (`36808a62`)

`pull`, `read`, `wait`, `triage` and a bare `topic <name>` now **404** on a
channel that does not exist. (Four of those are guarded at the daemon route;
`triage` reads the log file rather than a route, so its guard is in the CLI —
same answer to a caller, different mechanism.) Before, they silently rebuilt a
channel a human had just closed — empty, file-less, back in `list`, answering
`{"ok":true,"messages":[]}` **forever**, with no way to discover why. The guard
is in the daemon, not just the CLI, because the read routes resurrected on their
own.

The refusal names its recovery as a verb invocation —
`{"error":"no channel \"x\"","channel":"x","hint":"open x"}` — and the CLI
renders that as a runnable line against its own path, because the daemon cannot
know how its client was invoked.

**Breaking if you read before you open, and it fails loudly the first time.**
`open`, `tail`, `watch`, `send`, `announce`, `mark` and `topic <name> <text>`
still create: only an act that declares intent does. Channels opened by an older
daemon and never written to stay memory-only until something re-opens them.
grapevine's `SKILL.md` carries this as its **V2.2** banner.

### Other wire changes, named rather than smuggled

- **The SSE stream now opens with a `: connected` comment** on astrolabe,
  magpie, glamour and bounty (D20, D35, D47), so a quiet stream flushes headers
  and leaves no `fetch()` unresolved. A client that reads **line 0** rather than
  the first frame breaks; every house tail client drops `:` lines.
- **`.html` is served as `text/html; charset=utf-8`**, was `text/html`.
- **bounty's `connected` / `disconnected` presence frames left the replay log**
  (D47). They are live-only now and **no longer carry an `id`**. Before, a tail
  at `--since 0` replayed the entire browser-presence history and every replayed
  frame advanced the agent's cursor.
- **imago's `proposal.send` and `proposal.dismiss` put the proposal id in the
  frame's `id` field** — which is the tail cursor. `ev.id > since` compared a
  string, so those frames were **never replayed at all**. The cursor is now the
  cursor and the proposal rides beside it as **`proposalId`**, on the wire, in
  the shipped types and in the SKILL.
- **A bare invocation is a usage error** (exit 2, stdout empty, usage on stderr)
  on grapevine, magpie and glamour, where it previously exited 0. `help` /
  `--help` remains the help path at exit 0.
- **Unknown flags are rejected** rather than accepted and ignored, and **flags
  are scoped to their verb**. On grapevine all 26 flags previously parsed on
  every verb; each verb now accepts its own set plus the global identity pair
  `--as`/`--from`. A recognised flag on the wrong verb is refused as MISPLACED
  with that verb's flags as `choices`.
- **A root `--flag` parses as a flag**, and missing or excess positionals, and
  non-numeric values on numeric flags, error before the verb runs.
- **astrolabe** gained exit `1` for an internal fault and puts failures on
  stderr as an envelope.
- **mind-mapper's exit codes moved** (needs-project and the 409 family from 2 to
  6, unknown entity to 5). It reaches no installed consumer — see below — but it
  is real for anything driving it in-repo.

### One human affordance was removed

grapevine's watch surface **no longer has a per-row 🗑 button**. Closing a
channel is now reached through a right-click context menu on the rail row, which
is also where Edit topic and Archive / Unarchive live. The confirm dialog stays.
This was deliberate — the menu is the one path to closing — but a human with the
old muscle memory will not find the button.

## What you receive that you did not have

**Every spell in the roster now ships built, and runs where nothing is
installed.** In v2.2.0 a spell was a folder you copy, and several of them needed
a `node_modules` above them that only existed inside this repo. imago was the
worst case: its daemon statically imported `sharp`, a native image addon absent
from the shipped folder, so **imago's daemon could not boot at an installed
destination**, network or no network. All eight spells — astrolabe, bounty,
digestify, glamour, grapevine, imago, magpie and mind-mapper — now build a
surface into a committed `dist/`, and five of them (astrolabe, bounty, glamour,
imago, magpie) build their **backend** too, emitted behind three-line launchers
at the same `scripts/` paths the docs have always named. imago's daemon starts
offline (`sharp` → Bun's built-in `Bun.Image`). Each port was verified by
copying only what ships to a path with no dependencies on any parent directory
and driving the board in a browser.

**`magpie extract` works again — it had been dead in the shipped plugin for
eight days.** Since the CLI came into the build at `7bb0f4a`, bundling
re-anchored `import.meta.dir` into `dist/`, and `remove.py` lives in `scripts/`.
**Every** `magpie extract` failed there, including the default crop-only path,
and answered `{"ok":true,"cut":0,"failed":1}` **at exit 0** — which is why
nobody noticed. Fixed at `3749a78`, driven fail-first against develop before it
was believed, then driven to a real 70×70 RGBA PNG out of the real rembg model.

**Your SSE tail stops dropping at ten seconds.** glamour, imago and magpie ran a
15-second keepalive with no `idleTimeout` set, and Bun's default request timeout
is 10 s — a server-sent heartbeat does not reset it. The heartbeat arrived five
seconds after the thing it was keeping alive, so **every SSE client dropped at
ten seconds**. Four other spells had each hit this and fixed it separately;
`76079b6` fixed the three that had not. digestify is deliberately untouched — it
holds no long-lived connection.

**A transient read error stops looking like a clean end of watch.**
`readSession` in bounty, imago and magpie swallowed **every** error as "no
session" — so a momentary failure to read the session pointer was reported to an
agent as the pinned session having gone away, and a tail loop exited **0** on
it. Only `ENOENT` means absence now; anything else dies with a named reason. The
session-pointer write also became atomic (temp file plus rename), so a reader
can no longer catch it half-written.

**glamour's tail stops hammering a dead daemon.** Measured against a server that
accepts and ends the body: the old CLI made 51–56 reconnect attempts in 14
seconds at a flat ~252 ms. The shipped one makes 6–7, at 252 · 503 · 1001 · 2002
· 4002 ms, capped.

**An astrolabe tail survives a daemon restart with events, not just with a
connection.** `join` — the verb designed to run for hours carrying presence —
used to resolve the daemon base once and reconnect to that fixed URL forever, so
after any restart it spun silently against a dead port. The event log now stamps
an epoch, a resumed tail is replayed whole rather than filtered against a cursor
from a dead process, and a `kill -9` plus respawn produces an
`{"type":"epoch.changed",…}` frame before the new `ready`.

**A daemon with a listener attached is no longer killed under it**, on
astrolabe, magpie and imago — driven both ways: alive at 12 s with a tail held,
gone 9 s after it dropped. And **an imago `/state` poll no longer keeps a dead
session alive forever.**

**A bounty daemon always ends.** Its shutdown watchdog is the corpus's only
unconditional termination guarantee, and it was armed on **one** of four
teardown entries — its `clearTimeout` sat four lines into a fifteen-line
sequence, beneath a comment saying it sat at the end. Measured with a planted
hang: the idle-close path, the `close` verb and a WebSocket user-close each left
the process running past ten seconds. All four now die at ~2 s, the idle path
exiting with its own code rather than a generic one. This is the orphan-daemon
class the 23-minute hang came from.

**Failures you can branch on, on seven of the eight CLIs.** astrolabe, glamour,
imago, magpie, mind-mapper and bounty answer every failure as one JSON envelope
on **stderr** with stdout empty —
`{ok:false, error:{kind, exit_code, retryable, message, hint?, choices?, server?}, meta:{command}}`
— under the taxonomy usage **2** / internal **1** / not_found **5** / conflict
**6**. grapevine is partly converted; its remaining prose errors predate the
contract. Branch on `kind`, never on the message text. The refusing daemon's own
body is carried verbatim under `error.server` (D31). `--version` / `-V` /
`version` answers on the five spells that have been through acc — astrolabe,
glamour, grapevine, magpie, mind-mapper. It does **not** answer on bounty, imago
or digestify.

**A second bounty agent can still join.** `join.ts` is a caller-facing entry no
previous port had and the gate cannot prove; it was driven for real in both
modes — host and participant connected, a task mutation each way, clean exits.

**grapevine's watch surface does to a channel what the CLI does.** A human can
now create a channel, edit its topic inline or from the menu, archive and
unarchive, and hide archived channels behind a switch (the channel you are on
stays visible). An archived name typed into Create gets the daemon's 409
explained in the dialog, with Unarchive offered instead. Topic editing is
disabled with a stated reason — join first, or read-only — rather than silently
inert.

**grapevine tells you when it made the channel.** A `tail` that created one says
so on the `subscribed` event and in the CLI's grounding line, so tailing a
**mistyped name** is visible instead of looking like a quiet channel. A late
joiner is told the channel is already archived on arrival, rather than finding
out from a rejected send. Archive and unarchive now append a persisted
`kind:"status"` frame, so `pull` replays it and a reconnecting `tail` receives
it; `triage` skips it, because an archive is not a work item. And an opened
channel is written down, so it survives a daemon restart and its age no longer
restarts with the daemon.

**`grapevine schema`** — a verb that emits grapevine's own interface
description, generated from the same registry that drives dispatch, so it cannot
drift from the parser. glamour has one too.

**bounty tells you when a restore failed.** `restoreFailed` (`{path, reason}`)
is on the `open` envelope and the daemon boot log, and is a different situation
from `restoreSkipped`: skipped means never attempted (fix your command), failed
means attempted and the snapshot could not be read (the board comes up empty and
your snapshot is the damaged thing). bounty also gains a feedback touchpoint it
was the only spell missing.

**bounty's board stopped being two implementations of itself.** Its predicates —
`cardPassesFilter`, `cardOverdue`, `ownersOverWip`, `expectedMinutes` — were
tested in `server.ts` and hand-mirrored in Alpine with nothing guarding the
pair. That drift is how `restoreFailed` once shipped emitted-at-five-sites and
rendered-at-zero for a full release. One implementation now, imported by the
daemon and the surface alike.

**Three boards were rewritten and look different.** grapevine's watch surface
(was 1,000 lines of hand-written HTML), bounty's board (1,003) and digestify's
review page (1,505) are now component-oriented React surfaces on the house token
layer. Ruled **behaviour-faithful, restyled** (Cole, 2026-09-06): same routes,
same frames, same features, same failure handling — verified against behaviour
inventories extracted from the old pages (72 rows, 115 rows), driven by the
author and again by an independent agent at the keyboard. They are **not**
pixel-identical and were never meant to be. digestify's three themes —
digestify, cthulhu and classic — all survive tokenized, each asserted by name.

## The download question, and the number moved

This is the one product question the previous draft escalated, and **the number
behind it has moved enough that the movement may be the answer.**

The shipped plugin goes from **5.59 MiB to 15.25 MiB** — 5,863,592 → 15,993,242
bytes, summing git blob sizes under `plugins/spellbook` at `main` vs `develop`.
Tracked files fall from **251 to 153**.

| spell       | `main` (v2.2.0) | `develop` |
| ----------- | --------------- | --------- |
| mind-mapper | 3.00 MiB        | 2.92 MiB  |
| digestify   | 610 KiB         | 2.09 MiB  |
| grapevine   | 303 KiB         | 2.03 MiB  |
| bounty      | 510 KiB         | 1.98 MiB  |
| magpie      | 436 KiB         | 1.74 MiB  |
| imago       | 471 KiB         | 1.70 MiB  |
| glamour     | 189 KiB         | 1.46 MiB  |
| astrolabe   | 136 KiB         | 1.34 MiB  |

That is React, Tailwind and — on five spells — a bundled backend inside each
spell's chunks, which is exactly what makes a dependency-free destination
possible. **The cost and the capability are the same bytes.**

**What Cole is being asked has not changed; the size at which he is being asked
has.** `docs/backlog/2026-09-02-what-a-consumer-receives-per-spell.md` is open
and owned by Cole since 2026-08-10, and it asks: _"Is ~8.7 MB (and growing) an
acceptable install, or does the packaging need to change?"_ It is **15.25 MiB**,
75% above the figure the question was asked at and nearly triple `main`. Three
things that item said would make the number bigger have all happened, and two of
its three mitigations have changed shape:

1. **"Four spells are still unported, so the roster will grow again."** They are
   ported. The roster is complete, so no further **surface** port will move this
   figure. Three backends (grapevine, digestify, mind-mapper) are still shipped
   as source, so there is **one increment left**, not an open-ended series.
2. **"mind-mapper ships ~2.9 MB — roughly a third of the download — and cannot
   be invoked."** Still true, but re-measure the fraction: it is now **2.92 MiB
   of 15.25, about a fifth**. Excluding it saves less of the whole than it used
   to.
3. **"Nothing lets a consumer take a subset."** Unchanged. The marketplace
   clones the whole `plugins/spellbook` subtree; it is all-or-nothing by
   construction.

⚠ **Do not treat this as a bug to fix.** It may well be the right trade. It is
filed because it is **unruled**. What is new is that the roster is now complete,
so this is the first time the question can be asked against a final shape rather
than a moving one.

**Stylesheets: one framing, not two.** v2.2.0 shipped exactly **one** compiled
stylesheet — mind-mapper's, 165,575 bytes. This release ships **eight**,
totalling **435,055 bytes** (summed from the tree on `develop`; 36,484 B for
astrolabe up to 76,969 B for grapevine). The total is up because seven more
spells now have one. The scoping work is why each is 36–77 KB instead of 165 KB
and rising: a bare `@import "tailwindcss"` roots Tailwind's content scan at the
build's working directory, so every spell's stylesheet was being compiled out of
every other spell's text — including class names appearing only in comments and
prose. Scoping each spell to its own surface cut the one stylesheet that existed
before and after, mind-mapper's, from **165,575 to 67,345 bytes (−59%) with zero
classes lost**, verified by two instruments that fail in opposite directions
plus a computed-style comparison over a running board.

## What is now checked, and what that check does not mean

The repo gains its first CI check, named `gate`, on every pull request: build,
lint, full test suite, then `dist-check` — a rebuild-and-diff proving each
committed `dist/` matches its own committed source. `bun test` on this tree is
**1978 pass / 0 fail, 5880 expect() calls across 159 files** (run at `3755635`;
the smaller figures inside individual merge commits were true at their own
commits, not here).

The rebuild arm exists because a stale build artifact produces a **working**
board — the daemon simply serves the previous build — so it is invisible to
tests, to the linter, to a browser drive and to a reviewer. One had already
slipped onto `develop` and was caught by hand.

Four limits on this, stated plainly:

- **The check has to be marked required in GitHub's settings, and no agent can
  do that.** Until a human does, a red `gate` does not block a merge. Filed as
  `docs/backlog/2026-08-31-the-pr-check-must-be-marked-required.md`. ⚠ The
  workflow file's own header asserts _"a ruleset on `main` requires a status
  check named `gate`"_ — that sentence was written in the same commit that
  created the workflow, and **nothing in this tree can confirm it.** Treat it as
  an instruction to a human, not as a statement of fact.
- **None of it asserts that a board works.** These checks prove `dist/` is the
  faithful build of its committed source. They say nothing about whether that
  source is correct. The install simulation that proved the ported spells run is
  a manual recipe run by hand, not a script in the gate. Both filed.
- **`dist-check`'s reproduction arm is CI-scoped** (register C2), so
  source-versus-inlined-copy staleness of two-sided modules is not caught by the
  local gate.
- **Nothing re-runs `acc`** — not `package.json`, not the workflow, not the
  pre-commit hook. Four spells carry an `acc.config.json` (astrolabe, glamour,
  magpie, mind-mapper). **Five have a recorded CONFORMANT (L0) verdict** — those
  four plus grapevine, which is graded but ships no config. **Every one of those
  verdicts is a point-in-time run by a human, not a standing property.**
  glamour's is the only one re-run **after** its port (that ordering was an
  explicit acceptance criterion, and it is the whole reason the result means
  anything: run acc only afterwards and a pass cannot distinguish "the port
  changed nothing" from "the port changed something acc never saw"). **bounty is
  on record NOT CONFORMANT** (3 core violated, 2026-08-24) and took the most
  invasive contract change of this cycle with no re-grade. imago and digestify
  are ungraded. `acc` is `git+github.com/ichabodcole/agent-cli-conformance` —
  the same author's repo, not third-party validation.

The gate also reports what it cannot see, and says so out loud: `bun run check`
reads 487 of 523 hand-authored files and is blind to 26 files / 1,987 lines
(largest: three spells' `styles.css`); the roster-drift ward asserts over 7 of 8
spell folders, mind-mapper excluded by ruling.

## What this deliberately does not reach

**Three backends are still shipped as source** — grapevine, digestify and
mind-mapper. Six of the eight spine concerns now have one implementation instead
of six, in `src/kit/wire/`, but **six spells still own their own spine**, and
grapevine's event bus (durable `.jsonl` replay, presence metadata on subscriber
records) **cannot be served by the shared spine as it stands** — whether the
spine grows or grapevine stays out is undecided (register B6).

**The daemon-restart gap is narrowed, not closed** (D23). Replay triggers only
when the tail's cursor is **strictly** greater than the daemon's, so a tail that
has seen exactly `ready` reconnects at equality and is still
connected-and-silent — the ordinary state of a quiet board. It self-heals on the
first real event, and develop was silent after **every** restart, so this is
strictly better. The one-line `>=` is recorded as the **wrong** repair (a
healthy tail reconnects at the tip every time and would be handed the whole
buffer again). Five daemons stamp no epoch, so the client's epoch hook is inert
for them.

**The spells do not yet agree with each other.** The new
`docs/projects/backend-convergence/conformance-register.md` records 21 such
items at the moment each was chosen, so they are decisions rather than
omissions. The ones a caller can feel:

- **`hint` / `choices` is half-applied**: glamour 12/12, magpie 3/6, imago 2/0,
  bounty 1/0. An agent routing on `error.choices` gets nothing from three
  spells.
- **imago and bounty adopted the failure contract with no test guarding it and
  no acc grade.** Nothing in the gate would say if it regressed.
- **`conflict` (6) is advertised in bounty's contract**, and the register still
  lists it as emitted nowhere — while D51 records bounty's claim, duplicate and
  cycle refusals moving **to** 6 in the same phase. One of those two is stale;
  resolve it before shipping.
- **`imago info` against a dead daemon exits 0** with a stale pointer on stdout
  — a third failure shape nobody named.
- **Teardown order diverges** between glamour and imago, so a CLI verb issued
  during imago's 150 ms grace can still find the session.
- **mind-mapper does not import the kit's error module.** It keeps a private
  copy of the taxonomy in its own CLI — numerically identical today,
  structurally a fifth copy, and nothing guards the pair.
- **bounty's `join.ts` reuses exit 2 for two things** — usage, and
  ended-by-error — distinguished by channel, not by number: an ending writes a
  `disconnected` frame and never an envelope.

**Shared code between spells is a capability, not a cleanup.** If you adopt a
kit component you must also import the kit stylesheet — importing only the
component ships it with none of its utilities, silently, and everything stays
green.

**mind-mapper is not a released spell.** It ships files and a `dist/` (2.92 MiB,
about a fifth of the plugin) but has **no `SKILL.md`** and is absent from every
listing on purpose — it is unfinished, and Cole ruled that a spell that has not
coalesced should not claim a roster slot. Nothing here changes that.

## Known defects shipped on purpose

**The most severe is unchanged and still unfixed.** `bounty update --stdin`
destroys the task's title, at `{"ok":true}`, with `valuesIgnored` reporting
`null` — a false negative on a destroyed field. Note the precise framing,
because the loose one ("it writes notes to the title") was withdrawn on the
backlog item itself: **`--stdin` replaces the verb's positional argument, and
that rule holds everywhere** — `add <title…>` → the title, `message <text…>` →
the text. `update`'s only positional is `<id>`, so `--stdin` has no natural
referent and resolves to `--title`, overriding an explicit `--title` silently.
**The code is untouched; bounty's `SKILL.md` has shipped a prominent warning
since 2026-08-11.** Use `--notes`.

Also still open, and also unfixed here:

- `bounty tail` against a target it cannot resolve retries forever at exit 0
  while looking alive (GitHub `#98` — an **inbound** issue; another team is
  waiting on it). The port made this sharper rather than fixing it: the shared
  tail client now **offers** the distinction — `onUnresolved` receives
  `{everResolved, everConnected}` and may return `"stop"` — and glamour, imago
  and magpie all use it. bounty is the only consumer that ignores it and always
  returns `"retry"`.
- `astrolabe close` can exit 0 while carrying an error envelope
  (`{ok:true, applied:false, error:"no daemon running"}` — mis-shaped on both
  axes). It is the one command that calls `postCmd` directly and so bypasses the
  `if (!r.applied && r.error) die(r.error)` discipline every other verb goes
  through. **No test asserts either the current behaviour or the corrected
  one**, so nothing would catch a fix or a regression.
- A **non-numeric** `--timeout` (`--timeout abc`) parses to `NaN` on magpie and
  bounty, which means the daemon never idle-closes — silently, with no refusal.
  Unchanged before and after; noted here because the `0` reversal above puts a
  reader's eye on the same flag.
- A real flag can still be silently swallowed as a positional after a `--`
  terminator. On bounty this is worse than silent: a `--session-key` placed
  after `--` is eaten and the write lands on whatever board the ambient
  environment resolves to. Correct: `bounty add --session-key K -- "text"`.

**The sprint scoped to drain this queue — spell-hardening 06, "Filed is not
fixed" — is still a scaffold with no branch cut.** An earlier merge commit said
the gate work and the fix queue would "ship together". **That has not held for a
month (sprint 05 merged 2026-08-10), and this release ships without the fixes.**
See the header: the question of whether to keep waiting is Cole's, and the cost
of waiting has grown.
