import { useEffect, useRef, useState } from "react";
import type { ClientToServer, GlamourState, ServerToClient } from "./types";

export function useSession() {
  const [state, setState] = useState<GlamourState | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as ServerToClient;
        if (msg.type === "state") setState(msg.state);
      } catch (err) {
        console.error("glamour: malformed ws frame", err);
      }
    };
    return () => ws.close();
  }, []);

  const send = (m: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  return { state, send };
}
