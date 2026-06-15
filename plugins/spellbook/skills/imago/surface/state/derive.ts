// surface/state/derive.ts
// Pure view-helpers derived from ImagoState — no stored duplicates of these.
import type { ImagoState, Variant } from "./types";

// "a", "b", "c", … from a variant's index within its batch.
export function variantLabel(i: number): string {
  return String.fromCharCode(97 + i);
}

// The Variant currently on the canvas (the `focus`), or undefined when the blank
// "new image" frame is showing. The base image an added layer composites onto.
export function focusedVariant(s: ImagoState): Variant | undefined {
  const f = s.focus;
  if (!f) return undefined;
  return s.batches.find((b) => b.id === f.batchId)?.variants.find((v) => v.id === f.variantId);
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
