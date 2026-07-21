// R4 K1 — pure-logic tests for the doc-kind rendering vocabulary.

import { expect, test } from "bun:test";
import {
  KIND_BADGE,
  kindAuthorClass,
  kindAuthorTitle,
  kindBadgeClass,
  NEUTRAL_BADGE,
} from "./docKind";

test("null kind renders NO badge — absence, not an 'unclassified' chip", () => {
  expect(kindBadgeClass(null)).toBeNull();
});

test("the house kinds keep their tier-vocabulary tints", () => {
  expect(kindBadgeClass("ramble")).toBe(KIND_BADGE.ramble as string);
  expect(kindBadgeClass("story")).toBe(KIND_BADGE.story as string);
  expect(kindBadgeClass("bible")).toBe(KIND_BADGE.bible as string);
});

test("an unknown asserted kind gets the neutral plate, never a crash", () => {
  expect(kindBadgeClass("field-notes")).toBe(NEUTRAL_BADGE);
});

test("author styling: user solid, agent dashed, null honestly unmarked", () => {
  expect(kindAuthorClass("user")).toContain("border");
  expect(kindAuthorClass("user")).not.toContain("dashed");
  expect(kindAuthorClass("agent")).toContain("border-dashed");
  expect(kindAuthorClass(null)).toBe("");
});

test("author titles say who; null carries no claim", () => {
  expect(kindAuthorTitle("user")).toContain("you");
  expect(kindAuthorTitle("agent")).toContain("agent");
  expect(kindAuthorTitle(null)).toBeUndefined();
});
