// Round 7 (TAGS) — per-target freeform tags: an agent-curated folksonomy pinned
// to a node or a PENDING proposal. The exact twin of node_actions (Round 4,
// A1): target-keyed wholesale-upsert metadata, engine-owned (the shape IS
// validated at intake — the opaque-draft doctrine covers agent extraction
// drafts, not this). FREEFORM by ruling: the engine stores strings; curation
// (reuse-suggestion = autocomplete over existing tags) is a SURFACE concern.
//
// Storage: node_tags (target_id PK, tags_json) — wholesale upsert per target,
// empty array (or DELETE) clears. Lifecycle rides the target's owners exactly
// as node_actions: ratify re-homes the row onto the freshly minted node id,
// reject deletes it, edge accept deletes it, zone delete cascades it, promote
// is a no-op (the proposal id survives the move).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";

// Hard byte-cap on the serialized json — a folksonomy stays naturally small,
// so (unlike actions) there's no advisory soft-cap; the byte cap only stops
// abuse from ballooning a snapshot.
const TAGS_BYTE_CAP = 16 * 1024;

interface SetTagsResult {
  targetId: string;
  tags: string[];
}

// Freeform, but not shapeless — a non-array or a non-string entry is a loud
// intake error (the parseActions parse-guard, minus the object triple). Tags
// ride verbatim: no trim/dedup/lowercase here (that's surface curation).
function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("tags must be an array of strings (empty array clears)");
  }
  return raw.map((entry, i) => {
    if (typeof entry !== "string") {
      throw new Error(`tags[${i}] is not a string — tags are freeform strings`);
    }
    return entry;
  });
}

// A target is a real node or a PENDING proposal — anything else is null (the
// server 404s). A ratified/rejected proposal is NOT a valid target: its tags
// either re-homed to the node or died with the ruling. Byte-identical to
// actions.ts's resolveTarget (the disjoint-UUID-space + pending lifecycle).
function resolveTarget(db: Database, targetId: string): "node" | "proposal" | null {
  if (db.query("SELECT 1 FROM nodes WHERE id = ?").get(targetId)) return "node";
  const proposal = db.query("SELECT status FROM proposals WHERE id = ?").get(targetId) as {
    status: string;
  } | null;
  if (proposal?.status === "pending") return "proposal";
  return null;
}

function setTags(
  db: Database,
  bus: EventBus,
  targetId: string,
  rawTags: unknown,
): SetTagsResult | null {
  if (resolveTarget(db, targetId) === null) return null;
  const tags = parseTags(rawTags);

  if (tags.length === 0) {
    db.run("DELETE FROM node_tags WHERE target_id = ?", [targetId]);
    bus.emit("tags.set", { targetId, tags: [] });
    return { targetId, tags: [] };
  }

  const json = JSON.stringify(tags);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > TAGS_BYTE_CAP) {
    throw new Error(
      `tags payload is ${bytes} bytes — over the ${TAGS_BYTE_CAP}-byte cap; trim the list`,
    );
  }
  db.run(
    "INSERT INTO node_tags (target_id, tags_json) VALUES (?, ?) ON CONFLICT(target_id) DO UPDATE SET tags_json = excluded.tags_json",
    [targetId, json],
  );
  bus.emit("tags.set", { targetId, tags });
  return { targetId, tags };
}

function clearTags(db: Database, bus: EventBus, targetId: string): SetTagsResult | null {
  return setTags(db, bus, targetId, []);
}

// The /state merge input: every stored tag list keyed by target id (state.ts
// attaches them onto nodes[] AND proposals[] AND readProposalById; absent =
// none). Written on the propose path too (buildProposal's insert closure), so
// this reads both agent-set and propose-time tags uniformly.
function readTags(db: Database): Map<string, string[]> {
  const rows = db.query("SELECT target_id, tags_json FROM node_tags").all() as Array<{
    target_id: string;
    tags_json: string;
  }>;
  const out = new Map<string, string[]>();
  for (const row of rows) {
    try {
      out.set(row.target_id, JSON.parse(row.tags_json) as string[]);
    } catch {
      // A corrupt row never crashes a snapshot — it just doesn't render.
    }
  }
  return out;
}

export type { SetTagsResult };
export { clearTags, parseTags, readTags, setTags, TAGS_BYTE_CAP };
