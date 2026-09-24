/**
 * The tail's HANDOFF: how a spell's `tail` ends its own watch just before the
 * harness's Monitor cap, and the one stdout line that names the agent's next
 * act, bookmark included.
 *
 * ⛔ THE KIT IS A LEAF. This module imports only its sibling `./tailEvents`.
 *
 * Built on `feat/tail-quiet-handoff` to Cole's ruling of 2026-09-23 (the
 * "Ruling" section of
 * `docs/backlog/2026-09-22-scriptorium-tail-monitor-expiry-wakes-the-agent-for-nothing.md`)
 * and the four adjustments of its feasibility spike
 * (`docs/investigations/2026-09-22-monitor-expiry-and-the-tail.md`).
 *
 * ── THE PROBLEM, ONE PARAGRAPH ──────────────────────────────────────────────
 *
 * Claude Code's Monitor kills every watch at 1,800,000 ms. Every spell tells
 * the agent to wrap `tail` in Monitor, so an idle session woke the agent every
 * 30 minutes to re-arm, and a bare re-arm replayed up to the last 1000 events,
 * answered human messages included. The replay is a correctness bug; the idle
 * wakes are a cost Cole ruled against.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────────────
 *
 * Two modes, one line at the end of each:
 *
 *   • `watch` (the default, run under Monitor): streams until its WINDOW ends,
 *     then prints `tail.window` (it saw events → re-arm Monitor) or
 *     `tail.quiet` (it saw none → run `tail --once` as a background Bash
 *     task). A PRESENCE spell always gets `tail.window`: a stop-start tail
 *     would flicker the presence its connection carries.
 *   • `once` (run as a background Bash task): sleeps until the first log event,
 *     prints it, prints `tail.woke` (→ back to Monitor) and EXITS, which is
 *     what wakes the agent.
 *
 * Either mode ends with `tail.closed` when the session closes and `tail.lost`
 * when the daemon is gone (session spells), each naming how to come back
 * instead of a re-arm. A signal or a caller's abort prints nothing.
 *
 * Every re-arm carries `--since <cursor>`, so nothing replays; the daemon's
 * buffer covers whatever lands between one watch's exit and the next's arm.
 *
 * ── DECISION LOG (feat/tail-quiet-handoff, 2026-09-23) ──────────────────────
 *
 * Kit decisions live in module headers (the architecture doc's §4 rule: "each
 * module's header is the authoritative account"). Ruled by Cole: the hybrid,
 * the always-bookmark, presence spells always re-arm Monitor, bounty's example
 * fixed. The four adjustments were the spike's requirements. The rest are the
 * implementer's rulings, marked ⚖ with the options not taken.
 *
 * A1 · A TERMINAL FRAME CLOSES THE CONNECTION. `tailEvents` now aborts the
 *      in-flight fetch before it returns on a terminal frame. Before, it
 *      returned from inside the read loop and left the SSE stream open, so the
 *      process stayed alive: unseen for `closed` (the server ends that
 *      stream itself) and fatal for `--once`, whose background task would
 *      never exit and so never wake the agent, silently. Pinned in
 *      `tailHandoff.test.ts` against a server that keeps the stream open.
 *
 * A2 · THE NEXT ACT DEPENDS ON STATE. `handoff()` below is the pure decision:
 *      quiet → background, active or presence → Monitor, woke → Monitor,
 *      closed → come back, lost → come back. Come back is the spell's own verb
 *      (`open --restore <id>` for the session spells).
 *      ⚖ THE DISCONNECT DECISION: for a session spell, a LOST daemon ends the
 *      tail in BOTH modes with a stdout `tail.lost` line. Monitor notifies only
 *      on stdout, so the old stderr-only `tail.disconnected` left a
 *      Monitor-wrapped agent unaware of a `kill -9` (E55's purpose unmet), and
 *      a `--once` on a dead daemon would have slept forever. "Lost" is
 *      `LOST_AFTER_REFUSALS` connection refusals in a row, never a dropped
 *      stream alone: a laptop that sleeps drops the stream, reconnects on the
 *      first try, and must stay silent.
 *        Not taken: (a) keep retrying and only MOVE the disconnect line to
 *        stdout — a session daemon is never respawned by its tail, so the
 *        retries buy nothing and the agent is woken to be told to wait; (b)
 *        leave it on stderr — the defect.
 *      ⚖ Presence spells keep retrying, as before: grapevine's tail respawns
 *      its daemon and astrolabe's `join` waits for the human to reopen the
 *      board, both by design. Their disconnect notes stay where they were.
 *
 * A3 · QUIET IS THE TAIL'S OWN COUNT. `events` counts the log frames this
 *      process wrote to stdout. The grounding line, a spell's `subscribed`
 *      marker, `epoch.changed` and the handoff line itself are not log frames
 *      and are not counted (`counts` lets a spell exclude a server-sent
 *      grounding frame). Any log frame counts, the daemon's `waiting` reminder
 *      included, so "quiet" means nothing on the log.
 *      ⚖ A frame the tail's own filter rejects (bounty's owner scope, a
 *      self-echo) is NOT counted and does not end a `--once`: it was never
 *      delivered, and waking on it would be a wake with nothing to act on —
 *      the defect this module exists to remove. The cursor still advances
 *      past it (tailEvents' rule), so it never replays either.
 *      A `--since` re-arm prints no grounding line; that half lives in each
 *      spell's `tail`, which knows whether `--since` was given.
 *
 * A4 · THE WINDOW. `DEFAULT_WINDOW_MS` = the cap minus `WINDOW_MARGIN_MS`
 *      (60 s), so 1,740,000 ms. The margin has to cover the gap between the
 *      harness starting its clock and this process starting its own (Bun
 *      start-up, a session lookup, a daemon spawn on the spells whose `resolve`
 *      spawns one — bounded by their start timeouts, which are seconds) plus
 *      the last line's flush and Monitor's 200 ms batching. A minute covers
 *      all of that many times over and costs 3% of the window, one extra
 *      re-arm about every 14.5 hours of activity. The spike measured a 12 s
 *      window under a 20 s cap ending cleanly; nothing here depends on a
 *      margin that tight. If the cap wins anyway, the agent gets Monitor's
 *      bare expiry notice and re-arms silently from the last id it saw — the
 *      ruling's fallback, stated in every skill.
 *      ⚖ The window is injectable for tests and verification through
 *      `SPELLBOOK_TAIL_WINDOW_MS` (a count of ms; `0` turns the window off,
 *      for a human watching a terminal). An env var and not a flag: it is
 *      not an agent's act, so it stays out of eight verbs' schemas.
 *
 * ⚖ `--once` ENDS ON THE FIRST FRAME, with no drain. A burst arrives split: the
 *   first event on the one-shot, the rest on the Monitor re-arm, which loses
 *   nothing because of the bookmark. The spike offered a ~200 ms drain as an
 *   option, not a requirement; not taken, because it adds a timer to the
 *   exit path whose failure this branch exists to make impossible.
 * ⚖ THE LINE'S `command` IS RUNNABLE AS PRINTED: `bun <this cli's path> …`,
 *   pinned to the session this tail was bound to, with its scope flags. The
 *   skills name the rule once; the line carries the specifics.
 */
import { type SseFrame, type TailOptions, tailEvents } from "./tailEvents";

/** Claude Code's Monitor cap, per the tool's schema ("Deadlines above
 *  1800000ms are capped to 1800000ms"). A harness number: if it changes, this
 *  changes, and so does the skills' `timeout_ms`. */
export const MONITOR_CAP_MS = 1_800_000;
/** See A4 in the header for why a minute. */
export const WINDOW_MARGIN_MS = 60_000;
export const DEFAULT_WINDOW_MS = MONITOR_CAP_MS - WINDOW_MARGIN_MS;
/** The injection point for tests and verification (see A4). */
export const WINDOW_ENV = "SPELLBOOK_TAIL_WINDOW_MS";
/** Connection refusals in a row that make the daemon "lost" (see A2). Three
 *  span about 0.75 s under the kit's default backoff (250 + 500 ms between
 *  them): a live daemon never refuses its own port, and the two extra attempts
 *  only buy tolerance for a restart that rebinds the same port. */
export const LOST_AFTER_REFUSALS = 3;

/** The window length: the env value when it is a non-negative integer, else the
 *  default. `0` means no window. */
export function resolveWindowMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WINDOW_MS;
}

export type TailMode = "watch" | "once";

/** How a tail ended. `window` is our own deadline, `event` is a `--once`'s
 *  first frame, `closed` is the session ending (a `closed` frame or the pinned
 *  session's pointer vanishing), `lost` is the daemon refusing connections,
 *  and `stopped` is a signal, a caller's abort or a closed stdout. */
export type TailEnd = "window" | "event" | "closed" | "lost" | "stopped";

export type HandoffInput = {
  end: TailEnd;
  mode: TailMode;
  /** Log frames this process wrote to stdout (A3). */
  events: number;
  /** The bookmark: the highest id this process has seen. */
  cursor: number;
  presence: boolean;
};

export type HandoffCommands = {
  /** The re-arm, with the bookmark; `once` adds `--once`. */
  tail: (o: { since: number; once: boolean }) => string;
  /** How to come back from a session that is gone. */
  comeBack: () => string;
};

export type HandoffLine = {
  type: "tail.window" | "tail.quiet" | "tail.woke" | "tail.closed" | "tail.lost";
  events: number;
  cursor: number;
  /** `monitor`: arm Monitor (timeout_ms 1800000) with `command`.
   *  `background`: run `command` as a background Bash task.
   *  `stop`: nothing to watch; `command` is how to come back, if wanted. */
  next: "monitor" | "background" | "stop";
  command: string;
  hint: string;
};

/**
 * THE DECISION: given how the tail ended, which line it prints. Pure, so every
 * state is a literal cell in `tailHandoff.test.ts`. Returns null for `stopped`:
 * a human's Ctrl-C or a caller's abort is not a handoff.
 */
export function handoff(s: HandoffInput, cmd: HandoffCommands): HandoffLine | null {
  const base = { events: s.events, cursor: s.cursor };
  switch (s.end) {
    case "stopped":
      return null;
    case "closed":
      return {
        type: "tail.closed",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: "the session closed; there is nothing left to watch. To bring it back, run command",
      };
    case "lost":
      return {
        type: "tail.lost",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: "lost the daemon (it crashed or was killed); nothing is listening. To come back, run command",
      };
    case "event":
      return {
        type: "tail.woke",
        ...base,
        next: "monitor",
        command: cmd.tail({ since: s.cursor, once: false }),
        hint: "handle the event above, then arm Monitor (timeout_ms 1800000) with command",
      };
    case "window":
      if (s.presence || s.events > 0)
        return {
          type: "tail.window",
          ...base,
          next: "monitor",
          command: cmd.tail({ since: s.cursor, once: false }),
          hint: "the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) with command",
        };
      return {
        type: "tail.quiet",
        ...base,
        next: "background",
        command: cmd.tail({ since: s.cursor, once: true }),
        hint: "nothing on the log this window; run command as a background Bash task (run_in_background) — it exits on the next event",
      };
  }
}

/** POSIX single-quote an argument when it needs it, so a printed `command`
 *  runs as printed. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Join an argv into one runnable command line. */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** How THIS process was invoked, as the head of a command that runs it again:
 *  `bun <the launcher's full path>`. Bun hands `argv[1]` over as a full path. */
export function selfCommand(): string[] {
  return ["bun", process.argv[1] ?? "cli.ts"];
}

/** The re-arm for a spell whose tail is `<prefix…> --since N [--once]`. */
export function tailCommand(prefix: readonly string[], since: number, once: boolean): string {
  // ⚠ A negative bookmark (nothing seen yet) is spelled `--since=-1`: the
  // parsers read a bare `-1` after a flag as another flag and refuse it.
  const at = since < 0 ? [`--since=${since}`] : ["--since", String(since)];
  return commandLine([...prefix, ...at, ...(once ? ["--once"] : [])]);
}

export type HandoffOptions<Ev> = {
  mode: TailMode;
  /** A presence spell: always `tail.window` at the window's end, never lost. */
  presence: boolean;
  /** Default: `resolveWindowMs(process.env[WINDOW_ENV])`. `0` = no window. */
  windowMs?: number;
  /** Whether an emitted frame is a LOG frame (A3). Default: every one. */
  counts?: (ev: Ev, frame: SseFrame) => boolean;
  /** Which terminal frame means the session closed. Default: every terminal. */
  isClosed?: (ev: Ev) => boolean;
  commands: HandoffCommands;
};

/**
 * Run `tailEvents` with the handoff: the window, `--once`, the lost rule, and
 * the final line. Returns the exit code, like `tailEvents`, and never exits.
 */
export async function tailWithHandoff<Ev>(
  tail: TailOptions<Ev>,
  h: HandoffOptions<Ev>,
): Promise<number> {
  const out = tail.out ?? process.stdout;
  const windowMs = h.windowMs ?? resolveWindowMs(process.env[WINDOW_ENV]);
  const counts = h.counts ?? (() => true);
  const endOnLost = !h.presence;

  const ac = new AbortController();
  const onCallerAbort = () => ac.abort();
  tail.signal?.addEventListener("abort", onCallerAbort);
  if (tail.signal?.aborted) ac.abort();

  let events = 0;
  let cursor = tail.since;
  let end: TailEnd | null = null;
  let refusals = 0;

  const finish = (e: TailEnd) => {
    if (end === null) end = e;
    ac.abort();
  };
  const timer =
    h.mode === "watch" && windowMs > 0 ? setTimeout(() => finish("window"), windowMs) : null;

  try {
    const code = await tailEvents<Ev>({
      ...tail,
      signal: ac.signal,
      onUnresolved: (s) => {
        const verdict = tail.onUnresolved?.(s) ?? "retry";
        // A pinned session's pointer vanishing after we had it: it closed.
        if (verdict === "stop" && s.everResolved && end === null) end = "closed";
        return verdict;
      },
      render: (ev, frame) => {
        refusals = 0;
        const line = tail.render ? tail.render(ev, frame) : frame.data;
        if (line !== null && counts(ev, frame)) events += 1;
        return line;
      },
      terminal: (ev, frame, accepted) => {
        if (tail.terminal?.(ev, frame, accepted)) {
          if (end === null) end = (h.isClosed ?? (() => true))(ev) ? "closed" : "event";
          return true;
        }
        if (h.mode === "once" && accepted && counts(ev, frame)) {
          if (end === null) end = "event";
          return true;
        }
        return false;
      },
      onComment: (text) => {
        refusals = 0;
        return tail.onComment?.(text) ?? null;
      },
      onDisconnect: (info) => {
        const line = tail.onDisconnect?.(info) ?? null;
        if (info.cause === "connect-failed") {
          refusals += 1;
          if (endOnLost && refusals >= LOST_AFTER_REFUSALS) finish("lost");
        } else {
          // The daemon answered (a status, or a stream that opened and then
          // ended): it is alive, so the refusals were not in a row.
          refusals = 0;
        }
        return line;
      },
      onEnd: (s) => {
        cursor = s.cursor;
        tail.onEnd?.(s);
      },
    });
    const line = handoff(
      { end: end ?? "stopped", mode: h.mode, events, cursor, presence: h.presence },
      h.commands,
    );
    if (line !== null) out.write(`${JSON.stringify(line)}\n`);
    return code;
  } finally {
    if (timer !== null) clearTimeout(timer);
    tail.signal?.removeEventListener("abort", onCallerAbort);
  }
}
