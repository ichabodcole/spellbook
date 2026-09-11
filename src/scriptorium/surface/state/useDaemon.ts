// The surface's ONE connection to the daemon: a WebSocket at /ws. State
// snapshots come down; the surface renders them. Reconnects with a doubling
// backoff so a daemon restart (open --restore) is picked up without a reload.
//
// Beyond the snapshot it keeps the two things the snapshot deliberately does not
// carry: version TEXTS (`version.text` frames, keyed doc@version) and directory
// listings for the path box (`fs.list`, a request answered by path).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMsg, FsListEntry, PublicState, ServerMsg } from "../../backend/protocol";

export type Connection = "connecting" | "open" | "closed";

export const textKey = (doc: string, version: number) => `${doc}@${version}`;

export type Listing = { entries: FsListEntry[]; error?: string };

export function useDaemon(): {
  state: PublicState | null;
  connection: Connection;
  lastError: string | null;
  texts: ReadonlyMap<string, string>;
  send: (msg: ClientMsg) => void;
  listDir: (path: string) => Promise<Listing>;
} {
  const [state, setState] = useState<PublicState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const [texts, setTexts] = useState<ReadonlyMap<string, string>>(() => new Map());
  const wsRef = useRef<WebSocket | null>(null);
  // One pending listing per path; a later ask for the same path shares the answer.
  const pending = useRef(new Map<string, ((l: Listing) => void)[]>());

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

  return { state, connection, lastError, texts, send, listDir };
}
