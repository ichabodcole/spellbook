#!/usr/bin/env bun

// grapevine CLI — thin wrapper around the daemon's HTTP surface.
//
// Usage:
//   bun cli.ts open <name>
//   bun cli.ts list
//   bun cli.ts send <name> --from <alias> <text...>
//   bun cli.ts tail <name> [--since <id>] [--from-start] [--last <n>]
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
import { parseArgs as nodeParseArgs } from "node:util";

const DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
const PORT_FILE = join(DATA_DIR, "daemon.port");
const PID_FILE = join(DATA_DIR, "daemon.pid");
const HOLD_FILE = join(DATA_DIR, "daemon.hold");
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
  kind: "message" | "topic" | "announcement" | "status";
  in_reply_to?: number;
  target?: number;
  disposition?: string;
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
  // null = the daemon could not establish a count (unreadable file), NEVER 0.
  // 0 means "this channel is genuinely empty" and nothing else — b5.
  message_count: number | null;
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
  unarchived?: boolean;
  cleared?: boolean;
  snapshot?: string | null;
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
  kind?: "message" | "topic" | "announcement" | "status";
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

function holdActive(): number | null {
  try {
    if (!existsSync(HOLD_FILE)) return null;
    const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now()) return until;
    try {
      unlinkSync(HOLD_FILE);
    } catch {} // expired → clean
    return null;
  } catch {
    return null;
  }
}
export function releaseHold() {
  try {
    if (existsSync(HOLD_FILE)) unlinkSync(HOLD_FILE);
  } catch {}
}

async function ensureDaemon(): Promise<number> {
  let port = await readDaemonPort();
  if (port) return port;
  if (holdActive())
    die("daemon is held (respawn suppressed) — wait for the hold to clear or run `grapevine roll`");
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

async function cmdOpen(name: string, opts: { topic?: string; from?: string; fresh?: boolean }) {
  if (!name) die("usage: grapevine open <name> [--topic <text>] [--fresh]");
  const port = await ensureDaemon();
  const body: Record<string, string | boolean> = { name, explicit: true };
  if (opts.topic !== undefined) body.topic = opts.topic;
  if (opts.from !== undefined) body.from = opts.from;
  if (opts.fresh) body.fresh = true;
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

async function cmdPull(name: string, since: number, opts: { status?: string } = {}) {
  if (!name) die("usage: grapevine pull <channel> [--since <id>] [--status <value>]");
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name });

  if (opts.status !== undefined) {
    // Full-channel scan: filter by latest disposition, status frames excluded.
    const badged = loadChannelMessagesBadged(name);
    const filtered = badged.filter((m) => {
      const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
      // `--status open` mirrors triage's open bucket: signal-only, so non-message
      // FYIs (topic/announcement) are excluded from the actionable queue.
      return opts.status === "open"
        ? m.kind === "message" && isOpen(dispArg)
        : m.disposition === opts.status;
    });
    const lastId = filtered.length ? filtered[filtered.length - 1].id : 0;
    printJson({ ok: true, messages: filtered, cursor: lastId });
    return;
  }

  // Since-window path (unchanged from Task 2).
  const { status, data } = await api<MessagesResponse>(
    port,
    "GET",
    `/channels/${name}/messages?since=${since}`,
  );
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  const rawMsgs = data?.messages ?? [];
  const cursor = rawMsgs.length ? rawMsgs[rawMsgs.length - 1].id : since;
  const disp = foldDispositions(name);
  const annotated = rawMsgs
    .filter((m) => m.kind !== "status")
    .map((m) => {
      const d = disp.get(m.id);
      return d ? { ...m, disposition: d.disposition, reopens: d.reopens } : m;
    });
  printJson({ ok: true, messages: annotated, cursor });
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
  const dispMap = foldDispositions(name);
  const d = dispMap.get(id);
  const annotatedMsg = d ? { ...msg, disposition: d.disposition, reopens: d.reopens } : msg;
  if (opts.text) {
    // Prose mode: header + body, no JSON envelope, so a human (or an agent
    // recovering a truncated notification) can read it directly.
    const ts = new Date(msg.ts).toISOString();
    const dispPrefix = d
      ? d.reopens > 0
        ? `[${d.disposition} ↻${d.reopens}] `
        : `[${d.disposition}] `
      : "";
    process.stdout.write(`${dispPrefix}[${msg.id}] ${msg.from} · ${ts}\n${msg.text}\n`);
    return;
  }
  printJson({ ok: true, message: annotatedMsg });
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
    last?: number;
    as?: string;
    human?: boolean;
    lurk?: boolean;
    max?: number;
  },
) {
  if (!name)
    die(
      "usage: grapevine tail <name> [--as <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]",
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
    // #68 — `--last N` only rides the FIRST connection (while we've seen nothing
    // yet, highestSeen < 0). Once any message lands, highestSeen advances and a
    // reconnect resumes from it via `since` — never re-backfilling the window.
    const lastParam = opts.last !== undefined && highestSeen < 0 ? `&last=${opts.last}` : "";
    const url = `http://127.0.0.1:${port}/channels/${name}/tail?since=${highestSeen}${lastParam}${asParam}${humanParam}${lurkParam}`;

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
          // Drop status frames — disposition updates are metadata, not messages.
          if (payload.kind === "status") continue;
          // Suppress self-echo: when --as is set, drop messages we sent
          // ourselves. The sender already got the receipt as the POST
          // response, so re-emitting it on tail is pure noise.
          if (myAlias && payload.from === myAlias) continue;
          // #67 — front-load a recovery pointer on EVERY message frame, so the
          // read coordinates survive a downstream notification clip. Monitor
          // truncates at its OWN cap (below our hint threshold, and one we can't
          // observe here); a message it clips would otherwise lose its trailing
          // `id` and become unrecoverable — the reader is left inferring the id.
          // Every frame therefore carries a FRONT-loaded `read <channel> <id>`,
          // either as the richer `truncation_hint` (genuinely-long messages —
          // the "+N chars, you're definitely missing content" alarm) or as the
          // compact `full` pointer (everything else). Serializing it before the
          // long `.text` is what makes it survive the clip (F17).
          const readRef = `read ${name} ${payload.id}`;
          if (
            typeof payload.text === "string" &&
            payload.text.length > (opts.max ?? TRUNCATION_HINT_THRESHOLD)
          ) {
            const truncation_hint = `+${payload.text.length} chars — full: ${readRef}`;
            // Cap the INLINE body when --max is set (the full message stays on
            // disk → `read`); without --max, emit the full text (today's default).
            const text = opts.max !== undefined ? payload.text.slice(0, opts.max) : payload.text;
            process.stdout.write(`${JSON.stringify({ truncation_hint, ...payload, text })}\n`);
          } else {
            process.stdout.write(`${JSON.stringify({ full: readRef, ...payload })}\n`);
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

function foldDispositions(name: string) {
  const map = new Map<
    number,
    {
      disposition: string;
      from: string;
      ts: number;
      note: string;
      reopens: number;
    }
  >();
  const path = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    if (m.kind !== "status" || typeof m.target !== "number" || typeof m.disposition !== "string")
      continue;
    const prev = map.get(m.target);
    const reopens =
      (prev?.reopens ?? 0) +
      (m.disposition === "open" && prev && prev.disposition !== "open" ? 1 : 0);
    map.set(m.target, {
      disposition: m.disposition,
      from: m.from,
      ts: m.ts,
      note: m.text,
      reopens,
    });
  }
  return map;
}
// "open" = no entry, or latest disposition is "open"
function isOpen(d?: { disposition: string }) {
  return !d || d.disposition === "open";
}

// Reads the full channel log, drops kind:"status" frames, and badges each
// remaining message with its latest disposition via foldDispositions.
function loadChannelMessagesBadged(
  name: string,
): (Message & { disposition?: string; reopens?: number })[] {
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath)) return [];
  const disp = foldDispositions(name);
  const messages: (Message & { disposition?: string; reopens?: number })[] = [];
  for (const line of readFileSync(logPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    if (m.kind === "status") continue;
    const d = disp.get(m.id);
    if (d) {
      messages.push({ ...m, disposition: d.disposition, reopens: d.reopens });
    } else {
      messages.push(m);
    }
  }
  return messages;
}

type BadgedMessage = Message & { disposition?: string; reopens?: number };

// Dashboard render of a triage scan: the open queue on top, then each
// disposition group, one scannable line per message. Mirrors `read --text`
// prose mode so a human (or an agent) reads it without parsing JSON.
function renderTriageHuman(
  name: string,
  open: BadgedMessage[],
  by_status: Record<string, BadgedMessage[]>,
): string {
  const line = (m: BadgedMessage) => {
    const ts = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
    const reopen = m.reopens && m.reopens > 0 ? ` ↻${m.reopens}` : "";
    const head = m.text.split("\n")[0];
    const preview = head.length > 100 ? `${head.slice(0, 99)}…` : head;
    return `  [${m.id}${reopen}] ${m.from} · ${ts} · ${preview}`;
  };
  const sections = [`${name} · triage\n`, `OPEN (${open.length})`];
  sections.push(open.length ? open.map(line).join("\n") : "  —");
  for (const [status, items] of Object.entries(by_status)) {
    sections.push(`\n${status.toUpperCase()} (${items.length})`, items.map(line).join("\n"));
  }
  return `${sections.join("\n")}\n`;
}

async function cmdTriage(name: string, opts: { human?: boolean } = {}) {
  if (!name) die("usage: grapevine triage <channel> [--human]");
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name });
  const badged = loadChannelMessagesBadged(name);
  const open: BadgedMessage[] = [];
  const by_status: Record<string, BadgedMessage[]> = {};
  for (const m of badged) {
    // isOpen expects a disposition entry object (or undefined for no entry).
    const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
    if (isOpen(dispArg)) {
      // The open queue is signal-only: skip non-actionable frames (topic/
      // announcement FYIs can never carry a disposition, so they'd otherwise
      // pad "what's left?" forever).
      if (m.kind === "message") open.push(m);
    } else {
      const key = m.disposition ?? "unknown";
      if (!by_status[key]) by_status[key] = [];
      by_status[key].push(m);
    }
  }
  if (opts.human) {
    process.stdout.write(renderTriageHuman(name, open, by_status));
    return;
  }
  printJson({ ok: true, open, by_status });
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

async function cmdReset(name: string, opts: { force?: boolean }) {
  if (!name) die("usage: grapevine reset <name> [--force]");
  const port = await ensureDaemon();
  const body: Record<string, boolean> = {};
  if (opts.force) body.force = true;
  const { status, data } = await api<{ error?: string; subscribers?: number }>(
    port,
    "POST",
    `/channels/${name}/reset`,
    body,
  );
  if (status === 409 && data?.error === "live") {
    die(
      `channel has ${data.subscribers} live subscriber(s) — refusing to clear a live session. Re-run with --force to clear anyway (the log is snapshotted first).`,
    );
  }
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}

// Archive (read-only) or unarchive a channel (V1.7) — the non-destructive
// alternative to close: history is preserved, sends are rejected, and the name
// is locked from re-open until unarchived.
async function cmdMark(
  name: string,
  id: number,
  disposition: string,
  from: string,
  opts: { note?: string },
) {
  if (!name || !Number.isFinite(id) || !disposition)
    die("usage: grapevine mark <channel> <id> <disposition> [--note <text>] [--as <alias>]");
  const port = await ensureDaemon();
  const body: Record<string, unknown> = { from, target: id, disposition };
  if (opts.note !== undefined) body.note = opts.note;
  const { status, data } = await api<Message>(port, "POST", `/channels/${name}/status`, body);
  if (status >= 400 || !data) die((data as { error?: string })?.error ?? `HTTP ${status}`);
  printJson(data);
}

async function cmdArchive(name: string, unarchive: boolean) {
  const verb = unarchive ? "unarchive" : "archive";
  if (!name) die(`usage: grapevine ${verb} <channel>`);
  const port = await ensureDaemon();
  const { status, data } = await api<StatusResponse>(port, "POST", `/channels/${name}/${verb}`);
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}

async function cmdStop(opts: { holdSeconds?: number } = {}) {
  let heldUntil: number | undefined;
  if (opts.holdSeconds && opts.holdSeconds > 0) {
    heldUntil = Date.now() + opts.holdSeconds * 1000;
    try {
      writeFileSync(HOLD_FILE, String(heldUntil));
    } catch {}
  }
  const port = await readDaemonPort();
  if (!port) {
    printJson({
      ok: true,
      daemon: false,
      ...(heldUntil !== undefined ? { held_until: heldUntil } : {}),
    });
    return;
  }
  try {
    await api(port, "DELETE", "/");
  } catch {}
  printJson({
    ok: true,
    stopped: true,
    ...(heldUntil !== undefined ? { held_until: heldUntil } : {}),
  });
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
  if (!existing && holdActive()) {
    printJson({ ok: true, held: true, port: null });
    return;
  }
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

// b3 — THE VERSION VERIFY, AS ONE SOURCE FOR BOTH PATHS.
//
// `roll` is documented as "the recommended deploy step … + version verify", and
// the verify had two ways to say nothing:
//
//   COLD PATH — no daemon running: it spawned one and printed neither `version`
//   nor `version_ok`. The fields were ABSENT, so a caller checking the verify
//   got `undefined` on the exact path where the verify never happened.
//
//   WARM PATH — the probe was wrapped in `catch {}`, leaving `version = null`,
//   and `version_ok: null === PLUGIN_VERSION` evaluates to FALSE. "I could not
//   check" was reported as "the version is WRONG" — a boolean that cannot say
//   "unknown" is the canonical shape of this sprint's defect, and false is the
//   worst available answer because it is actionable and incorrect.
//
// So `version_ok` is now `boolean | null`: null means UNCHECKED, never false.
// `version_unchecked_reason` is present-and-null beside it, because a bare null
// tells a caller the check did not happen and not why.
//
// One helper rather than two call sites: a second copy of this logic on the cold
// path is the mirror-drift trap, and the cold path is precisely the one nobody
// re-reads.
export async function probeVersion(port: number): Promise<{
  version: string | null;
  version_ok: boolean | null;
  version_unchecked_reason: string | null;
}> {
  try {
    const v = (await api<RootInfo>(port, "GET", "/")).data?.version ?? null;
    if (v === null) {
      return {
        version: null,
        version_ok: null,
        version_unchecked_reason: "the daemon answered but reported no version",
      };
    }
    return { version: v, version_ok: v === PLUGIN_VERSION, version_unchecked_reason: null };
  } catch (e) {
    return {
      version: null,
      version_ok: null,
      version_unchecked_reason: `could not reach the daemon to verify: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

async function cmdRoll(opts: { force?: boolean }) {
  const port = await readDaemonPort();
  if (!port) {
    // COLD PATH — nothing was running, so this is a start rather than a roll.
    // It still reports the verify, because "no daemon was up" is not a reason to
    // stay silent about which version is now serving.
    const fresh = await ensureDaemon();
    printJson({
      ok: true,
      rolled: true,
      previous_pid: null,
      port: fresh,
      ...(await probeVersion(fresh)),
    });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die(
      `roll: ${total} active subscriber(s) — ${where}. They'll auto-reconnect across the roll. Re-run with --force to proceed.`,
    );
  }
  let previousPid: number | null = null;
  try {
    previousPid = (await api<RootInfo>(port, "GET", "/")).data?.pid ?? null;
  } catch {}
  // Stop with a short hold so a stale CLI can't win the respawn race; we hold the spawn ourselves.
  const holdMs = 4000;
  try {
    writeFileSync(HOLD_FILE, String(Date.now() + holdMs));
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if ((await readDaemonPort()) === null) break;
  }
  releaseHold(); // our turn to spawn the new version
  const fresh = await ensureDaemon();
  let pid: number | null = null;
  try {
    pid = (await api<RootInfo>(fresh, "GET", "/")).data?.pid ?? null;
  } catch {}
  printJson({
    ok: true,
    rolled: true,
    previous_pid: previousPid,
    pid,
    port: fresh,
    ...(await probeVersion(fresh)),
  });
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

  // Enumerate other daemon processes via the shared classifier. Each entry
  // gains port/home/version/status/reapable so the operator has the full
  // picture without needing a separate `reap --dry-run`.
  const otherDaemons: Array<Awaited<ReturnType<typeof classifyDaemon>> & { command?: string }> = [];
  const selfPid = authoritative?.pid as number | undefined;
  try {
    for (const pid of await listGrapevineDaemonPids()) {
      if (selfPid && pid === selfPid) continue;
      otherDaemons.push(await classifyDaemon(pid));
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
    const reapableCount = otherDaemons.filter((d) => d.reapable).length;
    if (reapableCount > 0) {
      hints.push(
        `Found ${reapableCount} reapable orphan daemon(s). Run \`grapevine reap\` to clear them safely.`,
      );
    }
    if (otherDaemons.some((d) => d.status === "unresponsive")) {
      hints.push("Some daemons are unresponsive; `grapevine reap --force` includes them.");
    }
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

// ── Daemon enumeration + classifier ──────────────────────────────────────────

/** All grapevine daemon.ts pids visible on this machine (via `ps`). */
async function listGrapevineDaemonPids(): Promise<number[]> {
  const pids: number[] = [];
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
      const m = line.match(/^\s*(\d+)\s+/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid) pids.push(pid);
    }
  } catch {
    // ps unavailable; return empty
  }
  return pids;
}

async function lsofListenPort(pid: number): Promise<number | null> {
  try {
    const proc = spawn("lsof", ["-aiTCP", "-sTCP:LISTEN", "-p", String(pid), "-P", "-n"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on("data", (b) => chunks.push(b as Buffer));
    await new Promise<void>((r) => proc.on("exit", () => r()));
    const m = Buffer.concat(chunks)
      .toString("utf-8")
      .match(/127\.0\.0\.1:(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

export type DaemonStatus = "authoritative" | "orphan" | "unresponsive" | "unknown";

export async function classifyDaemon(pid: number): Promise<{
  pid: number;
  port: number | null;
  home?: string;
  version?: string | null;
  status: DaemonStatus;
  reapable: boolean;
}> {
  const port = await lsofListenPort(pid);
  if (!port) return { pid, port: null, status: "unknown", reapable: false };
  let info: RootInfo | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) info = (await res.json()) as RootInfo;
  } catch {}
  if (!info) return { pid, port, status: "unresponsive", reapable: false }; // reap only with --force (handled in cmdReap)
  const home = info.data_dir as string;
  let owns = false;
  try {
    const op = readFileSync(join(home, "daemon.port"), "utf-8").trim();
    const oi = readFileSync(join(home, "daemon.pid"), "utf-8").trim();
    owns = op === String(port) && oi === String(pid);
  } catch {}
  return owns
    ? {
        pid,
        port,
        home,
        version: info.version ?? null,
        status: "authoritative",
        reapable: false,
      }
    : {
        pid,
        port,
        home,
        version: info.version ?? null,
        status: "orphan",
        reapable: true,
      };
}

async function cmdReap(opts: { force?: boolean; dryRun?: boolean }) {
  const selfPort = await readDaemonPort(); // current HOME authoritative (never reap)
  let selfPid: number | null = null;
  if (selfPort) {
    try {
      selfPid = (await api<RootInfo>(selfPort, "GET", "/")).data?.pid ?? null;
    } catch {}
  }
  const pids = await listGrapevineDaemonPids();
  const kept: unknown[] = [],
    reaped: unknown[] = [],
    skipped: unknown[] = [];
  for (const pid of pids) {
    const c = await classifyDaemon(pid);
    const isSelf = pid === selfPid;
    const shouldReap =
      !isSelf && (c.reapable || (c.status === "unresponsive" && opts.force === true));
    if (!shouldReap) {
      kept.push(c);
      continue;
    }
    if (opts.dryRun) {
      skipped.push({ ...c, note: "dry-run" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(c);
    } catch {
      skipped.push({ ...c, note: "kill failed" });
    }
  }
  printJson({ ok: true, dry_run: !!opts.dryRun, kept, reaped, skipped });
}

// (BOOLEAN_FLAGS was here. It listed which flags take no value — half a
// registry, consulted by the hand-rolled parser. Its 13 entries now live in
// CLI_OPTIONS below as `{type:"boolean"}`, verified 13-for-13 against thoth's
// independently-derived artifact before the move. Deleted rather than left
// beside its replacement: a second source of truth for the same fact is the
// drift bug this lane exists to remove, and it would no longer be consulted
// by anything.)

// Signature of a heredoc fumble: a line that is (or begins with) a
// `bun … cli.ts … send` invocation. When a `send --stdin <<EOF` is botched, the
// shell pipes the literal command line in as the body, which then gets posted —
// corrupting the channel with `bun /…/cli.ts send <channel> --as … <text>`.
// We refuse to post such a body unless --force is passed.
const LEAKED_SEND_RE = /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\b(?:send|announce)\b/;
function looksLikeLeakedSend(text: string): boolean {
  return LEAKED_SEND_RE.test(text);
}

// Shell-metacharacter footgun (#60): a body passed as an INLINE positional arg
// is exposed to the caller's shell, which command-substitutes backticks /
// `$(...)` / `${...}` BEFORE grapevine sees it — corrupting or partially
// executing code-bearing messages. The CLI can't un-substitute what the shell
// already ate; the honest fix is to steer callers to the shell-free paths
// (--body-file / --stdin / default-stdin). When metacharacters SURVIVE into an
// inline body (e.g. the caller happened to single-quote), they're intact this
// time — but the pattern is a latent footgun, so we warn (never block: the
// message is fine as received). Absent-metachar inline bodies are either plain
// text (safe) or already-substituted (undetectable) — so we only warn on the
// detectable risky pattern.
const SHELL_METACHAR_RE = /`|\$\(|\$\{/;
export function looksShellRisky(text: string): boolean {
  return SHELL_METACHAR_RE.test(text);
}

// #81 / D4 — THE RECOGNIZED SET, AT PARSER ALTITUDE.
//
// grapevine already had HALF a registry: `BOOLEAN_FLAGS` above told the parser
// which flags take no value. What it had no notion of was which flags EXIST, so
// an unknown flag was accepted at exit 0 and the verb ran anyway, and free prose
// containing a `--word` was silently truncated at that word.
//
// ⚠ grapevine is the OUTLIER of the six, and it is worth saying why so nobody
// reads it as merely behind: it types its value flags with a CAST
// (`flags.topic as string | undefined`) where the other entry points use a
// `typeof` guard. A cast is a claim with NO RUNTIME CHECK, so grapevine carried
// a class of latent type-lie the others were guarded against — and bare value
// flags produced silent wrong values rather than errors:
//
//   --last   bare  ->  parseInt(true, 10)  ->  NaN, silently
//   --topic  bare  ->  `true` in a field DECLARED `string`
//
// `strict: true` turns each of those from a silent wrong value into a
// caller-facing error, which is the lane's whole purpose and the largest
// behaviour delta of the six entry points.
//
// The boolean set below is BOOLEAN_FLAGS, unchanged — extracted from this file
// and diffed against thoth's independently-derived artifact: 13 for 13, exact,
// zero divergence in either direction.
const CLI_OPTIONS = {
  as: { type: "string" },
  "body-file": { type: "string" },
  channels: { type: "string" },
  from: { type: "string" },
  hold: { type: "string" },
  "in-reply-to": { type: "string" },
  last: { type: "string" },
  max: { type: "string" },
  note: { type: "string" },
  since: { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  topic: { type: "string" },
  all: { type: "boolean" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  fresh: { type: "boolean" },
  "from-start": { type: "boolean" },
  human: { type: "boolean" },
  literal: { type: "boolean" },
  lurk: { type: "boolean" },
  quiet: { type: "boolean" },
  stdin: { type: "boolean" },
  text: { type: "boolean" },
  verbose: { type: "boolean" },
  yes: { type: "boolean" },
} as const;

class UsageError extends Error {}

type FlagName = keyof typeof CLI_OPTIONS;
type Flags = Record<string, string | boolean>;

// Identity is contractually GLOBAL: SKILL.md tells agents to pass --as/--from
// on EVERY verb (a fresh shell per command means GRAPEVINE_FROM never
// persists), so every command accepts both — even where a verb has no use for
// identity, a caller following our own docs must not be rejected for obeying
// them. On `grep`, `--from` is an author FILTER rather than identity: different
// semantics, same acceptance.
const GLOBAL_FLAGS: FlagName[] = ["as", "from"];

type PositionalSpec = { name: string; required: boolean; variadic?: boolean };

// THE COMMAND TABLE, AS A STRUCTURE — the parser, the dispatcher, the schema
// emitter and the root rejection all walk THIS. It replaced a bare `switch`,
// which only the dispatcher could walk: a schema emitted from anything other
// than the structure that routes the behaviour is a document that lies as soon
// as anyone edits the other side (acc STANDARD.md Part 1 §2; our own #81/D4
// lane learned the same lesson one altitude down with BOOLEAN_FLAGS).
//
// `flags` is the verb's OWN accepted set (GLOBAL_FLAGS are merged in by
// `acceptedFlags`). A flag not listed here is REJECTED for this verb with the
// verb's own set enumerated — accepted-and-ignored is the disease this table
// exists to cure (acc DT-1: anthill accepting a root `--format` it silently
// discards; grapevine accepting `send --dry-run` and doing nothing was the
// same event with a different spelling).
type CommandSpec = {
  name: string;
  aliases?: string[];
  flags: FlagName[];
  positionals: PositionalSpec[];
  run: (positional: string[], flags: Flags) => Promise<void> | void;
};

// A declared value flag that carries a number must REJECT a non-number as a
// usage error (exit 2), not crash on it downstream — `schema` publishes the
// flag as valid, so the parse boundary is where a bad value gets its
// caller-facing answer. (`wait --timeout notanumber` used to throw an
// unhandled RangeError at exit 1, stack trace and all.)
function numericFlag(verb: string, name: string, raw: unknown, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    die(`${verb}: --${name} expects a non-negative number, got ${JSON.stringify(String(raw))}`);
  return n;
}

// Body resolution shared by send/announce — first match wins: --body-file,
// --stdin, inline positionals, default-stdin when piped. See the per-verb
// comments at the original sites (V1.6/#60); behaviour unchanged.
async function resolveBody(
  verb: "send" | "announce",
  inline: string[],
  flags: Flags,
): Promise<{ text: string; fromInline: boolean }> {
  if (flags["body-file"]) {
    const path = flags["body-file"] as string;
    const file = Bun.file(path);
    if (!(await file.exists())) die(`${verb}: --body-file not found: ${path}`);
    return { text: (await file.text()).replace(/\n$/, ""), fromInline: false };
  }
  if (flags.stdin || (inline.length === 0 && !process.stdin.isTTY)) {
    const buf: Buffer[] = [];
    for await (const chunk of process.stdin) buf.push(chunk as Buffer);
    return {
      text: Buffer.concat(buf).toString("utf-8").replace(/\n$/, ""),
      fromInline: false,
    };
  }
  return { text: inline.join(" "), fromInline: true };
}

// The two body guards shared by send/announce: refuse a leaked invocation
// (fumbled heredoc) unless --force, and warn on shell metacharacters that
// survived an inline body (#60 — warn, never block).
function guardBody(verb: "send" | "announce", text: string, fromInline: boolean, force: boolean) {
  if (!force && looksLikeLeakedSend(text)) {
    die(
      `${verb}: that body looks like a leaked grapevine invocation (a fumbled ` +
        "heredoc?). Nothing was sent. Pipe the real body via --stdin or " +
        "--body-file <path>, or pass --force to send it anyway.",
    );
  }
  if (fromInline && looksShellRisky(text)) {
    process.stderr.write(
      "# ⚠ inline body contains shell metacharacters (backtick, $(), curly-brace vars). " +
        "It was sent as-is, but the shell can command-substitute these before " +
        "grapevine sees them — use --body-file or --stdin for code-bearing messages.\n",
    );
  }
}

const identityRequired = (verb: string): never =>
  die(`${verb}: identity required — pass --as/--from <alias> or set GRAPEVINE_FROM env var`);

const COMMANDS: CommandSpec[] = [
  {
    name: "open",
    flags: ["topic", "fresh"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdOpen(positional[0], {
        topic: flags.topic as string | undefined,
        from: resolveAlias(flags),
        fresh: flags.fresh === true,
      });
    },
  },
  {
    name: "topic",
    flags: [],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true },
    ],
    run: async (positional, flags) => {
      await cmdTopic(
        positional[0],
        positional.length > 1 ? positional.slice(1).join(" ") : undefined,
        resolveAlias(flags),
      );
    },
  },
  {
    name: "list",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdList();
    },
  },
  {
    name: "send",
    flags: ["body-file", "stdin", "quiet", "verbose", "force", "in-reply-to"],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true },
    ],
    run: async (positional, flags) => {
      const name = positional[0];
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("send", positional.slice(1), flags);
      if (!from) identityRequired("send");
      guardBody("send", text, fromInline, !!flags.force);
      await cmdSend(name, from as string, text, {
        quiet: !!flags.quiet,
        verbose: !!flags.verbose,
        inReplyTo: flags["in-reply-to"]
          ? numericFlag("send", "in-reply-to", flags["in-reply-to"], 0)
          : undefined,
      });
    },
  },
  {
    name: "announce",
    flags: ["body-file", "stdin", "quiet", "force", "channels"],
    positionals: [{ name: "text", required: false, variadic: true }],
    run: async (positional, flags) => {
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("announce", positional, flags);
      if (!from) identityRequired("announce");
      guardBody("announce", text, fromInline, !!flags.force);
      const channels = flags.channels
        ? (flags.channels as string)
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined;
      await cmdAnnounce(from as string, text, channels, { quiet: !!flags.quiet });
    },
  },
  {
    name: "pull",
    flags: ["since", "status"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("pull", "since", flags.since, 0);
      await cmdPull(positional[0], since, { status: flags.status as string | undefined });
    },
  },
  {
    name: "triage",
    flags: ["human"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdTriage(positional[0], { human: !!flags.human });
    },
  },
  {
    name: "read",
    flags: ["text"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true },
    ],
    run: async (positional, flags) => {
      const id = positional[1] ? parseInt(positional[1], 10) : NaN;
      await cmdRead(positional[0], id, { text: !!flags.text });
    },
  },
  {
    name: "wait",
    flags: ["since", "timeout"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("wait", "since", flags.since, 0);
      const timeout = numericFlag("wait", "timeout", flags.timeout, 30);
      await cmdWait(positional[0], since, timeout, resolveAlias(flags));
    },
  },
  {
    name: "who",
    flags: ["all"],
    positionals: [{ name: "name", required: false }],
    run: async (positional, flags) => {
      if (flags.all) await cmdWhoAll();
      else await cmdWho(positional[0]);
    },
  },
  {
    name: "alias",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdAlias(positional[0]);
    },
  },
  {
    name: "tail",
    flags: ["since", "from-start", "last", "human", "lurk", "max"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdTail(positional[0], {
        since: flags.since !== undefined ? numericFlag("tail", "since", flags.since, 0) : undefined,
        fromStart: !!flags["from-start"],
        last: flags.last !== undefined ? numericFlag("tail", "last", flags.last, 0) : undefined,
        as: resolveAlias(flags),
        human: !!flags.human,
        lurk: !!flags.lurk,
        max: resolveTailMax(flags.max),
      });
    },
  },
  {
    name: "grep",
    flags: ["literal"],
    positionals: [
      { name: "name", required: true },
      { name: "pattern", required: true, variadic: true },
    ],
    run: async (positional, flags) => {
      await cmdGrep(positional[0], positional.slice(1).join(" "), {
        literal: !!flags.literal,
        from: flags.from as string | undefined,
      });
    },
  },
  {
    name: "close",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional) => {
      await cmdClose(positional[0]);
    },
  },
  {
    name: "reset",
    flags: ["force"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdReset(positional[0], { force: flags.force === true });
    },
  },
  {
    name: "mark",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true },
      { name: "disposition", required: true, variadic: true },
    ],
    run: async (positional, flags) => {
      await cmdMark(
        positional[0],
        parseInt(positional[1], 10),
        positional.slice(2).join(" "),
        resolveAlias(flags) ?? identityRequired("mark"),
        { note: flags.note as string | undefined },
      );
    },
  },
  {
    name: "reopen",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true },
    ],
    run: async (positional, flags) => {
      await cmdMark(
        positional[0],
        parseInt(positional[1], 10),
        "open",
        resolveAlias(flags) ?? identityRequired("reopen"),
        { note: flags.note as string | undefined },
      );
    },
  },
  {
    name: "archive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional) => {
      await cmdArchive(positional[0], false);
    },
  },
  {
    name: "unarchive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional) => {
      await cmdArchive(positional[0], true);
    },
  },
  {
    name: "start",
    aliases: ["up"],
    flags: [],
    positionals: [],
    run: async () => {
      await cmdStart();
    },
  },
  {
    name: "restart",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRestart({ force: !!flags.force || !!flags.yes });
    },
  },
  {
    name: "roll",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRoll({ force: flags.force === true || flags.yes === true });
    },
  },
  {
    name: "stop",
    flags: ["hold"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdStop({
        holdSeconds:
          flags.hold !== undefined ? numericFlag("stop", "hold", flags.hold, 0) : undefined,
      });
    },
  },
  {
    name: "watch",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdWatch(positional[0]);
    },
  },
  {
    name: "reap",
    aliases: ["prune"],
    flags: ["force", "dry-run"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdReap({ force: flags.force === true, dryRun: flags["dry-run"] === true });
    },
  },
  {
    name: "info",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdInfo();
    },
  },
  {
    name: "doctor",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdDoctor();
    },
  },
  {
    name: "version",
    flags: ["human"],
    positionals: [],
    run: (_positional, flags) => {
      // The CLI can be ASKED what it is. grapevine already carries
      // PLUGIN_VERSION to warn that a daemon is from a different cached plugin
      // path than this CLI (maybeWarnOnVersionMismatch) — but a caller that hit
      // that warning, or that runs `roll` for its version verify, had no way to
      // ask this side what it is holding. The value was already in memory; only
      // the question was missing.
      // JSON by default, matching every data command; --human for prose.
      if (PLUGIN_VERSION === null) die("version unavailable — could not read plugin.json", 1);
      if (flags.human === true) process.stdout.write(`grapevine v${PLUGIN_VERSION}\n`);
      else printJson({ name: "grapevine", version: PLUGIN_VERSION });
    },
  },
  {
    name: "schema",
    flags: [],
    positionals: [],
    run: () => {
      // Emit this CLI's machine-readable interface description — generated by
      // WALKING COMMANDS and CLI_OPTIONS, the same structures the parser and
      // dispatcher consume, at answer time. No daemon, no config, no
      // credentials; stdout, exit 0. The shape is acc declaration format v0
      // exactly, so the output pipes straight into
      // `acc check <cli> --declaration <(grapevine schema)` with no adapter.
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}\n`);
    },
  },
  {
    name: "help",
    flags: [],
    positionals: [],
    run: () => {
      printHelp();
    },
  },
];

function findCommand(token: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === token || c.aliases?.includes(token));
}

// The verb's full accepted set: its own flags plus the contractually-global
// identity pair, in registry order.
function acceptedFlags(spec: CommandSpec): FlagName[] {
  const own = new Set<FlagName>([...GLOBAL_FLAGS, ...spec.flags]);
  return (Object.keys(CLI_OPTIONS) as FlagName[]).filter((k) => own.has(k));
}

// Root interceptors — flags the ROOT answers itself, before any verb. These are
// not commands, which is exactly why a generator walking "the commands" walks
// past them (acc DT-6); they are declared explicitly at `path: []`.
const ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" },
] as const;

// acc declaration format v0 (see agent-cli-conformance src/acc/kit/declaration.ts):
// { formatVersion, provenance, selfDescription, commands: [{ path, args, positionals }] }.
// v0 refuses unknown keys, so nothing richer (effects, summaries, versions)
// rides along — those wait for a v1 with slots for them.
function buildDeclaration() {
  // Every registry flag is accepted today; a refusal list would add
  // status: "refused" entries here the day a verb recognises-and-declines one.
  const arg = (k: FlagName) => ({
    name: `--${k}`,
    type: CLI_OPTIONS[k].type,
    status: "valid",
  });
  const commands: {
    path: string[];
    args: { name: string; type: "string" | "boolean"; status: string }[];
    positionals: PositionalSpec[];
  }[] = [
    {
      // `path: []` IS the root. Its grammar: one required token selecting a
      // command, or an interceptor flag the root answers itself.
      path: [],
      args: ROOT_INTERCEPTORS.map((i) => ({
        name: i.name,
        type: "boolean" as const,
        status: "valid",
      })),
      positionals: [{ name: "command", required: true }],
    },
  ];
  for (const spec of COMMANDS) {
    for (const name of [spec.name, ...(spec.aliases ?? [])]) {
      commands.push({
        path: [name],
        args: acceptedFlags(spec).map((k) => arg(k)),
        positionals: spec.positionals,
      });
    }
  }
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands,
  };
}

function parseFlags(
  argv: string[],
  spec: CommandSpec,
): {
  positional: string[];
  flags: Flags;
} {
  const accepted = acceptedFlags(spec);
  const options = Object.fromEntries(accepted.map((k) => [k, CLI_OPTIONS[k]]));
  try {
    const { values, positionals } = nodeParseArgs({
      args: argv,
      options,
      strict: true,
      allowPositionals: true,
    });
    return {
      positional: positionals,
      flags: values as Flags,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // "recognized flags:" with the colon straight after the noun — the exact
    // marker shape flag-set extractors match ("Valid flags: --x" and kin; acc's
    // MARKER regex is the measured consumer). A qualifier between the noun and
    // the colon ("recognized flags for send:") reads as prose, not a set.
    const bodyHint =
      spec.name === "send" || spec.name === "announce"
        ? `\n  for a message body containing dashes, use --stdin or --body-file, ` +
          `or put it after a bare --`
        : "";
    throw new UsageError(
      `${spec.name}: ${detail}\n` +
        `  recognized flags: ${accepted.map((k) => `--${k}`).join(" ")}${bodyHint}`,
    );
  }
}

function commandTokens(): string[] {
  return COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
}

function printHelp() {
  process.stdout.write(`grapevine — agent-to-agent walkie-talkie

Usage:
  grapevine open <name> [--topic <text>] [--fresh]   open/create (auto-unarchives; --fresh clears a dormant channel)
  grapevine list
  grapevine send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--body-file <path>] [--force] [--in-reply-to <id>] [<text...>]
                                    # body: inline text, --stdin, --body-file, or piped stdin (default when no inline text)
  grapevine announce [--from/--as <alias>] [--channels a,b,c] [--stdin] [--body-file <path>] [--quiet] [<text...>]
                                    # broadcast one message to every active channel (or --channels)
  grapevine tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]
       # --last <n>: backfill the most recent n messages then go live (bounded catch-up for a cold joiner)
  grapevine pull <name> [--since <id>] [--status <value>]   # --status = full-scan filter (open|wontfix|incorporated|…)
  grapevine triage <name>             # full-scan: open messages on top + grouped by_status
  grapevine mark <name> <id> <disposition> [--note <text>]  # set disposition (incorporated|wontfix|deferred|…)
  grapevine reopen <name> <id>        # bounce a message back to open
  grapevine read <name> <id> [--text]   # one full message by id (--text = prose)
  grapevine wait <name> [--since <id>] [--timeout <s>]
  grapevine grep <name> <pattern> [--literal] [--from <alias>]
  grapevine topic <name> [<text>]   # no text → read current; with text → update
  grapevine who <name>              # roster; the humans field lists humans
  grapevine alias [<name>]          # set/show your persisted alias (config.json)
  grapevine watch [<name>]          # open browser tab; live chat-bubble view
  grapevine reset <name> [--force]           snapshot the log → ~/.grapevine/archive, then clear it
  grapevine archive <name>          # read-only: keep history, reject sends
  grapevine unarchive <name>        # bring an archived channel back
  grapevine close <name>            # destructive: delete the message log
  grapevine start                   # ensure the daemon is running (alias: up); no channel
  grapevine restart [--force|--yes] # stop + respawn fresh; --force to override the live-fleet guard
  grapevine roll [--force]          # safe restart (stop+hold+respawn) + version verify — the recommended deploy step
  grapevine stop [--hold <seconds>] # kill the daemon; --hold suppresses auto-respawn for <s> seconds (upgrade window)
  grapevine info
  grapevine doctor                  # health check — labels each daemon: authoritative / orphan / unresponsive / unknown
  grapevine reap [--force] [--dry-run]  # kill orphan daemons; --force also kills unresponsive; alias: prune

  grapevine schema                  # this CLI's machine-readable interface description (acc declaration v0)
  grapevine --version               # this CLI's version (alias: -V, version)
  grapevine help                    # this usage (alias: --help, -h)

Output:
  Data commands emit JSON on stdout by DEFAULT; pass --human for prose where a
  command offers it. Diagnostics and warnings go to stderr, never stdout.
  Usage errors exit 2. Each command accepts its OWN flags (plus --as/--from,
  which are global) — an unknown flag for a verb enumerates that verb's set.

Env:
  GRAPEVINE_FROM   Default identity alias (--from/--as are interchangeable).
  GRAPEVINE_HOME   Data dir (default ~/.grapevine).
`);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // Usage failures return 2 rather than exiting, so the runtime drains stdout.

  // BARE INVOCATION IS A USAGE ERROR — exit 2, usage pointer on stderr — not a
  // help request at exit 0. grapevine's callers are agents: a bare call is an
  // unset shell variable expanding to nothing, or a mistake, and answering it
  // with 2.9KB of help at exit 0 reports success for a command that asked for
  // nothing. `help` / `--help` remain one token away at exit 0 (acc D2 —
  // conformed for that reason, not because the rule said so).
  if (cmd === undefined) {
    process.stderr.write(
      `grapevine: expected a command\n` +
        `  commands: ${commandTokens().join(" ")}\n` +
        `  run \`grapevine help\` (or --help) for usage\n`,
    );
    return 2;
  }

  // ROOT FLAG ROUTING. A leading --token used to be consumed as the COMMAND
  // token and rejected as `unknown command: --nope` — a flag reaching the verb
  // parser's error path, where the rejection could not enumerate the flag set
  // (found via acc's root-only surface capture). The root's accepted flags are
  // the interceptors; anything else dashed is rejected AS A FLAG, enumerating
  // the root's own set.
  if (cmd.startsWith("-")) {
    const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === cmd);
    if (!interceptor) {
      process.stderr.write(
        `grapevine: unknown flag at the root: ${cmd}\n` +
          // Long flags first: flag-set extractors (acc's measured) read the
          // list left-to-right and stop at the first token that is not a
          // `--long` flag, so a short alias mid-list truncates what they see.
          `  recognized flags: ${[...ROOT_INTERCEPTORS.map((i) => i.name)]
            .sort((a, b) => Number(b.startsWith("--")) - Number(a.startsWith("--")))
            .join(" ")}\n` +
          `  commands (each takes its own flags): ${commandTokens().join(" ")}\n`,
      );
      return 2;
    }
    return await runCommand(findCommand(interceptor.runs) as CommandSpec, rest);
  }

  const spec = findCommand(cmd);
  if (!spec) {
    // The unknown-verb rejection enumerates the valid set, exactly as the
    // unknown-flag rejection does — the parser's own account of what it
    // accepts, produced by the parser (acc STANDARD.md, "the cheapest version
    // of checked").
    process.stderr.write(
      `grapevine: unknown command: ${cmd}\n  commands: ${commandTokens().join(" ")}\n`,
    );
    return 2;
  }
  return await runCommand(spec, rest);
}

async function runCommand(spec: CommandSpec, rest: string[]): Promise<number> {
  let positional: string[];
  let flags: Flags;
  try {
    ({ positional, flags } = parseFlags(rest, spec));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`grapevine: ${e.message}\n`);
    return 2;
  }
  // Arity, enforced FROM THE DECLARED SHAPE — the registry's positional spec is
  // what `schema` publishes, so enforcing it here is what keeps the declaration
  // true by construction: a missing required positional errors before the verb
  // runs, and an EXCESS positional is rejected rather than silently swallowed
  // (acc A4's shape — the defect no external check can see).
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (positional.length < required) {
    const missing = spec.positionals[positional.length];
    process.stderr.write(
      `grapevine: ${spec.name}: missing required <${missing?.name ?? "argument"}>\n` +
        `  expects: ${spec.name} ${spec.positionals
          .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
          .join(" ")}\n`,
    );
    return 2;
  }
  if (!variadic && positional.length > spec.positionals.length) {
    process.stderr.write(
      `grapevine: ${spec.name}: unexpected argument ${JSON.stringify(
        positional[spec.positionals.length],
      )}\n` +
        `  expects: ${spec.name} ${
          spec.positionals.map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`)).join(" ") ||
          "(no arguments)"
        }\n`,
    );
    return 2;
  }
  await spec.run(positional, flags);
  return 0;
}

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
