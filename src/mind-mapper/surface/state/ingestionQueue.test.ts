// Pure-logic tests for the R6 ingestion-tray derive.

import { expect, test } from "bun:test";
import type { Proposal } from "../types";
import { processingItems } from "./ingestionQueue";

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    kind: "node",
    draft: { title: id },
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "user",
    zoneId: null,
    ...over,
  };
}

const proposals = [
  proposal("raw-1"),
  proposal("raw-2"),
  proposal("agent-sketch", { author: "agent" }),
  proposal("already-curated", { status: "ratified" }),
  proposal("withdrawn", { status: "rejected" }),
];

test("keeps only pending author:user proposals — the raw items being curated", () => {
  expect(processingItems(proposals).map((p) => p.id)).toEqual(["raw-1", "raw-2"]);
});

test("an item leaves once it ratifies (status off pending)", () => {
  const after = processingItems(
    proposals.map((p) => (p.id === "raw-1" ? { ...p, status: "ratified" as const } : p)),
  );
  expect(after.map((p) => p.id)).toEqual(["raw-2"]);
});

test("agent proposals are never in the ingestion tray (they're not raw human input)", () => {
  expect(processingItems([proposal("a", { author: "agent" })])).toEqual([]);
});

test("a zoned raw item still counts (the tray is decoupled from the canvas view)", () => {
  const zoned = [proposal("z", { zoneId: "wild-ideas" })];
  expect(processingItems(zoned).map((p) => p.id)).toEqual(["z"]);
});

test("empty in → empty out", () => {
  expect(processingItems([])).toEqual([]);
});
