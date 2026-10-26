// A document's frontmatter: split from the body, read without validating, kept out
// of the rendered HTML, and skipped by the projection so every rendered offset still
// maps to the right place in the WHOLE text.

import { describe, expect, test } from "bun:test";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import { renderMarkdown } from "../lib/markdown.ts";
import { defaultChips } from "./FrontmatterHeader.tsx";
import {
  frontmatterKeyAt,
  generatedAt,
  listField,
  readFrontmatter,
  showValue,
  trustTier,
} from "./frontmatter.ts";
import { insertAt } from "./pane.ts";
import { sourceLine } from "./place.ts";
import { lineAt, project, toPlain, toSource } from "./projection.ts";
import { renderDocument } from "./rendered.ts";

const FM = [
  "---",
  "type: feature",
  "title: The atlas",
  "description: Where worlds are made.",
  "status: draft",
  "lifecycle: ready",
  "tags: [kit, atlas]",
  "generated: { by: an agent, at: 2026-10-01 }",
  "id: 1234",
  "---",
  "",
].join("\n");
const BODY = "# The atlas\n\nMaren's **bakery** opens at dawn.\n\n- one\n- two [PAUSE:2s] three\n";
const DOC = FM + BODY;

describe("splitFrontmatter", () => {
  test("the block and the body, and where the body begins", () => {
    const s = splitFrontmatter(DOC);
    expect(s.body).toBe(BODY);
    expect(s.bodyStart).toBe(FM.length);
    expect(s.raw).toContain("type: feature");
    expect(s.raw?.startsWith("---")).toBe(false);
  });

  test("no block: the whole text is the body", () => {
    expect(splitFrontmatter(BODY)).toEqual({ raw: null, body: BODY, bodyStart: 0 });
  });

  test("an opening --- that never closes is markdown, not frontmatter", () => {
    const t = "---\ntype: x\n\nNo closing line.\n";
    expect(splitFrontmatter(t).raw).toBeNull();
  });

  test("prose between two rules is not a block: its first line is not a key", () => {
    const t = "---\nOnce upon a time.\n---\n\nThe tale.";
    expect(splitFrontmatter(t).raw).toBeNull();
    expect(readFrontmatter(t)).toBeNull();
    expect(renderDocument(t)).toBe(renderMarkdown(t));
    expect(project(t).plain).toContain("Once upon a time.");
  });

  test("trailing spaces on either delimiter still make a block", () => {
    const t = "---   \ntitle: A\n---  \nBody\n";
    expect(splitFrontmatter(t)).toEqual({ raw: "title: A", body: "Body\n", bodyStart: 22 });
    expect(renderDocument(t)).toBe(renderMarkdown("Body\n"));
  });

  test("the first non-empty line decides, so blank lines may come before the first key", () => {
    expect(splitFrontmatter("---\n\ntype: x\n---\nBody\n").raw).toBe("\ntype: x");
    expect(splitFrontmatter("---\n\n---\nBody\n").raw).toBeNull();
  });

  test("CRLF line ends, and a block at the very end of the text", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\nBody\r\n").body).toBe("Body\r\n");
    expect(splitFrontmatter("---\na: 1\n---").body).toBe("");
  });

  test("a first key written quoted is still a key: the block is frontmatter", () => {
    for (const q of ['"', "'"]) {
      const text = `---\n${q}status${q}: draft\ntitle: T\n---\n# T\n`;
      expect(splitFrontmatter(text).raw).toBe(`${q}status${q}: draft\ntitle: T`);
      expect(readFrontmatter(text)?.fields).toEqual({ status: "draft", title: "T" });
    }
    // A quote that does not close round a key is not one: prose stays prose.
    expect(splitFrontmatter('---\n"Hello: she said\n---\n').raw).toBeNull();
  });

  test("a byte-order mark before the block: still the block, and bodyStart counts the mark", () => {
    const text = "\uFEFF---\na: 1\n---\nBody\n";
    expect(splitFrontmatter(text)).toEqual({ raw: "a: 1", body: "Body\n", bodyStart: 14 });
    expect(readFrontmatter(text)?.fields).toEqual({ a: 1 });
  });
});

describe("readFrontmatter", () => {
  test("every key survives, and a date stays the string it was written as", () => {
    const fm = readFrontmatter(DOC);
    expect(fm?.error).toBeUndefined();
    expect(fm?.fields.type).toBe("feature");
    expect(fm?.fields.tags).toEqual(["kit", "atlas"]);
    expect(fm?.fields.generated).toEqual({ by: "an agent", at: "2026-10-01" });
    expect(fm?.fields.id).toBe(1234);
  });

  test("no block is null", () => {
    expect(readFrontmatter(BODY)).toBeNull();
  });

  test("a block that will not parse keeps its raw text and says why", () => {
    const raw = "type: [unclosed\nstatus: draft";
    const fm = readFrontmatter(`---\n${raw}\n---\nBody\n`);
    expect(fm?.raw).toBe(raw);
    expect(fm?.fields).toEqual({});
    expect(fm?.error).toBeTruthy();
    expect(fm?.error).not.toContain("\n");
  });

  test("a block that does not open with a key is not frontmatter at all", () => {
    expect(readFrontmatter("---\n- a\n- b\n---\nBody\n")).toBeNull();
    expect(readFrontmatter("---\njust words\n---\nBody\n")).toBeNull();
  });
});

describe("the small readers", () => {
  test("showValue writes any YAML value on one line", () => {
    expect(showValue({ by: "x", at: "2026-10-01" })).toBe("by: x · at: 2026-10-01");
    expect(showValue(["a", 2])).toBe("a, 2");
    expect(showValue(null)).toBe("—");
  });

  test("listField takes a list or a lone string", () => {
    expect(listField({ tags: ["a", 1, { x: 1 }] }, "tags")).toEqual(["a", "1"]);
    expect(listField({ tags: "solo" }, "tags")).toEqual(["solo"]);
    expect(listField({}, "tags")).toEqual([]);
  });

  test("trust is derived from verified, and a human verifier outranks a machine", () => {
    expect(trustTier({})).toBe("unverified");
    expect(trustTier({ verified: [{ by: "a checker" }] })).toBe("machine-confirmed");
    expect(trustTier({ verified: [{ by: "a checker" }, { by: "human:someone" }] })).toBe(
      "human-reviewed",
    );
  });

  test("generatedAt reads generated.at", () => {
    expect(generatedAt({ generated: { at: "2026-10-01" } })).toBe("2026-10-01");
    expect(generatedAt({ generated: "yesterday" })).toBeNull();
  });
});

describe("defaultChips", () => {
  test("type, status, lifecycle, trust and the date, in that order", () => {
    const chips = defaultChips({
      ...(readFrontmatter(DOC)?.fields ?? {}),
      verified: [{ by: "a checker" }],
    });
    expect(chips.map((c) => c.key)).toEqual([
      "type",
      "status",
      "lifecycle",
      "verified",
      "generated.at",
    ]);
    expect(chips.map((c) => (typeof c.label === "string" ? c.label : "·"))).toEqual([
      "feature",
      "draft",
      "ready",
      "·",
      "2026-10-01",
    ]);
  });

  test("status is coloured by its value", () => {
    const tone = (status: string) => defaultChips({ status }).find((c) => c.key === "status")?.tone;
    expect(tone("draft")).toBe("attention");
    expect(tone("stable")).toBe("stable");
    expect(tone("deprecated")).toBe("danger");
    expect(tone("something else")).toBe("dim");
  });

  test("an absent key has no chip, trust included: nothing says unverified by default", () => {
    expect(defaultChips({}).map((c) => c.key)).toEqual([]);
  });

  test("trust shows for any verified key, even an empty one, unless turned off", () => {
    expect(defaultChips({ verified: [] }).map((c) => c.key)).toEqual(["verified"]);
    expect(defaultChips({ verified: [] }, { trust: true }).map((c) => c.key)).toEqual(["verified"]);
    expect(defaultChips({ verified: [{ by: "human:x" }] }, { trust: false })).toEqual([]);
  });
});

describe("the rendered body", () => {
  test("the block is not in the HTML, and the body renders as it would alone", () => {
    expect(renderDocument(DOC)).toBe(renderMarkdown(BODY));
    expect(renderDocument(DOC)).not.toContain("type: feature");
  });

  test("a malformed block is still kept out of the body", () => {
    expect(renderDocument(`---\ntype: [oops\n---\n${BODY}`)).toBe(renderMarkdown(BODY));
  });

  test("a document without a block renders exactly as before", () => {
    expect(renderDocument(BODY)).toBe(renderMarkdown(BODY));
    const hr = "---\n\nA rule first, then text.\n";
    expect(renderDocument(hr)).toBe(renderMarkdown(hr));
  });
});

describe("the projection skips the block", () => {
  const p = project(DOC);
  const alone = project(BODY);

  test("nothing of the block is rendered text", () => {
    expect(p.plain).toBe(alone.plain);
    expect(p.plain).not.toContain("feature");
    expect(p.plain.startsWith("The atlas")).toBe(true);
  });

  test("every segment is the body's, moved by the block's length", () => {
    expect(p.segments).toEqual(
      alone.segments.map((s) => ({
        ...s,
        srcFrom: s.srcFrom + FM.length,
        srcTo: s.srcTo + FM.length,
      })),
    );
  });

  test("a rendered selection maps to the right whole-text offsets", () => {
    const at = p.plain.indexOf("bakery");
    const r = toSource(p, at, at + "bakery".length);
    expect(DOC.slice(r.from, r.to)).toBe("bakery");
    const across = toSource(p, p.plain.indexOf("opens"), p.plain.indexOf("two") + 3);
    expect(DOC.slice(across.from, across.to)).toBe("opens at dawn.\n\n- one\n- two");
  });

  test("a note's source range paints the same rendered text", () => {
    const from = DOC.indexOf("bakery");
    const r = toPlain(p, from, from + 6);
    expect(r && p.plain.slice(r.from, r.to)).toBe("bakery");
    // A range inside the block has no rendered text: null, never the document's start.
    expect(toPlain(p, DOC.indexOf("type"), DOC.indexOf("type") + 4)).toBeNull();
  });

  test("the round trip is stable", () => {
    const from = DOC.indexOf("Maren");
    const to = DOC.indexOf("dawn") + 4;
    const plain = toPlain(p, from, to);
    if (!plain) throw new Error("not placed");
    expect(toSource(p, plain.from, plain.to)).toEqual({ from, to });
  });

  test("a line reported for the rendered view is the file's line, not the body's", () => {
    const line = sourceLine(p, DOC, p.plain.indexOf("bakery"));
    expect(line).toBe(lineAt(DOC, DOC.indexOf("bakery")));
    expect(line).toBe(FM.split("\n").length + 2);
  });

  test("inserting after a rendered selection lands after it in the file", () => {
    const at = p.plain.indexOf("two");
    const sel = toSource(p, at, at + 3);
    const out = insertAt(DOC, sel.to, " [PAUSE:1s]");
    expect(out.startsWith(FM)).toBe(true);
    expect(out).toContain("- two [PAUSE:1s] [PAUSE:2s] three");
  });

  test("a block and nothing else projects to nothing", () => {
    expect(project(FM)).toEqual({ plain: "", segments: [], pageOnly: [] });
  });
});

// A reveal in the frontmatter (a broken `related:` reference opened from the link
// check) has no text to land on in the rendered view; the header marks the field.
describe("the key a frontmatter offset is in", () => {
  const LISTED =
    '---\ntitle: D\nrelated:\n  - ./a.md\n  - ./ghost.md\n"quoted key": 1\n---\n\nBody.\n';
  test("each key's whole entry, a list under it included, and a quoted key unquoted", () => {
    expect(frontmatterKeyAt(DOC, DOC.indexOf("feature"))).toBe("type");
    expect(frontmatterKeyAt(DOC, DOC.indexOf("2026-10-01"))).toBe("generated");
    expect(frontmatterKeyAt(LISTED, LISTED.indexOf("./ghost.md"))).toBe("related");
    expect(frontmatterKeyAt(LISTED, LISTED.indexOf("related"))).toBe("related");
    expect(frontmatterKeyAt(LISTED, LISTED.indexOf(": 1"))).toBe("quoted key");
  });

  test("a delimiter is no key's; the body and a document with no block are not the block's", () => {
    expect(frontmatterKeyAt(DOC, 0)).toBe("");
    expect(frontmatterKeyAt(DOC, FM.lastIndexOf("---"))).toBe("");
    expect(frontmatterKeyAt(DOC, DOC.indexOf("bakery"))).toBeNull();
    expect(frontmatterKeyAt(BODY, 3)).toBeNull();
  });

  test("CRLF lines count their carriage return", () => {
    const crlf = "---\r\ntitle: D\r\nrelated: [./ghost.md]\r\n---\r\n\r\nBody.\r\n";
    expect(frontmatterKeyAt(crlf, crlf.indexOf("./ghost.md"))).toBe("related");
    expect(frontmatterKeyAt(crlf, crlf.indexOf("D\r"))).toBe("title");
  });
});
