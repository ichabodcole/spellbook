// Round 6 (RB) — ratify-batch: ratify a node+edge set in one call/one txn,
// returning the old→new id map; auto-partition nodes-before-edges; NO
// auto-include of unlisted edges; anchors[] ratify-then-anchor; reject
// excluded; atomicity (a throwing batch leaves zero rows/events/changelog).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { ratify, ratifyBatch } from "./ratify.ts";
import { readState } from "./state.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-ratify-batch-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}
const meta = { id: "default", title: "Default" };

test("ratify-batch ratifies nodes then edges in one call, edge resolves via idMap", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = proposeNode(db, bus, { draft: { title: "A" }, evidence: {} });
    const b = proposeNode(db, bus, { draft: { title: "B" }, evidence: {} });
    // Edge draft references the PROPOSAL ids (pre-ratify) — the RB use case.
    const e = proposeEdge(db, bus, {
      draft: { source: a.id, target: b.id, label: "rel" },
      evidence: {},
    });
    // Caller order deliberately edge-first — the engine auto-partitions.
    const result = ratifyBatch(db, bus, docsDir, {
      ruling: "canon",
      ids: [e.id, a.id, b.id],
    });
    expect(result.idMap[a.id]).toBeDefined();
    expect(result.idMap[b.id]).toBeDefined();
    expect(result.ratified).toHaveLength(3);

    const state = readState(db, meta);
    expect(state.proposals.every((p) => p.status === "ratified")).toBe(true);
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    // The edge's endpoints resolved to the minted node ids, not proposal ids.
    expect(state.edges[0]).toMatchObject({
      source: result.idMap[a.id],
      target: result.idMap[b.id],
      label: "rel",
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify-batch does NOT auto-include an unlisted edge", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = proposeNode(db, bus, { draft: { title: "A" }, evidence: {} });
    const b = proposeNode(db, bus, { draft: { title: "B" }, evidence: {} });
    const e = proposeEdge(db, bus, {
      draft: { source: a.id, target: b.id, label: "rel" },
      evidence: {},
    });
    ratifyBatch(db, bus, docsDir, { ruling: "canon", ids: [a.id, b.id] });
    const state = readState(db, meta);
    // Only the two listed node proposals ratified; the edge stays pending.
    expect(state.edges).toHaveLength(0);
    expect(state.proposals.find((p) => p.id === e.id)?.status).toBe("pending");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify-batch anchors[] ratifies then nests the child under the parent", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const parent = proposeNode(db, bus, { draft: { title: "Parent" }, evidence: {} });
    const child = proposeNode(db, bus, { draft: { title: "Child" }, evidence: {} });
    const received: Array<{ kind: string }> = [];
    bus.subscribe(bus.cursor(), (ev) => received.push(ev as never));
    const result = ratifyBatch(db, bus, docsDir, {
      ruling: "canon",
      ids: [parent.id, child.id],
      anchors: [{ node: child.id, parent: parent.id }],
    });
    const state = readState(db, meta);
    const childNode = state.nodes.find((n) => n.id === result.idMap[child.id]);
    const parentNode = state.nodes.find((n) => n.id === result.idMap[parent.id]);
    expect(childNode?.anchorNodeId).toBe(result.idMap[parent.id]);
    expect(parentNode?.submapChildCount).toBe(1);
    expect(received.some((e) => e.kind === "node.anchored")).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify-batch anchors under an already-ratified real node", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const parentProposal = proposeNode(db, bus, { draft: { title: "Parent" }, evidence: {} });
    const { nodeId: parentId } = ratify(db, bus, docsDir, {
      proposalId: parentProposal.id,
      ruling: "canon",
    });
    const child = proposeNode(db, bus, { draft: { title: "Child" }, evidence: {} });
    const result = ratifyBatch(db, bus, docsDir, {
      ruling: "canon",
      ids: [child.id],
      anchors: [{ node: child.id, parent: parentId as string }],
    });
    const state = readState(db, meta);
    const childNode = state.nodes.find((n) => n.id === result.idMap[child.id]);
    expect(childNode?.anchorNodeId).toBe(parentId);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify-batch refuses a reject ruling (reject excludes from the batch)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = proposeNode(db, bus, { draft: { title: "A" }, evidence: {} });
    expect(() => ratifyBatch(db, bus, docsDir, { ruling: "reject", ids: [a.id] })).toThrow(
      /does not reject/,
    );
    expect(readState(db, meta).proposals[0]?.status).toBe("pending");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing batch leaves zero rows, zero events, zero changelog lines (atomicity)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const a = proposeNode(db, bus, { draft: { title: "A" }, evidence: {} });
    const b = proposeNode(db, bus, { draft: { title: "B" }, evidence: {} });
    const received: unknown[] = [];
    bus.subscribe(bus.cursor(), (ev) => received.push(ev));
    // A cycle among the batched anchors throws INSIDE the txn (after the node
    // inserts run) — the strongest atomicity case: it must roll back.
    expect(() =>
      ratifyBatch(db, bus, docsDir, {
        ruling: "canon",
        ids: [a.id, b.id],
        anchors: [
          { node: a.id, parent: b.id },
          { node: b.id, parent: a.id },
        ],
      }),
    ).toThrow();
    const state = readState(db, meta);
    expect(state.nodes).toEqual([]);
    expect(state.proposals.every((p) => p.status === "pending")).toBe(true);
    expect(received).toEqual([]);
    expect(existsSync(join(docsDir, "..", "changelog.txt"))).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
