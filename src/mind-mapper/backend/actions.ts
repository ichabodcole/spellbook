// Round 4 (A1) — per-target action slots: agent-authored conversational
// shortcuts pinned to a node or a PENDING proposal (the stigmergy payoff —
// the agent leaves affordances on the board; a click seeds the composer,
// never auto-sends). Engine-owned metadata like the lens: agent-writable,
// not staged, never ratified — so shape IS validated at intake (the
// opaque-draft doctrine covers agent extraction drafts, not this).
//
// Storage: node_actions (target_id PK, actions_json) — wholesale upsert per
// target, empty array (or DELETE) clears. Lifecycle rides the target's
// owners: ratify re-homes the row onto the freshly minted node id, reject
// deletes it, zone delete cascades it with the zone's proposals, promote is
// a no-op (the proposal id survives the move).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";

interface ActionSlot {
  id: string;
  label: string;
  seed: string;
}

// Soft cap (advisory warning, edgeDraftWarning mechanism — additive response
// field, never stored) and the hard byte-cap on the serialized json.
const ACTIONS_SOFT_CAP = 4;
const ACTIONS_BYTE_CAP = 16 * 1024;

interface SetActionsResult {
  targetId: string;
  actions: ActionSlot[];
  // Advisory only — surfaces show 4 + scroll (cap the visible, never the
  // list); the daemon stores the full array.
  warning?: string;
}

function parseActions(raw: unknown): ActionSlot[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `the request body IS the action array — send a BARE JSON array of {"id","label","seed"} string triples (empty array clears), NOT {"actions":[...]}; got ${typeof raw === "object" && raw !== null ? `an object with keys: ${Object.keys(raw as object).join(", ")}` : typeof raw}`,
    );
  }
  return raw.map((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`actions[${i}] is not an object — expected {"id", "label", "seed"}`);
    }
    const { id, label, seed } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string" || typeof seed !== "string") {
      throw new Error(`actions[${i}] needs string id/label/seed`);
    }
    return { id, label, seed };
  });
}

// A target is a real node or a PENDING proposal — anything else is null (the
// server 404s). A ratified/rejected proposal is NOT a valid target: its
// actions either re-homed to the node or died with the ruling.
function resolveTarget(db: Database, targetId: string): "node" | "proposal" | null {
  if (db.query("SELECT 1 FROM nodes WHERE id = ?").get(targetId)) return "node";
  const proposal = db.query("SELECT status FROM proposals WHERE id = ?").get(targetId) as {
    status: string;
  } | null;
  if (proposal?.status === "pending") return "proposal";
  return null;
}

function setActions(
  db: Database,
  bus: EventBus,
  targetId: string,
  rawActions: unknown,
): SetActionsResult | null {
  if (resolveTarget(db, targetId) === null) return null;
  const actions = parseActions(rawActions);

  if (actions.length === 0) {
    db.run("DELETE FROM node_actions WHERE target_id = ?", [targetId]);
    bus.emit("actions.set", { targetId, actions: [] });
    return { targetId, actions: [] };
  }

  const json = JSON.stringify(actions);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > ACTIONS_BYTE_CAP) {
    throw new Error(
      `actions payload is ${bytes} bytes — over the ${ACTIONS_BYTE_CAP}-byte cap; trim the seeds`,
    );
  }
  db.run(
    "INSERT INTO node_actions (target_id, actions_json) VALUES (?, ?) ON CONFLICT(target_id) DO UPDATE SET actions_json = excluded.actions_json",
    [targetId, json],
  );
  bus.emit("actions.set", { targetId, actions: actions as unknown as Record<string, unknown>[] });
  const result: SetActionsResult = { targetId, actions };
  if (actions.length > ACTIONS_SOFT_CAP) {
    result.warning = `${actions.length} actions on one target — surfaces render ${ACTIONS_SOFT_CAP} plus scroll; consider fewer, sharper slots`;
  }
  return result;
}

function clearActions(db: Database, bus: EventBus, targetId: string): SetActionsResult | null {
  return setActions(db, bus, targetId, []);
}

// The /state merge input: every stored slot list keyed by target id (state.ts
// attaches them onto nodes[] AND proposals[]; absent = none).
function readActions(db: Database): Map<string, ActionSlot[]> {
  const rows = db.query("SELECT target_id, actions_json FROM node_actions").all() as Array<{
    target_id: string;
    actions_json: string;
  }>;
  const out = new Map<string, ActionSlot[]>();
  for (const row of rows) {
    try {
      out.set(row.target_id, JSON.parse(row.actions_json) as ActionSlot[]);
    } catch {
      // A corrupt row never crashes a snapshot — it just doesn't render.
    }
  }
  return out;
}

export type { ActionSlot, SetActionsResult };
export { ACTIONS_BYTE_CAP, ACTIONS_SOFT_CAP, clearActions, readActions, setActions };
