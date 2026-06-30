import { useEffect, useRef, useState } from "react";
import type { ClientToServer, ObservatoryView, ServerToClient } from "../../scripts/state";

// The browser's live link to the daemon. astrolabe pushes the full projected
// board ({type:"state"}) over WS on connect and on every change, so the surface
// just replaces local state wholesale — no client-side reducer. Same-origin WS
// (ws://${location.host}/ws), derived here, so the surface needs no injected
// config. Auto-reconnects (the daemon is a standing singleton the board may
// outlive a restart of).
export function useSession() {
  const [state, setState] = useState<ObservatoryView | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerToClient;
          if (msg.type === "state") setState({ title: msg.title, projects: msg.projects });
        } catch (err) {
          console.error("astrolabe: malformed ws frame", err);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!disposed) setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      disposed = true;
      ws?.close();
    };
  }, []);

  // Human → daemon over WS (poke / close). Project registration is a POST /cmd
  // (see AddProjectModal), matching the daemon's write paths.
  const send = (m: ClientToServer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  };

  return { state, connected, send };
}
