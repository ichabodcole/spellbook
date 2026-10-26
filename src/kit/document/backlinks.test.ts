// How "Linked from" arranges what the daemon answered: grouped by relation, bare
// links last, and each line quoted as a reader would say it.
import { describe, expect, test } from "bun:test";
import type { BacklinkView } from "../workspace/protocol";
import { groupBacklinks, snippetParts } from "./backlinks.ts";

const b = (source: string, rel: string[], extra: Partial<BacklinkView> = {}): BacklinkView => ({
  source,
  name: source,
  shown: source,
  line: 1,
  raw: "./x.md",
  rel,
  kind: "markdown",
  context: "",
  from: 0,
  to: 0,
  ...extra,
});

describe("groupBacklinks", () => {
  test("one group per relation, most links first then alphabetical, bare last", () => {
    const groups = groupBacklinks([
      b("a", ["sister-of", "extends"]),
      b("b", []),
      b("c", ["extends"]),
      b("d", ["applies"]),
    ]);
    expect(groups.map((g) => [g.rel, g.links.map((l) => l.source)])).toEqual([
      ["extends", ["a", "c"]],
      ["applies", ["d"]],
      ["sister-of", ["a"]],
      [null, ["b"]],
    ]);
  });

  test("⛔ a bare link is never filed under a relation, and no links make no groups", () => {
    expect(groupBacklinks([b("a", [])]).map((g) => g.rel)).toEqual([null]);
    expect(groupBacklinks([])).toEqual([]);
  });
});

describe("snippetParts", () => {
  test("links become their words, the backlink's own marked, a list marker dropped", () => {
    expect(
      snippetParts({
        kind: "markdown",
        raw: "./the-glade.md?rel=sister-of",
        context: "- Near [the river](./river.md) and [the glade](./the-glade.md?rel=sister-of).",
      }),
    ).toEqual([{ text: "Near the river and " }, { text: "the glade", mark: true }, { text: "." }]);
  });

  test("a wiki link is its label, or its name", () => {
    expect(
      snippetParts({
        kind: "wiki",
        raw: "the-glade",
        context: "## See [[the-glade|Glade]] and [[x]]",
      }),
    ).toEqual([{ text: "See " }, { text: "Glade", mark: true }, { text: " and x" }]);
  });

  test("strong emphasis and code ticks go, the words stay", () => {
    expect(
      snippetParts({
        kind: "markdown",
        raw: "../locations/the-glade.md",
        context: "**Cite** by [`bible/the-glade.md`](../locations/the-glade.md) or `x`.",
      }),
    ).toEqual([
      { text: "Cite by " },
      { text: "bible/the-glade.md", mark: true },
      { text: " or x." },
    ]);
  });

  test("an empty label shows the target, and only the first of two identical links is marked", () => {
    expect(
      snippetParts({ kind: "markdown", raw: "./a.md", context: "[](./a.md) then [a](./a.md)" }),
    ).toEqual([{ text: "./a.md", mark: true }, { text: " then a" }]);
  });
});
