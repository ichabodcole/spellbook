// PART OF THE GRAPEVINE CLI SUITE: cli.test.ts plus its cli.*.test.ts
// siblings, one file once (about 62 s alone). It was split, by describe block
// and its long "grapevine cli" block into three runs of tests, so a parallel
// run is not floored by one file; every test body is unchanged. The shared
// harness is fixtures/cliSuite.ts, evaluated once per file: each file has its
// own GRAPEVINE_HOME, its own daemon, and stops both after its last test.

import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  at,
  bunRun,
  CLI,
  HOME,
  must,
  sleep,
  spawnTail,
  stopSuiteProcesses,
  TRACKED_PROCS,
} from "./fixtures/cliSuite.ts";

afterAll(stopSuiteProcesses);

describe("grapevine cli", () => {
  test("tail emits truncation hint before text for long messages", async () => {
    await bunRun(["open", "test_trunc"]);
    const t = spawnTail("test_trunc", ["--as", "observer"]);
    await sleep(400);
    const longBody = "x".repeat(2500); // > the raised ~2000 default threshold
    await bunRun(["send", "test_trunc", "--from", "talker", longBody]);
    await sleep(400);
    const line = must(
      t
        .output()
        .split("\n")
        .filter(Boolean)
        .find((l) => l.includes('"text"')),
      "a stdout line carrying the message text",
    );
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
    const line = must(
      t
        .output()
        .split("\n")
        .filter(Boolean)
        .find((l) => l.includes('"text"')),
      "a stdout line carrying the message text",
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.truncation_hint).toBeUndefined();
    t.proc.kill("SIGTERM");
  });

  test("every message frame front-loads a `full` read pointer, surviving a clip (#67)", async () => {
    await bunRun(["open", "test_ref"]);
    const t = spawnTail("test_ref", ["--as", "observer"]);
    await sleep(400);
    // A SHORT message (below the hint threshold) — the gap #67 names: Monitor may
    // still clip it, and without a front-loaded pointer its trailing id is lost.
    await bunRun(["send", "test_ref", "--from", "talker", "short one"]);
    await sleep(400);
    const line = must(
      t
        .output()
        .split("\n")
        .filter(Boolean)
        .find((l) => l.includes('"text"')),
      "a stdout line carrying the message text",
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.truncation_hint).toBeUndefined(); // short → no "+N chars" alarm
    expect(payload.full).toBe(`read test_ref ${payload.id}`); // but recovery is still there
    // Front-loaded: `full` serializes BEFORE `text`, so a downstream clip of the
    // long body can't eat the recovery coordinates.
    expect(line.indexOf('"full"')).toBeLessThan(line.indexOf('"text"'));
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
    const line = at(
      Buffer.concat(buf).toString("utf-8").split("\n").filter(Boolean),
      0,
      "the tail's stdout lines",
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.truncation_hint).toBeDefined();
    expect(payload.truncation_hint).toContain("100 chars");
    proc.kill("SIGTERM");
  });

  test("tail --max caps the inline body and still emits the read-pointer hint", async () => {
    await bunRun(["open", "test_max"]);
    const t = spawnTail("test_max", ["--as", "observer", "--max", "200"]);
    await sleep(400);
    await bunRun(["send", "test_max", "--from", "talker", "m".repeat(2500)]);
    await sleep(400);
    const line = must(
      t
        .output()
        .split("\n")
        .filter(Boolean)
        .find((l) => l.includes('"text"')),
      "a stdout line carrying the message text",
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.text.length).toBe(200); // inline body capped to --max
    expect(payload.truncation_hint).toBeDefined();
    expect(payload.truncation_hint).toContain("2500 chars"); // hint reports the TRUE total
    expect(payload.truncation_hint).toContain(`read test_max ${payload.id}`);
    // F17 order: hint serializes before .text so a downstream clip can't bury it.
    expect(line.indexOf("truncation_hint")).toBeLessThan(line.indexOf('"text"'));
    t.proc.kill("SIGTERM");
  });

  test("tail --max above the message length leaves the body intact (no cap, no hint)", async () => {
    await bunRun(["open", "test_max_big"]);
    const t = spawnTail("test_max_big", ["--as", "observer", "--max", "100000"]);
    await sleep(400);
    await bunRun(["send", "test_max_big", "--from", "talker", "k".repeat(2500)]);
    await sleep(400);
    const line = must(
      t
        .output()
        .split("\n")
        .filter(Boolean)
        .find((l) => l.includes('"text"')),
      "a stdout line carrying the message text",
    );
    expect(line).toBeDefined();
    const payload = JSON.parse(line);
    expect(payload.text.length).toBe(2500); // full inline — consumer opted into a high cap
    expect(payload.truncation_hint).toBeUndefined();
    t.proc.kill("SIGTERM");
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
    expect(JSON.parse(at(lines, 0, "lines")).from).toBe("other");
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
});
