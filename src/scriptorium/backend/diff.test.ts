// The diff engine (E36). The load-bearing cell is the ROUND TRIP: taking every
// hunk must turn the left text into the right one exactly. Everything the
// surface and the merge verb do is a subset of that, so if it holds, a partial
// merge can only be wrong about WHICH hunks, never about how one is applied.
import { describe, expect, test } from "bun:test";
import { applyHunks, diffText, refine, splitLines, unified, words } from "./diff";

/** Take every hunk — the identity a merge is a subset of. */
const takeAll = (before: string, after: string) => {
  const d = diffText(before, after);
  return applyHunks(
    before,
    d.hunks,
    d.hunks.map((h) => h.id),
  );
};

describe("splitLines", () => {
  test("round-trips a trailing newline as a final empty line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(splitLines("a\nb\n").join("\n")).toBe("a\nb\n");
  });

  test("the empty text is one empty line, not zero lines", () => {
    expect(splitLines("")).toEqual([""]);
  });
});

describe("diffText", () => {
  test("identical texts produce no hunks and say so", () => {
    const d = diffText("one\ntwo\n", "one\ntwo\n");
    expect(d.same).toBe(true);
    expect(d.hunks).toHaveLength(0);
    expect(d.lines.every((l) => l.op === "same")).toBe(true);
  });

  test("a pure insertion is an add hunk with an empty aFrom..aTo range", () => {
    const d = diffText("one\nthree", "one\ntwo\nthree");
    expect(d.hunks).toHaveLength(1);
    const [h] = d.hunks;
    expect(h?.aFrom).toBe(h?.aTo as number);
    expect(h?.add).toEqual(["two"]);
    expect(h?.del).toEqual([]);
  });

  test("a pure deletion is a del hunk with an empty bFrom..bTo range", () => {
    const d = diffText("one\ntwo\nthree", "one\nthree");
    expect(d.hunks).toHaveLength(1);
    const [h] = d.hunks;
    expect(h?.bFrom).toBe(h?.bTo as number);
    expect(h?.del).toEqual(["two"]);
    expect(h?.add).toEqual([]);
  });

  test("a replacement is ONE hunk carrying both sides", () => {
    const d = diffText("one\ntwo\nthree", "one\nTWO\nthree");
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]?.del).toEqual(["two"]);
    expect(d.hunks[0]?.add).toEqual(["TWO"]);
  });

  test("separate changes are separate hunks, numbered from 1", () => {
    const d = diffText("a\nb\nc\nd\ne", "a\nB\nc\nd\nE");
    expect(d.hunks.map((h) => h.id)).toEqual([1, 2]);
  });

  test("a moved paragraph reads as a delete and an add, not a move", () => {
    // Said in the module and asserted here: this is a LINE diff, and claiming
    // to detect moves is the wrong clever answer.
    const d = diffText("alpha\nbeta\ngamma", "beta\ngamma\nalpha");
    expect(d.same).toBe(false);
    expect(takeAll("alpha\nbeta\ngamma", "beta\ngamma\nalpha")).toBe("beta\ngamma\nalpha");
  });
});

describe("word refinement", () => {
  test("splits into words, whitespace and punctuation runs", () => {
    expect(words("a big, dog")).toEqual(["a", " ", "big", ",", " ", "dog"]);
  });

  test("marks only the words that differ", () => {
    const { del, add } = refine("the quick fox", "the slow fox");
    expect(del.filter((s) => s.changed).map((s) => s.text)).toEqual(["quick"]);
    expect(add.filter((s) => s.changed).map((s) => s.text)).toEqual(["slow"]);
  });

  test("spans reassemble into the original line on each side", () => {
    const { del, add } = refine("alpha beta gamma", "alpha delta gamma epsilon");
    expect(del.map((s) => s.text).join("")).toBe("alpha beta gamma");
    expect(add.map((s) => s.text).join("")).toBe("alpha delta gamma epsilon");
  });

  test("a paired hunk gets spans on both sides", () => {
    const d = diffText("the quick fox", "the slow fox");
    const del = d.lines.find((l) => l.op === "del");
    const add = d.lines.find((l) => l.op === "add");
    expect(del?.spans).toBeDefined();
    expect(add?.spans).toBeDefined();
  });

  test("an UNPAIRED hunk gets no spans rather than an arbitrary pairing", () => {
    // One line becoming three has no honest line-to-line correspondence.
    const d = diffText("one line", "first\nsecond\nthird");
    expect(d.lines.every((l) => l.spans === undefined)).toBe(true);
  });
});

describe("applyHunks", () => {
  test("taking every hunk reproduces the right side exactly", () => {
    const before = "alpha\nbeta\ngamma\ndelta\nepsilon\n";
    const after = "alpha\nBETA\ngamma\nnew line\ndelta\n";
    expect(takeAll(before, after)).toBe(after);
  });

  test("taking NO hunks leaves the left side untouched", () => {
    const before = "alpha\nbeta\n";
    const d = diffText(before, "alpha\nBETA\n");
    expect(applyHunks(before, d.hunks, [])).toBe(before);
  });

  test("a later hunk lands correctly when an earlier one changed the line count", () => {
    // ⛔ The back-to-front cell. Applied front to back, hunk 2 would land
    // shifted by the two lines hunk 1 inserted.
    const before = "a\nb\nc\nd";
    const after = "a\nX\nY\nZ\nb\nc\nD";
    const d = diffText(before, after);
    expect(d.hunks.length).toBeGreaterThan(1);
    expect(
      applyHunks(
        before,
        d.hunks,
        d.hunks.map((h) => h.id),
      ),
    ).toBe(after);
  });

  test("one hunk of several applies alone, leaving the rest as the left has them", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nc\nd\nE";
    const d = diffText(before, after);
    const ids = d.hunks.map((h) => h.id);
    expect(applyHunks(before, d.hunks, ids.slice(0, 1))).toBe("a\nB\nc\nd\ne");
    expect(applyHunks(before, d.hunks, ids.slice(-1))).toBe("a\nb\nc\nd\nE");
  });

  test("an unknown hunk id is ignored, not an error", () => {
    const before = "a\nb";
    const d = diffText(before, "a\nB");
    expect(applyHunks(before, d.hunks, [99])).toBe(before);
  });

  test("a trailing newline is neither added nor dropped by a merge", () => {
    const before = "a\nb\n";
    const after = "a\nB\n";
    expect(takeAll(before, after)).toBe(after);
    expect(takeAll("a\nb", "a\nB")).toBe("a\nB");
  });

  test("the round trip holds across many shapes", () => {
    const shapes: [string, string][] = [
      ["", "hello"],
      ["hello", ""],
      ["a\nb\nc", "c\nb\na"],
      ["# Title\n\nBody text.\n", "# Title\n\nBody text, revised.\n\n## New\n"],
      ["one\ntwo\nthree\nfour\nfive", "one\nthree\nfive"],
      ["x", "x\ny\nz"],
      ["\n\n\n", "\n"],
    ];
    for (const [before, after] of shapes) expect(takeAll(before, after)).toBe(after);
  });
});

describe("the coarse fallback", () => {
  test("says so rather than silently degrading", () => {
    // Past the edit cap the line diff gives up; the flag is what lets the
    // surface say "too many changes to walk" instead of showing one hunk and
    // calling it one change.
    const before = Array.from({ length: 2200 }, (_, i) => `left ${i}`).join("\n");
    const after = Array.from({ length: 2200 }, (_, i) => `right ${i}`).join("\n");
    const d = diffText(before, after);
    expect(d.coarse).toBe(true);
    expect(d.hunks).toHaveLength(1);
    expect(applyHunks(before, d.hunks, [1])).toBe(after);
  });

  test("a large but SHALLOW difference is still diffed properly", () => {
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const before = lines.join("\n");
    const after = [...lines.slice(0, 2000), "inserted", ...lines.slice(2000)].join("\n");
    const d = diffText(before, after);
    expect(d.coarse).toBe(false);
    expect(d.hunks).toHaveLength(1);
  });
});

describe("unified", () => {
  test("prints a header, a range and the changed lines", () => {
    const d = diffText("a\nb\nc\n", "a\nB\nc\n");
    const text = unified(d, { from: "v1", to: "v2" });
    expect(text).toContain("--- v1");
    expect(text).toContain("+++ v2");
    expect(text).toContain("@@");
    expect(text).toContain("-b");
    expect(text).toContain("+B");
  });

  test("identical texts print nothing at all", () => {
    expect(unified(diffText("same\n", "same\n"))).toBe("");
  });

  test("nearby hunks share one header rather than repeating context", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 5", "LINE 5").replace("line 7", "LINE 7");
    const text = unified(diffText(before, after));
    expect(text.match(/^@@/gm)).toHaveLength(1);
  });

  test("distant hunks get a header each", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 5", "LINE 5").replace("line 50", "LINE 50");
    const text = unified(diffText(before, after));
    expect(text.match(/^@@/gm)).toHaveLength(2);
  });
});
