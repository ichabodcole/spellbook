# Grapevine — Operator Roll-Safety Implementation Plan

> **Status:** Archived (Implemented) — ownership guard + `reap`/`doctor`/`roll`
>
> - `stop --hold` shipped and merged; 8 tests added. Archived 2026-06-27.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rolling, diagnosing, and cleaning up grapevine daemons safe and
one-command — so a deploy/re-roll never knocks out the live daemon and orphan
processes can be killed without forensics.

**Architecture:** All changes are daemon/CLI **back-end** (no new agent-facing
message verbs). The daemon owns `DATA_DIR/daemon.port` + `daemon.pid`; the CLI
discovers it by reading those files + a `GET /` health check. This work hardens
that lifecycle: ownership-aware file cleanup, an ownership-aware `reap`, a
classifying `doctor`, a respawn `--hold`, and a `roll` verb that wraps the safe
re-roll sequence.

**Tech Stack:** Bun, TypeScript, `node:fs`, `ps`/`lsof` (operator diagnostics).
Tests: `bun test` via the tmpdir-HOME `bunRun`/spawn harness in `cli.test.ts`.

**Motivation (real incident, 2026-06-23/24):** during a manual daemon roll +
orphan cleanup, killing a stale race-loser daemon triggered its `shutdown()`,
which deleted the **live** daemon's `daemon.port`/`daemon.pid` (it deleted
unconditionally, not checking ownership) — orphaning the healthy 1.9.0 daemon
from every CLI until the files were hand-restored. The team's sockets survived;
only discovery broke. See
`grimoire/scenarios/2026-06-24-exit-cleanup-must-verify-ownership.md` (added in
Finalize). This plan turns that manual, dangerous cleanup into safe, automated
verbs.

## Global Constraints

- **Branch:** all work on `feat/grapevine-operator-roll-safety` (off `develop`).
  Do NOT push or release — the maintainer (Cole) handles that; merge to
  `develop` locally at the end.
- **Runtime:** Bun. Tests:
  `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` (spawns its
  own daemons under tmpdir `GRAPEVINE_HOME`). Never npm/jest.
- **Version:** do NOT hand-edit `plugin.json`. New behavior → `feat(grapevine):`
  (minor) via release-please. Back-end only — no agent-facing verb changes, so a
  release + one roll deploys it without asking anyone to restart sessions.
- **Safety-first for destructive ops:** `reap`/kill logic must **default to keep
  on any uncertainty** — never kill a daemon it cannot positively classify as an
  orphan. The current-HOME authoritative daemon is never reaped.
- **No new spell / rename / removal** → ward synced listings unchanged (spell
  revision).
- **Format:** `bunx biome check --write` on changed `.ts`; prettier on `.md`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Resolved design

1. **Port-file ownership guard** — `shutdown()` deletes
   `daemon.port`/`daemon.pid` **only if they still point to this process** (port
   == `server.port`, pid == `process.pid`). A stale daemon whose files were
   replaced by a newer one leaves them alone. (The CLI's stale-cleanup in
   `readDaemonPort`/`ensureDaemon` only runs after a failed health check, so
   it's deleting genuinely-dead files — leave it; the shutdown path is the bug.)
2. **Daemon classifier + `reap`** — `classifyDaemon(pid)` resolves a daemon's
   listening port (lsof) + `GET /` (its `data_dir`, `version`) and decides:
   **authoritative** (its own `home/daemon.port` points back to it → keep),
   **orphan** (home doesn't recognize it → reapable), **unresponsive** (no
   `GET /` → reapable only with `--force`), **unknown** (can't resolve port →
   never reap). `grapevine reap [--force] [--dry-run]` kills reapable daemons,
   never the current-HOME authoritative.
3. **Smarter `doctor`** — each `other_daemons_on_machine` entry gains
   `port`/`home`/`version`/`status`/`reapable` from the classifier; hints
   suggest `reap` (and `reap --force` if any are unresponsive).
4. **`stop --hold <seconds>`** — stop the daemon AND write a
   `DATA_DIR/daemon.hold` marker (expiry timestamp) that suppresses auto-respawn
   for the window; `ensureDaemon` honors a live hold (waits/declines) so a stale
   CLI can't win the respawn race during an upgrade.
5. **`roll` verb** — one command: report active subscribers (refuse without
   `--force` if any, like restart) → `stop --hold` → spawn from THIS CLI's path
   → release the hold → verify the new daemon's `version` matches the CLI →
   report.

## File Structure

| File                  | Responsibility                                                                                | Tasks      |
| --------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| `scripts/daemon.ts`   | ownership-aware `shutdown`; honor `hold` on startup; `/` already advertises identity          | 1, 4       |
| `scripts/cli.ts`      | `classifyDaemon` + `reap`; doctor labeling; `stop --hold`; `ensureDaemon` honors hold; `roll` | 2, 3, 4, 5 |
| `scripts/cli.test.ts` | tests for each                                                                                | 1–5        |

All under `plugins/spellbook/skills/grapevine/`.

---

### Task 1: Port-file ownership guard (the fix)

**Files:** Modify `scripts/daemon.ts` (`shutdown`, ~901-913). Test:
`cli.test.ts`.

**Interfaces:**

- Produces: `shutdown(code)` removes `PORT_FILE` only if its content
  `=== String(server.port)`, and `PID_FILE` only if its content
  `=== String(process.pid)`. A small exported helper
  `fileHasValue(path, expected): boolean` for unit testing.

- [ ] **Step 1: Write the failing integration test** (reproduces the incident)

Add to `cli.test.ts`:

```ts
test("a stale daemon's shutdown does not delete a newer daemon's port/pid files (V1.9 ownership guard)", async () => {
  // Start a real daemon (becomes authoritative for this HOME).
  await bunRun(["start"]);
  const before = JSON.parse((await bunRun(["doctor"])).stdout);
  const livePid = before.authoritative.pid as number;
  const livePort = before.authoritative.port as number;

  // Simulate a NEWER daemon having claimed the files: overwrite port/pid with
  // foreign values the running daemon does NOT own.
  const portFile = join(HOME, "daemon.port");
  const pidFile = join(HOME, "daemon.pid");
  writeFileSync(portFile, "59999");
  writeFileSync(pidFile, "999999");

  // SIGTERM the (now non-owning) daemon — its shutdown must NOT delete the
  // foreign files (pre-fix it deleted unconditionally).
  process.kill(livePid, "SIGTERM");
  await sleep(600);

  expect(existsSync(portFile)).toBe(true);
  expect(readFileSync(portFile, "utf-8").trim()).toBe("59999");
  expect(existsSync(pidFile)).toBe(true);
  expect(readFileSync(pidFile, "utf-8").trim()).toBe("999999");
  // (livePort referenced so lint is happy; the daemon is gone now)
  expect(typeof livePort).toBe("number");

  // cleanup the foreign files so later tests start clean
  try {
    rmSync(portFile);
  } catch {}
  try {
    rmSync(pidFile);
  } catch {}
});
```

Ensure `writeFileSync`/`readFileSync`/`existsSync`/`rmSync` are imported from
`node:fs` in the test (most are already).

- [ ] **Step 2: Run it — expect FAIL** (the daemon deletes the foreign files)

Run:
`bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts -t "ownership guard"`
Expected: FAIL — files are gone after SIGTERM.

- [ ] **Step 3: Implement the ownership guard** in `daemon.ts`

Add a helper near `shutdown`:

```ts
// True iff the file exists and its trimmed content equals `expected`. Used so a
// stale daemon never deletes lifecycle files a newer daemon now owns.
function fileHasValue(path: string, expected: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, "utf-8").trim() === expected;
  } catch {
    return false;
  }
}
```

Rewrite the cleanup in `shutdown`:

```ts
function shutdown(code: number) {
  try {
    if (server && fileHasValue(PORT_FILE, String(server.port)))
      unlinkSync(PORT_FILE);
    if (fileHasValue(PID_FILE, String(process.pid))) unlinkSync(PID_FILE);
  } catch {}
  if (server) {
    Promise.race([
      server.stop(true),
      new Promise((r) => setTimeout(r, 200)),
    ]).finally(() => process.exit(code));
  } else {
    process.exit(code);
  }
}
```

(Confirm `readFileSync` is imported in daemon.ts — it is, per the startup code.)

- [ ] **Step 4: Run tests — expect PASS** (full suite)

Run: `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` Expected:
PASS — the foreign files survive; normal start/stop still cleans up its own
files (covered by existing stop/restart tests).

- [ ] **Step 5: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/daemon.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "fix(grapevine): daemon shutdown only deletes port/pid files it owns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Daemon classifier + `reap` verb

**Files:** Modify `scripts/cli.ts` (add `lsofListenPort`, `classifyDaemon`,
`cmdReap`, wire `reap`, HELP). Test: `cli.test.ts`.

**Interfaces:**

- Produces:
  - `lsofListenPort(pid: number): Promise<number | null>` — the daemon's
    listening 127.0.0.1 port via `lsof -aiTCP -sTCP:LISTEN -p <pid> -P -n`, or
    null if unavailable.
  - `type DaemonStatus = "authoritative" | "orphan" | "unresponsive" | "unknown"`
  - `classifyDaemon(pid: number): Promise<{ pid; port: number|null; home?: string; version?: string|null; status: DaemonStatus; reapable: boolean }>`
    — resolve port (lsof) → `GET /` → compare `home/daemon.port`+`daemon.pid` to
    decide. **Defaults to keep on uncertainty:** `unknown` (no port) → not
    reapable; `unresponsive` (no `GET /`) → reapable only when caller opts in;
    `orphan` (home doesn't point back) → reapable; `authoritative` → not
    reapable.
  - `cmdReap(opts: { force?: boolean; dryRun?: boolean })` — list all grapevine
    daemons (the doctor `ps` scan), classify each, kill the reapable ones (skip
    `unresponsive` unless `--force`; NEVER the current-HOME authoritative),
    print `{ kept: [...], reaped: [...], skipped: [...] }`.
  - `reap` / `prune` verbs (+ `--force`, `--dry-run`); `dry-run` is a boolean
    flag.

- [ ] **Step 1: Write the failing tests**

`classifyDaemon` is the unit-testable core. Add:

```ts
test("classifyDaemon: a daemon whose own HOME points back to it is authoritative; otherwise orphan (V1.9)", async () => {
  // Start a real daemon in this HOME — it writes HOME/daemon.port + daemon.pid.
  await bunRun(["start"]);
  const doc = JSON.parse((await bunRun(["doctor"])).stdout);
  const pid = doc.authoritative.pid as number;
  const { classifyDaemon } = await import("./cli.ts");

  const auth = await classifyDaemon(pid);
  expect(auth.status).toBe("authoritative");
  expect(auth.reapable).toBe(false);

  // Now clobber HOME's port file so the live daemon is no longer recognized by
  // its own home → it classifies as an orphan (reapable).
  writeFileSync(join(HOME, "daemon.port"), "59998");
  const orphan = await classifyDaemon(pid);
  expect(orphan.status).toBe("orphan");
  expect(orphan.reapable).toBe(true);

  // restore so teardown/stop is clean
  await bunRun(["stop"]);
});
```

And an integration test for `reap` (spawn an orphan, reap, assert it dies + the
authoritative survives):

```ts
test("reap kills an orphan daemon but never the authoritative (V1.9)", async () => {
  await bunRun(["start"]); // authoritative for HOME
  const auth = JSON.parse((await bunRun(["doctor"])).stdout).authoritative;

  // Spawn an orphan: a daemon under a DIFFERENT, throwaway home dir, then delete
  // that home's port file so nothing recognizes it.
  const orphanHome = mkdtempSync(join(tmpdir(), "gv-orphan-"));
  const op = spawn(process.execPath, [join(import.meta.dir, "daemon.ts")], {
    env: { ...process.env, GRAPEVINE_HOME: orphanHome },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  TRACKED_PROCS.add(op);
  await sleep(800);
  rmSync(join(orphanHome, "daemon.port"), { force: true }); // now an orphan

  const res = JSON.parse((await bunRun(["reap"])).stdout);
  await sleep(300);
  expect(res.reaped.some((r: { pid: number }) => r.pid === op.pid)).toBe(true);
  expect(res.kept.some((k: { pid: number }) => k.pid === auth.pid)).toBe(true);
  // the authoritative daemon is still alive
  expect(JSON.parse((await bunRun(["doctor"])).stdout).authoritative.pid).toBe(
    auth.pid
  );

  TRACKED_PROCS.delete(op);
  rmSync(orphanHome, { recursive: true, force: true });
  await bunRun(["stop"]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`classifyDaemon`/`reap` not defined)

Run:
`bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts -t "classifyDaemon"`
then `-t "reap"`. Expected: FAIL.

- [ ] **Step 3: Implement `lsofListenPort`, `classifyDaemon`, `cmdReap`**

In `cli.ts` (export `classifyDaemon` so the test can import it):

```ts
export type DaemonStatus =
  | "authoritative"
  | "orphan"
  | "unresponsive"
  | "unknown";

async function lsofListenPort(pid: number): Promise<number | null> {
  try {
    const proc = spawn(
      "lsof",
      ["-aiTCP", "-sTCP:LISTEN", "-p", String(pid), "-P", "-n"],
      {
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (b) => chunks.push(b as Buffer));
    await new Promise<void>((r) => proc.on("exit", () => r()));
    const m = Buffer.concat(chunks)
      .toString("utf-8")
      .match(/127\.0\.0\.1:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

export async function classifyDaemon(pid: number): Promise<{
  pid: number;
  port: number | null;
  home?: string;
  version?: string | null;
  status: DaemonStatus;
  reapable: boolean;
}> {
  const port = await lsofListenPort(pid);
  if (!port) return { pid, port: null, status: "unknown", reapable: false };
  let info: RootInfo | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) info = (await res.json()) as RootInfo;
  } catch {}
  if (!info) return { pid, port, status: "unresponsive", reapable: false }; // reap only with --force (handled in cmdReap)
  const home = info.data_dir as string;
  let owns = false;
  try {
    const op = readFileSync(join(home, "daemon.port"), "utf-8").trim();
    const oi = readFileSync(join(home, "daemon.pid"), "utf-8").trim();
    owns = op === String(port) && oi === String(pid);
  } catch {}
  return owns
    ? {
        pid,
        port,
        home,
        version: info.version ?? null,
        status: "authoritative",
        reapable: false,
      }
    : {
        pid,
        port,
        home,
        version: info.version ?? null,
        status: "orphan",
        reapable: true,
      };
}
```

`cmdReap` (reuse doctor's `ps` scan to enumerate grapevine `daemon.ts` pids;
extract that scan into a shared `listGrapevineDaemonPids(): Promise<number[]>`
and call it from both doctor and reap):

```ts
async function cmdReap(opts: { force?: boolean; dryRun?: boolean }) {
  const selfPort = await readDaemonPort(); // current HOME authoritative (never reap)
  let selfPid: number | null = null;
  if (selfPort) {
    try {
      selfPid = (await api<RootInfo>(selfPort, "GET", "/")).data?.pid ?? null;
    } catch {}
  }
  const pids = await listGrapevineDaemonPids();
  const kept: unknown[] = [],
    reaped: unknown[] = [],
    skipped: unknown[] = [];
  for (const pid of pids) {
    const c = await classifyDaemon(pid);
    const isSelf = pid === selfPid;
    const shouldReap =
      !isSelf &&
      (c.reapable || (c.status === "unresponsive" && opts.force === true));
    if (!shouldReap) {
      kept.push(c);
      continue;
    }
    if (opts.dryRun) {
      skipped.push({ ...c, note: "dry-run" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(c);
    } catch {
      skipped.push({ ...c, note: "kill failed" });
    }
  }
  printJson({ ok: true, dry_run: !!opts.dryRun, kept, reaped, skipped });
}
```

Wire verbs in `main`:

```ts
    case "reap":
    case "prune":
      await cmdReap({ force: flags.force === true, dryRun: flags["dry-run"] === true });
      return 0;
```

Add `"dry-run"` to `BOOLEAN_FLAGS` (`force` already present). Refresh HELP with
`reap [--force] [--dry-run]`.

> Extract `listGrapevineDaemonPids()` from the existing doctor `ps` scan (cli.ts
> ~956-979) so doctor (Task 3) and reap share one enumerator.

- [ ] **Step 4: Run tests — expect PASS**

Run: `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` Expected:
PASS. (If the orphan test is timing-sensitive, widen the `sleep`s.)

- [ ] **Step 5: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): ownership-aware reap verb + daemon classifier

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Smarter `doctor` (label other daemons)

**Files:** Modify `scripts/cli.ts` (`cmdDoctor`). Test: `cli.test.ts`.

**Interfaces:**

- Consumes: `classifyDaemon`, `listGrapevineDaemonPids` (Task 2).
- Produces: each `other_daemons_on_machine` entry gains `port`/`home`/`version`/
  `status`/`reapable`; hints recommend `reap` when any are reapable and
  `reap --force` when any are `unresponsive`.

- [ ] **Step 1: Write the failing test**

```ts
test("doctor labels other daemons with status + reapable (V1.9)", async () => {
  await bunRun(["start"]);
  const orphanHome = mkdtempSync(join(tmpdir(), "gv-orphan2-"));
  const op = spawn(process.execPath, [join(import.meta.dir, "daemon.ts")], {
    env: { ...process.env, GRAPEVINE_HOME: orphanHome },
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  TRACKED_PROCS.add(op);
  await sleep(800);
  rmSync(join(orphanHome, "daemon.port"), { force: true });

  const doc = JSON.parse((await bunRun(["doctor"])).stdout);
  const entry = doc.other_daemons_on_machine.find(
    (d: { pid: number }) => d.pid === op.pid
  );
  expect(entry).toBeTruthy();
  expect(entry.status).toBe("orphan");
  expect(entry.reapable).toBe(true);
  expect(doc.hints.some((h: string) => h.includes("reap"))).toBe(true);

  op.kill("SIGTERM");
  TRACKED_PROCS.delete(op);
  rmSync(orphanHome, { recursive: true, force: true });
  await bunRun(["stop"]);
});
```

- [ ] **Step 2: Run — expect FAIL** (entries lack `status`/`reapable`)

- [ ] **Step 3: Implement** — in `cmdDoctor`, replace the raw `otherDaemons`
      build with the shared enumerator + classifier:

```ts
const otherDaemons: Array<
  Awaited<ReturnType<typeof classifyDaemon>> & { command?: string }
> = [];
const selfPid = authoritative?.pid as number | undefined;
for (const pid of await listGrapevineDaemonPids()) {
  if (selfPid && pid === selfPid) continue;
  otherDaemons.push(await classifyDaemon(pid));
}
```

Update the hints block: if `otherDaemons.some(d => d.reapable)` →
`"Found N reapable orphan daemon(s). Run \`grapevine reap\` to clear them
safely."`; if `otherDaemons.some(d => d.status === "unresponsive")`→`"Some
daemons are unresponsive; \`grapevine reap --force\` includes them."`. Keep the
existing version-skew + subscriber hints.

- [ ] **Step 4: Run tests — expect PASS** (full suite)

- [ ] **Step 5: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): doctor labels other daemons (status/home/version/reapable)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `stop --hold` + respawn suppression

**Files:** Modify `scripts/cli.ts` (`cmdStop`, `ensureDaemon`, `BOOLEAN_FLAGS`/
flag parse), `scripts/daemon.ts` (honor hold on startup). Test: `cli.test.ts`.

**Interfaces:**

- Produces:
  - `HOLD_FILE = join(DATA_DIR, "daemon.hold")` (both files).
  - `stop --hold <seconds>` — writes `HOLD_FILE` with an expiry epoch-ms, then
    stops. `releaseHold()` removes it (used by `roll`).
  - `ensureDaemon` honors a live hold: if `HOLD_FILE` exists and is unexpired,
    it does NOT spawn (returns null / a clear "held" signal) — a stale CLI can't
    win the respawn race during an upgrade. An expired hold is ignored +
    cleaned.
  - daemon startup also refuses/clears nothing extra (the CLI is the spawner;
    the hold lives CLI-side) — but the daemon should delete an expired
    `HOLD_FILE` it finds at startup for tidiness.

- [ ] **Step 1: Write the failing test**

```ts
test("stop --hold suppresses respawn for the window (V1.9)", async () => {
  await bunRun(["start"]);
  const stop = await bunRun(["stop", "--hold", "3"]);
  expect(JSON.parse(stop.stdout).held_until).toBeGreaterThan(Date.now());

  // A verb that would normally ensureDaemon must NOT spawn while held.
  const held = await bunRun(["start"]);
  const parsed = JSON.parse(held.stdout);
  expect(parsed.held).toBe(true);
  expect(parsed.port ?? null).toBe(null);
  expect(existsSync(join(HOME, "daemon.port"))).toBe(false);

  // After the hold expires, a verb spawns normally.
  await sleep(3200);
  const after = await bunRun(["start"]);
  expect(JSON.parse(after.stdout).port).toBeGreaterThan(0);
  await bunRun(["stop"]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`--hold` ignored; start respawns
      immediately)

- [ ] **Step 3: Implement**

`cli.ts` — add `HOLD_FILE` const; helpers:

```ts
function holdActive(): number | null {
  try {
    if (!existsSync(HOLD_FILE)) return null;
    const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now()) return until;
    try {
      unlinkSync(HOLD_FILE);
    } catch {} // expired → clean
    return null;
  } catch {
    return null;
  }
}
function releaseHold() {
  try {
    if (existsSync(HOLD_FILE)) unlinkSync(HOLD_FILE);
  } catch {}
}
```

`ensureDaemon` — honor the hold at the top:

```ts
async function ensureDaemon(): Promise<number> {
  let port = await readDaemonPort();
  if (port) return port;
  if (holdActive())
    die(
      "daemon is held (respawn suppressed) — wait for the hold to clear or run `grapevine roll`"
    );
  // …existing spawn…
}
```

`cmdStart` — surface the hold instead of dying, so `start` reports it cleanly:

```ts
async function cmdStart() {
  const existing = await readDaemonPort();
  if (!existing && holdActive()) {
    printJson({ ok: true, held: true, port: null });
    return;
  }
  const port = existing ?? (await ensureDaemon());
  printJson({ ok: true, port, already_running: existing !== null });
}
```

`cmdStop` — accept `--hold <seconds>`:

```ts
async function cmdStop(opts: { holdSeconds?: number }) {
  if (opts.holdSeconds && opts.holdSeconds > 0) {
    const until = Date.now() + opts.holdSeconds * 1000;
    try {
      writeFileSync(HOLD_FILE, String(until));
    } catch {}
  }
  const port = await readDaemonPort();
  if (!port) {
    printJson({
      ok: true,
      daemon: false,
      ...(opts.holdSeconds
        ? { held_until: Date.now() + opts.holdSeconds * 1000 }
        : {}),
    });
    return;
  }
  try {
    await api(port, "DELETE", "/");
  } catch {}
  printJson({
    ok: true,
    stopped: true,
    ...(opts.holdSeconds
      ? { held_until: Date.now() + opts.holdSeconds * 1000 }
      : {}),
  });
}
```

Dispatch:
`case "stop": await cmdStop({ holdSeconds: flags.hold ? parseInt(String(flags.hold), 10) : undefined }); return 0;`
(`hold` is a value flag — NOT in BOOLEAN_FLAGS). `daemon.ts` startup — after
`ensureDirs()`, delete an expired hold file for tidiness (the hold is enforced
CLI-side; this just prevents a stale file lingering): optional, low priority —
include a one-liner that unlinks `HOLD_FILE` if expired.

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/daemon.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): stop --hold suppresses daemon respawn during a roll

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `roll` verb (one-command safe re-roll)

**Files:** Modify `scripts/cli.ts` (`cmdRoll`, wire `roll`, HELP). Test:
`cli.test.ts`.

**Interfaces:**

- Consumes: `fetchActiveSubscribers`, `readDaemonPort`, `ensureDaemon`,
  `holdActive`/`releaseHold` (Task 4), `PLUGIN_VERSION`.
- Produces: `roll [--force]` — refuse on active subscribers without `--force`
  (like restart) → `stop` with a short hold → wait for the old daemon to vanish
  → release hold → `ensureDaemon` (spawns from THIS CLI's path) → `GET /` and
  verify `version === PLUGIN_VERSION` → print
  `{ ok, rolled, previous_pid, pid, port, version, version_ok }`.

- [ ] **Step 1: Write the failing test**

```ts
test("roll restarts the daemon and verifies the version (V1.9)", async () => {
  await bunRun(["start"]);
  const before = JSON.parse((await bunRun(["doctor"])).stdout).authoritative;

  const res = JSON.parse((await bunRun(["roll"])).stdout);
  expect(res.rolled).toBe(true);
  expect(res.previous_pid).toBe(before.pid);
  expect(res.pid).not.toBe(before.pid); // a fresh daemon
  expect(res.version_ok).toBe(true); // matches the CLI's PLUGIN_VERSION
  expect(JSON.parse((await bunRun(["doctor"])).stdout).authoritative.pid).toBe(
    res.pid
  );
  await bunRun(["stop"]);
});

test("roll refuses active subscribers without --force (V1.9)", async () => {
  await bunRun(["open", "roll_live"]);
  const tail = spawn(
    process.execPath,
    [CLI, "tail", "roll_live", "--as", "seat"],
    {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  TRACKED_PROCS.add(tail);
  await sleep(400);
  const blocked = await bunRun(["roll"]);
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toContain("--force");
  tail.kill("SIGTERM");
  TRACKED_PROCS.delete(tail);
  await sleep(200);
  await bunRun(["close", "roll_live"]);
  await bunRun(["stop"]);
});
```

- [ ] **Step 2: Run — expect FAIL** (`roll` undefined)

- [ ] **Step 3: Implement `cmdRoll`**

```ts
async function cmdRoll(opts: { force?: boolean }) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh = await ensureDaemon();
    printJson({ ok: true, rolled: true, previous_pid: null, port: fresh });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels
      .map((c) => `${c.name} (${c.connections})`)
      .join(", ");
    die(
      `roll: ${total} active subscriber(s) — ${where}. They'll auto-reconnect across the roll. Re-run with --force to proceed.`
    );
  }
  let previousPid: number | null = null;
  try {
    previousPid = (await api<RootInfo>(port, "GET", "/")).data?.pid ?? null;
  } catch {}
  // Stop with a short hold so a stale CLI can't win the respawn race; we hold the spawn ourselves.
  const holdMs = 4000;
  try {
    writeFileSync(HOLD_FILE, String(Date.now() + holdMs));
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if ((await readDaemonPort()) === null) break;
  }
  releaseHold(); // our turn to spawn the new version
  const fresh = await ensureDaemon();
  let version: string | null = null;
  try {
    version = (await api<RootInfo>(fresh, "GET", "/")).data?.version ?? null;
  } catch {}
  let pid: number | null = null;
  try {
    pid = (await api<RootInfo>(fresh, "GET", "/")).data?.pid ?? null;
  } catch {}
  printJson({
    ok: true,
    rolled: true,
    previous_pid: previousPid,
    pid,
    port: fresh,
    version,
    version_ok: version === PLUGIN_VERSION,
  });
}
```

Wire:
`case "roll": await cmdRoll({ force: flags.force === true || flags.yes === true }); return 0;`.
HELP:
`roll [--force]   safely restart the daemon (stop+hold+respawn) and verify the version`.

- [ ] **Step 4: Run tests — expect PASS** (full suite, twice for determinism —
      live-subscriber test)

- [ ] **Step 5: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): roll verb — one-command safe re-roll with version verify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Documentation — HELP + SKILL.md

**Files:** `scripts/cli.ts` (HELP), `SKILL.md`. Test: help renders + suite
green.

- [ ] **Step 1:** Ensure HELP lists `reap [--force] [--dry-run]`,
      `roll [--force]`, `stop [--hold <s>]`. Add a SKILL.md "Operator /
      maintenance" subsection documenting: the ownership guard (why stale
      daemons no longer wipe live files), `doctor` labels, `reap` (safe orphan
      cleanup), `stop --hold`, and `roll` (the one-command deploy). One worked
      example:

```
grapevine doctor        # labels each daemon: authoritative / orphan / stale
grapevine reap          # kill only the orphans, never the live daemon
grapevine roll          # safe restart + version verify (after a release)
```

- [ ] **Step 2:** `bun plugins/spellbook/skills/grapevine/scripts/cli.ts help`
      renders the new verbs; `bun test …/cli.test.ts` green.
- [ ] **Step 3: Commit**
      (`docs(grapevine): document reap, roll, stop --hold, doctor labels`).

---

## Finalize (controller-run)

- [ ] Whole-branch review (opus) over the branch range.
- [ ] **ward (spell revision):** bun test green; narrative banner — note the
      operator hardening (a V1.8.x line in the banner, or fold under V1.8 since
      it's same-cycle back-end — controller decides); capture the
      `exit-cleanup-must-verify-ownership` scenario in `grimoire/scenarios/`
      (the incident's distilled judgment); decay-ledger "daemon + thin CLI" row
      reinforce; roster unchanged; version via release-please feat commits.
- [ ] **Live smoke (isolated temp HOME, dev tree):** ownership guard (the
      reproduce-the-incident sequence by hand), `reap --dry-run` then `reap` on
      a spawned orphan, `doctor` labels, `stop --hold`, `roll` + version verify;
      no zombies left.
- [ ] Merge to `develop` locally; Cole pushes + release.
- [ ] **After release: roll the production daemon with the new `roll` verb**
      (the first dogfood of the automation) — but only on Cole's go,
      coordinating the dream-flute live session as before.

## Self-Review

**Spec coverage:** ownership guard (T1) ✓; classifier + reap (T2) ✓; doctor
labels (T3) ✓; stop --hold + respawn suppression (T4) ✓; roll (T5) ✓; docs (T6)
✓; ward scenario + smoke (Finalize) ✓.

**Type/shared-piece consistency:** `classifyDaemon` (T2) is reused by `doctor`
(T3); `listGrapevineDaemonPids` extracted in T2, used by both reap + doctor;
`HOLD_FILE`/`holdActive`/`releaseHold` (T4) reused by `roll` (T5); `RootInfo`
(existing) carries `pid`/`data_dir`/`version` used everywhere. `force` already
in `BOOLEAN_FLAGS`; `dry-run` added in T2; `hold` is a value flag (not boolean).

**Safety review:** reap defaults to keep on uncertainty
(`unknown`/`unresponsive` not reaped without `--force`); never reaps the
current-HOME authoritative; the ownership guard means even a mis-reap can't wipe
a live daemon's files.

**Ordering:** T1 (independent fix) → T2 (classifier + reap) → T3 (doctor reuses
classifier) → T4 (hold) → T5 (roll uses hold) → T6 (docs). No collisions: T2/T3
share the enumerator (built in T2); T4/T5 share the hold (built in T4).
