// The surface's one connection to the workspace daemon: a WebSocket at `/ws`,
// without React, so it is testable against a real daemon and the hook over it is
// a few lines.
//
// What comes down: a `state` snapshot on connect and after every change, and a
// few frames that answer a request (`version.text`, `diff`, `fs.list`,
// `structure.done`, `link.target`, `link.targets`, `error`). What goes up: `op`
// frames. A frame may carry an `id`, unique on its socket; the daemon echoes it
// as `requestId` on every reply to that frame, which is how `request` can be
// awaited. Broadcasts such as `state` belong to no request and carry none.
//
// Which ops answer at all is the daemon's: `open`, `link.open`, `link.targets`,
// `link.embeds`, `read`, `diff`, `fs.list` and the structure ops reply; `say`, `select`,
// `note.*`, `task.*` and `prefs.set` change state and broadcast it, and reply
// only when they fail.
// So `request` is for the first kind (and an app's own ops, which reply through
// their `reply` callback), `send` is for the rest, and a `request` for an op
// that never replies rejects at its timeout rather than hanging.
//
// A dropped socket reconnects with a doubling delay, so a daemon restart
// (`open --restore`) is picked up without a reload. The daemon sends the state
// as the first frame of every connection, which is the re-sync: nothing is
// replayed and nothing is lost, because the snapshot is the whole truth.

import { isImageName } from "../lib/docFormat.ts";
import type { ClosedBy } from "../workspace/events";
import type {
  ClientOp,
  DiffPayload,
  DocView,
  FsListEntry,
  PublicState,
  ServerOp,
  StateSnapshot,
  StructureOpName,
} from "../workspace/protocol";

/** The heading of a toast for a link that did not open. */
export const LINK_REFUSED = "That link didn't open";

/** The folder a path sits in, as a path. */
const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

/**
 * What the page says when a followed link cannot open, naming the target as
 * written, without its `?rel=` query or `#anchor`; null when it opened (the
 * document showing is the answer). Following never adds to the context, so a
 * target outside it names the folder to add. A target the session holds that
 * still did not open (an image that is a link leading out) says the daemon's why.
 */
export function linkRefusal(f: Extract<ServerOp, { op: "link.target" }>): string | null {
  const written = f.target.split(/[?#]/)[0] || f.target;
  if (f.refused) return f.refused;
  switch (f.state) {
    case "in-context":
      return null;
    case "outside":
      return `${written} is outside this session's context. Add its folder, ${folderOf(f.path)}, to open it here.`;
    case "not-a-doc":
      // An image the tree shows opens in the viewer; one that reaches here is not in a set.
      return isImageName(f.path)
        ? `${written} is an image that no set in this session shows. Add its folder, ${folderOf(f.path)}, to open it here.`
        : `${written} is not a document the workspace opens: ${f.path}.`;
    case "folder":
      return `${written} is a folder, not a document: ${f.path}.`;
    case "missing":
      return f.tried.length === 0
        ? `That link points at ${written}, which names no file here.`
        : `That link points at ${written}, which does not exist: nothing at ${f.tried.join(" or ")}.`;
  }
}

/** What the page says to an act that can no longer reach the daemon. */
export const SESSION_ENDED = "The session has ended";

/**
 * Traffic the page sends on its OWN (a resize persisting the layout, a selection
 * report, a text being loaded, the editor's buffer): after an end it is dropped
 * without a word, because no one asked for it. Anything else is a human's act,
 * and is answered with `SESSION_ENDED` rather than silence.
 */
const AMBIENT = new Set<string>(["prefs.set", "select", "read", "diff", "edit"]);

/**
 * Ops that move a document's text out from under a write still in its pause.
 * `activate` and `version.new` (which may activate the copy, and copies the
 * active text either way) change which version the buffer belongs to; `merge`
 * rewrites the active version's file. Each is sent only after the document's
 * pending write, so the typed text lands in the version it was typed in and
 * the op follows on the same ordered socket. `revert` discards unsaved work by
 * definition, so its document's pending write is dropped instead. A
 * `version.delete` never touches the active version (the daemon refuses to
 * delete it), so a write waiting beside one is left to its timer.
 */
const FLUSH_FIRST = new Set<string>(["activate", "version.new", "merge"]);

/** `ended`: the daemon said it was closing on purpose, so there is nothing to retry. */
export type Connection = "connecting" | "open" | "closed" | "ended";

/** How long typing settles before the buffer is sent: one `edit` per pause, not per key. */
export const EDIT_DEBOUNCE_MS = 250;

/** How long a write the socket could not take waits before it is tried again. */
const EDIT_RETRY_MS = 1000;

/** What a frame's `id` and its reply's `requestId` hold. */
export type RequestId = string | number;

export type Listing = { entries: FsListEntry[]; error?: string };

/** The last structure op THIS viewer sent that landed. `seq` makes a repeat a new value. */
export type Done = {
  of: StructureOpName;
  path: string;
  seq: number;
  /** Made to be named in place but not opened (`bundle.create`'s `stay: "rename"`). */
  stay?: "rename";
};

/** An op the kit does not define: an app's own, named `<app>.<name>`. */
export type AppOp = { op: string } & Record<string, unknown>;

/** A frame from the daemon that is not one the kit defines: an app's own reply. */
export type AppFrame = { op: string; requestId?: string | number } & Record<string, unknown>;

export type ServerFrame = (ServerOp | AppFrame) & { requestId?: string | number };

/** A request the daemon refused, with what it would have accepted, when it said. */
export class DaemonError extends Error {
  constructor(
    message: string,
    readonly choices?: string[],
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

export type DaemonOptions = {
  /** The daemon's WebSocket URL. Default: `/ws` on the page's own origin. */
  url?: string;
  /** The WebSocket constructor. Default: the global one, read when connecting. */
  WebSocket?: typeof WebSocket;
  /** First reconnect delay; it doubles up to `maxDelayMs`. Default 250. */
  minDelayMs?: number;
  /** Reconnect delay ceiling. Default 5000. */
  maxDelayMs?: number;
  /** How long a `request` waits for its reply. Default 10 s. */
  requestTimeoutMs?: number;
};

/** What a surface reads, re-rendering when it changes. */
export type DaemonView = {
  /** The latest snapshot, or null before the first one. */
  state: PublicState | null;
  connection: Connection;
  /** Who ended the session, once the daemon has said; null while it runs. */
  endedBy: ClosedBy | null;
  /** The last refusal that belonged to no request; `clearError` dismisses it. */
  lastError: string | null;
  /**
   * A heading of its own for `lastError`, when the refusal has one (a link that
   * did not open); null for the daemon's ordinary refusals.
   */
  lastErrorTitle: string | null;
  /** Version texts, keyed `doc@version`: loaded on ask, or pushed by a merge. */
  texts: ReadonlyMap<string, string>;
  done: Done | null;
  /** The latest comparison the daemon computed. */
  diff: DiffPayload | null;
};

export type Daemon = DaemonView & {
  /**
   * Send an op without waiting. Returns the `id` it carried, or null when the
   * socket is not open (nothing is queued: a stale act replayed after a
   * reconnect would be a surprise).
   *
   * Every frame carries a fresh `rid`, its request id, which the daemon echoes as
   * `requestId`. An op's own `id` (a task, note or entry) is its subject and is
   * left alone.
   */
  send: (op: ClientOp | AppOp) => RequestId | null;
  /**
   * Send an op and wait for the daemon's reply to it: the first frame carrying
   * this request's id. Rejects with a `DaemonError` when the daemon refuses, or
   * with a plain error when the socket drops or the timeout passes.
   */
  request: (op: ClientOp | AppOp, options?: { timeoutMs?: number }) => Promise<ServerFrame>;
  /** `fs.list`: a directory's entries, or `{ entries: [], error }`. Never rejects. */
  listDir: (path: string) => Promise<Listing>;
  /** Record what THIS viewer typed, so its own copy of the text matches its buffer. */
  noteText: (doc: string, version: number, text: string) => void;
  /**
   * Write a buffer to a document's ACTIVE version, debounced (`EDIT_DEBOUNCE_MS`)
   * per document: the last text written within a pause is the one sent, as an
   * `edit` op, and this viewer's own copy is updated with it. `text` may be a
   * function, read only when the write is sent, so a large buffer is not copied
   * on every keystroke.
   *
   * The surface only ever writes the active version. So a call for a version
   * that is not `doc.active` is declined: it returns false and nothing is sent.
   * A pending write whose version stopped being the active one before it fired
   * (the agent, or another viewer, activated another: this client's own switch
   * sends it first) is sent as soon as this client sees the switch, still
   * naming the version it was typed in, and the daemon saves it there and says
   * so in the chat. A write that cannot be sent because the socket is down is
   * held and retried until the socket opens or another write replaces it.
   */
  writeText: (
    doc: Pick<DocView, "slug" | "active">,
    version: number,
    text: string | (() => string),
  ) => boolean;
  /**
   * Send what is pending now, for one document or every one: before Save, on
   * losing focus, on unmount. `send` and `request` do it on their own before an op
   * the write would otherwise land after (`activate`, `version.new`, `merge`).
   */
  flushText: (doc?: string) => void;
  /**
   * Forget what is pending for a document, unsent: before Revert, which
   * discards unsaved work by definition, so a write still in its pause can
   * never land on top of the reverted text. `send` and `request` do it on
   * their own before a `revert`.
   */
  dropText: (doc: string) => void;
  clearError: () => void;
  /** Listen to every frame, for an app's own (`<app>.<name>`). Returns the unsubscribe. */
  onFrame: (listener: (frame: ServerFrame) => void) => () => void;
  /** `GET /state`: the snapshot plus the log's cursor and epoch. Needs the daemon's origin. */
  fetchSnapshot: (full?: boolean) => Promise<StateSnapshot>;
  /**
   * Where an image the tree shows is served (`GET /fs/file`), or its cached
   * thumbnail (`GET /fs/thumb`) with `thumb`. `stamp` makes a changed file a new
   * URL, so an image replaced under its own name is never shown stale.
   */
  imageUrl: (path: string, opts?: { stamp?: string; thumb?: 256 | 1024 }) => string;
  /**
   * Send a dropped image's bytes to the daemon (`POST /fs/image`), to be written
   * into `dir` as a plain file. Never rejects: a refusal comes back as `error`,
   * and a name already taken (with `onTaken: "ask"`) as `taken`. With `doc` (a
   * markdown document's path), it goes into the `images/` folder beside that
   * document under a free name instead, and the answer carries `href`, the
   * path an embed in the document writes; `how` says whether it was pasted
   * (named by the surface, its extension corrected from its bytes) or dropped.
   */
  importImage: (file: Blob & { name: string }, opts: ImageImportOptions) => Promise<ImageImport>;
};

/** Where an image sent to the daemon goes: see `Daemon.importImage`. */
export type ImageImportOptions = {
  dir?: string;
  onTaken?: "ask" | "keep-both" | "replace";
  doc?: string;
  /** Onto a bundle's own view (a board): into the bundle's `assets/`, under a free name. */
  bundle?: string;
  how?: "paste" | "drop";
  /** The name to write it under, when not the file's own (a paste's dated name). */
  name?: string;
};

/** What became of a dropped image. */
export type ImageImport =
  | {
      ok: true;
      path: string;
      href?: string;
      /** Into a bundle (`bundle`): the path a card writes for it, `./assets/…`. */
      card?: string;
      replaced?: boolean;
      converted?: boolean;
      /** The image import settings would have converted it, and left it as it came (see `note`). */
      kept?: boolean;
      /** What the image import settings did to it, or why they left it as it came. */
      note?: string;
    }
  | {
      ok: false;
      error: string;
      taken?: boolean;
      /** The name that is taken: the one it would be written under (`photo.webp` for a converted `photo.jpg`). */
      takenName?: string;
    };

export type DaemonClient = {
  subscribe: (listener: () => void) => () => void;
  /** The same object until something changes. */
  getSnapshot: () => Daemon;
  /** Open the socket (idempotent); reconnects on its own until `close`. */
  connect: () => void;
  /** Close for good: no reconnect, pending requests rejected. */
  close: () => void;
};

export const textKey = (doc: string, version: number) => `${doc}@${version}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function createDaemonClient(options: DaemonOptions = {}): DaemonClient {
  const minDelay = options.minDelayMs ?? 250;
  const maxDelay = options.maxDelayMs ?? 5000;
  const timeoutMs = options.requestTimeoutMs ?? 10_000;
  const listeners = new Set<() => void>();
  const frameListeners = new Set<(frame: ServerFrame) => void>();

  let view: DaemonView = {
    state: null,
    connection: "connecting",
    endedBy: null,
    lastError: null,
    lastErrorTitle: null,
    texts: new Map(),
    done: null,
    diff: null,
  };
  let socket: WebSocket | null = null;
  let stopped = true;
  let delay = minDelay;
  /** The next open is a reconnect, not the first connection. */
  let reconnecting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Unique on a socket; one counter for the client's life is unique on every socket.
  let nextId = 1;
  const pending = new Map<
    RequestId,
    {
      resolve: (frame: ServerFrame) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const origin = () => {
    const base = options.url ? new URL(options.url) : new URL(globalThis.location.href);
    base.protocol = base.protocol === "https:" || base.protocol === "wss:" ? "https:" : "http:";
    return base;
  };

  let snapshot: Daemon;
  const build = (): Daemon => ({
    ...view,
    send,
    request,
    listDir,
    noteText,
    writeText,
    flushText,
    dropText,
    clearError,
    onFrame,
    fetchSnapshot,
    imageUrl,
    importImage,
  });
  const set = (patch: Partial<DaemonView>) => {
    view = { ...view, ...patch };
    snapshot = build();
    for (const l of [...listeners]) l();
  };

  const settle = (id: RequestId) => {
    const p = pending.get(id);
    if (p) clearTimeout(p.timer);
    pending.delete(id);
    return p;
  };
  const failAll = (reason: string) => {
    for (const id of [...pending.keys()]) settle(id)?.reject(new Error(reason));
  };

  /** The frame to send and the request id it will be answered on. */
  function framed(op: ClientOp | AppOp): { id: RequestId; text: string } {
    const id = nextId++;
    return { id, text: JSON.stringify({ ...op, rid: id }) };
  }

  /**
   * Settle the pending write an op would overtake (see `FLUSH_FIRST`): sent
   * now, ahead of the op, or dropped before a revert. An op naming no document
   * (a `merge` on the selected one) settles every document's.
   */
  function beforeSending(op: ClientOp | AppOp) {
    const doc = "doc" in op && typeof op.doc === "string" ? op.doc : undefined;
    if (FLUSH_FIRST.has(op.op)) flushText(doc);
    else if (op.op === "revert" && doc !== undefined) dropText(doc);
  }

  function send(op: ClientOp | AppOp): RequestId | null {
    if (view.endedBy) {
      if (!AMBIENT.has(op.op)) set({ lastError: SESSION_ENDED, lastErrorTitle: null });
      return null;
    }
    const ws = socket;
    if (ws?.readyState !== 1) return null;
    beforeSending(op);
    const { id, text } = framed(op);
    ws.send(text);
    return id;
  }

  function request(op: ClientOp | AppOp, o: { timeoutMs?: number } = {}): Promise<ServerFrame> {
    return new Promise<ServerFrame>((resolve, reject) => {
      if (view.endedBy) {
        reject(new Error(SESSION_ENDED));
        return;
      }
      const ws = socket;
      if (ws?.readyState !== 1) {
        reject(new Error("disconnected"));
        return;
      }
      beforeSending(op);
      const { id, text } = framed(op);
      const ms = o.timeoutMs ?? timeoutMs;
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no reply to ${op.op} within ${ms} ms`));
      }, ms);
      pending.set(id, { resolve, reject, timer: t });
      ws.send(text);
    });
  }

  async function listDir(path: string): Promise<Listing> {
    try {
      const frame = await request({ op: "fs.list", path });
      if (frame.op !== "fs.list") return { entries: [], error: "unexpected reply" };
      const f = frame as Extract<ServerOp, { op: "fs.list" }>;
      return { entries: f.entries, ...(f.error ? { error: f.error } : {}) };
    } catch (e) {
      return { entries: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  function noteText(doc: string, version: number, text: string) {
    const key = textKey(doc, version);
    if (view.texts.get(key) === text) return;
    const next = new Map(view.texts);
    next.set(key, text);
    set({ texts: next });
  }

  /** The newest daemon-rewritten text taken per document (`version.text`'s `rev`), sent as an edit's `base`. */
  const seenRev = new Map<string, number>();

  /** Writes waiting out their pause, by document slug. */
  const writes = new Map<
    string,
    { version: number; text: string | (() => string); timer: ReturnType<typeof setTimeout> }
  >();

  /** Send one pending write now. Returns false when it could not go yet (the socket is down). */
  function fireWrite(slug: string): boolean {
    const w = writes.get(slug);
    if (!w) return true;
    clearTimeout(w.timer);
    // Nothing is written after an end, and nothing is retried.
    if (view.endedBy) {
      writes.delete(slug);
      return true;
    }
    const doc = view.state?.docs.find((d) => d.slug === slug);
    if (!doc) {
      writes.delete(slug);
      return true;
    }
    // A version that stopped being the active one is still written: the agent
    // (or another viewer) switched while the edit waited, and the daemon saves
    // it to the version it was typed in, or keeps it as one of its own.
    const text = typeof w.text === "function" ? w.text() : w.text;
    const base = seenRev.get(slug);
    if (
      send({
        op: "edit",
        doc: slug,
        version: w.version,
        text,
        ...(base !== undefined ? { base } : {}),
      }) === null
    ) {
      w.timer = setTimeout(() => fireWrite(slug), EDIT_RETRY_MS);
      return false;
    }
    writes.delete(slug);
    noteText(slug, w.version, text);
    return true;
  }

  function writeText(
    doc: Pick<DocView, "slug" | "active">,
    version: number,
    text: string | (() => string),
  ): boolean {
    if (version !== doc.active || view.endedBy) return false;
    const was = writes.get(doc.slug);
    if (was) clearTimeout(was.timer);
    writes.set(doc.slug, {
      version,
      text,
      timer: setTimeout(() => fireWrite(doc.slug), EDIT_DEBOUNCE_MS),
    });
    // Typed on a render from before a switch this client has already seen: the
    // buffer is about to be given the new version's text, so it is read and sent
    // now, while it still holds what was typed.
    const known = view.state?.docs.find((d) => d.slug === doc.slug);
    if (known && known.active !== version) fireWrite(doc.slug);
    return true;
  }

  function flushText(doc?: string) {
    for (const slug of doc === undefined ? [...writes.keys()] : [doc]) fireWrite(slug);
  }

  function dropText(doc: string) {
    const w = writes.get(doc);
    if (!w) return;
    clearTimeout(w.timer);
    writes.delete(doc);
  }

  function clearError() {
    if (view.lastError !== null) set({ lastError: null, lastErrorTitle: null });
  }

  function onFrame(listener: (frame: ServerFrame) => void) {
    frameListeners.add(listener);
    return () => frameListeners.delete(listener);
  }

  async function fetchSnapshot(full = false): Promise<StateSnapshot> {
    const url = origin();
    url.pathname = "/state";
    url.search = full ? "?full=1" : "";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET /state answered ${res.status}`);
    return (await res.json()) as StateSnapshot;
  }

  function imageUrl(path: string, opts: { stamp?: string; thumb?: 256 | 1024 } = {}): string {
    const url = origin();
    url.pathname = opts.thumb ? "/fs/thumb" : "/fs/file";
    const q = new URLSearchParams({ path });
    if (opts.thumb) q.set("w", String(opts.thumb));
    if (opts.stamp) q.set("v", opts.stamp);
    url.search = `?${q}`;
    return url.toString();
  }

  async function importImage(
    file: Blob & { name: string },
    opts: ImageImportOptions,
  ): Promise<ImageImport> {
    const url = origin();
    url.pathname = "/fs/image";
    const q = new URLSearchParams({ name: opts.name ?? file.name, onTaken: opts.onTaken ?? "ask" });
    if (opts.dir) q.set("dir", opts.dir);
    if (opts.doc) q.set("doc", opts.doc);
    if (opts.bundle) q.set("bundle", opts.bundle);
    if (opts.how) q.set("how", opts.how);
    url.search = `?${q}`;
    try {
      const res = await fetch(url, { method: "POST", body: file });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        choices?: string[];
        name?: string;
        path?: string;
        href?: string;
        card?: string;
        replaced?: boolean;
        converted?: boolean;
        kept?: boolean;
        note?: string;
      };
      if (res.ok && body.ok && typeof body.path === "string")
        return {
          ok: true,
          path: body.path,
          ...(typeof body.href === "string" ? { href: body.href } : {}),
          ...(typeof body.card === "string" ? { card: body.card } : {}),
          ...(body.replaced ? { replaced: true } : {}),
          ...(body.converted ? { converted: true } : {}),
          ...(body.kept ? { kept: true } : {}),
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        };
      return {
        ok: false,
        error: body.error ?? `the workspace answered ${res.status}`,
        ...(res.status === 409 && body.choices?.includes("replace")
          ? { taken: true, ...(typeof body.name === "string" ? { takenName: body.name } : {}) }
          : {}),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  const onMessage = (raw: unknown) => {
    let frame: ServerFrame;
    try {
      const parsed = JSON.parse(String(raw));
      if (!isObject(parsed) || typeof parsed.op !== "string") return;
      frame = parsed as ServerFrame;
    } catch {
      return;
    }
    const rid = frame.requestId;
    const waiting = rid !== undefined ? pending.get(rid) : undefined;
    if (waiting && rid !== undefined) {
      settle(rid);
      if (frame.op === "error") {
        const e = frame as Extract<ServerOp, { op: "error" }>;
        waiting.reject(new DaemonError(e.message, e.choices));
      } else waiting.resolve(frame);
    }
    switch (frame.op) {
      case "state": {
        const next = (frame as Extract<ServerOp, { op: "state" }>).state;
        // A write waiting for a version this state no longer has active (the
        // agent switched, and this client could not send it first as it does
        // before its own switch): sent now, before the surface hears of the
        // switch and gives the buffer the new version's text, which a lazy
        // write would otherwise read into the old version.
        if (view.state?.sessionId === next.sessionId)
          for (const [slug, w] of [...writes]) {
            const d = next.docs.find((x) => x.slug === slug);
            if (d && d.active !== w.version) fireWrite(slug);
          }
        // What was loaded belongs to the session it came from: a different one
        // (the daemon restarted into a new session) must not show the old texts.
        if (view.state && view.state.sessionId !== next.sessionId) {
          seenRev.clear();
          set({ state: next, texts: new Map(), diff: null });
        } else set({ state: next });
        break;
      }
      case "closed":
        // The daemon is closing on purpose: the socket that follows is an end,
        // not a drop to retry.
        set({ endedBy: (frame as Extract<ServerOp, { op: "closed" }>).by });
        // What was waiting to be written will never be.
        for (const w of writes.values()) clearTimeout(w.timer);
        writes.clear();
        break;
      case "error":
        // A refusal that answers a request is that request's to show.
        if (!waiting)
          set({
            lastError: (frame as Extract<ServerOp, { op: "error" }>).message,
            lastErrorTitle: null,
          });
        break;
      case "version.text": {
        const f = frame as Extract<ServerOp, { op: "version.text" }>;
        // A write is waiting for this very version: this frame's text is older than
        // the buffer it would replace, and the write will say what is current.
        if (writes.get(f.doc)?.version === f.version) break;
        // Taken: the next edit is typed over this text (see the daemon's `linkFollow`).
        if (f.rev !== undefined) seenRev.set(f.doc, Math.max(seenRev.get(f.doc) ?? 0, f.rev));
        noteText(f.doc, f.version, f.text);
        break;
      }
      case "diff": {
        const {
          op: _op,
          requestId: _rid,
          ...payload
        } = frame as Extract<ServerOp, { op: "diff" }> & {
          requestId?: string | number;
        };
        set({ diff: payload });
        break;
      }
      case "link.target": {
        const said = linkRefusal(frame as Extract<ServerOp, { op: "link.target" }>);
        if (said && !waiting) set({ lastError: said, lastErrorTitle: LINK_REFUSED });
        break;
      }
      case "structure.done": {
        const f = frame as Extract<ServerOp, { op: "structure.done" }>;
        // A maker that stays where it is (a board promoting a sticky): the new
        // document is not opened or renamed, so `done` does not hear of it.
        if (f.stay === true) break;
        set({
          done: {
            of: f.of,
            path: f.path,
            seq: (view.done?.seq ?? 0) + 1,
            ...(f.stay === "rename" ? { stay: "rename" as const } : {}),
          },
        });
        break;
      }
    }
    for (const l of [...frameListeners]) l(frame);
  };

  const open = () => {
    const Ctor = options.WebSocket ?? globalThis.WebSocket;
    const url = origin();
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.search = "";
    const ws = new Ctor(url.toString());
    socket = ws;
    if (view.connection !== "connecting") set({ connection: "connecting" });
    ws.onopen = () => {
      if (socket !== ws) return;
      delay = minDelay;
      // A reconnect may land on a daemon whose files changed while the socket was
      // down, so what was loaded is dropped and asked for again.
      // The daemon there may be a new one, counting rewritten texts from 1 again.
      if (reconnecting) {
        seenRev.clear();
        set({ connection: "open", texts: new Map(), diff: null });
      } else set({ connection: "open" });
      reconnecting = false;
      // A write the socket could not take goes out NOW, before the surface asks to
      // re-read the text it just lost: the daemon handles frames in order, so the
      // read's reply then carries the edit and cannot overwrite the buffer with the
      // pre-edit text.
      for (const slug of [...writes.keys()]) fireWrite(slug);
    };
    ws.onmessage = (ev) => {
      if (socket === ws) onMessage(ev.data);
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      failAll("disconnected");
      if (view.endedBy) {
        set({ connection: "ended" });
        return;
      }
      set({ connection: "closed" });
      if (stopped) return;
      reconnecting = true;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, maxDelay);
    };
  };

  snapshot = build();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    connect() {
      if (!stopped) return;
      stopped = false;
      reconnecting = false;
      delay = minDelay;
      open();
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const w of writes.values()) clearTimeout(w.timer);
      writes.clear();
      const ws = socket;
      socket = null;
      failAll("closed");
      ws?.close();
      if (view.connection !== "closed") set({ connection: "closed" });
    },
  };
}
