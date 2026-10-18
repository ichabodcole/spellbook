/**
 * The flagged Scriptorium's interim frame (`SCRIPTORIUM_KIT=1` only): the kit's
 * context sidebar, chat, Notes and Tasks around the kit's document pane. Cycle
 * 5's shell replaces this file whole, so it stays thin: no resizing, no
 * persisted layout, no search.
 *
 * The pane reads a workspace the shell would provide; `./frameWorkspace.ts`
 * builds a small one (one held selection, reveal, the chosen note, toasts), and
 * the chat and Notes read the same selection, so `say` and a note made in the
 * panel are about the passage the pane holds. Scriptorium's own slots: the
 * trust chip on (E69), a stale chip (`scriptoriumChips`), split view, and the
 * view mode kept under Scriptorium's name.
 *
 * ⚠ Its classes are ones the shipped surface already uses: the shipped
 * stylesheet scans all of `surface/` (`@source "./"`), this folder included, so
 * a class new here would be compiled into the shipped Scriptorium's CSS too.
 * The frame's own sheet (`./styles.css`) is the shipped one plus the kit's
 * document rules, which only this page carries.
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
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatSidebar } from "../../../kit/chat/ChatSidebar";
import { NewVersionToasts } from "../../../kit/chat/NewVersionToasts";
import { NotesPanel } from "../../../kit/chat/NotesPanel";
import { badgesOn } from "../../../kit/chat/noteWaiting";
import { OutsideChangeToasts } from "../../../kit/chat/OutsideChangeToasts";
import { TasksPanel } from "../../../kit/chat/TasksPanel";
import { useAskLocation } from "../../../kit/context/AskLocation";
import { ContextSidebar } from "../../../kit/context/ContextSidebar";
import type { Daemon } from "../../../kit/context/daemonClient";
import type { MenuActions } from "../../../kit/context/menuActions";
import { dirOf, docAt, entryPath, joinPath, singleDoc } from "../../../kit/context/model";
import { WorkspaceContext } from "../../../kit/context/workspace";
import { DocumentPane } from "../../../kit/document/DocumentPane";
import type { FrontmatterChips } from "../../../kit/document/FrontmatterHeader";
import { bundlePlace } from "../../../kit/lib/bundles";
import { cn } from "../../../kit/lib/cn";
import { safeStorage } from "../../../kit/lib/storage";
import type { Theme } from "../../../kit/theme/mode";
import { Toasts, useToastStore } from "../../../kit/ui/toast";
import type { PublicState } from "../../../kit/workspace/protocol";
import { isStale } from "../../backend/frontmatter";
import type { DocSummary } from "../../backend/protocol";
import { statusMark } from "../components/context/model";
import { useFrameWorkspace } from "./frameWorkspace";
import { scriptoriumBeforeMove, scriptoriumUncheckedMoveNote } from "./movePlan";
import { useMapView } from "./useMapView";

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

/** Where the pane keeps raw, rendered or split: this page's own origin, under Scriptorium's name. */
export const VIEW_MODE_KEY = "scriptorium:view-mode";

/** Where the raw editor's line-number toggle is remembered, beside the view mode. */
export const LINE_NUMBERS_KEY = "scriptorium:line-numbers";

/** The stale chip's hover text: the tree's dot says the same (`statusMark`). */
const STALE_TITLE = "Past its stale_after date";

/**
 * The pane's chip slot: the kit's chips, and a stale chip when the document is
 * past its `stale_after`, as the shipped header shows one (`MetaHeader`). Read
 * off the fields the header shows, by the shipped rule (`isStale`), so the
 * chip and the fields beside it describe the same text. It claims no key, so
 * `stale_after` itself is still listed, as the shipped header lists it.
 */
export function scriptoriumChips(now: () => number = Date.now): FrontmatterChips {
  return (fields, chips) =>
    isStale(fields as Record<string, unknown>, now())
      ? [
          ...chips,
          {
            tone: "attention",
            title: STALE_TITLE,
            label: (
              <>
                <ClockIcon aria-hidden className="size-3" />
                stale
              </>
            ),
          },
        ]
      : chips;
}
const CHIPS = scriptoriumChips();

/** What `hide` left out of each entry, by entry id (the kit daemon's `appState.hidden`). */
const hiddenOf = (state: PublicState): Record<string, string[]> =>
  ((state.appState as { hidden?: Record<string, string[]> } | null)?.hidden ?? {}) as Record<
    string,
    string[]
  >;

const NO_META: Record<string, DocSummary> = {};

/** Each document's frontmatter, by absolute path (the kit daemon's `appState.docMeta`). */
const docMetaOf = (state: PublicState | null): Record<string, DocSummary> =>
  (state?.appState as { docMeta?: Record<string, DocSummary> } | null | undefined)?.docMeta ??
  NO_META;

/**
 * The sidebar's `rowMarker`: the shipped tree's status dot (draft, stale,
 * deprecated, unreadable), decided by the shipped `statusMark` and drawn in its
 * classes, so both trees mark the same documents the same way.
 */
export function scriptoriumRowMarker(
  docMeta: Record<string, DocSummary>,
): (path: string) => ReactNode {
  return (path) => {
    const mark = statusMark(docMeta[path]);
    if (!mark) return null;
    return (
      <span
        title={mark.title}
        data-tone={mark.tone}
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          "data-[tone=draft]:bg-attention data-[tone=stale]:bg-attention/70",
          "data-[tone=deprecated]:bg-danger data-[tone=unreadable]:bg-ink-faint",
        )}
      />
    );
  };
}

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
  const [theme, setTheme] = useState<Theme>(() =>
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
  const chooseTheme = useCallback(
    (next: Theme) => {
      setTheme(next);
      send({ op: "prefs.set", key: "theme", value: next });
    },
    [send],
  );
  const toggleTheme = () => chooseTheme(theme === "light" ? "dark" : "light");
  const toasts = useToastStore();
  const ws = useFrameWorkspace({ daemon, toasts, theme, setTheme: chooseTheme });
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
  // One marker per docMeta, not per render: the sidebar memoises on it.
  const docMeta = docMetaOf(state);
  const rowMarker = useMemo(() => scriptoriumRowMarker(docMeta), [docMeta]);
  const map = useMapView(daemon);
  const { workspace, openDoc, heldHere, collapsed } = ws;
  if (!state || !workspace)
    return (
      <div className="flex h-full items-center justify-center text-ink-dim">
        {daemon.connection === "ended" ? "The session has ended." : "Connecting to Scriptorium…"}
      </div>
    );
  const notice = daemon.lastError
    ? [daemon.lastError, hints.current.get(daemon.lastError)].filter(Boolean).join(". To go on: ")
    : null;
  const docName = (slug: string) => state.docs.find((d) => d.slug === slug)?.name ?? slug;
  const tabs = { chat: "Chat", notes: "Notes", tasks: "Tasks" } as const;
  return (
    <WorkspaceContext.Provider value={workspace}>
      <OutsideChangeToasts
        doc={openDoc}
        announce={toasts.announce}
        dismiss={toasts.dismiss}
        onReload={(doc) => send({ op: "revert", doc })}
        onShowDiff={(doc) => ws.requestDiff(doc, "original")}
      />
      <NewVersionToasts
        doc={openDoc}
        connected={daemon.connection === "open"}
        announce={toasts.announce}
        dismiss={toasts.dismiss}
        onActivate={(doc, version) => send({ op: "activate", doc, version })}
        onShowDiff={(doc, version) => ws.requestDiff(doc, version)}
      />
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
          <aside
            data-pane="context"
            tabIndex={-1}
            hidden={collapsed.context}
            className="flex w-80 shrink-0 flex-col"
          >
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
              rowMarker={rowMarker}
              appActionsFor={(t) => [
                ...scriptoriumMenuActions(
                  send,
                  hiddenOf(state),
                )({ ...t, doc: docAt(state.docs, t.path) }),
                ...map.menuActions(t),
              ]}
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
          {/* Focusable by script, as the shell's centre is: the pane forwards that focus to its editor. */}
          <main
            data-pane="centre"
            tabIndex={-1}
            className="relative flex min-w-0 flex-1 flex-col border-l border-edge"
          >
            <DocumentPane
              showDiff={ws.showDiff}
              viewModeKey={VIEW_MODE_KEY}
              lineNumbers
              lineNumbersKey={LINE_NUMBERS_KEY}
              splitView
              frontmatterTrust
              frontmatterChips={CHIPS}
              appView={map.appView}
            />
            <Toasts store={toasts} />
          </main>
          <aside
            data-pane="chat"
            tabIndex={-1}
            hidden={collapsed.chat}
            className="flex w-80 shrink-0 flex-col border-l border-edge"
          >
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
                attachable={
                  heldHere
                    ? {
                        doc: heldHere.doc,
                        name: docName(heldHere.doc),
                        version: heldHere.version,
                        fromLine: heldHere.fromLine,
                        toLine: heldHere.toLine,
                        text: heldHere.text,
                      }
                    : null
                }
                connected={daemon.connection === "open"}
                ended={daemon.connection === "ended"}
                // The subject is left to the daemon, which attaches the selection it holds.
                onSend={(text, withSelection) =>
                  send({ op: "say", text, withSelection, via: "chat" })
                }
                onDropSelection={ws.dropSelection}
              />
            )}
            {tab === "notes" && (
              <NotesPanel
                notes={openDoc?.notes ?? []}
                waiting={badgesOn(state.notesWaiting ?? [], openDoc?.slug ?? null)}
                agentListening={state.agentListening !== false}
                focusedId={ws.focusedNote}
                onLetGo={ws.letGoOfNote}
                showResolved={ws.showResolvedNotes}
                onShowResolved={ws.setShowResolvedNotes}
                selection={
                  heldHere ? { from: heldHere.from, to: heldHere.to, text: heldHere.text } : null
                }
                onAdd={ws.addNote}
                onGoTo={ws.goToNote}
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
    </WorkspaceContext.Provider>
  );
}
