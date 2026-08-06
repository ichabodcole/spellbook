// Pure-logic test for intake's title derivation — the only DOM-free piece.
// ingestFiles/ingestText/ingestBlank touch FileReader/fetch and are
// exercised live once POST /ingest exists server-side (same split as
// imago's fileIntake.test.ts: pure geometry/parsing tested, DOM glue live).

import { expect, test } from "bun:test";
import { titleFromFilename } from "./intake";

test("strips a markdown extension", () => {
  expect(titleFromFilename("hollowbrook-bible.md")).toBe("hollowbrook bible");
});

test("collapses dashes and underscores into spaces", () => {
  expect(titleFromFilename("ramble_01-draft.txt")).toBe("ramble 01 draft");
});

test("a filename with no extension is left as-is (minus separators)", () => {
  expect(titleFromFilename("notes")).toBe("notes");
});

test("a dotfile-like name with no real extension keeps its leading content", () => {
  expect(titleFromFilename("v2.final.md")).toBe("v2.final");
});
