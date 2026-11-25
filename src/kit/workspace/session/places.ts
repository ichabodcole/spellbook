/**
 * Places: how a path reads in a chat line, how the context names it, and the
 * guards on where the session reads and writes (the `…OrDie` guards, the
 * workspace, and our own places: the sessions root and the app home, which no
 * set shows and nothing writes in). Tier 1 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core (`state`) and
 * imports only tier 0 and `state`.
 *
 * It holds the world's writer (`world`), which checks every write against our
 * own places at the syscall.
 */

import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BundleType, bundleOf, bundlePlace, bundleTypeOf } from "../../lib/bundles.ts";
import { homeDir } from "../../lib/home.ts";
import { type Disk, worldDisk } from "../disk";
import {
  onDisk as diskPath,
  holdsOwnPlaces,
  inOwnPlaces,
  noLocation,
  notALocation,
  notASet,
  type OwnPlaces,
  within,
} from "../noHome";
import type { ContextEntry, ContextNode } from "../protocol";
import {
  docPaths,
  findNode,
  imagePaths,
  isDocName,
  listedFile,
  sidecarPaths,
  toPosix,
} from "../tree";
import { GoneError, SessionError } from "./errors.ts";
import { IMPORTED_DIR } from "./facts.ts";
import { bundleNameAt, tilde } from "./names.ts";
import {
  outsideMembers,
  realOr,
  refuseInBundle,
  refuseWorkspaceInBundle,
  rootReal,
} from "./paths.ts";
import { refuseWrite, type State } from "./state.ts";
import type { ContextIndex } from "./types.ts";

export class Places {
  constructor(private readonly core: State) {}

  /**
   * The workspace, ready to be written into. The session's own `imported/`
   * folder is made on demand; a chosen folder that has gone is a conflict in
   * words, never a raw ENOENT.
   */
  workspaceOrDie(): string {
    // No home workspace: a write that names no folder has nowhere to go.
    if (!this.core.hasHome) {
      const r = noLocation(this.core.app);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    const dir = this.core.workspace;
    // ⛔ The one gate for writing into the workspace (new documents, folders
    // and bundles, drops, imported images, moves): a workspace inside a bundle
    // would write into the bundle, which is one item and never a folder.
    refuseWorkspaceInBundle(dir);
    this.notOwnPlaceOrDie(dir);
    if (existsSync(dir)) return dir;
    if (dir === join(this.core.dir, IMPORTED_DIR)) {
      this.core.own.mkdir(dir, { recursive: true });
      return dir;
    }
    throw new SessionError(
      `the workspace folder is gone: ${dir}. Set it with \`workspace <dir>\``,
      409,
    );
  }

  /** Whether `abs` is the workspace folder, as named or by where it really is. */
  isWorkspace(abs: string): boolean {
    if (!this.core.hasHome) return false;
    return abs === this.core.workspace || realOr(abs) === realOr(this.core.workspace);
  }

  /**
   * The places no set shows and no structure op writes in: the sessions root
   * and the app home. A home-workspace app's own `imported/` folder is the one
   * exception (its default workspace, inside the session).
   */
  get ownPlaces(): OwnPlaces {
    return {
      sessionsRoot: this.core.sessionsRoot,
      ...(this.core.appHome !== undefined ? { appHome: this.core.appHome } : {}),
      ...(this.core.hasHome
        ? {
            except: join(this.core.dir, IMPORTED_DIR),
            // Only where the session folder really was at the open: an
            // `imported/` that is a link, or a session folder swapped since,
            // is no exception (`exceptionOf` in `./noHome.ts`).
            ...(this.core.realDir !== undefined
              ? { exceptReal: join(this.core.realDir, IMPORTED_DIR) }
              : {}),
          }
        : {}),
    };
  }

  /**
   * ⛔ THE WORLD'S WRITER: every write to a file or folder the sets show (a
   * create, a drop, a sidecar, a Save, a link rewrite, a move). Never among
   * the sessions or in the app home, as written or as the disk resolves it,
   * checked at the syscall (`worldDisk` in `./disk.ts`).
   */
  readonly world: Disk = worldDisk(() => this.ownPlaces, refuseWrite);

  /**
   * ⛔ THE BACKSTOP FOR EVERY STRUCTURE OP (create, move, rename, delete,
   * trash, import, make-set). Nothing is written among the sessions or in the
   * app home, whatever the sets say: a set that shows them (one restored from
   * an old manifest, one whose folder became a link) never makes them a place
   * to write. Refused before anything is changed.
   */
  notOwnPlaceOrDie(abs: string, status: 400 | 409 = 409): string {
    const why = inOwnPlaces(abs, this.ownPlaces);
    if (why !== null)
      throw new SessionError(`${why}: nothing is written or moved there from here`, status);
    return abs;
  }

  /** As `notOwnPlaceOrDie`, for what an op takes away (a move's, a rename's, a trash's source): nor one that holds them. */
  notOwnSourceOrDie(abs: string): string {
    this.notOwnPlaceOrDie(abs);
    const why = holdsOwnPlaces(abs, this.ownPlaces);
    if (why !== null)
      throw new SessionError(`${why}: it is not moved, renamed or removed from here`, 409);
    return abs;
  }

  /** The one guard on every route that makes a set or a listed entry (`notASet`). 409 when refused. */
  mayBeASetOrDie(abs: string, gone = false): void {
    const why = notASet(abs, this.ownPlaces);
    if (why === null) return;
    const message = `${why}: it is not added to the context`;
    throw gone ? new GoneError(message, 409) : new SessionError(message, 409);
  }

  /**
   * A version file's path, refused unless it is in the session's own `docs/`
   * folder as written and as the disk resolves it (a slug or extension that
   * climbs out, a linked folder that leads out). The manifest check refuses
   * such a slug or extension on restore; this is the backstop at every write.
   */
  ownFileOrDie(path: string): string {
    this.core.dirStillOrDie();
    const docs = this.core.docsDir;
    const real = this.core.realDir !== undefined ? join(this.core.realDir, "docs") : diskPath(docs);
    if (!within(resolve(path), docs) || resolve(path) === docs || !within(diskPath(path), real))
      throw new SessionError(
        `${path} is not inside this session's docs folder (${docs}): nothing was written`,
        409,
      );
    return path;
  }

  /**
   * Every document the context lists, by path, with the entry that lists it
   * (the first, as `locate` answers), and each entry's root by realpath. What
   * `locate` and `canonical` would work out entry by entry, built once: a caller
   * that asks many times in one go (backlinks resolves every matching link in
   * the world) builds this and passes it, rather than walking every entry's
   * tree per question.
   */
  contextIndex(): ContextIndex {
    const entryOf = new Map<string, string>();
    const images = new Set<string>();
    const sidecars = new Set<string>();
    for (const e of this.core.m.context) {
      for (const p of docPaths(e)) if (!entryOf.has(p)) entryOf.set(p, e.id);
      for (const p of imagePaths(e)) images.add(p);
      for (const p of sidecarPaths(e)) sidecars.add(p);
    }
    return {
      entryOf,
      images,
      sidecars,
      realRoots: this.core.m.context.map((e) => ({ root: e.root, real: realOr(e.root) })),
    };
  }

  /** `abs` as the context names it, when it is the same file by realpath. */
  canonical(abs: string, index: ContextIndex = this.contextIndex()): string {
    const known = (p: string) => index.entryOf.has(p) || index.images.has(p);
    if (known(abs)) return abs;
    const real = realOr(abs);
    for (const { root, real: realRoot } of index.realRoots) {
      if (!real.startsWith(realRoot + sep)) continue;
      const named = join(root, relative(realRoot, real));
      if (known(named)) return named;
    }
    return abs;
  }

  /**
   * `abs`'s realpath, when it lies inside `entry`'s root by realpath: a link in
   * the set that leads out of it is refused, as a 404, so a probe learns nothing.
   * For a listed entry the allowed place is exactly the listed file: its
   * realpath must be its folder's realpath and its own name, so a loose image
   * that is a link (out, or to a sibling) is refused.
   */
  realInsideOrDie(abs: string, entry: ContextEntry, what: string): string {
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new SessionError(`${abs} is not on disk`, 404);
    }
    // Against the root's realpath as it was when the entry was added: a
    // symlinked folder retargeted since then leads nowhere new.
    const root = rootReal(entry);
    if (entry.membership === "listed") {
      let link = true;
      try {
        link = lstatSync(abs).isSymbolicLink();
      } catch {
        /* gone: refused below as not where it was */
      }
      if (link) throw new SessionError(`${this.display(abs)} is a link: ${what}`, 404);
      if (dirname(abs) !== entry.root || dirname(real) !== root)
        throw new SessionError(
          `${this.display(abs)} is not in the folder it was added from (a link there leads elsewhere now): ${what}`,
          404,
        );
      if (basename(real) !== basename(abs))
        throw new SessionError(`${this.display(abs)} is a link: ${what}`, 404);
      return real;
    }
    if (!real.startsWith(root + sep))
      throw new SessionError(
        `${this.display(abs)} leads outside ${entry.label} through a link: ${what}`,
        404,
      );
    return real;
  }

  /**
   * How a path reads in a chat line: `set/rel` inside a set, a single
   * document's file name, `workspace/...` in the workspace, else `~/...`.
   */
  display(abs: string): string {
    // In the innermost set that holds it: a linked folder opened as a set of
    // its own sits under the set holding its link, and is named as itself.
    let set: ContextEntry | undefined;
    for (const e of this.core.m.context) {
      if (e.membership !== "mirrored") continue;
      if (abs !== e.root && !abs.startsWith(e.root + sep)) continue;
      if (!set || e.root.length > set.root.length) set = e;
    }
    if (set)
      return abs === set.root ? set.label : `${set.label}/${toPosix(relative(set.root, abs))}`;
    for (const e of this.core.m.context)
      if (e.membership !== "mirrored" && e.nodes.some((n) => join(e.root, n.rel) === abs))
        return e.label;
    if (abs.startsWith(this.core.dir + sep)) return toPosix(relative(this.core.dir, abs));
    if (this.core.hasHome && abs.startsWith(this.core.workspace + sep))
      return `workspace/${toPosix(relative(this.core.workspace, abs))}`;
    const home = homeDir();
    return abs === home ? "~" : abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
  }

  /**
   * A folder things may be copied into (`destinationOrDie`): a set, a folder
   * the tree shows in one, or the workspace. Throws the refusal otherwise.
   */
  shownFolderOrDie(dir: string): string {
    return this.destinationOrDie(dir);
  }

  /** `path` named the way the context names it (`contextForm`), for a path from outside: the picker's. */
  namedAsContext(path: string): string {
    return this.contextForm(resolve(path));
  }

  /**
   * `abs` named the way the context names it. A caller whose cwd is a
   * realpath (/private/var/... for /var/..., a symlinked folder) names the same
   * place differently, and it must land on the same node.
   */
  contextForm(abs: string): string {
    if (this.core.m.context.some((e) => abs === e.root || abs.startsWith(e.root + sep))) return abs;
    const real = realOr(abs);
    for (const e of this.core.m.context) {
      const realRoot = realOr(e.root);
      if (real === realRoot) return e.root;
      if (real.startsWith(realRoot + sep)) return join(e.root, relative(realRoot, real));
    }
    return abs;
  }

  /** The mirrored entry that covers `abs` (its root, or anything under it), if any. */
  coveringEntry(abs: string, except?: string): ContextEntry | undefined {
    return this.core.m.context.find(
      (e) =>
        e.id !== except &&
        e.membership === "mirrored" &&
        (abs === e.root || abs.startsWith(e.root + sep)),
    );
  }

  /**
   * A folder things may be made in or moved into: a mirrored entry's root or a
   * visible folder under one. Refuses anything else: the context stays the way
   * in.
   */
  destinationOrDie(rawDir: string): string {
    const abs = this.contextForm(resolve(rawDir));
    // A folder the tree shows, and never one that is really inside a bundle
    // (a linked folder in a set that leads into one's insides).
    const shown = (): string => {
      refuseInBundle(abs, "that folder");
      return this.notOwnPlaceOrDie(abs);
    };
    // A set's own root first, whatever the order of the context: a linked
    // folder added as a set of its own (what a link row's refusal says to do)
    // is also a link's row in the set that holds it, and must take things as
    // the set it now is.
    if (this.core.m.context.some((e) => e.membership === "mirrored" && abs === e.root))
      return shown();
    for (const e of this.core.m.context) {
      // A listed entry is no place to put things, but for a folder inside an
      // expandable bundle listed on its own (a stage's `docs/`), which is
      // shown under its row as a set's folder is.
      if (e.membership !== "mirrored" && listedFile(e)?.kind !== "bundle") continue;
      if (abs.startsWith(e.root + sep)) {
        const node = findNode(e.nodes, toPosix(relative(e.root, abs)));
        if (node?.kind === "group") return this.notThroughLinkOrDie(shown(), e);
      }
    }
    if (this.isWorkspace(abs)) return this.workspaceOrDie();
    if (!this.core.hasHome) {
      const r = notALocation(this.core.app, abs);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    throw new SessionError(
      `${abs} is not a folder in this session: name a set, a folder inside one, or the workspace (${this.core.workspace})`,
      400,
    );
  }

  /**
   * A folder of a set's tree that is a link (a link's row: the scan shows it
   * and never enters it), or that really is somewhere else (a folder above it
   * swapped for a link since the scan), takes nothing: what is made, imported,
   * moved or dropped there would land where the link leads and vanish from
   * the set. The way to work in it is to add it as a set of its own.
   */
  private notThroughLinkOrDie(abs: string, e: ContextEntry): string {
    let link: boolean;
    try {
      link = lstatSync(abs).isSymbolicLink();
    } catch {
      throw new SessionError(
        `${this.display(abs)} is no longer on disk: choose a folder that is, or look again once the list has caught up`,
        404,
      );
    }
    const real = realOr(abs);
    const root = rootReal(e);
    const outside = real !== root && !real.startsWith(root + sep);
    if (!link && !outside) return abs;
    throw new SessionError(
      `${this.display(abs)} ${link ? "is a link" : "is reached through a link"}${outside ? ` that leads outside ${e.label}` : ""} (to ${tilde(real)}): nothing is made in, moved into or dropped on a linked folder, or it would land there and vanish from the set`,
      400,
      undefined,
      `to work in that folder, add it as a set of its own: add ${abs}`,
    );
  }

  /** An existing folder on disk, as the context names it: where an undone move goes back to. */
  folderOrDie(rawDir: string): string {
    const abs = this.notOwnPlaceOrDie(this.contextForm(resolve(rawDir)));
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir)
      throw new GoneError(
        `${tilde(abs)} is no longer a folder: the move this would undo cannot go back`,
        409,
      );
    return abs;
  }

  /** A document or folder shown in the context, with where it is shown. */
  itemOrDie(rawPath: string): {
    abs: string;
    entry: ContextEntry;
    /** The whole entry (a set's own folder, a listed document or image), or a node inside a set. */
    whole: boolean;
    /** A folder on disk: a set's, a group's, or a bundle's. */
    dir: boolean;
    /** A bundle, with its registered type: one item, though a folder on disk. */
    bundle?: BundleType;
  } {
    const abs = this.contextForm(resolve(rawPath));
    // Inside an expandable bundle only a member's files and folders are items
    // a structure act takes: the member folder itself, the main file,
    // `info.json` and the rest are the type's own, shown and never acted on.
    const place = bundlePlace(abs);
    if (place !== null && place !== "member") {
      const b = bundleOf(abs) as NonNullable<ReturnType<typeof bundleOf>>;
      const name = `the ${b.type.label} ${bundleNameAt(b.root)}`;
      throw new SessionError(
        place === "member-folder"
          ? `${this.display(abs)} is ${name}'s folder for its documents: it is not renamed, moved, duplicated or deleted from here, but documents can be made in it, dropped into it and moved in and out of it`
          : `${this.display(abs)} is one of ${name}'s own files: ${outsideMembers(b.type)}`,
        409,
      );
    }
    const asBundle = (node: ContextNode | undefined) =>
      node?.kind === "bundle" ? bundleTypeOf(abs) : null;
    for (const e of this.core.m.context) {
      if (e.membership === "listed") {
        const only = listedFile(e);
        // A member's file in an expandable bundle listed on its own.
        if (place === "member" && only?.kind === "bundle" && abs.startsWith(only.abs + sep)) {
          const node = findNode(e.nodes, toPosix(relative(e.root, abs)));
          if (node && node.kind !== "file")
            return { abs, entry: e, whole: false, dir: node.kind === "group" };
        }
        if (only?.abs !== abs) continue;
        const bundle = asBundle(e.nodes[0]);
        return bundle
          ? { abs, entry: e, whole: true, dir: true, bundle }
          : { abs, entry: e, whole: true, dir: false };
      }
      if (abs === e.root) return { abs, entry: e, whole: true, dir: true };
      if (abs.startsWith(e.root + sep)) {
        const node = findNode(e.nodes, toPosix(relative(e.root, abs)));
        const bundle = asBundle(node);
        if (bundle) return { abs, entry: e, whole: false, dir: true, bundle };
        if (node) return { abs, entry: e, whole: false, dir: node.kind === "group" };
      }
    }
    throw new SessionError(`${abs} is not shown in this session's context`, 404);
  }

  /** Whether `abs` is shown anywhere in the context now. */
  itemAt(abs: string): boolean {
    try {
      this.itemOrDie(abs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The path to reveal in the file manager, or a `not_found` refusal.
   *
   * Only paths the session already knows are accepted: anything inside the
   * session folder (versions, renders), and anything under a
   * context entry's root (for a listed entry, the listed file itself, not its
   * siblings). Both sides are compared by realpath, so a `..` or a symlink
   * cannot carry a request outside. Anything else is refused as not found, so a
   * page cannot aim the file manager at an arbitrary path.
   */
  revealTarget(rawPath: string): string {
    if (!isAbsolute(rawPath))
      throw new SessionError(`${rawPath} is not a full path: start it with /`, 400);
    // Both the path as given and where it really leads must be inside a known
    // root. A symlink outside every root that points in is refused (the
    // given path is outside), and so is one inside that points out (its
    // realpath is outside). What is handed to the file manager is the
    // realpath, so what was checked is what is opened.
    const abs = resolve(rawPath);
    const real = realOr(abs);
    const within = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);
    const known = (() => {
      const roots: { root: string; only?: string }[] = [{ root: this.core.dir }];
      for (const e of this.core.m.context) {
        if (e.membership === "mirrored") roots.push({ root: e.root });
        else
          for (const n of e.nodes)
            if (n.kind !== "group")
              roots.push({ root: join(e.root, n.rel), only: join(e.root, n.rel) });
      }
      return roots.some(({ root }) => {
        const lexical = within(abs, root) || within(abs, realOr(root));
        return lexical && within(real, realOr(root));
      });
    })();
    if (!known || !existsSync(abs))
      throw new SessionError(`${abs} is not a path this session knows`, 404);
    return real;
  }

  /** Refuse a name that is not one plain file or folder name. */
  nameOrDie(name: string): string {
    const n = name.trim();
    if (
      n === "" ||
      n === "." ||
      n === ".." ||
      n.startsWith(".") ||
      /[/\\\0]/.test(n) ||
      n.length > 255
    )
      throw new SessionError(
        `"${name}" is not a usable name: one plain name, no slashes, not starting with a dot`,
        400,
      );
    return n;
  }

  /** A document name: a name without a document extension gets `.md`. */
  docNameOrDie(name: string): string {
    const n = this.nameOrDie(name);
    return isDocName(n) ? n : `${n}.md`;
  }
}
