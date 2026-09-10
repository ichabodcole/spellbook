// Round 4 (A1) — action slots: target-keyed agent affordances on nodes and
// PENDING proposals; the lifecycle rides the target's owners (ratify
// re-homes, reject/zone-delete clean up, promote is a no-op).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS_BYTE_CAP, clearActions, readActions, setActions } from "./actions.ts";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { ratify } from "./ratify.ts";
import { readState } from "./state.ts";
import { createZone, deleteZone, promote } from "./zones.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-actions-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}

const SLOT = { id: "jungian", label: "Explore Jungian archetypes", seed: "Explore — " };

test("setActions on a node: wholesale upsert, actions ride state.nodes[], event carries the full array", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(0, (e) => received.push(e as unknown as Record<string, unknown>));

    const result = setActions(db, bus, "n1", [SLOT]);
    expect(result).toEqual({ targetId: "n1", actions: [SLOT] });
    expect(received).toEqual([
      {
        seq: 1,
        epoch: bus.epoch,
        kind: "actions.set",
        payload: { targetId: "n1", actions: [SLOT] },
      },
    ]);

    // Wholesale replace, not merge.
    const second = { id: "v2", label: "v2", seed: "v2 — " };
    setActions(db, bus, "n1", [second]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes[0]?.actions).toEqual([second]);
    // A node without slots carries NO actions key (absent = none).
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n2', 'cast', 'canon', 'Edda', '')",
    );
    const state2 = readState(db, { id: "default", title: "Default" });
    expect("actions" in (state2.nodes.find((n) => n.id === "n2") ?? {})).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setActions targets a PENDING proposal; unknown / ratified / rejected targets are null (404)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    writeFileSync(join(docsDir, "ramble-01.md"), "prose");
    db.run(
      "INSERT INTO docs (id, title, kind, path) VALUES ('ramble-01', 'R', '', 'docs/ramble-01.md')",
    );
    const pending = proposeNode(db, bus, { draft: { title: "P" }, evidence: {} });
    expect(setActions(db, bus, pending.id, [SLOT])?.actions).toEqual([SLOT]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.find((p) => p.id === pending.id)?.actions).toEqual([SLOT]);

    expect(setActions(db, bus, "no-such-target", [SLOT])).toBeNull();

    const rejected = proposeNode(db, bus, { draft: { title: "R" }, evidence: {} });
    ratify(db, bus, docsDir, { proposalId: rejected.id, ruling: "reject" });
    expect(setActions(db, bus, rejected.id, [SLOT])).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shape validation fails loud; soft cap warns past 4; byte cap hard-errors", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    expect(() => setActions(db, bus, "n1", { not: "an array" })).toThrow(/array/);
    expect(() => setActions(db, bus, "n1", ["nope"])).toThrow(/not an object/);
    expect(() => setActions(db, bus, "n1", [{ id: "x", label: "y" }])).toThrow(
      /string id\/label\/seed/,
    );

    const five = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `L${i}`, seed: "s" }));
    const result = setActions(db, bus, "n1", five);
    expect(result?.actions).toHaveLength(5); // stored in full — the cap is advisory
    expect(result?.warning).toContain("5 actions");

    const fat = [{ id: "fat", label: "fat", seed: "x".repeat(ACTIONS_BYTE_CAP) }];
    expect(() => setActions(db, bus, "n1", fat)).toThrow(/byte cap|byte-cap|-byte cap/);
    // The oversized write landed nothing — the previous slots survive.
    expect(readActions(db).get("n1")).toHaveLength(5);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty array and clearActions both delete the row and emit actions.set []", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    setActions(db, bus, "n1", [SLOT]);
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as unknown as Record<string, unknown>));

    expect(setActions(db, bus, "n1", [])).toEqual({ targetId: "n1", actions: [] });
    expect(readActions(db).size).toBe(0);
    expect(received[0]).toMatchObject({
      kind: "actions.set",
      payload: { targetId: "n1", actions: [] },
    });

    setActions(db, bus, "n1", [SLOT]);
    expect(clearActions(db, bus, "n1")).toEqual({ targetId: "n1", actions: [] });
    expect(readActions(db).size).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle: ratify re-homes slots onto the minted node; reject deletes; promote is a no-op", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    const pending = proposeNode(db, bus, { draft: { title: "Edda" }, evidence: {} });
    setActions(db, bus, pending.id, [SLOT]);

    // Promote path first: a zoned proposal keeps its slots across the move
    // (the row keys by proposal id, which survives).
    createZone(db, bus, "Messy");
    const zoned = proposeNode(db, bus, { draft: { title: "Wisp" }, evidence: {}, zone: "messy" });
    setActions(db, bus, zoned.id, [SLOT]);
    promote(db, bus, zoned.id);
    expect(readActions(db).get(zoned.id)).toEqual([SLOT]);

    // Ratify re-homes onto the fresh node id.
    const result = ratify(db, bus, docsDir, { proposalId: pending.id, ruling: "thread" });
    expect(result.status).toBe("ratified");
    const actions = readActions(db);
    expect(actions.get(pending.id)).toBeUndefined();
    expect(actions.get(result.nodeId as string)).toEqual([SLOT]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes.find((n) => n.id === result.nodeId)?.actions).toEqual([SLOT]);

    // Reject deletes.
    ratify(db, bus, docsDir, { proposalId: zoned.id, ruling: "reject" });
    expect(readActions(db).get(zoned.id)).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle: an accepted EDGE proposal's slots die (no node to re-home onto); zone delete cascades slots", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('a', 'cast', 'canon', 'A', '')",
    );
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('b', 'cast', 'canon', 'B', '')",
    );
    const edge = proposeEdge(db, bus, {
      draft: { source: "a", target: "b", label: "knows" },
      evidence: {},
    });
    setActions(db, bus, edge.id, [SLOT]);
    ratify(db, bus, docsDir, { proposalId: edge.id, ruling: "canon" });
    expect(readActions(db).get(edge.id)).toBeUndefined();

    createZone(db, bus, "Pen");
    const zoned = proposeNode(db, bus, { draft: { title: "Z" }, evidence: {}, zone: "pen" });
    setActions(db, bus, zoned.id, [SLOT]);
    deleteZone(db, bus, "pen", true);
    expect(readActions(db).get(zoned.id)).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
