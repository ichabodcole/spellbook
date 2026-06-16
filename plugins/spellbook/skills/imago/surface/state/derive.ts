// surface/state/derive.ts
// Pure view-helpers derived from ImagoState — no stored duplicates of these.
import type { ImagoState } from "./types";

// "a", "b", "c", … from a variant's index within its batch.
export function variantLabel(i: number): string {
  return String.fromCharCode(97 + i);
}

// The agent's presence, derived so it can't drift from the thread:
//   asking — handoff is set, OR the last message is an unanswered question
//   working — the agent reported status.busy
//   idle — otherwise
export type Presence = "idle" | "working" | "asking";
export function presence(s: ImagoState): Presence {
  const last = s.conversation[s.conversation.length - 1];
  const unanswered = !!last && last.role === "agent" && last.kind === "question";
  if (s.handoff.trim() || unanswered) return "asking";
  if (s.status.busy) return "working";
  return "idle";
}
