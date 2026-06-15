#!/usr/bin/env bun

// imago — an agent-driven image canvas the user works inside.
//
// imago is a GROUNDED CONVERSATION about an image: the user and the agent talk
// (the conversation), the surface holds the artifacts (batches of kept
// generations, the focused one on the canvas), and surface gestures (liking,
// marking, attaching a ref) are messages the agent hears. It's a loop, not a
// funnel — no phase pipeline.
//
// Architecture (cli.ts wraps this):
//   - Agent ↔ server: HTTP on the same Bun.serve.
//       POST /cmd            — agent command (JSON; AgentCommand union)
//       GET  /state[?lean=1] — full snapshot { state, cursor }; lean strips blobs
//       GET  /events?since=N — SSE stream of user events (Monitor-wrappable)
//   - Server ↔ browser: WebSocket at /ws (ClientToServer / ServerToClient).
//   - Server holds canonical state; full-state broadcast to browsers on change.
//
// IMPORTANT (house-style: keep the client thin, the agent is the runtime): the
// server does NOT generate images. Generation happens agent-side (media-forge,
// out of band); the agent posts results via batch.add. The surface displays +
// collects the conversation and gestures.
//
// Agent commands (POST /cmd) and user events (GET /events) are the AgentCommand
// union and AGENT_EVENT_TYPES in surface/state/types.ts — the single contract.
//
// Exit codes: 0 submit/close, 2 bad args, 124 idle timeout, 130 cancel.

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import index from "../surface/index.html";
import { optimizeImageBuffer } from "../surface/state/imageOptimize.server";
import {
  type Batch,
  defaultState,
  type ImagoState,
  type Mark,
  type Message,
  type Reference,
  type Variant,
} from "../surface/state/types";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Persistent home for session snapshots (survives restarts, unlike tmpdir).
const IMAGO_HOME = process.env.IMAGO_HOME ?? join(homedir(), ".imago");
const SNAPSHOTS_DIR = join(IMAGO_HOME, "snapshots");

type CloseReason = "submit" | "cancel" | "timeout" | "close";
type DoneResult = { code: number; reason: CloseReason };

const PORT_SUFFIX_RE = /-p(\d{2,5})$/;

function parsePortFromSessionId(sid: string): number | null {
  const m = sid?.match(PORT_SUFFIX_RE);
  if (!m) return null;
  const port = parseInt(m[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}

function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newId(prefix: string): string {
  return `${prefix}-${randHex(4)}`;
}

// Stable content hash of a reference's bytes — dedupes identical adds and keys
// the analysis cache (so a delete→re-add of the same image reuses its read).
function contentHash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 16);
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

// Decode a `data:<mime>;base64,<payload>` URL to a file the agent can Read (its
// vision needs real pixels). Returns the path, or "" on any failure.
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

// ── agent-facing projections: strip the (huge) inlined data-URL blobs. The
// agent reads on-disk `path`s instead, keeping /state small regardless of size.
function variantForAgent(v: Variant): Omit<Variant, "src"> {
  const { src: _drop, ...rest } = v;
  return rest;
}
function batchForAgent(b: Batch): Omit<Batch, "variants"> & { variants: Omit<Variant, "src">[] } {
  return { ...b, variants: b.variants.map(variantForAgent) };
}
function refForAgent(r: Reference): Omit<Reference, "src"> {
  const { src: _drop, ...rest } = r;
  return rest;
}

export function leanState(s: ImagoState) {
  return {
    ...s,
    batches: s.batches.map(batchForAgent),
    refs: s.refs.map(refForAgent),
  };
}

const IMAGE_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is;

// Downscale+webp an inlined image data-url before it enters state (raw model
// PNGs are the dominant state-bloat source). Non-data-url srcs (http, etc.) and
// any failure pass through unchanged — optimization is best-effort.
export async function optimizeSrc(src: string): Promise<string> {
  const m = IMAGE_DATA_URL_RE.exec(src);
  if (!m) return src;
  try {
    const input = new Uint8Array(Buffer.from(m[1], "base64"));
    const { data } = await optimizeImageBuffer(input);
    return `data:image/webp;base64,${Buffer.from(data).toString("base64")}`;
  } catch {
    return src;
  }
}

function normStyle(name: string): string {
  return name.trim().toLowerCase();
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "imago" },
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

  let state = defaultState(v.title as string);
  let restored = false;
  if (v.restore) {
    const restorePath = existsSync(v.restore as string)
      ? (v.restore as string)
      : join(SNAPSHOTS_DIR, `${v.restore}.json`);
    try {
      const snap = JSON.parse(readFileSync(restorePath, "utf8")) as Partial<ImagoState>;
      // Merge over defaults so snapshots from older builds gain new fields.
      state = { ...defaultState(v.title as string), ...snap } as ImagoState;
      restored = true;
    } catch (e) {
      process.stderr.write(
        `imago: restore failed (${restorePath}): ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  const sockets = new Set<ServerWebSocket<unknown>>();
  const enc = new TextEncoder();

  // Append-only event log for the agent's SSE tail. Each event gets a monotonic
  // id so a (re)connecting tail can replay via ?since=<id>.
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

  let sessionFilesDir = ""; // set once sessionId is known (after bind)
  const saveSnapshot = () => {
    try {
      mkdirSync(SNAPSHOTS_DIR, { recursive: true });
      writeFileSync(join(SNAPSHOTS_DIR, `${sessionId}.json`), JSON.stringify(state));
    } catch {
      /* persistence is best-effort */
    }
  };

  // ── helpers over the canonical state ──
  const findBatch = (id: string) => state.batches.find((b) => b.id === id);
  function findVariant(id: string): { batch: Batch; variant: Variant; index: number } | null {
    for (const b of state.batches) {
      const index = b.variants.findIndex((x) => x.id === id);
      if (index >= 0) return { batch: b, variant: b.variants[index], index };
    }
    return null;
  }
  const labelOf = (i: number) => String.fromCharCode(97 + i);
  function pushMessage(m: Omit<Message, "id" | "ts"> & { id?: string }) {
    const msg: Message = { id: m.id ?? newId("m"), ts: Date.now(), ...m } as Message;
    state.conversation.push(msg);
    return msg;
  }

  // ── agent commands (POST /cmd) ────────────────────────────────────
  async function handleAgentMsg(msg: Record<string, unknown>) {
    const t = msg.type as string;
    if (t === "init") {
      if (typeof msg.title === "string") state.title = msg.title;
      broadcastState();
    } else if (t === "say") {
      if (typeof msg.text === "string" && msg.text) {
        pushMessage({ role: "agent", kind: "text", text: msg.text });
        broadcastState();
      }
    } else if (t === "propose") {
      if (typeof msg.prompt === "string" && msg.prompt) {
        const n = typeof msg.n === "number" && msg.n > 0 ? Math.min(4, Math.floor(msg.n)) : 4;
        // No framing text on the proposal itself — the agent `say`s its
        // reasoning as a preceding bubble, then `propose`s the card.
        pushMessage({
          role: "agent",
          kind: "prompt",
          text: "",
          proposal: { prompt: msg.prompt, n, status: "pending" },
        });
        broadcastState();
      }
    } else if (t === "ask") {
      if (typeof msg.text === "string" && msg.text) {
        pushMessage({
          role: "agent",
          kind: "question",
          text: msg.text,
          options: Array.isArray(msg.options) ? (msg.options as string[]) : undefined,
        });
        broadcastState();
      }
    } else if (t === "batch.add") {
      const variantsIn = Array.isArray(msg.variants)
        ? (msg.variants as Array<Record<string, unknown>>)
        : [];
      if (variantsIn.length === 0) return;
      const batchId = newId("b");
      const variants: Variant[] = [];
      for (const raw of variantsIn) {
        if (typeof raw.src !== "string") continue;
        const vid = typeof raw.id === "string" ? raw.id : newId("v");
        const src = await optimizeSrc(raw.src);
        variants.push({
          id: vid,
          src,
          path: saveDataUrl(sessionFilesDir, vid, src),
          seed: typeof raw.seed === "number" ? raw.seed : undefined,
          model: typeof raw.model === "string" ? raw.model : undefined,
          liked: false,
          analysis: "",
        });
      }
      if (variants.length === 0) return;
      const batch: Batch = {
        id: batchId,
        kind: msg.kind === "edit" ? "edit" : "generate",
        prompt: typeof msg.prompt === "string" ? msg.prompt : "",
        tag: typeof msg.tag === "string" ? msg.tag : undefined,
        editedFromVariantId:
          typeof msg.editedFromVariantId === "string" ? msg.editedFromVariantId : undefined,
        variants,
      };
      state.batches.push(batch);
      pushMessage({
        role: "agent",
        kind: "result",
        text:
          typeof msg.summary === "string"
            ? msg.summary
            : `Generated ${variants.length} variant${variants.length > 1 ? "s" : ""} — they're on the left.`,
        batchId,
      });
      // Show the first result on the canvas if nothing is focused yet.
      if (!state.focus) state.focus = { batchId, variantId: variants[0].id };
      broadcastState();
    } else if (t === "focus") {
      const b = findBatch(msg.batchId as string);
      const has = b?.variants.some((x) => x.id === msg.variantId);
      if (b && has) {
        state.focus = { batchId: b.id, variantId: msg.variantId as string };
        state.marks = []; // marks are scoped to the focused image
        broadcastState();
      }
    } else if (t === "ref.select") {
      // the agent points at a ref too — the user sees it highlight on the board
      const r = state.refs.find((x) => x.id === msg.id);
      if (!r) return;
      r.selected = msg.selected === true;
      broadcastState();
    } else if (t === "ref.analyze") {
      // the agent writes its read onto a ref (visible to the user + cached by
      // hash so a re-add or another agent doesn't re-analyze the same pixels)
      const r = state.refs.find((x) => x.id === msg.id);
      if (!r || typeof msg.text !== "string") return;
      r.analysis = msg.text;
      state.analysisCache[r.hash] = msg.text;
      broadcastState();
    } else if (t === "variant.analyze") {
      // the agent writes its read onto a generated/imported image — durable
      // metadata stored on the variant (persists in the snapshot).
      const hit = findVariant(msg.id as string);
      if (!hit || typeof msg.text !== "string") return;
      hit.variant.analysis = msg.text;
      broadcastState();
    } else if (t === "style.add") {
      if (typeof msg.name === "string" && msg.name.trim()) {
        const name = normStyle(msg.name);
        const existing = state.styles.find((s) => s.name === name);
        if (existing) {
          existing.active = true;
          existing.captured = true;
        } else {
          state.styles.push({ name, active: true, captured: true });
        }
        broadcastState();
      }
    } else if (t === "status") {
      state.status = {
        busy: msg.busy === true,
        text: typeof msg.text === "string" ? msg.text : "",
      };
      broadcastState();
    } else if (t === "cost") {
      if (typeof msg.text === "string") {
        state.cost = msg.text;
        broadcastState();
      }
    } else if (t === "handoff") {
      state.handoff = typeof msg.text === "string" ? msg.text : "";
      broadcastState();
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

  // ── browser messages (WebSocket) ──────────────────────────────────
  function handleBrowserMsg(msg: Record<string, unknown>) {
    const t = msg.type as string;
    if (t === "say") {
      if (typeof msg.text !== "string" || !msg.text) return;
      pushMessage({ role: "user", kind: "text", text: msg.text });
      broadcastState();
      emitEvent({ type: "say", text: msg.text });
    } else if (t === "proposal.send") {
      const m = state.conversation.find((x) => x.id === msg.id);
      if (m?.proposal) {
        m.proposal.status = "sent";
        broadcastState();
      }
      emitEvent({ type: "proposal.send", id: msg.id });
    } else if (t === "proposal.dismiss") {
      const m = state.conversation.find((x) => x.id === msg.id);
      if (m?.proposal) {
        m.proposal.status = "dismissed";
        broadcastState();
      }
      emitEvent({ type: "proposal.dismiss", id: msg.id });
    } else if (t === "focus.set") {
      const b = findBatch(msg.batchId as string);
      if (!b) return;
      if (!b.variants.some((x) => x.id === msg.variantId)) return;
      state.focus = { batchId: b.id, variantId: msg.variantId as string };
      state.marks = []; // marks are scoped to the focused image
      broadcastState();
      emitEvent({ type: "focus.set", batchId: b.id, variantId: msg.variantId });
    } else if (t === "focus.clear") {
      state.focus = null;
      state.marks = [];
      broadcastState();
      emitEvent({ type: "focus.clear" });
    } else if (t === "variant.like") {
      const hit = findVariant(msg.id as string);
      if (!hit) return;
      hit.variant.liked = msg.liked === true;
      if (hit.variant.liked) {
        pushMessage({
          role: "user",
          kind: "gesture",
          text: `👍 you liked variant ${labelOf(hit.index)} — imago can see which one`,
          gesture: { kind: "liked", targetId: hit.variant.id },
        });
      }
      broadcastState();
      emitEvent({ type: "variant.like", id: hit.variant.id, liked: hit.variant.liked });
    } else if (t === "style.toggle") {
      if (typeof msg.name !== "string") return;
      const name = normStyle(msg.name);
      const s = state.styles.find((x) => x.name === name);
      if (!s) return;
      s.active = !s.active;
      broadcastState();
      emitEvent({ type: "style.toggle", name: s.name, active: s.active });
    } else if (t === "style.capture") {
      emitEvent({ type: "style.capture" });
    } else if (t === "pin.add") {
      if (typeof msg.key !== "string" || typeof msg.value !== "string") return;
      const ex = state.pins.find((p) => p.key === msg.key);
      if (ex) ex.value = msg.value;
      else state.pins.push({ key: msg.key, value: msg.value });
      broadcastState();
      emitEvent({ type: "pin.add", key: msg.key, value: msg.value });
    } else if (t === "pin.remove") {
      state.pins = state.pins.filter((p) => p.key !== msg.key);
      broadcastState();
      emitEvent({ type: "pin.remove", key: msg.key });
    } else if (t === "ref.add") {
      const raw = msg.reference as Record<string, unknown> | undefined;
      if (!raw || typeof raw.src !== "string") return;
      const hash = contentHash(raw.src);
      // dedupe: the same image already in the drawer → no-op (no confusing dupes)
      if (state.refs.some((r) => r.hash === hash)) return;
      const id = typeof raw.id === "string" ? raw.id : newId("ref");
      const name = typeof raw.name === "string" ? raw.name : "reference";
      const ref: Reference = {
        id,
        src: raw.src,
        path: saveDataUrl(sessionFilesDir, id, raw.src),
        name,
        selected: false,
        hash,
        analysis: state.analysisCache[hash] ?? "", // reuse a prior read of the same image
      };
      state.refs.push(ref);
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `📎 you attached a reference (${name})`,
        gesture: { kind: "ref-added", targetId: id },
      });
      broadcastState();
      emitEvent({ type: "ref.add", id, name });
    } else if (t === "ref.remove") {
      state.refs = state.refs.filter((r) => r.id !== msg.id);
      broadcastState();
      emitEvent({ type: "ref.remove", id: msg.id });
    } else if (t === "ref.select") {
      const r = state.refs.find((x) => x.id === msg.id);
      if (!r) return;
      r.selected = msg.selected === true;
      broadcastState();
      emitEvent({ type: "ref.select", id: r.id, selected: r.selected });
    } else if (t === "image.import") {
      // the user dropped their own image onto the canvas — a first-class working
      // image (a one-variant "import" batch), focused so they can annotate/edit it
      const raw = msg.image as Record<string, unknown> | undefined;
      if (!raw || typeof raw.src !== "string") return;
      const name = typeof raw.name === "string" ? raw.name : "imported image";
      const vid = newId("v");
      const batchId = newId("b");
      const variant: Variant = {
        id: vid,
        src: raw.src,
        path: saveDataUrl(sessionFilesDir, vid, raw.src),
        liked: false,
        analysis: "",
      };
      state.batches.push({
        id: batchId,
        kind: "import",
        prompt: "",
        tag: name,
        variants: [variant],
      });
      state.focus = { batchId, variantId: vid };
      state.marks = [];
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `🖼 you brought in an image to work on (${name})`,
        gesture: { kind: "imported", targetId: vid },
      });
      broadcastState();
      emitEvent({ type: "image.import", batchId, variantId: vid, name });
    } else if (t === "mark.add") {
      const mk = msg.mark as Mark | undefined;
      if (!mk || (mk.tool !== "pin" && mk.tool !== "arrow")) return;
      if (!mk.id) return;
      state.marks.push(mk);
      broadcastState(); // incremental — no agent event until commit
    } else if (t === "marks.clear") {
      state.marks = [];
      broadcastState();
    } else if (t === "marks.commit") {
      if (
        typeof msg.text !== "string" ||
        typeof msg.batchId !== "string" ||
        typeof msg.variantId !== "string"
      )
        return;
      const marks = state.marks;
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `✍️ ${msg.text}`,
        gesture: { kind: "marked", targetId: msg.variantId },
      });
      state.marks = [];
      broadcastState();
      emitEvent({
        type: "marks.commit",
        text: msg.text,
        batchId: msg.batchId,
        variantId: msg.variantId,
        marks,
      });
    } else if (t === "aspect.set") {
      if (typeof msg.aspect !== "string") return;
      state.aspect = msg.aspect;
      broadcastState();
      emitEvent({ type: "aspect.set", aspect: msg.aspect });
    } else if (t === "size.set") {
      if (msg.size !== "1K" && msg.size !== "2K") return;
      state.size = msg.size;
      broadcastState();
      emitEvent({ type: "size.set", size: msg.size });
    } else if (t === "submit") {
      broadcast({ type: "submit" });
      emitEvent({ type: "submit" });
      resolveDone({ code: 0, reason: "submit" });
    } else if (t === "cancel") {
      broadcast({ type: "cancel" });
      resolveDone({ code: 130, reason: "cancel" });
    }
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
            .then(async (body) => {
              touch();
              await handleAgentMsg(body as Record<string, unknown>);
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
              ? new Response(f, { headers: { "Content-Type": guessMime(assetName) } })
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
              `imago: bad json from browser: ${e instanceof Error ? e.message : String(e)}\n`,
            );
            return;
          }
          handleBrowserMsg(msg);
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
  if (!sessionId) sessionId = `imago-${randHex(4)}-p${boundPort}`;
  sessionFilesDir = join(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync(sessionFilesDir, { recursive: true });
  } catch {
    /* fall back to no-file-paths (path stays "") */
  }
  // On restore, the snapshot's src blobs are self-contained but its file paths
  // are stale (old tmpdir, cleaned). Re-materialize files so the agent's vision
  // (Read by path) works again.
  if (restored) {
    for (const b of state.batches) {
      for (const v2 of b.variants) {
        if (v2.src) v2.path = saveDataUrl(sessionFilesDir, v2.id, v2.src) || v2.path;
        if (v2.analysis === undefined) v2.analysis = ""; // backfill pre-analysis snapshots
      }
    }
    for (const r of state.refs) {
      if (r.src) r.path = saveDataUrl(sessionFilesDir, r.id, r.src) || r.path;
      if (!r.hash && r.src) r.hash = contentHash(r.src); // backfill for pre-hash snapshots
      if (r.analysis === undefined) r.analysis = state.analysisCache[r.hash] ?? "";
    }
    saveSnapshot();
  }

  const url = `http://${host}:${boundPort}`;
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId });

  // Discovery files — cli.ts reads the port from here.
  const sessionFile = join(tmpdir(), `imago-${sessionId}.json`);
  const latestFile = join(tmpdir(), `imago-latest.json`);
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
      `imago: could not write discovery file: ${e instanceof Error ? e.message : String(e)}\n`,
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
  saveSnapshot(); // final write — keep it (the resume point, NOT deleted on close)
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

export type { Batch, ImagoState, Variant } from "../surface/state/types";
export { defaultState } from "../surface/state/types";
export { main, parsePortFromSessionId };
