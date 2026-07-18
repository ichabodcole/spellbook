// P3.1 — review queue grouping (plan/circe.md P3.1), the ratified
// review-queue contract: batch-by-source (bobbin's spec). Pure map-building
// only pending proposals ever appear (a status filter, not the caller's
// job) — grouped under their evidence docId, with a "from conversation"
// bucket for message-grounded proposals (Claim E: message evidence is real
// grounding, NOT an orphan) and an "ungrounded" bucket (key "") for
// proposals whose evidence carries nothing (cassandra's deliberate-orphan
// gate case: an orphan node still needs a ruling).

import type { MapNode, Proposal } from "../types";

export const UNGROUNDED = "";
// Sentinel bucket key — a ":" never appears in a doc slug (SLUG_RE), so this
// can't collide with a real docId.
export const FROM_CONVERSATION = ":conversation";

// V1.x Claim D — the author split, upstream of the by-doc grouping: the
// queue is asymmetric BY DESIGN. Agent-authored rows keep the one-keystroke
// ruling UI; user-authored rows are a WAITING state ("yours — awaiting a
// doc home" — the staging inversion: the human sketches, the agent drafts
// the doc-home sentence before it can be ratified). Pending-only, same
// contract as groupProposalsByDoc.
export function partitionByAuthor(proposals: Proposal[]): {
  user: Proposal[];
  agent: Proposal[];
} {
  const user: Proposal[] = [];
  const agent: Proposal[] = [];
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    (p.author === "user" ? user : agent).push(p);
  }
  return { user, agent };
}

export function groupProposalsByDoc(proposals: Proposal[]): Map<string, Proposal[]> {
  const groups = new Map<string, Proposal[]>();
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    const key = p.evidence.docId ?? (p.evidence.messageId ? FROM_CONVERSATION : UNGROUNDED);
    const bucket = groups.get(key);
    if (bucket) bucket.push(p);
    else groups.set(key, [p]);
  }
  return groups;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// The draft rendered verbatim (review-queue contract: no compose-in-UI) —
// this only SUMMARIZES an opaque draft into a one-line title + detail for
// the row; it never edits or reshapes the draft itself. `nodes` (when
// given) resolves an edge draft's endpoint ids to their titles — display
// resolution, not draft editing; an id that matches no node renders as-is.
export function draftSummary(p: Proposal, nodes?: MapNode[]): { title: string; detail: string } {
  if (p.kind === "node") {
    return { title: str(p.draft.title, "untitled"), detail: str(p.draft.synopsis) };
  }
  const resolve = (id: string) => nodes?.find((n) => n.id === id)?.title ?? id;
  const source = resolve(str(p.draft.source, "?"));
  const target = resolve(str(p.draft.target, "?"));
  const label = str(p.draft.label, "relates to");
  return { title: `${source} — ${label} — ${target}`, detail: "" };
}
