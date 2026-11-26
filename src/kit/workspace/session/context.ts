/**
 * The context: the sets and items the session shows (`m.context`), adding,
 * removing and putting back an entry (`addContext`, `removeContext`,
 * `restoreContext`), re-reading what they show (`rescan`, `rescanAround`,
 * `refreshListed`, `refreshListedContents`, `listedBundleHolding`), where a
 * path is shown (`shownAt`), each held document's place in it (`relink`),
 * and what the watcher must see (`watchRoots`). With it, ours and not Story
 * Studio's, the scan filter: the kit's guard on every scan (`scanGuard`) and
 * the app's filter (`scanSkip`, `filteredOut`, `refilter`). Tier 2 of the
 * session parts (docs/architecture/workspace-session.md); it takes the core,
 * `places`, the `viewer`, `media`, `sidecars` and `workspace` (for the app's
 * slot, which the filter reads), and as hooks the facade's `persist`, so a
 * test that replaces `persist` on a session still sees every write, and its
 * `closeImage`, which puts away an image the context no longer shows and
 * persists.
 */

import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { bundleOf, bundleTypeOf } from "../../lib/bundles.ts";
import { ownPlaceGuard } from "../noHome";
import { PROFILES_DIR } from "../profiles";
import type { ContextEntry } from "../protocol";
import {
  bundleNode,
  entryForPath,
  listedFile,
  locate,
  MIRROR_NODE_CAP,
  PathError,
  type ScanGuard,
  type ScanSkip,
  scanTree,
  toPosix,
} from "../tree";
import { GoneError, SessionError } from "./errors.ts";
import type { Media } from "./media.ts";
import { randHex, tilde } from "./names.ts";
import { isFolder, overlapOf, realOr } from "./paths.ts";
import type { Places } from "./places.ts";
import type { Sidecars } from "./sidecars.ts";
import type { State } from "./state.ts";
import type { Viewer } from "./viewer.ts";
import type { Workspace } from "./workspace.ts";

export class Context {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly viewer: Viewer,
    private readonly media: Media,
    private readonly sidecars: Sidecars,
    private readonly workspace: Workspace,
    private readonly hooks: { persist: () => void; closeImage: () => void },
  ) {}

  /**
   * Every directory the watcher must see: the session's docs, each entry root,
   * and the real directory of every opened original.
   *
   * Each root is watched at its realpath, and an event is reported under the
   * path form the session stores. A watch on a symlinked directory saw nothing
   * when the target changed (FSEvents reports real paths); a symlinked original
   * is matched back to its doc by realpath in `onFileEvent`.
   */
  watchRoots(): { path: string; watch: string; recursive: boolean; entryId?: string }[] {
    const roots: { path: string; watch: string; recursive: boolean; entryId?: string }[] = [
      { path: this.core.docsDir, watch: realOr(this.core.docsDir), recursive: true },
    ];
    for (const e of this.core.m.context) {
      roots.push({
        path: e.root,
        watch: realOr(e.root),
        recursive: e.membership === "mirrored",
        entryId: e.id,
      });
      // A listed bundle's folder is watched whole, as a set's is: a change
      // anywhere inside it is a change to the bundle.
      const only = listedFile(e);
      if (only?.kind === "bundle")
        roots.push({ path: only.abs, watch: realOr(only.abs), recursive: true, entryId: e.id });
      // A mirrored folder's watch is recursive, so its profile files are
      // watched with its documents. A listed document's folder is watched
      // alone, so its `_meta/profiles/` (the only one its lookup can reach) is
      // watched beside it: a profile edited outside cues `context.changed`.
      const profiles = join(e.root, PROFILES_DIR);
      if (e.membership !== "mirrored" && isFolder(profiles))
        roots.push({ path: profiles, watch: realOr(profiles), recursive: false });
    }
    for (const d of this.core.m.docs) {
      const realDir = dirname(realOr(d.original));
      if (
        !roots.some((r) => r.watch === realDir && r.recursive === false) &&
        !roots.some(
          (r) => r.recursive && (realDir === r.watch || realDir.startsWith(r.watch + sep)),
        )
      )
        roots.push({ path: realDir, watch: realDir, recursive: false });
    }
    return roots;
  }

  addContext(rawPath: string): { entry: ContextEntry; added: boolean } {
    const abs = resolve(rawPath);
    this.places.mayBeASetOrDie(abs);
    const id = `c-${randHex(3)}`;
    // The app's filter sees a new set from its first scan.
    const probe = entryForPath(abs, id, (root) => this.scanSkip(id, root), this.scanGuard());
    const same = this.core.m.context.find(
      (e) =>
        e.root === probe.root &&
        e.membership === probe.membership &&
        (probe.membership === "mirrored" ||
          JSON.stringify(e.nodes) === JSON.stringify(probe.nodes)),
    );
    if (same) return { entry: same, added: false };
    // A set whose folder is the workspace, or holds it, would make a file in the
    // workspace belong to both: refused, with the way round it.
    if (
      probe.membership === "mirrored" &&
      this.core.hasHome &&
      overlapOf(this.core.workspace, [probe])
    )
      throw new SessionError(
        `${probe.label} cannot be added as a set: its folder ${
          realOr(this.core.workspace) === realOr(probe.root) ? "is" : "holds"
        } the workspace folder (${tilde(this.core.workspace)}), so a file there would belong to both. Set the workspace to a folder outside it first, such as ${tilde(dirname(probe.root))} (the pencil in the sidebar, or \`workspace <dir>\`)`,
        409,
      );
    this.core.m.context.push(probe);
    // A loose image comes with its description, when one is beside it: listed
    // too, and folded into the image's row by the surface.
    const only = listedFile(probe);
    const sidecar = only?.kind === "image" ? this.sidecars.sidecarFileOf(only.abs) : null;
    if (sidecar && !this.places.itemAt(sidecar))
      this.core.m.context.push(entryForPath(sidecar, `c-${randHex(3)}`));
    this.relink();
    this.hooks.persist();
    return { entry: probe, added: true };
  }

  /**
   * Take an entry out of the context (the files stay on disk). Returns the
   * entry and where it stood, which `restoreContext` takes to put it back.
   */
  removeContext(id: string): { entry: ContextEntry; index: number } {
    const i = this.core.m.context.findIndex((e) => e.id === id);
    if (i < 0)
      throw new SessionError(
        `no context entry ${id}`,
        404,
        this.core.m.context.map((e) => e.id),
      );
    const [entry] = this.core.m.context.splice(i, 1) as [ContextEntry];
    this.relink();
    this.viewer.closeOrphaned();
    // An open image the context no longer shows is put away, as `closeImage` does.
    if (this.core.m.openImage && !this.media.imageNodeAt(this.core.m.openImage))
      this.hooks.closeImage();
    this.hooks.persist();
    return { entry, index: i };
  }

  /**
   * Put back an entry `removeContext` took out: the SAME id, root and
   * membership, at `index` (clamped to the list), so whatever names it by id
   * (an app's slot, an act on the history) finds it again. What it shows is
   * read again from disk, a set's through the app's filter. A `GoneError` when
   * it can never come back this way: its id or its folder (or item) is in the
   * context already, or what it showed is gone from disk or is no longer the
   * same kind of entry. A 409 when a set would hold the workspace, as
   * `addContext` refuses it. Persists. For an app's undo of a removal
   * (Scriptorium's `hide` of a whole entry).
   */
  restoreContext(entry: ContextEntry, index = this.core.m.context.length): ContextEntry {
    if (this.core.m.context.some((e) => e.id === entry.id))
      throw new GoneError(`${entry.label} (${entry.id}) is in the context already`, 409);
    const only = entry.membership === "listed" ? entry.nodes[0] : undefined;
    const path =
      entry.membership === "mirrored" ? entry.root : only ? join(entry.root, only.rel) : null;
    if (path === null)
      throw new GoneError(`${entry.label} (${entry.id}) shows nothing to put back`, 409);
    // Checked now, where the disk really leads: a folder swapped for a link to
    // the sessions since it was hidden is never put back as a set.
    this.places.mayBeASetOrDie(path, true);
    let fresh: ContextEntry;
    try {
      fresh = entryForPath(
        path,
        entry.id,
        (root) => this.scanSkip(entry.id, root),
        this.scanGuard(),
      );
    } catch (e) {
      if (e instanceof PathError)
        throw new GoneError(`${tilde(path)} cannot come back: ${e.message}`, 409);
      throw e;
    }
    if (fresh.membership !== entry.membership || fresh.root !== entry.root)
      throw new GoneError(`${tilde(path)} is no longer what ${entry.label} was`, 409);
    if (
      this.core.m.context.some(
        (e) =>
          e.root === fresh.root &&
          e.membership === fresh.membership &&
          (fresh.membership === "mirrored" ||
            JSON.stringify(e.nodes) === JSON.stringify(fresh.nodes)),
      )
    )
      throw new GoneError(`${tilde(path)} is in the context already`, 409);
    if (
      fresh.membership === "mirrored" &&
      this.core.hasHome &&
      overlapOf(this.core.workspace, [fresh])
    )
      throw new SessionError(
        `${fresh.label} cannot come back as a set: its folder holds the workspace folder (${tilde(this.core.workspace)})`,
        409,
      );
    const back: ContextEntry = {
      ...fresh,
      label: entry.label,
      ...(entry.realRoot ? { realRoot: entry.realRoot } : {}),
    };
    this.core.m.context.splice(Math.max(0, Math.min(index, this.core.m.context.length)), 0, back);
    this.relink();
    this.hooks.persist();
    return back;
  }

  /** Re-mirror a folder entry. Returns whether its nodes changed. */
  rescan(entryId: string): boolean {
    const e = this.core.m.context.find((x) => x.id === entryId);
    if (e?.membership !== "mirrored") return false;
    const { nodes, truncated } = scanTree(
      e.root,
      MIRROR_NODE_CAP,
      this.scanSkip(e.id, e.root),
      this.scanGuard(),
    );
    const changed =
      JSON.stringify(nodes) !== JSON.stringify(e.nodes) || !!truncated !== !!e.truncated;
    e.nodes = nodes;
    if (truncated) e.truncated = true;
    else delete e.truncated;
    if (changed) this.relink();
    return changed;
  }

  /**
   * The kit's guard on every scan: the app's own places are never mirrored,
   * whatever a set holds or a link inside one leads to (`ownPlaceGuard`).
   */
  scanGuard(): ScanGuard {
    return ownPlaceGuard(this.places.ownPlaces);
  }

  /** The app's filter for a set's scan (`AppDeclaration.scan`), as the slot is now. */
  scanSkip(entryId: string, root: string): ScanSkip | undefined {
    return this.core.app.scan?.({ entryId, root, slot: this.workspace.appSlot })?.skip;
  }

  /**
   * Whether the app's filter leaves `abs` out of a set whose folder holds it:
   * the path itself, or a folder above it, skipped (`ScanRule.skip`). A path no
   * set holds is not filtered.
   */
  filteredOut(): (abs: string) => boolean {
    const rules: { root: string; skip: ScanSkip }[] = [];
    if (this.core.app.scan)
      for (const e of this.core.m.context) {
        if (e.membership !== "mirrored") continue;
        const skip = this.scanSkip(e.id, e.root);
        if (skip) rules.push({ root: e.root, skip });
      }
    return (abs) =>
      rules.some(({ root, skip }) => {
        const rel = toPosix(relative(root, abs));
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
        const parts = rel.split("/");
        return parts.some((_, i) => skip(parts.slice(0, i + 1).join("/"), i < parts.length - 1));
      });
  }

  /**
   * Scan sets again through the app's filter (`AppDeclaration.scan`), after
   * the app changed what it reads: one entry, or every set. The tree, search
   * and links follow; an open document or image the context no longer shows
   * is closed in the view (its versions stay). Persists. Returns whether any
   * tree changed.
   */
  refilter(entryId?: string): boolean {
    if (entryId !== undefined && !this.core.m.context.some((e) => e.id === entryId))
      throw new SessionError(
        `no context entry ${entryId}`,
        404,
        this.core.m.context.map((e) => e.id),
      );
    let changed = false;
    for (const e of this.core.m.context)
      if ((entryId === undefined || e.id === entryId) && this.rescan(e.id)) changed = true;
    this.relink();
    this.viewer.closeOrphaned();
    if (this.core.m.openImage && !this.media.imageNodeAt(this.core.m.openImage))
      this.hooks.closeImage();
    this.hooks.persist();
    return changed;
  }

  /**
   * Where the context shows a path: its entry, its `rel` from the entry's
   * root, and whether it is the whole entry (a set's own folder, a listed
   * item). A 404 when nothing shows it. For an app act on what the tree shows
   * (Scriptorium's `hide`).
   */
  shownAt(rawPath: string): { abs: string; entryId: string; rel: string; whole: boolean } {
    const item = this.places.itemOrDie(rawPath);
    return {
      abs: item.abs,
      entryId: item.entry.id,
      rel: toPosix(relative(item.entry.root, item.abs)),
      whole: item.whole,
    };
  }

  relink(): void {
    for (const d of this.core.m.docs) {
      const at = locate(this.core.m.context, d.original);
      d.entryId = at?.entryId ?? null;
      d.rel = at?.rel ?? null;
    }
  }

  /** Re-mirror the sets that hold `abs`, after a file there came or went. */
  rescanAround(abs: string): void {
    for (const e of this.core.m.context)
      if (e.membership === "mirrored" && abs.startsWith(e.root + sep)) this.rescan(e.id);
    const listed = this.listedBundleHolding(abs);
    if (listed) this.refreshListed(listed);
  }

  /** The folder of a bundle listed on its own (no set shows it) that `abs` is inside, else null. */
  listedBundleHolding(abs: string): string | null {
    const b = bundleOf(abs);
    if (!b || b.inner === "") return null;
    for (const e of this.core.m.context) {
      const only = listedFile(e);
      if (only?.kind === "bundle" && only.abs === b.root) return b.root;
    }
    return null;
  }

  /** Read every listed bundle of an expandable type again: its contents follow what moved. */
  refreshListedContents(): void {
    for (const e of this.core.m.context) {
      const only = listedFile(e);
      if (only?.kind === "bundle" && bundleTypeOf(only.abs)?.expand) this.refreshListed(only.abs);
    }
  }

  /** Read a listed bundle's node again (its title changed), as a set's rescan does for one inside it. */
  refreshListed(abs: string): void {
    for (const e of this.core.m.context) {
      const only = listedFile(e);
      if (only?.kind !== "bundle" || only.abs !== abs) continue;
      const type = bundleTypeOf(abs);
      if (!type) continue;
      const nodes = [bundleNode(basename(abs), abs, type)];
      const changed = JSON.stringify(nodes) !== JSON.stringify(e.nodes);
      e.nodes = nodes;
      // Its member documents are documents of the context: they follow.
      if (changed && type.expand) this.relink();
    }
  }
}
