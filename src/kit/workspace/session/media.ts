/**
 * The images the session shows, as files: which path is an image node of the
 * tree (`imageNodeAt`), or an image inside a bundle the tree shows
 * (`bundleImageAt`), the file route's guard (`imageFile`), and the stamps of
 * every image shown (`imageStamps`, the thumbnails worth keeping). Tier 2 of
 * the session parts (docs/architecture/workspace-session.md); it takes the
 * core and `places`, and writes nothing.
 */

import { closeSync, fstatSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { bundleOf } from "../../lib/bundles.ts";
import { IMAGE_EXTENSIONS, type ImageType, isImageName, sniffImage } from "../../lib/docFormat.ts";
import { openNoFollow, readHeadFd, stampOf } from "../images";
import type { ContextEntry } from "../protocol";
import { findNode, imagePaths, listedFile, toPosix } from "../tree";
import { SessionError } from "./errors.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";

export class Media {
  constructor(
    private readonly core: State,
    private readonly places: Places,
  ) {}

  /**
   * The image node at `abs` (in its context form), or null: one inside a
   * mirrored set, or the one file of a listed entry. A listed entry's root is
   * the image's folder, but nothing else in that folder is ever its node, so a
   * sibling beside a loose image is no image this session shows.
   */
  imageNodeAt(abs: string): { entry: ContextEntry; rel: string } | null {
    for (const e of this.core.m.context) {
      if (e.membership === "listed") {
        const only = listedFile(e);
        if (only?.kind === "image" && only.abs === abs) return { entry: e, rel: only.rel };
        continue;
      }
      if (!abs.startsWith(e.root + sep)) continue;
      const rel = toPosix(relative(e.root, abs));
      if (findNode(e.nodes, rel)?.kind === "image") return { entry: e, rel };
    }
    return null;
  }

  /**
   * An image inside a bundle the tree shows (a board's `assets/`), or null.
   * The tree shows a bundle as one row and never its insides, so a bundle's own
   * image is shown when its bundle is: the file route serves it, so a board can
   * draw its assets. Nothing else treats it as a node of its own.
   */
  private bundleImageAt(abs: string): { entry: ContextEntry; rel: string } | null {
    const b = bundleOf(abs);
    if (!b?.inner || b.inner === b.type.main) return null;
    // In a set only: a listed entry's guard admits its one file and nothing
    // beneath it, so a listed bundle's assets are not served.
    for (const e of this.core.m.context) {
      if (e.membership === "listed" || !b.root.startsWith(e.root + sep)) continue;
      if (findNode(e.nodes, toPosix(relative(e.root, b.root)))?.kind === "bundle")
        return { entry: e, rel: toPosix(relative(e.root, abs)) };
    }
    return null;
  }

  /**
   * ⛔ THE FILE ROUTE'S GUARD. An image this session shows, checked before a
   * byte of it is served, or a refusal that says why:
   *
   * - an absolute path, with no `..` segment and no NUL;
   * - an image name (`IMAGE_EXTENSIONS`): a document, a script or anything else
   *   is refused before the disk is looked at;
   * - an image node in a mirrored context entry right now, or the one image a
   *   listed entry holds: what the tree shows, and nothing else, so a path
   *   outside every entry is refused, and so is a sibling beside a loose image.
   *   An image inside a bundle the tree shows (a board's `assets/`) counts as
   *   shown, since the bundle's row stands for its files;
   * - whose realpath is inside that entry's root by realpath: a symlink in the
   *   set that leads out of it is refused, however its name looks. A loose
   *   image's realpath must be the listed file itself (its folder's realpath and
   *   its own name): a loose image that is a link is refused wherever it leads;
   * - a regular file whose first bytes are one of the shown image types: a page
   *   or a script saved under an image's name is refused, never served.
   *
   * Every refusal outside the context is a 404, so a probe learns nothing about
   * what exists where.
   */
  imageFile(rawPath: string): {
    abs: string;
    real: string;
    entry: ContextEntry;
    rel: string;
    size: number;
    stamp: string;
    type: ImageType;
    /**
     * ⛔ The file, opened ONCE and checked: every byte served or read comes
     * from this descriptor, never from the path again, so a file swapped for a
     * link between the check and the read cannot be served. The caller closes
     * it (`imageResponse` does when it serves from it).
     */
    fd: number;
  } {
    if (!rawPath || !isAbsolute(rawPath))
      throw new SessionError(`"${rawPath}" is not a full path: start it with /`, 400);
    if (rawPath.includes("\0") || rawPath.split(/[\\/]/).includes(".."))
      throw new SessionError("a path with a .. in it is not served: name the file itself", 400);
    if (!isImageName(rawPath))
      throw new SessionError(
        `not an image the workspace shows (${IMAGE_EXTENSIONS.join(" ")}): ${rawPath}`,
        400,
        [...IMAGE_EXTENSIONS],
      );
    const abs = this.places.contextForm(resolve(rawPath));
    const at = this.imageNodeAt(abs) ?? this.bundleImageAt(abs);
    if (!at) throw new SessionError(`${abs} is not an image shown in this session`, 404);
    const real = this.places.realInsideOrDie(abs, at.entry, "not served");
    // Open the real path once, refusing a link in its last place; then make sure
    // what was opened is a plain file, and is the very file the path inside the
    // set names now, by device and inode. A swap at any moment either fails the
    // open, or leaves a descriptor whose identity no longer matches, and is refused.
    const fd = openNoFollow(real);
    if (fd === null) throw new SessionError(`${abs} is not on disk`, 404);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SessionError(`${abs} is not a file`, 404);
      const now = this.places.realInsideOrDie(abs, at.entry, "not served");
      let named: ReturnType<typeof statSync>;
      try {
        named = statSync(now);
      } catch {
        throw new SessionError(`${abs} is not on disk`, 404);
      }
      if (named.dev !== st.dev || named.ino !== st.ino)
        throw new SessionError(`${abs} changed while it was being read: try again`, 409);
      const type = sniffImage(readHeadFd(fd));
      if (!type)
        throw new SessionError(
          `${basename(abs)} is not a PNG, JPEG, WebP, GIF or AVIF image inside, whatever its name says: not served`,
          400,
        );
      return {
        abs,
        real: now,
        entry: at.entry,
        rel: at.rel,
        size: st.size,
        stamp: stampOf(st),
        type,
        fd,
      };
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }

  /** The stamp of every image the context shows now: the thumbnails worth keeping. */
  imageStamps(): Set<string> {
    const out = new Set<string>();
    for (const e of this.core.m.context) {
      // A set's images and a loose image's alike: a listed entry's nodes hold
      // only its own file, never a sibling.
      for (const p of imagePaths(e)) {
        try {
          out.add(stampOf(statSync(p)));
        } catch {
          /* gone */
        }
      }
    }
    return out;
  }
}
