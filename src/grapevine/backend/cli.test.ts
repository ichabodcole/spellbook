// PART OF THE GRAPEVINE CLI SUITE: cli.test.ts plus its cli.*.test.ts
// siblings, one file once (about 62 s alone). It was split, by describe block
// and its long "grapevine cli" block into three runs of tests, so a parallel
// run is not floored by one file; every test body is unchanged. The shared
// harness is fixtures/cliSuite.ts, evaluated once per file: each file has its
// own GRAPEVINE_HOME, its own daemon, and stops both after its last test.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { looksShellRisky } from "./cli.ts";
import {
  at,
  bunRun,
  CLI,
  daemonPort,
  errorOf,
  HOME,
  listedChannels,
  must,
  sleep,
  spawnTail,
  stopSuiteProcesses,
  TRACKED_PROCS,
} from "./fixtures/cliSuite.ts";

afterAll(stopSuiteProcesses);

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
    const m = JSON.parse(at(lines, 0, "lines"));
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
    expect(JSON.parse(at(lines, 0, "lines")).text).toBe("msg1");
    expect(JSON.parse(at(lines, 1, "lines")).text).toBe("msg2");
  });

  test("--last N backfills only the most recent N, then goes live (#68)", async () => {
    await bunRun(["open", "test_last"]);
    for (const n of [1, 2, 3, 4, 5]) await bunRun(["send", "test_last", "--from", "a", `m${n}`]);
    // Cold joiner asks for the last 2 of 5 — no cursor, not the whole log.
    const { proc, output } = spawnTail("test_last", ["--last", "2"]);
    await sleep(400);
    // A live message after subscribe still arrives (the tail didn't stop at the backfill).
    await bunRun(["send", "test_last", "--from", "b", "live"]);
    await sleep(300);
    proc.kill("SIGTERM");
    const texts = output()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((m) => m.from) // drop the grounding frame (no `from`)
      .map((m) => m.text);
    expect(texts).toEqual(["m4", "m5", "live"]); // last 2 backfilled + the live one, not m1–m3
  });

  test("--last 0 backfills nothing but still tails live (#68)", async () => {
    await bunRun(["open", "test_last0"]);
    await bunRun(["send", "test_last0", "--from", "a", "old"]);
    const { proc, output } = spawnTail("test_last0", ["--last", "0"]);
    await sleep(400);
    await bunRun(["send", "test_last0", "--from", "b", "new"]);
    await sleep(300);
    proc.kill("SIGTERM");
    const texts = output()
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((m) => m.from) // drop the grounding frame (no `from`)
      .map((m) => m.text);
    expect(texts).toEqual(["new"]); // no backfill of "old", live "new" still flows
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
    expect(JSON.parse(at(aLines, 0, "aLines")).id).toBe(JSON.parse(at(bLines, 0, "bLines")).id);
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
    // One message — plus the kind:"status" archive frame the archive now
    // appends (2026-09-06), which is history too and is what a disconnected
    // agent learns from.
    const pull = await bunRun(["pull", "test_arch", "--since", "0"]);
    const arcMsgs = JSON.parse(pull.stdout).messages as { kind: string; event?: string }[];
    expect(arcMsgs.filter((m) => m.kind === "message").length).toBe(1);
    expect(arcMsgs.filter((m) => m.kind === "status").map((m) => m.event)).toEqual(["archived"]);

    // open auto-unarchives (the convene-at-start path): reopening a retired
    // channel brings it back rather than failing.
    const reopen = await bunRun(["open", "test_arch"]);
    expect(reopen.code).toBe(0);
    expect(JSON.parse(reopen.stdout).channel.unarchived).toBe(true);
    // and it is writable again immediately
    const afterReopen = await bunRun(["send", "test_arch", "--from", "a", "back"]);
    expect(afterReopen.code).toBe(0);

    // unarchive brings it back to writable
    const un = await bunRun(["unarchive", "test_arch"]);
    expect(JSON.parse(un.stdout).archived).toBe(false);
    const ok = await bunRun(["send", "test_arch", "--from", "a", "works again"]);
    expect(ok.code).toBe(0);
  });

  test("open auto-unarchives an archived channel (V1.8)", async () => {
    await bunRun(["open", "au_chan"]);
    await bunRun(["send", "au_chan", "--from", "a", "hi"]);
    expect(JSON.parse((await bunRun(["archive", "au_chan"])).stdout).archived).toBe(true);

    const reopen = await bunRun(["open", "au_chan"]);
    expect(reopen.code).toBe(0);
    expect(JSON.parse(reopen.stdout).channel.unarchived).toBe(true);

    // history is intact (auto-unarchive does NOT clear) — one real message,
    // bracketed by the archive frame and the frame `open`'s auto-unarchive
    // appends (2026-09-06: the third unarchive path, and the one that used to
    // be silent).
    const pull = await bunRun(["pull", "au_chan", "--since", "0"]);
    const auMsgs = JSON.parse(pull.stdout).messages as { kind: string; event?: string }[];
    expect(auMsgs.filter((m) => m.kind === "message").length).toBe(1);
    expect(auMsgs.filter((m) => m.kind === "status").map((m) => m.event)).toEqual([
      "archived",
      "unarchived",
    ]);

    // list no longer shows it archived
    const ch = JSON.parse((await bunRun(["list"])).stdout).channels.find(
      (c: { name: string; archived?: boolean }) => c.name === "au_chan",
    );
    expect(ch.archived).toBe(false);
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
});

describe("looksShellRisky (#60 inline-body footgun predicate)", () => {
  // Brace-expansion inputs are built as "$" + "{...}" so this file contains no
  // literal dollar-brace sequence (which biome's noTemplateCurlyInString flags).
  test("flags bodies with backticks, command-substitution, or brace vars", () => {
    expect(looksShellRisky("run `git add`")).toBe(true);
    expect(looksShellRisky("value is $(whoami)")).toBe(true);
    expect(looksShellRisky(`path $${"{HOME}/x"}`)).toBe(true);
    expect(looksShellRisky(`a \`b\` and $(c) and $${"{d}"}`)).toBe(true);
  });
  test("does NOT flag plain text or lone $ (no false positives on normal messages)", () => {
    expect(looksShellRisky("just a normal message")).toBe(false);
    expect(looksShellRisky("it costs $5 and it's fine")).toBe(false);
    expect(looksShellRisky("apostrophes ' and quotes \" are fine")).toBe(false);
    expect(looksShellRisky("")).toBe(false);
  });
});

// ── P0 — a >64KiB payload survives a PIPE (#77) ──────────────────────────
// Bun's stdout is ASYNCHRONOUS on a pipe and synchronous on a TTY or file, so
// `process.exit(code)` discards whatever has not drained. `pull` over an
// unbounded message log is this spell's over-buffer verb.
//
// ⚠ THE READER IS PART OF THE EXPERIMENT. A harness that spawns the CLI with a
// node/Bun pipe and drains it concurrently does NOT reproduce this — measured on
// bounty: shell pipe 65536, Bun.spawn pipe 114042, same board, defect present.
// So `bunRun` above CANNOT gate this defect, and a gate built on it passes in
// both worlds. The CLI's stdout must be a REAL SHELL PIPE; `sh -c` gives it one
// and the outer hop is where nothing is at stake. (Construction ratified for
// every P0 gate — see the bounty twin in bounty/scripts/server.test.ts.)
describe("P0 — a >64KiB pull survives a PIPE (#77)", () => {
  test("pull through a shell pipe is complete and parses", async () => {
    const ch = "p0_pipe";
    await bunRun(["open", ch]);
    // ~120KB of message log: comfortably over 64KiB, with headroom so ordinary
    // drift in the envelope cannot silently walk the fixture back under it.
    const body = "y".repeat(2000);
    for (let i = 0; i < 60; i++) {
      await bunRun(["send", ch, "--from", "p0", `${i}-${body}`]);
    }

    const shell = spawn("sh", ["-c", `${process.execPath} ${CLI} pull ${ch} --since 0 | cat`], {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    TRACKED_PROCS.add(shell);
    const chunks: Buffer[] = [];
    shell.stdout.on("data", (b) => chunks.push(b));
    await new Promise((r) => shell.on("exit", r));
    const stdout = Buffer.concat(chunks).toString("utf-8");

    // ── THE VACUITY GUARD, asserted BEFORE the parse ────────────────────
    // A sub-64KiB fixture passes in BOTH worlds and stays green forever,
    // including on the day it breaks: truncating 40KB at 65,536 is a no-op.
    const bytes = Buffer.byteLength(stdout);
    expect({ overBuffer: bytes > 65_536, bytes }).toEqual({ overBuffer: true, bytes });
    // Never truncated AT the boundary — the signature of the defect.
    expect(bytes).not.toBe(65_536);

    const data = JSON.parse(stdout) as { messages: unknown[] };
    expect(data.messages.length).toBe(60);
  }, 120000);
});

// ── The declared surface (acc standard working session, standard-grapevine) ──
//
// grapevine emits its own interface description (`schema`, acc declaration
// format v0), GENERATED from the same COMMANDS registry the parser and
// dispatcher walk. These tests hold the surface to the three-part ask: the
// emission runs and parses; it is generated (so registry facts appear in it by
// construction); and the running tool matches it (per-verb rejection
// enumerates, arity is enforced from the declared shape, the root routes flags
// as flags).
describe("declared surface (schema / root routing / per-verb flags)", () => {
  test("bare invocation is a usage error: exit 2, stdout empty, commands enumerated on stderr", async () => {
    const { code, stdout, stderr } = await bunRun([]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("expected a command");
    expect(stderr).toContain("send");
    expect(stderr).toContain("grapevine help");
  });

  test("a root --flag is rejected AS A FLAG, enumerating the root's set — not as an unknown command", async () => {
    const { code, stdout, stderr } = await bunRun(["--nope"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("unknown command");
    expect(stderr).toContain("unknown flag at the root: --nope");
    expect(stderr).toContain("--help");
    expect(stderr).toContain("--version");
  });

  test("an unknown verb flag is rejected with THAT verb's own set — not the global registry", async () => {
    const { code, stderr } = await bunRun(["send", "chan", "--timeout", "5"]);
    expect(code).toBe(2);
    // ⛔ THE ENUMERATION IS `choices` NOW, NOT A PROSE MARKER (Phase 6 chapter
    // 2). It used to be a second stderr line reading `recognized flags: --a --b`
    // — spelled with the colon straight after the noun because that is the shape
    // a flag-set extractor matches — and the cell found it by splitting on
    // newlines. The envelope carries an ARRAY, which cannot be truncated by a
    // reader that stops at the first token which is not a `--long` flag, and the
    // verb names itself in `meta.command` and in the message.
    const e = errorOf(stderr);
    expect(e.kind).toBe("usage");
    // --timeout is a grapevine flag, so since the move onto the kit registry it
    // is refused as MISPLACED (`--timeout is not accepted by \`send\``), not
    // as node's `Unknown option`; the verb still names itself.
    expect(e.message).toContain("is not accepted by `send`");
    const enumeration = e.choices;
    expect(enumeration).toBeDefined();
    expect(enumeration).toContain("--in-reply-to");
    // --timeout belongs to wait; send's enumeration must not advertise it.
    expect(enumeration).not.toContain("--timeout");
  });

  test("identity flags are global by contract: accepted on a verb with no identity semantics", async () => {
    // SKILL.md instructs agents to pass --as/--from on EVERY verb; the parser
    // must not reject a caller for following the tool's own docs.
    const { code, stderr } = await bunRun(["list", "--as", "somebody"]);
    expect(code).toBe(0);
    expect(stderr).not.toContain("Unknown option");
  });

  test("missing required positional errors before the verb runs", async () => {
    const { code, stdout, stderr } = await bunRun(["read", "chan"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(errorOf(stderr).message).toContain("missing required <id>");
  });

  test("an excess positional is rejected, not silently swallowed", async () => {
    const { code, stderr } = await bunRun(["info", "extra"]);
    expect(code).toBe(2);
    // ⚠ THE QUOTES ARE WHY THIS ONE HAD TO CHANGE AND ITS SIBLINGS DID NOT. The
    // message still says `unexpected argument "extra"`; inside a JSON document
    // those quotes are escaped, so a `toContain` over the RAW stderr fails while
    // the contract is intact. Parse, then match the field.
    expect(errorOf(stderr).message).toContain('unexpected argument "extra"');
  });

  test("schema emits parseable acc declaration v0 on stdout at exit 0, and lists its own verb", async () => {
    const { code, stdout, stderr } = await bunRun(["schema"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const decl = JSON.parse(stdout) as {
      formatVersion: string;
      provenance: string;
      selfDescription: { args: string[] };
      commands: { path: string[]; args: { name: string; status: string }[] }[];
    };
    expect(decl.formatVersion).toBe("0");
    expect(decl.provenance).toBe("emitted");
    expect(decl.selfDescription.args).toEqual(["schema"]);
    // DT-6's headline: the declaration must list the door it came through.
    expect(decl.commands.some((c) => c.path[0] === "schema")).toBe(true);
    // The root is declared as path [] and carries the interceptors.
    const root = decl.commands.find((c) => c.path.length === 0);
    expect(root).toBeDefined();
    expect(root?.args.map((a) => a.name)).toEqual(["--help", "-h", "--version", "-V"]);
    // Per-verb sets: send declares its own flags plus the global identity pair,
    // and does not declare wait's.
    const send = decl.commands.find((c) => c.path[0] === "send");
    const sendFlags = send?.args.map((a) => a.name) ?? [];
    expect(sendFlags).toContain("--in-reply-to");
    expect(sendFlags).toContain("--as");
    expect(sendFlags).toContain("--from");
    expect(sendFlags).not.toContain("--timeout");
  });

  test("every declared command path is reachable in help — emission and help cannot drift on the verb list", async () => {
    const schema = await bunRun(["schema"]);
    const decl = JSON.parse(schema.stdout) as { commands: { path: string[] }[] };
    const help = await bunRun(["--help"]);
    expect(help.code).toBe(0);
    for (const c of decl.commands) {
      if (c.path.length === 0) continue;
      // Word-boundary match — a substring check lets short verbs ride inside
      // unrelated words ("up" in "Usage") and can never fail.
      expect(help.stdout).toMatch(new RegExp(`\\b${c.path[0]}\\b`));
    }
  });

  test("a declared numeric flag rejects a non-number as a usage error, not a crash", async () => {
    const { code, stdout, stderr } = await bunRun(["wait", "chan", "--timeout", "notanumber"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(errorOf(stderr).message).toContain("--timeout expects a non-negative number");
    expect(stderr).not.toContain("RangeError");
  });
});

// ---------------------------------------------------------------------------
// Channel lifecycle: only an act that declares intent may create a channel
// (2026-09-06). Before this, every read verb sent `POST /channels {name}` to
// "ensure loaded" and the read routes ran through `loadChannel`, which
// REGISTERS the name — so a read resurrected a closed channel into `list`,
// empty and file-less, with nothing the reader could observe.
// ---------------------------------------------------------------------------

describe("a read verb never creates a channel", () => {
  // Each row: the argv, and how the verb answers — from a ROUTE, or from the
  // log file. The file-readers cannot 404 on their own (`triage` and
  // `pull --status` scan the .jsonl, where absent reads as empty), so they are
  // here to prove the CLI closes that hole too.
  const readVerbs: [string, string[]][] = [
    ["pull", ["pull", "ghost-pull"]],
    ["read", ["read", "ghost-read", "1"]],
    ["wait", ["wait", "ghost-wait", "--timeout", "1"]],
    ["topic (no text — a read)", ["topic", "ghost-topic"]],
    ["triage", ["triage", "ghost-triage"]],
    ["pull --status (scans the log file)", ["pull", "ghost-status", "--status", "open"]],
  ];

  for (const [label, argv] of readVerbs) {
    test(`${label} refuses a missing channel, names the recovery, and leaves list unchanged`, async () => {
      const before = await listedChannels();
      const { code, stdout, stderr } = await bunRun(argv);
      // ⛔ 5, NOT 2, SINCE PHASE 6 CHAPTER 2. "The channel does not exist" is
      // `not_found` in the house taxonomy, and the daemon already said so with a
      // 404 — the CLI used to collapse it, a bad flag and a broken daemon into
      // one number, which left an agent nothing to route on.
      expect(code).toBe(5);
      expect(stdout).toBe("");
      const e = errorOf(stderr);
      expect(e.kind).toBe("not_found");
      expect(e.message).toContain(`no channel "${argv[1]}"`);
      // A refusal names the act that recovers from it — and the line it names
      // must be RUNNABLE, not a `grapevine …` command no PATH resolves. It is a
      // FIELD now rather than a clause appended to the message.
      expect(e.hint).toBe(`try: bun ${CLI} open ${argv[1]}`);
      // The upstream's own body rides along verbatim, so a caller can branch on
      // what the DAEMON said rather than on this CLI's prose about it.
      expect(e.server?.error).toBe(`no channel "${argv[1]}"`);
      // THE ACTUAL BUG: the name must not have come back.
      const after = await listedChannels();
      expect(after).not.toContain(argv[1]);
      expect(after).toEqual(before);
    });
  }

  test("the reported repro: a closed channel stays closed when an agent polls it", async () => {
    await bunRun(["open", "resurrect-me"]);
    await bunRun(["send", "resurrect-me", "before the close", "--as", "agent"]);
    expect(await listedChannels()).toContain("resurrect-me");
    expect((await bunRun(["close", "resurrect-me"])).code).toBe(0);

    const pull = await bunRun(["pull", "resurrect-me"]);
    expect(pull.code).toBe(5);
    expect(errorOf(pull.stderr).message).toContain('no channel "resurrect-me"');
    expect(await listedChannels()).not.toContain("resurrect-me");
  });

  test("the guard is in the DAEMON, not just the CLI: the routes themselves 404", async () => {
    const port = daemonPort();
    for (const route of ["messages", "wait?timeout=1", "topic"]) {
      const res = await fetch(`http://127.0.0.1:${port}/channels/ghost-route/${route}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; channel: string; hint: string };
      expect(body.error).toBe('no channel "ghost-route"');
      expect(body.channel).toBe("ghost-route");
      // The wire carries the VERB. The daemon cannot know how its client was
      // invoked, so composing the runnable line is the CLI's job.
      expect(body.hint).toBe("open ghost-route");
    }
    expect(await listedChannels()).not.toContain("ghost-route");
  });

  test("a read verb on a channel that DOES exist still works", async () => {
    await bunRun(["open", "still-here", "--topic", "unchanged"]);
    await bunRun(["send", "still-here", "hello", "--as", "agent"]);
    const pull = await bunRun(["pull", "still-here"]);
    expect(pull.code).toBe(0);
    expect((JSON.parse(pull.stdout) as { messages: unknown[] }).messages.length).toBe(2);
    const topic = await bunRun(["topic", "still-here"]);
    expect(topic.code).toBe(0);
    expect((JSON.parse(topic.stdout) as { topic: string }).topic).toBe("unchanged");
    expect((await bunRun(["triage", "still-here"])).code).toBe(0);
  });

  test("a topic WRITE may still create: it declares intent, unlike the read", async () => {
    expect((await bunRun(["topic", "born-by-topic", "created by a write"])).code).toBe(0);
    expect(await listedChannels()).toContain("born-by-topic");
    const back = await bunRun(["topic", "born-by-topic"]);
    expect((JSON.parse(back.stdout) as { topic: string }).topic).toBe("created by a write");
  });
});

describe("tail creates — and says so", () => {
  test("tailing a name that does not exist emits created:true with a hint naming the risk", async () => {
    const { proc, output } = spawnTail("mistyped-channel", ["--as", "watcher"]);
    await sleep(1200);
    proc.kill("SIGTERM");
    const grounding = JSON.parse(must(output().trim().split("\n")[0], "the first stdout line")) as {
      kind: string;
      channel: string;
      created?: boolean;
      hint?: string;
    };
    expect(grounding.kind).toBe("grounding");
    expect(grounding.channel).toBe("mistyped-channel");
    expect(grounding.created).toBe(true);
    expect(grounding.hint).toContain("this tail created mistyped-channel");
    // It still creates — that is the ruling. The fix is the signal, not a refusal.
    expect(await listedChannels()).toContain("mistyped-channel");
  });

  test("tailing an EXISTING channel does not claim to have created it", async () => {
    await bunRun(["open", "already-open", "--topic", "t"]);
    const { proc, output } = spawnTail("already-open");
    await sleep(1200);
    proc.kill("SIGTERM");
    const grounding = JSON.parse(must(output().trim().split("\n")[0], "the first stdout line")) as {
      created?: boolean;
    };
    expect(grounding.created).toBeUndefined();
  });
});
