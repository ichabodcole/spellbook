// THE RIGHT COLUMN'S STATE: what the kit's tabs show and the composer sends,
// read off the snapshot each render: the open document's notes and the
// session's tasks, the notes owed an answer and the ones asked about, and the
// subject and refs the next message carries, with the composer's props. A hook
// of `ShellBody`'s, called where this section sat in it, right after the
// `contextBody` JSX, so the hooks keep their order. The tabs themselves are
// JSX and stay in `ShellBody`; the chosen tab is `useRightTab`'s.

import { useCallback, useMemo, useState } from "react";
import type { Attachable, ChatComposerProps } from "../chat/ChatComposer.tsx";
import { pathLabel } from "../chat/ChatMessageView.tsx";
import { repliesByNote } from "../chat/NotesPanel.tsx";
import {
  askAboutNoteText,
  askedAbout,
  badgesOn,
  elsewhere,
  owedSummary,
} from "../chat/noteWaiting.ts";
import { isFinishedStatus } from "../chat/TasksPanel.tsx";
import type { Daemon } from "../context/daemonClient.ts";
import { bundleLabelAt, rowRefs } from "../context/model.ts";
import { quoteLabel } from "../workspace/anchors.ts";
import type { PublicState } from "../workspace/protocol";
import { messageParts } from "./messageRefs.ts";
import { waitingOnAgent } from "./rail.ts";
import type { useHeldSelection } from "./useHeldSelection.ts";

type Held = ReturnType<typeof useHeldSelection>;

export function useRightColumn({
  daemon,
  state,
  send,
  ended,
  askAboutNotes,
  draft,
  setDraft,
  openDoc,
  openImage,
  selection,
  dropSelection,
  pointedDocs,
  pointDocs,
  treeSelected,
  setTreeSelected,
  addedRefs,
  removeRef,
  clearRefs,
}: {
  daemon: Daemon;
  state: PublicState;
  send: Daemon["send"];
  ended: boolean;
  askAboutNotes:
    | boolean
    | ((note: { quote: string; body: string }, docName: string) => string)
    | undefined;
  draft: string;
  setDraft: (draft: string) => void;
  openDoc: Held["openDoc"];
  openImage: Held["openImage"];
  selection: Held["selection"];
  dropSelection: Held["dropSelection"];
  pointedDocs: Held["pointedDocs"];
  pointDocs: Held["pointDocs"];
  treeSelected: Held["treeSelected"];
  setTreeSelected: Held["setTreeSelected"];
  addedRefs: Held["addedRefs"];
  removeRef: Held["removeRef"];
  clearRefs: Held["clearRefs"];
}) {
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
  return {
    notes,
    openNotes,
    tasks,
    outstanding,
    docName,
    pathName,
    heldHere,
    agentListening,
    notesAsked,
    notesWaiting,
    askNote,
    noteReplies,
    noteName,
    followChatLink,
    noteBadges,
    notesElsewhere,
    notesOwed,
    composerWaiting,
    composerProps,
  };
}
