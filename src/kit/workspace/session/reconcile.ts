/**
 * Reconcile: the watcher's question, whose write was that? One filesystem
 * event classified (`onFileEvent`, `onFileEvents`), an original marked gone
 * (`markMissing`) or asked after under a path (`originalsUnder`), a bundle's
 * row read again (`refreshBundle`) and the shown bundle found
 * (`shownBundleOf`), the original's text back
 * over the active version (`revert`), and a gone document's record forgotten
 * (`forgetDoc`). Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, `places`,
 * `writes` (`isOwnWrite`, `own`, `isOwnBundleEcho`), the `viewer`, the
 * `documents` and the `context`, and as a hook the facade's `persist`, so a
 * test that replaces `persist` on a session still sees every write.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { bundleOf, isBundleMember } from "../../lib/bundles.ts";
import type { Doc } from "../protocol";
import { bundlesIn } from "../tree";
import type { Context } from "./context.ts";
import type { Documents } from "./documents.ts";
import { SessionError } from "./errors.ts";
import { contentHash, nowIso } from "./names.ts";
import { realOr } from "./paths.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";
import type { FileEvent } from "./types.ts";
import type { Viewer } from "./viewer.ts";
import type { Writes } from "./writes.ts";

export class Reconcile {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly writes: Writes,
    private readonly viewer: Viewer,
    private readonly documents: Documents,
    private readonly context: Context,
    private readonly hooks: { persist: () => void },
  ) {}

  /**
   * Forget a document whose file is gone: its record goes, with the way to
   * its versions, so the session stops offering it back and its slug is free.
   * Refused (409) while the file is on disk: forgetting a live document's
   * record would throw away its history while the document sits there. The
   * version files are left where they are: nothing reads them once the record
   * is gone, and removing them would be a second deletion nobody asked for.
   */
  forgetDoc(ref?: string): { slug: string; name: string; original: string; versions: number } {
    const d = this.documents.docOrDie(ref);
    if (existsSync(d.original))
      throw new SessionError(
        `${this.places.display(d.original)} is still on disk: forget is for a document whose file is gone`,
        409,
      );
    const forgotten = {
      slug: d.slug,
      name: this.documents.docName(d),
      original: d.original,
      versions: d.versions.length,
    };
    this.core.m.docs = this.core.m.docs.filter((x) => x.slug !== d.slug);
    this.viewer.docForgotten(d.slug);
    this.context.relink();
    this.viewer.closeOrphaned();
    this.hooks.persist();
    return forgotten;
  }

  /**
   * Read a bundle's row again, after an app wrote into it directly (a stage
   * act copying documents into `docs/`): its contents and its member
   * documents are the context's at once, not when the watcher next says so,
   * so a document just copied in opens by its path straight away.
   */
  refreshBundle(abs: string): void {
    this.context.rescanAround(abs);
    // A bundle listed on its own (made in the workspace) is its entry's one
    // row: read that row again, whether `abs` is the bundle or inside it.
    const b = bundleOf(abs);
    if (b) this.context.refreshListed(b.root);
    this.context.relink();
  }

  /** Mark a document's original missing; the event to announce, or null when it already was. */
  markMissing(d: Doc): FileEvent | null {
    if (d.missing) return null;
    d.missing = true;
    this.context.rescanAround(d.original);
    this.hooks.persist();
    return {
      kind: "original.missing",
      doc: d.slug,
      original: d.original,
      folder: !existsSync(dirname(d.original)),
    };
  }

  /**
   * The documents whose originals are at or under `abs`, checked against the
   * disk after a watcher event there. A deleted folder may be reported only as
   * the folder, so its documents are asked after by path; a folder put back is
   * found the same way.
   */
  originalsUnder(abs: string): FileEvent[] {
    const out: FileEvent[] = [];
    for (const d of this.core.m.docs) {
      if (d.original !== abs && !d.original.startsWith(abs + sep)) continue;
      const there = existsSync(d.original);
      if (!d.missing && !there) {
        const ev = this.markMissing(d);
        if (ev) out.push(ev);
      } else if (d.missing && there) {
        const ev = this.onFileEvent(d.original);
        if (ev) out.push(ev);
      }
    }
    return out;
  }

  /** Revert: the original's text back over the active version. */
  revert(slug: string): { version: number; text: string } {
    const d = this.documents.docOrDie(slug);
    let text: string;
    try {
      text = readFileSync(d.original, "utf8");
    } catch {
      throw new SessionError(`${d.original} is gone from disk: there is no file to revert to`, 409);
    }
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    delete d.outsideHash;
    this.documents.writeActive(d, text);
    this.hooks.persist();
    return { version: d.active, text };
  }

  // ── the watcher's question: whose write was that? ──────────────────────

  /**
   * Classify one filesystem event, as `onFileEvent` does, with what follows
   * from it: a held document in an expandable bundle's member folder is
   * classified as a document (reloaded, or asked about), and its change is a
   * change to its bundle as well, so a view of the bundle hears of it.
   */
  onFileEvents(abs: string): FileEvent[] {
    const ev = this.onFileEvent(abs);
    const out = ev ? [ev] : [];
    if (ev?.kind === "bundle" || ev?.kind === "tree" || !isBundleMember(abs)) return out;
    if (!this.core.m.docs.some((d) => d.original === abs)) return out;
    const bundle = this.shownBundleOf(abs);
    if (bundle && existsSync(abs)) out.push({ kind: "bundle", path: bundle, file: abs });
    return out;
  }

  /**
   * Classify one filesystem event. Reads the file; returns `null` when it is
   * the daemon's own write, unchanged, gone, or not ours to care about.
   */
  onFileEvent(abs: string): FileEvent | null {
    // A version file under docs/<slug>/vN.ext?
    if (abs.startsWith(this.core.docsDir + sep)) {
      const rest = abs.slice(this.core.docsDir.length + 1).split(sep);
      if (rest.length !== 2) return null;
      const [slug, file] = rest as [string, string];
      const d = this.core.m.docs.find((x) => x.slug === slug);
      const match = /^v(\d+)(\.[a-z]+)$/.exec(file);
      if (!d || !match || match[2] !== d.ext) return null;
      const n = Number(match[1]);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        return null;
      }
      if (this.writes.isOwnWrite(abs, text)) return null;
      if (!d.versions.some((v) => v.n === n)) {
        // The agent wrote a version file by hand rather than through
        // `version-new`: adopt it rather than leave a file the surface cannot
        // see. The counter moves past it, so the next number is still unused.
        // A number below the counter was used once and may have been deleted:
        // reusing it would make a "v2" named in a chat message or an agent's
        // notes point at a different document, so the file is renumbered.
        if (n < d.nextVersion) {
          const next = this.documents.takeVersion(d);
          const to = this.core.versionPath(d, next);
          this.writes.own(to, text);
          this.core.own.rename(abs, this.places.ownFileOrDie(to));
          d.versions.push({ n: next, by: "agent", createdAt: nowIso() });
          d.versions.sort((a, b) => a.n - b.n);
          this.hooks.persist();
          return { kind: "version.created", doc: d.slug, version: next, path: to, renamedFrom: n };
        }
        d.versions.push({ n, by: "agent", createdAt: nowIso() });
        d.versions.sort((a, b) => a.n - b.n);
        d.nextVersion = Math.max(d.nextVersion, n + 1);
        this.writes.own(abs, text);
        this.hooks.persist();
        return { kind: "version.created", doc: d.slug, version: n, path: abs };
      }
      if (n === d.active) {
        // The outside text becomes a new agent version, and the active version
        // goes back to the daemon's own last text, so the active version only
        // ever holds what the human typed, and nothing anyone wrote is lost.
        const kept = this.documents.preserveOutside(d, text);
        this.documents.writeActive(d, this.documents.lastActiveText.get(d.slug) ?? text);
        return {
          kind: "active.outside",
          doc: d.slug,
          version: n,
          path: abs,
          preservedAs: kept.n,
          preservedPath: kept.path,
        };
      }
      this.writes.own(abs, text);
      return { kind: "version.changed", doc: d.slug, version: n, text, active: false };
    }

    // An opened original: by its stored path, or by realpath for a symlink.
    const d = this.core.m.docs.find((x) => x.original === abs || realOr(x.original) === abs);
    if (d) {
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        // Gone, or unreadable for a moment. Not marked here: an atomic save or a
        // quick rename back leaves a gap, and a banner that flashes would be a
        // false alarm. The daemon asks again a moment later (`originalsUnder`).
        return null;
      }
      const h = contentHash(text);
      if (d.missing) {
        // Back on disk (restored from the Trash, moved back). As it was: nothing
        // to ask. With other text: asked, as any outside change with edits is,
        // never reloaded over the session's text.
        delete d.missing;
        this.context.rescanAround(d.original);
        this.context.relink();
        if (h !== d.originalHash) {
          d.outsideChanged = true;
          d.outsideHash = h;
          this.hooks.persist();
          return { kind: "original.conflict", doc: d.slug, original: d.original };
        }
        this.hooks.persist();
        return { kind: "original.back", doc: d.slug, original: d.original };
      }
      if (h === d.originalHash) return null; // our own save, or no change
      const clean = !this.documents.isDirty(d);
      if (clean) {
        d.originalHash = h;
        this.documents.writeActive(d, text);
        this.hooks.persist();
        return {
          kind: "original.reloaded",
          doc: d.slug,
          version: d.active,
          text,
          original: d.original,
        };
      }
      // Already asked. The same text: nothing new. A newer text is asked about
      // again (the comparison, the toast, the chat line, the agent), so the
      // human is never asked about one text and Keep mine writes over another;
      // Save checks the same of a change the watcher missed (`outsideHash`).
      if (d.outsideChanged && h === d.outsideHash) return null;
      d.outsideChanged = true;
      d.outsideHash = h;
      this.hooks.persist();
      return { kind: "original.conflict", doc: d.slug, original: d.original };
    }

    // Anything inside a bundle the context shows is a change to the bundle:
    // its row is read again (its title may be new), and the change is said.
    // One gone from disk is a change to the tree, below.
    const bundle = this.shownBundleOf(abs);
    if (bundle && existsSync(bundle)) {
      this.context.rescanAround(bundle);
      this.context.refreshListed(bundle);
      // The echo of the session's own act: the tree is read again, and that is all.
      if (this.writes.isOwnBundleEcho(bundle)) return null;
      return { kind: "bundle", path: bundle, file: abs };
    }

    // Something under a mirrored root: the tree may have changed.
    for (const e of this.core.m.context) {
      if (e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep))) {
        return this.context.rescan(e.id) ? { kind: "tree", entryId: e.id } : null;
      }
    }
    return null;
  }

  /** The bundle the context shows that `abs` is in, or is, by its folder's path; else null. */
  private shownBundleOf(abs: string): string | null {
    const b = bundleOf(abs);
    if (!b) return null;
    for (const e of this.core.m.context)
      for (const { abs: at } of bundlesIn(e)) if (at === b.root) return at;
    return null;
  }
}
