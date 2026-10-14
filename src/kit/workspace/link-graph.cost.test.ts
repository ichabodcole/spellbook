// What one link graph costs on a 2,500-document world, held as counts rather
// than times, as backlinks' and the link check's are: the context's document
// list is walked a fixed number of times per answer, never once per link; each
// document is read once and then only when it changes; and what is sent is cut
// at the cap however large the world. A whole-graph build resolves every link
// that names a document, the same order of work as the link check.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, relative } from "node:path";
import * as links from "./links";
import { GRAPH_CAP } from "./session";
import { inContext, tempRoot } from "./testing";
import * as tree from "./tree";

const root = tempRoot("link-graph-cost");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * Documents in the world, in folders of 100, each writing LINKS links. One
 * context entry lists at most MIRROR_NODE_CAP nodes, so the world is two sets,
 * and links cross between them.
 */
const N = 2500;
const LINKS = 20;
const RELS = ["applies", "mirrors", "sister-of", "contrasts-with"];

test("a 2,500-document graph walks the context a fixed number of times, reads each document once, and is cut at the cap", () => {
  const docs = join(root, "world");
  const half = (f: number) => (f < N / 200 ? "east" : "west");
  const at = (i: number) => {
    const f = Math.floor(i / 100);
    return join(docs, half(f), `f${f}`, `doc-${i}.md`);
  };
  for (let f = 0; f < N / 100; f++) fs.mkdirSync(join(docs, half(f), `f${f}`), { recursive: true });
  for (let i = 0; i < N; i++) {
    const out: string[] = [];
    for (let k = 1; k <= LINKS; k++) {
      // Spread over the world, one in ten typed; one in twenty dangling.
      const j = (i * 7 + k * 131) % N;
      const rel = k % 10 === 0 ? `?rel=${RELS[k % RELS.length]}` : "";
      const target = k % 20 === 0 ? `../gone-${i}.md` : relative(dirname(at(i)), at(j));
      out.push(`[${k}](${target}${rel})`);
    }
    fs.writeFileSync(at(i), `---\ntype: t${i % 6}\n---\n# Doc ${i}\n\n${out.join(" ")}\n`);
  }
  const s = inContext(join(root, "sessions"), join(docs, "east"));
  s.addContext(join(docs, "west"));
  const walks = spyOn(tree, "docPaths");
  const reads = spyOn(links, "extractLinks");
  try {
    const before = walks.mock.calls.length;
    const g = s.linkGraph();
    expect(walks.mock.calls.length - before).toBeGreaterThan(0);
    expect(walks.mock.calls.length - before).toBeLessThanOrEqual(4);
    expect(reads.mock.calls.length).toBe(N);
    // Every link but the dangling ones is an edge before the cut, folded by pair and relation.
    expect(g.total.nodes).toBe(N);
    expect(g.total.edges).toBeGreaterThan(N * (LINKS - 2));
    expect(g.nodes).toHaveLength(GRAPH_CAP);
    expect(g.truncated).toBe(true);
    // Edges only between documents that were kept.
    const kept = new Set(g.nodes.map((n) => n.path));
    for (const e of g.edges) expect(kept.has(e.from) && kept.has(e.to)).toBe(true);
    expect(g.kinds).toHaveLength(6);

    // A filtered view and a neighbourhood read nothing again.
    const focused = s.linkGraph({ focus: at(0), rel: ["mirrors"], untyped: false });
    expect(focused.nodes.length).toBeLessThan(LINKS * 2);
    expect(reads.mock.calls.length).toBe(N);

    // After one document changed, only that one is read again.
    fs.writeFileSync(at(7), "# Doc 7, now with no links at all\n");
    s.linkGraph({ kind: ["t1"] });
    expect(reads.mock.calls.length).toBe(N + 1);
  } finally {
    walks.mockRestore();
    reads.mockRestore();
  }
}, 60_000);
