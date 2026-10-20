// What the chat's rail says while the conversation column is collapsed: whether
// the agent has said something the human has not seen, and whether something of
// the human's still waits on the agent. DOM-free, so the rule is a
// test; `WorkspaceShell` keeps the mark of what was seen.
//
// The unseen signal is the agent's own lines, nothing else: a system line (a save, a
// revert) is the human's own doing, and the human's lines they wrote themselves.
// The mark is a message id rather than a count or a time, so a trimmed log or two
// lines in the same millisecond cannot fool it.

import { owedSummary } from "../chat/noteWaiting.ts";
import { type BadgeKind, badgeFor, labelOf } from "../chat/WaitingBadge.tsx";
import type { Message, NoteWaiting, Waiting } from "../workspace/protocol";

/** The id of the newest message, the mark of everything seen up to it; null for none. */
export function lastMessageId(chat: readonly Pick<Message, "id">[]): string | null {
  return chat.at(-1)?.id ?? null;
}

/**
 * Whether the agent has spoken after `seen` (the newest message id when the column
 * was last open; null when the log was empty then). A mark no longer in the log
 * (trimmed away) counts every agent line kept as unseen, which errs towards
 * telling.
 */
export function unseenFromAgent(
  chat: readonly Pick<Message, "id" | "from">[],
  seen: string | null,
): boolean {
  const from = seen === null ? 0 : chat.findIndex((m) => m.id === seen) + 1;
  // Not found (trimmed): findIndex is -1, so `from` is 0 and the whole log is new.
  return chat.slice(from).some((m) => m.from === "agent");
}

/**
 * Whether anything waits on the agent, as one mark for the chat's rail: the
 * human's message (`waiting`) and the notes owed an answer, read through the
 * same rules as their own badges (`badgeFor`, `owedSummary`). Null when nothing
 * waits. It is the daemon's state drawn once more, never a flag of its own, so
 * it holds exactly as long as the wait does.
 *
 * One mark for both, so it says the most urgent: stuck if either is, then
 * unheard, then working. A pulse beside a stuck or unheard wait would be the
 * false liveness the static badges exist to refuse. Its words name each wait,
 * so "may be stuck" is never said of the wrong one.
 */
export function waitingOnAgent(
  waiting: Pick<Waiting, "badge" | "acknowledged"> | null | undefined,
  notes: readonly NoteWaiting[],
  agentListening: boolean,
): { badge: BadgeKind; label: string } | null {
  const message = waiting ? badgeFor(waiting, agentListening) : null;
  const owed = owedSummary(notes, agentListening);
  const badges = [message, owed?.badge].filter((b): b is BadgeKind => b != null);
  if (badges.length === 0) return null;
  const badge = LOUDNESS.find((b) => badges.includes(b)) as BadgeKind;
  const label = [message && `your message: ${labelOf(message)}`, owed?.label]
    .filter(Boolean)
    .join("; ");
  return { badge, label };
}

const LOUDNESS: readonly BadgeKind[] = ["stalled", "unheard", "working"];
