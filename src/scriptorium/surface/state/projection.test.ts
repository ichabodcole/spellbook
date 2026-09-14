// E51: the rendered text of a document, and the round trip back to source.
import { describe, expect, test } from "bun:test";
import { alignRuns, lineAt, project, toPlain, toSource } from "./projection";

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
