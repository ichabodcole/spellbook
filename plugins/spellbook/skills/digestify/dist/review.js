#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/digestify/backend/review.ts
import { existsSync, readFileSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
function resolveMode() {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}
var TAILWIND_PLUGIN = "bun-plugin-tailwind";
var DEV_SURFACE_ROUTE = "/__surface";
var STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function serveDist(path) {
  const rel = path.slice(1);
  if (!rel || rel === "index.html" || rel.includes("..") || rel.includes("/"))
    return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file))
    return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" }
  });
}
var QBLOCK_RE = /^:::\s*question([^\n]*)\n([\s\S]*?)\n:::\s*$/gm;
var ID_RE = /\bid\s*=\s*([A-Za-z0-9_-]*)/;
var PORT_SUFFIX_RE = /-p(\d{2,5})$/;
var VALID_THEMES = ["digestify", "cthulhu", "classic"];
function parseQuestions(markdown) {
  const questions = [];
  const seen = new Set;
  const transformed = markdown.replace(QBLOCK_RE, (_m, attrs, body) => {
    const idMatch = (attrs || "").match(ID_RE);
    if (!idMatch?.[1]) {
      throw new Error("question block missing or has empty id; expected '::: question id=<name>'");
    }
    const qid = idMatch[1];
    if (seen.has(qid))
      throw new Error(`duplicate question id: '${qid}'`);
    seen.add(qid);
    const bodyTrim = body.trim();
    if (!bodyTrim)
      throw new Error(`question id='${qid}' has empty body`);
    questions.push({ id: qid, prompt: bodyTrim });
    return `

<div data-qblock="${qid}"></div>

`;
  });
  return { transformed, questions };
}
function buildPayload(markdown, opts) {
  const { transformed, questions } = parseQuestions(markdown);
  return {
    title: opts.title,
    theme: opts.theme,
    markdown: transformed,
    questions,
    session_id: opts.sessionId,
    timeout_seconds: opts.timeout
  };
}
function parsePortFromSessionId(sid) {
  if (!sid)
    return null;
  const m = sid.match(PORT_SUFFIX_RE);
  if (!m)
    return null;
  const port = parseInt(m[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
async function readStdinWithTimeout(ms = 100) {
  if (process.stdin.isTTY)
    return "";
  const reader = Bun.stdin.stream().getReader();
  try {
    const TIMEOUT = Symbol("timeout");
    const timer = new Promise((res) => setTimeout(() => res(TIMEOUT), ms));
    const first = await Promise.race([reader.read(), timer]);
    if (first === TIMEOUT)
      return "";
    if (first.done)
      return "";
    const chunks = [first.value];
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      if (value)
        chunks.push(value);
    }
    let total = 0;
    for (const c of chunks)
      total += c.byteLength;
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
    } catch {}
  }
}
async function readInput(args) {
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
  const parts = [];
  if (referenceContent.trim()) {
    parts.push(`> Reference: \`${refLabel}\`

${referenceContent.replace(/\s+$/, "")}`);
  }
  if (agentContent.trim()) {
    if (parts.length > 0) {
      const labelAttr = htmlEscape(refLabel);
      parts.push(`<div data-refboundary="${labelAttr}"></div>

${agentContent.replace(/\s+$/, "")}`);
    } else {
      parts.push(agentContent.replace(/\s+$/, ""));
    }
  }
  return parts.join(`

`);
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  } catch {}
}
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function isoZNoMillis(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
var MIME_BY_EXT = {
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
  ".otf": "font/otf"
};
function guessMime(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
async function main(argv) {
  let parsed;
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
        id: { type: "string" }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}
`);
    return 2;
  }
  const v = parsed.values;
  const theme = v.theme;
  if (!VALID_THEMES.includes(theme)) {
    process.stderr.write(`error: invalid --theme '${theme}' (allowed: ${VALID_THEMES.join(", ")})
`);
    return 2;
  }
  const timeout = parseFloat(v.timeout);
  let port = parseInt(v.port, 10);
  const host = v.host;
  let sessionId = v.id ?? "";
  if (port === 0 && sessionId) {
    const embedded = parsePortFromSessionId(sessionId);
    if (embedded !== null)
      port = embedded;
  }
  let markdown;
  try {
    markdown = await readInput({
      file: v.file,
      reference: v.reference
    });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      const path = "path" in e ? e.path : undefined;
      process.stderr.write(`error: file not found: ${path ?? "<unknown>"}
`);
      return 2;
    }
    throw e;
  }
  if (!markdown.trim()) {
    process.stderr.write(`error: no markdown provided on stdin, --file, or --reference
`);
    return 2;
  }
  let payload;
  try {
    payload = buildPayload(markdown, {
      title: v.title,
      theme,
      sessionId: sessionId || "__TBD__",
      timeout
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}
`);
    return 2;
  }
  const mode = resolveMode();
  const DEV_SURFACE_CWD = join(SKILL_ROOT, "..", "..", "..", "..", "src", "digestify");
  let devIndex;
  if (mode === "dev") {
    const bunfig = join(process.cwd(), "bunfig.toml");
    const loadsTailwind = existsSync(bunfig) && readFileSync(bunfig, "utf8").includes(TAILWIND_PLUGIN);
    if (!loadsTailwind) {
      process.stderr.write(`digestify: cannot start in dev mode from this directory.
` + `  cwd:    ${process.cwd()}
` + `  needed: a cwd whose bunfig.toml loads ${TAILWIND_PLUGIN} \u2014 in a checkout of
` + `          this repo that is ${DEV_SURFACE_CWD}
` + `  why:    Bun reads bunfig.toml from the process cwd, at STARTUP \u2014 chdir is
` + `          too late. Without the plugin the stylesheet never compiles and the
` + `          page is served unstyled, or as Bun's own build-failure page, with
` + `          nothing red anywhere.
` + `  A published spell ships a built dist/ and resolves to release mode; dev mode
` + `  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from that directory.
`);
      return 2;
    }
    try {
      devIndex = (await import("../../../../../src/digestify/surface/index.html")).default;
    } catch (e) {
      process.stderr.write(`digestify: cannot start in dev mode \u2014 the surface source is missing.
` + `  needed: src/digestify/surface/index.html (relative to the repo root)
  reason: ${e instanceof Error ? e.message : String(e)}
  A published spell ships a built dist/ and resolves to release mode; dev mode
  needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.
`);
      return 2;
    }
  }
  const releaseTemplate = mode === "release" ? await Bun.file(join(DIST_DIR, "index.html")).text() : "";
  const assetsDir = join(SKILL_ROOT, "assets");
  let substitute = (html) => html;
  let heartbeatAt = performance.now();
  let departure = null;
  let pageServed = false;
  let resolveDone;
  const done = new Promise((res) => {
    resolveDone = res;
  });
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes: devIndex ? { [DEV_SURFACE_ROUTE]: devIndex } : {},
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;
        if (method === "GET" && path === "/") {
          pageServed = true;
          const source = mode === "dev" ? await (await fetch(`http://${host}:${server.port}${DEV_SURFACE_ROUTE}`)).text() : releaseTemplate;
          return new Response(substitute(source), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        if (method === "GET" && mode === "release") {
          const asset = serveDist(path);
          if (asset)
            return asset;
        }
        if (method === "GET" && path.startsWith("/assets/")) {
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          if (assetName.includes("..") || assetName.startsWith("/")) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          const f = Bun.file(join(assetsDir, assetName));
          if (!await f.exists()) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          return new Response(f, { headers: { "Content-Type": guessMime(assetName) } });
        }
        if (method === "POST" && path === "/submit") {
          let body;
          try {
            body = await req.json();
          } catch {
            return new Response('{"error":"invalid json"}', {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          resolveDone({ code: 0, data: body });
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        if (method === "POST" && path === "/left") {
          try {
            const b = await req.json();
            const named = typeof b.sessionId === "string" ? b.sessionId : null;
            departure = {
              engaged: b.engaged === true,
              elapsedMs: typeof b.elapsedMs === "number" ? b.elapsedMs : null,
              answered: typeof b.answered === "number" ? b.answered : null,
              commented: typeof b.commented === "number" ? b.commented : null,
              stale: named !== null && named !== sessionId
            };
          } catch {
            departure = {
              engaged: false,
              elapsedMs: null,
              answered: null,
              commented: null,
              stale: false
            };
          }
          return new Response(null, { status: 204 });
        }
        if (method === "POST" && path === "/cancel") {
          let named = null;
          try {
            const b = await req.json();
            if (typeof b.sessionId === "string")
              named = b.sessionId;
          } catch {}
          if (named !== null && named !== sessionId) {
            process.stderr.write(`${JSON.stringify({ event: "stale_cancel_ignored", named, current: sessionId })}
`);
            return new Response('{"ok":true,"ignored":"stale-session"}', {
              headers: { "Content-Type": "application/json" }
            });
          }
          resolveDone({ code: 130, data: null });
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        if (method === "POST" && path === "/heartbeat") {
          heartbeatAt = performance.now();
          process.stderr.write(`${JSON.stringify({ event: "heartbeat", at: Math.round(heartbeatAt / 10) / 100 })}
`);
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    });
  } catch (e) {
    process.stderr.write(`${JSON.stringify({
      event: "bind_error",
      host,
      port,
      error: e instanceof Error ? e.message : String(e)
    })}
`);
    return 2;
  }
  const boundPort = server.port;
  if (!sessionId) {
    sessionId = `digestify-${randHex(4)}-p${boundPort}`;
  }
  payload.session_id = sessionId;
  const payloadJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
  const escapedTitle = htmlEscape(payload.title);
  substitute = (html) => html.replace("__TITLE__", escapedTitle).replace("__PAYLOAD__", payloadJson);
  const readyUrl = `http://${host}:${boundPort}`;
  process.stderr.write(`${JSON.stringify({ url: readyUrl, port: boundPort, session_id: sessionId, mode })}
`);
  if (!v["no-open"])
    openBrowser(readyUrl);
  const idleTimer = setInterval(() => {
    if ((performance.now() - heartbeatAt) / 1000 >= timeout) {
      resolveDone({ code: 124, data: null });
    }
  }, 50);
  const { code, data } = await done;
  clearInterval(idleTimer);
  if (code === 0)
    await new Promise((r) => setTimeout(r, 700));
  await server.stop();
  if (code === 0 && data !== null && typeof data === "object") {
    const response = {
      answers: data.answers ?? {},
      comments: data.comments ?? [],
      submitted_at: isoZNoMillis(new Date)
    };
    process.stdout.write(`${JSON.stringify(response)}
`);
  } else {
    const observed = !pageServed ? "never-opened" : departure === null ? "opened-then-silent" : departure.engaged ? "engaged-then-left" : "read-then-left";
    process.stdout.write(`${JSON.stringify({
      submitted: false,
      exit: code,
      reason: code === 124 ? "idle-timeout" : "closed-without-submitting",
      observed,
      pageServed,
      departure,
      timeoutSeconds: timeout,
      ended_at: isoZNoMillis(new Date)
    })}
`);
  }
  return code;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  buildPayload,
  htmlEscape,
  isoZNoMillis,
  main,
  parsePortFromSessionId,
  parseQuestions,
  resolveMode,
  run
};

//# debugId=02EB228DC050C4DC64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2RpZ2VzdGlmeS9iYWNrZW5kL3Jldmlldy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gZGlnZXN0aWZ5IHJldmlldyDigJQgQnVuIHBvcnQgKHNpYmxpbmcgdG8gcmV2aWV3LnB5KS5cbi8vXG4vLyBSZWFkcyBtYXJrZG93biBmcm9tIHN0ZGluIG9yIC0tZmlsZSwgcGFyc2VzIDo6OnF1ZXN0aW9uIGZlbmNlcywgc2VydmVzIGFcbi8vIGxvY2FsIEhUVFAgcGFnZSB0aGF0IHJlbmRlcnMgdGhlIG1hcmtkb3duIHdpdGggcXVlc3Rpb24gZmllbGRzIGFuZCBpbmxpbmVcbi8vIGNvbW1lbnQgd2lkZ2V0cywgYmxvY2tzIHVudGlsIHRoZSB1c2VyIHN1Ym1pdHMsIHRoZW4gcHJpbnRzXG4vLyB7YW5zd2VycywgY29tbWVudHMsIHN1Ym1pdHRlZF9hdH0gSlNPTiB0byBzdGRvdXQuXG4vL1xuLy8gRXhpdCBjb2Rlczpcbi8vICAgMCAgIHN1Ym1pdHRlZCBzdWNjZXNzZnVsbHlcbi8vICAgMiAgIGJhZCBpbnB1dCAobm8gcXVlc3Rpb25zLCBtYWxmb3JtZWQgYXJncywgZXRjLilcbi8vICAgMTI0IHRpbWVvdXRcbi8vICAgMTMwIHVzZXIgY2xvc2VkIHRhYiB3aXRob3V0IHN1Ym1pdHRpbmdcbi8vXG4vLyBDb250cmFjdCBpbnRlbnRpb25hbGx5IG1pcnJvcnMgcmV2aWV3LnB5IHNvIHRoZSBzYW1lIHRlc3RzIGFuZCBhZ2VudC1mYWNpbmdcbi8vIGJlaGF2aW9yIGFwcGx5LiBTZWUgcmV2aWV3LnB5IGZvciBwcm9zZS1sZXZlbCBjb21tZW50YXJ5IG9uIGVkZ2UgY2FzZXMg4oCUXG4vLyByZXBlYXRlZCBoZXJlIG9ubHkgd2hlcmUgdGhlIGltcGxlbWVudGF0aW9uIGRpZmZlcnMuXG4vL1xuLy8g4pqgIFRoZSBzaGFyZWQgU1VSRkFDRSBpcyBnb25lIGZyb20gdGhhdCBzZW50ZW5jZSBhcyBvZiAyMDI2LTA5LTA3OiB0aGUgcGFnZVxuLy8gYm90aCBzY3JpcHRzIHVzZWQgdG8gc2VydmUsIGBzY3JpcHRzL3RlbXBsYXRlLmh0bWxgLCBpcyBub3cgYSBSZWFjdCBzdXJmYWNlXG4vLyBhdCBzcmMvZGlnZXN0aWZ5L3N1cmZhY2UvIGJ1aWx0IGludG8gZGlzdC8uIHJldmlldy5weSwgaWYgaXQgaXMgZXZlciBydW5cbi8vIGFnYWluLCBzZXJ2ZXMgbm90aGluZy5cblxuaW1wb3J0IHsgZXhpc3RzU3luYywgcmVhZEZpbGVTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gXCJub2RlOnVybFwiO1xuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuXG4vLyBUaGUgcmV2aWV3IHBhZ2UgdXNlZCB0byBiZSBgc2NyaXB0cy90ZW1wbGF0ZS5odG1sYCwgcmVhZCBhdCBib290IGFuZCBzdHJpbmdcbi8vIHN1YnN0aXR1dGVkIGJlZm9yZSBldmVyeSByZXNwb25zZS4gSXQgaXMgbm93IGEgUmVhY3Qgc3VyZmFjZSBhdFxuLy8gc3JjL2RpZ2VzdGlmeS9zdXJmYWNlLywgYnVpbHQgaW50byBkaXN0LyAoc2VhbXMgQ29udHJhY3QgMikuIFRoZSBkZXYgZW50cnkgaXNcbi8vIGEgRFlOQU1JQyBpbXBvcnQgcmVhY2hlZCBvbmx5IG9uIHRoZSBkZXYgYnJhbmNoOiBhIHN0YXRpYyBvbmUgd291bGQgZm9yY2UgQnVuXG4vLyB0byByZXNvbHZlIHRoZSB3aG9sZSAudHN4ICsgVGFpbHdpbmQgZ3JhcGggd2hlbiB0aGlzIG1vZHVsZSBMT0FEUywgc28gdGhlXG4vLyBwdWJsaXNoZWQgYXJ0aWZhY3Qg4oCUIHdoaWNoIHNoaXBzIGRpc3QvIGFuZCBubyBzdXJmYWNlIHNvdXJjZSDigJQgd291bGQgZGllXG4vLyBiZWZvcmUgaXQgY291bGQgc2VydmUgdGhlIGRpc3QgaXQgZG9lcyBoYXZlIChDb250cmFjdCAxKS5cbi8vXG4vLyBQYXRocyBhbmNob3IgYXQgdGhlIFNLSUxMIFJPT1QsIG5ldmVyIGF0IGN3ZDogdGhpcyBzY3JpcHQgaXMgaW52b2tlZCBieSB0aGVcbi8vIGFnZW50IGZyb20gd2hlcmV2ZXIgdGhlIGNvbnZlcnNhdGlvbiBoYXBwZW5zIHRvIGJlLlxuLy9cbi8vIOKblCBBTkQgU0lOQ0UgUEhBU0UgNSBUSEUgT05MWSBBRERSRVNTIFRIQVQgQVJJVEhNRVRJQyBJUyBUUlVFIEFUIElTIFRIRVxuLy8gQVJUSUZBQ1Qg4oCUIGA8c2tpbGw+L2Rpc3QvcmV2aWV3LmpzYCwgd2hpY2ggdGhlIGxhdW5jaGVyIGF0XG4vLyBgPHNraWxsPi9zY3JpcHRzL3Jldmlldy50c2AgaW1wb3J0cy4gYFNDUklQVF9ESVJgIGlzIHRoZXJlZm9yZSBgPHNraWxsPi9kaXN0YCxcbi8vIGBTS0lMTF9ST09UYCBpcyBgPHNraWxsPmAsIGFuZCBldmVyeXRoaW5nIGJlbG93IGRlcml2ZXMgZnJvbSBpdDogYERJU1RfRElSYCxcbi8vIHRoZSBhc3NldHMgZGlyZWN0b3J5LCBgREVWX1NVUkZBQ0VfQ1dEYCwgYW5kIHRoZSBkZXYgc3VyZmFjZSBpbXBvcnQncyBmaXZlXG4vLyBgLi5gLiBGcm9tIFRISVMgc291cmNlIGZpbGUncyBvd24gZGlyZWN0b3J5IChgc3JjL2RpZ2VzdGlmeS9iYWNrZW5kL2ApIGV2ZXJ5XG4vLyBvbmUgb2YgdGhlbSBpcyB3cm9uZywgd2hpY2ggaXMgd2h5IHRoZXJlIGlzIG5vIGBpbXBvcnQubWV0YS5tYWluYCBibG9jayBhdFxuLy8gdGhlIGZvb3Qgb2YgdGhlIGZpbGUg4oCUIHNlZSBgcnVuKClgIGFuZCBENTcuIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2Bcbi8vIGlzIHRoZSBpbnN0cnVtZW50OiBpdCByZXNvbHZlcyB0aGVzZSBmcm9tIHRoZSBFTUlUVEVEIGZpbGUncyBkaXJlY3RvcnksIHRoZVxuLy8gd2F5IHRoZSBydW50aW1lIHdpbGwuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5cbi8vIHJlbGVhc2UgaWZmIGRpc3QvaW5kZXguaHRtbCBleGlzdHMgYXQgdGhlIHNraWxsIHJvb3Qg4oCUIHRoZSBGSUxFLCBuZXZlciB0aGVcbi8vIGRpcmVjdG9yeSAoYSBidWlsdCBiYWNrZW5kIGNhbiBwdXQgY2xpLmpzIGluIGRpc3QvIHdpdGggbm8gc3VyZmFjZSB0aGVyZSkg4oCUXG4vLyBlbHNlIGRldjsgdGhlIGVudiBvdmVycmlkZSB3aW5zIGVpdGhlciB3YXkgKENvbnRyYWN0IDEpLiBSZWxlYXNlOiB6ZXJvIHJlYWRzXG4vLyBvZiBzdXJmYWNlIHNvdXJjZSBvciBidW5maWcudG9tbCwgc3RhdGljIGZpbGVzIG9ubHkuXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZU1vZGUoKTogXCJkZXZcIiB8IFwicmVsZWFzZVwiIHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFO1xuICBpZiAob3ZlcnJpZGUgPT09IFwiZGV2XCIgfHwgb3ZlcnJpZGUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gb3ZlcnJpZGU7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBcInJlbGVhc2VcIiA6IFwiZGV2XCI7XG59XG5cbi8qKiBXaGF0IGEgZGV2LW1vZGUgY3dkJ3MgYnVuZmlnLnRvbWwgbXVzdCBsb2FkLCBvciB0aGUgc3R5bGVzaGVldCBuZXZlclxuICogIGNvbXBpbGVzLiBOYW1lZCBvbmNlOyB0aGUgZ3VhcmQgYW5kIGl0cyBlcnJvciBtZXNzYWdlIHNoYXJlIGl0LiAqL1xuY29uc3QgVEFJTFdJTkRfUExVR0lOID0gXCJidW4tcGx1Z2luLXRhaWx3aW5kXCI7XG5cbi8qKiBXaGVyZSB0aGUgZGV2IGJ1bmRsZXIncyBIVE1MIGxpdmVzLiBOZXZlciBcIi9cIiDigJQgc2VlIHRoZSBcIi9cIiBoYW5kbGVyLiAqL1xuY29uc3QgREVWX1NVUkZBQ0VfUk9VVEUgPSBcIi9fX3N1cmZhY2VcIjtcblxuY29uc3QgU1RBVElDX0NPTlRFTlRfVFlQRVM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmh0bWxcIjogXCJ0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLThcIixcbiAgXCIuanNcIjogXCJ0ZXh0L2phdmFzY3JpcHRcIixcbiAgXCIuY3NzXCI6IFwidGV4dC9jc3NcIixcbiAgXCIuanNvblwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbn07XG5cbi8vIFNlcnZlcyBkaXN0LyB2ZXJiYXRpbSBFWENFUFQgaXRzIGVudHJ5OiB0aGUgaGFzaGVkIGluZGV4LSouanMgLyBpbmRleC0qLmNzc1xuLy8gdGhhdCBpbmRleC5odG1sIGxpbmtzIFJFTEFUSVZFTFksIHdoaWNoIGZyb20gXCIvXCIgYXJyaXZlIGFzIGJhcmUgZmlsZW5hbWVzXG4vLyAoQ29udHJhY3QgMidzIGZsYXQgbGF5b3V0KS4gXCIvXCIgaXMgTk9UIHNlcnZlZCBmcm9tIGhlcmUg4oCUIGl0IGlzIHRoZVxuLy8gc3Vic3RpdHV0ZWQgcGFnZSwgYnVpbHQgb25jZSBhZnRlciB0aGUgcG9ydCBpcyBrbm93bi4gVGhlIGd1YXJkIGtlZXBzIHRoaXNcbi8vIE9ORSBsZXZlbCBkZWVwLCBzbyBldmVyeSAvYXNzZXRzLyBwYXRoIChhbGwgbmVzdGVkKSBpcyByZWZ1c2VkIGhlcmUgYW5kIGZhbGxzXG4vLyB0aHJvdWdoIHRvIHRoZSBib2FyZCdzIG93biBhc3NldCByb3V0ZS5cbmZ1bmN0aW9uIHNlcnZlRGlzdChwYXRoOiBzdHJpbmcpOiBSZXNwb25zZSB8IG51bGwge1xuICBjb25zdCByZWwgPSBwYXRoLnNsaWNlKDEpO1xuICBpZiAoIXJlbCB8fCByZWwgPT09IFwiaW5kZXguaHRtbFwiIHx8IHJlbC5pbmNsdWRlcyhcIi4uXCIpIHx8IHJlbC5pbmNsdWRlcyhcIi9cIikpIHJldHVybiBudWxsO1xuICBjb25zdCBmaWxlID0gam9pbihESVNUX0RJUiwgcmVsKTtcbiAgaWYgKCFleGlzdHNTeW5jKGZpbGUpKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgZXh0ID0gcmVsLnNsaWNlKHJlbC5sYXN0SW5kZXhPZihcIi5cIikpO1xuICByZXR1cm4gbmV3IFJlc3BvbnNlKEJ1bi5maWxlKGZpbGUpLCB7XG4gICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBTVEFUSUNfQ09OVEVOVF9UWVBFU1tleHRdID8/IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCIgfSxcbiAgfSk7XG59XG5cbnR5cGUgUXVlc3Rpb24gPSB7IGlkOiBzdHJpbmc7IHByb21wdDogc3RyaW5nIH07XG50eXBlIFBheWxvYWQgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIHRoZW1lOiBzdHJpbmc7XG4gIG1hcmtkb3duOiBzdHJpbmc7XG4gIHF1ZXN0aW9uczogUXVlc3Rpb25bXTtcbiAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICB0aW1lb3V0X3NlY29uZHM6IG51bWJlcjtcbn07XG5cbi8vIFByb3RvY29sIOKAlCB3aGF0IHRoZSBicm93c2VyIFBPU1RzIHRvIC9zdWJtaXQgYW5kIHdoYXQgd2UgZW1pdCB0byBzdGRvdXQuXG50eXBlIFN1Ym1pdEJvZHkgPSB7XG4gIGFuc3dlcnM/OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgY29tbWVudHM/OiB1bmtub3duW107XG59O1xudHlwZSBEb25lUmVzdWx0ID0geyBjb2RlOiBudW1iZXI7IGRhdGE6IFN1Ym1pdEJvZHkgfCBudWxsIH07XG5cbmNvbnN0IFFCTE9DS19SRSA9IC9eOjo6XFxzKnF1ZXN0aW9uKFteXFxuXSopXFxuKFtcXHNcXFNdKj8pXFxuOjo6XFxzKiQvZ207XG5jb25zdCBJRF9SRSA9IC9cXGJpZFxccyo9XFxzKihbQS1aYS16MC05Xy1dKikvO1xuY29uc3QgUE9SVF9TVUZGSVhfUkUgPSAvLXAoXFxkezIsNX0pJC87XG5jb25zdCBWQUxJRF9USEVNRVMgPSBbXCJkaWdlc3RpZnlcIiwgXCJjdGh1bGh1XCIsIFwiY2xhc3NpY1wiXSBhcyBjb25zdDtcblxuZnVuY3Rpb24gcGFyc2VRdWVzdGlvbnMobWFya2Rvd246IHN0cmluZyk6IHsgdHJhbnNmb3JtZWQ6IHN0cmluZzsgcXVlc3Rpb25zOiBRdWVzdGlvbltdIH0ge1xuICBjb25zdCBxdWVzdGlvbnM6IFF1ZXN0aW9uW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCB0cmFuc2Zvcm1lZCA9IG1hcmtkb3duLnJlcGxhY2UoUUJMT0NLX1JFLCAoX20sIGF0dHJzOiBzdHJpbmcsIGJvZHk6IHN0cmluZykgPT4ge1xuICAgIGNvbnN0IGlkTWF0Y2ggPSAoYXR0cnMgfHwgXCJcIikubWF0Y2goSURfUkUpO1xuICAgIGlmICghaWRNYXRjaD8uWzFdKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJxdWVzdGlvbiBibG9jayBtaXNzaW5nIG9yIGhhcyBlbXB0eSBpZDsgZXhwZWN0ZWQgJzo6OiBxdWVzdGlvbiBpZD08bmFtZT4nXCIpO1xuICAgIH1cbiAgICBjb25zdCBxaWQgPSBpZE1hdGNoWzFdO1xuICAgIGlmIChzZWVuLmhhcyhxaWQpKSB0aHJvdyBuZXcgRXJyb3IoYGR1cGxpY2F0ZSBxdWVzdGlvbiBpZDogJyR7cWlkfSdgKTtcbiAgICBzZWVuLmFkZChxaWQpO1xuICAgIGNvbnN0IGJvZHlUcmltID0gYm9keS50cmltKCk7XG4gICAgaWYgKCFib2R5VHJpbSkgdGhyb3cgbmV3IEVycm9yKGBxdWVzdGlvbiBpZD0nJHtxaWR9JyBoYXMgZW1wdHkgYm9keWApO1xuICAgIHF1ZXN0aW9ucy5wdXNoKHsgaWQ6IHFpZCwgcHJvbXB0OiBib2R5VHJpbSB9KTtcbiAgICAvLyBTdXJyb3VuZCB3aXRoIGJsYW5rIGxpbmVzIHNvIG1hcmtlZCB0cmVhdHMgdGhpcyBhcyBhIHNlbGYtY29udGFpbmVkXG4gICAgLy8gdHlwZS02IEhUTUwgYmxvY2sgKENvbW1vbk1hcmspIOKAlCB3aXRob3V0IHRoZSB0cmFpbGluZyBibGFuayBsaW5lIHRoZVxuICAgIC8vIHJhdyBIVE1MIHN3YWxsb3dzIHRoZSBuZXh0IGhlYWRpbmcvcGFyYWdyYXBoLlxuICAgIHJldHVybiBgXFxuXFxuPGRpdiBkYXRhLXFibG9jaz1cIiR7cWlkfVwiPjwvZGl2PlxcblxcbmA7XG4gIH0pO1xuICByZXR1cm4geyB0cmFuc2Zvcm1lZCwgcXVlc3Rpb25zIH07XG59XG5cbmZ1bmN0aW9uIGJ1aWxkUGF5bG9hZChcbiAgbWFya2Rvd246IHN0cmluZyxcbiAgb3B0czogeyB0aXRsZTogc3RyaW5nOyB0aGVtZTogc3RyaW5nOyBzZXNzaW9uSWQ6IHN0cmluZzsgdGltZW91dDogbnVtYmVyIH0sXG4pOiBQYXlsb2FkIHtcbiAgY29uc3QgeyB0cmFuc2Zvcm1lZCwgcXVlc3Rpb25zIH0gPSBwYXJzZVF1ZXN0aW9ucyhtYXJrZG93bik7XG4gIHJldHVybiB7XG4gICAgdGl0bGU6IG9wdHMudGl0bGUsXG4gICAgdGhlbWU6IG9wdHMudGhlbWUsXG4gICAgbWFya2Rvd246IHRyYW5zZm9ybWVkLFxuICAgIHF1ZXN0aW9ucyxcbiAgICBzZXNzaW9uX2lkOiBvcHRzLnNlc3Npb25JZCxcbiAgICB0aW1lb3V0X3NlY29uZHM6IG9wdHMudGltZW91dCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQb3J0RnJvbVNlc3Npb25JZChzaWQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBpZiAoIXNpZCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IG0gPSBzaWQubWF0Y2goUE9SVF9TVUZGSVhfUkUpO1xuICBpZiAoIW0pIHJldHVybiBudWxsO1xuICBjb25zdCBwb3J0ID0gcGFyc2VJbnQobVsxXSwgMTApO1xuICByZXR1cm4gcG9ydCA+PSAxICYmIHBvcnQgPD0gNjU1MzUgPyBwb3J0IDogbnVsbDtcbn1cblxuZnVuY3Rpb24gaHRtbEVzY2FwZShzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc1xuICAgIC5yZXBsYWNlKC8mL2csIFwiJmFtcDtcIilcbiAgICAucmVwbGFjZSgvPC9nLCBcIiZsdDtcIilcbiAgICAucmVwbGFjZSgvPi9nLCBcIiZndDtcIilcbiAgICAucmVwbGFjZSgvXCIvZywgXCImcXVvdDtcIilcbiAgICAucmVwbGFjZSgvJy9nLCBcIiYjeDI3O1wiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluV2l0aFRpbWVvdXQobXMgPSAxMDApOiBQcm9taXNlPHN0cmluZz4ge1xuICAvLyBNaXJyb3JzIHRoZSBzZWxlY3QoKS13aXRoLXRpbnktd2luZG93IGd1YXJkIGluIHJldmlldy5weSDigJQgYWdlbnQgaGFybmVzc2VzXG4gIC8vIGNhbiBsZWF2ZSBzdGRpbiBvcGVuLWJ1dC1lbXB0eSwgYW5kIGEgbmFpdmUgcmVhZCB3b3VsZCBoYW5nIGZvcmV2ZXIuXG4gIGlmIChwcm9jZXNzLnN0ZGluLmlzVFRZKSByZXR1cm4gXCJcIjtcbiAgY29uc3QgcmVhZGVyID0gQnVuLnN0ZGluLnN0cmVhbSgpLmdldFJlYWRlcigpO1xuICB0cnkge1xuICAgIGNvbnN0IFRJTUVPVVQgPSBTeW1ib2woXCJ0aW1lb3V0XCIpO1xuICAgIGNvbnN0IHRpbWVyID0gbmV3IFByb21pc2U8dHlwZW9mIFRJTUVPVVQ+KChyZXMpID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzKFRJTUVPVVQpLCBtcykpO1xuICAgIGNvbnN0IGZpcnN0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtyZWFkZXIucmVhZCgpLCB0aW1lcl0pO1xuICAgIGlmIChmaXJzdCA9PT0gVElNRU9VVCkgcmV0dXJuIFwiXCI7XG4gICAgaWYgKGZpcnN0LmRvbmUpIHJldHVybiBcIlwiO1xuICAgIGNvbnN0IGNodW5rczogVWludDhBcnJheVtdID0gW2ZpcnN0LnZhbHVlXTtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgY29uc3QgeyBkb25lLCB2YWx1ZSB9ID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICAgIGlmICh2YWx1ZSkgY2h1bmtzLnB1c2godmFsdWUpO1xuICAgIH1cbiAgICBsZXQgdG90YWwgPSAwO1xuICAgIGZvciAoY29uc3QgYyBvZiBjaHVua3MpIHRvdGFsICs9IGMuYnl0ZUxlbmd0aDtcbiAgICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheSh0b3RhbCk7XG4gICAgbGV0IG9mZiA9IDA7XG4gICAgZm9yIChjb25zdCBjIG9mIGNodW5rcykge1xuICAgICAgYnVmLnNldChjLCBvZmYpO1xuICAgICAgb2ZmICs9IGMuYnl0ZUxlbmd0aDtcbiAgICB9XG4gICAgcmV0dXJuIG5ldyBUZXh0RGVjb2RlcihcInV0Zi04XCIpLmRlY29kZShidWYpO1xuICB9IGZpbmFsbHkge1xuICAgIHRyeSB7XG4gICAgICByZWFkZXIucmVsZWFzZUxvY2soKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIGFscmVhZHkgcmVsZWFzZWQgKi9cbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZElucHV0KGFyZ3M6IHsgcmVmZXJlbmNlPzogc3RyaW5nOyBmaWxlPzogc3RyaW5nIH0pOiBQcm9taXNlPHN0cmluZz4ge1xuICBsZXQgcmVmZXJlbmNlQ29udGVudCA9IFwiXCI7XG4gIGxldCByZWZMYWJlbCA9IFwiXCI7XG4gIGlmIChhcmdzLnJlZmVyZW5jZSkge1xuICAgIHJlZmVyZW5jZUNvbnRlbnQgPSBhd2FpdCBCdW4uZmlsZShhcmdzLnJlZmVyZW5jZSkudGV4dCgpO1xuICAgIHJlZkxhYmVsID0gYmFzZW5hbWUoYXJncy5yZWZlcmVuY2UpO1xuICB9XG5cbiAgbGV0IGFnZW50Q29udGVudCA9IGF3YWl0IHJlYWRTdGRpbldpdGhUaW1lb3V0KDEwMCk7XG4gIGlmICghYWdlbnRDb250ZW50ICYmIGFyZ3MuZmlsZSkge1xuICAgIGFnZW50Q29udGVudCA9IGF3YWl0IEJ1bi5maWxlKGFyZ3MuZmlsZSkudGV4dCgpO1xuICB9XG5cbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGlmIChyZWZlcmVuY2VDb250ZW50LnRyaW0oKSkge1xuICAgIHBhcnRzLnB1c2goYD4gUmVmZXJlbmNlOiBcXGAke3JlZkxhYmVsfVxcYFxcblxcbiR7cmVmZXJlbmNlQ29udGVudC5yZXBsYWNlKC9cXHMrJC8sIFwiXCIpfWApO1xuICB9XG4gIGlmIChhZ2VudENvbnRlbnQudHJpbSgpKSB7XG4gICAgaWYgKHBhcnRzLmxlbmd0aCA+IDApIHtcbiAgICAgIC8vIFN0eWxlZCBib3VuZGFyeSBtYXJrZXIgd2l0aCBIVE1MLWVzY2FwZWQgcmVmZXJlbmNlIGZpbGVuYW1lIHNvIHRoZVxuICAgICAgLy8gdGVtcGxhdGUgY2FuIHJlbmRlciBcImVuZCBvZiA8ZmlsZW5hbWU+XCIgd2l0aG91dCBhdHRyaWJ1dGUgaW5qZWN0aW9uLlxuICAgICAgY29uc3QgbGFiZWxBdHRyID0gaHRtbEVzY2FwZShyZWZMYWJlbCk7XG4gICAgICBwYXJ0cy5wdXNoKFxuICAgICAgICBgPGRpdiBkYXRhLXJlZmJvdW5kYXJ5PVwiJHtsYWJlbEF0dHJ9XCI+PC9kaXY+XFxuXFxuJHthZ2VudENvbnRlbnQucmVwbGFjZSgvXFxzKyQvLCBcIlwiKX1gLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcGFydHMucHVzaChhZ2VudENvbnRlbnQucmVwbGFjZSgvXFxzKyQvLCBcIlwiKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBwYXJ0cy5qb2luKFwiXFxuXFxuXCIpO1xufVxuXG5mdW5jdGlvbiBvcGVuQnJvd3Nlcih1cmw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjbWQgPVxuICAgIHByb2Nlc3MucGxhdGZvcm0gPT09IFwiZGFyd2luXCJcbiAgICAgID8gW1wib3BlblwiLCB1cmxdXG4gICAgICA6IHByb2Nlc3MucGxhdGZvcm0gPT09IFwid2luMzJcIlxuICAgICAgICA/IFtcImNtZFwiLCBcIi9jXCIsIFwic3RhcnRcIiwgXCJcIiwgdXJsXVxuICAgICAgICA6IFtcInhkZy1vcGVuXCIsIHVybF07XG4gIHRyeSB7XG4gICAgQnVuLnNwYXduKHsgY21kLCBzdGRvdXQ6IFwiaWdub3JlXCIsIHN0ZGVycjogXCJpZ25vcmVcIiB9KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYmVzdC1lZmZvcnQgKi9cbiAgfVxufVxuXG5mdW5jdGlvbiByYW5kSGV4KGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShieXRlcyk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgcmV0dXJuIEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuXG5mdW5jdGlvbiBpc29aTm9NaWxsaXMoZDogRGF0ZSk6IHN0cmluZyB7XG4gIC8vIE1hdGNoIFB5dGhvbidzIHN0cmZ0aW1lKFwiJVktJW0tJWRUJUg6JU06JVNaXCIpIOKAlCBubyBmcmFjdGlvbmFsIHNlY29uZHMuXG4gIHJldHVybiBkLnRvSVNPU3RyaW5nKCkucmVwbGFjZSgvXFwuXFxkezN9WiQvLCBcIlpcIik7XG59XG5cbmNvbnN0IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5odG1sXCI6IFwidGV4dC9odG1sOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmNzc1wiOiBcInRleHQvY3NzOyBjaGFyc2V0PXV0Zi04XCIsXG4gIFwiLmpzXCI6IFwiYXBwbGljYXRpb24vamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOFwiLFxuICBcIi5qc29uXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5naWZcIjogXCJpbWFnZS9naWZcIixcbiAgXCIuc3ZnXCI6IFwiaW1hZ2Uvc3ZnK3htbFwiLFxuICBcIi53ZWJwXCI6IFwiaW1hZ2Uvd2VicFwiLFxuICBcIi5pY29cIjogXCJpbWFnZS94LWljb25cIixcbiAgXCIud29mZlwiOiBcImZvbnQvd29mZlwiLFxuICBcIi53b2ZmMlwiOiBcImZvbnQvd29mZjJcIixcbiAgXCIudHRmXCI6IFwiZm9udC90dGZcIixcbiAgXCIub3RmXCI6IFwiZm9udC9vdGZcIixcbn07XG5cbmZ1bmN0aW9uIGd1ZXNzTWltZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBkb3QgPSBuYW1lLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgY29uc3QgZXh0ID0gZG90ID49IDAgPyBuYW1lLnNsaWNlKGRvdCkudG9Mb3dlckNhc2UoKSA6IFwiXCI7XG4gIHJldHVybiBNSU1FX0JZX0VYVFtleHRdIHx8IFwiYXBwbGljYXRpb24vb2N0ZXQtc3RyZWFtXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBmaWxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgcmVmZXJlbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCJEb2N1bWVudCBSZXZpZXdcIiB9LFxuICAgICAgICB0aGVtZTogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBcImRpZ2VzdGlmeVwiIH0sXG4gICAgICAgIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIxODAwXCIgfSxcbiAgICAgICAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIsIGRlZmF1bHQ6IGZhbHNlIH0sXG4gICAgICAgIHBvcnQ6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogXCIwXCIgfSxcbiAgICAgICAgaG9zdDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBcIjEyNy4wLjAuMVwiIH0sXG4gICAgICAgIGlkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgIH0sXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBmYWxzZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgdiA9IHBhcnNlZC52YWx1ZXM7XG4gIGNvbnN0IHRoZW1lID0gdi50aGVtZSBhcyBzdHJpbmc7XG4gIGlmICghVkFMSURfVEhFTUVTLmluY2x1ZGVzKHRoZW1lIGFzICh0eXBlb2YgVkFMSURfVEhFTUVTKVtudW1iZXJdKSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYGVycm9yOiBpbnZhbGlkIC0tdGhlbWUgJyR7dGhlbWV9JyAoYWxsb3dlZDogJHtWQUxJRF9USEVNRVMuam9pbihcIiwgXCIpfSlcXG5gLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgdGltZW91dCA9IHBhcnNlRmxvYXQodi50aW1lb3V0IGFzIHN0cmluZyk7XG4gIGxldCBwb3J0ID0gcGFyc2VJbnQodi5wb3J0IGFzIHN0cmluZywgMTApO1xuICBjb25zdCBob3N0ID0gdi5ob3N0IGFzIHN0cmluZztcbiAgbGV0IHNlc3Npb25JZCA9ICh2LmlkIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gXCJcIjtcblxuICAvLyBIb25vciB0aGUgcG9ydCBiYWtlZCBpbnRvIGFuIGF1dG8tZ2VuZXJhdGVkIHNlc3Npb24gaWQgKHJlbGF1bmNoIGNhc2UpLlxuICBpZiAocG9ydCA9PT0gMCAmJiBzZXNzaW9uSWQpIHtcbiAgICBjb25zdCBlbWJlZGRlZCA9IHBhcnNlUG9ydEZyb21TZXNzaW9uSWQoc2Vzc2lvbklkKTtcbiAgICBpZiAoZW1iZWRkZWQgIT09IG51bGwpIHBvcnQgPSBlbWJlZGRlZDtcbiAgfVxuXG4gIGxldCBtYXJrZG93bjogc3RyaW5nO1xuICB0cnkge1xuICAgIG1hcmtkb3duID0gYXdhaXQgcmVhZElucHV0KHtcbiAgICAgIGZpbGU6IHYuZmlsZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICByZWZlcmVuY2U6IHYucmVmZXJlbmNlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgJiYgZS5jb2RlID09PSBcIkVOT0VOVFwiKSB7XG4gICAgICBjb25zdCBwYXRoID0gXCJwYXRoXCIgaW4gZSA/IGUucGF0aCA6IHVuZGVmaW5lZDtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogZmlsZSBub3QgZm91bmQ6ICR7cGF0aCA/PyBcIjx1bmtub3duPlwifVxcbmApO1xuICAgICAgcmV0dXJuIDI7XG4gICAgfVxuICAgIHRocm93IGU7XG4gIH1cbiAgaWYgKCFtYXJrZG93bi50cmltKCkpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcImVycm9yOiBubyBtYXJrZG93biBwcm92aWRlZCBvbiBzdGRpbiwgLS1maWxlLCBvciAtLXJlZmVyZW5jZVxcblwiKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIC8vIEJ1aWxkIHBheWxvYWQgd2l0aCBhIHBsYWNlaG9sZGVyIHNlc3Npb25faWQ7IGZpbmFsaXplIGFmdGVyIHdlIGtub3cgdGhlXG4gIC8vIGJvdW5kIHBvcnQgKHdlIG5lZWQgdGhlIHBvcnQgdG8gZW5jb2RlIGl0IGludG8gdGhlIGF1dG8tZ2VuZXJhdGVkIGlkKS5cbiAgbGV0IHBheWxvYWQ6IFBheWxvYWQ7XG4gIHRyeSB7XG4gICAgcGF5bG9hZCA9IGJ1aWxkUGF5bG9hZChtYXJrZG93biwge1xuICAgICAgdGl0bGU6IHYudGl0bGUgYXMgc3RyaW5nLFxuICAgICAgdGhlbWUsXG4gICAgICBzZXNzaW9uSWQ6IHNlc3Npb25JZCB8fCBcIl9fVEJEX19cIixcbiAgICAgIHRpbWVvdXQsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZXJyb3I6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgLy8gUmVzb2x2ZWQgQkVGT1JFIHRoZSBzZXJ2ZXIgYmluZHMgYW5kIGJlZm9yZSBhbnl0aGluZyBpcyB3cml0dGVuLCBzbyBhXG4gIC8vIGZvcmNlZC1kZXYgYm9vdCBhdCBhIHN1cmZhY2UtZnJlZSBkZXN0aW5hdGlvbiBkaWVzIEhFUkUsIGhhdmluZyBkb25lXG4gIC8vIG5vdGhpbmcuXG4gIGNvbnN0IG1vZGUgPSByZXNvbHZlTW9kZSgpO1xuXG4gIC8vIOKblCBDT05UUkFDVCA1IExBTkRTIE9OIFdIT0VWRVIgU1BBV05TIFRIRSBEQUVNT04g4oCUIEFORCBOT1RISU5HIFNQQVdOUyBUSElTXG4gIC8vIE9ORS4gRXZlcnkgb3RoZXIgcG9ydGVkIHNwZWxsIGhhcyBhIGBjbGkudHNgIHRoYXQgcGlucyB0aGUgZGFlbW9uJ3MgY3dkIHRvXG4gIC8vIHNyYy88c3BlbGw+LyBzbyBCdW4gY2FuIHJlYWQgdGhhdCBkaXJlY3RvcnkncyBidW5maWcudG9tbCBhbmQgbG9hZCB0aGVcbiAgLy8gVGFpbHdpbmQgcGx1Z2luLiBEaWdlc3RpZnkncyBkYWVtb24gSVMgdGhlIHByb2Nlc3MgdGhlIGFnZW50IHJ1bnMsIGZyb21cbiAgLy8gd2hhdGV2ZXIgZGlyZWN0b3J5IHRoZSBjb252ZXJzYXRpb24gaXMgaW4sIHNvIHRoZXJlIGlzIG5vIHNwYXduZXIgdG8gcGluLlxuICAvL1xuICAvLyBBbmQgYHByb2Nlc3MuY2hkaXIoKWAgZG9lcyBub3QgcmVzY3VlIGl0OiBNRUFTVVJFRCAyMDI2LTA5LTA3IOKAlCBCdW4gcmVhZHNcbiAgLy8gYnVuZmlnLnRvbWwgYXQgcHJvY2VzcyBTVEFSVCwgc28gY2hkaXItdGhlbi1pbXBvcnQgYnVuZGxlcyB0aGUgcGFnZSwgc2VydmVzXG4gIC8vIGl0LCBhbmQgZmFpbHMgdG8gcGFyc2UgYEBpbXBvcnQgXCJ0YWlsd2luZGNzc1wiIHNvdXJjZShub25lKWAgYXQgcmVxdWVzdCB0aW1lLlxuICAvLyBUaGUgcGFnZSBjb21lcyBiYWNrIHVuc3R5bGVkIHdpdGggYSBncmVlbiBidWlsZCBhbmQgbm8gZXJyb3Igb24gdGhlIGRhZW1vbi5cbiAgLy9cbiAgLy8gU28gdGhlIGRhZW1vbiBjaGVja3MgaXRzIG93biBjd2QgYW5kIFJFRlVTRVMsIGxvdWRseSwgbmFtaW5nIHRoZSBkaXJlY3RvcnkuXG4gIC8vIEEgaGFyZCBleGl0IGlzIHRoZSByaWdodCBzaGFwZTogdGhlIGFsdGVybmF0aXZlIGlzIHRoZSBzaWxlbnQtdW5zdHlsZWRcbiAgLy8gZGVmZWN0IGZvdXIgc3BlbGxzJyBjb21tZW50cyBkZXNjcmliZSBhbmQgbm9ib2R5IGhhZCBydW4uXG4gIGNvbnN0IERFVl9TVVJGQUNFX0NXRCA9IGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcImRpZ2VzdGlmeVwiKTtcbiAgbGV0IGRldkluZGV4OiB1bmtub3duO1xuICBpZiAobW9kZSA9PT0gXCJkZXZcIikge1xuICAgIC8vIOKblCBUSEUgVEVTVCBJUyBcIkRPRVMgVEhJUyBidW5maWcgTE9BRCBUSEUgVEFJTFdJTkQgUExVR0lOXCIsIE5PVCBcIklTIFRIRVJFXG4gICAgLy8gQSBidW5maWdcIi4gVGhlIGZpcnN0IGRyYWZ0IGFza2VkIG9ubHkgd2hldGhlciB0aGUgZmlsZSBleGlzdGVkLCBhbmQgdGhlXG4gICAgLy8gUkVQTyBST09UIGhhcyBvbmUg4oCUIGFuIGBbaW5zdGFsbF0gbGlua2VyYCBwaW4gd2l0aCBubyBwbHVnaW5zIGluIGl0LiBGcm9tXG4gICAgLy8gdGhlcmUgdGhlIGRhZW1vbiBib290ZWQgaGFwcGlseSwgYW5ub3VuY2VkIGBtb2RlOlwiZGV2XCJgLCBhbmQgc2VydmVkIEJ1bidzXG4gICAgLy8gb3duIGA8dGl0bGU+QnVuIC0gQnVpbGQgRmFpbGVkPC90aXRsZT5gIHBhZ2U6IGEgZ3JlZW4gYm9vdCBvdmVyIGEgcGFnZVxuICAgIC8vIHRoYXQgbmV2ZXIgcmVuZGVycywgd2hpY2ggaXMgQ29udHJhY3QgNSdzIHNjYXIgd2VhcmluZyBuZXcgY2xvdGhlcy4gQW5kXG4gICAgLy8gdGhlIHJlcG8gcm9vdCBpcyB0aGUgbGlrZWxpZXN0IGN3ZCBhbiBhZ2VudCBhY3R1YWxseSBoYXMuXG4gICAgY29uc3QgYnVuZmlnID0gam9pbihwcm9jZXNzLmN3ZCgpLCBcImJ1bmZpZy50b21sXCIpO1xuICAgIGNvbnN0IGxvYWRzVGFpbHdpbmQgPVxuICAgICAgZXhpc3RzU3luYyhidW5maWcpICYmIHJlYWRGaWxlU3luYyhidW5maWcsIFwidXRmOFwiKS5pbmNsdWRlcyhUQUlMV0lORF9QTFVHSU4pO1xuICAgIGlmICghbG9hZHNUYWlsd2luZCkge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIFwiZGlnZXN0aWZ5OiBjYW5ub3Qgc3RhcnQgaW4gZGV2IG1vZGUgZnJvbSB0aGlzIGRpcmVjdG9yeS5cXG5cIiArXG4gICAgICAgICAgYCAgY3dkOiAgICAke3Byb2Nlc3MuY3dkKCl9XFxuYCArXG4gICAgICAgICAgYCAgbmVlZGVkOiBhIGN3ZCB3aG9zZSBidW5maWcudG9tbCBsb2FkcyAke1RBSUxXSU5EX1BMVUdJTn0g4oCUIGluIGEgY2hlY2tvdXQgb2ZcXG5gICtcbiAgICAgICAgICBgICAgICAgICAgIHRoaXMgcmVwbyB0aGF0IGlzICR7REVWX1NVUkZBQ0VfQ1dEfVxcbmAgK1xuICAgICAgICAgIFwiICB3aHk6ICAgIEJ1biByZWFkcyBidW5maWcudG9tbCBmcm9tIHRoZSBwcm9jZXNzIGN3ZCwgYXQgU1RBUlRVUCDigJQgY2hkaXIgaXNcXG5cIiArXG4gICAgICAgICAgXCIgICAgICAgICAgdG9vIGxhdGUuIFdpdGhvdXQgdGhlIHBsdWdpbiB0aGUgc3R5bGVzaGVldCBuZXZlciBjb21waWxlcyBhbmQgdGhlXFxuXCIgK1xuICAgICAgICAgIFwiICAgICAgICAgIHBhZ2UgaXMgc2VydmVkIHVuc3R5bGVkLCBvciBhcyBCdW4ncyBvd24gYnVpbGQtZmFpbHVyZSBwYWdlLCB3aXRoXFxuXCIgK1xuICAgICAgICAgIFwiICAgICAgICAgIG5vdGhpbmcgcmVkIGFueXdoZXJlLlxcblwiICtcbiAgICAgICAgICBcIiAgQSBwdWJsaXNoZWQgc3BlbGwgc2hpcHMgYSBidWlsdCBkaXN0LyBhbmQgcmVzb2x2ZXMgdG8gcmVsZWFzZSBtb2RlOyBkZXYgbW9kZVxcblwiICtcbiAgICAgICAgICBcIiAgbmVlZHMgdGhlIHJlcG8uIFVuc2V0IFNQRUxMQk9PS19TVVJGQUNFX01PREUsIG9yIHJ1biBmcm9tIHRoYXQgZGlyZWN0b3J5LlxcblwiLFxuICAgICAgKTtcbiAgICAgIHJldHVybiAyO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgZGV2SW5kZXggPSAoYXdhaXQgaW1wb3J0KFwiLi4vLi4vLi4vLi4vLi4vc3JjL2RpZ2VzdGlmeS9zdXJmYWNlL2luZGV4Lmh0bWxcIikpLmRlZmF1bHQ7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgLy8g4puUIFRIRSBGQUlMVVJFIE1VU1QgTkFNRSBUSEUgU1VSRkFDRS4gQSBmb3JjZWQtZGV2IGJvb3QgYXQgYVxuICAgICAgLy8gc3VyZmFjZS1mcmVlIGRlc3RpbmF0aW9uIG90aGVyd2lzZSBkaWVzIHdpdGggYSBtb2R1bGUtcmVzb2x1dGlvbiBlcnJvclxuICAgICAgLy8gdGhlIG9wZXJhdG9yIGNhbm5vdCB0ZWxsIGZyb20gYSBtaXNzaW5nIGBidW5gLlxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIFwiZGlnZXN0aWZ5OiBjYW5ub3Qgc3RhcnQgaW4gZGV2IG1vZGUg4oCUIHRoZSBzdXJmYWNlIHNvdXJjZSBpcyBtaXNzaW5nLlxcblwiICtcbiAgICAgICAgICBcIiAgbmVlZGVkOiBzcmMvZGlnZXN0aWZ5L3N1cmZhY2UvaW5kZXguaHRtbCAocmVsYXRpdmUgdG8gdGhlIHJlcG8gcm9vdClcXG5cIiArXG4gICAgICAgICAgYCAgcmVhc29uOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gICtcbiAgICAgICAgICBcIiAgQSBwdWJsaXNoZWQgc3BlbGwgc2hpcHMgYSBidWlsdCBkaXN0LyBhbmQgcmVzb2x2ZXMgdG8gcmVsZWFzZSBtb2RlOyBkZXYgbW9kZVxcblwiICtcbiAgICAgICAgICBcIiAgbmVlZHMgdGhlIHJlcG8uIFVuc2V0IFNQRUxMQk9PS19TVVJGQUNFX01PREUsIG9yIHJ1biBmcm9tIGEgY2hlY2tvdXQuXFxuXCIsXG4gICAgICApO1xuICAgICAgcmV0dXJuIDI7XG4gICAgfVxuICB9XG5cbiAgLy8gVGhlIHBhZ2UncyBIVE1MIFNPVVJDRSwgYmVmb3JlIHN1YnN0aXR1dGlvbi4gSW4gcmVsZWFzZSBpdCBpcyB0aGUgY29tbWl0dGVkXG4gIC8vIGRpc3QvaW5kZXguaHRtbCwgcmVhZCBvbmNlLiBJbiBkZXYgaXQgaXMgd2hhdGV2ZXIgQnVuJ3MgYnVuZGxlciBwcm9kdWNlcyxcbiAgLy8gZmV0Y2hlZCBmcm9tIHRoaXMgc2FtZSBzZXJ2ZXIncyBwcml2YXRlIHN1cmZhY2Ugcm91dGUgYXQgcmVxdWVzdCB0aW1lIChzZWVcbiAgLy8gdGhlIFwiL1wiIGhhbmRsZXIpIOKAlCB0aGUgYnVuZGxlciBvd25zIHRoZSByZXNwb25zZSBhbmQgdGhlcmUgaXMgbm8gd2F5IHRvIGFza1xuICAvLyBpdCBmb3IgdGhlIHRleHQgZGlyZWN0bHkuXG4gIGNvbnN0IHJlbGVhc2VUZW1wbGF0ZSA9XG4gICAgbW9kZSA9PT0gXCJyZWxlYXNlXCIgPyBhd2FpdCBCdW4uZmlsZShqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpLnRleHQoKSA6IFwiXCI7XG4gIC8vIERlcml2ZWQgZnJvbSB0aGUgZXhwbGljaXQgU0tJTExfUk9PVCByYXRoZXIgdGhhbiByZS1jb3VudGVkIGZyb21cbiAgLy8gU0NSSVBUX0RJUi4gU2FtZSBkaXJlY3RvcnksIGFuZCBpdCB3YXMgdGhlIHNhbWUgZGlyZWN0b3J5IGJlZm9yZSB0aGVcbiAgLy8gcmVsb2NhdGlvbiB0b28g4oCUIGJ1dCBhIGAuLmAgY291bnRlZCBhdCBhIHNlY29uZCBzaXRlIGlzIHRoZSByZXBhaXIgdGhhdFxuICAvLyByb3RzIChwbGF5Ym9vayBQaGFzZSBCLCBCNiksIGFuZCB0aGlzIGlzIHRoZSBzcGVsbCdzIG90aGVyIHBhdGgtcGlubmVkXG4gIC8vIHNpYmxpbmc6IHRoZSB3b3JkbWFya3MsIG1hc2NvdHMgYW5kIHNlbnQtcGFnZSBpbGx1c3RyYXRpb25zIHVuZGVyXG4gIC8vIGA8c2tpbGw+L2Fzc2V0cy9gLCB3aGljaCBhcmUgTk9UIGJ1aWxkIGlucHV0cyBhbmQgYXJlIHNlcnZlZCBieSB0aGVcbiAgLy8gYC9hc3NldHMvYCByb3V0ZSBiZWxvdy5cbiAgY29uc3QgYXNzZXRzRGlyID0gam9pbihTS0lMTF9ST09ULCBcImFzc2V0c1wiKTtcblxuICAvLyBUaGUgc3Vic3RpdHV0aW9uIHRoZSBwYWdlJ3Mgd2hvbGUgc3RhdGUgYXJyaXZlcyB0aHJvdWdoLiBBcHBsaWVkIHRvIHRoZVxuICAvLyBCVUlMVCBodG1sIElOIE1FTU9SWSBhdCBzZXJ2ZSB0aW1lLCBzbyBkaXN0LyBzdGF5cyBieXRlLXN0YWJsZSBhbmRcbiAgLy8gQ29udHJhY3QgMTgncyByZXByb2R1Y3Rpb24gY2hlY2sgaXMgdW5hZmZlY3RlZC5cbiAgLy9cbiAgLy8g4pqgIE5FSVRIRVIgUkVQTEFDRSBJUyBHTE9CQUwsIGFuZCB0aGF0IGlzIHRoZSBzaGlwcGVkIGJlaGF2aW91cjogb25seSB0aGVcbiAgLy8gRklSU1Qgb2NjdXJyZW5jZSBvZiBlYWNoIHRva2VuIGlzIHN1YnN0aXR1dGVkLiBpbmRleC5odG1sIGNhcnJpZXMgZWFjaFxuICAvLyBleGFjdGx5IG9uY2UgKGFzc2VydGVkIGJ5IHNjcmlwdHMvcmVsZWFzZS1zZXJ2ZS50ZXN0LnRzKS5cbiAgbGV0IHN1YnN0aXR1dGU6IChodG1sOiBzdHJpbmcpID0+IHN0cmluZyA9IChodG1sKSA9PiBodG1sO1xuICBsZXQgaGVhcnRiZWF0QXQgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgLy8gYjQg4oCUIHdoYXQgdGhlIHN1cmZhY2UgdG9sZCB1cyBhYm91dCB0aGUgaHVtYW4ncyBkZXBhcnR1cmUsIGFuZCB3aGV0aGVyIHRoZVxuICAvLyBwYWdlIHdhcyBldmVyIHNlcnZlZCBhdCBhbGwuIEJvdGggYXJlIFJFQ09SRFMsIG5vdCByZXNvbHV0aW9uczogbmVpdGhlciBlbmRzXG4gIC8vIHRoZSBzZXNzaW9uIChzZWUgUE9TVCAvbGVmdCkuXG4gIHR5cGUgRGVwYXJ0dXJlID0ge1xuICAgIGVuZ2FnZWQ6IGJvb2xlYW47XG4gICAgZWxhcHNlZE1zOiBudW1iZXIgfCBudWxsO1xuICAgIGFuc3dlcmVkOiBudW1iZXIgfCBudWxsO1xuICAgIGNvbW1lbnRlZDogbnVtYmVyIHwgbnVsbDtcbiAgICAvKiogVHJ1ZSB3aGVuIHRoZSBiZWFjb24gbmFtZWQgYSBzZXNzaW9uIHRoYXQgaXMgbm90IHRoaXMgb25lIOKAlCBhIHRhYiBsZWZ0XG4gICAgICogIG92ZXIgZnJvbSBhIHJldmlldyB0aGlzIGRhZW1vbiByZXBsYWNlZCBvbiB0aGUgc2FtZSByZS1ib3VuZCBwb3J0LiBUaGVcbiAgICAgKiAgZmFjdCBpcyBzdGlsbCB3b3J0aCByZWNvcmRpbmc7IGl0IGp1c3QgbXVzdCBub3QgZW5kIHRoZSBzZXNzaW9uLiAqL1xuICAgIHN0YWxlOiBib29sZWFuO1xuICB9O1xuICBsZXQgZGVwYXJ0dXJlOiBEZXBhcnR1cmUgfCBudWxsID0gbnVsbDtcbiAgbGV0IHBhZ2VTZXJ2ZWQgPSBmYWxzZTtcblxuICBsZXQgcmVzb2x2ZURvbmUhOiAodmFsOiBEb25lUmVzdWx0KSA9PiB2b2lkO1xuICBjb25zdCBkb25lID0gbmV3IFByb21pc2U8RG9uZVJlc3VsdD4oKHJlcykgPT4ge1xuICAgIHJlc29sdmVEb25lID0gcmVzO1xuICB9KTtcblxuICBsZXQgc2VydmVyOiBSZXR1cm5UeXBlPHR5cGVvZiBCdW4uc2VydmU+O1xuICB0cnkge1xuICAgIHNlcnZlciA9IEJ1bi5zZXJ2ZSh7XG4gICAgICBwb3J0LFxuICAgICAgaG9zdG5hbWU6IGhvc3QsXG4gICAgICAvLyBEZXYgb25seSwgYW5kIGRlbGliZXJhdGVseSBOT1QgXCIvXCI6IHRoZSBidW5kbGVyIHdvdWxkIHRoZW4gb3duIHRoZVxuICAgICAgLy8gcmVzcG9uc2UgYW5kIHRoZSBwYXlsb2FkIGNvdWxkIG5ldmVyIGJlIGluamVjdGVkLiBcIi9cIiBzdGF5cyB0aGlzXG4gICAgICAvLyBtb2R1bGUncywgYW5kIHJlYWRzIHRoZSBidW5kbGUgdGhyb3VnaCBoZXJlLlxuICAgICAgcm91dGVzOiAoZGV2SW5kZXggPyB7IFtERVZfU1VSRkFDRV9ST1VURV06IGRldkluZGV4IH0gOiB7fSkgYXMgUmVjb3JkPHN0cmluZywgbmV2ZXI+LFxuICAgICAgZmV0Y2g6IGFzeW5jIChyZXEpID0+IHtcbiAgICAgICAgY29uc3QgdXJsID0gbmV3IFVSTChyZXEudXJsKTtcbiAgICAgICAgY29uc3QgcGF0aCA9IHVybC5wYXRobmFtZTtcbiAgICAgICAgY29uc3QgbWV0aG9kID0gcmVxLm1ldGhvZDtcblxuICAgICAgICBpZiAobWV0aG9kID09PSBcIkdFVFwiICYmIHBhdGggPT09IFwiL1wiKSB7XG4gICAgICAgICAgLy8gYjQg4oCUIHRoZSBPTkUgb2JzZXJ2YWJsZSB0aGF0IHNlcGFyYXRlcyBcIm5vYm9keSBldmVyIG9wZW5lZCBpdFwiIGZyb21cbiAgICAgICAgICAvLyBcIm9wZW5lZCBhbmQgdGhlbiB3ZW50IHF1aWV0XCIuIFdpdGhvdXQgaXQgdGhvc2UgdHdvIGFyZSB0aGUgc2FtZVxuICAgICAgICAgIC8vIHRpbWVvdXQsIHdoaWNoIGlzIGhhbGYgb2Ygd2hhdCBtYWRlIGEgY2FuY2VsbGVkIHJldmlldyB1bnJlcG9ydGFibGUuXG4gICAgICAgICAgcGFnZVNlcnZlZCA9IHRydWU7XG4gICAgICAgICAgLy8gRGV2OiBhc2sgdGhpcyBzYW1lIHNlcnZlcidzIHByaXZhdGUgc3VyZmFjZSByb3V0ZSBmb3IgdGhlIGJ1bmRsZXInc1xuICAgICAgICAgIC8vIEhUTUwsIHRoZW4gc3Vic3RpdHV0ZS4gQnVuIG93bnMgdGhlIEhUTUxCdW5kbGUgcmVzcG9uc2UgYW5kIG9mZmVyc1xuICAgICAgICAgIC8vIG5vIHdheSB0byByZWFkIGl0IGFzIHRleHQsIGFuZCB0aGUgcGF5bG9hZCBNVVNUIGJlIGluamVjdGVkIChhXG4gICAgICAgICAgLy8gR0VUIC9wYXlsb2FkIHJvdXRlIHdvdWxkIGJlIG5ldyBiZWhhdmlvdXIgYW5kIGEgbmV3IGZhaWx1cmUgbW9kZSkuXG4gICAgICAgICAgLy8gUmVsZWFzZTogdGhlIGNvbW1pdHRlZCBkaXN0L2luZGV4Lmh0bWwsIHJlYWQgb25jZSBhdCBib290LlxuICAgICAgICAgIGNvbnN0IHNvdXJjZSA9XG4gICAgICAgICAgICBtb2RlID09PSBcImRldlwiXG4gICAgICAgICAgICAgID8gYXdhaXQgKGF3YWl0IGZldGNoKGBodHRwOi8vJHtob3N0fToke3NlcnZlci5wb3J0fSR7REVWX1NVUkZBQ0VfUk9VVEV9YCkpLnRleHQoKVxuICAgICAgICAgICAgICA6IHJlbGVhc2VUZW1wbGF0ZTtcbiAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKHN1YnN0aXR1dGUoc291cmNlKSwge1xuICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcInRleHQvaHRtbDsgY2hhcnNldD11dGYtOFwiIH0sXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1ldGhvZCA9PT0gXCJHRVRcIiAmJiBtb2RlID09PSBcInJlbGVhc2VcIikge1xuICAgICAgICAgIGNvbnN0IGFzc2V0ID0gc2VydmVEaXN0KHBhdGgpO1xuICAgICAgICAgIGlmIChhc3NldCkgcmV0dXJuIGFzc2V0O1xuICAgICAgICB9XG4gICAgICAgIGlmIChtZXRob2QgPT09IFwiR0VUXCIgJiYgcGF0aC5zdGFydHNXaXRoKFwiL2Fzc2V0cy9cIikpIHtcbiAgICAgICAgICBjb25zdCBhc3NldE5hbWUgPSBkZWNvZGVVUklDb21wb25lbnQocGF0aC5zbGljZShcIi9hc3NldHMvXCIubGVuZ3RoKSk7XG4gICAgICAgICAgLy8gUGF0aC10cmF2ZXJzYWwgZ3VhcmQuIFRoZSBQeXRob24gdmVyc2lvbiB1c2VzIHJlc29sdmUoKStwYXJlbnRzXG4gICAgICAgICAgLy8gY29udGFpbm1lbnQ7IHJlZnVzaW5nIGFueSBcIi4uXCIgc2VnbWVudCBhY2hpZXZlcyB0aGUgc2FtZSBnb2FsXG4gICAgICAgICAgLy8gaGVyZSBhbmQgYXZvaWRzIG5lZWRpbmcgcmVhbHBhdGguXG4gICAgICAgICAgaWYgKGFzc2V0TmFtZS5pbmNsdWRlcyhcIi4uXCIpIHx8IGFzc2V0TmFtZS5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcIm5vdCBmb3VuZFwifScsIHtcbiAgICAgICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICBjb25zdCBmID0gQnVuLmZpbGUoam9pbihhc3NldHNEaXIsIGFzc2V0TmFtZSkpO1xuICAgICAgICAgIGlmICghKGF3YWl0IGYuZXhpc3RzKCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFJlc3BvbnNlKCd7XCJlcnJvclwiOlwibm90IGZvdW5kXCJ9Jywge1xuICAgICAgICAgICAgICBzdGF0dXM6IDQwNCxcbiAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoZiwgeyBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IGd1ZXNzTWltZShhc3NldE5hbWUpIH0gfSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKG1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvc3VibWl0XCIpIHtcbiAgICAgICAgICBsZXQgYm9keTogU3VibWl0Qm9keTtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYm9keSA9IChhd2FpdCByZXEuanNvbigpKSBhcyBTdWJtaXRCb2R5O1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wiZXJyb3JcIjpcImludmFsaWQganNvblwifScsIHtcbiAgICAgICAgICAgICAgc3RhdHVzOiA0MDAsXG4gICAgICAgICAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDAsIGRhdGE6IGJvZHkgfSk7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wib2tcIjp0cnVlfScsIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IH0pO1xuICAgICAgICB9XG4gICAgICAgIC8vIGI0IOKAlCB0aGUgc3VyZmFjZSBiZWFjb25zIGhlcmUgb24gRVZFUlkgZGVwYXJ0dXJlLCBlbmdhZ2VkIG9yIG5vdFxuICAgICAgICAvLyAoY2lyY2UncyBiNHMsIGZiZmUxZDMpLiBSRUNPUkQtT05MWSBCWSBDT05UUkFDVDogdGhpcyByb3V0ZSBtdXN0IG5ldmVyXG4gICAgICAgIC8vIGNhbGwgcmVzb2x2ZURvbmUuIFRoYXQgaXMgdGhlIHdob2xlIHNhZmV0eSBvZiB0aGUgc2VhbSDigJQgL2NhbmNlbCBzdGlsbFxuICAgICAgICAvLyBvd25zIGVuZGluZyB0aGUgc2Vzc2lvbiwgc28gYSByZWZyZXNoIGNhbm5vdCBraWxsIG9uZSwgYW5kIGV4aXQgMTMwXG4gICAgICAgIC8vIGtlZXBzIG1lYW5pbmcgXCJjbG9zZWQgdGhlIHRhYiBBRlRFUiBpbnRlcmFjdGluZ1wiIGV4YWN0bHkgYXNcbiAgICAgICAgLy8gaG91c2Utc3R5bGUncyBleGl0LWNvZGUgY29udHJhY3QgZGVmaW5lcyBpdC5cbiAgICAgICAgLy9cbiAgICAgICAgLy8gQSByb3V0ZSBuYW1lZCBmb3IgYSB2ZXJiIG11c3QgYWx3YXlzIHBlcmZvcm0gdGhhdCB2ZXJiOiB0aGlzIGlzIHdoeVxuICAgICAgICAvLyB0aGUgc2VhbSBpcyBhIHNlcGFyYXRlIHJvdXRlIHJhdGhlciB0aGFuIGEgZmxhZyBvbiAvY2FuY2VsLCB3aGljaFxuICAgICAgICAvLyB3b3VsZCBtYWtlIG9uZSByb3V0ZSBzb21ldGltZXMgcmVzb2x2ZSBhbmQgc29tZXRpbWVzIG5vdC5cbiAgICAgICAgaWYgKG1ldGhvZCA9PT0gXCJQT1NUXCIgJiYgcGF0aCA9PT0gXCIvbGVmdFwiKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGIgPSAoYXdhaXQgcmVxLmpzb24oKSkgYXMgUGFydGlhbDxEZXBhcnR1cmU+ICYgeyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgICAgICBjb25zdCBuYW1lZCA9IHR5cGVvZiBiLnNlc3Npb25JZCA9PT0gXCJzdHJpbmdcIiA/IGIuc2Vzc2lvbklkIDogbnVsbDtcbiAgICAgICAgICAgIGRlcGFydHVyZSA9IHtcbiAgICAgICAgICAgICAgZW5nYWdlZDogYi5lbmdhZ2VkID09PSB0cnVlLFxuICAgICAgICAgICAgICBlbGFwc2VkTXM6IHR5cGVvZiBiLmVsYXBzZWRNcyA9PT0gXCJudW1iZXJcIiA/IGIuZWxhcHNlZE1zIDogbnVsbCxcbiAgICAgICAgICAgICAgYW5zd2VyZWQ6IHR5cGVvZiBiLmFuc3dlcmVkID09PSBcIm51bWJlclwiID8gYi5hbnN3ZXJlZCA6IG51bGwsXG4gICAgICAgICAgICAgIGNvbW1lbnRlZDogdHlwZW9mIGIuY29tbWVudGVkID09PSBcIm51bWJlclwiID8gYi5jb21tZW50ZWQgOiBudWxsLFxuICAgICAgICAgICAgICBzdGFsZTogbmFtZWQgIT09IG51bGwgJiYgbmFtZWQgIT09IHNlc3Npb25JZCxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgICAvLyBBIG1hbGZvcm1lZCBiZWFjb24gc3RpbGwgbWVhbnMgU09NRUJPRFkgTEVGVCDigJQgdGhhdCBmYWN0IGlzIHRoZVxuICAgICAgICAgICAgLy8gcG9pbnQgb2YgdGhlIHJvdXRlLCBhbmQgZGlzY2FyZGluZyBpdCB3b3VsZCByZXN0b3JlIHRoZSB2ZXJ5XG4gICAgICAgICAgICAvLyBzaWxlbmNlIGI0IGV4aXN0cyB0byByZW1vdmUuIFJlY29yZCB0aGUgZGVwYXJ0dXJlIHdpdGggdW5rbm93blxuICAgICAgICAgICAgLy8gZGV0YWlsIHJhdGhlciB0aGFuIG5vdGhpbmcuXG4gICAgICAgICAgICBkZXBhcnR1cmUgPSB7XG4gICAgICAgICAgICAgIGVuZ2FnZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICBlbGFwc2VkTXM6IG51bGwsXG4gICAgICAgICAgICAgIGFuc3dlcmVkOiBudWxsLFxuICAgICAgICAgICAgICBjb21tZW50ZWQ6IG51bGwsXG4gICAgICAgICAgICAgIHN0YWxlOiBmYWxzZSxcbiAgICAgICAgICAgIH07XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UobnVsbCwgeyBzdGF0dXM6IDIwNCB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9jYW5jZWxcIikge1xuICAgICAgICAgIC8vIOKblCAvY2FuY2VsIEVORFMgVEhJUyBTRVNTSU9OLCBOT1QgV0hPRVZFUiBIT0xEUyBUSEUgUE9SVC5cbiAgICAgICAgICAvL1xuICAgICAgICAgIC8vIFJlY292ZXJ5IHJlLWJpbmRzIHRoZSBwb3J0IGVuY29kZWQgaW4gdGhlIHNlc3Npb24gaWQgc28gdGhlXG4gICAgICAgICAgLy8gcmVsYXVuY2hlZCBwYWdlIGxhbmRzIG9uIHRoZSBzYW1lIG9yaWdpbiBhbmQgaW5oZXJpdHMgaXRzXG4gICAgICAgICAgLy8gbG9jYWxTdG9yYWdlIGRyYWZ0LiBUaGF0IGxlYXZlcyB0aGUgdXNlcidzIE9MRCB0YWIgcG9pbnRlZCBhdCB0aGVcbiAgICAgICAgICAvLyBzYW1lIG9yaWdpbiwgc28gY2xvc2luZyBpdCBhZnRlciBhIHJlbGF1bmNoIGJlYWNvbmVkIC9jYW5jZWwgaW50b1xuICAgICAgICAgIC8vIHRoZSBORVcgZGFlbW9uIGFuZCByZXNvbHZlZCAxMzAg4oCUIHRoZSByZXN0b3JlZCByZXZpZXcgZGllZCB0aGVcbiAgICAgICAgICAvLyBtb21lbnQgdGhlIHVzZXIgdGlkaWVkIHVwIHRoZSB0YWIgaXQgd2FzIHJlc3RvcmVkIGZyb20uIEZvdW5kIGJ5XG4gICAgICAgICAgLy8gbG9zaW5nIGFuIGhvdXIgdG8gaXQgZHVyaW5nIHRoZSBwb3J0J3MgYnJvd3NlciBkcml2ZS5cbiAgICAgICAgICAvL1xuICAgICAgICAgIC8vIEEgYmVhY29uIHRoYXQgTkFNRVMgYSBkaWZmZXJlbnQgc2Vzc2lvbiBpcyB0aGVyZWZvcmUgaWdub3JlZC4gT25lXG4gICAgICAgICAgLy8gY2Fycnlpbmcgbm8gaWQgaXMgc3RpbGwgaG9ub3VyZWQ6IHRoZSByb3V0ZSBzdGF5cyBjYWxsYWJsZSBieSBoYW5kLFxuICAgICAgICAgIC8vIGFuZCB0aGUgb25seSBwYWdlIHRoYXQgY2FuIHNlbmQgYW4gaWQtbGVzcyBiZWFjb24gaXMgYSB0YWIgZnJvbSBhXG4gICAgICAgICAgLy8gcmVsZWFzZSBvbGRlciB0aGFuIHRoaXMgb25lLlxuICAgICAgICAgIGxldCBuYW1lZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IGIgPSAoYXdhaXQgcmVxLmpzb24oKSkgYXMgeyBzZXNzaW9uSWQ/OiB1bmtub3duIH07XG4gICAgICAgICAgICBpZiAodHlwZW9mIGIuc2Vzc2lvbklkID09PSBcInN0cmluZ1wiKSBuYW1lZCA9IGIuc2Vzc2lvbklkO1xuICAgICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgICAgLyogYW4gZW1wdHkgb3IgbWFsZm9ybWVkIGJvZHkgbmFtZXMgbm90aGluZyDigJQgaG9ub3VyZWQsIGFzIGFib3ZlICovXG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChuYW1lZCAhPT0gbnVsbCAmJiBuYW1lZCAhPT0gc2Vzc2lvbklkKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyBldmVudDogXCJzdGFsZV9jYW5jZWxfaWdub3JlZFwiLCBuYW1lZCwgY3VycmVudDogc2Vzc2lvbklkIH0pfVxcbmAsXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wib2tcIjp0cnVlLFwiaWdub3JlZFwiOlwic3RhbGUtc2Vzc2lvblwifScsIHtcbiAgICAgICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJlc29sdmVEb25lKHsgY29kZTogMTMwLCBkYXRhOiBudWxsIH0pO1xuICAgICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcIm9rXCI6dHJ1ZX0nLCB7IGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSB9KTtcbiAgICAgICAgfVxuICAgICAgICBpZiAobWV0aG9kID09PSBcIlBPU1RcIiAmJiBwYXRoID09PSBcIi9oZWFydGJlYXRcIikge1xuICAgICAgICAgIGhlYXJ0YmVhdEF0ID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IGV2ZW50OiBcImhlYXJ0YmVhdFwiLCBhdDogTWF0aC5yb3VuZChoZWFydGJlYXRBdCAvIDEwKSAvIDEwMCB9KX1cXG5gLFxuICAgICAgICAgICk7XG4gICAgICAgICAgcmV0dXJuIG5ldyBSZXNwb25zZSgne1wib2tcIjp0cnVlfScsIHsgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBuZXcgUmVzcG9uc2UoJ3tcImVycm9yXCI6XCJub3QgZm91bmRcIn0nLCB7XG4gICAgICAgICAgc3RhdHVzOiA0MDQsXG4gICAgICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgZXZlbnQ6IFwiYmluZF9lcnJvclwiLFxuICAgICAgICBob3N0LFxuICAgICAgICBwb3J0LFxuICAgICAgICBlcnJvcjogZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpLFxuICAgICAgfSl9XFxuYCxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgY29uc3QgYm91bmRQb3J0ID0gc2VydmVyLnBvcnQ7XG4gIGlmICghc2Vzc2lvbklkKSB7XG4gICAgc2Vzc2lvbklkID0gYGRpZ2VzdGlmeS0ke3JhbmRIZXgoNCl9LXAke2JvdW5kUG9ydH1gO1xuICB9XG4gIHBheWxvYWQuc2Vzc2lvbl9pZCA9IHNlc3Npb25JZDtcbiAgLy8gVGhlIGA8L3NjcmlwdD5gIGJyZWFrb3V0IGd1YXJkLiBUaGUgcGF5bG9hZCBsYW5kcyBpbnNpZGUgYVxuICAvLyA8c2NyaXB0IHR5cGU9XCJhcHBsaWNhdGlvbi9qc29uXCI+IGRhdGEgaXNsYW5kLCBhbmQgYSBkb2N1bWVudCBjb250YWluaW5nIHRoZVxuICAvLyBsaXRlcmFsIGNoYXJhY3RlcnMgYDwvc2NyaXB0PmAgd291bGQgb3RoZXJ3aXNlIGNsb3NlIHRoZSB0YWcgZWFybHkgYW5kIHR1cm5cbiAgLy8gdGhlIHJlc3Qgb2YgdGhlIHJldmlldyBpbnRvIG1hcmt1cC4gUmUtZGVyaXZlZCwgbm90IGNhcnJpZWQgb24gZmFpdGg6IHRoZVxuICAvLyBwYXlsb2FkIHN0aWxsIHJlYWNoZXMgdGhlIHBhZ2UgYXMgdGhlIHRleHQgY29udGVudCBvZiB0aGF0IGVsZW1lbnQsIHNvIHRoZVxuICAvLyBlc2NhcGUgaXMgc3RpbGwgZXhhY3RseSB0aGUgb25lIHRoYXQgc2VhbSBuZWVkcy5cbiAgY29uc3QgcGF5bG9hZEpzb24gPSBKU09OLnN0cmluZ2lmeShwYXlsb2FkKS5yZXBsYWNlKC88XFwvL2csIFwiPFxcXFwvXCIpO1xuICBjb25zdCBlc2NhcGVkVGl0bGUgPSBodG1sRXNjYXBlKHBheWxvYWQudGl0bGUpO1xuICBzdWJzdGl0dXRlID0gKGh0bWwpID0+XG4gICAgaHRtbC5yZXBsYWNlKFwiX19USVRMRV9fXCIsIGVzY2FwZWRUaXRsZSkucmVwbGFjZShcIl9fUEFZTE9BRF9fXCIsIHBheWxvYWRKc29uKTtcblxuICBjb25zdCByZWFkeVVybCA9IGBodHRwOi8vJHtob3N0fToke2JvdW5kUG9ydH1gO1xuICAvLyBUaGUgcmVhZHkgbGluZSBpcyB0aGlzIGRhZW1vbidzIE9OTFkgbW9kZSB0cmFuc3BvcnQg4oCUIGRlcml2ZWQgYnkgcmVhZGluZ1xuICAvLyBldmVyeSBzdGRvdXQvc3RkZXJyIHdyaXRlIGluIHRoaXMgZmlsZSByYXRoZXIgdGhhbiBieSBzdWJ0cmFjdGluZyBmcm9tIGFuXG4gIC8vIGV4ZW1wbGFyICh0aGUgbWlzdGFrZSBib3VudHkncyBwb3J0IHJlY29yZGVkKS4gVGhlcmUgaXMgbm8gZGlzY292ZXJ5IGZpbGUsXG4gIC8vIG5vIHJlYWR5IEVWRU5UIGFuZCBubyBzdGRvdXQgaGFuZHNoYWtlOiB0aGUgb3RoZXIgd3JpdGVzIGFyZSB0aGUgaGVhcnRiZWF0XG4gIC8vIHRyYWNlLCB0aGUgZXJyb3IgbGluZXMsIGFuZCB0aGUgc2luZ2xlIGZpbmFsIGVudmVsb3BlLiBgbW9kZWAgaXMgYWRkaXRpdmVcbiAgLy8gdG8gYSBsaW5lIFNLSUxMLm1kIGRvY3VtZW50cyBhcyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfS5cbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB1cmw6IHJlYWR5VXJsLCBwb3J0OiBib3VuZFBvcnQsIHNlc3Npb25faWQ6IHNlc3Npb25JZCwgbW9kZSB9KX1cXG5gLFxuICApO1xuICBpZiAoIXZbXCJuby1vcGVuXCJdKSBvcGVuQnJvd3NlcihyZWFkeVVybCk7XG5cbiAgLy8gSWRsZS10aW1lb3V0IHdhdGNoZXI6IHNsaWRlcyBmb3J3YXJkIG9uIGV2ZXJ5IC9oZWFydGJlYXQuXG4gIGNvbnN0IGlkbGVUaW1lciA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBpZiAoKHBlcmZvcm1hbmNlLm5vdygpIC0gaGVhcnRiZWF0QXQpIC8gMTAwMCA+PSB0aW1lb3V0KSB7XG4gICAgICByZXNvbHZlRG9uZSh7IGNvZGU6IDEyNCwgZGF0YTogbnVsbCB9KTtcbiAgICB9XG4gIH0sIDUwKTtcblxuICBjb25zdCB7IGNvZGUsIGRhdGEgfSA9IGF3YWl0IGRvbmU7XG4gIGNsZWFySW50ZXJ2YWwoaWRsZVRpbWVyKTtcbiAgLy8gR3JhY2UgcGVyaW9kIG9uIHN1Ym1pdDogdGhlIGJyb3dzZXIgcmFjZXMgdG8gZmV0Y2ggdGhlIFwiZGlnZXN0ZWRcIlxuICAvLyBtYXNjb3QgZnJvbSAvYXNzZXRzIGFmdGVyIHRoZSBQT1NUIC9zdWJtaXQgcmVzcG9uc2UgcmV0dXJucywgYnV0IGl0XG4gIC8vIGRvZXNuJ3Qga25vdyB3ZSdyZSBhYm91dCB0byB0ZWFyIGRvd24uIFdpdGhvdXQgdGhpcyBkZWxheSB0aGUgaW1hZ2VcbiAgLy8gcmVxdWVzdCBsYW5kcyBvbiBhIGRlYWQgc2VydmVyIGFuZCB0aGUgc2VudC1zY3JlZW4gcmVuZGVycyBicm9rZW4uXG4gIC8vIENhbmNlbC90aW1lb3V0IGRvbid0IG5lZWQgaXQg4oCUIHRoZSBwYWdlIGlzbid0IGxvYWRpbmcgbmV3IGFzc2V0cy5cbiAgaWYgKGNvZGUgPT09IDApIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDcwMCkpO1xuICBhd2FpdCBzZXJ2ZXIuc3RvcCgpO1xuXG4gIGlmIChjb2RlID09PSAwICYmIGRhdGEgIT09IG51bGwgJiYgdHlwZW9mIGRhdGEgPT09IFwib2JqZWN0XCIpIHtcbiAgICBjb25zdCByZXNwb25zZSA9IHtcbiAgICAgIGFuc3dlcnM6IGRhdGEuYW5zd2VycyA/PyB7fSxcbiAgICAgIGNvbW1lbnRzOiBkYXRhLmNvbW1lbnRzID8/IFtdLFxuICAgICAgc3VibWl0dGVkX2F0OiBpc29aTm9NaWxsaXMobmV3IERhdGUoKSksXG4gICAgfTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShyZXNwb25zZSl9XFxuYCk7XG4gIH0gZWxzZSB7XG4gICAgLy8gYjQg4oCUIGEgY2FuY2VsbGVkIG9yIHRpbWVkLW91dCByZXZpZXcgdXNlZCB0byB3cml0ZSBOT1RISU5HIHRvIHN0ZG91dCwgc29cbiAgICAvLyBcInRoZSBodW1hbiByZWFkIGl0IGFuZCBkZWNsaW5lZFwiLCBcIm5vYm9keSBldmVyIG9wZW5lZCBpdFwiLCBcInRoZSB0YWJcbiAgICAvLyBjcmFzaGVkXCIgYW5kIFwidGhleSB3YWxrZWQgYXdheVwiIHdlcmUgT05FIG9ic2VydmFibGUgdGhyb3VnaCBhIHBpcGUuIEV2ZXJ5XG4gICAgLy8gbm9uLXN1Ym1pdCBleGl0IG5vdyB3cml0ZXMgYSBsaW5lIG5hbWluZyB3aGF0IHdhcyBhY3R1YWxseSBvYnNlcnZlZC5cbiAgICAvL1xuICAgIC8vIOKaoCBgb2JzZXJ2ZWRgIGlzIGEgRkFDVCwgbm90IGEgY29udHJhY3Qgbm91bi4gVGhpcyBzaXR1YXRpb24gaXMgb25lIHRoZVxuICAgIC8vIG91dGNvbWUgY29udHJhY3QgZXhwbGljaXRseSBkb2VzIE5PVCBjb3ZlciDigJQgZ3JpbW9pcmUvb3V0Y29tZS1jb250cmFjdC5tZFxuICAgIC8vIEJvdW5kYXJ5IDIgbGlzdHMgXCJkZWFkbGluZSBleHBpcnlcIiBhbmQgXCJjb3VudGVycGFydHkgZGVjbGluZWRcIiBhbW9uZyB0aGVcbiAgICAvLyBuaW5lIHNpdHVhdGlvbnMgdGhlIHR3byBzaGFwZXMgZG8gbm90IHJlYWNoIOKAlCBhbmQgQm91bmRhcnkgMiBzYXlzIG1lZXRpbmdcbiAgICAvLyBvbmUgaXMgYSBGSU5ESU5HLCBub3QgbGljZW5jZSB0byBpbnZlbnQgYSB0aGlyZCBzcGVsbGluZy4gU28gdGhpcyByZXBvcnRzXG4gICAgLy8gb2JzZXJ2YXRpb25zIGFuZCBkZWxpYmVyYXRlbHkgZG9lcyBub3QgbWludCBhbiBgb3V0Y29tZTpgIG5vdW4uXG4gICAgLy9cbiAgICAvLyBLZXB0IGhvbmVzdCBhYm91dCBpdHMgb3duIGxpbWl0czogYGRlcGFydHVyZTogbnVsbGAgd2l0aCBgcGFnZVNlcnZlZDp0cnVlYFxuICAgIC8vIGdlbnVpbmVseSBjYW5ub3Qgc2VwYXJhdGUgYSBjcmFzaGVkIHRhYiBmcm9tIGEgd2Fsa2VkLWF3YXkgaHVtYW4sIGFuZFxuICAgIC8vIGBlbGFwc2VkTXM6IG51bGxgIG1lYW5zIHRoZSBiZWFjb24gYXJyaXZlZCBtYWxmb3JtZWQgcmF0aGVyIHRoYW5cbiAgICAvLyBpbnN0YW50YW5lb3VzLlxuICAgIGNvbnN0IG9ic2VydmVkID0gIXBhZ2VTZXJ2ZWRcbiAgICAgID8gXCJuZXZlci1vcGVuZWRcIlxuICAgICAgOiBkZXBhcnR1cmUgPT09IG51bGxcbiAgICAgICAgPyBcIm9wZW5lZC10aGVuLXNpbGVudFwiXG4gICAgICAgIDogZGVwYXJ0dXJlLmVuZ2FnZWRcbiAgICAgICAgICA/IFwiZW5nYWdlZC10aGVuLWxlZnRcIlxuICAgICAgICAgIDogXCJyZWFkLXRoZW4tbGVmdFwiO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBzdWJtaXR0ZWQ6IGZhbHNlLFxuICAgICAgICBleGl0OiBjb2RlLFxuICAgICAgICByZWFzb246IGNvZGUgPT09IDEyNCA/IFwiaWRsZS10aW1lb3V0XCIgOiBcImNsb3NlZC13aXRob3V0LXN1Ym1pdHRpbmdcIixcbiAgICAgICAgb2JzZXJ2ZWQsXG4gICAgICAgIHBhZ2VTZXJ2ZWQsXG4gICAgICAgIGRlcGFydHVyZSxcbiAgICAgICAgdGltZW91dFNlY29uZHM6IHRpbWVvdXQsXG4gICAgICAgIGVuZGVkX2F0OiBpc29aTm9NaWxsaXMobmV3IERhdGUoKSksXG4gICAgICB9KX1cXG5gLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGNvZGU7XG59XG5cbi8qKlxuICogVGhlIGxhdW5jaGVyJ3Mgb25lIGVudHJ5IHBvaW50LlxuICpcbiAqIOKblCBUSEVSRSBJUyBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0sgSEVSRSwgQU5EIElUUyBBQlNFTkNFIElTIFRIRSBSVUxJTkcg4oCUXG4gKiBwbGF5Ym9vayBQaGFzZSBCLCBCMywgcmUta2V5ZWQgb250byB0aGUgcHJvcGVydHkgYnkgRDU1LiBUaGlzIG1vZHVsZSBzaGlwc1xuICogQlVORExFRCBhdCBgPHNraWxsPi9kaXN0L3Jldmlldy5qc2AgYW5kIGlzIElNUE9SVEVEIGJ5XG4gKiBgPHNraWxsPi9zY3JpcHRzL3Jldmlldy50c2AsIG5ldmVyIGV4ZWN1dGVkIGFzIHRoZSBwcm9jZXNzIGVudHJ5LCBzbyB0aGVcbiAqIGJsb2NrIHdvdWxkIG5ldmVyIHJ1biBhdCBhbGwuIFRoYXQgaXMgb25seSBoYWxmIHRoZSByZWFzb24gaXQgaXMgZ29uZS4gVGhlXG4gKiBvdGhlciBoYWxmIGlzIHRoYXQgdGhpcyBmaWxlJ3MgYXJpdGhtZXRpYyBpcyBhbmNob3JlZCBhdCB0aGUgU0tJTEwgUk9PVCDigJRcbiAqIGBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpYCwgYW5kIGZyb20gaXQgYERJU1RfRElSYCwgYGFzc2V0c0RpcmBcbiAqIGFuZCBgREVWX1NVUkZBQ0VfQ1dEYCDigJQgYW5kIGV2ZXJ5IG9uZSBvZiB0aG9zZSBpcyBjb3JyZWN0IGZyb20gYGRpc3QvYCBhbmRcbiAqIFdST05HIGZyb20gYHNyYy9kaWdlc3RpZnkvYmFja2VuZC9gLiBBbiBgaW1wb3J0Lm1ldGEubWFpbmAgaGVyZSB3b3VsZCBvZmZlciBhXG4gKiBzZWNvbmQsIGJyb2tlbiBhZGRyZXNzIHRvIHJ1biB0aGUgc3BlbGwgZnJvbS5cbiAqXG4gKiDim5QgQU5EIElUIERPRVMgTk9UIEZBSUwgUVVJRVRMWSwgV0hJQ0ggSVMgV09SU0UgVEhBTiBUSEUgUFJFRElDVElPTiAoRDU3KS5cbiAqIE1lYXN1cmVkIDIwMjYtMDktMDkgYmVmb3JlIHRoaXMgcG9ydCwgYnkgY29weWluZyB0aGUgZmlsZSBoZXJlIGFuZCBydW5uaW5nXG4gKiBpdDogZnJvbSB0aGUgcmVwbyByb290IGl0IGV4aXRzIDIgdGVsbGluZyB0aGUgb3BlcmF0b3IgdG8gZ28gdG9cbiAqIGAvVXNlcnMvY29sZXJlZWQvc3JjL2RpZ2VzdGlmeWAg4oCUIGEgZGlyZWN0b3J5IHRoYXQgZG9lcyBub3QgZXhpc3QsIGJlY2F1c2VcbiAqIHRoZSBtZXNzYWdlIGlzIGNvbXB1dGVkIGJ5IHJ1bm5pbmcgdGhlIGJyb2tlbiBgU0tJTExfUk9PVGAgdGhyb3VnaFxuICogYERFVl9TVVJGQUNFX0NXRGAncyBmb3VyIGAuLmA7IGZyb20gYHNyYy9kaWdlc3RpZnlgIGl0IGV4aXRzIDIgYmxhbWluZyBhXG4gKiBzdXJmYWNlIHNvdXJjZSB0aGF0IGlzIHByZXNlbnQgYW5kIGNvcnJlY3QuICoqQSBkaWFnbm9zdGljIGNvbXB1dGVkIGZyb20gYVxuICogYnJva2VuIGFuY2hvciBsaWVzIGNvbmZpZGVudGx5KiosIHNvIHRoZSBwYXRocyB3ZXJlIHJlc29sdmVkIGJ5IGhhbmQgZnJvbSB0aGVcbiAqIGFkZHJlc3MgdGhpcyBtb2R1bGUgYWN0dWFsbHkgc2hpcHMgYXQgcmF0aGVyIHRoYW4gcmVhZCBvZmYgaXRzIG93biBlcnJvcnMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgYnVpbGRQYXlsb2FkLCBodG1sRXNjYXBlLCBpc29aTm9NaWxsaXMsIG1haW4sIHBhcnNlUG9ydEZyb21TZXNzaW9uSWQsIHBhcnNlUXVlc3Rpb25zIH07XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7OztBQXdCQTtBQUNBO0FBQ0E7QUFDQTtBQXVCQSxJQUFNLGFBQWEsUUFBUSxjQUFjLFlBQVksR0FBRyxDQUFDO0FBQ3pELElBQU0sYUFBYSxLQUFLLFlBQVksSUFBSTtBQUN4QyxJQUFNLFdBQVcsS0FBSyxZQUFZLE1BQU07QUFNakMsU0FBUyxXQUFXLEdBQXNCO0FBQUEsRUFDL0MsTUFBTSxXQUFXLFFBQVEsSUFBSTtBQUFBLEVBQzdCLElBQUks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
