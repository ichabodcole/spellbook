// The rendered text of a document, and the round trip back to source.
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../lib/markdown.ts";
import {
  alignRuns,
  lineAt,
  project,
  runOffset,
  showsSelection,
  toPlain,
  toSource,
} from "./projection";

/**
 * The text nodes a browser would build from `renderMarkdown`'s output, in
 * document order — what `renderedRange.align` hands to `alignRuns`. Splitting
 * on tags and decoding micromark's five entities is enough, because every tag
 * in that output was minted by the renderer (lib/markdown.ts).
 *
 * ⚠ IT IS A SECOND, PARTIAL HTML READER, and it lives in a test for that
 * reason: it stands in for the browser, and anything it decides matters is
 * confirmed by driving the real DOM. Do not promote it to the surface.
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

/** A run placed with nothing of its own left over — the ordinary case. */
function at(offset: number): { at: number; lead: number } {
  return { at: offset, lead: 0 };
}

/**
 * An extract of a style guide: the shape that once broke alignment. A blockquote
 * followed by a list: micromark writes THREE newline text nodes between the quote's last
 * word and the list's first, the projection writes two, and the third was
 * searched for forwards and matched the soft line break inside the list item,
 * past "must never derive". Everything after that aligned late or not at all.
 */
const STYLE_EXTRACT = `### Carry the frame, not just the value.

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

  test("a range that is entirely markup has no rendered text: null, not zero", () => {
    const src = "```\n\n```\n\nBody.\n";
    const p = project(src);
    expect(toPlain(p, 0, 3)).toBeNull();
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
    expect(alignRuns(p.plain, runs)).toEqual([at(0), at(4), at(6)]);
  });

  test("a run the projection never wrote is null, not a guess", () => {
    const p = project("Hello.\n");
    expect(alignRuns(p.plain, ["Hello.", "alt words"])).toEqual([at(0), null]);
  });

  test("a repeated run takes the LATER occurrence, because the cursor advances", () => {
    const p = project("the gate and the gate\n");
    const runs = ["the gate", " and ", "the gate"];
    const got = alignRuns(p.plain, runs);
    expect(got[0]).toEqual(at(0));
    expect(got[2]).toEqual(at(p.plain.lastIndexOf("the gate")));
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
    const from = (starts[1] as { at: number }).at;
    const range = toSource(p, from, from + label.length);
    expect(src.slice(range.from, range.to)).toBe("Maren's Bakery");
  });
});

describe("alignRuns on a real document (house-style)", () => {
  const src = STYLE_EXTRACT;
  const p = project(src);
  const runs = domRuns(renderMarkdown(src));
  const starts = alignRuns(p.plain, runs);

  test("every run with text in it is placed, and the SOURCE under it is its text", () => {
    runs.forEach((run, i) => {
      const core = run.trim();
      if (core === "") return;
      const placed = starts[i];
      expect({ run: core, placed: placed !== null }).toEqual({ run: core, placed: true });
      // ⛔ ASKED OF THE SOURCE, NOT OF THE PLACEMENT. Reading `plain` back at
      // an offset `runOffset` just produced is true by construction — it
      // cannot fail, whatever the placement is. The round trip through
      // `toSource` can. A wrapped line's source carries the `> ` or the indent
      // the rendered text does not, so those line prefixes come off first.
      const flat = (t: string) =>
        t
          .split("\n")
          .map((line) => line.replace(/^[\t ]*>?[\t ]?/u, ""))
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim();
      const { from, to } = toSource(
        p,
        runOffset(placed as NonNullable<typeof placed>, run.length - run.trimStart().length),
        runOffset(placed as NonNullable<typeof placed>, run.trimEnd().length),
      );
      expect(flat(src.slice(from, to))).toContain(flat(core));
    });
  });

  test("placements never go backwards", () => {
    let prev = -1;
    for (const placed of starts) {
      if (placed === null) continue;
      expect(placed.at).toBeGreaterThanOrEqual(prev);
      prev = placed.at;
    }
  });

  test("a heading directly after a block is placed (it was skipped by a stray newline)", () => {
    const i = runs.indexOf("A response states the conditions it was produced under.");
    expect(starts[i]).toEqual(at(p.plain.indexOf("A response states")));
  });

  test("the rule-id comment is placed, though its text node carries the newlines around it", () => {
    const i = runs.findIndex((r) => r.includes("rule-id: carry-frame-just-value -->"));
    expect(i).toBeGreaterThan(-1);
    expect(starts[i]).not.toBeNull();
  });

  test("a selection past the blockquote reports the lines it is on", () => {
    // Double-click "derive" in the list item: the text node is the <strong>'s.
    const i = runs.indexOf("derive");
    const where = (starts[i] as { at: number }).at;
    const { from, to } = toSource(p, where, where + "derive".length);
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
    const src = STYLE_EXTRACT;
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

describe("a run whose leading space the projection does not carry", () => {
  // A GFM task list is the plain case: the checkbox is an <input>, so the
  // item's text node STARTS with the space after it, and the projection
  // (which reads the mdast text node) has no space there at all.
  const src = "- [ ] first task item\n- [ ] second task item\n";
  const p = project(src);
  const runs = domRuns(renderMarkdown(src));
  const starts = alignRuns(p.plain, runs);
  /** Where character `within` of run `i` is in the source — the whole trip. */
  const source = (i: number, within: number, length: number) => {
    const at = runOffset(starts[i] as NonNullable<(typeof starts)[number]>, within);
    const { from, to } = toSource(p, at, runOffset(starts[i] as never, within + length));
    return src.slice(from, to);
  };

  test("the FIRST run in the document is not clamped onto its own text", () => {
    // ⛔ The bug this is written against resolved every offset in this node one
    // character early — invisible to a test that re-derives the offset the same
    // way the code does, so this asks the SOURCE what is there.
    const i = runs.findIndex((r) => r.endsWith("first task item"));
    expect(source(i, 1, 5)).toBe("first");
    expect(source(i, 7, 4)).toBe("task");
  });

  test("a selection anchored at a run's very first character starts at its text", () => {
    const i = runs.findIndex((r) => r.endsWith("second task item"));
    // Character 0 is the space that only the DOM has: it must resolve to the
    // start of "second", not one character back into the previous item.
    expect(source(i, 0, 7)).toBe("second");
    expect(source(i, 1, 6)).toBe("second");
  });
});

describe("leading whitespace the projection DID write belongs to the run", () => {
  // The text node after a `<strong>` starts with the space before the next
  // word, and the projection wrote that space too — so it is part of this run
  // and the placement covers it. (The task-list cells above are the other
  // half: whitespace the projection never wrote, which is `lead`.)
  //
  // ⛔ THIS IS THE ONLY CELL THAT FAILS IF THE BACK-OFF IS REMOVED. Without
  // it every such run is placed one character late, its leading space treated
  // as `lead` — and a selection that starts at the space, which is what
  // dragging from the end of a bold word gives you, silently loses it.
  const src = "A **bold** and more text.\n";
  const p = project(src);
  const runs = domRuns(renderMarkdown(src));
  const starts = alignRuns(p.plain, runs);
  const i = runs.findIndex((r) => r.startsWith(" and"));

  test("the run is placed ON its space, not on the word after it", () => {
    const from = runOffset(starts[i] as NonNullable<(typeof starts)[number]>, 0);
    const to = runOffset(starts[i] as NonNullable<(typeof starts)[number]>, 4);
    expect(src.slice(toSource(p, from, to).from, toSource(p, from, to).to)).toBe(" and");
  });

  test("and nothing of it is left over", () => {
    expect(starts[i]).toEqual({ at: p.plain.indexOf(" and"), lead: 0 });
  });
});

describe("alignRuns — one bad run does not poison the rest", () => {
  test("a whitespace run with no whitespace at the cursor is null, and moves nothing", () => {
    // Three newlines in the DOM where the projection wrote two: the third must
    // not go looking for the next newline, which is a soft break in "b\nc".
    const plain = "a\n\nb\nc";
    expect(alignRuns(plain, ["a", "\n", "\n", "\n", "b\nc"])).toEqual([
      at(0),
      at(1),
      at(2),
      null,
      at(3),
    ]);
  });

  test("a run the projection never wrote does not jump to a later copy of itself", () => {
    // A footnote marker "1" is rendered text the projection does not carry; the
    // next "1" in the document is pages away. Taking it would strand every run
    // between here and there.
    const plain = "See the note. Then more text.\n\nChapter 1 begins.";
    const runs = ["See the note", "1", ". Then more text.", "\n", "Chapter 1 begins."];
    expect(alignRuns(plain, runs)).toEqual([at(0), null, at(12), at(29), at(31)]);
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

// kit-crlf-note-offsets: the page holds one character for each `\r\n` (HTML
// parsing makes it `\n`), so the projection must too, or a note after a line
// break inside a paragraph is painted nowhere (the runs no longer align).
describe("a CRLF file", () => {
  const LF =
    "title\n\nThe first has words.\nA third holds the target here.\n\n```\na\nb\n```\n\nEnd.\n";
  const CRLF = LF.replaceAll("\n", "\r\n");

  test("the plain text is the LF file's, and the page's runs align with it", () => {
    const p = project(CRLF);
    expect(p.plain).toBe(project(LF).plain);
    // What the browser holds: the renderer's HTML with each CRLF read as one `\n`.
    const runs = domRuns(renderMarkdown(CRLF).replaceAll("\r\n", "\n"));
    const placed = alignRuns(p.plain, runs);
    // Every run with words on it is placed, as in the LF file.
    expect(runs.filter((r, i) => r.trim() !== "" && placed[i] === null)).toEqual([]);
    expect(placed).toEqual(alignRuns(project(LF).plain, domRuns(renderMarkdown(LF))));
  });

  test("a passage after a soft line break maps to its own source, both ways", () => {
    const p = project(CRLF);
    const from = CRLF.indexOf("the target");
    const plain = toPlain(p, from, from + "the target".length);
    expect(plain && p.plain.slice(plain.from, plain.to)).toBe("the target");
    const back = plain && toSource(p, plain.from, plain.to);
    expect(back && CRLF.slice(back.from, back.to)).toBe("the target");
    const end = CRLF.indexOf("End.");
    const last = toPlain(p, end, end + 4);
    expect(last && p.plain.slice(last.from, last.to)).toBe("End.");
  });
});

// kit-lone-cr-line-endings: a file whose lines end in a lone `\r` (old Mac
// endings). The browser reads each lone `\r` as `\n` too, so the projection must,
// or no run with a break in it aligns: no note paints, the right-click finds no
// passage, and a selection borrows its neighbours and covers the whole body.
describe("a lone-CR file, and files mixing it with LF or CRLF", () => {
  const LF =
    "# Title\n\nFirst line alpha\nsecond line beta.\n\n- item one\n  wraps here\n- item two\n\n> quoted\n> more\n\n```\na\nb\n```\n\nEnd.\n";
  /**
   * Each break of `LF` written in turn as the endings given: the mixed files. A
   * `\n` straight after a lone `\r` would make one CRLF of two breaks, so a lone
   * `\r` is written there instead.
   */
  const withEndings = (endings: string[]) => {
    let i = 0;
    let prev = { at: -2, e: "" };
    return LF.replace(/\n/g, (_, at: number) => {
      let e = endings[i++ % endings.length] as string;
      if (e === "\n" && prev.at === at - 1 && prev.e === "\r") e = "\r";
      prev = { at, e };
      return e;
    });
  };
  const FILES: [string, string][] = [
    ["lone CR", withEndings(["\r"])],
    ["lone CR and LF", withEndings(["\r", "\n"])],
    ["lone CR and CRLF", withEndings(["\r", "\r\n"])],
    ["all three", withEndings(["\r", "\r\n", "\n"])],
  ];
  /** What the browser holds: HTML parsing reads `\r\n` and a lone `\r` as `\n`. */
  const pageRuns = (text: string) => domRuns(renderMarkdown(text).replace(/\r\n?/g, "\n"));

  for (const [name, text] of FILES) {
    test(`${name}: the plain text is the LF file's, and every run with words aligns`, () => {
      const p = project(text);
      expect(p.plain).toBe(project(LF).plain);
      const runs = pageRuns(text);
      const placed = alignRuns(p.plain, runs);
      expect(runs.filter((r, i) => r.trim() !== "" && placed[i] === null)).toEqual([]);
      expect(placed).toEqual(alignRuns(project(LF).plain, domRuns(renderMarkdown(LF))));
    });

    test(`${name}: each passage maps to its own source, both ways`, () => {
      const p = project(text);
      for (const want of ["alpha", "second line", "wraps here", "item two", "more", "End."]) {
        const from = text.indexOf(want);
        const plain = toPlain(p, from, from + want.length);
        expect(plain && p.plain.slice(plain.from, plain.to)).toBe(want);
        const back = plain && toSource(p, plain.from, plain.to);
        expect(back && text.slice(back.from, back.to)).toBe(want);
      }
    });

    test(`${name}: lines are counted as the raw editor counts them`, () => {
      // CodeMirror breaks at `\r\n`, a lone `\r` and `\n`: the LF file's lines.
      for (const want of ["alpha", "second line", "wraps here", "End."])
        expect(lineAt(text, text.indexOf(want))).toBe(lineAt(LF, LF.indexOf(want)));
    });
  }

  test("a lone CR is one character either side, so a prose run stays exact", () => {
    const p = project("one\rtwo\r");
    expect(p.plain).toBe("one\ntwo");
    expect(p.segments.every((s) => s.exact)).toBe(true);
  });
});

describe("lineAt with every line ending", () => {
  test("a lone CR breaks a line, and a CRLF is one break", () => {
    const t = "a\rb\r\nc\nd";
    expect([0, 2, 5, 7].map((i) => lineAt(t, i))).toEqual([1, 2, 3, 4]);
    // Between the `\r` and the `\n` of a CRLF is still the line it ends.
    expect(lineAt(t, 4)).toBe(2);
  });
});

// kit-lone-cr-line-endings: the daemon's check that a note's range holds what
// the human selected. "alpha" selected must never become a note over the body.
describe("showsSelection", () => {
  const T = "# Title\n\nSome **bold** words and `code here` too.\n\nOther alpha beta.\n";
  const range = (s: string) => {
    const from = T.indexOf(s);
    return [from, from + s.length] as const;
  };

  test("the source itself passes: a selection in the raw view", () => {
    const [f, t] = range("**bold** words");
    expect(showsSelection(T, f, t, "**bold** words")).toBe(true);
  });

  test("the rendered text passes: a selection in the rendered view", () => {
    const [f, t] = range("**bold** words");
    expect(showsSelection(T, f, t, "bold words")).toBe(true);
    // Across blocks, the page writes the gap its own way.
    const from = T.indexOf("too.");
    const to = T.indexOf("Other") + "Other".length;
    expect(showsSelection(T, from, to, "too.\n\nOther")).toBe(true);
    expect(showsSelection(T, from, to, "too. Other")).toBe(true);
  });

  test("a range wider than the selection is refused: the wide-note regression", () => {
    // What the lone-CR page did: "alpha" selected, the whole body stored.
    expect(showsSelection(T, 9, T.length, "alpha")).toBe(false);
    const [f, t] = range("Other alpha beta.");
    expect(showsSelection(T, f, t, "alpha")).toBe(false);
  });

  test("a range of the same size somewhere else is refused", () => {
    const [f, t] = range("beta.");
    expect(showsSelection(T, f, t, "alpha")).toBe(false);
  });

  test("inside a run the projection cannot cut, the rest of that run is allowed, and no more", () => {
    // An inline code span resolves to the whole span.
    const [f, t] = range("`code here`");
    expect(showsSelection(T, f, t, "de he")).toBe(true);
    expect(showsSelection(T, f, t, "alpha")).toBe(false);
    // From inside the span to a word after it: the span's rest, then exact text.
    const to = T.indexOf("too.") + 3;
    expect(showsSelection(T, f, to, "here too")).toBe(true);
    // ...but not past the word the selection ended on.
    expect(showsSelection(T, f, T.length, "here too")).toBe(false);
  });

  test("text the page draws and the projection never carries may sit inside what was seen", () => {
    const N = "A claim[^1] stands.\n\n[^1]: The source.\n";
    const from = N.indexOf("claim");
    const to = N.indexOf("stands") + "stands".length;
    // The page shows the footnote's number inside the selection.
    expect(showsSelection(N, from, to, "claim1 stands")).toBe(true);
  });

  test("a lone-CR file's selection passes on the right range and fails on the wide one", () => {
    const CR = T.replaceAll("\n", "\r");
    const from = CR.indexOf("alpha");
    expect(showsSelection(CR, from, from + 5, "alpha")).toBe(true);
    expect(showsSelection(CR, 9, CR.length, "alpha")).toBe(false);
  });

  test("nothing seen passes only over nothing but space", () => {
    expect(showsSelection(T, 7, 9, "")).toBe(true);
    const [f, t] = range("alpha");
    expect(showsSelection(T, f, t, "  ")).toBe(false);
  });

  // The verifier's mouse drags (fix round): a run the projection cannot cut AND
  // a footnote number the page draws, in one selection. Each range is the one
  // the page sent for it.
  test("an uncut run and the page's footnote number together pass", () => {
    const CODEFN = "# T\n\nCall `doThing()` then see note[^1] now.\n\n[^1]: Foot.\n";
    const code = CODEFN.indexOf("`doThing()`");
    const now = CODEFN.indexOf(" now") + 1;
    // "Thing" to after "now", and to before it.
    expect(showsSelection(CODEFN, code, now + 3, "Thing() then see note1 now")).toBe(true);
    expect(showsSelection(CODEFN, code, now, "Thing() then see note1 ")).toBe(true);
    const AMPFN = "# T\n\nTom &amp; Jerry met here[^1] and left.\n\n[^1]: Foot.\n";
    const para = AMPFN.indexOf("Tom");
    const and = AMPFN.indexOf(" and left") + 4;
    // "Jerry" to "and": the line holds an entity, so its run is stored whole.
    expect(showsSelection(AMPFN, para, and, "Jerry met here1 and")).toBe(true);
  });

  test("the page's own text may be cut at either end of what was seen", () => {
    const N = "Final words.\n\n[^1]: The first footnote.\n\nA claim[^1] stands.\n";
    const at = N.indexOf("Final");
    // A drag from a paragraph into the "Footnotes" heading the page draws.
    expect(showsSelection(N, at, at + "Final words.".length, "Final words.\nFootno")).toBe(true);
    const def = N.indexOf("The first");
    expect(showsSelection(N, def, def + 9, "tes\n\nThe first")).toBe(true);
    // A range over a space beside a footnote's number shows nothing but the page's own.
    const sp = N.indexOf("] ") + 1;
    expect(showsSelection(N, sp, sp + 1, "1 ")).toBe(true);
  });

  test("what was seen may not hold text the range does not, beyond the page's own", () => {
    const T1 = "Alpha beta gamma.\n\nThe zeta paragraph mentions a cat.\n";
    const a = T1.indexOf("a cat");
    // The letters of "a" are in "Alpha": a range elsewhere is not what was seen.
    expect(showsSelection(T1, a, a + 1, "Alpha")).toBe(false);
    const cat = T1.indexOf("cat");
    expect(showsSelection(T1, cat, cat + 3, "Alpha beta gamma. cat")).toBe(false);
  });

  test("an uncut run at an edge may add the rest of itself, not all of itself", () => {
    const E = "Start \\*esc\\* left words **bold** right \\*esc\\* end.\n";
    // Two runs nobody selected around "bold": the whole paragraph is refused.
    expect(showsSelection(E, 0, E.length - 1, "bold")).toBe(false);
    // Begun and ended inside them, it passes.
    expect(showsSelection(E, 0, E.length - 1, "words bold right")).toBe(true);
    // Begun on the space at the end of a run, that run may be wholly unselected.
    const C = "Some words `code` more.\n";
    const code = C.indexOf("`code`");
    expect(showsSelection(C, 0, code + 6, "Some words")).toBe(false);
    expect(showsSelection(C, 0, code + 6, "Some words co")).toBe(true);
    // An exact run adds nothing: " more" was not selected.
    const more = C.indexOf(" more") + 5;
    expect(showsSelection(C, code, more, "code")).toBe(false);
  });

  test("every kind of space and line break is set aside: tabs, a lone CR, a no-break space", () => {
    const CR = "# T\r\rfirst alpha\rsecond line\r";
    const at = CR.indexOf("alpha");
    expect(showsSelection(CR, at, at + 12, "alpha\nsecond")).toBe(true);
    const TB = "| a | b |\n| - | - |\n| a1 | b1 |\n";
    const a1 = TB.indexOf("a1");
    expect(showsSelection(TB, a1, TB.indexOf("b1") + 2, "a1\tb1")).toBe(true);
    const NB = "one two\n";
    expect(showsSelection(NB, 0, 7, "one two")).toBe(true);
  });

  test("an uncut run at the start may be wholly unselected only when what was seen starts on a space", () => {
    const C = "`code` more words.\n";
    const to = C.indexOf(" words");
    // Begun on the space after the span: the span is in the range, none of it seen.
    expect(showsSelection(C, 0, to, " more")).toBe(true);
    // Begun on "more" itself, the span is text nobody selected.
    expect(showsSelection(C, 0, to, "more")).toBe(false);
  });

  test("the page's own text alone does not pass for a range that shows something", () => {
    const N = "A `code` claim[^1].\n\n[^1]: Foot.\n";
    const code = N.indexOf("`code`");
    // Only the footnote's number was seen: the code span shows text, and none of it was.
    expect(showsSelection(N, code, code + 6, "1")).toBe(false);
  });

  test("a projection passed in is the one used: the page's own, never made again", () => {
    const A = "One **alpha** here.\n";
    const B = "One **betaa** here.\n";
    const at = A.indexOf("**alpha**");
    // The range's rendered text, read from B's projection, says "betaa".
    expect(showsSelection(A, at, at + 9, "betaa", project(B))).toBe(true);
    expect(showsSelection(A, at, at + 9, "alpha", project(B))).toBe(false);
    expect(showsSelection(A, at, at + 9, "alpha")).toBe(true);
  });

  test("repetitive text inside an uncut run is settled in bounded time", () => {
    // kit-lone-cr-line-endings, round 3: every start stayed alive in a fenced
    // block of dashes, and 20 KB took 3.4 s.
    const lines = Array.from({ length: 2000 }, () => "---------").join("\n");
    const F = `# T\n\n\`\`\`\n${lines}\n\`\`\`\n`;
    const from = F.indexOf("---");
    const to = F.lastIndexOf("---") + 3;
    const seen = lines.slice(0, 9000);
    const t0 = performance.now();
    expect(showsSelection(F, from, to, seen)).toBe(true);
    expect(showsSelection(F, from, to, `${seen}x`)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  // Round 4: the walk's fallback (`foundWhole`), forced with a budget of nothing.
  // It must refuse what the walk refuses: text beyond the edges' allowance, on
  // either side, and whole runs nobody selected between two uncut edges.
  test("forced, the fallback keeps the edges' allowance and refuses unselected runs between", () => {
    const forced = (t: string, from: number, to: number, seen: string) =>
      showsSelection(t, from, to, seen, undefined, 0);
    for (const n of [300, 3000]) {
      // Shape A: an uncut run of dashes, then exact text nobody selected.
      const A = `&amp; ${"-".repeat(n)} **bold** tail words here.\n`;
      const seen = "-".repeat(Math.floor(n * 0.7));
      expect(forced(A, 0, A.indexOf(" here."), seen)).toBe(false);
      expect(forced(A, 0, A.indexOf(" **bold**"), seen)).toBe(true);
      // The same, the unselected text before the run.
      const L = `Lead words here **bold** &amp; ${"=".repeat(n)}\n`;
      expect(forced(L, 0, L.length - 1, "=".repeat(Math.floor(n * 0.7)))).toBe(false);
      // Shape B: two uncut blocks and a paragraph nobody selected between them.
      const blk = `\`\`\`\n${"ab".repeat(n)}\n\`\`\`\n`;
      const B = `${blk}\nMiddle paragraph nobody selected at all.\n\n${blk}`;
      expect(forced(B, 0, B.length - 1, "ab".repeat(n))).toBe(false);
      // Two runs and nothing between: an uncut run, then exact text nobody
      // selected. The fallback must keep to the trailing edge's allowance...
      const T2 = `&amp; ${"-".repeat(n)} **tail**\n`;
      expect(forced(T2, 0, T2.length - 1, seen)).toBe(false);
      // ...and to the leading edge's: exact text, then an uncut run.
      const L2 = `**Lead** &amp; ${"=".repeat(n)}\n`;
      expect(forced(L2, 0, L2.length - 1, "=".repeat(Math.floor(n * 0.7)))).toBe(false);
      // Across both blocks, nothing between them unselected, it passes.
      const C = `${blk}\n${blk}`;
      expect(forced(C, 0, C.length - 1, `b${"ab".repeat(n - 1)}${"ab".repeat(n - 1)}a`)).toBe(true);
    }
  });

  test("ordinary text is answered by the walk, not the fallback", () => {
    // A real "1" and a footnote's "1" side by side: the walk tells them apart,
    // the fallback (all of the page's text taken out, or none) cannot.
    // Enough text for the walk to be past a small budget: an entity makes the
    // run uncut, so every start in it is open.
    const V = "Version 1 &amp; a little more is said here[^1].\n\n[^1]: Foot.\n";
    const to = V.indexOf("[^1]");
    const seen = "Version 1 & a little more is said here1";
    expect(showsSelection(V, 0, to, seen)).toBe(true);
    expect(showsSelection(V, 0, to, seen, undefined, 0)).toBe(false);
  });
});
