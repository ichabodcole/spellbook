#!/usr/bin/env bun

// glamour — agent-driven visual-style composer the user works inside.
//
// A glamour is an enchantment cast over appearance: the user brings
// influences (images) + context files + intent, the agent synthesizes a deep
// understanding of the look and produces a re-castable style spec (+ images).
//
// Architecture (matured toward grapevine's shape; cli.ts wraps this):
//   - Agent ↔ server: HTTP API on the same Bun.serve.
//       POST /cmd            — agent command (JSON body; shapes below)
//       GET  /state          — full state snapshot { state, cursor }
//       GET  /events?since=N — SSE stream of user events (Monitor-wrappable)
//   - Server ↔ browser: WebSocket at /ws.
//   - Server holds canonical state; full-state broadcast to browsers on
//     every change (state is small; snapshots dodge diff bugs).
//
// IMPORTANT (house-style: keep the client thin, the agent is the runtime):
// the server does NOT generate images. Generation happens agent-side
// (MediaForge CLI, Fal, etc., out of band); the agent posts results as
// variants. The surface only displays + collects feedback.
//
// Agent commands — POST /cmd body (one JSON object):
//   {"type":"init",          "title?":..,"intent?":..}
//   {"type":"intent",        "text":".."}
//   {"type":"influence.read","id":"..","read":".."}        // per-image analysis
//   {"type":"phase",         "phase":"gather|analysis|direction|prompts|variants|spec"}
//   {"type":"direction",     "understanding":"..","revision?":N}
//   {"type":"prompts",       "prompts":[{"id?":..,"text":".."}]}
//   {"type":"variant.add",   "variant":{"id?":..,"src":"..","prompt?":"..","label?":"..","round?":N}}
//   {"type":"variants.clear"}
//   {"type":"spec",          "spec":{understanding?,modules?,recreatePrompt?,model?}}
//   {"type":"status",        "busy":bool,"text":".."}       // surface shows a spinner while busy
//   {"type":"message",       "text":".."}                   // toast
//   {"type":"narrate",       "kind?":"info|working|result|error","text":".."}  // agent→user activity feed
//   {"type":"close"}
//
// User events — streamed on GET /events (and replayable via ?since):
//   {"type":"ready",...} {"type":"connected"} {"type":"disconnected"}
//   {"type":"influence.add","influence":{id,name,path,aspects,starred,note}}  // src omitted; path = file to Read
//   {"type":"influence.annotate","id":"..","patch":{aspects?,starred?,note?}}
//   {"type":"influence.remove","id":".."}
//   {"type":"context.add","context":{id,name,path,starred,note}}              // text omitted; path = file to Read
//   {"type":"context.annotate","id":"..","patch":{starred?,note?}}
//   {"type":"context.remove","id":".."}
//   {"type":"intent.set","text":".."}
//   {"type":"analysis.comment","id":"..","text":".."}
//   {"type":"direction.correct","text":".."}
//   {"type":"prompt.comment","id":"..","text":".."}  {"type":"prompts.comment","text":".."}
//   {"type":"variant.like","id":"..","liked":bool}   {"type":"variant.canonical","id":"..","canonical":bool}
//   {"type":"feedback","scope":"analysis|prompts","items":[{id,text}],"overall":".."}  // batched review
//   {"type":"steer","text":".."}  {"type":"generate"}  {"type":"nudge","label":".."}
//   {"type":"spec.module","key":"..","on":bool}
//   {"type":"submit","state":GlamourState}  {"type":"closed","reason":".."}
//
// Exit codes: 0 submit, 2 bad args, 124 idle timeout, 130 cancel.

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import index from "../surface/index.html";
import {
  type Context,
  defaultState,
  type GlamourState,
  type Influence,
  type NarrationKind,
  type Phase,
  VALID_PHASE,
  type Variant,
} from "../surface/state/types";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Persistent home for session snapshots (survives restarts, unlike tmpdir).
const GLAMOUR_HOME = process.env.GLAMOUR_HOME ?? join(homedir(), ".glamour");
const SNAPSHOTS_DIR = join(GLAMOUR_HOME, "snapshots");

type CloseReason = "submit" | "cancel" | "timeout" | "close";
type DoneResult = { code: number; reason: CloseReason };

const PORT_SUFFIX_RE = /-p(\d{2,5})$/;

function parsePortFromSessionId(sid: string): number | null {
  const m = sid?.match(PORT_SUFFIX_RE);
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

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newId(prefix: string): string {
  return `${prefix}-${randHex(4)}`;
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
};
function guessMime(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

// Decode a `data:<mime>;base64,<payload>` URL to a file the agent can Read
// (its vision needs real pixels). Returns the path, or "" on any failure
// (a non-data-URL src, bad base64, unwritable dir — all non-fatal).
function saveDataUrl(dir: string, id: string, dataUrl: string): string {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m || !dir) return "";
  const ext = EXT_BY_MIME[m[1].toLowerCase()] ?? ".bin";
  const path = join(dir, `${id}${ext}`);
  try {
    writeFileSync(path, Buffer.from(m[2], "base64"));
    return path;
  } catch {
    return "";
  }
}

// Write a dropped text/markdown context to a file the agent can Read.
// Keeps the original extension when present; defaults to .md.
function saveText(dir: string, id: string, name: string, text: string): string {
  if (!dir) return "";
  const m = /(\.[a-z0-9]+)$/i.exec(name);
  const ext = m ? m[1] : ".md";
  const path = join(dir, `${id}${ext}`);
  try {
    writeFileSync(path, text);
    return path;
  } catch {
    return "";
  }
}

// Project an influence for the agent: drop the (huge) data-URL src — the
// agent reads the on-disk `path` instead.
function influenceForAgent(inf: Influence): Omit<Influence, "src"> {
  const { src: _drop, ...rest } = inf;
  return rest;
}

// Project a context for the agent: drop the inline text (can be large) — the
// agent reads the on-disk `path` instead.
function contextForAgent(c: Context): Omit<Context, "text"> {
  const { text: _drop, ...rest } = c;
  return rest;
}

// Project a variant for the agent: drop the (huge) data-URL src — the
// agent inspects variants via path or label, not raw pixel data.
function variantForAgent(v: Variant): Omit<Variant, "src"> {
  const { src: _drop, ...rest } = v;
  return rest;
}

// Advance the phase forward only: returns target if it is strictly later in
// VALID_PHASE than current, otherwise returns current unchanged.
export function advancePhase(current: Phase, target: Phase): Phase {
  const ci = VALID_PHASE.indexOf(current);
  const ti = VALID_PHASE.indexOf(target);
  return ti > ci ? target : current;
}

// Lean state projection for the agent: strips all inlined binary/text blobs
// (influence src, variant src, context text). The agent reads on-disk paths
// instead — keeps the payload ~small regardless of session size.
export function leanState(s: GlamourState) {
  return {
    ...s,
    influences: s.influences.map(influenceForAgent),
    contexts: s.contexts.map(contextForAgent),
    variants: s.variants.map(variantForAgent),
  };
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Glamour" },
        intent: { type: "string", default: "" },
        timeout: { type: "string", default: "1800" },
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        id: { type: "string" },
        restore: { type: "string" }, // snapshot path or session id to resume
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const v = parsed.values;
  const timeout = parseFloat(v.timeout as string);
  let port = parseInt(v.port as string, 10);
  const host = v.host as string;
  let sessionId = (v.id as string | undefined) ?? "";
  if (port === 0 && sessionId) {
    const embedded = parsePortFromSessionId(sessionId);
    if (embedded !== null) port = embedded;
  }

  const assetsDir = join(SCRIPT_DIR, "..", "assets");

  let state = defaultState(v.title as string, v.intent as string);
  let restored = false;
  if (v.restore) {
    const restorePath = existsSync(v.restore as string)
      ? (v.restore as string)
      : join(SNAPSHOTS_DIR, `${v.restore}.json`);
    try {
      const snap = JSON.parse(readFileSync(restorePath, "utf8")) as Partial<GlamourState>;
      // Merge over defaults so snapshots from older builds gain new fields.
      state = {
        ...defaultState(v.title as string, v.intent as string),
        ...snap,
      } as GlamourState;
      restored = true;
    } catch (e) {
      process.stderr.write(
        `glamour: restore failed (${restorePath}): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const sockets = new Set<ServerWebSocket<unknown>>();
  const enc = new TextEncoder();

  // Append-only event log for the agent's SSE tail. Each event gets a
  // monotonic id so a (re)connecting tail can replay via ?since=<id>.
  const events: Array<Record<string, unknown>> = [];
  let eventSeq = 0;
  const sseClients = new Set<ReadableStreamDefaultController>();
  const sseTimers = new Set<ReturnType<typeof setInterval>>();

  let resolveDone!: (val: DoneResult) => void;
  let settled = false;
  const done = new Promise<DoneResult>((res) => {
    resolveDone = (val) => {
      if (settled) return;
      settled = true;
      res(val);
    };
  });

  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };

  // Record a user event: append to the log and fan out to SSE tails.
  function emitEvent(msg: Record<string, unknown>) {
    const ev = { id: ++eventSeq, ...msg };
    events.push(ev);
    const frame = enc.encode(`data: ${JSON.stringify(ev)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(frame);
      } catch {
        /* client gone */
      }
    }
  }

  function broadcast(msg: object) {
    const s = JSON.stringify(msg);
    for (const ws of sockets) {
      try {
        ws.send(s);
      } catch {
        /* socket closed */
      }
    }
  }
  let snapDirty = false;
  const broadcastState = () => {
    snapDirty = true; // mark for the persistence snapshot
    broadcast({ type: "state", state });
  };

  const findInfluence = (id: string) => state.influences.find((i) => i.id === id);
  const findVariant = (id: string) => state.variants.find((x) => x.id === id);

  let sessionFilesDir = ""; // set once sessionId is known (after bind)
  const saveSnapshot = () => {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      writeFileSync(join(SNAPSHOTS_DIR, `${sessionId}.json`), JSON.stringify(state));
    } catch {
      /* persistence is best-effort */
    }
  };

  // ── agent commands (POST /cmd) ────────────────────────────────────
  function handleAgentMsg(msg: Record<string, unknown>) {
    const t = msg.type as string;
    if (t === "init") {
      if (typeof msg.title === "string") state.title = msg.title;
      if (typeof msg.intent === "string") state.intent = msg.intent;
      broadcastState();
    } else if (t === "intent") {
      if (typeof msg.text === "string") state.intent = msg.text;
      broadcastState();
    } else if (t === "influence.read") {
      const inf = findInfluence(msg.id as string);
      if (inf && typeof msg.read === "string") {
        inf.read = msg.read;
        state.phase = advancePhase(state.phase, "analysis");
        broadcastState();
      }
    } else if (t === "phase") {
      if (VALID_PHASE.includes(msg.phase as Phase)) {
        state.phase = msg.phase as Phase;
        broadcastState();
      }
    } else if (t === "direction") {
      if (typeof msg.understanding === "string") {
        state.direction.understanding = msg.understanding;
        state.direction.revision =
          typeof msg.revision === "number" ? msg.revision : state.direction.revision + 1;
        state.phase = advancePhase(state.phase, "direction");
        broadcastState();
      }
    } else if (t === "prompts") {
      if (Array.isArray(msg.prompts)) {
        state.prompts = (msg.prompts as Array<Record<string, unknown>>).map((p) => ({
          id: typeof p.id === "string" ? p.id : newId("p"),
          text: typeof p.text === "string" ? p.text : "",
        }));
        state.phase = advancePhase(state.phase, "prompts");
        broadcastState();
      }
    } else if (t === "variant.add") {
      const raw2 = msg.variant as Record<string, unknown> | undefined;
      if (raw2 && typeof raw2.src === "string") {
        state.variants.push({
          id: typeof raw2.id === "string" ? raw2.id : newId("v"),
          src: raw2.src,
          prompt: typeof raw2.prompt === "string" ? raw2.prompt : "",
          label: typeof raw2.label === "string" ? raw2.label : "",
          round: typeof raw2.round === "number" ? raw2.round : state.round,
          liked: false,
          canonical: false,
        });
        state.phase = advancePhase(state.phase, "variants");
        broadcastState();
      }
    } else if (t === "variants.clear") {
      state.variants = [];
      state.round += 1;
      broadcastState();
    } else if (t === "spec") {
      const s = (msg.spec ?? {}) as Record<string, unknown>;
      if (typeof s.understanding === "string") state.spec.understanding = s.understanding;
      if (typeof s.recreatePrompt === "string") state.spec.recreatePrompt = s.recreatePrompt;
      if (typeof s.model === "string") state.spec.model = s.model;
      if (Array.isArray(s.modules)) {
        for (const m of s.modules as Array<Record<string, unknown>>) {
          const mod = state.spec.modules.find((x) => x.key === m.key);
          if (!mod) continue;
          if (typeof m.on === "boolean") mod.on = m.on;
          if (typeof m.content === "string") mod.content = m.content;
        }
      }
      state.phase = advancePhase(state.phase, "spec");
      broadcastState();
    } else if (t === "status") {
      state.status = {
        busy: msg.busy === true,
        text: typeof msg.text === "string" ? msg.text : "",
      };
      broadcastState();
    } else if (t === "narrate") {
      const kind = (["info", "working", "result", "error"] as const).includes(
        msg.kind as NarrationKind,
      )
        ? (msg.kind as NarrationKind)
        : "info";
      if (typeof msg.text === "string" && msg.text) {
        state.narration.push({
          id: newId("n"),
          kind,
          text: msg.text,
          ts: Date.now(),
        });
        broadcastState();
      }
    } else if (t === "message") {
      broadcast({ type: "message", text: msg.text });
    } else if (t === "close") {
      resolveDone({ code: 0, reason: "close" });
    }
  }

  function sseResponse(url: URL): Response {
    touch();
    const since = parseInt(url.searchParams.get("since") ?? "-1", 10);
    let ref: ReadableStreamDefaultController | null = null;
    let hb: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        ref = controller;
        for (const ev of events) {
          if ((ev.id as number) > since) {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
          }
        }
        sseClients.add(controller);
        hb = setInterval(() => {
          try {
            controller.enqueue(enc.encode(`: hb\n\n`));
          } catch {
            /* gone */
          }
        }, 15000);
        sseTimers.add(hb);
      },
      cancel() {
        if (hb) {
          clearInterval(hb);
          sseTimers.delete(hb);
        }
        if (ref) sseClients.delete(ref);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes: {
        "/": index,
      },
      development: { hmr: true },
      fetch: (req, srv) => {
        const url = new URL(req.url);
        const path = url.pathname;
        if (path === "/ws") {
          const upgraded = srv.upgrade(req);
          if (upgraded) return undefined;
          return new Response("upgrade required", { status: 426 });
        }
        // ── agent HTTP API ──
        if (req.method === "GET" && path === "/state") {
          const lean = url.searchParams.get("lean") === "1";
          const payload = lean ? leanState(state) : state;
          return new Response(JSON.stringify({ state: payload, cursor: eventSeq }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (req.method === "GET" && path === "/events") {
          return sseResponse(url);
        }
        if (req.method === "POST" && path === "/cmd") {
          return req
            .json()
            .then((body) => {
              touch();
              handleAgentMsg(body as Record<string, unknown>);
              return new Response('{"ok":true}', {
                headers: { "Content-Type": "application/json" },
              });
            })
            .catch(
              () =>
                new Response('{"error":"bad json"}', {
                  status: 400,
                  headers: { "Content-Type": "application/json" },
                }),
            );
        }
        if (req.method === "GET" && path.startsWith("/assets/")) {
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          if (assetName.includes("..") || assetName.startsWith("/")) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          const f = Bun.file(join(assetsDir, assetName));
          return f.exists().then((exists) =>
            exists
              ? new Response(f, {
                  headers: { "Content-Type": guessMime(assetName) },
                })
              : new Response('{"error":"not found"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                }),
          );
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          touch();
          emitEvent({ type: "connected" });
          ws.send(JSON.stringify({ type: "state", state }));
        },
        message(_ws, raw) {
          touch();
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(
              `glamour: bad json from browser: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            return;
          }
          const t = msg.type as string;

          if (t === "influence.add") {
            const raw2 = msg.influence as Record<string, unknown> | undefined;
            if (!raw2 || typeof raw2.src !== "string") return;
            const id = typeof raw2.id === "string" ? raw2.id : newId("inf");
            const inf: Influence = {
              id,
              src: raw2.src,
              path: saveDataUrl(sessionFilesDir, id, raw2.src),
              name: typeof raw2.name === "string" ? raw2.name : "untitled",
              aspects: Array.isArray(raw2.aspects) ? (raw2.aspects as string[]) : [],
              starred: raw2.starred === true,
              note: typeof raw2.note === "string" ? raw2.note : "",
              read: "",
            };
            if (state.influences.some((i) => i.id === inf.id)) return;
            state.influences.push(inf);
            broadcastState();
            emitEvent({
              type: "influence.add",
              influence: influenceForAgent(inf),
            });
          } else if (t === "influence.annotate") {
            const inf = findInfluence(msg.id as string);
            if (!inf) return;
            const patch = (msg.patch ?? {}) as Record<string, unknown>;
            if (Array.isArray(patch.aspects)) inf.aspects = patch.aspects as string[];
            if (typeof patch.starred === "boolean") inf.starred = patch.starred;
            if (typeof patch.note === "string") inf.note = patch.note;
            broadcastState();
            emitEvent({ type: "influence.annotate", id: inf.id, patch });
          } else if (t === "influence.remove") {
            const idx = state.influences.findIndex((i) => i.id === msg.id);
            if (idx === -1) return;
            state.influences.splice(idx, 1);
            broadcastState();
            emitEvent({ type: "influence.remove", id: msg.id });
          } else if (t === "context.add") {
            const raw2 = msg.context as Record<string, unknown> | undefined;
            if (!raw2 || typeof raw2.text !== "string") return;
            const cid = typeof raw2.id === "string" ? raw2.id : newId("ctx");
            const name = typeof raw2.name === "string" ? raw2.name : "untitled.md";
            const ctx: Context = {
              id: cid,
              name,
              text: raw2.text,
              path: saveText(sessionFilesDir, cid, name, raw2.text),
              starred: raw2.starred === true,
              note: typeof raw2.note === "string" ? raw2.note : "",
            };
            if (state.contexts.some((c) => c.id === ctx.id)) return;
            state.contexts.push(ctx);
            broadcastState();
            emitEvent({ type: "context.add", context: contextForAgent(ctx) });
          } else if (t === "context.annotate") {
            const ctx = state.contexts.find((c) => c.id === msg.id);
            if (!ctx) return;
            const patch = (msg.patch ?? {}) as Record<string, unknown>;
            if (typeof patch.starred === "boolean") ctx.starred = patch.starred;
            if (typeof patch.note === "string") ctx.note = patch.note;
            broadcastState();
            emitEvent({ type: "context.annotate", id: ctx.id, patch });
          } else if (t === "context.remove") {
            const idx = state.contexts.findIndex((c) => c.id === msg.id);
            if (idx === -1) return;
            state.contexts.splice(idx, 1);
            broadcastState();
            emitEvent({ type: "context.remove", id: msg.id });
          } else if (t === "intent.set") {
            if (typeof msg.text !== "string") return;
            state.intent = msg.text;
            broadcastState();
            emitEvent({ type: "intent.set", text: msg.text });
          } else if (t === "analysis.comment") {
            if (!findInfluence(msg.id as string) || typeof msg.text !== "string") return;
            emitEvent({ type: "analysis.comment", id: msg.id, text: msg.text });
          } else if (t === "direction.correct") {
            if (typeof msg.text !== "string") return;
            emitEvent({ type: "direction.correct", text: msg.text });
          } else if (t === "prompt.comment") {
            if (typeof msg.text !== "string") return;
            emitEvent({ type: "prompt.comment", id: msg.id, text: msg.text });
          } else if (t === "prompts.comment") {
            if (typeof msg.text !== "string") return;
            emitEvent({ type: "prompts.comment", text: msg.text });
          } else if (t === "variant.like") {
            const x = findVariant(msg.id as string);
            if (!x) return;
            x.liked = msg.liked === true;
            broadcastState();
            emitEvent({ type: "variant.like", id: x.id, liked: x.liked });
          } else if (t === "variant.canonical") {
            const x = findVariant(msg.id as string);
            if (!x) return;
            x.canonical = msg.canonical === true;
            broadcastState();
            emitEvent({
              type: "variant.canonical",
              id: x.id,
              canonical: x.canonical,
            });
          } else if (t === "steer") {
            if (typeof msg.text !== "string") return;
            emitEvent({ type: "steer", text: msg.text });
          } else if (t === "feedback") {
            // Batched review feedback for a phase: many per-item comments +
            // an optional overall note, sent in one shot. The agent revises
            // the whole set and posts a new round (better than reacting to
            // each comment piecemeal).
            emitEvent({
              type: "feedback",
              scope: typeof msg.scope === "string" ? msg.scope : "",
              items: Array.isArray(msg.items) ? msg.items : [],
              overall: typeof msg.overall === "string" ? msg.overall : "",
            });
          } else if (t === "generate") {
            emitEvent({ type: "generate" });
          } else if (t === "nudge") {
            // A user "proceed" button press (e.g. "read the influences",
            // "distill the spec"). Carries a human-readable label; the
            // agent infers the requested move from the current phase.
            emitEvent({
              type: "nudge",
              label: typeof msg.label === "string" ? msg.label : "",
            });
          } else if (t === "spec.module") {
            const mod = state.spec.modules.find((m) => m.key === msg.key);
            if (!mod) return;
            mod.on = msg.on === true;
            broadcastState();
            emitEvent({ type: "spec.module", key: mod.key, on: mod.on });
          } else if (t === "submit") {
            broadcast({ type: "submit" });
            emitEvent({ type: "submit", state });
            resolveDone({ code: 0, reason: "submit" });
          } else if (t === "cancel") {
            broadcast({ type: "cancel" });
            resolveDone({ code: 130, reason: "cancel" });
          }
        },
        close(ws) {
          sockets.delete(ws);
          emitEvent({ type: "disconnected" });
        },
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
  if (!sessionId) sessionId = `glamour-${randHex(4)}-p${boundPort}`;
  sessionFilesDir = join(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync(sessionFilesDir, { recursive: true });
  } catch {
    /* fall back to no-file-paths (path stays "") */
  }
  // On restore, the snapshot's src/text are self-contained but its file paths
  // are stale (old tmpdir, cleaned). Re-materialize files so the agent's vision
  // (Read by path) works again.
  if (restored) {
    for (const inf of state.influences) {
      if (inf.src) inf.path = saveDataUrl(sessionFilesDir, inf.id, inf.src) || inf.path;
    }
    for (const c of state.contexts) {
      if (c.text) c.path = saveText(sessionFilesDir, c.id, c.name, c.text) || c.path;
    }
    saveSnapshot();
  }

  const url = `http://${host}:${boundPort}`;
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId });

  // Discovery files — cli.ts reads the port from here (mirror bounty).
  const sessionFile = join(tmpdir(), `glamour-${sessionId}.json`);
  const latestFile = join(tmpdir(), `glamour-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
  });
  try {
    writeFileSync(sessionFile, sessionInfo);
    writeFileSync(latestFile, sessionInfo);
  } catch (e) {
    process.stderr.write(
      `glamour: could not write discovery file: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  const cleanupDiscovery = async () => {
    try {
      unlinkSync(sessionFile);
    } catch {}
    try {
      const cur = await Bun.file(latestFile).text();
      if (JSON.parse(cur).session_id === sessionId) unlinkSync(latestFile);
    } catch {
      /* gone — fine */
    }
    try {
      if (sessionFilesDir) rmSync(sessionFilesDir, { recursive: true, force: true });
    } catch {}
  };

  if (!v["no-open"]) openBrowser(url);

  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeout) {
      resolveDone({ code: 124, reason: "timeout" });
    }
  }, 250);

  // Debounced persistence: snapshot the full state ~1s after any change, so a
  // restart (cli.ts open --restore <id>) resumes exactly where we left off.
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveSnapshot();
    }
  }, 1000);

  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  saveSnapshot(); // final write — keep it (NOT deleted on close; it's the resume point)
  emitEvent({ type: "closed", reason });
  broadcast({ type: "message", text: `session ended: ${reason}` });
  // Grace period so the closed event + submit/cancel broadcasts flush.
  await new Promise((r) => setTimeout(r, 150));
  for (const t of sseTimers) clearInterval(t);
  for (const c of sseClients) {
    try {
      c.close();
    } catch {}
  }
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {}
  }
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  await cleanupDiscovery();
  return code;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}

export type {
  Context,
  GlamourState,
  Influence,
  Phase,
  Variant,
} from "../surface/state/types";
export { defaultState } from "../surface/state/types";
export { htmlEscape, main, parsePortFromSessionId };
