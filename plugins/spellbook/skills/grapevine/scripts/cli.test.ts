// Integration tests for the grapevine CLI + daemon. Spawns a fresh daemon
// against a tmpdir GRAPEVINE_HOME, exercises the verbs end to end.
//
// Run with: bun test from this directory.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "grapevine-test-"));
const CLI = join(import.meta.dir, "cli.ts");

// Track every long-lived child process we spawn (tails, the wait helper,
// etc.) so afterAll can SIGTERM them even if `bunRun(["stop"])` fails or
// is skipped. Prevents zombie daemons/tails from accumulating across runs.
const TRACKED_PROCS = new Set<ReturnType<typeof spawn>>();

function bunRun(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("exit", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      }),
    );
  });
}

// Like bunRun, but feeds `input` to the child's stdin (stdin is a pipe, not
// ignored). For exercising `send`'s stdin-reading paths without a real shell.
function bunRunStdin(
  args: string[],
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    proc.stderr.on("data", (b) => err.push(b));
    proc.on("exit", (code) =>
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"),
      }),
    );
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function spawnTail(
  name: string,
  extra: string[] = [],
): { proc: ReturnType<typeof spawn>; output: () => string } {
  const buf: Buffer[] = [];
  const proc = spawn(process.execPath, [CLI, "tail", name, ...extra], {
    env: { ...process.env, GRAPEVINE_HOME: HOME },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (b) => buf.push(b));
  TRACKED_PROCS.add(proc);
  proc.on("exit", () => TRACKED_PROCS.delete(proc));
  return { proc, output: () => Buffer.concat(buf).toString("utf-8") };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

afterAll(async () => {
  // SIGTERM any tracked child processes first (tails etc.) so they can't
  // race-spawn a new daemon during teardown — same race that produced
  // today's zombie sweep.
  for (const proc of TRACKED_PROCS) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  TRACKED_PROCS.clear();
  await sleep(150);
  // Then ask the daemon to stop politely.
  await bunRun(["stop"]);
  await sleep(100);
  // Belt-and-suspenders: if the port file still points at a live process,
  // kill it directly. Catches the case where `stop` didn't reach the daemon.
  try {
    const pidPath = join(HOME, "daemon.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(require("node:fs").readFileSync(pidPath, "utf-8").trim(), 10);
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  } catch {}
  rmSync(HOME, { recursive: true, force: true });
});

describe("grapevine cli", () => {
  test("open creates a channel idempotently", async () => {
    const r1 = await bunRun(["open", "test1"]);
    expect(r1.code).toBe(0);
    expect(JSON.parse(r1.stdout).channel.name).toBe("test1");

    const r2 = await bunRun(["open", "test1"]);
    expect(r2.code).toBe(0);
    expect(JSON.parse(r2.stdout).channel.name).toBe("test1");
  });

  test("send appends a message and assigns id", async () => {
    await bunRun(["open", "test2"]);
    const r = await bunRun(["send", "test2", "--from", "alice", "hello"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(1);
    expect(parsed.channel).toBe("test2");
    expect(parsed.subscribers).toBe(0);
    expect(parsed.warning).toBe("channel has no subscribers");
  });

  test("send --quiet suppresses stdout on success", async () => {
    await bunRun(["open", "test_quiet"]);
    const r = await bunRun(["send", "test_quiet", "--from", "x", "--quiet", "shh"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("GRAPEVINE_FROM provides default alias", async () => {
    await bunRun(["open", "test_env"]);
    // Use bunRun's env merge with a custom override.
    const proc = spawn(process.execPath, [CLI, "send", "test_env", "hi"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME, GRAPEVINE_FROM: "viaenv" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    const code: number = await new Promise((r) => proc.on("exit", (c) => r(c ?? -1)));
    expect(code).toBe(0);
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string }) => c.name === "test_env",
    );
    expect(ch.message_count).toBe(1);
  });

  test("list shows channels with counts", async () => {
    await bunRun(["open", "test3"]);
    await bunRun(["send", "test3", "--from", "x", "one"]);
    await bunRun(["send", "test3", "--from", "x", "two"]);
    const r = await bunRun(["list"]);
    const data = JSON.parse(r.stdout);
    const ch = data.channels.find((c: { name: string }) => c.name === "test3");
    expect(ch).toBeDefined();
    expect(ch.message_count).toBe(2);
  });

  test("tail receives live messages", async () => {
    await bunRun(["open", "test4"]);
    const { proc, output } = spawnTail("test4");
    await sleep(400); // let subscription land
    await bunRun(["send", "test4", "--from", "bob", "live ping"]);
    await sleep(300);
    proc.kill("SIGTERM");
    const lines = output()
      .trim()
      .split("\n")
      .filter((l) => l);
    expect(lines.length).toBe(1);
    const m = JSON.parse(lines[0]);
    expect(m.from).toBe("bob");
    expect(m.text).toBe("live ping");
  });

  test("--from-start replays backlog", async () => {
    await bunRun(["open", "test5"]);
    await bunRun(["send", "test5", "--from", "a", "msg1"]);
    await bunRun(["send", "test5", "--from", "b", "msg2"]);
    const { proc, output } = spawnTail("test5", ["--from-start"]);
    await sleep(400);
    proc.kill("SIGTERM");
    const lines = output()
      .trim()
      .split("\n")
      .filter((l) => l);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).text).toBe("msg1");
    expect(JSON.parse(lines[1]).text).toBe("msg2");
  });

  test("two tails get the same message", async () => {
    await bunRun(["open", "test6"]);
    const a = spawnTail("test6");
    const b = spawnTail("test6");
    await sleep(400);
    await bunRun(["send", "test6", "--from", "x", "broadcast"]);
    await sleep(300);
    a.proc.kill("SIGTERM");
    b.proc.kill("SIGTERM");
    const aLines = a
      .output()
      .trim()
      .split("\n")
      .filter((l) => l);
    const bLines = b
      .output()
      .trim()
      .split("\n")
      .filter((l) => l);
    expect(aLines.length).toBe(1);
    expect(bLines.length).toBe(1);
    expect(JSON.parse(aLines[0]).id).toBe(JSON.parse(bLines[0]).id);
  });

  test("close removes the channel and its log", async () => {
    await bunRun(["open", "test7"]);
    await bunRun(["send", "test7", "--from", "x", "before close"]);
    const r = await bunRun(["close", "test7"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(HOME, "channels", "test7.jsonl"))).toBe(false);
  });

  test("invalid channel name rejected", async () => {
    const r = await bunRun(["open", "bad/name"]);
    expect(r.code).not.toBe(0);
  });

  test("channel names with internal dots are accepted (e.g. v1.7)", async () => {
    const r = await bunRun(["open", "grapevine-v1.7"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).channel.name).toBe("grapevine-v1.7");
  });

  test("channel name with leading dot rejected", async () => {
    const r = await bunRun(["open", ".hidden"]);
    expect(r.code).not.toBe(0);
  });

  test("channel name with trailing dot rejected", async () => {
    const r = await bunRun(["open", "trailing."]);
    expect(r.code).not.toBe(0);
  });

  test("channel name with consecutive dots rejected (no path traversal)", async () => {
    const r = await bunRun(["open", "foo..bar"]);
    expect(r.code).not.toBe(0);
  });

  test("channel name '..' rejected", async () => {
    const r = await bunRun(["open", ".."]);
    expect(r.code).not.toBe(0);
  });

  test("who returns subscriber aliases", async () => {
    await bunRun(["open", "test_who"]);
    const a = spawnTail("test_who", ["--as", "alice"]);
    const b = spawnTail("test_who", ["--as", "bob"]);
    await sleep(500);
    const r = await bunRun(["who", "test_who"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.channel).toBe("test_who");
    expect(data.subscribers.sort()).toEqual(["alice", "bob"]);
    expect(data.count).toBe(2);
    a.proc.kill("SIGTERM");
    b.proc.kill("SIGTERM");
  });

  test("tail --human marks the connection as human in who (V1.7)", async () => {
    await bunRun(["open", "test_human"]);
    const human = spawnTail("test_human", ["--as", "cole", "--human"]);
    const agent = spawnTail("test_human", ["--as", "flint"]);
    await sleep(500);
    const r = await bunRun(["who", "test_human"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    // Both show as named subscribers; only the human is flagged in `humans`.
    expect(data.subscribers.sort()).toEqual(["cole", "flint"]);
    expect(data.humans).toEqual(["cole"]);
    human.proc.kill("SIGTERM");
    agent.proc.kill("SIGTERM");
  });

  test("alias set then show round-trips via config.json (V1.7)", async () => {
    const set = await bunRun(["alias", "cole"]);
    expect(set.code).toBe(0);
    expect(JSON.parse(set.stdout).alias).toBe("cole");
    const get = await bunRun(["alias"]);
    expect(JSON.parse(get.stdout).alias).toBe("cole");
  });

  test("GET /identity serves the configured alias (V1.7)", async () => {
    await bunRun(["alias", "cole-laptop"]);
    // Need a running daemon to serve /identity — any verb that ensures one.
    await bunRun(["open", "test_identity"]);
    const port = parseInt(readFileSync(join(HOME, "daemon.port"), "utf-8").trim(), 10);
    const res = await fetch(`http://127.0.0.1:${port}/identity`);
    const data = (await res.json()) as { alias: string | null };
    expect(data.alias).toBe("cole-laptop");
  });

  test("send --in-reply-to threads a message (V1.7)", async () => {
    await bunRun(["open", "test_thread"]);
    await bunRun(["send", "test_thread", "--from", "a", "original"]); // id 1
    const r = await bunRun(["send", "test_thread", "--from", "b", "--in-reply-to", "1", "a reply"]); // id 2
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).id).toBe(2);
    const pull = await bunRun(["pull", "test_thread", "--since", "0"]);
    const msgs = JSON.parse(pull.stdout).messages as Array<{
      id: number;
      in_reply_to?: number;
    }>;
    // The reply carries the field; the original (a plain send) does not.
    expect(msgs.find((m) => m.id === 2)?.in_reply_to).toBe(1);
    expect(msgs.find((m) => m.id === 1)?.in_reply_to).toBeUndefined();
  });

  test("archive makes a channel read-only; unarchive restores (V1.7)", async () => {
    await bunRun(["open", "test_arch"]);
    await bunRun(["send", "test_arch", "--from", "a", "before archive"]);

    const arch = await bunRun(["archive", "test_arch"]);
    expect(arch.code).toBe(0);
    expect(JSON.parse(arch.stdout).archived).toBe(true);

    // list reflects the archived flag
    const list = await bunRun(["list"]);
    const ch = JSON.parse(list.stdout).channels.find(
      (c: { name: string; archived?: boolean }) => c.name === "test_arch",
    );
    expect(ch.archived).toBe(true);

    // sends are rejected, but history stays readable
    const blocked = await bunRun(["send", "test_arch", "--from", "a", "nope"]);
    expect(blocked.code).not.toBe(0);
    const pull = await bunRun(["pull", "test_arch", "--since", "0"]);
    expect(JSON.parse(pull.stdout).messages.length).toBe(1);

    // the name is locked from re-open
    const reopen = await bunRun(["open", "test_arch"]);
    expect(reopen.code).not.toBe(0);

    // unarchive brings it back to writable
    const un = await bunRun(["unarchive", "test_arch"]);
    expect(JSON.parse(un.stdout).archived).toBe(false);
    const ok = await bunRun(["send", "test_arch", "--from", "a", "works again"]);
    expect(ok.code).toBe(0);
  });

  test("tail --lurk receives messages but is invisible to who (V1.7)", async () => {
    await bunRun(["open", "test_lurk"]);
    const named = spawnTail("test_lurk", ["--as", "watcher"]);
    const lurker = spawnTail("test_lurk", ["--lurk"]);
    await sleep(500);

    // who counts only the named subscriber — the lurker bumps nothing.
    const w = await bunRun(["who", "test_lurk"]);
    const d = JSON.parse(w.stdout);
    expect(d.subscribers).toEqual(["watcher"]);
    expect(d.connections).toBe(1);
    expect(d.anonymous).toBe(0);

    // ...and the channel-list count must agree (a lurker mustn't tick the
    // left-rail badge while `who` shows no one).
    const list = await bunRun(["list"]);
    const lch = JSON.parse(list.stdout).channels.find(
      (c: { name: string; subscribers: number }) => c.name === "test_lurk",
    );
    expect(lch.subscribers).toBe(1);

    // ...and `/presence` (who --all) must exclude the lurker too.
    const all = await bunRun(["who", "--all"]);
    const pch = JSON.parse(all.stdout).channels.find(
      (c: { name: string; connections: number; subscribers: string[] }) => c.name === "test_lurk",
    );
    expect(pch.connections).toBe(1);
    expect(pch.subscribers).toEqual(["watcher"]);

    // ...but the lurker still receives live messages.
    await bunRun(["send", "test_lurk", "--from", "speaker", "for the lurker"]);
    await sleep(300);
    named.proc.kill("SIGTERM");
    lurker.proc.kill("SIGTERM");
    expect(lurker.output()).toContain("for the lurker");
  });

  test("tail boolean flags parse before the channel arg (V1.7)", async () => {
    // Regression: `--human`/`--lurk` are boolean. If they weren't, a flag
    // placed before the channel name would swallow it and the CLI would die
    // with a usage error instead of tailing.
    await bunRun(["open", "test_flagorder"]);
    const proc = spawn(
      process.execPath,
      [CLI, "tail", "--human", "test_flagorder", "--as", "zoe"],
      {
        env: { ...process.env, GRAPEVINE_HOME: HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    TRACKED_PROCS.add(proc);
    let exited = false;
    proc.on("exit", () => {
      exited = true;
      TRACKED_PROCS.delete(proc);
    });
    await sleep(500);
    expect(exited).toBe(false); // didn't die on a swallowed channel arg
    const w = await bunRun(["who", "test_flagorder"]);
    expect(JSON.parse(w.stdout).humans).toEqual(["zoe"]); // channel + --human both parsed
    proc.kill("SIGTERM");
  });

  test("pull returns backlog since cursor", async () => {
    await bunRun(["open", "test_pull"]);
    await bunRun(["send", "test_pull", "--from", "x", "one"]);
    await bunRun(["send", "test_pull", "--from", "x", "two"]);
    const r = await bunRun(["pull", "test_pull", "--since", "0"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.messages.length).toBe(2);
    expect(data.cursor).toBe(2);
    // Pull again with cursor at top — no new messages.
    const r2 = await bunRun(["pull", "test_pull", "--since", String(data.cursor)]);
    expect(JSON.parse(r2.stdout).messages.length).toBe(0);
  });

  test("wait returns immediately when messages already present", async () => {
    await bunRun(["open", "test_wait_now"]);
    await bunRun(["send", "test_wait_now", "--from", "x", "ready"]);
    const t0 = Date.now();
    const r = await bunRun(["wait", "test_wait_now", "--since", "0", "--timeout", "5"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.messages.length).toBe(1);
    expect(data.timed_out).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000); // should be immediate
  });

  test("wait blocks then resolves on new message", async () => {
    await bunRun(["open", "test_wait_block"]);
    // Kick off a wait at the current head (no messages yet).
    const waitProc = spawn(
      process.execPath,
      [CLI, "wait", "test_wait_block", "--since", "0", "--timeout", "5"],
      {
        env: { ...process.env, GRAPEVINE_HOME: HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const out: Buffer[] = [];
    waitProc.stdout.on("data", (b) => out.push(b));
    // Attach the exit listener IMMEDIATELY after spawn. If the wait process
    // happens to exit fast (drain landed quickly), attaching the listener
    // later (after the `await sleep` + send below) would miss the exit
    // event entirely — Node's child_process exit is one-shot, not buffered.
    // That race made this test flake intermittently with no actual hang.
    const exitPromise: Promise<number> = new Promise((r) => waitProc.on("exit", (c) => r(c ?? -1)));
    // Send a message a moment later — give the wait process time to bind
    // and register before the send fires.
    await sleep(800);
    await bunRun(["send", "test_wait_block", "--from", "x", "hi"]);
    const code = await exitPromise;
    expect(code).toBe(0);
    const data = JSON.parse(Buffer.concat(out).toString("utf-8"));
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].text).toBe("hi");
    expect(data.timed_out).toBe(false);
  });

  test("wait times out cleanly with empty messages + unchanged cursor", async () => {
    await bunRun(["open", "test_wait_timeout"]);
    await bunRun(["send", "test_wait_timeout", "--from", "x", "anchor"]);
    const r = await bunRun(["wait", "test_wait_timeout", "--since", "1", "--timeout", "0.4"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.timed_out).toBe(true);
    expect(data.messages.length).toBe(0);
    expect(data.cursor).toBe(1);
  });

  test("open --topic sets the channel topic", async () => {
    const r = await bunRun(["open", "test_topic_set", "--topic", "discussing the X feature"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).channel.topic).toBe("discussing the X feature");
    const t = await bunRun(["topic", "test_topic_set"]);
    expect(JSON.parse(t.stdout).topic).toBe("discussing the X feature");
  });

  test("topic verb updates the channel topic", async () => {
    await bunRun(["open", "test_topic_update"]);
    await bunRun(["topic", "test_topic_update", "first topic"]);
    await bunRun(["topic", "test_topic_update", "second topic"]);
    const r = await bunRun(["topic", "test_topic_update"]);
    expect(JSON.parse(r.stdout).topic).toBe("second topic");
  });

  test("re-opening with a different --topic does not clobber existing topic", async () => {
    await bunRun(["open", "test_topic_noclobber", "--topic", "original"]);
    await bunRun(["open", "test_topic_noclobber", "--topic", "ignored"]);
    const r = await bunRun(["topic", "test_topic_noclobber"]);
    expect(JSON.parse(r.stdout).topic).toBe("original");
  });

  test("who response includes current topic", async () => {
    await bunRun(["open", "test_topic_who", "--topic", "what we're doing"]);
    const r = await bunRun(["who", "test_topic_who"]);
    expect(JSON.parse(r.stdout).topic).toBe("what we're doing");
  });

  test("wait --as registers presence for the wait duration", async () => {
    await bunRun(["open", "test_wait_presence"]);
    // Spawn a wait that will block for 2s, then check who while it's blocked.
    const waitProc = spawn(
      process.execPath,
      [CLI, "wait", "test_wait_presence", "--as", "polly", "--since", "0", "--timeout", "2"],
      {
        env: { ...process.env, GRAPEVINE_HOME: HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    // Attach exit listener immediately so a fast exit doesn't race past us
    // (same pattern as the "wait blocks then resolves" test fix).
    const exitPromise = new Promise((res) => waitProc.on("exit", res));
    await sleep(400); // let wait register
    const r = await bunRun(["who", "test_wait_presence"]);
    expect(JSON.parse(r.stdout).subscribers).toContain("polly");
    // Wait for the wait to time out.
    await exitPromise;
    // After it exits, polly should be gone.
    const r2 = await bunRun(["who", "test_wait_presence"]);
    expect(JSON.parse(r2.stdout).subscribers).not.toContain("polly");
  });

  test("send --stdin reads body from stdin", async () => {
    await bunRun(["open", "test_stdin"]);
    const proc = spawn(process.execPath, [CLI, "send", "test_stdin", "--from", "x", "--stdin"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.write(`text with <brackets> & "quotes" & \`backticks\``);
    proc.stdin.end();
    const out: Buffer[] = [];
    proc.stdout.on("data", (b) => out.push(b));
    const code: number = await new Promise((r) => proc.on("exit", (c) => r(c ?? -1)));
    expect(code).toBe(0);
    const pulled = await bunRun(["pull", "test_stdin", "--since", "0"]);
    const msg = JSON.parse(pulled.stdout).messages[0];
    expect(msg.text).toBe(`text with <brackets> & "quotes" & \`backticks\``);
  });

  test("tail emits truncation hint before text for long messages", async () => {
    await bunRun(["open", "test_trunc"]);
    const t = spawnTail("test_trunc", ["--as", "observer"]);
    await sleep(400);
    const longBody = "x".repeat(2500); // > the raised ~2000 default threshold
    await bunRun(["send", "test_trunc", "--from", "talker", longBody]);
    await sleep(400);
    const line = t
      .output()
      .split("\n")
      .filter(Boolean)
      .find((l) => l.includes('"text"'));
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.text.length).toBe(2500);
    expect(payload.truncation_hint).toBeDefined();
    expect(payload.truncation_hint).toContain("2500 chars");
    // Hint carries the exact recovery command: `read <channel> <id>`.
    expect(payload.truncation_hint).toContain(`read test_trunc ${payload.id}`);
    // F17: the hint must serialize BEFORE .text so a notification clip (which
    // lands inside .text) can't bury it.
    expect(line.indexOf("truncation_hint")).toBeGreaterThanOrEqual(0);
    expect(line.indexOf("truncation_hint")).toBeLessThan(line.indexOf('"text"'));
    t.proc.kill("SIGTERM");
  });

  test("tail does not emit truncation hint below the raised threshold", async () => {
    await bunRun(["open", "test_short"]);
    const t = spawnTail("test_short", ["--as", "observer"]);
    await sleep(400);
    // 1000 chars: above the OLD 800 default, below the NEW ~2000 default — so a
    // raised threshold means no hint. Proves the default was actually raised.
    await bunRun(["send", "test_short", "--from", "talker", "z".repeat(1000)]);
    await sleep(400);
    const line = t
      .output()
      .split("\n")
      .filter(Boolean)
      .find((l) => l.includes('"text"'));
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.truncation_hint).toBeUndefined();
    t.proc.kill("SIGTERM");
  });

  test("tail respects GRAPEVINE_TRUNCATION_HINT_THRESHOLD env override", async () => {
    await bunRun(["open", "test_thresh"]);
    const buf: Buffer[] = [];
    const proc = spawn(process.execPath, [CLI, "tail", "test_thresh", "--as", "observer"], {
      env: {
        ...process.env,
        GRAPEVINE_HOME: HOME,
        GRAPEVINE_TRUNCATION_HINT_THRESHOLD: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (b) => buf.push(b));
    await sleep(400);
    // 100 chars > 50-char override → should get hint.
    await bunRun(["send", "test_thresh", "--from", "talker", "y".repeat(100)]);
    await sleep(400);
    const line = Buffer.concat(buf).toString("utf-8").split("\n").filter(Boolean)[0];
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.truncation_hint).toBeDefined();
    expect(payload.truncation_hint).toContain("100 chars");
    proc.kill("SIGTERM");
  });

  test("grep returns regex-matched messages (case-insensitive default)", async () => {
    await bunRun(["open", "test_grep"]);
    await bunRun(["send", "test_grep", "--from", "a", "Apple pie"]);
    await bunRun(["send", "test_grep", "--from", "b", "banana bread"]);
    await bunRun(["send", "test_grep", "--from", "a", "APPLE crisp"]);
    const r = await bunRun(["grep", "test_grep", "apple"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.messages.length).toBe(2);
    expect(data.messages[0].text).toBe("Apple pie");
    expect(data.messages[1].text).toBe("APPLE crisp");
  });

  test("grep --literal does substring match", async () => {
    await bunRun(["open", "test_grep_lit"]);
    await bunRun(["send", "test_grep_lit", "--from", "a", "a.b match"]);
    await bunRun(["send", "test_grep_lit", "--from", "a", "axb skip"]);
    const r = await bunRun(["grep", "test_grep_lit", "a.b", "--literal"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].text).toBe("a.b match");
  });

  test("grep --from filters by sender", async () => {
    await bunRun(["open", "test_grep_from"]);
    await bunRun(["send", "test_grep_from", "--from", "alice", "hello world"]);
    await bunRun(["send", "test_grep_from", "--from", "bob", "hello there"]);
    const r = await bunRun(["grep", "test_grep_from", "hello", "--from", "alice"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.messages.length).toBe(1);
    expect(data.messages[0].from).toBe("alice");
  });

  test("grep on a missing channel returns empty messages", async () => {
    const r = await bunRun(["grep", "no_such_channel_xyz", "anything"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.messages).toEqual([]);
  });

  test("grep with invalid regex errors gracefully", async () => {
    await bunRun(["open", "test_grep_bad"]);
    await bunRun(["send", "test_grep_bad", "--from", "a", "hi"]);
    const r = await bunRun(["grep", "test_grep_bad", "[invalid"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("invalid regex");
  });

  test("doctor reports authoritative daemon, channels, and hints", async () => {
    // Send a message so the channel JSONL actually lands on disk
    // (open without --topic is in-memory only until first append).
    await bunRun(["open", "test_doctor_ch"]);
    await bunRun(["send", "test_doctor_ch", "--from", "x", "hello"]);
    const r = await bunRun(["doctor"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.home).toBe(HOME);
    expect(typeof data.cli_version).toBe("string");
    expect(data.authoritative).toBeDefined();
    expect(data.authoritative.version).toBeDefined();
    expect(Array.isArray(data.other_daemons_on_machine)).toBe(true);
    expect(Array.isArray(data.channels_on_disk)).toBe(true);
    expect(data.channels_on_disk).toContain("test_doctor_ch");
    expect(Array.isArray(data.hints)).toBe(true);
    expect(data.active_subscribers).toBeDefined();
    expect(typeof data.active_subscribers.total).toBe("number");
    expect(Array.isArray(data.active_subscribers.busy_channels)).toBe(true);
    // test_doctor_ch shouldn't appear as busy since no tail was opened on it.
    const ownEntry = data.active_subscribers.busy_channels.find(
      (c: { name: string }) => c.name === "test_doctor_ch",
    );
    expect(ownEntry).toBeUndefined();
  });

  test("doctor surfaces active subscribers when present", async () => {
    await bunRun(["open", "test_doctor_busy"]);
    const t = spawnTail("test_doctor_busy", ["--as", "watcher"]);
    await sleep(400);
    const r = await bunRun(["doctor"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.active_subscribers.total).toBeGreaterThan(0);
    const busy = data.active_subscribers.busy_channels.find(
      (c: { name: string }) => c.name === "test_doctor_busy",
    );
    expect(busy).toBeDefined();
    expect(busy.subscribers).toBeGreaterThan(0);
    expect(data.hints.some((h: string) => h.includes("active subscriber"))).toBe(true);
    t.proc.kill("SIGTERM");
  });

  test("info response includes plugin version", async () => {
    // Trigger daemon spawn, then check info.
    await bunRun(["open", "test_version"]);
    const r = await bunRun(["info"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.daemon).toBe(true);
    expect(typeof data.version).toBe("string");
    expect(data.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("send response includes both subscribers and recipients", async () => {
    await bunRun(["open", "test_recipients"]);
    const a = spawnTail("test_recipients", ["--as", "alice"]);
    const b = spawnTail("test_recipients", ["--as", "bob"]);
    await sleep(400);
    const r = await bunRun(["send", "test_recipients", "--from", "alice", "hello"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    // alice + bob subscribed; alice sends → recipients excludes alice.
    expect(data.subscribers).toBe(2);
    expect(data.recipients).toBe(1);
    a.proc.kill("SIGTERM");
    b.proc.kill("SIGTERM");
  });

  test("send warns when sender is the only subscriber", async () => {
    await bunRun(["open", "test_lonely"]);
    const a = spawnTail("test_lonely", ["--as", "solo"]);
    await sleep(400);
    const r = await bunRun(["send", "test_lonely", "--from", "solo", "hi self"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.subscribers).toBe(1);
    expect(data.recipients).toBe(0);
    expect(data.warning).toBe("only you are subscribed");
    a.proc.kill("SIGTERM");
  });

  test("send --verbose includes subscriber aliases", async () => {
    await bunRun(["open", "test_verbose"]);
    const a = spawnTail("test_verbose", ["--as", "alice"]);
    await sleep(400);
    const r = await bunRun(["send", "test_verbose", "--from", "outside", "--verbose", "hi"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.subscriber_aliases).toEqual(["alice"]);
    expect(data.subscribers).toBe(1);
    a.proc.kill("SIGTERM");
  });

  test("read returns one full message by id", async () => {
    await bunRun(["open", "test_read"]);
    await bunRun(["send", "test_read", "--from", "a", "first"]);
    await bunRun(["send", "test_read", "--from", "b", "second"]);
    await bunRun(["send", "test_read", "--from", "c", "third"]);
    const r = await bunRun(["read", "test_read", "2"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.message.id).toBe(2);
    expect(data.message.from).toBe("b");
    expect(data.message.text).toBe("second");
  });

  test("read --text prints prose without JSON envelope", async () => {
    await bunRun(["open", "test_read_text"]);
    await bunRun(["send", "test_read_text", "--from", "narrator", "the body"]);
    const r = await bunRun(["read", "test_read_text", "1", "--text"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[1] narrator");
    expect(r.stdout).toContain("the body");
    expect(r.stdout.trimStart().startsWith("{")).toBe(false);
  });

  test("read errors on a missing id", async () => {
    await bunRun(["open", "test_read_missing"]);
    await bunRun(["send", "test_read_missing", "--from", "x", "only one"]);
    const r = await bunRun(["read", "test_read_missing", "999"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("not found");
  });

  test("send accepts --as as an identity alias (interchangeable with --from)", async () => {
    await bunRun(["open", "test_as_send"]);
    const r = await bunRun(["send", "test_as_send", "--as", "viaAs", "hi"]);
    expect(r.code).toBe(0);
    const pulled = await bunRun(["pull", "test_as_send", "--since", "0"]);
    expect(JSON.parse(pulled.stdout).messages[0].from).toBe("viaAs");
  });

  test("tail accepts --from as an identity alias (self-echo suppressed)", async () => {
    await bunRun(["open", "test_from_tail"]);
    // Subscribe with --from instead of --as; our own sends should be dropped.
    const t = spawnTail("test_from_tail", ["--from", "self"]);
    await sleep(400);
    await bunRun(["send", "test_from_tail", "--from", "self", "echo me"]);
    await bunRun(["send", "test_from_tail", "--from", "other", "keep me"]);
    await sleep(400);
    const lines = t
      .output()
      .trim()
      .split("\n")
      .filter((l) => l);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).from).toBe("other");
    t.proc.kill("SIGTERM");
  });

  test("a hard-killed tail is reaped from who within a few seconds", async () => {
    await bunRun(["open", "test_reap"]);
    const t = spawnTail("test_reap", ["--as", "ghost"]);
    await sleep(600); // let the subscription land
    const before = JSON.parse((await bunRun(["who", "test_reap"])).stdout);
    expect(before.subscribers).toContain("ghost");

    // SIGKILL simulates a crashed / abruptly-terminated consumer — no clean
    // SSE close. This is the failure mode that left minute-long ghosts in the
    // V1.6 multi-channel roundtable (the daemon's enqueue-catch reaper does not
    // fire reliably under Bun, leaving idleTimeout:255 as the de-facto reaper).
    t.proc.kill("SIGKILL");

    // Poll who until ghost is reaped, up to ~6s. A correct daemon reaps the
    // dead connection within seconds; the pre-fix daemon lingers far past this.
    let reaped = false;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(500);
      const w = JSON.parse((await bunRun(["who", "test_reap"])).stdout);
      if (!w.subscribers.includes("ghost")) {
        reaped = true;
        break;
      }
    }
    expect(reaped).toBe(true);
  }, 15000);

  test("who distinguishes named subscribers from anonymous connections", async () => {
    await bunRun(["open", "test_anon"]);
    const named = spawnTail("test_anon", ["--as", "alice"]);
    const anon = spawnTail("test_anon"); // no --as → null alias, like a watch tab
    await sleep(600);
    const who = JSON.parse((await bunRun(["who", "test_anon"])).stdout);
    // The name list shows only the named subscriber; explicit counts account
    // for the anonymous connection so `count` is never a mystery vs. names.
    expect(who.subscribers).toEqual(["alice"]);
    expect(who.named).toBe(1);
    expect(who.anonymous).toBe(1);
    expect(who.connections).toBe(2);
    named.proc.kill("SIGTERM");
    anon.proc.kill("SIGTERM");
  });

  test("who --all returns subscribers across all channels in one call", async () => {
    await bunRun(["open", "wa_one"]);
    await bunRun(["open", "wa_two"]);
    const a = spawnTail("wa_one", ["--as", "alice"]);
    const b = spawnTail("wa_two", ["--as", "bob"]);
    const a2 = spawnTail("wa_two", ["--as", "alice"]);
    await sleep(600);
    const r = await bunRun(["who", "--all"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(Array.isArray(data.channels)).toBe(true);
    const one = data.channels.find((c: { name: string }) => c.name === "wa_one");
    const two = data.channels.find((c: { name: string }) => c.name === "wa_two");
    expect(one.subscribers).toEqual(["alice"]);
    expect(two.subscribers.sort()).toEqual(["alice", "bob"]);
    expect(two.connections).toBe(2);
    a.proc.kill("SIGTERM");
    b.proc.kill("SIGTERM");
    a2.proc.kill("SIGTERM");
  });

  test("doctor reports named/anonymous breakdown and flags count-vs-names divergence", async () => {
    await bunRun(["open", "doc_div"]);
    const named = spawnTail("doc_div", ["--as", "alice"]);
    const anon = spawnTail("doc_div"); // null alias, like a watch tab
    await sleep(600);
    const r = await bunRun(["doctor"]);
    expect(r.code).toBe(0);
    const data = JSON.parse(r.stdout);
    const entry = data.active_subscribers.busy_channels.find(
      (c: { name: string }) => c.name === "doc_div",
    );
    expect(entry).toBeDefined();
    expect(entry.connections).toBe(2);
    expect(entry.named).toBe(1);
    expect(entry.anonymous).toBe(1);
    // Divergence (connections > named) is surfaced as a hint so the anonymous
    // watcher reads as a watcher, not a ghost.
    expect(
      data.hints.some((h: string) => h.includes("doc_div") && /anonymous|named/i.test(h)),
    ).toBe(true);
    named.proc.kill("SIGTERM");
    anon.proc.kill("SIGTERM");
  });

  test("tail emits a grounding line on stdout when joining a channel with history", async () => {
    await bunRun(["open", "ground_hist"]);
    await bunRun(["send", "ground_hist", "--from", "a", "old one"]);
    await bunRun(["send", "ground_hist", "--from", "a", "old two"]);
    // Default (HEAD) join: the newcomer sees nothing of the 2 prior messages,
    // so a grounding line should announce that earlier history exists (F7).
    const t = spawnTail("ground_hist", ["--as", "newcomer"]);
    await sleep(500);
    const grounding = t
      .output()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m.kind === "grounding");
    expect(grounding).toBeDefined();
    expect(grounding.channel).toBe("ground_hist");
    expect(grounding.earlier).toBe(2);
    t.proc.kill("SIGTERM");
  });

  test("tail emits a keepalive sentinel on stderr while idle", async () => {
    await bunRun(["open", "test_keepalive"]);
    const errBuf: Buffer[] = [];
    const proc = spawn(process.execPath, [CLI, "tail", "test_keepalive", "--as", "k"], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stderr.on("data", (b) => errBuf.push(b));
    TRACKED_PROCS.add(proc);
    proc.on("exit", () => TRACKED_PROCS.delete(proc));
    await sleep(4000); // longer than one 3s daemon heartbeat
    proc.kill("SIGTERM");
    const err = Buffer.concat(errBuf).toString("utf-8");
    expect(err).toContain("grapevine-keepalive");
  }, 10000);

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
});
