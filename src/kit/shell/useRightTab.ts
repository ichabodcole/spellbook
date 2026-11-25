// THE RIGHT COLUMN'S CHOSEN TAB: which of the column's tabs is shown, kept in
// the shell's storage so a reload keeps it, and the way to the chat tab that
// the pane keys call. A hook of `ShellBody`'s, called where this section sat
// in it, right after the tabs are built, so the hooks keep their order.

import type { ReactNode, RefObject } from "react";
import { useState } from "react";
import type { ShellStorage } from "./storage.ts";

export function useRightTab({
  storage,
  tabs,
  showChatTab,
}: {
  storage: ShellStorage;
  tabs: { id: string; label: ReactNode; node: ReactNode }[];
  showChatTab: RefObject<() => void>;
}) {
  const TAB_KEY = "tab";
  const [panelId, setPanelIdState] = useState<string | null>(() => storage.getItem(TAB_KEY));
  const setPanelId = (id: string) => {
    setPanelIdState(id);
    storage.setItem(TAB_KEY, id);
  };
  const activePanel = (tabs.find((p) => p.id === panelId) ?? tabs[0]) as (typeof tabs)[number];
  showChatTab.current = () => setPanelId("chat");
  return { setPanelId, activePanel };
}
