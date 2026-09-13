// The centre pane's document. EDITABLE as of E31 — the human types here, and
// what they type reaches the ACTIVE VERSION's file, never the original (E7:
// Save is the only thing that writes that).
//
// CodeMirror 6, hand-wrapped (investigation §1: the spell must dispatch its own
// transactions — the human's edits, remote changes, later a merge — so the
// view's lifecycle is ours, not a wrapper library's). ONE view per document —
// not per version — so a new text (the agent's version made active, the
// original reloaded from disk) is applied as the SMALLEST change that turns the
// old text into the new, and the reader keeps their place. (It first remounted
// per version and replaced the whole text, which put a reader 300,000px down
// back at the top — the verify pass drove it.)
//
// ⛔ TWO WRITERS, ONE DOCUMENT, AND AN ANNOTATION IS WHAT KEEPS THEM APART. A
// change this view applies FROM the daemon is stamped `remote`, and the update
// listener ignores a stamped transaction — otherwise a reload from disk would
// be sent straight back as if the human had typed it, and the two would chase
// each other.
//
// Markdown highlighting is in `markdownMode.ts`, which also records why it is
// hand-written rather than `@codemirror/lang-markdown` (E20's open question).
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  Annotation,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { PlacedNote } from "../../backend/protocol";
import { markdownHighlighting } from "./markdownMode";

/** A change that came FROM the daemon, so the listener does not send it back. */
const remote = Annotation.define<boolean>();

// ── notes, drawn over the text (E45) ─────────────────────────────────────────
//
// ⛔ THE DAEMON DECIDES WHERE A NOTE IS, not this view. The ranges arrive
// already placed (`anchors.ts` re-finds each note's quote on every snapshot),
// so the editor's only job is to paint them. A decoration computed here from a
// stored offset would be the stale-offset bug the anchoring exists to avoid.
const setNotes = StateEffect.define<PlacedNote[]>();

/**
 * The passage a note is being written about, while the composer is open (E46).
 *
 * ⛔ A DECORATION, NOT THE SELECTION. The browser's selection dims or vanishes
 * the moment focus moves to a textarea, and the one thing the composer must
 * keep visible is WHICH passage you are writing about. Painting it as a mark
 * makes it independent of focus entirely.
 */
const setPending = StateEffect.define<{ from: number; to: number } | null>();

/** `nearest` is a guess, and is drawn as one — dashed rather than solid. */
const noteMark = Decoration.mark({ class: "cm-note" });
const guessMark = Decoration.mark({ class: "cm-note cm-note-guess" });

const pendingMark = Decoration.mark({ class: "cm-note cm-note-pending" });

const pendingField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects)
      if (e.is(setPending))
        return e.value
          ? Decoration.set([pendingMark.range(e.value.from, e.value.to)])
          : Decoration.none;
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const noteField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects)
      if (e.is(setNotes)) {
        const placed = e.value
          .filter((n) => n.from !== null && n.to !== null && n.from < n.to)
          .sort((a, b) => (a.from as number) - (b.from as number))
          .map((n) =>
            (n.how === "nearest" ? guessMark : noteMark).range(n.from as number, n.to as number),
          );
        return Decoration.set(placed, true);
      }
    // Between snapshots the text moves under the marks; mapping keeps them on
    // the words they were on until the daemon's next placement arrives.
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How long typing settles before the buffer is sent (one daemon write per message). */
export const EDIT_DEBOUNCE_MS = 250;

/** The editor's look, from the spell's semantic tokens — so both themes follow. */
const scriptoriumTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--color-ink)",
    backgroundColor: "var(--color-bg)",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
  },
  ".cm-content": {
    // 76ch is a PROSE measure and monospace is not prose: at 14px JetBrains
    // Mono that came out around 640px, which reads cramped on a wide screen
    // (Cole). 104ch is the code measure most editors wrap at, and the pane's
    // own width still wins when it is narrower.
    maxWidth: "104ch",
    margin: "0 auto",
    padding: "28px 40px 64px",
    caretColor: "var(--color-rubric)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-rubric) 28%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-note": {
    backgroundColor: "color-mix(in srgb, var(--color-attention) 22%, transparent)",
    borderBottom: "1px solid color-mix(in srgb, var(--color-attention) 55%, transparent)",
  },
  ".cm-note-guess": { borderBottomStyle: "dashed" },
  ".cm-note-pending": {
    backgroundColor: "color-mix(in srgb, var(--color-rubric) 24%, transparent)",
    borderBottom: "1px solid var(--color-rubric)",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-rubric)", borderLeftWidth: "2px" },
});

/** The smallest single replacement turning `a` into `b`: common prefix and suffix kept. */
export function minimalChange(
  a: string,
  b: string,
): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export function DocumentView({
  docKey,
  text,
  editable = false,
  notes,
  onChange,
  onSave,
  onSelect,
  reveal,
  pendingNote,
  onContextMenu,
}: {
  docKey: string;
  text: string;
  /** Only the ACTIVE version is editable (E2); anything else is read. */
  editable?: boolean;
  /** The buffer, debounced — the daemon writes it to the active version's file. */
  onChange?: (text: string) => void;
  /** ⌘S / Ctrl-S: the one act that writes the original (E7). */
  onSave?: () => void;
  /** Notes, already PLACED by the daemon (E45). */
  notes?: PlacedNote[];
  /** The selection, so something outside can offer to note it. */
  onSelect?: (from: number, to: number) => void;
  /** Ask the editor to show a range — `seq` makes the same range askable twice. */
  reveal?: { from: number; to: number; seq: number } | null;
  /** The passage a note is being written about — painted while the composer is open. */
  pendingNote?: { from: number; to: number } | null;
  /** Right-click over a SELECTION: where, and what is selected. */
  onContextMenu?: (at: { x: number; y: number; from: number; to: number }) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef(text);
  initial.current = text;
  // The handlers change identity every render; the extensions must not.
  const handlers = useRef({ onChange, onSave, onSelect, onContextMenu });
  handlers.current = { onChange, onSave, onSelect, onContextMenu };
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The last text the DAEMON gave us — see the remote effect below. */
  const lastRemote = useRef(text);
  // Read at mount so a remount (a version change) repaints its notes at once.
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // One view per document, rebuilt when the document or its editability changes.
  useEffect(() => {
    if (!host.current) return;
    const send = (value: string) => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = null;
        handlers.current.onChange?.(value);
      }, EDIT_DEBOUNCE_MS);
    };
    /** Send what is pending NOW — before a save, a blur, or unmounting. */
    const flush = () => {
      if (!pending.current) return;
      clearTimeout(pending.current);
      pending.current = null;
      const v = view.current;
      if (v) handlers.current.onChange?.(v.state.doc.toString());
    };
    const extensions: Extension[] = [
      EditorView.lineWrapping,
      noteField,
      pendingField,
      markdownHighlighting,
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const { from, to } = update.state.selection.main;
        handlers.current.onSelect?.(from, to);
      }),
      scriptoriumTheme,
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
    ];
    if (editable)
      extensions.push(
        history(),
        // ⌘S is bound FIRST so it wins, and `preventDefault` is what stops the
        // browser's own Save-page dialog from opening over the surface.
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              flush();
              handlers.current.onSave?.();
              return true;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((t) => t.annotation(remote))) return;
          send(update.state.doc.toString());
        }),
        // Typing and then clicking away must not leave the last keystrokes unsent.
        EditorView.domEventHandlers({
          blur: () => {
            flush();
            return false;
          },
          // ⛔ ONLY OVER A SELECTION. With nothing selected there is nothing to
          // note, so the browser's own menu (spelling, copy, look up) is left
          // alone rather than replaced with something useless.
          contextmenu: (event, view) => {
            const { from, to } = view.state.selection.main;
            if (from === to || !handlers.current.onContextMenu) return false;
            event.preventDefault();
            handlers.current.onContextMenu({ x: event.clientX, y: event.clientY, from, to });
            return true;
          },
        }),
      );
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: initial.current, extensions }),
    });
    view.current = v;
    v.dispatch({ effects: setNotes.of(notesRef.current ?? []) });
    return () => {
      flush();
      v.destroy();
      view.current = null;
    };
  }, [docKey, editable]);

  // Clicking a note's quote brings it into view and selects it — `seq` is what
  // lets the same note be asked for twice in a row.
  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const end = Math.min(reveal.to, v.state.doc.length);
    const start = Math.min(reveal.from, end);
    v.dispatch({
      selection: { anchor: start, head: end },
      effects: EditorView.scrollIntoView(start, { y: "center" }),
    });
    v.focus();
  }, [reveal]);

  useEffect(() => {
    view.current?.dispatch({ effects: setPending.of(pendingNote ?? null) });
  }, [pendingNote]);

  // Notes arrive already placed; push them in whenever the daemon re-places them.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: setNotes.of(notes ?? []) });
  }, [notes]);

  // The text changed UNDER us (a version made active, the original reloaded).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    // ⛔ A re-render carrying the SAME text the daemon last gave us is not news.
    // Applying it would throw away everything typed since — the prop trails the
    // buffer by design, because the daemon does not echo an edit back.
    if (text === lastRemote.current) return;
    lastRemote.current = text;
    const change = minimalChange(v.state.doc.toString(), text);
    if (!change) return;
    const top = v.scrollDOM.scrollTop;
    v.dispatch({ changes: change, annotations: remote.of(true) });
    v.requestMeasure({
      read: () => null,
      write: () => {
        v.scrollDOM.scrollTop = top;
      },
    });
  }, [text]);

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" data-slot="document-view" />;
}
