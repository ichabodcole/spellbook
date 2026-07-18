// V1.x Claim C — the header presence dot's pure state rule. Two layers kept
// deliberately separate: the browser's OWN socket (ConnStatus — the
// measurement instrument) answers "can I see the daemon at all", and the
// agents count (open SSE tails, agents-only by ruling) answers "is anyone
// on the other side of the board". Collapsing them is exactly the ambiguity
// finding 7 kills.

import type { ConnStatus } from "./useProjectState";

export type PresenceDot = "unreachable" | "connected-no-agent" | "agent-here";

export function dotState(status: ConnStatus, agents: number): PresenceDot {
  // A connecting socket has no live measurement either — until it opens,
  // the daemon is unreachable as far as this board can honestly claim.
  if (status !== "open") return "unreachable";
  return agents > 0 ? "agent-here" : "connected-no-agent";
}
