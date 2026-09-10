#!/usr/bin/env bun
// @bun

// src/mind-mapper/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseArgs } from "util";
var SCRIPT_DIR = import.meta.dir;
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
var PORT_FILE = join(HOME, "daemon.port");
var PID_FILE = join(HOME, "daemon.pid");
function livePort() {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE))
    return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  const port = Number.parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || !Number.isFinite(port))
    return null;
  try {
    process.kill(pid, 0);
    return port;
  } catch {
    return null;
  }
}
async function ensureDaemon(port) {
  const running = livePort();
  if (running !== null)
    return running;
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open", ...port ? ["--port", String(port)] : []], {
    detached: true,
    stdio: "ignore",
    cwd: daemonCwd()
  });
  proc.unref();
  for (let i = 0;i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const port2 = livePort();
    if (port2 !== null)
      return port2;
  }
  throw new CliError("internal", "daemon did not come up within 10s");
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}
function envMs(name, fallback) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
var EXIT_FOR = {
  usage: 2,
  internal: 1,
  not_found: 5,
  conflict: 6
};
var CURRENT_COMMAND = null;

class CliError extends Error {
  kind;
  hint;
  choices;
  server;
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    this.hint = extra?.hint;
    this.choices = extra?.choices;
    this.server = extra?.server;
  }
}
var usageError = (message, extra) => new CliError("usage", message, extra);
function writeEnvelope(e) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      kind: e.kind,
      exit_code: EXIT_FOR[e.kind],
      retryable: false,
      message: e.message,
      ...e.hint !== undefined ? { hint: e.hint } : {},
      ...e.choices !== undefined ? { choices: e.choices } : {},
      ...e.server !== undefined ? { server: e.server } : {}
    },
    meta: { command: CURRENT_COMMAND }
  })}
`);
  return EXIT_FOR[e.kind];
}
async function passOrThrow(res) {
  const text = await res.text();
  if (res.ok)
    return text;
  let server = text;
  try {
    server = JSON.parse(text);
  } catch {}
  const kind = res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 400 ? "usage" : "internal";
  throw new CliError(kind, `${CURRENT_COMMAND ?? "request"} refused (HTTP ${res.status})`, {
    server
  });
}
function requireDaemon() {
  const port = livePort();
  if (port === null) {
    throw new CliError("not_found", "no daemon running (use `open` first)");
  }
  return port;
}
function toSkeleton(state) {
  const degree = new Map;
  for (const e of state.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: state.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      tier: n.tier,
      degree: degree.get(n.id) ?? 0
    }))
  };
}
var CLI_OPTIONS = {
  add: { type: "string" },
  anchor: { type: "string" },
  author: { type: "string" },
  batch: { type: "string" },
  "body-file": { type: "string" },
  check: { type: "string" },
  clear: { type: "boolean" },
  create: { type: "string" },
  deliverable: { type: "string" },
  depth: { type: "string" },
  detail: { type: "string" },
  doc: { type: "string" },
  "doc-edit": { type: "string" },
  file: { type: "string" },
  force: { type: "boolean" },
  ground: { type: "string", multiple: true },
  inbound: { type: "boolean" },
  kind: { type: "string" },
  message: { type: "string" },
  "no-open": { type: "boolean" },
  node: { type: "string" },
  note: { type: "string" },
  owner: { type: "string" },
  port: { type: "string" },
  project: { type: "string" },
  role: { type: "string" },
  ruling: { type: "string" },
  set: { type: "string" },
  since: { type: "string" },
  skeleton: { type: "boolean" },
  span: { type: "string" },
  status: { type: "string" },
  stdin: { type: "boolean" },
  synopsis: { type: "string" },
  title: { type: "string" },
  to: { type: "string" },
  uncheck: { type: "string" },
  yes: { type: "boolean" },
  zone: { type: "string" }
};
var VERB_SPEC = {
  open: ["no-open", "port", "project"],
  state: ["skeleton", "batch", "project"],
  changes: ["since", "project"],
  tail: ["since", "inbound", "project"],
  projects: ["create"],
  ingest: ["title", "file", "stdin", "project"],
  "propose-node": ["stdin", "zone", "project"],
  "propose-edge": ["stdin", "zone", "project"],
  "propose-batch": ["stdin", "project"],
  "ratify-batch": ["stdin", "project"],
  "delete-batch": ["stdin", "project"],
  "node anchor": ["to", "clear", "project"],
  "node edit": ["title", "synopsis", "stdin", "project"],
  "node delete": ["force", "project"],
  read: ["project"],
  "zone create": ["project"],
  "zone list": ["project"],
  "zone delete": ["yes", "project"],
  promote: ["project"],
  "proposal zone": ["to", "clear", "project"],
  "proposal delete": ["project"],
  doc: ["project"],
  "doc delete": ["force", "project"],
  "doc kind": ["author", "clear", "project"],
  mark: ["status", "note", "author", "project"],
  search: ["project"],
  neighbors: ["depth", "project"],
  ratify: ["ruling", "doc-edit", "doc", "span", "anchor", "project"],
  "lens set": ["node", "doc", "depth", "owner", "project"],
  "lens clear": ["project"],
  "look-here": ["project"],
  actions: ["set", "stdin", "clear", "project"],
  tags: ["set", "stdin", "clear", "project"],
  "job create": ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
  "job update": ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
  "job claim": ["owner", "project"],
  "job release": ["project"],
  "job subtask": ["add", "check", "uncheck", "project"],
  "job list": ["project"],
  "job delete": ["project"],
  activity: ["message", "project"],
  send: ["role", "kind", "ground", "body-file", "stdin", "force", "project"],
  help: []
};
var VERB_ALIASES = { message: "read" };
var VERBS = [...new Set(Object.keys(VERB_SPEC).map((p) => p.split(" ")[0]))];
var NO_POSITIONALS = new Set([
  "open",
  "state",
  "changes",
  "tail",
  "ingest",
  "propose-node",
  "propose-edge",
  "propose-batch",
  "ratify-batch",
  "delete-batch",
  "lens set",
  "lens clear",
  "help"
]);
var flagsFor = (path) => VERB_SPEC[path].map((k) => `--${k}`).sort();
var subsOf = (verb) => Object.keys(VERB_SPEC).filter((p) => p.startsWith(`${verb} `)).map((p) => p.slice(verb.length + 1));
function parseVerbArgs(path, args) {
  CURRENT_COMMAND = path;
  const parsed = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: true
  });
  const allowed = new Set(VERB_SPEC[path]);
  const stray = Object.keys(parsed.values).find((k) => !allowed.has(k));
  if (stray) {
    throw usageError(`--${stray} is not accepted by \`${path}\` (it is a recognized mind-mapper flag, just not this verb's)`, { choices: flagsFor(path) });
  }
  if (NO_POSITIONALS.has(path) && parsed.positionals.length > 0) {
    throw usageError(`${path} takes no positional arguments (got "${parsed.positionals[0]}")`, VERB_SPEC[path].length > 0 ? { choices: flagsFor(path) } : undefined);
  }
  return parsed;
}
var HELP = `mind-mapper \u2014 a co-present knowledge map: a dumb daemon holds the graph, the casting agent does the thinking.

  open   [--project <id>] [--port <n>] [--no-open]   spawn (or find) the daemon, print its url
  state  [--skeleton] [--batch <id>]                 the project snapshot (skeleton = ids/titles/degree)
  changes --since <epochSeconds>                     bounded delta, ADDITIONS ONLY (notCovered names the rest)
  tail   [--since N] [--inbound]                     SSE events as JSONL (wrap with Monitor)
  projects [--create <title>]                        list projects / create one
  ingest --title <t> (--file <p> | --stdin)          add a doc
  propose-node --stdin                               stage a node proposal (JSON {draft, evidence, ...})
  propose-edge --stdin [--zone <id>]                 stage an edge proposal
  propose-batch --stdin                              stage a set in one txn ({nodes, edges})
  ratify-batch --stdin                               ratify a set in one txn ({ruling, ids, anchors?})
  delete-batch --stdin                               delete a proposal set in one txn ({ids}, all-or-nothing)
  ratify <id> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <t>] [--anchor <parentId>]
  zone   create <name> | list | delete <id> [--yes]  staging pens for proposals
  promote <id>                                       move a zoned proposal to the main queue
  proposal zone <id> (--to <z> | --clear) | proposal delete <id>
  node   anchor <id> (--to <p> | --clear) | edit <id> [--title/--synopsis/--stdin] | delete <id> [--force]
  doc    <id> | delete <id> [--force] | kind <docId> (<kind> [--author a] | --clear)
  mark   <docId> --status <s> [--note <t>]           append a doc status mark
  actions <targetId> (--set <json> | --stdin | --clear)   action slots on a node/pending proposal
  tags   <targetId> (--set <json> | --stdin | --clear)    freeform tags, same targets
  job    create|update|claim|release|subtask|list|delete  persisted units of agent work
  search <query...>                                  FTS over nodes, docs, messages
  neighbors <id> [--depth 1]                         local hood + edge reasons
  lens   set (--node <id> [--depth n] | --doc <id>) | lens clear
  look-here <nodeId>                                 fire-once attention nudge
  read   <messageId>                                 one full message row (alias: message <id>)
  send   <text...> | --body-file <p> | --stdin       post a message ([--role] [--kind] [--ground])
  activity <received|thinking|idle> [--message <id>] the casting-loop liveness signal
  help | --version

  --project <id> is accepted by every verb except open's spawn-time flags; omit for the default project.

  Output: every verb prints JSON on stdout by default, one document per answer \u2014
  except tail, a stream that prints one JSON line per event. Prose, warnings and
  diagnostics go to stderr; failures exit non-zero (2 = usage).`;
function versionInfo() {
  try {
    const raw = readFileSync(join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "mind-mapper", version: pkg.version };
  } catch {}
  return { name: "mind-mapper", version: "unknown" };
}
async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (e) {
    if (e instanceof CliError)
      return writeEnvelope(e);
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (code.startsWith("ERR_PARSE_ARGS"))
      return writeEnvelope(usageError(msg));
    if (e instanceof SyntaxError)
      return writeEnvelope(usageError(`invalid JSON: ${msg}`));
    if (code === "ENOENT")
      return writeEnvelope(usageError(msg));
    return writeEnvelope(new CliError("internal", msg));
  }
}
async function dispatch(argv) {
  const verb = argv[0];
  const rest = argv.slice(1);
  CURRENT_COMMAND = verb ?? null;
  if (verb === "--help" || verb === "-h") {
    process.stdout.write(`${HELP}
`);
    return 0;
  }
  if (verb === "--version" || verb === "-V" || verb === "version") {
    process.stdout.write(`${JSON.stringify(versionInfo())}
`);
    return 0;
  }
  if (verb === "help") {
    parseVerbArgs("help", rest);
    process.stdout.write(`${HELP}
`);
    return 0;
  }
  if (verb === "open") {
    const parsed = parseVerbArgs("open", rest);
    const port = await ensureDaemon(parsed.values.port);
    const project = parsed.values.project;
    if (project !== undefined) {
      const res = await fetch(`http://127.0.0.1:${port}/projects`);
      const body = await res.json();
      if (!body.projects.some((p) => p.id === project)) {
        throw usageError(`unknown project: ${project} (open never creates one \u2014 use \`projects --create <title>\` first)`, { choices: body.projects.map((p) => p.id) });
      }
    }
    const url = `http://127.0.0.1:${port}${project ? `/?project=${encodeURIComponent(project)}` : ""}`;
    if (!parsed.values["no-open"])
      openBrowser(url);
    process.stdout.write(`${JSON.stringify({ ok: true, url })}
`);
    return 0;
  }
  if (verb === "state") {
    const parsed = parseVerbArgs("state", rest);
    const port = requireDaemon();
    const params = new URLSearchParams;
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    if (parsed.values.batch)
      params.set("batch", parsed.values.batch);
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/state${qs}`);
    const stateText = await passOrThrow(res);
    if (parsed.values.skeleton) {
      const state = JSON.parse(stateText);
      process.stdout.write(`${JSON.stringify(toSkeleton(state))}
`);
    } else {
      process.stdout.write(`${stateText}
`);
    }
    return 0;
  }
  if (verb === "changes") {
    const parsed = parseVerbArgs("changes", rest);
    if (parsed.values.since === undefined) {
      throw usageError("changes requires --since <epochSeconds> (use 0 for everything, then pass back the `now` from the previous response)", {
        hint: "ADDITIONS ONLY \u2014 the response's notCovered names what it cannot see; a full `state` read is still the only way to reconcile deletions, rejections and in-place edits"
      });
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ since: parsed.values.since });
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/changes?${params}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "tail") {
    const parsed = parseVerbArgs("tail", rest);
    const inbound = parsed.values.inbound === true;
    requireDaemon();
    const idleMs = envMs("MIND_MAPPER_TAIL_IDLE_MS", 45000);
    const retryMs = envMs("MIND_MAPPER_TAIL_RETRY_MS", 1000);
    const since = Number.parseInt(parsed.values.since, 10);
    let cursor = Number.isFinite(since) ? since : 0;
    let epoch = null;
    let grounded = false;
    for (;; ) {
      const port = livePort();
      if (port === null) {
        await new Promise((r) => setTimeout(r, retryMs));
        continue;
      }
      const params = new URLSearchParams({ since: String(cursor) });
      if (parsed.values.project)
        params.set("project", parsed.values.project);
      if (inbound)
        params.set("inbound", "1");
      const controller = new AbortController;
      let watchdog = null;
      const resetWatchdog = () => {
        if (watchdog !== null)
          clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), idleMs);
      };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/events?${params}`, {
          signal: controller.signal
        });
        if (res.status === 409 || res.status === 404) {
          if (watchdog !== null)
            clearTimeout(watchdog);
          await passOrThrow(res);
        }
        if (!res.body)
          throw new Error("no body");
        resetWatchdog();
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buf = "";
        for (;; ) {
          const { done, value } = await reader.read();
          if (done)
            break;
          resetWatchdog();
          buf += decoder.decode(value, { stream: true });
          for (let idx = buf.indexOf(`

`);idx !== -1; idx = buf.indexOf(`

`)) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split(`
`).find((l) => l.startsWith("data: "));
            if (!dataLine)
              continue;
            const line = dataLine.slice("data: ".length);
            try {
              const event = JSON.parse(line);
              if (event.kind === "grounding") {
                if (!grounded) {
                  grounded = true;
                  process.stdout.write(`${line}
`);
                }
                continue;
              }
              if (typeof event.epoch === "string") {
                if (epoch !== null && event.epoch !== epoch) {
                  cursor = 0;
                  process.stdout.write(`${JSON.stringify({ kind: "epoch.changed", epoch: event.epoch })}
`);
                }
                epoch = event.epoch;
              }
              if (typeof event.seq === "number")
                cursor = event.seq;
            } catch {}
            process.stdout.write(`${line}
`);
          }
        }
      } catch (e) {
        if (e instanceof CliError)
          throw e;
      } finally {
        if (watchdog !== null)
          clearTimeout(watchdog);
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }
  if (verb === "projects") {
    const parsed = parseVerbArgs("projects", rest);
    const port = requireDaemon();
    if (parsed.values.create) {
      const title = parsed.values.create;
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const res2 = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        body: JSON.stringify({ id, title })
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "ingest") {
    const parsed = parseVerbArgs("ingest", rest);
    if (!parsed.values.title) {
      throw usageError("ingest requires --title");
    }
    if (!parsed.values.file && !parsed.values.stdin) {
      throw usageError("ingest requires --file <path> or --stdin");
    }
    const text = parsed.values.file ? readFileSync(parsed.values.file, "utf8") : await Bun.stdin.text();
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/ingest${qs}`, {
      method: "POST",
      body: JSON.stringify({ title: parsed.values.title, text })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "propose-node" || verb === "propose-edge") {
    const parsed = parseVerbArgs(verb, rest);
    if (!parsed.values.stdin) {
      throw usageError(`${verb} requires --stdin JSON {draft, evidence[, suggestedTier, author, tags, batchId]}`, {
        hint: 'propose-edge endpoints: a node id, a pending node-proposal id, or "title:<exact node title>" ' + "(title refs resolve at INTAKE against ratified nodes only, exact + case-sensitive; " + "an ambiguous title errors and names every candidate id)"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals${qs}`, {
      method: "POST",
      body: JSON.stringify({
        kind: verb === "propose-node" ? "node" : "edge",
        draft: input.draft,
        evidence: input.evidence ?? {},
        suggestedTier: input.suggestedTier,
        author: input.author,
        zone: parsed.values.zone,
        tags: input.tags,
        batchId: input.batchId
      })
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}
`);
    if (verb === "propose-edge") {
      try {
        const { warning } = JSON.parse(responseText);
        if (typeof warning === "string")
          process.stderr.write(`# warning: ${warning}
`);
      } catch {}
    }
    return 0;
  }
  if (verb === "propose-batch") {
    const parsed = parseVerbArgs("propose-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError("propose-batch requires --stdin JSON {nodes:[{ref, draft, suggestedTier?, evidence?}], edges:[{draft:{source, target, label?}}]}", {
        hint: "an edge endpoint may be a node LOCAL REF (matches a node's ref in this batch), " + 'a real node id, a pending proposal id, or "title:<exact node title>" \u2014 local refs ' + "resolve to minted ids and title refs to ratified node ids, both server-side; " + "optional batchId: omit and one is MINTED + returned; supply one to extend that act"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/batch${qs}`, {
      method: "POST",
      body: JSON.stringify({
        nodes: input.nodes ?? [],
        edges: input.edges ?? [],
        batchId: input.batchId
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "ratify-batch") {
    const parsed = parseVerbArgs("ratify-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError('ratify-batch requires --stdin JSON {ruling: "canon|thread|story-local", ids: [proposalId], anchors?: [{node, parent}]}', {
        hint: "ratifies the set in ONE call/txn; nodes ratify before edges (auto-partitioned), " + "edge endpoints + anchor refs resolve old proposal ids \u2192 minted node ids via the " + "returned idMap. NO auto-include of unlisted edges; reject is not a batch act"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/ratify-batch${qs}`, {
      method: "POST",
      body: JSON.stringify({
        ruling: input.ruling,
        ids: input.ids ?? [],
        anchors: input.anchors
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "delete-batch") {
    const parsed = parseVerbArgs("delete-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError('delete-batch requires --stdin JSON {ids: ["<proposalId>", ...]}', {
        hint: "deletes the set in ONE txn \u2014 all-or-nothing: if any id is unknown, NOTHING is " + "deleted and the error names every unknown id. There is deliberately no " + "{batch: <id>} shorthand \u2014 run `state --batch <id>` and look before you sweep " + "(drive #10's bug was an over-broad cleanup that took the edges with it)"
      });
    }
    const input = JSON.parse(await Bun.stdin.text());
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/delete-batch${qs}`, {
      method: "POST",
      body: JSON.stringify({ ids: input.ids ?? [] })
    });
    const deleteBatchBody = await passOrThrow(res);
    process.stdout.write(`${deleteBatchBody}
`);
    try {
      const { warning } = JSON.parse(deleteBatchBody);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
    return 0;
  }
  if (verb === "node") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("node").includes(sub)) {
      throw usageError(sub === undefined ? "node requires a sub-command" : `unknown node sub-command: ${sub}`, { choices: subsOf("node") });
    }
    const parsed = parseVerbArgs(`node ${sub}`, rest.slice(1));
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "delete") {
      const id2 = parsed.positionals[0];
      if (!id2) {
        throw usageError("usage: cli.ts node delete <nodeId> [--force]");
      }
      const port2 = requireDaemon();
      const params = new URLSearchParams;
      if (parsed.values.project)
        params.set("project", parsed.values.project);
      if (parsed.values.force)
        params.set("force", "1");
      const dqs = params.size > 0 ? `?${params}` : "";
      const res2 = await fetch(`http://127.0.0.1:${port2}/nodes/${id2}${dqs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    if (sub === "edit") {
      const id2 = parsed.positionals[0];
      const patch = {};
      if (parsed.values.stdin) {
        Object.assign(patch, JSON.parse(await Bun.stdin.text()));
      }
      if (parsed.values.title !== undefined)
        patch.title = parsed.values.title;
      if (parsed.values.synopsis !== undefined)
        patch.synopsis = parsed.values.synopsis;
      if (!id2 || patch.title === undefined && patch.synopsis === undefined) {
        throw usageError(`usage: cli.ts node edit <nodeId> (--title <t> | --synopsis <s> | --stdin '{"synopsis": "..."}')`, {
          hint: "writes exactly what it is given (no inference); only title/synopsis are editable \u2014 " + "tier is the human's ruling and kind is a ratification-time classification"
        });
      }
      const port2 = requireDaemon();
      const res2 = await fetch(`http://127.0.0.1:${port2}/nodes/${id2}${qs}`, {
        method: "POST",
        body: JSON.stringify({
          ...patch.title !== undefined ? { title: patch.title } : {},
          ...patch.synopsis !== undefined ? { synopsis: patch.synopsis } : {}
        })
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    if (sub !== "anchor") {
      throw usageError(`usage: cli.ts node anchor <nodeId> (--to <parentId> | --clear) | node edit <nodeId> (--title <t> | --synopsis <s> | --stdin) | node delete <nodeId> [--force]
`);
    }
    const id = parsed.positionals[0];
    const hasTo = parsed.values.to !== undefined;
    if (!id || hasTo && parsed.values.clear || !hasTo && !parsed.values.clear) {
      throw usageError(`usage: cli.ts node anchor <nodeId> (--to <parentId> | --clear)
` + `  --to anchors the node under <parentId> (a real node id); --clear moves it to top-level
`);
    }
    const port = requireDaemon();
    const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}/anchor${qs}`, {
      method: "POST",
      body: JSON.stringify({ parentId: parsed.values.clear ? null : parsed.values.to })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "read" || verb === "message") {
    const parsed = parseVerbArgs("read", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts read <messageId>");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/message/${id}${qs}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "zone") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("zone").includes(sub)) {
      throw usageError(sub === undefined ? "zone requires a sub-command" : `unknown zone sub-command: ${sub}`, { choices: subsOf("zone") });
    }
    const parsed = parseVerbArgs(`zone ${sub}`, rest.slice(1));
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "create") {
      const name = parsed.positionals.join(" ");
      if (!name) {
        throw usageError("usage: cli.ts zone create <name>");
      }
      const res = await fetch(`http://127.0.0.1:${port}/zones${qs}`, {
        method: "POST",
        body: JSON.stringify({ name })
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "list") {
      const res = await fetch(`http://127.0.0.1:${port}/zones${qs}`);
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts zone delete <id> [--yes]");
      }
      const params = new URLSearchParams;
      if (parsed.values.project)
        params.set("project", parsed.values.project);
      if (parsed.values.yes)
        params.set("yes", "1");
      const dqs = params.size > 0 ? `?${params}` : "";
      const res = await fetch(`http://127.0.0.1:${port}/zones/${id}${dqs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    throw usageError("usage: cli.ts zone <create <name> | list | delete <id> [--yes]>");
  }
  if (verb === "promote") {
    const parsed = parseVerbArgs("promote", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts promote <proposalId>");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/promote${qs}`, {
      method: "POST"
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "proposal") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("proposal").includes(sub)) {
      throw usageError(sub === undefined ? "proposal requires a sub-command" : `unknown proposal sub-command: ${sub}`, { choices: subsOf("proposal") });
    }
    const parsed = parseVerbArgs(`proposal ${sub}`, rest.slice(1));
    const pqs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "delete") {
      const id2 = parsed.positionals[0];
      if (!id2) {
        throw usageError("usage: cli.ts proposal delete <proposalId>");
      }
      const port2 = requireDaemon();
      const res2 = await fetch(`http://127.0.0.1:${port2}/proposals/${id2}${pqs}`, {
        method: "DELETE"
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    if (sub !== "zone") {
      throw usageError(`usage: cli.ts proposal zone <id> (--to <zoneId> | --clear) | proposal delete <id>
`);
    }
    const id = parsed.positionals[0];
    const hasTo = parsed.values.to !== undefined;
    if (!id || hasTo && parsed.values.clear || !hasTo && !parsed.values.clear) {
      throw usageError(`usage: cli.ts proposal zone <proposalId> (--to <zoneId> | --clear)
` + `  --to moves a PENDING proposal INTO <zoneId>; --clear moves it back to the main queue
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/zone${qs}`, {
      method: "POST",
      body: JSON.stringify({ zoneId: parsed.values.clear ? null : parsed.values.to })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "doc") {
    const probe = parseArgs({
      args: rest,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true
    });
    const docPath = probe.positionals[0] === "kind" ? "doc kind" : probe.positionals[0] === "delete" ? "doc delete" : "doc";
    const parsed = parseVerbArgs(docPath, rest);
    if (parsed.positionals[0] === "kind") {
      const docId = parsed.positionals[1];
      const kindWords = parsed.positionals.slice(2).join(" ");
      if (!docId || kindWords === "" && !parsed.values.clear) {
        throw usageError(`usage: cli.ts doc kind <docId> <kind> [--author user|agent] | doc kind <docId> --clear
`);
      }
      const port2 = requireDaemon();
      const qs2 = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
      const res2 = await fetch(`http://127.0.0.1:${port2}/doc/${docId}/kind${qs2}`, {
        method: "POST",
        body: JSON.stringify(parsed.values.clear ? { kind: null } : { kind: kindWords, author: parsed.values.author ?? "agent" })
      });
      process.stdout.write(`${await passOrThrow(res2)}
`);
      return 0;
    }
    const isDelete = parsed.positionals[0] === "delete";
    const id = isDelete ? parsed.positionals[1] : parsed.positionals[0];
    if (!id) {
      throw usageError(`usage: cli.ts doc <id> | doc delete <id> [--force] | doc kind <docId> <kind|--clear> [--project <id>]
`);
    }
    const port = requireDaemon();
    const params = new URLSearchParams;
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    if (isDelete && parsed.values.force)
      params.set("force", "1");
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/doc/${id}${qs}`, {
      method: isDelete ? "DELETE" : "GET"
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "mark") {
    const parsed = parseVerbArgs("mark", rest);
    const docId = parsed.positionals[0];
    if (!docId || !parsed.values.status) {
      throw usageError("usage: cli.ts mark <docId> --status <s> [--note <t>]");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/doc/${docId}/mark${qs}`, {
      method: "POST",
      body: JSON.stringify({
        author: parsed.values.author ?? "agent",
        note: parsed.values.note,
        status: parsed.values.status
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "search") {
    const parsed = parseVerbArgs("search", rest);
    const query = parsed.positionals.join(" ");
    if (!query) {
      throw usageError("usage: cli.ts search <query...>");
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ q: query });
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/search?${params}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "neighbors") {
    const parsed = parseVerbArgs("neighbors", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts neighbors <nodeId> [--depth 1]");
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ depth: parsed.values.depth ?? "1" });
    if (parsed.values.project)
      params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/neighbors/${id}?${params}`);
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "ratify") {
    const parsed = parseVerbArgs("ratify", rest);
    const proposalId = parsed.positionals[0];
    if (!proposalId || !parsed.values.ruling) {
      throw usageError(`usage: cli.ts ratify <proposalId> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <text>] [--anchor <parentId>]
`);
    }
    if (parsed.values.doc && !parsed.values["doc-edit"]) {
      throw usageError("--doc requires --doc-edit (the drafted doc home)");
    }
    const docEdit = parsed.values["doc-edit"] ? readFileSync(parsed.values["doc-edit"], "utf8") : undefined;
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${proposalId}/ruling${qs}`, {
      method: "POST",
      body: JSON.stringify({
        ruling: parsed.values.ruling,
        docEdit,
        docId: parsed.values.doc,
        span: parsed.values.span,
        anchor: parsed.values.anchor
      })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "lens") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("lens").includes(sub)) {
      throw usageError(sub === undefined ? "lens requires a sub-command" : `unknown lens sub-command: ${sub}`, { choices: subsOf("lens") });
    }
    const parsed = parseVerbArgs(`lens ${sub}`, rest.slice(1));
    if (parsed.values.node !== undefined && parsed.values.doc !== undefined) {
      throw usageError("lens set takes --node OR --doc, not both");
    }
    if (parsed.values.doc !== undefined && parsed.values.depth !== undefined) {
      throw usageError("--depth applies to a node lens only");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "set") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, {
        method: "POST",
        body: JSON.stringify({
          owner: parsed.values.owner ?? "agent",
          nodeId: parsed.values.node,
          docId: parsed.values.doc,
          depth: parsed.values.depth ? Number.parseInt(parsed.values.depth, 10) : undefined
        })
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "clear") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    throw usageError(`usage: cli.ts lens <set (--node <id> [--depth n] | --doc <docId>) | clear>
`);
  }
  if (verb === "look-here") {
    const parsed = parseVerbArgs("look-here", rest);
    const id = parsed.positionals[0];
    if (!id) {
      throw usageError("usage: cli.ts look-here <nodeId>");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/look-here/${id}${qs}`, { method: "POST" });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "actions") {
    const parsed = parseVerbArgs("actions", rest);
    const targetId = parsed.positionals[0];
    const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
    if (!targetId || modes.filter(Boolean).length !== 1) {
      throw usageError(`usage: cli.ts actions <targetId> (--set <json> | --stdin | --clear)
` + `  target is a node id or a PENDING proposal id; json is an array of
` + `  {"id", "label", "seed"} \u2014 empty array (or --clear) removes the slots
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const target = `http://127.0.0.1:${port}/actions/${targetId}${qs}`;
    const res = parsed.values.clear ? await fetch(target, { method: "DELETE" }) : await fetch(target, {
      method: "PUT",
      body: parsed.values.stdin ? await Bun.stdin.text() : parsed.values.set
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}
`);
    try {
      const { warning } = JSON.parse(responseText);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
    return 0;
  }
  if (verb === "tags") {
    const parsed = parseVerbArgs("tags", rest);
    const targetId = parsed.positionals[0];
    const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
    if (!targetId || modes.filter(Boolean).length !== 1) {
      throw usageError(`usage: cli.ts tags <targetId> (--set <json> | --stdin | --clear)
` + `  target is a node id or a PENDING proposal id; json is an array of
` + `  freeform strings \u2014 empty array (or --clear) removes the tags
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const target = `http://127.0.0.1:${port}/tags/${targetId}${qs}`;
    const res = parsed.values.clear ? await fetch(target, { method: "DELETE" }) : await fetch(target, {
      method: "PUT",
      body: parsed.values.stdin ? await Bun.stdin.text() : parsed.values.set
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "job") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("job").includes(sub)) {
      throw usageError(sub === undefined ? "job requires a sub-command" : `unknown job sub-command: ${sub}`, { choices: subsOf("job") });
    }
    const parsed = parseVerbArgs(`job ${sub}`, rest.slice(1));
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const base = (port, suffix = "") => `http://127.0.0.1:${port}/jobs${suffix}${qs}`;
    const bodyFromSource = async () => {
      if (parsed.values["body-file"] !== undefined) {
        const p = parsed.values["body-file"];
        if (!existsSync(p)) {
          throw usageError(`job: --body-file not found: ${p}`);
        }
        return JSON.parse(readFileSync(p, "utf8"));
      }
      if (parsed.values.stdin)
        return JSON.parse(await Bun.stdin.text());
      return null;
    };
    if (sub === "list") {
      const port = requireDaemon();
      const res = await fetch(base(port));
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "create") {
      const override = await bodyFromSource();
      const body = override ?? {
        title: parsed.values.title,
        status: parsed.values.status,
        deliverable: parsed.values.deliverable,
        detail: parsed.values.detail
      };
      if (typeof body.title !== "string" || body.title === "") {
        throw usageError(`usage: cli.ts job create --title <t> [--status <s>] [--deliverable <ref>] [--detail <x>]
` + `  or: cli.ts job create (--stdin | --body-file <path>) with JSON {title, status?, deliverable?, detail?}
`);
      }
      const port = requireDaemon();
      const res = await fetch(base(port), { method: "POST", body: JSON.stringify(body) });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "update") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError(`usage: cli.ts job update <id> [--title <t>] [--status <s>] [--deliverable <ref>] [--detail <x>]
`);
      }
      const override = await bodyFromSource();
      const body = override ?? Object.fromEntries(["title", "status", "deliverable", "detail"].filter((k) => parsed.values[k] !== undefined).map((k) => [k, parsed.values[k]]));
      if (Object.keys(body).length === 0) {
        throw usageError(`usage: cli.ts job update <id> (at least one of --title|--status|--deliverable|--detail)
`);
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}`), { method: "POST", body: JSON.stringify(body) });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "claim") {
      const id = parsed.positionals[0];
      if (!id || parsed.values.owner === undefined) {
        throw usageError("usage: cli.ts job claim <id> --owner <who>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/claim`), {
        method: "POST",
        body: JSON.stringify({ owner: parsed.values.owner })
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "release") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts job release <id>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/release`), { method: "POST" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "subtask") {
      const id = parsed.positionals[0];
      const modes = [
        parsed.values.add !== undefined,
        parsed.values.check !== undefined,
        parsed.values.uncheck !== undefined
      ];
      if (!id || modes.filter(Boolean).length !== 1) {
        throw usageError(`usage: cli.ts job subtask <id> (--add <label> | --check <subtaskId> | --uncheck <subtaskId>)
`);
      }
      const jobBody = parsed.values.add !== undefined ? { op: "add", label: parsed.values.add } : parsed.values.check !== undefined ? { op: "check", subtaskId: parsed.values.check } : { op: "uncheck", subtaskId: parsed.values.uncheck };
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/subtask`), {
        method: "POST",
        body: JSON.stringify(jobBody)
      });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts job delete <id>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}`), { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}
`);
      return 0;
    }
    throw usageError(`usage: cli.ts job <create|update <id>|claim <id> --owner <who>|release <id>|subtask <id> ...|list|delete <id>>
`);
  }
  if (verb === "activity") {
    const parsed = parseVerbArgs("activity", rest);
    const state = parsed.positionals[0];
    if (state !== "received" && state !== "thinking" && state !== "idle") {
      throw usageError("usage: cli.ts activity <received|thinking|idle> [--message <id>]");
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/activity${qs}`, {
      method: "POST",
      body: JSON.stringify({ state, messageId: parsed.values.message })
    });
    process.stdout.write(`${await passOrThrow(res)}
`);
    return 0;
  }
  if (verb === "send") {
    const parsed = parseVerbArgs("send", rest);
    const hasInline = parsed.positionals.length > 0;
    let text;
    let fromInline = false;
    if (parsed.values["body-file"] !== undefined) {
      const path = parsed.values["body-file"];
      if (!existsSync(path)) {
        throw usageError(`send: --body-file not found: ${path}`);
      }
      text = readFileSync(path, "utf8").replace(/\n$/, "");
    } else if (parsed.values.stdin || !hasInline && !process.stdin.isTTY) {
      text = (await Bun.stdin.text()).replace(/\n$/, "");
    } else {
      text = parsed.positionals.join(" ");
      fromInline = true;
    }
    if (text === "") {
      throw usageError(`usage: cli.ts send <text...> | --body-file <path> | --stdin
` + `mind-mapper: send resolved an empty body \u2014 nothing sent
`);
    }
    if (!parsed.values.force && /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\bsend\b/.test(text)) {
      throw usageError("mind-mapper: that body looks like a leaked cli invocation (a fumbled heredoc?). " + "Nothing was sent. Pipe the real body via --stdin or --body-file <path>, " + `or pass --force to send it anyway.
`);
    }
    if (fromInline && /`|\$\(|\$\{/.test(text)) {
      process.stderr.write("# warning: inline body contains shell metacharacters (backtick, $(), curly-brace vars). " + "It was sent as-is, but the shell can command-substitute these first \u2014 " + `use --body-file or --stdin for code-bearing messages.
`);
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/send${qs}`, {
      method: "POST",
      body: JSON.stringify({
        role: parsed.values.role ?? "agent",
        kind: parsed.values.kind ?? "turn",
        text,
        ground: (() => {
          const refs = (parsed.values.ground ?? []).flatMap((g) => g.split(",")).map((g) => g.trim()).filter((g) => g !== "");
          return refs.length > 0 ? refs : undefined;
        })()
      })
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}
`);
    try {
      const { warning } = JSON.parse(responseText);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
    return 0;
  }
  const VERB_CHOICES = [...VERBS, ...Object.keys(VERB_ALIASES)];
  if (verb === undefined) {
    throw usageError("no verb given", { hint: "run: cli.ts help", choices: VERB_CHOICES });
  }
  if (verb.startsWith("-")) {
    throw usageError(`unknown flag at the root: ${verb} (flags belong after a verb; root tokens are --help/-h and --version/-V)`, { hint: "run: cli.ts help", choices: VERB_CHOICES });
  }
  throw usageError(`unknown verb: ${verb}`, { hint: "run: cli.ts help", choices: VERB_CHOICES });
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  VERBS,
  VERB_ALIASES,
  VERB_SPEC,
  run
};

//# debugId=11E94036E332D41E64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBtaW5kLW1hcHBlciDigJQgdGhlIGZ1bGwgdmVyYiBzZXQgKFYxICsgVjEueCArIFJvdW5kIDMpOlxuLy8gICBvcGVuICAgICAgICAgIHNwYXduIChvciBmaW5kKSB0aGUgZGFlbW9uLCBwcmludCBpdHMgdXJsLCBvcGVuIHRoZSBicm93c2VyXG4vLyAgICAgICAgICAgICAgICAgLS1wcm9qZWN0IDxpZD4gc2NvcGVzIHRoZSB1cmwgKD9wcm9qZWN0PSk7IG9wZW4gbmV2ZXIgbWludHMg4oCUXG4vLyAgICAgICAgICAgICAgICAgYW4gdW5rbm93biBpZCBlcnJvcnMgKHVzZSBwcm9qZWN0cyAtLWNyZWF0ZSBmaXJzdClcbi8vICAgICAgICAgICAgICAgICAtLXBvcnQgPG4+IGJpbmRzIGEgU1RBQkxFIHBvcnQgc28gYSBicm93c2VyIHJlZnJlc2ggcmVjb25uZWN0c1xuLy8gICAgICAgICAgICAgICAgIGFjcm9zcyBhbiBlbnZpcm9ubWVudC1yZWFwICsgcmVzdGFydC4gVHdvIHdyaW5rbGVzOiAoMSkgYWdhaW5zdFxuLy8gICAgICAgICAgICAgICAgIGEgTElWRSBkYWVtb24gLS1wb3J0IE4gaXMgSUdOT1JFRCAob3BlbiByZXR1cm5zIHRoZSBleGlzdGluZ1xuLy8gICAgICAgICAgICAgICAgIGRhZW1vbikg4oCUIHRoZSBzdGFibGUgdXJsIGhvbGRzIG9ubHkgaWYgdGhlIEZJUlNUIG9wZW4gc2V0IGl0O1xuLy8gICAgICAgICAgICAgICAgICgyKSBpZiBwb3J0IE4gaXMgYWxyZWFkeSBpbiB1c2UgdGhlIGRhZW1vbiBleGl0cyBhbmQgdGhpcyBwb2xsXG4vLyAgICAgICAgICAgICAgICAgdGltZXMgb3V0IChcImRhZW1vbiBkaWQgbm90IGNvbWUgdXBcIikg4oCUIHBpY2sgYSBmcmVlIHBvcnQuXG4vLyAgIHN0YXRlICAgICAgICAgR0VUIC9zdGF0ZSDihpIgdGhlIHJlYWwgcHJvamVjdCBzbmFwc2hvdCBvbiBzdGRvdXRcbi8vICAgICAgICAgICAgICAgICAtLXNrZWxldG9uIHJldHVybnMgaWRzL3RpdGxlcy9kZWdyZWUgb25seSAoY29udGV4dCBidWRnZXRpbmcpXG4vLyAgICAgICAgICAgICAgICAgZnJlc2ggc3RvcmUgd2l0aCBubyBwcm9qZWN0IOKGkiB0aGUgbmVlZHMtcHJvamVjdCA0MDkgcmlkZXNcbi8vICAgICAgICAgICAgICAgICB0aGUgZXJyb3IgZW52ZWxvcGUgKGNvbmZsaWN0LCBleGl0IDY7IGJvZHkgdW5kZXIgZXJyb3Iuc2VydmVyKVxuLy8gICB0YWlsICAgICAgICAgIE1vbml0b3Itc2hhcGVkOiBHRVQgL2V2ZW50cz9zaW5jZT08Y3Vyc29yPiBTU0Ug4oaSIG9uZSBKU09OXG4vLyAgICAgICAgICAgICAgICAgbGluZSBwZXIgZXZlbnQgb24gc3Rkb3V0XG4vLyAgICAgICAgICAgICAgICAgLS1pbmJvdW5kIGZpbHRlcnMgc2VydmVyLXNpZGUgdG8gaHVtYW4tb3JpZ2luYXRlZCBldmVudHNcbi8vICAgICAgICAgICAgICAgICAoY2hhdCArIGRyb3BwZWQgbm9kZXMpICsgb3BlbnMgd2l0aCBhIGtpbmQ6XCJncm91bmRpbmdcIiBsaW5lXG4vLyAgIHByb2plY3RzICAgICAgbGlzdCBzYXZlZCBwcm9qZWN0czsgLS1jcmVhdGUgPHRpdGxlPiBtYWtlcyBhIG5ldyBvbmVcbi8vICAgaW5nZXN0ICAgICAgICAtLXRpdGxlIFQgKC0tZmlsZSBQIHwgLS1zdGRpbikg4oaSIFBPU1QgL2luZ2VzdFxuLy8gICBwcm9wb3NlLW5vZGUgIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlLCBzdWdnZXN0ZWRUaWVyP30g4oaSIFBPU1QgL3Byb3Bvc2Fsc1xuLy8gICBwcm9wb3NlLWVkZ2UgIHNhbWUgc2hhcGUsIGtpbmQ6IFwiZWRnZVwiIChzb3VyY2UvdGFyZ2V0IG1heSBiZSBhIHJlYWwgbm9kZVxuLy8gICAgICAgICAgICAgICAgIGlkIE9SIGEgcGVuZGluZyBwcm9wb3NhbCdzIGlkIOKAlCByYXRpZnkgcmVzb2x2ZXMgdGhlIGxhdHRlcilcbi8vICAgICAgICAgICAgICAgICAtLXpvbmUgPGlkPiBzdGFnZXMgdGhlIHByb3Bvc2FsIGluIGEgem9uZVxuLy8gICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCAuLi59XSwgZWRnZXM6W3tkcmFmdDp7XG4vLyAgICAgICAgICAgICAgICAgc291cmNlLCB0YXJnZXQsIGxhYmVsP319XX0g4oCUIG9uZSB0cmFuc2FjdGlvbjsgYW4gZWRnZVxuLy8gICAgICAgICAgICAgICAgIGVuZHBvaW50IG1heSBiZSBhIG5vZGUncyBMT0NBTCBSRUYgKHJlc29sdmVkIHRvIHRoZSBtaW50ZWRcbi8vICAgICAgICAgICAgICAgICBpZCBzZXJ2ZXItc2lkZSksIGEgcmVhbCBub2RlIGlkLCBvciBhIHBlbmRpbmcgcHJvcG9zYWwgaWQuXG4vLyAgICAgICAgICAgICAgICAgUmV0dXJucyB7cmVmVG9JZCwgcHJvcG9zYWxzfVxuLy8gICByZWFkIDxpZD4gICAgIEdFVCAvbWVzc2FnZS86aWQg4oaSIHRoZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuLy8gICBub2RlIGFuY2hvciA8aWQ+ICgtLXRvIDxwYXJlbnRJZD4gfCAtLWNsZWFyKSAgUE9TVCAvbm9kZXMvOmlkL2FuY2hvciDigJRcbi8vICAgICAgICAgICAgICAgICBhbmNob3IgYSByZWFsIG5vZGUgdW5kZXIgYSBwYXJlbnQgaW4gdGhlIHN1Ym1hcCB0cmVlLCBvclxuLy8gICAgICAgICAgICAgICAgIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIHRvcC1sZXZlbCAoY3ljbGVzIHJlamVjdGVkKVxuLy8gICB6b25lICAgICAgICAgIGNyZWF0ZSA8bmFtZT4gKHNsdWcgaWQgZGVyaXZlZCkgfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXVxuLy8gICAgICAgICAgICAgICAgIChkZWxldGUgY2FzY2FkZXMgdGhlIHpvbmUncyBwcm9wb3NhbHM7IHBvcHVsYXRlZCB6b25lcyA0MDlcbi8vICAgICAgICAgICAgICAgICB3aXRob3V0IC0teWVzKVxuLy8gICBwcm9tb3RlIDxpZD4gIG1vdmUgYSB6b25lZCBwZW5kaW5nIHByb3Bvc2FsIHRvIHRoZSBtYWluIHJldmlldyBxdWV1ZVxuLy8gICAgICAgICAgICAgICAgIChlZGdlIGVuZHBvaW50cyBtdXN0IHByb21vdGUgZmlyc3Qg4oCUIGVycm9yIG5hbWVzIHRoZW0pXG4vLyAgIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpICBQT1NUIC9wcm9wb3NhbHMvOmlkL3pvbmUg4oCUXG4vLyAgICAgICAgICAgICAgICAgbW92ZSBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyBhIHpvbmUgKHRoZSBpbnZlcnNlIG9mIHByb21vdGUpLFxuLy8gICAgICAgICAgICAgICAgIG9yIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIG1haW5cbi8vICAgZG9jIDxpZD4gICAgICBHRVQgL2RvYy86aWQg4oaSIHRoZSBkb2MgZW52ZWxvcGUgb24gc3Rkb3V0XG4vLyAgIGRvYyBkZWxldGUgPGlkPiBbLS1mb3JjZV0gIERFTEVURSAvZG9jLzppZCDihpIgNDA5IHtlcnJvcjpcImNpdGVkXCIsIGNpdGVkQnl9XG4vLyAgICAgICAgICAgICAgICAgd2hlbiBjaXRlZCBhbmQgdW5mb3JjZWQ7IC0tZm9yY2UgY2FzY2FkZXNcbi8vICAgZG9jIGtpbmQgPGRvY0lkPiA8a2luZD4gWy0tYXV0aG9yIHVzZXJ8YWdlbnRdIHwgZG9jIGtpbmQgPGRvY0lkPiAtLWNsZWFyXG4vLyAgICAgICAgICAgICAgICAgUE9TVCAvZG9jLzppZC9raW5kIOKAlCBhc3NlcnQgKG9yIGNsZWFyKSBhIGRvYydzIGtpbmQ7IGluZ2VzdFxuLy8gICAgICAgICAgICAgICAgIG5ldmVyIGd1ZXNzZXMgb25lICh1bnR5cGVkID0ga2luZCBudWxsIG9uIHRoZSB3aXJlKVxuLy8gICBtYXJrIDxkb2NJZD4gLS1zdGF0dXMgPHM+IFstLW5vdGUgPHQ+XSAgUE9TVCAvZG9jLzppZC9tYXJrIOKGkiBhcHBlbmQgYVxuLy8gICAgICAgICAgICAgICAgIHN0YXR1cyBtYXJrIChkb2MubWFya2VkIGNhcnJpZXMgdGhlIGZ1bGwgbWFyayBpbmxpbmUpXG4vLyAgIGFjdGlvbnMgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpICBQVVQvREVMRVRFXG4vLyAgICAgICAgICAgICAgICAgL2FjdGlvbnMvOnRhcmdldElkIOKAlCByZXBsYWNlICh3aG9sZXNhbGUpIG9yIGNsZWFyIHRoZVxuLy8gICAgICAgICAgICAgICAgIGFjdGlvbiBzbG90cyBvbiBhIG5vZGUgb3IgUEVORElORyBwcm9wb3NhbDsganNvbiBpcyBhblxuLy8gICAgICAgICAgICAgICAgIGFycmF5IG9mIHtpZCwgbGFiZWwsIHNlZWR9OyA+NCBlbnRyaWVzIHdhcm5zIChzb2Z0IGNhcClcbi8vICAgdGFncyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgIFBVVC9ERUxFVEVcbi8vICAgICAgICAgICAgICAgICAvdGFncy86dGFyZ2V0SWQg4oCUIHJlcGxhY2UgKHdob2xlc2FsZSkgb3IgY2xlYXIgdGhlIGZyZWVmb3JtXG4vLyAgICAgICAgICAgICAgICAgdGFncyBvbiBhIG5vZGUgb3IgUEVORElORyBwcm9wb3NhbDsganNvbiBpcyBhbiBhcnJheSBvZlxuLy8gICAgICAgICAgICAgICAgIHN0cmluZ3M7IHRhZ3MgYWxzbyByaWRlIHByb3Bvc2UtKiBzdGRpbiBKU09OIChhIGB0YWdzYCBrZXkpXG4vLyAgIGpvYiAgICAgICAgICAgY3JlYXRlIC0tdGl0bGUgVCBbLS1zdGF0dXMgc10gWy0tZGVsaXZlcmFibGUgcmVmXSBbLS1kZXRhaWwgeF1cbi8vICAgICAgICAgICAgICAgICB8IHVwZGF0ZSA8aWQ+IFstLXRpdGxlLy0tc3RhdHVzLy0tZGVsaXZlcmFibGUvLS1kZXRhaWxdXG4vLyAgICAgICAgICAgICAgICAgfCBjbGFpbSA8aWQ+IC0tb3duZXIgPHdobz4gKGF0b21pYyBsZWFzZTsgNDA5IGlmIGhlbGQgYnlcbi8vICAgICAgICAgICAgICAgICAgIGFub3RoZXIgb3duZXIpIHwgcmVsZWFzZSA8aWQ+IHwgc3VidGFzayA8aWQ+ICgtLWFkZCA8bGFiZWw+XG4vLyAgICAgICAgICAgICAgICAgICB8IC0tY2hlY2sgPHN1YnRhc2tJZD4gfCAtLXVuY2hlY2sgPHN1YnRhc2tJZD4pIHwgbGlzdFxuLy8gICAgICAgICAgICAgICAgIHwgZGVsZXRlIDxpZD4uIEEgcGVyc2lzdGVkIHVuaXQgb2YgQUdFTlQgV09SSyAoc3RhdHVzICtcbi8vICAgICAgICAgICAgICAgICBzdWItdGFza3MgKyBkZWxpdmVyYWJsZSArIG93bmVyKTsgY3JlYXRlL3VwZGF0ZSBhbHNvIHRha2UgYVxuLy8gICAgICAgICAgICAgICAgIGZ1bGwgSlNPTiBib2R5IHZpYSAtLXN0ZGluIC8gLS1ib2R5LWZpbGVcbi8vICAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+ICBQT1NUIC9hY3Rpdml0eSDihpIgZmlyZS1hbmQtZm9yZ2V0XG4vLyAgICAgICAgICAgICAgICAgYWdlbnQuYWN0aXZpdHkgc2lnbmFsICh+NjBzIFRUTCBlbWl0cyBzeW50aGV0aWMgaWRsZSlcbi8vICAgc2VhcmNoIDxxLi4uPiBHRVQgL3NlYXJjaCDihpIge2hpdHM6IFt7a2luZDogbm9kZXxkb2N8bWVzc2FnZSwgLi4ufV19XG4vLyAgIG5laWdoYm9ycyA8aWQ+IFstLWRlcHRoIDFdICBHRVQgL25laWdoYm9ycy86aWQg4oaSIGxvY2FsIGhvb2QgKyBlZGdlIHJlYXNvbnNcbi8vICAgcmF0aWZ5IDxpZD4gLS1ydWxpbmcgY2Fub258dGhyZWFkfHN0b3J5LWxvY2FsfHJlamVjdCBbLS1kb2MtZWRpdCA8ZmlsZT5dXG4vLyAgICAgICAgICAgICAgICAgWy0tZG9jIDxkb2NJZD4gLS1zcGFuIDx0ZXh0Pl0gIHJhdGlmeS10aW1lIGV2aWRlbmNlIGF0dGFjaDpcbi8vICAgICAgICAgICAgICAgICBmb3IgYW4gRVZJREVOQ0UtTEVTUyBub2RlIHByb3Bvc2FsIG9ubHksIC0tZG9jIG5hbWVzIHRoZSBkb2Ncbi8vICAgICAgICAgICAgICAgICBob21lIChtdXN0IGV4aXN0OyByZXF1aXJlcyAtLWRvYy1lZGl0KSBhbmQgbWludHMgdGhlIG5vZGUnc1xuLy8gICAgICAgICAgICAgICAgIHNvdXJjZXMgcm93IHdpdGggdGhlIG9wdGlvbmFsIC0tc3BhbiBleGNlcnB0XG4vLyAgIGxlbnMgc2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxkb2NJZD4pIHwgbGVucyBjbGVhclxuLy8gICBsb29rLWhlcmUgPG5vZGVJZD4gIGZpcmUtb25jZSBhdHRlbnRpb24gbnVkZ2UsIG5vdCBwZXJzaXN0ZWRcbi8vICAgc2VuZCAgICAgICAgICBib2R5IGNoYWluOiAtLWJvZHktZmlsZSA8cGF0aD4gPiAtLXN0ZGluID4gaW5saW5lIDx0ZXh0Li4uPiA+XG4vLyAgICAgICAgICAgICAgICAgcGlwZWQgc3RkaW47IFstLXJvbGUgdXNlcnxhZ2VudF0gWy0ta2luZF0gWy0tZ3JvdW5kIGEsYl1cbi8vICAgICAgICAgICAgICAgICAocmVwZWF0YWJsZSDigJQgcmVwZWF0cyBhY2N1bXVsYXRlLCBjb21tYXMgc3BsaXQgZWl0aGVyIHdheSlcbi8vICAgICAgICAgICAgICAgICBbLS1mb3JjZV0g4oaSIFBPU1QgL3NlbmQuIEVtcHR5IHJlc29sdmVkIGJvZHkgPSB1c2FnZSBlcnJvci4gVGhlXG4vLyAgICAgICAgICAgICAgICAgcGlwZWQgZGVmYXVsdCBIQU5HUyB3aXRoIG5vIHBpcGUgdW5kZXIgYWdlbnQgc2hlbGxzIOKAlCBhbHdheXNcbi8vICAgICAgICAgICAgICAgICBwYXNzIGEgYm9keSAoLS1ib2R5LWZpbGUgcHJlZmVycmVkIGZvciBwcm9zZSkuXG4vLyAgICAgICAgICAgICAgICAgUjExOiAtLWtpbmQgaXMgdGhlIENIQU5ORUwgdGhlIG1lc3NhZ2UgYXJyaXZlZCB0aHJvdWdoXG4vLyAgICAgICAgICAgICAgICAgKHR1cm58YW5hbHl6ZXxjYW52YXM7IG9wZW4gc2V0IOKAlCBhbiB1bmtub3duIG9uZSBpcyBzdG9yZWRcbi8vICAgICAgICAgICAgICAgICB3aXRoIGEgc3RkZXJyIGFkdmlzb3J5LCBuZXZlciByZWplY3RlZCkuXG4vLyAgIGFjdGl2aXR5IDxyZWNlaXZlZHx0aGlua2luZ3xpZGxlPiBbLS1tZXNzYWdlIDxpZD5dICDihpIgUE9TVCAvYWN0aXZpdHkuIFRoZVxuLy8gICAgICAgICAgICAgICAgIG1lc3NhZ2VJZCB0aWVzIHRoZSBzaWduYWwgdG8gT05FIG1lc3NhZ2Ugc28gdGhlIGh1bWFuIHNlZXNcbi8vICAgICAgICAgICAgICAgICB3aGljaCBvbmUgaXMgYmVpbmcgd29ya2VkOyBvbWl0dGVkLCBpdCBpbmhlcml0cyB0aGUgb3BlblxuLy8gICAgICAgICAgICAgICAgIGxhZGRlcidzIG1lc3NhZ2UuIGlkbGUgY2xvc2VzIHRoZSBsYWRkZXIgKHRoZXJlIGlzIG5vIGBkb25lYFxuLy8gICAgICAgICAgICAgICAgIOKAlCBhbiBhZ2VudCBgc2VuZGAgSVMgdGhlIGNvbXBsZXRpb24gc2lnbmFsKS5cbi8vXG4vLyAtLXByb2plY3QgPGlkPiBpcyBhY2NlcHRlZCBieSBldmVyeSB2ZXJiIGFib3ZlIGV4Y2VwdCBvcGVuIChzY29wZXMgdG8gYVxuLy8gbm9uLWRlZmF1bHQgcHJvamVjdDsgb21pdCBmb3IgdGhlIGRlZmF1bHQgcHJvamVjdCkuXG4vL1xuLy8gRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgc3RhdGVkIE9OQ0Ug4oCUIHBlci12ZXJiIHByb3NlIGFib3ZlIG5hbWVzIEhUVFBcbi8vIHN0YXR1c2VzLCB0aGlzIHRhYmxlIGlzIHdoYXQgdGhlIFBST0NFU1MgZG9lcyB3aXRoIHRoZW0pOiBldmVyeSBmYWlsdXJlIGlzXG4vLyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgZW1wdHkg4oCUXG4vLyAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sXG4vLyAgICBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4vLyAgIHVzYWdlIOKGkiBleGl0IDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IChIVFRQIDQwNCkgwrcgY29uZmxpY3Qg4oaSIDZcbi8vICAgKEhUVFAgNDA5KTsgSFRUUCA0MDAgbWFwcyB0byB1c2FnZS4gQSBkYWVtb24gcmVmdXNhbCBjYXJyaWVzIHRoZSBzZXJ2ZXInc1xuLy8gICBvd24gSlNPTiBib2R5IFZFUkJBVElNIHVuZGVyIGVycm9yLnNlcnZlciAobmVlZHMtcHJvamVjdCwgY2l0ZWQsIHpvbmVkLFxuLy8gICB6b25lLW5vdC1lbXB0eSwgY2xhaW0gY29uZmxpY3RzLCDigKYpIOKAlCBicmFuY2ggb24ga2luZC9zZXJ2ZXIsIG5ldmVyIHByb3NlLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5cbi8vIOKblCBFVkVSWSBQQVRIIEJFTE9XIElTIENPTVBVVEVEIEZST00gVEhFIEFSVElGQUNUJ1MgQUREUkVTUywgV0hJQ0ggSVNcbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWluZC1tYXBwZXIvZGlzdC9jbGkuanNgIOKAlCBOT1QgRlJPTSBUSElTIFNPVVJDRVxuLy8gRklMRS4gVGhhdCBpcyB3aGF0IG1ha2VzIHRoZSBgaW1wb3J0Lm1ldGEubWFpbmAgYmxvY2sncyBhYnNlbmNlIGF0IHRoZSBib3R0b21cbi8vIG9mIHRoaXMgZmlsZSBhIHJlcXVpcmVtZW50IHJhdGhlciB0aGFuIGEgdGlkeTogcnVuIGZyb21cbi8vIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9gIHRoZXNlIHJlc29sdmUgaW50byBgc3JjL21pbmQtbWFwcGVyL2AsIHdoaWNoIGhhcyBub1xuLy8gYGRpc3QvaW5kZXguaHRtbGAsIHNvIHRoZSBDTEkgd291bGQgY2hvb3NlIERFViBhbmQgdGhlbiBzcGF3biBhIGRhZW1vbiBmcm9tXG4vLyB0aGUgd3JvbmcgYW5jaG9yLiBgZGlzdC9gIHNpdHMgYXQgdGhlIHNhbWUgZGVwdGggdW5kZXIgdGhlIHNraWxsIHJvb3QgYXMgdGhlXG4vLyBgc2NyaXB0cy9gIGl0IHJlcGxhY2VkLCBzbyBldmVyeSBhbmNlc3RvciBjbGltYiBiZWxvdyBpcyB1bmNoYW5nZWQg4oCUIGFcbi8vIENPSU5DSURFTkNFIE9GIERFUFRILCBhc3NlcnRlZCBieSBgZ3JpbW9pcmUvc3Bhd24tcGF0aC13YXJkLnRlc3QudHNgIHJhdGhlclxuLy8gdGhhbiB0cnVzdGVkIChwbGF5Ym9vayBCNC9CNSkuXG5jb25zdCBTQ1JJUFRfRElSID0gaW1wb3J0Lm1ldGEuZGlyO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIE5PVCBBIEZMQVQgU0lCTElORy4gVGhpcyB3YXMgYGpvaW4oU0NSSVBUX0RJUixcbi8vIFwic2VydmVyLnRzXCIpYCB1bnRpbCB0aGUgYmFja2VuZCBwb3J0IOKAlCBnbGFtb3VyJ3MgZXhhY3Qgc2hpcHBlZCBkZWZlY3Qgc2hhcGUsXG4vLyBjb3JyZWN0IG9ubHkgd2hpbGUgdGhlIENMSSBhbmQgdGhlIGRhZW1vbiBzaGFyZWQgYSBmb2xkZXIuIEZyb20gYGRpc3QvYCB0aGVcbi8vIGZsYXQgZm9ybSBuYW1lcyBgZGlzdC9zZXJ2ZXIudHNgLCB3aGljaCBkb2VzIG5vdCBleGlzdDsgdGhlIHN5bXB0b20gaXMgbm90IGFcbi8vIGNyYXNoIGJ1dCBgZW5zdXJlRGFlbW9uYCdzIHBvbGwgcnVubmluZyBvdXQgdG8gXCJkYWVtb24gZGlkIG5vdCBjb21lIHVwIHdpdGhpblxuLy8gMTBzXCIuIFRoZSBsYXVuY2hlciBpcyB0aGUgcHJvY2VzcyBhIGNhbGxlciBydW5zLCBhbmQgaXQgbGl2ZXMgaW4gYHNjcmlwdHMvYC5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBkZXY6IHRoZSBkYWVtb24gc2VydmVzIGEgQnVuLWJ1bmRsZWQgUmVhY3Qgc3VyZmFjZTsgQnVuIHJlYWRzIGJ1bmZpZy50b21sXG4vLyAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gdGhlIGRhZW1vbidzIGN3ZCBNVVNUIGJlXG4vLyBzcmMvbWluZC1tYXBwZXIvIChzZWFtcyBDb250cmFjdCA1IGN3ZC1waW4pIOKAlCBsYXVuY2hlZCBlbHNld2hlcmUgdGhlIGRldlxuLy8gYnVuZGxlciBjYW5ub3QgY29tcGlsZSB0aGUgc3R5bGVzaGVldCAobWVhc3VyZWQgb24gZ2xhbW91cjogdGhlIHBhZ2UgNTAwcztcbi8vIG1pbmQtbWFwcGVyJ3Mgb3duIGZhaWx1cmUgc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmQgc3RhdGljIOKAlCBubyBidW5maWdcbi8vIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmVcbi8vIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGQgYnJlYWsgc3Bhd24uXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwibWluZC1tYXBwZXJcIik7XG5cbmZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG5jb25zdCBIT01FID0gcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIubWluZC1tYXBwZXJcIik7XG5jb25zdCBQT1JUX0ZJTEUgPSBqb2luKEhPTUUsIFwiZGFlbW9uLnBvcnRcIik7XG5jb25zdCBQSURfRklMRSA9IGpvaW4oSE9NRSwgXCJkYWVtb24ucGlkXCIpO1xuXG5mdW5jdGlvbiBsaXZlUG9ydCgpOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCFleGlzdHNTeW5jKFBPUlRfRklMRSkgfHwgIWV4aXN0c1N5bmMoUElEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcGlkID0gTnVtYmVyLnBhcnNlSW50KHJlYWRGaWxlU3luYyhQSURfRklMRSwgXCJ1dGY4XCIpLnRyaW0oKSwgMTApO1xuICBjb25zdCBwb3J0ID0gTnVtYmVyLnBhcnNlSW50KHJlYWRGaWxlU3luYyhQT1JUX0ZJTEUsIFwidXRmOFwiKS50cmltKCksIDEwKTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUocGlkKSB8fCAhTnVtYmVyLmlzRmluaXRlKHBvcnQpKSByZXR1cm4gbnVsbDtcbiAgdHJ5IHtcbiAgICBwcm9jZXNzLmtpbGwocGlkLCAwKTsgLy8gbGl2ZW5lc3MgcHJvYmUsIG5vIHNpZ25hbCBkZWxpdmVyZWRcbiAgICByZXR1cm4gcG9ydDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7IC8vIHN0YWxlIGRpc2NvdmVyeSBmaWxlc1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbihwb3J0Pzogc3RyaW5nKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcnVubmluZyA9IGxpdmVQb3J0KCk7XG4gIC8vIFJvdW5kIDcgKFBPUlQpOiBhIGxpdmUgZGFlbW9uIElHTk9SRVMgLS1wb3J0IOKAlCB0aGUgc3RhYmxlLXVybCBndWFyYW50ZWVcbiAgLy8gb25seSBob2xkcyBpZiB0aGUgRklSU1Qgb3BlbiBzZXQgdGhlIHBvcnQgKHRoZSBkYWVtb24gYmluZHMgb25jZSBhdCBib290KS5cbiAgaWYgKHJ1bm5pbmcgIT09IG51bGwpIHJldHVybiBydW5uaW5nO1xuICBjb25zdCBwcm9jID0gc3Bhd24oXG4gICAgcHJvY2Vzcy5leGVjUGF0aCxcbiAgICBbXCJydW5cIiwgU0VSVkVSX1NDUklQVCwgXCItLW5vLW9wZW5cIiwgLi4uKHBvcnQgPyBbXCItLXBvcnRcIiwgU3RyaW5nKHBvcnQpXSA6IFtdKV0sXG4gICAge1xuICAgICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgICBzdGRpbzogXCJpZ25vcmVcIixcbiAgICAgIGN3ZDogZGFlbW9uQ3dkKCksXG4gICAgfSxcbiAgKTtcbiAgcHJvYy51bnJlZigpO1xuICAvLyBQb2xsIGRpc2NvdmVyeSB1bnRpbCB0aGUgZGFlbW9uIHdyaXRlcyBpdHMgcG9ydCAoY29sZCBCdW4gYnVuZGxlIGNhbiBsYWcpLlxuICBmb3IgKGxldCBpID0gMDsgaSA8IDEwMDsgaSsrKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgMTAwKSk7XG4gICAgY29uc3QgcG9ydCA9IGxpdmVQb3J0KCk7XG4gICAgaWYgKHBvcnQgIT09IG51bGwpIHJldHVybiBwb3J0O1xuICB9XG4gIHRocm93IG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW4gMTBzXCIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjbWQgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCIgPyBcIm9wZW5cIiA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIiA/IFwic3RhcnRcIiA6IFwieGRnLW9wZW5cIjtcbiAgc3Bhd24oY21kLCBbdXJsXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86IFwiaWdub3JlXCIgfSkudW5yZWYoKTtcbn1cblxuZnVuY3Rpb24gZW52TXMobmFtZTogc3RyaW5nLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgdiA9IE51bWJlci5wYXJzZUludChwcm9jZXNzLmVudltuYW1lXSA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodikgJiYgdiA+IDAgPyB2IDogZmFsbGJhY2s7XG59XG5cbi8vIOKUgOKUgCBlcnJvciBlbnZlbG9wZSAobWFncGllJ3MgdGF4b25vbXksIGJvdW50eSdzIGRlbGl2ZXJ5KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBtaW5kLW1hcHBlciBkZWNsYXJlcyBgZGVmYXVsdE91dHB1dDogXCJqc29uXCJgLCBhbmQgdGhhdCBkZWNsYXJhdGlvbiBpcyBhYm91dFxuLy8gRVZFUlkgc3RyZWFtLCBub3QganVzdCB0aGUgaGFwcHkgcGF0aC4gQSBmYWlsdXJlIGlzIE9ORSBKU09OIGRvY3VtZW50IG9uXG4vLyBzdGRlcnI7IHN0ZG91dCBzdGF5cyBlbXB0eSBiZWNhdXNlIHN0ZG91dCBjYXJyaWVzIGRhdGEgYW5kIGEgZmFpbHVyZSBoYXNcbi8vIG5vbmUuIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24g4oCUIHJld29yZGluZyBhXG4vLyBtZXNzYWdlIG11c3QgbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlc1xuLy8gb24gcHJvc2UuIERlbGl2ZXJ5IGlzIGJvdW50eSdzLCBub3QgbWFncGllJ3M6IFRIUk9XIGFuZCBsZXQgbWFpbigpIGNhdGNoIGFuZFxuLy8gUkVUVVJOIHRoZSBjb2RlIOKAlCB0aGlzIENMSSBzaGlwcyBsYXJnZSBzdGRvdXQgcGF5bG9hZHMsIGFuZCBhIHByb2Nlc3MuZXhpdFxuLy8gaW5zaWRlIGEgZGllKCkgd291bGQgdHJ1bmNhdGUgdGhlbSBhdCA2NSw1MzYgYnl0ZXMgKHNlZSB0aGUgZHJhaW4gaWRpb20gYXRcbi8vIHRoZSBib3R0b20gb2YgdGhpcyBmaWxlKS5cbnR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyBtaW5kLW1hcHBlciAob3IgaXRzIGRhZW1vbiB0cmFuc3BvcnQpIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZCAoY2l0ZWQsIHpvbmVkLCBuZWVkcy1wcm9qZWN0LCBjbGFpbSBoZWxkLCDigKYpXG59O1xuXG4vLyBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIHRoZSBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgZGlzcGF0Y2guXG5sZXQgQ1VSUkVOVF9DT01NQU5EOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGtpbmQ6IEVycktpbmQ7XG4gIGhpbnQ/OiBzdHJpbmc7XG4gIGNob2ljZXM/OiBzdHJpbmdbXTtcbiAgLy8gQSBkYWVtb24tcmVmdXNlZCByZXF1ZXN0IGNhcnJpZXMgdGhlIHNlcnZlcidzIG93biBKU09OIGJvZHkgaGVyZSBWRVJCQVRJTVxuICAvLyAoZGVsaWJlcmF0ZSB3cmFwLW5vdC1wYXNzdGhyb3VnaCBkZWNpc2lvbjogdGhlIHR5cGVkIGRhZW1vbiBlcnJvcnMg4oCUXG4gIC8vIG5lZWRzLXByb2plY3QsIGNpdGVkLCB6b25lZCwgem9uZS1ub3QtZW1wdHksIGNsYWltIGNvbmZsaWN0cyDigJQga2VlcCB0aGVpclxuICAvLyBzaGFwZSBmb3IgY2FsbGVycyB0aGF0IGJyYW5jaCBvbiB0aGVtLCB3aGlsZSB0aGUgcHJvY2Vzcy1sZXZlbCBjb250cmFjdFxuICAvLyBzdGF5cyBPTkUgZW52ZWxvcGUgb24gc3RkZXJyIHdpdGggYW4gZW1wdHkgc3Rkb3V0KS5cbiAgc2VydmVyPzogdW5rbm93bjtcbiAgY29uc3RydWN0b3IoXG4gICAga2luZDogRXJyS2luZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9LFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuaGludCA9IGV4dHJhPy5oaW50O1xuICAgIHRoaXMuY2hvaWNlcyA9IGV4dHJhPy5jaG9pY2VzO1xuICAgIHRoaXMuc2VydmVyID0gZXh0cmE/LnNlcnZlcjtcbiAgfVxufVxuXG5jb25zdCB1c2FnZUVycm9yID0gKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSA9PlxuICBuZXcgQ2xpRXJyb3IoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG5cbmZ1bmN0aW9uIHdyaXRlRW52ZWxvcGUoZTogQ2xpRXJyb3IpOiBudW1iZXIge1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjoge1xuICAgICAgICBraW5kOiBlLmtpbmQsXG4gICAgICAgIGV4aXRfY29kZTogRVhJVF9GT1JbZS5raW5kXSxcbiAgICAgICAgLy8gTm90aGluZyBtaW5kLW1hcHBlciByYWlzZXMgaXMgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkLlxuICAgICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgICBtZXNzYWdlOiBlLm1lc3NhZ2UsXG4gICAgICAgIC4uLihlLmhpbnQgIT09IHVuZGVmaW5lZCA/IHsgaGludDogZS5oaW50IH0gOiB7fSksXG4gICAgICAgIC4uLihlLmNob2ljZXMgIT09IHVuZGVmaW5lZCA/IHsgY2hvaWNlczogZS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAgIC4uLihlLnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGUuc2VydmVyIH0gOiB7fSksXG4gICAgICB9LFxuICAgICAgbWV0YTogeyBjb21tYW5kOiBDVVJSRU5UX0NPTU1BTkQgfSxcbiAgICB9KX1cXG5gLFxuICApO1xuICByZXR1cm4gRVhJVF9GT1JbZS5raW5kXTtcbn1cblxuLy8gVGhlIG9uZSBleGl0IGZvciBldmVyeSBkYWVtb24gcm91bmQtdHJpcDogb2sg4oaSIHRoZSBib2R5IHRleHQgKGNhbGxlciBwcmludHNcbi8vIGl0IG9uIHN0ZG91dCksIHJlZnVzZWQg4oaSIGEgdHlwZWQgQ2xpRXJyb3Igd2hvc2Uga2luZCBtYXBzIG9mZiB0aGUgSFRUUFxuLy8gc3RhdHVzIGFuZCB3aG9zZSBgc2VydmVyYCBmaWVsZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gSlNPTiBib2R5LlxuYXN5bmMgZnVuY3Rpb24gcGFzc09yVGhyb3cocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICBpZiAocmVzLm9rKSByZXR1cm4gdGV4dDtcbiAgbGV0IHNlcnZlcjogdW5rbm93biA9IHRleHQ7XG4gIHRyeSB7XG4gICAgc2VydmVyID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gZGFlbW9uIGJvZHkgcmlkZXMgYXMgdGhlIHJhdyBzdHJpbmcgKi9cbiAgfVxuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICByZXMuc3RhdHVzID09PSA0MDRcbiAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgOiByZXMuc3RhdHVzID09PSA0MDlcbiAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgOiByZXMuc3RhdHVzID09PSA0MDBcbiAgICAgICAgICA/IFwidXNhZ2VcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgYCR7Q1VSUkVOVF9DT01NQU5EID8/IFwicmVxdWVzdFwifSByZWZ1c2VkIChIVFRQICR7cmVzLnN0YXR1c30pYCwge1xuICAgIHNlcnZlcixcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVEYWVtb24oKTogbnVtYmVyIHtcbiAgY29uc3QgcG9ydCA9IGxpdmVQb3J0KCk7XG4gIGlmIChwb3J0ID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IENsaUVycm9yKFwibm90X2ZvdW5kXCIsIFwibm8gZGFlbW9uIHJ1bm5pbmcgKHVzZSBgb3BlbmAgZmlyc3QpXCIpO1xuICB9XG4gIHJldHVybiBwb3J0O1xufVxuXG4vLyBTa2VsZXRvbiBwcm9qZWN0aW9uIOKAlCBpZHMvdGl0bGVzL2RlZ3JlZSBvbmx5LCBubyBzeW5vcHNpcy9jb250ZW50LiBLZXB0IGFzXG4vLyBhIGNsaWVudC1zaWRlIHRyYW5zZm9ybSAodGhlIGRhZW1vbiBzdGF5cyBkdW1iIGFuZCBhbHdheXMgc2VydmVzIHRoZSBmdWxsXG4vLyBzbmFwc2hvdDsgc2tlbGV0b24gaXMgYSBjb3VydGVzeSBzaGFwZSBmb3IgY29udGV4dC1idWRnZXRlZCBhZ2VudCByZWFkcykuXG5mdW5jdGlvbiB0b1NrZWxldG9uKHN0YXRlOiB7XG4gIG5vZGVzOiBBcnJheTx7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGtpbmQ6IHN0cmluZzsgdGllcjogc3RyaW5nIH0+O1xuICBlZGdlczogQXJyYXk8eyBpZDogc3RyaW5nOyBzb3VyY2U6IHN0cmluZzsgdGFyZ2V0OiBzdHJpbmcgfT47XG59KSB7XG4gIGNvbnN0IGRlZ3JlZSA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgZSBvZiBzdGF0ZS5lZGdlcykge1xuICAgIGRlZ3JlZS5zZXQoZS5zb3VyY2UsIChkZWdyZWUuZ2V0KGUuc291cmNlKSA/PyAwKSArIDEpO1xuICAgIGRlZ3JlZS5zZXQoZS50YXJnZXQsIChkZWdyZWUuZ2V0KGUudGFyZ2V0KSA/PyAwKSArIDEpO1xuICB9XG4gIHJldHVybiB7XG4gICAgbm9kZXM6IHN0YXRlLm5vZGVzLm1hcCgobikgPT4gKHtcbiAgICAgIGlkOiBuLmlkLFxuICAgICAgdGl0bGU6IG4udGl0bGUsXG4gICAgICBraW5kOiBuLmtpbmQsXG4gICAgICB0aWVyOiBuLnRpZXIsXG4gICAgICBkZWdyZWU6IGRlZ3JlZS5nZXQobi5pZCkgPz8gMCxcbiAgICB9KSksXG4gIH07XG59XG5cbi8vIOKUgOKUgCB0aGUgZmxhZyByZWdpc3RyeSArIHZlcmIgc3BlYyAobWFncGllJ3MgdHdvLXN0YWdlIHBhcnNlLCBwYXRoLWV4dGVuZGVkKSDilIDilIBcbi8vXG4vLyBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS4gU3RhZ2UgMSBwYXJzZXMgZXZlcnkgaW52b2NhdGlvblxuLy8gYWdhaW5zdCB0aGlzIHdob2xlIHJlZ2lzdHJ5IChzdHJpY3QpLCBzbyBhIHRva2VuIG1pbmQtbWFwcGVyIGhhcyBuZXZlciBoZWFyZFxuLy8gb2YgaXMgcmVmdXNlZCBieSBub2RlOnV0aWwgd2l0aCBpdHMgb3duIG1lc3NhZ2U7IHN0YWdlIDIgdGhlbiBhc2tzIHRoZVxuLy8gcXVlc3Rpb24gdGhlIHBhcnNlciBjYW5ub3Q6IGlzIHRoaXMgZmxhZyBhY2NlcHRlZCBBVCBUSElTIFZFUkIuIFRoZSBvcmRlciBpc1xuLy8gdGhlIHBvaW50IOKAlCBoYW5kaW5nIHBhcnNlQXJncyBhIHBlci12ZXJiIHN1YnNldCB3b3VsZCBhbnN3ZXIgYHN0YXRlIC0tcnVsaW5nYFxuLy8gd2l0aCBcIlVua25vd24gb3B0aW9uICctLXJ1bGluZydcIiwgd2hpY2ggaXMgZmFsc2UgYW5kIHNlbmRzIGFuIGFnZW50IGh1bnRpbmcgYVxuLy8gdHlwbyBpdCBkaWQgbm90IG1ha2UuXG4vL1xuLy8gTk8gREVGQVVMVFMgaW4gdGhlIHJlZ2lzdHJ5LCBzdHJ1Y3R1cmFsbHk6IHN0YWdlIDIgZGV0ZWN0cyBhIHN0cmF5IGZsYWcgYnlcbi8vIGtleS1wcmVzZW5jZSBpbiB0aGUgcGFyc2VkIHZhbHVlcywgYW5kIGEgcmVnaXN0cnkgZGVmYXVsdCB3b3VsZCBwbGFudCB0aGF0XG4vLyBrZXkgb24gZXZlcnkgdmVyYi4gUGVyLXZlcmIgZGVmYXVsdHMgbGl2ZSBhdCB0aGUgY29uc3VtcHRpb24gc2l0ZSAoPz8gXCLigKZcIikuXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYWRkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYW5jaG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYXV0aG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYmF0Y2g6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hlY2s6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBjcmVhdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkZWxpdmVyYWJsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRlcHRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZGV0YWlsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJkb2MtZWRpdFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZmlsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIC8vIHNlbmQgLS1ncm91bmQgaXMgcGFyc2VBcmdzLWBtdWx0aXBsZWAgQlkgU0VBTSAoQ29udHJhY3QgOSBSNDogcmVwZWF0c1xuICAvLyBhY2N1bXVsYXRlLCBjb21tYXMgc3BsaXQpIOKAlCBhbnkgdmVyYiBjb3B5aW5nIHRoZSBwYXR0ZXJuIGNvcGllcyB0aGlzIHRvby5cbiAgZ3JvdW5kOiB7IHR5cGU6IFwic3RyaW5nXCIsIG11bHRpcGxlOiB0cnVlIH0sXG4gIGluYm91bmQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1lc3NhZ2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBub2RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG93bmVyOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcG9ydDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHByb2plY3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByb2xlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcnVsaW5nOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBza2VsZXRvbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzcGFuOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3lub3BzaXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRvOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdW5jaGVjazogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHllczogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB6b25lOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8vIFdISUNIIEZMQUdTIEVBQ0ggQ09NTUFORCBQQVRIIEFDQ0VQVFMg4oCUIGFuZCB0aGUgb25seSBzb3VyY2Ugb2YgdGhlIHZlcmIgc2V0LlxuLy8gS2V5cyBhcmUgUEFUSFMsIG5vdCBiYXJlIHZlcmJzOiBtaW5kLW1hcHBlcidzIGdyYW1tYXIgaXMgdHdvLXRva2VuIGZvciB0aGVcbi8vIHN1Yi1jb21tYW5kZWQgdmVyYnMgKHpvbmUgY3JlYXRlLCBub2RlIGVkaXQsIGpvYiBjbGFpbSDigKYpLCBzbyB0aGUgc3BlY1xuLy8gZXh0ZW5kcyBtYWdwaWUncyBmbGF0IHRhYmxlIHdpdGggc3BhY2Utam9pbmVkIHBhdGhzLiBgcmVzb2x2ZVBhdGhgIHBpY2tzIHRoZVxuLy8gdHdvLXRva2VuIGtleSB3aGVuIHRoZSBzZWNvbmQgdG9rZW4gbmFtZXMgYSBrbm93biBzdWIsIGVsc2UgdGhlIG9uZS10b2tlblxuLy8ga2V5LiBUaGUgaGVscCB0ZXh0LCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgIGFuZCB0aGUgcGFyc2VyIGFsbCByZWFkIHRoaXNcbi8vIG9uZSBvYmplY3Q7IGFkZGluZyBhIGZsYWcgdG8gYSB2ZXJiIGlzIG9uZSBlZGl0LlxuZXhwb3J0IGNvbnN0IFZFUkJfU1BFQyA9IHtcbiAgb3BlbjogW1wibm8tb3BlblwiLCBcInBvcnRcIiwgXCJwcm9qZWN0XCJdLFxuICBzdGF0ZTogW1wic2tlbGV0b25cIiwgXCJiYXRjaFwiLCBcInByb2plY3RcIl0sXG4gIGNoYW5nZXM6IFtcInNpbmNlXCIsIFwicHJvamVjdFwiXSxcbiAgdGFpbDogW1wic2luY2VcIiwgXCJpbmJvdW5kXCIsIFwicHJvamVjdFwiXSxcbiAgcHJvamVjdHM6IFtcImNyZWF0ZVwiXSxcbiAgaW5nZXN0OiBbXCJ0aXRsZVwiLCBcImZpbGVcIiwgXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gIFwicHJvcG9zZS1ub2RlXCI6IFtcInN0ZGluXCIsIFwiem9uZVwiLCBcInByb2plY3RcIl0sXG4gIFwicHJvcG9zZS1lZGdlXCI6IFtcInN0ZGluXCIsIFwiem9uZVwiLCBcInByb2plY3RcIl0sXG4gIFwicHJvcG9zZS1iYXRjaFwiOiBbXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gIFwicmF0aWZ5LWJhdGNoXCI6IFtcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgXCJkZWxldGUtYmF0Y2hcIjogW1wic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICBcIm5vZGUgYW5jaG9yXCI6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICBcIm5vZGUgZWRpdFwiOiBbXCJ0aXRsZVwiLCBcInN5bm9wc2lzXCIsIFwic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICBcIm5vZGUgZGVsZXRlXCI6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgcmVhZDogW1wicHJvamVjdFwiXSxcbiAgXCJ6b25lIGNyZWF0ZVwiOiBbXCJwcm9qZWN0XCJdLFxuICBcInpvbmUgbGlzdFwiOiBbXCJwcm9qZWN0XCJdLFxuICBcInpvbmUgZGVsZXRlXCI6IFtcInllc1wiLCBcInByb2plY3RcIl0sXG4gIHByb21vdGU6IFtcInByb2plY3RcIl0sXG4gIFwicHJvcG9zYWwgem9uZVwiOiBbXCJ0b1wiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgXCJwcm9wb3NhbCBkZWxldGVcIjogW1wicHJvamVjdFwiXSxcbiAgZG9jOiBbXCJwcm9qZWN0XCJdLFxuICBcImRvYyBkZWxldGVcIjogW1wiZm9yY2VcIiwgXCJwcm9qZWN0XCJdLFxuICBcImRvYyBraW5kXCI6IFtcImF1dGhvclwiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgbWFyazogW1wic3RhdHVzXCIsIFwibm90ZVwiLCBcImF1dGhvclwiLCBcInByb2plY3RcIl0sXG4gIHNlYXJjaDogW1wicHJvamVjdFwiXSxcbiAgbmVpZ2hib3JzOiBbXCJkZXB0aFwiLCBcInByb2plY3RcIl0sXG4gIHJhdGlmeTogW1wicnVsaW5nXCIsIFwiZG9jLWVkaXRcIiwgXCJkb2NcIiwgXCJzcGFuXCIsIFwiYW5jaG9yXCIsIFwicHJvamVjdFwiXSxcbiAgXCJsZW5zIHNldFwiOiBbXCJub2RlXCIsIFwiZG9jXCIsIFwiZGVwdGhcIiwgXCJvd25lclwiLCBcInByb2plY3RcIl0sXG4gIFwibGVucyBjbGVhclwiOiBbXCJwcm9qZWN0XCJdLFxuICBcImxvb2staGVyZVwiOiBbXCJwcm9qZWN0XCJdLFxuICBhY3Rpb25zOiBbXCJzZXRcIiwgXCJzdGRpblwiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgdGFnczogW1wic2V0XCIsIFwic3RkaW5cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gIFwiam9iIGNyZWF0ZVwiOiBbXCJ0aXRsZVwiLCBcInN0YXR1c1wiLCBcImRlbGl2ZXJhYmxlXCIsIFwiZGV0YWlsXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIiwgXCJwcm9qZWN0XCJdLFxuICBcImpvYiB1cGRhdGVcIjogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgXCJqb2IgY2xhaW1cIjogW1wib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICBcImpvYiByZWxlYXNlXCI6IFtcInByb2plY3RcIl0sXG4gIFwiam9iIHN1YnRhc2tcIjogW1wiYWRkXCIsIFwiY2hlY2tcIiwgXCJ1bmNoZWNrXCIsIFwicHJvamVjdFwiXSxcbiAgXCJqb2IgbGlzdFwiOiBbXCJwcm9qZWN0XCJdLFxuICBcImpvYiBkZWxldGVcIjogW1wicHJvamVjdFwiXSxcbiAgYWN0aXZpdHk6IFtcIm1lc3NhZ2VcIiwgXCJwcm9qZWN0XCJdLFxuICBzZW5kOiBbXCJyb2xlXCIsIFwia2luZFwiLCBcImdyb3VuZFwiLCBcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwiZm9yY2VcIiwgXCJwcm9qZWN0XCJdLFxuICBoZWxwOiBbXSxcbn0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IChrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlMpW10+O1xuXG50eXBlIFZlcmJQYXRoID0ga2V5b2YgdHlwZW9mIFZFUkJfU1BFQztcblxuLy8gYG1lc3NhZ2VgIGlzIGFuIGFkdmVydGlzZWQgQUxJQVMgb2YgYHJlYWRgIChvbmUgbWVzc2FnZS1mZXRjaCB2ZXJiLCB0d29cbi8vIHNwZWxsaW5ncykg4oCUIGFuIGFsaWFzIG1hcHMgb250byBpdHMgdGFyZ2V0J3MgcGF0aCBhbmQgbmV2ZXIgZ2V0cyBpdHMgb3duXG4vLyBzcGVjIHJvdywgc28gdGhlIHR3byBjYW4gbm90IGRyaWZ0IGFwYXJ0LlxuZXhwb3J0IGNvbnN0IFZFUkJfQUxJQVNFUzogUmVjb3JkPHN0cmluZywgVmVyYlBhdGg+ID0geyBtZXNzYWdlOiBcInJlYWRcIiB9O1xuXG4vLyBUaGUgYWR2ZXJ0aXNlZCB2ZXJiIHJvc3RlciwgREVSSVZFRDogdG9wLWxldmVsIHRva2VucyBvZiB0aGUgc3BlYyBwYXRocy5cbmV4cG9ydCBjb25zdCBWRVJCUyA9IFsuLi5uZXcgU2V0KE9iamVjdC5rZXlzKFZFUkJfU1BFQykubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbi8vIFBhdGhzIHdob3NlIGdyYW1tYXIgdGFrZXMgTk8gZnJlZSBwb3NpdGlvbmFscyAoZXZlcnl0aGluZyB0aGV5IG5lZWQgcmlkZXNcbi8vIGZsYWdzKTsgc3RhZ2UgMiByZWZ1c2VzIGEgc3RyYXkgdG9rZW4gYnkgbmFtZSBpbnN0ZWFkIG9mIHNpbGVudGx5XG4vLyBkcm9wcGluZyBpdC4gRXZlcnkgb3RoZXIgcGF0aCBjb25zdW1lcyBwb3NpdGlvbmFscyAoaWRzLCBxdWVyaWVzLCBwcm9zZSkuXG5jb25zdCBOT19QT1NJVElPTkFMUzogUmVhZG9ubHlTZXQ8VmVyYlBhdGg+ID0gbmV3IFNldChbXG4gIFwib3BlblwiLFxuICBcInN0YXRlXCIsXG4gIFwiY2hhbmdlc1wiLFxuICBcInRhaWxcIixcbiAgXCJpbmdlc3RcIixcbiAgXCJwcm9wb3NlLW5vZGVcIixcbiAgXCJwcm9wb3NlLWVkZ2VcIixcbiAgXCJwcm9wb3NlLWJhdGNoXCIsXG4gIFwicmF0aWZ5LWJhdGNoXCIsXG4gIFwiZGVsZXRlLWJhdGNoXCIsXG4gIFwibGVucyBzZXRcIixcbiAgXCJsZW5zIGNsZWFyXCIsXG4gIFwiaGVscFwiLFxuXSBhcyBWZXJiUGF0aFtdKTtcblxuY29uc3QgZmxhZ3NGb3IgPSAocGF0aDogVmVyYlBhdGgpOiBzdHJpbmdbXSA9PiBWRVJCX1NQRUNbcGF0aF0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuXG5jb25zdCBzdWJzT2YgPSAodmVyYjogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgT2JqZWN0LmtleXMoVkVSQl9TUEVDKVxuICAgIC5maWx0ZXIoKHApID0+IHAuc3RhcnRzV2l0aChgJHt2ZXJifSBgKSlcbiAgICAubWFwKChwKSA9PiBwLnNsaWNlKHZlcmIubGVuZ3RoICsgMSkpO1xuXG4vLyBUV08gU1RBR0VTLCBBTkQgVEhFIE9SREVSIElTIFRIRSBQT0lOVCAoc2VlIHRoZSByZWdpc3RyeSBoZWFkZXIpLiBBbHNvIHNldHNcbi8vIG1ldGEuY29tbWFuZCB0byB0aGUgUkVTT0xWRUQgcGF0aCBzbyBhbiBlbnZlbG9wZSBmcm9tIGBub2RlIGVkaXRgIHNheXMgc28uXG5mdW5jdGlvbiBwYXJzZVZlcmJBcmdzKHBhdGg6IFZlcmJQYXRoLCBhcmdzOiBzdHJpbmdbXSkge1xuICBDVVJSRU5UX0NPTU1BTkQgPSBwYXRoO1xuICBjb25zdCBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgIGFyZ3MsXG4gICAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gICAgc3RyaWN0OiB0cnVlLFxuICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gIH0pO1xuICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KFZFUkJfU1BFQ1twYXRoXSk7XG4gIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXMocGFyc2VkLnZhbHVlcykuZmluZCgoaykgPT4gIWFsbG93ZWQuaGFzKGspKTtcbiAgaWYgKHN0cmF5KSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3BhdGh9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgbWluZC1tYXBwZXIgZmxhZywganVzdCBub3QgdGhpcyB2ZXJiJ3MpYCxcbiAgICAgIHsgY2hvaWNlczogZmxhZ3NGb3IocGF0aCkgfSxcbiAgICApO1xuICB9XG4gIGlmIChOT19QT1NJVElPTkFMUy5oYXMocGF0aCkgJiYgcGFyc2VkLnBvc2l0aW9uYWxzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgYCR7cGF0aH0gdGFrZXMgbm8gcG9zaXRpb25hbCBhcmd1bWVudHMgKGdvdCBcIiR7cGFyc2VkLnBvc2l0aW9uYWxzWzBdfVwiKWAsXG4gICAgICBWRVJCX1NQRUNbcGF0aF0ubGVuZ3RoID4gMCA/IHsgY2hvaWNlczogZmxhZ3NGb3IocGF0aCkgfSA6IHVuZGVmaW5lZCxcbiAgICApO1xuICB9XG4gIHJldHVybiBwYXJzZWQ7XG59XG5cbmNvbnN0IEhFTFAgPSBgbWluZC1tYXBwZXIg4oCUIGEgY28tcHJlc2VudCBrbm93bGVkZ2UgbWFwOiBhIGR1bWIgZGFlbW9uIGhvbGRzIHRoZSBncmFwaCwgdGhlIGNhc3RpbmcgYWdlbnQgZG9lcyB0aGUgdGhpbmtpbmcuXG5cbiAgb3BlbiAgIFstLXByb2plY3QgPGlkPl0gWy0tcG9ydCA8bj5dIFstLW5vLW9wZW5dICAgc3Bhd24gKG9yIGZpbmQpIHRoZSBkYWVtb24sIHByaW50IGl0cyB1cmxcbiAgc3RhdGUgIFstLXNrZWxldG9uXSBbLS1iYXRjaCA8aWQ+XSAgICAgICAgICAgICAgICAgdGhlIHByb2plY3Qgc25hcHNob3QgKHNrZWxldG9uID0gaWRzL3RpdGxlcy9kZWdyZWUpXG4gIGNoYW5nZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPiAgICAgICAgICAgICAgICAgICAgIGJvdW5kZWQgZGVsdGEsIEFERElUSU9OUyBPTkxZIChub3RDb3ZlcmVkIG5hbWVzIHRoZSByZXN0KVxuICB0YWlsICAgWy0tc2luY2UgTl0gWy0taW5ib3VuZF0gICAgICAgICAgICAgICAgICAgICBTU0UgZXZlbnRzIGFzIEpTT05MICh3cmFwIHdpdGggTW9uaXRvcilcbiAgcHJvamVjdHMgWy0tY3JlYXRlIDx0aXRsZT5dICAgICAgICAgICAgICAgICAgICAgICAgbGlzdCBwcm9qZWN0cyAvIGNyZWF0ZSBvbmVcbiAgaW5nZXN0IC0tdGl0bGUgPHQ+ICgtLWZpbGUgPHA+IHwgLS1zdGRpbikgICAgICAgICAgYWRkIGEgZG9jXG4gIHByb3Bvc2Utbm9kZSAtLXN0ZGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0YWdlIGEgbm9kZSBwcm9wb3NhbCAoSlNPTiB7ZHJhZnQsIGV2aWRlbmNlLCAuLi59KVxuICBwcm9wb3NlLWVkZ2UgLS1zdGRpbiBbLS16b25lIDxpZD5dICAgICAgICAgICAgICAgICBzdGFnZSBhbiBlZGdlIHByb3Bvc2FsXG4gIHByb3Bvc2UtYmF0Y2ggLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHN0YWdlIGEgc2V0IGluIG9uZSB0eG4gKHtub2RlcywgZWRnZXN9KVxuICByYXRpZnktYmF0Y2ggLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByYXRpZnkgYSBzZXQgaW4gb25lIHR4biAoe3J1bGluZywgaWRzLCBhbmNob3JzP30pXG4gIGRlbGV0ZS1iYXRjaCAtLXN0ZGluICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlbGV0ZSBhIHByb3Bvc2FsIHNldCBpbiBvbmUgdHhuICh7aWRzfSwgYWxsLW9yLW5vdGhpbmcpXG4gIHJhdGlmeSA8aWQ+IC0tcnVsaW5nIDxyPiBbLS1kb2MtZWRpdCA8ZmlsZT5dIFstLWRvYyA8ZG9jSWQ+IC0tc3BhbiA8dD5dIFstLWFuY2hvciA8cGFyZW50SWQ+XVxuICB6b25lICAgY3JlYXRlIDxuYW1lPiB8IGxpc3QgfCBkZWxldGUgPGlkPiBbLS15ZXNdICBzdGFnaW5nIHBlbnMgZm9yIHByb3Bvc2Fsc1xuICBwcm9tb3RlIDxpZD4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBtb3ZlIGEgem9uZWQgcHJvcG9zYWwgdG8gdGhlIG1haW4gcXVldWVcbiAgcHJvcG9zYWwgem9uZSA8aWQ+ICgtLXRvIDx6PiB8IC0tY2xlYXIpIHwgcHJvcG9zYWwgZGVsZXRlIDxpZD5cbiAgbm9kZSAgIGFuY2hvciA8aWQ+ICgtLXRvIDxwPiB8IC0tY2xlYXIpIHwgZWRpdCA8aWQ+IFstLXRpdGxlLy0tc3lub3BzaXMvLS1zdGRpbl0gfCBkZWxldGUgPGlkPiBbLS1mb3JjZV1cbiAgZG9jICAgIDxpZD4gfCBkZWxldGUgPGlkPiBbLS1mb3JjZV0gfCBraW5kIDxkb2NJZD4gKDxraW5kPiBbLS1hdXRob3IgYV0gfCAtLWNsZWFyKVxuICBtYXJrICAgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICAgICAgICAgICBhcHBlbmQgYSBkb2Mgc3RhdHVzIG1hcmtcbiAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgICBhY3Rpb24gc2xvdHMgb24gYSBub2RlL3BlbmRpbmcgcHJvcG9zYWxcbiAgdGFncyAgIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgICBmcmVlZm9ybSB0YWdzLCBzYW1lIHRhcmdldHNcbiAgam9iICAgIGNyZWF0ZXx1cGRhdGV8Y2xhaW18cmVsZWFzZXxzdWJ0YXNrfGxpc3R8ZGVsZXRlICBwZXJzaXN0ZWQgdW5pdHMgb2YgYWdlbnQgd29ya1xuICBzZWFyY2ggPHF1ZXJ5Li4uPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBGVFMgb3ZlciBub2RlcywgZG9jcywgbWVzc2FnZXNcbiAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuICBsZW5zICAgc2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxpZD4pIHwgbGVucyBjbGVhclxuICBsb29rLWhlcmUgPG5vZGVJZD4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXG4gIHJlYWQgICA8bWVzc2FnZUlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuICBzZW5kICAgPHRleHQuLi4+IHwgLS1ib2R5LWZpbGUgPHA+IHwgLS1zdGRpbiAgICAgICBwb3N0IGEgbWVzc2FnZSAoWy0tcm9sZV0gWy0ta2luZF0gWy0tZ3JvdW5kXSlcbiAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gdGhlIGNhc3RpbmctbG9vcCBsaXZlbmVzcyBzaWduYWxcbiAgaGVscCB8IC0tdmVyc2lvblxuXG4gIC0tcHJvamVjdCA8aWQ+IGlzIGFjY2VwdGVkIGJ5IGV2ZXJ5IHZlcmIgZXhjZXB0IG9wZW4ncyBzcGF3bi10aW1lIGZsYWdzOyBvbWl0IGZvciB0aGUgZGVmYXVsdCBwcm9qZWN0LlxuXG4gIE91dHB1dDogZXZlcnkgdmVyYiBwcmludHMgSlNPTiBvbiBzdGRvdXQgYnkgZGVmYXVsdCwgb25lIGRvY3VtZW50IHBlciBhbnN3ZXIg4oCUXG4gIGV4Y2VwdCB0YWlsLCBhIHN0cmVhbSB0aGF0IHByaW50cyBvbmUgSlNPTiBsaW5lIHBlciBldmVudC4gUHJvc2UsIHdhcm5pbmdzIGFuZFxuICBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnI7IGZhaWx1cmVzIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuYDtcblxuLy8gVGhlIHBsdWdpbiBtYW5pZmVzdCBpcyB0aGUgb25lIHZlcnNpb24gc291cmNlOyB0aGUgQ0xJIHJlYWRzIGl0IHJhdGhlciB0aGFuXG4vLyBtaXJyb3JpbmcgdGhlIG51bWJlciAoYXN0cm9sYWJlJ3MgcGF0dGVybikuIExheW91dC1kZXBlbmRlbnQsIHNvIGFic2VuY2Vcbi8vIGRlZ3JhZGVzIHRvIFwidW5rbm93blwiIGluc3RlYWQgb2YgaW52ZW50aW5nIG9uZS5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKFxuICAgICAgam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIiksXG4gICAgICBcInV0ZjhcIixcbiAgICApO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJtaW5kLW1hcHBlclwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggdG8gdW5rbm93biAqL1xuICB9XG4gIHJldHVybiB7IG5hbWU6IFwibWluZC1tYXBwZXJcIiwgdmVyc2lvbjogXCJ1bmtub3duXCIgfTtcbn1cblxuLy8gcGFyc2VBcmdzIHRocm93cyAoRVJSX1BBUlNFX0FSR1NfVU5LTk9XTl9PUFRJT04gZXRjLikgb24gYW4gdW5yZWNvZ25pemVkXG4vLyBmbGFnIGxpa2UgYSBzdHJheSAtLWhlbHAg4oCUIHVuY2F1Z2h0LCB0aGF0J3MgYSBzdGFjay10cmFjZSBjcmFzaCBpbnN0ZWFkIG9mXG4vLyBhIHVzYWdlIG1lc3NhZ2UgKGNhc3NhbmRyYSdzIFAyIGdhdGUgZmluZGluZykuIEV2ZXJ5IHZlcmIncyBwYXJzZUFyZ3MgY2FsbFxuLy8gZnVubmVscyB0aHJvdWdoIGhlcmUgc28gYSBiYWQgZmxhZyBhbHdheXMgZXhpdHMgMiB3aXRoIGEgb25lLWxpbmUgZXJyb3IuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIENsaUVycm9yKSByZXR1cm4gd3JpdGVFbnZlbG9wZShlKTtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAvLyBBIHN0cmF5L3Vua25vd24gZmxhZyAobm9kZTp1dGlsIHN0cmljdCkgaXMgdGhlIENBTExFUidzIHRvIGZpeC5cbiAgICBpZiAoY29kZS5zdGFydHNXaXRoKFwiRVJSX1BBUlNFX0FSR1NcIikpIHJldHVybiB3cml0ZUVudmVsb3BlKHVzYWdlRXJyb3IobXNnKSk7XG4gICAgLy8gQSBib2R5IHRoYXQgZmFpbGVkIHRvIHBhcnNlIChzdGRpbi8tLWJvZHktZmlsZSBKU09OKSDigJQgYWxzbyB0aGUgY2FsbGVyJ3MuXG4gICAgaWYgKGUgaW5zdGFuY2VvZiBTeW50YXhFcnJvcikgcmV0dXJuIHdyaXRlRW52ZWxvcGUodXNhZ2VFcnJvcihgaW52YWxpZCBKU09OOiAke21zZ31gKSk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUvLS1kb2MtZWRpdCBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHdyaXRlRW52ZWxvcGUodXNhZ2VFcnJvcihtc2cpKTtcbiAgICAvLyBFdmVyeXRoaW5nIGVsc2UgaXMgbWluZC1tYXBwZXIncyBvd24gZmF1bHQ6IG9uZSBJTlRFUk5BTCBlbnZlbG9wZSwgbmV2ZXJcbiAgICAvLyBhIHN0YWNrIHRyYWNlIOKAlCB0aGUgcHJvY2VzcyBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS5cbiAgICByZXR1cm4gd3JpdGVFbnZlbG9wZShuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBtc2cpKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHZlcmIgPSBhcmd2WzBdO1xuICBjb25zdCByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgLy8gVGhlIGVudmVsb3BlIG5hbWVzIHRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiAobWV0YS5jb21tYW5kKTsgcm9vdCB0b2tlbnNcbiAgLy8gYW5kIHRoZSBmYWxsdGhyb3VnaCBsZWF2ZSBpdCBhcyB0aGUgcmF3IGZpcnN0IHRva2VuLCB3aGljaCBpcyB0aGUgaG9uZXN0XG4gIC8vIGFuc3dlciB0byBcIndoYXQgd2FzIGJlaW5nIHJ1biB3aGVuIHRoaXMgZmFpbGVkXCIuXG4gIENVUlJFTlRfQ09NTUFORCA9IHZlcmIgPz8gbnVsbDtcblxuICAvLyBST09UIFRPS0VOUyBGSVJTVCwgYmVmb3JlIGFueSBmbGFnIHBhcnNpbmcgKG1hZ3BpZS9hc3Ryb2xhYmUgcGF0dGVybikuXG4gIC8vIC0taGVscC8taCByZXNvbHZlIGF0IHRoZSByb290OyBgaGVscGAgaXMgQUxTTyBhIGRpc3BhdGNoYWJsZSB2ZXJiIGJlbG93LCBzb1xuICAvLyBgaGVscCAtLWZvb2AgaXMgYSByZWplY3RlZCBmbGFnLCBub3QgYSBzaWxlbnRseS10b2xlcmF0ZWQgb25lLlxuICBpZiAodmVyYiA9PT0gXCItLWhlbHBcIiB8fCB2ZXJiID09PSBcIi1oXCIpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG4gIC8vIFJvb3QgVE9LRU4sIGRlbGliZXJhdGVseSBOT1QgYSBmbGFnOiBubyBwZXItdmVyYiBwYXJzZXIgYmVsb3cgdGhlIHJvb3QgaXNcbiAgLy8gZXZlciBleHBlY3RlZCB0byBhY2NlcHQgaXQsIGFuZCBpdCBjYXJyaWVzIG5vIGZsYWdzIG9mIGl0cyBvd24uXG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIiB8fCB2ZXJiID09PSBcInZlcnNpb25cIikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHZlcnNpb25JbmZvKCkpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG4gIGlmICh2ZXJiID09PSBcImhlbHBcIikge1xuICAgIC8vIERpc3BhdGNoYWJsZSB2ZXJiIHdpdGggYW4gRU1QVFkgZmxhZyBzZXQg4oCUIGEgc3RyaWN0IHBhcnNlIG9mIHRoZSByZXN0XG4gICAgLy8gbWVhbnMgYGhlbHAgLS1mb29gIGlzIHJlZnVzZWQgaW5zdGVhZCBvZiBpZ25vcmVkLlxuICAgIHBhcnNlVmVyYkFyZ3MoXCJoZWxwXCIsIHJlc3QpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJvcGVuXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwib3BlblwiLCByZXN0KTtcbiAgICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKHBhcnNlZC52YWx1ZXMucG9ydCk7XG4gICAgLy8gLS1wcm9qZWN0IHNjb3BlcyB0aGUgcHJpbnRlZCBVUkwgKyBzcGF3bmVkIGJyb3dzZXIgKD9wcm9qZWN0PSByaWRlc1xuICAgIC8vIGFsb25nKS4gT3BlbiBuZXZlciBtaW50czogYW4gdW5rbm93biBpZCBpcyBhIHVzYWdlIGVycm9yIHBvaW50aW5nIGF0XG4gICAgLy8gYHByb2plY3RzIC0tY3JlYXRlYCwgbm90IGEgc2lsZW50IG5ldyBzdG9yZS5cbiAgICBjb25zdCBwcm9qZWN0ID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0O1xuICAgIGlmIChwcm9qZWN0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvamVjdHNgKTtcbiAgICAgIGNvbnN0IGJvZHkgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgeyBwcm9qZWN0czogQXJyYXk8eyBpZDogc3RyaW5nIH0+IH07XG4gICAgICBpZiAoIWJvZHkucHJvamVjdHMuc29tZSgocCkgPT4gcC5pZCA9PT0gcHJvamVjdCkpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICBgdW5rbm93biBwcm9qZWN0OiAke3Byb2plY3R9IChvcGVuIG5ldmVyIGNyZWF0ZXMgb25lIOKAlCB1c2UgXFxgcHJvamVjdHMgLS1jcmVhdGUgPHRpdGxlPlxcYCBmaXJzdClgLFxuICAgICAgICAgIHsgY2hvaWNlczogYm9keS5wcm9qZWN0cy5tYXAoKHApID0+IHAuaWQpIH0sXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3Byb2plY3QgPyBgLz9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHByb2plY3QpfWAgOiBcIlwifWA7XG4gICAgaWYgKCFwYXJzZWQudmFsdWVzW1wibm8tb3BlblwiXSkgb3BlbkJyb3dzZXIodXJsKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh7IG9rOiB0cnVlLCB1cmwgfSl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJzdGF0ZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInN0YXRlXCIsIHJlc3QpO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuYmF0Y2gpIHBhcmFtcy5zZXQoXCJiYXRjaFwiLCBwYXJzZWQudmFsdWVzLmJhdGNoKTtcbiAgICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zdGF0ZSR7cXN9YCk7XG4gICAgLy8gQSBub24tb2sgL3N0YXRlICg0MDkgbmVlZHMtcHJvamVjdCBvbiBhIGZyZXNoIHN0b3JlLCA0MDQgdW5rbm93blxuICAgIC8vIHByb2plY3QpIHJpZGVzIHRoZSBlcnJvciBlbnZlbG9wZSB3aXRoIHRoZSBkYWVtb24gYm9keSB1bmRlclxuICAgIC8vIGVycm9yLnNlcnZlciDigJQgdGhlIHNrZWxldG9uIHRyYW5zZm9ybSBvbmx5IHJ1bnMgb24gYSByZWFsIHNuYXBzaG90LlxuICAgIGNvbnN0IHN0YXRlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuc2tlbGV0b24pIHtcbiAgICAgIGNvbnN0IHN0YXRlID0gSlNPTi5wYXJzZShzdGF0ZVRleHQpIGFzIFBhcmFtZXRlcnM8dHlwZW9mIHRvU2tlbGV0b24+WzBdO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkodG9Ta2VsZXRvbihzdGF0ZSkpfVxcbmApO1xuICAgIH0gZWxzZSB7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtzdGF0ZVRleHR9XFxuYCk7XG4gICAgfVxuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgMTIgKFNFQU0gMyk6IGBjaGFuZ2VzIC0tc2luY2UgPGVwb2NoU2Vjb25kcz5gIOKAlCB0aGUgYm91bmRlZCBkZWx0YS5cbiAgLy8gUmVhZCB0aGUgcmVzcG9uc2UncyBub3RDb3ZlcmVkIGJlZm9yZSB0cnVzdGluZyBhbiBlbXB0eSBvbmU6IFwibm90aGluZ1xuICAvLyBhZGRlZFwiIGlzIE5PVCBcIm5vdGhpbmcgY2hhbmdlZFwiIChkZWxldGlvbnMsIHJlamVjdGlvbnMgYW5kIGluLXBsYWNlIGVkaXRzXG4gIC8vIGFyZSBpbnZpc2libGUgaGVyZSBieSBjb25zdHJ1Y3Rpb24pLlxuICBpZiAodmVyYiA9PT0gXCJjaGFuZ2VzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiY2hhbmdlc1wiLCByZXN0KTtcbiAgICBpZiAocGFyc2VkLnZhbHVlcy5zaW5jZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcImNoYW5nZXMgcmVxdWlyZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPiAodXNlIDAgZm9yIGV2ZXJ5dGhpbmcsIHRoZW4gcGFzcyBiYWNrIHRoZSBgbm93YCBmcm9tIHRoZSBwcmV2aW91cyByZXNwb25zZSlcIixcbiAgICAgICAge1xuICAgICAgICAgIGhpbnQ6IFwiQURESVRJT05TIE9OTFkg4oCUIHRoZSByZXNwb25zZSdzIG5vdENvdmVyZWQgbmFtZXMgd2hhdCBpdCBjYW5ub3Qgc2VlOyBhIGZ1bGwgYHN0YXRlYCByZWFkIGlzIHN0aWxsIHRoZSBvbmx5IHdheSB0byByZWNvbmNpbGUgZGVsZXRpb25zLCByZWplY3Rpb25zIGFuZCBpbi1wbGFjZSBlZGl0c1wiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgc2luY2U6IHBhcnNlZC52YWx1ZXMuc2luY2UgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5nZXM/JHtwYXJhbXN9YCk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInRhaWxcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJ0YWlsXCIsIHJlc3QpO1xuICAgIGNvbnN0IGluYm91bmQgPSBwYXJzZWQudmFsdWVzLmluYm91bmQgPT09IHRydWU7XG4gICAgcmVxdWlyZURhZW1vbigpOyAvLyBubyBkYWVtb24gYXQgc3RhcnQgaXMgYSB1c2FnZSBlcnJvcjsgbWlkLXRhaWwgZGVhdGggaXMgc2VsZi1oZWFsZWQgYmVsb3dcbiAgICAvLyBXYXRjaGRvZyDiiYggMyBtaXNzZWQgc2VydmVyIGtlZXBhbGl2ZXMgKDE1cyB0aWNrLCBDbGFpbSBGKTsgZW52XG4gICAgLy8gb3ZlcnJpZGVzIGFyZSBmb3IgdGhlIHNjcmlwdGVkLWZha2Utc2VydmVyIHRlc3RzIG9ubHkuXG4gICAgY29uc3QgaWRsZU1zID0gZW52TXMoXCJNSU5EX01BUFBFUl9UQUlMX0lETEVfTVNcIiwgNDVfMDAwKTtcbiAgICBjb25zdCByZXRyeU1zID0gZW52TXMoXCJNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TXCIsIDFfMDAwKTtcbiAgICBjb25zdCBzaW5jZSA9IE51bWJlci5wYXJzZUludChwYXJzZWQudmFsdWVzLnNpbmNlIGFzIHN0cmluZywgMTApO1xuICAgIGxldCBjdXJzb3IgPSBOdW1iZXIuaXNGaW5pdGUoc2luY2UpID8gc2luY2UgOiAwO1xuICAgIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgLy8gVGhlIHNlcnZlciAocmUtKWVtaXRzIGEgZ3JvdW5kaW5nIGZyYW1lIGF0IHRoZSB0b3Agb2YgRVZFUlkgaW5ib3VuZCBTU0VcbiAgICAvLyBjb25uZWN0OyBmb3J3YXJkIG9ubHkgdGhlIEZJUlNUIHNvIHRoZSBhZ2VudCdzIE1vbml0b3Igc2VlcyBleGFjdGx5IG9uZVxuICAgIC8vIGdyb3VuZGluZyBsaW5lLCBub3Qgb25lIHBlciByZWNvbm5lY3QgKEY1OiBmaXJzdC1jb25uZWN0IGxpbmUpLlxuICAgIGxldCBncm91bmRlZCA9IGZhbHNlO1xuXG4gICAgLy8gU3RhbmRpbmcsIHNlbGYtaGVhbGluZyBsb29wIChNb25pdG9yLXNoYXBlZCk6IGVhY2ggY29ubmVjdGlvbiBhdHRlbXB0XG4gICAgLy8gZ2V0cyBpdHMgb3duIEFib3J0Q29udHJvbGxlciBwbHVzIGEgcm9sbGluZyBpZGxlIHdhdGNoZG9nIHJlc2V0IG9uXG4gICAgLy8gZXZlcnkgcmVjZWl2ZWQgUkFXIGNodW5rIGJlZm9yZSBmcmFtZSBwYXJzaW5nIOKAlCBrZWVwYWxpdmUgY29tbWVudHMgbXVzdFxuICAgIC8vIGZlZWQgdGhlIHdhdGNoZG9nIGV2ZW4gdGhvdWdoIHRoZSBkYXRhLWxpbmUgZmlsdGVyIGRpc2NhcmRzIHRoZW0uIE9uXG4gICAgLy8gZmlyZSAob3IgYW55IHRyYW5zcG9ydCBlcnJvcik6IGFib3J0IOKGkiByZWNvbm5lY3Qgd2l0aCB0aGUgbGFzdC1zZWVuXG4gICAgLy8gc2VxLiBBIHJlY29ubmVjdCB0aGF0IGxhbmRzIG9uIGEgZGlmZmVyZW50IGVwb2NoIG1lYW5zIHRoZSBkYWVtb25cbiAgICAvLyByZXN0YXJ0ZWQ6IHJlc2V0IHRoZSBjdXJzb3IgdG8gMCBhbmQgc3ludGhlc2l6ZSBhbiB7a2luZDpcbiAgICAvLyBcImVwb2NoLmNoYW5nZWRcIn0gc3Rkb3V0IGxpbmUgc28gdGhlIGNhc3RpbmcgYWdlbnQgcmVmZXRjaGVzIHN0YXRlIOKAlFxuICAgIC8vIENMSS1zeW50aGVzaXplZCBvbmx5LCBuZXZlciBhIGJ1cyBldmVudCAodGhlIGJyb3dzZXIgV1MgbmV2ZXIgc2VlcyBpdCkuXG4gICAgZm9yICg7Oykge1xuICAgICAgY29uc3QgcG9ydCA9IGxpdmVQb3J0KCk7XG4gICAgICBpZiAocG9ydCA9PT0gbnVsbCkge1xuICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCByZXRyeU1zKSk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9KTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgICBpZiAoaW5ib3VuZCkgcGFyYW1zLnNldChcImluYm91bmRcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2V2ZW50cz8ke3BhcmFtc31gLCB7XG4gICAgICAgICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICAgICAgfSk7XG4gICAgICAgIC8vIEEgcmVmdXNlZCBjb25uZWN0aW9uICg0MDkgbmVlZHMtcHJvamVjdCBvbiBhIHByb2plY3RsZXNzIHN0b3JlLFxuICAgICAgICAvLyA0MDQgdW5rbm93biBwcm9qZWN0KSBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSB0cmFuc3BvcnQgYmxpcCDigJRcbiAgICAgICAgLy8gcmV0cnlpbmcgaXQgZm9yZXZlciB3b3VsZCBqdXN0IHNwaW4gc2lsZW50bHkuXG4gICAgICAgIGlmIChyZXMuc3RhdHVzID09PSA0MDkgfHwgcmVzLnN0YXR1cyA9PT0gNDA0KSB7XG4gICAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICAgIC8vIFJldXNlIHRoZSBvbmUgc3RhdHVz4oaSa2luZCBtYXBwaW5nOiBwYXNzT3JUaHJvdyBhbHdheXMgdGhyb3dzIGhlcmUuXG4gICAgICAgICAgYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB0aHJvdyBuZXcgRXJyb3IoXCJubyBib2R5XCIpO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuICAgICAgICBmb3IgKDs7KSB7XG4gICAgICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICBpZiAoZG9uZSkgYnJlYWs7XG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpOyAvLyByYXcgY2h1bmssIGJlZm9yZSBmcmFtZSBwYXJzaW5nXG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKHZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgICAgICBmb3IgKGxldCBpZHggPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgaWR4ICE9PSAtMTsgaWR4ID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGZyYW1lID0gYnVmLnNsaWNlKDAsIGlkeCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2UoaWR4ICsgMik7XG4gICAgICAgICAgICBjb25zdCBkYXRhTGluZSA9IGZyYW1lLnNwbGl0KFwiXFxuXCIpLmZpbmQoKGwpID0+IGwuc3RhcnRzV2l0aChcImRhdGE6IFwiKSk7XG4gICAgICAgICAgICBpZiAoIWRhdGFMaW5lKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBkYXRhTGluZS5zbGljZShcImRhdGE6IFwiLmxlbmd0aCk7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBldmVudCA9IEpTT04ucGFyc2UobGluZSkgYXMgeyBzZXE/OiB1bmtub3duOyBlcG9jaD86IHVua25vd247IGtpbmQ/OiB1bmtub3duIH07XG4gICAgICAgICAgICAgIC8vIEdyb3VuZGluZyBpcyBhIHN5bnRoZXRpYywgc2VxLWxlc3MgZmlyc3QtY29ubmVjdCBmcmFtZSDigJQgZm9yd2FyZFxuICAgICAgICAgICAgICAvLyB0aGUgZmlyc3QsIHN1cHByZXNzIHJlLWdyb3VuZGluZ3Mgb24gcmVjb25uZWN0IChleGFjdGx5IG9uZSBwZXJcbiAgICAgICAgICAgICAgLy8gcHJvY2VzcykuIEl0IG5ldmVyIGNhcnJpZXMgc2VxL2Vwb2NoLCBzbyBjdXJzb3IvZXBvY2ggYXJlXG4gICAgICAgICAgICAgIC8vIHVudG91Y2hlZCBlaXRoZXIgd2F5LlxuICAgICAgICAgICAgICBpZiAoZXZlbnQua2luZCA9PT0gXCJncm91bmRpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgICAgICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgZXZlbnQuZXBvY2ggPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgZXZlbnQuZXBvY2ggIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsga2luZDogXCJlcG9jaC5jaGFuZ2VkXCIsIGVwb2NoOiBldmVudC5lcG9jaCB9KX1cXG5gLFxuICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBldmVudC5lcG9jaDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAodHlwZW9mIGV2ZW50LnNlcSA9PT0gXCJudW1iZXJcIikgY3Vyc29yID0gZXZlbnQuc2VxO1xuICAgICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAgIC8qIG5vbi1KU09OIGRhdGEgbGluZSDigJQgcGFzcyB0aHJvdWdoIHVudHJhY2tlZCAqL1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgLy8gQSB0eXBlZCByZWZ1c2FsICg0MDkvNDA0IHZpYSBwYXNzT3JUaHJvdykgaXMgYSB1c2FnZS1jbGFzcyBleGl0LCBub3RcbiAgICAgICAgLy8gYSB0cmFuc3BvcnQgYmxpcCDigJQgcmV0cnlpbmcgaXQgZm9yZXZlciB3b3VsZCBqdXN0IHNwaW4gc2lsZW50bHkuXG4gICAgICAgIGlmIChlIGluc3RhbmNlb2YgQ2xpRXJyb3IpIHRocm93IGU7XG4gICAgICAgIC8qIHdhdGNoZG9nIGFib3J0IG9yIHRyYW5zcG9ydCBlcnJvciDigJQgcmVjb25uZWN0IGJlbG93ICovXG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICB9XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCByZXRyeU1zKSk7XG4gICAgfVxuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicHJvamVjdHNcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJwcm9qZWN0c1wiLCByZXN0KTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGlmIChwYXJzZWQudmFsdWVzLmNyZWF0ZSkge1xuICAgICAgY29uc3QgdGl0bGUgPSBwYXJzZWQudmFsdWVzLmNyZWF0ZTtcbiAgICAgIGNvbnN0IGlkID0gdGl0bGVcbiAgICAgICAgLnRvTG93ZXJDYXNlKClcbiAgICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgICAgIC5yZXBsYWNlKC9eLSt8LSskL2csIFwiXCIpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2AsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZCwgdGl0bGUgfSksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2ApO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJpbmdlc3RcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJpbmdlc3RcIiwgcmVzdCk7XG4gICAgaWYgKCFwYXJzZWQudmFsdWVzLnRpdGxlKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiaW5nZXN0IHJlcXVpcmVzIC0tdGl0bGVcIik7XG4gICAgfVxuICAgIGlmICghcGFyc2VkLnZhbHVlcy5maWxlICYmICFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiaW5nZXN0IHJlcXVpcmVzIC0tZmlsZSA8cGF0aD4gb3IgLS1zdGRpblwiKTtcbiAgICB9XG4gICAgY29uc3QgdGV4dCA9IHBhcnNlZC52YWx1ZXMuZmlsZVxuICAgICAgPyByZWFkRmlsZVN5bmMocGFyc2VkLnZhbHVlcy5maWxlLCBcInV0ZjhcIilcbiAgICAgIDogYXdhaXQgQnVuLnN0ZGluLnRleHQoKTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9pbmdlc3Qke3FzfWAsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHRpdGxlOiBwYXJzZWQudmFsdWVzLnRpdGxlLCB0ZXh0IH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiB8fCB2ZXJiID09PSBcInByb3Bvc2UtZWRnZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyh2ZXJiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIGAke3ZlcmJ9IHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlWywgc3VnZ2VzdGVkVGllciwgYXV0aG9yLCB0YWdzLCBiYXRjaElkXX1gLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgICdwcm9wb3NlLWVkZ2UgZW5kcG9pbnRzOiBhIG5vZGUgaWQsIGEgcGVuZGluZyBub2RlLXByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiICcgK1xuICAgICAgICAgICAgXCIodGl0bGUgcmVmcyByZXNvbHZlIGF0IElOVEFLRSBhZ2FpbnN0IHJhdGlmaWVkIG5vZGVzIG9ubHksIGV4YWN0ICsgY2FzZS1zZW5zaXRpdmU7IFwiICtcbiAgICAgICAgICAgIFwiYW4gYW1iaWd1b3VzIHRpdGxlIGVycm9ycyBhbmQgbmFtZXMgZXZlcnkgY2FuZGlkYXRlIGlkKVwiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICAgIGRyYWZ0OiB1bmtub3duO1xuICAgICAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgICAgIHN1Z2dlc3RlZFRpZXI/OiBzdHJpbmc7XG4gICAgICBhdXRob3I/OiBzdHJpbmc7XG4gICAgICAvLyBSb3VuZCA3IChUQUdTKTogcHJvcG9zZS10aW1lIHRhZ3MgcmlkZSB0aGUgc3RkaW4gSlNPTiDigJQgbXVzdCBiZVxuICAgICAgLy8gZm9yd2FyZGVkIGludG8gdGhlIFBPU1QgYm9keSwgb3IgdGhlIC9wcm9wb3NhbHMgcm91dGUgbmV2ZXIgc2VlcyB0aGVtXG4gICAgICAvLyAodGhlIGJhdGNoIHBhdGggZm9yd2FyZHMgaXRzIG5vZGUgdGFnczsgdGhlIHNpbmdsZSB2ZXJiIG11c3QgdG9vKS5cbiAgICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAgIC8vIFJvdW5kIDEyIChTRUFNIDEpOiBqb2luIGFuIGV4aXN0aW5nIHN0YWdpbmcgYWN0IChmcm9tIHByb3Bvc2UtYmF0Y2gpLlxuICAgICAgYmF0Y2hJZD86IHN0cmluZztcbiAgICB9O1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2FscyR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAga2luZDogdmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiA/IFwibm9kZVwiIDogXCJlZGdlXCIsXG4gICAgICAgIGRyYWZ0OiBpbnB1dC5kcmFmdCxcbiAgICAgICAgZXZpZGVuY2U6IGlucHV0LmV2aWRlbmNlID8/IHt9LFxuICAgICAgICBzdWdnZXN0ZWRUaWVyOiBpbnB1dC5zdWdnZXN0ZWRUaWVyLFxuICAgICAgICBhdXRob3I6IGlucHV0LmF1dGhvcixcbiAgICAgICAgLy8gLS16b25lIHN0YWdlcyB0aGUgcHJvcG9zYWwgaW4gYSB6b25lIChmbGFnIHdpbnM7IHRoZSBzdGRpbiBKU09OXG4gICAgICAgIC8vIHN0YXlzIHRoZSBkcmFmdC9ldmlkZW5jZSBzaGFwZSDigJQgem9uZSBpcyByb3V0aW5nLCBub3QgY29udGVudCkuXG4gICAgICAgIHpvbmU6IHBhcnNlZC52YWx1ZXMuem9uZSxcbiAgICAgICAgLy8gVEFHUzogZm9yd2FyZCB0aGUgc3RkaW4gdGFncyAodGhlIHJvdXRlIHZhbGlkYXRlcyB0aGUgc2hhcGUpLlxuICAgICAgICB0YWdzOiBpbnB1dC50YWdzLFxuICAgICAgICAvLyBTRUFNIDE6IGZvcndhcmQgdGhlIHN0ZGluIGJhdGNoSWQgKHRoZSBib2R5LW1pcnJvciBkaXNjaXBsaW5lIOKAlCBhXG4gICAgICAgIC8vIGZpZWxkIGFkZGVkIHRvIHRoZSBzaGFyZWQgL3Byb3Bvc2FscyBib2R5IG11c3QgYmUgdGhyZWFkZWQgaW50byBFVkVSWVxuICAgICAgICAvLyBDTEkgdmVyYiB0aGF0IHBvc3RzIHRvIGl0OyB0aGUgcHJvcG9zZS1ub2RlLXRhZ3Mgc2NhcikuXG4gICAgICAgIGJhdGNoSWQ6IGlucHV0LmJhdGNoSWQsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICBjb25zdCByZXNwb25zZVRleHQgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgICAvLyBNaXJyb3IgdGhlIGRhZW1vbidzIGFkZGl0aXZlIGVkZ2UtZHJhZnQgd2FybmluZyB0byBzdGRlcnIg4oCUIGEgY29sZFxuICAgIC8vIGFnZW50IHNjYW5uaW5nIGZvciBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgZG9lc24ndCBwYXJzZSBzdGRvdXQuXG4gICAgaWYgKHZlcmIgPT09IFwicHJvcG9zZS1lZGdlXCIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLWJhdGNoXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicHJvcG9zZS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwicHJvcG9zZS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge25vZGVzOlt7cmVmLCBkcmFmdCwgc3VnZ2VzdGVkVGllcj8sIGV2aWRlbmNlP31dLCBlZGdlczpbe2RyYWZ0Ontzb3VyY2UsIHRhcmdldCwgbGFiZWw/fX1dfVwiLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgIFwiYW4gZWRnZSBlbmRwb2ludCBtYXkgYmUgYSBub2RlIExPQ0FMIFJFRiAobWF0Y2hlcyBhIG5vZGUncyByZWYgaW4gdGhpcyBiYXRjaCksIFwiICtcbiAgICAgICAgICAgICdhIHJlYWwgbm9kZSBpZCwgYSBwZW5kaW5nIHByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIOKAlCBsb2NhbCByZWZzICcgK1xuICAgICAgICAgICAgXCJyZXNvbHZlIHRvIG1pbnRlZCBpZHMgYW5kIHRpdGxlIHJlZnMgdG8gcmF0aWZpZWQgbm9kZSBpZHMsIGJvdGggc2VydmVyLXNpZGU7IFwiICtcbiAgICAgICAgICAgIFwib3B0aW9uYWwgYmF0Y2hJZDogb21pdCBhbmQgb25lIGlzIE1JTlRFRCArIHJldHVybmVkOyBzdXBwbHkgb25lIHRvIGV4dGVuZCB0aGF0IGFjdFwiLFxuICAgICAgICB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICAgIG5vZGVzPzogdW5rbm93bjtcbiAgICAgIGVkZ2VzPzogdW5rbm93bjtcbiAgICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICAgIH07XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL2JhdGNoJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBub2RlczogaW5wdXQubm9kZXMgPz8gW10sXG4gICAgICAgIGVkZ2VzOiBpbnB1dC5lZGdlcyA/PyBbXSxcbiAgICAgICAgLy8gU0VBTSAxOiBvbWl0dGVkIOKGkiB0aGUgZGFlbW9uIG1pbnRzIGEgYmF0Y2hJZCBhbmQgcmV0dXJucyBpdDsgc3VwcGxpZWRcbiAgICAgICAgLy8g4oaSIHRoaXMgY2FsbCBqb2lucyB0aGF0IGFjdCAodGhlIFwiSSBmb3Jnb3QgdGhlIGVkZ2VzXCIgcmVwYWlyKS5cbiAgICAgICAgYmF0Y2hJZDogaW5wdXQuYmF0Y2hJZCxcbiAgICAgIH0pLFxuICAgIH0pO1xuICAgIC8vIFJlc3BvbnNlIGNhcnJpZXMge2JhdGNoSWQsIHJlZlRvSWQ6IHs8cmVmPjogPG1pbnRlZElkPn0sIHByb3Bvc2FsczogWy4uLl19XG4gICAgLy8g4oCUIHRoZSByZWbihpJpZCBtYXAgaXMgdGhlIHBvaW50IGZvciBUSElTIGNhbGwsIGFuZCBiYXRjaElkIGlzIHRoZSBwb2ludCBmb3JcbiAgICAvLyBldmVyeSBsYXRlciBvbmUgKGBzdGF0ZSAtLWJhdGNoIDxpZD5gIHJlY29uY2lsZXMgYSBwYXJ0aWFsIHJhdGlmaWNhdGlvbikuXG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInJhdGlmeS1iYXRjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInJhdGlmeS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICdyYXRpZnktYmF0Y2ggcmVxdWlyZXMgLS1zdGRpbiBKU09OIHtydWxpbmc6IFwiY2Fub258dGhyZWFkfHN0b3J5LWxvY2FsXCIsIGlkczogW3Byb3Bvc2FsSWRdLCBhbmNob3JzPzogW3tub2RlLCBwYXJlbnR9XX0nLFxuICAgICAgICB7XG4gICAgICAgICAgaGludDpcbiAgICAgICAgICAgIFwicmF0aWZpZXMgdGhlIHNldCBpbiBPTkUgY2FsbC90eG47IG5vZGVzIHJhdGlmeSBiZWZvcmUgZWRnZXMgKGF1dG8tcGFydGl0aW9uZWQpLCBcIiArXG4gICAgICAgICAgICBcImVkZ2UgZW5kcG9pbnRzICsgYW5jaG9yIHJlZnMgcmVzb2x2ZSBvbGQgcHJvcG9zYWwgaWRzIOKGkiBtaW50ZWQgbm9kZSBpZHMgdmlhIHRoZSBcIiArXG4gICAgICAgICAgICBcInJldHVybmVkIGlkTWFwLiBOTyBhdXRvLWluY2x1ZGUgb2YgdW5saXN0ZWQgZWRnZXM7IHJlamVjdCBpcyBub3QgYSBiYXRjaCBhY3RcIixcbiAgICAgICAgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7XG4gICAgICBydWxpbmc/OiB1bmtub3duO1xuICAgICAgaWRzPzogdW5rbm93bjtcbiAgICAgIGFuY2hvcnM/OiB1bmtub3duO1xuICAgIH07XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL3JhdGlmeS1iYXRjaCR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcnVsaW5nOiBpbnB1dC5ydWxpbmcsXG4gICAgICAgIGlkczogaW5wdXQuaWRzID8/IFtdLFxuICAgICAgICBhbmNob3JzOiBpbnB1dC5hbmNob3JzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgLy8gUmVzcG9uc2UgY2FycmllcyB7aWRNYXA6IHs8b2xkUHJvcG9zYWxJZD46IDxtaW50ZWROb2RlSWQ+fSwgcmF0aWZpZWQ6Wy4uLl19XG4gICAgLy8g4oCUIHRoZSBpZE1hcCBpcyB0aGUgcG9pbnQgKHJlY29ubmVjdCBhbiBlZGdlL2FuY2hvciB0byB0aGUgcmVhbCBub2RlKS5cbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgMTIgKFNFQU0gNSkg4oCUIHRoZSBpbnZlcnNlIG9mIHJhdGlmeS1iYXRjaDogY2xlYXIgYSBzZXQgb2YgcHJvcG9zYWxzXG4gIC8vIGluIE9ORSB0cmFuc2FjdGlvbmFsIGNhbGwgaW5zdGVhZCBvZiBOIEhUVFAgZGVsZXRlcyBpbiBhIGxvb3AuXG4gIGlmICh2ZXJiID09PSBcImRlbGV0ZS1iYXRjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImRlbGV0ZS1iYXRjaFwiLCByZXN0KTtcbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoJ2RlbGV0ZS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge2lkczogW1wiPHByb3Bvc2FsSWQ+XCIsIC4uLl19Jywge1xuICAgICAgICBoaW50OlxuICAgICAgICAgIFwiZGVsZXRlcyB0aGUgc2V0IGluIE9ORSB0eG4g4oCUIGFsbC1vci1ub3RoaW5nOiBpZiBhbnkgaWQgaXMgdW5rbm93biwgTk9USElORyBpcyBcIiArXG4gICAgICAgICAgXCJkZWxldGVkIGFuZCB0aGUgZXJyb3IgbmFtZXMgZXZlcnkgdW5rbm93biBpZC4gVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIFwiICtcbiAgICAgICAgICBcIntiYXRjaDogPGlkPn0gc2hvcnRoYW5kIOKAlCBydW4gYHN0YXRlIC0tYmF0Y2ggPGlkPmAgYW5kIGxvb2sgYmVmb3JlIHlvdSBzd2VlcCBcIiArXG4gICAgICAgICAgXCIoZHJpdmUgIzEwJ3MgYnVnIHdhcyBhbiBvdmVyLWJyb2FkIGNsZWFudXAgdGhhdCB0b29rIHRoZSBlZGdlcyB3aXRoIGl0KVwiLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7IGlkcz86IHVua25vd24gfTtcbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvZGVsZXRlLWJhdGNoJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZHM6IGlucHV0LmlkcyA/PyBbXSB9KSxcbiAgICB9KTtcbiAgICBjb25zdCBkZWxldGVCYXRjaEJvZHkgPSBhd2FpdCBwYXNzT3JUaHJvdyhyZXMpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RlbGV0ZUJhdGNoQm9keX1cXG5gKTtcbiAgICAvLyBSMTIgZ2F0ZSBmaW5kaW5nIDE6IG1pcnJvciB0aGUgc3RyYW5kZWQtbm9kZSBhZHZpc29yeSB0byBzdGRlcnIsIHRoZSBzYW1lXG4gICAgLy8gd2F5IHByb3Bvc2UtZWRnZSBtaXJyb3JzIGVkZ2VEcmFmdFdhcm5pbmcg4oCUIGEgY29sZCBhZ2VudCBzY2FubmluZyBmb3JcbiAgICAvLyBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgbmV2ZXIgcGFyc2VzIHN0ZG91dC4gQWR2aXNvcnksIG5vdCBhIGZhaWx1cmU6XG4gICAgLy8gdGhlIGV4aXQgY29kZSBpcyB1bmNoYW5nZWQuXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShkZWxldGVCYXRjaEJvZHkpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgaWYgKHR5cGVvZiB3YXJuaW5nID09PSBcInN0cmluZ1wiKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB3YXJuaW5nOiAke3dhcm5pbmd9XFxuYCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJub2RlXCIpIHtcbiAgICBjb25zdCBzdWIgPSByZXN0WzBdO1xuICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCB8fCAhc3Vic09mKFwibm9kZVwiKS5pbmNsdWRlcyhzdWIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBzdWIgPT09IHVuZGVmaW5lZCA/IFwibm9kZSByZXF1aXJlcyBhIHN1Yi1jb21tYW5kXCIgOiBgdW5rbm93biBub2RlIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcIm5vZGVcIikgfSxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoYG5vZGUgJHtzdWJ9YCBhcyBWZXJiUGF0aCwgcmVzdC5zbGljZSgxKSk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICAvLyBSb3VuZCA2IChERUwpOiBgbm9kZSBkZWxldGUgPGlkPiBbLS1mb3JjZV1gIOKAlCA0MDkge2Vycm9yOlwiY2l0ZWRcIixcbiAgICAvLyBjaXRlZEJ5OntlZGdlcywgY2hpbGRyZW59fSB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuICAgIC8vIChlZGdlcyBnb25lLCBjaGlsZHJlbiByZS1wYXJlbnRlZCB0byB0b3AtbGV2ZWwsIGRldHJpdHVzIGdvbmUpLlxuICAgIGlmIChzdWIgPT09IFwiZGVsZXRlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgICAgaWYgKCFpZCkge1xuICAgICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBub2RlIGRlbGV0ZSA8bm9kZUlkPiBbLS1mb3JjZV1cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICAgICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgZHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgLy8gUm91bmQgMTIgKFNFQU0gNCk6IGBub2RlIGVkaXQgPGlkPiBbLS10aXRsZSBUXSBbLS1zeW5vcHNpcyBTXSB8IC0tc3RkaW5gXG4gICAgLy8g4oCUIGEgcmF0aWZpZWQgbm9kZSBjYW4gZmluYWxseSBnYWluIGEgc3lub3BzaXMgKEYyKS4gV3JpdGVzIGV4YWN0bHkgd2hhdFxuICAgIC8vIGl0IGlzIGdpdmVuOyB0aWVyIGFuZCBraW5kIGFyZSBOT1QgZWRpdGFibGUgKHNlZSBlZGl0LnRzIGZvciB3aHkpLlxuICAgIGlmIChzdWIgPT09IFwiZWRpdFwiKSB7XG4gICAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICAgIGNvbnN0IHBhdGNoOiB7IHRpdGxlPzogc3RyaW5nOyBzeW5vcHNpcz86IHN0cmluZyB9ID0ge307XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikge1xuICAgICAgICAvLyBQcm9zZSBiZWxvbmdzIG9uIHN0ZGluIOKAlCBhIHN5bm9wc2lzIGlzIGEgcGFyYWdyYXBoLCBub3QgYSBmbGFnIHZhbHVlLlxuICAgICAgICBPYmplY3QuYXNzaWduKFxuICAgICAgICAgIHBhdGNoLFxuICAgICAgICAgIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyB0aXRsZT86IHN0cmluZzsgc3lub3BzaXM/OiBzdHJpbmcgfSxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnRpdGxlICE9PSB1bmRlZmluZWQpIHBhdGNoLnRpdGxlID0gcGFyc2VkLnZhbHVlcy50aXRsZTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnN5bm9wc2lzICE9PSB1bmRlZmluZWQpIHBhdGNoLnN5bm9wc2lzID0gcGFyc2VkLnZhbHVlcy5zeW5vcHNpcztcbiAgICAgIGlmICghaWQgfHwgKHBhdGNoLnRpdGxlID09PSB1bmRlZmluZWQgJiYgcGF0Y2guc3lub3BzaXMgPT09IHVuZGVmaW5lZCkpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICAndXNhZ2U6IGNsaS50cyBub2RlIGVkaXQgPG5vZGVJZD4gKC0tdGl0bGUgPHQ+IHwgLS1zeW5vcHNpcyA8cz4gfCAtLXN0ZGluIFxcJ3tcInN5bm9wc2lzXCI6IFwiLi4uXCJ9XFwnKScsXG4gICAgICAgICAge1xuICAgICAgICAgICAgaGludDpcbiAgICAgICAgICAgICAgXCJ3cml0ZXMgZXhhY3RseSB3aGF0IGl0IGlzIGdpdmVuIChubyBpbmZlcmVuY2UpOyBvbmx5IHRpdGxlL3N5bm9wc2lzIGFyZSBlZGl0YWJsZSDigJQgXCIgK1xuICAgICAgICAgICAgICBcInRpZXIgaXMgdGhlIGh1bWFuJ3MgcnVsaW5nIGFuZCBraW5kIGlzIGEgcmF0aWZpY2F0aW9uLXRpbWUgY2xhc3NpZmljYXRpb25cIixcbiAgICAgICAgICB9LFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgLy8gQm9keS1taXJyb3IgZGlzY2lwbGluZTogdGhyZWFkIGV2ZXJ5IGZpZWxkIGV4cGxpY2l0bHkgKHRoZVxuICAgICAgICAvLyBwcm9wb3NlLW5vZGUtdGFncyBzY2FyKSDigJQgYW4gb21pdHRlZCBrZXkgbXVzdCBzdGF5IG9taXR0ZWQgc28gdGhlXG4gICAgICAgIC8vIHJvdXRlIHBhdGNoZXMgaW5zdGVhZCBvZiBibGFua2luZy5cbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIC4uLihwYXRjaC50aXRsZSAhPT0gdW5kZWZpbmVkID8geyB0aXRsZTogcGF0Y2gudGl0bGUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4ocGF0Y2guc3lub3BzaXMgIT09IHVuZGVmaW5lZCA/IHsgc3lub3BzaXM6IHBhdGNoLnN5bm9wc2lzIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgIT09IFwiYW5jaG9yXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBub2RlIGFuY2hvciA8bm9kZUlkPiAoLS10byA8cGFyZW50SWQ+IHwgLS1jbGVhcikgfCBub2RlIGVkaXQgPG5vZGVJZD4gKC0tdGl0bGUgPHQ+IHwgLS1zeW5vcHNpcyA8cz4gfCAtLXN0ZGluKSB8IG5vZGUgZGVsZXRlIDxub2RlSWQ+IFstLWZvcmNlXVxcblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgY29uc3QgaGFzVG8gPSBwYXJzZWQudmFsdWVzLnRvICE9PSB1bmRlZmluZWQ7XG4gICAgaWYgKCFpZCB8fCAoaGFzVG8gJiYgcGFyc2VkLnZhbHVlcy5jbGVhcikgfHwgKCFoYXNUbyAmJiAhcGFyc2VkLnZhbHVlcy5jbGVhcikpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBub2RlIGFuY2hvciA8bm9kZUlkPiAoLS10byA8cGFyZW50SWQ+IHwgLS1jbGVhcilcXG5cIiArXG4gICAgICAgICAgXCIgIC0tdG8gYW5jaG9ycyB0aGUgbm9kZSB1bmRlciA8cGFyZW50SWQ+IChhIHJlYWwgbm9kZSBpZCk7IC0tY2xlYXIgbW92ZXMgaXQgdG8gdG9wLWxldmVsXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0vYW5jaG9yJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJlbnRJZDogcGFyc2VkLnZhbHVlcy5jbGVhciA/IG51bGwgOiBwYXJzZWQudmFsdWVzLnRvIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJyZWFkXCIgfHwgdmVyYiA9PT0gXCJtZXNzYWdlXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicmVhZFwiLCByZXN0KTtcbiAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyByZWFkIDxtZXNzYWdlSWQ+XCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9tZXNzYWdlLyR7aWR9JHtxc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwiem9uZVwiKSB7XG4gICAgY29uc3Qgc3ViID0gcmVzdFswXTtcbiAgICBpZiAoc3ViID09PSB1bmRlZmluZWQgfHwgIXN1YnNPZihcInpvbmVcIikuaW5jbHVkZXMoc3ViKSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgc3ViID09PSB1bmRlZmluZWQgPyBcInpvbmUgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gem9uZSBzdWItY29tbWFuZDogJHtzdWJ9YCxcbiAgICAgICAgeyBjaG9pY2VzOiBzdWJzT2YoXCJ6b25lXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGB6b25lICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBpZiAoc3ViID09PSBcImNyZWF0ZVwiKSB7XG4gICAgICBjb25zdCBuYW1lID0gcGFyc2VkLnBvc2l0aW9uYWxzLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCFuYW1lKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHpvbmUgY3JlYXRlIDxuYW1lPlwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pLFxuICAgICAgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgPT09IFwibGlzdFwiKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3pvbmVzJHtxc31gKTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHpvbmUgZGVsZXRlIDxpZD4gWy0teWVzXVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy55ZXMpIHBhcmFtcy5zZXQoXCJ5ZXNcIiwgXCIxXCIpO1xuICAgICAgY29uc3QgZHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgem9uZSA8Y3JlYXRlIDxuYW1lPiB8IGxpc3QgfCBkZWxldGUgPGlkPiBbLS15ZXNdPlwiKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInByb21vdGVcIikge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoXCJwcm9tb3RlXCIsIHJlc3QpO1xuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGlmICghaWQpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHByb21vdGUgPHByb3Bvc2FsSWQ+XCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vcHJvbW90ZSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICB9KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicHJvcG9zYWxcIikge1xuICAgIGNvbnN0IHN1YiA9IHJlc3RbMF07XG4gICAgaWYgKHN1YiA9PT0gdW5kZWZpbmVkIHx8ICFzdWJzT2YoXCJwcm9wb3NhbFwiKS5pbmNsdWRlcyhzdWIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBzdWIgPT09IHVuZGVmaW5lZFxuICAgICAgICAgID8gXCJwcm9wb3NhbCByZXF1aXJlcyBhIHN1Yi1jb21tYW5kXCJcbiAgICAgICAgICA6IGB1bmtub3duIHByb3Bvc2FsIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcInByb3Bvc2FsXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGBwcm9wb3NhbCAke3N1Yn1gIGFzIFZlcmJQYXRoLCByZXN0LnNsaWNlKDEpKTtcbiAgICBjb25zdCBwcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3RcbiAgICAgID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YFxuICAgICAgOiBcIlwiO1xuICAgIC8vIFJvdW5kIDYgKERFTCk6IGBwcm9wb3NhbCBkZWxldGUgPGlkPmAg4oCUIHRoaW4sIG5vIGd1YXJkIChkcm9wIHJvdyArXG4gICAgLy8gY2FzY2FkZSBub2RlX2FjdGlvbnMpLiBUaGUgbGl0dGVyLWNsZWFyaW5nIHBhdGggKGNsZWFyIGEgcmF3XG4gICAgLy8gaW5zdHJ1Y3Rpb24tbm9kZSB0aHJvdWdoIERFTEVURSwgbm90IHJlamVjdCkuXG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHByb3Bvc2FsIGRlbGV0ZSA8cHJvcG9zYWxJZD5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0ke3Bxc31gLCB7XG4gICAgICAgIG1ldGhvZDogXCJERUxFVEVcIixcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViICE9PSBcInpvbmVcIikge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJ1c2FnZTogY2xpLnRzIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpIHwgcHJvcG9zYWwgZGVsZXRlIDxpZD5cXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGNvbnN0IGhhc1RvID0gcGFyc2VkLnZhbHVlcy50byAhPT0gdW5kZWZpbmVkO1xuICAgIGlmICghaWQgfHwgKGhhc1RvICYmIHBhcnNlZC52YWx1ZXMuY2xlYXIpIHx8ICghaGFzVG8gJiYgIXBhcnNlZC52YWx1ZXMuY2xlYXIpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcInVzYWdlOiBjbGkudHMgcHJvcG9zYWwgem9uZSA8cHJvcG9zYWxJZD4gKC0tdG8gPHpvbmVJZD4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgLS10byBtb3ZlcyBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyA8em9uZUlkPjsgLS1jbGVhciBtb3ZlcyBpdCBiYWNrIHRvIHRoZSBtYWluIHF1ZXVlXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vem9uZSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgem9uZUlkOiBwYXJzZWQudmFsdWVzLmNsZWFyID8gbnVsbCA6IHBhcnNlZC52YWx1ZXMudG8gfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImRvY1wiKSB7XG4gICAgLy8gZG9jJ3Mgc3ViIGlzIE9QVElPTkFMIChgZG9jIDxpZD5gIHJlYWRzKSBhbmQgcmlkZXMgdGhlIHBvc2l0aW9uYWxzLCBzbyBhXG4gICAgLy8gcmVnaXN0cnktd2lkZSBwcm9iZSBwYXJzZSByZXNvbHZlcyB0aGUgcGF0aCBiZWZvcmUgdGhlIHBlci1wYXRoIGNoZWNrLlxuICAgIGNvbnN0IHByb2JlID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IHJlc3QsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgY29uc3QgZG9jUGF0aDogVmVyYlBhdGggPVxuICAgICAgcHJvYmUucG9zaXRpb25hbHNbMF0gPT09IFwia2luZFwiXG4gICAgICAgID8gXCJkb2Mga2luZFwiXG4gICAgICAgIDogcHJvYmUucG9zaXRpb25hbHNbMF0gPT09IFwiZGVsZXRlXCJcbiAgICAgICAgICA/IFwiZG9jIGRlbGV0ZVwiXG4gICAgICAgICAgOiBcImRvY1wiO1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlVmVyYkFyZ3MoZG9jUGF0aCwgcmVzdCk7XG4gICAgLy8gYGRvYyBkZWxldGUgPGlkPmAgLyBgZG9jIGtpbmQgPGlkPmAgb3ZlcmxvYWQgdGhlIHBvc2l0aW9uYWwgKGEgZG9jXG4gICAgLy8gbGl0ZXJhbGx5IHNsdWdnZWQgXCJkZWxldGVcIi9cImtpbmRcIiBpcyB1bmFkZHJlc3NhYmxlIOKAlCBhY2NlcHRlZCBmb3IgdGhlXG4gICAgLy8gcmVjb3JkLCBwbGFuLXYxeCkuXG4gICAgLy8gUm91bmQgNCAoSzEpOiBgZG9jIGtpbmQgPGRvY0lkPiA8a2luZC4uLj4gWy0tYXV0aG9yIHVzZXJ8YWdlbnRdYCBzZXRzLFxuICAgIC8vIGBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJgIGNsZWFycyAoYXV0aG9yIG51bGxzIHdpdGggaXQpLiBUaGUgaW5nZXN0XG4gICAgLy8gZGVmYXVsdHMgZGllZCDigJQgdGhpcyB2ZXJiIGlzIGhvdyBhIGRvYyBnZXRzIHR5cGVkIGF0IGFsbC5cbiAgICBpZiAocGFyc2VkLnBvc2l0aW9uYWxzWzBdID09PSBcImtpbmRcIikge1xuICAgICAgY29uc3QgZG9jSWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMV07XG4gICAgICBjb25zdCBraW5kV29yZHMgPSBwYXJzZWQucG9zaXRpb25hbHMuc2xpY2UoMikuam9pbihcIiBcIik7XG4gICAgICBpZiAoIWRvY0lkIHx8IChraW5kV29yZHMgPT09IFwiXCIgJiYgIXBhcnNlZC52YWx1ZXMuY2xlYXIpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGRvYyBraW5kIDxkb2NJZD4gPGtpbmQ+IFstLWF1dGhvciB1c2VyfGFnZW50XSB8IGRvYyBraW5kIDxkb2NJZD4gLS1jbGVhclxcblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0XG4gICAgICAgID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YFxuICAgICAgICA6IFwiXCI7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9raW5kJHtxc31gLCB7XG4gICAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KFxuICAgICAgICAgIHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgICAgICAgID8geyBraW5kOiBudWxsIH1cbiAgICAgICAgICAgIDogeyBraW5kOiBraW5kV29yZHMsIGF1dGhvcjogcGFyc2VkLnZhbHVlcy5hdXRob3IgPz8gXCJhZ2VudFwiIH0sXG4gICAgICAgICksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgY29uc3QgaXNEZWxldGUgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gPT09IFwiZGVsZXRlXCI7XG4gICAgY29uc3QgaWQgPSBpc0RlbGV0ZSA/IHBhcnNlZC5wb3NpdGlvbmFsc1sxXSA6IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICBcInVzYWdlOiBjbGkudHMgZG9jIDxpZD4gfCBkb2MgZGVsZXRlIDxpZD4gWy0tZm9yY2VdIHwgZG9jIGtpbmQgPGRvY0lkPiA8a2luZHwtLWNsZWFyPiBbLS1wcm9qZWN0IDxpZD5dXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICAgIGlmIChpc0RlbGV0ZSAmJiBwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICAgIGNvbnN0IHFzID0gcGFyYW1zLnNpemUgPiAwID8gYD8ke3BhcmFtc31gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2lkfSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBpc0RlbGV0ZSA/IFwiREVMRVRFXCIgOiBcIkdFVFwiLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJtYXJrXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwibWFya1wiLCByZXN0KTtcbiAgICBjb25zdCBkb2NJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWRvY0lkIHx8ICFwYXJzZWQudmFsdWVzLnN0YXR1cykge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgbWFyayA8ZG9jSWQ+IC0tc3RhdHVzIDxzPiBbLS1ub3RlIDx0Pl1cIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9tYXJrJHtxc31gLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBhdXRob3I6IHBhcnNlZC52YWx1ZXMuYXV0aG9yID8/IFwiYWdlbnRcIixcbiAgICAgICAgbm90ZTogcGFyc2VkLnZhbHVlcy5ub3RlLFxuICAgICAgICBzdGF0dXM6IHBhcnNlZC52YWx1ZXMuc3RhdHVzLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcInNlYXJjaFwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcInNlYXJjaFwiLCByZXN0KTtcbiAgICBjb25zdCBxdWVyeSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgICBpZiAoIXF1ZXJ5KSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBzZWFyY2ggPHF1ZXJ5Li4uPlwiKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgcTogcXVlcnkgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3NlYXJjaD8ke3BhcmFtc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwibmVpZ2hib3JzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwibmVpZ2hib3JzXCIsIHJlc3QpO1xuICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgIGlmICghaWQpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXVwiKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPz8gXCIxXCIgfSk7XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L25laWdoYm9ycy8ke2lkfT8ke3BhcmFtc31gKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwicmF0aWZ5XCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwicmF0aWZ5XCIsIHJlc3QpO1xuICAgIGNvbnN0IHByb3Bvc2FsSWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgaWYgKCFwcm9wb3NhbElkIHx8ICFwYXJzZWQudmFsdWVzLnJ1bGluZykge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJ1c2FnZTogY2xpLnRzIHJhdGlmeSA8cHJvcG9zYWxJZD4gLS1ydWxpbmcgPHI+IFstLWRvYy1lZGl0IDxmaWxlPl0gWy0tZG9jIDxkb2NJZD4gLS1zcGFuIDx0ZXh0Pl0gWy0tYW5jaG9yIDxwYXJlbnRJZD5dXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICAvLyAtLWRvYyByZXF1aXJlcyAtLWRvYy1lZGl0IOKAlCB0aGUgZGFlbW9uIGVuZm9yY2VzIGl0IHRvbywgYnV0IGEgbG9jYWxcbiAgICAvLyB1c2FnZSBlcnJvciBiZWF0cyBhIHJvdW5kLXRyaXAgZm9yIHRoZSBjb21tb24gc2xpcC5cbiAgICBpZiAocGFyc2VkLnZhbHVlcy5kb2MgJiYgIXBhcnNlZC52YWx1ZXNbXCJkb2MtZWRpdFwiXSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcIi0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQgKHRoZSBkcmFmdGVkIGRvYyBob21lKVwiKTtcbiAgICB9XG4gICAgY29uc3QgZG9jRWRpdCA9IHBhcnNlZC52YWx1ZXNbXCJkb2MtZWRpdFwiXVxuICAgICAgPyByZWFkRmlsZVN5bmMocGFyc2VkLnZhbHVlc1tcImRvYy1lZGl0XCJdLCBcInV0ZjhcIilcbiAgICAgIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke3Byb3Bvc2FsSWR9L3J1bGluZyR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcnVsaW5nOiBwYXJzZWQudmFsdWVzLnJ1bGluZyxcbiAgICAgICAgZG9jRWRpdCxcbiAgICAgICAgZG9jSWQ6IHBhcnNlZC52YWx1ZXMuZG9jLFxuICAgICAgICBzcGFuOiBwYXJzZWQudmFsdWVzLnNwYW4sXG4gICAgICAgIC8vIFJvdW5kIDYgKFJCKTogLS1hbmNob3IgPHBhcmVudElkPiByYXRpZmllcyB0aGVuIG5lc3RzIHRoZSBtaW50ZWRcbiAgICAgICAgLy8gbm9kZSB1bmRlciA8cGFyZW50SWQ+IGluIG9uZSBhdG9taWMgY2FsbCAobm9kZSBwcm9wb3NhbHMgb25seSkuXG4gICAgICAgIGFuY2hvcjogcGFyc2VkLnZhbHVlcy5hbmNob3IsXG4gICAgICB9KSxcbiAgICB9KTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG5cbiAgaWYgKHZlcmIgPT09IFwibGVuc1wiKSB7XG4gICAgY29uc3Qgc3ViID0gcmVzdFswXTtcbiAgICBpZiAoc3ViID09PSB1bmRlZmluZWQgfHwgIXN1YnNPZihcImxlbnNcIikuaW5jbHVkZXMoc3ViKSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgc3ViID09PSB1bmRlZmluZWQgPyBcImxlbnMgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gbGVucyBzdWItY29tbWFuZDogJHtzdWJ9YCxcbiAgICAgICAgeyBjaG9pY2VzOiBzdWJzT2YoXCJsZW5zXCIpIH0sXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKGBsZW5zICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIC8vIFJvdW5kIDMgKENsYWltIFYyKTogb25lIGxlbnMsIHR3byBtb2RlcyDigJQgLS1ub2RlIGFuZCAtLWRvYyBhcmVcbiAgICAvLyBleGNsdXNpdmUgYXQgcGFyc2UgdGltZSAodGhlIGRhZW1vbiBlbmZvcmNlcyB0aGUgWE9SIHRvbywgYnV0IHRoZVxuICAgIC8vIGNvbW1vbiBzbGlwIHNob3VsZCBmYWlsIGJlZm9yZSBhIHJvdW5kLXRyaXApLlxuICAgIGlmIChwYXJzZWQudmFsdWVzLm5vZGUgIT09IHVuZGVmaW5lZCAmJiBwYXJzZWQudmFsdWVzLmRvYyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwibGVucyBzZXQgdGFrZXMgLS1ub2RlIE9SIC0tZG9jLCBub3QgYm90aFwiKTtcbiAgICB9XG4gICAgaWYgKHBhcnNlZC52YWx1ZXMuZG9jICE9PSB1bmRlZmluZWQgJiYgcGFyc2VkLnZhbHVlcy5kZXB0aCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwiLS1kZXB0aCBhcHBsaWVzIHRvIGEgbm9kZSBsZW5zIG9ubHlcIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBpZiAoc3ViID09PSBcInNldFwiKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2xlbnMke3FzfWAsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIG93bmVyOiBwYXJzZWQudmFsdWVzLm93bmVyID8/IFwiYWdlbnRcIixcbiAgICAgICAgICBub2RlSWQ6IHBhcnNlZC52YWx1ZXMubm9kZSxcbiAgICAgICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICAgICAgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPyBOdW1iZXIucGFyc2VJbnQocGFyc2VkLnZhbHVlcy5kZXB0aCwgMTApIDogdW5kZWZpbmVkLFxuICAgICAgICB9KSxcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcImNsZWFyXCIpIHtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbGVucyR7cXN9YCwgeyBtZXRob2Q6IFwiREVMRVRFXCIgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgbGVucyA8c2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxkb2NJZD4pIHwgY2xlYXI+XFxuXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImxvb2staGVyZVwiKSB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhcImxvb2staGVyZVwiLCByZXN0KTtcbiAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBpZiAoIWlkKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBsb29rLWhlcmUgPG5vZGVJZD5cIik7XG4gICAgfVxuICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2xvb2staGVyZS8ke2lkfSR7cXN9YCwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJhY3Rpb25zXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiYWN0aW9uc1wiLCByZXN0KTtcbiAgICBjb25zdCB0YXJnZXRJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBjb25zdCBtb2RlcyA9IFtwYXJzZWQudmFsdWVzLnNldCAhPT0gdW5kZWZpbmVkLCBwYXJzZWQudmFsdWVzLnN0ZGluLCBwYXJzZWQudmFsdWVzLmNsZWFyXTtcbiAgICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBhY3Rpb25zIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICAgJyAge1wiaWRcIiwgXCJsYWJlbFwiLCBcInNlZWRcIn0g4oCUIGVtcHR5IGFycmF5IChvciAtLWNsZWFyKSByZW1vdmVzIHRoZSBzbG90c1xcbicsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpb25zLyR7dGFyZ2V0SWR9JHtxc31gO1xuICAgIGNvbnN0IHJlcyA9IHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgID8gYXdhaXQgZmV0Y2godGFyZ2V0LCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KVxuICAgICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgICBtZXRob2Q6IFwiUFVUXCIsXG4gICAgICAgICAgYm9keTogcGFyc2VkLnZhbHVlcy5zdGRpbiA/IGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkgOiAocGFyc2VkLnZhbHVlcy5zZXQgYXMgc3RyaW5nKSxcbiAgICAgICAgfSk7XG4gICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZXNwb25zZVRleHR9XFxuYCk7XG4gICAgLy8gTWlycm9yIHRoZSBkYWVtb24ncyBhZGRpdGl2ZSBzb2Z0LWNhcCB3YXJuaW5nIHRvIHN0ZGVyciAodGhlXG4gICAgLy8gZWRnZURyYWZ0V2FybmluZyBwYXR0ZXJuIOKAlCBhIGNvbGQgYWdlbnQgc2Nhbm5pbmcgZm9yIHByb2JsZW1zIHNlZXMgaXQpLlxuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gICAgfVxuICAgIHJldHVybiAwO1xuICB9XG5cbiAgLy8gUm91bmQgNyAoVEFHUykg4oCUIHR3aW4gb2YgdGhlIGFjdGlvbnMgdmVyYjogd2hvbGVzYWxlIHJlcGxhY2UgLyBjbGVhciBhXG4gIC8vIHRhcmdldCdzIGZyZWVmb3JtIHRhZ3MuIFRhcmdldCBpcyBhIG5vZGUgaWQgb3IgYSBQRU5ESU5HIHByb3Bvc2FsIGlkLlxuICBpZiAodmVyYiA9PT0gXCJ0YWdzXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwidGFnc1wiLCByZXN0KTtcbiAgICBjb25zdCB0YXJnZXRJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICBjb25zdCBtb2RlcyA9IFtwYXJzZWQudmFsdWVzLnNldCAhPT0gdW5kZWZpbmVkLCBwYXJzZWQudmFsdWVzLnN0ZGluLCBwYXJzZWQudmFsdWVzLmNsZWFyXTtcbiAgICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKVxcblwiICtcbiAgICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICAgXCIgIGZyZWVmb3JtIHN0cmluZ3Mg4oCUIGVtcHR5IGFycmF5IChvciAtLWNsZWFyKSByZW1vdmVzIHRoZSB0YWdzXFxuXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS90YWdzLyR7dGFyZ2V0SWR9JHtxc31gO1xuICAgIGNvbnN0IHJlcyA9IHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgID8gYXdhaXQgZmV0Y2godGFyZ2V0LCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KVxuICAgICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgICBtZXRob2Q6IFwiUFVUXCIsXG4gICAgICAgICAgYm9keTogcGFyc2VkLnZhbHVlcy5zdGRpbiA/IGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkgOiAocGFyc2VkLnZhbHVlcy5zZXQgYXMgc3RyaW5nKSxcbiAgICAgICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFJvdW5kIDkgKEpvYiBRdWV1ZSkg4oCUIHRoZSBgam9iYCB2ZXJiOiBjcmVhdGUvdXBkYXRlL2NsYWltL3JlbGVhc2Uvc3VidGFzay9cbiAgLy8gbGlzdC9kZWxldGUsIGNvcHlpbmcgdGhlIGBwcm9wb3NhbCA8c3ViPmAgbGlmZWN5Y2xlIHNoYXBlICsgdGhlIHRhZ3NcbiAgLy8gYm9keS1idWlsZGVyIGRpc2NpcGxpbmUuIEVWRVJZIGZpZWxkIGlzIHRocmVhZGVkIGludG8gdGhlIFBPU1QgYm9keSAodGhlIFI3XG4gIC8vIGdhdGUgc2NhcjogYSBoYW5kLXdyaXR0ZW4gYm9keS1idWlsZGVyIGlzIGEgTUlSUk9SIG9mIHRoZSByb3V0ZSdzIGZpZWxkIHNldFxuICAvLyBhbmQgZHJpZnRzIHNpbGVudGx5IOKAlCBzbyB1cGRhdGUgZm9yd2FyZHMgZWFjaCBwcm92aWRlZCBzY2FsYXIsIHN1YnRhc2tcbiAgLy8gZm9yd2FyZHMgb3AgKyBsYWJlbHxzdWJ0YXNrSWQsIGNsYWltIGZvcndhcmRzIG93bmVyKS5cbiAgaWYgKHZlcmIgPT09IFwiam9iXCIpIHtcbiAgICBjb25zdCBzdWIgPSByZXN0WzBdO1xuICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCB8fCAhc3Vic09mKFwiam9iXCIpLmluY2x1ZGVzKHN1YikpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIHN1YiA9PT0gdW5kZWZpbmVkID8gXCJqb2IgcmVxdWlyZXMgYSBzdWItY29tbWFuZFwiIDogYHVua25vd24gam9iIHN1Yi1jb21tYW5kOiAke3N1Yn1gLFxuICAgICAgICB7IGNob2ljZXM6IHN1YnNPZihcImpvYlwiKSB9LFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VWZXJiQXJncyhgam9iICR7c3VifWAgYXMgVmVyYlBhdGgsIHJlc3Quc2xpY2UoMSkpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgYmFzZSA9IChwb3J0OiBudW1iZXIsIHN1ZmZpeCA9IFwiXCIpID0+IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vam9icyR7c3VmZml4fSR7cXN9YDtcbiAgICAvLyBBIEpTT04gYm9keSBmcm9tIC0tYm9keS1maWxlID4gLS1zdGRpbiBvdmVycmlkZXMgdGhlIGZsYWctYnVpbHQgYm9keSAodGhlXG4gICAgLy8gc2VuZCBwcmVjZWRlbmNlIGNoYWluKSwgc28gYSBmdWxsIGpvYiBjYW4gYmUgcGlwZWQgaW4gb25lIHNob3QuXG4gICAgY29uc3QgYm9keUZyb21Tb3VyY2UgPSBhc3luYyAoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGw+ID0+IHtcbiAgICAgIGlmIChwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgcCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgICAgIGlmICghZXhpc3RzU3luYyhwKSkge1xuICAgICAgICAgIHRocm93IHVzYWdlRXJyb3IoYGpvYjogLS1ib2R5LWZpbGUgbm90IGZvdW5kOiAke3B9YCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHAsIFwidXRmOFwiKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB9XG4gICAgICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9O1xuXG4gICAgaWYgKHN1YiA9PT0gXCJsaXN0XCIpIHtcbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQpKTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJjcmVhdGVcIikge1xuICAgICAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBib2R5RnJvbVNvdXJjZSgpO1xuICAgICAgY29uc3QgYm9keSA9IG92ZXJyaWRlID8/IHtcbiAgICAgICAgdGl0bGU6IHBhcnNlZC52YWx1ZXMudGl0bGUsXG4gICAgICAgIHN0YXR1czogcGFyc2VkLnZhbHVlcy5zdGF0dXMsXG4gICAgICAgIGRlbGl2ZXJhYmxlOiBwYXJzZWQudmFsdWVzLmRlbGl2ZXJhYmxlLFxuICAgICAgICBkZXRhaWw6IHBhcnNlZC52YWx1ZXMuZGV0YWlsLFxuICAgICAgfTtcbiAgICAgIGlmICh0eXBlb2YgYm9keS50aXRsZSAhPT0gXCJzdHJpbmdcIiB8fCBib2R5LnRpdGxlID09PSBcIlwiKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiBjcmVhdGUgLS10aXRsZSA8dD4gWy0tc3RhdHVzIDxzPl0gWy0tZGVsaXZlcmFibGUgPHJlZj5dIFstLWRldGFpbCA8eD5dXFxuXCIgK1xuICAgICAgICAgICAgXCIgIG9yOiBjbGkudHMgam9iIGNyZWF0ZSAoLS1zdGRpbiB8IC0tYm9keS1maWxlIDxwYXRoPikgd2l0aCBKU09OIHt0aXRsZSwgc3RhdHVzPywgZGVsaXZlcmFibGU/LCBkZXRhaWw/fVxcblwiLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGJhc2UocG9ydCksIHsgbWV0aG9kOiBcIlBPU1RcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSkgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGlmIChzdWIgPT09IFwidXBkYXRlXCIpIHtcbiAgICAgIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICAgICAgaWYgKCFpZCkge1xuICAgICAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgICAgIFwidXNhZ2U6IGNsaS50cyBqb2IgdXBkYXRlIDxpZD4gWy0tdGl0bGUgPHQ+XSBbLS1zdGF0dXMgPHM+XSBbLS1kZWxpdmVyYWJsZSA8cmVmPl0gWy0tZGV0YWlsIDx4Pl1cXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG92ZXJyaWRlID0gYXdhaXQgYm9keUZyb21Tb3VyY2UoKTtcbiAgICAgIC8vIEZvcndhcmQgb25seSB0aGUgZmxhZ3MgdGhhdCB3ZXJlIFBST1ZJREVEICh0aHJlYWQgZXZlcnkgZmllbGQg4oCUIHRoZSBSN1xuICAgICAgLy8gYm9keS1taXJyb3Igc2Nhcik7IGEgYmFyZSBgam9iIHVwZGF0ZSA8aWQ+YCB3aXRoIG5vIGZpZWxkcyBpcyBhIHVzYWdlXG4gICAgICAvLyBlcnJvciwgbm90IGEgc2lsZW50IG5vLW9wIFBPU1QuXG4gICAgICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9XG4gICAgICAgIG92ZXJyaWRlID8/XG4gICAgICAgIE9iamVjdC5mcm9tRW50cmllcyhcbiAgICAgICAgICAoW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiXSBhcyBjb25zdClcbiAgICAgICAgICAgIC5maWx0ZXIoKGspID0+IHBhcnNlZC52YWx1ZXNba10gIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgIC5tYXAoKGspID0+IFtrLCBwYXJzZWQudmFsdWVzW2tdXSksXG4gICAgICAgICk7XG4gICAgICBpZiAoT2JqZWN0LmtleXMoYm9keSkubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiB1cGRhdGUgPGlkPiAoYXQgbGVhc3Qgb25lIG9mIC0tdGl0bGV8LS1zdGF0dXN8LS1kZWxpdmVyYWJsZXwtLWRldGFpbClcXG5cIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQsIGAvJHtpZH1gKSwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJjbGFpbVwiKSB7XG4gICAgICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgICAgIGlmICghaWQgfHwgcGFyc2VkLnZhbHVlcy5vd25lciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiBjbGFpbSA8aWQ+IC0tb3duZXIgPHdobz5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYmFzZShwb3J0LCBgLyR7aWR9L2NsYWltYCksIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBvd25lcjogcGFyc2VkLnZhbHVlcy5vd25lciB9KSxcbiAgICAgIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcInJlbGVhc2VcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiByZWxlYXNlIDxpZD5cIik7XG4gICAgICB9XG4gICAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYmFzZShwb3J0LCBgLyR7aWR9L3JlbGVhc2VgKSwgeyBtZXRob2Q6IFwiUE9TVFwiIH0pO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBpZiAoc3ViID09PSBcInN1YnRhc2tcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBjb25zdCBtb2RlcyA9IFtcbiAgICAgICAgcGFyc2VkLnZhbHVlcy5hZGQgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgcGFyc2VkLnZhbHVlcy5jaGVjayAhPT0gdW5kZWZpbmVkLFxuICAgICAgICBwYXJzZWQudmFsdWVzLnVuY2hlY2sgIT09IHVuZGVmaW5lZCxcbiAgICAgIF07XG4gICAgICBpZiAoIWlkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgICBcInVzYWdlOiBjbGkudHMgam9iIHN1YnRhc2sgPGlkPiAoLS1hZGQgPGxhYmVsPiB8IC0tY2hlY2sgPHN1YnRhc2tJZD4gfCAtLXVuY2hlY2sgPHN1YnRhc2tJZD4pXFxuXCIsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBjb25zdCBqb2JCb2R5ID1cbiAgICAgICAgcGFyc2VkLnZhbHVlcy5hZGQgIT09IHVuZGVmaW5lZFxuICAgICAgICAgID8geyBvcDogXCJhZGRcIiwgbGFiZWw6IHBhcnNlZC52YWx1ZXMuYWRkIH1cbiAgICAgICAgICA6IHBhcnNlZC52YWx1ZXMuY2hlY2sgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyB7IG9wOiBcImNoZWNrXCIsIHN1YnRhc2tJZDogcGFyc2VkLnZhbHVlcy5jaGVjayB9XG4gICAgICAgICAgICA6IHsgb3A6IFwidW5jaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMudW5jaGVjayB9O1xuICAgICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGJhc2UocG9ydCwgYC8ke2lkfS9zdWJ0YXNrYCksIHtcbiAgICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoam9iQm9keSksXG4gICAgICB9KTtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgICByZXR1cm4gMDtcbiAgICB9XG4gICAgaWYgKHN1YiA9PT0gXCJkZWxldGVcIikge1xuICAgICAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgICBpZiAoIWlkKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGpvYiBkZWxldGUgPGlkPlwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChiYXNlKHBvcnQsIGAvJHtpZH1gKSwgeyBtZXRob2Q6IFwiREVMRVRFXCIgfSk7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgam9iIDxjcmVhdGV8dXBkYXRlIDxpZD58Y2xhaW0gPGlkPiAtLW93bmVyIDx3aG8+fHJlbGVhc2UgPGlkPnxzdWJ0YXNrIDxpZD4gLi4ufGxpc3R8ZGVsZXRlIDxpZD4+XFxuXCIsXG4gICAgKTtcbiAgfVxuXG4gIGlmICh2ZXJiID09PSBcImFjdGl2aXR5XCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwiYWN0aXZpdHlcIiwgcmVzdCk7XG4gICAgY29uc3Qgc3RhdGUgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gICAgaWYgKHN0YXRlICE9PSBcInJlY2VpdmVkXCIgJiYgc3RhdGUgIT09IFwidGhpbmtpbmdcIiAmJiBzdGF0ZSAhPT0gXCJpZGxlXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIGFjdGl2aXR5IDxyZWNlaXZlZHx0aGlua2luZ3xpZGxlPiBbLS1tZXNzYWdlIDxpZD5dXCIpO1xuICAgIH1cbiAgICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICAgIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpdml0eSR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgc3RhdGUsIG1lc3NhZ2VJZDogcGFyc2VkLnZhbHVlcy5tZXNzYWdlIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICBpZiAodmVyYiA9PT0gXCJzZW5kXCIpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVZlcmJBcmdzKFwic2VuZFwiLCByZXN0KTtcbiAgICAvLyBSb3VuZCAzIChDbGFpbSBDMSk6IGdyYXBldmluZSdzIGJvZHktcmVzb2x1dGlvbiBjaGFpbiwgcHJlY2VkZW5jZVxuICAgIC8vIC0tYm9keS1maWxlID4gLS1zdGRpbiA+IGlubGluZSBwb3NpdGlvbmFsID4gcGlwZWQtc3RkaW4gZGVmYXVsdC5cbiAgICAvLyBTaGFycCBlZGdlIChtZWFzdXJlZCwgaG91c2Utd2lkZSk6IHRoZSBwaXBlZC1zdGRpbiBkZWZhdWx0IEhBTkdTXG4gICAgLy8gRk9SRVZFUiB1bmRlciBhZ2VudCBzaGVsbHMgKGlzVFRZIG51bGwsIG5vIEVPRikg4oCUIG5vIHJlYWQgdGltZW91dCBvblxuICAgIC8vIHB1cnBvc2UgKGl0IHdvdWxkIGJyZWFrIHNsb3cgcGlwZXMpOyBhbHdheXMgcGFzcyBhIGJvZHkuXG4gICAgY29uc3QgaGFzSW5saW5lID0gcGFyc2VkLnBvc2l0aW9uYWxzLmxlbmd0aCA+IDA7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICBsZXQgZnJvbUlubGluZSA9IGZhbHNlO1xuICAgIGlmIChwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IHBhdGggPSBwYXJzZWQudmFsdWVzW1wiYm9keS1maWxlXCJdO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICAgIHRocm93IHVzYWdlRXJyb3IoYHNlbmQ6IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwYXRofWApO1xuICAgICAgfVxuICAgICAgLy8gVHJhaWxpbmcgbmV3bGluZSBzdHJpcHBlZCAoZmlsZXMgYW5kIGhlcmVkb2NzIGVuZCB3aXRoIG9uZTsgdGhlXG4gICAgICAvLyBtZXNzYWdlIHNob3VsZG4ndCkg4oCUIG1hdGNoaW5nIC0tc3RkaW4sIGFuZCBncmFwZXZpbmUuXG4gICAgICB0ZXh0ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG4gICAgfSBlbHNlIGlmIChwYXJzZWQudmFsdWVzLnN0ZGluIHx8ICghaGFzSW5saW5lICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgICAgdGV4dCA9IChhd2FpdCBCdW4uc3RkaW4udGV4dCgpKS5yZXBsYWNlKC9cXG4kLywgXCJcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRleHQgPSBwYXJzZWQucG9zaXRpb25hbHMuam9pbihcIiBcIik7XG4gICAgICBmcm9tSW5saW5lID0gdHJ1ZTtcbiAgICB9XG4gICAgLy8gQW4gRU1QVFkgcmVzb2x2ZWQgYm9keSBpcyBhIHVzYWdlIGVycm9yIChleGl0IDIpLCB3aGF0ZXZlciBwYXRoXG4gICAgLy8gcHJvZHVjZWQgaXQg4oCUIGEgYmxhbmsgbWVzc2FnZSBoZWxwcyBub2JvZHkgYW5kIHVzdWFsbHkgbWVhbnMgYSBmdW1ibGUuXG4gICAgaWYgKHRleHQgPT09IFwiXCIpIHtcbiAgICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICAgIFwidXNhZ2U6IGNsaS50cyBzZW5kIDx0ZXh0Li4uPiB8IC0tYm9keS1maWxlIDxwYXRoPiB8IC0tc3RkaW5cXG5cIiArXG4gICAgICAgICAgXCJtaW5kLW1hcHBlcjogc2VuZCByZXNvbHZlZCBhbiBlbXB0eSBib2R5IOKAlCBub3RoaW5nIHNlbnRcXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIEEgZnVtYmxlZCBoZXJlZG9jIHBpcGVzIHRoZSBsaXRlcmFsIHNlbmQgaW52b2NhdGlvbiBpbiBhcyB0aGUgYm9keSDigJRcbiAgICAvLyByZWZ1c2UgdG8gcG9zdCB0aGF0IChuYXJyb3dlZCB0byB0aGUgc2VuZCB2ZXJiOyAtLWZvcmNlIG92ZXJyaWRlcyBmb3JcbiAgICAvLyBhIGJvZHkgdGhhdCBnZW51aW5lbHkgcXVvdGVzIHRoZSBjb21tYW5kKS5cbiAgICBpZiAoIXBhcnNlZC52YWx1ZXMuZm9yY2UgJiYgLyg/Ol58XFxuKVsgXFx0XSpidW5cXGJbXlxcbl0qXFxiY2xpXFwudHNcXGJbXlxcbl0qXFxic2VuZFxcYi8udGVzdCh0ZXh0KSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgXCJtaW5kLW1hcHBlcjogdGhhdCBib2R5IGxvb2tzIGxpa2UgYSBsZWFrZWQgY2xpIGludm9jYXRpb24gKGEgZnVtYmxlZCBoZXJlZG9jPykuIFwiICtcbiAgICAgICAgICBcIk5vdGhpbmcgd2FzIHNlbnQuIFBpcGUgdGhlIHJlYWwgYm9keSB2aWEgLS1zdGRpbiBvciAtLWJvZHktZmlsZSA8cGF0aD4sIFwiICtcbiAgICAgICAgICBcIm9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cXG5cIixcbiAgICAgICk7XG4gICAgfVxuICAgIC8vIElubGluZSBib2RpZXMgd2l0aCBzdXJ2aXZpbmcgc2hlbGwgbWV0YWNoYXJhY3RlcnMgbWFkZSBpdCB0aHJvdWdoIFRISVNcbiAgICAvLyB0aW1lIOKAlCB3YXJuIChzdGRlcnIsIG5ldmVyIGJsb2NrcykgYW5kIHN0ZWVyIHRvIHRoZSBzaGVsbC1mcmVlIHBhdGhzLlxuICAgIGlmIChmcm9tSW5saW5lICYmIC9gfFxcJFxcKHxcXCRcXHsvLnRlc3QodGV4dCkpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBcIiMgd2FybmluZzogaW5saW5lIGJvZHkgY29udGFpbnMgc2hlbGwgbWV0YWNoYXJhY3RlcnMgKGJhY2t0aWNrLCAkKCksIGN1cmx5LWJyYWNlIHZhcnMpLiBcIiArXG4gICAgICAgICAgXCJJdCB3YXMgc2VudCBhcy1pcywgYnV0IHRoZSBzaGVsbCBjYW4gY29tbWFuZC1zdWJzdGl0dXRlIHRoZXNlIGZpcnN0IOKAlCBcIiArXG4gICAgICAgICAgXCJ1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc2VuZCR7cXN9YCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgcm9sZTogcGFyc2VkLnZhbHVlcy5yb2xlID8/IFwiYWdlbnRcIixcbiAgICAgICAga2luZDogcGFyc2VkLnZhbHVlcy5raW5kID8/IFwidHVyblwiLFxuICAgICAgICB0ZXh0LFxuICAgICAgICAvLyBGbGF0dGVuIHJlcGVhdHMsIHNwbGl0IGNvbW1hcywgZHJvcCBibGFuayBmcmFnbWVudHMg4oCUIGFuIGVtcHR5XG4gICAgICAgIC8vIHJlc29sdmVkIGxpc3QgcG9zdHMgYXMgbm8gZ3JvdW5kIGF0IGFsbCAobmV2ZXIgW1wiXCJdKS5cbiAgICAgICAgZ3JvdW5kOiAoKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHJlZnMgPSAocGFyc2VkLnZhbHVlcy5ncm91bmQgPz8gW10pXG4gICAgICAgICAgICAuZmxhdE1hcCgoZykgPT4gZy5zcGxpdChcIixcIikpXG4gICAgICAgICAgICAubWFwKChnKSA9PiBnLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoKGcpID0+IGcgIT09IFwiXCIpO1xuICAgICAgICAgIHJldHVybiByZWZzLmxlbmd0aCA+IDAgPyByZWZzIDogdW5kZWZpbmVkO1xuICAgICAgICB9KSgpLFxuICAgICAgfSksXG4gICAgfSk7XG4gICAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZXNwb25zZVRleHR9XFxuYCk7XG4gICAgLy8gUm91bmQgMTEgKFNFQU0gMSk6IG1pcnJvciB0aGUgZGFlbW9uJ3MgdW5rbm93bi1jaGFubmVsIGFkdmlzb3J5IHRvIHN0ZGVycixcbiAgICAvLyBzYW1lIGFzIHByb3Bvc2UtZWRnZSdzIGRyYWZ0IHdhcm5pbmcg4oCUIGEgdHlwbydkIGAtLWtpbmRgIGlzIG90aGVyd2lzZSBhXG4gICAgLy8gbWVzc2FnZSB0aGF0IHNpbGVudGx5IHJlbmRlcnMgYXMgYSBwbGFpbiBjaGF0IHR1cm4uXG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShyZXNwb25zZVRleHQpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgICAgaWYgKHR5cGVvZiB3YXJuaW5nID09PSBcInN0cmluZ1wiKSBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyB3YXJuaW5nOiAke3dhcm5pbmd9XFxuYCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgICB9XG4gICAgcmV0dXJuIDA7XG4gIH1cblxuICAvLyBSb290IGZhbGx0aHJvdWdoIOKAlCBOQU1FIHRoZSBvZmZlbmRpbmcgdG9rZW4sIGFuZCBkaXN0aW5ndWlzaCBmbGFnLXNoYXBlZFxuICAvLyBmcm9tIHZlcmItc2hhcGVkOiBcIi0teCBhdCB0aGUgcm9vdFwiIHNlbmRzIHRoZSBjYWxsZXIgdG8gcHV0IGl0IGFmdGVyIGFcbiAgLy8gdmVyYiwgXCJ1bmtub3duIHZlcmIgeFwiIHNlbmRzIHRoZW0gdG8gdGhlIHJvc3RlciAoY2hvaWNlcykuIEEgYmFyZVxuICAvLyBpbnZvY2F0aW9uIG5hbWVkIG5vdGhpbmcgYXQgYWxsIOKAlCBhIHVzYWdlIGVycm9yLCBub3QgYSBoZWxwIHBhdGggKHRoaXMgQ0xJXG4gIC8vIGlzIGFnZW50LWRyaXZlbjsgbWFncGllJ3MgcnVsaW5nKS5cbiAgLy9cbiAgLy8gY2hvaWNlcyBuYW1lcyBFVkVSWVRISU5HIHRoZSBwYXJzZXIgYWNjZXB0czogdGhlIHJvc3RlciB2ZXJicyBwbHVzIHRoZVxuICAvLyBhY2NlcHRlZCBhbGlhcyBzcGVsbGluZ3MsIGFsaWFzZXMgYXBwZW5kZWQgYWZ0ZXIgdGhlIHJvc3RlclxuICAvLyAoZGV0ZXJtaW5pc3RpYykuIFZFUkJTIGFsb25lIHVuZGVyc3RhdGVkIHRoZSBhY2NlcHRlZCBzZXQgYnkgZXhhY3RseSB0aGVcbiAgLy8gYWxpYXNlcyDigJQgYWNjJ3MgYWR2ZXJ0aXNlZC12ZXJicyBjb21wYXJpc29uIGZsYWdnZWQgYG1lc3NhZ2VgIGFzIHJlY29yZGVkXG4gIC8vIGJ1dCBuZXZlciBhZHZlcnRpc2VkIChncmFwZXZpbmUncyBvbmUtcm93LXBlci1hbGlhcyByZWdpc3RyeSBpcyB0aGUgaG91c2VcbiAgLy8gcHJlY2VkZW50IHRoaXMgbWF0Y2hlcykuIEhlbHAgaXMgTk9UIHRvdWNoZWQ6IHRoZSBhbGlhcyBzdGF5cyBhZHZlcnRpc2VkXG4gIC8vIG9uIGl0cyB0YXJnZXQncyBsaW5lIHBlciB0aGUgIzEwOTcgcnVsaW5nLlxuICBjb25zdCBWRVJCX0NIT0lDRVMgPSBbLi4uVkVSQlMsIC4uLk9iamVjdC5rZXlzKFZFUkJfQUxJQVNFUyldO1xuICBpZiAodmVyYiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcIm5vIHZlcmIgZ2l2ZW5cIiwgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQl9DSE9JQ0VTIH0pO1xuICB9XG4gIGlmICh2ZXJiLnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIGB1bmtub3duIGZsYWcgYXQgdGhlIHJvb3Q6ICR7dmVyYn0gKGZsYWdzIGJlbG9uZyBhZnRlciBhIHZlcmI7IHJvb3QgdG9rZW5zIGFyZSAtLWhlbHAvLWggYW5kIC0tdmVyc2lvbi8tVilgLFxuICAgICAgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQl9DSE9JQ0VTIH0sXG4gICAgKTtcbiAgfVxuICB0aHJvdyB1c2FnZUVycm9yKGB1bmtub3duIHZlcmI6ICR7dmVyYn1gLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBWRVJCX0NIT0lDRVMgfSk7XG59XG5cbi8qKlxuICogVGhlIENMSSdzIG9uZSBlbnRyeSwgY2FsbGVkIGJ5IHRoZSBsYXVuY2hlciBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9taW5kLW1hcHBlci9zY3JpcHRzL2NsaS50c2AuXG4gKlxuICog4puUIFRIRVJFIElTIE5PIGBpbXBvcnQubWV0YS5tYWluYCBCTE9DSywgQU5EIFRIQVQgSVMgVEhFIFBPSU5ULlxuICogYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSB0aGUgbGF1bmNoZXIsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzXG4gKiBlbnRyeSwgc28gYGltcG9ydC5tZXRhLm1haW5gIGlzIEZBTFNFIGluIHRoZSBidW5kbGU6IGEgYmxvY2sgaGVyZSB3b3VsZCBuZXZlclxuICogcnVuIGFuZCB0aGUgQ0xJIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kIGV4aXQgMCBmb3IgZXZlcnkgdmVyYi4gVGhpcyBleHBvcnQgaXNcbiAqIHdoYXQgcmVwbGFjZXMgaXQuIEFuZCB0aGUgc291cmNlIGtlZXBzIG5vIHNlY29uZCBlbnRyeSBkZWxpYmVyYXRlbHkg4oCUIHRoZVxuICogYXJpdGhtZXRpYyBhYm92ZSBpcyB0cnVlIGF0IHRoZSBhcnRpZmFjdCdzIGFkZHJlc3MgYW5kIGZhbHNlIGF0IHRoaXMgZmlsZSdzLFxuICogc28gb2ZmZXJpbmcgYGJ1biBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9jbGkudHNgIHdvdWxkIGJlIG9mZmVyaW5nIGEgd3JvbmdcbiAqIHByb2Nlc3MgKHBsYXlib29rIEIzKS5cbiAqXG4gKiDim5QgSVQgUkVUVVJOUyBUSEUgQ09ERSBSQVRIRVIgVEhBTiBTRVRUSU5HIElULiBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbiAqIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlXG4gKiAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdFxuICogZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5XG4gKiB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWVcbiAqIHNoYXBlLCBzYW1lIHJlYXNvbi4gVGhlIGFzc2lnbm1lbnQgaGFwcGVucyBvbmNlLCBpbiB0aGUgbGF1bmNoZXIuIERvIG5vdCB0aWR5XG4gKiB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTOiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVNcbiAqIGl0LCB3aGljaCBpcyB0aGlzIG9uZS4gQSBsYXVuY2hlciByZWFkaW5nIHRoZSBhcmd1bWVudCB2ZWN0b3Igd291bGQgbWF0Y2ggdGhlXG4gKiBhcmctcGFyc2luZyBwcmVkaWNhdGUgaW4gYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBMEdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFZQSxJQUFNLGFBQWEsWUFBWTtBQU8vQixJQUFNLGdCQUFnQixL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TSxTQUFTO0FBQUEsRUFDeEIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixhQUFhLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDOUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixLQUFLLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdEIsWUFBWSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzdCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixPQUFPLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFHekIsUUFBUSxFQUFFLE1BQU0sVUFBVSxVQUFVLEtBQUs7QUFBQSxFQUN6QyxTQUFTLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDM0IsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixXQUFXLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDN0IsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsUUFBUSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3pCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsVUFBVSxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQzVCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLFVBQVUsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMzQixPQUFP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
