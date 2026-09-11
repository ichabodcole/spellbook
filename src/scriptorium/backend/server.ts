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

import { type FSWatcher, unlinkSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";
import { createEventLog } from "../../kit/wire/eventLog.ts";
import { drainAndStop, startHousekeeping } from "../../kit/wire/housekeeping.ts";
import { resolveMode as resolveModeIn, serveFromDist } from "../../kit/wire/serveDist.ts";
import { type SseClients, sseResponse } from "../../kit/wire/sse.ts";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat";
import type { AgentCmd, ClientMsg, Selection, ServerMsg } from "./protocol";
import { type FileEvent, Session, SessionError } from "./session";
import { listDir, PathError } from "./tree";

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

export type StartOpts = { port?: number; restore?: string; timeoutS?: number };

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

  const session = opts.restore ? Session.restore(home, opts.restore) : Session.create(home);
  const sessionId = session.id;
  let selection: Selection | null = null;

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
  const broadcastState = () => send({ type: "state", state: session.view(mode, selection) });

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

  // --- surface messages (WebSocket) --------------------------------------------
  const reply = (ws: import("bun").ServerWebSocket<unknown>, msg: ServerMsg) => {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* gone */
    }
  };

  const handleClientMsg = (ws: import("bun").ServerWebSocket<unknown>, msg: ClientMsg) => {
    switch (msg.type) {
      case "open": {
        const r = session.openPath(msg.path);
        syncWatchers();
        broadcastState();
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
        addPaths([msg.path]);
        return;
      case "context.remove":
        session.removeContext(msg.id);
        syncWatchers();
        broadcastState();
        return;
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

  const handleAgentCmd = (cmd: AgentCmd): Record<string, unknown> => {
    switch (cmd.type) {
      case "context.add": {
        const added = addPaths(cmd.paths);
        return { entries: added.map((a) => ({ ...a.entry, added: a.added })) };
      }
      case "version.new": {
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
          ["context.add", "version.new", "say", "activate", "close"],
        );
    }
  };

  const refusal = (e: unknown): Response => {
    if (e instanceof SessionError)
      return Response.json(
        { ok: false, error: e.message, ...(e.choices ? { choices: e.choices } : {}) },
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
      const url = new URL(req.url);
      const path = url.pathname;
      // ⛔ VERIFY-PASS FIX 1a — A FOREIGN ORIGIN IS REFUSED. Any web page the
      // human visits can open a WebSocket or POST to 127.0.0.1; the browser
      // sends its Origin, and only this daemon's own page may drive it. The
      // CLI's fetch sends no Origin at all, so it is unaffected.
      if (
        (path === "/ws" || path === "/cmd" || path.startsWith("/fs/")) &&
        !sameOrigin(req, srv.port)
      )
        return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
      if (path === "/ws")
        return srv.upgrade(req) ? undefined : new Response("upgrade required", { status: 426 });
      if (req.method === "GET" && path === "/state") {
        touch();
        const state = session.view(mode, selection);
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
        ws.send(JSON.stringify({ type: "state", state: session.view(mode, selection) }));
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
  log.emit({ type: "ready", mode, session_id: sessionId, restored: !!opts.restore });
  // Verify-pass fix 2: what changed on disk while no daemon was watching.
  for (const f of session.restoreFindings)
    announce(
      f.missing
        ? `${f.original} is gone from disk since this session was last open. Save would recreate it; Revert cannot run.`
        : `${f.original} changed on disk while this session was closed. Save overwrites it with the active version; Revert takes the file's version.`,
      { fact: "original.conflict", doc: f.doc, whileClosed: true },
    );

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

/** An absent Origin (the CLI, curl) or this daemon's own page; nothing else. */
export function sameOrigin(req: Request, port: number | undefined): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** The daemon's private argv — the CLI spawns it with exactly these. */
const DAEMON_OPTIONS = {
  port: { type: "string" },
  restore: { type: "string" },
  timeout: { type: "string" },
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
