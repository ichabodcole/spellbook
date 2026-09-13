// The surface: three drag-resizable panes (E11 — `resizable`, not `sidebar`),
// the context sidebar on the left (E16 — built first, props-only so it can move
// to the kit), the open document read-only in the centre with the status strip
// under it (E18), and the conversation placeholder on the right (chat is a later
// piece, E16).

import { cn } from "cn";
import { MessagesSquareIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Button } from "@/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/ui/resizable";
import type {
  ChatMessage,
  ContextEntry,
  DiffSide,
  DocView,
  PublicState,
} from "../backend/protocol";
import { ActiveVersionToast } from "./components/ActiveVersionToast";
import { ContextSidebar } from "./components/context/ContextSidebar";
import { joinPath } from "./components/context/model";
import { DocumentPane, VIEW_MODES, type ViewMode } from "./components/DocumentPane";
import { NotesPanel } from "./components/NotesPanel";
import { Toasts, useToasts } from "./components/Toasts";
import { applyTheme, readAppliedTheme, type Theme } from "./state/theme";
import { type Connection, textKey, useDaemon } from "./state/useDaemon";

/** The pane ids are the persisted layout's keys — renaming one forgets a viewer's sizes. */
export const PANES = ["context", "document", "chat"] as const;
export const LAYOUT_ID = "scriptorium:panes";
/** The split inside the document pane keeps its own sizes (E29). */
export const SPLIT_PANES = ["doc-raw", "doc-rendered"] as const;
export const SPLIT_LAYOUT_ID = "scriptorium:doc-split";
/** Raw, rendered or split — a viewer's choice, kept in the home's prefs like the theme. */
const VIEW_PREF = "doc:view";

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
  const {
    send,
    texts,
    noteText,
    diff,
    listDir,
    planMove,
    mapOf,
    suggestMeta,
    lastError,
    clearError,
    done,
  } = daemon;
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
  const splitLayout = useDefaultLayout({
    id: SPLIT_LAYOUT_ID,
    panelIds: [...SPLIT_PANES],
    storage,
  });

  const saved = state.prefs[VIEW_PREF];
  const mode: ViewMode = (VIEW_MODES as readonly string[]).includes(saved ?? "")
    ? (saved as ViewMode)
    : "rendered";

  // What the comparison is against (E36). Deliberately NOT persisted: which
  // version you wanted to look at last session says nothing about this one,
  // and the original is the side that always exists.
  const [against, setAgainst] = useState<DiffSide>("original");
  const { toasts, announce, dismiss } = useToasts();
  // The editor's selection, kept here because the NOTES PANEL is the thing that
  // acts on it and it lives in the other pane (E45).
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null);
  // Which of the right pane's two things is showing.
  const [rightPane, setRightPane] = useState<"conversation" | "notes">("conversation");
  /** Asking the editor to scroll a note's range into view — bumped per request. */
  const [reveal, setReveal] = useState<{ from: number; to: number; seq: number } | null>(null);
  /** The note the document is pointing at (E47). */
  const [focusedNote, setFocusedNote] = useState<string | null>(null);

  const open: DocView | null = state.docs.find((d) => d.slug === state.openDoc) ?? null;
  const openNotes = (open?.notes ?? []).filter((n) => !n.resolved);
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

  // Ask for the comparison whenever anything it depends on moves — the
  // document, the active version, the chosen side, or the text itself. A merge
  // lands as a new text, so this is also what refreshes the view after one:
  // the hunks the human sees are always the hunks the daemon would apply.
  useEffect(() => {
    if (mode !== "compare" || !open) return;
    // The side can vanish under us — it is a version, and a version can be
    // deleted (E41) or become the active one. Either way the original is the
    // side that always exists.
    if (
      against === open.active ||
      (typeof against === "number" && !open.versions.some((v) => v.n === against))
    ) {
      setAgainst("original");
      return;
    }
    send({ type: "diff", doc: open.slug, against });
  }, [mode, open, against, text, send]);

  // ⌘S belongs to the SESSION, not to the editor's focus: in rendered mode the
  // editor is not mounted at all, and the browser's own Save-page dialog is
  // what opens if nothing claims the key. The editor keeps its own binding too
  // (it flushes the pending buffer first), and both end at the same `save`.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "s" || !(e.metaKey || e.ctrlKey) || e.altKey) return;
      const doc = openRef.current;
      e.preventDefault();
      if (doc?.dirty) send({ type: "save", doc: doc.slug });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

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
    <>
      <ActiveVersionToast doc={open} announce={announce} />
      <Toasts toasts={toasts} onDismiss={dismiss} />
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
            onPick={(want) => send({ type: "pick", want })}
            metaFor={(path) => state.docMeta[path]}
            listDir={listDir}
            planMove={planMove}
            mapOf={mapOf}
            onOpenPath={(path) => send({ type: "open", path })}
            created={created}
            notice={lastError}
            onDismissNotice={clearError}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="document" defaultSize="50" minSize="25" className="flex flex-col bg-bg">
          <DocumentPane
            doc={open}
            text={text}
            mode={mode}
            onMode={(next) => send({ type: "prefs.set", key: VIEW_PREF, value: next })}
            diff={diff}
            onAgainst={setAgainst}
            onTake={(hunks) => {
              if (open) send({ type: "merge", doc: open.slug, against, hunks });
            }}
            onActivate={(version) => {
              if (open) send({ type: "activate", doc: open.slug, version });
            }}
            onNewVersion={(label, intent) => {
              if (open)
                send({
                  type: "version.new",
                  doc: open.slug,
                  ...(label ? { label } : {}),
                  activate: intent === "branch",
                });
            }}
            onDeleteVersion={(version) => {
              if (open) send({ type: "version.delete", doc: open.slug, version });
            }}
            onRevealVersion={(version) => {
              if (open) send({ type: "reveal.version", doc: open.slug, version });
            }}
            onSelect={(from, to) => setSelection(from === to ? null : { from, to })}
            reveal={reveal}
            onAddNote={(from, to, body) => {
              if (open) send({ type: "note.add", doc: open.slug, from, to, body });
            }}
            onDeleteNote={(id) => {
              if (open) send({ type: "note.remove", doc: open.slug, id });
            }}
            onShowNote={(id) => {
              // Pointing at a note has to OPEN the notes — the panel may be
              // showing the conversation, in which case a border nobody can
              // see is not an answer.
              setRightPane("notes");
              setFocusedNote(id);
            }}
            splitLayout={splitLayout}
            onAddFrontmatter={async () => {
              if (!open) return;
              const { block, error } = await suggestMeta(open.original);
              if (!block || error) return;
              // The block goes into the BUFFER, not the file: the human reads it,
              // fills the blank description, and Save puts it on disk (E7).
              const next = `${block}${text ?? ""}`;
              noteText(open.slug, open.active, next);
              send({ type: "edit", doc: open.slug, version: open.active, text: next });
            }}
            onFollowLink={(target) => {
              if (open) send({ type: "link.open", from: open.original, target });
            }}
            onEdit={(next) => {
              if (!open) return;
              // The daemon does not echo an edit back, so this viewer keeps its
              // own copy in step — otherwise the prop would trail the buffer and
              // every re-render would look like news from the daemon.
              noteText(open.slug, open.active, next);
              send({ type: "edit", doc: open.slug, version: open.active, text: next });
            }}
            onSave={() => open && send({ type: "save", doc: open.slug })}
            onRevert={() => open && send({ type: "revert", doc: open.slug })}
          />
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel
          id="chat"
          defaultSize="28"
          minSize="15"
          className="flex flex-col bg-surface"
        >
          {/* ⛔ TWO THINGS, ONE PANE (E45). A fourth resizable pane would make
              every pane too narrow to read; notes and the conversation are both
              "what is being said about this document", so they share, and when
              chat lands it joins as the same kind of tab rather than needing
              somewhere new to live. */}
          <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-edge px-2">
            {(["conversation", "notes"] as const).map((which) => (
              <button
                key={which}
                type="button"
                onClick={() => setRightPane(which)}
                aria-pressed={rightPane === which}
                className={cn(
                  "rounded-sm px-2 py-1 text-xs font-medium tracking-wide uppercase",
                  "text-ink-dim hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                  rightPane === which && "bg-surface-raised text-ink",
                )}
              >
                {which === "notes" && openNotes.length > 0 ? `Notes ${openNotes.length}` : which}
              </button>
            ))}
          </div>
          {rightPane === "notes" ? (
            <NotesPanel
              notes={open?.notes ?? []}
              focusedId={focusedNote}
              selection={
                open && selection && text !== undefined
                  ? { ...selection, text: text.slice(selection.from, selection.to) }
                  : null
              }
              onAdd={(from, to, body) => {
                if (open) send({ type: "note.add", doc: open.slug, from, to, body });
              }}
              onGoTo={(n) => {
                // ⛔ THE BORDER FOLLOWS THE CLICK (E47 fix). Showing a note's
                // passage without moving the border left the PREVIOUS note
                // bordered — so the panel pointed at one note while the editor
                // showed another. Whatever was last asked for is the one marked.
                setFocusedNote(n.id);
                if (n.from !== null)
                  setReveal({ from: n.from, to: n.to as number, seq: Date.now() });
              }}
              onEdit={(id, body) => {
                if (open) send({ type: "note.edit", doc: open.slug, id, body });
              }}
              onResolve={(id, resolved) => {
                if (open) send({ type: "note.resolve", doc: open.slug, id, resolved });
              }}
              onRemove={(id) => {
                if (open) send({ type: "note.remove", doc: open.slug, id });
              }}
            />
          ) : state.chat.length === 0 ? (
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
    </>
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
