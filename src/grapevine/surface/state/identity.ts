// Identity and lurk/join (inventory I1–I7, R2). Storage is injected so the
// rules are testable without a browser: the alias persists globally, the mode
// is remembered PER CHANNEL and defaults to lurk, so browsing channels never
// silently joins you — joining is explicit.

import type { Mode } from "./types";

export type KV = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const ALIAS_KEY = "grapevine:alias";
export const modeKey = (channel: string) => `grapevine:mode:${channel}`;

/** I1 — the UI override, if one was ever set. Empty string when absent. */
export function loadAlias(kv: KV): string {
  return kv.getItem(ALIAS_KEY) || "";
}

/** I3 — trim; a non-empty alias is stored, an empty one REMOVES the override
 *  (not an empty-string one) so the next load falls back to /identity. */
export function commitAlias(kv: KV, raw: string): string {
  const alias = raw.trim();
  if (alias) kv.setItem(ALIAS_KEY, alias);
  else kv.removeItem(ALIAS_KEY);
  return alias;
}

/** I4 — join only when this channel was explicitly joined AND an alias
 *  resolved; otherwise lurk. */
export function initialMode(kv: KV, channel: string, alias: string): Mode {
  return kv.getItem(modeKey(channel)) === "join" && alias ? "join" : "lurk";
}

export function saveMode(kv: KV, channel: string, mode: Mode): void {
  kv.setItem(modeKey(channel), mode);
}

/** I6 — the next mode after a toggle, or null when the toggle is refused
 *  (lurk → join needs a non-blank alias). */
export function nextMode(mode: Mode, alias: string): Mode | null {
  if (mode === "lurk") return alias.trim() ? "join" : null;
  return "lurk";
}

/** I5 — the toggle's label. */
export function toggleLabel(mode: Mode): string {
  return mode === "join" ? "Joined — click to lurk" : "Join channel";
}

/** I5 — the toggle is disabled in lurk while the alias is blank. */
export function toggleDisabled(mode: Mode, alias: string): boolean {
  return mode === "lurk" && !alias.trim();
}

/** R2 / I7 — join registers named + human presence; lurk registers NONE
 *  (`&lurk=1`), so browsing is invisible to every count. `since` is the
 *  highest id seen, so a reconnect replays only the gap (N2). */
export function tailUrl(channel: string, since: number, mode: Mode, alias: string): string {
  const params = mode === "join" && alias ? `&as=${encodeURIComponent(alias)}&human=1` : "&lurk=1";
  return `/channels/${encodeURIComponent(channel)}/tail?since=${since}${params}`;
}

/** E1 — the status-bar text once the stream is hot. */
export function subscribedStatus(mode: Mode, channel: string, alias: string): string {
  return mode === "join" ? `joined ${channel} as ${alias}` : `subscribed to ${channel}`;
}
