# Convergence design: the SSE tail reader, seven implementations of one client

**Date:** 2026-09-08 · **Status:** design closed; feeds the backend convergence
project · **Follows:**
[the duplication recon](./2026-09-08-backend-duplication-recon.md)

## Correction to the recon

There are **seven**, not six. `bounty/scripts/cli.ts`'s `cmdTail` was counted
under the error-contract cluster and missed here; it is the richest of the
"imago fork line" variants — scoping _and_ self-echo _and_ session pinning — and
a design drawn against six would find bounty's `--mine` scope arriving late.

The browser side is not an eighth: only `src/grapevine/surface/state/feed.ts`
reads SSE, via the platform `EventSource`. Every other surface is WebSocket or
polling.

_(The recon also cites glamour's `cmdTail` at `:1269`; it is at `:621` since the
surface relocation. Corrected there.)_

## The two decisions that make one client possible

**1. "Where is the daemon" must be a callback, not a URL.** That single change
unifies four incompatible discovery models — session-pointer re-read
(glamour/imago/magpie/bounty), pid-checked port file (mind-mapper),
respawn-if-absent (grapevine) — and repairs astrolabe by construction, since its
bug is precisely that it resolves the base once.

**2. The client never calls `process.exit`; it returns an exit code.** Five
copies of the `P0f SHAPE B` comment block exist because five sites each had to
prove locally that a `return` escapes three nested loops. A client that returns
a code makes that proof once.

## The signature

```ts
async function tailEvents<Ev>(opts: {
  // WHERE — called before EVERY connect attempt; never captured
  resolve: () => Endpoint | null | Promise<Endpoint | null>;
  onUnresolved?: (s: { everConnected: boolean }) => "retry" | "stop";

  // WHAT — cursor and per-attempt query
  path: string;
  since: number;
  cursorOf: (ev: Ev) => number | undefined; // ev.id | ev.seq | payload.id
  cursorPolicy?: "monotonic" | "assign";
  query?: (cursor: number, firstConnect: boolean) => Record<string, string>;

  // EPOCH — opt-in; requires a daemon that stamps one
  epochOf?: (ev: Ev) => string | undefined;
  onEpochChange?: (next: string) => string | null;

  // FILTER and SHAPE
  accept?: (ev: Ev, raw: string) => boolean; // scope ∧ ¬self-echo
  render?: (ev: Ev, raw: string) => string | null;
  firstFrame?: (frame: Frame, ev: Ev | null) => string | null; // grounding

  // END
  terminal?: (ev: Ev) => boolean;
  terminalEmitsFiltered?: boolean;

  // TRANSPORT HEALTH
  idleMs?: number; // default 45_000; 0 disables
  retry?: { initialMs: number; maxMs: number }; // default {250, 5000}
  httpStatus?: (status: number) => "retry" | "throw";
  onComment?: (text: string) => void;

  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
  signal?: AbortSignal;
}): Promise<number>;
```

Non-negotiable internals: SSE parsing per the spec algorithm (below);
AbortController per attempt with the watchdog **reset on every raw chunk before
frame parsing** (comments must feed the watchdog even though the data filter
discards them); backoff reset on a successful open; the cursor advanced on
**every** event including filtered ones.

## The `"data: "` question, resolved

Both sides are non-conformant, and neither is currently wrong in production.

The spec (WHATWG HTML, _Interpreting an event stream_): split each line at the
**first** colon; if the value begins with **exactly one** U+0020, remove that
one space; append each `data` value plus `"\n"`, then strip the final newline.

- Every house daemon emits `data: ` **with** the space and one data line per
  frame — verified at every emit site across all seven. **The difference is
  latent, not live.**
- **mind-mapper's `startsWith("data: ")` is the more dangerous error.** A
  spec-legal `data:{…}` matches nothing, so the frame is silently dropped **and
  the cursor does not advance**. It also keeps only the first data line.
- **The other six's `.slice(5).trim()` is the more forgiving error.** It accepts
  both forms but strips _all_ whitespace rather than one leading space, which
  would corrupt a multi-line payload with meaningful indentation.

**The converged client must do neither**: split on the first colon, strip at
most one leading space, accumulate with `"\n"`. That is simultaneously
spec-correct and byte-compatible with all seven daemons — the rare case where
the right answer costs nothing.

Nobody implements `id:` / Last-Event-ID / `retry:`. That is a coherent house
choice — resume is a query-param cursor — and should be **stated** as such
rather than fixed.

## The call site that stresses the design hardest

**grapevine's `cmdTail`.** It is the only one that branches on a named non-data
frame (`event: subscribed`), composes its grounding line from that frame plus an
accumulating hint list, **mutates every emitted frame** (front-loading
`full`/`truncation_hint` so the pointer survives a Monitor clip, capping under
`--max`), sends `--last N` on the first connect only, and calls `ensureDaemon()`
inside the reconnect loop — which may spawn a daemon and may `die()`.

All five are served by `firstFrame` receiving the raw frame, `render`,
`query(cursor, firstConnect)`, and `resolve` being an arbitrary async callback.
The last is _improved_: a `die()` reachable from inside a reconnect loop becomes
a thrown error the caller decides about.

**Stated honestly up front:** grapevine's tail is where four independent
features live, each with a scar comment beside the frame it acts on. Pushing
them into `accept`/`render`/`firstFrame` moves that reasoning away from the
parse. **If serving grapevine ever needs a fifth escape hatch, the correct
answer is that grapevine keeps its own loop and adopts only the frame parser and
the reconnect policy.**

## What cannot be served

- **Epoch resume is not portable today.** It is a different resume contract, not
  extra robustness, and it requires the daemon to stamp an epoch. Five daemons
  hold the log in memory and restart `id` at 1 with no marker, so a client
  resuming from a saved cursor goes silent until the counter catches up. The
  client can carry the hook; **those spells cannot use it until their daemons
  emit an epoch.** That is daemon-side work and a named dependency.
- **Astrolabe's `join` pays for the watchdog.** Holding the connection open _is_
  its presence signal, so every watchdog fire flaps a card in a human's view. It
  still wants the watchdog — a wedged half-open connection shows a card as
  permanently present, which is worse — but `idleMs` must stay well above the
  heartbeat. This is the one place the convergence is visible to a person.
- **Two exit models must both survive.** Five terminate on a `closed` frame;
  mind-mapper and grapevine run forever and have no terminal frame. `terminal`
  being optional is the actual shape of the roster, not a hedge.

## ⚠ The acceptance criteria already exist

`mind-mapper/scripts/tail.test.ts` is **the only executable specification of
tail behaviour in the repo** — four behavioural tests over the watchdog, abort
and epoch. **They must be re-pointed at the shared client, not rewritten.**

## Live defects — again, acceptance criteria rather than a work queue

Per the same 2026-09-08 ruling, these are not separate fix branches.

| #   | defect                                                                                                                                                                                                                                           | broken in                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| B1  | the tail resolves the daemon base **once** and reconnects to that fixed port forever; astrolabe binds an ephemeral port, so `join` — the verb designed to run for hours carrying presence — spins silently against a dead port after any restart | astrolabe                        |
| B2  | no idle watchdog: `await reader.read()` with no timeout parks forever on a half-open socket after laptop sleep, NAT rebind or a `SIGKILL`ed daemon                                                                                               | six of seven                     |
| B3  | the P0f drain fix was applied to the `closed` frame but **not to the signal handler** — Ctrl-C on a tail piped into Monitor discards undrained stdout. The bug sits twelve lines above its own fix                                               | six of seven                     |
| B4  | EPIPE unhandled, so `<spell> tail \| head` dies instead of exiting 0                                                                                                                                                                             | six of seven (magpie handles it) |
| B5  | a 200-with-no-body sleeps without growing the backoff — a fixed 250ms reconnect storm. Glamour split the sibling guard in two and the second half lost the growth line                                                                           | glamour                          |
| B6  | spec-legal `data:` frames silently dropped **without advancing the cursor**; multi-line data truncated to its first line                                                                                                                         | mind-mapper                      |
| B7  | the cursor **assigns** rather than taking a max, so a replayed or out-of-order frame regresses it and the next reconnect re-requests seen events. No comment, no test — somebody has to rule what was intended                                   | mind-mapper                      |
| B8  | _(low confidence)_ a permanently-malformed frame is skipped without advancing the cursor, so it is re-delivered on every reconnect for the daemon's life. Constructed from code shape; no reproduction                                           | five                             |

B1 and B5 were verified independently by the orchestrator.

## Coverage

**Read in full:** `src/astrolabe/backend/cli.ts`;
`mind-mapper/scripts/tail.test.ts`.

**Read in full over the tail region, grepped elsewhere:** glamour, imago,
magpie, mind-mapper, grapevine and bounty CLIs — roughly 40% of mind-mapper's
CLI, 15% of grapevine's, and only the tail of bounty's.

**Targeted daemon-side reads** solely to settle the wire format: every `data: `
emit site across all seven daemons, every keepalive interval, astrolabe's
`sseResponse` (establishing that its `project` param binds presence and does
**not** filter), and grapevine's `since`/`last` semantics.

**Not read:** the non-tail majority of the glamour, grapevine and bounty CLIs
(~85%, ~85%, ~95%) — a grep for `getReader`/`data:`/`/events` across all seven
found no eighth tail, which bounds but does not eliminate the risk.

**Weakest claims:** B8 (no reproduction), and the `stale` verdict on the missing
grounding line in astrolabe and bounty — it reads as fork-order drift from the
comment vintages, but no commit archaeology was run.
