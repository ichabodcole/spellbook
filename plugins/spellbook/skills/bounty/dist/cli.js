#!/usr/bin/env bun
// @bun

// src/bounty/backend/cli.ts
import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "bounty");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var SNAPSHOTS_DIR = join(process.env.BOUNTY_HOME ?? join(homedir(), ".bounty"), "snapshots");
var VALID_STATUS = ["todo", "doing", "review", "done"];
function die(msg) {
  process.stderr.write(`bounty: ${msg}
`);
  process.exit(2);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function sessionFilePath(session) {
  return session ? join(tmpdir(), `bounty-${session}.json`) : join(tmpdir(), "bounty-latest.json");
}
function slugifyKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
function findScopeRoot(startDir, exists = existsSync) {
  let dir = startDir;
  while (true) {
    if (exists(join(dir, ".git")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return startDir;
    dir = parent;
  }
}
function deriveSessionId(key, scopeRoot) {
  const slug = slugifyKey(key);
  const scopeHash = createHash("sha256").update(scopeRoot).digest("hex").slice(0, 8);
  return slug ? `k-${slug}-${scopeHash}` : `k-${scopeHash}`;
}
function sessionKeyToId(key, startDir = process.cwd(), exists = existsSync) {
  return deriveSessionId(key, findScopeRoot(startDir, exists));
}
function resolveSession(flags, env = process.env, startDir = process.cwd(), readFile = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}, exists = existsSync) {
  if (typeof flags["session-key"] === "string")
    return sessionKeyToId(flags["session-key"], startDir, exists);
  if (typeof flags.session === "string")
    return flags.session;
  if (env.BOUNTY_SESSION_KEY)
    return sessionKeyToId(env.BOUNTY_SESSION_KEY, startDir, exists);
  if (env.BOUNTY_SESSION)
    return env.BOUNTY_SESSION;
  let dir = startDir;
  while (true) {
    const contents = readFile(join(dir, ".bounty-session"));
    const id = contents?.trim();
    if (id)
      return id;
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return;
}
function readSession(session) {
  const path = sessionFilePath(session);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT")
      return null;
    die(`cannot read the session pointer (${code ?? "unknown error"}): ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`the session pointer is not valid JSON: ${path}`);
  }
}
function requireSession(session) {
  const s = readSession(session);
  if (!s)
    die("no running bounty session \u2014 run: cli.ts open");
  return s;
}
function pickTailSession(pinned, read) {
  const s = read(pinned);
  if (!s)
    return null;
  return { session: s, pinned: pinned ?? s.session_id };
}
function sameOwner(a, b) {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
function ownerInScope(owner, scope) {
  if (scope.owner)
    return sameOwner(owner, scope.owner);
  if (scope.mine)
    return sameOwner(owner, scope.as) || !owner;
  return true;
}
function parseTags(value) {
  const out = [];
  for (const raw of value.split(",")) {
    const t = raw.trim();
    if (t && !out.includes(t))
      out.push(t);
  }
  return out;
}
function parseSize(value) {
  if (typeof value !== "string")
    return;
  const s = value.trim().toUpperCase();
  return s === "S" || s === "M" || s === "L" ? s : undefined;
}
function parseExpect(value) {
  if (typeof value !== "string")
    return;
  const m = Number(value.trim());
  return Number.isFinite(m) && m > 0 ? m : undefined;
}
function ignoredValues(flags) {
  const out = [];
  if (typeof flags.size === "string" && parseSize(flags.size) === undefined)
    out.push({ flag: "size", value: flags.size, reason: "not one of S|M|L" });
  if (typeof flags.expect === "string" && parseExpect(flags.expect) === undefined)
    out.push({ flag: "expect", value: flags.expect, reason: "not a positive number" });
  return out;
}
function warnIgnored(ignored) {
  for (const i of ignored)
    process.stderr.write(`bounty: ignored --${i.flag} ${JSON.stringify(i.value)} \u2014 ${i.reason}
`);
}
async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
var CLI_OPTIONS = {
  as: { type: "string" },
  expect: { type: "string" },
  id: { type: "string" },
  notes: { type: "string" },
  on: { type: "string" },
  owner: { type: "string" },
  restore: { type: "string" },
  session: { type: "string" },
  "session-key": { type: "string" },
  since: { type: "string" },
  size: { type: "string" },
  status: { type: "string" },
  tag: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  fresh: { type: "boolean" },
  full: { type: "boolean" },
  mine: { type: "boolean" },
  "no-open": { type: "boolean" },
  pin: { type: "boolean" },
  stdin: { type: "boolean" },
  "stdin-tasks": { type: "boolean" }
};

class UsageError extends Error {
}
function parseArgs(args) {
  try {
    const { values, positionals } = nodeParseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true
    });
    return {
      pos: positionals,
      flags: values
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new UsageError(`${detail}
` + `  recognized flags: ${Object.keys(CLI_OPTIONS).map((k) => `--${k}`).join(" ")}
` + `  for free text containing dashes, use --stdin, or put it after a bare --`);
  }
}
function resolveAs(flags) {
  if (typeof flags.as === "string")
    return flags.as;
  return process.env.BOUNTY_AS || undefined;
}
async function postCmd(session, msg, opts = {}) {
  const s = requireSession(session);
  const body = opts.as ? { ...msg, as: opts.as } : msg;
  const { status, data } = await api(s.port, "POST", "/cmd", body);
  if (status !== 200)
    die(`cmd failed (HTTP ${status}) \u2014 is the session still alive?`);
  if (!opts.quiet)
    printJson({ ok: true, sent: msg.type });
  return data ?? {};
}
function ackOrFail(type, res) {
  if (res.applied === false) {
    const error = res.error ?? `the daemon did not apply ${String(type)} \u2014 the board is unchanged`;
    printJson({ ok: false, applied: false, sent: type, error });
    process.stderr.write(`bounty: ${error}
`);
    return 1;
  }
  const dropped = res.tasksDropped;
  if (dropped !== undefined) {
    printJson({ ok: true, sent: type, tasksDropped: dropped });
    if (dropped && typeof dropped === "object") {
      const d = dropped;
      process.stderr.write(`bounty: ${d.dropped.length} of ${d.requested} task(s) were DROPPED and not seeded:
`);
      for (const item of d.dropped)
        process.stderr.write(`  [${item.index}] ${item.reason}
`);
    }
    return 0;
  }
  printJson({ ok: true, sent: type });
  return 0;
}
function newTaskId() {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}
async function boardIfLive(session) {
  const s = readSession(session);
  if (!s)
    return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/state`);
    return r.ok ? s : null;
  } catch {
    return null;
  }
}
function writePin(sessionId) {
  const pinPath = join(process.cwd(), ".bounty-session");
  try {
    writeFileSync(pinPath, `${sessionId}
`);
    process.stderr.write(`# pinned board ${sessionId} \u2192 ${pinPath}
`);
  } catch (e) {
    process.stderr.write(`bounty: could not write ${pinPath}: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
var ATTACH_LOST_FLAGS = ["title", "timeout", "restore"];
async function cmdOpen(flags) {
  const key = typeof flags["session-key"] === "string" ? flags["session-key"] : process.env.BOUNTY_SESSION_KEY ?? undefined;
  const forcedId = key ? sessionKeyToId(key) : undefined;
  if (forcedId) {
    const live = await boardIfLive(forcedId);
    if (live && !flags.fresh) {
      const requested = ATTACH_LOST_FLAGS.filter((f) => Boolean(flags[f]));
      const named = requested.map((f) => `--${f}`).join(", ");
      if (requested.length) {
        printJson({
          ...live,
          restoreSkipped: {
            requested,
            reason: `a live board already exists for this key, so open attached to it instead of spawning a daemon; ${named} configure a daemon at spawn time and the running board was left unchanged`
          }
        });
        process.stderr.write(`bounty: refusing to attach \u2014 ${named} cannot take effect on a board that is already running (key "${key}", board ${forcedId})
`);
        if (flags.pin)
          writePin(forcedId);
        return 2;
      }
      printJson({ ...live, restoreSkipped: null });
      process.stderr.write(`# attached to existing board ${forcedId} (key "${key}")
`);
      if (flags.pin)
        writePin(forcedId);
      return 0;
    }
    if (live && flags.fresh) {
      try {
        await api(live.port, "POST", "/cmd", { type: "close" });
      } catch {}
      const gone = Date.now() + 3000;
      while (Date.now() < gone && await boardIfLive(forcedId))
        await sleep(80);
    }
  }
  const args = ["run", SERVER_SCRIPT];
  if (flags.title)
    args.push("--title", String(flags.title));
  if (flags.timeout)
    args.push("--timeout", String(flags.timeout));
  if (forcedId && !flags.restore && !flags.fresh && existsSync(join(SNAPSHOTS_DIR, `${forcedId}.json`))) {
    args.push("--restore", forcedId);
  }
  if (flags.restore)
    args.push("--restore", String(flags.restore));
  if (flags["no-open"])
    args.push("--no-open");
  if (forcedId)
    args.push("--id", forcedId);
  const prevId = readSession()?.session_id;
  let stderr = "ignore";
  try {
    const bountyHome = process.env.BOUNTY_HOME ?? join(homedir(), ".bounty");
    mkdirSync(bountyHome, { recursive: true });
    stderr = openSync(join(bountyHome, "daemon.log"), "a");
  } catch {
    stderr = "ignore";
  }
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    printJson({
      error: `bounty cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}. No dist/index.html was found (or SPELLBOOK_SURFACE_MODE=dev is set), so the daemon would run in dev mode and needs the surface source at that path.`
    });
    return 2;
  }
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", stderr],
    env: process.env,
    cwd
  });
  proc.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(80);
    const s = forcedId ? readSession(forcedId) : readSession();
    const isUp = forcedId ? !!s : !!(s && s.session_id !== prevId);
    if (s && isUp) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/state`);
        if (r.ok) {
          printJson({ ...s, restoreSkipped: null });
          if (flags.pin)
            writePin(s.session_id);
          return 0;
        }
      } catch {}
    }
  }
  return die("bounty daemon failed to start within 5s");
}
async function cmdState(session, scope = {}) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    die(`state failed (HTTP ${status})`);
  if (scope.owner || scope.mine) {
    const d = data;
    if (d.state?.tasks) {
      d.state.tasks = d.state.tasks.filter((t) => ownerInScope(t.owner, scope));
    }
  }
  printJson({ ...data, readMode: "full" });
}
async function cmdTail(session, sinceArg, scope = {}) {
  let since = sinceArg;
  let delay = 250;
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const owner = scope.owner;
  const self = scope.as;
  const scopeable = (t) => typeof t === "string" && (t.startsWith("task.") || t === "unblocked" || t === "heartbeat");
  const inScope = (ev) => !scopeable(ev.type) || ownerInScope(ev.owner, scope);
  if (owner)
    process.stderr.write(`# scoped to owner=${owner}
`);
  else if (scope.mine)
    process.stderr.write(`# scoped to --mine (owner=${self ?? "?"} + claimable)
`);
  let pinned = session;
  while (!stopped) {
    const resolved = pickTailSession(pinned, readSession);
    if (!resolved) {
      process.stderr.write(`# no session yet, retrying\u2026
`);
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (pinned === undefined) {
      pinned = resolved.pinned;
      process.stderr.write(`# pinned to session ${pinned} \u2014 a long-lived tail won't migrate to a newer board (pass --session to choose another)
`);
    }
    const s = resolved.session;
    let res;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!res.ok || !res.body) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    delay = 250;
    const reader = res.body.getReader();
    const dec = new TextDecoder;
    let buf = "";
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done)
        break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf(`

`);sep >= 0; sep = buf.indexOf(`

`)) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = [];
        for (const line of block.split(`
`)) {
          if (line.startsWith(":")) {
            process.stderr.write(`: bounty-keepalive
`);
            continue;
          }
          if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length)
          continue;
        const payload = dataLines.join(`
`);
        try {
          const ev = JSON.parse(payload);
          if (typeof ev.id === "number" && ev.id > since)
            since = ev.id;
          const selfEcho = self !== undefined && ev.by === self;
          const emit = inScope(ev) && !selfEcho;
          if (ev.type === "closed") {
            if (emit)
              process.stdout.write(`${payload}
`, () => process.exit(0));
            else
              process.exit(0);
            stopped = true;
            return;
          }
          if (emit)
            process.stdout.write(`${payload}
`);
        } catch {}
      }
    }
    await sleep(delay);
  }
}
function cmdInfo(session) {
  const s = readSession(session);
  if (!s)
    die("no running bounty session");
  printJson(s);
}
function cmdSessions() {
  let files;
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    process.stdout.write(`no saved sessions
`);
    return;
  }
  const rows = [];
  for (const f of files) {
    const path = join(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        tasks: Array.isArray(st.tasks) ? st.tasks.length : 0,
        mtime: statSync(path).mtimeMs
      });
    } catch {}
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.tasks} tasks  \u2014 ${r.title}
`);
  }
  if (!rows.length)
    process.stdout.write(`no saved sessions
`);
}
async function liveBoards(discovered, probe) {
  const probed = await Promise.all(discovered.map(async (s) => {
    const probed2 = await probe(s);
    return probed2 === null ? null : { session_id: s.session_id, title: s.title, url: s.url, tasks: probed2.tasks };
  }));
  return probed.filter((b) => b !== null);
}
async function probeBoard(s) {
  try {
    const res = await fetch(`${s.url}/state?lean=1`, { signal: AbortSignal.timeout(600) });
    if (!res.ok)
      return null;
    const body = await res.json();
    return { tasks: Array.isArray(body.state?.tasks) ? body.state.tasks.length : null };
  } catch {
    return null;
  }
}
async function cmdList() {
  let files;
  try {
    files = readdirSync(tmpdir()).filter((f) => f.startsWith("bounty-") && f.endsWith(".json") && f !== "bounty-latest.json");
  } catch {
    files = [];
  }
  const discovered = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(tmpdir(), f), "utf8"));
      if (s && typeof s.url === "string" && typeof s.session_id === "string")
        discovered.push(s);
    } catch {}
  }
  const live = await liveBoards(discovered, probeBoard);
  live.sort((a, b) => a.session_id.localeCompare(b.session_id));
  process.stdout.write(`${live.length} running board${live.length === 1 ? "" : "s"}
`);
  for (const b of live) {
    const count = b.tasks === null ? "? (unreadable)" : `${b.tasks} tasks`;
    process.stdout.write(`${b.session_id}  ${count}  ${b.url}  \u2014 ${b.title}
`);
  }
  if (!live.length)
    process.stdout.write("this lists BOARDS, not tasks \u2014 for the cards ON a board use `bounty state`\n");
}
async function readStdin() {
  return (await Bun.stdin.text()).replace(/\n$/, "");
}
var HELP = `bounty \u2014 an agent-driven task board.

  open   [--title ..] [--timeout S] [--no-open] [--restore <id>] [--pin] [--session-key <key> [--fresh]]   spawn a board daemon (--pin binds it to cwd; --session-key binds it to a caller-owned key, idempotently)
  state  [--mine | --owner <name>] [--as <name>]   read-back: { state, cursor, readMode }
           (--full is accepted but redundant: the read is full by default \u2014 b6)
  tail   [--since N] [--owner <name> | --mine] [--as <name>]   SSE events \u2192 JSONL (Monitor)
  add    <title...> [--status ..] [--notes ..] [--owner ..] [--tag a,b] [--size S|M|L] [--expect <min>] [--id ..] [--stdin]   add a task
  update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--tag a,b] [--size S|M|L] [--expect <min>] [--stdin]      patch a task (--tag "" clears)
  --size S|M|L \u2192 heartbeat estimate (5/10/20 min); --expect <min> overrides. A doing task that overruns pokes its owner.
  claim  <id> [--as <name>]          self-claim an UNOWNED task (rejected if owned by another)
  block  <id> --on <id>[,<id>...]    mark <id> blocked on other task(s) (rejected on a cycle)
  unblock <id> --on <id>[,<id>...]   remove blocker edge(s)
  remove <id>                        delete a task
  message <text...> [--stdin]        show a toast on the board
  init   [--title ..] [--stdin-tasks]   seed the board (tasks = JSON array on stdin; each
           task REQUIRES id + title + status. init does NOT mint ids, unlike add. Any
           dropped task is reported per-entry in tasksDropped)
  list                               list currently-RUNNING boards (id/tasks/url/title)
  sessions                           list saved SNAPSHOTS (incl. closed boards)
  close | info | help

  --as <name> (or $BOUNTY_AS) is your identity \u2014 stamped on events (for scoped
  tail + self-echo suppression) and used by claim/--mine. --owner assigns a task.
  --stdin reads the title from stdin (verbatim \u2014 survives apostrophes, quotes,
  &, <, >). Session targeting resolves --session-key <key> > --session <id> >
  $BOUNTY_SESSION_KEY > $BOUNTY_SESSION > nearest .bounty-session (walking up
  from cwd) > most-recent board. A --session-key is a caller-owned handle: it
  derives a stable, project-scoped board id, so open --session-key K is
  idempotent (attaches to a live board for K, respawns a dead one; --fresh
  forces a clean one), and every verb re-derives the same id \u2014 deterministic
  board binding with no stored/latest pointer. Or use open --pin to write
  cwd/.bounty-session and bind a board to this directory.`;
async function main(argv) {
  const [verb, ...rest] = argv;
  let pos;
  let flags;
  try {
    ({ pos, flags } = parseArgs(rest));
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    process.stderr.write(`bounty: ${e.message}
`);
    return 2;
  }
  const session = resolveSession(flags);
  const as = resolveAs(flags);
  switch (verb) {
    case "open":
      return await cmdOpen(flags);
    case "tail": {
      const mine = flags.mine === true;
      if (mine && !as)
        die("--mine needs an identity \u2014 pass --as <name> or set BOUNTY_AS");
      await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1, {
        owner: typeof flags.owner === "string" ? flags.owner : undefined,
        mine,
        as
      });
      break;
    }
    case "state": {
      const mine = flags.mine === true;
      if (mine && !as)
        die("--mine needs an identity \u2014 pass --as <name> or set BOUNTY_AS");
      await cmdState(session, {
        owner: typeof flags.owner === "string" ? flags.owner : undefined,
        mine,
        as
      });
      break;
    }
    case "add": {
      const title = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!title)
        die("usage: add <title...> [--status ..] [--notes ..] [--stdin]");
      const status = typeof flags.status === "string" && VALID_STATUS.includes(flags.status) ? flags.status : "todo";
      const task = {
        id: typeof flags.id === "string" ? flags.id : newTaskId(),
        title,
        status
      };
      if (typeof flags.notes === "string")
        task.notes = flags.notes;
      if (typeof flags.owner === "string")
        task.owner = flags.owner;
      if (typeof flags.tag === "string")
        task.tags = parseTags(flags.tag);
      const addSize = parseSize(flags.size);
      if (addSize)
        task.size = addSize;
      const addExpect = parseExpect(flags.expect);
      if (addExpect !== undefined)
        task.expect = addExpect;
      const addIgnored = ignoredValues(flags);
      warnIgnored(addIgnored);
      const res = await postCmd(session, { type: "task.add", task }, { as, quiet: true });
      if (!res.applied) {
        const error = res.error ?? `task ${task.id} was not added`;
        printJson({ ok: false, applied: false, id: task.id, error });
        process.stderr.write(`bounty: ${error}
`);
        return 1;
      }
      printJson({ ok: true, added: task.id, valuesIgnored: addIgnored.length ? addIgnored : null });
      break;
    }
    case "update": {
      const id = pos[0];
      if (!id)
        die("usage: update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--tag a,b] [--stdin]");
      const patch = {};
      if (flags.stdin === true)
        patch.title = await readStdin();
      else if (typeof flags.title === "string")
        patch.title = flags.title;
      if (typeof flags.status === "string")
        patch.status = flags.status;
      if (typeof flags.notes === "string")
        patch.notes = flags.notes;
      if (typeof flags.owner === "string")
        patch.owner = flags.owner;
      if (typeof flags.tag === "string")
        patch.tags = parseTags(flags.tag);
      const upSize = parseSize(flags.size);
      if (upSize)
        patch.size = upSize;
      const upExpect = parseExpect(flags.expect);
      if (upExpect !== undefined)
        patch.expect = upExpect;
      const upIgnored = ignoredValues(flags);
      warnIgnored(upIgnored);
      if (Object.keys(patch).length === 0) {
        const why = upIgnored.length ? ` \u2014 ${upIgnored.map((i) => `--${i.flag} ${JSON.stringify(i.value)} was ignored (${i.reason})`).join("; ")}` : "";
        die(`update: nothing to change (give --status/--title/--notes/--owner/--tag/--size/--expect/--stdin)${why}`);
      }
      const res = await postCmd(session, { type: "task.update", id, patch }, { as, quiet: true });
      if (res.applied) {
        printJson({ ok: true, updated: id, valuesIgnored: upIgnored.length ? upIgnored : null });
      } else if (res.error) {
        process.stderr.write(`bounty: ${res.error}
`);
        return 1;
      } else {
        printJson({
          ok: true,
          updated: id,
          noop: true,
          valuesIgnored: upIgnored.length ? upIgnored : null
        });
      }
      break;
    }
    case "claim": {
      const id = pos[0];
      if (!id)
        die("usage: claim <id> [--as <name>]");
      if (!as)
        die("claim needs an identity \u2014 pass --as <name> or set BOUNTY_AS");
      const res = await postCmd(session, { type: "task.update", id, patch: { owner: as }, claim: true }, { as, quiet: true });
      if (res.applied) {
        printJson({ ok: true, claimed: id, owner: as });
      } else {
        process.stderr.write(`bounty: ${res.error ?? `could not claim ${id}`}
`);
        return 1;
      }
      break;
    }
    case "block":
    case "unblock": {
      const id = pos[0];
      if (!id || typeof flags.on !== "string") {
        die(`usage: ${verb} <id> --on <id>[,<id>...]`);
      }
      const on = flags.on.split(",").map((x) => x.trim()).filter(Boolean);
      if (!on.length)
        die(`${verb}: --on needs at least one task id`);
      const res = await postCmd(session, { type: verb === "block" ? "task.block" : "task.unblock", id, on }, { as, quiet: true });
      if (res.applied) {
        printJson({ ok: true, [verb === "block" ? "blocked" : "unblocked"]: id, on });
      } else {
        process.stderr.write(`bounty: ${res.error ?? `could not ${verb} ${id}`}
`);
        return 1;
      }
      break;
    }
    case "remove": {
      const id = pos[0];
      if (!id)
        die("usage: remove <id>");
      const res = await postCmd(session, { type: "task.remove", id }, { as, quiet: true });
      if (res.applied) {
        printJson({ ok: true, removed: id });
      } else {
        process.stderr.write(`bounty: ${res.error ?? `no such task ${id} (wrong board? pass --session)`}
`);
        return 1;
      }
      break;
    }
    case "message": {
      const text = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!text)
        die("usage: message <text...> [--stdin]");
      return ackOrFail("message", await postCmd(session, { type: "message", text }, { as, quiet: true }));
    }
    case "init": {
      const msg = { type: "init" };
      if (typeof flags.title === "string")
        msg.title = flags.title;
      if (flags["stdin-tasks"] === true) {
        const raw = await readStdin();
        try {
          const tasks = JSON.parse(raw);
          if (!Array.isArray(tasks))
            die("init --stdin-tasks: stdin must be a JSON array of tasks");
          msg.tasks = tasks;
        } catch (e) {
          if (e instanceof Error && e.message.includes("JSON array"))
            throw e;
          die("init --stdin-tasks: invalid JSON on stdin");
        }
      }
      return ackOrFail(msg.type, await postCmd(session, msg, { as, quiet: true }));
    }
    case "close": {
      const closeRes = await postCmd(session, { type: "close" }, { as, quiet: true });
      const resolved = requireSession(session);
      const deadline = Date.now() + 3000;
      let down = false;
      while (Date.now() < deadline) {
        if (!await boardIfLive(resolved.session_id)) {
          down = true;
          break;
        }
        await sleep(80);
      }
      if (!closeRes.applied)
        return ackOrFail("close", closeRes);
      printJson({ ok: true, sent: "close", down });
      if (!down)
        process.stderr.write(`bounty: close acked but the daemon was still answering after 3s \u2014 a reopen may attach to it
`);
      return 0;
    }
    case "info":
      cmdInfo(session);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "list":
      await cmdList();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}
`);
      break;
    default:
      die(`unknown verb "${verb}" \u2014 run: cli.ts help`);
  }
  return 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  deriveSessionId,
  findScopeRoot,
  liveBoards,
  main,
  ownerInScope,
  parseTags,
  pickTailSession,
  resolveSession,
  run,
  sessionKeyToId,
  slugifyKey
};

//# debugId=DFFA87527DB71F5F64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2JvdW50eS9iYWNrZW5kL2NsaS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gYm91bnR5IENMSSDigJQgdGhpbiwgc3RhdGVsZXNzIHdyYXBwZXIgYXJvdW5kIHRoZSBwZXItc2Vzc2lvbiBkYWVtb24ncyBIVFRQXG4vLyBzdXJmYWNlIChzZXJ2ZXIudHMpLiBUaGUgYWdlbnQgZHJpdmVzIHRoZSBib2FyZCB0aHJvdWdoIHRoZXNlIHZlcmJzOyBgdGFpbGBcbi8vIHN0cmVhbXMgYm9hcmQgZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAuXG4vL1xuLy8gTGlmZWN5Y2xlOlxuLy8gICBidW4gY2xpLnRzIG9wZW4gWy0tdGl0bGUgLi5dIFstLXRpbWVvdXQgU10gWy0tbm8tb3Blbl0gWy0tcmVzdG9yZSA8aWQ+XSBbLS1waW5dIFstLXNlc3Npb24ta2V5IDxrZXk+IFstLWZyZXNoXV0gICMgc3Bhd24gYSBkYWVtb24gKC0tcGluIGJpbmRzIGl0IHRvIGN3ZDsgLS1zZXNzaW9uLWtleSBiaW5kcyBpdCB0byBhIGNhbGxlci1vd25lZCBrZXksIGlkZW1wb3RlbnRseSDigJQgIzY5KVxuLy8gICBidW4gY2xpLnRzIHRhaWwgWy0tc2luY2UgTl0gWy0tb3duZXIgPG5hbWU+IHwgLS1taW5lXSBbLS1hcyA8bmFtZT5dICAjIHNjb3BlZCBTU0Ug4oaSIEpTT05MXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tb3duZXIgPG5hbWU+IHwgLS1taW5lXSBbLS1hcyA8bmFtZT5dICAgICMgc2NvcGVkIHJlYWQtYmFjayAoZnVsbDsgLS1mdWxsIGFjY2VwdGVkLCBpdCBpcyB0aGUgZGVmYXVsdClcbi8vICAgICBFYWNoIHRhc2sgY2FycmllcyBkZXJpdmVkIGBibG9ja2VkYCArIGBsaXZlQmxvY2tlcnM6W3tpZCx0aXRsZSxzdGF0dXN9XWBcbi8vICAgICAodGhlIG5vdC1kb25lIGJsb2NrZXJzKSwgc28gYSBmaWx0ZXJlZCBibG9ja2VkIHRhc2sgc3RheXMgYWN0aW9uYWJsZS5cbi8vXG4vLyBEcml2aW5nIHRoZSBib2FyZCAoUE9TVCAvY21kKTpcbi8vICAgYnVuIGNsaS50cyBhZGQgPHRpdGxlLi4uPiBbLS1zdGF0dXMgLi5dIFstLW5vdGVzIC4uXSBbLS1vd25lciAuLl0gWy0tdGFnIGEsYl0gWy0tc2l6ZSBTfE18TF0gWy0tZXhwZWN0IDxtaW4+XSBbLS1pZCAuLl0gWy0tc3RkaW5dXG4vLyAgIGJ1biBjbGkudHMgdXBkYXRlIDxpZD4gWy0tc3RhdHVzIC4uXSBbLS10aXRsZSAuLl0gWy0tbm90ZXMgLi5dIFstLW93bmVyIC4uXSBbLS10YWcgYSxiXSBbLS1zaXplIFN8TXxMXSBbLS1leHBlY3QgPG1pbj5dIFstLXN0ZGluXVxuLy8gICBidW4gY2xpLnRzIGNsYWltIDxpZD4gWy0tYXMgPG5hbWU+XSAgICAgICAgICAgICAgICAgICAgICMgc2VsZi1jbGFpbSBhbiB1bm93bmVkIHRhc2tcbi8vICAgYnVuIGNsaS50cyBibG9jayA8aWQ+IC0tb24gPGlkPlssPGlkPi4uLl0gICAgICAgICAgICAgICAjIGFkZCBibG9ja2VyIGVkZ2VzIChjeWNsZS1ndWFyZGVkKVxuLy8gICBidW4gY2xpLnRzIHVuYmxvY2sgPGlkPiAtLW9uIDxpZD5bLDxpZD4uLi5dICAgICAgICAgICAgICMgcmVtb3ZlIGJsb2NrZXIgZWRnZXNcbi8vICAgYnVuIGNsaS50cyByZW1vdmUgPGlkPlxuLy8gICBidW4gY2xpLnRzIG1lc3NhZ2UgPHRleHQuLi4+IFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICMgdG9hc3Rcbi8vICAgYnVuIGNsaS50cyBpbml0IFstLXRpdGxlIC4uXSBbLS1zdGRpbi10YXNrc10gICAgICAgICAgICAjIHNlZWQgdGhlIGJvYXJkIChlYWNoIHRhc2sgbmVlZHMgaWQrdGl0bGUrc3RhdHVzKVxuLy8gICBidW4gY2xpLnRzIGxpc3QgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBydW5uaW5nIGJvYXJkcyAobGl2ZSlcbi8vICAgYnVuIGNsaS50cyBjbG9zZSB8IGluZm8gfCBzZXNzaW9ucyB8IGhlbHAgICAgICAgICAgICAgICMgc2Vzc2lvbnMgPSBzYXZlZCBzbmFwc2hvdHNcbi8vXG4vLyBJZGVudGl0eTogLS1hcyA8bmFtZT4gKG9yICRCT1VOVFlfQVMpIHN0YW1wcyB0aGUgZXZlbnQgYGJ5YCwgZHJpdmVzIHNlbGYtZWNob1xuLy8gc3VwcHJlc3Npb24gKyBjbGFpbS8tLW1pbmUuIE93bmVyc2hpcDogLS1vd25lciBhc3NpZ25zOyB0YWlsIC0tb3duZXIvLS1taW5lXG4vLyBzY29wZXMgYSB3b3JrZXIncyB3YWtlLXNldCB0byBpdHMgb3duICsgY2xhaW1hYmxlIHRhc2tzIChjbGllbnQtc2lkZSBmaWx0ZXIpLlxuLy8gLS1zdGRpbiByZWFkcyB0aGUgdGl0bGUgZnJvbSBzdGRpbiAoYnlwYXNzZXMgc2hlbGwgcXVvdGluZyDigJQgYXBvc3Ryb3BoZXMsXG4vLyBxdW90ZXMsIGFtcGVyc2FuZHMsIGFuZ2xlIGJyYWNrZXRzIGFsbCBsYW5kIHZlcmJhdGltKS4gU2Vzc2lvbiB0YXJnZXRpbmdcbi8vICgjNTksICM2OSkgcmVzb2x2ZXMgaW4gcHJlY2VkZW5jZSBvcmRlcjogLS1zZXNzaW9uLWtleSA8a2V5PiA+IC0tc2Vzc2lvbiA8aWQ+XG4vLyA+ICRCT1VOVFlfU0VTU0lPTl9LRVkgPiAkQk9VTlRZX1NFU1NJT04gPiB0aGUgbmVhcmVzdCBgLmJvdW50eS1zZXNzaW9uYCBmaWxlXG4vLyB3YWxraW5nIHVwIGZyb20gY3dkID4gdGhlIG1vc3QtcmVjZW50IGJvYXJkICh0aGUgYGxhdGVzdGAgcG9pbnRlcikuIEFcbi8vIGAtLXNlc3Npb24ta2V5YCBpcyBhIGNhbGxlci1vd25lZCBoYW5kbGUgdGhhdCBERVJJVkVTIGEgc3RhYmxlLCBwcm9qZWN0LXNjb3BlZFxuLy8gYm9hcmQgaWQgKCM2OSkg4oCUIHNvIGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2AgaXMgaWRlbXBvdGVudCBhbmQgZXZlcnkgdmVyYlxuLy8gcmUtZGVyaXZlcyB0aGUgc2FtZSBib2FyZCwgd2l0aCBubyByYW5kb20gaWQgdG8gY2FycnkuIGBvcGVuIC0tcGluYCB3cml0ZXNcbi8vIGN3ZC8uYm91bnR5LXNlc3Npb24gc28gYSB0ZWFtIGNhbiBiaW5kIGEgYm9hcmQgdG8gaXRzIHByb2plY3QgZGlyZWN0b3J5LlxuLy9cbi8vIERpc2NpcGxpbmU6IHN0cnVjdHVyZWQgcGF5bG9hZCBvbiBzdGRvdXQgKG9uZSBKU09OIGxpbmUpOyBsaXZlbmVzcywgZWNob2VzLFxuLy8gYW5kIGRpYWdub3N0aWNzIG9uIHN0ZGVyciDigJQgbmV2ZXIgbWVyZ2UgdGhlbS4gRXhpdCAyIG9uIGJhZCBhcmdzLCAwIG9uIGFcbi8vIHN1Y2Nlc3NmdWwgdmVyYjsgYHRhaWxgIGV4aXRzIDAgb24gdGhlIGRhZW1vbidzIGBjbG9zZWRgIGV2ZW50LlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGNyZWF0ZUhhc2ggfSBmcm9tIFwibm9kZTpjcnlwdG9cIjtcbmltcG9ydCB7XG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgb3BlblN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHN0YXRTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciwgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBOT1QgYGpvaW4oU0NSSVBUX0RJUiwgXCJzZXJ2ZXIudHNcIilgIOKAlCBUSEUgREVGRUNUIFRISVNcbi8vIFBPUlQgQ0xPU0VELiBVbnRpbCAyMDI2LTA5LTA5IHRoaXMgbGluZSByZWFkIGBqb2luKFNDUklQVF9ESVIsIFwic2VydmVyLnRzXCIpYDpcbi8vIHRoZSBDTEkncyBvd24gZGlyZWN0b3J5LCB3aGljaCB3YXMgdHJ1ZSBmb3IgZXhhY3RseSBhcyBsb25nIGFzIHRoZSBDTEkgYW5kXG4vLyB0aGUgZGFlbW9uIHNoYXJlZCBgc2NyaXB0cy9gLiBCdW5kbGVkIGludG8gYGRpc3QvYCwgdGhhdCByZXNvbHZlcyB0b1xuLy8gYGRpc3Qvc2VydmVyLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgYW5kIG11c3Qgbm90IGV4aXN0LiAqKlRoZSBzeW1wdG9tIGlzXG4vLyBub3QgYSBjcmFzaCoqIOKAlCBgb3BlbmAgd2FpdHMgb3V0IGl0cyBoYW5kc2hha2UgZGVhZGxpbmUgYW5kIHJlcG9ydHMgYSBzdGFydFxuLy8gdGltZW91dCwgd2hpY2ggcmVhZHMgbGlrZSBhIHNsb3cgZmlyc3QgYnVuZGxlIGJ1aWxkLiBJdCBpcyBnbGFtb3VyJ3MgZXhhY3Rcbi8vIHNoaXBwZWQgZGVmZWN0LCBhbmQgYGRvY3MvcGxheWJvb2tzL3BvcnRpbmctYS1zcGVsbC1wbGF5Ym9vay5tZGAgQjQgcHJlZGljdGVkXG4vLyBpdCBoZXJlIGJlZm9yZSB0aGlzIGZpbGUgd2FzIHRvdWNoZWQuIFRoZSB1cC1hbmQtYmFjay1kb3duIGZvcm0gaXMgcmlnaHQgZnJvbVxuLy8gQk9USCBhZGRyZXNzZXMgKGBzY3JpcHRzL2AgYW5kIGBkaXN0L2ApLCB3aGljaCBpcyB3aHkgaXQgaXMgdGhlIGhvdXNlIGZvcm0uXG4vLyBgZ3JpbW9pcmUvc3Bhd24tcGF0aC13YXJkLnRlc3QudHNgIGlzIHRoZSBpbnN0cnVtZW50IHRoYXQgY2F0Y2hlcyBhXG4vLyByZWdyZXNzaW9uLCByZXNvbHZpbmcgdGhpcyBhcml0aG1ldGljIHRoZSB3YXkgdGhlIFJVTlRJTUUgd2lsbC5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyDim5QgQ09OVFJBQ1QgNSBMQU5EUyBPTiBXSE9FVkVSIFNQQVdOUyBUSEUgREFFTU9OLCBBTkQgVEhBVCBJUyBUSElTIEZJTEUuXG4vLyBCdW4gcmVhZHMgYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIGluIERFViBtb2RlIHRoZVxuLy8gZGFlbW9uJ3MgY3dkIE1VU1QgYmUgc3JjL2JvdW50eS8g4oCUIHNwYXduZWQgYW55d2hlcmUgZWxzZSB0aGUgZGV2IGJ1bmRsZXJcbi8vIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IGFuZCB0aGUgV0hPTEUgUEFHRSBmYWlscyAoNTAwLCBubyBzdHlsZXNoZWV0XG4vLyBsaW5rKSwgc2lsZW50bHksIHdpdGggbm90aGluZyByZWQgYW55d2hlcmUuIEluIFJFTEVBU0UgdGhlcmUgaXMgbm8gYnVuZGxpbmdcbi8vIGFuZCBubyBzcmMvIGF0IGFsbCAoYSBzb3VyY2UtZnJlZSBtYXJrZXRwbGFjZSBjbG9uZSBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLFxuLy8gc28gdGhlIGN3ZCBzdGF5cyBhdCB0aGUgc2tpbGwgcm9vdC4gVW50aWwgMjAyNi0wOS0wNiB0aGlzIHNwYXduIHBhc3NlZCB0aGVcbi8vIHNraWxsIHJvb3QgdW5jb25kaXRpb25hbGx5LCB3aGljaCB3YXMgY29ycmVjdCB3aGlsZSB0aGUgYm9hcmQgd2FzIGEgc2luZ2xlXG4vLyBzdGF0aWMgSFRNTCBmaWxlIGFuZCBpcyBub3QgY29ycmVjdCBub3cuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiYm91bnR5XCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cbmNvbnN0IFNOQVBTSE9UU19ESVIgPSBqb2luKHByb2Nlc3MuZW52LkJPVU5UWV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5ib3VudHlcIiksIFwic25hcHNob3RzXCIpO1xuXG50eXBlIFRhc2tTdGF0dXMgPSBcInRvZG9cIiB8IFwiZG9pbmdcIiB8IFwicmV2aWV3XCIgfCBcImRvbmVcIjtcbmNvbnN0IFZBTElEX1NUQVRVUzogVGFza1N0YXR1c1tdID0gW1widG9kb1wiLCBcImRvaW5nXCIsIFwicmV2aWV3XCIsIFwiZG9uZVwiXTtcblxudHlwZSBTZXNzaW9uID0ge1xuICB1cmw6IHN0cmluZztcbiAgcG9ydDogbnVtYmVyO1xuICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG59O1xuXG5mdW5jdGlvbiBkaWUobXNnOiBzdHJpbmcpOiBuZXZlciB7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBib3VudHk6ICR7bXNnfVxcbmApO1xuICBwcm9jZXNzLmV4aXQoMik7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzZXNzaW9uID8gam9pbih0bXBkaXIoKSwgYGJvdW50eS0ke3Nlc3Npb259Lmpzb25gKSA6IGpvaW4odG1wZGlyKCksIFwiYm91bnR5LWxhdGVzdC5qc29uXCIpO1xufVxuXG4vLyDilIDilIAgQ2FsbGVyLW93bmVkIHNlc3Npb24ga2V5cyAoIzY5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIEEgY29vcmRpbmF0aW5nIGNhbGxlciAoYW50aGlsbCwgb3IgYW55IG11bHRpLWJvYXJkIGNvbnN1bWVyKSBiaW5kcyBldmVyeVxuLy8gY29tbWFuZCB0byBJVFMgYm9hcmQgdmlhIGEga2V5IElUIGNob29zZXMg4oCUIGRldGVybWluaXN0aWMgYnkgY29uc3RydWN0aW9uLFxuLy8gbmV2ZXIgdGhlIGdsb2JhbCBgbGF0ZXN0YCBwb2ludGVyLCBhbmQgbmV2ZXIgYSByYW5kb20gZGFlbW9uLW1pbnRlZCBpZCBpdCBoYXNcbi8vIHRvIGNhcnJ5ICh3aGljaCBnb2VzIHN0YWxlKS4gVGhlIGtleSBpc24ndCBzdG9yZWQgYXMgYW4gb3BhcXVlIGhhbmRsZTsgaXRcbi8vIERFUklWRVMgYSBzdGFibGUgc2Vzc2lvbiBpZCwgc28gdGhlIHdob2xlIGV4aXN0aW5nIGJvdW50eS08aWQ+Lmpzb24gK1xuLy8gcmVzb2x2ZVNlc3Npb24gKyBsYXRlc3QgbWFjaGluZXJ5IHdvcmtzIHVuY2hhbmdlZC4gVGhlIGRlcml2ZWQgaWQgaXNcbi8vIFBST0pFQ1QtU0NPUEVEIChoYXNoZWQgd2l0aCB0aGUgcmVwbyByb290KSwgc28gdGhlIHNhbWUga2V5IGluIHR3byByZXBvcyBpc1xuLy8gdHdvIGJvYXJkcyDigJQgdGhlIGNvbGxpc2lvbiBndWFyZCBmb3IgXCJzYW1lIGtleSwgZGlmZmVyZW50IHByb2plY3RcIi4gU2FtZSBrZXkgK1xuLy8gc2FtZSByZXBvIGRlcml2ZXMgdGhlIFNBTUUgaWQg4oaSIGFuIGlkZW1wb3RlbnQgYG9wZW5gIGF0dGFjaGVzIChpbnRlbmRlZFxuLy8gc2hhcmUpLCBuZXZlciBoaWphY2tzOyBhIHZlcmIgaW4gYSBzdWJkaXIgYmluZHMgdGhlIHNhbWUgYm9hcmQgYG9wZW5gIG1hZGUgYXRcbi8vIHRoZSByb290LlxuXG4vLyBGaWxlc3lzdGVtLXNhZmUgc2x1ZyBvZiBhIGNhbGxlciBrZXk6IGxvd2VyY2FzZWQsIG5vbi1hbG51bSBydW5zIOKGkiBzaW5nbGVcbi8vIGRhc2gsIHRyaW1tZWQsIGNhcHBlZCDigJQga2VlcHMgdGhlIGRlcml2ZWQgaWQgbGVnaWJsZSAoYGstYW50aGlsbC10ZWFtLTxoYXNoPmApLlxuZXhwb3J0IGZ1bmN0aW9uIHNsdWdpZnlLZXkoa2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4ga2V5XG4gICAgLnRvTG93ZXJDYXNlKClcbiAgICAucmVwbGFjZSgvW15hLXowLTldKy9nLCBcIi1cIilcbiAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKVxuICAgIC5zbGljZSgwLCAzMik7XG59XG5cbi8vIFRoZSBzY29wZSBhIGtleSBiaW5kcyB0bzogdGhlIG5lYXJlc3QgYW5jZXN0b3IgaG9sZGluZyBhIGAuZ2l0YCBtYXJrZXIgKHRoZVxuLy8gcmVwbyByb290KSwgZWxzZSB0aGUgc3RhcnRpbmcgZGlyLiBXYWxraW5nIHRvIHRoZSByZXBvIHJvb3Qg4oCUIG5vdCByYXcgY3dkIOKAlFxuLy8gaXMgd2hhdCBtYWtlcyBgb3BlbmAgYXQgdGhlIHJvb3QgYW5kIGEgdmVyYiBpbiBhIHN1YmRpciBkZXJpdmUgdGhlIFNBTUUgaWQuXG4vLyBgZXhpc3RzYCBpcyBpbmplY3RlZCBzbyB0aGUgd2FsayBpcyBwdXJlL3Rlc3RhYmxlLlxuZXhwb3J0IGZ1bmN0aW9uIGZpbmRTY29wZVJvb3QoXG4gIHN0YXJ0RGlyOiBzdHJpbmcsXG4gIGV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbiA9IGV4aXN0c1N5bmMsXG4pOiBzdHJpbmcge1xuICBsZXQgZGlyID0gc3RhcnREaXI7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgaWYgKGV4aXN0cyhqb2luKGRpciwgXCIuZ2l0XCIpKSkgcmV0dXJuIGRpcjtcbiAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XG4gICAgaWYgKHBhcmVudCA9PT0gZGlyKSByZXR1cm4gc3RhcnREaXI7IC8vIG5vIHJlcG8gcm9vdCDihpIgdGhlIGN3ZCBpdHNlbGYgaXMgdGhlIHNjb3BlXG4gICAgZGlyID0gcGFyZW50O1xuICB9XG59XG5cbi8vIERlcml2ZSB0aGUgc3RhYmxlLCBwcm9qZWN0LXNjb3BlZCBib2FyZCBpZCBmb3IgYSBjYWxsZXIga2V5LiBEZXRlcm1pbmlzdGljOlxuLy8gc2FtZSAoa2V5LCBzY29wZVJvb3QpIOKGkiBzYW1lIGlkLCBhbHdheXMuXG5leHBvcnQgZnVuY3Rpb24gZGVyaXZlU2Vzc2lvbklkKGtleTogc3RyaW5nLCBzY29wZVJvb3Q6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHNsdWcgPSBzbHVnaWZ5S2V5KGtleSk7XG4gIGNvbnN0IHNjb3BlSGFzaCA9IGNyZWF0ZUhhc2goXCJzaGEyNTZcIikudXBkYXRlKHNjb3BlUm9vdCkuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDgpO1xuICByZXR1cm4gc2x1ZyA/IGBrLSR7c2x1Z30tJHtzY29wZUhhc2h9YCA6IGBrLSR7c2NvcGVIYXNofWA7XG59XG5cbi8vIFJlc29sdmUgYSBjYWxsZXIga2V5IHRvIGl0cyBib2FyZCBpZDogZmluZCB0aGUgc2NvcGUgcm9vdCBmcm9tIHN0YXJ0RGlyLCB0aGVuXG4vLyBkZXJpdmUuIFRoZSBzaW5nbGUgZW50cnkgcG9pbnQgc2hhcmVkIGJ5IHJlc29sdmVTZXNzaW9uICh2ZXJicykgYW5kIGNtZE9wZW5cbi8vIChzcGF3biksIHNvIGJvdGggYWdyZWUgb24gdGhlIGlkIGZvciBhIGdpdmVuIGtleSArIGN3ZC5cbmV4cG9ydCBmdW5jdGlvbiBzZXNzaW9uS2V5VG9JZChcbiAga2V5OiBzdHJpbmcsXG4gIHN0YXJ0RGlyOiBzdHJpbmcgPSBwcm9jZXNzLmN3ZCgpLFxuICBleGlzdHM6IChwYXRoOiBzdHJpbmcpID0+IGJvb2xlYW4gPSBleGlzdHNTeW5jLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGRlcml2ZVNlc3Npb25JZChrZXksIGZpbmRTY29wZVJvb3Qoc3RhcnREaXIsIGV4aXN0cykpO1xufVxuXG4vLyBSZXNvbHZlIHdoaWNoIGJvYXJkIGEgdmVyYiB0YXJnZXRzLCBpbiBwcmVjZWRlbmNlIG9yZGVyICgjNTksIGV4dGVuZGVkIGJ5XG4vLyAjNjkpIOKAlCBhbiB1bi1waW5uZWQgdmVyYiBtdXN0IE5PVCBzaWxlbnRseSBmYWxsIG9udG8gYSBzdHJhbmdlciBib2FyZCB0aGF0XG4vLyBtZXJlbHkgb3BlbmVkIG1vcmUgcmVjZW50bHk6XG4vLyAgIDEuIGAtLXNlc3Npb24ta2V5IDxrZXk+YCAoZmxhZ3MpIOKAlCBhIGNhbGxlci1vd25lZCBrZXksIERFUklWRUQgdG8gaXRzXG4vLyAgICAgIHNjb3BlZCBib2FyZCBpZCAoIzY5KTsgdGhlIG1vc3QgZXhwbGljaXQgXCJ0aGlzIGV4YWN0IGJvYXJkXCIgYVxuLy8gICAgICBjb29yZGluYXRvciBjYW4gc3RhdGUsIGJvdW5kIGJ5IGNvbnN0cnVjdGlvbjtcbi8vICAgMi4gZXhwbGljaXQgLS1zZXNzaW9uIDxpZD4gKGZsYWdzKSDigJQgYSByYXcgYm9hcmQgaWQ7XG4vLyAgIDMuICRCT1VOVFlfU0VTU0lPTl9LRVkgZW52IHZhciDigJQgYSBrZXksIGRlcml2ZWQgbGlrZSAoMSkgKCM2OSk7XG4vLyAgIDQuICRCT1VOVFlfU0VTU0lPTiBlbnYgdmFyIOKAlCBhIHJhdyBib2FyZCBpZDtcbi8vICAgNS4gdGhlIG5lYXJlc3QgYC5ib3VudHktc2Vzc2lvbmAgZmlsZSBmb3VuZCBieSB3YWxraW5nIFVQIGZyb20gY3dkIChpdHNcbi8vICAgICAgdHJpbW1lZCBjb250ZW50cyA9IHRoZSBib2FyZCBpZCkg4oCUIGEgcHJvamVjdC1yb290LXN0eWxlIG1hcmtlciBiaW5kaW5nXG4vLyAgICAgIGEgYm9hcmQgdG8gYSBkaXJlY3RvcnkgdHJlZSAod3JpdHRlbiBieSBgb3BlbiAtLXBpbmApO1xuLy8gICA2LiBvdGhlcndpc2UgdW5kZWZpbmVkIOKGkiB0aGUgY2FsbGVyIGZhbGxzIGJhY2sgdG8gdGhlIGBsYXRlc3RgIHBvaW50ZXJcbi8vICAgICAgKHByaW9yIGJlaGF2aW9yKS5cbi8vIGVudi9zdGFydERpci9yZWFkRmlsZS9leGlzdHMgYXJlIGluamVjdGVkIChsaWtlIHBpY2tUYWlsU2Vzc2lvbidzIGByZWFkYCkgc29cbi8vIHRoZSBwcmVjZWRlbmNlIGlzIHVuaXQtdGVzdGFibGUgd2l0aG91dCBhIHJlYWwgY3dkL2ZpbGVzeXN0ZW0uXG5mdW5jdGlvbiByZXNvbHZlU2Vzc2lvbihcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuICBlbnY6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4gPSBwcm9jZXNzLmVudixcbiAgc3RhcnREaXI6IHN0cmluZyA9IHByb2Nlc3MuY3dkKCksXG4gIHJlYWRGaWxlOiAocGF0aDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsID0gKHApID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHJlYWRGaWxlU3luYyhwLCBcInV0ZjhcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH0sXG4gIGV4aXN0czogKHBhdGg6IHN0cmluZykgPT4gYm9vbGVhbiA9IGV4aXN0c1N5bmMsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIGZsYWdzW1wic2Vzc2lvbi1rZXlcIl0gPT09IFwic3RyaW5nXCIpXG4gICAgcmV0dXJuIHNlc3Npb25LZXlUb0lkKGZsYWdzW1wic2Vzc2lvbi1rZXlcIl0sIHN0YXJ0RGlyLCBleGlzdHMpO1xuICBpZiAodHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIpIHJldHVybiBmbGFncy5zZXNzaW9uO1xuICBpZiAoZW52LkJPVU5UWV9TRVNTSU9OX0tFWSkgcmV0dXJuIHNlc3Npb25LZXlUb0lkKGVudi5CT1VOVFlfU0VTU0lPTl9LRVksIHN0YXJ0RGlyLCBleGlzdHMpO1xuICBpZiAoZW52LkJPVU5UWV9TRVNTSU9OKSByZXR1cm4gZW52LkJPVU5UWV9TRVNTSU9OO1xuICBsZXQgZGlyID0gc3RhcnREaXI7XG4gIHdoaWxlICh0cnVlKSB7XG4gICAgY29uc3QgY29udGVudHMgPSByZWFkRmlsZShqb2luKGRpciwgXCIuYm91bnR5LXNlc3Npb25cIikpO1xuICAgIGNvbnN0IGlkID0gY29udGVudHM/LnRyaW0oKTtcbiAgICBpZiAoaWQpIHJldHVybiBpZDtcbiAgICBjb25zdCBwYXJlbnQgPSBkaXJuYW1lKGRpcik7XG4gICAgaWYgKHBhcmVudCA9PT0gZGlyKSBicmVhazsgLy8gcmVhY2hlZCB0aGUgZmlsZXN5c3RlbSByb290XG4gICAgZGlyID0gcGFyZW50O1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiDim5QgTlVMTCBNRUFOUyBcIk5PIFNFU1NJT05cIiwgQU5EIE5PVEhJTkcgRUxTRS5cbiAqXG4gKiAgVGhpcyBjYXVnaHQgZXZlcnkgZXJyb3IgZnJvbSB0aGUgcmVhZCBhbmQgcmV0dXJuZWQgbnVsbCwgc28gYSBjb3JydXB0XG4gKiAgcG9pbnRlciwgYW4gRUFDQ0VTLCBhbmQgYW55IHRyYW5zaWVudCB0aGUgT1MgcmFpc2VzIHVuZGVyIGxvYWQgYWxsIGFycml2ZWRcbiAqICBhdCB0aGUgY2FsbGVycyB3ZWFyaW5nIGFic2VuY2UncyBjbG90aGVzIOKAlCBhbmQgdGhlIGNhbGxlcnMgYWN0IG9uIGFic2VuY2U6XG4gKiAgdGhleSByZXBvcnQgXCJubyBydW5uaW5nIHNlc3Npb25cIiwgYW5kIGEgdGFpbCBsb29wIHJlYWRzIGl0IGFzIFwidGhlIHBpbm5lZFxuICogIHNlc3Npb24gd2VudCBhd2F5XCIgYW5kIGV4aXRzIDAuIEEgcmVzb3VyY2UgZmFpbHVyZSB3YXMgdGhlcmVmb3JlIHJlcG9ydGVkXG4gKiAgYXMgYSBTVUNDRVNTRlVMIGVuZCBvZiB3YXRjaC5cbiAqXG4gKiAgTWVhc3VyZWQgaW4gZ2xhbW91ciwgd2hvc2UgY29weSBvZiB0aGlzIGZ1bmN0aW9uIGlzIGJ5dGUtaWRlbnRpY2FsOiBpdHMgQ0xJXG4gKiAgY29udHJhY3QgY2VsbCBmYWlsZWQgb25jZSB1bmRlciB0aGUgZnVsbCBnYXRlIHdpdGggdGhlIG5vdF9mb3VuZCBleGl0IHdoZXJlXG4gKiAgdGhlIGNvbnRyYWN0IHNhaWQgdXNhZ2UsIGFuZCBwYXNzZWQgYWxvbmUgYW5kIG9uIHJlLXJ1bi4gRml4ZWQgdGhlcmVcbiAqICAyMDI2LTA5LTA3OyBmb3VuZCBzdGlsbCBzdGFuZGluZyBoZXJlIDIwMjYtMDktMDggYnkgdGhlIGJhY2tlbmQgZHVwbGljYXRpb25cbiAqICByZWNvbiAoZG9jcy9pbnZlc3RpZ2F0aW9ucy8yMDI2LTA5LTA4LWJhY2tlbmQtZHVwbGljYXRpb24tcmVjb24ubWQpLlxuICpcbiAqICBFTk9FTlQgaXMgdGhlIG9ubHkgaG9uZXN0IGFic2VuY2UuIEV2ZXJ5dGhpbmcgZWxzZSBzYXlzIHdoYXQgaXQgd2FzLlxuICpcbiAqICDimqAgVGhlIGRhZW1vbiB3cml0ZXMgdGhpcyBmaWxlIGF0b21pY2FsbHkgKHNlcnZlci50cyksIHdoaWNoIGlzIHdoYXQgbGV0c1xuICogIHVucGFyc2VhYmxlIGNvbnRlbnQgY291bnQgYXMgY29ycnVwdGlvbiByYXRoZXIgdGhhbiBhIGhhbGYtd3JpdHRlbiByZWFkLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24gfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gbnVsbDtcbiAgICBkaWUoYGNhbm5vdCByZWFkIHRoZSBzZXNzaW9uIHBvaW50ZXIgKCR7Y29kZSA/PyBcInVua25vd24gZXJyb3JcIn0pOiAke3BhdGh9YCk7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb247XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgYm91bnR5IHNlc3Npb24g4oCUIHJ1bjogY2xpLnRzIG9wZW5cIik7XG4gIHJldHVybiBzO1xufVxuXG4vLyBSZXNvbHZlIHRoZSBzZXNzaW9uIGEgYHRhaWxgIHNob3VsZCByZWFkIG9uIHRoaXMgaXRlcmF0aW9uLCBhbmQgdGhlIGlkIGl0IGlzXG4vLyBub3cgUElOTkVEIHRvICgjdGFpbC1waW4pLiBUaGUgZmlyc3QgdGltZSBhbiB1bnBpbm5lZCB0YWlsIHJlc29sdmVzIGEgY29uY3JldGVcbi8vIHNlc3Npb24gKG9mZiB0aGUgZ2xvYmFsIGBsYXRlc3RgIHBvaW50ZXIpLCBpdCBsb2NrcyBvbnRvIHRoYXQgc2Vzc2lvbl9pZDtcbi8vIGV2ZXJ5IGxhdGVyIHJlY29ubmVjdCByZWFkcyBUSEFUIHNlc3Npb24ncyBvd24gZmlsZSwgbmV2ZXIgYGxhdGVzdGAgYWdhaW4g4oCUIHNvXG4vLyBhIG5ld2VyIGJvYXJkIG9wZW5pbmcgb24gdGhlIGhvc3QgY2FuJ3Qgc2lsZW50bHkgaGlqYWNrIGEgbG9uZy1saXZlZCB0YWlsLiBBblxuLy8gZXhwbGljaXQgLS1zZXNzaW9uIGlzIHBpbm5lZCBmcm9tIHRoZSBzdGFydC4gYHJlYWRgIGlzIGluamVjdGVkIHNvIHRoZSBsb29wJ3Ncbi8vIHJlc29sdXRpb24gaXMgdW5pdC10ZXN0YWJsZSB3aXRob3V0IHRvdWNoaW5nIHRoZSByYWNlLXByb25lIGdsb2JhbCBwb2ludGVyLlxuLy8gUmV0dXJucyBudWxsIHdoZW4gbm90aGluZyByZXNvbHZlcyB5ZXQgKG5vIGJvYXJkIHVwKSDigJQgdGhlIGNhbGxlciByZXRyaWVzLlxuZnVuY3Rpb24gcGlja1RhaWxTZXNzaW9uKFxuICBwaW5uZWQ6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcmVhZDogKHNlc3Npb24/OiBzdHJpbmcpID0+IFNlc3Npb24gfCBudWxsLFxuKTogeyBzZXNzaW9uOiBTZXNzaW9uOyBwaW5uZWQ6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IHMgPSByZWFkKHBpbm5lZCk7XG4gIGlmICghcykgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNlc3Npb246IHMsIHBpbm5lZDogcGlubmVkID8/IHMuc2Vzc2lvbl9pZCB9O1xufVxuXG4vLyBPd25lciBpZGVudGl0eSBpcyBjYXNlLWluc2Vuc2l0aXZlICgjb3duZXItY2FzZSk6IHRoZSBsZWFkIG1heSBhc3NpZ25cbi8vIGAtLW93bmVyIGxvb21gIHdoaWxlIHRoZSB3b3JrZXIgZmlsdGVycyBhcyBgLS1hcyBMb29tYCAoZ3JhcGV2aW5lIGFsaWFzZXMgYXJlXG4vLyBvZnRlbiBjYXBpdGFsaXplZCkuIEEgY2FzZS1zZW5zaXRpdmUgY29tcGFyZSBzaWxlbnRseSBlbXB0aWVkIGAtLW1pbmVgLlxuZnVuY3Rpb24gc2FtZU93bmVyKGE6IHN0cmluZyB8IHVuZGVmaW5lZCwgYjogc3RyaW5nIHwgdW5kZWZpbmVkKTogYm9vbGVhbiB7XG4gIHJldHVybiBhICE9PSB1bmRlZmluZWQgJiYgYiAhPT0gdW5kZWZpbmVkICYmIGEudG9Mb3dlckNhc2UoKSA9PT0gYi50b0xvd2VyQ2FzZSgpO1xufVxuXG4vLyBEb2VzIGEgdGFzay9ldmVudCB3aXRoIGBvd25lcmAgZmFsbCBpbiB0aGUgY2FsbGVyJ3Mgc2NvcGU/IFNoYXJlZCBieSBgc3RhdGVgXG4vLyBhbmQgYHRhaWxgIHNvIHRoZXkgZmlsdGVyIGlkZW50aWNhbGx5LiBgLS1vd25lciBYYCA9IGV4YWN0bHkgWCdzIChjYXNlLVxuLy8gaW5zZW5zaXRpdmUpOyBgLS1taW5lYCA9IG93biAoY2FzZS1pbnNlbnNpdGl2ZSkgKyBjbGFpbWFibGUgKHVub3duZWQpOyBub1xuLy8gc2NvcGUgPSBldmVyeXRoaW5nLlxuZnVuY3Rpb24gb3duZXJJblNjb3BlKFxuICBvd25lcjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzY29wZTogeyBvd25lcj86IHN0cmluZzsgbWluZT86IGJvb2xlYW47IGFzPzogc3RyaW5nIH0sXG4pOiBib29sZWFuIHtcbiAgaWYgKHNjb3BlLm93bmVyKSByZXR1cm4gc2FtZU93bmVyKG93bmVyLCBzY29wZS5vd25lcik7XG4gIGlmIChzY29wZS5taW5lKSByZXR1cm4gc2FtZU93bmVyKG93bmVyLCBzY29wZS5hcykgfHwgIW93bmVyO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUGFyc2UgYSBjb21tYS1zZXBhcmF0ZWQgYC0tdGFnYCB2YWx1ZSBpbnRvIGEgY2xlYW4gc3RyaW5nW10gKHRyaW0gZWFjaCwgZHJvcFxuLy8gZW1wdGllcywgZGVkdXBlKS4gU0VUIHNlbWFudGljczogdGhlIGxpc3QgUkVQTEFDRVMgdGhlIHRhc2sncyB0YWdzLCBtaXJyb3Jpbmdcbi8vIHRoZSBgYmxvY2sgLS1vbiBhLGJgIGNvbnZlbnRpb247IGAtLXRhZyBcIlwiYCB5aWVsZHMgW10gKGEgY2xlYXIpLiBUaGUgZGFlbW9uXG4vLyByZS1zYW5pdGl6ZXMgdmlhIGNsZWFuVGFncywgc28gdGhpcyBpcyB0aGUgY29udmVuaWVuY2UgbGF5ZXIsIG5vdCB0aGUgZ3VhcmQuXG5mdW5jdGlvbiBwYXJzZVRhZ3ModmFsdWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGNvbnN0IHJhdyBvZiB2YWx1ZS5zcGxpdChcIixcIikpIHtcbiAgICBjb25zdCB0ID0gcmF3LnRyaW0oKTtcbiAgICBpZiAodCAmJiAhb3V0LmluY2x1ZGVzKHQpKSBvdXQucHVzaCh0KTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vLyBIZWFydGJlYXQgc2l6aW5nIGZsYWdzICgjMjkpLiAtLXNpemUgU3xNfEwgKGNhc2UtaW5zZW5zaXRpdmUpOyBhbnl0aGluZyBlbHNlXG4vLyBpcyBpZ25vcmVkIHNvIGEgdHlwbyBjYW4ndCBzZXQgYSBib2d1cyBzaXplLiAtLWV4cGVjdCA8bWludXRlcz4gb3ZlcnJpZGVzIHRoZVxuLy8gc2l6ZSBkZWZhdWx0OyBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyLiBUaGUgZGFlbW9uIHJlLXZhbGlkYXRlcyBib3RoLlxuZnVuY3Rpb24gcGFyc2VTaXplKHZhbHVlOiBzdHJpbmcgfCBib29sZWFuIHwgdW5kZWZpbmVkKTogXCJTXCIgfCBcIk1cIiB8IFwiTFwiIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIHVuZGVmaW5lZDtcbiAgY29uc3QgcyA9IHZhbHVlLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICByZXR1cm4gcyA9PT0gXCJTXCIgfHwgcyA9PT0gXCJNXCIgfHwgcyA9PT0gXCJMXCIgPyBzIDogdW5kZWZpbmVkO1xufVxuZnVuY3Rpb24gcGFyc2VFeHBlY3QodmFsdWU6IHN0cmluZyB8IGJvb2xlYW4gfCB1bmRlZmluZWQpOiBudW1iZXIgfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gdW5kZWZpbmVkO1xuICBjb25zdCBtID0gTnVtYmVyKHZhbHVlLnRyaW0oKSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobSkgJiYgbSA+IDAgPyBtIDogdW5kZWZpbmVkO1xufVxuXG4vLyBQMWQg4oCUIHRoZSBMRU5JRU5DWSBTVEFZUyBhbmQgdGhlIGVudmVsb3BlIHNheXMgd2hhdCBpdCBjb3N0LlxuLy9cbi8vIGBwYXJzZVNpemVgL2BwYXJzZUV4cGVjdGAgZHJvcHBpbmcgYSBiYWQgdmFsdWUgaXMgYSBkZWxpYmVyYXRlIGFudGktdHlwb1xuLy8gcnVsaW5nIChzZWUgdGhlIGNvbW1lbnQgYWJvdmUgdGhlbSksIGFuZCByZXZlcnNpbmcgaXQgcmUtb3BlbnMgdGhhdCBoYXphcmQuXG4vLyBSdWxlZCBieSBDb2xlOiBrZWVwIHRoZSBsZW5pZW5jeSwgbWFrZSBpdCBBVURJQkxFLiBTbyB0aGUgZHJvcCBpcyB1bmNoYW5nZWRcbi8vIGFuZCB0aGUgY2FsbGVyIGlzIG5vdyBUT0xELlxuLy9cbi8vIOKaoCBUaGlzIGlzIHRoZSBgcmVzdG9yZVNraXBwZWRgIFNIQVBFIGFuZCBkZWxpYmVyYXRlbHkgbm90IGl0cyBuYW1lLCBiZWNhdXNlIGl0XG4vLyBpcyB0aGUgb3Bwb3NpdGUgRVZFTlQuIGByZXN0b3JlU2tpcHBlZGAgbWVhbnMgXCJ5b3VyIEVYUExJQ0lUIGAtLXJlc3RvcmVgIHdhc1xuLy8gdmFsaWQgYW5kIHRoZSBzaXR1YXRpb24gY291bGQgbm90IGhvbm91ciBpdFwiIOKAlCB0aGUgdXNlciBkaWQgbm90aGluZyB3cm9uZy5cbi8vIChFWFBMSUNJVCBpcyBsb2FkLWJlYXJpbmcgc2luY2UgYGZiMjA5ZjFgOiBhIGtleWVkIHJlc3Bhd24gcmVzdG9yZXMgQllcbi8vIERFRkFVTFQsIGJ1dCB0aGF0IHBhdGggcHVzaGVzIGEgc3Bhd24gYXJnIGFuZCBuZXZlciBzZXRzIGBmbGFncy5yZXN0b3JlYCwgc29cbi8vIGl0IGNhbiBuZXZlciBwb3B1bGF0ZSB0aGlzIGZpZWxkLiBUaGVyZSBpcyBPTkUgdHJpZ2dlciwgbm90IHR3byDigJQgYW5kIGFcbi8vIGRlZmF1bHQgcmVzdG9yZSBjYW5ub3QgYmUgXCJza2lwcGVkXCIgaW4gdGhpcyBmaWVsZCdzIHNlbnNlIGF0IGFsbCwgYmVjYXVzZSBpdHNcbi8vIGd1YXJkIGNvbmRpdGlvbiBJUyB0aGUgc2tpcCBjb25kaXRpb24uIFJ1bGVkIGFmdGVyIHRoZSB0cmlnZ2VyIGNvdW50IHdhc1xuLy8gZm91bmQgdG8gaGF2ZSBzaWxlbnRseSBkb3VibGVkIHVuZGVybmVhdGggdGhlIG9sZCB3b3JkaW5nLikgVGhpcyBtZWFucyBcInlvdXJcbi8vIHZhbHVlIHdhcyBpbnZhbGlkIGFuZCB3ZSBjaG9zZSB0byBpZ25vcmUgaXRcIiDigJQgdGhlIHVzZXIgbWFkZSBhIHR5cG8sIGFuZCB3aGF0XG4vLyB0aGV5IG5lZWQgaXMgdGhlIGxlZ2FsIHNldCwgbm90IGFuIGV4cGxhbmF0aW9uIGFib3V0IHRoZWlyIGJvYXJkLlxuLy9cbi8vIE5BTUUgYHZhbHVlc0lnbm9yZWRgIFJVTEVEIEJZIHRob3RoLiBUaHJlZSBwYXJ0cywgZWFjaCBvdmVydHVybmFibGU6XG4vLyAgIGBJZ25vcmVkYCBub3QgYFNraXBwZWRgIOKAlCBza2lwcGVkIGltcGxpZXMgYW4gT0JTVEFDTEUgKHRoZSBmbGFnIHdhcyBmaW5lLFxuLy8gICAgIHRoZSBzaXR1YXRpb24gd2FzIG5vdCwgd2hpY2ggaXMgYHJlc3RvcmVTa2lwcGVkYCk7IGlnbm9yZWQgaW1wbGllcyBhXG4vLyAgICAgQ0hPSUNFLiBjbGkudHM6MjU5IGFscmVhZHkgdXNlcyB0aGF0IHdvcmQgZm9yIHRoaXMgYmVoYXZpb3VyLlxuLy8gICBgdmFsdWVzYCBub3QgYHNpemVgL2BmbGFnc2Ag4oCUIGAtLXNpemVgIHdhcyBSRUNPR05JU0VEOyBpdCBwYXJzZWQsIGl0IGlzIGFcbi8vICAgICByZWFsIGZsYWcuIFdoYXQgd2FzIHVudXNhYmxlIHdhcyBpdHMgVkFMVUUuIGBpZ25vcmVkRmxhZ3NgIHdvdWxkIHNlbmQgYVxuLy8gICAgIHJlYWRlciBodW50aW5nIGZvciB3aGV0aGVyIHRoZSBmbGFnIGlzIHN1cHBvcnRlZCBhdCBhbGwuXG4vLyAgIEdyb3VwZWQgYnkgQ0FVU0UsIHByZXNlbnQtYW5kLW51bGwg4oCUIHRoZSBob3VzZSBzaGFwZSwgd2hvc2UgZmlyc3QgbWVtYmVyIGlzXG4vLyAgICAgYHJlc3RvcmVTa2lwcGVkYC4gQSBuZXcgZ3JvdXBlZCBmaWVsZCBlYXJucyBpdHMgcGxhY2Ugd2hlbiB0aGUgY2F1c2Vcbi8vICAgICBjaGFuZ2VzIHdoYXQgdGhlIENBTExFUiBET0VTOiByZXN0b3JlU2tpcHBlZCDihpIgZml4IHlvdXIgc2l0dWF0aW9uO1xuLy8gICAgIHZhbHVlc0lnbm9yZWQg4oaSIGZpeCB5b3VyIHR5cG8uIFNhbWUgcmVtZWR5IOKGkiBzYW1lIGZpZWxkLlxuLy9cbi8vIOKblCBUSEUgU0hBUEUgREVMSUJFUkFURUxZIERJVkVSR0VTIEZST00gYHJlc3RvcmVTa2lwcGVkYCwgQU5EIFRISVMgSVMgVEhFIE9ORVxuLy8gREVDSVNJT04gVEhBVCBJUyBNSU5FIFJBVEhFUiBUSEFOIHRob3RoJ3MuIGByZXN0b3JlU2tpcHBlZGAgaXNcbi8vIGB7cmVxdWVzdGVkOiBzdHJpbmdbXSwgcmVhc29uOiBzdHJpbmd9YCDigJQgb25lIHJlYXNvbiBmb3IgYWxsIGl0cyBmbGFncywgd2hpY2hcbi8vIGlzIGhvbmVzdCB0aGVyZSBiZWNhdXNlIHRoZXkgc2hhcmUgb25lIGNhdXNlIGJ5IGNvbnN0cnVjdGlvbiAodGhlIGJvYXJkIHdhc1xuLy8gbGl2ZSwgZnVsbCBzdG9wKS4gT3VycyBkbyBOT1Q6IGBhZGQgLS1zaXplIGJvZ3VzIC0tZXhwZWN0IGFiY2AgaXMgb25lIGNvbW1hbmRcbi8vIHdpdGggVFdPIGRpZmZlcmVudCByZWFzb25zLCBhbmQgYSBzaW5nbGUgYHJlYXNvbmAgc3RyaW5nIGlzIHdyb25nIGFib3V0XG4vLyB3aGljaGV2ZXIgZmxhZyBpdCBkb2VzIG5vdCBkZXNjcmliZS5cbi8vXG4vLyBTbyBlYWNoIGVudHJ5IGNhcnJpZXMgaXRzIG93biByZWFzb24uIEFuZCB0aGUga2V5IGlzIE5PVCByZXVzZWQ6IGNhbGxpbmcgaXRcbi8vIGByZXF1ZXN0ZWRgIHdoaWxlIGhvbGRpbmcgb2JqZWN0cywgd2hlbiBgcmVzdG9yZVNraXBwZWQucmVxdWVzdGVkYCBob2xkc1xuLy8gc3RyaW5ncywgd291bGQgZ2l2ZSBvbmUgaG91c2Uga2V5LW5hbWUgdHdvIGVsZW1lbnQgdHlwZXMg4oCUIGEgY29uc3VtZXIgdGhhdFxuLy8gbGVhcm5lZCB0aGUgZmlyc3QgYnJlYWtzIHNpbGVudGx5IG9uIHRoZSBzZWNvbmQuIERpdmVyZ2luZyBWSVNJQkxZIGlzIHNhZmVyXG4vLyB0aGFuIGRpdmVyZ2luZyB1bmRlciBhIHNoYXJlZCBuYW1lLlxudHlwZSBJZ25vcmVkVmFsdWUgPSB7IGZsYWc6IHN0cmluZzsgdmFsdWU6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfTtcblxuZnVuY3Rpb24gaWdub3JlZFZhbHVlcyhmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pOiBJZ25vcmVkVmFsdWVbXSB7XG4gIGNvbnN0IG91dDogSWdub3JlZFZhbHVlW10gPSBbXTtcbiAgLy8gQmFyZSBmbGFnIG5hbWVzLCBtYXRjaGluZyBgcmVzdG9yZVNraXBwZWQucmVxdWVzdGVkYCdzIGNvbnZlbnRpb24uXG4gIGlmICh0eXBlb2YgZmxhZ3Muc2l6ZSA9PT0gXCJzdHJpbmdcIiAmJiBwYXJzZVNpemUoZmxhZ3Muc2l6ZSkgPT09IHVuZGVmaW5lZClcbiAgICBvdXQucHVzaCh7IGZsYWc6IFwic2l6ZVwiLCB2YWx1ZTogZmxhZ3Muc2l6ZSwgcmVhc29uOiBcIm5vdCBvbmUgb2YgU3xNfExcIiB9KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5leHBlY3QgPT09IFwic3RyaW5nXCIgJiYgcGFyc2VFeHBlY3QoZmxhZ3MuZXhwZWN0KSA9PT0gdW5kZWZpbmVkKVxuICAgIG91dC5wdXNoKHsgZmxhZzogXCJleHBlY3RcIiwgdmFsdWU6IGZsYWdzLmV4cGVjdCwgcmVhc29uOiBcIm5vdCBhIHBvc2l0aXZlIG51bWJlclwiIH0pO1xuICByZXR1cm4gb3V0O1xufVxuXG4vLyBNaXJyb3IgdG8gc3RkZXJyLCB0aGUgaG91c2UgcGF0dGVybiBmb3IgYW4gYWR2aXNvcnkgKGVkZ2VEcmFmdFdhcm5pbmcsIHRoZVxuLy8gdGFncyBzb2Z0LWNhcCwgdGhlIHVua25vd24tY2hhbm5lbCBhZHZpc29yeSk6IHRoZSBKU09OIGVudmVsb3BlIGNhcnJpZXMgaXQgZm9yXG4vLyBhIHBhcnNlciwgc3RkZXJyIGNhcnJpZXMgaXQgZm9yIGEgaHVtYW4sIGFuZCBuZWl0aGVyIGlzIHRoZSBvbmx5IGNvcHkuXG5mdW5jdGlvbiB3YXJuSWdub3JlZChpZ25vcmVkOiBJZ25vcmVkVmFsdWVbXSk6IHZvaWQge1xuICBmb3IgKGNvbnN0IGkgb2YgaWdub3JlZClcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgYm91bnR5OiBpZ25vcmVkIC0tJHtpLmZsYWd9ICR7SlNPTi5zdHJpbmdpZnkoaS52YWx1ZSl9IOKAlCAke2kucmVhc29ufVxcbmApO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG4vLyBTcGxpdCBhcmd2IGludG8gcG9zaXRpb25hbHMgKyBmbGFncy4gYC0tZmxhZyB2YWx1ZWAgb3IgYm9vbGVhbiBgLS1mbGFnYC5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS5cbi8vXG4vLyBUaGUgaGFuZC1yb2xsZWQgcGFyc2VyIHRoaXMgcmVwbGFjZXMgaGFkIHRocmVlIGRlZmVjdHMgYW5kIGV2ZXJ5IG9uZSBvZiB0aGVtXG4vLyB3YXMgc2lsZW50OlxuLy9cbi8vICAgLS1vd25lcj1hbGljZSAgICAgICAgdGhlIHdob2xlIGBvd25lcj1hbGljZWAgYmVjYW1lIGEgYm9vbGVhbiBrZXksIHNvIHRoZVxuLy8gICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZSB3YXMgRFJPUFBFRCBhbmQgYSByZWFkIGZpbHRlciBtYXRjaGVkIG5vdGhpbmcg4oCUXG4vLyAgICAgICAgICAgICAgICAgICAgICAgIGEgcmVhZCByZXR1cm5lZCB0aGUgV0hPTEUgQk9BUkQgaW5zdGVhZCBvZiBhIHN1YnNldFxuLy8gICAtLXRvdGFsbHktYm9ndXMgICAgICBhY2NlcHRlZCwgZXhpdCAwLCB2ZXJiIHJhbiBhbnl3YXlcbi8vICAgYWRkIHdyaXRlIHRoZSAtLWRyYWZ0IHNlY3Rpb25cbi8vICAgICAgICAgICAgICAgICAgICAgICAgYC0tZHJhZnRgIHdhcyByZWFkIGFzIGEgZmxhZywgc28gdGhlIHRpdGxlIHNpbGVudGx5XG4vLyAgICAgICAgICAgICAgICAgICAgICAgIFRSVU5DQVRFRCB0byBcIndyaXRlIHRoZVwiIGF0IGV4aXQgMFxuLy9cbi8vIGBub2RlOnV0aWxgIHN0cmljdCBnaXZlcyBhbGwgdGhyZWUgZml4ZXMgZnJvbSB0aGUgc3RhbmRhcmQgbGlicmFyeSDigJQgYD1gXG4vLyBzdXBwb3J0LCB1bmtub3duLWZsYWcgcmVqZWN0aW9uLCBhbmQgdGhlIGAtLWAgdGVybWluYXRvciDigJQgaW4gdGhlIHNoYXBlXG4vLyBqb2luLnRzIGFuZCBzZXJ2ZXIudHMgaW4gdGhpcyB2ZXJ5IHNwZWxsIGFscmVhZHkgdXNlLiBUaGF0IG1ha2VzIFwidGhyZWVcbi8vIHNwZWxsaW5ncyBvZiBvbmUgaWRlYVwiIGltcG9zc2libGUgYnkgY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGRpc2NpcGxpbmUuXG4vL1xuLy8g4pqgIFRIRSBUWVBFUyBBUkUgTE9BRC1CRUFSSU5HIEFORCBHRVRUSU5HIE9ORSBXUk9ORyBJUyBOT1QgQSBOTy1PUDpcbi8vICAgYSBcInN0cmluZ1wiIHRoYXQgc2hvdWxkIGJlIGJvb2xlYW4gU1dBTExPV1MgVEhFIE5FWFQgUE9TSVRJT05BTCBhcyBpdHMgdmFsdWVcbi8vICAgYSBcImJvb2xlYW5cIiB0aGF0IHNob3VsZCBiZSBzdHJpbmcgYnJlYWtzIGAtLW93bmVyIGFsaWNlYCAoYWxpY2UgYmVjb21lcyBhXG4vLyAgIHBvc2l0aW9uYWwpXG4vLyBCb3RoIGFyZSBzaWxlbnQgZW5vdWdoIHRvIHNoaXAuIFRoaXMgc2V0IGlzIHRob3RoJ3MgYXVkaXRlZCBhcnRpZmFjdFxuLy8gKGBkb2NzL3Byb2plY3RzL3NwZWxsLWhhcmRlbmluZy9hcnRpZmFjdHMvcDBjLXJlY29nbml6ZWQtZmxhZy1zZXRzLm1kYCk6XG4vLyAyMiBmbGFncywgMTUgc3RyaW5nIC8gNyBib29sZWFuLCBlYWNoIHNldHRsZWQgYnkgdW5hbWJpZ3VvdXMgZXZpZGVuY2UgYXRcbi8vIEVWRVJZIGNvbnN1bXB0aW9uIHNpdGUuIGBleHBlY3RgIGFuZCBgc2l6ZWAgYXJlIHN0cmluZyBiZWNhdXNlIHRoZXkgdHlwZSBvZmZcbi8vIHBhcnNlRXhwZWN0L3BhcnNlU2l6ZSwgbm90IG9mZiB0aGUgYmFyZSB0cnV0aGluZXNzIGF0IHRoZSBjYWxsIHNpdGUuXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBleHBlY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBvd25lcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJzZXNzaW9uLWtleVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaXplOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGFnOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJlc2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBtaW5lOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHBpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcInN0ZGluLXRhc2tzXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8vIEEgdXNhZ2UgZmFpbHVyZSBpcyBUSFJPV04gcmF0aGVyIHRoYW4gZXhpdGluZywgc28gYG1haW5gIGNhbiByZXR1cm4gMiBhbmQgbGV0XG4vLyB0aGUgcnVudGltZSBkcmFpbiBzdGRvdXQg4oCUIGBkaWUoKWAgaXMgcHJvY2Vzcy5leGl0LCB3aGljaCBpcyB0aGUgZGVmZWN0IHRoaXNcbi8vIHNwcmludCdzIHNpYmxpbmcgbGFuZXMgZXhpc3QgdG8gcmVtb3ZlLiBTYW1lIHJlYXNvbiB0aGUgIzgwLjEgcmVmdXNhbCBkb2VzXG4vLyBub3Qgcm91dGUgdGhyb3VnaCBkaWUoKSBlaXRoZXIuXG5jbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuZnVuY3Rpb24gcGFyc2VBcmdzKGFyZ3M6IHN0cmluZ1tdKToge1xuICBwb3M6IHN0cmluZ1tdO1xuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG59IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJncyxcbiAgICAgIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgICByZXR1cm4ge1xuICAgICAgcG9zOiBwb3NpdGlvbmFscyxcbiAgICAgIGZsYWdzOiB2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIC8vIG5vZGU6dXRpbCBuYW1lcyB0aGUgb2ZmZW5kaW5nIHRva2VuOyBrZWVwIHRoYXQgYW5kIGFkZCB0aGUgZXNjYXBlIGhhdGNoLFxuICAgIC8vIGJlY2F1c2UgdGhlIG1vc3QgbGlrZWx5IHZpY3RpbSBpcyBmcmVlIHByb3NlIGNvbnRhaW5pbmcgYSBkYXNoLWRhc2ggd29yZFxuICAgIC8vIChgYWRkIHdyaXRlIHRoZSAtLWRyYWZ0IHNlY3Rpb25gKSwgd2hpY2ggVE9EQVkgdHJ1bmNhdGVzIHNpbGVudGx5LlxuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgIGAke2RldGFpbH1cXG5gICtcbiAgICAgICAgYCAgcmVjb2duaXplZCBmbGFnczogJHtPYmplY3Qua2V5cyhDTElfT1BUSU9OUylcbiAgICAgICAgICAubWFwKChrKSA9PiBgLS0ke2t9YClcbiAgICAgICAgICAuam9pbihcIiBcIil9XFxuYCArXG4gICAgICAgIGAgIGZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMsIHVzZSAtLXN0ZGluLCBvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tYCxcbiAgICApO1xuICB9XG59XG5cbnR5cGUgQ21kUmVzdWx0ID0geyBvaz86IGJvb2xlYW47IGFwcGxpZWQ/OiBib29sZWFuOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBUaGUgY2FsbGVyJ3MgaWRlbnRpdHksIHN0YW1wZWQgb250byB0aGUgZXZlbnQgYGJ5YCBzbyBhIHNjb3BlZCB0YWlsIGNhblxuLy8gZmlsdGVyICsgc3VwcHJlc3Mgc2VsZi1lY2hvLiAtLWFzIHdpbnMsIGVsc2UgJEJPVU5UWV9BUywgZWxzZSB1bmRlZmluZWQuXG5mdW5jdGlvbiByZXNvbHZlQXMoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiBmbGFncy5hcyA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIGZsYWdzLmFzO1xuICByZXR1cm4gcHJvY2Vzcy5lbnYuQk9VTlRZX0FTIHx8IHVuZGVmaW5lZDtcbn1cblxuLy8gUE9TVCBhIGNvbW1hbmQ7IG1lcmdlIHRoZSBjYWxsZXIncyBgYXNgIGlkZW50aXR5IGluOyByZXR1cm4gdGhlIGFwcGx5LXJlc3VsdC5cbi8vIFBhc3MgYHF1aWV0YCBmb3IgdmVyYnMgdGhhdCBwcmludCB0aGVpciBvd24gb3V0Y29tZSAoZS5nLiBjbGFpbSkuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKFxuICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIG9wdHM6IHsgYXM/OiBzdHJpbmc7IHF1aWV0PzogYm9vbGVhbiB9ID0ge30sXG4pOiBQcm9taXNlPENtZFJlc3VsdD4ge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IGJvZHkgPSBvcHRzLmFzID8geyAuLi5tc2csIGFzOiBvcHRzLmFzIH0gOiBtc2c7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgY21kIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pIOKAlCBpcyB0aGUgc2Vzc2lvbiBzdGlsbCBhbGl2ZT9gKTtcbiAgaWYgKCFvcHRzLnF1aWV0KSBwcmludEpzb24oeyBvazogdHJ1ZSwgc2VudDogbXNnLnR5cGUgfSk7XG4gIHJldHVybiAoZGF0YSA/PyB7fSkgYXMgQ21kUmVzdWx0O1xufVxuXG4vLyAjODMg4oCUIGhvbm91ciB0aGUgZGFlbW9uJ3MgdmVyZGljdCBmb3IgZXZlcnkgdmVyYiB0aGF0IGhhcyBubyBiZXNwb2tlIHJlc3VsdFxuLy8gaGFuZGxpbmcuIEEgRlVOTkVMLCBkZWxpYmVyYXRlbHksIHJhdGhlciB0aGFuIHRoZSBzYW1lIHRocmVlIGxpbmVzIHBhc3RlZCBhdFxuLy8gZm91ciBjYWxsIHNpdGVzOiBhIHByb3NlIGNvbnZlbnRpb24gKFwicmVtZW1iZXIgdG8gY2hlY2sgYGFwcGxpZWRgXCIpIGlzIG5vdFxuLy8gaW5oZXJpdGFibGUgYW5kIGlzIGV4YWN0bHkgaG93IGBhZGRgIGNhbWUgdG8gYmUgdGhlIG9kZCBvbmUgb3V0IGFtb25nIGZpdmVcbi8vIHdyaXRlIHZlcmJzLiBBIGZ1dHVyZSB2ZXJiIGluaGVyaXRzIHRoZSBjb250cmFjdCBieSByb3V0aW5nIHRocm91Z2ggaGVyZS5cbi8vXG4vLyBUaGUgYGFwcGxpZWQgPT09IGZhbHNlYCB0ZXN0IGlzIGV4cGxpY2l0LCBub3QgdHJ1dGhpbmVzczogYSBkYWVtb24gdGhhdCBvbWl0c1xuLy8gdGhlIGZpZWxkIGVudGlyZWx5IChhbiBvbGRlciBidWlsZCwgb3IgYSBjb21tYW5kIHR5cGUgaXQgYW5zd2VycyB3aXRob3V0IGFcbi8vIHZlcmRpY3QpIG11c3Qga2VlcCBpdHMgYWNrIHJhdGhlciB0aGFuIGJlaW5nIHJlcG9ydGVkIGFzIGEgZmFpbHVyZSDigJQgYWJzZW50IGlzXG4vLyBub3QgdGhlIHNhbWUgYXMgZmFsc2UsIGFuZCBjb25mbGF0aW5nIHRoZW0gd291bGQgdHVybiBhIHZlcnNpb24gc2tldyBpbnRvIGFcbi8vIHN0b3JtIG9mIGZha2UgZXJyb3JzLlxuLy8gVGhlIGZhaWx1cmUgRU5WRUxPUEUgY2FycmllcyBgYXBwbGllZDogZmFsc2VgIG9uIHN0ZG91dCwgYmVzaWRlIHRoZSBub24temVyb1xuLy8gZXhpdCBhbmQgdGhlIGh1bWFuIGxpbmUgb24gc3RkZXJyIOKAlCB0aGUgc2FtZSB0d28tY2hhbm5lbCBzaGFwZSBQMGIncyByZWZ1c2FsXG4vLyB1c2VzLiBUaGUgZXhpdCBjb2RlIGlzIHdoYXQgYSBgc2V0IC1lYCB3cmFwcGVyIG9yIGEgTW9uaXRvciBjYXRjaGVzOyB0aGVcbi8vIGVudmVsb3BlIGlzIHdoYXQgYW4gYWdlbnQgcGFyc2VzLiBSZXBvcnRpbmcgb25seSBvbiBzdGRlcnIgd291bGQgbGVhdmUgYVxuLy8gc3Rkb3V0IHJlYWRlciB3aXRoIGFuIGVtcHR5IHBheWxvYWQsIHdoaWNoIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSB2ZXJiXG4vLyB0aGF0IHByb2R1Y2VkIG5vIG91dHB1dCBmb3IgYSBiZW5pZ24gcmVhc29uLlxuZnVuY3Rpb24gYWNrT3JGYWlsKHR5cGU6IHVua25vd24sIHJlczogQ21kUmVzdWx0KTogbnVtYmVyIHtcbiAgaWYgKHJlcy5hcHBsaWVkID09PSBmYWxzZSkge1xuICAgIGNvbnN0IGVycm9yID0gcmVzLmVycm9yID8/IGB0aGUgZGFlbW9uIGRpZCBub3QgYXBwbHkgJHtTdHJpbmcodHlwZSl9IOKAlCB0aGUgYm9hcmQgaXMgdW5jaGFuZ2VkYDtcbiAgICBwcmludEpzb24oeyBvazogZmFsc2UsIGFwcGxpZWQ6IGZhbHNlLCBzZW50OiB0eXBlLCBlcnJvciB9KTtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgYm91bnR5OiAke2Vycm9yfVxcbmApO1xuICAgIHJldHVybiAxO1xuICB9XG4gIC8vIGI4IOKAlCBmb3J3YXJkIHRoZSBkYWVtb24ncyBkcm9wIHJlcG9ydCB3aGVuIHRoZXJlIGlzIG9uZS4gYGluaXRgIGZpbHRlcnNcbiAgLy8gdW50cnVzdGVkIHRhc2tzIGFuZCB1c2VkIHRvIHNheSBub3RoaW5nLCBzbyAxOCB0YXNrcyBpbiAvIDAgc2VlZGVkIGFuc3dlcmVkXG4gIC8vIHtvazp0cnVlfS4gVGhlIGZpZWxkIHJpZGVzIHRoZSBBQ0sgYmVjYXVzZSB0aGF0IGlzIHRoZSByZXNwb25zZSB0aGUgY2FsbGVyXG4gIC8vIHJlYWRzOyBpdCBpcyBvbWl0dGVkIHJhdGhlciB0aGFuIG51bGwtc3R1ZmZlZCBvbiB2ZXJicyB0aGF0IG5ldmVyIGRyb3AsIGFuZFxuICAvLyB0aGUgZGFlbW9uIHNlbmRzIG51bGwgb24gYW4gaW5pdCB0aGF0IGRyb3BwZWQgbm90aGluZyAocHJlc2VudC1hbmQtbnVsbFxuICAvLyB3aGVyZSBpdCBpcyBtZWFuaW5nZnVsLCBhYnNlbnQgd2hlcmUgaXQgaXMgbm90IGFwcGxpY2FibGUpLlxuICBjb25zdCBkcm9wcGVkID0gKHJlcyBhcyB7IHRhc2tzRHJvcHBlZD86IHVua25vd24gfSkudGFza3NEcm9wcGVkO1xuICBpZiAoZHJvcHBlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IHR5cGUsIHRhc2tzRHJvcHBlZDogZHJvcHBlZCB9KTtcbiAgICBpZiAoZHJvcHBlZCAmJiB0eXBlb2YgZHJvcHBlZCA9PT0gXCJvYmplY3RcIikge1xuICAgICAgY29uc3QgZCA9IGRyb3BwZWQgYXMgeyByZXF1ZXN0ZWQ6IG51bWJlcjsgZHJvcHBlZDogeyBpbmRleDogbnVtYmVyOyByZWFzb246IHN0cmluZyB9W10gfTtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgYm91bnR5OiAke2QuZHJvcHBlZC5sZW5ndGh9IG9mICR7ZC5yZXF1ZXN0ZWR9IHRhc2socykgd2VyZSBEUk9QUEVEIGFuZCBub3Qgc2VlZGVkOlxcbmAsXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCBpdGVtIG9mIGQuZHJvcHBlZCkgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCAgWyR7aXRlbS5pbmRleH1dICR7aXRlbS5yZWFzb259XFxuYCk7XG4gICAgfVxuICAgIHJldHVybiAwO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiB0eXBlIH0pO1xuICByZXR1cm4gMDtcbn1cblxuZnVuY3Rpb24gbmV3VGFza0lkKCk6IHN0cmluZyB7XG4gIHJldHVybiBgdC0ke2NyeXB0by5yYW5kb21VVUlEKCkuc2xpY2UoMCwgOCl9YDtcbn1cblxuLy8g4pSA4pSAIHZlcmJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBSZWFkIGEgYm9hcmQncyBkaXNjb3ZlcnkgZmlsZSBhbmQgY29uZmlybSBpdHMgZGFlbW9uIGFjdHVhbGx5IGFuc3dlcnMg4oCUIHRoZVxuLy8gYXR0YWNoLXZzLXNwYXduIGRlY2lzaW9uIGZvciBrZXllZCBvcGVuICgjNjkpLiBSZXR1cm5zIHRoZSBsaXZlIFNlc3Npb24sIG9yXG4vLyBudWxsIGlmIGFic2VudCBvciBzdGFsZS5cbmFzeW5jIGZ1bmN0aW9uIGJvYXJkSWZMaXZlKHNlc3Npb246IHN0cmluZyk6IFByb21pc2U8U2Vzc2lvbiB8IG51bGw+IHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vc3RhdGVgKTtcbiAgICByZXR1cm4gci5vayA/IHMgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyAtLXBpbjogYmluZCBhIGJvYXJkIHRvIHRoZSBjd2Qgc28gdW4tcGlubmVkIHZlcmJzIHJ1biBoZXJlIHJlc29sdmUgdG8gaXQgKHZpYVxuLy8gdGhlIGAuYm91bnR5LXNlc3Npb25gIHdhbGstdXAgaW4gcmVzb2x2ZVNlc3Npb24pIGluc3RlYWQgb2YgdGhlIG1hY2hpbmUtd2lkZVxuLy8gYGxhdGVzdGAgcG9pbnRlciAoIzU5KS4gRm9yIGEga2V5ZWQgb3BlbiB0aGlzIHBlcnNpc3RzIHRoZSBERVJJVkVEIGlkLCBzbyB0aGVcbi8vIHBpbm5lZCBtYXJrZXIgYW5kIGEgZnJlc2ggYC0tc2Vzc2lvbi1rZXlgIGRlcml2ZSB0byB0aGUgc2FtZSBib2FyZC5cbmZ1bmN0aW9uIHdyaXRlUGluKHNlc3Npb25JZDogc3RyaW5nKSB7XG4gIGNvbnN0IHBpblBhdGggPSBqb2luKHByb2Nlc3MuY3dkKCksIFwiLmJvdW50eS1zZXNzaW9uXCIpO1xuICB0cnkge1xuICAgIHdyaXRlRmlsZVN5bmMocGluUGF0aCwgYCR7c2Vzc2lvbklkfVxcbmApO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHBpbm5lZCBib2FyZCAke3Nlc3Npb25JZH0g4oaSICR7cGluUGF0aH1cXG5gKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGJvdW50eTogY291bGQgbm90IHdyaXRlICR7cGluUGF0aH06ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmAsXG4gICAgKTtcbiAgfVxufVxuXG4vLyAjODAuMSDigJQgZmxhZ3Mgd2hvc2UgRUZGRUNUIElTIExPU1Qgb24gdGhlIGlkZW1wb3RlbnQtYXR0YWNoIHBhdGguXG4vL1xuLy8gVGhlIGF0dGFjaCBicmFuY2ggYmVsb3cgUkVUVVJOUyBiZWZvcmUgdGhlIGRhZW1vbiBhcmd1bWVudCBsaXN0IGlzIGJ1aWx0LCBzb1xuLy8gZXZlcnkgZmxhZyB0aGF0IG9ubHkgZXZlciB0YWtlcyBlZmZlY3QgYXMgYSBkYWVtb24gYXJnIGlzIHNpbGVudGx5IGRpc2NhcmRlZDpcbi8vIHRoZSBjYWxsZXIgYXNrcyBmb3IgYSBmb3VyLWhvdXIgdGltZW91dCwgZ2V0cyB0aGlydHkgc2Vjb25kcywgYW5kIGlzIHRvbGRcbi8vIG5vdGhpbmcuIGAtLXJlc3RvcmVgIHdhcyBvbmx5IGV2ZXIgb25lIG9mIHRocmVlIHN5bXB0b21zIG9mIHRoYXQgb25lIHJldHVybi5cbi8vXG4vLyDimqAgREVSSVZFIFRISVMgU0VUIEJZIExPU1QgRUZGRUNULCBORVZFUiBCWSBQT1NJVElPTi4gXCJBcHBlbmRlZCBwYXN0IHRoZVxuLy8gcmV0dXJuXCIgYW5kIFwibm90IGhvbm91cmVkIG9uIGF0dGFjaFwiIGxvb2sgbGlrZSB0d28gc3BlbGxpbmdzIG9mIG9uZSBzZXQgYW5kXG4vLyB0aGV5IGFyZSBub3Qg4oCUIHRoZSBwb3NpdGlvbmFsIHJlYWRpbmcgaXMgd3JvbmcgaW4gQk9USCBkaXJlY3Rpb25zIGF0IG9uY2U6XG4vL1xuLy8gICAtLXRpdGxlICAgIGxvc3QgICAgICBNSVNTRUQgYnkgYSBwb3NpdGlvbmFsIGN1dG9mZiAoYXBwZW5kZWQgYmVmb3JlIC0tcmVzdG9yZSlcbi8vICAgLS10aW1lb3V0ICBsb3N0ICAgICAgTUlTU0VEIGJ5IGEgcG9zaXRpb25hbCBjdXRvZmYgKGxpa2V3aXNlKVxuLy8gICAtLXJlc3RvcmUgIGxvc3QgICAgICBjYXVnaHQgZWl0aGVyIHdheVxuLy8gICAtLW5vLW9wZW4gIGhvbm91cmVkICBXUk9OR0xZIElOQ0xVREVEIGJ5IGEgcG9zaXRpb25hbCBjdXRvZmYg4oCUIG9uIHRoZSBhdHRhY2hcbi8vICAgICAgICAgICAgICAgICAgICAgICAgcGF0aCB0aGVyZSBpcyBub3RoaW5nIHRvIG9wZW4sIHNvIGl0IGlzIFZBQ1VPVVNMWVxuLy8gICAgICAgICAgICAgICAgICAgICAgICBob25vdXJlZDsgdGhlIGNhbGxlciBhc2tlZCBmb3IgYSB0aGluZyBhbHJlYWR5IHRydWVcbi8vICAgLS1waW4gICAgICBob25vdXJlZCAgbmV2ZXIgcmVhY2hlZCBieSBhIHBvc2l0aW9uYWwgY3V0b2ZmIGF0IGFsbCDigJQgaXQgcnVuc1xuLy8gICAgICAgICAgICAgICAgICAgICAgICBJTlNJREUgdGhlIGF0dGFjaCBicmFuY2gsIGFib3ZlIHRoZSByZXR1cm5cbi8vXG4vLyBSZWZ1c2luZyBvbiAtLW5vLW9wZW4gb3IgLS1waW4gd291bGQgbWFrZSBldmVyeSBjYWxsZXIgdGhhdCByZWpvaW5zIGEgbGl2ZVxuLy8gYm9hcmQgc3RhcnQgZmFpbGluZyAoYG9wZW4gLS1zZXNzaW9uLWtleSBLIC0tcGluIC0tbm8tb3BlbmAgaXMgYSByZWFsLCBsaXZlXG4vLyBpbnZvY2F0aW9uKSDigJQgdGhpcyBsYW5lJ3Mgb3duIGN1cmUgaW5mbGljdGluZyB0aGlzIGxhbmUncyBvd24gZGlzZWFzZS5cbi8vXG4vLyBUaGUgbWVtYmVyc2hpcCB0ZXN0IGlzIGBCb29sZWFuKGZsYWdzW2ZdKWAsIGRlbGliZXJhdGVseSB0aGUgU0FNRSB0cnV0aGluZXNzXG4vLyB0aGUgZGFlbW9uLWFyZyBjb25zdHJ1Y3Rpb24gdXNlcywgc28gXCJ3ZSByZWZ1c2UgaXRcIiBhbmQgXCJpdCB3b3VsZCBoYXZlIGhhZCBhblxuLy8gZWZmZWN0XCIgY2Fubm90IGRyaWZ0IGFwYXJ0LlxuY29uc3QgQVRUQUNIX0xPU1RfRkxBR1MgPSBbXCJ0aXRsZVwiLCBcInRpbWVvdXRcIiwgXCJyZXN0b3JlXCJdIGFzIGNvbnN0O1xuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vICM2OTogYSBjYWxsZXItb3duZWQga2V5IGRlcml2ZXMgYSBkZXRlcm1pbmlzdGljLCBwcm9qZWN0LXNjb3BlZCBib2FyZCBpZCwgYW5kXG4gIC8vIGBvcGVuYCBiZWNvbWVzIElERU1QT1RFTlQgYWdhaW5zdCBpdCDigJQgYSBsaXZlIGJvYXJkIGZvciB0aGUga2V5IGlzIEFUVEFDSEVEXG4gIC8vIHRvIChub3RoaW5nIHNwYXduZWQpLCBhIGRlYWQvYWJzZW50IG9uZSBpcyAocmUpc3Bhd25lZCB1bmRlciB0aGUgc2FtZSBpZC4gU29cbiAgLy8gcmUtcnVubmluZyBvcGVuLCBvciByZXVzaW5nIHRoZSBrZXkgYWZ0ZXIgYSBjcmFzaCwgQ09OVkVSR0VTIG9uIG9uZSBib2FyZFxuICAvLyBpbnN0ZWFkIG9mIGZvcmtpbmcgYSBzdHJhbmdlciBkYWVtb24uIGAtLWZyZXNoYCBmb3JjZXMgYSBjbGVhbiBib2FyZCAodGVhcnNcbiAgLy8gZG93biBhbnkgbGl2ZSBvbmUgZmlyc3QpLiBVbmtleWVkIG9wZW4gaXMgdW5jaGFuZ2VkIChhbHdheXMgc3Bhd25zKS5cbiAgY29uc3Qga2V5ID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzZXNzaW9uLWtleVwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBmbGFnc1tcInNlc3Npb24ta2V5XCJdXG4gICAgICA6IChwcm9jZXNzLmVudi5CT1VOVFlfU0VTU0lPTl9LRVkgPz8gdW5kZWZpbmVkKTtcbiAgY29uc3QgZm9yY2VkSWQgPSBrZXkgPyBzZXNzaW9uS2V5VG9JZChrZXkpIDogdW5kZWZpbmVkO1xuXG4gIGlmIChmb3JjZWRJZCkge1xuICAgIGNvbnN0IGxpdmUgPSBhd2FpdCBib2FyZElmTGl2ZShmb3JjZWRJZCk7XG4gICAgaWYgKGxpdmUgJiYgIWZsYWdzLmZyZXNoKSB7XG4gICAgICAvLyBJZGVtcG90ZW50IGF0dGFjaCDigJQgdGhlIGJvYXJkIGZvciB0aGlzIGtleSBpcyBhbHJlYWR5IHVwLiBFbWl0IHRoZSBzYW1lXG4gICAgICAvLyBkaXNjb3ZlcnkgSlNPTiBhIHNwYXduIHdvdWxkLCBzbyB0aGUgY2FsbGVyIGdldHMgcG9ydC91cmwgZWl0aGVyIHdheS5cbiAgICAgIGNvbnN0IHJlcXVlc3RlZCA9IEFUVEFDSF9MT1NUX0ZMQUdTLmZpbHRlcigoZikgPT4gQm9vbGVhbihmbGFnc1tmXSkpO1xuICAgICAgY29uc3QgbmFtZWQgPSByZXF1ZXN0ZWQubWFwKChmKSA9PiBgLS0ke2Z9YCkuam9pbihcIiwgXCIpO1xuICAgICAgaWYgKHJlcXVlc3RlZC5sZW5ndGgpIHtcbiAgICAgICAgLy8gIzgwLjEg4oCUIFJFRlVTRSByYXRoZXIgdGhhbiBhdHRhY2gtYW5kLWRpc2NhcmQuIFRoZSBleGl0IGNvZGUgaXMgd2hhdCBhXG4gICAgICAgIC8vIGBzZXQgLWVgIHdyYXBwZXIgb3IgYSBNb25pdG9yIGNhdGNoZXM7IGByZXN0b3JlU2tpcHBlZGAgaXMgd2hhdCBhblxuICAgICAgICAvLyBhZ2VudCBwYXJzZXMuIDIgPSBiYWQgaW5wdXQsIG1hdGNoaW5nIGBkaWUoKWAgYW5kIHRoZSBob3VzZSBleGl0LWNvZGVcbiAgICAgICAgLy8gY29udHJhY3Qg4oCUIGJ1dCBOT1QgdmlhIGBkaWUoKWAsIHdoaWNoIGlzIHByb2Nlc3MuZXhpdCgyKSBhbmQgd291bGRcbiAgICAgICAgLy8gZGlzY2FyZCB0aGlzIGVudmVsb3BlIG9uIGEgcGlwZSAodGhlIGRyYWluZWQtZXhpdCBkZWZlY3QsIHJlLWNvbW1pdHRlZFxuICAgICAgICAvLyBpbiB0aGUgYWN0IG9mIHByaW50aW5nIHRoZSBmaWVsZCB0aGF0IGZpeGVzIHRoaXMgb25lKS5cbiAgICAgICAgLy9cbiAgICAgICAgLy8g4puUIFRoZSByZWZ1c2FsIE5BTUVTIE5PIENPUlJFQ1RJVkUgVkVSQi4gUnVsZWQgYnkgQ29sZSAyMDI2LTA4LTA2IGFuZFxuICAgICAgICAvLyBub3QgcmVvcGVuYWJsZSBoZXJlLiBUaGUgb2J2aW91cyBoZWxwZnVsIHN1Z2dlc3Rpb24g4oCUIFwiLS1mcmVzaFxuICAgICAgICAvLyAtLXJlc3RvcmVcIiDigJQgaXMgTUVBU1VSRUQgdG8gZGVzdHJveSB0aGUgdXNlcidzIG9ubHkgY29weSBvZiB0aGVpclxuICAgICAgICAvLyBkYXRhOiAtLWZyZXNoIHRlYXJzIHRoZSBib2FyZCBkb3duIGJ5IFBPU1Rpbmcge3R5cGU6XCJjbG9zZVwifSwgY2xvc2VcbiAgICAgICAgLy8gdW5jb25kaXRpb25hbGx5IHdyaXRlcyB0aGUgc25hcHNob3QgKHNlcnZlci50czoxMjg2KSwgc28gYW4gRU1QVFkgbGl2ZVxuICAgICAgICAvLyBib2FyZCBmbHVzaGVzIGVtcHR5IG92ZXIgYSBwb3B1bGF0ZWQgc25hcHNob3QsIGFuZCAtLXJlc3RvcmUgdGhlblxuICAgICAgICAvLyBmYWl0aGZ1bGx5IHJlc3RvcmVzIGZyb20gdGhlIGNvcnBzZSB0aGUgdGVhcmRvd24ganVzdCBtYWRlLiBBIHVzZXIgaW5cbiAgICAgICAgLy8gZXhhY3RseSB0aGUgc2l0dWF0aW9uIHRoaXMgbWVzc2FnZSBpcyB3cml0dGVuIGZvciB3b3VsZCBmb2xsb3cgdGhlXG4gICAgICAgIC8vIGFkdmljZSBhbmQgbG9zZSBldmVyeXRoaW5nLiBTYXkgd2hhdCBpcyB0cnVlOyBvZmZlciBubyBmaXguXG4gICAgICAgIHByaW50SnNvbih7XG4gICAgICAgICAgLi4ubGl2ZSxcbiAgICAgICAgICByZXN0b3JlU2tpcHBlZDoge1xuICAgICAgICAgICAgcmVxdWVzdGVkLFxuICAgICAgICAgICAgcmVhc29uOiBgYSBsaXZlIGJvYXJkIGFscmVhZHkgZXhpc3RzIGZvciB0aGlzIGtleSwgc28gb3BlbiBhdHRhY2hlZCB0byBpdCBpbnN0ZWFkIG9mIHNwYXduaW5nIGEgZGFlbW9uOyAke25hbWVkfSBjb25maWd1cmUgYSBkYWVtb24gYXQgc3Bhd24gdGltZSBhbmQgdGhlIHJ1bm5pbmcgYm9hcmQgd2FzIGxlZnQgdW5jaGFuZ2VkYCxcbiAgICAgICAgICB9LFxuICAgICAgICB9KTtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgYGJvdW50eTogcmVmdXNpbmcgdG8gYXR0YWNoIOKAlCAke25hbWVkfSBjYW5ub3QgdGFrZSBlZmZlY3Qgb24gYSBib2FyZCB0aGF0IGlzIGFscmVhZHkgcnVubmluZyAoa2V5IFwiJHtrZXl9XCIsIGJvYXJkICR7Zm9yY2VkSWR9KVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIC8vIEhPTk9VUi1XSEFULVlPVS1DQU4sIHJ1bGVkIGJ5IHByb3NwZXJvIDIwMjYtMDgtMDYgYW5kIHdyaXR0ZW4gaGVyZVxuICAgICAgICAvLyBiZWNhdXNlIHRoZSB0d28gcmVhZGluZ3MgYXJlIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gdGhlIGRpZmY6IC0tcGluIGlzXG4gICAgICAgIC8vIHBlcmZvcm1lZCBldmVuIG9uIHRoZSByZWZ1c2FsLCBiZWNhdXNlIGl0IGlzIE5PVCBpbiB0aGUgbG9zdC1lZmZlY3RcbiAgICAgICAgLy8gc2V0IOKAlCB0aGUgYXR0YWNoIHBhdGggcmVhbGx5IGRvZXMgd2hhdCAtLXBpbiBhc2tlZC4gV2l0aGhvbGRpbmcgaXRcbiAgICAgICAgLy8gd291bGQgbWFrZSBvbmUgZmxhZydzIGJlaGF2aW91ciBkZXBlbmQgb24gYW4gdW5yZWxhdGVkIGZsYWcsIHdoaWNoIGlzXG4gICAgICAgIC8vIHRoZSBzYW1lIG92ZXItaW5jbHVzaXZlIGVycm9yIGFzIHJlZnVzaW5nIG9uIC0tbm8tb3BlbiwganVzdCBzcGVsbGVkXG4gICAgICAgIC8vIGFzIGEgc2lkZSBlZmZlY3QgaW5zdGVhZCBvZiBhbiBleGl0IGNvZGUuIFRoZSByZWZ1c2FsIGlzIGFib3V0IHRoZVxuICAgICAgICAvLyBmbGFncyB3aG9zZSBlZmZlY3QgaXMgbG9zdCwgYW5kIG9ubHkgdGhvc2UuXG4gICAgICAgIGlmIChmbGFncy5waW4pIHdyaXRlUGluKGZvcmNlZElkKTtcbiAgICAgICAgcmV0dXJuIDI7XG4gICAgICB9XG4gICAgICBwcmludEpzb24oeyAuLi5saXZlLCByZXN0b3JlU2tpcHBlZDogbnVsbCB9KTtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIGF0dGFjaGVkIHRvIGV4aXN0aW5nIGJvYXJkICR7Zm9yY2VkSWR9IChrZXkgXCIke2tleX1cIilcXG5gKTtcbiAgICAgIGlmIChmbGFncy5waW4pIHdyaXRlUGluKGZvcmNlZElkKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAobGl2ZSAmJiBmbGFncy5mcmVzaCkge1xuICAgICAgLy8gUmVwbGFjZSBpdDogY2xvc2UgdGhlIGxpdmUgYm9hcmQgb3ZlciBpdHMgb3duIHByb3RvY29sLCB0aGVuIHdhaXQgZm9yIGl0XG4gICAgICAvLyB0byBhY3R1YWxseSBnbyBkb3duIChpdHMgZXhpdCB1bmxpbmtzIGJvdW50eS08Zm9yY2VkSWQ+Lmpzb24pIHNvIHRoZSBuZXdcbiAgICAgIC8vIGRhZW1vbidzIGZpbGUgd3JpdGUgY2FuJ3QgYmUgY2xvYmJlcmVkIGJ5IHRoZSBkZXBhcnRpbmcgb25lJ3MgY2xlYW51cC5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGFwaShsaXZlLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgeyB0eXBlOiBcImNsb3NlXCIgfSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgICB9XG4gICAgICBjb25zdCBnb25lID0gRGF0ZS5ub3coKSArIDMwMDA7XG4gICAgICB3aGlsZSAoRGF0ZS5ub3coKSA8IGdvbmUgJiYgKGF3YWl0IGJvYXJkSWZMaXZlKGZvcmNlZElkKSkpIGF3YWl0IHNsZWVwKDgwKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBhcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAoZmxhZ3MudGl0bGUpIGFyZ3MucHVzaChcIi0tdGl0bGVcIiwgU3RyaW5nKGZsYWdzLnRpdGxlKSk7XG4gIGlmIChmbGFncy50aW1lb3V0KSBhcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgU3RyaW5nKGZsYWdzLnRpbWVvdXQpKTtcbiAgLy8gYjcgLyBzcGVsbGJvb2sjOTcg4oCUIEEgS0VZRUQgUkVTUEFXTiBSRVNUT1JFUyBCWSBERUZBVUxULlxuICAvL1xuICAvLyBSZXBvcnRlZCBieSBhbnRoaWxsIHdpdGggYSA1LXN0ZXAgcmVwcm86IG9wZW4gLS1zZXNzaW9uLWtleSBLLCBhZGQgYSBjYXJkLFxuICAvLyBjbG9zZSAoc25hcHNob3Q6IDEpLCBvcGVuIC0tc2Vzc2lvbi1rZXkgSyBhZ2FpbiAtPiBMSVZFIDAgdGFza3Mgb3ZlciBhblxuICAvLyBpbnRhY3QgMS10YXNrIHNuYXBzaG90LCBhbmQgdGhlIG5leHQgY2xvc2Ugd3JpdGVzIDAgb3ZlciBpdC4gU3RlcCA0IGlzIHRoZVxuICAvLyBkZWZlY3QgYW5kIHN0ZXAgNSBpcyB0aGUgZGFtYWdlLlxuICAvL1xuICAvLyDimqAgSSBSVUxFRCBUSElTIFwiSU5URU5ERURcIiBBVCAjODI0IGFuZCBJIHdhcyB3cm9uZy4gTXkgcmVhc29uaW5nIHdhcyB0aGF0XG4gIC8vIGAtLXJlc3RvcmVgIGlzIHRoZSBleHBsaWNpdCBvcHQtaW4sIHNvIGEgZnJlc2ggYm9hcmQgaXMgdGhlIGhvbmVzdCBkZWZhdWx0LlxuICAvLyBUaGF0IGlzIHJpZ2h0IGZvciBhbiBVTktFWUVEIG9wZW4gYW5kIHdyb25nIGZvciBhIGtleWVkIG9uZTogYSBzdGFibGUga2V5J3NcbiAgLy8gd2hvbGUgcHJvbWlzZSBpcyBDT05USU5VSVRZIOKAlCBgb3BlbiAtLXNlc3Npb24ta2V5IEtgIGlzIGRvY3VtZW50ZWRcbiAgLy8gaWRlbXBvdGVudCDigJQgYW5kIGRpc2NhcmRpbmcgSydzIHNuYXBzaG90IGlzIHRoZSBvbmUgbW9tZW50IGl0IGRvZXMgbm90XG4gIC8vIGRlbGl2ZXIgaXQuIFRoZSBvcHQtaW4gYXJndW1lbnQgc3Vydml2ZXMgb25seSB3aGVyZSB0aGVyZSBpcyBubyBrZXkuXG4gIC8vXG4gIC8vIERlbGliZXJhdGVseSBuYXJyb3csIHNvIHRoaXMgY2Fubm90IHJlc3VycmVjdCBhIGJvYXJkIGFueW9uZSBhc2tlZCB0byBiZVxuICAvLyByaWQgb2Y6XG4gIC8vICAgLSBrZXllZCBvcGVucyBvbmx5OyBhbiB1bmtleWVkIG9wZW4gc3RpbGwgYWx3YXlzIHNwYXducyBlbXB0eTtcbiAgLy8gICAtIG9ubHkgd2hlbiBOTyBsaXZlIGJvYXJkIHdhcyBmb3VuZCAoYW4gYXR0YWNoIGlzIHVudG91Y2hlZCk7XG4gIC8vICAgLSBgLS1mcmVzaGAgc3RpbGwgd2lucyBhbmQgc3RpbGwgZ2l2ZXMgYSBjbGVhbiBib2FyZCDigJQgdGhhdCBpcyB0aGUgdmVyYlxuICAvLyAgICAgZm9yIFwiSSB3YW50IHRoaXMga2V5LCBlbXB0eVwiO1xuICAvLyAgIC0gYW4gZXhwbGljaXQgYC0tcmVzdG9yZWAgc3RpbGwgd2lucywgYW5kIGlzIG5ldmVyIG92ZXJyaWRkZW4uXG4gIGlmIChcbiAgICBmb3JjZWRJZCAmJlxuICAgICFmbGFncy5yZXN0b3JlICYmXG4gICAgIWZsYWdzLmZyZXNoICYmXG4gICAgZXhpc3RzU3luYyhqb2luKFNOQVBTSE9UU19ESVIsIGAke2ZvcmNlZElkfS5qc29uYCkpXG4gICkge1xuICAgIGFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBmb3JjZWRJZCk7XG4gIH1cbiAgaWYgKGZsYWdzLnJlc3RvcmUpIGFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBTdHJpbmcoZmxhZ3MucmVzdG9yZSkpO1xuICBpZiAoZmxhZ3NbXCJuby1vcGVuXCJdKSBhcmdzLnB1c2goXCItLW5vLW9wZW5cIik7XG4gIGlmIChmb3JjZWRJZCkgYXJncy5wdXNoKFwiLS1pZFwiLCBmb3JjZWRJZCk7IC8vIGZvcmNlIHRoZSBkYWVtb24ncyBpZCB0byB0aGUgZGVyaXZlZCBrZXkgaWRcblxuICBjb25zdCBwcmV2SWQgPSByZWFkU2Vzc2lvbigpPy5zZXNzaW9uX2lkO1xuICAvLyBQb2ludCB0aGUgZGV0YWNoZWQgZGFlbW9uJ3MgbmF0aXZlIHN0ZGVyciBhdCB0aGUgZHVyYWJsZSBkaWFnbm9zdGljcyBsb2dcbiAgLy8gKCM2NCkgc28gQnVuJ3MgT1dOIGhhcmQtYWJvcnQgb3V0cHV0IOKAlCB0aGUgY3Jhc2ggdHJhY2VzIEpTIGhhbmRsZXJzIGNhbid0XG4gIC8vIGNhdGNoLCB3aGljaCBcImlnbm9yZVwiIHVzZWQgdG8gZGlzY2FyZCDigJQgaXMgY2FwdHVyZWQgb24gdGhlIHNhbWUgZmlsZSB0aGVcbiAgLy8gZGFlbW9uIGFwcGVuZHMgaXRzIGxpZmVjeWNsZSBsaW5lcyB0by4gQmVzdC1lZmZvcnQ6IGZhbGwgYmFjayB0byBcImlnbm9yZVwiIGlmXG4gIC8vIHRoZSBmZCBjYW4ndCBiZSBvcGVuZWQgKG5ldmVyIGJsb2NrIGBvcGVuYCBvbiBsb2dnaW5nKS4gc3RkaW4rc3Rkb3V0IHN0YXlcbiAgLy8gaWdub3JlZC5cbiAgbGV0IHN0ZGVycjogXCJpZ25vcmVcIiB8IG51bWJlciA9IFwiaWdub3JlXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgYm91bnR5SG9tZSA9IHByb2Nlc3MuZW52LkJPVU5UWV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5ib3VudHlcIik7XG4gICAgbWtkaXJTeW5jKGJvdW50eUhvbWUsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIHN0ZGVyciA9IG9wZW5TeW5jKGpvaW4oYm91bnR5SG9tZSwgXCJkYWVtb24ubG9nXCIpLCBcImFcIik7XG4gIH0gY2F0Y2gge1xuICAgIHN0ZGVyciA9IFwiaWdub3JlXCI7XG4gIH1cbiAgLy8gbm9kZTpjaGlsZF9wcm9jZXNzIChub3QgQnVuLnNwYXduKSBpcyBkZWxpYmVyYXRlICsgbWF0Y2hlcyBpbWFnby9ncmFwZXZpbmU6XG4gIC8vIHRoZSBkYWVtb24gbXVzdCBTVVJWSVZFIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdGluZywgd2hpY2ggbmVlZHMgZGV0YWNoZWQ6dHJ1ZVxuICAvLyArIHVucmVmKCkuIEJ1bi5zcGF3biBjYW4ndCBkZXRhY2ggYSBzdXJ2aXZpbmcgZGFlbW9uLlxuICAvLyBDaGVjayB0aGUgY3dkIEVYSVNUUyBiZWZvcmUgc3Bhd25pbmc6IHRoZSBkYWVtb24ncyBzdGRpbyBpcyBkZXRhY2hlZCwgc28gYVxuICAvLyBtaXNzaW5nIGRpcmVjdG9yeSB3b3VsZCBzdXJmYWNlIGFzIGEgc2lsZW50IFwiZmFpbGVkIHRvIHN0YXJ0XCIg4oCUIGFuZCBub2RlXG4gIC8vIHJlcG9ydHMgYSBtaXNzaW5nIGN3ZCBhcyBFTk9FTlQgb24gdGhlIEVYRUNVVEFCTEUsIHdoaWNoIHJlYWRzIGFzIFwiYnVuIGlzXG4gIC8vIG1pc3NpbmdcIiByYXRoZXIgdGhhbiBcInRoZSBzdXJmYWNlIGlzIG5vdCBoZXJlXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIHByaW50SnNvbih7XG4gICAgICBlcnJvcjogYGJvdW50eSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfS4gTm8gZGlzdC9pbmRleC5odG1sIHdhcyBmb3VuZCAob3IgU1BFTExCT09LX1NVUkZBQ0VfTU9ERT1kZXYgaXMgc2V0KSwgc28gdGhlIGRhZW1vbiB3b3VsZCBydW4gaW4gZGV2IG1vZGUgYW5kIG5lZWRzIHRoZSBzdXJmYWNlIHNvdXJjZSBhdCB0aGF0IHBhdGguYCxcbiAgICB9KTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgYXJncywge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgc3RkZXJyXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIGN3ZCxcbiAgfSk7XG4gIHByb2MudW5yZWYoKTtcblxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgc2xlZXAoODApO1xuICAgIC8vIEEga2V5ZWQgb3BlbiBwb2xscyBpdHMgT1dOIGJvYXJkIGZpbGUgKGRldGVybWluaXN0aWMgaWQpIOKAlCBub3QgYGxhdGVzdGAsXG4gICAgLy8gd2hpY2ggYSBjb25jdXJyZW50IG9wZW4gY291bGQgd2luLiBVbmtleWVkIG9wZW4ga2VlcHMgdGhlIGxlZ2FjeVxuICAgIC8vIHJlYWQtbGF0ZXN0LXVudGlsLXRoZS1pZC1jaGFuZ2VzIGJlaGF2aW9yLlxuICAgIGNvbnN0IHMgPSBmb3JjZWRJZCA/IHJlYWRTZXNzaW9uKGZvcmNlZElkKSA6IHJlYWRTZXNzaW9uKCk7XG4gICAgY29uc3QgaXNVcCA9IGZvcmNlZElkID8gISFzIDogISEocyAmJiBzLnNlc3Npb25faWQgIT09IHByZXZJZCk7XG4gICAgaWYgKHMgJiYgaXNVcCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fS9zdGF0ZWApO1xuICAgICAgICBpZiAoci5vaykge1xuICAgICAgICAgIC8vIGByZXN0b3JlU2tpcHBlZGAgaXMgUFJFU0VOVCBBTkQgTlVMTCBvbiBldmVyeSBzdWNjZXNzIHBhdGgsIG5ldmVyXG4gICAgICAgICAgLy8gYWJzZW50ICgjODAuMSAvIEQxLjIpLiBBIGZpZWxkIHRoYXQgYXBwZWFycyBvbmx5IHdoZW4gaXQgaGFzXG4gICAgICAgICAgLy8gc29tZXRoaW5nIHRvIHNheSBjYW5ub3QgYmUgdG9sZCBhcGFydCBmcm9tIGEgYnVpbGQgdGhhdCBkb2VzIG5vdFxuICAgICAgICAgIC8vIGVtaXQgaXQgYXQgYWxsLCBzbyBgXCJyZXN0b3JlU2tpcHBlZFwiIGluIGVudmVsb3BlYCBpcyB0aGUgYXNzZXJ0aW9uXG4gICAgICAgICAgLy8gdGhhdCBoYXMgdGVldGggYW5kIGA9PT0gbnVsbGAgYWxvbmUgaXMgdGhlIG9uZSB0aGF0IHBhc3NlcyB2YWN1b3VzbHkuXG4gICAgICAgICAgcHJpbnRKc29uKHsgLi4ucywgcmVzdG9yZVNraXBwZWQ6IG51bGwgfSk7XG4gICAgICAgICAgaWYgKGZsYWdzLnBpbikgd3JpdGVQaW4ocy5zZXNzaW9uX2lkKTtcbiAgICAgICAgICByZXR1cm4gMDtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vdCB1cCB5ZXQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgcmV0dXJuIGRpZShcImJvdW50eSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiA1c1wiKTtcbn1cblxuLy8gYjYg4oCUIGBmdWxsYCBpcyBubyBsb25nZXIgYSBwYXJhbWV0ZXIuIFRoZSByZWFkIGlzIGFsd2F5cyBmdWxsLCBzbyB0aGVyZSBpc1xuLy8gbm90aGluZyBmb3IgaXQgdG8gc2VsZWN0LiBUaGUgRkxBRyBzdGF5cyBkZWNsYXJlZCBpbiBDTElfT1BUSU9OUyBzbyBhIHN0cmljdFxuLy8gcGFyc2VyIHN0aWxsIGFjY2VwdHMgYHN0YXRlIC0tZnVsbGAgZnJvbSBleGlzdGluZyBjYWxsZXJzIChyZW1vdmluZyBpdCB3b3VsZFxuLy8gZXhpdCAyIG9uIHRoZW0pLCBhbmQgYHJlYWRNb2RlOiBcImZ1bGxcImAgaW4gdGhlIHJlc3BvbnNlIGNvbmZpcm1zIHRoZXkgZ290IHdoYXRcbi8vIHRoZXkgYXNrZWQgZm9yIHJhdGhlciB0aGFuIGxlYXZpbmcgaXQgYXNzdW1lZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKFxuICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHNjb3BlOiB7IG93bmVyPzogc3RyaW5nOyBtaW5lPzogYm9vbGVhbjsgYXM/OiBzdHJpbmcgfSA9IHt9LFxuKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgLy8gYjYg4oCUIERFRkFVTFQgRkxJUFBFRC4gVGhpcyBsaW5lIHVzZWQgdG8gcmVhZCBgJHtmdWxsID8gXCJcIiA6IFwiP2xlYW49MVwifWAsIHNvXG4gIC8vIHRoZSBtb3N0LXVzZWQgcmVhZCBpbiB0aGUgdG9vbGJveCBhc2tlZCBmb3IgTEVBTiBhbmQgYC0tZnVsbGAgYXNrZWQgZm9yXG4gIC8vIGV2ZXJ5dGhpbmcuIFRoYXQgaXMgYSBsb3NzeSByZWFkIGFzIHRoZSBkZWZhdWx0LCBhbmQgaXQgd2FzIGhhcm1sZXNzIG9ubHkgYnlcbiAgLy8gYWNjaWRlbnQgb2YgdGhlIHNlcnZlciBpZ25vcmluZyB0aGUgcGFyYW1ldGVyLlxuICAvL1xuICAvLyDim5QgQSBQUkUtSU5TVEFMTEVEIEFCU0VOQ0UgV0lUSCBBIFRSSUdHRVIgREFURTogc2VydmVyLnRzIGRvY3VtZW50cyB0aGF0XG4gIC8vIGBsZWFuIOKJiCBmdWxsIHRvZGF5YCBhbmQgZXhwbGljaXRseSByZXNlcnZlcyB0aGUgcmlnaHQgdG8gaW1wbGVtZW50IGEgcmVhbFxuICAvLyBsZWFuIGxhdGVyLiBPbiB0aGUgZGF5IGFueW9uZSBkb2VzLCBldmVyeSBleGlzdGluZyBjYWxsZXIgd291bGQgc2lsZW50bHlcbiAgLy8gc3RhcnQgcmVjZWl2aW5nIGEgVFJJTU1FRCBwYXlsb2FkIHdpdGggbm90aGluZyBzYXlpbmcgd2hpY2ggbW9kZSBwcm9kdWNlZFxuICAvLyBpdC4gRmxpcHBpbmcgaXQgaXMgZnJlZSBhbmQgc2FmZSBUT0RBWSBwcmVjaXNlbHkgYmVjYXVzZSB0aGUgZmxhZyBpc1xuICAvLyBjdXJyZW50bHkgYSBuby1vcCwgYW5kIGltcG9zc2libGUgdG8gZG8gc2FmZWx5IGFmdGVyd2FyZHMuXG4gIC8vXG4gIC8vIEEgTE9TU1kgUkVBRCBNVVNUIEJFIE9QVEVEIElOVE8sIE5FVkVSIERFRkFVTFRFRC5cbiAgLy9cbiAgLy8gYC0tZnVsbGAgaXMgS0VQVCBhbmQgbm93IG5hbWVzIHRoZSBkZWZhdWx0LiBJdCBpcyBub3QgcmVtb3ZlZDogdGhlIHBhcnNlciBpc1xuICAvLyBzdHJpY3QsIHNvIGFuIHVua25vd24gZmxhZyBleGl0cyAyIOKAlCBkZWxldGluZyBpdCB3b3VsZCB0dXJuIGV2ZXJ5IGV4aXN0aW5nXG4gIC8vIGBzdGF0ZSAtLWZ1bGxgIGNhbGxlciBpbnRvIGEgaGFyZCBmYWlsdXJlIHRvIGZpeCBhIGZsYWcgdGhhdCBuZXZlciBkaWRcbiAgLy8gYW55dGhpbmcuIEl0IGlzIGRvY3VtZW50ZWQgYXMgY29tcGF0aWJpbGl0eSByYXRoZXIgdGhhbiBsZWZ0IHRvIGxvb2sgbG9hZC1cbiAgLy8gYmVhcmluZyAoY2Fzc2FuZHJhJ3MgcjQ6IFNLSUxMLm1kIGFkdmVydGlzZWQgaXQgd2l0aCBubyBub3RlIHRoYXQgaXQgd2FzXG4gIC8vIGluZXJ0LCBhbmQgdGhhdCBpcyB0aGUgY29udHJhY3QgYSBjb2xkIGFnZW50IHJlYWRzKS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgKTtcbiAgLy8gU2NvcGVkIHJlYWRiYWNrIChtaXJyb3JzIGB0YWlsYCBzZW1hbnRpY3MpOiAtLW93bmVyIFggPSBYJ3MgdGFza3M7IC0tbWluZSA9XG4gIC8vIG93biArIGNsYWltYWJsZSAodW5vd25lZCkuIEVhY2ggcmV0YWluZWQgdGFzayBrZWVwcyBpdHMgY29tcHV0ZWRcbiAgLy8gYGxpdmVCbG9ja2Vyc2AsIHNvIGEgYmxvY2tlZCB0YXNrIHN0YXlzIGFjdGlvbmFibGUgZXZlbiB3aGVuIHRoZSBibG9ja2VyIGlzXG4gIC8vIG93bmVkIGJ5IHNvbWVvbmUgZWxzZSBhbmQgdGh1cyBmaWx0ZXJlZCBvdXQgb2YgdGhpcyB2aWV3LlxuICBpZiAoc2NvcGUub3duZXIgfHwgc2NvcGUubWluZSkge1xuICAgIGNvbnN0IGQgPSBkYXRhIGFzIHsgc3RhdGU/OiB7IHRhc2tzPzogQXJyYXk8eyBvd25lcj86IHN0cmluZyB9PiB9IH07XG4gICAgaWYgKGQuc3RhdGU/LnRhc2tzKSB7XG4gICAgICBkLnN0YXRlLnRhc2tzID0gZC5zdGF0ZS50YXNrcy5maWx0ZXIoKHQpID0+IG93bmVySW5TY29wZSh0Lm93bmVyLCBzY29wZSkpO1xuICAgIH1cbiAgfVxuICAvLyBiNiDigJQgdGhlIHJlc3BvbnNlIG5vdyBTVEFURVMgV0hJQ0ggTU9ERSBBTlNXRVJFRCBJVCByYXRoZXIgdGhhbiBsZWF2aW5nIHRoZVxuICAvLyBjYWxsZXIgdG8gYXNzdW1lIGl0cyByZXF1ZXN0IHdhcyBob25vdXJlZC4gQWx3YXlzIFwiZnVsbFwiLCBiZWNhdXNlIHRoYXQgaXNcbiAgLy8gd2hhdCB0aGUgZGFlbW9uIGFjdHVhbGx5IHNlcnZlczsgYHJlYWRNb2RlYCBpcyBhIGNsYWltIGFib3V0IHRoZSBBTlNXRVIsIG5vdFxuICAvLyBhbiBlY2hvIG9mIHRoZSBBU0suXG4gIC8vXG4gIC8vIERPTUFJTiwgc3RhdGVkIGJlY2F1c2UgYSBwcmVzZW50LWFuZC1udWxsIGZpZWxkIGlzIG9ubHkgaG9uZXN0IG92ZXIgb25lXG4gIC8vIChvdXRjb21lLWNvbnRyYWN0IEJvdW5kYXJ5IDMpOiBgcmVhZE1vZGVgIHJhbmdlcyBvdmVyIHdoYXQgVEhJUyBDTElcbiAgLy8gcmVxdWVzdGVkIGFuZCB3aGF0IHRoZSBkYWVtb24gcmV0dXJuZWQgZm9yIGAvc3RhdGVgLiBJdCBzYXlzIG5vdGhpbmcgYWJvdXRcbiAgLy8gYW55IG90aGVyIHJvdXRlLCBhbmQgaXQgaXMgbm90IGEgcHJvbWlzZSB0aGF0IGEgZnV0dXJlIGxlYW4gd291bGQgYmVcbiAgLy8gcmVwb3J0ZWQgaGVyZSDigJQgdGhhdCB3b3VsZCBiZSB0aGUgc2FtZSBmdXNlIG9uZSBsZXZlbCB1cC5cbiAgcHJpbnRKc29uKHsgLi4uKGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLCByZWFkTW9kZTogXCJmdWxsXCIgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgc2luY2VBcmc6IG51bWJlcixcbiAgc2NvcGU6IHsgb3duZXI/OiBzdHJpbmc7IG1pbmU/OiBib29sZWFuOyBhcz86IHN0cmluZyB9ID0ge30sXG4pIHtcbiAgbGV0IHNpbmNlID0gc2luY2VBcmc7XG4gIGxldCBkZWxheSA9IDI1MDtcbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgY29uc3Qgc3RvcCA9ICgpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH07XG4gIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgc3RvcCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIHN0b3ApO1xuXG4gIC8vIENsaWVudC1zaWRlIHNjb3BlIGZpbHRlciAodGhlIGRhZW1vbiBzdHJlYW1zIEFMTCBldmVudHMpLiBMaWZlY3ljbGUgZnJhbWVzXG4gIC8vIChyZWFkeS9jb25uZWN0ZWQvZGlzY29ubmVjdGVkL2Nsb3NlZCkgYWx3YXlzIHBhc3Mg4oCUIG9ubHkgdGFzay4qIGZyYW1lcyBhcmVcbiAgLy8gb3duZXItc2NvcGVkLiBgLS1taW5lYCBhbHNvIHBhc3NlcyBjbGFpbWFibGUgKHVub3duZWQpIHRhc2tzLlxuICBjb25zdCBvd25lciA9IHNjb3BlLm93bmVyO1xuICBjb25zdCBzZWxmID0gc2NvcGUuYXM7XG4gIC8vIE93bmVyLXNjb3BlZCBmcmFtZXM6IHRhc2suKiBtdXRhdGlvbnMgQU5EIGB1bmJsb2NrZWRgIChpdCBjYXJyaWVzIGFuIG93bmVyLFxuICAvLyBzbyBpdCBtdXN0IGJlIHNjb3BlZCDigJQgZWxzZSBldmVyeSB3b3JrZXIgd2FrZXMgb24gZXZlcnkgdW5ibG9jaykuIExpZmVjeWNsZVxuICAvLyAocmVhZHkvY29ubmVjdGVkL2Rpc2Nvbm5lY3RlZC9jbG9zZWQpIGFsd2F5cyBwYXNzZXMuXG4gIGNvbnN0IHNjb3BlYWJsZSA9ICh0Pzogc3RyaW5nKSA9PlxuICAgIHR5cGVvZiB0ID09PSBcInN0cmluZ1wiICYmICh0LnN0YXJ0c1dpdGgoXCJ0YXNrLlwiKSB8fCB0ID09PSBcInVuYmxvY2tlZFwiIHx8IHQgPT09IFwiaGVhcnRiZWF0XCIpO1xuICBjb25zdCBpblNjb3BlID0gKGV2OiB7IHR5cGU/OiBzdHJpbmc7IG93bmVyPzogc3RyaW5nIH0pID0+XG4gICAgIXNjb3BlYWJsZShldi50eXBlKSB8fCBvd25lckluU2NvcGUoZXYub3duZXIsIHNjb3BlKTtcbiAgLy8gU2VsZi1lY2hvIHN1cHByZXNzaW9uOiBkcm9wIGZyYW1lcyB0aGUgY2FsbGVyJ3Mgb3duIGlkZW50aXR5IGNhdXNlZCAoYXBwbGllZFxuICAvLyBhZnRlciB0aGUgc2NvcGUgZmlsdGVyKS4gTm90aWNlIHJpZGVzIHN0ZGVyciwgbmV2ZXIgc3Rkb3V0LlxuICBpZiAob3duZXIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHNjb3BlZCB0byBvd25lcj0ke293bmVyfVxcbmApO1xuICBlbHNlIGlmIChzY29wZS5taW5lKVxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHNjb3BlZCB0byAtLW1pbmUgKG93bmVyPSR7c2VsZiA/PyBcIj9cIn0gKyBjbGFpbWFibGUpXFxuYCk7XG5cbiAgLy8gUGluIHRoZSBzZXNzaW9uIHRoaXMgdGFpbCBmb2xsb3dzICgjdGFpbC1waW4pLiBBbiBleHBsaWNpdCAtLXNlc3Npb24gaXNcbiAgLy8gcGlubmVkIHVwIGZyb250OyBhbiB1bnBpbm5lZCB0YWlsIHBpbnMgdGhlIGZpcnN0IHNlc3Npb24gaXQgcmVzb2x2ZXMgYW5kXG4gIC8vIG5ldmVyIGNvbnN1bHRzIGBsYXRlc3RgIGFnYWluIOKAlCBubyBzaWxlbnQgY3Jvc3MtcHJvamVjdCBoaWphY2sgb24gcmVjb25uZWN0LlxuICBsZXQgcGlubmVkID0gc2Vzc2lvbjtcbiAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgY29uc3QgcmVzb2x2ZWQgPSBwaWNrVGFpbFNlc3Npb24ocGlubmVkLCByZWFkU2Vzc2lvbik7XG4gICAgaWYgKCFyZXNvbHZlZCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCA1MDAwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAocGlubmVkID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHBpbm5lZCA9IHJlc29sdmVkLnBpbm5lZDtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBwaW5uZWQgdG8gc2Vzc2lvbiAke3Bpbm5lZH0g4oCUIGEgbG9uZy1saXZlZCB0YWlsIHdvbid0IG1pZ3JhdGUgdG8gYSBuZXdlciBib2FyZCAocGFzcyAtLXNlc3Npb24gdG8gY2hvb3NlIGFub3RoZXIpXFxuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHMgPSByZXNvbHZlZC5zZXNzaW9uO1xuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vZXZlbnRzP3NpbmNlPSR7c2luY2V9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZGVsYXkgPSAyNTA7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGxldCBjaHVuazogUmVhZGFibGVTdHJlYW1SZWFkUmVzdWx0PFVpbnQ4QXJyYXk+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKGNodW5rLmRvbmUpIGJyZWFrO1xuICAgICAgYnVmICs9IGRlYy5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiOiBib3VudHkta2VlcGFsaXZlXFxuXCIpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS50cmltKCkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghZGF0YUxpbmVzLmxlbmd0aCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBkYXRhTGluZXMuam9pbihcIlxcblwiKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBldiA9IEpTT04ucGFyc2UocGF5bG9hZCkgYXMge1xuICAgICAgICAgICAgaWQ/OiBudW1iZXI7XG4gICAgICAgICAgICB0eXBlPzogc3RyaW5nO1xuICAgICAgICAgICAgYnk/OiBzdHJpbmc7XG4gICAgICAgICAgICBvd25lcj86IHN0cmluZztcbiAgICAgICAgICB9O1xuICAgICAgICAgIC8vIEFkdmFuY2UgdGhlIGN1cnNvciBvbiBFVkVSWSBldmVudCAoZXZlbiBmaWx0ZXJlZCBvbmVzKSBzbyByZXN1bWUgaXNcbiAgICAgICAgICAvLyBjb3JyZWN0IHJlZ2FyZGxlc3Mgb2Ygc2NvcGUuXG4gICAgICAgICAgaWYgKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiAmJiBldi5pZCA+IHNpbmNlKSBzaW5jZSA9IGV2LmlkO1xuICAgICAgICAgIC8vIFNjb3BlIGZpbHRlciwgdGhlbiBzZWxmLWVjaG8gc3VwcHJlc3Npb24uIGBjbG9zZWRgIGlzIGxpZmVjeWNsZSwgc29cbiAgICAgICAgICAvLyBpdCBhbHdheXMgcGFzc2VzIOKAlCBidXQgZ3VhcmQgdGhlIGV4aXQgb3V0c2lkZSB0aGUgZmlsdGVyIHJlZ2FyZGxlc3MuXG4gICAgICAgICAgY29uc3Qgc2VsZkVjaG8gPSBzZWxmICE9PSB1bmRlZmluZWQgJiYgZXYuYnkgPT09IHNlbGY7XG4gICAgICAgICAgY29uc3QgZW1pdCA9IGluU2NvcGUoZXYpICYmICFzZWxmRWNobztcbiAgICAgICAgICBpZiAoZXYudHlwZSA9PT0gXCJjbG9zZWRcIikge1xuICAgICAgICAgICAgLy8gUDBmIOKAlCB0aGUgdGVybWluYWwgZnJhbWUgaXMgdGhlIG9uZSBhIGNvbnN1bWVyIG1vc3QgbmVlZHMgYW5kIHRoZVxuICAgICAgICAgICAgLy8gb25lIGB3cml0ZShwYXlsb2FkKTsgcHJvY2Vzcy5leGl0KDApYCB0aHJvd3MgYXdheTogQnVuJ3Mgc3Rkb3V0IGlzXG4gICAgICAgICAgICAvLyBhc3luYyBvbiBhIFBJUEUsIGFuZCBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAgICAgICAgICAgIC8vIGRyYWluZWQgKG1lYXN1cmVkIGluIHRoaXMgcmVwbyBhdCBleGFjdGx5IDY1LDUzNiBieXRlcykuXG4gICAgICAgICAgICAvL1xuICAgICAgICAgICAgLy8gU0hBUEUgQiDigJQgdGhlIGNhbGxiYWNrIHJpZGVzIFRISVMgd3JpdGUsIHNvIGl0IGZpcmVzIG9uIFRISVNcbiAgICAgICAgICAgIC8vIHdyaXRlJ3MgY29tcGxldGlvbi4gRG8gTk9UIFwiZml4XCIgdGhpcyB3aXRoIGEgdHJhaWxpbmdcbiAgICAgICAgICAgIC8vIGB3cml0ZShcIlwiLCAoKSA9PiBleGl0KWA6IGEgZHJhaW4gY2FsbGJhY2sgY292ZXJzIG9ubHkgaXRzIG93blxuICAgICAgICAgICAgLy8gd3JpdGUgYW5kIGlzIG5vdCBhIGJhcnJpZXIg4oCUIG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzXG4gICAgICAgICAgICAvLyBubyBmaXggYXQgYWxsLCBhbmQgaXQgaXMgdGhlIGhlbHBlciB0aGlzIHNoYXBlIGludml0ZXMuXG4gICAgICAgICAgICAvL1xuICAgICAgICAgICAgLy8gUEVSLVNJVEUgUFJFQ09ORElUSU9OLCBjaGVja2VkIGhlcmUgYW5kIG5vdCBpbmZlcnJlZCBmcm9tIHRoZVxuICAgICAgICAgICAgLy8gc2hhcGU6IHRoaXMgZXhpdCBzaXRzIFRIUkVFIGxvb3BzIGRlZXAgKHdoaWxlIOKGkiBmb3Itc2VwIOKGklxuICAgICAgICAgICAgLy8gZm9yLWxpbmUpLCBzbyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWwgcmV0dXJuIOKAlCB0aGUgdGlkeVxuICAgICAgICAgICAgLy8gb25lLWxpbmVyIHVzZWQgYXQgdGhlIG5pbmUgZW50cnkgcG9pbnRzIOKAlCBkb2VzIE5PVCByZXR1cm4gZnJvbSBhXG4gICAgICAgICAgICAvLyB0YWlsLiBJdCBmYWxscyB0aHJvdWdoIGFuZCB0aGUgbG9vcCBnb2VzIHJvdW5kIGFnYWluLiBUaGF0IGlzIHRoZVxuICAgICAgICAgICAgLy8gMjMtbWludXRlIGBnbGFtb3VyIG9wZW5gIGhhbmcsIG9uZSBzcHJpbnQgbGF0ZXIsIGluIGEgbmV3IHBsYWNlLlxuICAgICAgICAgICAgLy8gVGhlIGV4cGxpY2l0IGByZXR1cm5gIGJlbG93IGlzIHdoYXQgbGVhdmVzIGFsbCB0aHJlZSBsb29wczsgdGhlXG4gICAgICAgICAgICAvLyBjYWxsYmFjayBpcyB3aGF0IGRyYWlucy4gQm90aCBhcmUgcmVxdWlyZWQsIGZvciBkaWZmZXJlbnQgcmVhc29ucy5cbiAgICAgICAgICAgIGlmIChlbWl0KSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtwYXlsb2FkfVxcbmAsICgpID0+IHByb2Nlc3MuZXhpdCgwKSk7XG4gICAgICAgICAgICBlbHNlIHByb2Nlc3MuZXhpdCgwKTtcbiAgICAgICAgICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZW1pdCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cGF5bG9hZH1cXG5gKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLyogc2tpcCBtYWxmb3JtZWQgZnJhbWUgKi9cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICAvLyBzdHJlYW0gZW5kZWQg4oCUIGRhZW1vbiBsaWtlbHkgY2xvc2VkOyBsb29wIHdpbGwgcmV0cnkgb3IgZXhpdC5cbiAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY21kSW5mbyhzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIGJvdW50eSBzZXNzaW9uXCIpO1xuICBwcmludEpzb24ocyk7XG59XG5cbmZ1bmN0aW9uIGNtZFNlc3Npb25zKCkge1xuICBsZXQgZmlsZXM6IHN0cmluZ1tdO1xuICB0cnkge1xuICAgIGZpbGVzID0gcmVhZGRpclN5bmMoU05BUFNIT1RTX0RJUikuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKFwiLmpzb25cIikpO1xuICB9IGNhdGNoIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcIm5vIHNhdmVkIHNlc3Npb25zXFxuXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICB0eXBlIFJvdyA9IHsgaWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdGFza3M6IG51bWJlcjsgbXRpbWU6IG51bWJlciB9O1xuICBjb25zdCByb3dzOiBSb3dbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHtcbiAgICBjb25zdCBwYXRoID0gam9pbihTTkFQU0hPVFNfRElSLCBmKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgcm93cy5wdXNoKHtcbiAgICAgICAgaWQ6IGYucmVwbGFjZSgvXFwuanNvbiQvLCBcIlwiKSxcbiAgICAgICAgdGl0bGU6IHN0LnRpdGxlLFxuICAgICAgICB0YXNrczogQXJyYXkuaXNBcnJheShzdC50YXNrcykgPyBzdC50YXNrcy5sZW5ndGggOiAwLFxuICAgICAgICBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWVNcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCB1bnJlYWRhYmxlIHNuYXBzaG90ICovXG4gICAgfVxuICB9XG4gIHJvd3Muc29ydCgoYSwgYikgPT4gYi5tdGltZSAtIGEubXRpbWUpO1xuICBmb3IgKGNvbnN0IHIgb2Ygcm93cykge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3IuaWR9ICAke3IudGFza3N9IHRhc2tzICDigJQgJHtyLnRpdGxlfVxcbmApO1xuICB9XG4gIGlmICghcm93cy5sZW5ndGgpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFwibm8gc2F2ZWQgc2Vzc2lvbnNcXG5cIik7XG59XG5cbi8vIGIxIOKAlCBgdGFza3NgIGlzIGBudW1iZXIgfCBudWxsYDogbnVsbCBtZWFucyB0aGUgYm9hcmQgQU5TV0VSRUQgYnV0IGl0cyB0YXNrXG4vLyBjb3VudCBjb3VsZCBub3QgYmUgZXN0YWJsaXNoZWQuIEJlZm9yZSwgYW4gdW5yZWNvZ25pc2VkIGJvZHkgcmVwb3J0ZWQgMCwgd2hpY2hcbi8vIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYW4gZW1wdHkgYm9hcmQgKGI1J3MgZGVmZWN0IGluIHRoaXMgcHJvYmUpLiBJdCBjb3VsZFxuLy8gbm90IHNpbXBseSBiZWNvbWUgbnVsbCBhdCB0aGUgcHJvYmUsIGJlY2F1c2UgbGl2ZUJvYXJkcyB0cmVhdHMgbnVsbCBhcyBERUFEXG4vLyBhbmQgd291bGQgaGF2ZSBtYWRlIGEgbGl2ZS1idXQtdW5jb3VudGFibGUgYm9hcmQgVkFOSVNIIGZyb20gYGxpc3RgIOKAlCB3b3JzZVxuLy8gdGhhbiBhIHdyb25nIGNvdW50LiBEaXN0aW5ndWlzaGluZyBcIm5vdCBsaXZlXCIgZnJvbSBcImxpdmUsIHVuY291bnRhYmxlXCIgbmVlZHNcbi8vIHRoZSB0d28gbnVsbHMgdG8gbGl2ZSBhdCBkaWZmZXJlbnQgbGV2ZWxzLCB3aGljaCBpcyB0aGlzIHR5cGUgY2hhbmdlLlxudHlwZSBMaXZlQm9hcmQgPSB7IHNlc3Npb25faWQ6IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgdXJsOiBzdHJpbmc7IHRhc2tzOiBudW1iZXIgfCBudWxsIH07XG5cbi8vIEZpbHRlciBkaXNjb3ZlcmVkIHNlc3Npb25zIHRvIHRoZSBMSVZFIG9uZXMgdmlhIGFuIGluamVjdGVkIHByb2JlICh0YXNrIGNvdW50XG4vLyBpZiB0aGUgYm9hcmQgYW5zd2VycywgbnVsbCBpZiBkZWFkL3N0YWxlKS4gUHJvYmVzIHJ1biBpbiBwYXJhbGxlbC4gSW5qZWN0aW5nXG4vLyB0aGUgcHJvYmUga2VlcHMgdGhlIGxpdmUtZmlsdGVyIHVuaXQtdGVzdGFibGUgd2l0aG91dCBzcGF3bmluZyByZWFsIGRhZW1vbnMuXG5hc3luYyBmdW5jdGlvbiBsaXZlQm9hcmRzKFxuICBkaXNjb3ZlcmVkOiBTZXNzaW9uW10sXG4gIHByb2JlOiAoczogU2Vzc2lvbikgPT4gUHJvbWlzZTx7IHRhc2tzOiBudW1iZXIgfCBudWxsIH0gfCBudWxsPixcbik6IFByb21pc2U8TGl2ZUJvYXJkW10+IHtcbiAgY29uc3QgcHJvYmVkID0gYXdhaXQgUHJvbWlzZS5hbGwoXG4gICAgZGlzY292ZXJlZC5tYXAoYXN5bmMgKHMpID0+IHtcbiAgICAgIC8vIE9VVEVSIG51bGwgPSB0aGUgYm9hcmQgZGlkIG5vdCBhbnN3ZXIsIHNvIGl0IGlzIG5vdCBsaXZlIGFuZCBpcyBkcm9wcGVkLlxuICAgICAgLy8gVGhlIGNvdW50IElOU0lERSBhIGxpdmUgYm9hcmQgbWF5IHNlcGFyYXRlbHkgYmUgbnVsbCDigJQgc2VlIExpdmVCb2FyZC5cbiAgICAgIGNvbnN0IHByb2JlZCA9IGF3YWl0IHByb2JlKHMpO1xuICAgICAgcmV0dXJuIHByb2JlZCA9PT0gbnVsbFxuICAgICAgICA/IG51bGxcbiAgICAgICAgOiB7IHNlc3Npb25faWQ6IHMuc2Vzc2lvbl9pZCwgdGl0bGU6IHMudGl0bGUsIHVybDogcy51cmwsIHRhc2tzOiBwcm9iZWQudGFza3MgfTtcbiAgICB9KSxcbiAgKTtcbiAgcmV0dXJuIHByb2JlZC5maWx0ZXIoKGIpOiBiIGlzIExpdmVCb2FyZCA9PiBiICE9PSBudWxsKTtcbn1cblxuLy8gTGl2ZW5lc3MgcHJvYmU6IEdFVCAvc3RhdGUgd2l0aCBhIHNob3J0IHRpbWVvdXQuIFJldHVybnMgdGhlIHRhc2sgY291bnQgaWYgdGhlXG4vLyBib2FyZCBhbnN3ZXJzLCBudWxsIGlmIHVucmVhY2hhYmxlIChhIHN0YWxlIGRpc2NvdmVyeSBmaWxlIGxlZnQgYnkgYSBkYWVtb25cbi8vIHRoYXQgZGllZCB3aXRob3V0IGNsZWFudXApLlxuYXN5bmMgZnVuY3Rpb24gcHJvYmVCb2FyZChzOiBTZXNzaW9uKTogUHJvbWlzZTx7IHRhc2tzOiBudW1iZXIgfCBudWxsIH0gfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgLy8gYjYg4oCUIGA/bGVhbj0xYCBTVVJWSVZFUyBIRVJFIE9OIFBVUlBPU0UsIGFuZCB0aGlzIGlzIHRoZSBkZWxpYmVyYXRlXG4gICAgLy8gb3B0LWluIHRoZSBmbGlwcGVkIGRlZmF1bHQgZXhpc3RzIHRvIG1ha2UgcG9zc2libGUuIGI2J3MgcnVsZSBpcyB0aGF0IGFcbiAgICAvLyBMT1NTWSBSRUFEIE1VU1QgQkUgT1BURUQgSU5UTywgTkVWRVIgREVGQVVMVEVEOyBhIGxpdmVuZXNzIHByb2JlIHdpdGggYVxuICAgIC8vIDYwMG1zIGJ1ZGdldCB0aGF0IHJlYWRzIG5vdGhpbmcgYnV0IGEgY291bnQgaXMgZXhhY3RseSB0aGUgY2FsbGVyIHRoYXRcbiAgICAvLyBzaG91bGQgb3B0IGluLiBGbGlwcGluZyBjbWRTdGF0ZSBhbmQgbGVhdmluZyB0aGlzIHVudG91Y2hlZCBpcyB0aGUgcnVsZVxuICAgIC8vIGFwcGxpZWQsIG5vdCB0aGUgcnVsZSBoYWxmLWFwcGxpZWQuIChSYWlzZWQgYnkgY2Fzc2FuZHJhLCAjNzc3IOKAlCB0aGVcbiAgICAvLyBjb21tZW50IGRpZCBub3Qgc2F5LCBhbmQgYW4gdW5leHBsYWluZWQgc3Vydml2b3IgcmVhZHMgYXMgYW4gb3ZlcnNpZ2h0LilcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtzLnVybH0vc3RhdGU/bGVhbj0xYCwgeyBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoNjAwKSB9KTtcbiAgICBpZiAoIXJlcy5vaykgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgYm9keSA9IChhd2FpdCByZXMuanNvbigpKSBhcyB7IHN0YXRlPzogeyB0YXNrcz86IHVua25vd25bXSB9IH07XG4gICAgLy8gYjEg4oCUIFRXTyBESUZGRVJFTlQgTlVMTFMsIGFuZCBrZWVwaW5nIHRoZW0gYXBhcnQgaXMgdGhlIHdob2xlIHBvaW50LiBUaGVcbiAgICAvLyBvdXRlciBudWxsIChyZXR1cm5lZCBhYm92ZSBhbmQgYmVsb3cpIG1lYW5zIE5PVCBMSVZFLCBhbmQgbGl2ZUJvYXJkcyBkcm9wc1xuICAgIC8vIHRoYXQgYm9hcmQuIFRoaXMgaW5uZXIgb25lIG1lYW5zIExJVkUgQlVUIFVOQ09VTlRBQkxFOiB0aGUgYm9hcmQgYW5zd2VyZWRcbiAgICAvLyAyMDAgYW5kIGl0cyBib2R5IHdhcyBub3QgdGhlIHNoYXBlIHdlIHJlY29nbmlzZS4gSXQgdXNlZCB0byByZXBvcnQgMCxcbiAgICAvLyB3aGljaCBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGFuIGVtcHR5IGJvYXJkIOKAlCBiNSdzIGRlZmVjdCBpbiB0aGlzXG4gICAgLy8gcHJvYmUg4oCUIGFuZCBpdCBtdXN0IE5PVCBjb2xsYXBzZSBpbnRvIHRoZSBkZWFkIG51bGwsIG9yIGEgbGl2ZSBib2FyZFxuICAgIC8vIGRpc2FwcGVhcnMgZnJvbSBgbGlzdGAgZW50aXJlbHkuXG4gICAgcmV0dXJuIHsgdGFza3M6IEFycmF5LmlzQXJyYXkoYm9keS5zdGF0ZT8udGFza3MpID8gYm9keS5zdGF0ZS50YXNrcy5sZW5ndGggOiBudWxsIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIGBsaXN0YCDigJQgZW51bWVyYXRlIGN1cnJlbnRseS1SVU5OSU5HIGJvYXJkcyBmcm9tIHRoZSB0bXBkaXIgZGlzY292ZXJ5IGZpbGVzXG4vLyAoYm91bnR5LTxpZD4uanNvbiwgbWludXMgdGhlIGJvdW50eS1sYXRlc3QgcG9pbnRlciksIGxpdmVuZXNzLXByb2JlIGVhY2gsIGFuZFxuLy8gcHJpbnQgb25seSB0aGUgbGl2ZSBvbmVzIChpZC90YXNrLWNvdW50L3VybC90aXRsZSkuIERpc3RpbmN0IGZyb20gYHNlc3Npb25zYCxcbi8vIHdoaWNoIGxpc3RzIHNhdmVkIHNuYXBzaG90cyAoaW5jbHVkaW5nIGNsb3NlZCBib2FyZHMpLiBGb3Igam9pbi1kaXNhbWJpZ3VhdGlvblxuLy8gYW5kIHNlZWluZyB3aGF0J3MgcnVubmluZyBiZWZvcmUgYSBjb21tYW5kIGhpdHMgdGhlIHdyb25nIGJvYXJkLlxuYXN5bmMgZnVuY3Rpb24gY21kTGlzdCgpIHtcbiAgbGV0IGZpbGVzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBmaWxlcyA9IHJlYWRkaXJTeW5jKHRtcGRpcigpKS5maWx0ZXIoXG4gICAgICAoZikgPT4gZi5zdGFydHNXaXRoKFwiYm91bnR5LVwiKSAmJiBmLmVuZHNXaXRoKFwiLmpzb25cIikgJiYgZiAhPT0gXCJib3VudHktbGF0ZXN0Lmpzb25cIixcbiAgICApO1xuICB9IGNhdGNoIHtcbiAgICBmaWxlcyA9IFtdO1xuICB9XG4gIGNvbnN0IGRpc2NvdmVyZWQ6IFNlc3Npb25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGYgb2YgZmlsZXMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4odG1wZGlyKCksIGYpLCBcInV0ZjhcIikpIGFzIFNlc3Npb247XG4gICAgICBpZiAocyAmJiB0eXBlb2Ygcy51cmwgPT09IFwic3RyaW5nXCIgJiYgdHlwZW9mIHMuc2Vzc2lvbl9pZCA9PT0gXCJzdHJpbmdcIikgZGlzY292ZXJlZC5wdXNoKHMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCBhbiB1bnJlYWRhYmxlIC8gcGFydGlhbCBkaXNjb3ZlcnkgZmlsZSAqL1xuICAgIH1cbiAgfVxuICBjb25zdCBsaXZlID0gYXdhaXQgbGl2ZUJvYXJkcyhkaXNjb3ZlcmVkLCBwcm9iZUJvYXJkKTtcbiAgbGl2ZS5zb3J0KChhLCBiKSA9PiBhLnNlc3Npb25faWQubG9jYWxlQ29tcGFyZShiLnNlc3Npb25faWQpKTtcbiAgLy8gYjEgLyAjNzkg4oCUIFNBWSBXSElDSCBRVUVTVElPTiBUSElTIEFOU1dFUkVELiBUaGUgcmVwb3J0ZXIgc2VlZGVkIHNpeCBjYXJkcyxcbiAgLy8gcmFuIGBsaXN0YCB0byBjb25maXJtIHRoZXkgd2VyZSB0aGVyZSwgZ290IG5vdGhpbmcgYmFjaywgYW5kIGNvbmNsdWRlZCB0aGVcbiAgLy8gY2FyZHMgaGFkIG5vdCBiZWVuIGNyZWF0ZWQg4oCUIG9uZSBtZXNzYWdlIGZyb20gZmlsaW5nIGEgZmFsc2UgZGVmZWN0IGFnYWluc3RcbiAgLy8gYSB3b3JraW5nIHRvb2wuIGBsaXN0YCBpcyB0aGUgdmVyYiBhIGNhbGxlciByZWFjaGVzIGZvciB0byBzZWUgd2hhdCBpcyBPTiBhXG4gIC8vIGJvYXJkOyBpdCBlbnVtZXJhdGVzIEJPQVJEUy4gVGhlIHZlcmIgaXMgcmlnaHQgYW5kIHRoZSBub3VuIGlzIGEgZGlmZmVyZW50XG4gIC8vIG9uZSB0aGFuIHRoZSBjYWxsZXIgaGFzIGluIG1pbmQsIGFuZCBhbiBlbXB0eSBzZXQgaXMgZXhhY3RseSB3aGF0IHRoZXlcbiAgLy8gZXhwZWN0IHRvIHNlZSB3aGVuIHRoZWlyIGNhcmRzIGFyZSBtaXNzaW5nLCBzbyBpdCBDT05GSVJNUyB0aGUgd3JvbmdcbiAgLy8gaHlwb3RoZXNpcyBpbnN0ZWFkIG9mIHJhaXNpbmcgYSBxdWVzdGlvbi5cbiAgLy9cbiAgLy8gTmFtaW5nIHRoZSBub3VuIG9uIGV2ZXJ5IHBhdGgg4oCUIGluY2x1ZGluZyB0aGUgcG9wdWxhdGVkIG9uZSDigJQgaXMgd2hhdCBsZXRzIGFcbiAgLy8gY2FsbGVyIG5vdGljZSB0aGV5IGFza2VkIGEgZGlmZmVyZW50IHF1ZXN0aW9uIHRoYW4gdGhlIG9uZSBhbnN3ZXJlZC5cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7bGl2ZS5sZW5ndGh9IHJ1bm5pbmcgYm9hcmQke2xpdmUubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifVxcbmApO1xuICBmb3IgKGNvbnN0IGIgb2YgbGl2ZSkge1xuICAgIC8vIEEgbnVsbCBjb3VudCBpcyBMSVZFIEJVVCBVTkNPVU5UQUJMRSwgbmV2ZXIgMC4gUmVuZGVyZWQgYXMgXCI/XCIgc28gaXQgY2FuXG4gICAgLy8gbmV2ZXIgYmUgcmVhZCBhcyBhbiBlbXB0eSBib2FyZCDigJQgdGhlIHdob2xlIHJlYXNvbiB0aGUgdHdvIG51bGxzIGFyZSBrZXB0XG4gICAgLy8gYXBhcnQgdXBzdHJlYW0uXG4gICAgY29uc3QgY291bnQgPSBiLnRhc2tzID09PSBudWxsID8gXCI/ICh1bnJlYWRhYmxlKVwiIDogYCR7Yi50YXNrc30gdGFza3NgO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2Iuc2Vzc2lvbl9pZH0gICR7Y291bnR9ICAke2IudXJsfSAg4oCUICR7Yi50aXRsZX1cXG5gKTtcbiAgfVxuICBpZiAoIWxpdmUubGVuZ3RoKVxuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgXCJ0aGlzIGxpc3RzIEJPQVJEUywgbm90IHRhc2tzIOKAlCBmb3IgdGhlIGNhcmRzIE9OIGEgYm9hcmQgdXNlIGBib3VudHkgc3RhdGVgXFxuXCIsXG4gICAgKTtcbn1cblxuLy8gUmVhZCBhbGwgb2Ygc3RkaW4gYXMgYSBzaW5nbGUgc3RyaW5nLiBVc2VkIGJ5IC0tc3RkaW4gc28gZnJlZSB0ZXh0ICh0aXRsZXMsXG4vLyBub3RlcykgbGFuZHMgdmVyYmF0aW0gcmVnYXJkbGVzcyBvZiBzaGVsbCBtZXRhY2hhcmFjdGVycy5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRTdGRpbigpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKTtcbn1cblxuY29uc3QgSEVMUCA9IGBib3VudHkg4oCUIGFuIGFnZW50LWRyaXZlbiB0YXNrIGJvYXJkLlxuXG4gIG9wZW4gICBbLS10aXRsZSAuLl0gWy0tdGltZW91dCBTXSBbLS1uby1vcGVuXSBbLS1yZXN0b3JlIDxpZD5dIFstLXBpbl0gWy0tc2Vzc2lvbi1rZXkgPGtleT4gWy0tZnJlc2hdXSAgIHNwYXduIGEgYm9hcmQgZGFlbW9uICgtLXBpbiBiaW5kcyBpdCB0byBjd2Q7IC0tc2Vzc2lvbi1rZXkgYmluZHMgaXQgdG8gYSBjYWxsZXItb3duZWQga2V5LCBpZGVtcG90ZW50bHkpXG4gIHN0YXRlICBbLS1taW5lIHwgLS1vd25lciA8bmFtZT5dIFstLWFzIDxuYW1lPl0gICByZWFkLWJhY2s6IHsgc3RhdGUsIGN1cnNvciwgcmVhZE1vZGUgfVxuICAgICAgICAgICAoLS1mdWxsIGlzIGFjY2VwdGVkIGJ1dCByZWR1bmRhbnQ6IHRoZSByZWFkIGlzIGZ1bGwgYnkgZGVmYXVsdCDigJQgYjYpXG4gIHRhaWwgICBbLS1zaW5jZSBOXSBbLS1vd25lciA8bmFtZT4gfCAtLW1pbmVdIFstLWFzIDxuYW1lPl0gICBTU0UgZXZlbnRzIOKGkiBKU09OTCAoTW9uaXRvcilcbiAgYWRkICAgIDx0aXRsZS4uLj4gWy0tc3RhdHVzIC4uXSBbLS1ub3RlcyAuLl0gWy0tb3duZXIgLi5dIFstLXRhZyBhLGJdIFstLXNpemUgU3xNfExdIFstLWV4cGVjdCA8bWluPl0gWy0taWQgLi5dIFstLXN0ZGluXSAgIGFkZCBhIHRhc2tcbiAgdXBkYXRlIDxpZD4gWy0tc3RhdHVzIC4uXSBbLS10aXRsZSAuLl0gWy0tbm90ZXMgLi5dIFstLW93bmVyIC4uXSBbLS10YWcgYSxiXSBbLS1zaXplIFN8TXxMXSBbLS1leHBlY3QgPG1pbj5dIFstLXN0ZGluXSAgICAgIHBhdGNoIGEgdGFzayAoLS10YWcgXCJcIiBjbGVhcnMpXG4gIC0tc2l6ZSBTfE18TCDihpIgaGVhcnRiZWF0IGVzdGltYXRlICg1LzEwLzIwIG1pbik7IC0tZXhwZWN0IDxtaW4+IG92ZXJyaWRlcy4gQSBkb2luZyB0YXNrIHRoYXQgb3ZlcnJ1bnMgcG9rZXMgaXRzIG93bmVyLlxuICBjbGFpbSAgPGlkPiBbLS1hcyA8bmFtZT5dICAgICAgICAgIHNlbGYtY2xhaW0gYW4gVU5PV05FRCB0YXNrIChyZWplY3RlZCBpZiBvd25lZCBieSBhbm90aGVyKVxuICBibG9jayAgPGlkPiAtLW9uIDxpZD5bLDxpZD4uLi5dICAgIG1hcmsgPGlkPiBibG9ja2VkIG9uIG90aGVyIHRhc2socykgKHJlamVjdGVkIG9uIGEgY3ljbGUpXG4gIHVuYmxvY2sgPGlkPiAtLW9uIDxpZD5bLDxpZD4uLi5dICAgcmVtb3ZlIGJsb2NrZXIgZWRnZShzKVxuICByZW1vdmUgPGlkPiAgICAgICAgICAgICAgICAgICAgICAgIGRlbGV0ZSBhIHRhc2tcbiAgbWVzc2FnZSA8dGV4dC4uLj4gWy0tc3RkaW5dICAgICAgICBzaG93IGEgdG9hc3Qgb24gdGhlIGJvYXJkXG4gIGluaXQgICBbLS10aXRsZSAuLl0gWy0tc3RkaW4tdGFza3NdICAgc2VlZCB0aGUgYm9hcmQgKHRhc2tzID0gSlNPTiBhcnJheSBvbiBzdGRpbjsgZWFjaFxuICAgICAgICAgICB0YXNrIFJFUVVJUkVTIGlkICsgdGl0bGUgKyBzdGF0dXMuIGluaXQgZG9lcyBOT1QgbWludCBpZHMsIHVubGlrZSBhZGQuIEFueVxuICAgICAgICAgICBkcm9wcGVkIHRhc2sgaXMgcmVwb3J0ZWQgcGVyLWVudHJ5IGluIHRhc2tzRHJvcHBlZClcbiAgbGlzdCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaXN0IGN1cnJlbnRseS1SVU5OSU5HIGJvYXJkcyAoaWQvdGFza3MvdXJsL3RpdGxlKVxuICBzZXNzaW9ucyAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Qgc2F2ZWQgU05BUFNIT1RTIChpbmNsLiBjbG9zZWQgYm9hcmRzKVxuICBjbG9zZSB8IGluZm8gfCBoZWxwXG5cbiAgLS1hcyA8bmFtZT4gKG9yICRCT1VOVFlfQVMpIGlzIHlvdXIgaWRlbnRpdHkg4oCUIHN0YW1wZWQgb24gZXZlbnRzIChmb3Igc2NvcGVkXG4gIHRhaWwgKyBzZWxmLWVjaG8gc3VwcHJlc3Npb24pIGFuZCB1c2VkIGJ5IGNsYWltLy0tbWluZS4gLS1vd25lciBhc3NpZ25zIGEgdGFzay5cbiAgLS1zdGRpbiByZWFkcyB0aGUgdGl0bGUgZnJvbSBzdGRpbiAodmVyYmF0aW0g4oCUIHN1cnZpdmVzIGFwb3N0cm9waGVzLCBxdW90ZXMsXG4gICYsIDwsID4pLiBTZXNzaW9uIHRhcmdldGluZyByZXNvbHZlcyAtLXNlc3Npb24ta2V5IDxrZXk+ID4gLS1zZXNzaW9uIDxpZD4gPlxuICAkQk9VTlRZX1NFU1NJT05fS0VZID4gJEJPVU5UWV9TRVNTSU9OID4gbmVhcmVzdCAuYm91bnR5LXNlc3Npb24gKHdhbGtpbmcgdXBcbiAgZnJvbSBjd2QpID4gbW9zdC1yZWNlbnQgYm9hcmQuIEEgLS1zZXNzaW9uLWtleSBpcyBhIGNhbGxlci1vd25lZCBoYW5kbGU6IGl0XG4gIGRlcml2ZXMgYSBzdGFibGUsIHByb2plY3Qtc2NvcGVkIGJvYXJkIGlkLCBzbyBvcGVuIC0tc2Vzc2lvbi1rZXkgSyBpc1xuICBpZGVtcG90ZW50IChhdHRhY2hlcyB0byBhIGxpdmUgYm9hcmQgZm9yIEssIHJlc3Bhd25zIGEgZGVhZCBvbmU7IC0tZnJlc2hcbiAgZm9yY2VzIGEgY2xlYW4gb25lKSwgYW5kIGV2ZXJ5IHZlcmIgcmUtZGVyaXZlcyB0aGUgc2FtZSBpZCDigJQgZGV0ZXJtaW5pc3RpY1xuICBib2FyZCBiaW5kaW5nIHdpdGggbm8gc3RvcmVkL2xhdGVzdCBwb2ludGVyLiBPciB1c2Ugb3BlbiAtLXBpbiB0byB3cml0ZVxuICBjd2QvLmJvdW50eS1zZXNzaW9uIGFuZCBiaW5kIGEgYm9hcmQgdG8gdGhpcyBkaXJlY3RvcnkuYDtcblxuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IFt2ZXJiLCAuLi5yZXN0XSA9IGFyZ3Y7XG4gIGxldCBwb3M6IHN0cmluZ1tdO1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuICB0cnkge1xuICAgICh7IHBvcywgZmxhZ3MgfSA9IHBhcnNlQXJncyhyZXN0KSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGJvdW50eTogJHtlLm1lc3NhZ2V9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3Qgc2Vzc2lvbiA9IHJlc29sdmVTZXNzaW9uKGZsYWdzKTtcbiAgY29uc3QgYXMgPSByZXNvbHZlQXMoZmxhZ3MpO1xuXG4gIHN3aXRjaCAodmVyYikge1xuICAgIGNhc2UgXCJvcGVuXCI6XG4gICAgICAvLyBQcm9wYWdhdGVzIGNtZE9wZW4ncyBjb2RlIHNvIHRoZSAjODAuMSByZWZ1c2FsIGFjdHVhbGx5IHJlYWNoZXMgdGhlXG4gICAgICAvLyBzaGVsbCDigJQgYGJyZWFrYCBoZXJlIHdvdWxkIHN3YWxsb3cgaXQgaW50byBtYWluJ3MgdHJhaWxpbmcgYHJldHVybiAwYC5cbiAgICAgIHJldHVybiBhd2FpdCBjbWRPcGVuKGZsYWdzKTtcbiAgICBjYXNlIFwidGFpbFwiOiB7XG4gICAgICBjb25zdCBtaW5lID0gZmxhZ3MubWluZSA9PT0gdHJ1ZTtcbiAgICAgIGlmIChtaW5lICYmICFhcykgZGllKFwiLS1taW5lIG5lZWRzIGFuIGlkZW50aXR5IOKAlCBwYXNzIC0tYXMgPG5hbWU+IG9yIHNldCBCT1VOVFlfQVNcIik7XG4gICAgICBhd2FpdCBjbWRUYWlsKHNlc3Npb24sIHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlSW50KGZsYWdzLnNpbmNlLCAxMCkgOiAtMSwge1xuICAgICAgICBvd25lcjogdHlwZW9mIGZsYWdzLm93bmVyID09PSBcInN0cmluZ1wiID8gZmxhZ3Mub3duZXIgOiB1bmRlZmluZWQsXG4gICAgICAgIG1pbmUsXG4gICAgICAgIGFzLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInN0YXRlXCI6IHtcbiAgICAgIGNvbnN0IG1pbmUgPSBmbGFncy5taW5lID09PSB0cnVlO1xuICAgICAgaWYgKG1pbmUgJiYgIWFzKSBkaWUoXCItLW1pbmUgbmVlZHMgYW4gaWRlbnRpdHkg4oCUIHBhc3MgLS1hcyA8bmFtZT4gb3Igc2V0IEJPVU5UWV9BU1wiKTtcbiAgICAgIGF3YWl0IGNtZFN0YXRlKHNlc3Npb24sIHtcbiAgICAgICAgb3duZXI6IHR5cGVvZiBmbGFncy5vd25lciA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLm93bmVyIDogdW5kZWZpbmVkLFxuICAgICAgICBtaW5lLFxuICAgICAgICBhcyxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJhZGRcIjoge1xuICAgICAgY29uc3QgdGl0bGUgPSBmbGFncy5zdGRpbiA9PT0gdHJ1ZSA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCF0aXRsZSkgZGllKFwidXNhZ2U6IGFkZCA8dGl0bGUuLi4+IFstLXN0YXR1cyAuLl0gWy0tbm90ZXMgLi5dIFstLXN0ZGluXVwiKTtcbiAgICAgIGNvbnN0IHN0YXR1cyA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5zdGF0dXMgPT09IFwic3RyaW5nXCIgJiYgVkFMSURfU1RBVFVTLmluY2x1ZGVzKGZsYWdzLnN0YXR1cyBhcyBUYXNrU3RhdHVzKVxuICAgICAgICAgID8gKGZsYWdzLnN0YXR1cyBhcyBUYXNrU3RhdHVzKVxuICAgICAgICAgIDogXCJ0b2RvXCI7XG4gICAgICBjb25zdCB0YXNrOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgICAgaWQ6IHR5cGVvZiBmbGFncy5pZCA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmlkIDogbmV3VGFza0lkKCksXG4gICAgICAgIHRpdGxlLFxuICAgICAgICBzdGF0dXMsXG4gICAgICB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5ub3RlcyA9PT0gXCJzdHJpbmdcIikgdGFzay5ub3RlcyA9IGZsYWdzLm5vdGVzO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5vd25lciA9PT0gXCJzdHJpbmdcIikgdGFzay5vd25lciA9IGZsYWdzLm93bmVyO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy50YWcgPT09IFwic3RyaW5nXCIpIHRhc2sudGFncyA9IHBhcnNlVGFncyhmbGFncy50YWcpO1xuICAgICAgY29uc3QgYWRkU2l6ZSA9IHBhcnNlU2l6ZShmbGFncy5zaXplKTtcbiAgICAgIGlmIChhZGRTaXplKSB0YXNrLnNpemUgPSBhZGRTaXplO1xuICAgICAgY29uc3QgYWRkRXhwZWN0ID0gcGFyc2VFeHBlY3QoZmxhZ3MuZXhwZWN0KTtcbiAgICAgIGlmIChhZGRFeHBlY3QgIT09IHVuZGVmaW5lZCkgdGFzay5leHBlY3QgPSBhZGRFeHBlY3Q7XG4gICAgICBjb25zdCBhZGRJZ25vcmVkID0gaWdub3JlZFZhbHVlcyhmbGFncyk7XG4gICAgICB3YXJuSWdub3JlZChhZGRJZ25vcmVkKTtcbiAgICAgIC8vICM4MyDigJQgYGFkZGAgd2FzIHRoZSBPTkxZIHdyaXRlIHZlcmIgdGhhdCBkaXNjYXJkZWQgdGhlIGRhZW1vbidzIHZlcmRpY3Q6XG4gICAgICAvLyB1cGRhdGUvY2xhaW0vYmxvY2svdW5ibG9jay9yZW1vdmUgYWxsIHJlYWQgaXQuIFNvIHRoaXMgaXMgYW4gb3ZlcnNpZ2h0XG4gICAgICAvLyBjb3JyZWN0ZWQgdG8gbWF0Y2ggaXRzIGZvdXIgc2libGluZ3MsIG5vdCBhIG5ldyBjb252ZW50aW9uLlxuICAgICAgLy9cbiAgICAgIC8vIE5vIG5vLW9wIGJyYW5jaCBoZXJlLCB1bmxpa2UgYHVwZGF0ZWAuIGB1cGRhdGVgIGhhcyBhIGxlZ2l0aW1hdGVcbiAgICAgIC8vIGFwcGxpZWQ6ZmFsc2UgKHRoZSB0YXNrIGFscmVhZHkgaGVsZCB0aGUgdmFsdWUpOyBgYWRkYCBkb2VzIG5vdCDigJQgYVxuICAgICAgLy8gcmVmdXNhbCBtZWFucyB0aGUgc2hhcGUgd2FzIGludmFsaWQgb3IgdGhlIGlkIHdhcyB0YWtlbiwgYW5kIGJvdGggYXJlXG4gICAgICAvLyByZWFsIGZhaWx1cmVzLiBUaGUgZGFlbW9uIG5hbWVzIHdoaWNoLlxuICAgICAgY29uc3QgcmVzID0gYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5hZGRcIiwgdGFzayB9LCB7IGFzLCBxdWlldDogdHJ1ZSB9KTtcbiAgICAgIGlmICghcmVzLmFwcGxpZWQpIHtcbiAgICAgICAgY29uc3QgZXJyb3IgPSByZXMuZXJyb3IgPz8gYHRhc2sgJHt0YXNrLmlkfSB3YXMgbm90IGFkZGVkYDtcbiAgICAgICAgcHJpbnRKc29uKHsgb2s6IGZhbHNlLCBhcHBsaWVkOiBmYWxzZSwgaWQ6IHRhc2suaWQsIGVycm9yIH0pO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgYm91bnR5OiAke2Vycm9yfVxcbmApO1xuICAgICAgICByZXR1cm4gMTtcbiAgICAgIH1cbiAgICAgIC8vIFByZXNlbnQtYW5kLW51bGwsIG5ldmVyIGFic2VudCAodGhlIHJlc3RvcmVTa2lwcGVkIGxlc3NvbiwgRDEuMik6IGFcbiAgICAgIC8vIGZpZWxkIHRoYXQgYXBwZWFycyBvbmx5IHdoZW4gaXQgaGFzIHNvbWV0aGluZyB0byBzYXkgY2Fubm90IGJlIHRvbGRcbiAgICAgIC8vIGFwYXJ0IGZyb20gYSBidWlsZCB0aGF0IGRvZXMgbm90IGVtaXQgaXQgYXQgYWxsLlxuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFkZGVkOiB0YXNrLmlkLCB2YWx1ZXNJZ25vcmVkOiBhZGRJZ25vcmVkLmxlbmd0aCA/IGFkZElnbm9yZWQgOiBudWxsIH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJ1cGRhdGVcIjoge1xuICAgICAgY29uc3QgaWQgPSBwb3NbMF07XG4gICAgICBpZiAoIWlkKVxuICAgICAgICBkaWUoXG4gICAgICAgICAgXCJ1c2FnZTogdXBkYXRlIDxpZD4gWy0tc3RhdHVzIC4uXSBbLS10aXRsZSAuLl0gWy0tbm90ZXMgLi5dIFstLW93bmVyIC4uXSBbLS10YWcgYSxiXSBbLS1zdGRpbl1cIixcbiAgICAgICAgKTtcbiAgICAgIGNvbnN0IHBhdGNoOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICAgICAgaWYgKGZsYWdzLnN0ZGluID09PSB0cnVlKSBwYXRjaC50aXRsZSA9IGF3YWl0IHJlYWRTdGRpbigpO1xuICAgICAgZWxzZSBpZiAodHlwZW9mIGZsYWdzLnRpdGxlID09PSBcInN0cmluZ1wiKSBwYXRjaC50aXRsZSA9IGZsYWdzLnRpdGxlO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5zdGF0dXMgPT09IFwic3RyaW5nXCIpIHBhdGNoLnN0YXR1cyA9IGZsYWdzLnN0YXR1cztcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Mubm90ZXMgPT09IFwic3RyaW5nXCIpIHBhdGNoLm5vdGVzID0gZmxhZ3Mubm90ZXM7XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLm93bmVyID09PSBcInN0cmluZ1wiKSBwYXRjaC5vd25lciA9IGZsYWdzLm93bmVyOyAvLyBsZWFkIHJlYXNzaWdubWVudFxuICAgICAgaWYgKHR5cGVvZiBmbGFncy50YWcgPT09IFwic3RyaW5nXCIpIHBhdGNoLnRhZ3MgPSBwYXJzZVRhZ3MoZmxhZ3MudGFnKTsgLy8gU0VUOyBcIlwiIGNsZWFyc1xuICAgICAgY29uc3QgdXBTaXplID0gcGFyc2VTaXplKGZsYWdzLnNpemUpO1xuICAgICAgaWYgKHVwU2l6ZSkgcGF0Y2guc2l6ZSA9IHVwU2l6ZTtcbiAgICAgIGNvbnN0IHVwRXhwZWN0ID0gcGFyc2VFeHBlY3QoZmxhZ3MuZXhwZWN0KTtcbiAgICAgIGlmICh1cEV4cGVjdCAhPT0gdW5kZWZpbmVkKSBwYXRjaC5leHBlY3QgPSB1cEV4cGVjdDtcbiAgICAgIGNvbnN0IHVwSWdub3JlZCA9IGlnbm9yZWRWYWx1ZXMoZmxhZ3MpO1xuICAgICAgd2Fybklnbm9yZWQodXBJZ25vcmVkKTtcbiAgICAgIGlmIChPYmplY3Qua2V5cyhwYXRjaCkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIC8vIOKblCBUSEUgRU5WRUxPUEUgTkVWRVIgUFJJTlRTIE9OIFRISVMgUEFUSCwgc28gdGhlIGlnbm9yZWQtZmxhZyByZXBvcnRcbiAgICAgICAgLy8gaGFzIHRvIHJpZGUgdGhlIHJlZnVzYWwgaXRzZWxmIOKAlCBhbmQgdGhpcyBpcyB0aGUgY2FzZSB3aGVyZSB0aGUgY2FsbGVyXG4gICAgICAgIC8vIG1vc3QgbmVlZHMgaXQuIGB1cGRhdGUgPGlkPiAtLXNpemUgYm9ndXNgIHdpdGggbm8gb3RoZXIgZmxhZyBsYW5kc1xuICAgICAgICAvLyBIRVJFOiB0aGUgc2l6ZSB3YXMgZHJvcHBlZCwgd2hpY2ggbGVmdCB0aGUgcGF0Y2ggZW1wdHksIHdoaWNoIGlzIHdoeVxuICAgICAgICAvLyBpdCByZWZ1c2VzLiBNZWFzdXJlZCwgYW5kIHRoZSByZWZ1c2FsIHVzZWQgdG8gYmxhbWUgYW4gZW1wdHkgcGF0Y2hcbiAgICAgICAgLy8gd2hpbGUgc2F5aW5nIG5vdGhpbmcgYWJvdXQgdGhlIGZsYWcgdGhlIGNhbGxlciBhY3R1YWxseSBwYXNzZWQuXG4gICAgICAgIC8vXG4gICAgICAgIC8vIGAtLXNpemVgL2AtLWV4cGVjdGAgYXJlIGFsc28gQURERUQgdG8gdGhlIGZsYWcgbGlzdDogdGhlIG9sZCBtZXNzYWdlXG4gICAgICAgIC8vIG9taXR0ZWQgdGhlbSwgYW5kIHRoYXQgb21pc3Npb24gd2FzIHJlYWQgKGJ5IHRoZSBzcHJpbnQgc2NhZmZvbGQsIGFuZFxuICAgICAgICAvLyBieSBtZSBhdCBmaXJzdCkgYXMgYSBzeW1wdG9tIG9mIHRoZSBkcm9wLiBJdCBpcyBhIHNlY29uZCwgcmVhbCBkZWZlY3RcbiAgICAgICAgLy8g4oCUIGEgVkFMSUQgYC0tc2l6ZWAgZG9lcyBwb3B1bGF0ZSB0aGUgcGF0Y2gsIHNvIGl0IGFsd2F5cyBiZWxvbmdlZCBpblxuICAgICAgICAvLyB0aGUgbGlzdCBvZiBmbGFncyB0aGF0IHdvdWxkIGhhdmUgbWFkZSB0aGlzIHN1Y2NlZWQuXG4gICAgICAgIGNvbnN0IHdoeSA9IHVwSWdub3JlZC5sZW5ndGhcbiAgICAgICAgICA/IGAg4oCUICR7dXBJZ25vcmVkLm1hcCgoaSkgPT4gYC0tJHtpLmZsYWd9ICR7SlNPTi5zdHJpbmdpZnkoaS52YWx1ZSl9IHdhcyBpZ25vcmVkICgke2kucmVhc29ufSlgKS5qb2luKFwiOyBcIil9YFxuICAgICAgICAgIDogXCJcIjtcbiAgICAgICAgZGllKFxuICAgICAgICAgIGB1cGRhdGU6IG5vdGhpbmcgdG8gY2hhbmdlIChnaXZlIC0tc3RhdHVzLy0tdGl0bGUvLS1ub3Rlcy8tLW93bmVyLy0tdGFnLy0tc2l6ZS8tLWV4cGVjdC8tLXN0ZGluKSR7d2h5fWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICAvLyBTdXJmYWNlIHRoZSBkYWVtb24ncyBvdXRjb21lIChsaWtlIGNsYWltL2Jsb2NrKSwgZGlzdGluZ3Vpc2hpbmcgdGhlIHR3b1xuICAgICAgLy8ga2luZHMgb2YgYXBwbGllZDpmYWxzZTogV0lUSCBhbiBlcnJvciA9IG5vdC1mb3VuZCAvIHJlamVjdGVkIChlLmcuIHRoZVxuICAgICAgLy8gdmVyYiBtaXMtcm91dGVkIHRvIGEgc3RyYW5nZXIgYm9hcmQpIOKGkiBhIHZpc2libGUsIG5vbnplcm8gZmFpbHVyZSwgbmV2ZXJcbiAgICAgIC8vIGEgc2lsZW50IHtvazp0cnVlfSAoIzYyKS4gV0lUSE9VVCBhbiBlcnJvciA9IGEgbGVnaXRpbWF0ZSBuby1vcCAodGhlIHRhc2tcbiAgICAgIC8vIGFscmVhZHkgaGVsZCB0aGlzIHZhbHVlLCBlLmcuIGRvaW5n4oaSZG9pbmcpIOKGkiBiZW5pZ24gc3VjY2Vzcywgc2luY2UgdGhlXG4gICAgICAvLyB0YXNrIGV4aXN0cyBhbmQgdGhlIGJvYXJkIGlzIHJpZ2h0LlxuICAgICAgY29uc3QgcmVzID0gYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay51cGRhdGVcIiwgaWQsIHBhdGNoIH0sIHsgYXMsIHF1aWV0OiB0cnVlIH0pO1xuICAgICAgaWYgKHJlcy5hcHBsaWVkKSB7XG4gICAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCB1cGRhdGVkOiBpZCwgdmFsdWVzSWdub3JlZDogdXBJZ25vcmVkLmxlbmd0aCA/IHVwSWdub3JlZCA6IG51bGwgfSk7XG4gICAgICB9IGVsc2UgaWYgKHJlcy5lcnJvcikge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgYm91bnR5OiAke3Jlcy5lcnJvcn1cXG5gKTtcbiAgICAgICAgcmV0dXJuIDE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBUaGUgbm8tb3AgYnJhbmNoIGNhcnJpZXMgaXQgdG9vLiBMZWF2aW5nIGl0IG9mZiBoZXJlIHdvdWxkIG1lYW4gdGhlXG4gICAgICAgIC8vIGZpZWxkJ3MgcHJlc2VuY2UgZGVwZW5kZWQgb24gd2hldGhlciB0aGUgZGFlbW9uIGhhcHBlbmVkIHRvIGNoYW5nZVxuICAgICAgICAvLyBhbnl0aGluZyDigJQgc28gYSBjYWxsZXIgY291bGQgbm90IHRlbGwgXCJubyBpZ25vcmVkIGZsYWdzXCIgZnJvbSBcInRoaXNcbiAgICAgICAgLy8gYnVpbGQgZG9lcyBub3QgcmVwb3J0IHRoZW1cIiwgd2hpY2ggaXMgdGhlIGV4YWN0IGFic2VuY2UgdGhlXG4gICAgICAgIC8vIHByZXNlbnQtYW5kLW51bGwgcnVsZSBleGlzdHMgdG8gcHJldmVudC5cbiAgICAgICAgcHJpbnRKc29uKHtcbiAgICAgICAgICBvazogdHJ1ZSxcbiAgICAgICAgICB1cGRhdGVkOiBpZCxcbiAgICAgICAgICBub29wOiB0cnVlLFxuICAgICAgICAgIHZhbHVlc0lnbm9yZWQ6IHVwSWdub3JlZC5sZW5ndGggPyB1cElnbm9yZWQgOiBudWxsLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY2xhaW1cIjoge1xuICAgICAgLy8gQ29vcGVyYXRpdmUgc2VsZi1jbGFpbTogdGFrZSBvd25lcnNoaXAgb2YgYW4gVU5PV05FRCB0YXNrLiBSZWplY3RlZCAoYW5kXG4gICAgICAvLyBzdXJmYWNlZCkgaWYgc29tZW9uZSBlbHNlIGFscmVhZHkgb3ducyBpdCDigJQgbmV2ZXIgYSBzaWxlbnQgc3RlYWwuXG4gICAgICBjb25zdCBpZCA9IHBvc1swXTtcbiAgICAgIGlmICghaWQpIGRpZShcInVzYWdlOiBjbGFpbSA8aWQ+IFstLWFzIDxuYW1lPl1cIik7XG4gICAgICBpZiAoIWFzKSBkaWUoXCJjbGFpbSBuZWVkcyBhbiBpZGVudGl0eSDigJQgcGFzcyAtLWFzIDxuYW1lPiBvciBzZXQgQk9VTlRZX0FTXCIpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgcG9zdENtZChcbiAgICAgICAgc2Vzc2lvbixcbiAgICAgICAgeyB0eXBlOiBcInRhc2sudXBkYXRlXCIsIGlkLCBwYXRjaDogeyBvd25lcjogYXMgfSwgY2xhaW06IHRydWUgfSxcbiAgICAgICAgeyBhcywgcXVpZXQ6IHRydWUgfSxcbiAgICAgICk7XG4gICAgICBpZiAocmVzLmFwcGxpZWQpIHtcbiAgICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNsYWltZWQ6IGlkLCBvd25lcjogYXMgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWaXNpYmxlIHJlamVjdGlvbiDigJQgbm9uemVybyBleGl0IHNvIHRoZSBhZ2VudCBjYW4ndCBtaXN0YWtlIGEgcmVqZWN0ZWRcbiAgICAgICAgLy8gY2xhaW0gZm9yIG93bmVyc2hpcCAodGhlIGRhZW1vbiByZXR1cm5lZCBhcHBsaWVkOmZhbHNlKS5cbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGJvdW50eTogJHtyZXMuZXJyb3IgPz8gYGNvdWxkIG5vdCBjbGFpbSAke2lkfWB9XFxuYCk7XG4gICAgICAgIHJldHVybiAxO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJibG9ja1wiOlxuICAgIGNhc2UgXCJ1bmJsb2NrXCI6IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zWzBdO1xuICAgICAgaWYgKCFpZCB8fCB0eXBlb2YgZmxhZ3Mub24gIT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgZGllKGB1c2FnZTogJHt2ZXJifSA8aWQ+IC0tb24gPGlkPlssPGlkPi4uLl1gKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG9uID0gZmxhZ3Mub25cbiAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAubWFwKCh4KSA9PiB4LnRyaW0oKSlcbiAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIGlmICghb24ubGVuZ3RoKSBkaWUoYCR7dmVyYn06IC0tb24gbmVlZHMgYXQgbGVhc3Qgb25lIHRhc2sgaWRgKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHBvc3RDbWQoXG4gICAgICAgIHNlc3Npb24sXG4gICAgICAgIHsgdHlwZTogdmVyYiA9PT0gXCJibG9ja1wiID8gXCJ0YXNrLmJsb2NrXCIgOiBcInRhc2sudW5ibG9ja1wiLCBpZCwgb24gfSxcbiAgICAgICAgeyBhcywgcXVpZXQ6IHRydWUgfSxcbiAgICAgICk7XG4gICAgICBpZiAocmVzLmFwcGxpZWQpIHtcbiAgICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIFt2ZXJiID09PSBcImJsb2NrXCIgPyBcImJsb2NrZWRcIiA6IFwidW5ibG9ja2VkXCJdOiBpZCwgb24gfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBWaXNpYmxlIHJlamVjdGlvbiAoZS5nLiBhIGN5Y2xlKSDigJQgbm9uemVybyBleGl0LCBsaWtlIGEgcmVqZWN0ZWQgY2xhaW0uXG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBib3VudHk6ICR7cmVzLmVycm9yID8/IGBjb3VsZCBub3QgJHt2ZXJifSAke2lkfWB9XFxuYCk7XG4gICAgICAgIHJldHVybiAxO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJyZW1vdmVcIjoge1xuICAgICAgY29uc3QgaWQgPSBwb3NbMF07XG4gICAgICBpZiAoIWlkKSBkaWUoXCJ1c2FnZTogcmVtb3ZlIDxpZD5cIik7XG4gICAgICAvLyBTYW1lIGFwcGxpZWQtY2hlY2sgYXMgdXBkYXRlICgjNjIpOiBhIG5vdC1mb3VuZCByZW1vdmUgKG1pcy1yb3V0ZWQgdG9cbiAgICAgIC8vIGFub3RoZXIgYm9hcmQpIG11c3QgZmFpbCB2aXNpYmx5LCBub3QgcHJpbnQgYSBzaWxlbnQgc3VjY2Vzcy5cbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInRhc2sucmVtb3ZlXCIsIGlkIH0sIHsgYXMsIHF1aWV0OiB0cnVlIH0pO1xuICAgICAgaWYgKHJlcy5hcHBsaWVkKSB7XG4gICAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCByZW1vdmVkOiBpZCB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgIGBib3VudHk6ICR7cmVzLmVycm9yID8/IGBubyBzdWNoIHRhc2sgJHtpZH0gKHdyb25nIGJvYXJkPyBwYXNzIC0tc2Vzc2lvbilgfVxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiAxO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJtZXNzYWdlXCI6IHtcbiAgICAgIGNvbnN0IHRleHQgPSBmbGFncy5zdGRpbiA9PT0gdHJ1ZSA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCF0ZXh0KSBkaWUoXCJ1c2FnZTogbWVzc2FnZSA8dGV4dC4uLj4gWy0tc3RkaW5dXCIpO1xuICAgICAgLy8gREVDSURFRCBFWFBMSUNJVExZIChwbGFuIHN0ZXAgMiksIGFuZCByZWNvcmRlZCBiZWNhdXNlIFwid2UgY2hlY2tlZCBpdFwiXG4gICAgICAvLyBhbmQgXCJpdCBjYW5ub3QgZmFpbFwiIGFyZSBkaWZmZXJlbnQgY2xhaW1zOiB0aGUgZGFlbW9uIGFuc3dlcnMgYG1lc3NhZ2VgXG4gICAgICAvLyB3aXRoIGFwcGxpZWQ6dHJ1ZSB1bmNvbmRpdGlvbmFsbHkgdG9kYXksIHNvIHJvdXRpbmcgaXQgdGhyb3VnaCB0aGVcbiAgICAgIC8vIGZ1bm5lbCBjaGFuZ2VzIE5PVEhJTkcgbm93LiBJdCBpcyBhIHJlZ3Jlc3Npb24gZ3VhcmQg4oCUIGlmIGBtZXNzYWdlYGV2ZXJcbiAgICAgIC8vIGdyb3dzIGEgcmVmdXNhbCAoYSBjbG9zZWQgYm9hcmQsIGEgcmVqZWN0ZWQgcGF5bG9hZCksIHRoZSBDTEkgcmVwb3J0cyBpdFxuICAgICAgLy8gd2l0aG91dCBhbnlvbmUgcmVtZW1iZXJpbmcgdG8gY29tZSBiYWNrIGhlcmUuXG4gICAgICByZXR1cm4gYWNrT3JGYWlsKFxuICAgICAgICBcIm1lc3NhZ2VcIixcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwibWVzc2FnZVwiLCB0ZXh0IH0sIHsgYXMsIHF1aWV0OiB0cnVlIH0pLFxuICAgICAgKTtcbiAgICB9XG4gICAgY2FzZSBcImluaXRcIjoge1xuICAgICAgY29uc3QgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgdHlwZTogXCJpbml0XCIgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MudGl0bGUgPT09IFwic3RyaW5nXCIpIG1zZy50aXRsZSA9IGZsYWdzLnRpdGxlO1xuICAgICAgaWYgKGZsYWdzW1wic3RkaW4tdGFza3NcIl0gPT09IHRydWUpIHtcbiAgICAgICAgY29uc3QgcmF3ID0gYXdhaXQgcmVhZFN0ZGluKCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgdGFza3MgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHRhc2tzKSkgZGllKFwiaW5pdCAtLXN0ZGluLXRhc2tzOiBzdGRpbiBtdXN0IGJlIGEgSlNPTiBhcnJheSBvZiB0YXNrc1wiKTtcbiAgICAgICAgICBtc2cudGFza3MgPSB0YXNrcztcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGlmIChlIGluc3RhbmNlb2YgRXJyb3IgJiYgZS5tZXNzYWdlLmluY2x1ZGVzKFwiSlNPTiBhcnJheVwiKSkgdGhyb3cgZTtcbiAgICAgICAgICBkaWUoXCJpbml0IC0tc3RkaW4tdGFza3M6IGludmFsaWQgSlNPTiBvbiBzdGRpblwiKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgLy8gVGhlIGdlbmVyaWMgcGF0aCDigJQgYW5kIHRoZSBvbmUgd2l0aCBhIFJFQUwgYmVoYXZpb3VyIGNoYW5nZSB0b2RheS4gVGhlXG4gICAgICAvLyBkYWVtb24ncyBjb21tYW5kIGRpc3BhdGNoIGVuZHMgaW4gYHJldHVybiB7b2s6dHJ1ZSwgYXBwbGllZDpmYWxzZX1gIGZvclxuICAgICAgLy8gYW55IHR5cGUgaXQgZG9lcyBub3QgcmVjb2duaXNlLCBzbyBhbiB1bnJlY29nbmlzZWQgY29tbWFuZCBoYXMgYWx3YXlzXG4gICAgICAvLyBiZWVuIGFuc3dlcmVkIHdpdGggYSBzdWNjZXNzLXNoYXBlZCBlbnZlbG9wZS4gUm91dGluZyB0aHJvdWdoIHRoZSBmdW5uZWxcbiAgICAgIC8vIGlzIHdoYXQgdHVybnMgdGhhdCBpbnRvIGEgdmlzaWJsZSBmYWlsdXJlLlxuICAgICAgcmV0dXJuIGFja09yRmFpbChtc2cudHlwZSwgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBtc2csIHsgYXMsIHF1aWV0OiB0cnVlIH0pKTtcbiAgICB9XG4gICAgY2FzZSBcImNsb3NlXCI6IHtcbiAgICAgIC8vIFNhbWUgZXhwbGljaXQgZGVjaXNpb24gYXMgYG1lc3NhZ2VgOiBhcHBsaWVkOnRydWUgdW5jb25kaXRpb25hbGx5IHRvZGF5LFxuICAgICAgLy8gc28gdGhpcyBpcyBhIHJlZ3Jlc3Npb24gZ3VhcmQgcmF0aGVyIHRoYW4gYSBmaXguIEl0IGVhcm5zIGl0cyBwbGFjZVxuICAgICAgLy8gYmVjYXVzZSBgY2xvc2VgIGlzIHRoZSB2ZXJiIHRoYXQgV1JJVEVTIFRIRSBTTkFQU0hPVCDigJQgYSBjbG9zZSB0aGF0XG4gICAgICAvLyBzaWxlbnRseSBmYWlsZWQgdG8gYXBwbHksIHJlcG9ydGVkIGFzIHN1Y2Nlc3MsIGlzIGhvdyBhIGNhbGxlciBjb25jbHVkZXNcbiAgICAgIC8vIGl0cyBkYXRhIHdhcyBwZXJzaXN0ZWQgd2hlbiBpdCB3YXMgbm90LlxuICAgICAgY29uc3QgY2xvc2VSZXMgPSBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0sIHsgYXMsIHF1aWV0OiB0cnVlIH0pO1xuICAgICAgLy8gYjE0IOKAlCBXQUlUIEZPUiBJVCBUTyBBQ1RVQUxMWSBCRSBET1dOLiBgY2xvc2VgIHVzZWQgdG8gcmV0dXJuIGFzIHNvb24gYXNcbiAgICAgIC8vIHRoZSBkYWVtb24gQUNLRUQgdGhlIGNvbW1hbmQsIGFuZCB0aGUgZGFlbW9uIGFja3MgYmVmb3JlIGl0IGZpbmlzaGVzXG4gICAgICAvLyB0ZWFyaW5nIGRvd24uIE1lYXN1cmVkOiBgc3RhdGVgIG9uIHRoZSBzYW1lIHNlc3Npb24gU1RJTEwgQU5TV0VSUyB3aXRoXG4gICAgICAvLyB0aGUgZnVsbCBib2FyZCBpbW1lZGlhdGVseSBhZnRlciBhIHN1Y2Nlc3NmdWwgY2xvc2UsIGFuZCBvbmx5IHN0b3BzXG4gICAgICAvLyBhZnRlciBhIHNldHRsZS4gU28gYSBjYWxsZXIgdGhhdCBjbG9zZWQgYW5kIHJlb3BlbmVkIGF0dGFjaGVkIHRvIHRoZVxuICAgICAgLy8gZHlpbmcgYm9hcmQgaW5zdGVhZCBvZiByZXNwYXduaW5nIOKAlCBzdWNjZXNzIHJlcG9ydGVkIGFuIEFDVCwgbm90IGl0c1xuICAgICAgLy8gQ09NUExFVElPTi5cbiAgICAgIC8vXG4gICAgICAvLyBUaGUgd2FpdCBpcyBub3QgbmV3IG1hY2hpbmVyeTogYG9wZW4gLS1mcmVzaGAgYWxyZWFkeSBwb2xsc1xuICAgICAgLy8gYGJvYXJkSWZMaXZlYCBmb3IgdXAgdG8gM3MgYWZ0ZXIgaXRzIG93biB0ZWFyZG93biBQT1NULiBUaGlzIGFwcGxpZXMgdGhlXG4gICAgICAvLyBkaXNjaXBsaW5lIHRoYXQgYWxyZWFkeSBleGlzdGVkIG9uZSBmdW5jdGlvbiBhd2F5LCB3aGljaCBpcyBhbHNvIHdoeSB0aGVcbiAgICAgIC8vIGJvdW5kIGFuZCB0aGUgaW50ZXJ2YWwgbWF0Y2ggaXQgcmF0aGVyIHRoYW4gYmVpbmcgaW52ZW50ZWQgaGVyZS5cbiAgICAgIC8vXG4gICAgICAvLyBgZG93bmAgaXMgUkVQT1JURUQgcmF0aGVyIHRoYW4gZW5mb3JjZWQ6IGlmIHRoZSBkYWVtb24gb3V0bGl2ZXMgdGhlXG4gICAgICAvLyBib3VuZCwgdGhhdCBpcyBhIHJlYWwgZmFjdCBhIGNhbGxlciBtYXkgbmVlZCAoYSB3ZWRnZWQgdGVhcmRvd24pLCBhbmRcbiAgICAgIC8vIGV4aXRpbmcgbm9uLXplcm8gd291bGQgdHVybiBhIHNsb3cgY2xvc2UgaW50byBhIGZhaWxlZCBvbmUuIFByZXNlbnQgb25cbiAgICAgIC8vIGV2ZXJ5IGNsb3NlLCBuZXZlciBhYnNlbnQg4oCUIGEgcmVhZGFibGUgYmxhbmsgYmVhdHMgYW4gYWJzZW5jZS5cbiAgICAgIGNvbnN0IHJlc29sdmVkID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gICAgICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICAgICAgbGV0IGRvd24gPSBmYWxzZTtcbiAgICAgIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICAgICAgaWYgKCEoYXdhaXQgYm9hcmRJZkxpdmUocmVzb2x2ZWQuc2Vzc2lvbl9pZCkpKSB7XG4gICAgICAgICAgZG93biA9IHRydWU7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgc2xlZXAoODApO1xuICAgICAgfVxuICAgICAgaWYgKCFjbG9zZVJlcy5hcHBsaWVkKSByZXR1cm4gYWNrT3JGYWlsKFwiY2xvc2VcIiwgY2xvc2VSZXMpO1xuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IFwiY2xvc2VcIiwgZG93biB9KTtcbiAgICAgIGlmICghZG93bilcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgXCJib3VudHk6IGNsb3NlIGFja2VkIGJ1dCB0aGUgZGFlbW9uIHdhcyBzdGlsbCBhbnN3ZXJpbmcgYWZ0ZXIgM3Mg4oCUIGEgcmVvcGVuIG1heSBhdHRhY2ggdG8gaXRcXG5cIixcbiAgICAgICAgKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBjYXNlIFwiaW5mb1wiOlxuICAgICAgY21kSW5mbyhzZXNzaW9uKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzZXNzaW9uc1wiOlxuICAgICAgY21kU2Vzc2lvbnMoKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJsaXN0XCI6XG4gICAgICBhd2FpdCBjbWRMaXN0KCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaGVscFwiOlxuICAgIGNhc2UgXCItLWhlbHBcIjpcbiAgICBjYXNlIFwiLWhcIjpcbiAgICBjYXNlIHVuZGVmaW5lZDpcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgICBicmVhaztcbiAgICBkZWZhdWx0OlxuICAgICAgZGllKGB1bmtub3duIHZlcmIgXCIke3ZlcmJ9XCIg4oCUIHJ1bjogY2xpLnRzIGhlbHBgKTtcbiAgfVxuICByZXR1cm4gMDtcbn1cblxuLyoqXG4gKiBUaGUgcHJvY2VzcyBlbnRyeSwgY2FsbGVkIGJ5IHRoZSBMQVVOQ0hFUiBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ib3VudHkvc2NyaXB0cy9jbGkudHNgLlxuICpcbiAqIOKblCBUSEVSRSBJUyBOTyBgaWYgKGltcG9ydC5tZXRhLm1haW4pYCBCTE9DSyBIRVJFLCBBTkQgSVRTIEFCU0VOQ0UgSVMgVEhFXG4gKiBQT0lOVC4gVGhpcyBtb2R1bGUgc2hpcHMgQlVORExFRCBhdCBgLi4vZGlzdC9jbGkuanNgIGFuZCBpcyBJTVBPUlRFRCBieSB0aGVcbiAqIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2VzcyBlbnRyeSDigJQgc28gYGltcG9ydC5tZXRhLm1haW5gIGlzXG4gKiBGQUxTRSBpbiB0aGUgYXJ0aWZhY3QgYW5kIGEgZ3VhcmRlZCBibG9jayB3b3VsZCBuZXZlciBydW4uIFRoZSBzeW1wdG9tIGlzIG5vdFxuICogYSBjcmFzaDogZXZlcnkgdmVyYiB3b3VsZCBwcmludCBub3RoaW5nIGFuZCBleGl0IDAgKHBsYXlib29rIFBoYXNlIEIsIEIzKS5cbiAqXG4gKiDimqAgVEhFIEVYSVQgRElTQ0lQTElORSBNT1ZFRCBXSVRIIElUIEFORCBNVVNUIE5PVCBCRSBcIlRJRElFRFwiLiBUaGlzIGZ1bmN0aW9uXG4gKiBSRVRVUk5TIGEgY29kZTsgdGhlIGxhdW5jaGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgIGFuZCByZXR1cm5zXG4gKiBuYXR1cmFsbHksIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgLiBCdW4ncyBzdGRvdXQgaXMgYXN5bmNocm9ub3VzIG9uIGEgUElQRVxuICogYW5kIHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUsIHNvIGFuIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzXG4gKiBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgaW4gdGhpcyByZXBvIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCB3aXRoIHRoZSBmaWxlXG4gKiBmb3JtIG9mIHRoZSBzYW1lIHBheWxvYWQgY29tcGxldGUuIFRoZSBzeW1wdG9tIGlzIGEgdHJ1bmNhdGVkIEpTT04gYm9keSB0aGF0XG4gKiBmYWlscyB0byBwYXJzZSwgYW5kIHRoZSBoYXJtIGlzIHdvcnNlIHRoYW4gYSBjcmFzaDogYSByZWFkZXIgY29uY2x1ZGVkIFwib3VyXG4gKiBib2FyZCBpcyB0b28gYmlnIHRvIHJlYWRcIiBhbmQgdGhyZWUgYWdlbnRzIHdvcmtlZCB1bmRlciB0aGF0IGZhbHNlIHJ1bGUuXG4gKiBib3VudHkncyBgc3RhdGVgIG9uIGEgbGFyZ2UgYm9hcmQgaXMgZXhhY3RseSB0aGF0IHBheWxvYWQuXG4gKlxuICogYHJ1bigpYCB0YWtlcyBOTyBBUkdVTUVOVFM6IHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IFBBUlNFU1xuICogaXQsIHdoaWNoIGlzIHRoaXMgb25lLiBBIGxhdW5jaGVyIHRoYXQgcmVhZCB0aGUgYXJndW1lbnQgdmVjdG9yIHdvdWxkIG1hdGNoXG4gKiB0aGUgcm9zdGVyIGVudW1lcmF0b3IncyBhcmctcGFyc2luZyBwcmVkaWNhdGUgaW5cbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCwgYW5kIHRoZSBmbGFnIHdhcmQgd291bGQgdGhlbiBqdWRnZSBib3VudHknc1xuICogZG9jdW1lbnRlZCBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0IHJlY29nbmlzZXMgbm9uZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgdHlwZSB7IFNlc3Npb24gfTtcbmV4cG9ydCB7IGxpdmVCb2FyZHMsIG1haW4sIG93bmVySW5TY29wZSwgcGFyc2VUYWdzLCBwaWNrVGFpbFNlc3Npb24sIHJlc29sdmVTZXNzaW9uIH07XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBMENBO0FBQ0E7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFTQTtBQUNBO0FBQ0E7QUFDQSxzQkFBUztBQUVULElBQU0sYUFBYSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFhekQsSUFBTSxnQkFBZ0IsS0FBSyxZQUFZLE1BQU0sV0FBVyxXQUFXO0FBQ25FLElBQU0sYUFBYSxLQUFLLFlBQVksSUFBSTtBQUN4QyxJQUFNLFdBQVcsS0FBSyxZQUFZLE1BQU07QUFVeEMsSUFBTSxjQUFjLEtBQUssWUFBWSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sT0FBTyxRQUFRO0FBRWxGLFNBQVMsU0FBUyxHQUFXO0FBQUEsRUFDM0IsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBVyxPQUFPO0FBQUEsRUFDN0QsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FB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QUFBQSxRQUM1QixJQUFJLENBQUUsTUFBTSxZQUFZLFNBQVMsVUFBVSxHQUFJO0FBQUEsVUFDN0MsT0FBTztBQUFBLFVBQ1A7QUFBQSxRQUNGO0FBQUEsUUFDQSxNQUFNLE1BQU0sRUFBRTtBQUFBLE1BQ2hCO0FBQUEsTUFDQSxJQUFJLENBQUMsU0FBUztBQUFBLFFBQVMsT0FBTyxVQUFVLFNBQVMsUUFBUTtBQUFBLE1BQ3pELFVBQVUsRUFBRSxJQUFJLE1BQU0sTUFBTSxTQUFTLEtBQUssQ0FBQztBQUFBLE1BQzNDLElBQUksQ0FBQztBQUFBLFFBQ0gsUUFBUSxPQUFPLE1BQ2I7QUFBQSxDQUNGO0FBQUEsTUFDRixPQUFPO0FBQUEsSUFDVDtBQUFBLFNBQ0s7QUFBQSxNQUNILFFBQVEsT0FBTztBQUFBLE1BQ2Y7QUFBQSxTQUNHO0FBQUEsTUFDSCxZQUFZO0FBQUEsTUFDWjtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sUUFBUTtBQUFBLE1BQ2Q7QUFBQSxTQUNHO0FBQUEsU0FDQTtBQUFBLFNBQ0E7QUFBQSxTQUNBO0FBQUEsTUFDSCxRQUFRLE9BQU8sTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBLE1BQ2hDO0FBQUE7QUFBQSxNQUVBLElBQUksaUJBQWlCLCtCQUEwQjtBQUFBO0FBQUEsRUFFbkQsT0FBTztBQUFBO0FBNkJULGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkRGRkE4NzUyN0RCNzFGNUY2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
