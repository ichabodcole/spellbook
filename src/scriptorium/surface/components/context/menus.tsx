// Menu pieces the list and the tree share — so a document gets the SAME
// actions wherever it is shown (E24: equal capabilities, and one vocabulary).
import { FolderInputIcon, FolderSearchIcon } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/ui/context-menu";
import type { MoveTarget } from "./model";

/** "Move to ▸" — the workspace and every set's folder. Moving between sets by drag needs both on screen; this does not. */
export function MoveToMenu({
  targets,
  onMove,
}: {
  targets: readonly MoveTarget[];
  onMove: (into: string) => void;
}) {
  if (targets.length === 0) return null;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <FolderInputIcon />
        Move to
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {targets.map((t) => (
          <ContextMenuItem key={t.path} onClick={() => onMove(t.path)} title={t.path}>
            <span className="max-w-64 truncate">{t.label}</span>
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** A drag carrying files from outside the page (Finder). */
export const carriesFiles = (dt: DataTransfer | null): boolean =>
  !!dt && Array.from(dt.types).includes("Files");

/**
 * The files a drop carries — folders left out: a dropped folder arrives as a
 * `File` whose text cannot be read, and E23 copies documents, not trees (add a
 * folder by path to link it instead).
 */
export function droppedFiles(dt: DataTransfer): { files: File[]; folders: string[] } {
  const files: File[] = [];
  const folders: string[] = [];
  const items = Array.from(dt.items ?? []);
  Array.from(dt.files).forEach((f, i) => {
    const entry = items[i]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) folders.push(f.name);
    else files.push(f);
  });
  return { files, folders };
}

/** "Reveal in Finder" on a Mac, the file manager's plain name elsewhere. */
const revealLabel = (): string =>
  /Mac/i.test(navigator.userAgent) ? "Reveal in Finder" : "Show in file manager";

/** The daemon opens the OS file manager at the path — a local app's affordance a web page alone cannot have. */
export function RevealItem({ onReveal }: { onReveal: () => void }) {
  return (
    <ContextMenuItem onClick={onReveal}>
      <FolderSearchIcon />
      {revealLabel()}
    </ContextMenuItem>
  );
}
