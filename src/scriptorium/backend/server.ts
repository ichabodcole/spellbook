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

import { type FSWatcher, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";
import { unlinkIfMatches, writeFileAtomic } from "../../kit/wire/discovery.ts";
import { createEventLog } from "../../kit/wire/eventLog.ts";
import { drainAndStop, startHousekeeping } from "../../kit/wire/housekeeping.ts";
import { resolveMode as resolveModeIn, serveFromDist } from "../../kit/wire/serveDist.ts";
import { type SseClients, sseResponse } from "../../kit/wire/sse.ts";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS } from "./heartbeat";
import { type PickKind, parsePickerOutput, pickerCommand, wasCancelled } from "./picker";
import type { AgentCmd, ClientMsg, Selection, ServerMsg, StructureOp } from "./protocol";
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
  const viewState = () => ({ ...session.view(mode, selection), prefs: readPrefs(), userHome });

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
        line = `${who} removed ${shown(h.path)} from Scriptorium (the file is still on disk).`;
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
    announce(line, { fact: op.type, by, ...r });
    return r;
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
        addPaths([surfacePath(msg.path)]);
        return;
      case "reveal": {
        const path = session.shownPath(surfacePath(msg.path));
        // An argv, never a shell string: the path is data, whatever it holds.
        const [cmd, ...args] =
          process.platform === "darwin"
            ? ["open", "-R", path]
            : process.platform === "win32"
              ? ["explorer", `/select,${path}`]
              : ["xdg-open", dirname(path)];
        Bun.spawn([cmd as string, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
        return;
      }
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

  const handleAgentCmd = (cmd: AgentCmd): Record<string, unknown> => {
    if (isStructureOp(cmd)) return structure(cmd, "agent");
    switch (cmd.type) {
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
          ["context.add", "version.new", "say", "activate", "close", ...STRUCTURE_OPS],
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
