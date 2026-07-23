// P1 wire reducer (plan/circe.md P1.2) — applies one daemon ServerEvent onto
// a ProjectState snapshot. Per-entity patch semantics only (the wire-schema
// addendum ratified on the vine, msg 4): every known kind appends or upserts
// a single entity, never replaces a whole array wholesale. Unknown kinds are
// ignored, not thrown — a peripheral wire surprise must never take the board
// down (the reflex in circe's seat doc) — but the cursor still advances,
// since the event still consumed a seq the bus won't reissue.

import type {
  ActionSlot,
  DocMark,
  DocMeta,
  Job,
  Lens,
  ProjectState,
  Proposal,
  ServerEvent,
  WireMessage,
  Zone,
} from "../types";

// A resumed/duplicate event (seq <= cursor) is a no-op — dedupe on WS
// reconnect. A skipped seq (seq > cursor + 1) is a genuine gap: the caller
// (useProjectState) must refetch /state wholesale rather than patch around
// the hole.
export function isGap(cursor: number, seq: number): boolean {
  return seq > cursor + 1;
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

// node.ratified/edge.ratified carry ONLY {id, proposalId} (ratify.ts) — never
// the full ratified entity, so there's nothing here to upsert into
// nodes/edges. What the reducer CAN do purely from this payload: flip the
// matching proposal out of "pending" immediately, so the review badge and
// the pendingOverlay-derived synthetic node/edge clear without waiting on
// anything else. useProjectState is responsible for the follow-up snapshot
// refetch that backfills the real new node/edge — this bug (badge/queue
// staleness after an in-UI ruling, cassandra's P3 gate finding, t-bdd3136e)
// was exactly this half being silently skipped.
function markProposalRatified(proposals: Proposal[], proposalId: unknown): Proposal[] {
  if (typeof proposalId !== "string") return proposals;
  const i = proposals.findIndex((p) => p.id === proposalId);
  if (i === -1) return proposals;
  const next = proposals.slice();
  const target = next[i];
  if (target) next[i] = { ...target, status: "ratified" };
  return next;
}

export function applyEvent(state: ProjectState, event: ServerEvent): ProjectState {
  if (event.seq <= state.cursor) return state;

  switch (event.kind) {
    case "doc.added":
      return { ...state, docs: [...state.docs, event.payload as DocMeta], cursor: event.seq };
    case "doc.deleted": {
      // Thin event ({id} only, Claim A) — nodes SURVIVE a doc delete
      // (map-as-view: deleting a source doesn't un-ratify the claim), so
      // only docs[] filters; stale source refs are tolerated by consumers.
      const { id } = event.payload as { id?: unknown };
      return { ...state, docs: state.docs.filter((d) => d.id !== id), cursor: event.seq };
    }
    case "doc.kind": {
      // R4 K1 — {docId, kind, author}: kind already wire-normalized (null,
      // never ''); a clear (kind null) un-attributes too (author null),
      // which the payload carries by construction.
      const { docId, kind, author } = event.payload as {
        docId?: unknown;
        kind?: unknown;
        author?: unknown;
      };
      if (typeof docId !== "string") return { ...state, cursor: event.seq };
      const nextKind = typeof kind === "string" ? kind : null;
      const nextAuthor = author === "user" || author === "agent" ? author : null;
      return {
        ...state,
        docs: state.docs.map((d) =>
          d.id === docId ? { ...d, kind: nextKind, kindAuthor: nextAuthor } : d,
        ),
        cursor: event.seq,
      };
    }
    case "doc.marked": {
      // Full mark inline (Claim B ruling — marks are small and append-only;
      // thin-refetch is for mutable entities). `stale` never rides the
      // event: a just-made mark was minted against the current file, so
      // false is true by construction until the next /state read says
      // otherwise.
      const { docId, mark } = event.payload as { docId?: unknown; mark?: DocMark };
      if (typeof docId !== "string" || !mark) return { ...state, cursor: event.seq };
      return {
        ...state,
        docs: state.docs.map((d) =>
          d.id === docId ? { ...d, mark: { ...mark, stale: false } } : d,
        ),
        cursor: event.seq,
      };
    }
    case "node.deleted": {
      // Round 6 (DEL) — THIN {id}, but a server FORCE delete cascaded more
      // than the node: it dropped every edge touching the node and re-parented
      // its anchored children to top-level. The thin payload can't carry that,
      // and node.deleted is NOT on useProjectState's ratified-refetch path, so
      // the reducer reconciles it LOCALLY (co-presence: the human sees the
      // cascade immediately, no round-trip). submapChildCount on a FORMER
      // parent of the deleted node may drift by one until the next /state read
      // (the node.anchored derived-count tolerance) — a rare, self-correcting
      // cosmetic, never a dangling edge or an orphaned child.
      const { id } = event.payload as { id?: unknown };
      if (typeof id !== "string") return { ...state, cursor: event.seq };
      return {
        ...state,
        nodes: state.nodes
          .filter((n) => n.id !== id)
          .map((n) => (n.anchorNodeId === id ? { ...n, anchorNodeId: null } : n)),
        edges: state.edges.filter((e) => e.source !== id && e.target !== id),
        cursor: event.seq,
      };
    }
    case "proposal.deleted": {
      // Round 6 (DEL) — THIN {id}, hard remove: drop the proposal row (the
      // litter-clearing path; mirrors the doc.deleted filter). A dependent
      // pending edge lives only in opaque draft_json and fails safe at its own
      // ratify (Contract 8) — nothing else to reconcile here.
      const { id } = event.payload as { id?: unknown };
      if (typeof id !== "string") return { ...state, cursor: event.seq };
      return {
        ...state,
        proposals: state.proposals.filter((p) => p.id !== id),
        cursor: event.seq,
      };
    }
    case "proposal.rejected": {
      // Round 6 (REJECT, finding #3) — THIN {id}: reject is decline-WITH-history
      // (DISTINCT from delete's hard remove), so flip the row's status to
      // "rejected" rather than dropping it. Every board overlay filters to
      // status === "pending" (pendingOverlay / mainProposals / review queue), so
      // the flip makes the proposal leave the canvas + queue WITHOUT a refetch —
      // the live fix for reject previously emitting nothing.
      const { id } = event.payload as { id?: unknown };
      if (typeof id !== "string") return { ...state, cursor: event.seq };
      return {
        ...state,
        proposals: state.proposals.map((p) => (p.id === id ? { ...p, status: "rejected" } : p)),
        cursor: event.seq,
      };
    }
    case "node.ratified":
    case "edge.ratified": {
      const payload = event.payload as { id: string; proposalId?: unknown };
      return {
        ...state,
        proposals: markProposalRatified(state.proposals, payload.proposalId),
        cursor: event.seq,
      };
    }
    // The payload is the full tagged Proposal (zoneId always carried, Claim
    // Z1) — the upsert lands it in the INCLUSIVE store untouched; views
    // segregate by zoneId at render, so this one rule serves snapshot merge
    // and event ingestion identically.
    case "proposal.added":
      return {
        ...state,
        proposals: upsertById(state.proposals, event.payload as Proposal),
        cursor: event.seq,
      };
    case "zone.created": {
      const zone = event.payload as Zone;
      if (typeof zone?.id !== "string") return { ...state, cursor: event.seq };
      return {
        ...state,
        zones: state.zones.some((z) => z.id === zone.id) ? state.zones : [...state.zones, zone],
        cursor: event.seq,
      };
    }
    case "zone.deleted": {
      // Thin ({id} only, Claim Z1) — the delete cascaded the zone's
      // proposals server-side, so consumers drop that zone's rows locally: a
      // SCOPED drop, never a wholesale replace (main-queue and other-zone
      // proposals are untouched by construction).
      const { id } = event.payload as { id?: unknown };
      if (typeof id !== "string") return { ...state, cursor: event.seq };
      return {
        ...state,
        zones: state.zones.filter((z) => z.id !== id),
        proposals: state.proposals.filter((p) => p.zoneId !== id),
        cursor: event.seq,
      };
    }
    case "proposal.promoted": {
      // Thin ({id} only, Claim Z2) — promotion is a MOVE: with the inclusive
      // store the reducer's whole job is clearing zoneId on the row, which
      // re-homes it to the main review queue at render. Draft/evidence/
      // status untouched (it stays a normal pending item).
      const { id } = event.payload as { id?: unknown };
      if (typeof id !== "string") return { ...state, cursor: event.seq };
      return {
        ...state,
        proposals: state.proposals.map((p) => (p.id === id ? { ...p, zoneId: null } : p)),
        cursor: event.seq,
      };
    }
    case "actions.set": {
      // Round 4 (A1) — WHOLESALE metadata replace, the one deliberate
      // exception to per-entity patching (the slots are metadata riding a
      // node/pending proposal, not an entity of their own). Empty array
      // clears back to wire absence. The ratify re-home emits NO actions.set
      // — the thin ratified event's snapshot refetch carries the slots onto
      // the minted node, so this case never has to move them.
      const { targetId, actions } = event.payload as {
        targetId?: unknown;
        actions?: unknown;
      };
      if (typeof targetId !== "string" || !Array.isArray(actions)) {
        return { ...state, cursor: event.seq };
      }
      const slots = actions as ActionSlot[];
      const apply = <T extends { id: string; actions?: ActionSlot[] }>(list: T[]): T[] =>
        list.map((item) => {
          if (item.id !== targetId) return item;
          const { actions: _dropped, ...rest } = item;
          return slots.length > 0 ? ({ ...rest, actions: slots } as T) : (rest as unknown as T);
        });
      return {
        ...state,
        nodes: apply(state.nodes),
        proposals: apply(state.proposals),
        cursor: event.seq,
      };
    }
    case "tags.set": {
      // Round 7 (TAGS) — WHOLESALE metadata replace, the actions.set precedent
      // (freeform tags ride a node/pending proposal, not an entity of their
      // own). A FULL-array replace, never a merge — `tags.set` is exactly like
      // `actions.set` in this respect. Empty array clears back to wire absence
      // (absent = none). Disjoint id spaces, so one pass over both is
      // unambiguous.
      const { targetId, tags } = event.payload as {
        targetId?: unknown;
        tags?: unknown;
      };
      if (typeof targetId !== "string" || !Array.isArray(tags)) {
        return { ...state, cursor: event.seq };
      }
      const list = tags as string[];
      const apply = <T extends { id: string; tags?: string[] }>(items: T[]): T[] =>
        items.map((item) => {
          if (item.id !== targetId) return item;
          const { tags: _dropped, ...rest } = item;
          return list.length > 0 ? ({ ...rest, tags: list } as T) : (rest as unknown as T);
        });
      return {
        ...state,
        nodes: apply(state.nodes),
        proposals: apply(state.proposals),
        cursor: event.seq,
      };
    }
    case "node.anchored": {
      // Round 5 (SG1) — THIN {nodeId, anchorNodeId}: flip the referenced
      // node's anchorNodeId locally (the one thing the payload proves). The
      // derived submapChildCount can shift on the OTHER end (an old/new
      // parent), which this thin event can't carry — the ratified-events
      // doctrine covers it: a snapshot refetch backfills the true counts.
      // (Anchor is a rare, deliberate act; the surface's own moves already
      // re-fetch, and an agent's move is corrected on the next /state read.)
      const { nodeId, anchorNodeId } = event.payload as {
        nodeId?: unknown;
        anchorNodeId?: unknown;
      };
      if (typeof nodeId !== "string") return { ...state, cursor: event.seq };
      const nextAnchor = typeof anchorNodeId === "string" ? anchorNodeId : null;
      return {
        ...state,
        nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, anchorNodeId: nextAnchor } : n)),
        cursor: event.seq,
      };
    }
    // Round 9 (Job Queue, SEAM B) — job.added/updated/claimed carry the FULL
    // Job entity (D3), so the reducer does a wholesale replace-by-id (the
    // tags.set/actions.set idiom, but jobs ARE their own entity so it's a
    // straight upsert into jobs[], not a metadata copy onto another row).
    // job.claimed is the acquisition signal kept distinct on the wire; the
    // surface collapses it through the SAME replace-by-id case (both carry the
    // full entity) — a distinct surface animation could split it later, but the
    // reducer's job is identical either way.
    case "job.added":
    case "job.updated":
    case "job.claimed": {
      const jobPayload = event.payload as Job;
      if (typeof jobPayload?.id !== "string") return { ...state, cursor: event.seq };
      return { ...state, jobs: upsertById(state.jobs, jobPayload), cursor: event.seq };
    }
    case "job.deleted": {
      // Thin {id} (D3) — mirror the doc.deleted / proposal.deleted filter.
      const { id } = event.payload as { id?: unknown };
      if (typeof id !== "string") return { ...state, cursor: event.seq };
      return { ...state, jobs: state.jobs.filter((j) => j.id !== id), cursor: event.seq };
    }
    case "message.posted":
      return {
        ...state,
        conversation: [...state.conversation, event.payload as WireMessage],
        cursor: event.seq,
      };
    case "lens.set":
      return { ...state, lens: event.payload as Lens, cursor: event.seq };
    case "presence.changed": {
      const { agents } = event.payload as { agents?: unknown };
      if (typeof agents !== "number") return { ...state, cursor: event.seq };
      return { ...state, presence: { agents }, cursor: event.seq };
    }
    // Ephemeral kinds (look.here, agent.activity) fall through to the
    // default ON PURPOSE — the ephemeral-event cursor clause (Contract 9
    // amendment): every emit consumed a seq, so the cursor must advance
    // here even though no state row changes; useProjectState surfaces the
    // signal separately via the {payload, seq} idiom. Early-returning
    // around the reducer is the bug this clause exists to kill (a
    // permanently-stale cursor reads every later event as a gap → a
    // wholesale refetch per agent.activity signal).
    default:
      return { ...state, cursor: event.seq };
  }
}
