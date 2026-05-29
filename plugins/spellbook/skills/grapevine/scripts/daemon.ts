#!/usr/bin/env bun
// grapevine daemon — multi-tenant broker hosting N named channels on
// 127.0.0.1. One daemon per machine; CLI verbs (open/list/tail/send/close)
// talk to it over HTTP. Channels persist as append-only JSONL under
// ~/.grapevine/channels/<name>.jsonl. Live fan-out uses SSE.
//
// Started on demand by any CLI verb that finds no running daemon. Writes
// its port + pid to ~/.grapevine/daemon.{port,pid} for discovery. Stays up
// until `grapevine stop` (DELETE /) or the user kills it.
//
// HTTP surface (all 127.0.0.1):
//   GET    /             — daemon info ({pid, started_at, channels: N})
//   DELETE /             — shut down the daemon
//   GET    /watch        — HTML control plane (chat-bubble live view; channel from URL hash)
//   GET    /channels     — list channels
//   GET    /presence     — cross-channel roster: [{ name, subscribers:[alias], connections, named, anonymous }]
//   POST   /channels     — { name, topic? } create channel (idempotent)
//   DELETE /channels/:name — close channel
//   POST   /channels/:name/messages — { from, text } append + broadcast
//   GET    /channels/:name/messages — backlog (?since=<id>)
//   GET    /channels/:name/subscribers — { channel, subscribers:[alias], count, connections, named, anonymous, topic }
//   GET    /channels/:name/topic    — { channel, topic }
//   PUT    /channels/:name/topic    — { topic, from? } update topic (appends a kind:"topic" message)
//   GET    /channels/:name/tail     — SSE: live messages (?since=<id> for catch-up, ?as=<alias> registers)
//                                    subscribed event includes the current topic.
//
// Message shape: { id, channel, from, text, ts, kind: "message" }
// IDs are channel-scoped, monotonically ascending integers. `ts` is unix
// millis at append time.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WATCH_HTML_PATH = join(SCRIPT_DIR, "watch.html");

// Read our plugin version from the same plugin.json the CLI reads. Daemon
// advertises this on GET / so CLI clients can detect cache-pinning mismatches
// (e.g. a V1.5 daemon serving a V1.6 CLI, where daemon-side features like
// `recipients` are silently absent). Best-effort — version is null if read fails.
function readPluginVersion(): string | null {
  try {
    const pluginJsonPath = join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf-8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}
const PLUGIN_VERSION = readPluginVersion();

const DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
const CHANNELS_DIR = join(DATA_DIR, "channels");
const PORT_FILE = join(DATA_DIR, "daemon.port");
const PID_FILE = join(DATA_DIR, "daemon.pid");

type Message = {
  id: number;
  channel: string;
  from: string;
  text: string;
  ts: number;
  kind: "message" | "topic";
};

type Subscriber = {
  alias: string | null;
  send: (m: Message) => void;
};

type PendingWait = {
  since: number;
  resolve: (msgs: Message[]) => void;
};

type Channel = {
  name: string;
  created_at: number;
  next_id: number;
  subscribers: Map<symbol, Subscriber>;
  waits: Set<PendingWait>;
  last_activity: number;
  topic: string | null; // latest kind:"topic" message text; null if never set.
};

const channels = new Map<string, Channel>();

function ensureDirs() {
  mkdirSync(CHANNELS_DIR, { recursive: true });
}

function channelPath(name: string): string {
  // Defensive: allow [a-zA-Z0-9_.-] in the middle, alphanumeric/underscore/
  // hyphen at the ends. Reject leading/trailing dots (hidden files,
  // trailing-dot oddities) and consecutive dots (path traversal — `..`,
  // `foo..bar`). Internal dots are allowed so version-numbered channel
  // names like `grapevine-v1.7` work naturally.
  const VALID = /^[a-zA-Z0-9_-]([a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_-])?$/;
  if (!VALID.test(name) || name.includes("..")) {
    throw new Error(`invalid channel name: ${JSON.stringify(name)}`);
  }
  return join(CHANNELS_DIR, `${name}.jsonl`);
}

function loadChannel(name: string): Channel {
  const existing = channels.get(name);
  if (existing) return existing;
  const path = channelPath(name);
  let next_id = 1;
  let created_at = Date.now();
  let topic: string | null = null;
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length) {
      try {
        const first = JSON.parse(lines[0]) as Message;
        created_at = first.ts;
      } catch {}
      try {
        const last = JSON.parse(lines[lines.length - 1]) as Message;
        next_id = last.id + 1;
      } catch {}
      // Recover the latest topic by scanning backwards. Cheap because we
      // only do it once per channel-load (cold start).
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const m = JSON.parse(lines[i]) as Message;
          if (m.kind === "topic") {
            topic = m.text;
            break;
          }
        } catch {}
      }
    }
  }
  const ch: Channel = {
    name,
    created_at,
    next_id,
    subscribers: new Map(),
    waits: new Set(),
    last_activity: Date.now(),
    topic,
  };
  channels.set(name, ch);
  return ch;
}

function listChannels() {
  // Include channels on disk that we haven't loaded yet.
  const onDisk = readdirSync(CHANNELS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
  const merged = new Set([...channels.keys(), ...onDisk]);
  return Array.from(merged)
    .sort()
    .map((name) => {
      const ch = channels.get(name);
      let last_activity = 0;
      let message_count = 0;
      if (ch) {
        last_activity = ch.last_activity;
        message_count = ch.next_id - 1;
      } else {
        // Stat disk file for an approximation.
        try {
          const s = statSync(channelPath(name));
          last_activity = s.mtimeMs;
        } catch {}
      }
      return {
        name,
        subscribers: ch?.subscribers.size ?? 0,
        message_count,
        last_activity,
        loaded: !!ch,
      };
    });
}

function appendMessage(
  name: string,
  from: string,
  text: string,
  kind: "message" | "topic" = "message",
): Message {
  const ch = loadChannel(name);
  const msg: Message = {
    id: ch.next_id++,
    channel: name,
    from,
    text,
    ts: Date.now(),
    kind,
  };
  appendFileSync(channelPath(name), `${JSON.stringify(msg)}\n`);
  if (kind === "topic") ch.topic = text;
  ch.last_activity = msg.ts;
  // Fan out to live subscribers. Errors in one subscriber must not break
  // delivery to others.
  for (const sub of ch.subscribers.values()) {
    try {
      sub.send(msg);
    } catch (e) {
      console.error("subscriber error:", e);
    }
  }
  // Drain long-poll waiters: anyone whose `since` < msg.id is now resolvable.
  // They receive every message they haven't seen yet, not just the new one,
  // in case multiple messages landed during the same tick.
  for (const w of [...ch.waits]) {
    if (msg.id > w.since) {
      ch.waits.delete(w);
      try {
        w.resolve(readBacklog(name, w.since));
      } catch (e) {
        console.error("wait resolve error:", e);
      }
    }
  }
  return msg;
}

function subscriberAliases(name: string): string[] {
  const ch = channels.get(name);
  if (!ch) return [];
  const out: string[] = [];
  for (const sub of ch.subscribers.values()) {
    if (sub.alias) out.push(sub.alias);
  }
  return out.sort();
}

function readBacklog(name: string, since: number): Message[] {
  const path = channelPath(name);
  if (!existsSync(path)) return [];
  const out: Message[] = [];
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as Message;
      if (m.id > since) out.push(m);
    } catch {}
  }
  return out;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

// Request bodies are untrusted external JSON. We return a loose record (or
// null on parse failure) and narrow each field at the use site.
type JsonBody = Record<string, unknown> | null;

async function readJsonBody(req: Request): Promise<JsonBody> {
  try {
    return (await req.json()) as JsonBody;
  } catch {
    return null;
  }
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (path === "/" && method === "GET") {
    return json({
      ok: true,
      pid: process.pid,
      started_at: STARTED_AT,
      channels: channels.size,
      data_dir: DATA_DIR,
      version: PLUGIN_VERSION,
    });
  }

  if (path === "/" && method === "DELETE") {
    // Reply, then schedule shutdown so the response actually flushes.
    setTimeout(() => shutdown(0), 10);
    return json({ ok: true, shutting_down: true });
  }

  if (path === "/watch" && method === "GET") {
    try {
      const html = readFileSync(WATCH_HTML_PATH, "utf-8");
      return new Response(html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (e) {
      return json(
        { error: "watch.html missing", details: e instanceof Error ? e.message : String(e) },
        { status: 500 },
      );
    }
  }

  if (path === "/channels" && method === "GET") {
    return json({ channels: listChannels() });
  }

  // Cross-channel presence aggregation — one shot of names × channel for the
  // `who --all` view and `doctor`'s cross-check. Only channels with at least
  // one live connection appear (presence only exists for loaded channels).
  if (path === "/presence" && method === "GET") {
    const out = [];
    for (const ch of channels.values()) {
      const subs = Array.from(ch.subscribers.values());
      if (subs.length === 0) continue;
      out.push({
        name: ch.name,
        subscribers: subscriberAliases(ch.name),
        connections: subs.length,
        named: subs.filter((s) => s.alias).length,
        anonymous: subs.filter((s) => !s.alias).length,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return json({ channels: out });
  }

  if (path === "/channels" && method === "POST") {
    const body = await readJsonBody(req);
    if (!body || typeof body.name !== "string") {
      return json({ error: "name required" }, { status: 400 });
    }
    try {
      const ch = loadChannel(body.name);
      // Optional topic on open — only set if provided AND channel has no
      // topic yet (so re-opening doesn't clobber). To update later, use
      // the explicit PUT /topic endpoint.
      if (typeof body.topic === "string" && body.topic.trim() !== "" && ch.topic === null) {
        appendMessage(
          body.name,
          typeof body.from === "string" ? body.from : "system",
          body.topic,
          "topic",
        );
      }
      return json({
        name: ch.name,
        created_at: ch.created_at,
        message_count: ch.next_id - 1,
        subscribers: ch.subscribers.size,
        topic: ch.topic,
      });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
  }

  // Route-level channel name pattern. Mirrors channelPath()'s rules:
  // alnum/underscore/hyphen at the ends, optional dot in the middle.
  // channelPath() does the canonical validation (incl. no-`..`) on
  // anything that gets through here.
  const chMatch = path.match(
    /^\/channels\/([a-zA-Z0-9_-](?:[a-zA-Z0-9_.-]{0,62}[a-zA-Z0-9_-])?)(\/.*)?$/,
  );
  if (chMatch) {
    const name = chMatch[1];
    const sub = chMatch[2] ?? "";

    if (sub === "" && method === "DELETE") {
      const ch = channels.get(name);
      if (ch) {
        for (const s of ch.subscribers.values()) {
          try {
            s.send({
              id: -1,
              channel: name,
              from: "system",
              text: "channel closed",
              ts: Date.now(),
              kind: "message",
            });
          } catch {}
        }
        ch.subscribers.clear();
        channels.delete(name);
      }
      // Delete persisted log too.
      const p = channelPath(name);
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {}
      }
      return json({ ok: true });
    }

    if (sub === "/messages" && method === "GET") {
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      return json({ messages: readBacklog(name, since) });
    }

    if (sub === "/messages" && method === "POST") {
      const body = await readJsonBody(req);
      if (!body || typeof body.text !== "string" || typeof body.from !== "string") {
        return json({ error: "from and text required" }, { status: 400 });
      }
      try {
        const m = appendMessage(name, body.from, body.text);
        const ch = channels.get(name);
        const aliases = subscriberAliases(name);
        // recipients = subscribers excluding the sender. Subscribers with a
        // null alias (anonymous watch tabs) always count as recipients.
        const recipients = Array.from(ch?.subscribers.values() ?? []).reduce(
          (n, sub) => (sub.alias !== body.from ? n + 1 : n),
          0,
        );
        return json(
          {
            ...m,
            subscribers: ch?.subscribers.size ?? 0,
            recipients,
            subscriber_aliases: aliases,
          },
          { status: 201 },
        );
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }

    if (sub === "/wait" && method === "GET") {
      const ch = loadChannel(name);
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      const alias = url.searchParams.get("as");
      const timeoutS = Math.min(
        Math.max(parseFloat(url.searchParams.get("timeout") ?? "30") || 30, 0.1),
        300,
      );
      // Register a no-op presence subscriber for the wait duration so the
      // alias appears on `who`. `wait` is long-poll — semantically a tail
      // with a deadline — so it deserves presence. `pull` is fire-and-forget
      // and intentionally does not register.
      let presenceKey: symbol | null = null;
      if (alias) {
        presenceKey = Symbol(`wait:${alias}`);
        ch.subscribers.set(presenceKey, {
          alias,
          send: () => {}, // no-op; wait fulfillment is via the waits set, not SSE
        });
      }
      const cleanupPresence = () => {
        if (presenceKey) ch.subscribers.delete(presenceKey);
      };
      // Immediate-return path: if there are messages newer than `since`, hand
      // them back right away. Mirrors the codex `wait` UX — long-poll only
      // when you're truly current.
      const immediate = readBacklog(name, since);
      const cursorOf = (msgs: Message[]) =>
        msgs.length ? msgs[msgs.length - 1].id : Math.max(since, ch.next_id - 1);
      if (immediate.length) {
        cleanupPresence();
        return json({
          messages: immediate,
          cursor: cursorOf(immediate),
          timed_out: false,
        });
      }
      // Else hold for up to `timeoutS` seconds; resolves when appendMessage
      // sees something new for this `since`.
      const result = await new Promise<{
        messages: Message[];
        timed_out: boolean;
      }>((resolve) => {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const waiter: PendingWait = {
          since,
          resolve: (msgs) => {
            if (timeoutHandle !== null) clearTimeout(timeoutHandle);
            resolve({ messages: msgs, timed_out: false });
          },
        };
        ch.waits.add(waiter);
        // Defense-in-depth recheck. JS event-loop semantics make the
        // register-after-broadcast race nearly impossible in practice, but
        // some runtimes (notably Bun pre-1.3.10) have shown long-poll hangs
        // where the awaited Promise neither resolves via drain nor via
        // setTimeout. Re-reading the backlog after registering closes the
        // theoretical race AND gives us a fallback if append sees no
        // waiters during its drain pass for whatever reason.
        const missed = readBacklog(name, since);
        if (missed.length > 0) {
          ch.waits.delete(waiter);
          resolve({ messages: missed, timed_out: false });
          return;
        }
        timeoutHandle = setTimeout(() => {
          ch.waits.delete(waiter);
          resolve({ messages: [], timed_out: true });
        }, timeoutS * 1000);
      });
      cleanupPresence();
      return json({
        messages: result.messages,
        cursor: cursorOf(result.messages),
        timed_out: result.timed_out,
      });
    }

    if (sub === "/subscribers" && method === "GET") {
      const ch = channels.get(name);
      const subs = ch ? Array.from(ch.subscribers.values()) : [];
      // Honest presence accounting: `connections` is the raw socket count,
      // `named` is connections carrying an alias, `anonymous` is null-alias
      // connections (e.g. watch tabs). named + anonymous === connections, so a
      // `count` that exceeds the visible name list is always explainable rather
      // than reading as a ghost. `count` stays === connections for back-compat.
      const named = subs.filter((s) => s.alias).length;
      const anonymous = subs.filter((s) => !s.alias).length;
      return json({
        channel: name,
        subscribers: subscriberAliases(name),
        count: subs.length,
        connections: subs.length,
        named,
        anonymous,
        topic: ch?.topic ?? null,
      });
    }

    if (sub === "/topic" && method === "GET") {
      const ch = loadChannel(name);
      return json({ channel: name, topic: ch.topic });
    }

    if (sub === "/topic" && method === "PUT") {
      const body = await readJsonBody(req);
      if (!body || typeof body.topic !== "string") {
        return json({ error: "topic required" }, { status: 400 });
      }
      try {
        const m = appendMessage(
          name,
          typeof body.from === "string" ? body.from : "system",
          body.topic,
          "topic",
        );
        return json({ ok: true, channel: name, topic: body.topic, id: m.id });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }

    if (sub === "/tail" && method === "GET") {
      const ch = loadChannel(name);
      const since = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
      const alias = url.searchParams.get("as");
      const backlog = since >= 0 ? readBacklog(name, since) : [];

      // We stash the per-stream cleanup fn on the controller so cancel() can
      // reach it via `this`. ReadableStream's typings don't model arbitrary
      // properties, so we use a small augmenting interface.
      type CleanupController = ReadableStreamDefaultController<Uint8Array> & {
        __cleanup?: () => void;
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller: CleanupController) {
          const enc = new TextEncoder();
          const send = (m: Message) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(m)}\n\n`));
            } catch {
              // Controller closed; drop.
            }
          };
          // Initial event: subscribed marker so client knows the stream is
          // hot. Includes the current topic so a freshly-joined agent has
          // grounding context before any messages arrive.
          controller.enqueue(
            enc.encode(
              `event: subscribed\ndata: ${JSON.stringify({ channel: name, since, as: alias, topic: ch.topic, latest_id: ch.next_id - 1 })}\n\n`,
            ),
          );
          // Replay backlog before live tail begins.
          for (const m of backlog) send(m);

          const key = Symbol(`sub:${alias ?? "anon"}`);
          ch.subscribers.set(key, { alias: alias ?? null, send });

          let cleanedUp = false;
          const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            clearInterval(hb);
            ch.subscribers.delete(key);
          };

          // Heartbeat every 3s — both a keep-alive signal and a liveness
          // probe. If the write fails, the client has dropped, so we
          // unregister the subscriber so `who` doesn't show ghosts.
          // SSE comments (`:`) are ignored by the spec parser.
          const hb = setInterval(() => {
            try {
              controller.enqueue(enc.encode(`: hb ${Date.now()}\n\n`));
            } catch {
              cleanup();
            }
          }, 3000);

          // Hold a reference so cancel() can clean up.
          controller.__cleanup = cleanup;
        },
        cancel(this: { __cleanup?: () => void }) {
          this.__cleanup?.();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
  }

  return json({ error: "not found", path }, { status: 404 });
}

let server: ReturnType<typeof Bun.serve> | null = null;
let STARTED_AT = Date.now();

function shutdown(code: number) {
  try {
    if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE);
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
  if (server) {
    Promise.race([server.stop(true), new Promise((r) => setTimeout(r, 200))]).finally(() =>
      process.exit(code),
    );
  } else {
    process.exit(code);
  }
}

async function main() {
  ensureDirs();

  // Check if a daemon is already running by reading the port file and
  // trying to ping it. If alive, exit 0 quietly — caller will discover.
  if (existsSync(PORT_FILE) && existsSync(PID_FILE)) {
    try {
      const port = parseInt(readFileSync(PORT_FILE, "utf-8").trim(), 10);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) {
        console.error(`daemon already running on port ${port}`);
        process.exit(0);
      }
    } catch {
      // Stale; clean up.
      try {
        unlinkSync(PORT_FILE);
      } catch {}
      try {
        unlinkSync(PID_FILE);
      } catch {}
    }
  }

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0, // OS-assigned
    // SSE streams are long-lived and silent client→server. Default 10s
    // idleTimeout closes them prematurely; set to 255 (Bun's max — 0 isn't
    // honored on all paths). Our own 15s heartbeat keeps clients aware.
    idleTimeout: 255,
    fetch: handle,
  });

  Bun.write(PORT_FILE, String(server.port));
  Bun.write(PID_FILE, String(process.pid));
  STARTED_AT = Date.now();
  console.error(
    `grapevine daemon listening on http://127.0.0.1:${server.port} (pid ${process.pid})`,
  );
  console.error(`data dir: ${DATA_DIR}`);

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

if (import.meta.main) {
  await main();
}
