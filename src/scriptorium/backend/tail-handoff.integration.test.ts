// The tail's handoff (`src/kit/wire/tailHandoff.ts`) on a REAL scriptorium
// daemon, through the shipped launcher: `--once` exits on the first event, a
// `--since` re-arm prints no grounding and replays nothing, the window
// self-ends and names the right act, an event landing between one watch's exit
// and the next's arm is not lost, and a closed or killed daemon ends the wait
// naming how to come back.
//
// The window is injected through `SPELLBOOK_TAIL_WINDOW_MS`, so no cell waits
// minutes. Same rig as `daemon.integration.test.ts`: a temp SCRIPTORIUM_HOME
// and TMPDIR, every daemon this file starts it stops. Build first (T23).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  BACKEND_DIR,
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "scriptorium",
  "scripts",
  "cli.ts",
);

const root = mkdtempSync(join(tmpdir(), "scriptorium-handoff-"));
const env = {
  ...process.env,
  SCRIPTORIUM_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
};
mkdirSync(join(root, "tmp"), { recursive: true });
const doc = join(root, "a.md");
writeFileSync(doc, "# A\n");
/** Every session this file opens, so a failing cell cannot leak its daemon. */
const opened: string[] = [];
afterAll(async () => {
  for (const id of opened)
    if (existsSync(join(root, "tmp", `scriptorium-${id}.json`)))
      await cli("close", "--session", id);
  rmSync(root, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env, cwd: root });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

type Line = Record<string, unknown>;

/** A tail process: its stdout as parsed lines, and its exit. */
function spawnTail(args: string[], windowMs: number) {
  const p = Bun.spawn(["bun", CLI, "tail", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...env, SPELLBOOK_TAIL_WINDOW_MS: String(windowMs) },
  });
  let raw = "";
  const drained = (async () => {
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
    }
  })();
  const lines = () =>
    raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Line);
  /** Wait for the process to exit on its own, within `ms`; kill it if not. */
  const exit = async (ms: number): Promise<number | "hung"> => {
    const r = await Promise.race([p.exited, Bun.sleep(ms).then(() => "hung" as const)]);
    if (r === "hung") p.kill();
    await drained;
    return r;
  };
  return { p, lines, exit };
}

/** The human, played the way the surface does it: a `say` over the socket. */
async function humanSays(port: number, text: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => {
    ws.onopen = r;
  });
  ws.send(JSON.stringify({ type: "say", text, withSelection: false }));
  await Bun.sleep(150);
  ws.close();
}

/** Every message id on the log so far, via a bounded replay. */
async function lastId(id: string): Promise<number> {
  const t = spawnTail(["--session", id, "--since=-1"], 400);
  await t.exit(10_000);
  const handoff = t.lines().at(-1) as Line;
  return handoff.cursor as number;
}

const cmd = (...args: string[]) => ["bun", CLI, ...args].join(" ");

describe("the handoff on a live session", () => {
  let port = 0;
  let id = "";

  beforeAll(async () => {
    const r = await cli("open", "--no-open", doc);
    expect(r.code).toBe(0);
    const hs = JSON.parse(r.out) as { port: number; session_id: string };
    port = hs.port;
    id = hs.session_id;
    opened.push(id);
  }, 60_000);

  afterAll(async () => {
    if (existsSync(join(root, "tmp", `scriptorium-${id}.json`)))
      await cli("close", "--session", id);
  });

  test("--once sleeps until the first event, prints it, names Monitor, and EXITS", async () => {
    const since = await lastId(id);
    const t = spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await Bun.sleep(1000); // asleep, not exited
    expect(t.lines()).toEqual([]);
    await humanSays(port, "back from lunch");
    // ⛔ THE SILENT FAILURE: a one-shot that prints and does not exit never wakes
    // the agent. It must exit on its own, promptly, at 0.
    expect(await t.exit(5000)).toBe(0);
    const [event, woke] = t.lines();
    expect([event?.type, event?.id, event?.text]).toEqual([
      "message",
      since + 1,
      "back from lunch",
    ]);
    expect(woke).toEqual({
      type: "tail.woke",
      events: 1,
      cursor: since + 1,
      next: "monitor",
      command: cmd("tail", "--session", id, "--since", String(since + 1)),
      hint: "handle the event above, then arm Monitor (timeout_ms 1800000) with command",
    });
  }, 30_000);

  test("a --since re-arm prints no grounding, replays nothing, and a quiet window names --once", async () => {
    const since = await lastId(id);
    const t = spawnTail(["--session", id, "--since", String(since)], 800);
    expect(await t.exit(10_000)).toBe(0);
    expect(t.lines()).toEqual([
      {
        type: "tail.quiet",
        events: 0,
        cursor: since,
        next: "background",
        command: cmd("tail", "--session", id, "--since", String(since), "--once"),
        hint: "nothing on the log this window; run command as a background Bash task (run_in_background) — it exits on the next event",
      },
    ]);
  }, 30_000);

  test("a first arm (no --since) still grounds, and the grounding does not make the window active", async () => {
    // Replays the buffer, so this window counts those frames; what matters is
    // that the grounding line is present and is not one of them.
    const t = spawnTail(["--session", id], 600);
    await t.exit(10_000);
    const lines = t.lines();
    const logFrames = lines.filter((l) => typeof l.id === "number").length;
    expect(lines[0]).toEqual({ type: "grounding", session_id: id, port });
    expect(lines.at(-1)?.events).toBe(logFrames);
  }, 30_000);

  test("an active window self-ends and names the Monitor re-arm from its last id", async () => {
    const since = await lastId(id);
    const t = spawnTail(["--session", id, "--since", String(since)], 2500);
    await Bun.sleep(800);
    await humanSays(port, "one more thing");
    expect(await t.exit(10_000)).toBe(0);
    const lines = t.lines();
    expect(lines.map((l) => l.type)).toEqual(["message", "tail.window"]);
    expect(lines[1]).toEqual({
      type: "tail.window",
      events: 1,
      cursor: since + 1,
      next: "monitor",
      command: cmd("tail", "--session", id, "--since", String(since + 1)),
      hint: "the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) with command",
    });
  }, 30_000);

  test("an event between the one-shot's exit and the re-arm is delivered by the re-arm, once", async () => {
    const since = await lastId(id);
    const once = spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await Bun.sleep(800);
    await humanSays(port, "first");
    expect(await once.exit(5000)).toBe(0);
    const woke = once.lines().at(-1) as Line;
    // The gap: nobody is subscribed now.
    await humanSays(port, "in the gap");
    const rearm = spawnTail(["--session", id, "--since", String(woke.cursor)], 800);
    await rearm.exit(10_000);
    const texts = rearm
      .lines()
      .filter((l) => l.type === "message")
      .map((l) => l.text);
    expect(texts).toEqual(["in the gap"]);
  }, 30_000);
});

describe("the wait ends on a closed or a lost session, naming how to come back", () => {
  test("closed while a one-shot sleeps: the closed frame, then tail.closed → open --restore", async () => {
    const r = await cli("open", "--no-open", doc);
    const { session_id: id } = JSON.parse(r.out) as { session_id: string };
    opened.push(id);
    const since = await lastId(id);
    const t = spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await Bun.sleep(800);
    expect((await cli("close", "--session", id)).code).toBe(0);
    expect(await t.exit(5000)).toBe(0);
    const lines = t.lines();
    expect(lines.map((l) => l.type)).toEqual(["closed", "tail.closed"]);
    expect(lines[1]).toMatchObject({
      next: "stop",
      command: cmd("open", "--restore", id),
    });
  }, 30_000);

  test("a kill -9'd daemon: the one-shot wakes with tail.lost ON STDOUT instead of sleeping forever", async () => {
    const r = await cli("open", "--no-open", doc);
    const { session_id: id, port } = JSON.parse(r.out) as { session_id: string; port: number };
    opened.push(id);
    const since = await lastId(id);
    const t = spawnTail(["--session", id, "--since", String(since), "--once"], 0);
    await Bun.sleep(800);
    const pid = (
      await new Response(
        Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe" })
          .stdout,
      ).text()
    ).trim();
    expect(pid).toMatch(/^\d+$/);
    process.kill(Number(pid), "SIGKILL");
    expect(await t.exit(10_000)).toBe(0);
    expect(t.lines()).toEqual([
      {
        type: "tail.lost",
        events: 0,
        cursor: since,
        next: "stop",
        command: cmd("open", "--restore", id),
        hint: "lost the daemon (it crashed or was killed); nothing is listening. To come back, run command",
      },
    ]);
    // The killed daemon left its pointer behind; clear it so nothing reads it.
    rmSync(join(root, "tmp", `scriptorium-${id}.json`), { force: true });
  }, 30_000);
});
