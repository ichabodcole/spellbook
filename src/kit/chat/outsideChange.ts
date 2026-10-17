// "The file changed on disk": the pure half of the outside-change toast.
//
// The daemon reloads a document silently when the human has no unsaved edits.
// When they do, it flags the document `outsideChanged` and waits: Save would
// overwrite the file's new text, Revert would discard the buffer, and neither is
// the daemon's call. The flag is the signal; the toast is how the surface says it
// at the moment it flips, wherever the human is looking.
import type { DocView } from "../workspace/protocol";

/** The words of the toast: what changed, and what each way forward costs. */
export function outsideChangeToast(doc: DocView): { title: string; description: string } {
  return {
    title: `${doc.name} changed on disk`,
    description: doc.dirty
      ? "You have unsaved edits here. Reload takes the file's text and drops them; Keep leaves both until you decide."
      : "The file changed since this version was made. Reload takes the file's text; Keep leaves this version as it is.",
  };
}

/**
 * Which open documents have an unanswered outside change, as the surface has
 * seen it. A flag already up on first sight is news (a session restored over a
 * changed file waits on a decision nobody has seen), unlike a version already
 * present, which is only a baseline.
 */
export type OutsideWatch = {
  /**
   * A snapshot of the open document arrived. True when its flag has just gone up
   * and not been raised for it yet; a flag that goes down and up again is news again.
   */
  snapshot: (doc: DocView) => boolean;
};

export function createOutsideWatch(): OutsideWatch {
  const raised = new Set<string>();
  return {
    snapshot: (doc) => {
      if (!doc.outsideChanged) {
        raised.delete(doc.slug);
        return false;
      }
      if (raised.has(doc.slug)) return false;
      raised.add(doc.slug);
      return true;
    },
  };
}
