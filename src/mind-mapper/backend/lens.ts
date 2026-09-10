// P3 — `lens set --node <id> [--depth <n>] | lens clear` and `look-here
// <nodeId>` backing. Lens is addressable, persisted view-state (writable
// from both sides — human clicks, agent steers via conversation); look-here
// is a fire-once nudge with no backing table, distinct from lens (plan.md's
// ratified distinction).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import type { Lens } from "./state.ts";

// Round 3 (Claim V2): the upsert writes EVERY column, so node-lens XOR
// doc-lens holds by construction — setting one mode always nulls the other
// (one lens row per project; no stale doc_id can survive a node set).
function setLens(db: Database, bus: EventBus, projectId: string, lens: Lens): Lens {
  db.run(
    "INSERT INTO lens (project_id, owner, node_id, depth, doc_id) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(project_id) DO UPDATE SET owner = excluded.owner, node_id = excluded.node_id, depth = excluded.depth, doc_id = excluded.doc_id",
    [projectId, lens.owner, lens.nodeId, lens.depth, lens.docId],
  );
  // lens.set ALWAYS carries docId (null on a node lens) — additive-optional.
  bus.emit("lens.set", lens as unknown as Record<string, unknown>);
  return lens;
}

function clearLens(db: Database, bus: EventBus, projectId: string): void {
  db.run("DELETE FROM lens WHERE project_id = ?", [projectId]);
  bus.emit("lens.set", { owner: null, nodeId: null, depth: null, docId: null });
}

function lookHere(bus: EventBus, nodeId: string): void {
  // Distinct event kind, per the ratified verb design: look-here is a
  // fire-once viewport nudge, NOT a lens change — reusing "lens.set" here
  // clobbered the surface's lens state and never moved the viewport
  // (plan-alignment review finding, finalize flow).
  bus.emit("look.here", { nodeId });
}

export { clearLens, lookHere, setLens };
