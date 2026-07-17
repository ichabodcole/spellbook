// P1 schema tests — a fresh store applies cleanly, re-opening an existing one
// doesn't error or duplicate tables (the honest-rebuild path Claim B commits
// to: re-index recovers wikilinks/re-anchors claims, it never re-runs
// extraction, but it must at minimum not corrupt what's already there).
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "mind-mapper-db-test-"));
}

test("openStore creates all ratified tables in a fresh dir", () => {
  const dir = tempDir();
  try {
    const db = openStore(join(dir, "store.sqlite"));
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of ["docs", "edges", "messages", "nodes", "proposals", "sources"]) {
      expect(tables).toContain(expected);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore is idempotent — re-opening an existing store does not error or duplicate", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    const db1 = openStore(path);
    db1.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "n1",
      "cast",
      "canon",
      "Maren",
      "the baker",
    ]);
    db1.close();

    const db2 = openStore(path);
    const rows = db2.query("SELECT id FROM nodes").all();
    expect(rows).toHaveLength(1);
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore backfills columns added after a table's original shape shipped", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store under the PREVIOUS messages shape (pre-P2 message-shape
    // change, vine msg 20's exact repro): project_id/seq/role/text/ts only.
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE messages (
        project_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    oldSchemaDb.run("INSERT INTO messages (project_id, seq, role, text) VALUES (?, ?, ?, ?)", [
      "default",
      1,
      "user",
      "hello",
    ]);
    oldSchemaDb.close();

    // Open with the CURRENT db.ts — must not throw, must add the new columns.
    const db = openStore(path);
    const columns = new Set(
      (db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const expected of ["id", "kind", "ground_json"]) expect(columns).toContain(expected);

    // The pre-existing row survives, with the new columns nulled (honest —
    // it predates them, nothing pretends it had an id/kind all along).
    const row = db.query("SELECT project_id, text, id, kind FROM messages").get() as {
      project_id: string;
      text: string;
      id: string | null;
      kind: string | null;
    };
    expect(row).toEqual({ project_id: "default", text: "hello", id: null, kind: null });

    // And a NEW row through the current write path works end to end.
    db.run(
      "INSERT INTO messages (id, project_id, seq, role, kind, text, ground_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["m1", "default", 2, "user", "turn", "hi again", null],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore is idempotent when the backfill has already run (no double-migration)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    openStore(path).close();
    expect(() => openStore(path).close()).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("docs_fts is queryable over doc content", () => {
  const dir = tempDir();
  try {
    const db = openStore(join(dir, "store.sqlite"));
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
    const hits = db.query("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all("crossing");
    expect(hits).toEqual([{ doc_id: "ramble-01" }]);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
