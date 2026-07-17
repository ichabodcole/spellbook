// P1 — one-time bootstrap: seed the "default" project's real sqlite store
// from the spike's stub-map.json + data/docs/*.md the first time it's
// created, so the existing dogfood dataset survives the cut-over from
// stub-JSON to real state (continuity for circe's surface work). Not a
// migration path for anything else — a fresh non-default project starts
// genuinely empty.

import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface StubMap {
  docs?: Array<{ id: string; title: string; kind: string }>;
  nodes?: Array<{
    id: string;
    kind: string;
    tier: string;
    title: string;
    synopsis: string;
    sources?: Array<{ docId: string; span?: string }>;
  }>;
  edges?: Array<{
    id: string;
    source: string;
    target: string;
    label: string;
    provenance: string;
    direction?: string;
  }>;
}

function seedDefaultProject(db: Database, projectDocsDir: string, stubDataDir: string): void {
  const stubFile = join(stubDataDir, "stub-map.json");
  if (!existsSync(stubFile)) return;
  const stub = JSON.parse(readFileSync(stubFile, "utf8")) as StubMap;

  const insertDoc = db.query(
    "INSERT OR IGNORE INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)",
  );
  const insertDocFts = db.query(
    "INSERT INTO docs_fts (rowid, doc_id, content) VALUES (last_insert_rowid(), ?, ?)",
  );
  for (const doc of stub.docs ?? []) {
    const srcFile = join(stubDataDir, "docs", `${doc.id}.md`);
    if (!existsSync(srcFile)) continue;
    const content = readFileSync(srcFile, "utf8");
    copyFileSync(srcFile, join(projectDocsDir, `${doc.id}.md`));
    insertDoc.run(doc.id, doc.title, doc.kind, `docs/${doc.id}.md`);
    insertDocFts.run(doc.id, content);
  }

  const insertNode = db.query(
    "INSERT OR IGNORE INTO nodes (id, kind, tier, title, synopsis) VALUES (?, ?, ?, ?, ?)",
  );
  const insertSource = db.query("INSERT INTO sources (node_id, doc_id, span) VALUES (?, ?, ?)");
  for (const node of stub.nodes ?? []) {
    insertNode.run(node.id, node.kind, node.tier, node.title, node.synopsis);
    for (const source of node.sources ?? []) {
      insertSource.run(node.id, source.docId, source.span ?? null);
    }
  }

  const insertEdge = db.query(
    "INSERT OR IGNORE INTO edges (id, source, target, label, provenance, direction) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const edge of stub.edges ?? []) {
    insertEdge.run(
      edge.id,
      edge.source,
      edge.target,
      edge.label,
      edge.provenance,
      edge.direction ?? null,
    );
  }
}

export { seedDefaultProject };
