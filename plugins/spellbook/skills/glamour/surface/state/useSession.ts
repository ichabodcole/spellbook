import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientToServer, GlamourState, ServerToClient } from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

export function useSession() {
  const [state, setState] = useState<GlamourState | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const url = `ws://${location.host}/ws`;
    let stop = false;
    const connect = () => {
      const sock = new WebSocket(url);
      ws.current = sock;
      sock.onopen = () => setStatus("open");
      sock.onclose = () => {
        setStatus("closed");
        if (!stop) setTimeout(connect, 800);
      };
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as ServerToClient;
        if (msg.type === "state") setState(msg.state);
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

  return { state, send, status };
}
