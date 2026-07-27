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
