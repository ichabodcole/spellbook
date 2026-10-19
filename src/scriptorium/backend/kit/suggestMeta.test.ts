// "Add a block" (E35) on the kit path: the kit's `suggestMeta` against the
// SHIPPED one (`Session.suggestMeta`, what `meta.suggest` answers), over one
// world on disk, document by document. Same inputs, same block, same type,
// same refusal. The shipped answers are CAPTURED (`fixtures/suggest-meta.json`,
// written by the shipped code through `../kitFixtures.capture.ts` over
// `fixtures/worlds.ts`'s `SUGGEST_WORLD`), so this path imports no shipped
// code (scriptorium-kit-keepers). No daemon: the verb over a real one is in
// `wiki.integration.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WorkspaceSession } from "../../../kit/workspace/session";
import { tempRoot, testApp } from "../../../kit/workspace/testing";
import { REFUSED, SUGGEST_WORLD, SUGGESTED } from "./fixtures/worlds";
import { suggestMeta } from "./wiki";

let root: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("scriptorium-suggest");
  docs = join(root, "docs");
  for (const [rel, text] of Object.entries(SUGGEST_WORLD)) {
    mkdirSync(dirname(join(docs, rel)), { recursive: true });
    writeFileSync(join(docs, rel), text);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

type Answer = { path: string; type?: string; block: string };
type Captured = {
  answers: Record<string, { human: Answer; unknown: Answer }>;
  refusals: Record<string, { status: number; message: string }>;
};

/** The shipped answers, placed in this test's world on this test's day. */
function shipped(): Captured {
  const today = new Date().toISOString().slice(0, 10);
  const text = readFileSync(join(import.meta.dir, "fixtures", "suggest-meta.json"), "utf8")
    .replaceAll("@DOCS@", docs)
    .replaceAll("@TODAY@", today);
  return JSON.parse(text) as Captured;
}

function kitSession() {
  const kit = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  kit.addContext(docs);
  return kit;
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

describe("scriptorium.meta.suggest: the shipped meta.suggest's answer, for the same document", () => {
  for (const rel of SUGGESTED)
    test(`${rel}: the same block and type`, () => {
      const want = shipped().answers[rel]?.human;
      expect(want).toBeDefined();
      expect(suggestMeta(kitSession(), join(docs, rel), "human")).toEqual(want as Answer);
    });

  test("what each one says, so a match is not two blanks agreeing", () => {
    const kit = kitSession();
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
    const kit = kitSession();
    const path = join(docs, "notes/bare.md");
    expect(suggestMeta(kit, path)).toEqual(shipped().answers["notes/bare.md"]?.unknown as Answer);
    expect(suggestMeta(kit, path).block).toContain("generated: { by: unknown, at: ");
  });

  for (const rel of REFUSED)
    test(`${rel}: a document with a block is refused the same way, readable or not`, () => {
      const want = shipped().refusals[rel];
      expect(want?.status).toBe(409);
      expect(refusal(() => suggestMeta(kitSession(), join(docs, rel), "human"))).toEqual(
        want as { status: number; message: string },
      );
    });
});
