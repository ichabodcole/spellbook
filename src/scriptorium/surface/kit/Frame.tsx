/**
 * The flagged Scriptorium's surface (`SCRIPTORIUM_KIT=1` only): the kit's
 * `WorkspaceShell` (the context sidebar, the conversation column with Chat,
 * Notes and Tasks, resizable columns with rails, the floating composer, search,
 * End session and the theme) around the kit's document pane, filled with what is
 * Scriptorium's own. It replaced the interim frame (a fixed three-column layout
 * and a small workspace of its own, `frameWorkspace.ts`) whole.
 *
 * Scriptorium's own, passed into the shell's and the pane's slots:
 * - the tree's status dot (`rowMarker`), and the menu actions: hide, unhide,
 *   make-set, New beside it, and the map's entry (`menuActions`);
 * - the move plan (`beforeMove`, `uncheckedMoveNote`, `./movePlan.tsx`);
 * - where a new file goes when nothing is selected (`askLocation`, its dialog
 *   rendered in the centre: it portals);
 * - the refusal notice, with the daemon's hint read off its frame;
 * - the centre `DocumentPane`: the trust and stale chips, split view, line
 *   numbers, the map as its app view, "Add a block" (`textOffer`), and the view
 *   mode under the shipped pref `doc:view`;
 * - a comparison asked for from a toast: the new version's, and the outside
 *   change's against the file on disk;
 * - End session's unsaved warning (`scriptoriumEndWarning`);
 * - the shell's storage, backed by the daemon's prefs (`./prefsStorage.ts`), so
 *   the layout, the float, the tab, the theme, the view mode and line numbers
 *   come back in the next session, whose port (and origin) is new.
 *
 * Every create, import and drop the panes send names its folder (`dir`):
 * Scriptorium has no workspace, so what has no set or folder under it (New
 * document or New folder with nothing selected, a drop on the list itself) asks
 * where, the place chosen last preselected.
 *
 * The page's stylesheet (`./styles.css`) is its own: the kit's base, then the
 * document's rules, then the shell's.
 */

import {
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderTreeIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAskLocation } from "../../../kit/context/AskLocation";
import type { Daemon } from "../../../kit/context/daemonClient";
import type { MenuActions } from "../../../kit/context/menuActions";
import { dirOf, entryPath, singleDoc } from "../../../kit/context/model";
import { DocumentPane, type ShowDiff } from "../../../kit/document/DocumentPane";
import type { FrontmatterChips } from "../../../kit/document/FrontmatterHeader";
import { bundlePlace } from "../../../kit/lib/bundles";
import { cn } from "../../../kit/lib/cn";
import { WorkspaceShell } from "../../../kit/shell/WorkspaceShell";
import type { DiffSide, DocView, PublicState } from "../../../kit/workspace/protocol";
import { type DocSummary, isStale } from "../../backend/kit/frontmatter";
// Scriptorium's document kinds (`.mdx`), as the daemon registers them, so the tree reads them alike.
import "../../backend/kit/docKinds";
import { scriptoriumBeforeMove, scriptoriumUncheckedMoveNote } from "./movePlan";
import { LINE_NUMBERS_KEY, prefsStorage, VIEW_MODE_KEY } from "./prefsStorage";
import { statusMark } from "./statusMark";
import { noFrontmatterOf, scriptoriumTextOffer } from "./suggestMeta";
import { useMapView } from "./useMapView";

export { LINE_NUMBERS_KEY, VIEW_MODE_KEY };

const NO_ENTRIES: PublicState["context"] = [];
const NO_PREFS: Readonly<Record<string, string>> = {};

/** Under the location dialog: the other way to make room for new files. */
const MAKE_ROOM =
  "A document listed on its own can take new files beside it once it is a set: Turn into a set, in its row's menu.";

/** The stale chip's hover text: the tree's dot says the same (`statusMark`). */
const STALE_TITLE = "Past its stale_after date";

/**
 * The pane's chip slot: the kit's chips, and a stale chip when the document is
 * past its `stale_after`, as the shipped header shows one (`MetaHeader`). Read
 * off the fields the header shows, by the shipped rule (`isStale`), so the
 * chip and the fields beside it describe the same text. It claims no key, so
 * `stale_after` itself is still listed, as the shipped header lists it.
 */
export function scriptoriumChips(now: () => number = Date.now): FrontmatterChips {
  return (fields, chips) =>
    isStale(fields as Record<string, unknown>, now())
      ? [
          ...chips,
          {
            tone: "attention",
            title: STALE_TITLE,
            label: (
              <>
                <ClockIcon aria-hidden className="size-3" />
                stale
              </>
            ),
          },
        ]
      : chips;
}
const CHIPS = scriptoriumChips();

/** What `hide` left out of each entry, by entry id (the kit daemon's `appState.hidden`). */
const hiddenOf = (state: PublicState): Record<string, string[]> =>
  ((state.appState as { hidden?: Record<string, string[]> } | null)?.hidden ?? {}) as Record<
    string,
    string[]
  >;

const NO_META: Record<string, DocSummary> = {};

/** Each document's frontmatter, by absolute path (the kit daemon's `appState.docMeta`). */
const docMetaOf = (state: PublicState | null): Record<string, DocSummary> =>
  (state?.appState as { docMeta?: Record<string, DocSummary> } | null | undefined)?.docMeta ??
  NO_META;

/**
 * The sidebar's `rowMarker`: the shipped tree's status dot (draft, stale,
 * deprecated, unreadable), decided by the shipped `statusMark` and drawn in its
 * classes, so both trees mark the same documents the same way.
 */
export function scriptoriumRowMarker(
  docMeta: Record<string, DocSummary>,
): (path: string) => ReactNode {
  return (path) => {
    const mark = statusMark(docMeta[path]);
    if (!mark) return null;
    return (
      <span
        title={mark.title}
        data-tone={mark.tone}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          "data-[tone=draft]:bg-attention data-[tone=stale]:bg-attention/70",
          "data-[tone=deprecated]:bg-danger data-[tone=unreadable]:bg-ink-faint",
        )}
      />
    );
  };
}

/**
 * Scriptorium's menu actions: Hide on anything inside a set, Show hidden on a set that hides something, and Turn into a set on a
 * document listed on its own (the shipped surface's words for all three). On a
 * document or image inside a set, New document and New folder beside it: the
 * kit's own are on a folder's row, a set's and the tree's background, and a
 * selected document is a place too, so making one there never asks.
 */
export function scriptoriumMenuActions(
  send: Daemon["send"],
  hidden: Record<string, string[]>,
): MenuActions {
  return ({ kind, path, entry }) => {
    if (kind === "background" || !entry) return [];
    const actions = [];
    const own = entry && kind === "entry" && singleDoc(entry);
    if (own)
      actions.push({
        id: "scriptorium.make-set",
        label: "Turn into a set",
        icon: <FolderTreeIcon />,
        onSelect: () => send({ op: "set.make", path: entryPath(entry) }),
      });
    const n = hidden[entry.id]?.length ?? 0;
    if (kind === "entry" && n > 0)
      actions.push({
        id: "scriptorium.unhide",
        label: `Show ${n} hidden ${n === 1 ? "item" : "items"}`,
        icon: <EyeIcon />,
        onSelect: () => send({ op: "scriptorium.unhide", entry: entry.id }),
      });
    const beside =
      (kind === "doc" || kind === "image" || kind === "bundle") && bundlePlace(path) !== "own";
    if (beside) {
      const dir = dirOf(path);
      actions.push(
        {
          id: "scriptorium.new-doc-beside",
          label: "New document beside it",
          icon: <FilePlusIcon />,
          onSelect: () => send({ op: "doc.create", dir }),
        },
        {
          id: "scriptorium.new-folder-beside",
          label: "New folder beside it",
          icon: <FolderPlusIcon />,
          onSelect: () => send({ op: "folder.create", dir }),
        },
      );
    }
    // A row in the list is taken out by the kit's own Remove; Hide is for what is inside.
    if (kind !== "entry")
      actions.push({
        id: "scriptorium.hide",
        label: "Hide from Scriptorium",
        icon: <EyeOffIcon />,
        onSelect: () => send({ op: "scriptorium.hide", path }),
      });
    return actions;
  };
}

/**
 * End session's warning when ending would leave edits out of the files on
 * disk: the shipped app's (`unsavedWarning` in `../state/ending.ts`), in its
 * words, written again here because the kit path borrows nothing from the
 * shipped code. Every unsaved document counts, the open one named first,
 * because it is the one on screen. Nothing is lost (the session keeps its
 * versions), which is why ending is still allowed.
 */
export function scriptoriumEndWarning(
  state: Pick<PublicState, "openDoc"> & {
    docs: readonly Pick<DocView, "slug" | "name" | "active" | "dirty">[];
  },
): string | null {
  const dirty = state.docs
    .filter((d) => d.dirty)
    .sort((a, b) => Number(b.slug === state.openDoc) - Number(a.slug === state.openDoc));
  const first = dirty[0];
  if (!first) return null;
  const kept =
    "They stay in this session (the agent can bring it back with open --restore), but they won't be in your";
  if (dirty.length === 1)
    return `v${first.active} of ${first.name} has unsaved changes. ${kept} file.`;
  return `${dirty.length} documents have unsaved changes (${dirty.map((d) => d.name).join(", ")}). ${kept} files.`;
}

export function Frame({ daemon }: { daemon: Daemon }) {
  const { state, send } = daemon;
  // The shell's storage over the daemon's prefs. Read through refs, so the one
  // adapter lives as long as the page: the shell keys its layout on it.
  const prefs = useRef(state?.prefs ?? NO_PREFS);
  prefs.current = state?.prefs ?? NO_PREFS;
  const connection = useRef(daemon.connection);
  connection.current = daemon.connection;
  const sendRef = useRef(send);
  sendRef.current = send;
  const storage = useMemo(
    () =>
      prefsStorage({
        read: () => prefs.current,
        write: (key, value) => sendRef.current({ op: "prefs.set", key, value }),
        ended: () => connection.current === "ended",
      }),
    [],
  );
  // What is still in its pause is sent as the page goes away.
  useEffect(() => {
    const flush = () => storage.flush();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [storage]);
  // The client keeps a refusal's message only; the daemon's hint (what to do
  // instead, as for a create with no folder) is read off the frame here.
  const hints = useRef(new Map<string, string>());
  useEffect(
    () =>
      daemon.onFrame((f) => {
        if (f.op === "error" && typeof f.hint === "string" && typeof f.message === "string")
          hints.current.set(f.message, f.hint);
      }),
    [daemon.onFrame],
  );
  const userHome = state?.userHome || null;
  const beforeMove = useMemo(
    () => scriptoriumBeforeMove(daemon, { userHome }),
    [daemon.request, userHome],
  );
  // "Add a block" (E35) for a document with no frontmatter: `./suggestMeta.ts`.
  const noBlock = noFrontmatterOf(state);
  const textOffer = useMemo(() => scriptoriumTextOffer(daemon, noBlock), [daemon.request, noBlock]);
  // Where to create when nothing is selected. The place chosen last is held by
  // the hook for as long as this page lives, which is this session's surface.
  const ask = useAskLocation({
    entries: state?.context ?? NO_ENTRIES,
    userHome,
    listDir: daemon.listDir,
    addFolder: (path) => daemon.request({ op: "folder.add", path }),
    hint: MAKE_ROOM,
  });
  // One marker per docMeta, not per render: the sidebar memoises on it.
  const docMeta = docMetaOf(state);
  const rowMarker = useMemo(() => scriptoriumRowMarker(docMeta), [docMeta]);
  const map = useMapView(daemon);
  const hidden = state ? hiddenOf(state) : null;
  const menuActions = useCallback<MenuActions>(
    (t) => [...scriptoriumMenuActions(send, hidden ?? {})(t), ...map.menuActions(t)],
    [send, hidden, map.menuActions],
  );
  // A comparison asked for from outside the pane: a toast's.
  const [showDiff, setShowDiff] = useState<ShowDiff | null>(null);
  const requestDiff = useCallback(
    (doc: string, against: DiffSide) =>
      setShowDiff((was) => ({ doc, version: against, seq: (was?.seq ?? 0) + 1 })),
    [],
  );
  const notice = daemon.lastError
    ? [daemon.lastError, hints.current.get(daemon.lastError)].filter(Boolean).join(". To go on: ")
    : null;
  return (
    <WorkspaceShell
      daemon={daemon}
      storage={storage}
      rowMarker={rowMarker}
      menuActions={menuActions}
      askLocation={ask.askLocation}
      beforeMove={beforeMove}
      uncheckedMoveNote={scriptoriumUncheckedMoveNote}
      notice={notice}
      onDismissNotice={daemon.clearError}
      onShowDiff={(doc, version) => requestDiff(doc.slug, version)}
      onShowOutsideDiff={(doc) => requestDiff(doc.slug, "original")}
      endWarning={scriptoriumEndWarning}
      // E65: a note that may be stuck carries its act, as the shipped app's does.
      askAboutNotes
      centre={
        <>
          <DocumentPane
            showDiff={showDiff}
            viewModeKey={VIEW_MODE_KEY}
            lineNumbers
            lineNumbersKey={LINE_NUMBERS_KEY}
            splitView
            frontmatterTrust
            frontmatterChips={CHIPS}
            appView={map.appView}
            textOffer={textOffer}
          />
          {ask.dialog}
        </>
      }
    />
  );
}
