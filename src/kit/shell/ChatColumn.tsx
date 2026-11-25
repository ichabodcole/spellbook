// The shell's conversation column: its rail while collapsed, and its tabs
// (Chat, Notes, Tasks and an app's own) with the active one's panel.

import { MessageSquareIcon, PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { WaitingDot } from "../chat/WaitingBadge.tsx";
import { cn } from "../lib/cn.ts";
import { ResizablePanel } from "../ui/index.ts";
import { ColumnButton, FLOAT_INPUT, Rail } from "./ColumnChrome.tsx";
import { type Collapsed, DEFAULT_SIZE, MIN_SIZE, RAIL_PX, type Side } from "./columns.ts";
import type { waitingOnAgent } from "./rail.ts";

/** A tab of the conversation column. */
type ColumnTab = { id: string; label: ReactNode; node: ReactNode };

export function ChatColumn({
  chatPanel,
  collapsed,
  quiet,
  fade,
  floatIcon,
  chatUnseen,
  composerWaiting,
  setFloatClosed,
  focusNext,
  setPanelId,
  toggleFrom,
  tabs,
  activePanel,
  storageKey,
}: {
  chatPanel: RefObject<PanelImperativeHandle | null>;
  collapsed: Collapsed;
  quiet: boolean;
  fade: string | undefined;
  floatIcon: boolean;
  chatUnseen: boolean;
  composerWaiting: ReturnType<typeof waitingOnAgent>;
  setFloatClosed: (closed: boolean) => void;
  focusNext: { current: string | null };
  setPanelId: (id: string) => void;
  toggleFrom: (side: Side, act: "collapse" | "expand", then?: string) => void;
  tabs: ColumnTab[];
  activePanel: ColumnTab;
  storageKey: string;
}) {
  return (
    <ResizablePanel
      id="chat"
      panelRef={chatPanel}
      collapsible
      defaultSize={`${DEFAULT_SIZE.chat}`}
      minSize={`${MIN_SIZE.chat}`}
      collapsedSize={`${RAIL_PX}px`}
      className="flex flex-col bg-surface"
    >
      {collapsed.chat && (
        <Rail
          quiet={quiet}
          below={
            (floatIcon || chatUnseen) && (
              <div className="flex flex-col items-center">
                {/* The float closed: this brings it back. Idle, so it fades. */}
                {floatIcon && (
                  <span className="relative flex">
                    <ColumnButton
                      label={
                        composerWaiting
                          ? `Show the composer (${composerWaiting.label})`
                          : "Show the composer"
                      }
                      control="chat-float-show"
                      onClick={() => {
                        setFloatClosed(false);
                        focusNext.current = FLOAT_INPUT;
                      }}
                      className={fade}
                    >
                      <MessageSquareIcon aria-hidden />
                    </ColumnButton>
                    {/* E53's waiting mark, which the closed float would
                    otherwise take with it: on the composer's own button,
                    since an answer lands in the composer's line. Its words
                    are the button's name; it never fades, as a stuck wait
                    asks for attention. Not the unseen mark below: that one
                    is the agent's news, this one the human's question. */}
                    {composerWaiting && (
                      <span
                        aria-hidden
                        data-slot="chat-rail-waiting"
                        className="pointer-events-none absolute top-0.5 right-0.5 flex"
                      >
                        <WaitingDot badge={composerWaiting.badge} label={composerWaiting.label} />
                      </span>
                    )}
                    {/* The mark's words, read out when they change: the
                    open float's badge is a live region, and closing it
                    must not make a wait going quiet ("may be stuck")
                    silent. Polite, as that badge is. Here only while the
                    float is closed, so the two never speak at once; it
                    stays while nothing waits, so the next wait is a
                    change it can announce. */}
                    <span
                      aria-live="polite"
                      aria-atomic="true"
                      data-slot="chat-rail-waiting-live"
                      className="sr-only"
                    >
                      {composerWaiting?.label ?? ""}
                    </span>
                  </span>
                )}
                {/* Asks for attention, so it never fades with the rail. A button
                of its own: the 8 px dot sits centred in a 24 px target, which
                also puts it under the reopen row. A press opens the
                conversation on the Chat tab, where the new message is. */}
                {chatUnseen && (
                  <button
                    type="button"
                    data-slot="chat-unseen"
                    aria-label="Open the conversation: the agent has said something new"
                    title="Open the conversation: the agent has said something new"
                    onClick={() => {
                      setPanelId("chat");
                      toggleFrom("chat", "expand");
                    }}
                    className="flex size-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span aria-hidden className="size-2 rounded-full bg-attention" />
                  </button>
                )}
              </div>
            )
          }
        >
          <ColumnButton
            label={
              chatUnseen
                ? "Reopen the conversation column: the agent has said something new"
                : "Reopen the conversation column"
            }
            control="chat-reopen"
            onClick={() => toggleFrom("chat", "expand")}
            className={fade}
          >
            <PanelRightOpenIcon aria-hidden />
          </ColumnButton>
        </Rail>
      )}
      <div
        data-pane="chat"
        tabIndex={-1}
        inert={collapsed.chat}
        hidden={collapsed.chat}
        className={cn("min-h-0 flex-1 flex-col outline-none", collapsed.chat ? "hidden" : "flex")}
      >
        {/* The collapse button is pinned; the tabs give way. */}
        <div className="flex min-h-9 shrink-0 items-center gap-0.5 border-b border-edge px-2 py-1">
          <div
            role="tablist"
            aria-label="Conversation column"
            className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 overflow-hidden"
            onKeyDown={(e) => {
              // Arrow keys move between tabs, the tablist pattern.
              const i = tabs.findIndex((t) => t.id === activePanel.id);
              const to =
                e.key === "ArrowRight"
                  ? tabs[(i + 1) % tabs.length]
                  : e.key === "ArrowLeft"
                    ? tabs[(i - 1 + tabs.length) % tabs.length]
                    : e.key === "Home"
                      ? tabs[0]
                      : e.key === "End"
                        ? tabs.at(-1)
                        : undefined;
              if (!to) return;
              e.preventDefault();
              setPanelId(to.id);
              requestAnimationFrame(() =>
                document.getElementById(`${storageKey}-tab-${to.id}`)?.focus(),
              );
            }}
          >
            {tabs.map((p) => (
              <button
                key={p.id}
                id={`${storageKey}-tab-${p.id}`}
                type="button"
                role="tab"
                aria-selected={activePanel.id === p.id}
                aria-controls={`${storageKey}-tabpanel`}
                tabIndex={activePanel.id === p.id ? 0 : -1}
                onClick={() => setPanelId(p.id)}
                className={cn(
                  "rounded-sm px-2 py-1 text-xs font-medium tracking-wide uppercase",
                  "text-ink-dim hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                  activePanel.id === p.id && "bg-surface-raised text-ink",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="shrink-0">
            <ColumnButton
              label="Collapse the conversation column"
              control="chat-collapse"
              onClick={() => toggleFrom("chat", "collapse")}
            >
              <PanelRightCloseIcon aria-hidden />
            </ColumnButton>
          </div>
        </div>
        <div
          id={`${storageKey}-tabpanel`}
          role="tabpanel"
          aria-labelledby={`${storageKey}-tab-${activePanel.id}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          {activePanel.node}
        </div>
      </div>
    </ResizablePanel>
  );
}
