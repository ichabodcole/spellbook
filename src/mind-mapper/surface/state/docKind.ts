// R4 K1 — the doc-kind rendering vocabulary, pure half. The old closed
// DocKind union died with the ingest defaults: kind is a free-form string
// when asserted, null when nobody asserted one — and null renders as
// ABSENCE (no badge), never an "unclassified" chip (game-board honesty).
//
// The house kinds keep their tier-vocabulary tints (bible = canon, story =
// story-local, ramble = pending — raw capture stays staging-colored);
// anything else someone asserts gets a neutral plate rather than a crash or
// an invented color. Literal class strings on purpose (@source sees only
// literal text); this module is the one home for the lookup — ContextRail
// cards and MessageBubble doc chips both import it.

export const KIND_BADGE: Record<string, string> = {
  ramble: "bg-pending/20 text-pending",
  story: "bg-story-local/20 text-story-local",
  bible: "bg-canon/20 text-canon",
};

// The doc-REFERENCE tint (MessageBubble chips): the chip renders the doc's
// title regardless of kind, so an untyped doc needs a neutral plate, not
// absence.
export const NEUTRAL_BADGE = "bg-surface-raised text-ink-dim";

// The kind BADGE class (ContextRail cards): null kind = null = render NO
// badge at all; a known kind gets its house tint; an unknown asserted kind
// gets the neutral plate.
export function kindBadgeClass(kind: string | null): string | null {
  if (kind === null) return null;
  return KIND_BADGE[kind] ?? NEUTRAL_BADGE;
}

// Who asserted the kind, worn by the badge: user-asserted gets a solid
// border, agent-set a dashed one (the staging vocabulary — dashed = not yet
// human-vouched), null (legacy rows, honestly unattributed) stays neutral —
// no border, no claim.
export function kindAuthorClass(author: "user" | "agent" | null): string {
  if (author === "user") return "border border-current/50";
  if (author === "agent") return "border border-dashed border-current/50";
  return "";
}

export function kindAuthorTitle(author: "user" | "agent" | null): string | undefined {
  if (author === "user") return "kind asserted by you";
  if (author === "agent") return "kind set by the agent";
  return undefined;
}
