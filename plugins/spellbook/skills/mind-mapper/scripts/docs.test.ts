// Claim A / T7 — doc delete: unforced deletes 409 (throw CitedError) when
// cited, force cascades (file, docs+fts+sources rows, pending-proposal
// evidence NULLed), nodes SURVIVE, and the zombie-write hole is closed: a
// post-delete ratify of a formerly-citing pending proposal succeeds WITHOUT
// recreating the deleted file.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { CitedError, deleteDoc, setDocKind } from "./docs.ts";
import { createEventBus } from "./events.ts";
import { proposeNode } from "./propose.ts";
import { ratify } from "./ratify.ts";
import { readState } from "./state.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-docs-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}

function addDoc(db: ReturnType<typeof openStore>, docsDir: string, id: string) {
  writeFileSync(join(docsDir, `${id}.md`), `prose of ${id}`);
  db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, 'ramble', ?)", [
    id,
    id,
    `docs/${id}.md`,
  ]);
  db.run("INSERT INTO docs_fts (doc_id, content) VALUES (?, ?)", [id, `prose of ${id}`]);
}

test("an uncited doc deletes without force: file, docs row, fts row all gone; doc.deleted emitted", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    const received: unknown[] = [];
    bus.subscribe(0, (e) => received.push(e));

    const result = deleteDoc(db, bus, dir, "ramble-01", false);
    expect(result).toEqual({ id: "ramble-01" });
    expect(existsSync(join(docsDir, "ramble-01.md"))).toBe(false);
    expect(db.query("SELECT 1 FROM docs WHERE id = 'ramble-01'").get()).toBeNull();
    expect(db.query("SELECT 1 FROM docs_fts WHERE doc_id = 'ramble-01'").get()).toBeNull();
    expect(received).toEqual([
      { seq: 1, epoch: bus.epoch, kind: "doc.deleted", payload: { id: "ramble-01" } },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown and non-slug ids return null (the server 404s before cited/force reasoning)", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    expect(deleteDoc(db, bus, dir, "no-such-doc", false)).toBeNull();
    expect(deleteDoc(db, bus, dir, "../escape", true)).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unforced delete of a cited doc throws CitedError with distinct-node + pending-proposal counts", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    // Two source rows on ONE node (distinct count must be 1), plus one
    // pending and one ratified citing proposal (only pending counts).
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES ('n1', 'ramble-01', 'a')");
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES ('n1', 'ramble-01', 'b')");
    proposeNode(db, bus, { draft: { title: "P" }, evidence: { docId: "ramble-01" } });
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, status) VALUES ('p-done', 'node', '{}', 'ramble-01', 'ratified')",
    );

    let thrown: unknown;
    try {
      deleteDoc(db, bus, dir, "ramble-01", false);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CitedError);
    expect((thrown as CitedError).citedBy).toEqual({ nodes: 1, proposals: 1 });
    // Nothing was touched.
    expect(existsSync(join(docsDir, "ramble-01.md"))).toBe(true);
    expect(db.query("SELECT 1 FROM docs WHERE id = 'ramble-01'").get()).not.toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("force cascade: sources rows die, nodes survive, pending evidence NULLs, ratified evidence is kept", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES ('n1', 'ramble-01', 'a')");
    const pending = proposeNode(db, bus, {
      draft: { title: "P" },
      evidence: { docId: "ramble-01", span: "x" },
    });
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, status) VALUES ('p-done', 'node', '{}', 'ramble-01', 'ratified')",
    );

    const result = deleteDoc(db, bus, dir, "ramble-01", true);
    expect(result).toEqual({ id: "ramble-01" });

    const state = readState(db, { id: "default", title: "Default" });
    // The node survives, with its doc source rows gone.
    expect(state.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(state.nodes[0]?.sources).toEqual([]);
    // The pending proposal became evidence-less (span included); the
    // ratified one keeps its docId as historical record.
    const pendingAfter = state.proposals.find((p) => p.id === pending.id);
    expect(pendingAfter?.evidence).toEqual({ docId: null, messageId: null, span: null });
    const ratifiedAfter = state.proposals.find((p) => p.id === "p-done");
    expect(ratifiedAfter?.evidence.docId).toBe("ramble-01");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zombie-write hole closed: post-delete ratify of a formerly-citing pending proposal succeeds WITHOUT recreating the file", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    const proposal = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: { docId: "ramble-01", span: "keeps the mill" },
    });
    deleteDoc(db, bus, dir, "ramble-01", true);

    // Accepting the now-evidence-less proposal works…
    const result = ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "thread" });
    expect(result.status).toBe("ratified");
    // …creates no source row and does NOT resurrect the deleted file.
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes.find((n) => n.id === result.nodeId)?.sources).toEqual([]);
    expect(existsSync(join(docsDir, "ramble-01.md"))).toBe(false);
    // And a doc-edit attempt against it holds the existing guard.
    const second = proposeNode(db, bus, { draft: { title: "X" }, evidence: {} });
    expect(() =>
      ratify(db, bus, docsDir, { proposalId: second.id, ruling: "canon", docEdit: "prose" }),
    ).toThrow(/no evidence doc to edit/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round 4 (K1) — setDocKind: assert/clear a doc's kind with attribution.
test("setDocKind sets kind + author, emits doc.kind, and round-trips through readState", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(0, (event) => received.push(event as unknown as Record<string, unknown>));

    const result = setDocKind(db, bus, {
      docId: "ramble-01",
      kind: "worldbuilding",
      author: "user",
    });
    expect(result).toEqual({ docId: "ramble-01", kind: "worldbuilding", kindAuthor: "user" });
    expect(received).toEqual([
      {
        seq: 1,
        epoch: bus.epoch,
        kind: "doc.kind",
        payload: { docId: "ramble-01", kind: "worldbuilding", author: "user" },
      },
    ]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.docs[0]).toMatchObject({ kind: "worldbuilding", kindAuthor: "user" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setDocKind with kind null clears to the '' sentinel and nulls the author", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    setDocKind(db, bus, { docId: "ramble-01", kind: "notes", author: "agent" });
    const result = setDocKind(db, bus, { docId: "ramble-01", kind: null });
    expect(result).toEqual({ docId: "ramble-01", kind: null, kindAuthor: null });
    const row = db.query("SELECT kind, kind_author FROM docs WHERE id = 'ramble-01'").get() as {
      kind: string;
      kind_author: string | null;
    };
    expect(row).toEqual({ kind: "", kind_author: null }); // '' at rest, null on the wire
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.docs[0]).toMatchObject({ kind: null, kindAuthor: null });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setDocKind fails loud: unknown/non-slug docs are null (404), a set without a valid author throws", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, docsDir, "ramble-01");
    expect(setDocKind(db, bus, { docId: "no-such-doc", kind: "x", author: "agent" })).toBeNull();
    expect(setDocKind(db, bus, { docId: "../evil", kind: "x", author: "agent" })).toBeNull();
    expect(() => setDocKind(db, bus, { docId: "ramble-01", kind: "x" })).toThrow(/author/);
    expect(() => setDocKind(db, bus, { docId: "ramble-01", kind: "x", author: "gremlin" })).toThrow(
      /author/,
    );
    expect(() => setDocKind(db, bus, { docId: "ramble-01", kind: "", author: "agent" })).toThrow(
      /non-empty/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
