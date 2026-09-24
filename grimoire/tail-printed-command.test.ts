// The handoff line's `command` names no launcher and no path, and the line
// carries `spell` (Cole's ruling, 2026-09-24; `src/kit/wire/tailHandoff.ts`).
//
// Each spell builds its own command, so each needs its own cell: the kit's
// cells cannot see a spell that puts a launcher back. Scriptorium, bounty and
// glamour pin theirs in their `tail-handoff.integration.test.ts`; grapevine's
// is in its own; astrolabe's and mind-mapper's are in their fake-daemon suites.
// This file covers magpie and imago, on real daemons in temp homes.
//
// The window is injected (`SPELLBOOK_TAIL_WINDOW_MS`). Build first.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILLS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "spellbook",
  "skills",
);
const root = mkdtempSync(join(tmpdir(), "tail-printed-command-"));
const env = {
  ...process.env,
  TMPDIR: `${root}/`,
  MAGPIE_HOME: join(root, "magpie"),
  IMAGO_HOME: join(root, "imago"),
};
const opened: Array<[string, string]> = [];
afterAll(async () => {
  for (const [spell, id] of opened) await run(spell, ["close", "--session", id]);
  rmSync(root, { recursive: true, force: true });
});

async function run(spell: string, args: string[], extra: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", join(SKILLS, spell, "scripts", "cli.ts"), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...env, ...extra },
    cwd: root,
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}

for (const spell of ["magpie", "imago"]) {
  test(`${spell}: the printed command is the verb and its arguments, with spell, and no launcher`, async () => {
    const opened_ = await run(spell, ["open", "--no-open", "--title", "printed"]);
    expect(opened_.code).toBe(0);
    const id = (JSON.parse(opened_.out) as { session_id: string }).session_id;
    opened.push([spell, id]);

    const t = await run(spell, ["tail", "--session", id, "--since", "0"], {
      SPELLBOOK_TAIL_WINDOW_MS: "800",
    });
    expect(t.code).toBe(0);
    const line = JSON.parse(t.out.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect([line.type, line.spell, line.command]).toEqual([
      "tail.window",
      spell,
      `tail --session ${id} --since 1`,
    ]);
  }, 60_000);
}
