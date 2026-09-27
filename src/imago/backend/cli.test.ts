// Unit tests for the cli's hand-rolled flag parser. The bug this guards: the
// EQUALS form (`--flag=value`) used to be mis-parsed — the whole `flag=value`
// became a boolean key and the value was silently dropped (it bit a real
// batch.add, losing --prompt/--tag/--summary). Both forms must work now.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseArgs as nodeParseArgs } from "node:util";
import {
  CLI_OPTIONS,
  cli,
  RECOGNIZED_FLAGS,
  VALID_CONTEXT_KINDS,
  VALID_CONTEXT_LINKS,
  VERBS,
} from "./cli";

/** The split the CLI's parser makes (the kit registry parses strict against
 *  imago's one options table), for exercising the flag forms directly. */
function parseArgs(args: string[]): { pos: string[]; flags: Record<string, string | boolean> } {
  const { values, positionals } = nodeParseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  return { pos: positionals, flags: values as Record<string, string | boolean> };
}

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
// The dispatcher, help, `choices` and `schema` are all the kit registry's walk
// of ONE table, so the old "VERBS is the dispatch switch" source-parse has
// nothing left to bind. What remains worth pinning: the roster is the table,
// `schema` declares every verb, and the CLI never grows a verb unnoticed.
test("VERBS is the registry's roster, and schema declares every verb (A1)", () => {
  expect([...VERBS].sort()).toEqual(
    [
      "analyze",
      "ask",
      "batch",
      "close",
      "context",
      "cost",
      "focus",
      "handoff",
      "help",
      "info",
      "open",
      "propose",
      "say",
      "schema",
      "select",
      "sessions",
      "state",
      "status",
      "tail",
      "version",
    ].sort(),
  );
  const declared = cli
    .declaration()
    .commands.map((c) => c.path.join(" "))
    .filter((p) => p !== "");
  expect(declared.sort()).toEqual([...VERBS].sort());
});

test("RECOGNIZED_FLAGS is the options table the registry parses against (A1)", () => {
  expect([...RECOGNIZED_FLAGS]).toEqual(Object.keys(CLI_OPTIONS).map((k) => `--${k}`));
});

// Per-verb sets: a verb accepts only its own flags. `--session` rides every
// verb that talks to a session, and none that does not.
test("each verb's accepted flags are its own row's (per-verb sets)", () => {
  expect(cli.flagsFor("sessions")).toEqual(["--human"]);
  expect(cli.flagsFor("open")).toEqual(["--no-open", "--restore", "--timeout", "--title"]);
  expect(cli.flagsFor("handoff")).toEqual(["--clear", "--session"]);
  expect(cli.flagsFor("say")).toEqual(["--session"]);
});

// ⚠ FLAG-DEPENDENT ARITY. The declaration can only mark handoff's <text>
// optional; the row's `check` refuses the two combinations it cannot express
// Both refusals throw before the row runs, so no session is ever looked up.
test("handoff: <text> is declared optional (the check carries the rest)", async () => {
  const row = cli.declaration().commands.find((c) => c.path.join(" ") === "handoff");
  expect(row?.positionals).toEqual([{ name: "text", required: false, variadic: true }]);
  await expect(cli.dispatch(["handoff"])).rejects.toMatchObject({ kind: "usage" });
  await expect(cli.dispatch(["handoff", "--clear", "hi"])).rejects.toMatchObject({
    kind: "usage",
  });
});

// The two ENUMERATED types are single arrays, checked and published. These
// cells are what stops a member being added to the check and not the set.
test("context's enumerated sets are the ones the checks read (A1)", () => {
  const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  expect(src).toContain("VALID_CONTEXT_KINDS.includes(");
  expect(src).toContain("VALID_CONTEXT_LINKS.includes(");
  expect([...VALID_CONTEXT_KINDS]).toEqual(["prompt", "style", "skill", "context"]);
  expect([...VALID_CONTEXT_LINKS]).toEqual(["active", "quickPrompts"]);
});
