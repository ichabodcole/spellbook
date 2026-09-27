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
//                 --once sleeps until the first log event, prints it, exits
//                 (the quiet handoff's background one-shot)
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
//   doc <id>      GET /doc/:id → the doc envelope on stdout. Flags may come
//                 before doc's sub-verb (`doc --project P delete D1`); a doc
//                 literally named "delete" or "kind" reads as `doc -- delete`
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
// --project <id> is accepted by every verb above except projects (scopes to a
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
import {
  type CommandSpec,
  defineCli,
  type Invocation,
  type PositionalSpec,
} from "../../kit/cli/registry.ts";
import {
  EXIT_FOR,
  errorEnvelope,
  getCurrentCommand,
  CliError as KitCliError,
  type ErrKind as KitErrKind,
  reportCliError,
} from "../../kit/wire/errors.ts";
import {
  commandLine,
  readSince,
  tailCommand,
  tailWithHandoff,
  WINDOW_HELP,
} from "../../kit/wire/tailHandoff.ts";
import { TAIL_IDLE_MS, TAIL_RETRY_MAX_MS, TAIL_RETRY_MS } from "./heartbeat.ts";

// ⛔ EVERY PATH BELOW IS COMPUTED FROM THE ARTIFACT'S ADDRESS, WHICH IS
// `plugins/spellbook/skills/mind-mapper/dist/cli.js` — NOT FROM THIS SOURCE
// FILE. That is what makes the `import.meta.main` block's absence at the bottom
// of this file a requirement rather than a tidy: run from
// `src/mind-mapper/backend/` these resolve into `src/mind-mapper/`, which has no
// `dist/index.html`, so the CLI would choose DEV and then spawn a daemon from
// the wrong anchor. `dist/` sits at the same depth under the skill root as the
// `scripts/` it replaced, so every ancestor climb below is unchanged — a
// COINCIDENCE OF DEPTH, asserted by `grimoire/spawn-path-ward.test.ts` rather
// than trusted (playbook B4/B5).
const SCRIPT_DIR = import.meta.dir;
// ⛔ UP AND BACK DOWN, NOT A FLAT SIBLING. This was `join(SCRIPT_DIR,
// "server.ts")` until the backend port — glamour's exact shipped defect shape,
// correct only while the CLI and the daemon shared a folder. From `dist/` the
// flat form names `dist/server.ts`, which does not exist; the symptom is not a
// crash but `ensureDaemon`'s poll running out to "daemon did not come up within
// 10s". The launcher is the process a caller runs, and it lives in `scripts/`.
const SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
// dev: the daemon serves a Bun-bundled React surface; Bun reads bunfig.toml
// (the Tailwind plugin) from cwd ONLY, so the daemon's cwd MUST be
// src/mind-mapper/ (seams Contract 5 cwd-pin) — launched elsewhere the dev
// bundler cannot compile the stylesheet (measured on glamour: the page 500s;
// mind-mapper's own failure shape is unmeasured). release: dist/ is pre-built and static — no bunfig
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

// ⛔ `envMs` IS GONE, AND ITS TWO KNOBS MOVED RATHER THAN DISAPPEARED.
// `MIND_MAPPER_TAIL_IDLE_MS` and `MIND_MAPPER_TAIL_RETRY_MS` are resolved in
// `./heartbeat.ts` — the seam file BOTH halves import — because the watchdog is
// DERIVED from the daemon's beat and a knob resolved above the derivation splits
// the pair silently, invisibly at the default (D75).

// ── the failure contract: THE HOUSE'S ONE COPY ─────────────────────────────
//
// ⛔ DE-DUPLICATED, AND MIND-MAPPER IS ONE OF THE TWO SPELLS THIS MODULE'S OWN
// HEADER NAMES AS HAVING REACHED ITS SHAPE INDEPENDENTLY (`errors.ts:33`:
// "glamour and mind-mapper reached this shape independently at their acc L0
// passes"). The delta on the WIRE is NIL, and that is a measurement rather than
// a hope: the `ErrKind` union was character-for-character identical, `EXIT_FOR`
// was the same `2/1/5/6`, and the envelope had the same keys in the same order
// — `{ok:false, error:{kind, exit_code, retryable, message, hint?, choices?,
// server?}, meta:{command}}` — including `server` LAST, which the kit's own
// comment says is deliberate so a spell that already emitted it keeps its byte
// order. ⚠ ONE latent difference, checked and empty: the kit guards `hint` and
// `choices` on TRUTHINESS where this file guarded on PRESENCE, so a
// `hint: ""` would ship from one and not the other. Grepped: this CLI has no
// empty-string hint at any of its 64 raise sites, so the populations agree.
//
// mind-mapper declares `defaultOutput: "json"`, and that declaration is about
// EVERY stream, not just the happy path. `kind` is the contract; `message` is
// presentation — rewording a message must never break a caller, which it does
// the moment anyone matches on prose. Delivery is bounty's, not magpie's: THROW
// and let main() catch and RETURN the code — this CLI ships large stdout
// payloads, and a `process.exit` inside a `die()` would truncate them at 65,536
// bytes (see the drain idiom at the bottom of this file). The kit's `die`
// throws for exactly that reason, so the adoption changes no delivery either.
//
// ⛔ AND THIS IS THE ONE STEP OF THE WHOLE PHASE WHERE THE KIT IS MEASURABLY
// WEAKER, WHICH IS WHY THE TRIAGE CHAIN IN `main` BELOW IS KEPT AND NOT
// REPLACED. `errors.ts` is TWO things — an ENVELOPE and a CLASSIFIER — and only
// the envelope converged. `reportCliError` returns `null` for anything that is
// not a `CliError` and demands the caller rethrow; this CLI triages THREE
// documented usage classes out of raw throws (`ERR_PARSE_ARGS*`, a
// `SyntaxError` from a JSON body, and `ENOENT` on a named file). Adopting the
// classifier naively would regress all three into a stack-trace crash — the
// exact defect this file's own comment records as cassandra's P2 gate finding,
// re-created by the adoption meant to standardise it. So `reportCliError` is
// called INSIDE the chain, at the position the chain reaches for a typed
// failure, and the chain keeps the three branches the kit does not carry.
type ErrKind = KitErrKind;

/**
 * mind-mapper's raise type is now the kit's `CliError`, re-exported under the
 * name 62 call sites already use. ⚠ The FIELD SHAPE differs: this file's class
 * held `hint`/`choices`/`server` as own properties and the kit holds them in an
 * `extra` bag, so the constructor below adapts rather than the call sites
 * changing — a relocation-shaped edit at 62 sites inside a chapter titled
 * "behaviour changes, and each change is named" is how a real change hides.
 */
class CliError extends KitCliError {
  constructor(
    kind: ErrKind,
    message: string,
    extra?: { hint?: string; choices?: string[]; server?: unknown },
  ) {
    super(kind, message, extra);
  }
}

const usageError = (message: string, extra?: { hint?: string; choices?: string[] }) =>
  new CliError("usage", message, extra);

/**
 * Report one of the three RAW throws the kit's classifier does not recognise as
 * a `usage` envelope, and hand back its exit code.
 *
 * ⛔ IT EXISTS BECAUSE THE CLASSIFIER IS THE HALF THAT DID NOT CONVERGE. These
 * three are not `CliError`s — they are a `node:util` parse rejection, a
 * `SyntaxError` out of `JSON.parse`, and an `ENOENT` from a named path — and
 * `reportCliError` answers `null` for all three. Routing them through the
 * ENVELOPE (which did converge) is the whole of the repair: same bytes on
 * stderr, same exit 2, and the triage stays where the spell can see it.
 */
function reportUsage(message: string, extra?: { hint?: string; choices?: string[] }): number {
  process.stderr.write(errorEnvelope("usage", message, extra));
  return EXIT_FOR.usage;
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
  throw new CliError(kind, `${getCurrentCommand() ?? "request"} refused (HTTP ${res.status})`, {
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

// ── the flag registry + the command table, ON THE KIT REGISTRY ──────────────
//
// THE RECOGNIZED SET, AT PARSER ALTITUDE. Every invocation is parsed strict
// against this whole table, so a token mind-mapper has never heard of is
// refused as UNKNOWN; the registry then asks the question the parser cannot:
// is this flag accepted AT THIS VERB. A recognized flag on the wrong verb is
// refused as MISPLACED (`state --ruling` is not a typo), and both rejections
// carry that verb's accepted set as `choices`.
//
// NO DEFAULTS in the table: per-verb defaults live at the consumption site
// (`?? "agent"`, `?? "1"`), where the daemon's contract is written.
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
  once: { type: "boolean" },
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

type Opts = typeof CLI_OPTIONS;
type Flag = keyof Opts & string;
/** The parsed values, typed off the table: a `multiple` flag is an array, a
 *  string flag a string, a boolean flag a boolean. */
type Flags = {
  -readonly [K in Flag]?: Opts[K] extends { multiple: true }
    ? string[]
    : Opts[K]["type"] extends "string"
      ? string
      : boolean;
};
/** What every handler below reads — the shape `parseArgs` used to hand them,
 *  so each body moved onto the registry unchanged. */
type Parsed = { values: Flags; positionals: string[] };
const on =
  (h: (parsed: Parsed) => unknown) =>
  (inv: Invocation<Flag>): unknown =>
    h({ values: inv.flags as Flags, positionals: inv.pos });

/**
 * `activity <state>`'s accepted values — the one ENUMERATED POSITIONAL in this
 * CLI, and the one closed set that was not already published as `choices`.
 */
export const ACTIVITY_STATES = ["received", "thinking", "idle"] as const;

const HELP = `mind-mapper — a co-present knowledge map: a dumb daemon holds the graph, the casting agent does the thinking.

  open   [--project <id>] [--port <n>] [--no-open]   spawn (or find) the daemon, print its url
  state  [--skeleton] [--batch <id>]                 the project snapshot (skeleton = ids/titles/degree)
  changes --since <epochSeconds>                     bounded delta, ADDITIONS ONLY (notCovered names the rest)
  tail   [--since N] [--inbound] [--once]            SSE events as JSONL (wrap with Monitor; see below)
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
         flags may precede the sub-verb (doc --project P delete <id>); doc -- <id> reads a doc named "delete" or "kind"
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
  version                                            {name, version} as JSON (alias: --version, -V)
  schema                                             the machine-readable interface (acc declaration v0)
  help                                               this message (alias: --help, -h)

  --project <id> goes after the verb; every verb that reads a map accepts it (projects, help,
  version and schema do not). Omit it for the default project. Each verb accepts only the flags on its line: a flag on the wrong verb is
  refused, and the rejection lists that verb's own flags.

  Output: every verb prints JSON on stdout by default, one document per answer —
  except tail, a stream that prints one JSON line per event, and help, which is
  prose. Prose, warnings and
  diagnostics go to stderr; failures exit non-zero (2 = usage).

  Keep watching past Monitor's 30-minute cap. Arm the tail with Monitor at
  timeout_ms: 1800000. It ends itself just before the cap, and its last line
  (type: "tail.…") names your next act. That line's command is the verb and its
  arguments only, bookmark (--since) included, with no launcher and no path.
  Always run it with this skill's own launcher, the one you use for its other
  verbs: bun <this skill's directory>/scripts/cli.ts <command>. A command of
  tail --since 12 runs as bun <this skill's directory>/scripts/cli.ts tail --since 12.
  Never reuse a launcher path from an earlier line or session: the plugin's
  directory changes when it updates. Do what next says:

  - monitor: arm Monitor again with the launcher and command.
  - background: nothing happened; the human is away. Run the launcher and
    command as a background Bash task (run_in_background). It exits on the
    next event, which wakes you. Handle the event, then follow its line back to
    Monitor.
  - stop: the session closed or its daemon is gone. Do not re-arm; the launcher
    and command bring it back. If you run it, arm the tail again with no
    --since (and the session id it prints, where there is one): a restarted
    daemon starts a new event log.

  If Monitor expires before that line arrives, re-arm silently with
  --since <the last id you saw>, written <id>@<its epoch> when events carry an
  epoch. Never re-arm without --since: that replays events you have already
  handled. If the launcher refuses a command with a usage error, its message
  names the forms it accepts; fix the arguments to match.
  tail ${WINDOW_HELP}.`;

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

// ── the handlers ─────────────────────────────────────────────────────────
//
// One per command path. The registry has already refused an unknown or
// misplaced flag and enforced the declared arity before any of these runs, so
// a required positional is always present here.

async function cmdOpen(parsed: Parsed): Promise<number> {
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

async function cmdState(parsed: Parsed): Promise<number> {
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
async function cmdChanges(parsed: Parsed): Promise<number> {
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

async function cmdTail(parsed: Parsed): Promise<number> {
  const inbound = parsed.values.inbound === true;
  const once = parsed.values.once === true;
  // A bookmark, `N` or `N@<epoch>` as the handoff line prints it
  // (`kit/wire/tailHandoff.ts`, D2). A form it does not accept is refused with
  // the accepted forms named — read BEFORE the daemon check, so the answer
  // does not depend on whether one is up.
  const read =
    typeof parsed.values.since === "string"
      ? readSince(parsed.values.since, { epoch: true })
      : null;
  if (read !== null && !read.ok) throw usageError(read.message);
  const mark = read?.ok ? read : null;
  const since = mark?.since ?? Number.NaN;
  requireDaemon(); // no daemon at start is a usage error; mid-tail death is self-healed below
  // A `--since` re-arm prints no grounding (`kit/wire/tailHandoff.ts`, A3).
  const sinceGiven = parsed.values.since !== undefined;
  // The server (re-)emits a grounding frame at the top of EVERY inbound SSE
  // connect; forward only the FIRST so the agent's Monitor sees exactly one
  // grounding line, not one per reconnect (F5: first-connect line).
  //
  // ⛔ THE SUPPRESSION'S STATE LIVES IN THIS CLOSURE, OUTSIDE THE THING THAT
  // OWNS THE RECONNECTS, AND THAT IS THE ONE HONEST GAP IN THIS ADOPTION.
  // `render` is a caller-written closure, so `grounded` survives the
  // reconnects `tailEvents` performs — which is exactly why it WORKS, and also
  // why nothing in the kit guarantees it: there is no dedicated
  // first-frame-once affordance and no worked example of one, and a future
  // change to when `tailEvents` re-invokes its hooks would move this
  // behaviour without touching this file. The alternative was asking the kit
  // for a `firstFrameOnce` option, which is a widening for a closure the
  // caller can write in three lines (D82's not-taken).
  let grounded = sinceGiven;

  // ⛔ ONE CALL INTO THE HOUSE'S SHARED TAIL CLIENT
  // (`src/kit/wire/tailEvents.ts`), REPLACING A HAND-ROLLED
  // THREE-LEVEL LOOP — and mind-mapper is the spell that module's own
  // constant-backoff warning was written about: the loop below used to sleep
  // `retryMs` after EVERY failed attempt, flat, forever, which is a
  // reconnect storm rather than a backoff. What the swap closes here, none of
  // it by anyone editing it:
  //
  //   · BACKOFF. 1,000 ms flat becomes 1,000 · 2,000 · 4,000 · 5,000 · 5,000,
  //     reset on a successful open. Driven on glamour before and after
  //     against a server that accepts and immediately drops: 51 attempts in
  //     14 s at a flat ~252 ms became 6 attempts at 252 · 503 · 1001 · 2002 ·
  //     4002.
  //   · THE SPEC. The hand-rolled frame parser matched `startsWith("data: ")`
  //     and kept only the FIRST data line, so a spec-legal `data:{...}` was
  //     silently DROPPED **and the cursor did not advance** — a frame nobody
  //     can read is re-delivered on every reconnect for the daemon's life.
  //     The kit splits at the first colon and strips at most one space, per
  //     WHATWG, which is simultaneously byte-compatible with every house
  //     daemon.
  //   · THE SIGNAL HANDLERS. There were none. Ctrl-C on a tail piped into a
  //     reader now ends the watch by RETURNING, so the runtime drains stdout
  //     first — the half of the P0f drain fix five spells did not apply.
  //   · THE EXIT CODE CROSSES THE LOOPS. The client RETURNS a code instead of
  //     ending the process from inside three nested loops, which is what
  //     retires the per-site question of whether a `return` escapes them all.
  //
  // ⚠ AND `idleMs`/`retry` ARE DERIVED, NOT COPIED (B8's one uncopyable rule).
  // They come from `./heartbeat.ts`, the seam file both halves import, where
  // the watchdog is `tailIdleMs(SSE_HEARTBEAT_MS)` — three of THIS daemon's
  // beats, whatever the beat becomes — and where the two env knobs this
  // spell's own tail suite drives are resolved (D75). The number is 45,000 at
  // the default, which is what this file hard-coded; the EXPRESSION is what
  // changed.
  //
  // ⛔ AND THE QUIET HANDOFF, LIKE THE SESSION SPELLS (Cole's ruling,
  // 2026-09-24; `kit/wire/tailHandoff.ts`, "MIND-MAPPER JOINS THE SESSION
  // SPELLS"). A quiet window names a background `--once`; a woken one-shot
  // names Monitor; a daemon that died names `open --no-open`. The tail's
  // stop-start is what the daemon's presence LINGER (`server.ts`,
  // `adjustAgents`) exists to hide from the human.
  //
  // ⚠ THE LAST URL IS KEPT, so a dead daemon is LOST rather than unresolved.
  // `livePort()` answers null once the daemon's pid is dead, and an
  // unresolved tail retries forever — a `--once` would sleep for good and a
  // Monitor watch would never hear it. Asking the last port instead gets
  // refused, and the kit's lost rule ends the tail with the way back. A live
  // daemon on a NEW port (someone ran `open` again) is still found first.
  let lastUrl: string | null = null;
  return await tailWithHandoff<{ id?: unknown; epoch?: unknown; kind?: unknown }>(
    {
      resolve: () => {
        const port = livePort();
        if (port !== null) lastUrl = `http://127.0.0.1:${port}`;
        return lastUrl;
      },
      path: "/events",
      since: Number.isFinite(since) ? since : 0,
      ...(mark?.epoch ? { sinceEpoch: mark.epoch } : {}),
      query: (cursor) => ({
        since: String(cursor),
        ...(parsed.values.project ? { project: parsed.values.project as string } : {}),
        ...(inbound ? { inbound: "1" } : {}),
      }),
      // ⛔ `id`, NOT `seq` — the daemon's envelope field was renamed by the
      // `createEventLog` adoption (D81), and this is the CLI-side reader of it.
      // ⚠ The CLI half FORCED nothing: `cursorOf` is caller-supplied, so
      // `(ev) => ev.seq` would have compiled and run. It would also have read a
      // field the daemon no longer emits, so the cursor would never advance and
      // every reconnect would re-request `since=0` — the whole replay window
      // into an agent's pipe, silently, forever. **A caller-supplied accessor is
      // where a wire rename goes wrong quietly.**
      cursorOf: (ev) => (typeof ev.id === "number" ? ev.id : undefined),
      epochOf: (ev) => (typeof ev.epoch === "string" ? ev.epoch : undefined),
      // A reconnect that lands on a different epoch means the daemon restarted:
      // the kit resets the cursor to 0 and this line tells the casting agent to
      // refetch state. CLI-synthesized only, never a bus event (the browser WS
      // never sees it), and it carries no `id` — so it never advances the
      // cursor, which is the same separation the grounding line makes.
      onEpochChange: (epoch) => JSON.stringify({ kind: "epoch.changed", epoch }),
      // Grounding is a synthetic, id-less first-connect frame: forward the
      // first, suppress re-groundings on reconnect (exactly one per process).
      // Returning null writes nothing; it never carries id/epoch, so the
      // cursor and the epoch are untouched either way.
      render: (ev, frame) => {
        if (ev.kind === "grounding") {
          if (grounded) return null;
          grounded = true;
        }
        return frame.data;
      },
      // A refused connection (409 needs-project on a projectless store, 404
      // unknown project) is a usage error, not a transport blip — retrying it
      // forever would just spin silently. `passOrThrow` always throws here, and
      // the throw propagates out of the client into `main`'s catch, which is
      // strictly better than a raise reachable from inside a reconnect loop.
      // Annotated: an async arrow's `return "retry"` widens to `Promise<string>`
      // unless the return type is stated, and the client accepts only the
      // literal (type-debt T36).
      onHttpError: async (res): Promise<"retry"> => {
        if (res.status === 409 || res.status === 404) await passOrThrow(res);
        return "retry";
      },
      // ⛔ THE UNPARSEABLE LINE GOES TO STDOUT, WHICH IS THIS SPELL'S OWN
      // BEHAVIOUR AND THE ONE THE KIT'S DEFAULT WOULD HAVE CHANGED. The
      // hand-rolled loop caught the `JSON.parse` and passed the raw line
      // through untracked; the kit's `onMalformed` return value goes to `err`
      // instead, because a diagnostic about the stream is not data. mind-mapper
      // is the "one spell" that module's header names as genuinely wanting it on
      // stdout, and the way to keep that is to write it from inside the hook and
      // return null.
      onMalformed: (frame) => {
        process.stdout.write(`${frame.data}\n`);
        return null;
      },
      idleMs: TAIL_IDLE_MS,
      retry: { initialMs: TAIL_RETRY_MS, maxMs: TAIL_RETRY_MAX_MS },
    },
    {
      spell: "mind-mapper",
      mode: once ? "once" : "watch",
      presence: false,
      // ⛔ `presence.changed` IS ON THE LOG AND IS NOT COUNTED. The daemon
      // emits it, with a log id, when a tail opens or (past the linger) the
      // last one closes — so a tail's OWN connect lands on its own stream.
      // Counted, every window would be "active" and every `--once` would wake
      // on itself at once. It is churn, not an act to answer. (The grounding
      // frame carries no log id, so D3's rule already leaves it out.)
      counts: (ev) => ev.kind !== "presence.changed",
      commands: {
        tail: ({ since: at, once: nextOnce, epoch }) =>
          tailCommand(
            [
              "tail",
              ...(inbound ? ["--inbound"] : []),
              ...(parsed.values.project ? ["--project", parsed.values.project as string] : []),
            ],
            at,
            nextOnce,
            epoch,
          ),
        comeBack: () => commandLine(["open", "--no-open"]),
      },
    },
  );
}

async function cmdProjects(parsed: Parsed): Promise<number> {
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

async function cmdIngest(parsed: Parsed): Promise<number> {
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

async function cmdPropose(verb: "propose-node" | "propose-edge", parsed: Parsed): Promise<number> {
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

async function cmdProposeBatch(parsed: Parsed): Promise<number> {
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

async function cmdRatifyBatch(parsed: Parsed): Promise<number> {
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
async function cmdDeleteBatch(parsed: Parsed): Promise<number> {
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

const projectQs = (parsed: Parsed): string =>
  parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";

// Round 6 (DEL): `node delete <id> [--force]` — 409 {error:"cited",
// citedBy:{edges, children}} when cited and unforced; --force cascades
// (edges gone, children re-parented to top-level, detritus gone).
async function cmdNodeDelete(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
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
async function cmdNodeEdit(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
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
  if (patch.title === undefined && patch.synopsis === undefined) {
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
  const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}${projectQs(parsed)}`, {
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

/**
 * `--to <id> | --clear`, exactly one — `node anchor` and `proposal zone`. A
 * rule the declaration cannot state (it publishes both flags as valid), so it
 * rides the row's `check` and is refused before the handler runs.
 */
const toXorClear = (inv: Invocation<Flag>): string | undefined => {
  const hasTo = inv.flags.to !== undefined;
  const clear = inv.flags.clear === true;
  if (hasTo && clear) return "give --to <id> or --clear, not both";
  if (!hasTo && !clear) return "give --to <id> or --clear";
  return undefined;
};

async function cmdNodeAnchor(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}/anchor${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({ parentId: parsed.values.clear ? null : parsed.values.to }),
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdRead(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/message/${id}${projectQs(parsed)}`);
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdZoneCreate(parsed: Parsed): Promise<number> {
  const name = parsed.positionals.join(" ");
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/zones${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdZoneList(parsed: Parsed): Promise<number> {
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/zones${projectQs(parsed)}`);
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdZoneDelete(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const params = new URLSearchParams();
  if (parsed.values.project) params.set("project", parsed.values.project);
  if (parsed.values.yes) params.set("yes", "1");
  const dqs = params.size > 0 ? `?${params}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/zones/${id}${dqs}`, { method: "DELETE" });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdPromote(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/promote${projectQs(parsed)}`, {
    method: "POST",
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdProposalZone(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/zone${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({ zoneId: parsed.values.clear ? null : parsed.values.to }),
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

// Round 6 (DEL): `proposal delete <id>` — thin, no guard (drop row +
// cascade node_actions). The litter-clearing path (clear a raw
// instruction-node through DELETE, not reject).
async function cmdProposalDelete(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}${projectQs(parsed)}`, {
    method: "DELETE",
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

// `doc <id>` reads and `doc delete <id> [--force]` deletes. The `doc` group
// finds its sub-verb at the FIRST POSITIONAL, so flags may come first
// (`doc --project P delete D1 --force`); a doc literally named "delete" or
// "kind" is read with `doc -- delete`, since the scan stops at a bare `--`.
async function cmdDoc(isDelete: boolean, parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
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

// Round 4 (K1): `doc kind <docId> <kind...> [--author user|agent]` sets,
// `doc kind <docId> --clear` clears (author nulls with it). The ingest
// defaults died — this verb is how a doc gets typed at all.
async function cmdDocKind(parsed: Parsed): Promise<number> {
  const docId = parsed.positionals[0] as string;
  const kindWords = parsed.positionals.slice(1).join(" ");
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/doc/${docId}/kind${projectQs(parsed)}`, {
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

async function cmdMark(parsed: Parsed): Promise<number> {
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

async function cmdSearch(parsed: Parsed): Promise<number> {
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

async function cmdNeighbors(parsed: Parsed): Promise<number> {
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

async function cmdRatify(parsed: Parsed): Promise<number> {
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

// Round 3 (Claim V2): one lens, two modes — --node and --doc are exclusive
// (the daemon enforces the XOR too, but the common slip should fail before a
// round-trip). The row's `check` refuses the slip; this only posts.
async function cmdLensSet(parsed: Parsed): Promise<number> {
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/lens${projectQs(parsed)}`, {
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

async function cmdLensClear(parsed: Parsed): Promise<number> {
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/lens${projectQs(parsed)}`, {
    method: "DELETE",
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdLookHere(parsed: Parsed): Promise<number> {
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

/**
 * `--set <json> | --stdin | --clear`, exactly one — `actions` and `tags`. The
 * declaration publishes all three as valid; the rule rides the row's `check`.
 */
const exactlyOneMode = (inv: Invocation<Flag>): string | undefined => {
  const modes = [inv.flags.set !== undefined, inv.flags.stdin === true, inv.flags.clear === true];
  return modes.filter(Boolean).length === 1
    ? undefined
    : "give exactly one of --set <json>, --stdin or --clear";
};

async function cmdActions(parsed: Parsed): Promise<number> {
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
async function cmdTags(parsed: Parsed): Promise<number> {
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

// Round 9 (Job Queue) — the `job` group: create/update/claim/release/subtask/
// list/delete, copying the `proposal <sub>` lifecycle shape + the tags
// body-builder discipline. EVERY field is threaded into the POST body (the R7
// gate scar: a hand-written body-builder is a MIRROR of the route's field set
// and drifts silently — so update forwards each provided scalar, subtask
// forwards op + label|subtaskId, claim forwards owner).
const jobUrl = (port: number, parsed: Parsed, suffix = ""): string =>
  `http://127.0.0.1:${port}/jobs${suffix}${projectQs(parsed)}`;

// A JSON body from --body-file > --stdin overrides the flag-built body (the
// send precedence chain), so a full job can be piped in one shot.
async function jobBodyFromSource(parsed: Parsed): Promise<Record<string, unknown> | null> {
  if (parsed.values["body-file"] !== undefined) {
    const p = parsed.values["body-file"];
    if (!existsSync(p)) {
      throw usageError(`job: --body-file not found: ${p}`);
    }
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  }
  if (parsed.values.stdin) return JSON.parse(await Bun.stdin.text()) as Record<string, unknown>;
  return null;
}

async function cmdJobList(parsed: Parsed): Promise<number> {
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed));
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdJobCreate(parsed: Parsed): Promise<number> {
  const override = await jobBodyFromSource(parsed);
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
  const res = await fetch(jobUrl(port, parsed), { method: "POST", body: JSON.stringify(body) });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdJobUpdate(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const override = await jobBodyFromSource(parsed);
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
  const res = await fetch(jobUrl(port, parsed, `/${id}`), {
    method: "POST",
    body: JSON.stringify(body),
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdJobClaim(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  if (parsed.values.owner === undefined) {
    throw usageError("usage: cli.ts job claim <id> --owner <who>");
  }
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}/claim`), {
    method: "POST",
    body: JSON.stringify({ owner: parsed.values.owner }),
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdJobRelease(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}/release`), { method: "POST" });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

/** `--add | --check | --uncheck`, exactly one — `job subtask`'s `check`. */
const oneSubtaskOp = (inv: Invocation<Flag>): string | undefined => {
  const modes = [inv.flags.add, inv.flags.check, inv.flags.uncheck].filter((v) => v !== undefined);
  return modes.length === 1
    ? undefined
    : "give exactly one of --add <label>, --check <subtaskId> or --uncheck <subtaskId>";
};

async function cmdJobSubtask(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const jobBody =
    parsed.values.add !== undefined
      ? { op: "add", label: parsed.values.add }
      : parsed.values.check !== undefined
        ? { op: "check", subtaskId: parsed.values.check }
        : { op: "uncheck", subtaskId: parsed.values.uncheck };
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}/subtask`), {
    method: "POST",
    body: JSON.stringify(jobBody),
  });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdJobDelete(parsed: Parsed): Promise<number> {
  const id = parsed.positionals[0] as string;
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}`), { method: "DELETE" });
  process.stdout.write(`${await passOrThrow(res)}\n`);
  return 0;
}

async function cmdActivity(parsed: Parsed): Promise<number> {
  const state = parsed.positionals[0];
  if (!ACTIVITY_STATES.includes(state as (typeof ACTIVITY_STATES)[number])) {
    // ⛔ ONE ARRAY, CHECKED AND PUBLISHED (A1). The members were a three-way
    // `!==` chain for the check and the string `<received|thinking|idle>` for
    // the message — two copies of one closed set, and the machine-readable
    // one did not exist. This is the LAST enumerated value in this file that
    // was still prose-only; every other rejection here already had `choices`.
    throw usageError("usage: cli.ts activity <state> [--message <id>]", {
      hint: "state is the first positional",
      choices: [...ACTIVITY_STATES],
    });
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

async function cmdSend(parsed: Parsed): Promise<number> {
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

// ── THE COMMAND TABLE ────────────────────────────────────────────────────
//
// The dispatcher, the per-path flag check, the rejections' `choices`, arity,
// `--version` and the `schema` declaration all walk THIS, through the house's
// one registry (`src/kit/cli/registry.ts`). A path added here is dispatched and
// published by `schema` at once. The help text is the one hand-written view
// (`HELP` above); `cli-contract.test.ts` binds it to this table.

const one = (name: string): PositionalSpec[] => [{ name, required: true }];
const words = (name: string): PositionalSpec[] => [{ name, required: true, variadic: true }];
const NONE: PositionalSpec[] = [];

const ROWS: CommandSpec<Flag>[] = [
  {
    name: "open",
    flags: ["no-open", "port", "project"],
    positionals: NONE,
    describe: "spawn (or find) the daemon, print its url",
    run: on(cmdOpen),
  },
  {
    name: "state",
    flags: ["skeleton", "batch", "project"],
    positionals: NONE,
    describe: "the project snapshot",
    run: on(cmdState),
  },
  {
    name: "changes",
    flags: ["since", "project"],
    positionals: NONE,
    describe: "bounded delta, additions only",
    run: on(cmdChanges),
  },
  {
    name: "tail",
    flags: ["since", "inbound", "once", "project"],
    positionals: NONE,
    describe: "SSE events as JSONL",
    run: on(cmdTail),
  },
  {
    name: "projects",
    flags: ["create"],
    positionals: NONE,
    describe: "list projects / create one",
    run: on(cmdProjects),
  },
  {
    name: "ingest",
    flags: ["title", "file", "stdin", "project"],
    positionals: NONE,
    describe: "add a doc",
    run: on(cmdIngest),
  },
  {
    name: "propose-node",
    flags: ["stdin", "zone", "project"],
    positionals: NONE,
    describe: "stage a node proposal",
    run: on((p) => cmdPropose("propose-node", p)),
  },
  {
    name: "propose-edge",
    flags: ["stdin", "zone", "project"],
    positionals: NONE,
    describe: "stage an edge proposal",
    run: on((p) => cmdPropose("propose-edge", p)),
  },
  {
    name: "propose-batch",
    flags: ["stdin", "project"],
    positionals: NONE,
    describe: "stage a set in one txn",
    run: on(cmdProposeBatch),
  },
  {
    name: "ratify-batch",
    flags: ["stdin", "project"],
    positionals: NONE,
    describe: "ratify a set in one txn",
    run: on(cmdRatifyBatch),
  },
  {
    name: "delete-batch",
    flags: ["stdin", "project"],
    positionals: NONE,
    describe: "delete a proposal set in one txn",
    run: on(cmdDeleteBatch),
  },
  {
    name: "node anchor",
    flags: ["to", "clear", "project"],
    positionals: one("nodeId"),
    describe: "anchor a node under a parent (--to) or back to top-level (--clear)",
    check: toXorClear,
    run: on(cmdNodeAnchor),
  },
  {
    name: "node edit",
    flags: ["title", "synopsis", "stdin", "project"],
    positionals: one("nodeId"),
    describe: "edit a node's title/synopsis",
    run: on(cmdNodeEdit),
  },
  {
    name: "node delete",
    flags: ["force", "project"],
    positionals: one("nodeId"),
    describe: "delete a node (--force cascades)",
    run: on(cmdNodeDelete),
  },
  {
    // `message` is an advertised ALIAS of `read` (one message-fetch verb, two
    // spellings): dispatchable, in `verbs`, and declared on its own row.
    name: "read",
    aliases: ["message"],
    flags: ["project"],
    positionals: one("messageId"),
    describe: "one full message row",
    run: on(cmdRead),
  },
  {
    name: "zone create",
    flags: ["project"],
    positionals: words("name"),
    describe: "create a staging zone",
    run: on(cmdZoneCreate),
  },
  {
    name: "zone list",
    flags: ["project"],
    positionals: NONE,
    describe: "list zones",
    run: on(cmdZoneList),
  },
  {
    name: "zone delete",
    flags: ["yes", "project"],
    positionals: one("zoneId"),
    describe: "delete a zone (--yes when populated)",
    run: on(cmdZoneDelete),
  },
  {
    name: "promote",
    flags: ["project"],
    positionals: one("proposalId"),
    describe: "move a zoned proposal to the main queue",
    run: on(cmdPromote),
  },
  {
    name: "proposal zone",
    flags: ["to", "clear", "project"],
    positionals: one("proposalId"),
    describe: "move a pending proposal into a zone (--to) or back to main (--clear)",
    check: toXorClear,
    run: on(cmdProposalZone),
  },
  {
    name: "proposal delete",
    flags: ["project"],
    positionals: one("proposalId"),
    describe: "delete a proposal",
    run: on(cmdProposalDelete),
  },
  {
    name: "doc",
    flags: ["project"],
    positionals: one("docId"),
    describe: "the doc envelope",
    run: on((p) => cmdDoc(false, p)),
  },
  {
    name: "doc delete",
    flags: ["force", "project"],
    positionals: one("docId"),
    describe: "delete a doc (--force cascades)",
    run: on((p) => cmdDoc(true, p)),
  },
  {
    name: "doc kind",
    flags: ["author", "clear", "project"],
    // ⚠ FLAG-DEPENDENT ARITY: `doc kind <docId> <kind...>` sets, `doc kind
    // <docId> --clear` clears and takes no kind. The declaration cannot say
    // "required unless --clear", so it can only mark <kind> optional; `check`
    // enforces the rest.
    positionals: [
      { name: "docId", required: true },
      { name: "kind", required: false, variadic: true },
    ],
    describe: "assert (<kind>) or clear (--clear) a doc's kind",
    check: (inv) => {
      const clear = inv.flags.clear === true;
      if (clear && inv.pos.length > 1) return "--clear takes no <kind>";
      if (!clear && inv.pos.length < 2) return "missing required <kind> (or pass --clear)";
      return undefined;
    },
    run: on(cmdDocKind),
  },
  {
    name: "mark",
    flags: ["status", "note", "author", "project"],
    positionals: one("docId"),
    describe: "append a doc status mark",
    run: on(cmdMark),
  },
  {
    name: "search",
    flags: ["project"],
    positionals: words("query"),
    describe: "FTS over nodes, docs, messages",
    run: on(cmdSearch),
  },
  {
    name: "neighbors",
    flags: ["depth", "project"],
    positionals: one("nodeId"),
    describe: "local hood + edge reasons",
    run: on(cmdNeighbors),
  },
  {
    name: "ratify",
    flags: ["ruling", "doc-edit", "doc", "span", "anchor", "project"],
    positionals: one("proposalId"),
    describe: "rule on a proposal",
    run: on(cmdRatify),
  },
  {
    name: "lens set",
    flags: ["node", "doc", "depth", "owner", "project"],
    positionals: NONE,
    describe: "set the lens on a node (--node) or a doc (--doc)",
    check: (inv) => {
      if (inv.flags.node !== undefined && inv.flags.doc !== undefined) {
        return "lens set takes --node OR --doc, not both";
      }
      if (inv.flags.doc !== undefined && inv.flags.depth !== undefined) {
        return "--depth applies to a node lens only";
      }
      return undefined;
    },
    run: on(cmdLensSet),
  },
  {
    name: "lens clear",
    flags: ["project"],
    positionals: NONE,
    describe: "clear the lens",
    run: on(cmdLensClear),
  },
  {
    name: "look-here",
    flags: ["project"],
    positionals: one("nodeId"),
    describe: "fire-once attention nudge",
    run: on(cmdLookHere),
  },
  {
    name: "actions",
    flags: ["set", "stdin", "clear", "project"],
    positionals: one("targetId"),
    describe: "action slots on a node/pending proposal",
    check: exactlyOneMode,
    run: on(cmdActions),
  },
  {
    name: "tags",
    flags: ["set", "stdin", "clear", "project"],
    positionals: one("targetId"),
    describe: "freeform tags on a node/pending proposal",
    check: exactlyOneMode,
    run: on(cmdTags),
  },
  {
    name: "job create",
    flags: ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
    positionals: NONE,
    describe: "create a job",
    run: on(cmdJobCreate),
  },
  {
    name: "job update",
    flags: ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
    positionals: one("jobId"),
    describe: "update a job",
    run: on(cmdJobUpdate),
  },
  {
    name: "job claim",
    flags: ["owner", "project"],
    positionals: one("jobId"),
    describe: "claim a job (atomic lease)",
    run: on(cmdJobClaim),
  },
  {
    name: "job release",
    flags: ["project"],
    positionals: one("jobId"),
    describe: "release a job",
    run: on(cmdJobRelease),
  },
  {
    name: "job subtask",
    flags: ["add", "check", "uncheck", "project"],
    positionals: one("jobId"),
    describe: "add, check or uncheck a job's sub-task",
    check: oneSubtaskOp,
    run: on(cmdJobSubtask),
  },
  {
    name: "job list",
    flags: ["project"],
    positionals: NONE,
    describe: "list jobs",
    run: on(cmdJobList),
  },
  {
    name: "job delete",
    flags: ["project"],
    positionals: one("jobId"),
    describe: "delete a job",
    run: on(cmdJobDelete),
  },
  {
    name: "activity",
    flags: ["message", "project"],
    positionals: one("state"),
    describe: "the casting-loop liveness signal (received|thinking|idle)",
    run: on(cmdActivity),
  },
  {
    name: "send",
    flags: ["role", "kind", "ground", "body-file", "stdin", "force", "project"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "post a message",
    run: on(cmdSend),
  },
];

// ⛔ BUILDING THE TABLE HAS NO SIDE EFFECTS. `defineCli` only validates and
// indexes; nothing is parsed, printed or read until `main` runs. So a grimoire
// ward, or a test, can import this module and read `cli.recognizedFlags`,
// `cli.flagsFor` and `cli.declaration()` without running the CLI.
export const cli = defineCli({
  name: "mind-mapper",
  options: CLI_OPTIONS,
  commands: ROWS,
  // The verb is the first argument: `mind-mapper --project p state` is refused
  // as an unknown root flag. A bare `--` makes the next token the verb (acc A6).
  grammar: "verb-first",
  // `doc` takes flags BEFORE its sub-verb (`doc --project P delete D1`), so
  // its sub-verb is the first positional, not the adjacent token. The other
  // groups (node, zone, proposal, lens, job) keep the default: adjacent.
  groups: { doc: { subVerbAt: "first-positional" } },
  version: versionInfo,
  help: () => HELP,
});

// The derived views the tests read. VERBS is the roster (the module's own
// `version`, `schema` and `help` rows included); VERB_SPEC is each path's
// accepted flags, keyed by path (`"node edit"`).
export const VERBS: readonly string[] = cli.verbs;
export const VERB_SPEC: Record<string, readonly string[]> = Object.fromEntries(
  cli.rows.map((r) => [r.name, r.accepted]),
);
export const RECOGNIZED_FLAGS: readonly string[] = cli.recognizedFlags;

/**
 * THE ONE PLACE A FAILURE BECOMES AN EXIT CODE. Every raise in this file THROWS
 * (the kit's `die`/`CliError`), arrives here, is written as ONE JSON envelope
 * on stderr, and becomes a taxonomy exit code — nothing exits from inside a
 * verb, so a large stdout payload is never truncated.
 *
 * `cli.dispatch`, not the registry's `main`, because mind-mapper triages two
 * raw throws the registry cannot know about.
 *
 * ⛔ THE KIT'S REPORTER SITS INSIDE THIS CHAIN, NOT IN PLACE OF IT. It writes
 * the envelope for a typed failure and returns `null` for everything else, so
 * the two usage classes below are classified HERE: a body that failed to parse
 * as JSON (stdin/--body-file), and a named file that is not there
 * (--file/--doc-edit). A bare `reportCliError(e) ?? rethrow` would turn both
 * into stack-trace crashes (cassandra's P2 gate finding). Node's own parse
 * rejections no longer reach here: the registry catches them and answers with
 * the verb's accepted set as `choices`.
 */
async function main(argv: string[]): Promise<number> {
  try {
    return await cli.dispatch(argv);
  } catch (e) {
    const reported = reportCliError(e);
    if (reported !== null) return reported;
    const code =
      e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    // A body that failed to parse (stdin/--body-file JSON) — the caller's.
    if (e instanceof SyntaxError) return reportUsage(`invalid JSON: ${msg}`);
    // A named file that is not there (--file/--doc-edit paths) — the caller's.
    if (code === "ENOENT") return reportUsage(msg);
    // Everything else is mind-mapper's own fault: one INTERNAL envelope, never
    // a stack trace — the process contract is JSON on stderr for EVERY failure.
    process.stderr.write(errorEnvelope("internal", msg));
    return EXIT_FOR.internal;
  }
}

/**
 * The CLI's one entry, called by the launcher at
 * `plugins/spellbook/skills/mind-mapper/scripts/cli.ts`.
 *
 * ⛔ THERE IS NO `import.meta.main` BLOCK, AND THAT IS THE POINT.
 * `dist/cli.js` is IMPORTED by the launcher, never executed as the process
 * entry, so `import.meta.main` is FALSE in the bundle: a block here would never
 * run and the CLI would print nothing and exit 0 for every verb. This export is
 * what replaces it. And the source keeps no second entry deliberately — the
 * arithmetic above is true at the artifact's address and false at this file's,
 * so offering `bun src/mind-mapper/backend/cli.ts` would be offering a wrong
 * process (playbook B3).
 *
 * ⛔ IT RETURNS THE CODE RATHER THAN SETTING IT. `process.exitCode` + a natural
 * return, NEVER `process.exit(code)`: Bun's stdout is ASYNCHRONOUS on a pipe
 * (synchronous on a TTY or file), so an explicit exit discards whatever has not
 * drained — measured at exactly 65,536 bytes. The payload is complete and only
 * the write is lost, so the caller gets well-formed-looking JSON that stops
 * mid-string. Reproduced, fixed and gated in bounty first (P0, #77/#78); same
 * shape, same reason. The assignment happens once, in the launcher. Do not tidy
 * this back into an explicit exit.
 *
 * ⛔ AND IT TAKES NO ARGUMENTS: the command line belongs to the file that PARSES
 * it, which is this one. A launcher reading the argument vector would match the
 * arg-parsing predicate in `grimoire/lib/entry-points.ts`.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}
