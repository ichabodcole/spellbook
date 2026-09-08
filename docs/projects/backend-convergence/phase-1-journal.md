# Phase 1a journal — what held, what the design got wrong, what had to be found

**Date:** 2026-09-08 · **Branch:** `feat/backend-spine-phase-1` · **Agent:**
Claude Opus 5 (1M context), implementing under the orchestrator's brief.

Later phases roll this to five more spells and will be written from here, so
this is deliberately about the surprises, not the plan.

---

## The design held, with four changes

The drafted `tailEvents` signature survived contact with two real consumers. The
central decision — `resolve` as a callback rather than a captured URL — is worth
everything the design claims for it: astrolabe's B1 died without anyone fixing
it, and magpie's session-pointer re-read became the same parameter rather than a
second discovery model. Four changes were needed.

**1. `firstFrame` is gone; `render` and `accept` receive the FRAME.** The draft
gave `render` the event and a raw string and handed named non-data frames to a
separate `firstFrame` hook. That is two mechanisms for one thing, and the
"first" part is not the client's business: mind-mapper's grounding suppression,
magpie's grounding anchor and grapevine's grounding line are each a boolean the
CALLER closes over, in a callback the caller already owns. What the client must
supply is the parsed frame — the `event:` name included — because that is the
only thing a consumer cannot reconstruct. One hook, strictly more capable. It
also answers the design's own worry about grapevine needing a fifth escape
hatch: `subscribed` is not a special case of anything, it is a frame with a
name.

**2. `httpStatus: (status) => "retry" | "throw"` became
`onHttpError: (res) => "retry"`, and may throw.** A status number is not enough:
mind-mapper's refusal path reads the RESPONSE BODY to build its typed error. A
hook that receives the Response and is free to throw serves both, and it removes
a return value ("throw") that the client would have had to invent an error for.

**3. `onMalformed` was added.** The draft had no story for a data line that will
not parse. Five spells skip it silently, mind-mapper passes it through
untracked, grapevine writes a stderr note. One optional hook, defaulting to
skip, covers all three — and the place to write B8's warning (a permanently
malformed frame is re-delivered on every reconnect for the daemon's life,
because the cursor cannot advance past a frame nobody can read) is that hook's
doc comment.

**4. `die` throws.** Not in scope as drafted, and unavoidable in practice: see
D8 in the decision log. The tail could not honestly "return an exit code" while
sitting in a CLI where any `die` under it could still `process.exit` mid-stream.

## ⛔ The one thing that bit, and it was not in the tail

**Kit prose leaks Tailwind utilities into unrelated spells' shipped CSS, and the
ward that guards this has a declared blind spot the new modules walked straight
into.**

`src/kit/theme/base.css` declares `@source "../"`, so every comment in
`src/kit/` is a content source for every spell that adopts the kit stylesheet.
`grimoire/kit-prose-ward.test.ts` guards exactly this — and its `CLASS_TOKEN`
requires a structural marker (`-`, `:`, `/`, `[`), so SINGLE-WORD utilities are
outside its predicate. Its header says so, in the "what this cannot see" list.

Measured here, not reasoned: the words **"invisible"** and **"truncate"** in the
new modules' prose put `.invisible` into bounty's, digestify's and imago's
shipped stylesheets and `.truncate` into bounty's — three spells that share no
code with this and were not touched by the branch. The ward stayed GREEN; the
thing that caught it was `dist-check`'s reproduction arm going red on eleven
paths. The prose was reworded and the rebuild came back to exactly the two
intended `dist/cli.js` files.

**This is a real hole and it is now measured rather than hypothetical.** Two
things follow. Widening `CLASS_TOKEN` to include bare single-word utilities is
now motivated by evidence instead of caution — and it needs the vocabulary to be
derived, as the ward already derives its segment vocabulary, or it will red on
every occurrence of the word "table". And every module that lands in `src/kit/`
from here is a fresh chance to do this again, because the kit is about to grow.

## Smaller findings, in the order they were met

**A blanket `try` around a tail's read loop swallows the caller's own errors.**
The first draft wrapped the whole connection attempt — fetch, read, and every
consumer hook — in one `catch { /* reconnect */ }`. A hook that throws then
reads as a dropped connection and the tail reconnects forever: it spins silently
on an error nobody can see, which is the failure this client exists to remove.
Caught by its own unit cell (the refusal-hook test hung the suite). The `try`
now wraps `fetch` and `reader.read()` and NOTHING else, which is what all seven
hand-written loops did — a shape that looked accidental and was not.

**`bun test` on a hanging tail gives no output at all.** No partial results, no
test name, nothing on stdout until the process is killed. When a tail test
hangs, bisect it with a standalone script, not with the runner.

**The B1 test's second read continues the same stream.** `readLines` releases
its lock and a fresh reader picks up where it left off, so the post-restart
assertion sees ONLY the post-restart lines. Asserting `[1, 2]` there would have
been an assertion that could never pass; it was written as `[1, 2]`, failed for
that reason on the unfixed CLI, and had to be re-run after correction so the
fail-first evidence was about the defect and not about the harness.

**A restarted fake daemon can be handed back the port it just released.** The
test asserts the two ports differ and re-binds until they do; without that it
would have gone green against the unfixed CLI.

## The signature against all seven — the paper check

Done against each tail's source, not from the design's matrix.

| tail            | served      | how                                                                                                                                                 |
| --------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **astrolabe**   | ✅ adopted  | `resolve` = port-file re-read; `accept` = scope ∧ ¬self-echo; `terminal` = `closed`                                                                 |
| **magpie**      | ✅ adopted  | `resolve` = session-pointer re-read + pin + grounding; `onUnresolved` = the pinned-session-went-away exit                                           |
| **glamour**     | ✅          | magpie's shape exactly (it is the same fork line). B5's split backoff guard has no site to live in — there is one backoff path.                     |
| **imago**       | ✅          | ditto                                                                                                                                               |
| **bounty**      | ✅          | the richest of the fork line: `--mine` scoping and self-echo are both `accept`; session pinning is `resolve`'s closure                              |
| **mind-mapper** | ✅          | `epochOf`/`onEpochChange` are its; `livePort`'s pid-checked read is `resolve`; its 404/409 refusal is `onHttpError` throwing; B6/B7 die on adoption |
| **grapevine**   | ⚠ see below |                                                                                                                                                     |

**Grapevine — the verdict, stated as the brief asked.** Its four features are
served, and by fewer hatches than the design expected:

- `event: subscribed` → `render` receives the frame, which carries the name.
- the accumulating hint list and the grounding line → a closure in `render`.
- mutating every emitted frame (front-loading `full`/`truncation_hint` so the
  pointer survives a Monitor clip, capping under `--max`) → `render` returns the
  line, so it may return any line it likes.
- `--last N` on the first connect only → `query(cursor, firstConnect)`.
- `ensureDaemon()` inside the reconnect loop, which may spawn and may `die` →
  `resolve` is an arbitrary async callback that may do both, and its `die` is
  now a throw the caller decides about rather than an exit from three frames
  down.

**No fifth escape hatch was needed, so grapevine does NOT have to keep its own
loop.** One thing it loses and it should be named before Phase 3 rather than
discovered: grapevine writes a stderr line on EVERY reconnect
(`# stream closed, reconnecting…`, `# connect failed: …`), and the shared client
has no hook for "an attempt ended". That is one `onDisconnect?: (reason)` away,
and it is the only gap the paper check found across all seven. It was not added
here because neither adopting spell needs it and a hook nobody calls is a hook
nobody tests.

**What still cannot be served, unchanged from the design:** epoch resume is not
portable until five daemons stamp an epoch (the client carries the hook; that is
daemon-side work), and the two exit models both survive because `terminal` is
optional — which is the actual shape of the roster.

## For the phase that re-points `mind-mapper/scripts/tail.test.ts`

It was read as the specification and not touched, per the brief. Its four cells
map onto the shared client cleanly, and the unit cells here were written to
cover the same properties one level down — watchdog abort with cursor resume,
keepalives feeding the watchdog, first-connect-only grounding (as a `query`

- closure cell), and epoch change resetting the cursor. When they are
  re-pointed, the mapping is: `MIND_MAPPER_TAIL_IDLE_MS` → `idleMs`,
  `MIND_MAPPER_TAIL_RETRY_MS` → `retry.initialMs`. Neither astrolabe nor magpie
  took an env override for those; a spell whose tests drive a short window will
  need one, and it should be that spell's env var, not the kit's.

---

# Post-verification round

Written after the orchestrator's verification pass. The verifier built its own
B1 instrument and agreed; behaviour preservation was checked byte-for-byte on
both spells. Seven things came back, and what follows is what changed and what
was learned by fixing them.

## ⛔ The regression the phase nearly shipped: Ctrl-C during backoff

**Measured: 0.13s before, 2.80s after, and hammering Ctrl-C did not help.**

Installing a SIGINT listener SUPPRESSES the runtime's default terminate, so from
that moment whatever the client does on a signal is the WHOLE of what happens.
The client aborted the in-flight attempt — and every backoff was a bare
`setTimeout` with nothing wired to it, so a signal arriving during the sleep did
nothing at all until the timer ran out. The ceiling is `retry.maxMs`, and repeat
signals all hit the same sleeping timer, which is why hammering was useless.

⭐ **A tail spends most of a dead daemon's lifetime inside that sleep**, so it
is precisely the state a human interrupts. Fixed by making the backoff wakeable
from `stop()`. Re-measured the way the verifier measured it, against a session
pointer aimed at a dead port, three seconds in:

|                                                    | SIGINT → process exit |
| -------------------------------------------------- | --------------------- |
| control (a bare bun process with a SIGINT handler) | 0.12s                 |
| magpie, before                                     | 2.80s                 |
| magpie, after (source)                             | 0.117s                |
| magpie, after (built `dist/cli.js`, twice)         | 0.129s · 0.124s       |

**The lesson for the roll:** taking over a signal is not a neutral act. Any
`await` a converged client can be sitting in must be abortable, or the client
has made the process LESS interruptible than the hand-written loop it replaced.

## `err` was declared and never read, and finishing it answered the grapevine question

The orchestrator ruled the design's trip-wire is not tripped by a diagnostics
sink: the four named hatches are BEHAVIOURAL — they change what the client does
— while a sink changes only what the caller REPORTS, and `err` was in the
signature for exactly that. So `onDisconnect` is not a fifth hatch, and
grapevine does not keep its own loop.

Wired as ruled, and it went further than the ruling required, because once there
is a diagnostics sink the client must not be writing diagnostics anywhere else:

- `onComment` now RETURNS a line instead of writing one. Both adopters were
  writing their keepalive sentinel straight to `process.stderr` from inside a
  callback — which works, and means the client cannot be tested with a fake
  `err`, and means `out`/`err` are not actually the two streams.
- `onMalformed`'s returned line goes to `err`, not `out`. It is a note ABOUT the
  stream; stdout carries data. A spell that wants the unparsed line on stdout
  (mind-mapper does) writes it from inside the hook and returns null — stated in
  the hook's doc.
- `onDisconnect` carries `cause` + `error` + `status`, which covers all four of
  grapevine's lines: `connect-failed`, `http`, `stream-error`, `stream-end`.

There is now a cell asserting that stdout receives ONE data line while every
sentinel, malformed note and disconnect note lands on `err` — the property the
adopters' JSONL contract actually rests on.

## ⛔ B5 is wider than its write-up, and the write-up's branch is unreachable

Two findings from writing the cell the verifier asked for.

**1. `!res.body` cannot be reached from a Bun client.** Measured: Bun's `fetch`
hands the caller an empty-but-PRESENT body for
`new Response(null, {status: 200})` AND for a 204. So the guard B5 is written
about survives only as a types-level safety net, and the LIVE path for an empty
response is the read loop ending immediately.

**2. The reset was in the wrong place, in all seven loops.**
`delay = retry.initialMs` sat after a successful OPEN. An open that yields
nothing — exactly what a daemon mid-restart does — therefore reset the backoff
every time: a reconnect storm at a constant interval, which is B5's shape
reached through a different door. Driven: reset-at-open gives a constant 41ms
against a server that accepts and closes; reset-at-first-BYTE gives 40, 80, 160.

**And the fall-through path never grew the delay at all.** Every `continue`
branch doubled it; the path where a connection opened and then ended just slept.
Both are fixed, and they are a pair: the reset must move to the first byte or
growing the fall-through would slow a healthy tail that reconnects normally.

**So B5 is retired more thoroughly than claimed, and the claim was too narrow.**

## The watchdog was a constant decoupled from the thing it watches

`idleMs: 45_000` was hard-coded in both CLIs. astrolabe's daemon heartbeat is
`ASTROLABE_HEARTBEAT_MS`, env-tunable and clamped only to half the idle timeout
— a ceiling of 127.5s at defaults. Any value above 45,000 put the tail in a
permanent abort/reconnect cycle; the verifier drove it and saw reconnects at
+47.4s, +92.6s and +137.9s against a healthy daemon. It was harmless only
because `PRESENCE_DEBOUNCE_MS` happened to absorb the churn — a third constant
with no relationship to either.

Both CLIs now DERIVE `idleMs` from the same heartbeat expression their own
daemon uses (astrolabe mirrors the clamp; magpie's daemon heartbeats on a
literal 15,000 with no override). The mirroring is by hand and says so: a CLI
cannot import its daemon without dragging the whole server graph into
`dist/cli.js`. **That pair is a Phase 1b deliverable** — one exported constant,
daemon-side, is exactly what the shared spine is for.

## Record, do not fix

**The epoch gap is now OBSERVABLE in astrolabe, and it was not before.** After a
daemon restart the tail resumes at `since=<last seen>` against a daemon whose
event ids restart at 1, so the new daemon's early frames — its `ready` at id 1 —
are never delivered. This is not a regression: the old tail delivered NOTHING
after a restart, because it was still dialling a dead port. **B1's repair is
what makes the gap reachable for the first time.** It is the design's named
daemon-side dependency (a daemon must stamp an epoch before `epochOf` can do
anything), and it is a Phase 1b input: astrolabe's event log needs an epoch, and
then astrolabe's tail gets `epochOf`/`onEpochChange` for free.

## Three things the adoption playbook MUST say

Written here because the next five spells inherit them.

1. **DELETE the spell's own signal handler.** `tailEvents` installs its own and
   removes them on return, but it does NOT remove the caller's. A spell that
   adopts the client and keeps its `process.on("SIGINT", () => process.exit(0))`
   still discards undrained stdout on Ctrl-C — B3 survives the adoption, and
   silently, because the two handlers both run and the exiting one wins.
2. **DERIVE `idleMs` from that spell's own daemon heartbeat**, never copy
   45,000. The number is meaningless except as a multiple of the heartbeat.
3. **`exit-site-inventory` coverage goes to zero for an adopter**, and will for
   all seven. That is correct — the shared client contains no `process.exit(` by
   construction — but it must be recorded in the ward's prose each time rather
   than showing up as eight silently deleted rows.

## The ward, fixed rather than noted

The kit-prose ward now has a BARE half: a closed, enumerable list of Tailwind's
single-word utilities, cut out of the text by the same extractor the structural
half uses. The two halves disagree about method — derived vocabulary there, list
here — and that is a property of the mechanism: `bg-teal-500` is unbounded by
construction, single-word utilities are not.

It was calibrated by the tree rather than by a fixture: switched on, it
immediately red on a live occurrence in `src/kit/ui/Dot.tsx` that predates this
branch. Six kit files were reworded (`inline` → bundle, `filter` → predicate,
`invisible` → opaque, `truncate` → cut short, `block` → hang, `fixed` →
repaired), including two outside this phase's modules. **The rebuild after that
is byte-identical for every spell's CSS** — the occurrences that were harmless
stayed harmless — so the ward is now stricter than the mechanism in exactly the
way its structural half already is.
