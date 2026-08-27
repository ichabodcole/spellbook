#!/usr/bin/env bun

// mind-mapper — the full verb set (V1 + V1.x + Round 3):
//   open          spawn (or find) the daemon, print its url, open the browser
//                 --project <id> scopes the url (?project=); open never mints —
//                 an unknown id errors (use projects --create first)
//                 --port <n> binds a STABLE port so a browser refresh reconnects
//                 across an environment-reap + restart. Two wrinkles: (1) against
//                 a LIVE daemon --port N is IGNORED (open returns the existing
//                 daemon) — the stable url holds only if the FIRST open set it;
//                 (2) if port N is already in use the daemon exits and this poll
//                 times out ("daemon did not come up") — pick a free port.
//   state         GET /state → the real project snapshot on stdout
//                 --skeleton returns ids/titles/degree only (context budgeting)
//                 fresh store with no project → the needs-project 409 rides
//                 the error envelope (conflict, exit 6; body under error.server)
//   tail          Monitor-shaped: GET /events?since=<cursor> SSE → one JSON
//                 line per event on stdout
//                 --inbound filters server-side to human-originated events
//                 (chat + dropped nodes) + opens with a kind:"grounding" line
//   projects      list saved projects; --create <title> makes a new one
//   ingest        --title T (--file P | --stdin) → POST /ingest
//   propose-node  --stdin JSON {draft, evidence, suggestedTier?} → POST /proposals
//   propose-edge  same shape, kind: "edge" (source/target may be a real node
//                 id OR a pending proposal's id — ratify resolves the latter)
//                 --zone <id> stages the proposal in a zone
//   propose-batch --stdin JSON {nodes:[{ref, draft, ...}], edges:[{draft:{
//                 source, target, label?}}]} — one transaction; an edge
//                 endpoint may be a node's LOCAL REF (resolved to the minted
//                 id server-side), a real node id, or a pending proposal id.
//                 Returns {refToId, proposals}
//   read <id>     GET /message/:id → the full message row (alias: message <id>)
//   node anchor <id> (--to <parentId> | --clear)  POST /nodes/:id/anchor —
//                 anchor a real node under a parent in the submap tree, or
//                 --clear to move it back to top-level (cycles rejected)
//   zone          create <name> (slug id derived) | list | delete <id> [--yes]
//                 (delete cascades the zone's proposals; populated zones 409
//                 without --yes)
//   promote <id>  move a zoned pending proposal to the main review queue
//                 (edge endpoints must promote first — error names them)
//   proposal zone <id> (--to <zoneId> | --clear)  POST /proposals/:id/zone —
//                 move a PENDING proposal INTO a zone (the inverse of promote),
//                 or --clear to move it back to main
//   doc <id>      GET /doc/:id → the doc envelope on stdout
//   doc delete <id> [--force]  DELETE /doc/:id → 409 {error:"cited", citedBy}
//                 when cited and unforced; --force cascades
//   doc kind <docId> <kind> [--author user|agent] | doc kind <docId> --clear
//                 POST /doc/:id/kind — assert (or clear) a doc's kind; ingest
//                 never guesses one (untyped = kind null on the wire)
//   mark <docId> --status <s> [--note <t>]  POST /doc/:id/mark → append a
//                 status mark (doc.marked carries the full mark inline)
//   actions <targetId> (--set <json> | --stdin | --clear)  PUT/DELETE
//                 /actions/:targetId — replace (wholesale) or clear the
//                 action slots on a node or PENDING proposal; json is an
//                 array of {id, label, seed}; >4 entries warns (soft cap)
//   tags <targetId> (--set <json> | --stdin | --clear)  PUT/DELETE
//                 /tags/:targetId — replace (wholesale) or clear the freeform
//                 tags on a node or PENDING proposal; json is an array of
//                 strings; tags also ride propose-* stdin JSON (a `tags` key)
//   job           create --title T [--status s] [--deliverable ref] [--detail x]
//                 | update <id> [--title/--status/--deliverable/--detail]
//                 | claim <id> --owner <who> (atomic lease; 409 if held by
//                   another owner) | release <id> | subtask <id> (--add <label>
//                   | --check <subtaskId> | --uncheck <subtaskId>) | list
//                 | delete <id>. A persisted unit of AGENT WORK (status +
//                 sub-tasks + deliverable + owner); create/update also take a
//                 full JSON body via --stdin / --body-file
//   activity <received|thinking|idle>  POST /activity → fire-and-forget
//                 agent.activity signal (~60s TTL emits synthetic idle)
//   search <q...> GET /search → {hits: [{kind: node|doc|message, ...}]}
//   neighbors <id> [--depth 1]  GET /neighbors/:id → local hood + edge reasons
//   ratify <id> --ruling canon|thread|story-local|reject [--doc-edit <file>]
//                 [--doc <docId> --span <text>]  ratify-time evidence attach:
//                 for an EVIDENCE-LESS node proposal only, --doc names the doc
//                 home (must exist; requires --doc-edit) and mints the node's
//                 sources row with the optional --span excerpt
//   lens set (--node <id> [--depth n] | --doc <docId>) | lens clear
//   look-here <nodeId>  fire-once attention nudge, not persisted
//   send          body chain: --body-file <path> > --stdin > inline <text...> >
//                 piped stdin; [--role user|agent] [--kind] [--ground a,b]
//                 (repeatable — repeats accumulate, commas split either way)
//                 [--force] → POST /send. Empty resolved body = usage error. The
//                 piped default HANGS with no pipe under agent shells — always
//                 pass a body (--body-file preferred for prose).
//                 R11: --kind is the CHANNEL the message arrived through
//                 (turn|analyze|canvas; open set — an unknown one is stored
//                 with a stderr advisory, never rejected).
//   activity <received|thinking|idle> [--message <id>]  → POST /activity. The
//                 messageId ties the signal to ONE message so the human sees
//                 which one is being worked; omitted, it inherits the open
//                 ladder's message. idle closes the ladder (there is no `done`
//                 — an agent `send` IS the completion signal).
//
// --project <id> is accepted by every verb above except open (scopes to a
// non-default project; omit for the default project).
//
// ERROR CONTRACT (acc L0, stated ONCE — per-verb prose above names HTTP
// statuses, this table is what the PROCESS does with them): every failure is
// ONE JSON envelope on stderr with stdout empty —
//   {ok:false, error:{kind, exit_code, retryable, message, hint?, choices?,
//    server?}, meta:{command}}
//   usage → exit 2 · internal → 1 · not_found → 5 (HTTP 404) · conflict → 6
//   (HTTP 409); HTTP 400 maps to usage. A daemon refusal carries the server's
//   own JSON body VERBATIM under error.server (needs-project, cited, zoned,
//   zone-not-empty, claim conflicts, …) — branch on kind/server, never prose.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const SCRIPT_DIR = import.meta.dir;
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
// dev: the daemon serves a Bun-bundled React surface; Bun reads bunfig.toml
// (the Tailwind plugin) from cwd ONLY, so the daemon's cwd MUST be
// src/mind-mapper/ (seams Contract 5 cwd-pin) — launched elsewhere, Tailwind
// is silently skipped. release: dist/ is pre-built and static — no bunfig
// read, so this path need not exist at all (a source-free marketplace clone
// has no top-level src/), and pinning cwd there anyway would break spawn.
const SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");

function daemonCwd(): string {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release") return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev") return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}

const HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
const PORT_FILE = join(HOME, "daemon.port");
const PID_FILE = join(HOME, "daemon.pid");

function livePort(): number | null {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE)) return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  const port = Number.parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || !Number.isFinite(port)) return null;
  try {
    process.kill(pid, 0); // liveness probe, no signal delivered
    return port;
  } catch {
    return null; // stale discovery files
  }
}

async function ensureDaemon(port?: string): Promise<number> {
  const running = livePort();
  // Round 7 (PORT): a live daemon IGNORES --port — the stable-url guarantee
  // only holds if the FIRST open set the port (the daemon binds once at boot).
  if (running !== null) return running;
  const proc = spawn(
    process.execPath,
    ["run", SERVER_SCRIPT, "--no-open", ...(port ? ["--port", String(port)] : [])],
    {
      detached: true,
      stdio: "ignore",
      cwd: daemonCwd(),
    },
  );
  proc.unref();
  // Poll discovery until the daemon writes its port (cold Bun bundle can lag).
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const port = livePort();
    if (port !== null) return port;
  }
  throw new CliError("internal", "daemon did not come up within 10s");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function envMs(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── error envelope (magpie's taxonomy, bounty's delivery) ───────────
//
// mind-mapper declares `defaultOutput: "json"`, and that declaration is about
// EVERY stream, not just the happy path. A failure is ONE JSON document on
// stderr; stdout stays empty because stdout carries data and a failure has
// none. `kind` is the contract; `message` is presentation — rewording a
// message must never break a caller, which it does the moment anyone matches
// on prose. Delivery is bounty's, not magpie's: THROW and let main() catch and
// RETURN the code — this CLI ships large stdout payloads, and a process.exit
// inside a die() would truncate them at 65,536 bytes (see the drain idiom at
// the bottom of this file).
type ErrKind = "usage" | "internal" | "not_found" | "conflict";

const EXIT_FOR: Record<ErrKind, number> = {
  usage: 2, // the caller can fix this by changing the command
  internal: 1, // mind-mapper (or its daemon transport) broke; the invocation may have been fine
  not_found: 5, // the named thing does not exist
  conflict: 6, // a precondition failed (cited, zoned, needs-project, claim held, …)
};

// The verb under execution, so the envelope can name it. Set once by dispatch.
let CURRENT_COMMAND: string | null = null;

class CliError extends Error {
  kind: ErrKind;
  hint?: string;
  choices?: string[];
  // A daemon-refused request carries the server's own JSON body here VERBATIM
  // (deliberate wrap-not-passthrough decision: the typed daemon errors —
  // needs-project, cited, zoned, zone-not-empty, claim conflicts — keep their
  // shape for callers that branch on them, while the process-level contract
  // stays ONE envelope on stderr with an empty stdout).
  server?: unknown;
  constructor(
    kind: ErrKind,
    message: string,
    extra?: { hint?: string; choices?: string[]; server?: unknown },
  ) {
    super(message);
    this.kind = kind;
    this.hint = extra?.hint;
    this.choices = extra?.choices;
    this.server = extra?.server;
  }
}

const usageError = (message: string, extra?: { hint?: string; choices?: string[] }) =>
  new CliError("usage", message, extra);

function writeEnvelope(e: CliError): number {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: {
        kind: e.kind,
        exit_code: EXIT_FOR[e.kind],
        // Nothing mind-mapper raises is worth retrying unchanged.
        retryable: false,
        message: e.message,
        ...(e.hint !== undefined ? { hint: e.hint } : {}),
        ...(e.choices !== undefined ? { choices: e.choices } : {}),
        ...(e.server !== undefined ? { server: e.server } : {}),
      },
      meta: { command: CURRENT_COMMAND },
    })}\n`,
  );
  return EXIT_FOR[e.kind];
}

// The one exit for every daemon round-trip: ok → the body text (caller prints
// it on stdout), refused → a typed CliError whose kind maps off the HTTP
// status and whose `server` field carries the daemon's own JSON body.
async function passOrThrow(res: Response): Promise<string> {
  const text = await res.text();
  if (res.ok) return text;
  let server: unknown = text;
  try {
    server = JSON.parse(text);
  } catch {
    /* non-JSON daemon body rides as the raw string */
  }
  const kind: ErrKind =
    res.status === 404
      ? "not_found"
      : res.status === 409
        ? "conflict"
        : res.status === 400
          ? "usage"
          : "internal";
  throw new CliError(kind, `${CURRENT_COMMAND ?? "request"} refused (HTTP ${res.status})`, {
    server,
  });
}

function requireDaemon(): number {
  const port = livePort();
  if (port === null) {
    throw new CliError("not_found", "no daemon running (use `open` first)");
  }
  return port;
}

// Skeleton projection — ids/titles/degree only, no synopsis/content. Kept as
// a client-side transform (the daemon stays dumb and always serves the full
// snapshot; skeleton is a courtesy shape for context-budgeted agent reads).
function toSkeleton(state: {
  nodes: Array<{ id: string; title: string; kind: string; tier: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
}) {
  const degree = new Map<string, number>();
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
      degree: degree.get(n.id) ?? 0,
    })),
  };
}

// ── the flag registry + verb spec (magpie's two-stage parse, path-extended) ──
//
// THE RECOGNIZED SET, AT PARSER ALTITUDE. Stage 1 parses every invocation
// against this whole registry (strict), so a token mind-mapper has never heard
// of is refused by node:util with its own message; stage 2 then asks the
// question the parser cannot: is this flag accepted AT THIS VERB. The order is
// the point — handing parseArgs a per-verb subset would answer `state --ruling`
// with "Unknown option '--ruling'", which is false and sends an agent hunting a
// typo it did not make.
//
// NO DEFAULTS in the registry, structurally: stage 2 detects a stray flag by
// key-presence in the parsed values, and a registry default would plant that
// key on every verb. Per-verb defaults live at the consumption site (?? "…").
const CLI_OPTIONS = {
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
  // send --ground is parseArgs-`multiple` BY SEAM (Contract 9 R4: repeats
  // accumulate, commas split) — any verb copying the pattern copies this too.
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
  zone: { type: "string" },
} as const;

// WHICH FLAGS EACH COMMAND PATH ACCEPTS — and the only source of the verb set.
// Keys are PATHS, not bare verbs: mind-mapper's grammar is two-token for the
// sub-commanded verbs (zone create, node edit, job claim …), so the spec
// extends magpie's flat table with space-joined paths. `resolvePath` picks the
// two-token key when the second token names a known sub, else the one-token
// key. The help text, the rejections' `choices` and the parser all read this
// one object; adding a flag to a verb is one edit.
export const VERB_SPEC = {
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
  help: [],
} as const satisfies Record<string, readonly (keyof typeof CLI_OPTIONS)[]>;

type VerbPath = keyof typeof VERB_SPEC;

// `message` is an advertised ALIAS of `read` (one message-fetch verb, two
// spellings) — an alias maps onto its target's path and never gets its own
// spec row, so the two can not drift apart.
export const VERB_ALIASES: Record<string, VerbPath> = { message: "read" };

// The advertised verb roster, DERIVED: top-level tokens of the spec paths.
export const VERBS = [...new Set(Object.keys(VERB_SPEC).map((p) => p.split(" ")[0] as string))];

// Paths whose grammar takes NO free positionals (everything they need rides
// flags); stage 2 refuses a stray token by name instead of silently
// dropping it. Every other path consumes positionals (ids, queries, prose).
const NO_POSITIONALS: ReadonlySet<VerbPath> = new Set([
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
  "help",
] as VerbPath[]);

const flagsFor = (path: VerbPath): string[] => VERB_SPEC[path].map((k) => `--${k}`).sort();

const subsOf = (verb: string): string[] =>
  Object.keys(VERB_SPEC)
    .filter((p) => p.startsWith(`${verb} `))
    .map((p) => p.slice(verb.length + 1));

// TWO STAGES, AND THE ORDER IS THE POINT (see the registry header). Also sets
// meta.command to the RESOLVED path so an envelope from `node edit` says so.
function parseVerbArgs(path: VerbPath, args: string[]) {
  CURRENT_COMMAND = path;
  const parsed = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: true,
    allowPositionals: true,
  });
  const allowed = new Set<string>(VERB_SPEC[path]);
  const stray = Object.keys(parsed.values).find((k) => !allowed.has(k));
  if (stray) {
    throw usageError(
      `--${stray} is not accepted by \`${path}\` (it is a recognized mind-mapper flag, just not this verb's)`,
      { choices: flagsFor(path) },
    );
  }
  if (NO_POSITIONALS.has(path) && parsed.positionals.length > 0) {
    throw usageError(
      `${path} takes no positional arguments (got "${parsed.positionals[0]}")`,
      VERB_SPEC[path].length > 0 ? { choices: flagsFor(path) } : undefined,
    );
  }
  return parsed;
}

const HELP = `mind-mapper — a co-present knowledge map: a dumb daemon holds the graph, the casting agent does the thinking.

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

  Output: every verb prints JSON on stdout by default, one document per answer —
  except tail, a stream that prints one JSON line per event. Prose, warnings and
  diagnostics go to stderr; failures exit non-zero (2 = usage).`;

// The plugin manifest is the one version source; the CLI reads it rather than
// mirroring the number (astrolabe's pattern). Layout-dependent, so absence
// degrades to "unknown" instead of inventing one.
function versionInfo(): { name: string; version: string } {
  try {
    const raw = readFileSync(
      join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json"),
      "utf8",
    );
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === "string") return { name: "mind-mapper", version: pkg.version };
  } catch {
    /* fall through to unknown */
  }
  return { name: "mind-mapper", version: "unknown" };
}

// parseArgs throws (ERR_PARSE_ARGS_UNKNOWN_OPTION etc.) on an unrecognized
// flag like a stray --help — uncaught, that's a stack-trace crash instead of
// a usage message (cassandra's P2 gate finding). Every verb's parseArgs call
// funnels through here so a bad flag always exits 2 with a one-line error.
async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } catch (e) {
    if (e instanceof CliError) return writeEnvelope(e);
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    // A stray/unknown flag (node:util strict) is the CALLER's to fix.
    if (code.startsWith("ERR_PARSE_ARGS")) return writeEnvelope(usageError(msg));
    // A body that failed to parse (stdin/--body-file JSON) — also the caller's.
    if (e instanceof SyntaxError) return writeEnvelope(usageError(`invalid JSON: ${msg}`));
    // A named file that is not there (--file/--doc-edit paths) — the caller's.
    if (code === "ENOENT") return writeEnvelope(usageError(msg));
    // Everything else is mind-mapper's own fault: one INTERNAL envelope, never
    // a stack trace — the process contract is JSON on stderr for EVERY failure.
    return writeEnvelope(new CliError("internal", msg));
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const verb = argv[0];
  const rest = argv.slice(1);
  // The envelope names the verb under execution (meta.command); root tokens
  // and the fallthrough leave it as the raw first token, which is the honest
  // answer to "what was being run when this failed".
  CURRENT_COMMAND = verb ?? null;

  // ROOT TOKENS FIRST, before any flag parsing (magpie/astrolabe pattern).
  // --help/-h resolve at the root; `help` is ALSO a dispatchable verb below, so
  // `help --foo` is a rejected flag, not a silently-tolerated one.
  if (verb === "--help" || verb === "-h") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  // Root TOKEN, deliberately NOT a flag: no per-verb parser below the root is
  // ever expected to accept it, and it carries no flags of its own.
  if (verb === "--version" || verb === "-V" || verb === "version") {
    process.stdout.write(`${JSON.stringify(versionInfo())}\n`);
    return 0;
  }
  if (verb === "help") {
    // Dispatchable verb with an EMPTY flag set — a strict parse of the rest
    // means `help --foo` is refused instead of ignored.
    parseVerbArgs("help", rest);
    process.stdout.write(`${HELP}\n`);
    return 0;
  }

  if (verb === "open") {
    const parsed = parseVerbArgs("open", rest);
    const port = await ensureDaemon(parsed.values.port);
    // --project scopes the printed URL + spawned browser (?project= rides
    // along). Open never mints: an unknown id is a usage error pointing at
    // `projects --create`, not a silent new store.
    const project = parsed.values.project;
    if (project !== undefined) {
      const res = await fetch(`http://127.0.0.1:${port}/projects`);
      const body = (await res.json()) as { projects: Array<{ id: string }> };
      if (!body.projects.some((p) => p.id === project)) {
        throw usageError(
          `unknown project: ${project} (open never creates one — use \`projects --create <title>\` first)`,
          { choices: body.projects.map((p) => p.id) },
        );
      }
    }
    const url = `http://127.0.0.1:${port}${project ? `/?project=${encodeURIComponent(project)}` : ""}`;
    if (!parsed.values["no-open"]) openBrowser(url);
    process.stdout.write(`${JSON.stringify({ ok: true, url })}\n`);
    return 0;
  }

  if (verb === "state") {
    const parsed = parseVerbArgs("state", rest);
    const port = requireDaemon();
    const params = new URLSearchParams();
    if (parsed.values.project) params.set("project", parsed.values.project);
    if (parsed.values.batch) params.set("batch", parsed.values.batch);
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/state${qs}`);
    // A non-ok /state (409 needs-project on a fresh store, 404 unknown
    // project) rides the error envelope with the daemon body under
    // error.server — the skeleton transform only runs on a real snapshot.
    const stateText = await passOrThrow(res);
    if (parsed.values.skeleton) {
      const state = JSON.parse(stateText) as Parameters<typeof toSkeleton>[0];
      process.stdout.write(`${JSON.stringify(toSkeleton(state))}\n`);
    } else {
      process.stdout.write(`${stateText}\n`);
    }
    return 0;
  }

  // Round 12 (SEAM 3): `changes --since <epochSeconds>` — the bounded delta.
  // Read the response's notCovered before trusting an empty one: "nothing
  // added" is NOT "nothing changed" (deletions, rejections and in-place edits
  // are invisible here by construction).
  if (verb === "changes") {
    const parsed = parseVerbArgs("changes", rest);
    if (parsed.values.since === undefined) {
      throw usageError(
        "changes requires --since <epochSeconds> (use 0 for everything, then pass back the `now` from the previous response)",
        {
          hint: "ADDITIONS ONLY — the response's notCovered names what it cannot see; a full `state` read is still the only way to reconcile deletions, rejections and in-place edits",
        },
      );
    }
    const port = requireDaemon();
    const params = new URLSearchParams({ since: parsed.values.since });
    if (parsed.values.project) params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/changes?${params}`);
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "tail") {
    const parsed = parseVerbArgs("tail", rest);
    const inbound = parsed.values.inbound === true;
    requireDaemon(); // no daemon at start is a usage error; mid-tail death is self-healed below
    // Watchdog ≈ 3 missed server keepalives (15s tick, Claim F); env
    // overrides are for the scripted-fake-server tests only.
    const idleMs = envMs("MIND_MAPPER_TAIL_IDLE_MS", 45_000);
    const retryMs = envMs("MIND_MAPPER_TAIL_RETRY_MS", 1_000);
    const since = Number.parseInt(parsed.values.since as string, 10);
    let cursor = Number.isFinite(since) ? since : 0;
    let epoch: string | null = null;
    // The server (re-)emits a grounding frame at the top of EVERY inbound SSE
    // connect; forward only the FIRST so the agent's Monitor sees exactly one
    // grounding line, not one per reconnect (F5: first-connect line).
    let grounded = false;

    // Standing, self-healing loop (Monitor-shaped): each connection attempt
    // gets its own AbortController plus a rolling idle watchdog reset on
    // every received RAW chunk before frame parsing — keepalive comments must
    // feed the watchdog even though the data-line filter discards them. On
    // fire (or any transport error): abort → reconnect with the last-seen
    // seq. A reconnect that lands on a different epoch means the daemon
    // restarted: reset the cursor to 0 and synthesize an {kind:
    // "epoch.changed"} stdout line so the casting agent refetches state —
    // CLI-synthesized only, never a bus event (the browser WS never sees it).
    for (;;) {
      const port = livePort();
      if (port === null) {
        await new Promise((r) => setTimeout(r, retryMs));
        continue;
      }
      const params = new URLSearchParams({ since: String(cursor) });
      if (parsed.values.project) params.set("project", parsed.values.project);
      if (inbound) params.set("inbound", "1");
      const controller = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      const resetWatchdog = () => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), idleMs);
      };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/events?${params}`, {
          signal: controller.signal,
        });
        // A refused connection (409 needs-project on a projectless store,
        // 404 unknown project) is a usage error, not a transport blip —
        // retrying it forever would just spin silently.
        if (res.status === 409 || res.status === 404) {
          if (watchdog !== null) clearTimeout(watchdog);
          // Reuse the one status→kind mapping: passOrThrow always throws here.
          await passOrThrow(res);
        }
        if (!res.body) throw new Error("no body");
        resetWatchdog();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          resetWatchdog(); // raw chunk, before frame parsing
          buf += decoder.decode(value, { stream: true });
          for (let idx = buf.indexOf("\n\n"); idx !== -1; idx = buf.indexOf("\n\n")) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            const line = dataLine.slice("data: ".length);
            try {
              const event = JSON.parse(line) as { seq?: unknown; epoch?: unknown; kind?: unknown };
              // Grounding is a synthetic, seq-less first-connect frame — forward
              // the first, suppress re-groundings on reconnect (exactly one per
              // process). It never carries seq/epoch, so cursor/epoch are
              // untouched either way.
              if (event.kind === "grounding") {
                if (!grounded) {
                  grounded = true;
                  process.stdout.write(`${line}\n`);
                }
                continue;
              }
              if (typeof event.epoch === "string") {
                if (epoch !== null && event.epoch !== epoch) {
                  cursor = 0;
                  process.stdout.write(
                    `${JSON.stringify({ kind: "epoch.changed", epoch: event.epoch })}\n`,
                  );
                }
                epoch = event.epoch;
              }
              if (typeof event.seq === "number") cursor = event.seq;
            } catch {
              /* non-JSON data line — pass through untracked */
            }
            process.stdout.write(`${line}\n`);
          }
        }
      } catch (e) {
        // A typed refusal (409/404 via passOrThrow) is a usage-class exit, not
        // a transport blip — retrying it forever would just spin silently.
        if (e instanceof CliError) throw e;
        /* watchdog abort or transport error — reconnect below */
      } finally {
        if (watchdog !== null) clearTimeout(watchdog);
      }
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }

  if (verb === "projects") {
    const parsed = parseVerbArgs("projects", rest);
    const port = requireDaemon();
    if (parsed.values.create) {
      const title = parsed.values.create;
      const id = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const res = await fetch(`http://127.0.0.1:${port}/projects`, {
        method: "POST",
        body: JSON.stringify({ id, title }),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    process.stdout.write(`${await passOrThrow(res)}\n`);
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
    const text = parsed.values.file
      ? readFileSync(parsed.values.file, "utf8")
      : await Bun.stdin.text();
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/ingest${qs}`, {
      method: "POST",
      body: JSON.stringify({ title: parsed.values.title, text }),
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "propose-node" || verb === "propose-edge") {
    const parsed = parseVerbArgs(verb, rest);
    if (!parsed.values.stdin) {
      throw usageError(
        `${verb} requires --stdin JSON {draft, evidence[, suggestedTier, author, tags, batchId]}`,
        {
          hint:
            'propose-edge endpoints: a node id, a pending node-proposal id, or "title:<exact node title>" ' +
            "(title refs resolve at INTAKE against ratified nodes only, exact + case-sensitive; " +
            "an ambiguous title errors and names every candidate id)",
        },
      );
    }
    const input = JSON.parse(await Bun.stdin.text()) as {
      draft: unknown;
      evidence?: { docId?: string; messageId?: string; span?: string };
      suggestedTier?: string;
      author?: string;
      // Round 7 (TAGS): propose-time tags ride the stdin JSON — must be
      // forwarded into the POST body, or the /proposals route never sees them
      // (the batch path forwards its node tags; the single verb must too).
      tags?: string[];
      // Round 12 (SEAM 1): join an existing staging act (from propose-batch).
      batchId?: string;
    };
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
        // --zone stages the proposal in a zone (flag wins; the stdin JSON
        // stays the draft/evidence shape — zone is routing, not content).
        zone: parsed.values.zone,
        // TAGS: forward the stdin tags (the route validates the shape).
        tags: input.tags,
        // SEAM 1: forward the stdin batchId (the body-mirror discipline — a
        // field added to the shared /proposals body must be threaded into EVERY
        // CLI verb that posts to it; the propose-node-tags scar).
        batchId: input.batchId,
      }),
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}\n`);
    // Mirror the daemon's additive edge-draft warning to stderr — a cold
    // agent scanning for problems sees it even if it doesn't parse stdout.
    if (verb === "propose-edge") {
      try {
        const { warning } = JSON.parse(responseText) as { warning?: string };
        if (typeof warning === "string") process.stderr.write(`# warning: ${warning}\n`);
      } catch {
        /* body is what it is */
      }
    }
    return 0;
  }

  if (verb === "propose-batch") {
    const parsed = parseVerbArgs("propose-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError(
        "propose-batch requires --stdin JSON {nodes:[{ref, draft, suggestedTier?, evidence?}], edges:[{draft:{source, target, label?}}]}",
        {
          hint:
            "an edge endpoint may be a node LOCAL REF (matches a node's ref in this batch), " +
            'a real node id, a pending proposal id, or "title:<exact node title>" — local refs ' +
            "resolve to minted ids and title refs to ratified node ids, both server-side; " +
            "optional batchId: omit and one is MINTED + returned; supply one to extend that act",
        },
      );
    }
    const input = JSON.parse(await Bun.stdin.text()) as {
      nodes?: unknown;
      edges?: unknown;
      batchId?: unknown;
    };
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/batch${qs}`, {
      method: "POST",
      body: JSON.stringify({
        nodes: input.nodes ?? [],
        edges: input.edges ?? [],
        // SEAM 1: omitted → the daemon mints a batchId and returns it; supplied
        // → this call joins that act (the "I forgot the edges" repair).
        batchId: input.batchId,
      }),
    });
    // Response carries {batchId, refToId: {<ref>: <mintedId>}, proposals: [...]}
    // — the ref→id map is the point for THIS call, and batchId is the point for
    // every later one (`state --batch <id>` reconciles a partial ratification).
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "ratify-batch") {
    const parsed = parseVerbArgs("ratify-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError(
        'ratify-batch requires --stdin JSON {ruling: "canon|thread|story-local", ids: [proposalId], anchors?: [{node, parent}]}',
        {
          hint:
            "ratifies the set in ONE call/txn; nodes ratify before edges (auto-partitioned), " +
            "edge endpoints + anchor refs resolve old proposal ids → minted node ids via the " +
            "returned idMap. NO auto-include of unlisted edges; reject is not a batch act",
        },
      );
    }
    const input = JSON.parse(await Bun.stdin.text()) as {
      ruling?: unknown;
      ids?: unknown;
      anchors?: unknown;
    };
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/ratify-batch${qs}`, {
      method: "POST",
      body: JSON.stringify({
        ruling: input.ruling,
        ids: input.ids ?? [],
        anchors: input.anchors,
      }),
    });
    // Response carries {idMap: {<oldProposalId>: <mintedNodeId>}, ratified:[...]}
    // — the idMap is the point (reconnect an edge/anchor to the real node).
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  // Round 12 (SEAM 5) — the inverse of ratify-batch: clear a set of proposals
  // in ONE transactional call instead of N HTTP deletes in a loop.
  if (verb === "delete-batch") {
    const parsed = parseVerbArgs("delete-batch", rest);
    if (!parsed.values.stdin) {
      throw usageError('delete-batch requires --stdin JSON {ids: ["<proposalId>", ...]}', {
        hint:
          "deletes the set in ONE txn — all-or-nothing: if any id is unknown, NOTHING is " +
          "deleted and the error names every unknown id. There is deliberately no " +
          "{batch: <id>} shorthand — run `state --batch <id>` and look before you sweep " +
          "(drive #10's bug was an over-broad cleanup that took the edges with it)",
      });
    }
    const input = JSON.parse(await Bun.stdin.text()) as { ids?: unknown };
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/delete-batch${qs}`, {
      method: "POST",
      body: JSON.stringify({ ids: input.ids ?? [] }),
    });
    const deleteBatchBody = await passOrThrow(res);
    process.stdout.write(`${deleteBatchBody}\n`);
    // R12 gate finding 1: mirror the stranded-node advisory to stderr, the same
    // way propose-edge mirrors edgeDraftWarning — a cold agent scanning for
    // problems sees it even if it never parses stdout. Advisory, not a failure:
    // the exit code is unchanged.
    try {
      const { warning } = JSON.parse(deleteBatchBody) as { warning?: string };
      if (typeof warning === "string") process.stderr.write(`# warning: ${warning}\n`);
    } catch {
      /* body is what it is */
    }
    return 0;
  }

  if (verb === "node") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("node").includes(sub)) {
      throw usageError(
        sub === undefined ? "node requires a sub-command" : `unknown node sub-command: ${sub}`,
        { choices: subsOf("node") },
      );
    }
    const parsed = parseVerbArgs(`node ${sub}` as VerbPath, rest.slice(1));
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    // Round 6 (DEL): `node delete <id> [--force]` — 409 {error:"cited",
    // citedBy:{edges, children}} when cited and unforced; --force cascades
    // (edges gone, children re-parented to top-level, detritus gone).
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts node delete <nodeId> [--force]");
      }
      const port = requireDaemon();
      const params = new URLSearchParams();
      if (parsed.values.project) params.set("project", parsed.values.project);
      if (parsed.values.force) params.set("force", "1");
      const dqs = params.size > 0 ? `?${params}` : "";
      const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}${dqs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    // Round 12 (SEAM 4): `node edit <id> [--title T] [--synopsis S] | --stdin`
    // — a ratified node can finally gain a synopsis (F2). Writes exactly what
    // it is given; tier and kind are NOT editable (see edit.ts for why).
    if (sub === "edit") {
      const id = parsed.positionals[0];
      const patch: { title?: string; synopsis?: string } = {};
      if (parsed.values.stdin) {
        // Prose belongs on stdin — a synopsis is a paragraph, not a flag value.
        Object.assign(
          patch,
          JSON.parse(await Bun.stdin.text()) as { title?: string; synopsis?: string },
        );
      }
      if (parsed.values.title !== undefined) patch.title = parsed.values.title;
      if (parsed.values.synopsis !== undefined) patch.synopsis = parsed.values.synopsis;
      if (!id || (patch.title === undefined && patch.synopsis === undefined)) {
        throw usageError(
          'usage: cli.ts node edit <nodeId> (--title <t> | --synopsis <s> | --stdin \'{"synopsis": "..."}\')',
          {
            hint:
              "writes exactly what it is given (no inference); only title/synopsis are editable — " +
              "tier is the human's ruling and kind is a ratification-time classification",
          },
        );
      }
      const port = requireDaemon();
      const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}${qs}`, {
        method: "POST",
        // Body-mirror discipline: thread every field explicitly (the
        // propose-node-tags scar) — an omitted key must stay omitted so the
        // route patches instead of blanking.
        body: JSON.stringify({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.synopsis !== undefined ? { synopsis: patch.synopsis } : {}),
        }),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub !== "anchor") {
      throw usageError(
        "usage: cli.ts node anchor <nodeId> (--to <parentId> | --clear) | node edit <nodeId> (--title <t> | --synopsis <s> | --stdin) | node delete <nodeId> [--force]\n",
      );
    }
    const id = parsed.positionals[0];
    const hasTo = parsed.values.to !== undefined;
    if (!id || (hasTo && parsed.values.clear) || (!hasTo && !parsed.values.clear)) {
      throw usageError(
        "usage: cli.ts node anchor <nodeId> (--to <parentId> | --clear)\n" +
          "  --to anchors the node under <parentId> (a real node id); --clear moves it to top-level\n",
      );
    }
    const port = requireDaemon();
    const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}/anchor${qs}`, {
      method: "POST",
      body: JSON.stringify({ parentId: parsed.values.clear ? null : parsed.values.to }),
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
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
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "zone") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("zone").includes(sub)) {
      throw usageError(
        sub === undefined ? "zone requires a sub-command" : `unknown zone sub-command: ${sub}`,
        { choices: subsOf("zone") },
      );
    }
    const parsed = parseVerbArgs(`zone ${sub}` as VerbPath, rest.slice(1));
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    if (sub === "create") {
      const name = parsed.positionals.join(" ");
      if (!name) {
        throw usageError("usage: cli.ts zone create <name>");
      }
      const res = await fetch(`http://127.0.0.1:${port}/zones${qs}`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "list") {
      const res = await fetch(`http://127.0.0.1:${port}/zones${qs}`);
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts zone delete <id> [--yes]");
      }
      const params = new URLSearchParams();
      if (parsed.values.project) params.set("project", parsed.values.project);
      if (parsed.values.yes) params.set("yes", "1");
      const dqs = params.size > 0 ? `?${params}` : "";
      const res = await fetch(`http://127.0.0.1:${port}/zones/${id}${dqs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}\n`);
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
      method: "POST",
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "proposal") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("proposal").includes(sub)) {
      throw usageError(
        sub === undefined
          ? "proposal requires a sub-command"
          : `unknown proposal sub-command: ${sub}`,
        { choices: subsOf("proposal") },
      );
    }
    const parsed = parseVerbArgs(`proposal ${sub}` as VerbPath, rest.slice(1));
    const pqs = parsed.values.project
      ? `?project=${encodeURIComponent(parsed.values.project)}`
      : "";
    // Round 6 (DEL): `proposal delete <id>` — thin, no guard (drop row +
    // cascade node_actions). The litter-clearing path (clear a raw
    // instruction-node through DELETE, not reject).
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts proposal delete <proposalId>");
      }
      const port = requireDaemon();
      const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}${pqs}`, {
        method: "DELETE",
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub !== "zone") {
      throw usageError(
        "usage: cli.ts proposal zone <id> (--to <zoneId> | --clear) | proposal delete <id>\n",
      );
    }
    const id = parsed.positionals[0];
    const hasTo = parsed.values.to !== undefined;
    if (!id || (hasTo && parsed.values.clear) || (!hasTo && !parsed.values.clear)) {
      throw usageError(
        "usage: cli.ts proposal zone <proposalId> (--to <zoneId> | --clear)\n" +
          "  --to moves a PENDING proposal INTO <zoneId>; --clear moves it back to the main queue\n",
      );
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/zone${qs}`, {
      method: "POST",
      body: JSON.stringify({ zoneId: parsed.values.clear ? null : parsed.values.to }),
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "doc") {
    // doc's sub is OPTIONAL (`doc <id>` reads) and rides the positionals, so a
    // registry-wide probe parse resolves the path before the per-path check.
    const probe = parseArgs({
      args: rest,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
    const docPath: VerbPath =
      probe.positionals[0] === "kind"
        ? "doc kind"
        : probe.positionals[0] === "delete"
          ? "doc delete"
          : "doc";
    const parsed = parseVerbArgs(docPath, rest);
    // `doc delete <id>` / `doc kind <id>` overload the positional (a doc
    // literally slugged "delete"/"kind" is unaddressable — accepted for the
    // record, plan-v1x).
    // Round 4 (K1): `doc kind <docId> <kind...> [--author user|agent]` sets,
    // `doc kind <docId> --clear` clears (author nulls with it). The ingest
    // defaults died — this verb is how a doc gets typed at all.
    if (parsed.positionals[0] === "kind") {
      const docId = parsed.positionals[1];
      const kindWords = parsed.positionals.slice(2).join(" ");
      if (!docId || (kindWords === "" && !parsed.values.clear)) {
        throw usageError(
          "usage: cli.ts doc kind <docId> <kind> [--author user|agent] | doc kind <docId> --clear\n",
        );
      }
      const port = requireDaemon();
      const qs = parsed.values.project
        ? `?project=${encodeURIComponent(parsed.values.project)}`
        : "";
      const res = await fetch(`http://127.0.0.1:${port}/doc/${docId}/kind${qs}`, {
        method: "POST",
        body: JSON.stringify(
          parsed.values.clear
            ? { kind: null }
            : { kind: kindWords, author: parsed.values.author ?? "agent" },
        ),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    const isDelete = parsed.positionals[0] === "delete";
    const id = isDelete ? parsed.positionals[1] : parsed.positionals[0];
    if (!id) {
      throw usageError(
        "usage: cli.ts doc <id> | doc delete <id> [--force] | doc kind <docId> <kind|--clear> [--project <id>]\n",
      );
    }
    const port = requireDaemon();
    const params = new URLSearchParams();
    if (parsed.values.project) params.set("project", parsed.values.project);
    if (isDelete && parsed.values.force) params.set("force", "1");
    const qs = params.size > 0 ? `?${params}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/doc/${id}${qs}`, {
      method: isDelete ? "DELETE" : "GET",
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
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
        status: parsed.values.status,
      }),
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
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
    if (parsed.values.project) params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/search?${params}`);
    process.stdout.write(`${await passOrThrow(res)}\n`);
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
    if (parsed.values.project) params.set("project", parsed.values.project);
    const res = await fetch(`http://127.0.0.1:${port}/neighbors/${id}?${params}`);
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "ratify") {
    const parsed = parseVerbArgs("ratify", rest);
    const proposalId = parsed.positionals[0];
    if (!proposalId || !parsed.values.ruling) {
      throw usageError(
        "usage: cli.ts ratify <proposalId> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <text>] [--anchor <parentId>]\n",
      );
    }
    // --doc requires --doc-edit — the daemon enforces it too, but a local
    // usage error beats a round-trip for the common slip.
    if (parsed.values.doc && !parsed.values["doc-edit"]) {
      throw usageError("--doc requires --doc-edit (the drafted doc home)");
    }
    const docEdit = parsed.values["doc-edit"]
      ? readFileSync(parsed.values["doc-edit"], "utf8")
      : undefined;
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/proposals/${proposalId}/ruling${qs}`, {
      method: "POST",
      body: JSON.stringify({
        ruling: parsed.values.ruling,
        docEdit,
        docId: parsed.values.doc,
        span: parsed.values.span,
        // Round 6 (RB): --anchor <parentId> ratifies then nests the minted
        // node under <parentId> in one atomic call (node proposals only).
        anchor: parsed.values.anchor,
      }),
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "lens") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("lens").includes(sub)) {
      throw usageError(
        sub === undefined ? "lens requires a sub-command" : `unknown lens sub-command: ${sub}`,
        { choices: subsOf("lens") },
      );
    }
    const parsed = parseVerbArgs(`lens ${sub}` as VerbPath, rest.slice(1));
    // Round 3 (Claim V2): one lens, two modes — --node and --doc are
    // exclusive at parse time (the daemon enforces the XOR too, but the
    // common slip should fail before a round-trip).
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
          depth: parsed.values.depth ? Number.parseInt(parsed.values.depth, 10) : undefined,
        }),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "clear") {
      const res = await fetch(`http://127.0.0.1:${port}/lens${qs}`, { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    throw usageError(
      "usage: cli.ts lens <set (--node <id> [--depth n] | --doc <docId>) | clear>\n",
    );
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
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "actions") {
    const parsed = parseVerbArgs("actions", rest);
    const targetId = parsed.positionals[0];
    const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
    if (!targetId || modes.filter(Boolean).length !== 1) {
      throw usageError(
        "usage: cli.ts actions <targetId> (--set <json> | --stdin | --clear)\n" +
          "  target is a node id or a PENDING proposal id; json is an array of\n" +
          '  {"id", "label", "seed"} — empty array (or --clear) removes the slots\n',
      );
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const target = `http://127.0.0.1:${port}/actions/${targetId}${qs}`;
    const res = parsed.values.clear
      ? await fetch(target, { method: "DELETE" })
      : await fetch(target, {
          method: "PUT",
          body: parsed.values.stdin ? await Bun.stdin.text() : (parsed.values.set as string),
        });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}\n`);
    // Mirror the daemon's additive soft-cap warning to stderr (the
    // edgeDraftWarning pattern — a cold agent scanning for problems sees it).
    try {
      const { warning } = JSON.parse(responseText) as { warning?: string };
      if (typeof warning === "string") process.stderr.write(`# warning: ${warning}\n`);
    } catch {
      /* body is what it is */
    }
    return 0;
  }

  // Round 7 (TAGS) — twin of the actions verb: wholesale replace / clear a
  // target's freeform tags. Target is a node id or a PENDING proposal id.
  if (verb === "tags") {
    const parsed = parseVerbArgs("tags", rest);
    const targetId = parsed.positionals[0];
    const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
    if (!targetId || modes.filter(Boolean).length !== 1) {
      throw usageError(
        "usage: cli.ts tags <targetId> (--set <json> | --stdin | --clear)\n" +
          "  target is a node id or a PENDING proposal id; json is an array of\n" +
          "  freeform strings — empty array (or --clear) removes the tags\n",
      );
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const target = `http://127.0.0.1:${port}/tags/${targetId}${qs}`;
    const res = parsed.values.clear
      ? await fetch(target, { method: "DELETE" })
      : await fetch(target, {
          method: "PUT",
          body: parsed.values.stdin ? await Bun.stdin.text() : (parsed.values.set as string),
        });
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  // Round 9 (Job Queue) — the `job` verb: create/update/claim/release/subtask/
  // list/delete, copying the `proposal <sub>` lifecycle shape + the tags
  // body-builder discipline. EVERY field is threaded into the POST body (the R7
  // gate scar: a hand-written body-builder is a MIRROR of the route's field set
  // and drifts silently — so update forwards each provided scalar, subtask
  // forwards op + label|subtaskId, claim forwards owner).
  if (verb === "job") {
    const sub = rest[0];
    if (sub === undefined || !subsOf("job").includes(sub)) {
      throw usageError(
        sub === undefined ? "job requires a sub-command" : `unknown job sub-command: ${sub}`,
        { choices: subsOf("job") },
      );
    }
    const parsed = parseVerbArgs(`job ${sub}` as VerbPath, rest.slice(1));
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const base = (port: number, suffix = "") => `http://127.0.0.1:${port}/jobs${suffix}${qs}`;
    // A JSON body from --body-file > --stdin overrides the flag-built body (the
    // send precedence chain), so a full job can be piped in one shot.
    const bodyFromSource = async (): Promise<Record<string, unknown> | null> => {
      if (parsed.values["body-file"] !== undefined) {
        const p = parsed.values["body-file"];
        if (!existsSync(p)) {
          throw usageError(`job: --body-file not found: ${p}`);
        }
        return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
      }
      if (parsed.values.stdin) return JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
      return null;
    };

    if (sub === "list") {
      const port = requireDaemon();
      const res = await fetch(base(port));
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "create") {
      const override = await bodyFromSource();
      const body = override ?? {
        title: parsed.values.title,
        status: parsed.values.status,
        deliverable: parsed.values.deliverable,
        detail: parsed.values.detail,
      };
      if (typeof body.title !== "string" || body.title === "") {
        throw usageError(
          "usage: cli.ts job create --title <t> [--status <s>] [--deliverable <ref>] [--detail <x>]\n" +
            "  or: cli.ts job create (--stdin | --body-file <path>) with JSON {title, status?, deliverable?, detail?}\n",
        );
      }
      const port = requireDaemon();
      const res = await fetch(base(port), { method: "POST", body: JSON.stringify(body) });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "update") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError(
          "usage: cli.ts job update <id> [--title <t>] [--status <s>] [--deliverable <ref>] [--detail <x>]\n",
        );
      }
      const override = await bodyFromSource();
      // Forward only the flags that were PROVIDED (thread every field — the R7
      // body-mirror scar); a bare `job update <id>` with no fields is a usage
      // error, not a silent no-op POST.
      const body: Record<string, unknown> =
        override ??
        Object.fromEntries(
          (["title", "status", "deliverable", "detail"] as const)
            .filter((k) => parsed.values[k] !== undefined)
            .map((k) => [k, parsed.values[k]]),
        );
      if (Object.keys(body).length === 0) {
        throw usageError(
          "usage: cli.ts job update <id> (at least one of --title|--status|--deliverable|--detail)\n",
        );
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}`), { method: "POST", body: JSON.stringify(body) });
      process.stdout.write(`${await passOrThrow(res)}\n`);
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
        body: JSON.stringify({ owner: parsed.values.owner }),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "release") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts job release <id>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/release`), { method: "POST" });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "subtask") {
      const id = parsed.positionals[0];
      const modes = [
        parsed.values.add !== undefined,
        parsed.values.check !== undefined,
        parsed.values.uncheck !== undefined,
      ];
      if (!id || modes.filter(Boolean).length !== 1) {
        throw usageError(
          "usage: cli.ts job subtask <id> (--add <label> | --check <subtaskId> | --uncheck <subtaskId>)\n",
        );
      }
      const jobBody =
        parsed.values.add !== undefined
          ? { op: "add", label: parsed.values.add }
          : parsed.values.check !== undefined
            ? { op: "check", subtaskId: parsed.values.check }
            : { op: "uncheck", subtaskId: parsed.values.uncheck };
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}/subtask`), {
        method: "POST",
        body: JSON.stringify(jobBody),
      });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    if (sub === "delete") {
      const id = parsed.positionals[0];
      if (!id) {
        throw usageError("usage: cli.ts job delete <id>");
      }
      const port = requireDaemon();
      const res = await fetch(base(port, `/${id}`), { method: "DELETE" });
      process.stdout.write(`${await passOrThrow(res)}\n`);
      return 0;
    }
    throw usageError(
      "usage: cli.ts job <create|update <id>|claim <id> --owner <who>|release <id>|subtask <id> ...|list|delete <id>>\n",
    );
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
      body: JSON.stringify({ state, messageId: parsed.values.message }),
    });
    process.stdout.write(`${await passOrThrow(res)}\n`);
    return 0;
  }

  if (verb === "send") {
    const parsed = parseVerbArgs("send", rest);
    // Round 3 (Claim C1): grapevine's body-resolution chain, precedence
    // --body-file > --stdin > inline positional > piped-stdin default.
    // Sharp edge (measured, house-wide): the piped-stdin default HANGS
    // FOREVER under agent shells (isTTY null, no EOF) — no read timeout on
    // purpose (it would break slow pipes); always pass a body.
    const hasInline = parsed.positionals.length > 0;
    let text: string;
    let fromInline = false;
    if (parsed.values["body-file"] !== undefined) {
      const path = parsed.values["body-file"];
      if (!existsSync(path)) {
        throw usageError(`send: --body-file not found: ${path}`);
      }
      // Trailing newline stripped (files and heredocs end with one; the
      // message shouldn't) — matching --stdin, and grapevine.
      text = readFileSync(path, "utf8").replace(/\n$/, "");
    } else if (parsed.values.stdin || (!hasInline && !process.stdin.isTTY)) {
      text = (await Bun.stdin.text()).replace(/\n$/, "");
    } else {
      text = parsed.positionals.join(" ");
      fromInline = true;
    }
    // An EMPTY resolved body is a usage error (exit 2), whatever path
    // produced it — a blank message helps nobody and usually means a fumble.
    if (text === "") {
      throw usageError(
        "usage: cli.ts send <text...> | --body-file <path> | --stdin\n" +
          "mind-mapper: send resolved an empty body — nothing sent\n",
      );
    }
    // A fumbled heredoc pipes the literal send invocation in as the body —
    // refuse to post that (narrowed to the send verb; --force overrides for
    // a body that genuinely quotes the command).
    if (!parsed.values.force && /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\bsend\b/.test(text)) {
      throw usageError(
        "mind-mapper: that body looks like a leaked cli invocation (a fumbled heredoc?). " +
          "Nothing was sent. Pipe the real body via --stdin or --body-file <path>, " +
          "or pass --force to send it anyway.\n",
      );
    }
    // Inline bodies with surviving shell metacharacters made it through THIS
    // time — warn (stderr, never blocks) and steer to the shell-free paths.
    if (fromInline && /`|\$\(|\$\{/.test(text)) {
      process.stderr.write(
        "# warning: inline body contains shell metacharacters (backtick, $(), curly-brace vars). " +
          "It was sent as-is, but the shell can command-substitute these first — " +
          "use --body-file or --stdin for code-bearing messages.\n",
      );
    }
    const port = requireDaemon();
    const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
    const res = await fetch(`http://127.0.0.1:${port}/send${qs}`, {
      method: "POST",
      body: JSON.stringify({
        role: parsed.values.role ?? "agent",
        kind: parsed.values.kind ?? "turn",
        text,
        // Flatten repeats, split commas, drop blank fragments — an empty
        // resolved list posts as no ground at all (never [""]).
        ground: (() => {
          const refs = (parsed.values.ground ?? [])
            .flatMap((g) => g.split(","))
            .map((g) => g.trim())
            .filter((g) => g !== "");
          return refs.length > 0 ? refs : undefined;
        })(),
      }),
    });
    const responseText = await passOrThrow(res);
    process.stdout.write(`${responseText}\n`);
    // Round 11 (SEAM 1): mirror the daemon's unknown-channel advisory to stderr,
    // same as propose-edge's draft warning — a typo'd `--kind` is otherwise a
    // message that silently renders as a plain chat turn.
    try {
      const { warning } = JSON.parse(responseText) as { warning?: string };
      if (typeof warning === "string") process.stderr.write(`# warning: ${warning}\n`);
    } catch {
      /* body is what it is */
    }
    return 0;
  }

  // Root fallthrough — NAME the offending token, and distinguish flag-shaped
  // from verb-shaped: "--x at the root" sends the caller to put it after a
  // verb, "unknown verb x" sends them to the roster (choices). A bare
  // invocation named nothing at all — a usage error, not a help path (this CLI
  // is agent-driven; magpie's ruling).
  const VERB_CHOICES = VERBS;
  if (verb === undefined) {
    throw usageError("no verb given", { hint: "run: cli.ts help", choices: VERB_CHOICES });
  }
  if (verb.startsWith("-")) {
    throw usageError(
      `unknown flag at the root: ${verb} (flags belong after a verb; root tokens are --help/-h and --version/-V)`,
      { hint: "run: cli.ts help", choices: VERB_CHOICES },
    );
  }
  throw usageError(`unknown verb: ${verb}`, { hint: "run: cli.ts help", choices: VERB_CHOICES });
}

if (import.meta.main) {
  // `process.exitCode` + a natural return, NEVER `process.exit(code)`: Bun's
  // stdout is ASYNCHRONOUS on a pipe (synchronous on a TTY or file), so an
  // explicit exit discards whatever has not drained — measured at exactly
  // 65,536 bytes. The payload is complete and only the write is lost, so the
  // caller gets well-formed-looking JSON that stops mid-string. Reproduced,
  // fixed and gated in bounty first (P0, #77/#78); same shape, same reason.
  // Do not tidy this back into an explicit exit.
  process.exitCode = await main(process.argv.slice(2));
}
