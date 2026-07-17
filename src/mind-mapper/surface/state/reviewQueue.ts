// P3.1 — review queue grouping (plan/circe.md P3.1), the ratified
// review-queue contract: batch-by-source (bobbin's spec). Pure map-building
// only pending proposals ever appear (a status filter, not the caller's
// job) — grouped under their evidence docId, with an "ungrounded" bucket
// (key "") for proposals whose evidence carries no docId (cassandra's
// deliberate-orphan gate case: an orphan node still needs a ruling).

import type { Proposal } from "../types";

export const UNGROUNDED = "";

export function groupProposalsByDoc(proposals: Proposal[]): Map<string, Proposal[]> {
  const groups = new Map<string, Proposal[]>();
  for (const p of proposals) {
    if (p.status !== "pending") continue;
    const key = p.evidence.docId ?? UNGROUNDED;
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
// the row; it never edits or reshapes the draft itself.
export function draftSummary(p: Proposal): { title: string; detail: string } {
  if (p.kind === "node") {
    return { title: str(p.draft.title, "untitled"), detail: str(p.draft.synopsis) };
  }
  const source = str(p.draft.source, "?");
  const target = str(p.draft.target, "?");
  const label = str(p.draft.label, "relates to");
  return { title: `${source} — ${label} — ${target}`, detail: "" };
}
