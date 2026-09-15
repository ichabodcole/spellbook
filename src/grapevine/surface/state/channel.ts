// Channel selection (inventory C1–C4). The channel is read from the URL hash
// so one page serves any channel: /watch#roundtable.

/** C1 — no hash and a bare `#` both mean `lobby`. */
export function channelFromHash(hash: string): string {
  return decodeURIComponent((hash || "#lobby").slice(1)) || "lobby";
}

/** C4 — the rail row's link target. */
export function channelHref(name: string): string {
  return `#${encodeURIComponent(name)}`;
}

/** C2 — the tab title. */
export function pageTitle(channel: string): string {
  return `grapevine · ${channel}`;
}
