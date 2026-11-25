// THE WORKSPACE SHELL: three drag-resizable panes around a centre the app owns.
// The context sidebar on the left and the conversation column on the right are
// the kit's; the centre (an editor, a reader, a timeline) is the app's, passed in
// as a slot and given the workspace through `useWorkspace()`.
//
//   - `daemon`: the connection, from `useDaemon()`.
//   - `centre`, `toolbar`, `status`: slots. The toolbar sits above the centre, the
//     status below the panes beside the connection mark.
//   - `menuActions`: what an app adds to the context's right-click menu, for one
//     target at a time, below the kit's own Open, Rename, Move and Reveal.
//   - `panels`: tabs added to the right column beside the kit's own (Chat,
//     Notes and Tasks).
//   - `onShowDiff`: what the new-version toast's "Show diff" does. The kit has no
//     compare view, so the button appears only when the app says how to show one.
//   - `badges`: what shows at the trailing edge of a document's row.
//   - `folderBadges`: what shows at the trailing edge of a set's row and of each
//     folder inside it, given the open documents under that folder and the number
//     of documents there in all (so one never opened still counts).
//   - the panes' own slots, handed to them unchanged: the context sidebar's
//     `askLocation`, `beforeMove` (with `beforeMoveTimeoutMs` and
//     `uncheckedMoveNote`) and refusal `notice`; Notes' `addUnavailable` (as
//     `notesAddUnavailable`); and the outside-change toast's "See the
//     difference" (as `onShowOutsideDiff`). Given `notice`, the app shows the
//     daemon's refusals there, and the shell toasts them only while the
//     context column is collapsed and the notice is out of sight.
//   - `endWarning`: what End session warns of while it asks (unsaved documents).
//
// Over everything is the top bar: the app's title (its declaration's `title`), the
// session id, search over the session's documents, End session and the theme.
//
// Either side column collapses out of the way, persisted with the layout in
// localStorage so a reload keeps it. With the conversation collapsed, its
// composer floats at the foot of the centre (in a pane's dock, above its status
// strip, when the pane draws one), or is closed to a chat icon on the rail;
// the shell holds the one draft, so moving the composer loses nothing.
// It is a subpath of its own (`kit/shell`) because composing `context` and
// `chat` is its whole job, which `ui` must not do.

import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type Attachable, ChatComposer, type ChatComposerProps } from "../chat/ChatComposer.tsx";
import { pathLabel } from "../chat/ChatMessageView.tsx";
import { ChatSidebar } from "../chat/ChatSidebar.tsx";
import { FloatingComposer } from "../chat/FloatingComposer.tsx";
import { NewVersionToasts } from "../chat/NewVersionToasts.tsx";
import { NotesPanel, repliesByNote } from "../chat/NotesPanel.tsx";
import {
  askAboutNoteText,
  askedAbout,
  badgesOn,
  elsewhere,
  owedSummary,
} from "../chat/noteWaiting.ts";
import { OutsideChangeToasts } from "../chat/OutsideChangeToasts.tsx";
import { isFinishedStatus, Spinner, TasksPanel } from "../chat/TasksPanel.tsx";
import { TaskToasts } from "../chat/TaskToasts.tsx";
import { badgeFor, WaitingDot } from "../chat/WaitingBadge.tsx";
import type { AskLocation } from "../context/AskLocation.tsx";
import { ContextSidebar } from "../context/ContextSidebar.tsx";
import { CentreDockContext } from "../context/centreDock.tsx";
import { type Daemon, fileAlreadyAt } from "../context/daemonClient.ts";
import { HistoryArrows } from "../context/HistoryArrows.tsx";
import type { MenuActions } from "../context/menuActions.ts";
import {
  baseName,
  bundleLabelAt,
  docAt,
  folderDocs,
  joinPath,
  rowRefs,
  rowsShown,
  shortPath,
  tildify,
} from "../context/model.ts";
import type { BeforeMove, UncheckedMoveNote } from "../context/preMove.ts";
import { RelinkBar } from "../context/RelinkBar.tsx";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { bundleOf, isBundleMain } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { askDescribeText } from "../lib/sidecar.ts";
import { applyTheme, readAppliedTheme, type Theme } from "../theme/mode.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  QUIET_GROUP,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Toasts,
  useToastStore,
} from "../ui/index.ts";
import { quoteLabel } from "../workspace/anchors.ts";
import type {
  Backlinks as BacklinksData,
  DocView,
  Message,
  PublicState,
  TrashPreview,
} from "../workspace/protocol";
import { ChatColumn } from "./ChatColumn.tsx";
import { COLUMN_INPUT, ColumnButton, Rail } from "./ColumnChrome.tsx";
import {
  DEFAULT_SIZE,
  decodeFloatClosed,
  encodeFloatClosed,
  FLOAT_KEY,
  floatOnRail,
  floatShown,
  MIN_SIZE,
  RAIL_PX,
  readKept,
} from "./columns.ts";
import { ImageDescriptionPanel } from "./ImageDescription.tsx";
import { ImageLinkedFrom } from "./ImageLinkedFrom.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { messageParts } from "./messageRefs.ts";
import { waitingOnAgent } from "./rail.ts";
import { type EndPhase, SessionEndDialog } from "./SessionEnd.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { StatusBar } from "./StatusBar.tsx";
import { keptTheme, type ShellStorage, THEME_KEY } from "./storage.ts";
import { TopBar } from "./TopBar.tsx";
import { useDaemonNotices } from "./useDaemonNotices.ts";
import { useHeldSelection } from "./useHeldSelection.ts";
import { usePaneKeys } from "./usePaneKeys.ts";
import { useReveal } from "./useReveal.ts";
import { useShellColumns } from "./useShellColumns.ts";

/** A tab an app adds to the right column. */
export type ShellPanel = { id: string; label: string; node: ReactNode };

export type WorkspaceShellProps = {
  daemon: Daemon;
  /** The app's own pane, rendered in the middle. */
  centre: ReactNode;
  /** Above the centre. */
  toolbar?: ReactNode;
  /** The app's context-menu actions for one target; return none for no extras. */
  menuActions?: MenuActions;
  /** Below the panes, beside the connection mark. */
  status?: ReactNode;
  /** Tabs added to the right column, after the kit's own. */
  panels?: readonly ShellPanel[];
  /** The per-document badge in the context tree. Shown for documents the daemon has open. */
  badges?: (doc: DocView) => ReactNode;
  /**
   * A mark at the trailing edge of any tree row, open or not: a document, an
   * image or a bundle, by the row's own absolute path (a bundle's folder, not
   * its main file). After the open document's badge. Atlas marks the files on
   * the open board.
   */
  rowMarker?: (path: string) => ReactNode;
  /**
   * The per-folder badge on a set's row and on each folder in its tree: the open
   * documents under the folder, and how many documents the folder holds in all.
   */
  folderBadges?: (docs: readonly DocView[], total: number) => ReactNode;
  /** What "Show diff" on a new-version toast does. Absent: the toast offers Activate only. */
  onShowDiff?: (doc: DocView, version: number) => void;
  /** Prefix for what the shell keeps in localStorage. Default "spellbook". */
  storageKey?: string;
  /**
   * Where the shell keeps the layout, the reopen widths, the closed float, the
   * tab and the theme, by bare key (`storage.ts`). Default: localStorage under
   * `storageKey`, with the theme left to `theme/mode.ts`. Read once on mount, so
   * an asynchronous store is hydrated before the shell mounts: mounted before,
   * the default layout is written over the saved one (`useDefaultLayout`
   * persists every commit). The theme alone is followed while mounted. Passed
   * on to the panes as the workspace's `storage`.
   */
  storage?: ShellStorage;
  /** An app's own actions under a chat message, or nothing (`ChatSidebar`'s `messageActions`). */
  messageActions?: (message: Message) => ReactNode;

  // ── the panes' own slots, handed to them unchanged ──────────────────────
  /**
   * The context sidebar's `askLocation`: for an app with no workspace, ask the
   * human where a new document, a new folder or a drop on the list goes
   * (`useAskLocation` answers it). Absent, nothing asks. The app renders the
   * hook's `dialog` itself; it portals, so anywhere does, `centre` included.
   */
  askLocation?: AskLocation;
  /** The context sidebar's pre-move slot (`context/preMove.ts`). Absent, every move is sent at once. */
  beforeMove?: BeforeMove;
  /** How long a move waits for `beforeMove` before asking without it. Absent, the sidebar's default. */
  beforeMoveTimeoutMs?: number;
  /** What a move that `beforeMove` could not check names as unchecked, in its dialog. */
  uncheckedMoveNote?: UncheckedMoveNote;
  /**
   * The refusal shown at the head of the context sidebar (an app adds its
   * "To go on: …" hint here), or null when there is none. Given, even as null,
   * the app owns the daemon's refusals: the shell does not clear `lastError`,
   * and does not toast a refusal while the context column is open, so a
   * refusal is shown once; `onDismissNotice` (usually `daemon.clearError`)
   * lets it go. While the column is collapsed, the notice is out of sight, so
   * the shell toasts the refusal too, under its title. A session that has
   * ended is still the shell's to say. Absent, the shell toasts each refusal,
   * as it always has.
   *
   * The notice is a string alone: a refusal's title (`daemon.lastErrorTitle`,
   * "That link didn't open") is for the app to read off the daemon, if it
   * wants it in the notice.
   */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** Notes' `addUnavailable`: why no note can be added here, shown in place of the form. */
  notesAddUnavailable?: string;
  /**
   * "Ask the agent" on a note that may be stuck, in the Notes panel and the
   * floating composer's note line: a message in the conversation with
   * `via: "ask"` and `about.noteId`, sent once while the note is owed an
   * answer. `true` says it in the kit's words (`askAboutNoteText`); a function
   * says it in the app's. Absent, not offered.
   */
  askAboutNotes?: boolean | ((note: { quote: string; body: string }, docName: string) => string);
  /**
   * What the outside-change toast's "See the difference" does: compare the
   * document with its file on disk. Absent, the toast offers Reload and Keep only.
   */
  onShowOutsideDiff?: (doc: DocView) => void;
  /**
   * End session's warning, read while it asks: what ending would leave out of
   * the files on disk (an app's unsaved documents, say), or null for
   * nothing. Ending is still allowed. Absent, End session asks without one.
   */
  endWarning?: (state: PublicState) => string | null;
};

export { PANES } from "./useShellColumns.ts";

/** Why End session did not end it: the close never reached the daemon. */
const UNREACHABLE =
  "The workspace daemon is not answering, so the session cannot be ended from here. Try again once it is back.";

export { NOT_CONNECTED_REASON } from "./TopBar.tsx";

/**
 * The pinned control never clips: at the narrowest width the layout allows, the
 * title and the other actions give way, and the collapse button stays on screen.
 */
function PaneHeading({
  children,
  actions,
  pinned,
}: {
  children: string;
  actions?: ReactNode;
  pinned?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-edge px-2 text-xs font-medium tracking-wide text-ink-dim uppercase">
      <span className="min-w-0 truncate pl-1">{children}</span>
      {actions && (
        <div className="ml-auto flex min-w-0 items-center gap-0.5 overflow-hidden">{actions}</div>
      )}
      {pinned && <div className={cn("shrink-0", !actions && "ml-auto")}>{pinned}</div>}
    </div>
  );
}

export function WorkspaceShell(props: WorkspaceShellProps) {
  const state = props.daemon.state;
  if (!state) {
    return (
      <div
        data-slot="workspace-shell"
        className="flex h-full items-center justify-center bg-bg text-ink"
      >
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {props.daemon.connection === "closed"
                ? "Daemon unreachable"
                : props.daemon.connection === "ended"
                  ? "Session ended"
                  : "Connecting"}
            </EmptyTitle>
            <EmptyDescription>
              {props.daemon.connection === "closed"
                ? "The workspace daemon is not answering. This page keeps trying."
                : props.daemon.connection === "ended"
                  ? "The session was closed."
                  : "Waiting for the workspace daemon."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return <ShellBody {...props} state={state} />;
}

function ShellBody({
  daemon,
  state,
  centre,
  toolbar,
  menuActions,
  status,
  panels = [],
  badges,
  rowMarker,
  folderBadges,
  onShowDiff,
  storageKey = "spellbook",
  storage: storageProp,
  messageActions,
  askLocation,
  beforeMove,
  beforeMoveTimeoutMs,
  uncheckedMoveNote,
  notice,
  onDismissNotice,
  notesAddUnavailable,
  askAboutNotes,
  onShowOutsideDiff,
  endWarning,
}: WorkspaceShellProps & { state: PublicState }) {
  const { send } = daemon;
  const toasts = useToastStore();

  // ── theme ───────────────────────────────────────────────────────────────
  /** The command that brings this session back: the app's own launcher when it declared one. */
  const restoreCommand = `${state.launcher ? `${state.launcher} ` : ""}open --restore ${state.sessionId}`;
  /**
   * The human's End session. Confirmed here and ended by the daemon, with no
   * round trip through the agent: a session whose agent is gone must still
   * close. The agent's tail hears `closed` with `by: "human"`. The dialog that
   * asked stays open and becomes the ended state when the daemon says so.
   */
  const [endPhase, setEndPhase] = useState<EndPhase | null>(null);
  const ended = daemon.connection === "ended";
  // Opened on its own only when the session ends while this page watches: an end
  // the agent or the idle timeout made, which nobody here confirmed. A page that
  // mounts already ended (a remount, never a live close) gets the chip alone.
  const endedBefore = useRef(ended);
  useEffect(() => {
    if (ended && !endedBefore.current) setEndPhase("ended");
    endedBefore.current = ended;
  }, [ended]);
  /** Why the last confirm did not end the session; cleared when the dialog closes. */
  const [endNotice, setEndNotice] = useState<string | null>(null);
  // The connection dropped after the close went out and before the daemon said it
  // was closing: the close may never have arrived, so it is asked again.
  useEffect(() => {
    if (endPhase === "ending" && daemon.connection !== "open" && !ended) {
      setEndPhase("confirm");
      setEndNotice(UNREACHABLE);
    }
  }, [endPhase, daemon.connection, ended]);
  /** The chip, where focus goes back to when the ended dialog closes. */
  const chipRef = useRef<HTMLButtonElement>(null);
  /** The app's settings dialog, from the top bar. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => readAppliedTheme());
  const setTheme = useCallback(
    (next: Theme) => {
      // The browser copy too: the pre-paint script reads only that.
      applyTheme(next);
      setThemeState(next);
      storageProp?.setItem(THEME_KEY, next);
    },
    [storageProp],
  );
  // An app's own storage holds the theme across origins: followed when it
  // arrives or changes (another session's choice), and never written back.
  const themeKept = keptTheme(storageProp?.getItem(THEME_KEY));
  useEffect(() => {
    if (themeKept && themeKept !== readAppliedTheme()) {
      applyTheme(themeKept);
      setThemeState(themeKept);
    }
  }, [themeKept]);

  // ── the side columns ────────────────────────────────────────────────────
  const {
    storage,
    layout,
    collapsed,
    collapsedRef,
    contextPanel,
    chatPanel,
    collapse,
    expand,
    onGroupDoubleClick,
    handleEnter,
    focusNext,
    toggleFrom,
    onLayoutChanged,
    columns,
    setQuiet,
    quiet,
    fade,
    chatUnseen,
  } = useShellColumns({ storageProp, storageKey, state });

  // ── the composer, wherever it is drawn ──────────────────────────────────
  /**
   * What the human is typing to the agent. Held here, not in the composer: the
   * composer is drawn in the conversation column, or floating at the foot of
   * the centre while that column is collapsed, and a draft inside it would be
   * lost on every move (a remount), or doubled if it were drawn twice. One
   * draft, wherever it is shown. A tab swapped in for the chat and back keeps
   * it too.
   */
  const [draft, setDraft] = useState("");
  /** The human closed the float: kept beside the layout, so a reload keeps it. */
  const [floatClosed, setFloatClosedState] = useState(() =>
    decodeFloatClosed(readKept(storage.getItem, FLOAT_KEY)),
  );
  const setFloatClosed = useCallback(
    (closed: boolean) => {
      setFloatClosedState(closed);
      storage.setItem(FLOAT_KEY, encodeFloatClosed(closed));
    },
    [storage],
  );
  // A closed float lasts only until the column is next opened (the user,
  // 2026-10-14), by whatever route: the rail, the float's own button, a key, a
  // handle, leaving reader mode. Watched on the column itself, so no route can
  // miss it; the next collapse floats the composer again. A reload with the
  // column still collapsed keeps it closed, and nothing else opens it: a new
  // message from the agent shows on the rail's unseen mark instead.
  const chatWasCollapsed = useRef(collapsed.chat);
  useEffect(() => {
    if (chatWasCollapsed.current && !collapsed.chat && floatClosed) setFloatClosed(false);
    chatWasCollapsed.current = collapsed.chat;
  }, [collapsed.chat, floatClosed, setFloatClosed]);
  const floating = floatShown(collapsed, floatClosed);
  /** A pane's dock for the float, above its status strip: `null` when none is drawn. */
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const floatIcon = floatOnRail(collapsed, floatClosed);
  /** The top bar's session line, and the title's tooltip where the line is hidden. */
  const sessionLabel = `session ${state.sessionId}${daemon.connection === "ended" ? " (ended)" : ""}`;

  // ── pane focus and keys ─────────────────────────────────────────────────
  const { focusPane, showChatTab, focusComposer, rootRef } = usePaneKeys({
    collapsed,
    collapse,
    expand,
    toggleFrom,
    floating,
    floatClosed,
  });

  // ── the open document, and the selection held against it ────────────────
  const {
    openDoc,
    openImage,
    rawMain,
    setRawMain,
    selection,
    clearSeq,
    reveal,
    setPointedAt,
    focusedNote,
    showResolvedNotes,
    setShowResolvedNotes,
    pointedDocs,
    reportSelection,
    dropSelection,
    pointDocs,
    treeSelected,
    setTreeSelected,
    addedRefs,
    addRef,
    removeRef,
    clearRefs,
    requestReveal,
    revealApplied,
  } = useHeldSelection({ daemon, state, send });

  // ── opening a search result ──────────────────────────────────────────────
  const { setPendingShow, openAt, openResult } = useReveal({
    daemon,
    toasts,
    send,
    openDoc,
    requestReveal,
  });

  // ── where the open image is used ────────────────────────────────────────
  // The open image's backlinks (its embeds and the links to it), for the
  // viewer's footer. Asked when the image changes and again on a new snapshot,
  // a beat later, as the document's "Linked from" is.
  const [imageLinks, setImageLinks] = useState<BacklinksData | null>(null);
  const openImagePath = openImage?.path ?? null;
  const { request } = daemon;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot is the trigger to ask again.
  useEffect(() => {
    if (openImagePath === null) {
      setImageLinks(null);
      return;
    }
    let current = true;
    const t = setTimeout(() => {
      request({ op: "link.backlinks", doc: openImagePath })
        .then((frame) => {
          if (current) setImageLinks(frame as unknown as BacklinksData);
        })
        // A convenience: a refusal (the image went) leaves nothing to show.
        .catch(() => {
          if (current) setImageLinks(null);
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [openImagePath, request, state]);

  // ── what the daemon said ────────────────────────────────────────────────
  const { moved, created } = useDaemonNotices({
    daemon,
    toasts,
    send,
    notice,
    setPendingShow,
    collapsedRef,
    collapsed,
  });

  // Memoised: the centre re-renders from this context, and a fresh object on every
  // snapshot would re-render it for changes it does not read.
  const workspace = useMemo<Workspace>(
    () => ({
      daemon,
      state,
      openDoc,
      openImage,
      selection,
      reportSelection,
      dropSelection,
      clearSeq,
      reveal,
      requestReveal,
      revealApplied,
      focusedNote,
      showResolvedNotes,
      openAt,
      toasts,
      announce: toasts.announce,
      theme,
      setTheme,
      focusPane,
      columns,
      setQuiet,
      pointedDocs,
      pointDocs,
      focusComposer,
      rawMain,
      refs: addedRefs,
      addRef,
      removeRef,
      clearRefs,
      storage: storageProp,
    }),
    [
      daemon,
      state,
      openDoc,
      openImage,
      selection,
      reportSelection,
      dropSelection,
      clearSeq,
      reveal,
      requestReveal,
      revealApplied,
      focusedNote,
      showResolvedNotes,
      openAt,
      toasts,
      theme,
      setTheme,
      focusPane,
      columns,
      pointedDocs,
      pointDocs,
      focusComposer,
      rawMain,
      addedRefs,
      addRef,
      removeRef,
      clearRefs,
      storageProp,
      setQuiet,
    ],
  );

  // The row the sidebar marks as open: the open image's, else the open document's.
  const activeDoc = openImage
    ? { entryId: openImage.entryId, rel: openImage.rel }
    : openDoc?.entryId && openDoc.rel
      ? {
          entryId: openDoc.entryId,
          rel: openDoc.rel,
          ...(rawMain !== null && openDoc.original === rawMain ? { raw: true } : {}),
        }
      : null;
  const userHome = state.userHome || null;
  // "Ask the agent to describe": a chat message from the human about the image,
  // as "Ask the agent to fix" posts one. Nothing else moves: no focus is taken,
  // the chat is not opened, a selection stays where it is.
  // The image is named as the sidebar shows it (`bible/images/fox.png`); its
  // whole path rides along in `about`.
  const contextEntries = state.context;
  const askDescribe = useCallback(
    (path: string) => {
      const set = contextEntries.find(
        (e) => e.membership === "mirrored" && path.startsWith(`${e.root}/`),
      );
      const shown = set
        ? `${set.label}/${path.slice(set.root.length + 1)}`
        : tildify(path, userHome);
      send({
        op: "say",
        text: askDescribeText(shown, baseName(path)),
        withSelection: false,
        // The kit's button, not the composer (the user, 2026-10-14). A button
        // press carries no held refs, and leaves them held.
        via: "describe",
        // The image is the subject, whatever is open.
        about: { path },
      });
    },
    [send, userHome, contextEntries],
  );

  // A chosen row renamed, moved or deleted leaves the selection with the tree's
  // change, so a later file at its old path never comes back as a ref.
  useEffect(() => {
    setTreeSelected((rows) => {
      if (rows.length === 0) return rows;
      const kept = rowsShown(contextEntries, rows);
      return kept.length === rows.length ? rows : kept;
    });
  }, [contextEntries, setTreeSelected]);

  const contextBody = (
    <ContextSidebar
      entries={state.context}
      activeDoc={activeDoc}
      userHome={userHome}
      onOpenDoc={(entry, rel) => {
        const path = joinPath(entry.root, rel);
        // A bundle's main file, by its own row inside the bundle: raw. The
        // bundle's row names its folder, and opens the app's view of it.
        setRawMain(isBundleMain(path) ? path : null);
        send({ op: "open", path });
      }}
      onAddPath={(path) => send({ op: "context.add", path })}
      onStructure={(op) => send(op)}
      onRemoveEntry={(id) => send({ op: "context.remove", id })}
      onReveal={(path) => send({ op: "reveal", path })}
      onPick={(want) => send({ op: "pick", want })}
      listDir={daemon.listDir}
      badgeFor={(path) => {
        const doc = docAt(state.docs, path);
        const badge = doc && badges ? badges(doc) : null;
        // A bundle's row is asked by its main file; its mark is by its folder.
        const bundle = isBundleMain(path) ? bundleOf(path) : null;
        const mark = rowMarker ? rowMarker(bundle ? bundle.root : path) : null;
        if (!mark) return badge;
        if (!badge) return mark;
        return (
          <span className="flex items-center gap-1">
            {badge}
            {mark}
          </span>
        );
      }}
      folderBadgeFor={(folder) => {
        if (!folderBadges) return null;
        const { docs, total } = folderDocs(state.context, state.docs, folder);
        return folderBadges(docs, total);
      }}
      appActionsFor={(target) =>
        menuActions ? menuActions({ ...target, doc: docAt(state.docs, target.path) }) : []
      }
      created={created}
      moved={moved}
      trashPreview={async (path) => {
        const f = await daemon.request({ op: "trash.preview", path });
        if (f.op !== "trash.preview") throw new Error("the workspace did not say what would go");
        return f as unknown as TrashPreview;
      }}
      onTrash={(path) => send({ op: "trash", path })}
      importImage={daemon.importImage}
      fileAt={(dir, file) => fileAlreadyAt(daemon.request, dir, file)}
      thumbFor={(path) => daemon.imageUrl(path, { thumb: 256 })}
      onAskDescribe={askDescribe}
      selected={treeSelected}
      onSelect={setTreeSelected}
      onAddRef={(path, name) => addRef({ path, label: name })}
      askLocation={askLocation}
      beforeMove={beforeMove}
      beforeMoveTimeoutMs={beforeMoveTimeoutMs}
      uncheckedMoveNote={uncheckedMoveNote}
      notice={notice}
      onDismissNotice={onDismissNotice}
    />
  );

  // ── the right column: the kit's tabs, then the app's ─────────────────────
  const notes = openDoc?.notes ?? [];
  const openNotes = notes.filter((n) => !n.resolved);
  const tasks = state.tasks;
  const outstanding = tasks.filter((t) => !isFinishedStatus(t.status));
  const docName = useCallback(
    (slug: string) => state.docs.find((d) => d.slug === slug)?.name ?? slug,
    [state.docs],
  );
  // A chip's path at or inside a bundle names the bundle by its title.
  const pathName = useCallback(
    (path: string) => bundleLabelAt(state.context, path) ?? pathLabel(path),
    [state.context],
  );
  const heldHere =
    selection && openDoc && selection.doc === openDoc.slug && selection.version === openDoc.active
      ? selection
      : null;

  // Absent from an older snapshot: no news, so not "no agent".
  const agentListening = state.agentListening !== false;
  // Notes owed an answer. One scope, the session: the Notes tab's dot, the
  // floating composer and the panel's pointer read every owed note, so one on
  // another document shows without collapsing a column. Only the panel's list
  // is the open document's, and it points at the rest.
  const owedNotes = state.notesWaiting ?? [];
  // "Ask the agent": the notes asked about and not answered, read off the
  // conversation by the daemon's own one-ask rule, plus those pressed here
  // whose message the snapshot has not brought yet (the conversation is as
  // long as it was at the press), so a second press before it arrives sends
  // nothing. An asked note waits on its message, so it shows the message's
  // badge, as the conversation does.
  const [askPressed, setAskPressed] = useState<ReadonlyMap<string, number>>(() => new Map());
  const notesAsked = askedAbout(owedNotes, state.docs, state.chat);
  if (daemon.connection === "open")
    for (const [id, at] of askPressed) if (at === state.chat.length) notesAsked.add(id);
  const notesWaiting =
    notesAsked.size === 0
      ? owedNotes
      : owedNotes.map((n) =>
          notesAsked.has(n.noteId) && state.waiting
            ? {
                ...n,
                badge: state.waiting.badge,
                ...(state.waiting.acknowledged ? { acknowledged: true as const } : {}),
              }
            : n,
        );
  const askNote = askAboutNotes
    ? (doc: string, noteId: string) => {
        if (notesAsked.has(noteId)) return;
        const note = state.docs.find((d) => d.slug === doc)?.notes.find((n) => n.id === noteId);
        if (!note) return;
        const name = docName(doc);
        const text =
          typeof askAboutNotes === "function"
            ? askAboutNotes(note, name)
            : askAboutNoteText(note, name);
        // The kit's button, not the composer: no held refs ride along, and
        // nothing else moves. The note's badge says it was asked.
        const sent = send({ op: "say", text, withSelection: false, via: "ask", about: { noteId } });
        if (sent !== null) setAskPressed((p) => new Map(p).set(noteId, state.chat.length));
      }
    : undefined;
  // The agent's answers to notes are its messages about them: read off the
  // conversation, shown under each note.
  const noteReplies = useMemo(() => repliesByNote(state.chat), [state.chat]);
  // A message about a note names the note on its chip: its document and a short
  // quote, so replies to three notes read apart.
  const noteName = (noteId: string): string | undefined => {
    for (const d of state.docs) {
      const n = d.notes.find((x) => x.id === noteId);
      if (n) return `note on ${docName(d.slug)}: "${quoteLabel(n.quote, 40)}"`;
    }
    return undefined;
  };
  // A link in the conversation, or in a reply under a note: resolved by the
  // daemon, as the document pane's links are. It was not written beside the
  // open document, so `from: "chat"` lets its `./` and `../` fall back to the
  // context's root.
  const followChatLink = (target: string) =>
    send({
      op: "link.open",
      target,
      from: "chat",
      ...(openDoc ? { doc: openDoc.slug } : {}),
    });
  const noteBadges = badgesOn(notesWaiting, openDoc?.slug ?? null);
  const notesElsewhere = elsewhere(notesWaiting, openDoc?.slug ?? null).map((o) => ({
    ...o,
    name: docName(o.doc),
  }));
  const notesOwed = owedSummary(notesWaiting, agentListening, ended);
  /** Everything waiting on the agent, as one mark: the closed composer's rail button. */
  const composerWaiting = waitingOnAgent(state.waiting, notesWaiting, agentListening, ended);
  const attachable: Attachable | null = heldHere
    ? {
        doc: heldHere.doc,
        name: docName(heldHere.doc),
        version: heldHere.version,
        fromLine: heldHere.fromLine,
        toLine: heldHere.toLine,
        text: heldHere.text,
      }
    : null;
  const pointedNames = pointedDocs ? pointedDocs.docs.map((d) => d.name) : null;
  const pointedLabel = pointedDocs?.label ?? null;
  const dropPointed = () => pointDocs(null);
  const activePath = openDoc?.versions.find((v) => v.n === openDoc.active)?.path;
  // The tree's selected rows as refs, read again only when the tree or the selection changes.
  const treeRefs = useMemo(
    () => rowRefs(state.context, treeSelected),
    [state.context, treeSelected],
  );
  // The subject and the refs, as the next message would carry them: the chip's
  // second row shows the refs, and `say` sends the same.
  const parts = messageParts({
    selection: attachable !== null && !pointedDocs,
    // A view whose own part carries its selection (a board's cards) names no subject or refs.
    pointed: pointedDocs?.inAppPart ? [] : (pointedDocs?.docs ?? []),
    openDoc: openDoc
      ? { original: openDoc.original, ...(activePath ? { path: activePath } : {}) }
      : null,
    openImage: openImage?.path ?? null,
    tree: treeRefs,
    added: addedRefs,
    nameOf: pathName,
  });
  /** A ref's X: it stops riding along, wherever it came from (the tree's row is deselected there). */
  const dropRef = (path: string) => {
    const rows = new Set(treeRefs.filter((r) => r.path === path).map((r) => r.row));
    if (rows.size > 0) setTreeSelected((s) => s.filter((p) => !rows.has(p)));
    removeRef(path);
    if (pointedDocs?.docs.some((d) => d.path === path))
      pointDocs({ ...pointedDocs, docs: pointedDocs.docs.filter((d) => d.path !== path) });
  };
  /**
   * Saying it, from the column or the float: one message either way. Only a
   * typed message carries the held refs (the user, 2026-10-14): the app's and
   * the kit's buttons send their own `say` with none, and leave them held.
   */
  const say = (text: string, withSelection: boolean) => {
    const about = {
      ...(parts.subject && !(withSelection && !pointedDocs) ? { path: parts.subject } : {}),
      ...(parts.refs.length > 0 ? { refs: parts.refs.map((r) => r.ref) } : {}),
    };
    const sent = send({
      op: "say",
      text,
      withSelection: withSelection && !pointedDocs,
      via: "chat",
      ...(Object.keys(about).length > 0 ? { about } : {}),
    });
    // References added by hand went with this message; the tree's selection
    // stays. A message that did not go (no connection, the session ended)
    // took nothing, so they stay held.
    if (sent !== null) clearRefs();
  };
  /** The one composer's props, whichever place it is drawn in. */
  const composerProps: ChatComposerProps = {
    attachable,
    connected: daemon.connection === "open",
    heard: agentListening,
    ended: daemon.connection === "ended",
    draft,
    onDraft: setDraft,
    onDrop: dropSelection,
    pointed: pointedNames,
    pointedLabel,
    onDropPointed: dropPointed,
    refs: parts.refs.map((r) => ({
      path: r.path,
      name: r.name,
      role: r.role ?? "reference",
      from: r.from,
    })),
    refsUnsent: parts.unsent,
    onDropRef: dropRef,
    onSend: say,
  };
  const chatPanel_ = (
    <ChatSidebar
      messages={state.chat}
      waiting={state.waiting}
      agentListening={agentListening}
      sessionEnded={ended}
      // Drawn in one place at a time: here while the column is open, floating
      // at the foot of the centre while it is collapsed.
      composer={collapsed.chat ? null : <ChatComposer {...composerProps} />}
      docName={docName}
      pathName={pathName}
      noteName={noteName}
      onFollowLink={followChatLink}
      {...(messageActions ? { messageActions } : {})}
    />
  );
  const notesPanel_ = (
    <NotesPanel
      notes={notes}
      waiting={noteBadges}
      others={notesElsewhere}
      agentListening={agentListening}
      sessionEnded={ended}
      asked={notesAsked}
      replies={noteReplies}
      onFollowLink={followChatLink}
      {...(askNote ? { onAsk: (n) => openDoc && askNote(openDoc.slug, n.id) } : {})}
      onOpenDoc={(doc) => send({ op: "open.doc", doc })}
      focusedId={focusedNote}
      onLetGo={() => setPointedAt(null)}
      showResolved={showResolvedNotes}
      onShowResolved={setShowResolvedNotes}
      selection={
        heldHere
          ? {
              from: heldHere.from,
              to: heldHere.to,
              text: heldHere.text,
              ...(heldHere.noteRefusal ? { refusal: heldHere.noteRefusal } : {}),
            }
          : null
      }
      onAdd={(from, to, body) => {
        if (!openDoc) return;
        // What was selected, for the daemon to hold the range to.
        const seen =
          heldHere && heldHere.from === from && heldHere.to === to ? heldHere.seen : undefined;
        send({
          op: "note.add",
          doc: openDoc.slug,
          from,
          to,
          body,
          ...(seen !== undefined ? { seen } : {}),
        });
        // A note consumes the passage it was written about.
        dropSelection();
      }}
      onGoTo={(n) => {
        if (!openDoc) return;
        // A second click on the chosen note lets it go, and shows nothing new.
        if (n.id === focusedNote) {
          setPointedAt(null);
          return;
        }
        setPointedAt({
          id: n.id,
          doc: openDoc.slug,
          version: openDoc.active,
          resolved: n.resolved,
        });
        if (n.from !== null && n.to !== null)
          requestReveal({ doc: openDoc.slug, version: openDoc.active, from: n.from, to: n.to });
      }}
      onEdit={(id, body) => openDoc && send({ op: "note.edit", doc: openDoc.slug, id, body })}
      onResolve={(id, resolved) =>
        openDoc && send({ op: "note.resolve", doc: openDoc.slug, id, resolved })
      }
      onRemove={(id) => openDoc && send({ op: "note.remove", doc: openDoc.slug, id })}
      addUnavailable={notesAddUnavailable}
    />
  );
  const tasksPanel_ = (
    <TasksPanel
      tasks={tasks}
      onCancel={(id) => send({ op: "task.cancel", id })}
      onRemove={(id) => send({ op: "task.remove", id })}
      onClear={() => send({ op: "tasks.clear" })}
      onCreate={(title) => send({ op: "task.create", title })}
    />
  );
  const tabs: { id: string; label: ReactNode; node: ReactNode }[] = [
    {
      id: "chat",
      label: (
        <span className="flex items-center gap-1">
          Chat
          {state.waiting && <WaitingDot badge={badgeFor(state.waiting, agentListening, ended)} />}
        </span>
      ),
      node: chatPanel_,
    },
    {
      id: "notes",
      // One dot for every owed note in the session, stuck if any is; the count
      // stays the open document's, as the list is.
      label: notesOwed ? (
        <span className="flex items-center gap-1">
          {openNotes.length > 0 ? `Notes (${openNotes.length})` : "Notes"}
          <WaitingDot of="note" badge={notesOwed.badge} label={notesOwed.label} />
        </span>
      ) : openNotes.length > 0 ? (
        `Notes (${openNotes.length})`
      ) : (
        "Notes"
      ),
      node: notesPanel_,
    },
    {
      id: "tasks",
      // The spinner is in the tab, not only inside the panel: the point of a
      // queue is knowing work is outstanding while you look at something else.
      label:
        outstanding.length > 0 ? (
          <span className="flex items-center gap-1">
            <Spinner className="text-ink-dim" />
            {`Tasks (${outstanding.length})`}
          </span>
        ) : (
          "Tasks"
        ),
      node: tasksPanel_,
    },
    ...panels,
  ];
  const TAB_KEY = "tab";
  const [panelId, setPanelIdState] = useState<string | null>(() => storage.getItem(TAB_KEY));
  const setPanelId = (id: string) => {
    setPanelIdState(id);
    storage.setItem(TAB_KEY, id);
  };
  const activePanel = (tabs.find((p) => p.id === panelId) ?? tabs[0]) as (typeof tabs)[number];
  showChatTab.current = () => setPanelId("chat");

  const floatRow = floating && (
    <div className="shrink-0 px-3 pt-1 pb-2">
      <FloatingComposer
        messages={state.chat}
        waiting={state.waiting}
        notesWaiting={notesWaiting}
        docs={state.docs}
        openDoc={openDoc?.slug ?? null}
        agentListening={agentListening}
        sessionEnded={ended}
        asked={notesAsked}
        {...(askNote ? { onAskNote: (w) => askNote(w.doc, w.noteId) } : {})}
        onOpen={() => {
          setPanelId("chat");
          toggleFrom("chat", "expand", COLUMN_INPUT);
        }}
        onClose={() => {
          setFloatClosed(true);
          focusNext.current = '[data-column-control="chat-float-show"]';
        }}
      >
        <ChatComposer floating {...composerProps} />
      </FloatingComposer>
    </div>
  );
  // A pane's dock takes the float, and the toasts' anchor just above it, so
  // the stack grows up over the document and never over the float.
  const docked = floating && dock !== null;
  const floatAtFoot = floating && dock === null;

  return (
    <WorkspaceContext.Provider value={workspace}>
      {docked &&
        createPortal(
          <>
            <div data-slot="dock-toasts" className="relative h-0 shrink-0">
              <Toasts store={toasts} />
            </div>
            {floatRow}
          </>,
          dock,
        )}
      <TaskToasts
        tasks={tasks}
        announce={toasts.announce}
        startsInView={!collapsed.chat && (activePanel.id === "chat" || activePanel.id === "tasks")}
        // The unseen mark's way in: the tab first, then the column off its rail.
        onShowTasks={() => {
          setPanelId("tasks");
          toggleFrom("chat", "expand");
        }}
      />
      <OutsideChangeToasts
        doc={openDoc}
        announce={toasts.announce}
        dismiss={toasts.dismiss}
        onReload={(doc) => send({ op: "revert", doc })}
        onShowDiff={
          onShowOutsideDiff
            ? (doc) => {
                const d = state.docs.find((x) => x.slug === doc);
                if (d) onShowOutsideDiff(d);
              }
            : undefined
        }
      />
      <NewVersionToasts
        doc={openDoc}
        connected={daemon.connection === "open"}
        announce={toasts.announce}
        dismiss={toasts.dismiss}
        onActivate={(doc, version) => send({ op: "activate", doc, version })}
        onShowDiff={
          onShowDiff
            ? (doc, version) => {
                const d = state.docs.find((x) => x.slug === doc);
                if (d) onShowDiff(d, version);
              }
            : undefined
        }
      />
      <div
        ref={rootRef}
        data-slot="workspace-shell"
        data-theme={theme}
        className="flex h-full min-h-0 flex-col bg-bg text-ink"
      >
        <TopBar
          daemon={daemon}
          state={state}
          quiet={quiet}
          fade={fade}
          sessionLabel={sessionLabel}
          openResult={openResult}
          ended={ended}
          restoreCommand={restoreCommand}
          chipRef={chipRef}
          setEndPhase={setEndPhase}
          setSettingsOpen={setSettingsOpen}
          theme={theme}
          setTheme={setTheme}
        />
        {daemon.connection === "closed" && (
          <div
            role="status"
            className="shrink-0 border-b border-attention/40 bg-attention/10 px-3 py-1 text-xs text-ink"
          >
            The workspace daemon is not answering. This page keeps trying, and what you see is how
            things were when it went quiet.
          </div>
        )}
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={onLayoutChanged}
          onDoubleClickCapture={onGroupDoubleClick}
        >
          <ResizablePanel
            id="context"
            panelRef={contextPanel}
            collapsible
            defaultSize={`${DEFAULT_SIZE.context}`}
            minSize={`${MIN_SIZE.context}`}
            collapsedSize={`${RAIL_PX}px`}
            className="flex flex-col bg-surface"
            // Undo here means the context's, and only while focus is in here.
            // Scoped by letting the event bubble to this panel rather than
            // listening on the window: the editor's own undo must stay the
            // editor's, and a global listener would have to guess which was meant.
            // A deleting undo is not offered to the keyboard: a reflex that removes
            // a file is the one thing this must not turn into.
            onKeyDown={(e) => {
              if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
              if ((e.target as HTMLElement).matches("input, textarea")) return;
              e.preventDefault();
              if (e.shiftKey) {
                if (state.history.canRedo) send({ op: "history.redo" });
                return;
              }
              if (state.history.canUndo && !state.history.undoDeletes) send({ op: "history.undo" });
            }}
          >
            {collapsed.context && (
              <Rail quiet={quiet}>
                <ColumnButton
                  label="Reopen the context column"
                  control="context-reopen"
                  onClick={() => toggleFrom("context", "expand")}
                  className={fade}
                >
                  <PanelLeftOpenIcon aria-hidden />
                </ColumnButton>
              </Rail>
            )}
            {/* Kept mounted while collapsed, hidden and inert: the tree's open
                folders and any rename in progress are the sidebar's own state, and
                unmounting it would forget them every time it was put away. */}
            <div
              data-pane="context"
              tabIndex={-1}
              inert={collapsed.context}
              hidden={collapsed.context}
              className={cn(
                "min-h-0 flex-1 flex-col outline-none",
                collapsed.context ? "hidden" : "flex",
              )}
            >
              <PaneHeading
                actions={
                  <HistoryArrows
                    history={state.history}
                    display={(p) => shortPath(p, userHome, 2)}
                    onUndo={(confirmDelete) => send({ op: "history.undo", confirmDelete })}
                    onRedo={() => send({ op: "history.redo" })}
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
              {state.relink && (
                <RelinkBar
                  offer={state.relink}
                  onUpdate={() => send({ op: "relink" })}
                  onLeave={() => send({ op: "relink.leave" })}
                  focusAfter={() =>
                    document
                      .querySelector<HTMLElement>(
                        '[data-pane="context"] [data-action="history-undo"]',
                      )
                      ?.focus()
                  }
                />
              )}
              {contextBody}
            </div>
          </ResizablePanel>
          <ResizableHandle
            withHandle
            disableDoubleClick
            data-handle-for="context"
            onKeyDownCapture={handleEnter("context")}
          />
          <ResizablePanel id="centre" minSize="25" className="flex flex-col">
            {/* The centre's own row holds the app's toolbar, and is not drawn
                without one: a shut column's way back is on its rail. Quieter with
                the centre in reader mode: it fades back until the pointer or the
                keyboard focus reaches the row. */}
            {toolbar && !openImage && (
              <div
                data-slot="shell-toolbar-row"
                className={cn(
                  // As tall as the rails and the pane headings (36 px with its border), so
                  // their bottom borders run as one line; it grows only when it wraps.
                  "flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-0.5",
                  quiet ? `${QUIET_GROUP} border-transparent` : "border-edge",
                )}
              >
                {/* The app's toolbar keeps its content width. */}
                <div
                  data-slot="shell-toolbar"
                  className={cn("flex shrink-0 items-center gap-1", fade)}
                >
                  {toolbar}
                </div>
              </div>
            )}
            <main
              data-pane="centre"
              tabIndex={-1}
              className="relative flex min-h-0 flex-1 flex-col outline-none"
            >
              {/* The centre's body, and the box the toasts are placed by: the
                  float is below it in the flow, so the toasts sit above the
                  float and the float covers nothing of the centre (its toolbar,
                  find bar, version controls or the end of its scroll). With the
                  float in a pane's dock, the toasts go to the dock's anchor. */}
              <div data-slot="centre-body" className="relative flex min-h-0 flex-1 flex-col">
                {openImage ? (
                  <ImageViewer
                    key={openImage.path}
                    name={openImage.name}
                    src={daemon.imageUrl(openImage.path, { stamp: openImage.stamp })}
                    size={openImage.size}
                    type={openImage.type}
                    onClose={() => send({ op: "image.close" })}
                    aside={
                      <ImageDescriptionPanel
                        name={openImage.name}
                        description={openImage.description}
                        onEdit={(path) => send({ op: "open", path })}
                        onAsk={() => askDescribe(openImage.path)}
                      />
                    }
                    footer={
                      <ImageLinkedFrom
                        data={imageLinks?.path === openImage.path ? imageLinks : null}
                        onOpen={(b) => openAt(b.source, { from: b.from, to: b.to })}
                      />
                    }
                  />
                ) : (
                  <CentreDockContext.Provider value={setDock}>{centre}</CentreDockContext.Provider>
                )}
                {!docked && <Toasts store={toasts} />}
              </div>
              {/* With no dock on screen (a board, a stage's dashboard, the map),
                  the float sits at the foot of the centre. */}
              {floatAtFoot && floatRow}
            </main>
          </ResizablePanel>
          <ResizableHandle
            withHandle
            disableDoubleClick
            data-handle-for="chat"
            onKeyDownCapture={handleEnter("chat")}
          />
          <ChatColumn
            chatPanel={chatPanel}
            collapsed={collapsed}
            quiet={quiet}
            fade={fade}
            floatIcon={floatIcon}
            chatUnseen={chatUnseen}
            composerWaiting={composerWaiting}
            setFloatClosed={setFloatClosed}
            focusNext={focusNext}
            setPanelId={setPanelId}
            toggleFrom={toggleFrom}
            tabs={tabs}
            activePanel={activePanel}
            storageKey={storageKey}
          />
        </ResizablePanelGroup>
        <StatusBar
          daemon={daemon}
          state={state}
          quiet={quiet}
          fade={fade}
          agentListening={agentListening}
          status={status}
          openAt={openAt}
        />
      </div>
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        prefs={state.prefs}
        send={send}
        connected={daemon.connection === "open"}
      />
      <SessionEndDialog
        phase={endPhase}
        onOpenChange={(open) => {
          if (open) return;
          setEndPhase(null);
          setEndNotice(null);
        }}
        onConfirm={() => {
          // A close the socket could not carry is not an end: ask again, and say why.
          if (daemon.connection !== "open" || daemon.send({ op: "close" }) === null) {
            setEndPhase("confirm");
            setEndNotice(UNREACHABLE);
            return;
          }
          setEndNotice(null);
          setEndPhase("ending");
        }}
        connected={daemon.connection === "open"}
        notice={endNotice}
        warning={endPhase === "confirm" || endPhase === "ending" ? endWarning?.(state) : null}
        // The dialog has no trigger: on close, focus goes to the Ended chip, or back
        // to End session when the session goes on.
        finalFocus={() =>
          chipRef.current ??
          document.querySelector<HTMLElement>('[data-column-control="end-session"]') ??
          true
        }
        sessionId={state.sessionId}
        command={restoreCommand}
        by={daemon.endedBy}
      />
    </WorkspaceContext.Provider>
  );
}
