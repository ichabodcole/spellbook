// THE SHELL'S PANE KEYS: focusing a pane or the composer, and the window's keys
// that move between the panes (Cmd/Ctrl+1, 2, 3), collapse and reopen the side
// columns (Cmd/Ctrl+[ and ]) and return to the centre on Escape. A hook of
// `ShellBody`'s, called where this section sat in it, so the hooks keep their
// order.

import { useCallback, useEffect, useRef } from "react";
import type { PaneName } from "../context/workspace.ts";
import { COLUMN_INPUT, FLOAT_INPUT } from "./ColumnChrome.tsx";
import type { Collapsed, Side } from "./columns.ts";

export function usePaneKeys({
  collapsed,
  collapse,
  expand,
  toggleFrom,
  floating,
  floatClosed,
}: {
  collapsed: Collapsed;
  collapse: (side: Side) => boolean;
  expand: (side: Side) => boolean;
  toggleFrom: (side: Side, act: "collapse" | "expand", then?: string) => void;
  floating: boolean;
  floatClosed: boolean;
}) {
  const focusPane = useCallback(
    (pane: PaneName) => {
      if (pane === "context" && collapsed.context) expand("context");
      if (pane === "chat" && collapsed.chat) expand("chat");
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus(),
      );
    },
    [collapsed.context, collapsed.chat, expand],
  );
  /** Brings the chat tab forward; set below, where the tabs are. */
  const showChatTab = useRef<() => void>(() => {});
  const focusComposer = useCallback(() => {
    // Talking to the agent never needs the column: a float on screen takes it.
    if (floating) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(FLOAT_INPUT)?.focus());
      return;
    }
    if (collapsed.chat) expand("chat");
    showChatTab.current();
    // Twice: once for the column to open, once for the tab to draw its composer.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('[data-pane="chat"] [data-slot="composer-input"]')
          ?.focus(),
      ),
    );
  }, [collapsed.chat, expand, floating]);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey) {
        const pane = ({ "1": "context", "2": "centre", "3": "chat" } as const)[
          e.key as "1" | "2" | "3"
        ];
        if (pane) {
          e.preventDefault();
          focusPane(pane);
          return;
        }
        if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const side: Side = e.key === "[" ? "context" : "chat";
          // Where focus is on the control that goes away (inside the column being
          // collapsed, or on the rail being reopened) it is handed on, as the
          // buttons do; from anywhere else focus stays where it is.
          const holds = document.activeElement?.closest(
            collapsed[side]
              ? `[data-column-control="${side}-reopen"]${side === "chat" ? ", [data-slot=chat-unseen]" : ""}`
              : `[data-pane="${side}"]`,
          );
          const act = collapsed[side] ? "expand" : "collapse";
          // From the floating composer, the column's composer is where typing goes on.
          const inFloat =
            side === "chat" && document.activeElement?.closest('[data-slot="floating-composer"]');
          // From the column's composer, typing goes on in the float. (An open
          // column always clears a closed float, so the float will show; the
          // guard only keeps the hand-off honest if that ever changes.)
          const inColumnInput = side === "chat" && document.activeElement?.closest(COLUMN_INPUT);
          if (inFloat && act === "expand") toggleFrom(side, act, COLUMN_INPUT);
          else if (inColumnInput && act === "collapse" && !floatClosed)
            toggleFrom(side, act, FLOAT_INPUT);
          else if (holds) toggleFrom(side, act);
          else if (act === "expand") expand(side);
          else collapse(side);
          return;
        }
      }
      // Escape from inside a sidebar, with nothing open to close, returns to the
      // centre. Dialogs, menus and tooltips close on Escape themselves (and stop
      // the event), so this only sees an Escape nobody else took.
      if (e.key === "Escape" && !e.defaultPrevented && !mod) {
        const t = e.target as HTMLElement | null;
        const typing = t?.matches?.("input, textarea, select, [contenteditable='true']");
        const inSide = t?.closest?.('[data-pane="context"], [data-pane="chat"]');
        const popup = document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]',
        );
        if (inSide && !typing && !popup && root.contains(t)) focusPane("centre");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, collapse, expand, focusPane, toggleFrom, floatClosed]);

  return { focusPane, showChatTab, focusComposer, rootRef };
}
