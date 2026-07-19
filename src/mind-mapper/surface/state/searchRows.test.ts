// Pure-logic tests for the S1 palette row resolution — hit kinds must
// survive the memo, proposal hits resolve to the pending synthetic nodes
// (proposal id IS node id), off-board kinds count instead of vanishing.

import { expect, test } from "bun:test";
import type { MapNode, SearchHit } from "../types";
import { paletteRows } from "./searchRows";

const maren: MapNode = { id: "maren", title: "Maren", kind: "cast", tier: "canon", synopsis: "" };
const pendingToll: MapNode = {
  id: "prop-1",
  title: "The story-toll",
  kind: "concept",
  tier: "thread",
  synopsis: "Paid in untold stories.",
  pending: true,
};

function hit(overrides: Partial<SearchHit>): SearchHit {
  return { kind: "node", id: "maren", title: "Maren", score: 20, ...overrides };
}

test("node and proposal hits resolve to rows in server rank order, kinds intact", () => {
  const { rows } = paletteRows(
    [hit({}), hit({ kind: "proposal", id: "prop-1", title: "The story-toll", score: 18 })],
    [maren],
    [pendingToll],
  );
  expect(rows.map((r) => r.kind)).toEqual(["node", "proposal"]);
  expect(rows[1]?.node).toEqual(pendingToll);
});

test("a proposal hit carries its zone tag; a node row's zoneId is always null", () => {
  const { rows } = paletteRows(
    [hit({}), hit({ kind: "proposal", id: "prop-1", zoneId: "wild-ideas", score: 18 })],
    [maren],
    [pendingToll],
  );
  expect(rows[0]?.zoneId).toBeNull();
  expect(rows[1]?.zoneId).toBe("wild-ideas");
});

test("a proposal hit with no zoneId on the wire normalizes to null (main queue)", () => {
  const { rows } = paletteRows([hit({ kind: "proposal", id: "prop-1" })], [], [pendingToll]);
  expect(rows[0]?.zoneId).toBeNull();
});

test("doc and message hits count as off-board instead of becoming rows", () => {
  const { rows, offBoard } = paletteRows(
    [
      hit({ kind: "doc", id: "ramble-01", title: "R1", score: 3 }),
      hit({ kind: "message", id: "m-1", title: "said once", score: 2 }),
      hit({ kind: "message", id: "m-2", title: "said again", score: 1 }),
    ],
    [maren],
    [],
  );
  expect(rows).toEqual([]);
  expect(offBoard).toEqual({ docs: 1, messages: 2 });
});

test("unresolvable hits drop silently (stale node id, edge proposal, unknown future kind)", () => {
  const { rows, offBoard } = paletteRows(
    [
      hit({ id: "gone" }),
      hit({ kind: "proposal", id: "edge-prop" }),
      hit({ kind: "vector" as SearchHit["kind"], id: "v1" }),
    ],
    [maren],
    [pendingToll],
  );
  expect(rows).toEqual([]);
  expect(offBoard).toEqual({ docs: 0, messages: 0 });
});
