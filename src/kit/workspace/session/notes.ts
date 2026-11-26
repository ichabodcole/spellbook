/**
 * The notes on a document: adding one over a selection or a quote
 * (`addNote`), placing every note in the active text as it stands now
 * (`placedNotes`, `noteLines`), and the verbs that change, answer, resolve
 * and remove a note. Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, the `chats`
 * (a reply is a message) and the `documents`, and the facade's `persist` as
 * a hook, so a test that replaces `persist` on a session still sees every
 * write.
 *
 * ⛔ The note guard stays lazy: `loadNoteGuard` loads `showsSelection` with an
 * `await import`, never a static one, and `NOT_PLACED` comes from
 * `notPlaced.ts` (no imports), never from `projection.ts`, which re-exports
 * it. `noteGuard.lazy.test.ts` holds the start path to it.
 */

import { NOT_PLACED } from "../../document/notPlaced.ts";
import { type Anchor, anchorOf, findAnchor, linesOf, quoteLabel } from "../anchors";
import type { Author, Doc, Message, Note, PlacedNote } from "../protocol";
import type { Chats } from "./chats.ts";
import type { Documents } from "./documents.ts";
import { SessionError } from "./errors.ts";
import { nowIso } from "./names.ts";
import type { State } from "./state.ts";

/**
 * The note guard (`showsSelection`), loaded the first time a note arrives with
 * what the human selected. ⛔ NEVER A STATIC IMPORT: it pulls in the markdown
 * parser, and every daemon and CLI start loads this file; 31 more modules made
 * each spawn about 10% slower, and a test of 21 spawns ran out of time.
 */
let noteGuard: typeof import("../../document/projection.ts").showsSelection | null = null;
/** Load the note guard; `addNote` with `seen` needs it. Cheap once loaded. */
export async function loadNoteGuard(): Promise<void> {
  noteGuard ??= (await import("../../document/projection.ts")).showsSelection;
}

/**
 * The loaded guard. ⛔ Not loaded is a caller's mistake (`loadNoteGuard` first),
 * and it is said, never taken as a pass: an unchecked note is the bug the guard
 * is for.
 */
function guardLoaded(): NonNullable<typeof noteGuard> {
  if (!noteGuard)
    throw new Error(
      "addNote: a note with `seen` needs the note guard: await loadNoteGuard() first",
    );
  return noteGuard;
}

export class Notes {
  constructor(
    private readonly core: State,
    private readonly chats: Chats,
    private readonly documents: Documents,
    private readonly hooks: { persist: () => void },
  ) {}

  /** Place every note in the active text as it stands now (re-anchoring after edits). */
  placedNotes(d: Doc): PlacedNote[] {
    if (d.notes.length === 0) return [];
    const text = this.documents.activeText(d);
    return d.notes.map((n) => placeNote(text, n));
  }

  /**
   * Note a range of the active version's text (the human selects) or a quote
   * found in it (the agent quotes: it has no offsets).
   */
  addNote(opts: {
    doc?: string;
    body: string;
    by: Author;
    range?: { from: number; to: number };
    /**
     * With `range`: the text the human selected, as their view showed it. When
     * given, a range that does not hold it is refused (`showsSelection`).
     */
    seen?: string;
    quote?: string;
  }): { slug: string; note: Note; how: "selection" | "quote" } {
    const d = this.documents.docOrDie(opts.doc);
    const body = opts.body.trim();
    if (!body) throw new SessionError("a note needs something written in it", 400);
    const text = this.documents.activeText(d);

    let anchor: Anchor;
    if (opts.range) {
      const { from, to } = opts.range;
      if (from < 0 || to > text.length || from >= to)
        throw new SessionError(
          `${from}..${to} is not a range in v${d.active} of ${d.slug} (${text.length} characters)`,
          400,
        );
      // ⛔ NEVER A NOTE OVER TEXT THE HUMAN DID NOT SELECT. The page turns a
      // selection into offsets; when that goes wrong (a file whose line endings
      // the rendered view could not place), the range can cover far more than
      // was chosen, and a note stored there is wrong without anyone seeing it.
      // Refused, with the act that answers it.
      if (opts.seen !== undefined && !guardLoaded()(text, from, to, opts.seen))
        throw new SessionError(
          `The note on ${JSON.stringify(quoteLabel(opts.seen, 40))} was not added. ${NOT_PLACED}`,
          409,
        );
      anchor = anchorOf(text, from, to);
    } else {
      const quote = opts.quote ?? "";
      if (!quote) throw new SessionError("a note needs a selection or a quote", 400);
      const at = text.indexOf(quote);
      // Refused, not anchored hopefully. A quote the active version does not
      // contain would become an orphan the moment it was made, which reads as
      // "the text changed" when the truth is "you quoted something else".
      if (at === -1)
        throw new SessionError(
          `v${d.active} of ${d.slug} does not contain that text: quote it exactly as it appears`,
          404,
        );
      anchor = anchorOf(text, at, at + quote.length);
    }

    const note: Note = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      version: d.active,
      ...anchor,
      body,
      by: opts.by,
      createdAt: nowIso(),
      resolved: false,
    };
    d.notes = [...d.notes, note];
    this.hooks.persist();
    return { slug: d.slug, note, how: opts.range ? "selection" : "quote" };
  }

  /**
   * The lines a note covers in the active version now, or null when its text is
   * gone. Placed, not remembered, for the reason notes are.
   */
  noteLines(doc: string, note: Note): { from: number; to: number } | null {
    const d = this.documents.docOrDie(doc);
    const text = this.documents.activeText(d);
    const at = findAnchor(text, note);
    return at.from === null ? null : linesOf(text, at.from, at.to);
  }

  /** The slug of the document that holds note `id`, or undefined when no document does. */
  noteDoc(id: string): string | undefined {
    return this.core.m.docs.find((d) => d.notes.some((n) => n.id === id))?.slug;
  }

  /** Notes on a document, placed; `all` includes the resolved ones. */
  notesOf(opts: { doc?: string; all?: boolean }): { slug: string; notes: PlacedNote[] } {
    const d = this.documents.docOrDie(opts.doc);
    const placed = this.placedNotes(d);
    return { slug: d.slug, notes: opts.all ? placed : placed.filter((n) => !n.resolved) };
  }

  private noteOrDie(d: Doc, id: string): Note {
    const note = d.notes.find((n) => n.id === id);
    if (!note)
      throw new SessionError(
        `${d.slug} has no note ${id}`,
        404,
        d.notes.map((n) => n.id),
      );
    return note;
  }

  /**
   * Every document's notes as stored: no placement, so no file reads. The
   * attention tick asks this every second, and `view()` would place every note.
   */
  noteFacts(): { slug: string; notes: readonly Note[] }[] {
    return this.core.m.docs.map((d) => ({ slug: d.slug, notes: d.notes }));
  }

  /**
   * Change what a note says. Its anchor is untouched: it is still about the same
   * passage. Who rewrote it is stored, because it decides whether the note is
   * owed an answer (`notesWaiting`). The agent's rewrite keeps the words it
   * replaced (the first it replaced, while it goes on rewriting), so the human
   * can see them and put them back; the human's own rewrite lets them go.
   *
   * A body that is the same is not a rewrite (`changed: false`): nothing is
   * stamped or stored, so a Save with nothing changed does not put the note in
   * front of the agent again.
   *
   * THE AGENT NEVER REWRITES THE HUMAN'S WORDS. A note the human wrote, or
   * rewrote last, is refused to the agent, which answers it with a reply
   * instead (`replyToNote`): the reply sits beside the note, its words untouched.
   */
  editNote(opts: { doc?: string; id: string; body: string; by: Author }): {
    slug: string;
    note: Note;
    changed: boolean;
  } {
    const d = this.documents.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    if (opts.by === "agent" && (note.by === "human" || note.editedBy === "human"))
      throw new SessionError(
        `note ${note.id} on ${d.slug} holds the human's words, and the agent does not rewrite them: reply to it instead`,
        409,
        ["note-reply", "note-resolve"],
        `run: note-reply ${note.id} --doc ${d.slug} <your answer> (the note keeps its words), or note-resolve ${note.id} --doc ${d.slug} when it is dealt with`,
      );
    const body = opts.body.trim();
    if (!body) throw new SessionError("a note needs something written in it", 400);
    if (body === note.body) return { slug: d.slug, note, changed: false };
    // An agent rewrite back to the words it replaced leaves nothing to put back.
    if (opts.by === "agent" && body !== (note.replacedBody ?? note.body))
      note.replacedBody ??= note.body;
    else delete note.replacedBody;
    note.body = body;
    note.editedAt = nowIso();
    note.editedBy = opts.by;
    this.hooks.persist();
    return { slug: d.slug, note, changed: true };
  }

  /**
   * The agent's answer to a note: a message in the conversation about it
   * (`about.noteId`), the shape the agent's `say` already stores when it names
   * a note. The note is untouched; the surface shows the answer with it. A
   * note that does not exist is refused, so an answer never points at nothing.
   */
  replyToNote(opts: { doc?: string; id: string; text: string }): {
    slug: string;
    note: Note;
    message: Message;
  } {
    const d = this.documents.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    const text = opts.text.trim();
    if (!text) throw new SessionError("a reply needs something written in it", 400);
    const message = this.chats.addMessage({ from: "agent", text, about: { noteId: note.id } });
    return { slug: d.slug, note, message };
  }

  resolveNote(opts: { doc?: string; id: string; resolved: boolean; by: Author }): {
    slug: string;
    note: Note;
  } {
    const d = this.documents.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    // A reopen is a write: the human reopening asks again, timed from here; the
    // agent reopening is an act on the note.
    if (note.resolved && !opts.resolved) {
      note.reopenedAt = nowIso();
      note.reopenedBy = opts.by;
    }
    note.resolved = opts.resolved;
    if (opts.resolved) note.resolvedAt = nowIso();
    else delete note.resolvedAt;
    this.hooks.persist();
    return { slug: d.slug, note };
  }

  removeNote(opts: { doc?: string; id: string }): { slug: string; note: Note } {
    const d = this.documents.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    d.notes = d.notes.filter((n) => n.id !== opts.id);
    this.hooks.persist();
    return { slug: d.slug, note };
  }
}

/** A note placed in `text`: where it is now, how sure we are, and its lines for display. */
function placeNote(text: string, note: Note): PlacedNote {
  const at = findAnchor(text, note);
  if (at.from === null) return { ...note, ...at, fromLine: null, toLine: null };
  const lines = linesOf(text, at.from, at.to);
  return { ...note, ...at, fromLine: lines.from, toLine: lines.to };
}
