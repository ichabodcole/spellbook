// The one hook that touches things: the socket, the two timers, and the
// browser's localStorage. Everything it decides is decided by a pure function
// in a sibling module; what is left here is wiring, and that is deliberate —
// R2's rule is that a module either touches nothing (and is tested) or touches
// one thing (and is not).
//
// ⚠ THE SOCKET IS THE WHOLE WIRE. The board makes no fetch() calls at all.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyAdd,
  applyInit,
  applyRemove,
  applyUpdate,
  type BoardSnapshot,
  isSessionEnd,
  randId,
} from "./board";
import { type Filters, loadFilters, NO_FILTERS, persistFilters, toggleFacet } from "./filters";
import {
  AGE_TICK_MS,
  type ClientFrame,
  type ConnState,
  RECONNECT_MS,
  type ServerFrame,
  type Task,
  type TaskStatus,
  TOAST_MS,
  type Toast,
} from "./types";

/** The daemon serves this page from its own origin and listens for the socket
 *  on the same one. The old page had the URL substituted into its markup; a
 *  built, static index.html cannot be substituted into, and the value is
 *  derivable, so it is derived. */
function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const EMPTY: BoardSnapshot = {
  title: "",
  tasks: [],
  restoreFailed: null,
  sessionId: "",
};

export type Board = {
  title: string;
  tasks: Task[];
  restoreFailed: BoardSnapshot["restoreFailed"];
  sessionId: string;
  conn: ConnState;
  statusText: string;
  ended: boolean;
  toasts: Toast[];
  now: number;
  filters: Filters;
  toggleTag: (tag: string) => void;
  toggleOwner: (owner: string) => void;
  clearFilters: () => void;
  addTask: (status: TaskStatus, title: string) => void;
  toggleStatus: (task: Task, status: TaskStatus) => void;
  editTitle: (task: Task, title: string) => void;
  editNotes: (id: string, notes: string) => void;
  removeTask: (id: string) => void;
  moveTask: (id: string, status: TaskStatus, index: number) => void;
  closeBoard: () => void;
};

export function useBoard(): Board {
  const [board, setBoard] = useState<BoardSnapshot>(EMPTY);
  const [conn, setConn] = useState<ConnState>("");
  const [ended, setEnded] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  const socketRef = useRef<WebSocket | null>(null);
  const closedByServer = useRef(false);
  const toastSeq = useRef(0);

  // surface-filter: restore the human's filters from a prior reload, before
  // the first paint that could show an unfiltered board.
  useEffect(() => {
    setFilters(loadFilters(safeStorage()));
  }, []);

  // Card-aging: advance `now` so the stale dim and the age cue update live
  // without a user action. Cheap — one assignment.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const toast = useCallback((text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  // The socket, and its own reconnect loop. Mounted once; `connect` re-enters
  // itself on close unless the server ended the session.
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      setConn("");
      const socket = new WebSocket(wsUrl());
      socketRef.current = socket;

      socket.onopen = () => setConn("connected");
      socket.onclose = () => {
        setConn("closed");
        if (!closedByServer.current && !disposed) retry = setTimeout(connect, RECONNECT_MS);
      };
      // The error itself is never shown; it surfaces via the close above.
      socket.onerror = () => {};
      socket.onmessage = (ev: MessageEvent<string>) => {
        let msg: ServerFrame;
        try {
          msg = JSON.parse(ev.data) as ServerFrame;
        } catch {
          return; // a malformed frame is dropped; the board keeps running
        }
        if (msg.type === "init") {
          setBoard((prev) => applyInit(prev, msg));
          if (msg.title) document.title = msg.title;
        } else if (msg.type === "task.add") {
          setBoard((prev) => {
            const tasks = applyAdd(prev.tasks, msg.task);
            return tasks === prev.tasks ? prev : { ...prev, tasks };
          });
        } else if (msg.type === "task.update") {
          setBoard((prev) => {
            const tasks = applyUpdate(prev.tasks, msg.id, msg.patch);
            return tasks === prev.tasks ? prev : { ...prev, tasks };
          });
        } else if (msg.type === "task.remove") {
          setBoard((prev) => {
            const tasks = applyRemove(prev.tasks, msg.id);
            return tasks === prev.tasks ? prev : { ...prev, tasks };
          });
        } else if (msg.type === "message") {
          // The uniform session-end signal: a "session ended: <reason>" toast
          // precedes the socket close (any reason — user dismiss, idle timeout,
          // agent close).
          toast(msg.text);
          if (isSessionEnd(msg.text)) {
            closedByServer.current = true;
            setEnded(true);
          }
        }
        // Any other type is ignored.
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [toast]);

  /** Outgoing. A silent no-op unless the socket is OPEN — an action taken
   *  during a reconnect gap is DROPPED, never queued (inventory W13). */
  const send = useCallback((msg: ClientFrame) => {
    const s = socketRef.current;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    s.send(JSON.stringify(msg));
  }, []);

  const writeFilters = useCallback((next: Filters) => {
    setFilters(next);
    persistFilters(safeStorage(), next);
  }, []);

  return {
    title: board.title,
    tasks: board.tasks,
    restoreFailed: board.restoreFailed,
    sessionId: board.sessionId,
    conn,
    statusText: conn === "connected" ? "connected" : conn === "closed" ? "closed" : "connecting…",
    ended,
    toasts,
    now,
    filters,

    toggleTag: (tag) => writeFilters({ ...filters, tags: toggleFacet(filters.tags, tag) }),
    toggleOwner: (owner) =>
      writeFilters({ ...filters, owners: toggleFacet(filters.owners, owner) }),
    clearFilters: () => writeFilters(NO_FILTERS),

    addTask: (status, title) => {
      const trimmed = title.trim();
      if (!trimmed) return; // silent — an empty draft sends nothing
      send({ type: "task.add", task: { id: randId(), title: trimmed, status } });
    },
    toggleStatus: (task, status) => {
      if (task.status === status) return; // a redundant pill click sends nothing
      send({ type: "task.toggle", id: task.id, status });
    },
    editTitle: (task, title) => {
      const next = title.trim();
      // An empty title is REVERTED by the caller and never sent: the daemon
      // rejects it and the visible text would otherwise diverge from canonical
      // state. An unchanged title sends nothing either.
      if (next === "" || next === task.title) return;
      send({ type: "task.edit", id: task.id, title: next });
    },
    editNotes: (id, notes) => send({ type: "task.edit", id, notes }),
    removeTask: (id) => send({ type: "task.remove", id }),
    moveTask: (id, status, index) => send({ type: "task.move", id, status, index }),
    closeBoard: () => send({ type: "close" }),
  };
}
