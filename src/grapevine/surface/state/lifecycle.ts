// Channel lifecycle from the surface (inventory L1–L6, added 2026-09-05 by the
// UX branch): the archived filter and its persisted key, the create dialog's
// outcome mapping, the `from` a topic edit signs with, and the intent that
// survives the reload a channel switch causes (C3). Pure and storage-injected,
// like identity.ts; the hook wires them to fetch, localStorage and the hash.

import type { KV } from "./identity";
import type { ChannelRow, Mode } from "./types";

/** L4 — the archived filter is remembered per browser, default off. */
export const SHOW_ARCHIVED_KEY = "grapevine:show-archived";

export function loadShowArchived(kv: KV): boolean {
  return kv.getItem(SHOW_ARCHIVED_KEY) === "1";
}

export function saveShowArchived(kv: KV, on: boolean): void {
  if (on) kv.setItem(SHOW_ARCHIVED_KEY, "1");
  else kv.removeItem(SHOW_ARCHIVED_KEY);
}

/** L4 — the rows the rail shows. Archived rows are hidden unless the filter is
 *  on; the CURRENT channel is always shown even when archived, because the URL
 *  hash names it and hiding it would strand the reader. Order is preserved. */
export function visibleChannels(
  rows: ChannelRow[],
  current: string,
  showArchived: boolean,
): ChannelRow[] {
  if (showArchived) return rows;
  return rows.filter((c) => !c.archived || c.name === current);
}

/** L4 — how many rows the filter is hiding right now (never the current one). */
export function hiddenArchivedCount(rows: ChannelRow[], current: string, showArchived: boolean) {
  return rows.length - visibleChannels(rows, current, showArchived).length;
}

/** L2 — what the create dialog does with the daemon's answer to POST /channels.
 *  409 `archived` is the one the dialog must name and offer a way out of. */
export type CreateOutcome =
  | { kind: "created" }
  | { kind: "archived" }
  | { kind: "error"; message: string };

export function createOutcome(status: number, body: { error?: unknown } | null): CreateOutcome {
  if (status >= 200 && status < 300) return { kind: "created" };
  if (status === 409 && body?.error === "archived") return { kind: "archived" };
  const message = typeof body?.error === "string" ? body.error : `HTTP ${status}`;
  return { kind: "error", message };
}

/** L2 — the create dialog's message for a refused name. */
export function createArchivedText(name: string): string {
  return `“${name}” exists but is archived. Unarchive it instead?`;
}

/** L3 — the alias a topic edit is signed with: the joined alias, or the
 *  persisted default from /identity while lurking. Null when neither exists. */
export function topicFrom(mode: Mode, alias: string, identityAlias: string | null): string | null {
  if (mode === "join" && alias.trim()) return alias.trim();
  const d = identityAlias?.trim();
  return d ? d : null;
}

/** L3 — whether the header's topic can be edited, and why not. Archived wins
 *  over a missing identity: the daemon refuses the write regardless. */
export function topicEditState(
  archived: boolean,
  from: string | null,
): { disabled: false } | { disabled: true; reason: string } {
  if (archived) return { disabled: true, reason: "archived — read-only" };
  if (!from)
    return {
      disabled: true,
      reason: "join the channel (or set a default alias) to edit the topic",
    };
  return { disabled: false };
}

/** L3 — a rail row's _Edit topic_ for a channel that is not the current one
 *  switches to it (a reload, C3) and must survive that reload: the intent is
 *  parked in storage, keyed by channel, and taken exactly once on init. */
export const INTENT_KEY = "grapevine:intent";
export type Intent = "edit-topic";

export function parkIntent(kv: KV, channel: string, intent: Intent): void {
  kv.setItem(INTENT_KEY, JSON.stringify({ channel, intent }));
}

export function takeIntent(kv: KV, channel: string): Intent | null {
  const raw = kv.getItem(INTENT_KEY);
  if (!raw) return null;
  kv.removeItem(INTENT_KEY);
  try {
    const j = JSON.parse(raw) as { channel?: unknown; intent?: unknown };
    return j.channel === channel && j.intent === "edit-topic" ? "edit-topic" : null;
  } catch {
    return null;
  }
}

/** L3c — the editor must not outlive the channel's writability: when a poll
 *  flips the channel to archived while the editor is open, the edit is
 *  cancelled (and, at commit time, refused) rather than landing a topic frame
 *  on a read-only channel. The daemon does not guard `PUT /topic`; this is the
 *  surface's fence. */
export function shouldCancelEdit(editing: boolean, disabled: boolean): boolean {
  return editing && disabled;
}

/** L2c — what the create dialog promises for a typed topic. `POST /channels`
 *  sets a topic only where none exists, and the create does NOT follow with a
 *  PUT — the CLI's `open --topic` does not clobber either. So for a channel the
 *  rail already lists the promise is conditional, and names the act that does
 *  replace a topic. */
export function createTopicHint(existed: boolean, signer: string | null): string {
  const who = signer ?? "system";
  return existed
    ? `Set as ${who}, if this channel has no topic yet. Use Edit topic to replace one.`
    : `Set as ${who}.`;
}

/** L1 — the context menu's archive verb for a row. */
export function archiveLabel(archived: boolean): "Archive" | "Unarchive" {
  return archived ? "Unarchive" : "Archive";
}
