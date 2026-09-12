// The tokenizer, over the REAL StringStream — the shape a vendored language
// would not have given us (markdownMode.ts says why it is hand-written).

import { describe, expect, test } from "bun:test";
import { StringStream } from "@codemirror/language";
import { type MdState, mdToken, TOKEN_TAGS } from "./markdownMode";

/** Every token a line produces, as [token, text] pairs, with state carried on. */
function tokens(line: string, state: MdState = { fence: null }): [string | null, string][] {
  const stream = new StringStream(line, 2, 2);
  const out: [string | null, string][] = [];
  let guard = 0;
  while (!stream.eol()) {
    if (++guard > 500) throw new Error("tokenizer did not advance");
    const start = stream.pos;
    const token = mdToken(stream, state);
    // ⛔ A tokenizer that returns without consuming hangs CodeMirror's
    // highlighter. Asserted on every step rather than hoped for.
    expect(stream.pos).toBeGreaterThan(start);
    out.push([token, line.slice(start, stream.pos)]);
  }
  return out;
}

const kinds = (line: string, state?: MdState) =>
  tokens(line, state)
    .map(([t]) => t)
    .filter((t) => t !== null);

describe("line shapes", () => {
  test("headings, at every level and with leading space", () => {
    expect(kinds("# Title")).toEqual(["heading"]);
    expect(kinds("###### Small")).toEqual(["heading"]);
    expect(kinds("   ## Indented")).toEqual(["heading"]);
    // Not a heading: no space after the hashes, or too many.
    expect(kinds("#NoSpace")).toEqual([]);
    expect(kinds("####### Seven")).toEqual([]);
  });
  test("quotes, bullets, ordered items and rules", () => {
    expect(kinds("> quoted")).toEqual(["quote"]);
    expect(kinds("- item")).toEqual(["bullet"]);
    expect(kinds("* item")).toEqual(["bullet"]);
    expect(kinds("3. item")).toEqual(["bullet"]);
    expect(kinds("---")).toEqual(["rule"]);
    // A bullet marks only the MARKER; the rest of the line is ordinary text
    // (so emphasis inside a list item still highlights).
    expect(tokens("- a **bold** word")[0]).toEqual(["bullet", "- "]);
    expect(kinds("- a **bold** word")).toEqual(["bullet", "strong"]);
  });
});

describe("inline shapes", () => {
  test("strong, emphasis, strikethrough, code", () => {
    expect(kinds("**bold**")).toEqual(["strong"]);
    expect(kinds("__bold__")).toEqual(["strong"]);
    expect(kinds("*em*")).toEqual(["emph"]);
    expect(kinds("~~gone~~")).toEqual(["strike"]);
    expect(kinds("`code`")).toEqual(["code"]);
  });
  test("links and bare urls", () => {
    expect(kinds("[text](https://x.dev)")).toEqual(["link"]);
    expect(kinds("![alt](pic.png)")).toEqual(["link"]);
    expect(kinds("see https://x.dev now")).toEqual(["url"]);
  });
  test("an unclosed marker is not a shape — it is text being typed", () => {
    expect(kinds("**unfinished")).toEqual([]);
    expect(kinds("a * b * c")).toEqual([]); // spaced asterisks are not emphasis
  });
});

describe("fenced blocks carry state across lines", () => {
  test("everything between fences is code, and the closing fence ends it", () => {
    const state: MdState = { fence: null };
    expect(kinds("```ts", state)).toEqual(["code"]);
    expect(state.fence).toBe("```");
    expect(kinds("# not a heading in here", state)).toEqual(["code"]);
    expect(kinds("```", state)).toEqual(["code"]);
    expect(state.fence).toBeNull();
    expect(kinds("# a heading again", state)).toEqual(["heading"]);
  });
  test("a tilde fence is not closed by a backtick fence", () => {
    const state: MdState = { fence: null };
    kinds("~~~", state);
    expect(state.fence).toBe("~~~");
    kinds("```", state);
    expect(state.fence).toBe("~~~");
  });
});

test("every token name the tokenizer can return has a tag", () => {
  const names = new Set<string>();
  for (const line of [
    "# h",
    "> q",
    "- b",
    "---",
    "**s**",
    "*e*",
    "~~x~~",
    "`c`",
    "[t](u)",
    "https://x.dev",
    "```",
  ])
    for (const k of kinds(line)) names.add(k as string);
  for (const n of names) expect(Object.keys(TOKEN_TAGS)).toContain(n);
});
