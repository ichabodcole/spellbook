// A note the agent has not answered, as the surface draws it.
//
// One derived state, drawn in several places. The daemon decides which notes
// are owed an answer (`notesWaiting` in `workspace/waiting.ts`) and sends the
// list in every snapshot. Everything here only reads that list: the notes
// panel, its tab, the floating composer and the note menu in the text all draw
// the same entry, so none of them can disagree about a note.
import type { NoteWaiting, Waiting } from "../workspace/protocol";
import { type BadgeKind, badgeFor, UNHEARD_LABEL } from "./WaitingBadge.tsx";

type Badge = Waiting["badge"];

/** The open document's waiting notes, by note id. */
export function badgesOn(
  waiting: readonly NoteWaiting[],
  doc: string | null,
): Map<string, NoteWaiting> {
  const out = new Map<string, NoteWaiting>();
  for (const n of waiting) if (n.doc === doc) out.set(n.noteId, n);
  return out;
}

/**
 * One mark standing for several notes: stuck if any is. A pulse over a set that
 * holds a stuck note would be the false liveness the stalled badge exists to refuse.
 */
export function loudest(badges: Iterable<Badge>): Badge | null {
  let got: Badge | null = null;
  for (const b of badges) {
    if (b === "stalled") return "stalled";
    got = "working";
  }
  return got;
}

/**
 * The documents other than the open one with notes owed an answer, oldest
 * first. The panel lists the open document's notes; this is the pointer to the
 * rest, so something owed anywhere is visible without closing a column.
 */
export function elsewhere(
  waiting: readonly NoteWaiting[],
  open: string | null,
): { doc: string; count: number; badge: Badge; acknowledged?: true }[] {
  const by = new Map<
    string,
    { doc: string; count: number; badge: Badge; since: number; acknowledged: boolean }
  >();
  for (const n of waiting) {
    if (n.doc === open) continue;
    const since = Date.parse(n.since);
    const got = by.get(n.doc);
    if (!got)
      by.set(n.doc, {
        doc: n.doc,
        count: 1,
        badge: n.badge,
        since,
        acknowledged: n.acknowledged === true,
      });
    else {
      got.count++;
      if (n.badge === "stalled") got.badge = "stalled";
      got.since = Math.min(got.since, since);
    }
  }
  // The snooze is one for the session, so a document's first note speaks for all of them.
  return [...by.values()]
    .sort((a, b) => a.since - b.since)
    .map(({ doc, count, badge, acknowledged }) => ({
      doc,
      count,
      badge,
      ...(acknowledged ? { acknowledged: true as const } : {}),
    }));
}

/**
 * The words behind a dot standing for several notes, for a screen reader and on
 * hover: counted, so "may be stuck" never speaks for more notes, or fewer, than
 * it is true of.
 */
export function owedLabel(waiting: readonly NoteWaiting[]): string {
  const stuck = waiting.filter((n) => n.badge === "stalled").length;
  const owed = owedCount(waiting);
  if (stuck === 0) return owed;
  if (waiting.length === 1) return `${owed}; it may be stuck`;
  return `${owed}; ${stuck} may be stuck`;
}

/**
 * The one mark for every owed note in the session (the Notes tab's dot), or
 * null when nothing is owed. While no agent listens it reads `unheard`, as a
 * message's badge does, unless the agent's snooze holds: the snooze is one for
 * the session, so it holds for every note or none.
 */
export function owedSummary(
  waiting: readonly NoteWaiting[],
  agentListening: boolean,
): { badge: BadgeKind; label: string } | null {
  const badge = loudest(waiting.map((n) => n.badge));
  if (!badge) return null;
  const shown = badgeFor(
    { badge, ...(waiting.every((n) => n.acknowledged) ? { acknowledged: true } : {}) },
    agentListening,
  );
  return {
    badge: shown,
    label: shown === "unheard" ? `${owedCount(waiting)}; ${UNHEARD_LABEL}` : owedLabel(waiting),
  };
}

const owedCount = (waiting: readonly NoteWaiting[]): string =>
  `${waiting.length} ${waiting.length === 1 ? "note" : "notes"} owed an answer`;
