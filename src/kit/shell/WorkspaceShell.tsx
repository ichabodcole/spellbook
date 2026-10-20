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

import {
  MessageSquareIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PowerIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type Layout, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { type Attachable, ChatComposer, type ChatComposerProps } from "../chat/ChatComposer.tsx";
import { pathLabel } from "../chat/ChatMessageView.tsx";
import { ChatSidebar } from "../chat/ChatSidebar.tsx";
import { FloatingComposer } from "../chat/FloatingComposer.tsx";
import { NewVersionToasts } from "../chat/NewVersionToasts.tsx";
import { NotesPanel } from "../chat/NotesPanel.tsx";
import { badgesOn, elsewhere, owedSummary } from "../chat/noteWaiting.ts";
import { OutsideChangeToasts } from "../chat/OutsideChangeToasts.tsx";
import { isFinishedStatus, Spinner, TasksPanel } from "../chat/TasksPanel.tsx";
import { TaskToasts } from "../chat/TaskToasts.tsx";
import { badgeFor, WaitingDot } from "../chat/WaitingBadge.tsx";
import type { AskLocation } from "../context/AskLocation.tsx";
import { ContextSidebar } from "../context/ContextSidebar.tsx";
import { CentreDockContext } from "../context/centreDock.tsx";
import { type Daemon, SESSION_ENDED } from "../context/daemonClient.ts";
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
import {
  applySelectionEvent,
  type HeldSelection,
  type Reveal,
  revealAfter,
  type SelectionEvent,
} from "../context/selection.ts";
import {
  type Columns,
  type PaneName,
  type PointedDocs,
  type Workspace,
  WorkspaceContext,
} from "../context/workspace.ts";
import { bundleOf, isBundleMain } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { askDescribeText } from "../lib/sidecar.ts";
import { applyTheme, readAppliedTheme, type Theme } from "../theme/mode.ts";
import {
  Dot,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  QUIET_FADE,
  QUIET_GROUP,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Toasts,
  useToastStore,
} from "../ui/index.ts";
import type {
  Backlinks as BacklinksData,
  DocView,
  Message,
  MessageRef,
  PublicState,
  SearchResult,
  ServerOp,
  TrashPreview,
} from "../workspace/protocol";
import {
  type Collapsed,
  collapsedFrom,
  collapsedSides,
  DEFAULT_SIZE,
  decodeFloatClosed,
  decodeOpenSizes,
  encodeFloatClosed,
  encodeOpenSizes,
  FLOAT_KEY,
  floatOnRail,
  floatShown,
  MIN_SIZE,
  OPEN_KEY,
  RAIL_PX,
  readKept,
  rememberOpen,
  reopenSize,
  type Side,
} from "./columns.ts";
import { ImageDescriptionPanel } from "./ImageDescription.tsx";
import { ImageLinkedFrom } from "./ImageLinkedFrom.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { LinkCheck } from "./LinkCheck.tsx";
import { messageParts } from "./messageRefs.ts";
import { lastMessageId, unseenFromAgent } from "./rail.ts";
import { SearchBox } from "./SearchBox.tsx";
import { EndedChip, type EndPhase, SessionEndDialog } from "./SessionEnd.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { keptTheme, localShellStorage, type ShellStorage, THEME_KEY } from "./storage.ts";

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
   * What the outside-change toast's "See the difference" does: compare the
   * document with its file on disk. Absent, the toast offers Reload and Keep only.
   */
  onShowOutsideDiff?: (doc: DocView) => void;
};

/** The pane ids are the persisted layout's keys: renaming one forgets a viewer's sizes. */
export const PANES = ["context", "centre", "chat"] as const;

/** How far either side of a handle's drawn line a double-click still reaches it: the library's own reach for a drag. */
const HANDLE_REACH = 6;

/** Why End session did not end it: the close never reached the daemon. */
const UNREACHABLE =
  "The workspace daemon is not answering, so the session cannot be ended from here. Try again once it is back.";

const CONNECTION_LABEL = {
  connecting: "connecting…",
  open: "connected",
  closed: "daemon unreachable, retrying",
  ended: "session ended",
} as const;

/** The connection mark's tooltip: what the dot is about, which is this page only. */
const CONNECTION_TITLE = {
  connecting: "This page is connecting to the session",
  open: "This page is connected to the session. Whether an agent is listening shows beside it.",
  closed: "This page cannot reach the session's daemon, and keeps trying",
  ended: "The session has ended",
} as const;

/** The agent's mark: derived by the daemon from the agent's attached tails. */
const PRESENCE = {
  listening: {
    label: "agent listening",
    title: "An agent is following this session's events, so what you send is heard",
  },
  absent: {
    label: "no agent listening",
    title: "No agent is following this session's events, so what you send waits until one does",
  },
} as const;

/** The floating composer's input, and the column's: where focus is handed. */
const FLOAT_INPUT = '[data-slot="floating-composer"] [data-slot="composer-input"]';
const COLUMN_INPUT = '[data-pane="chat"] [data-slot="composer-input"]';

/** A small icon button for a column's own chrome: collapse, reopen. */
function ColumnButton({
  label,
  onClick,
  control,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Names the control so focus can be handed to it when its twin goes away. */
  control?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-column-control={control}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-faint outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 [&_svg]:size-3.5",
        className,
      )}
    >
      {children}
    </button>
  );
}

/**
 * A collapsed column's rail: the reopen button alone, on a row as tall as the pane
 * headings beside it, so the icons line up across the window. The column's body
 * stays mounted (hidden and inert) beside it.
 */
function Rail({
  quiet,
  below,
  children,
}: {
  quiet: boolean;
  /** Under the button, centred on the rail: a mark asking for attention. */
  below?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-slot="column-rail" className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex h-9 shrink-0 items-center justify-center border-b",
          quiet ? `${QUIET_GROUP} border-transparent` : "border-edge",
        )}
      >
        {children}
      </div>
      {below && <div className="flex shrink-0 justify-center">{below}</div>}
    </div>
  );
}

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
  onShowOutsideDiff,
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
  // Collapsed is the library's (`columns.ts`): a collapsed column is a panel at its
  // collapsed size, a 40 px rail, persisted by the same layout as every other size.
  // The panels are asked on every layout change, so the button, a drag shut and a
  // reload all agree by construction.
  const storage = useMemo(
    () => storageProp ?? localShellStorage(storageKey),
    [storageProp, storageKey],
  );
  const layout = useDefaultLayout({ id: "panes", panelIds: [...PANES], storage });
  // Set from the library's own callback and never written back. Before the panels
  // exist (the first render) it is the saved layout's guess.
  const [collapsed, setCollapsed] = useState<Collapsed>(() => collapsedSides(layout.defaultLayout));
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  /** The columns the shell itself is reopening: the only non-human way a rail opens. */
  const reopening = useRef(new Set<Side>());
  const openSizesRef = useRef(decodeOpenSizes(readKept(storage.getItem, OPEN_KEY) ?? undefined));
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
  // Not the library's `expand()`: it reopens to a width it keeps in memory, so
  // after a reload a column came back at its minimum. The width it reopens to is
  // the one remembered beside the layout, capped so it never pushes the other
  // column shut.
  const expand = useCallback(
    (side: Side) => {
      const panel = panelFor(side);
      if (!panel?.isCollapsed()) return false;
      const other = panelFor(side === "context" ? "chat" : "context");
      const around = other
        ? { [side === "context" ? "chat" : "context"]: other.getSize().asPercentage }
        : undefined;
      reopening.current.add(side);
      panel.resize(`${reopenSize(openSizesRef.current, side, around)}%`);
      return true;
    },
    [panelFor],
  );
  /**
   * A double-click on a handle: a rail reopens through the shell's own reopen (the
   * remembered width, and the mark that lets it past the rail guard below); an
   * open column goes back to its default width, as the library's own did. The
   * library's double-click is off, because its reopen carried no such mark.
   */
  const handleDoubleClick = (side: Side) => {
    if (collapsed[side]) expand(side);
    else panelFor(side)?.resize(`${DEFAULT_SIZE[side]}%`);
  };
  /**
   * Caught on the whole group, in the capture phase, because the library's handle
   * takes a drag a few pixels either side of the drawn line and a double-click
   * must reach as far. Which handle is meant: the one pressed, else the one the
   * library marks as under the pointer.
   */
  const onGroupDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as Element | null;
    const handles = [
      ...e.currentTarget.querySelectorAll<HTMLElement>('[data-slot="resizable-handle"]'),
    ];
    // The first press of a double-click focuses the handle, so by the second its
    // state says "focus", not "hover": where the pointer is decides, within the
    // library's few pixels either side of the line.
    const near = handles.find((h) => {
      const r = h.getBoundingClientRect();
      return (
        r.width > 0 && e.clientX >= r.left - HANDLE_REACH && e.clientX <= r.right + HANDLE_REACH
      );
    });
    const handle =
      target?.closest('[data-slot="resizable-handle"]') ??
      near ??
      handles.find((h) => ["hover", "active"].includes(h.getAttribute("data-separator") ?? ""));
    if (!handle) return;
    const side: Side | undefined = ({ context: "context", chat: "chat" } as const)[
      handle.getAttribute("data-handle-for") ?? ""
    ];
    if (!side) return;
    e.preventDefault();
    e.stopPropagation();
    handleDoubleClick(side);
  };
  /** The handle's Enter goes through the same two acts, in the capture phase. */
  const handleEnter = (side: Side) => (e: ReactKeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    e.stopPropagation();
    if (collapsed[side]) expand(side);
    else collapse(side);
  };
  /**
   * Where focus goes when a column's control takes itself away: collapsing hides
   * the column's body (and its collapse button) behind the rail, and reopening
   * removes the rail's reopen button, so focus would fall to the body. The twin
   * control is where the next act is.
   */
  /** A selector for where focus goes once it is drawn; null for nowhere pending. */
  const focusNext = useRef<string | null>(null);
  const toggleFrom = useCallback(
    (side: Side, act: "collapse" | "expand", then?: string) => {
      const acted = act === "collapse" ? collapse(side) : expand(side);
      // A no-op leaves nothing pending: a stale hand-off would otherwise grab
      // focus the next time that control happened to render.
      focusNext.current = acted
        ? (then ?? `[data-column-control="${side}-${act === "collapse" ? "reopen" : "collapse"}"]`)
        : null;
    },
    [collapse, expand],
  );
  useEffect(() => {
    const sel = focusNext.current;
    if (!sel) return;
    const el = document.querySelector<HTMLElement>(sel);
    if (!el || el.closest("[inert]")) return;
    focusNext.current = null;
    el.focus();
  });
  const onLayoutChanged = useCallback(
    (next: Layout, meta: Parameters<typeof layout.onLayoutChanged>[1]) => {
      layout.onLayoutChanged(next, meta);
      const panels = { context: contextPanel.current, chat: chatPanel.current };
      const now = collapsedFrom(next, panels);
      // A RAIL STAYS A RAIL WHEN THE WINDOW GROWS. The library keeps a collapsed
      // panel's share of the group in percent, so a rail collapsed in a narrow
      // window (40 px of 640 is 6.25%) comes back past its threshold in a wide one
      // and is opened at its minimum. Only the human (a drag, a key on a handle)
      // and the shell's own reopen open a column; anything else is put back.
      for (const side of ["context", "chat"] as const) {
        if (!collapsedRef.current[side] || now[side]) continue;
        // A reopen asked for is spent once the column is seen open; several can
        // be in flight at once (leaving reader mode reopens both).
        if (reopening.current.delete(side) || meta.isUserInteraction) continue;
        panels[side]?.collapse();
        now[side] = true;
      }
      collapsedRef.current = now;
      setCollapsed((prev) => (prev.context === now.context && prev.chat === now.chat ? prev : now));
      const remembered = rememberOpen(openSizesRef.current, next, meta.isUserInteraction, now);
      if (remembered !== openSizesRef.current) {
        openSizesRef.current = remembered;
        storage.setItem(OPEN_KEY, encodeOpenSizes(remembered));
      }
    },
    [layout, storage, contextPanel, chatPanel],
  );

  /** The columns as the centre sees them: what reader mode reads and acts on. */
  const columns = useMemo<Columns>(
    () => ({
      collapsed: { context: collapsed.context, chat: collapsed.chat },
      collapse: (side) => void collapse(side),
      expand: (side) => void expand(side),
    }),
    [collapsed.context, collapsed.chat, collapse, expand],
  );
  /**
   * The centre is in a quiet reading mode (reader mode), so the shell's own chrome
   * fades with it. The centre derives it and says so; the shell only follows.
   */
  const [quietWanted, setQuiet] = useState(false);
  // The image viewer has no reading mode: a reader mode left on by the document
  // it replaced does not fade the chrome around an image.
  const quiet = quietWanted && !state.openImage;
  const fade = quiet ? QUIET_FADE : undefined;

  /**
   * The chat rail's mark: the agent has said something since the column was last
   * open. What was seen is the newest message while it is open; reopening it is
   * seeing it, which clears the mark. A reload starts from what is already there.
   */
  const newestMessage = lastMessageId(state.chat);
  const [seenMessage, setSeenMessage] = useState(newestMessage);
  useEffect(() => {
    if (!collapsed.chat && seenMessage !== newestMessage) setSeenMessage(newestMessage);
  }, [collapsed.chat, newestMessage, seenMessage]);
  const chatUnseen = collapsed.chat && unseenFromAgent(state.chat, seenMessage);

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
  const focusPane = useCallback(
    (pane: PaneName) => {
      if (pane === "context" && collapsed.context) expand("context");
      if (pane === "chat" && collapsed.chat) expand("chat");
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus(),
      );
    },
    [collapsed.context, collapsed.chat, expand],
  );
  /** Brings the chat tab forward; set below, where the tabs are. */
  const showChatTab = useRef<() => void>(() => {});
  const focusComposer = useCallback(() => {
    // Talking to the agent never needs the column: a float on screen takes it.
    if (floating) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(FLOAT_INPUT)?.focus());
      return;
    }
    if (collapsed.chat) expand("chat");
    showChatTab.current();
    // Twice: once for the column to open, once for the tab to draw its composer.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('[data-pane="chat"] [data-slot="composer-input"]')
          ?.focus(),
      ),
    );
  }, [collapsed.chat, expand, floating]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey) {
        const pane = ({ "1": "context", "2": "centre", "3": "chat" } as const)[
          e.key as "1" | "2" | "3"
        ];
        if (pane) {
          e.preventDefault();
          focusPane(pane);
          return;
        }
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const side: Side = e.key === "[" ? "context" : "chat";
          // Where focus is on the control that goes away (inside the column being
          // collapsed, or on the rail being reopened) it is handed on, as the
          // buttons do; from anywhere else focus stays where it is.
          const holds = document.activeElement?.closest(
            collapsed[side]
              ? `[data-column-control="${side}-reopen"]${side === "chat" ? ", [data-slot=chat-unseen]" : ""}`
              : `[data-pane="${side}"]`,
          );
          const act = collapsed[side] ? "expand" : "collapse";
          // From the floating composer, the column's composer is where typing goes on.
          const inFloat =
            side === "chat" && document.activeElement?.closest('[data-slot="floating-composer"]');
          // From the column's composer, typing goes on in the float. (An open
          // column always clears a closed float, so the float will show; the
          // guard only keeps the hand-off honest if that ever changes.)
          const inColumnInput = side === "chat" && document.activeElement?.closest(COLUMN_INPUT);
          if (inFloat && act === "expand") toggleFrom(side, act, COLUMN_INPUT);
          else if (inColumnInput && act === "collapse" && !floatClosed)
            toggleFrom(side, act, FLOAT_INPUT);
          else if (holds) toggleFrom(side, act);
          else if (act === "expand") expand(side);
          else collapse(side);
          return;
        }
      }
      // Escape from inside a sidebar, with nothing open to close, returns to the
      // centre. Dialogs, menus and tooltips close on Escape themselves (and stop
      // the event), so this only sees an Escape nobody else took.
      if (e.key === "Escape" && !e.defaultPrevented && !mod) {
        const t = e.target as HTMLElement | null;
        const typing = t?.matches?.("input, textarea, select, [contenteditable='true']");
        const inSide = t?.closest?.('[data-pane="context"], [data-pane="chat"]');
        const popup = document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]',
        );
        if (inSide && !typing && !popup && root.contains(t)) focusPane("centre");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, collapse, expand, focusPane, toggleFrom, floatClosed]);

  // ── the open document, and the selection held against it ────────────────
  const openDoc = useMemo(
    () => state.docs.find((d) => d.slug === state.openDoc) ?? null,
    [state.docs, state.openDoc],
  );
  // The open image, when one is: the centre shows the kit's viewer instead of
  // the app's own centre, and the app's toolbar (a document's tools) stands aside.
  const openImage = state.openImage ?? null;
  // A bundle's main file opened from its own row inside the expanded bundle
  // is drawn raw. It stays so while that file is the open document, and ends
  // when another one opens (the bundle's own row clears it at once).
  const [rawMain, setRawMain] = useState<string | null>(null);
  const openOriginal = openDoc?.original ?? null;
  const rawRef = useRef(rawMain);
  rawRef.current = rawMain;
  useEffect(() => {
    if (rawRef.current !== null && openOriginal !== rawRef.current) setRawMain(null);
  }, [openOriginal]);
  const [selection, setSelection] = useState<HeldSelection | null>(null);
  const [clearSeq, setClearSeq] = useState(0);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealSeq = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  /** One held selection, told to the daemon, with a bump when the panes must unpaint. */
  const onSelectionEvent = useCallback((event: SelectionEvent) => {
    const { held, clearPaint } = applySelectionEvent(selectionRef.current, event);
    selectionRef.current = held;
    setSelection(held);
    if (clearPaint) setClearSeq((n) => n + 1);
    if (event.type === "shown") setReveal((r) => revealAfter(r, event));
    else setReveal((r) => revealAfter(r, { type: "selection" }));
  }, []);
  const shownDoc = openDoc?.slug ?? null;
  const shownVersion = openDoc?.active ?? null;
  useEffect(() => {
    onSelectionEvent({ type: "shown", doc: shownDoc, version: shownVersion });
  }, [shownDoc, shownVersion, onSelectionEvent]);
  // A note is pointed at until the human moves on: another document or version.
  // The Notes panel borders it and the centre paints its passage, from this one id.
  // Resolving it lets it go as well: it leaves the panel's list, so it leaves the
  // document's paint (a resolved note chosen while they are listed stays chosen).
  const [pointedAt, setPointedAt] = useState<{
    id: string;
    doc: string;
    version: number;
    resolved: boolean;
  } | null>(null);
  const focusedNote =
    pointedAt && pointedAt.doc === shownDoc && pointedAt.version === shownVersion
      ? pointedAt.id
      : null;
  const pickedState =
    focusedNote === null ? undefined : openDoc?.notes.find((n) => n.id === focusedNote)?.resolved;
  useEffect(() => {
    if (!pointedAt || pickedState === undefined) return;
    if (pickedState && !pointedAt.resolved) setPointedAt(null);
    // Chosen while resolved and reopened since: the next resolve lets it go.
    else if (!pickedState && pointedAt.resolved) setPointedAt({ ...pointedAt, resolved: false });
  }, [pickedState, pointedAt]);
  /** The Notes panel is listing resolved notes: the document paints them too. */
  const [showResolvedNotes, setShowResolvedNotes] = useState(false);
  // The daemon holds the selection `say` attaches; it is told of every change.
  // The snapshot is read when the selection changes, not on every snapshot. A
  // reconnect tells it again: a daemon that restarted holds no selection, and the
  // chip on screen would otherwise promise a passage `say` no longer carries.
  const connected = daemon.connection === "open";
  const docsRef = useRef(state.docs);
  docsRef.current = state.docs;
  useEffect(() => {
    if (!connected) return;
    if (!selection) {
      send({ op: "select", selection: null });
      return;
    }
    const doc = docsRef.current.find((d) => d.slug === selection.doc);
    const path = doc?.versions.find((v) => v.n === selection.version)?.path;
    if (!path) return;
    send({
      op: "select",
      selection: {
        doc: selection.doc,
        version: selection.version,
        path,
        fromLine: selection.fromLine,
        toLine: selection.toLine,
        text: selection.text,
      },
    });
  }, [selection, send, connected]);

  // Whole documents pointed at from an app's view: the chip's other kind. One
  // kind is held at a time, so a message is never about two things at once.
  const [pointedDocs, setPointedDocs] = useState<PointedDocs | null>(null);
  const reportSelection = useCallback(
    (s: HeldSelection) => {
      if (s.from !== s.to) setPointedDocs(null);
      onSelectionEvent({ type: "report", selection: s });
    },
    [onSelectionEvent],
  );
  const dropSelection = useCallback(() => onSelectionEvent({ type: "drop" }), [onSelectionEvent]);
  const pointDocs = useCallback(
    (p: PointedDocs | null) => {
      const next = p && (p.docs.length > 0 || p.label) ? p : null;
      if (next && selectionRef.current) onSelectionEvent({ type: "drop" });
      setPointedDocs(next);
    },
    [onSelectionEvent],
  );
  // ── what the next message draws on besides its subject ──────────────────
  // The file tree's selection (absolute row paths): the tree's own, held here so
  // it outlives a set drilled out of, read at send and never cleared by it.
  const [treeSelected, setTreeSelected] = useState<readonly string[]>([]);
  // The references added by hand ("Add as reference"): cleared on send.
  const [addedRefs, setAddedRefs] = useState<readonly MessageRef[]>([]);
  const addRef = useCallback(
    (ref: MessageRef) =>
      setAddedRefs((rs) => (rs.some((r) => r.path === ref.path) ? rs : [...rs, ref])),
    [],
  );
  const removeRef = useCallback(
    (path: string) => setAddedRefs((rs) => rs.filter((r) => r.path !== path)),
    [],
  );
  const clearRefs = useCallback(() => setAddedRefs([]), []);
  const requestReveal = useCallback((target: Omit<Reveal, "seq">) => {
    setReveal({ ...target, seq: ++revealSeq.current });
  }, []);
  const revealApplied = useCallback(
    (seq: number) => setReveal((r) => revealAfter(r, { type: "applied", seq })),
    [],
  );

  // ── opening a search result ──────────────────────────────────────────────
  // A match in the document already on screen is shown at once. Otherwise the
  // document is opened first, and the match is shown when it is the one on screen:
  // a reveal asked for before that would be spent by the switch itself.
  const [pendingShow, setPendingShow] = useState<{
    path: string;
    from: number;
    to: number;
    /** A heading's line, for a link followed to a heading: see `Reveal`. */
    heading?: { from: number; to: number };
    /** The document on screen when it was asked for: leaving for any other one cancels it. */
    since: string | null;
  } | null>(null);
  // The same for a backlink, which knows where its link sits in the source.
  const openAt = useCallback(
    (path: string, at?: { from: number; to: number }) => {
      if (openDoc && openDoc.original === path) {
        setPendingShow(null);
        if (at)
          requestReveal({ doc: openDoc.slug, version: openDoc.active, from: at.from, to: at.to });
        return;
      }
      setPendingShow(
        at ? { path, from: at.from, to: at.to, since: openDoc?.original ?? null } : null,
      );
      send({ op: "open", path });
    },
    [send, requestReveal, openDoc],
  );
  const openResult = useCallback(
    (r: SearchResult) => {
      // A match in an image's description opens the image, which shows it.
      if (r.image) {
        setPendingShow(null);
        send({ op: "open", path: r.image });
        return;
      }
      openAt(
        r.path,
        r.kind === "text" && r.from !== undefined && r.to !== undefined
          ? { from: r.from, to: r.to }
          : undefined,
      );
    },
    [openAt, send],
  );
  // Declared after the effect that clears a reveal when the document changes, so
  // that on the render a document comes on screen the clear runs first.
  useEffect(() => {
    if (!pendingShow) return;
    if (openDoc?.original !== pendingShow.path) {
      // Another document came on screen instead: the request is stale.
      if ((openDoc?.original ?? null) !== pendingShow.since) setPendingShow(null);
      return;
    }
    setPendingShow(null);
    requestReveal({
      doc: openDoc.slug,
      version: openDoc.active,
      from: pendingShow.from,
      to: pendingShow.to,
      ...(pendingShow.heading ? { heading: pendingShow.heading } : {}),
    });
  }, [pendingShow, openDoc, requestReveal]);

  // ── following a link to a heading ────────────────────────────────────────
  // The daemon opened the document and says where the link's heading is in the
  // version it opened (kit-heading-links-build). The human followed their own
  // link, so the caret goes to the heading's start, nothing selected, and its
  // line is marked; a heading not found opens the document at the top, and
  // says which heading was not there. Shown once the document is on screen, as
  // a search result is.
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;
  const { onFrame: onDaemonFrame } = daemon;
  const { announce: announceToast } = toasts;
  useEffect(
    () =>
      onDaemonFrame((frame) => {
        if (frame.op !== "link.target") return;
        const f = frame as Extract<ServerOp, { op: "link.target" }>;
        if (f.state !== "in-context" || !f.heading || f.refused) return;
        const { found, anchor } = f.heading;
        if (!found)
          announceToast(
            "Heading not found",
            `No heading “${anchor}” in ${baseName(f.path)}; opened at the top.`,
          );
        setPendingShow({
          path: f.path,
          from: found?.from ?? 0,
          to: found?.from ?? 0,
          ...(found ? { heading: { from: found.from, to: found.to } } : {}),
          since: openDocRef.current?.original ?? null,
        });
      }),
    [onDaemonFrame, announceToast],
  );

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
  const { lastError, lastErrorTitle, clearError, done } = daemon;
  const endedToastAt = useRef(0);
  // A refusal (the open failed) cancels a reveal that was waiting on it.
  useEffect(() => {
    if (lastError) setPendingShow(null);
  }, [lastError]);
  // An app that shows refusals in the sidebar's notice keeps them there: one
  // place per refusal, cleared when the human dismisses it. While the context
  // column is collapsed its notice is out of sight, so the refusal is toasted
  // as well, and left for the app to clear: the human always sees a refusal.
  const noticeOwned = notice !== undefined;
  /** The toast standing in for the notice while the column is collapsed. */
  const ownedToast = useRef<number | null>(null);
  const { dismiss: dismissToast } = toasts;
  const letOwnedToastGo = useCallback(() => {
    if (ownedToast.current === null) return;
    dismissToast(ownedToast.current);
    ownedToast.current = null;
  }, [dismissToast]);
  useEffect(() => {
    if (!lastError) return;
    if (noticeOwned && lastError !== SESSION_ENDED) {
      if (collapsedRef.current.context) {
        letOwnedToastGo();
        ownedToast.current = toasts.announce(
          lastErrorTitle ?? "The workspace refused that",
          lastError,
        );
      }
      return;
    }
    if (lastError === SESSION_ENDED) {
      // One toast per burst: a held key or a double click is one answer, not five.
      if (Date.now() - endedToastAt.current > 2500) toasts.announce("Session ended", lastError);
      endedToastAt.current = Date.now();
    } else toasts.announce(lastErrorTitle ?? "The workspace refused that", lastError);
    clearError();
  }, [lastError, lastErrorTitle, clearError, toasts, noticeOwned, letOwnedToastGo]);
  // The stand-in goes once the notice is in sight (the column reopened) or the
  // refusal is let go: a refusal is never shown twice at once.
  useEffect(() => {
    if (!lastError || !collapsed.context) letOwnedToastGo();
  }, [lastError, collapsed.context, letOwnedToastGo]);
  // A new document or folder this viewer made arrives in rename mode; a new
  // document also opens.
  // A move this viewer made, once the daemon has done it: the sidebar puts the
  // focus on the row where it now is.
  const moved = useMemo(
    () => (done?.of === "move" ? { path: done.path, seq: done.seq } : null),
    [done],
  );
  const created = useMemo(
    () =>
      done &&
      (done.of === "doc.create" || done.of === "folder.create" || done.of === "bundle.create")
        ? { path: done.path, seq: done.seq }
        : null,
    [done],
  );
  // A new document opens, and so does a new bundle (as its main file), unless
  // its maker stays where it is and only asks for it to be named.
  useEffect(() => {
    if (done?.stay === "rename") return;
    if (done?.of === "doc.create" || done?.of === "bundle.create")
      send({ op: "open", path: done.path });
  }, [done, send]);

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
  }, [contextEntries]);

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
  const notesWaiting = state.notesWaiting ?? [];
  const noteBadges = badgesOn(notesWaiting, openDoc?.slug ?? null);
  const notesElsewhere = elsewhere(notesWaiting, openDoc?.slug ?? null).map((o) => ({
    ...o,
    name: docName(o.doc),
  }));
  const notesOwed = owedSummary(notesWaiting, agentListening);
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
      // Drawn in one place at a time: here while the column is open, floating
      // at the foot of the centre while it is collapsed.
      composer={collapsed.chat ? null : <ChatComposer {...composerProps} />}
      docName={docName}
      pathName={pathName}
      onFollowLink={(target) =>
        // Resolved by the daemon, as the document pane's links are. A chat link
        // was not written beside the open document, so `from: "chat"` lets its
        // `./` and `../` fall back to the context's root.
        send({
          op: "link.open",
          target,
          from: "chat",
          ...(openDoc ? { doc: openDoc.slug } : {}),
        })
      }
      {...(messageActions ? { messageActions } : {})}
    />
  );
  const notesPanel_ = (
    <NotesPanel
      notes={notes}
      waiting={noteBadges}
      others={notesElsewhere}
      agentListening={agentListening}
      onOpenDoc={(doc) => send({ op: "open.doc", doc })}
      focusedId={focusedNote}
      onLetGo={() => setPointedAt(null)}
      showResolved={showResolvedNotes}
      onShowResolved={setShowResolvedNotes}
      selection={heldHere ? { from: heldHere.from, to: heldHere.to, text: heldHere.text } : null}
      onAdd={(from, to, body) => {
        if (!openDoc) return;
        send({ op: "note.add", doc: openDoc.slug, from, to, body });
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
          {state.waiting && <WaitingDot badge={badgeFor(state.waiting, agentListening)} />}
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
        {/* THE TOP BAR, across the window: which app and which session, search over
            every document in the session, and what acts on the session itself.
            Three columns, the outer two equal while their content fits, so search
            is centred against the WINDOW rather than drifting with the title's
            length. Search gives way as the window narrows, down to its icon, and
            the session id is dropped before anything clips. Quieter in reader
            mode, like the rest of the chrome. */}
        <header
          data-slot="shell-top-bar"
          className={cn(
            "@container grid h-10 shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,2fr)_minmax(max-content,1fr)] items-center gap-3 border-b bg-surface px-3",
            quiet ? `${QUIET_GROUP} border-transparent` : "border-edge",
          )}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            {/* The id hides on a narrow bar, so the title carries it as a tooltip. */}
            <span
              data-slot="app-title"
              title={sessionLabel}
              className={cn("text-sm font-medium text-ink", fade)}
            >
              {state.appTitle ?? state.app}
            </span>
            {/* Ended is news, so it is never faded, like the status bar's mark. */}
            <span
              data-slot="session-id"
              className={cn(
                "hidden font-mono text-xs @[34rem]:inline",
                daemon.connection === "ended" ? "text-ink-dim" : "text-ink-faint",
                daemon.connection !== "ended" && fade,
              )}
            >
              {sessionLabel}
            </span>
          </div>
          <div className="flex min-w-0 justify-center">
            <SearchBox
              request={daemon.request}
              connected={daemon.connection === "open"}
              onOpen={openResult}
              className={fade}
            />
          </div>
          <div className="flex items-center justify-end gap-1">
            {ended ? (
              <EndedChip command={restoreCommand} by={daemon.endedBy} chipRef={chipRef} />
            ) : (
              <ColumnButton
                label="End session"
                control="end-session"
                onClick={() => setEndPhase("confirm")}
                disabled={daemon.connection !== "open"}
                className={fade}
              >
                <PowerIcon aria-hidden />
              </ColumnButton>
            )}
            <ColumnButton
              label="Settings"
              control="settings"
              onClick={() => setSettingsOpen(true)}
              disabled={daemon.connection !== "open"}
              className={fade}
            >
              <SettingsIcon aria-hidden />
            </ColumnButton>
            <ColumnButton
              label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className={fade}
            >
              {theme === "dark" ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
            </ColumnButton>
          </div>
        </header>
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
          <ResizablePanel
            id="chat"
            panelRef={chatPanel}
            collapsible
            defaultSize={`${DEFAULT_SIZE.chat}`}
            minSize={`${MIN_SIZE.chat}`}
            collapsedSize={`${RAIL_PX}px`}
            className="flex flex-col bg-surface"
          >
            {collapsed.chat && (
              <Rail
                quiet={quiet}
                below={
                  (floatIcon || chatUnseen) && (
                    <div className="flex flex-col items-center">
                      {/* The float closed: this brings it back. Idle, so it fades. */}
                      {floatIcon && (
                        <ColumnButton
                          label="Show the composer"
                          control="chat-float-show"
                          onClick={() => {
                            setFloatClosed(false);
                            focusNext.current = FLOAT_INPUT;
                          }}
                          className={fade}
                        >
                          <MessageSquareIcon aria-hidden />
                        </ColumnButton>
                      )}
                      {/* Asks for attention, so it never fades with the rail. A button
                      of its own: the 8 px dot sits centred in a 24 px target, which
                      also puts it under the reopen row. A press opens the
                      conversation on the Chat tab, where the new message is. */}
                      {chatUnseen && (
                        <button
                          type="button"
                          data-slot="chat-unseen"
                          aria-label="Open the conversation: the agent has said something new"
                          title="Open the conversation: the agent has said something new"
                          onClick={() => {
                            setPanelId("chat");
                            toggleFrom("chat", "expand");
                          }}
                          className="flex size-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          <span aria-hidden className="size-2 rounded-full bg-attention" />
                        </button>
                      )}
                    </div>
                  )
                }
              >
                <ColumnButton
                  label={
                    chatUnseen
                      ? "Reopen the conversation column: the agent has said something new"
                      : "Reopen the conversation column"
                  }
                  control="chat-reopen"
                  onClick={() => toggleFrom("chat", "expand")}
                  className={fade}
                >
                  <PanelRightOpenIcon aria-hidden />
                </ColumnButton>
              </Rail>
            )}
            <div
              data-pane="chat"
              tabIndex={-1}
              inert={collapsed.chat}
              hidden={collapsed.chat}
              className={cn(
                "min-h-0 flex-1 flex-col outline-none",
                collapsed.chat ? "hidden" : "flex",
              )}
            >
              {/* The collapse button is pinned; the tabs give way. */}
              <div className="flex min-h-9 shrink-0 items-center gap-0.5 border-b border-edge px-2 py-1">
                <div
                  role="tablist"
                  aria-label="Conversation column"
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 overflow-hidden"
                  onKeyDown={(e) => {
                    // Arrow keys move between tabs, the tablist pattern.
                    const i = tabs.findIndex((t) => t.id === activePanel.id);
                    const to =
                      e.key === "ArrowRight"
                        ? tabs[(i + 1) % tabs.length]
                        : e.key === "ArrowLeft"
                          ? tabs[(i - 1 + tabs.length) % tabs.length]
                          : e.key === "Home"
                            ? tabs[0]
                            : e.key === "End"
                              ? tabs.at(-1)
                              : undefined;
                    if (!to) return;
                    e.preventDefault();
                    setPanelId(to.id);
                    requestAnimationFrame(() =>
                      document.getElementById(`${storageKey}-tab-${to.id}`)?.focus(),
                    );
                  }}
                >
                  {tabs.map((p) => (
                    <button
                      key={p.id}
                      id={`${storageKey}-tab-${p.id}`}
                      type="button"
                      role="tab"
                      aria-selected={activePanel.id === p.id}
                      aria-controls={`${storageKey}-tabpanel`}
                      tabIndex={activePanel.id === p.id ? 0 : -1}
                      onClick={() => setPanelId(p.id)}
                      className={cn(
                        "rounded-sm px-2 py-1 text-xs font-medium tracking-wide uppercase",
                        "text-ink-dim hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                        activePanel.id === p.id && "bg-surface-raised text-ink",
                      )}
                    >
                      {p.label}
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
              <div
                id={`${storageKey}-tabpanel`}
                role="tabpanel"
                aria-labelledby={`${storageKey}-tab-${activePanel.id}`}
                className="flex min-h-0 flex-1 flex-col"
              >
                {activePanel.node}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
        <footer
          data-slot="shell-status"
          className={cn(
            "flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-surface px-3 text-xs text-ink-dim",
            quiet && QUIET_GROUP,
          )}
        >
          {/* Connected is idle and fades; anything else (retrying, ended) is news. */}
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5",
              daemon.connection === "open" && fade,
            )}
            title={`${CONNECTION_TITLE[daemon.connection]}\n${state.dir}`}
          >
            <Dot
              tone={
                daemon.connection === "open"
                  ? "bg-added"
                  : daemon.connection === "closed"
                    ? "bg-danger"
                    : "bg-attention"
              }
              pulse={daemon.connection === "connecting"}
            />
            {CONNECTION_LABEL[daemon.connection]}
          </span>
          {/* The agent, apart from the page: only while the page can know. Listening
              is idle and fades; nobody listening is news. */}
          {daemon.connection === "open" && (
            <span
              data-slot="agent-presence"
              data-listening={agentListening}
              className={cn("flex shrink-0 items-center gap-1.5", agentListening && fade)}
              title={PRESENCE[agentListening ? "listening" : "absent"].title}
            >
              <Dot tone={agentListening ? "bg-brand" : "bg-ink-faint"} />
              {PRESENCE[agentListening ? "listening" : "absent"].label}
            </span>
          )}
          <div className={cn("flex min-w-0 flex-1 items-center", fade)}>{status}</div>
          {/* The link check: nothing at all while the session's links are sound. */}
          <LinkCheck
            request={daemon.request}
            onFrame={daemon.onFrame}
            connected={daemon.connection === "open"}
            snapshot={state}
            edits={daemon.texts}
            onOpen={openAt}
            className={fade}
          />
        </footer>
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
