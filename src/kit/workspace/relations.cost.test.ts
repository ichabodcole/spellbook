// What the link picker's relations cost on the 2,500-document world the graph's
// cost test builds (link-graph.cost.test.ts), held as counts rather than times.
// Before kit-picker-relation-meanings, every open of the picker read every
// document's whole text to count `?rel=`. Now the relations come from the link
// cache: the first open reads each document once, a second open reads none, and
// after one edit only that document is read again. Each vocabulary file is
// parsed once, and again only when it changes.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeVocabulary } from "./fixtures/relations";
import * as links from "./links";
import type { RelationsReader } from "./relations";
import { inContext, tempRoot } from "./testing";
import * as tree from "./tree";

const root = tempRoot("relations-cost");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const N = 2500;
const LINKS = 20;
const RELS = ["applies", "mirrors", "sister-of", "contrasts-with"];

test("a 2,500-document world's relations come from the link cache: one read per document, then only what changed", () => {
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
  // A vocabulary at the root of each entry: the east declares sister-of
  // symmetric, the west declares nothing the links use.
  writeVocabulary(join(docs, "east"), {
    relations: { "sister-of": { label: "sister of", means: "A peer.", symmetric: true } },
  });
  writeVocabulary(join(docs, "west"), { relations: { "grounded-in": { inverse: "grounds" } } });
  const s = inContext(join(root, "sessions"), join(docs, "east"));
  s.addContext(join(docs, "west"));
  const reader = (s as unknown as { relationsReader: RelationsReader }).relationsReader;
  const { slug } = s.openPath(at(0));
  const walks = spyOn(tree, "docPaths");
  const reads = spyOn(links, "extractLinks");
  const texts = spyOn(fs, "readFileSync");
  const docReads = () =>
    texts.mock.calls.filter(([p]) => typeof p === "string" && p.endsWith(".md")).length;
  try {
    const before = walks.mock.calls.length;
    const t = s.linkTargets(slug);
    expect(walks.mock.calls.length - before).toBeGreaterThan(0);
    expect(walks.mock.calls.length - before).toBeLessThanOrEqual(4);
    // Each document read once, and extracted once.
    expect(reads.mock.calls.length).toBe(N);
    expect(docReads()).toBeGreaterThanOrEqual(N);
    expect(docReads()).toBeLessThanOrEqual(N + 1);
    expect(reader.parsed).toBe(1);
    expect(t.vocabulary).toBe(true);
    expect(t.kind).toBe("t0");
    // Every typed link's relation counted: per document, one sister-of that
    // lands and one applies that dangles.
    expect(t.relations.find((r) => r.rel === "sister-of")).toMatchObject({
      count: N,
      declared: true,
      means: "A peer.",
    });
    expect(t.relations.find((r) => r.rel === "applies")).toMatchObject({
      count: N,
      declared: false,
    });
    // The dangling ones land on no kind; the others are counted into theirs.
    expect(t.byKind.filter((u) => u.rel === "applies")).toEqual([]);
    expect(t.byKind.reduce((n, u) => n + u.links, 0)).toBe(N);
    expect(t.byKind.filter((u) => u.kind === "t1").map((u) => u.rel)).toEqual(["sister-of"]);

    // A second open: nothing read, nothing parsed.
    const reading = docReads();
    s.linkTargets(slug);
    expect(reads.mock.calls.length).toBe(N);
    expect(docReads()).toBe(reading);
    expect(reader.parsed).toBe(1);

    // One document changed: only it is read again. The vocabulary changed: only it is parsed again.
    fs.writeFileSync(at(7), "---\ntype: t1\n---\n# Doc 7\n\n[x](./doc-8.md?rel=echoes)\n");
    writeVocabulary(join(docs, "east"), {
      relations: { echoes: { label: "echoes", symmetric: true } },
    });
    const again = s.linkTargets(slug);
    expect(reads.mock.calls.length).toBe(N + 1);
    expect(reader.parsed).toBe(2);
    expect(again.relations.find((r) => r.rel === "echoes")).toMatchObject({
      count: 1,
      declared: true,
    });
  } finally {
    walks.mockRestore();
    reads.mockRestore();
    texts.mockRestore();
  }
}, 60_000);
