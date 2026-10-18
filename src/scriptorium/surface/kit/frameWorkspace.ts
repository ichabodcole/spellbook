/**
 * The interim frame's workspace: what the kit's `DocumentPane` reads through
 * `useWorkspace()`, which Story Studio's shell provides and this frame has to
 * build for itself until cycle 5's shell replaces both.
 *
 * It follows the shell (`shell/WorkspaceShell.tsx` at Story Studio's
 * `b6d5956`) wherever the pane can tell the difference:
 *
 * - ONE held selection, through the kit's own rules (`applySelectionEvent`,
 *   `revealAfter`), cleared whenever the text on screen changes, and told to
 *   the daemon on every change and again on a reconnect, since `say` attaches
 *   the selection the DAEMON holds;
 * - a one-shot reveal, for a note chosen in the Notes panel, a backlink, or a
 *   link followed to a heading;
 * - the chosen note (`focusedNote`), let go when the human moves to another
 *   document or version, or resolves it;
 * - a request to compare (`showDiff`), from a toast.
 *
 * What the shell has and the pane does not need is left out: pointed-at
 * documents, hand-added refs, the floating composer, raw bundle mains, the
 * image viewer. The columns and quiet mode are plain stand-ins: the frame
 * hides a column the pane collapses (reader mode), and quiet changes nothing,
 * because the frame's chrome is one thin header.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Collapsed, ColumnSide } from "../../../kit/context/columns";
import type { Daemon } from "../../../kit/context/daemonClient";
import {
  applySelectionEvent,
  type HeldSelection,
  type Reveal,
  revealAfter,
  type SelectionEvent,
} from "../../../kit/context/selection";
import type { PaneName, Workspace } from "../../../kit/context/workspace";
import type { ShowDiff } from "../../../kit/document/DocumentPane";
import type { Theme } from "../../../kit/theme/mode";
import type { ToastStore } from "../../../kit/ui/toast-store";
import type { DiffSide, DocView, PlacedNote, ServerOp } from "../../../kit/workspace/protocol";

/** The last part of a path, for a toast that names a file. */
const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

export type FrameWorkspace = {
  /** The pane's context, or null until the first snapshot. */
  workspace: Workspace | null;
  openDoc: DocView | null;
  /** The held selection when it is about the text on screen, else null. */
  heldHere: HeldSelection | null;
  dropSelection: () => void;
  focusedNote: string | null;
  /** Escape in the Notes panel: let the chosen note go. */
  letGoOfNote: () => void;
  showResolvedNotes: boolean;
  setShowResolvedNotes: (show: boolean) => void;
  /** A note in the Notes panel was clicked: choose it and show its passage (again: let it go). */
  goToNote: (n: PlacedNote) => void;
  /** Add a note on the held passage; a note consumes the passage it was written about. */
  addNote: (from: number, to: number, body: string) => void;
  showDiff: ShowDiff | null;
  /** Open compare on this document, against a version or the file on disk. */
  requestDiff: (doc: string, against: DiffSide) => void;
  collapsed: Collapsed;
};

export function useFrameWorkspace({
  daemon,
  toasts,
  theme,
  setTheme,
}: {
  daemon: Daemon;
  toasts: ToastStore;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}): FrameWorkspace {
  const { state, send } = daemon;
  const docs = state?.docs;
  const openSlug = state?.openDoc ?? null;
  const openDoc = useMemo(() => docs?.find((d) => d.slug === openSlug) ?? null, [docs, openSlug]);

  // ── the held selection ──────────────────────────────────────────────────
  const [selection, setSelection] = useState<HeldSelection | null>(null);
  const [clearSeq, setClearSeq] = useState(0);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealSeq = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
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
  const reportSelection = useCallback(
    (s: HeldSelection) => onSelectionEvent({ type: "report", selection: s }),
    [onSelectionEvent],
  );
  const dropSelection = useCallback(() => onSelectionEvent({ type: "drop" }), [onSelectionEvent]);

  // The daemon holds the selection `say` attaches: it is told of every change,
  // and again on a reconnect (a daemon that restarted holds none).
  const connected = daemon.connection === "open";
  const docsRef = useRef(docs);
  docsRef.current = docs;
  useEffect(() => {
    if (!connected) return;
    if (!selection) {
      send({ op: "select", selection: null });
      return;
    }
    const doc = docsRef.current?.find((d) => d.slug === selection.doc);
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

  const requestReveal = useCallback((target: Omit<Reveal, "seq">) => {
    setReveal({ ...target, seq: ++revealSeq.current });
  }, []);
  const revealApplied = useCallback(
    (seq: number) => setReveal((r) => revealAfter(r, { type: "applied", seq })),
    [],
  );

  // ── the chosen note ─────────────────────────────────────────────────────
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
    else if (!pickedState && pointedAt.resolved) setPointedAt({ ...pointedAt, resolved: false });
  }, [pickedState, pointedAt]);
  const [showResolvedNotes, setShowResolvedNotes] = useState(false);
  const goToNote = (n: PlacedNote) => {
    if (!openDoc) return;
    // A second click on the chosen note lets it go, and shows nothing new.
    if (n.id === focusedNote) {
      setPointedAt(null);
      return;
    }
    setPointedAt({ id: n.id, doc: openDoc.slug, version: openDoc.active, resolved: n.resolved });
    if (n.from !== null && n.to !== null)
      requestReveal({ doc: openDoc.slug, version: openDoc.active, from: n.from, to: n.to });
  };
  const addNote = (from: number, to: number, body: string) => {
    if (!openDoc) return;
    send({ op: "note.add", doc: openDoc.slug, from, to, body });
    dropSelection();
  };

  // ── opening at a place: a backlink, or a link followed to a heading ─────
  const [pendingShow, setPendingShow] = useState<{
    path: string;
    from: number;
    to: number;
    heading?: { from: number; to: number };
    /** The document on screen when it was asked for: leaving for any other one cancels it. */
    since: string | null;
  } | null>(null);
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
  useEffect(() => {
    if (!pendingShow) return;
    if (openDoc?.original !== pendingShow.path) {
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
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;
  const { onFrame } = daemon;
  const { announce } = toasts;
  useEffect(
    () =>
      onFrame((frame) => {
        if (frame.op !== "link.target") return;
        const f = frame as Extract<ServerOp, { op: "link.target" }>;
        if (f.state !== "in-context" || !f.heading || f.refused) return;
        const { found, anchor } = f.heading;
        if (!found)
          announce(
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
    [onFrame, announce],
  );
  // A refusal (the open failed) cancels a reveal that was waiting on it.
  const { lastError } = daemon;
  useEffect(() => {
    if (lastError) setPendingShow(null);
  }, [lastError]);

  // ── a comparison asked for from outside the pane ────────────────────────
  const [showDiff, setShowDiff] = useState<ShowDiff | null>(null);
  const requestDiff = useCallback(
    (doc: string, against: DiffSide) =>
      setShowDiff((was) => ({ doc, version: against, seq: (was?.seq ?? 0) + 1 })),
    [],
  );

  // ── stand-ins for the shell's own chrome ────────────────────────────────
  const [collapsed, setCollapsed] = useState<Collapsed>({ context: false, chat: false });
  const columns = useMemo(
    () => ({
      collapsed,
      collapse: (side: ColumnSide) => setCollapsed((c) => ({ ...c, [side]: true })),
      expand: (side: ColumnSide) => setCollapsed((c) => ({ ...c, [side]: false })),
    }),
    [collapsed],
  );
  const focusPane = useCallback((pane: PaneName) => {
    document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus();
  }, []);
  const setQuiet = useCallback((_quiet: boolean) => {}, []);

  // Memoised: the centre re-renders from this context, and a fresh object on
  // every snapshot would re-render it for changes it does not read.
  const workspace = useMemo<Workspace | null>(
    () =>
      state
        ? {
            daemon,
            state,
            openDoc,
            openImage: state.openImage ?? null,
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
          }
        : null,
    [
      daemon,
      state,
      openDoc,
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
      setQuiet,
    ],
  );

  const heldHere =
    selection && openDoc && selection.doc === openDoc.slug && selection.version === openDoc.active
      ? selection
      : null;

  return {
    workspace,
    openDoc,
    heldHere,
    dropSelection,
    focusedNote,
    letGoOfNote: () => setPointedAt(null),
    showResolvedNotes,
    setShowResolvedNotes,
    goToNote,
    addNote,
    showDiff,
    requestDiff,
    collapsed,
  };
}
