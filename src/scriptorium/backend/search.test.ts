// E59: the two matchers — fuzzy on names, exact on content.
import { describe, expect, test } from "bun:test";
import type { SearchHit, SearchReport as WireReport } from "./protocol";
import {
  type Candidate,
  type Hit,
  type NameMatch,
  type NameSearch,
  type SearchReport,
  scoreName,
  searchDocuments,
  searchText,
  type TextMatch,
} from "./search";

describe("searchText — exact, with line numbers you can open", () => {
  const doc = ["# The Bridge", "", "The baker on the bridge.", "", "Her starter is old."].join(
    "\n",
  );

  test("case-insensitive, and the line is 1-based", () => {
    const hits = searchText(doc, "BRIDGE");
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
  });

  test("the offsets point at the match in the document, not in the line", () => {
    const [hit] = searchText(doc, "baker");
    expect(doc.slice((hit as { from: number }).from, (hit as { to: number }).to)).toBe("baker");
  });

  test("⚠ TWO HITS ON ONE LINE ARE TWO HITS", () => {
    // Stepping by line rather than by match would silently drop the second.
    const hits = searchText("the cat and the cat again", "cat");
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.line)).toEqual([1, 1]);
    expect(hits[0]?.from).not.toBe(hits[1]?.from);
  });

  test("an empty or whitespace query finds nothing, rather than everything", () => {
    expect(searchText(doc, "")).toEqual([]);
    expect(searchText(doc, "   ")).toEqual([]);
  });

  test("the limit is respected", () => {
    const many = Array.from({ length: 30 }, () => "needle").join("\n");
    expect(searchText(many, "needle", 5)).toHaveLength(5);
    expect(searchText(many, "needle", 0)).toEqual([]);
  });

  test("a long line is truncated, and says so", () => {
    const long = `${"x".repeat(400)}needle`;
    const [hit] = searchText(long, "needle");
    expect((hit as { text: string }).text.endsWith("…")).toBe(true);
    expect((hit as { text: string }).text.length).toBeLessThan(400);
  });

  test("a match on the last line, with no trailing newline, still reports", () => {
    const hits = searchText("one\ntwo\nthree", "three");
    expect(hits[0]?.line).toBe(3);
    expect(hits[0]?.text).toBe("three");
  });
});

describe("scoreName — fuzzy, and the ORDERINGS are what is pinned", () => {
  // ⚠ These assert "this beats that", never a number: the weights are taste and
  // must stay retunable without rewriting the suite.
  const beats = (a: [string, string], b: [string, string]) => {
    const sa = scoreName(a[0], a[1]);
    const sb = scoreName(b[0], b[1]);
    expect(sa).not.toBeNull();
    expect(sb).not.toBeNull();
    expect(sa as number).toBeGreaterThan(sb as number);
  };

  test("a non-subsequence is null, not a low score", () => {
    expect(scoreName("Maren.md", "zzz")).toBeNull();
    expect(scoreName("Maren.md", "nam")).toBeNull(); // out of order
    expect(scoreName("anything", "")).toBeNull();
  });

  test("the initials of words match — the jump-box case", () => {
    expect(scoreName("Maren's Bakery.md", "mb")).not.toBeNull();
    expect(scoreName("Maren's Bakery.md", "mabak")).not.toBeNull();
  });

  test("contiguous beats scattered", () => {
    beats(["Maren.md", "mare"], ["My awesome recipe notes.md", "mare"]);
  });

  test("a word start beats the middle of a word", () => {
    beats(["Old Tobias.md", "to"], ["Custom.md", "to"]);
  });

  test("a whole substring beats a mere subsequence", () => {
    // ⚠ The second name must actually CONTAIN s-t-y-l-e in order for this to be
    // the comparison it claims; the first fixture here did not, and the cell
    // failed on `null` rather than on the ordering it meant to pin.
    beats(["Visual Style.md", "style"], ["Set the yellow lever.md", "style"]);
  });

  test("a prefix beats a substring elsewhere", () => {
    beats(["Bridge notes.md", "bridge"], ["The Bridge notes.md", "bridge"]);
  });

  test("the shorter name wins a tie", () => {
    beats(["Maren.md", "maren"], ["Maren and the very long title.md", "maren"]);
  });

  test("case does not matter", () => {
    expect(scoreName("MAREN.MD", "maren")).toBe(scoreName("maren.md", "MAREN"));
  });
});

describe("searchDocuments — both groups, and the caps", () => {
  const docs: Candidate[] = [
    { path: "/w/Maren.md", name: "Maren.md", slug: "maren", title: "Maren" },
    { path: "/w/Maren's Bakery.md", name: "Maren's Bakery.md", slug: "bakery" },
    { path: "/w/Notes.md", name: "Notes.md", slug: "notes" },
  ];
  const bodies: Record<string, string> = {
    "/w/Maren.md": "She keeps the bakery warm.\nAnd the bridge.",
    "/w/Maren's Bakery.md": "The bakery opens early.",
    "/w/Notes.md": "Nothing relevant here.",
  };
  const read = (c: Candidate) => bodies[c.path] ?? null;

  test("names are ranked and content is found, in one report", () => {
    const r = searchDocuments(docs, "bakery", read);
    // The document CALLED bakery ranks first in the jump list.
    expect(r.documents[0]?.name).toBe("Maren's Bakery.md");
    // And both documents mentioning it appear in the find list.
    expect(r.text.map((t) => t.name).sort()).toEqual(["Maren's Bakery.md", "Maren.md"]);
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test("an empty query is an empty report, not every document", () => {
    const r = searchDocuments(docs, "   ", read);
    expect(r).toEqual({ query: "", documents: [], text: [], count: 0, truncated: false });
  });

  test("a document that cannot be read is SKIPPED, not reported as empty", () => {
    const r = searchDocuments(docs, "bakery", (c) => {
      if (c.path === "/w/Maren.md") throw new Error("gone from disk");
      return bodies[c.path] ?? null;
    });
    expect(r.text.map((t) => t.name)).toEqual(["Maren's Bakery.md"]);
  });

  test("the total cap sets `truncated`, so a partial answer cannot look complete", () => {
    const many: Candidate[] = Array.from({ length: 5 }, (_, i) => ({
      path: `/w/d${i}.md`,
      name: `d${i}.md`,
    }));
    const r = searchDocuments(many, "x", () => "x\nx\nx", { total: 4, perDoc: 3 });
    expect(r.count).toBe(4);
    expect(r.truncated).toBe(true);
  });

  test("the per-document cap does not starve later documents", () => {
    const two: Candidate[] = [
      { path: "/w/a.md", name: "a.md" },
      { path: "/w/b.md", name: "b.md" },
    ];
    const r = searchDocuments(two, "x", () => "x\nx\nx\nx\nx", { perDoc: 2, total: 10 });
    expect(r.text.map((t) => t.hits.length)).toEqual([2, 2]);
    expect(r.truncated).toBe(true);
  });

  // ⛔ THE SWAP SEAM, asserted rather than asserted-in-a-comment (Cole asked for
  // the hand-rolled scorer to be replaceable). A stand-in `NameSearch` shaped
  // the way a Fuse adapter would be — given the corpus and a query, return a
  // ranked slice — must change the jump list and NOTHING else.
  test("a replacement NameSearch takes over ranking, and content matching is untouched", () => {
    const reversed: NameSearch = (candidates, _query, limit) =>
      [...candidates]
        .reverse()
        .slice(0, limit)
        .map((c) => ({ path: c.path, name: c.name, score: 1 }));
    const r = searchDocuments(docs, "bakery", read, { nameSearch: reversed });
    // Ranking is the stand-in's: context order reversed, not scored.
    expect(r.documents.map((d) => d.name)).toEqual(["Notes.md", "Maren's Bakery.md", "Maren.md"]);
    // …and the exact content search is completely unaffected by it.
    expect(r.text.map((t) => t.name).sort()).toEqual(["Maren's Bakery.md", "Maren.md"]);
    expect(r.count).toBe(2);
  });

  test("the name limit is handed to the matcher, not applied after it", () => {
    // A Fuse adapter takes `limit` itself; a seam that sliced afterwards would
    // make it do needless work and would disagree about ties.
    // ⚠ Collected into an array rather than a `let`: TypeScript cannot see that
    // the callback ran, so it narrows a `number | null` captured that way to
    // `null` and the assertion stops compiling.
    const seen: number[] = [];
    const spy: NameSearch = (_c, _q, limit) => {
      seen.push(limit);
      return [];
    };
    searchDocuments(docs, "bakery", read, { nameSearch: spy, names: 3 });
    expect(seen).toEqual([3]);
  });

  test("a title matches even when the filename does not", () => {
    const odd: Candidate[] = [{ path: "/w/doc-7.md", name: "doc-7.md", title: "The Bridge" }];
    const r = searchDocuments(odd, "bridge", () => "");
    expect(r.documents[0]?.path).toBe("/w/doc-7.md");
  });
});

// ── the mirror guard ────────────────────────────────────────────────────────
//
// ⛔ `protocol.ts` DUPLICATES these shapes because it is import-free on purpose
// (the surface and `dist/cli.js` must not drag the daemon's modules). Same
// discipline as `GraphPayload`: KEY EQUALITY in both directions, because two-way
// assignability alone is blind to an optional field added to one side — measured
// when E54 drifted `raw?`/`line?` past exactly that check. Nothing runs here;
// the type checker is the assertion.
type ExactKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;
const _reportKeys: ExactKeys<SearchReport, WireReport> = true;
const _hitKeys: ExactKeys<Hit, SearchHit> = true;
const _nameKeys: ExactKeys<NameMatch, WireReport["documents"][number]> = true;
const _textKeys: ExactKeys<TextMatch, WireReport["text"][number]> = true;
const _reportToWire: WireReport = {} as SearchReport;
const _wireToReport: SearchReport = {} as WireReport;
void _reportKeys;
void _hitKeys;
void _nameKeys;
void _textKeys;
void _reportToWire;
void _wireToReport;
