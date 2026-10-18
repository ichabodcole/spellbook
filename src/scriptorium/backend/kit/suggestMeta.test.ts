// "Add a block" (E35) on the kit path: the kit's `suggestMeta` against the
// SHIPPED one (`Session.suggestMeta`, what `meta.suggest` answers), over one
// world on disk, document by document. Same inputs, same block, same type,
// same refusal. No daemon: the verb over a real one is in
// `wiki.integration.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceSession } from "../../../kit/workspace/session";
import { tempRoot, testApp } from "../../../kit/workspace/testing";
import { Session } from "../session";
import { suggestMeta } from "./wiki";

let root: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("scriptorium-suggest");
  docs = join(root, "docs");
  const put = (rel: string, text: string) => {
    const p = join(docs, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
  };
  // Neighbours that say: two `decision`, one `memo`, so the majority wins.
  put("notes/a.md", "---\ntype: decision\n---\n# A\n");
  put("notes/b.md", "---\ntype: decision\n---\n# B\n");
  put("notes/c.md", "---\ntype: memo\n---\n# C\n");
  put("notes/bare.md", "# The bare one\n\nBody.\n");
  // A neighbour whose block will not parse says nothing.
  put("notes/broken.md", "---\ntype: [unclosed\n---\n# Broken\n");
  // Nobody beside it says: the folder's name, de-pluralised.
  put("stories/tale.md", "Prose before any heading.\n\n# Not the title\n");
  put("categories/one.md", "# One: a title that needs quoting\n");
  // A tie between neighbours: the name that sorts first.
  put("tie/x.md", "---\ntype: zeta\n---\n");
  put("tie/y.md", "---\ntype: alpha\n---\n");
  put("tie/z.md", "# Zed\n");
  // Already has a block, readable or not: refused, both ways.
  put("notes/has.md", "---\ntitle: Has\n---\n# Has\n");
  put("notes/bad.md", "---\n: : :\n---\n# Bad\n");
  put("solo.md", "# Solo\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function both() {
  const shipped = Session.create(join(root, "home"));
  shipped.addContext(docs);
  const kit = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  kit.addContext(docs);
  return { shipped, kit };
}

const refusal = (fn: () => unknown): { status: number; message: string } => {
  try {
    fn();
  } catch (e) {
    const err = e as Error & { status: number };
    return { status: err.status, message: err.message };
  }
  throw new Error("expected a refusal");
};

const SUGGESTED = [
  "notes/bare.md",
  "stories/tale.md",
  "categories/one.md",
  "tie/z.md",
  "solo.md",
] as const;

describe("scriptorium.meta.suggest: the shipped meta.suggest's answer, for the same document", () => {
  for (const rel of SUGGESTED)
    test(`${rel}: the same block and type`, () => {
      const { shipped, kit } = both();
      const path = join(docs, rel);
      const want = shipped.suggestMeta(path, "human");
      const got = suggestMeta(kit, path, "human");
      expect(got).toEqual(want);
    });

  test("what each one says, so a match is not two blanks agreeing", () => {
    const { kit } = both();
    const block = (rel: string) => suggestMeta(kit, join(docs, rel), "human").block;
    const today = new Date().toISOString().slice(0, 10);
    expect(block("notes/bare.md")).toBe(
      `---\ntype: decision\ntitle: The bare one\ndescription: \ntags: []\nstatus: draft\ngenerated: { by: human, at: ${today} }\n---\n`,
    );
    expect(block("stories/tale.md")).toContain('type: story\ntitle: ""\n');
    expect(block("categories/one.md")).toContain(
      'type: category\ntitle: "One: a title that needs quoting"\n',
    );
    expect(block("tie/z.md")).toContain("type: alpha\ntitle: Zed\n");
  });

  test("with no `by`, both say unknown", () => {
    const { shipped, kit } = both();
    const path = join(docs, "notes/bare.md");
    expect(suggestMeta(kit, path)).toEqual(shipped.suggestMeta(path));
    expect(suggestMeta(kit, path).block).toContain("generated: { by: unknown, at: ");
  });

  for (const rel of ["notes/has.md", "notes/bad.md"])
    test(`${rel}: a document with a block is refused the same way, readable or not`, () => {
      const { shipped, kit } = both();
      const path = join(docs, rel);
      const want = refusal(() => shipped.suggestMeta(path, "human"));
      expect(want.status).toBe(409);
      expect(refusal(() => suggestMeta(kit, path, "human"))).toEqual(want);
    });
});
