// docMeta over a real session and disk, without a daemon: the shipped cap of
// 500 documents, said when it is hit, and a document two entries show counted
// once. The verbs over it are in `wiki.integration.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceSession } from "../../../kit/workspace/session";
import { tempRoot, testApp } from "../../../kit/workspace/testing";
import { META_SCAN_CAP } from "./frontmatter";
import { docMeta } from "./wiki";

let root: string;
let world: string;

beforeEach(() => {
  root = tempRoot("scriptorium-docmeta");
  world = join(root, "world");
  mkdirSync(join(world, "sub"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const note = (abs: string) => writeFileSync(abs, "---\ntype: note\n---\n# A note\n");

/** `n` documents with a block in the world's own folder, and one in `sub/`. */
function fill(n: number): void {
  for (let i = 0; i < n; i++) note(join(world, `n${String(i).padStart(4, "0")}.md`));
  note(join(world, "sub", "b.md"));
}

const session = () => {
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  s.addContext(world);
  return s;
};

describe("docMeta: the shipped cap", () => {
  test("a world of more than 500 documents gets 500, and says it was cut", () => {
    expect(META_SCAN_CAP).toBe(500);
    fill(META_SCAN_CAP);
    const m = docMeta(session());
    expect(Object.keys(m.docMeta)).toHaveLength(META_SCAN_CAP);
    expect(m.docMetaTruncated).toBe(true);
  });

  test("a world of exactly 500 is whole, and says nothing", () => {
    fill(META_SCAN_CAP - 1);
    const m = docMeta(session());
    expect(Object.keys(m.docMeta)).toHaveLength(META_SCAN_CAP);
    expect("docMetaTruncated" in m).toBe(false);
  });

  test("a document a second entry shows again is counted once: 500 is still whole", () => {
    fill(META_SCAN_CAP - 1);
    const s = session();
    // The set's sub-folder, and one of its documents, added again after it.
    s.addContext(join(world, "sub"));
    s.addContext(join(world, "sub", "b.md"));
    const m = docMeta(s);
    expect(Object.keys(m.docMeta)).toHaveLength(META_SCAN_CAP);
    expect("docMetaTruncated" in m).toBe(false);
  });
});
