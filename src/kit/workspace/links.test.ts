// The link resolver, pure: ported from the source editor's link tests
// (resolution and percent-decoding), with the kit's own reading of the root
// and of "in the session". The index is injected, so nothing here touches disk.
import { describe, expect, test } from "bun:test";
import { decodePath, type LinkIndex, resolveTarget, splitTarget } from "./links";

const ROOT = "/w/wiki";
const PATHS = [
  "/w/wiki/index.md",
  "/w/wiki/concepts/exit-codes.md",
  "/w/wiki/decisions/stay-pre-1-0.md",
  "/w/wiki/rules/exit-codes/help-exits-zero.md",
];

/** An index over PATHS (the context), with `onDisk` existing beside it and `dirs` as folders. */
function index(
  onDisk: string[] = [],
  paths: string[] = PATHS,
  root = ROOT,
  dirs: string[] = [],
): LinkIndex {
  const exists = new Set([...paths, ...onDisk]);
  return {
    root,
    inContext: (p) => (paths.includes(p) ? p : null),
    exists: (p) => exists.has(p),
    isDir: (p) => dirs.includes(p),
  };
}

describe("resolving against the context", () => {
  const from = "/w/wiki/decisions/stay-pre-1-0.md";
  // ⛔ THE CLICK PATH GETS THE TARGET AS WRITTEN: query, anchor, encoding and
  // all. The source editor's graph was right while following the same link
  // reported it missing, until the resolver split first. These cells are that bug.
  test("an Operator typed link (`?rel=`) resolves: the query is not part of the name", () => {
    expect(resolveTarget("../concepts/exit-codes.md?rel=located-in", from, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("several relations on one link (`?rel=sister-of,extends`) resolve the same way", () => {
    expect(resolveTarget("../concepts/exit-codes.md?rel=sister-of,extends", from, index())).toEqual(
      { state: "in-context", path: "/w/wiki/concepts/exit-codes.md" },
    );
  });
  test("a percent-encoded space resolves", () => {
    const withFile = index([], [...PATHS, "/w/wiki/concepts/two words.md"]);
    expect(resolveTarget("../concepts/two%20words.md", from, withFile)).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/two words.md",
    });
  });
  test("an anchor is not part of the name either", () => {
    expect(resolveTarget("../concepts/exit-codes.md#the-rule", from, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("all three at once: the Hollowbrook shape", () => {
    const withFile = index([], [...PATHS, "/w/wiki/concepts/two words.md"]);
    expect(resolveTarget("../concepts/two%20words.md?rel=located-in#top", from, withFile)).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/two words.md",
    });
  });
  test("a lone `%` in a name resolves to the file as written, and never throws", () => {
    const withFile = index([], [...PATHS, "/w/wiki/decisions/100% done.md"]);
    expect(() => resolveTarget("./100% done.md", from, withFile)).not.toThrow();
    expect(resolveTarget("./100% done.md?rel=extends", from, withFile)).toEqual({
      state: "in-context",
      path: "/w/wiki/decisions/100% done.md",
    });
  });

  test("`./` and `../` resolve against the document's folder", () => {
    expect(resolveTarget("./stay-pre-1-0.md", from, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/decisions/stay-pre-1-0.md",
    });
    expect(resolveTarget("../concepts/exit-codes.md", from, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
    // Anchored means only there: not tried against the root as well.
    expect(resolveTarget("./index.md", from, index())).toEqual({
      state: "missing",
      tried: ["/w/wiki/decisions/index.md"],
    });
  });
  test("⛔ a leading slash is the ROOT of the document's entry, not the filesystem root", () => {
    expect(resolveTarget("/concepts/exit-codes.md", from, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("an absolute filesystem path (an agent's, in the chat) is tried after the root", () => {
    const i = index([], [...PATHS, "/elsewhere/notes.md"]);
    expect(resolveTarget("/elsewhere/notes.md", from, i)).toEqual({
      state: "in-context",
      path: "/elsewhere/notes.md",
    });
  });
  test("an UNANCHORED path is tried against the document, then the root", () => {
    expect(resolveTarget("concepts/exit-codes.md", "/w/wiki/rules/x.md", index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
    // Document-relative still WINS when both would resolve.
    const j = index([], [...PATHS, "/w/wiki/decisions/notes.md", "/w/wiki/notes.md"]);
    expect(resolveTarget("notes.md", from, j)).toEqual({
      state: "in-context",
      path: "/w/wiki/decisions/notes.md",
    });
  });
  test("a target with no extension is read as a markdown file", () => {
    expect(resolveTarget("../concepts/exit-codes", from, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("with no document (a chat link and nothing open), relative targets read from the root", () => {
    expect(resolveTarget("concepts/exit-codes.md", null, index())).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });

  test("a target that exists but no entry lists is `outside`, not missing", () => {
    expect(resolveTarget("../../other/notes.md", from, index(["/w/other/notes.md"]))).toEqual({
      state: "outside",
      path: "/w/other/notes.md",
    });
  });
  test("a file that exists but is not a document type is `not-a-doc`", () => {
    expect(resolveTarget("./map.png", from, index(["/w/wiki/decisions/map.png"]))).toEqual({
      state: "not-a-doc",
      path: "/w/wiki/decisions/map.png",
    });
  });
  test("in the context wins over merely existing, in candidate order", () => {
    // Document-relative exists on disk but is outside; the root's copy is listed.
    const i = index(["/w/wiki/decisions/concepts/exit-codes.md"]);
    expect(resolveTarget("concepts/exit-codes.md", from, i)).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });
  test("a target nothing answers is `missing`, naming every place looked", () => {
    expect(resolveTarget("./gone.md?rel=x", from, index())).toEqual({
      state: "missing",
      tried: ["/w/wiki/decisions/gone.md"],
    });
    // A `/` target names the filesystem path as well as the root-joined one,
    // so an agent's absolute path is reported as it wrote it, not only doubled.
    expect(resolveTarget("/elsewhere/gone.md", from, index())).toEqual({
      state: "missing",
      tried: ["/w/wiki/elsewhere/gone.md", "/elsewhere/gone.md"],
    });
  });
  test("a link to a folder says it is a folder, not a missing `.md`", () => {
    const i = index([], PATHS, ROOT, ["/w/wiki/concepts"]);
    expect(resolveTarget("../concepts/", from, i)).toEqual({
      state: "folder",
      path: "/w/wiki/concepts",
    });
    expect(resolveTarget("/concepts", from, i)).toEqual({
      state: "folder",
      path: "/w/wiki/concepts",
    });
  });
  // From the source editor's verifier repros.
  describe("a folder and a document of the same name", () => {
    const home = "/w/wiki/index.md";
    const both = index([], [...PATHS, "/w/wiki/rules.md"], ROOT, ["/w/wiki/rules"]);
    test("⚠ the document wins without the slash; a trailing slash says FOLDER", () => {
      expect(resolveTarget("./rules", home, both)).toEqual({
        state: "in-context",
        path: "/w/wiki/rules.md",
      });
      for (const t of ["./rules/", "rules/", "/rules/", "./rules/?rel=x"])
        expect(resolveTarget(t, home, both)).toEqual({ state: "folder", path: "/w/wiki/rules" });
    });
    test("a trailing-slash target that is no folder is missing, and says the folder it tried", () => {
      expect(resolveTarget("./places/", home, both)).toEqual({
        state: "missing",
        tried: ["/w/wiki/places"],
      });
      // `index/` is no `index.md`: the slash asks for a folder.
      expect(resolveTarget("./index/", home, both).state).toBe("missing");
    });
    test("a bare name no document answers, a nested folder, and the root itself", () => {
      const i = index([], PATHS, ROOT, ["/w/wiki", "/w/wiki/rules", "/w/wiki/rules/exit-codes"]);
      expect(resolveTarget("rules", home, i)).toEqual({ state: "folder", path: "/w/wiki/rules" });
      expect(resolveTarget("../rules/exit-codes/", "/w/wiki/concepts/x.md", i)).toEqual({
        state: "folder",
        path: "/w/wiki/rules/exit-codes",
      });
      expect(resolveTarget("/", home, i)).toEqual({ state: "folder", path: "/w/wiki" });
    });
    test("`./v1.2` is v1.2.md when both it and a v1.2/ folder exist", () => {
      const dotted = index([], [...PATHS, "/w/wiki/v1.2.md"], ROOT, ["/w/wiki/v1.2"]);
      expect(resolveTarget("./v1.2", home, dotted)).toEqual({
        state: "in-context",
        path: "/w/wiki/v1.2.md",
      });
      expect(resolveTarget("./v1.2/", home, dotted)).toEqual({
        state: "folder",
        path: "/w/wiki/v1.2",
      });
      // With no document, the folder answers.
      expect(resolveTarget("./v1.2", home, index([], PATHS, ROOT, ["/w/wiki/v1.2"]))).toEqual({
        state: "folder",
        path: "/w/wiki/v1.2",
      });
    });
    test("`./notes.v2` finds notes.v2.md", () => {
      expect(
        resolveTarget("./notes.v2", home, index([], [...PATHS, "/w/wiki/notes.v2.md"])),
      ).toEqual({ state: "in-context", path: "/w/wiki/notes.v2.md" });
    });
    test("⚠ a name with a real extension is still that file, and a miss says what was looked for", () => {
      expect(resolveTarget("./lint.ts", home, index(["/w/wiki/lint.ts"]))).toEqual({
        state: "not-a-doc",
        path: "/w/wiki/lint.ts",
      });
      expect(resolveTarget("./v9.9", home, index())).toEqual({
        state: "missing",
        tried: ["/w/wiki/v9.9", "/w/wiki/v9.9.md"],
      });
      // A document's or an image's name is not given a second `.md`.
      expect(resolveTarget("./gone.md", home, index())).toEqual({
        state: "missing",
        tried: ["/w/wiki/gone.md"],
      });
      expect(resolveTarget("./gone.png", home, index())).toEqual({
        state: "missing",
        tried: ["/w/wiki/gone.png"],
      });
    });
  });
  test("an in-context path comes back in the context's own form, not the link's", () => {
    const i: LinkIndex = {
      ...index(),
      inContext: (p) =>
        p.toLowerCase() === "/w/wiki/concepts/exit-codes.md"
          ? "/w/wiki/concepts/exit-codes.md"
          : null,
    };
    expect(resolveTarget("../Concepts/Exit-Codes.md", from, i)).toEqual({
      state: "in-context",
      path: "/w/wiki/concepts/exit-codes.md",
    });
  });

  describe("a link from the chat, which was not written beside the open document", () => {
    const glade = "/w/wiki/locations/the-glade.md";
    const i = index([], [...PATHS, glade]);
    test("`./` falls back to the root when the open document is nested", () => {
      // The open document is in `locations/`: from there alone this would be
      // `locations/locations/the-glade.md`.
      expect(resolveTarget("./locations/the-glade.md", glade, i, "chat")).toEqual({
        state: "in-context",
        path: glade,
      });
      // The same link written IN that document stays anchored to its folder.
      expect(resolveTarget("./locations/the-glade.md", glade, i).state).toBe("missing");
    });
    test("the open document's folder still wins when both answer", () => {
      const near = "/w/wiki/locations/notes.md";
      const j = index([], [...PATHS, glade, near, "/w/wiki/notes.md"]);
      expect(resolveTarget("./notes.md", glade, j, "chat")).toEqual({
        state: "in-context",
        path: near,
      });
    });
  });
  test("a scheme or an empty path names no file", () => {
    expect(resolveTarget("op:doc/01a0f97b", from, index()).state).toBe("missing");
    expect(resolveTarget("?rel=x", from, index()).state).toBe("missing");
  });
});

describe("percent-encoded targets", () => {
  test("a space encoded as %20 decodes to the name it stands for", () => {
    expect(splitTarget("Maren's%20Bakery.md").path).toBe("Maren's Bakery.md");
  });
  test("decoding happens before the query is read, and the query is kept as written", () => {
    const t = splitTarget("Visual%20Style.md?rel=renders-per,extends");
    expect(t.path).toBe("Visual Style.md");
    expect(t.query).toBe("rel=renders-per,extends");
  });
  test("an em dash survives encoding", () => {
    // Encoded by the platform, as an exporter would write it.
    const written = encodeURIComponent("Hollowbrook — Overview.md");
    expect(written).toContain("%20%");
    expect(splitTarget(written).path).toBe("Hollowbrook — Overview.md");
  });
  test("an UNDECODABLE target is left alone rather than throwing", () => {
    expect(() => splitTarget("100% done.md")).not.toThrow();
    expect(splitTarget("100% done.md").path).toBe("100% done.md");
    expect(decodePath("100%")).toBe("100%");
  });
  test("a target with no encoding is untouched", () => {
    expect(splitTarget("Maren.md").path).toBe("Maren.md");
  });
  test("an anchor is split off, and the path decoded", () => {
    const t = splitTarget("Hollowbrook%20Overview.md#the-rules");
    expect(t.path).toBe("Hollowbrook Overview.md");
    expect(t.anchor).toBe("the-rules");
  });
});
