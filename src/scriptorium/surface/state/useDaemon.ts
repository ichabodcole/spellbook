// The surface's ONE connection to the daemon: a WebSocket at /ws. State
// snapshots come down; the surface renders them. Reconnects with a doubling
// backoff so a daemon restart (open --restore) is picked up without a reload.
//
// Beyond the snapshot it keeps the two things the snapshot deliberately does not
// carry: version TEXTS (`version.text` frames, keyed doc@version) and directory
// listings for the path box (`fs.list`, a request answered by path).
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClientMsg,
  DiffPayload,
  FsListEntry,
  GraphPayload,
  MovePlan,
  PublicState,
  SearchReport,
  ServerMsg,
  StructureOpType,
} from "../../backend/protocol";

export type Connection = "connecting" | "open" | "closed";

export const textKey = (doc: string, version: number) => `${doc}@${version}`;

export type Listing = { entries: FsListEntry[]; error?: string };

export type Planning = { plan?: MovePlan; error?: string };

export type Mapping = { graph?: GraphPayload; error?: string };

/** A frontmatter block the human may insert — suggested, never written for them. */
export type Suggestion = { block?: string; suggestedType?: string; error?: string };

/** The last structure op THIS viewer sent that landed — `seq` makes a repeat a new value. */
export type Done = { op: StructureOpType; path: string; seq: number };

export function useDaemon(): {
  state: PublicState | null;
  connection: Connection;
  /** E59: the daemon's last search answer, or null before the first one. */
  search: SearchReport | null;
  lastError: string | null;
  clearError: () => void;
  texts: ReadonlyMap<string, string>;
  /** Record what THIS viewer typed, so its own copy matches the buffer. */
  noteText: (doc: string, version: number, text: string) => void;
  done: Done | null;
  send: (msg: ClientMsg) => void;
  diff: DiffPayload | null;
  listDir: (path: string) => Promise<Listing>;
  planMove: (path: string, into: string) => Promise<Planning>;
  mapOf: (entry: string) => Promise<Mapping>;
  suggestMeta: (path: string) => Promise<Suggestion>;
} {
  const [state, setState] = useState<PublicState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [texts, setTexts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [done, setDone] = useState<Done | null>(null);
  // The latest comparison the daemon computed (E36). Live state rather than a
  // promise: a merge changes the document, and the view must re-read itself.
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  /** E59's last answer. The caller drops it when the query has moved on. */
  const [search, setSearch] = useState<SearchReport | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // One pending listing per path; a later ask for the same path shares the answer.
  const pending = useRef(new Map<string, ((l: Listing) => void)[]>());
  // One pending move plan per from→into pair (E26's confirmation).
  const plans = useRef(new Map<string, ((p: Planning) => void)[]>());
  // One pending map per entry (E33).
  const maps = useRef(new Map<string, ((m: Mapping) => void)[]>());
  // One pending frontmatter suggestion per path (E35).
  const suggestions = useRef(new Map<string, ((s: Suggestion) => void)[]>());

  useEffect(() => {
    let stopped = false;
    let delay = 250;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setConnection("connecting");
      ws.onopen = () => {
        delay = 250;
        setConnection("open");
      };
      ws.onmessage = (ev) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMsg;
        } catch {
          return;
        }
        if (msg.type === "state") setState(msg.state);
        else if (msg.type === "error") setLastError(msg.message);
        else if (msg.type === "version.text") {
          const key = textKey(msg.doc, msg.version);
          setTexts((prev) => {
            if (prev.get(key) === msg.text) return prev;
            const next = new Map(prev);
            next.set(key, msg.text);
            return next;
          });
        } else if (msg.type === "diff") {
          setDiff(msg);
        } else if (msg.type === "search.results") {
          setSearch(msg.report);
        } else if (msg.type === "structure.done") {
          setDone((prev) => ({ op: msg.op, path: msg.path, seq: (prev?.seq ?? 0) + 1 }));
        } else if (msg.type === "move.plan") {
          const key = `${msg.path}\u0000${msg.into}`;
          const waiters = plans.current.get(key);
          plans.current.delete(key);
          for (const w of waiters ?? []) w({ plan: msg.plan, error: msg.error });
        } else if (msg.type === "graph") {
          const waiters = maps.current.get(msg.entry);
          maps.current.delete(msg.entry);
          for (const w of waiters ?? []) w({ graph: msg.graph, error: msg.error });
        } else if (msg.type === "meta.suggestion") {
          const waiters = suggestions.current.get(msg.path);
          suggestions.current.delete(msg.path);
          for (const w of waiters ?? [])
            w({ block: msg.block, suggestedType: msg.suggestedType, error: msg.error });
        } else if (msg.type === "link.target") {
          // A link that left the bundle, or answered nothing: say so. Following
          // one INSIDE the bundle needs no notice — the document just opens.
          if (msg.state === "missing")
            setLastError(`That link points at ${msg.target}, which is not in this set.`);
          else if (msg.state === "outside")
            setLastError(
              `${msg.target} is outside this set. Add its folder to open it here — the file is at ${msg.path}.`,
            );
        } else if (msg.type === "fs.list") {
          const waiters = pending.current.get(msg.path);
          pending.current.delete(msg.path);
          for (const w of waiters ?? []) w({ entries: msg.entries, error: msg.error });
        }
      };
      ws.onclose = () => {
        setConnection("closed");
        // Unanswered listings would otherwise wait forever on a dead socket.
        for (const waiters of pending.current.values())
          for (const w of waiters) w({ entries: [], error: "disconnected" });
        pending.current.clear();
        for (const waiters of plans.current.values())
          for (const w of waiters) w({ error: "disconnected" });
        plans.current.clear();
        for (const waiters of maps.current.values())
          for (const w of waiters) w({ error: "disconnected" });
        maps.current.clear();
        for (const waiters of suggestions.current.values())
          for (const w of waiters) w({ error: "disconnected" });
        suggestions.current.clear();
        if (stopped) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 5000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const listDir = useCallback(
    (path: string) =>
      new Promise<Listing>((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ entries: [], error: "disconnected" });
          return;
        }
        const waiters = pending.current.get(path);
        if (waiters) {
          waiters.push(resolve);
          return;
        }
        pending.current.set(path, [resolve]);
        ws.send(JSON.stringify({ type: "fs.list", path } satisfies ClientMsg));
      }),
    [],
  );

  const planMove = useCallback(
    (path: string, into: string) =>
      new Promise<Planning>((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ error: "disconnected" });
          return;
        }
        const key = `${path}\u0000${into}`;
        const waiters = plans.current.get(key);
        if (waiters) {
          waiters.push(resolve);
          return;
        }
        plans.current.set(key, [resolve]);
        ws.send(JSON.stringify({ type: "move.plan", path, into } satisfies ClientMsg));
      }),
    [],
  );

  const mapOf = useCallback(
    (entry: string) =>
      new Promise<Mapping>((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ error: "disconnected" });
          return;
        }
        const waiters = maps.current.get(entry);
        if (waiters) {
          waiters.push(resolve);
          return;
        }
        maps.current.set(entry, [resolve]);
        ws.send(JSON.stringify({ type: "graph", entry } satisfies ClientMsg));
      }),
    [],
  );

  const suggestMeta = useCallback(
    (path: string) =>
      new Promise<Suggestion>((resolve) => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resolve({ error: "disconnected" });
          return;
        }
        const waiters = suggestions.current.get(path);
        if (waiters) {
          waiters.push(resolve);
          return;
        }
        suggestions.current.set(path, [resolve]);
        ws.send(JSON.stringify({ type: "meta.suggest", path } satisfies ClientMsg));
      }),
    [],
  );

  const noteText = useCallback((doc: string, version: number, text: string) => {
    setTexts((prev) => {
      const key = textKey(doc, version);
      if (prev.get(key) === text) return prev;
      const next = new Map(prev);
      next.set(key, text);
      return next;
    });
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  return {
    state,
    connection,
    search,
    lastError,
    clearError,
    texts,
    noteText,
    done,
    diff,
    send,
    listDir,
    planMove,
    mapOf,
    suggestMeta,
  };
}
