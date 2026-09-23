// E65: a note the agent has not answered, as the surface draws it.
//
// ⛔ ONE DERIVED STATE, DRAWN IN SEVERAL PLACES. The daemon decides which notes
// are owed an answer (`notesWaiting` in `backend/waiting.ts`) and sends the list
// in every snapshot. Everything here only READS that list — the notes panel,
// its tab, the floating composer and the note menu in the text all draw the
// same entry, so none of them can disagree about a note.
import type { NoteWaiting, Waiting } from "../../backend/protocol";

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

/** Which words a waiting note gets: asked about in the conversation, or not. */
export const waitingOf = (n: NoteWaiting): "note" | "asked" => (n.askedIn ? "asked" : "note");

/**
 * One mark standing for several notes: stuck if any is. A pulse over a set that
 * holds a stuck note would be the false liveness E53 exists to refuse.
 */
export function loudest(badges: Iterable<Badge>): Badge | null {
  let got: Badge | null = null;
  for (const b of badges) {
    if (b === "stalled") return "stalled";
    got = "working";
  }
  return got;
}

/** A one-line excerpt, cut at a character boundary rather than mid-emoji. */
function label(text: string, max: number): string {
  const flat = [...text.replace(/\s+/gu, " ").trim()];
  return flat.length <= max
    ? flat.join("")
    : `${flat
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

/**
 * What "Ask the agent" says when a note may be stuck (E65). A message in the
 * human's own conversation, so it gets everything a message gets — E53's
 * badge, its one nudge — and the agent's answer to it answers the note too.
 *
 * ⛔ AN EXCERPT, NOT THE NOTE. The message carries the note's REFERENCE (id and
 * document), which is how the agent finds and resolves it; the words are for
 * the human reading the conversation back, and a long note pasted whole would
 * bury it (verifier D4).
 */
export function askAboutNote(note: { quote: string; body: string }, docName: string): string {
  return `About my note on “${label(note.quote, 60)}” in ${docName}: “${label(note.body, 120)}”`;
}

/**
 * The documents OTHER than the open one with notes owed an answer, oldest
 * first (verifier D3). The panel lists the open document's notes; this is the
 * pointer to the rest, so something owed anywhere is visible without closing a
 * column.
 */
export function elsewhere(
  waiting: readonly NoteWaiting[],
  open: string | null,
): { doc: string; count: number; badge: Badge }[] {
  const by = new Map<string, { doc: string; count: number; badge: Badge; since: number }>();
  for (const n of waiting) {
    if (n.doc === open) continue;
    const got = by.get(n.doc);
    if (!got) by.set(n.doc, { doc: n.doc, count: 1, badge: n.badge, since: n.since });
    else {
      got.count++;
      if (n.badge === "stalled") got.badge = "stalled";
      got.since = Math.min(got.since, n.since);
    }
  }
  return [...by.values()]
    .sort((a, b) => a.since - b.since)
    .map(({ doc, count, badge }) => ({ doc, count, badge }));
}

/**
 * The words behind the Notes tab's one dot, for a screen reader and on hover —
 * counted, so "may be stuck" never speaks for more notes, or fewer, than it
 * is true of (reviewer).
 */
export function owedLabel(waiting: readonly NoteWaiting[]): string {
  const stuck = waiting.filter((n) => n.badge === "stalled").length;
  const owed = `${waiting.length} ${waiting.length === 1 ? "note" : "notes"} owed an answer`;
  if (stuck === 0) return owed;
  if (waiting.length === 1) return `${owed} — it may be stuck`;
  return `${owed} — ${stuck} may be stuck`;
}
