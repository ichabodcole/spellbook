// bounty's own wiring of the tail handoff (`src/kit/wire/tailHandoff.ts`),
// driven through the shipped launcher against real boards in a temp
// BOUNTY_HOME / TMPDIR. The kit's cells stub a spell's rules; these are the
// rules bounty actually carries:
//
//   · D1 — a re-arm (`--session` or `--since`) at a closed board ends
//     `tail.closed` at once, and B1 — a FIRST arm whose board comes from
//     `$BOUNTY_SESSION_KEY` (every anthill seat) still waits for the board;
//   · `--once` sleeps until a board event and exits on it;
//   · a keyed board's come-back is `open --session-key K`, not a restore by id.
//
// The window is injected (`SPELLBOOK_TAIL_WINDOW_MS`), so no cell waits minutes.
// Build first.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "plugins",
  "spellbook",
  "skills",
  "bounty",
  "scripts",
  "cli.ts",
);
const root = mkdtempSync(join(tmpdir(), "bounty-handoff-"));
const cwd = join(root, "proj");
mkdirSync(join(root, "tmp"), { recursive: true });
mkdirSync(cwd, { recursive: true });
const baseEnv: Record<string, string | undefined> = {
  ...process.env,
  BOUNTY_HOME: join(root, "home"),
  TMPDIR: `${join(root, "tmp")}/`,
};
delete baseEnv.BOUNTY_SESSION_KEY;
delete baseEnv.BOUNTY_SESSION;

const opened: Array<{ id: string; env: Record<string, string | undefined> }> = [];
afterAll(async () => {
  for (const o of opened) await cli(o.env, "close", "--session", o.id);
  rmSync(root, { recursive: true, force: true });
});

async function cli(env: Record<string, string | undefined>, ...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env, cwd });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

function spawnTail(env: Record<string, string | undefined>, args: string[], windowMs: number) {
  const p = Bun.spawn(["bun", CLI, "tail", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd,
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
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const exit = async (ms: number): Promise<number | "hung"> => {
    const r = await Promise.race([p.exited, Bun.sleep(ms).then(() => "hung" as const)]);
    if (r === "hung") p.kill();
    await drained;
    return r;
  };
  return { lines, exit };
}

async function openBoard(env: Record<string, string | undefined>, ...extra: string[]) {
  const r = await cli(env, "open", "--no-open", ...extra);
  expect(r.code).toBe(0);
  const hs = JSON.parse(r.out) as { session_id: string };
  opened.push({ id: hs.session_id, env });
  return hs.session_id;
}

const cmd = (...args: string[]) => ["bun", CLI, ...args].join(" ");

describe("bounty's tail handoff", () => {
  test("B1: a keyed FIRST arm (an anthill seat's shape) waits for its board instead of closing", async () => {
    const env = { ...baseEnv, BOUNTY_SESSION_KEY: "seat-team" };
    const t = spawnTail(env, ["--mine", "--as", "seat1"], 60_000);
    // No board is up. Before B1's fix this printed tail.closed at once.
    expect(await t.exit(1500)).toBe("hung");
    expect(t.lines()).toEqual([]);
  }, 30_000);

  test("D1: a re-arm at a board that closed in the gap ends tail.closed at once", async () => {
    const id = await openBoard(baseEnv, "--title", "d1");
    expect((await cli(baseEnv, "close", "--session", id)).code).toBe(0);
    await Bun.sleep(500);
    const t = spawnTail(baseEnv, ["--session", id, "--since", "1"], 60_000);
    expect(await t.exit(5000)).toBe(0);
    expect(t.lines().map((l) => [l.type, l.command])).toEqual([
      ["tail.closed", cmd("open", "--restore", id, "--no-open")],
    ]);
  }, 30_000);

  test("--once sleeps until a board event, prints it, names Monitor and exits", async () => {
    const id = await openBoard(baseEnv, "--title", "once");
    const state = JSON.parse((await cli(baseEnv, "state", "--session", id)).out) as {
      cursor: number;
    };
    const t = spawnTail(baseEnv, ["--session", id, "--since", String(state.cursor), "--once"], 0);
    await Bun.sleep(800);
    expect(t.lines()).toEqual([]);
    expect((await cli(baseEnv, "add", "--session", id, "a task")).code).toBe(0);
    expect(await t.exit(5000)).toBe(0);
    const lines = t.lines();
    expect(lines.map((l) => l.type)).toEqual(["task.add", "tail.woke"]);
    expect(lines[1]?.command).toBe(
      cmd("tail", "--session", id, "--since", String(state.cursor + 1)),
    );
  }, 30_000);

  test("a keyed board comes back by its key: open --session-key K, not a stray restore", async () => {
    const env = { ...baseEnv, BOUNTY_SESSION_KEY: "keyed-back" };
    const id = await openBoard(env, "--session-key", "keyed-back");
    expect((await cli(env, "close", "--session", id)).code).toBe(0);
    await Bun.sleep(500);
    const t = spawnTail(env, ["--session", id, "--since", "1", "--once"], 0);
    expect(await t.exit(5000)).toBe(0);
    expect(t.lines().map((l) => [l.type, l.command])).toEqual([
      ["tail.closed", cmd("open", "--session-key", "keyed-back", "--no-open")],
    ]);
  }, 30_000);
});
