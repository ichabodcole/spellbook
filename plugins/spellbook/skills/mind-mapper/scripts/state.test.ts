// P1 — the assembled snapshot must match the ratified wire schema exactly
// (vine msg 6): { project, docs[], nodes[], edges[], proposals[],
// conversation[], lens, cursor }. This is the contract circe's types.ts is
// written against — a shape mismatch here is a seam break, not a bug.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-state-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("readState assembles an empty project with the ratified shape", () => {
  const { dir, db } = tempDb();
  try {
    const state = readState(db, { id: "default", title: "Default" });
    expect(state).toEqual({
      project: { id: "default", title: "Default" },
      docs: [],
      nodes: [],
      edges: [],
      proposals: [],
      conversation: [],
      lens: null,
      cursor: 0,
      epoch: "",
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readState reflects seeded rows, docs stay content-free", () => {
  const { dir, db } = tempDb();
  try {
    db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)", [
      "ramble-01",
      "Ramble",
      "ramble",
      "docs/ramble-01.md",
    ]);
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker",
    ]);
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)", [
      "maren",
      "ramble-01",
      "the baker of Hollowbrook",
    ]);
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)", [
      "maren",
      "bible-maren",
      null,
    ]);
    db.run(
      "INSERT INTO edges (id, source, target, label, provenance, direction) VALUES (?, ?, ?, ?, ?, ?)",
      ["e1", "maren", "hollowbrook", "lives in", "asserted", null],
    );
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_span, suggested_tier, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "p1",
        "node",
        JSON.stringify({ title: "Edda" }),
        "ramble-01",
        "Edda keeps the mill",
        "thread",
        "pending",
      ],
    );
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text, ground_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["m1", "default", 1, "user", "turn", "hello", JSON.stringify(["maren"])],
    );
    db.run("INSERT INTO lens (project_id, owner, node_id, depth) VALUES (?, ?, ?, ?)", [
      "default",
      "human",
      "maren",
      1,
    ]);

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.docs).toEqual([{ id: "ramble-01", title: "Ramble", kind: "ramble" }]);
    expect(state.nodes[0]).toMatchObject({ id: "maren", title: "Maren" });
    expect(state.nodes[0]?.sources).toEqual([
      { docId: "ramble-01", span: "the baker of Hollowbrook" },
      { docId: "bible-maren", span: null },
    ]);
    expect(state.edges[0]).toMatchObject({ id: "e1", source: "maren", target: "hollowbrook" });
    expect(state.proposals[0]).toMatchObject({ id: "p1", status: "pending" });
    expect(state.conversation[0]).toMatchObject({
      id: "m1",
      seq: 1,
      role: "user",
      kind: "turn",
      text: "hello",
      ground: ["maren"],
    });
    expect(state.lens).toEqual({ owner: "human", nodeId: "maren", depth: 1 });
    expect(state.cursor).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
