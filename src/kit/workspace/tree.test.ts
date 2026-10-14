import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOC_EXTENSIONS,
  docPaths,
  entryForPath,
  imagePaths,
  isDocName,
  listDir,
  locate,
  scanTree,
} from "./tree";

const root = mkdtempSync(join(tmpdir(), "workspace-tree-"));
mkdirSync(join(root, "set", "g1", "deep"), { recursive: true });
mkdirSync(join(root, "set", "node_modules", "x"), { recursive: true });
mkdirSync(join(root, "set", ".hidden"), { recursive: true });
mkdirSync(join(root, "set", "empty"), { recursive: true });
mkdirSync(join(root, "set", "assets"), { recursive: true });
writeFileSync(join(root, "set", "assets", "logo.png"), "no");
writeFileSync(join(root, "set", "z.md"), "z");
writeFileSync(join(root, "set", "a.txt"), "a");
writeFileSync(join(root, "set", "g1", "deep", "d.markdown"), "d");
writeFileSync(join(root, "set", "node_modules", "x", "readme.md"), "no");
writeFileSync(join(root, "set", ".hidden", "h.md"), "no");
writeFileSync(join(root, "set", "pic.png"), "no");
mkdirSync(join(root, "set", "other"), { recursive: true });
writeFileSync(join(root, "set", "other", "notes.zip"), "no");
writeFileSync(join(root, "set", "other", "logo.svg"), "<svg/>");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("documents are recognised by extension, case-insensitively", () => {
  expect(["a.md", "B.MD", "c.markdown", "e.txt", "g.json", "H.JSON"].every(isDocName)).toBe(true);
  expect(isDocName("f.png")).toBe(false);
  // `.mdx` is not admitted: the workspace opens prose, not components.
  expect(isDocName("d.mdx")).toBe(false);
  expect([...DOC_EXTENSIONS]).toEqual([".md", ".markdown", ".txt", ".json"]);
});

test("a scan mirrors documents and images; skips dot and noise directories and folders of neither; keeps an empty folder", () => {
  const { nodes, truncated } = scanTree(join(root, "set"));
  expect(truncated).toBe(false);
  expect(nodes).toEqual([
    // A folder of images shows: images are in the tree now.
    { kind: "group", rel: "assets", children: [{ kind: "image", rel: "assets/logo.png" }] },
    // Kept: somebody just made it to put documents in ("New folder").
    { kind: "group", rel: "empty", children: [] },
    {
      kind: "group",
      rel: "g1",
      children: [
        { kind: "group", rel: "g1/deep", children: [{ kind: "doc", rel: "g1/deep/d.markdown" }] },
      ],
    },
    // Neither a document nor an image: not shown, and its folder with it.
    { kind: "doc", rel: "a.txt" },
    { kind: "image", rel: "pic.png" },
    { kind: "doc", rel: "z.md" },
  ]);
});

test("images are their own nodes: docPaths never lists one, imagePaths lists only them", () => {
  const e = entryForPath(join(root, "set"), "c1");
  expect(docPaths(e).some((p) => p.endsWith(".png"))).toBe(false);
  expect(imagePaths(e).sort()).toEqual([
    join(root, "set", "assets", "logo.png"),
    join(root, "set", "pic.png"),
  ]);
  // A document's lookup never finds an image.
  expect(locate([e], join(root, "set", "pic.png"))).toBeNull();
});

test("a scan that hits its cap says so rather than presenting a short list as whole", () => {
  expect(scanTree(join(root, "set"), 1).truncated).toBe(true);
});

test("docPaths and locate agree on where a document lives", () => {
  const e = entryForPath(join(root, "set"), "c1");
  expect(docPaths(e)).toContain(join(root, "set", "g1", "deep", "d.markdown"));
  expect(locate([e], join(root, "set", "g1", "deep", "d.markdown"))).toEqual({
    entryId: "c1",
    rel: "g1/deep/d.markdown",
  });
  expect(locate([e], join(root, "elsewhere.md"))).toBeNull();
});

test("listDir offers directories first, then documents and images, and nothing else", () => {
  expect(listDir(join(root, "set")).map((e) => [e.name, e.dir])).toEqual([
    ["assets", true],
    ["empty", true],
    ["g1", true],
    ["node_modules", true],
    ["other", true],
    // The add-a-path completion lists documents and images: a single image can
    // be added by path as its own entry, as a document can.
    ["a.txt", false],
    ["pic.png", false],
    ["z.md", false],
  ]);
});
