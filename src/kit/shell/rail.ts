// What the chat's rail says while the conversation column is collapsed: whether
// the agent has said something the human has not seen. DOM-free, so the rule is a
// test; `WorkspaceShell` keeps the mark of what was seen.
//
// The signal is the agent's own lines, nothing else: a system line (a save, a
// revert) is the human's own doing, and the human's lines they wrote themselves.
// The mark is a message id rather than a count or a time, so a trimmed log or two
// lines in the same millisecond cannot fool it.

import type { Message } from "../workspace/protocol";

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
