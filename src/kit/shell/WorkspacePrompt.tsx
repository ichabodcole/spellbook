// The first thing a session without a workspace shows: a dialog asking for the
// folder its files will live in (kit-workspace-set). It cannot be dismissed, since
// nothing can be added or made until a workspace is set; the daemon refuses
// those acts too, so the dialog is the way through, not the guard.
//
// The folder is typed with the kit's path completion (`AddPath`), or chosen in
// the OS's own picker, which the daemon opens. Setting it is the human's act:
// the agent hears of it, and the context becomes what the folder holds.

import { useEffect, useState } from "react";
import { AddPath } from "../context/AddPath.tsx";
import type { Listing } from "../context/daemonClient.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/index.ts";

export function WorkspacePrompt({
  appTitle,
  listDir,
  onSet,
  onPick,
  refusal,
  onChoosing,
}: {
  /** The app as the human reads its name. */
  appTitle: string;
  listDir: (path: string) => Promise<Listing>;
  /** Set the folder typed (absolute or `~`). Resolves, or rejects with the daemon's refusal. */
  onSet: (path: string) => Promise<unknown>;
  /** Open the OS's folder picker; the daemon sets what comes back. */
  onPick: () => void;
  /** A refusal that came back from the picker, which answers no request of its own. */
  refusal?: string | null;
  /**
   * Told when the prompt opens and when it goes: while it is open the human is
   * choosing a workspace, and the agent's own set is refused, not made under
   * their hand.
   */
  onChoosing?: (open: boolean) => void;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: on mount and unmount only
  useEffect(() => {
    onChoosing?.(true);
    return () => onChoosing?.(false);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = error ?? refusal ?? null;
  return (
    // Open for as long as there is no workspace: Escape and the backdrop do
    // nothing, and the dialog goes when the snapshot carries one.
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        data-slot="workspace-prompt"
        showCloseButton={false}
        className="gap-3 sm:max-w-md"
      >
        <DialogTitle>Choose a workspace</DialogTitle>
        <DialogDescription>
          The workspace is the folder this {appTitle} session's files live in. Its folders and
          documents become the context, and what you make or drop in goes into it. Nothing can be
          added until one is chosen.
        </DialogDescription>
        <AddPath
          listDir={listDir}
          foldersOnly
          autoFocus
          openDown
          verb="sets"
          placeholder="Workspace folder…"
          onPick={() => {
            setError(null);
            onPick();
          }}
          onAdd={(path) => {
            if (busy) return;
            setBusy(true);
            setError(null);
            onSet(path).then(
              () => setBusy(false),
              (e: unknown) => {
                setBusy(false);
                setError(e instanceof Error ? e.message : String(e));
              },
            );
          }}
          className="border-t-0 p-0"
        />
        {shown && (
          <p role="alert" className="text-xs leading-relaxed text-attention">
            {shown}
          </p>
        )}
        <p className="text-xs text-ink-faint">
          Type a folder's path (Tab completes it), or choose one with the folder button. The agent
          can set it too.
        </p>
      </DialogContent>
    </Dialog>
  );
}
