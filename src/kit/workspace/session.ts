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
 *   map), so the watcher can tell the daemon's own writes from anyone else's. A
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
// (`this.world` for the world the sets show, `this.own` for the session's own
// files), which checks each path at the syscall. The ward
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
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import {
  BUNDLE_INFO,
  type BundleReference,
  type BundleType,
  bundleDisplayName,
  bundleOf,
  bundlePlace,
  bundleStem,
  bundleTypeOf,
  bundleTypes,
  isBundleMain,
  isBundleMember,
  isMemberDir,
  newBundleInfo,
  type ReferencePlace,
  referencingBundle,
  writeBundleInfo,
} from "../lib/bundles.ts";
import {
  docFormat,
  EXTENSION_OF,
  IMAGE_EXTENSIONS,
  IMAGE_HEAD_BYTES,
  type ImageType,
  imageSize,
  isHeicName,
  isImageName,
  isSvgName,
  type PixelSize,
  SVG_REFUSED,
  sniffImage,
  withoutDocExtension,
} from "../lib/docFormat.ts";
import { splitFrontmatter } from "../lib/frontmatter.ts";
import {
  anchorFor,
  anchorHref,
  findHeading,
  headingPlainText,
  nearestHeading,
} from "../lib/headingAnchor.ts";
import { type Heading, headingsOf } from "../lib/headings.ts";
import { homeDir } from "../lib/home.ts";
import { describeJsonProblem, type JsonProblem, jsonProblem } from "../lib/json.ts";
import { decodePath, linkScheme, splitTarget } from "../lib/linkTarget.ts";
import { EMBED_BLOCKED, EMBED_REMOTE, EMBED_SVG } from "../lib/markdown.ts";
import { withoutCode } from "../lib/markdownCode.ts";
import { countPair, type KindPairUse, kindUseFrom } from "../lib/relationUse.ts";
import {
  describeSidecar,
  type ImageDescription,
  type ImageSource,
  imageOfSidecar,
  sidecarOf,
  sidecarSkeleton,
} from "../lib/sidecar.ts";
import { type Anchor, anchorOf, findAnchor, linesOf } from "./anchors";
import { applyHunks, diffText } from "./diff";
import { type Disk, sessionDisk, worldDisk } from "./disk";
import { type Finding, findings, type Overlap } from "./doctor";
import type { ClosedBy } from "./events";
import { IMAGE_MAX_BYTES, openNoFollow, readAllFd, readHeadFd, stampOf } from "./images";
import {
  type AppEdge,
  BODY_LINKS,
  checkLinkSlot,
  type EdgeSpot,
  edgeBacklinksTo,
  edgeKeeps,
  type LinkSlot,
  locateEdges,
  pathShaped,
  type ResolvableDocument,
  readEdges,
} from "./linkEdges";
import {
  backlinksTo,
  type DanglingLink,
  danglingLinks,
  duplicateNames,
  extractLinks,
  type GraphDoc,
  type LinkKind,
  type LinkOrigin,
  type LinkRef,
  landingName,
  linkGraph,
  type Resolution,
  rebaseCopy,
  relativeHref,
  resolveTarget,
  retarget,
  type SchemeLink,
  swapLinkTargets,
} from "./links";
import {
  keepPreMigrate,
  type ManifestMigrateContext,
  type ManifestMigrated,
  type MigrateManifest,
  migrateRefusal,
  PRE_MIGRATE_FILE,
  runManifestMigrate,
} from "./manifestMigrate";
import { type EdgeBreak, type MovedWorld, type MovePlan, movedWorld, treeOrder } from "./movePlan";
import {
  onDisk as diskPath,
  hasHomeWorkspace,
  holdsOwnPlaces,
  inOwnPlaces,
  noLocation,
  notAddedWhole,
  notALocation,
  notASet,
  noWorkspaceToSet,
  type OwnPlaces,
  ownPlaceGuard,
  within,
} from "./noHome";
import {
  checkFields,
  type FieldRule,
  fixFor,
  NO_MATCH,
  PROFILES_DIR,
  type ProfileLookup,
  type ProfileMatch,
  ProfileReader,
} from "./profiles";
import type {
  Author,
  Backlinks,
  BacklinkView,
  BrokenProfileView,
  CheckedEdgeView,
  CheckedLinkView,
  CheckedReferenceView,
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
  EdgeBacklinkView,
  EmbedView,
  GraphNodeView,
  GraphOptions,
  HeadingOffer,
  HeadingProblem,
  ImageView,
  LeavingLinkView,
  LinkCheck,
  LinkCheckOptions,
  LinkGraph,
  LinkHeadings,
  LinkTarget,
  LinkTargets,
  Message,
  MessageAbout,
  MessageType,
  Note,
  Outlinks,
  OutlinkView,
  PlacedNote,
  ProfileCheck,
  ProfilesReport,
  ProfileWarningView,
  ProposedLinkView,
  ReferenceBacklinkView,
  ReferenceView,
  RelationsAt,
  RelationsReport,
  RelationUse,
  SearchReport,
  SearchResult,
  Session,
  Speaker,
  SymmetryHint,
  Task,
  TaskAuthor,
  TaskStatus,
  TrashPreview,
  Version,
  WikiBreak,
} from "./protocol";
import {
  NO_VOCABULARY,
  oneWaySymmetric,
  type RelationsLookup,
  RelationsReader,
  readsBack,
  relationOffers,
  type TypedEdge,
  type Vocabulary,
} from "./relations";
import { safeExt, safeSlug } from "./safeNames";
import { type Candidate, DEFAULT_LIMIT, searchDocuments } from "./search";
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
  sidecarPaths,
  toPosix,
} from "./tree";

export const MANIFEST_FORMAT = 1;

/** The context's documents by path, each with the entry listing it, and the entries' realpath roots. */
type ContextIndex = {
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

/**
 * How many backlinks one answer carries. The documents read are already bounded
 * the way search and the link picker's are (each context entry lists at most
 * MIRROR_NODE_CAP); this bounds what one heavily linked document can send.
 */
export const BACKLINK_CAP = 500;

/** Schemes a link opens outward, in a browser: what `outlinks` marks `outward`. */
const OUTWARD = new Set(["http", "https", "mailto"]);

/** How many distinct embeds one `embeds` answer resolves: a document with more shows the rest as placeholders. */
export const EMBED_CAP = 200;

/** How many moves the session keeps for the link check's `proposed` (`moves`). */
const MOVES_KEPT = 500;

/**
 * A version kept from an outside write to the active one (`preserveOutside`):
 * the agent's by its record, but no proposal. `Version.outside` marks it; one
 * kept before that field, by its label.
 */
const keptOutside = (v: Version): boolean =>
  v.outside === true || /^outside write to v\d+$/.test(v.label ?? "");

/** How many entries each section of one link check carries; its `count` is the whole. */
export const LINK_CHECK_CAP = 500;

/** How many warnings one profile check lists; its `count` is the whole. */
export const PROFILE_CHECK_CAP = 500;

/**
 * How many documents one link graph answer carries, the best connected first;
 * `total` is the whole. At about twenty links each, 500 documents is already
 * thousands of edges, and no drawing reads more than a few hundred nodes.
 */
export const GRAPH_CAP = 500;

/**
 * What the graph and the profile check read from a document besides its links,
 * kept in the same per-file cache: its frontmatter `title`, `type` and `status`
 * (scalars only), its first `#` heading, and the whole frontmatter block parsed
 * (`fields`, null when there is none or it does not parse), which a profile
 * checks. Frontmatter is the first few hundred bytes, so holding it costs
 * little at 2,500 documents.
 */
/** A link pinned before a move (`pinLinks`): where it is written, as written, and where it landed. */
type LinkPin = {
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
type EdgePin = {
  kind: string;
  src: string;
  raw: string;
  target: string;
  key?: string;
  line?: number;
};

/** A context entry as it would be after a move (`planWorld`), with a listed entry's one item. */
type EntryAfter = { e: ContextEntry; file: string | null };

/**
 * The world after a move that has not happened (`movePlan`): the paths, the
 * context's entries as they would be, and the documents an app's resolver
 * would be handed then, once built.
 */
type PlanWorld = MovedWorld & {
  entries: readonly EntryAfter[];
  docs?: readonly ResolvableDocument[];
};

type DocFacts = {
  title: string | null;
  type: string | null;
  status: string | null;
  heading: string | null;
  fields: Record<string, unknown> | null;
  /** Why a frontmatter block that is there could not be read as fields; else null. */
  unparsed: string | null;
};

const NO_FACTS: DocFacts = {
  title: null,
  type: null,
  status: null,
  heading: null,
  fields: null,
  unparsed: null,
};

/** How many warnings one document contributes to a profile check; the rest are counted. */
export const PROFILE_WARNINGS_PER_DOC = 20;

/** One pass's profile lookup (`profilePass`): the profile a document matches. */
type ProfilePass = {
  lookup: ProfileLookup;
  match: (path: string, facts: DocFacts) => ProfileMatch;
};

/** What `profile <doc>` shows of one field's rule. */
type FieldView = Omit<NonNullable<DocumentProfile["fields"]>[number], "field" | "required">;

function ruleView(rule: FieldRule): FieldView {
  if (rule === false) return { forbidden: true };
  return {
    ...(rule.type ? { type: rule.type } : {}),
    ...(rule.enum ? { enum: rule.enum } : {}),
    ...(rule.const ? { const: rule.const.value } : {}),
    ...(rule.minLength !== undefined ? { minLength: rule.minLength } : {}),
    ...(rule.description !== undefined ? { description: rule.description } : {}),
  };
}

/** A frontmatter value the graph can show: a string or a number, trimmed; else null. */
const scalar = (v: unknown): string | null =>
  typeof v === "string" ? v.trim() || null : typeof v === "number" ? String(v) : null;

/** What a card adds to a summary: the `description` and the count of links to files. */
function cardFacts(
  facts: DocFacts,
  links: readonly { scheme?: string }[],
): { description?: string; links: number } {
  const description = scalar(facts.fields?.description);
  return {
    ...(description !== null ? { description } : {}),
    links: links.filter((l) => l.scheme === undefined).length,
  };
}

/** The first level-one ATX heading of a body, without its marks. */
const FIRST_HEADING = /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/m;

/** A document's facts, read from its whole text. A block that will not parse has none. */
/** Text as one line: every run of whitespace, newlines included, one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function docFacts(text: string): DocFacts {
  const { raw, body } = splitFrontmatter(text);
  const heading = FIRST_HEADING.exec(withoutCode(body))?.[1]?.trim() || null;
  if (raw === null) return { ...NO_FACTS, heading };
  try {
    const doc = parseDocument(raw, { prettyErrors: false });
    const error = doc.errors[0];
    if (error)
      return {
        ...NO_FACTS,
        heading,
        unparsed: `does not parse as YAML: ${firstLine(error.message)}`,
      };
    const parsed = doc.toJS() as unknown;
    // An empty block is no frontmatter, not a broken one.
    if (parsed === null || parsed === undefined) return { ...NO_FACTS, heading };
    if (typeof parsed !== "object" || Array.isArray(parsed))
      return {
        ...NO_FACTS,
        heading,
        unparsed: `is ${Array.isArray(parsed) ? "a list" : "a single value"}, not a mapping of fields`,
      };
    const f = parsed as Record<string, unknown>;
    return {
      title: scalar(f.title),
      type: scalar(f.type),
      status: scalar(f.status),
      heading,
      fields: f,
      unparsed: null,
    };
  } catch (e) {
    return {
      ...NO_FACTS,
      heading,
      unparsed: `does not parse as YAML: ${firstLine(e instanceof Error ? e.message : String(e))}`,
    };
  }
}

const firstLine = (t: string) => t.split("\n")[0]?.trim() ?? "";

/**
 * How the world's typed links use each relation: how many links carry it, and
 * how many between each pair of kinds (a link into a document with no kind,
 * or into none, counts only in `uses`). What the link picker ranks by.
 */
function relationUses(
  kinds: ReadonlyMap<string, string | null>,
  links: readonly { source: string; rel: string[]; to: string | null }[],
): { uses: Map<string, number>; pairs: KindPairUse[] } {
  const uses = new Map<string, number>();
  const pairs = new Map<string, KindPairUse>();
  for (const l of links) {
    const toKind = l.to === null ? null : (kinds.get(l.to) ?? null);
    const fromKind = kinds.get(l.source) ?? null;
    for (const rel of l.rel) {
      uses.set(rel, (uses.get(rel) ?? 0) + 1);
      if (toKind !== null) countPair(pairs, fromKind, toKind, rel);
    }
  }
  return { uses, pairs: [...pairs.values()] };
}

/**
 * Whether the disk holding `path` ignores case, asked of the disk itself: the
 * same file under the other case of its name (or of a folder above it). A path
 * with no cased letter anywhere falls back to the platform's default.
 */
export function caseInsensitiveAt(path: string): boolean {
  const flip = (s: string) => {
    const up = s.toUpperCase();
    return up !== s ? up : s.toLowerCase();
  };
  for (let p = path; dirname(p) !== p; p = dirname(p)) {
    const name = basename(p);
    const other = flip(name);
    if (other === name) continue;
    try {
      const a = statSync(p);
      const b = statSync(join(dirname(p), other));
      return a.ino === b.ino && a.dev === b.dev;
    } catch {
      return false;
    }
  }
  return process.platform === "darwin" || process.platform === "win32";
}

/** The folder inside a session that stands in as the workspace when none was chosen. */
export const IMPORTED_DIR = "imported";

/** The folder beside a document that an image pasted or dropped into it lands in. */
export const IMAGES_DIR = "images";

/** The most names of converted images the manifest remembers for their descriptions. */
const IMPORT_NAMES_MAX = 500;

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

/** A refusal the daemon turns into an HTTP status; `choices` when the set is in hand. */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly choices?: string[],
    /** What to do about it, when the message alone does not say. */
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * A refusal that can never turn into success: a recorded act names a place
 * that is gone from disk. An undo or redo refused this way leaves the stack
 * (see the daemon's `history.undo`), so the acts under it stay reachable.
 */
export class GoneError extends SessionError {}

/**
 * Save refused: the original changed on disk and the watcher never said so (a
 * change just as a watch armed, or an event a busy fseventsd dropped). `event`
 * is what the watcher would have said, classified now that Save has seen the
 * change: the daemon passes it on, so the human lands where a delivered event
 * would have put them ("Changed on disk", or the file's text reloaded).
 */
export class UnseenChangeError extends SessionError {
  constructor(
    message: string,
    readonly event: FileEvent | null,
    hint: string,
  ) {
    super(message, 409, undefined, hint);
  }
}

export const contentHash = (text: string): string => Bun.hash(text).toString(16);

const randHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const newSessionId = (): string => randHex(4);

/**
 * A session id is one plain folder name, and not `latest`, which is the
 * discovery pointer's own word. `open --restore ../elsewhere` must not read a
 * manifest from outside the sessions folder.
 */
export function checkSessionId(id: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id) || id.toLowerCase() === "latest")
    throw new SessionError(
      `"${id}" is not a session id (letters, numbers, dashes; not "latest")`,
      400,
    );
  return id;
}

/** An ISO 8601 timestamp, now. */
export const nowIso = (): string => new Date().toISOString();

/** Whether `p` is a directory now (false when it is gone or unreadable). */
function isFolder(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A path's realpath, or the path itself when it cannot be resolved (gone). */
/** An entry's root realpath, as it was when the entry was added. */
/** The most bytes one file name may have on the disks the studio runs on. */
export const NAME_MAX_BYTES = 255;

/**
 * `stem` and then `tail` (a number and the extension, kept whole), with the
 * stem shortened, a whole character at a time, until the name fits in
 * NAME_MAX_BYTES of UTF-8: a taken name at the limit still gets a free one.
 */
export function fitName(stem: string, tail: string): string {
  const room = NAME_MAX_BYTES - Buffer.byteLength(tail);
  const chars = [...stem];
  while (chars.length > 0 && Buffer.byteLength(chars.join("")) > room) chars.pop();
  return `${chars.join("").trimEnd()}${tail}`;
}

function rootReal(e: ContextEntry): string {
  return e.realRoot ?? realOr(e.root);
}

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

/** A path as the app shows it in words: the home folder as `~`. */
export function tilde(abs: string): string {
  const home = homeDir();
  return abs === home ? "~" : abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
}

/** An overlap with its paths as the app shows them, for a chat line or a finding. */
function shownOverlap(o: Overlap, workspace: string): Overlap & { workspace: string } {
  return { ...o, root: tilde(o.root), workspace: tilde(workspace) };
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
const TASK_NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
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

/** What a move or rename moved: the item, and an image's description beside it. */
const movedPairs = (
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

export class WorkspaceSession {
  readonly dir: string;
  private m: Session;
  /** path to hash of the daemon's last write to it. */
  private owned = new Map<string, string>();
  /**
   * A bundle folder the session itself just wrote whole (made, copied,
   * renamed, retitled), to when that is no longer news: the watcher's echo
   * of the session's own act is not reported as a change to the bundle.
   */
  private ownBundles = new Map<string, number>();
  /** slug to hash of the active version's current text. */
  private activeHash = new Map<string, string>();
  /** slug to the active version's text as the daemon last wrote (or adopted) it:
   *  what an outside write to the active version is reverted to. */
  private lastActiveText = new Map<string, string>();
  /**
   * A document's links, by the file they were read from, with the stamp
   * (inode, size, mtime, ctime) of the file when they were. Backlinks are asked for
   * whenever the surface's snapshot changes, and re-reading every document each
   * time would make that a full read of the world; with this, an answer stats
   * each document and re-reads only the ones that changed. An edit lands by
   * rename, so the active version's inode changes with every edit, which the
   * stamp catches even within one mtime tick.
   *
   * ⛔ MTIME AND SIZE ARE NOT ENOUGH (found by the source editor's verifier). An
   * outside edit that keeps the byte count and puts the old mtime back
   * (`touch -r`, a sync tool) left the link check answering from the old links. The stamp carries ctime,
   * which no userland call can set back. The headings, profile and relation
   * caches stamp the same way.
   */
  private linkCache = new Map<
    string,
    {
      stamp: string;
      links: LinkRef[];
      fragments: LinkRef[];
      facts: DocFacts;
      /** A bundle's references, for a main file whose type reads them; else empty. */
      refs: BundleReference[];
      /** The app's edges from it (kit-link-edges-slot), read from the same text. */
      edges: AppEdge[];
      /** Where each of `edges` is written, in order (`locateEdges`): what the link check opens. */
      edgeAt?: (EdgeSpot | undefined)[];
    }
  >();
  /**
   * Every move and rename this daemon made (`followMove`), oldest first, an
   * undo's way back included: what the link check's `proposed` reads to say
   * where a proposal's old target went. Memory only, so a restart forgets it
   * and a proposal's broken link is then reported with no `suggest`.
   */
  private moves: [from: string, to: string][] = [];
  /** The app's part of the link layer: its edges and its resolver (`setLinkSlot`). */
  private linkSlot: LinkSlot = {};
  /** What the app asks of the link check beyond the kit's own (`setLinkCheck`). */
  private linkCheckOpts: LinkCheckOptions = {};
  /** The documents the app's resolver may land on, built once per context index. */
  private resolvable = new WeakMap<ContextIndex, readonly ResolvableDocument[]>();
  /**
   * A document's headings, by the file they were read from and its stamp, as
   * `linkCache` holds links: read only for a document some link names with an
   * anchor (the link check), or the picker asks about.
   */
  private headingCache = new Map<string, { stamp: string; headings: Heading[] }>();

  /**
   * The world's profile files (`_meta/profiles/<kind>.json`), each parsed once
   * per change of its stamp, as `linkCache` holds documents (see `profiles.ts`).
   */
  private profileReader = new ProfileReader();
  /** The world's relation vocabulary files (`_meta/profiles/_relations.json`), parsed once per stamp (see `relations.ts`). */
  private relationsReader = new RelationsReader();
  /** What a restore found changed while no daemon was watching. */
  restoreReport: RestoreReport = { outside: [], tasks: [] };

  private constructor(
    readonly sessionsRoot: string,
    readonly app: AppDeclaration,
    manifest: Session,
  ) {
    this.m = manifest;
    this.dir = join(sessionsRoot, manifest.sessionId);
  }

  /**
   * The app's part of the link layer (kit-link-edges-slot): edges it adds
   * beside the body links, and a resolver for its own forms. Set once, as the
   * daemon boots (`WorkspaceDaemonOptions.links`); what was read before is
   * read again.
   */
  setLinkSlot(slot: LinkSlot | undefined): void {
    this.linkSlot = checkLinkSlot(slot);
    this.linkCache.clear();
  }

  /**
   * What the app asks of the link check (`WorkspaceDaemonOptions.linkCheck`):
   * the links leaving their set, and its word for a set. Set once, as the
   * daemon boots; without it the check is the kit's own.
   */
  setLinkCheck(opts: LinkCheckOptions | undefined): void {
    this.linkCheckOpts = { ...(opts ?? {}) };
  }

  /** Whether the app adds edges of its own: what decides that the answers carry them. */
  private get appEdges(): boolean {
    return this.linkSlot.edges !== undefined;
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
    s.pinDir();
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
    s.pinDir();
    // ⛔ A SET FROM AN OLDER MANIFEST NEVER SHOWS THE APP'S OWN PLACES. One
    // that lies among the sessions or in the app home is dropped; one that
    // holds them in plain sight is kept, narrowed by the scan's guard, which
    // leaves them out of it. Said in the chat either way.
    s.settleOwnPlaceSets(report);
    // Mirrors are re-read, not trusted: the folder may have changed while no
    // daemon was watching it.
    for (const e of s.m.context) if (e.membership === "mirrored") s.rescan(e.id);
    // A manifest from before entries kept their root's realpath: taken now.
    for (const e of s.m.context) if (!e.realRoot) e.realRoot = realOr(e.root);
    if (storedWorkspace !== undefined) {
      const added = s.keepDroppedWorkspace(storedWorkspace);
      if (added) report.workspaceAdded = added;
    }
    for (const d of s.m.docs) {
      const p = s.versionPath(d, d.active);
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
          d.outsideChanged = true;
          report.outside.push({ doc: d.slug, original: d.original, missing: false });
        }
      }
    }
    // The daemon that ran a daemon task is gone, so nothing will finish it: a
    // running one failed, a queued one is cancelled (re-running it unasked could
    // spend money). The agent outlives the daemon, so an agent task is left as
    // it was, and so is a human task.
    for (const t of s.m.tasks) {
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

  get id(): string {
    return this.m.sessionId;
  }

  get docsDir(): string {
    return join(this.dir, "docs");
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
      this.m.context.some(
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
    this.m.context.push(entry);
    this.relink();
    return folder;
  }

  /** Whether the app keeps a home workspace (`AppDeclaration.homeWorkspace`). */
  get hasHome(): boolean {
    return hasHomeWorkspace(this.app);
  }

  /** The folder dropped files and new top-level documents land in. */
  get workspace(): string {
    return this.m.workspace ?? join(this.dir, IMPORTED_DIR);
  }

  /**
   * The workspace, ready to be written into. The session's own `imported/`
   * folder is made on demand; a chosen folder that has gone is a conflict in
   * words, never a raw ENOENT.
   */
  private workspaceOrDie(): string {
    // No home workspace: a write that names no folder has nowhere to go.
    if (!this.hasHome) {
      const r = noLocation(this.app);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    const dir = this.workspace;
    // ⛔ The one gate for writing into the workspace (new documents, folders
    // and bundles, drops, imported images, moves): a workspace inside a bundle
    // would write into the bundle, which is one item and never a folder.
    refuseWorkspaceInBundle(dir);
    this.notOwnPlaceOrDie(dir);
    if (existsSync(dir)) return dir;
    if (dir === join(this.dir, IMPORTED_DIR)) {
      this.own.mkdir(dir, { recursive: true });
      return dir;
    }
    throw new SessionError(
      `the workspace folder is gone: ${dir}. Set it with \`workspace <dir>\``,
      409,
    );
  }

  /** Point the workspace at an existing folder (relative paths resolve against the daemon's cwd: callers send absolute ones). */
  setWorkspace(rawPath: string): { path: string; from: string } {
    if (!this.hasHome) {
      const r = noWorkspaceToSet(this.app);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    const abs = this.notOwnPlaceOrDie(resolve(rawPath));
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
    const overlap = overlapOf(abs, this.m.context);
    if (overlap)
      throw new SessionError(
        `the workspace cannot be ${overlap.same ? "the folder of" : "inside"} the set ${overlap.label} (${tilde(overlap.root)}): a file there would belong to both. Choose a folder outside it, such as ${tilde(dirname(overlap.root))}, or remove ${overlap.label} from the context first`,
        409,
      );
    const from = this.workspace;
    this.m.workspace = abs;
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
    return overlapOf(this.workspace, this.m.context);
  }

  /**
   * The overlap to say at startup, with its paths as the app shows them, or
   * null: said once per session, and again only when it changed (another
   * workspace or another set). A session that no longer overlaps forgets it.
   */
  overlapToSay(): (Overlap & { workspace: string }) | null {
    const o = this.workspaceOverlap();
    const key = o ? `${this.workspace}\n${o.root}` : undefined;
    if (key === this.m.overlapSaid) return null;
    if (key === undefined) delete this.m.overlapSaid;
    else this.m.overlapSaid = key;
    this.persist();
    return o ? shownOverlap(o, this.workspace) : null;
  }

  /** Whether `abs` is the workspace folder, as named or by where it really is. */
  isWorkspace(abs: string): boolean {
    if (!this.hasHome) return false;
    return abs === this.workspace || realOr(abs) === realOr(this.workspace);
  }

  get openDocSlug(): string | null {
    return this.m.openDoc;
  }

  get context(): readonly ContextEntry[] {
    return this.m.context;
  }

  /** The app's slot data, without its `version` (a copy: change it through `updateApp`). */
  get appSlot(): Record<string, unknown> {
    const { version: _version, ...data } = this.m.app;
    return structuredClone(data);
  }

  /** Change the app's slot and persist. The slot is the app's; the `version` key is not. */
  updateApp(change: (slot: Record<string, unknown>) => void): void {
    const slot = this.appSlot;
    change(slot);
    if ("version" in slot) throw new Error("`version` is reserved in the app slot");
    this.m.app = { ...slot, version: this.app.slot.version };
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
    for (const e of this.m.context) {
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
    for (const d of this.m.docs) {
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

  /** Record who ended the session; the daemon's close persists it next. */
  markEnded(by: ClosedBy): void {
    this.m.ended = { by, at: nowIso() };
  }

  /** Write the manifest, atomically. Call it on status changes, never on progress ticks. */
  persist(): void {
    this.own.mkdir(this.dir, { recursive: true });
    this.dirStillOrDie();
    this.own.writeAtomic(join(this.dir, "manifest.json"), `${JSON.stringify(this.m, null, 2)}\n`);
  }

  /**
   * Where the session folder really was when it was opened (its realpath),
   * taken once the folder exists (`pinDir`). Every write to the session's own
   * files checks the folder still leads there.
   */
  private realDir: string | undefined;

  /**
   * The app's own folder, where its sessions, settings and logs live, when the
   * daemon names one (`WorkspaceDaemonOptions.appHome`). Without it only the
   * sessions root is guarded.
   */
  private appHome: string | undefined;

  /** Name the app's own folder (`appHome`): guarded as the sessions root is. */
  setAppHome(appHome: string | undefined): void {
    this.appHome = appHome === undefined ? undefined : resolve(appHome);
  }

  /**
   * The places no set shows and no structure op writes in: the sessions root
   * and the app home. A home-workspace app's own `imported/` folder is the one
   * exception (its default workspace, inside the session).
   */
  private get ownPlaces(): OwnPlaces {
    return {
      sessionsRoot: this.sessionsRoot,
      ...(this.appHome !== undefined ? { appHome: this.appHome } : {}),
      ...(this.hasHome
        ? {
            except: join(this.dir, IMPORTED_DIR),
            // Only where the session folder really was at the open: an
            // `imported/` that is a link, or a session folder swapped since,
            // is no exception (`exceptionOf` in `./noHome.ts`).
            ...(this.realDir !== undefined ? { exceptReal: join(this.realDir, IMPORTED_DIR) } : {}),
          }
        : {}),
    };
  }

  /** A refusal at the write: the session's 409. */
  private static refuseWrite = (message: string): Error => new SessionError(message, 409);

  /**
   * ⛔ THE WORLD'S WRITER: every write to a file or folder the sets show (a
   * create, a drop, a sidecar, a Save, a link rewrite, a move). Never among
   * the sessions or in the app home, as written or as the disk resolves it,
   * checked at the syscall (`worldDisk` in `./disk.ts`).
   */
  private readonly world: Disk = worldDisk(() => this.ownPlaces, WorkspaceSession.refuseWrite);

  /**
   * ⛔ THE SESSION'S OWN WRITER: its manifest, versions and the folders for
   * them. Only inside the session folder, as written and as the disk resolves
   * it against the folder's realpath at open (`sessionDisk` in `./disk.ts`).
   */
  readonly own: Disk = sessionDisk(
    () => ({ dir: this.dir, ...(this.realDir !== undefined ? { realDir: this.realDir } : {}) }),
    WorkspaceSession.refuseWrite,
  );

  /**
   * An app verb's write of a file the context shows (an app's own edit of a
   * document, such as Scriptorium's frontmatter verbs): through the world's
   * writer, so never among the sessions or in the app home, whatever the sets
   * show. Not remembered as the session's own write: the watcher treats it as
   * any write to an opened original.
   */
  writeShown(rawPath: string, text: string): string {
    const { abs } = this.shownAt(rawPath);
    this.world.writeFile(abs, text);
    return abs;
  }

  /**
   * ⛔ THE BACKSTOP FOR EVERY STRUCTURE OP (create, move, rename, delete,
   * trash, import, make-set). Nothing is written among the sessions or in the
   * app home, whatever the sets say: a set that shows them (one restored from
   * an old manifest, one whose folder became a link) never makes them a place
   * to write. Refused before anything is changed.
   */
  private notOwnPlaceOrDie(abs: string, status: 400 | 409 = 409): string {
    const why = inOwnPlaces(abs, this.ownPlaces);
    if (why !== null)
      throw new SessionError(`${why}: nothing is written or moved there from here`, status);
    return abs;
  }

  /** As `notOwnPlaceOrDie`, for what an op takes away (a move's, a rename's, a trash's source): nor one that holds them. */
  private notOwnSourceOrDie(abs: string): string {
    this.notOwnPlaceOrDie(abs);
    const why = holdsOwnPlaces(abs, this.ownPlaces);
    if (why !== null)
      throw new SessionError(`${why}: it is not moved, renamed or removed from here`, 409);
    return abs;
  }

  /** The one guard on every route that makes a set or a listed entry (`notASet`). 409 when refused. */
  private mayBeASetOrDie(abs: string, gone = false): void {
    const why = notASet(abs, this.ownPlaces);
    if (why === null) return;
    const message = `${why}: it is not added to the context`;
    throw gone ? new GoneError(message, 409) : new SessionError(message, 409);
  }

  /**
   * At restore, before any scan: drop each entry that lies among the app's
   * own places (a set's root, or a listed file, as written or as the disk
   * resolves it), and note each set that holds them in plain sight, which the
   * scan's guard narrows. Older manifests could hold either; `add` refuses
   * both now (`notASet`).
   */
  private settleOwnPlaceSets(report: RestoreReport): void {
    const own = this.ownPlaces;
    const out: NonNullable<RestoreReport["ownPlaceSets"]> = [];
    this.m.context = this.m.context.filter((e) => {
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

  /** Take the session folder's realpath, once: called as a session is made or restored. */
  private pinDir(): void {
    if (this.realDir === undefined) this.realDir = realpathSync(this.dir);
  }

  /**
   * ⛔ THE SESSION'S FILES ARE WRITTEN WHERE THE SESSION WAS OPENED. A sessions
   * folder (or one session's) swapped for a link after the open would carry
   * every later write to wherever the link leads: someone else's sessions, a
   * real home a dry run was kept away from. Refused, and nothing is written.
   */
  private dirStillOrDie(): void {
    if (this.realDir === undefined) return;
    const now = realOr(this.dir);
    if (now !== this.realDir)
      throw new SessionError(
        `the session folder ${this.dir} now leads to ${now}, not where this session was opened (${this.realDir}): nothing was written`,
        409,
      );
  }

  /**
   * A version file's path, refused unless it is in the session's own `docs/`
   * folder as written and as the disk resolves it (a slug or extension that
   * climbs out, a linked folder that leads out). The manifest check refuses
   * such a slug or extension on restore; this is the backstop at every write.
   */
  private ownFileOrDie(path: string): string {
    this.dirStillOrDie();
    const docs = this.docsDir;
    const real = this.realDir !== undefined ? join(this.realDir, "docs") : diskPath(docs);
    if (!within(resolve(path), docs) || resolve(path) === docs || !within(diskPath(path), real))
      throw new SessionError(
        `${path} is not inside this session's docs folder (${docs}): nothing was written`,
        409,
      );
    return path;
  }

  /** A version file written: only inside the session's own `docs/` (`ownFileOrDie`). */
  private writeVersion(path: string, text: string): void {
    this.writeOwned(this.ownFileOrDie(path), text, this.own);
  }

  /** A write the watcher will know as the daemon's own: a version (`this.own`) or an original (`this.world`). */
  private writeOwned(path: string, text: string, disk: Disk): void {
    // Checked before anything: a refused write leaves no hash behind.
    const why = disk.refusal(path);
    if (why !== null) throw WorkspaceSession.refuseWrite(why);
    disk.mkdir(dirname(path), { recursive: true });
    // Remember before writing: the watcher's event can arrive before this
    // function returns, and it must find the hash already there.
    this.owned.set(path, contentHash(text));
    disk.writeFile(path, text);
  }

  private adoptActive(d: Doc, text: string): void {
    const p = this.versionPath(d, d.active);
    this.owned.set(p, contentHash(text));
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  private writeActive(d: Doc, text: string): void {
    this.writeVersion(this.versionPath(d, d.active), text);
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
    this.writeVersion(this.versionPath(d, n), text);
    this.persist();
    return { ...rec, path: this.versionPath(d, n) };
  }

  /** True iff `text` at `path` is exactly what the daemon last wrote there. */
  isOwnWrite(path: string, text: string): boolean {
    return this.owned.get(path) === contentHash(text);
  }

  // ── context ────────────────────────────────────────────────────────────

  addContext(rawPath: string): { entry: ContextEntry; added: boolean } {
    const abs = resolve(rawPath);
    this.mayBeASetOrDie(abs);
    const id = `c-${randHex(3)}`;
    // The app's filter sees a new set from its first scan.
    const probe = entryForPath(abs, id, (root) => this.scanSkip(id, root), this.scanGuard());
    const same = this.m.context.find(
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
    this.m.context.push(probe);
    // A loose image comes with its description, when one is beside it: listed
    // too, and folded into the image's row by the surface.
    const only = listedFile(probe);
    const sidecar = only?.kind === "image" ? this.sidecarFileOf(only.abs) : null;
    if (sidecar && !this.itemAt(sidecar))
      this.m.context.push(entryForPath(sidecar, `c-${randHex(3)}`));
    this.relink();
    this.persist();
    return { entry: probe, added: true };
  }

  /**
   * Take an entry out of the context (the files stay on disk). Returns the
   * entry and where it stood, which `restoreContext` takes to put it back.
   */
  removeContext(id: string): { entry: ContextEntry; index: number } {
    const i = this.m.context.findIndex((e) => e.id === id);
    if (i < 0)
      throw new SessionError(
        `no context entry ${id}`,
        404,
        this.m.context.map((e) => e.id),
      );
    const [entry] = this.m.context.splice(i, 1) as [ContextEntry];
    this.relink();
    this.closeOrphanedOpenDoc();
    // An open image the context no longer shows is put away, as `closeImage` does.
    if (this.m.openImage && !this.imageNodeAt(this.m.openImage)) this.closeImage();
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
  restoreContext(entry: ContextEntry, index = this.m.context.length): ContextEntry {
    if (this.m.context.some((e) => e.id === entry.id))
      throw new GoneError(`${entry.label} (${entry.id}) is in the context already`, 409);
    const only = entry.membership === "listed" ? entry.nodes[0] : undefined;
    const path =
      entry.membership === "mirrored" ? entry.root : only ? join(entry.root, only.rel) : null;
    if (path === null)
      throw new GoneError(`${entry.label} (${entry.id}) shows nothing to put back`, 409);
    // Checked now, where the disk really leads: a folder swapped for a link to
    // the sessions since it was hidden is never put back as a set.
    this.mayBeASetOrDie(path, true);
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
      this.m.context.some(
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
    this.m.context.splice(Math.max(0, Math.min(index, this.m.context.length)), 0, back);
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
    const open = this.m.openDoc ? this.m.docs.find((d) => d.slug === this.m.openDoc) : undefined;
    if (open && open.entryId === null) this.m.openDoc = null;
  }

  /** Re-mirror a folder entry. Returns whether its nodes changed. */
  rescan(entryId: string): boolean {
    const e = this.m.context.find((x) => x.id === entryId);
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
    return ownPlaceGuard(this.ownPlaces);
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
      for (const e of this.m.context) {
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
    if (entryId !== undefined && !this.m.context.some((e) => e.id === entryId))
      throw new SessionError(
        `no context entry ${entryId}`,
        404,
        this.m.context.map((e) => e.id),
      );
    let changed = false;
    for (const e of this.m.context)
      if ((entryId === undefined || e.id === entryId) && this.rescan(e.id)) changed = true;
    this.relink();
    this.closeOrphanedOpenDoc();
    if (this.m.openImage && !this.imageNodeAt(this.m.openImage)) this.closeImage();
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
    const item = this.itemOrDie(rawPath);
    return {
      abs: item.abs,
      entryId: item.entry.id,
      rel: toPosix(relative(item.entry.root, item.abs)),
      whole: item.whole,
    };
  }

  private relink(): void {
    for (const d of this.m.docs) {
      const at = locate(this.m.context, d.original);
      d.entryId = at?.entryId ?? null;
      d.rel = at?.rel ?? null;
    }
  }

  // ── documents and versions ─────────────────────────────────────────────

  /**
   * `<docs>/<slug>/v<n><ext>`. ⛔ Refused unless the slug is one safe name and
   * the extension a plain one (`safeSlug`, `safeExt`): the manifest check
   * refuses both on restore, so this only fires on a manifest changed under a
   * live session. Writes also check where the path really leads (`ownFileOrDie`).
   */
  private versionPath(d: Doc, n: number): string {
    if (safeSlug(d.slug) !== null || safeExt(d.ext) !== null)
      throw new SessionError(
        `${JSON.stringify(d.slug)} (${JSON.stringify(d.ext)}) does not name a version file inside this session`,
        409,
      );
    return join(this.docsDir, d.slug, `v${n}${d.ext}`);
  }

  private docOrDie(slug?: string): Doc {
    const want = slug ?? this.m.openDoc ?? undefined;
    // A document's alias names it too (`--doc touchstones`), so it is a choice.
    const opened = this.m.docs.flatMap((d) => {
      const alias = this.docAlias(d);
      return alias === undefined ? [d.slug] : [d.slug, alias];
    });
    // When nothing is open, the opened slugs are an empty list, and an empty
    // list is not an answer. So an unopened session offers the paths it could
    // open, and says how: a filename only resolves for a document that is
    // already open; a path always opens one.
    const choices =
      opened.length > 0 ? opened : this.m.context.flatMap((e) => docPaths(e)).slice(0, 20);
    const hint =
      opened.length > 0
        ? undefined
        : "nothing is open yet: pass a PATH from the context (a filename only resolves once a document is open)";
    if (want === undefined)
      throw new SessionError("no document is open: name one with --doc", 409, choices, hint);
    const d = this.findDoc(want);
    if (!d) throw new SessionError(`no document "${want}" in this session`, 404, choices, hint);
    return d;
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
    return new Map(this.m.docs.map((d) => [d.original, d.slug]));
  }

  findDoc(key: string): Doc | undefined {
    const bySlug = this.m.docs.find((d) => d.slug === key);
    if (bySlug) return bySlug;
    // Only an absolute key is a path: resolving a relative one here would
    // resolve it against the daemon's cwd. The CLI resolves against its own cwd
    // and sends an absolute path.
    if (isAbsolute(key)) {
      const path = this.mainOf(key.length > 1 ? key.replace(/\/+$/, "") : key);
      const byPath = this.m.docs.find(
        (d) => d.original === path || realOr(d.original) === realOr(path),
      );
      if (byPath) return byPath;
    }
    const byAlias = this.m.docs.find((d) => this.docAlias(d) === key);
    if (byAlias) return byAlias;
    const byName = this.m.docs.filter((d) => basename(d.original) === key || d.rel === key);
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
    if (alias === d.slug || this.m.docs.some((x) => x.slug === alias)) return undefined;
    const others = this.m.docs.filter(
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
    for (let i = 2; this.m.docs.some((d) => d.slug === slug); i++) slug = `${stem}-${i}`;
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
    const abs = this.canonical(this.mainOf(resolve(rawPath)));
    const existing = this.m.docs.find((d) => d.original === abs);
    if (existing) {
      if (focus) this.focusDoc(existing.slug);
      this.persist();
      return { slug: existing.slug, created: false };
    }
    if (!isDocName(abs) && !isBundleMain(abs))
      throw new SessionError(`not a document the workspace opens: ${abs}`, 400, docExtensions());
    const at = locate(this.m.context, abs);
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
    this.m.docs.push(d);
    this.writeActive(d, text);
    if (focus) this.focusDoc(d.slug);
    this.persist();
    return { slug: d.slug, created: true };
  }

  /** The centre shows one thing: a document coming on screen puts the open image away. */
  private focusDoc(slug: string): void {
    this.m.openDoc = slug;
    this.m.openImage = null;
    this.m.docAside = null;
  }

  /**
   * Every document the context lists, by path, with the entry that lists it
   * (the first, as `locate` answers), and each entry's root by realpath. What
   * `locate` and `canonical` would work out entry by entry, built once: a caller
   * that asks many times in one go (backlinks resolves every matching link in
   * the world) builds this and passes it, rather than walking every entry's
   * tree per question.
   */
  private contextIndex(): ContextIndex {
    const entryOf = new Map<string, string>();
    const images = new Set<string>();
    const sidecars = new Set<string>();
    for (const e of this.m.context) {
      for (const p of docPaths(e)) if (!entryOf.has(p)) entryOf.set(p, e.id);
      for (const p of imagePaths(e)) images.add(p);
      for (const p of sidecarPaths(e)) sidecars.add(p);
    }
    return {
      entryOf,
      images,
      sidecars,
      realRoots: this.m.context.map((e) => ({ root: e.root, real: realOr(e.root) })),
    };
  }

  /** `abs` as the context names it, when it is the same file by realpath. */
  private canonical(abs: string, index: ContextIndex = this.contextIndex()): string {
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

  openSlug(slug: string): void {
    this.focusDoc(this.docOrDie(slug).slug);
    this.persist();
  }

  readVersion(slug: string, n: number): { text: string; path: string } {
    const d = this.docOrDie(slug);
    this.versionOrDie(d, n);
    const path = this.versionPath(d, n);
    return { text: readFileSync(path, "utf8"), path };
  }

  activePath(slug?: string): string | null {
    const d = slug ? this.findDoc(slug) : this.m.openDoc ? this.findDoc(this.m.openDoc) : undefined;
    return d ? this.versionPath(d, d.active) : null;
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
    const path = this.versionPath(d, n);
    // The edit is staged in a sibling file first, so the check below and the
    // rename that lands the edit are adjacent syscalls: the window in which an
    // outside write could slip between them is microseconds, not the length of
    // a multi-megabyte write, and a write landing after the rename goes to the
    // new file, where the watcher finds it and preserves it too.
    // A fresh file under a random name (`stage`): never through a link
    // planted at a name it could guess.
    this.ownFileOrDie(path);
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
      this.owned.set(path, contentHash(text));
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
      const path = this.versionPath(d, n);
      let onDisk: string | null = null;
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {
        onDisk = null;
      }
      if (onDisk !== null && (onDisk === text || this.isOwnWrite(path, onDisk))) {
        this.writeVersion(path, text);
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
    const path = this.versionPath(d, v);
    this.writeVersion(path, text);
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
    const d = this.docOrDie(opts.doc);
    const from = opts.from ?? d.active;
    this.versionOrDie(d, from);
    const text = opts.body ?? readFileSync(this.versionPath(d, from), "utf8");
    const n = this.takeVersion(d);
    const rec: Version = {
      n,
      by: opts.by,
      fromVersion: from,
      createdAt: nowIso(),
      ...(opts.label ? { label: opts.label } : {}),
    };
    d.versions.push(rec);
    this.writeVersion(this.versionPath(d, n), text);
    this.persist();
    return { slug: d.slug, version: { ...rec, path: this.versionPath(d, n) } };
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
    const path = this.ownFileOrDie(this.versionPath(d, opts.version));
    d.versions = d.versions.filter((x) => x.n !== opts.version);
    try {
      this.own.rm(path);
    } catch (e) {
      if (e instanceof SessionError) throw e;
      // The record is what the session believes; a file already gone (a hand
      // tidy, a crash between write and record) must not block removing it.
    }
    this.owned.delete(path);
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
        readFileSync(this.versionPath(d, opts.version), "utf8"),
        "activated",
      );
    const previous = d.active;
    // Both have now been active (`Version.activated`): neither is a proposal
    // the link check reads, whoever wrote it.
    for (const v of d.versions) if (v.n === previous || v.n === opts.version) v.activated = true;
    d.active = opts.version;
    // The new active version's text as it is now is the baseline the next
    // check-before-write compares against.
    this.adoptActive(d, readFileSync(this.versionPath(d, d.active), "utf8"));
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
    return readFileSync(this.versionPath(d, side), "utf8");
  }

  /** Compare the active version (left) against another side (right). */
  compare(opts: { doc?: string; against: DiffSide }): DiffPayload {
    const d = this.docOrDie(opts.doc);
    if (opts.against === d.active)
      throw new SessionError(
        `v${d.active} is the active version of ${d.slug}: comparing it with itself says nothing`,
        400,
      );
    const left = readFileSync(this.versionPath(d, d.active), "utf8");
    return {
      doc: d.slug,
      active: d.active,
      against: opts.against,
      diff: diffText(left, this.sideText(d, opts.against)),
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
    const before = readFileSync(this.versionPath(d, d.active), "utf8");
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
    return readFileSync(this.versionPath(d, d.active), "utf8");
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
    return this.m.docs.find((d) => d.notes.some((n) => n.id === id))?.slug;
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
    return this.m.docs.map((d) => ({ slug: d.slug, notes: d.notes }));
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
   */
  editNote(opts: { doc?: string; id: string; body: string; by: Author }): {
    slug: string;
    note: Note;
    changed: boolean;
  } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
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
    return jsonProblem(readFileSync(this.versionPath(d, version), "utf8"));
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
    const text = readFileSync(this.versionPath(d, d.active), "utf8");
    // A JSON document is a contract other things read: one that does not parse
    // never reaches the file. The text stays in the version, to be fixed there.
    this.refuseInvalidJson(d, d.active, text, "saved");
    // The file's text is asked of the disk too, not of the watcher: a change it
    // never reported would be overwritten unseen. Once the flag is up the human
    // has been asked, and Save is their "Keep mine", a deliberate overwrite.
    if (fileThere && !d.outsideChanged) {
      const disk = readFileSync(d.original, "utf8");
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
    this.writeOwned(d.original, text, this.world);
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
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
    if (this.m.openDoc === d.slug) this.m.openDoc = null;
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
    this.m.docs = this.m.docs.filter((x) => x.slug !== d.slug);
    if (this.m.openDoc === d.slug) this.m.openDoc = this.m.docs[0]?.slug ?? null;
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
    for (const e of this.m.context) {
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
    for (const e of this.m.context) {
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
    const abs = this.contextForm(resolve(rawPath));
    const at = this.imageNodeAt(abs) ?? this.bundleImageAt(abs);
    if (!at) throw new SessionError(`${abs} is not an image shown in this session`, 404);
    const real = this.realInsideOrDie(abs, at.entry, "not served");
    // Open the real path once, refusing a link in its last place; then make sure
    // what was opened is a plain file, and is the very file the path inside the
    // set names now, by device and inode. A swap at any moment either fails the
    // open, or leaves a descriptor whose identity no longer matches, and is refused.
    const fd = openNoFollow(real);
    if (fd === null) throw new SessionError(`${abs} is not on disk`, 404);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SessionError(`${abs} is not a file`, 404);
      const now = this.realInsideOrDie(abs, at.entry, "not served");
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
   * `abs`'s realpath, when it lies inside `entry`'s root by realpath: a link in
   * the set that leads out of it is refused, as a 404, so a probe learns nothing.
   * For a listed entry the allowed place is exactly the listed file: its
   * realpath must be its folder's realpath and its own name, so a loose image
   * that is a link (out, or to a sibling) is refused.
   */
  private realInsideOrDie(abs: string, entry: ContextEntry, what: string): string {
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
   * Open an image in the centre's viewer for the human. Only an image the tree
   * shows; the open document is put aside (its record and versions stay, and
   * clicking it brings it back).
   */
  openImage(rawPath: string): { path: string } {
    if (!isAbsolute(rawPath))
      throw new SessionError(`"${rawPath}" is not a full path: start it with /`, 400);
    const abs = this.contextForm(resolve(rawPath));
    const at = isImageName(abs) ? this.imageNodeAt(abs) : null;
    if (!at)
      throw new SessionError(
        `${abs} is not an image shown in this session: add its folder to the context first`,
        400,
      );
    this.realInsideOrDie(abs, at.entry, "not opened");
    // The document on screen is put aside, not forgotten: closing the image
    // brings it back. A second image opened over the first keeps the same one.
    if (this.m.openDoc) this.m.docAside = this.m.openDoc;
    this.m.openImage = abs;
    this.m.openDoc = null;
    this.persist();
    return { path: abs };
  }

  /**
   * Put the open image away, and bring back the document it was opened over,
   * when that document is still held (closed or gone, nothing comes back).
   */
  closeImage(): void {
    const back = this.m.docAside;
    this.m.openImage = null;
    this.m.docAside = null;
    if (back && this.m.docs.some((d) => d.slug === back)) this.m.openDoc = back;
    this.persist();
  }

  /** The stamp of every image the context shows now: the thumbnails worth keeping. */
  imageStamps(): Set<string> {
    const out = new Set<string>();
    for (const e of this.m.context) {
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
    return this.m.openImage ?? null;
  }

  /**
   * The open image as the snapshot carries it, or null when none is open or it
   * has left the tree. Reads its size and first bytes, never more.
   */
  imageView(): ImageView | null {
    const abs = this.m.openImage;
    if (!abs) return null;
    const at = this.imageNodeAt(abs);
    if (!at) return null;
    // Nothing is read through a link that leads out of the set, not even its size.
    let real: string;
    try {
      real = this.realInsideOrDie(abs, at.entry, "not shown");
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
  sidecarDocOf(abs: string, index: ContextIndex = this.contextIndex()): string | null {
    const p = sidecarOf(abs);
    return index.sidecars.has(p) ? p : null;
  }

  /**
   * The image a document describes, when the document is a sidecar and the
   * session shows that image: its path, else null.
   */
  imageOfDoc(path: string, index: ContextIndex = this.contextIndex()): string | null {
    const image = imageOfSidecar(path);
    return image !== null && index.sidecars.has(path) && index.images.has(image) ? image : null;
  }

  /** A sidecar's text as the session holds it: its active version, else the file. */
  private sidecarText(path: string): string | null {
    const d = this.m.docs.find((x) => x.original === path);
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
    const held = this.m.docs.find(
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
      this.world.rename(sidecar, sidecarTo);
    } catch (e) {
      try {
        this.world.rename(to, from);
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
    const abs = this.contextForm(resolve(rawImage));
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
    const cameAs = this.m.importedAs?.[abs];
    const text = sidecarSkeleton(cameAs ?? basename(abs), source, added);
    this.world.writeFile(path, text, { flag: "wx" });
    if (cameAs !== undefined && this.m.importedAs) {
      delete this.m.importedAs[abs];
      if (Object.keys(this.m.importedAs).length === 0) delete this.m.importedAs;
    }
    if (!this.itemAt(path)) this.adoptNew(path);
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
    const n = this.nameOrDie(name);
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
    const at = this.contextForm(resolve(abs));
    const names = { ...(this.m.importedAs ?? {}) };
    delete names[at];
    if (given !== basename(at)) names[at] = given;
    const keys = Object.keys(names);
    // Bounded: a name nobody describes is dropped, oldest first.
    for (const k of keys.slice(0, Math.max(0, keys.length - IMPORT_NAMES_MAX))) delete names[k];
    if (Object.keys(names).length > 0) this.m.importedAs = names;
    else delete this.m.importedAs;
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
    const dir = rawDir ? this.destinationOrDie(rawDir) : this.workspaceOrDie();
    const set = this.coveringEntry(dir);
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
    this.world.writeFile(abs, bytes, { flag: "wx" });
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
    const abs = this.contextForm(resolve(rawBundle));
    const b = bundleOf(abs);
    if (!b || b.root !== abs || b.inner !== "")
      throw new SessionError(`${this.display(abs)} is not a bundle's folder`, 400);
    const entry = this.m.context.find(
      (e) =>
        e.membership === "mirrored" &&
        abs.startsWith(e.root + sep) &&
        findNode(e.nodes, toPosix(relative(e.root, abs)))?.kind === "bundle",
    );
    if (!entry) throw new SessionError(`${this.display(abs)} is not a bundle a set shows`, 404);
    this.realInsideOrDie(abs, entry, "not written into");
    this.notOwnPlaceOrDie(abs);
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
    if (!st) this.world.mkdir(assets);
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
    this.world.writeFile(abs, bytes, { flag: "wx" });
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
    this.world.writeFile(abs, bytes, { flag: "wx" });
    const from = sidecarOf(f.abs);
    const to = sidecarOf(abs);
    let sidecar: string | undefined;
    try {
      if (lstatSync(from).isFile() && !existsSync(to)) {
        this.world.writeFile(to, readFileSync(from), { flag: "wx" });
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
    const doc = this.contextForm(resolve(rawDoc));
    const item = this.itemOrDie(doc);
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
    this.world.writeFile(abs, bytes, { flag: "wx" });
    const set = this.coveringEntry(abs);
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
    this.notOwnPlaceOrDie(docDir);
    const dir = join(docDir, IMAGES_DIR);
    const set = this.coveringEntry(docDir);
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
      this.world.mkdir(dir);
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
          this.world.rmdir(dir);
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
      if (!this.coveringEntry(dir) && !this.itemAt(abs) && isImageName(abs)) {
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
    this.notOwnPlaceOrDie(dirname(target));
    const staged = join(dirname(target), `.${basename(target)}.incoming-${randHex(4)}`);
    this.world.writeFile(staged, bytes, { flag: "wx" });
    return staged;
  }

  /** Put a staged replacement in place of `target`, whose old file is now in the Trash. */
  placeStaged(staged: string, target: string): { path: string } {
    this.refuseExisting(target);
    this.world.rename(staged, target);
    // A loose image's entry is still there (only the file went to the Trash); one
    // the context no longer showed is given an entry again, as a new drop would be.
    if (this.itemAt(target)) this.rescanAround(target);
    else this.adoptNew(target);
    this.persist();
    return { path: target };
  }

  /** Drop a staged replacement that will not be used. */
  unstage(staged: string): void {
    try {
      this.world.unlink(staged);
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
    const item = this.itemOrDie(rawPath);
    this.notOwnSourceOrDie(item.abs);
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
    for (const e of this.m.context) {
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
    const docs = this.m.docs
      .filter((d) => inside(d.original) && !d.missing)
      .map((d) => ({
        slug: d.slug,
        name: this.docName(d),
        unsaved: this.isDirty(d),
        versions: d.versions.length,
        open: this.m.openDoc === d.slug,
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
    for (const d of this.m.docs) {
      if (!inside(d.original)) continue;
      d.missing = true;
      docs.push(d.slug);
      if (this.m.openDoc === d.slug) {
        this.m.openDoc = null;
        closed = d.slug;
      }
    }
    // An image has no record to keep: its viewer simply closes.
    if (this.m.openImage && inside(this.m.openImage)) this.m.openImage = null;
    for (const e of [...this.m.context]) {
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
    for (const e of this.m.context)
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
    for (const d of this.m.docs) {
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
    if (!this.m.docs.some((d) => d.original === abs)) return out;
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
      const d = this.m.docs.find((x) => x.slug === slug);
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
          const to = this.versionPath(d, next);
          this.owned.set(to, contentHash(text));
          this.own.rename(abs, this.ownFileOrDie(to));
          d.versions.push({ n: next, by: "agent", createdAt: nowIso() });
          d.versions.sort((a, b) => a.n - b.n);
          this.persist();
          return { kind: "version.created", doc: d.slug, version: next, path: to, renamedFrom: n };
        }
        d.versions.push({ n, by: "agent", createdAt: nowIso() });
        d.versions.sort((a, b) => a.n - b.n);
        d.nextVersion = Math.max(d.nextVersion, n + 1);
        this.owned.set(abs, contentHash(text));
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
      this.owned.set(abs, contentHash(text));
      return { kind: "version.changed", doc: d.slug, version: n, text, active: false };
    }

    // An opened original: by its stored path, or by realpath for a symlink.
    const d = this.m.docs.find((x) => x.original === abs || realOr(x.original) === abs);
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
      if (d.outsideChanged) return null; // already asked
      d.outsideChanged = true;
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
      if ((this.ownBundles.get(bundle) ?? 0) > Date.now()) return null;
      this.ownBundles.delete(bundle);
      return { kind: "bundle", path: bundle, file: abs };
    }

    // Something under a mirrored root: the tree may have changed.
    for (const e of this.m.context) {
      if (e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep))) {
        return this.rescan(e.id) ? { kind: "tree", entryId: e.id } : null;
      }
    }
    return null;
  }

  /** How long the watcher's echo of the session's own write to a bundle is not news. */
  static readonly OWN_BUNDLE_ECHO_MS = 2000;

  /** The session itself just wrote the bundle at `abs` whole. */
  private wroteBundle(abs: string): void {
    this.ownBundles.set(abs, Date.now() + WorkspaceSession.OWN_BUNDLE_ECHO_MS);
  }

  /** The bundle the context shows that `abs` is in, or is, by its folder's path; else null. */
  private shownBundleOf(abs: string): string | null {
    const b = bundleOf(abs);
    if (!b) return null;
    for (const e of this.m.context)
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
   * How a path reads in a chat line: `set/rel` inside a set, a single
   * document's file name, `workspace/...` in the workspace, else `~/...`.
   */
  display(abs: string): string {
    for (const e of this.m.context) {
      if (e.membership === "mirrored") {
        if (abs === e.root) return e.label;
        if (abs.startsWith(e.root + sep)) return `${e.label}/${toPosix(relative(e.root, abs))}`;
      } else if (e.nodes.some((n) => join(e.root, n.rel) === abs)) return e.label;
    }
    if (abs.startsWith(this.dir + sep)) return toPosix(relative(this.dir, abs));
    if (this.hasHome && abs.startsWith(this.workspace + sep))
      return `workspace/${toPosix(relative(this.workspace, abs))}`;
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
  private contextForm(abs: string): string {
    if (this.m.context.some((e) => abs === e.root || abs.startsWith(e.root + sep))) return abs;
    const real = realOr(abs);
    for (const e of this.m.context) {
      const realRoot = realOr(e.root);
      if (real === realRoot) return e.root;
      if (real.startsWith(realRoot + sep)) return join(e.root, relative(realRoot, real));
    }
    return abs;
  }

  /** The mirrored entry that covers `abs` (its root, or anything under it), if any. */
  private coveringEntry(abs: string, except?: string): ContextEntry | undefined {
    return this.m.context.find(
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
  private destinationOrDie(rawDir: string): string {
    const abs = this.contextForm(resolve(rawDir));
    // A folder the tree shows, and never one that is really inside a bundle
    // (a linked folder in a set that leads into one's insides).
    const shown = (): string => {
      refuseInBundle(abs, "that folder");
      return this.notOwnPlaceOrDie(abs);
    };
    for (const e of this.m.context) {
      // A listed entry is no place to put things, but for a folder inside an
      // expandable bundle listed on its own (a stage's `docs/`), which is
      // shown under its row as a set's folder is.
      if (e.membership !== "mirrored" && listedFile(e)?.kind !== "bundle") continue;
      if (abs === e.root && e.membership === "mirrored") return shown();
      if (abs.startsWith(e.root + sep)) {
        const node = findNode(e.nodes, toPosix(relative(e.root, abs)));
        if (node?.kind === "group") return shown();
      }
    }
    if (this.isWorkspace(abs)) return this.workspaceOrDie();
    if (!this.hasHome) {
      const r = notALocation(this.app, abs);
      throw new SessionError(r.message, 400, undefined, r.hint);
    }
    throw new SessionError(
      `${abs} is not a folder in this session: name a set, a folder inside one, or the workspace (${this.workspace})`,
      400,
    );
  }

  /** An existing folder on disk, as the context names it: where an undone move goes back to. */
  private folderOrDie(rawDir: string): string {
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
  private itemOrDie(rawPath: string): {
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
    for (const e of this.m.context) {
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
  private itemAt(abs: string): boolean {
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
      const roots: { root: string; only?: string }[] = [{ root: this.dir }];
      for (const e of this.m.context) {
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
  private nameOrDie(name: string): string {
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
  private docNameOrDie(name: string): string {
    const n = this.nameOrDie(name);
    return isDocName(n) ? n : `${n}.md`;
  }

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
    for (const d of this.m.docs) {
      const now = moved(d.original);
      if (now) {
        d.original = now;
        d.name = basename(now);
      }
    }
    // The open image follows a rename or a move, as an open document does.
    const image = this.m.openImage ? moved(this.m.openImage) : null;
    if (image) this.m.openImage = image;
    // A converted image's remembered name follows it; one left by a file that
    // was where the moved thing now is goes.
    if (this.m.importedAs) {
      const names: Record<string, string> = {};
      for (const [p, n] of Object.entries(this.m.importedAs)) {
        const now = moved(p);
        if (now) names[now] = n;
        else if (p !== to && !p.startsWith(to + sep)) names[p] = n;
      }
      this.m.importedAs = names;
    }
    const drop = new Set<string>();
    for (const e of this.m.context) {
      if (e.membership === "listed") {
        const only = listedFile(e);
        if (!only) continue;
        const now = moved(only.abs);
        if (!now) continue;
        if (this.coveringEntry(now, e.id)) drop.add(e.id);
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
        if (this.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = now;
          e.realRoot = realOr(now);
          e.label = basename(now) || now;
        }
      }
    }
    this.m.context = this.m.context.filter((e) => !drop.has(e.id));
    for (const e of this.m.context) if (e.membership === "mirrored") this.rescan(e.id);
    this.refreshListedContents();
    this.relink();
  }

  /** After a file or folder landed at `abs`: re-read the set it is in, or give it an entry. */
  private adoptNew(abs: string): void {
    const set = this.coveringEntry(abs);
    const listed = set ? null : this.listedBundleHolding(abs);
    if (set) this.rescan(set.id);
    // Made in a member folder of a bundle listed on its own: its row is read
    // again. An entry of its own would be the bundle a second time.
    else if (listed) this.refreshListed(listed);
    else {
      // Every write that lands here passed the backstop; a new entry still
      // takes the one set guard.
      this.mayBeASetOrDie(abs);
      const id = `c-${randHex(3)}`;
      this.m.context.push(
        entryForPath(abs, id, (root) => this.scanSkip(id, root), this.scanGuard()),
      );
    }
    this.relink();
  }

  /** The folder of a bundle listed on its own (no set shows it) that `abs` is inside, else null. */
  private listedBundleHolding(abs: string): string | null {
    const b = bundleOf(abs);
    if (!b || b.inner === "") return null;
    for (const e of this.m.context) {
      const only = listedFile(e);
      if (only?.kind === "bundle" && only.abs === b.root) return b.root;
    }
    return null;
  }

  /** Read every listed bundle of an expandable type again: its contents follow what moved. */
  private refreshListedContents(): void {
    for (const e of this.m.context) {
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
    const dir = this.destinationOrDie(rawDir);
    const wanted = name === undefined ? "Untitled.md" : this.docNameOrDie(name);
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
    this.world.writeFile(abs, text, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  createFolder(rawDir: string, name?: string): { path: string } {
    const dir = this.destinationOrDie(rawDir);
    // One made in the workspace gets an entry of its own (`adoptNew`): a set,
    // and named as one. Inside a set it is a folder.
    const makesSet = !this.coveringEntry(dir) && this.isWorkspace(dir);
    const folder =
      name === undefined
        ? this.freeName(dir, makesSet ? "New set" : "New folder", true)
        : this.nameOrDie(name);
    this.refuseBundleName(folder, "a new folder");
    const abs = join(dir, folder);
    this.refuseExisting(abs);
    this.world.mkdir(abs);
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
    const dir = this.destinationOrDie(rawDir);
    // A member folder takes documents, never a bundle inside a bundle.
    const holder = bundleHolding(dir);
    if (holder)
      throw new SessionError(
        `a ${type.label} is not made inside the ${holder.type.label} ${bundleNameAt(holder.root)}: make it beside it`,
        409,
      );
    const given = name === undefined ? null : this.nameOrDie(name);
    const folder =
      given === null
        ? this.freeName(dir, `Untitled${type.extension}`, false)
        : bundleTypeOf(given) === type
          ? given
          : fitName(given, type.extension);
    const abs = join(dir, folder);
    this.refuseExisting(abs);
    this.wroteBundle(abs);
    this.world.mkdir(abs);
    this.world.writeFile(join(abs, BUNDLE_INFO), newBundleInfo(type, bundleStem(folder)), {
      flag: "wx",
    });
    this.world.writeFile(join(abs, type.main), type.mainTemplate, { flag: "wx" });
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
    const item = this.itemOrDie(rawPath);
    this.notOwnPlaceOrDie(dirname(item.abs));
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
      this.wroteBundle(to);
      // ⛔ The copy's folder is made here first, alone (no `recursive`), so it
      // fails if anything is at `to` by now (a link, a folder another process
      // just made): only a folder this act made is ever removed below.
      try {
        this.world.mkdir(to);
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
          this.world.cp(join(item.abs, name), join(to, name), {
            recursive: true,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
          });
      } catch (e) {
        // Part of a copy is no copy: the folder this act made goes again.
        try {
          this.world.rm(to, { recursive: true, force: true });
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
        this.world.writeFile(
          join(to, BUNDLE_INFO),
          writeBundleInfo(info, item.bundle, { title: `${uncopied(title)}${suffix}` }),
        );
    } else {
      this.refuseExisting(to);
      try {
        this.world.copyFile(item.abs, to, constants.COPYFILE_EXCL);
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
    const item = this.itemOrDie(rawPath);
    if (!item.dir) this.refuseLoneSidecar(item.abs, "move");
    const into = opts.back ? this.folderOrDie(rawInto) : this.destinationOrDie(rawInto);
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
    const sidecarShown = sidecar !== null && this.itemAt(sidecar);
    const pins = opts.links ? this.pinLinks(sidecar ? [item.abs, sidecar] : [item.abs]) : null;
    // The app's edges it breaks are said as the plan says them, never rewritten.
    const edgePins =
      opts.links && this.appEdges
        ? this.pinEdges(sidecar ? [item.abs, sidecar] : [item.abs])
        : null;
    this.renameOrDie(item.abs, to);
    if (sidecar && sidecarTo) this.carrySidecar(item.abs, to, sidecar, sidecarTo);
    this.followMove(item.abs, to);
    if (sidecar && sidecarTo) this.followMove(sidecar, sidecarTo);
    if (!this.itemAt(to)) this.adoptNew(to);
    if (sidecarTo && sidecarShown && !this.itemAt(sidecarTo)) this.adoptNew(sidecarTo);
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
    const item = this.itemOrDie(rawPath);
    if (!item.dir) this.refuseLoneSidecar(item.abs, "move");
    const into = this.destinationOrDie(rawInto);
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
    const adopted = [to, ...(sidecar && sidecarTo && this.itemAt(sidecar) ? [sidecarTo] : [])];
    const world = this.planWorld(movedWorld(pairs), adopted);
    const plan = this.planRelink(pins, pairs, world);
    const docs = item.dir
      ? [...this.contextIndex().entryOf.keys()].filter((p) => p.startsWith(item.abs + sep)).length
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
    for (const e of this.m.context) {
      const only = e.membership === "listed" ? listedFile(e) : null;
      if (e.membership === "listed" && !only) continue;
      const was = only ? only.abs : e.root;
      const now = world.forward(was);
      if (now !== was && this.coveringEntry(now, e.id)) continue;
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
    const keyed = this.resolvableDocs(index).map((d, i) => {
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
    if (!this.appEdges) return [];
    const under = (p: string) => moved.some((m) => p === m || p.startsWith(m + sep));
    const index = this.contextIndex();
    const entryOf = this.entryFinder(index);
    const read = new Set<string>();
    const pins: EdgePin[] = [];
    for (const c of this.markdownCandidates()) {
      const inside = under(c.path);
      for (const e of this.readOf(c, read)?.edges ?? []) {
        // Resolved as the link check resolves an edge.
        const r = this.resolveFrom(e.target, c.path, entryOf(c.path), "document", index);
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
    const index = this.contextIndex();
    const entryOf = this.entryFinder(index);
    const out: EdgeBreak[] = [];
    for (const pin of pins) {
      const src = map(pin.src);
      const entry = world ? this.entryAfter(src, world, entryOf) : entryOf(src);
      const r = this.resolveFrom(pin.raw, src, entry, "document", index, "markdown", world);
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
    const item = this.itemOrDie(rawPath);
    if (item.bundle) return this.renameBundle(item.abs, item.bundle, name, opts);
    if (!item.dir) this.refuseLoneSidecar(item.abs, "rename");
    let next = this.nameOrDie(name);
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
    const given = this.nameOrDie(name);
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
      this.wroteBundle(to);
      this.followMove(from, to);
    }
    if (titleTo !== titleFrom) {
      this.wroteBundle(to);
      this.world.writeFile(
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
    for (const e of this.m.context) {
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
    const d = this.m.docs.find((x) => x.original === to);
    if (d && this.activeText(d) !== "") return null;
    this.writeOwned(to, text, this.world);
    if (!d) return null;
    this.edit(d.slug, d.active, text);
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
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
    const index = this.contextIndex();
    const entryOf = this.entryFinder(index);
    const read = new Set<string>();
    const pins: LinkPin[] = [];
    for (const c of this.markdownCandidates()) {
      const inside = under(c.path);
      for (const l of this.linksOf(c, read)) {
        if (l.scheme !== undefined) continue;
        const r = this.resolveFrom(l.raw, c.path, entryOf(c.path), "document", index, l.kind);
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
    for (const c of this.referenceCandidates()) {
      const inside = under(c.path);
      for (const ref of this.readOf(c, read)?.refs ?? []) {
        const r = this.resolveReference(ref.raw, c.path, entryOf(c.path), index);
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
    const index = this.contextIndex();
    const entryOf = this.entryFinder(index);
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
            ? this.resolveReference(raw, src, entry, index)
            : this.resolveFrom(raw, src, entry, "document", index, pin.kind, world);
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
          const written = rb?.references.write(dest, this.placeOf(src, rb.root, entry)) ?? null;
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
    const holders = this.m.context.filter((e) => src.startsWith(e.root + sep));
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
      const refused = this.world.refusal(edit.path);
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
      const d = this.m.docs.find((x) => x.original === edit.path);
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
          this.writeOwned(d.original, onDisk.text, this.world);
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
      this.world.writeFile(edit.path, out.text);
      docs.push({ path: edit.path, count: out.count, ...noun });
      total += out.count;
    }
    if (texts.length > 0 || docs.length > 0) this.persist();
    return { docs, count: total, texts, skipped, events };
  }

  private renameOrDie(from: string, to: string): void {
    this.notOwnSourceOrDie(from);
    this.notOwnPlaceOrDie(to);
    try {
      this.world.rename(from, to);
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
    const abs = this.notOwnSourceOrDie(resolve(rawPath));
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
      this.world.rmdir(abs);
    } else {
      this.world.unlink(abs);
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
    for (const e of [...this.m.context]) {
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
    this.m.docs = this.m.docs.filter((d) => !inside(d.original));
    if (this.m.openImage && inside(this.m.openImage)) this.m.openImage = null;
    if (this.m.openDoc && !this.m.docs.some((d) => d.slug === this.m.openDoc))
      this.m.openDoc = this.m.docs[0]?.slug ?? null;
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
    const item = this.itemOrDie(rawPath);
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
    this.notOwnSourceOrDie(item.abs);
    this.mayBeASetOrDie(folder);
    const pins = opts.links ? this.pinLinks([item.abs]) : null;
    try {
      this.world.mkdir(folder);
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
        this.world.rmdir(folder);
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
    const abs = this.contextForm(resolve(rawPath));
    const folder = dirname(abs);
    const e = this.m.context.find((x) => x.membership === "mirrored" && x.root === folder);
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
    this.mayBeASetOrDie(to, true);
    this.refuseExisting(to);
    this.renameOrDie(abs, to);
    try {
      this.world.rmdir(folder);
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
    const abs = join(this.contextForm(dirname(raw)), name);
    // Never among the sessions or in the app home, even where a set shows it.
    this.notOwnPlaceOrDie(raw, 400);
    this.notOwnPlaceOrDie(abs, 400);
    if (this.nameOrDie(name) !== name)
      throw new SessionError(`"${name}" is not a usable name: no space at either end`, 400);
    this.refuseBundleName(name, "a new folder");
    const parent = dirname(abs);
    let shown = false;
    try {
      this.destinationOrDie(parent);
      shown = true;
    } catch (err) {
      // Inside a set but not where it shows folders (a hidden one, a bundle's
      // own files): refused as `new-folder` refuses it.
      if (this.coveringEntry(parent) || !(err instanceof SessionError) || err.status !== 400)
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
      this.mayBeASetOrDie(abs);
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
      this.world.mkdir(abs);
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
      this.coveringEntry(abs) ??
      this.m.context.find((x) => {
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
    const file = this.nameOrDie(name);
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
    const dir = into ? this.destinationOrDie(into) : this.workspaceOrDie();
    const abs = join(dir, this.freeName(dir, file, false));
    this.world.writeFile(abs, text, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  // ── chat ───────────────────────────────────────────────────────────────

  addMessage(input: {
    from: Speaker;
    text: string;
    type?: MessageType;
    about?: MessageAbout;
    /** The gesture it came through, as sent (`Message.via`). */
    via?: string;
  }): Message {
    const msg: Message = {
      id: `m-${randHex(4)}`,
      from: input.from,
      type: input.type ?? (input.from === "system" ? "info" : "message"),
      text: input.text,
      ...(input.about ? { about: input.about } : {}),
      ...(input.via ? { via: input.via } : {}),
      ts: nowIso(),
    };
    this.m.chat.push(msg);
    this.persist();
    return msg;
  }

  /** The conversation, without building a snapshot around it. */
  messages(): readonly Message[] {
    return this.m.chat;
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  /**
   * One list, three creators. A task starts `open` (or `running`, when its
   * creator is already on it) and only ever moves along `TASK_NEXT`.
   */
  createTask(input: NewTask): Task {
    const title = input.title.trim();
    if (!title) throw new SessionError("a task needs to say what the work is", 400);
    if (input.parent !== undefined) this.taskOrDie(input.parent);
    const at = nowIso();
    let id = `t-${randHex(4)}`;
    while (this.m.tasks.some((t) => t.id === id)) id = `t-${randHex(4)}`;
    const task: Task = {
      id,
      title,
      by: input.by,
      status: input.status ?? "open",
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.quiet ? { quiet: true as const } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.m.tasks.push(task);
    this.persist();
    return task;
  }

  private taskOrDie(id: string): Task {
    const task = this.m.tasks.find((t) => t.id === id);
    if (!task)
      throw new SessionError(
        `no task ${id} in this session`,
        404,
        this.m.tasks.filter((t) => !isFinished(t.status)).map((t) => t.id),
      );
    return task;
  }

  task(id: string): Task {
    return this.taskOrDie(id);
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
    const task = this.taskOrDie(id);
    const from = task.status;
    if (from === to) return { task, from, changed: false };
    if (!TASK_NEXT[from].includes(to))
      throw new SessionError(`task ${id} is ${from}: it cannot become ${to}`, 409);
    task.status = to;
    task.updatedAt = nowIso();
    if (patch.detail !== undefined) task.detail = patch.detail.trim() || undefined;
    if (patch.outcome?.trim()) task.outcome = patch.outcome.trim();
    this.persist();
    return { task, from, changed: true };
  }

  /**
   * Set a task's detail without persisting: it rides progress reports, which are
   * runtime, and is written with the next status change.
   */
  setTaskDetail(id: string, detail: string): Task {
    const task = this.taskOrDie(id);
    task.detail = detail.trim() || undefined;
    return task;
  }

  /** Forget a finished task: one started by mistake, or no longer worth listing. */
  removeTask(id: string): Task {
    const task = this.taskOrDie(id);
    if (!isFinished(task.status))
      throw new SessionError(`task ${id} is ${task.status}: cancel it before removing it`, 409);
    this.m.tasks = this.m.tasks.filter((t) => t.id !== id);
    this.persist();
    return task;
  }

  /** Forget every finished task. Outstanding ones are untouched. */
  clearFinishedTasks(): number {
    const before = this.m.tasks.length;
    this.m.tasks = this.m.tasks.filter((t) => !isFinished(t.status));
    const cleared = before - this.m.tasks.length;
    if (cleared > 0) this.persist();
    return cleared;
  }

  /** Newest first: a queue is read from the top. */
  tasks(): Task[] {
    return [...this.m.tasks].reverse();
  }

  // ── views ──────────────────────────────────────────────────────────────

  docView(d: Doc): DocView {
    let hash = "";
    try {
      hash = contentHash(readFileSync(this.versionPath(d, d.active), "utf8"));
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
      versions: d.versions.map((v) => ({ ...v, path: this.versionPath(d, v.n) })),
      active: d.active,
      hash,
      dirty: !d.missing && this.isDirty(d),
      outsideChanged: d.outsideChanged,
      ...(d.missing ? { missing: existsSync(dirname(d.original)) ? "file" : "folder" } : {}),
      notes: this.placedNotes(d),
    };
  }

  doc(slug: string): DocView {
    return this.docView(this.docOrDie(slug));
  }

  /**
   * Search the context: fuzzy on names, exact in text. A document the session
   * holds is read as its ACTIVE VERSION, which lives under the session folder and
   * not at the original path, so an edit made a minute ago is found and `grep`
   * over the workspace would miss it. A document not yet opened is read from disk.
   */
  search(opts: { query: string; limit?: number }): SearchReport {
    const q = opts.query.trim();
    if (q === "") throw new SessionError("search: the query is empty", 400);
    const report = searchDocuments(
      this.candidates(),
      q,
      (c) => this.candidateText(c),
      opts.limit ?? DEFAULT_LIMIT,
    );
    // A hit in an image's description is a hit on the image: it carries the
    // image's path, which is what a surface opens.
    const index = this.contextIndex();
    for (const r of report.results) {
      const image = this.imageOfDoc(r.path, index);
      if (image) r.image = image;
      this.labelBundleHit(r);
    }
    return report;
  }

  /** A hit in a bundle's main file says which bundle it is in, as its row names it. */
  private labelBundleHit(r: SearchResult): void {
    if (!isBundleMain(r.path)) return;
    const b = bundleOf(r.path);
    if (b) r.bundle = { path: b.root, name: bundleNameAt(b.root), label: b.type.label };
  }

  /**
   * `search` for several queries in one pass: each document's text is read
   * once, however many queries there are, and each query gets its own report,
   * as `search` would give it. For a caller that asks about several words at
   * once (Atlas's impact check), where a search per word would read the whole
   * context once per word.
   */
  searchEach(opts: { queries: readonly string[]; limit?: number }): SearchReport[] {
    const queries = opts.queries.map((q) => q.trim());
    if (queries.some((q) => q === "")) throw new SessionError("search: a query is empty", 400);
    const candidates = this.candidates();
    const texts = new Map<string, string | null>();
    const read = (c: Candidate) => {
      if (!texts.has(c.path)) {
        let t: string | null;
        try {
          t = this.candidateText(c);
        } catch {
          t = null;
        }
        texts.set(c.path, t);
      }
      return texts.get(c.path) ?? null;
    };
    const index = this.contextIndex();
    return queries.map((q) => {
      const report = searchDocuments(candidates, q, read, opts.limit ?? DEFAULT_LIMIT);
      for (const r of report.results) {
        const image = this.imageOfDoc(r.path, index);
        if (image) r.image = image;
        this.labelBundleHit(r);
      }
      return report;
    });
  }

  /**
   * Every document in the session, once: what each context entry lists, then
   * any document opened by path that no entry lists, which is still one the
   * human has. What search looks through and what a link can point at.
   */
  private candidates(): Candidate[] {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const add = (path: string, d: Doc | undefined) => {
      if (seen.has(path)) return;
      seen.add(path);
      // A bundle's main file is found by its bundle's name ("The well"), not
      // by the name every main file of its type shares.
      const bundle = isBundleMain(path) ? bundleOf(path) : null;
      candidates.push({
        path,
        name: bundle ? bundleNameAt(bundle.root) : (d?.name ?? basename(path)),
        slug: d?.slug ?? null,
        version: d?.active ?? null,
      });
    };
    for (const entry of this.m.context)
      for (const path of docPaths(entry))
        add(
          path,
          this.m.docs.find((d) => d.original === path),
        );
    // A document the session keeps but no entry lists (opened, then its entry
    // left) is still one the human has, unless a set's folder holds it and the
    // app's filter leaves it out there (`ScanRule.skip`): then it is out of
    // search and links as it is out of the tree. Its record stays, versions
    // and unsaved text, for when the filter lets it back.
    const filtered = this.filteredOut();
    for (const d of this.m.docs)
      if (!(d.entryId === null && filtered(d.original))) add(d.original, d);
    return candidates;
  }

  /**
   * The candidates read as markdown: every markdown document. A JSON document
   * has no links, frontmatter or title to read, and is not a place on the map,
   * so link targets, backlinks, the link check, the graph and the profile
   * survey pass over it (a world's profile files are JSON documents too, and
   * are not untyped documents). Search does not: it matches names and plain
   * text, no markdown.
   */
  private markdownCandidates(): Candidate[] {
    return this.candidates().filter((c) => docFormat(c.path) === "markdown");
  }

  /** A candidate's text: its ACTIVE VERSION when the session holds it, else the file. */
  private candidateText(c: Candidate): string {
    const d = c.slug === null ? undefined : this.m.docs.find((x) => x.slug === c.slug);
    return d ? this.activeText(d) : readFileSync(c.path, "utf8");
  }

  /**
   * What a link written in document `slug` can point at: every OTHER document in
   * the session, each with the relative target to write, and the `?rel=` values
   * the session's documents already use (read as search reads them, so a
   * relation typed a minute ago is offered). It only reads; the link is typed
   * into the editor by the human like any other text.
   */
  /**
   * The headings of the markdown document at `path` (absolute, in the
   * context's form), read from its ACTIVE version when the session holds it,
   * else from its file; cached per stamp. Null when it cannot be read, and
   * empty for a JSON document, which has none.
   */
  private headingsAt(path: string): Heading[] | null {
    if (docFormat(path) === "json") return [];
    const d = this.m.docs.find((x) => x.original === path);
    const file = d ? this.versionPath(d, d.active) : path;
    let stamp: string;
    try {
      const st = statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return null;
    }
    const hit = this.headingCache.get(file);
    if (hit?.stamp === stamp) return hit.headings;
    let headings: Heading[];
    try {
      headings = headingsOf(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
    this.headingCache.set(file, { stamp, headings });
    return headings;
  }

  /**
   * The link picker's second step: the headings of the document at `path`,
   * each with the anchor a link writes for it (`anchorFor`: the heading's
   * text, or the path of headings that names a repeat alone), encoded. Only a
   * document in the context is read; anything else has no headings to offer.
   */
  linkHeadings(slug: string, path: string): LinkHeadings {
    this.docOrDie(slug);
    const index = this.contextIndex();
    const own = this.canonical(path, index);
    const listed = index.entryOf.has(own) || this.m.docs.some((d) => d.original === own);
    if (!listed || isImageName(own)) return { path: own, headings: [] };
    const hs = this.headingsAt(own) ?? [];
    const headings: HeadingOffer[] = hs.map((h, i) => ({
      level: h.level,
      text: headingPlainText(h.text),
      line: h.line,
      anchor: anchorHref(anchorFor(hs, i)),
    }));
    return { path: own, headings };
  }

  linkTargets(slug: string): LinkTargets {
    const from = this.docOrDie(slug).original;
    const all = this.markdownCandidates();
    const shownOf = (path: string) => {
      const entry = this.m.context.find((e) => path.startsWith(e.root + sep));
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const index = this.contextIndex();
    const targets: LinkTarget[] = all
      // An image's description is offered as its image, never as a document of
      // its own: a link to it would be a link to the words, not the picture.
      .filter((c) => c.path !== from && this.imageOfDoc(c.path, index) === null)
      .map((c) => ({
        path: c.path,
        name: c.name,
        href: relativeHref(from, c.path),
        shown: shownOf(c.path),
      }));
    // And every image the tree shows (kit-image-embeds), by name only: an
    // image's bytes are never read here.
    const seen = new Set(targets.map((t) => t.path));
    for (const e of this.m.context)
      for (const path of imagePaths(e)) {
        if (seen.has(path)) continue;
        seen.add(path);
        const d = this.imageDescription(path, index);
        const description = d ? [d.title, d.summary].filter(Boolean).join(": ") : "";
        targets.push({
          path,
          name: basename(path),
          href: relativeHref(from, path),
          shown: shownOf(path),
          image: true,
          ...(description ? { description } : {}),
        });
      }
    // The relations, from the link cache: a stat per document, and a read only
    // of what changed since the last ask (kit-picker-relation-meanings). Before,
    // every document's whole text was read on every open of the picker.
    const { kinds, links } = this.typedLinks(index, all);
    const here = this.canonical(from, index);
    const kind = kinds.get(here) ?? null;
    for (const t of targets) {
      const k = t.image ? null : (kinds.get(t.path) ?? null);
      if (k !== null) t.kind = k;
    }
    const { uses, pairs } = relationUses(kinds, links);
    const vocabulary = this.relationPass(index).at(here);
    return {
      doc: slug,
      kind,
      targets,
      relations: relationOffers(uses, vocabulary),
      vocabulary: vocabulary.any,
      byKind: kindUseFrom(pairs, kind),
    };
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
    const index = this.contextIndex();
    const all = this.markdownCandidates();
    const { kinds, links } = this.typedLinks(index, all);
    const { uses, pairs } = relationUses(kinds, links);
    const own = this.canonical(path, index);
    const pass = this.relationPass(index);
    const vocabulary = pass.at(own);
    const entry = this.entryFinder(index)(own);
    const near = entry ? pass.lookup.nearest(dirname(own), entry.root) : null;
    return {
      vocabulary: vocabulary.any,
      relations: relationOffers(uses, vocabulary),
      pairs,
      file: near?.path ?? null,
      ...(near && "broken" in near.read ? { broken: near.read.broken } : {}),
    };
  }

  /**
   * Every candidate's kind, and every TYPED link (one with `?rel=`) with the
   * document it lands on, resolved as written in a DOCUMENT; null for a link
   * that lands on no document in the session (a scheme link, `op:doc/…`, is
   * still a use of its relations). Read through the link cache, as the check
   * and the graph read; it read every candidate, so the cache is pruned.
   */
  private typedLinks(
    index: ContextIndex,
    all: Candidate[] = this.markdownCandidates(),
  ): {
    kinds: Map<string, string | null>;
    links: { source: string; rel: string[]; to: string | null }[];
  } {
    const read = new Set<string>();
    const pass = this.profilePass(index);
    const entryOf = this.entryFinder(index);
    const kinds = new Map<string, string | null>();
    const sources = all.map((c) => {
      const got = this.readOf(c, read);
      kinds.set(c.path, this.kindOf(c.path, got?.facts ?? NO_FACTS, pass));
      return { path: c.path, links: got?.links ?? [] };
    });
    this.pruneLinkCache(read);
    const links: { source: string; rel: string[]; to: string | null }[] = [];
    for (const s of sources)
      for (const l of s.links) {
        if (l.rel.length === 0) continue;
        let to: string | null = null;
        if (l.scheme === undefined) {
          const r = this.resolveFrom(l.raw, s.path, entryOf(s.path), "document", index, l.kind);
          if (r.state === "in-context" && kinds.has(r.path)) to = r.path;
        }
        links.push({ source: s.path, rel: l.rel, to });
      }
    return { kinds, links };
  }

  /**
   * One pass's relation vocabulary: what is in force for a document or image
   * at a path, the nearest `_meta/profiles/_relations.json` winning per
   * relation, up to the root of the context entry that holds it and never
   * above (`relations.ts`). None outside every entry.
   */
  private relationPass(index: ContextIndex): {
    lookup: RelationsLookup;
    at: (path: string) => Vocabulary;
  } {
    const lookup = this.relationsReader.pass();
    const entryOf = this.entryFinder(index);
    return {
      lookup,
      at: (path) => {
        const entry = entryOf(path);
        return entry ? lookup.at(dirname(path), entry.root) : NO_VOCABULARY;
      },
    };
  }

  /**
   * The world's relation vocabulary and how its links use it: every vocabulary
   * file (broken ones with why), each declared relation with the links using it
   * where its definition is the one in force, the relations used where a
   * vocabulary is in force but does not declare them, and every relation in
   * use. It only reads. The `relations` verb answers from here.
   */
  relations(): RelationsReport {
    const index = this.contextIndex();
    const all = this.markdownCandidates();
    const { links } = this.typedLinks(index, all);
    const pass = this.relationPass(index);
    // Every document's folder looked in, so a file nothing links under is still listed.
    for (const c of all) pass.at(c.path);
    const entryOf = this.entryFinder(index);
    const shown = (path: string) => {
      const entry = entryOf(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const used = new Map<string, number>();
    const undeclared = new Map<string, number>();
    const declaredUses = new Map<string, number>();
    for (const l of links) {
      const v = pass.at(l.source);
      for (const rel of l.rel) {
        used.set(rel, (used.get(rel) ?? 0) + 1);
        const def = v.relations.get(rel);
        if (def) {
          const key = `${def.source}\0${rel}`;
          declaredUses.set(key, (declaredUses.get(key) ?? 0) + 1);
        } else if (v.any) undeclared.set(rel, (undeclared.get(rel) ?? 0) + 1);
      }
    }
    const files = pass.lookup.files();
    this.relationsReader.prune(pass.lookup.seen());
    const declared: RelationsReport["declared"] = [];
    for (const f of files)
      if (!("broken" in f.read))
        for (const d of f.read.relations)
          declared.push({
            rel: d.rel,
            label: d.label,
            ...(d.means !== undefined ? { means: d.means } : {}),
            symmetric: d.symmetric,
            ...(d.inverse !== undefined ? { inverse: d.inverse } : {}),
            ...(d.color !== undefined ? { color: d.color } : {}),
            file: shown(f.path),
            uses: declaredUses.get(`${f.path}\0${d.rel}`) ?? 0,
          });
    const byUse = (m: Map<string, number>): RelationUse[] =>
      [...m]
        .map(([rel, count]) => ({ rel, count }))
        .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
    return {
      files: files.map((f) => ({
        path: f.path,
        shown: shown(f.path),
        relations: "broken" in f.read ? 0 : f.read.relations.length,
        ...("broken" in f.read ? { broken: f.read.broken } : {}),
        ...(!("broken" in f.read) && f.read.warnings ? { warnings: f.read.warnings } : {}),
      })),
      broken: files.filter((f) => "broken" in f.read).length,
      warnings: files.reduce(
        (n, f) => n + ("broken" in f.read ? 0 : (f.read.warnings?.length ?? 0)),
        0,
      ),
      declared,
      undeclared: byUse(undeclared),
      used: byUse(used),
    };
  }

  /**
   * How many vocabulary files in the context are broken, how many keys they
   * ignore, and which of those repeat an earlier key in another case (each
   * with its file, shown as `relations` shows it): the doctor's counts.
   */
  private vocabularyHealth(index: ContextIndex): {
    broken: number;
    warnings: number;
    folded: { key: string; earlier: string; file: string }[];
  } {
    const pass = this.relationPass(index);
    for (const c of this.markdownCandidates()) pass.at(c.path);
    const files = pass.lookup.files();
    const entryOf = this.entryFinder(index);
    const shown = (path: string) => {
      const entry = entryOf(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const folded: { key: string; earlier: string; file: string }[] = [];
    for (const f of files)
      if (!("broken" in f.read))
        for (const k of f.read.folded ?? []) folded.push({ ...k, file: shown(f.path) });
    return {
      broken: files.filter((f) => "broken" in f.read).length,
      warnings: files.reduce(
        (n, f) => n + ("broken" in f.read ? 0 : (f.read.warnings?.length ?? 0)),
        0,
      ),
      folded,
    };
  }

  /**
   * Where a link written in document `from` (a slug, or null for a link in the
   * chat with no document open) goes. See `links.ts` for what the root and "in
   * the session" mean here. It only resolves: the caller opens an `in-context`
   * target, and nothing is ever added to the context.
   */
  resolveLink(target: string, from: string | null, origin: LinkOrigin = "document"): Resolution {
    const d = from === null ? undefined : this.docOrDie(from);
    const src = d?.original ?? null;
    const entry =
      (d?.entryId ? this.m.context.find((e) => e.id === d.entryId) : undefined) ??
      (src ? this.m.context.find((e) => src.startsWith(e.root + sep)) : this.m.context[0]);
    return this.resolveFrom(target, src, entry, origin, this.contextIndex());
  }

  /**
   * A dropped document's link text: its frontmatter `title`, else its first
   * heading (the user's choice, 2026-10-06), from its ACTIVE VERSION when the
   * session holds it, as the rest of the link layer reads. A JSON document, or
   * one that cannot be read, falls back to its file name.
   */
  private droppedDocTitle(path: string): string | undefined {
    if (docFormat(path) === "json") return undefined;
    const c = this.markdownCandidates().find((x) => x.path === path);
    try {
      const f = docFacts(c ? this.candidateText(c) : readFileSync(path, "utf8"));
      return f.title ?? f.heading ?? undefined;
    } catch {
      return undefined;
    }
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
    const d = this.docOrDie(slug);
    const from = d.original;
    const index = this.contextIndex();
    // The entry the document is read in: its own, else the first that holds it.
    const home =
      (d.entryId ? this.m.context.find((e) => e.id === d.entryId) : undefined) ??
      this.m.context.find((e) => from.startsWith(e.root + sep));
    const out: DroppedLink[] = [];
    for (const raw of new Set(paths)) {
      const path = this.canonical(raw, index);
      const isImage = index.images.has(path);
      // A document links; a sidecar is its image's, and is reached through it.
      const isDoc = !isImage && index.entryOf.has(path) && !index.sidecars.has(path);
      if (path === from || (!isImage && !isDoc)) continue;
      if (!home || !path.startsWith(home.root + sep)) {
        out.push({
          path,
          refused: `${basename(path)} is in another part of the context, outside ${home ? home.label : "this document's folder"}, so no link from this document would travel with it. Copy it into this set first.`,
        });
        continue;
      }
      const title = isImage
        ? this.imageDescription(path, index)?.title?.trim()
        : this.droppedDocTitle(path);
      out.push({
        path,
        image: isImage,
        href: relativeHref(from, path),
        text: oneLine(title ?? "") || basename(path).replace(/\.[^.]+$/, ""),
      });
    }
    return out;
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
    const d = this.docOrDie(slug);
    const src = d.original;
    const entry =
      (d.entryId ? this.m.context.find((e) => e.id === d.entryId) : undefined) ??
      this.m.context.find((e) => src.startsWith(e.root + sep));
    const index = this.contextIndex();
    const notShown = (target: string, reason: string): EmbedView => ({
      target,
      state: "not-shown",
      reason,
    });
    return [...new Set(targets)].slice(0, EMBED_CAP).map((target): EmbedView => {
      const scheme = linkScheme(target);
      if (scheme === "http" || scheme === "https") return notShown(target, EMBED_REMOTE);
      if (target === "" || scheme !== undefined) return notShown(target, EMBED_BLOCKED);
      if (isSvgName(splitTarget(target).path)) return notShown(target, EMBED_SVG);
      const r = this.resolveFrom(target, src, entry, "document", index);
      switch (r.state) {
        case "in-context": {
          if (!isImageName(r.path))
            return notShown(
              target,
              `${this.display(r.path)} is a document, not an image: link to it with [text](…).`,
            );
          try {
            const f = this.imageFile(r.path);
            // The size from the header, through the guard's own descriptor.
            let size: PixelSize | null = null;
            try {
              size = imageSize(readHeadFd(f.fd, IMAGE_HEAD_BYTES), f.type);
            } finally {
              closeSync(f.fd);
            }
            return {
              target,
              state: "shown",
              path: f.abs,
              stamp: f.stamp,
              type: f.type,
              ...(size ? { width: size.width, height: size.height } : {}),
            };
          } catch (e) {
            // The guard names the file by its full path; a placeholder names it
            // as the context does, so the reason fits on a line or two.
            const said = e instanceof Error ? e.message : String(e);
            return notShown(target, said.split(r.path).join(this.display(r.path)));
          }
        }
        case "not-a-doc":
          return notShown(
            target,
            isImageName(r.path)
              ? `${basename(r.path)} is an image no set in this session shows: add its folder, ${this.display(dirname(r.path))}, to show it.`
              : `${this.display(r.path)} is not an image the workspace shows (${IMAGE_EXTENSIONS.join(" ")}).`,
          );
        case "outside":
          return notShown(target, `${this.display(r.path)} is a document, not an image.`);
        case "folder":
          return notShown(target, `${this.display(r.path)} is a folder, not an image.`);
        default:
          // `missing`: nothing answers.
          return notShown(
            target,
            r.tried.length === 0
              ? "Image not found."
              : `Image not found: nothing at ${r.tried.map((p) => this.display(p)).join(" or ")}.`,
          );
      }
    });
  }

  /** Resolve `target` as written in the document at `src` (null: the chat), in `entry`. */
  private resolveFrom(
    target: string,
    src: string | null,
    entry: ContextEntry | undefined,
    origin: LinkOrigin,
    index: ContextIndex,
    kind: LinkKind = "markdown",
    /**
     * Resolve in the world after a move that has not happened (`movePlan`):
     * `src`, `entry` and every path asked about are that world's, and each
     * is read on disk where it is now.
     */
    world?: PlanWorld,
  ): Resolution {
    const root = entry?.root ?? (src ? dirname(src) : this.workspace);
    const is = (p: string, what: "file" | "dir") => {
      const at = world ? world.back(p) : p;
      if (at === null) return false;
      try {
        const st = statSync(at);
        return what === "file" ? st.isFile() : st.isDirectory();
      } catch {
        return false;
      }
    };
    const inContext = (p: string): string | null => {
      if (!world) return this.inContextAt(p, index);
      const at = world.back(p);
      const own = at === null ? null : this.inContextAt(at, index);
      return own === null ? null : world.forward(own);
    };
    const app = this.linkSlot.resolve;
    return resolveTarget(
      target,
      src,
      {
        root,
        inContext,
        exists: (p) => is(p, "file"),
        isDir: (p) => is(p, "dir"),
        ...(app
          ? {
              app: (path: string, k: LinkKind) => {
                try {
                  return app({
                    target: path,
                    from: src,
                    root,
                    kind: k,
                    documents: () =>
                      world ? this.docsAfter(index, world) : this.resolvableDocs(index),
                  });
                } catch {
                  // An app resolver that throws answers nothing: the link is missing.
                  return undefined;
                }
              },
            }
          : {}),
      },
      origin,
      kind,
    );
  }

  /**
   * Every markdown document in the context, with its frontmatter, for the
   * app's resolver: built once per context index (one answer), read through
   * the link cache, so the same array is handed to every target in it.
   */
  private resolvableDocs(index: ContextIndex): readonly ResolvableDocument[] {
    const had = this.resolvable.get(index);
    if (had) return had;
    const read = new Set<string>();
    const docs = this.markdownCandidates().map((c) => {
      const f = this.readOf(c, read)?.facts ?? NO_FACTS;
      return { path: c.path, type: f.type, frontmatter: f.fields };
    });
    this.resolvable.set(index, docs);
    return docs;
  }

  /**
   * What a link (or a reference) landing on `p` lands on in the session, in
   * the context's own form, so a link written `./Part/B.md` on a
   * case-insensitive disk reports (and opens) the file as it is named; null
   * when `p` is no document the session may open and no image it shows.
   */
  private inContextAt(p: string, index: ContextIndex): string | null {
    const own = this.canonical(p, index);
    // An image the tree shows answers a link as a document does: the
    // image's backlinks then say where it is used (kit-image-embeds).
    if (index.entryOf.has(own) || index.images.has(own)) return own;
    // A document gone from disk (deleted outside, or moved to the Trash)
    // is held only as a record: a link to it answers nothing.
    return (
      this.m.docs.find((x) => !x.missing && (x.original === p || x.original === own))?.original ??
      null
    );
  }

  // ── a bundle's references (kit-canvas-references) ─────────────────────
  //
  // A bundle whose type reads references (Atlas's board) has links of its own:
  // its type reads them from the main file, says where each could land, and
  // writes and swaps them; the kit decides what each lands on, by the same
  // test a markdown link's target meets (`inContextAt`). They are kept apart
  // from markdown links throughout, so nothing that reads a link's `?rel=` or
  // `#anchor` sees a reference's path.

  /** The candidates that are a bundle's main file whose type reads references. */
  private referenceCandidates(): Candidate[] {
    return this.candidates().filter((c) => referencingBundle(c.path) !== null);
  }

  /** Where the bundle whose main file is `main` is, for its type's questions. */
  private placeOf(main: string, bundle: string, entry: ContextEntry | undefined): ReferencePlace {
    return {
      main,
      bundle,
      entryRoot: entry?.root ?? dirname(bundle),
      isDir: (p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
    };
  }

  /**
   * Where a reference written `raw` in the bundle whose main file is `main`
   * lands: the first of its type's candidates that is on disk, read as a
   * link's target is (in the context, outside it, a file the workspace does
   * not open, a folder). A candidate that is a bundle's folder stands for its
   * main file, as opening one does. `missing` when none is on disk.
   */
  private resolveReference(
    raw: string,
    main: string,
    entry: ContextEntry | undefined,
    index: ContextIndex,
  ): Resolution {
    const rb = referencingBundle(main);
    if (!rb) return { state: "missing", tried: [] };
    const tried = rb.references.candidates(raw, this.placeOf(main, rb.root, entry));
    for (const c of tried) {
      let dir: boolean;
      try {
        dir = statSync(c).isDirectory();
      } catch {
        continue;
      }
      const target = dir ? this.mainOf(c) : c;
      const own = this.inContextAt(target, index);
      if (own !== null) return { state: "in-context", path: own };
      if (dir && target === c) return { state: "folder", path: c };
      return isDocName(target) || isBundleMain(target)
        ? { state: "outside", path: target }
        : { state: "not-a-doc", path: target };
    }
    return { state: "missing", tried };
  }

  /** A bundle's reference as a report shows it: the bundle, named as its row is, and the reference. */
  private referenceView(
    main: string,
    ref: BundleReference,
    entryOf: (path: string) => ContextEntry | undefined,
  ): Omit<ReferenceBacklinkView, "refs"> & ReferenceView {
    const rb = referencingBundle(main) as NonNullable<ReturnType<typeof referencingBundle>>;
    const entry = entryOf(main);
    return {
      source: main,
      bundle: rb.root,
      name: bundleNameAt(rb.root),
      shown: entry ? toPosix(relative(entry.root, rb.root)) : basename(rb.root),
      noun: rb.references.noun,
      part: rb.references.part,
      id: ref.id,
      line: ref.line,
      raw: ref.raw,
      ...(ref.label !== undefined ? { label: ref.label } : {}),
      ...(ref.subpath !== undefined ? { subpath: ref.subpath } : {}),
      from: ref.from,
      to: ref.to,
    };
  }

  /**
   * A candidate's links, read as search reads it (its ACTIVE VERSION when the
   * session holds it, so an unsaved edit counts), from the cache while the file
   * it was read from is unchanged. A document gone from disk has none.
   */
  private linksOf(c: Candidate, read: Set<string>): LinkRef[] {
    return this.readOf(c, read)?.links ?? [];
  }

  /**
   * A candidate's links and facts (`linksOf`'s cache): read once per change of
   * the file they came from, both from the same read. Null for a document gone
   * from disk. `version` reads one of a held document's other versions
   * instead of its active one (the link check's `proposed`).
   */
  private readOf(
    c: Candidate,
    read: Set<string>,
    version?: number,
  ): {
    links: LinkRef[];
    fragments: LinkRef[];
    facts: DocFacts;
    refs: BundleReference[];
    edges: AppEdge[];
    edgeAt?: (EdgeSpot | undefined)[];
  } | null {
    const d = c.slug === null ? undefined : this.m.docs.find((x) => x.slug === c.slug);
    const file = d ? this.versionPath(d, version ?? d.active) : c.path;
    read.add(file);
    let stamp: string;
    try {
      const st = statSync(file);
      stamp = `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return null;
    }
    // Belt and braces: the link layer and the profile survey read
    // `markdownCandidates`, which has no JSON document, but nothing here may
    // run markdown over one.
    // A bundle's main file whose type reads references (a board) has those,
    // read by its type; any other JSON document has nothing here.
    const bundle = referencingBundle(c.path);
    if (docFormat(c.path) === "json" && !bundle)
      return { links: [], fragments: [], facts: NO_FACTS, refs: [], edges: [] };
    const hit = this.linkCache.get(file);
    if (hit?.stamp === stamp) return hit;
    let entry: {
      stamp: string;
      links: LinkRef[];
      fragments: LinkRef[];
      facts: DocFacts;
      refs: BundleReference[];
      edges: AppEdge[];
      edgeAt?: (EdgeSpot | undefined)[];
    };
    if (bundle) {
      try {
        const refs = bundle.references.read(readFileSync(file, "utf8"));
        entry = { stamp, links: [], fragments: [], facts: NO_FACTS, refs, edges: [] };
      } catch {
        return null;
      }
      this.linkCache.set(file, entry);
      return entry;
    }
    try {
      const text = readFileSync(file, "utf8");
      // Scheme targets kept, for the link check; backlinks passes over them.
      // Links to a place in the same document (`#heading`) are read apart,
      // for the link check's headings; nothing that resolves paths sees them.
      const all = extractLinks(text, { schemes: true, fragments: true });
      const facts = docFacts(text);
      // The app's edges, from the same read and kept under the same stamp,
      // so a save or an edit on disk re-reads them with the links.
      const edges = readEdges(this.linkSlot, { path: c.path, text, frontmatter: facts.fields });
      entry = {
        stamp,
        links: all.filter((l) => !l.fragment),
        fragments: all.filter((l) => l.fragment),
        facts,
        refs: [],
        edges,
        ...(edges.length > 0 ? { edgeAt: locateEdges(text, edges) } : {}),
      };
    } catch {
      return null;
    }
    this.linkCache.set(file, entry);
    return entry;
  }

  /**
   * ⛔ THE ONE PLACE A DOCUMENT'S KIND IS DECIDED: the kind of the profile that
   * matches it (the nearest `_meta/profiles/<type>.json`, matched by `type`; see
   * `profilePass`), else its frontmatter `type` exactly as written, or null. A
   * document no profile matches, or whose nearest profile file is broken, keeps
   * the kind it had before profiles, so a world with none behaves as it did. In
   * v1 a profile matches only its own `type`, so the two agree; what changed is
   * where the answer comes from. The graph, its `kind` filter and every map that
   * colours or groups by kind read it from here and nowhere else.
   */
  private kindOf(path: string, facts: DocFacts, profiles: ProfilePass): string | null {
    return this.kindView(path, facts, profiles).kind;
  }

  /**
   * `kindOf`'s answer with what the matched profile says of the kind: its
   * `label` (the kind itself without a profile) and whether it is `canon` (true
   * without a profile, or with a broken one). One match per document.
   */
  private kindView(
    path: string,
    facts: DocFacts,
    profiles: ProfilePass,
  ): { kind: string | null; label?: string; canon: boolean; labelDepth?: number } {
    const m = profiles.match(path, facts);
    return m.state === "matched"
      ? {
          kind: m.profile.kind,
          label: m.profile.label,
          canon: m.profile.canon,
          // The graph labels a kind by its root-most profile.
          labelDepth: m.path.split(sep).length,
        }
      : { kind: facts.type, canon: true };
  }

  /**
   * One pass's profile lookup: the profile each document matches, the nearest
   * folder's file for its `type`, looking up to the root of the context entry
   * that holds it and never above (`profiles.ts`). A folder's profile files are
   * listed once per pass, and each file parsed once per change of its stamp. A
   * document no entry holds matches nothing.
   */
  private profilePass(index: ContextIndex): ProfilePass {
    const lookup = this.profileReader.pass();
    const entryOf = this.entryFinder(index);
    return {
      lookup,
      match: (path, facts) => {
        const entry = entryOf(path);
        if (!entry) return NO_MATCH;
        return lookup.match(dirname(path), entry.root, facts.type);
      },
    };
  }

  /**
   * Every document in the session with how it matched a profile and its
   * warnings, read through the link cache (each document once per change) and
   * one profile pass. Both caches are pruned to what this pass saw.
   *
   * `profileShown` is a profile file's path from the root of the entry whose
   * document first reached it, so a file in a listed document's folder reads
   * from that document's own entry, whatever other entry also covers it. When
   * two files would read the same (two listed entries in different folders,
   * each with `_meta/profiles/location.json`), each is led by its entry's
   * folder name, or failing that given whole.
   */
  private profileSurvey(): {
    rows: {
      path: string;
      shown: string;
      facts: DocFacts;
      match: ProfileMatch;
      warnings: ProfileWarningView[];
    }[];
    lookup: ProfileLookup;
    profileShown: (path: string) => string;
    broken: { files: BrokenProfileView[]; count: number };
    notes: { path: string; shown: string; note: string }[];
  } {
    const index = this.contextIndex();
    const all = this.markdownCandidates();
    const read = new Set<string>();
    const pass = this.profilePass(index);
    const entryOf = this.entryFinder(index);
    const shown = (path: string) => {
      const entry = entryOf(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const rows = all.map((c) => {
      const facts = this.readOf(c, read)?.facts ?? NO_FACTS;
      const match = pass.match(c.path, facts);
      const warnings =
        match.state === "matched" ? checkFields(match.profile, facts.fields ?? {}) : [];
      return { path: c.path, shown: shown(c.path), facts, match, warnings };
    });
    this.pruneLinkCache(read);
    this.profileReader.prune(pass.lookup.seen());
    const lookup = pass.lookup;
    const base = (path: string) => {
      const root = lookup.rootOf(path);
      return root === undefined ? shown(path) : toPosix(relative(root, path));
    };
    const led = (path: string) => {
      const root = lookup.rootOf(path);
      return root === undefined ? path : `${basename(root)}/${base(path)}`;
    };
    const clash = (f: (p: string) => string) => {
      const by = new Map<string, Set<string>>();
      for (const p of lookup.seen()) {
        const k = f(p);
        by.set(k, (by.get(k) ?? new Set()).add(p));
      }
      return (p: string) => (by.get(f(p))?.size ?? 0) > 1;
    };
    const clashes = clash(base);
    const ledClashes = clash(led);
    const profileShown = (path: string) =>
      !clashes(path) ? base(path) : !ledClashes(path) ? led(path) : path;
    // The broken files: each kind file broken in itself, each shared file
    // broken in itself (once, however many kinds refer to it), and each kind
    // broken only through a shared file, which says so and points there.
    // `count` is the files that need a fix.
    const docsOf = new Map<string, number>();
    for (const r of rows)
      if (r.match.state === "broken") docsOf.set(r.match.path, (docsOf.get(r.match.path) ?? 0) + 1);
    const files: BrokenProfileView[] = [];
    for (const l of lookup.loads())
      if (l.broken !== undefined)
        files.push({
          path: l.path,
          shown: profileShown(l.path),
          kind: l.kind,
          reason: l.broken,
          ...(l.through !== undefined ? { through: profileShown(l.through) } : {}),
          documents: docsOf.get(l.path) ?? 0,
        });
    for (const b of lookup.sharedBroken()) {
      const dependents = lookup
        .loads()
        .filter((l) => l.broken !== undefined && l.through === b.path);
      files.push({
        path: b.path,
        shown: profileShown(b.path),
        kind: null,
        reason: b.reason,
        documents: dependents.reduce((n, l) => n + (docsOf.get(l.path) ?? 0), 0),
      });
    }
    files.sort((a, b) => a.shown.localeCompare(b.shown));
    const notes = lookup
      .notes()
      .map((n) => ({ path: n.path, shown: profileShown(n.path), note: n.note }));
    return {
      rows,
      lookup,
      profileShown,
      broken: { files, count: files.filter((f) => f.through === undefined).length },
      notes,
    };
  }

  /**
   * The world's profiles: each usable profile file with the documents it is
   * the nearest for, the `type` values no profile defines, the documents with no
   * `type`, the documents whose frontmatter does not parse, and the broken files
   * with why. It only reads.
   */
  profiles(): ProfilesReport {
    const { rows, lookup, profileShown, broken, notes } = this.profileSurvey();
    const bySource = new Map<string, { documents: number; withWarnings: number }>();
    const unprofiled = new Map<string, number>();
    const unparsed: ProfilesReport["unparsed"]["documents"] = [];
    let untyped = 0;
    for (const r of rows) {
      if (r.facts.unparsed !== null) {
        unparsed.push({ path: r.path, shown: r.shown, reason: r.facts.unparsed });
        continue;
      }
      if (r.match.state === "none") {
        if (r.facts.type === null) untyped++;
        else unprofiled.set(r.facts.type, (unprofiled.get(r.facts.type) ?? 0) + 1);
        continue;
      }
      const n = bySource.get(r.match.path) ?? { documents: 0, withWarnings: 0 };
      n.documents++;
      if (r.warnings.length > 0) n.withWarnings++;
      bySource.set(r.match.path, n);
    }
    const order = (a: { kind: string; shown: string }, b: { kind: string; shown: string }) =>
      a.kind.localeCompare(b.kind) || a.shown.localeCompare(b.shown);
    const kinds: ProfilesReport["kinds"] = [];
    for (const l of lookup.loads()) {
      const n = bySource.get(l.path) ?? { documents: 0, withWarnings: 0 };
      if (l.profile)
        kinds.push({
          kind: l.kind,
          label: l.profile.label,
          canon: l.profile.canon,
          source: l.path,
          shown: profileShown(l.path),
          refs: l.profile.refs.map(profileShown),
          ...n,
        });
    }
    unparsed.sort((a, b) => a.shown.localeCompare(b.shown, undefined, { numeric: true }));
    return {
      documents: rows.length,
      kinds: kinds.sort(order),
      unprofiled: [...unprofiled]
        .map(([type, documents]) => ({ type, documents }))
        .sort((a, b) => b.documents - a.documents || a.type.localeCompare(b.type)),
      untyped,
      unparsed: {
        count: unparsed.length,
        documents: unparsed.slice(0, PROFILE_CHECK_CAP),
      },
      broken: broken.files.map((f) => ({ ...f, documents: f.documents ?? 0 })),
      brokenFiles: broken.count,
      ...(notes.length > 0 ? { notes } : {}),
    };
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
    const index = this.contextIndex();
    const subject = this.linkSubject(key, index);
    // A JSON document (a profile file among them) has no frontmatter to match.
    if (docFormat(subject.path) === "json") {
      const entry = this.entryFinder(index)(subject.path);
      return {
        doc: subject.doc,
        path: subject.path,
        shown: entry ? toPosix(relative(entry.root, subject.path)) : basename(subject.path),
        type: null,
        kind: null,
        canon: true,
        match: "none",
        reason: "a JSON file, not a frontmatter document: profiles describe markdown documents",
        warnings: [],
      };
    }
    const c: Candidate = this.markdownCandidates().find((x) => x.path === subject.path) ?? {
      path: subject.path,
      name: basename(subject.path),
      slug: subject.doc,
      version: null,
    };
    const facts = this.readOf(c, new Set())?.facts ?? NO_FACTS;
    const pass = this.profilePass(index);
    const match = pass.match(c.path, facts);
    const entry = this.entryFinder(index)(c.path);
    const shown = (p: string) => (entry ? toPosix(relative(entry.root, p)) : basename(p));
    // The version the facts were read from, for a held document: the header
    // shows an answer only for the version on screen.
    const held = c.slug === null ? undefined : this.m.docs.find((x) => x.slug === c.slug);
    const base = {
      doc: subject.doc,
      ...(held ? { version: held.active } : {}),
      path: c.path,
      shown: shown(c.path),
      type: facts.type,
      kind: this.kindOf(c.path, facts, pass),
      // Not canon only when a usable profile says so: no profile, or a broken
      // one, leaves the document as it was before profiles.
      canon: match.state === "matched" ? match.profile.canon : true,
    };
    if (match.state === "none") {
      const reason =
        facts.unparsed !== null
          ? `its frontmatter ${facts.unparsed}`
          : !entry
            ? "it is not under a folder in the context, so no profile is looked for"
            : facts.type === null
              ? facts.fields === null
                ? "it has no frontmatter, so no type"
                : "its frontmatter has no type"
              : `no _meta/profiles/${facts.type}.json between its folder and the root of its context entry`;
      return { ...base, match: "none", reason, warnings: [] };
    }
    if (match.state === "broken")
      return {
        ...base,
        match: "broken",
        source: match.path,
        sourceShown: shown(match.path),
        reason: match.reason,
        // Broken only through a shared file: that file is the one to fix.
        ...(match.through !== undefined
          ? { through: match.through, throughShown: shown(match.through) }
          : {}),
        warnings: [],
      };
    const p = match.profile;
    // Each file's fields as that file writes them, the kind's own first: two
    // files may both name a field, and each rule applies (no merging).
    const fields: NonNullable<DocumentProfile["fields"]> = [];
    for (const part of [
      { path: p.path, properties: p.properties, required: p.required },
      ...p.shared,
    ]) {
      const from = { file: part.path, fileShown: shown(part.path) };
      for (const [field, rule] of Object.entries(part.properties))
        fields.push({ field, required: part.required.includes(field), ...ruleView(rule), ...from });
      for (const field of part.required)
        if (!Object.hasOwn(part.properties, field)) fields.push({ field, required: true, ...from });
    }
    return {
      ...base,
      match: "matched",
      label: p.label,
      source: match.path,
      sourceShown: shown(match.path),
      ...(p.description !== undefined ? { description: p.description } : {}),
      // With its fix in words, as `profileCheck` lists it: the header's "Ask
      // the agent to fix" says it, and the agent's `profile` verb shows it.
      warnings: checkFields(p, facts.fields ?? {}).map((w) => ({
        ...w,
        ...(w.file !== undefined ? { fileShown: shown(w.file) } : {}),
        fix: fixFor(w),
      })),
      ...(p.refs.length > 0 ? { refs: p.refs.map(shown) } : {}),
      fields,
    };
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
    const { rows, profileShown, broken: bad, notes } = this.profileSurvey();
    const list: ProfileCheck["warnings"]["list"] = [];
    const more: NonNullable<ProfileCheck["warnings"]["more"]> = [];
    let documents = 0;
    let count = 0;
    for (const r of rows) {
      if (r.match.state !== "matched" || r.warnings.length === 0) continue;
      documents++;
      count += r.warnings.length;
      for (const w of r.warnings.slice(0, PROFILE_WARNINGS_PER_DOC))
        list.push({
          ...w,
          source: r.path,
          name: basename(r.path),
          shown: r.shown,
          kind: r.match.profile.kind,
          profile: profileShown(r.match.path),
          ...(w.file !== undefined ? { fileShown: profileShown(w.file) } : {}),
          fix: fixFor(w),
        });
      if (r.warnings.length > PROFILE_WARNINGS_PER_DOC)
        more.push({
          source: r.path,
          shown: r.shown,
          count: r.warnings.length - PROFILE_WARNINGS_PER_DOC,
        });
    }
    // Stable: a document's warnings keep the order the profile gave them.
    const byShown = (a: { shown: string }, b: { shown: string }) =>
      a.shown.localeCompare(b.shown, undefined, { numeric: true });
    list.sort(byShown);
    more.sort(byShown);
    const broken: ProfileCheck["broken"]["files"] = bad.files.map(({ documents: _d, ...f }) => ({
      ...f,
      fix:
        f.through !== undefined
          ? `fix ${f.through}, which this kind refers to: until it is fixed, a document of type ${JSON.stringify(f.kind)} beneath ${f.shown} matches no profile`
          : f.kind === null
            ? `fix ${f.shown}: until it is fixed, every kind that refers to it matches no document`
            : `fix ${f.shown}: until it is fixed, a document of type ${JSON.stringify(f.kind)} beneath it matches no profile`,
    }));
    return {
      count: count + bad.count,
      warnings: {
        count,
        documents,
        list: list.slice(0, PROFILE_CHECK_CAP),
        ...(more.length > 0 ? { more } : {}),
      },
      broken: { count: bad.count, files: broken },
      ...(notes.length > 0 ? { notes } : {}),
      ...(list.length > PROFILE_CHECK_CAP ? { truncated: true as const } : {}),
    };
  }

  /**
   * The entry that holds a source, as `resolveLink` picks it: the one that lists
   * it, else (a document opened by path) the one whose folder it is in.
   */
  private entryFinder(index: ContextIndex): (path: string) => ContextEntry | undefined {
    const byId = new Map(this.m.context.map((e) => [e.id, e]));
    return (path) => {
      const id = index.entryOf.get(path);
      return (
        (id !== undefined ? byId.get(id) : undefined) ??
        this.m.context.find((e) => path.startsWith(e.root + sep))
      );
    };
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
      const r = this.resolveFrom(written, src, entry, "document", index, "markdown");
      const folderLink = splitTarget(raw).path.endsWith("/");
      if (r.state !== "missing" && (folderLink || r.state !== "folder")) return written;
    }
    return undefined;
  }

  /**
   * Forget what was read for documents the session no longer has (or for a
   * version no longer active), so the cache is bounded by the context, not by
   * everything ever read. Only after a pass that read every candidate.
   */
  private pruneLinkCache(read: Set<string>): void {
    for (const file of this.linkCache.keys()) if (!read.has(file)) this.linkCache.delete(file);
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
    const index = this.contextIndex();
    const all = this.markdownCandidates();
    const read = new Set<string>();
    const entryOf = this.entryFinder(index);
    // ⛔ THE INNERMOST SET WINS for which set a file is in: with `world` and
    // `world/inner` both in the context, `inner/deep.md` is `inner`'s, as the
    // shipped map counted it (whichever was added first). Resolving still goes
    // through `entryOf`, so the check follows a link as a click does.
    const setEntry = (path: string): ContextEntry | undefined => {
      let best = entryOf(path);
      for (const e of this.m.context)
        if (
          e.membership === "mirrored" &&
          path.startsWith(e.root + sep) &&
          (best === undefined || e.root.length > best.root.length)
        )
          best = e;
      return best;
    };
    // From the root of the set it is grouped under (`setEntry`, below).
    const shown = (path: string) => {
      const entry = setEntry(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    // Every image a link or an embed reaches, seen on the way: the unused-images
    // section costs nothing beyond the resolving already done.
    const used = new Set<string>();
    // Where each link landed, kept as it is resolved, so the symmetry hints
    // below resolve nothing again.
    const landed = new Map<string, string>();
    const facts = new Map<string, DocFacts>();
    const sources = all.map((c) => {
      const got = this.readOf(c, read);
      facts.set(c.path, got?.facts ?? NO_FACTS);
      return {
        path: c.path,
        links: got?.links ?? [],
        fragments: got?.fragments ?? [],
        edges: got?.edges ?? [],
        edgeAt: got?.edgeAt ?? [],
      };
    });
    // Links and edges that land outside the set they are written in
    // (kit-broken-links-visible), for an app that asks (`linkCheck.leaving`).
    const leavingLinks: LeavingLinkView[] = [];
    // Only for an app that asks for it (`linkCheck.leaving`).
    const wantLeaving = this.linkCheckOpts.leaving === true;
    const setOf = (path: string) => setEntry(path)?.id;
    /** Where a link from `from` lands, when that is outside `from`'s set; else null. */
    const leaves = (r: Resolution, from: string): { target: string } | null => {
      // ⛔ A LINK TO ONE OF THE SESSION'S OWN DOCUMENTS NEVER LEAVES
      // (scriptorium-broken-links-sign-noise, Cole's ruling 2026-10-22): the
      // session is what the human gathered, so a link between two of its
      // documents stays inside it, whichever sets they are in. Documents added
      // one by one are a set each, and counting every link between them as
      // leaving made the sign say little else.
      if (r.state !== "outside" && r.state !== "not-a-doc") return null;
      const own = setEntry(from);
      if (own === undefined) return null;
      // ⛔ A LISTED ENTRY (documents added on their own) HAS NO FOLDER OF ITS
      // OWN: its root is its document's folder, so the folder rule would take
      // every sibling on disk as inside it. A link from one to a file the
      // session does not hold leaves.
      if (own.membership === "listed") return { target: r.path };
      // A mirrored set: a file in its folder that is not a document (a CSV
      // beside the pages) is inside it; anything else leaves.
      return r.path.startsWith(own.root + sep) ? null : { target: r.path };
    };
    const leavingView = (from: string, target: string) => {
      // The set whose FOLDER holds the target: a listed entry holds only its
      // documents, and a leaving target is none of the session's documents.
      const near = setEntry(target);
      const there =
        near?.membership === "mirrored" && target.startsWith(near.root + sep) ? near : undefined;
      const own = setEntry(from);
      return {
        source: from,
        name: basename(from),
        shown: shown(from),
        target,
        targetShown: there
          ? toPosix(relative(there.root, target))
          : own
            ? toPosix(relative(own.root, target))
            : target,
        ...(there ? { targetSet: there.label } : {}),
        ...(own ? { set: own.id } : {}),
      };
    };
    // The body links that resolve, kept by how they were written, so the
    // leaving list below needs no second resolve.
    const resolvedLinks = new Map<string, Resolution>();
    // A bundle's references whose file nothing answers, beside the documents'
    // dangling links ("card 'The Glade' points at …, which is missing"). Each
    // one that lands on an image counts as that image's use.
    const references: CheckedReferenceView[] = [];
    for (const c of this.referenceCandidates())
      for (const ref of this.readOf(c, read)?.refs ?? []) {
        const r = this.resolveReference(ref.raw, c.path, entryOf(c.path), index);
        if (r.state === "in-context" && index.images.has(r.path)) used.add(r.path);
        if (r.state !== "missing") continue;
        const v = this.referenceView(c.path, ref, entryOf);
        const called = ref.label ?? basename(ref.raw);
        const set = setOf(c.path);
        references.push({
          ...v,
          ...(set !== undefined ? { set } : {}),
          tried: r.tried,
          text: `${v.part} '${called}' points at \`${ref.raw}\`, which is missing`,
        });
      }
    references.sort(
      (a, b) =>
        a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
        a.line - b.line ||
        a.from - b.from,
    );
    const found = danglingLinks(
      sources,
      // ⛔ As written in a DOCUMENT: no chat fallback, as backlinks reads them.
      (raw, from, kind) => {
        const r = this.resolveFrom(raw, from, entryOf(from), "document", index, kind);
        if (r.state === "in-context") {
          if (index.images.has(r.path)) used.add(r.path);
          landed.set(`${from}\0${kind}\0${raw}`, r.path);
        }
        resolvedLinks.set(`${from}\0${kind}\0${raw}`, r);
        return r;
      },
    );
    // The app's edges that nothing answers (kit-link-edges-slot), apart from
    // the body links: a frontmatter reference to a page not written yet.
    const keep = edgeKeeps(opts.edge);
    const danglingEdges: CheckedEdgeView[] = [];
    // The edges nothing answers that are not written as paths (`pathShaped`):
    // a reference in a convention the kit does not know, listed, not counted.
    const unresolvedEdges: CheckedEdgeView[] = [];
    if (this.appEdges)
      for (const s of sources)
        s.edges.forEach((e, i) => {
          if (!keep(e.kind)) return;
          const r = this.resolveFrom(e.target, s.path, entryOf(s.path), "document", index);
          const spot = s.edgeAt[i];
          const line = e.line ?? spot?.line;
          const at = spot ? { from: spot.from, to: spot.to } : {};
          const set = setOf(s.path);
          const out = wantLeaving ? leaves(r, s.path) : null;
          if (out)
            leavingLinks.push({
              ...leavingView(s.path, out.target),
              raw: e.target,
              ...(line !== undefined ? { line } : {}),
              ...(e.label !== undefined ? { label: e.label } : {}),
              ...at,
              edge: e.kind,
              ...(e.key !== undefined ? { key: e.key } : {}),
            });
          if (r.state !== "missing") return;
          (pathShaped(e.target) ? danglingEdges : unresolvedEdges).push({
            source: s.path,
            name: basename(s.path),
            shown: shown(s.path),
            edge: e.kind,
            raw: e.target,
            ...(e.key !== undefined ? { key: e.key } : {}),
            ...(line !== undefined ? { line } : {}),
            ...(e.label !== undefined ? { label: e.label } : {}),
            tried: r.tried,
            ...at,
            ...(set !== undefined ? { set } : {}),
          });
        });
    const edgeOrder = (a: CheckedEdgeView, b: CheckedEdgeView) =>
      a.shown.localeCompare(b.shown, undefined, { numeric: true }) || (a.line ?? 0) - (b.line ?? 0);
    danglingEdges.sort(edgeOrder);
    unresolvedEdges.sort(edgeOrder);
    if (wantLeaving && keep(BODY_LINKS))
      for (const s of sources)
        for (const link of s.links) {
          if (link.scheme !== undefined) continue;
          const r = resolvedLinks.get(`${s.path}\0${link.kind}\0${link.raw}`);
          const out = r && leaves(r, s.path);
          if (!out) continue;
          leavingLinks.push({
            ...leavingView(s.path, out.target),
            raw: link.raw,
            line: link.line,
            ...(link.label !== undefined ? { label: link.label } : {}),
            from: link.from,
            to: link.to,
          });
        }
    leavingLinks.sort(
      (a, b) =>
        a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.from ?? 0) - (b.from ?? 0),
    );
    // Links broken in a version the agent PROPOSED (kit-relink-misses-proposed-
    // versions, Cole's ruling 2026-10-22): written by the agent and never
    // active (`Version.activated`). A move's relink rewrites only the active
    // version, so a proposal made before the move keeps the old target.
    // Reported, never rewritten. A version the human has had active, theirs
    // or one they took from the agent, is history, not a proposal: not read.
    // A link the active version also has broken, as written, is reported
    // there once, not again per version.
    const activeMissing = new Set(found.missing.map((l) => `${l.source}\0${l.raw}`));
    const proposed: ProposedLinkView[] = [];
    if (keep(BODY_LINKS))
      for (const c of all) {
        const d = c.slug === null ? undefined : this.m.docs.find((x) => x.slug === c.slug);
        if (!d || d.versions.length < 2) continue;
        const entry = entryOf(c.path);
        // Where the document was before the moves this daemon made: a link
        // written there reads from there.
        const wasAt = this.movedFrom(c.path);
        for (const v of d.versions) {
          if (v.n === d.active || v.by !== "agent" || v.activated || keptOutside(v)) continue;
          const got = this.readOf(c, read, v.n);
          if (!got) continue;
          // Every broken link of this version, then one act for them all: the
          // fix is ONE new version, so each entry's act names the whole of it.
          const mine: Omit<ProposedLinkView, "act">[] = [];
          for (const link of got.links) {
            if (link.scheme !== undefined) continue;
            if (activeMissing.has(`${c.path}\0${link.raw}`)) continue;
            const r = this.resolveFrom(link.raw, c.path, entry, "document", index, link.kind);
            if (r.state !== "missing") continue;
            const suggest =
              link.kind === "markdown"
                ? this.movedTarget(link.raw, c.path, wasAt, r.tried, entry, index)
                : undefined;
            mine.push({
              source: c.path,
              name: basename(c.path),
              shown: shown(c.path),
              line: link.line,
              raw: link.raw,
              kind: link.kind,
              ...(link.label !== undefined ? { label: link.label } : {}),
              ...(link.embed ? { embed: true as const } : {}),
              context: link.context,
              from: link.from,
              to: link.to,
              ...(setOf(c.path) !== undefined ? { set: setOf(c.path) } : {}),
              doc: d.slug,
              version: v.n,
              tried: r.tried,
              ...(suggest !== undefined ? { suggest } : {}),
            });
          }
          const label = v.label !== undefined ? ` --label ${JSON.stringify(v.label)}` : "";
          const make = `version-new --doc ${d.slug} --from v${v.n}${label} --stdin`;
          const drop = `version-delete v${v.n} --doc ${d.slug}`;
          const all =
            mine.length === 1 ? "its broken link" : `all ${mine.length} of its broken links`;
          for (const l of mine)
            proposed.push({
              ...l,
              act: `Your proposal v${v.n} links \`${l.raw}\` (line ${l.line}), ${
                l.suggest ? `which moved to \`${l.suggest}\`` : "which is missing"
              }${
                mine.length > 1
                  ? `, one of ${mine.length} broken links in v${v.n} (every \`proposed\` entry with version ${v.n})`
                  : ""
              }. Fix ${all} in ONE new version (\`${make}\`, v${v.n}'s text with each fixed${
                mine.some((x) => x.suggest) ? ", written as `suggest` says where it is given" : ""
              }), then delete v${v.n}, your unactivated proposal it replaces (\`${drop}\`).`,
            });
        }
      }
    proposed.sort(
      (a, b) =>
        a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
        a.version - b.version ||
        a.line - b.line ||
        a.from - b.from,
    );
    this.pruneLinkCache(read);
    const view = (l: Omit<DanglingLink, "tried"> | SchemeLink): CheckedLinkView => ({
      source: l.source,
      name: basename(l.source),
      shown: shown(l.source),
      line: l.line,
      raw: l.raw,
      kind: l.kind,
      ...(l.label !== undefined ? { label: l.label } : {}),
      ...(l.embed ? { embed: true as const } : {}),
      context: l.context,
      from: l.from,
      to: l.to,
      ...(setOf(l.source) !== undefined ? { set: setOf(l.source) } : {}),
    });
    const order = (a: CheckedLinkView, b: CheckedLinkView) =>
      a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
      a.line - b.line ||
      a.from - b.from;
    const dangling = found.missing.map((l) => ({ ...view(l), tried: l.tried })).sort(order);
    const unsupported = found.unsupported
      .map((l) => ({ ...view(l), scheme: l.scheme }))
      .sort(order);
    const probed = new Map<string, boolean>();
    const names = duplicateNames(
      all.map((c) => c.path),
      {
        caseInsensitive: (p) => {
          const dir = dirname(p);
          let known = probed.get(dir);
          if (known === undefined) {
            known = caseInsensitiveAt(p);
            probed.set(dir, known);
          }
          return known;
        },
        exists: (p) => existsSync(p),
      },
    ).map((d) => ({
      name: d.name,
      files: d.files.map((f) => ({
        path: f.path,
        shown: shown(f.path),
        suggest: f.suggest,
        ...(setOf(f.path) !== undefined ? { set: setOf(f.path) } : {}),
      })),
    }));
    const unusedImages = [...index.images]
      .filter((p) => basename(dirname(p)) === IMAGES_DIR && !used.has(p))
      .map((path) => ({
        path,
        shown: shown(path),
        ...(setOf(path) !== undefined ? { set: setOf(path) } : {}),
      }))
      .sort((a, b) => a.shown.localeCompare(b.shown, undefined, { numeric: true }));
    // Symmetric relations written one way (kit-link-check-symmetry): which
    // relations are symmetric comes from the vocabulary in force for the
    // document that writes the link. A hint, kept out of `count`.
    const vocabulary = this.relationPass(index);
    const edges: TypedEdge<LinkRef & { source: string }>[] = [];
    for (const s of sources)
      for (const link of s.links) {
        if (link.rel.length === 0 || link.scheme !== undefined) continue;
        const to = landed.get(`${s.path}\0${link.kind}\0${link.raw}`);
        if (to === undefined || !facts.has(to)) continue;
        for (const rel of link.rel)
          edges.push({ from: s.path, to, rel, link: { ...link, source: s.path } });
      }
    const title = (path: string) => {
      const f = facts.get(path) ?? NO_FACTS;
      return f.title ?? f.heading ?? withoutDocExtension(basename(path));
    };
    const symmetry = oneWaySymmetric(
      edges,
      (from, rel) => vocabulary.at(from).relations.get(rel)?.symmetric === true,
    )
      .map(
        (e): SymmetryHint => ({
          ...view(e.link),
          rel: e.rel,
          target: e.to,
          targetShown: shown(e.to),
          hint: `${title(e.from)} ${e.rel} ${title(e.to)}; ${title(e.to)} does not link back`,
        }),
      )
      .sort(order);
    // Links to a heading (kit-heading-links-build): a link whose document
    // resolves but whose anchor names no heading in it is a problem of its own,
    // kept apart from dangling links, with the heading most like it; a bare
    // anchor naming a repeated heading is a hint. Only documents some link
    // names with an anchor are read for headings.
    const missingHeadings: HeadingProblem[] = [];
    const ambiguous: HeadingProblem[] = [];
    // Each link with an anchor, and the document it names a heading in: where
    // it landed, or, for a link that is only `#heading`, the one it is in.
    const anchored: { source: string; link: LinkRef; to: string; anchor: string }[] = [];
    for (const s of sources) {
      for (const link of s.links) {
        if (link.scheme !== undefined || link.embed) continue;
        const anchor = splitTarget(link.raw).anchor;
        if (anchor === undefined) continue;
        const to = landed.get(`${s.path}\0${link.kind}\0${link.raw}`);
        if (to === undefined || index.images.has(to)) continue;
        anchored.push({ source: s.path, link, to, anchor });
      }
      for (const link of s.fragments)
        anchored.push({ source: s.path, link, to: s.path, anchor: link.raw.slice(1) });
    }
    for (const { source, link, to, anchor } of anchored) {
      const hs = this.headingsAt(to);
      if (hs === null) continue;
      const heading = decodePath(anchor);
      const m = findHeading(hs, heading);
      const base = {
        ...view({ ...link, source }),
        heading,
        target: to,
        targetShown: shown(to),
      };
      if (m === null) {
        const near = nearestHeading(hs, heading);
        missingHeadings.push({
          ...base,
          ...(near ? { nearest: headingPlainText(near.text) } : {}),
        });
      } else if (m.ambiguous)
        ambiguous.push({ ...base, nearest: headingPlainText(m.heading.text) });
    }
    for (const file of this.headingCache.keys())
      if (!read.has(file)) this.headingCache.delete(file);
    missingHeadings.sort(order);
    ambiguous.sort(order);
    // A function, not a generic arrow: `<T>(` reads as JSX to a tsx parser,
    // and the import-boundary ward audits every file with one.
    function cut<T>(list: T[]): T[] {
      return list.slice(0, LINK_CHECK_CAP);
    }
    // An `edge` filter without `link` keeps no body link's section.
    if (!keep(BODY_LINKS)) {
      // (The leaving list kept only the edges the filter names already.)
      dangling.length = 0;
      unsupported.length = 0;
      missingHeadings.length = 0;
      ambiguous.length = 0;
      symmetry.length = 0;
    }
    const truncated =
      danglingEdges.length > LINK_CHECK_CAP ||
      missingHeadings.length > LINK_CHECK_CAP ||
      ambiguous.length > LINK_CHECK_CAP ||
      dangling.length > LINK_CHECK_CAP ||
      unsupported.length > LINK_CHECK_CAP ||
      names.length > LINK_CHECK_CAP ||
      unusedImages.length > LINK_CHECK_CAP ||
      symmetry.length > LINK_CHECK_CAP ||
      references.length > LINK_CHECK_CAP ||
      proposed.length > LINK_CHECK_CAP ||
      unresolvedEdges.length > LINK_CHECK_CAP ||
      leavingLinks.length > LINK_CHECK_CAP;
    // Each set's whole, before any list is cut: what a group says it shows
    // part of when the check is truncated. Shared names are the session's.
    // Unresolved references and links leaving the set are listed but not
    // counted, as the sign counts: a set with only those is still named, with
    // a total of 0.
    const totals = new Map<string, number>();
    for (const list of [
      dangling,
      unsupported,
      missingHeadings,
      ambiguous,
      symmetry,
      references,
      danglingEdges,
      proposed,
      unusedImages,
    ] as { set?: string }[][])
      for (const x of list)
        if (x.set !== undefined) totals.set(x.set, (totals.get(x.set) ?? 0) + 1);
    const named = new Set<string | undefined>([
      ...totals.keys(),
      ...cut(unresolvedEdges).map((e) => e.set),
      ...cut(leavingLinks).map((e) => e.set),
      ...cut(names).flatMap((n) => n.files.map((f) => f.set)),
    ]);
    return {
      count:
        dangling.length +
        unsupported.length +
        names.length +
        missingHeadings.length +
        references.length +
        danglingEdges.length +
        proposed.length,
      dangling: { count: dangling.length, links: cut(dangling) },
      proposed: { count: proposed.length, links: cut(proposed) },
      unsupported: {
        count: unsupported.length,
        schemes: [...new Set(unsupported.map((l) => l.scheme))].sort(),
        links: cut(unsupported),
      },
      duplicates: { count: names.length, names: cut(names) },
      unusedImages: { count: unusedImages.length, images: cut(unusedImages) },
      symmetry: { count: symmetry.length, hints: cut(symmetry) },
      headings: { count: missingHeadings.length, links: cut(missingHeadings) },
      ambiguousHeadings: { count: ambiguous.length, hints: cut(ambiguous) },
      references: { count: references.length, links: cut(references) },
      ...(this.appEdges
        ? {
            edges: {
              count: danglingEdges.length,
              kinds: [...new Set(danglingEdges.map((e) => e.edge))].sort(),
              links: cut(danglingEdges),
            },
            unresolved: {
              count: unresolvedEdges.length,
              kinds: [...new Set(unresolvedEdges.map((e) => e.edge))].sort(),
              links: cut(unresolvedEdges),
            },
          }
        : {}),
      ...(wantLeaving ? { leaving: { count: leavingLinks.length, links: cut(leavingLinks) } } : {}),
      ...(this.linkCheckOpts.noun !== undefined ? { noun: this.linkCheckOpts.noun } : {}),
      // Only the sets the answer names, in the context's order.
      sets: this.m.context
        .filter((e) => named.has(e.id))
        .map((e) => ({ id: e.id, label: e.label, total: totals.get(e.id) ?? 0 })),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }

  /**
   * The document a link question is about: `key` is a slug or a held
   * document's name (the open document when absent), or the absolute path of any
   * document in the context, held or not.
   */
  private linkSubject(
    key: string | undefined,
    index: ContextIndex,
    opts: { images?: boolean } = {},
  ): { doc: string | null; path: string } {
    if (key !== undefined && isAbsolute(key) && !this.findDoc(key)) {
      const own = this.canonical(key, index);
      if (index.entryOf.has(own)) return { doc: null, path: own };
      // An image is a link target and nothing more: backlinks ask about one,
      // the graph and the profile never do (they read text).
      if (opts.images && index.images.has(own)) return { doc: null, path: own };
    }
    const d = this.docOrDie(key);
    return { doc: d.slug, path: this.canonical(d.original, index) };
  }

  /**
   * Of `paths`, the ones that are documents in the session's context, each in
   * the context's own form, by the rule `linkSubject` uses: absolute, the same
   * file by realpath, and listed by a context entry. A path that only looks
   * like one (`/etc/passwd`, a `..` that climbs out) is dropped. For what a page
   * says it points at, which the agent then reads.
   */
  /** An image the tree shows whose realpath stays inside its entry, as the file route requires. */
  private imageInside(abs: string): boolean {
    const at = this.imageNodeAt(abs);
    if (!at) return false;
    try {
      this.realInsideOrDie(abs, at.entry, "not pointed at");
      return true;
    } catch {
      return false;
    }
  }

  contextDocs(paths: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const own of this.contextDocEach(paths))
      if (own !== undefined && !out.includes(own)) out.push(own);
    return out;
  }

  /**
   * Each path as `contextDocs` keeps it, in place: canonical when it is a
   * document or an image the tree shows, undefined when it is not. The
   * context's index is built once for the whole list (a message's refs).
   */
  contextDocEach(paths: readonly unknown[]): (string | undefined)[] {
    const index = this.contextIndex();
    return paths.map((p) => {
      if (typeof p !== "string" || !isAbsolute(p)) return undefined;
      const own = this.canonical(resolve(p), index);
      // A document, or an image the tree shows (a message about an image, such
      // as "describe this", points at the image file itself).
      if (index.entryOf.has(own)) return own;
      if (index.images.has(own) && this.imageInside(own)) return own;
      return undefined;
    });
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
    const index = this.contextIndex();
    const focus = opts.focus === undefined ? undefined : this.linkSubject(opts.focus, index).path;
    if (opts.hops !== undefined && (!Number.isInteger(opts.hops) || opts.hops < 0 || opts.hops > 3))
      throw new SessionError(`graph: hops must be 0 to 3, not ${String(opts.hops)}`, 400);
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1))
      throw new SessionError(`graph: limit must be at least 1, not ${String(opts.limit)}`, 400);
    if (opts.within !== undefined && !isAbsolute(opts.within))
      throw new SessionError(`graph: within must be an absolute folder, not ${opts.within}`, 400);
    const within = opts.within === undefined ? undefined : this.canonical(opts.within, index);
    const inside = (p: string) =>
      within === undefined || p === focus || p === within || p.startsWith(within + sep);
    const all = this.markdownCandidates().filter((c) => inside(c.path));
    const read = new Set<string>();
    const facts = new Map<string, DocFacts>();
    const sources = all.map((c) => {
      const got = this.readOf(c, read);
      facts.set(c.path, got?.facts ?? NO_FACTS);
      return { path: c.path, links: got?.links ?? [], edges: got?.edges ?? [] };
    });
    const entryOf = this.entryFinder(index);
    // Boards as nodes of their own kind (`bundles`, off by default): a bundle
    // whose type reads references, of its type's kind, labelled by its noun,
    // not canon (a board is not canon), with an edge to each document,
    // image or bundle it references.
    const bundleDocs: GraphDoc[] = [];
    const referenceEdges: { from: string; to: string }[] = [];
    if (opts.bundles === true)
      for (const c of this.referenceCandidates()) {
        if (!inside(c.path)) continue;
        const rb = referencingBundle(c.path) as NonNullable<ReturnType<typeof referencingBundle>>;
        const noun = rb.references.noun;
        bundleDocs.push({
          path: c.path,
          kind: rb.type.type,
          label: noun.charAt(0).toUpperCase() + noun.slice(1),
          canon: false,
          bundle: { noun },
        });
        for (const ref of this.readOf(c, read)?.refs ?? []) {
          const r = this.resolveReference(ref.raw, c.path, entryOf(c.path), index);
          if (r.state === "in-context") referenceEdges.push({ from: c.path, to: r.path });
        }
      }
    // Only after a pass that read every candidate: a folder's graph read some.
    if (within === undefined) this.pruneLinkCache(read);
    const limit = Math.min(opts.limit ?? GRAPH_CAP, GRAPH_CAP);
    const profiles = this.profilePass(index);
    // Relations are matched case-folded, as the CLI's `--rel` folds them: a wire
    // client asking for `Extends` means `extends`. Folded once, so the filter
    // and the "matches nothing" warning below can never disagree.
    const rels = opts.rel?.map((r) => r.toLowerCase());
    const g = linkGraph(
      [
        ...all.map((c) => ({
          path: c.path,
          ...this.kindView(c.path, facts.get(c.path) ?? NO_FACTS, profiles),
        })),
        ...bundleDocs,
      ],
      sources,
      // ⛔ As written in a DOCUMENT: no chat fallback, as backlinks reads them.
      (raw, from, kind) => this.resolveFrom(raw, from, entryOf(from), "document", index, kind),
      {
        ...(focus !== undefined ? { focus } : {}),
        ...(opts.hops !== undefined ? { hops: opts.hops } : {}),
        ...(rels !== undefined ? { rel: rels } : {}),
        ...(opts.untyped !== undefined ? { untyped: opts.untyped } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
        ...(opts.kindless !== undefined ? { kindless: opts.kindless } : {}),
        ...(opts.edge !== undefined ? { edge: opts.edge } : {}),
        limit,
      },
      referenceEdges,
    );
    const nodes: GraphNodeView[] = g.nodes.map((n) => {
      if (n.bundle) {
        const root = dirname(n.path);
        const entry = entryOf(n.path);
        return {
          path: n.path,
          name: basename(root),
          shown: entry ? toPosix(relative(entry.root, root)) : basename(root),
          title: bundleNameAt(root),
          kind: n.kind,
          label: n.label ?? n.kind,
          canon: false,
          linksIn: n.linksIn,
          linksOut: n.linksOut,
          ...(n.hop !== undefined ? { hop: n.hop } : {}),
          bundle: n.bundle,
        };
      }
      const f = facts.get(n.path) ?? NO_FACTS;
      const entry = entryOf(n.path);
      const name = basename(n.path);
      return {
        path: n.path,
        name,
        shown: entry ? toPosix(relative(entry.root, n.path)) : name,
        title: f.title ?? f.heading ?? withoutDocExtension(name),
        kind: n.kind,
        label: n.kind === null ? null : (n.label ?? n.kind),
        canon: n.canon ?? true,
        ...(f.status !== null ? { status: f.status } : {}),
        linksIn: n.linksIn,
        linksOut: n.linksOut,
        ...(n.hop !== undefined ? { hop: n.hop } : {}),
      };
    });
    // A filter that matches nothing is said, not left to look like an empty world.
    const warnings: string[] = [];
    if (within !== undefined && !all.some((c) => c.path !== focus))
      warnings.push(`within: no document in the session is under ${within}`);
    const kindNames = g.kinds.flatMap((k) => (k.kind === null ? [] : [k.kind]));
    const strayKinds = (opts.kind ?? []).filter((k) => !kindNames.includes(k));
    if (strayKinds.length > 0)
      warnings.push(
        `kind: no document is of kind ${strayKinds.join(", ")}; the kinds are ${kindNames.join(", ") || "none"}`,
      );
    const relNames = g.relations.map((r) => r.rel);
    const strayRels = (rels ?? []).filter((r) => !relNames.includes(r));
    if (strayRels.length > 0)
      warnings.push(
        `rel: no link in view carries ${strayRels.join(", ")}; the relations in view are ${relNames.join(", ") || "none"}`,
      );
    // An edge kind no link among the documents is of (kit-link-edges-slot).
    const edgeNames = g.edgeKinds?.map((k) => k.kind) ?? [BODY_LINKS];
    const strayEdges = (opts.edge ?? []).filter((k) => !edgeNames.includes(k));
    if (strayEdges.length > 0)
      warnings.push(
        `edge: no link is of kind ${strayEdges.join(", ")}; the edge kinds are ${edgeNames.join(", ")}`,
      );
    if (g.total.nodes === 0) warnings.push("the filter left no document");
    return {
      focus: focus ?? null,
      nodes,
      edges: g.edges,
      relations: g.relations,
      untyped: g.untyped,
      kinds: g.kinds,
      ...(g.edgeKinds ? { edgeKinds: g.edgeKinds } : {}),
      total: g.total,
      ...(g.total.nodes > nodes.length ? { truncated: true as const } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
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
    // ⛔ ONE INDEX PER ANSWER. Resolving a link asks "is this in the context?",
    // and `locate` answers by walking every entry's tree: once per link, a hub
    // that 644 of 2,500 documents link to took about 490 ms an ask, on every
    // snapshot while it was open. Built once here, each question is a lookup.
    const index = this.contextIndex();
    const target = this.linkSubject(key, index, { images: true });
    const all = this.markdownCandidates();
    const read = new Set<string>();
    const entryOf = this.entryFinder(index);
    const keep = edgeKeeps(opts.edge);
    const found = backlinksTo(
      target.path,
      all.map((c) => ({
        path: c.path,
        // Belt and braces: a scheme link could never land here anyway, since
        // `resolveTarget` answers `missing` for one; filtering just skips the ask.
        links: keep(BODY_LINKS) ? this.linksOf(c, read).filter((l) => l.scheme === undefined) : [],
      })),
      // ⛔ As written in a DOCUMENT: no chat fallback (see `backlinksTo`).
      (raw, from, kind) => this.resolveFrom(raw, from, entryOf(from), "document", index, kind),
    );
    // The app's edges that land on it (kit-link-edges-slot), apart from the
    // links: Scriptorium's frontmatter references are a claim about the
    // document, a body link a citation in prose. Sifted by name as links are.
    const edges: EdgeBacklinkView[] = [];
    if (this.appEdges) {
      const want = landingName(target.path);
      for (const e of edgeBacklinksTo(
        target.path,
        all.map((c) => ({
          path: c.path,
          edges: (this.readOf(c, read)?.edges ?? []).filter((x) => keep(x.kind)),
        })),
        (raw) => landingName(splitTarget(raw).path) === want,
        (raw, from) => {
          const r = this.resolveFrom(raw, from, entryOf(from), "document", index);
          return r.state === "in-context" ? r.path : null;
        },
      )) {
        const entry = entryOf(e.source);
        edges.push({
          source: e.source,
          name: basename(e.source),
          shown: entry ? toPosix(relative(entry.root, e.source)) : basename(e.source),
          edge: e.kind,
          raw: e.target,
          ...(e.key !== undefined ? { key: e.key } : {}),
          ...(e.line !== undefined ? { line: e.line } : {}),
          rel: [...(e.rel ?? [])],
          ...(e.label !== undefined ? { label: e.label } : {}),
        });
      }
      edges.sort((a, b) => a.shown.localeCompare(b.shown) || (a.line ?? 0) - (b.line ?? 0));
    }
    // The bundles that reference it (the boards it is on), each once with its
    // references to it, apart from the links: a board is not canon. Sifted by
    // the name a reference would end in (a bundle's folder for its main file)
    // before anything is resolved.
    const landing = (p: string) =>
      basename(p.endsWith("/") ? p.slice(0, -1) : p)
        .normalize("NFC")
        .toLowerCase();
    const tb = bundleOf(target.path);
    const wantName = landing(tb && tb.inner === tb.type.main ? tb.root : target.path);
    const bundles: ReferenceBacklinkView[] = [];
    for (const c of this.referenceCandidates()) {
      if (c.path === target.path) continue;
      const refs: ReferenceView[] = [];
      let head: Omit<ReferenceBacklinkView, "refs"> | null = null;
      for (const ref of this.readOf(c, read)?.refs ?? []) {
        const name = landing(ref.raw);
        if (name !== wantName && name !== landing(target.path)) continue;
        const r = this.resolveReference(ref.raw, c.path, entryOf(c.path), index);
        if (r.state !== "in-context" || r.path !== target.path) continue;
        const v = this.referenceView(c.path, ref, entryOf);
        const { source, bundle, name: title, shown, noun, part, ...one } = v;
        head ??= { source, bundle, name: title, shown, noun, part };
        refs.push(one);
      }
      if (head) bundles.push({ ...head, refs });
    }
    bundles.sort((a, b) => a.name.localeCompare(b.name) || a.shown.localeCompare(b.shown));
    this.pruneLinkCache(read);
    const views: BacklinkView[] = found.map((b) => {
      const entry = entryOf(b.source);
      return {
        source: b.source,
        name: basename(b.source),
        shown: entry ? toPosix(relative(entry.root, b.source)) : basename(b.source),
        line: b.line,
        raw: b.raw,
        rel: b.rel,
        kind: b.kind,
        ...(b.label !== undefined ? { label: b.label } : {}),
        ...(b.embed ? { embed: true as const } : {}),
        context: b.context,
        from: b.from,
        to: b.to,
      };
    });
    views.sort((a, b) => a.shown.localeCompare(b.shown) || a.line - b.line);
    const counts = new Map<string, number>();
    let bare = 0;
    for (const v of views) {
      if (v.rel.length === 0) bare++;
      for (const r of v.rel) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    // How each relation reads from THIS end (kit-picker-relation-meanings): a
    // declared inverse ("grounds"), or a symmetric relation's own label. Read
    // from the vocabulary in force here, at the document linked to: a world
    // keeps one, and a reader stands at this end.
    const vocabulary = this.relationPass(index).at(target.path);
    const relations = [...counts]
      .map(([rel, count]) => {
        const def = vocabulary.relations.get(rel);
        const as = def ? readsBack(def) : undefined;
        return { rel, count, ...(as !== undefined ? { as } : {}) };
      })
      .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));
    const kept = views.slice(0, BACKLINK_CAP);
    const keptEdges = edges.slice(0, BACKLINK_CAP);
    return {
      doc: target.doc,
      path: target.path,
      count: views.length,
      backlinks: kept,
      relations,
      bare,
      bundles,
      ...(this.appEdges ? { edges: keptEdges, edgeCount: edges.length } : {}),
      ...(views.length > kept.length || edges.length > keptEdges.length
        ? { truncated: true as const }
        : {}),
    };
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
    return this.summariesOf(paths, false);
  }

  /**
   * `summaries`, with what a card on a board shows besides: each document's
   * frontmatter `description` and how many links it writes. From the same
   * cache, so a board of many cards costs one read per changed document.
   */
  cardSummaries(paths: readonly string[]): DocCardSummary[] {
    return this.summariesOf(paths, true) as DocCardSummary[];
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
    const index = this.contextIndex();
    const entryOf = this.entryFinder(index);
    const byPath = new Map(this.markdownCandidates().map((c) => [c.path, c]));
    const want = new Set<string>();
    for (const p of paths) if (isAbsolute(p)) want.add(this.canonical(p, index));
    const read = new Set<string>();
    const out: { from: string; to: string; anchor?: string }[] = [];
    const seen = new Set<string>();
    for (const from of want) {
      const c = byPath.get(from);
      if (!c) continue;
      for (const l of this.linksOf(c, read)) {
        if (l.scheme !== undefined) continue;
        // ⛔ As written in a DOCUMENT: no chat fallback, as backlinks reads them.
        const r = this.resolveFrom(l.raw, from, entryOf(from), "document", index, l.kind);
        if (r.state !== "in-context" || r.path === from || !want.has(r.path)) continue;
        const hash = l.raw.indexOf("#");
        const anchor = hash === -1 ? "" : l.raw.slice(hash + 1);
        const key = `${from}\0${r.path}\0${anchor}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ from, to: r.path, ...(anchor !== "" ? { anchor } : {}) });
      }
    }
    return out;
  }

  private summariesOf(paths: readonly string[], card: boolean): DocSummary[] {
    const index = this.contextIndex();
    const entryOf = this.entryFinder(index);
    const profiles = this.profilePass(index);
    const byPath = new Map(this.markdownCandidates().map((c) => [c.path, c]));
    const read = new Set<string>();
    const out: DocSummary[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      if (!isAbsolute(p)) continue;
      const own = this.canonical(p, index);
      const c = byPath.get(own);
      if (!c || seen.has(own)) continue;
      seen.add(own);
      const facts = this.readOf(c, read)?.facts ?? NO_FACTS;
      const k = this.kindView(own, facts, profiles);
      const entry = entryOf(own);
      const name = basename(own);
      out.push({
        path: own,
        name,
        shown: entry ? toPosix(relative(entry.root, own)) : name,
        title: facts.title ?? facts.heading ?? withoutDocExtension(name),
        kind: k.kind,
        label: k.kind === null ? null : (k.label ?? k.kind),
        canon: k.canon,
        ...(facts.status !== null ? { status: facts.status } : {}),
        ...(card ? cardFacts(facts, this.linksOf(c, read)) : {}),
      });
    }
    return out;
  }

  /**
   * The text of a held version, or of the active version or the file: the
   * version asked for must be one the session holds for that document.
   */
  private subjectText(
    subject: { doc: string | null; path: string },
    version: number | undefined,
  ): { text: string; version: number | null } {
    if (version !== undefined) {
      const d = subject.doc === null ? undefined : this.findDoc(subject.doc);
      if (!d)
        throw new SessionError(
          `${this.display(subject.path)} is not open in the session, so it has no v${version}`,
          404,
        );
      this.versionOrDie(d, version);
      return { text: readFileSync(this.versionPath(d, version), "utf8"), version };
    }
    const c = this.candidates().find((x) => x.path === subject.path);
    if (!c) throw new SessionError(`no document ${subject.path} in this session`, 404);
    return { text: this.candidateText(c), version: c.version };
  }

  /**
   * One document's text as the session holds it: its active version (an unsaved
   * edit counts, as search reads it), a held version when `version` names one,
   * or the file for a document the session does not hold. `key` is what
   * backlinks takes. It only reads.
   */
  documentText(key?: string, version?: number): DocText {
    const index = this.contextIndex();
    const subject = this.linkSubject(key, index);
    const got = this.subjectText(subject, version);
    const entry = this.entryFinder(index)(subject.path);
    return {
      path: subject.path,
      shown: entry ? toPosix(relative(entry.root, subject.path)) : basename(subject.path),
      version: got.version,
      text: got.text,
    };
  }

  /**
   * The links a document writes, each followed from where it is written as
   * backlinks follow them, with where it landed: a document in the session, a
   * file outside it, nothing, or a scheme (`op:doc/…` opens nothing here;
   * `https:` opens outward). Read from the active version, or the held version
   * `version` names. `key` is what backlinks takes. It only reads.
   */
  outlinks(key?: string, version?: number): Outlinks {
    const index = this.contextIndex();
    const subject = this.linkSubject(key, index);
    const entryOf = this.entryFinder(index);
    let links: LinkRef[];
    let read: number | null;
    if (version !== undefined) {
      const got = this.subjectText(subject, version);
      links = docFormat(subject.path) === "json" ? [] : extractLinks(got.text, { schemes: true });
      read = got.version;
    } else {
      const c = this.markdownCandidates().find((x) => x.path === subject.path);
      links = c ? this.linksOf(c, new Set()) : [];
      read = c?.version ?? null;
    }
    const entry = entryOf(subject.path);
    const views: OutlinkView[] = links.map((l) => {
      const base = {
        line: l.line,
        raw: l.raw,
        rel: l.rel,
        kind: l.kind,
        ...(l.label !== undefined ? { label: l.label } : {}),
        ...(l.embed ? { embed: true as const } : {}),
        context: l.context,
        from: l.from,
        to: l.to,
      };
      if (l.scheme !== undefined)
        return { ...base, state: "scheme", scheme: l.scheme, outward: OUTWARD.has(l.scheme) };
      const r = this.resolveFrom(l.raw, subject.path, entry, "document", index, l.kind);
      return r.state === "missing" ? { ...base, state: r.state } : { ...base, ...r };
    });
    const kept = views.slice(0, BACKLINK_CAP);
    return {
      path: subject.path,
      shown: entry ? toPosix(relative(entry.root, subject.path)) : basename(subject.path),
      version: read,
      count: views.length,
      links: kept,
      ...(views.length > kept.length ? { truncated: true as const } : {}),
    };
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
      relations: this.vocabularyHealth(this.contextIndex()),
    });
  }

  /**
   * Everything worth looking at in this session. It only looks: repairing would
   * mean deciding for the human that a ghost entry is not wanted back and that
   * versions held for a vanished file are not worth saving.
   */
  checkup(): Finding[] {
    const nodes: { entry: string; path: string; shown: string; exists: boolean }[] = [];
    for (const e of this.m.context)
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
      relations: this.vocabularyHealth(this.contextIndex()),
      links: {
        // A bundle's broken references (a board's cards) are broken links too.
        dangling: check.dangling.count + check.references.count,
        unsupported: check.unsupported.count,
        schemes: check.unsupported.schemes,
        duplicates: check.duplicates.count,
        headings: check.headings.count,
        proposed: check.proposed?.count ?? 0,
      },
      docs: this.m.docs.map((d) => ({
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
      sessionId: this.m.sessionId,
      dir: this.dir,
      workspace: this.workspace,
      context: this.m.context,
      docs: this.m.docs.map((d) => this.docView(d)),
      openDoc: this.m.openDoc,
      openImage: this.imageView(),
      chat: this.m.chat,
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

/**
 * ⛔ Refuse a manifest that is not this app's own, by its shape, never by its
 * path. Scriptorium's session manifests say `format: 1` too, and a restore that
 * took one would throw on a missing `tasks` or, worse, misread `who`, times in
 * milliseconds and `author` without a word, then persist it as the kit's.
 *
 * - Scriptorium's shape (millisecond `createdAt`, chat by `who`) is refused
 *   whatever else the manifest carries, an `app` slot included.
 * - The kit always writes an `app` slot (an object); a manifest without one is
 *   not the kit's.
 * - `appName` names the app that wrote it; another app's is refused.
 * - Stamped (`appName` present): the slot's `version` is a whole number from 0,
 *   as every stamping build writes it.
 * - Unstamped: a kit manifest from before `appName`. It is told from a foreign
 *   one by the kit's own marks: an ISO `createdAt` (a string), and a slot
 *   `version` that is absent (migrated from 0) or a whole number from 0.
 */
/**
 * Refuses (409) a manifest that is this app's but not of the shape a restore
 * reads: the lists it walks, and the fields of each entry it reads, are of
 * their type. Nothing is changed or written before it answers.
 */
function refuseMalformedManifest(raw: Record<string, unknown>, sessionId: string): void {
  const refuse = (what: string): never => {
    throw new SessionError(
      `session ${sessionId} has a malformed manifest: ${what}. Nothing was changed`,
      409,
      undefined,
      "the manifest was edited by hand or written by something else: fix it, or start a new session",
    );
  };
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const list = (key: string): Record<string, unknown>[] => {
    const v = raw[key];
    if (!Array.isArray(v)) return refuse(`\`${key}\` is not a list`);
    v.forEach((x, i) => {
      if (!isObj(x)) refuse(`\`${key}[${i}]\` is not an object`);
    });
    return v as Record<string, unknown>[];
  };
  const fields = (at: string, o: Record<string, unknown>, spec: Record<string, string>) => {
    for (const [k, type] of Object.entries(spec)) {
      const v = o[k];
      const ok =
        type === "list"
          ? Array.isArray(v)
          : type === "number"
            ? typeof v === "number" && Number.isFinite(v)
            : typeof v === type;
      if (!ok) refuse(`\`${at}.${k}\` is not ${type === "list" ? "a list" : `a ${type}`}`);
    }
  };
  list("context").forEach((e, i) => {
    fields(`context[${i}]`, e, {
      id: "string",
      root: "string",
      membership: "string",
      nodes: "list",
    });
    // A relative root would be read against the daemon's working directory.
    if (!isAbsolute(e.root as string)) refuse(`\`context[${i}].root\` is not a full path`);
  });
  list("docs").forEach((d, i) => {
    fields(`docs[${i}]`, d, {
      slug: "string",
      name: "string",
      original: "string",
      versions: "list",
      active: "number",
      notes: "list",
    });
    // ⛔ Both become part of a path the kit writes (`docs/<slug>/v<n><ext>`):
    // one that climbs out would put a version anywhere (`safeNames.ts`).
    const badSlug = safeSlug(d.slug);
    if (badSlug !== null) refuse(`\`docs[${i}].slug\` is not one safe folder name: ${badSlug}`);
    const badExt = safeExt(d.ext);
    if (badExt !== null) refuse(`\`docs[${i}].ext\` is not a plain extension: ${badExt}`);
    (d.versions as unknown[]).forEach((v, j) => {
      if (!isObj(v)) refuse(`\`docs[${i}].versions[${j}]\` is not an object`);
      fields(`docs[${i}].versions[${j}]`, v as Record<string, unknown>, { n: "number" });
    });
    (d.notes as unknown[]).forEach((n, j) => {
      if (!isObj(n)) refuse(`\`docs[${i}].notes[${j}]\` is not an object`);
    });
  });
  list("chat");
  list("tasks").forEach((t, i) => {
    fields(`tasks[${i}]`, t, { id: "string", status: "string" });
  });
  if (raw.openDoc != null && typeof raw.openDoc !== "string")
    refuse("`openDoc` is not a string or null");
}

function refuseForeignManifest(
  raw: Record<string, unknown>,
  app: AppDeclaration,
  sessionId: string,
): void {
  const refuse = (message: string, what: string): never => {
    throw new SessionError(
      `session ${sessionId} was not written by ${app.name}: ${message}`,
      409,
      undefined,
      `it looks like ${what}. Restore it with the app that wrote it; ${app.name} will not read it`,
    );
  };
  if (looksLikeScriptorium(raw))
    refuse(
      "its manifest has Scriptorium's shape",
      "a Scriptorium session (format 1, times in milliseconds, chat by `who`)",
    );
  const slot = raw.app;
  if (slot === null || typeof slot !== "object" || Array.isArray(slot))
    refuse(
      "its manifest has no app slot",
      "a manifest with no `app` slot, so not one a workspace-kit app wrote",
    );
  const owner = raw.appName;
  if (owner !== undefined && owner !== app.name) {
    const name = typeof owner === "string" ? owner : JSON.stringify(owner);
    throw new SessionError(
      `session ${sessionId} belongs to ${name}, not ${app.name}`,
      409,
      undefined,
      `it looks like a ${name} session. Restore it with ${name}; ${app.name} will not read it`,
    );
  }
  const version = (slot as Record<string, unknown>).version;
  const wholeVersion = typeof version === "number" && Number.isInteger(version) && version >= 0;
  if (owner === undefined) {
    if (typeof raw.createdAt !== "string")
      refuse(
        "its manifest has no `appName` and no ISO `createdAt`",
        "a manifest no workspace-kit app wrote",
      );
    if (version !== undefined && !wholeVersion)
      refuse(
        `its app slot's version is ${JSON.stringify(version)}`,
        "a manifest no workspace-kit app wrote",
      );
  } else if (!wholeVersion)
    refuse(
      `its app slot's version is ${JSON.stringify(version)}, not a whole number`,
      "a damaged or hand-made manifest",
    );
}

/** Scriptorium's manifest: `createdAt` in milliseconds, or chat messages that say `who`. */
function looksLikeScriptorium(raw: Record<string, unknown>): boolean {
  if (typeof raw.createdAt === "number") return true;
  return (
    Array.isArray(raw.chat) &&
    raw.chat.some((m) => m !== null && typeof m === "object" && "who" in m)
  );
}

/** Bring a stored app slot to the declared version, or refuse one from the future. */
function migrateSlot(
  app: AppDeclaration,
  stored: unknown,
  sessionId: string,
  report: RestoreReport,
): Session["app"] {
  const raw = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const { version, ...prev } = raw;
  const prevVersion = typeof version === "number" && Number.isInteger(version) ? version : 0;
  if (prevVersion > app.slot.version)
    throw new SessionError(
      `session ${sessionId} was written by a newer ${app.name} (app data version ${prevVersion}; this build reads up to ${app.slot.version})`,
      409,
    );
  if (prevVersion === app.slot.version) return { ...prev, version: prevVersion };
  report.slotMigratedFrom = prevVersion;
  const next = app.slot.migrate(prev, prevVersion);
  if ("version" in next) throw new Error(`app ${app.name}: migrate() may not set \`version\``);
  return { ...next, version: app.slot.version };
}

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
 * Whether anything is at `abs`, a dangling link included: what a name a
 * create or a copy is about to take is checked with. `existsSync` follows a
 * link, and calls a dangling one free.
 */
export function entryAt(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** How far `freeName` counts from 2 before a default name is refused. */
const FREE_NAME_TRIES = 100_000;
/** How far `copyName` counts after "copy" before a copy is refused. */
const COPY_NAME_TRIES = 100_000;

/** A copy suffix at a stem's end: ` copy`, ` copy 2`. */
const COPY_SUFFIX = / copy(?: \d+)?$/;

/** A name without the copy suffix it ends in: `Ch 4` for `Ch 4 copy 2`, and for `Ch 4`. */
export function uncopied(stem: string): string {
  return stem.replace(COPY_SUFFIX, "") || stem;
}

/**
 * The name a copy of `name` takes in `dir`, as Finder names one: the stem
 * without any copy suffix it has, then ` copy`, else ` copy N` with N the
 * first free number from 2, then `ext` (a bundle's own; `""` for a folder).
 * `Ch 4.md` gives `Ch 4 copy.md`, then `Ch 4 copy 2.md`; a copy of `Ch 4
 * copy.md` is the next free `Ch 4 copy N.md`, never `Ch 4 copy copy.md`. A
 * long stem is shortened to fit the name limit, never the suffix. `suffix`
 * is what followed the stem (` copy 2`), for a bundle's title. Bounded:
 * past COPY_NAME_TRIES it is refused rather than counted further.
 */
export function copyName(dir: string, name: string, ext: string): { name: string; suffix: string } {
  const own = ext ? name.slice(0, name.length - ext.length) : name;
  const stem = uncopied(own);
  for (let i = 1; i < 1 + COPY_NAME_TRIES; i++) {
    const suffix = i === 1 ? " copy" : ` copy ${i}`;
    const n = fitName(stem, `${suffix}${ext}`);
    if (!entryAt(join(dir, n))) return { name: n, suffix };
  }
  throw new SessionError(`no free name for a copy of ${name} is left in ${tilde(dir)}`, 409);
}

/**
 * The bundle a folder is in, by its name or, through a link, by where it
 * really is; else null.
 */
export function bundleHolding(dir: string): ReturnType<typeof bundleOf> {
  return bundleOf(dir) ?? bundleOf(realOr(dir));
}

/** Refuse a workspace folder inside a bundle, as it is named or as it really is. */
function refuseWorkspaceInBundle(dir: string): void {
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
function refuseInBundle(dir: string, what: string): void {
  if (isMemberDir(dir) && isMemberDir(realOr(dir))) return;
  const inBundle = bundleHolding(dir);
  if (inBundle)
    throw new SessionError(
      `${what} (${tilde(dir)}) is inside the ${inBundle.type.label} ${bundleNameAt(inBundle.root)}: ${outsideMembers(inBundle.type)}`,
      409,
    );
}

/** What may be written into a bundle of `type` from here, said after a refusal. */
function outsideMembers(type: BundleType): string {
  const members = type.expand?.members ?? [];
  return members.length === 0
    ? `nothing is written into a ${type.label} from here`
    : `only its ${members.map((m) => `${m}/`).join(" and ")} folder${members.length === 1 ? "" : "s"} can be written into from here`;
}

/** A name as a slug reads it: lower case, runs of anything but letters, digits, `_` and `-` as one `-`. */
function slugBase(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "doc"
  );
}

/** A bundle's name as its row shows it, read from its `info.json` on disk. */
export function bundleNameAt(abs: string): string {
  const title = readBundleInfo(abs)?.title;
  return bundleDisplayName(basename(abs), typeof title === "string" ? title : undefined);
}

/**
 * How a comparison side reads in a message to a human or an agent. The file is
 * named, not described: "the original" sounds temporal when the thing is
 * locational, and "save to the saved file" says nothing. So it gets its own
 * name, `note.md`.
 *
 * `file` is the document's name when the caller knows it; without one this falls
 * back to a generic, for contexts that have no document in hand.
 */
export function sideName(side: DiffSide, file?: string): string {
  if (side !== "original") return `v${side}`;
  return file ?? "the saved file";
}
