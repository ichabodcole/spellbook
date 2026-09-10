// Round 12 (SEAM 4) — `node edit`: the missing "the agent is allowed to learn
// more about this later". Before this, `node` supported only anchor and delete,
// so a node ratified from a thin draft could NEVER gain a synopsis — the only
// recovery was delete + re-propose + re-ratify, which destroys the human's
// ratification act. Observed live: five canon nodes permanently bare (F2).
//
// WHAT IS EDITABLE — title and synopsis ONLY. The line is: an edit changes what
// a node SAYS, never what it IS or how it was RULED.
//   · `tier` is the human's ruling (canon / thread / story-local) — an agent
//     "edit" that re-tiers a node would overwrite a ratification act with a
//     write, which is exactly the thing F2 was trying not to destroy.
//   · `kind` is the same classification axis (drafted, then frozen by the
//     ruling) and no need for it is in evidence — deliberately out, not
//     forgotten. Re-classifying stays a propose-and-rule act.
//   · `anchorNodeId` has its own verb (`node anchor`), `tags` have `/tags/:id`,
//     `sources` are provenance and are never rewritten in place.
//
// Contract 8 holds: this writes EXACTLY what it is given. No trimming, no
// title-casing, no re-deriving anything from the new text, no auto-relate.
//
// SEARCH (the plan's sub-question 2, FALSIFIED): nodes are NOT in any FTS
// table. search.ts matches nodes with a live `LIKE` over the `nodes` table
// itself (docs_fts / messages_fts index docs and messages only), so an edit is
// visible to search the instant it commits and there is no index to keep in
// sync. The "an edit that doesn't re-index silently corrupts search" risk does
// not exist here — but it is pinned by a test rather than left as a claim,
// because it would become real the day node search moves to FTS.

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import { type Node, readNodeById } from "./state.ts";

interface EditNodeInput {
  title?: string;
  synopsis?: string;
}

const EDITABLE = 'expected {"title"?: string, "synopsis"?: string} — at least one';

// Returns null for an unknown node (the server 404s); throws a named intake
// error for an empty or ill-shaped patch (the jobs-update precedent).
function editNode(db: Database, bus: EventBus, id: string, input: EditNodeInput): Node | null {
  const hasTitle = input.title !== undefined;
  const hasSynopsis = input.synopsis !== undefined;
  if (!hasTitle && !hasSynopsis) {
    throw new Error(
      `node edit needs something to write — ${EDITABLE}. tier is the human's ruling and kind is a ratification-time classification; neither is editable (re-propose to re-classify)`,
    );
  }
  if (hasTitle && (typeof input.title !== "string" || input.title.trim() === "")) {
    // A title is a search key AND the SEAM 2 resolution key — an empty one
    // would make the node unaddressable by every name it has.
    throw new Error(
      `node edit title must be a non-empty string (it is the search key and the \`title:\` endpoint-resolution key) — ${EDITABLE}`,
    );
  }
  if (hasSynopsis && typeof input.synopsis !== "string") {
    // "" IS allowed — clearing a synopsis is a legitimate edit.
    throw new Error(`node edit synopsis must be a string (empty string clears it) — ${EDITABLE}`);
  }
  if (!db.query("SELECT 1 FROM nodes WHERE id = ?").get(id)) return null;

  // Only the provided fields are written — a patch, never a wholesale replace
  // (an omitted synopsis must not blank an existing one).
  if (hasTitle) db.run("UPDATE nodes SET title = ? WHERE id = ?", [input.title as string, id]);
  if (hasSynopsis) {
    db.run("UPDATE nodes SET synopsis = ? WHERE id = ?", [input.synopsis as string, id]);
  }

  // Re-read through the SINGLE reader so the payload is byte-identical to
  // /state.nodes[] — never hand-assemble an entity a replace-by-id consumer
  // holds (the standing re-emit rule).
  const node = readNodeById(db, id) as Node;
  bus.emit("node.edited", node as unknown as Record<string, unknown>);
  return node;
}

export type { EditNodeInput };
export { editNode };
