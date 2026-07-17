// P2 — POST /ingest backing: multipart (file drop) or JSON (brain-dump text,
// "+ new document") all converge here. Writes the source doc file + a docs
// row, emits doc.added. Does nothing else — no extraction, no chunking, no
// embedding (Claim A: that's the casting agent reacting to the event).

import type { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./events.ts";
import type { Doc } from "./state.ts";

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "doc";
}

// A duplicate title gets a disambiguating numeric suffix — never an
// overwrite (silent data loss is the failure mode to guard).
function uniqueId(db: Database, title: string): string {
  const base = slugify(title);
  let id = base;
  let n = 2;
  while ((db.query("SELECT 1 FROM docs WHERE id = ?").get(id) as unknown) !== null) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function storeDoc(
  db: Database,
  bus: EventBus,
  docsDir: string,
  title: string,
  content: string,
  kind: string,
): Doc {
  const id = uniqueId(db, title);
  if (!existsSync(docsDir)) throw new Error(`docs dir does not exist: ${docsDir}`);
  writeFileSync(join(docsDir, `${id}.md`), content);
  db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)", [
    id,
    title,
    kind,
    `docs/${id}.md`,
  ]);
  db.run("INSERT INTO docs_fts (rowid, doc_id, content) VALUES (last_insert_rowid(), ?, ?)", [
    id,
    content,
  ]);
  const doc: Doc = { id, title, kind };
  bus.emit("doc.added", doc as unknown as Record<string, unknown>);
  return doc;
}

function ingestText(
  db: Database,
  bus: EventBus,
  docsDir: string,
  title: string,
  text: string,
  kind = "ramble",
): Doc {
  return storeDoc(db, bus, docsDir, title, text, kind);
}

function ingestFile(
  db: Database,
  bus: EventBus,
  docsDir: string,
  title: string,
  content: string,
  kind = "story",
): Doc {
  return storeDoc(db, bus, docsDir, title, content, kind);
}

export { ingestFile, ingestText };
