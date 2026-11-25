// THE SHELL'S HELD SELECTION: the open document and image, the selection held
// against it and told to the daemon, the note pointed at, the whole documents
// pointed at, the refs the next message draws on, and the reveal's state. A hook
// of `ShellBody`'s, called where this section sat in it, so the hooks keep their
// order.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import {
  applySelectionEvent,
  type HeldSelection,
  type Reveal,
  revealAfter,
  type SelectionEvent,
} from "../context/selection.ts";
import type { PointedDocs } from "../context/workspace.ts";
import type { MessageRef, PublicState } from "../workspace/protocol";

export function useHeldSelection({
  daemon,
  state,
  send,
}: {
  daemon: Daemon;
  state: PublicState;
  send: Daemon["send"];
}) {
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
  return {
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
  };
}
