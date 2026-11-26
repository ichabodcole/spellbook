/**
 * Saving: the active version's text over the original, the only write to it
 * (`save`), and putting a document away (`closeDoc`). Tier 4 of the session
 * parts (docs/architecture/workspace-session.md); it takes the core,
 * `places`, `writes`, the `viewer`, the `documents`, the `context` (its
 * `rescanAround` and `relink`) and `reconcile` (the watcher's `onFileEvent`,
 * its own tier, one way), and as a hook the facade's `persist`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { isBundleMain } from "../../lib/bundles.ts";
import { isDocName } from "../tree";
import type { Context } from "./context.ts";
import type { Documents } from "./documents.ts";
import { SessionError, UnseenChangeError } from "./errors.ts";
import { contentHash } from "./names.ts";
import type { Places } from "./places.ts";
import type { Reconcile } from "./reconcile.ts";
import type { State } from "./state.ts";
import type { Viewer } from "./viewer.ts";
import type { Writes } from "./writes.ts";

export class Saving {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly writes: Writes,
    private readonly viewer: Viewer,
    private readonly documents: Documents,
    private readonly context: Context,
    private readonly reconcile: Reconcile,
    private readonly hooks: {
      persist: () => void;
    },
  ) {}

  /**
   * Save: the active version's text over the original. The only write to it.
   *
   * An original that is gone from disk is recreated only when `recreate` says
   * so, and its folder only with `recreate: "folder"`: Save never quietly brings
   * back a file, or a folder, that someone deleted.
   */
  save(
    slug: string,
    opts: { recreate?: "file" | "folder" } = {},
  ): { original: string; version: number; recreated?: "file" | "folder"; unchanged?: true } {
    const d = this.documents.docOrDie(slug);
    // Save writes only an original admitted by `openPath` (a document-type file
    // inside a context entry). Checked again here so no other path into the
    // manifest (a hand-edited one, a future verb) can turn Save into "write
    // any file".
    if (!d.admitted || !(isDocName(d.original) || isBundleMain(d.original)))
      throw new SessionError(
        `refusing to save ${d.original}: it was not opened from the context`,
        409,
      );
    // Asked of the disk, not of the flag: the watcher may not have said yet.
    const folderThere = existsSync(dirname(d.original));
    const fileThere = folderThere && existsSync(d.original);
    if (!fileThere) {
      if (!d.missing) {
        d.missing = true;
        this.hooks.persist();
      }
      if (!folderThere && opts.recreate !== "folder")
        throw new SessionError(
          `${d.name} and its folder are gone from disk, so Save waits: choose "Save, making the folder again" in the document's banner to bring both back`,
          409,
        );
      if (!opts.recreate)
        throw new SessionError(
          `${d.name} is gone from disk, so Save waits: choose "Save to recreate it" in the document's banner to bring it back`,
          409,
        );
    }
    const text = readFileSync(this.core.versionPath(d, d.active), "utf8");
    // A JSON document is a contract other things read: one that does not parse
    // never reaches the file. The text stays in the version, to be fixed there.
    this.documents.refuseInvalidJson(d, d.active, text, "saved");
    // The file's text is asked of the disk too, not of the watcher: a change it
    // never reported would be overwritten unseen. Once the flag is up the human
    // has been asked, and Save is their "Keep mine", a deliberate overwrite of
    // the text they were asked about (`outsideHash`) and of nothing newer: a
    // second change the watcher also missed is asked about again.
    const disk = fileThere ? readFileSync(d.original, "utf8") : null;
    if (disk !== null && d.outsideChanged) {
      const h = contentHash(disk);
      if (h !== d.outsideHash && h !== d.originalHash && disk !== text) {
        // "Again" only when a text was asked about: a manifest from before
        // `outsideHash` has the flag up with no text recorded as shown.
        const again = d.outsideHash !== undefined;
        d.outsideHash = h;
        this.hooks.persist();
        throw new UnseenChangeError(
          again
            ? `${d.name} changed on disk again since you were asked, so Save waits and wrote nothing: choose in the document's banner`
            : `${d.name} changed on disk, so Save waits and wrote nothing: see the difference in the document's banner first`,
          { kind: "original.conflict", doc: d.slug, original: d.original },
          `"See the difference" shows the file's newer text against yours; "Keep mine" saves yours over it; "Take the file's" loads it`,
        );
      }
    }
    if (disk !== null && !d.outsideChanged) {
      if (contentHash(disk) !== d.originalHash && disk !== text) {
        const event = this.reconcile.onFileEvent(d.original);
        if (event?.kind === "original.reloaded")
          throw new UnseenChangeError(
            `${d.name} changed on disk and you had no unsaved edits, so its text was loaded and Save wrote nothing`,
            event,
            "the file's new text is in the active version now: edit it and Save again to change the file",
          );
        throw new UnseenChangeError(
          `${d.name} changed on disk since it was last read, so Save waits and wrote nothing: choose in the document's banner`,
          event,
          `"See the difference" compares the file with yours; "Keep mine" saves yours over it; "Take the file's" loads it`,
        );
      }
    }
    // The bytes on disk are already the text: a save that changes nothing, which
    // the daemon never wakes the agent for. Still written, as the human asked.
    const unchanged = fileThere && readFileSync(d.original).equals(Buffer.from(text, "utf8"));
    this.writes.writeOwned(d.original, text, this.places.world);
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    delete d.outsideHash;
    const recreated = fileThere ? undefined : folderThere ? "file" : "folder";
    if (!fileThere) {
      delete d.missing;
      this.context.rescanAround(d.original);
      this.context.relink();
    }
    this.hooks.persist();
    return {
      original: d.original,
      version: d.active,
      ...(recreated ? { recreated } : {}),
      ...(unchanged ? { unchanged: true as const } : {}),
    };
  }

  /**
   * Put a document away: the view closes it. The record and every version stay
   * in the session, so opening the file again (or restoring it from the Trash)
   * finds them.
   */
  closeDoc(slug: string): { slug: string } {
    const d = this.documents.docOrDie(slug);
    this.viewer.closeDoc(d.slug);
    this.hooks.persist();
    return { slug: d.slug };
  }
}
