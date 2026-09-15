// The one impure module of the surface: the EventSource, the two 3 s polls,
// the 1 s reconnect, the scroll element, localStorage and the URL hash. Every
// rule it applies lives in the pure modules beside it (channel.ts,
// identity.ts, feed.ts) and is tested there; this file only wires them to the
// browser. Inventory rows are cited inline.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { channelFromHash, pageTitle } from "./channel";
import {
  appendMessage,
  emptyFeed,
  type Feed,
  isChannelArchived,
  mergeChannels,
  nearBottom,
} from "./feed";
import {
  commitAlias,
  initialMode,
  loadAlias,
  nextMode,
  saveMode,
  subscribedStatus,
  tailUrl,
} from "./identity";
import {
  type CreateOutcome,
  createOutcome,
  loadShowArchived,
  parkIntent,
  saveShowArchived,
  signedBody,
  takeIntent,
  topicFrom,
} from "./lifecycle";
import type { ChannelRow, ChannelWire, Message, Mode } from "./types";

export type Grapevine = ReturnType<typeof useGrapevine>;

export function useGrapevine() {
  // C1 — read once; a hash change reloads the page (C3), so this never moves.
  const [channel] = useState(() => channelFromHash(location.hash));
  const [topic, setTopicState] = useState("");
  const [status, setStatus] = useState("connecting…");
  const [disconnected, setDisconnected] = useState(false);
  const [feed, setFeed] = useState<Feed>(emptyFeed);
  const [subscribers, setSubscribers] = useState<string[]>([]);
  const [humans, setHumans] = useState<string[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [channelArchived, setChannelArchived] = useState(false);
  const [alias, setAliasState] = useState(() => loadAlias(localStorage));
  const [mode, setModeState] = useState<Mode>("lurk");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // L3 — the persisted default alias (/identity), kept apart from the UI
  // override so a lurking human can still sign a topic edit with it.
  const [identityAlias, setIdentityAlias] = useState<string | null>(null);
  // L4 — the archived filter, remembered per browser.
  const [showArchived, setShowArchivedState] = useState(() => loadShowArchived(localStorage));
  // L3 — bumped whenever something asks the header to open its topic editor
  // (the context menu's _Edit topic_, or an intent parked before a reload).
  const [topicEditRequest, setTopicEditRequest] = useState(0);

  // Refs mirror the state the stream handlers and timers need without
  // re-subscribing: the feed (for `since=highest` on reconnect, N2), mode and
  // alias (for the reconnect's params), the seen-channel set (C6), the scroll
  // element (E3) and the current EventSource + its generation (E5).
  const feedRef = useRef(feed);
  const modeRef = useRef<Mode>("lurk");
  const aliasRef = useRef(alias);
  const seenRef = useRef<Set<string>>(new Set());
  const firstPollRef = useRef(true);
  const streamRef = useRef<HTMLElement | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const genRef = useRef(0);
  const stickRef = useRef(false);

  // The original sets `topic = t || ""` — a null topic reads as unset (H2).
  const setTopic = useCallback((t: string | null | undefined) => setTopicState(t || ""), []);

  // E3 — scroll after the DOM has the new row, only if we were near the
  // bottom before it was appended (the flag is set in the message handler).
  const rendered = feed.messages.length;
  useLayoutEffect(() => {
    const el = streamRef.current;
    if (rendered > 0 && stickRef.current && el) {
      el.scrollTop = el.scrollHeight;
      stickRef.current = false;
    }
  }, [rendered]);

  const refreshSubscribers = useCallback(async () => {
    try {
      const r = await fetch(`/channels/${encodeURIComponent(channel)}/subscribers`);
      const j = (await r.json()) as {
        subscribers?: string[];
        humans?: string[];
        topic?: string | null;
      };
      setSubscribers(j.subscribers || []);
      setHumans(j.humans || []);
      if (j.topic !== undefined) setTopic(j.topic);
    } catch {
      // X1 — polls fail silently; the last values stand.
    }
  }, [channel, setTopic]);

  const refreshChannels = useCallback(async () => {
    try {
      const r = await fetch("/channels");
      const j = (await r.json()) as { channels?: ChannelWire[] };
      const { rows, seen } = mergeChannels(seenRef.current, j.channels || [], firstPollRef.current);
      seenRef.current = seen;
      firstPollRef.current = false;
      setChannels(rows);
      setChannelArchived(isChannelArchived(rows, channel)); // C12
    } catch {
      // X1
    }
  }, [channel]);

  // N1 / R2 / E1 / E2 / E4 / E5 — (re)open the stream for the given mode and
  // alias. Bumps the generation and closes the prior stream so a toggle or a
  // reconnect never leaves two live EventSources, and a superseded stream's
  // late events are ignored rather than double-reconnecting.
  const connect = useCallback(
    (m: Mode, a: string) => {
      const myGen = ++genRef.current;
      esRef.current?.close();
      setDisconnected(false);
      setStatus(`connecting to ${channel}…`);
      const es = new EventSource(tailUrl(channel, feedRef.current.highest, m, a));
      esRef.current = es;
      es.addEventListener("subscribed", (ev) => {
        if (myGen !== genRef.current) return;
        try {
          const d = JSON.parse((ev as MessageEvent).data) as { topic?: string | null };
          if (d.topic !== undefined) setTopic(d.topic);
          setStatus(subscribedStatus(m, channel, a));
        } catch {
          // E6
        }
      });
      es.addEventListener("message", (ev) => {
        if (myGen !== genRef.current) return;
        try {
          const msg = JSON.parse((ev as MessageEvent).data) as Message;
          const el = streamRef.current;
          // Measure BEFORE the push (E3).
          stickRef.current = el
            ? nearBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
            : false;
          const r = appendMessage(feedRef.current, msg);
          feedRef.current = r.feed;
          setFeed(r.feed);
          if (r.topic !== undefined) setTopic(r.topic);
        } catch {
          // E6
        }
      });
      es.addEventListener("error", () => {
        if (myGen !== genRef.current) return;
        setDisconnected(true);
        setStatus("disconnected — reconnecting…");
        es.close();
        setTimeout(() => {
          if (myGen === genRef.current) connect(modeRef.current, aliasRef.current);
        }, 1000);
      });
    },
    [channel, setTopic],
  );

  // init (inventory C2, I1/R1, C13): title; resolve identity BEFORE the
  // first connect so a remembered join can register presence; then the
  // stream, the two polls, and the hash listener (C3).
  useEffect(() => {
    document.title = pageTitle(channel);
    let cancelled = false;
    (async () => {
      let a = aliasRef.current;
      // R1 (amended 2026-09-05): /identity is fetched on every init — the
      // default alias also signs a lurker's topic edit (L3) — but it PRE-FILLS
      // the alias only when no localStorage override exists, as before.
      let d: string | null = null;
      try {
        const r = await fetch("/identity");
        const j = (await r.json()) as { alias?: string | null };
        if (j.alias) d = j.alias;
      } catch {
        // X1
      }
      if (!a && d) a = d;
      if (cancelled) return;
      setIdentityAlias(d);
      aliasRef.current = a;
      setAliasState(a);
      const m = initialMode(localStorage, channel, a); // I4
      modeRef.current = m;
      setModeState(m);
      connect(m, a);
      refreshSubscribers();
      refreshChannels();
      // L3 — an _Edit topic_ parked before the switch to this channel.
      if (takeIntent(localStorage, channel) === "edit-topic") setTopicEditRequest((n) => n + 1);
    })();
    const t1 = setInterval(refreshSubscribers, 3000); // C13 / S3
    const t2 = setInterval(refreshChannels, 3000);
    const onHash = () => location.reload();
    window.addEventListener("hashchange", onHash);
    return () => {
      cancelled = true;
      clearInterval(t1);
      clearInterval(t2);
      window.removeEventListener("hashchange", onHash);
      genRef.current++;
      esRef.current?.close();
    };
  }, [channel, connect, refreshSubscribers, refreshChannels]);

  // I3
  const setAlias = useCallback((raw: string) => {
    const a = commitAlias(localStorage, raw);
    aliasRef.current = a;
    setAliasState(a);
    return a;
  }, []);

  // I6
  const toggleMode = useCallback(() => {
    const n = nextMode(modeRef.current, aliasRef.current);
    if (!n) return;
    if (n === "join") setAlias(aliasRef.current);
    modeRef.current = n;
    setModeState(n);
    saveMode(localStorage, channel, n);
    connect(n, aliasRef.current);
    refreshSubscribers();
  }, [channel, connect, refreshSubscribers, setAlias]);

  // C10 — after the confirmation; the dialog is the rail's.
  const closeChannel = useCallback(
    async (name: string) => {
      try {
        await fetch(`/channels/${encodeURIComponent(name)}`, { method: "DELETE" });
      } catch {
        // X1
      }
      seenRef.current.delete(name);
      refreshChannels();
      if (name === channel) location.hash = "lobby";
    },
    [channel, refreshChannels],
  );

  // L1 / L5 — archive and unarchive are reversible, so no confirmation. The
  // rail poll is the source of truth: nothing is mutated optimistically, the
  // refresh right after is just the next poll brought forward, and the
  // composer follows `channelArchived` from that poll exactly as it does for
  // the agent-driven case (C12).
  // L5a — SIGNED with the same alias a topic edit is signed with. Both routes
  // append a kind:"status" frame carrying `from`, and posting with no body left
  // the human's own act attributed to `system` on the one path humans actually
  // use. `topicFrom` is the single signer (mode/alias/identity fallback); when
  // it resolves to null the daemon signs `system`, which is then honest.
  const archiveChannel = useCallback(
    async (name: string) => {
      try {
        await fetch(`/channels/${encodeURIComponent(name)}/archive`, {
          method: "POST",
          ...signedBody(topicFrom(modeRef.current, aliasRef.current, identityAlias)),
        });
      } catch {
        // X1
      }
      refreshChannels();
    },
    [refreshChannels, identityAlias],
  );
  const unarchiveChannel = useCallback(
    async (name: string): Promise<{ ok: true } | { ok: false; message: string }> => {
      let out: { ok: true } | { ok: false; message: string } = {
        ok: false,
        message: "daemon unreachable",
      };
      try {
        const r = await fetch(`/channels/${encodeURIComponent(name)}/unarchive`, {
          method: "POST",
          ...signedBody(topicFrom(modeRef.current, aliasRef.current, identityAlias)),
        });
        if (r.ok) out = { ok: true };
        else {
          const j = (await r.json().catch(() => null)) as { error?: unknown } | null;
          out = { ok: false, message: typeof j?.error === "string" ? j.error : `HTTP ${r.status}` };
        }
      } catch {
        // X1 — the message above stands
      }
      refreshChannels();
      return out;
    },
    [refreshChannels, identityAlias],
  );

  // L2 — POST /channels as the CLI's non-explicit verbs do (no `explicit`,
  // so an archived name answers 409 and the dialog offers unarchive). The
  // topic, when given, is signed the way a topic edit is (L3) or falls to the
  // daemon's `system`. On success navigate: a hash change is a reload (C3);
  // creating the channel we are on is a no-op the poll confirms.
  // L2c — the daemon sets the POST's topic only on a channel with none, and
  // this deliberately does NOT follow with a PUT: the CLI's `open --topic`
  // does not clobber an existing topic either, and the dialog's hint says so.
  // Replacing a topic is _Edit topic_ (L3), one act with one path.
  const createChannel = useCallback(
    async (name: string, topic: string): Promise<CreateOutcome> => {
      const from = topicFrom(modeRef.current, aliasRef.current, identityAlias);
      const body: { name: string; topic?: string; from?: string } = { name };
      if (topic.trim()) {
        body.topic = topic.trim();
        if (from) body.from = from;
      }
      let outcome: CreateOutcome;
      try {
        const r = await fetch("/channels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        outcome = createOutcome(
          r.status,
          (await r.json().catch(() => null)) as { error?: unknown },
        );
      } catch {
        outcome = { kind: "error", message: "daemon unreachable" };
      }
      if (outcome.kind === "created") {
        if (name === channel) refreshChannels();
        else location.hash = name;
      }
      return outcome;
    },
    [channel, identityAlias, refreshChannels],
  );

  // L2 — the dialog's _Unarchive instead_: unarchive, then go there; a
  // failure comes back to the dialog, which stays open and says so.
  const unarchiveAndGo = useCallback(
    async (name: string) => {
      const r = await unarchiveChannel(name);
      if (r.ok && name !== channel) location.hash = name;
      return r;
    },
    [channel, unarchiveChannel],
  );

  // L3 — PUT the topic signed as `from`; the header follows the `kind:"topic"`
  // message that arrives over our own stream (E2), never an optimistic set.
  const putTopic = useCallback(
    async (text: string): Promise<boolean> => {
      const from = topicFrom(modeRef.current, aliasRef.current, identityAlias);
      if (!from) return false;
      try {
        const r = await fetch(`/channels/${encodeURIComponent(channel)}/topic`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: text, from }),
        });
        return r.ok;
      } catch {
        return false; // X1
      }
    },
    [channel, identityAlias],
  );

  // L3 — _Edit topic_ from the rail: the current channel's editor opens in
  // place; another channel's means switching there first (a reload), so the
  // request is parked and taken on the next init.
  const editTopicFor = useCallback(
    (name: string) => {
      if (name === channel) {
        setTopicEditRequest((n) => n + 1);
      } else {
        parkIntent(localStorage, name, "edit-topic");
        location.hash = name;
      }
    },
    [channel],
  );

  // L4
  const setShowArchived = useCallback((on: boolean) => {
    saveShowArchived(localStorage, on);
    setShowArchivedState(on);
  }, []);

  // P6 / P7 — resolves true iff the daemon accepted it; the composer clears
  // its draft on true and keeps it otherwise. No optimistic insert: the row
  // arrives over our own stream.
  const send = useCallback(
    async (draft: string): Promise<boolean> => {
      const text = draft.trim();
      if (!text || modeRef.current !== "join") return false;
      const body: { from: string; text: string; in_reply_to?: number } = {
        from: aliasRef.current,
        text,
      };
      if (replyingTo) body.in_reply_to = replyingTo.id;
      try {
        const r = await fetch(`/channels/${encodeURIComponent(channel)}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (r.ok) {
          setReplyingTo(null);
          return true;
        }
      } catch {
        // X2 — the draft is kept.
      }
      return false;
    },
    [channel, replyingTo],
  );

  return {
    channel,
    topic,
    status,
    disconnected,
    messages: feed.messages,
    msgById: (id: number) => feed.byId.get(id),
    subscribers,
    humans,
    channels,
    channelArchived,
    alias,
    mode,
    replyingTo,
    streamRef,
    setAlias,
    toggleMode,
    closeChannel,
    send,
    identityAlias,
    topicFrom: topicFrom(mode, alias, identityAlias),
    showArchived,
    setShowArchived,
    topicEditRequest,
    archiveChannel,
    unarchiveChannel,
    createChannel,
    unarchiveAndGo,
    putTopic,
    editTopicFor,
    replyTo: (m: Message) => setReplyingTo(m),
    cancelReply: () => setReplyingTo(null),
  };
}
