// The surface shell — three drag-resizable panes (E11's layout ruling:
// `resizable`, not `sidebar`), their sizes remembered per viewer, and both
// themes. Slice A stops here on the surface (E16, and the lead's split): the
// panes are PLACEHOLDERS wired to the daemon's live state, so the context
// sidebar and the read-only viewer that land next have a shell, a connection
// and a state snapshot to render — and nothing to rip out.
import { FileTextIcon, FolderTreeIcon, MessagesSquareIcon, MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/ui/resizable";
import { PLACEHOLDER_SEGMENTS, StatusStrip } from "./components/StatusStrip";
import { safeStorage } from "./state/storage";
import { applyTheme, readAppliedTheme, type Theme } from "./state/theme";
import { type Connection, useDaemon } from "./state/useDaemon";

/** The pane ids are the persisted layout's keys — renaming one forgets a viewer's sizes. */
export const PANES = ["context", "document", "chat"] as const;
export const LAYOUT_ID = "scriptorium:panes";

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "connecting…",
  open: "connected",
  closed: "daemon unreachable — retrying",
};

function Placeholder({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof FileTextIcon;
  title: string;
  description: string;
}) {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function PaneHeading({ children }: { children: string }) {
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-edge px-3 text-xs font-medium tracking-wide text-ink-dim uppercase">
      {children}
    </div>
  );
}

export function App() {
  const { state, connection } = useDaemon();
  const [theme, setTheme] = useState<Theme>(readAppliedTheme);
  const layout = useDefaultLayout({ id: LAYOUT_ID, panelIds: [...PANES], storage: safeStorage });

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  const entries = state?.context.length ?? 0;
  const docs = state?.docs.length ?? 0;
  const open = state?.docs.find((d) => d.slug === state.openDoc) ?? null;
  const messages = state?.chat.length ?? 0;

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
          <Placeholder
            icon={FolderTreeIcon}
            title={
              !state
                ? "Waiting for the session…"
                : entries === 0
                  ? "No context yet"
                  : `${entries} context ${entries === 1 ? "entry" : "entries"}`
            }
            description="Files and folders added to this session appear here. Add one from the agent: cli.ts add <path>."
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="document" defaultSize="50" minSize="25" className="flex flex-col bg-bg">
          <PaneHeading>Document</PaneHeading>
          <Placeholder
            icon={FileTextIcon}
            title={!state ? "Waiting for the session…" : open ? open.name : "No document open"}
            description={
              docs === 0
                ? "Pick a document from the context pane to read it here."
                : `${docs} ${docs === 1 ? "document" : "documents"} in this session.`
            }
          />
          <StatusStrip segments={PLACEHOLDER_SEGMENTS} />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="chat"
          defaultSize="28"
          minSize="15"
          className="flex flex-col bg-surface"
        >
          <PaneHeading>Conversation</PaneHeading>
          <Placeholder
            icon={MessagesSquareIcon}
            title={
              !state
                ? "Waiting for the session…"
                : messages === 0
                  ? "No messages yet"
                  : `${messages} ${messages === 1 ? "message" : "messages"}`
            }
            description="The conversation with the agent lives here."
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
