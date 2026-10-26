// The composer, floating at the foot of the centre while the conversation column
// is collapsed, with the one line of the conversation the human needs so as not
// to open it: what the agent said last, or that it is still working on theirs.
// Above it, while one is owed an answer, the oldest note with the agent.
// Anything more is a click away, and the click reopens the column. The human can
// also close the float, for a centre with nothing over it; the collapsed rail
// then carries the way back.
//
// Props only: the composer it carries is passed in as `children`, so the shell
// keeps the one draft and draws the one composer wherever it is.
import { XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { plainLine } from "../lib/oneLine.ts";
import { Button } from "../ui/button.tsx";
import type { DocView, Message, NoteWaiting, Waiting } from "../workspace/protocol";
import { badgeFor, WaitingBadge } from "./WaitingBadge.tsx";

/**
 * The agent's latest line: its newest message (not a system line or the human's
 * own), as plain text on one row, since the float does not render markdown.
 */
export function latestAgentLine(
  messages: readonly Pick<Message, "from" | "text">[],
): string | null {
  const text = messages.findLast((m) => m.from === "agent")?.text;
  return text === undefined ? null : plainLine(text) || null;
}

/**
 * The message the human is waiting on, as plain text on one row: with the
 * column shut, its echo is the only way to tell which message waits. Null when
 * it is not in `messages` (as for a moment while a snapshot catches up).
 */
export function waitingLine(
  messages: readonly Pick<Message, "id" | "text">[],
  waiting: Pick<Waiting, "messageId"> | null,
): string | null {
  if (!waiting) return null;
  const text = messages.find((m) => m.id === waiting.messageId)?.text;
  return text === undefined ? null : plainLine(text) || null;
}

/**
 * The note the float names: the oldest owed an answer that the human can still
 * act on (not yet asked about, by `asked`), else the oldest, with its document
 * and how many more there are, or null when none is owed (or that note is not
 * in `docs`, as for a moment while a snapshot catches up).
 */
export function floatNote(
  notesWaiting: readonly NoteWaiting[],
  docs: readonly Pick<DocView, "slug" | "name" | "notes">[],
  asked: ReadonlySet<string> = new Set(),
): { waiting: NoteWaiting; body: string; docName: string; doc: string; more: number } | null {
  const first = notesWaiting.find((n) => !asked.has(n.noteId)) ?? notesWaiting[0];
  if (!first) return null;
  const doc = docs.find((d) => d.slug === first.doc);
  const note = doc?.notes.find((n) => n.id === first.noteId);
  if (!doc || !note) return null;
  return {
    waiting: first,
    body: plainLine(note.body),
    docName: doc.name,
    doc: doc.slug,
    more: notesWaiting.length - 1,
  };
}

export function FloatingComposer({
  messages,
  waiting,
  notesWaiting = [],
  docs = [],
  openDoc = null,
  agentListening = true,
  sessionEnded = false,
  asked,
  onAskNote,
  onOpen,
  onClose,
  children,
}: {
  messages: readonly Message[];
  /** Whether the human is waiting on an answer: then the line says so. */
  waiting: Waiting | null;
  /**
   * The session's notes owed an answer, oldest first. With the column shut, a
   * note with the agent has to show somewhere: the float names the oldest.
   */
  notesWaiting?: readonly NoteWaiting[];
  /** The session's documents, for the note's words and its document's name. */
  docs?: readonly Pick<DocView, "slug" | "name" | "notes">[];
  /** The open document: a note on it needs no document named. */
  openDoc?: string | null;
  agentListening?: boolean;
  /** The session has ended: a wait's badge says so, and nothing is offered to ask. */
  sessionEnded?: boolean;
  /** The waiting notes already asked about, unanswered, by id (`askedAbout`). */
  asked?: ReadonlySet<string>;
  /**
   * "Ask the agent", on the named note when it may be stuck: the host sends the
   * ask (`via: "ask"`, `about.noteId`). Absent, not offered.
   */
  onAskNote?: (waiting: NoteWaiting) => void;
  /** Open the conversation: reopen the column on its Chat tab. */
  onOpen: () => void;
  /** Close the float; the collapsed rail brings it back. */
  onClose: () => void;
  /** The composer. */
  children: ReactNode;
}) {
  const line = waiting ? null : latestAgentLine(messages);
  const waitedOn = waitingLine(messages, waiting);
  const owed = floatNote(notesWaiting, docs, asked);
  const owedAsked = owed !== null && asked?.has(owed.waiting.noteId) === true;
  const owedBadge = owed ? badgeFor(owed.waiting, agentListening, sessionEnded) : null;
  return (
    <div data-slot="floating-composer" className="mx-auto flex w-full max-w-2xl flex-col gap-1">
      {/* A note with the agent, on a row of its own above the conversation's
          line, as the earlier work drew it: the two are different waits, and
          neither hides the other. One row, its count kept out of the truncated
          text so it never clips. */}
      {owed && (
        <div
          data-slot="float-note"
          data-waiting={owed.waiting.badge}
          className="flex min-h-5 items-center gap-2 pl-1 text-[11px] text-ink-dim"
        >
          <p className="min-w-0 flex-1 truncate" title={owed.body}>
            <span className="mr-1.5 font-medium text-ink-faint">
              Your note{owed.doc !== openDoc ? ` on ${owed.docName}` : ""}
            </span>
            {owed.body}
          </p>
          {owed.more > 0 && <span className="shrink-0 text-ink-faint">+{owed.more} more</span>}
          <span className="shrink-0">
            <WaitingBadge flush of={owedAsked ? "asked" : "note"} badge={owedBadge ?? "working"} />
          </span>
          {onAskNote && !owedAsked && owedBadge === "stalled" && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-action="float-note-ask"
              title="Send this note to the agent as a message in the conversation"
              onClick={() => onAskNote(owed.waiting)}
            >
              Ask the agent
            </Button>
          )}
        </div>
      )}
      <div className="flex min-h-6 items-center gap-1 pl-1 text-[11px] text-ink-dim">
        <div data-slot="float-line" className="min-w-0 flex-1">
          {waiting ? (
            // The message waited on, echoed before its badge as a note is,
            // its badge kept out of the truncated text so it never clips.
            <div data-slot="float-waiting" className="flex min-w-0 items-center gap-2">
              {waitedOn && (
                <p className="min-w-0 truncate" title={waitedOn}>
                  <span className="mr-1.5 font-medium text-ink-faint">You</span>
                  {waitedOn}
                </p>
              )}
              <span className="shrink-0">
                <WaitingBadge flush badge={badgeFor(waiting, agentListening, sessionEnded)} />
              </span>
            </div>
          ) : line ? (
            <p className="truncate" title={line}>
              <span className="mr-1.5 font-medium text-ink-faint">Agent</span>
              {line}
            </p>
          ) : null}
        </div>
        <Button type="button" variant="ghost" size="xs" data-action="float-open" onClick={onOpen}>
          Open the conversation
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-action="float-close"
          aria-label="Close the composer"
          title="Close the composer: the conversation's rail brings it back"
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      {children}
    </div>
  );
}
