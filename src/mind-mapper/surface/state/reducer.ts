// P1 wire reducer (plan/circe.md P1.2) — applies one daemon ServerEvent onto
// a ProjectState snapshot. Per-entity patch semantics only (the wire-schema
// addendum ratified on the vine, msg 4): every known kind appends or upserts
// a single entity, never replaces a whole array wholesale. Unknown kinds are
// ignored, not thrown — a peripheral wire surprise must never take the board
// down (the reflex in circe's seat doc) — but the cursor still advances,
// since the event still consumed a seq the bus won't reissue.

import type {
  DocMark,
  DocMeta,
  Lens,
  ProjectState,
  Proposal,
  ServerEvent,
  WireMessage,
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
