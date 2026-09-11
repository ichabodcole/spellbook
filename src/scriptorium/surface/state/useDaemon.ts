// The surface's ONE connection to the daemon: a WebSocket at /ws. State
// snapshots come down; the surface renders them. Reconnects with a doubling
// backoff so a daemon restart (open --restore) is picked up without a reload.
//
// Slice A's surface is the empty layout (E16 and the lead's split): this hook
// is the wiring the context sidebar and the editor will read, and `send` is
// the up-channel they will use (protocol.ts `ClientMsg`).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMsg, PublicState, ServerMsg } from "../../backend/protocol";

export type Connection = "connecting" | "open" | "closed";

export function useDaemon(): {
  state: PublicState | null;
  connection: Connection;
  lastError: string | null;
  send: (msg: ClientMsg) => void;
} {
  const [state, setState] = useState<PublicState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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
      };
      ws.onclose = () => {
        setConnection("closed");
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

  return { state, connection, lastError, send };
}
