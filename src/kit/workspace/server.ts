/**
 * The workspace daemon: the per-session process a surface talks to over a
 * WebSocket and the CLI talks to over HTTP, composed once for every workspace.
 * An app supplies its name and manifest slot, its task runners, its own verbs
 * and its own events; everything else is here.
 *
 * Routes: `/ws` (the surface), `GET /state`, `POST /cmd` and `GET /events?since=`
 * (the CLI), `GET /fs/*` (read-only: a directory listing for path completion, a
 * version's text), the built surface at `/` in release mode, and whatever the
 * app's `http` hook answers first.
 *
 * Every request passes the origin guard before anything else: a page the human
 * is merely browsing must not be able to drive a daemon on loopback.
 *
 * Lifecycle: long-running, one daemon per session, idle timeout (30 minutes by
 * default; the daemon exits with code 124). The event log is in memory and its
 * ids restart at 1, even under `--restore` (which restores the manifest, not the
 * log), so the log is stamped with a per-boot epoch and a tail resets its cursor
 * when the epoch changes.
 *
 * Teardown order, fixed: stop housekeeping, clear the attention timer, close the
 * watchers, abort the runners, persist the manifest, unlink discovery, emit
 * `closed`, drain. Discovery goes before the `closed` frame so a tail that sees
 * `closed` and a CLI verb that runs right after it both find no pointer to a
 * daemon that is leaving; the other order leaves a window in which a verb
 * resolves a session that will refuse it.
 */

import { closeSync, type FSWatcher, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";
import { bundleDisplayName, bundleOf, bundleTypeOf, linkPlacesText } from "../lib/bundles.ts";
import { EXTENSION_OF, isImageName, sniffImage } from "../lib/docFormat.ts";
import { findHeading, headingPlainText, lineRange, nearestHeading } from "../lib/headingAnchor.ts";
import { headingsOf } from "../lib/headings.ts";
import { homeDir, underTest } from "../lib/home.ts";
import {
  describeImageImport,
  IMAGE_PREF_KEYS,
  imagePrefRefusal,
  readImageImportSettings,
} from "../lib/imageImport.ts";
import { describeJsonProblem } from "../lib/json.ts";
import { decodePath, splitTarget } from "../lib/linkTarget.ts";
import { IMAGE_SOURCES } from "../lib/sidecar.ts";
import { publishPointer, removePointer, writeFileAtomic } from "../wire/discovery.ts";
import { createEventLog } from "../wire/eventLog.ts";
import { drainAndStop, startHousekeeping } from "../wire/housekeeping.ts";
import { refuseForeignOrigin } from "../wire/origin.ts";
import { resolveMode, serveFromDist } from "../wire/serveDist.ts";
import { type SseClients, sseResponse } from "../wire/sse.ts";
import { linesOf, quoteLabel } from "./anchors";
import { diffText, splitLines, unified } from "./diff";
import { type Finding, overlapMessage, summary } from "./doctor";
import { type ClosedBy, KIT_EVENT_TAIL, type SaveWake, type TailRule } from "./events";
import {
  AGENT_ALL_PARAM,
  AGENT_ONCE_PARAM,
  AGENT_TAIL_PARAM,
  IDLE_TIMEOUT_SEC,
  NOT_PRESENCE_HEADER,
  SSE_HEARTBEAT_MS,
} from "./heartbeat";
import {
  type Act,
  type After,
  type AppAct,
  type Created,
  deletesOf,
  type Follow,
  FollowError,
  History,
  type Inverse,
  type LinkEdit,
  planInverse,
  reverseLinkEdits,
} from "./history";
import {
  crossSite,
  IMAGE_MAX_BYTES,
  ImageError,
  type ImportedBytes,
  imageDecodes,
  imageRefusal,
  imageResponse,
  optimiseImport,
  pruneThumbs,
  readAllFd,
  readCapped,
  THUMB_SOURCE_MAX_BYTES,
  THUMB_WIDTHS,
  thumbnail,
} from "./images";
import type { LinkSlot } from "./linkEdges";
import { extractLinks, swapLinkTargets } from "./links";
import {
  cleanVia,
  KIT_REF_ROLES,
  KIT_VIA,
  MAX_REFS,
  messageVia,
  refRole,
  roleAdvisory,
  VIA_MAX,
  viaAdvisory,
} from "./messageParts";
import { missingDir } from "./noHome";
import { type PickKind, parsePickerOutput, pickerCommand, wasCancelled } from "./picker";
import type {
  AgentCmd,
  ClientOp,
  DiffHunk,
  DocLinkFixes,
  DocView,
  GraphOptions,
  HeadingLanding,
  Message,
  MessageAbout,
  MessageRef,
  Note,
  PublicState,
  RelinkOffer,
  Selection,
  ServerOp,
  ShowTarget,
  StructureOp,
  WikiBreak,
} from "./protocol";
import { revealCommand } from "./reveal";
import { type Screen, selectionOnScreen } from "./selection";
import {
  type AppDeclaration,
  checkApp,
  contentHash,
  type FileEvent,
  GoneError,
  newSessionId,
  SessionError,
  sideName,
  treeHash,
  WorkspaceSession,
} from "./session";
import { type Actor, TaskEngine, type TaskRunner } from "./tasks";
import { systemTrash, type TrashFn } from "./trash";
import { listDir, PathError } from "./tree";

import {
  askOutstanding,
  attentionKey,
  DEFAULT_SNOOZE_MS,
  noteEventFacts,
  notesWaiting,
  replyHint,
  waitingHint,
  waitingOn,
} from "./waiting";

/** A dropped image's name is taken: `takenName` is the name it would be written under, which may not be the dropped file's. */
class ImageTakenError extends SessionError {
  constructor(
    e: SessionError,
    readonly takenName: string,
  ) {
    super(e.message, e.status, e.choices, e.hint);
  }
}

/** A frame on the event log: `type` names the event; the log stamps `id` and `epoch`. */
export type LogEvent = Record<string, unknown> & { type: string };

/**
 * How long a link rewrite is rebased into an open editor's late edits at most
 * (see `linkFollow`): a backstop, since an up-to-date edit ends it sooner.
 */
const RELINK_FOLLOW_MS = 5000;

/**
 * `mine`, typed over `pre`, moved onto `post` (`pre` with the link targets in
 * `swaps` rewritten, line for line).
 *
 * - A line of `mine` unchanged from `pre` takes `post`'s line.
 * - Within a changed run of lines, a link whose target `swaps` names is
 *   rewritten only as many times as that target was written in the run's
 *   lines of `pre`: those were the links the rewrite meant (in prose a link's
 *   line is its paragraph, so typing anywhere in it changes the line). A copy
 *   typed beyond that count was written on purpose and stays.
 * - A line added or changed otherwise keeps exactly what was typed.
 *
 * `kept` names the old targets left in the result (1-based line, as written),
 * so they are said rather than silently saved. Line counts that disagree, or a
 * diff too large to walk, keep `mine` with every old target in it named.
 */
export function rebaseLines(
  pre: string,
  post: string,
  mine: string,
  swaps: ReadonlyMap<string, string>,
): { text: string; kept: { line: number; raw: string }[] } {
  const keptIn = (lines: string[], from = 0) =>
    lines.flatMap((text, i) =>
      extractLinks(text)
        .filter((l) => l.kind === "markdown" && swaps.has(l.raw))
        .map((l) => ({ line: from + i + 1, raw: l.raw })),
    );
  const postLines = splitLines(post);
  const d = splitLines(pre).length === postLines.length ? diffText(pre, mine) : null;
  if (!d || d.coarse) return { text: mine, kept: keptIn(splitLines(mine)) };
  const out: string[] = [];
  const kept: { line: number; raw: string }[] = [];
  let i = 0;
  while (i < d.lines.length) {
    const l = d.lines[i] as (typeof d.lines)[number];
    if (l.op === "same") {
      out.push(postLines[l.a as number] as string);
      i++;
      continue;
    }
    // A changed run: what `pre` had in it, and what was typed for it.
    const was: string[] = [];
    const typed: string[] = [];
    for (; i < d.lines.length && (d.lines[i] as typeof l).op !== "same"; i++) {
      const x = d.lines[i] as typeof l;
      (x.op === "del" ? was : typed).push(x.text);
    }
    const budget = new Map<string, number>();
    for (const line of was)
      for (const link of extractLinks(line))
        if (link.kind === "markdown" && swaps.has(link.raw))
          budget.set(link.raw, (budget.get(link.raw) ?? 0) + 1);
    const from = out.length;
    for (const line of typed)
      out.push(
        swapLinkTargets(line, (raw) => {
          const left = budget.get(raw) ?? 0;
          if (left === 0) return undefined;
          budget.set(raw, left - 1);
          return swaps.get(raw);
        }).text,
      );
    kept.push(...keptIn(out.slice(from), from));
  }
  return { text: out.join("\n"), kept };
}

/**
 * The kit's agent commands' fields, by type, checked before the command runs
 * (`checkAgentCmd`). A field of the wrong type reached the session as sent: a
 * `say` stored `{"x":1}` as its text, a `reveal` of `null` threw a 500 from
 * `node:path`. `text` (must say something) and `str` are required strings;
 * `optStr` and `optNum` may be absent or null; `strs` is a list of strings.
 */
type CmdFields = {
  text?: string[];
  str?: string[];
  optStr?: string[];
  num?: string[];
  optNum?: string[];
  bool?: string[];
  strs?: string[];
};
const AGENT_CMD_FIELDS: Record<string, CmdFields> = {
  say: { text: ["text"], optStr: ["via"] },
  reveal: { str: ["path"] },
  "context.add": { strs: ["paths"] },
  "version.new": { optStr: ["doc", "label"], optNum: ["from"] },
  activate: { optStr: ["doc"], num: ["version"] },
  "version.delete": { optStr: ["doc"], num: ["version"] },
  "note.add": { str: ["quote", "body"], optStr: ["doc"] },
  notes: { optStr: ["doc"] },
  "note.edit": { str: ["id", "body"], optStr: ["doc"] },
  "note.resolve": { str: ["id"], optStr: ["doc"], bool: ["resolved"] },
  working: { optNum: ["seconds"] },
  "task.create": { str: ["title"], optStr: ["detail", "parent"] },
  "task.status": { str: ["id", "detail"] },
  "task.done": { str: ["id"], optStr: ["outcome"] },
  "task.cancel": { str: ["id"] },
  diff: { optStr: ["doc"], optNum: ["context"] },
  merge: { optStr: ["doc"] },
  show: { optStr: ["doc", "quote", "heading"], optNum: ["hunk"] },
  search: { str: ["query"], optNum: ["limit"] },
  backlinks: { optStr: ["doc"] },
  profile: { optStr: ["doc"] },
  "image.describe": { str: ["image"], optStr: ["source", "label"] },
  "doc.create": { str: ["dir"], optStr: ["name", "text"] },
  "folder.create": { str: ["dir"], optStr: ["name"] },
  "folder.add": { str: ["path"] },
  "set.make": { str: ["path"] },
  "bundle.create": { str: ["dir"], optStr: ["extension", "name"] },
  duplicate: { str: ["path"] },
  move: { str: ["path", "into"] },
  rename: { str: ["path", "name"] },
  import: { str: ["name", "text"], optStr: ["dir"] },
  "workspace.set": { str: ["path"] },
};

/** Refuses (400) an agent command whose fields are not of their type: before anything runs. */
export function checkAgentCmd(cmd: Record<string, unknown>): void {
  const spec = typeof cmd.op === "string" ? AGENT_CMD_FIELDS[cmd.op] : undefined;
  if (!spec) return;
  const bad = (field: string, what: string) =>
    new SessionError(`${cmd.op}: ${field} must be ${what}: nothing was applied`, 400);
  for (const f of spec.text ?? [])
    if (typeof cmd[f] !== "string" || !(cmd[f] as string).trim()) throw bad(f, "non-empty text");
  for (const f of spec.str ?? []) if (typeof cmd[f] !== "string") throw bad(f, "a string");
  for (const f of spec.optStr ?? [])
    if (cmd[f] != null && typeof cmd[f] !== "string") throw bad(f, "a string when given");
  for (const f of spec.num ?? [])
    if (typeof cmd[f] !== "number" || !Number.isFinite(cmd[f])) throw bad(f, "a number");
  for (const f of spec.optNum ?? [])
    if (cmd[f] != null && (typeof cmd[f] !== "number" || !Number.isFinite(cmd[f])))
      throw bad(f, "a number when given");
  for (const f of spec.bool ?? []) if (typeof cmd[f] !== "boolean") throw bad(f, "true or false");
  for (const f of spec.strs ?? [])
    if (!Array.isArray(cmd[f]) || !(cmd[f] as unknown[]).every((p) => typeof p === "string"))
      throw bad(f, "a list of strings");
}

/** The ops the kit answers itself, so an app's namespaced op can never shadow one. */
const STRUCTURE_OPS = new Set<string>([
  "doc.create",
  "folder.create",
  "folder.add",
  "set.make",
  "bundle.create",
  "duplicate",
  "move",
  "rename",
  "import",
  "workspace.set",
] satisfies StructureOp["op"][]);
const isStructureOp = (m: { op: string }): m is StructureOp => STRUCTURE_OPS.has(m.op);

/**
 * How long the agent still counts as listening after its last tail let go, or
 * after its last call (`POST /cmd` is only ever the agent's CLI). A watch re-arms
 * at its window within seconds, and every verb the agent runs mid-turn renews
 * this, so a minute is enough for both.
 */
export const AGENT_GRACE_MS = 60_000;

/**
 * How long after a switch the human's edit to the version it left is still
 * taken into that version: the client's pause (`EDIT_DEBOUNCE_MS`) and a
 * round trip, with room for a loaded machine. Later, or with no switch on
 * record (a restarted daemon), an edit to a version that is not active is
 * refused as it always was (`kit-agent-activate-pending-edit`).
 */
export const LATE_EDIT_MS = 3000;

/**
 * How long the daemon waits after an image arrives in a document before it
 * tells the agent: several pasted or dropped at once are sent one request
 * each, and are told as ONE `image.pasted` fact, not one per image.
 */
export const IMAGE_ARRIVAL_SETTLE_MS = 400;

/**
 * How long a `--once` tail that closed on a delivered frame holds presence. That
 * close is the agent being woken, usually by the human's message, and the turn
 * that follows can run for minutes with no tail attached and no call made: the
 * agent at work, not the agent gone. The next tail ends the hold; a call only
 * ever extends it.
 */
export const AGENT_ONCE_GRACE_MS = 5 * 60_000;

/** How long a burst of watcher events on one path settles before it is read. */
const WATCH_SETTLE_MS = 60;

/**
 * How long a document's file must stay gone before it is called missing: an
 * atomic save or a quick rename back leaves a gap, and the banner must not flash.
 */
const MISSING_RECHECK_MS = 400;

/**
 * How long watcher events across the context settle before `context.changed`
 * goes out: a save, a `git checkout` or an export is one frame, not hundreds.
 */
export const CONTEXT_CHANGED_SETTLE_MS = 400;

/**
 * Is a watcher's relative name under a dot-folder or a dot-file (`.git/…`,
 * `.DS_Store`, `.obsidian/…`)? Those churn on their own (a commit, Finder, an
 * editor's state) and hold no documents the context lists, so they never cue
 * `context.changed`.
 */
export function isDotPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith("."));
}

/**
 * Where a link's `#anchor` (as written, encoded) lands in a document's text
 * (kit-heading-links-build): the heading `findHeading` finds, with its line's
 * extent, or no `found` when none matches.
 */
export function headingLanding(
  opened: { slug: string; version: number; text: string },
  rawAnchor: string,
): HeadingLanding {
  const anchor = decodePath(rawAnchor);
  const base = { anchor, doc: opened.slug, version: opened.version };
  const m = findHeading(headingsOf(opened.text), anchor);
  if (!m) return base;
  const { from, to } = lineRange(opened.text, m.heading.line);
  return {
    ...base,
    found: {
      text: headingPlainText(m.heading.text),
      line: m.heading.line,
      from,
      to,
      ...(m.ambiguous ? { ambiguous: true as const } : {}),
    },
  };
}

/**
 * A graph request's options, from a frame or a command: each part checked for
 * its type, so a string where a list belongs is refused rather than read as one
 * relation per character.
 */
function graphOptions(raw: Record<string, unknown>): GraphOptions {
  const out: GraphOptions = {};
  const strings = (key: string): string[] | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
      throw new SessionError(`graph: ${key} must be a list of names`, 400);
    return v as string[];
  };
  const count = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number") throw new SessionError(`graph: ${key} must be a number`, 400);
    return v;
  };
  const text = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "")
      throw new SessionError(`graph: ${key} must be a name or a path`, 400);
    return v;
  };
  const focus = text("focus");
  const within = text("within");
  const hops = count("hops");
  const limit = count("limit");
  const rel = strings("rel");
  const kind = strings("kind");
  if (focus !== undefined) out.focus = focus;
  if (within !== undefined) out.within = within;
  if (hops !== undefined) out.hops = hops;
  if (limit !== undefined) out.limit = limit;
  if (rel !== undefined) out.rel = rel;
  if (kind !== undefined) out.kind = kind;
  if (raw.untyped !== undefined) {
    if (typeof raw.untyped !== "boolean")
      throw new SessionError("graph: untyped must be true or false", 400);
    out.untyped = raw.untyped;
  }
  if (raw.kindless !== undefined) {
    if (typeof raw.kindless !== "boolean")
      throw new SessionError("graph: kindless must be true or false", 400);
    out.kindless = raw.kindless;
  }
  if (raw.bundles !== undefined) {
    if (typeof raw.bundles !== "boolean")
      throw new SessionError("graph: bundles must be true or false", 400);
    out.bundles = raw.bundles;
  }
  const edge = edgeKinds(raw.edge, "graph");
  if (edge !== undefined) out.edge = edge;
  return out;
}

/** An `edge` filter as the wire sends it (kit-link-edges-slot): a list of edge kinds, or absent. */
function edgeKinds(v: unknown, verb: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== ""))
    throw new SessionError(`${verb}: edge must be a list of edge kinds (link, or the app's)`, 400);
  return v as string[];
}

/** What a verb handler is told about how it was reached. */
export type VerbCall = {
  /** `agent`: `POST /cmd`. `surface`: a WebSocket frame. */
  from: "agent" | "surface";
  /**
   * Which page sent a surface call: an id for its socket, stable while it is
   * connected, so an app can keep something per page and drop it in
   * `hooks.onSurfaceClose`. Absent for an agent call.
   */
  surface?: string;
  /** Answer the asking surface only (a no-op for an agent call). */
  reply(frame: { op: string; [key: string]: unknown }): void;
};

/**
 * What a verb, a runner's host, or an `http` hook may do to the running daemon.
 * The app gets exactly these and never the daemon's internals.
 */
export type WorkspaceContext = {
  readonly app: string;
  readonly session: WorkspaceSession;
  readonly tasks: TaskEngine;
  /**
   * Put an event on the log. Only kit events and the app's declared
   * `<app>.<event>` are allowed. `wake` overrides the type's tail rule for this
   * one frame (see `TailRule`).
   */
  emit(type: string, fields?: Record<string, unknown>, opts?: EmitOptions): void;
  /** A line in the chat (from `system`, type `info`, unless told otherwise). */
  line(text: string, about?: MessageAbout): Message;
  /** A line in the chat and a `system` event, for a fact the agent must know. */
  announce(text: string, fact?: Record<string, unknown>): void;
  /** Send a frame to every connected surface (an app's own frames are `<app>.<name>`). */
  send(frame: { op: string; [key: string]: unknown }): void;
  /** The state changed: push a new snapshot to every surface. */
  broadcast(): void;
  /**
   * Write a document's ACTIVE version as the human's editor does (the `edit`
   * frame): check-before-write keeps an outside write as a new version and
   * says so, and a change to the dirty mark is broadcast. For an app that holds
   * an open document's text itself (Atlas's live board) and writes it back.
   */
  edit(doc: string, version: number, text: string): void;
  /**
   * The context's undo history (the arrows in the context's header). `push`
   * puts an app's own act on it, beside the kit's renames and moves, with its
   * way back (`AppAct` in `history.ts`). Call it once the act is done; a
   * new act ends what the redo arrow offered.
   */
  readonly history: { push(act: AppAct): void };
  /** The session is in use: reset the idle clock. */
  touch(): void;
  /** Show a path in the file manager; only paths the session knows. */
  reveal(path: string): string;
  /**
   * Ask the human for a path with the OS's own dialog: `save` asks where to write
   * (`defaultName` is the suggested file name), `file` and `folder` ask what to open.
   * One dialog at a time: a second request while one is open is refused. A
   * cancelled dialog resolves with `cancelled: true` and no paths.
   */
  pick(
    kind: PickKind,
    prompt: string,
    defaultName?: string,
  ): Promise<{ paths: string[]; cancelled: boolean }>;
};

/** What a `messageHint` slot is given: the human's message, and the session it is in. */
export type MessageHintInput = {
  session: string;
  messageId: string;
  text: string;
  about?: MessageAboutOnTail;
};

/**
 * A human message's `about` as the agent's tail carries it: the kit's parts,
 * and any part the app adds (`hooks.messageAbout`), such as Atlas's `map`.
 */
export type MessageAboutOnTail = MessageAbout & { [part: string]: unknown };

/** The kit's own `about` keys, which an app's part may not take. Every key, by type. */
const KIT_ABOUT_KEYS = new Set<string>(
  Object.keys({
    doc: true,
    version: true,
    path: true,
    fromLine: true,
    toLine: true,
    text: true,
    entryIds: true,
    docs: true,
    noteId: true,
    refs: true,
  } satisfies Record<keyof MessageAbout, true>),
);

/** How one emit departs from its type's tail rule. */
export type EmitOptions = { wake?: boolean };

/** An app's handler for one of its own ops (`<app>.<name>`), from the CLI or the surface. */
export type VerbHandler = (
  ctx: WorkspaceContext,
  args: Record<string, unknown>,
  call: VerbCall,
) => unknown | Promise<unknown>;

export type WorkspaceDaemonOptions = {
  /** The app's name (fixes its discovery names) and its manifest slot. */
  app: AppDeclaration;
  /** Where sessions live: `<home>/<app>/sessions`. Preferences are kept beside it. */
  sessionsRoot: string;
  /**
   * The app's own folder, where its sessions, settings and logs live (by
   * default only the sessions root is guarded). No set shows it and no
   * structure op writes in it, as for the sessions root (`notASet`,
   * `inOwnPlaces` in `./noHome.ts`).
   */
  appHome?: string;
  /** Task runners by `kind`. */
  runners?: Record<string, TaskRunner>;
  /** The app's own ops, keyed `<app>.<name>`: reachable from `/cmd` and the WebSocket. */
  verbs?: Record<string, VerbHandler>;
  /**
   * The app's own event types, each `<app>.<event>`, with whether it wakes the
   * agent's tail (`TailRule`). The test: an event belongs on the agent's tail
   * only if it can change what the agent should do next. What the human only
   * looked at is `quiet`: kept on the log, and readable in `state`.
   */
  events?: Readonly<Record<string, TailRule>>;
  /**
   * The `hint` a human message carries on the agent's tail, in place of the
   * fixed one (`replyHint`: say now, start a task, or both). The slot for
   * something smarter to pick one of the three; `undefined` keeps the fixed
   * hint. Every command it names must carry `--session <id>`.
   */
  messageHint?: (input: MessageHintInput) => string | undefined;
  /**
   * The app's own gestures a message can come through, beside the kit's
   * (`KIT_VIA`): Sound Stage's pace button is `"pace"`. Build one list,
   * `[...KIT_VIA, "pace"] as const`, and derive the app's union from it. A
   * `say` with a value outside the list is stored as sent and answered with an
   * advisory, never refused.
   */
  via?: readonly string[];
  /**
   * The app's own ref roles, beside the kit's (`KIT_REF_ROLES`). An unknown
   * role is stored as sent, with an advisory.
   */
  refRoles?: readonly string[];
  /** The app's own view of the session, for `appState` in the snapshot. */
  appState?: (ctx: WorkspaceContext) => unknown;
  /** Extra HTTP routes (an audio stream, say). Return nothing to fall through. */
  http?: (
    req: Request,
    url: URL,
    ctx: WorkspaceContext,
  ) => Response | Promise<Response> | null | undefined;
  /** The built surface: `distDir` holds `index.html` in release mode; `devIndex` is the dev HTML entry. */
  surface?: { distDir?: string; devIndex?: () => unknown | Promise<unknown> };
  /** Listen here; default an ephemeral port. */
  port?: number;
  /** Reopen this saved session instead of starting a new one. */
  restore?: string;
  /** A NEW session's workspace: the directory `open` ran in. A restored session keeps its own. */
  workspace?: string;
  /** Idle timeout in seconds; default 1800, `0` stands until closed. */
  timeoutS?: number;
  /** Where discovery pointers go; default the OS temp directory. */
  tmp?: string;
  /** How long a human waits before the wait is reported; default 30 s. A test seam. */
  stallMs?: number;
  /**
   * How long the stop waits for queued frames to flush when a tail, a socket or
   * a request is still open; default 150 ms. With nobody connected there is no
   * wait. A test seam.
   */
  drainGraceMs?: number;
  /**
   * The app's part of the link layer (kit-link-edges-slot): edges it adds
   * beside each document's body links, each with a kind, and a resolver for
   * its own ways of naming a document, tried after the kit's. `graph`,
   * `backlinks` and `link-check` carry the edges and filter by kind.
   */
  links?: LinkSlot;
  /** Hooks an app may set to take part in an act the kit performs. */
  hooks?: {
    /**
     * Called before a version is deleted, from any path (the surface, the agent's
     * verb). Refuse with a reason, or allow. A refusal is a conflict the caller
     * reads; an app that keeps renders per version says so here.
     */
    beforeVersionDelete?: (
      doc: string,
      version: number,
      ctx: WorkspaceContext,
      /** Who asked: the human's surface confirms in its own dialog; the agent cannot. */
      call: { by: Actor },
    ) => Promise<{ allow: boolean; reason?: string }>;
    /**
     * Called after a version has been deleted and recorded, from any path. For
     * what the app kept per version (renders, say) and must now tidy.
     */
    afterVersionDelete?: (
      doc: string,
      version: number,
      ctx: WorkspaceContext,
      call: { by: Actor },
    ) => void | Promise<void>;
    /**
     * Called when a page's socket closes (a reload, a closed tab, the session
     * ending), with the id its verb calls carried (`VerbCall.surface`): for what
     * the app kept per page and must now forget.
     */
    onSurfaceClose?: (surface: string, ctx: WorkspaceContext) => void;
    /**
     * What the app adds to a human message's `about` on the agent's tail, from
     * what the sending page shows (its id is `VerbCall.surface`): Atlas adds
     * `map` while that page shows its map. Context the app's quiet events
     * would otherwise have carried. Keys are the app's; a kit key is dropped.
     */
    messageAbout?: (surface: string, ctx: WorkspaceContext) => Record<string, unknown> | undefined;
    /**
     * Called before the daemon handles any kit op, from a surface's socket or
     * the agent's `/cmd` (not the app's own verbs), with the op's name. An app
     * that holds a document's text in memory and writes it on a timer writes
     * it here, so Save, Compare, a new version, activate, merge and revert all
     * read the file as the human sees it. A throw refuses the kit op: the
     * surface gets an error frame, the agent a refusal, and the op is not run.
     */
    beforeKitAct?: (op: string, ctx: WorkspaceContext) => void;
    /**
     * Called when a rename or move's links are rewritten (accepted, or its
     * undo or redo) in a document the session holds, before the kit writes
     * its active version. An app that holds the document's text in memory
     * (Atlas's open board) applies `swaps` there itself, each target written
     * `from` becoming `to`, through its own changes so nothing it holds is
     * overwritten, writes the active version as it writes any change
     * (`ctx.edit`), and returns how many it changed. Return undefined for a
     * document the app does not hold: the kit writes the active version. The
     * kit writes the document's file either way. A `SessionError` leaves the
     * document as it was, named as left with the error's reason.
     */
    rewriteHeld?: (
      doc: string,
      swaps: readonly (readonly [string, string])[],
      ctx: WorkspaceContext,
    ) => number | undefined;
    /**
     * Called once a rename or move is done, by either party, with where the
     * item was and where it is now (absolute). Not called for that act's undo
     * or redo. An app that keeps something keyed by the item's path (a stage's
     * order entry and audio folder for a document in its `docs/`) follows the
     * change here, writing nothing the agent must be told of, and returns its
     * way back (`Follow`): the kit keeps it on the act's undo, so one arrow
     * puts the file and the app's part back, and runs it after its own undo or
     * redo. Return undefined when there was nothing to follow. A throw leaves
     * the act done, and the chat line says the app could not follow it; a
     * `FollowError` also hands over the way back from the part it did do,
     * which the kit keeps as if returned.
     */
    followMove?: (
      moved: { op: "move" | "rename"; from: string; to: string; by: "human" | "agent" },
      ctx: WorkspaceContext,
    ) => Follow | undefined;
    /** Called as the daemon begins to close, for any reason: write what is still held in memory. */
    beforeClose?: (ctx: WorkspaceContext) => void;
  };
  /** How often the attention tick looks; default 1 s. A test seam. */
  attentionMs?: number;
  /**
   * How long the agent still counts as listening after its last tail detached,
   * or after its last call; default `AGENT_GRACE_MS`. A test seam.
   */
  agentGraceMs?: number;
  /**
   * How long after a `--once` tail closes on a delivered frame; default
   * `AGENT_ONCE_GRACE_MS`. A test seam.
   */
  agentOnceGraceMs?: number;
  /** How long arrivals in one document gather before one fact; default `IMAGE_ARRIVAL_SETTLE_MS`. A test seam. */
  imageArrivalMs?: number;
  /** Test seams: how a reveal is spawned, which platform to answer for, and the native picker. */
  reveal?: (argv: string[]) => void;
  platform?: string;
  /**
   * How a path is moved to the Trash. Absent, the operating system's Trash
   * (`trash.ts`); a test passes its own, so no test touches the real one. Under
   * `bun test` (NODE_ENV=test) the real Trash is refused outright.
   */
  trash?: TrashFn;
  pick?: (
    kind: PickKind,
    prompt: string,
    defaultName?: string,
  ) => Promise<{ paths: string[]; cancelled: boolean }>;
};

export type WorkspaceDaemon = {
  /** Boot: create or restore the session, bind, publish discovery, say `ready`. */
  start(): Promise<void>;
  /** Close the session as `close` does, and resolve when the daemon has drained. */
  stop(): Promise<void>;
  readonly url: string;
  readonly port: number;
  readonly sessionId: string;
  /** The session folder. */
  readonly dir: string;
  readonly mode: "dev" | "release";
  /** Resolves with the exit code when the daemon ends: 0 closed, 124 idle. */
  readonly done: Promise<{ code: number; reason: string; by: ClosedBy }>;
  /** Resolves when teardown has finished. */
  readonly shutdown: Promise<void>;
  /** The running session and its context, for tests and for an app's own code. */
  readonly session: WorkspaceSession;
  readonly context: WorkspaceContext;
};

/** A path typed in the surface. It has no working directory, so it must be absolute or start at `~`. */
export function surfacePath(p: string): string {
  const t = p.trim();
  if (t === "~" || t.startsWith("~/")) return expandHome(t);
  if (!isAbsolute(t))
    throw new SessionError(`"${p}" is not a full path: start it with / or ~/`, 400);
  return resolve(t);
}

/**
 * A structure op with every path field through `surfacePath`: from the surface,
 * and from the agent's `/cmd` too. The daemon's working directory is the folder
 * `open` ran in, which no caller named, so an empty or relative `dir`, `into` or
 * `path` is refused rather than resolved against it. The kit's CLI resolves a
 * relative path in the agent's own directory before it posts.
 */
function anchorSurfacePaths(op: StructureOp): StructureOp {
  const out: Record<string, unknown> = { ...op };
  for (const k of ["dir", "path", "into"] as const)
    if (typeof out[k] === "string") out[k] = surfacePath(out[k] as string);
  return out as StructureOp;
}

export function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return join(homeDir(), p.slice(2));
  return resolve(p);
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * An app's undo that changed things and then could not finish (the Trash took
 * one of what the act made and refused the next). It can never be undone as a
 * whole again, so it comes off the list like any gone step, and the chat says
 * what was done.
 */
class PartialUndo extends GoneError {}

/**
 * The mark on a frame the agent's tail is not sent (`TailRule`). A symbol: the
 * log's spread keeps it on the frame, and `JSON.stringify` leaves it off the wire.
 */
const QUIET = Symbol("quiet");

/** Findings compared across a save: what each says and how many it counts. */
const findingsKey = (list: readonly Finding[]): string =>
  list.map((f) => `${f.kind}:${f.count ?? ""}:${f.message}`).join("\n");

/** An undo or redo refused: the reason, and, when it can never succeed, that it is off the list. */
const historyRefusal = (e: unknown, which: "undo" | "redo" = "undo"): string =>
  e instanceof GoneError ? `${e.message}; it has been taken off the ${which} list.` : messageOf(e);

export function createWorkspaceDaemon(opts: WorkspaceDaemonOptions): WorkspaceDaemon {
  const app = checkApp(opts.app);
  const appEvents = new Map(Object.entries(opts.events ?? {}));
  for (const [e, rule] of appEvents) {
    if (!e.startsWith(`${app.name}.`) || e.length === app.name.length + 1)
      throw new Error(`app event "${e}" must be named ${app.name}.<event>`);
    if (rule !== "wake" && rule !== "quiet")
      throw new Error(`app event "${e}" must say whether it wakes the agent: "wake" or "quiet"`);
  }
  const verbs = new Map(Object.entries(opts.verbs ?? {}));
  for (const name of verbs.keys())
    if (!name.startsWith(`${app.name}.`) || name.length === app.name.length + 1)
      throw new Error(`app verb "${name}" must be named ${app.name}.<op>`);
  const tailRules = new Map<string, TailRule>([...Object.entries(KIT_EVENT_TAIL), ...appEvents]);
  const platform = opts.platform ?? process.platform;
  const timeoutS = opts.timeoutS ?? 1800;
  const sessionId = opts.restore ?? newSessionId();
  const dir = join(opts.sessionsRoot, sessionId);
  const mode = opts.surface?.distDir ? resolveMode(opts.surface.distDir) : "dev";

  let resolveDone!: (v: { code: number; reason: string; by: ClosedBy }) => void;
  const done = new Promise<{ code: number; reason: string; by: ClosedBy }>((r) => {
    resolveDone = r;
  });
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((r) => {
    resolveShutdown = r;
  });

  // Everything the running daemon owns lives in `run`, set by `start`.
  let run: { port: number; session: WorkspaceSession; ctx: WorkspaceContext } | null = null;
  /** While `boot` runs past binding: what a throw must undo. Cleared once it returns. */
  let unwindBoot: (() => void) | null = null;

  // A function, not a generic arrow: `<T>(` reads as JSX to a tsx parser,
  // and the import-boundary ward audits every file with one.
  function need<T>(v: T | undefined | null, what: string): T {
    if (v === undefined || v === null) throw new Error(`the daemon is not started (${what})`);
    return v;
  }

  return {
    async start() {
      if (run) throw new Error("the daemon is already started");
      try {
        run = await boot();
      } catch (e) {
        // A start that failed after binding leaves nothing behind: no port
        // still listening, no pointer naming it for `close` to get a 500 from.
        unwindBoot?.();
        throw e;
      } finally {
        unwindBoot = null;
      }
    },
    async stop() {
      if (!run) return;
      resolveDone({ code: 0, reason: "stop", by: "agent" });
      await shutdown;
    },
    get url() {
      return `http://127.0.0.1:${need(run, "url").port}`;
    },
    get port() {
      return need(run, "port").port;
    },
    sessionId,
    dir,
    mode,
    done,
    shutdown,
    get session() {
      return need(run, "session").session;
    },
    get context() {
      return need(run, "context").ctx;
    },
  };

  async function boot() {
    const devIndex = mode === "dev" ? await opts.surface?.devIndex?.() : undefined;
    const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;

    const session = opts.restore
      ? WorkspaceSession.restore(opts.sessionsRoot, app, opts.restore)
      : WorkspaceSession.create(opts.sessionsRoot, app, sessionId, opts.workspace);
    if (opts.links) session.setLinkSlot(opts.links);
    if (opts.appHome !== undefined) session.setAppHome(opts.appHome);

    let selection: Selection | null = null;
    /** The document text on screen: the open document at its active version. */
    const screen = (): Screen | null => {
      const d = session.openDocSlug ? session.findDoc(session.openDocSlug) : undefined;
      return d ? { doc: d.slug, version: d.active } : null;
    };
    /**
     * The held selection, once the text it was made in is still the text on
     * screen. Read through this, never `selection` directly: the open document
     * moves under it from many places (the surface's `open` and `open.doc`, the
     * agent, a version activated, an entry removed), and a check at each of them
     * is a check some future path forgets. Dropping it here, on the next read, is
     * why going back to the first document does not revive it.
     */
    const heldSelection = (): Selection | null => {
      selection = selectionOnScreen(selection, screen());
      return selection;
    };

    // --- prefs: the app's preferences, outliving a session's port ------------
    // Browser storage is keyed by origin, port included, and every session gets
    // a new port, so a pane size kept in localStorage resets at the next `open`.
    // They live beside the sessions instead, shared by every session of the app
    // and the same for every world: per-viewer conveniences, and the app
    // preferences the daemon itself reads (the image import settings,
    // `lib/imageImport.ts`), whose values are checked when set.
    const prefsFile = join(dirname(opts.sessionsRoot), "prefs.json");
    const PREF_KEY = /^[a-z][a-z0-9:._-]{0,63}$/;
    const PREF_VALUE_MAX = 4096;
    const PREF_KEYS_MAX = 64;
    /**
     * Read the prefs fresh. Several sessions can share one folder, each its own
     * daemon, so a copy loaded once at boot and written back whole would erase a
     * key another session wrote since. Every write is therefore read, set one
     * key, write, and every snapshot reads the file. Only well-formed entries
     * survive a read; a bad file reads as empty and is replaced by the next write.
     */
    const readPrefs = (): Record<string, string> => {
      const out: Record<string, string> = {};
      try {
        const raw = JSON.parse(readFileSync(prefsFile, "utf8")) as unknown;
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw))
            if (PREF_KEY.test(k) && typeof v === "string" && v.length <= PREF_VALUE_MAX) out[k] = v;
        }
      } catch {
        /* no prefs yet, or unreadable: empty */
      }
      return out;
    };
    /**
     * Set some prefs at once, read fresh and written whole (see `readPrefs`),
     * and tell every page. Refuses a bad key or value, or one key too many,
     * before anything is written. False when nothing changed.
     */
    const setPrefs = (entries: Record<string, string>): boolean => {
      for (const [key, value] of Object.entries(entries)) {
        if (!PREF_KEY.test(key) || typeof value !== "string" || value.length > PREF_VALUE_MAX)
          throw new SessionError(`refused pref ${JSON.stringify(key)}`, 400);
        const why = imagePrefRefusal(key, value);
        if (why) throw new SessionError(why, 400);
      }
      const current = readPrefs();
      const next = { ...current, ...entries };
      if (Object.entries(entries).every(([k, v]) => current[k] === v)) return false;
      if (
        Object.keys(next).length > PREF_KEYS_MAX &&
        Object.keys(next).length > Object.keys(current).length
      )
        throw new SessionError(
          `refused prefs ${Object.keys(entries).join(", ")}: ${PREF_KEYS_MAX} keys already kept`,
          400,
        );
      writeFileAtomic(prefsFile, `${JSON.stringify(next, null, 2)}\n`);
      broadcastState();
      return true;
    };
    const userHome = homeDir();

    /**
     * The snooze the agent asked for, and the messages already nudged.
     *
     * One nudge per message is the whole anti-nag rule: a message id enters
     * `nudged` the first time it is reported, or the moment the agent snoozes
     * it, and never leaves. A snooze expiring therefore changes what the human
     * sees (back to "may be stuck", because they are owed the truth) without
     * pinging the agent again.
     *
     * In memory, not in the manifest, deliberately: a restored session whose
     * human was left waiting should tell the agent that arrives.
     */
    let acknowledgedUntil: number | undefined;
    const nudged = new Set<string>();
    /** The context's undo history, in memory on purpose (see `history.ts`). */
    const history = new History();
    /**
     * Links the last rename or move broke, offered for updating (`relink`): good
     * while that act is still the top of the undo stack and nothing has changed
     * the context's shape since.
     */
    let relinkOffer: {
      act: Act;
      fixes: DocLinkFixes[];
      wiki: WikiBreak[];
      what: string;
      by: "human" | "agent";
    } | null = null;
    const relinkView = (): RelinkOffer | null => {
      const o = relinkOffer;
      if (!o || history.peekUndo() !== o.act) return null;
      return {
        what: o.what,
        by: o.by,
        count: o.fixes.reduce((n, d) => n + d.fixes.length, 0),
        docs: o.fixes.map((d) => ({
          path: d.path,
          // A bundle's references are shown under the bundle's name, as its row is.
          shown: d.noun ? session.itemName(dirname(d.path)) : session.display(d.path),
          fixes: d.fixes,
          ...(d.noun ? { noun: d.noun } : {}),
        })),
        wiki: o.wiki.map((w) => ({ ...w, shown: session.display(w.path) })),
      };
    };

    // --- channels -------------------------------------------------------------
    const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
    /** An id per connected page, for an app that keeps something per page (`VerbCall.surface`). */
    const surfaceIds = new WeakMap<import("bun").ServerWebSocket<unknown>, string>();
    let surfaceSeq = 0;
    const surfaceId = (ws: import("bun").ServerWebSocket<unknown>): string => {
      let id = surfaceIds.get(ws);
      if (!id) {
        id = `s${++surfaceSeq}`;
        surfaceIds.set(ws, id);
      }
      return id;
    };
    const log = createEventLog<LogEvent>({ epoch: crypto.randomUUID() });
    const sseClients: SseClients = new Set();
    /**
     * Agent presence, derived from what the agent's CLI does and never from a
     * claim the agent makes: how many of its tails are open, and until when the
     * last tail to let go, or its last call, holds it (`AGENT_GRACE_MS`,
     * `AGENT_ONCE_GRACE_MS`). `presenceShown` is what the surface was last sent.
     */
    let agentTails = 0;
    let agentHeldUntil = 0;
    let agentGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let presenceShown = false;
    const agentGraceMs = opts.agentGraceMs ?? AGENT_GRACE_MS;
    const agentOnceGraceMs = opts.agentOnceGraceMs ?? AGENT_ONCE_GRACE_MS;
    const agentListening = (): boolean => agentTails > 0 || performance.now() < agentHeldUntil;
    let lastActivity = performance.now();
    const touch = () => {
      lastActivity = performance.now();
    };

    const send = (frame: { op: string; [key: string]: unknown }) => {
      const s = JSON.stringify(frame);
      for (const ws of sockets) {
        try {
          ws.send(s);
        } catch {
          /* socket closed */
        }
      }
    };

    const emit = (type: string, fields: Record<string, unknown> = {}, o: EmitOptions = {}) => {
      const rule = tailRules.get(type);
      if (rule === undefined)
        throw new Error(
          `unknown event "${type}": kit events are fixed, and ${app.name} declares ${
            appEvents.size === 0 ? "none" : [...appEvents.keys()].join(", ")
          }`,
        );
      // Marked before the log fans it out: a live tail's filter runs inside `emit`.
      const quiet = !(o.wake ?? rule === "wake");
      log.emit({ ...fields, type, ...(quiet ? { [QUIET]: true } : {}) });
    };

    // The task engine is built before the snapshot because the snapshot reads it.
    let closed = false;
    let broadcastState: () => void = () => {};
    // An app's own view can depend on the text (an app that hashes the active
    // version), and the kit only broadcasts an edit when the dirty flag flips, so a
    // daemon with an `appState` hook also broadcasts after a pause in typing.
    let editTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleEditBroadcast = () => {
      if (editTimer) return;
      editTimer = setTimeout(() => {
        editTimer = null;
        if (!closed) broadcastState();
      }, 250);
    };
    const engine = new TaskEngine(session, opts.runners ?? {}, {
      emit,
      say: (m) => {
        session.addMessage(m);
        broadcastState();
      },
      changed: () => broadcastState(),
      context: () => ctx,
    });

    const appCtx = (): WorkspaceContext => ctx;
    const viewState = (): PublicState => {
      const base = session.view();
      return {
        app: app.name,
        ...(app.title ? { appTitle: app.title } : {}),
        sessionId,
        dir: session.dir,
        ...(session.hasHome ? { workspace: session.workspace } : {}),
        mode,
        agentListening: agentListening(),
        context: base.context,
        docs: base.docs,
        openDoc: base.openDoc,
        openImage: base.openImage,
        selection: heldSelection(),
        chat: base.chat,
        tasks: engine.view(),
        waiting: waitingOn(base.chat, Date.now(), { acknowledgedUntil, stallMs: opts.stallMs }),
        // The same rule for notes, over the whole conversation: a reply that
        // answers a note may be older than the chat a snapshot carries.
        notesWaiting: notesWaiting(session.noteFacts(), session.messages(), Date.now(), {
          acknowledgedUntil,
          stallMs: opts.stallMs,
        }),
        history: history.view(),
        ...((offer) => (offer ? { relink: offer } : {}))(relinkView()),
        prefs: readPrefs(),
        userHome,
        ...(app.launcher ? { launcher: app.launcher } : {}),
        appState: opts.appState?.(appCtx()) ?? null,
      };
    };
    broadcastState = () => {
      presenceShown = agentListening();
      send({ op: "state", state: viewState() });
    };

    /** A line in the chat. */
    const line = (text: string, about?: MessageAbout): Message => {
      const m = session.addMessage({
        from: "system",
        type: "info",
        text,
        ...(about ? { about } : {}),
      });
      broadcastState();
      return m;
    };

    /** A system line in the chat and, because the agent must know it too, on the log. */
    /** A create with no folder (`dir`), from either route: a 400 with the app's hint (`missingDir`). */
    const refuseMissingDir = (cmd: { op?: unknown; dir?: unknown }): void => {
      const r = missingDir(app, cmd);
      if (r) throw new SessionError(r.message, 400, undefined, r.hint);
    };

    const announce = (text: string, fact: Record<string, unknown> = {}) => {
      const m = session.addMessage({ from: "system", type: "info", text });
      emit("system", { text, ts: m.ts, ...fact });
      broadcastState();
    };

    const revealPath = (raw: string): string => {
      const target = session.revealTarget(raw);
      const argv = revealCommand(platform, target);
      if (!argv)
        throw new SessionError(`no file manager to reveal in on this system (${platform})`, 409);
      if (opts.reveal) opts.reveal(argv);
      else {
        const [cmd, ...args] = argv;
        Bun.spawn([cmd as string, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
      }
      return target;
    };

    /**
     * An app's act onto the context's history (`ctx.history.push`). What it
     * made is hashed now, as it was made, so its undo can tell it untouched.
     */
    const pushAppAct = (act: AppAct): void => {
      const label = typeof act.label === "string" ? act.label.trim() : "";
      if (!label) throw new SessionError("history.push: an act needs a label", 400);
      if (typeof act.undo !== "function")
        throw new SessionError("history.push: an act needs an undo", 400);
      const creates: Created[] = (act.creates ?? []).map((c) => {
        try {
          return {
            path: c.path,
            dir: c.dir,
            unchanged: c.dir ? treeHash(c.path) : contentHash(readFileSync(c.path, "utf8")),
          };
        } catch {
          throw new SessionError(`history.push: ${session.display(c.path)} is not there`, 400);
        }
      });
      history.did({
        label,
        inverse: {
          kind: "app",
          label,
          undo: act.undo,
          ...(act.redo && creates.length === 0 ? { redo: act.redo } : {}),
          ...(creates.length > 0 ? { creates } : {}),
        },
      });
      broadcastState();
    };

    const ctx: WorkspaceContext = {
      app: app.name,
      session,
      tasks: engine,
      emit,
      line,
      announce,
      send,
      // An app verb may have changed the context (a stage made in the
      // workspace is a new listed entry): its watches are armed again with the
      // snapshot, so an outside change inside it is seen.
      broadcast: () => {
        syncWatchers();
        broadcastState();
      },
      edit: (doc, version, text) => editActive(doc, version, text),
      history: { push: (act) => pushAppAct(act) },
      touch,
      reveal: revealPath,
      pick: (kind, prompt, defaultName) => pickGuarded(kind, prompt, defaultName),
    };

    // --- the watcher ----------------------------------------------------------
    //
    // `node:fs` `watch` (Bun's built-in), not a native watcher addon: an addon's
    // loader does a runtime `require()` of a per-platform package that a bundle
    // does not inline. Measured under Bun on macOS: a recursive directory watch
    // reports an in-place write, an atomic tmp+rename save, and both again in a
    // subdirectory. The hash-compare and self-write suppression live in the
    // session.
    const watchers = new Map<string, FSWatcher>();
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    // A file under the context changed on disk: tell the surfaces, once a burst
    // settles, so a view of the whole context (the link check) can ask again. A
    // change to a document the session does not hold sends no snapshot, so
    // without this such a view would go stale. Carries nothing; it is a cue.
    // The session's own version files are not the context: an edit's write
    // lands there, and the surface that sent the edit already knows of it.
    let contextChanged: ReturnType<typeof setTimeout> | null = null;
    const cueContextChanged = () => {
      if (contextChanged) clearTimeout(contextChanged);
      contextChanged = setTimeout(() => {
        contextChanged = null;
        if (closed) return;
        send({ op: "context.changed" });
        pruneImageThumbs();
      }, CONTEXT_CHANGED_SETTLE_MS);
      contextChanged.unref?.();
    };
    /**
     * Drop cached thumbnails no image in the context has now (a file changed,
     * renamed away, deleted), once the context settles and on close. Best-effort.
     */
    const pruneImageThumbs = () => {
      try {
        pruneThumbs(session.dir, session.imageStamps());
      } catch {
        /* a cache: the next prune tries again */
      }
    };
    const onFs = (abs: string, inContext = true) => {
      if (inContext) cueContextChanged();
      const t = pending.get(abs);
      if (t) clearTimeout(t);
      pending.set(
        abs,
        setTimeout(() => {
          pending.delete(abs);
          let evs: FileEvent[] = [];
          try {
            evs = session.onFileEvents(abs);
          } catch (e) {
            process.stderr.write(`${app.name}: watcher: ${e}\n`);
          }
          for (const ev of evs) handleFileEvent(ev);
          // The documents at or under the path are asked after by path (a
          // deleted folder may be reported only as the folder), a moment later,
          // so a file gone only for an instant is never called missing.
          const prev = rechecks.get(abs);
          if (prev) clearTimeout(prev);
          rechecks.set(
            abs,
            setTimeout(() => {
              rechecks.delete(abs);
              if (closed) return;
              try {
                for (const gone of session.originalsUnder(abs)) handleFileEvent(gone);
              } catch (e) {
                process.stderr.write(`${app.name}: watcher: ${e}\n`);
              }
            }, MISSING_RECHECK_MS),
          );
        }, WATCH_SETTLE_MS),
      );
    };
    const rechecks = new Map<string, ReturnType<typeof setTimeout>>();
    // Watchers synced again once a burst under a listed folder settles, so a
    // `_meta/profiles/` made after the session started is watched too.
    let resync: ReturnType<typeof setTimeout> | null = null;
    const resyncSoon = () => {
      if (resync) clearTimeout(resync);
      resync = setTimeout(() => {
        resync = null;
        if (!closed) syncWatchers();
      }, CONTEXT_CHANGED_SETTLE_MS);
      resync.unref();
    };
    const syncWatchers = () => {
      const want = new Map(
        session.watchRoots().map((r) => [`${r.recursive ? "R" : "F"}:${r.watch}>${r.path}`, r]),
      );
      for (const [key, w] of watchers)
        if (!want.has(key)) {
          w.close();
          watchers.delete(key);
        }
      for (const [key, r] of want) {
        if (watchers.has(key)) continue;
        try {
          const inContext = r.path !== session.docsDir;
          // Watched at the realpath, reported under the stored path form.
          const w = watch(r.watch, { recursive: r.recursive }, (_event, name) => {
            // A listed document's folder is watched alone, and its
            // `_meta/profiles/` beside it only once it exists (`watchRoots`):
            // a `_meta` appearing there is a cue to look again.
            if (name && !r.recursive && r.entryId && name.toString() === "_meta") resyncSoon();
            if (name) onFs(join(r.path, name.toString()), inContext && !isDotPath(name.toString()));
            else if (r.entryId) onFs(r.path, inContext);
          });
          w.on("error", () => {
            /* the directory went away; the next sync drops it */
          });
          watchers.set(key, w);
        } catch {
          /* unwatchable (gone, permissions): outside changes there go unseen */
        }
      }
    };

    const activeOf = (doc?: string) => {
      const slug = doc ?? session.openDocSlug;
      if (!slug) return null;
      try {
        const v = session.doc(slug);
        return { doc: v.slug, version: v.active, path: session.activePath(v.slug) };
      } catch {
        return null;
      }
    };

    const announceOutside = (
      doc: string,
      version: number,
      path: string,
      preservedAs: number,
      preservedPath: string,
    ) => {
      emit("version.created", {
        doc,
        version: preservedAs,
        fromVersion: version,
        by: "agent",
        path: preservedPath,
        preserved: true,
      });
      announce(
        `v${version} of ${doc} is the active version and was written from outside the editor. That text is kept as v${preservedAs}; the active version keeps your text. Agent edits belong in a new version (version-new).`,
        { fact: "active.outside", doc, version, path, preservedAs, preservedPath },
      );
    };

    /**
     * A version written from outside (the agent's own tools, after
     * `version-new`) that leaves a JSON document not parsing: said to the agent
     * on the log, with where and why, since Save will refuse it. Not in the
     * chat: the human has not asked for it and may never activate it.
     */
    const tellInvalidJson = (doc: string, version: number) => {
      let p: ReturnType<typeof session.jsonProblemOf>;
      let view: DocView;
      try {
        p = session.jsonProblemOf(doc, version);
        view = session.doc(doc);
      } catch {
        return;
      }
      if (!p) return;
      const { name } = view;
      const path = view.versions.find((v) => v.n === version)?.path ?? "";
      emit("system", {
        text: `v${version} of ${name} is not valid JSON (${describeJsonProblem(p)}). Save, and your activate and merge, refuse it until it parses: fix ${path}.`,
        fact: "json.invalid",
        doc,
        version,
        path,
        line: p.line,
        column: p.column,
        problem: p.problem,
      });
    };

    const handleFileEvent = (ev: FileEvent) => {
      switch (ev.kind) {
        case "version.changed":
          send({
            op: "version.text",
            doc: ev.doc,
            version: ev.version,
            text: ev.text,
            origin: "remote",
          });
          broadcastState();
          tellInvalidJson(ev.doc, ev.version);
          return;
        case "version.created":
          emit("version.created", {
            doc: ev.doc,
            version: ev.version,
            by: "agent",
            path: ev.path,
            adopted: true,
            ...(ev.renamedFrom !== undefined ? { renamedFrom: ev.renamedFrom } : {}),
          });
          line(
            ev.renamedFrom !== undefined
              ? `A file written directly as v${ev.renamedFrom} of ${ev.doc} reused a number that was already taken, so it is kept as v${ev.version} (${ev.path}).`
              : `v${ev.version} of ${ev.doc} appeared (written directly to ${ev.path})`,
          );
          tellInvalidJson(ev.doc, ev.version);
          return;
        case "active.outside": {
          // The agent never writes the version the human is editing. The outside
          // text is kept as a new agent version and the active version keeps the
          // human's text: nothing is lost, and the human's buffer is not touched.
          announceOutside(ev.doc, ev.version, ev.path, ev.preservedAs, ev.preservedPath);
          tellInvalidJson(ev.doc, ev.preservedAs);
          return;
        }
        case "original.reloaded":
          send({
            op: "version.text",
            doc: ev.doc,
            version: ev.version,
            text: ev.text,
            origin: "remote",
          });
          announce(`${ev.original} changed on disk: reloaded (you had no unsaved edits).`, {
            fact: "original.reloaded",
            doc: ev.doc,
          });
          return;
        case "original.conflict":
          announce(
            `${ev.original} changed on disk while you have unsaved edits. Save overwrites it with yours; Revert takes the file's version.`,
            { fact: "original.conflict", doc: ev.doc },
          );
          return;
        case "original.missing":
          announce(
            ev.folder
              ? `${session.display(ev.original)} is gone from disk, and so is its folder (deleted or moved outside the app). The text and its versions are still here: Close puts it away, and Save makes the folder and the file again only when asked.`
              : `${session.display(ev.original)} is gone from disk (deleted or moved outside the app). The text and its versions are still here: Close puts it away, and Save recreates the file only when asked.`,
            { fact: "original.missing", doc: ev.doc, original: ev.original, folder: ev.folder },
          );
          return;
        case "original.back":
          announce(`${session.display(ev.original)} is back on disk, as it was.`, {
            fact: "original.back",
            doc: ev.doc,
            original: ev.original,
          });
          return;
        case "tree":
          broadcastState();
          return;
        case "bundle": {
          // Quiet: the file is on disk to read, and a view of the bundle is
          // told directly. Its row may have a new title, so the state goes too.
          send({ op: "bundle.changed", path: ev.path, file: ev.file });
          emit(
            "system",
            {
              text: `${session.display(ev.file)} changed on disk, in ${session.display(ev.path)}.`,
              fact: "bundle.changed",
              path: ev.path,
              file: ev.file,
            },
            { wake: false },
          );
          broadcastState();
          return;
        }
      }
    };

    // --- the Trash: the human's delete, never the agent's ---------------------
    const trashFn: TrashFn =
      opts.trash ??
      // `underTest()`, not `process.env.NODE_ENV`: a build that defines the
      // latter would compile this refusal out (see `../lib/home.ts`).
      (underTest()
        ? async () => {
            throw new SessionError(
              "the real Trash is not used under test: pass a trash function",
              409,
            );
          }
        : systemTrash(platform));
    let trashing = false;
    /** Move one path to the Trash for the human, and say so in the chat and on the log. */
    const trashForHuman = async (raw: string): Promise<string> => {
      const pre = session.trashPreview(surfacePath(raw));
      // Named before anything moves: once gone, a loose file's entry is too,
      // and it would be named by its whole path.
      const sidecarShown = pre.sidecar ? session.display(pre.sidecar) : null;
      // One at a time: a second click while the first runs is refused, not queued.
      if (trashing) throw new SessionError("a move to the Trash is already running", 409);
      trashing = true;
      // An image's description goes with it. The image first: if it cannot go,
      // nothing has. If the description then cannot, it stays, and is said.
      let sidecarLeft: string | null = null;
      try {
        await trashFn(pre.path);
        if (pre.sidecar) {
          try {
            await trashFn(pre.sidecar);
          } catch (e) {
            sidecarLeft = messageOf(e);
          }
        }
      } catch (e) {
        throw e instanceof SessionError ? e : new SessionError(messageOf(e), 409);
      } finally {
        trashing = false;
      }
      const r = session.trashed(pre.path);
      if (pre.sidecar && sidecarLeft === null) r.docs.push(...session.trashed(pre.sidecar).docs);
      syncWatchers();
      const described = sidecarShown
        ? sidecarLeft === null
          ? ` and its description, ${sidecarShown},`
          : ` (its description, ${sidecarShown}, could not go: ${sidecarLeft})`
        : "";
      // A bundle goes whole, as the one item its row is.
      const what = pre.bundle
        ? `the ${pre.bundle.label} ${pre.bundle.name} (${placeOf(pre.path)})`
        : pre.dir
          ? `the folder ${pre.shown} (${pre.truncated ? "at least " : ""}${pre.files} ${pre.files === 1 ? "file" : "files"})`
          : `${pre.shown}${described}`;
      const names = r.docs.map((slug) => pre.docs.find((d) => d.slug === slug)?.name ?? slug);
      const kept =
        names.length === 0 ? "" : ` The versions of ${names.join(", ")} are kept in the session.`;
      announce(`You moved ${what} to the Trash.${kept}`, {
        fact: "trash",
        by: "human",
        path: pre.path,
        dir: pre.dir,
        files: pre.files,
        docs: r.docs,
        ...(r.closed ? { closed: r.closed } : {}),
        ...(pre.sidecar && sidecarLeft === null ? { sidecar: pre.sidecar } : {}),
      });
      return pre.path;
    };

    // --- images brought in from outside (the human's drop) ---------------------
    /**
     * Bytes that sniff as an image, do not decode, and stop before their
     * format's end marker (cut short in transit) are refused rather than
     * written. What does not sniff as an image is left to the session's own
     * check, which says so in its words.
     */
    const decodesOrDie = async (raw: string, bytes: Uint8Array): Promise<void> => {
      if (sniffImage(bytes.subarray(0, 32)) && !(await imageDecodes(bytes)))
        throw new SessionError(
          `${raw} is cut short: it does not decode, and stops before its format's end: not brought in`,
          400,
        );
    };

    /**
     * An image from outside as it will be written: its name, and its bytes
     * after the app's image import settings (`optimiseImport`: WebP, quality, a
     * longest side; a HEIC photo always converted), checked to decode. The
     * one path every drop and paste goes through. A re-encoded image takes the
     * extension of what it now is and keeps its stem; `given` is the name it
     * came in with, which its description will record.
     */
    let lastImport: { key: string; at: number; r: ImportedBytes } | null = null;
    const incoming = async (
      raw: string,
      bytes: Uint8Array,
    ): Promise<{
      name: string;
      given: string;
      body: Uint8Array;
      done?: string;
      left?: string;
      already?: true;
      stripped?: string;
      metaKept?: string;
    }> => {
      const { name, heic, given } = session.imageNameIn(raw);
      if (bytes.byteLength > IMAGE_MAX_BYTES)
        throw new SessionError(
          `${raw} is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB: not brought in`,
          400,
        );
      let r: ImportedBytes;
      try {
        const settings = readImageImportSettings(readPrefs());
        // The same bytes sent again (the human's answer to a taken name) are
        // not encoded twice: the last result is kept a little while.
        const key = `${Bun.hash(bytes)}:${bytes.byteLength}:${heic}:${JSON.stringify(settings)}`;
        const hit =
          lastImport && lastImport.key === key && performance.now() - lastImport.at < 120_000
            ? lastImport.r
            : null;
        r = hit ?? (await optimiseImport(bytes, settings, { heic }));
        lastImport = { key, at: performance.now(), r };
      } catch (e) {
        throw new SessionError(`${raw} was not brought in: ${messageOf(e)}`, 400);
      }
      await decodesOrDie(raw, r.bytes);
      let file = name;
      // `.jpeg` stays `.jpeg`: the name already says JPEG.
      if (r.done && r.type && !(r.type === "image/jpeg" && /\.jpe?g$/i.test(name)))
        file = `${name.slice(0, name.length - extname(name).length)}${EXTENSION_OF[r.type]}`;
      return {
        name: file,
        given,
        body: r.bytes,
        ...(r.done ? { done: r.done } : {}),
        ...(r.left ? { left: r.left } : {}),
        ...(r.already ? { already: true as const } : {}),
        ...(r.stripped ? { stripped: r.stripped } : {}),
        ...(r.metaKept ? { metaKept: r.metaKept } : {}),
      };
    };
    type Came = {
      done?: string;
      left?: string;
      already?: true;
      stripped?: string;
      metaKept?: string;
    };
    /** What became of its metadata, in words, when anything is to be said. */
    const metaOf = (i: Came) => i.stripped ?? i.metaKept;
    /** What became of an incoming image, as the chat line ends: ", converted …" or ", as it came: …". */
    const howItCame = (i: Came) => {
      const how = i.done ? `, ${i.done}` : i.left ? `, as it came: ${i.left}` : "";
      const meta = metaOf(i);
      return meta ? `${how}${how ? ";" : ","} ${meta}` : how;
    };
    /** The same for the surface to show: what was done, or why it was left. */
    const noteOf = (i: Came) => {
      const how = i.done ?? (i.left ? `kept as it came: ${i.left}` : undefined);
      const meta = metaOf(i);
      return how && meta ? `${how}; ${meta}` : (how ?? meta);
    };
    /**
     * What the answer to the surface says of it: `converted`, or `kept` when
     * the settings would have converted it and could not or should not (not
     * when it already was what they ask for), and the note in words.
     */
    const toldOf = (i: Came) => {
      const note = noteOf(i);
      return {
        ...(i.done ? { converted: true as const } : {}),
        ...(i.left && !i.already ? { kept: true as const } : {}),
        ...(note ? { note } : {}),
      };
    };

    /**
     * One dropped image, from `POST /fs/image`: written as a plain file, or put
     * in place of the image of the same name, whose old file goes to the Trash.
     * Written as the image import settings say (`incoming`); a HEIC photo is
     * converted on the way in. Never the agent's: it has files of its own to
     * write with.
     */
    const imageIn = async (
      raw: string,
      bytes: Uint8Array,
      opts: { dir?: string; onTaken: "ask" | "keep-both" | "replace" },
    ): Promise<{
      path: string;
      replaced?: true;
      converted?: true;
      kept?: true;
      note?: string;
      sidecarKept?: true;
    }> => {
      const i = await incoming(raw, bytes);
      const body = i.body;
      const how = howItCame(i);
      const told = toldOf(i);
      if (opts.onTaken !== "replace") {
        let r: { path: string };
        try {
          r = session.importImage(i.name, body, { dir: opts.dir, onTaken: opts.onTaken });
        } catch (e) {
          // The question names the file that would be written (`photo.webp`
          // for a converted `photo.jpg`): that is what is taken, and replaced.
          if (e instanceof SessionError && e.status === 409 && e.choices?.includes("replace"))
            throw new ImageTakenError(e, i.name);
          throw e;
        }
        session.rememberImportName(r.path, i.given);
        syncWatchers();
        history.did({
          label: `copied in ${basename(r.path)}`,
          inverse: { kind: "delete", path: r.path, dir: false },
        });
        announce(`You copied ${raw} in as ${session.display(r.path)}${how}.`, {
          fact: "image.import",
          by: "human",
          path: r.path,
        });
        return { path: r.path, ...told };
      }
      const name = i.name;
      // Replace: the new bytes are staged beside the old file first, so a
      // failure at any step leaves the old one where it was.
      const target = session.replaceTargetOrDie(name, opts.dir);
      if (trashing) throw new SessionError("a move to the Trash is already running", 409);
      const staged = session.stageImage(target, name, body);
      trashing = true;
      try {
        await trashFn(target);
      } catch (e) {
        session.unstage(staged);
        throw e instanceof SessionError ? e : new SessionError(messageOf(e), 409);
      } finally {
        trashing = false;
      }
      try {
        session.placeStaged(staged, target);
      } catch (e) {
        session.unstage(staged);
        throw e;
      }
      session.rememberImportName(target, i.given);
      syncWatchers();
      // Its description is kept: it may still say what the new image shows (a
      // retouched photo, a re-export), and only someone looking can tell.
      const sidecar = session.sidecarFileOf(target);
      const kept = sidecar
        ? ` Its description, ${session.display(sidecar)}, was kept: check that it still fits.`
        : "";
      announce(
        `You replaced ${session.display(target)} with ${raw}${how}; the old file is in the Trash.${kept}`,
        {
          fact: "image.replace",
          by: "human",
          path: target,
          ...(sidecar ? { sidecar, sidecarKept: true } : {}),
        },
      );
      return {
        path: target,
        replaced: true,
        ...told,
        ...(sidecar ? { sidecarKept: true as const } : {}),
      };
    };

    /**
     * Images that arrived in a document's editor (`POST /fs/image?doc=`), told
     * to the agent once they settle: one `image.pasted` fact per document and
     * burst, naming the document and every image, so the agent can offer to
     * describe and name them before anything else links to them. A fact on the
     * log only, never a chat line: the human already sees the embed.
     */
    const arrivals = new Map<
      string,
      {
        images: string[];
        /** What the import settings did to each image, or why they left it, by path. */
        notes: Record<string, string>;
        how: Set<"paste" | "drop">;
        timer?: ReturnType<typeof setTimeout>;
      }
    >();
    const tellArrival = (doc: string) => {
      const a = arrivals.get(doc);
      arrivals.delete(doc);
      if (!a || closed) return;
      const how = a.how.size > 1 ? "both" : a.how.has("drop") ? "drop" : "paste";
      const what = a.images.length === 1 ? "An image" : `${a.images.length} images`;
      const verb = { paste: "pasted", drop: "dropped", both: "pasted and dropped" }[how];
      // Each image as the embed names it, from the document's own folder
      // (`images/w.png`), whatever entry lists it, with what the import settings did.
      const shown = a.images.map((p) => {
        const rel = relative(dirname(doc), p).split(sep).join("/");
        return a.notes[p] ? `${rel} (${a.notes[p]})` : rel;
      });
      emit("system", {
        fact: "image.pasted",
        by: "human",
        doc,
        images: a.images,
        how,
        ...(Object.keys(a.notes).length > 0 ? { notes: a.notes } : {}),
        text: `${what} ${verb} into ${session.display(doc)}: ${shown.join(", ")}.`,
      });
    };
    /**
     * One image pasted or dropped into a markdown document in the editor:
     * written to the `images/` folder beside it under a free name, and never
     * put in the undo history (`Undo` in the editor takes the embed back and
     * leaves the file, which the link check then lists as embedded nowhere).
     */
    /** An image dropped on a bundle's own view (a board): into its `assets/`, never asked about. */
    const imageIntoBundle = async (
      bundle: string,
      raw: string,
      bytes: Uint8Array,
      how: "paste" | "drop",
    ): Promise<{ path: string; card: string; converted?: true; kept?: true; note?: string }> => {
      const i = await incoming(raw, bytes);
      const r = session.importImageIntoBundle(bundle, i.name, i.body, how);
      session.rememberImportName(r.path, i.given);
      announce(`You copied ${raw} into ${session.display(bundle)}${howItCame(i)}.`, {
        fact: "image.import",
        by: "human",
        path: r.path,
      });
      return { ...r, ...toldOf(i) };
    };

    const imageBeside = async (
      doc: string,
      raw: string,
      bytes: Uint8Array,
      how: "paste" | "drop",
    ): Promise<{ path: string; href: string; converted?: true; kept?: true; note?: string }> => {
      const i = await incoming(raw, bytes);
      const r = session.importImageBeside(doc, i.name, i.body, how);
      // A paste's name is the surface's dated one, not the user's: nothing to keep.
      if (how === "drop") session.rememberImportName(r.path, i.given);
      syncWatchers();
      broadcastState();
      const a = arrivals.get(r.doc) ?? {
        images: [],
        notes: {},
        how: new Set<"paste" | "drop">(),
      };
      if (a.timer) clearTimeout(a.timer);
      a.images.push(r.path);
      const note = noteOf(i);
      if (note) a.notes[r.path] = note;
      a.how.add(how);
      a.timer = setTimeout(
        () => tellArrival(r.doc),
        opts.imageArrivalMs ?? IMAGE_ARRIVAL_SETTLE_MS,
      );
      arrivals.set(r.doc, a);
      return {
        path: r.path,
        href: r.href,
        ...toldOf(i),
      };
    };

    // --- shared acts (surface and agent reach the same code) -------------------
    const addPaths = (paths: string[]) => {
      // A refusal part-way (a set that would hold the workspace) keeps what was
      // added before it, and the watchers and the surface still learn of those.
      try {
        return paths.map((p) => session.addContext(p));
      } finally {
        syncWatchers();
        broadcastState();
      }
    };

    /**
     * Each document's recent switches: the version that was active just before,
     * who switched and when. Only an edit to one of these versions, within
     * `LATE_EDIT_MS` of its switch, is taken late (`editLeft`). In memory only.
     */
    const switches = new Map<string, { from: number; by: "human" | "agent"; at: number }[]>();
    const recordSwitch = (slug: string, from: number, by: "human" | "agent") => {
      const now = performance.now();
      const recent = (switches.get(slug) ?? []).filter((x) => now - x.at < LATE_EDIT_MS);
      recent.push({ from, by, at: now });
      switches.set(slug, recent);
    };
    /** The switch that just left `version`, if it is recent enough for an edit typed there to be taken. */
    const switchLeaving = (slug: string, version: number) => {
      const now = performance.now();
      return (switches.get(slug) ?? [])
        .filter((x) => x.from === version && now - x.at < LATE_EDIT_MS)
        .at(-1);
    };
    const activate = (doc: string | undefined, version: number, by: "human" | "agent") => {
      // Another version active: a rewrite of the old one is nothing its edits rebase onto.
      if (doc !== undefined) forgetRewrite(doc);
      const r = session.activate({ doc, version, ...(by === "agent" ? { json: "refuse" } : {}) });
      recordSwitch(r.slug, r.previous, by);
      const view = session.doc(r.slug);
      const path = view.versions.find((v) => v.n === version)?.path ?? null;
      send({
        op: "version.text",
        doc: r.slug,
        version,
        text: session.readVersion(r.slug, version).text,
        origin: "load",
      });
      const m = session.addMessage({
        from: "system",
        type: "info",
        text: `${by === "agent" ? "Agent" : "You"} made v${version} of ${r.slug} active (was v${r.previous}).`,
      });
      emit("activated", { by, doc: r.slug, version, previous: r.previous, path, ts: m.ts });
      broadcastState();
      return { doc: r.slug, version, previous: r.previous, path };
    };

    /**
     * One structure change, from either party: the same session method, the
     * same announcement (naming who did it), the same log fact. Returns the path
     * the change landed at, which the surface uses to open or rename it.
     */
    // --- how an act names what it acted on -------------------------------------
    //
    // A bundle is named by its title wherever a person reads it (a chat line,
    // an undo's label), never by its folder or its main file.
    const isBundleRoot = (p: string) => bundleOf(p)?.inner === "";
    /** An item's name: a bundle's title (`title` as it was, when given), else its file or folder name. */
    const nameOf = (p: string, title?: { was: string | undefined }) =>
      isBundleRoot(p)
        ? title
          ? bundleDisplayName(basename(p), title.was)
          : session.itemName(p)
        : basename(p);
    /** An item as a chat line names it: `the canvas The well`, or its path as the context shows it. */
    const named = (p: string, name?: string) => {
      const type = isBundleRoot(p) ? bundleTypeOf(p) : null;
      return type ? `the ${type.label} ${name ?? nameOf(p)}` : session.display(p);
    };
    /** Where an item now is, as a chat line says it: `in world/places`, `in the workspace`. */
    const placeOf = (p: string, word = "in") =>
      session.isWorkspace(dirname(p))
        ? `${word} the workspace`
        : `${word} ${session.display(dirname(p))}`;
    /** A bundle rename's names, before and after, by the titles the rename read and wrote. */
    const renamedNames = (m: {
      path: string;
      from: string;
      title?: { from?: string; to?: string };
    }) => {
      const before = m.title ? m.title.from : session.bundleTitleAt(m.path);
      const after = m.title ? m.title.to : session.bundleTitleAt(m.path);
      return {
        from: nameOf(m.from, { was: before }),
        to: nameOf(m.path, { was: after }),
      };
    };

    /**
     * The way back from `set.make`, and forward again: the session's own
     * (`unmakeSet`, `makeSet`), following where the document is after each.
     */
    type AppInverse = Extract<Inverse, { kind: "app" }>;
    /** What a set made from a document says of the links it broke: no verb rewrites them. */
    const SET_MAKE_LINKS_HINT =
      "Turning a document into a set does not rewrite links: write each one as its `to`, or leave it for the link check. Wiki links are never rewritten.";
    const setMakeInverse = (from: string, at: string): AppInverse => {
      let now = at;
      const undo = () => {
        now = session.unmakeSet(now).path;
      };
      // Made again, it breaks the links the first make did: said as that make said them.
      const redo = () => {
        const m = session.makeSet(now, { links: true });
        now = m.path;
        noteRedoBroke(m, "redo", SET_MAKE_LINKS_HINT);
      };
      return { kind: "app", label: `turned ${basename(from)} into a set`, undo, redo };
    };

    const structure = (op: StructureOp, by: "human" | "agent"): Record<string, unknown> => {
      const who = by === "agent" ? "Agent" : "You";
      const shown = (p: string) => session.display(p);
      let r: Record<string, unknown> & { path?: string };
      let text: string;
      let fixes: DocLinkFixes[] = [];
      let wiki: WikiBreak[] = [];
      // What a creation wrote, for its undo only: never said or returned.
      let hash: string | undefined;
      // A bundle's names before and after, by its title, for the undo's label.
      let names: { from?: string; to?: string } | undefined;
      // A folder creation made a set (a folder with its own entry), for its words.
      let madeSet = false;
      // An act whose way back the session holds (`set.make`), and its links fact.
      let own: { inverse: AppInverse; fact?: Record<string, unknown> } | undefined;
      switch (op.op) {
        case "doc.create":
          r = session.createDoc(op.dir, op.name, {
            ...(typeof op.text === "string" ? { text: op.text } : {}),
            ...(op.free === true ? { free: true } : {}),
          });
          text = `${who} created ${shown(r.path as string)}.`;
          break;
        case "folder.create":
          r = session.createFolder(op.dir, op.name);
          // One made in the workspace has an entry of its own: a set, and said so.
          madeSet = session.context.some((e) => e.root === r.path);
          text = `${who} created the ${madeSet ? "set" : "folder"} ${shown(r.path as string)}.`;
          break;
        case "folder.add":
          r = session.addFolder(op.path);
          madeSet = r.set === true;
          text = `${who} created the ${madeSet ? "set" : "folder"} ${shown(r.path as string)}.`;
          break;
        case "set.make": {
          const { links, wiki: w, ...m } = session.makeSet(op.path, { links: true });
          r = m;
          text = `${who} turned ${basename(m.from)} into a set: ${shown(m.folder)}.`;
          own = { inverse: setMakeInverse(m.from, m.path) };
          // The links the move into the folder broke: said, never rewritten.
          // There is no `relink` offer for this act; the link check lists them.
          if ((links?.length ?? 0) > 0 || (w?.length ?? 0) > 0) {
            text += ` ${brokenText(links ?? [], w ?? [], basename(m.from))}`;
            own.fact = {
              broken: {
                ...brokenFact(links ?? [], w ?? []),
                hint: SET_MAKE_LINKS_HINT,
              },
            };
          }
          break;
        }
        case "bundle.create": {
          const { hash: h, ...made } = session.createBundle(op.dir, op.extension, op.name);
          hash = h;
          r = made;
          names = { to: nameOf(made.path) };
          text = `${who} created ${named(made.path)} ${placeOf(made.path)}.`;
          break;
        }
        case "duplicate": {
          const { hash: h, dir, ...made } = session.duplicate(op.path);
          hash = h;
          r = made;
          if (dir) {
            names = { from: nameOf(made.from), to: nameOf(made.path) };
            text = `${who} duplicated ${named(made.from)} as ${names.to}.`;
            r = { ...made, dir };
          } else text = `${who} duplicated ${shown(made.from)} as ${shown(made.path)}.`;
          break;
        }
        case "move": {
          // Every move by either party lands here: the human's "Move to…"
          // dialog and drags in the sidebar, and the agent's `move`. What moved
          // and where is known in full only here: `m.from` to `m.path`, and an
          // image's description to `m.sidecar`. (An undo or redo of a move goes
          // through `applyInverse` instead, as its own act.)
          const { links, wiki: w, ...m } = session.move(op.path, op.into, { links: true });
          fixes = links ?? [];
          wiki = w ?? [];
          r = m;
          if (isBundleRoot(m.path)) {
            names = { from: nameOf(m.path), to: nameOf(m.path) };
            text = `${who} moved ${named(m.path)} ${placeOf(m.path, "to")}.`;
          } else {
            const where = session.isWorkspace(dirname(m.path)) ? "the workspace" : shown(m.path);
            text = `${who} moved ${shown(m.from)} to ${where}${m.sidecar ? ", with its description" : ""}.`;
          }
          break;
        }
        case "rename": {
          const {
            seeded,
            links,
            wiki: w,
            ...m
          } = session.rename(op.path, op.name, {
            links: true,
          });
          fixes = links ?? [];
          wiki = w ?? [];
          r = m;
          // An empty document renamed to JSON was given `{}`: an open editor shows it.
          if (seeded) send({ op: "version.text", ...seeded, origin: "remote" });
          if (isBundleRoot(m.path)) {
            names = renamedNames(m);
            text = `${who} renamed ${named(m.from, names.from)} to ${names.to}.`;
          } else
            text = `${who} renamed ${shown(m.from)} to ${shown(m.path)}${m.sidecar ? ", with its description" : ""}.`;
          break;
        }
        case "import":
          r = session.importText(op.name, op.text, op.dir);
          text = `${who} copied ${op.name} in as ${shown(r.path as string)}.`;
          break;
        case "workspace.set":
          r = session.setWorkspace(op.path);
          text = `${who} set the workspace to ${shown(r.path as string)}.`;
          break;
      }
      syncWatchers();
      // Any change to the context's shape ends the last offer to update links.
      relinkOffer = null;
      // The app follows what moved (a stage's entry and audio), on the same act.
      let follow: Follow | undefined;
      let followNote = "";
      if ((op.op === "move" || op.op === "rename") && r.from !== r.path && opts.hooks?.followMove)
        try {
          follow = opts.hooks.followMove(
            { op: op.op, from: r.from as string, to: r.path as string, by },
            ctx,
          );
        } catch (e) {
          // Done in part: what it did do is still undone with the act.
          if (e instanceof FollowError) follow = e.follow;
          followNote = ` ${app.title ?? app.name} could not follow it: ${messageOf(e)}.`;
        }
      // The way back, planned now and from what was true now.
      const act = planInverse(op, {
        ...(r as After),
        ...(hash !== undefined ? { hash } : {}),
        ...(names ? { names } : {}),
        ...(madeSet ? { set: true } : {}),
        ...(own ? { inverse: own.inverse } : {}),
      });
      if (follow && (act?.inverse.kind === "move" || act?.inverse.kind === "rename"))
        act.inverse.follow = follow;
      let linkFact: Record<string, unknown> = own?.fact ?? {};
      if (
        (fixes.length > 0 || wiki.length > 0) &&
        act &&
        (act.inverse.kind === "move" || act.inverse.kind === "rename")
      ) {
        const what = names?.from ?? basename(r.from as string);
        if (fixes.length > 0 && "updateLinks" in op && op.updateLinks) {
          // Asked for in the same act: rewritten now, and the undo takes both back.
          const edits = linkEditsOf(fixes);
          const done = applyLinkEdits(edits, what);
          act.inverse.links = reverseLinkEdits(edits);
          act.label += `, updating ${plural(done.count, "link")}`;
          text = `${text.slice(0, -1)}, updating ${linksDone(done)}.${wikiNote(wiki, what)}`;
          linkFact = {
            links: linksFactOf(done, fixes),
            ...(wiki.length > 0 ? { broken: brokenFact([], wiki) } : {}),
          };
        } else {
          if (fixes.length > 0) relinkOffer = { act, fixes, wiki, what, by };
          text += ` ${brokenText(fixes, wiki, what)}`;
          linkFact = { broken: brokenFact(fixes, wiki) };
        }
      }
      history.did(act);
      announce(text + followNote, { fact: op.op, by, ...r, ...linkFact });
      broadcastState();
      return { ...r, ...linkFact };
    };

    // --- links that follow a rename or move -----------------------------------
    //
    // A rename or move that breaks links offers to update them (`relinkOffer`),
    // until the next change to the context's shape. Accepting rewrites them as
    // part of that act: its undo entry grows to cover them, so one undo puts the
    // file and its links back. `move --update-links` does both at once.
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    const points = (n: number) => (n === 1 ? "points" : "point");
    const linkCount = (fixes: readonly DocLinkFixes[]) =>
      fixes.reduce((n, d) => n + d.fixes.length, 0);
    /** What the chat says of the links an act broke, the wiki links it cannot update among them. */
    const brokenText = (
      fixes: readonly DocLinkFixes[],
      wiki: readonly WikiBreak[],
      what: string,
    ) =>
      fixes.length === 0
        ? `${plural(wiki.length, "wiki link")} still ${points(wiki.length)} at where ${what} was, and cannot be updated: ${wiki.length === 1 ? "it names" : "they name"} a page, not a path.`
        : `${plural(linkCount(fixes), "link")} in ${linkPlacesText(fixes)} still ${points(linkCount(fixes))} at where ${what} was${
            wiki.length > 0 ? `, and ${plural(wiki.length, "wiki link")} it can't update` : ""
          }.`;
    const wikiNote = (wiki: readonly WikiBreak[], what: string) =>
      wiki.length > 0
        ? ` ${plural(wiki.length, "wiki link")} still ${points(wiki.length)} at where ${what} was, and cannot be updated.`
        : "";
    const brokenFact = (fixes: readonly DocLinkFixes[], wiki: readonly WikiBreak[]) => ({
      count: linkCount(fixes),
      docs: fixes.map((d) => ({
        path: d.path,
        ...(d.noun ? { noun: d.noun } : {}),
        links: d.fixes.map(fixFact),
      })),
      ...(wiki.length > 0 ? { wiki } : {}),
      hint:
        fixes.length > 0
          ? "`relink` updates them all in one act (one undo); the human may update or leave them from the context sidebar. Left, the link check lists them. Wiki links are never rewritten."
          : "Wiki links name a page, not a path, and are never rewritten; the link check lists them.",
    });
    const fixFact = (f: DocLinkFixes["fixes"][number]) => ({
      line: f.line,
      ...(f.id !== undefined ? { id: f.id } : {}),
      from: f.from,
      to: f.to,
    });

    /** One edit per document, each target as written swapped once. */
    const linkEditsOf = (fixes: readonly DocLinkFixes[]): LinkEdit[] =>
      fixes.map((d) => ({
        at: d.path,
        was: d.was,
        swaps: [...new Map(d.fixes.map((f) => [f.from, f.to])).entries()],
      }));

    /** Rewrite links, and let an open editor follow an active version that changed. */
    /** `what`: what moved, as the chat names it ("glade.md"). */
    const applyLinkEdits = (edits: readonly LinkEdit[], what: string) => {
      const held = opts.hooks?.rewriteHeld;
      const done = session.rewriteLinks(
        edits.map((e) => ({ path: e.at, swaps: e.swaps })),
        held ? { held: (doc, swaps) => held(doc, swaps, ctx) } : {},
      );
      for (const ev of done.events) handleFileEvent(ev);
      for (const t of done.texts) {
        const original = session.doc(t.doc).original;
        const rev = followRewrite(t, edits.find((e) => e.at === original)?.swaps ?? [], what);
        send({
          op: "version.text",
          doc: t.doc,
          version: t.version,
          text: t.text,
          origin: "remote",
          rev,
        });
      }
      return done;
    };

    /**
     * Link rewrites an open editor may not have taken yet, by document.
     *
     * ⚠ THE DEBOUNCE RACE. A surface with a write waiting for a document drops a
     * `version.text` for it (its pending write is newer), and that write then
     * sends the buffer typed before the rewrite: the old link, back in the
     * active version, and Save puts it in the file.
     *
     * Staleness is decided by what the surface had seen: each rewritten text is
     * sent with a `rev`, the surface's edits carry the newest `rev` it took
     * (`base`), and only an edit based on an older one is stale. A stale edit
     * is rebased, never searched for old targets: its lines unchanged from the
     * text it was typed over (`pre`) take the rewritten text's lines (`post`),
     * and every line the human added or changed stays exactly as typed, so a
     * link written on purpose is never touched. The rebased text is sent back
     * with a new `rev`. An entry goes when an up-to-date edit arrives, when
     * the document is closed or another version made active, and after
     * `RELINK_FOLLOW_MS` in any case.
     */
    const linkFollow = new Map<
      string,
      {
        version: number;
        rev: number;
        pre: string;
        post: string;
        swaps: Map<string, string>;
        what: string;
        at: number;
      }
    >();
    let textRev = 0;
    const followRewrite = (
      t: { doc: string; version: number; text: string; was: string },
      swaps: readonly (readonly [string, string])[],
      what: string,
    ) => {
      const rev = ++textRev;
      const prev = linkFollow.get(t.doc);
      // A second rewrite before the surface caught up, over the first's text:
      // the surface's edits are still typed over the first `pre`, which lines
      // up with this rewrite line for line, and the two rewrites compose.
      const stacked =
        prev &&
        prev.version === t.version &&
        prev.post === t.was &&
        performance.now() - prev.at < RELINK_FOLLOW_MS;
      const next = new Map(swaps);
      if (stacked)
        for (const [a, b] of prev.swaps) {
          const c = next.get(b) ?? b;
          if (a !== c) next.set(a, c);
          else next.delete(a);
        }
      linkFollow.set(t.doc, {
        version: t.version,
        rev,
        pre: stacked ? prev.pre : t.was,
        post: t.text,
        swaps: next,
        what,
        at: performance.now(),
      });
      return rev;
    };
    const forgetRewrite = (slug: string) => linkFollow.delete(slug);
    /** An edit's text, rebased onto a rewrite its surface had not seen, and the `rev` to send back. */
    const followedEdit = (
      slug: string,
      version: number,
      text: string,
      base: number | undefined,
    ) => {
      const f = linkFollow.get(slug);
      if (!f) return { text, rev: null };
      if (f.version !== version || performance.now() - f.at >= RELINK_FOLLOW_MS) {
        linkFollow.delete(slug);
        return { text, rev: null };
      }
      if ((base ?? 0) >= f.rev) {
        linkFollow.delete(slug);
        return { text, rev: null };
      }
      const rebased = rebaseLines(f.pre, f.post, text, f.swaps);
      const rev = ++textRev;
      linkFollow.set(slug, { ...f, rev, pre: text, post: rebased.text });
      // Old targets the rebase kept are said, not saved silently: the agent
      // must not believe the update reached them.
      if (rebased.kept.length > 0) {
        const d = session.doc(slug);
        const lines = [...new Set(rebased.kept.map((k) => k.line))].join(", ");
        announce(
          `An edit to ${session.display(d.original)} typed over its old text kept ${plural(
            rebased.kept.length,
            "link",
          )} to where ${f.what} was (line ${lines}); the link check lists ${
            rebased.kept.length === 1 ? "it" : "them"
          }.`,
          { fact: "relink.kept", doc: slug, path: d.original, links: rebased.kept },
        );
      }
      return { text: rebased.text, rev };
    };

    /** "3 links in 2 documents", and any document left alone with why. */
    const linksDone = (done: ReturnType<typeof applyLinkEdits>) =>
      `${plural(done.count, "link")} in ${linkPlacesText(done.docs)}${
        done.skipped.length > 0
          ? ` (left ${done.skipped.map((x) => `${session.display(x.path)}: ${x.reason}`).join("; ")})`
          : ""
      }`;

    const linksFactOf = (
      done: ReturnType<typeof applyLinkEdits>,
      fixes: readonly DocLinkFixes[],
    ) => ({
      count: done.count,
      docs: done.docs.map((d) => ({
        path: d.path,
        ...(d.noun ? { noun: d.noun } : {}),
        links: (fixes.find((f) => f.path === d.path)?.fixes ?? []).map(fixFact),
      })),
      ...(done.skipped.length > 0 ? { skipped: done.skipped } : {}),
    });

    /** Accept the offer: the links the last rename or move broke, rewritten as part of that act. */
    const relink = (by: "human" | "agent"): Record<string, unknown> => {
      const offer = relinkOffer;
      relinkOffer = null;
      if (!offer || history.peekUndo() !== offer.act)
        throw new SessionError(
          "no links to update: the offer lasts until the next change to the context's shape (a move, a rename, an undo). Run `link-check` for what is broken now",
          409,
        );
      const inverse = offer.act.inverse;
      if (inverse.kind !== "move" && inverse.kind !== "rename")
        throw new SessionError("no links to update", 409);
      const edits = linkEditsOf(offer.fixes);
      const done = applyLinkEdits(edits, offer.what);
      inverse.links = reverseLinkEdits(edits);
      offer.act.label += `, updating ${plural(done.count, "link")}`;
      const who = by === "agent" ? "Agent" : "You";
      const fact = linksFactOf(done, offer.fixes);
      announce(`${who} updated ${linksDone(done)} to follow ${offer.what}.`, {
        fact: "relink",
        by,
        ...fact,
      });
      broadcastState();
      return fact;
    };

    /**
     * Apply one recorded inverse, and return the act that would reverse that,
     * which is what goes onto the other stack.
     *
     * A delete has no way back, and says so by returning null. Once a created
     * file is gone its contents are gone with it, so a redo that "re-creates" it
     * would hand back an empty file wearing the same name, which is the kind of
     * lie an undo stack must not tell. Confirmed deletions are therefore one-way,
     * which is also why they are confirmed.
     */
    /**
     * What an undo or redo did to links, for its chat line: set by
     * `followLinks`, and by a redo that broke links again (`redoBroke`).
     */
    let linkNote = "";
    /** A redo of an act that carried no link edits found links it broke: offered afresh. */
    // `hint`: an act with no `relink` offer (`set.make`) says its own words instead.
    let redoBroke: {
      fixes: DocLinkFixes[];
      wiki: WikiBreak[];
      what: string;
      hint?: string;
    } | null = null;
    const redoBrokeNow = () => redoBroke;

    /** The links an undone or redone act carried, put as they were with it. */
    const followLinks = (edits: LinkEdit[], what: string): { back: LinkEdit[]; label: string } => {
      const done = applyLinkEdits(edits, what);
      linkNote = ` Links: ${linksDone(done)} followed it.`;
      return { back: reverseLinkEdits(edits), label: `, with ${plural(done.count, "link")}` };
    };

    /** After a redo with no link edits: what it broke, to offer as a fresh act does. */
    const noteRedoBroke = (
      m: { from: string; links?: DocLinkFixes[]; wiki?: WikiBreak[] },
      dir: "undo" | "redo",
      hint?: string,
    ) => {
      if (dir !== "redo") return;
      const fixes = m.links ?? [];
      const wiki = m.wiki ?? [];
      if (fixes.length === 0 && wiki.length === 0) return;
      const what = basename(m.from);
      redoBroke = { fixes, wiki, what, ...(hint ? { hint } : {}) };
      linkNote = ` ${brokenText(fixes, wiki, what)}`;
    };

    /**
     * The app's part of an undone or redone rename or move, put as it was with
     * it (`hooks.followMove`). The kit's part is done by now, so a failure is
     * said with the undo's line, and the step keeps the way back from whatever
     * part the app did do (a `FollowError`'s `follow`), else none.
     */
    const runFollow = (f: Follow): Follow | undefined => {
      try {
        return f();
      } catch (e) {
        linkNote += ` ${app.title ?? app.name} could not follow it: ${messageOf(e)}.`;
        return e instanceof FollowError ? e.follow : undefined;
      }
    };

    /** An act's label without the link count it was given when done: the chat line says what happened now. */
    const withoutLinkCount = (label: string) =>
      label.replace(/, (?:updating|with) \d+ links?$/, "");

    const applyInverse = async (
      inv: Inverse,
      dir: "undo" | "redo" = "undo",
    ): Promise<Act | null> => {
      switch (inv.kind) {
        case "move": {
          // Back to where it was, whether or not that is a set or the workspace now.
          // A redo with no link edits looks for the links it breaks, as the act did.
          const m = session.move(inv.path, inv.into, {
            back: true,
            links: !inv.links && dir === "redo",
          });
          noteRedoBroke(m, dir);
          const what = nameOf(m.path);
          const links = inv.links ? followLinks(inv.links, what) : null;
          const follow = inv.follow ? runFollow(inv.follow) : undefined;
          return {
            label: `moved ${what} back into ${basename(dirname(m.path))}${links?.label ?? ""}`,
            inverse: {
              kind: "move",
              path: m.path,
              into: dirname(m.from),
              ...(links ? { links: links.back } : {}),
              ...(follow ? { follow } : {}),
            },
          };
        }
        case "rename": {
          // A bundle's title goes back with its name: the one it had, or none.
          const m = session.rename(inv.path, inv.name, {
            links: !inv.links && dir === "redo",
            ...(inv.title ? { title: inv.title.to ?? null } : {}),
          });
          noteRedoBroke(m, dir);
          const n = isBundleRoot(m.path)
            ? renamedNames(m)
            : { from: basename(m.from), to: basename(m.path) };
          const links = inv.links ? followLinks(inv.links, n.from) : null;
          const follow = inv.follow ? runFollow(inv.follow) : undefined;
          return {
            label: `renamed ${n.from} back to ${n.to}${links?.label ?? ""}`,
            inverse: {
              kind: "rename",
              path: m.path,
              name: basename(m.from),
              ...(links ? { links: links.back } : {}),
              ...(follow ? { follow } : {}),
              ...(m.title ? { title: m.title.from !== undefined ? { to: m.title.from } : {} } : {}),
            },
          };
        }
        case "delete": {
          if (inv.unchanged === undefined) {
            session.removeCreated(inv.path, inv.dir);
            return null;
          }
          // Written by the act: to the Trash, and only while unchanged.
          session.unchangedOrDie(inv.path, inv.unchanged);
          await trashMade(inv.path);
          return null;
        }
        case "app": {
          // An app's act: what it made is checked first, all of it, so a
          // refusal changes nothing; then the app's own way back, which
          // refuses before it writes; then what it made goes to the Trash,
          // each checked again just before it goes.
          //
          // The app's undo runs before the Trash, not after: once it has run,
          // a copy the Trash then fails to take is left as an ordinary file
          // (a stage shows it as unplaced), where the other order would leave
          // the app's record naming files already gone.
          const made = inv.creates ?? [];
          for (const c of made) session.unchangedOrDie(c.path, c.unchanged);
          if (made.length > 0 && trashing)
            throw new SessionError("a move to the Trash is already running", 409);
          await inv.undo();
          // Past this point the world has changed: a failure is reported with
          // what was done, and the step comes off the list (a GoneError), since
          // it can never be undone as a whole again.
          const gone: string[] = [];
          for (const c of made) {
            try {
              session.unchangedOrDie(c.path, c.unchanged);
              await trashMade(c.path);
              gone.push(c.path);
            } catch (e) {
              const left = made.filter((m) => !gone.includes(m.path));
              throw new PartialUndo(
                `undoing "${inv.label}" was done only in part: ${
                  gone.length > 0
                    ? `${gone.map((p) => session.display(p)).join(", ")} went to the Trash, but `
                    : ""
                }${left.map((m) => session.display(m.path)).join(", ")} did not (${messageOf(e)}), and ${
                  left.length === 1 ? "stays" : "stay"
                } where ${left.length === 1 ? "it is" : "they are"}`,
                409,
              );
            }
          }
          // Put back the other way: the label stays the act's own.
          return inv.redo && made.length === 0
            ? {
                label: inv.label,
                inverse: { kind: "app", label: inv.label, undo: inv.redo, redo: inv.undo },
              }
            : null;
        }
      }
    };

    /** Something an act made, to the Trash for an undo: one move to the Trash at a time. */
    const trashMade = async (path: string): Promise<void> => {
      if (trashing) throw new SessionError("a move to the Trash is already running", 409);
      trashing = true;
      try {
        await trashFn(path);
      } catch (e) {
        throw e instanceof SessionError ? e : new SessionError(messageOf(e), 409);
      } finally {
        trashing = false;
      }
      session.trashed(path);
    };

    // --- the native picker (one dialog at a time) ---------------------------------
    //
    // A modal dialog owns the human's attention, and a second one behind the
    // first cannot be seen or dismissed, so a request while one is open is
    // refused in words rather than queued.
    let pickerOpen = false;
    const zenity = platform === "linux" ? Bun.which("zenity") : null;
    const nativePick = async (
      kind: PickKind,
      prompt: string,
      defaultName?: string,
    ): Promise<{ paths: string[]; cancelled: boolean }> => {
      const cmd = pickerCommand(platform, kind, prompt, zenity, defaultName);
      if (!cmd)
        throw new SessionError(
          `no file picker on this system (${platform}): type the path instead`,
          409,
        );
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const paths = parsePickerOutput(out);
      if (paths.length === 0 && !wasCancelled(code, out))
        throw new SessionError(`the file picker failed (exit ${code})`, 409);
      return { paths, cancelled: paths.length === 0 };
    };
    /** The app's request for a dialog: the same one-at-a-time rule, refused as a conflict. */
    const pickGuarded = async (
      kind: PickKind,
      prompt: string,
      defaultName?: string,
    ): Promise<{ paths: string[]; cancelled: boolean }> => {
      if (pickerOpen) throw new SessionError("a file picker is already open", 409);
      pickerOpen = true;
      try {
        const r = await (opts.pick ?? nativePick)(kind, prompt, defaultName);
        touch();
        return r;
      } finally {
        pickerOpen = false;
      }
    };
    const openPicker = async (
      ws: import("bun").ServerWebSocket<unknown>,
      want: "context-file" | "context-folder",
      rid: string | number | undefined,
    ) => {
      const reply = (w: import("bun").ServerWebSocket<unknown>, f: ServerOp | { op: string }) =>
        replyRaw(w, f, rid);
      if (pickerOpen) {
        reply(ws, { op: "error", message: "a file picker is already open" });
        return;
      }
      const kind: PickKind = want === "context-file" ? "file" : "folder";
      const prompt =
        want === "context-folder"
          ? `Choose a folder to add to ${app.name}`
          : `Choose documents to add to ${app.name}`;
      pickerOpen = true;
      try {
        const { paths } = await (opts.pick ?? nativePick)(kind, prompt);
        touch(); // a human stood at a dialog; the session is not idle
        // Nothing chosen is a cancelled dialog: nothing said.
        if (paths.length > 0) addPaths(paths);
      } catch (e) {
        reply(ws, { op: "error", message: messageOf(e) });
      } finally {
        pickerOpen = false;
      }
    };

    // --- surface messages (WebSocket) ------------------------------------------
    /**
     * Answer one socket. `requestId` is the `rid` of the client frame being
     * answered, bound by whoever dispatched it (never read from shared state),
     * and is echoed on every reply to that request, success frames included.
     */
    const replyRaw = (
      ws: import("bun").ServerWebSocket<unknown>,
      frame: ServerOp | { op: string },
      requestId: string | number | undefined,
    ) => {
      try {
        const out = requestId !== undefined ? { ...frame, requestId } : frame;
        ws.send(JSON.stringify(out));
      } catch {
        /* gone */
      }
    };

    const viaKnown: readonly string[] = [...KIT_VIA, ...(opts.via ?? [])];
    const rolesKnown: readonly string[] = [...KIT_REF_ROLES, ...(opts.refRoles ?? [])];

    /**
     * The refs a message draws on, from what the page sent: each kept only when
     * its path is a document or image in the session's context (the agent
     * reads it), canonical; one naming the subject is dropped, and so is a
     * second with the same path. At most `MAX_REFS`. Dedup is against the
     * kit's subject only, never an app's `about` part. What was dropped as
     * outside the context or past the cap is counted, for the advisory; one
     * naming the subject, or a repeat, is no loss and is not.
     */
    const refsFor = (
      raw: unknown,
      subject: ReadonlySet<string>,
    ): { refs: MessageRef[]; outside: number; over: number } => {
      if (!Array.isArray(raw)) return { refs: [], outside: 0, over: 0 };
      const given = raw.filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
      // One read of the context for the whole list, however many refs it holds.
      const kept = session.contextDocEach(given.map((r) => r.path));
      const refs: MessageRef[] = [];
      const seen = new Set<string>();
      let outside = 0;
      let over = 0;
      given.forEach((ref, i) => {
        const path = kept[i];
        if (!path) {
          outside++;
          return;
        }
        if (subject.has(path) || seen.has(path)) return;
        seen.add(path);
        if (refs.length === MAX_REFS) {
          over++;
          return;
        }
        refs.push({
          path,
          ...(typeof ref.doc === "string" ? { doc: ref.doc } : {}),
          ...(typeof ref.version === "number" ? { version: ref.version } : {}),
          ...(typeof ref.role === "string" ? { role: ref.role } : {}),
          ...(typeof ref.label === "string" ? { label: ref.label } : {}),
          ...(typeof ref.text === "string" ? { text: ref.text } : {}),
        });
      });
      return { refs, outside, over };
    };

    /** The subject's own paths: its file, and a document's original beside its version's. */
    const subjectPaths = (about: MessageAbout): Set<string> => {
      const paths = new Set<string>();
      if (about.path) paths.add(about.path);
      if (about.doc) {
        const d = session.findDoc(about.doc);
        if (d) paths.add(d.original);
      }
      return paths;
    };

    /**
     * What a human message is about, and what it is answered with: the
     * advisories for a subject named outside the context, refs dropped, and a
     * role outside the app's list. They ride the tail's message as `warning`.
     */
    const aboutFor = (
      withSelection: boolean,
      extra?: Pick<MessageAbout, "entryIds" | "noteId" | "path" | "refs">,
    ): { about: MessageAbout | undefined; advice: string[] } => {
      const advice: string[] = [];
      // A backstop: every path that moves the open document or its version
      // broadcasts first, and the broadcast's read has already dropped a stale
      // selection. It reads through the rule anyway, for the path somebody adds
      // without a broadcast.
      const sel = withSelection ? heldSelection() : null;
      // With no selection the page may name the subject itself, a whole
      // document or image (an open image, a document a view points at): kept
      // only when it is in the session's context. A document the session holds
      // is said as its active version, as the open document is. One named
      // outside the context is no subject at all: the human pointed at it, so
      // the open document would be the wrong answer.
      const asked = !sel && typeof extra?.path === "string" ? extra.path : undefined;
      const named = asked !== undefined ? session.contextDocEach([asked])[0] : undefined;
      if (asked !== undefined && !named)
        advice.push(
          `the subject ${JSON.stringify(asked)} is not a document or image in the session's context: the message names no subject.`,
        );
      const namedDoc = named ? session.findDoc(named) : undefined;
      // With nothing named and no selection, an open image is the subject before
      // the document behind it.
      const image = !sel && asked === undefined ? session.openImagePath : null;
      const active = sel
        ? activeOf(sel.doc)
        : asked !== undefined
          ? namedDoc
            ? activeOf(namedDoc.slug)
            : null
          : image
            ? null
            : activeOf();
      const wholePath = named && !namedDoc ? named : image;
      const about: MessageAbout = {
        ...(active
          ? {
              doc: active.doc,
              version: active.version,
              ...(active.path ? { path: active.path } : {}),
            }
          : wholePath
            ? { path: wholePath }
            : {}),
        ...(sel
          ? {
              doc: sel.doc,
              version: sel.version,
              path: sel.path,
              fromLine: sel.fromLine,
              toLine: sel.toLine,
              text: sel.text,
            }
          : {}),
        ...(extra?.entryIds?.length ? { entryIds: extra.entryIds } : {}),
        ...(extra?.noteId ? { noteId: extra.noteId } : {}),
      };
      const { refs, outside, over } = refsFor(extra?.refs, subjectPaths(about));
      if (refs.length > 0) about.refs = refs;
      if (outside > 0)
        advice.push(
          `${outside} ${outside === 1 ? "ref was" : "refs were"} dropped: not a document or image in the session's context.`,
        );
      if (over > 0)
        advice.push(
          `${over} ${over === 1 ? "ref was" : "refs were"} dropped past the first ${MAX_REFS}.`,
        );
      const role = roleAdvisory(refs.map(refRole), rolesKnown);
      if (role) advice.push(role);
      return { about: Object.keys(about).length > 0 ? about : undefined, advice };
    };

    /** A `say`'s `via`, as stored: cut to its length, with the advisories it earns. */
    const viaOf = (
      raw: unknown,
      by: "human" | "agent" = "human",
    ): { via: string | undefined; advice: string[] } => {
      const { via, cut } = cleanVia(raw);
      const advice: string[] = [];
      if (cut)
        advice.push(
          `via was longer than ${VIA_MAX} characters: it was cut to ${JSON.stringify(via)}.`,
        );
      const unknown = viaAdvisory(via, viaKnown, cut ? "cut" : "as sent");
      if (unknown) advice.push(unknown);
      // Every value past `chat` names a button the human presses: from the
      // agent it says something that did not happen. Stored, never refused.
      if (by === "agent" && via !== undefined && via !== "chat" && viaKnown.includes(via))
        advice.push(
          `via ${JSON.stringify(via)} is a button the human presses: the message was stored with it, and shows as if pressed. Leave via out (or "chat") for your own messages.`,
        );
      return { via, advice };
    };

    /**
     * Whether the human's save asks anything of the agent (`saved` in
     * `events.ts`), and why. Never when it changed nothing on disk. Otherwise,
     * when it may overtake the agent's work in flight: a version of this
     * document the agent made after the one saved (a proposal not taken yet;
     * once per proposal), a running task the agent is working, its own or a
     * human's it picked up (tasks name no document, so any counts; a daemon's
     * render does not), or a note of the
     * human's on this document still open (the agent is answering it). Or when
     * the saved file is a profile or relations file and the save changed the
     * profile or relation findings the agent reports.
     */
    /** The agent proposals a save has already woken the agent for, `<slug>:<n>`. */
    const toldOfProposal = new Set<string>();
    const saveWakes = (
      slug: string,
      r: { unchanged?: true },
      findingsBefore: string,
    ): { because: SaveWake[]; findings?: Finding[] } => {
      if (r.unchanged) return { because: [] };
      const because: SaveWake[] = [];
      const d = session.doc(slug);
      // Once per proposal: the first save that may overtake it says so, and the
      // saves after it, while it still sits there untaken, do not.
      const fresh = d.versions.filter(
        (v) => v.by === "agent" && v.n > d.active && !toldOfProposal.has(`${d.slug}:${v.n}`),
      );
      if (fresh.length > 0) {
        for (const v of fresh) toldOfProposal.add(`${d.slug}:${v.n}`);
        because.push("version");
      }
      // The agent's work: a task running that is not the daemon's. Only a
      // runner's task is `by: "daemon"`, and only the agent moves anyone else's
      // task to running (its own, or a human's it picked up with task-status).
      if (session.tasks().some((t) => t.status === "running" && t.by !== "daemon"))
        because.push("task");
      if (d.notes.some((n) => n.by === "human" && !n.resolved)) because.push("note");
      const after = session.reportedFindings();
      if (findingsKey(after) !== findingsBefore) {
        because.push("findings");
        return { because, findings: after };
      }
      return { because };
    };

    /**
     * The `about` the agent's tail gets: the kit's, plus what the app adds from
     * what the sending page shows (`hooks.messageAbout`). A part may not take a
     * kit key, and an app hook that throws costs its part, never the message.
     */
    const withAppAbout = (
      about: MessageAbout | undefined,
      surface: string,
    ): MessageAboutOnTail | undefined => {
      const hook = opts.hooks?.messageAbout;
      if (!hook) return about;
      let parts: Record<string, unknown> | undefined;
      try {
        parts = hook(surface, ctx);
      } catch (e) {
        process.stderr.write(`${app.name}: messageAbout failed: ${messageOf(e)}\n`);
      }
      const extra = Object.entries(parts ?? {}).filter(
        ([k, v]) => v !== undefined && !KIT_ABOUT_KEYS.has(k),
      );
      if (extra.length === 0) return about;
      return { ...(about ?? {}), ...Object.fromEntries(extra) };
    };

    /** The slot's hint, or the fixed one when it has none or fails: the message goes out regardless. */
    const pickReplyHint = (input: MessageHintInput): string => {
      try {
        const picked = opts.messageHint?.(input);
        if (typeof picked === "string" && picked.trim() !== "") return picked;
      } catch (e) {
        process.stderr.write(`${app.name}: messageHint failed: ${messageOf(e)}\n`);
      }
      return replyHint(sessionId);
    };

    const noteFacts = (slug: string, note: Note) =>
      noteEventFacts(slug, note, session.noteLines(slug, note), sessionId);

    /** The slug a version delete is about, resolved the way the session resolves it. */
    const slugOf = (doc: string | undefined): string => {
      const want = doc ?? session.openDocSlug ?? "";
      return session.findDoc(want)?.slug ?? want;
    };
    const mayDeleteVersion = async (
      doc: string | undefined,
      version: number,
      by: Actor,
    ): Promise<void> => {
      // The kit's own checks first (the document and version exist, and the
      // version is not active): its message wins, and the app's hook is never
      // asked about a delete that could not happen anyway.
      const slug = session.checkDeletable({ doc, version });
      const check = opts.hooks?.beforeVersionDelete;
      if (!check) return;
      const r = await check(slug, version, ctx, { by });
      if (!r.allow)
        throw new SessionError(r.reason ?? `v${version} of ${slugOf(doc)} may not be deleted`, 409);
    };

    /**
     * The app's tidy-up after a delete. The version is already gone, so a hook that
     * throws must not skip the chat line and the event that follow: it is reported
     * as a system line instead.
     */
    const afterDelete = async (slug: string, version: number, by: Actor): Promise<void> => {
      try {
        await opts.hooks?.afterVersionDelete?.(slug, version, ctx, { by });
      } catch (e) {
        announce(`Deleted v${version} of ${slug}, but tidying up after it failed: ${messageOf(e)}`);
      }
    };

    const SURFACE_OPS = [
      "open",
      "open.doc",
      "image.close",
      "edit",
      "select",
      "history.undo",
      "history.redo",
      "say",
      "activate",
      "version.new",
      "version.delete",
      "note.add",
      "note.edit",
      "note.resolve",
      "note.remove",
      "task.create",
      "task.cancel",
      "task.remove",
      "tasks.clear",
      "save",
      "revert",
      "context.add",
      "context.remove",
      "fs.list",
      "read",
      "diff",
      "merge",
      "prefs.set",
      "reveal",
      "reveal.version",
      "pick",
      "search",
      "link.open",
      "link.targets",
      "link.headings",
      "link.embeds",
      "link.drop",
      "link.backlinks",
      "profile",
      "link.check",
      "link.graph",
      "close",
      "doc.close",
      "trash.preview",
      "trash",
      "relink",
      "relink.leave",
    ] as const satisfies readonly ClientOp["op"][];
    // ⛔ Every op the surface sends is named here, the structure ops beside it:
    // the refusal's `choices` is the list, and a new op left out of it fails
    // the typecheck rather than going unoffered.
    const everyClientOpListed: [
      Exclude<ClientOp["op"], (typeof SURFACE_OPS)[number] | StructureOp["op"]>,
    ] extends [never]
      ? true
      : never = true;
    void everyClientOpListed;
    const CLIENT_OPS: readonly string[] = [...SURFACE_OPS, ...STRUCTURE_OPS];

    /**
     * The human's text reaches the active version: the editor's `edit`, and an
     * app writing what it holds (`ctx.edit`). `rev`: the edit was rebased onto a
     * link rewrite, and every editor is told the text kept.
     */
    const editActive = (doc: string, version: number, text: string, rev?: number) => {
      const r = session.edit(doc, version, text);
      if (rev !== undefined)
        send({ op: "version.text", doc, version, text, origin: "remote", rev });
      if (r.preserved) {
        const d = session.doc(doc);
        announceOutside(
          d.slug,
          version,
          session.activePath(d.slug) ?? "",
          r.preserved.n,
          r.preserved.path,
        );
      } else if (r.dirtyChanged) broadcastState();
      else if (opts.appState) scheduleEditBroadcast();
    };

    /**
     * The human's edit to a version that is no longer active: the switch
     * overtook it in the client's pause, which only the human's own switch can
     * prevent (its client sends the edit first). The edit is saved where it was
     * typed, or kept as a version of its own (`session.editLeft`), and the
     * human is told in the chat. The agent is not: nothing on its tail asks it
     * to act, and the version it moved to is untouched.
     */
    const editLeft = (doc: string, version: number, text: string, by: "human" | "agent") => {
      const r = session.editLeft(doc, version, text);
      const d = session.findDoc(doc);
      if (!d) return;
      const name = `v${version} of ${d.slug}`;
      const why = r.kept === "changed" ? "changed" : "was deleted";
      // The human's own switch (a key typed after the click, before the switch
      // was seen) is said as theirs; the agent's names the agent.
      const said =
        by === "agent"
          ? r.kept === null
            ? `Your last edit was saved to ${name}; the agent made v${d.active} active.`
            : `Your last edit to ${name} was kept as v${r.saved}, because v${version} ${why} after the switch; the agent made v${d.active} active.`
          : r.kept === null
            ? `Your last edit was saved to ${name} before you switched to v${d.active}.`
            : `Your last edit to ${name} was kept as v${r.saved}, because v${version} ${why} after you switched to v${d.active}.`;
      session.addMessage({ from: "system", type: "info", text: said });
      broadcastState();
    };

    /** An app's own pending writes, made before a kit act reads or replaces a document. */
    const beforeKitAct = (op: unknown) => {
      if (typeof op !== "string" || !opts.hooks?.beforeKitAct) return;
      opts.hooks.beforeKitAct(op, ctx);
    };

    /** Open a document for the human, and send the opener its text straight away. */
    const openForHuman = (
      ws: import("bun").ServerWebSocket<unknown>,
      path: string,
      reply: (w: import("bun").ServerWebSocket<unknown>, f: ServerOp | { op: string }) => void,
    ): { slug: string; version: number; text: string } => {
      const r = session.openPath(path);
      syncWatchers();
      broadcastState();
      // The opener gets the active version's text straight away: the
      // snapshot carries no texts, and a viewer must not wait on a second ask.
      const d = session.doc(r.slug);
      const text = session.readVersion(r.slug, d.active).text;
      reply(ws, {
        op: "version.text",
        doc: r.slug,
        version: d.active,
        text,
        origin: "load",
      });
      if (r.created)
        emit("doc.opened", { doc: r.slug, path: session.activePath(r.slug), by: "human" });
      return { slug: r.slug, version: d.active, text };
    };

    const handleClientOp = async (
      ws: import("bun").ServerWebSocket<unknown>,
      msg: ClientOp,
      rid: string | number | undefined,
    ): Promise<void> => {
      const reply = (w: import("bun").ServerWebSocket<unknown>, f: ServerOp | { op: string }) =>
        replyRaw(w, f, rid);
      if (isStructureOp(msg)) {
        refuseMissingDir(msg);
        const r = structure(anchorSurfacePaths(msg), "human");
        if (typeof r.path === "string")
          reply(ws, {
            op: "structure.done",
            of: msg.op,
            path: r.path,
            ...(msg.op === "doc.create" && msg.stay === true ? { stay: true as const } : {}),
            ...(msg.op === "bundle.create" && msg.stay === "rename"
              ? { stay: "rename" as const }
              : {}),
            ...((msg.op === "rename" || msg.op === "move") && typeof r.from === "string"
              ? { from: r.from }
              : {}),
          });
        return;
      }
      switch (msg.op) {
        case "open": {
          const path = surfacePath(msg.path);
          // An image opens in the viewer, never as a document: no text is read.
          if (isImageName(path)) {
            session.openImage(path);
            broadcastState();
            return;
          }
          openForHuman(ws, path, reply);
          return;
        }
        case "image.close":
          session.closeImage();
          broadcastState();
          return;
        case "link.open": {
          // Followed only when the target is in the session; one outside it is
          // reported so the surface can say which folder to add, never added.
          const r = session.resolveLink(msg.target, msg.doc ?? null, msg.from ?? "document");
          // A link to an image the tree shows lands in the context like a
          // document's, and opens it in the viewer, as a click on its row would
          // (Close brings the document back). One that is not shown answers
          // `not-a-doc`, and the surface says it as an image.
          if (r.state === "in-context" && isImageName(r.path)) {
            try {
              const { path } = session.openImage(r.path);
              broadcastState();
              reply(ws, { op: "link.target", target: msg.target, state: "in-context", path });
            } catch (e) {
              // Shown in the tree, yet refused (a link leading out of its set):
              // the answer to the link names why, rather than a bare error.
              reply(ws, { op: "link.target", target: msg.target, ...r, refused: messageOf(e) });
            }
            return;
          }
          if (r.state !== "in-context") {
            reply(ws, { op: "link.target", target: msg.target, ...r });
            return;
          }
          const opened = openForHuman(ws, r.path, reply);
          // A `#anchor` names a heading (kit-heading-links-build), found in the
          // version just opened, so the surface can show it; one not found
          // still opened the document, and the surface says which heading.
          const anchor = splitTarget(msg.target).anchor;
          const heading = anchor === undefined ? undefined : headingLanding(opened, anchor);
          reply(ws, {
            op: "link.target",
            target: msg.target,
            ...r,
            ...(heading ? { heading } : {}),
          });
          return;
        }
        case "open.doc":
          session.openSlug(msg.doc);
          broadcastState();
          return;
        case "edit": {
          // Typed in a version that a switch just left while the edit waited
          // out its pause (the agent switched): it goes to that version. Any
          // other version that is not active is refused, below, as before.
          const typedIn = session.findDoc(msg.doc);
          const left =
            typedIn && typedIn.active !== msg.version
              ? switchLeaving(typedIn.slug, msg.version)
              : undefined;
          if (left) {
            editLeft(msg.doc, msg.version, msg.text, left.by);
            return;
          }
          const followed = followedEdit(msg.doc, msg.version, msg.text, msg.base);
          // A stale edit was rebased onto a link rewrite: the editor is told the text kept.
          editActive(
            msg.doc,
            msg.version,
            followed.text,
            followed.rev !== null ? followed.rev : undefined,
          );
          return;
        }
        case "history.undo": {
          const act = history.peekUndo();
          if (!act) return;
          // A deleting undo needs the human's word, carried explicitly. A client
          // that simply omits the flag gets a refusal rather than a deletion, so
          // "forgot to confirm" can never become "deleted anyway".
          const deletes = deletesOf(act);
          if (deletes && msg.confirmDelete !== true) {
            const more = deletes.also?.length ?? 0;
            reply(ws, {
              op: "error",
              message: `Undoing "${act.label}" would delete ${session.display(deletes.path)}${more > 0 ? ` and ${more} more` : ""}: confirm it first.`,
            });
            return;
          }
          try {
            linkNote = "";
            history.tookUndo(await applyInverse(act.inverse, "undo"));
            // Only a done undo ends the offer: a refused one changed nothing.
            relinkOffer = null;
            syncWatchers();
            announce(`You undid: ${withoutLinkCount(act.label)}.${linkNote}`, {
              fact: "history.undo",
            });
            broadcastState();
          } catch (e) {
            // The refusal the human needs to read: a folder with things in it, or
            // a world that has moved under a recorded inverse. The act stays on
            // the stack: nothing happened, so nothing should be forgotten. Unless
            // it can never succeed (a place it names is gone): then it comes off,
            // or it would hide every older act.
            if (e instanceof GoneError) {
              history.dropUndo();
              // An undo done only in part changed the context: the watches
              // follow it, and the chat (so the agent too) says what was done.
              if (e instanceof PartialUndo) {
                syncWatchers();
                announce(`You undid in part: ${e.message}.`, { fact: "history.undo" });
              }
              broadcastState();
            }
            reply(ws, { op: "error", message: historyRefusal(e) });
          }
          return;
        }
        case "history.redo": {
          const act = history.peekRedo();
          if (!act) return;
          try {
            linkNote = "";
            redoBroke = null;
            const back = await applyInverse(act.inverse, "redo");
            history.tookRedo(back);
            relinkOffer = null;
            // Read through a call: set inside `applyInverse`, which the compiler cannot see.
            const broke = redoBrokeNow();
            if (broke && back && broke.fixes.length > 0 && !broke.hint)
              relinkOffer = { act: back, ...broke, by: "human" };
            syncWatchers();
            announce(`You redid: ${withoutLinkCount(act.label)}.${linkNote}`, {
              fact: "history.redo",
              ...(broke
                ? {
                    broken: {
                      ...brokenFact(broke.fixes, broke.wiki),
                      ...(broke.hint ? { hint: broke.hint } : {}),
                    },
                  }
                : {}),
            });
            broadcastState();
          } catch (e) {
            if (e instanceof GoneError) {
              history.dropRedo();
              broadcastState();
            }
            reply(ws, { op: "error", message: historyRefusal(e, "redo") });
          }
          return;
        }
        case "select":
          // Ambient state: stored and shown, never pushed onto the agent's tail.
          // One naming a document that is not on screen is a stale echo from
          // before a switch, and is not held.
          selection = selectionOnScreen(msg.selection, screen());
          return;
        case "say": {
          const text = msg.text.trim();
          if (!text) return;
          // The gesture, stored as sent (cut to its length); one outside the
          // app's list is answered on the tail's message, never refused.
          const { via, advice: viaAdvice } = viaOf(msg.via);
          // One ask at a time: `via: "ask"` naming a note whose last ask is
          // still owed an answer is a double-click, so it is not sent, and only
          // the sender is told. Any other `via` naming a note is a typed
          // follow-up, and always goes.
          const asking =
            via === "ask" && typeof msg.about?.noteId === "string" && msg.about.noteId
              ? msg.about.noteId
              : undefined;
          if (asking) {
            const n = session
              .noteFacts()
              .flatMap((d) => d.notes)
              .find((x) => x.id === asking);
            if (n && askOutstanding(n, session.messages())) {
              replyRaw(
                ws,
                {
                  op: "error",
                  message: `note ${asking} is already with the agent, and the agent has not answered yet: the ask was not sent again`,
                },
                rid,
              );
              return;
            }
          }
          const { about, advice: aboutAdvice } = aboutFor(msg.withSelection, msg.about);
          const advice = [...viaAdvice, ...aboutAdvice];
          const m = session.addMessage({
            from: "human",
            type: "message",
            text,
            ...(about ? { about } : {}),
            ...(via ? { via } : {}),
          });
          // What the app adds to `about` from what this page shows (Atlas: its
          // map). On the tail's message only: the chat keeps the kit's parts.
          const told: MessageAboutOnTail | undefined = withAppAbout(about, surfaceId(ws));
          // Every human message names the three honest answers: the one that
          // goes wrong is work done with no task, which the human cannot see.
          const reply = pickReplyHint({
            session: sessionId,
            messageId: m.id,
            text,
            ...(told ? { about: told } : {}),
          });
          // The note's own document, which need not be the one open now.
          const noteSlug = about?.noteId ? session.noteDoc(about.noteId) : undefined;
          const noteDoc = noteSlug ? ` --doc ${noteSlug}` : "";
          emit("message", {
            message_id: m.id,
            text,
            // Always said, so the agent can tell a typed question from a pressed button.
            via: messageVia(m),
            ...(told ? { about: told } : {}),
            // What the page sent that was not taken as sent: said to the agent,
            // who can act on it, rather than to a log nobody reads.
            ...(advice.length > 0 ? { warning: advice.join(" ") } : {}),
            ts: m.ts,
            hint: about?.noteId
              ? `about note ${about.noteId}: \`notes --session ${sessionId}${noteDoc}\` has it whole, and \`note-resolve ${about.noteId} --session ${sessionId}${noteDoc}\` when it is dealt with. ${reply}`
              : reply,
          });
          broadcastState();
          return;
        }
        case "activate":
          activate(msg.doc, msg.version, "human");
          return;
        case "note.add": {
          const r = session.addNote({
            doc: msg.doc,
            body: msg.body,
            by: "human",
            range: { from: msg.from, to: msg.to },
          });
          // The event carries the note itself when it is short, and names the
          // act that closes it: an agent should not have to go and ask what just
          // arrived before it can start.
          emit("note.added", {
            doc: r.slug,
            note: r.note.id,
            by: "human",
            ...noteFacts(r.slug, r.note),
          });
          broadcastState();
          return;
        }
        case "note.edit": {
          const r = session.editNote({ doc: msg.doc, id: msg.id, body: msg.body, by: "human" });
          // A Save with nothing changed is not a rewrite: nothing to tell anyone.
          if (!r.changed) return;
          // A human's rewrite is owed an answer again, so it says what the note
          // now says, as `note.added` does.
          emit("system", {
            fact: "note.edited",
            doc: r.slug,
            note: r.note.id,
            by: "human",
            ...noteFacts(r.slug, r.note),
          });
          broadcastState();
          return;
        }
        case "note.resolve": {
          const r = session.resolveNote({
            doc: msg.doc,
            id: msg.id,
            resolved: msg.resolved,
            by: "human",
          });
          emit("note.resolved", {
            doc: r.slug,
            note: r.note.id,
            by: "human",
            resolved: r.note.resolved,
            // A human reopening a note is asking again, so it carries what
            // `note.added` carries.
            ...(r.note.resolved ? {} : noteFacts(r.slug, r.note)),
          });
          broadcastState();
          return;
        }
        case "note.remove": {
          const r = session.removeNote({ doc: msg.doc, id: msg.id });
          emit("system", { fact: "note.removed", doc: r.slug, note: r.note.id, by: "human" });
          broadcastState();
          return;
        }
        case "task.create": {
          // A human task is a request for the agent, not a chat message: it is
          // how the human hands work over without one. One made from a chat
          // message keeps that message's id.
          if (msg.messageId && !session.messages().some((m) => m.id === msg.messageId))
            throw new SessionError(`no message ${msg.messageId} in this session`, 404);
          engine.create({
            title: msg.title,
            by: "human",
            ...(msg.detail ? { detail: msg.detail } : {}),
            ...(msg.parent ? { parent: msg.parent } : {}),
            ...(msg.messageId ? { messageId: msg.messageId } : {}),
          });
          return;
        }
        case "task.cancel":
          engine.cancel(msg.id, "human");
          return;
        case "task.remove":
          session.removeTask(msg.id);
          broadcastState();
          return;
        case "tasks.clear":
          session.clearFinishedTasks();
          broadcastState();
          return;
        case "version.delete": {
          await mayDeleteVersion(msg.doc, msg.version, "human");
          const r = session.deleteVersion({ doc: msg.doc, version: msg.version });
          await afterDelete(r.slug, r.version, "human");
          const m = session.addMessage({
            from: "system",
            type: "info",
            text: `Deleted v${r.version} of ${r.slug}${r.label ? `: ${r.label}` : ""}.`,
          });
          emit("version.deleted", { doc: r.slug, version: r.version, by: "human", ts: m.ts });
          broadcastState();
          return;
        }
        case "version.new": {
          const r = session.newVersion({
            doc: msg.doc,
            ...(msg.from === undefined ? {} : { from: msg.from }),
            ...(msg.label ? { label: msg.label } : {}),
            by: "human",
          });
          // Say where they are, not just what was made: announcing the new
          // version and going quiet about which one the human is editing is how
          // someone types into v1 believing they are in v2.
          if (msg.activate) {
            const a = session.activate({ doc: r.slug, version: r.version.n });
            recordSwitch(r.slug, a.previous, "human");
          }
          const m = session.addMessage({
            from: "system",
            type: "info",
            text:
              `Made v${r.version.n} of ${r.slug} from v${r.version.fromVersion}${msg.label ? `: ${msg.label}` : ""}. ` +
              (msg.activate
                ? `You are now editing v${r.version.n}.`
                : `You are still editing v${r.version.fromVersion}.`),
          });
          emit("version.created", {
            doc: r.slug,
            version: r.version.n,
            fromVersion: r.version.fromVersion,
            ...(msg.label ? { label: msg.label } : {}),
            activated: msg.activate === true,
            by: "human",
            path: r.version.path,
            ts: m.ts,
          });
          broadcastState();
          return;
        }
        case "save": {
          // Asked before the write, to tell whether the save changed a finding.
          const findingsBefore = findingsKey(session.reportedFindings());
          let r: ReturnType<typeof session.save>;
          try {
            r = session.save(
              msg.doc,
              msg.recreate === "file" || msg.recreate === "folder"
                ? { recreate: msg.recreate }
                : {},
            );
          } catch (e) {
            // A refused Save may have found the file gone and marked it: show that.
            broadcastState();
            throw e;
          }
          const m = session.addMessage({
            from: "system",
            type: "info",
            text:
              r.recreated === "folder"
                ? `Saved v${r.version} to ${r.original}, making its folder again.`
                : r.recreated === "file"
                  ? `Saved v${r.version} to ${r.original}, recreating the file.`
                  : `Saved v${r.version} to ${r.original}.`,
          });
          const wakes = saveWakes(msg.doc, r, findingsBefore);
          emit(
            "saved",
            {
              doc: msg.doc,
              version: r.version,
              original: r.original,
              by: "human",
              ts: m.ts,
              ...(r.recreated ? { recreated: r.recreated } : {}),
              ...(r.unchanged ? { unchanged: true } : {}),
              ...(wakes.because.length > 0 ? { because: wakes.because } : {}),
              ...(wakes.findings ? { findings: wakes.findings } : {}),
            },
            { wake: wakes.because.length > 0 },
          );
          broadcastState();
          return;
        }
        case "doc.close":
          session.closeDoc(msg.doc);
          forgetRewrite(msg.doc);
          broadcastState();
          return;
        case "trash.preview":
          reply(ws, { op: "trash.preview", ...session.trashPreview(surfacePath(msg.path)) });
          return;
        case "trash": {
          const path = await trashForHuman(msg.path);
          reply(ws, { op: "trash.done", path });
          return;
        }
        case "relink":
          relink("human");
          return;
        case "relink.leave": {
          const offer = relinkView();
          relinkOffer = null;
          if (offer)
            announce(
              `You left ${plural(offer.count, "link")} pointing at where ${offer.what} was; the link check lists ${offer.count === 1 ? "it" : "them"}.`,
              { fact: "relink.left", by: "human", count: offer.count },
            );
          return;
        }
        case "revert": {
          const r = session.revert(msg.doc);
          send({
            op: "version.text",
            doc: msg.doc,
            version: r.version,
            text: r.text,
            origin: "remote",
          });
          const m = session.addMessage({
            from: "system",
            type: "info",
            text: `Reverted v${r.version} of ${msg.doc} to the saved file.`,
          });
          emit("reverted", { doc: msg.doc, version: r.version, by: "human", ts: m.ts });
          broadcastState();
          return;
        }
        case "context.add":
          addPaths([surfacePath(msg.path)]);
          return;
        case "reveal": {
          const target = revealPath(surfacePath(msg.path));
          emit("system", { fact: "reveal", by: "human", path: target, text: `Revealed ${target}` });
          return;
        }
        case "reveal.version": {
          // The daemon resolves it, so the surface never names a path outside
          // what the session already owns.
          const target = revealPath(session.readVersion(msg.doc, msg.version).path);
          emit("system", { fact: "reveal", by: "human", path: target, text: `Revealed ${target}` });
          return;
        }
        case "pick":
          void openPicker(ws, msg.want, rid);
          return;
        case "context.remove":
          session.removeContext(msg.id);
          syncWatchers();
          broadcastState();
          // The thumbnails of the images it showed are no longer worth keeping.
          pruneImageThumbs();
          return;
        case "read":
          reply(ws, {
            op: "version.text",
            doc: msg.doc,
            version: msg.version,
            text: session.readVersion(msg.doc, msg.version).text,
            origin: "load",
          });
          return;
        case "diff":
          reply(ws, { op: "diff", ...session.compare({ doc: msg.doc, against: msg.against }) });
          return;
        case "merge": {
          const r = session.merge({ doc: msg.doc, against: msg.against, hunks: msg.hunks });
          // The buffer the human is looking at must be told: the merge wrote the
          // active version's file, and the editor's text is now behind it.
          send({
            op: "version.text",
            doc: r.slug,
            version: r.version,
            text: r.text,
            origin: "remote",
          });
          const m = session.addMessage({
            from: "system",
            type: "info",
            text: `Took ${r.applied} change${r.applied === 1 ? "" : "s"} from ${sideName(msg.against, session.doc(r.slug).name)} into v${r.version} of ${r.slug}.`,
          });
          emit("merged", {
            doc: r.slug,
            version: r.version,
            against: msg.against,
            hunks: msg.hunks,
            by: "human",
            ts: m.ts,
          });
          broadcastState();
          return;
        }
        case "prefs.set": {
          // The image import settings are among them, checked here; the agent
          // reads them with `image-settings` when it needs them.
          setPrefs({ [msg.key]: msg.value });
          return;
        }
        case "close":
          // The page already asked the human to confirm. Same teardown as the
          // CLI's close, and the agent's tail hears `closed` with `by: "human"`.
          resolveDone({ code: 0, reason: "close", by: "human" });
          return;
        case "search":
          reply(ws, { op: "search.results", ...session.search(msg) });
          return;
        case "link.targets":
          reply(ws, { op: "link.targets", ...session.linkTargets(msg.doc) });
          return;
        case "link.headings":
          reply(ws, { op: "link.headings", ...session.linkHeadings(msg.doc, msg.path) });
          return;
        case "link.embeds": {
          const targets: unknown = msg.targets;
          if (!Array.isArray(targets) || !targets.every((t) => typeof t === "string"))
            throw new SessionError("link.embeds: targets must be a list of strings", 400);
          reply(ws, {
            op: "link.embeds",
            doc: msg.doc,
            embeds: session.embeds(msg.doc, targets),
          });
          return;
        }
        case "link.drop": {
          const paths: unknown = msg.paths;
          if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string"))
            throw new SessionError("link.drop: paths must be a list of strings", 400);
          reply(ws, { op: "link.drop", doc: msg.doc, links: session.droppedLinks(msg.doc, paths) });
          return;
        }
        case "link.backlinks":
          reply(ws, { op: "link.backlinks", ...session.backlinks(msg.doc) });
          return;
        case "profile":
          reply(ws, { op: "profile", ...session.documentProfile(msg.doc) });
          return;
        case "link.check":
          reply(ws, { op: "link.check", ...session.linkCheck() });
          return;
        case "link.graph": {
          const { op: _op, ...opts } = msg;
          reply(ws, { op: "link.graph", ...session.linkGraph(graphOptions(opts)) });
          return;
        }
        case "fs.list": {
          try {
            reply(ws, { op: "fs.list", path: msg.path, entries: listDir(expandHome(msg.path)) });
          } catch (e) {
            reply(ws, { op: "fs.list", path: msg.path, entries: [], error: messageOf(e) });
          }
          return;
        }
        default: {
          // Named, with what would have been accepted, like `/cmd` does: a frame
          // the daemon does not know must not vanish without a word.
          const op = (msg as { op?: unknown }).op;
          reply(ws, {
            op: "error",
            message:
              typeof op === "string"
                ? `unrecognised op ${JSON.stringify(op)}: nothing was applied`
                : "a frame needs an op: nothing was applied",
            choices: [...CLIENT_OPS, ...verbs.keys()],
          });
        }
      }
    };

    /** An app's own op, from either side; `null` when the name is not one of its verbs. */
    const callVerb = async (
      name: string,
      args: Record<string, unknown>,
      call: VerbCall,
    ): Promise<{ result: unknown } | null> => {
      const handler = verbs.get(name);
      if (!handler) return null;
      return { result: await handler(ctx, args, call) };
    };

    /**
     * `show`: the agent points the human's view at a change or a passage. Checked
     * first and moved second, so a hunk or a quote that is not there moves
     * nothing. The document becomes the open one, every surface is told where to
     * scroll, and the chat says so: a view that moves on its own must say why.
     */
    const showForAgent = (cmd: Extract<AgentCmd, { op: "show" }>): Record<string, unknown> => {
      const byHunk = cmd.hunk !== undefined;
      const byQuote = typeof cmd.quote === "string" && cmd.quote !== "";
      const byHeading = typeof cmd.heading === "string" && cmd.heading.trim() !== "";
      if ([byHunk, byQuote, byHeading].filter(Boolean).length !== 1)
        throw new SessionError(
          "show needs one of hunk (a change), quote (a passage) or heading (a heading)",
          400,
        );
      /** The heading named in `text`, or a 404 naming the nearest one. */
      const headingIn = (text: string, where: string) => {
        const hs = headingsOf(text);
        const m = findHeading(hs, cmd.heading as string);
        if (m) return m;
        const near = nearestHeading(hs, cmd.heading as string);
        throw new SessionError(
          `${where} has no heading "${cmd.heading}"${
            near ? `; the nearest is "${headingPlainText(near.text)}"` : ""
          }`,
          404,
          hs.map((h) => headingPlainText(h.text)),
        );
      };
      if (byHunk && (!Number.isInteger(cmd.hunk) || (cmd.hunk as number) < 1))
        throw new SessionError(`show: ${String(cmd.hunk)} is not a hunk id`, 400);
      // A path the session does not hold yet is checked before it is opened, so a
      // target that is not there leaves the session as it was. Not held, it has
      // no versions but the copy of its file that opening makes, so it has no
      // change to show; a passage is looked for in the file itself. Then it is
      // opened the way `version-new` opens one, under the same admission rule;
      // the human's view moves only below.
      if (cmd.doc && isAbsolute(cmd.doc) && !session.findDoc(cmd.doc)) {
        if (byHunk)
          throw new SessionError(
            `${basename(cmd.doc)} is not open in this session, so it has no changes to show`,
            404,
            undefined,
            "run: version-new --doc <path>, write the version, then diff and show",
          );
        let onDisk: string;
        try {
          onDisk = readFileSync(cmd.doc, "utf8");
        } catch {
          throw new SessionError(`no document at ${cmd.doc}`, 404);
        }
        if (byHeading) headingIn(onDisk, basename(cmd.doc));
        else if (!onDisk.includes(cmd.quote as string))
          throw new SessionError(
            `${basename(cmd.doc)} does not contain that text: quote it exactly as it appears`,
            404,
          );
        const o = session.openPath(cmd.doc, { focus: false });
        syncWatchers();
        if (o.created)
          emit("doc.opened", { doc: o.slug, path: session.activePath(o.slug), by: "agent" });
      }
      const key = cmd.doc ?? session.openDocSlug;
      if (!key) throw new SessionError("no document is open: name one with --doc", 409);
      const d = session.doc(slugOf(key));

      let target: ShowTarget;
      let said: string;
      let answer: Record<string, unknown>;
      if (byHunk) {
        const against = cmd.against ?? "original";
        const p = session.compare({ doc: d.slug, against });
        const hunks = p.diff.hunks;
        const i = hunks.findIndex((h) => h.id === cmd.hunk);
        const side = sideName(against, d.name);
        if (i === -1)
          throw new SessionError(
            hunks.length === 0
              ? `v${d.active} of ${d.slug} has no changes against ${side}`
              : `v${d.active} of ${d.slug} has no hunk ${cmd.hunk} against ${side}: run diff again for the ids`,
            404,
            hunks.map((h) => String(h.id)),
          );
        const h = hunks[i] as DiffHunk;
        target = { doc: d.slug, version: d.active, hunk: h.id, against };
        said = `Agent is showing you change ${i + 1} of ${hunks.length} in ${d.name}, v${d.active} compared with ${side}.`;
        answer = { hunk: h.id, of: hunks.length, against, line: h.aFrom + 1 };
      } else if (byHeading) {
        // A heading is pointed at as its whole line: the passage path the
        // surface already marks without selecting or taking focus.
        const text = session.readVersion(d.slug, d.active).text;
        const m = headingIn(text, `v${d.active} of ${d.slug}`);
        const { from, to } = lineRange(text, m.heading.line);
        const quote = text.slice(from, to);
        const name = headingPlainText(m.heading.text);
        target = { doc: d.slug, version: d.active, from, to, quote };
        said = `Agent is showing you the heading "${quoteLabel(name)}" in ${d.name}.`;
        answer = {
          heading: name,
          from,
          to,
          line: m.heading.line,
          ...(m.ambiguous ? { ambiguous: true } : {}),
        };
      } else {
        const quote = cmd.quote as string;
        const text = session.readVersion(d.slug, d.active).text;
        const at = text.indexOf(quote);
        if (at === -1)
          throw new SessionError(
            `v${d.active} of ${d.slug} does not contain that text: quote it exactly as it appears`,
            404,
          );
        target = { doc: d.slug, version: d.active, from: at, to: at + quote.length, quote };
        said = `Agent is showing you "${quoteLabel(quote)}" in ${d.name}.`;
        answer = { quote, from: at, to: at + quote.length, line: linesOf(text, at, at + 1).from };
      }

      if (session.openDocSlug !== d.slug) {
        session.openSlug(d.slug);
        broadcastState();
      }
      send({ op: "show", ...target });
      line(said);
      // How many pages were told: none means nobody saw it, and the agent should
      // say so in words instead.
      return { doc: d.slug, version: d.active, ...answer, surfaces: sockets.size };
    };

    // --- agent commands (POST /cmd) -----------------------------------------------
    const handleAgentCmd = async (cmd: AgentCmd): Promise<Record<string, unknown>> => {
      if (isStructureOp(cmd)) return structure(anchorSurfacePaths(cmd), "agent");
      switch (cmd.op) {
        case "doctor": {
          const list = session.checkup();
          return { findings: list, count: list.length };
        }
        case "search":
          return { ...session.search(cmd) };
        case "backlinks": {
          const edge = edgeKinds(cmd.edge, "backlinks");
          return { ...session.backlinks(cmd.doc, edge ? { edge } : {}) };
        }
        case "link.check": {
          const edge = edgeKinds(cmd.edge, "link-check");
          return { ...session.linkCheck(edge ? { edge } : {}) };
        }
        case "graph": {
          const { op: _op, ...opts } = cmd;
          return { ...session.linkGraph(graphOptions(opts)) };
        }
        case "profiles":
          return { ...session.profiles() };
        case "profile":
          return { ...session.documentProfile(cmd.doc) };
        case "profile.check":
          return { ...session.profileCheck() };
        case "relations":
          return { ...session.relations() };
        case "image.settings": {
          // The app's image import settings: read, or set the ones given. The
          // user's preference, so a change by the agent is said in the chat.
          const given: Record<string, string> = {};
          for (const [field, key] of Object.entries(IMAGE_PREF_KEYS)) {
            const v = cmd[field as keyof typeof IMAGE_PREF_KEYS];
            if (v !== undefined) given[key] = String(v).trim();
          }
          const before = readImageImportSettings(readPrefs());
          // Refused whole, before anything is written, when any value is bad.
          if (Object.keys(given).length > 0) setPrefs(given);
          const settings = readImageImportSettings(readPrefs());
          const changed = JSON.stringify(before) !== JSON.stringify(settings);
          if (changed) {
            // Each change named, so one the summary does not show (a quality
            // while the format is kept) is still said.
            const what = [
              ...(before.format !== settings.format
                ? [settings.format === "webp" ? "convert to WebP" : "keep the format they come in"]
                : []),
              ...(before.quality !== settings.quality ? [`quality ${settings.quality}`] : []),
              ...(before.maxSide !== settings.maxSide
                ? [
                    settings.maxSide === null
                      ? "no limit on size"
                      : `longest side ${settings.maxSide} px`,
                  ]
                : []),
            ];
            line(
              `Agent changed the image import settings: ${what.join(", ")}. Images brought in are now ${describeImageImport(settings)}.`,
            );
          }
          return { settings, summary: describeImageImport(settings), changed, file: prefsFile };
        }
        case "image.describe": {
          const source = cmd.source ?? "user";
          if (!(IMAGE_SOURCES as readonly string[]).includes(source))
            throw new SessionError(
              `describe-image: --source must be one of ${IMAGE_SOURCES.join(", ")}`,
              400,
              [...IMAGE_SOURCES],
            );
          const made = session.describeImage(cmd.image, source);
          syncWatchers();
          // Undone like any creation: the empty description is the session's own.
          // On the one undo stack, as every structure act is, the agent's
          // included (`new-doc`, `rename`, `move`). Its undo sends the
          // description to the Trash only while it is still the skeleton.
          history.did({
            label: `created ${basename(made.path)}`,
            inverse: { kind: "delete", path: made.path, dir: false, unchanged: made.hash },
          });
          announce(
            `Agent started a description of ${session.display(made.image)}, in ${session.display(made.path)}.`,
            { fact: "image.describe", by: "agent", path: made.path, image: made.image },
          );
          const o = session.openPath(made.path, { focus: false });
          if (o.created)
            emit("doc.opened", { doc: o.slug, path: session.activePath(o.slug), by: "agent" });
          const label = cmd.label ?? "Description";
          const v = session.newVersion({ doc: o.slug, label, by: "agent" });
          line(
            `Agent created v${v.version.n} of ${v.slug} from v${v.version.fromVersion}: ${label}.`,
          );
          emit("version.created", {
            doc: v.slug,
            version: v.version.n,
            fromVersion: v.version.fromVersion,
            label,
            by: "agent",
            path: v.version.path,
          });
          broadcastState();
          return {
            image: made.image,
            sidecar: made.path,
            doc: v.slug,
            version: v.version.n,
            from: v.version.fromVersion,
            path: v.version.path,
          };
        }
        case "reveal": {
          const target = revealPath(cmd.path);
          emit("system", { fact: "reveal", by: "agent", path: target, text: `Revealed ${target}` });
          return { path: target, revealed: true };
        }
        case "version.delete": {
          await mayDeleteVersion(cmd.doc, cmd.version, "agent");
          const r = session.deleteVersion({ doc: cmd.doc, version: cmd.version });
          await afterDelete(r.slug, r.version, "agent");
          line(`Agent deleted v${r.version} of ${r.slug}${r.label ? `: ${r.label}` : ""}.`);
          emit("version.deleted", { doc: r.slug, version: r.version, by: "agent" });
          return { doc: r.slug, version: r.version, remaining: r.remaining };
        }
        case "note.add": {
          const r = session.addNote({
            doc: cmd.doc,
            body: cmd.body,
            by: "agent",
            quote: cmd.quote,
          });
          line(`Agent noted "${quoteLabel(r.note.quote)}" on ${r.slug}.`);
          // The agent's own acts on notes stay on the log and off its tail: it
          // knows what it just did, and its reply already says it.
          emit("note.added", { doc: r.slug, note: r.note.id, by: "agent" }, { wake: false });
          return { doc: r.slug, note: r.note.id, quote: r.note.quote };
        }
        case "notes": {
          const r = session.notesOf({ doc: cmd.doc, ...(cmd.all ? { all: true } : {}) });
          return { doc: r.slug, notes: r.notes };
        }
        case "note.edit": {
          // The agent's rewrite answers the note (`notesWaiting`): an act on
          // this note that the human sees on this note.
          const r = session.editNote({ doc: cmd.doc, id: cmd.id, body: cmd.body, by: "agent" });
          if (!r.changed)
            return { doc: r.slug, note: r.note.id, body: r.note.body, unchanged: true };
          line(`Agent rewrote a note on ${r.slug}: "${quoteLabel(r.note.quote)}".`);
          emit(
            "system",
            { fact: "note.edited", doc: r.slug, note: r.note.id, by: "agent" },
            { wake: false },
          );
          return { doc: r.slug, note: r.note.id, body: r.note.body };
        }
        case "note.resolve": {
          const r = session.resolveNote({
            doc: cmd.doc,
            id: cmd.id,
            resolved: cmd.resolved,
            by: "agent",
          });
          line(
            `Agent ${cmd.resolved ? "resolved" : "reopened"} a note on ${r.slug}: "${quoteLabel(r.note.quote)}".`,
          );
          emit(
            "note.resolved",
            { doc: r.slug, note: r.note.id, by: "agent", resolved: r.note.resolved },
            { wake: false },
          );
          return { doc: r.slug, note: r.note.id, resolved: r.note.resolved };
        }
        case "working": {
          // The snooze. It does not post to the chat: an agent saying "still
          // working" in the conversation is a reply, and it can do that with
          // `say`. This is the quieter thing, for when there is nothing to
          // report yet but the alarm should stop.
          const ms = cmd.seconds !== undefined ? cmd.seconds * 1000 : DEFAULT_SNOOZE_MS;
          acknowledgedUntil = Date.now() + Math.max(0, ms);
          // Whatever is pending is acknowledged, so it is never nudged again.
          const w = waitingOn(session.messages(), Date.now(), {
            acknowledgedUntil,
            stallMs: opts.stallMs,
          });
          if (w) nudged.add(w.messageId);
          broadcastState();
          return {
            until: new Date(acknowledgedUntil).toISOString(),
            seconds: Math.round(Math.max(0, ms) / 1000),
            ...(w ? { waiting: w.messageId } : {}),
          };
        }
        case "task.create": {
          // A task the agent creates is announced as a chat message from the
          // agent and keeps that message's id, so the two stay one thing: the
          // conversation reads as a narrative and the list reads as state. The
          // agent is starting it, so it is `running` from the first moment.
          const title = cmd.title.trim();
          if (!title) throw new SessionError("a task needs to say what the work is", 400);
          // Checked before the announcement is posted, so a refusal leaves no
          // orphan line in the chat.
          if (cmd.parent) session.task(cmd.parent);
          const m = session.addMessage({ from: "agent", type: "message", text: title });
          const t = engine.create({
            title,
            by: "agent",
            status: "running",
            messageId: m.id,
            ...(cmd.detail ? { detail: cmd.detail } : {}),
            ...(cmd.parent ? { parent: cmd.parent } : {}),
          });
          return { task: t.id, title: t.title, status: t.status, message_id: m.id };
        }
        case "task.status": {
          const t = engine.setDetail(cmd.id, cmd.detail, "agent");
          return { task: t.id, status: t.status, detail: t.detail };
        }
        case "task.done": {
          const r = engine.finish(
            cmd.id,
            cmd.failed ? "failed" : "done",
            cmd.failed ? { detail: cmd.outcome } : { outcome: cmd.outcome },
            "agent",
          );
          return { task: r.task.id, status: r.task.status, already: r.already };
        }
        case "task.cancel": {
          const r = engine.cancel(cmd.id, "agent");
          return { task: r.task.id, status: r.task.status, already: r.already };
        }
        case "diff": {
          const p = session.compare({ doc: cmd.doc, against: cmd.against });
          return {
            doc: p.doc,
            active: p.active,
            against: p.against,
            same: p.diff.same,
            coarse: p.diff.coarse,
            hunks: p.diff.hunks,
            unified: unified(p.diff, {
              from: `v${p.active}`,
              to: sideName(p.against, session.doc(p.doc).name),
              ...(cmd.context === undefined ? {} : { context: cmd.context }),
            }),
          };
        }
        case "merge": {
          const r = session.merge({
            doc: cmd.doc,
            against: cmd.against,
            hunks: cmd.hunks,
            json: "refuse",
          });
          send({
            op: "version.text",
            doc: r.slug,
            version: r.version,
            text: r.text,
            origin: "remote",
          });
          line(
            `Agent took ${r.applied} change${r.applied === 1 ? "" : "s"} from ${sideName(cmd.against, session.doc(r.slug).name)} into v${r.version} of ${r.slug}.`,
          );
          emit("merged", {
            doc: r.slug,
            version: r.version,
            against: cmd.against,
            hunks: cmd.hunks,
            by: "agent",
          });
          return { doc: r.slug, version: r.version, applied: r.applied };
        }
        case "show":
          return showForAgent(cmd);
        case "context.add": {
          const added = addPaths(cmd.paths);
          return { entries: added.map((a) => ({ ...a.entry, added: a.added })) };
        }
        case "version.new": {
          // The agent may name a doc the human has not opened, by absolute path
          // (the CLI resolves it against its own cwd); it is opened implicitly
          // under the same admission rule as the surface's `open` (a
          // document-type file inside a context entry) without moving the human's
          // open document.
          if (cmd.doc && isAbsolute(cmd.doc) && !session.findDoc(cmd.doc)) {
            const o = session.openPath(cmd.doc, { focus: false });
            syncWatchers();
            if (o.created)
              emit("doc.opened", { doc: o.slug, path: session.activePath(o.slug), by: "agent" });
          }
          if (cmd.body !== undefined && typeof cmd.body !== "string")
            throw new SessionError("version.new: body must be text", 400);
          const r = session.newVersion({
            doc: cmd.doc,
            from: cmd.from,
            label: cmd.label,
            ...(cmd.body !== undefined ? { body: cmd.body } : {}),
            by: "agent",
          });
          line(
            `Agent created v${r.version.n} of ${r.slug} from v${r.version.fromVersion}${cmd.label ? `: ${cmd.label}` : ""}.`,
          );
          // Written in the same act, so no file event carries it: say here what
          // the watcher says of a JSON version that does not parse.
          if (cmd.body !== undefined) tellInvalidJson(r.slug, r.version.n);
          emit("version.created", {
            doc: r.slug,
            version: r.version.n,
            fromVersion: r.version.fromVersion,
            ...(cmd.label ? { label: cmd.label } : {}),
            by: "agent",
            path: r.version.path,
          });
          return {
            doc: r.slug,
            version: r.version.n,
            from: r.version.fromVersion,
            path: r.version.path,
            written: cmd.body !== undefined,
          };
        }
        case "say": {
          // Only what an agent's message may point at: entries and a note. The
          // rest of `MessageAbout` is the human's (`refs`, `docs`, a subject and
          // a passage are what the human pointed at), so it is dropped, not
          // stored as sent, and so is any other key sent. An entry id that is
          // not a string is dropped on its own; the others stay.
          const raw = cmd.about as Partial<MessageAbout> | null | undefined;
          const entryIds = Array.isArray(raw?.entryIds)
            ? (raw.entryIds as unknown[]).filter((e): e is string => typeof e === "string")
            : undefined;
          const noteId = typeof raw?.noteId === "string" && raw.noteId ? raw.noteId : undefined;
          const about: Pick<MessageAbout, "entryIds" | "noteId"> | undefined =
            entryIds?.length || noteId
              ? { ...(entryIds?.length ? { entryIds } : {}), ...(noteId ? { noteId } : {}) }
              : undefined;
          const { via, advice } = viaOf(cmd.via, "agent");
          const m = session.addMessage({
            from: "agent",
            type: "message",
            text: cmd.text,
            ...(about ? { about } : {}),
            ...(via ? { via } : {}),
          });
          broadcastState();
          // Stored as sent; one outside the list is answered, not refused.
          return { id: m.id, ...(advice.length > 0 ? { warning: advice.join(" ") } : {}) };
        }
        case "activate":
          return activate(cmd.doc, cmd.version, "agent");
        case "relink":
          return relink("agent");
        case "close":
          resolveDone({ code: 0, reason: "close", by: "agent" });
          return {};
        default:
          throw new SessionError(
            `unrecognised command ${JSON.stringify((cmd as { op?: unknown }).op)}: nothing was applied`,
            400,
            [
              "context.add",
              "version.new",
              "say",
              "activate",
              "close",
              "doctor",
              "search",
              "backlinks",
              "link.check",
              "graph",
              "profiles",
              "profile",
              "profile.check",
              "relations",
              "image.describe",
              "image.settings",
              "reveal",
              ...STRUCTURE_OPS,
              ...verbs.keys(),
            ],
          );
      }
    };

    const refusal = (e: unknown): Response => {
      if (e instanceof SessionError)
        return Response.json(
          {
            ok: false,
            error: e.message,
            ...(e.choices ? { choices: e.choices } : {}),
            ...(e.hint ? { hint: e.hint } : {}),
            ...(e instanceof ImageTakenError ? { name: e.takenName } : {}),
          },
          { status: e.status },
        );
      if (e instanceof PathError)
        return Response.json({ ok: false, error: e.message }, { status: 404 });
      return Response.json({ ok: false, error: String(e) }, { status: 500 });
    };

    /** Tell the surface when presence is not what it was last sent. */
    const presenceMaybeChanged = () => {
      if (!closed && agentListening() !== presenceShown) broadcastState();
    };
    /** Hold presence for at least `ms` from now, and look again when the hold runs out. */
    const holdAgent = (ms: number) => {
      // A closing daemon drains its tails, and each close lands here: a hold armed
      // then would keep the process alive for its whole length.
      if (closed) return;
      agentHeldUntil = Math.max(agentHeldUntil, performance.now() + ms);
      if (agentGraceTimer) clearTimeout(agentGraceTimer);
      agentGraceTimer = setTimeout(
        () => {
          agentGraceTimer = null;
          presenceMaybeChanged();
        },
        agentHeldUntil - performance.now() + 5,
      );
      // Presence is never a reason for the process to stay up.
      agentGraceTimer.unref?.();
      presenceMaybeChanged();
    };
    /** A tail of the agent's attached: it ends any hold, which its own close renews. */
    const agentTailOpened = () => {
      agentTails++;
      agentHeldUntil = 0;
      if (agentGraceTimer) clearTimeout(agentGraceTimer);
      agentGraceTimer = null;
      presenceMaybeChanged();
    };
    /** The last tail let go: a woken `--once` holds longer than a watch's re-arm. */
    const agentTailClosed = (woken: boolean) => {
      agentTails = Math.max(0, agentTails - 1);
      if (agentTails > 0) return;
      holdAgent(woken ? agentOnceGraceMs : agentGraceMs);
    };

    const eventsResponse = (req: Request, url: URL): Response => {
      touch();
      const agent = url.searchParams.get(AGENT_TAIL_PARAM) === "1";
      const once = url.searchParams.get(AGENT_ONCE_PARAM) === "1";
      const all = url.searchParams.get(AGENT_ALL_PARAM) === "1";
      const since = Number.parseInt(url.searchParams.get("since") ?? "-1", 10);
      // Whether this stream sent a frame: a `--once` that did woke the agent. Not
      // the log's cursor, which quiet frames the agent was never sent also move.
      let sent = false;
      return sseResponse({
        log,
        since,
        heartbeatMs: SSE_HEARTBEAT_MS,
        clients: sseClients,
        signal: req.signal,
        // ⛔ ONLY THE AGENT'S TAIL IS FILTERED. A quiet event is still on the log
        // and every other reader is sent it. The agent's cursor stays at the
        // last frame it was sent, so a re-arm's `--since` replays the quiet
        // frames after it and they are filtered again: nothing lost, nothing doubled.
        filter: (frame) => {
          const pass = !agent || all || !(QUIET in frame);
          if (pass) sent = true;
          return pass;
        },
        onOpen: () => {
          touch();
          if (agent) agentTailOpened();
        },
        onClose: () => {
          touch();
          // A `--once` that closes having been sent a frame: the agent was woken,
          // and is at work.
          if (agent) agentTailClosed(once && sent);
        },
      });
    };

    // --- serve ------------------------------------------------------------------
    const distDir = opts.surface?.distDir;
    const server = Bun.serve({
      port: opts.port ?? 0,
      hostname: "127.0.0.1",
      routes,
      idleTimeout: IDLE_TIMEOUT_SEC,
      development: { hmr: mode === "dev" && devIndex !== undefined },
      async fetch(req, srv) {
        // Refused on the request, not on a list of paths: no inventory of
        // "dangerous routes" can go stale.
        {
          const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
          if (refused) return refused;
        }
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === "/ws")
          return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
        if (req.method === "GET" && path === "/state") {
          touch();
          const state = viewState();
          const full = url.searchParams.get("full") === "1";
          return Response.json({
            ...state,
            chat: full ? state.chat : state.chat.slice(-10),
            chatTotal: state.chat.length,
            active: activeOf(),
            cursor: log.cursor(),
            epoch: log.epoch,
          });
        }
        if (req.method === "GET" && path === "/events") return eventsResponse(req, url);
        if (req.method === "GET" && path === "/fs/version") {
          touch();
          try {
            return Response.json(
              session.readVersion(
                url.searchParams.get("doc") ?? "",
                Number.parseInt(url.searchParams.get("v") ?? "", 10),
              ),
            );
          } catch (e) {
            return refusal(e);
          }
        }
        if (req.method === "GET" && path === "/fs/list") {
          touch();
          try {
            return Response.json({
              entries: listDir(expandHome(url.searchParams.get("path") ?? "~")),
            });
          } catch (e) {
            return Response.json({ ok: false, error: messageOf(e) }, { status: 404 });
          }
        }
        // Images: the bytes of an image the tree shows, a cached thumbnail of
        // one, and a dropped image coming in. `imageFile` is the guard.
        if (req.method === "GET" && (path === "/fs/file" || path === "/fs/thumb")) {
          touch();
          if (crossSite(req)) return imageRefusal(403, "images are served to this app's own page");
          const w = Number(url.searchParams.get("w") ?? THUMB_WIDTHS[0]);
          const width = THUMB_WIDTHS.find((x) => x === w);
          if (path === "/fs/thumb" && width === undefined)
            return imageRefusal(400, `a thumbnail is ${THUMB_WIDTHS.join(" or ")} pixels wide`);
          try {
            // The guard opens the file once; every byte below comes from `f.fd`.
            const f = session.imageFile(url.searchParams.get("path") ?? "");
            const original = { fd: f.fd, size: f.size };
            if (path === "/fs/file" || width === undefined)
              return imageResponse(req, original, f.type, f.stamp);
            try {
              const out = await thumbnail(
                session.dir,
                () => {
                  if (f.size > THUMB_SOURCE_MAX_BYTES)
                    throw new ImageError("the image is too large to preview", "too-large");
                  return readAllFd(f.fd, f.size);
                },
                f.stamp,
                width,
              );
              closeSync(f.fd);
              return imageResponse(req, { path: out }, "image/webp", `${f.stamp}-${width}`);
            } catch {
              // A machine that cannot decode it (an AVIF without an AV1
              // decoder): the original stands in, which the browser may read.
              return imageResponse(req, original, f.type, f.stamp);
            }
          } catch (e) {
            return refusal(e);
          }
        }
        if (req.method === "POST" && path === "/fs/image") {
          touch();
          if (crossSite(req)) return imageRefusal(403, "images come in from this app's own page");
          try {
            const q = url.searchParams;
            const onTaken = q.get("onTaken") ?? "ask";
            if (onTaken !== "ask" && onTaken !== "keep-both" && onTaken !== "replace")
              throw new SessionError(`onTaken is ask, keep-both or replace, not ${onTaken}`, 400, [
                "ask",
                "keep-both",
                "replace",
              ]);
            const dir = q.get("dir");
            const doc = q.get("doc");
            const how = q.get("how") ?? "drop";
            if (how !== "paste" && how !== "drop")
              throw new SessionError(`how is paste or drop, not ${how}`, 400, ["paste", "drop"]);
            const tooLarge = () =>
              new SessionError(
                `that file is larger than ${IMAGE_MAX_BYTES / 1024 / 1024} MB: not brought in`,
                400,
              );
            const declared = Number(req.headers.get("content-length") ?? 0);
            if (declared > IMAGE_MAX_BYTES) throw tooLarge();
            // Counted as it streams in: a chunked body with no length stops at the cap.
            const bytes = await readCapped(req.body, IMAGE_MAX_BYTES);
            if (!bytes) throw tooLarge();
            // A body that ended before its declared length is a cut-off upload:
            // written as it stands it would be a broken file under a good name.
            // Bun aborts the read when the connection closes early (the catch
            // below refuses it); this holds should a body ever end short instead.
            if (req.headers.has("content-length") && bytes.byteLength < declared)
              throw new SessionError(
                `the upload ended after ${bytes.byteLength} of ${declared} bytes: not brought in`,
                400,
              );
            // Onto a bundle's view (a board): into its own `assets/`.
            const bundle = q.get("bundle");
            if (bundle)
              return Response.json({
                ok: true,
                ...(await imageIntoBundle(surfacePath(bundle), q.get("name") ?? "", bytes, how)),
              });
            // Into a document's editor: beside the document, never asked about.
            if (doc)
              return Response.json({
                ok: true,
                ...(await imageBeside(surfacePath(doc), q.get("name") ?? "", bytes, how)),
              });
            const r = await imageIn(q.get("name") ?? "", bytes, {
              ...(dir ? { dir: surfacePath(dir) } : {}),
              onTaken,
            });
            return Response.json({ ok: true, ...r });
          } catch (e) {
            return refusal(e);
          }
        }
        if (req.method === "POST" && path === "/cmd") {
          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ ok: false, error: "bad json" }, { status: 400 });
          }
          touch();
          // Only the agent's CLI posts here: a call is the agent at work, unless
          // the CLI says it is its own bookkeeping (`open` adding its paths).
          if (req.headers.get(NOT_PRESENCE_HEADER) !== "1") holdAgent(agentGraceMs);
          if (body === null || typeof body !== "object" || Array.isArray(body))
            return Response.json(
              { ok: false, error: 'a command must be a JSON object, with its "op"' },
              { status: 400 },
            );
          try {
            const cmd = body as Record<string, unknown> & { op?: string };
            const hit = typeof cmd.op === "string" ? verbs.has(cmd.op) : false;
            if (hit) {
              const r = await callVerb(cmd.op as string, cmd, { from: "agent", reply: () => {} });
              const result = r?.result;
              return Response.json({
                ok: true,
                ...(result && typeof result === "object" ? (result as object) : {}),
              });
            }
            refuseMissingDir(cmd);
            checkAgentCmd(cmd);
            beforeKitAct(cmd.op);
            return Response.json({ ok: true, ...(await handleAgentCmd(body as AgentCmd)) });
          } catch (e) {
            return refusal(e);
          }
        }
        const custom = await opts.http?.(req, url, ctx);
        if (custom) return custom;
        if (mode === "release" && distDir) {
          const asset = serveFromDist(distDir, path === "/" ? "index.html" : path.slice(1));
          if (asset) return asset;
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          touch();
          ws.send(JSON.stringify({ op: "state", state: viewState() }));
        },
        async message(ws, raw) {
          touch();
          let msg: ClientOp;
          let rid: string | number | undefined;
          try {
            msg = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw),
            ) as ClientOp;
          } catch (e) {
            process.stderr.write(`${app.name}: bad json from browser: ${e}\n`);
            return;
          }
          const idOf = (msg as { rid?: unknown } | null)?.rid;
          rid = typeof idOf === "string" || typeof idOf === "number" ? idOf : undefined;
          try {
            const name = (msg as { op?: unknown } | null)?.op;
            if (typeof name === "string" && verbs.has(name)) {
              await callVerb(name, msg as unknown as Record<string, unknown>, {
                from: "surface",
                surface: surfaceId(ws),
                reply: (frame) => replyRaw(ws, frame, rid),
              });
              return;
            }
            beforeKitAct(name);
            await handleClientOp(ws, msg, rid);
          } catch (e) {
            // A refusal the human caused (edit a non-active version, open a
            // vanished file) reaches them as an error frame the surface shows: a
            // chat-visible system line would be too loud for a keystroke.
            replyRaw(
              ws,
              {
                op: "error",
                message: messageOf(e),
                ...(e instanceof SessionError && e.hint ? { hint: e.hint } : {}),
              },
              rid,
            );
          }
        },
        close(ws) {
          sockets.delete(ws);
          const id = surfaceIds.get(ws);
          if (id && opts.hooks?.onSurfaceClose) {
            try {
              opts.hooks.onSurfaceClose(id, ctx);
            } catch (e) {
              process.stderr.write(`${app.name}: onSurfaceClose failed: ${messageOf(e)}\n`);
            }
          }
        },
      },
    });

    const boundPort = server.port as number;
    unwindBoot = () => {
      for (const w of watchers.values()) w.close();
      watchers.clear();
      try {
        removePointer(app.name, sessionId, { tmp: opts.tmp });
      } catch {
        /* gone, fine */
      }
      server.stop(true);
    };
    // --- discovery -------------------------------------------------------------------
    try {
      publishPointer(
        app.name,
        {
          url: `http://127.0.0.1:${boundPort}`,
          port: boundPort,
          session_id: sessionId,
          dir: session.dir,
          pid: process.pid,
        },
        { tmp: opts.tmp },
      );
    } catch {
      /* discovery is best-effort */
    }

    syncWatchers();
    // The session says what its own timeout is. `--timeout 0` has always meant
    // "stand until closed" and there was no way to confirm from outside that a
    // daemon had taken it.
    emit("ready", {
      app: app.name,
      mode,
      session_id: sessionId,
      restored: !!opts.restore,
      idle_timeout_s: timeoutS,
    });

    // What changed on disk while no daemon was watching, and what a restore had
    // to settle.
    const report = session.restoreReport;
    // Said first: everything below is about the session as converted.
    if (report.manifestMigrated)
      announce(
        `${report.manifestMigrated.note ?? `This session was converted for ${app.name}.`} The manifest it had is kept at ${report.manifestMigrated.kept}.`,
        { fact: "manifest.migrated", kept: report.manifestMigrated.kept },
      );
    for (const f of report.outside)
      announce(
        f.missing
          ? `${f.original} is gone from disk since this session was last open. The text and its versions are still here: Save recreates the file only when asked; Revert cannot run.`
          : `${f.original} changed on disk while this session was closed. Save overwrites it with the active version; Revert takes the file's version.`,
        { fact: "original.conflict", doc: f.doc, whileClosed: true },
      );
    for (const t of report.tasks) {
      emit(t.now === "failed" ? "task.failed" : "task.cancelled", {
        task: t.id,
        title: t.title,
        by: "daemon",
        was: t.was,
        restored: true,
        ...(t.now === "failed" ? { message: session.task(t.id).detail } : {}),
      });
      line(
        t.now === "failed"
          ? `${t.title} was running when the daemon stopped, so it is marked failed.`
          : `${t.title} had not started when the daemon stopped, so it is cancelled.`,
      );
    }
    if (report.workspaceDefaulted !== undefined)
      announce(
        `This session was saved before it had a workspace folder, so ${report.workspaceDefaulted} is the workspace now. Change it with the pencil in the sidebar or \`workspace <dir>\`.`,
        { fact: "workspace.defaulted", path: report.workspaceDefaulted },
      );
    if (report.workspaceAdded !== undefined)
      announce(
        `This session was saved with ${report.workspaceAdded} as its workspace folder. ${app.name} has no default folder now, so it is a set in the sidebar: its files are still here, and a new file goes where you point.`,
        { fact: "workspace.added", path: report.workspaceAdded },
      );
    // A session from before the overlap block still opens, and says what to
    // change: once, not at every restore (`doctor` keeps listing it).
    {
      const overlap = session.overlapToSay();
      const raw = session.workspaceOverlap();
      if (overlap && raw)
        announce(overlapMessage(overlap), {
          fact: "workspace.overlap",
          path: session.workspace,
          set: raw.root,
        });
    }
    if (report.slotMigratedFrom !== undefined)
      announce(
        `This session's ${app.name} data was brought forward from version ${report.slotMigratedFrom}.`,
        {
          fact: "slot.migrated",
          from: report.slotMigratedFrom,
        },
      );

    // One line when the session has something worth looking at, and silence when
    // it does not. A summary, not a repeat: the per-document conflicts above say
    // their own piece with the Save/Revert nuance; this counts what is there,
    // including the things those lines never covered (a context entry pointing at
    // nothing), and points at the verb.
    {
      const list = session.checkup();
      const text = summary(list);
      // The chat line leaves the link check's findings to the status bar mark.
      if (text) announce(text, { fact: "doctor", findings: list.length });
      // The agent gets the whole report on its tail, link findings included, so
      // an agent that arrives later does not have to ask or parse the sentence.
      if (list.length > 0) emit("doctor", { count: list.length, findings: list });
    }

    /**
     * The attention tick. Separate from housekeeping because it is about the
     * human's patience rather than the daemon's lifetime, and because it runs on
     * a slower clock: a 250 ms sweep re-broadcasting state would be churn for a
     * value that changes twice in a wait.
     */
    let lastWaiting: string | null = null;
    const attentionTimer = setInterval(() => {
      const now = Date.now();
      const w = waitingOn(session.messages(), now, {
        acknowledgedUntil,
        stallMs: opts.stallMs,
      });
      // A note flipping to "may be stuck" is a change the surface must see too.
      // Not a nudge: the mark is the human's, and the event that delivered the
      // note already carried it to the agent.
      const notes = notesWaiting(session.noteFacts(), session.messages(), now, {
        acknowledgedUntil,
        stallMs: opts.stallMs,
      });
      const key = attentionKey(w, notes);
      if (key === lastWaiting) return;
      lastWaiting = key;
      // The badge changed, so the surface needs the new snapshot.
      broadcastState();
      if (!w) return;
      if (w.badge !== "stalled" || nudged.has(w.messageId)) return;
      nudged.add(w.messageId);
      // The nudge goes to the agent's tail and nowhere else. The human already
      // sees the badge; putting this in the chat as well would be telling them
      // what they are looking at. It carries the message text because an agent
      // that has been away needs to know what is pending, not just that
      // something is, and it names the two ways out.
      const pendingMsg = session.messages().find((m) => m.id === w.messageId);
      emit("waiting", {
        message_id: w.messageId,
        seconds: Math.round((Date.now() - Date.parse(w.since)) / 1000),
        ...(pendingMsg ? { text: pendingMsg.text } : {}),
        hint: waitingHint(sessionId),
      });
    }, opts.attentionMs ?? 1000);

    const stopHousekeeping = startHousekeeping({
      subscriberCount: () => sockets.size + sseClients.size,
      idleMs: () => performance.now() - lastActivity,
      touch,
      timeoutMs: timeoutS * 1000,
      onIdleClose: () => resolveDone({ code: 124, reason: "timeout", by: "timeout" }),
    });

    const close = async (by: ClosedBy, announce: boolean) => {
      if (closed) return;
      // What an app still holds in memory is written while the session can take it.
      try {
        opts.hooks?.beforeClose?.(ctx);
      } catch (e) {
        process.stderr.write(`${app.name}: beforeClose failed: ${messageOf(e)}\n`);
      }
      closed = true;
      stopHousekeeping();
      clearInterval(attentionTimer);
      if (editTimer) clearTimeout(editTimer);
      if (agentGraceTimer) clearTimeout(agentGraceTimer);
      for (const a of arrivals.values()) if (a.timer) clearTimeout(a.timer);
      arrivals.clear();
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const t of pending.values()) clearTimeout(t);
      for (const t of rechecks.values()) clearTimeout(t);
      if (contextChanged) clearTimeout(contextChanged);
      if (resync) clearTimeout(resync);
      pruneImageThumbs();
      // A running job must not outlive the session that owns it.
      try {
        await engine.abortAll();
      } catch {
        /* best-effort */
      }
      try {
        // Who ended it outlives the daemon, for a tail re-armed after the end.
        // A programmatic `stop()` (a restart, a test) is not an end.
        if (announce) session.markEnded(by);
        session.persist();
      } catch {
        /* best-effort */
      }
      try {
        removePointer(app.name, sessionId, { tmp: opts.tmp });
      } catch {
        /* gone, fine */
      }
      log.emit({ type: "closed", by });
      // The surface hears it too, so it can say "Session ended" and stop retrying.
      // A programmatic `stop()` (a restart, a test) is not an end: the page keeps
      // retrying and finds the daemon when it is back.
      if (announce) send({ op: "closed", by });
      await drainAndStop({
        server,
        clients: sseClients,
        sockets,
        ...(opts.drainGraceMs !== undefined ? { graceMs: opts.drainGraceMs } : {}),
      });
      resolveShutdown();
    };
    void done.then((v) => close(v.by, v.reason !== "stop"));

    return { port: boundPort, session, ctx };
  }
}

/** The daemon's private argv: the CLI spawns it with exactly these. */
const DAEMON_OPTIONS = {
  log: { type: "string" },
  port: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
  workspace: { type: "string" },
} as const;

/**
 * A daemon process's entry: parse its argv, boot, print the handshake line the
 * CLI waits for, wait for the end. Returns the exit code (0 closed, 124 idle,
 * and the `not_found`/`conflict` codes for a restore that was refused).
 *
 * `build` makes the daemon from what the command line said; everything else the
 * app decided is already in it.
 */
export async function runWorkspaceDaemon(
  argv: string[],
  build: (flags: {
    port: number;
    restore?: string;
    timeoutS?: number;
    workspace?: string;
  }) => WorkspaceDaemon,
  name = "workspace",
): Promise<number> {
  let flags: Record<string, string | undefined>;
  try {
    flags = nodeParseArgs({ args: argv, options: DAEMON_OPTIONS, strict: true }).values as Record<
      string,
      string | undefined
    >;
  } catch (e) {
    process.stderr.write(
      `${name}: ${messageOf(e)}\n  recognized flags: ${Object.keys(DAEMON_OPTIONS)
        .map((k) => `--${k}`)
        .join(" ")}\n`,
    );
    return 2;
  }
  let d: WorkspaceDaemon;
  try {
    d = build({
      port: flags.port ? Number(flags.port) : 0,
      ...(flags.restore ? { restore: flags.restore } : {}),
      ...(flags.timeout ? { timeoutS: Number(flags.timeout) } : {}),
      ...(flags.workspace ? { workspace: flags.workspace } : {}),
    });
    await d.start();
  } catch (e) {
    // The handshake line is JSON either way, so the CLI reads one shape.
    const status = e instanceof SessionError ? e.status : 500;
    // The refusal's hint rides along: `open` forwards it to the envelope.
    const hint = e instanceof SessionError && e.hint ? { hint: e.hint } : {};
    process.stdout.write(
      `${JSON.stringify({ ok: false, status, error: messageOf(e), ...hint })}\n`,
    );
    return status === 404 ? 5 : status === 409 ? 6 : 1;
  }
  process.stdout.write(
    // `workspace` rides the handshake so `open` can name it, restored or new;
    // left out (undefined) for an app with no home workspace.
    `${JSON.stringify({ url: d.url, port: d.port, session_id: d.sessionId, mode: d.mode, dir: d.dir, workspace: d.session.hasHome ? d.session.workspace : undefined })}\n`,
  );
  const res = await d.done;
  await d.shutdown;
  // A clean close leaves no empty log behind.
  if (res.code === 0 && flags.log) {
    try {
      if (statSync(flags.log).size === 0) unlinkSync(flags.log);
    } catch {
      /* already gone */
    }
  }
  return res.code;
}
