// The centre pane: the open document's header, the view (raw, rendered, both side
// by side where the app offers split, or a comparison), and the status strip. An app mounts it as the shell's centre, which
// gives it the workspace through `useWorkspace()`, and adds its own through props:
// raw-view extensions and inline tokens, rendered-view inline widgets, and lines
// for the version-delete confirm. An app's toolbar is the shell's `toolbar` slot,
// and acts on the editor through the handle.
//
// What it decides, because the shell and the daemon client do not:
//
// - CACHE. The daemon client keeps version texts by `doc@version`. The text of the
//   ACTIVE version is authoritative: the daemon pushes every outside change and every
//   activation as a `version.text` frame, and the client drops its texts on a
//   reconnect or a new session. Another version is never shown here (a comparison is
//   computed by the daemon), so its staleness is not observable. The pane asks for
//   the active text only when it has none.
// - WRITING. The editor hands a reader to `daemon.writeText`, which debounces and
//   writes only the active version; a toolbar edit of the whole text goes the same
//   way. Save flushes first.
// - FOCUS. `focusPane("centre")` focuses the shell's `main[data-pane=centre]`; this
//   pane forwards that focus to the editor.

import type { Extension } from "@codemirror/state";
import {
  BookOpenIcon,
  Columns2Icon,
  FileBracesIcon,
  FileCodeIcon,
  FileTextIcon,
  GitCompareIcon,
  GlassesIcon,
  ListOrderedIcon,
  SaveIcon,
  UndoDotIcon,
} from "lucide-react";
import {
  createElement,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Layout, type LayoutChangedMeta, useDefaultLayout } from "react-resizable-panels";
import { type At, NoteAtSelection } from "../chat/NoteAtSelection.tsx";
import { badgeFor } from "../chat/WaitingBadge.tsx";
import { CentreDock } from "../context/centreDock.tsx";
import { textKey } from "../context/daemonClient.ts";
import { carriesRows, readRowDrag } from "../context/rowDrag.ts";
import { useWorkspace } from "../context/workspace.ts";
import { bundleOf } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { docFormat } from "../lib/docFormat.ts";
import { findHeading, lineRange } from "../lib/headingAnchor.ts";
import { headingsOf } from "../lib/headings.ts";
import { type JsonProblem, jsonProblem } from "../lib/json.ts";
import { decodePath } from "../lib/linkTarget.ts";
import { safeStorage } from "../lib/storage.ts";
import {
  Button,
  contentStats,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  QUIET_FADE,
  QUIET_GROUP,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  relativeTime,
  Separator,
  type StatusSegment,
  StatusStrip,
  useConfirm,
} from "../ui/index.ts";
import type {
  Backlinks as BacklinksData,
  BacklinkView,
  DiffSide,
  DocumentProfile,
  DocView,
  DroppedLink,
  EmbedView,
  HeadingOffer,
  LinkHeadings,
  LinkTargets,
  ShowTarget,
} from "../workspace/protocol";
import { ActiveVersionToast } from "./ActiveVersionToast.tsx";
import { Backlinks, type LinkedFromAction } from "./Backlinks.tsx";
import {
  type CompareFocus,
  CompareView,
  FLASH_MS,
  NOTHING_TO_COMPARE,
  NothingToCompare,
  nothingToCompare,
} from "./CompareView.tsx";
import {
  DocumentView,
  type EditorHandle,
  type ImageArrival,
  type RowArrival,
  type SelectionReport,
} from "./DocumentView.tsx";
import type { EmbedSource } from "./embeds.tsx";
import type { FrontmatterChips } from "./FrontmatterHeader.tsx";
import {
  clipboardImages,
  droppedEmbed,
  embedFor,
  embedsText,
  isImageLike,
  pastedImageName,
} from "./imagePaste.ts";
import { LinkPicker } from "./LinkPicker.tsx";
import { rawLinkAct } from "./linkClick.ts";
import {
  insertionGuard,
  type LinkKind,
  type LinkRequest,
  type LinkTracker,
  linkInsertion,
  linkTextProblem,
  typedFrom,
} from "./linkInsert.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import type { InlineToken } from "./markdownMode.ts";
import { NewVersionDialog, type VersionIntent } from "./NewVersionDialog.tsx";
import {
  DEFAULT_LINE_NUMBERS_KEY,
  DEFAULT_VIEW_MODE_KEY,
  hasEditor,
  isSplitLayout,
  nextVersionNumber,
  pointedRange,
  readLineNumbers,
  readViewMode,
  SPLIT_DEFAULT_SIZE,
  SPLIT_LAYOUT_ID,
  SPLIT_MIN_PX,
  SPLIT_MIN_SIZE,
  SPLIT_PANES,
  saveState,
  shownViewMode,
  splitFits,
  storedLineNumbers,
  textToShow,
  type ViewMode,
} from "./pane.ts";
import { createPlace } from "./place.ts";
import { profileFor } from "./profileHeader.ts";
import { lineAt } from "./projection.ts";
import { isReader, readerAct, readerStaysLoud } from "./reader.ts";
import type { InlineWidget } from "./rendered.ts";
import { applyChanges, minimalChange, type TextChange } from "./text.ts";
import { VersionMenu, versionSummary } from "./VersionMenu.tsx";
import { ViewBoundary } from "./ViewBoundary.tsx";

/** Which view a link picker writes through. */
type LinkVia = "editor" | "rendered";
/** A rendered view's tracked range. */
type RenderedTracked = { from: number; to: number };

/** `pos` after `c`, leaning right (1) or left (-1) when the change touches it. */
function mapThrough(pos: number, c: TextChange, assoc: 1 | -1): number {
  if (pos < c.from) return pos;
  if (pos > c.to) return pos + c.insert.length - (c.to - c.from);
  return assoc < 0 ? c.from : c.from + c.insert.length;
}

/** A problem's words as a sentence: ended with a full stop unless they end already. */
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

/**
 * A request, from outside the pane, to compare the open document with a version,
 * or with the file on disk (`"original"`: the outside-change toast's "See the
 * difference").
 */
export type ShowDiff = { doc: string; version: DiffSide; seq: number };

/** How long the backlinks wait after a change before asking: a burst of snapshots is one ask. */
const BACKLINKS_PAUSE_MS = 150;

/** No embed answered yet: one map, so the view is not redrawn for nothing. */
const NO_EMBEDS: ReadonlyMap<string, EmbedView> = new Map();

const MODE_BUTTONS: { mode: ViewMode; label: string; icon: typeof FileTextIcon }[] = [
  { mode: "raw", label: "Raw text", icon: FileCodeIcon },
  { mode: "rendered", label: "Rendered", icon: BookOpenIcon },
  { mode: "split", label: "Raw and rendered side by side", icon: Columns2Icon },
  { mode: "compare", label: "Compare with another version", icon: GitCompareIcon },
];

/** The line-number toggle's name. */
export const LINE_NUMBERS_LABEL = "Line numbers";

/** The reader toggle's tooltip, for entering and for leaving. */
export const READER_LABEL = {
  enter: "Reader mode: rendered, with both columns out of the way",
  leave: "Leave reader mode and bring the columns back",
} as const;

/** The split's halves, one array for the life of the page (the layout hook memoises on it). */
const SPLIT_PANEL_IDS: string[] = [...SPLIT_PANES];

/** The disabled split button's tooltip: why it cannot be pressed, not only that it cannot. */
export const SPLIT_TOO_NARROW = `Raw and rendered side by side: the pane is too narrow (split needs ${SPLIT_MIN_PX} px)`;

/**
 * The pane's own width, watched: a container query can restyle a layout but cannot
 * change a MODE. Measured once before the first paint, so a saved split in a narrow
 * pane is drawn as raw from the start rather than flashing split and then falling
 * back; 0 until then (and where nothing lays out, as in a test DOM) reads as fitting.
 */
function usePaneWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Recount after typing pauses: counting a long document on every key would be the slowest thing here. */
function useDebouncedStats(text: string | undefined, ms = 300) {
  const [stats, setStats] = useState(() => contentStats(text ?? ""));
  useEffect(() => {
    const t = setTimeout(() => setStats(contentStats(text ?? "")), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return stats;
}

/** Re-render on a slow clock so "5 min ago" stays true. */
function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/** What an app adds to the pane. Every part is optional; the pane is complete without them. */
export type DocumentPaneSlots = {
  /** CodeMirror extensions for the raw view, added after its own. Read when the view is built. */
  rawExtensions?: readonly Extension[];
  /** Inline shapes for the raw view's markdown highlighter. Read when the view is built. */
  rawTokens?: readonly InlineToken[];
  /** Spans of the text the rendered view draws as the app's own nodes. */
  inlineWidgets?: readonly InlineWidget[];
  /**
   * The rendered view's frontmatter chips: given a document's fields and the kit's
   * chips (type, status, lifecycle, trust, date), the chips to show. Add one for a key
   * of the app's own, restyle one, or drop one; a key a chip names leaves the header's
   * field list.
   */
  frontmatterChips?: FrontmatterChips;
  /**
   * The frontmatter header's trust chip, derived from `verified`. On by default, and
   * then shown only for a document that has the key; off for an app whose documents
   * never carry it (Atlas), where "unverified" would read as a judgement.
   */
  frontmatterTrust?: boolean;
  /**
   * Lines added to the warning in the version-delete confirm: what else goes with the
   * version. Asked when the human presses Delete; empty lines are dropped.
   */
  versionDeleteWarnings?: (doc: DocView, version: number) => readonly (string | null | undefined)[];
  /**
   * One action in the "Linked from" heading at the foot of the rendered view, for
   * another way to look at the same links (Atlas: the neighbourhood as a graph).
   * Shown only when the document has backlinks, like the list itself.
   */
  linkedFromAction?: LinkedFromAction;
  /**
   * One more way to show the centre, the app's own, beside raw, rendered, split
   * and compare: a button in the same toolbar, and, while it is active, the app's
   * view in place of the document. The document stays open behind it; any of the
   * document's own modes, or the button again, brings it back. Controlled by the
   * app, which also says what is drawn.
   */
  appView?: AppView;
  /**
   * An app's own view of a bundle type's main file, by the type's `type`
   * (`lib/bundles.ts`): drawn in place of the raw editor while a bundle of that
   * type is open (Compare stays the kit's). A type with no view here opens its
   * main file raw, in the format its registration names, as any document of
   * that format opens.
   */
  formatViews?: Readonly<Record<string, FormatView>>;
  /**
   * An offer of text for the top of the document, shown as a line under the
   * header (a frontmatter block for a document that has none, say).
   * Asked with the open document and its active version's text on each render;
   * null offers nothing. Taking it writes into the active version as the
   * human's own edit, unsaved: the file changes only when they Save. Not asked
   * for a JSON document, nor while the app's own view is showing.
   */
  textOffer?: (doc: DocView, text: string) => TextOffer | null;
};

/** One offer under the pane's header (`DocumentPaneSlots.textOffer`). */
export type TextOffer = {
  /** A stable name, for the line's `data-offer`. */
  id: string;
  /** What the line says before the button. */
  message: ReactNode;
  /** The button's label. */
  label: string;
  /**
   * The text to put at the top of the active version, fetched when the human
   * takes the offer; null puts nothing. A throw is announced with its message.
   * Before writing, the pane asks `textOffer` again with the text as it is
   * then, and writes nothing if the offer has gone (the text changed under it).
   */
  take: () => string | null | Promise<string | null>;
};

/** What a bundle's format view is given (`DocumentPaneSlots.formatViews`). */
export type FormatViewProps = {
  doc: DocView;
  /** The bundle's folder, absolute: where its own files (`assets/`) are. */
  bundle: string;
  /** The active version's text, as the editor would show it. */
  text: string;
  /** Whether the text may be changed now (the session has not ended). */
  editable: boolean;
  /** Write new text to the active version, as typing in the editor does (debounced, and saved by Save). */
  write: (text: string) => void;
  /** Save the active version to the file, as the header's Save and ⌘S in the editor do. */
  save: () => void;
  /**
   * Listen for a file inside this bundle changing on disk (`bundle.changed`,
   * with the file's absolute path): an asset written, replaced or removed, by
   * the agent or another program. The main file's own text arrives as `text`.
   * The watcher drops the echo of the session's own acts for about 2 s, so a
   * view must not wait for its own writes to come back. Returns the unsubscribe.
   */
  onBundleChange: (listener: (file: string) => void) => () => void;
  /**
   * What the view adds to the status strip below it, in place of the text's
   * character count (a board: its items, connections and linked documents).
   * Null takes them away. Kept for this document only.
   */
  setStatus: (segments: readonly StatusSegment[] | null) => void;
  /**
   * Something the view does to its text just before any Save (the header's,
   * ⌘S, the outside-change banner's "Keep mine"): it may `write` once more,
   * and that write is what is saved. Null takes it away. A board refreshes
   * what it remembers of its cards' targets here.
   */
  beforeSave: (prepare: (() => void) | null) => void;
};

/**
 * An app's view of one bundle type's main file: a component, rendered as one
 * (its hooks are its own), keyed by the open document.
 */
export type FormatView = (props: FormatViewProps) => ReactNode;

/** An app's own centre view (`DocumentPaneSlots.appView`). */
export type AppView = {
  /** A stable name, for the view's `data-view`. */
  id: string;
  /** The button's label and tooltip. */
  label: string;
  /** The button's icon, drawn at 14 px. */
  icon: ReactNode;
  active: boolean;
  onActive: (active: boolean) => void;
  /** What the centre shows while it is active. */
  render: () => ReactNode;
};

export function DocumentPane({
  showDiff,
  editor,
  mode: modeProp,
  onMode,
  viewModeKey = DEFAULT_VIEW_MODE_KEY,
  splitView = false,
  lineNumbers = false,
  lineNumbersKey = DEFAULT_LINE_NUMBERS_KEY,
  rawExtensions,
  rawTokens,
  inlineWidgets,
  frontmatterChips,
  frontmatterTrust,
  versionDeleteWarnings,
  linkedFromAction,
  appView,
  formatViews,
  textOffer,
}: {
  showDiff?: ShowDiff | null;
  /** The editor's handle, for the app's toolbar (insert at the caret, the selection). */
  editor?: Ref<EditorHandle>;
  /** Controlled view mode, so the toolbar can read it. Absent: the pane keeps its own. */
  mode?: ViewMode;
  onMode?: (mode: ViewMode) => void;
  /** Where the raw, rendered or split choice is remembered. */
  viewModeKey?: string;
  /**
   * Offer split: the raw editor and the rendered view of the same version side by
   * side. Off by default. Off, a stored or controlled `split` is drawn as raw.
   */
  splitView?: boolean;
  /**
   * Offer a line-number gutter in the raw editor: a toggle in the header, shown
   * in raw and split (split's raw half only; the rendered half has no source
   * lines). Off by default, as split is. On, the gutter starts off until the
   * human turns it on, and their choice is remembered under `lineNumbersKey`.
   */
  lineNumbers?: boolean;
  /** Where the line-number choice is remembered. */
  lineNumbersKey?: string;
} & DocumentPaneSlots) {
  const w = useWorkspace();
  const { daemon, openDoc: doc } = w;
  const { send, writeText, flushText } = daemon;
  /** Where the view mode and line numbers are kept: the app's store, else the browser's. */
  const kept = w.storage ?? safeStorage;

  const [ownMode, setOwnMode] = useState<ViewMode>(() =>
    readViewMode(kept.getItem(viewModeKey), { split: splitView }),
  );
  const mode = modeProp ?? ownMode;
  // The line-number gutter: a viewer preference, remembered as the view mode is.
  const [numbered, setNumbered] = useState(() => readLineNumbers(kept.getItem(lineNumbersKey)));
  const toggleNumbered = () => {
    const next = !numbered;
    kept.setItem(lineNumbersKey, storedLineNumbers(next));
    setNumbered(next);
  };
  // The split's width, kept where the view mode is. The group it sizes is drawn in
  // raw and rendered too (one panel wide), so only a layout with both halves is
  // kept (`isSplitLayout`): a one-panel layout is a write nothing reads.
  const splitLayout = useDefaultLayout({
    id: SPLIT_LAYOUT_ID,
    panelIds: SPLIT_PANEL_IDS,
    storage: kept,
  });
  const keepSplit = splitLayout.onLayoutChanged;
  const onSplitLayout = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      if (isSplitLayout(layout)) keepSplit(layout, meta);
    },
    [keepSplit],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const width = usePaneWidth(rootRef);
  const splitRoom = splitFits(width);
  /**
   * A JSON document has no rendered view, frontmatter or links: it is drawn raw
   * (or compared), and the markdown-only controls are not offered. The mode
   * chosen is left as it is, so the next markdown document opens the way the
   * human last read one.
   */
  const isJson = !!doc && docFormat(doc.original) === "json";
  // An open bundle whose type the app gives a view of its own: that view, in
  // place of the raw editor. Without one, its main file opens raw.
  // Opened from its own row inside the expanded bundle (`rawMain`), the main
  // file is drawn raw: in its format's editor, with its parse check.
  const bundle = doc ? bundleOf(doc.original) : null;
  const raw = !!doc && w.rawMain === doc.original;
  const formatView =
    bundle && bundle.inner === bundle.type.main && !raw
      ? formatViews?.[bundle.type.type]
      : undefined;
  // A change inside the open bundle, handed to its view: the daemon sends every
  // surface `bundle.changed` for a file the watcher saw change inside a bundle.
  const bundleRoot = formatView ? bundle?.root : undefined;
  const { onFrame } = daemon;
  // What the format view does just before a Save.
  const prepareSave = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new document starts without the last one's.
  useEffect(() => {
    prepareSave.current = null;
  }, [doc?.slug]);
  const beforeSave = useCallback((prepare: (() => void) | null) => {
    prepareSave.current = prepare;
  }, []);
  // What the format view says in the status strip, for its own document.
  const [viewStatus, setViewStatus] = useState<{
    slug: string;
    segments: readonly StatusSegment[];
  } | null>(null);
  const viewSlug = formatView ? doc?.slug : undefined;
  const setStatus = useCallback(
    (segments: readonly StatusSegment[] | null) =>
      setViewStatus(segments && viewSlug !== undefined ? { slug: viewSlug, segments } : null),
    [viewSlug],
  );
  const onBundleChange = useCallback(
    (listener: (file: string) => void) =>
      onFrame((frame) => {
        if (frame.op !== "bundle.changed" || bundleRoot === undefined) return;
        const f = frame as { path?: unknown; file?: unknown };
        if (f.path === bundleRoot && typeof f.file === "string") listener(f.file);
      }),
    [onFrame, bundleRoot],
  );
  /**
   * What is drawn: `mode`, except a split the app does not offer or the pane
   * cannot fit, and anything but raw or compare for a JSON document.
   */
  const shownMode = shownViewMode(mode, { split: splitView, width });
  const showing: ViewMode = isJson && shownMode !== "compare" ? "raw" : shownMode;
  const setMode = (picked: ViewMode) => {
    // On a JSON document Raw is only the way out of Compare, not a preference:
    // it goes back to the stored markdown choice (drawn raw here), and nothing
    // is stored, so the next markdown document opens as it was last read.
    const m =
      isJson && picked === "raw"
        ? readViewMode(kept.getItem(viewModeKey), { split: splitView })
        : picked;
    if (m !== "compare" && !isJson) kept.setItem(viewModeKey, m);
    setOwnMode(m);
    onMode?.(m);
  };

  // ── reader mode ─────────────────────────────────────────────────────────
  // Rendered with both columns shut: derived, never stored (`reader.ts`), so the
  // toggle reads pressed however the state came about, and leaving it is just
  // reopening the columns. Judged on the mode chosen, not the one drawn: a split
  // drawn as raw is not reader mode either way.
  const { columns, setQuiet } = w;
  // A JSON document is never read rendered, so never in reader mode.
  const reader = !isJson && isReader(mode, columns.collapsed);
  const toggleReader = () => {
    const act = readerAct(mode, columns.collapsed);
    if (act.mode && act.mode !== mode) setMode(act.mode);
    for (const side of act.collapse) columns.collapse(side);
    for (const side of act.expand) columns.expand(side);
  };
  // The shell's own chrome quiets with the pane's. Said again on every change and
  // taken back when the pane goes, so the shell is never left quiet by a pane that
  // is no longer there.
  // A layout effect, so a reload in reader mode never paints the shell loud first.
  useLayoutEffect(() => {
    setQuiet(reader);
  }, [reader, setQuiet]);
  useLayoutEffect(() => () => setQuiet(false), [setQuiet]);
  /** The reader-mode fade, or nothing outside reader mode. */
  const fade = reader ? QUIET_FADE : undefined;

  const [against, setAgainst] = useState<DiffSide>("original");
  /** What the comparison is asked to bring into view (the agent's `show`). */
  const [compareFocus, setCompareFocus] = useState<CompareFocus | null>(null);
  /**
   * The human picks the side. A change the agent pointed at, still waiting for
   * its own side's comparison, is dropped: it must not fire on a later visit.
   */
  const chooseSide = (side: DiffSide) => {
    setCompareFocus(null);
    setAgainst(side);
  };
  const [naming, setNaming] = useState<VersionIntent | null>(null);
  const [noteAt, setNoteAt] = useState<At | null>(null);
  /** The link being written, while its picker is open, with the text it covers. */
  const [linking, setLinking] = useState<
    (LinkRequest & { initialQuery: string; via: LinkVia }) | null
  >(null);
  const [linkTargets, setLinkTargets] = useState<LinkTargets | null>(null);
  const [linkFailure, setLinkFailure] = useState<string | null>(null);
  /**
   * The JSON document whose problem is shown: its Save was just refused, or a
   * version that does not parse was just made active (opened or activated).
   */
  const [jsonRefused, setJsonRefused] = useState<{
    slug: string;
    why: "save" | "loaded";
    /** Where it went wrong, in the text it was found in. */
    problem: JsonProblem;
    /** The pane's text when it was found (behind the editor's, after a quick Save). */
    seen: string | undefined;
  } | null>(null);
  const { confirm, dialog } = useConfirm();

  // ── the text on screen ──────────────────────────────────────────────────
  const text = doc ? daemon.texts.get(textKey(doc.slug, doc.active)) : undefined;
  const lastShown = useRef<{ slug: string; text: string } | null>(null);
  if (doc && text !== undefined) lastShown.current = { slug: doc.slug, text };
  const shown = doc ? textToShow(doc.slug, text, lastShown.current) : undefined;
  const slug = doc?.slug;
  const active = doc?.active;

  // Where a JSON text stops parsing: once per text, not once per render.
  const jsonNow = useMemo(
    () => (isJson && shown !== undefined ? jsonProblem(shown) : null),
    [isJson, shown],
  );
  // A version that does not parse says so as soon as it is the active one
  // (opened, or activated), not only when Save is pressed: checked once per
  // version, on its own text. ONE effect decides it for each document and
  // version, whatever was shown before: a separate "another document, so
  // clear" step ran in the same commit and won, losing the notice on a
  // revisit.
  const jsonChecked = useRef<string | null>(null);
  useEffect(() => {
    if (slug === undefined || active === undefined) return;
    const key = `${slug}@${active}`;
    if (jsonChecked.current === key) return;
    if (!isJson) {
      jsonChecked.current = key;
      setJsonRefused(null);
      return;
    }
    if (text === undefined) return;
    jsonChecked.current = key;
    const problem = jsonProblem(text);
    setJsonRefused(problem ? { slug, why: "loaded", problem, seen: text } : null);
  }, [isJson, slug, active, text]);
  // The problem shows until the text parses (it follows the fix as it is
  // typed); then it is spent. Until the text on screen moves on from what it
  // was when the problem was found, the problem found is the one shown: a Save
  // pressed straight after typing is refused on the editor's text, a beat
  // before the pane's copy catches up, and that copy still parses.
  const jsonMine = jsonRefused !== null && jsonRefused.slug === slug ? jsonRefused : null;
  const jsonShown = jsonMine ? (shown === jsonMine.seen ? jsonMine.problem : jsonNow) : null;
  useEffect(() => {
    if (jsonMine && shown !== undefined && shown !== jsonMine.seen && !jsonNow)
      setJsonRefused(null);
  }, [jsonMine, shown, jsonNow]);

  // The daemon sends the text when a document is opened here; ask when it did not
  // (another viewer opened it, or this one reloaded).
  useEffect(() => {
    if (slug !== undefined && active !== undefined && text === undefined)
      send({ op: "read", doc: slug, version: active });
  }, [slug, active, text, send]);

  // Your place in one document says nothing about your place in another.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the place belongs to the document.
  const place = useMemo(() => createPlace(), [slug]);

  // ── comparing ───────────────────────────────────────────────────────────
  // Asked for whenever the document, its active version, its text or the chosen side
  // changes, so a merge refreshes what is left to take.
  const hash = doc?.hash;
  /**
   * The document the comparison's state (the mode and the side, `against`)
   * belongs to. On the render another document arrives, that state is still the
   * last one's until the reset below runs, and effects run in order: asked then,
   * the diff named the new document with the old side ("beta has no v3").
   */
  const compareSlug = useRef(slug);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active version and the text hash are triggers, not inputs.
  useEffect(() => {
    if (compareSlug.current !== slug) return;
    if (mode === "compare" && slug !== undefined) send({ op: "diff", doc: slug, against });
  }, [mode, slug, active, hash, against, send]);
  // Leaving the document leaves the comparison.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different document is the trigger.
  useEffect(() => {
    compareSlug.current = slug;
    if (mode === "compare") {
      const m = readViewMode(kept.getItem(viewModeKey), { split: splitView });
      setOwnMode(m);
      onMode?.(m);
    }
    setAgainst("original");
    setNoteAt(null);
    setLinking(null);
    setCompareFocus(null);
  }, [slug]);
  // A toast's "Show diff", or any other request from outside, opens the comparison.
  const lastShowDiff = useRef<number>(0);
  useEffect(() => {
    if (!showDiff || showDiff.seq === lastShowDiff.current) return;
    lastShowDiff.current = showDiff.seq;
    if (showDiff.doc !== slug) return;
    setAgainst(showDiff.version);
    setOwnMode("compare");
    onMode?.("compare");
  }, [showDiff, slug, onMode]);

  // ── focus ───────────────────────────────────────────────────────────────
  const editorHandle = useRef<EditorHandle | null>(null);
  const setEditor = (h: EditorHandle | null) => {
    editorHandle.current = h;
    if (typeof editor === "function") editor(h);
    else if (editor) (editor as { current: EditorHandle | null }).current = h;
  };
  // Only focus that lands on the pane ITSELF is forwarded. A press on the rendered
  // view must never arrive here, or in split the editor would take focus and
  // collapse the passage being selected: the rendered scroller is focusable by
  // script for exactly that reason (see `MarkdownView`).
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>('[data-pane="centre"]');
    if (!pane) return;
    const onFocus = (e: FocusEvent) => {
      if (e.target === pane) editorHandle.current?.focus();
    };
    pane.addEventListener("focus", onFocus);
    return () => pane.removeEventListener("focus", onFocus);
  }, []);

  // ── what the pane does for the human ─────────────────────────────────────
  const onEdit = (read: () => string) => {
    if (doc) writeText(doc, doc.active, read);
  };
  const onFlush = () => {
    if (slug) flushText(slug);
  };
  /**
   * JSON that does not parse is not saved. Checked here, against the editor's
   * own text (ahead of the daemon's while typing), so the problem is shown
   * beside the editor rather than as a refusal; the daemon checks again and
   * refuses on its own. The unsaved text stays where it is, to be fixed.
   */
  const refuseJson = (): boolean => {
    if (!doc || !isJson) return false;
    const now = editorHandle.current?.text() ?? shown;
    const problem = now === undefined ? null : jsonProblem(now);
    if (!problem) return false;
    setJsonRefused({ slug: doc.slug, why: "save", problem, seen: shown });
    return true;
  };
  const onSave = () => {
    // A missing file is saved only from its banner, which says what Save would make.
    if (!doc || doc.missing) return;
    if (formatView) prepareSave.current?.();
    flushText(doc.slug);
    if (refuseJson()) return;
    send({ op: "save", doc: doc.slug });
  };
  const onRevert = () => {
    if (!doc) return;
    // Revert discards unsaved work: a write still in its pause is dropped, not
    // sent after the revert to land on top of the file's text. Pressing Revert
    // takes focus from whatever had it, and a view that writes when focus
    // leaves (a board's note card being typed in) queues one just now. The
    // client drops it as it sends the revert.
    send({ op: "revert", doc: doc.slug });
  };
  /** Save over a missing original: the human's explicit choice, the folder included. */
  const onRecreate = () => {
    if (!doc?.missing) return;
    flushText(doc.slug);
    if (refuseJson()) return;
    send({ op: "save", doc: doc.slug, recreate: doc.missing });
  };
  // ⌘S belongs to the pane, not to the editor's focus: in the rendered view, and
  // with focus anywhere else on the page, no editor is there to claim it, and the
  // browser's own Save Page dialog opened. The raw editor keeps its own binding
  // (it flushes its buffer first) and marks the key as taken, so one press is
  // one save. Here it saves what the Save button would: a document with
  // unsaved changes, while the session is live.
  const saveKey = useRef(onSave);
  saveKey.current = onSave;
  const dirtyNow = useRef(false);
  dirtyNow.current = !!doc?.dirty && daemon.connection !== "ended";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey)
        return;
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (dirtyNow.current) saveKey.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onClose = () => doc && send({ op: "doc.close", doc: doc.slug });
  const onSelect = (s: SelectionReport) => {
    if (!doc) return;
    w.reportSelection({ doc: doc.slug, version: doc.active, ...s });
  };

  // ── writing a link ──────────────────────────────────────────────────────
  // Offered while the session is live, in every view but the comparison. With
  // the raw editor mounted (raw, split) the link is typed through it. In the
  // rendered view alone there is no editor, so the link is written the way the
  // pane writes any whole-text edit, `writeText` (the `edit` op, the human's
  // own), and the raw editor replays it into its undo history when it mounts.
  const canLink = !!doc && !isJson && daemon.connection !== "ended" && showing !== "compare";
  const editorMounted = showing === "raw" || showing === "split";

  // The rendered view's own tracking: with no editor to map a range through,
  // the pane maps it through each change to the text it shows.
  const renderedTrackers = useRef(new Set<RenderedTracked>());
  const shownBefore = useRef(shown);
  useEffect(() => {
    const prev = shownBefore.current;
    shownBefore.current = shown;
    if (prev === undefined || shown === undefined) return;
    const c = minimalChange(prev, shown);
    if (!c) return;
    for (const t of renderedTrackers.current) {
      t.from = mapThrough(t.from, c, 1);
      t.to = mapThrough(t.to, c, -1);
    }
  }, [shown]);
  const trackRendered = (from: number, to: number): LinkTracker => {
    const t: RenderedTracked = { from, to };
    renderedTrackers.current.add(t);
    return {
      range: () => ({ from: t.from, to: Math.max(t.from, t.to) }),
      release: () => {
        renderedTrackers.current.delete(t);
      },
    };
  };
  /** Links written in the rendered view since the raw editor last mounted, for its undo. */
  const replay = useRef<{ slug: string; base: string; changes: TextChange[] } | null>(null);

  const askLink = (r: LinkRequest, via: LinkVia = "editor") => {
    if (!canLink) {
      r.track.release();
      return;
    }
    // A selection that cannot be one link is refused before the picker opens,
    // rather than written as markdown that does not render as a link.
    const problem = r.kind === "wrap" ? linkTextProblem(r.quote) : null;
    if (problem) {
      r.track.release();
      w.announce("Can't link this selection", problem);
      return;
    }
    // Keys typed after `](` or `[[` before the picker opened are its first query.
    const range = r.track.range();
    const initialQuery =
      r.kind !== "wrap" && range
        ? (editorHandle.current?.text() ?? "").slice(typedFrom(r.kind, range), range.to)
        : "";
    setNoteAt(null);
    setLinking({ ...r, initialQuery, via });
  };
  /**
   * Add link from the right-click menu. With the editor mounted, offsets and
   * quote are read from it, as the shortcut does; in the rendered view alone,
   * from the text it shows, which is what its selection was mapped onto.
   */
  const askLinkAt = (at: { from: number; to: number; x: number; y: number }) => {
    const ed = editorMounted ? editorHandle.current : null;
    if (ed) {
      askLink({
        kind: "wrap",
        ...at,
        quote: ed.text().slice(at.from, at.to),
        track: ed.track("wrap", at.from, at.to),
      });
      return;
    }
    if (shown === undefined) return;
    askLink(
      {
        kind: "wrap",
        ...at,
        quote: shown.slice(at.from, at.to),
        track: trackRendered(at.from, at.to),
      },
      "rendered",
    );
  };
  // Whatever ends the picker (a choice, a close, another document, the session
  // ending) stops its range being tracked.
  useEffect(() => () => linking?.track.release(), [linking]);
  // The targets are asked for each time the picker opens, so a document added a
  // moment ago is there and the relations are the ones in use now.
  const { request } = daemon;
  const linkingOpen = linking !== null;
  useEffect(() => {
    if (!linkingOpen || slug === undefined) return;
    let current = true;
    setLinkTargets(null);
    setLinkFailure(null);
    request({ op: "link.targets", doc: slug })
      .then((frame) => {
        if (current) setLinkTargets(frame as unknown as LinkTargets);
      })
      .catch((e: unknown) => {
        if (current) setLinkFailure(e instanceof Error ? e.message : String(e));
      });
    return () => {
      current = false;
    };
  }, [linkingOpen, slug, request]);
  // What links here, for the foot of the rendered view. Asked for when the
  // document changes and again whenever the snapshot does (an edit or a save in
  // another document can add or remove one), a beat later so a burst of
  // snapshots is one ask. The daemon re-reads only the documents that changed, so
  // asking is cheap; an answer equal to the last is not set again.
  const [backlinks, setBacklinks] = useState<BacklinksData | null>(null);
  const lastBacklinks = useRef("");
  const readingRendered = showing !== "raw";
  const live = daemon.connection === "open";
  const snapshot = w.state;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot is the trigger to ask again.
  useEffect(() => {
    if (slug === undefined || !readingRendered || !live) return;
    let current = true;
    const t = setTimeout(() => {
      request({ op: "link.backlinks", doc: slug })
        .then((frame) => {
          if (!current) return;
          const {
            op: _op,
            requestId: _rid,
            ...data
          } = frame as unknown as BacklinksData & {
            op: string;
            requestId?: unknown;
          };
          const key = JSON.stringify(data);
          if (key === lastBacklinks.current) return;
          lastBacklinks.current = key;
          setBacklinks(data);
        })
        // The list is a convenience: a refusal (the document went) leaves it as it was.
        .catch(() => {});
    }, BACKLINKS_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [slug, readingRendered, live, request, snapshot]);
  // What the document's embeds show (`![alt](x.png)`): the targets the rendered
  // view found, asked about when they change and again on a new snapshot (an
  // image added, replaced or removed), a beat later, as the backlinks are. An
  // answer equal to the last is not set again, so the images do not redraw.
  const [embedTargets, setEmbedTargets] = useState<string[]>([]);
  const embedKey = embedTargets.join("\n");
  const onEmbedTargets = useCallback((targets: string[]) => {
    setEmbedTargets((was) => (was.join("\n") === targets.join("\n") ? was : targets));
  }, []);
  const [embedViews, setEmbedViews] = useState<{
    doc: string;
    views: ReadonlyMap<string, EmbedView>;
  } | null>(null);
  const lastEmbeds = useRef("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new snapshot is the trigger to ask again.
  useEffect(() => {
    if (slug === undefined || !readingRendered || !live || embedKey === "") return;
    let current = true;
    const t = setTimeout(() => {
      request({ op: "link.embeds", doc: slug, targets: embedKey.split("\n") })
        .then((frame) => {
          if (!current) return;
          const { embeds } = frame as unknown as { embeds: EmbedView[] };
          const key = `${slug}\0${JSON.stringify(embeds)}`;
          if (key === lastEmbeds.current) return;
          lastEmbeds.current = key;
          setEmbedViews({ doc: slug, views: new Map(embeds.map((e) => [e.target, e])) });
        })
        // A refusal (the document went) leaves the placeholders as they were.
        .catch(() => {});
    }, BACKLINKS_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [slug, readingRendered, live, request, snapshot, embedKey]);
  const { imageUrl } = daemon;
  const embeds = useMemo<EmbedSource>(
    () => ({
      views: embedViews && embedViews.doc === slug ? embedViews.views : NO_EMBEDS,
      // The 1024 px thumbnail for reading: a photograph is megabytes, and the
      // column is narrower than that. A GIF is drawn from the file, so it
      // still moves; the viewer always shows the file.
      src: (v) =>
        v.type === "image/gif"
          ? imageUrl(v.path, { stamp: v.stamp })
          : imageUrl(v.path, { stamp: v.stamp, thumb: 1024 }),
      open: (path) => send({ op: "open", path }),
    }),
    [embedViews, slug, imageUrl, send],
  );
  // The document's profile, for the frontmatter header: its kind's label and
  // its warnings. Read by the daemon from the ACTIVE VERSION, as the agent's
  // `profile` and `profile-check` verbs read it, so the chip and the agent
  // agree about the text on screen. Asked again, a beat later, after a snapshot
  // (a save, another version made active), after this viewer's own edit is
  // sent (`texts`: a plain edit sends no snapshot), and after the daemon says
  // something on disk changed (`context.changed`: a profile file saved, here or
  // outside). A JSON document has no frontmatter to match, and is not asked about.
  const [profile, setProfile] = useState<DocumentProfile | null>(null);
  const lastProfile = useRef("");
  const [diskChanged, setDiskChanged] = useState(0);
  const onDaemonFrame = daemon.onFrame;
  useEffect(
    () =>
      onDaemonFrame((f) => {
        if (f.op === "context.changed") setDiskChanged((n) => n + 1);
      }),
    [onDaemonFrame],
  );
  const edits = daemon.texts;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each cue (snapshot, edit, disk change) is a trigger to ask again.
  useEffect(() => {
    if (slug === undefined || isJson || !readingRendered || !live) return;
    let current = true;
    const t = setTimeout(() => {
      request({ op: "profile", doc: slug })
        .then((frame) => {
          if (!current) return;
          const {
            op: _op,
            requestId: _rid,
            ...data
          } = frame as unknown as DocumentProfile & { op: string; requestId?: unknown };
          const key = JSON.stringify(data);
          if (key === lastProfile.current) return;
          lastProfile.current = key;
          setProfile(data);
        })
        // A convenience, like the backlinks: a refusal leaves the header as it was.
        .catch(() => {});
    }, BACKLINKS_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [slug, isJson, readingRendered, live, request, snapshot, edits, diskChanged]);
  // "Ask the agent to fix": a chat message from the human, with the document
  // pointed at, exactly as the composer's send would post it. Nothing else
  // moves: the chat is not opened, no focus is taken, the selection stays.
  const askProfileFix = (text: string, p: DocumentProfile) =>
    // The kit's button (`fix`), not the composer: it carries no held refs.
    send({ op: "say", text, withSelection: false, via: "fix", about: { path: p.path } });
  /**
   * A link followed from this document (a click in the rendered view, a
   * Mod-click in the raw editor): one that is only a `#heading` stays here and
   * goes to the heading in the text on screen, without the daemon; any other
   * goes to the daemon, which opens it and says where its heading is.
   */
  const followLink = (target: string) => {
    if (!doc) return;
    // The rendered view's rule (a Mod-click in the raw editor gets here with
    // any target): a web or mail address opens outward, never at the daemon.
    const act = rawLinkAct(target);
    if (act.kind === "outward") window.open(act.href, "_blank", "noopener,noreferrer");
    else if (act.kind === "jump") jumpToHeading(target.slice(1));
    else if (act.kind === "follow") send({ op: "link.open", target, doc: doc.slug });
    else w.announce("That link doesn't open here", `${target} is not a document or a web address.`);
  };
  /** The heading `anchor` (as written) names in the text on screen, revealed as a followed link's is. */
  const jumpToHeading = (anchor: string) => {
    if (!doc || shown === undefined || doc.active === undefined) return;
    const name = decodePath(anchor);
    const m = findHeading(headingsOf(shown), name);
    if (!m) {
      w.announce("Heading not found", `No heading “${name}” in ${doc.name}.`);
      return;
    }
    const line = lineRange(shown, m.heading.line);
    w.requestReveal({
      doc: doc.slug,
      version: doc.active,
      from: line.from,
      to: line.from,
      heading: line,
    });
  };
  /** The link picker's second step: one document's headings, asked for when wanted. */
  const headingsFor = async (path: string): Promise<HeadingOffer[]> => {
    if (slug === undefined) return [];
    const frame = (await daemon.request({
      op: "link.headings",
      doc: slug,
      path,
    })) as unknown as LinkHeadings;
    return frame.headings;
  };
  const openBacklink = (b: BacklinkView) => {
    const at = { from: b.from, to: b.to };
    if (w.openAt) w.openAt(b.source, at);
    else send({ op: "open", path: b.source });
  };
  // The session ending, or the view the picker writes through going, closes it:
  // nothing could be written.
  const linkVia = linking?.via;
  useEffect(() => {
    if (
      !canLink ||
      (linkVia === "editor" && !editorMounted) ||
      (linkVia === "rendered" && editorMounted)
    )
      setLinking(null);
  }, [canLink, linkVia, editorMounted]);
  /**
   * Closing without a choice. In `complete` and `wiki` the picker took the
   * keystrokes that followed the trigger, so what is in its search box goes
   * into the text where they would have landed: `[link](http`, Escape, keeps
   * `http`.
   */
  const closeLink = (query: string) => {
    const l = linking;
    setLinking(null);
    const ed = editorHandle.current;
    const range = l?.track.range();
    if (l && ed && range && l.kind !== "wrap") {
      const start = typedFrom(l.kind, range);
      if (ed.text().slice(start, range.to) !== query)
        ed.replaceRange(start, range.to, query, insertionGuard(l.kind, range, ""));
    }
    ed?.focus();
  };
  const chooseLink = (
    kind: LinkKind,
    quote: string,
    insert: string,
    l: LinkRequest & { via: LinkVia },
  ) => {
    setLinking(null);
    if (l.via === "rendered") {
      chooseRendered(quote, insert, l);
      return;
    }
    const ed = editorHandle.current;
    const range = l.track.range();
    // Through the editor, as the human's own edit: the daemon client writes it
    // to the active version like any keystroke.
    const ok =
      !!ed &&
      !!range &&
      (kind !== "wrap" || range.to - range.from === quote.length) &&
      ed.replaceRange(range.from, range.to, insert, insertionGuard(kind, range, quote));
    if (!ok) {
      ed?.focus();
      w.announce(
        "Link not added",
        "The text changed while the picker was open. Select it and try again.",
      );
    }
  };

  /**
   * The rendered view's write: the same guard (the selection must still stand
   * at its mapped range), then the whole text through `writeText`, sent at once.
   * The change is kept for the raw editor's undo history.
   */
  const chooseRendered = (quote: string, insert: string, l: LinkRequest) => {
    const range = l.track.range();
    const now = shownBefore.current;
    if (
      !doc ||
      !range ||
      now === undefined ||
      range.to - range.from !== quote.length ||
      now.slice(range.from, range.to) !== quote
    ) {
      w.announce(
        "Link not added",
        "The text changed while the picker was open. Select it and try again.",
      );
      return;
    }
    const change = { from: range.from, to: range.to, insert };
    const next = applyChanges(now, [change]);
    if (!writeText(doc, doc.active, next)) {
      w.announce("Link not added", "Only the active version can be edited.");
      return;
    }
    flushText(doc.slug);
    const r = replay.current;
    replay.current =
      r && r.slug === doc.slug && applyChanges(r.base, r.changes) === now
        ? { ...r, changes: [...r.changes, change] }
        : { slug: doc.slug, base: now, changes: [change] };
  };

  // ── an app's offer of text for the top (`textOffer`) ─────────────────────
  // Taken, the text goes in as the human's own edit: through the editor when
  // it is mounted (one undo step, the caret after it), otherwise through
  // `writeText` as the rendered view's links are, kept for the editor's undo.
  // Never to the file: Save puts it there.
  const [taking, setTaking] = useState(false);
  /** What the answer is checked against when it arrives, a render or more later. */
  const offerNow = useRef({ doc, editorMounted, textOffer });
  offerNow.current = { doc, editorMounted, textOffer };
  const takeOffer = (offer: TextOffer) => {
    if (!doc || taking) return;
    const at = { slug: doc.slug, active: doc.active };
    setTaking(true);
    void (async () => {
      let insert: string | null;
      try {
        insert = await offer.take();
      } catch (e) {
        w.announce(`Not done: ${offer.label}`, e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setTaking(false);
      }
      const { doc: now, editorMounted: mounted, textOffer: ask } = offerNow.current;
      if (!insert || !now || now.slug !== at.slug || now.active !== at.active) return;
      const ed = mounted ? editorHandle.current : null;
      const before = ed ? ed.text() : shownBefore.current;
      // The text may have changed while the offer was fetched: asked again, it still stands.
      if (before === undefined || ask?.(now, before)?.id !== offer.id) return;
      if (ed) {
        if (!ed.replaceRange(0, 0, insert)) return;
      } else {
        const change = { from: 0, to: 0, insert };
        if (!writeText(now, now.active, applyChanges(before, [change]))) return;
        const r = replay.current;
        replay.current =
          r && r.slug === now.slug && applyChanges(r.base, r.changes) === before
            ? { ...r, changes: [...r.changes, change] }
            : { slug: now.slug, base: before, changes: [change] };
      }
      flushText(now.slug);
    })();
  };

  // ── images pasted or dropped in (kit-image-paste) ────────────────────────
  // Each file is sent to the daemon, which writes it into `images/` beside the
  // document and answers with the path to embed. The embeds then go in at the
  // tracked range as ONE edit through the editor, so one Undo takes them all
  // back; the files stay, and the link check lists any nothing links to or embeds. A
  // refusal (too large, SVG, not an image inside) is a quiet notice, and no
  // embed is written for it.
  const { importImage } = daemon;
  const takeImages = (r: ImageArrival) => {
    if (!doc || isJson || daemon.connection === "ended") {
      r.track.release();
      return;
    }
    const docPath = doc.original;
    const at = new Date();
    void (async () => {
      const embeds: string[] = [];
      const refused: string[] = [];
      /** Images the import settings would have converted, but left as they came, and why. */
      const left: string[] = [];
      for (const f of r.files) {
        const name = r.how === "paste" ? pastedImageName(at, f.type) : f.name;
        const got = await importImage(f, { doc: docPath, how: r.how, name });
        if (got.ok && got.href) {
          embeds.push(embedFor(got.path, got.href));
          if (got.kept && got.note)
            left.push(`${r.how === "paste" ? "The pasted image" : f.name} was ${got.note}.`);
        } else
          refused.push(
            `${r.how === "paste" ? "The pasted image" : f.name} was not added: ${got.ok ? "the workspace gave no path for it" : got.error}`,
          );
      }
      const range = r.track.range();
      r.track.release();
      if (embeds.length > 0) {
        const ed = editorHandle.current;
        const insert = embedsText(embeds);
        // The selection a paste replaces must still be there; when it is not,
        // the embeds go in after where it was, replacing nothing.
        const ok =
          !!ed &&
          !!range &&
          (ed.replaceRange(range.from, range.to, insert, { at: range.from, text: r.quote }) ||
            ed.replaceRange(range.to, range.to, insert));
        if (!ok)
          w.announce(
            embeds.length === 1 ? "Image saved, not embedded" : "Images saved, not embedded",
            "The editor closed while they were sent. They are in the images folder beside the document; embed them from the link picker.",
          );
      }
      if (refused.length > 0)
        w.announce(
          refused.length === r.files.length
            ? r.files.length === 1
              ? "Image not added"
              : "Images not added"
            : "Some images not added",
          refused.join(" "),
        );
      if (left.length > 0)
        w.announce(
          left.length === 1 ? "Image not converted" : "Images not converted",
          left.join(" "),
        );
    })();
  };
  // ── rows dragged in from the sidebar (kit-tree-drag-into-document) ────────
  // The daemon says what each row writes: an image in reach is embedded,
  // relative to the document, its sidecar title as the alt; one in another
  // part of the context is refused in words. Nothing is copied or moved. The
  // embeds go in at the drop point as ONE edit, so one Undo takes them back.
  // A document row writes a link to it, its title as the text (the user's
  // choice, 2026-10-06), by the same rules. A folder or a set writes nothing.
  const takeRows = (r: RowArrival) => {
    const paths = r.rows
      .filter((row) => row.kind === "image" || row.kind === "document")
      .map((row) => row.path);
    if (!doc || isJson || daemon.connection === "ended" || paths.length === 0) {
      r.track.release();
      return;
    }
    const onlyImages = r.rows.every((row) => row.kind !== "document");
    const notEmbedded = (n: number) =>
      onlyImages ? (n === 1 ? "Image not embedded" : "Images not embedded") : "Not inserted";
    request({ op: "link.drop", doc: doc.slug, paths })
      .then((frame) => {
        const { links } = frame as unknown as { links: DroppedLink[] };
        const range = r.track.range();
        r.track.release();
        const embeds: string[] = [];
        const refused: string[] = [];
        for (const l of links) {
          if ("refused" in l) refused.push(l.refused);
          else embeds.push(droppedEmbed(l));
        }
        if (embeds.length > 0) {
          const ed = editorHandle.current;
          if (!ed || !range || !ed.replaceRange(range.from, range.to, embedsText(embeds)))
            w.announce(
              notEmbedded(embeds.length),
              onlyImages
                ? "The editor closed before the embed could go in. Drop the image again."
                : "The editor closed before the text could go in. Drop it again.",
            );
        }
        if (refused.length > 0) w.announce(notEmbedded(refused.length), refused.join(" "));
      })
      .catch((e: unknown) => {
        r.track.release();
        w.announce(notEmbedded(paths.length), e instanceof Error ? e.message : String(e));
      });
  };
  /**
   * An image pasted or dropped on the rendered view: refused with a hint. It is
   * for reading, and pastes no text either; the caret that says where an embed
   * goes is the raw editor's. Taking the drop also keeps the browser from
   * leaving the app to show the file.
   */
  const hintRaw = () =>
    w.announce(
      "Paste images in the raw view",
      "The rendered view is for reading. Put the caret in the raw text (Raw, or the left half of Split) where the image belongs, and paste or drop it there.",
    );
  const renderedImageEvents = canLink
    ? {
        onPaste: (e: React.ClipboardEvent) => {
          if (clipboardImages(e.clipboardData).length === 0) return;
          e.preventDefault();
          hintRaw();
        },
        onDragOver: (e: React.DragEvent) => {
          if (Array.from(e.dataTransfer.types).includes("Files") || carriesRows(e.dataTransfer))
            e.preventDefault();
        },
        onDrop: (e: React.DragEvent) => {
          // An image row from the sidebar is hinted at as a dropped image file is.
          if (carriesRows(e.dataTransfer)) {
            e.preventDefault();
            if (readRowDrag(e.dataTransfer)?.some((r) => r.kind === "image")) hintRaw();
            return;
          }
          if (!Array.from(e.dataTransfer.types).includes("Files")) return;
          e.preventDefault();
          if (Array.from(e.dataTransfer.files).some(isImageLike)) hintRaw();
        },
      }
    : {};

  const stats = useDebouncedStats(shown);
  const now = useNow();
  const current = doc?.versions.find((v) => v.n === doc.active);
  const segments: StatusSegment[] = doc
    ? [
        { label: "Version", value: versionSummary(current, doc.active) },
        { label: "Author", value: current?.by === "agent" ? "Agent" : "You", priority: "low" },
        {
          label: "Updated",
          value: current ? relativeTime(Date.parse(current.createdAt), now) : "-",
          priority: "low",
        },
        { value: saveState(doc), loud: readerStaysLoud("status", doc) },
        // Words say nothing about data.
        ...(isJson ? [] : [{ label: "Words", value: stats.words.toLocaleString() }]),
        // A format view says what its document holds in its own terms.
        ...(formatView && viewStatus?.slug === doc.slug
          ? viewStatus.segments
          : [
              {
                label: "Characters",
                value: stats.characters.toLocaleString(),
                priority: "low" as const,
              },
            ]),
      ]
    : [];

  const pendingNote = noteAt && noteAt.from < noteAt.to ? noteAt : null;
  // The notes the views paint: those the Notes panel lists. A resolved note is
  // listed while the panel shows resolved notes, or while it is the chosen one.
  const { focusedNote, showResolvedNotes } = w;
  const docNotes = doc?.notes;
  const paintedNotes = useMemo(
    () =>
      showResolvedNotes || !docNotes
        ? docNotes
        : docNotes.filter((n) => !n.resolved || n.id === focusedNote),
    [docNotes, showResolvedNotes, focusedNote],
  );
  const revealHere =
    doc && w.reveal && w.reveal.doc === doc.slug && w.reveal.version === doc.active
      ? {
          from: w.reveal.from,
          to: w.reveal.to,
          seq: w.reveal.seq,
          ...(w.reveal.heading ? { heading: w.reveal.heading } : {}),
        }
      : null;

  // The raw editor selects and shows a revealed range itself (in split too, and
  // the rendered half follows its scroll through the place). The rendered view
  // alone has no selection to move, so a reveal there scrolls it to the range's
  // line, by reporting that line to the place the two views share, and is spent.
  // It is marked for a moment too, since nothing is selected to say which passage.
  const { revealApplied } = w;
  /**
   * A passage marked for a moment. `agent` marks one the agent pointed at, which
   * the raw editor marks too (instead of selecting it); a reveal's mark is the
   * rendered view's alone, since the editor selects a reveal.
   */
  const [flash, setFlash] = useState<{
    from: number;
    to: number;
    seq: number;
    agent?: boolean;
  } | null>(null);
  const flashSeq = useRef(0);
  useEffect(() => {
    if (showing !== "rendered" || !revealHere || shown === undefined) return;
    place.report("reveal", lineAt(shown, revealHere.from));
    // A heading is marked by its line; the reveal itself is only its caret.
    const mark = revealHere.heading ?? revealHere;
    setFlash({ from: mark.from, to: mark.to, seq: ++flashSeq.current });
    revealApplied(revealHere.seq);
  }, [showing, revealHere, shown, place, revealApplied]);
  // Spent once it has shown, so a rendered view mounted later does not mark it again.
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  // ── the agent pointing (`show`) ─────────────────────────────────────────
  // The daemon makes the document the open one first, then says where to look.
  // Held until that document is the one here: the snapshot that opens it can
  // arrive a render after the frame. A change goes to the comparison against
  // the side its hunk was numbered in; a passage is scrolled to and marked in
  // the view on screen, or on its line in compare.
  //
  // POINTING IS NOT CHOOSING. Unlike a search result or a note, the agent's
  // passage is never selected and never takes focus: the human may be typing in
  // the chat, and a selection in a focused editor would turn their next keys
  // into a replacement of the passage. Their selection and the chat's context
  // stay what they were.
  const [pointed, setPointed] = useState<(ShowTarget & { seq: number }) | null>(null);
  const pointSeq = useRef(0);
  useEffect(
    () =>
      onFrame((frame) => {
        if (frame.op !== "show") return;
        const { op: _op, ...target } = frame as { op: "show" } & ShowTarget;
        setPointed({ ...target, seq: ++pointSeq.current });
      }),
    [onFrame],
  );
  const { announce } = w;
  useEffect(() => {
    if (!pointed || slug !== pointed.doc) return;
    if ("hunk" in pointed) {
      setPointed(null);
      setAgainst(pointed.against);
      setOwnMode("compare");
      onMode?.("compare");
      setCompareFocus({ seq: pointed.seq, hunk: pointed.hunk, against: pointed.against });
      return;
    }
    // The active version's own text, not a stand-in kept from another version.
    if (text === undefined) return;
    setPointed(null);
    // Another version became active before the passage landed: its offsets were
    // for the old text, so the quote is found again in this one, or the chat's
    // line is corrected rather than left claiming something was shown.
    const at = pointedRange(pointed, active ?? 0, text);
    if (!at) {
      announce(
        "Not shown",
        `The passage the agent pointed at is not in v${active}: another version became active first.`,
      );
      return;
    }
    const { from, to } = at;
    if (showing === "compare") {
      setCompareFocus({ seq: pointed.seq, line: lineAt(text, from) - 1 });
      return;
    }
    if (showing === "rendered") place.report("reveal", lineAt(text, from));
    setFlash({ from, to, seq: ++flashSeq.current, agent: true });
  }, [pointed, slug, active, text, showing, onMode, announce, place]);

  // Last in the header, beside the view modes, whether or not a document is open:
  // reader mode is the columns as much as the view, and the way out must be where
  // the way in was. With a document it wraps with the view modes, never alone.
  const readerToggle = (
    <button
      type="button"
      onClick={toggleReader}
      aria-pressed={reader}
      aria-label={READER_LABEL[reader ? "leave" : "enter"]}
      title={READER_LABEL[reader ? "leave" : "enter"]}
      data-slot="reader-toggle"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm outline-none",
        "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
        !doc && "ml-auto",
        reader ? "bg-surface-raised text-ink" : "text-ink-faint",
        fade,
      )}
    >
      <GlassesIcon aria-hidden className="size-3.5" />
    </button>
  );
  const appActive = !!appView?.active;
  const offer =
    textOffer && doc && !isJson && !appActive && shown !== undefined ? textOffer(doc, shown) : null;
  // Only where the raw editor is drawn and numbers would be its choice: not in
  // the rendered view (no source lines), not for JSON (always numbered), not
  // over an app's own view.
  const numbersToggle =
    lineNumbers && doc && !isJson && !formatView && !appActive && hasEditor(showing) ? (
      <button
        type="button"
        // A press with the pointer leaves focus where it was, so the caret stays
        // in the editor and the next key types there. The keyboard still reaches
        // the button by Tab and works it with Enter or Space.
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleNumbered}
        aria-pressed={numbered}
        aria-label={LINE_NUMBERS_LABEL}
        title={numbered ? `${LINE_NUMBERS_LABEL}: on` : `${LINE_NUMBERS_LABEL}: off`}
        data-slot="line-numbers-toggle"
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm outline-none",
          "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
          numbered ? "bg-surface-raised text-ink" : "text-ink-faint",
          fade,
        )}
      >
        <ListOrderedIcon aria-hidden className="size-3.5" />
      </button>
    ) : null;
  const appViewButton = appView ? (
    <button
      type="button"
      onClick={() => appView.onActive(!appActive)}
      aria-pressed={appActive}
      aria-label={appView.label}
      title={appActive ? `${appView.label}: back to the document` : appView.label}
      data-slot="app-view-toggle"
      className={cn(
        "flex size-6 items-center justify-center rounded-sm text-ink-faint outline-none",
        "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
        appActive && "bg-bg text-ink shadow-sm",
      )}
    >
      {appView.icon}
    </button>
  ) : null;

  return (
    <div ref={rootRef} data-reader={reader || undefined} className="flex min-h-0 flex-1 flex-col">
      <ActiveVersionToast doc={doc} announce={w.announce} />
      {/* QUIETER, NOT GONE in reader mode. The header and the status strip fade
          back until the pointer or the keyboard focus reaches them. Hiding them
          would take Save, the version and "Unsaved" out of reach, and a reader
          mode that loses an edit is worse than one that shows a bar. The header
          wraps rather than clips, so the toggle is reachable at any width. */}
      <div
        className={cn(
          "flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1",
          // The joiner does not resolve conflicts, so one border colour or the other.
          reader ? `${QUIET_GROUP} border-transparent` : "border-edge",
        )}
      >
        {doc ? (
          <>
            <div className={cn("flex min-w-0 items-center gap-2", fade)}>
              <VersionMenu
                versions={doc.versions}
                active={doc.active}
                onActivate={(n) => {
                  // An edit still in its pause belongs to the version it was
                  // typed in: the client sends it first (`FLUSH_FIRST`).
                  send({ op: "activate", doc: doc.slug, version: n });
                }}
                onCompare={(n) => {
                  if (daemon.connection === "ended") return;
                  chooseSide(n);
                  setMode("compare");
                }}
                onNewVersion={setNaming}
                onReveal={(n) => send({ op: "reveal.version", doc: doc.slug, version: n })}
                onDelete={async (n) => {
                  const v = doc.versions.find((x) => x.n === n);
                  // Asked, because this removes a FILE. The version's own text is
                  // the only copy of whatever was tried in it: the original on disk
                  // and the active version both survive, but what was written here
                  // does not. Anything of the app's that goes with it is named by
                  // the app's lines: the daemon lets the human's delete through
                  // because this is where that is confirmed.
                  const ok = await confirm({
                    title: `Delete ${v?.label?.trim() ? `“${v.label.trim()}”` : `v${n}`}?`,
                    message: `v${n} and its file are removed from this session. The file on disk and the version you are editing are untouched.`,
                    warning: [
                      "Anything written only in this version is lost.",
                      ...(versionDeleteWarnings?.(doc, n) ?? []),
                    ]
                      .filter(Boolean)
                      .join(" "),
                    confirmLabel: "Delete",
                    confirmClassName: "bg-danger text-bg hover:bg-danger/90",
                  });
                  if (ok) send({ op: "version.delete", doc: doc.slug, version: n });
                }}
              />
              <Separator orientation="vertical" className="my-2 shrink-0" />
              {formatView && bundle?.type.icon ? (
                // A bundle drawn in its app's own view: its type's icon, as its row has.
                <span
                  aria-hidden
                  data-slot="format-icon"
                  className="flex size-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5"
                >
                  {bundle.type.icon}
                </span>
              ) : isJson ? (
                <FileBracesIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
              ) : (
                <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
              )}
              <span className="truncate text-sm text-ink" title={doc.original}>
                {doc.name}
              </span>
              {formatView && bundle && (
                // What kind of thing this is, as the type names one: `canvas`.
                <span
                  data-slot="format-chip"
                  className="shrink-0 rounded-sm bg-surface-raised px-1.5 py-px font-mono text-[10.5px] text-ink-dim"
                >
                  {bundle.type.label}
                </span>
              )}
            </div>
            <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={onRevert}
                disabled={
                  (!doc.dirty && !doc.outsideChanged) ||
                  !!doc.missing ||
                  daemon.connection === "ended"
                }
                title="Take the file on disk back over your edits"
                className={cn("h-7 gap-1.5 px-2 text-xs", fade)}
              >
                <UndoDotIcon className="size-3.5" />
                Revert
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSave}
                disabled={!doc.dirty || daemon.connection === "ended"}
                title={`Save v${doc.active} to ${doc.name}, the file in your folder (⌘S)`}
                className={cn("h-7 gap-1.5 px-2 text-xs", !readerStaysLoud("save", doc) && fade)}
              >
                <SaveIcon className="size-3.5" />
                Save
              </Button>
              <div
                role="toolbar"
                aria-label="How to show this document"
                className={cn("flex items-center gap-0.5 rounded-md bg-surface-raised p-0.5", fade)}
              >
                {MODE_BUTTONS.filter(
                  ({ mode: m }) =>
                    (m !== "split" || splitView) &&
                    // JSON is raw text or a comparison; there is nothing to render.
                    (!isJson || m === "raw" || m === "compare"),
                ).map(({ mode: m, label: modeLabel, icon: Icon }) => {
                  // A bundle in its app's own view: "raw" is that view, named
                  // for the type ("Canvas"), with the type's icon.
                  const ownView = m === "raw" && formatView && bundle ? bundle.type : null;
                  const label = ownView
                    ? ownView.label.charAt(0).toUpperCase() + ownView.label.slice(1)
                    : modeLabel;
                  // Disabled before the click, and the tooltip says why, so the
                  // human is not left to guess what would make it work.
                  const noRoom = m === "split" && !splitRoom;
                  // The comparison is asked of the daemon, which has gone.
                  const ended = m === "compare" && daemon.connection === "ended";
                  // One version that matches its file: nothing to compare.
                  const noCompare = m === "compare" && nothingToCompare(doc);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        if (appActive) appView?.onActive(false);
                        setMode(m);
                      }}
                      disabled={noRoom || ended || noCompare}
                      aria-pressed={!appActive && showing === m}
                      aria-label={label}
                      title={
                        noRoom
                          ? SPLIT_TOO_NARROW
                          : ended
                            ? "The session has ended, so there is nothing to compare"
                            : noCompare
                              ? NOTHING_TO_COMPARE
                              : label
                      }
                      className={cn(
                        "flex size-6 items-center justify-center rounded-sm text-ink-faint outline-none",
                        "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-faint",
                        !appActive && showing === m && "bg-bg text-ink shadow-sm",
                      )}
                    >
                      {ownView?.icon ? (
                        <span
                          aria-hidden
                          className="flex size-3.5 items-center justify-center [&>svg]:size-3.5"
                        >
                          {ownView.icon}
                        </span>
                      ) : (
                        <Icon aria-hidden className="size-3.5" />
                      )}
                    </button>
                  );
                })}
                {appViewButton}
              </div>
              {numbersToggle}
              {!isJson && readerToggle}
            </div>
          </>
        ) : (
          <span className={cn("text-xs font-medium tracking-wide text-ink-dim uppercase", fade)}>
            Document
          </span>
        )}
        {!doc && appViewButton && (
          <div
            role="toolbar"
            aria-label="How to show the centre"
            className={cn(
              "ml-auto flex items-center gap-0.5 rounded-md bg-surface-raised p-0.5",
              fade,
            )}
          >
            {appViewButton}
          </div>
        )}
        {!doc && readerToggle}
      </div>
      {offer && (
        <div
          data-slot="text-offer"
          data-offer={offer.id}
          className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface-raised/60 px-3 py-1.5 text-xs text-ink-dim"
        >
          <span>{offer.message}</span>
          <button
            type="button"
            onClick={() => takeOffer(offer)}
            disabled={taking || daemon.connection === "ended"}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:no-underline"
          >
            {offer.label}
          </button>
        </div>
      )}
      {!appActive && doc?.missing && (
        <div
          role="alert"
          data-slot="file-gone"
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-attention/40 bg-attention/10 px-3 py-1.5 text-xs text-ink"
        >
          {/* Not dirty and not "changed": there is no file to differ from. The text
              and its versions are still in the session, which is the reassurance
              the sentence leads with; Save brings the file back only from here,
              and says when it would make the folder too. */}
          <span className="min-w-0 flex-1">
            {doc.missing === "folder"
              ? "This file and its folder are gone from disk. Your text and its versions are still here."
              : "This file is gone from disk. Your text and its versions are still here."}
          </span>
          <button
            type="button"
            onClick={onRecreate}
            disabled={daemon.connection === "ended"}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline disabled:opacity-50"
          >
            {doc.missing === "folder" ? "Save, making the folder again" : "Save to recreate it"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={daemon.connection === "ended"}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline disabled:opacity-50"
          >
            Close
          </button>
        </div>
      )}
      {!appActive && doc?.outsideChanged && !doc.missing && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-attention/40 bg-attention/10 px-3 py-1.5 text-xs text-ink"
        >
          {/* The sentence has to match the situation: a session reopened where the
              file had moved on can have an active version with no edits at all, and
              claiming edits the human did not make makes the next warning distrusted
              too. */}
          <span className="min-w-0 flex-1">
            {doc.dirty
              ? "This file changed on disk while you have unsaved edits."
              : "This file changed on disk since this version was made."}
          </span>
          {/* The difference comes first, because it is what the other two buttons
              need you to know: each of them discards something. */}
          <button
            type="button"
            onClick={() => {
              chooseSide("original");
              setMode("compare");
            }}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
          >
            See the difference
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
          >
            Keep mine
          </button>
          <button
            type="button"
            onClick={onRevert}
            className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
          >
            Take the file's
          </button>
        </div>
      )}
      {!appActive && doc && jsonShown && (
        <div
          role="alert"
          data-slot="json-refused"
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-danger/40 bg-danger/10 px-3 py-1.5 text-xs text-ink"
        >
          {/* Says what was refused and that nothing is lost, then where and why:
              the line and column are the way to the fix. */}
          <span className="min-w-0 flex-1">
            {jsonMine?.why === "loaded"
              ? `v${doc.active} is not valid JSON, so it will not save until it parses.`
              : "Not saved: this is not valid JSON."}{" "}
            Line {jsonShown.line}, column {jsonShown.column}: {sentence(jsonShown.problem)}
            {jsonMine?.why === "loaded" ? "" : " Your text is kept here."}
          </span>
          {showing === "raw" && (
            <button
              type="button"
              onClick={() =>
                w.requestReveal({
                  doc: doc.slug,
                  version: doc.active,
                  from: jsonShown.offset,
                  to: jsonShown.offset,
                })
              }
              className="rounded-sm px-1.5 py-0.5 font-medium text-ink underline-offset-2 hover:underline"
            >
              Go to the problem
            </button>
          )}
        </div>
      )}
      {appView && appActive ? (
        // The app's own view, in place of the document; the document stays open
        // behind it, and its mode button brings it back.
        <div data-slot="app-view" data-view={appView.id} className="flex min-h-0 flex-1 flex-col">
          {appView.render()}
        </div>
      ) : !doc ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon />
            </EmptyMedia>
            <EmptyTitle>No document open</EmptyTitle>
            <EmptyDescription>
              Add a document to the context on the left, or drag one in, and open it to edit it
              here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : shown === undefined ? (
        <div className="flex-1" aria-busy="true" />
      ) : showing === "compare" ? (
        // The payload is asked for whenever the document, the active version or the
        // chosen side changes; until the first one lands the pane holds its space
        // rather than flashing an empty comparison.
        // A compare mode saved earlier, or kept across a save that left one clean
        // version, lands here with nothing to show.
        nothingToCompare(doc) ? (
          <NothingToCompare />
        ) : daemon.diff && daemon.diff.doc === doc.slug ? (
          <ViewBoundary resetKey={`compare:${doc.slug}`}>
            <CompareView
              payload={daemon.diff}
              file={doc.name}
              versions={doc.versions}
              onAgainst={chooseSide}
              onTake={(hunks) =>
                send({
                  op: "merge",
                  doc: doc.slug,
                  against: daemon.diff?.against ?? against,
                  hunks,
                })
              }
              focus={compareFocus}
              onFocused={() => setCompareFocus(null)}
            />
          </ViewBoundary>
        ) : (
          <div className="flex-1" aria-busy="true" />
        )
      ) : formatView && bundle ? (
        <ViewBoundary resetKey={`format:${doc.slug}`}>
          <div
            data-slot="format-view"
            data-bundle={bundle.type.type}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* A component of its own, keyed by document: its hooks are its
                own, and a new bundle starts it afresh. */}
            {createElement(formatView, {
              key: doc.slug,
              doc,
              bundle: bundle.root,
              text: shown,
              editable: daemon.connection !== "ended",
              write: (next: string) => {
                writeText(doc, doc.active, next);
              },
              save: onSave,
              onBundleChange,
              setStatus,
              beforeSave,
            })}
          </div>
        </ViewBoundary>
      ) : (
        // Raw, rendered and split share one row, each view keyed in its own cell, so
        // moving between raw and split (or rendered and split) keeps the view that
        // stays: the editor its caret and undo history, the rendered view its scroll.
        // In split both read the same `shown` text: the rendered half follows an edit
        // when the client's debounced write lands, as the rendered view always has,
        // and both join the one `place`, so scrolling either moves the other.
        // The row is the split's resizable group in every one of the three, one
        // panel wide in raw and rendered: drawn only in split, a group would put
        // the editor under a different parent and remount it on every switch.
        <ViewBoundary resetKey={`${doc.slug}:${showing}`}>
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            defaultLayout={splitLayout.defaultLayout}
            onLayoutChanged={onSplitLayout}
            {...(showing === "split" ? { "data-slot": "split-view" } : {})}
          >
            {showing !== "rendered" && (
              <ResizablePanel
                key="raw"
                id="doc-raw"
                defaultSize={`${SPLIT_DEFAULT_SIZE}`}
                minSize={`${SPLIT_MIN_SIZE}`}
                className="flex min-h-0 min-w-0 flex-col"
              >
                <DocumentView
                  docKey={doc.slug}
                  text={shown}
                  editable={daemon.connection !== "ended"}
                  notes={paintedNotes}
                  focusedNote={focusedNote ?? null}
                  onChange={onEdit}
                  onFlush={onFlush}
                  onSave={onSave}
                  onSelect={onSelect}
                  reveal={revealHere}
                  onRevealed={w.revealApplied}
                  flash={flash?.agent ? flash : null}
                  clearSeq={w.clearSeq}
                  place={place}
                  pendingNote={pendingNote}
                  onContextMenu={setNoteAt}
                  onLinkRequest={isJson ? undefined : askLink}
                  onFollowLink={isJson ? undefined : followLink}
                  onImages={isJson ? undefined : takeImages}
                  onRows={isJson ? undefined : takeRows}
                  replay={replay.current?.slug === doc.slug ? replay.current : null}
                  onReplayed={() => {
                    replay.current = null;
                  }}
                  handle={setEditor}
                  extensions={rawExtensions}
                  tokens={rawTokens}
                  format={isJson ? "json" : "markdown"}
                  lineNumbers={lineNumbers && numbered}
                  quiet={reader}
                />
              </ResizablePanel>
            )}
            {showing === "split" && (
              // The library's keyboard: arrows move it 5%, Home and End to either
              // half's minimum. It draws the line between the halves.
              <ResizableHandle key="divider" withHandle aria-label="Resize raw and rendered" />
            )}
            {showing !== "raw" && (
              <ResizablePanel
                key="rendered"
                id="doc-rendered"
                defaultSize={`${100 - SPLIT_DEFAULT_SIZE}`}
                minSize={`${SPLIT_MIN_SIZE}`}
                className="flex min-h-0 min-w-0 flex-col"
              >
                <div className="flex min-h-0 min-w-0 flex-1 flex-col" {...renderedImageEvents}>
                  <MarkdownView
                    text={shown}
                    textKey={`${doc.slug}@${doc.active}`}
                    notes={paintedNotes}
                    focusedNote={focusedNote ?? null}
                    pendingNote={pendingNote}
                    onFollowLink={followLink}
                    onFollowHeading={jumpToHeading}
                    onSelect={onSelect}
                    clearSeq={w.clearSeq}
                    place={place}
                    onContextMenu={setNoteAt}
                    widgets={inlineWidgets}
                    frontmatterChips={frontmatterChips}
                    frontmatterTrust={frontmatterTrust}
                    profile={profileFor(profile, doc)}
                    onAskProfileFix={askProfileFix}
                    flash={flash}
                    embeds={embeds}
                    onEmbedTargets={onEmbedTargets}
                    footer={
                      <Backlinks
                        data={backlinks?.doc === doc.slug ? backlinks : null}
                        onOpen={openBacklink}
                        onOpenBundle={(b) =>
                          w.openAt ? w.openAt(b.source) : send({ op: "open", path: b.source })
                        }
                        onOpenEdge={(e) =>
                          w.openAt ? w.openAt(e.source) : send({ op: "open", path: e.source })
                        }
                        {...(linkedFromAction
                          ? {
                              action: {
                                label: linkedFromAction.label,
                                onSelect: () => linkedFromAction.onSelect(doc),
                              },
                            }
                          : {})}
                      />
                    }
                  />
                </div>
              </ResizablePanel>
            )}
          </ResizablePanelGroup>
        </ViewBoundary>
      )}
      {/* The floating composer, when the shell has one, docks here: under the
          document in the flow, so it covers none of it, and above the strip. */}
      {doc && !appActive && <CentreDock />}
      {doc && !appActive && (
        <div className={cn("shrink-0 border-t border-edge px-3 py-1", reader && QUIET_GROUP)}>
          <StatusStrip segments={segments} fade={fade} />
        </div>
      )}
      {dialog}
      <NoteAtSelection
        at={noteAt}
        quote={noteAt && shown !== undefined ? shown.slice(noteAt.from, noteAt.to) : ""}
        existing={(noteAt?.noteIds ?? []).flatMap((id) => {
          const n = doc?.notes.find((x) => x.id === id);
          // Still owed an answer: the note menu on the passage says so too.
          const owed = w.state.notesWaiting?.find((o) => o.doc === doc?.slug && o.noteId === id);
          const waiting = owed ? badgeFor(owed, w.state.agentListening !== false) : undefined;
          return n ? [{ id, label: n.body, ...(waiting ? { waiting } : {}) }] : [];
        })}
        onClose={() => setNoteAt(null)}
        onAdd={(from, to, body) => {
          if (!doc) return;
          send({ op: "note.add", doc: doc.slug, from, to, body });
          // A note consumes the passage it was written about.
          w.dropSelection();
        }}
        onShowNote={(id) => {
          const n = doc?.notes.find((x) => x.id === id);
          if (doc && n && n.from !== null && n.to !== null)
            w.requestReveal({ doc: doc.slug, version: doc.active, from: n.from, to: n.to });
        }}
        onDeleteNote={(id) => doc && send({ op: "note.remove", doc: doc.slug, id })}
        onAddLink={
          canLink ? (at) => askLinkAt({ from: at.from, to: at.to, x: at.x, y: at.y }) : undefined
        }
      />
      {linking && canLink && (
        <LinkPicker
          at={linking}
          kind={linking.kind}
          quote={linking.quote}
          initialQuery={linking.initialQuery}
          targets={linkTargets && linkTargets.doc === slug ? linkTargets.targets : null}
          relations={linkTargets?.relations ?? []}
          byKind={linkTargets?.byKind ?? []}
          vocabulary={linkTargets?.vocabulary ?? false}
          failure={linkFailure}
          onClose={closeLink}
          onHeadings={(target) => headingsFor(target.path)}
          onChoose={(target, relations, heading) =>
            chooseLink(
              linking.kind,
              linking.quote,
              linkInsertion(linking.kind, linking.quote, target, relations, heading),
              linking,
            )
          }
        />
      )}
      {doc && (
        <NewVersionDialog
          open={naming !== null}
          intent={naming ?? "branch"}
          from={doc.active}
          next={nextVersionNumber(doc.versions)}
          onOpenChange={(o) => {
            if (!o) setNaming(null);
          }}
          onCreate={(label) => {
            // Branching moves into the new copy; a snapshot stays where it is.
            // Either way the client sends a pending edit first, so the copy has it.
            send({
              op: "version.new",
              doc: doc.slug,
              from: doc.active,
              ...(label ? { label } : {}),
              activate: (naming ?? "branch") === "branch",
            });
          }}
        />
      )}
    </div>
  );
}
