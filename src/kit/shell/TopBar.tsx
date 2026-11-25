// The shell's top bar: the app's title, the session id, search, End session,
// Settings and the theme.

import { MoonIcon, PowerIcon, SettingsIcon, SunIcon } from "lucide-react";
import type { Ref } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { cn } from "../lib/cn.ts";
import type { Theme } from "../theme/mode.ts";
import { QUIET_GROUP } from "../ui/index.ts";
import type { PublicState, SearchResult } from "../workspace/protocol";
import { ColumnButton } from "./ColumnChrome.tsx";
import { SearchBox } from "./SearchBox.tsx";
import { EndedChip, type EndPhase } from "./SessionEnd.tsx";

/** Why End session and Settings are off while the daemon is not answering. */
export const NOT_CONNECTED_REASON =
  "Not connected to the workspace daemon: this waits until it answers again";

export function TopBar({
  daemon,
  state,
  quiet,
  fade,
  sessionLabel,
  openResult,
  ended,
  restoreCommand,
  chipRef,
  setEndPhase,
  setSettingsOpen,
  theme,
  setTheme,
}: {
  daemon: Daemon;
  state: PublicState;
  quiet: boolean;
  fade: string | undefined;
  sessionLabel: string;
  openResult: (r: SearchResult) => void;
  ended: boolean;
  restoreCommand: string;
  chipRef: Ref<HTMLButtonElement>;
  setEndPhase: (phase: EndPhase) => void;
  setSettingsOpen: (open: boolean) => void;
  theme: Theme;
  setTheme: (next: Theme) => void;
}) {
  return (
    <>
      {/* THE TOP BAR, across the window: which app and which session, search over
          every document in the session, and what acts on the session itself.
          Three columns, the outer two equal while their content fits, so search
          is centred against the WINDOW rather than drifting with the title's
          length. Search gives way as the window narrows, down to its icon, and
          the session id is dropped before anything clips. Quieter in reader
          mode, like the rest of the chrome. */}
      <header
        data-slot="shell-top-bar"
        className={cn(
          "@container grid h-10 shrink-0 grid-cols-[minmax(max-content,1fr)_minmax(0,2fr)_minmax(max-content,1fr)] items-center gap-3 border-b bg-surface px-3",
          quiet ? `${QUIET_GROUP} border-transparent` : "border-edge",
        )}
      >
        <div className="flex min-w-0 items-baseline gap-2">
          {/* The id hides on a narrow bar, so the title carries it as a tooltip. */}
          <span
            data-slot="app-title"
            title={sessionLabel}
            className={cn("text-sm font-medium text-ink", fade)}
          >
            {state.appTitle ?? state.app}
          </span>
          {/* Ended is news, so it is never faded, like the status bar's mark. */}
          <span
            data-slot="session-id"
            className={cn(
              "hidden font-mono text-xs @[34rem]:inline",
              daemon.connection === "ended" ? "text-ink-dim" : "text-ink-faint",
              daemon.connection !== "ended" && fade,
            )}
          >
            {sessionLabel}
          </span>
        </div>
        <div className="flex min-w-0 justify-center">
          <SearchBox
            request={daemon.request}
            connected={daemon.connection === "open"}
            onOpen={openResult}
            className={fade}
          />
        </div>
        <div className="flex items-center justify-end gap-1">
          {ended ? (
            <EndedChip command={restoreCommand} by={daemon.endedBy} chipRef={chipRef} />
          ) : (
            <ColumnButton
              label="End session"
              control="end-session"
              onClick={() => setEndPhase("confirm")}
              disabled={daemon.connection !== "open"}
              disabledReason={NOT_CONNECTED_REASON}
              className={fade}
            >
              <PowerIcon aria-hidden />
            </ColumnButton>
          )}
          <ColumnButton
            label="Settings"
            control="settings"
            onClick={() => setSettingsOpen(true)}
            disabled={daemon.connection !== "open"}
            disabledReason={NOT_CONNECTED_REASON}
            className={fade}
          >
            <SettingsIcon aria-hidden />
          </ColumnButton>
          <ColumnButton
            label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className={fade}
          >
            {theme === "dark" ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
          </ColumnButton>
        </div>
      </header>
    </>
  );
}
