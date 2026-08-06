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

// R11 SEAM 4 — the zone carry (a canvas ramble made on a zone board).

test("a zone rides last, after the doc ref", () => {
  expect(groundBundle(["a"], "field-notes", "sandbox")).toEqual([
    "a",
    "doc:field-notes",
    "zone:sandbox",
  ]);
});

test("the main board (null zone) mints no zone ref — today's shape, unchanged", () => {
  expect(groundBundle(["a"], null, null)).toEqual(["a"]);
  expect(groundBundle(["a"], null)).toEqual(["a"]);
});

test("a zone alone grounds the message", () => {
  expect(groundBundle([], null, "sandbox")).toEqual(["zone:sandbox"]);
});
