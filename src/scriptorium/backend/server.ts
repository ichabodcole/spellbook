/**
 * scriptorium's per-session daemon — the process the surface talks to over a
 * WebSocket and the CLI talks to over HTTP. Launched by
 * `plugins/spellbook/skills/scriptorium/scripts/server.ts` (the launcher), which
 * imports the BUILT `dist/server.js`.
 *
 * ── THE EIGHT QUESTIONS (scaffolding playbook N1), ANSWERED AS DESIGN ──────
 *
 * 1. Arithmetic: `SKILL_ROOT`/`DIST_DIR` only, for the kit's `resolveMode` and
 *    `serveFromDist`, and true at the EMITTED address (`dist/server.js`, whose
 *    `..` is the skill folder). Nothing else is pinned off `import.meta`.
 * 2. Serves: YES. `/` is the built `index.html` via `serveFromDist`, no
 *    substitution; the only routes of its own are `/state`, `/cmd`, `/events`,
 *    `/ws` and `/fs/*` (read-only: a version's text, a directory listing).
 * 3. Second half: YES — `cli.ts`; the two share `./heartbeat.ts`.
 * 4. Lifecycle: long-running, one daemon per session, idle-timeout like
 *    glamour (linger after the last subscriber leaves; exit 124).
 * 5. `main()` returns while the process must live? NO — `main` awaits the
 *    session's end and its own drain, exactly as glamour's server does, so the
 *    launcher is TERMINAL-EXIT (`process.exit(await run())`): once `main`
 *    resolves nothing may keep the process alive, and a watcher handle or a
 *    straggling socket would. Driven, not read (see the slice-A journal).
 * 6. Event ids recovered across restart? NO — the log is in memory and ids
 *    restart at 1, even under `--restore` (which restores the MANIFEST, not the
 *    log). So the log is stamped with a per-boot EPOCH (mind-mapper's shape)
 *    and the tail resets its cursor when the epoch changes.
 * 7. A kit subject in a different shape? No — the shape was chosen to be the
 *    kit's.
 * 8. A kit module names this spell as its source? Structurally NO: scriptorium
 *    is the first spell scaffolded after the convergence.
 *
 * ── KIT VERDICTS (playbook N4) ─────────────────────────────────────────────
 *
 * errors SUBJECT (the CLI; the daemon answers HTTP statuses the CLI maps) ·
 * serveDist SUBJECT (`resolveMode`, `serveFromDist`) · housekeeping SUBJECT, all
 * three exports (`shouldIdleClose` via `startHousekeeping`'s idle-close, the
 * snapshot sweep — here the manifest is written on every change instead, so the
 * sweep's snapshot hook is deliberately NOT passed — and `drainAndStop`) ·
 * tailEvents SUBJECT (the CLI's `tail`) · heartbeat SUBJECT (`./heartbeat.ts`) ·
 * discovery SUBJECT (session-JSON, E13: `scriptorium-<id>.json` +
 * `scriptorium-latest.json` in tmpdir via `writeFileAtomic`/`unlinkIfMatches`) ·
 * eventLog SUBJECT, WITH EPOCH (Q6) · sse SUBJECT (`GET /events`) ·
 * lib/printJson SUBJECT (the CLI speaks the agent wire).
 *
 * ── TEARDOWN ORDER (register A6), STATED ───────────────────────────────────
 *
 * glamour's order: stop housekeeping → close the watchers → persist the
 * manifest → unlink discovery → emit `closed` → drain. Discovery goes BEFORE the
 * `closed` frame so a tail that sees `closed` and a CLI verb that runs right
 * after it both find no pointer to a daemon that is leaving; the other order
 * leaves a window in which a verb resolves a session that will refuse it.
 */

import { existsSync, type FSWatcher, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";
import { createEventLog } from "../../kit/wire/eventLog.ts";
import { drainAndStop, startHousekeeping } from "../../kit/wire/housekeeping.ts";
import { refuseForeignOrigin } from "../../kit/wire/origin.ts";
import { resolveMode as resolveModeIn, serveFromDist } from "../../kit/wire/serveDist.ts";
import { type SseClients, sseResponse } from "../../kit/wire/sse.ts";
import { quoteLabel } from "./anchors";
import { unified } from "./diff";
import { summary } from "./doctor";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat";
import { type Act, type After, type Before, History, type Inverse, planInverse } from "./history";
import { type PickKind, parsePickerOutput, pickerCommand, wasCancelled } from "./picker";
import type {
  AgentCmd,
  ClientMsg,
  PublicState,
  Selection,
  ServerMsg,
  StructureOp,
} from "./protocol";
import { type FileEvent, Session, SessionError, sideName } from "./session";
import { listDir, PathError } from "./tree";
import { DEFAULT_SNOOZE_MS, noteEventFacts, notesWaiting, waitingOn } from "./waiting";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

/** release iff `dist/index.html` exists at the skill root; the env var overrides (Contract 1). */
export function resolveMode(): "dev" | "release" {
  return resolveModeIn(DIST_DIR);
}

function serveDist(path: string): Response | null {
  return serveFromDist(DIST_DIR, path === "/" ? "index.html" : path.slice(1));
}

/** `$SCRIPTORIUM_HOME`, default `~/.scriptorium`. `prompts.json` beside `sessions/` is slice B's (E9). */
export function scriptoriumHome(): string {
  return resolve(process.env.SCRIPTORIUM_HOME ?? join(homedir(), ".scriptorium"));
}

export type StartOpts = {
  port?: number;
  restore?: string;
  timeoutS?: number;
  /** E23: a NEW session's workspace — the directory `open` ran in. A restore keeps its own. */
  workspace?: string;
};

/** A tail frame's payload. The log stamps `id` and `epoch`. */
type LogEvent = Record<string, unknown> & { type: string };

/** How long a burst of watcher events on one path settles before it is read. */
const WATCH_SETTLE_MS = 60;

export async function startDaemon(opts: StartOpts) {
  const home = scriptoriumHome();
  // Mode BEFORE any write: a forced-dev boot at a surface-free destination must
  // die at the import having created nothing (glamour's measured order).
  const mode = resolveMode();
  const devIndex =
    mode === "dev"
      ? (await import("../../../../../src/scriptorium/surface/index.html")).default
      : undefined;
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;

  const session = opts.restore
    ? Session.restore(home, opts.restore)
    : Session.create(home, undefined, opts.workspace);
  const sessionId = session.id;
  let selection: Selection | null = null;

  // --- prefs: per-viewer conveniences that outlive a session's port ------------
  // Browser storage is keyed by origin, port included, and every session gets a
  // new port — so a pane size kept in localStorage resets at the next `open`.
  // They live in the home instead, shared by every session of this home.
  const prefsFile = join(home, "prefs.json");
  const PREF_KEY = /^[a-z][a-z0-9:._-]{0,63}$/;
  const PREF_VALUE_MAX = 4096;
  const PREF_KEYS_MAX = 64;
  /**
   * Read the home's prefs FRESH. Several sessions can share one home (E13), each
   * its own daemon, so a copy loaded once at boot and written back whole would
   * erase a key another session wrote since (verify pass). Every write is
   * therefore read → set one key → write, and every snapshot reads the file.
   * Only well-formed entries survive a read; a bad file reads as empty and is
   * replaced by the next write.
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
      /* no prefs yet, or unreadable — empty */
    }
    return out;
  };
  const userHome = homedir();
  /**
   * E53: the snooze the agent asked for, and the messages already nudged.
   *
   * ⛔ ONE NUDGE PER MESSAGE, AND THAT IS THE WHOLE ANTI-NAG RULE. Cole: "we
   * don't want to have a situation where an agent keeps getting pinged about
   * something and it's like, no, I'm actually working." So a message id enters
   * `nudged` the first time it is reported — or the moment the agent snoozes it
   * — and never leaves. A snooze EXPIRING therefore changes what the HUMAN
   * sees (back to "may be stuck", because they are owed the truth) without
   * pinging the agent again.
   *
   * ⚠ IN MEMORY, NOT IN THE MANIFEST, deliberately. A restored session whose
   * human was left waiting SHOULD tell the agent that arrives — the wait is
   * real and the new agent has not heard about it.
   */
  let acknowledgedUntil: number | undefined;
  const nudged = new Set<string>();
  /**
   * E60: the CONTEXT's undo history — not the editor's, which CodeMirror owns.
   * In memory on purpose (see `history.ts`): an inverse describes the world as
   * it is now, and a session restored tomorrow may meet files somebody has
   * since moved by hand.
   */
  const history = new History();

  const viewState = (): PublicState => {
    const base = { ...session.view(mode, selection), prefs: readPrefs(), userHome };
    const now = Date.now();
    return {
      ...base,
      waiting: waitingOn(base.chat, now, { acknowledgedUntil }),
      notesWaiting: notesWaiting(session.noteFacts(), base.chat, now, { acknowledgedUntil }),
      history: history.view(),
    };
  };

  // --- channels ---------------------------------------------------------------
  const sockets = new Set<import("bun").ServerWebSocket<unknown>>();
  const log = createEventLog<LogEvent>({ epoch: crypto.randomUUID() });
  const sseClients: SseClients = new Set();
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  const send = (msg: ServerMsg) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* socket closed */
      }
    }
  };
  const broadcastState = () => send({ type: "state", state: viewState() });

  /** A system line in the chat — and, because the agent must know it too, on the tail. */
  const announce = (text: string, fact: Record<string, unknown> = {}) => {
    const m = session.addMessage("system", text);
    log.emit({ type: "system", text, ts: m.ts, ...fact });
    broadcastState();
  };

  // --- the watcher --------------------------------------------------------------
  //
  // ⚠ DEVIATION FROM THE BRIEF, WITH ITS REASON: `node:fs` `watch` (Bun's
  // built-in), NOT `@parcel/watcher`. `@parcel/watcher` is a native addon whose
  // loader does a runtime `require()` of a per-platform package; bundled into
  // `dist/server.js` it is not inlined, so the shipped daemon would need a
  // `node_modules` the marketplace never copies (import-boundary ward 1b's
  // "the shipped execution path carries no dependencies"). Measured under Bun
  // 1.4.0 on macOS before choosing: a recursive directory watch reports an
  // in-place write, an atomic tmp+rename save, and both again in a
  // subdirectory — the four cases investigation §5 drove @parcel/watcher on.
  // The hash-compare and self-write suppression are unchanged (session.ts).
  const watchers = new Map<string, FSWatcher>();
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const onFs = (abs: string) => {
    const t = pending.get(abs);
    if (t) clearTimeout(t);
    pending.set(
      abs,
      setTimeout(() => {
        pending.delete(abs);
        let ev: FileEvent | null = null;
        try {
          ev = session.onFileEvent(abs);
        } catch (e) {
          process.stderr.write(`scriptorium: watcher: ${e}\n`);
        }
        if (ev) handleFileEvent(ev);
      }, WATCH_SETTLE_MS),
    );
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
        // Watched at the REALPATH, reported under the stored path form
        // (verify-pass fix 3 — see Session.watchRoots).
        const w = watch(r.watch, { recursive: r.recursive }, (_event, name) => {
          if (name) onFs(join(r.path, name.toString()));
          else if (r.entryId) onFs(r.path);
        });
        w.on("error", () => {
          /* the directory went away; the next sync drops it */
        });
        watchers.set(key, w);
      } catch {
        /* unwatchable (gone, permissions) — outside changes there go unseen */
      }
    }
  };

  const handleFileEvent = (ev: FileEvent) => {
    switch (ev.kind) {
      case "version.changed":
        send({
          type: "version.text",
          doc: ev.doc,
          version: ev.version,
          text: ev.text,
          origin: "remote",
        });
        broadcastState();
        return;
      case "version.created":
        announce(`v${ev.version} of ${ev.doc} appeared (written directly to ${ev.path})`, {
          fact: "version.created",
          doc: ev.doc,
          version: ev.version,
        });
        return;
      case "active.outside":
        // E2: the agent never writes the version the human is editing. The
        // outside text is KEPT as a new agent version and the active version
        // keeps the human's text — nothing is lost, and the human's buffer is
        // not touched (verify-pass fix 4).
        announceOutside(ev.doc, ev.version, ev.path, ev.preservedAs, ev.preservedPath);
        return;
      case "original.reloaded":
        send({
          type: "version.text",
          doc: ev.doc,
          version: ev.version,
          text: ev.text,
          origin: "remote",
        });
        announce(`${ev.original} changed on disk — reloaded (you had no unsaved edits).`, {
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
      case "tree":
        broadcastState();
        return;
    }
  };

  const announceOutside = (
    doc: string,
    version: number,
    path: string,
    preservedAs: number,
    preservedPath: string,
  ) =>
    announce(
      `v${version} of ${doc} is the ACTIVE version and was written from outside the editor. That text is kept as v${preservedAs}; the active version keeps your text. Agent edits belong in a new version (version-new).`,
      { fact: "active.outside", doc, version, path, preservedAs, preservedPath },
    );

  // --- shared acts (surface and agent reach the same code) ---------------------
  const addPaths = (paths: string[]) => {
    const added = paths.map((p) => session.addContext(p));
    syncWatchers();
    broadcastState();
    return added;
  };

  const activate = (doc: string | undefined, version: number, by: "human" | "agent") => {
    const r = session.activate({ doc, version });
    const view = session.doc(r.slug);
    const path = view.versions.find((v) => v.n === version)?.path ?? null;
    send({
      type: "version.text",
      doc: r.slug,
      version,
      text: session.readVersion(r.slug, version).text,
      origin: "load",
    });
    const m = session.addMessage(
      "system",
      `${by === "agent" ? "Agent" : "You"} made v${version} of ${r.slug} active (was v${r.previous}).`,
    );
    log.emit({ type: "activated", by, doc: r.slug, version, previous: r.previous, path, ts: m.ts });
    broadcastState();
    return { doc: r.slug, version, previous: r.previous, path };
  };

  /**
   * E24: one structure change, from either party — the same session method, the
   * same announcement (naming who did it), the same tail fact. Returns the path
   * the change landed at, which the surface uses to open or rename it.
   */
  const STRUCTURE_OPS = new Set<string>([
    "doc.create",
    "folder.create",
    "move",
    "rename",
    "hide",
    "unhide",
    "set.make",
    "import",
    "workspace.set",
  ] satisfies StructureOp["type"][]);
  const isStructureOp = (m: { type: string }): m is StructureOp => STRUCTURE_OPS.has(m.type);

  const structure = (op: StructureOp, by: "human" | "agent"): Record<string, unknown> => {
    const who = by === "agent" ? "Agent" : "You";
    // ⛔ CAPTURED BEFORE THE ACT, because every field here is something the act
    // CHANGES: reading an entry's hidden list afterwards returns the list
    // including what was just hidden, which restores nothing (E60).
    const before: Before = {
      ...(op.type === "hide" ? { hidden: session.hiddenBefore(op.path) ?? undefined } : {}),
      ...(op.type === "unhide" ? { hidden: session.hiddenOfEntry(op.entry) ?? undefined } : {}),
      ...(op.type === "workspace.set" ? { workspace: session.workspace } : {}),
    };
    const shown = (p: string) => session.display(p);
    let r: Record<string, unknown> & { path?: string };
    let line: string;
    switch (op.type) {
      case "doc.create":
        r = session.createDoc(op.dir, op.name);
        line = `${who} created ${shown(r.path as string)}.`;
        break;
      case "folder.create":
        r = session.createFolder(op.dir, op.name);
        line = `${who} created the folder ${shown(r.path as string)}.`;
        break;
      case "move": {
        const m = session.move(op.path, op.into);
        r = m;
        line = `${who} moved ${shown(m.from)} to ${shown(m.path)}.`;
        break;
      }
      case "rename": {
        const m = session.rename(op.path, op.name);
        r = m;
        line = `${who} renamed ${shown(m.from)} to ${shown(m.path)}.`;
        break;
      }
      case "hide": {
        const h = session.hide(op.path);
        r = h;
        // ⚠ THE PARENTHETICAL HAS TO BE TRUE. It said "(the file is still on
        // disk)" unconditionally, which is wrong twice over on a GHOST — an
        // entry whose file is already gone — and calls a folder a file. Cole
        // met both in one go while clearing residue from the E60 bug, and a
        // reassurance that is false is worse than no reassurance: it is the
        // same defect as the conflict banner claiming edits he had not made.
        const gone = !existsSync(h.path);
        const kind = gone ? "" : statSync(h.path).isDirectory() ? "folder" : "file";
        line = gone
          ? `${who} removed ${shown(h.path)} from Scriptorium (it was already gone from disk).`
          : `${who} removed ${shown(h.path)} from Scriptorium (the ${kind} is still on disk).`;
        break;
      }
      case "unhide": {
        const u = session.unhide(op.entry);
        r = u;
        line = `${who} brought back ${u.restored} hidden item${u.restored === 1 ? "" : "s"}.`;
        break;
      }
      case "set.make": {
        const m = session.makeSet(op.path);
        r = m;
        line = `${who} turned ${basename(m.path)} into a set: ${shown(m.folder)}.`;
        break;
      }
      case "import":
        r = session.importText(op.name, op.text, op.into);
        line = `${who} copied ${op.name} in as ${shown(r.path as string)}.`;
        break;
      case "workspace.set":
        r = session.setWorkspace(op.path);
        line = `${who} set the workspace to ${shown(r.path as string)}.`;
        break;
    }
    syncWatchers();
    // The way back, planned now and from what was true now.
    history.did(planInverse(op, r as After, before));
    announce(line, { fact: op.type, by, ...r });
    broadcastState();
    return r;
  };

  /**
   * Apply one recorded inverse, and return the act that would reverse THAT —
   * which is what goes onto the other stack.
   *
   * ⛔ A DELETE HAS NO WAY BACK, and says so by returning null. Once a created
   * file is gone its contents are gone with it, so a redo that "re-creates" it
   * would hand back an empty file wearing the same name — the kind of lie an
   * undo stack must not tell. Confirmed deletions are therefore one-way, which
   * is also why they are confirmed.
   */
  const applyInverse = (inv: Inverse): Act | null => {
    switch (inv.kind) {
      case "move": {
        const m = session.move(inv.path, inv.into);
        return {
          label: `moved ${basename(m.from)} back into ${basename(dirname(m.path))}`,
          inverse: { kind: "move", path: m.path, into: dirname(m.from) },
        };
      }
      case "rename": {
        const m = session.rename(inv.path, inv.name);
        return {
          label: `renamed ${basename(m.from)} back to ${basename(m.path)}`,
          inverse: { kind: "rename", path: m.path, name: basename(m.from) },
        };
      }
      case "hidden": {
        const r = session.restoreHidden(inv.entry, inv.rels);
        return {
          label: r.was.length > inv.rels.length ? "brought items back" : "hid items again",
          inverse: { kind: "hidden", entry: r.entry, rels: r.was },
        };
      }
      case "context.add": {
        const { entry } = session.addContext(inv.path);
        return {
          label: `put ${basename(inv.path)} back in the context`,
          inverse: { kind: "context.remove", entry: entry.id },
        };
      }
      case "context.remove": {
        const path = session.entryRoot(inv.entry);
        session.removeContext(inv.entry);
        return path === null
          ? null
          : {
              label: `took ${basename(path)} back out of the context`,
              inverse: { kind: "context.add", path },
            };
      }
      case "workspace": {
        const was = session.workspace;
        session.setWorkspace(inv.path);
        return {
          label: `set the workspace back to ${basename(inv.path)}`,
          inverse: { kind: "workspace", path: was },
        };
      }
      case "delete": {
        session.removeCreated(inv.path, inv.dir);
        return null;
      }
    }
  };

  // --- surface messages (WebSocket) --------------------------------------------
  const reply = (ws: import("bun").ServerWebSocket<unknown>, msg: ServerMsg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* gone */
    }
  };

  const handleClientMsg = (ws: import("bun").ServerWebSocket<unknown>, msg: ClientMsg) => {
    if (isStructureOp(msg)) {
      const r = structure(anchorSurfacePaths(msg), "human");
      if (typeof r.path === "string")
        reply(ws, { type: "structure.done", op: msg.type, path: r.path });
      return;
    }
    switch (msg.type) {
      case "open": {
        const r = session.openPath(msg.path);
        syncWatchers();
        broadcastState();
        // The opener gets the active version's text straight away — the state
        // snapshot carries no texts, and a viewer must not wait on a second ask.
        {
          const d = session.doc(r.slug);
          reply(ws, {
            type: "version.text",
            doc: r.slug,
            version: d.active,
            text: session.readVersion(r.slug, d.active).text,
            origin: "load",
          });
        }
        if (r.created)
          log.emit({ type: "doc.opened", doc: r.slug, path: session.activePath(r.slug) });
        return;
      }
      case "open.doc":
        session.openSlug(msg.doc);
        broadcastState();
        return;
      case "edit": {
        const r = session.edit(msg.doc, msg.version, msg.text);
        if (r.preserved) {
          const d = session.doc(msg.doc);
          announceOutside(
            d.slug,
            msg.version,
            session.activePath(d.slug) ?? "",
            r.preserved.n,
            r.preserved.path,
          );
        } else if (r.dirtyChanged) broadcastState();
        return;
      }
      case "search": {
        // ⛔ REPLIED TO THE ASKING SOCKET, NOT BROADCAST. A search is one
        // viewer's question; pushing results to every client would put someone
        // else's query in your pane. (The same reason `diff` replies rather
        // than broadcasting.)
        try {
          reply(ws, { type: "search.results", report: session.searchAll(msg) });
        } catch (e) {
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "history.undo": {
        const act = history.peekUndo();
        if (!act) return;
        // ⛔ A DELETING UNDO NEEDS THE HUMAN'S WORD, carried explicitly. A
        // client that simply omits the flag gets a refusal rather than a
        // deletion, so "forgot to confirm" can never become "deleted anyway".
        if (act.inverse.kind === "delete" && msg.confirmDelete !== true) {
          reply(ws, {
            type: "error",
            message: `Undoing "${act.label}" would delete ${session.display(act.inverse.path)} — confirm it first.`,
          });
          return;
        }
        try {
          history.tookUndo(applyInverse(act.inverse));
          syncWatchers();
          announce(`You undid: ${act.label}.`, { fact: "history.undo" });
          broadcastState();
        } catch (e) {
          // The refusal the human needs to read — a folder with things in it,
          // or a world that has moved under a recorded inverse. The act STAYS
          // on the stack: nothing happened, so nothing should be forgotten.
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "history.redo": {
        const act = history.peekRedo();
        if (!act) return;
        try {
          history.tookRedo(applyInverse(act.inverse));
          syncWatchers();
          announce(`You redid: ${act.label}.`, { fact: "history.redo" });
          broadcastState();
        } catch (e) {
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      case "select":
        // AMBIENT state: stored and shown, never pushed onto the agent's tail.
        selection = msg.selection;
        return;
      case "say": {
        const text = msg.text.trim();
        if (!text) return;
        const sel = msg.withSelection ? selection : null;
        const activePath = sel ? session.activePath(sel.doc) : session.activePath();
        const m = session.addMessage("human", text, { selection: sel, activePath });
        log.emit({
          type: "message",
          message_id: m.id,
          text,
          selection: sel,
          active: activeOf(sel?.doc),
          ts: m.ts,
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
          who: "human",
          range: { from: msg.from, to: msg.to },
        });
        // E65: the event carries the note itself when it is short, and names
        // the act that closes it — an agent should not have to go and ask
        // what just arrived before it can start.
        log.emit({
          type: "note.added",
          doc: r.slug,
          note: r.note.id,
          by: "human",
          ...noteEventFacts(r.slug, r.note, session.noteLines(r.slug, r.note)),
        });
        broadcastState();
        return;
      }
      case "task.done": {
        const r = session.finishTask(msg.id, msg.outcome);
        if (!r.already) {
          session.addMessage("system", `Done: ${r.task.text}`);
          log.emit({ type: "task.done", task: r.task.id, by: "human" });
        }
        broadcastState();
        return;
      }
      case "task.remove": {
        session.removeTask(msg.id);
        broadcastState();
        return;
      }
      case "tasks.clear": {
        session.clearDoneTasks();
        broadcastState();
        return;
      }
      case "note.edit": {
        const r = session.editNote({ doc: msg.doc, id: msg.id, body: msg.body, who: "human" });
        // A human's rewrite is owed an answer again (E65), so it says what
        // the note now says, exactly as `note.added` does.
        log.emit({
          type: "note.edited",
          doc: r.slug,
          note: r.note.id,
          by: "human",
          ...noteEventFacts(r.slug, r.note, session.noteLines(r.slug, r.note)),
        });
        broadcastState();
        return;
      }
      case "note.resolve": {
        const r = session.resolveNote({ doc: msg.doc, id: msg.id, resolved: msg.resolved });
        log.emit({
          type: msg.resolved ? "note.resolved" : "note.reopened",
          doc: r.slug,
          note: r.note.id,
          by: "human",
        });
        broadcastState();
        return;
      }
      case "note.remove": {
        const r = session.removeNote({ doc: msg.doc, id: msg.id });
        log.emit({ type: "note.removed", doc: r.slug, note: r.note.id, by: "human" });
        broadcastState();
        return;
      }
      case "version.delete": {
        const r = session.deleteVersion({ doc: msg.doc, version: msg.version });
        const m = session.addMessage(
          "system",
          `Deleted v${r.version} of ${r.slug}${r.label ? ` — ${r.label}` : ""}.`,
        );
        log.emit({
          type: "version.deleted",
          doc: r.slug,
          version: r.version,
          by: "human",
          ts: m.ts,
        });
        broadcastState();
        return;
      }
      case "version.new": {
        const r = session.newVersion({
          doc: msg.doc,
          ...(msg.from === undefined ? {} : { from: msg.from }),
          ...(msg.label ? { label: msg.label } : {}),
          author: "human",
        });
        // ⛔ SAY WHERE THEY ARE, not just what was made (E42). The old message
        // announced the new version and went quiet about which one the human
        // was editing — which is exactly how someone types into v1 believing
        // they are in v2.
        if (msg.activate) session.activate({ doc: r.slug, version: r.version.n });
        const m = session.addMessage(
          "system",
          `Made v${r.version.n} of ${r.slug} from v${r.version.from}${msg.label ? ` — ${msg.label}` : ""}. ` +
            (msg.activate
              ? `You are now editing v${r.version.n}.`
              : `You are still editing v${r.version.from}.`),
        );
        log.emit({
          type: "version.created",
          doc: r.slug,
          version: r.version.n,
          from: r.version.from,
          activated: msg.activate === true,
          by: "human",
          ts: m.ts,
        });
        broadcastState();
        return;
      }
      case "save": {
        const r = session.save(msg.doc);
        const m = session.addMessage("system", `Saved v${r.version} to ${r.original}.`);
        log.emit({
          type: "saved",
          doc: msg.doc,
          version: r.version,
          original: r.original,
          ts: m.ts,
        });
        broadcastState();
        return;
      }
      case "revert": {
        const r = session.revert(msg.doc);
        send({
          type: "version.text",
          doc: msg.doc,
          version: r.version,
          text: r.text,
          origin: "remote",
        });
        const m = session.addMessage(
          "system",
          `Reverted v${r.version} of ${msg.doc} to the saved file.`,
        );
        log.emit({ type: "reverted", doc: msg.doc, version: r.version, ts: m.ts });
        broadcastState();
        return;
      }
      case "context.add":
        addPaths([surfacePath(msg.path)]);
        return;
      case "reveal":
        revealPath(session.shownPath(surfacePath(msg.path)));
        return;
      case "reveal.version":
        // The daemon resolves it, so the surface never names a path outside
        // what the session already owns.
        revealPath(session.readVersion(msg.doc, msg.version).path);
        return;
      case "pick": {
        void openPicker(ws, msg.want);
        return;
      }
      case "context.remove":
        session.removeContext(msg.id);
        syncWatchers();
        broadcastState();
        return;
      case "read": {
        reply(ws, {
          type: "version.text",
          doc: msg.doc,
          version: msg.version,
          text: session.readVersion(msg.doc, msg.version).text,
          origin: "load",
        });
        return;
      }
      case "diff": {
        reply(ws, { type: "diff", ...session.compare({ doc: msg.doc, against: msg.against }) });
        return;
      }
      case "merge": {
        const r = session.merge({ doc: msg.doc, against: msg.against, hunks: msg.hunks });
        // The buffer the human is looking at must be told: the merge wrote the
        // active version's FILE, and the editor's text is now behind it.
        send({
          type: "version.text",
          doc: r.slug,
          version: r.version,
          text: r.text,
          origin: "remote",
        });
        const m = session.addMessage(
          "system",
          `Took ${r.applied} change${r.applied === 1 ? "" : "s"} from ${sideName(msg.against, session.doc(r.slug).name)} into v${r.version} of ${r.slug}.`,
        );
        log.emit({
          type: "merged",
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
        if (
          !PREF_KEY.test(msg.key) ||
          typeof msg.value !== "string" ||
          msg.value.length > PREF_VALUE_MAX
        )
          throw new Error(`refused pref ${JSON.stringify(msg.key)}`);
        const current = readPrefs();
        if (current[msg.key] === msg.value) return;
        if (!(msg.key in current) && Object.keys(current).length >= PREF_KEYS_MAX)
          throw new Error(
            `refused pref ${JSON.stringify(msg.key)}: ${PREF_KEYS_MAX} keys already kept`,
          );
        writeFileAtomic(
          prefsFile,
          `${JSON.stringify({ ...current, [msg.key]: msg.value }, null, 2)}\n`,
        );
        broadcastState();
        return;
      }
      case "graph": {
        try {
          reply(ws, { type: "graph", entry: msg.entry, graph: session.graphFor(msg.entry) });
        } catch (e) {
          reply(ws, {
            type: "graph",
            entry: msg.entry,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      case "link.open": {
        // E33: a link inside the bundle is FOLLOWED; one that escapes it is
        // reported so the surface can offer to add it, never added silently.
        const r = session.resolveLink(msg.from, msg.target);
        if (r.state === "in-bundle") {
          session.openPath(r.path);
          broadcastState();
          const d = session.doc(session.openDocSlug ?? "");
          reply(ws, {
            type: "version.text",
            doc: d.slug,
            version: d.active,
            text: session.readVersion(d.slug, d.active).text,
            origin: "load",
          });
        }
        reply(ws, {
          type: "link.target",
          target: msg.target,
          state: r.state,
          ...(r.state === "missing" ? {} : { path: r.path }),
        });
        return;
      }
      case "meta.suggest": {
        try {
          const r = session.suggestMeta(msg.path, "human");
          reply(ws, {
            type: "meta.suggestion",
            path: msg.path,
            block: r.block,
            ...(r.type ? { suggestedType: r.type } : {}),
          });
        } catch (e) {
          reply(ws, {
            type: "meta.suggestion",
            path: msg.path,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      case "move.plan": {
        try {
          reply(ws, {
            type: "move.plan",
            path: msg.path,
            into: msg.into,
            plan: session.movePlan(surfacePath(msg.path), surfacePath(msg.into)),
          });
        } catch (e) {
          reply(ws, {
            type: "move.plan",
            path: msg.path,
            into: msg.into,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }
      case "fs.list": {
        const path = expandHome(msg.path);
        try {
          reply(ws, { type: "fs.list", path: msg.path, entries: listDir(path) });
        } catch (e) {
          reply(ws, {
            type: "fs.list",
            path: msg.path,
            entries: [],
            error: String((e as Error).message),
          });
        }
        return;
      }
    }
  };

  // ── the native picker (one dialog at a time) ───────────────────────────────
  //
  // A modal dialog owns the human's attention, and a second one behind the
  // first cannot be seen or dismissed — so a request while one is open is
  // refused in words rather than queued.
  let pickerOpen = false;
  const zenity = process.platform === "linux" ? Bun.which("zenity") : null;
  const openPicker = async (
    ws: import("bun").ServerWebSocket<unknown>,
    want: "context-file" | "context-folder" | "workspace",
  ) => {
    if (pickerOpen) {
      reply(ws, { type: "error", message: "a file picker is already open" });
      return;
    }
    const kind: PickKind = want === "context-file" ? "file" : "folder";
    const prompt =
      want === "workspace"
        ? "Choose the workspace folder for scriptorium"
        : want === "context-folder"
          ? "Choose a folder to add to scriptorium"
          : "Choose documents to add to scriptorium";
    const cmd = pickerCommand(process.platform, kind, prompt, zenity);
    if (!cmd) {
      reply(ws, {
        type: "error",
        message: `no file picker on this system (${process.platform}) — type the path instead`,
      });
      return;
    }
    pickerOpen = true;
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      touch(); // a human stood at a dialog; the session is not idle
      const paths = parsePickerOutput(out);
      if (paths.length === 0) {
        // Cancelled: nothing chosen, nothing said. A real failure is said.
        if (!wasCancelled(code, out))
          reply(ws, { type: "error", message: `the file picker failed (exit ${code})` });
        return;
      }
      // What was chosen is admitted like any other path — a picked file that
      // scriptorium does not open is refused in the sidebar's own words, and
      // that refusal must not read as "the picker failed".
      try {
        if (want === "workspace")
          structure({ type: "workspace.set", path: paths[0] as string }, "human");
        else addPaths(paths);
      } catch (e) {
        reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } catch (e) {
      reply(ws, {
        type: "error",
        message: `could not open the file picker: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      pickerOpen = false;
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

  // --- agent commands (POST /cmd) ----------------------------------------------
  let resolveDone!: (v: { code: number; reason: string }) => void;
  const done = new Promise<{ code: number; reason: string }>((r) => {
    resolveDone = r;
  });

  /** Show a file in the platform's file manager. An argv, never a shell string:
   *  the path is data, whatever it holds. */
  const revealPath = (path: string): void => {
    const [cmd, ...args] =
      process.platform === "darwin"
        ? ["open", "-R", path]
        : process.platform === "win32"
          ? ["explorer", `/select,${path}`]
          : ["xdg-open", dirname(path)];
    Bun.spawn([cmd as string, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  };

  const handleAgentCmd = (cmd: AgentCmd): Record<string, unknown> => {
    if (isStructureOp(cmd)) return structure(cmd, "agent");
    switch (cmd.type) {
      case "meta":
        return session.metaFor(cmd.path);
      case "graph":
        return session.graphFor(cmd.entry) as unknown as Record<string, unknown>;
      case "dangling":
        return session.danglingLinks(cmd.entry);
      case "doctor": {
        const list = session.checkup();
        return { findings: list, count: list.length } as unknown as Record<string, unknown>;
      }
      case "forget": {
        const f = session.forgetDoc(cmd.doc);
        announce(
          `Agent forgot ${f.name} — its file was gone, and ${f.versions === 1 ? "1 version" : `${f.versions} versions`} in this session ${f.versions === 1 ? "is" : "are"} no longer reachable.`,
          { fact: "doc.forgotten", doc: f.slug, original: f.original },
        );
        broadcastState();
        return f as unknown as Record<string, unknown>;
      }
      case "search":
        return session.searchAll(cmd) as unknown as Record<string, unknown>;
      case "backlinks":
        return session.backlinks(cmd.path);
      case "meta.init": {
        const r = session.metaInit(cmd.path, {
          ...(cmd.metaType ? { type: cmd.metaType } : {}),
          by: cmd.by ?? "agent",
        });
        announce(`Agent added frontmatter to ${session.display(String(r.path))}.`, {
          fact: "meta.init",
          by: "agent",
          ...r,
        });
        return r;
      }
      case "meta.set": {
        const r = session.metaSet(cmd.path, cmd.fields);
        announce(
          `Agent set ${(r.set as string[]).join(", ")} on ${session.display(String(r.path))}.`,
          { fact: "meta.set", by: "agent", ...r },
        );
        return r;
      }
      case "version.delete": {
        const r = session.deleteVersion({ doc: cmd.doc, version: cmd.version });
        announce(`Agent deleted v${r.version} of ${r.slug}${r.label ? ` — ${r.label}` : ""}.`, {
          fact: "version.deleted",
          doc: r.slug,
          version: r.version,
          by: "agent",
        });
        return { doc: r.slug, version: r.version, remaining: r.remaining };
      }
      case "note.add": {
        const r = session.addNote({
          doc: cmd.doc,
          body: cmd.body,
          who: "agent",
          quote: cmd.quote,
        });
        announce(`Agent noted “${quoteLabel(r.note.quote)}” on ${r.slug}.`, {
          fact: "note.added",
          doc: r.slug,
          note: r.note.id,
          by: "agent",
        });
        return { doc: r.slug, note: r.note.id, quote: r.note.quote };
      }
      case "notes": {
        const r = session.notesOf({ doc: cmd.doc, ...(cmd.all ? { all: true } : {}) });
        return { doc: r.slug, notes: r.notes };
      }
      case "task.remove": {
        const t = session.removeTask(cmd.id);
        broadcastState();
        return { task: t.id, removed: true };
      }
      case "tasks.clear": {
        const cleared = session.clearDoneTasks();
        broadcastState();
        return { cleared };
      }
      case "working": {
        // E53's snooze. It does NOT post to the chat: an agent saying "still
        // working" in the conversation is a reply, and it can do that with
        // `say` — this is the quieter thing, for when there is nothing to
        // report yet but the alarm should stop.
        const ms = cmd.seconds !== undefined ? cmd.seconds * 1000 : DEFAULT_SNOOZE_MS;
        acknowledgedUntil = Date.now() + Math.max(0, ms);
        // Whatever is pending is acknowledged, so it must never be nudged again.
        const w = waitingOn(session.messages(), Date.now(), { acknowledgedUntil });
        if (w) nudged.add(w.messageId);
        broadcastState();
        return {
          until: acknowledgedUntil,
          seconds: Math.round(Math.max(0, ms) / 1000),
          ...(w ? { waiting: w.messageId } : {}),
        };
      }
      case "task.start": {
        const t = session.startTask(cmd.text, "agent");
        log.emit({ type: "task.started", task: t.id, text: t.text, by: "agent" });
        broadcastState();
        return { task: t.id, text: t.text };
      }
      case "task.status": {
        const t = session.setTaskStatus(cmd.id, cmd.status);
        broadcastState();
        return { task: t.id, status: t.status };
      }
      case "task.done": {
        const r = session.finishTask(cmd.id, cmd.outcome);
        if (!r.already)
          announce(`Done: ${r.task.text}${r.task.outcome ? ` — ${r.task.outcome}` : ""}`, {
            fact: "task.done",
            task: r.task.id,
            by: "agent",
          });
        broadcastState();
        return { task: r.task.id, already: r.already };
      }
      case "note.edit": {
        const r = session.editNote({ doc: cmd.doc, id: cmd.id, body: cmd.body, who: "agent" });
        announce(`Agent rewrote a note on ${r.slug}: “${quoteLabel(r.note.quote)}”.`, {
          fact: "note.edited",
          doc: r.slug,
          note: r.note.id,
          by: "agent",
        });
        return { doc: r.slug, note: r.note.id };
      }
      case "note.resolve": {
        const r = session.resolveNote({ doc: cmd.doc, id: cmd.id, resolved: cmd.resolved });
        announce(
          `Agent ${cmd.resolved ? "resolved" : "reopened"} a note on ${r.slug}: “${quoteLabel(r.note.quote)}”.`,
          { fact: "note.resolved", doc: r.slug, note: r.note.id, by: "agent" },
        );
        return { doc: r.slug, note: r.note.id, resolved: r.note.resolved };
      }
      case "note.remove": {
        const r = session.removeNote({ doc: cmd.doc, id: cmd.id });
        announce(`Agent removed a note on ${r.slug}: “${quoteLabel(r.note.quote)}”.`, {
          fact: "note.removed",
          doc: r.slug,
          note: r.note.id,
          by: "agent",
        });
        return { doc: r.slug, note: r.note.id };
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
        const r = session.merge({ doc: cmd.doc, against: cmd.against, hunks: cmd.hunks });
        send({
          type: "version.text",
          doc: r.slug,
          version: r.version,
          text: r.text,
          origin: "remote",
        });
        announce(
          `Agent took ${r.applied} change${r.applied === 1 ? "" : "s"} from ${sideName(cmd.against, session.doc(r.slug).name)} into v${r.version} of ${r.slug}.`,
          { fact: "merged", doc: r.slug, version: r.version, hunks: cmd.hunks, by: "agent" },
        );
        return { doc: r.slug, version: r.version, applied: r.applied };
      }
      case "find":
        return session.find(cmd.filter);
      case "context.add": {
        const added = addPaths(cmd.paths);
        return { entries: added.map((a) => ({ ...a.entry, added: a.added })) };
      }
      case "version.new": {
        // ⛔ VERIFY-PASS FIX 7: the agent may name a doc the human has not
        // opened, by ABSOLUTE path (the CLI resolves it against its own cwd);
        // it is opened implicitly under the same admission rule as the
        // surface's `open` — a doc-type file inside a context entry — without
        // moving the human's open document.
        if (cmd.doc && isAbsolute(cmd.doc) && !session.findDoc(cmd.doc)) {
          const o = session.openPath(cmd.doc, { focus: false });
          if (o.created)
            log.emit({
              type: "doc.opened",
              doc: o.slug,
              path: session.activePath(o.slug),
              by: "agent",
            });
        }
        const r = session.newVersion({
          doc: cmd.doc,
          from: cmd.from,
          label: cmd.label,
          author: "agent",
        });
        announce(
          `Agent created v${r.version.n} of ${r.slug} from v${r.version.from}${cmd.label ? ` — ${cmd.label}` : ""}.`,
          { fact: "version.created", doc: r.slug, version: r.version.n },
        );
        return { doc: r.slug, version: r.version.n, from: r.version.from, path: r.version.path };
      }
      case "say": {
        const m = session.addMessage("agent", cmd.text);
        broadcastState();
        return { id: m.id };
      }
      case "activate":
        return activate(cmd.doc, cmd.version, "agent");
      case "close":
        resolveDone({ code: 0, reason: "close" });
        return {};
      default:
        throw new SessionError(
          `unrecognised command type ${JSON.stringify((cmd as { type?: unknown }).type)} — nothing was applied`,
          400,
          [
            "context.add",
            "version.new",
            "say",
            "activate",
            "close",
            "meta",
            "find",
            "graph",
            "backlinks",
            "meta.init",
            "meta.set",
            ...STRUCTURE_OPS,
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
        },
        { status: e.status },
      );
    if (e instanceof PathError)
      return Response.json({ ok: false, error: e.message }, { status: 404 });
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  };

  const eventsResponse = (req: Request, url: URL): Response => {
    touch();
    return sseResponse({
      log,
      since: Number.parseInt(url.searchParams.get("since") ?? "-1", 10),
      heartbeatMs: SSE_HEARTBEAT_MS,
      clients: sseClients,
      signal: req.signal,
      onOpen: touch,
      onClose: touch,
    });
  };

  // --- serve ----------------------------------------------------------------------
  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    routes,
    idleTimeout: IDLE_TIMEOUT_SEC,
    development: { hmr: mode === "dev" },
    fetch(req, srv) {
      // ⛔ VERIFY-PASS FIX 1a, NOW THE KIT'S AND NOW ROSTER-WIDE. This was the
      // first copy and it listed paths (`/ws`, `/cmd`, `/fs/`) — a list that
      // was already missing `/state`, which answers a session's whole contents.
      // `src/kit/wire/origin.ts` refuses on the REQUEST instead, so no path
      // inventory can go stale, and `grimoire/origin-guard-ward.test.ts` holds
      // the other eight daemons to the same line.
      {
        const refused = refuseForeignOrigin(req, srv.port);
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
          const r = session.readVersion(
            url.searchParams.get("doc") ?? "",
            Number.parseInt(url.searchParams.get("v") ?? "", 10),
          );
          return Response.json(r);
        } catch (e) {
          return refusal(e);
        }
      }
      if (req.method === "GET" && path === "/fs/list") {
        try {
          return Response.json({
            entries: listDir(expandHome(url.searchParams.get("path") ?? "~")),
          });
        } catch (e) {
          return Response.json({ ok: false, error: String((e as Error).message) }, { status: 404 });
        }
      }
      if (req.method === "POST" && path === "/cmd")
        return req
          .json()
          .then((b) => {
            touch();
            try {
              return Response.json({ ok: true, ...handleAgentCmd(b as AgentCmd) });
            } catch (e) {
              return refusal(e);
            }
          })
          .catch(() => Response.json({ ok: false, error: "bad json" }, { status: 400 }));
      if (mode === "release") {
        const asset = serveDist(path);
        if (asset) return asset;
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        touch();
        ws.send(JSON.stringify({ type: "state", state: viewState() }));
      },
      message(ws, raw) {
        touch();
        let msg: ClientMsg;
        try {
          msg = JSON.parse(
            typeof raw === "string" ? raw : new TextDecoder().decode(raw),
          ) as ClientMsg;
        } catch (e) {
          process.stderr.write(`scriptorium: bad json from browser: ${e}\n`);
          return;
        }
        try {
          handleClientMsg(ws, msg);
        } catch (e) {
          // A refusal the human caused (edit a non-active version, open a
          // vanished file) reaches THEM, as a chat-visible system line would be
          // too loud for a keystroke — so it is an error frame the surface shows.
          reply(ws, { type: "error", message: e instanceof Error ? e.message : String(e) });
        }
      },
      close(ws) {
        sockets.delete(ws);
      },
    },
  });

  const boundPort = server.port;
  // --- discovery (E13: session-JSON, the only convention that can express several) --
  const sessionFile = join(tmpdir(), `scriptorium-${sessionId}.json`);
  const latestFile = join(tmpdir(), "scriptorium-latest.json");
  const info = JSON.stringify({
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    session_id: sessionId,
    home,
    dir: session.dir,
    mode,
  });
  try {
    writeFileAtomic(sessionFile, info);
    writeFileAtomic(latestFile, info);
  } catch {
    /* discovery is best-effort */
  }

  syncWatchers();
  // ⚠ THE SESSION SAYS WHAT ITS OWN TIMEOUT IS. `--timeout 0` has always meant
  // "stand until closed" and there was no way to confirm from outside that a
  // daemon had taken it — which is the kind of setting you find out about by
  // losing a session at the wrong moment.
  log.emit({
    type: "ready",
    mode,
    session_id: sessionId,
    restored: !!opts.restore,
    idle_timeout_s: opts.timeoutS ?? 1800,
  });
  // Verify-pass fix 2: what changed on disk while no daemon was watching.
  for (const f of session.restoreFindings)
    announce(
      f.missing
        ? `${f.original} is gone from disk since this session was last open. Save would recreate it; Revert cannot run.`
        : `${f.original} changed on disk while this session was closed. Save overwrites it with the active version; Revert takes the file's version.`,
      { fact: "original.conflict", doc: f.doc, whileClosed: true },
    );

  // E62: one line when the session has something worth looking at, and silence
  // when it does not.
  //
  // ⛔ A SUMMARY, NOT A REPEAT. The per-document conflicts above say their own
  // piece with the Save/Revert nuance; this counts what is there — including
  // the things those lines never covered, like a context entry pointing at
  // nothing — and points at the verb. A startup check that restates what was
  // just said, or that announces itself when everything is fine, is a line
  // people learn to skip.
  {
    const list = session.checkup();
    const line = summary(list);
    if (line) {
      announce(line, { fact: "doctor", findings: list.length });
      // The agent gets the whole report on its tail, so an agent that arrives
      // later does not have to ask — and does not have to parse the sentence.
      log.emit({ type: "doctor", count: list.length, findings: list });
    }
  }

  /**
   * E53's attention tick. Separate from housekeeping because it is about the
   * HUMAN's patience rather than the daemon's lifetime, and because it must run
   * on a slower clock: a 250 ms sweep re-broadcasting state would be churn for a
   * value that changes twice in a wait.
   */
  let lastWaiting: string | null = null;
  const attentionTimer = setInterval(() => {
    const now = Date.now();
    const w = waitingOn(session.messages(), now, { acknowledgedUntil });
    // E65: a note flipping to stalled is a change the surface must see too.
    // ⚠ NOT a nudge: see E65 in the decision log — the note's act is the
    // human's, and the event that delivered it already carried it.
    const notes = notesWaiting(session.noteFacts(), session.messages(), now, {
      acknowledgedUntil,
    });
    const key = [
      w ? `${w.messageId}:${w.badge}` : "-",
      ...notes.map((n) => `${n.noteId}:${n.badge}`),
    ].join("|");
    if (key === lastWaiting) return;
    lastWaiting = key;
    // The badge changed, so the surface needs the new snapshot.
    broadcastState();
    if (!w) return;
    if (w.badge !== "stalled" || nudged.has(w.messageId)) return;
    nudged.add(w.messageId);
    // ⛔ THE NUDGE GOES TO THE AGENT'S TAIL AND NOWHERE ELSE. The human already
    // sees the badge; putting this in the chat as well would be telling them
    // what they are looking at. It carries the message TEXT because an agent
    // that has been away needs to know what is pending, not just that something
    // is — and it names the two ways out, because a nudge that does not say how
    // to answer it invites a fourth primitive.
    const pending = session.messages().find((m) => m.id === w.messageId);
    log.emit({
      type: "waiting",
      message_id: w.messageId,
      seconds: Math.round((Date.now() - w.since) / 1000),
      ...(pending ? { text: pending.text } : {}),
      hint: "reply with `say`, or `working` to say you are still on it",
    });
  }, 1000);

  const stopHousekeeping = startHousekeeping({
    subscriberCount: () => sockets.size + sseClients.size,
    idleMs: () => performance.now() - lastActivity,
    touch,
    timeoutMs: (opts.timeoutS ?? 1800) * 1000,
    onIdleClose: () => resolveDone({ code: 124, reason: "timeout" }),
  });

  let closed = false;
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((r) => {
    resolveShutdown = r;
  });

  const cleanupDiscovery = () => {
    try {
      unlinkSync(sessionFile);
    } catch {
      /* gone — fine */
    }
    unlinkIfMatches(latestFile, sessionId, (raw) => {
      try {
        const id = (JSON.parse(raw) as { session_id?: unknown }).session_id;
        return typeof id === "string" ? id : null;
      } catch {
        return null;
      }
    });
  };

  // The order is the header's, and the header says why.
  const close = () => {
    if (closed) return;
    closed = true;
    stopHousekeeping();
    clearInterval(attentionTimer);
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const t of pending.values()) clearTimeout(t);
    try {
      session.persist();
    } catch {
      /* best-effort */
    }
    cleanupDiscovery();
    log.emit({ type: "closed" });
    void drainAndStop({ server, clients: sseClients, sockets }).then(resolveShutdown);
  };
  done.then(() => close());

  return { port: boundPort, sessionId, mode, dir: session.dir, close, done, shutdown };
}

/**
 * A path typed in the SURFACE. The page has no working directory, so a path
 * from it must be absolute or start at `~` — which is expanded HERE. Before
 * this, `~/Documents` reached `resolve()` and was taken as relative to the
 * daemon's cwd (the skill folder): the path box completed `~/…` (listing
 * expands it) and then Enter failed with "no such file or folder:
 * …/skills/scriptorium/~/Documents/…" (Cole, 2026-09-11).
 */
export function surfacePath(p: string): string {
  const t = p.trim();
  if (t === "~" || t.startsWith("~/")) return expandHome(t);
  if (!isAbsolute(t))
    throw new SessionError(`"${p}" is not a full path — start it with / or ~/`, 400);
  return resolve(t);
}

/** A structure op from the surface, with every path field through `surfacePath`. */
function anchorSurfacePaths(op: StructureOp): StructureOp {
  const out: Record<string, unknown> = { ...op };
  for (const k of ["dir", "path", "into"] as const)
    if (typeof out[k] === "string") out[k] = surfacePath(out[k] as string);
  return out as StructureOp;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** The daemon's private argv — the CLI spawns it with exactly these. */
const DAEMON_OPTIONS = {
  log: { type: "string" },
  port: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
  workspace: { type: "string" },
} as const;

/** Parse the daemon's argv, boot, print the handshake, wait for the end. Returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  let flags: Record<string, string | undefined>;
  try {
    flags = nodeParseArgs({ args: argv, options: DAEMON_OPTIONS, strict: true }).values as Record<
      string,
      string | undefined
    >;
  } catch (e) {
    process.stderr.write(
      `scriptorium: ${e instanceof Error ? e.message : String(e)}\n  recognized flags: ${Object.keys(
        DAEMON_OPTIONS,
      )
        .map((k) => `--${k}`)
        .join(" ")}\n`,
    );
    return 2;
  }
  let d: Awaited<ReturnType<typeof startDaemon>>;
  try {
    d = await startDaemon({
      port: flags.port ? Number(flags.port) : 0,
      restore: flags.restore,
      timeoutS: flags.timeout ? Number(flags.timeout) : undefined,
      workspace: flags.workspace,
    });
  } catch (e) {
    // The handshake line is JSON either way, so the CLI reads ONE shape.
    const status = e instanceof SessionError ? e.status : 500;
    process.stdout.write(
      `${JSON.stringify({ ok: false, status, error: e instanceof Error ? e.message : String(e) })}\n`,
    );
    return status === 404 ? 5 : status === 409 ? 6 : 1;
  }
  process.stdout.write(
    `${JSON.stringify({ url: `http://127.0.0.1:${d.port}`, port: d.port, session_id: d.sessionId, mode: d.mode, dir: d.dir })}\n`,
  );
  const res = await d.done;
  await d.shutdown;
  // Verify-pass fix 6: a clean close leaves no empty log behind.
  if (res.code === 0 && flags.log) {
    try {
      if (statSync(flags.log).size === 0) unlinkSync(flags.log);
    } catch {
      /* already gone */
    }
  }
  return res.code;
}

/**
 * The daemon's entry, for the LAUNCHER. `import.meta.main` is FALSE in the
 * bundle, so there is no such block here, and this takes no arguments: the
 * command line belongs to the file that parses it.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}
