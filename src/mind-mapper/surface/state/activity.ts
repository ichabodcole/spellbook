// R4 ACT1 — the agent-activity vocabulary, pure half. `stalled` is
// daemon-synthesized only (received older than the TTL, Contract 9 R4
// supersession 2): it PERSISTS until an agent write resolves it, so the
// badge rules below are load-bearing — a stalled badge must never wear the
// thinking pulse (false-liveness) and must never be cleared by the client's
// thinking TTL backstop (there is no timer behind it to race).

import type { AgentActivityState } from "../types";

const ACTIVITY_STATES: readonly AgentActivityState[] = ["received", "thinking", "idle", "stalled"];

// The wire guard: unknown vocabulary drops silently (a future state must
// never crash the board), known strings narrow.
export function parseActivityState(value: unknown): AgentActivityState | null {
  return ACTIVITY_STATES.includes(value as AgentActivityState)
    ? (value as AgentActivityState)
    : null;
}

// What the conversation panel shows for a given activity state. `received`
// reads as engagement (the pulse sits where the reply will land); `stalled`
// is its own STATIC attention branch; `idle` clears.
export type AgentBadge = "thinking" | "stalled" | null;

export function badgeFor(state: AgentActivityState): AgentBadge {
  if (state === "idle") return null;
  if (state === "stalled") return "stalled";
  return "thinking";
}

// Whether the client-side TTL backstop applies: only the pulse gets one —
// stalled arrived with no server timer behind it and persists until an agent
// write resolves it, so the client must not decay it to blank either.
export function badgeHasClientTtl(badge: AgentBadge): boolean {
  return badge === "thinking";
}
