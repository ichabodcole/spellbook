#!/usr/bin/env bun

// astrolabe CLI — thin, stateless wrapper around the standing observatory
// daemon's HTTP surface (server.ts). The agent drives the board through these
// verbs; `join`/`tail` stream events as JSONL for Monitor to wrap.
//
// Discovery + lifecycle: a SINGLETON daemon per $ASTROLABE_HOME. The first verb
// that needs it auto-spawns it (detached, survives this CLI); it's found via
// $ASTROLABE_HOME/daemon.{port,pid}.
//
//   bun cli.ts open [--no-open] [--timeout S]    # ensure the daemon is up + open the board
//   bun cli.ts add <name> --path <p> [--description ..] [--avatar ..] [--id ..] [--stdin]
//   bun cli.ts remove <id>                       # unregister a project (durable)
//   bun cli.ts join <id> [--as <name>] [--since N]   # scoped /events tail — ACTIVATES the card + receives pokes (wrap with Monitor)
//   bun cli.ts status <id> <summary...> [--phase ..] [--stdin]   # replace the current status
//   bun cli.ts attention <id> [--clear] [--question ...]         # raise / clear the human gate
//   bun cli.ts poke <id>                         # request a fresh status from the project's agent
//   bun cli.ts state                             # read-back: project cards
//   bun cli.ts tail [--since N] [--as <name>]    # unscoped event tail → JSONL (no presence)
//   bun cli.ts list | close | info | help | version | schema
//
// `join` is the listening loop a project's agent runs: holding the scoped
// `/events?project=<id>` tail open is what marks the card active (per the daemon
// contract — presence IS the live connection), and the same tail delivers pokes.
//
// The verbs, their flags and positionals are ONE table at the foot of this file,
// run by the house's CLI registry (`src/kit/cli/registry.ts`).
//
// Identity: --as / --from (or $ASTROLABE_AS) stamps the event `by` and drives
// self-echo suppression. --stdin reads free text (description/summary) from
// stdin (bypasses shell quoting). Discipline: structured JSON on stdout (one
// line); liveness, echoes and keepalives on stderr; failures put ONE JSON error
// envelope on stderr with stdout left empty — never merge streams. Exit 2 on
// bad args, a bare invocation, OR a rejected command (dedupe / unknown id);
// 0 on success; 1 on internal faults (daemon failed to start); 6 (`conflict`)
// when, with no daemon up, registry.json cannot be read; a tail exits 0
// on the daemon's `closed` frame.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyProjectAdd,
  type ObservatoryState,
} from "../../../plugins/spellbook/skills/astrolabe/scripts/state.ts";
import {
  type CommandSpec,
  defineCli,
  type Invocation,
  type PositionalSpec,
} from "../../kit/cli/registry";
import { printJson } from "../../kit/lib/printJson";
import { die } from "../../kit/wire/errors";
import {
  commandLine,
  readSince,
  tailCommand,
  tailWithHandoff,
  WINDOW_HELP,
} from "../../kit/wire/tailHandoff";
import { TAIL_IDLE_MS } from "./heartbeat.ts";
import { listSetAside, readRegistry, recoverAct } from "./registryFile.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// ⛔ "..", "scripts" — NOT a sibling lookup. This file is AUTHORED here and
// EXECUTES as `../dist/cli.js` (Contract 4's built-backend amendment), and
// `dist/` sits at the SAME DEPTH as `scripts/`, so every ANCESTOR-relative
// path in this file (SKILL_ROOT, DIST_DIR, SURFACE_CWD, plugin.json) is
// unchanged by the move. A SIBLING-relative one is not: `join(SCRIPT_DIR,
// "server.ts")` resolved to `dist/server.ts` and the daemon would never
// spawn. Going up and back down is correct from BOTH locations.
const SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
// dev: the daemon serves a Bun-bundled React surface, and Bun reads bunfig.toml
// (the Tailwind plugin) from cwd ONLY, so the daemon's cwd MUST be
// src/astrolabe/ (seams Contract 5 cwd-pin) — launched anywhere else the dev
// bundler cannot compile the stylesheet (measured on glamour: the page 500s
// with no stylesheet link; astrolabe's own failure shape is unmeasured). release: dist/ is
// pre-built and static — no bunfig read, so this path need not exist at all (a
// source-free marketplace clone has no top-level src/), and pinning cwd there
// anyway would break the spawn.
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "astrolabe");

function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
const ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join(homedir(), ".astrolabe");
const PORT_FILE = join(ASTROLABE_HOME, "daemon.port");
const REGISTRY_FILE = join(ASTROLABE_HOME, "registry.json");

// ── the tail watchdog, DERIVED FROM THE DAEMON'S OWN HEARTBEAT ──────────────
//
// ⛔ A CONSTANT HERE WOULD BE A CONSTANT DECOUPLED FROM THE THING IT WATCHES.
// The watchdog aborts a connection that has said nothing for `TAIL_IDLE_MS`;
// the only thing keeping a quiet connection alive is the daemon's `: hb`
// comment. So the two numbers are ONE invariant — watchdog > heartbeat, with
// room for missed beats.
//
// ⛔ IT USED TO BE MIRRORED HERE BY HAND. Two expressions copied out of the
// daemon under a comment saying "an edit there is an edit here", because the
// CLI could not import the daemon without dragging the whole server graph into
// `dist/cli.js`. Phase 1b's shared spine is that import: `./heartbeat.ts` is a
// leaf-shaped module with no daemon in it, both halves import it, and the
// mirror is gone rather than annotated.

// Failures leave stdout empty and put ONE JSON envelope on stderr — the same
// machine shape as the data path, so a piped caller parses the error instead of
// scraping prose. THE ENVELOPE, THE TAXONOMY AND THE EXIT CODES ARE NOW SHARED
// (`src/kit/wire/errors.ts`); astrolabe's fourth, minimal copy is gone. Two
// things changed and both are additive: the envelope gains `exit_code`,
// `retryable` and `meta.command`, and `die` THROWS a CliError that `main`
// reports, rather than exiting from wherever it was called. `kind` and
// `message` — the two fields anything can be keying on — are untouched.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// id + avatar are DERIVED by the daemon (state.ts) from the project name, so the
// cli passes id/avatar through only when the caller gave them explicitly — one
// source of truth, no slug/avatar mirror to drift.

function resolveAs(flags: Record<string, string | boolean>): string | undefined {
  const v = flags.as ?? flags.from;
  if (typeof v === "string" && v.trim()) return v.trim();
  const env = process.env.ASTROLABE_AS;
  return env?.trim() ? env.trim() : undefined;
}

// `Bun.stdin.text()` — the house's own shape (magpie, bounty, mind-mapper).
// The loop it replaces iterated `Bun.stdin.stream()` with `for await`, which Bun
// supports at run time but the root tsconfig's DOM `ReadableStream` does not
// declare; same UTF-8 decode, same trim.
async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).trim();
}

// ── daemon discovery + HTTP ──────────────────────────────────────────

async function readPort(): Promise<number | null> {
  try {
    const p = Number.parseInt((await Bun.file(PORT_FILE).text()).trim(), 10);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function isUp(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/state`)).ok;
  } catch {
    return false;
  }
}

// Find the running daemon, or auto-spawn one (detached so it outlives this CLI —
// node:child_process, not Bun.spawn, which can't detach a surviving daemon).
async function ensureDaemon(): Promise<{ base: string; port: number }> {
  const existing = await readPort();
  if (existing && (await isUp(existing))) {
    return { base: `http://127.0.0.1:${existing}`, port: existing };
  }
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    // Contract 5 — see daemonCwd(). A wrong cwd skips bunfig.toml's Tailwind
    // plugin; on glamour that fails the page outright (500). Assert the invariant,
    // not the status: the utility never reaches the browser when cwd is wrong.
    cwd: daemonCwd(),
  });
  proc.unref();
  // The daemon BINDS fast and answers /state as soon as it's listening (the
  // cold Tailwind+React bundle is lazy, on the first GET "/"), so this handshake
  // usually returns quickly. The wide deadline covers a cold machine where
  // module load + first serve runs slow (glamour uses the same ~45s budget).
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(80);
    const p = await readPort();
    if (p && (await isUp(p))) return { base: `http://127.0.0.1:${p}`, port: p };
  }
  die("astrolabe daemon failed to start within 45s", "internal");
}

// ── A REFUSED INVOCATION STARTS NOTHING (one-act-one-answer) ───────────
//
// Every verb that names a project used to call `ensureDaemon()` and let the
// daemon decide — so `status <unknown> hi` on a cold machine SPAWNED a daemon
// to answer "unknown project", exit 2, and left it running. The registry is
// not only in the daemon: it is `$ASTROLABE_HOME/registry.json`, the snapshot
// the daemon restores on boot. So:
//
//   - a daemon is up  → `null`: the daemon's live state decides, as before
//     (the file is a debounced snapshot and may trail it);
//   - no daemon is up → the board the daemon WOULD boot with, via the same
//     `readRegistry` it uses. No file is the empty board.
//
// A cold refusal is therefore the same answer, kind and exit as a warm one;
// only the side effect is gone. "No daemon" is not itself `not_found`: the
// question is whether the project is registered, and the disk answers it.
//
// ⛔ AN UNREADABLE FILE IS NOT THE EMPTY BOARD (data-you-cant-get-back). It
// used to be read as one, so `status beta` on a corrupt registry answered
// "unknown project 'beta'", `choices: []` — a confident answer to a question
// the disk could not answer. Now it is refused as `conflict` (a precondition
// failed; exit 6), with NO side effect: the bytes stay exactly where they are,
// and the hint names the two acts that move forward — fix the file, or `open`,
// whose daemon boot sets it aside (a rename, never a delete) and starts empty.
// The CLI does not move the file itself: a refused invocation starts nothing
// and touches nothing, and `open` is the one place the move happens.
async function coldBoard(): Promise<ObservatoryState | null> {
  const port = await readPort();
  if (port && (await isUp(port))) return null;
  const read = readRegistry(REGISTRY_FILE);
  if (!read.ok)
    die(
      `${REGISTRY_FILE} could not be read (${read.reason}), so which projects are registered is unknown`,
      "conflict",
      {
        hint: "fix the JSON in that file and retry; or run `cli.ts open --no-open` to set it aside (renamed to registry.json.unreadable-<time>, never deleted) and start an empty board",
      },
    );
  return read.state;
}

// ── A SET-ASIDE REGISTRY IS REPORTED FOR AS LONG AS IT EXISTS ──────────────
//
// When the daemon's boot moved an unreadable registry aside, projects the human
// registered may be in that file and not on the board. That is STATE, not an
// event: it is re-read from the directory on every call (`listSetAside`), and
// it stops being reported when the human deals with the file — moves it back,
// or deletes it. No "already told" flag: a second record of the same fact is
// the defect (one-state-one-meaning).
//
//   - a success on a verb that touches the board → one `# warning:` on stderr
//     (stdout and the exit are unchanged);
//   - an unknown project, cold or warm → the refusal's message says the
//     registry was set aside and where, and its hint is the recovery;
//   - `info` / `state` / `list` → a `registry_set_aside` field, absent when
//     there is nothing to report (so a healthy answer is byte-identical).
function setAsideClause(asides: string[]): string {
  return `registry.json could not be read and was set aside at ${asides.join(", ")}`;
}
function recoverHint(asides: string[]): string {
  return asides.map((a) => recoverAct(a, REGISTRY_FILE)).join("; ");
}

function warnSetAside(): void {
  const asides = listSetAside(REGISTRY_FILE);
  if (asides.length === 0) return;
  process.stderr.write(
    `# warning: astrolabe: ${setAsideClause(asides)}; projects registered in it are not on the board. To recover: ${recoverHint(asides)}\n`,
  );
}

function setAsideField(): { registry_set_aside?: Array<{ path: string; recover: string }> } {
  const asides = listSetAside(REGISTRY_FILE);
  if (asides.length === 0) return {};
  return {
    registry_set_aside: asides.map((path) => ({ path, recover: recoverAct(path, REGISTRY_FILE) })),
  };
}

/** The unknown-project refusal's words — naming the set-aside copy when one exists. */
function unknownProject(id: string): { message: string; hint: string } {
  const add = "run: cli.ts add <name> --path <p> to register it";
  const asides = listSetAside(REGISTRY_FILE);
  if (asides.length === 0) return { message: `unknown project '${id}'`, hint: add };
  return {
    message: `unknown project '${id}' — but ${setAsideClause(asides)}, so '${id}' may be registered there`,
    hint: `to recover it: ${recoverHint(asides)}. Or ${add}`,
  };
}

/** `ensureDaemon()` for a verb naming project `id` — refused first, cold, if the id is unregistered. */
async function ensureDaemonFor(id: string): Promise<{ base: string; port: number }> {
  const board = await coldBoard();
  if (board && !board.projects.some((p) => p.id === id)) {
    // The registry is in hand, so `choices` names it (as `join`'s warm check
    // does). An EMPTY board answers `choices: []` — "nothing would have been
    // accepted" — which is a true answer and not the same as no field.
    //
    // ⚠ Inline, not a `: never` helper shared with `join`: the census
    // enumerator (`grimoire/lib/error-sites.ts`) counts every call to a raiser
    // as a site, and reads `choices` off the call's own argument text.
    const u = unknownProject(id);
    die(u.message, "usage", {
      hint: u.hint,
      choices: board.projects.map((p) => p.id),
    });
  }
  return await ensureDaemon();
}

// A read-only verb requires a live daemon but must not spawn one (nothing to
// observe yet) — so `state`/`list`/`info` on a cold machine report cleanly.
async function runningBase(): Promise<string | null> {
  const p = await readPort();
  return p ? `http://127.0.0.1:${p}` : null;
}

async function postCmd(base: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { ok: boolean; applied: boolean; error?: string; outcome?: string };
}

// Apply a /cmd, surface a rejection on stderr + non-zero exit (exit-code
// contract), and echo the structured result on stdout on success.
async function cmd(base: string, body: Record<string, unknown>) {
  const r = await postCmd(base, body);
  // b2/#85 — DISTINGUISH THE TWO KINDS OF applied:false. WITH an error = a real
  // rejection (unknown project, duplicate) -> visible, non-zero, unchanged.
  // WITHOUT an error = a benign no-op: the state was already what was asked for,
  // the project exists, the daemon is right, and nothing is wrong. That used to
  // exit 2 with "command 'attention' was not applied", so re-issuing an
  // already-applied command was a hard failure — while bounty treats the
  // identical payload as ordinary success.
  //
  // This is bounty's discipline (cli.ts `task.update`), ported rather than
  // re-derived. It reports the daemon's `outcome` noun instead of bounty's
  // `noop: true` boolean, per the outcome contract's "enumerated, never a
  // boolean" — the noun says WHICH state made the work unnecessary.
  if (!r.applied && r.error) {
    // The daemon's unknown-project rejection carries the set-aside notice too
    // (still the one relayed raise site it always was).
    const unknown = /^unknown project '(.*)'$/.exec(r.error);
    const u = unknown ? unknownProject(unknown[1] as string) : null;
    die(u ? u.message : r.error, "usage", u ? { hint: u.hint } : undefined);
  }
  printJson(r);
  warnSetAside();
}

function openBrowser(url: string): void {
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}

// SSE reader: stream the event log as JSONL on stdout, resumable + reconnecting
// — one call into the house's shared tail client (`src/kit/wire/tailEvents.ts`),
// which is where the loop, the frame parser, the backoff, the idle watchdog and
// the drained exit now live, ONCE, for every spell.
//
// `scopeId` (set by `join`) filters to this project's frames + lifecycle; an
// unscoped tail passes everything. Self-echo (frames the caller's own --as
// caused) is suppressed. `:` keepalives ride stderr; returns 0 on `closed`.
//
// ⛔ `resolve` IS `runningBase`, RE-READ ON EVERY ATTEMPT — this is the B1 fix
// and the reason astrolabe went first. astrolabe binds an EPHEMERAL port, and
// this function used to take a captured `base: string`, so after any daemon
// restart `join` reconnected to a dead port forever and streamed nothing while
// looking perfectly alive. It cannot: the callback re-reads
// `$ASTROLABE_HOME/daemon.port` before every connect. Driven in `cli.test.ts`.
//
// It deliberately does NOT spawn. `join`/`tail` still call `ensureDaemon()`
// once up front (a tail with no daemon at all is worth reporting); a daemon
// that dies MID-watch is a wait, not a respawn, because a second astrolabe
// spawned from inside a reconnect loop is a worse outcome than a watch that
// resumes when the human reopens the board.
async function streamEvents(opts: {
  since: number;
  sinceEpoch?: string;
  project?: string;
  scopeId?: string;
  self?: string;
  /** The verb and its identity flags, so the handoff line re-arms THIS watch. */
  again: string[];
}): Promise<number> {
  type Ev = { id?: number; epoch?: string; type?: string; by?: string; projectId?: string };

  const inScope = (ev: Ev) => {
    if (!opts.scopeId) return true;
    if (ev.type === "ready" || ev.type === "closed") return true;
    return ev.projectId === opts.scopeId;
  };

  // ⛔ A PRESENCE SPELL (`kit/wire/tailHandoff.ts`): `join` holding its
  // connection is what lights the card, so its window always names the Monitor
  // re-arm and never the stop-start `--once`, and a lost daemon is waited for,
  // not reported (a dead astrolabe resumes when the human reopens the board).
  return await tailWithHandoff<Ev>(
    {
      resolve: runningBase,
      path: "/events",
      since: opts.since,
      ...(opts.sinceEpoch ? { sinceEpoch: opts.sinceEpoch } : {}),
      cursorOf: (ev) => ev.id,
      query: (cursor) => ({
        since: String(cursor),
        ...(opts.project ? { project: opts.project } : {}),
      }),
      accept: (ev) => inScope(ev) && !(opts.self !== undefined && ev.by === opts.self),
      terminal: (ev) => ev.type === "closed",
      // ⛔ THE RESTART GAP. Astrolabe is a singleton that `cli.ts` respawns, and
      // its event ids restart at 1 — so a `join` that has been running for hours
      // resumes at `since=<a large number>` against a daemon whose whole log is
      // smaller than that. The daemon half (`kit/wire/eventLog.ts`) replays whole
      // when the cursor is beyond its own; this half is what stops the tail then
      // re-requesting the stale cursor on every subsequent reconnect. The line is
      // SYNTHESIZED — it is not a bus event, carries no `id`, and never advances
      // the cursor — which is the same separation mind-mapper's `epoch.changed`
      // makes and `src/mind-mapper/backend/tail.test.ts` pins.
      epochOf: (ev) => ev.epoch,
      onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
      idleMs: TAIL_IDLE_MS,
      onComment: () => ": astrolabe-keepalive",
    },
    {
      spell: "astrolabe",
      mode: "watch",
      presence: true,
      commands: {
        tail: ({ since, epoch }) => tailCommand(opts.again, since, false, epoch),
        comeBack: () => commandLine(["open", "--no-open"]),
      },
    },
  );
}

// ── verbs ────────────────────────────────────────────────────────────

async function cmdOpen(flags: Record<string, string | boolean>) {
  const { port } = await ensureDaemon();
  if (!flags["no-open"]) openBrowser(`http://127.0.0.1:${port}`);
  printJson({ ok: true, url: `http://127.0.0.1:${port}`, port });
  // `open` is where an unreadable registry gets set aside (the daemon's boot),
  // so this is where the human first hears of it.
  warnSetAside();
}

async function cmdAdd(pos: string[], flags: Record<string, string | boolean>) {
  const name = pos.join(" ").trim();
  if (!name) die("usage: add <name> --path <p> [--description ..] [--avatar ..] [--id ..]");
  const path = typeof flags.path === "string" ? flags.path.trim() : "";
  if (!path) die("add requires --path <p>");
  const description = flags.stdin
    ? await readStdin()
    : typeof flags.description === "string"
      ? flags.description
      : undefined;
  // id + avatar are optional — the daemon derives both from the name when omitted.
  const avatar = typeof flags.avatar === "string" ? flags.avatar : undefined;
  const id = typeof flags.id === "string" && flags.id.trim() ? flags.id.trim() : undefined;
  // A duplicate is refused cold by the daemon's own reducer over the board it
  // would boot with — the same message and exit as the warm rejection below.
  const board = await coldBoard();
  if (board) {
    const dry = applyProjectAdd(board, { id: id ?? "", name, path, description, avatar });
    if (!dry.applied && dry.error) die(dry.error);
  }
  const { base } = await ensureDaemon();
  await cmd(base, {
    type: "project.add",
    project: { id, name, path, description, avatar },
    as: resolveAs(flags),
  });
}

async function cmdRemove(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: remove <id>");
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "project.remove", id, as: resolveAs(flags) });
}

async function cmdStatus(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: status <id> <summary...> [--phase ..] [--stdin]");
  const summary = flags.stdin ? await readStdin() : pos.slice(1).join(" ").trim();
  if (!summary) die("status requires a summary (positional or --stdin)");
  const phase = typeof flags.phase === "string" ? flags.phase : undefined;
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "status", id, summary, phase, as: resolveAs(flags) });
}

async function cmdAttention(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: attention <id> [--clear] [--question ...]");
  const raised = flags.clear !== true;
  const question =
    typeof flags.question === "string"
      ? flags.question
      : pos.slice(1).join(" ").trim() || undefined;
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "attention", id, raised, question, as: resolveAs(flags) });
}

async function cmdPoke(pos: string[], flags: Record<string, string | boolean>) {
  const id = pos[0];
  if (!id) die("usage: poke <id>");
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "poke", id, as: resolveAs(flags) });
}

async function cmdState() {
  const base = await runningBase();
  if (!base || !(await isUp(Number.parseInt(base.split(":").pop() as string, 10)))) {
    printJson({
      ok: true,
      running: false,
      state: { title: "Observatory", projects: [] },
      ...setAsideField(),
    });
    return;
  }
  const res = await fetch(`${base}/state`);
  if (!res.ok) die(`state failed (HTTP ${res.status})`);
  printJson({ ...((await res.json()) as Record<string, unknown>), ...setAsideField() });
}

async function cmdList() {
  const base = await runningBase();
  // Guard with isUp() before fetching (mirrors cmdState): a STALE daemon.port
  // from a crashed daemon would otherwise throw ECONNREFUSED here instead of the
  // clean running:false path.
  if (!base || !(await isUp(Number.parseInt(base.split(":").pop() as string, 10)))) {
    printJson({ ok: true, running: false, projects: [], ...setAsideField() });
    return;
  }
  const { state } = (await (await fetch(`${base}/state`)).json()) as {
    state: { projects: Array<Record<string, unknown>> };
  };
  printJson({
    ok: true,
    running: true,
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      zone: p.zone,
      connected: p.connected,
    })),
    ...setAsideField(),
  });
}

// How long `close` waits for the daemon to actually be down, and how often it
// looks. The same bound and interval as bounty's `close` (b14), which borrowed
// them from its own `open --fresh` — not invented here.
const CLOSE_WAIT_MS = 3000;
const CLOSE_POLL_MS = 80;

// s5-8 — close with nothing to close is a BENIGN NO-OP, not a rejection. It
// used to print `{ok:true, applied:false, error:"no daemon running"}` at exit 0:
// shaped as a rejection (an `error`) and exited as a success, so the two faults
// cancelled and nothing caught it. The state that made the work unnecessary is
// named by a noun, in astrolabe's own `already-<state>` family
// (already-connected/-disconnected, already-raised/-cleared), and there is no
// `error` key — outcome-contract: a zero exit never carries a failure
// explanation.
const CLOSED = { ok: true, applied: false, outcome: "already-closed" } as const;

async function cmdClose(flags: Record<string, string | boolean>) {
  const port = await readPort();
  // No port file, OR a stale one (daemon killed, file left behind): nothing is
  // answering, so there is nothing to close. `isUp` is false on a refused
  // connection, which is what used to surface as an internal "Unable to connect".
  if (!port || !(await isUp(port))) {
    printJson(CLOSED);
    return;
  }
  let r: Awaited<ReturnType<typeof postCmd>>;
  try {
    r = await postCmd(`http://127.0.0.1:${port}`, { type: "close", as: resolveAs(flags) });
  } catch (e) {
    // It went down between the probe and the POST — the same no-op, honestly.
    if (!(await isUp(port))) {
      printJson(CLOSED);
      return;
    }
    throw e;
  }
  // `cmd()`'s discipline: applied:false WITH an error is a rejection.
  if (!r.applied && r.error) die(r.error);
  if (!r.applied) {
    printJson(r);
    return;
  }
  // WAIT FOR IT TO ACTUALLY BE DOWN. The daemon acks `close` before it has torn
  // down, so returning on the ack reported an ACT, not its COMPLETION: `close;
  // close` answered applied:true twice, and a check written that way passed
  // vacuously (the item's fixture trap). Now applied:true means it is down.
  const deadline = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!(await isUp(port))) {
      printJson(r);
      return;
    }
    await sleep(CLOSE_POLL_MS);
  }
  // Still answering at the bound: the close was acked but did not complete, so
  // reporting ok:true applied:true would be a lie. A wedged teardown is the
  // spell's fault, not the caller's — `internal`, exit 1.
  die(
    `close was acknowledged but the daemon was still answering after ${CLOSE_WAIT_MS / 1000}s`,
    "internal",
    { hint: "check with `info`; re-run `close` once it settles" },
  );
}

async function cmdInfo() {
  const port = await readPort();
  if (port && (await isUp(port))) {
    printJson({
      ok: true,
      running: true,
      url: `http://127.0.0.1:${port}`,
      port,
      ...setAsideField(),
    });
  } else {
    printJson({ ok: true, running: false, ...setAsideField() });
  }
}

/**
 * ── ONE TABLE: the parser, the dispatcher, help, `choices` and `schema` ─────
 *
 * astrolabe runs on the house's CLI registry (`src/kit/cli/registry.ts`). The
 * rows below are the only declaration of what each verb accepts; the kit
 * parses every argv against them, refuses a flag that belongs to another verb
 * (with this verb's own set as `choices`), enforces arity from `positionals`,
 * answers `help`, `version` and `schema`, and publishes the acc declaration.
 *
 * ⛔ The hand-kept `VERBS` / `ROOT_TOKENS` / `RECOGNIZED_FLAGS` lists, the
 * source-parsing cell that bound `VERBS` to a `switch`, and the one flag map
 * shared by every verb are gone: there is no second copy left to drift.
 *
 * ⚠ `clear`, `stdin` and `no-open` carry `default: false`. The kit strips
 * defaults before the per-row check and applies them only to the rows that
 * list the flag, so `remove p1` is never refused over `--clear`.
 */
const CLI_OPTIONS = {
  as: { type: "string" },
  from: { type: "string" },
  path: { type: "string" },
  description: { type: "string" },
  avatar: { type: "string" },
  id: { type: "string" },
  phase: { type: "string" },
  question: { type: "string" },
  since: { type: "string" },
  timeout: { type: "string" },
  clear: { type: "boolean", default: false },
  stdin: { type: "boolean", default: false },
  "no-open": { type: "boolean", default: false },
} as const;

type Flag = keyof typeof CLI_OPTIONS;
type Flags = Record<string, string | boolean>;

/** Keep the handlers' `(pos, flags)` shape; adapt it to the row's `run(inv)`. */
const on =
  (h: (pos: string[], flags: Flags) => unknown) =>
  (inv: Invocation<Flag>): unknown =>
    h(inv.pos, inv.flags as Flags);

/** The actor flags: every verb that writes an event or holds a watch. */
const IDENTITY = ["as", "from"] as const satisfies readonly Flag[];
const NONE: PositionalSpec[] = [];
const ID: PositionalSpec[] = [{ name: "id", required: true }];

/**
 * `--since` is a bookmark, `N` or `N@<epoch>` as the handoff line prints it
 * (`kit/wire/tailHandoff.ts`, D2): the epoch lets the tail notice a restarted
 * daemon whose new log is already past the id. A form it does not accept is
 * refused with the accepted forms named, never misparsed (`readSince`).
 */
function sinceOf(flags: Flags): { since: number; sinceEpoch?: string } {
  const read = typeof flags.since === "string" ? readSince(flags.since, { epoch: true }) : null;
  if (read !== null && !read.ok) die(read.message, "usage");
  return read?.ok ? { since: read.since, sinceEpoch: read.epoch } : { since: -1 };
}

async function cmdJoin(pos: string[], flags: Flags): Promise<number> {
  const id = pos[0] as string;
  const { since, sinceEpoch } = sinceOf(flags);
  const { base } = await ensureDaemonFor(id);
  // Confirm the project exists before holding the watch (a typo'd id would
  // otherwise bind no presence and silently stream nothing useful). Cold, that
  // was answered from disk above; warm, the live board answers it here.
  const { state } = (await (await fetch(`${base}/state`)).json()) as {
    state: { projects: Array<{ id: string }> };
  };
  if (!state.projects.some((p) => p.id === id)) {
    // ⭐ THE SET IS ALREADY IN HAND, WHICH IS WHY THIS SITE QUALIFIES AND
    // the same rejection relayed from the daemon (`cmd()`) does not: the
    // snapshot was fetched one line above to make this very check, so
    // naming the registered ids costs nothing and needs no second call.
    // An EMPTY board answers `choices: []` — a true answer, not a missing one.
    const u = unknownProject(id);
    die(u.message, "usage", {
      hint: u.hint,
      choices: state.projects.map((p) => p.id),
    });
  }
  const self = resolveAs(flags);
  warnSetAside();
  return await streamEvents({
    since,
    sinceEpoch,
    project: id,
    scopeId: id,
    self,
    again: ["join", id, ...(self !== undefined ? ["--as", self] : [])],
  });
}

async function cmdTail(flags: Flags): Promise<number> {
  const { since, sinceEpoch } = sinceOf(flags);
  // ensureDaemon for the START of the watch only; the tail re-resolves the
  // daemon on every reconnect (see streamEvents), so `base` is not carried.
  await ensureDaemon();
  const self = resolveAs(flags);
  warnSetAside();
  return await streamEvents({
    since,
    sinceEpoch,
    self,
    again: ["tail", ...(self !== undefined ? ["--as", self] : [])],
  });
}

const ROWS: CommandSpec<Flag>[] = [
  {
    name: "open",
    // ⚠ `--timeout` is accepted and not read: the daemon is spawned standing.
    // Kept because it was accepted before the move; `usageHides` keeps it out
    // of help, as the hand-written help did (`schema` still declares it).
    flags: ["no-open", "timeout"],
    positionals: NONE,
    describe: "ensure the daemon is up + open the board in the browser",
    run: on((_pos, flags) => cmdOpen(flags)),
  },
  {
    name: "add",
    flags: ["path", "description", "avatar", "id", "stdin", ...IDENTITY],
    positionals: [{ name: "name", required: true, variadic: true }],
    describe:
      "register a project (--path required; dedupe-guarded; id + avatar derived from the name). echoes the derived id for join/status/attention/remove",
    run: on(cmdAdd),
  },
  {
    name: "remove",
    flags: [...IDENTITY],
    positionals: ID,
    describe: "unregister a project",
    run: on(cmdRemove),
  },
  {
    name: "join",
    flags: ["since", ...IDENTITY],
    positionals: ID,
    describe:
      "activate the card + listen for pokes (scoped tail; wrap with Monitor). end it to idle the card",
    run: on(cmdJoin),
  },
  {
    name: "status",
    flags: ["phase", "stdin", ...IDENTITY],
    // ⚠ FLAG-DEPENDENT ARITY: the summary is positional OR `--stdin`. The
    // declaration can only mark it optional; `check` refuses a call with neither.
    positionals: [...ID, { name: "summary", required: false, variadic: true }],
    describe: "replace a project's current status (the summary is positional, or --stdin)",
    check: (inv) =>
      inv.flags.stdin !== true && inv.pos.length < 2
        ? "missing required <summary> (or pass --stdin)"
        : undefined,
    run: on(cmdStatus),
  },
  {
    name: "attention",
    flags: ["clear", "question", ...IDENTITY],
    positionals: [...ID, { name: "question", required: false, variadic: true }],
    describe: "raise / clear (--clear) the needs-you gate (--question attaches the prompt)",
    run: on(cmdAttention),
  },
  {
    name: "poke",
    flags: [...IDENTITY],
    positionals: ID,
    describe: "request a fresh status from the project's agent",
    run: on(cmdPoke),
  },
  {
    name: "state",
    flags: [],
    positionals: NONE,
    describe: "read-back: project cards (each carries a derived zone: attention | active | quiet)",
    run: () => cmdState(),
  },
  {
    name: "tail",
    flags: ["since", ...IDENTITY],
    positionals: NONE,
    describe: "unscoped event tail as JSONL (no presence)",
    run: on((_pos, flags) => cmdTail(flags)),
  },
  {
    name: "list",
    flags: [],
    positionals: NONE,
    describe: "the registered projects, compact",
    run: () => cmdList(),
  },
  {
    name: "close",
    flags: [...IDENTITY],
    positionals: NONE,
    describe: "dismiss the observatory",
    run: on((_pos, flags) => cmdClose(flags)),
  },
  {
    name: "info",
    flags: [],
    positionals: NONE,
    describe: "daemon status: running, url, port",
    run: () => cmdInfo(),
  },
];

// The plugin manifest is the one version source; the CLI reads it rather than
// mirroring the number. Layout-dependent, so absence degrades to "unknown".
async function versionInfo(): Promise<{ name: string; version: string }> {
  try {
    const pkg = await Bun.file(join(SCRIPT_DIR, "../../../.claude-plugin/plugin.json")).json();
    if (typeof pkg?.version === "string") return { name: "astrolabe", version: pkg.version };
  } catch {}
  return { name: "astrolabe", version: "unknown" };
}

// ⛔ BUILDING THE TABLE HAS NO SIDE EFFECTS. `defineCli` only validates and
// indexes; nothing is parsed, printed or read until `main` runs, so a ward or
// a test can import this module and read `cli.flagsFor` / `cli.declaration()`.
export const cli = defineCli({
  name: "astrolabe",
  summary: "a standing observatory board for projects in flight.",
  options: CLI_OPTIONS,
  commands: ROWS,
  // The verb is the first argument: `astrolabe --as x state` is refused as an
  // unknown root flag. A bare `--` makes the next token the verb (acc A6).
  grammar: "verb-first",
  usageHides: ["timeout"],
  version: versionInfo,
  helpFooter: `  join and tail ${WINDOW_HELP}

  Identity: --as / --from (or $ASTROLABE_AS) stamps the actor + suppresses
  self-echo, on the verbs that list it. --stdin reads a description/summary from
  stdin (shell-quoting-safe). Each verb accepts only the flags on its row; a
  recognized flag on the wrong verb is refused, and the rejection lists the
  verb's own flags.

  Output: every command prints JSON on stdout by default, one line per answer;
  failures put one JSON error envelope on stderr and exit non-zero (2 = usage,
  1 = internal). There is no prose mode to switch out of.`,
});

/**
 * The failure funnel is the registry's `main`: `die` THROWS a CliError (the
 * house's one error contract, `src/kit/wire/errors.ts`), `main` turns it into
 * ONE JSON envelope on stderr and a taxonomy exit code, and an unexpected
 * throw becomes an `internal` envelope (exit 1) rather than a stack trace —
 * the process contract is JSON on stderr for EVERY failure. The process still
 * ends the one way the house sanctions, `process.exitCode` plus a natural
 * return, which is what drains stdout on a pipe.
 */
async function main(argv: string[]): Promise<number> {
  return await cli.main(argv);
}

if (import.meta.main) {
  // `process.exitCode` + a natural return, NEVER `process.exit(code)`: Bun's
  // stdout is ASYNCHRONOUS on a pipe (synchronous on a TTY or file), so an
  // explicit exit discards whatever has not drained — measured at exactly
  // 65,536 bytes. The payload is complete and only the write is lost, so the
  // caller gets well-formed-looking JSON that stops mid-string. Reproduced,
  // fixed and gated in bounty first (P0, #77/#78); same shape, same reason.
  // Do not tidy this back into an explicit exit.
  process.exitCode = await main(process.argv.slice(2));
}

// Exported so the shipped launcher (plugins/.../scripts/cli.ts) can invoke the
// BUNDLED copy of this module. The import.meta.main block above still runs this
// file directly during development; the two entry routes are exclusive, because
// import.meta.main is false for an imported module.
export { main };

/**
 * The SHIPPED ENTRY POINT, called by `plugins/spellbook/skills/astrolabe/scripts/cli.ts`
 * after the bundle is imported.
 *
 * ⛔ IT TAKES NO ARGUMENTS, AND THAT IS THE POINT. argv belongs to whichever file
 * PARSES it, and that is this one. An earlier launcher read
 * `process.argv.slice(2)` itself and passed it in — which made the launcher match
 * `grimoire/lib/entry-points.ts`'s PARSES_ARGS predicate (`process.argv`), so the
 * roster counted a 3-line forwarder as an arg-parsing entry point and then
 * reported the spell's documented flags as UNRESOLVED against a file that
 * recognises none. Keeping argv on this side makes the enumerator's answer true
 * instead of making its regex looser.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}
