// Round 5 (SG1) — anchorNode + its cycle guard. Real-nodes-only containment
// tree; the ancestor-walk rejects self/direct/deep cycles, unknown parent,
// unknown node; a clear (null) is always safe. Emits node.anchored (thin).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnchorError, anchorNode } from "./anchor.ts";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-anchor-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  // a small set of real nodes: b, c, d, e
  for (const id of ["b", "c", "d", "e"]) {
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, 'concept','canon',?, '')",
      [id, id.toUpperCase()],
    );
  }
  return { dir, db };
}

test("anchorNode builds a tree, emits node.anchored, and reads back on /state", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const emitted: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    bus.subscribe(0, (e) => emitted.push({ kind: e.kind, payload: e.payload }));

    expect(anchorNode(db, bus, "c", "b")).toEqual({ nodeId: "c", anchorNodeId: "b" });
    expect(anchorNode(db, bus, "d", "c")).toEqual({ nodeId: "d", anchorNodeId: "c" });
    anchorNode(db, bus, "e", "b");

    expect(emitted).toEqual([
      { kind: "node.anchored", payload: { nodeId: "c", anchorNodeId: "b" } },
      { kind: "node.anchored", payload: { nodeId: "d", anchorNodeId: "c" } },
      { kind: "node.anchored", payload: { nodeId: "e", anchorNodeId: "b" } },
    ]);

    const state = readState(db, { id: "default", title: "Default" });
    const byId = new Map(state.nodes.map((n) => [n.id, n]));
    expect(byId.get("c")?.anchorNodeId).toBe("b");
    expect(byId.get("d")?.anchorNodeId).toBe("c");
    // b has two direct children (c, e); c has one (d); leaves are 0.
    expect(byId.get("b")?.submapChildCount).toBe(2);
    expect(byId.get("c")?.submapChildCount).toBe(1);
    expect(byId.get("d")?.submapChildCount).toBe(0);
    expect(byId.get("b")?.anchorNodeId).toBeNull(); // top-level
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cycle guard rejects self, direct cycle, deep cycle, unknown parent, unknown node", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    anchorNode(db, bus, "c", "b"); // b <- c
    anchorNode(db, bus, "d", "c"); // c <- d  (so d descends b->c->d)

    expect(() => anchorNode(db, bus, "b", "b")).toThrow(/itself/);
    // direct cycle: b under c, but c descends from b
    expect(() => anchorNode(db, bus, "b", "c")).toThrow(AnchorError);
    // deep cycle: b under d, d descends from b via c
    expect(() => anchorNode(db, bus, "b", "d")).toThrow(/cycle/);
    expect(() => anchorNode(db, bus, "e", "zzz")).toThrow(/unknown anchor target/);
    expect(() => anchorNode(db, bus, "zzz", "b")).toThrow(/unknown node/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear (parentId null) moves a node back to top-level and is always safe", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    anchorNode(db, bus, "c", "b");
    expect(anchorNode(db, bus, "c", null)).toEqual({ nodeId: "c", anchorNodeId: null });
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes.find((n) => n.id === "c")?.anchorNodeId).toBeNull();
    expect(state.nodes.find((n) => n.id === "b")?.submapChildCount).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a re-parent is accepted when it introduces no cycle", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    anchorNode(db, bus, "c", "b");
    anchorNode(db, bus, "d", "c");
    // move d directly under b — d no longer descends from c, no cycle.
    expect(() => anchorNode(db, bus, "d", "b")).not.toThrow();
    expect(
      readState(db, { id: "default", title: "Default" }).nodes.find((n) => n.id === "d")
        ?.anchorNodeId,
    ).toBe("b");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
