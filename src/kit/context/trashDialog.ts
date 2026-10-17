// What the Delete dialog says, from the daemon's preview of what would go. Pure,
// so the wording (the counts, the warnings) is pinned by tests without a DOM.
//
// The dialog names what goes, says it goes to the Trash (so it can be put back
// from there), and warns about what exists only in this session: unsaved edits,
// and versions the file on disk never had. Those are kept in the session, not
// thrown away, and the warning says so plainly.
import type { TrashPreview } from "../workspace/protocol";

/** The dialog's danger tone, as the version delete uses it. */
export const TRASH_CONFIRM_CLASS = "bg-danger text-bg hover:bg-danger/90";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a.md", "a.md and b.md", "a.md, b.md and 2 more". */
export function listNames(names: readonly string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

/** The base name of the path being deleted. */
const nameOf = (p: TrashPreview) => p.path.split("/").filter(Boolean).at(-1) ?? p.path;

export type TrashDialog = {
  title: string;
  message: string;
  /** Null when nothing exists only in the session. */
  warning: string | null;
  confirmLabel: string;
};

export function trashDialog(p: TrashPreview): TrashDialog {
  // A bundle is one item to the human: named as its row names it, its files
  // not counted out.
  const name = p.bundle ? p.bundle.name : nameOf(p);
  const atLeast = p.truncated ? "at least " : "";
  const contents =
    p.files + p.folders === 0
      ? "It is empty."
      : p.folders > 0
        ? `It holds ${atLeast}${plural(p.files, "file")} in ${plural(p.folders, "folder")}.`
        : `It holds ${atLeast}${plural(p.files, "file")}.`;
  const message = p.link
    ? `${p.shown} is a link: the link goes to the Trash, not what it points at.`
    : p.bundle
      ? `The ${p.bundle.label} ${p.bundle.name} goes to the Trash whole, with everything it holds. You can put it back from the Trash.`
      : p.dir
        ? `The folder ${p.shown} and everything in it go to the Trash. ${contents} You can put it back from the Trash.`
        : p.sidecar
          ? `${p.shown} and its description, ${p.sidecar.split("/").at(-1)}, go to the Trash. You can put them back from there.`
          : `${p.shown} goes to the Trash. You can put it back from there.`;

  // A bundle's document is its main file: named for the bundle.
  const docName = (d: { name: string }) => (p.bundle ? p.bundle.name : d.name);
  const warnings: string[] = [];
  const unsaved = p.docs.filter((d) => d.unsaved).map(docName);
  if (unsaved.length > 0)
    warnings.push(
      `${listNames(unsaved)} ${unsaved.length === 1 ? "has" : "have"} unsaved edits: they stay in this session, not in the file.`,
    );
  const versioned = p.docs.filter((d) => d.versions > 1);
  const first = versioned[0];
  if (first)
    warnings.push(
      versioned.length === 1
        ? `${docName(first)} has ${plural(first.versions, "version")} in this session; they are kept here, not in the Trash.`
        : `${listNames(versioned.map(docName))} have versions in this session; they are kept here, not in the Trash.`,
    );
  const open = p.docs.find((d) => d.open);
  if (open) warnings.push(`${docName(open)} is open, and closes.`);

  return {
    title: `Move ${name} to the Trash?`,
    message,
    warning: warnings.length > 0 ? warnings.join(" ") : null,
    confirmLabel: "Move to Trash",
  };
}
