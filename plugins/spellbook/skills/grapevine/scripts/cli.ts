#!/usr/bin/env bun

// grapevine CLI — thin wrapper around the daemon's HTTP surface.
//
// Usage:
//   bun cli.ts open <name>
//   bun cli.ts list
//   bun cli.ts send <name> --from <alias> <text...>
//   bun cli.ts tail <name> [--since <id>] [--from-start]
//   bun cli.ts read <name> <id> [--text]
//   bun cli.ts close <name>
//   bun cli.ts stop
//   bun cli.ts info
//
// `tail` writes each incoming message as one JSONL line on stdout. Pipe
// or wrap with Monitor.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
const PORT_FILE = join(DATA_DIR, "daemon.port");
const PID_FILE = join(DATA_DIR, "daemon.pid");
// Persisted identity config (V1.7) — `grapevine alias <name>` writes it; the
// daemon serves it to the watch via GET /identity.
const CONFIG_FILE = join(DATA_DIR, "config.json");
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts");

// ── Daemon HTTP protocol ──────────────────────────────────────────────────
// Response shapes the daemon emits. Any endpoint can also return an error
// body with a 4xx/5xx status, so each carries an optional `error`.

type Message = {
  id: number;
  channel: string;
  from: string;
  text: string;
  ts: number;
  kind: "message" | "topic";
};

// GET / — daemon liveness/info.
type RootInfo = {
  ok?: boolean;
  pid?: number;
  started_at?: number;
  channels?: number;
  data_dir?: string;
  version?: string | null;
  error?: string;
};

// POST /channels/<name>/messages — message receipt with delivery accounting.
type SendReceipt = Message & {
  subscribers?: number;
  recipients?: number;
  subscriber_aliases?: string[];
  error?: string;
};

// POST /announce — cross-channel broadcast receipt.
type AnnounceReceipt = {
  ok: boolean;
  channels: { name: string; recipients: number }[];
  skipped: { name: string; reason: string }[];
  total_recipients: number;
  error?: string;
};

// GET /channels — channel directory listing.
type ChannelSummary = {
  name: string;
  subscribers: number;
  message_count: number;
  last_activity: number;
  loaded: boolean;
};
type ChannelsResponse = { channels?: ChannelSummary[]; error?: string };

// Any endpoint may reply with just an error/ok envelope.
type StatusResponse = { ok?: boolean; error?: string };

// GET /channels/<name>/messages and ?since= ranges.
type MessagesResponse = { messages?: Message[]; error?: string };

// GET /channels/<name>/wait — long-poll batch.
type WaitResponse = {
  messages?: Message[];
  cursor?: number;
  timed_out?: boolean;
  error?: string;
};

// POST /channels — open/ensure a channel.
type OpenResponse = {
  name?: string;
  created_at?: number;
  message_count?: number;
  subscribers?: number;
  topic?: string | null;
  error?: string;
};

// GET /channels/<name>/topic and PUT /channels/<name>/topic.
type TopicResponse = {
  ok?: boolean;
  channel?: string;
  topic?: string | null;
  id?: number;
  error?: string;
};

// GET /channels/<name>/subscribers — single-channel roster.
type SubscribersResponse = {
  channel?: string;
  subscribers?: string[];
  humans?: string[];
  count?: number;
  connections?: number;
  named?: number;
  anonymous?: number;
  topic?: string | null;
  error?: string;
};

// Per-channel presence entry from GET /presence.
type PresenceChannel = {
  name: string;
  subscribers: string[];
  humans?: string[];
  connections: number;
  named: number;
  anonymous: number;
};
type PresenceResponse = { channels?: PresenceChannel[]; error?: string };

// SSE frames pushed on GET /channels/<name>/tail. Two frame kinds arrive on
// the same `data:` line — a `subscribed` event and per-message frames — so the
// decoded payload is a union. All fields optional because the frame is
// untrusted wire data narrowed at the use site.
type TailPayload = {
  // subscribed-event fields
  since?: number;
  as?: string | null;
  latest_id?: number;
  // message fields
  id?: number;
  from?: string;
  text?: string;
  ts?: number;
  kind?: "message" | "topic";
  // shared
  channel?: string;
  topic?: string | null;
};

// Our plugin version (from plugin.json). Used to detect cache-pinning
// mismatches when we talk to a daemon spawned from a different cached
// path. Best-effort; null if read fails.
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

// One-shot version-mismatch check. The daemon may be from a different
// cached plugin path than this CLI (existing tail processes' auto-reconnect
// can race a `stop` and respawn the old daemon). Warn once per invocation
// so the user has a signal instead of silently degraded behavior.
let _versionCheckDone = false;
async function maybeWarnOnVersionMismatch(port: number) {
  if (_versionCheckDone) return;
  _versionCheckDone = true;
  if (!PLUGIN_VERSION) return; // can't compare if we don't know our own version
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return;
    const data = (await res.json()) as RootInfo;
    const daemonVersion = data?.version ?? null;
    if (daemonVersion === null) {
      process.stderr.write(
        `# grapevine: daemon is older than this CLI (no version reported). ` +
          `CLI is v${PLUGIN_VERSION}. Some features may silently degrade. ` +
          `Restart the daemon (drop tails, then \`stop\`, then any verb) to upgrade.\n`,
      );
    } else if (daemonVersion !== PLUGIN_VERSION) {
      process.stderr.write(
        `# grapevine: daemon version (v${daemonVersion}) differs from CLI version (v${PLUGIN_VERSION}). ` +
          `Some features may silently degrade. Restart the daemon to align.\n`,
      );
    }
  } catch {
    // best-effort
  }
}
// GRAPEVINE_FROM sets the default --from / --as alias so agents don't have
// to repeat their identity on every verb. Per-verb flags still override.
const DEFAULT_ALIAS = process.env.GRAPEVINE_FROM ?? undefined;

// Identity flags are interchangeable across verbs. `send` historically took
// `--from` while `tail`/`wait` took `--as` — same concept (who am I), and the
// asymmetry trips you mid-flow. Accept either everywhere identity is meant,
// falling back to GRAPEVINE_FROM. (grep's `--from` is a different thing — an
// author *filter*, not identity — so it doesn't use this.)
function resolveAlias(flags: Record<string, string | boolean>): string | undefined {
  return (flags.from as string | undefined) ?? (flags.as as string | undefined) ?? DEFAULT_ALIAS;
}
// Truncation-hint threshold. Messages longer than this get a `truncation_hint`
// field on the tail JSON so consumers (e.g. Monitor) know the notification
// preview is incomplete and should `read` the full body. In agent-to-agent
// traffic, long messages are the NORM (the V1.6 roundtable saw most substantive
// messages exceed 800), so an 800 default fired on nearly everything and the
// recovery path became the main path. Default raised to 2000 so the hint marks
// the genuinely-long outliers. Overridable via env var for tuning.
const TRUNCATION_HINT_THRESHOLD = parseInt(
  process.env.GRAPEVINE_TRUNCATION_HINT_THRESHOLD ?? "2000",
  10,
);

// Optional inline-body cap for `tail` (opt-in via --max <n> or GRAPEVINE_TAIL_MAX).
// When set, a body longer than the cap is truncated to `n` chars in the tail
// frame (plus the read-pointer hint), so a push consumer can hand its
// notification surface a deliberately-sized line. The FULL message is always
// retrievable via `read <channel> <id>`. Undefined = no cap (full text inline —
// today's default). Note: the hard clip a consumer ultimately sees is still the
// Monitor/notification layer's; --max only bounds the line grapevine emits.
// Rejects negative / non-numeric.
function resolveTailMax(flag: unknown): number | undefined {
  const raw = typeof flag === "string" ? flag : process.env.GRAPEVINE_TAIL_MAX;
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function die(msg: string, code = 2): never {
  process.stderr.write(`grapevine: ${msg}\n`);
  process.exit(code);
}

async function readDaemonPort(): Promise<number | null> {
  if (!existsSync(PORT_FILE)) return null;
  const raw = readFileSync(PORT_FILE, "utf-8").trim();
  const port = parseInt(raw, 10);
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      // Fire-and-forget mismatch check (won't block the verb).
      maybeWarnOnVersionMismatch(port);
      return port;
    }
  } catch {}
  // Stale — clean up.
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  return null;
}

async function ensureDaemon(): Promise<number> {
  let port = await readDaemonPort();
  if (port) return port;
  // Spawn detached so the daemon survives this CLI process exit.
  const proc = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  proc.unref();
  // Wait up to 3s for the port file to appear and respond.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    port = await readDaemonPort();
    if (port) return port;
  }
  die("daemon failed to start within 3s");
}

// Generic over the expected success body. `data` may be null if the response
// had no JSON body, so callers see `T | null`.
async function api<T = unknown>(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {}
  return { status: res.status, data };
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

async function cmdOpen(name: string, opts: { topic?: string; from?: string }) {
  if (!name) die("usage: grapevine open <name> [--topic <text>]");
  const port = await ensureDaemon();
  const body: Record<string, string> = { name };
  if (opts.topic !== undefined) body.topic = opts.topic;
  if (opts.from !== undefined) body.from = opts.from;
  const { status, data } = await api<OpenResponse>(port, "POST", "/channels", body);
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, channel: data });
}

async function cmdTopic(name: string, text: string | undefined, from: string | undefined) {
  if (!name) die("usage: grapevine topic <channel> [<text>]");
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name });
  if (text === undefined) {
    // Read current topic.
    const { status, data } = await api<TopicResponse>(port, "GET", `/channels/${name}/topic`);
    if (status >= 400) die(data?.error ?? `HTTP ${status}`);
    printJson({ ok: true, channel: name, topic: data?.topic });
    return;
  }
  const { status, data } = await api<TopicResponse>(port, "PUT", `/channels/${name}/topic`, {
    topic: text,
    from: from ?? "system",
  });
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, channel: name, topic: data?.topic, id: data?.id });
}

async function cmdList() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { data } = await api<ChannelsResponse>(port, "GET", "/channels");
  printJson({ ok: true, daemon: true, ...data });
}

async function cmdSend(
  name: string,
  from: string,
  text: string,
  opts: { quiet?: boolean; verbose?: boolean; inReplyTo?: number },
) {
  if (!name || !from || !text) die("usage: grapevine send <name> --from <alias> <text...>");
  const port = await ensureDaemon();
  const body: { from: string; text: string; in_reply_to?: number } = {
    from,
    text,
  };
  if (opts.inReplyTo !== undefined) body.in_reply_to = opts.inReplyTo;
  const { status, data } = await api<SendReceipt>(port, "POST", `/channels/${name}/messages`, body);
  if (status >= 400 || !data) die(data?.error ?? `HTTP ${status}`);
  // Target echo on stderr — confirms WHERE the message landed so a misrouted
  // reply (right prompt, wrong channel) is caught the instant it happens (F9).
  // On stderr so it never pollutes the stdout JSON receipt, and it fires even
  // under --quiet (the safety signal shouldn't be silenced).
  const recip =
    data.recipients !== undefined
      ? `${data.recipients} recipient(s)`
      : `${data.subscribers ?? 0} subscriber(s)`;
  process.stderr.write(`# → ${data.channel} · ${recip}\n`);
  if (opts.quiet) return;
  // Terse default: id + subscriber count + void warning. --verbose also
  // includes the subscriber alias list (same data as the `who` verb,
  // piggybacked to avoid an extra round-trip when the sender cares).
  const out: Record<string, unknown> = {
    ok: true,
    id: data.id,
    channel: data.channel,
    subscribers: data.subscribers ?? 0,
  };
  // Only surface recipients if the daemon actually computed it. Defaulting
  // to 0 was indistinguishable from "really 0" and hid silent V1.5-daemon
  // degradation during cross-version sessions; missing-means-missing is the
  // honest signal.
  if (data.recipients !== undefined) out.recipients = data.recipients;
  if (data.subscribers === 0) out.warning = "channel has no subscribers";
  else if (data.recipients === 0) out.warning = "only you are subscribed";
  if (opts.verbose) out.subscriber_aliases = data.subscriber_aliases ?? [];
  printJson(out);
}

async function cmdAnnounce(
  from: string,
  text: string,
  channels: string[] | undefined,
  opts: { quiet?: boolean },
) {
  if (!from || !text) die("usage: grapevine announce --from <alias> <text...>");
  const port = await ensureDaemon();
  const body: { from: string; text: string; channels?: string[] } = { from, text };
  if (channels?.length) body.channels = channels;
  const { status, data } = await api<AnnounceReceipt>(port, "POST", "/announce", body);
  if (status >= 400 || !data) die(data?.error ?? `HTTP ${status}`);
  process.stderr.write(
    `# announced → ${data.channels.length} channel(s) · ${data.total_recipients} recipient(s)\n`,
  );
  if (opts.quiet) return;
  const out: Record<string, unknown> = {
    ok: true,
    channels: data.channels,
    total_recipients: data.total_recipients,
  };
  if (data.skipped?.length) out.skipped = data.skipped;
  if (data.channels.length === 0) out.warning = "no active channels to announce to";
  printJson(out);
}

async function cmdPull(name: string, since: number) {
  if (!name) die("usage: grapevine pull <channel> [--since <id>]");
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name });
  const { status, data } = await api<MessagesResponse>(
    port,
    "GET",
    `/channels/${name}/messages?since=${since}`,
  );
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  const msgs = data?.messages ?? [];
  const cursor = msgs.length ? msgs[msgs.length - 1].id : since;
  printJson({ ok: true, messages: msgs, cursor });
}

async function cmdRead(name: string, id: number, opts: { text?: boolean }) {
  if (!name || !Number.isFinite(id)) die("usage: grapevine read <channel> <id> [--text]");
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name });
  // Built on the existing range fetch — `since=id-1` returns id and beyond;
  // we pick the exact id. No daemon API change. This is the targeted
  // "give me message N in full" verb that recovers a clipped tail preview
  // without the pull-range + jq dance.
  const { status, data } = await api<MessagesResponse>(
    port,
    "GET",
    `/channels/${name}/messages?since=${id - 1}`,
  );
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  const msg = (data?.messages ?? []).find((m) => m.id === id);
  if (!msg) die(`message ${id} not found in ${name}`, 1);
  if (opts.text) {
    // Prose mode: header + body, no JSON envelope, so a human (or an agent
    // recovering a truncated notification) can read it directly.
    const ts = new Date(msg.ts).toISOString();
    process.stdout.write(`[${msg.id}] ${msg.from} · ${ts}\n${msg.text}\n`);
    return;
  }
  printJson({ ok: true, message: msg });
}

async function cmdWait(name: string, since: number, timeoutS: number, alias: string | undefined) {
  if (!name) die("usage: grapevine wait <channel> [--as <alias>] [--since <id>] [--timeout <s>]");
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name });
  // Give the HTTP fetch a slightly higher abort timeout than the daemon's
  // long-poll timeout so the daemon always wins the timeout race.
  // `?as=<alias>` registers presence on the channel for the wait duration —
  // wait is long-poll (push-shaped with a deadline) so it deserves presence.
  const asParam = alias ? `&as=${encodeURIComponent(alias)}` : "";
  const url = `http://127.0.0.1:${port}/channels/${name}/wait?since=${since}&timeout=${timeoutS}${asParam}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout((timeoutS + 5) * 1000),
  });
  let data: WaitResponse | null = null;
  try {
    data = (await res.json()) as WaitResponse;
  } catch {}
  if (!res.ok) die(data?.error ?? `HTTP ${res.status}`);
  printJson({
    ok: true,
    messages: data?.messages ?? [],
    cursor: data?.cursor ?? since,
    timed_out: !!data?.timed_out,
  });
}

async function cmdWho(name: string) {
  if (!name) die("usage: grapevine who <channel>");
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channel: name, subscribers: [] });
    return;
  }
  const { status, data } = await api<SubscribersResponse>(
    port,
    "GET",
    `/channels/${name}/subscribers`,
  );
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}

async function cmdWhoAll() {
  // Cross-channel roster — names × channel in one call, so you don't fan out
  // N `who` calls + a manual join to answer "who is on which vine?".
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { status, data } = await api<PresenceResponse>(port, "GET", "/presence");
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}

// Get or set the persisted default alias (V1.7). With no argument, prints the
// current alias; with one, writes it to config.json. Pure file I/O — works
// without a running daemon. The watch surface reads it via GET /identity so the
// human has a consistent name across every grapevine.
async function cmdAlias(name: string | undefined) {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  if (name === undefined) {
    const alias = typeof cfg.alias === "string" && cfg.alias.trim() ? cfg.alias.trim() : null;
    printJson({ ok: true, alias });
    return;
  }
  const trimmed = name.trim();
  cfg.alias = trimmed;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
  printJson({ ok: true, alias: trimmed || null });
}

async function cmdTail(
  name: string,
  opts: {
    since?: number;
    fromStart?: boolean;
    as?: string;
    human?: boolean;
    lurk?: boolean;
    max?: number;
  },
) {
  if (!name)
    die(
      "usage: grapevine tail <name> [--as <alias>] [--since <id>] [--from-start] [--human] [--lurk] [--max <n>]",
    );
  // --lurk receives messages but registers no presence — an invisible observer.
  // It overrides identity flags (a lurker has no name to show).
  const myAlias = opts.lurk ? undefined : opts.as;

  // Clean exit on signals so the SSE stream doesn't leak.
  let stopped = false;
  const cleanup = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  let highestSeen = opts.fromStart ? 0 : (opts.since ?? -1);
  let reconnectDelay = 250;
  // Emit the grounding line only on the first subscribe, never on reconnects
  // (a reconnect resumes from highestSeen — there's no unseen history then).
  let grounded = false;

  while (!stopped) {
    const port = await ensureDaemon();
    // Ensure the channel exists (so a fresh `tail name` works without explicit open).
    await api(port, "POST", "/channels", { name });
    const asParam = myAlias ? `&as=${encodeURIComponent(myAlias)}` : "";
    const humanParam = opts.human && !opts.lurk ? "&human=1" : "";
    const lurkParam = opts.lurk ? "&lurk=1" : "";
    const url = `http://127.0.0.1:${port}/channels/${name}/tail?since=${highestSeen}${asParam}${humanParam}${lurkParam}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      process.stderr.write(
        `# connect failed: ${e instanceof Error ? e.message : String(e)}, retrying…\n`,
      );
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      continue;
    }
    if (!res.ok || !res.body) {
      process.stderr.write(`# tail HTTP ${res.status}, retrying…\n`);
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      continue;
    }
    reconnectDelay = 250; // reset on a successful open

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        process.stderr.write(
          `# stream dropped: ${e instanceof Error ? e.message : String(e)}, reconnecting…\n`,
        );
        break;
      }
      if (chunk.done) {
        process.stderr.write(`# stream closed, reconnecting…\n`);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      // Drain complete SSE frames (separated by a blank line). Re-read the
      // separator index each pass so `continue` statements below don't skip
      // the buffer advance (which a hoisted-once assignment would).
      for (let sep = buffer.indexOf("\n\n"); sep >= 0; sep = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const lines = block.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith(":")) {
            // Daemon liveness heartbeat (`: hb <ts>`). Surface a recognizable
            // sentinel on stderr so a `2>&1` consumer can tell "idle" from
            // "wedged" (F6). Kept off stdout — the JSONL stream stays pure.
            if (line.startsWith(": hb")) process.stderr.write(": grapevine-keepalive\n");
            continue;
          }
          if (line.startsWith("event:")) eventName = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        try {
          const payload = JSON.parse(dataLines.join("\n")) as TailPayload;
          if (eventName === "subscribed") {
            process.stderr.write(`# subscribed to ${payload.channel} (since=${payload.since})\n`);
            if (payload.topic) process.stderr.write(`# topic: ${payload.topic}\n`);
            // Structured grounding on stdout (F3/F7) — under the default
            // Wiring-B Monitor, stdout surfaces as notifications, so a fresh
            // subscriber actually sees the topic + that earlier history exists.
            // Gated: only when there's something to ground (unseen history or a
            // topic), and only on the first subscribe (not reconnects).
            if (!grounded) {
              grounded = true;
              const latest = typeof payload.latest_id === "number" ? payload.latest_id : 0;
              const earlier = highestSeen < 0 ? latest : Math.max(0, Math.min(highestSeen, latest));
              if (earlier > 0 || payload.topic) {
                const grounding: Record<string, unknown> = {
                  kind: "grounding",
                  channel: payload.channel,
                  joined_at: highestSeen < 0 ? latest : Math.min(highestSeen, latest),
                  earlier,
                };
                if (payload.topic) grounding.topic = payload.topic;
                if (earlier > 0)
                  grounding.hint = `${earlier} earlier message(s) exist — use --from-start or --since <id> to backfill`;
                process.stdout.write(`${JSON.stringify(grounding)}\n`);
              }
            }
            continue;
          }
          if (typeof payload.id === "number" && payload.id > highestSeen) {
            highestSeen = payload.id;
          }
          // Suppress self-echo: when --as is set, drop messages we sent
          // ourselves. The sender already got the receipt as the POST
          // response, so re-emitting it on tail is pure noise.
          if (myAlias && payload.from === myAlias) continue;
          // Mark messages whose body exceeds the notification cap so consumers
          // know the preview is incomplete and should `read` the full text.
          // The hint must serialize BEFORE `.text`: a notification clip lands
          // inside the long `.text`, so a hint trailing after it gets eaten
          // (F17). Spreading payload after the hint puts the hint first.
          if (
            typeof payload.text === "string" &&
            payload.text.length > (opts.max ?? TRUNCATION_HINT_THRESHOLD)
          ) {
            const truncation_hint = `+${payload.text.length} chars — full: read ${name} ${payload.id}`;
            // Cap the INLINE body when --max is set (the full message stays on
            // disk → `read`); without --max, emit the full text (today's default).
            const text = opts.max !== undefined ? payload.text.slice(0, opts.max) : payload.text;
            process.stdout.write(`${JSON.stringify({ truncation_hint, ...payload, text })}\n`);
          } else {
            process.stdout.write(`${JSON.stringify(payload)}\n`);
          }
        } catch (e) {
          process.stderr.write(`# bad sse data: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
    // Brief pause before reconnect; resume from highestSeen so no messages
    // are lost across reconnects.
    if (!stopped) await new Promise((r) => setTimeout(r, 200));
  }
}

async function cmdGrep(name: string, pattern: string, opts: { literal?: boolean; from?: string }) {
  if (!name || !pattern)
    die("usage: grapevine grep <channel> <pattern> [--literal|-F] [--from <alias>]");
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath)) {
    printJson({ ok: true, messages: [] });
    return;
  }
  let matcher: (text: string) => boolean;
  if (opts.literal) {
    const needle = pattern.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(needle);
  } else {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      die(`invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }
    matcher = (text) => re.test(text);
  }
  const raw = readFileSync(logPath, "utf-8");
  const messages: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let msg: Partial<Message>;
    try {
      msg = JSON.parse(line) as Partial<Message>;
    } catch {
      continue;
    }
    if (typeof msg.text !== "string") continue;
    if (opts.from && msg.from !== opts.from) continue;
    if (!matcher(msg.text)) continue;
    messages.push(msg);
  }
  printJson({ ok: true, messages });
}

async function cmdClose(name: string) {
  if (!name) die("usage: grapevine close <name>");
  const port = await readDaemonPort();
  if (!port) die("no daemon running");
  const { status, data } = await api<StatusResponse>(port, "DELETE", `/channels/${name}`);
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true });
}

// Archive (read-only) or unarchive a channel (V1.7) — the non-destructive
// alternative to close: history is preserved, sends are rejected, and the name
// is locked from re-open until unarchived.
async function cmdArchive(name: string, unarchive: boolean) {
  const verb = unarchive ? "unarchive" : "archive";
  if (!name) die(`usage: grapevine ${verb} <channel>`);
  const port = await ensureDaemon();
  const { status, data } = await api<StatusResponse>(port, "POST", `/channels/${name}/${verb}`);
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}

async function cmdStop() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false });
    return;
  }
  try {
    await api(port, "DELETE", "/");
  } catch {}
  printJson({ ok: true, stopped: true });
}

// Per-channel live-connection summary — the restart-safety read. Mirrors what
// `doctor` reports under active_subscribers; only populated channels are listed.
async function fetchActiveSubscribers(
  port: number,
): Promise<{ total: number; channels: Array<{ name: string; connections: number }> }> {
  let total = 0;
  const channels: Array<{ name: string; connections: number }> = [];
  try {
    const { data } = await api<PresenceResponse>(port, "GET", "/presence");
    for (const ch of data?.channels ?? []) {
      total += ch.connections;
      if (ch.connections > 0) channels.push({ name: ch.name, connections: ch.connections });
    }
  } catch {
    // best-effort — a presence hiccup shouldn't crash a lifecycle verb
  }
  return { total, channels };
}

async function cmdStart() {
  // Ensure-running, no channel side-effect. Idempotent: report an existing
  // daemon, or spawn a fresh one. The explicit "bring it up" verb — diagnostics
  // (doctor/info/list) stay read-only and never spawn.
  const existing = await readDaemonPort();
  const port = existing ?? (await ensureDaemon());
  printJson({ ok: true, port, already_running: existing !== null });
}

async function cmdRestart(opts: { force?: boolean }) {
  const port = await readDaemonPort();
  if (!port) {
    // Nothing to tear down — just bring a fresh daemon up.
    const fresh = await ensureDaemon();
    printJson({ ok: true, restarted: true, port: fresh, previous_pid: null });
    return;
  }
  // SAFETY: a restart forces every connected client to auto-reconnect. Refuse to
  // tear down a working fleet unless explicitly forced — never silently drop it.
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die(
      `restart: ${total} active subscriber(s) across ${channels.length} channel(s) — ${where}. ` +
        "A restart would force them all to reconnect. Re-run with --force (or --yes) to proceed anyway.",
    );
  }
  // Capture the pid we're replacing, for the receipt.
  let previousPid: number | null = null;
  try {
    const { data } = await api<RootInfo>(port, "GET", "/");
    previousPid = data?.pid ?? null;
  } catch {}
  // Stop, then wait for the old daemon to actually go away — it unlinks its
  // port/pid files on shutdown, so ensureDaemon spawns fresh rather than
  // re-discovering the dying one.
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if ((await readDaemonPort()) === null) break;
  }
  const fresh = await ensureDaemon();
  printJson({ ok: true, restarted: true, port: fresh, previous_pid: previousPid });
}

async function cmdWatch(name: string | undefined) {
  // Channel name is optional — the page reads it from the URL hash and
  // defaults to "lobby" if absent. We pass through whatever the user gave
  // (or "lobby") and open the browser. Daemon is ensured so the served
  // /watch HTML is reachable.
  const channel = name?.trim() ? name.trim() : "lobby";
  const port = await ensureDaemon();
  // Ensure the channel exists so the page sees a valid backlog/topic.
  await api(port, "POST", "/channels", { name: channel });
  const url = `http://127.0.0.1:${port}/watch#${encodeURIComponent(channel)}`;
  // Open the browser via the platform's default opener. Best-effort —
  // print the URL so the user can click it if auto-open fails.
  const opener =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const p = spawn(opener, [url], {
      detached: true,
      stdio: "ignore",
    });
    p.unref();
  } catch {
    /* opener missing — just print */
  }
  printJson({ ok: true, channel, url });
}

async function cmdDoctor() {
  // Read-only diagnostic. Reports the authoritative daemon (if any), other
  // grapevine daemon processes visible on the machine, channel files on
  // disk, and surfaces hints. Does NOT take destructive action — cleanup
  // is the operator's call, with stock unix tools.
  const port = await readDaemonPort();
  let authoritative: Record<string, unknown> | null = null;
  // Per-channel subscriber summary — answers "is it safe to restart the
  // daemon right now?" without needing to also run `list` and read the
  // output. Empty if no daemon is running.
  let totalSubscribers = 0;
  const busyChannels: Array<{
    name: string;
    subscribers: number;
    connections: number;
    named: number;
    anonymous: number;
  }> = [];
  if (port) {
    try {
      const { data } = await api<RootInfo>(port, "GET", "/");
      authoritative = { port, ...data };
    } catch {
      // daemon went away between port check and api call
    }
    try {
      // /presence gives the honest per-channel breakdown (connections vs named
      // vs anonymous) — so the restart-safety total isn't a mystery and an
      // anonymous watch tab reads as a watcher, not a ghost.
      const { data: presData } = await api<PresenceResponse>(port, "GET", "/presence");
      for (const ch of presData?.channels ?? []) {
        totalSubscribers += ch.connections;
        busyChannels.push({
          name: ch.name,
          subscribers: ch.connections, // back-compat: previously the raw count
          connections: ch.connections,
          named: ch.named,
          anonymous: ch.anonymous,
        });
      }
    } catch {
      // best-effort
    }
  }

  // Scan ps for other daemon processes. Filter to those running daemon.ts
  // under a grapevine path. Excludes our authoritative daemon (so the
  // "other_daemons" set is genuinely other).
  const otherDaemons: Array<{ pid: number; command: string }> = [];
  try {
    const proc = spawn("ps", ["-eo", "pid,command"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (b) => chunks.push(b as Buffer));
    await new Promise<void>((resolve) => proc.on("exit", () => resolve()));
    const out = Buffer.concat(chunks).toString("utf-8");
    for (const line of out.split("\n")) {
      if (!line.includes("daemon.ts")) continue;
      if (!line.toLowerCase().includes("grapevine")) continue;
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (!pid) continue;
      if (authoritative && pid === authoritative.pid) continue;
      otherDaemons.push({ pid, command: m[2].trim() });
    }
  } catch {
    // ps unavailable; carry on with empty list
  }

  // Channels on disk under this HOME.
  const channelsOnDisk: string[] = [];
  try {
    const channelsDir = join(DATA_DIR, "channels");
    if (existsSync(channelsDir)) {
      for (const f of readdirSync(channelsDir)) {
        if (f.endsWith(".jsonl")) channelsOnDisk.push(f.replace(/\.jsonl$/, ""));
      }
    }
  } catch {}

  // Hints — surface the most actionable signals.
  const hints: string[] = [];
  if (!authoritative) {
    hints.push(
      "No authoritative daemon running for this HOME. Run any verb (e.g. `cli.ts list`) to spawn one.",
    );
  }
  if (otherDaemons.length > 0) {
    hints.push(
      `Found ${otherDaemons.length} other grapevine daemon process(es) on this machine. ` +
        "They may be zombies from past runs OR daemons serving other HOMEs (different GRAPEVINE_HOME).",
    );
    hints.push(
      "To inspect a specific one: `lsof -p <pid>` (shows its listening port). To clean up: `kill <pid>` (or `kill -9` if needed).",
    );
  }
  if (
    authoritative &&
    PLUGIN_VERSION &&
    typeof authoritative.version === "string" &&
    authoritative.version !== PLUGIN_VERSION
  ) {
    hints.push(
      `Authoritative daemon version (${authoritative.version}) differs from this CLI's version (${PLUGIN_VERSION}). ` +
        "Restart the daemon to align — drop active tails, then `stop`, then any verb.",
    );
  }
  if (authoritative && (authoritative.version === null || authoritative.version === undefined)) {
    hints.push("Authoritative daemon predates version reporting (pre-V1.6.2). Restart to align.");
  }
  if (totalSubscribers > 0) {
    hints.push(
      `${totalSubscribers} active subscriber(s) across ${busyChannels.length} channel(s). ` +
        "Daemon restart would force them to auto-reconnect (works, but disruptive) — coordinate first.",
    );
  } else if (authoritative) {
    hints.push("No active subscribers — daemon restart is non-disruptive.");
  }
  // Explain any channel where the connection count exceeds named agents — an
  // anonymous watch tab inflates `count`/`connections` but isn't a ghost.
  for (const ch of busyChannels) {
    if (ch.anonymous > 0) {
      hints.push(
        `${ch.name}: ${ch.connections} connection(s), ${ch.named} named agent(s) + ` +
          `${ch.anonymous} anonymous (e.g. a watch tab). The count over the name list is expected, not a ghost.`,
      );
    }
  }

  printJson({
    ok: true,
    home: DATA_DIR,
    cli_version: PLUGIN_VERSION,
    authoritative,
    active_subscribers: {
      total: totalSubscribers,
      busy_channels: busyChannels,
    },
    other_daemons_on_machine: otherDaemons,
    channels_on_disk: channelsOnDisk,
    hints,
  });
}

async function cmdInfo() {
  const port = await readDaemonPort();
  if (!port) {
    printJson({ ok: true, daemon: false });
    return;
  }
  const { data } = await api<RootInfo>(port, "GET", "/");
  printJson({ ok: true, daemon: true, ...data });
}

const BOOLEAN_FLAGS = new Set([
  "quiet",
  "from-start",
  "verbose",
  "stdin",
  "literal",
  "text",
  "all",
  "human",
  "lurk",
  "force",
  "yes",
]);

// Signature of a heredoc fumble: a line that is (or begins with) a
// `bun … cli.ts … send` invocation. When a `send --stdin <<EOF` is botched, the
// shell pipes the literal command line in as the body, which then gets posted —
// corrupting the channel with `bun /…/cli.ts send <channel> --as … <text>`.
// We refuse to post such a body unless --force is passed.
const LEAKED_SEND_RE = /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\b(?:send|announce)\b/;
function looksLikeLeakedSend(text: string): boolean {
  return LEAKED_SEND_RE.test(text);
}

function parseFlags(argv: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "open":
      await cmdOpen(positional[0], {
        topic: flags.topic as string | undefined,
        from: resolveAlias(flags),
      });
      return 0;
    case "topic":
      await cmdTopic(
        positional[0],
        positional.length > 1 ? positional.slice(1).join(" ") : undefined,
        resolveAlias(flags),
      );
      return 0;
    case "list":
      await cmdList();
      return 0;
    case "send": {
      const name = positional[0];
      const from = resolveAlias(flags);
      const hasInlineText = positional.length > 1;
      let text: string;
      if (flags["body-file"]) {
        // Read the body from a file — bypasses both shell quoting and any
        // heredoc fumble. Trailing newline stripped, matching --stdin.
        const path = flags["body-file"] as string;
        const file = Bun.file(path);
        if (!(await file.exists())) die(`send: --body-file not found: ${path}`);
        text = (await file.text()).replace(/\n$/, "");
      } else if (flags.stdin || (!hasInlineText && !process.stdin.isTTY)) {
        // Read stdin — explicitly via --stdin, or by DEFAULT when no inline text
        // was given and stdin is piped. The shell never gets to eat a token, so
        // piping is the safe path and now needs no flag. Trailing newline
        // stripped; everything else preserved.
        const buf: Buffer[] = [];
        for await (const chunk of process.stdin) buf.push(chunk as Buffer);
        text = Buffer.concat(buf).toString("utf-8").replace(/\n$/, "");
      } else {
        text = positional.slice(1).join(" ");
      }
      if (!from)
        die("send: identity required — pass --from/--as <alias> or set GRAPEVINE_FROM env var");
      // A fumbled heredoc can pipe the literal send invocation in as the body;
      // refuse to post that rather than corrupt the channel with it (--force
      // overrides for the rare case the text genuinely contains the command).
      if (!flags.force && looksLikeLeakedSend(text)) {
        die(
          "send: that body looks like a leaked grapevine invocation (a fumbled " +
            "heredoc?). Nothing was sent. Pipe the real body via --stdin or " +
            "--body-file <path>, or pass --force to send it anyway.",
        );
      }
      await cmdSend(name, from, text, {
        quiet: !!flags.quiet,
        verbose: !!flags.verbose,
        inReplyTo: flags["in-reply-to"] ? parseInt(flags["in-reply-to"] as string, 10) : undefined,
      });
      return 0;
    }
    case "announce": {
      const from = resolveAlias(flags);
      const hasInlineText = positional.length > 0;
      let text: string;
      if (flags["body-file"]) {
        const path = flags["body-file"] as string;
        const file = Bun.file(path);
        if (!(await file.exists())) die(`announce: --body-file not found: ${path}`);
        text = (await file.text()).replace(/\n$/, "");
      } else if (flags.stdin || (!hasInlineText && !process.stdin.isTTY)) {
        const buf: Buffer[] = [];
        for await (const chunk of process.stdin) buf.push(chunk as Buffer);
        text = Buffer.concat(buf).toString("utf-8").replace(/\n$/, "");
      } else {
        text = positional.join(" ");
      }
      if (!from)
        die("announce: identity required — pass --from/--as <alias> or set GRAPEVINE_FROM env var");
      if (!flags.force && looksLikeLeakedSend(text)) {
        die(
          "announce: that body looks like a leaked grapevine invocation (a fumbled " +
            "heredoc?). Nothing was sent. Pipe the real body via --stdin or " +
            "--body-file <path>, or pass --force to send it anyway.",
        );
      }
      const channels = flags.channels
        ? (flags.channels as string)
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined;
      await cmdAnnounce(from, text, channels, { quiet: !!flags.quiet });
      return 0;
    }
    case "pull": {
      const since = flags.since ? parseInt(flags.since as string, 10) : 0;
      await cmdPull(positional[0], since);
      return 0;
    }
    case "read": {
      const id = positional[1] ? parseInt(positional[1], 10) : NaN;
      await cmdRead(positional[0], id, { text: !!flags.text });
      return 0;
    }
    case "wait": {
      const since = flags.since ? parseInt(flags.since as string, 10) : 0;
      const timeout = flags.timeout ? parseFloat(flags.timeout as string) : 30;
      const alias = resolveAlias(flags);
      await cmdWait(positional[0], since, timeout, alias);
      return 0;
    }
    case "who":
      if (flags.all) await cmdWhoAll();
      else await cmdWho(positional[0]);
      return 0;
    case "alias":
      await cmdAlias(positional[0]);
      return 0;
    case "tail":
      await cmdTail(positional[0], {
        since: flags.since ? parseInt(flags.since as string, 10) : undefined,
        fromStart: !!flags["from-start"],
        as: resolveAlias(flags),
        human: !!flags.human,
        lurk: !!flags.lurk,
        max: resolveTailMax(flags.max),
      });
      return 0;
    case "grep": {
      await cmdGrep(positional[0], positional.slice(1).join(" "), {
        literal: !!flags.literal,
        from: flags.from as string | undefined,
      });
      return 0;
    }
    case "close":
      await cmdClose(positional[0]);
      return 0;
    case "archive":
      await cmdArchive(positional[0], false);
      return 0;
    case "unarchive":
      await cmdArchive(positional[0], true);
      return 0;
    case "start":
    case "up":
      await cmdStart();
      return 0;
    case "restart":
      await cmdRestart({ force: !!flags.force || !!flags.yes });
      return 0;
    case "stop":
      await cmdStop();
      return 0;
    case "watch":
      await cmdWatch(positional[0]);
      return 0;
    case "info":
      await cmdInfo();
      return 0;
    case "doctor":
      await cmdDoctor();
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(`grapevine — agent-to-agent walkie-talkie

Usage:
  grapevine open <name> [--topic <text>]
  grapevine list
  grapevine send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--body-file <path>] [--force] [--in-reply-to <id>] [<text...>]
                                    # body: inline text, --stdin, --body-file, or piped stdin (default when no inline text)
  grapevine tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--human] [--lurk] [--max <n>]
  grapevine pull <name> [--since <id>]
  grapevine read <name> <id> [--text]   # one full message by id (--text = prose)
  grapevine wait <name> [--since <id>] [--timeout <s>]
  grapevine grep <name> <pattern> [--literal] [--from <alias>]
  grapevine topic <name> [<text>]   # no text → read current; with text → update
  grapevine who <name>              # roster; the humans field lists humans
  grapevine alias [<name>]          # set/show your persisted alias (config.json)
  grapevine watch [<name>]          # open browser tab; live chat-bubble view
  grapevine archive <name>          # read-only: keep history, reject sends
  grapevine unarchive <name>        # bring an archived channel back
  grapevine close <name>            # destructive: delete the message log
  grapevine start                   # ensure the daemon is running (alias: up); no channel
  grapevine restart [--force|--yes] # stop + respawn fresh; --force to override the live-fleet guard
  grapevine stop
  grapevine info
  grapevine doctor                  # health check — daemon, zombies, channels

Env:
  GRAPEVINE_FROM   Default identity alias (--from/--as are interchangeable).
  GRAPEVINE_HOME   Data dir (default ~/.grapevine).
`);
      return 0;
    default:
      die(`unknown command: ${cmd}`);
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
