// The shell's status bar: the connection, the agent's presence, the app's
// status slot and the link check.

import type { ReactNode } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { cn } from "../lib/cn.ts";
import { Dot, QUIET_GROUP } from "../ui/index.ts";
import type { PublicState } from "../workspace/protocol";
import { LinkCheck } from "./LinkCheck.tsx";

const CONNECTION_LABEL = {
  connecting: "connecting…",
  open: "connected",
  closed: "daemon unreachable, retrying",
  ended: "session ended",
} as const;

/** The connection mark's tooltip: what the dot is about, which is this page only. */
const CONNECTION_TITLE = {
  connecting: "This page is connecting to the session",
  open: "This page is connected to the session. Whether an agent is listening shows beside it.",
  closed: "This page cannot reach the session's daemon, and keeps trying",
  ended: "The session has ended",
} as const;

/** The agent's mark: derived by the daemon from the agent's attached tails. */
const PRESENCE = {
  listening: {
    label: "agent listening",
    title: "An agent is following this session's events, so what you send is heard",
  },
  absent: {
    label: "no agent listening",
    title: "No agent is following this session's events, so what you send waits until one does",
  },
} as const;

export function StatusBar({
  daemon,
  state,
  quiet,
  fade,
  agentListening,
  status,
  openAt,
}: {
  daemon: Daemon;
  state: PublicState;
  quiet: boolean;
  fade: string | undefined;
  agentListening: boolean;
  status: ReactNode;
  openAt: (path: string, at?: { from: number; to: number }) => void;
}) {
  return (
    <footer
      data-slot="shell-status"
      className={cn(
        "flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-surface px-3 text-xs text-ink-dim",
        quiet && QUIET_GROUP,
      )}
    >
      {/* Connected is idle and fades; anything else (retrying, ended) is news. */}
      <span
        className={cn("flex shrink-0 items-center gap-1.5", daemon.connection === "open" && fade)}
        title={`${CONNECTION_TITLE[daemon.connection]}\n${state.dir}`}
      >
        <Dot
          tone={
            daemon.connection === "open"
              ? "bg-added"
              : daemon.connection === "closed"
                ? "bg-danger"
                : "bg-attention"
          }
          pulse={daemon.connection === "connecting"}
        />
        {CONNECTION_LABEL[daemon.connection]}
      </span>
      {/* The agent, apart from the page: only while the page can know. Listening
          is idle and fades; nobody listening is news. */}
      {daemon.connection === "open" && (
        <span
          data-slot="agent-presence"
          data-listening={agentListening}
          className={cn("flex shrink-0 items-center gap-1.5", agentListening && fade)}
          title={PRESENCE[agentListening ? "listening" : "absent"].title}
        >
          <Dot tone={agentListening ? "bg-brand" : "bg-ink-faint"} />
          {PRESENCE[agentListening ? "listening" : "absent"].label}
        </span>
      )}
      <div className={cn("flex min-w-0 flex-1 items-center", fade)}>{status}</div>
      {/* The link check: nothing at all while the session's links are sound. */}
      <LinkCheck
        request={daemon.request}
        onFrame={daemon.onFrame}
        connected={daemon.connection === "open"}
        snapshot={state}
        edits={daemon.texts}
        onOpen={openAt}
        className={fade}
      />
    </footer>
  );
}
