// The link check's symmetry hint over a real session (kit-link-check-symmetry):
// a relation the vocabulary declares symmetric, written one way only, is listed
// as a hint in its own section, with its own count, kept out of `count` and out
// of the doctor's findings; a pair written both ways and a link to itself are
// not; symmetry is read from the vocabulary, nearest file winning; an unsaved
// edit counts; and a world with no `_relations.json` has no hints.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { smallDreamwood, VOCABULARY, writeDoc, writeVocabulary } from "./fixtures/relations";
import type { WorkspaceSession } from "./session";
import { inContext, tempRoot } from "./testing";

let root: string;
let world: string;
let s: WorkspaceSession;

beforeEach(() => {
  root = tempRoot("links-symmetry");
  world = join(root, "bible");
  mkdirSync(world, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const hints = () =>
  s.linkCheck().symmetry.hints.map((h) => `${h.shown}:${h.line} ${h.rel} → ${h.targetShown}`);

describe("symmetric relations written one way", () => {
  test("each is a hint naming both ends, and the Ruin and the Cave, linked both ways, are not", () => {
    smallDreamwood(world);
    s = inContext(join(root, "sessions"), world);
    const r = s.linkCheck();
    expect(r.symmetry.count).toBe(2);
    expect(hints()).toEqual([
      "locations/the-cave.md:6 contrasts-with → locations/the-glade.md",
      "locations/the-ruin.md:6 contrasts-with → locations/the-glade.md",
    ]);
    const ruin = r.symmetry.hints[1];
    expect(ruin).toMatchObject({
      source: join(world, "locations", "the-ruin.md"),
      name: "the-ruin.md",
      raw: "./the-glade.md?rel=contrasts-with",
      label: "the Glade",
      kind: "markdown",
      target: join(world, "locations", "the-glade.md"),
      hint: "The Ruin contrasts-with The Glade; The Glade does not link back",
    });
    // A hint, never a problem: out of `count`, and the doctor says nothing of it.
    expect(r.count).toBe(1); // the op: link alone
    expect(s.checkup().some((f) => /symmetr|link back/i.test(f.message))).toBe(false);
  });

  test("a sister linked both ways, and a link to itself, give none; a one-way relation never does", () => {
    smallDreamwood(world);
    writeDoc(
      world,
      "a.md",
      "ritual",
      "# A\n\n[b](./b.md?rel=sister-of) [me](./a.md?rel=contrasts-with) [c](./c.md?rel=grounded-in)\n",
    );
    writeDoc(world, "b.md", "ritual", "# B\n\n[a](./a.md?rel=sister-of)\n");
    writeDoc(world, "c.md", "ritual", "# C\n");
    s = inContext(join(root, "sessions"), world);
    expect(hints().filter((h) => !h.startsWith("locations/"))).toEqual([]);
  });

  test("the link back must carry the same relation, and an unsaved edit counts", () => {
    smallDreamwood(world);
    s = inContext(join(root, "sessions"), world);
    const { slug } = s.openPath(join(world, "locations", "the-glade.md"));
    // A link back, but not a contrast: still a hint.
    s.edit(slug, 1, "---\ntype: location\n---\n# The Glade\n\n[the Ruin](./the-ruin.md)\n");
    expect(s.linkCheck().symmetry.count).toBe(2);
    // The contrast written back to the Ruin: only the Cave's is left.
    s.edit(
      slug,
      1,
      "---\ntype: location\n---\n# The Glade\n\n[the Ruin](./the-ruin.md?rel=contrasts-with)\n",
    );
    expect(hints()).toEqual(["locations/the-cave.md:6 contrasts-with → locations/the-glade.md"]);
  });

  test("symmetry comes from the vocabulary, nearest file winning", () => {
    smallDreamwood(world);
    // Beneath locations/, contrasts-with is declared one-way: no hints there.
    writeVocabulary(join(world, "locations"), {
      relations: { "contrasts-with": { label: "contrasts with", inverse: "contrasted by" } },
    });
    s = inContext(join(root, "sessions"), world);
    expect(s.linkCheck().symmetry.count).toBe(0);
  });

  test("symmetric only in a vocabulary nested on the writing side: no hint, since the target's world does not read it both ways", () => {
    smallDreamwood(world);
    // The world's root declares `echoes` nowhere; locations/ declares it symmetric.
    writeVocabulary(join(world, "locations"), {
      relations: { echoes: { label: "echoes", symmetric: true } },
    });
    writeDoc(
      world,
      "locations/the-crossing.md",
      "location",
      "# The Crossing\n\n[the cave](./the-cave.md?rel=echoes) [cosmology](../03-cosmology.md?rel=echoes)\n",
    );
    s = inContext(join(root, "sessions"), world);
    const echoes = s.linkCheck().symmetry.hints.filter((h) => h.rel === "echoes");
    // Into the Cave (same nested vocabulary): a hint. Into the cosmology, at the
    // root where `echoes` is undeclared: none.
    expect(echoes.map((h) => h.targetShown)).toEqual(["locations/the-cave.md"]);
  });

  test("a world with no _relations.json has no hints", () => {
    smallDreamwood(world, false);
    s = inContext(join(root, "sessions"), world);
    expect(s.linkCheck().symmetry).toEqual({ count: 0, hints: [] });
  });

  test("a broken vocabulary declares nothing symmetric", () => {
    smallDreamwood(world);
    writeVocabulary(world, `${JSON.stringify(VOCABULARY)},`);
    s = inContext(join(root, "sessions"), world);
    expect(s.linkCheck().symmetry.count).toBe(0);
  });
});
