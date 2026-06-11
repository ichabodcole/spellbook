import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientToServer, GlamourState, ServerToClient } from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

export function useSession() {
  const [state, setState] = useState<GlamourState | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [ended, setEnded] = useState(false);
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    let stop = false;
    let ended = false; // session ended (submit/cancel/normal close) — do not reconnect
    const connect = () => {
      const sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => setStatus("open");
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerToClient;
        if (msg.type === "state") setState(msg.state);
        else if (msg.type === "submit" || msg.type === "cancel") {
          ended = true;
          setEnded(true);
          setStatus("closed");
          sock.close();
        } else if (msg.type === "message") {
          console.info("[glamour]", msg.text);
        }
      };
      sock.onclose = (ev) => {
        setStatus("closed");
        // Reconnect only on unexpected drops, never after a clean/ended close.
        if (!stop && !ended && ev.code !== 1000 && ev.code !== 1001) {
          setTimeout(connect, 800);
        }
      };
    };
    connect();
    return () => {
      stop = true;
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientToServer) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  return { state, send, status, ended };
}
