// The two matchers: fuzzy on names, exact in text.
import { describe, expect, test } from "bun:test";
import {
  type Candidate,
  fold,
  NAME_CAP,
  PER_DOC,
  scoreName,
  searchDocuments,
  searchText,
} from "./search";

describe("searchText: exact, with a line and a column you can open", () => {
  const doc = ["# The Bridge", "", "The baker on the bridge.", "", "Her starter is old."].join(
    "\n",
  );

  test("case-insensitive; line and column are 1-based", () => {
    const hits = searchText(doc, "BRIDGE", 10);
    expect(hits.map((h) => [h.line, h.column])).toEqual([
      [1, 7],
      [3, 18],
    ]);
  });

  test("the offsets point at the match in the document, not in the line", () => {
    const [hit] = searchText(doc, "baker", 10);
    expect(doc.slice(hit?.from, hit?.to)).toBe("baker");
  });

  test("two hits on one line are two hits", () => {
    const hits = searchText("the cat and the cat again", "cat", 10);
    expect(hits.map((h) => h.line)).toEqual([1, 1]);
    expect(hits[0]?.from).not.toBe(hits[1]?.from);
  });

  test("an empty query finds nothing rather than everything", () => {
    expect(searchText(doc, "", 10)).toEqual([]);
    expect(searchText(doc, "   ", 10)).toEqual([]);
  });

  test("the limit is respected", () => {
    const many = Array.from({ length: 30 }, () => "needle").join("\n");
    expect(searchText(many, "needle", 5)).toHaveLength(5);
    expect(searchText(many, "needle", 0)).toEqual([]);
  });

  test("a long line is capped with an ellipsis, and a CRLF line does not keep its CR", () => {
    const [long] = searchText(`${"x".repeat(400)}needle`, "needle", 1);
    expect(long?.snippet.startsWith("…")).toBe(true);
    expect(long?.snippet.endsWith("needle")).toBe(true);
    expect(long?.snippet.length).toBeLessThan(400);
    const [crlf] = searchText("one\r\ntwo needle\r\n", "needle", 1);
    expect(crlf?.snippet).toBe("two needle");
  });

  test("a match on the last line with no trailing newline still reports", () => {
    expect(searchText("one\ntwo\nthree", "three", 3)[0]?.line).toBe(3);
  });
});

describe("searchText: windowed snippets, literal matching, and odd case", () => {
  test("a match far along a long line is shown, with its offsets inside the snippet", () => {
    const line = `${"word ".repeat(100)}needle ${"tail ".repeat(100)}`;
    const [hit] = searchText(line, "needle", 1);
    expect(hit?.column).toBe(501);
    const s = hit?.snippet ?? "";
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThan(200);
    expect(s.slice(hit?.snippetFrom, hit?.snippetTo)).toBe("needle");
  });

  test("two hits on one long line differ in what they show", () => {
    const line = `needle ${"x".repeat(300)} needle`;
    const [a, b] = searchText(line, "needle", 5);
    expect(a?.snippet).not.toBe(b?.snippet);
    expect(a?.snippet.slice(a.snippetFrom, a.snippetTo)).toBe("needle");
    expect(b?.snippet.slice(b.snippetFrom, b.snippetTo)).toBe("needle");
    expect(a?.snippet.startsWith("…")).toBe(false);
  });

  test("a short line is whole, with the offsets of the match in the trimmed line", () => {
    const [hit] = searchText("   the lantern is lit  ", "LANTERN", 1);
    expect(hit?.snippet).toBe("the lantern is lit");
    expect(hit?.snippet.slice(hit.snippetFrom, hit.snippetTo)).toBe("lantern");
  });

  test("metacharacters are literal", () => {
    expect(searchText("a (b) [c] a.c a*c", "a.c", 5)).toHaveLength(1);
    expect(searchText("x (y) z", "(y)", 5)).toHaveLength(1);
  });

  test("a character whose lowercase changes length does not hide the document", () => {
    const text = "İstanbul has a lantern\nsecond lantern";
    expect(fold(text)).toHaveLength(text.length);
    const hits = searchText(text, "lantern", 5);
    expect(hits.map((h) => [h.line, text.slice(h.from, h.to)])).toEqual([
      [1, "lantern"],
      [2, "lantern"],
    ]);
    expect(searchText(text, "İstanbul", 5)).toHaveLength(1);
  });
});

describe("scoreName: the orderings are what is pinned", () => {
  const s = (name: string, q: string) => scoreName(name, q) ?? Number.NEGATIVE_INFINITY;

  test("a non-subsequence is null", () => {
    expect(scoreName("Maren", "xyz")).toBeNull();
    expect(scoreName("Maren", "  ")).toBeNull();
  });
  test("word initials match", () => {
    expect(scoreName("Marens Bakery", "mb")).not.toBeNull();
  });
  test("contiguous beats scattered; prefix beats a later substring", () => {
    expect(s("Maren", "mare")).toBeGreaterThan(s("m a r e", "mare"));
    expect(s("bridge keeper", "bridge")).toBeGreaterThan(s("the bridge", "bridge"));
  });
  test("a space in the query matches any boundary in the name", () => {
    for (const name of ["the-old-mill", "the_old_mill", "the.old.mill", "The Old Mill"])
      expect(scoreName(name, "the old mill"), name).not.toBeNull();
    expect(scoreName("the-old-mill", "the  old   mill")).not.toBeNull();
    expect(scoreName("theoldmill", "the old mill")).toBeNull();
    expect(s("the-old-mill", "the old mill")).toBeGreaterThan(
      s("the-old-watermill", "the old mill"),
    );
  });
  test("a shorter name wins a tie, and case does not matter", () => {
    expect(s("bridge", "bridge")).toBeGreaterThan(s("bridge and more words", "bridge"));
    expect(s("BRIDGE", "bridge")).toBe(s("bridge", "BRIDGE"));
  });
});

describe("searchDocuments", () => {
  const cand = (name: string, over: Partial<Candidate> = {}): Candidate => ({
    path: `/w/${name}`,
    name,
    slug: null,
    version: null,
    ...over,
  });
  const texts: Record<string, string> = {
    "/w/bridge.md": "the bridge\nand the bridge again",
    "/w/other.md": "nothing but a bridge here",
    "/w/maren.md": "no match",
  };
  const read = (c: Candidate) => texts[c.path] ?? null;
  const all = [cand("maren.md"), cand("bridge.md"), cand("other.md")];

  test("names come first, then text matches in document order", () => {
    const r = searchDocuments(all, "bridge", read);
    expect(r.results.map((x) => [x.kind, x.name, x.line])).toEqual([
      ["name", "bridge.md", undefined],
      ["text", "bridge.md", 1],
      ["text", "bridge.md", 2],
      ["text", "other.md", 1],
    ]);
    expect(r.count).toBe(4);
    expect(r.truncated).toBe(false);
  });

  test("an empty query is an empty report", () => {
    expect(searchDocuments(all, "  ", read)).toEqual({
      query: "",
      results: [],
      count: 0,
      truncated: false,
    });
  });

  test("the limit caps the list and says so", () => {
    const r = searchDocuments(all, "bridge", read, 2);
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.results.map((x) => x.kind)).toEqual(["name", "text"]);
    expect(searchDocuments(all, "bridge", read, 4).truncated).toBe(false);
  });

  test("a document that cannot be read is skipped, not reported", () => {
    const r = searchDocuments(all, "bridge", (c) => {
      if (c.name === "bridge.md") throw new Error("gone");
      return read(c);
    });
    expect(r.results.filter((x) => x.kind === "text").map((x) => x.name)).toEqual(["other.md"]);
  });

  test("one huge document cannot starve the others, and names are capped", () => {
    const many = Array.from({ length: 100 }, () => "needle").join("\n");
    const docs = [cand("big.md"), cand("small.md")];
    const r = searchDocuments(docs, "needle", (c) => (c.name === "big.md" ? many : "needle"), 500);
    expect(r.results.filter((x) => x.name === "big.md" && x.kind === "text")).toHaveLength(PER_DOC);
    expect(r.results.some((x) => x.name === "small.md" && x.kind === "text")).toBe(true);
    const names = Array.from({ length: 30 }, (_, i) => cand(`note-${i}.md`));
    const n = searchDocuments(names, "note", () => null, 500);
    expect(n.results).toHaveLength(NAME_CAP);
    expect(n.truncated).toBe(true);
  });
});
