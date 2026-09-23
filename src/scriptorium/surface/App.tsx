// The surface: three drag-resizable panes (E11 — `resizable`, not `sidebar`),
// the context sidebar on the left (E16 — built first, props-only so it can move
// to the kit), the open document read-only in the centre with the status strip
// under it (E18), and the conversation placeholder on the right (chat is a later
// piece, E16). Either side column collapses out of the way (E64).

import { cn } from "cn";
import {
  GlassesIcon,
  MessagesSquareIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  SunIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Layout, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/ui/resizable";
import type {
  ChatMessage,
  ContextEntry,
  DiffSide,
  DocView,
  NoteWaiting,
  PublicState,
  Waiting,
} from "../backend/protocol";
import { selectionOnScreen } from "../backend/selection";
import { ActiveVersionToast } from "./components/ActiveVersionToast";
import { ChatComposer } from "./components/ChatComposer";
import { ContextSidebar } from "./components/context/ContextSidebar";
import { joinPath, shortPath } from "./components/context/model";
import { DocumentPane, VIEW_MODES, type ViewMode } from "./components/DocumentPane";
import { HistoryArrows } from "./components/HistoryArrows";
import { NotesPanel } from "./components/NotesPanel";
import { SearchBar } from "./components/SearchBar";
import { Spinner, TasksPanel } from "./components/TasksPanel";
import { TaskToasts } from "./components/TaskToasts";
import { Toasts, useToasts } from "./components/Toasts";
import { WaitingBadge, WaitingDot } from "./components/WaitingBadge";
import {
  collapsedSides,
  DEFAULT_SIZE,
  decodeOpenSizes,
  encodeOpenSizes,
  isReader,
  MIN_SIZE,
  OPEN_PREF,
  readerAct,
  rememberOpen,
  reopenSize,
  type Side,
} from "./state/columns";
import { askAboutNote, badgesOn, elsewhere, loudest, owedLabel, waitingOf } from "./state/notes";
import { applySelectionEvent, type HeldSelection, type SelectionEvent } from "./state/selection";
import { applyTheme, readAppliedTheme, type Theme } from "./state/theme";
import { type Connection, textKey, useDaemon } from "./state/useDaemon";

/** The pane ids are the persisted layout's keys — renaming one forgets a viewer's sizes. */
export const PANES = ["context", "document", "chat"] as const;
export const LAYOUT_ID = "scriptorium:panes";
/** The split inside the document pane keeps its own sizes (E29). */
export const SPLIT_PANES = ["doc-raw", "doc-rendered"] as const;
export const SPLIT_LAYOUT_ID = "scriptorium:doc-split";
/** Raw, rendered or split — a viewer's choice, kept in the home's prefs like the theme. */
const VIEW_PREF = "doc:view";

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "connecting…",
  open: "connected",
  closed: "daemon unreachable — retrying",
};

/** A small icon button for the columns' own chrome — collapse, reopen, reader. */
function ColumnButton({
  label,
  onClick,
  pressed,
  control,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  /** Names the control so focus can be handed to it when its twin goes away. */
  control?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-column-control={control}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-faint outline-none",
        "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
        "[&_svg]:size-3.5",
        pressed && "bg-surface-raised text-ink",
      )}
    >
      {children}
    </button>
  );
}

/**
 * ⛔ `pinned` NEVER CLIPS (E64, verifier): at the narrowest width the layout
 * allows, the title and the other actions give way — they shrink and clip —
 * and the pinned control (the column's collapse button) stays on screen.
 */
function PaneHeading({
  children,
  actions,
  pinned,
}: {
  children: string;
  actions?: React.ReactNode;
  pinned?: React.ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge px-2 text-xs font-medium tracking-wide text-ink-dim uppercase">
      <span className="min-w-0 truncate pl-1">{children}</span>
      {actions && (
        <div className="ml-auto flex min-w-0 items-center gap-0.5 overflow-hidden">{actions}</div>
      )}
      {pinned && (
        <div className={cn("flex shrink-0 items-center", !actions && "ml-auto")}>{pinned}</div>
      )}
    </div>
  );
}

/** The library's storage key, shortened to fit the daemon's pref-key rule. */
const prefKey = (key: string) => key.replace(/^react-resizable-panels:/, "panes:").slice(0, 64);

export function App() {
  const daemon = useDaemon();
  const { state, connection, send } = daemon;
  const [theme, setTheme] = useState<Theme>(readAppliedTheme);
  /**
   * A search result the human clicked (E59): open this document, and scroll to
   * `at` when it arrives. `seq` makes the same result clickable twice.
   *
   * ⚠ IT LIVES UP HERE because the search bar is in the HEADER and the editor
   * is inside `Workspace`; passing a request down is what keeps `Workspace`'s
   * reveal state where it belongs rather than hoisting the whole editor's
   * plumbing to the top of the tree.
   */
  const [jump, setJump] = useState<{
    path: string;
    at?: { from: number; to: number };
    seq: number;
  } | null>(null);

  // ONE global theme, last choice wins (Cole, E21): kept in the HOME's prefs so
  // every session — each on its own port, where browser storage cannot follow —
  // opens in it. The browser copy only lets the pre-paint script avoid a flash.
  const savedTheme = state?.prefs.theme;
  useEffect(() => {
    if ((savedTheme === "dark" || savedTheme === "light") && savedTheme !== readAppliedTheme()) {
      applyTheme(savedTheme);
      setTheme(savedTheme);
    }
  }, [savedTheme]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    send({ type: "prefs.set", key: "theme", value: next });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-surface px-3">
        <span className="font-manuscript text-base text-ink">scriptorium</span>
        {state && (
          <span className="font-mono text-xs text-ink-faint">session {state.sessionId}</span>
        )}
        {/* ⛔ CENTRED IN THE HEADER (Cole). `mx-auto` between the two flex
            groups is what centres it against the WINDOW rather than against
            whatever the label on its left happens to say today — a bar that
            drifts when the session id changes length reads as misaligned. */}
        {state && (
          <div className="mx-auto flex min-w-0 flex-1 justify-center px-4">
            <SearchBar
              report={daemon.search}
              onQuery={(query) => send({ type: "search", query })}
              onOpen={(target) => {
                send({ type: "open", path: target.path });
                // The document has to arrive before it can be scrolled, so the
                // jump is handed to the pane as a REQUEST rather than done here.
                setJump({
                  path: target.path,
                  ...(target.at ? { at: target.at } : {}),
                  seq: Date.now(),
                });
              }}
            />
          </div>
        )}
        <span
          data-connection={connection}
          className="ml-auto text-xs text-ink-dim data-[connection=closed]:text-attention"
        >
          {CONNECTION_LABEL[connection]}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </Button>
      </header>
      {state ? (
        <Workspace state={state} daemon={daemon} jump={jump} />
      ) : (
        <div className="flex-1" aria-busy="true" />
      )}
    </div>
  );
}

/**
 * Mounted once the first snapshot has arrived, so the panes' saved sizes (kept
 * in the HOME's prefs, not the browser — every session is a new port and
 * browser storage is keyed by origin) are known before the group lays out.
 */
function Workspace({
  state,
  daemon,
  jump,
}: {
  state: PublicState;
  daemon: ReturnType<typeof useDaemon>;
  /** E59: a clicked search result — open it, then scroll to the hit. */
  jump: { path: string; at?: { from: number; to: number }; seq: number } | null;
}) {
  const {
    send,
    connection,
    texts,
    noteText,
    diff,
    listDir,
    planMove,
    mapOf,
    suggestMeta,
    lastError,
    clearError,
    done,
  } = daemon;
  const prefsRef = useRef(state.prefs);
  prefsRef.current = state.prefs;
  const storage = useMemo(
    () => ({
      getItem: (key: string) => prefsRef.current[prefKey(key)] ?? null,
      setItem: (key: string, value: string) =>
        send({ type: "prefs.set", key: prefKey(key), value }),
    }),
    [send],
  );
  const layout = useDefaultLayout({ id: LAYOUT_ID, panelIds: [...PANES], storage });

  // ── the side columns (E64) ─────────────────────────────────────────────────
  // ⛔ COLLAPSED IS READ OFF THE LAYOUT (`state/columns.ts`): a collapsed column
  // is a panel at width 0, persisted by the same layout pref as every other
  // size, so the button, a drag shut and a reload all agree by construction.
  // This copy of the layout exists only so React re-renders when it changes;
  // it is set from the library's own callback and never written back.
  const [layoutNow, setLayoutNow] = useState<Layout | undefined>(layout.defaultLayout);
  const collapsed = collapsedSides(layoutNow);
  const openSizes = decodeOpenSizes(state.prefs[OPEN_PREF]);
  const openSizesRef = useRef(openSizes);
  openSizesRef.current = openSizes;
  const contextPanel = usePanelRef();
  const chatPanel = usePanelRef();
  const panelFor = useCallback(
    (side: Side) => (side === "context" ? contextPanel : chatPanel).current,
    [contextPanel, chatPanel],
  );
  /** Collapse `side`; false when there was nothing to do (already shut). */
  const collapse = useCallback(
    (side: Side) => {
      const panel = panelFor(side);
      if (!panel || panel.isCollapsed()) return false;
      panel.collapse();
      return true;
    },
    [panelFor],
  );
  // ⚠ NOT the library's `expand()`: it reopens to a width it keeps in memory,
  // so after a reload a column came back at its minimum. The width it reopens
  // to is the home's (`panes:open`), like the rest of the layout — capped so it
  // never pushes the other column shut (`reopenSize`).
  const expand = useCallback(
    (side: Side) => {
      const panel = panelFor(side);
      if (!panel?.isCollapsed()) return false;
      const other = panelFor(side === "context" ? "chat" : "context");
      const around = other
        ? { [side === "context" ? "chat" : "context"]: other.getSize().asPercentage }
        : undefined;
      panel.resize(`${reopenSize(openSizesRef.current, side, around)}%`);
      return true;
    },
    [panelFor],
  );
  /**
   * ⛔ THE HANDLE'S ENTER GOES THROUGH THE SAME TWO ACTS (verifier). The
   * library binds Enter on a separator to its own collapse/expand, and its
   * expand reopens at the MINIMUM after a reload. Taken in the capture phase —
   * React's capture listener sits on the root, which the event reaches before
   * the library's listener on the handle itself — so the library never sees it.
   * The right handle's Enter used to act on the document (not collapsible, so
   * it did nothing); it now toggles the conversation, the mirror of the left.
   */
  const handleEnter = (side: Side) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (collapsed[side]) expand(side);
    else collapse(side);
  };
  /**
   * Where focus goes when a column button takes itself away (E64, verifier):
   * collapsing makes the button inert and reopening removes the reopen button,
   * so focus fell to <body>. The twin control is where the next act is.
   */
  const focusNext = useRef<string | null>(null);
  const toggleFrom = (side: Side, act: "collapse" | "expand") => {
    const acted = act === "collapse" ? collapse(side) : expand(side);
    // ⚠ A no-op leaves nothing pending: a stale hand-off would otherwise grab
    // focus the next time that control happened to render (reviewer).
    focusNext.current = acted ? `${side}-${act === "collapse" ? "reopen" : "collapse"}` : null;
  };
  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    const el = document.querySelector<HTMLElement>(`[data-column-control="${id}"]`);
    if (!el || el.closest("[inert]")) return;
    focusNext.current = null;
    el.focus();
  });
  const onLayoutChanged = useCallback(
    (next: Layout, meta: Parameters<typeof layout.onLayoutChanged>[1]) => {
      layout.onLayoutChanged(next, meta);
      setLayoutNow(next);
      const remembered = rememberOpen(openSizesRef.current, next, meta.isUserInteraction);
      if (remembered !== openSizesRef.current)
        send({ type: "prefs.set", key: OPEN_PREF, value: encodeOpenSizes(remembered) });
    },
    [layout.onLayoutChanged, send],
  );
  /**
   * What the human is typing to the agent. ⛔ HELD HERE, NOT IN THE COMPOSER
   * (E64): the composer is drawn in the conversation column or floating under
   * the document depending on whether that column is collapsed, and a draft
   * living inside it would be lost — or, drawn twice, duplicated — every time
   * it moved. One draft, one meaning, wherever it is shown.
   */
  const [draft, setDraft] = useState("");
  const splitLayout = useDefaultLayout({
    id: SPLIT_LAYOUT_ID,
    panelIds: [...SPLIT_PANES],
    storage,
  });

  const saved = state.prefs[VIEW_PREF];
  const mode: ViewMode = (VIEW_MODES as readonly string[]).includes(saved ?? "")
    ? (saved as ViewMode)
    : "rendered";
  const setMode = useCallback(
    (next: ViewMode) => send({ type: "prefs.set", key: VIEW_PREF, value: next }),
    [send],
  );
  /** E64: rendered with both columns shut — derived, never stored (`isReader`). */
  const reader = isReader(mode, collapsed);
  const toggleReader = () => {
    const act = readerAct(mode, collapsed);
    if (act.mode) setMode(act.mode);
    for (const side of act.collapse) collapse(side);
    for (const side of act.expand) expand(side);
  };

  // What the comparison is against (E36). Deliberately NOT persisted: which
  // version you wanted to look at last session says nothing about this one,
  // and the original is the side that always exists.
  const [against, setAgainst] = useState<DiffSide>("original");
  const { toasts, announce, dismiss } = useToasts();
  // The editor's selection, kept here because the NOTES PANEL is the thing that
  // acts on it and it lives in the other pane (E45).
  // The chat's chip mirrors it, and the daemon is told of every change (below).
  const [selection, setSelection] = useState<HeldSelection | null>(null);
  /**
   * Bumped when the held selection goes away — the chip's X, a note consuming
   * the passage (E57), or a click that clears it in EITHER pane.
   *
   * ⛔ CLEARING IT HAS TO REACH THE HIGHLIGHT. Cole's ruling (2026-09-22):
   * "if you clear the context from the chat, that should basically be treated
   * as clearing the selection", and "clicking in either clears the selection,
   * it's the simpler ux pattern". One state, one meaning, so neither the human
   * nor the agent has to work out which copy is live. The panes own their own
   * selection (the browser's in the rendered half, CodeMirror's in the raw
   * one), so a clear reaches them as a seq they act on, NOT as a second copy
   * of what is selected. `applySelectionEvent` decides when it is bumped.
   */
  const [clearSeq, setClearSeq] = useState(0);
  const onSelectionEvent = useCallback(
    (event: SelectionEvent) => {
      const next = applySelectionEvent(selection, event);
      if (next.held !== selection) setSelection(next.held);
      if (next.clearPaint) setClearSeq((n) => n + 1);
    },
    [selection],
  );

  // Which of the right pane's two things is showing.
  const [rightPane, setRightPane] = useState<"conversation" | "notes" | "tasks">("conversation");
  /** Asking the editor to scroll a note's range into view — bumped per request. */
  const [reveal, setReveal] = useState<{ from: number; to: number; seq: number } | null>(null);
  /** The note the document is pointing at (E47). */
  const [focusedNote, setFocusedNote] = useState<string | null>(null);

  const open: DocView | null = state.docs.find((d) => d.slug === state.openDoc) ?? null;
  const openNotes = (open?.notes ?? []).filter((n) => !n.resolved);
  /** E65: the open document's notes still owed an answer — drawn, never decided, here. */
  const noteBadges = useMemo(
    () => badgesOn(state.notesWaiting, open?.slug ?? null),
    [state.notesWaiting, open?.slug],
  );
  /**
   * ⛔ ONE SCOPE: THE SESSION (verifier D3). The tab's dot, the floating
   * composer and the panel's pointer all read every owed note in the session,
   * so a note owed on another document is visible without collapsing a column.
   * Only the panel's LIST is the open document's, and it points at the rest.
   */
  const notesLoudest = loudest(state.notesWaiting.map((n) => n.badge));
  const notesOthers = elsewhere(state.notesWaiting, open?.slug ?? null).map((o) => ({
    ...o,
    name: state.docs.find((d) => d.slug === o.doc)?.name ?? o.doc,
  }));
  /**
   * E65: "may be stuck" → ask the agent, in the conversation. It is the human's
   * message, so the agent's answer to it answers the note as well, and while it
   * waits it carries E53's own badge. The conversation comes forward so the
   * human sees it go.
   */
  const askAbout = (
    note: { id: string; quote: string; body: string },
    doc: { slug: string; name: string },
  ) => {
    // The message carries the note's REFERENCE (verifier D4), so the agent can
    // resolve it by id; the daemon drops a second ask while one is unanswered.
    send({
      type: "say",
      text: askAboutNote(note, doc.name),
      withSelection: false,
      note: { doc: doc.slug, id: note.id },
    });
    setRightPane("conversation");
  };
  const openTasks = state.tasks.filter((t) => t.doneAt === undefined);
  const activeDoc =
    open?.entryId && open.rel !== null ? { entryId: open.entryId, rel: open.rel } : null;
  const text = open ? texts.get(textKey(open.slug, open.active)) : undefined;

  // ⛔ THE JUMP WAITS FOR THE DOCUMENT. A search result is clicked while another
  // document is open, so `open` still names the old one for a frame or two;
  // revealing immediately would scroll the WRONG document to an offset that
  // means nothing in it. Keyed on `seq` and on the document actually being the
  // one asked for.
  const jumped = useRef<number>(0);
  useEffect(() => {
    if (!jump?.at || jump.seq === jumped.current) return;
    if (!open || open.original !== jump.path) return;
    jumped.current = jump.seq;
    setReveal({ from: jump.at.from, to: jump.at.to, seq: jump.seq });
  }, [jump, open]);

  // A snapshot can name an open document whose text this viewer has never
  // received (a reload, a reconnect, the agent activating a version): ask once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!open || text !== undefined) return;
    const key = textKey(open.slug, open.active);
    if (asked.current.has(key)) return;
    asked.current.add(key);
    send({ type: "read", doc: open.slug, version: open.active });
  }, [open, text, send]);

  // ⛔ THE DAEMON MUST BE TOLD. `say` attaches the selection the DAEMON holds,
  // not one the surface sends with the message — so the selection has to reach
  // it as it changes. Sent only when the RANGE changes, not on every cursor
  // move, because a caret drifting through a document is not news.
  const openSlug = open?.slug ?? null;
  const activeVersion = open?.active ?? null;
  const original = open?.original ?? null;
  /**
   * The held selection, if it is about the text on screen (E66) — what the
   * chip, the Notes panel and the daemon are given. ⛔ NOT A SECOND COPY: it is
   * `selection` or null, and the effect below makes `selection` itself null
   * one render later. It exists for that one render, in which the document has
   * already changed and `selection` has not — the render that used to send the
   * daemon alpha's words stamped with beta's name.
   */
  const shown = selectionOnScreen(
    selection,
    openSlug !== null && activeVersion !== null ? { doc: openSlug, version: activeVersion } : null,
  );
  // ⛔ SWITCHING THE DOCUMENT IS A CLEAR (E66), like the chip's X: the held
  // selection goes, and so does any paint of it. Whatever moved the document —
  // the context list, a search result, a note's "open", the agent, the history
  // arrows, a version made active — reaches here as the same two values.
  useEffect(() => {
    onSelectionEvent({ type: "shown", doc: openSlug, version: activeVersion });
  }, [openSlug, activeVersion, onSelectionEvent]);
  useEffect(() => {
    if (!openSlug || activeVersion === null || original === null) return;
    send({
      type: "select",
      selection: shown
        ? {
            doc: shown.doc,
            version: shown.version,
            path: original,
            fromLine: shown.fromLine,
            toLine: shown.toLine,
            text: shown.text,
          }
        : null,
    });
  }, [openSlug, activeVersion, original, shown?.fromLine, shown?.toLine, shown?.text, send]);

  // Ask for the comparison whenever anything it depends on moves — the
  // document, the active version, the chosen side, or the text itself. A merge
  // lands as a new text, so this is also what refreshes the view after one:
  // the hunks the human sees are always the hunks the daemon would apply.
  useEffect(() => {
    if (mode !== "compare" || !open) return;
    // The side can vanish under us — it is a version, and a version can be
    // deleted (E41) or become the active one. Either way the original is the
    // side that always exists.
    if (
      against === open.active ||
      (typeof against === "number" && !open.versions.some((v) => v.n === against))
    ) {
      setAgainst("original");
      return;
    }
    send({ type: "diff", doc: open.slug, against });
  }, [mode, open, against, text, send]);

  // ⌘S belongs to the SESSION, not to the editor's focus: in rendered mode the
  // editor is not mounted at all, and the browser's own Save-page dialog is
  // what opens if nothing claims the key. The editor keeps its own binding too
  // (it flushes the pending buffer first), and both end at the same `save`.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      const doc = openRef.current;
      e.preventDefault();
      if (doc?.dirty) send({ type: "save", doc: doc.slug });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  const onOpenDoc = useCallback(
    (entry: ContextEntry, rel: string) => send({ type: "open", path: joinPath(entry.root, rel) }),
    [send],
  );

  // A new document this viewer made opens at once (and the sidebar puts it in
  // rename mode); a new folder only renames.
  const created = done && (done.op === "doc.create" || done.op === "folder.create") ? done : null;

  /** The one composer's props, whichever place it is drawn in (E64). */
  const composer = {
    connected: connection === "open",
    attachable:
      open && shown
        ? {
            doc: open.slug,
            name: open.name,
            version: open.active,
            fromLine: shown.fromLine,
            toLine: shown.toLine,
            text: shown.text,
          }
        : null,
    draft,
    onDraft: setDraft,
    onDrop: () => onSelectionEvent({ type: "drop" }),
    onSend: (text: string, withSelection: boolean) => send({ type: "say", text, withSelection }),
  };
  useEffect(() => {
    if (created?.op === "doc.create") send({ type: "open", path: created.path });
  }, [created, send]);

  return (
    <>
      <ActiveVersionToast doc={open} announce={announce} />
      <TaskToasts tasks={state.tasks} announce={announce} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="context"
          panelRef={contextPanel}
          collapsible
          defaultSize={`${DEFAULT_SIZE.context}`}
          minSize={`${MIN_SIZE.context}`}
          // ⚠ Kept MOUNTED while collapsed, and inert: the tree's open folders
          // and any rename in progress are the sidebar's own state, and
          // unmounting it would forget them every time it was put away.
          inert={collapsed.context}
          className="flex flex-col bg-surface"
          // ⛔ ⌘Z HERE MEANS THE CONTEXT, AND ONLY WHILE THE FOCUS IS IN HERE
          // (Cole: "if you've got that area focused, shortcuts could do it").
          // Scoped by letting the event BUBBLE to this panel rather than
          // listening on the window: the editor's ⌘Z must keep belonging to
          // CodeMirror, and a global listener would have to guess which one the
          // human meant. Focus is the answer, so focus is the mechanism.
          //
          // ⚠ A DELETING UNDO IS NOT OFFERED TO THE KEYBOARD. There is no
          // dialog in a keystroke, and a reflex that removes a file is the one
          // thing this must not grow into; the arrow (which can ask) stays the
          // only way through that step.
          onKeyDown={(e) => {
            if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
            e.preventDefault();
            if (e.shiftKey) {
              if (state.history.canRedo) send({ type: "history.redo" });
              return;
            }
            if (state.history.canUndo && !state.history.undoDeletes) send({ type: "history.undo" });
          }}
        >
          <PaneHeading
            actions={
              <HistoryArrows
                history={state.history}
                display={(p) => shortPath(p, state.userHome, 2)}
                onUndo={(confirmDelete) =>
                  send(
                    confirmDelete
                      ? { type: "history.undo", confirmDelete }
                      : { type: "history.undo" },
                  )
                }
                onRedo={() => send({ type: "history.redo" })}
              />
            }
            pinned={
              <ColumnButton
                label="Collapse the context column"
                control="context-collapse"
                onClick={() => toggleFrom("context", "collapse")}
              >
                <PanelLeftCloseIcon aria-hidden />
              </ColumnButton>
            }
          >
            Context
          </PaneHeading>
          <ContextSidebar
            entries={state.context}
            activeDoc={activeDoc}
            userHome={state.userHome}
            workspace={state.workspace}
            onOpenDoc={onOpenDoc}
            onAddPath={(path) => send({ type: "context.add", path })}
            onStructure={send}
            onReveal={(path) => send({ type: "reveal", path })}
            onPick={(want) => send({ type: "pick", want })}
            metaFor={(path) => state.docMeta[path]}
            listDir={listDir}
            planMove={planMove}
            mapOf={mapOf}
            onOpenPath={(path) => send({ type: "open", path })}
            created={created}
            notice={lastError}
            onDismissNotice={clearError}
          />
        </ResizablePanel>
        <ResizableHandle withHandle onKeyDownCapture={handleEnter("context")} />
        <ResizablePanel id="document" defaultSize="50" minSize="25" className="flex flex-col bg-bg">
          <DocumentPane
            doc={open}
            text={text}
            mode={mode}
            onMode={setMode}
            docPercent={layoutNow?.document ?? 100}
            quiet={reader}
            // ⛔ A COLLAPSED COLUMN IS REOPENED FROM THE EDGE IT WENT TO (E64).
            // The button sits at that end of the document's heading, where the
            // column was, so the way back is where the eye goes looking for it.
            headingStart={
              collapsed.context && (
                <ColumnButton
                  label="Show the context column"
                  control="context-reopen"
                  onClick={() => toggleFrom("context", "expand")}
                >
                  <PanelLeftOpenIcon aria-hidden />
                </ColumnButton>
              )
            }
            headingEnd={
              <>
                <ColumnButton
                  label={
                    reader
                      ? "Leave reader mode — bring the columns back"
                      : "Reader mode — rendered, with both columns out of the way"
                  }
                  pressed={reader}
                  onClick={toggleReader}
                >
                  <GlassesIcon aria-hidden />
                </ColumnButton>
                {collapsed.chat && (
                  <ColumnButton
                    label="Show the conversation column"
                    control="chat-reopen"
                    onClick={() => toggleFrom("chat", "expand")}
                  >
                    <PanelRightOpenIcon aria-hidden />
                  </ColumnButton>
                )}
              </>
            }
            // ⛔ TALKING TO THE AGENT NEVER NEEDS THE COLUMN (E64, Cole —
            // conversation-primary). With the conversation collapsed, the SAME
            // composer floats under the document: same draft, same chip.
            dock={
              collapsed.chat && (
                <FloatingComposer
                  chat={state.chat}
                  waiting={state.waiting}
                  notesWaiting={state.notesWaiting}
                  docs={state.docs}
                  openDoc={open?.slug ?? null}
                  onAsk={askAbout}
                  onOpen={() => {
                    setRightPane("conversation");
                    toggleFrom("chat", "expand");
                  }}
                >
                  <ChatComposer floating {...composer} />
                </FloatingComposer>
              )
            }
            diff={diff}
            onAgainst={setAgainst}
            onTake={(hunks) => {
              if (open) send({ type: "merge", doc: open.slug, against, hunks });
            }}
            onActivate={(version) => {
              if (open) send({ type: "activate", doc: open.slug, version });
            }}
            onNewVersion={(label, intent) => {
              if (open)
                send({
                  type: "version.new",
                  doc: open.slug,
                  ...(label ? { label } : {}),
                  activate: intent === "branch",
                });
            }}
            onDeleteVersion={(version) => {
              if (open) send({ type: "version.delete", doc: open.slug, version });
            }}
            onRevealVersion={(version) => {
              if (open) send({ type: "reveal.version", doc: open.slug, version });
            }}
            onSelect={(from, to, fromLine, toLine, sel) => {
              if (!open) return;
              onSelectionEvent({
                type: "report",
                selection: {
                  doc: open.slug,
                  version: open.active,
                  from,
                  to,
                  fromLine,
                  toLine,
                  text: sel,
                },
              });
            }}
            reveal={reveal}
            clearSeq={clearSeq}
            focusedNote={focusedNote}
            notesWaiting={noteBadges}
            onAddNote={(from, to, body) => {
              if (open) send({ type: "note.add", doc: open.slug, from, to, body });
              // ⛔ THE NOTE CONSUMES THE SELECTION (E57, Cole). Making a note is
              // what you chose to DO with that passage, so leaving it attached
              // means the next message you type silently carries the same text
              // again — "I've made some notes, take a look" arriving with the
              // very passage the note is about. Clearing it here also reaches
              // the daemon, because the effect below reports `selection` as it
              // changes, so the agent's view and the composer's chip agree — and
              // the highlight goes with it, like any other drop.
              onSelectionEvent({ type: "drop" });
            }}
            onDeleteNote={(id) => {
              if (open) send({ type: "note.remove", doc: open.slug, id });
            }}
            onShowNote={(id) => {
              // Pointing at a note has to OPEN the notes — the panel may be
              // showing the conversation, or be collapsed (E64), and either
              // way a border nobody can see is not an answer.
              setRightPane("notes");
              toggleFrom("chat", "expand");
              setFocusedNote(id);
            }}
            splitLayout={splitLayout}
            onAddFrontmatter={async () => {
              if (!open) return;
              const { block, error } = await suggestMeta(open.original);
              if (!block || error) return;
              // The block goes into the BUFFER, not the file: the human reads it,
              // fills the blank description, and Save puts it on disk (E7).
              const next = `${block}${text ?? ""}`;
              noteText(open.slug, open.active, next);
              send({ type: "edit", doc: open.slug, version: open.active, text: next });
            }}
            onFollowLink={(target) => {
              if (open) send({ type: "link.open", from: open.original, target });
            }}
            onEdit={(next) => {
              if (!open) return;
              // The daemon does not echo an edit back, so this viewer keeps its
              // own copy in step — otherwise the prop would trail the buffer and
              // every re-render would look like news from the daemon.
              noteText(open.slug, open.active, next);
              send({ type: "edit", doc: open.slug, version: open.active, text: next });
            }}
            onSave={() => open && send({ type: "save", doc: open.slug })}
            onRevert={() => open && send({ type: "revert", doc: open.slug })}
          />
        </ResizablePanel>
        <ResizableHandle withHandle onKeyDownCapture={handleEnter("chat")} />
        <ResizablePanel
          id="chat"
          panelRef={chatPanel}
          collapsible
          defaultSize={`${DEFAULT_SIZE.chat}`}
          minSize={`${MIN_SIZE.chat}`}
          inert={collapsed.chat}
          className="flex flex-col bg-surface"
        >
          {/* ⛔ TWO THINGS, ONE PANE (E45). A fourth resizable pane would make
              every pane too narrow to read; notes and the conversation are both
              "what is being said about this document", so they share, and when
              chat lands it joins as the same kind of tab rather than needing
              somewhere new to live. */}
          {/* ⛔ THE COLLAPSE BUTTON IS PINNED, THE TABS GIVE WAY (E64,
              verifier): the tabs need ~275 px and the column's minimum is
              15% of the window, so with the button after them it was pushed
              off the edge even at 1280. The tabs wrap, then clip; the button
              stays on screen at every width the layout allows. */}
          <div className="flex min-h-9 shrink-0 items-center gap-0.5 border-b border-edge px-2 py-1">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 overflow-hidden">
              {(["conversation", "notes", "tasks"] as const).map((which) => (
                <button
                  key={which}
                  type="button"
                  onClick={() => setRightPane(which)}
                  aria-pressed={rightPane === which}
                  className={cn(
                    "rounded-sm px-2 py-1 text-xs font-medium tracking-wide uppercase",
                    "text-ink-dim hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                    rightPane === which && "bg-surface-raised text-ink",
                  )}
                >
                  {/* Parenthesised so the number reads as a COUNT rather than
                    part of the tab's name (Cole). */}
                  {which === "notes" && (openNotes.length > 0 || notesLoudest) ? (
                    // E65: a note owed an answer shows on the tab, so it is
                    // seen from the conversation too — one dot for every owed
                    // note in the SESSION, stuck if any is. The count stays
                    // the open document's, as the list below is.
                    <span className="flex items-center gap-1">
                      {openNotes.length > 0 ? `Notes (${openNotes.length})` : "notes"}
                      {notesLoudest && (
                        <WaitingDot
                          badge={notesLoudest}
                          of="note"
                          label={owedLabel(state.notesWaiting)}
                        />
                      )}
                    </span>
                  ) : which === "tasks" && openTasks.length > 0 ? (
                    // ⛔ THE SPINNER IS IN THE TAB, not only inside the panel —
                    // the point of a queue is knowing work is outstanding while
                    // you are looking at something else.
                    <span className="flex items-center gap-1">
                      <Spinner className="text-ink-dim" />
                      {`Tasks (${openTasks.length})`}
                    </span>
                  ) : (
                    which
                  )}
                </button>
              ))}
            </div>
            <div className="shrink-0">
              <ColumnButton
                label="Collapse the conversation column"
                control="chat-collapse"
                onClick={() => toggleFrom("chat", "collapse")}
              >
                <PanelRightCloseIcon aria-hidden />
              </ColumnButton>
            </div>
          </div>
          {rightPane === "tasks" ? (
            <TasksPanel
              tasks={state.tasks}
              onDone={(id) => send({ type: "task.done", id })}
              onClear={() => send({ type: "tasks.clear" })}
            />
          ) : rightPane === "notes" ? (
            <NotesPanel
              notes={open?.notes ?? []}
              focusedId={focusedNote}
              waiting={noteBadges}
              others={notesOthers}
              onOpenDoc={(doc) => send({ type: "open.doc", doc })}
              onAsk={(n) => open && askAbout(n, open)}
              selection={
                open && shown && text !== undefined
                  ? { ...shown, text: text.slice(shown.from, shown.to) }
                  : null
              }
              onAdd={(from, to, body) => {
                if (open) send({ type: "note.add", doc: open.slug, from, to, body });
              }}
              onGoTo={(n) => {
                // ⛔ THE BORDER FOLLOWS THE CLICK (E47 fix). Showing a note's
                // passage without moving the border left the PREVIOUS note
                // bordered — so the panel pointed at one note while the editor
                // showed another. Whatever was last asked for is the one marked.
                setFocusedNote(n.id);
                if (n.from !== null)
                  setReveal({ from: n.from, to: n.to as number, seq: Date.now() });
              }}
              onEdit={(id, body) => {
                if (open) send({ type: "note.edit", doc: open.slug, id, body });
              }}
              onResolve={(id, resolved) => {
                if (open) send({ type: "note.resolve", doc: open.slug, id, resolved });
              }}
              onRemove={(id) => {
                if (open) send({ type: "note.remove", doc: open.slug, id });
              }}
            />
          ) : (
            <>
              {state.chat.length === 0 ? (
                <Empty className="flex-1">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessagesSquareIcon />
                    </EmptyMedia>
                    <EmptyTitle>No messages yet</EmptyTitle>
                    <EmptyDescription>
                      Ask the agent something. If you have text selected, it comes too.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ActivityLog chat={state.chat} waiting={state.waiting} />
              )}
              {/* ⛔ DRAWN IN ONE PLACE AT A TIME: here while the column is
                  open, floating under the document while it is collapsed. */}
              {!collapsed.chat && <ChatComposer {...composer} />}
            </>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

/**
 * The composer, floating under the document while the conversation column is
 * collapsed (E64) — with the one line of the conversation a human needs so as
 * not to have to open it: the agent's latest word, or that it is still working
 * on yours. Anything more is a click away, and the click reopens the column.
 */
function FloatingComposer({
  chat,
  waiting,
  notesWaiting,
  docs,
  openDoc,
  onAsk,
  onOpen,
  children,
}: {
  chat: readonly ChatMessage[];
  waiting: Waiting | null;
  /** E65: with the column shut, a note owed an answer has to show somewhere. */
  notesWaiting: readonly NoteWaiting[];
  docs: readonly DocView[];
  openDoc: string | null;
  onAsk: (
    note: { id: string; quote: string; body: string },
    doc: { slug: string; name: string },
  ) => void;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const last = chat.findLast((m) => m.who !== "system");
  // The note the line is ABOUT: the oldest one the human can still act on
  // (not yet asked about), else the oldest. Its own badge, and a count of the
  // rest kept OUT of the truncated text so it never clips (verifier D2).
  const first = notesWaiting.find((n) => !n.askedIn) ?? notesWaiting[0];
  const firstDoc = first ? docs.find((d) => d.slug === first.doc) : undefined;
  const firstNote = firstDoc?.notes.find((n) => n.id === first?.noteId);
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-1">
      {first && firstDoc && firstNote && (
        <div className="flex items-center gap-2 px-1 text-[11px] text-ink-dim">
          <span className="min-w-0 flex-1 truncate" title={firstNote.body}>
            <span className="mr-1.5 font-medium text-ink-faint">
              Your note{firstDoc.slug !== openDoc ? ` on ${firstDoc.name}` : ""}
            </span>
            {firstNote.body}
          </span>
          {notesWaiting.length > 1 && (
            <span className="shrink-0 text-ink-faint">+{notesWaiting.length - 1} more</span>
          )}
          <WaitingBadge badge={first.badge} of={waitingOf(first)} className="mt-0 shrink-0" />
          {first.badge === "stalled" && !first.askedIn && (
            <button
              type="button"
              onClick={() => onAsk(firstNote, firstDoc)}
              title="Send this note to the agent as a message in the conversation"
              className="shrink-0 rounded-sm px-1 text-ink-faint underline-offset-2 hover:text-ink hover:underline"
            >
              Ask the agent
            </button>
          )}
        </div>
      )}
      {last && (
        <div className="flex items-center gap-2 px-1 text-[11px] text-ink-dim">
          <span className="min-w-0 flex-1 truncate" title={last.text}>
            <span className="mr-1.5 font-medium text-ink-faint">
              {last.who === "agent" ? "Agent" : "You"}
            </span>
            {last.text}
          </span>
          {waiting?.messageId === last.id && <WaitingBadge badge={waiting.badge} />}
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 rounded-sm px-1 text-ink-faint underline-offset-2 hover:text-ink hover:underline"
          >
            Open the conversation
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * A READ-ONLY stand-in for the conversation (chat is a later piece, E16): the
 * session's lines, newest last, so what either party did — "Agent moved …",
 * "You created …" (E24) — is visible where the conversation will be.
 */
function ActivityLog({
  chat,
  waiting,
}: {
  chat: readonly ChatMessage[];
  /** E53: which message nobody has answered, and how that reads. */
  waiting: Waiting | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = chat.at(-1)?.id;
  // Scroll when a NEW line arrives, keyed by its id — and when the badge
  // appears or changes, because it is rendered below the last message and would
  // otherwise land just out of sight.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last, waiting?.badge]);
  return (
    <div
      role="log"
      aria-label="Activity"
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-3"
    >
      {chat.slice(-200).map((m) => (
        <div
          key={m.id}
          data-who={m.who}
          className="rounded-md px-2 py-1 text-xs leading-relaxed text-ink-dim data-[who=agent]:bg-surface-raised data-[who=agent]:text-ink data-[who=human]:bg-rubric/10 data-[who=human]:text-ink"
        >
          <span className="mr-1.5 font-medium text-ink-faint">
            {m.who === "system" ? "·" : m.who === "agent" ? "Agent" : "You"}
          </span>
          {m.text}
          {/* ⛔ THE RECORD SHOWS WHAT WAS SENT (E48). The passage travelled with
              the message, so the log has to show it — otherwise the human reads
              "can you answer this one?" a week later with no idea what "this"
              was, while the agent had it all along. */}
          {m.selection && (
            <p className="mt-1 border-l-2 border-edge pl-2 font-mono text-[11px] text-ink-dim">
              <span className="text-ink-faint">
                {m.selection.doc} · v{m.selection.version} ·{" "}
                {m.selection.fromLine === m.selection.toLine
                  ? `line ${m.selection.fromLine}`
                  : `lines ${m.selection.fromLine}–${m.selection.toLine}`}
              </span>
              <br />
              {m.selection.text.replace(/\s+/gu, " ").trim()}
            </p>
          )}
          {waiting?.messageId === m.id && <WaitingBadge badge={waiting.badge} />}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
