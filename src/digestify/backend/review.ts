#!/usr/bin/env bun

// digestify review — Bun port (sibling to review.py).
//
// Reads markdown from stdin or --file, parses :::question fences, serves a
// local HTTP page that renders the markdown with question fields and inline
// comment widgets, blocks until the user submits, then prints
// {answers, comments, submitted_at} JSON to stdout.
//
// Exit codes — TWO POPULATIONS, and the split is the contract (D58):
//
//   FAILURES, raised through `src/kit/wire/errors.ts` as ONE JSON envelope on
//   stderr, with `kind` to route on and stdout left empty:
//     2   usage      — a bad flag, a bad --theme, a malformed :::question
//                      fence, or nothing to review
//     5   not_found  — --file/--reference names a path that is not there, or a
//                      forced dev boot cannot find the surface source
//     6   conflict   — the review server could not bind (recovery re-binds the
//                      port in the session id, and the old daemon may hold it)
//     1   internal   — nothing raises this deliberately; an unknown throw ends
//                      the process here with its stack, as it always did
//
//   SESSION OUTCOMES, returned rather than raised, each with an observation
//   line on STDOUT and no envelope. They are OUTSIDE the taxonomy:
//     0   submitted successfully
//     124 idle timeout
//     130 user closed the tab after interacting
//
// Contract intentionally mirrors review.py so the same tests and agent-facing
// behavior apply. See review.py for prose-level commentary on edge cases —
// repeated here only where the implementation differs.
//
// ⚠ The shared SURFACE is gone from that sentence as of 2026-09-07: the page
// both scripts used to serve, `scripts/template.html`, is now a React surface
// at src/digestify/surface/ built into dist/. review.py, if it is ever run
// again, serves nothing.

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { die, reportCliError, setCurrentCommand } from "../../kit/wire/errors.ts";
import { shouldIdleClose } from "../../kit/wire/housekeeping.ts";
import { resolveMode as resolveModeIn, serveFromDist } from "../../kit/wire/serveDist.ts";

// The review page used to be `scripts/template.html`, read at boot and string
// substituted before every response. It is now a React surface at
// src/digestify/surface/, built into dist/ (seams Contract 2). The dev entry is
// a DYNAMIC import reached only on the dev branch: a static one would force Bun
// to resolve the whole .tsx + Tailwind graph when this module LOADS, so the
// published artifact — which ships dist/ and no surface source — would die
// before it could serve the dist it does have (Contract 1).
//
// Paths anchor at the SKILL ROOT, never at cwd: this script is invoked by the
// agent from wherever the conversation happens to be.
//
// ⛔ AND SINCE PHASE 5 THE ONLY ADDRESS THAT ARITHMETIC IS TRUE AT IS THE
// ARTIFACT — `<skill>/dist/review.js`, which the launcher at
// `<skill>/scripts/review.ts` imports. `SCRIPT_DIR` is therefore `<skill>/dist`,
// `SKILL_ROOT` is `<skill>`, and everything below derives from it: `DIST_DIR`,
// the assets directory, `DEV_SURFACE_CWD`, and the dev surface import's five
// `..`. From THIS source file's own directory (`src/digestify/backend/`) every
// one of them is wrong, which is why there is no `import.meta.main` block at
// the foot of the file — see `run()` and D57. `grimoire/spawn-path-ward.test.ts`
// is the instrument: it resolves these from the EMITTED file's directory, the
// way the runtime will.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// release iff dist/index.html exists at the skill root — the FILE, never the
// directory (a built backend can put review.js in dist/ with no surface there)
// — else dev; the env override wins either way (Contract 1). Release: zero
// reads of surface source or bunfig.toml, static files only.
//
// DE-DUPLICATED at Phase 5: the body is now `src/kit/wire/serveDist.ts`'s, which
// the census measured as byte-identical across all eight daemons (the only md5
// difference being the `export` keyword). The zero-argument wrapper is the house
// shape — glamour, imago and bounty all keep one — because this spell's callers
// ask the question about ITS dist, and passing the directory at every call site
// is a second place to get it wrong.
export function resolveMode(): "dev" | "release" {
  return resolveModeIn(DIST_DIR);
}

/** What a dev-mode cwd's bunfig.toml must load, or the stylesheet never
 *  compiles. Named once; the guard and its error message share it. */
const TAILWIND_PLUGIN = "bun-plugin-tailwind";

/** Where the dev bundler's HTML lives. Never "/" — see the "/" handler. */
const DEV_SURFACE_ROUTE = "/__surface";

/**
 * Serves `dist/` verbatim EXCEPT its entry: the hashed `index-*.js` /
 * `index-*.css` that `index.html` links RELATIVELY, which from "/" arrive as
 * bare filenames (Contract 2's flat layout).
 *
 * ⛔ **THE `index.html` REFUSAL IS DIGESTIFY'S AND THE KIT DOES NOT CARRY IT.**
 * `serveFromDist` decides whether a file may be READ — its guards are
 * empty / `..` / nested only — and the CALLER decides WHICH file. The house
 * caller is `path === "/" ? "index.html" : path.slice(1)`, and that expression
 * is exactly what this spell must never write: `/` here returns
 * `substitute(source)`, the built HTML with the review payload injected in
 * memory. Handing the entry document to the kit would serve the committed
 * `dist/index.html` UNSUBSTITUTED — a page that renders with no questions in
 * it, at HTTP 200, with nothing red anywhere — and even leaving the router
 * alone, a verbatim adoption would leave `GET /index.html` answering that same
 * unsubstituted document, because the refusal being deleted is this file's and
 * not the kit's. So the name check stays HERE, one line above the call, and
 * `src/digestify/backend/release-serve.test.ts` drives both routes in release
 * mode rather than reading them.
 *
 * ⚠ The nesting guard is the KIT's now, and it is what keeps this serve clear
 * of the review's own `/assets/<name>` route (all nested, all refused here).
 * Same rule, one owner.
 */
function serveDist(path: string): Response | null {
  const rel = path.slice(1);
  if (rel === "index.html") return null;
  return serveFromDist(DIST_DIR, rel);
}

type Question = { id: string; prompt: string };
type Payload = {
  title: string;
  theme: string;
  markdown: string;
  questions: Question[];
  session_id: string;
  timeout_seconds: number;
};

// Protocol — what the browser POSTs to /submit and what we emit to stdout.
type SubmitBody = {
  answers?: Record<string, unknown>;
  comments?: unknown[];
};
type DoneResult = { code: number; data: SubmitBody | null };

const QBLOCK_RE = /^:::\s*question([^\n]*)\n([\s\S]*?)\n:::\s*$/gm;
const ID_RE = /\bid\s*=\s*([A-Za-z0-9_-]*)/;
const PORT_SUFFIX_RE = /-p(\d{2,5})$/;
const VALID_THEMES = ["digestify", "cthulhu", "classic"] as const;

function parseQuestions(markdown: string): { transformed: string; questions: Question[] } {
  const questions: Question[] = [];
  const seen = new Set<string>();
  const transformed = markdown.replace(QBLOCK_RE, (_m, attrs: string, body: string) => {
    const idMatch = (attrs || "").match(ID_RE);
    if (!idMatch?.[1]) {
      throw new Error("question block missing or has empty id; expected '::: question id=<name>'");
    }
    const qid = idMatch[1];
    if (seen.has(qid)) throw new Error(`duplicate question id: '${qid}'`);
    seen.add(qid);
    const bodyTrim = body.trim();
    if (!bodyTrim) throw new Error(`question id='${qid}' has empty body`);
    questions.push({ id: qid, prompt: bodyTrim });
    // Surround with blank lines so marked treats this as a self-contained
    // type-6 HTML block (CommonMark) — without the trailing blank line the
    // raw HTML swallows the next heading/paragraph.
    return `\n\n<div data-qblock="${qid}"></div>\n\n`;
  });
  return { transformed, questions };
}

function buildPayload(
  markdown: string,
  opts: { title: string; theme: string; sessionId: string; timeout: number },
): Payload {
  const { transformed, questions } = parseQuestions(markdown);
  return {
    title: opts.title,
    theme: opts.theme,
    markdown: transformed,
    questions,
    session_id: opts.sessionId,
    timeout_seconds: opts.timeout,
  };
}

function parsePortFromSessionId(sid: string): number | null {
  if (!sid) return null;
  const m = sid.match(PORT_SUFFIX_RE);
  if (!m) return null;
  const port = parseInt(m[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

async function readStdinWithTimeout(ms = 100): Promise<string> {
  // Mirrors the select()-with-tiny-window guard in review.py — agent harnesses
  // can leave stdin open-but-empty, and a naive read would hang forever.
  if (process.stdin.isTTY) return "";
  const reader = Bun.stdin.stream().getReader();
  try {
    const TIMEOUT = Symbol("timeout");
    const timer = new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), ms));
    const first = await Promise.race([reader.read(), timer]);
    if (first === TIMEOUT) return "";
    if (first.done) return "";
    const chunks: Uint8Array[] = [first.value];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    let total = 0;
    for (const c of chunks) total += c.byteLength;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function readInput(args: { reference?: string; file?: string }): Promise<string> {
  let referenceContent = "";
  let refLabel = "";
  if (args.reference) {
    referenceContent = await Bun.file(args.reference).text();
    refLabel = basename(args.reference);
  }

  let agentContent = await readStdinWithTimeout(100);
  if (!agentContent && args.file) {
    agentContent = await Bun.file(args.file).text();
  }

  const parts: string[] = [];
  if (referenceContent.trim()) {
    parts.push(`> Reference: \`${refLabel}\`\n\n${referenceContent.replace(/\s+$/, "")}`);
  }
  if (agentContent.trim()) {
    if (parts.length > 0) {
      // Styled boundary marker with HTML-escaped reference filename so the
      // template can render "end of <filename>" without attribute injection.
      const labelAttr = htmlEscape(refLabel);
      parts.push(
        `<div data-refboundary="${labelAttr}"></div>\n\n${agentContent.replace(/\s+$/, "")}`,
      );
    } else {
      parts.push(agentContent.replace(/\s+$/, ""));
    }
  }
  return parts.join("\n\n");
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best-effort */
  }
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isoZNoMillis(d: Date): string {
  // Match Python's strftime("%Y-%m-%dT%H:%M:%SZ") — no fractional seconds.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

function guessMime(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/**
 * The review itself. Every failure below RAISES through `die` rather than
 * returning a number — see `main`, which is the one place a `CliError` becomes
 * an exit code.
 */
async function runReview(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        file: { type: "string" },
        reference: { type: "string" },
        title: { type: "string", default: "Document Review" },
        theme: { type: "string", default: "digestify" },
        timeout: { type: "string", default: "1800" },
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        id: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    // A bad flag is the most ordinary failure this entry has, and it is the
    // caller's to fix by changing the command — `usage`, which the taxonomy
    // already exits 2 for, so this site changes its ENVELOPE and not its code.
    die(e instanceof Error ? e.message : String(e), "usage");
  }
  const v = parsed.values;
  const theme = v.theme as string;
  if (!VALID_THEMES.includes(theme as (typeof VALID_THEMES)[number])) {
    // `choices` is what the envelope adds that the prose could only imply: the
    // set that WOULD have been accepted, as data rather than inside a sentence.
    die(`invalid --theme '${theme}'`, "usage", { choices: [...VALID_THEMES] });
  }
  const timeout = parseFloat(v.timeout as string);
  let port = parseInt(v.port as string, 10);
  const host = v.host as string;
  let sessionId = (v.id as string | undefined) ?? "";

  // Honor the port baked into an auto-generated session id (relaunch case).
  if (port === 0 && sessionId) {
    const embedded = parsePortFromSessionId(sessionId);
    if (embedded !== null) port = embedded;
  }

  let markdown: string;
  try {
    markdown = await readInput({
      file: v.file as string | undefined,
      reference: v.reference as string | undefined,
    });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      const path = "path" in e ? e.path : undefined;
      // ⚠ A CODE CHANGE, 2 → 5, AND IT IS THE ONE THING HERE A CALLER CAN
      // OBSERVE WITHOUT PARSING ANYTHING. `--file` or `--reference` naming a
      // path that is not there is `not_found` — the named thing does not exist
      // — which is a different act of repair from a malformed command, and
      // collapsing the two into 2 left an agent with nothing to route on. Same
      // ruling `join.ts` took for its missing discovery file (D52). SKILL.md's
      // exit-code table carries the row.
      die(`file not found: ${path ?? "<unknown>"}`, "not_found");
    }
    // ⛔ NOT SWALLOWED. An unknown read failure is not a taxonomy failure, and
    // reporting it as one would lose the stack that says what actually broke.
    throw e;
  }
  if (!markdown.trim()) {
    die("no markdown provided on stdin, --file, or --reference", "usage", {
      hint: "pipe the document on stdin, or pass --file PATH / --reference PATH",
    });
  }

  // Build payload with a placeholder session_id; finalize after we know the
  // bound port (we need the port to encode it into the auto-generated id).
  let payload: Payload;
  try {
    payload = buildPayload(markdown, {
      title: v.title as string,
      theme,
      sessionId: sessionId || "__TBD__",
      timeout,
    });
  } catch (e) {
    // A malformed `::: question` fence — a missing id, a duplicate id, an empty
    // body. The markdown is the caller's argument, so this is `usage` at 2.
    die(e instanceof Error ? e.message : String(e), "usage");
  }

  // Resolved BEFORE the server binds and before anything is written, so a
  // forced-dev boot at a surface-free destination dies HERE, having done
  // nothing.
  const mode = resolveMode();

  // ⛔ CONTRACT 5 LANDS ON WHOEVER SPAWNS THE DAEMON — AND NOTHING SPAWNS THIS
  // ONE. Every other ported spell has a `cli.ts` that pins the daemon's cwd to
  // src/<spell>/ so Bun can read that directory's bunfig.toml and load the
  // Tailwind plugin. Digestify's daemon IS the process the agent runs, from
  // whatever directory the conversation is in, so there is no spawner to pin.
  //
  // And `process.chdir()` does not rescue it: MEASURED 2026-09-07 — Bun reads
  // bunfig.toml at process START, so chdir-then-import bundles the page, serves
  // it, and fails to parse `@import "tailwindcss" source(none)` at request time.
  // The page comes back unstyled with a green build and no error on the daemon.
  //
  // So the daemon checks its own cwd and REFUSES, loudly, naming the directory.
  // A hard exit is the right shape: the alternative is the silent-unstyled
  // defect four spells' comments describe and nobody had run.
  const DEV_SURFACE_CWD = join(SKILL_ROOT, "..", "..", "..", "..", "src", "digestify");
  let devIndex: unknown;
  if (mode === "dev") {
    // ⛔ THE TEST IS "DOES THIS bunfig LOAD THE TAILWIND PLUGIN", NOT "IS THERE
    // A bunfig". The first draft asked only whether the file existed, and the
    // REPO ROOT has one — an `[install] linker` pin with no plugins in it. From
    // there the daemon booted happily, announced `mode:"dev"`, and served Bun's
    // own `<title>Bun - Build Failed</title>` page: a green boot over a page
    // that never renders, which is Contract 5's scar wearing new clothes. And
    // the repo root is the likeliest cwd an agent actually has.
    const bunfig = join(process.cwd(), "bunfig.toml");
    const loadsTailwind =
      existsSync(bunfig) && readFileSync(bunfig, "utf8").includes(TAILWIND_PLUGIN);
    if (!loadsTailwind) {
      // ⛔ THE DIAGNOSTIC SURVIVES THE ENVELOPE, IT DOES NOT SHRINK INTO IT.
      // Every line below was earned, and `hint` is the field that exists so a
      // structured failure can still say the operator's whole sentence. ⚠ AND
      // THE HINT NAMES A DIRECTORY COMPUTED FROM THIS FILE'S OWN ANCHOR — which
      // is precisely the message D57 caught lying when the anchor was wrong.
      // It is true only because this module ships at `dist/`; the ward, not the
      // message, is what holds that.
      die("digestify: cannot start in dev mode from this directory", "usage", {
        hint:
          `cwd: ${process.cwd()}\n` +
          `needed: a cwd whose bunfig.toml loads ${TAILWIND_PLUGIN} — in a checkout of ` +
          `this repo that is ${DEV_SURFACE_CWD}\n` +
          "why: Bun reads bunfig.toml from the process cwd, at STARTUP — chdir is too " +
          "late. Without the plugin the stylesheet never compiles and the page is served " +
          "unstyled, or as Bun's own build-failure page, with nothing red anywhere.\n" +
          "A published spell ships a built dist/ and resolves to release mode; dev mode " +
          "needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from that directory.",
      });
    }
    try {
      devIndex = (await import("../../../../../src/digestify/surface/index.html")).default;
    } catch (e) {
      // ⛔ THE FAILURE MUST NAME THE SURFACE. A forced-dev boot at a
      // surface-free destination otherwise dies with a module-resolution error
      // the operator cannot tell from a missing `bun`.
      //
      // ⚠ A CODE CHANGE, 2 → 5. The named thing — `src/digestify/surface/
      // index.html` — does not exist, which is `not_found` and not a malformed
      // command; the caller's repair is to fetch a checkout, not to retype the
      // invocation. The sibling refusal above stays `usage` at 2 because there
      // the cwd IS the argument.
      die("digestify: cannot start in dev mode — the surface source is missing", "not_found", {
        hint:
          "needed: src/digestify/surface/index.html (relative to the repo root)\n" +
          `reason: ${e instanceof Error ? e.message : String(e)}\n` +
          "A published spell ships a built dist/ and resolves to release mode; dev mode " +
          "needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.",
      });
    }
  }

  // The page's HTML SOURCE, before substitution. In release it is the committed
  // dist/index.html, read once. In dev it is whatever Bun's bundler produces,
  // fetched from this same server's private surface route at request time (see
  // the "/" handler) — the bundler owns the response and there is no way to ask
  // it for the text directly.
  const releaseTemplate =
    mode === "release" ? await Bun.file(join(DIST_DIR, "index.html")).text() : "";
  // Derived from the explicit SKILL_ROOT rather than re-counted from
  // SCRIPT_DIR. Same directory, and it was the same directory before the
  // relocation too — but a `..` counted at a second site is the repair that
  // rots (playbook Phase B, B6), and this is the spell's other path-pinned
  // sibling: the wordmarks, mascots and sent-page illustrations under
  // `<skill>/assets/`, which are NOT build inputs and are served by the
  // `/assets/` route below.
  const assetsDir = join(SKILL_ROOT, "assets");

  // The substitution the page's whole state arrives through. Applied to the
  // BUILT html IN MEMORY at serve time, so dist/ stays byte-stable and
  // Contract 18's reproduction check is unaffected.
  //
  // ⚠ NEITHER REPLACE IS GLOBAL, and that is the shipped behaviour: only the
  // FIRST occurrence of each token is substituted. index.html carries each
  // exactly once (asserted by scripts/release-serve.test.ts).
  let substitute: (html: string) => string = (html) => html;
  let heartbeatAt = performance.now();
  // b4 — what the surface told us about the human's departure, and whether the
  // page was ever served at all. Both are RECORDS, not resolutions: neither ends
  // the session (see POST /left).
  type Departure = {
    engaged: boolean;
    elapsedMs: number | null;
    answered: number | null;
    commented: number | null;
    /** True when the beacon named a session that is not this one — a tab left
     *  over from a review this daemon replaced on the same re-bound port. The
     *  fact is still worth recording; it just must not end the session. */
    stale: boolean;
  };
  let departure: Departure | null = null;
  let pageServed = false;

  let resolveDone!: (val: DoneResult) => void;
  const done = new Promise<DoneResult>((res) => {
    resolveDone = res;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      // Dev only, and deliberately NOT "/": the bundler would then own the
      // response and the payload could never be injected. "/" stays this
      // module's, and reads the bundle through here.
      routes: (devIndex ? { [DEV_SURFACE_ROUTE]: devIndex } : {}) as Record<string, never>,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (method === "GET" && path === "/") {
          // b4 — the ONE observable that separates "nobody ever opened it" from
          // "opened and then went quiet". Without it those two are the same
          // timeout, which is half of what made a cancelled review unreportable.
          pageServed = true;
          // Dev: ask this same server's private surface route for the bundler's
          // HTML, then substitute. Bun owns the HTMLBundle response and offers
          // no way to read it as text, and the payload MUST be injected (a
          // GET /payload route would be new behaviour and a new failure mode).
          // Release: the committed dist/index.html, read once at boot.
          const source =
            mode === "dev"
              ? await (await fetch(`http://${host}:${server.port}${DEV_SURFACE_ROUTE}`)).text()
              : releaseTemplate;
          return new Response(substitute(source), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        if (method === "GET" && mode === "release") {
          const asset = serveDist(path);
          if (asset) return asset;
        }
        if (method === "GET" && path.startsWith("/assets/")) {
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          // Path-traversal guard. The Python version uses resolve()+parents
          // containment; refusing any ".." segment achieves the same goal
          // here and avoids needing realpath.
          if (assetName.includes("..") || assetName.startsWith("/")) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          const f = Bun.file(join(assetsDir, assetName));
          if (!(await f.exists())) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response(f, { headers: { "Content-Type": guessMime(assetName) } });
        }
        if (method === "POST" && path === "/submit") {
          let body: SubmitBody;
          try {
            body = (await req.json()) as SubmitBody;
          } catch {
            return new Response('{"error":"invalid json"}', {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          resolveDone({ code: 0, data: body });
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        // b4 — the surface beacons here on EVERY departure, engaged or not
        // (circe's b4s, fbfe1d3). RECORD-ONLY BY CONTRACT: this route must never
        // call resolveDone. That is the whole safety of the seam — /cancel still
        // owns ending the session, so a refresh cannot kill one, and exit 130
        // keeps meaning "closed the tab AFTER interacting" exactly as
        // house-style's exit-code contract defines it.
        //
        // A route named for a verb must always perform that verb: this is why
        // the seam is a separate route rather than a flag on /cancel, which
        // would make one route sometimes resolve and sometimes not.
        if (method === "POST" && path === "/left") {
          try {
            const b = (await req.json()) as Partial<Departure> & { sessionId?: unknown };
            const named = typeof b.sessionId === "string" ? b.sessionId : null;
            departure = {
              engaged: b.engaged === true,
              elapsedMs: typeof b.elapsedMs === "number" ? b.elapsedMs : null,
              answered: typeof b.answered === "number" ? b.answered : null,
              commented: typeof b.commented === "number" ? b.commented : null,
              stale: named !== null && named !== sessionId,
            };
          } catch {
            // A malformed beacon still means SOMEBODY LEFT — that fact is the
            // point of the route, and discarding it would restore the very
            // silence b4 exists to remove. Record the departure with unknown
            // detail rather than nothing.
            departure = {
              engaged: false,
              elapsedMs: null,
              answered: null,
              commented: null,
              stale: false,
            };
          }
          return new Response(null, { status: 204 });
        }
        if (method === "POST" && path === "/cancel") {
          // ⛔ /cancel ENDS THIS SESSION, NOT WHOEVER HOLDS THE PORT.
          //
          // Recovery re-binds the port encoded in the session id so the
          // relaunched page lands on the same origin and inherits its
          // localStorage draft. That leaves the user's OLD tab pointed at the
          // same origin, so closing it after a relaunch beaconed /cancel into
          // the NEW daemon and resolved 130 — the restored review died the
          // moment the user tidied up the tab it was restored from. Found by
          // losing an hour to it during the port's browser drive.
          //
          // A beacon that NAMES a different session is therefore ignored. One
          // carrying no id is still honoured: the route stays callable by hand,
          // and the only page that can send an id-less beacon is a tab from a
          // release older than this one.
          let named: string | null = null;
          try {
            const b = (await req.json()) as { sessionId?: unknown };
            if (typeof b.sessionId === "string") named = b.sessionId;
          } catch {
            /* an empty or malformed body names nothing — honoured, as above */
          }
          if (named !== null && named !== sessionId) {
            process.stderr.write(
              `${JSON.stringify({ event: "stale_cancel_ignored", named, current: sessionId })}\n`,
            );
            return new Response('{"ok":true,"ignored":"stale-session"}', {
              headers: { "Content-Type": "application/json" },
            });
          }
          resolveDone({ code: 130, data: null });
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        if (method === "POST" && path === "/heartbeat") {
          heartbeatAt = performance.now();
          process.stderr.write(
            `${JSON.stringify({ event: "heartbeat", at: Math.round(heartbeatAt / 10) / 100 })}\n`,
          );
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  } catch (e) {
    // ⚠ A CODE CHANGE, 2 → 6, AND THE ONE FAILURE HERE THAT IS NOT THE
    // CALLER'S FAULT IN THE USUAL SENSE. A bind refusal is `conflict` — a
    // precondition failed — and it has a live subject in this spell: Session
    // Recovery re-binds the port encoded in the session id, so the daemon it is
    // replacing may still hold it. An agent that can tell "the port is taken"
    // from "your markdown is malformed" can retry; before this it could not.
    //
    // ⛔ AND THE OLD `{"event":"bind_error"}` LINE IS GONE, NOT KEPT BESIDE THE
    // ENVELOPE. "ONE JSON document on stderr" is the contract, and a second
    // JSON line above it is a second document — the same repair `join.ts` made
    // to its pre-handshake ws diagnostic (D52). The host and port it carried
    // are in the envelope's `hint`.
    die("could not bind the review server", "conflict", {
      hint: `host=${host} port=${port}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const boundPort = server.port;
  if (!sessionId) {
    sessionId = `digestify-${randHex(4)}-p${boundPort}`;
  }
  payload.session_id = sessionId;
  // The `</script>` breakout guard. The payload lands inside a
  // <script type="application/json"> data island, and a document containing the
  // literal characters `</script>` would otherwise close the tag early and turn
  // the rest of the review into markup. Re-derived, not carried on faith: the
  // payload still reaches the page as the text content of that element, so the
  // escape is still exactly the one that seam needs.
  const payloadJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
  const escapedTitle = htmlEscape(payload.title);
  substitute = (html) =>
    html.replace("__TITLE__", escapedTitle).replace("__PAYLOAD__", payloadJson);

  const readyUrl = `http://${host}:${boundPort}`;
  // The ready line is this daemon's ONLY mode transport — derived by reading
  // every stdout/stderr write in this file rather than by subtracting from an
  // exemplar (the mistake bounty's port recorded). There is no discovery file,
  // no ready EVENT and no stdout handshake: the other writes are the heartbeat
  // trace, the error lines, and the single final envelope. `mode` is additive
  // to a line SKILL.md documents as {url, port, session_id}.
  process.stderr.write(
    `${JSON.stringify({ url: readyUrl, port: boundPort, session_id: sessionId, mode })}\n`,
  );
  if (!v["no-open"]) openBrowser(readyUrl);

  // Idle-timeout watcher: slides forward on every /heartbeat.
  //
  // ⛔ THE DECISION IS THE KIT'S; THE SWEEP STAYS HERE. `shouldIdleClose` is
  // `src/kit/wire/housekeeping.ts`'s, and this spell has a real subject for it:
  // one idle window, slid forward by a `POST /heartbeat` the PAGE sends. What
  // is NOT adopted is `startHousekeeping`, which exists to own the PAIR of
  // standing timers a session daemon runs (the idle sweep and the debounced
  // snapshot) because they have always been one lifetime. Digestify has one
  // timer and no snapshot, so adopting the pair-manager would mean a no-op
  // `touch` and a `subscriberCount` that exists only to be zero.
  //
  // ⚠ AND ONE THING CAME BACK THE OTHER WAY — a RECEIVED change, not a gained
  // one, at exactly one input. `shouldIdleClose` carries astrolabe's
  // `timeoutMs <= 0` guard, which means NEVER. Before this adoption
  // `--timeout 0` closed the review on the first 50 ms tick; it now means the
  // review never times out on its own. Driven both sides and recorded as its
  // own decision-log entry, because "adopt and gain" is the framing that lands
  // a behaviour change unnamed.
  //
  // ⚠ `subscriberCount` is 0 BY FACT, not by omission: digestify holds no SSE
  // tail and no WebSocket, so there is never a watcher whose presence should
  // hold the session open. The argument is required precisely so a daemon that
  // DOES hold one cannot forget it (census defect L1).
  const timeoutMs = timeout * 1000;
  const idleTimer = setInterval(() => {
    if (shouldIdleClose(0, performance.now() - heartbeatAt, timeoutMs)) {
      resolveDone({ code: 124, data: null });
    }
  }, 50);

  const { code, data } = await done;
  clearInterval(idleTimer);
  // Grace period on submit: the browser races to fetch the "digested"
  // mascot from /assets after the POST /submit response returns, but it
  // doesn't know we're about to tear down. Without this delay the image
  // request lands on a dead server and the sent-screen renders broken.
  // Cancel/timeout don't need it — the page isn't loading new assets.
  if (code === 0) await new Promise((r) => setTimeout(r, 700));
  await server.stop();

  if (code === 0 && data !== null && typeof data === "object") {
    const response = {
      answers: data.answers ?? {},
      comments: data.comments ?? [],
      submitted_at: isoZNoMillis(new Date()),
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } else {
    // b4 — a cancelled or timed-out review used to write NOTHING to stdout, so
    // "the human read it and declined", "nobody ever opened it", "the tab
    // crashed" and "they walked away" were ONE observable through a pipe. Every
    // non-submit exit now writes a line naming what was actually observed.
    //
    // ⚠ `observed` is a FACT, not a contract noun. This situation is one the
    // outcome contract explicitly does NOT cover — grimoire/outcome-contract.md
    // Boundary 2 lists "deadline expiry" and "counterparty declined" among the
    // nine situations the two shapes do not reach — and Boundary 2 says meeting
    // one is a FINDING, not licence to invent a third spelling. So this reports
    // observations and deliberately does not mint an `outcome:` noun.
    //
    // Kept honest about its own limits: `departure: null` with `pageServed:true`
    // genuinely cannot separate a crashed tab from a walked-away human, and
    // `elapsedMs: null` means the beacon arrived malformed rather than
    // instantaneous.
    const observed = !pageServed
      ? "never-opened"
      : departure === null
        ? "opened-then-silent"
        : departure.engaged
          ? "engaged-then-left"
          : "read-then-left";
    process.stdout.write(
      `${JSON.stringify({
        submitted: false,
        exit: code,
        reason: code === 124 ? "idle-timeout" : "closed-without-submitting",
        observed,
        pageServed,
        departure,
        timeoutSeconds: timeout,
        ended_at: isoZNoMillis(new Date()),
      })}\n`,
    );
  }
  return code;
}

/**
 * The ONE place a failure becomes an exit code.
 *
 * ⛔ DIGESTIFY HAD NO `die` AND NO ERROR CLASS, AND THAT IS NOT THE SAME AS
 * HAVING NO ERROR CONTRACT (playbook Phase B, B8). It raised by
 * `process.stderr.write("error: …"); return 2;` at eight sites, and a grep for
 * `die(` reported "nothing to change" — the loudest possible wrong answer for a
 * spell whose exit codes SKILL.md publishes in a table with a per-code sentence
 * for the agent to say to the human. Every one of those eight is now
 * `src/kit/wire/errors.ts`'s envelope: ONE JSON document on stderr, `kind` to
 * route on, and stdout left empty because a failure has no data.
 *
 * ⛔ AND THE EXIT CODES ARE TWO POPULATIONS, RULED SEPARATELY — D52's ruling
 * for `join.ts`, arriving at the spell it was written for. **`2` is a FAILURE;
 * `124` and `130` are SESSION OUTCOMES.** A timeout and a closed tab are not
 * refusals of the caller's command: they are what happened to the review, they
 * are RETURNED from the body below and never raised, they each carry their own
 * observation envelope on STDOUT, and SKILL.md gives the agent a different
 * sentence to say to the human for each. They stay OUTSIDE the taxonomy and
 * keep their own numbers. Adopting `errors.ts` over them would re-spell the two
 * states this spell exists to distinguish.
 *
 * ⚠ AND THE CHANNEL IS WHAT SEPARATES THEM, NOT THE NUMBER — the same named
 * residue D52 recorded. A failure writes an envelope to stderr and nothing to
 * stdout; an outcome writes an observation to stdout and no envelope. `0` is
 * the third case and the only one with a payload.
 *
 * ⛔ AN UNKNOWN THROW IS RETHROWN, NOT REPORTED. `reportCliError` answers
 * `null` for anything that is not a `CliError`, and reporting one as a tidy
 * taxonomy failure would lose the stack that says what actually broke. Such a
 * throw ends the process at 1 with its stack, which is what it did before.
 */
async function main(argv: string[]): Promise<number> {
  // Digestify has one verb and it has no name — the envelope's `meta.command`
  // is the entry, which is what an agent reading the failure has in hand.
  setCurrentCommand("review");
  try {
    return await runReview(argv);
  } catch (e) {
    const code = reportCliError(e);
    if (code === null) throw e;
    return code;
  }
}

/**
 * The launcher's one entry point.
 *
 * ⛔ THERE IS NO `import.meta.main` BLOCK HERE, AND ITS ABSENCE IS THE RULING —
 * playbook Phase B, B3, re-keyed onto the property by D55. This module ships
 * BUNDLED at `<skill>/dist/review.js` and is IMPORTED by
 * `<skill>/scripts/review.ts`, never executed as the process entry, so the
 * block would never run at all. That is only half the reason it is gone. The
 * other half is that this file's arithmetic is anchored at the SKILL ROOT —
 * `SKILL_ROOT = join(SCRIPT_DIR, "..")`, and from it `DIST_DIR`, `assetsDir`
 * and `DEV_SURFACE_CWD` — and every one of those is correct from `dist/` and
 * WRONG from `src/digestify/backend/`. An `import.meta.main` here would offer a
 * second, broken address to run the spell from.
 *
 * ⛔ AND IT DOES NOT FAIL QUIETLY, WHICH IS WORSE THAN THE PREDICTION (D57).
 * Measured 2026-09-09 before this port, by copying the file here and running
 * it: from the repo root it exits 2 telling the operator to go to
 * `/Users/colereed/src/digestify` — a directory that does not exist, because
 * the message is computed by running the broken `SKILL_ROOT` through
 * `DEV_SURFACE_CWD`'s four `..`; from `src/digestify` it exits 2 blaming a
 * surface source that is present and correct. **A diagnostic computed from a
 * broken anchor lies confidently**, so the paths were resolved by hand from the
 * address this module actually ships at rather than read off its own errors.
 */
export async function run(): Promise<number> {
  return await main(process.argv.slice(2));
}

export { buildPayload, htmlEscape, isoZNoMillis, main, parsePortFromSessionId, parseQuestions };
