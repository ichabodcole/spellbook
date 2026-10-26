// What one backlinks answer costs, held as a count rather than a time: the
// context's document list is walked a fixed number of times per answer, never
// once per link. A review found the per-link walk (`locate` inside each
// resolution) at about 490 ms an ask on a 2,500-document world with a hub 644
// documents link to, paid on every snapshot while the hub was open.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inContext, tempRoot } from "./testing";
import * as tree from "./tree";

const root = tempRoot("backlinks-cost");
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("the context's documents are listed a fixed number of times per answer, not per link", () => {
  const docs = join(root, "world");
  mkdirSync(join(docs, "hub"), { recursive: true });
  mkdirSync(join(docs, "many"), { recursive: true });
  writeFileSync(join(docs, "hub", "hub.md"), "# Hub\n");
  const N = 300;
  for (let i = 0; i < N; i++)
    writeFileSync(
      join(docs, "many", `doc-${i}.md`),
      `# Doc ${i}\n\nBack to [the hub](../hub/hub.md?rel=sister-of) and [next](./doc-${(i + 1) % N}.md).\n`,
    );
  const s = inContext(join(root, "sessions"), docs);
  const walks = spyOn(tree, "docPaths");
  try {
    const before = walks.mock.calls.length;
    const r = s.backlinks(join(docs, "hub", "hub.md"));
    expect(r.count).toBe(N);
    // One entry here: `candidates` lists it once and the index once. Before the
    // fix this was one walk per resolved link, N and more.
    expect(walks.mock.calls.length - before).toBeGreaterThan(0);
    expect(walks.mock.calls.length - before).toBeLessThanOrEqual(4);
  } finally {
    walks.mockRestore();
  }
});
