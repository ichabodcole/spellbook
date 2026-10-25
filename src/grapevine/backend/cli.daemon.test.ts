// PART OF THE GRAPEVINE CLI SUITE: cli.test.ts plus its cli.*.test.ts
// siblings, one file once (about 62 s alone). It was split, by describe block
// and its long "grapevine cli" block into three runs of tests, so a parallel
// run is not floored by one file; every test body is unchanged. The shared
// harness is fixtures/cliSuite.ts, evaluated once per file: each file has its
// own GRAPEVINE_HOME, its own daemon, and stops both after its last test.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVersion } from "./cli.ts";
import {
  bunRun,
  bunRunStdin,
  CLI,
  DAEMON,
  errorOf,
  HOME,
  sleep,
  spawnTail,
  stopSuiteProcesses,
  TRACKED_PROCS,
} from "./fixtures/cliSuite.ts";

afterAll(stopSuiteProcesses);

describe("grapevine cli", () => {
  test("send echoes its target channel + recipient count to stderr", async () => {
    await bunRun(["open", "test_echo"]);
    const a = spawnTail("test_echo", ["--as", "listener"]);
    await sleep(400);
    const r = await bunRun(["send", "test_echo", "--from", "sender", "hi"]);
    expect(r.code).toBe(0);
    // stdout stays pure JSON (back-compat).
    const data = JSON.parse(r.stdout);
    expect(data.channel).toBe("test_echo");
    // stderr carries the human-visible target confirmation (misroute detection).
    expect(r.stderr).toContain("test_echo");
    expect(r.stderr).toMatch(/→|recipient/);
    a.proc.kill("SIGTERM");
  });

  test("send reads stdin by default when no inline text is given", async () => {
    await bunRun(["open", "test_defaultstdin"]);
    const a = spawnTail("test_defaultstdin", ["--as", "listener"]);
    await sleep(400);
    // No --stdin flag and no inline text — the body comes from piped stdin.
    const r = await bunRunStdin(
      ["send", "test_defaultstdin", "--from", "piper"],
      "piped body without the flag",
    );
    expect(r.code).toBe(0);
    await sleep(300);
    const got = a
      .output()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m.kind === "message" && m.from === "piper");
    expect(got).toBeDefined();
    expect(got.text).toBe("piped body without the flag");
    a.proc.kill("SIGTERM");
  });

  test("send --body-file reads the body from a file, preserving metachars", async () => {
    await bunRun(["open", "test_bodyfile"]);
    const a = spawnTail("test_bodyfile", ["--as", "listener"]);
    await sleep(400);
    const bodyPath = join(HOME, "body.txt");
    const body = "couldn't find `x` and $var — all > intact";
    writeFileSync(bodyPath, `${body}\n`); // trailing newline stripped, like stdin
    const r = await bunRun(["send", "test_bodyfile", "--from", "writer", "--body-file", bodyPath]);
    expect(r.code).toBe(0);
    await sleep(300);
    const got = a
      .output()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m.kind === "message" && m.from === "writer");
    expect(got).toBeDefined();
    expect(got.text).toBe(body);
    a.proc.kill("SIGTERM");
  });

  test("send rejects a leaked cli invocation in the body (and posts nothing)", async () => {
    await bunRun(["open", "test_leak"]);
    // A fumbled heredoc leaks the literal send invocation as the body.
    const leaked =
      "bun /Users/x/skills/grapevine/scripts/cli.ts send test_leak --as flint hello there\n" +
      "second line of the corrupted body";
    const r = await bunRunStdin(["send", "test_leak", "--from", "flint", "--stdin"], leaked);
    expect(r.code).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("leaked");
    // Nothing was posted — the corrupted body never reached the channel.
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "test_leak",
    );
    expect(ch.message_count).toBe(0);
  });

  test("send --force bypasses the leaked-invocation guard", async () => {
    await bunRun(["open", "test_force"]);
    const leaked = "bun /x/cli.ts send test_force --as flint genuinely meant to say this";
    const r = await bunRunStdin(
      ["send", "test_force", "--from", "flint", "--stdin", "--force"],
      leaked,
    );
    expect(r.code).toBe(0);
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "test_force",
    );
    expect(ch.message_count).toBe(1);
  });

  test("b3: an UNREACHABLE daemon makes version_ok NULL, never false", async () => {
    // `roll` is the documented deploy step and its verify had two silences. The
    // warm-path one is this: the probe was wrapped in `catch {}`, leaving
    // version = null, and `null === PLUGIN_VERSION` evaluates to FALSE. So "I
    // could not check" was reported as "the version is WRONG" — actionable and
    // incorrect, which is worse than saying nothing.
    //
    // Port 1 is reserved and nothing listens on it, so the probe must fail.
    const r = await probeVersion(1);
    // RED PRE-FIX: this was `false`.
    expect(r.version_ok).toBeNull();
    expect(r.version_ok).not.toBe(false);
    expect(r.version).toBeNull();
    // and a bare null tells a caller the check did not happen, not WHY
    expect(r.version_unchecked_reason).toBeTruthy();
  });

  // --- b5: message_count must distinguish "empty" from "I did not count" -----
  //
  // Placed ABOVE the daemon-lifecycle block on purpose: these plant files
  // directly in CHANNELS_DIR and must run while the shared daemon is still the
  // one every other test used (the shared-daemon insertion-position rule).
  //
  // Each channel below is planted on disk and NEVER accessed through a verb, so
  // the daemon lists it without loading it — which is the state the defect
  // lived in. `loaded: false` is asserted in-band as the PRECONDITION, so a cell
  // that silently loaded the channel reports itself instead of quietly passing.

  test("b5: an UNLOADED channel reports its real count, not 0", async () => {
    // The daemon is shared and normally already up from earlier tests — but
    // under `bun test -t b5` nothing has started it, `list` answers
    // {daemon:false, channels:[]}, and every cell below fails with `ch`
    // undefined INSTEAD of on its assertion. That is a cell failing for the
    // wrong reason, which is not evidence of anything. `start` is idempotent.
    await bunRun(["start"]);
    const lines = [1, 2, 3]
      .map((id) =>
        JSON.stringify({ id, ts: 1700000000000, from: "x", kind: "msg", text: `m${id}` }),
      )
      .join("\n");
    writeFileSync(join(HOME, "channels", "b5_unloaded.jsonl"), `${lines}\n`);
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "b5_unloaded",
    );
    // PRECONDITION, in-band: if this is true the cell is testing the loaded
    // path and proves nothing about the defect.
    expect(ch.loaded).toBe(false);
    // RED PRE-FIX: this was 0 for a channel holding three messages.
    expect(ch.message_count).toBe(3);
  });

  test("b5: a channel whose file cannot be read reports null, NEVER 0", async () => {
    await bunRun(["start"]);
    // A directory named *.jsonl is listed as a channel and throws on read —
    // the "I could not count" arm, which must be distinguishable from empty.
    mkdirSync(join(HOME, "channels", "b5_unreadable.jsonl"), { recursive: true });
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "b5_unreadable",
    );
    expect(ch.loaded).toBe(false);
    expect(ch.message_count).toBeNull();
  });

  test("b5 GUARD — a genuinely EMPTY channel still reports 0, so 0 keeps meaning empty", async () => {
    await bunRun(["start"]);
    // The failure mode of this fix is replacing every 0 with null, which would
    // destroy the signal instead of clarifying it. This cell passes in BOTH
    // worlds and is here to catch that, not to prove the fix.
    writeFileSync(join(HOME, "channels", "b5_empty.jsonl"), "");
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "b5_empty",
    );
    expect(ch.message_count).toBe(0);
    expect(ch.message_count).not.toBeNull();
  });

  // --- b11: a truncated final line must not destroy the next write -----------
  //
  // Fixture is the measured one: three well-formed messages, then a final line
  // cut mid-JSON — what a crash or kill during appendFileSync leaves behind.
  // Pre-fix, loading this channel reset next_id to 1 (empty catch), so the next
  // send reused id 1 AND fused onto the unterminated line, making both records
  // permanently unreadable, at ok:true.

  test("b11: a send after a truncated final line does NOT reuse an id", async () => {
    await bunRun(["start"]);
    const good = [1, 2, 3]
      .map((id) =>
        JSON.stringify({ id, ts: 1700000000000, from: "x", kind: "msg", text: `m${id}` }),
      )
      .join("\n");
    writeFileSync(
      join(HOME, "channels", "b11_ids.jsonl"),
      // no trailing newline on the fragment — that is the whole defect
      `${good}\n{"id":4,"ts":170000000`,
    );
    const r = await bunRun(["send", "b11_ids", "--from", "flint", "after-the-tail"]);
    expect(r.code).toBe(0);
    // RED PRE-FIX: this was 1 — an id that already exists in the file.
    expect(JSON.parse(r.stdout).id).toBeGreaterThan(3);
  });

  test("b11: the appended message stays PARSEABLE — it is not fused onto the fragment", async () => {
    await bunRun(["start"]);
    const good = [1, 2]
      .map((id) =>
        JSON.stringify({ id, ts: 1700000000000, from: "x", kind: "msg", text: `m${id}` }),
      )
      .join("\n");
    writeFileSync(join(HOME, "channels", "b11_fuse.jsonl"), `${good}\n{"id":3,"ts":17000`);
    await bunRun(["send", "b11_fuse", "--from", "flint", "SURVIVOR"]);
    const raw = readFileSync(join(HOME, "channels", "b11_fuse.jsonl"), "utf-8");
    const parseable = raw
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as { text?: string }];
        } catch {
          return [];
        }
      });
    // RED PRE-FIX: the new message was concatenated onto the truncated
    // fragment, so NOTHING in the file carried this text.
    expect(parseable.some((m) => m.text === "SURVIVOR")).toBe(true);
    // And the fragment is still its own line rather than having swallowed one.
    expect(raw).toContain('{"id":3,"ts":17000');
  });

  test("b11: the message is READABLE BACK through the daemon, not merely on disk", async () => {
    await bunRun(["start"]);
    writeFileSync(join(HOME, "channels", "b11_read.jsonl"), '{"id":1,"ts":1,"from":"x"');
    await bunRun(["send", "b11_read", "--from", "flint", "RECOVERABLE"]);
    // The real test of a write is a read: verifying bytes on disk would pass
    // even if the daemon could never serve them again.
    const pull = await bunRun(["pull", "b11_read"]);
    expect(pull.stdout).toContain("RECOVERABLE");
  });

  test("b11 GUARD — a healthy channel's bytes are unchanged (no stray separator)", async () => {
    await bunRun(["start"]);
    await bunRun(["open", "b11_healthy"]);
    await bunRun(["send", "b11_healthy", "--from", "flint", "one"]);
    await bunRun(["send", "b11_healthy", "--from", "flint", "two"]);
    const raw = readFileSync(join(HOME, "channels", "b11_healthy.jsonl"), "utf-8");
    // Passes in BOTH worlds by design: it exists to catch the fix inserting a
    // blank line into every healthy append, which would be a new defect.
    expect(raw).not.toContain("\n\n");
    expect(raw.endsWith("\n")).toBe(true);
  });

  // --- daemon lifecycle: start / restart -------------------------------------
  // These manipulate the shared daemon, so they run LAST in the file. afterAll
  // tears down whatever daemon is left standing.

  test("start ensures a daemon is running with no channel side-effect", async () => {
    const before = await bunRun(["list"]);
    const channelsBefore = JSON.parse(before.stdout).channels.length;
    const r = await bunRun(["start"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(typeof data.port).toBe("number");
    // A live daemon is reachable...
    const info = await bunRun(["info"]);
    expect(JSON.parse(info.stdout).daemon).toBe(true);
    // ...and `start` created no channel.
    const after = await bunRun(["list"]);
    expect(JSON.parse(after.stdout).channels.length).toBe(channelsBefore);
  });

  test("restart refuses to tear down a live fleet without --force", async () => {
    await bunRun(["open", "restart_busy"]);
    const t = spawnTail("restart_busy", ["--as", "listener"]);
    await sleep(400); // let the subscription register presence
    const infoBefore = await bunRun(["info"]);
    const pidBefore = JSON.parse(infoBefore.stdout).pid;
    const r = await bunRun(["restart"]);
    // 6 = `conflict` since Phase 6 chapter 2: a precondition failed (live
    // subscribers), which is not the caller mistyping the command.
    expect(r.code).toBe(6);
    expect(errorOf(r.stderr).kind).toBe("conflict");
    expect(r.stderr.toLowerCase()).toMatch(/subscriber|--force|live/);
    // Daemon untouched — same process, subscriber undisturbed.
    const infoAfter = await bunRun(["info"]);
    expect(JSON.parse(infoAfter.stdout).daemon).toBe(true);
    expect(JSON.parse(infoAfter.stdout).pid).toBe(pidBefore);
    t.proc.kill("SIGTERM");
    await sleep(300);
  });

  test("restart --force respawns a fresh daemon (new pid)", async () => {
    const infoBefore = await bunRun(["info"]);
    const pidBefore = JSON.parse(infoBefore.stdout).pid;
    const r = await bunRun(["restart", "--force"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.restarted).toBe(true);
    // A daemon is running again, and it's a different process.
    const infoAfter = await bunRun(["info"]);
    expect(JSON.parse(infoAfter.stdout).daemon).toBe(true);
    expect(JSON.parse(infoAfter.stdout).pid).not.toBe(pidBefore);
  }, 10000);

  test("announce --channels targets named channels, skips unknown/archived, ignores other active", async () => {
    // tc_a active (tail), tc_b idle (exists on disk, no tail), tc_c active (tail, NOT named),
    // tc_arch archived, tc_missing never created.
    const a = spawnTail("tc_a", ["--as", "alice"]);
    const c = spawnTail("tc_c", ["--as", "carol"]);
    await bunRun(["open", "tc_b"]); // on disk, idle, no subscriber
    await bunRun(["open", "tc_arch"]);
    await bunRun(["archive", "tc_arch"]);
    await sleep(400);

    const r = await bunRun([
      "announce",
      "--from",
      "lead",
      "--channels",
      "tc_a,tc_b,tc_arch,tc_missing",
      "reconvene in main",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);

    const delivered = parsed.channels.map((x: { name: string }) => x.name).sort();
    expect(delivered).toEqual(["tc_a", "tc_b"]); // named + resolvable
    const byName = Object.fromEntries(
      parsed.channels.map((x: { name: string; recipients: number }) => [x.name, x.recipients]),
    );
    expect(byName.tc_a).toBe(1); // alice tailing
    expect(byName.tc_b).toBe(0); // idle, no subscriber, but still delivered to its log

    const skipped = Object.fromEntries(
      parsed.skipped.map((x: { name: string; reason: string }) => [x.name, x.reason]),
    );
    expect(skipped.tc_arch).toBe("archived");
    expect(skipped.tc_missing).toBe("unknown");

    // tc_c was active but NOT named → must not receive it.
    await sleep(300);
    expect(c.output()).not.toContain("reconvene in main");
    expect(a.output()).toContain("reconvene in main");

    // Clean up tails and channels so they don't bleed into the next announce test.
    a.proc.kill("SIGTERM");
    c.proc.kill("SIGTERM");
    await sleep(400);
    await bunRun(["close", "tc_a"]);
    await bunRun(["close", "tc_b"]);
    await bunRun(["close", "tc_c"]);
    // tc_arch is archived; unarchive then close so it's out of the channel map.
    await bunRun(["unarchive", "tc_arch"]);
    await bunRun(["close", "tc_arch"]);
  });

  test("announce refuses a leaked invocation body (no --force)", async () => {
    await bunRun(["open", "ann_guard"]);
    const leaked = 'bun /path/to/cli.ts announce --from lead "hi"';
    const r = await bunRunStdin(
      ["announce", "--from", "lead", "--channels", "ann_guard", "--stdin"],
      leaked,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("leaked grapevine invocation");
    // Nothing was posted.
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "ann_guard",
    );
    expect(ch.message_count).toBe(0);
    await bunRun(["close", "ann_guard"]);
  });

  test("reset snapshots then clears the log (V1.8)", async () => {
    await bunRun(["open", "rs_chan"]);
    await bunRun(["send", "rs_chan", "--from", "a", "one"]);
    await bunRun(["send", "rs_chan", "--from", "a", "two"]);

    const res = await bunRun(["reset", "rs_chan"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.cleared).toBe(true);
    expect(typeof out.snapshot).toBe("string");
    expect(existsSync(out.snapshot)).toBe(true); // snapshot written under ~/.grapevine/archive

    // live log is now empty
    const pull = await bunRun(["pull", "rs_chan", "--since", "0"]);
    expect(JSON.parse(pull.stdout).messages.length).toBe(0);

    // snapshot holds the prior two messages
    const snap = readFileSync(out.snapshot, "utf-8").trim().split("\n").filter(Boolean);
    expect(snap.length).toBe(2);
  });

  test("reset refuses a live channel without --force, proceeds with it (V1.8)", async () => {
    await bunRun(["open", "rs_live"]);
    await bunRun(["send", "rs_live", "--from", "a", "live one"]);

    // a real subscriber makes the channel "live"
    const tail = spawn(process.execPath, [CLI, "tail", "rs_live", "--as", "seat"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    TRACKED_PROCS.add(tail);
    await sleep(400); // let the tail subscribe

    const blocked = await bunRun(["reset", "rs_live"]);
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toContain("--force");
    // history survives the refused reset
    expect(
      JSON.parse((await bunRun(["pull", "rs_live", "--since", "0"])).stdout).messages.length,
    ).toBe(1);

    const forced = await bunRun(["reset", "rs_live", "--force"]);
    expect(forced.code).toBe(0);
    expect(JSON.parse(forced.stdout).cleared).toBe(true);

    tail.kill("SIGTERM");
    TRACKED_PROCS.delete(tail);
    // Isolate the next test: let the daemon notice the disconnect, then remove
    // the channel entirely so its subscriber can't be counted as an active
    // recipient elsewhere (the announce test counts all active channels).
    await sleep(200);
    await bunRun(["close", "rs_live"]);
  });

  test("open --fresh clears a dormant channel's history (V1.8)", async () => {
    await bunRun(["open", "of_chan"]);
    await bunRun(["send", "of_chan", "--from", "a", "stale one"]);
    await bunRun(["send", "of_chan", "--from", "a", "stale two"]);

    const fresh = await bunRun(["open", "of_chan", "--fresh"]);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.stdout).channel.cleared).toBe(true);

    expect(
      JSON.parse((await bunRun(["pull", "of_chan", "--since", "0"])).stdout).messages.length,
    ).toBe(0);
  });

  test("open --fresh does NOT clear a live channel (idempotent-convene guard) (V1.8)", async () => {
    await bunRun(["open", "of_live"]);
    await bunRun(["send", "of_live", "--from", "a", "in flight"]);

    const tail = spawn(process.execPath, [CLI, "tail", "of_live", "--as", "seat"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    TRACKED_PROCS.add(tail);
    await sleep(400);

    const fresh = await bunRun(["open", "of_live", "--fresh"]);
    expect(fresh.code).toBe(0);
    expect(JSON.parse(fresh.stdout).channel.cleared).toBe(false); // seats present → no clear
    expect(
      JSON.parse((await bunRun(["pull", "of_live", "--since", "0"])).stdout).messages.length,
    ).toBe(1);

    tail.kill("SIGTERM");
    TRACKED_PROCS.delete(tail);
    await sleep(200);
    await bunRun(["close", "of_live"]);
  });

  test("announce broadcasts to all active channels with a kind:announcement frame", async () => {
    // Two active channels, each with one subscriber tail.
    const a = spawnTail("ann_a", ["--as", "alice"]);
    const b = spawnTail("ann_b", ["--as", "bob"]);
    await sleep(400); // let subscriptions land + load the channels

    const r = await bunRun(["announce", "--from", "lead", "ship is going down in 5"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);

    // Both active channels are in the receipt, each with 1 recipient (the tail).
    const byName = Object.fromEntries(
      parsed.channels.map((c: { name: string; recipients: number }) => [c.name, c.recipients]),
    );
    expect(byName.ann_a).toBe(1);
    expect(byName.ann_b).toBe(1);
    expect(parsed.total_recipients).toBe(2);

    // The stderr echo reports the spread.
    expect(r.stderr).toContain("# announced → ");

    // Each tail actually received the announcement frame.
    await sleep(300);
    for (const out of [a.output(), b.output()]) {
      const line = out.split("\n").find((l) => l.includes("ship is going down"));
      expect(line).toBeDefined();
      expect(JSON.parse(line as string).kind).toBe("announcement");
    }
  });

  test("a stale daemon's shutdown does not delete a newer daemon's port/pid files (V1.9 ownership guard)", async () => {
    // Kill any lingering tail processes from prior tests so they can't
    // reconnect after SIGTERM and trigger ensureDaemon → spawn → overwrite.
    for (const proc of TRACKED_PROCS) {
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
    TRACKED_PROCS.clear();
    await sleep(300);

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

  test("doctor labels other daemons with status + reapable (V1.9)", async () => {
    await bunRun(["start"]);
    const orphanHome = mkdtempSync(join(tmpdir(), "gv-orphan2-"));
    const op = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, GRAPEVINE_HOME: orphanHome },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    TRACKED_PROCS.add(op);
    await sleep(800);
    rmSync(join(orphanHome, "daemon.port"), { force: true });

    const doc = JSON.parse((await bunRun(["doctor"])).stdout);
    const entry = doc.other_daemons_on_machine.find((d: { pid: number }) => d.pid === op.pid);
    expect(entry).toBeTruthy();
    expect(entry.status).toBe("orphan");
    expect(entry.reapable).toBe(true);
    expect(doc.hints.some((h: string) => h.includes("reap"))).toBe(true);

    op.kill("SIGTERM");
    TRACKED_PROCS.delete(op);
    rmSync(orphanHome, { recursive: true, force: true });
    await bunRun(["stop"]);
  });

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
  }, 10000);

  test("roll restarts the daemon and verifies the version (V1.9)", async () => {
    await bunRun(["start"]);
    const before = JSON.parse((await bunRun(["doctor"])).stdout).authoritative;

    const res = JSON.parse((await bunRun(["roll"])).stdout);
    expect(res.rolled).toBe(true);
    expect(res.previous_pid).toBe(before.pid);
    expect(res.pid).not.toBe(before.pid); // a fresh daemon
    expect(res.version_ok).toBe(true); // matches the CLI's PLUGIN_VERSION
    expect(JSON.parse((await bunRun(["doctor"])).stdout).authoritative.pid).toBe(res.pid);
    await bunRun(["stop"]);
  }, 15000);

  test("roll refuses active subscribers without --force (V1.9)", async () => {
    await bunRun(["open", "roll_live"]);
    const tail = spawn(process.execPath, [CLI, "tail", "roll_live", "--as", "seat"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
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

  test("mark appends a kind:status frame referencing the target (V1.9)", async () => {
    await bunRun(["open", "disp1"]);
    await bunRun(["send", "disp1", "--from", "a", "feedback item"]); // id 1
    const r = await bunRun([
      "mark",
      "disp1",
      "1",
      "incorporated",
      "--note",
      "shipped",
      "--as",
      "cole",
    ]);
    expect(r.code).toBe(0);
    const f = JSON.parse(r.stdout);
    expect(f.kind).toBe("status");
    expect(f.target).toBe(1);
    expect(f.disposition).toBe("incorporated");
    expect(f.from).toBe("cole");
    expect(f.text).toBe("shipped");
  });

  test("mark 404s on a nonexistent target (V1.9)", async () => {
    await bunRun(["open", "disp_x"]);
    const r = await bunRun(["mark", "disp_x", "999", "wontfix", "--as", "a"]);
    expect(r.code).not.toBe(0);
  });

  test("reopen appends a status frame with disposition open (V1.9)", async () => {
    await bunRun(["open", "disp2"]);
    await bunRun(["send", "disp2", "--from", "a", "item"]); // id 1
    await bunRun(["mark", "disp2", "1", "wontfix", "--as", "a"]);
    const r = await bunRun(["reopen", "disp2", "1", "--as", "a"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).disposition).toBe("open");
  });

  test("pull drops status frames and badges the target's latest disposition (V1.9)", async () => {
    await bunRun(["open", "disp3"]);
    await bunRun(["send", "disp3", "--from", "a", "one"]); // id1
    await bunRun(["send", "disp3", "--from", "a", "two"]); // id2
    await bunRun(["mark", "disp3", "1", "wontfix", "--as", "a"]); // id3 (status)
    await bunRun(["mark", "disp3", "1", "incorporated", "--as", "a"]); // id4 (status) — latest wins
    const r = await bunRun(["pull", "disp3", "--since", "0"]);
    const msgs = JSON.parse(r.stdout).messages;
    // status frames are not in the list
    expect(msgs.every((m: { kind: string }) => m.kind !== "status")).toBe(true);
    expect(msgs.length).toBe(2);
    const m1 = msgs.find((m: { id: number }) => m.id === 1);
    expect(m1.disposition).toBe("incorporated"); // latest
    const m2 = msgs.find((m: { id: number }) => m.id === 2);
    expect(m2.disposition ?? null).toBe(null); // unmarked → no badge
  });

  test("tail drops status frames (V1.9)", async () => {
    await bunRun(["open", "disp4"]);
    await bunRun(["send", "disp4", "--from", "a", "item"]); // id1
    const { proc, output } = spawnTail("disp4");
    await sleep(400);
    await bunRun(["mark", "disp4", "1", "acted-on", "--as", "a"]);
    await bunRun(["send", "disp4", "--from", "a", "next"]);
    await sleep(300);
    proc.kill("SIGTERM");
    const lines = output()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.some((m) => m.kind === "status")).toBe(false);
    expect(lines.some((m) => m.text === "next")).toBe(true);
  });

  test("pull --status filters by latest disposition; open = unmarked-or-reopened (V1.9)", async () => {
    await bunRun(["open", "disp5"]);
    await bunRun(["send", "disp5", "--from", "a", "one"]); // id1
    await bunRun(["send", "disp5", "--from", "a", "two"]); // id2
    await bunRun(["send", "disp5", "--from", "a", "three"]); // id3
    await bunRun(["mark", "disp5", "1", "incorporated", "--as", "a"]);
    await bunRun(["mark", "disp5", "2", "wontfix", "--as", "a"]);
    await bunRun(["reopen", "disp5", "2", "--as", "a"]); // id2 back to open

    const open = JSON.parse((await bunRun(["pull", "disp5", "--status", "open"])).stdout)
      .messages.map((m: { id: number }) => m.id)
      .sort();
    expect(open).toEqual([2, 3]); // 2 reopened, 3 never marked
    const inc = JSON.parse(
      (await bunRun(["pull", "disp5", "--status", "incorporated"])).stdout,
    ).messages.map((m: { id: number }) => m.id);
    expect(inc).toEqual([1]);
  });

  test("triage groups open on top + dispositioned by status (V1.9)", async () => {
    await bunRun(["open", "disp6"]);
    await bunRun(["send", "disp6", "--from", "a", "one"]); // id1
    await bunRun(["send", "disp6", "--from", "a", "two"]); // id2
    await bunRun(["mark", "disp6", "1", "incorporated", "--as", "a"]);
    const t = JSON.parse((await bunRun(["triage", "disp6"])).stdout);
    expect(t.open.map((m: { id: number }) => m.id)).toEqual([2]);
    expect(t.by_status.incorporated.map((m: { id: number }) => m.id)).toEqual([1]);
  });

  test("triage + --status open skip non-message frames (topic/announcement)", async () => {
    await bunRun(["open", "disp7"]);
    await bunRun(["send", "disp7", "--from", "a", "real item"]); // id1 (message)
    await bunRun(["topic", "disp7", "kickoff"]); // appends a kind:"topic" frame
    await bunRun(["announce", "--channels", "disp7", "--from", "a", "heads up"]); // kind:"announcement"

    // The open queue is signal-only: only actionable kind:"message" frames.
    const t = JSON.parse((await bunRun(["triage", "disp7"])).stdout);
    expect(t.open.every((m: { kind: string }) => m.kind === "message")).toBe(true);
    expect(t.open.map((m: { text: string }) => m.text)).toEqual(["real item"]);

    // pull --status open mirrors triage's open bucket.
    const open = JSON.parse((await bunRun(["pull", "disp7", "--status", "open"])).stdout).messages;
    expect(open.every((m: { kind: string }) => m.kind === "message")).toBe(true);
    expect(open.map((m: { text: string }) => m.text)).toEqual(["real item"]);
  });

  test("triage --human renders a grouped readable dashboard (not JSON)", async () => {
    await bunRun(["open", "disp8"]);
    await bunRun(["send", "disp8", "--from", "a", "still open thing"]); // id1
    await bunRun(["send", "disp8", "--from", "a", "done thing"]); // id2
    await bunRun(["mark", "disp8", "2", "incorporated", "--as", "a"]);
    const out = (await bunRun(["triage", "disp8", "--human"])).stdout;
    expect(out.trimStart().startsWith("{")).toBe(false); // not a JSON envelope
    expect(out).toContain("OPEN (1)");
    expect(out).toContain("still open thing");
    expect(out).toContain("INCORPORATED (1)");
    expect(out).toContain("done thing");
    // the open item appears above its disposition group
    expect(out.indexOf("OPEN (1)")).toBeLessThan(out.indexOf("INCORPORATED (1)"));
  });

  test("presence roster dedupes a seat with multiple connections by alias", async () => {
    await bunRun(["open", "dedup1"]);
    const t1 = spawnTail("dedup1", ["--as", "fathom"]);
    const t2 = spawnTail("dedup1", ["--as", "fathom"]);
    await sleep(500); // let both subscriptions land
    const who = JSON.parse((await bunRun(["who", "dedup1"])).stdout);
    t1.proc.kill("SIGTERM");
    t2.proc.kill("SIGTERM");
    // the roster lists the alias once, even though two connections are present
    expect(who.subscribers.filter((a: string) => a === "fathom")).toEqual(["fathom"]);
    // connection count still reflects both live connections
    expect(who.connections).toBeGreaterThanOrEqual(2);
  });

  test("reap kills an orphan daemon but never the authoritative (V1.9)", async () => {
    await bunRun(["start"]); // authoritative for HOME
    const auth = JSON.parse((await bunRun(["doctor"])).stdout).authoritative;

    // Spawn an orphan: a daemon under a DIFFERENT, throwaway home dir, then delete
    // that home's port file so nothing recognizes it.
    const orphanHome = mkdtempSync(join(tmpdir(), "gv-orphan-"));
    const op = spawn(process.execPath, [DAEMON], {
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
    expect(JSON.parse((await bunRun(["doctor"])).stdout).authoritative.pid).toBe(auth.pid);

    TRACKED_PROCS.delete(op);
    rmSync(orphanHome, { recursive: true, force: true });
    await bunRun(["stop"]);
  });
});
