// P1 live-state hook (plan/circe.md P1.3) — owns the full lifecycle: GET
// /state seeds the reducer, WS /events feeds it incrementally, a detected
// gap or a dropped/reconnecting socket falls back to a wholesale refetch.
// This is DOM/network glue (fetch + WebSocket) — it is verified live against
// a real daemon, not unit-tested; the pure pieces it calls (applyEvent,
// isGap) already carry their own tests in reducer.test.ts, following the
// imago fileIntake precedent (pure logic tested, DOM glue verified live).
//
// Round 3 (Claim P1): a projectless store answers every scoped request with
// 409 {error:"needs-project", projects:[...]} — a distinct STATUS here, never
// the error screen (the store isn't broken, it just has no board yet). A 404
// on a NAMED project is likewise its own status (stale stored id / dead
// link — App decides how each source degrades). And the WS is gated on a
// RESOLVED scope: it only opens after a snapshot succeeded, and always with
// the resolved project id — never unscoped against a store whose unscoped
// resolution just failed (the upgrade would be refused; worse, a later-born
// default would attribute this socket to a board nobody picked).

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentActivityState, ProjectMeta, ProjectState, ServerEvent } from "../types";
import { parseActivityState } from "./activity";
import { applyEvent, isGap } from "./reducer";

export type ConnStatus = "connecting" | "open" | "closed";

export function useProjectState(projectId?: string) {
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  // Claim P1 — the two honest non-board answers, each distinct from `error`:
  // needsProject carries the pickable projects straight off the 409 body;
  // notFound means the NAMED scope doesn't exist (App reads the id's source
  // to decide between quiet degrade and honest message).
  const [needsProject, setNeedsProject] = useState<ProjectMeta[] | null>(null);
  const [notFound, setNotFound] = useState(false);
  // Fire-once agent viewport nudge (look.here events) — deliberately NOT
  // part of ProjectState: it's a signal, not state; seq makes repeats on the
  // same node re-fire downstream effects.
  const [lookHere, setLookHere] = useState<{ nodeId: string; seq: number } | null>(null);
  // Same {payload, seq} idiom for the agent's active-attention signal
  // (agent.activity, Claim C) — repeats of the same state must re-fire the
  // consumer's TTL reset.
  // R11 SEAM 2 — `messageId` is daedalus's additive-optional field (which
  // message the state is ABOUT). Read defensively so this hook is correct
  // whether the daemon ships it or not: absent → null → the consumer's
  // latest-human-message fallback (state/messageActivity.ts).
  const [agentActivity, setAgentActivity] = useState<{
    state: AgentActivityState;
    messageId: string | null;
    seq: number;
  } | null>(null);
  const ws = useRef<WebSocket | null>(null);

  // Resolves to the fresh ProjectState on success, null when the store
  // answered with a recognized non-board status (409 needs-project / 404).
  const fetchSnapshot = useCallback((): Promise<ProjectState | null> => {
    const qs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";
    return fetch(`/state${qs}`).then(async (r) => {
      if (r.status === 409) {
        const body = (await r.json().catch(() => null)) as {
          error?: unknown;
          projects?: unknown;
        } | null;
        if (body?.error === "needs-project") {
          setNeedsProject(Array.isArray(body.projects) ? (body.projects as ProjectMeta[]) : []);
          setState(null);
          setError(null);
          return null;
        }
        throw new Error("state 409");
      }
      if (r.status === 404) {
        setNotFound(true);
        setState(null);
        setError(null);
        return null;
      }
      if (!r.ok) throw new Error(`state ${r.status}`);
      const data = (await r.json()) as ProjectState;
      setState(data);
      setError(null);
      setNeedsProject(null);
      setNotFound(false);
      return data;
    });
  }, [projectId]);

  useEffect(() => {
    let stopped = false;
    // A scope change (fetchSnapshot identity) starts a clean slate — the
    // previous scope's refusal must not leak onto the new one.
    setNeedsProject(null);
    setNotFound(false);
    setStatus("connecting");

    // Opens the WS against the RESOLVED scope only — `scope` is the id the
    // snapshot actually came back under (state.project.id), which pins an
    // undefined projectId to the daemon-resolved default explicitly.
    const connect = (scope: string) => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/events?project=${encodeURIComponent(scope)}`;
      let hasOpenedOnce = false;
      const open = () => {
        if (stopped) return;
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
          // Ephemeral kinds surface as signals BUT still fall through to the
          // reducer below — the ephemeral-event cursor clause (Contract 9
          // amendment): the emit consumed a seq, so an early return here
          // would freeze the cursor and turn every subsequent event into a
          // phantom gap → one wholesale /state refetch per fire-once signal
          // (this was a real bug on the look.here path).
          if (event.kind === "look.here") {
            const nodeId = (event.payload as { nodeId?: string })?.nodeId;
            if (nodeId) setLookHere((r) => ({ nodeId, seq: (r?.seq ?? 0) + 1 }));
          } else if (event.kind === "agent.activity") {
            // parseActivityState (state/activity.ts) knows the full R4
            // vocabulary incl. the daemon-synthesized `stalled`; unknown
            // future states drop silently rather than crashing the board.
            const payload = event.payload as { state?: string; messageId?: unknown };
            const s = parseActivityState(payload?.state);
            if (s) {
              const messageId = typeof payload?.messageId === "string" ? payload.messageId : null;
              setAgentActivity((r) => ({ state: s, messageId, seq: (r?.seq ?? 0) + 1 }));
            }
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
            setTimeout(open, 800);
          }
        };
        sock.onerror = () => sock.close();
      };
      open();
    };

    fetchSnapshot()
      .then((data) => {
        // No socket without a board: a needs-project/not-found answer leaves
        // the WS closed until App re-scopes the hook onto a real project.
        if (data && !stopped) connect(data.project.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      stopped = true;
      ws.current?.close();
    };
  }, [fetchSnapshot]);

  return { state, error, status, needsProject, notFound, lookHere, agentActivity };
}
