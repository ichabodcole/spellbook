/**
 * Paths on disk: realpaths, the workspace's overlap with a set, a tree's hash,
 * what moved with what, and the refusals of a place inside a bundle. Tier 0
 * of the session parts (docs/architecture/workspace-session.md).
 */

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { type BundleType, bundleOf, isMemberDir } from "../../lib/bundles.ts";
import type { Overlap } from "../doctor";
import type { ContextEntry } from "../protocol";
import { SessionError } from "./errors.ts";
import { bundleNameAt, contentHash, tilde } from "./names.ts";

/** Whether `p` is a directory now (false when it is gone or unreadable). */
export function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** An entry's root realpath, as it was when the entry was added. */
export function rootReal(e: ContextEntry): string {
  return e.realRoot ?? realOr(e.root);
}

/** A path's realpath, or the path itself when it cannot be resolved (gone). */
export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The set (mirrored entry) whose folder is `workspace` or holds it, compared by
 * realpath, or null. The user's rule of 2026-10-06: neither may sit inside the
 * other's folder in a way that makes one file belong to both. A set INSIDE the
 * workspace is not an overlap: the workspace is not mirrored, so the set's
 * files show once, in the set.
 */
export function overlapOf(workspace: string, context: readonly ContextEntry[]): Overlap | null {
  const ws = realOr(workspace);
  for (const e of context) {
    if (e.membership !== "mirrored") continue;
    const root = rootReal(e);
    if (ws === root || ws.startsWith(root + sep))
      return { label: e.label, root: e.root, same: ws === root };
  }
  return null;
}

/** An overlap with its paths as the app shows them, for a chat line or a finding. */
export function shownOverlap(o: Overlap, workspace: string): Overlap & { workspace: string } {
  return { ...o, root: tilde(o.root), workspace: tilde(workspace) };
}

/** What a move or rename moved: the item, and an image's description beside it. */
export const movedPairs = (
  from: string,
  to: string,
  sidecar: string | null,
  sidecarTo: string | null,
): (readonly [string, string])[] =>
  sidecar && sidecarTo
    ? [
        [from, to],
        [sidecar, sidecarTo],
      ]
    : [[from, to]];

/**
 * What a path holds, as one hash: a file's text (`contentHash`, as a
 * description's undo has always compared it), or a folder's every name, kind
 * and content, in order. What an undo of a made thing compares, so it removes
 * nothing that was written into since.
 */
export function treeHash(abs: string): string {
  if (!lstatSync(abs).isDirectory()) return contentHash(readFileSync(abs, "utf8"));
  const parts: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        parts.push(`${r}/`);
        walk(p, r);
      } else if (st.isSymbolicLink()) parts.push(`${r}@`);
      else parts.push(`${r}:${Bun.hash(readFileSync(p)).toString(16)}`);
    }
  };
  walk(abs, "");
  return Bun.hash(parts.join("\n")).toString(16);
}

/**
 * The bundle a folder is in, by its name or, through a link, by where it
 * really is; else null.
 */
export function bundleHolding(dir: string): ReturnType<typeof bundleOf> {
  return bundleOf(dir) ?? bundleOf(realOr(dir));
}

/** Refuse a workspace folder inside a bundle, as it is named or as it really is. */
export function refuseWorkspaceInBundle(dir: string): void {
  const inBundle = bundleHolding(dir);
  if (inBundle)
    throw new SessionError(
      `the workspace folder is inside the ${inBundle.type.label} ${bundleNameAt(inBundle.root)} (${tilde(dir)}): nothing is written into a ${inBundle.type.label} from here. Set the workspace to a folder outside it (\`workspace <dir>\`)`,
      409,
    );
}

/**
 * Refuse a destination inside a bundle, as it is named or as it really is (a
 * linked folder). A bundle type's member folder (`docs/` in a stage) and
 * anything under it is no refusal: its files are ordinary documents. It must
 * be one as named AND as it really is, so a linked folder in a member folder
 * that leads into the bundle's own files (`audio/`), or out of the bundle,
 * is refused still.
 */
export function refuseInBundle(dir: string, what: string): void {
  if (isMemberDir(dir) && isMemberDir(realOr(dir))) return;
  const inBundle = bundleHolding(dir);
  if (inBundle)
    throw new SessionError(
      `${what} (${tilde(dir)}) is inside the ${inBundle.type.label} ${bundleNameAt(inBundle.root)}: ${outsideMembers(inBundle.type)}`,
      409,
    );
}

/** What may be written into a bundle of `type` from here, said after a refusal. */
export function outsideMembers(type: BundleType): string {
  const members = type.expand?.members ?? [];
  return members.length === 0
    ? `nothing is written into a ${type.label} from here`
    : `only its ${members.map((m) => `${m}/`).join(" and ")} folder${members.length === 1 ? "" : "s"} can be written into from here`;
}
