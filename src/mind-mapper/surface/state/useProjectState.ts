// P1 live-state hook (plan/circe.md P1.3) — owns the full lifecycle: GET
// /state seeds the reducer, WS /events feeds it incrementally, a detected
// gap or a dropped/reconnecting socket falls back to a wholesale refetch.
// This is DOM/network glue (fetch + WebSocket) — it is verified live against
// a real daemon, not unit-tested; the pure pieces it calls (applyEvent,
// isGap) already carry their own tests in reducer.test.ts, following the
// imago fileIntake precedent (pure logic tested, DOM glue verified live).
//
// The socket path needs daedalus's events.ts + WS /events endpoint to
// actually connect — until that lands this hook degrades to snapshot-only
// (the WS never opens, onclose schedules a reconnect that keeps retrying,
// GET /state still renders a real project). Reusing imago's useSession
// backoff-reconnect shape (surface/state/useSession.ts) rather than
// reinventing it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectState, ServerEvent } from "../types";
import { applyEvent, isGap } from "./reducer";

export type ConnStatus = "connecting" | "open" | "closed";

export function useProjectState(projectId?: string) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  // Fire-once agent viewport nudge (look.here events) — deliberately NOT
  // part of ProjectState: it's a signal, not state; seq makes repeats on the
  // same node re-fire downstream effects.
  const [lookHere, setLookHere] = useState<{ nodeId: string; seq: number } | null>(null);
  const ws = useRef<WebSocket | null>(null);

  const fetchSnapshot = useCallback(() => {
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    return fetch(`/state${qs}`)
      .then((r) => {
        if (!r.ok) throw new Error(`state ${r.status}`);
        return r.json() as Promise<ProjectState>;
      })
      .then((data) => {
        setState(data);
        setError(null);
        return data;
      });
  }, [projectId]);

  useEffect(() => {
    let stopped = false;

    fetchSnapshot().catch((e) => setError(e instanceof Error ? e.message : String(e)));

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    const url = `${proto}//${location.host}/events${qs}`;

    let hasOpenedOnce = false;
    const connect = () => {
      const sock = new WebSocket(url);
      ws.current = sock;
      setStatus("connecting");
      sock.onopen = () => {
        setStatus("open");
        // A RE-open means the daemon may have restarted: events restart at
        // seq 1 under a new epoch, and our stale cursor would swallow them
        // as already-applied (reducer's seq <= cursor dedupe) without ever
        // tripping isGap. Refetch the snapshot to adopt the new epoch's
        // cursor. Skipped on the first open — mount already fetched.
        if (hasOpenedOnce) {
          fetchSnapshot().catch((err) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
        }
        hasOpenedOnce = true;
      };
      sock.onmessage = (e) => {
        const event = JSON.parse(e.data) as ServerEvent;
        if (event.kind === "look.here") {
          const nodeId = (event.payload as { nodeId?: string })?.nodeId;
          if (nodeId) setLookHere((r) => ({ nodeId, seq: (r?.seq ?? 0) + 1 }));
          return; // never touches ProjectState
        }
        setState((prev) => {
          // Snapshot hasn't landed yet — safe to drop: the pending
          // fetchSnapshot() resolves to current state, which already
          // includes whatever this event described.
          if (!prev) return prev;
          if (isGap(prev.cursor, event.seq)) {
            fetchSnapshot().catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            );
            return prev;
          }
          return applyEvent(prev, event);
        });
        // node.ratified/edge.ratified only tell us WHICH proposal resolved
        // (ratify.ts's payload is {id, proposalId}, never the full entity) —
        // the reducer above already cleared it out of "pending" so the
        // review badge/overlay update immediately, but the actual new
        // node/edge only exists via a fresh snapshot (t-bdd3136e: this half
        // was missing entirely, so a live-ratified entity never appeared —
        // and the reload "fix" only looked like it worked because reload
        // re-triggers this same fetchSnapshot from scratch).
        if (event.kind === "node.ratified" || event.kind === "edge.ratified") {
          fetchSnapshot().catch((err) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
        }
      };
      sock.onclose = (ev) => {
        setStatus("closed");
        if (!stopped && ev.code !== 1000 && ev.code !== 1001) {
          setTimeout(connect, 800);
        }
      };
      sock.onerror = () => sock.close();
    };
    connect();

    return () => {
      stopped = true;
      ws.current?.close();
    };
    // projectId is redundant with fetchSnapshot (which already changes
    // identity when projectId changes) — listed explicitly because this
    // effect's own body also reads projectId directly for the WS query string.
  }, [fetchSnapshot, projectId]);

  return { state, error, status, lookHere };
}
