// PART OF THE BOUNTY DAEMON SUITE: server.test.ts plus its server.*.test.ts
// siblings, one file once (7,177 lines, about 128 s alone). It was split by
// describe block so a parallel run is not floored by one file; every test body
// is unchanged. The shared harness (spawn helpers, hermeticEnv, the suite's
// private TMPDIR) is fixtures/serverSuite.ts, evaluated once per file, so each
// file holds its own TMPDIR exactly as the single file did.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardState } from "../../../plugins/spellbook/skills/bounty/shared/types";
import {
  CLI,
  hermeticEnv,
  liveTaskCount,
  refusal,
  runCli,
  runOpen,
  snapshotTaskCountAt,
  TEST_TMPDIR,
  uniqHome,
} from "./fixtures/serverSuite.ts";

describe("P0b — open refuses rather than discarding flags on the attach path", () => {
  test("PRECONDITION + RED PRE-FIX — live 0 over snapshot 2, then --restore is REFUSED", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-"));
    const key = `p0b-${crypto.randomUUID().slice(0, 8)}`;

    // Step 1 — a board with two tasks.
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const board = JSON.parse(first.stdout) as { session_id: string; port: number };
    const id = board.session_id;
    await runCli(["add", "alpha", "--id", "a1", "--session", id], { env: { BOUNTY_HOME: home } });
    await runCli(["add", "beta", "--id", "b1", "--session", id], { env: { BOUNTY_HOME: home } });

    // Step 2 — POLL the snapshot to 2. Never a fixed sleep: the flush is a ~1s
    // debounce (server.ts:708 marks dirty, :1238 drains), so a sleep either
    // races or is pure padding.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && snapshotTaskCountAt(home, id) !== 2) await Bun.sleep(100);
    expect(snapshotTaskCountAt(home, id)).toBe(2);

    // Step 3 — kill -9. NOT close: close writes the snapshot (server.ts:1286),
    // which would flush the board we are about to empty OVER the fixture. And
    // the PID does not come from the discovery file, which carries url/port/
    // session_id/title and NO pid — a kill built on it silently no-ops, step 4
    // "respawns" onto the still-live board, and the precondition degenerates to
    // live=2/snapshot=2 while looking clean. The --id is unique, unlike the
    // shared `scripts/server.ts` argv that once cost this repo a live daemon.
    const pgrep = Bun.spawn({
      cmd: ["pgrep", "-f", "--", `--id ${id}`],
      stdout: "pipe",
      stderr: "ignore",
      env: { ...hermeticEnv() },
    });
    const pids = (await new Response(pgrep.stdout).text()).trim().split("\n").filter(Boolean);
    await pgrep.exited;
    expect(pids.length).toBeGreaterThan(0); // the kill has a target
    for (const pid of pids) process.kill(Number(pid), "SIGKILL");
    const gone = Date.now() + 5000;
    while (Date.now() < gone) {
      try {
        await fetch(`http://127.0.0.1:${board.port}/state?lean=1`);
        await Bun.sleep(100);
      } catch {
        break; // refused — it is down
      }
    }

    // Step 4 — respawn EMPTY under the same key, without mutating anything.
    //
    // ⚠ `--fresh` is now REQUIRED to construct this. Before b7 a keyed respawn
    // came up empty on its own and this line relied on that; b7 makes a keyed
    // respawn RESTORE its snapshot, so "empty board over a populated snapshot"
    // must be asked for explicitly. The scenario under test is unchanged — only
    // the way it is built. (This cell's own precondition guard caught the change:
    // it printed DEGENERATE rather than passing quietly.)
    const second = await runOpen(["--session-key", key, "--fresh", "--no-open"], { home, cwd });
    const revived = JSON.parse(second.stdout) as { session_id: string; port: number };
    expect(revived.session_id).toBe(id); // same key ⇒ same board id

    // Step 5 — THE PRECONDITION AS ITS OWN ASSERTED CELL. Printed as
    // VALID-CONTROL / DEGENERATE, because a probe that cannot announce its own
    // control is invalid is a probe that will eventually lie — and this exact
    // control has been degenerate three separate times in this project.
    const liveNow = await liveTaskCount(revived.port);
    const snapNow = snapshotTaskCountAt(home, id);
    const control = liveNow === 0 && snapNow === 2 ? "VALID-CONTROL" : "DEGENERATE";
    expect({ control, live: liveNow, snapshot: snapNow }).toEqual({
      control: "VALID-CONTROL",
      live: 0,
      snapshot: 2,
    });

    try {
      // Step 6 — THE MEASUREMENT. This is the reported user situation exactly:
      // board live and empty, the only real data in the snapshot, --restore the
      // only lever. Today it exits 0 and says nothing.
      const measured = await runOpen(["--session-key", key, "--restore", id, "--no-open"], {
        home,
        cwd,
      });
      expect(measured.code).not.toBe(0);
      const env = JSON.parse(measured.stdout) as {
        restoreSkipped: { requested: string[]; reason: string } | null;
      };
      expect(env.restoreSkipped).not.toBeNull();
      expect(env.restoreSkipped?.requested).toContain("restore");

      // The refusal names NO corrective verb (Cole, 2026-08-06). --fresh
      // --restore is MEASURED to destroy the snapshot it restores from, so a
      // user in exactly this situation would follow the advice and lose the
      // only copy of their data. This cell is what keeps a later "helpful"
      // edit from putting it back.
      const spoken = `${measured.stdout}\n${measured.stderr}`;
      expect(spoken).not.toContain("--fresh");
      expect(spoken).not.toContain("kill");
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 60000);

  test("RED PRE-FIX — restoreSkipped is PRESENT and null when nothing was skipped", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-null-"));
    const key = `p0b-null-${crypto.randomUUID().slice(0, 8)}`;
    const spawned = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(spawned.stdout) as { session_id: string }).session_id;
    try {
      // Both success paths carry it: the SPAWN path here, the ATTACH path below.
      // `in` is the assertion with teeth — `=== null` alone passes when the key
      // is absent entirely, so a fix that emits the field only when it skips
      // would sail through the weaker check while violating the ruling.
      for (const [path, out] of [
        ["spawn", spawned.stdout],
        ["attach", (await runOpen(["--session-key", key, "--no-open"], { home, cwd })).stdout],
      ] as const) {
        const env = JSON.parse(out) as Record<string, unknown>;
        expect({ path, present: "restoreSkipped" in env }).toEqual({ path, present: true });
        expect({ path, value: env.restoreSkipped }).toEqual({ path, value: null });
      }
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);

  test("RED PRE-FIX — EACH discarded flag refuses (the lane is the SET, not --restore)", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-set-"));
    const key = `p0b-set-${crypto.randomUUID().slice(0, 8)}`;
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    try {
      // G4: the invocations are named, not "for each discarded flag". A fix that
      // refuses on --restore alone — which is how this lane was described for a
      // whole sprint — must FAIL this cell. --title and --timeout are appended
      // BEFORE --restore, so a positional reading of the bug misses both.
      for (const [flag, args] of [
        ["restore", ["--restore", id]],
        ["timeout", ["--timeout", "14400"]],
        ["title", ["--title", "a new title"]],
      ] as const) {
        const r = await runOpen(["--session-key", key, "--no-open", ...args], { home, cwd });
        const env = JSON.parse(r.stdout) as { restoreSkipped: { requested: string[] } | null };
        expect({ flag, code: r.code === 0 }).toEqual({ flag, code: false });
        expect({ flag, requested: env.restoreSkipped?.requested }).toEqual({
          flag,
          requested: [flag],
        });
      }
      // And the SET together, in one invocation: all three named at once.
      const all = await runOpen(
        ["--session-key", key, "--no-open", "--title", "t", "--timeout", "99", "--restore", id],
        { home, cwd },
      );
      const allEnv = JSON.parse(all.stdout) as { restoreSkipped: { requested: string[] } | null };
      expect(allEnv.restoreSkipped?.requested.sort()).toEqual(["restore", "timeout", "title"]);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 60000);

  test("BLAST-RADIUS GUARD — --pin and --no-open are HONOURED on attach and still exit 0", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-guard-"));
    const key = `p0b-guard-${crypto.randomUUID().slice(0, 8)}`;
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    try {
      // ⛔ THIS PASSES TODAY AND MUST KEEP PASSING. It is not a red cell and
      // demanding it fail would send someone to manufacture a break.
      //
      // The literal invocation is how EVERY anthill seat rejoins a live team
      // board. An implementation that refuses on "any flag appended past the
      // return" makes every seat's rejoin exit non-zero — this lane inflicting
      // an instance of the very thesis it was written to cure. --no-open is
      // VACUOUSLY honoured (nothing to open on an attach) and --pin is REALLY
      // honoured (it runs inside the attach branch), so neither is in the set.
      // ⚠ THIS CELL ASSERTS ONLY WHAT IS TRUE IN BOTH WORLDS — exit 0, and the
      // pin written. Nothing about `restoreSkipped` belongs here: that field
      // does not exist pre-fix, so asserting it would make this cell FAIL under
      // the mutation and it would no longer be a blast-radius guard at all. It
      // would be a red cell wearing a guard's label, and a report counting it as
      // a guard would overstate the guard population by one — the exact
      // success-shaped arithmetic this sprint is named after.
      //
      // MEASURED: the first version of this cell did exactly that. It carried
      // the `restoreSkipped` assertions and failed under the mutation, which is
      // how the mislabelling was found. The null-arm cell above owns that
      // property, on both the spawn and attach paths.
      const rejoin = await runOpen(["--session-key", key, "--pin", "--no-open"], { home, cwd });
      expect(rejoin.code).toBe(0);
      expect(readFileSync(join(cwd, ".bounty-session"), "utf8").trim()).toBe(id);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 60000);

  test("RED PRE-FIX — a REFUSED invocation still honours --pin (honour-what-you-can)", async () => {
    // Ruled by prospero 2026-08-06, and pinned separately from the guard above
    // because it is a DIFFERENT label: pre-fix this invocation exits 0 and never
    // refuses at all, so this cell is red today. The behaviour it fixes: --pin
    // is not in the lost-effect set, so withholding it on a refusal would make
    // one flag's outcome depend on an unrelated flag — the over-inclusive error
    // spelled as a side effect instead of an exit code.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-hwyc-"));
    const key = `p0b-hwyc-${crypto.randomUUID().slice(0, 8)}`;
    const first = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(first.stdout) as { session_id: string }).session_id;
    try {
      const both = await runOpen(["--session-key", key, "--pin", "--restore", id, "--no-open"], {
        home,
        cwd,
      });
      expect(both.code).not.toBe(0); // refused, for --restore
      expect(readFileSync(join(cwd, ".bounty-session"), "utf8").trim()).toBe(id); // pinned anyway
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);
});

// ── P0b's two load-bearing snapshot facts ────────────────────────────────
// Both cells below are PRECONDITION, never counted as evidence about the fix:
// they pin facts about server.ts that are TRUE IN BOTH WORLDS and that the
// construction above depends on. They pass under the mutation, by design.
// Both were measured on 2026-08-06 and NEITHER was guarded by a test. They are
// the facts the construction above depends on, and a doc claim drifts under its
// own code while failing no gate — so they are pinned here, in this lane, not as
// a follow-up.
describe("P0b — the snapshot facts the construction rests on", () => {
  test("FACT 1 — `close` WRITES the snapshot, so closing an empty board clobbers a full one", async () => {
    // This is #73, and it is why the construction kills -9 instead of closing.
    // It is also why the refusal names no corrective verb: `--fresh` tears down
    // by POSTing {type:"close"}, so advising `--fresh --restore` tells a user
    // whose only data is in the snapshot to destroy it first.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-f1-"));
    const key = `p0b-f1-${crypto.randomUUID().slice(0, 8)}`;
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "keep me", "--id", "k1", "--session", id], { env: { BOUNTY_HOME: home } });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && snapshotTaskCountAt(home, id) !== 1) await Bun.sleep(100);
    expect(snapshotTaskCountAt(home, id)).toBe(1); // PRECONDITION: a full snapshot exists

    await runCli(["remove", "k1", "--session", id], { env: { BOUNTY_HOME: home } });
    await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    await Bun.sleep(500);
    // close flushed the NOW-EMPTY board over the snapshot that held the task.
    expect(snapshotTaskCountAt(home, id)).toBe(0);
  }, 40000);

  test("FACT 2 — snapshots are NOT close-only: a mutation flushes on the ~1s debounce", async () => {
    // Why the construction POLLS the snapshot instead of sleeping, and why
    // "empty the live board, then read the snapshot" destroys its own fixture:
    // the emptying is itself a mutation and it flushes.
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p0b-f2-"));
    const key = `p0b-f2-${crypto.randomUUID().slice(0, 8)}`;
    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "solo", "--id", "s1", "--session", id], { env: { BOUNTY_HOME: home } });
      // No close anywhere in this cell — the flush must happen on its own.
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && snapshotTaskCountAt(home, id) !== 1) await Bun.sleep(100);
      expect(snapshotTaskCountAt(home, id)).toBe(1);
    } finally {
      await runCli(["close", "--session", id], { env: { BOUNTY_HOME: home } });
    }
  }, 40000);
});

// ── P0d / #83 — `add` was the only write verb that ignored `applied` ──────
//
// ⛔ THIS GATE REPLACES A DEFECTIVE ORIGINAL, which read: "`add` with a
// duplicate --id exits non-zero AND a subsequent `state` does not show the
// task." That is an INVERTED CONTROL — it FAILS against a correct fix. On a
// duplicate id `applyTaskAdd` returns false without touching state, so the
// ORIGINAL keeps that id by construction; the only implementation satisfying
// the old cell's literal reading is one that also destroys the original. A gate
// whose plain reading fails the correct implementation is worse than a
// decorative one: decoration passes silently, this produces a false FAIL and
// dispatches a builder to "fix" code that is already right.
//
// Labels below, and they are NOT all discriminating: 1 RED PRE-FIX + 2
// BLAST-RADIUS GUARDS. Reporting "3 cells green" would be a coverage claim
// three times its true size.
describe("P0d #83 — a duplicate add is a REFUSAL, not a silent success", () => {
  test("RED PRE-FIX — duplicate --id is a `conflict` (6) whose envelope says applied:false", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      const first = await runCli(
        ["add", "ORIGINAL TITLE", "--id", "dup-probe", "--owner", "alice", "--session", session],
        { env },
      );
      expect(first.code).toBe(0);

      // Today: {"ok":true,"sent":"task.add"} at exit 0 — the success-shaped lie.
      const second = await runCli(
        ["add", "IMPOSTOR TITLE", "--id", "dup-probe", "--owner", "bob", "--session", session],
        { env },
      );
      // D51 — the envelope moved to STDERR and the exit code became `conflict`
      // (6). It used to be a legacy `{ok:false,applied:false}` document on
      // stdout beside prose on stderr, at exit 1 — the taxonomy's "the spell
      // broke", for the refusal bounty produces most often.
      expect(second.code).toBe(6);
      expect(second.stdout).toBe("");
      const envelope = JSON.parse(second.stderr) as {
        error: { kind: string; message: string; server?: { applied?: boolean } };
      };
      expect(envelope.error.kind).toBe("conflict");
      // The daemon's OWN reply, verbatim, under `error.server` (D31's field) —
      // so `applied:false` is still readable without parsing a human line.
      expect(envelope.error.server?.applied).toBe(false);
      // The reason is named, not merely signalled — `applied:false` alone
      // conflated an invalid shape with a taken id and told the caller neither.
      expect(envelope.error.message).toContain("dup-probe");
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 40000);

  test("BLAST-RADIUS GUARD — the surviving row is the ORIGINAL, field for field", async () => {
    // ⚠ ALREADY TRUE PRE-FIX. Do not try to make it red. It catches a fix that
    // "resolves" the duplicate by overwriting — the failure mode the retired
    // literal reading could not see at all, and one that only the change itself
    // can introduce.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(
        ["add", "ORIGINAL TITLE", "--id", "dup2", "--owner", "alice", "--session", session],
        { env },
      );
      const before = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as {
        state: BoardState;
      };
      const original = before.state.tasks.find((t) => t.id === "dup2");

      await runCli(
        ["add", "IMPOSTOR TITLE", "--id", "dup2", "--owner", "bob", "--session", session],
        { env },
      );
      const after = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
      };
      const survivor = after.state.tasks.find((t) => t.id === "dup2");
      expect(survivor).toEqual(original);
      expect(survivor).toMatchObject({ title: "ORIGINAL TITLE", owner: "alice", status: "todo" });
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 40000);

  test("BLAST-RADIUS GUARD — task count AND cursor unchanged by the refusal", async () => {
    // ⚠ ALSO ALREADY TRUE PRE-FIX. The cursor is the cheapest strong tell that
    // the daemon REFUSED rather than applied-then-reverted: an apply would have
    // emitted an event and advanced it. Worth keeping for exactly that, and not
    // evidence that the fix works.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "one", "--id", "c1", "--session", session], { env });
      const before = JSON.parse(
        (await runCli(["state", "--session", session], { env })).stdout,
      ) as {
        state: BoardState;
        cursor: number;
      };
      await runCli(["add", "impostor", "--id", "c1", "--session", session], { env });
      const after = JSON.parse((await runCli(["state", "--session", session], { env })).stdout) as {
        state: BoardState;
        cursor: number;
      };
      expect(after.state.tasks).toHaveLength(before.state.tasks.length);
      expect(after.cursor).toBe(before.cursor);
    } finally {
      await runCli(["close", "--session", session], { env });
    }
  }, 40000);

  // ⚠ LABEL CORRECTED AFTER MEASUREMENT — it read RED PRE-FIX and it is not.
  // This cell passes pre-fix, because the DAEMON already answered honestly;
  // #83's defect was the CLI discarding that answer, and this cell drives the
  // daemon directly. The comment inside it said so while the label contradicted
  // it — the second time in one session I wrote the label and the assertions in
  // one act and the label recorded my INTENT rather than the cell's measured
  // behaviour. A label is a claim about a measurement and cannot be assigned
  // before the measurement is taken.
  test("BLAST-RADIUS GUARD — an UNRECOGNISED command type still answers applied:false", async () => {
    // bounty's own instance of #84's shape: the daemon's dispatch ends in
    // `return {ok:true, applied:false}` for any type it does not recognise, and
    // the CLI's generic path printed the transport ack regardless. This drives
    // it through the real wire rather than the CLI, because no CLI verb can
    // send an unknown type — the defect lives at the /cmd contract.
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "30"], { env });
    const board = JSON.parse(open.stdout) as { session_id: string; port: number };
    try {
      const r = await fetch(`http://127.0.0.1:${board.port}/cmd`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "zzz-not-a-real-command" }),
      });
      const body = (await r.json()) as { ok?: boolean; applied?: boolean };
      // The daemon already reported the truth here; #83 is that the CLI threw
      // it away. Pinning it means a future dispatch refactor cannot quietly
      // start answering `applied:true` to a command it drops.
      expect(body.applied).toBe(false);
    } finally {
      await runCli(["close", "--session", board.session_id], { env });
    }
  }, 40000);
});

// ── P0f (slice) — the `tail` write→exit pair ─────────────────────────────
//
// `tail` wrote the terminal frame and exited on the NEXT statement. Bun's
// stdout is async on a PIPE, so an explicit exit discards whatever has not
// drained — measured in this repo at exactly 65,536 bytes. `tail` is the verb
// agents leave running for hours, and the frames it loses are the ones saying
// the stream ended.
//
// G6 — DRIVEN THROUGH A REAL SHELL PIPE, `sh -c "… | cat"`. This is not a
// stylistic choice and a `runCli`-style `Bun.spawn({stdout:"pipe"})` CANNOT
// FAIL on this defect: measured on one board, the same payload read three ways
// gave 65536 / 114042 / 65536 — Bun.spawn's pipe is the one that reads
// COMPLETE. The engine seat wrote that gate last sprint, it passed, he restored
// the bug, and it passed again.
//
// G8 — the fixture is ONE event over the buffer, not many small ones, and the
// byte assertion comes BEFORE the parse so a fixture that silently shrinks
// fails loudly instead of passing vacuously.
//
// G7 — the process must EXIT. A drain fix trades a truncation for a hang
// wherever process.exit was load-bearing, and here the exit sits three loops
// deep. A hang would otherwise surface as a test timeout, which reads as
// flakiness rather than as the regression it is.
describe("P0f — tail drains its terminal frame before exiting", () => {
  test("RED PRE-FIX — a >64KiB replay survives tail's exit, and tail RETURNS", async () => {
    const home = uniqHome();
    const env = { BOUNTY_HOME: home };
    const open = await runCli(["open", "--no-open", "--timeout", "60"], { env });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;

    // ONE event whose payload exceeds 64 KiB — a single 100 KB title, not many
    // small events. `bounty tail` replays its entire event history, so a
    // --since 0 tail re-emits this frame and then the `closed` frame.
    const big = "x".repeat(1_000_000);
    const added = await runCli(["add", "--id", "big-1", "--stdin", "--session", id], {
      env,
      stdin: big,
    });
    expect(added.code).toBe(0);

    const proc = Bun.spawn({
      // ⚠ `| ( sleep 2; cat )` — a NON-DRAINING consumer, and it is the whole
      // fixture. See the note above the sleep below.
      cmd: ["sh", "-c", `bun run ${CLI} tail --since 0 --session ${id} | ( sleep 2; cat )`],
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...hermeticEnv(), BOUNTY_HOME: home },
    });

    // ⚠⚠ THE NON-DRAINING CONSUMER IS THE FIXTURE — a big payload alone is NOT
    // enough, and this cell was VACUOUS twice before it discriminated.
    //
    // MEASURED, bug restored, 10 MB of replay through `| cat`, closing at
    // 0.02s / 0.05s / 0.15s / 0.3s / 1.0s: **10001074 bytes every time —
    // complete, at every timing.** A reader that keeps draining lets each write
    // complete before the next arrives, and the write immediately preceding the
    // exit is the small `closed` frame, which fits under the buffer. So a gate
    // built only to "ONE event over 64 KiB" passes with the bug in place.
    //
    // What discriminates is whether bytes are UNDRAINED at the instant of exit.
    // With `| ( sleep 2; cat )` the pipe stays full and the tail's writes sit
    // buffered, so the exit discards them:
    //
    //     bug restored -> 65536 bytes    (exactly the buffer)
    //     with the fix -> 3000440 bytes  (complete)
    //
    // That is realistic, not contrived: any consumer momentarily not reading —
    // a busy Monitor, a slow downstream — is in this state.
    await Bun.sleep(300);
    await runCli(["close", "--session", id], { env });

    const budget = 25_000;
    const killer = setTimeout(() => proc.kill("SIGKILL"), budget);
    const started = performance.now();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(killer);
    const ms = performance.now() - started;

    // G7 FIRST — a hang is a different failure from a truncation and must not
    // be reported as one.
    expect({ returnedOnItsOwn: ms < budget, code }).toEqual({ returnedOnItsOwn: true, code: 0 });

    // G8 — the over-buffer assertion BEFORE any parse. A fixture that shrank
    // below the buffer would pass every assertion below it while proving
    // nothing. The threshold is the 64 KiB buffer; the fixture is ~15x it.
    expect(out.length).toBeGreaterThan(65_536);

    // And the payload is INTACT, not merely large: the big frame parses and
    // carries all 100,000 characters. A truncated frame is cut mid-value, so it
    // cannot parse — that is the whole check.
    const bigLine = out.split("\n").find((l) => l.includes("big-1") && l.includes("task.add"));
    expect(bigLine).toBeDefined();
    const ev = JSON.parse(bigLine as string) as { task?: { title?: string } };
    expect(ev.task?.title?.length).toBe(1_000_000);
  }, 60000);
});

// ── P0c (#81) — `--flag=value`, and the verb that ran anyway ─────────────
//
// The hand-rolled parser had three silent defects. The `=` form dropped the
// value (so a read FILTER matched nothing and returned the WHOLE BOARD),
// unknown flags were accepted at exit 0, and free prose containing a `--word`
// was silently truncated at that word.
//
// Fixed at PARSER ALTITUDE by deleting the bespoke parser for `node:util`
// strict — anthill scoped the same guard to one verb's run() and reached 1 of
// 13 leaves, which is why this is not done per verb.
//
// ⚠ Cell 1 uses a BOGUS value on purpose. `--owner=alice` returning tasks is
// the paraphrase that hid this bug for a round: it "works" pre-fix too, because
// the unfiltered whole board contains alice. Only a value matching NOTHING can
// tell a working filter from an absent one.
describe("P0c #81 — the equals form, and unknown flags", () => {
  async function board(env: { BOUNTY_HOME: string }) {
    const open = await runCli(["open", "--no-open", "--timeout", "60"], { env });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "alice task", "--owner", "alice", "--id", "a1", "--session", id], { env });
    await runCli(["add", "maestro task", "--owner", "maestro", "--id", "m1", "--session", id], {
      env,
    });
    return id;
  }

  test("RED PRE-FIX — a bogus --owner=<value> returns ZERO tasks, not the whole board", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(["state", "--owner=zzz-nobody-zzz", "--session", id], { env });
      const d = JSON.parse(r.stdout) as { state: BoardState };
      expect(d.state.tasks).toHaveLength(0); // pre-fix: 2 — the whole board
      const hit = await runCli(["state", "--owner=alice", "--session", id], { env });
      expect((JSON.parse(hit.stdout) as { state: BoardState }).state.tasks).toHaveLength(1);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — an unknown flag exits non-zero and NAMES the flag", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(["state", "--totally-bogus-flag", "z", "--session", id], { env });
      expect(r.code).not.toBe(0); // pre-fix: 0, and the verb ran
      expect(r.stderr).toContain("--totally-bogus-flag");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — `close --help` does NOT close the board", async () => {
    // ⚠ THE DESTRUCTIVE ARM, and the most important user-facing fix in the
    // lane. Pre-fix `--help` was swallowed as an unknown flag and `close` ran:
    // asking for help DESTROYED the board — and `close` also writes the
    // snapshot, so it takes the resume point with it. Since the kit's per-verb
    // help, `close --help` answers with close's help at exit 0 (it used to be
    // refused as an unknown flag); either way `close` must not run.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(["close", "--help", "--session", id], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toStartWith("usage: close");
      const after = await runCli(["state", "--session", id], { env });
      expect(after.code).toBe(0); // the board is STILL THERE
      expect((JSON.parse(after.stdout) as { state: BoardState }).state.tasks).toHaveLength(2);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — the WRITE path: add --owner=<name> stores the owner", async () => {
    // A read-only gate misses the worse half: pre-fix the value was dropped, so
    // the task was created UNOWNED at exit 0 — a silent write corruption.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      await runCli(["add", "bob task", "--owner=bob", "--id", "b1", "--session", id], { env });
      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(d.state.tasks.find((t) => t.id === "b1")?.owner).toBe("bob");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("RED PRE-FIX — free prose with a --word is REFUSED, not silently truncated", async () => {
    // Pre-fix `add write the --draft section` stored the title "write the" and
    // exited 0. So the trade this lane makes is NOT "working prose → hard
    // error"; it is "silent truncation → hard error", which is strictly an
    // improvement. The plan's risk section argued against the fix using a
    // capability the tool does not have.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      const r = await runCli(
        ["add", "write", "the", "--draft", "section", "--id", "p1", "--session", id],
        { env },
      );
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("--draft");
      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(d.state.tasks.find((t) => t.id === "p1")).toBeUndefined(); // nothing stored
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  // ⚠ LABEL SPLIT AFTER MEASUREMENT — the THIRD time this session I put a
  // guard's label on assertions that cannot hold pre-fix. The `--` terminator
  // does not exist in the bespoke parser, so ANY cell exercising it is RED by
  // construction. The pre-fix-passing shapes are the real guard, below.
  test("RED PRE-FIX — the `--` terminator carries prose containing a --word", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      await runCli(["add", "--id", "p3", "--session", id, "--", "write the --draft section"], {
        env,
      });
      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(d.state.tasks.find((t) => t.id === "p3")?.title).toBe("write the --draft section");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);

  test("BLAST-RADIUS GUARD — positionals survive, per POSITIONAL SHAPE", async () => {
    // ⚠ POSITIONALS ARE WHAT BREAK. anthill's first guard at this altitude broke
    // seven tests, and bounty is MORE exposed — it had no `--` terminator at
    // all. Pinned by SHAPE rather than by verb (anthill's three cells hold
    // thirteen leaves): free prose, --stdin, and single-token ids.
    //
    // Every arm here PASSES PRE-FIX — that is what makes it a guard. It catches
    // the conversion breaking what already worked. The terminator arm lived
    // here until a mutation run showed it could not pass pre-fix; it is a red
    // cell and now has its own.
    const env = { BOUNTY_HOME: uniqHome() };
    const id = await board(env);
    try {
      // free prose, multi-word, no dashes — the ordinary case
      await runCli(["add", "write", "the", "section", "--id", "p2", "--session", id], { env });
      // the --stdin escape hatch — the OLD parser honoured this one too
      await runCli(["add", "--id", "p4", "--stdin", "--session", id], {
        env,
        stdin: "write the --draft section",
      });
      // single-token positional id
      await runCli(["update", "p2", "--status", "doing", "--session", id], { env });

      const d = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      const byId = (x: string) => d.state.tasks.find((t) => t.id === x);
      expect(byId("p2")?.title).toBe("write the section");
      expect(byId("p2")?.status).toBe("doing");
      expect(byId("p4")?.title).toBe("write the --draft section");
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 40000);
});

// ── P1a/P1b — the guard END TO END, on the real defect ───────────────────────
// The predicate cells above prove the DECISION. This proves the SINK is wired to
// it — a pure predicate nobody calls is a helper, not a fix.
//
// The construction is #73/#74's actual shape: seed a snapshot, kill the daemon
// so it writes NOTHING on the way out, respawn under the SAME KEY (which does
// not hydrate — measured), then make ONE ordinary mutation and let the ~1s
// debounce flush it. No `close`, no `--fresh`, no `--restore` anywhere.
describe("P1a/P1b — the shrinkage guard, end to end", () => {
  test("a respawned-empty board's first write COPIES the old snapshot aside, and SAYS so", async () => {
    const home = uniqHome();
    const cwd = mkdtempSync(join(TEST_TMPDIR, "p1a-"));
    const key = `p1a-${crypto.randomUUID().slice(0, 8)}`;
    const env = { BOUNTY_HOME: home };

    const open = await runOpen(["--session-key", key, "--no-open"], { home, cwd });
    const id = (JSON.parse(open.stdout) as { session_id: string; port: number }).session_id;
    const port = (JSON.parse(open.stdout) as { port: number }).port;
    for (const t of ["a", "b", "c"])
      await runCli(["add", t, "--id", `p1a-${t}`, "--session", id], { env });
    const seeded = Date.now() + 10000;
    while (Date.now() < seeded && snapshotTaskCountAt(home, id) !== 3) await Bun.sleep(100);
    // PRECONDITION, printable as a failure rather than assumed: if the snapshot
    // never reached 3, everything below is vacuous and would read as "no loss".
    expect(snapshotTaskCountAt(home, id)).toBe(3);

    // SIGKILL, by exact PID off the port. NOT `pkill -f`, and not a pattern on
    // the board id — the id appears in the argv of the process doing the
    // matching, so such a pattern lists the harness's own shell.
    const lsof = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pids = new TextDecoder().decode(lsof.stdout).trim().split("\n").filter(Boolean);
    expect(pids.length).toBeGreaterThan(0); // a kill that no-ops makes the run read clean
    for (const pid of pids) Bun.spawnSync(["kill", "-9", pid]);
    await Bun.sleep(600);
    // A killed daemon writes nothing on the way out — so the snapshot is intact
    // and the cell below is measuring the RESPAWN, not the kill.
    expect(snapshotTaskCountAt(home, id)).toBe(3);

    // `--fresh` for the same reason as P0b: post-b7 a keyed respawn RESTORES, so
    // the empty-board precondition is now explicit. Worth noting what that means
    // for THIS scenario in the real world — a SIGKILLed board's keyed respawn now
    // comes back with its cards, so the respawned-empty-then-clobber sequence
    // this guard was built for is substantially rarer than when it was written.
    // The guard still earns its place: --fresh, a genuine drain, and any other
    // route to a shrinking write all still reach it.
    const respawn = await runOpen(["--session-key", key, "--fresh", "--no-open"], { home, cwd });
    const id2 = (JSON.parse(respawn.stdout) as { session_id: string }).session_id;
    expect(id2).toBe(id); // same key, same board id — that is what makes it a clobber
    try {
      // ONE mutation. This is the write that used to take the snapshot 3 -> 1.
      await runCli(["add", "d", "--id", "p1a-d", "--session", id], { env });
      const flushed = Date.now() + 10000;
      while (Date.now() < flushed && snapshotTaskCountAt(home, id) !== 1) await Bun.sleep(100);
      expect(snapshotTaskCountAt(home, id)).toBe(1); // the shrink still HAPPENS

      // ...but the old one was copied aside first. THIS is the fix.
      const backups = readdirSync(join(home, "snapshots")).filter((f) =>
        f.startsWith(`${id}.pre-`),
      );
      expect(backups.length).toBe(1);
      const rescued = JSON.parse(
        readFileSync(join(home, "snapshots", backups[0] as string), "utf8"),
      ) as { tasks: unknown[] };
      expect(rescued.tasks.length).toBe(3);

      // AND IT SAID SO. A silent rescue is a success-shaped lie: the user is
      // protected and never learns they needed protecting.
      const log = readFileSync(join(home, "daemon.log"), "utf8");
      // daemon.log is NOT pure JSONL: cli.ts points the daemon's native stderr
      // at this same file (#64, so Bun's own hard-abort output is captured), so
      // the structured lines are interleaved with plain prose. Parsing every
      // line blows up on our OWN human-readable announcement — which is how this
      // cell first discovered that the stderr half lands here too.
      const said = log
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { reason?: string; priorTasks?: number; nextTasks?: number })
        .filter((e) => e.reason === "snapshotBackedUp");
      expect(said.length).toBe(1);
      expect(said[0]?.priorTasks).toBe(3);
      expect(said[0]?.nextTasks).toBe(1);
      // The human-readable half, in the same file, naming the numbers and the
      // file — this is what someone reading a log after a scare actually finds.
      expect(log).toContain("snapshot was about to shrink 3 → 1 tasks");
      expect(log).toContain(`${id}.pre-`);

      // ONCE PER SESSION: a SECOND shrink in the same daemon must NOT rotate
      // again. Without this the guard is per-write, and a card-by-card drain
      // evicts the rescued snapshot with the guard's own backups.
      await runCli(["remove", "p1a-d", "--session", id], { env });
      await Bun.sleep(1600);
      expect(snapshotTaskCountAt(home, id)).toBe(0);
      expect(
        readdirSync(join(home, "snapshots")).filter((f) => f.startsWith(`${id}.pre-`)).length,
      ).toBe(1);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 60000);
});

describe("one act, one answer — init over a board that has tasks", () => {
  // item/bounty-init-stdin-tasks-wipes-live-board. Before: `init --stdin-tasks`
  // over a populated board replaced every task at {"ok":true,…,"tasksDropped":null}
  // and exit 0. `tasksDropped` is b8's report of INPUT entries the daemon
  // rejected, so its null said nothing about the board's own tasks.
  test("init --stdin-tasks over a populated board is a conflict (6); --replace opts in and counts what it replaced", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const s = ["--session", session];
    const ids = async () =>
      (
        JSON.parse((await runCli(["state", ...s], { env })).stdout) as { state: BoardState }
      ).state.tasks.map((t) => t.id);
    try {
      await runCli(["add", "one", "--id", "t1", ...s], { env });
      await runCli(["add", "two", "--id", "t2", ...s], { env });
      const seed = JSON.stringify([{ id: "n1", title: "new", status: "todo" }]);

      const refused = await runCli(["init", "--stdin-tasks", ...s], { env, stdin: seed });
      const err = refusal(refused, "conflict", 6);
      expect(err.message).toContain("2 tasks");
      expect(err.hint).toContain("--replace");
      // An empty array would wipe the board just the same, and is refused the same.
      refusal(await runCli(["init", "--stdin-tasks", ...s], { env, stdin: "[]" }), "conflict", 6);
      expect(await ids()).toEqual(["t1", "t2"]);

      // --replace means it, and the count it replaced is a number, never null.
      const replaced = await runCli(["init", "--stdin-tasks", "--replace", ...s], {
        env,
        stdin: seed,
      });
      expect(replaced.code).toBe(0);
      expect(JSON.parse(replaced.stdout)).toEqual({
        ok: true,
        sent: "init",
        tasksDropped: null,
        tasksReplaced: 2,
      });
      expect(await ids()).toEqual(["n1"]);

      // --replace with no tasks to seed would do nothing, so it is refused.
      refusal(await runCli(["init", "--replace", ...s], { env }), "usage", 2);
    } finally {
      await runCli(["close", ...s], { env });
    }
  }, 30000);

  test("seeding an EMPTY board answers exactly as before, and --replace there reports 0", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const s = ["--session", session];
    try {
      const seed = JSON.stringify([{ id: "a", title: "A", status: "todo" }]);
      const first = await runCli(["init", "--stdin-tasks", ...s], { env, stdin: seed });
      expect(first.code).toBe(0);
      expect(first.stdout).toBe(
        `${JSON.stringify({ ok: true, sent: "init", tasksDropped: null })}\n`,
      );
      // A title-only init touches no tasks, so it is never a conflict.
      expect((await runCli(["init", "--title", "Renamed", ...s], { env })).code).toBe(0);
      await runCli(["remove", "a", ...s], { env });
      const again = await runCli(["init", "--stdin-tasks", "--replace", ...s], {
        env,
        stdin: seed,
      });
      expect(again.code).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ tasksReplaced: 0 });
    } finally {
      await runCli(["close", ...s], { env });
    }
  }, 30000);
});

describe("one act, one answer — open --restore of a snapshot that does not exist", () => {
  // item/bounty-open-restore-missing-exits-zero. Before: exit 0, an envelope
  // carrying `restoreFailed: ENOENT…`, and a NEW EMPTY board left running.
  test("open --restore <missing> is not_found (5) and starts no board", async () => {
    const tmp = mkdtempSync(join(TEST_TMPDIR, "restore-missing-"));
    const env = { BOUNTY_HOME: uniqHome(), TMPDIR: `${tmp}/` };
    const r = await runCli(["open", "--restore", "k-nope-123", "--no-open"], { env });
    const err = refusal(r, "not_found", 5);
    expect(err.message).toContain("k-nope-123");
    expect(err.hint).toContain("sessions");
    // Nothing was spawned: no discovery file now, nor after a spawn could land.
    await Bun.sleep(600);
    expect(readdirSync(tmp).filter((f) => f.startsWith("bounty-"))).toEqual([]);
    const list = await runCli(["list"], { env });
    expect(list.stdout).toStartWith("0 running boards");
  }, 30000);

  // An empty id used to read as "no restore": exit 0, a fresh empty board,
  // `restoreFailed: null`. An empty `--restore` names nothing to restore.
  test('open --restore "" is a usage error (2) and starts no board', async () => {
    const tmp = mkdtempSync(join(TEST_TMPDIR, "restore-empty-"));
    const env = { BOUNTY_HOME: uniqHome(), TMPDIR: `${tmp}/` };
    const r = await runCli(["open", "--restore", "", "--no-open"], { env });
    const err = refusal(r, "usage", 2);
    expect(err.message).toContain("--restore");
    await Bun.sleep(600);
    expect(readdirSync(tmp).filter((f) => f.startsWith("bounty-"))).toEqual([]);
    const list = await runCli(["list"], { env });
    expect(list.stdout).toStartWith("0 running boards");
  }, 30000);

  test("--fresh --restore <missing> on a live keyed board refuses BEFORE the teardown", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const key = `restore-fresh-${crypto.randomUUID().slice(0, 8)}`;
    const open = await runCli(["open", "--session-key", key, "--no-open", "--timeout", "10"], {
      env,
    });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    try {
      await runCli(["add", "live", "--id", "l1", "--session", id], { env });
      const r = await runCli(
        ["open", "--session-key", key, "--fresh", "--restore", "k-nope-123", "--no-open"],
        { env },
      );
      refusal(r, "not_found", 5);
      const s = JSON.parse((await runCli(["state", "--session", id], { env })).stdout) as {
        state: BoardState;
      };
      expect(s.state.tasks.map((t) => t.id)).toEqual(["l1"]);
    } finally {
      await runCli(["close", "--session", id], { env });
    }
  }, 30000);

  // The come-back `tail` prints for a closed board (#98) is `open --restore
  // <id> --no-open`. Still true: a snapshot that DOES exist restores, exit 0.
  test("GUARD — open --restore <id> of a closed board's snapshot still restores it", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const id = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    await runCli(["add", "kept", "--id", "k1", "--session", id], { env });
    expect((await runCli(["close", "--session", id], { env })).code).toBe(0);
    const back = await runCli(["open", "--restore", id, "--no-open", "--timeout", "10"], { env });
    expect(back.code).toBe(0);
    const hs = JSON.parse(back.stdout) as { session_id: string; restoreFailed: unknown };
    try {
      expect(hs.restoreFailed).toBeNull();
      const s = JSON.parse(
        (await runCli(["state", "--session", hs.session_id], { env })).stdout,
      ) as { state: BoardState };
      expect(s.state.tasks.map((t) => t.id)).toEqual(["k1"]);
    } finally {
      await runCli(["close", "--session", hs.session_id], { env });
    }
  }, 30000);
});

describe("one act, one answer — add with a title AND --stdin", () => {
  // item/bounty-add-stdin-drops-positional-title. Before: the stdin text became
  // the title and the positional was discarded, at exit 0. Sprint 06 made
  // `update --stdin --title` a usage error (s5-9); `add` now agrees with it.
  test("add <title> --stdin is a usage error (2) and adds nothing; either one alone still adds", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const s = ["--session", session];
    const titles = async () =>
      (
        JSON.parse((await runCli(["state", ...s], { env })).stdout) as { state: BoardState }
      ).state.tasks.map((t) => t.title);
    try {
      const r = await runCli(["add", "x", "--stdin", ...s], { env, stdin: "from stdin\n" });
      const err = refusal(r, "usage", 2);
      expect(err.message).toContain("--stdin");
      expect(await titles()).toEqual([]);

      expect((await runCli(["add", "positional", ...s], { env })).code).toBe(0);
      expect((await runCli(["add", "--stdin", ...s], { env, stdin: "piped\n" })).code).toBe(0);
      expect(await titles()).toEqual(["positional", "piped"]);
    } finally {
      await runCli(["close", ...s], { env });
    }
  }, 30000);

  // The same class on `message`: `message x --stdin` toasted the stdin text and
  // dropped `x`, at exit 0. Refused in the same shape as `add`.
  test("message <text> --stdin is a usage error (2); either one alone still sends", async () => {
    const env = { BOUNTY_HOME: uniqHome() };
    const open = await runCli(["open", "--no-open", "--timeout", "10"], { env });
    const session = (JSON.parse(open.stdout) as { session_id: string }).session_id;
    const s = ["--session", session];
    try {
      const r = await runCli(["message", "x", "--stdin", ...s], { env, stdin: "from stdin\n" });
      const err = refusal(r, "usage", 2);
      expect(err.message).toContain("--stdin");

      expect((await runCli(["message", "positional", ...s], { env })).code).toBe(0);
      expect((await runCli(["message", "--stdin", ...s], { env, stdin: "piped\n" })).code).toBe(0);
    } finally {
      await runCli(["close", ...s], { env });
    }
  }, 30000);
});
