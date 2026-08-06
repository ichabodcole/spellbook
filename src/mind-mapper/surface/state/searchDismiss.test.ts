// Pure-logic tests for the R5 Escape-dismiss guard.

import { expect, test } from "bun:test";
import { shouldDismissSearch } from "./searchDismiss";

test("Escape while the search input is focused always dismisses", () => {
  expect(shouldDismissSearch("INPUT", true, false)).toBe(true);
  expect(shouldDismissSearch("INPUT", true, true)).toBe(true);
});

test("Escape while typing in another field is left to that field", () => {
  expect(shouldDismissSearch("INPUT", false, true)).toBe(false);
  expect(shouldDismissSearch("TEXTAREA", false, true)).toBe(false);
});

test("Escape with focus on the board dismisses a lingering query", () => {
  expect(shouldDismissSearch("DIV", false, true)).toBe(true);
  expect(shouldDismissSearch(null, false, true)).toBe(true);
});

test("Escape with focus on the board and no query is a no-op", () => {
  expect(shouldDismissSearch("DIV", false, false)).toBe(false);
  expect(shouldDismissSearch(null, false, false)).toBe(false);
});
