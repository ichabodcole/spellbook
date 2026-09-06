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

  // init (watch.html 745–778): title; resolve identity (I1/R1) BEFORE the
  // first connect so a remembered join can register presence; then the
  // stream, the two polls, and the hash listener (C3).
  useEffect(() => {
    document.title = pageTitle(channel);
    let cancelled = false;
    (async () => {
      let a = aliasRef.current;
      if (!a) {
        try {
          const r = await fetch("/identity");
          const j = (await r.json()) as { alias?: string | null };
          if (j.alias) a = j.alias;
        } catch {
          // X1
        }
      }
      if (cancelled) return;
      aliasRef.current = a;
      setAliasState(a);
      const m = initialMode(localStorage, channel, a); // I4
      modeRef.current = m;
      setModeState(m);
      connect(m, a);
      refreshSubscribers();
      refreshChannels();
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
    replyTo: (m: Message) => setReplyingTo(m),
    cancelReply: () => setReplyingTo(null),
  };
}
