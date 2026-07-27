// R11 SEAM 2 (render half) — tie the agent's activity to a SPECIFIC message.
//
// With the jobs + ingest panels gone (SEAM 5), "the agent is working on this"
// has to be unmissable in the one place things now go: the chat stream. The
// pulse therefore lands ON the message being worked, not in a new panel — a
// new panel would repeat the exact mistake R11 is undoing.
//
// The wire half is daedalus's: `agent.activity` gains an additive `messageId`
// (SEAM 2 cut B). This module is written so BOTH cuts work — a payload with a
// messageId is used verbatim; a payload without one degrades to cut A (the
// latest human message owns the current state). The degrade is honest but
// wrong the moment the agent works an older message, which is why the field is
// the design and this is only the floor.

import type { Message } from "../types";
import type { AgentBadge } from "./activity";

// Which message the currently-lit badge belongs to. Null = unattributable, and
// the panel then renders the badge at the bottom of the log (today's behavior)
// — one pulse either way, never two saying the same thing.
export function activityOwnerId(
  activity: { messageId: string | null } | null,
  badge: AgentBadge,
  messages: Message[],
): string | null {
  if (!badge) return null;
  const named = activity?.messageId;
  if (named && messages.some((m) => m.id === named)) return named;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.who === "user") return m.id;
  }
  return null;
}

// The on-bubble copy. There is deliberately NO `done` state: the agent's reply
// IS the completion signal (ratified R11 SEAM 2) — one fewer primitive, and
// it's true. `clearsActivity` below is that rule, pinned.
export const ACTIVITY_ROW_LABEL: Record<Exclude<AgentBadge, null>, string> = {
  thinking: "working on this…",
  stalled: "took this in, then went quiet — may be stuck",
};

// A reply is done-thinking, whatever the activity stream last said (the local
// mirror of the daemon's terminal-act resolution, Contract 9 R4 ACT1).
export function clearsActivity(message: Message | undefined): boolean {
  return message?.who === "agent";
}
