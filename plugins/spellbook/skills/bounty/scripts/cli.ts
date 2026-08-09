#!/usr/bin/env bun

// bounty CLI — thin, stateless wrapper around the per-session daemon's HTTP
// surface (server.ts). The agent drives the board through these verbs; `tail`
// streams board events as JSONL for Monitor to wrap.
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--timeout S] [--no-open] [--restore <id>] [--pin] [--session-key <key> [--fresh]]  # spawn a daemon (--pin binds it to cwd; --session-key binds it to a caller-owned key, idempotently — #69)
//   bun cli.ts tail [--since N] [--owner <name> | --mine] [--as <name>]  # scoped SSE → JSONL
//   bun cli.ts state [--owner <name> | --mine] [--as <name>]    # scoped read-back (full; --full accepted, it is the default)
//     Each task carries derived `blocked` + `liveBlockers:[{id,title,status}]`
//     (the not-done blockers), so a filtered blocked task stays actionable.
//
// Driving the board (POST /cmd):
//   bun cli.ts add <title...> [--status ..] [--notes ..] [--owner ..] [--tag a,b] [--size S|M|L] [--expect <min>] [--id ..] [--stdin]
//   bun cli.ts update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--tag a,b] [--size S|M|L] [--expect <min>] [--stdin]
//   bun cli.ts claim <id> [--as <name>]                     # self-claim an unowned task
//   bun cli.ts block <id> --on <id>[,<id>...]               # add blocker edges (cycle-guarded)
//   bun cli.ts unblock <id> --on <id>[,<id>...]             # remove blocker edges
//   bun cli.ts remove <id>
//   bun cli.ts message <text...> [--stdin]                  # toast
//   bun cli.ts init [--title ..] [--stdin-tasks]            # seed the board (each task needs id+title+status)
//   bun cli.ts list                                        # running boards (live)
//   bun cli.ts close | info | sessions | help              # sessions = saved snapshots
//
// Identity: --as <name> (or $BOUNTY_AS) stamps the event `by`, drives self-echo
// suppression + claim/--mine. Ownership: --owner assigns; tail --owner/--mine
// scopes a worker's wake-set to its own + claimable tasks (client-side filter).
// --stdin reads the title from stdin (bypasses shell quoting — apostrophes,
// quotes, ampersands, angle brackets all land verbatim). Session targeting
// (#59, #69) resolves in precedence order: --session-key <key> > --session <id>
// > $BOUNTY_SESSION_KEY > $BOUNTY_SESSION > the nearest `.bounty-session` file
// walking up from cwd > the most-recent board (the `latest` pointer). A
// `--session-key` is a caller-owned handle that DERIVES a stable, project-scoped
// board id (#69) — so `open --session-key K` is idempotent and every verb
// re-derives the same board, with no random id to carry. `open --pin` writes
// cwd/.bounty-session so a team can bind a board to its project directory.
//
// Discipline: structured payload on stdout (one JSON line); liveness, echoes,
// and diagnostics on stderr — never merge them. Exit 2 on bad args, 0 on a
// successful verb; `tail` exits 0 on the daemon's `closed` event.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as nodeParseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");
const SNAPSHOTS_DIR = join(process.env.BOUNTY_HOME ?? join(homedir(), ".bounty"), "snapshots");

type TaskStatus = "todo" | "doing" | "review" | "done";
const VALID_STATUS: TaskStatus[] = ["todo", "doing", "review", "done"];

type Session = {
  url: string;
  port: number;
  session_id: string;
  title: string;
};

function die(msg: string): never {
  process.stderr.write(`bounty: ${msg}\n`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session ? join(tmpdir(), `bounty-${session}.json`) : join(tmpdir(), "bounty-latest.json");
}

// ── Caller-owned session keys (#69) ──────────────────────────────────────
// A coordinating caller (anthill, or any multi-board consumer) binds every
// command to ITS board via a key IT chooses — deterministic by construction,
// never the global `latest` pointer, and never a random daemon-minted id it has
// to carry (which goes stale). The key isn't stored as an opaque handle; it
// DERIVES a stable session id, so the whole existing bounty-<id>.json +
// resolveSession + latest machinery works unchanged. The derived id is
// PROJECT-SCOPED (hashed with the repo root), so the same key in two repos is
// two boards — the collision guard for "same key, different project". Same key +
// same repo derives the SAME id → an idempotent `open` attaches (intended
// share), never hijacks; a verb in a subdir binds the same board `open` made at
// the root.

// Filesystem-safe slug of a caller key: lowercased, non-alnum runs → single
// dash, trimmed, capped — keeps the derived id legible (`k-anthill-team-<hash>`).
export function slugifyKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

// The scope a key binds to: the nearest ancestor holding a `.git` marker (the
// repo root), else the starting dir. Walking to the repo root — not raw cwd —
// is what makes `open` at the root and a verb in a subdir derive the SAME id.
// `exists` is injected so the walk is pure/testable.
export function findScopeRoot(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string {
  let dir = startDir;
  while (true) {
    if (exists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir; // no repo root → the cwd itself is the scope
    dir = parent;
  }
}

// Derive the stable, project-scoped board id for a caller key. Deterministic:
// same (key, scopeRoot) → same id, always.
export function deriveSessionId(key: string, scopeRoot: string): string {
  const slug = slugifyKey(key);
  const scopeHash = createHash("sha256").update(scopeRoot).digest("hex").slice(0, 8);
  return slug ? `k-${slug}-${scopeHash}` : `k-${scopeHash}`;
}

// Resolve a caller key to its board id: find the scope root from startDir, then
// derive. The single entry point shared by resolveSession (verbs) and cmdOpen
// (spawn), so both agree on the id for a given key + cwd.
export function sessionKeyToId(
  key: string,
  startDir: string = process.cwd(),
  exists: (path: string) => boolean = existsSync,
): string {
  return deriveSessionId(key, findScopeRoot(startDir, exists));
}

// Resolve which board a verb targets, in precedence order (#59, extended by
// #69) — an un-pinned verb must NOT silently fall onto a stranger board that
// merely opened more recently:
//   1. `--session-key <key>` (flags) — a caller-owned key, DERIVED to its
//      scoped board id (#69); the most explicit "this exact board" a
//      coordinator can state, bound by construction;
//   2. explicit --session <id> (flags) — a raw board id;
//   3. $BOUNTY_SESSION_KEY env var — a key, derived like (1) (#69);
//   4. $BOUNTY_SESSION env var — a raw board id;
//   5. the nearest `.bounty-session` file found by walking UP from cwd (its
//      trimmed contents = the board id) — a project-root-style marker binding
//      a board to a directory tree (written by `open --pin`);
//   6. otherwise undefined → the caller falls back to the `latest` pointer
//      (prior behavior).
// env/startDir/readFile/exists are injected (like pickTailSession's `read`) so
// the precedence is unit-testable without a real cwd/filesystem.
function resolveSession(
  flags: Record<string, string | boolean>,
  env: Record<string, string | undefined> = process.env,
  startDir: string = process.cwd(),
  readFile: (path: string) => string | null = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (typeof flags["session-key"] === "string")
    return sessionKeyToId(flags["session-key"], startDir, exists);
  if (typeof flags.session === "string") return flags.session;
  if (env.BOUNTY_SESSION_KEY) return sessionKeyToId(env.BOUNTY_SESSION_KEY, startDir, exists);
  if (env.BOUNTY_SESSION) return env.BOUNTY_SESSION;
  let dir = startDir;
  while (true) {
    const contents = readFile(join(dir, ".bounty-session"));
    const id = contents?.trim();
    if (id) return id;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return undefined;
}

function readSession(session?: string): Session | null {
  try {
    return JSON.parse(readFileSync(sessionFilePath(session), "utf8")) as Session;
  } catch {
    return null;
  }
}

function requireSession(session?: string): Session {
  const s = readSession(session);
  if (!s) die("no running bounty session — run: cli.ts open");
  return s;
}

// Resolve the session a `tail` should read on this iteration, and the id it is
// now PINNED to (#tail-pin). The first time an unpinned tail resolves a concrete
// session (off the global `latest` pointer), it locks onto that session_id;
// every later reconnect reads THAT session's own file, never `latest` again — so
// a newer board opening on the host can't silently hijack a long-lived tail. An
// explicit --session is pinned from the start. `read` is injected so the loop's
// resolution is unit-testable without touching the race-prone global pointer.
// Returns null when nothing resolves yet (no board up) — the caller retries.
function pickTailSession(
  pinned: string | undefined,
  read: (session?: string) => Session | null,
): { session: Session; pinned: string } | null {
  const s = read(pinned);
  if (!s) return null;
  return { session: s, pinned: pinned ?? s.session_id };
}

// Owner identity is case-insensitive (#owner-case): the lead may assign
// `--owner loom` while the worker filters as `--as Loom` (grapevine aliases are
// often capitalized). A case-sensitive compare silently emptied `--mine`.
function sameOwner(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

// Does a task/event with `owner` fall in the caller's scope? Shared by `state`
// and `tail` so they filter identically. `--owner X` = exactly X's (case-
// insensitive); `--mine` = own (case-insensitive) + claimable (unowned); no
// scope = everything.
function ownerInScope(
  owner: string | undefined,
  scope: { owner?: string; mine?: boolean; as?: string },
): boolean {
  if (scope.owner) return sameOwner(owner, scope.owner);
  if (scope.mine) return sameOwner(owner, scope.as) || !owner;
  return true;
}

// Parse a comma-separated `--tag` value into a clean string[] (trim each, drop
// empties, dedupe). SET semantics: the list REPLACES the task's tags, mirroring
// the `block --on a,b` convention; `--tag ""` yields [] (a clear). The daemon
// re-sanitizes via cleanTags, so this is the convenience layer, not the guard.
function parseTags(value: string): string[] {
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// Heartbeat sizing flags (#29). --size S|M|L (case-insensitive); anything else
// is ignored so a typo can't set a bogus size. --expect <minutes> overrides the
// size default; must be a positive number. The daemon re-validates both.
function parseSize(value: string | boolean | undefined): "S" | "M" | "L" | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim().toUpperCase();
  return s === "S" || s === "M" || s === "L" ? s : undefined;
}
function parseExpect(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = Number(value.trim());
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

// P1d — the LENIENCY STAYS and the envelope says what it cost.
//
// `parseSize`/`parseExpect` dropping a bad value is a deliberate anti-typo
// ruling (see the comment above them), and reversing it re-opens that hazard.
// Ruled by Cole: keep the leniency, make it AUDIBLE. So the drop is unchanged
// and the caller is now TOLD.
//
// ⚠ This is the `restoreSkipped` SHAPE and deliberately not its name, because it
// is the opposite EVENT. `restoreSkipped` means "your flag was valid and the
// situation could not honour it" — the user did nothing wrong. This means "your
// value was invalid and we chose to ignore it" — the user made a typo, and what
// they need is the legal set, not an explanation about their board.
//
// NAME `valuesIgnored` RULED BY thoth. Three parts, each overturnable:
//   `Ignored` not `Skipped` — skipped implies an OBSTACLE (the flag was fine,
//     the situation was not, which is `restoreSkipped`); ignored implies a
//     CHOICE. cli.ts:259 already uses that word for this behaviour.
//   `values` not `size`/`flags` — `--size` was RECOGNISED; it parsed, it is a
//     real flag. What was unusable was its VALUE. `ignoredFlags` would send a
//     reader hunting for whether the flag is supported at all.
//   Grouped by CAUSE, present-and-null — the house shape, whose first member is
//     `restoreSkipped`. A new grouped field earns its place when the cause
//     changes what the CALLER DOES: restoreSkipped → fix your situation;
//     valuesIgnored → fix your typo. Same remedy → same field.
//
// ⛔ THE SHAPE DELIBERATELY DIVERGES FROM `restoreSkipped`, AND THIS IS THE ONE
// DECISION THAT IS MINE RATHER THAN thoth's. `restoreSkipped` is
// `{requested: string[], reason: string}` — one reason for all its flags, which
// is honest there because they share one cause by construction (the board was
// live, full stop). Ours do NOT: `add --size bogus --expect abc` is one command
// with TWO different reasons, and a single `reason` string is wrong about
// whichever flag it does not describe.
//
// So each entry carries its own reason. And the key is NOT reused: calling it
// `requested` while holding objects, when `restoreSkipped.requested` holds
// strings, would give one house key-name two element types — a consumer that
// learned the first breaks silently on the second. Diverging VISIBLY is safer
// than diverging under a shared name.
type IgnoredValue = { flag: string; value: string; reason: string };

function ignoredValues(flags: Record<string, string | boolean>): IgnoredValue[] {
  const out: IgnoredValue[] = [];
  // Bare flag names, matching `restoreSkipped.requested`'s convention.
  if (typeof flags.size === "string" && parseSize(flags.size) === undefined)
    out.push({ flag: "size", value: flags.size, reason: "not one of S|M|L" });
  if (typeof flags.expect === "string" && parseExpect(flags.expect) === undefined)
    out.push({ flag: "expect", value: flags.expect, reason: "not a positive number" });
  return out;
}

// Mirror to stderr, the house pattern for an advisory (edgeDraftWarning, the
// tags soft-cap, the unknown-channel advisory): the JSON envelope carries it for
// a parser, stderr carries it for a human, and neither is the only copy.
function warnIgnored(ignored: IgnoredValue[]): void {
  for (const i of ignored)
    process.stderr.write(`bounty: ignored --${i.flag} ${JSON.stringify(i.value)} — ${i.reason}\n`);
}

async function api(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

// Split argv into positionals + flags. `--flag value` or boolean `--flag`.
// #81 / D4 — THE RECOGNIZED SET, AT PARSER ALTITUDE.
//
// The hand-rolled parser this replaces had three defects and every one of them
// was silent:
//
//   --owner=alice        the whole `owner=alice` became a boolean key, so the
//                        value was DROPPED and a read filter matched nothing —
//                        a read returned the WHOLE BOARD instead of a subset
//   --totally-bogus      accepted, exit 0, verb ran anyway
//   add write the --draft section
//                        `--draft` was read as a flag, so the title silently
//                        TRUNCATED to "write the" at exit 0
//
// `node:util` strict gives all three fixes from the standard library — `=`
// support, unknown-flag rejection, and the `--` terminator — in the shape
// join.ts and server.ts in this very spell already use. That makes "three
// spellings of one idea" impossible by construction rather than by discipline.
//
// ⚠ THE TYPES ARE LOAD-BEARING AND GETTING ONE WRONG IS NOT A NO-OP:
//   a "string" that should be boolean SWALLOWS THE NEXT POSITIONAL as its value
//   a "boolean" that should be string breaks `--owner alice` (alice becomes a
//   positional)
// Both are silent enough to ship. This set is thoth's audited artifact
// (`docs/projects/spell-hardening/artifacts/p0c-recognized-flag-sets.md`):
// 22 flags, 15 string / 7 boolean, each settled by unambiguous evidence at
// EVERY consumption site. `expect` and `size` are string because they type off
// parseExpect/parseSize, not off the bare truthiness at the call site.
const CLI_OPTIONS = {
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
  "stdin-tasks": { type: "boolean" },
} as const;

// A usage failure is THROWN rather than exiting, so `main` can return 2 and let
// the runtime drain stdout — `die()` is process.exit, which is the defect this
// sprint's sibling lanes exist to remove. Same reason the #80.1 refusal does
// not route through die() either.
class UsageError extends Error {}

function parseArgs(args: string[]): {
  pos: string[];
  flags: Record<string, string | boolean>;
} {
  try {
    const { values, positionals } = nodeParseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true,
    });
    return {
      pos: positionals,
      flags: values as Record<string, string | boolean>,
    };
  } catch (e) {
    // node:util names the offending token; keep that and add the escape hatch,
    // because the most likely victim is free prose containing a dash-dash word
    // (`add write the --draft section`), which TODAY truncates silently.
    const detail = e instanceof Error ? e.message : String(e);
    throw new UsageError(
      `${detail}\n` +
        `  recognized flags: ${Object.keys(CLI_OPTIONS)
          .map((k) => `--${k}`)
          .join(" ")}\n` +
        `  for free text containing dashes, use --stdin, or put it after a bare --`,
    );
  }
}

type CmdResult = { ok?: boolean; applied?: boolean; error?: string };

// The caller's identity, stamped onto the event `by` so a scoped tail can
// filter + suppress self-echo. --as wins, else $BOUNTY_AS, else undefined.
function resolveAs(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags.as === "string") return flags.as;
  return process.env.BOUNTY_AS || undefined;
}

// POST a command; merge the caller's `as` identity in; return the apply-result.
// Pass `quiet` for verbs that print their own outcome (e.g. claim).
async function postCmd(
  session: string | undefined,
  msg: Record<string, unknown>,
  opts: { as?: string; quiet?: boolean } = {},
): Promise<CmdResult> {
  const s = requireSession(session);
  const body = opts.as ? { ...msg, as: opts.as } : msg;
  const { status, data } = await api(s.port, "POST", "/cmd", body);
  if (status !== 200) die(`cmd failed (HTTP ${status}) — is the session still alive?`);
  if (!opts.quiet) printJson({ ok: true, sent: msg.type });
  return (data ?? {}) as CmdResult;
}

// #83 — honour the daemon's verdict for every verb that has no bespoke result
// handling. A FUNNEL, deliberately, rather than the same three lines pasted at
// four call sites: a prose convention ("remember to check `applied`") is not
// inheritable and is exactly how `add` came to be the odd one out among five
// write verbs. A future verb inherits the contract by routing through here.
//
// The `applied === false` test is explicit, not truthiness: a daemon that omits
// the field entirely (an older build, or a command type it answers without a
// verdict) must keep its ack rather than being reported as a failure — absent is
// not the same as false, and conflating them would turn a version skew into a
// storm of fake errors.
// The failure ENVELOPE carries `applied: false` on stdout, beside the non-zero
// exit and the human line on stderr — the same two-channel shape P0b's refusal
// uses. The exit code is what a `set -e` wrapper or a Monitor catches; the
// envelope is what an agent parses. Reporting only on stderr would leave a
// stdout reader with an empty payload, which is indistinguishable from a verb
// that produced no output for a benign reason.
function ackOrFail(type: unknown, res: CmdResult): number {
  if (res.applied === false) {
    const error = res.error ?? `the daemon did not apply ${String(type)} — the board is unchanged`;
    printJson({ ok: false, applied: false, sent: type, error });
    process.stderr.write(`bounty: ${error}\n`);
    return 1;
  }
  // b8 — forward the daemon's drop report when there is one. `init` filters
  // untrusted tasks and used to say nothing, so 18 tasks in / 0 seeded answered
  // {ok:true}. The field rides the ACK because that is the response the caller
  // reads; it is omitted rather than null-stuffed on verbs that never drop, and
  // the daemon sends null on an init that dropped nothing (present-and-null
  // where it is meaningful, absent where it is not applicable).
  const dropped = (res as { tasksDropped?: unknown }).tasksDropped;
  if (dropped !== undefined) {
    printJson({ ok: true, sent: type, tasksDropped: dropped });
    if (dropped && typeof dropped === "object") {
      const d = dropped as { requested: number; dropped: { index: number; reason: string }[] };
      process.stderr.write(
        `bounty: ${d.dropped.length} of ${d.requested} task(s) were DROPPED and not seeded:\n`,
      );
      for (const item of d.dropped) process.stderr.write(`  [${item.index}] ${item.reason}\n`);
    }
    return 0;
  }
  printJson({ ok: true, sent: type });
  return 0;
}

function newTaskId(): string {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}

// ── verbs ───────────────────────────────────────────────────────────

// Read a board's discovery file and confirm its daemon actually answers — the
// attach-vs-spawn decision for keyed open (#69). Returns the live Session, or
// null if absent or stale.
async function boardIfLive(session: string): Promise<Session | null> {
  const s = readSession(session);
  if (!s) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/state`);
    return r.ok ? s : null;
  } catch {
    return null;
  }
}

// --pin: bind a board to the cwd so un-pinned verbs run here resolve to it (via
// the `.bounty-session` walk-up in resolveSession) instead of the machine-wide
// `latest` pointer (#59). For a keyed open this persists the DERIVED id, so the
// pinned marker and a fresh `--session-key` derive to the same board.
function writePin(sessionId: string) {
  const pinPath = join(process.cwd(), ".bounty-session");
  try {
    writeFileSync(pinPath, `${sessionId}\n`);
    process.stderr.write(`# pinned board ${sessionId} → ${pinPath}\n`);
  } catch (e) {
    process.stderr.write(
      `bounty: could not write ${pinPath}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

// #80.1 — flags whose EFFECT IS LOST on the idempotent-attach path.
//
// The attach branch below RETURNS before the daemon argument list is built, so
// every flag that only ever takes effect as a daemon arg is silently discarded:
// the caller asks for a four-hour timeout, gets thirty seconds, and is told
// nothing. `--restore` was only ever one of three symptoms of that one return.
//
// ⚠ DERIVE THIS SET BY LOST EFFECT, NEVER BY POSITION. "Appended past the
// return" and "not honoured on attach" look like two spellings of one set and
// they are not — the positional reading is wrong in BOTH directions at once:
//
//   --title    lost      MISSED by a positional cutoff (appended before --restore)
//   --timeout  lost      MISSED by a positional cutoff (likewise)
//   --restore  lost      caught either way
//   --no-open  honoured  WRONGLY INCLUDED by a positional cutoff — on the attach
//                        path there is nothing to open, so it is VACUOUSLY
//                        honoured; the caller asked for a thing already true
//   --pin      honoured  never reached by a positional cutoff at all — it runs
//                        INSIDE the attach branch, above the return
//
// Refusing on --no-open or --pin would make every caller that rejoins a live
// board start failing (`open --session-key K --pin --no-open` is a real, live
// invocation) — this lane's own cure inflicting this lane's own disease.
//
// The membership test is `Boolean(flags[f])`, deliberately the SAME truthiness
// the daemon-arg construction uses, so "we refuse it" and "it would have had an
// effect" cannot drift apart.
const ATTACH_LOST_FLAGS = ["title", "timeout", "restore"] as const;

async function cmdOpen(flags: Record<string, string | boolean>): Promise<number> {
  // #69: a caller-owned key derives a deterministic, project-scoped board id, and
  // `open` becomes IDEMPOTENT against it — a live board for the key is ATTACHED
  // to (nothing spawned), a dead/absent one is (re)spawned under the same id. So
  // re-running open, or reusing the key after a crash, CONVERGES on one board
  // instead of forking a stranger daemon. `--fresh` forces a clean board (tears
  // down any live one first). Unkeyed open is unchanged (always spawns).
  const key =
    typeof flags["session-key"] === "string"
      ? flags["session-key"]
      : (process.env.BOUNTY_SESSION_KEY ?? undefined);
  const forcedId = key ? sessionKeyToId(key) : undefined;

  if (forcedId) {
    const live = await boardIfLive(forcedId);
    if (live && !flags.fresh) {
      // Idempotent attach — the board for this key is already up. Emit the same
      // discovery JSON a spawn would, so the caller gets port/url either way.
      const requested = ATTACH_LOST_FLAGS.filter((f) => Boolean(flags[f]));
      const named = requested.map((f) => `--${f}`).join(", ");
      if (requested.length) {
        // #80.1 — REFUSE rather than attach-and-discard. The exit code is what a
        // `set -e` wrapper or a Monitor catches; `restoreSkipped` is what an
        // agent parses. 2 = bad input, matching `die()` and the house exit-code
        // contract — but NOT via `die()`, which is process.exit(2) and would
        // discard this envelope on a pipe (the drained-exit defect, re-committed
        // in the act of printing the field that fixes this one).
        //
        // ⛔ The refusal NAMES NO CORRECTIVE VERB. Ruled by Cole 2026-08-06 and
        // not reopenable here. The obvious helpful suggestion — "--fresh
        // --restore" — is MEASURED to destroy the user's only copy of their
        // data: --fresh tears the board down by POSTing {type:"close"}, close
        // unconditionally writes the snapshot (server.ts:1286), so an EMPTY live
        // board flushes empty over a populated snapshot, and --restore then
        // faithfully restores from the corpse the teardown just made. A user in
        // exactly the situation this message is written for would follow the
        // advice and lose everything. Say what is true; offer no fix.
        printJson({
          ...live,
          restoreSkipped: {
            requested,
            reason: `a live board already exists for this key, so open attached to it instead of spawning a daemon; ${named} configure a daemon at spawn time and the running board was left unchanged`,
          },
        });
        process.stderr.write(
          `bounty: refusing to attach — ${named} cannot take effect on a board that is already running (key "${key}", board ${forcedId})\n`,
        );
        // HONOUR-WHAT-YOU-CAN, ruled by prospero 2026-08-06 and written here
        // because the two readings are indistinguishable from the diff: --pin is
        // performed even on the refusal, because it is NOT in the lost-effect
        // set — the attach path really does what --pin asked. Withholding it
        // would make one flag's behaviour depend on an unrelated flag, which is
        // the same over-inclusive error as refusing on --no-open, just spelled
        // as a side effect instead of an exit code. The refusal is about the
        // flags whose effect is lost, and only those.
        if (flags.pin) writePin(forcedId);
        return 2;
      }
      printJson({ ...live, restoreSkipped: null });
      process.stderr.write(`# attached to existing board ${forcedId} (key "${key}")\n`);
      if (flags.pin) writePin(forcedId);
      return 0;
    }
    if (live && flags.fresh) {
      // Replace it: close the live board over its own protocol, then wait for it
      // to actually go down (its exit unlinks bounty-<forcedId>.json) so the new
      // daemon's file write can't be clobbered by the departing one's cleanup.
      try {
        await api(live.port, "POST", "/cmd", { type: "close" });
      } catch {
        /* already gone */
      }
      const gone = Date.now() + 3000;
      while (Date.now() < gone && (await boardIfLive(forcedId))) await sleep(80);
    }
  }

  const args = ["run", SERVER_SCRIPT];
  if (flags.title) args.push("--title", String(flags.title));
  if (flags.timeout) args.push("--timeout", String(flags.timeout));
  if (flags.restore) args.push("--restore", String(flags.restore));
  if (flags["no-open"]) args.push("--no-open");
  if (forcedId) args.push("--id", forcedId); // force the daemon's id to the derived key id

  const prevId = readSession()?.session_id;
  // Point the detached daemon's native stderr at the durable diagnostics log
  // (#64) so Bun's OWN hard-abort output — the crash traces JS handlers can't
  // catch, which "ignore" used to discard — is captured on the same file the
  // daemon appends its lifecycle lines to. Best-effort: fall back to "ignore" if
  // the fd can't be opened (never block `open` on logging). stdin+stdout stay
  // ignored.
  let stderr: "ignore" | number = "ignore";
  try {
    const bountyHome = process.env.BOUNTY_HOME ?? join(homedir(), ".bounty");
    mkdirSync(bountyHome, { recursive: true });
    stderr = openSync(join(bountyHome, "daemon.log"), "a");
  } catch {
    stderr = "ignore";
  }
  // node:child_process (not Bun.spawn) is deliberate + matches imago/grapevine:
  // the daemon must SURVIVE this CLI process exiting, which needs detached:true
  // + unref(). Bun.spawn can't detach a surviving daemon.
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", stderr],
    env: process.env,
    cwd: join(SCRIPT_DIR, ".."),
  });
  proc.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(80);
    // A keyed open polls its OWN board file (deterministic id) — not `latest`,
    // which a concurrent open could win. Unkeyed open keeps the legacy
    // read-latest-until-the-id-changes behavior.
    const s = forcedId ? readSession(forcedId) : readSession();
    const isUp = forcedId ? !!s : !!(s && s.session_id !== prevId);
    if (s && isUp) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/state`);
        if (r.ok) {
          // `restoreSkipped` is PRESENT AND NULL on every success path, never
          // absent (#80.1 / D1.2). A field that appears only when it has
          // something to say cannot be told apart from a build that does not
          // emit it at all, so `"restoreSkipped" in envelope` is the assertion
          // that has teeth and `=== null` alone is the one that passes vacuously.
          printJson({ ...s, restoreSkipped: null });
          if (flags.pin) writePin(s.session_id);
          return 0;
        }
      } catch {
        /* not up yet */
      }
    }
  }
  return die("bounty daemon failed to start within 5s");
}

// b6 — `full` is no longer a parameter. The read is always full, so there is
// nothing for it to select. The FLAG stays declared in CLI_OPTIONS so a strict
// parser still accepts `state --full` from existing callers (removing it would
// exit 2 on them), and `readMode: "full"` in the response confirms they got what
// they asked for rather than leaving it assumed.
async function cmdState(
  session: string | undefined,
  scope: { owner?: string; mine?: boolean; as?: string } = {},
) {
  const s = requireSession(session);
  // b6 — DEFAULT FLIPPED. This line used to read `${full ? "" : "?lean=1"}`, so
  // the most-used read in the toolbox asked for LEAN and `--full` asked for
  // everything. That is a lossy read as the default, and it was harmless only by
  // accident of the server ignoring the parameter.
  //
  // ⛔ A PRE-INSTALLED ABSENCE WITH A TRIGGER DATE: server.ts documents that
  // `lean ≈ full today` and explicitly reserves the right to implement a real
  // lean later. On the day anyone does, every existing caller would silently
  // start receiving a TRIMMED payload with nothing saying which mode produced
  // it. Flipping it is free and safe TODAY precisely because the flag is
  // currently a no-op, and impossible to do safely afterwards.
  //
  // A LOSSY READ MUST BE OPTED INTO, NEVER DEFAULTED.
  //
  // `--full` is KEPT and now names the default. It is not removed: the parser is
  // strict, so an unknown flag exits 2 — deleting it would turn every existing
  // `state --full` caller into a hard failure to fix a flag that never did
  // anything. It is documented as compatibility rather than left to look load-
  // bearing (cassandra's r4: SKILL.md advertised it with no note that it was
  // inert, and that is the contract a cold agent reads).
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200) die(`state failed (HTTP ${status})`);
  // Scoped readback (mirrors `tail` semantics): --owner X = X's tasks; --mine =
  // own + claimable (unowned). Each retained task keeps its computed
  // `liveBlockers`, so a blocked task stays actionable even when the blocker is
  // owned by someone else and thus filtered out of this view.
  if (scope.owner || scope.mine) {
    const d = data as { state?: { tasks?: Array<{ owner?: string }> } };
    if (d.state?.tasks) {
      d.state.tasks = d.state.tasks.filter((t) => ownerInScope(t.owner, scope));
    }
  }
  // b6 — the response now STATES WHICH MODE ANSWERED IT rather than leaving the
  // caller to assume its request was honoured. Always "full", because that is
  // what the daemon actually serves; `readMode` is a claim about the ANSWER, not
  // an echo of the ASK.
  //
  // DOMAIN, stated because a present-and-null field is only honest over one
  // (outcome-contract Boundary 3): `readMode` ranges over what THIS CLI
  // requested and what the daemon returned for `/state`. It says nothing about
  // any other route, and it is not a promise that a future lean would be
  // reported here — that would be the same fuse one level up.
  printJson({ ...(data as Record<string, unknown>), readMode: "full" });
}

async function cmdTail(
  session: string | undefined,
  sinceArg: number,
  scope: { owner?: string; mine?: boolean; as?: string } = {},
) {
  let since = sinceArg;
  let delay = 250;
  let stopped = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Client-side scope filter (the daemon streams ALL events). Lifecycle frames
  // (ready/connected/disconnected/closed) always pass — only task.* frames are
  // owner-scoped. `--mine` also passes claimable (unowned) tasks.
  const owner = scope.owner;
  const self = scope.as;
  // Owner-scoped frames: task.* mutations AND `unblocked` (it carries an owner,
  // so it must be scoped — else every worker wakes on every unblock). Lifecycle
  // (ready/connected/disconnected/closed) always passes.
  const scopeable = (t?: string) =>
    typeof t === "string" && (t.startsWith("task.") || t === "unblocked" || t === "heartbeat");
  const inScope = (ev: { type?: string; owner?: string }) =>
    !scopeable(ev.type) || ownerInScope(ev.owner, scope);
  // Self-echo suppression: drop frames the caller's own identity caused (applied
  // after the scope filter). Notice rides stderr, never stdout.
  if (owner) process.stderr.write(`# scoped to owner=${owner}\n`);
  else if (scope.mine)
    process.stderr.write(`# scoped to --mine (owner=${self ?? "?"} + claimable)\n`);

  // Pin the session this tail follows (#tail-pin). An explicit --session is
  // pinned up front; an unpinned tail pins the first session it resolves and
  // never consults `latest` again — no silent cross-project hijack on reconnect.
  let pinned = session;
  while (!stopped) {
    const resolved = pickTailSession(pinned, readSession);
    if (!resolved) {
      process.stderr.write("# no session yet, retrying…\n");
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (pinned === undefined) {
      pinned = resolved.pinned;
      process.stderr.write(
        `# pinned to session ${pinned} — a long-lived tail won't migrate to a newer board (pass --session to choose another)\n`,
      );
    }
    const s = resolved.session;
    let res: Response;
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
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            process.stderr.write(": bounty-keepalive\n");
            continue;
          }
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join("\n");
        try {
          const ev = JSON.parse(payload) as {
            id?: number;
            type?: string;
            by?: string;
            owner?: string;
          };
          // Advance the cursor on EVERY event (even filtered ones) so resume is
          // correct regardless of scope.
          if (typeof ev.id === "number" && ev.id > since) since = ev.id;
          // Scope filter, then self-echo suppression. `closed` is lifecycle, so
          // it always passes — but guard the exit outside the filter regardless.
          const selfEcho = self !== undefined && ev.by === self;
          const emit = inScope(ev) && !selfEcho;
          if (ev.type === "closed") {
            // P0f — the terminal frame is the one a consumer most needs and the
            // one `write(payload); process.exit(0)` throws away: Bun's stdout is
            // async on a PIPE, and an explicit exit discards whatever has not
            // drained (measured in this repo at exactly 65,536 bytes).
            //
            // SHAPE B — the callback rides THIS write, so it fires on THIS
            // write's completion. Do NOT "fix" this with a trailing
            // `write("", () => exit)`: a drain callback covers only its own
            // write and is not a barrier — measured byte-for-byte as broken as
            // no fix at all, and it is the helper this shape invites.
            //
            // PER-SITE PRECONDITION, checked here and not inferred from the
            // shape: this exit sits THREE loops deep (while → for-sep →
            // for-line), so `process.exitCode` + a natural return — the tidy
            // one-liner used at the nine entry points — does NOT return from a
            // tail. It falls through and the loop goes round again. That is the
            // 23-minute `glamour open` hang, one sprint later, in a new place.
            // The explicit `return` below is what leaves all three loops; the
            // callback is what drains. Both are required, for different reasons.
            if (emit) process.stdout.write(`${payload}\n`, () => process.exit(0));
            else process.exit(0);
            stopped = true;
            return;
          }
          if (emit) process.stdout.write(`${payload}\n`);
        } catch {
          /* skip malformed frame */
        }
      }
    }
    // stream ended — daemon likely closed; loop will retry or exit.
    await sleep(delay);
  }
}

function cmdInfo(session?: string) {
  const s = readSession(session);
  if (!s) die("no running bounty session");
  printJson(s);
}

function cmdSessions() {
  let files: string[];
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    process.stdout.write("no saved sessions\n");
    return;
  }
  type Row = { id: string; title: string; tasks: number; mtime: number };
  const rows: Row[] = [];
  for (const f of files) {
    const path = join(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        tasks: Array.isArray(st.tasks) ? st.tasks.length : 0,
        mtime: statSync(path).mtimeMs,
      });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.tasks} tasks  — ${r.title}\n`);
  }
  if (!rows.length) process.stdout.write("no saved sessions\n");
}

// b1 — `tasks` is `number | null`: null means the board ANSWERED but its task
// count could not be established. Before, an unrecognised body reported 0, which
// is indistinguishable from an empty board (b5's defect in this probe). It could
// not simply become null at the probe, because liveBoards treats null as DEAD
// and would have made a live-but-uncountable board VANISH from `list` — worse
// than a wrong count. Distinguishing "not live" from "live, uncountable" needs
// the two nulls to live at different levels, which is this type change.
type LiveBoard = { session_id: string; title: string; url: string; tasks: number | null };

// Filter discovered sessions to the LIVE ones via an injected probe (task count
// if the board answers, null if dead/stale). Probes run in parallel. Injecting
// the probe keeps the live-filter unit-testable without spawning real daemons.
async function liveBoards(
  discovered: Session[],
  probe: (s: Session) => Promise<{ tasks: number | null } | null>,
): Promise<LiveBoard[]> {
  const probed = await Promise.all(
    discovered.map(async (s) => {
      // OUTER null = the board did not answer, so it is not live and is dropped.
      // The count INSIDE a live board may separately be null — see LiveBoard.
      const probed = await probe(s);
      return probed === null
        ? null
        : { session_id: s.session_id, title: s.title, url: s.url, tasks: probed.tasks };
    }),
  );
  return probed.filter((b): b is LiveBoard => b !== null);
}

// Liveness probe: GET /state with a short timeout. Returns the task count if the
// board answers, null if unreachable (a stale discovery file left by a daemon
// that died without cleanup).
async function probeBoard(s: Session): Promise<{ tasks: number | null } | null> {
  try {
    // b6 — `?lean=1` SURVIVES HERE ON PURPOSE, and this is the deliberate
    // opt-in the flipped default exists to make possible. b6's rule is that a
    // LOSSY READ MUST BE OPTED INTO, NEVER DEFAULTED; a liveness probe with a
    // 600ms budget that reads nothing but a count is exactly the caller that
    // should opt in. Flipping cmdState and leaving this untouched is the rule
    // applied, not the rule half-applied. (Raised by cassandra, #777 — the
    // comment did not say, and an unexplained survivor reads as an oversight.)
    const res = await fetch(`${s.url}/state?lean=1`, { signal: AbortSignal.timeout(600) });
    if (!res.ok) return null;
    const body = (await res.json()) as { state?: { tasks?: unknown[] } };
    // b1 — TWO DIFFERENT NULLS, and keeping them apart is the whole point. The
    // outer null (returned above and below) means NOT LIVE, and liveBoards drops
    // that board. This inner one means LIVE BUT UNCOUNTABLE: the board answered
    // 200 and its body was not the shape we recognise. It used to report 0,
    // which is indistinguishable from an empty board — b5's defect in this
    // probe — and it must NOT collapse into the dead null, or a live board
    // disappears from `list` entirely.
    return { tasks: Array.isArray(body.state?.tasks) ? body.state.tasks.length : null };
  } catch {
    return null;
  }
}

// `list` — enumerate currently-RUNNING boards from the tmpdir discovery files
// (bounty-<id>.json, minus the bounty-latest pointer), liveness-probe each, and
// print only the live ones (id/task-count/url/title). Distinct from `sessions`,
// which lists saved snapshots (including closed boards). For join-disambiguation
// and seeing what's running before a command hits the wrong board.
async function cmdList() {
  let files: string[];
  try {
    files = readdirSync(tmpdir()).filter(
      (f) => f.startsWith("bounty-") && f.endsWith(".json") && f !== "bounty-latest.json",
    );
  } catch {
    files = [];
  }
  const discovered: Session[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(tmpdir(), f), "utf8")) as Session;
      if (s && typeof s.url === "string" && typeof s.session_id === "string") discovered.push(s);
    } catch {
      /* skip an unreadable / partial discovery file */
    }
  }
  const live = await liveBoards(discovered, probeBoard);
  live.sort((a, b) => a.session_id.localeCompare(b.session_id));
  // b1 / #79 — SAY WHICH QUESTION THIS ANSWERED. The reporter seeded six cards,
  // ran `list` to confirm they were there, got nothing back, and concluded the
  // cards had not been created — one message from filing a false defect against
  // a working tool. `list` is the verb a caller reaches for to see what is ON a
  // board; it enumerates BOARDS. The verb is right and the noun is a different
  // one than the caller has in mind, and an empty set is exactly what they
  // expect to see when their cards are missing, so it CONFIRMS the wrong
  // hypothesis instead of raising a question.
  //
  // Naming the noun on every path — including the populated one — is what lets a
  // caller notice they asked a different question than the one answered.
  process.stdout.write(`${live.length} running board${live.length === 1 ? "" : "s"}\n`);
  for (const b of live) {
    // A null count is LIVE BUT UNCOUNTABLE, never 0. Rendered as "?" so it can
    // never be read as an empty board — the whole reason the two nulls are kept
    // apart upstream.
    const count = b.tasks === null ? "? (unreadable)" : `${b.tasks} tasks`;
    process.stdout.write(`${b.session_id}  ${count}  ${b.url}  — ${b.title}\n`);
  }
  if (!live.length)
    process.stdout.write(
      "this lists BOARDS, not tasks — for the cards ON a board use `bounty state`\n",
    );
}

// Read all of stdin as a single string. Used by --stdin so free text (titles,
// notes) lands verbatim regardless of shell metacharacters.
async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/\n$/, "");
}

const HELP = `bounty — an agent-driven task board.

  open   [--title ..] [--timeout S] [--no-open] [--restore <id>] [--pin] [--session-key <key> [--fresh]]   spawn a board daemon (--pin binds it to cwd; --session-key binds it to a caller-owned key, idempotently)
  state  [--mine | --owner <name>] [--as <name>]   read-back: { state, cursor, readMode }
           (--full is accepted but redundant: the read is full by default — b6)
  tail   [--since N] [--owner <name> | --mine] [--as <name>]   SSE events → JSONL (Monitor)
  add    <title...> [--status ..] [--notes ..] [--owner ..] [--tag a,b] [--size S|M|L] [--expect <min>] [--id ..] [--stdin]   add a task
  update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--tag a,b] [--size S|M|L] [--expect <min>] [--stdin]      patch a task (--tag "" clears)
  --size S|M|L → heartbeat estimate (5/10/20 min); --expect <min> overrides. A doing task that overruns pokes its owner.
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

  --as <name> (or $BOUNTY_AS) is your identity — stamped on events (for scoped
  tail + self-echo suppression) and used by claim/--mine. --owner assigns a task.
  --stdin reads the title from stdin (verbatim — survives apostrophes, quotes,
  &, <, >). Session targeting resolves --session-key <key> > --session <id> >
  $BOUNTY_SESSION_KEY > $BOUNTY_SESSION > nearest .bounty-session (walking up
  from cwd) > most-recent board. A --session-key is a caller-owned handle: it
  derives a stable, project-scoped board id, so open --session-key K is
  idempotent (attaches to a live board for K, respawns a dead one; --fresh
  forces a clean one), and every verb re-derives the same id — deterministic
  board binding with no stored/latest pointer. Or use open --pin to write
  cwd/.bounty-session and bind a board to this directory.`;

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  let pos: string[];
  let flags: Record<string, string | boolean>;
  try {
    ({ pos, flags } = parseArgs(rest));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`bounty: ${e.message}\n`);
    return 2;
  }
  const session = resolveSession(flags);
  const as = resolveAs(flags);

  switch (verb) {
    case "open":
      // Propagates cmdOpen's code so the #80.1 refusal actually reaches the
      // shell — `break` here would swallow it into main's trailing `return 0`.
      return await cmdOpen(flags);
    case "tail": {
      const mine = flags.mine === true;
      if (mine && !as) die("--mine needs an identity — pass --as <name> or set BOUNTY_AS");
      await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1, {
        owner: typeof flags.owner === "string" ? flags.owner : undefined,
        mine,
        as,
      });
      break;
    }
    case "state": {
      const mine = flags.mine === true;
      if (mine && !as) die("--mine needs an identity — pass --as <name> or set BOUNTY_AS");
      await cmdState(session, {
        owner: typeof flags.owner === "string" ? flags.owner : undefined,
        mine,
        as,
      });
      break;
    }
    case "add": {
      const title = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!title) die("usage: add <title...> [--status ..] [--notes ..] [--stdin]");
      const status =
        typeof flags.status === "string" && VALID_STATUS.includes(flags.status as TaskStatus)
          ? (flags.status as TaskStatus)
          : "todo";
      const task: Record<string, unknown> = {
        id: typeof flags.id === "string" ? flags.id : newTaskId(),
        title,
        status,
      };
      if (typeof flags.notes === "string") task.notes = flags.notes;
      if (typeof flags.owner === "string") task.owner = flags.owner;
      if (typeof flags.tag === "string") task.tags = parseTags(flags.tag);
      const addSize = parseSize(flags.size);
      if (addSize) task.size = addSize;
      const addExpect = parseExpect(flags.expect);
      if (addExpect !== undefined) task.expect = addExpect;
      const addIgnored = ignoredValues(flags);
      warnIgnored(addIgnored);
      // #83 — `add` was the ONLY write verb that discarded the daemon's verdict:
      // update/claim/block/unblock/remove all read it. So this is an oversight
      // corrected to match its four siblings, not a new convention.
      //
      // No no-op branch here, unlike `update`. `update` has a legitimate
      // applied:false (the task already held the value); `add` does not — a
      // refusal means the shape was invalid or the id was taken, and both are
      // real failures. The daemon names which.
      const res = await postCmd(session, { type: "task.add", task }, { as, quiet: true });
      if (!res.applied) {
        const error = res.error ?? `task ${task.id} was not added`;
        printJson({ ok: false, applied: false, id: task.id, error });
        process.stderr.write(`bounty: ${error}\n`);
        return 1;
      }
      // Present-and-null, never absent (the restoreSkipped lesson, D1.2): a
      // field that appears only when it has something to say cannot be told
      // apart from a build that does not emit it at all.
      printJson({ ok: true, added: task.id, valuesIgnored: addIgnored.length ? addIgnored : null });
      break;
    }
    case "update": {
      const id = pos[0];
      if (!id)
        die(
          "usage: update <id> [--status ..] [--title ..] [--notes ..] [--owner ..] [--tag a,b] [--stdin]",
        );
      const patch: Record<string, unknown> = {};
      if (flags.stdin === true) patch.title = await readStdin();
      else if (typeof flags.title === "string") patch.title = flags.title;
      if (typeof flags.status === "string") patch.status = flags.status;
      if (typeof flags.notes === "string") patch.notes = flags.notes;
      if (typeof flags.owner === "string") patch.owner = flags.owner; // lead reassignment
      if (typeof flags.tag === "string") patch.tags = parseTags(flags.tag); // SET; "" clears
      const upSize = parseSize(flags.size);
      if (upSize) patch.size = upSize;
      const upExpect = parseExpect(flags.expect);
      if (upExpect !== undefined) patch.expect = upExpect;
      const upIgnored = ignoredValues(flags);
      warnIgnored(upIgnored);
      if (Object.keys(patch).length === 0) {
        // ⛔ THE ENVELOPE NEVER PRINTS ON THIS PATH, so the ignored-flag report
        // has to ride the refusal itself — and this is the case where the caller
        // most needs it. `update <id> --size bogus` with no other flag lands
        // HERE: the size was dropped, which left the patch empty, which is why
        // it refuses. Measured, and the refusal used to blame an empty patch
        // while saying nothing about the flag the caller actually passed.
        //
        // `--size`/`--expect` are also ADDED to the flag list: the old message
        // omitted them, and that omission was read (by the sprint scaffold, and
        // by me at first) as a symptom of the drop. It is a second, real defect
        // — a VALID `--size` does populate the patch, so it always belonged in
        // the list of flags that would have made this succeed.
        const why = upIgnored.length
          ? ` — ${upIgnored.map((i) => `--${i.flag} ${JSON.stringify(i.value)} was ignored (${i.reason})`).join("; ")}`
          : "";
        die(
          `update: nothing to change (give --status/--title/--notes/--owner/--tag/--size/--expect/--stdin)${why}`,
        );
      }
      // Surface the daemon's outcome (like claim/block), distinguishing the two
      // kinds of applied:false: WITH an error = not-found / rejected (e.g. the
      // verb mis-routed to a stranger board) → a visible, nonzero failure, never
      // a silent {ok:true} (#62). WITHOUT an error = a legitimate no-op (the task
      // already held this value, e.g. doing→doing) → benign success, since the
      // task exists and the board is right.
      const res = await postCmd(session, { type: "task.update", id, patch }, { as, quiet: true });
      if (res.applied) {
        printJson({ ok: true, updated: id, valuesIgnored: upIgnored.length ? upIgnored : null });
      } else if (res.error) {
        process.stderr.write(`bounty: ${res.error}\n`);
        return 1;
      } else {
        // The no-op branch carries it too. Leaving it off here would mean the
        // field's presence depended on whether the daemon happened to change
        // anything — so a caller could not tell "no ignored flags" from "this
        // build does not report them", which is the exact absence the
        // present-and-null rule exists to prevent.
        printJson({
          ok: true,
          updated: id,
          noop: true,
          valuesIgnored: upIgnored.length ? upIgnored : null,
        });
      }
      break;
    }
    case "claim": {
      // Cooperative self-claim: take ownership of an UNOWNED task. Rejected (and
      // surfaced) if someone else already owns it — never a silent steal.
      const id = pos[0];
      if (!id) die("usage: claim <id> [--as <name>]");
      if (!as) die("claim needs an identity — pass --as <name> or set BOUNTY_AS");
      const res = await postCmd(
        session,
        { type: "task.update", id, patch: { owner: as }, claim: true },
        { as, quiet: true },
      );
      if (res.applied) {
        printJson({ ok: true, claimed: id, owner: as });
      } else {
        // Visible rejection — nonzero exit so the agent can't mistake a rejected
        // claim for ownership (the daemon returned applied:false).
        process.stderr.write(`bounty: ${res.error ?? `could not claim ${id}`}\n`);
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
      const on = flags.on
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (!on.length) die(`${verb}: --on needs at least one task id`);
      const res = await postCmd(
        session,
        { type: verb === "block" ? "task.block" : "task.unblock", id, on },
        { as, quiet: true },
      );
      if (res.applied) {
        printJson({ ok: true, [verb === "block" ? "blocked" : "unblocked"]: id, on });
      } else {
        // Visible rejection (e.g. a cycle) — nonzero exit, like a rejected claim.
        process.stderr.write(`bounty: ${res.error ?? `could not ${verb} ${id}`}\n`);
        return 1;
      }
      break;
    }
    case "remove": {
      const id = pos[0];
      if (!id) die("usage: remove <id>");
      // Same applied-check as update (#62): a not-found remove (mis-routed to
      // another board) must fail visibly, not print a silent success.
      const res = await postCmd(session, { type: "task.remove", id }, { as, quiet: true });
      if (res.applied) {
        printJson({ ok: true, removed: id });
      } else {
        process.stderr.write(
          `bounty: ${res.error ?? `no such task ${id} (wrong board? pass --session)`}\n`,
        );
        return 1;
      }
      break;
    }
    case "message": {
      const text = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!text) die("usage: message <text...> [--stdin]");
      // DECIDED EXPLICITLY (plan step 2), and recorded because "we checked it"
      // and "it cannot fail" are different claims: the daemon answers `message`
      // with applied:true unconditionally today, so routing it through the
      // funnel changes NOTHING now. It is a regression guard — if `message`ever
      // grows a refusal (a closed board, a rejected payload), the CLI reports it
      // without anyone remembering to come back here.
      return ackOrFail(
        "message",
        await postCmd(session, { type: "message", text }, { as, quiet: true }),
      );
    }
    case "init": {
      const msg: Record<string, unknown> = { type: "init" };
      if (typeof flags.title === "string") msg.title = flags.title;
      if (flags["stdin-tasks"] === true) {
        const raw = await readStdin();
        try {
          const tasks = JSON.parse(raw);
          if (!Array.isArray(tasks)) die("init --stdin-tasks: stdin must be a JSON array of tasks");
          msg.tasks = tasks;
        } catch (e) {
          if (e instanceof Error && e.message.includes("JSON array")) throw e;
          die("init --stdin-tasks: invalid JSON on stdin");
        }
      }
      // The generic path — and the one with a REAL behaviour change today. The
      // daemon's command dispatch ends in `return {ok:true, applied:false}` for
      // any type it does not recognise, so an unrecognised command has always
      // been answered with a success-shaped envelope. Routing through the funnel
      // is what turns that into a visible failure.
      return ackOrFail(msg.type, await postCmd(session, msg, { as, quiet: true }));
    }
    case "close": {
      // Same explicit decision as `message`: applied:true unconditionally today,
      // so this is a regression guard rather than a fix. It earns its place
      // because `close` is the verb that WRITES THE SNAPSHOT — a close that
      // silently failed to apply, reported as success, is how a caller concludes
      // its data was persisted when it was not.
      const closeRes = await postCmd(session, { type: "close" }, { as, quiet: true });
      // b14 — WAIT FOR IT TO ACTUALLY BE DOWN. `close` used to return as soon as
      // the daemon ACKED the command, and the daemon acks before it finishes
      // tearing down. Measured: `state` on the same session STILL ANSWERS with
      // the full board immediately after a successful close, and only stops
      // after a settle. So a caller that closed and reopened attached to the
      // dying board instead of respawning — success reported an ACT, not its
      // COMPLETION.
      //
      // The wait is not new machinery: `open --fresh` already polls
      // `boardIfLive` for up to 3s after its own teardown POST. This applies the
      // discipline that already existed one function away, which is also why the
      // bound and the interval match it rather than being invented here.
      //
      // `down` is REPORTED rather than enforced: if the daemon outlives the
      // bound, that is a real fact a caller may need (a wedged teardown), and
      // exiting non-zero would turn a slow close into a failed one. Present on
      // every close, never absent — a readable blank beats an absence.
      const resolved = requireSession(session);
      const deadline = Date.now() + 3000;
      let down = false;
      while (Date.now() < deadline) {
        if (!(await boardIfLive(resolved.session_id))) {
          down = true;
          break;
        }
        await sleep(80);
      }
      if (!closeRes.applied) return ackOrFail("close", closeRes);
      printJson({ ok: true, sent: "close", down });
      if (!down)
        process.stderr.write(
          "bounty: close acked but the daemon was still answering after 3s — a reopen may attach to it\n",
        );
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
      process.stdout.write(`${HELP}\n`);
      break;
    default:
      die(`unknown verb "${verb}" — run: cli.ts help`);
  }
  return 0;
}

if (import.meta.main) {
  // `process.exitCode` + a natural return, NEVER `process.exit(code)`. Bun's
  // stdout is asynchronous on a PIPE and synchronous on a TTY or file, so an
  // explicit exit discards whatever has not drained — measured in this repo at
  // exactly 65,536 bytes, with the file form of the same payload complete. The
  // symptom is a truncated JSON body that fails to parse, and the harm is worse
  // than a crash: a reader concluded "our board is too big to read" and three
  // agents worked under that false rule.
  //
  // Setting exitCode and letting the process end naturally lets the runtime
  // flush first, and preserves the exit code the verb chose. Do not "tidy" this
  // back into an explicit exit.
  process.exitCode = await main(process.argv.slice(2));
}

export type { Session };
export { liveBoards, main, ownerInScope, parseTags, pickTailSession, resolveSession };
