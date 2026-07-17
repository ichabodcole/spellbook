// P2 — propose-node/propose-edge insert a pending proposal row and emit
// proposal.added. The draft is opaque JSON to the daemon (Claim A: it
// doesn't validate the agent's extraction, only stores it).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-propose-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("proposeNode round-trips a node draft + evidence verbatim", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda", tier: "thread", synopsis: "keeps the mill" },
      evidence: { docId: "ramble-01", span: "Edda keeps the mill" },
    });
    expect(proposal.status).toBe("pending");
    expect(proposal.draft).toEqual({ title: "Edda", tier: "thread", synopsis: "keeps the mill" });
    expect(proposal.evidence).toEqual({ docId: "ramble-01", span: "Edda keeps the mill" });

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals).toEqual([proposal]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposeEdge round-trips an edge draft + evidence verbatim", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const proposal = proposeEdge(db, bus, {
      draft: { source: "maren", target: "edda", label: "rivals with", provenance: "asserted" },
      evidence: { docId: "bible-maren" },
    });
    expect(proposal.kind).toBe("edge");
    expect(proposal.evidence).toEqual({ docId: "bible-maren", span: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("proposeNode emits a proposal.added patch, not the whole proposals array", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (event) => received.push(event));
    const proposal = proposeNode(db, bus, { draft: { title: "Tam" }, evidence: {} });
    expect(received).toEqual([
      { seq: 1, epoch: bus.epoch, kind: "proposal.added", payload: proposal },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
