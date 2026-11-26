/**
 * The daemon's rules: its timing constants, the agent commands' field checks
 * (`checkAgentCmd`), the ops the kit answers itself (`STRUCTURE_OPS`,
 * `CLIENT_OPS`), its own refusals (`SessionLockedError`, `ImageTakenError`,
 * `PartialUndo`) and the sentences it words them with, and the mark on a
 * frame the agent's tail is not sent (`QUIET`). Tier 0 of the daemon parts
 * (docs/architecture/workspace-session.md): no daemon state; `server.ts`
 * re-exports every name it exported before.
 */

import type { Finding } from "../doctor";
import type { ClientOp, StructureOp } from "../protocol";
import { GoneError, SessionError } from "../session/errors.ts";

/** A dropped image's name is taken: `takenName` is the name it would be written under, which may not be the dropped file's. */
export class ImageTakenError extends SessionError {
  constructor(
    e: SessionError,
    readonly takenName: string,
  ) {
    super(e.message, e.status, e.choices, e.hint);
  }
}

/**
 * Another daemon holds this session's lock (`../wire/daemonLock.ts`): `pid` is
 * that daemon's, which rides the handshake as `locked_by` so `open` can wait
 * for it and name it.
 */
export class SessionLockedError extends SessionError {
  constructor(
    sessionId: string,
    readonly pid: number,
    lockPath: string,
  ) {
    super(
      `session ${sessionId} is already running in another daemon (pid ${pid})`,
      409,
      undefined,
      `use it: state --session ${sessionId}. If no daemon is running, the lock is stale: ${lockPath}`,
    );
  }
}

/**
 * How long a link rewrite is rebased into an open editor's late edits at most
 * (see `linkFollow`): a backstop, since an up-to-date edit ends it sooner.
 */
export const RELINK_FOLLOW_MS = 5000;

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
  "note.reply": { str: ["id"], text: ["body"], optStr: ["doc"] },
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
export const STRUCTURE_OPS = new Set<string>([
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
export const isStructureOp = (m: { op: string }): m is StructureOp => STRUCTURE_OPS.has(m.op);

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
export const WATCH_SETTLE_MS = 60;

/**
 * How long a document's file must stay gone before it is called missing: an
 * atomic save or a quick rename back leaves a gap, and the banner must not flash.
 */
export const MISSING_RECHECK_MS = 400;

/**
 * How long watcher events across the context settle before `context.changed`
 * goes out: a save, a `git checkout` or an export is one frame, not hundreds.
 */
export const CONTEXT_CHANGED_SETTLE_MS = 400;

/**
 * The longest `context.changed` (and the app view's refresh) waits while
 * watcher events keep arriving: a steady trickle never settles.
 */
export const CONTEXT_CHANGED_MAX_WAIT_MS = 2000;

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * An app's undo that changed things and then could not finish (the Trash took
 * one of what the act made and refused the next). It can never be undone as a
 * whole again, so it comes off the list like any gone step, and the chat says
 * what was done.
 */
export class PartialUndo extends GoneError {}

/**
 * The mark on a frame the agent's tail is not sent (`TailRule`). A symbol: the
 * log's spread keeps it on the frame, and `JSON.stringify` leaves it off the wire.
 */
export const QUIET = Symbol("quiet");

/** Findings compared across a save: what each says and how many it counts. */
export const findingsKey = (list: readonly Finding[]): string =>
  list.map((f) => `${f.kind}:${f.count ?? ""}:${f.message}`).join("\n");

/** An undo or redo refused: the reason, and, when it can never succeed, that it is off the list. */
export const historyRefusal = (e: unknown, which: "undo" | "redo" = "undo"): string =>
  e instanceof GoneError ? `${e.message}; it has been taken off the ${which} list.` : messageOf(e);

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
  "fs.same",
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
export const CLIENT_OPS: readonly string[] = [...SURFACE_OPS, ...STRUCTURE_OPS];
