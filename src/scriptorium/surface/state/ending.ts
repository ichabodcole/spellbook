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

/** The tooltip on a control the end has disabled (Save, Revert, the composer…). */
export const SESSION_ENDED = "The session has ended";

/** What a click that could no longer reach the daemon is answered with. */
export const ENDED_NOTICE =
  "The session has ended, so that did nothing. To keep working, ask the agent to reopen it.";

/**
 * Traffic the page sends ON ITS OWN — a resize persisting the layout, a
 * selection report, a version or comparison loading, the editor's buffer —
 * which after an end is simply dropped: no one asked for it.
 */
const AMBIENT = new Set<string>(["prefs.set", "select", "read", "diff", "edit"]);

/**
 * What becomes of a message sent after a deliberate end. ⛔ A HUMAN'S ACT IS
 * NEVER SWALLOWED: a control that does nothing on click is the defect, so the
 * controls that only write are disabled outright, and whatever still reaches
 * here (opening a document, switching a version, a note, a task) is answered
 * with `ENDED_NOTICE` rather than silence.
 */
export function sentAfterEnd(msg: { type: string; query?: string }): "drop" | "notice" {
  if (AMBIENT.has(msg.type)) return "drop";
  if (msg.type === "search" && !msg.query) return "drop";
  return "notice";
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
