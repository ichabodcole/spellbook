// Round 12 (SEAM 3) — "what changed", ruled and BOUNDED.
//
// ── FALSIFICATION of the plan's stated blockers ─────────────────────────────
//
// (b) is FALSE. The plan says "`nodes`, `edges` and `proposals` carry no `ts`
// column at all (only `zones`, `doc_marks`, `messages` do)". They all carry
// `created_at INTEGER NOT NULL DEFAULT (unixepoch())`, and always have (db.ts
// — docs too). So an additions delta needs ZERO migration; the choice was never
// "add ts or give up", it was "how much can be DERIVED honestly".
//
// (a) is TRUE and it binds. Contract 8 ratifies no durable event log, and the
// plan asked whether an append-only `changes` table (option B) violates that
// clause or is orthogonal to it. RULING: it is the clause, not orthogonal to
// it. The clause's rationale is that events are DERIVED FROM STATE and a
// snapshot is the sole gap recovery — a table whose whole purpose is to let an
// agent resume `--since` IS a durable event log, whatever it is named. Two
// engineering reasons agree with the contract: (1) it would need a write at
// every one of ~25 mutation sites that no test forces to stay in sync — the
// mirror-drift trap that has already bitten this repo twice (the bounty surface
// mirror; `propose-node --stdin` silently dropping tags), and a delta that
// silently misses a mutation site is WORSE than no delta, which is this seam's
// own stated standard; (2) retention/vacuum would be unowned.
//
// ── What is built instead: additions-only, DERIVED, and self-declaring ──────
//
// Everything here is a pure read over columns that already exist. It cannot
// drift from the mutation sites because it does not touch them. It is
// deliberately NOT the whole answer, and the whole point of the shape is that
// it SAYS SO: `notCovered` is the response's largest field, modelled on the
// `--inbound` grounding line's `notWatching`, which drive #10 singled out as
// the best agent-facing design in the system ("interfaces that state what they
// DON'T cover are worth more than more capability"). An agent that trusts a
// delta which silently omits deletions is worse off than one that refetches —
// so this one never omits silently.
//
// Bonus property worth naming: `created_at` is DURABLE, so `/changes` survives
// a daemon restart. It is the only resumable-across-restart read in the system
// (the event bus resets its cursor and mints a new epoch on every boot).

import type { Database } from "bun:sqlite";
import type { ProjectMeta } from "./project.ts";
import { type ProjectState, readState } from "./state.ts";

interface ChangesResult {
  since: number;
  now: number;
  granularity: "seconds";
  inclusive: true;
  additions: {
    nodes: ProjectState["nodes"];
    edges: ProjectState["edges"];
    proposals: ProjectState["proposals"];
    docs: ProjectState["docs"];
    zones: ProjectState["zones"];
    messages: ProjectState["conversation"];
  };
  counts: Record<string, number>;
  notCovered: string[];
  note: string;
}

// The blind spots, stated once and returned on EVERY response. Adding a verb
// that mutates without creating a row means adding a line here.
const NOT_COVERED = [
  "DELETIONS of anything (node, edge, proposal, doc, zone) — a delete drops the row, so a deleted entity is indistinguishable from one that never existed",
  "proposal REJECTIONS and any other status flip that mints no row (a ratify DOES appear here, as the node/edge it created; a reject does not)",
  "EDITS in place: node.edited (title/synopsis), doc kind, doc marks, tags, actions, anchors (node.anchored), zone moves (proposal.promoted), lens",
  "jobs — the jobs table timestamps in epoch MILLISECONDS, a different unit from this query's seconds; mixing them in one watermark would be a silent off-by-1000",
  "WHO acted: nothing here is attributable to the human vs the agent (Contract 10's actor-tagging deferral is unchanged)",
];

const NOTE =
  "ADDITIONS ONLY, derived from created_at — this is a reconciliation AID, not a replacement for a full /state refetch, and NOT a replacement for actor tagging. Read notCovered before trusting an empty response: 'nothing added' is not 'nothing changed'. Pass `now` as your next `since`. `since` is INCLUSIVE and the granularity is whole seconds, so entities created in the boundary second may repeat (over-reporting is the safe direction). Unlike the event bus this survives a daemon restart — created_at is durable, cursors and epochs are not.";

function readChanges(
  db: Database,
  project: ProjectMeta,
  since: number,
  projectRoot?: string,
): ChangesResult {
  if (!Number.isFinite(since) || !Number.isInteger(since) || since < 0) {
    throw new Error(
      `since must be a non-negative integer in epoch SECONDS (use 0 for everything, then pass back the \`now\` from a previous response), got: ${JSON.stringify(since)}`,
    );
  }
  // Read the world through the ONE reader, then narrow by id — so every entity
  // in a delta is byte-identical to its /state entry (the single-source-reader
  // rule: never hand-assemble an entity a consumer will merge).
  const state = readState(db, project, 0, "", projectRoot);
  const idsSince = (table: string, column = "created_at"): Set<string> =>
    new Set(
      (
        db.query(`SELECT id FROM ${table} WHERE ${column} >= ?`).all(since) as Array<{
          id: string;
        }>
      ).map((r) => r.id),
    );
  const nodeIds = idsSince("nodes");
  const edgeIds = idsSince("edges");
  const proposalIds = idsSince("proposals");
  const docIds = idsSince("docs");
  const zoneIds = idsSince("zones", "ts");

  const additions = {
    nodes: state.nodes.filter((n) => nodeIds.has(n.id)),
    edges: state.edges.filter((e) => edgeIds.has(e.id)),
    proposals: state.proposals.filter((p) => proposalIds.has(p.id)),
    docs: state.docs.filter((d) => docIds.has(d.id)),
    zones: state.zones.filter((z) => zoneIds.has(z.id)),
    // messages carry their own ts on the wire already.
    messages: state.conversation.filter((m) => m.ts >= since),
  };

  return {
    since,
    now: Math.floor(Date.now() / 1000),
    granularity: "seconds",
    inclusive: true,
    additions,
    counts: Object.fromEntries(
      Object.entries(additions).map(([key, list]) => [key, list.length]),
    ) as Record<string, number>,
    notCovered: [...NOT_COVERED],
    note: NOTE,
  };
}

export type { ChangesResult };
export { NOT_COVERED, readChanges };
