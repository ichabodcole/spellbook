// Round 12 (SEAM 5) — delete-batch: the inverse of ratify-batch. Transactional
// all-or-nothing, mirroring ratifyBatch's atomicity contract.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { deleteProposalBatch } from "./del.ts";
import { type BusEvent, createEventBus } from "./events.ts";
import { batchPropose } from "./propose.ts";
import { ratifyBatch } from "./ratify.ts";
import { readState } from "./state.ts";

const PROJECT = { id: "default", title: "Default" };

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-delbatch-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("delete-batch clears a set in ONE call and emits one proposal.deleted per id", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const { proposals } = batchPropose(db, bus, {
      nodes: [
        { ref: "a", draft: { title: "A" }, tags: ["x"] },
        { ref: "b", draft: { title: "B" } },
        { ref: "c", draft: { title: "C" } },
      ],
    });
    const ids = proposals.map((p) => p.id);
    const seen: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => seen.push(e));

    const result = deleteProposalBatch(db, bus, ids.slice(0, 2));
    expect(result.deleted).toEqual(ids.slice(0, 2));
    expect(seen.map((e) => e.kind)).toEqual(["proposal.deleted", "proposal.deleted"]);
    expect(readState(db, PROJECT).proposals.map((p) => p.id)).toEqual([ids[2] as string]);
    // Target-keyed detritus cascades exactly as the single delete does.
    expect(db.query("SELECT COUNT(*) AS n FROM node_tags").get()).toEqual({ n: 0 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ONE unknown id deletes NOTHING and the error names EVERY unknown id", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const { proposals } = batchPropose(db, bus, {
      nodes: [{ ref: "a", draft: { title: "A" } }],
    });
    const seen: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => seen.push(e));
    let message = "";
    try {
      deleteProposalBatch(db, bus, [proposals[0]?.id as string, "ghost-1", "ghost-2"]);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    // A 44-id cleanup must never become a 44-round-trip bisect.
    expect(message).toContain("ghost-1");
    expect(message).toContain("ghost-2");
    expect(message).toContain("nothing was deleted");
    // Atomic: zero rows gone, zero events leaked.
    expect(readState(db, PROJECT).proposals).toHaveLength(1);
    expect(seen).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty or ill-shaped ids list is a named intake error", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(() => deleteProposalBatch(db, bus, [])).toThrow(/non-empty ids array/);
    expect(() => deleteProposalBatch(db, bus, [7 as unknown as string])).toThrow(
      /non-empty strings/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("duplicate ids collapse — one delete, one event", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const { proposals } = batchPropose(db, bus, { nodes: [{ ref: "a", draft: { title: "A" } }] });
    const id = proposals[0]?.id as string;
    const seen: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => seen.push(e));
    expect(deleteProposalBatch(db, bus, [id, id]).deleted).toEqual([id]);
    expect(seen).toHaveLength(1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R12 GATE FINDING 1 — the stranded-node advisory.
//
// cassandra's cold gate reproduced drive #10 exactly: batch nodes+edges, ratify
// only the NODES, then sweep the pending edges. delete-batch removed the last
// connection intent for four ratified canon nodes with exit 0 and said nothing.
// These tests pin the advisory that makes the sweep self-correcting. It is
// ADVISORY, never a refusal — the delete still happens (Contract 8: dumb daemon).
// ---------------------------------------------------------------------------

test("delete-batch WARNS when it strands a ratified node (the drive-#10 shape)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    // The exact drive-#10 setup: two nodes and the edge between them.
    const { refToId, proposals } = batchPropose(db, bus, {
      nodes: [
        { ref: "a", draft: { title: "Rich Ruth" } },
        { ref: "b", draft: { title: "Fourth world" } },
      ],
      edges: [{ draft: { source: "a", target: "b", label: "works in" } }],
    });
    const nodeProposalIds = [refToId.a as string, refToId.b as string];
    const edgeProposalId = proposals.find((p) => p.kind === "edge")?.id as string;

    // The human ratifies ONLY the nodes — the edge stays pending.
    ratifyBatch(db, bus, join(dir, "docs"), { ruling: "canon", ids: nodeProposalIds });

    // Now the agent sweeps its "stale" pending proposals. This is the bug.
    const result = deleteProposalBatch(db, bus, [edgeProposalId]);

    expect(result.deleted).toEqual([edgeProposalId]);
    // The delete STILL HAPPENED — advisory, not a refusal.
    expect(readState(db, PROJECT).proposals.some((p) => p.id === edgeProposalId)).toBe(false);
    // ...and it named both stranded nodes, by title, so the agent can repair.
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("Rich Ruth");
    expect(result.warning).toContain("Fourth world");
    expect(result.warning).toContain("2 ratified node(s)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete-batch is SILENT when connection intent survives (no crying wolf)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const { refToId, proposals } = batchPropose(db, bus, {
      nodes: [
        { ref: "a", draft: { title: "A" } },
        { ref: "b", draft: { title: "B" } },
      ],
      edges: [
        { draft: { source: "a", target: "b", label: "one" } },
        { draft: { source: "a", target: "b", label: "two" } },
      ],
    });
    ratifyBatch(db, bus, join(dir, "docs"), {
      ruling: "canon",
      ids: [refToId.a as string, refToId.b as string],
    });
    const edgeIds = proposals.filter((p) => p.kind === "edge").map((p) => p.id);

    // Delete ONE of the two pending edges — intent survives, so no warning.
    const result = deleteProposalBatch(db, bus, [edgeIds[0] as string]);
    expect(result.warning).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete-batch is SILENT for an unratified endpoint — nothing canon to strand", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    // Nobody ratifies anything: the endpoints are still pending proposals.
    const { proposals } = batchPropose(db, bus, {
      nodes: [
        { ref: "a", draft: { title: "A" } },
        { ref: "b", draft: { title: "B" } },
      ],
      edges: [{ draft: { source: "a", target: "b" } }],
    });
    const edgeId = proposals.find((p) => p.kind === "edge")?.id as string;
    const result = deleteProposalBatch(db, bus, [edgeId]);
    expect(result.warning).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("delete-batch is SILENT when the node already has a REAL edge", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const { refToId, proposals } = batchPropose(db, bus, {
      nodes: [
        { ref: "a", draft: { title: "A" } },
        { ref: "b", draft: { title: "B" } },
      ],
      edges: [{ draft: { source: "a", target: "b", label: "real" } }],
    });
    const edgeProposalId = proposals.find((p) => p.kind === "edge")?.id as string;
    // Ratify the WHOLE batch — the edge becomes a real edge.
    ratifyBatch(db, bus, join(dir, "docs"), {
      ruling: "canon",
      ids: [refToId.a as string, refToId.b as string, edgeProposalId],
    });
    // A second, still-pending edge proposal that we then delete.
    const { proposals: more } = batchPropose(db, bus, {
      edges: [{ draft: { source: refToId.a as string, target: refToId.b as string } }],
    });
    const result = deleteProposalBatch(db, bus, [more[0]?.id as string]);
    // The nodes are genuinely connected by a real edge — nothing is stranded.
    expect(result.warning).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
