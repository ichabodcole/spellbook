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
// Contract intentionally mirrors review.py so the same template.html, tests,
// and agent-facing behavior apply. See review.py for prose-level commentary
// on edge cases — repeated here only where the implementation differs.

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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

  const template = await Bun.file(join(SCRIPT_DIR, "template.html")).text();
  const assetsDir = join(SCRIPT_DIR, "..", "assets");

  // Page HTML is finalized after the server binds; the handler reads it from
  // closure, so we keep it in a `let` populated before we open the browser.
  let pageHtml = "";
  let heartbeatAt = performance.now();
  let resolveDone!: (val: DoneResult) => void;
  const done = new Promise<DoneResult>((res) => {
    resolveDone = res;
  });

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        if (method === "GET" && path === "/") {
          return new Response(pageHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
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
        if (method === "POST" && path === "/cancel") {
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
  const payloadJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
  pageHtml = template
    .replace("__TITLE__", htmlEscape(payload.title))
    .replace("__PAYLOAD__", payloadJson);

  const readyUrl = `http://${host}:${boundPort}`;
  process.stderr.write(
    `${JSON.stringify({ url: readyUrl, port: boundPort, session_id: sessionId })}\n`,
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
  }
  return code;
}

// Allow importing pieces from tests without invoking main.
if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}

export { buildPayload, htmlEscape, isoZNoMillis, main, parsePortFromSessionId, parseQuestions };
