// What one link check costs, held as a count rather than a time, as backlinks'
// is (backlinks.cost.test.ts): the context's document list is walked a fixed
// number of times per check, never once per link, and a second check reads
// again only the document that changed.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as links from "./links";
import { inContext, tempRoot } from "./testing";
import * as tree from "./tree";

const root = tempRoot("link-check-cost");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("a check walks the context a fixed number of times, and re-reads only what changed", () => {
  const docs = join(root, "world");
  fs.mkdirSync(join(docs, "many"), { recursive: true });
  const N = 300;
  for (let i = 0; i < N; i++)
    fs.writeFileSync(
      join(docs, "many", `doc-${i}.md`),
      `# Doc ${i}\n\n[next](./doc-${(i + 1) % N}.md), [gone](./gone-${i}.md) and [op](op:doc/${i}).\n`,
    );
  const s = inContext(join(root, "sessions"), docs);
  const walks = spyOn(tree, "docPaths");
  const reads = spyOn(links, "extractLinks");
  try {
    const before = walks.mock.calls.length;
    const r = s.linkCheck();
    expect(r.dangling.count).toBe(N);
    expect(r.unsupported.count).toBe(N);
    // One entry: `candidates` lists it once and the index once. Per link would be N and more.
    expect(walks.mock.calls.length - before).toBeGreaterThan(0);
    expect(walks.mock.calls.length - before).toBeLessThanOrEqual(4);
    expect(reads.mock.calls.length).toBe(N);

    // Again after one document changed: only that one is extracted again.
    fs.writeFileSync(join(docs, "many", "doc-7.md"), "# Doc 7, now with no links at all\n");
    const again = s.linkCheck();
    expect(again.dangling.count).toBe(N - 1);
    expect(reads.mock.calls.length).toBe(N + 1);
  } finally {
    walks.mockRestore();
    reads.mockRestore();
  }
});
