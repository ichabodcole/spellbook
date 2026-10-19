// meta-set-byte-safety on the SHIPPED path: `Session.metaSet` and `metaInit`,
// what the shipped `meta-set` and `meta-init` verbs call, writing real files.
// The same table as the kit path's (`kit/metaSetBytes.test.ts`): both paths run
// the one helper (`kit/frontmatter.ts`), so both write the same bytes. Goes with
// the shipped code at the cutover.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOM_NO_BLOCK, BOM_WITH_BLOCK, META_SET_CASES } from "./kit/fixtures/metaSetCases";
import { Session } from "./session";

let root: string;
let docs: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "scriptorium-metaset-")));
  docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function withDoc(name: string, text: string): { s: Session; path: string } {
  const path = join(docs, name);
  writeFileSync(path, text);
  const s = Session.create(join(root, "home"));
  s.addContext(docs);
  return { s, path };
}

describe("the shipped meta-set changes the named key and nothing else", () => {
  for (const [i, c] of META_SET_CASES.entries())
    test(c.name, () => {
      const { s, path } = withDoc(`d${i}.md`, c.before);
      s.metaSet(path, { [c.key]: c.value });
      expect(readFileSync(path, "utf8")).toBe(c.after);
    });
});

describe("the shipped meta-init, after a byte-order mark", () => {
  test("a block behind the mark is a block: refused, and the file is untouched", () => {
    const { s, path } = withDoc("bom.md", BOM_WITH_BLOCK);
    let status: number | undefined;
    try {
      s.metaInit(path, { type: "note" });
    } catch (e) {
      status = (e as { status?: number }).status;
    }
    expect(status).toBe(409);
    expect(readFileSync(path, "utf8")).toBe(BOM_WITH_BLOCK);
  });

  test("a new block goes after the mark, which stays first and single", () => {
    const { s, path } = withDoc("bombare.md", BOM_NO_BLOCK);
    s.metaInit(path, { type: "note", by: "agent" });
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("\uFEFF---\ntype: note\n")).toBe(true);
    expect(text.endsWith("\n---\n# Bombare\n")).toBe(true);
    expect(text.split("\uFEFF").length).toBe(2);
  });
});
