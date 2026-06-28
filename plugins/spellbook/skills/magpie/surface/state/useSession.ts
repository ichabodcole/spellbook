import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientToServer, MagpieState, ServerToClient } from "./types";

export type ConnStatus = "connecting" | "open" | "closed";

// WebSocket session hook → { state, send }. Full-state push from the daemon on
// every change; reconnects on unexpected drops, never after a clean/ended close.
export function useSession() {
  const [state, setState] = useState<MagpieState | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [agentPresent, setAgentPresent] = useState(false); // an agent tailing /events?
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
        else if (msg.type === "presence") setAgentPresent(msg.agent);
        else if (msg.type === "submit" || msg.type === "cancel") {
          ended = true;
          setEnded(true);
          setStatus("closed");
          sock.close();
        } else if (msg.type === "message") {
          console.info("[magpie]", msg.text);
        }
      };
      sock.onclose = (ev) => {
        setStatus("closed");
        setAgentPresent(false); // socket down → agent presence unknown
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

  return { state, send, status, agentPresent, ended };
}
