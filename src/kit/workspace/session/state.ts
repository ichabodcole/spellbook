/**
 * The session's core: its record (the manifest `m`), where it lives, and
 * writing the record. Every part takes it. Tier 1 of the session parts
 * (docs/architecture/workspace-session.md); it imports only tier 0.
 *
 * The facade builds it first and hands it to each part as `core`, so a part
 * reads and changes the record as `this.core.m`. `persist` writes the record;
 * a part that keeps something of its own in it adds it through `addToRecord`,
 * which `persist` runs just before each write (Story Studio's chats do).
 */

import { realpathSync } from "node:fs";
import { join } from "node:path";
import { type Disk, sessionDisk } from "../disk";
import type { ClosedBy } from "../events";
import { hasHomeWorkspace } from "../noHome";
import type { Doc, Session } from "../protocol";
import { safeExt, safeSlug } from "../safeNames";
import { SessionError } from "./errors.ts";
import { IMPORTED_DIR } from "./facts.ts";
import { nowIso } from "./names.ts";
import { realOr } from "./paths.ts";
import type { AppDeclaration } from "./types.ts";

/** A refusal at the write: the session's 409. */
export const refuseWrite = (message: string): Error => new SessionError(message, 409);

export class State {
  readonly dir: string;
  /** The record: what `persist` writes as `manifest.json`. */
  m: Session;
  /** What other parts add to the record before it is written (`addToRecord`). */
  private readonly additions: (() => void)[] = [];

  constructor(
    readonly sessionsRoot: string,
    readonly app: AppDeclaration,
    manifest: Session,
  ) {
    this.m = manifest;
    this.dir = join(sessionsRoot, manifest.sessionId);
  }

  /**
   * The hook for a part that keeps state of its own in the record: `add` runs
   * just before each write of the manifest, and puts it into `m`.
   */
  addToRecord(add: () => void): void {
    this.additions.push(add);
  }

  get id(): string {
    return this.m.sessionId;
  }

  get docsDir(): string {
    return join(this.dir, "docs");
  }

  /** Whether the app keeps a home workspace (`AppDeclaration.homeWorkspace`). */
  get hasHome(): boolean {
    return hasHomeWorkspace(this.app);
  }

  /** The folder dropped files and new top-level documents land in. */
  get workspace(): string {
    return this.m.workspace ?? join(this.dir, IMPORTED_DIR);
  }

  /** Record who ended the session; the daemon's close persists it next. */
  markEnded(by: ClosedBy): void {
    this.m.ended = { by, at: nowIso() };
  }

  /** Write the manifest, atomically. Call it on status changes, never on progress ticks. */
  persist(): void {
    this.own.mkdir(this.dir, { recursive: true });
    this.dirStillOrDie();
    for (const add of this.additions) add();
    this.own.writeAtomic(join(this.dir, "manifest.json"), `${JSON.stringify(this.m, null, 2)}\n`);
  }

  /**
   * Where the session folder really was when it was opened (its realpath),
   * taken once the folder exists (`pinDir`). Every write to the session's own
   * files checks the folder still leads there.
   */
  realDir: string | undefined;

  /**
   * The app's own folder, where its sessions, settings and logs live, when the
   * daemon names one (`WorkspaceDaemonOptions.appHome`). Without it only the
   * sessions root is guarded.
   */
  appHome: string | undefined;

  /**
   * ⛔ THE SESSION'S OWN WRITER: its manifest, versions and the folders for
   * them. Only inside the session folder, as written and as the disk resolves
   * it against the folder's realpath at open (`sessionDisk` in `./disk.ts`).
   */
  readonly own: Disk = sessionDisk(
    () => ({ dir: this.dir, ...(this.realDir !== undefined ? { realDir: this.realDir } : {}) }),
    refuseWrite,
  );

  /** Take the session folder's realpath, once: called as a session is made or restored. */
  pinDir(): void {
    if (this.realDir === undefined) this.realDir = realpathSync(this.dir);
  }

  /**
   * ⛔ THE SESSION'S FILES ARE WRITTEN WHERE THE SESSION WAS OPENED. A sessions
   * folder (or one session's) swapped for a link after the open would carry
   * every later write to wherever the link leads: someone else's sessions, a
   * real home a dry run was kept away from. Refused, and nothing is written.
   */
  dirStillOrDie(): void {
    if (this.realDir === undefined) return;
    const now = realOr(this.dir);
    if (now !== this.realDir)
      throw new SessionError(
        `the session folder ${this.dir} now leads to ${now}, not where this session was opened (${this.realDir}): nothing was written`,
        409,
      );
  }

  /**
   * `<docs>/<slug>/v<n><ext>`. ⛔ Refused unless the slug is one safe name and
   * the extension a plain one (`safeSlug`, `safeExt`): the manifest check
   * refuses both on restore, so this only fires on a manifest changed under a
   * live session. Writes also check where the path really leads (`ownFileOrDie`).
   */
  versionPath(d: Doc, n: number): string {
    if (safeSlug(d.slug) !== null || safeExt(d.ext) !== null)
      throw new SessionError(
        `${JSON.stringify(d.slug)} (${JSON.stringify(d.ext)}) does not name a version file inside this session`,
        409,
      );
    return join(this.docsDir, d.slug, `v${n}${d.ext}`);
  }
}
