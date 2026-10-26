// The notes on the open document.
//
// A LIST, NOT ONLY MARGIN MARKS. Notes are highlighted in the text AND gathered
// here, because the use is a PASS: go through a document flagging things, then
// decide what to do with the batch. A gutter icon answers "is there a note on
// this line"; only a list answers "what have I flagged", which is the question
// that makes the batch sendable later.
//
// AND IT IS WHERE AN ORPHAN CAN LIVE. A note whose text was deleted has no line
// to sit beside; in a margin-only design it would silently vanish, which is the
// one outcome the anchoring is built to prevent. Here it keeps its place in the
// list, marked, still readable, still deletable.
import {
  CheckIcon,
  MessageCircleQuestionIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
  UndoDotIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { oneLine } from "../lib/oneLine.ts";
import { Button } from "../ui/button.tsx";
import type { Message, NoteWaiting, PlacedNote, Waiting } from "../workspace/protocol";
import { badgeFor, WaitingBadge, WaitingDot } from "./WaitingBadge.tsx";

const NONE_WAITING: ReadonlyMap<string, NoteWaiting> = new Map();
const NONE_ASKED: ReadonlySet<string> = new Set();
const NONE_REPLIED: ReadonlyMap<string, readonly NoteReply[]> = new Map();
const NO_REPLIES: readonly NoteReply[] = [];

/** An answer to a note, as the panel shows it: the agent's message about it. */
export type NoteReply = Pick<Message, "id" | "text" | "ts">;

/**
 * The agent's answers to notes, by note id, oldest first: each agent message in
 * the conversation whose `about.noteId` names the note. That message IS the
 * reply (`note-reply` stores it, and so does a `say` that names the note), so
 * the panel reads the conversation and stores nothing of its own.
 */
export function repliesByNote(
  chat: readonly Pick<Message, "id" | "from" | "text" | "ts" | "about">[],
): ReadonlyMap<string, readonly NoteReply[]> {
  const out = new Map<string, NoteReply[]>();
  for (const m of chat) {
    const noteId = m.about?.noteId;
    if (m.from !== "agent" || typeof noteId !== "string" || !noteId) continue;
    const list = out.get(noteId) ?? [];
    list.push({ id: m.id, text: m.text, ts: m.ts });
    out.set(noteId, list);
  }
  return out;
}

/** How a note found its place, said plainly, or nothing when it is certain. */
const UNCERTAIN: Partial<Record<PlacedNote["how"], { label: string; title: string }>> = {
  nearest: {
    label: "moved?",
    title:
      "This text appears more than once and its surroundings changed. This is the closest match: it may be the wrong one.",
  },
  orphaned: {
    label: "text gone",
    title: "The text this note was made on is no longer in this version.",
  },
};

function Note({
  note,
  focused,
  waiting,
  agentListening,
  sessionEnded,
  asked,
  replies,
  onAsk,
  onGoTo,
  onEdit,
  onResolve,
  onRemove,
}: {
  note: PlacedNote;
  /** Pointed at from the document: bordered, and scrolled to. */
  focused: boolean;
  /** Owed an answer, and how long: absent when it is not. */
  waiting: NoteWaiting | undefined;
  agentListening: boolean;
  sessionEnded: boolean;
  /** Asked about in the conversation, and not answered yet. */
  asked: boolean;
  /** The agent's answers to this note, oldest first (`repliesByNote`). */
  replies: readonly NoteReply[];
  onAsk: ((n: PlacedNote) => void) | undefined;
  onGoTo: (n: PlacedNote) => void;
  onEdit: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const uncertain = UNCERTAIN[note.how];
  const shownBadge = waiting ? badgeFor(waiting, agentListening, sessionEnded) : null;
  const anchored = note.from !== null;
  // EDITING CHANGES WHAT A NOTE SAYS, NEVER WHAT IT IS ABOUT. The quote stays
  // put: a note you rewrote is still about the passage you made it on, and
  // re-quoting on edit would silently move it to wherever the caret happened to be.
  const [draft, setDraft] = useState<string | null>(null);
  // The words the agent's rewrite replaced, kept while the agent's rewrite stands.
  const replaced = note.editedBy === "agent" ? note.replacedBody : undefined;
  const [showReplaced, setShowReplaced] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) row.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [focused]);
  return (
    <div
      ref={row}
      data-slot="note"
      data-resolved={note.resolved || undefined}
      data-focused={focused || undefined}
      data-waiting={waiting?.badge}
      className={cn(
        "group/note rounded-md border border-edge bg-bg px-2 py-1.5 text-xs transition-colors",
        note.resolved && "opacity-60",
        // The border is the pointer: it says "this one" without moving anything
        // or changing what the note says.
        focused && "border-selected bg-selected/10 ring-1 ring-selected/40",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => onGoTo(note)}
          disabled={!anchored}
          title={anchored ? "Show this in the document" : "This note has no place in the text"}
          className={cn(
            "min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-dim",
            anchored && "hover:text-ink hover:underline",
            !anchored && "cursor-default line-through",
          )}
        >
          {oneLine(note.quote) || "—"}
        </button>
        {uncertain && (
          <span
            title={uncertain.title}
            className="shrink-0 rounded-sm bg-attention/15 px-1 text-[10px] text-attention"
          >
            {uncertain.label}
          </span>
        )}
      </div>
      {draft === null ? (
        <p data-slot="note-body" className="mt-1 whitespace-pre-wrap text-ink">
          {note.body}
        </p>
      ) : (
        <form
          className="mt-1 flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onEdit(note.id, draft);
            setDraft(null);
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the human just asked to edit this note
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            aria-label="Edit note"
            className={cn(
              "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
              "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
            )}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-faint">⌘↩ to save · esc to cancel</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft(null)}
              className="ml-auto h-5 px-1.5 text-[11px]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!draft.trim()}
              className="h-5 px-1.5 text-[11px]"
            >
              Save
            </Button>
          </div>
        </form>
      )}
      {/* THE AGENT'S ANSWERS SIT BESIDE THE NOTE, never in it: the note keeps
          the words it was written in, and each reply is the agent's message
          about it, shown here as well as in the conversation. */}
      {replies.length > 0 && (
        <ul
          data-slot="note-replies"
          className="mt-1 flex flex-col gap-1 border-edge border-l-2 pl-2"
        >
          {replies.map((r) => (
            <li key={r.id} data-slot="note-reply" className="text-ink-dim">
              <span className="text-[10px] text-ink-faint">Agent replied</span>
              <p className="whitespace-pre-wrap">{r.text}</p>
            </li>
          ))}
        </ul>
      )}
      {/* The message wait's badge, on the note it is about: a pulse while the
          note is with the agent, a static "may be stuck" once it has waited as
          long as a message would. Resolving (the check below) is the human's
          own way out. */}
      {waiting && (
        <div className="flex flex-wrap items-center gap-x-2">
          <WaitingBadge of={asked ? "asked" : "note"} badge={shownBadge ?? "working"} />
          {/* "May be stuck" carries its act: ask the agent in the conversation,
              where the answer lands. Once asked, not offered again: the note
              then waits on that message and says so. */}
          {onAsk && !asked && shownBadge === "stalled" && (
            <button
              type="button"
              data-action="note-ask"
              onClick={() => onAsk(note)}
              title="Send this note to the agent as a message in the conversation"
              className="mt-1 flex items-center gap-1 rounded-sm text-[11px] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
            >
              <MessageCircleQuestionIcon aria-hidden className="size-3" />
              Ask the agent
            </button>
          )}
        </div>
      )}
      {/* What the agent's rewrite replaced, on asking: the human's words are
          never lost to it, and putting them back is one act (the human's own
          rewrite, so it asks the agent again). */}
      {replaced !== undefined && showReplaced && (
        <div
          data-slot="note-replaced"
          className="mt-1 rounded-sm border border-edge border-dashed px-1.5 py-1"
        >
          <p className="whitespace-pre-wrap text-ink-dim">{replaced}</p>
          <button
            type="button"
            data-action="note-restore"
            onClick={() => {
              onEdit(note.id, replaced);
              setShowReplaced(false);
            }}
            title="Put these words back in place of the agent's"
            className="mt-1 rounded-sm text-[11px] text-ink-dim underline-offset-2 hover:text-ink hover:underline"
          >
            Put it back
          </button>
        </div>
      )}
      <div className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint">
        <span>{note.by === "agent" ? "Agent" : "You"}</span>
        <span>·</span>
        <span>v{note.version}</span>
        {note.editedAt !== undefined && (
          <>
            <span>·</span>
            {/* "By the agent" while the agent's words stand over someone's
                own: one it rewrote back to them is plainly "edited". */}
            <span data-slot="note-edited">
              {replaced !== undefined ? "edited by the agent" : "edited"}
            </span>
          </>
        )}
        {replaced !== undefined && (
          <button
            type="button"
            data-action="note-show-replaced"
            aria-expanded={showReplaced}
            onClick={() => setShowReplaced((v) => !v)}
            className="rounded-sm underline-offset-2 hover:text-ink hover:underline"
          >
            {showReplaced ? "hide what it replaced" : "show what it replaced"}
          </button>
        )}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/note:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setDraft(note.body)}
            title="Rewrite this note"
            aria-label="Edit note"
            className="rounded-sm p-0.5 hover:bg-surface-raised hover:text-ink"
          >
            <PencilIcon aria-hidden className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => onResolve(note.id, !note.resolved)}
            title={note.resolved ? "Put this note back" : "Mark this note dealt with"}
            aria-label={note.resolved ? "Reopen note" : "Resolve note"}
            className="rounded-sm p-0.5 hover:bg-surface-raised hover:text-ink"
          >
            {note.resolved ? (
              <UndoDotIcon aria-hidden className="size-3" />
            ) : (
              <CheckIcon aria-hidden className="size-3" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onRemove(note.id)}
            title="Delete this note"
            aria-label="Delete note"
            className="rounded-sm p-0.5 hover:bg-surface-raised hover:text-danger"
          >
            <Trash2Icon aria-hidden className="size-3" />
          </button>
        </span>
      </div>
    </div>
  );
}

export function NotesPanel({
  notes,
  waiting = NONE_WAITING,
  others = [],
  agentListening = true,
  sessionEnded = false,
  asked = NONE_ASKED,
  replies = NONE_REPLIED,
  onAsk,
  onOpenDoc,
  focusedId,
  onLetGo,
  showResolved: showResolvedProp,
  onShowResolved,
  selection,
  addUnavailable,
  onAdd,
  onGoTo,
  onEdit,
  onResolve,
  onRemove,
}: {
  /** The open document's notes, placed against its active version. */
  notes: readonly PlacedNote[];
  /** Which of these notes are owed an answer, by id (`badgesOn`). */
  waiting?: ReadonlyMap<string, NoteWaiting>;
  /**
   * Documents other than this one with notes owed an answer (`elsewhere`, with
   * each document's name): the pointer that keeps them visible here without a
   * second list.
   */
  others?: readonly {
    doc: string;
    name: string;
    count: number;
    badge: Waiting["badge"];
    acknowledged?: true;
  }[];
  agentListening?: boolean;
  /**
   * The session has ended: a note owed an answer says so, instead of working or
   * may be stuck, and Ask the agent is not offered. Default false.
   */
  sessionEnded?: boolean;
  /**
   * The waiting notes already asked about in the conversation, unanswered, by
   * id (`askedAbout`): their badge says so, and Ask the agent is not offered
   * again.
   */
  asked?: ReadonlySet<string>;
  /** The agent's answers, by note id (`repliesByNote`): each shown under its note. */
  replies?: ReadonlyMap<string, readonly NoteReply[]>;
  /**
   * "Ask the agent", on a note that may be stuck: the host sends the ask
   * (`via: "ask"`, `about.noteId`). Absent, not offered, and resolving the note
   * is the way out.
   */
  onAsk?: (n: PlacedNote) => void;
  /** Open a document named in `others`. */
  onOpenDoc?: (doc: string) => void;
  /** The note the document pointed at, if any. */
  focusedId: string | null;
  /** Escape in the panel, while a note is focused: the human lets it go. */
  onLetGo?: () => void;
  /**
   * Whether resolved notes are listed, when the host keeps it (the shell does,
   * so the document paints what is listed). Absent: the panel keeps its own.
   */
  showResolved?: boolean;
  onShowResolved?: (show: boolean) => void;
  /** The editor's current selection, or null: what a new note would be about. */
  selection: { from: number; to: number; text: string } | null;
  /**
   * Why no note can be added here at all (a host with no document view to
   * select in): shown in place of the form. Absent, the form is shown, and
   * waits for a selection.
   */
  addUnavailable?: string;
  onAdd: (from: number, to: number, body: string) => void;
  onGoTo: (n: PlacedNote) => void;
  onEdit: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const [body, setBody] = useState("");
  const [ownShowResolved, setOwnShowResolved] = useState(false);
  const showResolved = showResolvedProp ?? ownShowResolved;
  const setShowResolved = (show: boolean) => {
    setOwnShowResolved(show);
    onShowResolved?.(show);
  };
  const resolved = notes.filter((n) => n.resolved);
  // A FOCUSED NOTE IS ALWAYS SHOWN, even when it is resolved and the resolved
  // ones are hidden: otherwise pointing at it from the document scrolls to
  // nothing and the menu looks broken.
  const shown = showResolved ? notes : notes.filter((n) => !n.resolved || n.id === focusedId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selection || !body.trim()) return;
    onAdd(selection.from, selection.to, body);
    setBody("");
  };

  // Escape lets the focused note go. Not from a field: the edit draft's own
  // Escape closes the draft, and the new note's keeps what was typed. Taken, so
  // the shell's Escape (back to the centre) waits for the next one.
  const letGo = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || !focusedId || !onLetGo) return;
    if ((e.target as HTMLElement).closest?.("textarea, input")) return;
    e.preventDefault();
    onLetGo();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from anything inside the panel, which holds its own focusable controls.
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={letGo}>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {others.length > 0 && (
          <div
            data-slot="notes-elsewhere"
            className="mb-2 flex flex-col gap-0.5 rounded-md border border-edge px-2 py-1 text-[11px] text-ink-dim"
          >
            {others.map((o) => (
              <button
                key={o.doc}
                type="button"
                onClick={() => onOpenDoc?.(o.doc)}
                title={`Open ${o.name} to see its notes`}
                className="flex items-center gap-1.5 rounded-sm text-left hover:text-ink hover:underline"
              >
                <WaitingDot of="note" badge={badgeFor(o, agentListening, sessionEnded)} />
                <span className="min-w-0 truncate">
                  {o.count === 1 ? "A note" : `${o.count} notes`} owed an answer on {o.name}
                </span>
              </button>
            ))}
          </div>
        )}
        {shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-ink-faint">
            {/* With nowhere to select, the reason below says why; this does not ask for it. */}
            {addUnavailable
              ? "No notes on this document."
              : "Select some text in the document and write a note about it."}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((n) => (
              <Note
                key={n.id}
                note={n}
                focused={n.id === focusedId}
                waiting={waiting.get(n.id)}
                agentListening={agentListening}
                sessionEnded={sessionEnded}
                asked={asked.has(n.id)}
                replies={replies.get(n.id) ?? NO_REPLIES}
                onAsk={onAsk}
                onGoTo={onGoTo}
                onEdit={onEdit}
                onResolve={onResolve}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
        {resolved.length > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved(!showResolved)}
            className="mt-2 w-full rounded-sm px-1 py-1 text-[11px] text-ink-faint hover:text-ink"
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
        )}
      </div>

      {addUnavailable ? (
        <p className="shrink-0 border-t border-edge p-2 text-[11px] text-ink-faint">
          {addUnavailable}
        </p>
      ) : (
        <form onSubmit={submit} className="shrink-0 border-t border-edge p-2">
          {/* THE QUOTE IS SHOWN BEFORE THE NOTE IS MADE. A note is about a passage,
            and writing one without seeing which passage is how you end up with a
            note on the wrong sentence. */}
          <p className="mb-1 truncate font-mono text-[11px] text-ink-faint">
            {selection ? oneLine(selection.text) : "No selection"}
          </p>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={!selection}
            aria-label="New note"
            placeholder={selection ? "What about it?" : "Select text in the document first"}
            rows={2}
            className={cn(
              "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
              "placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-60",
            )}
            onKeyDown={(e) => {
              // Cmd or Ctrl plus Enter submits, because a note is prose and Enter
              // must make a line.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[10px] text-ink-faint">⌘↩ to add</span>
            <Button
              type="submit"
              size="sm"
              disabled={!selection || !body.trim()}
              className="ml-auto h-6 px-2 text-xs"
            >
              <MessageSquarePlusIcon aria-hidden className="size-3" />
              Add note
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
