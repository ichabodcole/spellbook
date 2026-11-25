// THE SHELL'S SIDE COLUMNS: the layout of the three panes, the two side columns'
// collapse and reopen, the hand-off of focus when a column's control takes itself
// away, the centre's quiet reading mode, and the chat rail's unseen mark. A hook
// of `ShellBody`'s, called where this section sat in it, so the hooks keep their
// order.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Layout, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import type { Columns } from "../context/workspace.ts";
import { guardedLayoutStorage } from "../lib/layoutStorage.ts";
import { QUIET_FADE } from "../ui/index.ts";
import type { PublicState } from "../workspace/protocol";
import {
  type Collapsed,
  collapsedFrom,
  collapsedSides,
  DEFAULT_SIZE,
  decodeOpenSizes,
  encodeOpenSizes,
  OPEN_KEY,
  readKept,
  rememberOpen,
  reopenSize,
  type Side,
} from "./columns.ts";
import { lastMessageId, unseenFromAgent } from "./rail.ts";
import { localShellStorage, type ShellStorage } from "./storage.ts";

/** The pane ids are the persisted layout's keys: renaming one forgets a viewer's sizes. */
export const PANES = ["context", "centre", "chat"] as const;

/** How far either side of a handle's drawn line a double-click still reaches it: the library's own reach for a drag. */
const HANDLE_REACH = 6;

export function useShellColumns({
  storageProp,
  storageKey,
  state,
}: {
  storageProp: ShellStorage | undefined;
  storageKey: string;
  state: PublicState;
}) {
  // Collapsed is the library's (`columns.ts`): a collapsed column is a panel at its
  // collapsed size, a 40 px rail, persisted by the same layout as every other size.
  // The panels are asked on every layout change, so the button, a drag shut and a
  // reload all agree by construction.
  const storage = useMemo(
    () => storageProp ?? localShellStorage(storageKey),
    [storageProp, storageKey],
  );
  // The library parses the saved layout during render, unguarded: read through the
  // guard, so a corrupt one opens the default layout rather than a blank page.
  const layoutStorage = useMemo(() => guardedLayoutStorage(storage, "panes", PANES), [storage]);
  const layout = useDefaultLayout({ id: "panes", panelIds: [...PANES], storage: layoutStorage });
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

  return {
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
  };
}
