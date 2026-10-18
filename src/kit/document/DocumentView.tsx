// The centre pane's raw view: the open document in CodeMirror 6, editable.
//
// What the human types reaches the ACTIVE version's file (through the daemon
// client's debounced `writeText`), never the original: Save is the only thing
// that writes that. CodeMirror is hand-wrapped, so this view dispatches its own
// transactions (the human's edits, remote changes, text an app's toolbar inserts
// through the handle) and its lifecycle is ours. An app adds to it through
// `extensions` and `tokens`, both read when the view is built. There is ONE view per document, not per version, so a
// new text (a version made active, the file reloaded) is applied as the smallest
// change that turns the old text into the new and the reader keeps their place.
//
// TWO WRITERS, ONE DOCUMENT, AND AN ANNOTATION KEEPS THEM APART. A change this
// view applies FROM the daemon is stamped `remote`, and the update listener ignores
// a stamped transaction: otherwise a reload from disk would be sent straight back
// as if the human had typed it, and the two would chase each other.
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, dropCursor, EditorView, keymap } from "@codemirror/view";
import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import { carriesRows, type DraggedRow, readRowDrag } from "../context/rowDrag.ts";
import type { DocFormat } from "../lib/docFormat.ts";
import { caretInCode } from "../lib/markdownCode.ts";
import type { PlacedNote } from "../workspace/protocol";
import { clipboardImages, isImageLike } from "./imagePaste.ts";
import { jsonHighlighting, numberedLines } from "./jsonMode.ts";
import { modClickFollowsLinks } from "./linkClick.ts";
import { type LinkKind, type LinkRequest, type LinkTracker, linkTrigger } from "./linkInsert.ts";
import { type InlineToken, markdownHighlighting } from "./markdownMode.ts";
import type { Place } from "./place.ts";
import { applyChanges, minimalChange, type TextChange } from "./text.ts";

/** A change that came FROM the daemon, so the listener does not send it back. */
const remote = Annotation.define<boolean>();

// Notes, drawn over the text. The daemon decides where a note is: the ranges arrive
// already placed (the note's quote re-found in the current text on every snapshot),
// so the editor's only job is to paint them. A decoration computed here from a
// stored offset would be the stale-offset bug the anchoring exists to avoid.
const setNotes = StateEffect.define<{ notes: PlacedNote[]; focused: string | null }>();

/**
 * The passage a note is being written about, while its composer is open. A
 * decoration, not the selection: the browser's selection dims the moment focus
 * moves to a textarea, and the one thing the composer must keep visible is WHICH
 * passage it is about.
 */
const setPending = StateEffect.define<{ from: number; to: number } | null>();

/**
 * `nearest` is a guess, and is drawn as one: dashed rather than solid. The note
 * the Notes panel has focused is drawn stronger, as the rendered view paints it.
 */
const noteMark = Decoration.mark({ class: "cm-note" });
const guessMark = Decoration.mark({ class: "cm-note cm-note-guess" });
const focusMark = Decoration.mark({ class: "cm-note cm-note-focus" });
const focusGuessMark = Decoration.mark({ class: "cm-note cm-note-guess cm-note-focus" });
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

/**
 * A passage just pointed at (the agent's `show`): marked for a moment and
 * scrolled to, WITHOUT selecting it or taking focus. Pointing is not choosing:
 * the human's selection, their caret and the chat's context stay theirs, and
 * the keys they are typing elsewhere keep going where they were going.
 */
const setFlash = StateEffect.define<{ from: number; to: number } | null>();
const flashMark = Decoration.mark({ class: "cm-flash" });
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects)
      if (e.is(setFlash))
        return e.value && e.value.from < e.value.to
          ? Decoration.set([flashMark.range(e.value.from, e.value.to)])
          : Decoration.none;
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** How long a pointed-at passage stays marked. */
export const FLASH_MARK_MS = 1600;

const noteField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const e of tr.effects)
      if (e.is(setNotes)) {
        const { notes, focused } = e.value;
        const placed = notes
          .filter((n) => n.from !== null && n.to !== null && n.from < n.to)
          .sort((a, b) => (a.from as number) - (b.from as number))
          .map((n) => {
            const guess = n.how === "nearest";
            const mark = n.id === focused ? (guess ? focusGuessMark : focusMark) : null;
            return (mark ?? (guess ? guessMark : noteMark)).range(n.from as number, n.to as number);
          });
        return Decoration.set(placed, true);
      }
    // Between snapshots the text moves under the marks; mapping keeps them on the
    // words they were on until the daemon's next placement arrives.
    return marks.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The editor's look, from the kit's semantic tokens, so both themes follow. */
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--color-ink)",
    backgroundColor: "var(--color-bg)",
    fontSize: "14px",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": {
    // 104ch is the measure most editors wrap at; the pane's own width still wins
    // when it is narrower.
    maxWidth: "104ch",
    margin: "0 auto",
    padding: "28px 40px 64px",
    caretColor: "var(--color-brand)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-brand) 28%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-note": {
    backgroundColor: "color-mix(in srgb, var(--color-attention) 22%, transparent)",
    borderBottom: "1px solid color-mix(in srgb, var(--color-attention) 55%, transparent)",
  },
  ".cm-note-guess": { borderBottomStyle: "dashed" },
  ".cm-note-focus": {
    backgroundColor: "color-mix(in srgb, var(--color-attention) 45%, transparent)",
  },
  ".cm-note-pending": {
    backgroundColor: "color-mix(in srgb, var(--color-brand) 24%, transparent)",
    borderBottom: "1px solid var(--color-brand)",
  },
  ".cm-cursor": { borderLeftColor: "var(--color-brand)", borderLeftWidth: "2px" },
  ".cm-dropCursor": { borderLeftColor: "var(--color-brand)", borderLeftWidth: "2px" },

  // The search panel. `@codemirror/search` ships a panel that inherits the
  // browser's default form controls, which in a themed surface reads as a piece of
  // another application bolted to the top of the document. These rules are the
  // kit's tokens, so both themes follow.
  ".cm-panels": {
    backgroundColor: "var(--color-surface-raised)",
    color: "var(--color-ink)",
    borderBottom: "1px solid var(--color-edge)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--color-edge)" },
  ".cm-search": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px",
    padding: "6px 10px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "4px" },
  // CodeMirror's base theme paints the search input white for a light editor, and
  // it believes the editor is light in both themes because this one does not
  // declare `dark`. Scoped through `.cm-panel.cm-search` to beat the base rule on
  // specificity instead of on registration order.
  ".cm-panel.cm-search .cm-textfield": {
    backgroundColor: "var(--color-bg)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-edge)",
    borderRadius: "6px",
    padding: "3px 7px",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    outline: "none",
  },
  ".cm-panel.cm-search .cm-textfield::placeholder": { color: "var(--color-ink-faint)" },
  ".cm-panel.cm-search .cm-textfield:focus": {
    borderColor: "var(--color-brand)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--color-brand) 45%, transparent)",
  },
  ".cm-search button": {
    backgroundColor: "transparent",
    backgroundImage: "none",
    color: "var(--color-ink-dim)",
    border: "1px solid var(--color-edge)",
    borderRadius: "6px",
    padding: "3px 8px",
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
  },
  ".cm-search button:hover": { color: "var(--color-ink)" },
  ".cm-search button[name=close]": {
    border: "none",
    fontSize: "16px",
    lineHeight: "1",
    padding: "0 4px",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--color-attention) 26%, transparent)",
  },
  // The current match in the pointed-at hue, as the kit's find bar paints it,
  // so it never reads as the selection.
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--color-pointed) 40%, transparent)",
    outline: "1px solid var(--color-pointed)",
  },
  ".cm-flash": {
    backgroundColor: "color-mix(in srgb, var(--color-pointed) 34%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in srgb, var(--color-ink-faint) 18%, transparent)",
  },
  // A quiet reading mode fades the gutter as `QUIET_FADE` fades the chrome (the
  // same strength and pace) and never hides it: the human turned the numbers on.
  // The pointer on the gutter brings it back, as it brings a bar back.
  "&.cm-quiet .cm-gutters": { opacity: "0.4", transition: "opacity 300ms" },
  "&.cm-quiet .cm-gutters:hover": { opacity: "1" },
});

/** The class a quiet reading mode puts on the editor, which fades its gutter. */
export const QUIET_GUTTER_CLASS = "cm-quiet";

/**
 * The line-number gutter, on or off. JSON's highlighting carries the same
 * gutter, which CodeMirror holds once however often it is named: on adds no
 * second one there, and off leaves JSON's.
 */
function gutterFor(on: boolean): Extension {
  return on ? numberedLines() : [];
}

/** The quiet fade on the gutter, or nothing. */
function quietFor(quiet: boolean): Extension {
  return quiet ? EditorView.editorAttributes.of({ class: QUIET_GUTTER_CLASS }) : [];
}

/**
 * What is inserted at the caret: the text, or a function of the character before
 * the caret (undefined at the start of the document) that returns it, for text that
 * spaces itself off a word it would touch.
 */
export type CaretInsert = string | ((before: string | undefined) => string);

/** What an app's toolbar and the shell's focus handling can ask of the editor. */
export type EditorHandle = {
  /** Put the caret in the editor. */
  focus: () => void;
  /** Put text at the caret (replacing the selection), and keep typing from after it. */
  insertAtCaret: (insert: CaretInsert) => void;
  /** The current selection, as offsets into the buffer; null before the editor is built. */
  selection: () => { from: number; to: number } | null;
  /** The current buffer. */
  text: () => string;
  /**
   * Replace `from`..`to` with `insert`, as the human's own edit (it is written
   * like typing, never to the file directly), and put the caret after it. Only
   * while `guard.text` still stands at `guard.at`: the text can change under a
   * picker that was open a while. False when it did not apply (read-only, or the
   * guard failed).
   */
  replaceRange: (
    from: number,
    to: number,
    insert: string,
    guard?: { at: number; text: string },
  ) => boolean;
  /**
   * Follow the range a link will replace through every change from now on (see
   * `LinkTracker`). The editor makes its own for the shortcut and the typed
   * triggers; the pane asks for one for the right-click menu.
   */
  track: (kind: LinkKind, from: number, to: number) => LinkTracker;
};

/**
 * Images pasted or dropped into the editor, handed to the pane to write. `track`
 * follows where the embeds go (the selection a paste replaces, or the point a
 * drop landed on) while the files are sent; `quote` is the text that range held,
 * which must still stand there for the paste to replace it.
 */
export type ImageArrival = {
  files: File[];
  how: "paste" | "drop";
  track: LinkTracker;
  quote: string;
};

/**
 * Sidebar rows dropped into the editor (kit-tree-drag-into-document), handed
 * to the pane to ask what each writes. `track` follows the drop point while
 * the pane asks.
 */
export type RowArrival = {
  rows: DraggedRow[];
  track: LinkTracker;
};

/** Where a drop landed in the text. */
function dropPoint(v: EditorView, event: MouseEvent): number {
  try {
    return v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head;
  } catch {
    // Not laid out (a test DOM): the caret stands in for the drop point.
    return v.state.selection.main.head;
  }
}

/** A range a link picker will replace, as the editor maps it. */
type Tracked = { from: number; to: number; fromAssoc: -1 | 1; toAssoc: -1 | 1; alive: boolean };

/** The link shortcut. Mod-K is the header's search, so the link takes its Shift sibling. */
export const LINK_KEY = "Mod-Shift-k";

/**
 * Where on screen to anchor a card for offset `pos`: just under its line. A
 * view that cannot measure (not laid out yet) falls back to its own top left.
 */
function caretPoint(v: EditorView, pos: number): { x: number; y: number } {
  const c = v.coordsAtPos(pos);
  if (c) return { x: c.left, y: c.bottom };
  const r = v.contentDOM.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

export type SelectionReport = {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  text: string;
};

export function DocumentView({
  docKey,
  text,
  editable = false,
  notes,
  focusedNote = null,
  onChange,
  onFlush,
  onSave,
  onSelect,
  reveal,
  onRevealed,
  flash,
  clearSeq,
  pendingNote,
  onContextMenu,
  place,
  handle,
  extensions,
  tokens,
  format = "markdown",
  onLinkRequest,
  onFollowLink,
  onImages,
  onRows,
  replay,
  onReplayed,
  lineNumbers = false,
  quiet = false,
}: {
  docKey: string;
  text: string;
  /** Only the ACTIVE version is editable. */
  editable?: boolean;
  /**
   * The buffer changed by the human. It is handed a reader, not the text: the
   * daemon client debounces the write and reads the buffer when it sends, so a
   * large document is not copied on every keystroke.
   */
  onChange?: (read: () => string) => void;
  /** Send what is pending now: before a save, when focus leaves, on unmount. */
  onFlush?: () => void;
  /** Mod-S: the one act that writes the original. */
  onSave?: () => void;
  /** Notes, already PLACED by the daemon. */
  notes?: PlacedNote[];
  /** The note the panel has focused: marked stronger than the rest. */
  focusedNote?: string | null;
  /**
   * The selection: offsets for notes, and LINE NUMBERS for the wire's selection,
   * which is what the agent reads. A character offset is neither party's language.
   */
  onSelect?: (s: SelectionReport) => void;
  /**
   * Ask the editor to show a range; `seq` makes the same range askable twice.
   * With `heading` (a link followed to a heading), `from`..`to` is the caret
   * (empty), the heading's line is marked for a moment, and it is scrolled
   * near the top rather than to the middle.
   */
  reveal?: {
    from: number;
    to: number;
    seq: number;
    heading?: { from: number; to: number };
  } | null;
  /**
   * Told once `reveal` has been applied, so it is spent. The effect runs whenever
   * the editor is created, so a reveal left standing would replay as a selection
   * nobody made.
   */
  onRevealed?: (seq: number) => void;
  /**
   * A passage pointed at, not chosen (the agent's `show`): scrolled to and marked
   * for a moment, with no selection and no focus. A new `seq` marks again.
   */
  flash?: { from: number; to: number; seq: number } | null;
  /** Bumped when the held selection goes away: the editor's goes with it. */
  clearSeq?: number;
  /** The passage a note is being written about, painted while its composer is open. */
  pendingNote?: { from: number; to: number } | null;
  /** Right-click in the text: where, what is selected, and which notes are under the pointer. */
  onContextMenu?: (at: {
    x: number;
    y: number;
    from: number;
    to: number;
    noteIds: string[];
  }) => void;
  /** The source line at the top of this pane, shared with the rendered one. */
  place?: Place;
  handle?: Ref<EditorHandle>;
  /** An app's own CodeMirror extensions, added after the view's. */
  extensions?: readonly Extension[];
  /** An app's inline shapes for the markdown highlighter. */
  tokens?: readonly InlineToken[];
  /**
   * How the text is highlighted: markdown (with `tokens`), or JSON. Read when the
   * view is built.
   */
  format?: DocFormat;
  /**
   * Asked for a link: Mod-Shift-K over the selection, or `](` or `[[` typed.
   * Editable views only; absent, none of the three does anything.
   */
  onLinkRequest?: (r: LinkRequest) => void;
  /**
   * Mod-click on a link follows it (kit-heading-links-build): its target as
   * written. Absent, a Mod-click does what the editor does with one.
   */
  onFollowLink?: (target: string) => void;
  /**
   * Images pasted or dropped in (kit-image-paste). Absent (a JSON document, an
   * app that takes none), the editor pastes and drops as it always has.
   */
  onImages?: (r: ImageArrival) => void;
  /**
   * Sidebar rows dropped in (kit-tree-drag-into-document). Absent, a row's
   * drop is still taken, so the browser inserts nothing of its own, and does
   * nothing.
   */
  onRows?: (r: RowArrival) => void;
  /**
   * Edits made while this view was not mounted (a link added in the rendered
   * view): `base` with `changes` applied is the text. Read when the view is
   * built; if it still matches, the view starts from `base` and applies the
   * changes as undoable steps, so Mod-Z takes them back here. A text that has
   * moved on since is shown as it is, without them in the history.
   */
  replay?: { base: string; changes: readonly TextChange[] } | null;
  /** Told once `replay` has been read, whether or not it still matched. */
  onReplayed?: () => void;
  /**
   * Number the lines in a gutter. Changing it reconfigures the editor in place
   * (a compartment), never rebuilds it, so the scroll, the selection and the
   * undo history stay. A JSON document is numbered whatever this says.
   */
  lineNumbers?: boolean;
  /**
   * A quiet reading mode is on: the gutter fades as the chrome does (`QUIET_FADE`),
   * and stays. Reconfigured in place, like `lineNumbers`.
   */
  quiet?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef(text);
  initial.current = text;
  // The handlers change identity every render; the extensions must not.
  const handlers = useRef({
    onChange,
    onFlush,
    onSave,
    onSelect,
    onContextMenu,
    onLinkRequest,
    onFollowLink,
    onImages,
    onRows,
    onReplayed,
  });
  handlers.current = {
    onChange,
    onFlush,
    onSave,
    onSelect,
    onContextMenu,
    onLinkRequest,
    onFollowLink,
    onImages,
    onRows,
    onReplayed,
  };
  const replayRef = useRef(replay);
  replayRef.current = replay;
  /** The last text the DAEMON gave us: see the remote effect below. */
  const lastRemote = useRef(text);
  /** The last text this view handed out to be written: its echo coming back is not news. */
  const lastWritten = useRef<string | null>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const focusedRef = useRef(focusedNote);
  focusedRef.current = focusedNote;
  const additions = useRef({ extensions, tokens });
  additions.current = { extensions, tokens };
  // The gutter and its fade, each in a compartment of its own: read when the
  // view is built, and reconfigured in place when they change (below), so
  // turning the numbers on or off never rebuilds the editor.
  const gutter = useRef({ numbers: new Compartment(), quiet: new Compartment() });
  const gutterNow = useRef({ lineNumbers, quiet });
  gutterNow.current = { lineNumbers, quiet };
  /** The ranges open link pickers will replace, mapped through every change. */
  const trackers = useRef(new Set<Tracked>());
  const follow = (from: number, to: number, fromAssoc: -1 | 1, toAssoc: -1 | 1): LinkTracker => {
    const t: Tracked = { from, to, fromAssoc, toAssoc, alive: true };
    trackers.current.add(t);
    return {
      range: () => (t.alive ? { from: t.from, to: Math.max(t.from, t.to) } : null),
      release: () => {
        trackers.current.delete(t);
      },
    };
  };
  // Which way each end leans when text is inserted right at it. A selection
  // keeps what is typed at its edges out; a completion takes in what is typed
  // at the caret (keys pressed before the picker took focus), and `[[` keeps
  // what is typed before the brackets out.
  const track = (kind: LinkKind, from: number, to: number): LinkTracker =>
    follow(from, to, kind === "complete" ? -1 : 1, kind === "wrap" ? -1 : 1);
  const trackRef = useRef(track);
  // Where arriving images go. At a caret both ends lean back, so what is
  // typed there while the files are sent lands after the embeds, as it would
  // have after a paste of text; a selection keeps typing at its edges out.
  const followRef = useRef(follow);
  followRef.current = follow;

  useImperativeHandle(
    handle,
    () => ({
      focus: () => view.current?.focus(),
      insertAtCaret: (what) => {
        const v = view.current;
        // Read-only stops typing, not a dispatch: an ended session's editor
        // must not take text that exists nowhere.
        if (!v || v.state.readOnly) return;
        const { from, to } = v.state.selection.main;
        const insert =
          typeof what === "string"
            ? what
            : what(from > 0 ? v.state.sliceDoc(from - 1, from) : undefined);
        v.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          scrollIntoView: true,
        });
        v.focus();
      },
      selection: () => {
        const main = view.current?.state.selection.main;
        return main ? { from: main.from, to: main.to } : null;
      },
      text: () => view.current?.state.doc.toString() ?? initial.current,
      replaceRange: (from, to, insert, guard) => {
        const v = view.current;
        if (!v || v.state.readOnly) return false;
        const len = v.state.doc.length;
        if (from < 0 || to < from || to > len) return false;
        if (
          guard &&
          (guard.at < 0 || v.state.sliceDoc(guard.at, guard.at + guard.text.length) !== guard.text)
        )
          return false;
        v.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          scrollIntoView: true,
          userEvent: "input.link",
          // One undo step of its own: a single Mod-Z takes the whole link back,
          // and the next key typed does not join it.
          annotations: isolateHistory.of("full"),
        });
        v.focus();
        return true;
      },
      track: (kind, from, to) => trackRef.current(kind, from, to),
    }),
    [],
  );

  // One view per document, rebuilt when the document or its editability changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is keyed on the document and its editability; everything else is read through refs.
  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      EditorView.lineWrapping,
      noteField,
      pendingField,
      flashField,
      // Mod-click follows a link, read or edit; kept apart from the paste and
      // drop handlers below.
      modClickFollowsLinks((href) => {
        const follow = handlers.current.onFollowLink;
        if (!follow || format === "json") return false;
        follow(href);
        return true;
      }),
      format === "json" ? jsonHighlighting() : markdownHighlighting(additions.current.tokens),
      // Search is not gated on `editable`, because finding is reading. It also
      // cannot be left to the browser's find: CodeMirror renders only the
      // viewport, so Mod-F would silently miss every line scrolled out, which is
      // worse than no search because it answers confidently and wrongly.
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of(searchKeymap),
      // An open picker's range follows the text, whoever changed it.
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        for (const t of trackers.current) {
          t.from = update.changes.mapPos(t.from, t.fromAssoc);
          t.to = update.changes.mapPos(t.to, t.toAssoc);
        }
      }),
      EditorView.updateListener.of((update) => {
        if (!update.selectionSet) return;
        const { from, to } = update.state.selection.main;
        handlers.current.onSelect?.({
          from,
          to,
          fromLine: update.state.doc.lineAt(from).number,
          toLine: update.state.doc.lineAt(to).number,
          text: update.state.sliceDoc(from, to),
        });
      }),
      editorTheme,
      gutter.current.numbers.of(gutterFor(gutterNow.current.lineNumbers)),
      gutter.current.quiet.of(quietFor(gutterNow.current.quiet)),
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
    ];
    if (editable)
      extensions.push(
        history(),
        // Where a drop will land, drawn while a file or a sidebar row is over
        // the text: a row carries no text, so the browser draws no caret for it.
        dropCursor(),
        // Mod-S is bound FIRST so it wins, and `preventDefault` is what stops the
        // browser's own Save-page dialog from opening over the surface.
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              handlers.current.onFlush?.();
              handlers.current.onSave?.();
              return true;
            },
          },
          // Before the default keymap, whose Mod-Shift-K deletes the line: in
          // prose a link is wanted far more often, and the line is still one
          // select and one delete away.
          {
            key: LINK_KEY,
            preventDefault: true,
            run: (v) => {
              const ask = handlers.current.onLinkRequest;
              // JSON has no links, but the key is still taken: falling through
              // to the default keymap would delete the line.
              if (format === "json") return true;
              if (!ask) return false;
              const { from, to } = v.state.selection.main;
              ask({
                kind: "wrap",
                from,
                to,
                // From the editor, which is ahead of the daemon's copy while typing.
                quote: v.state.sliceDoc(from, to),
                track: trackRef.current("wrap", from, to),
                ...caretPoint(v, from),
              });
              return true;
            },
          },
          ...historyKeymap,
          ...defaultKeymap,
          // Tab indents the line (or every line in the selection) and Shift-Tab
          // outdents, as an editor should; left to the browser, Tab moved focus
          // to the next control. The way out for a keyboard is CodeMirror's own:
          // Escape, then Tab within two seconds, moves focus on. The only Escape
          // here is the default keymap's, which collapses a selection first, so
          // with text selected it takes two. Read-only, there is no keymap and
          // Tab moves focus as before.
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.some((t) => t.annotation(remote))) return;
          handlers.current.onChange?.(() => {
            const now = update.view.state.doc.toString();
            lastWritten.current = now;
            return now;
          });
        }),
        // `](` or `[[` typed: the same picker, as a completion. Only a keystroke
        // counts (a paste, an undo or the agent's edit never opens it), never
        // mid-composition (an IME's keys are not yet the text), never in code,
        // and only with the caret right after the pair.
        EditorView.updateListener.of((update) => {
          const ask = handlers.current.onLinkRequest;
          if (!ask || !update.docChanged || update.view.composing) return;
          const typed = update.transactions.some(
            (t) => t.isUserEvent("input.type") && !t.isUserEvent("input.type.compose"),
          );
          if (!typed) return;
          const { state } = update;
          const sel = state.selection.main;
          if (!sel.empty) return;
          const head = sel.head;
          const kind = linkTrigger(state.sliceDoc(state.doc.lineAt(head).from, head));
          if (!kind || caretInCode(state.sliceDoc(0, head))) return;
          const from = kind === "wiki" ? head - 2 : head;
          const point = caretPoint(update.view, head);
          // Tracked from now, so a key typed before the picker opens is kept.
          const tracker = trackRef.current(kind, from, head);
          // After the update, not inside it: the picker takes focus, and moving
          // focus while CodeMirror is still applying the keystroke loses it.
          setTimeout(() => ask({ kind, from, to: head, quote: "", track: tracker, ...point }), 0);
        }),
        EditorView.domEventHandlers({
          // An image pasted in: its embed goes where the caret is, replacing
          // the selection as a paste of text would. Anything else pastes as it
          // always has.
          paste: (event, v) => {
            const take = handlers.current.onImages;
            const dt = event.clipboardData;
            if (!take || !dt || v.state.readOnly) return false;
            const files = clipboardImages(dt);
            if (files.length === 0) return false;
            event.preventDefault();
            const { from, to } = v.state.selection.main;
            take({
              files,
              how: "paste",
              track: followRef.current(from, to, from === to ? -1 : 1, -1),
              quote: v.state.sliceDoc(from, to),
            });
            return true;
          },
          // Images dropped in: their embeds go where they were dropped. A drop
          // with no image in it (a text file, a passage dragged within the
          // editor) is the editor's own, as before.
          // A sidebar row over the editor (kit-tree-drag-into-document): the
          // drop is accepted, so the drop point shows and the drop arrives.
          dragover: (event, v) => {
            if (!carriesRows(event.dataTransfer) || v.state.readOnly) return false;
            event.preventDefault();
            return false;
          },
          drop: (event, v) => {
            const dt = event.dataTransfer;
            // A sidebar row dropped in: always taken, so neither the editor nor
            // the browser inserts text of its own; the pane decides what it writes.
            if (carriesRows(dt)) {
              event.preventDefault();
              const rows = readRowDrag(dt);
              const takeRows = handlers.current.onRows;
              if (!rows || !takeRows || v.state.readOnly) return true;
              const at = dropPoint(v, event);
              takeRows({ rows, track: followRef.current(at, at, -1, -1) });
              return true;
            }
            const take = handlers.current.onImages;
            if (!take || !dt || v.state.readOnly) return false;
            const files = Array.from(dt.files).filter(isImageLike);
            if (files.length === 0) return false;
            event.preventDefault();
            const at = dropPoint(v, event);
            take({ files, how: "drop", track: followRef.current(at, at, -1, -1), quote: "" });
            return true;
          },
          // Typing and then clicking away must not leave the last keystrokes unsent.
          blur: () => {
            handlers.current.onFlush?.();
            return false;
          },
          // Only over a selection or a note. With neither there is nothing of ours
          // to offer, so the browser's own menu (spelling, copy, look up) is left
          // alone rather than replaced with an empty one.
          contextmenu: (event, v) => {
            if (!handlers.current.onContextMenu) return false;
            const { from, to } = v.state.selection.main;
            const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
            const noteIds =
              pos === null
                ? []
                : (notesRef.current ?? [])
                    .filter((n) => n.from !== null && n.to !== null && pos >= n.from && pos <= n.to)
                    .map((n) => n.id);
            if (from === to && noteIds.length === 0) return false;
            event.preventDefault();
            handlers.current.onContextMenu({
              x: event.clientX,
              y: event.clientY,
              from,
              to,
              noteIds,
            });
            return true;
          },
        }),
      );
    extensions.push(...(additions.current.extensions ?? []));
    const pending = editable ? replayRef.current : null;
    const replaying =
      pending && applyChanges(pending.base, pending.changes) === initial.current ? pending : null;
    const start = replaying ? replaying.base : initial.current;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: start, extensions }),
    });
    view.current = v;
    v.dispatch({
      effects: setNotes.of({ notes: notesRef.current ?? [], focused: focusedRef.current }),
    });
    // Each step is undoable, and marked remote: it is already in the daemon's text.
    for (const c of replaying?.changes ?? [])
      v.dispatch({ changes: c, annotations: [remote.of(true), isolateHistory.of("full")] });
    if (pending) handlers.current.onReplayed?.();
    return () => {
      handlers.current.onFlush?.();
      // A range in a view that is gone names nothing in the next one.
      for (const t of trackers.current) t.alive = false;
      trackers.current.clear();
      v.destroy();
      view.current = null;
    };
  }, [docKey, editable, format]);

  // The gutter turned on or off, or the reading mode quieted: reconfigured in
  // the view there is. Declared after the view effect, so a rebuild (a new
  // document) is built with the current choice and this finds nothing to change.
  useEffect(() => {
    view.current?.dispatch({ effects: gutter.current.numbers.reconfigure(gutterFor(lineNumbers)) });
  }, [lineNumbers]);
  useEffect(() => {
    view.current?.dispatch({ effects: gutter.current.quiet.reconfigure(quietFor(quiet)) });
  }, [quiet]);

  // Keeping your place. CodeMirror already knows both directions exactly:
  // `posAtCoords` for the line under the top edge of the scroller, and
  // `scrollIntoView` for the reverse, because the raw view's coordinate IS the
  // source. The rendered view is the half that has to interpolate. Declared after
  // the view effect so `view.current` is set when it runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on everything the view is keyed on, as well as the place.
  useEffect(() => {
    const v = view.current;
    if (!v || !place) return;
    const scroller = v.scrollDOM;
    const topLine = () => {
      const r = scroller.getBoundingClientRect();
      // `precise: false` always answers, which is what a scroll position needs: the
      // top edge often falls in the content's padding, not on a character.
      const pos = v.posAtCoords({ x: r.left + r.width / 2, y: r.top + 1 }, false);
      return v.state.doc.lineAt(Math.max(0, Math.min(pos, v.state.doc.length))).number;
    };
    const toLine = (n: number) => {
      // The first line is the TOP, not a line to align to: scrolling it into view
      // would scroll the editor's own top padding away.
      if (n <= 1) {
        scroller.scrollTop = 0;
        return;
      }
      const line = v.state.doc.line(Math.max(1, Math.min(n, v.state.doc.lines)));
      v.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: "start" }) });
    };
    // Synchronous, like the rendered pane's: the place reads a drive's own event by
    // ORDER against the animation frame, and a deferred report would arrive on the
    // wrong side of it.
    const onScroll = () => place.report("raw", topLine());
    scroller.addEventListener("scroll", onScroll, { passive: true });
    const leave = place.join("raw", { to: toLine, at: () => scroller.scrollTop });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      leave();
    };
  }, [place, docKey, editable]);

  // Clicking a note's quote brings it into view and selects it.
  const revealed = useRef(onRevealed);
  revealed.current = onRevealed;
  /** When a followed heading's mark clears (see the reveal effect). */
  const headingMarkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const end = Math.min(reveal.to, v.state.doc.length);
    const start = Math.min(reveal.from, end);
    const mark = reveal.heading;
    const len = v.state.doc.length;
    v.dispatch({
      selection: { anchor: start, head: end },
      effects: mark
        ? [
            EditorView.scrollIntoView(start, { y: "start", yMargin: 48 }),
            setFlash.of({ from: Math.min(mark.from, len), to: Math.min(mark.to, len) }),
          ]
        : EditorView.scrollIntoView(start, { y: "center" }),
    });
    v.focus();
    revealed.current?.(reveal.seq);
    if (!mark) return;
    // ⛔ NOT this effect's cleanup: spending the reveal (just above) re-renders
    // with no reveal, which would run a cleanup at once and leave the mark for
    // good. The timer lives in a ref, cleared by the next mark or on unmount.
    clearTimeout(headingMarkTimer.current);
    headingMarkTimer.current = setTimeout(
      () => view.current?.dispatch({ effects: setFlash.of(null) }),
      FLASH_MARK_MS,
    );
  }, [reveal]);
  useEffect(() => () => clearTimeout(headingMarkTimer.current), []);

  // A pointed-at passage: shown and marked, never selected, never focused.
  const flashSeq = flash?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request's seq is the trigger; its range is read with it.
  useEffect(() => {
    const v = view.current;
    if (!v || !flash) return;
    const end = Math.min(flash.to, v.state.doc.length);
    const start = Math.min(flash.from, end);
    v.dispatch({
      effects: [
        setFlash.of({ from: start, to: end }),
        EditorView.scrollIntoView(start, { y: "center" }),
      ],
    });
    const t = setTimeout(
      () => view.current?.dispatch({ effects: setFlash.of(null) }),
      FLASH_MARK_MS,
    );
    return () => clearTimeout(t);
  }, [flashSeq]);

  // A clear clears the highlight too: the chip and the editor cannot disagree about
  // what is chosen. Collapsing to the head fires the update listener, which reports
  // the empty range (the same path a click takes); nothing is held by then, so it
  // does not come round again.
  const unpainted = useRef(clearSeq);
  useEffect(() => {
    const v = view.current;
    if (!v || clearSeq === undefined || clearSeq === unpainted.current) return;
    unpainted.current = clearSeq;
    v.dispatch({ selection: { anchor: v.state.selection.main.head } });
    // And the browser's own, because the chip's X is clicked OUTSIDE the editor:
    // CodeMirror syncs the DOM selection from its state only while focused, so
    // collapsing the model alone would leave the grey blurred highlight painted
    // over a passage nothing was holding.
    // Not while the editor has focus: then the clear came from a click or a key in
    // the editor itself, whose own selection is already where the human put it, and
    // emptying the DOM selection under a focused CodeMirror makes it read the caret
    // as position 0 (the next key lands at the top of the document).
    if (v.hasFocus) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && v.dom.contains(sel.getRangeAt(0).commonAncestorContainer))
      sel.removeAllRanges();
  }, [clearSeq]);

  useEffect(() => {
    view.current?.dispatch({ effects: setPending.of(pendingNote ?? null) });
  }, [pendingNote]);

  // Notes arrive already placed; push them in whenever the daemon re-places them,
  // or the panel focuses another.
  useEffect(() => {
    view.current?.dispatch({ effects: setNotes.of({ notes: notes ?? [], focused: focusedNote }) });
  }, [notes, focusedNote]);

  // The text changed UNDER us (a version made active, the file reloaded).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    // A re-render carrying the SAME text the daemon last gave us is not news.
    // Applying it would throw away everything typed since: the prop trails the
    // buffer by design, because the daemon does not echo an edit back.
    if (text === lastRemote.current) return;
    lastRemote.current = text;
    // The client updates its copy of what it sent, and that copy arrives here as
    // the prop. It is this view's own text; applying it could undo a key typed
    // since.
    if (text === lastWritten.current) {
      lastWritten.current = null;
      return;
    }
    // Any other text replaces the buffer, so what this view last wrote is no
    // longer in it. Its echo may never come (a write sent as the client saw a
    // switch, `kit-agent-activate-pending-edit`), and the same text arriving
    // later (switching back to that version) must then be applied, not skipped.
    lastWritten.current = null;
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
