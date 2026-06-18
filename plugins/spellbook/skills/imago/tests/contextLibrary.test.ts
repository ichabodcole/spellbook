import { expect, test } from "bun:test";
import { entriesByKind, isLinked, resolveSet } from "../surface/state/contextLibrary";
import type { ContextEntry } from "../surface/state/types";

const lib: ContextEntry[] = [
  { id: "p1", kind: "prompt", name: "a", content: "" },
  { id: "s1", kind: "style", name: "b", content: "" },
  { id: "p2", kind: "prompt", name: "c", content: "" },
];

test("resolveSet maps ids → entries in set order, skipping missing ids", () => {
  expect(resolveSet(lib, ["p2", "missing", "p1"]).map((e) => e.id)).toEqual(["p2", "p1"]);
});

test("entriesByKind filters by kind, preserving library order", () => {
  expect(entriesByKind(lib, "prompt").map((e) => e.id)).toEqual(["p1", "p2"]);
});

test("isLinked reports membership", () => {
  expect(isLinked(["p1"], "p1")).toBe(true);
  expect(isLinked(["p1"], "p2")).toBe(false);
});
