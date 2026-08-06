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

// Round 4 (K1) — `doc kind <docId> <kind> [--clear]` backing (mark route
// family: slug + exists guards fail loud, 404-first at the server). kind
// null = clear: writes the '' sentinel at rest AND nulls kind_author (an
// untyped doc has no assertor). A string kind requires an author — the badge
// styles asserted-by-user vs agent-set, so an unattributed set would lie.
// Emits doc.kind {docId, kind, author} with the WIRE shape (null, never '').
function setDocKind(
  db: Database,
  bus: EventBus,
  input: { docId: string; kind: string | null; author?: string },
): { docId: string; kind: string | null; kindAuthor: "user" | "agent" | null } | null {
  if (!SLUG_RE.test(input.docId)) return null;
  if (!db.query("SELECT 1 FROM docs WHERE id = ?").get(input.docId)) return null;
  if (input.kind !== null && (typeof input.kind !== "string" || input.kind === "")) {
    throw new Error("kind must be a non-empty string, or null to clear");
  }
  let kindAuthor: "user" | "agent" | null = null;
  if (input.kind !== null) {
    if (input.author !== "user" && input.author !== "agent") {
      throw new Error("setting a kind requires author user|agent");
    }
    kindAuthor = input.author;
  }
  db.run("UPDATE docs SET kind = ?, kind_author = ? WHERE id = ?", [
    input.kind ?? "",
    kindAuthor,
    input.docId,
  ]);
  bus.emit("doc.kind", { docId: input.docId, kind: input.kind, author: kindAuthor });
  return { docId: input.docId, kind: input.kind, kindAuthor };
}

export { CitedError, deleteDoc, setDocKind };
