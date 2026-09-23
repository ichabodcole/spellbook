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
export function badgesOn(waiting: readonly NoteWaiting[], doc: string | null): Map<string, Badge> {
  const out = new Map<string, Badge>();
  for (const n of waiting) if (n.doc === doc) out.set(n.noteId, n.badge);
  return out;
}

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

/** A one-line label for a passage — the note's own text is never shortened. */
function label(quote: string, max = 60): string {
  const flat = quote.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * What "Ask the agent" sends when a note may be stuck (E65). A message in the
 * human's own conversation, so it gets everything a message gets — E53's badge,
 * its one nudge — and the agent's answer to it answers the note too.
 */
export function askAboutNote(note: { quote: string; body: string }, docName: string): string {
  return `About my note on “${label(note.quote)}” in ${docName}: ${note.body}`;
}
