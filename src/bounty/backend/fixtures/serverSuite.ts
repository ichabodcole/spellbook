// The shared harness of the bounty daemon suite (server.test.ts and its
// server.*.test.ts siblings): constants, the hermetic spawn helpers and the
// small readers the cells share. Moved here verbatim when the suite was split
// for parallel running; each test file evaluates it afresh (bun test isolates
// files), so TEST_TMPDIR is still one private directory per test file.
//
// The suite's original coverage note:
//
// Tests for bounty server.ts (the daemon), cli.ts, and join.ts.
//
// Coverage:
//   - Pure state-mutation helpers (applyTaskAdd/Update/Remove/Move).
//   - parsePortFromSessionId (the relaunch-port-reuse contract).
//   - htmlEscape (the 5 interesting chars + ampersand-first ordering).
//   - The daemon HTTP surface: GET /state, POST /cmd, GET /events (SSE).
//   - End-to-end via subprocess for the bits that need a real server:
//       * submit broadcasts to all WS clients (browsers + joiners)
//       * cancel broadcasts a structured event to all WS clients
//       * task.edit rejects non-string titles silently
//       * task.add from browser rejects malformed task objects
//       * cli.ts ↔ daemon parity: state ack, --stdin quoting, tail
//         resume-from-cursor, idle-touch (the Phase A gate)
//       * join.ts discovers via bounty-latest.json when --url/--id omitted
//       * join.ts idle timeout reports reason: "timeout"

import { expect } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BoardState,
  Task,
  TaskStatus,
} from "../../../../plugins/spellbook/skills/bounty/shared/types";

/**
 * Read a value this test's own setup is contracted to have produced, or fail
 * NAMING that contract (type-debt T11/T22: LOCAL copies — a test under `src/`
 * imports nothing from `grimoire/`). Written as function declarations, never
 * generic arrows: the import-boundary ward parses every file with Bun's
 * transpiler, which reads `<T>(` as JSX (Phase 4a). Not `?.`:
 * `expect(pokes[0]?.owner).toBeUndefined()` passes with no poke at all.
 */
export function must<T>(v: T | null | undefined, invariant: string): T {
  if (v === undefined || v === null) throw new Error(`INVARIANT VIOLATED — ${invariant}`);
  return v;
}

export function at<T>(xs: readonly T[], i: number, what: string): T {
  return must(xs[i], `${what} has an element ${i}`);
}

// The suite's own directory, `src/bounty/backend/`: one up from this harness,
// where the test files and the source they scan live.
export const SCRIPT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

// ⛔ THE SPAWNED FILE IS THE LAUNCHER, NEVER THIS DIRECTORY'S SOURCE (playbook
// Phase B, B6.1). The contract every process-level cell below asserts is what
// the PROCESS a caller runs writes and exits with, and the process a caller
// runs is `plugins/spellbook/skills/bounty/scripts/<entry>.ts`, which imports
// the BUILT `../dist/<entry>.js`. Spawning `./server.ts` from here would test a
// module that never ships in that form and would compute every one of its own
// path pins from `src/bounty/backend/` — an address with no `dist/`, no
// `assets/` and no `SKILL.md`, five levels from the right dev cwd.
//
// ⚠ AND IT IS DERIVED FROM AN EXPLICIT SKILL ROOT, NOT BY COUNTING `..` AT EACH
// SITE. The count is the repair that rots, and a test whose spawn path is wrong
// fails as "the daemon never answered" — which reads like flake, not like a
// broken path.
//
// The SOURCE-SCANNING cells further down deliberately keep reading
// `SCRIPT_DIR`: their subject is the authored text, not the running process.
export const SKILL_ROOT = join(
  SCRIPT_DIR,
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "bounty",
);

export const LAUNCHER_DIR = join(SKILL_ROOT, "scripts");

// A decoded protocol frame as observed on stdout / the WebSocket. The
// helpers collect heterogeneous frames (ready, meta, task.*, submit, init,
// joined, disconnected, …); fields are optional and narrowed per assertion.
export type WireMsg = {
  type?: string;
  task?: Task;
  tasks?: Task[];
  patch?: Partial<Task>;
  id?: string;
  status?: TaskStatus;
  index?: number;
  title?: string;
  text?: string;
  reason?: string;
  url?: string;
  port?: number;
  session_id?: string;
};

export const SERVER = join(LAUNCHER_DIR, "server.ts");

// ⛔ THE SOURCE ADDRESSES, HELD SEPARATELY FROM THE SPAWN ADDRESSES — and the
// need for the split is a gap in Phase B's B6.1. B6.1 says "spawn the LAUNCHER,
// not the source", which is right and is not the whole instruction: this file
// used ONE constant per entry for BOTH jobs, so re-pointing it at the launcher
// silently re-pointed the SOURCE-SCANNING cells too. They then read a 45-line
// comment block and found none of what they pin — `G7 PRECONDITION` failed as
// `expect(m).not.toBeNull()`, which reads like a broken regex rather than a
// wrong file. A source scan follows the SOURCE; only a process spawn follows
// the launcher.
export const CLI_SRC = join(SCRIPT_DIR, "cli.ts");

export const JOIN = join(LAUNCHER_DIR, "join.ts");

export function freshState(): BoardState {
  return { title: "T", tasks: [] };
}

// ── End-to-end subprocess tests ──────────────────────────────────────────

export type ReadyInfo = { url: string; port: number; session_id: string };

// ── Test hermeticity (#P0e) ──────────────────────────────────────────────
// The ambient environment binds every bounty verb to a REAL board: `cmdOpen`
// reads $BOUNTY_SESSION_KEY and derives a board id from it, and `resolveSession`
// falls back to $BOUNTY_SESSION. BOUNTY_HOME isolates the SNAPSHOT STORE only —
// it does NOT cover the key path — so a suite that scrubs only BOUNTY_HOME is
// still bound to whatever live board the shell points at. Measured: running
// this file inside an anthill seat shell (which exports BOUNTY_SESSION_KEY)
// made `open` take the idempotent-attach branch onto the TEAM's live board,
// write fixture cards into it, and then `close` it — the verb that clobbers the
// snapshot. Scrub the key path here, at the ONE place both spawn helpers share,
// so the hermeticity cannot drift between them.
// Computed per CALL, not once at module load: a module-load snapshot would make
// the regression test below vacuous (it sets the ambient key *during* the test,
// which a snapshot taken at import time could never have contained), and it
// would also miss anything that sets the variable after import.
//
// ── HALF 2: the discovery pointer (P0e reopened) ─────────────────────────
// Scrubbing the key path was only half the isolation. Session DISCOVERY does
// not go through BOUNTY_HOME at all: `cli.ts`, `join.ts` and `server.ts` all
// compose `join(tmpdir(), "bounty-latest.json")` — a MACHINE-GLOBAL singleton.
// Every daemon that boots anywhere on the machine overwrites it, so a peer
// suite (or another agent, or another project) can land inside the ~200ms
// window between this suite writing the pointer and reading it back. Measured:
// an injected daemon made this file's own assertions come back holding a
// FOREIGN session id, and 410 of 412 pointer writes on this machine in ten
// minutes were test fixtures — i.e. the peer is almost always another suite.
//
// So the harness assigns its own private TMPDIR and every spawn inherits it.
// A peer cannot reach a directory it cannot name.
//
// Note the deliberate asymmetry with the scrub above, because it looks like an
// inconsistency and is not: the SCRUB is recomputed per call (the ambient key
// changes during the run and a snapshot would miss it), while the TMPDIR is
// resolved ONCE and held (every spawn in this file must agree on one pointer
// directory — a fresh dir per call would hide each daemon from the very next
// CLI invocation that has to discover it).
//
// NOT put in the consumer's gate string on purpose: a `TMPDIR=$(mktemp -d)`
// pasted into `config.json` is a workaround living outside the thing it fixes,
// which is the shape this phase already deleted once. The harness owns it.
export const TEST_TMPDIR = mkdtempSync(join(tmpdir(), "bounty-suite-"));

// The machine-global temp dir — the one every OTHER bounty process on this box
// resolves to. Captured for the half-2 regression to assert AGAINST; nothing in
// this suite may compose a pointer path from it (the structural guard enforces
// that). Safe to read here because this file never mutates process.env.TMPDIR:
// the private dir travels to children through hermeticEnv(), not through us.
export const SHARED_TMPDIR = tmpdir();

// ⛔ The scrub list is NOT a set someone remembered — it is the env-typed half of
// AMBIENT_BINDINGS in preflight.ts, and preflight.test.ts source-scans this
// destructure to prove they agree. Adding a binding there without adding it here
// is RED, which is the only reason this list can be trusted later.
//
// BOUNTY_AS joined it in sprint 03: the enumeration that found it also found why
// it had been missed for two sprints — `grep 'process.env.'` cannot see
// BOUNTY_SESSION at all, because resolveSession reads it off an INJECTED env
// param (cli.ts:182). A scrub list derived by that grep is short and looks
// complete. TMPDIR is assigned rather than deleted (children need a private
// one); BOUNTY_HOME is assigned per-test by uniqHome().
export function hermeticEnv(): Record<string, string | undefined> {
  const { BOUNTY_SESSION_KEY: _k, BOUNTY_SESSION: _s, BOUNTY_AS: _a, ...rest } = process.env;
  return { ...rest, TMPDIR: TEST_TMPDIR };
}

// Spawn the daemon and wait until it's reachable. Readiness is discovered via
// the daemon's discovery file (`bounty-<id>.json`) + a /state probe — the
// daemon no longer prints a `ready` line on stdout (the SSE event log is the
// sole agent channel since the file-pump was retired).
export async function spawnServerReady(
  args: string[] = [],
): Promise<{ proc: ReturnType<typeof Bun.spawn>; ready: ReadyInfo }> {
  const id = `e2e-${crypto.randomUUID().slice(0, 8)}`;
  const proc = Bun.spawn({
    cmd: ["bun", "run", SERVER, "--no-open", "--port", "0", "--id", id, ...args],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    // Isolate persistence to a throwaway dir — a test suite must NOT write
    // snapshots into the user's real ~/.bounty (the default BOUNTY_HOME).
    env: { ...hermeticEnv(), BOUNTY_HOME: uniqHome() },
  });
  // TEST_TMPDIR, not tmpdir(): the daemon we just spawned writes its discovery
  // file into the TMPDIR we handed it, so the parent must look in the same place.
  const discoveryFile = join(TEST_TMPDIR, `bounty-${id}.json`);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const info = JSON.parse(readFileSync(discoveryFile, "utf8")) as ReadyInfo;
      const r = await fetch(`${info.url}/state`);
      if (r.ok) return { proc, ready: info };
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 80));
  }
  proc.kill();
  throw new Error("server did not become ready");
}

// Seed board state over the daemon's HTTP write path (replaces the retired
// stdin JSON-lines seeding).
export async function seedCmd(url: string, body: unknown): Promise<void> {
  await fetch(`${url}/cmd`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function collectStdout(
  proc: ReturnType<typeof Bun.spawn>,
  predicate: (m: WireMsg) => boolean,
  maxMs: number,
): Promise<WireMsg[]> {
  // `Bun.spawn`'s stdout is `number | ReadableStream` depending on the options;
  // every caller of this helper spawns with `stdout: "pipe"`, and a caller that
  // did not would read nothing, so it is refused by name rather than cast.
  const out = proc.stdout;
  if (!(out instanceof ReadableStream)) throw new Error('collectStdout needs stdout: "pipe"');
  const reader = out.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const seen: WireMsg[] = [];
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line) as WireMsg;
      seen.push(m);
      if (predicate(m)) {
        reader.releaseLock();
        return seen;
      }
    }
    if (done) break;
  }
  reader.releaseLock();
  return seen;
}

// Helper: wait for either the WS to close OR a target message to arrive,
// whichever comes first. Returns when both are settled so we can assert.
export async function collectWsUntilClose(ws: WebSocket): Promise<WireMsg[]> {
  const msgs: WireMsg[] = [];
  ws.addEventListener("message", (ev) => {
    try {
      msgs.push(JSON.parse(ev.data) as WireMsg);
    } catch {
      /* skip */
    }
  });
  await new Promise<void>((r) => {
    if (ws.readyState === WebSocket.CLOSED) return r();
    ws.addEventListener("close", () => r(), { once: true });
  });
  return msgs;
}

// ── cli.ts ↔ daemon parity (Phase A gate) ────────────────────────────────
//
// These drive the real cli.ts as a subprocess against a daemon it spawns —
// the agent-facing path that replaces bg.ts. Proving these green is the gate
// that lets bg.ts / watch-events.sh / the stdin reader be retired. Each test
// targets its daemon by explicit --session <id> (never the shared "latest"
// pointer) so concurrent/stale discovery files can't cross-wire the assertions.

export const CLI = join(LAUNCHER_DIR, "cli.ts");

// A fresh per-test BOUNTY_HOME so snapshot/discovery state never leaks between
// tests (Phase B writes snapshots here; Phase A keeps tests isolated up front).
export function uniqHome(): string {
  return join(TEST_TMPDIR, `bounty-test-${crypto.randomUUID().slice(0, 8)}`);
}

export type CliResult = { stdout: string; stderr: string; code: number };

export async function runCli(
  args: string[],
  opts: { stdin?: string; env?: Record<string, string> } = {},
) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, ...args],
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...hermeticEnv(), ...opts.env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { stdout, stderr, code } as CliResult;
}

// Strip `//` line comments before any source scan. Learned the hard way, twice
// in one edit: the first cut of the gate below matched the sentence in its own
// documentation and reported four offenders when the code had one. A guard that
// its own prose can trip gets "fixed" by softening the regex, which is how a
// real offender slips through later.
export function codeLines(src: string): string {
  return src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

// The files of the split suite: server.test.ts, every server.*.test.ts beside
// it, and this harness. The P0e source scans read all of them, because a spawn
// written in any sibling, or here, reaches the same live boards that one file's
// spawns did. Derived from the tree, so a new sibling is scanned without being
// listed; server.test.ts pins the population so a rename cannot shrink it
// silently.
export function suiteFiles(): string[] {
  const tests = readdirSync(SCRIPT_DIR)
    .filter((f) => /^server(\.[\w-]+)?\.test\.ts$/.test(f))
    .sort();
  return [...tests, "fixtures/serverSuite.ts"];
}

/** Every suite file's text with `//` comment lines stripped, joined. */
export async function suiteCode(): Promise<string> {
  const texts = await Promise.all(suiteFiles().map((f) => Bun.file(join(SCRIPT_DIR, f)).text()));
  return texts.map(codeLines).join("\n");
}

// ── P0b (#80.1) — the early return that discards a flag set ───────────────
//
// `open --session-key K` against a LIVE board takes the idempotent-attach branch
// and returns before the daemon argument list is built, so --title, --timeout
// and --restore are silently discarded: the caller asks for four hours and gets
// thirty seconds, at exit 0, with nothing said. The fix REFUSES (exit 2) and
// carries `restoreSkipped`.
//
// GATE LAW, as it applies here — stated rather than assumed:
//  · G1  every cell passes an explicit --session-key under a unique BOUNTY_HOME;
//        hermeticEnv() scrubs the two env routes. The explicit key is the
//        isolation — the scrub alone is NOT (a .bounty-session walk-up resolves
//        to the same team board the env var would have named).
//  · G5  every spawn inherits TEST_TMPDIR via hermeticEnv().
//  · G6  does NOT bind this lane. G6 is the DRAIN defect, where Bun.spawn's pipe
//        cannot reproduce a truncation. These cells assert an EXIT CODE and a
//        small envelope, neither of which the reader can mask. Named explicitly
//        so nobody reads its absence as an oversight.
//  · G7  binds: `runOpen` fails the cell if the process does not RETURN. A
//        drained-exit fix trades truncation for a hang wherever process.exit was
//        load-bearing, and a hang is invisible to a suite that only awaits.
//  · G8  the precondition prints VALID-CONTROL / DEGENERATE and is asserted, so
//        a setup that silently no-ops cannot pass as evidence.

// Spawn `open` with an explicit cwd and a HARD deadline.
//
// cwd matters twice: --pin writes `<cwd>/.bounty-session` (a cell running in the
// repo would rebind the team's own board), and sessionKeyToId hashes the project
// root, so every cell must derive its id from one stable directory.
//
// The deadline is G7: `await proc.exited` alone turns a hang into a suite
// timeout, which reads as flakiness rather than as the regression it is.
export async function runOpen(
  args: string[],
  opts: { home: string; cwd: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number; ms: number }> {
  const started = performance.now();
  const proc = Bun.spawn({
    cmd: ["bun", "run", CLI, "open", ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts.cwd,
    env: { ...hermeticEnv(), BOUNTY_HOME: opts.home },
  });
  const budget = opts.timeoutMs ?? 15000;

  // ⚠ G7 REACHABILITY — EXIT IS OBSERVED BEFORE THE PIPES ARE READ, and the
  // order is the whole point.
  //
  // The previous version read BOTH pipes to completion and only then awaited
  // `proc.exited`, so its G7 assertion sat downstream of an EOF it might never
  // receive. A pipe reaches EOF when EVERY holder closes it — including a
  // DETACHED GRANDCHILD. `bounty open` spawns exactly such a grandchild, so if
  // that daemon ever held one of these handles, the reads would block forever,
  // the assertion below would never execute, and the failure would surface as a
  // suite timeout — which reads as flakiness, not as the hang it is. The cell
  // would not go red; it would become UNREACHABLE.
  //
  // `SIGKILL` at the budget does NOT rescue it: it kills `proc`, not a detached
  // grandchild, so pipes held by the daemon stay open after the kill.
  //
  // So termination is decided by racing `proc.exited` against a timer, touching
  // no pipe. The reads happen afterwards and are themselves bounded, so this
  // helper always returns a verdict rather than hanging.
  const verdict = await Promise.race([
    proc.exited.then((code) => ({ timedOut: false, code })),
    Bun.sleep(budget).then(() => ({ timedOut: true, code: -1 })),
  ]);
  if (verdict.timedOut) proc.kill("SIGKILL");
  const ms = performance.now() - started;

  // G7, asserted on the pipe-independent verdict.
  expect({ verb: `open ${args.join(" ")}`, returnedOnItsOwn: !verdict.timedOut }).toEqual({
    verb: `open ${args.join(" ")}`,
    returnedOnItsOwn: true,
  });

  // Reads come last and are bounded — a grandchild still holding a handle
  // degrades this to empty output instead of wedging the suite.
  const drain = (s: ReadableStream<Uint8Array>) =>
    Promise.race([new Response(s).text(), Bun.sleep(2000).then(() => "")]);
  const [stdout, stderr] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
  return { stdout, stderr, code: verdict.code, ms };
}

// Renamed from `snapshotTaskCount` in sprint 03: that name is now a REAL
// export of server.ts (the shrinkage guard's prior-count reader), and an
// import of it here was SILENTLY SHADOWED by this local declaration —
// no runtime error, just the wrong function with the wrong arity. `bun test`
// cannot see that; `tsc` reports it as TS2440 and the repo gate does not run
// tsc. This helper resolves home+id, which the exported one deliberately does
// not, so it stays — under a name that cannot collide.
export function snapshotTaskCountAt(home: string, id: string): number | null {
  try {
    const raw = readFileSync(join(home, "snapshots", `${id}.json`), "utf8");
    return (JSON.parse(raw) as { tasks?: unknown[] }).tasks?.length ?? 0;
  } catch {
    return null; // no snapshot on disk yet
  }
}

export async function liveTaskCount(port: number): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/state?lean=1`);
  const d = (await r.json()) as { state: { tasks: unknown[] } };
  return d.state.tasks.length;
}

// ── One act, one answer (docs/cycles/2026-09-one-act-one-answer.md) ─────────
// Each cell is a command whose exit code, envelope or side effect disagreed with
// what it did. Every refusal here leaves stdout empty and puts ONE envelope on
// stderr (the house taxonomy, `src/kit/wire/errors.ts`).

export type Envelope = {
  ok: false;
  error: { kind: string; exit_code: number; message: string; hint?: string; server?: unknown };
};

export function refusal(r: CliResult, kind: string, code: number): Envelope["error"] {
  expect(r.code).toBe(code);
  expect(r.stdout).toBe("");
  const lines = r.stderr.trim().split("\n");
  const env = JSON.parse(lines.at(-1) ?? "") as Envelope;
  expect(env.ok).toBe(false);
  expect(env.error.kind).toBe(kind);
  expect(env.error.exit_code).toBe(code);
  return env.error;
}

// ── Data you can't get back (cycle 2026-09-data-you-cant-get-back) ──────────
// The re-measure (decision-log row 3) found four paths where an ordinary act
// still destroys state with no backup. Each is pinned here by a cell that was
// run RED against the pre-fix build first.

/** Every daemon process running board `id`, by the `--id <id>` its argv
 *  carries. `pgrep` excludes itself, and no CLI argv carries `--id`. */
export function daemonPids(id: string): number[] {
  const r = Bun.spawnSync(["pgrep", "-f", "--", `--id ${id}`]);
  return new TextDecoder().decode(r.stdout).trim().split("\n").filter(Boolean).map(Number);
}

/** The teardown of last resort: a lock bug leaves orphans, and an orphan
 *  outlives the suite. SIGKILL every daemon still running `id`. */
export function killBoard(id: string): void {
  for (const pid of daemonPids(id)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export async function liveTitles(id: string, env: Record<string, string>): Promise<string[]> {
  const st = await runCli(["state", "--session", id], { env });
  return (JSON.parse(st.stdout) as { state: { tasks: { title: string }[] } }).state.tasks.map(
    (t) => t.title,
  );
}

/** Open keyed board `key`, add `titles`, close it: a dead board whose snapshot
 *  holds exactly those tasks. Returns the derived id. */
export async function seedClosed(key: string, titles: string[], env: Record<string, string>) {
  const o = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "30"], { env });
  const id = (JSON.parse(o.stdout) as { session_id: string }).session_id;
  for (const t of titles) await runCli(["add", t, "--session", id], { env });
  await runCli(["close", "--session", id], { env });
  return id;
}

/** A backup named on the `open`/`close` envelope (`snapshotBackups`). */
export type Backup = {
  kind: string;
  path: string;
  taskCount: number | null;
  reason: string;
  restore: string;
};

export function titlesAt(path: string): string[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { tasks: { title: string }[] }).tasks.map(
    (t) => t.title,
  );
}

// ── Follow-ups from the data-loss cycle's no-stake verifier ──────────────
// Each cell was run RED against the pre-fix build first.

/** Run the CLI by bun's absolute path, so a test can hand it a PATH that has
 *  no `ps` (or a broken one) and still start, bounded so a hang is a finding
 *  rather than a suite timeout. `runCli` resolves `bun` on PATH. */
export async function runCliAbs(
  args: string[],
  env: Record<string, string>,
  boundMs = 30000,
): Promise<CliResult | "HUNG"> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", CLI, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...hermeticEnv(), ...env },
  });
  const out = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const r = await Promise.race([out, Bun.sleep(boundMs).then(() => "HUNG" as const)]);
  if (r === "HUNG") {
    proc.kill("SIGKILL");
    return "HUNG";
  }
  const [stdout, stderr, code] = r;
  return { stdout, stderr, code };
}

/** stderr is exactly ONE JSON envelope, with no prose beside it. */
export function onlyEnvelope(stderr: string): Envelope {
  const lines = stderr.trim().split("\n");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0] as string) as Envelope;
}

/** A PATH holding a `ps` that runs and fails. */
export function brokenPsDir(): string {
  const dir = mkdtempSync(join(TEST_TMPDIR, "brokenps-"));
  writeFileSync(join(dir, "ps"), "#!/bin/sh\necho 'ps: simulated failure' >&2\nexit 1\n");
  chmodSync(join(dir, "ps"), 0o755);
  return dir;
}

export type SaveFailed = {
  path: string;
  error: string;
  unsaved: string | null;
  taskCount: number;
} | null;

/** The command a failed close's hint says to run once the path is fixed. */
export function restoreFromHint(hint: string | undefined): string[] {
  const cmd = (hint ?? "").split("then run: ")[1] ?? "";
  expect(cmd).toContain("--restore");
  return cmd.trim().split(" ");
}

// Verifier, 2026-09-28 (third round), and decision-log row 13: every round
// found a narrower edge of one cause, a daemon writing over a snapshot it never
// read or kept a copy of. The rule: a daemon writes over its own snapshot only
// if it read that file at boot, or wrote it itself since, or has just copied it
// aside. Otherwise the copy comes first, and if the copy fails the board goes
// to the `unsaved` dump instead.
export type NamedBackupT = Omit<Backup, "restore"> & {
  restore: string | null;
  superseded?: string;
};

/** The one backup (named on an envelope) whose file holds `title`. */
export function backupHolding(list: NamedBackupT[], title: string): NamedBackupT | undefined {
  return list.find((b) => {
    try {
      return titlesAt(b.path).includes(title);
    } catch {
      return false;
    }
  });
}

// ── A restore keeps every task (cycle 2026-10-a-restore-keeps-every-task) ──
// item/bounty-snapshot-edges-after-the-ownership-rule. A keyed respawn used to
// own its snapshot after ANY restore of it, even one that dropped (or changed)
// entries this build's validateTask cannot keep, so the first write erased
// them. Ownership after a restore now needs the board to hold the file; a board
// that does not keeps the file aside first, and `open` names what it dropped.
export type Dropped = { index: number; id: string | null; reason: string };

/** Rewrite board `id`'s snapshot in `home` through `edit`. */
export function editSnapshot(
  home: string,
  id: string,
  edit: (board: { title: string; tasks: Record<string, unknown>[] }) => void,
): string {
  const snap = join(home, "snapshots", `${id}.json`);
  const board = JSON.parse(readFileSync(snap, "utf8")) as {
    title: string;
    tasks: Record<string, unknown>[];
  };
  edit(board);
  writeFileSync(snap, JSON.stringify(board));
  return snap;
}
