// R6 QUEUE — the ingestion tray's pure derive. The tray is a client-only view
// over the SAME inclusive proposals store the canvas reads (no engine queue
// state this round — Contract 9 R6 ships zero): the items being curated are
// exactly the pending `author:"user"` proposals — raw human input the agent
// hasn't yet refined into a curated node. An item LEAVES the tray when it
// ratifies (status flips off "pending") or is deleted/rejected (the row drops
// or flips) — both already fire events the reducer applies, so the derive
// re-runs and the tray drains without any tray-specific bookkeeping.
//
// FUTURE SEAM (named, NOT built — Contract 9 R6 "DEFERRED SEAM"): the
// multi-agent work-queue lands `proposals.claimed_by` (additive-nullable
// column + a thin `proposal.claimed {id, claimedBy}` event + wire
// `Proposal.claimedBy: string | null`). When it exists, this derive gains a
// "who is refining this" column and the tray can show lease ownership /
// grey-out claimed items — the drop-in point for a fleet of curating agents.
// Until then it's YAGNI: one agent, one implicit lease.

import type { Proposal } from "../types";

export function processingItems(proposals: Proposal[]): Proposal[] {
  return proposals.filter((p) => p.status === "pending" && p.author === "user");
}
