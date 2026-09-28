// bounty's own wiring of the tail handoff (`src/kit/wire/tailHandoff.ts`),
// driven through the shipped launcher against real boards in a temp
// BOUNTY_HOME / TMPDIR. The kit's cells stub a spell's rules; these are the
// rules bounty actually carries:
//
//   · D1 — a re-arm (`--session` or `--since`) at a closed board ends
//     `tail.closed` at once, and B1 — a FIRST arm whose board comes from
//     `$BOUNTY_SESSION_KEY` (every anthill seat) still waits for the board;
//   · `--once` sleeps until a board event and exits on it;
//   · a keyed board's come-back is `open --session-key K`, not a restore by id;
//   · #98 — every retry line names the id it looked for and where that id came
//     from; a NAMED target (`--session`, `--session-key`) that never resolves
//     exits `not_found` (5) after a grace, and a `--session` this host never
//     had is never called "closed" nor offered `open --restore`;
//   · one act, one answer — a closed board (its snapshot on disk) stops
//     `tail.closed` at once whether it is named by `--session` or
//     `--session-key`.
//
// The window is injected (`SPELLBOOK_TAIL_WINDOW_MS`), so no cell waits minutes,
// and so is the named-target grace (`BOUNTY_TAIL_GRACE_MS`, internal).
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
  let rawErr = "";
  const drain = async (s: ReadableStream<Uint8Array>, add: (t: string) => void) => {
    const reader = s.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      add(new TextDecoder().decode(value));
    }
  };
  const drained = Promise.all([
    drain(p.stdout as ReadableStream<Uint8Array>, (t) => {
      raw += t;
    }),
    drain(p.stderr as ReadableStream<Uint8Array>, (t) => {
      rawErr += t;
    }),
  ]);
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
  const stderr = () => rawErr;
  return { lines, stderr, exit };
}

async function openBoard(env: Record<string, string | undefined>, ...extra: string[]) {
  const r = await cli(env, "open", "--no-open", ...extra);
  expect(r.code).toBe(0);
  const hs = JSON.parse(r.out) as { session_id: string };
  opened.push({ id: hs.session_id, env });
  return hs.session_id;
}

// The printed command is the verb and its arguments only; the agent runs it with
// its own launcher (Cole's ruling, 2026-09-24). So a printed command is run
// here the way the skill says: `bun <this skill's launcher> <command>`.
const cmd = (...args: string[]) => args.join(" ");

describe("bounty's tail handoff", () => {
  test("B1: a keyed FIRST arm (an anthill seat's shape) waits for its board instead of closing", async () => {
    // The named-target grace is zeroed: a key from the ENVIRONMENT is not a
    // named target (#98), so the grace must not reach it.
    const env = { ...baseEnv, BOUNTY_SESSION_KEY: "seat-team", BOUNTY_TAIL_GRACE_MS: "0" };
    const t = spawnTail(env, ["--mine", "--as", "seat1"], 60_000);
    // No board is up. Before B1's fix this printed tail.closed at once.
    expect(await t.exit(1500)).toBe("hung");
    expect(t.lines()).toEqual([]);
    // #98 ask 1: the retry names the id, and the key and cwd it was derived from.
    expect(t.stderr()).toMatch(
      /# no session yet for k-seat-team-[0-9a-f]{8} \(derived from \$BOUNTY_SESSION_KEY 'seat-team' \+ cwd \S*proj\) — retrying…/,
    );
  }, 30_000);

  test("#98: an unpinned tail keeps waiting, and its retry names the pointer it read", async () => {
    const env = { ...baseEnv, BOUNTY_TAIL_GRACE_MS: "0" };
    const t = spawnTail(env, [], 60_000);
    expect(await t.exit(1500)).toBe("hung");
    expect(t.lines()).toEqual([]);
    expect(t.stderr()).toMatch(
      /# no session yet \(looked for the latest-board pointer \S*bounty-latest\.json\) — retrying…/,
    );
  }, 30_000);

  test("#98: a --session-key that never resolves exits not_found after the grace, naming what it looked for", async () => {
    const env = { ...baseEnv, BOUNTY_TAIL_GRACE_MS: "300" };
    const t = spawnTail(env, ["--session-key", "NOPE"], 60_000);
    // Before: `# no session yet, retrying…` forever, exit pending.
    expect(await t.exit(10_000)).toBe(5);
    expect(t.lines()).toEqual([]);
    const id = "k-nope-[0-9a-f]{8}";
    const from = String.raw`\(derived from --session-key 'NOPE' \+ cwd \S*proj\)`;
    const err = t.stderr();
    expect(err).toMatch(new RegExp(`# no session yet for ${id} ${from} — retrying…`));
    const envelope = JSON.parse(err.trim().split("\n").at(-1) ?? "") as {
      error: { kind: string; exit_code: number; message: string; hint: string };
    };
    expect(envelope.error.kind).toBe("not_found");
    expect(envelope.error.exit_code).toBe(5);
    expect(envelope.error.message).toMatch(new RegExp(`^no session ${id} found ${from}`));
    expect(envelope.error.hint).toContain("open --session-key NOPE --no-open");
  }, 30_000);

  test("#98: a --session that never existed is not_found, never tail.closed or open --restore", async () => {
    const env = { ...baseEnv, BOUNTY_TAIL_GRACE_MS: "300" };
    const t = spawnTail(env, ["--session", "k-nope-123"], 60_000);
    // Before: exit 0 at once with tail.closed and `open --restore k-nope-123`,
    // which spawns an unrelated fresh board.
    expect(await t.exit(10_000)).toBe(5);
    expect(t.lines()).toEqual([]);
    const err = t.stderr();
    expect(err).toContain("# no session yet for k-nope-123 (from --session) — retrying…");
    expect(err).not.toContain("closed");
    expect(err).not.toContain("--restore");
    const envelope = JSON.parse(err.trim().split("\n").at(-1) ?? "") as {
      error: { kind: string; message: string };
    };
    expect(envelope.error.kind).toBe("not_found");
    expect(envelope.error.message).toStartWith("no session k-nope-123 found (from --session)");
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

  // item/bounty-tail-closed-board-two-answers (one act, one answer). Before:
  // `--session <id>` on a closed board stopped `tail.closed` at once, while
  // `--session-key K` for the SAME board waited out the grace and exited 5.
  // The grace is set long here, so only a prompt stop can pass.
  test("a --session-key whose board has closed stops tail.closed at once, like --session", async () => {
    const env = { ...baseEnv, BOUNTY_TAIL_GRACE_MS: "60000" };
    const id = await openBoard(env, "--session-key", "closed-key");
    expect((await cli(env, "close", "--session", id)).code).toBe(0);
    await Bun.sleep(500);
    const byId = spawnTail(env, ["--session", id], 60_000);
    expect(await byId.exit(5000)).toBe(0);
    const byKey = spawnTail(env, ["--session-key", "closed-key"], 60_000);
    expect(await byKey.exit(5000)).toBe(0);
    expect(byKey.lines().map((l) => [l.type, l.command])).toEqual([
      ["tail.closed", cmd("open", "--session-key", "closed-key", "--no-open")],
    ]);
    expect(byId.lines().map((l) => l.type)).toEqual(["tail.closed"]);
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
