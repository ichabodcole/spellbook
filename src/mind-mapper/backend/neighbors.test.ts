// P3 — `neighbors <nodeId> [--depth 1]` backing: depth-bounded BFS over
// edges in BOTH directions (edges are directed claims — "neighbors" means
// anything connected, not just outgoing). Skeleton-shaped response
// (ids/titles/edge reasons) per the context-budgeting constraint.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { neighbors } from "./neighbors.ts";

function seededDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-neighbors-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  const insertNode = db.query(
    "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)",
  );
  const seedNodes: Array<[string, string]> = [
    ["maren", "Maren"],
    ["edda", "Edda"],
    ["hollowbrook", "Hollowbrook"],
    ["tam", "Tam"],
  ];
  for (const [id, title] of seedNodes) {
    insertNode.run(id, "cast", "canon", title, "");
  }
  const insertEdge = db.query(
    "INSERT INTO edges (id, source, target, label, provenance) VALUES (?, ?, ?, ?, 'asserted')",
  );
  insertEdge.run("e1", "maren", "edda", "rivals with");
  insertEdge.run("e2", "hollowbrook", "maren", "home of"); // maren is the TARGET here
  insertEdge.run("e3", "edda", "tam", "distrusts");
  return { dir, db };
}

test("neighbors at depth 1 returns directly connected nodes from both edge directions", () => {
  const { dir, db } = seededDb();
  try {
    const result = neighbors(db, "maren", 1);
    expect(result.map((n) => n.id).sort()).toEqual(["edda", "hollowbrook"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neighbors at depth 2 reaches the second hop", () => {
  const { dir, db } = seededDb();
  try {
    const result = neighbors(db, "maren", 2);
    expect(result.map((n) => n.id).sort()).toEqual(["edda", "hollowbrook", "tam"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neighbors includes the edge reason (label + direction)", () => {
  const { dir, db } = seededDb();
  try {
    const result = neighbors(db, "maren", 1);
    const edda = result.find((n) => n.id === "edda");
    expect(edda?.via).toEqual({ edgeId: "e1", label: "rivals with", direction: "outgoing" });
    const hollowbrook = result.find((n) => n.id === "hollowbrook");
    expect(hollowbrook?.via).toEqual({ edgeId: "e2", label: "home of", direction: "incoming" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("neighbors of an unknown node returns empty, not an error", () => {
  const { dir, db } = seededDb();
  try {
    expect(neighbors(db, "nope", 1)).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
