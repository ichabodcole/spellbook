// What the page says when a followed link does not open, ported from Story
// Studio's kit (`linkRefusal` in its daemonClient). Pure, so the wording is
// tested here rather than read off a toast.
//
// ⛔ A FILE THAT DOES NOT EXIST IS NOT "NOT IN THIS SET". The old toast said
// "…which is not in this set" for both a missing file and one outside the
// context, so the human went looking for a folder to add when there was no file
// at all. Missing names the path tried; outside names the folder to add.
import type { ServerMsg } from "../../backend/protocol";

type LinkTarget = Extract<ServerMsg, { type: "link.target" }>;

/** The folder a path sits in, as a path. */
const folderOf = (path: string) => path.slice(0, path.search(/[\\/][^\\/]*$/)) || "/";

/** An absolute path, POSIX or Windows: a `tried` worth showing as a place. */
const isAbsolutePath = (p: string) => /^([\\/]|[A-Za-z]:[\\/])/.test(p);

/**
 * The toast for a `link.target` frame, naming the target as written without its
 * `?rel=` query or `#anchor`; null when the link opened (the document showing
 * is the answer).
 */
export function linkRefusal(f: LinkTarget): string | null {
  const written = f.target.split(/[?#]/)[0] || f.target;
  switch (f.state) {
    case "in-bundle":
      return null;
    case "outside":
      return `${written} is outside this session's context. Add its folder, ${folderOf(f.path ?? "")}, to open it here.`;
    case "folder":
      return `${written} is a folder, not a document: ${f.path}.`;
    case "missing":
      if (!f.tried) return `That link points at ${written}, which does not exist.`;
      return isAbsolutePath(f.tried)
        ? `That link points at ${written}, which does not exist: nothing at ${f.tried}.`
        : `That link points at ${written}, which does not exist: no document here is named ${f.tried}.`;
  }
}
