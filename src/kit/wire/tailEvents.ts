/**
 * The house's ONE SSE tail client — the standing, self-healing read loop every
 * spell's `tail`/`join` verb runs.
 *
 * ⛔ THE KIT IS A LEAF. Nothing here may import out of `src/kit/` — ward 2's
 * assertion, and it is what makes this module safe to bundle into any spell's
 * bundle. It reaches for nothing, not even the sibling error contract.
 *
 * Designed against all seven of the house's hand-written tails (the convergence
 * design, `docs/investigations/2026-09-08-tail-reader-convergence.md`) and
 * adopted first by astrolabe and magpie.
 *
 * ── THE TWO DECISIONS THAT MAKE ONE CLIENT POSSIBLE ─────────────────────────
 *
 * **1. "Where is the daemon" is a CALLBACK, not a URL.** `resolve` is called
 * before EVERY connect attempt and its answer is never captured. That single
 * change unifies four incompatible discovery models — session-pointer re-read,
 * pid-checked port file, respawn-if-absent — and it repairs a defect by
 * construction rather than by anyone fixing it: astrolabe resolved its daemon
 * base ONCE and reconnected to that one captured port forever, so `join` — the verb
 * designed to run for hours carrying presence — spun silently against a dead
 * port after any daemon restart, and astrolabe binds an ephemeral port.
 *
 * **2. This client NEVER calls `process.exit`. It RETURNS an exit code.** See
 * the scar below; that is the whole of it.
 *
 * ── ⛔ THE SCAR: P0f, SHAPE B — RE-HOMED HERE, WRITTEN ONCE ─────────────────
 *
 * Five spells each carried a copy of this paragraph, because five sites each
 * had to prove LOCALLY that ending a tail does not cut its own last line short.
 * It documents a 23-minute hang that shipped. The reasoning now lives in one
 * place; the copies are gone, and this is what they said.
 *
 * Bun's stdout is ASYNCHRONOUS on a pipe (synchronous on a TTY or a file). An
 * explicit `process.exit()` therefore discards whatever has not drained —
 * measured at exactly 65,536 bytes, one pipe buffer. The payload is complete
 * and only the write is lost, so a caller receives well-formed-LOOKING JSON
 * that stops mid-string. Measured, Bun 1.3.14, 300KB writes:
 *
 *     write(big, cb -> exit)                    ✅ 300001 bytes arrive
 *     await Bun.write(Bun.stdout, big)          ✅
 *     natural return, process.exitCode          ✅
 *     write(big); write("", cb -> exit)         ❌ 65536
 *     5x write(big); write("", cb -> exit)      ❌ exactly 5x65536
 *
 * ⛔ The last two rows are why a trailing `write("", cb)` is NOT a barrier: a
 * drain callback covers ONLY ITS OWN WRITE. That is exactly the helper a
 * write-then-exit shape invites, and it measured byte-for-byte as broken as no
 * fix at all. Do not reintroduce it.
 *
 * The five copies then each had to establish a PER-SITE PRECONDITION — whether
 * a `return` escapes the three nested loops (outer reconnect, inner read, frame
 * drain) or merely falls through into another retry. They did not agree: two
 * needed an explicit `return`, one needed a `stopped` flag as well, and
 * astrolabe's site could `return` only because its caller returned straight
 * after. ⭐ **RETURNING AN EXIT CODE RETIRES THAT QUESTION ENTIRELY.** There is
 * one loop now; it breaks to one place; the caller assigns `process.exitCode`
 * and returns naturally, and the runtime drains stdout before the process ends.
 * Nothing here needs to know what its caller does next.
 *
 * That also repairs a defect the copies shared: the drain fix was applied to
 * the terminal frame but NOT to the signal handler twelve lines above it, so
 * Ctrl-C on a tail piped into a reader discarded undrained stdout. Same loop,
 * same exit path, one answer.
 *
 * ⚠ NOT re-homed INTO THIS MODULE, deliberately: mind-mapper's measured Bun
 * 1.3.14 finding that `controller.enqueue()` on an orphaned stream never throws.
 * It is a DAEMON-side fact about dead-socket detection and bears on
 * `sseResponse`, not on any client.
 *
 * ⛔ AND IT DID GET A HOME — SAY SO, BECAUSE THIS SENTENCE USED TO END "it stays
 * where it was measured" AND THAT IS FALSE. Read at port time it pointed a
 * reader at `mind-mapper/scripts/server.ts`, a file whose local `sseResponse`
 * the backend port might replace, so the measurement looked at risk. It was
 * not: the daemon half landed in `./sse.ts` the same day, under its own heading
 * ("THE SCAR, RE-HOMED: `try { enqueue } catch` DOES NOT DETECT A DEAD
 * CLIENT"), with the teardown-funnel ruling and the same known hole.
 *
 * ⚠ **AND THE PORT HAS SINCE HAPPENED, WHICH SETTLES IT.** mind-mapper's daemon
 * is now `src/mind-mapper/backend/server.ts` and it DID replace its local
 * `sseResponse` with `./sse.ts`'s (Phase 7, 2026-09-09) — so the only copies of
 * that measurement are the kit's and the two test files that PROVE it,
 * `src/mind-mapper/backend/presence.test.ts` and `sse-keepalive.test.ts`. The
 * risk this paragraph described is closed, in the direction it hoped for.
 *
 * The general shape, worth the four lines (D83): a refusal recorded in ONE
 * module's header cannot be read from the module it points AT. When a refusal
 * names another module as the right home, say whether it got there.
 *
 * ── THE WIRE FORMAT, AND THE `"data: "` QUESTION RESOLVED ───────────────────
 *
 * Per WHATWG HTML, "Interpreting an event stream": split each line at the FIRST
 * colon; if the value begins with EXACTLY ONE space, remove that one space;
 * append each data value plus a newline, then strip the final newline.
 *
 * The house's seven tails split into two non-conformant camps, and neither is
 * currently wrong in production, because every house daemon emits one data line
 * per frame WITH the space:
 *
 *   • `startsWith("data: ")` — the more dangerous error. A spec-legal
 *     `data:{...}` matches nothing, so the frame is silently dropped AND THE
 *     CURSOR DOES NOT ADVANCE. It also keeps only the first data line.
 *   • `.slice(5).trim()` — the more forgiving error. It accepts both forms but
 *     strips ALL whitespace rather than one leading space, which would corrupt
 *     a payload with meaningful indentation.
 *
 * This client does neither. Spec-correct is simultaneously byte-compatible with
 * all seven daemons — the rare case where the right answer costs nothing.
 *
 * `id:` / Last-Event-ID / `retry:` are NOT implemented, and that is a stated
 * house choice rather than an omission: resume is a query-param cursor, so the
 * server's replay window and the client's `since` are the one mechanism.
 */

/** One parsed SSE frame. `event` defaults to "message" per the spec. */
export type SseFrame = {
  event: string;
  /** The accumulated `data` value: fields joined with "\n", final newline stripped. */
  data: string;
};

/** A writable sink. Narrow on purpose — `process.stdout` and a test double
 *  both satisfy it, and the kit may not name a node type it does not import. */
export type Sink = { write(chunk: string): unknown };

export type TailOptions<Ev> = {
  // ── WHERE ────────────────────────────────────────────────────────────────
  /**
   * The daemon's base URL (no trailing slash), or `null` when it cannot be
   * found right now. ⛔ CALLED BEFORE EVERY CONNECT ATTEMPT AND NEVER CAPTURED
   * — a tail outlives the daemon it started against, and a captured base is
   * the defect this parameter exists to make unreachable. It may re-read a
   * pointer file, probe liveness, or spawn; it may throw, and the throw is the
   * caller's to answer (which is strictly better than a `die` reachable from
   * inside a reconnect loop).
   */
  resolve: () => string | null | Promise<string | null>;
  /**
   * What to do when `resolve` says "not found". Default `"retry"` forever.
   * `"stop"` ends the tail at exit code 0 — the shape a spell wants when the
   * session it PINNED has gone away, which is a completed watch and not a
   * failure. The flags distinguish "never found one" from "had one, lost it".
   */
  onUnresolved?: (s: { everResolved: boolean; everConnected: boolean }) => "retry" | "stop";

  // ── WHAT ─────────────────────────────────────────────────────────────────
  /** Path on the daemon, e.g. `"/events"`. Joined to `resolve`'s answer. */
  path: string;
  /** The starting cursor. Sent as `since` unless `query` says otherwise. */
  since: number;
  /** Read the cursor off an event (`ev.id`, `ev.seq`, `payload.id`, …). */
  cursorOf?: (ev: Ev) => number | undefined;
  /**
   * `"monotonic"` (default) takes the max, so a replayed or out-of-order frame
   * cannot regress the cursor and make the next reconnect re-request events
   * already seen. `"assign"` takes the value as given — available because one
   * spell does that today and nobody has ruled whether it was intended.
   */
  cursorPolicy?: "monotonic" | "assign";
  /** Per-attempt query parameters. Default `{ since: String(cursor) }`.
   *  `firstConnect` is what lets a `--last N` window ride the first connection
   *  only, never re-backfilling on a reconnect. */
  query?: (cursor: number, firstConnect: boolean) => Record<string, string>;

  // ── EPOCH (opt-in; requires a daemon that stamps one) ─────────────────────
  /** Read the daemon's epoch off an event. */
  epochOf?: (ev: Ev) => string | undefined;
  /** A reconnect landed on a DIFFERENT epoch: the daemon restarted, so the
   *  cursor resets to 0. Return a line to emit (a synthesized notice, never a
   *  bus event) or null.
   *
   *  ⛔ AND WHEN THE NEW LOG WAS ALREADY PAST THE BOOKMARK, THE CLIENT
   *  RECONNECTS FROM ITS START. A daemon that believes the cursor sends only
   *  what lies above it, so the new log's early frames — a human message at
   *  new id 2 under an old bookmark of 4 — were skipped silently. Everything in
   *  a new epoch is new to this reader, so the attempt is dropped and re-made
   *  from 0 at once (no backoff). A frame AT or below the asked cursor means
   *  the daemon is already replaying whole, and is kept. (Reviewer's D2 gap,
   *  feat/tail-quiet-handoff.) */
  onEpochChange?: (next: string) => string | null;
  /** The epoch the starting `since` came from, when the caller has one (a
   *  bookmark printed as `N@<epoch>`, `./tailHandoff.ts`). The first frame of a
   *  different epoch is then an epoch change like any other — which is what
   *  stops a bookmark outliving its log across processes. */
  sinceEpoch?: string;
  /**
   * Read a frame whose id is AT OR BELOW the cursor this connection asked
   * from as "the log restarted", reset the cursor to 0, and call
   * `onEpochChange` (with the frame's epoch, or `"unknown"`). Default false.
   *
   * ⛔ WHY IT IS HONEST: the kit's event log answers a cursor beyond its own
   * by replaying WHOLE (`./eventLog.ts`, point 3), and otherwise sends only
   * ids above the cursor. So a frame at or below the asked cursor exists only
   * when the daemon judged the cursor foreign — a restarted daemon, whose ids
   * began again at 1. The epoch catches that WITHIN one process; this catches
   * it ACROSS processes, where a re-armed tail carries a bookmark from a log
   * that no longer exists and, without it, kept that bookmark forever: every
   * re-arm replayed the whole new log, and a `--once` woke at once, in a loop
   * (found by the verifier on feat/tail-quiet-handoff, after `tail.lost` →
   * `open --restore`).
   *
   * ⚠ ONLY FOR A DAEMON ON THE KIT'S EVENT LOG. Grapevine's ids are recovered
   * across a restart and its `--last` query overrides `since`, so it leaves
   * this off. And the blind spot is stated: a bookmark that happens to be at
   * or below the RESTARTED log's own length looks valid to the daemon, which
   * then sends only what lies above it. The come-back path therefore drops
   * the bookmark altogether (`./tailHandoff.ts`, D2), so this is the net, not
   * the rule.
   */
  restartOnReplay?: boolean;

  // ── FILTER and SHAPE ─────────────────────────────────────────────────────
  /** Scope ∧ ¬self-echo. A rejected event still ADVANCES THE CURSOR. */
  accept?: (ev: Ev, frame: SseFrame) => boolean;
  /** The line to write for an accepted event, or null to write nothing.
   *  Default: the frame's data verbatim. Receives the frame, so a client that
   *  branches on a named non-data frame (`event: subscribed`) is served here
   *  rather than needing a hatch of its own. */
  render?: (ev: Ev, frame: SseFrame) => string | null;
  /**
   * A frame whose data will not parse. Default: skip it. ⛔ THE RETURNED LINE
   * GOES TO `err`, NOT `out` — it is a diagnostic about the stream, and stdout
   * carries data. A spell that genuinely wants the unparsed line on stdout
   * (one does) writes it from inside this hook and returns null.
   *
   * ⚠ The cursor cannot advance past a frame nobody can read, so a PERMANENTLY
   * malformed frame is re-delivered on every reconnect for the daemon's life.
   */
  onMalformed?: (frame: SseFrame, error: unknown) => string | null;

  // ── END ──────────────────────────────────────────────────────────────────
  /** The frame that ends the watch (a `closed` lifecycle event). Optional, and
   *  that is the actual shape of the roster rather than a hedge: some tails run
   *  forever and have no terminal frame at all. `accepted` is `accept`'s
   *  verdict on this frame, which is what lets `tail --once` end on the first
   *  frame it actually DELIVERS (`./tailHandoff.ts`).
   *
   *  ⛔ A TERMINAL FRAME CLOSES THE CONNECTION before the client returns. It
   *  used to return from inside the read loop with the SSE stream still open,
   *  which kept the process alive — unseen for `closed`, because the server
   *  ends that stream itself, and fatal for `--once`, whose background task
   *  would never exit and so never wake the agent. (Adjustment 1 of the
   *  Monitor-expiry spike; pinned in `tailHandoff.test.ts`.) */
  terminal?: (ev: Ev, frame: SseFrame, accepted: boolean) => boolean;
  /** Emit the terminal frame even when `accept` rejected it. Default false. */
  terminalEmitsFiltered?: boolean;

  // ── TRANSPORT HEALTH ─────────────────────────────────────────────────────
  /**
   * The idle watchdog, in ms. Default 45_000 ≈ three missed 15s heartbeats.
   * 0 disables it. Without one, `await reader.read()` parks FOREVER on a
   * half-open socket after laptop sleep, a NAT rebind, or a SIGKILLed daemon.
   *
   * ⚠ Hold it well above the daemon's heartbeat. Where holding the connection
   * open IS the presence signal, every watchdog fire flaps a card in a human's
   * view — that is the one place this convergence shows up for a person. It
   * still wants the watchdog: a wedged half-open connection shows a card as
   * permanently present, which is worse.
   */
  idleMs?: number;
  /** Reconnect backoff. Default `{ initialMs: 250, maxMs: 5000 }`; doubles on
   *  every failed attempt and RESETS on a successful open. A branch that sleeps
   *  without growing the delay is a constant-interval reconnect storm — that is a
   *  live defect in one spell today, and there is one code path here. */
  retry?: { initialMs: number; maxMs: number };
  /** A non-2xx response. Default: retry with backoff. May throw — a refused
   *  connection (an unknown project, a store that needs one) is a usage error,
   *  not a transport blip, and retrying it forever just spins silently. */
  onHttpError?: (res: Response) => "retry" | Promise<"retry">;
  /** A `:` comment line (a keepalive). Return a line for `err` — the sentinel
   *  that lets a `2>&1` consumer tell "idle" from "wedged" — or null.
   *  ⛔ Comments FEED THE WATCHDOG even though only data frames survive the
   *  selection below — that is handled here, before this hook is called. */
  onComment?: (text: string) => string | null;
  /**
   * One connection attempt ended. Return a line for `err`, or null.
   *
   * ⛔ THIS IS A DIAGNOSTICS SINK, NOT A FIFTH ESCAPE HATCH — and the
   * distinction is a ruling, not a preference. The hatches this client offers
   * (`accept`, `render`, `query`, `resolve`) are BEHAVIOURAL: they change what
   * the client DOES. This one changes only what the CALLER REPORTS, which is
   * what `err` was in the signature for. The design's trip-wire — "a fifth
   * escape hatch means grapevine keeps its own loop" — is not tripped by it.
   *
   * It exists because a tail that reconnects in silence is indistinguishable
   * from a tail that is working, and one spell writes four distinct lines here.
   * `cause` says which; `error` and `status` carry what the line needs.
   */
  onDisconnect?: (info: {
    cause: "connect-failed" | "http" | "no-body" | "stream-error" | "stream-end";
    error?: unknown;
    status?: number;
  }) => string | null;

  // ── PLUMBING ─────────────────────────────────────────────────────────────
  /** Where DATA goes. Default `process.stdout`. */
  out?: Sink;
  /** Where DIAGNOSTICS go — keepalive sentinels, disconnect notes, unparseable
   *  frames. Default `process.stderr`. Never mixed with `out`: a caller reading
   *  our stdout with a line-delimited parser must never meet a note. */
  err?: Sink;
  /** Caller-owned abort. Aborting ends the tail at exit code 0. */
  signal?: AbortSignal;
  /**
   * Install SIGINT/SIGTERM handlers that end the tail cleanly (default true).
   * ⛔ They end it by RETURNING, not by exiting — see the P0f scar: a signal
   * handler that calls `process.exit` discards undrained stdout, which is the
   * half of the fix five spells did not apply.
   */
  signals?: boolean;
  /**
   * Called once as the tail ends, with the final cursor (the bookmark a re-arm
   * passes as `--since`) and why it ended. A REPORT SINK like `onDisconnect`,
   * not a behavioural hatch: it changes nothing the client does. It exists
   * for `./tailHandoff.ts`, whose last line names the re-arm and must carry
   * the cursor exactly as this loop left it, epoch resets included.
   */
  onEnd?: (end: {
    cursor: number;
    /** The epoch of the log the cursor belongs to, when the daemon stamps one. */
    epoch: string | null;
    reason: "terminal" | "unresolved" | "stopped";
  }) => void;
};

const DEFAULT_IDLE_MS = 45_000;
const DEFAULT_RETRY = { initialMs: 250, maxMs: 5000 };

/**
 * Parse a complete SSE frame body (the text between blank lines) per the spec's
 * "Interpreting an event stream": split at the FIRST colon, strip AT MOST ONE
 * leading space from the value, accumulate `data` fields with "\n".
 *
 * Returns null for a comment-only frame; `comments` carries their text so the
 * caller can surface a keepalive sentinel.
 */
export function parseSseFrame(block: string): {
  frame: SseFrame | null;
  comments: string[];
} {
  const comments: string[] = [];
  const dataLines: string[] = [];
  let event = "message";
  let sawData = false;

  for (const line of block.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(":")) {
      comments.push(line.slice(1));
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
      sawData = true;
    } else if (field === "event") {
      event = value;
    }
    // `id:` and `retry:` are deliberately ignored — see the header.
  }

  if (!sawData) return { frame: null, comments };
  return { frame: { event, data: dataLines.join("\n") }, comments };
}

/**
 * Run a standing SSE tail until it ends, and return the process exit code.
 *
 * ⛔ IT NEVER CALLS `process.exit`. The caller does `process.exitCode = await
 * tailEvents(...)` and returns naturally. See the P0f scar in this file's
 * header for why that is the whole design and not a style preference.
 */
export async function tailEvents<Ev>(opts: TailOptions<Ev>): Promise<number> {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const cursorPolicy = opts.cursorPolicy ?? "monotonic";

  let cursor = opts.since;
  let epoch: string | null = opts.sinceEpoch ?? null;
  let everResolved = false;
  let everConnected = false;
  let firstConnect = true;
  let delay = retry.initialMs;
  let code = 0;
  let ending: "terminal" | "unresolved" | "stopped" = "stopped";

  // One stop switch for every way this loop can end: a signal, a caller's
  // abort, a downstream reader closing our stdout. Each sets it, aborts the
  // in-flight attempt AND WAKES THE BACKOFF; the loop then falls out and
  // RETURNS.
  //
  // ⛔ WAKING THE BACKOFF IS NOT A DETAIL — IT IS THE Ctrl-C PATH. Installing a
  // SIGINT listener SUPPRESSES the runtime's default terminate, so whatever
  // this client does on a signal is now the whole of what happens. A first
  // version aborted the attempt and left the reconnect sleeping on a bare
  // timer: Ctrl-C during backoff took up to `retry.maxMs` instead of ending at
  // once, measured at 2.80s against a dead port where the hand-written loop
  // took 0.13s — and hammering Ctrl-C did not help, because every repeat hit
  // the same sleeping timer. A tail spends most of a dead daemon's lifetime
  // inside this sleep, so that is the state a human interrupts.
  let stopped = false;
  let attempt: AbortController | null = null;
  let wakeBackoff: (() => void) | null = null;
  const stop = (exitCode: number) => {
    stopped = true;
    code = exitCode;
    attempt?.abort();
    wakeBackoff?.();
  };

  /** Sleep, but return AT ONCE if the tail is stopped meanwhile. */
  const backoff = (ms: number): Promise<void> =>
    new Promise<void>((resolveSleep) => {
      if (stopped) return resolveSleep();
      const finish = () => {
        clearTimeout(timer);
        wakeBackoff = null;
        resolveSleep();
      };
      const timer = setTimeout(finish, ms);
      wakeBackoff = finish;
    });

  const onSignal = () => stop(0);
  const useSignals = opts.signals !== false;
  if (useSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  // A downstream `head`/reader closing our stdout is a completed read, not a
  // crash: end at 0 instead of dying on EPIPE.
  const onOutError = (e: unknown) => {
    if ((e as NodeJS.ErrnoException | undefined)?.code === "EPIPE") stop(0);
  };
  const outEmitter = out as unknown as {
    on?: (ev: string, fn: (e: unknown) => void) => void;
    off?: (ev: string, fn: (e: unknown) => void) => void;
  };
  outEmitter.on?.("error", onOutError);

  const onCallerAbort = () => stop(0);
  opts.signal?.addEventListener("abort", onCallerAbort);
  if (opts.signal?.aborted) stop(0);

  const emit = (line: string) => {
    out.write(`${line}\n`);
  };
  /** Every diagnostic the client produces goes here and NOWHERE else, so a
   *  caller parsing our stdout never meets a note about our stdout. */
  const note = (line: string | null | undefined) => {
    if (line !== null && line !== undefined) err.write(`${line}\n`);
  };

  try {
    while (!stopped) {
      // ⚠ DELIBERATELY UNGUARDED. `resolve` may spawn, probe, or raise a
      // taxonomy failure, and that throw is the CALLER's to answer — which is
      // strictly better than the copies' shape, where a `die` was reachable
      // from inside a reconnect loop and ended the process from three frames
      // down.
      const base = await opts.resolve();
      // ⛔ A STOP THAT LANDED WHILE `resolve` WAS AWAITED (the handoff's window,
      // a signal) found no attempt to abort. Without this check the loop went
      // on to fetch, skipped the read, and returned with that stream still
      // open — which keeps a process alive exactly like the terminal-frame
      // hang. (Suspected by the reviewer, pinned in `tailHandoff.test.ts`.)
      if (stopped) break;
      if (base === null) {
        const verdict = opts.onUnresolved?.({ everResolved, everConnected }) ?? "retry";
        if (verdict === "stop") {
          ending = "unresolved";
          return code;
        }
        await backoff(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      everResolved = true;

      const params = opts.query?.(cursor, firstConnect) ?? {
        since: String(cursor),
      };
      // What this connection asked from, for `restartOnReplay`.
      const askedSince = cursor;
      let restartNoted = false;
      // Set when an epoch change finds the new log past the bookmark.
      let fromTop = false;
      const qs = new URLSearchParams(params).toString();
      const url = `${base}${opts.path}${qs ? `?${qs}` : ""}`;

      attempt = new AbortController();
      const controller = attempt;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const resetWatchdog = () => {
        if (idleMs <= 0) return;
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), idleMs);
      };

      // ⛔ THE TRY IS AROUND THE TRANSPORT CALLS ONLY — `fetch` and
      // `reader.read()` — and NEVER around the caller's hooks. A blanket
      // try/catch here reads a hook's throw as a dropped connection and
      // reconnects forever: the tail spins silently on an error nobody can
      // see, which is the exact failure this client exists to make
      // unreachable. (Caught by its own test: a refusal hook that throws hung
      // the suite until the catch was narrowed.)
      let res: Response;
      try {
        res = await fetch(url, { signal: controller.signal });
      } catch (e) {
        if (watchdog !== null) clearTimeout(watchdog);
        attempt = null;
        if (stopped) break;
        note(opts.onDisconnect?.({ cause: "connect-failed", error: e }));
        await backoff(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }

      try {
        if (!res.ok) {
          // May throw — a typed refusal is a usage error, not a blip.
          await opts.onHttpError?.(res);
          // ⛔ CANCEL THE BODY BEFORE LOOPING. An unread response body holds a
          // stream open, and this branch runs once per failed attempt for as
          // long as the daemon is unhappy — which is exactly the long-running
          // case. The hook may already have read it; cancel is a no-op then.
          await res.body?.cancel().catch(() => {});
          note(opts.onDisconnect?.({ cause: "http", status: res.status }));
          await backoff(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        if (!res.body) {
          // ⛔ A 200 WITH NO BODY MUST GROW THE BACKOFF like every other failed
          // attempt. One spell split this guard from its sibling and the second
          // half lost the growth line — a reconnect storm at a constant 250ms.
          note(opts.onDisconnect?.({ cause: "no-body", status: res.status }));
          await backoff(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }

        everConnected = true;
        firstConnect = false;
        resetWatchdog();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (!stopped) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (e) {
            // Watchdog abort, caller abort, or a dropped connection. All three
            // mean the same thing here: this attempt is over, reconnect below.
            if (!stopped) note(opts.onDisconnect?.({ cause: "stream-error", error: e }));
            break;
          }
          if (chunk.done) {
            if (!stopped) note(opts.onDisconnect?.({ cause: "stream-end" }));
            break;
          }
          // ⛔ THE BACKOFF RESETS ON THE FIRST BYTE, NOT ON A SUCCESSFUL OPEN —
          // and that is WIDER than the defect it was written for. B5 is
          // recorded as "a 200 with no body sleeps without growing the
          // backoff"; resetting at the open has the same shape for ANY
          // connection that is accepted and then yields nothing, which is what
          // a daemon mid-restart does. Driven: reset-at-open gives a constant
          // 41ms reconnect against a server that accepts and closes; reset-at-
          // first-byte gives 40, 80, 160. A byte is the only evidence the
          // daemon is actually talking to us.
          delay = retry.initialMs;
          // ⛔ BEFORE FRAME PARSING. A keepalive comment carries no data and is
          // discarded when data frames are selected below, but it is the proof the socket is
          // alive — feeding the watchdog only on DATA aborts every healthy but
          // quiet connection.
          resetWatchdog();
          buf += decoder.decode(chunk.value, { stream: true });

          for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const { frame, comments } = parseSseFrame(block);
            for (const text of comments) note(opts.onComment?.(text));
            if (!frame) continue;

            let ev: Ev;
            try {
              ev = JSON.parse(frame.data) as Ev;
            } catch (e) {
              note(opts.onMalformed?.(frame, e));
              continue;
            }

            // ⛔ THE CURSOR ADVANCES ON EVERY EVENT, INCLUDING A FILTERED ONE.
            // A scope predicate is about what the CALLER reads, never about what
            // the daemon has delivered; advancing only on emitted events makes
            // every reconnect re-request the filtered ones forever.
            const n = opts.cursorOf?.(ev);

            let epochReset = false;
            if (opts.epochOf) {
              const next = opts.epochOf(ev);
              if (typeof next === "string") {
                if (epoch !== null && next !== epoch) {
                  cursor = 0;
                  epochReset = true;
                  const line = opts.onEpochChange?.(next) ?? null;
                  if (line !== null) emit(line);
                  // The new log is past the bookmark: its start was skipped.
                  // Drop this attempt and re-read the new log from 0.
                  if (askedSince > 0 && typeof n === "number" && n > askedSince) {
                    epoch = next;
                    fromTop = true;
                    break;
                  }
                }
                epoch = next;
              }
            }
            if (
              opts.restartOnReplay === true &&
              !epochReset &&
              !restartNoted &&
              askedSince >= 0 &&
              typeof n === "number" &&
              n <= askedSince
            ) {
              // The daemon replayed WHOLE: its log restarted (see the option).
              restartNoted = true;
              cursor = 0;
              const line = opts.onEpochChange?.(opts.epochOf?.(ev) ?? "unknown") ?? null;
              if (line !== null) emit(line);
            }
            if (typeof n === "number" && Number.isFinite(n)) {
              cursor = cursorPolicy === "assign" ? n : Math.max(cursor, n);
            }

            const accepted = opts.accept?.(ev, frame) ?? true;
            const isTerminal = opts.terminal?.(ev, frame, accepted) ?? false;

            if (accepted || (isTerminal && opts.terminalEmitsFiltered === true)) {
              const line = opts.render ? opts.render(ev, frame) : frame.data;
              if (line !== null) emit(line);
            }
            if (isTerminal) {
              // ⛔ CLOSE THE CONNECTION. See `terminal`'s doc: without this the
              // open stream keeps the process alive after we return.
              controller.abort();
              ending = "terminal";
              return code;
            }
          }
          if (fromTop) {
            controller.abort();
            break;
          }
        }
      } finally {
        if (watchdog !== null) clearTimeout(watchdog);
        attempt = null;
      }

      if (stopped) break;
      if (fromTop) {
        // Re-read the new log from its start, now: nothing failed.
        delay = retry.initialMs;
        continue;
      }
      // ⛔ AND THE GROWTH LINE BELONGS HERE TOO. Every `continue` above grows
      // the delay; the path that falls through — a connection that OPENED and
      // then ended — did not, in any of the seven hand-written loops. Against a
      // daemon that accepts and immediately closes, that is a reconnect at a
      // constant 250ms for as long as it stays sick, which is B5's shape
      // reached by a different door. The reset on the first byte (above) is
      // what keeps this from slowing a healthy tail down.
      await backoff(delay);
      delay = Math.min(delay * 2, retry.maxMs);
    }
    return code;
  } finally {
    if (useSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    outEmitter.off?.("error", onOutError);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    opts.onEnd?.({ cursor, epoch, reason: ending });
  }
}
