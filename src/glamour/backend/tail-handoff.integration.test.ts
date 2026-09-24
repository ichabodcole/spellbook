// glamour's own wiring of the tail handoff (`src/kit/wire/tailHandoff.ts`),
// through the shipped launcher against a real daemon in a temp GLAMOUR_HOME /
// TMPDIR. The kit's cells stub a spell's rules; these are glamour's:
//
//   · D1 — a re-arm (`--session` or `--since`) at a session that closed in the
//     gap ends `tail.closed` at once instead of retrying forever;
//   · D3 — the tab's id-less `connected`/`disconnected` pings do not wake a
//     `--once`; the next log event does.
//
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
  "glamour",
  "scripts",
  "cli.ts",
);
const root = mkdtempSync(join(tmpdir(), "glamour-handoff-"));
mkdirSync(join(root, "tmp"), { recursive: true });
const env = { ...process.env, GLAMOUR_HOME: join(root, "home"), TMPDIR: `${join(root, "tmp")}/` };

const opened: string[] = [];
afterAll(async () => {
  for (const id of opened) await cli("close", "--session", id);
  rmSync(root, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env, cwd: root });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

function spawnTail(args: string[], windowMs: number) {
  const p = Bun.spawn(["bun", CLI, "tail", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: root,
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
  return { lines, exit, alive: () => p.exitCode === null };
}

async function openSession() {
  const r = await cli("open", "--no-open", "--title", "handoff");
  expect(r.code).toBe(0);
  const hs = JSON.parse(r.out) as { session_id: string; port: number };
  opened.push(hs.session_id);
  return hs;
}

async function socket(port: number, send?: unknown) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((r) => {
    ws.onopen = r;
  });
  if (send !== undefined) ws.send(JSON.stringify(send));
  await Bun.sleep(250);
  ws.close();
  await Bun.sleep(250);
}

const cmd = (...args: string[]) => ["bun", CLI, ...args].join(" ");

describe("glamour's tail handoff", () => {
  test("D1: a re-arm at a session that closed in the gap ends tail.closed at once", async () => {
    const { session_id: id } = await openSession();
    expect((await cli("close", "--session", id)).code).toBe(0);
    await Bun.sleep(500);
    const t = spawnTail(["--session", id, "--since", "1"], 60_000);
    expect(await t.exit(5000)).toBe(0);
    expect(t.lines().map((l) => [l.type, l.command])).toEqual([
      ["tail.closed", cmd("open", "--restore", id, "--no-open")],
    ]);
  }, 30_000);

  test("D3: a tab's connect/disconnect pings do not wake --once; a human message does", async () => {
    const { session_id: id, port } = await openSession();
    const t = spawnTail(["--session", id, "--since", "1", "--once"], 0);
    await Bun.sleep(800);
    await socket(port); // a tab opens and closes: `connected`, `disconnected`
    expect(t.alive()).toBe(true);
    await socket(port, { type: "message.send", text: "make it bluer" });
    expect(await t.exit(5000)).toBe(0);
    const woke = t.lines().at(-1);
    expect([woke?.type, woke?.events, woke?.cursor]).toEqual(["tail.woke", 1, 2]);
  }, 30_000);
});
