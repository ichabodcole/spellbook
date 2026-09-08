#!/usr/bin/env bun

// digestify review — Bun port (sibling to review.py).
//
// Reads markdown from stdin or --file, parses :::question fences, serves a
// local HTTP page that renders the markdown with question fields and inline
// comment widgets, blocks until the user submits, then prints
// {answers, comments, submitted_at} JSON to stdout.
//
// Exit codes:
//   0   submitted successfully
//   2   bad input (no questions, malformed args, etc.)
//   124 timeout
//   130 user closed tab without submitting
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
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// release iff dist/index.html exists at the skill root — the FILE, never the
// directory (a built backend can put cli.js in dist/ with no surface there) —
// else dev; the env override wins either way (Contract 1). Release: zero reads
// of surface source or bunfig.toml, static files only.
export function resolveMode(): "dev" | "release" {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release") return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}

/** What a dev-mode cwd's bunfig.toml must load, or the stylesheet never
 *  compiles. Named once; the guard and its error message share it. */
const TAILWIND_PLUGIN = "bun-plugin-tailwind";

/** Where the dev bundler's HTML lives. Never "/" — see the "/" handler. */
const DEV_SURFACE_ROUTE = "/__surface";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Serves dist/ verbatim EXCEPT its entry: the hashed index-*.js / index-*.css
// that index.html links RELATIVELY, which from "/" arrive as bare filenames
// (Contract 2's flat layout). "/" is NOT served from here — it is the
// substituted page, built once after the port is known. The guard keeps this
// ONE level deep, so every /assets/ path (all nested) is refused here and falls
// through to the board's own asset route.
function serveDist(path: string): Response | null {
  const rel = path.slice(1);
  if (!rel || rel === "index.html" || rel.includes("..") || rel.includes("/")) return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file)) return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
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

async function main(argv: string[]): Promise<number> {
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
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const v = parsed.values;
  const theme = v.theme as string;
  if (!VALID_THEMES.includes(theme as (typeof VALID_THEMES)[number])) {
    process.stderr.write(
      `error: invalid --theme '${theme}' (allowed: ${VALID_THEMES.join(", ")})\n`,
    );
    return 2;
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
      process.stderr.write(`error: file not found: ${path ?? "<unknown>"}\n`);
      return 2;
    }
    throw e;
  }
  if (!markdown.trim()) {
    process.stderr.write("error: no markdown provided on stdin, --file, or --reference\n");
    return 2;
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
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
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
      process.stderr.write(
        "digestify: cannot start in dev mode from this directory.\n" +
          `  cwd:    ${process.cwd()}\n` +
          `  needed: a cwd whose bunfig.toml loads ${TAILWIND_PLUGIN} — in a checkout of\n` +
          `          this repo that is ${DEV_SURFACE_CWD}\n` +
          "  why:    Bun reads bunfig.toml from the process cwd, at STARTUP — chdir is\n" +
          "          too late. Without the plugin the stylesheet never compiles and the\n" +
          "          page is served unstyled, or as Bun's own build-failure page, with\n" +
          "          nothing red anywhere.\n" +
          "  A published spell ships a built dist/ and resolves to release mode; dev mode\n" +
          "  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from that directory.\n",
      );
      return 2;
    }
    try {
      devIndex = (await import("../../../../../src/digestify/surface/index.html")).default;
    } catch (e) {
      // ⛔ THE FAILURE MUST NAME THE SURFACE. A forced-dev boot at a
      // surface-free destination otherwise dies with a module-resolution error
      // the operator cannot tell from a missing `bun`.
      process.stderr.write(
        "digestify: cannot start in dev mode — the surface source is missing.\n" +
          "  needed: src/digestify/surface/index.html (relative to the repo root)\n" +
          `  reason: ${e instanceof Error ? e.message : String(e)}\n` +
          "  A published spell ships a built dist/ and resolves to release mode; dev mode\n" +
          "  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.\n",
      );
      return 2;
    }
  }

  // The page's HTML SOURCE, before substitution. In release it is the committed
  // dist/index.html, read once. In dev it is whatever Bun's bundler produces,
  // fetched from this same server's private surface route at request time (see
  // the "/" handler) — the bundler owns the response and there is no way to ask
  // it for the text directly.
  const releaseTemplate =
    mode === "release" ? await Bun.file(join(DIST_DIR, "index.html")).text() : "";
  const assetsDir = join(SCRIPT_DIR, "..", "assets");

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
    process.stderr.write(
      `${JSON.stringify({
        event: "bind_error",
        host,
        port,
        error: e instanceof Error ? e.message : String(e),
      })}\n`,
    );
    return 2;
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
  const idleTimer = setInterval(() => {
    if ((performance.now() - heartbeatAt) / 1000 >= timeout) {
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

// Allow importing pieces from tests without invoking main.
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

export { buildPayload, htmlEscape, isoZNoMillis, main, parsePortFromSessionId, parseQuestions };
