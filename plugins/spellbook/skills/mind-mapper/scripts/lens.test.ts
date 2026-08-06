// P3 — `lens set --node <id> [--depth <n>] | lens clear` writes the lens
// table row, emits lens.set. `look-here <nodeId>` is a fire-once nudge, NOT
// persisted state — an event with no backing table, distinct from lens.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { clearLens, lookHere, setLens } from "./lens.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-lens-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("setLens writes the lens row, readState reflects it, emits lens.set", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (e) => received.push(e));
    setLens(db, bus, "default", { owner: "agent", nodeId: "maren", depth: 1, docId: null });

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.lens).toEqual({ owner: "agent", nodeId: "maren", depth: 1, docId: null });
    expect(received).toEqual([
      {
        seq: 1,
        epoch: bus.epoch,
        kind: "lens.set",
        payload: { owner: "agent", nodeId: "maren", depth: 1, docId: null },
      },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setLens replaces a prior lens for the same project (one row per project)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    setLens(db, bus, "default", { owner: "agent", nodeId: "maren", depth: 1, docId: null });
    setLens(db, bus, "default", { owner: "human", nodeId: "edda", depth: 2, docId: null });
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.lens).toEqual({ owner: "human", nodeId: "edda", depth: 2, docId: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearLens removes the row, readState.lens goes back to null", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    setLens(db, bus, "default", { owner: "agent", nodeId: "maren", depth: 1, docId: null });
    clearLens(db, bus, "default");
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.lens).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doc lens: setLens writes docId, XOR holds by construction (node set nulls doc, doc set nulls node)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (e) => received.push(e));
    setLens(db, bus, "default", { owner: "agent", nodeId: null, depth: null, docId: "ramble-01" });
    expect(readState(db, { id: "default", title: "Default" }).lens).toEqual({
      owner: "agent",
      nodeId: null,
      depth: null,
      docId: "ramble-01",
    });
    // The lens.set payload ALWAYS carries docId (additive-optional wire).
    expect((received[0] as { payload: { docId: string } }).payload.docId).toBe("ramble-01");

    // Switching back to a node lens nulls doc_id — the upsert writes every
    // column, so no stale doc mode can survive.
    setLens(db, bus, "default", { owner: "human", nodeId: "maren", depth: 1, docId: null });
    expect(readState(db, { id: "default", title: "Default" }).lens).toEqual({
      owner: "human",
      nodeId: "maren",
      depth: 1,
      docId: null,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a doc lens persists across a store reopen (restart survival)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    setLens(db, bus, "default", { owner: "agent", nodeId: null, depth: null, docId: "ramble-01" });
    db.close();

    const reopened = openStore(join(dir, "store.sqlite"));
    try {
      expect(readState(reopened, { id: "default", title: "Default" }).lens).toEqual({
        owner: "agent",
        nodeId: null,
        depth: null,
        docId: "ramble-01",
      });
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lookHere emits a fire-once event, writes no table row", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (e) => received.push(e));
    lookHere(bus, "maren");
    expect(received).toEqual([
      { seq: 1, epoch: bus.epoch, kind: "look.here", payload: { nodeId: "maren" } },
    ]);

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.lens).toBeNull(); // lookHere is not persisted lens state
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
