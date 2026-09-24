// grapevine's own wiring of the tail handoff (`src/kit/wire/tailHandoff.ts`),
// through the shipped launcher against a real daemon in a temp GRAPEVINE_HOME.
// The kit's cells stub a spell's rules; these are grapevine's:
//
//   · a live-only tail seeds its bookmark from the `subscribed` marker's
//     `latest_id`, so its re-arm is `--since <latest>` and misses nothing sent
//     in the gap;
//   · the marker (and the grounding line it renders) is not a message, so a
//     window that saw only it is still "0 events";
//   · D4 — a human at a terminal (`--human`) has no window at all.
//
// Build first.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  "grapevine",
  "scripts",
  "cli.ts",
);
const home = mkdtempSync(join(tmpdir(), "grapevine-handoff-"));
const env = { ...process.env, GRAPEVINE_HOME: home };

afterAll(async () => {
  await cli("stop");
  rmSync(home, { recursive: true, force: true });
});

async function cli(...args: string[]) {
  const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe", env });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { code, out };
}

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
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const exit = async (ms: number): Promise<number | "hung"> => {
    const r = await Promise.race([p.exited, Bun.sleep(ms).then(() => "hung" as const)]);
    if (r === "hung") p.kill();
    await drained;
    return r;
  };
  return { lines, exit };
}

describe("grapevine's tail handoff", () => {
  test("a live-only tail's bookmark is the channel's latest id, and the marker is not an event", async () => {
    expect((await cli("open", "seeded")).code).toBe(0);
    for (const text of ["one", "two", "three"])
      expect((await cli("send", "seeded", "--as", "other", text)).code).toBe(0);
    const t = spawnTail(["seeded", "--as", "agentx"], 1500);
    expect(await t.exit(10_000)).toBe(0);
    const last = t.lines().at(-1);
    expect([last?.type, last?.events, last?.cursor, last?.command]).toEqual([
      "tail.window",
      0,
      3,
      "tail seeded --as agentx --since 3",
    ]);
  }, 30_000);

  test("D4: --human (a person at a terminal) never ends by itself", async () => {
    expect((await cli("open", "human")).code).toBe(0);
    const t = spawnTail(["human", "--human"], 300);
    expect(await t.exit(2000)).toBe("hung");
    expect(t.lines().filter((l) => String(l.type).startsWith("tail."))).toEqual([]);
  }, 30_000);
});
