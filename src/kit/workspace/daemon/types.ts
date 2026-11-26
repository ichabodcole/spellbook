/**
 * The daemon's types: what an app passes `createWorkspaceDaemon`
 * (`WorkspaceDaemonOptions`), the daemon it gets back, what a verb, a runner's
 * host or an `http` hook may do (`WorkspaceContext`), how a verb was reached,
 * and a frame on the event log. Tier 0 of the daemon parts
 * (docs/architecture/workspace-session.md); `server.ts` re-exports every name.
 */

import type { FSWatcher } from "node:fs";
import type { ClosedBy, TailRule } from "../events";
import type { AppAct, Follow } from "../history";
import type { LinkSlot } from "../linkEdges";
import type { PickKind } from "../picker";
import type { LinkCheckOptions, Message, MessageAbout, MessageAboutOnTail } from "../protocol";
import type { AppDeclaration, WorkspaceSession } from "../session";
import type { Actor, TaskEngine, TaskRunner } from "../tasks";
import type { TrashFn } from "../trash";

/** A frame on the event log: `type` names the event; the log stamps `id` and `epoch`. */
export type LogEvent = Record<string, unknown> & { type: string };

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
  /**
   * A line in the chat and a `system` event, for a fact the agent must know.
   * `agentText` is the event's sentence when it must differ from the chat's: a
   * document named by its absolute path or slug, not as the sidebar shows it.
   */
  announce(text: string, fact?: Record<string, unknown>, agentText?: string): void;
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
  /**
   * What the app asks of the link check beyond the kit's own
   * (kit-broken-links-visible): `leaving` adds the links and edges that land
   * outside the set they are written in (off by default), and `noun` is the
   * app's word for a set, which the status bar's list uses ("leaving the
   * set"). Without it, `link-check` and the list are the kit's own.
   */
  linkCheck?: LinkCheckOptions;
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
  /**
   * How a folder is watched; absent, `fs.watch`. A test seam: a watch that
   * never reports stands for a change the real one missed (a write just as it
   * armed, or an event a busy fseventsd dropped).
   */
  watch?: (
    path: string,
    options: { recursive: boolean },
    listener: (event: string, name: string | Buffer | null) => void,
  ) => FSWatcher;
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
