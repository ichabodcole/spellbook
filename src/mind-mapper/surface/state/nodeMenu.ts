// R4 R1 — ratify-anywhere menu derivation (pure). The context-menu chassis
// (NodeContextMenu) renders the same ruling verbs the ReviewQueue offers,
// looked up by SYNTHETIC node id (a pending proposal's overlay node carries
// the proposal's own id, pendingOverlay.ts). Derivation over the INCLUSIVE
// proposals store, view-blind (the R3 segregation-at-derivation lesson):
// zoned rows get menu entries too — the daemon's typed 409 {error:"zoned"}
// is the honest refusal, never a hidden verb.
//
// Claim-D asymmetry mirrored from the queue: a user-authored sketch awaits
// its doc home, so the menu offers withdraw ONLY — never a ratify the daemon
// would refuse.

import type { ActionSlot, MapNode, Proposal, Ruling } from "../types";

// The tiers that are also valid accept-rulings. `background` is a Tier but
// NOT a Ruling (the engine's union stops at story-local) — a
// background-suggested proposal has no one-keystroke accept, so ratifyAs
// narrows to null there rather than offering a ratify the daemon refuses;
// the queue's tier picker remains its ratification home.
const ACCEPT_RULINGS = new Set(["canon", "thread", "story-local"]);

export type RulingInfo = {
  proposalId: string;
  // The one-keystroke accept (= suggestedTier), or null when the suggestion
  // isn't a rulable tier.
  ratifyAs: Exclude<Ruling, "reject"> | null;
  author: "user" | "agent";
};

export type NodeMenuInfo = {
  // Present iff the menu's target is a PENDING proposal (ratified/rejected
  // rows never render on the board, and real nodes have nothing to rule).
  ruling?: RulingInfo;
  // R4 A1 — agent-suggested action slots, from state.nodes[].actions AND
  // state.proposals[].actions (absent = none on the wire; only non-empty
  // arrays land here so renderers need no length guard).
  actions?: ActionSlot[];
};

// One map serves both views (canvas + card grid) — keyed by the id the
// rendered node actually wears (a pending proposal's synthetic node carries
// the proposal's own id, so proposal-attached slots resolve for free).
export function menuInfoFor(nodes: MapNode[], proposals: Proposal[]): Map<string, NodeMenuInfo> {
  const menus = new Map<string, NodeMenuInfo>();
  for (const n of nodes) {
    if (n.actions && n.actions.length > 0) menus.set(n.id, { actions: n.actions });
  }
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    const ratifyAs = ACCEPT_RULINGS.has(p.suggestedTier)
      ? (p.suggestedTier as Exclude<Ruling, "reject">)
      : null;
    menus.set(p.id, {
      ruling: { proposalId: p.id, ratifyAs, author: p.author },
      ...(p.actions && p.actions.length > 0 ? { actions: p.actions } : {}),
    });
  }
  return menus;
}

// The ruling fetch's error surface (promoteProposal precedent: body.error
// verbatim into the notice bar). The one TYPED refusal — 409
// {error:"zoned", zoneId} (Contract 9 R4) — gets said in full: the verb
// stays visible everywhere, so the refusal must teach the way out.
export function rulingErrorMessage(status: number, body: unknown): string {
  const err = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  if (status === 409 && err === "zoned") {
    const zoneId = (body as { zoneId?: unknown }).zoneId;
    const where = typeof zoneId === "string" ? ` "${zoneId}"` : "";
    return `it's still in zone${where} — promote it first (ratification is a main-queue act)`;
  }
  return typeof err === "string" ? err : `ruling ${status}`;
}
