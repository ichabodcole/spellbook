// The link check over a real session and disk: the three sections, read from
// each document's active version, shown paths, file lines after frontmatter,
// the disk's own answer about case, and the doctor's findings naming the verb.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseInsensitiveAt, LINK_CHECK_CAP, type WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

/** Whether the temp disk is case-insensitive (macOS by default; Linux CI is not). */
const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), "case-probe-"));
  try {
    writeFileSync(join(dir, "Probe"), "");
    return existsSync(join(dir, "probe"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

let root: string;
let world: string;
let s: WorkspaceSession;

beforeEach(() => {
  root = tempRoot("link-check");
  world = join(root, "bible");
  mkdirSync(join(world, "locations"), { recursive: true });
  writeFileSync(
    join(world, "00-overview.md"),
    [
      "---",
      "title: Overview",
      "---",
      "# Overview",
      "",
      "The [Glade](./locations/the-glade.md?rel=contains) and [Maren](op:doc/0193-maren?rel=knows).",
      "And [a ghost](./locations/ghost.md).",
    ].join("\n"),
  );
  writeFileSync(
    join(world, "locations", "00-overview.md"),
    "# Locations\n\n[Up](../00-overview.md)\n",
  );
  writeFileSync(join(world, "locations", "the-glade.md"), "# The Glade\n\n[web](https://x.dev)\n");
  s = inContext(join(root, "sessions"), world);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("linkCheck", () => {
  test("the three sections, each entry with its file, line and link as written", () => {
    const r = s.linkCheck();
    expect(r.count).toBe(3);
    expect(r.dangling.count).toBe(1);
    expect(r.dangling.links[0]).toMatchObject({
      source: join(world, "00-overview.md"),
      name: "00-overview.md",
      shown: "00-overview.md",
      line: 7,
      raw: "./locations/ghost.md",
      kind: "markdown",
      label: "a ghost",
      tried: [join(world, "locations", "ghost.md")],
    });
    expect(r.unsupported.count).toBe(1);
    expect(r.unsupported.links[0]).toMatchObject({
      shown: "00-overview.md",
      line: 6,
      raw: "op:doc/0193-maren?rel=knows",
      scheme: "op",
    });
    // The offsets are the link's, in the text the session holds.
    const l = r.unsupported.links[0];
    expect(l && l.to - l.from).toBe("[Maren](op:doc/0193-maren?rel=knows)".length);
    expect(r.duplicates).toEqual({
      count: 1,
      names: [
        {
          name: "00-overview.md",
          files: [
            {
              path: join(world, "00-overview.md"),
              shown: "00-overview.md",
              suggest: "bible-overview.md",
              set: s.context[0]?.id,
            },
            {
              path: join(world, "locations", "00-overview.md"),
              shown: "locations/00-overview.md",
              suggest: "locations-overview.md",
              set: s.context[0]?.id,
            },
          ],
        },
      ],
    });
    expect(r.truncated).toBeUndefined();
  });

  test("it only reads: nothing is renamed and no file changes", () => {
    s.linkCheck();
    expect(existsSync(join(world, "locations", "00-overview.md"))).toBe(true);
    expect(existsSync(join(world, "locations", "locations-overview.md"))).toBe(false);
  });

  test("an unsaved edit counts, and backlinks still never see a scheme link", () => {
    const { slug } = s.openPath(join(world, "locations", "the-glade.md"));
    s.edit(
      slug,
      1,
      "# The Glade\n\n[gone](./nowhere.md) [Op](op:doc/x) [Back](./00-overview.md)\n",
    );
    const r = s.linkCheck();
    expect(r.dangling.links.map((l) => [l.shown, l.line, l.raw])).toEqual([
      ["00-overview.md", 7, "./locations/ghost.md"],
      ["locations/the-glade.md", 3, "./nowhere.md"],
    ]);
    expect(r.unsupported.count).toBe(2);
    const back = s.backlinks(join(world, "locations", "00-overview.md"));
    expect(back.backlinks.map((b) => b.raw)).toEqual(["./00-overview.md"]);
  });

  test("a clean world says nothing in any section", () => {
    writeFileSync(
      join(world, "00-overview.md"),
      "# Overview\n\n[Glade](./locations/the-glade.md)\n",
    );
    rmSync(join(world, "locations", "00-overview.md"));
    s.rescan(s.view().context[0]?.id ?? "");
    const r = s.linkCheck();
    expect(r.count).toBe(0);
    expect(s.checkup().filter((f) => f.subject === "link-check")).toEqual([]);
  });

  test.skipIf(!caseInsensitive)(
    "names that differ only by case collide on this case-insensitive disk",
    () => {
      mkdirSync(join(world, "other"));
      writeFileSync(join(world, "other", "THE-GLADE.md"), "# Another glade\n");
      s.rescan(s.view().context[0]?.id ?? "");
      const names = s.linkCheck().duplicates.names.map((n) => n.files.map((f) => f.shown));
      expect(names).toContainEqual(["locations/the-glade.md", "other/THE-GLADE.md"]);
    },
  );

  test("the disk is asked about case, not the platform", () => {
    expect(caseInsensitiveAt(join(world, "00-overview.md"))).toBe(caseInsensitive);
  });

  test("each section is cut at the cap and says so, with the whole count", () => {
    const many = Array.from({ length: LINK_CHECK_CAP + 3 }, (_, i) => `[x](op:doc/${i})`);
    writeFileSync(join(world, "locations", "the-glade.md"), `${many.join("\n")}\n`);
    const r = s.linkCheck();
    expect(r.unsupported.count).toBe(LINK_CHECK_CAP + 4);
    expect(r.unsupported.links).toHaveLength(LINK_CHECK_CAP);
    expect(r.truncated).toBe(true);
  });

  test("shown paths sort naturally: doc-2 before doc-10", () => {
    for (const n of [10, 2, 1])
      writeFileSync(join(world, "locations", `doc-${n}.md`), "[x](./nowhere.md)\n");
    s.rescan(s.view().context[0]?.id ?? "");
    const shown = s.linkCheck().dangling.links.map((l) => l.shown);
    expect(shown.filter((p) => p.startsWith("locations/doc-"))).toEqual([
      "locations/doc-1.md",
      "locations/doc-2.md",
      "locations/doc-10.md",
    ]);
  });
});

describe("the doctor", () => {
  test("raises one finding per section, each naming the verb", () => {
    const got = s.checkup().filter((f) => f.subject === "link-check");
    expect(got.map((f) => [f.kind, f.count])).toEqual([
      ["names.shared", 1],
      ["links.dangling", 1],
      ["links.unsupported", 1],
    ]);
    for (const f of got) expect(f.fix).toContain("`link-check`");
    expect(got[2]?.message).toContain("(op:)");
  });

  test("names every scheme in use, past the list's cap", () => {
    const many = Array.from({ length: LINK_CHECK_CAP + 3 }, (_, i) => `[x](op:doc/${i})`);
    writeFileSync(
      join(world, "locations", "the-glade.md"),
      `${many.join("\n")}\n[late](x-devonthink://item/1)\n`,
    );
    const r = s.linkCheck();
    expect(r.unsupported.links.some((l) => l.scheme === "x-devonthink")).toBe(false);
    expect(r.unsupported.schemes).toEqual(["op", "x-devonthink"]);
    const f = s.checkup().find((x) => x.kind === "links.unsupported");
    expect(f?.message).toContain("(op:, x-devonthink:)");
  });
});

// The source editor's links-cycle verifier repros, on a real disk.
describe("what the source editor's verifier found, on the kit's link check", () => {
  test("a link to a folder is a folder, a dotted folder too, and neither dangles", () => {
    mkdirSync(join(world, "v1.2"));
    writeFileSync(
      join(world, "notes.md"),
      "# Notes\n\n[places](./locations/) [the same](./locations) [v](./v1.2) [v/](./v1.2/)\n",
    );
    // A context lists its folder's documents when it is added.
    s = inContext(join(root, "sessions"), world);
    const { slug } = s.openPath(join(world, "notes.md"));
    for (const t of ["./locations/", "./locations", "locations"])
      expect(s.resolveLink(t, slug)).toEqual({ state: "folder", path: join(world, "locations") });
    expect(s.resolveLink("./v1.2", slug)).toEqual({ state: "folder", path: join(world, "v1.2") });
    expect(s.linkCheck().dangling.links.map((l) => l.raw)).toEqual(["./locations/ghost.md"]);
    // A document of the dotted name wins without the slash, and only then.
    writeFileSync(join(world, "v1.2.md"), "# v1.2\n");
    s = inContext(join(root, "sessions"), world);
    const again = s.openPath(join(world, "notes.md")).slug;
    expect(s.resolveLink("./v1.2", again)).toEqual({
      state: "in-context",
      path: join(world, "v1.2.md"),
    });
    expect(s.resolveLink("./v1.2/", again)).toEqual({ state: "folder", path: join(world, "v1.2") });
  });

  test("a long prose description and a path too long for the disk never take the check down", () => {
    // The ENAMETOOLONG case: the kit reads no frontmatter references, so the
    // description is not a link at all; the long body path is a dangling one.
    const prose = `The build-out — ${"a long account of the work ".repeat(12)}and the CLI/server pair.`;
    const long = Array.from({ length: 6 }, (_, i) => `${i}${"x".repeat(240)}`).join("/");
    writeFileSync(
      join(world, "long.md"),
      [
        "---",
        `description: "${prose}"`,
        `related: [${long}/doc.md]`,
        "---",
        "# Long",
        "",
        `[far](./${long}/doc.md)`,
      ].join("\n"),
    );
    s = inContext(join(root, "sessions"), world);
    const { slug } = s.openPath(join(world, "long.md"));
    const r = s.linkCheck();
    expect(r.dangling.links.map((l) => [l.shown, l.line])).toEqual([
      ["00-overview.md", 7],
      ["long.md", 7],
    ]);
    expect(s.resolveLink(`./${long}.md`, slug).state).toBe("missing");
  });

  test("⛔ an edit that keeps the size and puts the mtime back is still seen", () => {
    const a = join(world, "locations", "00-overview.md");
    writeFileSync(a, "# A\n\n[g](./gone-gone.md)\n");
    // A whole-second mtime, so putting it back is exact.
    const then = new Date("2026-01-02T03:04:05Z");
    utimesSync(a, then, then);
    const before = statSync(a);
    expect(s.linkCheck().dangling.links.map((l) => l.raw)).toContain("./gone-gone.md");
    // Same byte count, then the old mtime restored, as `touch -r` or a sync tool does.
    writeFileSync(a, "# A\n\n[b](./the-glade.md)\n");
    utimesSync(a, before.atime, before.mtime);
    expect(statSync(a).size).toBe(before.size);
    expect(statSync(a).mtimeMs).toBe(before.mtimeMs);
    expect(s.linkCheck().dangling.links.map((l) => l.raw)).not.toContain("./gone-gone.md");
    const back = s.backlinks(join(world, "locations", "the-glade.md"));
    expect(back.backlinks.map((b) => b.raw)).toContain("./the-glade.md");
  });

  test("a wiki link in inline code is in no check, backlink or map (atlas-wiki-links-in-code)", () => {
    // Line 127 of the canvas SPEC: `[[wiki]]` in code, then [[wiki]] in prose.
    writeFileSync(
      join(world, "spec.md"),
      "| Wiki link | Faint dashed | Derived from `[[wiki]]` links. Toggle with the [[wiki]] chip. |\n\nAnd `[x](./wiki.md)` in code.\n",
    );
    s = inContext(join(root, "sessions"), world);
    const gone = s.linkCheck().dangling.links.filter((l) => l.shown === "spec.md");
    expect(gone.map((l) => [l.kind, l.context.slice(l.context.indexOf("Toggle"))])).toEqual([
      ["wiki", "Toggle with the [[wiki]] chip. |"],
    ]);
    writeFileSync(join(world, "wiki.md"), "# Wiki\n");
    s = inContext(join(root, "sessions"), world);
    expect(s.backlinks(join(world, "wiki.md")).backlinks).toHaveLength(1);
    const edges = s.linkGraph().edges.filter((e) => e.to === join(world, "wiki.md"));
    expect(edges.map((e) => e.count)).toEqual([1]);
  });

  test("⛔ the headings cache sees an edit that keeps the size and puts the mtime back", () => {
    const h = join(world, "locations", "the-glade.md");
    writeFileSync(h, "# Aaaaa\n");
    writeFileSync(join(world, "to-heading.md"), "# To\n\n[h](./locations/the-glade.md#aaaaa)\n");
    s = inContext(join(root, "sessions"), world);
    const then = new Date("2026-01-02T03:04:05Z");
    utimesSync(h, then, then);
    const before = statSync(h);
    expect(s.linkCheck().headings.count).toBe(0);
    writeFileSync(h, "# Bbbbb\n");
    utimesSync(h, before.atime, before.mtime);
    expect(statSync(h).size).toBe(before.size);
    expect(statSync(h).mtimeMs).toBe(before.mtimeMs);
    expect(s.linkCheck().headings.links.map((l) => l.raw)).toEqual([
      "./locations/the-glade.md#aaaaa",
    ]);
  });

  test("any scheme but http, https and mailto is reported; one written in code is not", () => {
    writeFileSync(
      join(world, "locations", "the-glade.md"),
      "# The Glade\n\n[a](tel:123) [b](FTP://x) [c](javascript:void(0)) [w](HTTPS://x) [m](mailto:a@b.c)\n\n`[x](op:doc/1)`\n",
    );
    const r = s.linkCheck();
    const here = r.unsupported.links.filter((l) => l.shown !== "00-overview.md");
    expect(here.map((l) => l.scheme)).toEqual(["tel", "ftp", "javascript"]);
  });
});
