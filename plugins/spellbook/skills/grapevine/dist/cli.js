#!/usr/bin/env bun
// @bun

// src/grapevine/backend/cli.ts
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";
var DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
var PORT_FILE = join(DATA_DIR, "daemon.port");
var PID_FILE = join(DATA_DIR, "daemon.pid");
var HOLD_FILE = join(DATA_DIR, "daemon.hold");
var CONFIG_FILE = join(DATA_DIR, "config.json");
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var DAEMON_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "daemon.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "grapevine");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
function readPluginVersion() {
  try {
    const pluginJsonPath = join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf-8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var _versionCheckDone = false;
async function maybeWarnOnVersionMismatch(port) {
  if (_versionCheckDone)
    return;
  _versionCheckDone = true;
  if (!PLUGIN_VERSION)
    return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    if (!res.ok)
      return;
    const data = await res.json();
    const daemonVersion = data?.version ?? null;
    if (daemonVersion === null) {
      process.stderr.write(`# grapevine: daemon is older than this CLI (no version reported). ` + `CLI is v${PLUGIN_VERSION}. Some features may silently degrade. ` + `Restart the daemon (drop tails, then \`stop\`, then any verb) to upgrade.
`);
    } else if (daemonVersion !== PLUGIN_VERSION) {
      process.stderr.write(`# grapevine: daemon version (v${daemonVersion}) differs from CLI version (v${PLUGIN_VERSION}). ` + `Some features may silently degrade. Restart the daemon to align.
`);
    }
  } catch {}
}
var DEFAULT_ALIAS = process.env.GRAPEVINE_FROM ?? undefined;
function resolveAlias(flags) {
  return flags.from ?? flags.as ?? DEFAULT_ALIAS;
}
var TRUNCATION_HINT_THRESHOLD = parseInt(process.env.GRAPEVINE_TRUNCATION_HINT_THRESHOLD ?? "2000", 10);
function resolveTailMax(flag) {
  const raw = typeof flag === "string" ? flag : process.env.GRAPEVINE_TAIL_MAX;
  if (raw === undefined)
    return;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function die(msg, code = 2) {
  process.stderr.write(`grapevine: ${msg}
`);
  process.exit(code);
}
async function readDaemonPort() {
  if (!existsSync(PORT_FILE))
    return null;
  const raw = readFileSync(PORT_FILE, "utf-8").trim();
  const port = parseInt(raw, 10);
  if (!port)
    return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    if (res.ok) {
      maybeWarnOnVersionMismatch(port);
      return port;
    }
  } catch {}
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  return null;
}
function holdActive() {
  try {
    if (!existsSync(HOLD_FILE))
      return null;
    const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now())
      return until;
    try {
      unlinkSync(HOLD_FILE);
    } catch {}
    return null;
  } catch {
    return null;
  }
}
function releaseHold() {
  try {
    if (existsSync(HOLD_FILE))
      unlinkSync(HOLD_FILE);
  } catch {}
}
async function ensureDaemon() {
  let port = await readDaemonPort();
  if (port)
    return port;
  if (holdActive())
    die("daemon is held (respawn suppressed) \u2014 wait for the hold to clear or run `grapevine roll`");
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    die(`grapevine cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}. ` + "No dist/index.html was found (or SPELLBOOK_SURFACE_MODE=dev is set), so the daemon " + "must run from src/grapevine/ to bundle the watch surface, which a source-free install " + "does not have. Either the shipped dist/ is missing (reinstall the spell) or you are in " + "a checkout without src/grapevine/.");
  }
  const proc = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd
  });
  proc.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    port = await readDaemonPort();
    if (port)
      return port;
  }
  die("daemon failed to start within 3s");
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
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function invocationPrefix() {
  const entry = process.argv[1];
  return entry ? `bun ${entry}` : "";
}
function apiError(data, status) {
  const msg = data?.error ?? `HTTP ${status}`;
  if (!data?.hint)
    return msg;
  const prefix = invocationPrefix();
  return prefix ? `${msg} \u2014 try: ${prefix} ${data.hint}` : `${msg} \u2014 try the \`${data.hint}\` verb`;
}
async function requireChannel(port, name) {
  const { status, data } = await api(port, "GET", `/channels/${name}/topic`);
  if (status >= 400)
    die(apiError(data, status));
}
async function cmdOpen(name, opts) {
  if (!name)
    die("usage: grapevine open <name> [--topic <text>] [--fresh]");
  const port = await ensureDaemon();
  const body = { name, explicit: true };
  if (opts.topic !== undefined)
    body.topic = opts.topic;
  if (opts.from !== undefined)
    body.from = opts.from;
  if (opts.fresh)
    body.fresh = true;
  const { status, data } = await api(port, "POST", "/channels", body);
  if (status >= 400)
    die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, channel: data });
}
async function cmdTopic(name, text, from) {
  if (!name)
    die("usage: grapevine topic <channel> [<text>]");
  const port = await ensureDaemon();
  if (text === undefined) {
    const { status: status2, data: data2 } = await api(port, "GET", `/channels/${name}/topic`);
    if (status2 >= 400)
      die(apiError(data2, status2));
    printJson({ ok: true, channel: name, topic: data2?.topic });
    return;
  }
  const ensure = await api(port, "POST", "/channels", { name });
  if (ensure.status >= 400)
    die(apiError(ensure.data, ensure.status));
  const { status, data } = await api(port, "PUT", `/channels/${name}/topic`, {
    topic: text,
    from: from ?? "system"
  });
  if (status >= 400)
    die(apiError(data, status));
  printJson({ ok: true, channel: name, topic: data?.topic, id: data?.id });
}
async function cmdList() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { data } = await api(port, "GET", "/channels");
  printJson({ ok: true, daemon: true, ...data });
}
async function cmdSend(name, from, text, opts) {
  if (!name || !from || !text)
    die("usage: grapevine send <name> --from <alias> <text...>");
  const port = await ensureDaemon();
  const body = {
    from,
    text
  };
  if (opts.inReplyTo !== undefined)
    body.in_reply_to = opts.inReplyTo;
  const { status, data } = await api(port, "POST", `/channels/${name}/messages`, body);
  if (status >= 400 || !data)
    die(apiError(data, status));
  const recip = data.recipients !== undefined ? `${data.recipients} recipient(s)` : `${data.subscribers ?? 0} subscriber(s)`;
  process.stderr.write(`# \u2192 ${data.channel} \xB7 ${recip}
`);
  if (opts.quiet)
    return;
  const out = {
    ok: true,
    id: data.id,
    channel: data.channel,
    subscribers: data.subscribers ?? 0
  };
  if (data.recipients !== undefined)
    out.recipients = data.recipients;
  if (data.subscribers === 0)
    out.warning = "channel has no subscribers";
  else if (data.recipients === 0)
    out.warning = "only you are subscribed";
  if (opts.verbose)
    out.subscriber_aliases = data.subscriber_aliases ?? [];
  printJson(out);
}
async function cmdAnnounce(from, text, channels, opts) {
  if (!from || !text)
    die("usage: grapevine announce --from <alias> <text...>");
  const port = await ensureDaemon();
  const body = { from, text };
  if (channels?.length)
    body.channels = channels;
  const { status, data } = await api(port, "POST", "/announce", body);
  if (status >= 400 || !data)
    die(apiError(data, status));
  process.stderr.write(`# announced \u2192 ${data.channels.length} channel(s) \xB7 ${data.total_recipients} recipient(s)
`);
  if (opts.quiet)
    return;
  const out = {
    ok: true,
    channels: data.channels,
    total_recipients: data.total_recipients
  };
  if (data.skipped?.length)
    out.skipped = data.skipped;
  if (data.channels.length === 0)
    out.warning = "no active channels to announce to";
  printJson(out);
}
async function cmdPull(name, since, opts = {}) {
  if (!name)
    die("usage: grapevine pull <channel> [--since <id>] [--status <value>]");
  const port = await ensureDaemon();
  if (opts.status !== undefined) {
    await requireChannel(port, name);
    const badged = loadChannelMessagesBadged(name);
    const filtered = badged.filter((m) => {
      const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
      return opts.status === "open" ? m.kind === "message" && isOpen(dispArg) : m.disposition === opts.status;
    });
    const lastId = filtered.length ? filtered[filtered.length - 1].id : 0;
    printJson({ ok: true, messages: filtered, cursor: lastId });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${since}`);
  if (status >= 400)
    die(apiError(data, status));
  const rawMsgs = data?.messages ?? [];
  const cursor = rawMsgs.length ? rawMsgs[rawMsgs.length - 1].id : since;
  const disp = foldDispositions(name);
  const annotated = rawMsgs.filter((m) => !isDispositionFrame(m)).map((m) => {
    const d = disp.get(m.id);
    return d ? { ...m, disposition: d.disposition, reopens: d.reopens } : m;
  });
  printJson({ ok: true, messages: annotated, cursor });
}
async function cmdRead(name, id, opts) {
  if (!name || !Number.isFinite(id))
    die("usage: grapevine read <channel> <id> [--text]");
  const port = await ensureDaemon();
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${id - 1}`);
  if (status >= 400)
    die(apiError(data, status));
  const msg = (data?.messages ?? []).find((m) => m.id === id);
  if (!msg)
    die(`message ${id} not found in ${name}`, 1);
  const dispMap = foldDispositions(name);
  const d = dispMap.get(id);
  const annotatedMsg = d ? { ...msg, disposition: d.disposition, reopens: d.reopens } : msg;
  if (opts.text) {
    const ts = new Date(msg.ts).toISOString();
    const dispPrefix = d ? d.reopens > 0 ? `[${d.disposition} \u21BB${d.reopens}] ` : `[${d.disposition}] ` : "";
    process.stdout.write(`${dispPrefix}[${msg.id}] ${msg.from} \xB7 ${ts}
${msg.text}
`);
    return;
  }
  printJson({ ok: true, message: annotatedMsg });
}
async function cmdWait(name, since, timeoutS, alias) {
  if (!name)
    die("usage: grapevine wait <channel> [--as <alias>] [--since <id>] [--timeout <s>]");
  const port = await ensureDaemon();
  const asParam = alias ? `&as=${encodeURIComponent(alias)}` : "";
  const url = `http://127.0.0.1:${port}/channels/${name}/wait?since=${since}&timeout=${timeoutS}${asParam}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout((timeoutS + 5) * 1000)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok)
    die(apiError(data, res.status));
  printJson({
    ok: true,
    messages: data?.messages ?? [],
    cursor: data?.cursor ?? since,
    timed_out: !!data?.timed_out
  });
}
async function cmdWho(name) {
  if (!name)
    die("usage: grapevine who <channel>");
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channel: name, subscribers: [] });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/subscribers`);
  if (status >= 400)
    die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}
async function cmdWhoAll() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { status, data } = await api(port, "GET", "/presence");
  if (status >= 400)
    die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}
async function cmdAlias(name) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  if (name === undefined) {
    const alias = typeof cfg.alias === "string" && cfg.alias.trim() ? cfg.alias.trim() : null;
    printJson({ ok: true, alias });
    return;
  }
  const trimmed = name.trim();
  cfg.alias = trimmed;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}
`);
  printJson({ ok: true, alias: trimmed || null });
}
async function cmdTail(name, opts) {
  if (!name)
    die("usage: grapevine tail <name> [--as <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]");
  const myAlias = opts.lurk ? undefined : opts.as;
  let stopped = false;
  const cleanup = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  let highestSeen = opts.fromStart ? 0 : opts.since ?? -1;
  let reconnectDelay = 250;
  let grounded = false;
  while (!stopped) {
    const port = await ensureDaemon();
    const asParam = myAlias ? `&as=${encodeURIComponent(myAlias)}` : "";
    const humanParam = opts.human && !opts.lurk ? "&human=1" : "";
    const lurkParam = opts.lurk ? "&lurk=1" : "";
    const lastParam = opts.last !== undefined && highestSeen < 0 ? `&last=${opts.last}` : "";
    const url = `http://127.0.0.1:${port}/channels/${name}/tail?since=${highestSeen}${lastParam}${asParam}${humanParam}${lurkParam}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      process.stderr.write(`# connect failed: ${e instanceof Error ? e.message : String(e)}, retrying\u2026
`);
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      continue;
    }
    if (!res.ok || !res.body) {
      process.stderr.write(`# tail HTTP ${res.status}, retrying\u2026
`);
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      continue;
    }
    reconnectDelay = 250;
    const reader = res.body.getReader();
    const decoder = new TextDecoder;
    let buffer = "";
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        process.stderr.write(`# stream dropped: ${e instanceof Error ? e.message : String(e)}, reconnecting\u2026
`);
        break;
      }
      if (chunk.done) {
        process.stderr.write(`# stream closed, reconnecting\u2026
`);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let sep = buffer.indexOf(`

`);sep >= 0; sep = buffer.indexOf(`

`)) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = block.split(`
`);
        let eventName = "message";
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith(":")) {
            if (line.startsWith(": hb"))
              process.stderr.write(`: grapevine-keepalive
`);
            continue;
          }
          if (line.startsWith("event:"))
            eventName = line.slice(6).trim();
          else if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length)
          continue;
        try {
          const payload = JSON.parse(dataLines.join(`
`));
          if (eventName === "subscribed") {
            process.stderr.write(`# subscribed to ${payload.channel} (since=${payload.since})
`);
            if (payload.topic)
              process.stderr.write(`# topic: ${payload.topic}
`);
            if (payload.created)
              process.stderr.write(`# created ${payload.channel} \u2014 this tail brought it into being (check the name)
`);
            if (payload.archived)
              process.stderr.write(`# ${payload.channel} is archived \u2014 read-only; a send will be rejected
`);
            if (!grounded) {
              grounded = true;
              const latest = typeof payload.latest_id === "number" ? payload.latest_id : 0;
              const earlier = highestSeen < 0 ? latest : Math.max(0, Math.min(highestSeen, latest));
              const hints = [];
              if (earlier > 0)
                hints.push(`${earlier} earlier message(s) exist \u2014 use --from-start or --since <id> to backfill`);
              if (payload.created)
                hints.push(`this tail created ${payload.channel} \u2014 no such channel existed; check the name, or another party has yet to open it`);
              if (payload.archived)
                hints.push(`${payload.channel} is archived \u2014 read-only; a send will be rejected until someone unarchives it`);
              if (earlier > 0 || payload.topic || payload.created || payload.archived) {
                const grounding = {
                  kind: "grounding",
                  channel: payload.channel,
                  joined_at: highestSeen < 0 ? latest : Math.min(highestSeen, latest),
                  earlier
                };
                if (payload.topic)
                  grounding.topic = payload.topic;
                if (payload.created)
                  grounding.created = true;
                if (payload.archived)
                  grounding.archived = true;
                if (hints.length)
                  grounding.hint = hints.join(" \xB7 ");
                process.stdout.write(`${JSON.stringify(grounding)}
`);
              }
            }
            continue;
          }
          if (typeof payload.id === "number" && payload.id > highestSeen) {
            highestSeen = payload.id;
          }
          if (isDispositionFrame(payload))
            continue;
          if (myAlias && payload.from === myAlias)
            continue;
          const readRef = `read ${name} ${payload.id}`;
          if (typeof payload.text === "string" && payload.text.length > (opts.max ?? TRUNCATION_HINT_THRESHOLD)) {
            const truncation_hint = `+${payload.text.length} chars \u2014 full: ${readRef}`;
            const text = opts.max !== undefined ? payload.text.slice(0, opts.max) : payload.text;
            process.stdout.write(`${JSON.stringify({ truncation_hint, ...payload, text })}
`);
          } else {
            process.stdout.write(`${JSON.stringify({ full: readRef, ...payload })}
`);
          }
        } catch (e) {
          process.stderr.write(`# bad sse data: ${e instanceof Error ? e.message : String(e)}
`);
        }
      }
    }
    if (!stopped)
      await new Promise((r) => setTimeout(r, 200));
  }
}
function foldDispositions(name) {
  const map = new Map;
  const path = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(path))
    return map;
  for (const line of readFileSync(path, "utf-8").split(`
`)) {
    if (!line.trim())
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind !== "status" || typeof m.target !== "number" || typeof m.disposition !== "string")
      continue;
    const prev = map.get(m.target);
    const reopens = (prev?.reopens ?? 0) + (m.disposition === "open" && prev && prev.disposition !== "open" ? 1 : 0);
    map.set(m.target, {
      disposition: m.disposition,
      from: m.from,
      ts: m.ts,
      note: m.text,
      reopens
    });
  }
  return map;
}
function isDispositionFrame(m) {
  return m.kind === "status" && typeof m.disposition === "string";
}
function isOpen(d) {
  return !d || d.disposition === "open";
}
function loadChannelMessagesBadged(name) {
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath))
    return [];
  const disp = foldDispositions(name);
  const messages = [];
  for (const line of readFileSync(logPath, "utf-8").split(`
`)) {
    if (!line.trim())
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind === "status")
      continue;
    const d = disp.get(m.id);
    if (d) {
      messages.push({ ...m, disposition: d.disposition, reopens: d.reopens });
    } else {
      messages.push(m);
    }
  }
  return messages;
}
function renderTriageHuman(name, open, by_status) {
  const line = (m) => {
    const ts = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
    const reopen = m.reopens && m.reopens > 0 ? ` \u21BB${m.reopens}` : "";
    const head = m.text.split(`
`)[0];
    const preview = head.length > 100 ? `${head.slice(0, 99)}\u2026` : head;
    return `  [${m.id}${reopen}] ${m.from} \xB7 ${ts} \xB7 ${preview}`;
  };
  const sections = [`${name} \xB7 triage
`, `OPEN (${open.length})`];
  sections.push(open.length ? open.map(line).join(`
`) : "  \u2014");
  for (const [status, items] of Object.entries(by_status)) {
    sections.push(`
${status.toUpperCase()} (${items.length})`, items.map(line).join(`
`));
  }
  return `${sections.join(`
`)}
`;
}
async function cmdTriage(name, opts = {}) {
  if (!name)
    die("usage: grapevine triage <channel> [--human]");
  const port = await ensureDaemon();
  await requireChannel(port, name);
  const badged = loadChannelMessagesBadged(name);
  const open = [];
  const by_status = {};
  for (const m of badged) {
    const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
    if (isOpen(dispArg)) {
      if (m.kind === "message")
        open.push(m);
    } else {
      const key = m.disposition ?? "unknown";
      if (!by_status[key])
        by_status[key] = [];
      by_status[key].push(m);
    }
  }
  if (opts.human) {
    process.stdout.write(renderTriageHuman(name, open, by_status));
    return;
  }
  printJson({ ok: true, open, by_status });
}
async function cmdGrep(name, pattern, opts) {
  if (!name || !pattern)
    die("usage: grapevine grep <channel> <pattern> [--literal|-F] [--from <alias>]");
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath)) {
    printJson({ ok: true, messages: [] });
    return;
  }
  let matcher;
  if (opts.literal) {
    const needle = pattern.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(needle);
  } else {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      die(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
    matcher = (text) => re.test(text);
  }
  const raw = readFileSync(logPath, "utf-8");
  const messages = [];
  for (const line of raw.split(`
`)) {
    if (!line)
      continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.text !== "string")
      continue;
    if (opts.from && msg.from !== opts.from)
      continue;
    if (!matcher(msg.text))
      continue;
    messages.push(msg);
  }
  printJson({ ok: true, messages });
}
async function cmdClose(name) {
  if (!name)
    die("usage: grapevine close <name>");
  const port = await readDaemonPort();
  if (!port)
    die("no daemon running");
  const { status, data } = await api(port, "DELETE", `/channels/${name}`);
  if (status >= 400)
    die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true });
}
async function cmdReset(name, opts) {
  if (!name)
    die("usage: grapevine reset <name> [--force]");
  const port = await ensureDaemon();
  const body = {};
  if (opts.force)
    body.force = true;
  const { status, data } = await api(port, "POST", `/channels/${name}/reset`, body);
  if (status === 409 && data?.error === "live") {
    die(`channel has ${data.subscribers} live subscriber(s) \u2014 refusing to clear a live session. Re-run with --force to clear anyway (the log is snapshotted first).`);
  }
  if (status >= 400)
    die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}
async function cmdMark(name, id, disposition, from, opts) {
  if (!name || !Number.isFinite(id) || !disposition)
    die("usage: grapevine mark <channel> <id> <disposition> [--note <text>] [--as <alias>]");
  const port = await ensureDaemon();
  const body = { from, target: id, disposition };
  if (opts.note !== undefined)
    body.note = opts.note;
  const { status, data } = await api(port, "POST", `/channels/${name}/status`, body);
  if (status >= 400 || !data)
    die(data?.error ?? `HTTP ${status}`);
  printJson(data);
}
async function cmdArchive(name, unarchive, from) {
  const verb = unarchive ? "unarchive" : "archive";
  if (!name)
    die(`usage: grapevine ${verb} <channel>`);
  const port = await ensureDaemon();
  const { status, data } = await api(port, "POST", `/channels/${name}/${verb}`, from ? { from } : undefined);
  if (status >= 400)
    die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}
async function cmdStop(opts = {}) {
  let heldUntil;
  if (opts.holdSeconds && opts.holdSeconds > 0) {
    heldUntil = Date.now() + opts.holdSeconds * 1000;
    try {
      writeFileSync(HOLD_FILE, String(heldUntil));
    } catch {}
  }
  const port = await readDaemonPort();
  if (!port) {
    printJson({
      ok: true,
      daemon: false,
      ...heldUntil !== undefined ? { held_until: heldUntil } : {}
    });
    return;
  }
  try {
    await api(port, "DELETE", "/");
  } catch {}
  printJson({
    ok: true,
    stopped: true,
    ...heldUntil !== undefined ? { held_until: heldUntil } : {}
  });
}
async function fetchActiveSubscribers(port) {
  let total = 0;
  const channels = [];
  try {
    const { data } = await api(port, "GET", "/presence");
    for (const ch of data?.channels ?? []) {
      total += ch.connections;
      if (ch.connections > 0)
        channels.push({ name: ch.name, connections: ch.connections });
    }
  } catch {}
  return { total, channels };
}
async function cmdStart() {
  const existing = await readDaemonPort();
  if (!existing && holdActive()) {
    printJson({ ok: true, held: true, port: null });
    return;
  }
  const port = existing ?? await ensureDaemon();
  printJson({ ok: true, port, already_running: existing !== null });
}
async function cmdRestart(opts) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh2 = await ensureDaemon();
    printJson({ ok: true, restarted: true, port: fresh2, previous_pid: null });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die(`restart: ${total} active subscriber(s) across ${channels.length} channel(s) \u2014 ${where}. ` + "A restart would force them all to reconnect. Re-run with --force (or --yes) to proceed anyway.");
  }
  let previousPid = null;
  try {
    const { data } = await api(port, "GET", "/");
    previousPid = data?.pid ?? null;
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      break;
  }
  const fresh = await ensureDaemon();
  printJson({ ok: true, restarted: true, port: fresh, previous_pid: previousPid });
}
async function probeVersion(port) {
  try {
    const v = (await api(port, "GET", "/")).data?.version ?? null;
    if (v === null) {
      return {
        version: null,
        version_ok: null,
        version_unchecked_reason: "the daemon answered but reported no version"
      };
    }
    return { version: v, version_ok: v === PLUGIN_VERSION, version_unchecked_reason: null };
  } catch (e) {
    return {
      version: null,
      version_ok: null,
      version_unchecked_reason: `could not reach the daemon to verify: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
async function cmdRoll(opts) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh2 = await ensureDaemon();
    printJson({
      ok: true,
      rolled: true,
      previous_pid: null,
      port: fresh2,
      ...await probeVersion(fresh2)
    });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die(`roll: ${total} active subscriber(s) \u2014 ${where}. They'll auto-reconnect across the roll. Re-run with --force to proceed.`);
  }
  let previousPid = null;
  try {
    previousPid = (await api(port, "GET", "/")).data?.pid ?? null;
  } catch {}
  const holdMs = 4000;
  try {
    writeFileSync(HOLD_FILE, String(Date.now() + holdMs));
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      break;
  }
  releaseHold();
  const fresh = await ensureDaemon();
  let pid = null;
  try {
    pid = (await api(fresh, "GET", "/")).data?.pid ?? null;
  } catch {}
  printJson({
    ok: true,
    rolled: true,
    previous_pid: previousPid,
    pid,
    port: fresh,
    ...await probeVersion(fresh)
  });
}
async function cmdWatch(name) {
  const channel = name?.trim() ? name.trim() : "lobby";
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name: channel });
  const url = `http://127.0.0.1:${port}/watch#${encodeURIComponent(channel)}`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const p = spawn(opener, [url], {
      detached: true,
      stdio: "ignore"
    });
    p.unref();
  } catch {}
  printJson({ ok: true, channel, url });
}
async function cmdDoctor() {
  const port = await readDaemonPort();
  let authoritative = null;
  let totalSubscribers = 0;
  const busyChannels = [];
  if (port) {
    try {
      const { data } = await api(port, "GET", "/");
      authoritative = { port, ...data };
    } catch {}
    try {
      const { data: presData } = await api(port, "GET", "/presence");
      for (const ch of presData?.channels ?? []) {
        totalSubscribers += ch.connections;
        busyChannels.push({
          name: ch.name,
          subscribers: ch.connections,
          connections: ch.connections,
          named: ch.named,
          anonymous: ch.anonymous
        });
      }
    } catch {}
  }
  const otherDaemons = [];
  const selfPid = authoritative?.pid;
  try {
    for (const pid of await listGrapevineDaemonPids()) {
      if (selfPid && pid === selfPid)
        continue;
      otherDaemons.push(await classifyDaemon(pid));
    }
  } catch {}
  const channelsOnDisk = [];
  try {
    const channelsDir = join(DATA_DIR, "channels");
    if (existsSync(channelsDir)) {
      for (const f of readdirSync(channelsDir)) {
        if (f.endsWith(".jsonl"))
          channelsOnDisk.push(f.replace(/\.jsonl$/, ""));
      }
    }
  } catch {}
  const hints = [];
  if (!authoritative) {
    hints.push("No authoritative daemon running for this HOME. Run any verb (e.g. `cli.ts list`) to spawn one.");
  }
  if (otherDaemons.length > 0) {
    hints.push(`Found ${otherDaemons.length} other grapevine daemon process(es) on this machine. ` + "They may be zombies from past runs OR daemons serving other HOMEs (different GRAPEVINE_HOME).");
    const reapableCount = otherDaemons.filter((d) => d.reapable).length;
    if (reapableCount > 0) {
      hints.push(`Found ${reapableCount} reapable orphan daemon(s). Run \`grapevine reap\` to clear them safely.`);
    }
    if (otherDaemons.some((d) => d.status === "unresponsive")) {
      hints.push("Some daemons are unresponsive; `grapevine reap --force` includes them.");
    }
  }
  if (authoritative && PLUGIN_VERSION && typeof authoritative.version === "string" && authoritative.version !== PLUGIN_VERSION) {
    hints.push(`Authoritative daemon version (${authoritative.version}) differs from this CLI's version (${PLUGIN_VERSION}). ` + "Restart the daemon to align \u2014 drop active tails, then `stop`, then any verb.");
  }
  if (authoritative && (authoritative.version === null || authoritative.version === undefined)) {
    hints.push("Authoritative daemon predates version reporting (pre-V1.6.2). Restart to align.");
  }
  if (totalSubscribers > 0) {
    hints.push(`${totalSubscribers} active subscriber(s) across ${busyChannels.length} channel(s). ` + "Daemon restart would force them to auto-reconnect (works, but disruptive) \u2014 coordinate first.");
  } else if (authoritative) {
    hints.push("No active subscribers \u2014 daemon restart is non-disruptive.");
  }
  for (const ch of busyChannels) {
    if (ch.anonymous > 0) {
      hints.push(`${ch.name}: ${ch.connections} connection(s), ${ch.named} named agent(s) + ` + `${ch.anonymous} anonymous (e.g. a watch tab). The count over the name list is expected, not a ghost.`);
    }
  }
  printJson({
    ok: true,
    home: DATA_DIR,
    cli_version: PLUGIN_VERSION,
    authoritative,
    active_subscribers: {
      total: totalSubscribers,
      busy_channels: busyChannels
    },
    other_daemons_on_machine: otherDaemons,
    channels_on_disk: channelsOnDisk,
    hints
  });
}
async function cmdInfo() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false });
    return;
  }
  const { data } = await api(port, "GET", "/");
  printJson({ ok: true, daemon: true, ...data });
}
async function listGrapevineDaemonPids() {
  const pids = [];
  try {
    const proc = spawn("ps", ["-eo", "pid,command"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    proc.stdout?.on("data", (b) => chunks.push(b));
    await new Promise((resolve) => proc.on("exit", () => resolve()));
    const out = Buffer.concat(chunks).toString("utf-8");
    for (const line of out.split(`
`)) {
      if (!line.includes("daemon.ts"))
        continue;
      if (!line.toLowerCase().includes("grapevine"))
        continue;
      const m = line.match(/^\s*(\d+)\s+/);
      if (!m)
        continue;
      const pid = parseInt(m[1], 10);
      if (pid)
        pids.push(pid);
    }
  } catch {}
  return pids;
}
async function lsofListenPort(pid) {
  try {
    const proc = spawn("lsof", ["-aiTCP", "-sTCP:LISTEN", "-p", String(pid), "-P", "-n"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    proc.stdout?.on("data", (b) => chunks.push(b));
    await new Promise((r) => proc.on("exit", () => r()));
    const m = Buffer.concat(chunks).toString("utf-8").match(/127\.0\.0\.1:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}
async function classifyDaemon(pid) {
  const port = await lsofListenPort(pid);
  if (!port)
    return { pid, port: null, status: "unknown", reapable: false };
  let info = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800)
    });
    if (res.ok)
      info = await res.json();
  } catch {}
  if (!info)
    return { pid, port, status: "unresponsive", reapable: false };
  const home = info.data_dir;
  let owns = false;
  try {
    const op = readFileSync(join(home, "daemon.port"), "utf-8").trim();
    const oi = readFileSync(join(home, "daemon.pid"), "utf-8").trim();
    owns = op === String(port) && oi === String(pid);
  } catch {}
  return owns ? {
    pid,
    port,
    home,
    version: info.version ?? null,
    status: "authoritative",
    reapable: false
  } : {
    pid,
    port,
    home,
    version: info.version ?? null,
    status: "orphan",
    reapable: true
  };
}
async function cmdReap(opts) {
  const selfPort = await readDaemonPort();
  let selfPid = null;
  if (selfPort) {
    try {
      selfPid = (await api(selfPort, "GET", "/")).data?.pid ?? null;
    } catch {}
  }
  const pids = await listGrapevineDaemonPids();
  const kept = [], reaped = [], skipped = [];
  for (const pid of pids) {
    const c = await classifyDaemon(pid);
    const isSelf = pid === selfPid;
    const shouldReap = !isSelf && (c.reapable || c.status === "unresponsive" && opts.force === true);
    if (!shouldReap) {
      kept.push(c);
      continue;
    }
    if (opts.dryRun) {
      skipped.push({ ...c, note: "dry-run" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(c);
    } catch {
      skipped.push({ ...c, note: "kill failed" });
    }
  }
  printJson({ ok: true, dry_run: !!opts.dryRun, kept, reaped, skipped });
}
var LEAKED_SEND_RE = /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\b(?:send|announce)\b/;
function looksLikeLeakedSend(text) {
  return LEAKED_SEND_RE.test(text);
}
var SHELL_METACHAR_RE = /`|\$\(|\$\{/;
function looksShellRisky(text) {
  return SHELL_METACHAR_RE.test(text);
}
var CLI_OPTIONS = {
  as: { type: "string" },
  "body-file": { type: "string" },
  channels: { type: "string" },
  from: { type: "string" },
  hold: { type: "string" },
  "in-reply-to": { type: "string" },
  last: { type: "string" },
  max: { type: "string" },
  note: { type: "string" },
  since: { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  topic: { type: "string" },
  all: { type: "boolean" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  fresh: { type: "boolean" },
  "from-start": { type: "boolean" },
  human: { type: "boolean" },
  literal: { type: "boolean" },
  lurk: { type: "boolean" },
  quiet: { type: "boolean" },
  stdin: { type: "boolean" },
  text: { type: "boolean" },
  verbose: { type: "boolean" },
  yes: { type: "boolean" }
};

class UsageError extends Error {
}
var GLOBAL_FLAGS = ["as", "from"];
function numericFlag(verb, name, raw, fallback) {
  if (raw === undefined)
    return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    die(`${verb}: --${name} expects a non-negative number, got ${JSON.stringify(String(raw))}`);
  return n;
}
async function resolveBody(verb, inline, flags) {
  if (flags["body-file"]) {
    const path = flags["body-file"];
    const file = Bun.file(path);
    if (!await file.exists())
      die(`${verb}: --body-file not found: ${path}`);
    return { text: (await file.text()).replace(/\n$/, ""), fromInline: false };
  }
  if (flags.stdin || inline.length === 0 && !process.stdin.isTTY) {
    const buf = [];
    for await (const chunk of process.stdin)
      buf.push(chunk);
    return {
      text: Buffer.concat(buf).toString("utf-8").replace(/\n$/, ""),
      fromInline: false
    };
  }
  return { text: inline.join(" "), fromInline: true };
}
function guardBody(verb, text, fromInline, force) {
  if (!force && looksLikeLeakedSend(text)) {
    die(`${verb}: that body looks like a leaked grapevine invocation (a fumbled ` + "heredoc?). Nothing was sent. Pipe the real body via --stdin or " + "--body-file <path>, or pass --force to send it anyway.");
  }
  if (fromInline && looksShellRisky(text)) {
    process.stderr.write("# \u26A0 inline body contains shell metacharacters (backtick, $(), curly-brace vars). " + "It was sent as-is, but the shell can command-substitute these before " + `grapevine sees them \u2014 use --body-file or --stdin for code-bearing messages.
`);
  }
}
var identityRequired = (verb) => die(`${verb}: identity required \u2014 pass --as/--from <alias> or set GRAPEVINE_FROM env var`);
var COMMANDS = [
  {
    name: "open",
    flags: ["topic", "fresh"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdOpen(positional[0], {
        topic: flags.topic,
        from: resolveAlias(flags),
        fresh: flags.fresh === true
      });
    }
  },
  {
    name: "topic",
    flags: [],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdTopic(positional[0], positional.length > 1 ? positional.slice(1).join(" ") : undefined, resolveAlias(flags));
    }
  },
  {
    name: "list",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdList();
    }
  },
  {
    name: "send",
    flags: ["body-file", "stdin", "quiet", "verbose", "force", "in-reply-to"],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true }
    ],
    run: async (positional, flags) => {
      const name = positional[0];
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("send", positional.slice(1), flags);
      if (!from)
        identityRequired("send");
      guardBody("send", text, fromInline, !!flags.force);
      await cmdSend(name, from, text, {
        quiet: !!flags.quiet,
        verbose: !!flags.verbose,
        inReplyTo: flags["in-reply-to"] ? numericFlag("send", "in-reply-to", flags["in-reply-to"], 0) : undefined
      });
    }
  },
  {
    name: "announce",
    flags: ["body-file", "stdin", "quiet", "force", "channels"],
    positionals: [{ name: "text", required: false, variadic: true }],
    run: async (positional, flags) => {
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("announce", positional, flags);
      if (!from)
        identityRequired("announce");
      guardBody("announce", text, fromInline, !!flags.force);
      const channels = flags.channels ? flags.channels.split(",").map((c) => c.trim()).filter(Boolean) : undefined;
      await cmdAnnounce(from, text, channels, { quiet: !!flags.quiet });
    }
  },
  {
    name: "pull",
    flags: ["since", "status"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("pull", "since", flags.since, 0);
      await cmdPull(positional[0], since, { status: flags.status });
    }
  },
  {
    name: "triage",
    flags: ["human"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdTriage(positional[0], { human: !!flags.human });
    }
  },
  {
    name: "read",
    flags: ["text"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true }
    ],
    run: async (positional, flags) => {
      const id = positional[1] ? parseInt(positional[1], 10) : NaN;
      await cmdRead(positional[0], id, { text: !!flags.text });
    }
  },
  {
    name: "wait",
    flags: ["since", "timeout"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("wait", "since", flags.since, 0);
      const timeout = numericFlag("wait", "timeout", flags.timeout, 30);
      await cmdWait(positional[0], since, timeout, resolveAlias(flags));
    }
  },
  {
    name: "who",
    flags: ["all"],
    positionals: [{ name: "name", required: false }],
    run: async (positional, flags) => {
      if (flags.all)
        await cmdWhoAll();
      else
        await cmdWho(positional[0]);
    }
  },
  {
    name: "alias",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdAlias(positional[0]);
    }
  },
  {
    name: "tail",
    flags: ["since", "from-start", "last", "human", "lurk", "max"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdTail(positional[0], {
        since: flags.since !== undefined ? numericFlag("tail", "since", flags.since, 0) : undefined,
        fromStart: !!flags["from-start"],
        last: flags.last !== undefined ? numericFlag("tail", "last", flags.last, 0) : undefined,
        as: resolveAlias(flags),
        human: !!flags.human,
        lurk: !!flags.lurk,
        max: resolveTailMax(flags.max)
      });
    }
  },
  {
    name: "grep",
    flags: ["literal"],
    positionals: [
      { name: "name", required: true },
      { name: "pattern", required: true, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdGrep(positional[0], positional.slice(1).join(" "), {
        literal: !!flags.literal,
        from: flags.from
      });
    }
  },
  {
    name: "close",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional) => {
      await cmdClose(positional[0]);
    }
  },
  {
    name: "reset",
    flags: ["force"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdReset(positional[0], { force: flags.force === true });
    }
  },
  {
    name: "mark",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true },
      { name: "disposition", required: true, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdMark(positional[0], parseInt(positional[1], 10), positional.slice(2).join(" "), resolveAlias(flags) ?? identityRequired("mark"), { note: flags.note });
    }
  },
  {
    name: "reopen",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true }
    ],
    run: async (positional, flags) => {
      await cmdMark(positional[0], parseInt(positional[1], 10), "open", resolveAlias(flags) ?? identityRequired("reopen"), { note: flags.note });
    }
  },
  {
    name: "archive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdArchive(positional[0], false, resolveAlias(flags));
    }
  },
  {
    name: "unarchive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdArchive(positional[0], true, resolveAlias(flags));
    }
  },
  {
    name: "start",
    aliases: ["up"],
    flags: [],
    positionals: [],
    run: async () => {
      await cmdStart();
    }
  },
  {
    name: "restart",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRestart({ force: !!flags.force || !!flags.yes });
    }
  },
  {
    name: "roll",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRoll({ force: flags.force === true || flags.yes === true });
    }
  },
  {
    name: "stop",
    flags: ["hold"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdStop({
        holdSeconds: flags.hold !== undefined ? numericFlag("stop", "hold", flags.hold, 0) : undefined
      });
    }
  },
  {
    name: "watch",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdWatch(positional[0]);
    }
  },
  {
    name: "reap",
    aliases: ["prune"],
    flags: ["force", "dry-run"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdReap({ force: flags.force === true, dryRun: flags["dry-run"] === true });
    }
  },
  {
    name: "info",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdInfo();
    }
  },
  {
    name: "doctor",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdDoctor();
    }
  },
  {
    name: "version",
    flags: ["human"],
    positionals: [],
    run: (_positional, flags) => {
      if (PLUGIN_VERSION === null)
        die("version unavailable \u2014 could not read plugin.json", 1);
      if (flags.human === true)
        process.stdout.write(`grapevine v${PLUGIN_VERSION}
`);
      else
        printJson({ name: "grapevine", version: PLUGIN_VERSION });
    }
  },
  {
    name: "schema",
    flags: [],
    positionals: [],
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}
`);
    }
  },
  {
    name: "help",
    flags: [],
    positionals: [],
    run: () => {
      printHelp();
    }
  }
];
function findCommand(token) {
  return COMMANDS.find((c) => c.name === token || c.aliases?.includes(token));
}
function acceptedFlags(spec) {
  const own = new Set([...GLOBAL_FLAGS, ...spec.flags]);
  return Object.keys(CLI_OPTIONS).filter((k) => own.has(k));
}
var ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" }
];
function buildDeclaration() {
  const arg = (k) => ({
    name: `--${k}`,
    type: CLI_OPTIONS[k].type,
    status: "valid"
  });
  const commands = [
    {
      path: [],
      args: ROOT_INTERCEPTORS.map((i) => ({
        name: i.name,
        type: "boolean",
        status: "valid"
      })),
      positionals: [{ name: "command", required: true }]
    }
  ];
  for (const spec of COMMANDS) {
    for (const name of [spec.name, ...spec.aliases ?? []]) {
      commands.push({
        path: [name],
        args: acceptedFlags(spec).map((k) => arg(k)),
        positionals: spec.positionals
      });
    }
  }
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands
  };
}
function parseFlags(argv, spec) {
  const accepted = acceptedFlags(spec);
  const options = Object.fromEntries(accepted.map((k) => [k, CLI_OPTIONS[k]]));
  try {
    const { values, positionals } = nodeParseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: true
    });
    return {
      positional: positionals,
      flags: values
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const bodyHint = spec.name === "send" || spec.name === "announce" ? `
  for a message body containing dashes, use --stdin or --body-file, ` + `or put it after a bare --` : "";
    throw new UsageError(`${spec.name}: ${detail}
` + `  recognized flags: ${accepted.map((k) => `--${k}`).join(" ")}${bodyHint}`);
  }
}
function commandTokens() {
  return COMMANDS.flatMap((c) => [c.name, ...c.aliases ?? []]);
}
function printHelp() {
  process.stdout.write(`grapevine \u2014 agent-to-agent walkie-talkie

Usage:
  grapevine open <name> [--topic <text>] [--fresh]   open/create (auto-unarchives; --fresh clears a dormant channel)
  grapevine list
  grapevine send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--body-file <path>] [--force] [--in-reply-to <id>] [<text...>]
                                    # body: inline text, --stdin, --body-file, or piped stdin (default when no inline text)
  grapevine announce [--from/--as <alias>] [--channels a,b,c] [--stdin] [--body-file <path>] [--quiet] [<text...>]
                                    # broadcast one message to every active channel (or --channels)
  grapevine tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]
       # --last <n>: backfill the most recent n messages then go live (bounded catch-up for a cold joiner)
  grapevine pull <name> [--since <id>] [--status <value>]   # --status = full-scan filter (open|wontfix|incorporated|\u2026)
  grapevine triage <name>             # full-scan: open messages on top + grouped by_status
  grapevine mark <name> <id> <disposition> [--note <text>]  # set disposition (incorporated|wontfix|deferred|\u2026)
  grapevine reopen <name> <id>        # bounce a message back to open
  grapevine read <name> <id> [--text]   # one full message by id (--text = prose)
  grapevine wait <name> [--since <id>] [--timeout <s>]
  grapevine grep <name> <pattern> [--literal] [--from <alias>]
  grapevine topic <name> [<text>]   # no text \u2192 read current; with text \u2192 update
  grapevine who <name>              # roster; the humans field lists humans
  grapevine alias [<name>]          # set/show your persisted alias (config.json)
  grapevine watch [<name>]          # open browser tab; live chat-bubble view
  grapevine reset <name> [--force]           snapshot the log \u2192 ~/.grapevine/archive, then clear it
  grapevine archive <name>          # read-only: keep history, reject sends
  grapevine unarchive <name>        # bring an archived channel back
  grapevine close <name>            # destructive: delete the message log
  grapevine start                   # ensure the daemon is running (alias: up); no channel
  grapevine restart [--force|--yes] # stop + respawn fresh; --force to override the live-fleet guard
  grapevine roll [--force]          # safe restart (stop+hold+respawn) + version verify \u2014 the recommended deploy step
  grapevine stop [--hold <seconds>] # kill the daemon; --hold suppresses auto-respawn for <s> seconds (upgrade window)
  grapevine info
  grapevine doctor                  # health check \u2014 labels each daemon: authoritative / orphan / unresponsive / unknown
  grapevine reap [--force] [--dry-run]  # kill orphan daemons; --force also kills unresponsive; alias: prune

  grapevine schema                  # this CLI's machine-readable interface description (acc declaration v0)
  grapevine --version               # this CLI's version (alias: -V, version)
  grapevine help                    # this usage (alias: --help, -h)

Output:
  Data commands emit JSON on stdout by DEFAULT; pass --human for prose where a
  command offers it. Diagnostics and warnings go to stderr, never stdout.
  Usage errors exit 2. Each command accepts its OWN flags (plus --as/--from,
  which are global) \u2014 an unknown flag for a verb enumerates that verb's set.

Env:
  GRAPEVINE_FROM   Default identity alias (--from/--as are interchangeable).
  GRAPEVINE_HOME   Data dir (default ~/.grapevine).
`);
}
async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) {
    process.stderr.write(`grapevine: expected a command
` + `  commands: ${commandTokens().join(" ")}
` + `  run \`grapevine help\` (or --help) for usage
`);
    return 2;
  }
  if (cmd.startsWith("-")) {
    const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === cmd);
    if (!interceptor) {
      process.stderr.write(`grapevine: unknown flag at the root: ${cmd}
` + `  recognized flags: ${[...ROOT_INTERCEPTORS.map((i) => i.name)].sort((a, b) => Number(b.startsWith("--")) - Number(a.startsWith("--"))).join(" ")}
` + `  commands (each takes its own flags): ${commandTokens().join(" ")}
`);
      return 2;
    }
    return await runCommand(findCommand(interceptor.runs), rest);
  }
  const spec = findCommand(cmd);
  if (!spec) {
    process.stderr.write(`grapevine: unknown command: ${cmd}
  commands: ${commandTokens().join(" ")}
`);
    return 2;
  }
  return await runCommand(spec, rest);
}
async function runCommand(spec, rest) {
  let positional;
  let flags;
  try {
    ({ positional, flags } = parseFlags(rest, spec));
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    process.stderr.write(`grapevine: ${e.message}
`);
    return 2;
  }
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (positional.length < required) {
    const missing = spec.positionals[positional.length];
    process.stderr.write(`grapevine: ${spec.name}: missing required <${missing?.name ?? "argument"}>
` + `  expects: ${spec.name} ${spec.positionals.map((p) => p.required ? `<${p.name}>` : `[${p.name}]`).join(" ")}
`);
    return 2;
  }
  if (!variadic && positional.length > spec.positionals.length) {
    process.stderr.write(`grapevine: ${spec.name}: unexpected argument ${JSON.stringify(positional[spec.positionals.length])}
` + `  expects: ${spec.name} ${spec.positionals.map((p) => p.required ? `<${p.name}>` : `[${p.name}]`).join(" ") || "(no arguments)"}
`);
    return 2;
  }
  await spec.run(positional, flags);
  return 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  classifyDaemon,
  daemonCwd,
  looksShellRisky,
  probeVersion,
  releaseHold,
  run
};

//# debugId=4B0C102F09E3C39664756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gZ3JhcGV2aW5lIENMSSDigJQgdGhpbiB3cmFwcGVyIGFyb3VuZCB0aGUgZGFlbW9uJ3MgSFRUUCBzdXJmYWNlLlxuLy9cbi8vIFVzYWdlOlxuLy8gICBidW4gY2xpLnRzIG9wZW4gPG5hbWU+XG4vLyAgIGJ1biBjbGkudHMgbGlzdFxuLy8gICBidW4gY2xpLnRzIHNlbmQgPG5hbWU+IC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIHRhaWwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XVxuLy8gICBidW4gY2xpLnRzIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF1cbi8vICAgYnVuIGNsaS50cyBjbG9zZSA8bmFtZT5cbi8vICAgYnVuIGNsaS50cyBzdG9wXG4vLyAgIGJ1biBjbGkudHMgaW5mb1xuLy9cbi8vIGB0YWlsYCB3cml0ZXMgZWFjaCBpbmNvbWluZyBtZXNzYWdlIGFzIG9uZSBKU09OTCBsaW5lIG9uIHN0ZG91dC4gUGlwZVxuLy8gb3Igd3JhcCB3aXRoIE1vbml0b3IuXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICByZWFkZGlyU3luYyxcbiAgcmVhZEZpbGVTeW5jLFxuICB1bmxpbmtTeW5jLFxuICB3cml0ZUZpbGVTeW5jLFxufSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgaG9tZWRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIGFzIG5vZGVQYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5cbmNvbnN0IERBVEFfRElSID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmdyYXBldmluZVwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBvcnRcIik7XG5jb25zdCBQSURfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBpZFwiKTtcbmNvbnN0IEhPTERfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLmhvbGRcIik7XG4vLyBQZXJzaXN0ZWQgaWRlbnRpdHkgY29uZmlnIChWMS43KSDigJQgYGdyYXBldmluZSBhbGlhcyA8bmFtZT5gIHdyaXRlcyBpdDsgdGhlXG4vLyBkYWVtb24gc2VydmVzIGl0IHRvIHRoZSB3YXRjaCB2aWEgR0VUIC9pZGVudGl0eS5cbmNvbnN0IENPTkZJR19GSUxFID0gam9pbihEQVRBX0RJUiwgXCJjb25maWcuanNvblwiKTtcbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG4vLyDim5QgVVAgQU5EIEJBQ0sgRE9XTiwgTkVWRVIgQSBGTEFUIFNJQkxJTkcgKHBsYXlib29rIEI0KS4gVGhpcyByZWFkXG4vLyBgam9pbihTQ1JJUFRfRElSLCBcImRhZW1vbi50c1wiKWAg4oCUIGdsYW1vdXIncyBleGFjdCBzaGlwcGVkIGRlZmVjdCDigJQgd2hpY2ggd2FzXG4vLyB0cnVlIGZvciBleGFjdGx5IGFzIGxvbmcgYXMgdGhlIENMSSBhbmQgdGhlIGRhZW1vbiBzaGFyZWQgYSBmb2xkZXIuIEZyb21cbi8vIGBkaXN0L2AgdGhhdCByZXNvbHZlcyB0byBgZGlzdC9kYWVtb24udHNgLCBhIGZpbGUgdGhhdCBkb2VzIG5vdCBhbmQgbXVzdCBub3Rcbi8vIGV4aXN0LiBUaGUgc3ltcHRvbSBpcyBub3QgYSBjcmFzaDogdGhlIHNwYXduIGZhaWxzIHNpbGVudGx5ICh0aGUgZGFlbW9uJ3Ncbi8vIHN0ZGlvIGlzIGlnbm9yZWQpLCBubyBwb3J0IGZpbGUgZXZlciBhcHBlYXJzLCBhbmQgdGhlIDMgcyBwb2xsIGxvb3AgYmVsb3dcbi8vIHJlcG9ydHMgYGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzYCDigJQgd2hpY2ggaXMgQUxTTyB3aGF0IGEgbGF1bmNoZXJcbi8vIHRoYXQgZXhpdHMgYSBsaXZlIGRhZW1vbiByZXBvcnRzIChENjkpIGFuZCBBTFNPIHdoYXQgYSBkZXYtbW9kZSBkYWVtb24gZHlpbmdcbi8vIGF0IGl0cyBzdXJmYWNlIGltcG9ydCByZXBvcnRzIChzZWUgYGVuc3VyZURhZW1vbmApLiBUaHJlZSBkZWZlY3QgY2xhc3Nlcywgb25lXG4vLyBzZW50ZW5jZTsgdGhpcyBpcyB0aGUgZmlyc3Qgb2YgdGhlIHRocmVlLlxuLy8gYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByZXNvbHZlcyB0aGlzIGFyaXRobWV0aWMgdGhlIHdheSB0aGVcbi8vIHJ1bnRpbWUgd2lsbCwgZnJvbSB0aGUgRU1JVFRFRCBmaWxlJ3Mgb3duIGRpcmVjdG9yeSwgYW5kIGFzc2VydHMgdGhlIGZpbGUgaXNcbi8vIHRoZXJlLlxuY29uc3QgREFFTU9OX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJkYWVtb24udHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIFRoZSB3YXRjaCBzdXJmYWNlIGlzIGJ1aWx0IChzcmMvZ3JhcGV2aW5lL3N1cmZhY2Ug4oaSIGRpc3QvKS4gQnVuIHJlYWRzXG4vLyBidW5maWcudG9tbCAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gaW4gREVWIG1vZGUgdGhlIGRhZW1vbidzXG4vLyBjd2QgTVVTVCBiZSBzcmMvZ3JhcGV2aW5lLyAoc2VhbXMgQ29udHJhY3QgNSkg4oCUIGxhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IGFuZCB0aGUgcGFnZSBmYWlscyAobWVhc3VyZWQgb25cbi8vIGdsYW1vdXI6IEhUVFAgNTAwLCBubyBzdHlsZXNoZWV0IGxpbmspLiBJbiBSRUxFQVNFIG1vZGUgZGlzdC8gaXMgc3RhdGljIGFuZFxuLy8gcHJlLWJ1aWx0LCBubyBidW5maWcgaXMgcmVhZCwgYW5kIHNyYy9ncmFwZXZpbmUvIG5lZWQgbm90IGV4aXN0IGF0IGFsbCAoYVxuLy8gc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSDigJQgc28gdGhlIGN3ZCBzdGF5cyBhdFxuLy8gdGhlIHNraWxsIHJvb3QuIFNhbWUgc2hhcGUgYXMgZ2xhbW91cidzIGRhZW1vbkN3ZCgpLiBFeHBvcnRlZCBmb3IgdGVzdHMuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ3JhcGV2aW5lXCIpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gSFRUUCBwcm90b2NvbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFJlc3BvbnNlIHNoYXBlcyB0aGUgZGFlbW9uIGVtaXRzLiBBbnkgZW5kcG9pbnQgY2FuIGFsc28gcmV0dXJuIGFuIGVycm9yXG4vLyBib2R5IHdpdGggYSA0eHgvNXh4IHN0YXR1cywgc28gZWFjaCBjYXJyaWVzIGFuIG9wdGlvbmFsIGBlcnJvcmAuXG5cbnR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgY2hhbm5lbDogc3RyaW5nO1xuICBmcm9tOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAga2luZDogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgaW5fcmVwbHlfdG8/OiBudW1iZXI7XG4gIHRhcmdldD86IG51bWJlcjtcbiAgZGlzcG9zaXRpb24/OiBzdHJpbmc7XG4gIC8vIENoYW5uZWwtbGV2ZWwgbGlmZWN5Y2xlIGZhY3QgKGFyY2hpdmUgLyB1bmFyY2hpdmUpLiBBIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZVxuICAvLyBjYXJyeWluZyBgZXZlbnRgIGFuZCBubyBgZGlzcG9zaXRpb25gIOKAlCBzZWUgaXNEaXNwb3NpdGlvbkZyYW1lLlxuICBldmVudD86IFwiYXJjaGl2ZWRcIiB8IFwidW5hcmNoaXZlZFwiO1xufTtcblxuLy8gR0VUIC8g4oCUIGRhZW1vbiBsaXZlbmVzcy9pbmZvLlxudHlwZSBSb290SW5mbyA9IHtcbiAgb2s/OiBib29sZWFuO1xuICBwaWQ/OiBudW1iZXI7XG4gIHN0YXJ0ZWRfYXQ/OiBudW1iZXI7XG4gIGNoYW5uZWxzPzogbnVtYmVyO1xuICBkYXRhX2Rpcj86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIOKAlCBtZXNzYWdlIHJlY2VpcHQgd2l0aCBkZWxpdmVyeSBhY2NvdW50aW5nLlxudHlwZSBTZW5kUmVjZWlwdCA9IE1lc3NhZ2UgJiB7XG4gIHN1YnNjcmliZXJzPzogbnVtYmVyO1xuICByZWNpcGllbnRzPzogbnVtYmVyO1xuICBzdWJzY3JpYmVyX2FsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9hbm5vdW5jZSDigJQgY3Jvc3MtY2hhbm5lbCBicm9hZGNhc3QgcmVjZWlwdC5cbnR5cGUgQW5ub3VuY2VSZWNlaXB0ID0ge1xuICBvazogYm9vbGVhbjtcbiAgY2hhbm5lbHM6IHsgbmFtZTogc3RyaW5nOyByZWNpcGllbnRzOiBudW1iZXIgfVtdO1xuICBza2lwcGVkOiB7IG5hbWU6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVtdO1xuICB0b3RhbF9yZWNpcGllbnRzOiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscyDigJQgY2hhbm5lbCBkaXJlY3RvcnkgbGlzdGluZy5cbnR5cGUgQ2hhbm5lbFN1bW1hcnkgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IG51bWJlcjtcbiAgLy8gbnVsbCA9IHRoZSBkYWVtb24gY291bGQgbm90IGVzdGFibGlzaCBhIGNvdW50ICh1bnJlYWRhYmxlIGZpbGUpLCBORVZFUiAwLlxuICAvLyAwIG1lYW5zIFwidGhpcyBjaGFubmVsIGlzIGdlbnVpbmVseSBlbXB0eVwiIGFuZCBub3RoaW5nIGVsc2Ug4oCUIGI1LlxuICBtZXNzYWdlX2NvdW50OiBudW1iZXIgfCBudWxsO1xuICBsYXN0X2FjdGl2aXR5OiBudW1iZXI7XG4gIGxvYWRlZDogYm9vbGVhbjtcbn07XG50eXBlIENoYW5uZWxzUmVzcG9uc2UgPSB7IGNoYW5uZWxzPzogQ2hhbm5lbFN1bW1hcnlbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gQW55IGVuZHBvaW50IG1heSByZXBseSB3aXRoIGp1c3QgYW4gZXJyb3Ivb2sgZW52ZWxvcGUuXG50eXBlIFN0YXR1c1Jlc3BvbnNlID0geyBvaz86IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIGFuZCA/c2luY2U9IHJhbmdlcy5cbnR5cGUgTWVzc2FnZXNSZXNwb25zZSA9IHsgbWVzc2FnZXM/OiBNZXNzYWdlW107IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3dhaXQg4oCUIGxvbmctcG9sbCBiYXRjaC5cbnR5cGUgV2FpdFJlc3BvbnNlID0ge1xuICBtZXNzYWdlcz86IE1lc3NhZ2VbXTtcbiAgY3Vyc29yPzogbnVtYmVyO1xuICB0aW1lZF9vdXQ/OiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbiAgLy8gQSByZWZ1c2FsIG5hbWVzIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0ICg0MDQgb24gYSBtaXNzaW5nIGNoYW5uZWwpLlxuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMg4oCUIG9wZW4vZW5zdXJlIGEgY2hhbm5lbC5cbnR5cGUgT3BlblJlc3BvbnNlID0ge1xuICBuYW1lPzogc3RyaW5nO1xuICBjcmVhdGVkX2F0PzogbnVtYmVyO1xuICBtZXNzYWdlX2NvdW50PzogbnVtYmVyO1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICB1bmFyY2hpdmVkPzogYm9vbGVhbjtcbiAgY2xlYXJlZD86IGJvb2xlYW47XG4gIHNuYXBzaG90Pzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi90b3BpYyBhbmQgUFVUIC9jaGFubmVscy88bmFtZT4vdG9waWMuXG50eXBlIFRvcGljUmVzcG9uc2UgPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBpZD86IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIGhpbnQ/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9zdWJzY3JpYmVycyDigJQgc2luZ2xlLWNoYW5uZWwgcm9zdGVyLlxudHlwZSBTdWJzY3JpYmVyc1Jlc3BvbnNlID0ge1xuICBjaGFubmVsPzogc3RyaW5nO1xuICBzdWJzY3JpYmVycz86IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY291bnQ/OiBudW1iZXI7XG4gIGNvbm5lY3Rpb25zPzogbnVtYmVyO1xuICBuYW1lZD86IG51bWJlcjtcbiAgYW5vbnltb3VzPzogbnVtYmVyO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUGVyLWNoYW5uZWwgcHJlc2VuY2UgZW50cnkgZnJvbSBHRVQgL3ByZXNlbmNlLlxudHlwZSBQcmVzZW5jZUNoYW5uZWwgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgbmFtZWQ6IG51bWJlcjtcbiAgYW5vbnltb3VzOiBudW1iZXI7XG59O1xudHlwZSBQcmVzZW5jZVJlc3BvbnNlID0geyBjaGFubmVscz86IFByZXNlbmNlQ2hhbm5lbFtdOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBTU0UgZnJhbWVzIHB1c2hlZCBvbiBHRVQgL2NoYW5uZWxzLzxuYW1lPi90YWlsLiBUd28gZnJhbWUga2luZHMgYXJyaXZlIG9uXG4vLyB0aGUgc2FtZSBgZGF0YTpgIGxpbmUg4oCUIGEgYHN1YnNjcmliZWRgIGV2ZW50IGFuZCBwZXItbWVzc2FnZSBmcmFtZXMg4oCUIHNvIHRoZVxuLy8gZGVjb2RlZCBwYXlsb2FkIGlzIGEgdW5pb24uIEFsbCBmaWVsZHMgb3B0aW9uYWwgYmVjYXVzZSB0aGUgZnJhbWUgaXNcbi8vIHVudHJ1c3RlZCB3aXJlIGRhdGEgbmFycm93ZWQgYXQgdGhlIHVzZSBzaXRlLlxudHlwZSBUYWlsUGF5bG9hZCA9IHtcbiAgLy8gc3Vic2NyaWJlZC1ldmVudCBmaWVsZHNcbiAgc2luY2U/OiBudW1iZXI7XG4gIGFzPzogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0X2lkPzogbnVtYmVyO1xuICAvLyBUcnVlIHdoZW4gVEhJUyBzdWJzY3JpYmUgY3JlYXRlZCB0aGUgY2hhbm5lbCDigJQgdGhlIHNpZ25hbCB0aGF0IHNlcGFyYXRlc1xuICAvLyBcInF1aWV0IGNoYW5uZWxcIiBmcm9tIFwieW91IHRhaWxlZCBhIG5hbWUgdGhhdCBkaWQgbm90IGV4aXN0XCIuXG4gIGNyZWF0ZWQ/OiBib29sZWFuO1xuICAvLyBUcnVlIHdoZW4gdGhlIGNoYW5uZWwgaXMgYWxyZWFkeSBhcmNoaXZlZCAocmVhZC1vbmx5KSBhdCBzdWJzY3JpYmUgdGltZSDigJRcbiAgLy8gdGhlIHNpZ25hbCBmb3IgYSBMQVRFIGpvaW5lciwgd2hvIHdvdWxkIG90aGVyd2lzZSBsZWFybiBpdCBmcm9tIGEgcmVqZWN0ZWRcbiAgLy8gc2VuZC4gVGhlIGxpZmVjeWNsZSBmcmFtZSBvbmx5IHJlYWNoZXMgYW4gYWdlbnQgdGhhdCB3YXMgY29ubmVjdGVkIGF0IHRoZVxuICAvLyBtb21lbnQsIG9yIHRoYXQgcHVsbHMgaGlzdG9yeS5cbiAgYXJjaGl2ZWQ/OiBib29sZWFuO1xuICAvLyBtZXNzYWdlIGZpZWxkc1xuICBpZD86IG51bWJlcjtcbiAgZnJvbT86IHN0cmluZztcbiAgdGV4dD86IHN0cmluZztcbiAgdHM/OiBudW1iZXI7XG4gIGtpbmQ/OiBcIm1lc3NhZ2VcIiB8IFwidG9waWNcIiB8IFwiYW5ub3VuY2VtZW50XCIgfCBcInN0YXR1c1wiO1xuICAvLyBzaGFyZWRcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuLy8gT3VyIHBsdWdpbiB2ZXJzaW9uIChmcm9tIHBsdWdpbi5qc29uKS4gVXNlZCB0byBkZXRlY3QgY2FjaGUtcGlubmluZ1xuLy8gbWlzbWF0Y2hlcyB3aGVuIHdlIHRhbGsgdG8gYSBkYWVtb24gc3Bhd25lZCBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZFxuLy8gcGF0aC4gQmVzdC1lZmZvcnQ7IG51bGwgaWYgcmVhZCBmYWlscy5cbmZ1bmN0aW9uIHJlYWRQbHVnaW5WZXJzaW9uKCk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBsdWdpbkpzb25QYXRoID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIik7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBsdWdpbkpzb25QYXRoLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykudmVyc2lvbiA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuY29uc3QgUExVR0lOX1ZFUlNJT04gPSByZWFkUGx1Z2luVmVyc2lvbigpO1xuXG4vLyBPbmUtc2hvdCB2ZXJzaW9uLW1pc21hdGNoIGNoZWNrLiBUaGUgZGFlbW9uIG1heSBiZSBmcm9tIGEgZGlmZmVyZW50XG4vLyBjYWNoZWQgcGx1Z2luIHBhdGggdGhhbiB0aGlzIENMSSAoZXhpc3RpbmcgdGFpbCBwcm9jZXNzZXMnIGF1dG8tcmVjb25uZWN0XG4vLyBjYW4gcmFjZSBhIGBzdG9wYCBhbmQgcmVzcGF3biB0aGUgb2xkIGRhZW1vbikuIFdhcm4gb25jZSBwZXIgaW52b2NhdGlvblxuLy8gc28gdGhlIHVzZXIgaGFzIGEgc2lnbmFsIGluc3RlYWQgb2Ygc2lsZW50bHkgZGVncmFkZWQgYmVoYXZpb3IuXG5sZXQgX3ZlcnNpb25DaGVja0RvbmUgPSBmYWxzZTtcbmFzeW5jIGZ1bmN0aW9uIG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKHBvcnQ6IG51bWJlcikge1xuICBpZiAoX3ZlcnNpb25DaGVja0RvbmUpIHJldHVybjtcbiAgX3ZlcnNpb25DaGVja0RvbmUgPSB0cnVlO1xuICBpZiAoIVBMVUdJTl9WRVJTSU9OKSByZXR1cm47IC8vIGNhbid0IGNvbXBhcmUgaWYgd2UgZG9uJ3Qga25vdyBvdXIgb3duIHZlcnNpb25cbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmICghcmVzLm9rKSByZXR1cm47XG4gICAgY29uc3QgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgICBjb25zdCBkYWVtb25WZXJzaW9uID0gZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmIChkYWVtb25WZXJzaW9uID09PSBudWxsKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgZ3JhcGV2aW5lOiBkYWVtb24gaXMgb2xkZXIgdGhhbiB0aGlzIENMSSAobm8gdmVyc2lvbiByZXBvcnRlZCkuIGAgK1xuICAgICAgICAgIGBDTEkgaXMgdiR7UExVR0lOX1ZFUlNJT059LiBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBgICtcbiAgICAgICAgICBgUmVzdGFydCB0aGUgZGFlbW9uIChkcm9wIHRhaWxzLCB0aGVuIFxcYHN0b3BcXGAsIHRoZW4gYW55IHZlcmIpIHRvIHVwZ3JhZGUuXFxuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChkYWVtb25WZXJzaW9uICE9PSBQTFVHSU5fVkVSU0lPTikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIHZlcnNpb24gKHYke2RhZW1vblZlcnNpb259KSBkaWZmZXJzIGZyb20gQ0xJIHZlcnNpb24gKHYke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICAgIGBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBSZXN0YXJ0IHRoZSBkYWVtb24gdG8gYWxpZ24uXFxuYCxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydFxuICB9XG59XG4vLyBHUkFQRVZJTkVfRlJPTSBzZXRzIHRoZSBkZWZhdWx0IC0tZnJvbSAvIC0tYXMgYWxpYXMgc28gYWdlbnRzIGRvbid0IGhhdmVcbi8vIHRvIHJlcGVhdCB0aGVpciBpZGVudGl0eSBvbiBldmVyeSB2ZXJiLiBQZXItdmVyYiBmbGFncyBzdGlsbCBvdmVycmlkZS5cbmNvbnN0IERFRkFVTFRfQUxJQVMgPSBwcm9jZXNzLmVudi5HUkFQRVZJTkVfRlJPTSA/PyB1bmRlZmluZWQ7XG5cbi8vIElkZW50aXR5IGZsYWdzIGFyZSBpbnRlcmNoYW5nZWFibGUgYWNyb3NzIHZlcmJzLiBgc2VuZGAgaGlzdG9yaWNhbGx5IHRvb2tcbi8vIGAtLWZyb21gIHdoaWxlIGB0YWlsYC9gd2FpdGAgdG9vayBgLS1hc2Ag4oCUIHNhbWUgY29uY2VwdCAod2hvIGFtIEkpLCBhbmQgdGhlXG4vLyBhc3ltbWV0cnkgdHJpcHMgeW91IG1pZC1mbG93LiBBY2NlcHQgZWl0aGVyIGV2ZXJ5d2hlcmUgaWRlbnRpdHkgaXMgbWVhbnQsXG4vLyBmYWxsaW5nIGJhY2sgdG8gR1JBUEVWSU5FX0ZST00uIChncmVwJ3MgYC0tZnJvbWAgaXMgYSBkaWZmZXJlbnQgdGhpbmcg4oCUIGFuXG4vLyBhdXRob3IgKmZpbHRlciosIG5vdCBpZGVudGl0eSDigJQgc28gaXQgZG9lc24ndCB1c2UgdGhpcy4pXG5mdW5jdGlvbiByZXNvbHZlQWxpYXMoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIChmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gKGZsYWdzLmFzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gREVGQVVMVF9BTElBUztcbn1cbi8vIFRydW5jYXRpb24taGludCB0aHJlc2hvbGQuIE1lc3NhZ2VzIGxvbmdlciB0aGFuIHRoaXMgZ2V0IGEgYHRydW5jYXRpb25faGludGBcbi8vIGZpZWxkIG9uIHRoZSB0YWlsIEpTT04gc28gY29uc3VtZXJzIChlLmcuIE1vbml0b3IpIGtub3cgdGhlIG5vdGlmaWNhdGlvblxuLy8gcHJldmlldyBpcyBpbmNvbXBsZXRlIGFuZCBzaG91bGQgYHJlYWRgIHRoZSBmdWxsIGJvZHkuIEluIGFnZW50LXRvLWFnZW50XG4vLyB0cmFmZmljLCBsb25nIG1lc3NhZ2VzIGFyZSB0aGUgTk9STSAodGhlIFYxLjYgcm91bmR0YWJsZSBzYXcgbW9zdCBzdWJzdGFudGl2ZVxuLy8gbWVzc2FnZXMgZXhjZWVkIDgwMCksIHNvIGFuIDgwMCBkZWZhdWx0IGZpcmVkIG9uIG5lYXJseSBldmVyeXRoaW5nIGFuZCB0aGVcbi8vIHJlY292ZXJ5IHBhdGggYmVjYW1lIHRoZSBtYWluIHBhdGguIERlZmF1bHQgcmFpc2VkIHRvIDIwMDAgc28gdGhlIGhpbnQgbWFya3Ncbi8vIHRoZSBnZW51aW5lbHktbG9uZyBvdXRsaWVycy4gT3ZlcnJpZGFibGUgdmlhIGVudiB2YXIgZm9yIHR1bmluZy5cbmNvbnN0IFRSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPSBwYXJzZUludChcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPz8gXCIyMDAwXCIsXG4gIDEwLFxuKTtcblxuLy8gT3B0aW9uYWwgaW5saW5lLWJvZHkgY2FwIGZvciBgdGFpbGAgKG9wdC1pbiB2aWEgLS1tYXggPG4+IG9yIEdSQVBFVklORV9UQUlMX01BWCkuXG4vLyBXaGVuIHNldCwgYSBib2R5IGxvbmdlciB0aGFuIHRoZSBjYXAgaXMgdHJ1bmNhdGVkIHRvIGBuYCBjaGFycyBpbiB0aGUgdGFpbFxuLy8gZnJhbWUgKHBsdXMgdGhlIHJlYWQtcG9pbnRlciBoaW50KSwgc28gYSBwdXNoIGNvbnN1bWVyIGNhbiBoYW5kIGl0c1xuLy8gbm90aWZpY2F0aW9uIHN1cmZhY2UgYSBkZWxpYmVyYXRlbHktc2l6ZWQgbGluZS4gVGhlIEZVTEwgbWVzc2FnZSBpcyBhbHdheXNcbi8vIHJldHJpZXZhYmxlIHZpYSBgcmVhZCA8Y2hhbm5lbD4gPGlkPmAuIFVuZGVmaW5lZCA9IG5vIGNhcCAoZnVsbCB0ZXh0IGlubGluZSDigJRcbi8vIHRvZGF5J3MgZGVmYXVsdCkuIE5vdGU6IHRoZSBoYXJkIGNsaXAgYSBjb25zdW1lciB1bHRpbWF0ZWx5IHNlZXMgaXMgc3RpbGwgdGhlXG4vLyBNb25pdG9yL25vdGlmaWNhdGlvbiBsYXllcidzOyAtLW1heCBvbmx5IGJvdW5kcyB0aGUgbGluZSBncmFwZXZpbmUgZW1pdHMuXG4vLyBSZWplY3RzIG5lZ2F0aXZlIC8gbm9uLW51bWVyaWMuXG5mdW5jdGlvbiByZXNvbHZlVGFpbE1heChmbGFnOiB1bmtub3duKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWcgPT09IFwic3RyaW5nXCIgPyBmbGFnIDogcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RBSUxfTUFYO1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3LCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+PSAwID8gbiA6IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gZGllKG1zZzogc3RyaW5nLCBjb2RlID0gMik6IG5ldmVyIHtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGdyYXBldmluZTogJHttc2d9XFxuYCk7XG4gIHByb2Nlc3MuZXhpdChjb2RlKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZERhZW1vblBvcnQoKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKFBPUlRfRklMRSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gIGNvbnN0IHBvcnQgPSBwYXJzZUludChyYXcsIDEwKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIC8vIEZpcmUtYW5kLWZvcmdldCBtaXNtYXRjaCBjaGVjayAod29uJ3QgYmxvY2sgdGhlIHZlcmIpLlxuICAgICAgbWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gocG9ydCk7XG4gICAgICByZXR1cm4gcG9ydDtcbiAgICB9XG4gIH0gY2F0Y2gge31cbiAgLy8gU3RhbGUg4oCUIGNsZWFuIHVwLlxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUE9SVF9GSUxFKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIHVubGlua1N5bmMoUElEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBob2xkQWN0aXZlKCk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB1bnRpbCA9IHBhcnNlSW50KHJlYWRGaWxlU3luYyhIT0xEX0ZJTEUsIFwidXRmLThcIikudHJpbSgpLCAxMCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh1bnRpbCkgJiYgdW50aWwgPiBEYXRlLm5vdygpKSByZXR1cm4gdW50aWw7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9IGNhdGNoIHt9IC8vIGV4cGlyZWQg4oaSIGNsZWFuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgZnVuY3Rpb24gcmVsZWFzZUhvbGQoKSB7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgaWYgKGhvbGRBY3RpdmUoKSlcbiAgICBkaWUoXCJkYWVtb24gaXMgaGVsZCAocmVzcGF3biBzdXBwcmVzc2VkKSDigJQgd2FpdCBmb3IgdGhlIGhvbGQgdG8gY2xlYXIgb3IgcnVuIGBncmFwZXZpbmUgcm9sbGBcIik7XG4gIC8vIENoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzogdGhlIGRhZW1vbidzIHN0ZGlvIGlzIGlnbm9yZWQsIHNvIGFcbiAgLy8gZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydCB3b3VsZCBvdGhlcndpc2Ugc3VyZmFjZSBvbmx5IGFzXG4gIC8vIFwiZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiIOKAlCBhbmQgbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgRU5PRU5UIG9uXG4gIC8vIHRoZSBleGVjdXRhYmxlLCB3aGljaCByZWFkcyBhcyBcImJ1biBpcyBtaXNzaW5nXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBncmFwZXZpbmUgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH0uIGAgK1xuICAgICAgICBcIk5vIGRpc3QvaW5kZXguaHRtbCB3YXMgZm91bmQgKG9yIFNQRUxMQk9PS19TVVJGQUNFX01PREU9ZGV2IGlzIHNldCksIHNvIHRoZSBkYWVtb24gXCIgK1xuICAgICAgICBcIm11c3QgcnVuIGZyb20gc3JjL2dyYXBldmluZS8gdG8gYnVuZGxlIHRoZSB3YXRjaCBzdXJmYWNlLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgXCIgK1xuICAgICAgICBcImRvZXMgbm90IGhhdmUuIEVpdGhlciB0aGUgc2hpcHBlZCBkaXN0LyBpcyBtaXNzaW5nIChyZWluc3RhbGwgdGhlIHNwZWxsKSBvciB5b3UgYXJlIGluIFwiICtcbiAgICAgICAgXCJhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dyYXBldmluZS8uXCIsXG4gICAgKTtcbiAgfVxuICAvLyBTcGF3biBkZXRhY2hlZCBzbyB0aGUgZGFlbW9uIHN1cnZpdmVzIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdC5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtEQUVNT05fU0NSSVBUXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2QsXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFdhaXQgdXAgdG8gM3MgZm9yIHRoZSBwb3J0IGZpbGUgdG8gYXBwZWFyIGFuZCByZXNwb25kLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIH1cbiAgZGllKFwiZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIik7XG59XG5cbi8vIEdlbmVyaWMgb3ZlciB0aGUgZXhwZWN0ZWQgc3VjY2VzcyBib2R5LiBgZGF0YWAgbWF5IGJlIG51bGwgaWYgdGhlIHJlc3BvbnNlXG4vLyBoYWQgbm8gSlNPTiBib2R5LCBzbyBjYWxsZXJzIHNlZSBgVCB8IG51bGxgLlxuYXN5bmMgZnVuY3Rpb24gYXBpPFQgPSB1bmtub3duPihcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogVCB8IG51bGwgfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IFQgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFQ7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG4vLyBIb3cgVEhJUyBDTEkgd2FzIGludm9rZWQsIGFzIGEgcnVubmFibGUgcHJlZml4LiBgcHJvY2Vzcy5hcmd2WzFdYCBpcyB0aGVcbi8vIGFic29sdXRlIHBhdGggb2YgY2xpLnRzIHVuZGVyIGBidW4g4oCmL2NsaS50cyA8dmVyYj5gLCB3aGljaCBpcyBTS0lMTC5tZCdzXG4vLyBjYW5vbmljYWwgaW52b2NhdGlvbiDigJQgc28gdGhlIGxpbmUgd2UgcHJpbnQgY2FuIGFjdHVhbGx5IGJlIHBhc3RlZC4gRmFsbHNcbi8vIGJhY2sgdG8gdGhlIGJhcmUgdmVyYiBpZiBhcmd2IGlzIG5vdCBzaGFwZWQgYXMgZXhwZWN0ZWQsIHdoaWNoIGlzIGEgdmVyYlxuLy8gcmVmZXJlbmNlIHJhdGhlciB0aGFuIGEgY29tbWFuZCB0aGF0IGxpZXMgYWJvdXQgYmVpbmcgb25lLlxuZnVuY3Rpb24gaW52b2NhdGlvblByZWZpeCgpOiBzdHJpbmcge1xuICBjb25zdCBlbnRyeSA9IHByb2Nlc3MuYXJndlsxXTtcbiAgcmV0dXJuIGVudHJ5ID8gYGJ1biAke2VudHJ5fWAgOiBcIlwiO1xufVxuXG4vLyBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgYGhpbnRgIOKAlCB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoYSA0MDQgb24gYVxuLy8gcmVhZCBuYW1lcyB0aGUgYG9wZW5gIHRoYXQgd291bGQgY3JlYXRlIHRoZSBjaGFubmVsKS5cbi8vXG4vLyDimqAgYGhpbnRgIGlzIGEgVkVSQiBJTlZPQ0FUSU9OLCBub3QgYSBzaGVsbCBjb21tYW5kOiB0aGUgZGFlbW9uIGNhbm5vdCBrbm93XG4vLyBob3cgaXRzIGNsaWVudCB3YXMgaW52b2tlZCwgc28gaXQgbmFtZXMgdGhlIGFjdCBhbmQgd2UgcmVuZGVyIGl0LiBJdCB1c2VkIHRvXG4vLyBhcnJpdmUgYXMgYGdyYXBldmluZSBvcGVuIDxuYW1lPmAgYW5kIGJlIHByaW50ZWQgdmVyYmF0aW0gYWZ0ZXIgYHRyeTpgLCB3aGljaFxuLy8gcmVhZHMgYXMgc29tZXRoaW5nIHRvIHBhc3RlIOKAlCBhbmQgcGFzdGluZyBpdCBnZXRzIGBjb21tYW5kIG5vdCBmb3VuZGAsXG4vLyBiZWNhdXNlIG5vdGhpbmcgaW5zdGFsbHMgYSBgZ3JhcGV2aW5lYCBiaW5hcnkuIFJ1bGluZyAyIGFza2VkIHRoYXQgYSByZWZ1c2FsXG4vLyBuYW1lIHRoZSBuZXh0IGFjdDsgYSByZWNvdmVyeSB0aGF0IGZhaWxzIHdoZW4geW91IHJ1biBpdCBkb2VzIG5vdC5cbmZ1bmN0aW9uIGFwaUVycm9yKGRhdGE6IHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1czogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgbXNnID0gZGF0YT8uZXJyb3IgPz8gYEhUVFAgJHtzdGF0dXN9YDtcbiAgaWYgKCFkYXRhPy5oaW50KSByZXR1cm4gbXNnO1xuICBjb25zdCBwcmVmaXggPSBpbnZvY2F0aW9uUHJlZml4KCk7XG4gIHJldHVybiBwcmVmaXggPyBgJHttc2d9IOKAlCB0cnk6ICR7cHJlZml4fSAke2RhdGEuaGludH1gIDogYCR7bXNnfSDigJQgdHJ5IHRoZSBcXGAke2RhdGEuaGludH1cXGAgdmVyYmA7XG59XG5cbi8vIEV4aXN0ZW5jZSBwcm9iZSBmb3IgdGhlIHJlYWQgdmVyYnMgdGhhdCBhbnN3ZXIgZnJvbSB0aGUgTE9HIEZJTEUgcmF0aGVyIHRoYW5cbi8vIGZyb20gYSByb3V0ZSAoYHRyaWFnZWAsIGBwdWxsIC0tc3RhdHVzYCkuIFRob3NlIGNhbm5vdCA0MDQgb24gdGhlaXIgb3duOiBhXG4vLyBtaXNzaW5nIGxvZyBpcyBhbiBlbXB0eSBhcnJheSwgd2hpY2ggaXMgdGhlIHNhbWUgc2lsZW50IGxpZSB0aGUgZGFlbW9uIGd1YXJkXG4vLyBleGlzdHMgdG8ga2lsbC4gR0VUIC90b3BpYyBpcyB0aGUgY2hlYXBlc3QgZ3VhcmRlZCByb3V0ZSwgc28gaXQgaXMgdGhlIHByb2JlLlxuYXN5bmMgZnVuY3Rpb24gcmVxdWlyZUNoYW5uZWwocG9ydDogbnVtYmVyLCBuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllKGFwaUVycm9yKGRhdGEsIHN0YXR1cykpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKG5hbWU6IHN0cmluZywgb3B0czogeyB0b3BpYz86IHN0cmluZzsgZnJvbT86IHN0cmluZzsgZnJlc2g/OiBib29sZWFuIH0pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIG9wZW4gPG5hbWU+IFstLXRvcGljIDx0ZXh0Pl0gWy0tZnJlc2hdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+ID0geyBuYW1lLCBleHBsaWNpdDogdHJ1ZSB9O1xuICBpZiAob3B0cy50b3BpYyAhPT0gdW5kZWZpbmVkKSBib2R5LnRvcGljID0gb3B0cy50b3BpYztcbiAgaWYgKG9wdHMuZnJvbSAhPT0gdW5kZWZpbmVkKSBib2R5LmZyb20gPSBvcHRzLmZyb207XG4gIGlmIChvcHRzLmZyZXNoKSBib2R5LmZyZXNoID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxPcGVuUmVzcG9uc2U+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZShkYXRhPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IGRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRvcGljKG5hbWU6IHN0cmluZywgdGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkLCBmcm9tOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRvcGljIDxjaGFubmVsPiBbPHRleHQ+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBpZiAodGV4dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gYHRvcGljIDxuYW1lPmAgd2l0aCBubyB0ZXh0IGlzIGEgUkVBRCDigJQgaXQgYXNrcyB3aGF0IHRoZSB0b3BpYyBpcywgYW5kIGFcbiAgICAvLyBtaXNzaW5nIGNoYW5uZWwgYW5zd2VycyB0aGF0IHF1ZXN0aW9uIGJ5IGJlaW5nIG1pc3NpbmcuIE5vIGVuc3VyZTogdGhlXG4gICAgLy8gZW5zdXJlIHdhcyB3aGF0IHJlc3VycmVjdGVkIGEgY2xvc2VkIGNoYW5uZWwgZnJvbSBhIHJlYWQgdmVyYi5cbiAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2ApO1xuICAgIGlmIChzdGF0dXMgPj0gNDAwKSBkaWUoYXBpRXJyb3IoZGF0YSwgc3RhdHVzKSk7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGNoYW5uZWw6IG5hbWUsIHRvcGljOiBkYXRhPy50b3BpYyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gYHRvcGljIDxuYW1lPiA8dGV4dD5gIGlzIGEgV1JJVEUsIHNvIGl0IG1heSBjcmVhdGUg4oCUIGJ1dCBpdCBtdXN0IG5vdCB3cml0ZVxuICAvLyB0byBhbiBBUkNISVZFRCBjaGFubmVsLiBUaGUgUFVUIGVuZm9yY2VzIHRoYXQgaXRzZWxmIG5vdzsgdGhpcyBlbnN1cmUgc3RheXNcbiAgLy8gYmVjYXVzZSBESVNDQVJESU5HIElUUyBTVEFUVVMgaXMgcHJlY2lzZWx5IHRoZSBidWcgYmVpbmcgZml4ZWQgaGVyZS4gQmVmb3JlXG4gIC8vIHRvZGF5IHRoZSA0MDkgdGhhdCBhbnN3ZXJzIGZvciBhbiBhcmNoaXZlZCBuYW1lIHdhcyB0aHJvd24gYXdheSBhbmQgdGhlIFBVVFxuICAvLyB0aGF0IGZvbGxvd2VkIGxhbmRlZDogYGFyY2hpdmUgeDsgdG9waWMgeCBcInRcImAgcmV0dXJuZWQgb2s6dHJ1ZSwgZXhpdCAwLlxuICBjb25zdCBlbnN1cmUgPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgaGludD86IHN0cmluZyB9Pihwb3J0LCBcIlBPU1RcIiwgXCIvY2hhbm5lbHNcIiwgeyBuYW1lIH0pO1xuICBpZiAoZW5zdXJlLnN0YXR1cyA+PSA0MDApIGRpZShhcGlFcnJvcihlbnN1cmUuZGF0YSwgZW5zdXJlLnN0YXR1cykpO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiUFVUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2AsIHtcbiAgICB0b3BpYzogdGV4dCxcbiAgICBmcm9tOiBmcm9tID8/IFwic3lzdGVtXCIsXG4gIH0pO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllKGFwaUVycm9yKGRhdGEsIHN0YXR1cykpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljLCBpZDogZGF0YT8uaWQgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxDaGFubmVsc1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9jaGFubmVsc1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChcbiAgbmFtZTogc3RyaW5nLFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW47IHZlcmJvc2U/OiBib29sZWFuOyBpblJlcGx5VG8/OiBudW1iZXIgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGluX3JlcGx5X3RvPzogbnVtYmVyIH0gPSB7XG4gICAgZnJvbSxcbiAgICB0ZXh0LFxuICB9O1xuICBpZiAob3B0cy5pblJlcGx5VG8gIT09IHVuZGVmaW5lZCkgYm9keS5pbl9yZXBseV90byA9IG9wdHMuaW5SZXBseVRvO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFNlbmRSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWUoYXBpRXJyb3IoZGF0YSwgc3RhdHVzKSk7XG4gIC8vIFRhcmdldCBlY2hvIG9uIHN0ZGVyciDigJQgY29uZmlybXMgV0hFUkUgdGhlIG1lc3NhZ2UgbGFuZGVkIHNvIGEgbWlzcm91dGVkXG4gIC8vIHJlcGx5IChyaWdodCBwcm9tcHQsIHdyb25nIGNoYW5uZWwpIGlzIGNhdWdodCB0aGUgaW5zdGFudCBpdCBoYXBwZW5zIChGOSkuXG4gIC8vIE9uIHN0ZGVyciBzbyBpdCBuZXZlciBwb2xsdXRlcyB0aGUgc3Rkb3V0IEpTT04gcmVjZWlwdCwgYW5kIGl0IGZpcmVzIGV2ZW5cbiAgLy8gdW5kZXIgLS1xdWlldCAodGhlIHNhZmV0eSBzaWduYWwgc2hvdWxkbid0IGJlIHNpbGVuY2VkKS5cbiAgY29uc3QgcmVjaXAgPVxuICAgIGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkXG4gICAgICA/IGAke2RhdGEucmVjaXBpZW50c30gcmVjaXBpZW50KHMpYFxuICAgICAgOiBgJHtkYXRhLnN1YnNjcmliZXJzID8/IDB9IHN1YnNjcmliZXIocylgO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyDihpIgJHtkYXRhLmNoYW5uZWx9IMK3ICR7cmVjaXB9XFxuYCk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIC8vIFRlcnNlIGRlZmF1bHQ6IGlkICsgc3Vic2NyaWJlciBjb3VudCArIHZvaWQgd2FybmluZy4gLS12ZXJib3NlIGFsc29cbiAgLy8gaW5jbHVkZXMgdGhlIHN1YnNjcmliZXIgYWxpYXMgbGlzdCAoc2FtZSBkYXRhIGFzIHRoZSBgd2hvYCB2ZXJiLFxuICAvLyBwaWdneWJhY2tlZCB0byBhdm9pZCBhbiBleHRyYSByb3VuZC10cmlwIHdoZW4gdGhlIHNlbmRlciBjYXJlcykuXG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgaWQ6IGRhdGEuaWQsXG4gICAgY2hhbm5lbDogZGF0YS5jaGFubmVsLFxuICAgIHN1YnNjcmliZXJzOiBkYXRhLnN1YnNjcmliZXJzID8/IDAsXG4gIH07XG4gIC8vIE9ubHkgc3VyZmFjZSByZWNpcGllbnRzIGlmIHRoZSBkYWVtb24gYWN0dWFsbHkgY29tcHV0ZWQgaXQuIERlZmF1bHRpbmdcbiAgLy8gdG8gMCB3YXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBcInJlYWxseSAwXCIgYW5kIGhpZCBzaWxlbnQgVjEuNS1kYWVtb25cbiAgLy8gZGVncmFkYXRpb24gZHVyaW5nIGNyb3NzLXZlcnNpb24gc2Vzc2lvbnM7IG1pc3NpbmctbWVhbnMtbWlzc2luZyBpcyB0aGVcbiAgLy8gaG9uZXN0IHNpZ25hbC5cbiAgaWYgKGRhdGEucmVjaXBpZW50cyAhPT0gdW5kZWZpbmVkKSBvdXQucmVjaXBpZW50cyA9IGRhdGEucmVjaXBpZW50cztcbiAgaWYgKGRhdGEuc3Vic2NyaWJlcnMgPT09IDApIG91dC53YXJuaW5nID0gXCJjaGFubmVsIGhhcyBubyBzdWJzY3JpYmVyc1wiO1xuICBlbHNlIGlmIChkYXRhLnJlY2lwaWVudHMgPT09IDApIG91dC53YXJuaW5nID0gXCJvbmx5IHlvdSBhcmUgc3Vic2NyaWJlZFwiO1xuICBpZiAob3B0cy52ZXJib3NlKSBvdXQuc3Vic2NyaWJlcl9hbGlhc2VzID0gZGF0YS5zdWJzY3JpYmVyX2FsaWFzZXMgPz8gW107XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBbm5vdW5jZShcbiAgZnJvbTogc3RyaW5nLFxuICB0ZXh0OiBzdHJpbmcsXG4gIGNoYW5uZWxzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW4gfSxcbikge1xuICBpZiAoIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgYW5ub3VuY2UgLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGNoYW5uZWxzPzogc3RyaW5nW10gfSA9IHsgZnJvbSwgdGV4dCB9O1xuICBpZiAoY2hhbm5lbHM/Lmxlbmd0aCkgYm9keS5jaGFubmVscyA9IGNoYW5uZWxzO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPEFubm91bmNlUmVjZWlwdD4ocG9ydCwgXCJQT1NUXCIsIFwiL2Fubm91bmNlXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCB8fCAhZGF0YSkgZGllKGFwaUVycm9yKGRhdGEsIHN0YXR1cykpO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgIyBhbm5vdW5jZWQg4oaSICR7ZGF0YS5jaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykgwrcgJHtkYXRhLnRvdGFsX3JlY2lwaWVudHN9IHJlY2lwaWVudChzKVxcbmAsXG4gICk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgY2hhbm5lbHM6IGRhdGEuY2hhbm5lbHMsXG4gICAgdG90YWxfcmVjaXBpZW50czogZGF0YS50b3RhbF9yZWNpcGllbnRzLFxuICB9O1xuICBpZiAoZGF0YS5za2lwcGVkPy5sZW5ndGgpIG91dC5za2lwcGVkID0gZGF0YS5za2lwcGVkO1xuICBpZiAoZGF0YS5jaGFubmVscy5sZW5ndGggPT09IDApIG91dC53YXJuaW5nID0gXCJubyBhY3RpdmUgY2hhbm5lbHMgdG8gYW5ub3VuY2UgdG9cIjtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFB1bGwobmFtZTogc3RyaW5nLCBzaW5jZTogbnVtYmVyLCBvcHRzOiB7IHN0YXR1cz86IHN0cmluZyB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHB1bGwgPGNoYW5uZWw+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuXG4gIGlmIChvcHRzLnN0YXR1cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gVGhpcyBicmFuY2ggYW5zd2VycyBmcm9tIHRoZSBsb2cgZmlsZSwgc28gaXQgY2Fubm90IDQwNCBvbiBpdHMgb3duLlxuICAgIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICAgIC8vIEZ1bGwtY2hhbm5lbCBzY2FuOiBmaWx0ZXIgYnkgbGF0ZXN0IGRpc3Bvc2l0aW9uLCBzdGF0dXMgZnJhbWVzIGV4Y2x1ZGVkLlxuICAgIGNvbnN0IGJhZGdlZCA9IGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQobmFtZSk7XG4gICAgY29uc3QgZmlsdGVyZWQgPSBiYWRnZWQuZmlsdGVyKChtKSA9PiB7XG4gICAgICBjb25zdCBkaXNwQXJnID0gbS5kaXNwb3NpdGlvbiAhPT0gdW5kZWZpbmVkID8geyBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbiB9IDogdW5kZWZpbmVkO1xuICAgICAgLy8gYC0tc3RhdHVzIG9wZW5gIG1pcnJvcnMgdHJpYWdlJ3Mgb3BlbiBidWNrZXQ6IHNpZ25hbC1vbmx5LCBzbyBub24tbWVzc2FnZVxuICAgICAgLy8gRllJcyAodG9waWMvYW5ub3VuY2VtZW50KSBhcmUgZXhjbHVkZWQgZnJvbSB0aGUgYWN0aW9uYWJsZSBxdWV1ZS5cbiAgICAgIHJldHVybiBvcHRzLnN0YXR1cyA9PT0gXCJvcGVuXCJcbiAgICAgICAgPyBtLmtpbmQgPT09IFwibWVzc2FnZVwiICYmIGlzT3BlbihkaXNwQXJnKVxuICAgICAgICA6IG0uZGlzcG9zaXRpb24gPT09IG9wdHMuc3RhdHVzO1xuICAgIH0pO1xuICAgIGNvbnN0IGxhc3RJZCA9IGZpbHRlcmVkLmxlbmd0aCA/IGZpbHRlcmVkW2ZpbHRlcmVkLmxlbmd0aCAtIDFdLmlkIDogMDtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IGZpbHRlcmVkLCBjdXJzb3I6IGxhc3RJZCB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaW5jZS13aW5kb3cgcGF0aCAodW5jaGFuZ2VkIGZyb20gVGFzayAyKS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzP3NpbmNlPSR7c2luY2V9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZShhcGlFcnJvcihkYXRhLCBzdGF0dXMpKTtcbiAgY29uc3QgcmF3TXNncyA9IGRhdGE/Lm1lc3NhZ2VzID8/IFtdO1xuICBjb25zdCBjdXJzb3IgPSByYXdNc2dzLmxlbmd0aCA/IHJhd01zZ3NbcmF3TXNncy5sZW5ndGggLSAxXS5pZCA6IHNpbmNlO1xuICBjb25zdCBkaXNwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgYW5ub3RhdGVkID0gcmF3TXNnc1xuICAgIC8vIERpc3Bvc2l0aW9uIGZyYW1lcyBvbmx5IOKAlCBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHN0YXlzIGluXG4gICAgLy8gdGhlIGhpc3RvcnkgYW4gYWdlbnQgcHVsbHM7IGl0IGlzIGhvdyBpdCBsZWFybnMgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQuXG4gICAgLmZpbHRlcigobSkgPT4gIWlzRGlzcG9zaXRpb25GcmFtZShtKSlcbiAgICAubWFwKChtKSA9PiB7XG4gICAgICBjb25zdCBkID0gZGlzcC5nZXQobS5pZCk7XG4gICAgICByZXR1cm4gZCA/IHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbTtcbiAgICB9KTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBhbm5vdGF0ZWQsIGN1cnNvciB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhZChuYW1lOiBzdHJpbmcsIGlkOiBudW1iZXIsIG9wdHM6IHsgdGV4dD86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVhZCA8Y2hhbm5lbD4gPGlkPiBbLS10ZXh0XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBCdWlsdCBvbiB0aGUgZXhpc3RpbmcgcmFuZ2UgZmV0Y2gg4oCUIGBzaW5jZT1pZC0xYCByZXR1cm5zIGlkIGFuZCBiZXlvbmQ7XG4gIC8vIHdlIHBpY2sgdGhlIGV4YWN0IGlkLiBObyBkYWVtb24gQVBJIGNoYW5nZS4gVGhpcyBpcyB0aGUgdGFyZ2V0ZWRcbiAgLy8gXCJnaXZlIG1lIG1lc3NhZ2UgTiBpbiBmdWxsXCIgdmVyYiB0aGF0IHJlY292ZXJzIGEgY2xpcHBlZCB0YWlsIHByZXZpZXdcbiAgLy8gd2l0aG91dCB0aGUgcHVsbC1yYW5nZSArIGpxIGRhbmNlLlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2VzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXM/c2luY2U9JHtpZCAtIDF9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZShhcGlFcnJvcihkYXRhLCBzdGF0dXMpKTtcbiAgY29uc3QgbXNnID0gKGRhdGE/Lm1lc3NhZ2VzID8/IFtdKS5maW5kKChtKSA9PiBtLmlkID09PSBpZCk7XG4gIGlmICghbXNnKSBkaWUoYG1lc3NhZ2UgJHtpZH0gbm90IGZvdW5kIGluICR7bmFtZX1gLCAxKTtcbiAgY29uc3QgZGlzcE1hcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGQgPSBkaXNwTWFwLmdldChpZCk7XG4gIGNvbnN0IGFubm90YXRlZE1zZyA9IGQgPyB7IC4uLm1zZywgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbXNnO1xuICBpZiAob3B0cy50ZXh0KSB7XG4gICAgLy8gUHJvc2UgbW9kZTogaGVhZGVyICsgYm9keSwgbm8gSlNPTiBlbnZlbG9wZSwgc28gYSBodW1hbiAob3IgYW4gYWdlbnRcbiAgICAvLyByZWNvdmVyaW5nIGEgdHJ1bmNhdGVkIG5vdGlmaWNhdGlvbikgY2FuIHJlYWQgaXQgZGlyZWN0bHkuXG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZShtc2cudHMpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgZGlzcFByZWZpeCA9IGRcbiAgICAgID8gZC5yZW9wZW5zID4gMFxuICAgICAgICA/IGBbJHtkLmRpc3Bvc2l0aW9ufSDihrske2QucmVvcGVuc31dIGBcbiAgICAgICAgOiBgWyR7ZC5kaXNwb3NpdGlvbn1dIGBcbiAgICAgIDogXCJcIjtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtkaXNwUHJlZml4fVske21zZy5pZH1dICR7bXNnLmZyb219IMK3ICR7dHN9XFxuJHttc2cudGV4dH1cXG5gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2U6IGFubm90YXRlZE1zZyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2FpdChuYW1lOiBzdHJpbmcsIHNpbmNlOiBudW1iZXIsIHRpbWVvdXRTOiBudW1iZXIsIGFsaWFzOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdhaXQgPGNoYW5uZWw+IFstLWFzIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBHaXZlIHRoZSBIVFRQIGZldGNoIGEgc2xpZ2h0bHkgaGlnaGVyIGFib3J0IHRpbWVvdXQgdGhhbiB0aGUgZGFlbW9uJ3NcbiAgLy8gbG9uZy1wb2xsIHRpbWVvdXQgc28gdGhlIGRhZW1vbiBhbHdheXMgd2lucyB0aGUgdGltZW91dCByYWNlLlxuICAvLyBgP2FzPTxhbGlhcz5gIHJlZ2lzdGVycyBwcmVzZW5jZSBvbiB0aGUgY2hhbm5lbCBmb3IgdGhlIHdhaXQgZHVyYXRpb24g4oCUXG4gIC8vIHdhaXQgaXMgbG9uZy1wb2xsIChwdXNoLXNoYXBlZCB3aXRoIGEgZGVhZGxpbmUpIHNvIGl0IGRlc2VydmVzIHByZXNlbmNlLlxuICBjb25zdCBhc1BhcmFtID0gYWxpYXMgPyBgJmFzPSR7ZW5jb2RlVVJJQ29tcG9uZW50KGFsaWFzKX1gIDogXCJcIjtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFubmVscy8ke25hbWV9L3dhaXQ/c2luY2U9JHtzaW5jZX0mdGltZW91dD0ke3RpbWVvdXRTfSR7YXNQYXJhbX1gO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHtcbiAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoKHRpbWVvdXRTICsgNSkgKiAxMDAwKSxcbiAgfSk7XG4gIGxldCBkYXRhOiBXYWl0UmVzcG9uc2UgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFdhaXRSZXNwb25zZTtcbiAgfSBjYXRjaCB7fVxuICBpZiAoIXJlcy5vaykgZGllKGFwaUVycm9yKGRhdGEsIHJlcy5zdGF0dXMpKTtcbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBtZXNzYWdlczogZGF0YT8ubWVzc2FnZXMgPz8gW10sXG4gICAgY3Vyc29yOiBkYXRhPy5jdXJzb3IgPz8gc2luY2UsXG4gICAgdGltZWRfb3V0OiAhIWRhdGE/LnRpbWVkX291dCxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdobyhuYW1lOiBzdHJpbmcpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdobyA8Y2hhbm5lbD5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbDogbmFtZSwgc3Vic2NyaWJlcnM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN1YnNjcmliZXJzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vc3Vic2NyaWJlcnNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllKGRhdGE/LmVycm9yID8/IGBIVFRQICR7c3RhdHVzfWApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvQWxsKCkge1xuICAvLyBDcm9zcy1jaGFubmVsIHJvc3RlciDigJQgbmFtZXMgw5cgY2hhbm5lbCBpbiBvbmUgY2FsbCwgc28geW91IGRvbid0IGZhbiBvdXRcbiAgLy8gTiBgd2hvYCBjYWxscyArIGEgbWFudWFsIGpvaW4gdG8gYW5zd2VyIFwid2hvIGlzIG9uIHdoaWNoIHZpbmU/XCIuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllKGRhdGE/LmVycm9yID8/IGBIVFRQICR7c3RhdHVzfWApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuLy8gR2V0IG9yIHNldCB0aGUgcGVyc2lzdGVkIGRlZmF1bHQgYWxpYXMgKFYxLjcpLiBXaXRoIG5vIGFyZ3VtZW50LCBwcmludHMgdGhlXG4vLyBjdXJyZW50IGFsaWFzOyB3aXRoIG9uZSwgd3JpdGVzIGl0IHRvIGNvbmZpZy5qc29uLiBQdXJlIGZpbGUgSS9PIOKAlCB3b3Jrc1xuLy8gd2l0aG91dCBhIHJ1bm5pbmcgZGFlbW9uLiBUaGUgd2F0Y2ggc3VyZmFjZSByZWFkcyBpdCB2aWEgR0VUIC9pZGVudGl0eSBzbyB0aGVcbi8vIGh1bWFuIGhhcyBhIGNvbnNpc3RlbnQgbmFtZSBhY3Jvc3MgZXZlcnkgZ3JhcGV2aW5lLlxuYXN5bmMgZnVuY3Rpb24gY21kQWxpYXMobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGxldCBjZmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG4gIHRyeSB7XG4gICAgY2ZnID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoQ09ORklHX0ZJTEUsIFwidXRmLThcIikpO1xuICB9IGNhdGNoIHt9XG4gIGlmIChuYW1lID09PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCBhbGlhcyA9IHR5cGVvZiBjZmcuYWxpYXMgPT09IFwic3RyaW5nXCIgJiYgY2ZnLmFsaWFzLnRyaW0oKSA/IGNmZy5hbGlhcy50cmltKCkgOiBudWxsO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhcyB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgdHJpbW1lZCA9IG5hbWUudHJpbSgpO1xuICBjZmcuYWxpYXMgPSB0cmltbWVkO1xuICBta2RpclN5bmMoREFUQV9ESVIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB3cml0ZUZpbGVTeW5jKENPTkZJR19GSUxFLCBgJHtKU09OLnN0cmluZ2lmeShjZmcsIG51bGwsIDIpfVxcbmApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgYWxpYXM6IHRyaW1tZWQgfHwgbnVsbCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgbmFtZTogc3RyaW5nLFxuICBvcHRzOiB7XG4gICAgc2luY2U/OiBudW1iZXI7XG4gICAgZnJvbVN0YXJ0PzogYm9vbGVhbjtcbiAgICBsYXN0PzogbnVtYmVyO1xuICAgIGFzPzogc3RyaW5nO1xuICAgIGh1bWFuPzogYm9vbGVhbjtcbiAgICBsdXJrPzogYm9vbGVhbjtcbiAgICBtYXg/OiBudW1iZXI7XG4gIH0sXG4pIHtcbiAgaWYgKCFuYW1lKVxuICAgIGRpZShcbiAgICAgIFwidXNhZ2U6IGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXCIsXG4gICAgKTtcbiAgLy8gLS1sdXJrIHJlY2VpdmVzIG1lc3NhZ2VzIGJ1dCByZWdpc3RlcnMgbm8gcHJlc2VuY2Ug4oCUIGFuIGludmlzaWJsZSBvYnNlcnZlci5cbiAgLy8gSXQgb3ZlcnJpZGVzIGlkZW50aXR5IGZsYWdzIChhIGx1cmtlciBoYXMgbm8gbmFtZSB0byBzaG93KS5cbiAgY29uc3QgbXlBbGlhcyA9IG9wdHMubHVyayA/IHVuZGVmaW5lZCA6IG9wdHMuYXM7XG5cbiAgLy8gQ2xlYW4gZXhpdCBvbiBzaWduYWxzIHNvIHRoZSBTU0Ugc3RyZWFtIGRvZXNuJ3QgbGVhay5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgY29uc3QgY2xlYW51cCA9ICgpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH07XG4gIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgY2xlYW51cCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIGNsZWFudXApO1xuXG4gIGxldCBoaWdoZXN0U2VlbiA9IG9wdHMuZnJvbVN0YXJ0ID8gMCA6IChvcHRzLnNpbmNlID8/IC0xKTtcbiAgbGV0IHJlY29ubmVjdERlbGF5ID0gMjUwO1xuICAvLyBFbWl0IHRoZSBncm91bmRpbmcgbGluZSBvbmx5IG9uIHRoZSBmaXJzdCBzdWJzY3JpYmUsIG5ldmVyIG9uIHJlY29ubmVjdHNcbiAgLy8gKGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSBoaWdoZXN0U2VlbiDigJQgdGhlcmUncyBubyB1bnNlZW4gaGlzdG9yeSB0aGVuKS5cbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG5cbiAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAgIC8vIOKaoCBOTyBlbnN1cmUgY2FsbC4gQSBmcmVzaCBgdGFpbCBuYW1lYCBzdGlsbCB3b3JrcyB3aXRob3V0IGFuIGV4cGxpY2l0XG4gICAgLy8gb3BlbiDigJQgR0VUIOKApi90YWlsIGNyZWF0ZXMgdGhlIGNoYW5uZWwgaXRzZWxmIOKAlCBhbmQgdGhhdCBpcyB0aGUgT05MWSB3YXlcbiAgICAvLyB0aGUgc3Vic2NyaWJlZCBldmVudCdzIGBjcmVhdGVkYCBmbGFnIGNhbiBldmVyIGJlIHRydWU6IGFuIGVuc3VyZSBzZW50XG4gICAgLy8gZmlyc3QgY3JlYXRlcyB0aGUgY2hhbm5lbCwgc28gdGhlIHN1YnNjcmliZSB0aGF0IGZvbGxvd3MgYWx3YXlzIHJlcG9ydHNcbiAgICAvLyBgY3JlYXRlZDpmYWxzZWAgYW5kIHRoZSBtaXN0eXBlZC1uYW1lIHNpZ25hbCBuZXZlciBmaXJlcy5cbiAgICBjb25zdCBhc1BhcmFtID0gbXlBbGlhcyA/IGAmYXM9JHtlbmNvZGVVUklDb21wb25lbnQobXlBbGlhcyl9YCA6IFwiXCI7XG4gICAgY29uc3QgaHVtYW5QYXJhbSA9IG9wdHMuaHVtYW4gJiYgIW9wdHMubHVyayA/IFwiJmh1bWFuPTFcIiA6IFwiXCI7XG4gICAgY29uc3QgbHVya1BhcmFtID0gb3B0cy5sdXJrID8gXCImbHVyaz0xXCIgOiBcIlwiO1xuICAgIC8vICM2OCDigJQgYC0tbGFzdCBOYCBvbmx5IHJpZGVzIHRoZSBGSVJTVCBjb25uZWN0aW9uICh3aGlsZSB3ZSd2ZSBzZWVuIG5vdGhpbmdcbiAgICAvLyB5ZXQsIGhpZ2hlc3RTZWVuIDwgMCkuIE9uY2UgYW55IG1lc3NhZ2UgbGFuZHMsIGhpZ2hlc3RTZWVuIGFkdmFuY2VzIGFuZCBhXG4gICAgLy8gcmVjb25uZWN0IHJlc3VtZXMgZnJvbSBpdCB2aWEgYHNpbmNlYCDigJQgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgdGhlIHdpbmRvdy5cbiAgICBjb25zdCBsYXN0UGFyYW0gPSBvcHRzLmxhc3QgIT09IHVuZGVmaW5lZCAmJiBoaWdoZXN0U2VlbiA8IDAgPyBgJmxhc3Q9JHtvcHRzLmxhc3R9YCA6IFwiXCI7XG4gICAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9jaGFubmVscy8ke25hbWV9L3RhaWw/c2luY2U9JHtoaWdoZXN0U2Vlbn0ke2xhc3RQYXJhbX0ke2FzUGFyYW19JHtodW1hblBhcmFtfSR7bHVya1BhcmFtfWA7XG5cbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgY29ubmVjdCBmYWlsZWQ6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfSwgcmV0cnlpbmfigKZcXG5gLFxuICAgICAgKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHJlY29ubmVjdERlbGF5KSk7XG4gICAgICByZWNvbm5lY3REZWxheSA9IE1hdGgubWluKHJlY29ubmVjdERlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB0YWlsIEhUVFAgJHtyZXMuc3RhdHVzfSwgcmV0cnlpbmfigKZcXG5gKTtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIHJlY29ubmVjdERlbGF5KSk7XG4gICAgICByZWNvbm5lY3REZWxheSA9IE1hdGgubWluKHJlY29ubmVjdERlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcmVjb25uZWN0RGVsYXkgPSAyNTA7IC8vIHJlc2V0IG9uIGEgc3VjY2Vzc2Z1bCBvcGVuXG5cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZmZlciA9IFwiXCI7XG5cbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgbGV0IGNodW5rOiBSZWFkYWJsZVN0cmVhbVJlYWRSZXN1bHQ8VWludDhBcnJheT47XG4gICAgICB0cnkge1xuICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgIGAjIHN0cmVhbSBkcm9wcGVkOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX0sIHJlY29ubmVjdGluZ+KAplxcbmAsXG4gICAgICAgICk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgc3RyZWFtIGNsb3NlZCwgcmVjb25uZWN0aW5n4oCmXFxuYCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgYnVmZmVyICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIC8vIERyYWluIGNvbXBsZXRlIFNTRSBmcmFtZXMgKHNlcGFyYXRlZCBieSBhIGJsYW5rIGxpbmUpLiBSZS1yZWFkIHRoZVxuICAgICAgLy8gc2VwYXJhdG9yIGluZGV4IGVhY2ggcGFzcyBzbyBgY29udGludWVgIHN0YXRlbWVudHMgYmVsb3cgZG9uJ3Qgc2tpcFxuICAgICAgLy8gdGhlIGJ1ZmZlciBhZHZhbmNlICh3aGljaCBhIGhvaXN0ZWQtb25jZSBhc3NpZ25tZW50IHdvdWxkKS5cbiAgICAgIGZvciAobGV0IHNlcCA9IGJ1ZmZlci5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmZmVyLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWZmZXIuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgYnVmZmVyID0gYnVmZmVyLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICBjb25zdCBsaW5lcyA9IGJsb2NrLnNwbGl0KFwiXFxuXCIpO1xuICAgICAgICBsZXQgZXZlbnROYW1lID0gXCJtZXNzYWdlXCI7XG4gICAgICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgIC8vIERhZW1vbiBsaXZlbmVzcyBoZWFydGJlYXQgKGA6IGhiIDx0cz5gKS4gU3VyZmFjZSBhIHJlY29nbml6YWJsZVxuICAgICAgICAgICAgLy8gc2VudGluZWwgb24gc3RkZXJyIHNvIGEgYDI+JjFgIGNvbnN1bWVyIGNhbiB0ZWxsIFwiaWRsZVwiIGZyb21cbiAgICAgICAgICAgIC8vIFwid2VkZ2VkXCIgKEY2KS4gS2VwdCBvZmYgc3Rkb3V0IOKAlCB0aGUgSlNPTkwgc3RyZWFtIHN0YXlzIHB1cmUuXG4gICAgICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOiBoYlwiKSkgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCI6IGdyYXBldmluZS1rZWVwYWxpdmVcXG5cIik7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcImV2ZW50OlwiKSkgZXZlbnROYW1lID0gbGluZS5zbGljZSg2KS50cmltKCk7XG4gICAgICAgICAgZWxzZSBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkudHJpbSgpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWRhdGFMaW5lcy5sZW5ndGgpIGNvbnRpbnVlO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnBhcnNlKGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpKSBhcyBUYWlsUGF5bG9hZDtcbiAgICAgICAgICBpZiAoZXZlbnROYW1lID09PSBcInN1YnNjcmliZWRcIikge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgc3Vic2NyaWJlZCB0byAke3BheWxvYWQuY2hhbm5lbH0gKHNpbmNlPSR7cGF5bG9hZC5zaW5jZX0pXFxuYCk7XG4gICAgICAgICAgICBpZiAocGF5bG9hZC50b3BpYykgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgdG9waWM6ICR7cGF5bG9hZC50b3BpY31cXG5gKTtcbiAgICAgICAgICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICAgIGAjIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCB0aGlzIHRhaWwgYnJvdWdodCBpdCBpbnRvIGJlaW5nIChjaGVjayB0aGUgbmFtZSlcXG5gLFxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICAgIGAjICR7cGF5bG9hZC5jaGFubmVsfSBpcyBhcmNoaXZlZCDigJQgcmVhZC1vbmx5OyBhIHNlbmQgd2lsbCBiZSByZWplY3RlZFxcbmAsXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAvLyBTdHJ1Y3R1cmVkIGdyb3VuZGluZyBvbiBzdGRvdXQgKEYzL0Y3KSDigJQgdW5kZXIgdGhlIGRlZmF1bHRcbiAgICAgICAgICAgIC8vIFdpcmluZy1CIE1vbml0b3IsIHN0ZG91dCBzdXJmYWNlcyBhcyBub3RpZmljYXRpb25zLCBzbyBhIGZyZXNoXG4gICAgICAgICAgICAvLyBzdWJzY3JpYmVyIGFjdHVhbGx5IHNlZXMgdGhlIHRvcGljICsgdGhhdCBlYXJsaWVyIGhpc3RvcnkgZXhpc3RzLlxuICAgICAgICAgICAgLy8gR2F0ZWQ6IG9ubHkgd2hlbiB0aGVyZSdzIHNvbWV0aGluZyB0byBncm91bmQgKHVuc2VlbiBoaXN0b3J5IG9yIGFcbiAgICAgICAgICAgIC8vIHRvcGljKSwgYW5kIG9ubHkgb24gdGhlIGZpcnN0IHN1YnNjcmliZSAobm90IHJlY29ubmVjdHMpLlxuICAgICAgICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICAgICAgICBncm91bmRlZCA9IHRydWU7XG4gICAgICAgICAgICAgIGNvbnN0IGxhdGVzdCA9IHR5cGVvZiBwYXlsb2FkLmxhdGVzdF9pZCA9PT0gXCJudW1iZXJcIiA/IHBheWxvYWQubGF0ZXN0X2lkIDogMDtcbiAgICAgICAgICAgICAgY29uc3QgZWFybGllciA9IGhpZ2hlc3RTZWVuIDwgMCA/IGxhdGVzdCA6IE1hdGgubWF4KDAsIE1hdGgubWluKGhpZ2hlc3RTZWVuLCBsYXRlc3QpKTtcbiAgICAgICAgICAgICAgLy8gYGNyZWF0ZWRgIGFuZCBgYXJjaGl2ZWRgIGpvaW4gdGhlIGdhdGUgb24gcHVycG9zZS4gQSBjaGFubmVsXG4gICAgICAgICAgICAgIC8vIHRoaXMgc3Vic2NyaWJlIGp1c3QgbWFkZSBoYXMgbm8gdG9waWMgYW5kIG5vIGhpc3RvcnksIHNvIHRoZVxuICAgICAgICAgICAgICAvLyBvbGQgY29uZGl0aW9uIChgZWFybGllciA+IDAgfHwgdG9waWNgKSBpcyBleGFjdGx5IHRoZSBjYXNlIHRoYXRcbiAgICAgICAgICAgICAgLy8gZW1pdHMgTk9USElORzsgYW5kIGFuIEFSQ0hJVkVEIGNoYW5uZWwncyBncm91bmRpbmcgbGluZSB3YXNcbiAgICAgICAgICAgICAgLy8gaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGhlYWx0aHkgb25lJ3MsIHNvIGEgbGF0ZSBqb2luZXIgc3RpbGxcbiAgICAgICAgICAgICAgLy8gbGVhcm5lZCB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZCBvbmx5IHdoZW4gaXRzIHNlbmQgYm91bmNlZC5cbiAgICAgICAgICAgICAgLy9cbiAgICAgICAgICAgICAgLy8g4pqgIFRoZSBoaW50cyBBQ0NVTVVMQVRFIGludG8gYSBsaXN0IHJhdGhlciB0aGFuIGFzc2lnbmluZyB0byBvbmVcbiAgICAgICAgICAgICAgLy8gZmllbGQuIFRoZXkgdXNlZCB0byBiZSB0aHJlZSBhc3NpZ25tZW50cyB0byBgZ3JvdW5kaW5nLmhpbnRgLFxuICAgICAgICAgICAgICAvLyBvcmRlcmVkIHNvIHRoZSBtb3N0IGltcG9ydGFudCB3b24g4oCUIHdoaWNoIGlzIGEgaGludCB0aGF0IGNhblxuICAgICAgICAgICAgICAvLyBzaWxlbnRseSBsb3NlIHRvIGFub3RoZXIgaGludCwgdGhlIGZhaWx1cmUgbW9kZSB0aGlzIHdob2xlXG4gICAgICAgICAgICAgIC8vIGJyYW5jaCBpcyBhYm91dCwgc2l0dGluZyBpbiB0aGUgZml4IGZvciBpdC4gQSBsaXN0IGNhbm5vdFxuICAgICAgICAgICAgICAvLyBvdmVyd3JpdGU6IGFuIGFyY2hpdmVkIGNoYW5uZWwgV0lUSCBoaXN0b3J5IG5vdyBzYXlzIGJvdGguXG4gICAgICAgICAgICAgIGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICAgICAgICBpZiAoZWFybGllciA+IDApXG4gICAgICAgICAgICAgICAgaGludHMucHVzaChcbiAgICAgICAgICAgICAgICAgIGAke2VhcmxpZXJ9IGVhcmxpZXIgbWVzc2FnZShzKSBleGlzdCDigJQgdXNlIC0tZnJvbS1zdGFydCBvciAtLXNpbmNlIDxpZD4gdG8gYmFja2ZpbGxgLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICAgICAgICAgICAgaGludHMucHVzaChcbiAgICAgICAgICAgICAgICAgIGB0aGlzIHRhaWwgY3JlYXRlZCAke3BheWxvYWQuY2hhbm5lbH0g4oCUIG5vIHN1Y2ggY2hhbm5lbCBleGlzdGVkOyBjaGVjayB0aGUgbmFtZSwgb3IgYW5vdGhlciBwYXJ0eSBoYXMgeWV0IHRvIG9wZW4gaXRgLFxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKVxuICAgICAgICAgICAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgICAgICAgICAgICBgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkIHVudGlsIHNvbWVvbmUgdW5hcmNoaXZlcyBpdGAsXG4gICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgaWYgKGVhcmxpZXIgPiAwIHx8IHBheWxvYWQudG9waWMgfHwgcGF5bG9hZC5jcmVhdGVkIHx8IHBheWxvYWQuYXJjaGl2ZWQpIHtcbiAgICAgICAgICAgICAgICBjb25zdCBncm91bmRpbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAgICAgICAgICAgICAga2luZDogXCJncm91bmRpbmdcIixcbiAgICAgICAgICAgICAgICAgIGNoYW5uZWw6IHBheWxvYWQuY2hhbm5lbCxcbiAgICAgICAgICAgICAgICAgIGpvaW5lZF9hdDogaGlnaGVzdFNlZW4gPCAwID8gbGF0ZXN0IDogTWF0aC5taW4oaGlnaGVzdFNlZW4sIGxhdGVzdCksXG4gICAgICAgICAgICAgICAgICBlYXJsaWVyLFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgaWYgKHBheWxvYWQudG9waWMpIGdyb3VuZGluZy50b3BpYyA9IHBheWxvYWQudG9waWM7XG4gICAgICAgICAgICAgICAgaWYgKHBheWxvYWQuY3JlYXRlZCkgZ3JvdW5kaW5nLmNyZWF0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKSBncm91bmRpbmcuYXJjaGl2ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGlmIChoaW50cy5sZW5ndGgpIGdyb3VuZGluZy5oaW50ID0gaGludHMuam9pbihcIiDCtyBcIik7XG4gICAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZ3JvdW5kaW5nKX1cXG5gKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmICh0eXBlb2YgcGF5bG9hZC5pZCA9PT0gXCJudW1iZXJcIiAmJiBwYXlsb2FkLmlkID4gaGlnaGVzdFNlZW4pIHtcbiAgICAgICAgICAgIGhpZ2hlc3RTZWVuID0gcGF5bG9hZC5pZDtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gRHJvcCBESVNQT1NJVElPTiBmcmFtZXMg4oCUIHRoZXkgYXJlIG1ldGFkYXRhIGFib3V0IGFub3RoZXIgbWVzc2FnZS5cbiAgICAgICAgICAvLyBBIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHBhc3NlcyB0aHJvdWdoOiBhbiBhZ2VudFxuICAgICAgICAgIC8vIHRhaWxpbmcgYSBjaGFubmVsIGNvdWxkIG5vdCBwcmV2aW91c2x5IHNlZSBlaXRoZXIgcGFydHkgcmV0aXJlIGl0LFxuICAgICAgICAgIC8vIGFuZCBmb3VuZCBvdXQgd2hlbiBpdHMgbmV4dCBzZW5kIHdhcyByZWplY3RlZC5cbiAgICAgICAgICBpZiAoaXNEaXNwb3NpdGlvbkZyYW1lKHBheWxvYWQpKSBjb250aW51ZTtcbiAgICAgICAgICAvLyBTdXBwcmVzcyBzZWxmLWVjaG86IHdoZW4gLS1hcyBpcyBzZXQsIGRyb3AgbWVzc2FnZXMgd2Ugc2VudFxuICAgICAgICAgIC8vIG91cnNlbHZlcy4gVGhlIHNlbmRlciBhbHJlYWR5IGdvdCB0aGUgcmVjZWlwdCBhcyB0aGUgUE9TVFxuICAgICAgICAgIC8vIHJlc3BvbnNlLCBzbyByZS1lbWl0dGluZyBpdCBvbiB0YWlsIGlzIHB1cmUgbm9pc2UuXG4gICAgICAgICAgaWYgKG15QWxpYXMgJiYgcGF5bG9hZC5mcm9tID09PSBteUFsaWFzKSBjb250aW51ZTtcbiAgICAgICAgICAvLyAjNjcg4oCUIGZyb250LWxvYWQgYSByZWNvdmVyeSBwb2ludGVyIG9uIEVWRVJZIG1lc3NhZ2UgZnJhbWUsIHNvIHRoZVxuICAgICAgICAgIC8vIHJlYWQgY29vcmRpbmF0ZXMgc3Vydml2ZSBhIGRvd25zdHJlYW0gbm90aWZpY2F0aW9uIGNsaXAuIE1vbml0b3JcbiAgICAgICAgICAvLyB0cnVuY2F0ZXMgYXQgaXRzIE9XTiBjYXAgKGJlbG93IG91ciBoaW50IHRocmVzaG9sZCwgYW5kIG9uZSB3ZSBjYW4ndFxuICAgICAgICAgIC8vIG9ic2VydmUgaGVyZSk7IGEgbWVzc2FnZSBpdCBjbGlwcyB3b3VsZCBvdGhlcndpc2UgbG9zZSBpdHMgdHJhaWxpbmdcbiAgICAgICAgICAvLyBgaWRgIGFuZCBiZWNvbWUgdW5yZWNvdmVyYWJsZSDigJQgdGhlIHJlYWRlciBpcyBsZWZ0IGluZmVycmluZyB0aGUgaWQuXG4gICAgICAgICAgLy8gRXZlcnkgZnJhbWUgdGhlcmVmb3JlIGNhcnJpZXMgYSBGUk9OVC1sb2FkZWQgYHJlYWQgPGNoYW5uZWw+IDxpZD5gLFxuICAgICAgICAgIC8vIGVpdGhlciBhcyB0aGUgcmljaGVyIGB0cnVuY2F0aW9uX2hpbnRgIChnZW51aW5lbHktbG9uZyBtZXNzYWdlcyDigJRcbiAgICAgICAgICAvLyB0aGUgXCIrTiBjaGFycywgeW91J3JlIGRlZmluaXRlbHkgbWlzc2luZyBjb250ZW50XCIgYWxhcm0pIG9yIGFzIHRoZVxuICAgICAgICAgIC8vIGNvbXBhY3QgYGZ1bGxgIHBvaW50ZXIgKGV2ZXJ5dGhpbmcgZWxzZSkuIFNlcmlhbGl6aW5nIGl0IGJlZm9yZSB0aGVcbiAgICAgICAgICAvLyBsb25nIGAudGV4dGAgaXMgd2hhdCBtYWtlcyBpdCBzdXJ2aXZlIHRoZSBjbGlwIChGMTcpLlxuICAgICAgICAgIGNvbnN0IHJlYWRSZWYgPSBgcmVhZCAke25hbWV9ICR7cGF5bG9hZC5pZH1gO1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIHR5cGVvZiBwYXlsb2FkLnRleHQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgICAgIHBheWxvYWQudGV4dC5sZW5ndGggPiAob3B0cy5tYXggPz8gVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRClcbiAgICAgICAgICApIHtcbiAgICAgICAgICAgIGNvbnN0IHRydW5jYXRpb25faGludCA9IGArJHtwYXlsb2FkLnRleHQubGVuZ3RofSBjaGFycyDigJQgZnVsbDogJHtyZWFkUmVmfWA7XG4gICAgICAgICAgICAvLyBDYXAgdGhlIElOTElORSBib2R5IHdoZW4gLS1tYXggaXMgc2V0ICh0aGUgZnVsbCBtZXNzYWdlIHN0YXlzIG9uXG4gICAgICAgICAgICAvLyBkaXNrIOKGkiBgcmVhZGApOyB3aXRob3V0IC0tbWF4LCBlbWl0IHRoZSBmdWxsIHRleHQgKHRvZGF5J3MgZGVmYXVsdCkuXG4gICAgICAgICAgICBjb25zdCB0ZXh0ID0gb3B0cy5tYXggIT09IHVuZGVmaW5lZCA/IHBheWxvYWQudGV4dC5zbGljZSgwLCBvcHRzLm1heCkgOiBwYXlsb2FkLnRleHQ7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh7IHRydW5jYXRpb25faGludCwgLi4ucGF5bG9hZCwgdGV4dCB9KX1cXG5gKTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoeyBmdWxsOiByZWFkUmVmLCAuLi5wYXlsb2FkIH0pfVxcbmApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIGJhZCBzc2UgZGF0YTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgLy8gQnJpZWYgcGF1c2UgYmVmb3JlIHJlY29ubmVjdDsgcmVzdW1lIGZyb20gaGlnaGVzdFNlZW4gc28gbm8gbWVzc2FnZXNcbiAgICAvLyBhcmUgbG9zdCBhY3Jvc3MgcmVjb25uZWN0cy5cbiAgICBpZiAoIXN0b3BwZWQpIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDIwMCkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZvbGREaXNwb3NpdGlvbnMobmFtZTogc3RyaW5nKSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8XG4gICAgbnVtYmVyLFxuICAgIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBzdHJpbmc7XG4gICAgICBmcm9tOiBzdHJpbmc7XG4gICAgICB0czogbnVtYmVyO1xuICAgICAgbm90ZTogc3RyaW5nO1xuICAgICAgcmVvcGVuczogbnVtYmVyO1xuICAgIH1cbiAgPigpO1xuICBjb25zdCBwYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBtYXA7XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgIT09IFwic3RhdHVzXCIgfHwgdHlwZW9mIG0udGFyZ2V0ICE9PSBcIm51bWJlclwiIHx8IHR5cGVvZiBtLmRpc3Bvc2l0aW9uICE9PSBcInN0cmluZ1wiKVxuICAgICAgY29udGludWU7XG4gICAgY29uc3QgcHJldiA9IG1hcC5nZXQobS50YXJnZXQpO1xuICAgIGNvbnN0IHJlb3BlbnMgPVxuICAgICAgKHByZXY/LnJlb3BlbnMgPz8gMCkgK1xuICAgICAgKG0uZGlzcG9zaXRpb24gPT09IFwib3BlblwiICYmIHByZXYgJiYgcHJldi5kaXNwb3NpdGlvbiAhPT0gXCJvcGVuXCIgPyAxIDogMCk7XG4gICAgbWFwLnNldChtLnRhcmdldCwge1xuICAgICAgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24sXG4gICAgICBmcm9tOiBtLmZyb20sXG4gICAgICB0czogbS50cyxcbiAgICAgIG5vdGU6IG0udGV4dCxcbiAgICAgIHJlb3BlbnMsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cbi8vIFRXTyB0aGluZ3Mgbm93IHdlYXIga2luZDpcInN0YXR1c1wiLiBBIERJU1BPU0lUSU9OIGZyYW1lIGFjdHMgb24gYSBzcGVjaWZpY1xuLy8gbWVzc2FnZSAoYHRhcmdldGAgKyBgZGlzcG9zaXRpb25gKSBhbmQgaXMgbWV0YWRhdGEg4oCUIGBwdWxsYCBhbmQgYHRhaWxgIGZvbGRcbi8vIGl0IGF3YXkgYW5kIGJhZGdlIHRoZSBtZXNzYWdlIGl0IHBvaW50cyBhdCBpbnN0ZWFkLiBBIExJRkVDWUNMRSBmcmFtZVxuLy8gKGFyY2hpdmUgLyB1bmFyY2hpdmUpIGlzIGEgZmFjdCBhYm91dCB0aGUgQ0hBTk5FTDogaXQgdGFyZ2V0cyBub3RoaW5nLCBhbmQgaXRcbi8vIGlzIHRoZSB3aG9sZSBwb2ludCB0aGF0IGEgcmVhZGVyIHNlZXMgaXQuIERpc2NyaW1pbmF0aW5nIG9uIGBkaXNwb3NpdGlvbmBcbi8vIHJhdGhlciB0aGFuIG9uIGBldmVudGAga2VlcHMgYSBmcmFtZSBmcm9tIHNvbWUgZnV0dXJlIGVtaXR0ZXIgdmlzaWJsZSBieVxuLy8gZGVmYXVsdCDigJQgdGhlIGZhaWx1cmUgbW9kZSBoZXJlIGlzIHN3YWxsb3dpbmcgYSBzaWduYWwsIG5vdCBzaG93aW5nIG9uZS5cbmZ1bmN0aW9uIGlzRGlzcG9zaXRpb25GcmFtZShtOiB7IGtpbmQ/OiBzdHJpbmc7IGRpc3Bvc2l0aW9uPzogc3RyaW5nIH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG0ua2luZCA9PT0gXCJzdGF0dXNcIiAmJiB0eXBlb2YgbS5kaXNwb3NpdGlvbiA9PT0gXCJzdHJpbmdcIjtcbn1cblxuLy8gXCJvcGVuXCIgPSBubyBlbnRyeSwgb3IgbGF0ZXN0IGRpc3Bvc2l0aW9uIGlzIFwib3BlblwiXG5mdW5jdGlvbiBpc09wZW4oZD86IHsgZGlzcG9zaXRpb246IHN0cmluZyB9KSB7XG4gIHJldHVybiAhZCB8fCBkLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIjtcbn1cblxuLy8gUmVhZHMgdGhlIGZ1bGwgY2hhbm5lbCBsb2csIGRyb3BzIEVWRVJZIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSwgYW5kIGJhZGdlcyBlYWNoXG4vLyByZW1haW5pbmcgbWVzc2FnZSB3aXRoIGl0cyBsYXRlc3QgZGlzcG9zaXRpb24gdmlhIGZvbGREaXNwb3NpdGlvbnMuXG4vL1xuLy8gRXZlcnkgb25lLCBkZWxpYmVyYXRlbHkg4oCUIGluY2x1ZGluZyBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpLFxuLy8gd2hpY2ggYHB1bGxgIGFuZCBgdGFpbGAgZG8gbGV0IHRocm91Z2guIFRoaXMgZmVlZHMgYHRyaWFnZWAsIHdob3NlIG9wZW4gcXVldWVcbi8vIGlzIFwid2hhdCBpcyBsZWZ0IHRvIGFjdCBvblwiLCBhbmQgYW4gYXJjaGl2ZSBpcyBhbiBGWUksIG5vdCBhIHdvcmsgaXRlbS4gU2FtZVxuLy8gcmVhc29uIGB0b3BpY2AgYW5kIGBhbm5vdW5jZW1lbnRgIGFyZSBmb2xkZWQgb3V0IG9mIHRoZSBvcGVuIGJ1Y2tldCBiZWxvdy5cbmZ1bmN0aW9uIGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQoXG4gIG5hbWU6IHN0cmluZyxcbik6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdIHtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSByZXR1cm4gW107XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBtZXNzYWdlczogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCA9PT0gXCJzdGF0dXNcIikgY29udGludWU7XG4gICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgIGlmIChkKSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWVzc2FnZXMucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1lc3NhZ2VzO1xufVxuXG50eXBlIEJhZGdlZE1lc3NhZ2UgPSBNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9O1xuXG4vLyBEYXNoYm9hcmQgcmVuZGVyIG9mIGEgdHJpYWdlIHNjYW46IHRoZSBvcGVuIHF1ZXVlIG9uIHRvcCwgdGhlbiBlYWNoXG4vLyBkaXNwb3NpdGlvbiBncm91cCwgb25lIHNjYW5uYWJsZSBsaW5lIHBlciBtZXNzYWdlLiBNaXJyb3JzIGByZWFkIC0tdGV4dGBcbi8vIHByb3NlIG1vZGUgc28gYSBodW1hbiAob3IgYW4gYWdlbnQpIHJlYWRzIGl0IHdpdGhvdXQgcGFyc2luZyBKU09OLlxuZnVuY3Rpb24gcmVuZGVyVHJpYWdlSHVtYW4oXG4gIG5hbWU6IHN0cmluZyxcbiAgb3BlbjogQmFkZ2VkTWVzc2FnZVtdLFxuICBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4sXG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lID0gKG06IEJhZGdlZE1lc3NhZ2UpID0+IHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG0udHMpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKTtcbiAgICBjb25zdCByZW9wZW4gPSBtLnJlb3BlbnMgJiYgbS5yZW9wZW5zID4gMCA/IGAg4oa7JHttLnJlb3BlbnN9YCA6IFwiXCI7XG4gICAgY29uc3QgaGVhZCA9IG0udGV4dC5zcGxpdChcIlxcblwiKVswXTtcbiAgICBjb25zdCBwcmV2aWV3ID0gaGVhZC5sZW5ndGggPiAxMDAgPyBgJHtoZWFkLnNsaWNlKDAsIDk5KX3igKZgIDogaGVhZDtcbiAgICByZXR1cm4gYCAgWyR7bS5pZH0ke3Jlb3Blbn1dICR7bS5mcm9tfSDCtyAke3RzfSDCtyAke3ByZXZpZXd9YDtcbiAgfTtcbiAgY29uc3Qgc2VjdGlvbnMgPSBbYCR7bmFtZX0gwrcgdHJpYWdlXFxuYCwgYE9QRU4gKCR7b3Blbi5sZW5ndGh9KWBdO1xuICBzZWN0aW9ucy5wdXNoKG9wZW4ubGVuZ3RoID8gb3Blbi5tYXAobGluZSkuam9pbihcIlxcblwiKSA6IFwiICDigJRcIik7XG4gIGZvciAoY29uc3QgW3N0YXR1cywgaXRlbXNdIG9mIE9iamVjdC5lbnRyaWVzKGJ5X3N0YXR1cykpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGBcXG4ke3N0YXR1cy50b1VwcGVyQ2FzZSgpfSAoJHtpdGVtcy5sZW5ndGh9KWAsIGl0ZW1zLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuICByZXR1cm4gYCR7c2VjdGlvbnMuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUcmlhZ2UobmFtZTogc3RyaW5nLCBvcHRzOiB7IGh1bWFuPzogYm9vbGVhbiB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRyaWFnZSA8Y2hhbm5lbD4gWy0taHVtYW5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIHRyaWFnZSByZWFkcyB0aGUgbG9nIGZpbGUsIG5vdCBhIHJvdXRlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24g4oCUIGFuZFxuICAvLyBhbiBlbXB0eSBkYXNoYm9hcmQgZm9yIGEgY2hhbm5lbCB0aGF0IGRvZXMgbm90IGV4aXN0IGlzIHRoZSBzYW1lIHNpbGVudCBsaWVcbiAgLy8gYXMgYW4gZW1wdHkgYHB1bGxgLlxuICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgY29uc3Qgb3BlbjogQmFkZ2VkTWVzc2FnZVtdID0gW107XG4gIGNvbnN0IGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPiA9IHt9O1xuICBmb3IgKGNvbnN0IG0gb2YgYmFkZ2VkKSB7XG4gICAgLy8gaXNPcGVuIGV4cGVjdHMgYSBkaXNwb3NpdGlvbiBlbnRyeSBvYmplY3QgKG9yIHVuZGVmaW5lZCBmb3Igbm8gZW50cnkpLlxuICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgaWYgKGlzT3BlbihkaXNwQXJnKSkge1xuICAgICAgLy8gVGhlIG9wZW4gcXVldWUgaXMgc2lnbmFsLW9ubHk6IHNraXAgbm9uLWFjdGlvbmFibGUgZnJhbWVzICh0b3BpYy9cbiAgICAgIC8vIGFubm91bmNlbWVudCBGWUlzIGNhbiBuZXZlciBjYXJyeSBhIGRpc3Bvc2l0aW9uLCBzbyB0aGV5J2Qgb3RoZXJ3aXNlXG4gICAgICAvLyBwYWQgXCJ3aGF0J3MgbGVmdD9cIiBmb3JldmVyKS5cbiAgICAgIGlmIChtLmtpbmQgPT09IFwibWVzc2FnZVwiKSBvcGVuLnB1c2gobSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGtleSA9IG0uZGlzcG9zaXRpb24gPz8gXCJ1bmtub3duXCI7XG4gICAgICBpZiAoIWJ5X3N0YXR1c1trZXldKSBieV9zdGF0dXNba2V5XSA9IFtdO1xuICAgICAgYnlfc3RhdHVzW2tleV0ucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgaWYgKG9wdHMuaHVtYW4pIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShyZW5kZXJUcmlhZ2VIdW1hbihuYW1lLCBvcGVuLCBieV9zdGF0dXMpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG9wZW4sIGJ5X3N0YXR1cyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kR3JlcChuYW1lOiBzdHJpbmcsIHBhdHRlcm46IHN0cmluZywgb3B0czogeyBsaXRlcmFsPzogYm9vbGVhbjsgZnJvbT86IHN0cmluZyB9KSB7XG4gIGlmICghbmFtZSB8fCAhcGF0dGVybilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGdyZXAgPGNoYW5uZWw+IDxwYXR0ZXJuPiBbLS1saXRlcmFsfC1GXSBbLS1mcm9tIDxhbGlhcz5dXCIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgbWF0Y2hlcjogKHRleHQ6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgaWYgKG9wdHMubGl0ZXJhbCkge1xuICAgIGNvbnN0IG5lZWRsZSA9IHBhdHRlcm4udG9Mb3dlckNhc2UoKTtcbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUpO1xuICB9IGVsc2Uge1xuICAgIGxldCByZTogUmVnRXhwO1xuICAgIHRyeSB7XG4gICAgICByZSA9IG5ldyBSZWdFeHAocGF0dGVybiwgXCJpXCIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRpZShgaW52YWxpZCByZWdleDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCk7XG4gICAgfVxuICAgIG1hdGNoZXIgPSAodGV4dCkgPT4gcmUudGVzdCh0ZXh0KTtcbiAgfVxuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgbWVzc2FnZXM6IHVua25vd25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmF3LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lKSBjb250aW51ZTtcbiAgICBsZXQgbXNnOiBQYXJ0aWFsPE1lc3NhZ2U+O1xuICAgIHRyeSB7XG4gICAgICBtc2cgPSBKU09OLnBhcnNlKGxpbmUpIGFzIFBhcnRpYWw8TWVzc2FnZT47XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBtc2cudGV4dCAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgaWYgKG9wdHMuZnJvbSAmJiBtc2cuZnJvbSAhPT0gb3B0cy5mcm9tKSBjb250aW51ZTtcbiAgICBpZiAoIW1hdGNoZXIobXNnLnRleHQpKSBjb250aW51ZTtcbiAgICBtZXNzYWdlcy5wdXNoKG1zZyk7XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShuYW1lOiBzdHJpbmcpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGNsb3NlIDxuYW1lPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkgZGllKFwibm8gZGFlbW9uIHJ1bm5pbmdcIik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KHBvcnQsIFwiREVMRVRFXCIsIGAvY2hhbm5lbHMvJHtuYW1lfWApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllKGRhdGE/LmVycm9yID8/IGBIVFRQICR7c3RhdHVzfWApO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVzZXQobmFtZTogc3RyaW5nLCBvcHRzOiB7IGZvcmNlPzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+ID0ge307XG4gIGlmIChvcHRzLmZvcmNlKSBib2R5LmZvcmNlID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBzdWJzY3JpYmVycz86IG51bWJlciB9PihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9yZXNldGAsXG4gICAgYm9keSxcbiAgKTtcbiAgaWYgKHN0YXR1cyA9PT0gNDA5ICYmIGRhdGE/LmVycm9yID09PSBcImxpdmVcIikge1xuICAgIGRpZShcbiAgICAgIGBjaGFubmVsIGhhcyAke2RhdGEuc3Vic2NyaWJlcnN9IGxpdmUgc3Vic2NyaWJlcihzKSDigJQgcmVmdXNpbmcgdG8gY2xlYXIgYSBsaXZlIHNlc3Npb24uIFJlLXJ1biB3aXRoIC0tZm9yY2UgdG8gY2xlYXIgYW55d2F5ICh0aGUgbG9nIGlzIHNuYXBzaG90dGVkIGZpcnN0KS5gLFxuICAgICk7XG4gIH1cbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZShkYXRhPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEFyY2hpdmUgKHJlYWQtb25seSkgb3IgdW5hcmNoaXZlIGEgY2hhbm5lbCAoVjEuNykg4oCUIHRoZSBub24tZGVzdHJ1Y3RpdmVcbi8vIGFsdGVybmF0aXZlIHRvIGNsb3NlOiBoaXN0b3J5IGlzIHByZXNlcnZlZCwgc2VuZHMgYXJlIHJlamVjdGVkLCBhbmQgdGhlIG5hbWVcbi8vIGlzIGxvY2tlZCBmcm9tIHJlLW9wZW4gdW50aWwgdW5hcmNoaXZlZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZE1hcmsoXG4gIG5hbWU6IHN0cmluZyxcbiAgaWQ6IG51bWJlcixcbiAgZGlzcG9zaXRpb246IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICBvcHRzOiB7IG5vdGU/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkgfHwgIWRpc3Bvc2l0aW9uKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgbWFyayA8Y2hhbm5lbD4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSBbLS1hcyA8YWxpYXM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgZnJvbSwgdGFyZ2V0OiBpZCwgZGlzcG9zaXRpb24gfTtcbiAgaWYgKG9wdHMubm90ZSAhPT0gdW5kZWZpbmVkKSBib2R5Lm5vdGUgPSBvcHRzLm5vdGU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZT4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9zdGF0dXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZSgoZGF0YSBhcyB7IGVycm9yPzogc3RyaW5nIH0pPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBcmNoaXZlKG5hbWU6IHN0cmluZywgdW5hcmNoaXZlOiBib29sZWFuLCBmcm9tPzogc3RyaW5nKSB7XG4gIGNvbnN0IHZlcmIgPSB1bmFyY2hpdmUgPyBcInVuYXJjaGl2ZVwiIDogXCJhcmNoaXZlXCI7XG4gIGlmICghbmFtZSkgZGllKGB1c2FnZTogZ3JhcGV2aW5lICR7dmVyYn0gPGNoYW5uZWw+YCk7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQm90aCByb3V0ZXMgYXBwZW5kIGEga2luZDpcInN0YXR1c1wiIGZyYW1lIHRvIHRoZSBsb2csIHNvIHdobyBkaWQgaXQgaXMgd29ydGhcbiAgLy8gcmVjb3JkaW5nIHdoZW4gdGhlIGNhbGxlciB0b2xkIHVzLiBJZGVudGl0eSBpcyBvcHRpb25hbCBoZXJlIChpdCBpcyBvbiB0aGVcbiAgLy8gZ2xvYmFsbHktYWNjZXB0ZWQgLS1hcy8tLWZyb20pLCBhbmQgdGhlIGRhZW1vbiBzaWducyBcInN5c3RlbVwiIHdpdGhvdXQgaXQuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJQT1NUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9LyR7dmVyYn1gLFxuICAgIGZyb20gPyB7IGZyb20gfSA6IHVuZGVmaW5lZCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZShkYXRhPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0b3Aob3B0czogeyBob2xkU2Vjb25kcz86IG51bWJlciB9ID0ge30pIHtcbiAgbGV0IGhlbGRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBpZiAob3B0cy5ob2xkU2Vjb25kcyAmJiBvcHRzLmhvbGRTZWNvbmRzID4gMCkge1xuICAgIGhlbGRVbnRpbCA9IERhdGUubm93KCkgKyBvcHRzLmhvbGRTZWNvbmRzICogMTAwMDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhIT0xEX0ZJTEUsIFN0cmluZyhoZWxkVW50aWwpKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGRhZW1vbjogZmFsc2UsXG4gICAgICAuLi4oaGVsZFVudGlsICE9PSB1bmRlZmluZWQgPyB7IGhlbGRfdW50aWw6IGhlbGRVbnRpbCB9IDoge30pLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wcGVkOiB0cnVlLFxuICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBQZXItY2hhbm5lbCBsaXZlLWNvbm5lY3Rpb24gc3VtbWFyeSDigJQgdGhlIHJlc3RhcnQtc2FmZXR5IHJlYWQuIE1pcnJvcnMgd2hhdFxuLy8gYGRvY3RvcmAgcmVwb3J0cyB1bmRlciBhY3RpdmVfc3Vic2NyaWJlcnM7IG9ubHkgcG9wdWxhdGVkIGNoYW5uZWxzIGFyZSBsaXN0ZWQuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKFxuICBwb3J0OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgdG90YWw6IG51bWJlcjsgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+IH0+IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgY29uc3QgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgZm9yIChjb25zdCBjaCBvZiBkYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgdG90YWwgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICBpZiAoY2guY29ubmVjdGlvbnMgPiAwKSBjaGFubmVscy5wdXNoKHsgbmFtZTogY2gubmFtZSwgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zIH0pO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnQg4oCUIGEgcHJlc2VuY2UgaGljY3VwIHNob3VsZG4ndCBjcmFzaCBhIGxpZmVjeWNsZSB2ZXJiXG4gIH1cbiAgcmV0dXJuIHsgdG90YWwsIGNoYW5uZWxzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXJ0KCkge1xuICAvLyBFbnN1cmUtcnVubmluZywgbm8gY2hhbm5lbCBzaWRlLWVmZmVjdC4gSWRlbXBvdGVudDogcmVwb3J0IGFuIGV4aXN0aW5nXG4gIC8vIGRhZW1vbiwgb3Igc3Bhd24gYSBmcmVzaCBvbmUuIFRoZSBleHBsaWNpdCBcImJyaW5nIGl0IHVwXCIgdmVyYiDigJQgZGlhZ25vc3RpY3NcbiAgLy8gKGRvY3Rvci9pbmZvL2xpc3QpIHN0YXkgcmVhZC1vbmx5IGFuZCBuZXZlciBzcGF3bi5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIWV4aXN0aW5nICYmIGhvbGRBY3RpdmUoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBoZWxkOiB0cnVlLCBwb3J0OiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwb3J0ID0gZXhpc3RpbmcgPz8gKGF3YWl0IGVuc3VyZURhZW1vbigpKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHBvcnQsIGFscmVhZHlfcnVubmluZzogZXhpc3RpbmcgIT09IG51bGwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc3RhcnQob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gTm90aGluZyB0byB0ZWFyIGRvd24g4oCUIGp1c3QgYnJpbmcgYSBmcmVzaCBkYWVtb24gdXAuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTQUZFVFk6IGEgcmVzdGFydCBmb3JjZXMgZXZlcnkgY29ubmVjdGVkIGNsaWVudCB0byBhdXRvLXJlY29ubmVjdC4gUmVmdXNlIHRvXG4gIC8vIHRlYXIgZG93biBhIHdvcmtpbmcgZmxlZXQgdW5sZXNzIGV4cGxpY2l0bHkgZm9yY2VkIOKAlCBuZXZlciBzaWxlbnRseSBkcm9wIGl0LlxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcmVzdGFydDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7Y2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIOKAlCAke3doZXJlfS4gYCArXG4gICAgICAgIFwiQSByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gYWxsIHRvIHJlY29ubmVjdC4gUmUtcnVuIHdpdGggLS1mb3JjZSAob3IgLS15ZXMpIHRvIHByb2NlZWQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FwdHVyZSB0aGUgcGlkIHdlJ3JlIHJlcGxhY2luZywgZm9yIHRoZSByZWNlaXB0LlxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgcHJldmlvdXNQaWQgPSBkYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wLCB0aGVuIHdhaXQgZm9yIHRoZSBvbGQgZGFlbW9uIHRvIGFjdHVhbGx5IGdvIGF3YXkg4oCUIGl0IHVubGlua3MgaXRzXG4gIC8vIHBvcnQvcGlkIGZpbGVzIG9uIHNodXRkb3duLCBzbyBlbnN1cmVEYWVtb24gc3Bhd25zIGZyZXNoIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRpc2NvdmVyaW5nIHRoZSBkeWluZyBvbmUuXG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCB9KTtcbn1cblxuLy8gYjMg4oCUIFRIRSBWRVJTSU9OIFZFUklGWSwgQVMgT05FIFNPVVJDRSBGT1IgQk9USCBQQVRIUy5cbi8vXG4vLyBgcm9sbGAgaXMgZG9jdW1lbnRlZCBhcyBcInRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcCDigKYgKyB2ZXJzaW9uIHZlcmlmeVwiLCBhbmRcbi8vIHRoZSB2ZXJpZnkgaGFkIHR3byB3YXlzIHRvIHNheSBub3RoaW5nOlxuLy9cbi8vICAgQ09MRCBQQVRIIOKAlCBubyBkYWVtb24gcnVubmluZzogaXQgc3Bhd25lZCBvbmUgYW5kIHByaW50ZWQgbmVpdGhlciBgdmVyc2lvbmBcbi8vICAgbm9yIGB2ZXJzaW9uX29rYC4gVGhlIGZpZWxkcyB3ZXJlIEFCU0VOVCwgc28gYSBjYWxsZXIgY2hlY2tpbmcgdGhlIHZlcmlmeVxuLy8gICBnb3QgYHVuZGVmaW5lZGAgb24gdGhlIGV4YWN0IHBhdGggd2hlcmUgdGhlIHZlcmlmeSBuZXZlciBoYXBwZW5lZC5cbi8vXG4vLyAgIFdBUk0gUEFUSCDigJQgdGhlIHByb2JlIHdhcyB3cmFwcGVkIGluIGBjYXRjaCB7fWAsIGxlYXZpbmcgYHZlcnNpb24gPSBudWxsYCxcbi8vICAgYW5kIGB2ZXJzaW9uX29rOiBudWxsID09PSBQTFVHSU5fVkVSU0lPTmAgZXZhbHVhdGVzIHRvIEZBTFNFLiBcIkkgY291bGQgbm90XG4vLyAgIGNoZWNrXCIgd2FzIHJlcG9ydGVkIGFzIFwidGhlIHZlcnNpb24gaXMgV1JPTkdcIiDigJQgYSBib29sZWFuIHRoYXQgY2Fubm90IHNheVxuLy8gICBcInVua25vd25cIiBpcyB0aGUgY2Fub25pY2FsIHNoYXBlIG9mIHRoaXMgc3ByaW50J3MgZGVmZWN0LCBhbmQgZmFsc2UgaXMgdGhlXG4vLyAgIHdvcnN0IGF2YWlsYWJsZSBhbnN3ZXIgYmVjYXVzZSBpdCBpcyBhY3Rpb25hYmxlIGFuZCBpbmNvcnJlY3QuXG4vL1xuLy8gU28gYHZlcnNpb25fb2tgIGlzIG5vdyBgYm9vbGVhbiB8IG51bGxgOiBudWxsIG1lYW5zIFVOQ0hFQ0tFRCwgbmV2ZXIgZmFsc2UuXG4vLyBgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uYCBpcyBwcmVzZW50LWFuZC1udWxsIGJlc2lkZSBpdCwgYmVjYXVzZSBhIGJhcmUgbnVsbFxuLy8gdGVsbHMgYSBjYWxsZXIgdGhlIGNoZWNrIGRpZCBub3QgaGFwcGVuIGFuZCBub3Qgd2h5LlxuLy9cbi8vIE9uZSBoZWxwZXIgcmF0aGVyIHRoYW4gdHdvIGNhbGwgc2l0ZXM6IGEgc2Vjb25kIGNvcHkgb2YgdGhpcyBsb2dpYyBvbiB0aGUgY29sZFxuLy8gcGF0aCBpcyB0aGUgbWlycm9yLWRyaWZ0IHRyYXAsIGFuZCB0aGUgY29sZCBwYXRoIGlzIHByZWNpc2VseSB0aGUgb25lIG5vYm9keVxuLy8gcmUtcmVhZHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVWZXJzaW9uKHBvcnQ6IG51bWJlcik6IFByb21pc2U8e1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB2ZXJzaW9uX29rOiBib29sZWFuIHwgbnVsbDtcbiAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBzdHJpbmcgfCBudWxsO1xufT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHYgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAodiA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBcInRoZSBkYWVtb24gYW5zd2VyZWQgYnV0IHJlcG9ydGVkIG5vIHZlcnNpb25cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IHZlcnNpb246IHYsIHZlcnNpb25fb2s6IHYgPT09IFBMVUdJTl9WRVJTSU9OLCB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IG51bGwgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogYGNvdWxkIG5vdCByZWFjaCB0aGUgZGFlbW9uIHRvIHZlcmlmeTogJHtcbiAgICAgICAgZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJvbGwob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gQ09MRCBQQVRIIOKAlCBub3RoaW5nIHdhcyBydW5uaW5nLCBzbyB0aGlzIGlzIGEgc3RhcnQgcmF0aGVyIHRoYW4gYSByb2xsLlxuICAgIC8vIEl0IHN0aWxsIHJlcG9ydHMgdGhlIHZlcmlmeSwgYmVjYXVzZSBcIm5vIGRhZW1vbiB3YXMgdXBcIiBpcyBub3QgYSByZWFzb24gdG9cbiAgICAvLyBzdGF5IHNpbGVudCBhYm91dCB3aGljaCB2ZXJzaW9uIGlzIG5vdyBzZXJ2aW5nLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgcm9sbGVkOiB0cnVlLFxuICAgICAgcHJldmlvdXNfcGlkOiBudWxsLFxuICAgICAgcG9ydDogZnJlc2gsXG4gICAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByb2xsOiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSDigJQgJHt3aGVyZX0uIFRoZXknbGwgYXV0by1yZWNvbm5lY3QgYWNyb3NzIHRoZSByb2xsLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIHByb2NlZWQuYCxcbiAgICApO1xuICB9XG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcHJldmlvdXNQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3Agd2l0aCBhIHNob3J0IGhvbGQgc28gYSBzdGFsZSBDTEkgY2FuJ3Qgd2luIHRoZSByZXNwYXduIHJhY2U7IHdlIGhvbGQgdGhlIHNwYXduIG91cnNlbHZlcy5cbiAgY29uc3QgaG9sZE1zID0gNDAwMDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKERhdGUubm93KCkgKyBob2xkTXMpKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgaWYgKChhd2FpdCByZWFkRGFlbW9uUG9ydCgpKSA9PT0gbnVsbCkgYnJlYWs7XG4gIH1cbiAgcmVsZWFzZUhvbGQoKTsgLy8gb3VyIHR1cm4gdG8gc3Bhd24gdGhlIG5ldyB2ZXJzaW9uXG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGxldCBwaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIHBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KGZyZXNoLCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgcm9sbGVkOiB0cnVlLFxuICAgIHByZXZpb3VzX3BpZDogcHJldmlvdXNQaWQsXG4gICAgcGlkLFxuICAgIHBvcnQ6IGZyZXNoLFxuICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhdGNoKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAvLyBDaGFubmVsIG5hbWUgaXMgb3B0aW9uYWwg4oCUIHRoZSBwYWdlIHJlYWRzIGl0IGZyb20gdGhlIFVSTCBoYXNoIGFuZFxuICAvLyBkZWZhdWx0cyB0byBcImxvYmJ5XCIgaWYgYWJzZW50LiBXZSBwYXNzIHRocm91Z2ggd2hhdGV2ZXIgdGhlIHVzZXIgZ2F2ZVxuICAvLyAob3IgXCJsb2JieVwiKSBhbmQgb3BlbiB0aGUgYnJvd3Nlci4gRGFlbW9uIGlzIGVuc3VyZWQgc28gdGhlIHNlcnZlZFxuICAvLyAvd2F0Y2ggSFRNTCBpcyByZWFjaGFibGUuXG4gIGNvbnN0IGNoYW5uZWwgPSBuYW1lPy50cmltKCkgPyBuYW1lLnRyaW0oKSA6IFwibG9iYnlcIjtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBFbnN1cmUgdGhlIGNoYW5uZWwgZXhpc3RzIHNvIHRoZSBwYWdlIHNlZXMgYSB2YWxpZCBiYWNrbG9nL3RvcGljLlxuICBhd2FpdCBhcGkocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZTogY2hhbm5lbCB9KTtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS93YXRjaCMke2VuY29kZVVSSUNvbXBvbmVudChjaGFubmVsKX1gO1xuICAvLyBPcGVuIHRoZSBicm93c2VyIHZpYSB0aGUgcGxhdGZvcm0ncyBkZWZhdWx0IG9wZW5lci4gQmVzdC1lZmZvcnQg4oCUXG4gIC8vIHByaW50IHRoZSBVUkwgc28gdGhlIHVzZXIgY2FuIGNsaWNrIGl0IGlmIGF1dG8tb3BlbiBmYWlscy5cbiAgY29uc3Qgb3BlbmVyID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcImV4cGxvcmVyXCIgOiBcInhkZy1vcGVuXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgcCA9IHNwYXduKG9wZW5lciwgW3VybF0sIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgfSk7XG4gICAgcC51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBvcGVuZXIgbWlzc2luZyDigJQganVzdCBwcmludCAqL1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsLCB1cmwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZERvY3RvcigpIHtcbiAgLy8gUmVhZC1vbmx5IGRpYWdub3N0aWMuIFJlcG9ydHMgdGhlIGF1dGhvcml0YXRpdmUgZGFlbW9uIChpZiBhbnkpLCBvdGhlclxuICAvLyBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3NlcyB2aXNpYmxlIG9uIHRoZSBtYWNoaW5lLCBjaGFubmVsIGZpbGVzIG9uXG4gIC8vIGRpc2ssIGFuZCBzdXJmYWNlcyBoaW50cy4gRG9lcyBOT1QgdGFrZSBkZXN0cnVjdGl2ZSBhY3Rpb24g4oCUIGNsZWFudXBcbiAgLy8gaXMgdGhlIG9wZXJhdG9yJ3MgY2FsbCwgd2l0aCBzdG9jayB1bml4IHRvb2xzLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgbGV0IGF1dGhvcml0YXRpdmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gIC8vIFBlci1jaGFubmVsIHN1YnNjcmliZXIgc3VtbWFyeSDigJQgYW5zd2VycyBcImlzIGl0IHNhZmUgdG8gcmVzdGFydCB0aGVcbiAgLy8gZGFlbW9uIHJpZ2h0IG5vdz9cIiB3aXRob3V0IG5lZWRpbmcgdG8gYWxzbyBydW4gYGxpc3RgIGFuZCByZWFkIHRoZVxuICAvLyBvdXRwdXQuIEVtcHR5IGlmIG5vIGRhZW1vbiBpcyBydW5uaW5nLlxuICBsZXQgdG90YWxTdWJzY3JpYmVycyA9IDA7XG4gIGNvbnN0IGJ1c3lDaGFubmVsczogQXJyYXk8e1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAgIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gICAgbmFtZWQ6IG51bWJlcjtcbiAgICBhbm9ueW1vdXM6IG51bWJlcjtcbiAgfT4gPSBbXTtcbiAgaWYgKHBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICAgIGF1dGhvcml0YXRpdmUgPSB7IHBvcnQsIC4uLmRhdGEgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGRhZW1vbiB3ZW50IGF3YXkgYmV0d2VlbiBwb3J0IGNoZWNrIGFuZCBhcGkgY2FsbFxuICAgIH1cbiAgICB0cnkge1xuICAgICAgLy8gL3ByZXNlbmNlIGdpdmVzIHRoZSBob25lc3QgcGVyLWNoYW5uZWwgYnJlYWtkb3duIChjb25uZWN0aW9ucyB2cyBuYW1lZFxuICAgICAgLy8gdnMgYW5vbnltb3VzKSDigJQgc28gdGhlIHJlc3RhcnQtc2FmZXR5IHRvdGFsIGlzbid0IGEgbXlzdGVyeSBhbmQgYW5cbiAgICAgIC8vIGFub255bW91cyB3YXRjaCB0YWIgcmVhZHMgYXMgYSB3YXRjaGVyLCBub3QgYSBnaG9zdC5cbiAgICAgIGNvbnN0IHsgZGF0YTogcHJlc0RhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgcHJlc0RhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICAgIHRvdGFsU3Vic2NyaWJlcnMgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICAgIGJ1c3lDaGFubmVscy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBjaC5uYW1lLFxuICAgICAgICAgIHN1YnNjcmliZXJzOiBjaC5jb25uZWN0aW9ucywgLy8gYmFjay1jb21wYXQ6IHByZXZpb3VzbHkgdGhlIHJhdyBjb3VudFxuICAgICAgICAgIGNvbm5lY3Rpb25zOiBjaC5jb25uZWN0aW9ucyxcbiAgICAgICAgICBuYW1lZDogY2gubmFtZWQsXG4gICAgICAgICAgYW5vbnltb3VzOiBjaC5hbm9ueW1vdXMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gYmVzdC1lZmZvcnRcbiAgICB9XG4gIH1cblxuICAvLyBFbnVtZXJhdGUgb3RoZXIgZGFlbW9uIHByb2Nlc3NlcyB2aWEgdGhlIHNoYXJlZCBjbGFzc2lmaWVyLiBFYWNoIGVudHJ5XG4gIC8vIGdhaW5zIHBvcnQvaG9tZS92ZXJzaW9uL3N0YXR1cy9yZWFwYWJsZSBzbyB0aGUgb3BlcmF0b3IgaGFzIHRoZSBmdWxsXG4gIC8vIHBpY3R1cmUgd2l0aG91dCBuZWVkaW5nIGEgc2VwYXJhdGUgYHJlYXAgLS1kcnktcnVuYC5cbiAgY29uc3Qgb3RoZXJEYWVtb25zOiBBcnJheTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGNsYXNzaWZ5RGFlbW9uPj4gJiB7IGNvbW1hbmQ/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3Qgc2VsZlBpZCA9IGF1dGhvcml0YXRpdmU/LnBpZCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBwaWQgb2YgYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKSkge1xuICAgICAgaWYgKHNlbGZQaWQgJiYgcGlkID09PSBzZWxmUGlkKSBjb250aW51ZTtcbiAgICAgIG90aGVyRGFlbW9ucy5wdXNoKGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCkpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IGNhcnJ5IG9uIHdpdGggZW1wdHkgbGlzdFxuICB9XG5cbiAgLy8gQ2hhbm5lbHMgb24gZGlzayB1bmRlciB0aGlzIEhPTUUuXG4gIGNvbnN0IGNoYW5uZWxzT25EaXNrOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGNoYW5uZWxzRGlyID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZiBvZiByZWFkZGlyU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgICAgaWYgKGYuZW5kc1dpdGgoXCIuanNvbmxcIikpIGNoYW5uZWxzT25EaXNrLnB1c2goZi5yZXBsYWNlKC9cXC5qc29ubCQvLCBcIlwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHt9XG5cbiAgLy8gSGludHMg4oCUIHN1cmZhY2UgdGhlIG1vc3QgYWN0aW9uYWJsZSBzaWduYWxzLlxuICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIFwiTm8gYXV0aG9yaXRhdGl2ZSBkYWVtb24gcnVubmluZyBmb3IgdGhpcyBIT01FLiBSdW4gYW55IHZlcmIgKGUuZy4gYGNsaS50cyBsaXN0YCkgdG8gc3Bhd24gb25lLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG90aGVyRGFlbW9ucy5sZW5ndGggPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBGb3VuZCAke290aGVyRGFlbW9ucy5sZW5ndGh9IG90aGVyIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzcyhlcykgb24gdGhpcyBtYWNoaW5lLiBgICtcbiAgICAgICAgXCJUaGV5IG1heSBiZSB6b21iaWVzIGZyb20gcGFzdCBydW5zIE9SIGRhZW1vbnMgc2VydmluZyBvdGhlciBIT01FcyAoZGlmZmVyZW50IEdSQVBFVklORV9IT01FKS5cIixcbiAgICApO1xuICAgIGNvbnN0IHJlYXBhYmxlQ291bnQgPSBvdGhlckRhZW1vbnMuZmlsdGVyKChkKSA9PiBkLnJlYXBhYmxlKS5sZW5ndGg7XG4gICAgaWYgKHJlYXBhYmxlQ291bnQgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgRm91bmQgJHtyZWFwYWJsZUNvdW50fSByZWFwYWJsZSBvcnBoYW4gZGFlbW9uKHMpLiBSdW4gXFxgZ3JhcGV2aW5lIHJlYXBcXGAgdG8gY2xlYXIgdGhlbSBzYWZlbHkuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvdGhlckRhZW1vbnMuc29tZSgoZCkgPT4gZC5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIpKSB7XG4gICAgICBoaW50cy5wdXNoKFwiU29tZSBkYWVtb25zIGFyZSB1bnJlc3BvbnNpdmU7IGBncmFwZXZpbmUgcmVhcCAtLWZvcmNlYCBpbmNsdWRlcyB0aGVtLlwiKTtcbiAgICB9XG4gIH1cbiAgaWYgKFxuICAgIGF1dGhvcml0YXRpdmUgJiZcbiAgICBQTFVHSU5fVkVSU0lPTiAmJlxuICAgIHR5cGVvZiBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IFwic3RyaW5nXCIgJiZcbiAgICBhdXRob3JpdGF0aXZlLnZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OXG4gICkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgQXV0aG9yaXRhdGl2ZSBkYWVtb24gdmVyc2lvbiAoJHthdXRob3JpdGF0aXZlLnZlcnNpb259KSBkaWZmZXJzIGZyb20gdGhpcyBDTEkncyB2ZXJzaW9uICgke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICBcIlJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbiDigJQgZHJvcCBhY3RpdmUgdGFpbHMsIHRoZW4gYHN0b3BgLCB0aGVuIGFueSB2ZXJiLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGF1dGhvcml0YXRpdmUgJiYgKGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gbnVsbCB8fCBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IHVuZGVmaW5lZCkpIHtcbiAgICBoaW50cy5wdXNoKFwiQXV0aG9yaXRhdGl2ZSBkYWVtb24gcHJlZGF0ZXMgdmVyc2lvbiByZXBvcnRpbmcgKHByZS1WMS42LjIpLiBSZXN0YXJ0IHRvIGFsaWduLlwiKTtcbiAgfVxuICBpZiAodG90YWxTdWJzY3JpYmVycyA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYCR7dG90YWxTdWJzY3JpYmVyc30gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7YnVzeUNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKS4gYCArXG4gICAgICAgIFwiRGFlbW9uIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSB0byBhdXRvLXJlY29ubmVjdCAod29ya3MsIGJ1dCBkaXNydXB0aXZlKSDigJQgY29vcmRpbmF0ZSBmaXJzdC5cIixcbiAgICApO1xuICB9IGVsc2UgaWYgKGF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFwiTm8gYWN0aXZlIHN1YnNjcmliZXJzIOKAlCBkYWVtb24gcmVzdGFydCBpcyBub24tZGlzcnVwdGl2ZS5cIik7XG4gIH1cbiAgLy8gRXhwbGFpbiBhbnkgY2hhbm5lbCB3aGVyZSB0aGUgY29ubmVjdGlvbiBjb3VudCBleGNlZWRzIG5hbWVkIGFnZW50cyDigJQgYW5cbiAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiBpbmZsYXRlcyBgY291bnRgL2Bjb25uZWN0aW9uc2AgYnV0IGlzbid0IGEgZ2hvc3QuXG4gIGZvciAoY29uc3QgY2ggb2YgYnVzeUNoYW5uZWxzKSB7XG4gICAgaWYgKGNoLmFub255bW91cyA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2NoLm5hbWV9OiAke2NoLmNvbm5lY3Rpb25zfSBjb25uZWN0aW9uKHMpLCAke2NoLm5hbWVkfSBuYW1lZCBhZ2VudChzKSArIGAgK1xuICAgICAgICAgIGAke2NoLmFub255bW91c30gYW5vbnltb3VzIChlLmcuIGEgd2F0Y2ggdGFiKS4gVGhlIGNvdW50IG92ZXIgdGhlIG5hbWUgbGlzdCBpcyBleHBlY3RlZCwgbm90IGEgZ2hvc3QuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBob21lOiBEQVRBX0RJUixcbiAgICBjbGlfdmVyc2lvbjogUExVR0lOX1ZFUlNJT04sXG4gICAgYXV0aG9yaXRhdGl2ZSxcbiAgICBhY3RpdmVfc3Vic2NyaWJlcnM6IHtcbiAgICAgIHRvdGFsOiB0b3RhbFN1YnNjcmliZXJzLFxuICAgICAgYnVzeV9jaGFubmVsczogYnVzeUNoYW5uZWxzLFxuICAgIH0sXG4gICAgb3RoZXJfZGFlbW9uc19vbl9tYWNoaW5lOiBvdGhlckRhZW1vbnMsXG4gICAgY2hhbm5lbHNfb25fZGlzazogY2hhbm5lbHNPbkRpc2ssXG4gICAgaGludHMsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRJbmZvKCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gZW51bWVyYXRpb24gKyBjbGFzc2lmaWVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogQWxsIGdyYXBldmluZSBkYWVtb24udHMgcGlkcyB2aXNpYmxlIG9uIHRoaXMgbWFjaGluZSAodmlhIGBwc2ApLiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuICBjb25zdCBwaWRzOiBudW1iZXJbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcInBzXCIsIFtcIi1lb1wiLCBcInBpZCxjb21tYW5kXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY29uc3Qgb3V0ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmLThcIik7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKFwiZGFlbW9uLnRzXCIpKSBjb250aW51ZTtcbiAgICAgIGlmICghbGluZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZ3JhcGV2aW5lXCIpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IG0gPSBsaW5lLm1hdGNoKC9eXFxzKihcXGQrKVxccysvKTtcbiAgICAgIGlmICghbSkgY29udGludWU7XG4gICAgICBjb25zdCBwaWQgPSBwYXJzZUludChtWzFdLCAxMCk7XG4gICAgICBpZiAocGlkKSBwaWRzLnB1c2gocGlkKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIHBzIHVuYXZhaWxhYmxlOyByZXR1cm4gZW1wdHlcbiAgfVxuICByZXR1cm4gcGlkcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gbHNvZkxpc3RlblBvcnQocGlkOiBudW1iZXIpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9jID0gc3Bhd24oXCJsc29mXCIsIFtcIi1haVRDUFwiLCBcIi1zVENQOkxJU1RFTlwiLCBcIi1wXCIsIFN0cmluZyhwaWQpLCBcIi1QXCIsIFwiLW5cIl0sIHtcbiAgICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJwaXBlXCIsIFwiaWdub3JlXCJdLFxuICAgIH0pO1xuICAgIGNvbnN0IGNodW5rczogQnVmZmVyW10gPSBbXTtcbiAgICBwcm9jLnN0ZG91dD8ub24oXCJkYXRhXCIsIChiKSA9PiBjaHVua3MucHVzaChiIGFzIEJ1ZmZlcikpO1xuICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyKSA9PiBwcm9jLm9uKFwiZXhpdFwiLCAoKSA9PiByKCkpKTtcbiAgICBjb25zdCBtID0gQnVmZmVyLmNvbmNhdChjaHVua3MpXG4gICAgICAudG9TdHJpbmcoXCJ1dGYtOFwiKVxuICAgICAgLm1hdGNoKC8xMjdcXC4wXFwuMFxcLjE6KFxcZCspLyk7XG4gICAgcmV0dXJuIG0gPyBwYXJzZUludChtWzFdLCAxMCkgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5leHBvcnQgdHlwZSBEYWVtb25TdGF0dXMgPSBcImF1dGhvcml0YXRpdmVcIiB8IFwib3JwaGFuXCIgfCBcInVucmVzcG9uc2l2ZVwiIHwgXCJ1bmtub3duXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGFzc2lmeURhZW1vbihwaWQ6IG51bWJlcik6IFByb21pc2U8e1xuICBwaWQ6IG51bWJlcjtcbiAgcG9ydDogbnVtYmVyIHwgbnVsbDtcbiAgaG9tZT86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIHN0YXR1czogRGFlbW9uU3RhdHVzO1xuICByZWFwYWJsZTogYm9vbGVhbjtcbn0+IHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGxzb2ZMaXN0ZW5Qb3J0KHBpZCk7XG4gIGlmICghcG9ydCkgcmV0dXJuIHsgcGlkLCBwb3J0OiBudWxsLCBzdGF0dXM6IFwidW5rbm93blwiLCByZWFwYWJsZTogZmFsc2UgfTtcbiAgbGV0IGluZm86IFJvb3RJbmZvIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9gLCB7XG4gICAgICBzaWduYWw6IEFib3J0U2lnbmFsLnRpbWVvdXQoODAwKSxcbiAgICB9KTtcbiAgICBpZiAocmVzLm9rKSBpbmZvID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJvb3RJbmZvO1xuICB9IGNhdGNoIHt9XG4gIGlmICghaW5mbykgcmV0dXJuIHsgcGlkLCBwb3J0LCBzdGF0dXM6IFwidW5yZXNwb25zaXZlXCIsIHJlYXBhYmxlOiBmYWxzZSB9OyAvLyByZWFwIG9ubHkgd2l0aCAtLWZvcmNlIChoYW5kbGVkIGluIGNtZFJlYXApXG4gIGNvbnN0IGhvbWUgPSBpbmZvLmRhdGFfZGlyIGFzIHN0cmluZztcbiAgbGV0IG93bnMgPSBmYWxzZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBvcCA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBvcnRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIGNvbnN0IG9pID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucGlkXCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBvd25zID0gb3AgPT09IFN0cmluZyhwb3J0KSAmJiBvaSA9PT0gU3RyaW5nKHBpZCk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG93bnNcbiAgICA/IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcImF1dGhvcml0YXRpdmVcIixcbiAgICAgICAgcmVhcGFibGU6IGZhbHNlLFxuICAgICAgfVxuICAgIDoge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwib3JwaGFuXCIsXG4gICAgICAgIHJlYXBhYmxlOiB0cnVlLFxuICAgICAgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmVhcChvcHRzOiB7IGZvcmNlPzogYm9vbGVhbjsgZHJ5UnVuPzogYm9vbGVhbiB9KSB7XG4gIGNvbnN0IHNlbGZQb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTsgLy8gY3VycmVudCBIT01FIGF1dGhvcml0YXRpdmUgKG5ldmVyIHJlYXApXG4gIGxldCBzZWxmUGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgaWYgKHNlbGZQb3J0KSB7XG4gICAgdHJ5IHtcbiAgICAgIHNlbGZQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihzZWxmUG9ydCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcGlkcyA9IGF3YWl0IGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCk7XG4gIGNvbnN0IGtlcHQ6IHVua25vd25bXSA9IFtdLFxuICAgIHJlYXBlZDogdW5rbm93bltdID0gW10sXG4gICAgc2tpcHBlZDogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgcGlkIG9mIHBpZHMpIHtcbiAgICBjb25zdCBjID0gYXdhaXQgY2xhc3NpZnlEYWVtb24ocGlkKTtcbiAgICBjb25zdCBpc1NlbGYgPSBwaWQgPT09IHNlbGZQaWQ7XG4gICAgY29uc3Qgc2hvdWxkUmVhcCA9XG4gICAgICAhaXNTZWxmICYmIChjLnJlYXBhYmxlIHx8IChjLnN0YXR1cyA9PT0gXCJ1bnJlc3BvbnNpdmVcIiAmJiBvcHRzLmZvcmNlID09PSB0cnVlKSk7XG4gICAgaWYgKCFzaG91bGRSZWFwKSB7XG4gICAgICBrZXB0LnB1c2goYyk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG9wdHMuZHJ5UnVuKSB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImRyeS1ydW5cIiB9KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgcHJvY2Vzcy5raWxsKHBpZCwgXCJTSUdURVJNXCIpO1xuICAgICAgcmVhcGVkLnB1c2goYyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBza2lwcGVkLnB1c2goeyAuLi5jLCBub3RlOiBcImtpbGwgZmFpbGVkXCIgfSk7XG4gICAgfVxuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkcnlfcnVuOiAhIW9wdHMuZHJ5UnVuLCBrZXB0LCByZWFwZWQsIHNraXBwZWQgfSk7XG59XG5cbi8vIChCT09MRUFOX0ZMQUdTIHdhcyBoZXJlLiBJdCBsaXN0ZWQgd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZSDigJQgaGFsZiBhXG4vLyByZWdpc3RyeSwgY29uc3VsdGVkIGJ5IHRoZSBoYW5kLXJvbGxlZCBwYXJzZXIuIEl0cyAxMyBlbnRyaWVzIG5vdyBsaXZlIGluXG4vLyBDTElfT1BUSU9OUyBiZWxvdyBhcyBge3R5cGU6XCJib29sZWFuXCJ9YCwgdmVyaWZpZWQgMTMtZm9yLTEzIGFnYWluc3QgdGhvdGgnc1xuLy8gaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0IGJlZm9yZSB0aGUgbW92ZS4gRGVsZXRlZCByYXRoZXIgdGhhbiBsZWZ0XG4vLyBiZXNpZGUgaXRzIHJlcGxhY2VtZW50OiBhIHNlY29uZCBzb3VyY2Ugb2YgdHJ1dGggZm9yIHRoZSBzYW1lIGZhY3QgaXMgdGhlXG4vLyBkcmlmdCBidWcgdGhpcyBsYW5lIGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCB3b3VsZCBubyBsb25nZXIgYmUgY29uc3VsdGVkXG4vLyBieSBhbnl0aGluZy4pXG5cbi8vIFNpZ25hdHVyZSBvZiBhIGhlcmVkb2MgZnVtYmxlOiBhIGxpbmUgdGhhdCBpcyAob3IgYmVnaW5zIHdpdGgpIGFcbi8vIGBidW4g4oCmIGNsaS50cyDigKYgc2VuZGAgaW52b2NhdGlvbi4gV2hlbiBhIGBzZW5kIC0tc3RkaW4gPDxFT0ZgIGlzIGJvdGNoZWQsIHRoZVxuLy8gc2hlbGwgcGlwZXMgdGhlIGxpdGVyYWwgY29tbWFuZCBsaW5lIGluIGFzIHRoZSBib2R5LCB3aGljaCB0aGVuIGdldHMgcG9zdGVkIOKAlFxuLy8gY29ycnVwdGluZyB0aGUgY2hhbm5lbCB3aXRoIGBidW4gL+KApi9jbGkudHMgc2VuZCA8Y2hhbm5lbD4gLS1hcyDigKYgPHRleHQ+YC5cbi8vIFdlIHJlZnVzZSB0byBwb3N0IHN1Y2ggYSBib2R5IHVubGVzcyAtLWZvcmNlIGlzIHBhc3NlZC5cbmNvbnN0IExFQUtFRF9TRU5EX1JFID0gLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxiKD86c2VuZHxhbm5vdW5jZSlcXGIvO1xuZnVuY3Rpb24gbG9va3NMaWtlTGVha2VkU2VuZCh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIExFQUtFRF9TRU5EX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vIFNoZWxsLW1ldGFjaGFyYWN0ZXIgZm9vdGd1biAoIzYwKTogYSBib2R5IHBhc3NlZCBhcyBhbiBJTkxJTkUgcG9zaXRpb25hbCBhcmdcbi8vIGlzIGV4cG9zZWQgdG8gdGhlIGNhbGxlcidzIHNoZWxsLCB3aGljaCBjb21tYW5kLXN1YnN0aXR1dGVzIGJhY2t0aWNrcyAvXG4vLyBgJCguLi4pYCAvIGAkey4uLn1gIEJFRk9SRSBncmFwZXZpbmUgc2VlcyBpdCDigJQgY29ycnVwdGluZyBvciBwYXJ0aWFsbHlcbi8vIGV4ZWN1dGluZyBjb2RlLWJlYXJpbmcgbWVzc2FnZXMuIFRoZSBDTEkgY2FuJ3QgdW4tc3Vic3RpdHV0ZSB3aGF0IHRoZSBzaGVsbFxuLy8gYWxyZWFkeSBhdGU7IHRoZSBob25lc3QgZml4IGlzIHRvIHN0ZWVyIGNhbGxlcnMgdG8gdGhlIHNoZWxsLWZyZWUgcGF0aHNcbi8vICgtLWJvZHktZmlsZSAvIC0tc3RkaW4gLyBkZWZhdWx0LXN0ZGluKS4gV2hlbiBtZXRhY2hhcmFjdGVycyBTVVJWSVZFIGludG8gYW5cbi8vIGlubGluZSBib2R5IChlLmcuIHRoZSBjYWxsZXIgaGFwcGVuZWQgdG8gc2luZ2xlLXF1b3RlKSwgdGhleSdyZSBpbnRhY3QgdGhpc1xuLy8gdGltZSDigJQgYnV0IHRoZSBwYXR0ZXJuIGlzIGEgbGF0ZW50IGZvb3RndW4sIHNvIHdlIHdhcm4gKG5ldmVyIGJsb2NrOiB0aGVcbi8vIG1lc3NhZ2UgaXMgZmluZSBhcyByZWNlaXZlZCkuIEFic2VudC1tZXRhY2hhciBpbmxpbmUgYm9kaWVzIGFyZSBlaXRoZXIgcGxhaW5cbi8vIHRleHQgKHNhZmUpIG9yIGFscmVhZHktc3Vic3RpdHV0ZWQgKHVuZGV0ZWN0YWJsZSkg4oCUIHNvIHdlIG9ubHkgd2FybiBvbiB0aGVcbi8vIGRldGVjdGFibGUgcmlza3kgcGF0dGVybi5cbmNvbnN0IFNIRUxMX01FVEFDSEFSX1JFID0gL2B8XFwkXFwofFxcJFxcey87XG5leHBvcnQgZnVuY3Rpb24gbG9va3NTaGVsbFJpc2t5KHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gU0hFTExfTUVUQUNIQVJfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIGdyYXBldmluZSBhbHJlYWR5IGhhZCBIQUxGIGEgcmVnaXN0cnk6IGBCT09MRUFOX0ZMQUdTYCBhYm92ZSB0b2xkIHRoZSBwYXJzZXJcbi8vIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUuIFdoYXQgaXQgaGFkIG5vIG5vdGlvbiBvZiB3YXMgd2hpY2ggZmxhZ3MgRVhJU1QsIHNvXG4vLyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2Vcbi8vIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXMgc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC5cbi8vXG4vLyDimqAgZ3JhcGV2aW5lIGlzIHRoZSBPVVRMSUVSIG9mIHRoZSBzaXgsIGFuZCBpdCBpcyB3b3J0aCBzYXlpbmcgd2h5IHNvIG5vYm9keVxuLy8gcmVhZHMgaXQgYXMgbWVyZWx5IGJlaGluZDogaXQgdHlwZXMgaXRzIHZhbHVlIGZsYWdzIHdpdGggYSBDQVNUXG4vLyAoYGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZGApIHdoZXJlIHRoZSBvdGhlciBlbnRyeSBwb2ludHMgdXNlIGFcbi8vIGB0eXBlb2ZgIGd1YXJkLiBBIGNhc3QgaXMgYSBjbGFpbSB3aXRoIE5PIFJVTlRJTUUgQ0hFQ0ssIHNvIGdyYXBldmluZSBjYXJyaWVkXG4vLyBhIGNsYXNzIG9mIGxhdGVudCB0eXBlLWxpZSB0aGUgb3RoZXJzIHdlcmUgZ3VhcmRlZCBhZ2FpbnN0IOKAlCBhbmQgYmFyZSB2YWx1ZVxuLy8gZmxhZ3MgcHJvZHVjZWQgc2lsZW50IHdyb25nIHZhbHVlcyByYXRoZXIgdGhhbiBlcnJvcnM6XG4vL1xuLy8gICAtLWxhc3QgICBiYXJlICAtPiAgcGFyc2VJbnQodHJ1ZSwgMTApICAtPiAgTmFOLCBzaWxlbnRseVxuLy8gICAtLXRvcGljICBiYXJlICAtPiAgYHRydWVgIGluIGEgZmllbGQgREVDTEFSRUQgYHN0cmluZ2Bcbi8vXG4vLyBgc3RyaWN0OiB0cnVlYCB0dXJucyBlYWNoIG9mIHRob3NlIGZyb20gYSBzaWxlbnQgd3JvbmcgdmFsdWUgaW50byBhXG4vLyBjYWxsZXItZmFjaW5nIGVycm9yLCB3aGljaCBpcyB0aGUgbGFuZSdzIHdob2xlIHB1cnBvc2UgYW5kIHRoZSBsYXJnZXN0XG4vLyBiZWhhdmlvdXIgZGVsdGEgb2YgdGhlIHNpeCBlbnRyeSBwb2ludHMuXG4vL1xuLy8gVGhlIGJvb2xlYW4gc2V0IGJlbG93IGlzIEJPT0xFQU5fRkxBR1MsIHVuY2hhbmdlZCDigJQgZXh0cmFjdGVkIGZyb20gdGhpcyBmaWxlXG4vLyBhbmQgZGlmZmVkIGFnYWluc3QgdGhvdGgncyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3Q6IDEzIGZvciAxMywgZXhhY3QsXG4vLyB6ZXJvIGRpdmVyZ2VuY2UgaW4gZWl0aGVyIGRpcmVjdGlvbi5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBhczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjaGFubmVsczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBob2xkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJpbi1yZXBseS10b1wiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFzdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1heDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5vdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0b3BpYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGFsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImRyeS1ydW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmb3JjZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBmcmVzaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcImZyb20tc3RhcnRcIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW1hbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsaXRlcmFsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGx1cms6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVpZXQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGV4dDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB2ZXJib3NlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHllczogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxufSBhcyBjb25zdDtcblxuY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbnR5cGUgRmxhZ05hbWUgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG5cbi8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgR0xPQkFMOiBTS0lMTC5tZCB0ZWxscyBhZ2VudHMgdG8gcGFzcyAtLWFzLy0tZnJvbVxuLy8gb24gRVZFUlkgdmVyYiAoYSBmcmVzaCBzaGVsbCBwZXIgY29tbWFuZCBtZWFucyBHUkFQRVZJTkVfRlJPTSBuZXZlclxuLy8gcGVyc2lzdHMpLCBzbyBldmVyeSBjb21tYW5kIGFjY2VwdHMgYm90aCDigJQgZXZlbiB3aGVyZSBhIHZlcmIgaGFzIG5vIHVzZSBmb3Jcbi8vIGlkZW50aXR5LCBhIGNhbGxlciBmb2xsb3dpbmcgb3VyIG93biBkb2NzIG11c3Qgbm90IGJlIHJlamVjdGVkIGZvciBvYmV5aW5nXG4vLyB0aGVtLiBPbiBgZ3JlcGAsIGAtLWZyb21gIGlzIGFuIGF1dGhvciBGSUxURVIgcmF0aGVyIHRoYW4gaWRlbnRpdHk6IGRpZmZlcmVudFxuLy8gc2VtYW50aWNzLCBzYW1lIGFjY2VwdGFuY2UuXG5jb25zdCBHTE9CQUxfRkxBR1M6IEZsYWdOYW1lW10gPSBbXCJhc1wiLCBcImZyb21cIl07XG5cbnR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG4vLyBUSEUgQ09NTUFORCBUQUJMRSwgQVMgQSBTVFJVQ1RVUkUg4oCUIHRoZSBwYXJzZXIsIHRoZSBkaXNwYXRjaGVyLCB0aGUgc2NoZW1hXG4vLyBlbWl0dGVyIGFuZCB0aGUgcm9vdCByZWplY3Rpb24gYWxsIHdhbGsgVEhJUy4gSXQgcmVwbGFjZWQgYSBiYXJlIGBzd2l0Y2hgLFxuLy8gd2hpY2ggb25seSB0aGUgZGlzcGF0Y2hlciBjb3VsZCB3YWxrOiBhIHNjaGVtYSBlbWl0dGVkIGZyb20gYW55dGhpbmcgb3RoZXJcbi8vIHRoYW4gdGhlIHN0cnVjdHVyZSB0aGF0IHJvdXRlcyB0aGUgYmVoYXZpb3VyIGlzIGEgZG9jdW1lbnQgdGhhdCBsaWVzIGFzIHNvb25cbi8vIGFzIGFueW9uZSBlZGl0cyB0aGUgb3RoZXIgc2lkZSAoYWNjIFNUQU5EQVJELm1kIFBhcnQgMSDCpzI7IG91ciBvd24gIzgxL0Q0XG4vLyBsYW5lIGxlYXJuZWQgdGhlIHNhbWUgbGVzc29uIG9uZSBhbHRpdHVkZSBkb3duIHdpdGggQk9PTEVBTl9GTEFHUykuXG4vL1xuLy8gYGZsYWdzYCBpcyB0aGUgdmVyYidzIE9XTiBhY2NlcHRlZCBzZXQgKEdMT0JBTF9GTEFHUyBhcmUgbWVyZ2VkIGluIGJ5XG4vLyBgYWNjZXB0ZWRGbGFnc2ApLiBBIGZsYWcgbm90IGxpc3RlZCBoZXJlIGlzIFJFSkVDVEVEIGZvciB0aGlzIHZlcmIgd2l0aCB0aGVcbi8vIHZlcmIncyBvd24gc2V0IGVudW1lcmF0ZWQg4oCUIGFjY2VwdGVkLWFuZC1pZ25vcmVkIGlzIHRoZSBkaXNlYXNlIHRoaXMgdGFibGVcbi8vIGV4aXN0cyB0byBjdXJlIChhY2MgRFQtMTogYW50aGlsbCBhY2NlcHRpbmcgYSByb290IGAtLWZvcm1hdGAgaXQgc2lsZW50bHlcbi8vIGRpc2NhcmRzOyBncmFwZXZpbmUgYWNjZXB0aW5nIGBzZW5kIC0tZHJ5LXJ1bmAgYW5kIGRvaW5nIG5vdGhpbmcgd2FzIHRoZVxuLy8gc2FtZSBldmVudCB3aXRoIGEgZGlmZmVyZW50IHNwZWxsaW5nKS5cbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlcz86IHN0cmluZ1tdO1xuICBmbGFnczogRmxhZ05hbWVbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIHJ1bjogKHBvc2l0aW9uYWw6IHN0cmluZ1tdLCBmbGFnczogRmxhZ3MpID0+IFByb21pc2U8dm9pZD4gfCB2b2lkO1xufTtcblxuLy8gQSBkZWNsYXJlZCB2YWx1ZSBmbGFnIHRoYXQgY2FycmllcyBhIG51bWJlciBtdXN0IFJFSkVDVCBhIG5vbi1udW1iZXIgYXMgYVxuLy8gdXNhZ2UgZXJyb3IgKGV4aXQgMiksIG5vdCBjcmFzaCBvbiBpdCBkb3duc3RyZWFtIOKAlCBgc2NoZW1hYCBwdWJsaXNoZXMgdGhlXG4vLyBmbGFnIGFzIHZhbGlkLCBzbyB0aGUgcGFyc2UgYm91bmRhcnkgaXMgd2hlcmUgYSBiYWQgdmFsdWUgZ2V0cyBpdHNcbi8vIGNhbGxlci1mYWNpbmcgYW5zd2VyLiAoYHdhaXQgLS10aW1lb3V0IG5vdGFudW1iZXJgIHVzZWQgdG8gdGhyb3cgYW5cbi8vIHVuaGFuZGxlZCBSYW5nZUVycm9yIGF0IGV4aXQgMSwgc3RhY2sgdHJhY2UgYW5kIGFsbC4pXG5mdW5jdGlvbiBudW1lcmljRmxhZyh2ZXJiOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmF3OiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8IDApXG4gICAgZGllKGAke3ZlcmJ9OiAtLSR7bmFtZX0gZXhwZWN0cyBhIG5vbi1uZWdhdGl2ZSBudW1iZXIsIGdvdCAke0pTT04uc3RyaW5naWZ5KFN0cmluZyhyYXcpKX1gKTtcbiAgcmV0dXJuIG47XG59XG5cbi8vIEJvZHkgcmVzb2x1dGlvbiBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZSDigJQgZmlyc3QgbWF0Y2ggd2luczogLS1ib2R5LWZpbGUsXG4vLyAtLXN0ZGluLCBpbmxpbmUgcG9zaXRpb25hbHMsIGRlZmF1bHQtc3RkaW4gd2hlbiBwaXBlZC4gU2VlIHRoZSBwZXItdmVyYlxuLy8gY29tbWVudHMgYXQgdGhlIG9yaWdpbmFsIHNpdGVzIChWMS42LyM2MCk7IGJlaGF2aW91ciB1bmNoYW5nZWQuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQm9keShcbiAgdmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsXG4gIGlubGluZTogc3RyaW5nW10sXG4gIGZsYWdzOiBGbGFncyxcbik6IFByb21pc2U8eyB0ZXh0OiBzdHJpbmc7IGZyb21JbmxpbmU6IGJvb2xlYW4gfT4ge1xuICBpZiAoZmxhZ3NbXCJib2R5LWZpbGVcIl0pIHtcbiAgICBjb25zdCBwYXRoID0gZmxhZ3NbXCJib2R5LWZpbGVcIl0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gKTtcbiAgICByZXR1cm4geyB0ZXh0OiAoYXdhaXQgZmlsZS50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSwgZnJvbUlubGluZTogZmFsc2UgfTtcbiAgfVxuICBpZiAoZmxhZ3Muc3RkaW4gfHwgKGlubGluZS5sZW5ndGggPT09IDAgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpKSB7XG4gICAgY29uc3QgYnVmOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcHJvY2Vzcy5zdGRpbikgYnVmLnB1c2goY2h1bmsgYXMgQnVmZmVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGV4dDogQnVmZmVyLmNvbmNhdChidWYpLnRvU3RyaW5nKFwidXRmLThcIikucmVwbGFjZSgvXFxuJC8sIFwiXCIpLFxuICAgICAgZnJvbUlubGluZTogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyB0ZXh0OiBpbmxpbmUuam9pbihcIiBcIiksIGZyb21JbmxpbmU6IHRydWUgfTtcbn1cblxuLy8gVGhlIHR3byBib2R5IGd1YXJkcyBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZTogcmVmdXNlIGEgbGVha2VkIGludm9jYXRpb25cbi8vIChmdW1ibGVkIGhlcmVkb2MpIHVubGVzcyAtLWZvcmNlLCBhbmQgd2FybiBvbiBzaGVsbCBtZXRhY2hhcmFjdGVycyB0aGF0XG4vLyBzdXJ2aXZlZCBhbiBpbmxpbmUgYm9keSAoIzYwIOKAlCB3YXJuLCBuZXZlciBibG9jaykuXG5mdW5jdGlvbiBndWFyZEJvZHkodmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsIHRleHQ6IHN0cmluZywgZnJvbUlubGluZTogYm9vbGVhbiwgZm9yY2U6IGJvb2xlYW4pIHtcbiAgaWYgKCFmb3JjZSAmJiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQpKSB7XG4gICAgZGllKFxuICAgICAgYCR7dmVyYn06IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGdyYXBldmluZSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgYCArXG4gICAgICAgIFwiaGVyZWRvYz8pLiBOb3RoaW5nIHdhcyBzZW50LiBQaXBlIHRoZSByZWFsIGJvZHkgdmlhIC0tc3RkaW4gb3IgXCIgK1xuICAgICAgICBcIi0tYm9keS1maWxlIDxwYXRoPiwgb3IgcGFzcyAtLWZvcmNlIHRvIHNlbmQgaXQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZyb21JbmxpbmUgJiYgbG9va3NTaGVsbFJpc2t5KHRleHQpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBcIiMg4pqgIGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgYmVmb3JlIFwiICtcbiAgICAgICAgXCJncmFwZXZpbmUgc2VlcyB0aGVtIOKAlCB1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbn1cblxuY29uc3QgaWRlbnRpdHlSZXF1aXJlZCA9ICh2ZXJiOiBzdHJpbmcpOiBuZXZlciA9PlxuICBkaWUoYCR7dmVyYn06IGlkZW50aXR5IHJlcXVpcmVkIOKAlCBwYXNzIC0tYXMvLS1mcm9tIDxhbGlhcz4gb3Igc2V0IEdSQVBFVklORV9GUk9NIGVudiB2YXJgKTtcblxuY29uc3QgQ09NTUFORFM6IENvbW1hbmRTcGVjW10gPSBbXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5cIixcbiAgICBmbGFnczogW1widG9waWNcIiwgXCJmcmVzaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRPcGVuKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgdG9waWM6IGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbTogcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICAgZnJlc2g6IGZsYWdzLmZyZXNoID09PSB0cnVlLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidG9waWNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kVG9waWMoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIHBvc2l0aW9uYWwubGVuZ3RoID4gMSA/IHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIikgOiB1bmRlZmluZWQsXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxpc3RcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kTGlzdCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlbmRcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcInZlcmJvc2VcIiwgXCJmb3JjZVwiLCBcImluLXJlcGx5LXRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwb3NpdGlvbmFsWzBdO1xuICAgICAgY29uc3QgZnJvbSA9IHJlc29sdmVBbGlhcyhmbGFncyk7XG4gICAgICBjb25zdCB7IHRleHQsIGZyb21JbmxpbmUgfSA9IGF3YWl0IHJlc29sdmVCb2R5KFwic2VuZFwiLCBwb3NpdGlvbmFsLnNsaWNlKDEpLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJzZW5kXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwic2VuZFwiLCB0ZXh0LCBmcm9tSW5saW5lLCAhIWZsYWdzLmZvcmNlKTtcbiAgICAgIGF3YWl0IGNtZFNlbmQobmFtZSwgZnJvbSBhcyBzdHJpbmcsIHRleHQsIHtcbiAgICAgICAgcXVpZXQ6ICEhZmxhZ3MucXVpZXQsXG4gICAgICAgIHZlcmJvc2U6ICEhZmxhZ3MudmVyYm9zZSxcbiAgICAgICAgaW5SZXBseVRvOiBmbGFnc1tcImluLXJlcGx5LXRvXCJdXG4gICAgICAgICAgPyBudW1lcmljRmxhZyhcInNlbmRcIiwgXCJpbi1yZXBseS10b1wiLCBmbGFnc1tcImluLXJlcGx5LXRvXCJdLCAwKVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYW5ub3VuY2VcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcImZvcmNlXCIsIFwiY2hhbm5lbHNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJhbm5vdW5jZVwiLCBwb3NpdGlvbmFsLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJhbm5vdW5jZVwiKTtcbiAgICAgIGd1YXJkQm9keShcImFubm91bmNlXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgY29uc3QgY2hhbm5lbHMgPSBmbGFncy5jaGFubmVsc1xuICAgICAgICA/IChmbGFncy5jaGFubmVscyBhcyBzdHJpbmcpXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKChjKSA9PiBjLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBhd2FpdCBjbWRBbm5vdW5jZShmcm9tIGFzIHN0cmluZywgdGV4dCwgY2hhbm5lbHMsIHsgcXVpZXQ6ICEhZmxhZ3MucXVpZXQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHVsbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcInN0YXR1c1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwicHVsbFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGF3YWl0IGNtZFB1bGwocG9zaXRpb25hbFswXSwgc2luY2UsIHsgc3RhdHVzOiBmbGFncy5zdGF0dXMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRyaWFnZVwiLFxuICAgIGZsYWdzOiBbXCJodW1hblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUcmlhZ2UocG9zaXRpb25hbFswXSwgeyBodW1hbjogISFmbGFncy5odW1hbiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgZmxhZ3M6IFtcInRleHRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBpZCA9IHBvc2l0aW9uYWxbMV0gPyBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCkgOiBOYU47XG4gICAgICBhd2FpdCBjbWRSZWFkKHBvc2l0aW9uYWxbMF0sIGlkLCB7IHRleHQ6ICEhZmxhZ3MudGV4dCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3YWl0XCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwidGltZW91dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGNvbnN0IHRpbWVvdXQgPSBudW1lcmljRmxhZyhcIndhaXRcIiwgXCJ0aW1lb3V0XCIsIGZsYWdzLnRpbWVvdXQsIDMwKTtcbiAgICAgIGF3YWl0IGNtZFdhaXQocG9zaXRpb25hbFswXSwgc2luY2UsIHRpbWVvdXQsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndob1wiLFxuICAgIGZsYWdzOiBbXCJhbGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGlmIChmbGFncy5hbGwpIGF3YWl0IGNtZFdob0FsbCgpO1xuICAgICAgZWxzZSBhd2FpdCBjbWRXaG8ocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYWxpYXNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQWxpYXMocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFpbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcImZyb20tc3RhcnRcIiwgXCJsYXN0XCIsIFwiaHVtYW5cIiwgXCJsdXJrXCIsIFwibWF4XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRhaWwocG9zaXRpb25hbFswXSwge1xuICAgICAgICBzaW5jZTogZmxhZ3Muc2luY2UgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbVN0YXJ0OiAhIWZsYWdzW1wiZnJvbS1zdGFydFwiXSxcbiAgICAgICAgbGFzdDogZmxhZ3MubGFzdCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJ0YWlsXCIsIFwibGFzdFwiLCBmbGFncy5sYXN0LCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgYXM6IHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICAgIGh1bWFuOiAhIWZsYWdzLmh1bWFuLFxuICAgICAgICBsdXJrOiAhIWZsYWdzLmx1cmssXG4gICAgICAgIG1heDogcmVzb2x2ZVRhaWxNYXgoZmxhZ3MubWF4KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdyZXBcIixcbiAgICBmbGFnczogW1wibGl0ZXJhbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJwYXR0ZXJuXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEdyZXAocG9zaXRpb25hbFswXSwgcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSwge1xuICAgICAgICBsaXRlcmFsOiAhIWZsYWdzLmxpdGVyYWwsXG4gICAgICAgIGZyb206IGZsYWdzLmZyb20gYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiY2xvc2VcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRDbG9zZShwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXNldFwiLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRSZXNldChwb3NpdGlvbmFsWzBdLCB7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtYXJrXCIsXG4gICAgZmxhZ3M6IFtcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJkaXNwb3NpdGlvblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRNYXJrKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIHBvc2l0aW9uYWwuc2xpY2UoMikuam9pbihcIiBcIiksXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncykgPz8gaWRlbnRpdHlSZXF1aXJlZChcIm1hcmtcIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRNYXJrKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIFwib3BlblwiLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJyZW9wZW5cIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBcmNoaXZlKHBvc2l0aW9uYWxbMF0sIGZhbHNlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCB0cnVlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGFydFwiLFxuICAgIGFsaWFzZXM6IFtcInVwXCJdLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdGFydCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlc3RhcnRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzdGFydCh7IGZvcmNlOiAhIWZsYWdzLmZvcmNlIHx8ICEhZmxhZ3MueWVzIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJvbGxcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUm9sbCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB8fCBmbGFncy55ZXMgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RvcFwiLFxuICAgIGZsYWdzOiBbXCJob2xkXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFN0b3Aoe1xuICAgICAgICBob2xkU2Vjb25kczpcbiAgICAgICAgICBmbGFncy5ob2xkICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInN0b3BcIiwgXCJob2xkXCIsIGZsYWdzLmhvbGQsIDApIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2F0Y2hcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kV2F0Y2gocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhcFwiLFxuICAgIGFsaWFzZXM6IFtcInBydW5lXCJdLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcImRyeS1ydW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVhcCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSwgZHJ5UnVuOiBmbGFnc1tcImRyeS1ydW5cIl0gPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRJbmZvKCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9jdG9yXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZERvY3RvcigpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICBmbGFnczogW1wiaHVtYW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgLy8gVGhlIENMSSBjYW4gYmUgQVNLRUQgd2hhdCBpdCBpcy4gZ3JhcGV2aW5lIGFscmVhZHkgY2Fycmllc1xuICAgICAgLy8gUExVR0lOX1ZFUlNJT04gdG8gd2FybiB0aGF0IGEgZGFlbW9uIGlzIGZyb20gYSBkaWZmZXJlbnQgY2FjaGVkIHBsdWdpblxuICAgICAgLy8gcGF0aCB0aGFuIHRoaXMgQ0xJIChtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaCkg4oCUIGJ1dCBhIGNhbGxlciB0aGF0IGhpdFxuICAgICAgLy8gdGhhdCB3YXJuaW5nLCBvciB0aGF0IHJ1bnMgYHJvbGxgIGZvciBpdHMgdmVyc2lvbiB2ZXJpZnksIGhhZCBubyB3YXkgdG9cbiAgICAgIC8vIGFzayB0aGlzIHNpZGUgd2hhdCBpdCBpcyBob2xkaW5nLiBUaGUgdmFsdWUgd2FzIGFscmVhZHkgaW4gbWVtb3J5OyBvbmx5XG4gICAgICAvLyB0aGUgcXVlc3Rpb24gd2FzIG1pc3NpbmcuXG4gICAgICAvLyBKU09OIGJ5IGRlZmF1bHQsIG1hdGNoaW5nIGV2ZXJ5IGRhdGEgY29tbWFuZDsgLS1odW1hbiBmb3IgcHJvc2UuXG4gICAgICBpZiAoUExVR0lOX1ZFUlNJT04gPT09IG51bGwpIGRpZShcInZlcnNpb24gdW5hdmFpbGFibGUg4oCUIGNvdWxkIG5vdCByZWFkIHBsdWdpbi5qc29uXCIsIDEpO1xuICAgICAgaWYgKGZsYWdzLmh1bWFuID09PSB0cnVlKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIHYke1BMVUdJTl9WRVJTSU9OfVxcbmApO1xuICAgICAgZWxzZSBwcmludEpzb24oeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgLy8gRW1pdCB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIOKAlCBnZW5lcmF0ZWQgYnlcbiAgICAgIC8vIFdBTEtJTkcgQ09NTUFORFMgYW5kIENMSV9PUFRJT05TLCB0aGUgc2FtZSBzdHJ1Y3R1cmVzIHRoZSBwYXJzZXIgYW5kXG4gICAgICAvLyBkaXNwYXRjaGVyIGNvbnN1bWUsIGF0IGFuc3dlciB0aW1lLiBObyBkYWVtb24sIG5vIGNvbmZpZywgbm9cbiAgICAgIC8vIGNyZWRlbnRpYWxzOyBzdGRvdXQsIGV4aXQgMC4gVGhlIHNoYXBlIGlzIGFjYyBkZWNsYXJhdGlvbiBmb3JtYXQgdjBcbiAgICAgIC8vIGV4YWN0bHksIHNvIHRoZSBvdXRwdXQgcGlwZXMgc3RyYWlnaHQgaW50b1xuICAgICAgLy8gYGFjYyBjaGVjayA8Y2xpPiAtLWRlY2xhcmF0aW9uIDwoZ3JhcGV2aW5lIHNjaGVtYSlgIHdpdGggbm8gYWRhcHRlci5cbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGJ1aWxkRGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGVscFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcmludEhlbHAoKTtcbiAgICB9LFxuICB9LFxuXTtcblxuZnVuY3Rpb24gZmluZENvbW1hbmQodG9rZW46IHN0cmluZyk6IENvbW1hbmRTcGVjIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIENPTU1BTkRTLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gdG9rZW4gfHwgYy5hbGlhc2VzPy5pbmNsdWRlcyh0b2tlbikpO1xufVxuXG4vLyBUaGUgdmVyYidzIGZ1bGwgYWNjZXB0ZWQgc2V0OiBpdHMgb3duIGZsYWdzIHBsdXMgdGhlIGNvbnRyYWN0dWFsbHktZ2xvYmFsXG4vLyBpZGVudGl0eSBwYWlyLCBpbiByZWdpc3RyeSBvcmRlci5cbmZ1bmN0aW9uIGFjY2VwdGVkRmxhZ3Moc3BlYzogQ29tbWFuZFNwZWMpOiBGbGFnTmFtZVtdIHtcbiAgY29uc3Qgb3duID0gbmV3IFNldDxGbGFnTmFtZT4oWy4uLkdMT0JBTF9GTEFHUywgLi4uc3BlYy5mbGFnc10pO1xuICByZXR1cm4gKE9iamVjdC5rZXlzKENMSV9PUFRJT05TKSBhcyBGbGFnTmFtZVtdKS5maWx0ZXIoKGspID0+IG93bi5oYXMoaykpO1xufVxuXG4vLyBSb290IGludGVyY2VwdG9ycyDigJQgZmxhZ3MgdGhlIFJPT1QgYW5zd2VycyBpdHNlbGYsIGJlZm9yZSBhbnkgdmVyYi4gVGhlc2UgYXJlXG4vLyBub3QgY29tbWFuZHMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IGEgZ2VuZXJhdG9yIHdhbGtpbmcgXCJ0aGUgY29tbWFuZHNcIiB3YWxrc1xuLy8gcGFzdCB0aGVtIChhY2MgRFQtNik7IHRoZXkgYXJlIGRlY2xhcmVkIGV4cGxpY2l0bHkgYXQgYHBhdGg6IFtdYC5cbmNvbnN0IFJPT1RfSU5URVJDRVBUT1JTID0gW1xuICB7IG5hbWU6IFwiLS1oZWxwXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItaFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLS12ZXJzaW9uXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG4gIHsgbmFtZTogXCItVlwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuLy8gYWNjIGRlY2xhcmF0aW9uIGZvcm1hdCB2MCAoc2VlIGFnZW50LWNsaS1jb25mb3JtYW5jZSBzcmMvYWNjL2tpdC9kZWNsYXJhdGlvbi50cyk6XG4vLyB7IGZvcm1hdFZlcnNpb24sIHByb3ZlbmFuY2UsIHNlbGZEZXNjcmlwdGlvbiwgY29tbWFuZHM6IFt7IHBhdGgsIGFyZ3MsIHBvc2l0aW9uYWxzIH1dIH0uXG4vLyB2MCByZWZ1c2VzIHVua25vd24ga2V5cywgc28gbm90aGluZyByaWNoZXIgKGVmZmVjdHMsIHN1bW1hcmllcywgdmVyc2lvbnMpXG4vLyByaWRlcyBhbG9uZyDigJQgdGhvc2Ugd2FpdCBmb3IgYSB2MSB3aXRoIHNsb3RzIGZvciB0aGVtLlxuZnVuY3Rpb24gYnVpbGREZWNsYXJhdGlvbigpIHtcbiAgLy8gRXZlcnkgcmVnaXN0cnkgZmxhZyBpcyBhY2NlcHRlZCB0b2RheTsgYSByZWZ1c2FsIGxpc3Qgd291bGQgYWRkXG4gIC8vIHN0YXR1czogXCJyZWZ1c2VkXCIgZW50cmllcyBoZXJlIHRoZSBkYXkgYSB2ZXJiIHJlY29nbmlzZXMtYW5kLWRlY2xpbmVzIG9uZS5cbiAgY29uc3QgYXJnID0gKGs6IEZsYWdOYW1lKSA9PiAoe1xuICAgIG5hbWU6IGAtLSR7a31gLFxuICAgIHR5cGU6IENMSV9PUFRJT05TW2tdLnR5cGUsXG4gICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gIH0pO1xuICBjb25zdCBjb21tYW5kczoge1xuICAgIHBhdGg6IHN0cmluZ1tdO1xuICAgIGFyZ3M6IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBcInN0cmluZ1wiIHwgXCJib29sZWFuXCI7IHN0YXR1czogc3RyaW5nIH1bXTtcbiAgICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbiAgfVtdID0gW1xuICAgIHtcbiAgICAgIC8vIGBwYXRoOiBbXWAgSVMgdGhlIHJvb3QuIEl0cyBncmFtbWFyOiBvbmUgcmVxdWlyZWQgdG9rZW4gc2VsZWN0aW5nIGFcbiAgICAgIC8vIGNvbW1hbmQsIG9yIGFuIGludGVyY2VwdG9yIGZsYWcgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuXG4gICAgICBwYXRoOiBbXSxcbiAgICAgIGFyZ3M6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgICB9KSksXG4gICAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIH0sXG4gIF07XG4gIGZvciAoY29uc3Qgc3BlYyBvZiBDT01NQU5EUykge1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBbc3BlYy5uYW1lLCAuLi4oc3BlYy5hbGlhc2VzID8/IFtdKV0pIHtcbiAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICBwYXRoOiBbbmFtZV0sXG4gICAgICAgIGFyZ3M6IGFjY2VwdGVkRmxhZ3Moc3BlYykubWFwKChrKSA9PiBhcmcoaykpLFxuICAgICAgICBwb3NpdGlvbmFsczogc3BlYy5wb3NpdGlvbmFscyxcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4ge1xuICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbXCJzY2hlbWFcIl0gfSxcbiAgICBjb21tYW5kcyxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VGbGFncyhcbiAgYXJndjogc3RyaW5nW10sXG4gIHNwZWM6IENvbW1hbmRTcGVjLFxuKToge1xuICBwb3NpdGlvbmFsOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IEZsYWdzO1xufSB7XG4gIGNvbnN0IGFjY2VwdGVkID0gYWNjZXB0ZWRGbGFncyhzcGVjKTtcbiAgY29uc3Qgb3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhhY2NlcHRlZC5tYXAoKGspID0+IFtrLCBDTElfT1BUSU9OU1trXV0pKTtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICAgIHJldHVybiB7XG4gICAgICBwb3NpdGlvbmFsOiBwb3NpdGlvbmFscyxcbiAgICAgIGZsYWdzOiB2YWx1ZXMgYXMgRmxhZ3MsXG4gICAgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGRldGFpbCA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAvLyBcInJlY29nbml6ZWQgZmxhZ3M6XCIgd2l0aCB0aGUgY29sb24gc3RyYWlnaHQgYWZ0ZXIgdGhlIG5vdW4g4oCUIHRoZSBleGFjdFxuICAgIC8vIG1hcmtlciBzaGFwZSBmbGFnLXNldCBleHRyYWN0b3JzIG1hdGNoIChcIlZhbGlkIGZsYWdzOiAtLXhcIiBhbmQga2luOyBhY2Mnc1xuICAgIC8vIE1BUktFUiByZWdleCBpcyB0aGUgbWVhc3VyZWQgY29uc3VtZXIpLiBBIHF1YWxpZmllciBiZXR3ZWVuIHRoZSBub3VuIGFuZFxuICAgIC8vIHRoZSBjb2xvbiAoXCJyZWNvZ25pemVkIGZsYWdzIGZvciBzZW5kOlwiKSByZWFkcyBhcyBwcm9zZSwgbm90IGEgc2V0LlxuICAgIGNvbnN0IGJvZHlIaW50ID1cbiAgICAgIHNwZWMubmFtZSA9PT0gXCJzZW5kXCIgfHwgc3BlYy5uYW1lID09PSBcImFubm91bmNlXCJcbiAgICAgICAgPyBgXFxuICBmb3IgYSBtZXNzYWdlIGJvZHkgY29udGFpbmluZyBkYXNoZXMsIHVzZSAtLXN0ZGluIG9yIC0tYm9keS1maWxlLCBgICtcbiAgICAgICAgICBgb3IgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLWBcbiAgICAgICAgOiBcIlwiO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYCR7c3BlYy5uYW1lfTogJHtkZXRhaWx9XFxuYCArXG4gICAgICAgIGAgIHJlY29nbml6ZWQgZmxhZ3M6ICR7YWNjZXB0ZWQubWFwKChrKSA9PiBgLS0ke2t9YCkuam9pbihcIiBcIil9JHtib2R5SGludH1gLFxuICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29tbWFuZFRva2VucygpOiBzdHJpbmdbXSB7XG4gIHJldHVybiBDT01NQU5EUy5mbGF0TWFwKChjKSA9PiBbYy5uYW1lLCAuLi4oYy5hbGlhc2VzID8/IFtdKV0pO1xufVxuXG5mdW5jdGlvbiBwcmludEhlbHAoKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBncmFwZXZpbmUg4oCUIGFnZW50LXRvLWFnZW50IHdhbGtpZS10YWxraWVcblxuVXNhZ2U6XG4gIGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXSAgIG9wZW4vY3JlYXRlIChhdXRvLXVuYXJjaGl2ZXM7IC0tZnJlc2ggY2xlYXJzIGEgZG9ybWFudCBjaGFubmVsKVxuICBncmFwZXZpbmUgbGlzdFxuICBncmFwZXZpbmUgc2VuZCA8bmFtZT4gWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLXF1aWV0XSBbLS12ZXJib3NlXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tZm9yY2VdIFstLWluLXJlcGx5LXRvIDxpZD5dIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJvZHk6IGlubGluZSB0ZXh0LCAtLXN0ZGluLCAtLWJvZHktZmlsZSwgb3IgcGlwZWQgc3RkaW4gKGRlZmF1bHQgd2hlbiBubyBpbmxpbmUgdGV4dClcbiAgZ3JhcGV2aW5lIGFubm91bmNlIFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1jaGFubmVscyBhLGIsY10gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLXF1aWV0XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBicm9hZGNhc3Qgb25lIG1lc3NhZ2UgdG8gZXZlcnkgYWN0aXZlIGNoYW5uZWwgKG9yIC0tY2hhbm5lbHMpXG4gIGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcy8tLWZyb20gPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVxuICAgICAgICMgLS1sYXN0IDxuPjogYmFja2ZpbGwgdGhlIG1vc3QgcmVjZW50IG4gbWVzc2FnZXMgdGhlbiBnbyBsaXZlIChib3VuZGVkIGNhdGNoLXVwIGZvciBhIGNvbGQgam9pbmVyKVxuICBncmFwZXZpbmUgcHVsbCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tc3RhdHVzIDx2YWx1ZT5dICAgIyAtLXN0YXR1cyA9IGZ1bGwtc2NhbiBmaWx0ZXIgKG9wZW58d29udGZpeHxpbmNvcnBvcmF0ZWR84oCmKVxuICBncmFwZXZpbmUgdHJpYWdlIDxuYW1lPiAgICAgICAgICAgICAjIGZ1bGwtc2Nhbjogb3BlbiBtZXNzYWdlcyBvbiB0b3AgKyBncm91cGVkIGJ5X3N0YXR1c1xuICBncmFwZXZpbmUgbWFyayA8bmFtZT4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSAgIyBzZXQgZGlzcG9zaXRpb24gKGluY29ycG9yYXRlZHx3b250Zml4fGRlZmVycmVkfOKApilcbiAgZ3JhcGV2aW5lIHJlb3BlbiA8bmFtZT4gPGlkPiAgICAgICAgIyBib3VuY2UgYSBtZXNzYWdlIGJhY2sgdG8gb3BlblxuICBncmFwZXZpbmUgcmVhZCA8bmFtZT4gPGlkPiBbLS10ZXh0XSAgICMgb25lIGZ1bGwgbWVzc2FnZSBieSBpZCAoLS10ZXh0ID0gcHJvc2UpXG4gIGdyYXBldmluZSB3YWl0IDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS10aW1lb3V0IDxzPl1cbiAgZ3JhcGV2aW5lIGdyZXAgPG5hbWU+IDxwYXR0ZXJuPiBbLS1saXRlcmFsXSBbLS1mcm9tIDxhbGlhcz5dXG4gIGdyYXBldmluZSB0b3BpYyA8bmFtZT4gWzx0ZXh0Pl0gICAjIG5vIHRleHQg4oaSIHJlYWQgY3VycmVudDsgd2l0aCB0ZXh0IOKGkiB1cGRhdGVcbiAgZ3JhcGV2aW5lIHdobyA8bmFtZT4gICAgICAgICAgICAgICMgcm9zdGVyOyB0aGUgaHVtYW5zIGZpZWxkIGxpc3RzIGh1bWFuc1xuICBncmFwZXZpbmUgYWxpYXMgWzxuYW1lPl0gICAgICAgICAgIyBzZXQvc2hvdyB5b3VyIHBlcnNpc3RlZCBhbGlhcyAoY29uZmlnLmpzb24pXG4gIGdyYXBldmluZSB3YXRjaCBbPG5hbWU+XSAgICAgICAgICAjIG9wZW4gYnJvd3NlciB0YWI7IGxpdmUgY2hhdC1idWJibGUgdmlld1xuICBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXSAgICAgICAgICAgc25hcHNob3QgdGhlIGxvZyDihpIgfi8uZ3JhcGV2aW5lL2FyY2hpdmUsIHRoZW4gY2xlYXIgaXRcbiAgZ3JhcGV2aW5lIGFyY2hpdmUgPG5hbWU+ICAgICAgICAgICMgcmVhZC1vbmx5OiBrZWVwIGhpc3RvcnksIHJlamVjdCBzZW5kc1xuICBncmFwZXZpbmUgdW5hcmNoaXZlIDxuYW1lPiAgICAgICAgIyBicmluZyBhbiBhcmNoaXZlZCBjaGFubmVsIGJhY2tcbiAgZ3JhcGV2aW5lIGNsb3NlIDxuYW1lPiAgICAgICAgICAgICMgZGVzdHJ1Y3RpdmU6IGRlbGV0ZSB0aGUgbWVzc2FnZSBsb2dcbiAgZ3JhcGV2aW5lIHN0YXJ0ICAgICAgICAgICAgICAgICAgICMgZW5zdXJlIHRoZSBkYWVtb24gaXMgcnVubmluZyAoYWxpYXM6IHVwKTsgbm8gY2hhbm5lbFxuICBncmFwZXZpbmUgcmVzdGFydCBbLS1mb3JjZXwtLXllc10gIyBzdG9wICsgcmVzcGF3biBmcmVzaDsgLS1mb3JjZSB0byBvdmVycmlkZSB0aGUgbGl2ZS1mbGVldCBndWFyZFxuICBncmFwZXZpbmUgcm9sbCBbLS1mb3JjZV0gICAgICAgICAgIyBzYWZlIHJlc3RhcnQgKHN0b3AraG9sZCtyZXNwYXduKSArIHZlcnNpb24gdmVyaWZ5IOKAlCB0aGUgcmVjb21tZW5kZWQgZGVwbG95IHN0ZXBcbiAgZ3JhcGV2aW5lIHN0b3AgWy0taG9sZCA8c2Vjb25kcz5dICMga2lsbCB0aGUgZGFlbW9uOyAtLWhvbGQgc3VwcHJlc3NlcyBhdXRvLXJlc3Bhd24gZm9yIDxzPiBzZWNvbmRzICh1cGdyYWRlIHdpbmRvdylcbiAgZ3JhcGV2aW5lIGluZm9cbiAgZ3JhcGV2aW5lIGRvY3RvciAgICAgICAgICAgICAgICAgICMgaGVhbHRoIGNoZWNrIOKAlCBsYWJlbHMgZWFjaCBkYWVtb246IGF1dGhvcml0YXRpdmUgLyBvcnBoYW4gLyB1bnJlc3BvbnNpdmUgLyB1bmtub3duXG4gIGdyYXBldmluZSByZWFwIFstLWZvcmNlXSBbLS1kcnktcnVuXSAgIyBraWxsIG9ycGhhbiBkYWVtb25zOyAtLWZvcmNlIGFsc28ga2lsbHMgdW5yZXNwb25zaXZlOyBhbGlhczogcHJ1bmVcblxuICBncmFwZXZpbmUgc2NoZW1hICAgICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIGRlc2NyaXB0aW9uIChhY2MgZGVjbGFyYXRpb24gdjApXG4gIGdyYXBldmluZSAtLXZlcnNpb24gICAgICAgICAgICAgICAjIHRoaXMgQ0xJJ3MgdmVyc2lvbiAoYWxpYXM6IC1WLCB2ZXJzaW9uKVxuICBncmFwZXZpbmUgaGVscCAgICAgICAgICAgICAgICAgICAgIyB0aGlzIHVzYWdlIChhbGlhczogLS1oZWxwLCAtaClcblxuT3V0cHV0OlxuICBEYXRhIGNvbW1hbmRzIGVtaXQgSlNPTiBvbiBzdGRvdXQgYnkgREVGQVVMVDsgcGFzcyAtLWh1bWFuIGZvciBwcm9zZSB3aGVyZSBhXG4gIGNvbW1hbmQgb2ZmZXJzIGl0LiBEaWFnbm9zdGljcyBhbmQgd2FybmluZ3MgZ28gdG8gc3RkZXJyLCBuZXZlciBzdGRvdXQuXG4gIFVzYWdlIGVycm9ycyBleGl0IDIuIEVhY2ggY29tbWFuZCBhY2NlcHRzIGl0cyBPV04gZmxhZ3MgKHBsdXMgLS1hcy8tLWZyb20sXG4gIHdoaWNoIGFyZSBnbG9iYWwpIOKAlCBhbiB1bmtub3duIGZsYWcgZm9yIGEgdmVyYiBlbnVtZXJhdGVzIHRoYXQgdmVyYidzIHNldC5cblxuRW52OlxuICBHUkFQRVZJTkVfRlJPTSAgIERlZmF1bHQgaWRlbnRpdHkgYWxpYXMgKC0tZnJvbS8tLWFzIGFyZSBpbnRlcmNoYW5nZWFibGUpLlxuICBHUkFQRVZJTkVfSE9NRSAgIERhdGEgZGlyIChkZWZhdWx0IH4vLmdyYXBldmluZSkuXG5gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IFtjbWQsIC4uLnJlc3RdID0gYXJndjtcbiAgLy8gVXNhZ2UgZmFpbHVyZXMgcmV0dXJuIDIgcmF0aGVyIHRoYW4gZXhpdGluZywgc28gdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dC5cblxuICAvLyBCQVJFIElOVk9DQVRJT04gSVMgQSBVU0FHRSBFUlJPUiDigJQgZXhpdCAyLCB1c2FnZSBwb2ludGVyIG9uIHN0ZGVyciDigJQgbm90IGFcbiAgLy8gaGVscCByZXF1ZXN0IGF0IGV4aXQgMC4gZ3JhcGV2aW5lJ3MgY2FsbGVycyBhcmUgYWdlbnRzOiBhIGJhcmUgY2FsbCBpcyBhblxuICAvLyB1bnNldCBzaGVsbCB2YXJpYWJsZSBleHBhbmRpbmcgdG8gbm90aGluZywgb3IgYSBtaXN0YWtlLCBhbmQgYW5zd2VyaW5nIGl0XG4gIC8vIHdpdGggMi45S0Igb2YgaGVscCBhdCBleGl0IDAgcmVwb3J0cyBzdWNjZXNzIGZvciBhIGNvbW1hbmQgdGhhdCBhc2tlZCBmb3JcbiAgLy8gbm90aGluZy4gYGhlbHBgIC8gYC0taGVscGAgcmVtYWluIG9uZSB0b2tlbiBhd2F5IGF0IGV4aXQgMCAoYWNjIEQyIOKAlFxuICAvLyBjb25mb3JtZWQgZm9yIHRoYXQgcmVhc29uLCBub3QgYmVjYXVzZSB0aGUgcnVsZSBzYWlkIHNvKS5cbiAgaWYgKGNtZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgZ3JhcGV2aW5lOiBleHBlY3RlZCBhIGNvbW1hbmRcXG5gICtcbiAgICAgICAgYCAgY29tbWFuZHM6ICR7Y29tbWFuZFRva2VucygpLmpvaW4oXCIgXCIpfVxcbmAgK1xuICAgICAgICBgICBydW4gXFxgZ3JhcGV2aW5lIGhlbHBcXGAgKG9yIC0taGVscCkgZm9yIHVzYWdlXFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgLy8gUk9PVCBGTEFHIFJPVVRJTkcuIEEgbGVhZGluZyAtLXRva2VuIHVzZWQgdG8gYmUgY29uc3VtZWQgYXMgdGhlIENPTU1BTkRcbiAgLy8gdG9rZW4gYW5kIHJlamVjdGVkIGFzIGB1bmtub3duIGNvbW1hbmQ6IC0tbm9wZWAg4oCUIGEgZmxhZyByZWFjaGluZyB0aGUgdmVyYlxuICAvLyBwYXJzZXIncyBlcnJvciBwYXRoLCB3aGVyZSB0aGUgcmVqZWN0aW9uIGNvdWxkIG5vdCBlbnVtZXJhdGUgdGhlIGZsYWcgc2V0XG4gIC8vIChmb3VuZCB2aWEgYWNjJ3Mgcm9vdC1vbmx5IHN1cmZhY2UgY2FwdHVyZSkuIFRoZSByb290J3MgYWNjZXB0ZWQgZmxhZ3MgYXJlXG4gIC8vIHRoZSBpbnRlcmNlcHRvcnM7IGFueXRoaW5nIGVsc2UgZGFzaGVkIGlzIHJlamVjdGVkIEFTIEEgRkxBRywgZW51bWVyYXRpbmdcbiAgLy8gdGhlIHJvb3QncyBvd24gc2V0LlxuICBpZiAoY21kLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBST09UX0lOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGNtZCk7XG4gICAgaWYgKCFpbnRlcmNlcHRvcikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGBncmFwZXZpbmU6IHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtjbWR9XFxuYCArXG4gICAgICAgICAgLy8gTG9uZyBmbGFncyBmaXJzdDogZmxhZy1zZXQgZXh0cmFjdG9ycyAoYWNjJ3MgbWVhc3VyZWQpIHJlYWQgdGhlXG4gICAgICAgICAgLy8gbGlzdCBsZWZ0LXRvLXJpZ2h0IGFuZCBzdG9wIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhXG4gICAgICAgICAgLy8gYC0tbG9uZ2AgZmxhZywgc28gYSBzaG9ydCBhbGlhcyBtaWQtbGlzdCB0cnVuY2F0ZXMgd2hhdCB0aGV5IHNlZS5cbiAgICAgICAgICBgICByZWNvZ25pemVkIGZsYWdzOiAke1suLi5ST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSldXG4gICAgICAgICAgICAuc29ydCgoYSwgYikgPT4gTnVtYmVyKGIuc3RhcnRzV2l0aChcIi0tXCIpKSAtIE51bWJlcihhLnN0YXJ0c1dpdGgoXCItLVwiKSkpXG4gICAgICAgICAgICAuam9pbihcIiBcIil9XFxuYCArXG4gICAgICAgICAgYCAgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7Y29tbWFuZFRva2VucygpLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgICApO1xuICAgICAgcmV0dXJuIDI7XG4gICAgfVxuICAgIHJldHVybiBhd2FpdCBydW5Db21tYW5kKGZpbmRDb21tYW5kKGludGVyY2VwdG9yLnJ1bnMpIGFzIENvbW1hbmRTcGVjLCByZXN0KTtcbiAgfVxuXG4gIGNvbnN0IHNwZWMgPSBmaW5kQ29tbWFuZChjbWQpO1xuICBpZiAoIXNwZWMpIHtcbiAgICAvLyBUaGUgdW5rbm93bi12ZXJiIHJlamVjdGlvbiBlbnVtZXJhdGVzIHRoZSB2YWxpZCBzZXQsIGV4YWN0bHkgYXMgdGhlXG4gICAgLy8gdW5rbm93bi1mbGFnIHJlamVjdGlvbiBkb2VzIOKAlCB0aGUgcGFyc2VyJ3Mgb3duIGFjY291bnQgb2Ygd2hhdCBpdFxuICAgIC8vIGFjY2VwdHMsIHByb2R1Y2VkIGJ5IHRoZSBwYXJzZXIgKGFjYyBTVEFOREFSRC5tZCwgXCJ0aGUgY2hlYXBlc3QgdmVyc2lvblxuICAgIC8vIG9mIGNoZWNrZWRcIikuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgZ3JhcGV2aW5lOiB1bmtub3duIGNvbW1hbmQ6ICR7Y21kfVxcbiAgY29tbWFuZHM6ICR7Y29tbWFuZFRva2VucygpLmpvaW4oXCIgXCIpfVxcbmAsXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICByZXR1cm4gYXdhaXQgcnVuQ29tbWFuZChzcGVjLCByZXN0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuQ29tbWFuZChzcGVjOiBDb21tYW5kU3BlYywgcmVzdDogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9zaXRpb25hbDogc3RyaW5nW107XG4gIGxldCBmbGFnczogRmxhZ3M7XG4gIHRyeSB7XG4gICAgKHsgcG9zaXRpb25hbCwgZmxhZ3MgfSA9IHBhcnNlRmxhZ3MocmVzdCwgc3BlYykpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKCEoZSBpbnN0YW5jZW9mIFVzYWdlRXJyb3IpKSB0aHJvdyBlO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBncmFwZXZpbmU6ICR7ZS5tZXNzYWdlfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIC8vIEFyaXR5LCBlbmZvcmNlZCBGUk9NIFRIRSBERUNMQVJFRCBTSEFQRSDigJQgdGhlIHJlZ2lzdHJ5J3MgcG9zaXRpb25hbCBzcGVjIGlzXG4gIC8vIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLCBzbyBlbmZvcmNpbmcgaXQgaGVyZSBpcyB3aGF0IGtlZXBzIHRoZSBkZWNsYXJhdGlvblxuICAvLyB0cnVlIGJ5IGNvbnN0cnVjdGlvbjogYSBtaXNzaW5nIHJlcXVpcmVkIHBvc2l0aW9uYWwgZXJyb3JzIGJlZm9yZSB0aGUgdmVyYlxuICAvLyBydW5zLCBhbmQgYW4gRVhDRVNTIHBvc2l0aW9uYWwgaXMgcmVqZWN0ZWQgcmF0aGVyIHRoYW4gc2lsZW50bHkgc3dhbGxvd2VkXG4gIC8vIChhY2MgQTQncyBzaGFwZSDigJQgdGhlIGRlZmVjdCBubyBleHRlcm5hbCBjaGVjayBjYW4gc2VlKS5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3NpdGlvbmFsLmxlbmd0aCA8IHJlcXVpcmVkKSB7XG4gICAgY29uc3QgbWlzc2luZyA9IHNwZWMucG9zaXRpb25hbHNbcG9zaXRpb25hbC5sZW5ndGhdO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGdyYXBldmluZTogJHtzcGVjLm5hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIDwke21pc3Npbmc/Lm5hbWUgPz8gXCJhcmd1bWVudFwifT5cXG5gICtcbiAgICAgICAgYCAgZXhwZWN0czogJHtzcGVjLm5hbWV9ICR7c3BlYy5wb3NpdGlvbmFsc1xuICAgICAgICAgIC5tYXAoKHApID0+IChwLnJlcXVpcmVkID8gYDwke3AubmFtZX0+YCA6IGBbJHtwLm5hbWV9XWApKVxuICAgICAgICAgIC5qb2luKFwiIFwiKX1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgaWYgKCF2YXJpYWRpYyAmJiBwb3NpdGlvbmFsLmxlbmd0aCA+IHNwZWMucG9zaXRpb25hbHMubGVuZ3RoKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgZ3JhcGV2aW5lOiAke3NwZWMubmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShcbiAgICAgICAgcG9zaXRpb25hbFtzcGVjLnBvc2l0aW9uYWxzLmxlbmd0aF0sXG4gICAgICApfVxcbmAgK1xuICAgICAgICBgICBleHBlY3RzOiAke3NwZWMubmFtZX0gJHtcbiAgICAgICAgICBzcGVjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHAucmVxdWlyZWQgPyBgPCR7cC5uYW1lfT5gIDogYFske3AubmFtZX1dYCkpLmpvaW4oXCIgXCIpIHx8XG4gICAgICAgICAgXCIobm8gYXJndW1lbnRzKVwiXG4gICAgICAgIH1cXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgYXdhaXQgc3BlYy5ydW4ocG9zaXRpb25hbCwgZmxhZ3MpO1xuICByZXR1cm4gMDtcbn1cblxuLy8g4puUIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIElUUyBBQlNFTkNFIElTIFRIRSBTVEVQIChwbGF5Ym9vayBCMykuXG4vLyBgZGlzdC9jbGkuanNgIGlzIElNUE9SVEVEIGJ5IGBzY3JpcHRzL2NsaS50c2AsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzXG4vLyBlbnRyeSwgc28gdGhlIGd1YXJkIHdvdWxkIG5ldmVyIHJ1biBhbmQgZXZlcnkgdmVyYiB3b3VsZCBwcmludCBub3RoaW5nIGFuZFxuLy8gZXhpdCAwLiBOb3IgbWF5IHRoaXMgZmlsZSBvZmZlciBhIHNlY29uZCBlbnRyeSBmcm9tIGl0cyBhdXRob3JpbmcgYWRkcmVzczpcbi8vIGBTS0lMTF9ST09UYCwgYERJU1RfRElSYCwgYFNVUkZBQ0VfQ1dEYCBhbmQgYERBRU1PTl9TQ1JJUFRgIGFib3ZlIGFyZSBhbGxcbi8vIGNvbXB1dGVkIGZyb20gYFNDUklQVF9ESVJgIGFuZCBhcmUgY29ycmVjdCBvbmx5IGZyb20gYGRpc3QvYC5cbi8vXG4vLyBUaGUgZHJhaW4gY29udHJhY3QgbGl2ZXMgYXQgdGhlIGxhdW5jaGVyIG5vdyDigJQgYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4vLyByZXR1cm4sIG5ldmVyIGFuIGV4cGxpY2l0IGV4aXQsIGJlY2F1c2UgQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhXG4vLyBwaXBlIGFuZCBgdGFpbGAgd3JpdGVzIEpTT05MIGEgY2FsbGVyIHBhcnNlcy4gU2VlXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dyYXBldmluZS9zY3JpcHRzL2NsaS50c2AgZm9yIHRoZSBmdWxsIGFjY291bnQuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBaUJBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVFBO0FBQ0E7QUFDQTtBQUNBLHNCQUFTO0FBRVQsSUFBTSxXQUFXLFFBQVEsSUFBSSxrQkFBa0IsS0FBSyxRQUFRLEdBQUcsWUFBWTtBQUMzRSxJQUFNLFlBQVksS0FBSyxVQUFVLGFBQWE7QUFDOUMsSUFBTSxXQUFXLEtBQUssVUFBVSxZQUFZO0FBQzVDLElBQU0sWUFBWSxLQUFLLFVBQVUsYUFBYTtBQUc5QyxJQUFNLGNBQWMsS0FBSyxVQUFVLGFBQWE7QUFDaEQsSUFBTSxhQUFhLFFBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQWN6RCxJQUFNLGdCQUFnQixLQUFLLFlBQVksTUFBTSxXQUFXLFdBQVc7QUFDbkUsSUFBTSxhQUFhLEtBQUssWUFBWSxJQUFJO0FBQ3hDLElBQU0sV0FBVyxLQUFLLFlBQVksTUFBTTtBQVN4QyxJQUFNLGNBQWMsS0FBSyxZQUFZLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxPQUFPLFdBQVc7QUFFOUUsU0FBUyxTQUFTLEdBQVc7QUFBQSxFQUNsQyxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFXLE9BQU87QUFBQSxFQUM3RCxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFPLE9BQU87QUFBQSxFQUN6RCxPQUFPLFdBQVcsS0FBSyxVQUFVLFlBQVksQ0FBQyxJQUFJLGFBQWE7QUFBQTtBQTRKakUsU0FBUyxpQkFBaUIsR0FBa0I7QUFBQSxFQUMxQyxJQUFJO0FBQUEsSUFDRixNQUFNLGlCQUFpQixLQUFLLFlBQVksTUFBTSxNQUFNLE1BQU0sa0JBQWtCLGFBQWE7QUFBQSxJQUN6RixNQUFNLE1BQU0sYUFBYSxnQkFBZ0IsT0FBTztBQUFBLElBQ2hE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UyxVQUFVO0FBQUEsSUFDaEMsTUFBTSxVQUFVLEtBQUssWUFBWSxXQUFXO0FBQUEsSUFDNUMsUUFBUSxPQUFPLE1BQ2IsY0FBYyxLQUFLLDJCQUEyQixTQUFTLFFBQVE7QUFBQSxJQUM3RCxjQUFjLEtBQUssUUFBUSxLQUFLLFlBQzdCLElBQUksQ0FBQyxNQUFPLEVBQUUsV0FBVyxJQUFJLEVBQUUsVUFBVSxJQUFJLEVBQUUsT0FBUSxFQUN2RCxLQUFLLEdBQUc7QUFBQSxDQUNmO0FBQUEsSUFDQSxPQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsSUFBSSxDQUFDLFlBQVksV0FBVyxTQUFTLEtBQUssWUFBWSxRQUFRO0FBQUEsSUFDNUQsUUFBUSxPQUFPLE1BQ2IsY0FBYyxLQUFLLDZCQUE2QixLQUFLLFVBQ25ELFdBQVcsS0FBSyxZQUFZLE9BQzlCO0FBQUEsSUFDRSxjQUFjLEtBQUssUUFDakIsS0FBSyxZQUFZLElBQUksQ0FBQyxNQUFPLEVBQUUsV0FBVyxJQUFJLEVBQUUsVUFBVSxJQUFJLEVBQUUsT0FBUSxFQUFFLEtBQUssR0FBRyxLQUNsRjtBQUFBLENBRU47QUFBQSxJQUNBLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxNQUFNLEtBQUssSUFBSSxZQUFZLEtBQUs7QUFBQSxFQUNoQyxPQUFPO0FBQUE7QUFjVCxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICI0QjBDMTAyRjA5RTNDMzk2NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
