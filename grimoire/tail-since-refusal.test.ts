// Every tail refuses a `--since` form it does not accept, the same way.
//
// The handoff line's command names no launcher (Cole's ruling, 2026-09-24;
// `src/kit/wire/tailHandoff.ts`), so an agent may run a line printed by one
// version, or one spell, against another's CLI. The worst case is meant to be an
// error that says what went wrong. Before this ward, four spells read an epoch
// bookmark (`4@e1`) as `4` with `parseInt` and dropped the rest silently, and
// two read junk as a whole replay. Each tail now answers through the kit's
// `readSince`: exit 2, stdout empty, one usage envelope naming the accepted
// forms.
//
// Driven through each spell's shipped launcher, with every home and TMPDIR in
// a temp dir. Nothing reaches a daemon: the refusal comes first. Build first.
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
const root = mkdtempSync(join(tmpdir(), "tail-since-refusal-"));
// If a refusal regresses, the tail goes on to spawn a singleton daemon under the
// temp home. Stop them so a red run leaves nothing behind.
afterAll(async () => {
  for (const [spell, verb] of [
    ["grapevine", "stop"],
    ["astrolabe", "close"],
  ] as const) {
    const p = Bun.spawn(["bun", join(SKILLS, spell, "scripts", "cli.ts"), verb], {
      stdout: "ignore",
      stderr: "ignore",
      env,
      cwd: root,
    });
    await p.exited;
  }
  rmSync(root, { recursive: true, force: true });
});
const env = {
  ...process.env,
  TMPDIR: `${root}/`,
  SCRIPTORIUM_HOME: join(root, "scriptorium"),
  GLAMOUR_HOME: join(root, "glamour"),
  IMAGO_HOME: join(root, "imago"),
  MAGPIE_HOME: join(root, "magpie"),
  BOUNTY_HOME: join(root, "bounty"),
  ASTROLABE_HOME: join(root, "astrolabe"),
  GRAPEVINE_HOME: join(root, "grapevine"),
  MIND_MAPPER_HOME: join(root, "mind-mapper"),
  BOUNTY_SESSION_KEY: "",
};

const ACCEPTS = "is not a bookmark this tail accepts";
const NO_EPOCH = `this spell's log stamps no epoch, so pass the id without the "@…" part`;

// [spell, argv after the launcher, what the refusal must also say]
const CASES: Array<[string, string[], string]> = [
  // The four no-epoch spells, handed an epoch bookmark another spell printed.
  ["glamour", ["tail", "--since", "4@e1"], NO_EPOCH],
  ["imago", ["tail", "--since", "4@e1"], NO_EPOCH],
  ["magpie", ["tail", "--since", "4@e1"], NO_EPOCH],
  ["bounty", ["tail", "--since", "4@e1"], NO_EPOCH],
  ["grapevine", ["tail", "somechannel", "--since", "4@e1"], NO_EPOCH],
  // The epoch spells, handed a form nobody prints.
  ["scriptorium", ["tail", "--since", "4@"], "or <id>@<epoch> as a handoff line prints it"],
  ["astrolabe", ["tail", "--since", "abc"], "or <id>@<epoch> as a handoff line prints it"],
  ["mind-mapper", ["tail", "--since", "abc"], "or <id>@<epoch> as a handoff line prints it"],
];

for (const [spell, argv, says] of CASES) {
  test(`${spell}: a --since form it does not accept is a usage error naming the accepted forms`, async () => {
    const p = Bun.spawn(["bun", join(SKILLS, spell, "scripts", "cli.ts"), ...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
      cwd: root,
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(code).toBe(2);
    expect(out).toBe("");
    const envelope = JSON.parse(err.trim().split("\n").at(-1) ?? "{}") as {
      error?: { kind?: string; message?: string };
    };
    expect(envelope.error?.kind).toBe("usage");
    expect(envelope.error?.message).toContain(ACCEPTS);
    expect(envelope.error?.message).toContain(says);
  }, 30_000);
}
