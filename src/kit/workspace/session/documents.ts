/**
 * The documents the session holds and their versions: finding one
 * (`findDoc`, `docOrDie`), opening one (`openPath`), the human's edits to the
 * active version (`edit`, `editLeft`, with check-before-write), making,
 * deleting and activating versions, and what every other part asks of a
 * document (`activeText`, `isDirty`, `jsonProblemOf`, `refuseInvalidJson`).
 * Tier 3 of the session parts (docs/architecture/workspace-session.md); it
 * takes the core, `places`, `writes` and the `viewer`, and the facade's
 * `persist` as a hook, so a test that replaces `persist` on a session still
 * sees every write.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { bundleDisplayName, bundleOf, bundleStem, isBundleMain } from "../../lib/bundles.ts";
import { docFormat } from "../../lib/docFormat.ts";
import { describeJsonProblem, type JsonProblem, jsonProblem } from "../../lib/json.ts";
import type { Author, Doc, Version } from "../protocol";
import { docExtensions, docPaths, isDocName, locate, readBundleInfo, toPosix } from "../tree";
import { SessionError } from "./errors.ts";
import { bundleNameAt, contentHash, nowIso, slugBase } from "./names.ts";
import { realOr } from "./paths.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";
import type { Viewer } from "./viewer.ts";
import type { Writes } from "./writes.ts";

export class Documents {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly writes: Writes,
    private readonly viewer: Viewer,
    private readonly hooks: { persist: () => void },
  ) {}

  /** slug to hash of the active version's current text. */
  private activeHash = new Map<string, string>();
  /** slug to the active version's text as the daemon last wrote (or adopted) it:
   *  what an outside write to the active version is reverted to. */
  lastActiveText = new Map<string, string>();

  adoptActive(d: Doc, text: string): void {
    const p = this.core.versionPath(d, d.active);
    this.writes.own(p, text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  writeActive(d: Doc, text: string): void {
    this.writes.writeVersion(this.core.versionPath(d, d.active), text);
    this.activeHash.set(d.slug, contentHash(text));
    this.lastActiveText.set(d.slug, text);
  }

  /** Keep an outside write to the active version as a new agent version. */
  preserveOutside(d: Doc, text: string): Version & { path: string } {
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
    this.hooks.persist();
    return { ...rec, path: this.core.versionPath(d, n) };
  }

  /**
   * `takesPath`: the verb asking takes the absolute path of any document in
   * the context, open or not (`version-new` and `show` open it; the link
   * questions read it), so such a path is a choice too.
   */
  docOrDie(slug?: string, opts: { takesPath?: boolean } = {}): Doc {
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
  docAlias(d: Doc): string | undefined {
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
  takeVersion(d: Doc): number {
    const n = d.nextVersion;
    d.nextVersion = n + 1;
    return n;
  }

  versionOrDie(d: Doc, n: number): Version {
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
  mainOf(abs: string): string {
    const b = bundleOf(abs);
    return b && b.inner === "" ? join(abs, b.type.main) : abs;
  }

  /** A document's name as it is shown: a bundle's main file by its bundle's title. */
  docName(d: Doc): string {
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
      if (focus) this.viewer.showDoc(existing.slug);
      this.hooks.persist();
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
    if (focus) this.viewer.showDoc(d.slug);
    this.hooks.persist();
    return { slug: d.slug, created: true };
  }

  openSlug(slug: string): void {
    this.viewer.showDoc(this.docOrDie(slug).slug);
    this.hooks.persist();
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
    const staged = this.core.own.stage(path, text, "edit");
    let preserved: (Version & { path: string }) | null = null;
    let landed = false;
    try {
      let onDisk: string | null = null;
      try {
        onDisk = readFileSync(path, "utf8");
      } catch {
        onDisk = null;
      }
      if (onDisk !== null && !this.writes.isOwnWrite(path, onDisk))
        preserved = this.preserveOutside(d, onDisk);
      this.writes.own(path, text);
      this.core.own.rename(staged, path);
      landed = true;
    } finally {
      // A failed edit leaves nothing behind: the staged file goes with it.
      if (!landed)
        try {
          this.core.own.unlink(staged);
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
      if (onDisk !== null && (onDisk === text || this.writes.isOwnWrite(path, onDisk))) {
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
    this.hooks.persist();
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
    this.hooks.persist();
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
      this.core.own.rm(path);
    } catch (e) {
      if (e instanceof SessionError) throw e;
      // The record is what the session believes; a file already gone (a hand
      // tidy, a crash between write and record) must not block removing it.
    }
    this.writes.disown(path);
    this.hooks.persist();
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
    this.hooks.persist();
    return { slug: d.slug, previous };
  }

  /** The active version's text: what every note is anchored against. */
  activeText(d: Doc): string {
    return readFileSync(this.core.versionPath(d, d.active), "utf8");
  }

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
  refuseInvalidJson(d: Doc, version: number, text: string, what: string): void {
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

  isDirty(d: Doc): boolean {
    return (this.activeHash.get(d.slug) ?? "") !== d.originalHash;
  }
}
