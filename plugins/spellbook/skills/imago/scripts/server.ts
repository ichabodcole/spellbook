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
  type ContextEntry,
  defaultState,
  type ImagoState,
  type Layer,
  MARK_TOOLS,
  type Mark,
  type Message,
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
  // `id` can be agent-supplied (batch/ref ids) — sanitize so it can't traverse
  // out of the session files dir via `..` or absolute-path segments.
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(dir, `${safeId}${ext}`);
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
function contextForAgent(e: ContextEntry): Omit<ContextEntry, "image"> {
  const { image: _drop, ...rest } = e;
  return rest; // agent reads imagePath, not the inlined blob
}

// Strip the (large) inlined bitmap from an image-layer mark in the agent
// projection — the agent reads the flattened composite, never per-layer bitmaps.
// Vector/pin marks pass through unchanged.
function markForAgent(m: Mark): Mark | Omit<Extract<Mark, { tool: "image" }>, "src"> {
  if (m.tool === "image") {
    const { src: _drop, ...rest } = m;
    return rest;
  }
  return m;
}

export function leanState(s: ImagoState) {
  return {
    ...s,
    batches: s.batches.map(batchForAgent),
    library: s.library.map(contextForAgent),
    marksByVariant: Object.fromEntries(
      Object.entries(s.marksByVariant).map(([vid, marks]) => [vid, marks.map(markForAgent)]),
    ),
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

  // In-memory, per-variant mark-edit history (undo/redo). Situational — NOT
  // snapshotted, so it resets on redeploy; that's intended. Each mutating mark op
  // snapshots the pre-mutation marks for that variant onto `undo` and clears
  // `redo`. Capped so it can't grow without bound.
  const HISTORY_CAP = 100;
  // A history entry snapshots BOTH the marks AND the layer containers for a
  // variant, so a layer rename/reorder/visibility/group op is atomically undoable
  // alongside element edits (container model — see type Layer).
  type MarkSnap = { marks: Mark[]; layers: Layer[] };
  const markHistory: Record<string, { undo: MarkSnap[]; redo: MarkSnap[] }> = {};
  const histFor = (vid: string) => (markHistory[vid] ??= { undo: [], redo: [] });
  // ONE freshness flag per variant: the agent hasn't seen these marks yet. Set on
  // every mark change; cleared when the agent receives the marked image (commit
  // button OR a say that carries it). See ImagoState.marksUnseen.
  const markUnseen: Record<string, boolean> = {};
  const snapFor = (vid: string): MarkSnap => ({
    marks: structuredClone(state.marksByVariant[vid] ?? []),
    layers: structuredClone(state.layersByVariant[vid] ?? []),
  });
  const pushHistory = (vid: string | undefined) => {
    if (!vid) return;
    markUnseen[vid] = true; // a mark/layer is about to change → agent's view is stale
    const h = histFor(vid);
    h.undo.push(snapFor(vid));
    if (h.undo.length > HISTORY_CAP) h.undo.shift();
    h.redo = []; // a fresh edit forks the timeline — redo is no longer valid
  };
  // Container model: every element belongs to a Layer. A new vector mark drops
  // into the active draw layer — the topmost NON-image layer (drawing "into" an
  // image layer reads oddly), creating a default "Annotations" layer if there's
  // no non-image layer yet (its push lands above any image layers, so annotations
  // paint over the collage). The active layer is otherwise surface-owned: mark.add
  // honors a valid client `mark.layerId` and only falls back to this. Call AFTER
  // pushHistory so the auto-created layer is part of the same undoable step.
  const ensureDrawLayer = (vid: string): string => {
    if (!state.layersByVariant[vid]) state.layersByVariant[vid] = [];
    const layers = state.layersByVariant[vid];
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i].kind !== "image") return layers[i].id;
    }
    const layer: Layer = { id: newId("layer"), name: "Annotations", kind: "annotation" };
    layers.push(layer);
    return layer.id;
  };
  // A single element's natural container kind + label (used by group/ungroup).
  const kindForTool = (tool: Mark["tool"]): Layer["kind"] =>
    tool === "image" ? "image" : tool === "draw" ? "sketch" : "annotation";
  const TOOL_LABEL: Record<Mark["tool"], string> = {
    pin: "Pin",
    arrow: "Arrow",
    line: "Line",
    rect: "Rectangle",
    ellipse: "Ellipse",
    draw: "Sketch",
    image: "Image",
  };
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
    // derive undo/redo availability for the focused variant (kept fresh here so
    // the toolbar buttons reflect the live history without a separate channel)
    const h = state.focus ? markHistory[state.focus.variantId] : undefined;
    state.history = { canUndo: (h?.undo.length ?? 0) > 0, canRedo: (h?.redo.length ?? 0) > 0 };
    state.marksUnseen = state.focus ? (markUnseen[state.focus.variantId] ?? false) : false;
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
  // The references "set" is just the variants flagged refSelected (one source of
  // truth; used by both the say + marks.commit handoffs). See refs-as-assets plan.
  const selectedRefIds = (): string[] =>
    state.batches
      .flatMap((b) => b.variants)
      .filter((v) => v.refSelected)
      .map((v) => v.id);
  // Import an external image as a one-variant import-kind batch — the unified path
  // for "bring in a working image" AND "add a reference". Hashes for dedup +
  // analysisCache; if the same pixels are already imported, returns the existing
  // variant (no duplicate). Caller decides focus/refSelected.
  function importImageVariant(src: string, name?: string): { batchId: string; variant: Variant } {
    const hash = contentHash(src);
    for (const b of state.batches) {
      const ex = b.variants.find((v) => v.hash === hash);
      if (ex) {
        if (name && !ex.name) ex.name = name; // fill a missing name on a dedup hit
        return { batchId: b.id, variant: ex };
      }
    }
    const vid = newId("v");
    const batchId = newId("b");
    const variant: Variant = {
      id: vid,
      src,
      path: saveDataUrl(sessionFilesDir, vid, src),
      liked: false,
      analysis: state.analysisCache[hash] ?? "", // reuse a prior read of the same pixels
      name,
      hash,
    };
    state.batches.push({ id: batchId, kind: "import", prompt: "", tag: name, variants: [variant] });
    return { batchId, variant };
  }
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
        broadcastState(); // marks are durable per variant — switching never clears them
      }
    } else if (t === "ref.select") {
      // the agent points a variant at the next gen — the user sees it highlight
      const hit = findVariant(msg.id as string);
      if (!hit) return;
      hit.variant.refSelected = msg.selected === true;
      broadcastState();
    } else if (t === "variant.analyze") {
      // the agent writes its read onto a generated/imported image — durable
      // metadata stored on the variant (persists in the snapshot).
      const hit = findVariant(msg.id as string);
      if (!hit || typeof msg.text !== "string") return;
      hit.variant.analysis = msg.text;
      // imported images carry a hash → cache by it so re-importing the same pixels
      // reuses the read (preserves the old ref.analyze behavior across the merge)
      if (hit.variant.hash) state.analysisCache[hit.variant.hash] = msg.text;
      broadcastState();
    } else if (t === "style.add") {
      if (typeof msg.name === "string" && msg.name.trim()) {
        const name = normStyle(msg.name);
        const description = typeof msg.description === "string" ? msg.description : undefined;
        // a captured style carries a canonical example image — materialize it
        const imageSrc =
          typeof msg.image === "string" && msg.image.startsWith("data:") ? msg.image : undefined;
        const imagePath = imageSrc
          ? saveDataUrl(sessionFilesDir, newId("style"), imageSrc) || undefined
          : undefined;
        const existing = state.styles.find((s) => s.name === name);
        if (existing) {
          existing.active = true;
          existing.captured = true;
          if (description !== undefined) existing.description = description;
          if (imageSrc) {
            existing.image = imageSrc;
            existing.imagePath = imagePath;
          }
        } else {
          state.styles.push({
            name,
            active: true,
            captured: true,
            description,
            image: imageSrc,
            imagePath,
          });
        }
        broadcastState();
      }
    } else if (t === "prompt.add") {
      if (typeof msg.label === "string" && typeof msg.text === "string" && msg.text.trim()) {
        state.prompts.push({
          id: newId("prompt"),
          label: msg.label.trim() || "prompt",
          text: msg.text,
        });
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
  async function handleBrowserMsg(msg: Record<string, unknown>) {
    const t = msg.type as string;
    if (t === "say") {
      if (typeof msg.text !== "string" || !msg.text) return;
      pushMessage({ role: "user", kind: "text", text: msg.text });
      // A message about a freshly-marked image rides the marked image + geometry
      // along (one freshness signal). The surface attaches flattenedSrc only when
      // the focused image has unseen marks; receiving it clears that flag.
      let flattenedImagePath: string | undefined;
      let attachedMarks: Mark[] | undefined;
      const fvid = state.focus?.variantId;
      if (fvid && typeof msg.flattenedSrc === "string" && msg.flattenedSrc.startsWith("data:")) {
        flattenedImagePath =
          saveDataUrl(sessionFilesDir, newId("flat"), msg.flattenedSrc) || undefined;
        attachedMarks = state.marksByVariant[fvid] ?? [];
        markUnseen[fvid] = false; // the agent now has the latest marks
      }
      broadcastState();
      // ambient board state (focus + selected refs) rides the message, so the
      // agent has "which image, with which refs" without subscribing to the
      // ambient focus.set/ref.select events (which no longer notify).
      emitEvent({
        type: "say",
        text: msg.text,
        focus: state.focus,
        selectedRefIds: selectedRefIds(),
        flattenedImagePath,
        marks: attachedMarks,
      });
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
      broadcastState(); // marks are durable per variant — switching never clears them
    } else if (t === "focus.clear") {
      state.focus = null;
      broadcastState();
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
    } else if (t === "variant.remove") {
      // delete a variant from the library: drop it from its batch (and drop the
      // batch when it empties), clean its annotations/layers/history, and clear
      // focus if it was the focused one. Ambient (library curation) — no agent
      // event; the agent reads the new state.
      const batchId = msg.batchId;
      const variantId = msg.variantId;
      if (typeof batchId !== "string" || typeof variantId !== "string") return;
      const batch = state.batches.find((b) => b.id === batchId);
      if (!batch?.variants.some((v) => v.id === variantId)) return;
      batch.variants = batch.variants.filter((v) => v.id !== variantId);
      if (batch.variants.length === 0) {
        state.batches = state.batches.filter((b) => b.id !== batchId);
      }
      delete state.marksByVariant[variantId];
      delete state.layersByVariant[variantId];
      delete markHistory[variantId];
      delete markUnseen[variantId];
      if (state.focus?.variantId === variantId) state.focus = null;
      broadcastState();
    } else if (t === "style.toggle") {
      if (typeof msg.name !== "string") return;
      const name = normStyle(msg.name);
      const s = state.styles.find((x) => x.name === name);
      if (!s) return;
      s.active = !s.active;
      broadcastState();
    } else if (t === "style.remove") {
      if (typeof msg.name === "string") {
        const name = normStyle(msg.name);
        state.styles = state.styles.filter((x) => x.name !== name);
        broadcastState();
      }
    } else if (t === "prompt.add") {
      if (typeof msg.label === "string" && typeof msg.text === "string" && msg.text.trim()) {
        state.prompts.push({
          id: newId("prompt"),
          label: msg.label.trim() || "prompt",
          text: msg.text,
        });
        broadcastState();
      }
    } else if (t === "prompt.update") {
      const p = state.prompts.find((x) => x.id === msg.id);
      if (p) {
        if (typeof msg.label === "string") p.label = msg.label.trim() || p.label;
        if (typeof msg.text === "string") p.text = msg.text;
        broadcastState();
      }
    } else if (t === "prompt.remove") {
      if (typeof msg.id === "string") {
        state.prompts = state.prompts.filter((x) => x.id !== msg.id);
        broadcastState();
      }
    } else if (t === "style.capture") {
      // carry the focused variant so the agent knows which image to read the
      // look from (focus.set no longer notifies).
      emitEvent({ type: "style.capture", focus: state.focus });
    } else if (t === "pin.add") {
      if (typeof msg.key !== "string" || typeof msg.value !== "string") return;
      const ex = state.pins.find((p) => p.key === msg.key);
      if (ex) ex.value = msg.value;
      else state.pins.push({ key: msg.key, value: msg.value });
      broadcastState();
    } else if (t === "pin.remove") {
      state.pins = state.pins.filter((p) => p.key !== msg.key);
      broadcastState();
    } else if (t === "ref.add") {
      // add an external image as a reference = import it as a library variant +
      // flag it refSelected (dedup → selects the existing one, no duplicate). Does
      // NOT steal focus (a ref isn't the working image; image.import is).
      const raw = msg.image as Record<string, unknown> | undefined;
      if (!raw || typeof raw.src !== "string") return;
      // leave name undefined when not supplied (don't store a "reference"
      // placeholder — a later image.import of the same pixels can fill the name)
      const name = typeof raw.name === "string" ? raw.name : undefined;
      const { variant } = importImageVariant(raw.src, name);
      variant.refSelected = true;
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `📎 you pointed at a reference (${variant.name ?? "image"})`,
        gesture: { kind: "ref-added", targetId: variant.id },
      });
      broadcastState();
    } else if (t === "ref.remove") {
      // DESELECT a variant as a ref — it stays in the library (delete = variant.remove)
      const hit = findVariant(msg.id as string);
      if (!hit) return;
      hit.variant.refSelected = false;
      broadcastState();
    } else if (t === "ref.select") {
      const hit = findVariant(msg.id as string);
      if (!hit) return;
      hit.variant.refSelected = msg.selected === true;
      broadcastState();
    } else if (t === "image.import") {
      // the user dropped their own image onto the canvas — a working image
      // (a one-variant "import" batch), focused so they can annotate/edit it
      const raw = msg.image as Record<string, unknown> | undefined;
      if (!raw || typeof raw.src !== "string") return;
      const name = typeof raw.name === "string" ? raw.name : "imported image";
      const { batchId, variant } = importImageVariant(raw.src, name);
      state.focus = { batchId, variantId: variant.id };
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `🖼 you brought in an image to work on (${variant.name ?? name})`,
        gesture: { kind: "imported", targetId: variant.id },
      });
      broadcastState();
    } else if (t === "layer.addImage") {
      // drop an image as a LAYER on the focused image (collage). The client
      // supplies the fraction-space box (it knows the base image box + the dropped
      // bitmap's aspect); default to a centered 40% box. No agent event until
      // commit (same rule as mark.add) — the flattened composite carries it.
      const vid = state.focus?.variantId;
      const raw = msg as {
        src?: unknown;
        name?: unknown;
        x?: unknown;
        y?: unknown;
        w?: unknown;
        h?: unknown;
      };
      if (!vid || typeof raw.src !== "string") return;
      const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
      const w = num(raw.w, 0.4);
      const h = num(raw.h, 0.4);
      const x = num(raw.x, (1 - w) / 2);
      const y = num(raw.y, (1 - h) / 2);
      const optimized = await optimizeSrc(raw.src);
      pushHistory(vid); // after the await, so any interleaved edit is in the snapshot
      if (!state.layersByVariant[vid]) state.layersByVariant[vid] = [];
      const layer: Layer = {
        id: newId("layer"),
        name: typeof raw.name === "string" && raw.name ? raw.name : "Image",
        kind: "image",
      };
      state.layersByVariant[vid].push(layer); // a new image layer on top
      if (!state.marksByVariant[vid]) state.marksByVariant[vid] = [];
      const arr = state.marksByVariant[vid];
      arr.push({
        id: newId("img"),
        tool: "image",
        src: optimized,
        x,
        y,
        w,
        h,
        layerId: layer.id,
        zOrder: arr.length,
      });
      broadcastState();
    } else if (t === "layer.add") {
      // a blank layer on top — becomes the surface's active draw target
      const vid = state.focus?.variantId;
      if (!vid) return;
      if (!state.layersByVariant[vid]) state.layersByVariant[vid] = [];
      pushHistory(vid);
      const kind: Layer["kind"] =
        msg.kind === "sketch" || msg.kind === "image" ? msg.kind : "annotation";
      state.layersByVariant[vid].push({
        id: newId("layer"),
        name: typeof msg.name === "string" && msg.name ? msg.name : "Layer",
        kind,
      });
      broadcastState();
    } else if (t === "layer.rename") {
      const vid = state.focus?.variantId;
      const layer = vid ? state.layersByVariant[vid]?.find((l) => l.id === msg.id) : undefined;
      if (!layer || typeof msg.name !== "string" || !msg.name || layer.name === msg.name) return;
      pushHistory(vid);
      layer.name = msg.name;
      broadcastState();
    } else if (t === "layer.setHidden" || t === "layer.setLocked") {
      const vid = state.focus?.variantId;
      const layer = vid ? state.layersByVariant[vid]?.find((l) => l.id === msg.id) : undefined;
      const key = t === "layer.setHidden" ? "hidden" : "locked";
      const next = t === "layer.setHidden" ? msg.hidden : msg.locked;
      if (!layer || typeof next !== "boolean" || Boolean(layer[key]) === next) return;
      pushHistory(vid);
      layer[key] = next;
      broadcastState();
    } else if (t === "layer.reorder") {
      // absolute placement (drag-drop): move layer `id` to `toIndex` (back→front)
      const vid = state.focus?.variantId;
      const layers = vid ? state.layersByVariant[vid] : undefined;
      const idx = layers?.findIndex((l) => l.id === msg.id) ?? -1;
      if (!vid || !layers || idx < 0 || typeof msg.toIndex !== "number") return;
      const to = Math.max(0, Math.min(layers.length - 1, Math.trunc(msg.toIndex)));
      if (to === idx) return;
      pushHistory(vid);
      const [l] = layers.splice(idx, 1);
      layers.splice(to, 0, l);
      broadcastState();
    } else if (t === "layer.remove") {
      // delete a layer AND the elements it contained
      const vid = state.focus?.variantId;
      if (!vid || !state.layersByVariant[vid]?.some((l) => l.id === msg.id)) return;
      pushHistory(vid);
      state.layersByVariant[vid] = state.layersByVariant[vid].filter((l) => l.id !== msg.id);
      if (state.marksByVariant[vid]) {
        state.marksByVariant[vid] = state.marksByVariant[vid].filter((m) => m.layerId !== msg.id);
      }
      broadcastState();
    } else if (t === "group") {
      // wrap the selected marks in a new layer on top; reassign layerId/zOrder.
      const vid = state.focus?.variantId;
      const ids = msg.markIds;
      if (!vid || !Array.isArray(ids) || !ids.length) return;
      const marks = state.marksByVariant[vid] ?? [];
      const idSet = new Set(ids.filter((x): x is string => typeof x === "string"));
      const picked = marks.filter((m) => idSet.has(m.id));
      if (!picked.length) return;
      pushHistory(vid);
      if (!state.layersByVariant[vid]) state.layersByVariant[vid] = [];
      const layers = state.layersByVariant[vid];
      const sourceIds = new Set(picked.map((m) => m.layerId).filter(Boolean) as string[]);
      // homogeneous selections keep their kind (a pure-image group must stay an
      // image layer — else ensureDrawLayer would treat it as a draw target and the
      // panel would show a shapes icon instead of the bitmap thumbnail); a mixed
      // selection is a generic annotation group.
      const group: Layer = {
        id: newId("layer"),
        name: typeof msg.name === "string" && msg.name ? msg.name : "Group",
        kind: picked.every((m) => m.tool === "draw")
          ? "sketch"
          : picked.every((m) => m.tool === "image")
            ? "image"
            : "annotation",
      };
      layers.push(group);
      picked.forEach((m, i) => {
        m.layerId = group.id;
        m.zOrder = i;
      });
      // prune source layers the move emptied (never the new one or a still-occupied one)
      state.layersByVariant[vid] = layers.filter(
        (l) => l.id === group.id || !sourceIds.has(l.id) || marks.some((m) => m.layerId === l.id),
      );
      broadcastState();
    } else if (t === "ungroup") {
      // dissolve a layer → each element becomes its own group-of-one layer in place
      const vid = state.focus?.variantId;
      const layers = vid ? state.layersByVariant[vid] : undefined;
      const at = layers?.findIndex((l) => l.id === msg.id) ?? -1;
      if (!vid || !layers || at < 0) return;
      const members = (state.marksByVariant[vid] ?? [])
        .filter((m) => m.layerId === msg.id)
        .sort((a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0));
      if (members.length < 2) return; // 0/1 element is already a group-of-one
      pushHistory(vid);
      const fresh: Layer[] = members.map((m) => {
        const id = newId("layer");
        m.layerId = id;
        m.zOrder = 0;
        return { id, name: TOOL_LABEL[m.tool], kind: kindForTool(m.tool) };
      });
      layers.splice(at, 1, ...fresh); // replace the dissolved layer, preserving z-band
      broadcastState();
    } else if (t === "mark.add") {
      const mk = msg.mark as Mark | undefined;
      const vid = state.focus?.variantId;
      if (!vid || !mk?.id || !MARK_TOOLS.includes(mk.tool)) return;
      pushHistory(vid);
      if (!state.marksByVariant[vid]) state.marksByVariant[vid] = [];
      const arr = state.marksByVariant[vid];
      // container model: honor a valid client-chosen active layer, else default
      const wanted = typeof mk.layerId === "string" ? mk.layerId : undefined;
      const onLayer = wanted && state.layersByVariant[vid]?.some((l) => l.id === wanted);
      mk.layerId = onLayer ? (wanted as string) : ensureDrawLayer(vid);
      mk.zOrder = arr.length; // server is authoritative for z-order
      arr.push(mk);
      broadcastState(); // incremental — no agent event until commit
    } else if (t === "mark.remove") {
      const vid = state.focus?.variantId;
      if (!vid || !state.marksByVariant[vid]) return;
      if (!state.marksByVariant[vid].some((m) => m.id === msg.id)) return; // no-op → no history
      pushHistory(vid);
      state.marksByVariant[vid] = state.marksByVariant[vid].filter((m) => m.id !== msg.id);
      broadcastState();
    } else if (t === "mark.update") {
      // move/resize/relabel a committed mark on the focused image; merge
      // geometry/label/style keys only, never id/tool/zOrder (server-owned).
      const vid = state.focus?.variantId;
      const m = vid
        ? (state.marksByVariant[vid]?.find((x) => x.id === msg.id) as
            | Record<string, unknown>
            | undefined)
        : undefined;
      const patch = msg.patch as Record<string, unknown> | undefined;
      if (!m || !patch || typeof patch !== "object") return;
      pushHistory(vid);
      for (const [k, val] of Object.entries(patch)) {
        if (k === "id" || k === "tool" || k === "zOrder") continue;
        if (typeof val === "number" || typeof val === "string") {
          m[k] = val;
        } else if (
          // a draw mark's `points` move/resize as a whole array of {x,y}
          k === "points" &&
          Array.isArray(val) &&
          val.every(
            (p) =>
              p &&
              typeof p === "object" &&
              typeof (p as { x: unknown }).x === "number" &&
              typeof (p as { y: unknown }).y === "number",
          )
        ) {
          m[k] = val;
        }
      }
      broadcastState();
    } else if (t === "mark.reorder") {
      const vid = state.focus?.variantId;
      if (!vid || !state.marksByVariant[vid]) return;
      const sorted = [...state.marksByVariant[vid]].sort(
        (a, b) => (a.zOrder ?? 0) - (b.zOrder ?? 0),
      );
      const idx = sorted.findIndex((m) => m.id === msg.id);
      if (idx < 0) return;
      pushHistory(vid); // state.marksByVariant[vid] is still the pre-reorder array
      const [m] = sorted.splice(idx, 1);
      const target =
        msg.direction === "front"
          ? sorted.length
          : msg.direction === "back-most"
            ? 0
            : msg.direction === "forward"
              ? Math.min(sorted.length, idx + 1)
              : Math.max(0, idx - 1); // "back"
      sorted.splice(target, 0, m);
      sorted.forEach((mm, i) => {
        mm.zOrder = i;
      });
      state.marksByVariant[vid] = sorted;
      broadcastState();
    } else if (t === "marks.clear") {
      const vid = state.focus?.variantId;
      if (vid && state.marksByVariant[vid]?.length) {
        pushHistory(vid);
        state.marksByVariant[vid] = [];
        broadcastState();
      }
    } else if (t === "marks.replace") {
      // wholesale swap of the focused image's marks (the eraser trims/splits
      // several strokes at once → one message, one history step). Validate +
      // re-assign zOrder by position (server-authoritative), like mark.add.
      const vid = state.focus?.variantId;
      const incoming = msg.marks as Mark[] | undefined;
      if (!vid || !Array.isArray(incoming)) return;
      const valid = incoming.filter((m) => m?.id && MARK_TOOLS.includes(m.tool));
      pushHistory(vid);
      valid.forEach((m, i) => {
        m.zOrder = i;
      });
      state.marksByVariant[vid] = valid;
      broadcastState();
    } else if (t === "undo" || t === "redo") {
      const vid = state.focus?.variantId;
      if (!vid) return;
      const h = histFor(vid);
      const from = t === "undo" ? h.undo : h.redo;
      const to = t === "undo" ? h.redo : h.undo;
      if (!from.length) return;
      to.push(snapFor(vid));
      const prev = from.pop() as MarkSnap;
      state.marksByVariant[vid] = prev.marks;
      state.layersByVariant[vid] = prev.layers;
      markUnseen[vid] = true; // the marks/layers changed → agent's view is stale again
      broadcastState();
    } else if (t === "marks.commit") {
      if (
        typeof msg.text !== "string" ||
        typeof msg.batchId !== "string" ||
        typeof msg.variantId !== "string"
      )
        return;
      const marks = state.marksByVariant[msg.variantId] ?? [];
      // The visual handoff: the surface sends the image with marks burned in as a
      // data-url; materialize it to disk so the agent can --ref it directly. The
      // blob stays browser→server only — just the path rides the SSE event.
      let flattenedImagePath: string | undefined;
      if (typeof msg.flattenedSrc === "string" && msg.flattenedSrc.startsWith("data:")) {
        flattenedImagePath =
          saveDataUrl(sessionFilesDir, newId("flat"), msg.flattenedSrc) || undefined;
      }
      pushMessage({
        role: "user",
        kind: "gesture",
        text: `✍️ ${msg.text}`,
        gesture: { kind: "marked", targetId: msg.variantId },
      });
      // committing hands a SNAPSHOT to the agent but leaves the marks in place —
      // they're durable annotations on the image, not consumed by the send. The
      // user clears them explicitly (marks.clear) when they're done with them.
      markUnseen[msg.variantId] = false; // the agent now has the latest marks
      broadcastState();
      emitEvent({
        type: "marks.commit",
        text: msg.text,
        batchId: msg.batchId,
        variantId: msg.variantId,
        marks,
        selectedRefIds: selectedRefIds(),
        flattenedImagePath,
      });
    } else if (t === "aspect.set") {
      if (typeof msg.aspect !== "string") return;
      state.aspect = msg.aspect;
      broadcastState();
    } else if (t === "size.set") {
      if (msg.size !== "1K" && msg.size !== "2K") return;
      state.size = msg.size;
      broadcastState();
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
          void handleBrowserMsg(msg);
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
    // refs-as-assets migration: a legacy `refs[]` array → an import-kind batch of
    // variants, REUSING each ref id as the variant id (so re-restore is idempotent
    // and any historical selectedRefIds still resolve). Runs BEFORE materialization
    // so the new variants get their on-disk paths.
    type LegacyRef = {
      id: string;
      src: string;
      path?: string;
      name?: string;
      selected?: boolean;
      hash?: string;
      analysis?: string;
    };
    const legacyRefs = (state as { refs?: LegacyRef[] }).refs;
    if (Array.isArray(legacyRefs) && legacyRefs.length) {
      state.batches.push({
        id: newId("b"),
        kind: "import",
        prompt: "",
        tag: "references",
        variants: legacyRefs.map((r) => {
          const hash = r.hash ?? (r.src ? contentHash(r.src) : undefined);
          // seed the hash→analysis cache so deleting + re-importing the same pixels
          // still reuses the agent's prior read (the old delete/re-add invariant)
          if (hash && r.analysis) state.analysisCache[hash] = r.analysis;
          return {
            id: r.id, // reuse the ref id as the variant id
            src: r.src,
            path: r.path ?? "",
            liked: false,
            analysis: r.analysis ?? "",
            name: r.name,
            refSelected: r.selected === true,
            hash,
          };
        }),
      });
    }
    delete (state as { refs?: unknown }).refs;

    for (const b of state.batches) {
      for (const v2 of b.variants) {
        if (v2.src) v2.path = saveDataUrl(sessionFilesDir, v2.id, v2.src) || v2.path;
        if (v2.analysis === undefined) v2.analysis = ""; // backfill pre-analysis snapshots
      }
    }
    // Migrate pre-durability snapshots: a legacy global `marks` array → the
    // focused variant's bucket. Then normalize zOrder within each bucket.
    const legacy = (state as { marks?: Mark[] }).marks;
    if (Array.isArray(legacy)) {
      if (legacy.length && state.focus) state.marksByVariant[state.focus.variantId] = legacy;
      delete (state as { marks?: Mark[] }).marks;
    }
    state.marksByVariant ??= {};
    state.layersByVariant ??= {};
    for (const vid of Object.keys(state.marksByVariant)) {
      const marks = state.marksByVariant[vid];
      // Backfill the container model: wrap pre-layer marks into one default
      // "Annotations" layer, then stamp layerId + normalize zOrder by position.
      let layers = state.layersByVariant[vid];
      if (!layers?.length && marks.length) {
        layers = [{ id: newId("layer"), name: "Annotations", kind: "annotation" }];
        state.layersByVariant[vid] = layers;
      }
      const defaultLayerId = layers?.[layers.length - 1]?.id;
      state.marksByVariant[vid] = marks.map((m, i) => ({
        ...m,
        zOrder: m.zOrder === undefined ? i : m.zOrder,
        layerId: m.layerId ?? defaultLayerId,
      }));
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
