// The human's End session (Cole, 2026-10-01): what the page does once the
// daemon has said it is ending, and what the confirmation says first. Pure, so
// it is tested rather than trusted; the button and the socket are in App and
// useDaemon.
import type { ClosedBy, DocView } from "../../backend/protocol";
import type { Connection } from "./useDaemon";

/**
 * What a closed socket means. ⛔ ONLY THE DAEMON'S OWN `closed` FRAME makes it
 * an end: a daemon that vanishes says nothing, and might be back (a restart, a
 * laptop waking), so the page keeps retrying as it always has. After a
 * deliberate end there is nothing to retry for — the session is not coming
 * back unless someone reopens it, and that is a new daemon on a new port.
 */
export function afterSocketClose(endedBy: ClosedBy | null): {
  connection: Connection;
  retry: boolean;
} {
  return endedBy ? { connection: "ended", retry: false } : { connection: "closed", retry: true };
}

/** Who ended it, for the "Session ended" label's tooltip. */
export function endedTitle(by: ClosedBy): string {
  switch (by) {
    case "human":
      return "You ended this session";
    case "agent":
      return "The agent ended this session";
    case "timeout":
      return "This session closed after it sat idle";
  }
}

/**
 * The modal's warning when ending would leave edits out of the files on disk.
 * Every unsaved document counts, not just the open one — each file is as
 * stale as the others — and the open one is named first, because it is the
 * one the human is looking at. Nothing is lost (the session keeps its
 * versions), which is why ending is still allowed.
 */
export function unsavedWarning(
  docs: readonly Pick<DocView, "slug" | "name" | "active" | "dirty">[],
  openDoc: string | null,
): string | null {
  const dirty = docs
    .filter((d) => d.dirty)
    .sort((a, b) => Number(b.slug === openDoc) - Number(a.slug === openDoc));
  const first = dirty[0];
  if (!first) return null;
  const kept =
    "They stay in this session (the agent can bring it back with open --restore), but they won't be in your";
  if (dirty.length === 1)
    return `v${first.active} of ${first.name} has unsaved changes. ${kept} file.`;
  return `${dirty.length} documents have unsaved changes (${dirty.map((d) => d.name).join(", ")}). ${kept} files.`;
}
