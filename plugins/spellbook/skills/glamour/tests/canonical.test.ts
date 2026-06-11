// tests/canonical.test.ts
import { expect, test } from "bun:test";
import { applyCanonical } from "../scripts/server";
import type { Variant } from "../surface/state/types";

const mk = (id: string, canonical = false): Variant => ({
  id,
  src: "",
  prompt: "",
  label: "",
  round: 1,
  liked: false,
  canonical,
});

test("applyCanonical makes exactly one variant canonical", () => {
  const vs = [mk("a", true), mk("b"), mk("c")];
  applyCanonical(vs, "b", true);
  expect(vs.map((v) => v.canonical)).toEqual([false, true, false]);
});

test("applyCanonical can clear the canonical flag", () => {
  const vs = [mk("a"), mk("b", true)];
  applyCanonical(vs, "b", false);
  expect(vs.every((v) => !v.canonical)).toBe(true);
});

test("applyCanonical ignores an unknown id", () => {
  const vs = [mk("a", true)];
  applyCanonical(vs, "zzz", true);
  expect(vs[0].canonical).toBe(true);
});
