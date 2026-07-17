// P1 wire reducer (plan/circe.md P1.2) — applies one daemon ServerEvent onto
// a ProjectState snapshot. Per-entity patch semantics only (the wire-schema
// addendum ratified on the vine, msg 4): every known kind appends or upserts
// a single entity, never replaces a whole array wholesale. Unknown kinds are
// ignored, not thrown — a peripheral wire surprise must never take the board
// down (the reflex in circe's seat doc) — but the cursor still advances,
// since the event still consumed a seq the bus won't reissue.

import type { DocMeta, Lens, ProjectState, Proposal, ServerEvent, WireMessage } from "../types";

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
    case "node.ratified":
    case "edge.ratified": {
      const payload = event.payload as { id: string; proposalId?: unknown };
      return {
        ...state,
        proposals: markProposalRatified(state.proposals, payload.proposalId),
        cursor: event.seq,
      };
    }
    case "proposal.added":
      return {
        ...state,
        proposals: upsertById(state.proposals, event.payload as Proposal),
        cursor: event.seq,
      };
    case "message.posted":
      return {
        ...state,
        conversation: [...state.conversation, event.payload as WireMessage],
        cursor: event.seq,
      };
    case "lens.set":
      return { ...state, lens: event.payload as Lens, cursor: event.seq };
    default:
      return { ...state, cursor: event.seq };
  }
}
