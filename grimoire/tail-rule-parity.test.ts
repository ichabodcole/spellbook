// The tail's shared rule ("Keep watching past Monitor's 30-minute cap") is
// word-for-word the same in every skill whose spell has a tail, and in
// mind-mapper's CLI help, which stands in for the skill it does not ship.
//
// It is copied, not included, because a SKILL.md cannot import. A copy that
// drifts tells one spell's agent something the others' are not told, which is
// the failure the rule exists to prevent: in the launcher-free ruling of
// 2026-09-24, HOW to run the printed command lives only in this text. So the
// copies are compared after normalising markdown (bold, backticks) and line
// wrapping. The presence sentence after the block is spell-specific and
// outside it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const START = "Keep watching past Monitor's 30-minute cap.";
const END = "fix the arguments to match.";

const normalise = (text: string) =>
  text.replaceAll("**", "").replaceAll("`", "").replace(/\s+/g, " ").trim();

function block(text: string, where: string): string {
  const flat = normalise(text);
  const i = flat.indexOf(START);
  const j = flat.indexOf(END, i);
  if (i === -1 || j === -1) throw new Error(`${where}: the shared tail rule is missing`);
  return flat.slice(i, j + END.length);
}

const SKILLS = ["scriptorium", "glamour", "imago", "magpie", "bounty", "astrolabe", "grapevine"];

test("the shared tail rule is identical in every tail's skill and in mind-mapper's help", () => {
  const texts = new Map<string, string>();
  for (const spell of SKILLS) {
    const path = join(REPO, "plugins", "spellbook", "skills", spell, "SKILL.md");
    texts.set(spell, block(readFileSync(path, "utf8"), spell));
  }
  const help = readFileSync(join(REPO, "src", "mind-mapper", "backend", "cli.ts"), "utf8");
  texts.set("mind-mapper (help)", block(help, "mind-mapper"));

  const reference = texts.get("scriptorium") ?? "";
  for (const [where, text] of texts) expect({ where, text }).toEqual({ where, text: reference });
  // And it names the launcher form, which is the ruling's whole point.
  expect(reference).toContain("bun <this skill's directory>/scripts/cli.ts <command>");
});
