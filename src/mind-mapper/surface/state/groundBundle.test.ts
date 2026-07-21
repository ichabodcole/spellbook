// R4 Claim G1 — the send-time ground bundle: selection ∪ open doc, the
// ratified open-doc-is-rail-selection mapping. Pure-logic tests; App's
// onSend is a one-line call into this module.

import { expect, test } from "bun:test";
import { groundBundle } from "./groundBundle";

test("nothing selected, no doc open → empty (caller omits ground)", () => {
  expect(groundBundle([], null)).toEqual([]);
});

test("nodes-only: bare ids ride through in selection order", () => {
  expect(groundBundle(["maren", "prop-1"], null)).toEqual(["maren", "prop-1"]);
});

test("doc-only: the open doc grounds the message as doc:<id>", () => {
  expect(groundBundle([], "field-notes")).toEqual(["doc:field-notes"]);
});

test("union: selection first (order preserved), doc ref last", () => {
  expect(groundBundle(["b", "a"], "field-notes")).toEqual(["b", "a", "doc:field-notes"]);
});

test("repeated selection ids dedupe, first occurrence wins", () => {
  expect(groundBundle(["a", "b", "a"], null)).toEqual(["a", "b"]);
});

test("null openDocId mints no doc ref", () => {
  expect(groundBundle(["a"], null)).toEqual(["a"]);
});
