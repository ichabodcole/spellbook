// Round 12 (SEAM 3) — the bounded, self-declaring delta. The load-bearing
// property is NOT what it returns; it is that it says what it CANNOT return.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOT_COVERED, readChanges } from "./changes.ts";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { proposeNode } from "./propose.ts";

const PROJECT = { id: "default", title: "Default" };

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-changes-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("nodes/edges/proposals ALREADY carry created_at — an additions delta needs no migration", () => {
  const { dir, db } = tempDb();
  try {
    // Falsifies the plan's obstacle (b): "nodes, edges and proposals carry no
    // ts column at all". They all do, and always have.
    for (const table of ["nodes", "edges", "proposals", "docs"]) {
      const columns = (
        db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(columns).toContain("created_at");
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readChanges returns entities created at/after the watermark, byte-identical to /state", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis, created_at) VALUES ('old', 'concept', 'canon', 'Old', '', 1000)",
    );
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis, created_at) VALUES ('new', 'concept', 'canon', 'New', '', 2000)",
    );
    proposeNode(db, bus, { draft: { title: "Fresh" }, evidence: {} });

    const delta = readChanges(db, PROJECT, 2000);
    expect(delta.additions.nodes.map((n) => n.id)).toEqual(["new"]);
    expect(delta.counts.nodes).toBe(1);
    // The proposal was created just now, so it rides the same delta — and it
    // carries the FULL wire shape (batchId included), not a hand-built stub.
    expect(delta.counts.proposals).toBe(1);
    expect(delta.additions.proposals[0]).toHaveProperty("batchId", null);
    // since=0 is "everything".
    expect(readChanges(db, PROJECT, 0).counts.nodes).toBe(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every response DECLARES its blind spots — deletions, rejections, edits, jobs, actors", () => {
  const { dir, db } = tempDb();
  try {
    const delta = readChanges(db, PROJECT, 0);
    // An EMPTY delta must still carry the disclosure — an agent that reads
    // "nothing added" as "nothing changed" is exactly the drive-10 failure.
    expect(delta.counts.nodes).toBe(0);
    expect(delta.notCovered).toEqual(NOT_COVERED);
    const blob = delta.notCovered.join(" ").toLowerCase();
    for (const blind of ["deletion", "reject", "edit", "jobs", "who acted"]) {
      expect(blob).toContain(blind);
    }
    expect(delta.note).toContain("ADDITIONS ONLY");
    expect(delta.note).toContain("not 'nothing changed'");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a DELETION is genuinely invisible — the disclosure is the whole contract, not a formality", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const p = proposeNode(db, bus, { draft: { title: "Doomed" }, evidence: {} });
    expect(readChanges(db, PROJECT, 0).counts.proposals).toBe(1);
    db.run("DELETE FROM proposals WHERE id = ?", [p.id]);
    // The delta now reports zero additions and says nothing about the removal:
    // this is the failure mode the notCovered list exists to make loud.
    expect(readChanges(db, PROJECT, 0).counts.proposals).toBe(0);
    expect(readChanges(db, PROJECT, 0).notCovered[0]).toContain("DELETIONS");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`now` is the next watermark, and `since` is inclusive (over-report, never under-report)", () => {
  const { dir, db } = tempDb();
  try {
    const delta = readChanges(db, PROJECT, 0);
    expect(delta.now).toBeGreaterThan(0);
    expect(delta.granularity).toBe("seconds");
    expect(delta.inclusive).toBe(true);
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis, created_at) VALUES ('boundary', 'concept', 'canon', 'B', '', ?)",
      [delta.now],
    );
    // Created IN the boundary second: an exclusive `>` would lose it forever.
    expect(readChanges(db, PROJECT, delta.now).additions.nodes.map((n) => n.id)).toEqual([
      "boundary",
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bad watermark is a named error, not a silent empty delta", () => {
  const { dir, db } = tempDb();
  try {
    expect(() => readChanges(db, PROJECT, Number.NaN)).toThrow(/epoch SECONDS/);
    expect(() => readChanges(db, PROJECT, -1)).toThrow(/non-negative/);
    expect(() => readChanges(db, PROJECT, 1.5)).toThrow(/integer/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
