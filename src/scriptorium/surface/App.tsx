// The surface: three drag-resizable panes (E11 — `resizable`, not `sidebar`),
// the context sidebar on the left (E16 — built first, props-only so it can move
// to the kit), the open document read-only in the centre with the status strip
// under it (E18), and the conversation placeholder on the right (chat is a later
// piece, E16).
import { MessagesSquareIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/ui/resizable";
import type { ChatMessage, ContextEntry, DocView, PublicState } from "../backend/protocol";
import { ContextSidebar } from "./components/context/ContextSidebar";
import { joinPath } from "./components/context/model";
import { DocumentPane } from "./components/DocumentPane";
import { applyTheme, readAppliedTheme, type Theme } from "./state/theme";
import { type Connection, textKey, useDaemon } from "./state/useDaemon";

/** The pane ids are the persisted layout's keys — renaming one forgets a viewer's sizes. */
export const PANES = ["context", "document", "chat"] as const;
export const LAYOUT_ID = "scriptorium:panes";

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "connecting…",
  open: "connected",
  closed: "daemon unreachable — retrying",
};

function PaneHeading({ children }: { children: string }) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-edge px-3 text-xs font-medium tracking-wide text-ink-dim uppercase">
      {children}
    </div>
  );
}

/** The library's storage key, shortened to fit the daemon's pref-key rule. */
const prefKey = (key: string) => key.replace(/^react-resizable-panels:/, "panes:").slice(0, 64);

export function App() {
  const daemon = useDaemon();
  const { state, connection, send } = daemon;
  const [theme, setTheme] = useState<Theme>(readAppliedTheme);

  // ONE global theme, last choice wins (Cole, E21): kept in the HOME's prefs so
  // every session — each on its own port, where browser storage cannot follow —
  // opens in it. The browser copy only lets the pre-paint script avoid a flash.
  const savedTheme = state?.prefs.theme;
  useEffect(() => {
    if ((savedTheme === "dark" || savedTheme === "light") && savedTheme !== readAppliedTheme()) {
      applyTheme(savedTheme);
      setTheme(savedTheme);
    }
  }, [savedTheme]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
    send({ type: "prefs.set", key: "theme", value: next });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-edge bg-surface px-3">
        <span className="font-manuscript text-base text-ink">scriptorium</span>
        {state && (
          <span className="font-mono text-xs text-ink-faint">session {state.sessionId}</span>
        )}
        <span
          data-connection={connection}
          className="ml-auto text-xs text-ink-dim data-[connection=closed]:text-attention"
        >
          {CONNECTION_LABEL[connection]}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </Button>
      </header>
      {state ? (
        <Workspace state={state} daemon={daemon} />
      ) : (
        <div className="flex-1" aria-busy="true" />
      )}
    </div>
  );
}

/**
 * Mounted once the first snapshot has arrived, so the panes' saved sizes (kept
 * in the HOME's prefs, not the browser — every session is a new port and
 * browser storage is keyed by origin) are known before the group lays out.
 */
function Workspace({
  state,
  daemon,
}: {
  state: PublicState;
  daemon: ReturnType<typeof useDaemon>;
}) {
  const { send, texts, listDir, lastError, clearError, done } = daemon;
  const prefsRef = useRef(state.prefs);
  prefsRef.current = state.prefs;
  const storage = useMemo(
    () => ({
      getItem: (key: string) => prefsRef.current[prefKey(key)] ?? null,
      setItem: (key: string, value: string) =>
        send({ type: "prefs.set", key: prefKey(key), value }),
    }),
    [send],
  );
  const layout = useDefaultLayout({ id: LAYOUT_ID, panelIds: [...PANES], storage });

  const open: DocView | null = state.docs.find((d) => d.slug === state.openDoc) ?? null;
  const activeDoc =
    open?.entryId && open.rel !== null ? { entryId: open.entryId, rel: open.rel } : null;
  const text = open ? texts.get(textKey(open.slug, open.active)) : undefined;

  // A snapshot can name an open document whose text this viewer has never
  // received (a reload, a reconnect, the agent activating a version): ask once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!open || text !== undefined) return;
    const key = textKey(open.slug, open.active);
    if (asked.current.has(key)) return;
    asked.current.add(key);
    send({ type: "read", doc: open.slug, version: open.active });
  }, [open, text, send]);

  const onOpenDoc = useCallback(
    (entry: ContextEntry, rel: string) => send({ type: "open", path: joinPath(entry.root, rel) }),
    [send],
  );

  // A new document this viewer made opens at once (and the sidebar puts it in
  // rename mode); a new folder only renames.
  const created = done && (done.op === "doc.create" || done.op === "folder.create") ? done : null;
  useEffect(() => {
    if (created?.op === "doc.create") send({ type: "open", path: created.path });
  }, [created, send]);

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <ResizablePanel
        id="context"
        defaultSize="22"
        minSize="12"
        className="flex flex-col bg-surface"
      >
        <PaneHeading>Context</PaneHeading>
        <ContextSidebar
          entries={state.context}
          activeDoc={activeDoc}
          userHome={state.userHome}
          workspace={state.workspace}
          onOpenDoc={onOpenDoc}
          onAddPath={(path) => send({ type: "context.add", path })}
          onStructure={send}
          onReveal={(path) => send({ type: "reveal", path })}
          listDir={listDir}
          created={created}
          notice={lastError}
          onDismissNotice={clearError}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="document" defaultSize="50" minSize="25" className="flex flex-col bg-bg">
        <DocumentPane doc={open} text={text} />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="chat" defaultSize="28" minSize="15" className="flex flex-col bg-surface">
        <PaneHeading>Conversation</PaneHeading>
        {state.chat.length === 0 ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessagesSquareIcon />
              </EmptyMedia>
              <EmptyTitle>No messages yet</EmptyTitle>
              <EmptyDescription>The conversation with the agent lives here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ActivityLog chat={state.chat} />
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * A READ-ONLY stand-in for the conversation (chat is a later piece, E16): the
 * session's lines, newest last, so what either party did — "Agent moved …",
 * "You created …" (E24) — is visible where the conversation will be.
 */
function ActivityLog({ chat }: { chat: readonly ChatMessage[] }) {
  const end = useRef<HTMLDivElement>(null);
  const last = chat.at(-1)?.id;
  // Scroll when a NEW line arrives, keyed by its id.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last]);
  return (
    <div
      role="log"
      aria-label="Activity"
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-3"
    >
      {chat.slice(-200).map((m) => (
        <div
          key={m.id}
          data-who={m.who}
          className="rounded-md px-2 py-1 text-xs leading-relaxed text-ink-dim data-[who=agent]:bg-surface-raised data-[who=agent]:text-ink data-[who=human]:bg-rubric/10 data-[who=human]:text-ink"
        >
          <span className="mr-1.5 font-medium text-ink-faint">
            {m.who === "system" ? "·" : m.who === "agent" ? "Agent" : "You"}
          </span>
          {m.text}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}
