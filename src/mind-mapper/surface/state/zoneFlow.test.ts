// Pure-logic tests for the zone-delete 409 parse (Z1) — the same
// strict-on-load-bearing / null-on-anything-else contract deleteFlow pins.

import { expect, test } from "bun:test";
import { parseZoneNotEmptyBody } from "./zoneFlow";

test("a well-formed zone-not-empty 409 body parses to its count", () => {
  expect(parseZoneNotEmptyBody({ error: "zone-not-empty", proposals: 3 })).toEqual({
    proposals: 3,
  });
});

test("a different error shape is null (caller degrades to the generic notice)", () => {
  expect(parseZoneNotEmptyBody({ error: "cited", citedBy: { nodes: 1, proposals: 0 } })).toBeNull();
  expect(parseZoneNotEmptyBody({ error: "zone-not-empty", proposals: "3" })).toBeNull();
  expect(parseZoneNotEmptyBody({ error: "zone-not-empty" })).toBeNull();
});

test("non-object bodies are null, never a throw", () => {
  expect(parseZoneNotEmptyBody(null)).toBeNull();
  expect(parseZoneNotEmptyBody(undefined)).toBeNull();
  expect(parseZoneNotEmptyBody("zone-not-empty")).toBeNull();
});
