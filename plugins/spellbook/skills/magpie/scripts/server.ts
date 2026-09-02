#!/usr/bin/env bun

// magpie — a standing conjuration over a composite image.
//
// The daemon holds the canonical extraction state; the React surface shows the
// element breakdown, the user judges each cutout, compares removal-model
// results, and selectively retries. The agent drives discovery + extraction out
// of band and posts results here; the surface is where the user steers.
//
// Architecture (cli.ts wraps this):
//   - Agent ↔ server: HTTP on the same Bun.serve.
//       POST /cmd            — agent command (JSON; AgentCommand union)
//       GET  /state[?lean=1] — full snapshot { state, cursor }; lean strips blobs
//       GET  /events?since=N — SSE stream of user events (Monitor-wrappable)
//   - Server ↔ browser: WebSocket at /ws (ClientToServer / ServerToClient).
//   - GET /assets/<name>     — serve per-session files (source/cutouts) from a
//                              per-session tmp dir, sanitized against traversal.
//   - Server holds canonical state; full-state broadcast to browsers on change.
//
// The single contract is shared/types.ts (the AgentCommand / ClientToServer
// unions + AGENT_EVENT_TYPES) — TWO-SIDED, so it sits in the spell's own
// shared/ rather than in either side's tree. Pure mutators live in
// scripts/reduce.ts and snapshot persistence in scripts/persist.server.ts;
// both are daemon-only and neither is imported by browser code.
//
// Exit codes: 0 submit/close, 2 bad args, 124 idle timeout, 130 cancel.

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import {
  type AgentCommand,
  type Backdrop,
  type ClientToServer,
  defaultState,
  type Element,
  type ElementStatus,
  type MagpieState,
  type PhaseKey,
} from "../shared/types";
import { loadSnapshot, saveSnapshot, snapshotsDir } from "./persist.server";
import {
  addElement,
  addVersion,
  advancePhase,
  chooseVersion,
  flagElement,
  judgeElement,
  leanState,
  pushMessage,
  removeElement,
  setBackdrop,
  setBundle,
  setElements,
  setIntent,
  setPhase,
  setSource,
  setStatus,
  updateElement,
} from "./reduce";
import { materializeSource } from "./source.server";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── surface mode (seams Contract 1) ─────────────────────────────────────────
//
// `import index from "../surface/index.html"` used to sit at the top of this
// file. A top-level STATIC import forces Bun to resolve the whole .tsx +
// Tailwind build graph when the module LOADS, so a destination that ships
// dist/ and no surface/ — the published artifact — dies before it can serve
// the dist it does have. The dev import is therefore dynamic and reached only
// on the dev branch, as astrolabe, imago and mind-mapper all do it.
//
// ⛔ MAGPIE'S dist/ ALREADY EXISTED, HOLDING cli.js AND NO index.html — which
// is precisely why this daemon stayed correctly in DEV mode through all of
// Slice 2. The FIRST surface build to land an index.html here FLIPS
// resolveMode(), and nothing announces the transition. `dist/` existing is not
// the discriminator; `dist/index.html` is.
//
// Paths anchor at the SKILL ROOT, never at cwd: cli.ts pins the daemon's cwd
// for bunfig.toml's sake (Contract 5), so cwd is not a stable base for dist/.
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");

// release iff dist/index.html exists at the skill root, else dev; the env
// override wins either way (seams Contract 1). Release: zero reads of surface/
// or bunfig.toml — static files only.
function resolveMode(): "dev" | "release" {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release") return override;
  return existsSync(join(DIST_DIR, "index.html")) ? "release" : "dev";
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Serves dist/ verbatim — entry index.html, hashed chunk-*.js/css by path
// (Contract 2's flat, relative-href layout). Path traversal guarded (a static
// asset request is always a bare filename, never nested), which is also what
// keeps this clear of magpie's own /assets/<name> route above it.
function serveDist(path: string): Response | null {
  const rel = path === "/" ? "index.html" : path.slice(1);
  if (rel.includes("..") || rel.includes("/")) return null;
  const file = join(DIST_DIR, rel);
  if (!existsSync(file)) return null;
  const ext = rel.slice(rel.lastIndexOf("."));
  return new Response(Bun.file(file), {
    headers: { "Content-Type": STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream" },
  });
}

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
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
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
        title: { type: "string", default: "magpie" },
        intent: { type: "string" },
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

  let state: MagpieState = defaultState(v.title as string);
  if (typeof v.intent === "string") state.intent = v.intent;
  let restored = false;
  if (v.restore) {
    const loaded = loadSnapshot(v.restore as string, v.title as string);
    if (loaded) {
      state = loaded;
      restored = true;
    } else {
      process.stderr.write(`magpie: restore failed (${v.restore})\n`);
    }
  }

  const sockets = new Set<ServerWebSocket<unknown>>();
  const enc = new TextEncoder();

  // Append-only event log for the agent's SSE tail; monotonic ids so a
  // reconnecting tail replays via ?since=<id>.
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
    snapDirty = true; // mark for the debounced persistence snapshot
    broadcast({ type: "state", state });
  };
  // Agent presence = at least one live SSE tail (an agent monitoring /events).
  // Runtime-only — pushed to browsers, never folded into persisted state.
  const broadcastPresence = () => broadcast({ type: "presence", agent: sseClients.size > 0 });

  // ── agent commands (POST /cmd) ────────────────────────────────────
  // #84 — RETURNS A VERDICT: `true` if the command type was RECOGNISED.
  // The switch below had 13 cases and NO `default:`, so an unrecognised type
  // fell straight through and the /cmd route still answered {ok:true} — a bogus
  // type was byte-identical to an executed one, measured live.
  //
  // "Recognised", NOT "changed state": several cases are guarded by a shape
  // check and legitimately do nothing, and reporting those as failures would
  // break working callers. The narrower contract is a deliberately unclaimed gap.
  //
  // ⚠ handleBrowserMsg below is a SEPARATE function with a near-identical
  // switch. It is NOT part of this verdict — the WebSocket has no response to
  // carry one — and must not be folded in.
  // Contract 13: the verdict originates in the code owning the recognised set.
  // b13 widens the RETURN without widening the CONTRACT — a command may answer
  // with a result object instead of the boolean, and every other command keeps
  // the bare boolean with a byte-identical response. Third spell on this shape
  // (imago 5e6aacd, glamour 34e8ab2), so it is a house pattern now.
  type AgentVerdict =
    | boolean
    | { recognised: true; ok: true; detail: Record<string, unknown> }
    | { recognised: true; ok: false; status: number; error: string };
  function handleAgentMsg(raw: Record<string, unknown>): AgentVerdict {
    const msg = raw as AgentCommand;
    switch (msg.type) {
      case "init":
        if (typeof msg.title === "string") state.title = msg.title;
        if (typeof msg.intent === "string") setIntent(state, msg.intent);
        broadcastState();
        break;
      case "say":
        if (typeof msg.text === "string" && msg.text) {
          // An optional inline CTA (a one-click shortcut for a conversational
          // act) rides along when the agent attaches one.
          pushMessage(state, { role: "agent", kind: "text", text: msg.text, action: msg.action });
          broadcastState();
        }
        break;
      case "ask":
        if (typeof msg.text === "string" && msg.text) {
          pushMessage(state, {
            role: "agent",
            kind: "question",
            text: msg.text,
            options: Array.isArray(msg.options) ? msg.options : undefined,
          });
          broadcastState();
        }
        break;
      case "source.set":
        if (typeof msg.path === "string" && Array.isArray(msg.size)) {
          setSource(state, { path: msg.path, size: msg.size, sha: String(msg.sha ?? "") });
          broadcastState();
        }
        break;
      case "elements.set":
        if (Array.isArray(msg.elements)) {
          setElements(state, msg.elements as Element[]);
          // Intake auto-seals to Slice once discovery returns elements — there's
          // nothing to "approve" about a drop, so no user gate for Intake.
          if (state.phase === "intake" && state.elements.length) advancePhase(state);
          broadcastState();
        }
        break;
      case "element.add":
        // The agent boxing a region incrementally. Broadcast so the surface
        // shows it; NO SSE (it's the agent's own move) and NO gesture message
        // (agent edits aren't "user gestures").
        // b13 + #87 (fourth spell) — this called the mutator WITHOUT CAPTURING
        // its return at all, which is the most complete drop of the family: the
        // browser path one screen down does `const el = addElement(...)` and
        // uses el.id/el.name, so the element's identity exists and only the
        // agent was denied it. It could not reference the box it had just
        // created.
        //
        // The guard was the second half: a malformed element fell through to the
        // terminal `return true`, so "nothing was added" and "added" were the
        // same answer. That one is an ambiguous absence, not a lost value.
        if (msg.element && Array.isArray(msg.element.bbox)) {
          const el = addElement(state, msg.element);
          broadcastState();
          return {
            recognised: true,
            ok: true,
            detail: { id: el.id, name: el.name, outcome: "created" },
          };
        }
        return {
          recognised: true,
          ok: false,
          status: 400,
          error:
            "element.add requires `element` with a `bbox` array — nothing was added " +
            "(the element is unchanged and no id was minted)",
        };
      case "element.update":
        // Partial-merge of name/type/bbox/status. Version results do NOT come
        // through here — they append via element.addVersion (a list op).
        if (typeof msg.id === "string" && msg.patch && updateElement(state, msg.id, msg.patch)) {
          broadcastState();
        }
        break;
      case "element.remove":
        // The agent retracting a box. Broadcast; NO SSE.
        if (typeof msg.id === "string" && removeElement(state, msg.id)) {
          broadcastState();
        }
        break;
      case "element.addVersion":
        // The agent posting a produced version (crop or removal result). Append
        // (upsert by model) + broadcast; NO SSE (it's the agent's own output).
        if (
          typeof msg.id === "string" &&
          msg.version &&
          addVersion(state, msg.id, msg.version, { choose: msg.choose ?? true })
        ) {
          broadcastState();
        }
        break;
      case "phase.set":
        // The agent advancing/moving the cursor on the user's conversational
        // request ("looks good, let's go"). Agent-driven → broadcast only.
        if (typeof msg.phase === "string" && setPhase(state, msg.phase as PhaseKey)) {
          broadcastState();
        }
        break;
      case "bundle.set":
        // The agent posting the built export bundle (after zipping). Broadcast so
        // the Export view offers the download; NO SSE (agent's own output).
        if (typeof msg.name === "string" && typeof msg.count === "number") {
          setBundle(state, msg.name, msg.count);
          broadcastState();
        }
        break;
      case "status":
        setStatus(state, msg.busy === true, typeof msg.text === "string" ? msg.text : "");
        broadcastState();
        break;
      case "close":
        resolveDone({ code: 0, reason: "close" });
        break;
      default:
        return false; // unrecognised type — the missing `default:` is the defect
    }
    return true;
  }

  // ── browser messages (WebSocket) ──────────────────────────────────
  function handleBrowserMsg(raw: Record<string, unknown>) {
    const msg = raw as ClientToServer;
    switch (msg.type) {
      case "say":
        if (typeof msg.text !== "string" || !msg.text) return;
        pushMessage(state, { role: "user", kind: "text", text: msg.text });
        broadcastState();
        emitEvent({ type: "say", text: msg.text });
        break;
      case "source.import": {
        // The user dropped a composite. Materialize it onto the session files
        // dir off-thread (decode/metadata is async), then set source + emit the
        // imperative the agent runs discover on. Failure logs to stderr; never
        // crashes the daemon.
        if (typeof msg.name !== "string" || typeof msg.dataUrl !== "string") return;
        void (async () => {
          try {
            const source = await materializeSource(sessionFilesDir, msg.name, msg.dataUrl);
            setSource(state, source);
            broadcastState();
            emitEvent({
              type: "source.added",
              path: source.path,
              size: source.size,
              sha: source.sha,
            });
          } catch (e) {
            process.stderr.write(
              `magpie: source.import failed: ${e instanceof Error ? e.message : String(e)}\n`,
            );
          }
        })();
        break;
      }
      case "element.add": {
        // The user drew a missed region — ambient editing of the breakdown.
        // Materialize it + log the gesture; do NOT push the agent: it picks the
        // new box up from /state when a cut actually fires.
        if (!msg.element || !Array.isArray(msg.element.bbox)) return;
        const el = addElement(state, msg.element);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `drew ${el.name}`,
          gesture: { kind: "draw", targetId: el.id },
        });
        broadcastState();
        break;
      }
      case "element.update": {
        // Move / resize / rename / retype — ambient editing of the breakdown, NOT
        // pushed to the agent (it reads the latest boxes from /state at cut time).
        // A gesture Message lands ONLY on a rename/retype; pure bbox moves are too
        // noisy even for the thread (they leave no message).
        if (typeof msg.id !== "string" || !msg.patch) return;
        if (!updateElement(state, msg.id, msg.patch)) return;
        const renamed = typeof msg.patch.name === "string";
        const retyped = typeof msg.patch.type === "string";
        if (renamed || retyped) {
          const el = state.elements.find((e) => e.id === msg.id);
          const text = renamed
            ? `renamed ${el?.name ?? msg.id}`
            : `retyped ${el?.name ?? msg.id} → ${msg.patch.type}`;
          pushMessage(state, {
            role: "user",
            kind: "gesture",
            text,
            gesture: { kind: renamed ? "rename" : "retype", targetId: msg.id },
          });
        }
        broadcastState();
        break;
      }
      case "element.remove": {
        // Hard-delete a box — ambient editing, not pushed to the agent (a removed
        // box is simply absent from /state at cut time). Capture the name first
        // for the gesture message.
        if (typeof msg.id !== "string") return;
        const name = state.elements.find((e) => e.id === msg.id)?.name ?? msg.id;
        if (!removeElement(state, msg.id)) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `removed ${name}`,
          gesture: { kind: "remove", targetId: msg.id },
        });
        broadcastState();
        break;
      }
      case "element.judge": {
        // Confirm / drop / restore an element — ambient editing, not pushed to the
        // agent (dropped boxes are skipped at cut time, read from /state).
        if (typeof msg.id !== "string") return;
        if (!judgeElement(state, msg.id, msg.status as ElementStatus)) return;
        const el = state.elements.find((e) => e.id === msg.id);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `judged ${el?.name ?? msg.id}: ${msg.status}`,
          gesture: { kind: "judge", targetId: msg.id },
        });
        broadcastState();
        break;
      }
      case "extract": {
        // The user asked to cut slices for the confirmed elements (or a subset,
        // on re-cut). The daemon stays thin — it does NOT spawn python; it hands
        // the agent the imperative (like discover, with the subset ids) and the
        // agent runs the cut loop, posting each result back via element.addVersion.
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids ? ids.length : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to cut ${n} slice${n === 1 ? "" : "s"}`,
          gesture: { kind: "extract" },
        });
        // Show the working signal IMMEDIATELY — without this the spinner only
        // appears once the agent picks up the SSE event and starts its cut loop
        // (seconds later), so the click feels like it did nothing. The agent's
        // cut loop clears it (status busy:false) when the cuts land.
        setStatus(state, true, `Re-slicing ${n} slice${n === 1 ? "" : "s"}…`);
        broadcastState();
        emitEvent({ type: "extract", ids });
        break;
      }
      case "element.flag": {
        // Flag / unflag for a re-run — ambient bookkeeping, NOT pushed to the
        // agent. The agent learns which to re-run from the extract/removeBg/
        // retryRemoval imperative (the user's "do it" click), not each flag toggle.
        if (typeof msg.id !== "string") return;
        const flagged = msg.flagged === true;
        if (!flagElement(state, msg.id, flagged)) return;
        const el = state.elements.find((e) => e.id === msg.id);
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: flagged ? `flagged ${el?.name ?? msg.id}` : `unflagged ${el?.name ?? msg.id}`,
          gesture: { kind: "flag", targetId: msg.id },
        });
        broadcastState();
        break;
      }
      case "version.choose":
        // Picking which version is chosen — an ambient preview/preference toggle,
        // like backdrop.set: too frequent + low-signal to log in the thread, and
        // never pushed to the agent. Just mutate + broadcast.
        if (typeof msg.id !== "string" || typeof msg.versionId !== "string") return;
        if (chooseVersion(state, msg.id, msg.versionId)) broadcastState();
        break;
      case "removeBg": {
        // Imperative: remove backgrounds for these (or all eligible) elements. The
        // agent picks the model + runs it. Flip busy immediately (the affordance).
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids ? ids.length : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to remove ${n} background${n === 1 ? "" : "s"}`,
          gesture: { kind: "removeBg" },
        });
        setStatus(state, true, `Removing ${n} background${n === 1 ? "" : "s"}…`);
        broadcastState();
        emitEvent({ type: "removeBg", ids });
        break;
      }
      case "retryRemoval": {
        // Imperative: "try a different removal" on these flagged items. Payload is
        // ids ONLY — the agent picks an unused model. Flip busy immediately.
        const ids = Array.isArray(msg.ids) ? msg.ids : [];
        if (!ids.length) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to try a different removal on ${ids.length}`,
          gesture: { kind: "retryRemoval" },
        });
        setStatus(state, true, `Trying a different removal on ${ids.length}…`);
        broadcastState();
        emitEvent({ type: "retryRemoval", ids });
        break;
      }
      case "backdrop.set":
        // ambient preview state — no agent event.
        if (setBackdrop(state, msg.backdrop as Backdrop)) broadcastState();
        break;
      case "phase.advance": {
        // The user sealing the active phase — an imperative hand-off. Advance the
        // cursor + tell the agent where we moved to. No-op at the last phase.
        const prev = state.phase;
        const next = advancePhase(state);
        if (!next) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `sealed ${prev} → ${next}`,
          gesture: { kind: "phase.advance" },
        });
        broadcastState();
        emitEvent({ type: "phase.advance", phase: next });
        break;
      }
      case "phase.set": {
        // Back-nav / jump — re-opens later phases for edits. A phase switch is a
        // deliberate relocation (NOT ambient editing), so it IS pushed to the
        // agent as context for what's coming (re-cuts likely) — even though
        // there's no action to take. Rare enough to never be spammy.
        if (typeof msg.phase !== "string") return;
        if (!setPhase(state, msg.phase as PhaseKey)) return;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `stepped to ${msg.phase}`,
          gesture: { kind: "phase.set", targetId: msg.phase },
        });
        broadcastState();
        emitEvent({ type: "phase.set", phase: msg.phase });
        break;
      }
      case "export": {
        // The user asked to build the downloadable bundle. Flip busy + emit to the
        // agent, which zips the chosen assets out of band then posts bundle.set.
        const ids = Array.isArray(msg.ids) ? msg.ids : undefined;
        const n = ids ? ids.length : state.elements.filter((e) => e.status !== "dropped").length;
        pushMessage(state, {
          role: "user",
          kind: "gesture",
          text: `asked to export ${n} asset${n === 1 ? "" : "s"}`,
          gesture: { kind: "export" },
        });
        setStatus(state, true, `Building bundle (${n} asset${n === 1 ? "" : "s"})…`);
        broadcastState();
        emitEvent({ type: "export", ids });
        break;
      }
      case "submit":
        broadcast({ type: "submit" });
        emitEvent({ type: "submit" });
        resolveDone({ code: 0, reason: "submit" });
        break;
      case "cancel":
        broadcast({ type: "cancel" });
        resolveDone({ code: 130, reason: "cancel" });
        break;
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
        broadcastPresence(); // an agent tail attached → tell the browsers
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
        broadcastPresence(); // the agent tail dropped → tell the browsers
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

  let sessionFilesDir = ""; // set once sessionId is known (after bind)

  const mode = resolveMode();

  // dev: the dynamic string-literal import keeps the surface graph off the
  // module load path (Contract 1) — Bun bundles the .tsx graph + Tailwind at
  // serve time, reading bunfig.toml from cwd, which cli.ts pins to src/magpie/
  // (Contract 5). hmr on for the surface iteration loop.
  // release: dist/ is static and pre-built (Contract 2) — "/" is answered by
  // serveDist() in the fetch fall-through below, so this branch never touches
  // surface/ or bunfig.toml and never needs either to exist.
  // Bun's Routes type ties the "/" value's type to the literal object shape, so
  // a mode-ternary union confuses its overload resolution — the runtime
  // behavior (HTMLBundle in dev, absent in release) is correct either way.
  const devIndex =
    mode === "dev"
      ? (await import("../../../../../src/magpie/surface/index.html")).default
      : undefined;
  const routes = (devIndex ? { "/": devIndex } : {}) as Record<string, never>;

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes,
      development: { hmr: mode === "dev" },
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
            .then((body) => {
              touch();
              // #84 — propagate the handler's verdict rather than a literal
              // {ok:true}. `applied` is bounty's existing field; nothing new.
              const verdict = handleAgentMsg(body as Record<string, unknown>);
              // A command that answered with its own result carries its status
              // and payload; the boolean path below is unchanged.
              if (typeof verdict === "object") {
                if (!verdict.ok)
                  return Response.json(
                    { ok: false, applied: false, error: verdict.error },
                    { status: verdict.status },
                  );
                return Response.json({ ok: true, applied: true, ...verdict.detail });
              }
              const applied = verdict;
              if (!applied) {
                return Response.json(
                  {
                    ok: false,
                    applied: false,
                    error: `unrecognised command type ${JSON.stringify(
                      (body as { type?: unknown })?.type,
                    )} — nothing was applied`,
                  },
                  { status: 400 },
                );
              }
              return new Response('{"ok":true,"applied":true}', {
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
          // Serve per-session files (the source board, materialized cutouts).
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          if (assetName.includes("..") || assetName.startsWith("/") || !sessionFilesDir) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          const f = Bun.file(join(sessionFilesDir, assetName));
          return f.exists().then((exists) =>
            exists
              ? new Response(f, { headers: { "Content-Type": guessMime(assetName) } })
              : new Response('{"error":"not found"}', {
                  status: 404,
                  headers: { "Content-Type": "application/json" },
                }),
          );
        }
        // release: "/" and the hashed chunk-*.js/css are static dist reads. Dev
        // never reaches here for "/" — the routes table above answers it first.
        // This sits AFTER /assets/, which serves session files, not dist ones.
        if (mode === "release") {
          const asset = serveDist(path);
          if (asset) return asset;
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
          ws.send(JSON.stringify({ type: "presence", agent: sseClients.size > 0 }));
        },
        message(_ws, raw) {
          touch();
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
          } catch (e) {
            process.stderr.write(
              `magpie: bad json from browser: ${e instanceof Error ? e.message : String(e)}\n`,
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
  if (!sessionId) sessionId = `magpie-${randHex(4)}-p${boundPort}`;
  state.sessionId = sessionId; // runtime: surface (Export reopen hint) reads it
  sessionFilesDir = join(tmpdir(), `${sessionId}-files`);
  try {
    mkdirSync(sessionFilesDir, { recursive: true });
  } catch {
    /* fall back to no-file-paths */
  }
  if (restored) saveSnapshot(sessionId, state);

  const url = `http://${host}:${boundPort}`;
  // `mode` is the ONLY thing that discriminates a release daemon from a dev
  // one: with root deps present a dev daemon renders an identical-looking
  // surface, so "it looks right" cannot verify Contract 1.
  emitEvent({ type: "ready", url, port: boundPort, session_id: sessionId, mode });

  // Discovery files — cli.ts reads the port from here.
  const sessionFile = join(tmpdir(), `magpie-${sessionId}.json`);
  const latestFile = join(tmpdir(), `magpie-latest.json`);
  const sessionInfo = JSON.stringify({
    url,
    port: boundPort,
    session_id: sessionId,
    title: state.title,
    files_dir: sessionFilesDir,
    // magpie writes NO stdout handshake (mind-mapper and astrolabe do) — its
    // handshake is this discovery file, so `mode` rides BOTH it and the SSE
    // `ready` event: same role, different transport, as imago does it.
    mode,
  });
  try {
    writeFileSync(sessionFile, sessionInfo);
    writeFileSync(latestFile, sessionInfo);
  } catch (e) {
    process.stderr.write(
      `magpie: could not write discovery file: ${e instanceof Error ? e.message : String(e)}\n`,
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

  // Debounced persistence: snapshot ~1s after any change so a restart resumes.
  const snapTimer = setInterval(() => {
    if (snapDirty) {
      snapDirty = false;
      saveSnapshot(sessionId, state);
    }
  }, 1000);

  const { code, reason } = await done;
  clearInterval(idleTimer);
  clearInterval(snapTimer);
  saveSnapshot(sessionId, state); // final write — the resume point
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
  // Race the graceful stop against a timer — never hang teardown on a slow socket.
  await Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]);
  await cleanupDiscovery();
  return code;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}

export type { MagpieState } from "../shared/types";
export { defaultState } from "../shared/types";
export { leanState } from "./reduce";
export { main, parsePortFromSessionId, snapshotsDir };
