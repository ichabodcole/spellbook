// The anchoring engine (E45). The cells that matter are the ones where the
// document has CHANGED — an anchor that only works on unmodified text is an
// offset with extra steps.
import { describe, expect, test } from "bun:test";
import { anchorOf, findAnchor, quoteLabel } from "./anchors";

const DOC = `# Release notes

The daemon watches the folder and writes nothing.
Every change is announced on the wire.

## Open questions

- Does the merge preserve a trailing newline?
`;

/** An anchor on the first occurrence of `quote` in `text`. */
const on = (text: string, quote: string) => {
  const at = text.indexOf(quote);
  if (at === -1) throw new Error(`no ${JSON.stringify(quote)} in the fixture`);
  return anchorOf(text, at, at + quote.length);
};

describe("anchorOf", () => {
  test("remembers the quote and what surrounded it", () => {
    const a = on(DOC, "watches the folder");
    expect(a.quote).toBe("watches the folder");
    expect(DOC.slice(a.at, a.at + a.quote.length)).toBe(a.quote);
    expect(a.before.endsWith("The daemon ")).toBe(true);
    expect(a.after.startsWith(" and writes")).toBe(true);
  });

  test("clips context at the start of the document rather than running off it", () => {
    const a = anchorOf(DOC, 0, 1);
    expect(a.before).toBe("");
    expect(a.quote).toBe("#");
  });
});

describe("findAnchor", () => {
  test("finds an untouched quote, by context", () => {
    const a = on(DOC, "watches the folder");
    const f = findAnchor(DOC, a);
    expect(f.how).toBe("context");
    expect(DOC.slice(f.from as number, f.to as number)).toBe("watches the folder");
  });

  test("SURVIVES AN EDIT ELSEWHERE — the whole point", () => {
    // A typo fixed three lines above shifts every offset below it.
    const a = on(DOC, "announced on the wire");
    const edited = DOC.replace("# Release notes", "# Release notes, revised at length");
    const f = findAnchor(edited, a);
    expect(f.how).toBe("context");
    expect(edited.slice(f.from as number, f.to as number)).toBe("announced on the wire");
  });

  test("survives an edit to its own SURROUNDINGS, by falling back to the quote", () => {
    const a = on(DOC, "announced on the wire");
    const edited = DOC.replace("Every change is", "Every single change is now");
    const f = findAnchor(edited, a);
    expect(f.how).toBe("unique");
    expect(edited.slice(f.from as number, f.to as number)).toBe("announced on the wire");
  });

  test("tells IDENTICAL quotes apart by their context", () => {
    const twins = "alpha\n\nthe same line here\n\nbeta\n\nthe same line here\n\ngamma";
    const second = twins.lastIndexOf("the same line here");
    const a = anchorOf(twins, second, second + "the same line here".length);
    const f = findAnchor(twins, a);
    expect(f.how).toBe("context");
    expect(f.from).toBe(second);
  });

  test("when context is gone and the quote repeats, takes the NEAREST and says so", () => {
    const twins = "alpha\n\nrepeated\n\nbeta\n\nrepeated\n\ngamma";
    const second = twins.lastIndexOf("repeated");
    const a = anchorOf(twins, second, second + "repeated".length);
    // Both contexts rewritten, so only the bare quote survives — twice.
    const edited = twins.replace("alpha", "ALPHA!").replace("beta", "BETA!").replace("gamma", "G!");
    const f = findAnchor(edited, a);
    expect(f.how).toBe("nearest");
    expect(edited.slice(f.from as number, f.to as number)).toBe("repeated");
  });

  test("ORPHANS a note whose text is gone, rather than guessing", () => {
    const a = on(DOC, "watches the folder");
    const edited = DOC.replace("The daemon watches the folder and writes nothing.", "Gone.");
    const f = findAnchor(edited, a);
    expect(f.how).toBe("orphaned");
    expect(f.from).toBeNull();
  });

  test("an empty quote is orphaned, never matched at position 0", () => {
    // Matching "" would silently pin every such note to the top of the file.
    expect(findAnchor(DOC, { quote: "", before: "", after: "", at: 0 }).how).toBe("orphaned");
  });

  test("finds a quote that moved to a different part of the document", () => {
    const a = on(DOC, "Does the merge preserve a trailing newline?");
    const moved = `# Release notes\n\n- Does the merge preserve a trailing newline?\n\nthe rest\n`;
    const f = findAnchor(moved, a);
    expect(f.how).toBe("unique");
    expect(moved.slice(f.from as number, f.to as number)).toBe(
      "Does the merge preserve a trailing newline?",
    );
  });

  test("a quote at the very end of the document still anchors", () => {
    const text = "one two three";
    const a = anchorOf(text, 8, 13);
    expect(a.after).toBe("");
    const f = findAnchor(text, a);
    expect(f.how).toBe("context");
    expect(text.slice(f.from as number, f.to as number)).toBe("three");
  });
});

describe("quoteLabel", () => {
  test("collapses newlines so a multi-line quote fits one row", () => {
    expect(quoteLabel("one\n\n  two   three ")).toBe("one two three");
  });

  test("truncates a long quote without a trailing space before the ellipsis", () => {
    expect(quoteLabel("aaa bbb ccc ddd", 8)).toBe("aaa bbb…");
  });

  test("leaves a short quote exactly as it is", () => {
    expect(quoteLabel("short")).toBe("short");
  });
});
