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
    for (const expected of [
      "docs",
      "doc_marks",
      "edges",
      "messages",
      "message_sources",
      "node_actions",
      "node_tags",
      "nodes",
      "proposals",
      "sources",
      "zones",
    ]) {
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

test("openStore backfills author/evidence_message_id onto a previous-shape proposals table", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store under the PREVIOUS proposals shape (V1-as-shipped: has
    // result_node_id, predates author + evidence_message_id) — the load-bearing
    // test design: a fresh store can never catch this class of bug, only a
    // genuinely-older store re-opened by current code can.
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        evidence_doc_id TEXT,
        evidence_span TEXT,
        suggested_tier TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        result_node_id TEXT
      );
    `);
    oldSchemaDb.run(
      "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, status) VALUES (?, ?, ?, ?, 'pending')",
      ["p1", "node", '{"title":"Edda"}', "ramble-01"],
    );
    oldSchemaDb.close();

    // Open with the CURRENT db.ts — must not throw, must add the new columns.
    const db = openStore(path);
    const columns = new Set(
      (db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    for (const expected of ["author", "evidence_message_id"]) expect(columns).toContain(expected);

    // The pre-existing row survives with the new columns nulled (null is
    // normalized to "agent" at read time, never rewritten in place).
    const row = db
      .query("SELECT id, author, evidence_message_id FROM proposals WHERE id = 'p1'")
      .get() as { id: string; author: string | null; evidence_message_id: string | null };
    expect(row).toEqual({ id: "p1", author: null, evidence_message_id: null });

    // And a NEW row through the current write path works end to end.
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, author, evidence_message_id, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      ["p2", "node", "{}", "user", null],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore backfills zone_id onto a previous-shape (V1.x) proposals table and creates zones", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store under the PREVIOUS proposals shape (V1.x-as-shipped: has
    // author + evidence_message_id, predates zone_id) — the load-bearing test
    // design: only a genuinely-older store re-opened by current code can
    // catch a missing backfill.
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        evidence_doc_id TEXT,
        evidence_span TEXT,
        suggested_tier TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        result_node_id TEXT,
        author TEXT,
        evidence_message_id TEXT
      );
    `);
    oldSchemaDb.run(
      "INSERT INTO proposals (id, kind, draft_json, author, status) VALUES (?, ?, ?, ?, 'pending')",
      ["p1", "node", '{"title":"Edda"}', "agent"],
    );
    oldSchemaDb.close();

    const db = openStore(path);
    const columns = new Set(
      (db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    expect(columns).toContain("zone_id");

    // The pre-existing row survives with zone_id null — a main-queue proposal
    // by construction (the main graph is zone_id IS NULL).
    const row = db.query("SELECT id, zone_id FROM proposals WHERE id = 'p1'").get() as {
      id: string;
      zone_id: string | null;
    };
    expect(row).toEqual({ id: "p1", zone_id: null });

    // The new zones table lands via CREATE TABLE IF NOT EXISTS on the same open.
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='zones'")
      .all();
    expect(tables).toHaveLength(1);

    // And a NEW zoned row through the current write path works end to end.
    db.run("INSERT INTO zones (id, name) VALUES (?, ?)", ["messy", "Messy"]);
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, zone_id, status) VALUES (?, ?, ?, ?, 'pending')",
      ["p2", "node", "{}", "messy"],
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore backfills kind_author onto a previous-shape docs table (fresh equals migrated)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store under the PREVIOUS docs shape (Round 3-as-shipped: kind
    // NOT NULL, no kind_author) with a populated row — only a genuinely-older
    // store re-opened by current code can catch a missing backfill.
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE docs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    oldSchemaDb.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)", [
      "ramble-01",
      "Ramble",
      "ramble",
      "docs/ramble-01.md",
    ]);
    oldSchemaDb.close();

    const db = openStore(path);
    const migratedColumns = (
      db.query("PRAGMA table_info(docs)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(migratedColumns).toContain("kind_author");

    // The pre-existing row keeps its stored kind, kind_author nulled —
    // legacy rows are honestly unattributed (K1 ruling).
    const row = db.query("SELECT id, kind, kind_author FROM docs WHERE id = 'ramble-01'").get() as {
      id: string;
      kind: string;
      kind_author: string | null;
    };
    expect(row).toEqual({ id: "ramble-01", kind: "ramble", kind_author: null });
    db.close();

    // Fresh-equals-migrated: a brand-new store's docs column set must be
    // identical to what the backfill produced (the migration doctrine's
    // load-bearing invariant).
    const freshDir = tempDir();
    try {
      const fresh = openStore(join(freshDir, "store.sqlite"));
      const freshColumns = (
        fresh.query("PRAGMA table_info(docs)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(freshColumns.sort()).toEqual(migratedColumns.sort());
      fresh.close();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore backfills anchor_node_id onto a previous-shape nodes table (fresh equals migrated)", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store under the PRE-SG1 nodes shape (no anchor_node_id) with a
    // populated row — only a genuinely-older store re-opened by current code
    // can catch a missing backfill (a fresh store's CREATE TABLE IF NOT EXISTS
    // silently no-ops the change).
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tier TEXT NOT NULL,
        title TEXT NOT NULL,
        synopsis TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    oldSchemaDb.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker",
    ]);
    oldSchemaDb.close();

    const db = openStore(path);
    const migratedColumns = (
      db.query("PRAGMA table_info(nodes)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(migratedColumns).toContain("anchor_node_id");

    // The pre-existing node backfills to a null anchor = top-level.
    const row = db.query("SELECT id, anchor_node_id FROM nodes WHERE id = 'maren'").get() as {
      id: string;
      anchor_node_id: string | null;
    };
    expect(row).toEqual({ id: "maren", anchor_node_id: null });
    db.close();

    // Fresh-equals-migrated: a brand-new store's nodes column set must equal
    // what the backfill produced (the migration doctrine's invariant).
    const freshDir = tempDir();
    try {
      const fresh = openStore(join(freshDir, "store.sqlite"));
      const freshColumns = (
        fresh.query("PRAGMA table_info(nodes)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(freshColumns.sort()).toEqual(migratedColumns.sort());
      fresh.close();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore backfills doc_id onto a previous-shape lens table", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store under the PREVIOUS lens shape (pre-doc-lens: no doc_id),
    // with a live node lens in it.
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE lens (
        project_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        node_id TEXT,
        depth INTEGER
      );
    `);
    oldSchemaDb.run("INSERT INTO lens (project_id, owner, node_id, depth) VALUES (?, ?, ?, ?)", [
      "default",
      "human",
      "maren",
      1,
    ]);
    oldSchemaDb.close();

    const db = openStore(path);
    const columns = new Set(
      (db.query("PRAGMA table_info(lens)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(columns).toContain("doc_id");

    // The pre-existing node lens survives untouched — doc_id null IS the
    // node-lens variant (XOR holds without a rewrite).
    const row = db
      .query("SELECT project_id, node_id, doc_id FROM lens WHERE project_id = 'default'")
      .get() as { project_id: string; node_id: string | null; doc_id: string | null };
    expect(row).toEqual({ project_id: "default", node_id: "maren", doc_id: null });
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openStore adds node_tags (new table) to a pre-node_tags store; fresh equals migrated", () => {
  const dir = tempDir();
  try {
    const path = join(dir, "store.sqlite");
    // Mint a store WITHOUT node_tags (the pre-R7 shape) carrying a node and a
    // proposal — a new table lands via CREATE TABLE IF NOT EXISTS on open, but
    // only a genuinely-older store proves the open doesn't error against
    // pre-existing data (the migration-doctrine test design).
    const oldSchemaDb = new Database(path, { create: true });
    oldSchemaDb.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tier TEXT NOT NULL,
        title TEXT NOT NULL,
        synopsis TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE node_actions (
        target_id TEXT PRIMARY KEY,
        actions_json TEXT NOT NULL
      );
    `);
    oldSchemaDb.run("INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)", [
      "maren",
      "cast",
      "canon",
      "Maren",
      "the baker",
    ]);
    oldSchemaDb.close();

    // node_tags absent before, present after — no error, no duplicate.
    const db = openStore(path);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='node_tags'")
      .all();
    expect(tables).toHaveLength(1);

    // A new tags row through the current write path works end to end.
    db.run("INSERT INTO node_tags (target_id, tags_json) VALUES (?, ?)", ["maren", '["theme"]']);
    const row = db
      .query("SELECT target_id, tags_json FROM node_tags WHERE target_id = 'maren'")
      .get() as {
      target_id: string;
      tags_json: string;
    };
    expect(row).toEqual({ target_id: "maren", tags_json: '["theme"]' });
    const migratedColumns = (
      db.query("PRAGMA table_info(node_tags)").all() as Array<{ name: string }>
    )
      .map((c) => c.name)
      .sort();
    db.close();

    // Fresh-equals-migrated: a brand-new store's node_tags shape must equal
    // what the current open produced against the older store.
    const freshDir = tempDir();
    try {
      const fresh = openStore(join(freshDir, "store.sqlite"));
      const freshColumns = (
        fresh.query("PRAGMA table_info(node_tags)").all() as Array<{ name: string }>
      )
        .map((c) => c.name)
        .sort();
      expect(freshColumns).toEqual(migratedColumns);
      fresh.close();
    } finally {
      rmSync(freshDir, { recursive: true, force: true });
    }
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
