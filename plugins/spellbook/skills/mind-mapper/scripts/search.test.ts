// P3 — search: one typed-hit shape shared by the palette (kind:"node" only
// consumer) and the agent's search verb (full set), per prospero's ruling
// (vine msg 36). Node hits rank first at an equal score.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { search } from "./search.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-search-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("search finds a node hit by title", () => {
  const { dir, db } = tempDb();
  try {
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker of Hollowbrook",
    ]);
    const hits = search(db, "Maren");
    expect(hits).toEqual([
      { kind: "node", id: "maren", title: "Maren", snippet: "the baker of Hollowbrook", score: 20 },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search finds a node hit by synopsis term (lower score than a title match)", () => {
  const { dir, db } = tempDb();
  try {
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker of Hollowbrook",
    ]);
    const hits = search(db, "baker");
    expect(hits).toEqual([
      { kind: "node", id: "maren", title: "Maren", snippet: "the baker of Hollowbrook", score: 10 },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search finds a doc hit via FTS5", () => {
  const { dir, db } = tempDb();
  try {
    db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)", [
      "ramble-01",
      "Ramble",
      "ramble",
      "docs/ramble-01.md",
    ]);
    db.run("INSERT INTO docs_fts (rowid, doc_id, content) VALUES (last_insert_rowid(), ?, ?)", [
      "ramble-01",
      "the crossing-stones hum at dusk",
    ]);
    const hits = search(db, "crossing-stones");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "doc", id: "ramble-01", title: "Ramble" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search finds a message hit via FTS5", () => {
  const { dir, db } = tempDb();
  try {
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text) VALUES (?, ?, ?, ?, ?, ?)",
      ["m1", "default", 1, "user", "turn", "the lighthouse keeper hides a secret"],
    );
    db.run(
      "INSERT INTO messages_fts (rowid, message_id, content) VALUES (last_insert_rowid(), ?, ?)",
      ["m1", "the lighthouse keeper hides a secret"],
    );
    const hits = search(db, "lighthouse");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "message", id: "m1" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a node hit ranks before a doc/message hit at an equal score", () => {
  const { dir, db } = tempDb();
  try {
    db.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "edda",
      "cast",
      "canon",
      "Edda",
      "keeps the mill",
    ]);
    db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)", [
      "story-3",
      "Edda's tale",
      "story",
      "docs/story-3.md",
    ]);
    db.run("INSERT INTO docs_fts (rowid, doc_id, content) VALUES (last_insert_rowid(), ?, ?)", [
      "story-3",
      "Edda mills the grain",
    ]);
    const hits = search(db, "Edda");
    expect(hits[0]).toMatchObject({ kind: "node", id: "edda" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search returns empty for an absent term, not an error", () => {
  const { dir, db } = tempDb();
  try {
    expect(search(db, "nonexistentterm")).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
