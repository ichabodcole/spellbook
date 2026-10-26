// Kept on the kit path (scriptorium-kit-keepers): a copy of the shipped
// sidebar's `statusMark` (`../components/context/model.ts`), which the shipped
// surface's bundle carries; a re-export would have rewritten that bundle's
// bytes. The shipped copy goes at the cutover.
import type { DocSummary } from "../backend/kit/frontmatter";

/**
 * A document's status mark for the sidebar (E32) — the smallest thing that can
 * carry meaning at row scale. `draft` and `deprecated` are worth a mark;
 * `stable` is the default and marking it would mark almost everything.
 */
export type StatusMark = { tone: "draft" | "deprecated" | "stale" | "unreadable"; title: string };

export function statusMark(summary: DocSummary | undefined): StatusMark | null {
  if (!summary) return null;
  if (summary.error)
    return { tone: "unreadable", title: `Frontmatter unreadable: ${summary.error}` };
  if (summary.stale) return { tone: "stale", title: "Past its stale_after date" };
  if (summary.status === "draft") return { tone: "draft", title: "status: draft" };
  if (summary.status === "deprecated") return { tone: "deprecated", title: "status: deprecated" };
  return null;
}
