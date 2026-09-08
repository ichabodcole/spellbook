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
