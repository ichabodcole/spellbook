/**
 * The shipped Scriptorium's sessions, converted for the kit path: the app's
 * whole-manifest migrate (`AppDeclaration.migrateManifest`).
 *
 * Only the daemon's app carries it (`daemonApp`, `./server.ts`): only the
 * daemon restores, so the CLI's bundle need not. Every session a daemon
 * restores from `$SCRIPTORIUM_HOME/sessions` passes through it, and a manifest
 * already in the kit's shape passes through untouched.
 *
 * Every shape the shipped writer has put on disk (read from `git log -p` on
 * `../session.ts` and `../protocol.ts`, 2026-09-11 to 2026-10-01) is one
 * manifest with optional parts, so one converter takes them all:
 *
 * | shipped (`../protocol.ts`, `Manifest`)     | kit (`kit/workspace/protocol.ts`, `Session`)          |
 * | ------------------------------------------ | ----------------------------------------------------- |
 * | `createdAt`, `ts`, `at`: milliseconds      | ISO 8601 strings                                      |
 * | no `appName`, no `app`                     | `appName: "scriptorium"`, `app` at the slot version   |
 * | `workspace` (absent before 923ee09a: home) | an added folder (`context`); no `workspace` (the kit path has no home one) |
 * | `context[].hidden` (923ee09a)              | `app.hidden[<entry id>]`                              |
 * | `docs[].versions[]`: `author`, `from`      | `by`, `fromVersion`                                   |
 * | `docs[].nextVersion` (absent before e2a756e6) | required: past every number used, on disk too     |
 * | `docs[].notes` (absent before 8c5d5e9a)    | required list                                         |
 * | `docs[].admitted` (absent before 1f328241) | required boolean (absent: not admitted)               |
 * | `notes[]`: `who`, ms times; `editedAt` (38a378e1), `editedBy` (e9c219c0), `reopenedAt`/`By` (8a65c39d) | `by`, ISO times, the same E65 fields |
 * | `chat[]`: `who`, `ts`, `selection`, `activePath`, `note` (8a65c39d) | `from`, `type`, `ts`, `about`, `via: "ask"` |
 * | `tasks` (absent before c810d3dd): `text`, `who`, `status` (a step), `doneAt` | `title`, `by`, `status` (open/running/done), `detail`, `updatedAt` |
 * | `ended: {by, at}` (56929d27)               | `ended: {by, at: ISO}` (a restore clears it anyway)   |
 *
 * It reads the disk only to look (version files for `nextVersion`, the old
 * workspace folder); it writes nothing. A manifest it cannot read as the
 * shipped shape is refused with the field that is wrong.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import type {
  ManifestMigrateContext,
  ManifestMigration,
} from "../../../kit/workspace/manifestMigrate";
import { notAddedWhole } from "../../../kit/workspace/noHome";
import { safeExt, safeSlug } from "../../../kit/workspace/safeNames";
import { scriptoriumApp } from "./app";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The id the old workspace's entry takes: stable, so a converted manifest is the same every time. */
export const WORKSPACE_ENTRY_ID = "c-workspace";

/**
 * Whether a manifest is the shipped Scriptorium's: no `appName`, no `app` slot,
 * and a millisecond `createdAt`. The shipped writer has always stamped
 * `createdAt: Date.now()` and never written either kit field; the kit has
 * always written an ISO string.
 */
export function isShippedManifest(raw: Obj): boolean {
  return !("appName" in raw) && !("app" in raw) && typeof raw.createdAt === "number";
}

/**
 * A reason a manifest cannot be converted: a plain Error, marked, and thrown
 * where it is made (`throw unconvertible(…)`). Not an Error class or a `never`
 * helper of its own, because it never reaches the CLI as an envelope (the kit
 * turns it into the restore's 409), and the error census
 * (`grimoire/lib/error-sites.ts`) counts both shapes as CLI raise sites.
 */
const UNCONVERTIBLE = Symbol("unconvertible");

const unconvertible = (why: string): Error =>
  Object.assign(new Error(why), { [UNCONVERTIBLE]: true });

const isUnconvertible = (e: unknown): e is Error =>
  e instanceof Error && (e as Error & { [UNCONVERTIBLE]?: true })[UNCONVERTIBLE] === true;

/** Milliseconds as ISO, or the field named as wrong. */
function iso(v: unknown, at: string): string {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw unconvertible(`\`${at}\` is ${JSON.stringify(v)}, not a time in milliseconds`);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw unconvertible(`\`${at}\` is ${v}, not a time`);
  return d.toISOString();
}

const optIso = (v: unknown, at: string): string | undefined =>
  v === undefined || v === null ? undefined : iso(v, at);

function oneOf<T extends string>(v: unknown, allowed: readonly T[], at: string): T {
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw unconvertible(`\`${at}\` is ${JSON.stringify(v)}, not one of ${allowed.join(", ")}`);
}

function list(v: unknown, at: string, absentOk = false): Obj[] {
  if (v === undefined && absentOk) return [];
  if (!Array.isArray(v)) throw unconvertible(`\`${at}\` is not a list`);
  v.forEach((x, i) => {
    if (!isObj(x)) throw unconvertible(`\`${at}[${i}]\` is not an object`);
  });
  return v as Obj[];
}

function str(v: unknown, at: string): string {
  if (typeof v !== "string") throw unconvertible(`\`${at}\` is not a string`);
  return v;
}

function num(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw unconvertible(`\`${at}\` is not a number`);
  return v;
}

/** Copy the keys that are present, leaving out the ones that are not (no `undefined` written). */
function present(o: Obj): Obj {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

const AUTHORS = ["human", "agent"] as const;

function version(v: Obj, at: string): Obj {
  return present({
    n: num(v.n, `${at}.n`),
    label: typeof v.label === "string" ? v.label : undefined,
    by: oneOf(v.author, AUTHORS, `${at}.author`),
    fromVersion: typeof v.from === "number" ? v.from : undefined,
    createdAt: iso(v.createdAt, `${at}.createdAt`),
  });
}

function note(n: Obj, at: string): Obj {
  return present({
    id: str(n.id, `${at}.id`),
    version: num(n.version, `${at}.version`),
    quote: str(n.quote, `${at}.quote`),
    before: str(n.before, `${at}.before`),
    after: str(n.after, `${at}.after`),
    at: num(n.at, `${at}.at`),
    body: str(n.body, `${at}.body`),
    by: oneOf(n.who, AUTHORS, `${at}.who`),
    createdAt: iso(n.createdAt, `${at}.createdAt`),
    editedAt: optIso(n.editedAt, `${at}.editedAt`),
    editedBy: n.editedBy === undefined ? undefined : oneOf(n.editedBy, AUTHORS, `${at}.editedBy`),
    reopenedAt: optIso(n.reopenedAt, `${at}.reopenedAt`),
    reopenedBy:
      n.reopenedBy === undefined ? undefined : oneOf(n.reopenedBy, AUTHORS, `${at}.reopenedBy`),
    resolved: n.resolved === true,
  });
}

/** The highest `v<n>` file in a document's version folder, or 0. */
function highestOnDisk(dir: string): number {
  let high = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = /^v(\d+)(?:\.|$)/.exec(name);
      if (m) high = Math.max(high, Number(m[1]));
    }
  } catch {
    /* no folder: nothing on disk */
  }
  return high;
}

function doc(d: Obj, at: string, sessionDir: string): Obj {
  const slug = str(d.slug, `${at}.slug`);
  // ⛔ Never written through: both become part of a version file's path
  // (`docs/<slug>/v<n><ext>`), and one that climbs out names any file.
  const badSlug = safeSlug(slug);
  if (badSlug !== null)
    throw unconvertible(`\`${at}.slug\` is ${JSON.stringify(slug)}: ${badSlug}`);
  const ext = str(d.ext, `${at}.ext`);
  const badExt = safeExt(ext);
  if (badExt !== null) throw unconvertible(`\`${at}.ext\` is ${JSON.stringify(ext)}: ${badExt}`);
  const versions = list(d.versions, `${at}.versions`).map((v, j) =>
    version(v, `${at}.versions[${j}]`),
  );
  if (versions.length === 0)
    throw unconvertible(`\`${at}.versions\` is empty: the document has no text`);
  // ⛔ A version number is never handed out twice (E41): past every number the
  // manifest remembers, and every version file on disk.
  const nextVersion = Math.max(
    typeof d.nextVersion === "number" ? d.nextVersion : 0,
    ...versions.map((v) => (v.n as number) + 1),
    highestOnDisk(join(sessionDir, "docs", slug)) + 1,
  );
  return {
    slug,
    name: str(d.name, `${at}.name`),
    original: str(d.original, `${at}.original`),
    entryId: typeof d.entryId === "string" ? d.entryId : null,
    rel: typeof d.rel === "string" ? d.rel : null,
    ext,
    versions,
    active: num(d.active, `${at}.active`),
    nextVersion,
    notes: list(d.notes, `${at}.notes`, true).map((n, j) => note(n, `${at}.notes[${j}]`)),
    originalHash: str(d.originalHash, `${at}.originalHash`),
    admitted: d.admitted === true,
    outsideChanged: d.outsideChanged === true,
  };
}

/** `<session>/docs/<slug>/v<n><ext>`: the document and version a path names, when it is one. */
function versionAt(path: string, sessionDir: string): { doc: string; version: number } | null {
  const docsDir = join(sessionDir, "docs") + sep;
  if (!path.startsWith(docsDir)) return null;
  const m = /^([^/\\]+)[/\\]v(\d+)(?:\.[^/\\]*)?$/.exec(path.slice(docsDir.length));
  return m ? { doc: m[1] as string, version: Number(m[2]) } : null;
}

function message(c: Obj, at: string, sessionDir: string): Obj {
  const from = oneOf(c.who, ["human", "agent", "system"] as const, `${at}.who`);
  const sel = c.selection;
  let about: Obj | undefined;
  if (isObj(sel)) {
    about = present({
      doc: typeof sel.doc === "string" ? sel.doc : undefined,
      version: typeof sel.version === "number" ? sel.version : undefined,
      path: typeof sel.path === "string" ? sel.path : undefined,
      fromLine: typeof sel.fromLine === "number" ? sel.fromLine : undefined,
      toLine: typeof sel.toLine === "number" ? sel.toLine : undefined,
      text: typeof sel.text === "string" ? sel.text : undefined,
    });
  } else if (typeof c.activePath === "string") {
    // The active version at send time: its path, and the document it is.
    about = { ...(versionAt(c.activePath, sessionDir) ?? {}), path: c.activePath };
  }
  // E65's "Ask the agent": the note it asks about. The kit's one-ask guard keys
  // on the human's `via: "ask"` with `about.noteId`, which is what this was.
  const asks = isObj(c.note) && typeof c.note.id === "string" ? c.note : null;
  if (asks) {
    about = { ...(about ?? {}), noteId: asks.id };
    if (typeof asks.doc === "string" && about.doc === undefined) about.doc = asks.doc;
  }
  return present({
    id: str(c.id, `${at}.id`),
    from,
    // A system line is the kit's `info`; everything said is a `message`.
    type: from === "system" ? "info" : "message",
    text: str(c.text, `${at}.text`),
    about: about && Object.keys(about).length > 0 ? about : undefined,
    via: asks && from === "human" ? "ask" : undefined,
    ts: iso(c.ts, `${at}.ts`),
  });
}

function task(t: Obj, at: string): Obj {
  const createdAt = iso(t.createdAt, `${at}.createdAt`);
  const doneAt = optIso(t.doneAt, `${at}.doneAt`);
  // The shipped `status` is the step being done (E50), not a state: a task
  // with one is under way. Finished is `doneAt`.
  const step = typeof t.status === "string" && t.status !== "" ? t.status : undefined;
  return present({
    id: str(t.id, `${at}.id`),
    title: str(t.text, `${at}.text`),
    by: oneOf(t.who, AUTHORS, `${at}.who`),
    status: doneAt ? "done" : step ? "running" : "open",
    messageId: typeof t.messageId === "string" ? t.messageId : undefined,
    detail: doneAt ? undefined : step,
    outcome: typeof t.outcome === "string" ? t.outcome : undefined,
    createdAt,
    updatedAt: doneAt ?? createdAt,
  });
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The old default workspace, as an ordinary added folder (the ruling in
 * `docs/items/scriptorium-no-default-workspace.md`), or why it is not added.
 */
function workspaceEntry(
  workspace: unknown,
  context: readonly Obj[],
  at: ManifestMigrateContext,
): { entry: Obj } | { skipped: string } {
  if (typeof workspace !== "string" || workspace === "")
    return { skipped: "it had no workspace folder of its own (it used your home folder)" };
  // A relative path would be read against the daemon's working directory.
  if (!isAbsolute(workspace))
    return { skipped: `its workspace ${JSON.stringify(workspace)} is not a full path` };
  const real = realOr(workspace);
  // The kit's rule for a folder no one picked as a set: not the home folder
  // or one above it, the top of the disk, the sessions (or a folder holding
  // them), or the app's home. The shipped sessions root is
  // `<app home>/sessions`, so the app home is the folder above it.
  const notWhole = notAddedWhole(workspace, at.sessionsRoot, dirname(at.sessionsRoot));
  if (notWhole !== null) return { skipped: notWhole };
  let isDir = false;
  try {
    isDir = statSync(workspace).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return { skipped: `its workspace folder ${workspace} is gone` };
  for (const e of context) {
    if (e.membership !== "mirrored" || typeof e.root !== "string") continue;
    const root = realOr(e.root);
    if (real === root || real.startsWith(root + sep))
      return {
        skipped: `its workspace folder ${workspace} is already shown in ${String(e.label)}`,
      };
  }
  return {
    entry: {
      id: WORKSPACE_ENTRY_ID,
      label: basename(workspace) || workspace,
      root: workspace,
      membership: "mirrored",
      // Re-read by the restore, as every mirrored entry is.
      nodes: [],
    },
  };
}

/**
 * The converter. Null for a manifest that is not the shipped Scriptorium's (a
 * kit one, or a stranger the kit's own guards refuse); throws the reason for
 * one that is but cannot be read.
 */
export function convertShippedManifest(
  raw: Obj,
  at: ManifestMigrateContext,
): ManifestMigration | null {
  if (!isShippedManifest(raw)) return null;
  try {
    return convert(raw, at);
  } catch (e) {
    if (isUnconvertible(e)) throw new Error(`a shipped Scriptorium manifest, but ${e.message}`);
    throw e;
  }
}

function convert(raw: Obj, at: ManifestMigrateContext): ManifestMigration {
  if (raw.format !== 1) throw unconvertible(`its format is ${JSON.stringify(raw.format)}, not 1`);
  const sessionId = str(raw.sessionId, "sessionId");
  const hidden: Record<string, string[]> = {};
  const context = list(raw.context, "context").map((e, i) => {
    const { hidden: h, ...rest } = e;
    const id = str(e.id, `context[${i}].id`);
    if (!isAbsolute(str(e.root, `context[${i}].root`)))
      throw unconvertible(`\`context[${i}].root\` is not a full path`);
    oneOf(e.membership, ["mirrored", "listed"] as const, `context[${i}].membership`);
    if (!Array.isArray(e.nodes)) throw unconvertible(`\`context[${i}].nodes\` is not a list`);
    if (h !== undefined) {
      if (!Array.isArray(h) || h.some((r) => typeof r !== "string"))
        throw unconvertible(`\`context[${i}].hidden\` is not a list of paths`);
      if ((h as string[]).length > 0) hidden[id] = [...(h as string[])];
    }
    return rest;
  });
  const ws = workspaceEntry(raw.workspace, context, at);
  if ("entry" in ws) {
    if (context.some((e) => e.id === WORKSPACE_ENTRY_ID))
      throw unconvertible(`a context entry already has the id ${WORKSPACE_ENTRY_ID}`);
    context.push(ws.entry);
  }
  const ended = isObj(raw.ended)
    ? {
        by: oneOf(raw.ended.by, ["human", "agent", "timeout"] as const, "ended.by"),
        at: iso(raw.ended.at, "ended.at"),
      }
    : undefined;
  const manifest = present({
    format: 1,
    sessionId,
    appName: "scriptorium",
    createdAt: iso(raw.createdAt, "createdAt"),
    // No `workspace`: the kit path has no home workspace (`homeWorkspace:
    // false`), so a converted session has no destination nobody chose. The
    // old one is an added folder (`workspaceEntry`, above).
    context,
    docs: list(raw.docs, "docs").map((d, i) => doc(d, `docs[${i}]`, at.dir)),
    openDoc: typeof raw.openDoc === "string" ? raw.openDoc : null,
    chat: list(raw.chat, "chat").map((c, i) => message(c, `chat[${i}]`, at.dir)),
    tasks: list(raw.tasks, "tasks", true).map((t, i) => task(t, `tasks[${i}]`)),
    // The slot as the app declares it now, so the restore has no slot migrate
    // to run (and no second chat line): the converter writes the current shape.
    app: {
      version: scriptoriumApp.slot.version,
      ...(Object.keys(hidden).length > 0 ? { hidden } : {}),
    },
    ended,
  });
  const where =
    "entry" in ws
      ? ` Its workspace folder, ${String(ws.entry.root)}, is now an ordinary added folder.`
      : ` Its workspace was not added as a folder: ${ws.skipped}.`;
  return {
    manifest,
    note: `This session was converted from the shipped Scriptorium.${where}`,
  };
}
