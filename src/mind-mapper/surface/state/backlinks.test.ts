// BACKLINKS (finding #6) — pure derive: which nodes/proposals reference a doc.

import { expect, test } from "bun:test";
import type { MapNode, Proposal } from "../types";
import { backlinksFor } from "./backlinks";

function node(id: string, docIds: string[]): MapNode {
  return {
    id,
    title: id,
    kind: "concept",
    tier: "thread",
    synopsis: "",
    sources: docIds.map((docId) => ({ docId, span: null })),
  };
}

function proposal(overrides: Partial<Proposal> & { id: string }): Proposal {
  return {
    kind: "node",
    draft: { title: "Draft" },
    evidence: { docId: null, messageId: null, span: null },
    suggestedTier: "thread",
    status: "pending",
    author: "agent",
    zoneId: null,
    ...overrides,
  };
}

test("ratified backlinks are nodes whose sources cite the doc", () => {
  const nodes = [node("a", ["ramble-01"]), node("b", ["ramble-02"]), node("c", ["ramble-01"])];
  const { ratified } = backlinksFor("ramble-01", nodes, []);
  expect(ratified.map((r) => r.id).sort()).toEqual(["a", "c"]);
  expect(ratified[0]?.title).toBe("a");
});

test("a message-sourced node does NOT count as a doc backlink", () => {
  const nodes: MapNode[] = [
    {
      id: "m",
      title: "m",
      kind: "concept",
      tier: "thread",
      synopsis: "",
      sources: [{ messageId: "msg-1", span: null }],
    },
  ];
  expect(backlinksFor("ramble-01", nodes, []).ratified).toEqual([]);
});

test("pending backlinks are pending proposals whose evidence cites the doc", () => {
  const proposals = [
    proposal({
      id: "p1",
      evidence: { docId: "ramble-01", messageId: null, span: null },
      draft: { title: "The Hollow" },
    }),
    proposal({ id: "p2", evidence: { docId: "ramble-02", messageId: null, span: null } }),
  ];
  const { pending } = backlinksFor("ramble-01", [], proposals);
  expect(pending).toEqual([{ id: "p1", title: "The Hollow" }]);
});

test("ratified/rejected proposals never count on the proposal side (node or gone)", () => {
  const proposals = [
    proposal({
      id: "done",
      status: "ratified",
      evidence: { docId: "ramble-01", messageId: null, span: null },
    }),
    proposal({
      id: "gone",
      status: "rejected",
      evidence: { docId: "ramble-01", messageId: null, span: null },
    }),
  ];
  expect(backlinksFor("ramble-01", [], proposals).pending).toEqual([]);
});

test("a titleless draft falls back to (untitled)", () => {
  const proposals = [
    proposal({ id: "p", draft: {}, evidence: { docId: "ramble-01", messageId: null, span: null } }),
  ];
  expect(backlinksFor("ramble-01", [], proposals).pending[0]?.title).toBe("(untitled)");
});

test("ratified and pending are kept distinct", () => {
  const nodes = [node("a", ["ramble-01"])];
  const proposals = [
    proposal({ id: "p", evidence: { docId: "ramble-01", messageId: null, span: null } }),
  ];
  const bl = backlinksFor("ramble-01", nodes, proposals);
  expect(bl.ratified.map((r) => r.id)).toEqual(["a"]);
  expect(bl.pending.map((r) => r.id)).toEqual(["p"]);
});

test("no citations → both empty", () => {
  expect(backlinksFor("orphan", [node("a", ["ramble-01"])], [])).toEqual({
    ratified: [],
    pending: [],
  });
});
