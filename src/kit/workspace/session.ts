/**
 * The session: the daemon's state, and the only code that writes a file.
 *
 * The daemon owns the session (context, docs, versions, which is active, the
 * chat, the tasks) and persists it as `manifest.json`; every version's text is
 * a file in the session folder, so the agent edits versions with its own file
 * tools.
 *
 *     <sessions root>/<sessionId>/
 *       manifest.json              written atomically, on status changes only
 *       docs/<slug>/v1.md, v2.md   one file per version
 *
 * The write rules, each a decision rather than a habit:
 *
 * - The original is written only by `save`. Opening copies it to v1; nothing
 *   else touches it.
 * - Every write this module makes is remembered by content hash (the `owned`
 *   map, in `session/writes.ts`), so the watcher can tell the daemon's own writes from anyone else's. A
 *   write to the active version that is not ours is a mistake the daemon
 *   announces.
 * - The agent never writes the active version. That is enforced socially by the
 *   skill and detected here, not prevented: the file is the agent's medium.
 * - The manifest is written on status changes, never on progress ticks.
 *
 * Nothing here knows about sockets, HTTP or the event log. The daemon calls a
 * method, gets a result, and decides what to broadcast; that split is what
 * lets the unit tests drive the whole model with a temp folder.
 */

// ⛔ No raw write from `node:fs` here: every write goes through `./disk.ts`
// (`this.places.world` for the world the sets show, `this.own` for the session's
// own files), which checks each path at the syscall. The ward
// `grimoire/kit-disk-write-ward.test.ts` holds this file to it.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { NOT_PLACED } from "../document/notPlaced.ts";
import {
  BUNDLE_INFO,
  type BundleType,
  bundleDisplayName,
  bundleOf,
  bundleStem,
  bundleTypeOf,
  bundleTypes,
  isBundleMain,
  isBundleMember,
  newBundleInfo,
  referencingBundle,
  writeBundleInfo,
} from "../lib/bundles.ts";
import {
  docFormat,
  EXTENSION_OF,
  IMAGE_EXTENSIONS,
  type ImageType,
  isHeicName,
  isImageName,
  isSvgName,
  SVG_REFUSED,
  sniffImage,
} from "../lib/docFormat.ts";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import { describeJsonProblem, type JsonProblem, jsonProblem } from "../lib/json.ts";
import { splitTarget } from "../lib/linkTarget.ts";
import {
  describeSidecar,
  type ImageDescription,
  type ImageSource,
  imageOfSidecar,
  sidecarOf,
  sidecarSkeleton,
} from "../lib/sidecar.ts";
import { type Anchor, anchorOf, findAnchor, linesOf, quoteLabel } from "./anchors";
import { applyHunks, diffText } from "./diff";
import type { Disk } from "./disk";
import { type Finding, findings, type Overlap } from "./doctor";
import type { ClosedBy } from "./events";
import { IMAGE_MAX_BYTES, openNoFollow, readAllFd, readHeadFd, stampOf } from "./images";
import type { LinkSlot, ResolvableDocument } from "./linkEdges";
import {
  type LinkOrigin,
  type Resolution,
  rebaseCopy,
  relativeHref,
  retarget,
  swapLinkTargets,
} from "./links";
import {
  keepPreMigrate,
  migrateRefusal,
  PRE_MIGRATE_FILE,
  runManifestMigrate,
} from "./manifestMigrate";
import { type EdgeBreak, type MovedWorld, type MovePlan, movedWorld, treeOrder } from "./movePlan";
import {
  hasHomeWorkspace,
  holdsOwnPlaces,
  inOwnPlaces,
  notAddedWhole,
  notASet,
  noWorkspaceToSet,
  ownPlaceGuard,
} from "./noHome";
import { PROFILES_DIR } from "./profiles";
import type {
  Author,
  Backlinks,
  ContextEntry,
  ContextNode,
  DiffPayload,
  DiffSide,
  Doc,
  DocCardSummary,
  DocLinkFixes,
  DocSummary,
  DocText,
  DocumentProfile,
  DocView,
  DroppedLink,
  EmbedView,
  GraphOptions,
  ImageView,
  LinkCheck,
  LinkCheckOptions,
  LinkGraph,
  LinkHeadings,
  LinkTargets,
  Message,
  Note,
  Outlinks,
  PlacedNote,
  ProfileCheck,
  ProfilesReport,
  RelationsAt,
  RelationsReport,
  SearchReport,
  Session,
  Task,
  TaskStatus,
  TrashPreview,
  Version,
  WikiBreak,
} from "./protocol";
import { Chats } from "./session/chats.ts";
import { GoneError, SessionError, UnseenChangeError } from "./session/errors.ts";
import {
  docFacts,
  IMAGES_DIR,
  IMPORT_NAMES_MAX,
  IMPORTED_DIR,
  MANIFEST_FORMAT,
  MOVES_KEPT,
} from "./session/facts.ts";
import { LinkChecker } from "./session/linkCheck.ts";
import { LinkReports } from "./session/linkReports.ts";
import { LinkResolve } from "./session/linkResolve.ts";
import { migrateSlot, refuseForeignManifest, refuseMalformedManifest } from "./session/manifest.ts";
import {
  bundleNameAt,
  checkSessionId,
  contentHash,
  copyName,
  entryAt,
  FREE_NAME_TRIES,
  fitName,
  newSessionId,
  nowIso,
  randHex,
  sideName,
  slugBase,
  tilde,
  uncopied,
} from "./session/names.ts";
import {
  bundleHolding,
  isFolder,
  movedPairs,
  outsideMembers,
  overlapOf,
  realOr,
  refuseWorkspaceInBundle,
  rootReal,
  shownOverlap,
  treeHash,
} from "./session/paths.ts";
import { Places } from "./session/places.ts";
import { Profiles } from "./session/profiles.ts";
import { ReadIndex } from "./session/readIndex.ts";
import { Relations } from "./session/relations.ts";
import { Search } from "./session/search.ts";
import { State } from "./session/state.ts";
import { Tasks } from "./session/tasks.ts";
import {
  type AppDeclaration,
  type ContextIndex,
  checkApp,
  type EdgePin,
  type EntryAfter,
  type FileEvent,
  type LinkPin,
  type NewTask,
  type PlanWorld,
  type RestoreReport,
} from "./session/types.ts";
import { Writes } from "./session/writes.ts";
import {
  bundleNode,
  bundlesIn,
  docExtensions,
  docNode,
  docPaths,
  entryForPath,
  findNode,
  imagePaths,
  isDocName,
  listedFile,
  locate,
  MIRROR_NODE_CAP,
  PathError,
  readBundleInfo,
  type ScanGuard,
  type ScanSkip,
  scanTree,
  sidecarFile,
  toPosix,
} from "./tree";

// Tier 0 of the session parts (docs/architecture/workspace-session.md): every
// name this module exported before the split, still exported from here.
export { GoneError, SessionError, UnseenChangeError } from "./session/errors.ts";
export {
  BACKLINK_CAP,
  EMBED_CAP,
  GRAPH_CAP,
  IMAGES_DIR,
  IMPORTED_DIR,
  LINK_CHECK_CAP,
  MANIFEST_FORMAT,
  PROFILE_CHECK_CAP,
  PROFILE_WARNINGS_PER_DOC,
} from "./session/facts.ts";
export {
  bundleNameAt,
  caseInsensitiveAt,
  checkSessionId,
  contentHash,
  copyName,
  entryAt,
  fitName,
  NAME_MAX_BYTES,
  newSessionId,
  nowIso,
  sideName,
  tilde,
  uncopied,
} from "./session/names.ts";
export { bundleHolding, overlapOf, realOr, treeHash } from "./session/paths.ts";
export {
  type AppDeclaration,
  type AppSlot,
  checkApp,
  FINISHED,
  type FileEvent,
  isFinished,
  type NewTask,
  type RestoreReport,
  type ScanAt,
  type ScanRule,
} from "./session/types.ts";

/**
 * The note guard (`showsSelection`), loaded the first time a note arrives with
 * what the human selected. ⛔ NEVER A STATIC IMPORT: it pulls in the markdown
 * parser, and every daemon and CLI start loads this file; 31 more modules made
 * each spawn about 10% slower, and a test of 21 spawns ran out of time.
 */
let noteGuard: typeof import("../document/projection.ts").showsSelection | null = null;
/** Load the note guard; `addNote` with `seen` needs it. Cheap once loaded. */
export async function loadNoteGuard(): Promise<void> {
  noteGuard ??= (await import("../document/projection.ts")).showsSelection;
}

/**
 * The loaded guard. ⛔ Not loaded is a caller's mistake (`loadNoteGuard` first),
 * and it is said, never taken as a pass: an unchecked note is the bug the guard
 * is for.
 */
function guardLoaded(): NonNullable<typeof noteGuard> {
  if (!noteGuard)
    throw new Error(
      "addNote: a note with `seen` needs the note guard: await loadNoteGuard() first",
    );
  return noteGuard;
}

export class WorkspaceSession {
  readonly dir: string;
  /** Tier 1 (docs/architecture/workspace-session.md): the core every part takes, built first. */
  private readonly core: State;
  private readonly places: Places;
  private readonly writes: Writes;
  /** Tier 2: the chat. */
  private readonly chats: Chats;
  /** Tier 3: the task list (`taskList`, since `tasks()` is a public verb). */
  private readonly taskList: Tasks;
  /** Tier 4: the read side (S5): the read index, resolving, profiles, relations, search. */
  private readonly readIndex: ReadIndex;
  private readonly linkResolve: LinkResolve;
  /** `profilesPart`, `relationsPart`, `searchPart`: `profiles()`, `relations()` and `search()` are public verbs. */
  private readonly profilesPart: Profiles;
  private readonly relationsPart: Relations;
  private readonly searchPart: Search;
  /** Tier 5: the link check (`linkCheckPart`, since `linkCheck()` is a public verb) and the link reports. */
  private readonly linkCheckPart: LinkChecker;
  private readonly linkReports: LinkReports;
  /** slug to hash of the active version's current text. */
  private activeHash = new Map<string, string>();
  /** slug to the active version's text as the daemon last wrote (or adopted) it:
   *  what an outside write to the active version is reverted to. */
  private lastActiveText = new Map<string, string>();
  /**
   * Every move and rename this daemon made (`followMove`), oldest first, an
   * undo's way back included: what the link check's `proposed` reads to say
   * where a proposal's old target went. Memory only, so a restart forgets it
   * and a proposal's broken link is then reported with no `suggest`.
   */
  private moves: [from: string, to: string][] = [];
  /** What a restore found changed while no daemon was watching. */
  restoreReport: RestoreReport = { outside: [], tasks: [] };

  private constructor(
    readonly sessionsRoot: string,
    readonly app: AppDeclaration,
    manifest: Session,
  ) {
    this.core = new State(sessionsRoot, app, manifest);
    this.dir = this.core.dir;
    this.places = new Places(this.core);
    this.writes = new Writes(this.core, this.places);
    this.chats = new Chats(this.core, { persist: () => this.persist() });
    this.taskList = new Tasks(this.core, { persist: () => this.persist() });
    this.readIndex = new ReadIndex(this.core, this.places, {
      activeText: (d) => this.activeText(d),
      filteredOut: () => this.filteredOut(),
      mainOf: (abs) => this.mainOf(abs),
      findDoc: (key) => this.findDoc(key),
      docOrDie: (slug, opts) => this.docOrDie(slug, opts),
    });
    this.linkResolve = new LinkResolve(this.core, this.places, this.readIndex, {
      docOrDie: (slug, opts) => this.docOrDie(slug, opts),
      imageOfDoc: (path, index) => this.imageOfDoc(path, index),
      imageDescription: (abs, index) => this.imageDescription(abs, index),
      imageFile: (rawPath) => this.imageFile(rawPath),
      imageNodeAt: (abs) => this.imageNodeAt(abs),
      docsAfter: (index, world) => this.docsAfter(index, world),
      typedLinks: (index, all) => this.relationsPart.typedLinks(index, all),
      relationPass: (index) => this.relationsPart.relationPass(index),
    });
    this.profilesPart = new Profiles(this.core, this.places, this.readIndex);
    this.relationsPart = new Relations(
      this.places,
      this.readIndex,
      this.linkResolve,
      this.profilesPart,
    );
    this.searchPart = new Search(this.places, this.readIndex, {
      imageOfDoc: (path, index) => this.imageOfDoc(path, index),
    });
    this.linkCheckPart = new LinkChecker(
      this.core,
      this.places,
      this.readIndex,
      this.linkResolve,
      this.relationsPart,
      {
        movedFrom: (path) => this.movedFrom(path),
        movedTarget: (raw, src, wasAt, tried, entry, index) =>
          this.movedTarget(raw, src, wasAt, tried, entry, index),
      },
    );
    this.linkReports = new LinkReports(
      this.core,
      this.places,
      this.readIndex,
      this.linkResolve,
      this.profilesPart,
      this.relationsPart,
      { findDoc: (key) => this.findDoc(key), versionOrDie: (d, n) => this.versionOrDie(d, n) },
    );
  }

  /**
   * The app's part of the link layer (kit-link-edges-slot): edges it adds
   * beside the body links, and a resolver for its own forms. Set once, as the
   * daemon boots (`WorkspaceDaemonOptions.links`); what was read before is
   * read again.
   */
  setLinkSlot(slot: LinkSlot | undefined): void {
    this.readIndex.setLinkSlot(slot);
  }

  /**
   * What the app asks of the link check (`WorkspaceDaemonOptions.linkCheck`):
   * the links leaving their set, and its word for a set. Set once, as the
   * daemon boots; without it the check is the kit's own.
   */
  setLinkCheck(opts: LinkCheckOptions | undefined): void {
    this.readIndex.setLinkCheck(opts);
  }

  static create(
    sessionsRoot: string,
    app: AppDeclaration,
    sessionId: string = newSessionId(),
    workspace?: string,
  ): WorkspaceSession {
    checkApp(app);
    checkSessionId(sessionId);
    // A new session never overwrites a saved one.
    if (existsSync(join(sessionsRoot, sessionId, "manifest.json")))
      throw new SessionError(`session ${sessionId} already exists: restore it instead`, 409);
    const s = new WorkspaceSession(sessionsRoot, app, {
      format: MANIFEST_FORMAT,
      sessionId,
      appName: app.name,
      createdAt: nowIso(),
      // Where `open` ran (the CLI passes its cwd). Nothing said: the session's
      // own `imported/` folder, made on demand. Never the home folder. An app
      // with no home workspace keeps none, whatever was passed.
      ...(hasHomeWorkspace(app)
        ? {
            workspace: workspace ? resolve(workspace) : join(sessionsRoot, sessionId, IMPORTED_DIR),
          }
        : {}),
      context: [],
      docs: [],
      openDoc: null,
      chat: [],
      tasks: [],
      app: { ...app.slot.migrate({}, 0), version: app.slot.version },
    });
    s.own.mkdir(join(s.dir, "docs"), { recursive: true });
    s.core.pinDir();
    s.persist();
    return s;
  }

  /** Reload a session from its manifest (`open --restore <id>`). */
  static restore(
    sessionsRoot: string,
    app: AppDeclaration,
    sessionId: string,
    opts: { appHome?: string } = {},
  ): WorkspaceSession {
    checkApp(app);
    checkSessionId(sessionId);
    const path = join(sessionsRoot, sessionId, "manifest.json");
    if (!existsSync(path)) throw new SessionError(`no saved session ${sessionId}`, 404);
    let raw: Record<string, unknown>;
    const stored = readFileSync(path, "utf8");
    try {
      raw = JSON.parse(stored) as Record<string, unknown>;
    } catch {
      throw new SessionError(`session ${sessionId} has a manifest that is not valid JSON`, 409);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new SessionError(`session ${sessionId} has a manifest that is not a JSON object`, 409);
    // The app's whole-manifest migrate, before any check: what it returns is
    // checked below exactly as a stored manifest is, and nothing is written
    // until every check has passed.
    const migrateAt = { sessionId, dir: join(sessionsRoot, sessionId), sessionsRoot };
    const migrated = runManifestMigrate(app.migrateManifest, raw, migrateAt, (reason) => {
      throw new SessionError(migrateRefusal(app.name, sessionId, reason), 409);
    });
    raw = migrated.raw;
    // The app's write check for a conversion, asked now (before anything in the
    // session folder is touched) and again just before the conversion is written.
    const migrateWriteOrDie = (): void => {
      const why = migrated.migration ? (app.migrateWriteRefusal?.(migrateAt) ?? null) : null;
      if (why !== null) throw new SessionError(migrateRefusal(app.name, sessionId, why), 409);
    };
    migrateWriteOrDie();
    // An unknown format is refused, never guessed at: a newer kit may have
    // written fields this one would silently drop on the next write.
    if (raw.format !== MANIFEST_FORMAT)
      throw new SessionError(
        `session ${sessionId} has manifest format ${JSON.stringify(raw.format)}; this build reads format ${MANIFEST_FORMAT}`,
        409,
      );
    refuseForeignManifest(raw, app, sessionId);
    if (raw.sessionId !== sessionId)
      throw new SessionError(
        `session ${sessionId}'s manifest says it is ${JSON.stringify(raw.sessionId)}`,
        409,
      );
    // ⛔ CHECKED WHOLE, BEFORE ANYTHING IS CHANGED OR WRITTEN. A restore that
    // failed part-way (a document with no `notes`) had already marked outside
    // changes and persisted the manifest, then answered a 500.
    refuseMalformedManifest(raw, sessionId);
    const m = raw as unknown as Session;
    // A restored session is live again: whoever ended it before, nobody has
    // now. Written below, so a daemon that dies without closing leaves no
    // stale `ended` for a re-armed tail to read.
    const wasEnded = m.ended !== undefined;
    delete m.ended;
    // A kit manifest from before the name was stamped: its slot passed the
    // shape check, so it is this app's. Written with the next change.
    m.appName = app.name;
    const report: RestoreReport = { outside: [], tasks: [] };
    if (migrated.migration)
      report.manifestMigrated = {
        ...(migrated.migration.note !== undefined ? { note: migrated.migration.note } : {}),
        kept: join(sessionsRoot, sessionId, PRE_MIGRATE_FILE),
      };
    m.app = migrateSlot(app, m.app, sessionId, report);
    // A manifest written before the workspace existed: the first context entry's
    // folder, else the session's own `imported/` folder (what drops did before).
    // Never the home folder: drops and new documents would write straight into it.
    // Not a set's own folder, though: the workspace may not overlap a set
    // (`overlapOf`), so a first entry that is a set gives way to `imported/`.
    // An app with no home workspace keeps none: one a manifest still holds
    // (written before the app declared none) is dropped, never used. Its files
    // stay reachable: a folder that holds some becomes a set, below.
    let droppedWorkspace = false;
    let storedWorkspace: string | undefined;
    if (!hasHomeWorkspace(app)) {
      if (m.workspace !== undefined) {
        if (typeof m.workspace === "string" && m.workspace !== "") storedWorkspace = m.workspace;
        delete m.workspace;
        droppedWorkspace = true;
      }
    } else if (typeof m.workspace !== "string" || m.workspace === "") {
      const first = m.context[0]?.root;
      m.workspace =
        first !== undefined && overlapOf(first, m.context) === null
          ? first
          : join(sessionsRoot, sessionId, IMPORTED_DIR);
      report.workspaceDefaulted = m.workspace;
    }
    const s = new WorkspaceSession(sessionsRoot, app, m);
    s.restoreReport = report;
    s.setAppHome(opts.appHome);
    s.own.mkdir(join(s.dir, "docs"), { recursive: true });
    s.core.pinDir();
    // ⛔ A SET FROM AN OLDER MANIFEST NEVER SHOWS THE APP'S OWN PLACES. One
    // that lies among the sessions or in the app home is dropped; one that
    // holds them in plain sight is kept, narrowed by the scan's guard, which
    // leaves them out of it. Said in the chat either way.
    s.settleOwnPlaceSets(report);
    // Mirrors are re-read, not trusted: the folder may have changed while no
    // daemon was watching it.
    for (const e of s.core.m.context) if (e.membership === "mirrored") s.rescan(e.id);
    // A manifest from before entries kept their root's realpath: taken now.
    for (const e of s.core.m.context) if (!e.realRoot) e.realRoot = realOr(e.root);
    if (storedWorkspace !== undefined) {
      const added = s.keepDroppedWorkspace(storedWorkspace);
      if (added) report.workspaceAdded = added;
    }
    for (const d of s.core.m.docs) {
      const p = s.core.versionPath(d, d.active);
      const text = existsSync(p) ? readFileSync(p, "utf8") : "";
      s.adoptActive(d, text);
      // An original changed while the session was closed was invisible here, so
      // the next Save overwrote it unannounced. The manifest holds the
      // original's hash as of the last open, save, revert or reload; a
      // different hash now is an outside change, marked exactly as a live one
      // with a dirty buffer is: asked, never merged or reloaded.
      let now: string | null = null;
      try {
        now = contentHash(readFileSync(d.original, "utf8"));
      } catch {
        now = null;
      }
      // A file that is gone is marked missing rather than changed: the pane says
      // so, and Save recreates it only when asked.
      if (now === null) {
        d.missing = true;
        report.outside.push({ doc: d.slug, original: d.original, missing: true });
      } else {
        delete d.missing;
        if (now !== d.originalHash) {
          // Already asked before the restart: still about the text asked about
          // then, so a newer one is asked about at Save, not kept over unseen.
          if (!d.outsideChanged) d.outsideHash = now;
          d.outsideChanged = true;
          report.outside.push({ doc: d.slug, original: d.original, missing: false });
        }
      }
    }
    // The daemon that ran a daemon task is gone, so nothing will finish it: a
    // running one failed, a queued one is cancelled (re-running it unasked could
    // spend money). The agent outlives the daemon, so an agent task is left as
    // it was, and so is a human task.
    for (const t of s.core.m.tasks) {
      if (t.by !== "daemon") continue;
      const was = t.status;
      if (was === "running") {
        t.status = "failed";
        t.detail = "the daemon stopped while this was running (session restored)";
      } else if (was === "open") {
        t.status = "cancelled";
        t.detail = "the daemon stopped before this started (session restored)";
      } else continue;
      t.updatedAt = nowIso();
      report.tasks.push({ id: t.id, title: t.title, was, now: t.status });
    }
    if (
      wasEnded ||
      report.outside.length > 0 ||
      report.tasks.length > 0 ||
      report.workspaceDefaulted ||
      droppedWorkspace ||
      (report.ownPlaceSets?.length ?? 0) > 0 ||
      report.slotMigratedFrom !== undefined ||
      report.manifestMigrated
    ) {
      // A converted manifest keeps what it replaced, written first: a failure
      // between the two leaves the original readable.
      if (report.manifestMigrated) {
        migrateWriteOrDie();
        keepPreMigrate(s.dir, stored, s.own);
      }
      s.persist();
    }
    return s;
  }

  static listSaved(sessionsRoot: string): string[] {
    try {
      return readdirSync(sessionsRoot).filter((id) =>
        existsSync(join(sessionsRoot, id, "manifest.json")),
      );
    } catch {
      return [];
    }
  }

  /**
   * A restored no-home session's dropped workspace folder, added as an
   * ordinary set when it still holds files (as the converter adds the shipped
   * session's old workspace), so they stay reachable as a destination. Not the
   * session's own `imported/`, a folder a set already shows, or one no set
   * should mirror whole (`notAddedWhole`). Returns the folder when added.
   */
  private keepDroppedWorkspace(folder: string): string | undefined {
    if (realOr(folder) === realOr(join(this.dir, IMPORTED_DIR))) return undefined;
    if (notAddedWhole(folder, this.sessionsRoot) !== null) return undefined;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return undefined; // gone, or not a folder
    }
    if (!names.some((n) => !n.startsWith("."))) return undefined;
    const real = realOr(folder);
    if (
      this.core.m.context.some(
        (e) =>
          e.membership === "mirrored" &&
          (real === realOr(e.root) || real.startsWith(realOr(e.root) + sep)),
      )
    )
      return undefined;
    // As `addContext` does, but unpersisted: the restore writes the manifest
    // once, after it keeps any pre-migrate copy.
    const id = `c-${randHex(3)}`;
    const entry = entryForPath(
      resolve(folder),
      id,
      (root) => this.scanSkip(id, root),
      this.scanGuard(),
    );
    if (entry.membership !== "mirrored") return undefined;
    this.core.m.context.push(entry);
    this.relink();
    return folder;
  }

  /** Point the workspace at an existing folder (relative paths resolve against the daemon's cwd: callers send absolute ones). */
  setWorkspace(rawPath: string): { path: string; from: string } {
    if (!this.hasHome) {
      const r = noWorkspaceToSet(this.app);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    const abs = this.places.notOwnPlaceOrDie(resolve(rawPath));
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new SessionError(`no such folder: ${abs}`, 404);
    }
    if (!isDir) throw new SessionError(`the workspace must be a folder: ${abs}`, 400);
    // Said when it is set, not at the first write it would refuse.
    refuseWorkspaceInBundle(abs);
    try {
      accessSync(abs, constants.W_OK);
    } catch {
      throw new SessionError(`the workspace must be a folder you can write to: ${abs}`, 400);
    }
    const overlap = overlapOf(abs, this.core.m.context);
    if (overlap)
      throw new SessionError(
        `the workspace cannot be ${overlap.same ? "the folder of" : "inside"} the set ${overlap.label} (${tilde(overlap.root)}): a file there would belong to both. Choose a folder outside it, such as ${tilde(dirname(overlap.root))}, or remove ${overlap.label} from the context first`,
        409,
      );
    const from = this.workspace;
    this.core.m.workspace = abs;
    this.persist();
    return { path: abs, from };
  }

  /**
   * The set the workspace folder is, or is inside, or null. A session from
   * before the block (`kit-workspace-set-overlap`) can still hold one: it opens,
   * and the daemon says what to change.
   */
  workspaceOverlap(): Overlap | null {
    if (!this.hasHome) return null;
    return overlapOf(this.workspace, this.core.m.context);
  }

  /**
   * The overlap to say at startup, with its paths as the app shows them, or
   * null: said once per session, and again only when it changed (another
   * workspace or another set). A session that no longer overlaps forgets it.
   */
  overlapToSay(): (Overlap & { workspace: string }) | null {
    const o = this.workspaceOverlap();
    const key = o ? `${this.workspace}\n${o.root}` : undefined;
    if (key === this.core.m.overlapSaid) return null;
    if (key === undefined) delete this.core.m.overlapSaid;
    else this.core.m.overlapSaid = key;
    this.persist();
    return o ? shownOverlap(o, this.workspace) : null;
  }

  get openDocSlug(): string | null {
    return this.core.m.openDoc;
  }

  get context(): readonly ContextEntry[] {
    return this.core.m.context;
  }

  /** The app's slot data, without its `version` (a copy: change it through `updateApp`). */
  get appSlot(): Record<string, unknown> {
    const { version: _version, ...data } = this.core.m.app;
    return structuredClone(data);
  }

  /** Change the app's slot and persist. The slot is the app's; the `version` key is not. */
  updateApp(change: (slot: Record<string, unknown>) => void): void {
    const slot = this.appSlot;
    change(slot);
    if ("version" in slot) throw new Error("`version` is reserved in the app slot");
    this.core.m.app = { ...slot, version: this.app.slot.version };
    this.persist();
  }

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
      { path: this.docsDir, watch: realOr(this.docsDir), recursive: true },
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

  // ── persistence ────────────────────────────────────────────────────────

  // The core's public members, delegated (`session/state.ts`, `places.ts`, `writes.ts`).
  get id(): string {
    return this.core.id;
  }

  get docsDir(): string {
    return this.core.docsDir;
  }

  get hasHome(): boolean {
    return this.core.hasHome;
  }

  get workspace(): string {
    return this.core.workspace;
  }

  get own(): Disk {
    return this.core.own;
  }

  markEnded(by: ClosedBy): void {
    this.core.markEnded(by);
  }

  persist(): void {
    this.core.persist();
  }

  isWorkspace(abs: string): boolean {
    return this.places.isWorkspace(abs);
  }

  display(abs: string): string {
    return this.places.display(abs);
  }

  shownFolderOrDie(dir: string): string {
    return this.places.shownFolderOrDie(dir);
  }

  namedAsContext(path: string): string {
    return this.places.namedAsContext(path);
  }

  revealTarget(rawPath: string): string {
    return this.places.revealTarget(rawPath);
  }

  isOwnWrite(path: string, text: string): boolean {
    return this.writes.isOwnWrite(path, text);
  }

  static readonly OWN_BUNDLE_ECHO_MS = Writes.OWN_BUNDLE_ECHO_MS;

  /** Name the app's own folder (`appHome`): guarded as the sessions root is. */
  setAppHome(appHome: string | undefined): void {
    this.core.appHome = appHome === undefined ? undefined : resolve(appHome);
  }

  /**
   * An app verb's write of a file the context shows (an app's own edit of a
   * document, such as Scriptorium's frontmatter verbs): through the world's
   * writer, so never among the sessions or in the app home, whatever the sets
   * show. Not remembered as the session's own write: the watcher treats it as
   * any write to an opened original.
   */
  writeShown(rawPath: string, text: string): string {
    const { abs } = this.shownAt(rawPath);
    this.places.world.writeFile(abs, text);
    return abs;
  }

  /**
   * At restore, before any scan: drop each entry that lies among the app's
   * own places (a set's root, or a listed file, as written or as the disk
   * resolves it), and note each set that holds them in plain sight, which the
   * scan's guard narrows. Older manifests could hold either; `add` refuses
   * both now (`notASet`).
   */
  private settleOwnPlaceSets(report: RestoreReport): void {
    const own = this.places.ownPlaces;
    const out: NonNullable<RestoreReport["ownPlaceSets"]> = [];
    this.core.m.context = this.core.m.context.filter((e) => {
      const paths =
        e.membership === "mirrored"
          ? [e.root]
          : [e.root, ...e.nodes.map((n) => join(e.root, n.rel))];
      const inside = paths.map((p) => inOwnPlaces(p, own)).find((w) => w !== null);
      if (inside) {
        out.push({ label: e.label, root: e.root, outcome: "dropped", why: inside });
        return false;
      }
      if (e.membership === "mirrored" && holdsOwnPlaces(e.root, own) !== null) {
        // Said only when the scan would have shown them (`notASet`'s rule);
        // the line names what is left out, the outermost own folder it holds.
        if (notASet(e.root, own) !== null) {
          const holds = (r: string) => holdsOwnPlaces(e.root, { sessionsRoot: r }) !== null;
          const left =
            own.appHome !== undefined && holds(own.appHome) ? own.appHome : own.sessionsRoot;
          out.push({ label: e.label, root: e.root, outcome: "narrowed", why: left });
        }
      }
      return true;
    });
    if (out.length > 0) {
      report.ownPlaceSets = out;
      this.closeOrphanedOpenDoc();
    }
  }

  private adoptActive(d: Doc, text: string): void {
    const p = this.core.versionPath(d, d.active);
    this.writes.own(p, text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  private writeActive(d: Doc, text: string): void {
    this.writes.writeVersion(this.core.versionPath(d, d.active), text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  /** Keep an outside write to the active version as a new agent version. */
  private preserveOutside(d: Doc, text: string): Version & { path: string } {
    const n = this.takeVersion(d);
    const rec: Version = {
      n,
      by: "agent",
      fromVersion: d.active,
      createdAt: nowIso(),
      label: `outside write to v${d.active}`,
      // Kept from a write the agent did not make through the kit: not a
      // proposal the link check reads (`Version.outside`).
      outside: true,
    };
    d.versions.push(rec);
    this.writes.writeVersion(this.core.versionPath(d, n), text);
    this.persist();
    return { ...rec, path: this.core.versionPath(d, n) };
  }

  // ── context ────────────────────────────────────────────────────────────

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
    if (probe.membership === "mirrored" && this.hasHome && overlapOf(this.workspace, [probe]))
      throw new SessionError(
        `${probe.label} cannot be added as a set: its folder ${
          realOr(this.workspace) === realOr(probe.root) ? "is" : "holds"
        } the workspace folder (${tilde(this.workspace)}), so a file there would belong to both. Set the workspace to a folder outside it first, such as ${tilde(dirname(probe.root))} (the pencil in the sidebar, or \`workspace <dir>\`)`,
        409,
      );
    this.core.m.context.push(probe);
    // A loose image comes with its description, when one is beside it: listed
    // too, and folded into the image's row by the surface.
    const only = listedFile(probe);
    const sidecar = only?.kind === "image" ? this.sidecarFileOf(only.abs) : null;
    if (sidecar && !this.places.itemAt(sidecar))
      this.core.m.context.push(entryForPath(sidecar, `c-${randHex(3)}`));
    this.relink();
    this.persist();
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
    this.closeOrphanedOpenDoc();
    // An open image the context no longer shows is put away, as `closeImage` does.
    if (this.core.m.openImage && !this.imageNodeAt(this.core.m.openImage)) this.closeImage();
    this.persist();
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
    if (fresh.membership === "mirrored" && this.hasHome && overlapOf(this.workspace, [fresh]))
      throw new SessionError(
        `${fresh.label} cannot come back as a set: its folder holds the workspace folder (${tilde(this.workspace)})`,
        409,
      );
    const back: ContextEntry = {
      ...fresh,
      label: entry.label,
      ...(entry.realRoot ? { realRoot: entry.realRoot } : {}),
    };
    this.core.m.context.splice(Math.max(0, Math.min(index, this.core.m.context.length)), 0, back);
    this.relink();
    this.persist();
    return back;
  }

  /**
   * The open document left the context (its entry removed): close it in the
   * view. Its versions stay in the session, since nothing is deleted, and
   * bringing it back and opening it again finds them.
   */
  private closeOrphanedOpenDoc(): void {
    const open = this.core.m.openDoc
      ? this.core.m.docs.find((d) => d.slug === this.core.m.openDoc)
      : undefined;
    if (open && open.entryId === null) this.core.m.openDoc = null;
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
  private scanGuard(): ScanGuard {
    return ownPlaceGuard(this.places.ownPlaces);
  }

  /** The app's filter for a set's scan (`AppDeclaration.scan`), as the slot is now. */
  private scanSkip(entryId: string, root: string): ScanSkip | undefined {
    return this.app.scan?.({ entryId, root, slot: this.appSlot })?.skip;
  }

  /**
   * Whether the app's filter leaves `abs` out of a set whose folder holds it:
   * the path itself, or a folder above it, skipped (`ScanRule.skip`). A path no
   * set holds is not filtered.
   */
  private filteredOut(): (abs: string) => boolean {
    const rules: { root: string; skip: ScanSkip }[] = [];
    if (this.app.scan)
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
    this.closeOrphanedOpenDoc();
    if (this.core.m.openImage && !this.imageNodeAt(this.core.m.openImage)) this.closeImage();
    this.persist();
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

  private relink(): void {
    for (const d of this.core.m.docs) {
      const at = locate(this.core.m.context, d.original);
      d.entryId = at?.entryId ?? null;
      d.rel = at?.rel ?? null;
    }
  }

  // ── documents and versions ─────────────────────────────────────────────

  /**
   * `takesPath`: the verb asking takes the absolute path of any document in
   * the context, open or not (`version-new` and `show` open it; the link
   * questions read it), so such a path is a choice too.
   */
  private docOrDie(slug?: string, opts: { takesPath?: boolean } = {}): Doc {
    const want = slug ?? this.core.m.openDoc ?? undefined;
    // A document's alias names it too (`--doc touchstones`), so it is a choice.
    const opened = this.core.m.docs.flatMap((d) => {
      const alias = this.docAlias(d);
      return alias === undefined ? [d.slug] : [d.slug, alias];
    });
    // When nothing is open, the opened slugs are an empty list, and an empty
    // list is not an answer. So an unopened session offers the paths it could
    // open, and says how: a filename only resolves for a document that is
    // already open; a path always opens one.
    const choices =
      opened.length > 0 ? opened : this.core.m.context.flatMap((e) => docPaths(e)).slice(0, 20);
    const hint =
      opened.length > 0
        ? undefined
        : "nothing is open yet: pass a PATH from the context (a filename only resolves once a document is open)";
    if (want === undefined)
      throw new SessionError("no document is open: name one with --doc", 409, choices, hint);
    const d = this.findDoc(want);
    if (!d) {
      // A filename (or set-relative path) that names a document the context
      // shows but nothing has opened: the refusal names where it is, since a
      // filename only resolves once a document is open.
      const unopened = isAbsolute(want) ? [] : this.unopenedNamed(want);
      if (unopened.length > 0)
        throw new SessionError(
          `no document "${want}" in this session`,
          404,
          opts.takesPath ? [...unopened, ...choices.filter((c) => !unopened.includes(c))] : choices,
          `${want} is in the context but not open, at ${unopened.join(" or ")}: ${
            opts.takesPath
              ? "pass that absolute path to --doc"
              : "open it first (version-new --doc <that path> opens it), then name it here"
          }`,
        );
      throw new SessionError(`no document "${want}" in this session`, 404, choices, hint);
    }
    return d;
  }

  /**
   * The documents the context shows, not held by the session, that a name
   * given to `--doc` means: by filename, or by the path from its set's root.
   * At most 20, in context order.
   */
  private unopenedNamed(name: string): string[] {
    const held = new Set(this.core.m.docs.map((d) => d.original));
    const out: string[] = [];
    for (const e of this.core.m.context)
      for (const p of docPaths(e)) {
        if (held.has(p) || out.includes(p)) continue;
        if (basename(p) === name || toPosix(relative(e.root, p)) === name) out.push(p);
        if (out.length >= 20) return out;
      }
    return out;
  }

  /**
   * A doc by slug, by original path, or by a unique original basename. A
   * bundle's folder (with or without a trailing `/`) names its main file, and
   * a bundle's main file also answers to its alias (`docAlias`): the slug of
   * the name its bundle has now, when it was renamed since it was opened.
   */
  /**
   * The documents the session holds, by their original's path (as opened):
   * one pass, no file-system calls. For an app that asks of many paths
   * whether the session holds each, where `findDoc` on a miss would try every
   * way of naming a document for every one.
   */
  heldPaths(): Map<string, string> {
    return new Map(this.core.m.docs.map((d) => [d.original, d.slug]));
  }

  findDoc(key: string): Doc | undefined {
    const bySlug = this.core.m.docs.find((d) => d.slug === key);
    if (bySlug) return bySlug;
    // Only an absolute key is a path: resolving a relative one here would
    // resolve it against the daemon's cwd. The CLI resolves against its own cwd
    // and sends an absolute path.
    if (isAbsolute(key)) {
      const path = this.mainOf(key.length > 1 ? key.replace(/\/+$/, "") : key);
      const byPath = this.core.m.docs.find(
        (d) => d.original === path || realOr(d.original) === realOr(path),
      );
      if (byPath) return byPath;
    }
    const byAlias = this.core.m.docs.find((d) => this.docAlias(d) === key);
    if (byAlias) return byAlias;
    const byName = this.core.m.docs.filter((d) => basename(d.original) === key || d.rel === key);
    return byName.length === 1 ? byName[0] : undefined;
  }

  /**
   * The second slug a bundle's main file answers to: the slug its bundle's
   * name now makes (`touchstones`, for a canvas opened as `untitled` and
   * renamed "touchstones" since). Undefined for any other document, when the
   * two are the same, and when another document holds that slug or would
   * answer to it too: a slug names one document or none.
   */
  private docAlias(d: Doc): string | undefined {
    if (!isBundleMain(d.original)) return undefined;
    const b = bundleOf(d.original);
    if (!b) return undefined;
    const alias = slugBase(bundleNameAt(b.root));
    if (alias === d.slug || this.core.m.docs.some((x) => x.slug === alias)) return undefined;
    const others = this.core.m.docs.filter(
      (x) => x !== d && isBundleMain(x.original) && slugBase(this.docName(x)) === alias,
    );
    return others.length === 0 ? alias : undefined;
  }

  /** The next version number, consumed. Numbers are never reused. */
  private takeVersion(d: Doc): number {
    const n = d.nextVersion;
    d.nextVersion = n + 1;
    return n;
  }

  private versionOrDie(d: Doc, n: number): Version {
    const v = d.versions.find((x) => x.n === n);
    if (!v)
      throw new SessionError(
        `${d.slug} has no v${n}`,
        404,
        d.versions.map((x) => `v${x.n}`),
      );
    return v;
  }

  /**
   * A bundle's folder stands for its main file: `x.canvasbundle` opens
   * `x.canvasbundle/board.canvas`. Any other path is itself.
   */
  private mainOf(abs: string): string {
    const b = bundleOf(abs);
    return b && b.inner === "" ? join(abs, b.type.main) : abs;
  }

  /** A document's name as it is shown: a bundle's main file by its bundle's title. */
  private docName(d: Doc): string {
    const b = isBundleMain(d.original) ? bundleOf(d.original) : null;
    return b ? bundleNameAt(b.root) : d.name;
  }

  /**
   * An item's name as a person reads it: a bundle by its title (else its
   * folder's name without the extension), anything else by its file or folder
   * name. `title` stands in for the one on disk (what it was before an act).
   */
  itemName(abs: string, title?: string): string {
    const b = bundleOf(abs);
    if (b && b.inner === "")
      return title !== undefined ? bundleDisplayName(basename(abs), title) : bundleNameAt(abs);
    return basename(abs);
  }

  /** A bundle's title on disk, when its `info.json` has one. */
  bundleTitleAt(abs: string): string | undefined {
    const title = readBundleInfo(abs)?.title;
    return typeof title === "string" ? title : undefined;
  }

  /** A slug for a new document: its stem, made unique within the session. */
  private slugFor(original: string): string {
    // A bundle's main file is named for its bundle (`the-well`, not `board`):
    // every board's main file has the same name.
    const bundle = bundleOf(original);
    const named = bundle && bundle.inner === bundle.type.main ? bundleStem(bundle.root) : null;
    const stem = slugBase(named ?? basename(original, extname(original)));
    let slug = stem;
    for (let i = 2; this.core.m.docs.some((d) => d.slug === slug); i++) slug = `${stem}-${i}`;
    return slug;
  }

  /**
   * Open a document by its original's path: v1 is written from the original
   * the first time. `focus: false` (the agent's implicit open through
   * `version-new --doc <path>`) does not move the human's open document.
   *
   * Admission: only a document-type file inside a context entry is opened;
   * `context.add` stays the one way in. Without it any path of any type could
   * be opened, and Save would then write it: a foreign web page could write
   * into a file outside the context.
   */
  openPath(rawPath: string, opts: { focus?: boolean } = {}): { slug: string; created: boolean } {
    const focus = opts.focus ?? true;
    // The context's own form of the path: a caller whose cwd is a realpath
    // (/private/var/... for /var/...) names the same file differently, and it
    // must land on the same doc. A bundle opens as its main file.
    const abs = this.places.canonical(this.mainOf(resolve(rawPath)));
    const existing = this.core.m.docs.find((d) => d.original === abs);
    if (existing) {
      if (focus) this.focusDoc(existing.slug);
      this.persist();
      return { slug: existing.slug, created: false };
    }
    if (!isDocName(abs) && !isBundleMain(abs))
      throw new SessionError(`not a document the workspace opens: ${abs}`, 400, docExtensions());
    const at = locate(this.core.m.context, abs);
    if (!at)
      throw new SessionError(
        `${abs} is not in this session's context: add it (or its folder) first`,
        400,
      );
    let text: string;
    try {
      if (!statSync(abs).isFile()) throw new Error("not a file");
      text = readFileSync(abs, "utf8");
    } catch {
      throw new SessionError(`cannot open ${abs}: no such file`, 404);
    }
    const lower = extname(abs).toLowerCase();
    // A bundle's main file keeps its own extension in its versions (`v1.canvas`).
    const ext =
      docExtensions().includes(lower) || (isBundleMain(abs) && /^\.[a-z0-9]+$/.test(lower))
        ? lower
        : ".md";
    const d: Doc = {
      slug: this.slugFor(abs),
      name: basename(abs),
      original: abs,
      entryId: at.entryId,
      rel: at.rel,
      ext,
      versions: [{ n: 1, by: "human", createdAt: nowIso() }],
      active: 1,
      nextVersion: 2,
      notes: [],
      originalHash: contentHash(text),
      admitted: true,
      outsideChanged: false,
    };
    this.core.m.docs.push(d);
    this.writeActive(d, text);
    if (focus) this.focusDoc(d.slug);
    this.persist();
    return { slug: d.slug, created: true };
  }

  /** The centre shows one thing: a document coming on screen puts the open image away. */
  private focusDoc(slug: string): void {
    this.core.m.openDoc = slug;
    this.core.m.openImage = null;
    this.core.m.docAside = null;
  }

  openSlug(slug: string): void {
    this.focusDoc(this.docOrDie(slug).slug);
    this.persist();
  }

  readVersion(slug: string, n: number): { text: string; path: string } {
    const d = this.docOrDie(slug);
    this.versionOrDie(d, n);
    const path = this.core.versionPath(d, n);
    return { text: readFileSync(path, "utf8"), path };
  }

  activePath(slug?: string): string | null {
    const d = slug
      ? this.findDoc(slug)
      : this.core.m.openDoc
        ? this.findDoc(this.core.m.openDoc)
        : undefined;
    return d ? this.core.versionPath(d, d.active) : null;
  }

  /**
   * The human's buffer reaches the active version's file (debounced by the
   * surface).
   *
   * Check before write. Before the human's edit is written, the file on disk is
   * hashed: if it is not the daemon's own last write, someone else wrote the
   * active version. That text is kept as a new agent version, and only then is
   * the edit written. Detection used to depend on the watcher's settle timer
   * firing before the next keystroke; a burst of edits clobbered an outside
   * write unannounced. Now nothing is lost whatever the timing: the one window
   * left is the microseconds between this read and this write.
   */
  edit(
    slug: string,
    n: number,
    text: string,
  ): { dirtyChanged: boolean; preserved: (Version & { path: string }) | null } {
    const d = this.docOrDie(slug);
    if (n !== d.active)
      throw new SessionError(
        `v${n} is not the active version of ${d.slug} (v${d.active} is): only the active version is editable`,
        409,
      );
    const before = this.isDirty(d);
    const path = this.core.versionPath(d, n);
    // The edit is staged in a sibling file first, so the check below and the
    // rename that lands the edit are adjacent syscalls: the window in which an
    // outside write could slip between them is microseconds, not the length of
    // a multi-megabyte write, and a write landing after the rename goes to the
    // new file, where the watcher finds it and preserves it too.
    // A fresh file under a random name (`stage`): never through a link
    // planted at a name it could guess.
    this.places.ownFileOrDie(path);
    const staged = this.own.stage(path, text, "edit");
    let preserved: (Version & { path: string }) | null = null;
    let landed = false;
    try {
      let onDisk: string | null = null;
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {
        onDisk = null;
      }
      if (onDisk !== null && !this.isOwnWrite(path, onDisk))
        preserved = this.preserveOutside(d, onDisk);
      this.writes.own(path, text);
      this.own.rename(staged, path);
      landed = true;
    } finally {
      // A failed edit leaves nothing behind: the staged file goes with it.
      if (!landed)
        try {
          this.own.unlink(staged);
        } catch {
          /* already gone */
        }
    }
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
    return { dirtyChanged: before !== this.isDirty(d), preserved };
  }

  /**
   * The human's edit to a version that stopped being active while the edit
   * waited out its pause: the agent (or another viewer) activated another
   * version, and the human's client could not send the edit first as it does
   * before its own switch (`kit-agent-activate-pending-edit`).
   *
   * The text was typed in version `n`, so it is written there when that file is
   * still what the daemon last wrote to it. When it is not (the agent rewrote
   * `n` with its own tools once it was no longer active) or `n` is gone, the
   * text is kept as a new version by the human instead, made from `n` (or from
   * the active version when `n` is gone) and not activated. Never refused: it
   * is the last of what the human typed in that version.
   */
  editLeft(
    slug: string,
    n: number,
    text: string,
  ): { saved: number; kept: null | "changed" | "deleted"; path: string } {
    const d = this.docOrDie(slug);
    const was = d.versions.find((v) => v.n === n);
    if (was) {
      const path = this.core.versionPath(d, n);
      let onDisk: string | null = null;
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {
        onDisk = null;
      }
      if (onDisk !== null && (onDisk === text || this.isOwnWrite(path, onDisk))) {
        this.writes.writeVersion(path, text);
        return { saved: n, kept: null, path };
      }
    }
    const v = this.takeVersion(d);
    const rec: Version = {
      n: v,
      by: "human",
      fromVersion: was ? n : d.active,
      createdAt: nowIso(),
      label: `edit to v${n} after a switch`,
    };
    d.versions.push(rec);
    const path = this.core.versionPath(d, v);
    this.writes.writeVersion(path, text);
    this.persist();
    return { saved: v, kept: was ? "changed" : "deleted", path };
  }

  /**
   * Copy a version to a new file; the agent then edits that file with its own
   * tools. With `body`, the new file holds that text instead of the copy, in the
   * same act; `fromVersion` still names the version it was made from.
   */
  newVersion(opts: { doc?: string; from?: number; label?: string; body?: string; by: Author }): {
    slug: string;
    version: Version & { path: string };
  } {
    const d = this.docOrDie(opts.doc, { takesPath: true });
    const from = opts.from ?? d.active;
    this.versionOrDie(d, from);
    const text = opts.body ?? readFileSync(this.core.versionPath(d, from), "utf8");
    const n = this.takeVersion(d);
    const rec: Version = {
      n,
      by: opts.by,
      fromVersion: from,
      createdAt: nowIso(),
      ...(opts.label ? { label: opts.label } : {}),
    };
    d.versions.push(rec);
    this.writes.writeVersion(this.core.versionPath(d, n), text);
    this.persist();
    return { slug: d.slug, version: { ...rec, path: this.core.versionPath(d, n) } };
  }

  /**
   * Remove a version and its file.
   *
   * The active version cannot be deleted, and refusing is better than picking a
   * replacement: choosing one for the human would silently move where their
   * edits and Save are pointed, which is the one thing the write rules exist to
   * keep explicit. Because exactly one version is always active, this also means
   * the last version can never be deleted.
   *
   * `fromVersion` pointers on other versions are left as they are: "made from
   * v2" stays true after v2 is gone.
   */
  /** The refusals a version delete would meet, without deleting: returns the slug. */
  checkDeletable(opts: { doc?: string; version: number }): string {
    const d = this.docOrDie(opts.doc);
    this.versionOrDie(d, opts.version);
    if (opts.version === d.active)
      throw new SessionError(
        `v${opts.version} is the active version of ${d.slug}: activate another one first, then delete this`,
        409,
      );
    return d.slug;
  }

  deleteVersion(opts: { doc?: string; version: number }): {
    slug: string;
    version: number;
    label?: string;
    remaining: number;
  } {
    this.checkDeletable(opts);
    const d = this.docOrDie(opts.doc);
    const v = this.versionOrDie(d, opts.version);
    // ⛔ Only a file inside the session's own docs/, as the disk resolves it:
    // a version folder swapped for a link deletes nothing outside. Refused
    // before the record changes.
    const path = this.places.ownFileOrDie(this.core.versionPath(d, opts.version));
    d.versions = d.versions.filter((x) => x.n !== opts.version);
    try {
      this.own.rm(path);
    } catch (e) {
      if (e instanceof SessionError) throw e;
      // The record is what the session believes; a file already gone (a hand
      // tidy, a crash between write and record) must not block removing it.
    }
    this.writes.disown(path);
    this.persist();
    return {
      slug: d.slug,
      version: opts.version,
      ...(v.label ? { label: v.label } : {}),
      remaining: d.versions.length,
    };
  }

  activate(opts: { doc?: string; version: number; json?: "refuse" }): {
    slug: string;
    previous: number;
  } {
    const d = this.docOrDie(opts.doc);
    this.versionOrDie(d, opts.version);
    // The agent may not put a JSON text that does not parse in front of the
    // human; the human may activate anything, and fix it there.
    if (opts.json === "refuse")
      this.refuseInvalidJson(
        d,
        opts.version,
        readFileSync(this.core.versionPath(d, opts.version), "utf8"),
        "activated",
      );
    const previous = d.active;
    // Both have now been active (`Version.activated`): neither is a proposal
    // the link check reads, whoever wrote it.
    for (const v of d.versions) if (v.n === previous || v.n === opts.version) v.activated = true;
    d.active = opts.version;
    // The new active version's text as it is now is the baseline the next
    // check-before-write compares against.
    this.adoptActive(d, readFileSync(this.core.versionPath(d, d.active), "utf8"));
    this.persist();
    return { slug: d.slug, previous };
  }

  // ── comparing and merging ──────────────────────────────────────────────

  /**
   * The text of one side of a comparison. `"original"` is read from disk, not
   * from a cache: the point of comparing against it is to see what the file of
   * record says right now, including a change someone else made while this
   * session was open.
   */
  private sideText(d: Doc, side: DiffSide): string {
    if (side === "original") return readFileSync(d.original, "utf8");
    this.versionOrDie(d, side);
    return readFileSync(this.core.versionPath(d, side), "utf8");
  }

  /**
   * Compare the active version (left) against another side (right).
   *
   * With `pick`, the side is the first whose text differs from the active
   * version's: the file on disk, then the other versions, newest first. A
   * comparison opened on a side that matches could only say "identical" (the
   * agent's `version-new` without a body is an untouched copy). When none
   * differs it is `against`, and the payload says `everyMatches`.
   */
  compare(opts: { doc?: string; against: DiffSide; pick?: boolean }): DiffPayload {
    const d = this.docOrDie(opts.doc);
    const left = readFileSync(this.core.versionPath(d, d.active), "utf8");
    if (opts.pick) {
      const sides: DiffSide[] = [
        "original",
        ...d.versions
          .map((v) => v.n)
          .filter((n) => n !== d.active)
          .sort((a, b) => b - a),
      ];
      for (const side of sides) {
        let right: string;
        try {
          right = this.sideText(d, side);
        } catch {
          continue; // a file gone from disk is no side to open on
        }
        if (right !== left)
          return {
            doc: d.slug,
            active: d.active,
            against: side,
            diff: diffText(left, right),
            picked: true,
          };
      }
    }
    if (opts.against === d.active)
      throw new SessionError(
        `v${d.active} is the active version of ${d.slug}: comparing it with itself says nothing`,
        400,
      );
    return {
      doc: d.slug,
      active: d.active,
      against: opts.against,
      diff: diffText(left, this.sideText(d, opts.against)),
      ...(opts.pick ? { picked: true as const, everyMatches: true as const } : {}),
    };
  }

  /**
   * Take named hunks from `against` into the active version.
   *
   * The write goes through `edit`, which is what makes a merge obey every rule
   * an ordinary keystroke obeys: it lands on the active version and never the
   * original, and check-before-write preserves an outside write as a new
   * version first. A merge writing the file directly would be the one path into
   * the document that could silently clobber the agent.
   */
  merge(opts: { doc?: string; against: DiffSide; hunks: number[]; json?: "refuse" }): {
    slug: string;
    version: number;
    text: string;
    applied: number;
    preserved: (Version & { path: string }) | null;
  } {
    const d = this.docOrDie(opts.doc);
    const payload = this.compare({ doc: d.slug, against: opts.against });
    const known = new Set(payload.diff.hunks.map((h) => h.id));
    const missing = opts.hunks.filter((id) => !known.has(id));
    if (missing.length)
      throw new SessionError(
        `${d.slug} has no hunk ${missing.join(", ")} against ${sideName(opts.against, d.name)}: ` +
          `it has ${known.size === 0 ? "none" : `1..${Math.max(...known)}`}. Run diff again: ` +
          `the text changed under the numbers.`,
        409,
      );
    const before = readFileSync(this.core.versionPath(d, d.active), "utf8");
    const text = applyHunks(before, payload.diff.hunks, opts.hunks);
    // The agent's merge must leave a JSON document parsing; the human's may not,
    // since they can see the text and fix it.
    if (opts.json === "refuse" && docFormat(d.original) === "json") {
      const p = jsonProblem(text);
      if (p) {
        const from = sideName(opts.against, d.name);
        throw new SessionError(
          `taking change${opts.hunks.length === 1 ? "" : "s"} ${opts.hunks.join(", ")} from ${from} into v${d.active} of ${d.name} would leave invalid JSON (${describeJsonProblem(p)}, in the merged text): fix ${from}, or take fewer changes. Nothing was merged.`,
          409,
        );
      }
    }
    const { preserved } = this.edit(d.slug, d.active, text);
    return {
      slug: d.slug,
      version: d.active,
      text,
      applied: opts.hunks.filter((id) => known.has(id)).length,
      preserved,
    };
  }

  // ── notes ──────────────────────────────────────────────────────────────

  /** The active version's text: what every note is anchored against. */
  private activeText(d: Doc): string {
    return readFileSync(this.core.versionPath(d, d.active), "utf8");
  }

  /** Place every note in the active text as it stands now (re-anchoring after edits). */
  private placedNotes(d: Doc): PlacedNote[] {
    if (d.notes.length === 0) return [];
    const text = this.activeText(d);
    return d.notes.map((n) => placeNote(text, n));
  }

  /**
   * Note a range of the active version's text (the human selects) or a quote
   * found in it (the agent quotes: it has no offsets).
   */
  addNote(opts: {
    doc?: string;
    body: string;
    by: Author;
    range?: { from: number; to: number };
    /**
     * With `range`: the text the human selected, as their view showed it. When
     * given, a range that does not hold it is refused (`showsSelection`).
     */
    seen?: string;
    quote?: string;
  }): { slug: string; note: Note; how: "selection" | "quote" } {
    const d = this.docOrDie(opts.doc);
    const body = opts.body.trim();
    if (!body) throw new SessionError("a note needs something written in it", 400);
    const text = this.activeText(d);

    let anchor: Anchor;
    if (opts.range) {
      const { from, to } = opts.range;
      if (from < 0 || to > text.length || from >= to)
        throw new SessionError(
          `${from}..${to} is not a range in v${d.active} of ${d.slug} (${text.length} characters)`,
          400,
        );
      // ⛔ NEVER A NOTE OVER TEXT THE HUMAN DID NOT SELECT. The page turns a
      // selection into offsets; when that goes wrong (a file whose line endings
      // the rendered view could not place), the range can cover far more than
      // was chosen, and a note stored there is wrong without anyone seeing it.
      // Refused, with the act that answers it.
      if (opts.seen !== undefined && !guardLoaded()(text, from, to, opts.seen))
        throw new SessionError(
          `The note on ${JSON.stringify(quoteLabel(opts.seen, 40))} was not added. ${NOT_PLACED}`,
          409,
        );
      anchor = anchorOf(text, from, to);
    } else {
      const quote = opts.quote ?? "";
      if (!quote) throw new SessionError("a note needs a selection or a quote", 400);
      const at = text.indexOf(quote);
      // Refused, not anchored hopefully. A quote the active version does not
      // contain would become an orphan the moment it was made, which reads as
      // "the text changed" when the truth is "you quoted something else".
      if (at === -1)
        throw new SessionError(
          `v${d.active} of ${d.slug} does not contain that text: quote it exactly as it appears`,
          404,
        );
      anchor = anchorOf(text, at, at + quote.length);
    }

    const note: Note = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      version: d.active,
      ...anchor,
      body,
      by: opts.by,
      createdAt: nowIso(),
      resolved: false,
    };
    d.notes = [...d.notes, note];
    this.persist();
    return { slug: d.slug, note, how: opts.range ? "selection" : "quote" };
  }

  /**
   * The lines a note covers in the active version now, or null when its text is
   * gone. Placed, not remembered, for the reason notes are.
   */
  noteLines(doc: string, note: Note): { from: number; to: number } | null {
    const d = this.docOrDie(doc);
    const text = this.activeText(d);
    const at = findAnchor(text, note);
    return at.from === null ? null : linesOf(text, at.from, at.to);
  }

  /** The slug of the document that holds note `id`, or undefined when no document does. */
  noteDoc(id: string): string | undefined {
    return this.core.m.docs.find((d) => d.notes.some((n) => n.id === id))?.slug;
  }

  /** Notes on a document, placed; `all` includes the resolved ones. */
  notesOf(opts: { doc?: string; all?: boolean }): { slug: string; notes: PlacedNote[] } {
    const d = this.docOrDie(opts.doc);
    const placed = this.placedNotes(d);
    return { slug: d.slug, notes: opts.all ? placed : placed.filter((n) => !n.resolved) };
  }

  private noteOrDie(d: Doc, id: string): Note {
    const note = d.notes.find((n) => n.id === id);
    if (!note)
      throw new SessionError(
        `${d.slug} has no note ${id}`,
        404,
        d.notes.map((n) => n.id),
      );
    return note;
  }

  /**
   * Every document's notes as stored: no placement, so no file reads. The
   * attention tick asks this every second, and `view()` would place every note.
   */
  noteFacts(): { slug: string; notes: readonly Note[] }[] {
    return this.core.m.docs.map((d) => ({ slug: d.slug, notes: d.notes }));
  }

  /**
   * Change what a note says. Its anchor is untouched: it is still about the same
   * passage. Who rewrote it is stored, because it decides whether the note is
   * owed an answer (`notesWaiting`). The agent's rewrite keeps the words it
   * replaced (the first it replaced, while it goes on rewriting), so the human
   * can see them and put them back; the human's own rewrite lets them go.
   *
   * A body that is the same is not a rewrite (`changed: false`): nothing is
   * stamped or stored, so a Save with nothing changed does not put the note in
   * front of the agent again.
   *
   * THE AGENT NEVER REWRITES THE HUMAN'S WORDS. A note the human wrote, or
   * rewrote last, is refused to the agent, which answers it with a reply
   * instead (`replyToNote`): the reply sits beside the note, its words untouched.
   */
  editNote(opts: { doc?: string; id: string; body: string; by: Author }): {
    slug: string;
    note: Note;
    changed: boolean;
  } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    if (opts.by === "agent" && (note.by === "human" || note.editedBy === "human"))
      throw new SessionError(
        `note ${note.id} on ${d.slug} holds the human's words, and the agent does not rewrite them: reply to it instead`,
        409,
        ["note-reply", "note-resolve"],
        `run: note-reply ${note.id} --doc ${d.slug} <your answer> (the note keeps its words), or note-resolve ${note.id} --doc ${d.slug} when it is dealt with`,
      );
    const body = opts.body.trim();
    if (!body) throw new SessionError("a note needs something written in it", 400);
    if (body === note.body) return { slug: d.slug, note, changed: false };
    // An agent rewrite back to the words it replaced leaves nothing to put back.
    if (opts.by === "agent" && body !== (note.replacedBody ?? note.body))
      note.replacedBody ??= note.body;
    else delete note.replacedBody;
    note.body = body;
    note.editedAt = nowIso();
    note.editedBy = opts.by;
    this.persist();
    return { slug: d.slug, note, changed: true };
  }

  /**
   * The agent's answer to a note: a message in the conversation about it
   * (`about.noteId`), the shape the agent's `say` already stores when it names
   * a note. The note is untouched; the surface shows the answer with it. A
   * note that does not exist is refused, so an answer never points at nothing.
   */
  replyToNote(opts: { doc?: string; id: string; text: string }): {
    slug: string;
    note: Note;
    message: Message;
  } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    const text = opts.text.trim();
    if (!text) throw new SessionError("a reply needs something written in it", 400);
    const message = this.addMessage({ from: "agent", text, about: { noteId: note.id } });
    return { slug: d.slug, note, message };
  }

  resolveNote(opts: { doc?: string; id: string; resolved: boolean; by: Author }): {
    slug: string;
    note: Note;
  } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    // A reopen is a write: the human reopening asks again, timed from here; the
    // agent reopening is an act on the note.
    if (note.resolved && !opts.resolved) {
      note.reopenedAt = nowIso();
      note.reopenedBy = opts.by;
    }
    note.resolved = opts.resolved;
    if (opts.resolved) note.resolvedAt = nowIso();
    else delete note.resolvedAt;
    this.persist();
    return { slug: d.slug, note };
  }

  removeNote(opts: { doc?: string; id: string }): { slug: string; note: Note } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    d.notes = d.notes.filter((n) => n.id !== opts.id);
    this.persist();
    return { slug: d.slug, note };
  }

  // ── save and revert ────────────────────────────────────────────────────

  /**
   * Where a version of a JSON document stops parsing, or null: when it parses,
   * or the document is not JSON (markdown is never checked).
   */
  jsonProblemOf(slug: string, version: number): JsonProblem | null {
    const d = this.docOrDie(slug);
    if (docFormat(d.original) !== "json") return null;
    this.versionOrDie(d, version);
    return jsonProblem(readFileSync(this.core.versionPath(d, version), "utf8"));
  }

  /** Refuse, saying where and why, when `text` (a JSON document's) does not parse. */
  private refuseInvalidJson(d: Doc, version: number, text: string, what: string): void {
    if (docFormat(d.original) !== "json") return;
    const p = jsonProblem(text);
    if (!p) return;
    throw new SessionError(
      `v${version} of ${d.name} is not valid JSON, so it was not ${what}: ${describeJsonProblem(p)}`,
      409,
      undefined,
      `fix the JSON in v${version} first; nothing was written`,
    );
  }

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
    const d = this.docOrDie(slug);
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
        this.persist();
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
    this.refuseInvalidJson(d, d.active, text, "saved");
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
        this.persist();
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
        const event = this.onFileEvent(d.original);
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
      this.rescanAround(d.original);
      this.relink();
    }
    this.persist();
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
    const d = this.docOrDie(slug);
    if (this.core.m.openDoc === d.slug) this.core.m.openDoc = null;
    this.persist();
    return { slug: d.slug };
  }

  /**
   * Forget a document whose file is gone: its record goes, with the way to
   * its versions, so the session stops offering it back and its slug is free.
   * Refused (409) while the file is on disk: forgetting a live document's
   * record would throw away its history while the document sits there. The
   * version files are left where they are: nothing reads them once the record
   * is gone, and removing them would be a second deletion nobody asked for.
   */
  forgetDoc(ref?: string): { slug: string; name: string; original: string; versions: number } {
    const d = this.docOrDie(ref);
    if (existsSync(d.original))
      throw new SessionError(
        `${this.display(d.original)} is still on disk: forget is for a document whose file is gone`,
        409,
      );
    const forgotten = {
      slug: d.slug,
      name: this.docName(d),
      original: d.original,
      versions: d.versions.length,
    };
    this.core.m.docs = this.core.m.docs.filter((x) => x.slug !== d.slug);
    if (this.core.m.openDoc === d.slug) this.core.m.openDoc = this.core.m.docs[0]?.slug ?? null;
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return forgotten;
  }

  // ── images: shown in the tree, opened in the viewer, served, brought in ─
  //
  // An image is a node of its own kind (`image`), shown inside a mirrored set
  // or as a listed entry of its own (a loose image: dropped on the context list,
  // or added by path). It is never a `Doc`: no versions, no text, no Compare.
  // Opening one sets `openImage` and puts the open document aside; its bytes
  // leave the daemon only through the file route, after `imageFile` has passed
  // them.

  /**
   * The image node at `abs` (in its context form), or null: one inside a
   * mirrored set, or the one file of a listed entry. A listed entry's root is
   * the image's folder, but nothing else in that folder is ever its node, so a
   * sibling beside a loose image is no image this session shows.
   */
  private imageNodeAt(abs: string): { entry: ContextEntry; rel: string } | null {
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

  /**
   * Open an image in the centre's viewer for the human. Only an image the tree
   * shows; the open document is put aside (its record and versions stay, and
   * clicking it brings it back).
   */
  openImage(rawPath: string): { path: string } {
    if (!isAbsolute(rawPath))
      throw new SessionError(`"${rawPath}" is not a full path: start it with /`, 400);
    const abs = this.places.contextForm(resolve(rawPath));
    const at = isImageName(abs) ? this.imageNodeAt(abs) : null;
    if (!at)
      throw new SessionError(
        `${abs} is not an image shown in this session: add its folder to the context first`,
        400,
      );
    this.places.realInsideOrDie(abs, at.entry, "not opened");
    // The document on screen is put aside, not forgotten: closing the image
    // brings it back. A second image opened over the first keeps the same one.
    if (this.core.m.openDoc) this.core.m.docAside = this.core.m.openDoc;
    this.core.m.openImage = abs;
    this.core.m.openDoc = null;
    this.persist();
    return { path: abs };
  }

  /**
   * Put the open image away, and bring back the document it was opened over,
   * when that document is still held (closed or gone, nothing comes back).
   */
  closeImage(): void {
    const back = this.core.m.docAside;
    this.core.m.openImage = null;
    this.core.m.docAside = null;
    if (back && this.core.m.docs.some((d) => d.slug === back)) this.core.m.openDoc = back;
    this.persist();
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

  /** The open image's path, or null. */
  get openImagePath(): string | null {
    return this.core.m.openImage ?? null;
  }

  /**
   * The open image as the snapshot carries it, or null when none is open or it
   * has left the tree. Reads its size and first bytes, never more.
   */
  imageView(): ImageView | null {
    const abs = this.core.m.openImage;
    if (!abs) return null;
    const at = this.imageNodeAt(abs);
    if (!at) return null;
    // Nothing is read through a link that leads out of the set, not even its size.
    let real: string;
    try {
      real = this.places.realInsideOrDie(abs, at.entry, "not shown");
    } catch {
      return null;
    }
    const fd = openNoFollow(real);
    if (fd === null) return null;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      return {
        path: abs,
        name: basename(abs),
        entryId: at.entry.id,
        rel: at.rel,
        size: st.size,
        type: sniffImage(readHeadFd(fd)),
        stamp: stampOf(st),
        ...this.withDescription(abs),
      };
    } finally {
      closeSync(fd);
    }
  }

  // ── an image's description: its sidecar ─────────────────────────────────
  //
  // `fox.png.md` beside `fox.png`, an ordinary document of `type: image`
  // (`lib/sidecar.ts`). Search, links, versions and profiles meet it as the
  // document it is; what follows is only how it is tied to its image.

  /**
   * The sidecar of the image at `abs`, when the session shows it as a document
   * (in a set, listed beside a loose image, or held): its path, else null. A
   * file nobody added is never read for the viewer.
   */
  sidecarDocOf(abs: string, index: ContextIndex = this.places.contextIndex()): string | null {
    const p = sidecarOf(abs);
    return index.sidecars.has(p) ? p : null;
  }

  /**
   * The image a document describes, when the document is a sidecar and the
   * session shows that image: its path, else null.
   */
  imageOfDoc(path: string, index: ContextIndex = this.places.contextIndex()): string | null {
    const image = imageOfSidecar(path);
    return image !== null && index.sidecars.has(path) && index.images.has(image) ? image : null;
  }

  /** A sidecar's text as the session holds it: its active version, else the file. */
  private sidecarText(path: string): string | null {
    const d = this.core.m.docs.find((x) => x.original === path);
    try {
      return d ? this.activeText(d) : readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  /** What the viewer shows of an image's sidecar, or undefined when it has none the session shows. */
  imageDescription(abs: string, index?: ContextIndex): ImageDescription | undefined {
    const path = this.sidecarDocOf(abs, index);
    if (!path) return undefined;
    const text = this.sidecarText(path);
    if (text === null) return undefined;
    const facts = docFacts(text);
    return describeSidecar(path, facts.fields, splitFrontmatter(text).body, facts.unparsed);
  }

  private withDescription(abs: string): { description?: ImageDescription } {
    const description = this.imageDescription(abs);
    return description ? { description } : {};
  }

  /**
   * An image's sidecar on disk beside it, when it is a plain file: what a
   * rename, move or Trash of the image carries with it. A link or a folder of
   * that name is not carried.
   */
  sidecarFileOf(imageAbs: string): string | null {
    return sidecarFile(imageAbs);
  }

  /**
   * Refuse to rename or move an image's description on its own: it would stop
   * describing its image, which would keep its old name. The image is what to
   * rename or move, and its description goes with it.
   */
  private refuseLoneSidecar(abs: string, act: "rename" | "move"): void {
    const image = imageOfSidecar(abs);
    if (image === null || sidecarFile(image) !== abs) return;
    throw new SessionError(
      `${this.display(abs)} is ${basename(image)}'s description: ${act} the image instead, and its description goes with it`,
      409,
    );
  }

  /**
   * Undo of `describe-image`: the description goes to the Trash only while its
   * file is still the skeleton that was written (by hash). One that has been
   * written into is refused, so undo never takes a description away.
   */
  unchangedOrDie(path: string, hash: string): void {
    // A bundle (a folder the act made whole, `bundle.create` or `duplicate`) is
    // judged by everything in it.
    let dir = false;
    try {
      dir = lstatSync(path).isDirectory();
    } catch {
      /* gone: said below */
    }
    let now: string | null = null;
    try {
      if (dir) now = treeHash(path);
      else if (lstatSync(path).isFile()) now = contentHash(readFileSync(path, "utf8"));
    } catch {
      now = null;
    }
    if (now === null)
      throw new SessionError(
        `${this.display(path)} is not where it was: what this would undo has moved or gone`,
        409,
      );
    if (now !== hash)
      throw new SessionError(
        `${this.display(path)} has been written into since it was ${dir ? "made" : "started"}, so undo leaves it: delete it from the sidebar if it should go`,
        409,
      );
    const held = this.core.m.docs.find(
      (d) => (d.original === path || d.original.startsWith(path + sep)) && !d.missing,
    );
    if (held && this.isDirty(held))
      throw new SessionError(
        `${this.display(path)} has unsaved edits, so undo leaves it: delete it from the sidebar if it should go`,
        409,
      );
  }

  /**
   * Move an image's sidecar after the image has moved from `from` to `to`. If
   * the sidecar cannot move, the image goes back where it was, so the two are
   * never parted by a half-done move.
   */
  private carrySidecar(from: string, to: string, sidecar: string, sidecarTo: string): void {
    try {
      this.places.world.rename(sidecar, sidecarTo);
    } catch (e) {
      try {
        this.places.world.rename(to, from);
      } catch {
        /* the refusal below still says what failed */
      }
      throw new SessionError(
        `cannot move ${this.display(sidecar)}, the description of ${basename(from)}, with it: ${(e as NodeJS.ErrnoException).code ?? String(e)}. Nothing was moved.`,
        409,
      );
    }
  }

  /**
   * Start a description for the image at `rawImage`: write its sidecar beside
   * it with the frontmatter an origin records (`type: image`, `source` and that
   * origin's fields, a web licence `unknown`), and show it. Refused when the
   * image is not shown, or when a sidecar is already there (it is edited as a
   * version, like any document).
   */
  describeImage(
    rawImage: string,
    source: ImageSource = "user",
  ): { path: string; image: string; hash: string } {
    if (!isAbsolute(rawImage))
      throw new SessionError(`"${rawImage}" is not a full path: start it with /`, 400);
    const abs = this.places.contextForm(resolve(rawImage));
    if (!isImageName(abs) || !this.imageNodeAt(abs))
      throw new SessionError(
        `${abs} is not an image shown in this session: add it, or its folder, first`,
        400,
      );
    const path = sidecarOf(abs);
    let taken = false;
    try {
      lstatSync(path);
      taken = true;
    } catch {
      /* free */
    }
    if (taken)
      throw new SessionError(
        `${this.display(abs)} already has a description, ${basename(path)}: change it with version-new --doc ${path}`,
        409,
      );
    let added = new Date();
    try {
      added = statSync(abs).mtime;
    } catch {
      /* today, then */
    }
    // A converted image's description records the name it came in with.
    const cameAs = this.core.m.importedAs?.[abs];
    const text = sidecarSkeleton(cameAs ?? basename(abs), source, added);
    this.places.world.writeFile(path, text, { flag: "wx" });
    if (cameAs !== undefined && this.core.m.importedAs) {
      delete this.core.m.importedAs[abs];
      if (Object.keys(this.core.m.importedAs).length === 0) delete this.core.m.importedAs;
    }
    if (!this.places.itemAt(path)) this.adoptNew(path);
    this.persist();
    return { path, image: abs, hash: contentHash(text) };
  }

  /**
   * The name a dropped image is written under, or a refusal saying why it is
   * not brought in. SVG is refused (it can carry script); a HEIC photo becomes a
   * `.jpg` (the daemon converts it); anything else that is not a shown image
   * type is refused with the types that are.
   */
  imageNameIn(name: string): { name: string; heic: boolean; given: string } {
    const n = this.places.nameOrDie(name);
    if (isSvgName(n)) throw new SessionError(SVG_REFUSED, 400);
    if (isHeicName(n))
      return { name: n.replace(/\.(?:heic|heif)$/i, ".jpg"), heic: true, given: n };
    if (!isImageName(n))
      throw new SessionError(
        `${n} is not an image the workspace shows (${IMAGE_EXTENSIONS.join(" ")})`,
        400,
        [...IMAGE_EXTENSIONS],
      );
    return { name: n, heic: false, given: n };
  }

  /**
   * Remember the name an image brought in at `abs` came in with, when it was
   * written under another (converted to WebP, or from HEIC), so the
   * description `describeImage` starts records it as `original-name`; or
   * forget any name remembered for `abs` when it came in under its own. Kept
   * in the manifest, follows a rename or a move, and is let go once a
   * description has recorded it.
   */
  rememberImportName(abs: string, given: string): void {
    const at = this.places.contextForm(resolve(abs));
    const names = { ...(this.core.m.importedAs ?? {}) };
    delete names[at];
    if (given !== basename(at)) names[at] = given;
    const keys = Object.keys(names);
    // Bounded: a name nobody describes is dropped, oldest first.
    for (const k of keys.slice(0, Math.max(0, keys.length - IMPORT_NAMES_MAX))) delete names[k];
    if (Object.keys(names).length > 0) this.core.m.importedAs = names;
    else delete this.core.m.importedAs;
    this.persist();
  }

  /**
   * Where a dropped image lands: the set or folder it was dropped on, or, with
   * none (a drop on the context list), the workspace folder. In a set it shows
   * in the set's tree; in a workspace folder no set covers it becomes a listed
   * entry of its own, as a dropped document does. `destinationOrDie` admits
   * only a set, a folder in one, or the workspace, so nothing else is reached.
   */
  private imageDestinationOrDie(rawDir?: string): string {
    const dir = rawDir ? this.places.destinationOrDie(rawDir) : this.places.workspaceOrDie();
    const set = this.places.coveringEntry(dir);
    if (!set) {
      if (this.isWorkspace(dir)) return dir;
      throw new SessionError(
        this.hasHome
          ? `${this.display(dir)} is not a set, a folder in one, or the workspace: drop it on one of those`
          : `${this.display(dir)} is not a set or a folder in one: drop it on one of those`,
        400,
      );
    }
    // Not through a linked folder that leads out of the set: the file would land elsewhere.
    const real = realOr(dir);
    const root = rootReal(set);
    if (real !== root && !real.startsWith(root + sep))
      throw new SessionError(
        `${this.display(dir)} leads outside ${set.label} through a link: drop it on a folder that is really in the set`,
        400,
      );
    return dir;
  }

  /** The checks every incoming image's bytes pass, after any conversion. */
  private imageBytesOrDie(name: string, bytes: Uint8Array): void {
    if (bytes.byteLength > IMAGE_MAX_BYTES)
      throw new SessionError(
        `${name} is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB: not brought in`,
        400,
      );
    if (!sniffImage(bytes.subarray(0, 32)))
      throw new SessionError(
        `${name} is not a PNG, JPEG, WebP, GIF or AVIF image inside, whatever its name says: not brought in`,
        400,
      );
  }

  /**
   * A dropped image: its bytes written as a plain file into `dir` (or the
   * workspace). Never over a file already there: with `onTaken: "ask"` a taken
   * name is refused with the choices `replace` and `keep-both`, for the surface
   * to put to the human; `keep-both` writes it under a free name. Replacing is
   * the daemon's (`replaceTargetOrDie`), since it needs the Trash.
   */
  importImage(
    name: string,
    bytes: Uint8Array,
    opts: { dir?: string; onTaken: "ask" | "keep-both" },
  ): { path: string } {
    this.imageBytesOrDie(name, bytes);
    const dir = this.imageDestinationOrDie(opts.dir);
    let file = name;
    if (existsSync(join(dir, file))) {
      if (opts.onTaken === "ask")
        throw new SessionError(
          `${file} is already in ${this.display(dir)}`,
          409,
          ["replace", "keep-both"],
          "replace it (the old file goes to the Trash), or keep both under a new name",
        );
      file = this.freeImageName(dir, file);
    } else if (existsSync(sidecarOf(join(dir, file)))) {
      // Only a description is there, its image gone: the new image takes a
      // name of its own rather than that description.
      file = this.freeImageName(dir, file);
    }
    const abs = join(dir, file);
    this.places.world.writeFile(abs, bytes, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  /**
   * ⛔ A bundle a set shows, for writing into its own folder (a board's
   * `assets/`): its folder's path exactly, a bundle node in a mirrored set's
   * tree, really inside that set, and an `assets/` that is a plain folder (or
   * not there yet), never a link. Anything else is refused before a byte is
   * written. A listed bundle is refused: its entry admits the folder alone.
   */
  private bundleAssetsOrDie(rawBundle: string): { bundle: string; assets: string } {
    if (!rawBundle || !isAbsolute(rawBundle))
      throw new SessionError(`"${rawBundle}" is not a full path: start it with /`, 400);
    const abs = this.places.contextForm(resolve(rawBundle));
    const b = bundleOf(abs);
    if (!b || b.root !== abs || b.inner !== "")
      throw new SessionError(`${this.display(abs)} is not a bundle's folder`, 400);
    const entry = this.core.m.context.find(
      (e) =>
        e.membership === "mirrored" &&
        abs.startsWith(e.root + sep) &&
        findNode(e.nodes, toPosix(relative(e.root, abs)))?.kind === "bundle",
    );
    if (!entry) throw new SessionError(`${this.display(abs)} is not a bundle a set shows`, 404);
    this.places.realInsideOrDie(abs, entry, "not written into");
    this.places.notOwnPlaceOrDie(abs);
    const assets = join(abs, "assets");
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(assets);
    } catch {
      /* not there yet: made below */
    }
    if (st && !st.isDirectory())
      throw new SessionError(
        `${this.display(assets)} is not a plain folder: not written into`,
        400,
      );
    if (!st) this.places.world.mkdir(assets);
    return { bundle: abs, assets };
  }

  /**
   * An image dropped on a bundle's view (a board): its bytes, already
   * brought in as any dropped image is (the image settings, the metadata
   * strip), written into the bundle's `assets/` under a free name. Never a
   * question: the human is placing a card. Returns the file and the path a
   * card writes for it (`./assets/…`). A paste's extension is the bytes'
   * (the surface guessed it from the clipboard's type), as for a paste into a
   * document (`importImageBeside`); a drop keeps its own name.
   */
  importImageIntoBundle(
    rawBundle: string,
    name: string,
    bytes: Uint8Array,
    how: "paste" | "drop" = "drop",
  ): { path: string; card: string } {
    this.imageBytesOrDie(name, bytes);
    const { assets } = this.bundleAssetsOrDie(rawBundle);
    let given = basename(name);
    if (how === "paste") {
      const type = sniffImage(bytes.subarray(0, 32)) as ImageType;
      given = `${given.slice(0, given.length - extname(given).length)}${EXTENSION_OF[type]}`;
    }
    // A free name counts a description left without its image, so a new
    // image never takes over an orphaned sidecar.
    const file = this.freeImageName(assets, given);
    const abs = join(assets, file);
    this.places.world.writeFile(abs, bytes, { flag: "wx" });
    return { path: abs, card: `./assets/${file}` };
  }

  /**
   * An image the tree shows, copied into a bundle's `assets/` (a board that
   * keeps its own copy), with its description: a sidecar beside the image
   * comes along beside the copy. The bytes are the shown file's, read through
   * the file route's guard, so only an image the session shows is copied.
   */
  copyImageIntoBundle(
    rawImage: string,
    rawBundle: string,
  ): { path: string; card: string; sidecar?: string } {
    const f = this.imageFile(rawImage);
    let bytes: Uint8Array;
    try {
      bytes = readAllFd(f.fd, f.size);
    } finally {
      closeSync(f.fd);
    }
    const { assets } = this.bundleAssetsOrDie(rawBundle);
    if (f.abs.startsWith(assets + sep))
      throw new SessionError(`${basename(f.abs)} is already this board's own`, 400);
    const file = this.freeImageName(assets, basename(f.abs));
    const abs = join(assets, file);
    this.places.world.writeFile(abs, bytes, { flag: "wx" });
    const from = sidecarOf(f.abs);
    const to = sidecarOf(abs);
    let sidecar: string | undefined;
    try {
      if (lstatSync(from).isFile() && !existsSync(to)) {
        this.places.world.writeFile(to, readFileSync(from), { flag: "wx" });
        sidecar = to;
      }
    } catch {
      /* no description to bring */
    }
    return { path: abs, card: `./assets/${file}`, ...(sidecar ? { sidecar } : {}) };
  }

  /**
   * An image pasted or dropped into a markdown document's editor
   * (kit-image-paste): written into the `images/` folder beside the document,
   * made if it is not there, under a free name (never a question: the human is
   * typing, and a dialog would stop them). A paste's name is the date the
   * surface gave it, with the extension of the type its bytes say; a drop keeps
   * its own. Returns the image and the path to write in the embed, relative to
   * the document as the link picker writes it.
   *
   * Where `images/` may be is where any dropped image may land: in the set the
   * document is in, or, for a loose document directly in the workspace folder,
   * in the workspace folder, where each image becomes a listed entry of its own
   * as a loose image dropped on the list does (the file routes serve only what
   * the context shows, so an unlisted file could not be drawn). A document
   * anywhere else is refused: there is no folder of the session's to write in.
   */
  importImageBeside(
    rawDoc: string,
    name: string,
    bytes: Uint8Array,
    how: "paste" | "drop",
  ): { path: string; doc: string; href: string } {
    const doc = this.places.contextForm(resolve(rawDoc));
    const item = this.places.itemOrDie(doc);
    if (item.dir || docFormat(doc) !== "markdown" || !isDocName(doc))
      throw new SessionError(`${this.display(doc)} is not a markdown document to embed in`, 400);
    this.imageBytesOrDie(name, bytes);
    let file = name;
    if (how === "paste") {
      // The surface guessed the extension from the clipboard's type; the bytes decide.
      const type = sniffImage(bytes.subarray(0, 32)) as ImageType;
      file = `${file.slice(0, file.length - extname(file).length)}${EXTENSION_OF[type]}`;
    }
    const dir = this.imagesDirBeside(doc);
    file = this.freeImageName(dir, file);
    const abs = join(dir, file);
    this.places.world.writeFile(abs, bytes, { flag: "wx" });
    const set = this.places.coveringEntry(abs);
    if (set) this.rescan(set.id);
    else this.adoptNew(abs);
    this.persist();
    return { path: abs, doc, href: relativeHref(doc, abs) };
  }

  /**
   * The `images/` folder beside a document, ready to write into: made when it
   * is not there, and refused when something else holds the name (a file, or a
   * link leading out of the set). See `importImageBeside` for where it may be.
   */
  private imagesDirBeside(doc: string): string {
    const docDir = dirname(doc);
    this.places.notOwnPlaceOrDie(docDir);
    const dir = join(docDir, IMAGES_DIR);
    const set = this.places.coveringEntry(docDir);
    if (!set && !this.isWorkspace(docDir))
      throw new SessionError(
        `${this.display(doc)} is not in a set${this.hasHome ? " or in the workspace folder" : ""}, so an image has nowhere of the session's to go beside it: move the document into one first`,
        400,
      );
    // Before anything is made: the document's folder must really be in the set
    // (a linked folder leading out of it is refused), so nothing is ever
    // created outside the set, even on the way to a refusal.
    if (set) {
      const real = realOr(docDir);
      const root = rootReal(set);
      if (real !== root && !real.startsWith(root + sep))
        throw new SessionError(
          `${this.display(docDir)} leads outside ${set.label} through a link: an image cannot go beside ${basename(doc)}`,
          400,
        );
    }
    let st: ReturnType<typeof lstatSync> | null = null;
    try {
      st = lstatSync(dir);
    } catch {
      /* not there yet */
    }
    let made = false;
    if (st === null) {
      this.places.world.mkdir(dir);
      made = true;
      if (set) this.rescan(set.id);
    } else if (!st.isDirectory() && !(set && st.isSymbolicLink()))
      throw new SessionError(
        `${this.display(dir)} is already there and is not a folder: rename it to bring images in beside ${basename(doc)}`,
        409,
      );
    if (!set) return dir;
    // In a set: a folder the tree shows, really inside the set (a link out is
    // refused). One made outside since the last scan is read in first. A
    // folder this call made is taken away again when it is refused.
    try {
      try {
        return this.imageDestinationOrDie(dir);
      } catch {
        this.rescan(set.id);
        return this.imageDestinationOrDie(dir);
      }
    } catch (e) {
      if (made) {
        try {
          this.places.world.rmdir(dir);
        } catch {
          /* not empty, or gone: leave it */
        }
        this.rescan(set.id);
      }
      throw e;
    }
  }

  /**
   * The image a replacing drop of `name` into `dir` would send to the Trash: an
   * image the tree shows there (in a set, or a loose image's own entry), which
   * `trashPreview` lets go; or, in a workspace folder no set covers, a plain
   * image file directly in it that the context no longer shows (a loose image
   * removed from the list). Refuses anything else, so a replace can never reach
   * a document, a folder, a link, or a file outside the set or the workspace.
   */
  replaceTargetOrDie(name: string, rawDir?: string): string {
    const dir = this.imageDestinationOrDie(rawDir);
    const abs = join(dir, name);
    if (!this.imageNodeAt(abs)) {
      if (!this.places.coveringEntry(dir) && !this.places.itemAt(abs) && isImageName(abs)) {
        let st: ReturnType<typeof lstatSync> | null = null;
        try {
          st = lstatSync(abs);
        } catch {
          /* gone */
        }
        // A plain file that really is an image inside, sniffed from a
        // descriptor opened without following a link: nothing else goes to the Trash.
        if (st?.isFile() && realOr(abs) === join(realOr(dir), name)) {
          const fd = openNoFollow(abs);
          if (fd !== null) {
            let type: ImageType | null = null;
            try {
              type = sniffImage(readHeadFd(fd));
            } finally {
              closeSync(fd);
            }
            if (type) return abs;
          }
        }
      }
      throw new SessionError(`${this.display(abs)} is not an image shown here to replace`, 404);
    }
    const pre = this.trashPreview(abs);
    if (pre.dir || pre.link)
      throw new SessionError(`${pre.shown} is not a plain image file to replace`, 409);
    return pre.path;
  }

  /**
   * The new bytes of a replacement, written beside `target` under a dotted name
   * (which the tree does not show), to be put in place once the old file is in
   * the Trash. Returns the staged path.
   */
  stageImage(target: string, name: string, bytes: Uint8Array): string {
    this.imageBytesOrDie(name, bytes);
    this.places.notOwnPlaceOrDie(dirname(target));
    const staged = join(dirname(target), `.${basename(target)}.incoming-${randHex(4)}`);
    this.places.world.writeFile(staged, bytes, { flag: "wx" });
    return staged;
  }

  /** Put a staged replacement in place of `target`, whose old file is now in the Trash. */
  placeStaged(staged: string, target: string): { path: string } {
    this.refuseExisting(target);
    this.places.world.rename(staged, target);
    // A loose image's entry is still there (only the file went to the Trash); one
    // the context no longer showed is given an entry again, as a new drop would be.
    if (this.places.itemAt(target)) this.rescanAround(target);
    else this.adoptNew(target);
    this.persist();
    return { path: target };
  }

  /** Drop a staged replacement that will not be used. */
  unstage(staged: string): void {
    try {
      this.places.world.unlink(staged);
    } catch {
      /* already gone, or refused: nothing removed */
    }
  }

  // ── the Trash: the human's delete ──────────────────────────────────────
  //
  // Not a structure op: the agent has no way to it, and it has no undo here
  // (the Trash is the way back). The daemon asks `trashPreview` (which is also
  // the check), moves the path to the Trash, then tells the session with
  // `trashed`.

  /** The most entries a preview counts before it says "at least". */
  static readonly TRASH_COUNT_CAP = 10_000;

  /**
   * What moving `rawPath` to the Trash would take, and the refusal when it may
   * not go: only a document, image or folder shown inside a set, or a single
   * listed document or image. A set's own folder is refused (Remove from context is the way to
   * stop showing it; deleting the folder is the file manager's job).
   */
  trashPreview(rawPath: string): TrashPreview {
    if (!isAbsolute(rawPath)) throw new SessionError(`"${rawPath}" is not a full path`, 400);
    const item = this.places.itemOrDie(rawPath);
    this.places.notOwnSourceOrDie(item.abs);
    const shown = this.display(item.abs);
    if (item.whole && item.dir && !item.bundle)
      throw new SessionError(
        `${shown} is a whole set: remove it from the context to stop showing it, or delete the folder in your file manager`,
        409,
      );
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(item.abs);
    } catch {
      throw new SessionError(`${item.abs} is not on disk`, 404);
    }
    const within = (p: string, root: string): boolean => p === root || p.startsWith(root + sep);
    // Where the item really is: its folders' realpath, the item itself not
    // followed, so a link is judged where it sits and trashing it moves the link.
    const real = join(realOr(dirname(item.abs)), basename(item.abs));
    // Not out through a link: a path through a linked folder inside the set
    // names a place outside it, and that place is not the set's to delete.
    if (!within(real, rootReal(item.entry)))
      throw new SessionError(
        `${shown} leads outside ${item.entry.label} through a link: delete it in your file manager if you mean to`,
        409,
      );
    // Never a set's own folder (one nested in this set counts too), and never
    // the workspace or the session's own store.
    const holds = (p: string) => within(p, item.abs) || within(realOr(p), real);
    for (const e of this.core.m.context) {
      if (e.id === item.entry.id) continue;
      if (e.membership === "mirrored" && holds(e.root))
        throw new SessionError(
          `${shown} holds the set ${e.label}: remove that set from the context first, or delete the folder in your file manager`,
          409,
        );
    }
    for (const [what, p] of [
      ["the workspace folder", this.workspace],
      ["this session's folder", this.dir],
      ["the sessions folder", this.sessionsRoot],
    ] as const)
      if (holds(p))
        throw new SessionError(
          `${shown} holds ${what}, so it cannot go to the Trash from here`,
          409,
        );
    const link = st.isSymbolicLink();
    const dir = st.isDirectory();
    let files = 0;
    let folders = 0;
    let truncated = false;
    if (!dir) files = 1;
    else {
      const stack = [item.abs];
      walk: while (stack.length > 0) {
        const at = stack.pop() as string;
        let names: string[];
        try {
          names = readdirSync(at);
        } catch {
          continue;
        }
        for (const name of names) {
          if (files + folders >= WorkspaceSession.TRASH_COUNT_CAP) {
            truncated = true;
            break walk;
          }
          const p = join(at, name);
          let isDir = false;
          try {
            // lstat: a link is one entry, and what it points at is not taken.
            isDir = lstatSync(p).isDirectory();
          } catch {
            /* gone meanwhile */
          }
          if (isDir) {
            folders++;
            stack.push(p);
          } else files++;
        }
      }
    }
    // An image's description goes to the Trash with it.
    const sidecar = dir || link ? null : this.sidecarFileOf(item.abs);
    if (sidecar) files++;
    const inside = (p: string) =>
      p === item.abs || p.startsWith(item.abs + sep) || (sidecar !== null && p === sidecar);
    const docs = this.core.m.docs
      .filter((d) => inside(d.original) && !d.missing)
      .map((d) => ({
        slug: d.slug,
        name: this.docName(d),
        unsaved: this.isDirty(d),
        versions: d.versions.length,
        open: this.core.m.openDoc === d.slug,
      }));
    return {
      path: item.abs,
      shown,
      dir,
      ...(link ? { link: true as const } : {}),
      files,
      folders,
      ...(truncated ? { truncated: true as const } : {}),
      docs,
      ...(sidecar ? { sidecar } : {}),
      ...(item.bundle
        ? {
            bundle: {
              label: item.bundle.label,
              name: bundleNameAt(item.abs),
            },
          }
        : {}),
    };
  }

  /**
   * After `path` went to the Trash: the documents under it are marked missing
   * (their records and versions stay), the open one closes, a single listed
   * document's or image's entry goes, and the sets that held it are re-read. Returns the
   * slugs of the documents it held.
   */
  trashed(path: string): { docs: string[]; closed: string | null } {
    const inside = (p: string) => p === path || p.startsWith(path + sep);
    const docs: string[] = [];
    let closed: string | null = null;
    for (const d of this.core.m.docs) {
      if (!inside(d.original)) continue;
      d.missing = true;
      docs.push(d.slug);
      if (this.core.m.openDoc === d.slug) {
        this.core.m.openDoc = null;
        closed = d.slug;
      }
    }
    // An image has no record to keep: its viewer simply closes.
    if (this.core.m.openImage && inside(this.core.m.openImage)) this.core.m.openImage = null;
    for (const e of [...this.core.m.context]) {
      const only = listedFile(e);
      if (only && inside(only.abs)) this.removeContext(e.id);
    }
    this.rescanAround(path);
    this.relink();
    this.persist();
    return { docs, closed };
  }

  /**
   * Read a bundle's row again, after an app wrote into it directly (a stage
   * act copying documents into `docs/`): its contents and its member
   * documents are the context's at once, not when the watcher next says so,
   * so a document just copied in opens by its path straight away.
   */
  refreshBundle(abs: string): void {
    this.rescanAround(abs);
    // A bundle listed on its own (made in the workspace) is its entry's one
    // row: read that row again, whether `abs` is the bundle or inside it.
    const b = bundleOf(abs);
    if (b) this.refreshListed(b.root);
    this.relink();
  }

  /** Re-mirror the sets that hold `abs`, after a file there came or went. */
  private rescanAround(abs: string): void {
    for (const e of this.core.m.context)
      if (e.membership === "mirrored" && abs.startsWith(e.root + sep)) this.rescan(e.id);
    const listed = this.listedBundleHolding(abs);
    if (listed) this.refreshListed(listed);
  }

  /** Mark a document's original missing; the event to announce, or null when it already was. */
  private markMissing(d: Doc): FileEvent | null {
    if (d.missing) return null;
    d.missing = true;
    this.rescanAround(d.original);
    this.persist();
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
    const d = this.docOrDie(slug);
    let text: string;
    try {
      text = readFileSync(d.original, "utf8");
    } catch {
      throw new SessionError(`${d.original} is gone from disk: there is no file to revert to`, 409);
    }
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    delete d.outsideHash;
    this.writeActive(d, text);
    this.persist();
    return { version: d.active, text };
  }

  private isDirty(d: Doc): boolean {
    return (this.activeHash.get(d.slug) ?? "") !== d.originalHash;
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
    if (abs.startsWith(this.docsDir + sep)) {
      const rest = abs.slice(this.docsDir.length + 1).split(sep);
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
      if (this.isOwnWrite(abs, text)) return null;
      if (!d.versions.some((v) => v.n === n)) {
        // The agent wrote a version file by hand rather than through
        // `version-new`: adopt it rather than leave a file the surface cannot
        // see. The counter moves past it, so the next number is still unused.
        // A number below the counter was used once and may have been deleted:
        // reusing it would make a "v2" named in a chat message or an agent's
        // notes point at a different document, so the file is renumbered.
        if (n < d.nextVersion) {
          const next = this.takeVersion(d);
          const to = this.core.versionPath(d, next);
          this.writes.own(to, text);
          this.own.rename(abs, this.places.ownFileOrDie(to));
          d.versions.push({ n: next, by: "agent", createdAt: nowIso() });
          d.versions.sort((a, b) => a.n - b.n);
          this.persist();
          return { kind: "version.created", doc: d.slug, version: next, path: to, renamedFrom: n };
        }
        d.versions.push({ n, by: "agent", createdAt: nowIso() });
        d.versions.sort((a, b) => a.n - b.n);
        d.nextVersion = Math.max(d.nextVersion, n + 1);
        this.writes.own(abs, text);
        this.persist();
        return { kind: "version.created", doc: d.slug, version: n, path: abs };
      }
      if (n === d.active) {
        // The outside text becomes a new agent version, and the active version
        // goes back to the daemon's own last text, so the active version only
        // ever holds what the human typed, and nothing anyone wrote is lost.
        const kept = this.preserveOutside(d, text);
        this.writeActive(d, this.lastActiveText.get(d.slug) ?? text);
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
        this.rescanAround(d.original);
        this.relink();
        if (h !== d.originalHash) {
          d.outsideChanged = true;
          d.outsideHash = h;
          this.persist();
          return { kind: "original.conflict", doc: d.slug, original: d.original };
        }
        this.persist();
        return { kind: "original.back", doc: d.slug, original: d.original };
      }
      if (h === d.originalHash) return null; // our own save, or no change
      const clean = !this.isDirty(d);
      if (clean) {
        d.originalHash = h;
        this.writeActive(d, text);
        this.persist();
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
      this.persist();
      return { kind: "original.conflict", doc: d.slug, original: d.original };
    }

    // Anything inside a bundle the context shows is a change to the bundle:
    // its row is read again (its title may be new), and the change is said.
    // One gone from disk is a change to the tree, below.
    const bundle = this.shownBundleOf(abs);
    if (bundle && existsSync(bundle)) {
      this.rescanAround(bundle);
      this.refreshListed(bundle);
      // The echo of the session's own act: the tree is read again, and that is all.
      if (this.writes.isOwnBundleEcho(bundle)) return null;
      return { kind: "bundle", path: bundle, file: abs };
    }

    // Something under a mirrored root: the tree may have changed.
    for (const e of this.core.m.context) {
      if (e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep))) {
        return this.rescan(e.id) ? { kind: "tree", entryId: e.id } : null;
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

  // ── structure: real changes on disk, one path for both parties ─────────
  //
  // Every method below does the change on disk and then brings the context
  // model back in line with it. The surface reaches them through menus and drag
  // and drop, the agent through CLI verbs; the daemon announces each one under
  // the name of whoever did it. Two rules hold throughout:
  //
  // - Nothing is deleted by a structure change. (Undoing a creation removes
  //   what the session itself made, behind a confirmation: see `history.ts`.
  //   The human's Delete moves a path to the Trash, and is not a structure
  //   change: see `trashPreview`.)
  // - Nothing is overwritten. A destination that exists is refused (an explicit
  //   name) or given a free name (a default one, a drop); files are created with
  //   the exclusive flag, so a race cannot clobber either.

  /**
   * After something moved on disk from `from` to `to`, bring the model with it:
   * opened documents keep their versions under the new path, entries rooted at
   * or holding the moved thing follow it, and every mirror is re-read. An entry
   * that now sits inside another set is dropped: the set shows it already.
   */
  private followMove(from: string, to: string): void {
    // Kept for the link check's `proposed`: where a proposal's old target went.
    this.moves.push([from, to]);
    if (this.moves.length > MOVES_KEPT) this.moves.splice(0, this.moves.length - MOVES_KEPT);
    const moved = (p: string): string | null =>
      p === from ? to : p.startsWith(from + sep) ? to + p.slice(from.length) : null;
    for (const d of this.core.m.docs) {
      const now = moved(d.original);
      if (now) {
        d.original = now;
        d.name = basename(now);
      }
    }
    // The open image follows a rename or a move, as an open document does.
    const image = this.core.m.openImage ? moved(this.core.m.openImage) : null;
    if (image) this.core.m.openImage = image;
    // A converted image's remembered name follows it; one left by a file that
    // was where the moved thing now is goes.
    if (this.core.m.importedAs) {
      const names: Record<string, string> = {};
      for (const [p, n] of Object.entries(this.core.m.importedAs)) {
        const now = moved(p);
        if (now) names[now] = n;
        else if (p !== to && !p.startsWith(to + sep)) names[p] = n;
      }
      this.core.m.importedAs = names;
    }
    const drop = new Set<string>();
    for (const e of this.core.m.context) {
      if (e.membership === "listed") {
        const only = listedFile(e);
        if (!only) continue;
        const now = moved(only.abs);
        if (!now) continue;
        if (this.places.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = dirname(now);
          e.realRoot = realOr(e.root);
          e.label = basename(now);
          const bundle = only.kind === "bundle" ? bundleTypeOf(now) : null;
          e.nodes = [
            only.kind === "image"
              ? { kind: "image", rel: basename(now) }
              : bundle
                ? bundleNode(basename(now), now, bundle)
                : docNode(basename(now), now),
          ];
        }
      } else {
        const now = moved(e.root);
        if (!now) continue;
        if (this.places.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = now;
          e.realRoot = realOr(now);
          e.label = basename(now) || now;
        }
      }
    }
    this.core.m.context = this.core.m.context.filter((e) => !drop.has(e.id));
    for (const e of this.core.m.context) if (e.membership === "mirrored") this.rescan(e.id);
    this.refreshListedContents();
    this.relink();
  }

  /** After a file or folder landed at `abs`: re-read the set it is in, or give it an entry. */
  private adoptNew(abs: string): void {
    const set = this.places.coveringEntry(abs);
    const listed = set ? null : this.listedBundleHolding(abs);
    // Every set whose root holds it, not only the first: a linked folder added
    // as a set of its own sits under the set holding its link, which shows it
    // only as a link's row, and the thing made is shown by the other one.
    if (set) {
      for (const e of this.core.m.context) {
        const holds = abs === e.root || abs.startsWith(e.root + sep);
        if (e.membership === "mirrored" && holds) this.rescan(e.id);
      }
    }
    // Made in a member folder of a bundle listed on its own: its row is read
    // again. An entry of its own would be the bundle a second time.
    else if (listed) this.refreshListed(listed);
    else {
      // Every write that lands here passed the backstop; a new entry still
      // takes the one set guard.
      this.places.mayBeASetOrDie(abs);
      const id = `c-${randHex(3)}`;
      this.core.m.context.push(
        entryForPath(abs, id, (root) => this.scanSkip(id, root), this.scanGuard()),
      );
    }
    this.relink();
  }

  /** The folder of a bundle listed on its own (no set shows it) that `abs` is inside, else null. */
  private listedBundleHolding(abs: string): string | null {
    const b = bundleOf(abs);
    if (!b || b.inner === "") return null;
    for (const e of this.core.m.context) {
      const only = listedFile(e);
      if (only?.kind === "bundle" && only.abs === b.root) return b.root;
    }
    return null;
  }

  /** Read every listed bundle of an expandable type again: its contents follow what moved. */
  private refreshListedContents(): void {
    for (const e of this.core.m.context) {
      const only = listedFile(e);
      if (only?.kind === "bundle" && bundleTypeOf(only.abs)?.expand) this.refreshListed(only.abs);
    }
  }

  /**
   * A name in `dir` that is free: `name`, else `stem N.ext` with N the first
   * free number from 2 (`Untitled 2.md`, filling a gap). A plain folder's
   * name has no extension; a bundle's keeps its own. Bounded: past
   * FREE_NAME_TRIES it is refused rather than counted further.
   */
  private freeName(
    dir: string,
    name: string,
    isDir: boolean,
    taken: (abs: string) => boolean = (abs) => !!entryAt(abs),
  ): string {
    if (!taken(join(dir, name))) return name;
    const ext = isDir ? "" : (bundleTypeOf(name)?.extension ?? extname(name));
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2; i < 2 + FREE_NAME_TRIES; i++) {
      const n = fitName(stem, ` ${i}${ext}`);
      if (!taken(join(dir, n))) return n;
    }
    throw new SessionError(
      `no free name like "${fitName(stem, ` 2${ext}`)}" is left in ${tilde(dir)}`,
      409,
    );
  }

  /**
   * A free name for an incoming image: one with neither the image nor its
   * description sidecar (`<name>.md`) there, so a description left behind by
   * an image that went is never taken up by a new one under its old name.
   */
  private freeImageName(dir: string, name: string): string {
    return this.freeName(dir, name, false, (abs) => !!entryAt(abs) || !!entryAt(sidecarOf(abs)));
  }

  private refuseExisting(abs: string): void {
    if (entryAt(abs)) throw new SessionError(`${abs} already exists: nothing was overwritten`, 409);
  }

  /**
   * A new document in `rawDir` (a set, a folder in one, or the workspace; never
   * inside a bundle). `opts.text` is what it starts with; `opts.free` takes the
   * next free name when `name` is taken, rather than refusing.
   */
  createDoc(
    rawDir: string,
    name?: string,
    opts: { text?: string; free?: boolean } = {},
  ): { path: string } {
    const dir = this.places.destinationOrDie(rawDir);
    const wanted = name === undefined ? "Untitled.md" : this.places.docNameOrDie(name);
    const file =
      name === undefined || opts.free === true ? this.freeName(dir, wanted, false) : wanted;
    const abs = join(dir, file);
    this.refuseExisting(abs);
    if (opts.text !== undefined && Buffer.byteLength(opts.text) > WorkspaceSession.IMPORT_MAX_BYTES)
      throw new SessionError(
        `a new document's text is larger than ${WorkspaceSession.IMPORT_MAX_BYTES / 1024 / 1024} MB: not created`,
        400,
      );
    // A new JSON document starts as the smallest JSON there is, so its first
    // Save is not refused for being empty.
    const text = opts.text ?? (docFormat(file) === "json" ? "{}\n" : "");
    this.places.world.writeFile(abs, text, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  createFolder(rawDir: string, name?: string): { path: string } {
    const dir = this.places.destinationOrDie(rawDir);
    // One made in the workspace gets an entry of its own (`adoptNew`): a set,
    // and named as one. Inside a set it is a folder.
    const makesSet = !this.places.coveringEntry(dir) && this.isWorkspace(dir);
    const folder =
      name === undefined
        ? this.freeName(dir, makesSet ? "New set" : "New folder", true)
        : this.places.nameOrDie(name);
    this.refuseBundleName(folder, "a new folder");
    const abs = join(dir, folder);
    this.refuseExisting(abs);
    this.places.world.mkdir(abs);
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  /**
   * A new, empty bundle in `rawDir`, wherever a new document may go (a set, a
   * folder in one, or the workspace) and so never inside another bundle: its
   * folder, its `info.json` and its main file from the type's template, and
   * nothing else (`assets/` waits until something needs it). The type is the
   * one registered for `extension`, else the first registered. `name` is the
   * title; it defaults to a free "Untitled". Returns the folder, and the hash
   * of what was written, so the undo can tell the bundle is still as made.
   */
  createBundle(rawDir: string, extension?: string, name?: string): { path: string; hash: string } {
    const type =
      extension === undefined
        ? bundleTypes()[0]
        : bundleTypes().find((t) => t.extension === extension.toLowerCase());
    if (!type)
      throw new SessionError(
        extension === undefined
          ? "no kind of bundle is registered in this app"
          : `no kind of bundle is registered for ${extension}`,
        400,
        bundleTypes().map((t) => t.extension),
      );
    const dir = this.places.destinationOrDie(rawDir);
    // A member folder takes documents, never a bundle inside a bundle.
    const holder = bundleHolding(dir);
    if (holder)
      throw new SessionError(
        `a ${type.label} is not made inside the ${holder.type.label} ${bundleNameAt(holder.root)}: make it beside it`,
        409,
      );
    const given = name === undefined ? null : this.places.nameOrDie(name);
    const folder =
      given === null
        ? this.freeName(dir, `Untitled${type.extension}`, false)
        : bundleTypeOf(given) === type
          ? given
          : fitName(given, type.extension);
    const abs = join(dir, folder);
    this.refuseExisting(abs);
    this.writes.wroteBundle(abs);
    this.places.world.mkdir(abs);
    this.places.world.writeFile(join(abs, BUNDLE_INFO), newBundleInfo(type, bundleStem(folder)), {
      flag: "wx",
    });
    this.places.world.writeFile(join(abs, type.main), type.mainTemplate, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs, hash: treeHash(abs) };
  }

  /**
   * A copy of a document or a bundle, beside it, named as Finder names one
   * (`copyName`): `Ch 4 copy.md`, then `Ch 4 copy 2.md`. A bundle is copied
   * whole, its own files with it and its links as written, and its copy's
   * title takes the same words ("The well copy"), so the two rows can be
   * told apart; a copy that fails part way is removed. A document is copied
   * as it is on disk: unsaved edits stay with the one they were made in. A
   * plain folder is not duplicated. Returns the copy, and the hash of what
   * was written, so the undo can tell it is still as made.
   */
  duplicate(rawPath: string): { path: string; from: string; hash: string; dir: boolean } {
    const item = this.places.itemOrDie(rawPath);
    this.places.notOwnPlaceOrDie(dirname(item.abs));
    const isDoc = !item.dir && isDocName(item.abs) && !isImageName(item.abs);
    if (!item.bundle && !isDoc)
      throw new SessionError(
        `${this.display(item.abs)} cannot be duplicated: only a document or a bundle can`,
        400,
      );
    // A link is not copied: the copy would be a second link to the same
    // folder, and writing its title would write into the original.
    if (lstatSync(item.abs).isSymbolicLink())
      throw new SessionError(
        `${this.display(item.abs)} is a link to ${tilde(realOr(item.abs))}: duplicate it where it really is`,
        409,
      );
    const dir = dirname(item.abs);
    const ext = item.bundle ? item.bundle.extension : extname(item.abs);
    const { name, suffix } = copyName(dir, basename(item.abs), ext);
    const to = join(dir, name);
    const refused = (e: unknown) =>
      new SessionError(
        `cannot copy ${this.display(item.abs)}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,
        409,
      );
    if (item.bundle) {
      this.writes.wroteBundle(to);
      // ⛔ The copy's folder is made here first, alone (no `recursive`), so it
      // fails if anything is at `to` by now (a link, a folder another process
      // just made): only a folder this act made is ever removed below.
      try {
        this.places.world.mkdir(to);
      } catch (e) {
        if (e instanceof SessionError) throw e;
        throw refused(e);
      }
      try {
        // Into the folder just made, one entry at a time (a folder copied
        // onto an existing one is refused). `verbatimSymlinks`: a link inside
        // is copied as written, so a relative one (`../a.md`) still leads
        // inside the copy, never back into the original.
        for (const name of readdirSync(item.abs))
          this.places.world.cp(join(item.abs, name), join(to, name), {
            recursive: true,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
          });
      } catch (e) {
        // Part of a copy is no copy: the folder this act made goes again.
        try {
          this.places.world.rm(to, { recursive: true, force: true });
        } catch {
          /* said below either way */
        }
        throw refused(e);
      }
      // `readBundleInfo` reads only a plain file (never through a link) that
      // parses: anything else is copied as it was, and not written. The title
      // takes the folder's words: "The well copy 2" copied is "The well copy 3".
      const info = readBundleInfo(to);
      const title = typeof info?.title === "string" ? info.title : bundleStem(basename(item.abs));
      if (info !== null)
        this.places.world.writeFile(
          join(to, BUNDLE_INFO),
          writeBundleInfo(info, item.bundle, { title: `${uncopied(title)}${suffix}` }),
        );
    } else {
      this.refuseExisting(to);
      try {
        this.places.world.copyFile(item.abs, to, constants.COPYFILE_EXCL);
      } catch (e) {
        if (e instanceof SessionError) throw e;
        throw refused(e);
      }
    }
    this.adoptNew(to);
    this.persist();
    return { path: to, from: item.abs, hash: treeHash(to), dir: item.bundle !== undefined };
  }

  move(
    rawPath: string,
    rawInto: string,
    opts: {
      /**
       * Undo or redo of a recorded move: `rawInto` is the folder the item was
       * in, which may be no set or workspace now (a set's whole folder moved
       * into the workspace came from elsewhere on disk). Any existing folder is
       * taken, so a move is always reversible. Never from a party's request.
       */
      back?: boolean;
      /** Find the links the move breaks (`links` in the result); nothing is rewritten. */
      links?: boolean;
    } = {},
  ): {
    path: string;
    from: string;
    /** An image's description moved with it: where it is now. */
    sidecar?: string;
    /** With `opts.links`: the links the move broke, by document, each with its new target. */
    links?: DocLinkFixes[];
    /** With `opts.links`: the wiki links it broke, which are never rewritten. */
    wiki?: WikiBreak[];
    /** With `opts.links`, for an app with edges: the app edges it broke, which are never rewritten. */
    edges?: EdgeBreak[];
  } {
    // A recorded move whose item has gone from disk can never be replayed.
    if (opts.back && !existsSync(resolve(rawPath)))
      throw new GoneError(
        `${tilde(resolve(rawPath))} is gone: the move this would undo cannot go back`,
        409,
      );
    const item = this.places.itemOrDie(rawPath);
    if (!item.dir) this.refuseLoneSidecar(item.abs, "move");
    const into = opts.back
      ? this.places.folderOrDie(rawInto)
      : this.places.destinationOrDie(rawInto);
    if (into === item.abs || into.startsWith(item.abs + sep))
      throw new SessionError(`cannot move ${this.display(item.abs)} into itself`, 400);
    if (dirname(item.abs) === into)
      throw new SessionError(`${this.display(item.abs)} is already in that folder`, 400);
    const to = join(into, basename(item.abs));
    this.refuseExisting(to);
    // An image's description goes with it, or nothing moves.
    const sidecar = item.dir ? null : this.sidecarFileOf(item.abs);
    const sidecarTo = sidecar ? sidecarOf(to) : null;
    if (sidecarTo) this.refuseExisting(sidecarTo);
    const sidecarShown = sidecar !== null && this.places.itemAt(sidecar);
    const pins = opts.links ? this.pinLinks(sidecar ? [item.abs, sidecar] : [item.abs]) : null;
    // The app's edges it breaks are said as the plan says them, never rewritten.
    const edgePins =
      opts.links && this.readIndex.appEdges
        ? this.pinEdges(sidecar ? [item.abs, sidecar] : [item.abs])
        : null;
    this.renameOrDie(item.abs, to);
    if (sidecar && sidecarTo) this.carrySidecar(item.abs, to, sidecar, sidecarTo);
    this.followMove(item.abs, to);
    if (sidecar && sidecarTo) this.followMove(sidecar, sidecarTo);
    if (!this.places.itemAt(to)) this.adoptNew(to);
    if (sidecarTo && sidecarShown && !this.places.itemAt(sidecarTo)) this.adoptNew(sidecarTo);
    this.persist();
    const pairs = movedPairs(item.abs, to, sidecar, sidecarTo);
    const links = pins ? this.planRelink(pins, pairs) : null;
    const edges = edgePins ? this.brokenEdges(edgePins, pairs) : null;
    return {
      path: to,
      from: item.abs,
      ...(sidecarTo ? { sidecar: sidecarTo } : {}),
      ...(links ? { links: links.fixes, wiki: links.wiki } : {}),
      ...(edges ? { edges } : {}),
    };
  }

  /**
   * What `move` would do, without doing it (kit-move-plan): the item, where it
   * would land, how many documents go with it, and the links it would break,
   * each with the rewrite `move --update-links` would offer (`./movePlan.ts`),
   * and the app edges it would break. Refuses exactly what `move` refuses, so a
   * move confirmed from the plan is admitted. It writes nothing: no file, no
   * manifest.
   */
  movePlan(rawPath: string, rawInto: string): MovePlan {
    const item = this.places.itemOrDie(rawPath);
    if (!item.dir) this.refuseLoneSidecar(item.abs, "move");
    const into = this.places.destinationOrDie(rawInto);
    if (into === item.abs || into.startsWith(item.abs + sep))
      throw new SessionError(`cannot move ${this.display(item.abs)} into itself`, 400);
    if (dirname(item.abs) === into)
      throw new SessionError(`${this.display(item.abs)} is already in that folder`, 400);
    const to = join(into, basename(item.abs));
    this.refuseExisting(to);
    const sidecar = item.dir ? null : this.sidecarFileOf(item.abs);
    const sidecarTo = sidecar ? sidecarOf(to) : null;
    if (sidecarTo) this.refuseExisting(sidecarTo);
    const pairs = movedPairs(item.abs, to, sidecar, sidecarTo);
    const moved = sidecar ? [item.abs, sidecar] : [item.abs];
    const pins = this.pinLinks(moved);
    const edgePins = this.pinEdges(moved);
    // As `move` adopts them: the item where it lands, and an image's
    // description the tree shows, each given an entry when nothing shows it.
    const adopted = [
      to,
      ...(sidecar && sidecarTo && this.places.itemAt(sidecar) ? [sidecarTo] : []),
    ];
    const world = this.planWorld(movedWorld(pairs), adopted);
    const plan = this.planRelink(pins, pairs, world);
    const docs = item.dir
      ? [...this.places.contextIndex().entryOf.keys()].filter((p) => p.startsWith(item.abs + sep))
          .length
      : 1;
    return {
      from: item.abs,
      to,
      into,
      name: basename(item.abs),
      folder: item.dir,
      docs,
      ...(sidecarTo ? { sidecar: sidecarTo } : {}),
      links: plan.fixes,
      wiki: plan.wiki,
      edges: this.brokenEdges(edgePins, pairs, world),
      references: pins.filter((p) => p.kind === "reference").length,
      checked: pins.length + edgePins.length,
    };
  }

  /**
   * The context as it would be after a move that has not happened, entry by
   * entry in context order, as `followMove` and then `adoptNew` would leave
   * it: each entry with its root where it would be (a listed entry's one item
   * too), less an entry the move takes into a set that covers it, and then an
   * entry for each of `adopted` that nothing would show: a set rooted at a
   * folder, a listed item for a file or a bundle, as `entryForPath` makes them.
   */
  private planWorld(world: MovedWorld, adopted: readonly string[]): PlanWorld {
    const entries: EntryAfter[] = [];
    for (const e of this.core.m.context) {
      const only = e.membership === "listed" ? listedFile(e) : null;
      if (e.membership === "listed" && !only) continue;
      const was = only ? only.abs : e.root;
      const now = world.forward(was);
      if (now !== was && this.places.coveringEntry(now, e.id)) continue;
      entries.push({ e: { ...e, root: only ? dirname(now) : now }, file: only ? now : null });
    }
    for (const p of adopted) {
      const shown = entries.some(({ e, file }) =>
        file !== null
          ? p === file || p.startsWith(file + sep)
          : e.membership === "mirrored" && (p === e.root || p.startsWith(e.root + sep)),
      );
      if (shown) continue;
      const at = world.back(p);
      let dir = false;
      try {
        dir = at !== null && statSync(at).isDirectory();
      } catch {
        continue;
      }
      const set = dir && bundleTypeOf(p) === null;
      const e: ContextEntry = {
        id: `c-plan-${entries.length}`,
        label: basename(p),
        root: set ? p : dirname(p),
        membership: set ? "mirrored" : "listed",
        nodes: [],
        realRoot: set ? p : dirname(p),
      };
      entries.push({ e, file: set ? null : p });
    }
    return { ...world, entries };
  }

  /**
   * The first entry of the world after a move that lists `path` (its listed
   * item, or under a set's root), as the context index would answer once the
   * move is made; -1 when none does.
   */
  private listedAfter(path: string, world: PlanWorld): number {
    return world.entries.findIndex(({ e, file }) =>
      file !== null ? path === file || path.startsWith(file + sep) : path.startsWith(e.root + sep),
    );
  }

  /**
   * The context entry a path is in after a move that has not happened, with
   * its root where it would be, as `entryFinder` would answer once the move
   * is made: a path the move leaves where it is keeps its entry; a moved one
   * is in the first entry that would list it, else under whose root it lies
   * (`planWorld` holds the entries, the one `adoptNew` would make among them).
   */
  private entryAfter(
    path: string,
    world: PlanWorld,
    entryOf: (path: string) => ContextEntry | undefined,
  ): ContextEntry | undefined {
    if (world.back(path) === path) {
      const e = entryOf(path);
      return e && { ...e, root: world.forward(e.root) };
    }
    const at = this.listedAfter(path, world);
    if (at >= 0) return world.entries[at]?.e;
    return world.entries.find(({ e }) => path.startsWith(e.root + sep))?.e;
  }

  /**
   * The documents an app's resolver is handed in the world after a move, in
   * the order the session will have them then (`candidates`): each entry's
   * documents in context order, each set's as its scan lists them
   * (`treeOrder`), then the documents no entry lists, as they were. An app's
   * resolver that takes the first match of a name (a wiki link) then matches
   * what it will match after the move. Built once per plan.
   */
  private docsAfter(index: ContextIndex, world: PlanWorld): readonly ResolvableDocument[] {
    if (world.docs) return world.docs;
    const keyed = this.readIndex.resolvableDocs(index).map((d, i) => {
      const path = world.forward(d.path);
      const at = this.listedAfter(path, world);
      return { d: { ...d, path }, i, at: at < 0 ? Number.POSITIVE_INFINITY : at };
    });
    keyed.sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      const e = world.entries[a.at]?.e;
      if (!e) return a.i - b.i;
      return treeOrder(relative(e.root, a.d.path), relative(e.root, b.d.path)) || a.i - b.i;
    });
    world.docs = keyed.map((k) => k.d);
    return world.docs;
  }

  /**
   * Every app edge (the link slot's `edges`) that a move of `moved` could
   * break: one that lands on the moved thing (or inside it), or is written in
   * a document inside it, with where it lands now. None for an app without
   * edges.
   */
  private pinEdges(moved: readonly string[]): EdgePin[] {
    if (!this.readIndex.appEdges) return [];
    const under = (p: string) => moved.some((m) => p === m || p.startsWith(m + sep));
    const index = this.places.contextIndex();
    const entryOf = this.readIndex.entryFinder(index);
    const read = new Set<string>();
    const pins: EdgePin[] = [];
    for (const c of this.readIndex.markdownCandidates()) {
      const inside = under(c.path);
      for (const e of this.readIndex.readOf(c, read)?.edges ?? []) {
        // Resolved as the link check resolves an edge.
        const r = this.linkResolve.resolveFrom(
          e.target,
          c.path,
          entryOf(c.path),
          "document",
          index,
        );
        if (r.state === "missing" || (!inside && !under(r.path))) continue;
        pins.push({
          kind: e.kind,
          src: c.path,
          raw: e.target,
          target: r.path,
          ...(e.key !== undefined ? { key: e.key } : {}),
          ...(e.line !== undefined ? { line: e.line } : {}),
        });
      }
    }
    return pins;
  }

  /**
   * The pinned app edges the move broke (or, with `world`, would break): each
   * that no longer lands where its target went. Reported, never rewritten: an
   * edge is the app's text, written in the app's form.
   */
  private brokenEdges(
    pins: readonly EdgePin[],
    pairs: readonly (readonly [string, string])[],
    world?: PlanWorld,
  ): EdgeBreak[] {
    if (pins.length === 0) return [];
    const map = movedWorld(pairs).forward;
    const index = this.places.contextIndex();
    const entryOf = this.readIndex.entryFinder(index);
    const out: EdgeBreak[] = [];
    for (const pin of pins) {
      const src = map(pin.src);
      const entry = world ? this.entryAfter(src, world, entryOf) : entryOf(src);
      const r = this.linkResolve.resolveFrom(
        pin.raw,
        src,
        entry,
        "document",
        index,
        "markdown",
        world,
      );
      if (r.state !== "missing" && r.path === map(pin.target)) continue;
      out.push({
        kind: pin.kind,
        source: src,
        ...(pin.key !== undefined ? { key: pin.key } : {}),
        ...(pin.line !== undefined ? { line: pin.line } : {}),
        raw: pin.raw,
      });
    }
    return out;
  }

  rename(
    rawPath: string,
    name: string,
    opts: {
      /** Find the links the rename breaks (`links` in the result); nothing is rewritten. */
      links?: boolean;
      /**
       * A bundle's title to write in place of the name given (an undo putting
       * the old one back); null removes it, so the row shows the folder's name.
       */
      title?: string | null;
    } = {},
  ): {
    path: string;
    from: string;
    /** A bundle's title, before and after (absent: it had none, or has none now). */
    title?: { from?: string; to?: string };
    /** An empty document renamed to JSON was given `{}`: the held version's new text. */
    seeded?: { doc: string; version: number; text: string };
    /** An image's description was renamed with it: its new path. */
    sidecar?: string;
    /** With `opts.links`: the links the rename broke, by document, each with its new target. */
    links?: DocLinkFixes[];
    /** With `opts.links`: the wiki links it broke, which are never rewritten. */
    wiki?: WikiBreak[];
  } {
    const item = this.places.itemOrDie(rawPath);
    if (item.bundle) return this.renameBundle(item.abs, item.bundle, name, opts);
    if (!item.dir) this.refuseLoneSidecar(item.abs, "rename");
    let next = this.places.nameOrDie(name);
    if (item.dir) this.refuseBundleName(next, "a folder");
    // A document keeps a document extension: "notes" renames notes.md to
    // notes.md, not to an extensionless file the workspace would stop showing.
    // An image keeps an image extension the same way, and above all never
    // takes a document's: `fox.png` renamed `fox.md` would be opened as text.
    if (!item.dir && isImageName(item.abs)) {
      if (!isImageName(next)) next += extname(item.abs);
    } else if (!item.dir && !isDocName(next)) next += extname(item.abs) || ".md";
    const to = join(dirname(item.abs), next);
    if (to === item.abs) return { path: to, from: item.abs };
    // A case-only rename on a case-insensitive disk finds "itself" existing.
    const caseOnly = to.toLowerCase() === item.abs.toLowerCase();
    if (!caseOnly) this.refuseExisting(to);
    // An image's description is renamed with it (`fox.png.md` to `wolf.png.md`),
    // or nothing is renamed.
    const sidecar = item.dir ? null : this.sidecarFileOf(item.abs);
    const sidecarTo = sidecar ? sidecarOf(to) : null;
    if (sidecarTo && !caseOnly) this.refuseExisting(sidecarTo);
    const pins = opts.links ? this.pinLinks(sidecar ? [item.abs, sidecar] : [item.abs]) : null;
    this.renameOrDie(item.abs, to);
    if (sidecar && sidecarTo) this.carrySidecar(item.abs, to, sidecar, sidecarTo);
    this.followMove(item.abs, to);
    if (sidecar && sidecarTo) this.followMove(sidecar, sidecarTo);
    const seeded = item.dir ? undefined : this.seedJson(item.abs, to);
    this.persist();
    const links = pins ? this.planRelink(pins, movedPairs(item.abs, to, sidecar, sidecarTo)) : null;
    return {
      path: to,
      from: item.abs,
      ...(seeded ? { seeded } : {}),
      ...(sidecarTo ? { sidecar: sidecarTo } : {}),
      ...(links ? { links: links.fixes, wiki: links.wiki } : {}),
    };
  }

  /**
   * Rename a bundle: its row's name is its title, so the name given becomes
   * both. "The dry well" renames `The well.canvasbundle` to `The dry
   * well.canvasbundle` and writes `"title": "The dry well"` into its
   * `info.json`, every other key kept. A name that already ends in the
   * extension names the folder exactly, and the title is its stem. Links that
   * point at the bundle or into it are found as for any rename.
   */
  private renameBundle(
    from: string,
    type: BundleType,
    name: string,
    opts: { links?: boolean; title?: string | null },
  ): ReturnType<WorkspaceSession["rename"]> {
    const given = this.places.nameOrDie(name);
    const exact = bundleTypeOf(given) === type;
    const folder = exact ? given : fitName(given, type.extension);
    if (!exact && bundleTypeOf(folder) !== type)
      throw new SessionError(`"${name}" is not a usable name for a ${type.label}`, 400);
    // The title is written only into an `info.json` that is there, a plain
    // file, and parses (`readBundleInfo`). One that is missing is not made by
    // a rename (the row shows the folder's name, which is the name given);
    // one that does not parse, or is a link, is left byte for byte as it was.
    const before = readBundleInfo(from);
    const titleFrom = typeof before?.title === "string" ? before.title : undefined;
    const titleTo =
      before === null
        ? titleFrom
        : opts.title === null
          ? undefined
          : (opts.title ?? (exact ? bundleStem(given) : given));
    const to = join(dirname(from), folder);
    const caseOnly = to !== from && to.toLowerCase() === from.toLowerCase();
    if (to !== from && !caseOnly) this.refuseExisting(to);
    const pins = opts.links && to !== from ? this.pinLinks([from]) : null;
    if (to !== from) {
      this.renameOrDie(from, to);
      this.writes.wroteBundle(to);
      this.followMove(from, to);
    }
    if (titleTo !== titleFrom) {
      this.writes.wroteBundle(to);
      this.places.world.writeFile(
        join(to, BUNDLE_INFO),
        writeBundleInfo(before, type, { title: titleTo }),
      );
      this.rescanAround(to);
      this.refreshListed(to);
    }
    this.persist();
    const links = pins ? this.planRelink(pins, [[from, to]]) : null;
    return {
      path: to,
      from,
      ...(titleTo !== titleFrom
        ? {
            title: {
              ...(titleFrom !== undefined ? { from: titleFrom } : {}),
              ...(titleTo !== undefined ? { to: titleTo } : {}),
            },
          }
        : {}),
      ...(links ? { links: links.fixes, wiki: links.wiki } : {}),
    };
  }

  /**
   * Refuse a name that would make a folder a bundle: a folder does not become
   * one by its name (its insides would vanish from the tree), and a bundle is
   * made with its own New.
   */
  private refuseBundleName(name: string, what: string): void {
    const type = bundleTypeOf(name);
    if (type)
      throw new SessionError(
        `"${name}" would make ${what} a ${type.label}: make a new ${type.label} instead`,
        400,
      );
  }

  /** Read a listed bundle's node again (its title changed), as a set's rescan does for one inside it. */
  private refreshListed(abs: string): void {
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

  /**
   * An empty document that a rename made JSON (the sidebar's "New document"
   * makes `Untitled.md`, which is then named `fresh.json`) starts as `{}`, as
   * `createDoc` would have made it, so its first Save is not refused for being
   * empty. A held, untouched copy follows; one with text of its own is left
   * alone, and so is any file that is not empty.
   */
  private seedJson(
    from: string,
    to: string,
  ): { doc: string; version: number; text: string } | null {
    if (docFormat(to) !== "json" || docFormat(from) === "json") return null;
    try {
      if (statSync(to).size !== 0) return null;
    } catch {
      return null;
    }
    const text = "{}\n";
    const d = this.core.m.docs.find((x) => x.original === to);
    if (d && this.activeText(d) !== "") return null;
    this.writes.writeOwned(to, text, this.places.world);
    if (!d) return null;
    this.edit(d.slug, d.active, text);
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    delete d.outsideHash;
    return { doc: d.slug, version: d.active, text };
  }

  // ── links that follow a rename or move (kit-rename-updates-references) ──
  //
  // Before a move, every markdown link and embed in the session's documents
  // that lands on the moved thing (or inside it), or is written inside it, is
  // pinned with where it landed. After the move each pin is resolved again from
  // where its document is now; one that no longer lands where its target went
  // is broken by the move, and is offered rewritten as the link picker writes
  // it. Wiki links name a page, not a path, and are left alone.

  /** Every path link that a move of `moved` could break, with where it lands now. */
  private pinLinks(moved: readonly string[]): LinkPin[] {
    const under = (p: string) => moved.some((m) => p === m || p.startsWith(m + sep));
    const index = this.places.contextIndex();
    const entryOf = this.readIndex.entryFinder(index);
    const read = new Set<string>();
    const pins: LinkPin[] = [];
    for (const c of this.readIndex.markdownCandidates()) {
      const inside = under(c.path);
      for (const l of this.readIndex.linksOf(c, read)) {
        if (l.scheme !== undefined) continue;
        const r = this.linkResolve.resolveFrom(
          l.raw,
          c.path,
          entryOf(c.path),
          "document",
          index,
          l.kind,
        );
        if (r.state === "missing" || (!inside && !under(r.path))) continue;
        pins.push({
          kind: l.kind,
          src: c.path,
          raw: l.raw,
          target: r.path,
          line: l.line,
          ...(l.label !== undefined ? { label: l.label } : {}),
          ...(l.embed ? { embed: true as const } : {}),
        });
      }
    }
    // A bundle's references (a board's cards) that land on the moved thing,
    // or are written inside it, pinned the same way.
    for (const c of this.readIndex.referenceCandidates()) {
      const inside = under(c.path);
      for (const ref of this.readIndex.readOf(c, read)?.refs ?? []) {
        const r = this.readIndex.resolveReference(ref.raw, c.path, entryOf(c.path), index);
        if (r.state === "missing" || (!inside && !under(r.path))) continue;
        pins.push({
          kind: "reference",
          src: c.path,
          raw: ref.raw,
          target: r.path,
          line: ref.line,
          id: ref.id,
          ...(ref.label !== undefined ? { label: ref.label } : {}),
        });
      }
    }
    return pins;
  }

  /**
   * The pinned links the move broke, by the document they are in (`path`
   * where it is now, `was` where it was), each with the target that lands
   * where its old one went. `pairs` are the moves made: the item, and an
   * image's description beside it.
   */
  private planRelink(
    pins: readonly LinkPin[],
    pairs: readonly (readonly [string, string])[],
    /**
     * Plan only (`movePlan`): the move has not happened, and links are
     * resolved in this world after it. A bundle's references are skipped
     * here: the caller counts them.
     */
    world?: PlanWorld,
  ): { fixes: DocLinkFixes[]; wiki: WikiBreak[] } {
    const wiki: WikiBreak[] = [];
    if (pins.length === 0) return { fixes: [], wiki };
    const map = (p: string): string => {
      for (const [a, b] of pairs) {
        if (p === a) return b;
        if (p.startsWith(a + sep)) return b + p.slice(a.length);
      }
      return p;
    };
    const index = this.places.contextIndex();
    const entryOf = this.readIndex.entryFinder(index);
    const byDoc = new Map<string, DocLinkFixes>();
    // One verdict per document and target as written: the same text in the
    // same document always lands in the same place.
    const verdicts = new Map<string, string | null>();
    for (const pin of pins) {
      if (world && pin.kind === "reference") continue;
      const src = map(pin.src);
      const to = map(pin.target);
      const key = `${src}\0${pin.kind}\0${pin.raw}`;
      const entry = world ? this.entryAfter(src, world, entryOf) : entryOf(src);
      const rb = pin.kind === "reference" ? referencingBundle(src) : null;
      const lands = (raw: string) => {
        const r =
          pin.kind === "reference"
            ? this.readIndex.resolveReference(raw, src, entry, index)
            : this.linkResolve.resolveFrom(raw, src, entry, "document", index, pin.kind, world);
        return r.state !== "missing" && r.path === to;
      };
      // A wiki link names a page, not a path: one the move broke is counted
      // and named, and never rewritten.
      if (pin.kind === "wiki") {
        if (!lands(pin.raw)) wiki.push({ path: src, line: pin.line, raw: pin.raw });
        continue;
      }
      let next = verdicts.get(key);
      if (next === undefined) {
        if (lands(pin.raw)) next = null;
        else if (pin.kind === "reference") {
          // Written by the bundle's type, to a bundle's folder rather than its
          // main file, as a card names a board.
          const tb = bundleOf(to);
          const dest = tb && tb.inner === tb.type.main ? tb.root : to;
          const written =
            rb?.references.write(dest, this.readIndex.placeOf(src, rb.root, entry)) ?? null;
          next = written !== null && lands(written) ? written : null;
        } else {
          const written = retarget(pin.raw, src, to, entry?.root ?? null);
          // Offered only when it is sure to land: anything else is left for the link check.
          next = lands(written) ? written : null;
        }
        verdicts.set(key, next);
      }
      if (next === null) continue;
      let doc = byDoc.get(src);
      if (!doc) {
        doc = { path: src, was: pin.src, fixes: [], ...(rb ? { noun: rb.references.noun } : {}) };
        byDoc.set(src, doc);
      }
      doc.fixes.push({
        line: pin.line,
        ...(pin.label !== undefined ? { label: pin.label } : {}),
        ...(pin.embed ? { embed: true as const } : {}),
        ...(pin.id !== undefined ? { id: pin.id } : {}),
        from: pin.raw,
        to: next,
      });
    }
    return { fixes: [...byDoc.values()], wiki };
  }

  /**
   * The text of a document at `src` as a COPY of it at `dest` must read so
   * that its links keep resolving (`rebaseCopy`): for an app that copies a
   * document elsewhere, as Sound Stage copies one onto a stage. A leading `/`
   * means the root of the context entry that holds `src`, as it does for any
   * link; `copies` maps the other originals copied in the same act to their
   * copies, so links among them follow. Text in, text out: nothing is
   * written, and the caller writes the copy.
   */
  rebaseCopy(
    text: string,
    src: string,
    dest: string,
    copies?: ReadonlyMap<string, string>,
  ): { text: string; count: number } {
    const holders = this.core.m.context.filter((e) => src.startsWith(e.root + sep));
    const root = holders.sort((a, b) => b.root.length - a.root.length)[0]?.root ?? null;
    const stat = (p: string) => {
      try {
        return statSync(p);
      } catch {
        return null;
      }
    };
    return rebaseCopy(text, src, dest, {
      root,
      exists: (p) => stat(p)?.isFile() === true,
      isDir: (p) => stat(p)?.isDirectory() === true,
      ...(copies ? { copies } : {}),
    });
  }

  /**
   * Rewrite link targets in documents: in each document at `path`, every
   * markdown link or embed written exactly as a swap's `from` is written as
   * its `to`. Label, `?rel=`, anchor and `!` are kept (`retarget` built `to`
   * with them).
   *
   * ⛔ THE SAVE RULE, AND HOW THIS KEEPS IT. A document's text reaches its file
   * only by Save; this is not a document's text but a structure act's tail,
   * like the rename it follows, and it writes the world folder directly:
   *
   * - a document the session does not hold: its file;
   * - a document it holds: its file (the ORIGINAL's text, rewritten, never the
   *   active version's) AND its active version, the same links rewritten in
   *   both. Unsaved edits stay in the active version and stay unsaved; a clean
   *   document stays clean. Save later writes the user's text with the new
   *   links, so it cannot put the old ones back. Other versions are left as
   *   they were written.
   * - a held document whose file changed outside the session, or is gone, is
   *   skipped and named: the outside-change banner is the user's to answer
   *   first. The file is hashed here, not only the flag read: an outside write
   *   the watcher has not reported yet would otherwise be folded into the
   *   rewrite, the watcher would then find "our own" hash and say nothing, and
   *   the next Save would lose it. Such a change is classified exactly as the
   *   watcher would (`onFileEvent`), its event returned in `events` for the
   *   daemon to announce: a clean document reloads and is then rewritten, a
   *   dirty one is marked changed and skipped.
   *
   * A bundle's main file whose type reads references (a board) has its
   * references swapped by its type, never as markdown.
   *
   * A held document that `opts.held` takes (an app holding the document's
   * text in memory, as Atlas holds an open board; it answers undefined for
   * any other) has its active version changed by the app, through the app's
   * own changes, never written under it here; the kit writes the file as
   * above, and only once the app has said how many it changed. A
   * `SessionError` from `held` leaves the document as it was, named in
   * `skipped` with the reason.
   */
  rewriteLinks(
    edits: readonly { path: string; swaps: readonly (readonly [string, string])[] }[],
    opts: {
      held?: (doc: string, swaps: readonly (readonly [string, string])[]) => number | undefined;
    } = {},
  ): {
    docs: { path: string; count: number; noun?: string }[];
    count: number;
    /** Active versions rewritten, for an open editor to follow. */
    texts: { doc: string; version: number; text: string; was: string }[];
    skipped: { path: string; reason: string }[];
    /** Outside changes found on the way, as the watcher would have reported them. */
    events: FileEvent[];
  } {
    const events: FileEvent[] = [];
    const docs: { path: string; count: number; noun?: string }[] = [];
    const texts: { doc: string; version: number; text: string; was: string }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let total = 0;
    for (const edit of edits) {
      const swaps = new Map(edit.swaps);
      const swap = (raw: string) => swaps.get(raw);
      const rb = referencingBundle(edit.path);
      const swapIn = (text: string) =>
        rb ? rb.references.swap(text, swap) : swapLinkTargets(text, swap);
      const noun = rb ? { noun: rb.references.noun } : {};
      // ⛔ A document among the sessions or in the app home (one a set shows
      // only because it shows them) is never rewritten: named, and left.
      const refused = this.places.world.refusal(edit.path);
      if (refused !== null) {
        skipped.push({ path: edit.path, reason: refused });
        continue;
      }
      const read = (p: string): string | null => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return null;
        }
      };
      const d = this.core.m.docs.find((x) => x.original === edit.path);
      if (d) {
        if (!d.missing && !d.outsideChanged) {
          const now = read(d.original);
          if (now === null || contentHash(now) !== d.originalHash) {
            const ev = now === null ? this.markMissing(d) : this.onFileEvent(d.original);
            if (ev) events.push(ev);
          }
        }
        if (d.missing || d.outsideChanged) {
          skipped.push({
            path: edit.path,
            reason: d.missing
              ? "its file is gone from disk"
              : "its file changed outside the session: answer that first",
          });
          continue;
        }
        const file = read(d.original);
        if (file === null) {
          skipped.push({ path: edit.path, reason: "its file could not be read" });
          continue;
        }
        const onDisk = swapIn(file);
        // An app that holds the document's text changes it itself, first: if
        // it cannot, nothing is written.
        let heldCount: number | undefined;
        if (opts.held)
          try {
            heldCount = opts.held(d.slug, edit.swaps);
          } catch (e) {
            if (!(e instanceof SessionError)) throw e;
            skipped.push({ path: edit.path, reason: e.message });
            continue;
          }
        if (onDisk.count > 0) {
          // Before the write, so the watcher finds its own write already known.
          d.originalHash = contentHash(onDisk.text);
          this.writes.writeOwned(d.original, onDisk.text, this.places.world);
        }
        let activeCount = heldCount ?? 0;
        if (heldCount === undefined) {
          const was = this.activeText(d);
          const active = swapIn(was);
          activeCount = active.count;
          if (active.count > 0) {
            this.writeActive(d, active.text);
            texts.push({ doc: d.slug, version: d.active, text: active.text, was });
          }
        }
        const n = Math.max(onDisk.count, activeCount);
        if (n > 0) docs.push({ path: edit.path, count: n, ...noun });
        total += n;
        continue;
      }
      const text = read(edit.path);
      if (text === null) {
        skipped.push({ path: edit.path, reason: "its file could not be read" });
        continue;
      }
      const out = swapIn(text);
      if (out.count === 0) continue;
      this.places.world.writeFile(edit.path, out.text);
      docs.push({ path: edit.path, count: out.count, ...noun });
      total += out.count;
    }
    if (texts.length > 0 || docs.length > 0) this.persist();
    return { docs, count: total, texts, skipped, events };
  }

  private renameOrDie(from: string, to: string): void {
    this.places.notOwnSourceOrDie(from);
    this.places.notOwnPlaceOrDie(to);
    try {
      this.places.world.rename(from, to);
    } catch (e) {
      if (e instanceof SessionError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      throw new SessionError(
        code === "EXDEV"
          ? `cannot move ${from} to another disk (${to}): copy it instead`
          : `cannot move ${from} to ${to}: ${code ?? String(e)}`,
        409,
      );
    }
  }

  /**
   * Remove something this session created (undo of a creation).
   *
   * A non-empty directory is refused, and no dialog can authorise it. Undo works
   * backwards, so it empties a folder before it reaches that folder's creation;
   * if the folder still has contents then something put them there that the
   * history does not know about, and removing a directory tree is a different
   * act from removing the empty thing you just made.
   *
   * It also refuses anything that is not where the history said it was: a path
   * that has become a directory, or a directory that has become a file, means
   * the world moved and the recorded inverse no longer describes it.
   */
  removeCreated(rawPath: string, dir: boolean): { path: string; removed: boolean } {
    const abs = this.places.notOwnSourceOrDie(resolve(rawPath));
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      // Already gone: the undo has nothing to do, which is not an error.
      return { path: abs, removed: false };
    }
    if (st.isDirectory() !== dir)
      throw new SessionError(
        `${this.display(abs)} is ${st.isDirectory() ? "a folder" : "a file"} now: the change this would undo no longer describes it`,
        409,
      );
    if (dir) {
      const left = readdirSync(abs);
      if (left.length > 0)
        throw new SessionError(
          `${this.display(abs)} is not empty (${left.length} item${left.length === 1 ? "" : "s"}): move what is inside it out first`,
          409,
          left.slice(0, 10),
        );
      // `rmdir` rather than a recursive remove on purpose: it throws
      // ENOTEMPTY, a second net under the emptiness check above. A recursive
      // delete would make the bug it prevents unrecoverable rather than loud.
      this.places.world.rmdir(abs);
    } else {
      this.places.world.unlink(abs);
    }
    this.forgetPath(abs);
    return { path: abs, removed: true };
  }

  /**
   * Forget a path that is no longer on disk: prune it from every context entry,
   * drop the entry if that empties it, and forget any document record for it.
   *
   * `rescan` is not enough: it returns early for any entry whose membership is
   * not `mirrored`, and a single document is a `listed` entry, so deleting one
   * would leave its node in the sidebar forever. The document record would also
   * outlive the file, keeping its slug taken, so the next `Untitled.md` would
   * become `untitled-2` while the file on disk was plain `Untitled.md`.
   *
   * The version files under the session folder are left where they are. The
   * record is gone, so nothing reads them, and removing them would be a second
   * deletion the human was never asked about.
   */
  private forgetPath(abs: string): void {
    const inside = (p: string) => p === abs || p.startsWith(abs + sep);
    for (const e of [...this.core.m.context]) {
      if (e.membership === "mirrored" && !inside(e.root)) {
        this.rescan(e.id);
        continue;
      }
      // A `listed` entry (or a mirrored one that was the deleted folder): prune
      // the nodes by hand, since `rescan` will not look at it.
      const prune = (nodes: ContextNode[]): ContextNode[] =>
        nodes
          .filter((n) => !inside(join(e.root, n.rel)))
          .map((n) => (n.kind === "group" ? { ...n, children: prune(n.children) } : n));
      e.nodes = prune(e.nodes);
      if (e.nodes.length === 0 || inside(e.root)) this.removeContext(e.id);
    }
    this.core.m.docs = this.core.m.docs.filter((d) => !inside(d.original));
    if (this.core.m.openImage && inside(this.core.m.openImage)) this.core.m.openImage = null;
    if (this.core.m.openDoc && !this.core.m.docs.some((d) => d.slug === this.core.m.openDoc))
      this.core.m.openDoc = this.core.m.docs[0]?.slug ?? null;
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
  }

  // ── set promotion, and a folder where the caller names ───────────────────

  /**
   * A document listed on its own becomes a set: a folder named for it beside
   * it (the next free name: `solo`, else `solo 2`), the document moved in, and
   * the SAME entry, by id, now mirroring that folder. What is keyed by the
   * document's slug (its versions, notes, a chat reference's `doc`) and by
   * the entry's id follows, as it does a move.
   *
   * Refused (400) for anything else: a document already in a set ("make a
   * folder there instead"), a set's own folder, an image, a bundle.
   * `opts.links`: the links the move broke, as `move` finds them; nothing is
   * rewritten.
   */
  makeSet(
    rawPath: string,
    opts: { links?: boolean } = {},
  ): {
    path: string;
    from: string;
    folder: string;
    entry: string;
    links?: DocLinkFixes[];
    wiki?: WikiBreak[];
  } {
    const item = this.places.itemOrDie(rawPath);
    const e = item.entry;
    if (e.membership !== "listed" || !item.whole)
      throw new SessionError(
        `${this.display(item.abs)} is already in a set: make a folder there instead`,
        400,
      );
    if (listedFile(e)?.kind !== "doc")
      throw new SessionError(
        `${this.display(item.abs)} is not a document: only a document listed on its own becomes a set`,
        400,
      );
    const parent = dirname(item.abs);
    const stem = basename(item.abs, extname(item.abs)) || "Untitled";
    const name = this.freeName(parent, stem, true);
    this.refuseBundleName(name, "the set's folder");
    const folder = join(parent, name);
    const to = join(folder, basename(item.abs));
    // The one set guard, and the backstop: never a set among the sessions.
    this.places.notOwnSourceOrDie(item.abs);
    this.places.mayBeASetOrDie(folder);
    const pins = opts.links ? this.pinLinks([item.abs]) : null;
    try {
      this.places.world.mkdir(folder);
    } catch (err) {
      if (err instanceof SessionError) throw err;
      throw new SessionError(
        `cannot make the folder ${tilde(folder)}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
        409,
      );
    }
    try {
      this.renameOrDie(item.abs, to);
    } catch (err) {
      // Nothing moved: the folder made for it goes, so a refusal changes nothing.
      try {
        this.places.world.rmdir(folder);
      } catch {
        /* left empty: a later rescan shows it, nothing is lost */
      }
      throw err;
    }
    // The entry switches BEFORE the model follows the move: a listed entry
    // would otherwise follow its document to the new folder as a listed one.
    e.membership = "mirrored";
    e.root = folder;
    e.realRoot = realOr(folder);
    e.label = basename(folder);
    e.nodes = [];
    delete e.truncated;
    this.followMove(item.abs, to);
    this.persist();
    const links = pins ? this.planRelink(pins, movedPairs(item.abs, to, null, null)) : null;
    return {
      path: to,
      from: item.abs,
      folder,
      entry: e.id,
      ...(links ? { links: links.fixes, wiki: links.wiki } : {}),
    };
  }

  /**
   * The way back from `makeSet`: the document at `rawPath`, alone in a set's
   * own folder, goes back up beside that folder, the folder (now empty) is
   * removed, and the same entry lists the document again. Refuses before it
   * changes anything: a folder that is no set's now (`GoneError`: it can never
   * apply again), one that holds anything else, a name taken beside it.
   */
  unmakeSet(rawPath: string): { path: string; from: string; folder: string; entry: string } {
    const abs = this.places.contextForm(resolve(rawPath));
    const folder = dirname(abs);
    const e = this.core.m.context.find((x) => x.membership === "mirrored" && x.root === folder);
    let left: string[] | null = null;
    try {
      left = statSync(abs).isFile() ? readdirSync(folder) : null;
    } catch {
      left = null;
    }
    if (!e || left === null)
      throw new GoneError(
        `${tilde(abs)} is no longer a document in a set of its own: it cannot be turned back`,
        409,
      );
    if (left.length !== 1)
      throw new SessionError(
        `${this.display(folder)} holds more than ${basename(abs)} now (${left.length} items): move the rest out first`,
        409,
        left.slice(0, 10),
      );
    const to = join(dirname(folder), basename(abs));
    this.places.mayBeASetOrDie(to, true);
    this.refuseExisting(to);
    this.renameOrDie(abs, to);
    try {
      this.places.world.rmdir(folder);
    } catch {
      /* not empty after all, or gone: the document is out either way */
    }
    e.membership = "listed";
    e.root = dirname(to);
    e.realRoot = realOr(e.root);
    e.label = basename(to);
    e.nodes = [docNode(basename(to), to)];
    delete e.truncated;
    this.followMove(abs, to);
    this.persist();
    return { path: to, from: abs, folder, entry: e.id };
  }

  /**
   * A new, empty folder at `rawPath`, a full path the caller names. Where a
   * set shows folders (a set, a folder in one, a bundle's member folder) it is
   * a folder there, as `createFolder` makes one. Anywhere else on disk whose
   * parent folder exists, it is added to the context as a set of its own: a
   * new entry. Never inside a bundle, never over anything that exists, never
   * among the app's sessions.
   */
  addFolder(rawPath: string): { path: string; entry: string; set: boolean } {
    // Named by where its parent folder really is: the folder itself does not
    // exist yet, so a link on the way there is followed through the parent.
    const raw = resolve(rawPath);
    const name = basename(raw);
    const abs = join(this.places.contextForm(dirname(raw)), name);
    // Never among the sessions or in the app home, even where a set shows it.
    this.places.notOwnPlaceOrDie(raw, 400);
    this.places.notOwnPlaceOrDie(abs, 400);
    if (this.places.nameOrDie(name) !== name)
      throw new SessionError(`"${name}" is not a usable name: no space at either end`, 400);
    this.refuseBundleName(name, "a new folder");
    const parent = dirname(abs);
    let shown = false;
    try {
      this.places.destinationOrDie(parent);
      shown = true;
    } catch (err) {
      // Inside a set but not where it shows folders (a hidden one, a bundle's
      // own files): refused as `new-folder` refuses it.
      if (this.places.coveringEntry(parent) || !(err instanceof SessionError) || err.status !== 400)
        throw err;
    }
    if (!shown) {
      // Where it would really be: its parent's realpath and its name, since a
      // path that does not exist yet has no realpath of its own.
      const real = join(realOr(parent), name);
      const inBundle = bundleOf(abs) ?? bundleOf(real);
      if (inBundle)
        throw new SessionError(
          `${tilde(abs)} is inside the ${inBundle.type.label} ${bundleNameAt(inBundle.root)}: ${outsideMembers(inBundle.type)}`,
          409,
        );
      const sessions = dirname(this.dir);
      const realSessions = realOr(sessions);
      const among = (p: string, root: string) => p === root || p.startsWith(root + sep);
      if (among(abs, sessions) || among(real, realSessions))
        throw new SessionError(`${tilde(abs)} is among the sessions' own folders`, 400);
      this.places.mayBeASetOrDie(abs);
      let isDir = false;
      try {
        isDir = statSync(parent).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir)
        throw new SessionError(
          `${tilde(parent)} is not a folder on disk: name a place whose folder exists`,
          400,
        );
    }
    this.refuseExisting(abs);
    try {
      this.places.world.mkdir(abs);
    } catch (err) {
      if (err instanceof SessionError) throw err;
      throw new SessionError(
        `cannot make the folder ${tilde(abs)}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`,
        409,
      );
    }
    this.adoptNew(abs);
    this.persist();
    // The entry that shows it: a set (its own, when it made one), or a bundle
    // listed on its own whose member folder it was made in.
    const e =
      this.places.coveringEntry(abs) ??
      this.core.m.context.find((x) => {
        const only = listedFile(x);
        return only?.kind === "bundle" && abs.startsWith(only.abs + sep);
      });
    return { path: abs, entry: e?.id ?? "", set: e?.root === abs };
  }

  /** The most text one import carries: a document, not a data dump. */
  static readonly IMPORT_MAX_BYTES = 8 * 1024 * 1024;

  /**
   * A dropped file: a copy of its text, written under a free name into the
   * workspace folder (or `into`: a set the drop landed on), then shown like any
   * other document. A drop never replaces a file already there.
   */
  importText(name: string, text: string, into?: string): { path: string } {
    const file = this.places.nameOrDie(name);
    if (!isDocName(file))
      throw new SessionError(
        `not a document the workspace opens (${docExtensions().join(" ")}): ${file}`,
        400,
        docExtensions(),
        "a folder cannot be dropped: add it with the file picker, or `add <folder>`",
      );
    if (Buffer.byteLength(text) > WorkspaceSession.IMPORT_MAX_BYTES)
      throw new SessionError(
        `${file} is larger than ${WorkspaceSession.IMPORT_MAX_BYTES / 1024 / 1024} MB: not imported`,
        400,
      );
    const dir = into ? this.places.destinationOrDie(into) : this.places.workspaceOrDie();
    const abs = join(dir, this.freeName(dir, file, false));
    this.places.world.writeFile(abs, text, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  // ── chat ───────────────────────────────────────────────────────────────

  addMessage(input: Parameters<Chats["addMessage"]>[0]): Message {
    return this.chats.addMessage(input);
  }

  /** The conversation, without building a snapshot around it. */
  messages(): readonly Message[] {
    return this.chats.messages();
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  /**
   * One list, three creators. A task starts `open` (or `running`, when its
   * creator is already on it) and only ever moves along `TASK_NEXT`.
   */
  createTask(input: NewTask): Task {
    return this.taskList.createTask(input);
  }

  task(id: string): Task {
    return this.taskList.task(id);
  }

  /**
   * Move a task along its transitions. Idempotent on purpose: a task finished
   * twice (an agent retrying, a human clicking as the agent reports) is not an
   * error, and refusing would make the surface handle a race it did not cause.
   * An illegal move (done to running, cancelled to done) is a conflict.
   */
  transitionTask(
    id: string,
    to: TaskStatus,
    patch: { detail?: string; outcome?: string } = {},
  ): { task: Task; from: TaskStatus; changed: boolean } {
    return this.taskList.transitionTask(id, to, patch);
  }

  /**
   * Set a task's detail without persisting: it rides progress reports, which are
   * runtime, and is written with the next status change.
   */
  setTaskDetail(id: string, detail: string): Task {
    return this.taskList.setTaskDetail(id, detail);
  }

  /** Forget a finished task: one started by mistake, or no longer worth listing. */
  removeTask(id: string): Task {
    return this.taskList.removeTask(id);
  }

  /** Forget every finished task. Outstanding ones are untouched. */
  clearFinishedTasks(): number {
    return this.taskList.clearFinishedTasks();
  }

  /** Newest first: a queue is read from the top. */
  tasks(): Task[] {
    return this.taskList.tasks();
  }

  // ── views ──────────────────────────────────────────────────────────────

  docView(d: Doc): DocView {
    let hash = "";
    try {
      hash = contentHash(readFileSync(this.core.versionPath(d, d.active), "utf8"));
    } catch {
      hash = "";
    }
    const alias = this.docAlias(d);
    return {
      slug: d.slug,
      ...(alias !== undefined ? { alias } : {}),
      // A bundle's main file is shown as its bundle: by its title, never as
      // the name every main file of its type shares.
      name: this.docName(d),
      original: d.original,
      entryId: d.entryId,
      rel: d.rel,
      ext: d.ext,
      versions: d.versions.map((v) => ({ ...v, path: this.core.versionPath(d, v.n) })),
      active: d.active,
      hash,
      dirty: !d.missing && this.isDirty(d),
      outsideChanged: d.outsideChanged,
      ...(d.outsideChanged && d.outsideHash ? { outsideHash: d.outsideHash } : {}),
      ...(d.missing ? { missing: existsSync(dirname(d.original)) ? "file" : "folder" } : {}),
      notes: this.placedNotes(d),
    };
  }

  /** `takesPath`: as `docOrDie`'s, for a verb that takes an absolute path (`show`). */
  doc(slug: string, opts: { takesPath?: boolean } = {}): DocView {
    return this.docView(this.docOrDie(slug, opts));
  }

  /**
   * Search the context: fuzzy on names, exact in text. A document the session
   * holds is read as its ACTIVE VERSION, which lives under the session folder and
   * not at the original path, so an edit made a minute ago is found and `grep`
   * over the workspace would miss it. A document not yet opened is read from disk.
   */
  search(opts: { query: string; limit?: number }): SearchReport {
    return this.searchPart.search(opts);
  }

  /**
   * `search` for several queries in one pass: each document's text is read
   * once, however many queries there are, and each query gets its own report,
   * as `search` would give it. For a caller that asks about several words at
   * once (Atlas's impact check), where a search per word would read the whole
   * context once per word.
   */
  searchEach(opts: { queries: readonly string[]; limit?: number }): SearchReport[] {
    return this.searchPart.searchEach(opts);
  }

  /**
   * The link picker's second step: the headings of the document at `path`,
   * each with the anchor a link writes for it (`anchorFor`: the heading's
   * text, or the path of headings that names a repeat alone), encoded. Only a
   * document in the context is read; anything else has no headings to offer.
   */
  linkHeadings(slug: string, path: string): LinkHeadings {
    return this.linkResolve.linkHeadings(slug, path);
  }

  /**
   * What a link written in document `slug` can point at: every OTHER document in
   * the session, each with the relative target to write, and the `?rel=` values
   * the session's documents already use (read as search reads them, so a
   * relation typed a minute ago is offered). It only reads; the link is typed
   * into the editor by the human like any other text.
   */
  linkTargets(slug: string): LinkTargets {
    return this.linkResolve.linkTargets(slug);
  }

  /**
   * The relations in force at `path` (a file or folder in the context, read as
   * a document there would be: its folder's vocabulary, the nearest file
   * winning per relation), offered as the link picker offers them, with how
   * the world's typed links use each relation between each pair of kinds, and
   * the nearest vocabulary file. For an app that types something between two
   * documents other than a link in one. It only reads.
   */
  relationsAt(path: string): RelationsAt {
    return this.relationsPart.relationsAt(path);
  }

  /**
   * The world's relation vocabulary and how its links use it: every vocabulary
   * file (broken ones with why), each declared relation with the links using it
   * where its definition is the one in force, the relations used where a
   * vocabulary is in force but does not declare them, and every relation in
   * use. It only reads. The `relations` verb answers from here.
   */
  relations(): RelationsReport {
    return this.relationsPart.relations();
  }

  /**
   * Where a link written in document `from` (a slug, or null for a link in the
   * chat with no document open) goes. See `links.ts` for what the root and "in
   * the session" mean here. It only resolves: the caller opens an `in-context`
   * target, and nothing is ever added to the context.
   */
  resolveLink(target: string, from: string | null, origin: LinkOrigin = "document"): Resolution {
    return this.linkResolve.resolveLink(target, from, origin);
  }

  /**
   * What sidebar rows dropped onto document `slug` write there
   * (kit-tree-drag-into-document): `DroppedLink` says the shape. An image the
   * tree shows is embedded, and a document is linked; a folder, an image's
   * description and the document itself write nothing. Only what lies under the
   * root of the document's own context entry is written: anything in another
   * set is refused rather than linked by a path that leaves the set, which
   * would break when either moves. Reads no image's bytes; a sidecar's title is
   * read as the viewer reads it. Link text is one line, its whitespace
   * collapsed, so a multi-line title cannot split the link.
   */
  droppedLinks(slug: string, paths: readonly string[]): DroppedLink[] {
    return this.linkResolve.droppedLinks(slug, paths);
  }

  /**
   * What each embed (`![alt](target)`) written in document `slug` shows, for
   * the rendered view: the image, when the target lands on one the tree shows
   * and the file route would serve it (the same guard, so a page saved as
   * `x.png` or a link out of the set is refused here, not drawn broken), or the
   * reason it is not, in words. Resolved exactly as a link from that document
   * is (relative to it, `?rel=` stripped). A remote image is never fetched and
   * an SVG is never served. Reads no image's bytes beyond the first few the
   * guard sniffs; distinct targets only, at most EMBED_CAP.
   */
  embeds(slug: string, targets: readonly string[]): EmbedView[] {
    return this.linkResolve.embeds(slug, targets);
  }

  /**
   * The world's profiles: each usable profile file with the documents it is
   * the nearest for, the `type` values no profile defines, the documents with no
   * `type`, the documents whose frontmatter does not parse, and the broken files
   * with why. It only reads.
   */
  profiles(): ProfilesReport {
    return this.profilesPart.profiles();
  }

  /**
   * How one document matched a profile: its kind, the profile's label and the
   * file it came from, its warnings, and what the profile expects field by
   * field; when nothing matched, why. `key` is a slug or a held document's name
   * (the open document when absent), or the absolute path of any document in
   * the context. It only reads. The header chip and the map read a document's
   * profile from here.
   */
  documentProfile(key?: string): DocumentProfile {
    return this.profilesPart.documentProfile(key);
  }

  /**
   * Every profile warning in the session, each with its document, field, rule
   * and a fix in words, and every broken profile file with why: shaped like the
   * link check. A document lists at most PROFILE_WARNINGS_PER_DOC warnings
   * (`more` counts the rest), so one document cannot fill the list, and the
   * list is cut at PROFILE_CHECK_CAP; `count` is always the whole. It only
   * reads; a warning never blocks a save.
   */
  profileCheck(): ProfileCheck {
    return this.profilesPart.profileCheck();
  }

  /** Where `path` is now, after the moves this daemon made, in order. */
  private movedTo(path: string): string {
    let p = path;
    for (const [from, to] of this.moves)
      if (p === from) p = to;
      else if (p.startsWith(from + sep)) p = to + p.slice(from.length);
    return p;
  }

  /** Where `path` was before the moves this daemon made: `movedTo` run back. */
  private movedFrom(path: string): string {
    let p = path;
    for (let i = this.moves.length - 1; i >= 0; i--) {
      const [from, to] = this.moves[i] as [string, string];
      if (p === to) p = from;
      else if (p.startsWith(to + sep)) p = from + p.slice(to.length);
    }
    return p;
  }

  /**
   * A broken link's target as a move left it: each place the link was looked
   * for (`tried`, and the same places from where its document was, `wasAt`),
   * followed through the moves this daemon made; the first that moved (or
   * whose document did) and lands, rewritten from where the document is now
   * as relink writes it. Undefined when no move explains it: no guess.
   */
  private movedTarget(
    raw: string,
    src: string,
    wasAt: string,
    tried: readonly string[],
    entry: ContextEntry | undefined,
    index: ContextIndex,
  ): string | undefined {
    if (this.moves.length === 0) return undefined;
    // Every place in `tried` is missing, so one that exists once followed
    // through the moves is one a move explains. From where the document was,
    // the same places (a relative link only) explain a move of the document.
    const looked = [...tried];
    if (wasAt !== src && !raw.startsWith("/"))
      for (const t of tried) looked.push(join(dirname(wasAt), relative(dirname(src), t)));
    for (const at of looked) {
      const now = this.movedTo(at);
      if (!existsSync(now)) continue;
      const written = retarget(raw, src, now, entry?.root ?? null);
      // ⛔ Offered only when it is sure to land, as relink's own offer is,
      // and lands as what it named: a link to a file never lands on a folder
      // (a file moved away and a folder made in its place).
      const r = this.linkResolve.resolveFrom(written, src, entry, "document", index, "markdown");
      const folderLink = splitTarget(raw).path.endsWith("/");
      if (r.state !== "missing" && (folderLink || r.state !== "folder")) return written;
    }
    return undefined;
  }

  /**
   * The link check: every link in the session's documents that nothing answers,
   * links whose scheme nothing here opens (Operator's `op:doc/…`) kept apart,
   * and documents whose file names collide, each with a suggested rename. It
   * only reads; a dangling link is reported, never an error, and nothing is
   * renamed.
   *
   * The documents read are the ones search and backlinks read (`candidates`),
   * through the same per-file link cache and one context index, so a second
   * check after an edit re-reads only the document that changed.
   */
  linkCheck(opts: { edge?: readonly string[] } = {}): LinkCheck {
    return this.linkCheckPart.linkCheck(opts);
  }

  /**
   * Of `paths`, the ones that are documents in the session's context, each in
   * the context's own form, by the rule `linkSubject` uses: absolute, the same
   * file by realpath, and listed by a context entry. A path that only looks
   * like one (`/etc/passwd`, a `..` that climbs out) is dropped. For what a page
   * says it points at, which the agent then reads.
   */
  contextDocs(paths: readonly unknown[]): string[] {
    return this.linkResolve.contextDocs(paths);
  }

  /**
   * Each path as `contextDocs` keeps it, in place: canonical when it is a
   * document or an image the tree shows, undefined when it is not. The
   * context's index is built once for the whole list (a message's refs).
   */
  contextDocEach(paths: readonly unknown[]): (string | undefined)[] {
    return this.linkResolve.contextDocEach(paths);
  }

  /**
   * The link graph: the session's documents and the typed links between them,
   * filtered by focus, hops, relation, kind and folder, then cut at GRAPH_CAP (or
   * `limit`) by degree, so a hub survives a cut a leaf does not (see `linkGraph`
   * in `links.ts`). It only reads.
   *
   * The documents read are the ones search, backlinks and the link check read
   * (`candidates`), through the same per-file cache and one context index, so a
   * second ask after an edit re-reads only the document that changed. A kind is
   * `kindOf`'s answer.
   */
  linkGraph(opts: GraphOptions = {}): LinkGraph {
    return this.linkReports.linkGraph(opts);
  }

  /**
   * What links to a document: every link, in the session's other documents,
   * that lands on it when followed from where it is written. `key` is a slug or
   * a held document's name (the open document when absent), or the absolute
   * path of any document in the context, held or not, so the agent can ask about
   * one the human has not opened. It only reads.
   *
   * The documents read are the ones search reads (`candidates`), bounded the
   * same way; the answer carries at most BACKLINK_CAP links and says when it was
   * cut. Each document's links come from `linksOf`'s cache, so asking again
   * after an edit re-reads only the document that changed.
   */
  backlinks(key?: string, opts: { edge?: readonly string[] } = {}): Backlinks {
    return this.linkReports.backlinks(key, opts);
  }

  /**
   * Each of `paths` that is a markdown document in the session, as a report
   * names it: its path, name, title, and its kind, label and canon as the
   * profiles say (`kindView`, the one place that is decided). Paths that are
   * not documents here are dropped. One profile pass, and each document's facts
   * from the link cache, so asking about many costs one read each at most. It
   * only reads.
   */
  summaries(paths: readonly string[]): DocSummary[] {
    return this.linkReports.summaries(paths);
  }

  /**
   * `summaries`, with what a card on a board shows besides: each document's
   * frontmatter `description` and how many links it writes. From the same
   * cache, so a board of many cards costs one read per changed document.
   */
  cardSummaries(paths: readonly string[]): DocCardSummary[] {
    return this.linkReports.cardSummaries(paths);
  }

  /**
   * The links among `paths`: for each that is a markdown document in the
   * session, every link it writes that lands on another of them, followed from
   * where it is written as backlinks follow it, with the heading it names
   * (`anchor`, as written after `#`) when it names one. Each pair and heading
   * once. For a board's faint lines between its document cards. One context
   * index and each document's links from the cache, so a board of many cards
   * costs one read per changed document. It only reads.
   */
  linksAmong(paths: readonly string[]): { from: string; to: string; anchor?: string }[] {
    return this.linkReports.linksAmong(paths);
  }

  /**
   * One document's text as the session holds it: its active version (an unsaved
   * edit counts, as search reads it), a held version when `version` names one,
   * or the file for a document the session does not hold. `key` is what
   * backlinks takes. It only reads.
   */
  documentText(key?: string, version?: number): DocText {
    return this.linkReports.documentText(key, version);
  }

  /**
   * The links a document writes, each followed from where it is written as
   * backlinks follow them, with where it landed: a document in the session, a
   * file outside it, nothing, or a scheme (`op:doc/…` opens nothing here;
   * `https:` opens outward). Read from the active version, or the held version
   * `version` names. `key` is what backlinks takes. It only reads.
   */
  outlinks(key?: string, version?: number): Outlinks {
    return this.linkReports.outlinks(key, version);
  }

  /**
   * The findings a save can change and the agent reports on: the profile
   * check's and the relation vocabulary's, as `doctor` words them. A save of a
   * profile or relations file that changes them wakes the agent (`saved` in
   * `events.ts`); a document's own warnings follow its unsaved text, so its
   * save changes nothing here. The link check's are left out: informational,
   * and shown by the status bar mark.
   */
  reportedFindings(): Finding[] {
    const profiles = this.profileCheck();
    return findings({
      docs: [],
      nodes: [],
      profiles: {
        warnings: profiles.warnings.count,
        documents: profiles.warnings.documents,
        broken: profiles.broken.count,
      },
      relations: this.relationsPart.vocabularyHealth(this.places.contextIndex()),
    });
  }

  /**
   * Everything worth looking at in this session. It only looks: repairing would
   * mean deciding for the human that a ghost entry is not wanted back and that
   * versions held for a vanished file are not worth saving.
   */
  checkup(): Finding[] {
    const nodes: { entry: string; path: string; shown: string; exists: boolean }[] = [];
    for (const e of this.core.m.context)
      for (const p of docPaths(e))
        nodes.push({ entry: e.id, path: p, shown: this.display(p), exists: existsSync(p) });
    const check = this.linkCheck();
    const profiles = this.profileCheck();
    const overlap = this.workspaceOverlap();
    return findings({
      ...(overlap ? { overlap: shownOverlap(overlap, this.workspace) } : {}),
      profiles: {
        warnings: profiles.warnings.count,
        documents: profiles.warnings.documents,
        broken: profiles.broken.count,
      },
      relations: this.relationsPart.vocabularyHealth(this.places.contextIndex()),
      links: {
        // A bundle's broken references (a board's cards) are broken links too.
        dangling: check.dangling.count + check.references.count,
        unsupported: check.unsupported.count,
        schemes: check.unsupported.schemes,
        duplicates: check.duplicates.count,
        headings: check.headings.count,
        proposed: check.proposed?.count ?? 0,
      },
      docs: this.core.m.docs.map((d) => ({
        slug: d.slug,
        name: d.name,
        original: d.original,
        exists: existsSync(d.original),
        versions: d.versions.length,
      })),
      nodes,
    });
  }

  /**
   * The session's half of the snapshot. The daemon adds what it alone knows:
   * the mode, the selection, who is waiting, the undo history, the prefs, task
   * progress and the app's own view.
   */
  view(): {
    sessionId: string;
    dir: string;
    workspace: string;
    context: ContextEntry[];
    docs: DocView[];
    openDoc: string | null;
    openImage: ImageView | null;
    chat: Message[];
    tasks: Task[];
  } {
    return {
      sessionId: this.core.m.sessionId,
      dir: this.dir,
      workspace: this.workspace,
      context: this.core.m.context,
      docs: this.core.m.docs.map((d) => this.docView(d)),
      openDoc: this.core.m.openDoc,
      openImage: this.imageView(),
      chat: this.core.m.chat,
      tasks: this.tasks(),
    };
  }
}

/** A note placed in `text`: where it is now, how sure we are, and its lines for display. */
function placeNote(text: string, note: Note): PlacedNote {
  const at = findAnchor(text, note);
  if (at.from === null) return { ...note, ...at, fromLine: null, toLine: null };
  const lines = linesOf(text, at.from, at.to);
  return { ...note, ...at, fromLine: lines.from, toLine: lines.to };
}
