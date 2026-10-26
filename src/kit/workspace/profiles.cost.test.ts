// What one profile check costs on a 2,500-document world, held as counts rather
// than times, as the link check's and the graph's are (link-graph.cost.test.ts
// builds the same world): each document is read once and then only when it
// changes; each profile file is listed once per check, however many documents
// look it up, and parsed once and then only when it changes; the context's
// document list is walked a fixed number of times per check.
import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as links from "./links";
import * as profiles from "./profiles";
import { inContext, tempRoot } from "./testing";
import * as tree from "./tree";

const root = tempRoot("profiles-cost");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Documents in the world, in folders of 100, split over two context entries. */
const N = 2500;
const KINDS = 6;

test("a 2,500-document profile check reads each document once, each profile file once, and again only what changed", () => {
  const docs = join(root, "world");
  const half = (f: number) => (f < N / 200 ? "east" : "west");
  const at = (i: number) => {
    const f = Math.floor(i / 100);
    return join(docs, half(f), `f${f}`, `doc-${i}.md`);
  };
  for (let f = 0; f < N / 100; f++) fs.mkdirSync(join(docs, half(f), `f${f}`), { recursive: true });
  const profile = (dir: string, kind: string, extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(join(dir, "_meta", "profiles"), { recursive: true });
    fs.writeFileSync(
      join(dir, "_meta", "profiles", `${kind}.json`),
      JSON.stringify({
        kind,
        allOf: [{ $ref: "_doc.json" }],
        properties: { title: { type: "string" } },
        required: ["title"],
        ...extra,
      }),
    );
  };
  const shared = (side: string, extra: Record<string, unknown> = {}) =>
    fs.writeFileSync(
      join(docs, side, "_meta", "profiles", "_doc.json"),
      JSON.stringify({
        properties: { status: { enum: ["draft", "stable"] } },
        required: ["status"],
        ...extra,
      }),
    );
  // Every kind at the root of each entry, each pulling in its entry's shared
  // file, and one nested override in the east that reaches up to the same one.
  for (const side of ["east", "west"]) {
    for (let k = 0; k < KINDS; k++) profile(join(docs, side), `t${k}`);
    shared(side);
  }
  profile(join(docs, "east", "f3"), "t1", {
    required: [],
    allOf: [{ $ref: "../../../_meta/profiles/_doc.json" }],
  });
  const FILES = KINDS * 2 + 1;
  const SHARED = 2;
  for (let i = 0; i < N; i++) {
    // One in ten has no title; one in twenty-five a status no profile allows.
    const title = i % 10 === 0 ? "" : `title: Doc ${i}\n`;
    const status = i % 25 === 0 ? "final" : "draft";
    fs.writeFileSync(
      at(i),
      `---\ntype: t${i % KINDS}\n${title}status: ${status}\n---\n# Doc ${i}\n\n[next](./doc-${i + 1}.md)\n`,
    );
  }
  const s = inContext(join(root, "sessions"), join(docs, "east"));
  s.addContext(join(docs, "west"));
  const reader = (s as unknown as { profileReader: profiles.ProfileReader }).profileReader;
  const walks = spyOn(tree, "docPaths");
  const reads = spyOn(links, "extractLinks");
  const lookups = spyOn(profiles.ProfileReader.prototype, "file");
  try {
    const before = walks.mock.calls.length;
    const r = s.profileCheck();
    expect(walks.mock.calls.length - before).toBeGreaterThan(0);
    expect(walks.mock.calls.length - before).toBeLessThanOrEqual(4);
    expect(reads.mock.calls.length).toBe(N);
    // Each kind file and each shared file once, however many kinds share one.
    expect(lookups.mock.calls.length).toBe(FILES + SHARED);
    expect(reader.parsed).toBe(FILES + SHARED);
    // f3's documents of kind t1 (in f3, i % 6 === 1) need no title: those
    // missing one are not warned. 250 untitled, less those; 100 bad statuses.
    const exempt = Array.from({ length: 100 }, (_, j) => 300 + j).filter(
      (i) => i % KINDS === 1 && i % 10 === 0,
    ).length;
    expect(r.warnings.count).toBe(250 - exempt + 100);
    expect(r.broken.count).toBe(0);

    // `profiles` and the graph, again: nothing is read or parsed again.
    const p = s.profiles();
    expect(p.kinds).toHaveLength(FILES);
    expect(p.kinds.reduce((n, k) => n + k.documents, 0)).toBe(N);
    s.linkGraph();
    expect(reads.mock.calls.length).toBe(N);
    expect(reader.parsed).toBe(FILES + SHARED);
    expect(lookups.mock.calls.length).toBe((FILES + SHARED) * 3);

    // One profile file changed: only it is parsed again. One document changed: only it is read.
    fs.writeFileSync(
      join(docs, "west", "_meta", "profiles", "t2.json"),
      JSON.stringify({ kind: "t2", required: ["owner"] }),
    );
    fs.writeFileSync(at(7), "---\ntype: t1\ntitle: Seven\nstatus: stable\n---\n# Doc 7\n");
    const again = s.profileCheck();
    expect(reader.parsed).toBe(FILES + SHARED + 1);
    expect(reads.mock.calls.length).toBe(N + 1);
    expect(again.warnings.count).toBeGreaterThan(r.warnings.count);

    // One shared file changed: it alone is parsed again, and every kind that
    // uses it (the west's five that still refer to it) is checked against it.
    shared("west", { required: ["status", "region"] });
    const third = s.profileCheck();
    expect(reader.parsed).toBe(FILES + SHARED + 2);
    expect(reads.mock.calls.length).toBe(N + 1);
    const regions = third.warnings.list.filter((w) => w.field === "region");
    expect(regions.length).toBeGreaterThan(0);
    expect(new Set(regions.map((w) => w.kind))).toEqual(new Set(["t0", "t1", "t3", "t4", "t5"]));
  } finally {
    walks.mockRestore();
    reads.mockRestore();
    lookups.mockRestore();
  }
}, 60_000);
