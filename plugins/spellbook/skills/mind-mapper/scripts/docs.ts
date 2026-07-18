// V1.x Claim A — `doc delete <id> [--force]` backing. Nodes SURVIVE a doc
// delete (map-as-view: deleting a source doesn't un-ratify the claim); what
// dies is the doc file, its docs/docs_fts rows, its sources rows, and — with
// force — the evidence columns on PENDING proposals citing it (they become
// evidence-less proposals, still rulable; ratify's "no evidence doc to edit"
// guard then holds, closing the zombie-write hole where ratifying a citing
// proposal would recreate the deleted file). Ratified proposals keep their
// evidence_doc_id as historical record — consumers tolerate a docId absent
// from docs[].

import type { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EventBus } from "./events.ts";
import { SLUG_RE } from "./project.ts";

// The first non-uniform error in server.ts, deliberate: an unforced delete
// of a cited doc is a 409 carrying the provenance counts the surface's
// confirm dialog renders — not a 400 string.
class CitedError extends Error {
  citedBy: { nodes: number; proposals: number };
  constructor(citedBy: { nodes: number; proposals: number }) {
    super(`doc is cited by ${citedBy.nodes} node(s) and ${citedBy.proposals} pending proposal(s)`);
    this.name = "CitedError";
    this.citedBy = citedBy;
  }
}

// Returns null for an unknown (or non-slug) id — the server 404s first,
// before any cited/force reasoning.
function deleteDoc(
  db: Database,
  bus: EventBus,
  projectDir: string,
  id: string,
  force: boolean,
): { id: string } | null {
  if (!SLUG_RE.test(id)) return null;
  const row = db.query("SELECT path FROM docs WHERE id = ?").get(id) as { path: string } | null;
  if (!row) return null;

  const nodes = (
    db.query("SELECT COUNT(DISTINCT node_id) as n FROM sources WHERE doc_id = ?").get(id) as {
      n: number;
    }
  ).n;
  const proposals = (
    db
      .query("SELECT COUNT(*) as n FROM proposals WHERE evidence_doc_id = ? AND status = 'pending'")
      .get(id) as { n: number }
  ).n;
  if (!force && (nodes > 0 || proposals > 0)) throw new CitedError({ nodes, proposals });

  const file = join(projectDir, row.path);
  if (existsSync(file)) unlinkSync(file);
  db.run("DELETE FROM docs WHERE id = ?", [id]);
  db.run("DELETE FROM docs_fts WHERE doc_id = ?", [id]);
  db.run("DELETE FROM sources WHERE doc_id = ?", [id]);
  // Pending proposals lose their evidence (span included — a span without
  // its doc anchors nothing); ratified ones keep it as history.
  db.run(
    "UPDATE proposals SET evidence_doc_id = NULL, evidence_span = NULL WHERE evidence_doc_id = ? AND status = 'pending'",
    [id],
  );

  bus.emit("doc.deleted", { id });
  return { id };
}

export { CitedError, deleteDoc };
