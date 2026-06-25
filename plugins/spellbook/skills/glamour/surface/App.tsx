import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Heart,
  Library,
  Maximize2,
  Minimize2,
  Pin,
  Star,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Conversation } from "./components/Conversation";
import { DetailsFlyout } from "./components/DetailsFlyout";
import { FacetBar } from "./components/FacetBar";
import { FocusBar } from "./components/FocusBar";
import { FocusDrawer } from "./components/FocusDrawer";
import { LandingScreen } from "./components/LandingScreen";
import { LibraryGrid } from "./components/LibraryGrid";
import { Lightbox } from "./components/Lightbox";
import { StyleGuide } from "./components/StyleGuide";
import { StylesTray } from "./components/StylesTray";
import { processFiles } from "./state/fileIntake";
import { agentRepliedSince } from "./state/reduce";
import type { ItemKind } from "./state/types";
import { useSession } from "./state/useSession";

export function App() {
  const { state, send } = useSession();
  const [facet, setFacet] = useState<ItemKind | "all">("all");
  const [rail, setRail] = useState<"collapsed" | "open" | "wide">("open");
  const [dragging, setDragging] = useState(false);
  const [trayOpen, setTrayOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [markFilter, setMarkFilter] = useState({ liked: false, starred: false, pinned: false });
  const toggleMark = (k: "liked" | "starred" | "pinned") =>
    setMarkFilter((f) => ({ ...f, [k]: !f[k] }));

  useEffect(() => {
    if (state && awaitingSince !== null && agentRepliedSince(state.messages, awaitingSince)) {
      setAwaitingSince(null);
    }
  }, [state, awaitingSince]);

  if (!state) return <div className="p-6 text-slate-400">connecting…</div>;

  const selected = state.library.find((i) => state.selectedIds.includes(i.id));
  const solid = state.styleGuide.filter((s) => s.status === "agreed").length;
  const thinking = awaitingSince !== null || state.status.busy;

  const visible =
    state.scope === "focus"
      ? state.library.filter((i) => state.focusSet.includes(i.id) && !i.archived)
      : state.library.filter((i) => !i.archived && (facet === "all" || i.kind === facet));

  return (
    <div
      role="application"
      className="flex h-screen flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void processFiles(e.dataTransfer.files, send);
      }}
    >
      <header className="flex items-center gap-3 border-b border-white/10 px-5 py-3">
        <h1 className="text-sm font-semibold tracking-wide">{state.title || "untitled"}</h1>
        {state.intent && <span className="text-xs text-slate-400">· {state.intent}</span>}
      </header>

      {state.messages.length === 0 ? (
        <LandingScreen
          onStart={(text) => {
            send({ type: "message.send", text });
            setAwaitingSince(Date.now());
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Style guide rail — left pane */}
          <aside
            className={`flex min-h-0 shrink-0 flex-col border-r border-white/10 transition-all duration-200 ${
              rail === "collapsed"
                ? "w-12"
                : rail === "wide"
                  ? "w-[28rem] xl:w-[32rem] 2xl:w-[38rem]"
                  : "w-80 xl:w-96 2xl:w-[26rem]"
            }`}
          >
            {rail === "collapsed" ? (
              /* Collapsed strip */
              <div className="flex flex-1 flex-col items-center gap-3 py-3">
                <button
                  type="button"
                  onClick={() => setRail("open")}
                  title="Expand style guide"
                  aria-label="expand style guide"
                  className="rounded p-1 text-slate-400 hover:text-slate-200"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <div className="flex flex-col items-center gap-1.5 py-1">
                  <BookOpen className="h-3.5 w-3.5 text-slate-500" />
                  {/* Section status dots */}
                  <div className="flex flex-col gap-1">
                    {state.styleGuide.map((s) => (
                      <span
                        key={s.key}
                        title={s.label}
                        className={`h-1.5 w-1.5 rounded-full ${
                          s.status === "agreed"
                            ? "bg-emerald-400"
                            : s.status === "forming"
                              ? "bg-amber-400"
                              : "bg-slate-600"
                        }`}
                      />
                    ))}
                  </div>
                  <span className="mt-1 text-[9px] text-slate-500">
                    {solid}/{state.styleGuide.length}
                  </span>
                </div>
              </div>
            ) : (
              /* Open / wide */
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
                  <BookOpen className="h-3.5 w-3.5 text-slate-400" />
                  <span className="flex-1 text-xs font-medium text-slate-300">Style guide</span>
                  <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[9px] text-slate-400">
                    {solid}/{state.styleGuide.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRail(rail === "wide" ? "open" : "wide")}
                    title={rail === "wide" ? "Narrow rail" : "Widen rail"}
                    aria-label={
                      rail === "wide" ? "narrow style guide rail" : "widen style guide rail"
                    }
                    className="rounded p-0.5 text-slate-500 hover:text-slate-300"
                  >
                    {rail === "wide" ? (
                      <Minimize2 className="h-3 w-3" />
                    ) : (
                      <Maximize2 className="h-3 w-3" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRail("collapsed")}
                    title="Collapse style guide"
                    aria-label="collapse style guide"
                    className="rounded p-0.5 text-slate-500 hover:text-slate-300"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <StyleGuide
                    sections={state.styleGuide}
                    canonicalItems={state.library
                      .filter((i) => i.canonical && !i.archived)
                      .map((i) => ({ id: i.id, title: i.title, src: i.src }))}
                  />
                </div>
              </>
            )}
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <FacetBar
              library={state.library}
              facet={facet}
              onPick={setFacet}
              trailing={
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-0.5 rounded-full bg-white/5 px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => toggleMark("liked")}
                      title="Filter: liked"
                      aria-label="filter liked"
                      className={`rounded-full p-1 ${markFilter.liked ? "bg-rose-500/30 text-rose-300" : "text-slate-400 hover:text-slate-200"}`}
                    >
                      <Heart className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleMark("starred")}
                      title="Filter: starred (shortlist)"
                      aria-label="filter starred"
                      className={`rounded-full p-1 ${markFilter.starred ? "bg-amber-500/30 text-amber-300" : "text-slate-400 hover:text-slate-200"}`}
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleMark("pinned")}
                      title="Filter: pinned (canonical)"
                      aria-label="filter pinned"
                      className={`rounded-full p-1 ${markFilter.pinned ? "bg-fuchsia-500/30 text-fuchsia-300" : "text-slate-400 hover:text-slate-200"}`}
                    >
                      <Pin className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {state.library.some((i) => i.archived) && (
                    <button
                      type="button"
                      onClick={() => setShowArchived((v) => !v)}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs ${
                        showArchived
                          ? "bg-slate-600 text-slate-100"
                          : "bg-white/5 text-slate-400 hover:bg-white/10 hover:text-slate-300"
                      }`}
                    >
                      Show archived ({state.library.filter((i) => i.archived).length})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setTrayOpen((v) => !v)}
                    className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1 text-xs text-slate-300 hover:bg-white/10"
                  >
                    <Library className="h-3.5 w-3.5" /> Project styles
                    <span className="rounded-full bg-slate-900 px-1.5 py-0.5 text-[9px] text-slate-400">
                      {state.tray.filter((s) => !s.archived).length}
                    </span>
                  </button>
                </div>
              }
            />
            {state.scope === "focus" && (
              <FocusBar
                owner={state.focusOwner}
                count={state.focusSet.length}
                note={state.focusOwner === "you" ? "" : state.focusNote}
                onZoomOut={() => send({ type: "focus.clear" })}
              />
            )}
            {state.scope === "all" && state.selectedIds.length > 0 && (
              <div className="flex items-center gap-2 border-b border-white/10 bg-fuchsia-950/20 px-4 py-1.5 text-[11px]">
                <span className="text-fuchsia-300">{state.selectedIds.length} selected</span>
                <button
                  type="button"
                  onClick={() => send({ type: "focus.set", ids: state.selectedIds })}
                  className="flex items-center gap-1 rounded-full border border-fuchsia-500/40 px-2.5 py-1 text-fuchsia-200 hover:bg-fuchsia-600/20"
                >
                  <Crosshair className="h-3 w-3" /> focus these
                </button>
                <button
                  type="button"
                  onClick={() => send({ type: "item.select", ids: [] })}
                  className="ml-auto text-slate-500 hover:text-slate-300"
                >
                  clear
                </button>
              </div>
            )}
            <LibraryGrid
              library={state.library}
              facet={facet}
              selectedIds={state.selectedIds}
              onSelect={(ids) => send({ type: "item.select", ids })}
              onEnlarge={(id) => {
                const idx = visible.findIndex((i) => i.id === id);
                if (idx !== -1) setLightboxIndex(idx);
              }}
              onArchive={(id, archived) => send({ type: "item.archive", id, archived })}
              scope={state.scope}
              focusSet={state.focusSet}
              showArchived={showArchived}
              markFilter={markFilter}
            />
            {trayOpen && (
              <StylesTray
                tray={state.tray}
                inLibrary={(id) => state.library.some((i) => i.id === id)}
                onBringIn={(id) => {
                  send({ type: "style.bringIn", id });
                  setTrayOpen(false);
                }}
                onClose={() => setTrayOpen(false)}
              />
            )}
          </main>

          {selected && (
            <DetailsFlyout
              key={selected.id}
              item={selected}
              onStar={(starred) => send({ type: "item.star", id: selected.id, starred })}
              onLike={(liked) => send({ type: "item.like", id: selected.id, liked })}
              onAnnotate={(human) => send({ type: "item.annotate", id: selected.id, human })}
              onCanonical={(canonical) =>
                send({ type: "item.canonical", id: selected.id, canonical })
              }
              onArchive={(archived) => send({ type: "item.archive", id: selected.id, archived })}
              onClose={() => send({ type: "item.select", ids: [] })}
              onEnlarge={() => {
                const idx = visible.findIndex((i) => i.id === selected.id);
                if (idx !== -1) setLightboxIndex(idx);
              }}
            />
          )}

          <div className="flex min-h-0 shrink-0 flex-col">
            {state.scope === "focus" && state.focusOwner === "agent" && (
              <FocusDrawer note={state.focusNote} count={state.focusSet.length} />
            )}
            <Conversation
              messages={state.messages}
              library={state.library}
              grounded={state.selectedIds}
              thinking={thinking}
              statusText={state.status.text}
              onSend={(text: string) => {
                send({ type: "message.send", text });
                setAwaitingSince(Date.now());
              }}
            />
          </div>
        </div>
      )}

      {lightboxIndex !== null && visible[lightboxIndex] && (
        <Lightbox
          items={visible}
          index={lightboxIndex}
          onIndex={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-fuchsia-500/10 ring-2 ring-inset ring-fuchsia-400/50">
          <span className="rounded bg-black/60 px-4 py-2 text-sm">
            drop references or context files
          </span>
        </div>
      )}
    </div>
  );
}
