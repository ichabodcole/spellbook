/**
 * The flagged Scriptorium's interim frame (`SCRIPTORIUM_KIT=1` only): the kit's
 * context sidebar, chat, Notes and Tasks around a centre that has no document
 * pane yet. Cycle 5's shell replaces this file whole, so it stays thin: no
 * resizing, no persisted layout, no search.
 *
 * ⚠ Its classes are ones the shipped surface already uses: the shipped
 * stylesheet scans all of `surface/` (`@source "./"`), this folder included, so
 * a class new here would be compiled into the shipped Scriptorium's CSS too.
 *
 * Scriptorium's own verbs reach the panes through their slots: hide, unhide
 * and make-set through `menuActions` (`scriptoriumMenuActions`), the move plan
 * through the pre-move slot (`./movePlan.tsx`). Every create, import and drop
 * the panes send names its folder (`dir`): Scriptorium has no workspace, so
 * what has no set or folder under it (New document or New folder with nothing
 * selected, a drop on the list itself) asks where, through the sidebar's
 * `askLocation` slot (`useAskLocation`), the place chosen last preselected.
 */

import {
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatSidebar } from "../../../kit/chat/ChatSidebar";
import { NotesPanel } from "../../../kit/chat/NotesPanel";
import { TasksPanel } from "../../../kit/chat/TasksPanel";
import { useAskLocation } from "../../../kit/context/AskLocation";
import { ContextSidebar } from "../../../kit/context/ContextSidebar";
import type { Daemon } from "../../../kit/context/daemonClient";
import type { MenuActions } from "../../../kit/context/menuActions";
import { dirOf, docAt, entryPath, joinPath, singleDoc } from "../../../kit/context/model";
import { bundlePlace } from "../../../kit/lib/bundles";
import { cn } from "../../../kit/lib/cn";
import { safeStorage } from "../../../kit/lib/storage";
import type { PublicState } from "../../../kit/workspace/protocol";
import { scriptoriumBeforeMove, scriptoriumUncheckedMoveNote } from "./movePlan";

const NO_ENTRIES: PublicState["context"] = [];

/** Under the location dialog: the other way to make room for new files. */
const MAKE_ROOM =
  "A document listed on its own can take new files beside it once it is a set: Turn into a set, in its row's menu.";

/**
 * The browser's copy of the theme, read by the page's pre-paint script so a
 * load does not flash. Each session has its own port, so its own origin and
 * storage: this copy is not shared between sessions, nor with the shipped
 * surface. What carries the choice is the daemon's prefs (`theme`, kept in the
 * kit path's `prefs.json`), as the shipped surface keeps its own.
 */
const THEME_KEY = "scriptorium:theme";

/** What `hide` left out of each entry, by entry id (the kit daemon's `appState.hidden`). */
const hiddenOf = (state: PublicState): Record<string, string[]> =>
  ((state.appState as { hidden?: Record<string, string[]> } | null)?.hidden ?? {}) as Record<
    string,
    string[]
  >;

/**
 * Scriptorium's menu actions: Hide on anything inside a set, Show hidden on a set that hides something, and Turn into a set on a
 * document listed on its own (the shipped surface's words for all three). On a
 * document or image inside a set, New document and New folder beside it: the
 * kit's own are on a folder's row, a set's and the tree's background, and a
 * selected document is a place too, so making one there never asks.
 */
export function scriptoriumMenuActions(
  send: Daemon["send"],
  hidden: Record<string, string[]>,
): MenuActions {
  return ({ kind, path, entry }) => {
    if (kind === "background" || !entry) return [];
    const actions = [];
    const own = entry && kind === "entry" && singleDoc(entry);
    if (own)
      actions.push({
        id: "scriptorium.make-set",
        label: "Turn into a set",
        icon: <FolderTreeIcon />,
        onSelect: () => send({ op: "set.make", path: entryPath(entry) }),
      });
    const n = hidden[entry.id]?.length ?? 0;
    if (kind === "entry" && n > 0)
      actions.push({
        id: "scriptorium.unhide",
        label: `Show ${n} hidden ${n === 1 ? "item" : "items"}`,
        icon: <EyeIcon />,
        onSelect: () => send({ op: "scriptorium.unhide", entry: entry.id }),
      });
    const beside =
      (kind === "doc" || kind === "image" || kind === "bundle") && bundlePlace(path) !== "own";
    if (beside) {
      const dir = dirOf(path);
      actions.push(
        {
          id: "scriptorium.new-doc-beside",
          label: "New document beside it",
          icon: <FilePlusIcon />,
          onSelect: () => send({ op: "doc.create", dir }),
        },
        {
          id: "scriptorium.new-folder-beside",
          label: "New folder beside it",
          icon: <FolderPlusIcon />,
          onSelect: () => send({ op: "folder.create", dir }),
        },
      );
    }
    // A row in the list is taken out by the kit's own Remove; Hide is for what is inside.
    if (kind !== "entry")
      actions.push({
        id: "scriptorium.hide",
        label: "Hide from Scriptorium",
        icon: <EyeOffIcon />,
        onSelect: () => send({ op: "scriptorium.hide", path }),
      });
    return actions;
  };
}

export function Frame({ daemon }: { daemon: Daemon }) {
  const { state, send } = daemon;
  const [tab, setTab] = useState<"chat" | "notes" | "tasks">("chat");
  const [theme, setTheme] = useState(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    safeStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  // One theme for every kit-path session, last choice wins: the prefs carry it.
  const savedTheme = state?.prefs.theme;
  useEffect(() => {
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
  }, [savedTheme]);
  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    send({ op: "prefs.set", key: "theme", value: next });
  };
  // The client keeps a refusal's message only; the daemon's hint (what to do
  // instead, as for a create with no folder) is read off the frame here.
  const hints = useRef(new Map<string, string>());
  useEffect(
    () =>
      daemon.onFrame((f) => {
        if (f.op === "error" && typeof f.hint === "string" && typeof f.message === "string")
          hints.current.set(f.message, f.hint);
      }),
    [daemon.onFrame],
  );
  const userHome = state?.userHome || null;
  const beforeMove = useMemo(
    () => scriptoriumBeforeMove(daemon, { userHome }),
    [daemon.request, userHome],
  );
  // Where to create when nothing is selected. The place chosen last is held by
  // the hook for as long as this page lives, which is this session's surface.
  const ask = useAskLocation({
    entries: state?.context ?? NO_ENTRIES,
    userHome,
    listDir: daemon.listDir,
    addFolder: (path) => daemon.request({ op: "folder.add", path }),
    hint: MAKE_ROOM,
  });
  // One object per `done`, not per render: the sidebar acts on a new one (it
  // shows the row and starts its rename), so a fresh object on every snapshot
  // pulled the view back into the set after the human had left it.
  const done = daemon.done;
  const created = useMemo(
    () =>
      done && ["doc.create", "folder.create", "bundle.create"].includes(done.of)
        ? { path: done.path, seq: done.seq }
        : null,
    [done],
  );
  const moved = useMemo(
    () => (done?.of === "move" ? { path: done.path, seq: done.seq } : null),
    [done],
  );
  if (!state)
    return (
      <div className="flex h-full items-center justify-center text-ink-dim">
        {daemon.connection === "ended" ? "The session has ended." : "Connecting to Scriptorium…"}
      </div>
    );
  const openDoc = state.openDoc ? state.docs.find((d) => d.slug === state.openDoc) : undefined;
  const notice = daemon.lastError
    ? [daemon.lastError, hints.current.get(daemon.lastError)].filter(Boolean).join(". To go on: ")
    : null;
  const docName = (slug: string) => state.docs.find((d) => d.slug === slug)?.name ?? slug;
  const tabs = { chat: "Chat", notes: "Notes", tasks: "Tasks" } as const;
  return (
    <div data-slot="interim-frame" className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-edge px-3 text-xs">
        <span className="font-manuscript text-sm text-rubric">Scriptorium</span>
        <span className="text-ink-faint">{state.sessionId}</span>
        <span className="ml-auto text-ink-dim">{daemon.connection}</span>
        <button
          type="button"
          aria-label="Switch theme"
          className="text-ink-faint hover:text-ink [&_svg]:size-3.5"
          onClick={toggleTheme}
        >
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside data-pane="context" className="flex w-80 shrink-0 flex-col">
          <ContextSidebar
            entries={state.context}
            activeDoc={
              openDoc?.entryId && openDoc.rel
                ? { entryId: openDoc.entryId, rel: openDoc.rel }
                : null
            }
            userHome={userHome}
            onOpenDoc={(entry, rel) => send({ op: "open", path: joinPath(entry.root, rel) })}
            onAddPath={(path) => send({ op: "context.add", path })}
            onStructure={(op) => send(op)}
            onRemoveEntry={(id) => send({ op: "context.remove", id })}
            onReveal={(path) => send({ op: "reveal", path })}
            onPick={(want) => send({ op: "pick", want })}
            listDir={daemon.listDir}
            appActionsFor={(t) =>
              scriptoriumMenuActions(
                send,
                hiddenOf(state),
              )({ ...t, doc: docAt(state.docs, t.path) })
            }
            created={created}
            moved={moved}
            notice={notice}
            onDismissNotice={daemon.clearError}
            importImage={daemon.importImage}
            askLocation={ask.askLocation}
            beforeMove={beforeMove}
            uncheckedMoveNote={scriptoriumUncheckedMoveNote}
          />
        </aside>
        <main
          data-pane="centre"
          className="flex flex-1 items-center justify-center border-l border-edge p-6"
        >
          <div className="max-w-md text-center text-ink-dim">
            {openDoc ? (
              <p role="status">
                <span className="text-ink">{openDoc.name}</span> is open in this session. This
                surface cannot show it yet: the document pane arrives in the next cycle. The agent
                can read it, and you can talk about it in the chat.
              </p>
            ) : (
              <p role="status">
                The document pane arrives in the next cycle. Until then, manage the sets on the left
                and talk with the agent on the right.
              </p>
            )}
          </div>
        </main>
        <aside data-pane="chat" className="flex w-80 shrink-0 flex-col border-l border-edge">
          <div role="tablist" className="flex h-9 shrink-0 border-b border-edge text-xs">
            {(Object.keys(tabs) as (keyof typeof tabs)[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn("px-3", tab === id ? "text-ink" : "text-ink-faint hover:text-ink")}
              >
                {tabs[id]}
              </button>
            ))}
          </div>
          {tab === "chat" && (
            <ChatSidebar
              messages={state.chat}
              waiting={state.waiting}
              agentListening={state.agentListening !== false}
              docName={docName}
              attachable={null}
              connected={daemon.connection === "open"}
              ended={daemon.connection === "ended"}
              onSend={(text) => send({ op: "say", text, withSelection: false, via: "chat" })}
              onDropSelection={() => {}}
            />
          )}
          {tab === "notes" && (
            <NotesPanel
              notes={openDoc?.notes ?? []}
              focusedId={null}
              selection={null}
              // A note is made on a passage selected in the document, and this
              // frame has no document view to select in.
              addUnavailable="Notes are added on a passage in the document, which this surface cannot show yet."
              onAdd={() => {}}
              onGoTo={() => {}}
              onEdit={(id, body) =>
                openDoc && send({ op: "note.edit", doc: openDoc.slug, id, body })
              }
              onResolve={(id, resolved) =>
                openDoc && send({ op: "note.resolve", doc: openDoc.slug, id, resolved })
              }
              onRemove={(id) => openDoc && send({ op: "note.remove", doc: openDoc.slug, id })}
            />
          )}
          {tab === "tasks" && (
            <TasksPanel
              tasks={state.tasks}
              onCancel={(id) => send({ op: "task.cancel", id })}
              onRemove={(id) => send({ op: "task.remove", id })}
              onClear={() => send({ op: "tasks.clear" })}
              onCreate={(title) => send({ op: "task.create", title })}
            />
          )}
        </aside>
      </div>
      {ask.dialog}
    </div>
  );
}
