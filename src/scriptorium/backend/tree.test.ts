import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOC_EXTENSIONS as SURFACE_DOC_EXTENSIONS } from "../surface/components/context/model";
import {
  DOC_EXTENSIONS,
  docPaths,
  entryForPath,
  isDocName,
  listDir,
  locate,
  scanTree,
} from "./tree";

const root = mkdtempSync(join(tmpdir(), "scriptorium-tree-"));
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
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the surface's copy of the document extensions is this list (it cannot import node:fs)", () => {
  expect([...SURFACE_DOC_EXTENSIONS]).toEqual([...DOC_EXTENSIONS]);
});

test("documents are recognised by extension, case-insensitively", () => {
  expect(["a.md", "B.MD", "c.markdown", "d.mdx", "e.txt"].every(isDocName)).toBe(true);
  expect(isDocName("f.png")).toBe(false);
});

test("a scan mirrors documents only; skips dot and noise directories and folders of non-documents; keeps an empty folder", () => {
  const { nodes, truncated } = scanTree(join(root, "set"));
  expect(truncated).toBe(false);
  expect(nodes).toEqual([
    // Kept: somebody just made it to put documents in (E24's "New folder").
    { kind: "group", rel: "empty", children: [] },
    {
      kind: "group",
      rel: "g1",
      children: [
        { kind: "group", rel: "g1/deep", children: [{ kind: "doc", rel: "g1/deep/d.markdown" }] },
      ],
    },
    { kind: "doc", rel: "a.txt" },
    { kind: "doc", rel: "z.md" },
  ]);
});

test("hidden rels are skipped — a hidden folder with everything under it", () => {
  const { nodes } = scanTree(join(root, "set"), undefined, ["g1", "z.md"]);
  expect(nodes.map((n) => n.rel)).toEqual(["empty", "a.txt"]);
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

test("listDir offers directories first, then documents, and nothing else", () => {
  expect(listDir(join(root, "set")).map((e) => [e.name, e.dir])).toEqual([
    ["assets", true],
    ["empty", true],
    ["g1", true],
    ["node_modules", true],
    ["a.txt", false],
    ["z.md", false],
  ]);
});
