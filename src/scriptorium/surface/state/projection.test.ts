// E51: the rendered text of a document, and the round trip back to source.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";
import { alignRuns, lineAt, project, toPlain, toSource } from "./projection";

/**
 * The text nodes a browser would build from `renderMarkdown`'s output, in
 * document order — what `renderedRange.align` hands to `alignRuns`. Splitting
 * on tags and decoding micromark's five entities is enough, because every tag
 * in that output was minted by the renderer (state/markdown.ts).
 */
function domRuns(html: string): string[] {
  const decode = (s: string) =>
    s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, "&");
  return html
    .split(/<[^>]*>/)
    .map(decode)
    .filter((r) => r !== "");
}

/**
 * An extract of `grimoire/house-style.md` (2026-09-22) — the document Cole
 * reproduced the drift on. The blockquote followed by a list is the shape that
 * broke it: micromark writes THREE newline text nodes between the quote's last
 * word and the list's first, the projection writes two, and the third was
 * searched for forwards and matched the soft line break inside the list item,
 * past "must never derive". Everything after that aligned late or not at all.
 */
const HOUSE_STYLE_EXTRACT = `### Carry the frame, not just the value.

<!-- rule-id: carry-frame-just-value -->

Three rules with one family resemblance and **three different mechanisms**. The
family name is how you recognise a fourth one; it is **not** a derivation, and
none of these follows from the others.

> **⚠ Siblings, not a hierarchy.** A response can state its window perfectly and
> still never carry the fact, because a response only answers questions that
> were asked — and the missing fact is one nobody can ask for. _(The subsumption
> was claimed, tested, and refuted at sprint 04's ratify round, by constructing
> the case where one holds and the other fails.)_

- **Boundary check:** the theme **organises** and must never **derive**. Before
  claiming one clause subsumes another, construct the case where the first holds
  and the second fails — a subsumption dies to a single counterexample, so
  attempting the counterexample _is_ the test. If you cannot build one, you have
  found a genuine overlap; if you can, they are siblings and stay separate.
- **Repeal when:** a mechanism is found that genuinely generates all three, at
  which point this becomes one rule with three corollaries rather than three
  rules under a heading. **Nobody has found one; two attempts were refuted the
  day the family was written.**

#### A response states the conditions it was produced under.

<!-- rule-id: carry-frame-just-value.response-states-conditions-was -->

An answer that cannot say what question it answered can be misread as the answer
to a different question. The theme organises; it does not derive.
`;

describe("project", () => {
  test("markup leaves the text, and the text keeps its source", () => {
    const src = "Hello **bold** world.\n";
    const p = project(src);
    expect(p.plain).toBe("Hello bold world.");
    // Every segment points at source that renders to exactly what it holds.
    for (const seg of p.segments) {
      if (!seg.exact) continue;
      expect(src.slice(seg.srcFrom, seg.srcTo)).toBe(p.plain.slice(seg.plainFrom, seg.plainTo));
    }
  });

  test("a link's label survives and its target does not", () => {
    const p = project("See [the bakery](Maren's%20Bakery.md) today.\n");
    expect(p.plain).toBe("See the bakery today.");
  });

  test("THE HOLLOWBROOK ROW — bold inside a link, which no source search finds", () => {
    const src = "- → [**Maren's Bakery**](Maren's%20Bakery.md) (Locations) — her place.\n";
    const p = project(src);
    expect(p.plain).toBe("→ Maren's Bakery (Locations) — her place.");
    // The motivating fact: what the human selects is absent from the source.
    expect(src.includes("Maren's Bakery (Locations)")).toBe(false);
    // …and the projection maps it back anyway.
    const at = p.plain.indexOf("Maren's Bakery");
    const { from, to } = toSource(p, at, at + "Maren's Bakery".length);
    expect(src.slice(from, to)).toBe("Maren's Bakery");
  });

  test("blocks are separated, so the last word of one is not glued to the next", () => {
    const p = project("One.\n\nTwo.\n");
    expect(p.plain).toBe("One.\n\nTwo.");
  });

  test("list items are separated by a single newline", () => {
    const p = project("- a\n- b\n");
    expect(p.plain).toBe("a\nb");
  });

  test("frontmatter is not in the rendered text, and offsets still land", () => {
    const src = "---\ntype: place\n---\n\nThe **bakery**.\n";
    const p = project(src);
    expect(p.plain).toBe("The bakery.");
    const at = p.plain.indexOf("bakery");
    const { from, to } = toSource(p, at, at + "bakery".length);
    // Whole-file offsets: the slice is the word, not something 20 characters early.
    expect(src.slice(from, to)).toBe("bakery");
  });

  test("an inline code span is not exact, and resolves to the whole span", () => {
    const src = "Run `go` now.\n";
    const p = project(src);
    expect(p.plain).toBe("Run go now.");
    const at = p.plain.indexOf("go");
    const { from, to } = toSource(p, at, at + 2);
    // The backticks come with it — there is no character-for-character answer.
    expect(src.slice(from, to)).toBe("`go`");
  });

  test("an image contributes nothing — its alt text cannot be selected", () => {
    const p = project("Before ![alt words](p.png) after.\n");
    expect(p.plain).toBe("Before  after.");
  });

  test("raw HTML reaches the human as text, because micromark encodes it", () => {
    const p = project("A <script>x</script> b\n");
    expect(p.plain).toContain("<script>");
  });

  test("a heading and a table both project", () => {
    const p = project("# Title\n\n| a | b |\n| - | - |\n| c | d |\n");
    expect(p.plain.startsWith("Title")).toBe(true);
    for (const cell of ["a", "b", "c", "d"]) expect(p.plain).toContain(cell);
  });
});

describe("toSource", () => {
  test("an empty selection is a point, not a range", () => {
    const p = project("Some words here.\n");
    const { from, to } = toSource(p, 5, 5);
    expect(to).toBe(from);
  });

  test("out-of-range offsets clamp instead of throwing", () => {
    const p = project("Short.\n");
    expect(() => toSource(p, -10, 9999)).not.toThrow();
    const { from, to } = toSource(p, -10, 9999);
    expect(from).toBeLessThanOrEqual(to);
  });

  test("an empty document does not blow up", () => {
    const p = project("");
    expect(p.plain).toBe("");
    expect(toSource(p, 0, 0)).toEqual({ from: 0, to: 0 });
  });

  test("a selection spanning two blocks covers both in source", () => {
    const src = "First para.\n\nSecond para.\n";
    const p = project(src);
    const { from, to } = toSource(p, p.plain.indexOf("para."), p.plain.length);
    const slice = src.slice(from, to);
    expect(slice.startsWith("para.")).toBe(true);
    expect(slice.endsWith("para.")).toBe(true);
  });
});

describe("toPlain", () => {
  test("the reverse trip — source range to rendered range", () => {
    const src = "Hello **bold** world.\n";
    const p = project(src);
    const at = src.indexOf("bold");
    const back = toPlain(p, at, at + 4);
    expect(back).not.toBeNull();
    expect(p.plain.slice((back as { from: number }).from, (back as { to: number }).to)).toBe(
      "bold",
    );
  });

  test("a range that is entirely markup has no rendered text — null, not zero", () => {
    const src = "---\ntype: place\n---\n\nBody.\n";
    const p = project(src);
    // Inside the frontmatter block.
    expect(toPlain(p, 4, 14)).toBeNull();
  });

  test("round trip is stable for prose", () => {
    const src = "The quick brown fox jumps.\n\nAnd a second line of prose.\n";
    const p = project(src);
    const at = p.plain.indexOf("brown fox");
    const { from, to } = toSource(p, at, at + "brown fox".length);
    const back = toPlain(p, from, to);
    expect(back).toEqual({ from: at, to: at + "brown fox".length });
  });
});

describe("alignRuns", () => {
  test("runs are placed in order, and the inter-tag newline is skipped", () => {
    const p = project("One.\n\nTwo.\n");
    // What the DOM actually offers: micromark writes ONE newline between the
    // block tags; the projection wrote two.
    const runs = ["One.", "\n", "Two."];
    expect(alignRuns(p.plain, runs)).toEqual([0, 4, 6]);
  });

  test("a run the projection never wrote is null, not a guess", () => {
    const p = project("Hello.\n");
    expect(alignRuns(p.plain, ["Hello.", "alt words"])).toEqual([0, null]);
  });

  test("a repeated run takes the LATER occurrence, because the cursor advances", () => {
    const p = project("the gate and the gate\n");
    const runs = ["the gate", " and ", "the gate"];
    const got = alignRuns(p.plain, runs);
    expect(got[0]).toBe(0);
    expect(got[2]).toBe(p.plain.lastIndexOf("the gate"));
  });

  test("the Hollowbrook row: a DOM selection resolves to the right source", () => {
    const src = "- → [**Maren's Bakery**](Maren's%20Bakery.md) (Locations) — her place.\n";
    const p = project(src);
    // The rendered DOM of that row, as text nodes: the arrow, the bold label
    // inside the link, then the tail.
    const label = "Maren's Bakery";
    const runs = ["→ ", label, " (Locations) — her place."];
    const starts = alignRuns(p.plain, runs);
    // The human selects the whole label by double-clicking it.
    const from = starts[1] as number;
    const range = toSource(p, from, from + label.length);
    expect(src.slice(range.from, range.to)).toBe("Maren's Bakery");
  });
});

describe("alignRuns on a real document (house-style)", () => {
  const src = HOUSE_STYLE_EXTRACT;
  const p = project(src);
  const runs = domRuns(renderMarkdown(src));
  const starts = alignRuns(p.plain, runs);

  test("every run with text in it is placed, and placed where its text is", () => {
    runs.forEach((run, i) => {
      const core = run.trim();
      if (core === "") return;
      const at = starts[i];
      expect({ run: core, placed: at !== null }).toEqual({ run: core, placed: true });
      const s = (at as number) + (run.length - run.trimStart().length);
      expect(p.plain.slice(s, s + core.length)).toBe(core);
    });
  });

  test("placements never go backwards", () => {
    let prev = -1;
    for (const at of starts) {
      if (at === null) continue;
      expect(at).toBeGreaterThanOrEqual(prev);
      prev = at;
    }
  });

  test("a heading directly after a block is placed (it was skipped by a stray newline)", () => {
    const i = runs.indexOf("A response states the conditions it was produced under.");
    expect(starts[i]).toBe(p.plain.indexOf("A response states"));
  });

  test("the rule-id comment is placed, though its text node carries the newlines around it", () => {
    const i = runs.findIndex((r) => r.includes("rule-id: carry-frame-just-value -->"));
    expect(i).toBeGreaterThan(-1);
    expect(starts[i]).not.toBeNull();
  });

  test("a selection past the blockquote reports the lines it is on", () => {
    // Double-click "derive" in the list item: the text node is the <strong>'s.
    const i = runs.indexOf("derive");
    const at = starts[i] as number;
    const { from, to } = toSource(p, at, at + "derive".length);
    expect(src.slice(from, to)).toBe("derive");
    const line = src.split("\n").findIndex((l) => l.includes("must never **derive**")) + 1;
    expect(lineAt(src, from)).toBe(line);
    expect(lineAt(src, to)).toBe(line);
  });
});

describe("wrapped lines inside a list item or a quote", () => {
  // The source of a wrapped list item or quote carries markup on every line
  // (the indent, the "> ") that the rendered text does not, so the text node is
  // longer in source than on screen. Treated as one non-exact run, a word on
  // its third line reported every line of the paragraph.
  test("a word on a list item's continuation line reports that line only", () => {
    const src = HOUSE_STYLE_EXTRACT;
    const p = project(src);
    const word = "attempting the counterexample";
    const at = p.plain.indexOf(word);
    const { from, to } = toSource(p, at, at + word.length);
    expect(src.slice(from, to)).toBe(word);
    const line = src.split("\n").findIndex((l) => l.includes(word)) + 1;
    expect([lineAt(src, from), lineAt(src, to)]).toEqual([line, line]);
  });

  test("a word on a quote's continuation line reports that line only", () => {
    const src = "> First line of the quote\n> second line here\n> third line.\n";
    const p = project(src);
    const at = p.plain.indexOf("second line");
    const { from, to } = toSource(p, at, at + "second line".length);
    expect(src.slice(from, to)).toBe("second line");
    expect([lineAt(src, from), lineAt(src, to)]).toEqual([2, 2]);
  });

  test("a selection across the wrap covers the markup between, in source", () => {
    const src = "- one two\n  three four\n";
    const p = project(src);
    const at = p.plain.indexOf("two");
    const { from, to } = toSource(p, at, p.plain.indexOf("three") + "three".length);
    expect(src.slice(from, to)).toBe("two\n  three");
  });
});

describe("alignRuns — one bad run does not poison the rest", () => {
  test("a whitespace run with no whitespace at the cursor is null, and moves nothing", () => {
    // Three newlines in the DOM where the projection wrote two: the third must
    // not go looking for the next newline, which is a soft break in "b\nc".
    const plain = "a\n\nb\nc";
    expect(alignRuns(plain, ["a", "\n", "\n", "\n", "b\nc"])).toEqual([0, 1, 2, null, 3]);
  });

  test("a run the projection never wrote does not jump to a later copy of itself", () => {
    // A footnote marker "1" is rendered text the projection does not carry; the
    // next "1" in the document is pages away. Taking it would strand every run
    // between here and there.
    const plain = "See the note. Then more text.\n\nChapter 1 begins.";
    const runs = ["See the note", "1", ". Then more text.", "\n", "Chapter 1 begins."];
    expect(alignRuns(plain, runs)).toEqual([0, null, 12, 29, 31]);
  });
});

describe("lineAt", () => {
  test("counts from 1, and a newline starts the next line", () => {
    const t = "one\ntwo\nthree";
    expect(lineAt(t, 0)).toBe(1);
    expect(lineAt(t, 3)).toBe(1);
    expect(lineAt(t, 4)).toBe(2);
    expect(lineAt(t, t.length)).toBe(3);
  });

  test("clamps rather than throwing", () => {
    expect(lineAt("a", -5)).toBe(1);
    expect(lineAt("a\nb", 999)).toBe(2);
  });
});
