/**
 * The session's types: the context index, the move plan's pinned links and
 * world, what an app declares (`AppDeclaration`, `checkApp`), what a watcher
 * event and a restore turned out to be, and a task's transitions. Tier 0 of
 * the session parts (docs/architecture/workspace-session.md).
 */

import type { ResolvableDocument } from "../linkEdges";
import type { LinkKind } from "../links";
import type { ManifestMigrateContext, ManifestMigrated, MigrateManifest } from "../manifestMigrate";
import type { MovedWorld } from "../movePlan";
import type { ContextEntry, TaskAuthor, TaskStatus } from "../protocol";
import type { ScanSkip } from "../tree";

/** The context's documents by path, each with the entry listing it, and the entries' realpath roots. */
export type ContextIndex = {
  entryOf: Map<string, string>;
  /**
   * Every image the context shows (a set's image nodes and loose images): what
   * a link or an embed may land on besides a document. Never read, only named.
   */
  images: Set<string>;
  /** Every document the tree marks as an image's description (`sidecar`). */
  sidecars: Set<string>;
  realRoots: { root: string; real: string }[];
};

/** A link pinned before a move (`pinLinks`): where it is written, as written, and where it landed. */
export type LinkPin = {
  /** `reference`: a bundle's reference (a card on a board), read and written by its type. */
  kind: LinkKind | "reference";
  src: string;
  raw: string;
  target: string;
  line: number;
  label?: string;
  embed?: true;
  /** A reference's holder, by its id in the file. */
  id?: string;
};

/** An app edge pinned before a move (`pinEdges`): where it is written, as written, and where it landed. */
export type EdgePin = {
  kind: string;
  src: string;
  raw: string;
  target: string;
  key?: string;
  line?: number;
};

/** A context entry as it would be after a move (`planWorld`), with a listed entry's one item. */
export type EntryAfter = { e: ContextEntry; file: string | null };

/**
 * The world after a move that has not happened (`movePlan`): the paths, the
 * context's entries as they would be, and the documents an app's resolver
 * would be handed then, once built.
 */
export type PlanWorld = MovedWorld & {
  entries: readonly EntryAfter[];
  docs?: readonly ResolvableDocument[];
};

/**
 * The app's slot in the manifest. `version` is the slot's own schema version;
 * `migrate` brings a stored slot forward from an older one. A fresh session
 * starts from `migrate({}, 0)`, so the slot has one place that says what it
 * looks like, at every version.
 */
export type AppSlot = {
  version: number;
  migrate(prev: Record<string, unknown>, prevVersion: number): Record<string, unknown>;
};

/** Where a set's scan is: the entry, its folder, and the app's slot as it is now (read-only). */
export type ScanAt = {
  entryId: string;
  root: string;
  slot: Readonly<Record<string, unknown>>;
};

/**
 * What an app says about one scan of a set (`AppDeclaration.scan`). `skip`
 * leaves a path out of the tree, and so out of search, links and the graph;
 * the files stay on disk. The object is the place for more of the same kind
 * (a rule that changes a node rather than dropping it), so an app can say
 * more without a second hook.
 */
export type ScanRule = {
  skip?: ScanSkip;
};

/** What an app declares about itself: its name and its manifest slot. */
export type AppDeclaration = {
  name: string;
  /** The name a human reads ("Sound Stage"), shown in the surface's top bar. Defaults to `name`. */
  title?: string;
  slot: AppSlot;
  /** How to run the app's CLI, absolute (`bun /path/to/scripts/cli.ts`), shown to the human to copy. */
  launcher?: string;
  /**
   * The app's filter on the kit's tree scan: asked once per scan of a set (a
   * restore, a rescan, an outside change, an add), with the slot as it is
   * then. Keep what it reads in the app slot, so it survives a restart and
   * every rescan sees it; after changing that, call `refilter` so the tree,
   * search and links follow. `undefined` (or no hook) scans everything.
   */
  scan?: (at: ScanAt) => ScanRule | undefined;
  /**
   * A whole-manifest migrate, run on a stored manifest before a restore reads
   * it: before the format check and the foreign-manifest guard. For sessions
   * written by something with another core shape. Null for a manifest that
   * needs nothing; a throw refuses the restore with its reason, and nothing is
   * written. See `manifestMigrate.ts` for the rules.
   */
  migrateManifest?: MigrateManifest;
  /**
   * Asked again at the moment a conversion is written (the kept copy and the
   * converted manifest), and before anything else in the session folder is
   * touched: why the write is refused now, or null. For a rule the app checked
   * at boot that the disk can break later (a sessions folder swapped for a
   * link). A refusal is the restore's 409, and nothing is written.
   */
  migrateWriteRefusal?: (at: ManifestMigrateContext) => string | null;
  /**
   * `false`: the app has no home workspace (`./noHome.ts`). Nothing writes a
   * new file or folder to a place the caller did not name: a create, drop or
   * import that names no folder is refused with the way to name one, the
   * session keeps no workspace folder, and `workspace.set` is refused. Absent
   * (or `true`): the kit's home workspace, where those land.
   */
  homeWorkspace?: boolean;
  /**
   * With `homeWorkspace: false`: how this app's caller names a place, or makes
   * one, in its own verbs' words; the hint of every refusal for want of one.
   * Absent: the kit's words (`DEFAULT_LOCATION_HINT`).
   */
  locationHint?: string;
};

const APP_NAME = /^[a-z][a-z0-9-]*$/;

/** Validate what an app declared, once, where the mistake is cheap to read. */
export function checkApp(app: AppDeclaration): AppDeclaration {
  if (!APP_NAME.test(app.name))
    throw new Error(`invalid app name: ${JSON.stringify(app.name)} (lowercase, digits, dashes)`);
  if (!Number.isInteger(app.slot.version) || app.slot.version < 1)
    throw new Error(`app ${app.name}: slot.version must be a whole number from 1`);
  return app;
}

/** What a watcher event turned out to be. `null` means nothing: ours, or no change. */
export type FileEvent =
  | { kind: "version.changed"; doc: string; version: number; text: string; active: false }
  | {
      kind: "active.outside";
      doc: string;
      version: number;
      path: string;
      /** The new agent version the outside text was preserved as. */
      preservedAs: number;
      preservedPath: string;
    }
  | {
      kind: "version.created";
      doc: string;
      version: number;
      path: string;
      /** The number the hand-written file carried, when it was renumbered. */
      renamedFrom?: number;
    }
  | { kind: "original.reloaded"; doc: string; version: number; text: string; original: string }
  | { kind: "original.conflict"; doc: string; original: string }
  /** The original is gone from disk; `folder` when its folder went too. */
  | { kind: "original.missing"; doc: string; original: string; folder: boolean }
  /** A missing original is back, as it was. (Back with other text is a conflict.) */
  | { kind: "original.back"; doc: string; original: string }
  | { kind: "tree"; entryId: string }
  /**
   * A file inside a bundle the context shows changed (`file`, which may be
   * the bundle itself): a change to the bundle at `path`. Its main file, when
   * the session holds it, is classified as a document instead.
   */
  | { kind: "bundle"; path: string; file: string };

/** What a restore found: changes made while no daemon was watching. */
export type RestoreReport = {
  /** Documents whose original changed (or vanished) while the session was closed. */
  outside: { doc: string; original: string; missing: boolean }[];
  /** Tasks the restore had to settle, because the daemon that ran them is gone. */
  tasks: { id: string; title: string; was: TaskStatus; now: TaskStatus }[];
  /** The app slot was brought forward from this version. */
  slotMigratedFrom?: number;
  /** The app's whole-manifest migrate converted the stored manifest (`AppDeclaration.migrateManifest`). */
  manifestMigrated?: ManifestMigrated;
  /** The manifest had no workspace: the folder chosen for it (the first context entry's, else the session's `imported/`). */
  workspaceDefaulted?: string;
  /**
   * An app with no home workspace: the folder the manifest still held as its
   * workspace, dropped and added as a set because it holds files.
   */
  workspaceAdded?: string;
  /**
   * Entries the manifest held that showed the app's own places (the sessions
   * or the app home): `dropped`, one that lay among them, `why` saying so;
   * `narrowed`, a set that holds them in plain sight, kept with them left out
   * of its scan, `why` the own folder left out (the outermost it holds).
   */
  ownPlaceSets?: { label: string; root: string; outcome: "dropped" | "narrowed"; why: string }[];
};

/** The legal task transitions. Everything else is a conflict. */
export const TASK_NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
  open: ["running", "cancelled"],
  running: ["done", "failed", "cancelled"],
  done: [],
  failed: [],
  cancelled: [],
};

export const FINISHED: readonly TaskStatus[] = ["done", "failed", "cancelled"];
export const isFinished = (s: TaskStatus): boolean => FINISHED.includes(s);

export type NewTask = {
  title: string;
  by: TaskAuthor;
  /** `open` (the default) or `running` (the creator is already on it). */
  status?: "open" | "running";
  kind?: string;
  messageId?: string;
  parent?: string;
  /** Settles with no chat line or toast of its own: its parent speaks for it (`Task.quiet`). */
  quiet?: boolean;
  detail?: string;
  /**
   * What the runner needs to do the job (a render's document and voice). Held by
   * the task engine in memory for the task's life, passed to the runner as
   * `task.input`, never written to the manifest, and dropped when the task settles.
   */
  input?: unknown;
};
