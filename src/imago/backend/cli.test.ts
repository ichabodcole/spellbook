// Unit tests for the cli's hand-rolled flag parser. The bug this guards: the
// EQUALS form (`--flag=value`) used to be mis-parsed — the whole `flag=value`
// became a boolean key and the value was silently dropped (it bit a real
// batch.add, losing --prompt/--tag/--summary). Both forms must work now.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseArgs,
  RECOGNIZED_FLAGS,
  VALID_CONTEXT_KINDS,
  VALID_CONTEXT_LINKS,
  VERB_ALIASES,
  VERBS,
} from "./cli";

test("space form: --key value", () => {
  const { pos, flags } = parseArgs(["--kind", "edit", "src1", "src2"]);
  expect(flags.kind).toBe("edit");
  expect(pos).toEqual(["src1", "src2"]);
});

test("equals form: --key=value (the regression)", () => {
  const { flags } = parseArgs(["--prompt=make it warmer", "--tag=hero"]);
  expect(flags.prompt).toBe("make it warmer");
  expect(flags.tag).toBe("hero");
});

// ⚠ This used `--text=a=b=c`, and imago's CLI NEVER READS `flags.text` — it was
// an arbitrary stand-in that only worked because the old parser accepted any
// flag name it was handed. So the test depended on exactly the permissiveness
// P0c removes, and it went red the moment the registry landed. Rewritten
// against a REAL flag; the property under test is unchanged, and `--options` is
// the honest choice because its values genuinely carry `k=v` pairs.
test("equals form splits on the FIRST = so the value can contain =", () => {
  const { flags } = parseArgs(["--options=a=b=c"]);
  expect(flags.options).toBe("a=b=c");
});

// And the flag that stand-in named is now REFUSED, which is the point of the
// lane: an unrecognised flag is a caller-facing error instead of a silent
// accept-and-ignore.
test("an unrecognised flag is refused, naming it", () => {
  expect(() => parseArgs(["--text=a=b=c"])).toThrow(/--text/);
});

test("empty equals value is the string '' (not a boolean)", () => {
  const { flags } = parseArgs(["--summary="]);
  expect(flags.summary).toBe("");
});

test("bare flag (no value, or followed by another flag) is boolean true", () => {
  const { flags } = parseArgs(["--no-open", "--kind", "generate"]);
  expect(flags["no-open"]).toBe(true);
  expect(flags.kind).toBe("generate");
});

test("mixed forms + positionals in one line", () => {
  const { pos, flags } = parseArgs([
    "--kind",
    "edit",
    "--prompt=harmonize the collage",
    "--edited-from=v-123",
    "https://x/0.png",
    "https://x/1.png",
  ]);
  expect(flags.kind).toBe("edit");
  expect(flags.prompt).toBe("harmonize the collage");
  expect(flags["edited-from"]).toBe("v-123");
  expect(pos).toEqual(["https://x/0.png", "https://x/1.png"]);
});

// context verb — builds the right context.add message shape via parseArgs
test("context verb: style with content, image, and link parses correctly", () => {
  const { pos, flags } = parseArgs([
    "style",
    "noir",
    "--content=high contrast b&w",
    "--image=/tmp/v-1.webp",
    "--link=active",
  ]);
  // pos[0] is the kind; pos[1..] join into the name
  expect(pos[0]).toBe("style");
  expect(pos.slice(1).join(" ")).toBe("noir");
  expect(flags.content).toBe("high contrast b&w");
  expect(flags.image).toBe("/tmp/v-1.webp");
  expect(flags.link).toBe("active");
});

test("context verb: prompt with quickPrompts link parses correctly", () => {
  const { pos, flags } = parseArgs([
    "prompt",
    "describe",
    "--content=Describe what you see in detail",
    "--link=quickPrompts",
  ]);
  expect(pos[0]).toBe("prompt");
  expect(pos.slice(1).join(" ")).toBe("describe");
  expect(flags.content).toBe("Describe what you see in detail");
  expect(flags.link).toBe("quickPrompts");
});

test("context verb: tags flag splits into array candidates", () => {
  const { flags } = parseArgs(["--tags=cinematic,moody,dark"]);
  // The CLI splits on commas; verify the raw flag value is correct pre-split
  expect(flags.tags).toBe("cinematic,moody,dark");
  // Simulate the CLI's split logic
  const tags = (flags.tags as string)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  expect(tags).toEqual(["cinematic", "moody", "dark"]);
});

// ── register A1 · the declaration is bound to the behaviour ──────────────────
//
// ⛔ `VERBS` IS WHAT `choices` ON AN UNKNOWN VERB IS BUILT FROM, and it is a
// DECLARATION while the `switch (verb)` is the BEHAVIOUR. Nothing in the type
// system ties them, so a verb added to one and not the other makes imago either
// advertise a verb it cannot run or run one it will not name — and `choices` is
// only worth emitting because a caller can trust it.
//
// magpie's cell, ported (`src/magpie/backend/cli.test.ts`, "VERB_SPEC is the
// dispatch switch"). The SOURCE is parsed rather than the module inspected,
// because a case label is not a value. Calibrated both directions.
test("VERBS is the dispatch switch — neither may grow a verb alone (A1)", () => {
  const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  const dispatch = src.slice(src.indexOf("switch (verb) {"));
  const cases = new Set(
    [...dispatch.matchAll(/^\s{4}case "(-{0,2}[a-z-]+)":/gm)].map((m) => m[1] as string),
  );
  expect([...cases].sort()).toEqual([...VERBS, ...VERB_ALIASES].sort());
});

// `RECOGNIZED_FLAGS` is derived from `CLI_OPTIONS`, so the only way it can lie
// is if the parser stops reading that object.
test("the parser reads CLI_OPTIONS, the same object choices is built from (A1)", () => {
  const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  expect(src).toContain("options: CLI_OPTIONS,");
  expect(RECOGNIZED_FLAGS.every((f) => f.startsWith("--"))).toBe(true);
});

// The two ENUMERATED types are now single arrays, checked and published. These
// cells are what stops a member being added to the check and not the set.
test("context's enumerated sets are the ones the checks read (A1)", () => {
  const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  expect(src).toContain("VALID_CONTEXT_KINDS.includes(");
  expect(src).toContain("VALID_CONTEXT_LINKS.includes(");
  expect([...VALID_CONTEXT_KINDS]).toEqual(["prompt", "style", "skill", "context"]);
  expect([...VALID_CONTEXT_LINKS]).toEqual(["active", "quickPrompts"]);
});
