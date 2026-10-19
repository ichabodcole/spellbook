// An app's own document kinds (`registerDocExtension`): admitted wherever the
// kit asks whether a name is a document, and read in the format they were
// registered with. Scriptorium's `.mdx` is the first.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTree } from "../workspace/tree";
import {
  DOC_EXTENSIONS,
  docExtensions,
  docFormat,
  isDocName,
  registerDocExtension,
  unregisterDocExtension,
  withKitDocKindsOnly,
  withoutDocExtension,
} from "./docFormat.ts";

// Each test runs on the kit's own kinds, whatever another file in the run
// registered, and leaves the registry as it found it.
const kitOnly = (name: string, fn: () => void) => test(name, () => withKitDocKindsOnly(fn));

kitOnly("the kit's own kinds, and nothing more, until an app adds one", () => {
  expect(docExtensions()).toEqual([...DOC_EXTENSIONS]);
  expect(isDocName("page.mdx")).toBe(false);
});

kitOnly("a registered kind is a document, read as markdown by default, case aside", () => {
  registerDocExtension(".MDX");
  expect(docExtensions()).toEqual([...DOC_EXTENSIONS, ".mdx"]);
  expect(isDocName("Page.MDX")).toBe(true);
  expect(docFormat("page.mdx")).toBe("markdown");
  registerDocExtension(".rst", "json");
  expect(docFormat("a/b.rst")).toBe("json");
  unregisterDocExtension(".mdx");
  expect(isDocName("page.mdx")).toBe(false);
});

kitOnly("a kit kind, an image's, or a name that is not an extension is refused", () => {
  expect(() => registerDocExtension(".md")).toThrow("already has its meaning");
  expect(() => registerDocExtension(".JSON")).toThrow("already has its meaning");
  expect(() => registerDocExtension(".png")).toThrow("already has its meaning");
  expect(() => registerDocExtension("mdx")).toThrow("a dot and letters or digits");
  expect(() => registerDocExtension(".m/x")).toThrow("a dot and letters or digits");
  expect(docExtensions()).toEqual([...DOC_EXTENSIONS]);
});

kitOnly("the tree scan shows a registered kind as a document, and leaves it out otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-docformat-"));
  try {
    writeFileSync(join(dir, "a.md"), "# a\n");
    writeFileSync(join(dir, "page.mdx"), "import X from './x'\n\n<X />\n");
    const rels = () => scanTree(dir).nodes.map((n) => `${n.kind}:${n.rel}`);
    expect(rels()).toEqual(["doc:a.md"]);
    registerDocExtension(".mdx");
    expect(rels()).toEqual(["doc:a.md", "doc:page.mdx"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

kitOnly(
  "a title falls back to the name without a markdown kind's extension, an app's included",
  () => {
    expect(withoutDocExtension("bare.md")).toBe("bare");
    expect(withoutDocExtension("Bare.MARKDOWN")).toBe("Bare");
    expect(withoutDocExtension("notes.txt")).toBe("notes");
    expect(withoutDocExtension("data.json")).toBe("data.json");
    expect(withoutDocExtension("bare.mdx")).toBe("bare.mdx");
    expect(withoutDocExtension(".md")).toBe(".md");
    registerDocExtension(".mdx");
    registerDocExtension(".rst", "json");
    expect(withoutDocExtension("bare.mdx")).toBe("bare");
    expect(withoutDocExtension("table.rst")).toBe("table.rst");
  },
);
