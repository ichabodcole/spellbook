// P1 — a tiny in-process event bus. Events are derived-from-state and
// replayable via snapshot (Claim A/B: no event-log table in V1), so the
// buffer here is a bounded in-memory replay window for reconnects within one
// daemon process's lifetime, not a durable log — a restart resets to cursor
// 0, which is honest (nothing ratified is lost; only the resume-point for
// events already ephemeral by design). One emit() fans out to both the
// browser's WS and the agent's SSE-shaped `tail` — same bus, two transports
// (daedalus's WS-vs-SSE ruling, vine msg 6).

const REPLAY_BUFFER_SIZE = 1000;

type EventKind =
  | "doc.added"
  | "node.ratified"
  | "edge.ratified"
  | "proposal.added"
  | "message.posted"
  | "lens.set";

interface BusEvent {
  seq: number;
  epoch: string;
  kind: EventKind;
  payload: Record<string, unknown>;
}

type Listener = (event: BusEvent) => void;

interface EventBus {
  emit(kind: EventKind, payload: Record<string, unknown>): BusEvent;
  subscribe(since: number, listener: Listener): () => void;
  cursor(): number;
  epoch: string;
}

// A fresh random epoch per bus instance (i.e. per daemon boot) — since seq
// resets to 0 on restart (no durable event log, Claim A/B), a resuming
// `tail --since <n>` client can't tell a stale watermark from a fresh one by
// seq alone. Comparing epoch makes that detectable: a different epoch means
// "this cursor is from a prior process, resnapshot instead of trusting it"
// (cassandra's P2 gate finding — tail-resume-across-restart was previously
// silent about this).
function createEventBus(): EventBus {
  let seq = 0;
  const epoch = crypto.randomUUID();
  const buffer: BusEvent[] = [];
  const listeners = new Set<Listener>();

  return {
    epoch,
    emit(kind, payload) {
      seq += 1;
      const event: BusEvent = { seq, epoch, kind, payload };
      buffer.push(event);
      if (buffer.length > REPLAY_BUFFER_SIZE) buffer.shift();
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(since, listener) {
      for (const event of buffer) {
        if (event.seq > since) listener(event);
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cursor() {
      return seq;
    },
  };
}

export type { BusEvent, EventBus, EventKind };
export { createEventBus };
