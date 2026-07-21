// Round 3 (Claims Z1/Z2) — zones: named staging pens for proposals, and
// promotion out of them. A zone is a place where everything is staging and
// mess is licensed; the map-as-view litmus applies only at the promotion
// boundary. Zone contents are PROPOSALS ONLY — nodes/edges never carry a
// zone_id. The daemon stays dumb (Contract 8): zones/promotion are storage
// moves, nothing else.
//
// Wire notes (ratified): zone ids are SLUGS derived from the name (same
// derivation as `projects --create`) — conversational referenceability; no
// rename this round. Events are project-scoped and can never be zone-scoped
// (one bus per project), so payload-tagging is the mechanism: the Proposal
// wire type carries `zoneId` and consumers filter — zone.created/zone.deleted
// are THIN, and on zone.deleted consumers drop that zone's proposals locally
// (scoped drop, never wholesale replace).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import { SLUG_RE } from "./project.ts";

interface Zone {
  id: string;
  name: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createZone(db: Database, bus: EventBus, name: string): Zone {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("zone create requires a name");
  }
  const id = slugify(name);
  if (!SLUG_RE.test(id)) throw new Error(`zone name does not yield a valid slug: ${name}`);
  if (db.query("SELECT 1 FROM zones WHERE id = ?").get(id)) {
    throw new Error(`zone already exists: ${id}`);
  }
  db.run("INSERT INTO zones (id, name) VALUES (?, ?)", [id, name]);
  const zone: Zone = { id, name };
  bus.emit("zone.created", { id, name });
  return zone;
}

function listZones(db: Database): Zone[] {
  return db.query("SELECT id, name FROM zones ORDER BY ts, id").all() as Zone[];
}

// A zone-not-empty guard mirroring doc delete's cited flow: deleting a zone
// discards its proposals wholesale (the disposable-sandbox property), so a
// populated zone needs an explicit yes — the error carries the count the
// confirm affordance renders.
class ZoneNotEmptyError extends Error {
  proposals: number;
  constructor(proposals: number) {
    super(`zone holds ${proposals} proposal(s) — pass --yes to delete them with it`);
    this.name = "ZoneNotEmptyError";
    this.proposals = proposals;
  }
}

// Returns null for an unknown (or non-slug) id — the server 404s first,
// before any not-empty/yes reasoning.
function deleteZone(db: Database, bus: EventBus, id: string, yes: boolean): { id: string } | null {
  if (!SLUG_RE.test(id)) return null;
  if (!db.query("SELECT 1 FROM zones WHERE id = ?").get(id)) return null;
  const count = (
    db.query("SELECT COUNT(*) as n FROM proposals WHERE zone_id = ?").get(id) as { n: number }
  ).n;
  if (!yes && count > 0) throw new ZoneNotEmptyError(count);
  // A1: the zone's proposals take their action slots with them (delete the
  // slots BEFORE the proposals — the target ids are about to vanish).
  db.run(
    "DELETE FROM node_actions WHERE target_id IN (SELECT id FROM proposals WHERE zone_id = ?)",
    [id],
  );
  db.run("DELETE FROM proposals WHERE zone_id = ?", [id]);
  db.run("DELETE FROM zones WHERE id = ?", [id]);
  bus.emit("zone.deleted", { id });
  return { id };
}

// Claim Z2 — promotion: MOVE, not duplicate (ruled). Clears zone_id (UPDATE
// only — draft/provenance/evidence rows untouched) so the proposal appears in
// the main review queue as a normal pending item; the zone keeps no
// tombstone. Ratification stays a main-graph act: ratify() refuses a
// still-zoned proposal ("promote first"), and this is the only exit a zoned
// proposal has besides dying with its zone.
//
// Edge endpoint-order mirror (same resolve-order rule as ratify): an edge
// proposal whose draft endpoints reference NODE PROPOSALS may only promote
// after (or with) those endpoints — the error names the unpromoted endpoint
// so the caller knows exactly what to promote first. Real node ids (and refs
// that resolve to nothing yet — ratify owns dangling-ref errors) pass.
function promote(db: Database, bus: EventBus, proposalId: string): { id: string } {
  const row = db
    .query("SELECT id, kind, draft_json, status, zone_id FROM proposals WHERE id = ?")
    .get(proposalId) as {
    id: string;
    kind: string;
    draft_json: string;
    status: string;
    zone_id: string | null;
  } | null;
  if (!row) throw new Error(`unknown proposal: ${proposalId}`);
  if (row.status !== "pending") {
    throw new Error(
      `proposal ${proposalId} already ${row.status} — promote is for pending proposals`,
    );
  }
  if (row.zone_id === null) {
    throw new Error(`proposal ${proposalId} is not in a zone — nothing to promote`);
  }

  if (row.kind === "edge") {
    const draft = JSON.parse(row.draft_json) as Record<string, unknown>;
    for (const end of ["source", "target"] as const) {
      const ref = String(draft[end]);
      const endpoint = db.query("SELECT id, zone_id FROM proposals WHERE id = ?").get(ref) as {
        id: string;
        zone_id: string | null;
      } | null;
      if (endpoint && endpoint.zone_id !== null) {
        throw new Error(
          `edge ${end} references proposal ${ref}, still in zone ${endpoint.zone_id} — promote it first`,
        );
      }
    }
  }

  db.run("UPDATE proposals SET zone_id = NULL WHERE id = ?", [proposalId]);
  // Thin (like the ratified events): consumers with the inclusive store
  // clear zoneId on the row locally; no denormalized payload.
  bus.emit("proposal.promoted", { id: proposalId });
  return { id: proposalId };
}

export type { Zone };
export { createZone, deleteZone, listZones, promote, ZoneNotEmptyError };
