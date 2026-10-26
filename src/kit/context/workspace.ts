// What the shell hands the pane it does not own: the centre. A centre pane reads
// the daemon's state, reports the human's selection, and answers a request to
// show a range, all through `useWorkspace()`, so it never has to know how the
// sidebars are built.
//
// The shell provides it (`ui/WorkspaceShell.tsx`); this file only names the
// shape and the hook, so the panes and apps can import it without importing the
// shell.

import { createContext, useContext } from "react";
import type { KeptStorage } from "../lib/storage.ts";
import type { Theme } from "../theme/mode.ts";
import type { ToastStore } from "../ui/toast-store.ts";
import type { DocView, ImageView, MessageRef, PublicState } from "../workspace/protocol";
import type { Collapsed, ColumnSide } from "./columns.ts";
import type { Daemon } from "./daemonClient.ts";
import type { HeldSelection, Reveal } from "./selection.ts";

export type PaneName = "context" | "centre" | "chat";

/**
 * Each side column as the centre sees it: which are shut, and the shell's own
 * acts that shut and reopen them (a reopen goes back to the remembered width). The
 * centre never holds a copy: collapsed is read off the layout every render.
 */
export type Columns = {
  collapsed: Collapsed;
  collapse: (side: ColumnSide) => void;
  expand: (side: ColumnSide) => void;
};

export type Workspace = {
  daemon: Daemon;
  /** The latest snapshot. The shell renders nothing until there is one. */
  state: PublicState;
  /** The open document, or null. */
  openDoc: DocView | null;
  /**
   * The image open in the centre's viewer, or null. While one is open the shell
   * shows the kit's viewer instead of the app's centre and toolbar, and
   * `openDoc` is null: a tool that works on a document stands aside, and one
   * that wants to say why reads this. Optional, for a test's hand-made workspace.
   */
  openImage?: ImageView | null;
  /** What the human has selected in the centre, in source coordinates. */
  selection: HeldSelection | null;
  /**
   * The centre reports its selection (an empty range is a clear). The shell
   * keeps ONE held selection, mirrors it in the chat's chip and the notes panel,
   * and tells the daemon, which is what `say` attaches.
   */
  reportSelection: (selection: HeldSelection) => void;
  /** Drop the selection: the chip's X, or a click that clears it in any pane. */
  dropSelection: () => void;
  /**
   * Bumped whenever the held selection goes away, from anywhere. A pane that
   * paints the selection (a highlight over a passage) unpaints when this changes,
   * so clearing it in one place clears it everywhere.
   */
  clearSeq: number;
  /** A request to select and show a range (a note clicked), or null. One shot. */
  reveal: Reveal | null;
  requestReveal: (target: Omit<Reveal, "seq">) => void;
  /** The pane that applied `reveal` says so, which spends it. */
  revealApplied: (seq: number) => void;
  /**
   * The note the human last chose in the Notes panel, by id, while the document
   * and version it was chosen on are the ones shown; null once the human moves
   * on. The centre paints its passage as the focused one. Optional, for a test's
   * hand-made workspace.
   */
  focusedNote?: string | null;
  /**
   * The Notes panel is listing resolved notes too. The centre paints a resolved
   * note only then, or while it is `focusedNote`, so the document marks what the
   * panel lists. Optional, for a test's hand-made workspace.
   */
  showResolvedNotes?: boolean;
  /**
   * Open the document at `path` and, when `at` is given, select and show that
   * range of its active text once it is on screen (a search match, a backlink).
   * Optional: a host without it opens with a plain `open`.
   */
  openAt?: (path: string, at?: { from: number; to: number }) => void;
  toasts: ToastStore;
  announce: ToastStore["announce"];
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** Move keyboard focus into a pane. */
  focusPane: (pane: PaneName) => void;
  /** Each side column: which are collapsed, and collapsing or reopening one. */
  columns: Columns;
  /**
   * The centre says whether it is in a quiet reading mode (reader mode), so the
   * shell's own chrome (its toolbar row and status bar) steps back with the
   * centre's. The centre derives it every render and says it again; false when it
   * unmounts.
   */
  setQuiet: (quiet: boolean) => void;
  /**
   * Whole documents the human has pointed at in a view that shows documents
   * rather than text (an app's own centre view), or null. Held like a text
   * selection: the chat shows it as its chip, and the chip's X drops it. On
   * `say` one of them is the subject (the open one, else the first) and the
   * rest ride as `about.refs`. One kind at a time: a text selection drops it,
   * and pointing drops the text selection. Optional for hosts without it.
   */
  pointedDocs?: PointedDocs | null;
  /**
   * Put the keyboard in the chat's composer (opening the chat column if it is
   * shut), for an app action that leads to asking the agent. The human's own
   * act only: never call it for an agent's action.
   */
  focusComposer?: () => void;
  /** Point at documents (null drops them). `from` names the view that pointed. */
  pointDocs?: (pointed: PointedDocs | null) => void;
  /**
   * What the human added as a reference by hand ("Add as reference" on a row
   * or a card's menu), for the next message: it rides as `about.refs` beside
   * the subject, which it does not replace. Held here, never sent before the
   * message: it survives a change of subject and clears when the message is
   * sent. The file tree's own multi-select is the other source of refs, read
   * at send. Optional for hosts without it.
   */
  refs?: readonly MessageRef[];
  /** Add a reference by hand; a path already held is kept once. */
  addRef?: (ref: MessageRef) => void;
  /** Drop a reference added by hand, by its path. */
  removeRef?: (path: string) => void;
  clearRefs?: () => void;
  /**
   * A bundle's main file (its absolute path) the human opened from its own
   * row inside the expanded bundle: the document pane draws it raw, in its
   * format's editor, not in the app's view of the type, until the bundle is
   * opened from its own row or another document is. Null or absent: none.
   */
  rawMain?: string | null;
  /**
   * The app's own store for a viewer's choices (the shell's `storage` prop), for
   * the panes to keep theirs beside the shell's: the document pane's view mode
   * and line numbers, under the pane's own keys. Absent: the browser's
   * localStorage, as a pane standing alone keeps them.
   */
  storage?: KeptStorage;
};

/** Documents pointed at as a whole, and which view pointed at them. */
export type PointedDocs = {
  docs: readonly { path: string; name: string }[];
  /**
   * What the chip says it is about, in place of "N documents": a view whose
   * selection is more than documents (a board's cards, text cards among them)
   * names it. A labelled pointer with no documents is still held.
   */
  label?: string;
  /** The view that pointed, so it can read back its own selection. */
  from: string;
  /**
   * The documents are named on the chip only: the app's own `about` part
   * carries the selection (Atlas's canvas cards, `about.canvas`), so they are
   * neither the message's subject nor its refs.
   */
  inAppPart?: boolean;
};

export const WorkspaceContext = createContext<Workspace | null>(null);

/** The workspace the surrounding shell provides. Throws outside a shell. */
export function useWorkspace(): Workspace {
  const w = useContext(WorkspaceContext);
  if (!w) throw new Error("useWorkspace must be used inside a WorkspaceShell");
  return w;
}
