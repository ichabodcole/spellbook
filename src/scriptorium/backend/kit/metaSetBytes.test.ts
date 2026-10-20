// meta-set-byte-safety on the kit path: the `meta-set` and `meta-init` verbs'
// own functions (`./wiki.ts`), over files on disk in a session's context.
// Each input changes only in the named key. The shipped verbs run the same
// table in `../metaSetBytes.test.ts`; the helper itself in `./frontmatter.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceSession } from "../../../kit/workspace/session";
import { tempRoot, testApp } from "../../../kit/workspace/testing";
import { BOM_NO_BLOCK, BOM_WITH_BLOCK, META_SET_CASES } from "./fixtures/metaSetCases";
import { metaInit, metaSet } from "./wiki";

let root: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("scriptorium-metaset");
  docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A session whose context is `docs`, with `text` written at `docs/<name>`. */
function withDoc(name: string, text: string): { s: WorkspaceSession; path: string } {
  const path = join(docs, name);
  writeFileSync(path, text);
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  s.addContext(docs);
  return { s, path };
}

describe("scriptorium.meta.set on the kit path changes the named key and nothing else", () => {
  for (const [i, c] of META_SET_CASES.entries())
    test(c.name, () => {
      const { s, path } = withDoc(`d${i}.md`, c.before);
      expect(metaSet(s, path, { [c.key]: c.value }).text).toBe(c.after);
    });
});

describe("scriptorium.meta.init on the kit path, after a byte-order mark", () => {
  test("a block behind the mark is a block: refused, as any document with one is", () => {
    const { s, path } = withDoc("bom.md", BOM_WITH_BLOCK);
    let status: number | undefined;
    try {
      metaInit(s, path, { type: "note" });
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(409);
  });

  test("a new block goes after the mark, which stays first and single", () => {
    const { s, path } = withDoc("bombare.md", BOM_NO_BLOCK);
    const { text } = metaInit(s, path, { type: "note", by: "agent" });
    expect(text.startsWith("\uFEFF---\ntype: note\n")).toBe(true);
    expect(text.endsWith("\n---\n# Bombare\n")).toBe(true);
    expect(text.split("\uFEFF").length).toBe(2);
  });
});
