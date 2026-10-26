// The world's use of each relation between kinds, folded for one source kind:
// what the link picker ranks by, and what Atlas ranks a board connection by.
import { describe, expect, test } from "bun:test";
import { parseRel } from "./linkTarget.ts";
import { countPair, type KindPairUse, kindUseFrom, normaliseRelation } from "./relationUse.ts";

describe("kindUseFrom", () => {
  const pairs = (() => {
    const m = new Map<string, KindPairUse>();
    countPair(m, "location", "location", "contrasts-with");
    countPair(m, "location", "location", "contrasts-with");
    countPair(m, "ritual", "reference", "sourced-from");
    countPair(m, "location", "reference", "sourced-from");
    countPair(m, null, "reference", "sourced-from");
    return [...m.values()];
  })();

  test("counts each (from, to, relation) once, a document of no kind apart", () => {
    expect(pairs).toEqual([
      { from: "location", kind: "location", rel: "contrasts-with", links: 2 },
      { from: "ritual", kind: "reference", rel: "sourced-from", links: 1 },
      { from: "location", kind: "reference", rel: "sourced-from", links: 1 },
      { from: null, kind: "reference", rel: "sourced-from", links: 1 },
    ]);
  });

  test("folds every link into each kind, and those from the given kind", () => {
    expect(kindUseFrom(pairs, "ritual")).toEqual([
      { kind: "location", rel: "contrasts-with", links: 2, fromKind: 0 },
      { kind: "reference", rel: "sourced-from", links: 3, fromKind: 1 },
    ]);
    expect(kindUseFrom(pairs, "location")).toEqual([
      { kind: "location", rel: "contrasts-with", links: 2, fromKind: 2 },
      { kind: "reference", rel: "sourced-from", links: 3, fromKind: 1 },
    ]);
  });

  test("from no kind, nothing is from it", () => {
    expect(kindUseFrom(pairs, null).every((u) => u.fromKind === 0)).toBe(true);
  });
});

describe("normaliseRelation", () => {
  test("keeps the case and the marks typed, so what it writes `parseRel` reads, folded", () => {
    expect(normaliseRelation("İlgili")).toBe("İlgili");
    expect(normaliseRelation("Grounded In")).toBe("Grounded-In");
    expect(normaliseRelation("i\u0307lgili")).toBe("i\u0307lgili");
    expect(normaliseRelation("\u0307-x")).toBe("x");
    for (const typed of ["İlgili", "Über alles", "Αναφέρεται σε", "contrasts with"])
      expect(parseRel(`rel=${normaliseRelation(typed)}`)).toEqual([
        normaliseRelation(typed).toLowerCase(),
      ]);
  });
});
