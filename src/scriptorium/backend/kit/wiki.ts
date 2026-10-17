/**
 * The wiki verbs on the kit path (scriptorium-kit-wiki-verbs), daemon side:
 * `meta`, `meta-init`, `meta-set`, `find` and `forget` as the shipped
 * Scriptorium has them (S/backend/session.ts `metaFor`, `metaInit`,
 * `metaSet`, `find`, `forgetDoc`; their handlers in S/backend/server.ts), the
 * move plan (E26) as a daemon op, the remove verbs, and `docMeta` for the
 * agent's `appState`.
 *
 * ⛔ THE SAME ANSWERS FOR THE SAME WORLD. The frontmatter is read by the
 * shipped reader (`../frontmatter.ts`: `readMeta`, `summarize`,
 * `matchesFilter`, `trustTier`, `isStale`), not the kit's, from the first
 * 8 KB of the file on disk, as the shipped verbs read it. Writes are the
 * shipped text edits (`buildBlock`, `withBlock`, `setKey`): a new block is
 * built, an existing one is edited a line at a time, and nothing else in the
 * file moves.
 *
 * Daemon side only: the CLI's half is `./wikiCommands.ts`.
 */

import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { VerbHandler } from "../../../kit/workspace/server";
import { SessionError, type WorkspaceSession } from "../../../kit/workspace/session";
import { docPaths } from "../../../kit/workspace/tree";
import { quoteLabel } from "../anchors";
import {
  buildBlock,
  guessType,
  type MetaFilter,
  matchesFilter,
  readMeta,
  setKey,
  splitFrontmatter,
  summarize,
  titleFromBody,
  withBlock,
} from "../frontmatter";
import type { DocMeta, DocSummary } from "../protocol";
import { gitRootOf, META_SCAN_CAP } from "../session";
import { fullPathOrDie } from "./hide";

/** A frontmatter block lives at the top of a file; this is how much is read to find it (the shipped size). */
const META_HEAD_BYTES = 8192;

/** The first 8 KB of a file, or "" when it cannot be read (a folder, a file gone). */
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

/** Every document the context shows, with the entry that shows it, depth-first. */
function contextDocs(s: WorkspaceSession): { abs: string; entry: string }[] {
  return s.context.flatMap((e) => docPaths(e).map((abs) => ({ abs, entry: e.id })));
}

/**
 * A path the context shows, or the shipped refusal: `meta`, `meta-init` and
 * `meta-set` answer only about what the human can see. The kit's `shownAt`
 * decides (a document, a folder in a set, a set's folder, a listed item); its
 * 404 becomes the shipped 400 and words.
 */
function shownOrDie(s: WorkspaceSession, rawPath: string): string {
  try {
    return s.shownAt(rawPath).abs;
  } catch (e) {
    if (e instanceof SessionError && e.status === 404)
      throw new SessionError(`${rawPath} is not shown in this session`, 400);
    throw e;
  }
}

// ── docMeta: the agent's per-document frontmatter, in appState ─────────────

type MetaCache = Map<string, { mtimeMs: number; summary: DocSummary | null }>;
const caches = new WeakMap<WorkspaceSession, MetaCache>();

/**
 * Frontmatter for every document in the context, by path: the shipped
 * snapshot's `docMeta` (S/backend/session.ts `contextMeta`), with each
 * document's trust tier and `stale`. Cached by path and mtime, read head
 * first, capped at the shipped 500; hitting the cap is said
 * (`docMetaTruncated`), not left to look like documents without any.
 */
export function docMeta(s: WorkspaceSession): {
  docMeta: Record<string, DocSummary>;
  docMetaTruncated?: true;
} {
  let cache = caches.get(s);
  if (!cache) {
    cache = new Map();
    caches.set(s, cache);
  }
  const map: Record<string, DocSummary> = {};
  const seen = new Set<string>();
  let truncated = false;
  for (const { abs } of contextDocs(s)) {
    if (seen.has(abs)) continue;
    if (seen.size >= META_SCAN_CAP) {
      truncated = true;
      break;
    }
    seen.add(abs);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    const hit = cache.get(abs);
    let summary: DocSummary | null;
    if (hit && hit.mtimeMs === mtimeMs) summary = hit.summary;
    else {
      summary = summarize(readMeta(readHead(abs)));
      cache.set(abs, { mtimeMs, summary });
    }
    if (summary) map[abs] = summary;
  }
  // What the context no longer shows is not kept.
  for (const p of cache.keys()) if (!seen.has(p)) cache.delete(p);
  return { docMeta: map, ...(truncated ? { docMetaTruncated: true as const } : {}) };
}

// ── the reads ──────────────────────────────────────────────────────────────

/** One document's frontmatter as read, or every context document's (shipped `metaFor`). */
export function metaFor(s: WorkspaceSession, rawPath?: string): Record<string, unknown> {
  if (rawPath !== undefined) {
    const abs = shownOrDie(s, rawPath);
    const meta = readMeta(readHead(abs));
    return { path: abs, meta, ...(meta ? {} : { note: "no frontmatter block" }) };
  }
  const out: { path: string; meta: DocMeta | null }[] = contextDocs(s).map(({ abs }) => ({
    path: abs,
    meta: readMeta(readHead(abs)),
  }));
  return { documents: out, count: out.length };
}

/** pdocs's `find` over the context (shipped `find`): the filters AND, and an empty result is an answer. */
export function find(s: WorkspaceSession, filter: MetaFilter): Record<string, unknown> {
  const matches: Record<string, unknown>[] = [];
  for (const { abs, entry } of contextDocs(s)) {
    const meta = readMeta(readHead(abs));
    if (!matchesFilter(meta, filter)) continue;
    matches.push({
      path: abs,
      entry,
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

/** The filter as the wire carries it: each a string, or absent. */
function filterOf(raw: unknown): MetaFilter {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new SessionError("find: filter must be an object of strings", 400);
  const out: MetaFilter = {};
  for (const k of ["type", "status", "lifecycle", "tag", "since"] as const) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (typeof v !== "string") throw new SessionError(`find: ${k} must be a string`, 400);
    out[k] = v;
  }
  return out;
}

// ── the writes ─────────────────────────────────────────────────────────────

/** What a frontmatter block for this document would say (shipped `suggestMeta`). */
function suggestMeta(
  s: WorkspaceSession,
  rawPath: string,
  by?: string,
): { path: string; block: string; type?: string } {
  const abs = shownOrDie(s, rawPath);
  const text = readFileSync(abs, "utf8");
  if (splitFrontmatter(text).raw !== null)
    throw new SessionError(`${basename(abs)} already has frontmatter`, 409);
  const folder = dirname(abs);
  const siblings: string[] = [];
  for (const { abs: p } of contextDocs(s))
    if (p !== abs && dirname(p) === folder) {
      const t = readMeta(readHead(p))?.type;
      if (t) siblings.push(t);
    }
  const type = guessType(siblings, basename(folder));
  const title = titleFromBody(text);
  return {
    path: abs,
    type,
    block: buildBlock({
      ...(type ? { type } : {}),
      ...(title ? { title } : {}),
      ...(by ? { by } : {}),
    }),
  };
}

/**
 * Write a new block into a document that has none (shipped `metaInit`, E35).
 * It writes the ORIGINAL, as the shipped verb does: if the human has the
 * document open with unsaved edits, the kit's watcher keeps their version and
 * says the file changed outside, and they choose.
 */
export function metaInit(
  s: WorkspaceSession,
  rawPath: string,
  opts: { type?: string; by?: string } = {},
): { path: string; type: string | null; added: true; text: string } {
  const suggested = suggestMeta(s, rawPath, opts.by);
  const abs = suggested.path;
  const text = readFileSync(abs, "utf8");
  const title = titleFromBody(text);
  const block = opts.type
    ? buildBlock({
        type: opts.type,
        ...(title ? { title } : {}),
        ...(opts.by ? { by: opts.by } : {}),
      })
    : suggested.block;
  return {
    path: abs,
    type: opts.type ?? suggested.type ?? null,
    added: true,
    text: withBlock(text, block),
  };
}

/** Set keys in an existing block, a line edit each (shipped `metaSet`). */
export function metaSet(
  s: WorkspaceSession,
  rawPath: string,
  pairs: Record<string, string>,
): { path: string; set: string[]; text: string } {
  const abs = shownOrDie(s, rawPath);
  let text = readFileSync(abs, "utf8");
  if (splitFrontmatter(text).raw === null)
    throw new SessionError(`${basename(abs)} has no frontmatter — add it first (meta-init)`, 409);
  for (const [key, value] of Object.entries(pairs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
      throw new SessionError(`"${key}" is not a frontmatter key`, 400);
    text = setKey(text, key, value);
  }
  return { path: abs, set: Object.keys(pairs), text };
}

/**
 * Write a document's original, as the shipped verbs do (E35: the agent's verb
 * writes the file). The kit's watcher then does what the shipped one does
 * with any write to an opened original: a document with no unsaved edits
 * takes the new text as its active version; one with unsaved edits keeps
 * them, and is marked changed outside, so the human chooses.
 */
function writeOriginal(abs: string, text: string): void {
  writeFileSync(abs, text);
}

// ── the move plan (E26) ─────────────────────────────────────────────────────

/**
 * What a move would do, before it does it: the kit's plan (what moves, and
 * the links it would break), with the shipped git half, which only the daemon
 * can see: whether the item leaves the git working tree it is in.
 */
export function movePlan(s: WorkspaceSession, rawPath: string, rawInto: string) {
  const plan = s.movePlan(rawPath, rawInto);
  const fromRepo = gitRootOf(dirname(plan.from));
  const intoRepo = gitRootOf(plan.into);
  return {
    ...plan,
    repo: fromRepo ? basename(fromRepo) : null,
    leavesRepo: fromRepo !== null && fromRepo !== intoRepo,
  };
}

// ── the verbs ──────────────────────────────────────────────────────────────

const who = (from: "agent" | "surface") => (from === "agent" ? "Agent" : "You");
const by = (from: "agent" | "surface") => (from === "agent" ? "agent" : "human");

function str(args: Record<string, unknown>, key: string, verb: string): string {
  const v = args[key];
  if (typeof v !== "string" || v === "") throw new SessionError(`${verb} needs ${key}`, 400);
  return v;
}

/** A path argument: present, and a full path (`fullPathOrDie`). */
const pathArg = (args: Record<string, unknown>, key: string, verb: string): string =>
  fullPathOrDie(str(args, key, verb), verb);

/** The kit's `forgetDoc` refusal reads `<path> is still on disk: …`. */
const STILL_ON_DISK = " is still on disk";

const optStr = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined;

export const wikiVerbs: Record<string, VerbHandler> = {
  "scriptorium.meta": (ctx, args) => {
    const path = optStr(args, "path");
    return metaFor(ctx.session, path === undefined ? undefined : fullPathOrDie(path, "meta"));
  },

  "scriptorium.find": (ctx, args) => find(ctx.session, filterOf(args.filter)),

  "scriptorium.meta.init": (ctx, args, call) => {
    const metaType = optStr(args, "metaType");
    const { text, ...r } = metaInit(ctx.session, pathArg(args, "path", "meta-init"), {
      ...(metaType ? { type: metaType } : {}),
      by: optStr(args, "by") ?? by(call.from),
    });
    writeOriginal(r.path, text);
    ctx.announce(`${who(call.from)} added frontmatter to ${ctx.session.display(r.path)}.`, {
      fact: "meta.init",
      by: by(call.from),
      ...r,
    });
    ctx.broadcast();
    return r;
  },

  "scriptorium.meta.set": (ctx, args, call) => {
    const fields = args.fields;
    if (
      fields === null ||
      typeof fields !== "object" ||
      Array.isArray(fields) ||
      Object.keys(fields).length === 0 ||
      !Object.values(fields).every((v) => typeof v === "string")
    )
      throw new SessionError("meta-set needs fields: an object of key to string value", 400);
    const { text, ...r } = metaSet(
      ctx.session,
      pathArg(args, "path", "meta-set"),
      fields as Record<string, string>,
    );
    writeOriginal(r.path, text);
    ctx.announce(`${who(call.from)} set ${r.set.join(", ")} on ${ctx.session.display(r.path)}.`, {
      fact: "meta.set",
      by: by(call.from),
      ...r,
    });
    ctx.broadcast();
    return r;
  },

  "scriptorium.forget": (ctx, args, call) => {
    let f: ReturnType<WorkspaceSession["forgetDoc"]>;
    try {
      f = ctx.session.forgetDoc(optStr(args, "doc"));
    } catch (e) {
      // The shipped refusal's words: forget is for a record whose file is
      // gone, and taking a live document out is `hide`.
      if (e instanceof SessionError && e.status === 409 && e.message.includes(STILL_ON_DISK))
        throw new SessionError(
          `${e.message.split(STILL_ON_DISK)[0]}${STILL_ON_DISK} — forget is for a document whose file is gone. To take it out of the context, remove it from Scriptorium instead.`,
          409,
        );
      throw e;
    }
    ctx.announce(
      `${who(call.from)} forgot ${f.name} — its file was gone, and ${f.versions === 1 ? "1 version" : `${f.versions} versions`} in this session ${f.versions === 1 ? "is" : "are"} no longer reachable.`,
      { fact: "doc.forgotten", doc: f.slug, original: f.original, by: by(call.from) },
    );
    ctx.broadcast();
    return f;
  },

  "scriptorium.move.plan": (ctx, args, call) => {
    const path = pathArg(args, "path", "move-plan");
    const into = pathArg(args, "into", "move-plan");
    const plan = movePlan(ctx.session, path, into);
    call.reply({ op: "scriptorium.move.plan", path, into, plan });
    return plan;
  },

  "scriptorium.note.remove": (ctx, args, call) => {
    const doc = optStr(args, "doc");
    const r = ctx.session.removeNote({
      ...(doc ? { doc } : {}),
      id: str(args, "id", "note-remove"),
    });
    ctx.announce(`${who(call.from)} removed a note on ${r.slug}: “${quoteLabel(r.note.quote)}”.`, {
      fact: "note.removed",
      doc: r.slug,
      note: r.note.id,
      by: by(call.from),
    });
    ctx.broadcast();
    return { doc: r.slug, note: r.note.id };
  },

  "scriptorium.task.remove": (ctx, args) => {
    const id = str(args, "id", "task-remove");
    let t: ReturnType<WorkspaceSession["removeTask"]>;
    try {
      t = ctx.session.removeTask(id);
    } catch (e) {
      // An unfinished task: the refusal names the two verbs that answer it.
      if (e instanceof SessionError && e.status === 409 && e.hint === undefined)
        throw new SessionError(
          e.message,
          409,
          e.choices,
          `task-cancel ${id}, then task-remove ${id}`,
        );
      throw e;
    }
    ctx.broadcast();
    return { task: t.id, removed: true };
  },

  "scriptorium.tasks.clear": (ctx) => {
    const cleared = ctx.session.clearFinishedTasks();
    ctx.broadcast();
    return { cleared };
  },
};
