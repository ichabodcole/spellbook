/**
 * The workspace CLI: the agent's half. A thin client of the per-session daemon
 * (`server.ts`): `open` spawns one, every other verb finds it through the
 * session pointer in the OS temp directory and speaks HTTP. `tail` streams the
 * session's events as JSON lines for the agent's Monitor to wrap.
 *
 * The kit's verbs are here, registered through the CLI registry, and an app adds
 * its own to the same table (`createWorkspaceCli({ commands })`).
 *
 * Failure contract (`../wire/errors`): every failure is one JSON envelope on
 * stderr, stdout empty. A daemon refusal maps off its HTTP status (400 usage,
 * 404 not_found, 409 conflict, else internal); the daemon's body rides verbatim
 * under `server`, and when the daemon named the valid set (a doc slug, a
 * version) that set is also lifted into `choices`.
 *
 * Prose goes through `--body-file <path>` or `--stdin`, never through an
 * unquoted argument: a word that happens to start with `--` or a shell that
 * eats a backtick must not be able to change what the agent says.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  type Cli,
  type CommandSpec,
  defineCli,
  type FlagValue,
  type Invocation,
  type OptionsTable,
} from "../cli/registry";
import {
  IMAGE_EXTENSIONS,
  isHeicName,
  isImageName,
  isSvgName,
  SVG_REFUSED,
} from "../lib/docFormat.ts";
import { homeDir } from "../lib/home.ts";
import { printJson } from "../lib/printJson";
import { startDaemon } from "../wire/detach";
import { type DiscoveryOptions, readPointer, type SessionPointer } from "../wire/discovery";
import { CliError, die, type ErrKind, reportCliError } from "../wire/errors";
import { stdinWaiting } from "../wire/stdinPeek";
import {
  commandLine,
  readSince,
  tailCommand,
  tailWithHandoff,
  WINDOW_HELP,
} from "../wire/tailHandoff";
import {
  AGENT_ALL_PARAM,
  AGENT_ONCE_PARAM,
  AGENT_TAIL_PARAM,
  NOT_PRESENCE_HEADER,
  TAIL_IDLE_MS,
} from "./heartbeat";
import { type HomeDeclaration, hasHomeWorkspace, locationHint, notAddedWhole } from "./noHome";
import type { DiffSide } from "./protocol";
import { DOC_EXTENSIONS, isDocName } from "./tree";

/** The flags every workspace CLI knows. An app adds its own beside them. */
export const KIT_OPTIONS = {
  against: { type: "string" },
  all: { type: "boolean" },
  "body-file": { type: "string" },
  context: { type: "string" },
  doc: { type: "string" },
  edge: { type: "string" },
  failed: { type: "boolean" },
  focus: { type: "string" },
  for: { type: "string" },
  from: { type: "string" },
  full: { type: "boolean" },
  hunk: { type: "string" },
  hunks: { type: "string" },
  hops: { type: "string" },
  kind: { type: "string" },
  label: { type: "string" },
  limit: { type: "string" },
  "no-open": { type: "boolean" },
  once: { type: "boolean" },
  parent: { type: "string" },
  patch: { type: "boolean" },
  quote: { type: "string" },
  heading: { type: "string" },
  rel: { type: "string" },
  reopen: { type: "boolean" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  source: { type: "string" },
  "start-timeout": { type: "string" },
  stdin: { type: "boolean" },
  timeout: { type: "string" },
  untyped: { type: "boolean" },
  "update-links": { type: "boolean" },
  via: { type: "string" },
  kindless: { type: "boolean" },
  bundles: { type: "boolean" },
  within: { type: "string" },
  format: { type: "string" },
  quality: { type: "string" },
  "max-side": { type: "string" },
} as const satisfies OptionsTable;

/** The flags only an app with no home workspace has (`./noHome.ts`): `import --into`. */
export const NO_HOME_OPTIONS = {
  into: { type: "string" },
} as const satisfies OptionsTable;

export type KitFlag = keyof typeof KIT_OPTIONS;
type NoHomeFlag = keyof typeof NO_HOME_OPTIONS;
type Flags = Record<string, FlagValue | undefined>;

export class UsageError extends CliError {
  constructor(message: string, extra?: { hint?: string; choices?: string[] }) {
    super("usage", message, extra);
  }
}

/** What `version-new` adds to its answer when stdin was an open pipe that sent nothing. */
export const STDIN_SILENT = "open but silent: not read (pass --stdin to wait for text)";

/**
 * `version-new`'s text, read only when a flag asks: `--body-file <path>`, or
 * `--stdin` (which waits for the end). No body means "copy". Without
 * `--stdin`, stdin is never read: it may belong to someone else, as in a
 * `while read` loop. It is only looked at (`stdinWaiting`, at most a tenth of
 * a second), and text waiting there is refused rather than dropped; an open
 * pipe that sent nothing in that time is copied over, and `silent` says so.
 */
async function versionBody(flags: Flags): Promise<{ body?: string; silent?: true }> {
  const verb = "version-new";
  const file = typeof flags["body-file"] === "string" ? flags["body-file"] : undefined;
  if (file !== undefined && flags.stdin === true)
    die(`${verb} takes its text from one place: --body-file or --stdin`, "usage", {
      choices: ["--body-file", "--stdin"],
    });
  let text: string;
  if (flags.stdin === true) text = await new Response(Bun.stdin.stream()).text();
  else {
    const look = await stdinWaiting();
    const waiting = look === "text";
    if (file !== undefined) {
      if (waiting)
        die(`${verb}: text was piped in and --body-file names another: give one`, "usage", {
          hint: "drop the pipe, or pass --stdin instead of --body-file to use the piped text",
        });
      try {
        text = readFileSync(file, "utf8");
      } catch (e) {
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "unreadable";
        return die(`${verb}: --body-file ${file} cannot be read (${code})`, "not_found");
      }
    } else if (waiting)
      return die(`${verb}: text was piped in, and nothing was made`, "usage", {
        hint: "text was piped in; pass --stdin to use it as the version's body, or --body-file",
        choices: ["--stdin", "--body-file"],
      });
    else return look === "silent" ? { silent: true } : {};
  }
  if (!text.trim())
    die(`${verb}: the text is empty`, "usage", {
      hint: "to copy a version, give no text (no --body-file or --stdin)",
    });
  return { body: text };
}
/**
 * `tail --since` is a bookmark: an event id (-1 for "everything"), optionally
 * with the epoch of the log it came from (`12@<epoch>`, as the tail's own
 * handoff line prints it). The epoch is what lets the tail notice a restarted
 * daemon whose new log is already past the id. `--since abc` used to parse to
 * NaN, which the log reads as "from the start", so a typo replayed the whole
 * buffer at exit 0: it is refused.
 */
export function parseTailSince(token: string): { since: number; epoch?: string } {
  const r = readSince(token, { epoch: true });
  if (!r.ok) die(r.message, "usage");
  return r.epoch ? { since: r.since, epoch: r.epoch } : { since: r.since };
}

/** `v2` or `2` to 2. A version number is an open set, so the rejection carries a hint, not choices. */
export function parseVersion(token: string, what: string): number {
  const m = /^v?(\d+)$/.exec(token.trim());
  if (!m || Number(m[1]) < 1)
    die(`${what}: "${token}" is not a version: write v1, v2, ...`, "usage", {
      hint: "run: state (each doc lists its versions)",
    });
  return Number(m[1]);
}

/** A non-negative whole number from a flag, refused rather than coerced. */
export function parseCount(token: string, what: string): number {
  const t = token.trim();
  if (!/^\d+$/.test(t)) die(`${what}: "${token}" is not a whole number`, "usage");
  return Number(t);
}

/**
 * An `--edge a,b` filter (kit-link-edges-slot): the edge kinds to keep, `link`
 * naming the body links; undefined when the flag is absent.
 */
export function edgeList(v: FlagValue | undefined, verb: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") die(`${verb} --edge: name at least one edge kind`, "usage");
  const names = v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) die(`${verb} --edge: name at least one edge kind`, "usage");
  return names;
}

/**
 * A comparison side: a version, or the file of record. `original` is written
 * out rather than offered as `v0`: a zeroth version would read like the
 * earliest one, and the original is not part of the version line at all.
 */
export function parseSide(token: string, what: string): DiffSide {
  const t = token.trim().toLowerCase();
  // `saved` is the word the surface uses for this side; `original` and `file`
  // keep working because they are what earlier sessions and notes say.
  if (t === "original" || t === "file" || t === "saved") return "original";
  return parseVersion(token, what);
}

/**
 * `--doc` as the CLI's caller meant it: a token with a path separator, or one
 * naming a file in this process's cwd, is resolved here to an absolute path
 * (the daemon's cwd is not the caller's). Anything else (a slug, a unique file
 * name) goes as typed.
 */
export function docArg(token: string): string {
  if (token.includes("/") || existsSync(resolve(token))) return resolve(token);
  return token;
}

/**
 * Every path is checked here, before any daemon exists. `open doc.md pic.png`
 * used to spawn a session, then fail on the second path inside it, leaving a
 * running daemon and a live pointer behind a failed command. A folder, a
 * document or an image is accepted (an image is listed as its own entry and
 * opens in the viewer); a missing path is not_found, an SVG is usage with its
 * reason, and any other file is usage with the accepted extensions as
 * `choices`.
 */
export function contextPaths(pos: string[]): string[] {
  const paths = pos.map((p) => resolve(p));
  for (const p of paths) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      die(`no such file or folder: ${p}`, "not_found");
    }
    if (!st.isDirectory() && isSvgName(p)) die(`${SVG_REFUSED} (${p})`, "usage");
    if (!st.isDirectory() && isHeicName(p))
      die(
        `a HEIC photo is not shown as it is: drop it on the context list, which converts it to JPEG, or export it as JPEG first: ${p}`,
        "usage",
      );
    if (!st.isDirectory() && !isDocName(p) && !isImageName(p))
      die(`not a document or image the workspace opens: ${p}`, "usage", {
        hint: "add a folder, or a file with one of these extensions",
        choices: [...DOC_EXTENSIONS, ...IMAGE_EXTENSIONS],
      });
  }
  return paths;
}

/**
 * Where a new session's workspace goes. Given one folder, the folder that holds
 * it, so a session over a world made from anywhere puts new documents beside
 * that world rather than in the folder `open` ran in; otherwise (several
 * entries, a lone file, nothing) the folder `open` ran in.
 *
 * Never a folder `open` was given or one inside it: each becomes a set, and the
 * workspace may not be a set's folder or inside one (`kit-workspace-set-overlap`).
 * Such a folder steps out to the folder holding the set. A step out that lands
 * at or above the home folder (`open ~`), or at the top of the disk, gives
 * `undefined`: the session's own
 * `imported/` folder, as with nothing said.
 *
 * `paths` are `contextPaths`'s, already absolute and already checked to exist.
 */
export function defaultWorkspace(paths: readonly string[], cwd: string): string | undefined {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const folders = paths.filter((p) => statSync(p).isDirectory()).map(real);
  const only = paths.length === 1 ? folders[0] : undefined;
  let ws = only !== undefined ? only : real(cwd);
  let stepped = false;
  for (;;) {
    const holder = folders.find((f) => ws === f || ws.startsWith(f + sep));
    if (holder === undefined) break;
    if (dirname(holder) === holder) return undefined;
    ws = dirname(holder);
    stepped = true;
  }
  // A step out that lands at or above the home folder (`open ~` would give
  // /Users) is no place for documents: none, so the session's own imported/.
  const home = real(homeDir());
  if (stepped && (ws === home || home.startsWith(ws + sep) || ws === dirname(ws))) return undefined;
  return ws;
}

/**
 * The folder `open` ran in, for an app with no home workspace opened on no
 * paths: added to the session as an ordinary entry (`context.add`, so a set),
 * or why it is not. Not the home folder or one above it, the top of the disk,
 * a folder that holds the app's sessions or lies among them, or the app's own
 * home (`appHome`) or a folder in it: those are no place to mirror whole
 * (`notAddedWhole`).
 */
export function openingFolder(
  cwd: string,
  sessionsRoot: string,
  appHome?: string,
): { path: string } | { skipped: string } {
  const why = notAddedWhole(cwd, sessionsRoot, appHome);
  return why === null ? { path: cwd } : { skipped: why };
}

/** Keep the newest `LOG_KEEP - 1` daemon logs, so the one about to be written makes `LOG_KEEP`. */
const LOG_KEEP = 10;
function pruneLogs(logDir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(logDir).filter((n) => /^daemon-\d+-\d+\.log$/.test(n));
  } catch {
    return;
  }
  const byAge = names.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  for (const n of byAge.slice(0, Math.max(0, byAge.length - (LOG_KEEP - 1)))) {
    try {
      unlinkSync(join(logDir, n));
    } catch {
      /* already gone */
    }
  }
}

/** A daemon's refusal, mapped to the house taxonomy. */
function daemonRefused(what: string, status: number, data: unknown): never {
  const kind: ErrKind =
    status === 400
      ? "usage"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : "internal";
  const body = (data ?? {}) as { error?: unknown; choices?: unknown; hint?: unknown };
  const choices = Array.isArray(body.choices) ? body.choices.map(String) : undefined;
  // The daemon's own hint, forwarded: a refusal that knows what to do next must
  // not drop that knowledge on the floor.
  const hint = typeof body.hint === "string" ? body.hint : undefined;
  die(typeof body.error === "string" ? body.error : `${what} failed (HTTP ${status})`, kind, {
    ...(hint ? { hint } : {}),
    ...(choices ? { choices } : {}),
    ...(data !== null && data !== undefined ? { server: data } : {}),
  });
}

/** How `open` starts the daemon: the app's own launcher. */
export type DaemonLauncher = {
  /** The runtime, usually `bun`. */
  command: string;
  /** The arguments up to the daemon's own flags: `["run", "<path to server.ts>"]`. */
  args: readonly string[];
  /** The working directory a dev-mode daemon needs. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/** What an app's own verbs get to reach the daemon with. */
export type CliHelpers = {
  readonly app: string;
  /** `["session"]`: list it in a verb's `flags` for the verb to accept `--session`. */
  readonly SESSION: readonly ["session"];
  /** The session a verb was asked about (`--session`), or undefined for the latest. */
  sessionOf(inv: Invocation<string>): string | undefined;
  /** POST one command to the session's daemon; throws the mapped `CliError` on a refusal. */
  postCmd(
    session: string | undefined,
    msg: { op: string; [key: string]: unknown },
  ): Promise<Record<string, unknown>>;
  /** The resolved pointer for a session, or a `not_found` with the way back. */
  requireSession(session: string | undefined): SessionPointer;
  /** Prose from exactly one of: the arguments, `--stdin`, `--body-file`. */
  readBody(pos: string[], flags: Flags, verb: string): Promise<string>;
  docArg: typeof docArg;
  printJson: typeof printJson;
};

export type WorkspaceCliOptions = {
  /**
   * The app's name: it fixes the discovery names the CLI reads. Its
   * `homeWorkspace: false` (the app declaration's, `./noHome.ts`) changes the
   * verbs that would write to a place nobody named: `open` with no paths adds
   * the folder it ran in as an ordinary entry, `import` takes `--into`, and
   * there is no `workspace` verb.
   */
  app: HomeDeclaration;
  /** One line for the help's first line. */
  summary?: string;
  /** The app's own flags, beside the kit's. */
  options?: OptionsTable;
  /** The app's own verbs; they share the table, the failure contract and `--session`. */
  commands?: (h: CliHelpers) => readonly CommandSpec<string>[];
  /** How `open` starts a daemon. */
  daemon: DaemonLauncher;
  /** Where sessions live (the same folder the daemon is given). Lazy, so `help` reads no environment. */
  sessionsRoot: () => string;
  /**
   * The app's own folder, which holds its sessions and settings (Scriptorium's
   * `$SCRIPTORIUM_HOME`): never added as the folder `open` ran in. Lazy, as
   * `sessionsRoot` is.
   */
  appHome?: () => string;
  /** The `version` row's payload. */
  version: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Appended to the help. */
  helpFooter?: string;
  /** Where discovery pointers are read from; default the OS temp directory. */
  discovery?: DiscoveryOptions;
};

export type WorkspaceCli = Cli & {
  /** Runs the CLI, triaging a thrown non-`CliError` the way the kit does. */
  run(argv: string[]): Promise<number>;
};

/** Every flag rejection's hint: the one repair for prose in which a word happens to start with `--`. */
const DASH_HINT = "for free text containing dashes, put it after a bare --";

export function createWorkspaceCli(opts: WorkspaceCliOptions): WorkspaceCli {
  const app = opts.app.name;
  /** The app has no home workspace: nothing is written where the caller did not point. */
  const noHome = !hasHomeWorkspace(opts.app);
  const options = {
    ...KIT_OPTIONS,
    ...(noHome ? NO_HOME_OPTIONS : {}),
    ...(opts.options ?? {}),
  } as OptionsTable;

  // ── finding the daemon ──────────────────────────────────────────────────

  /**
   * Sessions whose work is still on disk, newest first. A dead session is not a
   * lost one: the manifest and every version file live on disk, so a daemon that
   * has exited (the idle timeout, a crash, a reboot) costs the URL and nothing
   * else, and the only thing the tooling said was "no running session", which
   * reads like the work is gone.
   */
  function restorable(): string[] {
    const dir = opts.sessionsRoot();
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "manifest.json")))
        .map((e) => ({ id: e.name, at: statSync(join(dir, e.name, "manifest.json")).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .map((e) => e.id);
    } catch {
      return [];
    }
  }

  /** What to say when no daemon answers, including the way back when there is one. */
  function noSessionHint(): { hint: string; choices?: string[] } {
    const ids = restorable();
    const newest = ids[0];
    if (newest === undefined) return { hint: "no session has been opened yet: run `open <path>`" };
    return {
      // The command, with the id already in it. A hint that says "you can
      // restore a session" leaves the reader to find the id and guess the flag.
      hint: `no daemon is running, but the work is on disk: bring it back with \`open --restore ${newest}\``,
      choices: ids.slice(0, 10),
    };
  }

  /** Who ended a saved session, read from its manifest (which outlives the daemon). */
  function endedBy(id: string): string | undefined {
    try {
      const m = JSON.parse(
        readFileSync(join(opts.sessionsRoot(), id, "manifest.json"), "utf8"),
      ) as {
        ended?: { by?: unknown };
      };
      return typeof m.ended?.by === "string" ? m.ended.by : undefined;
    } catch {
      return undefined;
    }
  }

  /** Null means "no session", and nothing else: ENOENT is the only absence. */
  function readSession(session?: string): SessionPointer | null {
    if (session !== undefined && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(session))
      die(`"${session}" is not a session id`, "usage", {
        hint: "a session id is the session_id that `open` printed",
      });
    try {
      return readPointer(app, session, opts.discovery);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e), "internal");
    }
  }

  function requireSession(session?: string): SessionPointer {
    const s = readSession(session);
    if (!s) die(`no running ${app} session`, "not_found", noSessionHint());
    return s;
  }

  async function api(
    port: number,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; data: unknown }> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers:
        body !== undefined ? { "content-type": "application/json", ...extraHeaders } : extraHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body */
    }
    return { status: res.status, data };
  }

  async function postCmd(
    session: string | undefined,
    msg: { op: string; [key: string]: unknown },
    o: { presence?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const s = requireSession(session);
    let status: number;
    let data: unknown;
    try {
      ({ status, data } = await api(
        s.port,
        "POST",
        "/cmd",
        msg,
        o.presence === false ? { [NOT_PRESENCE_HEADER]: "1" } : {},
      ));
    } catch (err) {
      // `close` stops the server; a reset is its success. A refused connection
      // (a stale pointer) is a transport failure like any other.
      const message = err instanceof Error ? err.message : String(err);
      const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (msg.op === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET")))
        return { ok: true };
      throw err;
    }
    if (status !== 200) daemonRefused(msg.op, status, data);
    return data as Record<string, unknown>;
  }

  // ── prose ───────────────────────────────────────────────────────────────

  async function readBody(pos: string[], flags: Flags, verb: string): Promise<string> {
    const sources = [
      pos.length > 0,
      flags.stdin === true,
      typeof flags["body-file"] === "string",
    ].filter(Boolean).length;
    if (sources !== 1)
      die(
        sources === 0
          ? `${verb} needs text`
          : `${verb} takes its text from exactly one place: arguments, --stdin or --body-file`,
        "usage",
        {
          hint: "give the text as arguments, or prose through --body-file <path> / --stdin (never an unquoted heredoc)",
          choices: ["--stdin", "--body-file"],
        },
      );
    let text: string;
    if (flags.stdin === true) text = await new Response(Bun.stdin.stream()).text();
    else if (typeof flags["body-file"] === "string")
      text = readFileSync(flags["body-file"] as string, "utf8");
    else text = pos.join(" ");
    if (!text.trim()) die(`${verb}: the text is empty`, "usage");
    return text.trim();
  }

  // ── the verbs ───────────────────────────────────────────────────────────

  async function cmdOpen(pos: string[], flags: Flags): Promise<void> {
    const root = opts.sessionsRoot();
    // No home workspace: a new session opened on nothing shows the folder it
    // was opened in, as an ordinary entry (a set) the human sees and can
    // remove, never a hidden destination. Given paths, those are the session.
    const opening =
      noHome && pos.length === 0 && typeof flags.restore !== "string"
        ? openingFolder(process.cwd(), root, opts.appHome?.())
        : null;
    const paths = opening && "path" in opening ? [opening.path] : contextPaths(pos);

    if (typeof flags.restore === "string") {
      const id = flags.restore;
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id))
        die(`"${id}" is not a session id`, "usage", {
          hint: "a session id is the session_id that `open` printed",
        });
      if (!existsSync(join(root, id, "manifest.json"))) {
        const saved = restorable();
        die(`no saved session "${id}" under ${root}`, "not_found", {
          choices: saved.sort(),
          ...(saved.length === 0 ? { hint: "no saved sessions yet" } : {}),
        });
      }
      const live = readSession(id);
      if (live) {
        const alive = await api(live.port, "GET", "/state").then(
          (r) => r.status === 200,
          () => false,
        );
        if (alive)
          die(`session ${id} is already running at ${live.url}`, "conflict", {
            hint: `use it: state --session ${id}`,
          });
      }
    }

    const daemonArgs = [...opts.daemon.args];
    if (typeof flags.timeout === "string") daemonArgs.push("--timeout", flags.timeout);
    if (typeof flags.restore === "string") daemonArgs.push("--restore", flags.restore);
    // A new session's workspace is the folder holding the one folder it was
    // given, else where `open` ran, never a set's folder (`defaultWorkspace`).
    // None at all: the session's own `imported/`. A restored one keeps its own.
    // An app with no home workspace is given none.
    else if (!noHome) {
      const ws = defaultWorkspace(paths, process.cwd());
      if (ws !== undefined) daemonArgs.push("--workspace", ws);
    }

    if (opts.daemon.cwd !== undefined && !existsSync(opts.daemon.cwd))
      die(
        `${app} cannot start its daemon: the working directory it needs is missing: ${opts.daemon.cwd}`,
        "internal",
      );

    // The daemon's stderr goes to a log file, not to this CLI's stderr. An
    // inherited stderr outlives the CLI inside the detached daemon, so any caller
    // that reads `open`'s stderr to EOF (a test harness, a tool runner) waits for
    // the whole session. A file holds no pipe, and a start failure quotes its tail.
    const logDir = join(dirname(root), "logs");
    mkdirSync(logDir, { recursive: true });
    pruneLogs(logDir);
    const logFile = join(logDir, `daemon-${Date.now()}-${process.pid}.log`);
    daemonArgs.push("--log", logFile);

    const startTimeoutMs =
      typeof flags["start-timeout"] === "string"
        ? Math.max(5000, Number.parseInt(flags["start-timeout"], 10) * 1000)
        : 45000;

    type Handshake = {
      url: string;
      port: number;
      session_id: string;
      mode?: string;
      dir?: string;
      /** Where drops and new top-level documents land: what `open` names for the agent. */
      workspace?: string;
      ok?: boolean;
      status?: number;
      error?: string;
    };
    let hs: Handshake;
    try {
      ({ ready: hs } = await startDaemon<Handshake>({
        command: opts.daemon.command,
        args: daemonArgs,
        ...(opts.daemon.cwd ? { cwd: opts.daemon.cwd } : {}),
        env: opts.daemon.env ?? process.env,
        logFile,
        startTimeoutMs,
      }));
    } catch (err) {
      die(
        `${app} daemon failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "internal",
        { hint: `daemon log: ${logFile}` },
      );
    }
    if (hs.ok === false) daemonRefused("open", hs.status ?? 500, hs);

    let entries: unknown[] = [];
    if (paths.length > 0) {
      // The CLI's own act, not the agent's: no "agent listening" before a tail.
      const r = await postCmd(hs.session_id, { op: "context.add", paths }, { presence: false });
      entries = (r.entries as unknown[]) ?? [];
    }
    printJson({
      ...hs,
      ...(paths.length > 0 ? { entries } : {}),
      // The opening folder was not added, and why: the session starts empty.
      ...(opening && "skipped" in opening
        ? {
            entries: [],
            note: `nothing was added: ${opening.skipped}. Add a folder with \`add <folder>\``,
          }
        : {}),
    });

    if (!flags["no-open"]) {
      const opener =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      spawn(opener, [hs.url], { detached: true, stdio: "ignore" }).unref();
    }
  }

  async function cmdState(session: string | undefined, full: boolean): Promise<void> {
    const s = requireSession(session);
    const { status, data } = await api(s.port, "GET", `/state${full ? "?full=1" : ""}`);
    if (status !== 200) daemonRefused("state", status, data);
    printJson(data);
  }

  /** `workspace` alone prints it; `workspace <dir>` sets it (relative to the caller's cwd). */
  async function cmdWorkspace(dir: string | undefined, session: string | undefined): Promise<void> {
    if (dir === undefined) {
      const s = requireSession(session);
      const { status, data } = await api(s.port, "GET", "/state");
      if (status !== 200) daemonRefused("workspace", status, data);
      printJson({ workspace: (data as { workspace?: unknown }).workspace });
      return;
    }
    const abs = resolve(dir);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      die(`no such folder: ${abs}`, "not_found");
    }
    if (!st.isDirectory()) die(`the workspace must be a folder: ${abs}`, "usage");
    printJson(await postCmd(session, { op: "workspace.set", path: abs }));
  }

  /** `import <file>`: the file's text is sent, so the daemon writes a copy into the workspace folder. */
  async function cmdImport(
    file: string,
    session: string | undefined,
    into?: string,
  ): Promise<void> {
    // No home workspace: the copy goes where the caller points, or nowhere.
    if (noHome && into === undefined)
      die(
        `import: name the folder the copy goes in with --into <folder>: ${app} has no default folder`,
        "usage",
        { hint: locationHint(opts.app) },
      );
    const abs = resolve(file);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      die(`no such file: ${abs}`, "not_found");
    }
    if (st.isDirectory())
      die(`${abs} is a folder: a folder cannot be imported`, "usage", {
        hint: "add it with `add <folder>` instead",
      });
    if (!st.isFile() || !isDocName(abs))
      die(`not a document the workspace opens: ${abs}`, "usage", { choices: [...DOC_EXTENSIONS] });
    printJson(
      await postCmd(session, {
        op: "import",
        name: basename(abs),
        text: readFileSync(abs, "utf8"),
        ...(into !== undefined ? { dir: resolve(into) } : {}),
      }),
    );
  }

  /**
   * Whether the tail has already reported that it lost the daemon. Module scope
   * because a tail is one process doing one thing, and the two hooks that read it
   * are handed to a client that owns its own loop.
   */
  let disconnected = false;

  /**
   * The watch. Ends itself before Monitor's cap with one line naming the next
   * act (`../wire/tailHandoff.ts`): re-arm Monitor, go to a background `--once`,
   * or come back from a closed or lost session with `open --restore`. A `--since`
   * re-arm prints no grounding line: the agent already knows the session, and the
   * line would count as noise in the window's wake.
   */
  async function cmdTail(
    session: string | undefined,
    since: number,
    o: { once: boolean; all: boolean; sinceGiven: boolean; epoch?: string },
  ): Promise<number> {
    let boundId = session;
    const reArm = session !== undefined || o.sinceGiven;
    let grounded = o.sinceGiven;
    // `--all` rides every re-arm: a tail asked for the quiet events keeps asking.
    const pin = () => [
      ...(boundId !== undefined ? ["--session", boundId] : []),
      ...(o.all ? ["--all"] : []),
    ];
    return await tailWithHandoff<{ id?: number; epoch?: string; type?: string; by?: unknown }>(
      {
        resolve: () => {
          const s = readSession(boundId);
          if (!s) return null;
          if (!boundId) boundId = s.session_id;
          if (!grounded) {
            grounded = true;
            process.stdout.write(
              `${JSON.stringify({ type: "grounding", spell: app, session_id: s.session_id, port: s.port })}\n`,
            );
          }
          return `http://127.0.0.1:${s.port}`;
        },
        onUnresolved: ({ everResolved }) => {
          // A tail given --session or a bookmark is re-arming an existing
          // session, so not finding it means it closed (in the gap, say): the
          // handoff says `tail.closed`, never a silent retry-forever.
          if (everResolved || reArm) return "stop";
          process.stderr.write("# no session yet, retrying...\n");
          return "retry";
        },
        path: "/events",
        since,
        // Marks this reader as the agent's, so the surface can say one is listening.
        query: (cursor) => ({
          since: String(cursor),
          [AGENT_TAIL_PARAM]: "1",
          ...(o.once ? { [AGENT_ONCE_PARAM]: "1" } : {}),
          ...(o.all ? { [AGENT_ALL_PARAM]: "1" } : {}),
        }),
        ...(o.epoch ? { sinceEpoch: o.epoch } : {}),
        cursorOf: (ev) => (typeof ev.id === "number" ? ev.id : undefined),
        epochOf: (ev) => (typeof ev.epoch === "string" ? ev.epoch : undefined),
        // A different epoch on reconnect means the daemon restarted; ids began again.
        onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
        terminal: (ev) => ev.type === "closed",
        idleMs: TAIL_IDLE_MS,
        // A keepalive is proof of life, so it is also what clears a reported
        // disconnection. There is no `onConnect` hook and this is the honest
        // substitute: the daemon only sends comments down a live stream.
        onComment: () => {
          if (!disconnected) return `: ${app}-keepalive`;
          disconnected = false;
          return JSON.stringify({ type: "tail.reconnected" });
        },
        // One line per episode, not per attempt. The client reconnects with
        // backoff forever, so a hook that spoke every time would emit a line
        // every few seconds for as long as the daemon stayed down, which is how
        // a watcher gets muted. Without it a dead daemon and a quiet one are the
        // same thing from out here: a graceful close emits `closed` and ends the
        // tail, but a crash, a kill -9 or a sleeping laptop emits nothing.
        onDisconnect: ({ cause, status }) => {
          if (disconnected) return null;
          disconnected = true;
          return JSON.stringify({
            type: "tail.disconnected",
            cause,
            ...(status !== undefined ? { status } : {}),
            note: "retrying; the session may have closed or crashed",
          });
        },
      },
      {
        spell: app,
        mode: o.once ? "once" : "watch",
        presence: false,
        // The `closed` event says who ended it; `tail.closed` carries it as
        // `by`, and a human end tells the agent to stop and not reopen.
        closedBy: (ev) => (typeof ev.by === "string" ? ev.by : undefined),
        // A re-arm after the end never sees `closed`; the manifest's
        // `ended.by` is the same fact, and it outlives the daemon.
        goneBy: () => (boundId !== undefined ? endedBy(boundId) : undefined),
        commands: {
          tail: ({ since: at, once, epoch }) => tailCommand(["tail", ...pin()], at, once, epoch),
          comeBack: () => commandLine(["open", "--restore", boundId ?? "<id>", "--no-open"]),
        },
      },
    );
  }

  // ── the table ───────────────────────────────────────────────────────────

  const helpers: CliHelpers = {
    app,
    SESSION: ["session"],
    sessionOf: (inv) => (typeof inv.flags.session === "string" ? inv.flags.session : undefined),
    postCmd,
    requireSession,
    readBody,
    docArg,
    printJson,
  };

  type Row = Omit<CommandSpec<KitFlag | NoHomeFlag>, "run" | "rejectHint"> & {
    run: (pos: string[], flags: Flags, session: string | undefined) => unknown;
  };

  /** Adapt a `(pos, flags, session)` handler to the registry's `run(inv)`. */
  const on =
    (h: Row["run"]) =>
    (inv: Invocation<string>): unknown => {
      const flags = inv.flags as Flags;
      return h(inv.pos, flags, typeof flags.session === "string" ? flags.session : undefined);
    };

  const SESSION = ["session"] as const satisfies readonly KitFlag[];
  const withDoc = (flags: Flags) =>
    typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {};

  const ROWS: Row[] = [
    {
      name: "open",
      flags: ["no-open", "restore", "timeout", "start-timeout"],
      positionals: [{ name: "path", required: false, variadic: true }],
      describe: noHome
        ? "start a session (opens the browser), adding paths; with none, the current folder is added as a set; prints {url, port, session_id, entries}. --restore <id> brings a saved one back; --timeout <seconds> sets the idle close (default 1800); --timeout 0 stands until closed"
        : "start a session (opens the browser), adding paths; prints {url, port, session_id, workspace}; the workspace is the folder holding the one folder given, else the current folder, never a set's folder. --restore <id> brings a saved one back; --timeout <seconds> sets the idle close (default 1800); --timeout 0 stands until closed",
      run: (pos, flags) => cmdOpen(pos, flags),
    },
    {
      name: "add",
      flags: SESSION,
      positionals: [{ name: "path", required: true, variadic: true }],
      describe:
        "add files or folders to the context list (a document, an image, or a folder shown as a set)",
      run: async (pos, _flags, session) => {
        printJson(await postCmd(session, { op: "context.add", paths: contextPaths(pos) }));
      },
    },
    noHome
      ? {
          name: "import",
          flags: [...SESSION, "into"],
          positionals: [{ name: "file", required: true }],
          describe:
            "copy a document into --into <folder> (a set, or a folder in one) and show the copy (what dropping a file does); --into is required",
          run: (pos, flags, session) =>
            cmdImport(
              pos[0] as string,
              session,
              typeof flags.into === "string" ? flags.into : undefined,
            ),
        }
      : {
          name: "import",
          flags: SESSION,
          positionals: [{ name: "file", required: true }],
          describe:
            "copy a document into the workspace folder and show the copy (what dropping a file does)",
          run: (pos, _flags, session) => cmdImport(pos[0] as string, session),
        },
    // No home workspace, no `workspace` verb: there is nothing to print or set.
    ...(noHome
      ? []
      : [
          {
            name: "workspace",
            flags: SESSION,
            positionals: [{ name: "dir", required: false }],
            describe:
              "print the workspace (where drops and new top-level documents land), or set it to a folder",
            run: (pos, _flags, session) => cmdWorkspace(pos[0], session),
          } satisfies Row,
        ]),
    {
      name: "state",
      flags: [...SESSION, "full"],
      positionals: [],
      describe: "the session: context, docs and versions (with paths), tasks, selection, waiting",
      run: (_pos, flags, session) => cmdState(session, flags.full === true),
    },
    {
      name: "tail",
      flags: [...SESSION, "since", "once", "all"],
      positionals: [],
      describe:
        "the session's events (the human's messages with their selection, new tasks, notes) as JSON lines: wrap with Monitor; its last line names the next act. Events that ask nothing of you (the human opening a document) stay off it; --all includes them",
      run: (_pos, flags, session) => {
        const b = typeof flags.since === "string" ? parseTailSince(flags.since) : { since: -1 };
        return cmdTail(session, b.since, {
          once: flags.once === true,
          all: flags.all === true,
          sinceGiven: typeof flags.since === "string",
          ...(b.epoch ? { epoch: b.epoch } : {}),
        });
      },
    },
    {
      name: "say",
      flags: [...SESSION, "stdin", "body-file", "via"],
      positionals: [{ name: "text", required: false, variadic: true }],
      describe:
        'post a chat message from the agent (prose: --body-file <path> or --stdin). --via <gesture> says what it came through (default "chat", the kit\'s only one; an app adds its own): a value the app does not list is stored as sent, and the advisory is printed to stderr',
      run: async (pos, flags, session) => {
        const text = await readBody(pos, flags, "say");
        const via = typeof flags.via === "string" ? flags.via : undefined;
        const r = await postCmd(session, { op: "say", text, ...(via ? { via } : {}) });
        if (typeof r.warning === "string") process.stderr.write(`${r.warning}\n`);
        printJson(r);
      },
    },
    {
      name: "working",
      flags: [...SESSION, "for"],
      positionals: [],
      describe: "say you are still on it: silences the waiting nudge, keeps the human's pulse",
      run: async (_pos, flags, session) => {
        const seconds =
          typeof flags.for === "string" ? parseCount(flags.for, "working --for") : undefined;
        printJson(
          await postCmd(session, { op: "working", ...(seconds !== undefined ? { seconds } : {}) }),
        );
      },
    },
    {
      name: "version-new",
      flags: [...SESSION, "doc", "from", "label", "body-file", "stdin"],
      positionals: [],
      describe:
        "make a new version from another (--from vN, default: the active one) and print its path; its text is --body-file <path> or --stdin when given, else a copy to edit (text piped in without --stdin is refused, never dropped)",
      run: async (_pos, flags, session) => {
        const from =
          typeof flags.from === "string" ? parseVersion(flags.from, "--from") : undefined;
        const { body, silent } = await versionBody(flags);
        const r = await postCmd(session, {
          op: "version.new",
          ...withDoc(flags),
          ...(from !== undefined ? { from } : {}),
          ...(typeof flags.label === "string" ? { label: flags.label } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        // A pipe still open but silent was not read: said, so a slow writer's
        // text is never dropped without a word.
        printJson(silent ? { ...r, stdin: STDIN_SILENT } : r);
      },
    },
    {
      name: "activate",
      flags: [...SESSION, "doc"],
      positionals: [{ name: "vN", required: true }],
      describe:
        "make a version the active one (the one the human edits and Save writes); only when the human asks",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "activate",
            version: parseVersion(pos[0] ?? "", "activate"),
            ...withDoc(flags),
          }),
        );
      },
    },
    {
      name: "diff",
      flags: [...SESSION, "doc", "context", "patch"],
      positionals: [{ name: "against", required: true }],
      describe:
        "compare the active version with another (vN or 'saved' for the file on disk); --patch for plain unified text",
      run: async (pos, flags, session) => {
        const r = await postCmd(session, {
          op: "diff",
          against: parseSide(pos[0] ?? "", "diff"),
          ...withDoc(flags),
          ...(typeof flags.context === "string"
            ? { context: parseCount(flags.context, "--context") }
            : {}),
        });
        if (flags.patch) process.stdout.write(String(r.unified ?? ""));
        else printJson(r);
      },
    },
    {
      name: "merge",
      flags: [...SESSION, "doc", "hunks"],
      positionals: [{ name: "against", required: true }],
      describe:
        "take changes from another version into the active one (--hunks 1,3; default: all of them)",
      run: async (pos, flags, session) => {
        const against = parseSide(pos[0] ?? "", "merge");
        // Without --hunks this takes every hunk, which is the whole-document
        // merge. The ids come from `diff` and are only valid against the text it
        // saw: the daemon re-diffs and refuses ids it cannot find rather than
        // applying a number to a document that has moved underneath it.
        const listed =
          typeof flags.hunks === "string"
            ? flags.hunks.split(",").map((h) => parseCount(h, "--hunks"))
            : null;
        const hunks =
          listed ??
          (
            (await postCmd(session, { op: "diff", against, ...withDoc(flags) })) as {
              hunks?: { id: number }[];
            }
          ).hunks?.map((h) => h.id) ??
          [];
        printJson(await postCmd(session, { op: "merge", against, hunks, ...withDoc(flags) }));
      },
    },
    {
      name: "show",
      flags: [...SESSION, "doc", "hunk", "against", "quote", "heading"],
      positionals: [],
      describe:
        "scroll the human's view to a change (--hunk <id> from diff, --against vN or saved, default saved), a passage of the active version (--quote 'exact text'), or a heading (--heading 'its text', as a link's #anchor names it: the text, a GitHub slug, or Parent#Child for a repeated one); opens the document for them and says so in the chat",
      run: async (_pos, flags, session) => {
        const hunk = typeof flags.hunk === "string" ? parseCount(flags.hunk, "--hunk") : undefined;
        const quote = typeof flags.quote === "string" ? flags.quote : undefined;
        const heading = typeof flags.heading === "string" ? flags.heading : undefined;
        const named = [
          hunk !== undefined,
          quote !== undefined && quote.trim() !== "",
          heading !== undefined && heading.trim() !== "",
        ].filter(Boolean).length;
        if (named !== 1)
          die(
            "show: name one of --hunk <id> (a change), --quote '<exact text>' (a passage) or --heading '<heading>' (a heading)",
            "usage",
            {
              hint: "run: diff <vN|saved> (each hunk has an id)",
            },
          );
        if (typeof flags.against === "string" && hunk === undefined)
          die("show: --against goes with --hunk: a quote is found in the active version", "usage");
        printJson(
          await postCmd(session, {
            op: "show",
            ...withDoc(flags),
            ...(hunk !== undefined
              ? {
                  hunk,
                  against:
                    typeof flags.against === "string"
                      ? parseSide(flags.against, "--against")
                      : "original",
                }
              : heading !== undefined
                ? { heading }
                : { quote }),
          }),
        );
      },
    },
    {
      name: "version-delete",
      flags: [...SESSION, "doc"],
      positionals: [{ name: "vN", required: true }],
      describe: "remove a version and its file (never the active one: activate another first)",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "version.delete",
            version: parseVersion(pos[0] ?? "", "version-delete"),
            ...withDoc(flags),
          }),
        );
      },
    },
    {
      name: "note",
      flags: [...SESSION, "doc", "quote", "stdin", "body-file"],
      positionals: [{ name: "text", required: false, variadic: true }],
      describe:
        "note a passage of the active version (--quote 'exact text'; prose: --body-file or --stdin)",
      run: async (pos, flags, session) => {
        if (typeof flags.quote !== "string" || flags.quote.trim() === "")
          die("note: --quote is required: the exact text the note is about", "usage", {
            hint: "run: state (the active version's path is listed; quote from that file)",
          });
        printJson(
          await postCmd(session, {
            op: "note.add",
            quote: flags.quote,
            body: await readBody(pos, flags, "note"),
            ...withDoc(flags),
          }),
        );
      },
    },
    {
      name: "notes",
      flags: [...SESSION, "doc", "full"],
      positionals: [],
      describe:
        "the notes on a document, placed in the active version (--full includes resolved ones)",
      run: async (_pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "notes",
            ...(flags.full ? { all: true } : {}),
            ...withDoc(flags),
          }),
        );
      },
    },
    {
      name: "note-edit",
      flags: [...SESSION, "doc", "stdin", "body-file"],
      positionals: [
        { name: "id", required: true },
        { name: "text", required: false, variadic: true },
      ],
      describe:
        "rewrite what a note says; its passage stays (prose: --body-file or --stdin). Answers the note, as a reply does",
      run: async (pos, flags, session) => {
        const [id, ...text] = pos;
        printJson(
          await postCmd(session, {
            op: "note.edit",
            id: id as string,
            body: await readBody(text, flags, "note-edit"),
            ...withDoc(flags),
          }),
        );
      },
    },
    {
      name: "note-resolve",
      flags: [...SESSION, "doc", "reopen"],
      positionals: [{ name: "id", required: true }],
      describe: "mark a note dealt with (--reopen puts it back)",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "note.resolve",
            id: pos[0] as string,
            resolved: !flags.reopen,
            ...withDoc(flags),
          }),
        );
      },
    },
    {
      name: "task",
      flags: [...SESSION, "parent", "stdin", "body-file"],
      positionals: [{ name: "text", required: false, variadic: true }],
      describe:
        "say you have started something; prints the id to finish it with (--parent <id> when delegating for another task)",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "task.create",
            title: await readBody(pos, flags, "task"),
            ...(typeof flags.parent === "string" ? { parent: flags.parent } : {}),
          }),
        );
      },
    },
    {
      name: "task-status",
      flags: SESSION,
      positionals: [
        { name: "id", required: true },
        { name: "status", required: true, variadic: true },
      ],
      describe:
        "say what step a task is on (picks up a human's open task; for work worth watching)",
      run: async (pos, _flags, session) => {
        printJson(
          await postCmd(session, {
            op: "task.status",
            id: pos[0] as string,
            detail: pos.slice(1).join(" "),
          }),
        );
      },
    },
    {
      name: "task-done",
      flags: [...SESSION, "failed"],
      positionals: [
        { name: "id", required: true },
        { name: "outcome", required: false, variadic: true },
      ],
      describe:
        "mark a task finished, optionally saying what came of it (--failed marks it failed, and the words say why)",
      run: async (pos, flags, session) => {
        const outcome = pos.slice(1).join(" ").trim();
        printJson(
          await postCmd(session, {
            op: "task.done",
            id: pos[0] as string,
            ...(outcome ? { outcome } : {}),
            ...(flags.failed ? { failed: true } : {}),
          }),
        );
      },
    },
    {
      name: "task-cancel",
      flags: SESSION,
      positionals: [{ name: "id", required: true }],
      describe: "cancel a task you started or one the human asked for",
      run: async (pos, _flags, session) => {
        printJson(await postCmd(session, { op: "task.cancel", id: pos[0] as string }));
      },
    },
    {
      name: "new-doc",
      flags: SESSION,
      positionals: [{ name: "path", required: true }],
      describe: noHome
        ? "create an empty document at <path> (its folder must be a set or a folder in one)"
        : "create an empty document (its folder must be a set, a folder in one, or the workspace)",
      run: async (pos, _flags, session) => {
        const abs = resolve(pos[0] as string);
        printJson(
          await postCmd(session, { op: "doc.create", dir: dirname(abs), name: basename(abs) }),
        );
      },
    },
    {
      name: "new-folder",
      flags: SESSION,
      positionals: [{ name: "path", required: true }],
      describe: noHome
        ? "create a folder at <path> inside a set or a folder in one"
        : "create a folder inside a set, or in the workspace as a new set",
      run: async (pos, _flags, session) => {
        const abs = resolve(pos[0] as string);
        printJson(
          await postCmd(session, { op: "folder.create", dir: dirname(abs), name: basename(abs) }),
        );
      },
    },
    {
      name: "rename",
      flags: [...SESSION, "update-links"],
      positionals: [
        { name: "path", required: true },
        { name: "name", required: true },
      ],
      describe:
        "rename a document or folder in place; prints `broken`, the links the rename broke (each document, line, the link as written and as it would be written) (wiki links it broke under `wiki`, never rewritten), which `relink` updates, or with --update-links updates them in the same act and prints them as `links`",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "rename",
            path: resolve(pos[0] as string),
            name: pos[1] as string,
            ...(flags["update-links"] === true ? { updateLinks: true } : {}),
          }),
        );
      },
    },
    {
      name: "move",
      flags: [...SESSION, "update-links"],
      positionals: [
        { name: "path", required: true },
        { name: "into", required: true },
      ],
      describe:
        "move a document or folder into another folder (a real move on disk); prints `broken`, the links the move broke (wiki links it broke under `wiki`, never rewritten), which `relink` updates, or with --update-links updates them in the same act and prints them as `links`",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "move",
            path: resolve(pos[0] as string),
            into: resolve(pos[1] as string),
            ...(flags["update-links"] === true ? { updateLinks: true } : {}),
          }),
        );
      },
    },
    {
      name: "relink",
      flags: SESSION,
      positionals: [],
      describe:
        "update the links the last rename or move broke (its `broken`), each rewritten from its own document with its label, ?rel= and #anchor kept, as part of that act: one undo puts back both. Refused once anything else has changed the context's shape. A document open with unsaved edits keeps them, unsaved",
      run: async (_pos, _flags, session) => {
        printJson(await postCmd(session, { op: "relink" }));
      },
    },
    {
      name: "describe-image",
      flags: [...SESSION, "source", "label"],
      positionals: [{ name: "image", required: true }],
      describe:
        "start an image's description: writes its sidecar <image>.md beside it (type: image, --source user|web and that origin's fields, default user) and prints a new version's path to write the description into",
      run: async (pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "image.describe",
            image: resolve(pos[0] as string),
            ...(typeof flags.source === "string" ? { source: flags.source } : {}),
            ...(typeof flags.label === "string" ? { label: flags.label } : {}),
          }),
        );
      },
    },
    {
      name: "image-settings",
      flags: [...SESSION, "format", "quality", "max-side"],
      positionals: [],
      describe:
        "the app's image import settings, the same for every world: how an image the user drops or pastes in is written. With no flags, prints them; --format keep|webp, --quality 1-100 (WebP, and a JPEG made smaller), --max-side <px>|none (the longest side, never enlarged) set the ones given. The user's preference: change it only when they ask; the change is said in their chat",
      run: async (_pos, flags, session) => {
        printJson(
          await postCmd(session, {
            op: "image.settings",
            ...(typeof flags.format === "string" ? { format: flags.format } : {}),
            ...(typeof flags.quality === "string" ? { quality: flags.quality } : {}),
            ...(typeof flags["max-side"] === "string" ? { maxSide: flags["max-side"] } : {}),
          }),
        );
      },
    },
    {
      name: "search",
      flags: [...SESSION, "limit"],
      positionals: [{ name: "query", required: true, variadic: true }],
      describe:
        "search the context: fuzzy on document names, exact in text, reading each document's ACTIVE version (grep sees only the saved file); --limit n caps the results",
      run: async (pos, flags, session) => {
        const query = pos.join(" ").trim();
        if (query === "") die("search: the query is empty", "usage");
        const limit =
          typeof flags.limit === "string" ? parseCount(flags.limit, "search --limit") : undefined;
        if (limit === 0) die("search: --limit must be at least 1", "usage");
        printJson(
          await postCmd(session, {
            op: "search",
            query,
            ...(limit !== undefined ? { limit } : {}),
          }),
        );
      },
    },
    {
      name: "backlinks",
      flags: [...SESSION, "doc", "edge"],
      positionals: [],
      describe:
        "what links to a document or an image (--doc: a path, or the open one): each link's source, line, target as written and relations, read from each source's ACTIVE version; a bare link has rel [], an embed (![alt](x.png)) has embed: true; bundles lists apart the bundles it is on (an app's boards: name, noun, and each card's id, line, path as written and subpath), which are not canon; edges lists apart the app's own edges that land on it, when it adds any (edge: its kind, raw: the target as written, key: what carries it), counted in edgeCount, not count; --edge a,b keeps those edge kinds only (link: the body links)",
      run: async (_pos, flags, session) => {
        const edge = edgeList(flags.edge, "backlinks");
        printJson(
          await postCmd(session, { op: "backlinks", ...withDoc(flags), ...(edge ? { edge } : {}) }),
        );
      },
    },
    {
      name: "link-check",
      flags: [...SESSION, "edge"],
      positionals: [],
      describe:
        "check the session's links, in sections: dangling (file, line, the link as written, where it looked), unsupported (a scheme nothing here opens, like op:), duplicates (shared file names, each with a suggested rename, never applied), unusedImages (images in an images/ folder that no link or embed reaches, as an undone paste leaves them; never deleted), symmetry (hints: a relation the world's _relations.json declares symmetric, written one way only, the document linked to not linking back; never a problem), headings (links whose document opens but whose #anchor names no heading in it, a link that is only #heading read against its own document, each with the anchor decoded, the target and the nearest remaining heading, often the heading reworded; counted as problems), and ambiguousHeadings (hints: a bare #anchor naming a repeated heading, which lands on the first; write Parent#Child to name one); references (a bundle's references whose file is gone, an app's board cards: the bundle, the card's id, line, path as written, where it looked, and a sentence saying so; counted as problems); edges (the app's own edges that nothing answers, when it adds any: the edge's kind, the target as written, the key that carries it, where it looked; counted as problems); unusedImages, symmetry and ambiguousHeadings are kept out of count, which counts link problems only; --edge a,b keeps those edge kinds only (link: the body links' sections); reports, exits 0",
      run: async (_pos, flags, session) => {
        const edge = edgeList(flags.edge, "link-check");
        printJson(await postCmd(session, { op: "link.check", ...(edge ? { edge } : {}) }));
      },
    },
    {
      name: "graph",
      flags: [
        ...SESSION,
        "focus",
        "hops",
        "rel",
        "untyped",
        "kind",
        "kindless",
        "within",
        "limit",
        "bundles",
        "edge",
      ],
      positionals: [],
      describe:
        "the session's documents and the typed links between them: nodes (path, title, kind, the kind's label, canon, links in and out) and edges (from, to, rel, count; rel [] is an untyped link), read from each document's ACTIVE version. --focus <doc> centres on one, --hops n (0-3, default 1) says how far; --kind a,b keeps documents of those kinds (the matched profile's kind, else the frontmatter type) and drops the rest BEFORE the hop search, so a focus reaches only through those kinds, and documents with no kind go too unless --kindless; --rel a,b keeps links with those relations (--untyped keeps untyped ones too) and keeps every document, though a focus then reaches only along the kept links; --within <folder> keeps one folder; --limit n keeps the n best connected (at most 500). relations and untyped count the links in view before --rel, kinds the documents before --kind; total.links counts links, total.edges folded pairs; warnings says what in the filter matched nothing. --bundles adds the bundles whose type reads references (an app's boards) as nodes of their own kind, not canon (bundle: { noun }), with an edge marked reference: true to each file their cards point at. An app that adds edges of its own has them in edges too, marked edge: <kind> (frontmatter), with edgeKinds counting links per kind (link: the body links); --edge a,b keeps those kinds only",
      run: async (_pos, flags, session) => {
        const list = (v: FlagValue | undefined, what: string): string[] | undefined => {
          if (typeof v !== "string") return undefined;
          const names = v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
          if (names.length === 0) die(`graph ${what}: name at least one`, "usage");
          return names;
        };
        // Relations are read case-folded (`parseRel`), so a filter is too.
        const rel = list(flags.rel, "--rel")?.map((r) => r.toLowerCase());
        const kind = list(flags.kind, "--kind");
        const edge = edgeList(flags.edge, "graph");
        const hops =
          typeof flags.hops === "string" ? parseCount(flags.hops, "graph --hops") : undefined;
        if (hops !== undefined && hops > 3) die("graph --hops: at most 3", "usage");
        const limit =
          typeof flags.limit === "string" ? parseCount(flags.limit, "graph --limit") : undefined;
        if (limit === 0) die("graph --limit: must be at least 1", "usage");
        printJson(
          await postCmd(session, {
            op: "graph",
            ...(typeof flags.focus === "string" ? { focus: docArg(flags.focus) } : {}),
            ...(hops !== undefined ? { hops } : {}),
            ...(rel ? { rel } : {}),
            ...(flags.untyped === true ? { untyped: true } : {}),
            ...(kind ? { kind } : {}),
            ...(flags.kindless === true ? { kindless: true } : {}),
            ...(typeof flags.within === "string" ? { within: resolve(flags.within) } : {}),
            ...(limit !== undefined ? { limit } : {}),
            ...(flags.bundles === true ? { bundles: true } : {}),
            ...(edge ? { edge } : {}),
          }),
        );
      },
    },
    {
      name: "profiles",
      flags: SESSION,
      positionals: [],
      describe:
        "the world's document profiles (_meta/profiles/<kind>.json, the nearest folder's file winning per kind): each kind with its label and canon (false for a kind the world marks not canon), the file it came from and how many documents match it (and how many of those have warnings), the frontmatter types no profile defines, how many documents have no type, and broken profile files with why",
      run: async (_pos, _flags, session) => {
        printJson(await postCmd(session, { op: "profiles" }));
      },
    },
    {
      name: "profile",
      flags: [...SESSION, "doc"],
      positionals: [],
      describe:
        "how one document (--doc: a path, or the open one) matched a profile: its type, kind and canon, the profile's label and the file it came from, its warnings (each with a fix in words), and the fields the profile expects with each one's rule and description; when nothing matched, why; read from its ACTIVE version",
      run: async (_pos, flags, session) => {
        printJson(await postCmd(session, { op: "profile", ...withDoc(flags) }));
      },
    },
    {
      name: "profile-check",
      flags: SESSION,
      positionals: [],
      describe:
        "every profile warning in the session (file, field, rule, what is wrong and a fix in words), read from each document's ACTIVE version, and every broken profile file with why; a warning never blocks a save; reports, exits 0",
      run: async (_pos, _flags, session) => {
        printJson(await postCmd(session, { op: "profile.check" }));
      },
    },
    {
      name: "relations",
      flags: SESSION,
      positionals: [],
      describe:
        "the world's relation vocabulary (_meta/profiles/_relations.json, the nearest file winning per relation) and how the links use it: files (each vocabulary file, broken ones with why and the line and column), declared (each relation with its label, means, symmetric, inverse, color, the file and how many links use it there), undeclared (relations links use where a vocabulary is in force but does not declare them), used (every relation in use, by count); a broken file defines nothing until fixed",
      run: async (_pos, _flags, session) => {
        printJson(await postCmd(session, { op: "relations" }));
      },
    },
    {
      name: "reveal",
      flags: SESSION,
      positionals: [{ name: "path", required: true }],
      describe:
        "show a path in the file manager; only the session folder and what the context shows, anything else is not_found",
      run: async (pos, _flags, session) => {
        printJson(await postCmd(session, { op: "reveal", path: resolve(pos[0] as string) }));
      },
    },
    {
      name: "doctor",
      flags: SESSION,
      positionals: [],
      describe: "what is worth looking at in this session, each finding saying what to do",
      run: async (_pos, _flags, session) => {
        printJson(await postCmd(session, { op: "doctor" }));
      },
    },
    {
      name: "close",
      flags: SESSION,
      positionals: [],
      describe: "shut the session down (the manifest stays, for open --restore)",
      run: async (_pos, _flags, session) => {
        await postCmd(session, { op: "close" });
        printJson({ ok: true, sent: "close" });
      },
    },
  ];

  /** `help <verb>`'s line for the flag every session verb takes. */
  const SESSION_HELP = { session: "the session to talk to (default: the most recent)" };
  const kitCommands = ROWS.map(
    (r) =>
      ({
        ...r,
        run: on(r.run),
        rejectHint: DASH_HINT,
        flagHelp: SESSION_HELP,
      }) as unknown as CommandSpec<string>,
  );
  const appCommands = (opts.commands?.(helpers) ?? []).map((c) => ({
    ...c,
    flagHelp: { ...SESSION_HELP, ...c.flagHelp },
    rejectHint: c.rejectHint ?? DASH_HINT,
  }));

  // Building the table has no side effects: `defineCli` only validates and
  // indexes, so a test can import an app's CLI and read the table.
  const cli = defineCli({
    name: app,
    ...(opts.summary ? { summary: opts.summary } : {}),
    options,
    commands: [...kitCommands, ...appCommands],
    // `<app> --session x state` runs `state`; a bare `--` makes the next token
    // the verb.
    grammar: "flags-anywhere",
    verbPositional: "verb",
    usageHides: ["session"],
    version: opts.version,
    helpFooter: `  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row.

  Output: JSON on stdout, one document per answer, except tail (one JSON line
  per event) and help (prose). Failures: one JSON envelope on stderr, exit
  2 = usage, 1 = internal, 5 = not found, 6 = conflict. tail waits for a
  session rather than failing, and ends 0 when its session closes. tail
  ${WINDOW_HELP}.${opts.helpFooter ? `\n\n${opts.helpFooter}` : ""}`,
  });

  // `dispatch`, not the registry's `main`: the kit does not triage a
  // non-CliError; this does. A named file that is not there (--body-file) is the
  // caller's; everything else is ours.
  async function run(argv: string[]): Promise<number> {
    try {
      return await cli.dispatch(argv);
    } catch (e) {
      const reported = reportCliError(e);
      if (reported !== null) return reported;
      const code =
        e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
      const msg = e instanceof Error ? e.message : String(e);
      if (code === "ENOENT") return reportCliError(new UsageError(msg)) ?? 2;
      return reportCliError(new CliError("internal", msg)) ?? 1;
    }
  }

  return Object.assign(cli, { run });
}
