// The link check, pure: which links answer nothing (ported from the source
// editor's dangling-link report and its tests for the target as written and the
// line), which use a scheme nothing opens, and which documents share a name,
// with a rename for each. Resolution and the disk are injected.
import { describe, expect, test } from "bun:test";
import { DOC_NAME } from "../lib/linkTarget.ts";
import {
  danglingLinks,
  duplicateNames,
  extractLinks,
  type LinkIndex,
  type LinkKind,
  type LinkSource,
  type NameIndex,
  resolveTarget,
} from "./links";
import { DOC_EXTENSIONS } from "./tree";

test("lib's document-name rule names exactly the workspace's document types", () => {
  for (const ext of DOC_EXTENSIONS) expect(DOC_NAME.test(`a${ext}`)).toBe(true);
  expect(String(DOC_NAME)).toBe(`/\\.(?:${DOC_EXTENSIONS.map((e) => e.slice(1)).join("|")})$/i`);
});

/** A world on paper: these documents are in the context, and nothing else exists. */
function world(
  paths: string[],
): (raw: string, from: string, kind: LinkKind) => ReturnType<typeof resolveTarget> {
  const docs = new Set(paths);
  const index: LinkIndex = {
    root: "/w",
    inContext: (p) => (docs.has(p) ? p : null),
    exists: (p) => docs.has(p),
    isDir: (p) => [...docs].some((d) => d.startsWith(`${p}/`)),
  };
  return (raw, from, kind) => resolveTarget(raw, from, index, "document", kind);
}

const src = (path: string, text: string): LinkSource => ({
  path,
  links: extractLinks(text, { schemes: true }),
});

describe("scheme targets, on request", () => {
  test("left out by default, as backlinks wants", () => {
    expect(extractLinks("[a](op:doc/123) [b](https://x.dev) [c](./c.md)\n")).toHaveLength(1);
  });

  test("kept with { schemes: true }, each marked with its scheme, lower-cased", () => {
    const links = extractLinks("[a](op:doc/0193-abc) [b](HTTPS://x.dev) [c](mailto:a@b.c)\n", {
      schemes: true,
    });
    expect(links.map((l) => [l.kind, l.scheme, l.raw])).toEqual([
      ["markdown", "op", "op:doc/0193-abc"],
      ["markdown", "https", "HTTPS://x.dev"],
      ["markdown", "mailto", "mailto:a@b.c"],
    ]);
  });

  test("a wiki link is never a scheme link: `[[Note:Thing]]` is a page's name", () => {
    for (const schemes of [false, true]) {
      const [link] = extractLinks("See [[Note:Thing]] and [[op:doc/9]].\n", { schemes });
      expect(link).toMatchObject({ kind: "wiki", raw: "Note:Thing" });
      expect(link?.scheme).toBeUndefined();
    }
    // It resolves as a name, so a dangling one says where it looked.
    const { missing, unsupported } = danglingLinks(
      [src("/w/a.md", "[[Note:Thing]]\n")],
      world(["/w/a.md"]),
    );
    expect(unsupported).toEqual([]);
    expect(missing[0]?.tried).toEqual(["/w/Note:Thing.md"]);
  });

  test("a colon before a document's name, with no `//`, is a file name, not a scheme", () => {
    const [link] = extractLinks("[intro](Chapter2:intro.md)\n");
    expect(link).toMatchObject({ raw: "Chapter2:intro.md", target: "Chapter2:intro.md" });
    expect(link?.scheme).toBeUndefined();
    // And it resolves like any other path.
    expect(
      danglingLinks(
        [src("/w/a.md", "[intro](Chapter2:intro.md?rel=x)\n")],
        world(["/w/a.md", "/w/Chapter2:intro.md"]),
      ),
    ).toEqual({ missing: [], unsupported: [] });
    // A scheme followed by a path with a folder in it stays a scheme.
    expect(
      extractLinks("[x](op:x.md) [y](op:doc/x.md) [z](https://e.com/a.md)\n", {
        schemes: true,
      }).map((l) => l.scheme),
    ).toEqual([undefined, "op", "https"]);
  });

  test("a path target carries no scheme either way", () => {
    expect(extractLinks("[c](./c.md)\n", { schemes: true })[0]?.scheme).toBeUndefined();
  });
});

describe("what a dangling link report needs", () => {
  test("the target AS WRITTEN, not the resolved shape", () => {
    const { missing } = danglingLinks(
      [src("/w/a.md", "See [it](./missing/deep.md?rel=x#top).\n")],
      world(["/w/a.md"]),
    );
    // ⛔ The written string is the one IN the file, so it is the one a repair
    // can search for. The path alone sends you looking for `deep.md`.
    expect(missing[0]?.raw).toBe("./missing/deep.md?rel=x#top");
    expect(missing[0]?.rel).toEqual(["x"]);
  });

  test("the FILE line, frontmatter counted, not the body line", () => {
    const text = [
      "---",
      "title: A",
      "tags: [x]",
      "---",
      "# A",
      "",
      "- [ok](./b.md)",
      "- [gone](./nowhere.md)",
    ].join("\n");
    const { missing } = danglingLinks([src("/w/a.md", text)], world(["/w/a.md", "/w/b.md"]));
    expect(missing.map((l) => `${l.raw}:${l.line}`)).toEqual(["./nowhere.md:8"]);
  });

  test("a fenced block shifts nothing", () => {
    const text = ["# T", "", "```md", "[x](./not-a-link.md)", "```", "", "real [l](x.md)"].join(
      "\n",
    );
    const { missing } = danglingLinks([src("/w/a.md", text)], world(["/w/a.md"]));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.line).toBe(7);
  });

  test("a wiki link reports what was written inside the brackets", () => {
    const { missing } = danglingLinks(
      [src("/w/a.md", "A [[Ghost Page|the ghost]] here.\n")],
      world(["/w/a.md"]),
    );
    expect(missing[0]).toMatchObject({ kind: "wiki", raw: "Ghost Page", line: 1 });
  });

  test("where the resolver looked, in order", () => {
    const { missing } = danglingLinks([src("/w/sub/a.md", "[x](lost)\n")], world(["/w/sub/a.md"]));
    expect(missing[0]?.tried).toEqual(["/w/sub/lost.md", "/w/lost.md"]);
  });

  test("a link that resolves, to a document, a folder or a non-document, is not dangling", () => {
    const { missing } = danglingLinks(
      [src("/w/a.md", "[b](./b.md) [dir](./sub) [x](./sub/c.md)\n")],
      world(["/w/a.md", "/w/b.md", "/w/sub/c.md"]),
    );
    expect(missing).toEqual([]);
  });

  test("a link that only resolves from the chat is broken where it is written", () => {
    // `./b.md` in a document means beside it: /w/sub/b.md, which is not there.
    const { missing } = danglingLinks(
      [src("/w/sub/a.md", "[b](./b.md)\n")],
      world(["/w/sub/a.md", "/w/b.md"]),
    );
    expect(missing.map((l) => l.tried)).toEqual([["/w/sub/b.md"]]);
  });
});

describe("unsupported schemes, kept apart from missing files", () => {
  test("op:doc links are reported under their scheme, with the line, never as missing", () => {
    const text = "---\nid: 1\n---\nSee [Maren](op:doc/0193-abc?rel=knows) and [x](./gone.md).\n";
    const { missing, unsupported } = danglingLinks([src("/w/a.md", text)], world(["/w/a.md"]));
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({
      source: "/w/a.md",
      scheme: "op",
      raw: "op:doc/0193-abc?rel=knows",
      line: 4,
      label: "Maren",
    });
    expect(missing.map((l) => l.raw)).toEqual(["./gone.md"]);
  });

  test("http, https and mailto open outward and are not reported", () => {
    const { missing, unsupported } = danglingLinks(
      [src("/w/a.md", "[a](https://x.dev) [b](http://x.dev) [c](mailto:a@b.c)\n")],
      world(["/w/a.md"]),
    );
    expect([...missing, ...unsupported]).toEqual([]);
  });

  test("without { schemes: true } the sources hold none, so none is reported", () => {
    const { unsupported } = danglingLinks(
      [{ path: "/w/a.md", links: extractLinks("[a](op:doc/1)\n") }],
      world(["/w/a.md"]),
    );
    expect(unsupported).toEqual([]);
  });
});

describe("shared file names", () => {
  const disk = (opts: { insensitive?: boolean; existing?: string[] } = {}): NameIndex => ({
    caseInsensitive: () => opts.insensitive ?? true,
    exists: (p) => (opts.existing ?? []).includes(p),
  });

  test("the bible's two overviews, each with its folder in front, the ordinal dropped", () => {
    const got = duplicateNames(
      [
        "/w/bible/00-overview.md",
        "/w/bible/locations/00-overview.md",
        "/w/bible/locations/the-glade.md",
      ],
      disk(),
    );
    expect(got).toEqual([
      {
        name: "00-overview.md",
        files: [
          { path: "/w/bible/00-overview.md", suggest: "bible-overview.md" },
          { path: "/w/bible/locations/00-overview.md", suggest: "locations-overview.md" },
        ],
      },
    ]);
  });

  test("a name only one document has is not listed", () => {
    expect(duplicateNames(["/w/a/x.md", "/w/b/y.md"], disk())).toEqual([]);
  });

  test("names that differ only by case collide on a case-insensitive disk", () => {
    const got = duplicateNames(["/w/a/Overview.md", "/w/b/overview.md"], disk());
    expect(got.map((g) => g.files.map((f) => f.path))).toEqual([
      ["/w/a/Overview.md", "/w/b/overview.md"],
    ]);
  });

  test("and not on a case-sensitive one, where they are two names", () => {
    expect(
      duplicateNames(["/w/a/Overview.md", "/w/b/overview.md"], disk({ insensitive: false })),
    ).toEqual([]);
    // The same name, case and all, still collides there.
    expect(
      duplicateNames(["/w/a/x.md", "/w/b/x.md", "/w/c/X.md"], disk({ insensitive: false })).map(
        (g) => g.files.length,
      ),
    ).toEqual([2]);
  });

  test("NFC and NFD spellings of one name collide", () => {
    const nfc = "café.md";
    const nfd = "café.md";
    expect(duplicateNames([`/w/a/${nfc}`, `/w/b/${nfd}`], disk())).toHaveLength(1);
  });

  test("when the folder-based name is taken, the grandparent goes in front", () => {
    // `locations-overview.md` is already a document's name elsewhere.
    const got = duplicateNames(
      [
        "/w/bible/00-overview.md",
        "/w/bible/locations/00-overview.md",
        "/w/notes/locations-overview.md",
      ],
      disk(),
    );
    expect(got[0]?.files.map((f) => f.suggest)).toEqual([
      "bible-overview.md",
      "bible-locations-overview.md",
    ]);
  });

  test("a file already in the folder is taken too, even one the session does not list", () => {
    const got = duplicateNames(
      ["/w/a/x.md", "/w/b/x.md"],
      disk({ existing: ["/w/a/a-x.md", "/w/b/b-x.md", "/w/b/w-b-x.md"] }),
    );
    expect(got[0]?.files.map((f) => f.suggest)).toEqual(["w-a-x.md", "b-x-2.md"]);
  });

  test("two suggestions never collide with each other", () => {
    // Both live in folders named `loc`: both would suggest `loc-x.md`.
    const got = duplicateNames(["/w/one/loc/x.md", "/w/two/loc/x.md"], disk());
    expect(got[0]?.files.map((f) => f.suggest)).toEqual(["loc-x.md", "two-loc-x.md"]);
  });

  test("a folder already leading the name is not repeated", () => {
    const got = duplicateNames(["/w/locations/locations-map.md", "/w/x/locations-map.md"], disk());
    // `locations-map.md` is its own name, so the grandparent goes in front.
    expect(got[0]?.files.map((f) => f.suggest)).toEqual([
      "w-locations-map.md",
      "x-locations-map.md",
    ]);
  });

  test("groups come sorted by name, files by path", () => {
    const got = duplicateNames(["/w/b/z.md", "/w/a/z.md", "/w/b/a.md", "/w/a/a.md"], disk());
    expect(got.map((g) => [g.name, g.files.map((f) => f.path)])).toEqual([
      ["a.md", ["/w/a/a.md", "/w/b/a.md"]],
      ["z.md", ["/w/a/z.md", "/w/b/z.md"]],
    ]);
  });
});
