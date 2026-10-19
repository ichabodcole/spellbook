// What the question before a change of workspace says (kit-workspace-set). The
// tree then shows only what the new folder holds, so a document outside it leaves
// the tree: one with unsaved edits is named, as the Trash's question names one
// (`context/trashDialog.ts`), because its edits stay in the session and not in its
// file. The human's own change and the agent's ask put the same question; the
// agent's says who is asking.

import { listNames } from "../context/trashDialog.ts";
import type { DocView } from "../workspace/protocol";

export type WorkspaceChangeDialog = {
  title: string;
  message: string;
  warning: string | null;
  confirmLabel: string;
};

/** `~` and `~/…` read against the home folder; anything else as it is, without a trailing slash. */
function expand(path: string, home: string | null): string {
  const p = path.replace(/\/+$/, "") || "/";
  if (home === null) return p;
  if (p === "~") return home;
  return p.startsWith("~/") ? `${home}${p.slice(1)}` : p;
}

/** Whether `p` is `root` or inside it. */
const within = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export function workspaceChangeDialog(opts: {
  /** The folder asked for, as typed or as the agent sent it. */
  to: string;
  /** The session's documents, from the snapshot. */
  docs: readonly Pick<DocView, "name" | "original" | "dirty">[];
  /** Who asks: the human's own change, or the agent's ask. */
  by: "human" | "agent";
  /** The user's home folder, for a path typed with `~`. */
  home: string | null;
  /** The folder as the question shows it. */
  shown?: string;
}): WorkspaceChangeDialog {
  const to = expand(opts.to, opts.home);
  const shown = opts.shown ?? opts.to;
  const leaving = opts.docs.filter((d) => d.dirty && !within(d.original, to)).map((d) => d.name);
  const unsaved =
    leaving.length === 0
      ? null
      : `${listNames(leaving)} ${leaving.length === 1 ? "has" : "have"} unsaved edits and ${
          leaving.length === 1 ? "leaves" : "leave"
        } the tree: the edits stay in this session, not in ${leaving.length === 1 ? "its file" : "their files"}, until ${
          leaving.length === 1 ? "it is" : "they are"
        } back in the context.`;
  return {
    title: opts.by === "agent" ? "The agent asks to change the workspace" : "Change the workspace?",
    message: `The context will show what ${shown} holds, and none of what it shows now. No file is moved or deleted, and a document that leaves the tree keeps its versions in this session.`,
    warning: unsaved,
    confirmLabel: "Change workspace",
  };
}
