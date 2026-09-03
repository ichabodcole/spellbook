// derive.ts — the SURFACE half of what used to be surface/state/reduce.ts.
// Pure view-side derivations over state the daemon owns: no mutators, no
// verdicts. The mutating half (and applyAgentMsg, seams Contract 13's subject)
// lives daemon-side at scripts/reduce.ts. Split at the SYMBOL grain, ruled
// comms #1124; the four exports here are exactly the set the surface imports.
import type { ItemKind, LibraryItem, Message } from "../../shared/types";

export function itemsByKind(items: LibraryItem[], kind: ItemKind | "all"): LibraryItem[] {
  const live = items.filter((i) => !i.archived);
  return kind === "all" ? live : live.filter((i) => i.kind === kind);
}

// Mark filters compose as a UNION: with none active, everything passes; with one
// or more active, an item passes if it carries ANY active mark. (pinned ⇄ the
// item's `canonical` flag — see the marks vocabulary.)
export type MarkFilter = { liked: boolean; starred: boolean; pinned: boolean };
export function matchesMarks(it: LibraryItem, f: MarkFilter): boolean {
  if (!f.liked && !f.starred && !f.pinned) return true;
  return (f.liked && it.liked) || (f.starred && it.starred) || (f.pinned && it.canonical);
}

export function agentRepliedSince(messages: Message[], sinceTs: number): boolean {
  return messages.some((m) => m.who === "agent" && m.ts > sinceTs);
}
