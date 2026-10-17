// What the app's link slot (kit-link-edges-slot) costs on a 2,500-document
// world, held as counts rather than times, as the graph's own cost test is:
// each document's edges are read once, from the read its links come from, and
// again only when it changes; the body-link extractor runs no more often with
// the slot than without it; and the app's resolver is asked only for a target
// the kit's own lookup found no file for, never once per link.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AppEdge } from "./linkEdges";
import * as links from "./links";
import { inContext, tempRoot } from "./testing";

const root = tempRoot("link-edges-cost");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const N = 2500;
const LINKS = 10;
const EDGES = 4;

test("a 2,500-document world reads each document's edges once, and asks the app only on a miss", () => {
  const docs = join(root, "world");
  // Two sets: one context entry lists at most MIRROR_NODE_CAP nodes.
  const half = (f: number) => (f < N / 200 ? "east" : "west");
  const dir = (f: number) => join(docs, half(f), `f${f}`);
  const at = (i: number) => join(dir(Math.floor(i / 100)), `doc-${i}.md`);
  for (let f = 0; f < N / 100; f++) fs.mkdirSync(dir(f), { recursive: true });
  for (let i = 0; i < N; i++) {
    const body: string[] = [];
    for (let k = 1; k <= LINKS; k++) {
      const j = (i * 7 + k * 131) % N;
      body.push(`[${k}](${relative(dirname(at(i)), at(j))})`);
    }
    const related: string[] = [];
    for (let k = 1; k <= EDGES; k++) {
      const j = (i * 13 + k * 17) % N;
      // One in four an alias only the app answers (`@doc-<j>`).
      related.push(k === EDGES ? `"@doc-${j}"` : relative(dirname(at(i)), at(j)));
    }
    fs.writeFileSync(
      at(i),
      `---\nrelated: [${related.join(", ")}]\n---\n# Doc ${i}\n\n${body.join(" ")}\n`,
    );
  }
  // A dense line, as the extractor's own performance work measures one: the slot
  // reads frontmatter, so this costs it nothing more than any other document.
  fs.writeFileSync(
    join(dir(0), "dense.md"),
    `---\nrelated: [./doc-1.md]\n---\n${"[a](./doc-2.md)".repeat(200_000 / 15)}\n`,
  );
  const s = inContext(join(root, "sessions"), join(docs, "east"));
  s.addContext(join(docs, "west"));
  let edgeReads = 0;
  let asked = 0;
  s.setLinkSlot({
    edges: ({ frontmatter }) => {
      edgeReads++;
      const list = frontmatter?.related;
      return Array.isArray(list)
        ? list.map((t): AppEdge => ({ kind: "related", target: String(t) }))
        : [];
    },
    resolve: ({ target, from }) => {
      asked++;
      return target.startsWith("@") && from !== null ? [at(Number(target.slice(5)))] : undefined;
    },
  });
  const reads = spyOn(links, "extractLinks");
  try {
    const g = s.linkGraph();
    // Every document read once, links and edges from the same read.
    expect(reads.mock.calls.length).toBe(N + 1);
    expect(edgeReads).toBe(N + 1);
    // The graph sifts by name before it resolves: an alias that ends in no
    // document's name is passed over unasked (see `LinkSlot`).
    expect(asked).toBe(0);
    const related = g.edgeKinds?.find((k) => k.kind === "related")?.count ?? 0;
    expect(related).toBeGreaterThan(N * 2);

    // Asking again reads nothing, and the backlinks and the check read nothing either.
    s.linkGraph({ edge: ["related"] });
    s.backlinks(at(0));
    const check = s.linkCheck();
    expect(reads.mock.calls.length).toBe(N + 1);
    expect(edgeReads).toBe(N + 1);
    // The check resolves every edge: every body link and path edge on the
    // kit's own, so only the N aliases reach the app, and each lands.
    expect(asked).toBe(N);
    expect(check.edges?.count).toBe(0);

    // One document changed: it alone is read again, links and edges together.
    fs.writeFileSync(at(7), "---\nrelated: [./doc-8.md]\n---\n# Doc 7\n");
    s.linkGraph();
    expect(reads.mock.calls.length).toBe(N + 2);
    expect(edgeReads).toBe(N + 2);
  } finally {
    reads.mockRestore();
  }
}, 60_000);
