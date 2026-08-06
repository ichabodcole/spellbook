// P3 — `search <query>` backing, per prospero's ruling (vine msg 36): ONE
// typed-hit shape shared by the search palette (kind:"node" only) and the
// agent's search verb (the full set) — {hits: [{kind, id, title, snippet?,
// score}]}. Nodes are searched by title/synopsis (LIKE — my choice per the
// ruling); docs + messages via FTS5. Node hits rank first at an equal score
// (the ruling's tie-break). V1 stays lexical-only (no embeddings/similar,
// proposal.md's explicit absence) — the shape leaves room for a future
// `kind: "vector"` hit without a breaking change.

import type { Database } from "bun:sqlite";

interface SearchHit {
  kind: "node" | "doc" | "message" | "proposal";
  id: string;
  title: string;
  snippet?: string;
  score: number;
  // Round 3 (Claim S1): proposal hits carry their zone tag (null = main
  // queue) so the palette can switch to the zone view before focusing.
  zoneId?: string | null;
}

// FTS5's bareword query syntax treats hyphens/colons as operators — quoting
// the whole query as one phrase sidesteps that (V1 is plain substring-ish
// lexical search, not a query-DSL surface for the human/agent to learn).
function ftsPhrase(query: string): string {
  return `"${query.replace(/"/g, '""')}"`;
}

function search(db: Database, query: string): SearchHit[] {
  const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const nodeRows = db
    .query(
      `SELECT id, title, synopsis,
              (CASE WHEN title LIKE ? ESCAPE '\\' THEN 2 ELSE 1 END) as score
       FROM nodes WHERE title LIKE ? ESCAPE '\\' OR synopsis LIKE ? ESCAPE '\\'`,
    )
    .all(like, like, like) as Array<{
    id: string;
    title: string;
    synopsis: string;
    score: number;
  }>;
  const nodeHits: SearchHit[] = nodeRows.map((row) => ({
    kind: "node",
    id: row.id,
    title: row.title,
    snippet: row.synopsis || undefined,
    score: row.score * 10, // node hits outrank lexical FTS scores at any tie
  }));

  // Round 3 (Claim S1): pending proposals, matched in JS over the PARSED
  // draft (SQL LIKE over raw draft_json matches key names and escape
  // sequences — ruled out at ratify). Score = the node formula ×9 (title 18 /
  // synopsis 9): match quality dominates tier, and an equal-quality match
  // ranks the ratified node first (20/10 vs 18/9).
  const lowerQuery = query.toLowerCase();
  const proposalRows = db
    .query("SELECT id, draft_json, zone_id FROM proposals WHERE status = 'pending'")
    .all() as Array<{ id: string; draft_json: string; zone_id: string | null }>;
  const proposalHits: SearchHit[] = [];
  if (lowerQuery !== "") {
    for (const row of proposalRows) {
      let draft: Record<string, unknown>;
      try {
        draft = JSON.parse(row.draft_json) as Record<string, unknown>;
      } catch {
        continue; // an unparsable draft simply can't match
      }
      const title = typeof draft.title === "string" ? draft.title : "";
      const synopsis = typeof draft.synopsis === "string" ? draft.synopsis : "";
      const titleMatch = title.toLowerCase().includes(lowerQuery);
      const synopsisMatch = synopsis.toLowerCase().includes(lowerQuery);
      if (!titleMatch && !synopsisMatch) continue;
      proposalHits.push({
        kind: "proposal",
        id: row.id,
        title: title || "Untitled",
        snippet: synopsis || undefined,
        score: (titleMatch ? 2 : 1) * 9,
        zoneId: row.zone_id,
      });
    }
  }

  const phrase = ftsPhrase(query);
  const docRows = db
    .query(
      `SELECT docs.id as id, docs.title as title, rank as rank,
              snippet(docs_fts, 1, '', '', '...', 8) as snippet
       FROM docs_fts JOIN docs ON docs.id = docs_fts.doc_id
       WHERE docs_fts MATCH ? ORDER BY rank`,
    )
    .all(phrase) as Array<{ id: string; title: string; rank: number; snippet: string }>;
  const docHits: SearchHit[] = docRows.map((row) => ({
    kind: "doc",
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    score: -row.rank,
  }));

  const messageRows = db
    .query(
      `SELECT messages.id as id, messages.text as text, rank as rank,
              snippet(messages_fts, 1, '', '', '...', 8) as snippet
       FROM messages_fts JOIN messages ON messages.id = messages_fts.message_id
       WHERE messages_fts MATCH ? ORDER BY rank`,
    )
    .all(phrase) as Array<{ id: string; text: string; rank: number; snippet: string }>;
  const messageHits: SearchHit[] = messageRows.map((row) => ({
    kind: "message",
    id: row.id,
    title: row.text,
    snippet: row.snippet,
    score: -row.rank,
  }));

  return [...nodeHits, ...proposalHits, ...docHits, ...messageHits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.kind === "node" && b.kind !== "node") return -1;
    if (b.kind === "node" && a.kind !== "node") return 1;
    return 0;
  });
}

export type { SearchHit };
export { search };
