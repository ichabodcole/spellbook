/**
 * The CLI's argument parsing: the kit's flags (`KIT_OPTIONS`,
 * `NO_HOME_OPTIONS`), the usage refusal, `version-new`'s body, and the
 * readers that turn a token into a version, a count, seconds, an edge list,
 * a comparison side, a path or a session's paths and workspace. No daemon and
 * no network; a few read stdin or the filesystem (`versionBody`, `pathArg`,
 * `contextPaths`, `defaultWorkspace`). Part of the CLI's start path, so it
 * imports only what
 * `../verbs.ts` imports; `verbs.ts` re-exports every name it exported before.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { FlagValue, OptionsTable } from "../../cli/registry";
import {
  IMAGE_EXTENSIONS,
  isHeicName,
  isImageName,
  isSvgName,
  SVG_REFUSED,
} from "../../lib/docFormat.ts";
import { homeDir } from "../../lib/home.ts";
import { CliError, die } from "../../wire/errors";
import { readSeconds } from "../../wire/housekeeping";
import { stdinWaiting } from "../../wire/stdinPeek";
import { readSince } from "../../wire/tailHandoff";
import { notAddedWhole } from "../noHome";
import type { DiffSide } from "../protocol";
import { docExtensions, isDocName } from "../tree";

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
export type NoHomeFlag = keyof typeof NO_HOME_OPTIONS;
export type Flags = Record<string, FlagValue | undefined>;

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
export async function versionBody(flags: Flags): Promise<{ body?: string; silent?: true }> {
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
 * A seconds flag on `open` (`--timeout`, `--start-timeout`), read before any
 * daemon starts: absent is undefined, anything that is not a number of
 * seconds is a `usage` refusal (`readSeconds`), never a NaN handed on. `max`,
 * when given, is refused above too (a wait that becomes one timer).
 */
export function flagSeconds(
  v: FlagValue | undefined,
  flag: string,
  hint: string,
  max?: number,
): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string")
    die(`open ${flag}: give it once, as a number of seconds`, "usage", { hint });
  const r = readSeconds(v);
  if (!r.ok) die(`open ${flag}: ${r.message}`, "usage", { hint });
  if (max !== undefined && r.seconds > max)
    die(`open ${flag}: ${r.seconds} seconds is longer than the longest wait (${max})`, "usage", {
      hint,
    });
  return r.seconds;
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
/**
 * Whether a file-system error is about a path the caller wrote on the command
 * line: its `path` is one of the arguments (or a `--flag=value`'s value), as
 * written or made absolute against the cwd.
 */
export function callerNamed(argv: readonly string[], e: unknown): boolean {
  const path = e && typeof e === "object" && "path" in e ? (e as { path: unknown }).path : null;
  if (typeof path !== "string" || path === "") return false;
  for (const arg of argv) {
    const value = arg.startsWith("--") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if (value === "" || value.startsWith("--")) continue;
    if (value === path || resolve(value) === resolve(path)) return true;
  }
  return false;
}

export function docArg(token: string): string {
  if (token.includes("/") || existsSync(resolve(token))) return resolve(token);
  return token;
}

/**
 * A path argument made absolute against the caller's cwd, with a literal `~`
 * refused. A shell expands an unquoted leading `~` before the CLI runs, so a
 * `~` that arrives (quoted, or from a script) was not meant as a folder named
 * `~`: resolving it against the cwd made `add-folder "~"` create one there.
 * It is refused, as a path the caller did not mean, with the expanded path in
 * the hint; nothing is resolved or created. A `~` later in a path is a name.
 */
export function pathArg(token: string, verb: string): string {
  if (token === "~" || token.startsWith("~/")) {
    const meant = token === "~" ? homeDir() : join(homeDir(), token.slice(2));
    // A file or folder really named `~` here is reached as `./~`: said when
    // there is one, since that may be what was meant.
    const here = existsSync(resolve(token))
      ? `; for the ${resolve(token)} here, write ./${token}`
      : "";
    die(
      `${verb}: "${token}" arrived with its ~ unexpanded (quoted, or from a script): nothing was done`,
      "usage",
      {
        hint: `write the full path (${meant}), or leave the ~ unquoted for the shell to expand${here}`,
      },
    );
  }
  return resolve(token);
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
export function contextPaths(pos: string[], verb = "add"): string[] {
  const paths = pos.map((p) => pathArg(p, verb));
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
        choices: [...docExtensions(), ...IMAGE_EXTENSIONS],
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
