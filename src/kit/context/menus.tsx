// Menu pieces the list and the tree share, so a document gets the same actions
// wherever it is shown.
import { FolderInputIcon, FolderSearchIcon, Trash2Icon } from "lucide-react";
import { SVG_REFUSED } from "../lib/docFormat.ts";
import { ContextMenuItem, ContextMenuSeparator } from "../ui/context-menu.tsx";
import type { MenuAction } from "./menuActions.ts";

/**
 * "Move to…": opens the one dialog (`MoveToDialog`) that lists the workspace,
 * every set and every folder, searchable. The same item on every row, so a
 * document can always go anywhere, out of a set as well as into one.
 */
export function MoveToItem({ onAsk }: { onAsk: () => void }) {
  return (
    <ContextMenuItem onClick={onAsk}>
      <FolderInputIcon />
      Move to…
    </ContextMenuItem>
  );
}

/** The app's own actions, after a divider. Nothing is drawn for none. */
export function AppMenuItems({ actions }: { actions: readonly MenuAction[] }) {
  if (actions.length === 0) return null;
  return (
    <>
      <ContextMenuSeparator />
      {actions.map((a) => (
        <ContextMenuItem
          key={a.id}
          disabled={a.disabled}
          variant={a.destructive ? "destructive" : "default"}
          onClick={a.onSelect}
        >
          {a.icon}
          {a.label}
        </ContextMenuItem>
      ))}
    </>
  );
}

/** A drag carrying files from outside the page (Finder). */
export const carriesFiles = (dt: DataTransfer | null): boolean =>
  !!dt && Array.from(dt.types).includes("Files");

/**
 * The files a drop carries, folders set apart: a dropped folder arrives as a
 * `File` whose text cannot be read. The kit copies documents, not trees; a
 * folder is added with the picker or by path, which links it instead.
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

/** What the notice says about a drop the sidebar will not take in full. */
export function dropNotice(
  skipped: readonly string[],
  folders: readonly string[],
  svg: readonly string[] = [],
): string | null {
  const said: string[] = [];
  if (skipped.length) said.push(`Not documents or images, so not copied: ${skipped.join(", ")}.`);
  if (svg.length) said.push(`${svg.join(", ")}: ${SVG_REFUSED}`);
  if (folders.length)
    said.push(
      `A folder cannot be dropped (${folders.join(", ")}). Use the folder button below to pick it, or type its path, and it is linked instead of copied.`,
    );
  return said.length ? said.join(" ") : null;
}

/** "Reveal in Finder" on a Mac, the file manager's plain name elsewhere. */
const revealLabel = (): string =>
  /Mac/i.test(navigator.userAgent) ? "Reveal in Finder" : "Show in file manager";

/** The daemon opens the OS file manager at the path: a local app's affordance a web page alone cannot have. */
export function RevealItem({ onReveal }: { onReveal: () => void }) {
  return (
    <ContextMenuItem onClick={onReveal}>
      <FolderSearchIcon />
      {revealLabel()}
    </ContextMenuItem>
  );
}

/**
 * Delete, last in a row's menu after a divider: the human's alone, and only ever
 * a move to the Trash, asked about first. The menu item only asks; the dialog
 * names what goes.
 */
export function DeleteItem({ onDelete }: { onDelete: () => void }) {
  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onClick={onDelete}>
        <Trash2Icon />
        Move to Trash…
      </ContextMenuItem>
    </>
  );
}
