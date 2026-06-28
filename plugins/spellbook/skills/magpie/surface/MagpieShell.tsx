// surface/MagpieShell.tsx
// The top-level shell. Three views keyed off state:
//   no source            → a landing dropzone ("Drop a composite")
//   source, no elements  → the board + a quiet "Magpie is scanning…" (agent runs
//                          discover); still a drop target to replace the board
//   elements present      → the editable BreakdownCanvas + the slices rail +
//                          the conversation spine
// Phases so far: intake + editable canvas (Phase 1), then "slices" — cut raw
// crops, review/rate them, re-cut all or a subset. Background removal (transparent
// cutouts on backdrops) + model comparison are the next phase (still stubbed).
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  ImageUp,
  Maximize2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ActivityBars } from "./components/ActivityBars";
import { BreakdownCanvas } from "./components/BreakdownCanvas";
import { TypeMenu } from "./components/breakdown/TypeMenu";
import { typeColor } from "./components/breakdown/typeColor";
import { Conversation } from "./components/Conversation";
import { ExportView } from "./components/ExportView";
import { PhaseStepper } from "./components/PhaseStepper";
import { RemoveGallery } from "./components/RemoveGallery";
import { importDroppedFile } from "./state/fileIntake";
import type { ClientToServer, Element, MagpieState } from "./state/types";
import type { ConnStatus } from "./state/useSession";
import { chosenVersion, versionUrl } from "./state/versions";

export function MagpieShell({
  state,
  send,
  status,
  agentPresent,
  ended,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
  status: ConnStatus;
  agentPresent: boolean;
  ended: boolean;
}) {
  if (ended) {
    return (
      <div className="h-screen flex items-center justify-center text-center">
        <div className="card p-8">
          <p className="page-title">session ended</p>
          <p className="text-faint mt-2">you can close this tab</p>
        </div>
      </div>
    );
  }

  const hasSource = state.source !== null;
  const phase = state.phase;

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-divider">
        <span className="page-title">🐦 {state.title}</span>
        {state.intent && <span className="text-faint text-sm truncate">— {state.intent}</span>}
        <div className="ml-auto flex items-center gap-3">
          {state.status.busy && (
            <span className="text-attention-ink text-xs flex items-center gap-1">
              <span className="pulse-dot">●</span> {state.status.text || "working…"}
            </span>
          )}
          <ConnectionStatus status={status} agentPresent={agentPresent} />
        </div>
      </header>

      {/* The process spine — shown once a board exists */}
      {hasSource && <PhaseStepper phase={phase} send={send} />}

      {/* Body — switched by the phase cursor */}
      {phase === "intake" ? (
        !hasSource ? (
          <Dropzone send={send} />
        ) : (
          <ScanningView state={state} send={send} />
        )
      ) : (
        <div className="flex-1 grid grid-cols-[1fr_320px] gap-3 p-3 min-h-0">
          <div className="min-h-0 flex flex-col gap-3">
            {phase === "slice" && (
              <div className="flex-1 grid grid-cols-[1fr_300px] gap-3 min-h-0">
                {state.source && (
                  <BreakdownCanvas source={state.source} elements={state.elements} send={send} />
                )}
                <ElementList elements={state.elements} send={send} busy={state.status.busy} />
              </div>
            )}
            {phase === "remove" && <RemoveGallery state={state} send={send} />}
            {phase === "export" && <ExportView state={state} send={send} />}
          </div>
          <Conversation state={state} send={send} />
        </div>
      )}
    </div>
  );
}

// ── connection indicator ─────────────────────────────────────────────────────
const CONN: Record<ConnStatus, { color: string; label: string; pulse: boolean }> = {
  open: { color: "var(--color-positive)", label: "connected", pulse: false },
  connecting: { color: "var(--color-attention)", label: "connecting…", pulse: true },
  closed: { color: "var(--color-negative)", label: "disconnected", pulse: false },
};

function ConnectionStatus({ status, agentPresent }: { status: ConnStatus; agentPresent: boolean }) {
  const c = CONN[status];
  return (
    <span className="flex items-center gap-2 text-[11px] text-faint">
      {/* socket health — the daemon-alive canary */}
      <span className="flex items-center gap-1.5" title={`connection: ${status}`}>
        <span
          className={`w-1.5 h-1.5 rounded-full ${c.pulse ? "animate-pulse" : ""}`}
          style={{ background: c.color }}
        />
        {c.label}
      </span>
      {/* agent presence — is anyone actually driving the board? (socket-up only) */}
      {status === "open" &&
        (agentPresent ? (
          <span
            className="flex items-center gap-1 text-accent-ink"
            title="an agent is tailing this board"
          >
            <span className="opacity-30">·</span>
            <Eye className="w-3 h-3" /> magpie watching
          </span>
        ) : (
          <span className="flex items-center gap-1" title="no agent is attached">
            <span className="opacity-30">·</span>
            <EyeOff className="w-3 h-3 opacity-70" /> no agent
          </span>
        ))}
    </span>
  );
}

// ── landing: drop a composite ────────────────────────────────────────────────
function Dropzone({ send }: { send: (m: ClientToServer) => void }) {
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function take(files: FileList | null) {
    const f = Array.from(files ?? []).find((x) => x.type.startsWith("image/"));
    if (f) void importDroppedFile(f, send);
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: file drop zone */}
      <div
        className={`card w-full max-w-2xl p-16 flex flex-col items-center gap-4 text-center border-2 border-dashed transition-colors ${
          dragging ? "border-accent/70 bg-accent/5" : "border-edge-strong"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
      >
        <ImageUp className="w-10 h-10 text-accent-ink" />
        <p className="page-title">Drop a composite</p>
        <p className="text-faint max-w-md">
          Drop a moodboard, branding sheet, or style frame here and magpie will break it down into
          its distinct elements.
        </p>
        <button
          type="button"
          className="btn-outline mt-2"
          onClick={() => fileInput.current?.click()}
        >
          Choose an image
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            take(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

// ── source set, awaiting discovery ───────────────────────────────────────────
function ScanningView({ state, send }: { state: MagpieState; send: (m: ClientToServer) => void }) {
  const [dragging, setDragging] = useState(false);
  const src = state.source ? `/assets/${state.source.path.split("/").pop()}` : "";

  function take(files: FileList | null) {
    const f = Array.from(files ?? []).find((x) => x.type.startsWith("image/"));
    if (f) void importDroppedFile(f, send);
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6 min-h-0">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop to replace the board */}
      <div
        className={`card relative max-w-full max-h-full overflow-hidden flex flex-col items-center ${
          dragging ? "ring-2 ring-accent/60" : ""
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
      >
        {src && (
          <img
            src={src}
            alt="composite under review"
            className="block max-w-full max-h-[80vh] object-contain"
          />
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 py-3 bg-gradient-to-t from-bg/90 to-transparent text-sm text-accent-ink">
          <span className="pulse-dot">●</span> Magpie is scanning the board…
        </div>
      </div>
    </div>
  );
}

// ── the element / slices rail ────────────────────────────────────────────────
// Pre-slice it's the element list (name / type / drop). After "Cut slices" each
// row grows a raw-crop thumbnail + a flag-for-re-slice toggle + a per-row re-cut
// — the validation loop before the (next-phase) background-removal gallery.
function ElementList({
  elements,
  send,
  busy,
}: {
  elements: Element[];
  send: (m: ClientToServer) => void;
  busy: boolean;
}) {
  const live = elements.filter((e) => e.status !== "dropped");
  const sliced = live.filter((e) => chosenVersion(e)).length;
  const hasSlices = sliced > 0;
  // the focus-mode navigable set: sliced + not dropped, in display (rail) order
  const focusable = elements.filter((e) => chosenVersion(e) && e.status !== "dropped");
  // the batch re-slice set: slices the user flagged for re-cutting
  const markedIds = focusable.filter((e) => e.flagged).map((e) => e.id);
  const [zoomId, setZoomId] = useState<string | null>(null);
  const zoomIndex = zoomId ? focusable.findIndex((e) => e.id === zoomId) : -1;
  return (
    <aside className="card flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-divider">
        <span className="section-title">{hasSlices ? "Slices" : "Elements"}</span>
        <span className="text-faint text-xs ml-auto">
          {hasSlices ? `${sliced}/${live.length}` : live.length}
        </span>
      </div>
      <ul className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
        {elements.map((el, i) => (
          <ElementRow
            key={el.id}
            el={el}
            index={i + 1}
            send={send}
            onZoom={setZoomId}
            busy={busy}
          />
        ))}
      </ul>
      {zoomIndex >= 0 && (
        <Lightbox
          items={focusable}
          index={zoomIndex}
          onIndex={(i) => setZoomId(focusable[i]?.id ?? null)}
          send={send}
          onClose={() => setZoomId(null)}
        />
      )}
      <div className="p-2 border-t border-divider">
        {hasSlices ? (
          <button
            type="button"
            onClick={() => send({ type: "extract", ids: markedIds })}
            disabled={markedIds.length === 0 || busy}
            title={
              markedIds.length === 0
                ? "Flag slices for re-slicing first"
                : `Re-slice the ${markedIds.length} flagged slice${markedIds.length === 1 ? "" : "s"}`
            }
            className={`btn-primary w-full !py-2 text-xs disabled:opacity-40 ${busy ? "!opacity-100" : ""}`}
          >
            {busy ? (
              <>
                <ActivityBars /> Re-slicing…
              </>
            ) : (
              <>
                <Scissors className="w-3.5 h-3.5" />
                {markedIds.length > 0 ? `Re-slice ${markedIds.length} flagged` : "Nothing flagged"}
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => send({ type: "extract" })}
            disabled={live.length === 0 || busy}
            className={`btn-primary w-full !py-2 text-xs disabled:opacity-40 ${busy ? "!opacity-100" : ""}`}
          >
            {busy ? (
              <>
                <ActivityBars /> Cutting…
              </>
            ) : (
              <>
                <Scissors className="w-3.5 h-3.5" />
                {`Cut ${live.length} slice${live.length === 1 ? "" : "s"}`}
              </>
            )}
          </button>
        )}
      </div>
    </aside>
  );
}

function ElementRow({
  el,
  index,
  send,
  onZoom,
  busy,
}: {
  el: Element;
  index: number;
  send: (m: ClientToServer) => void;
  onZoom: (id: string) => void;
  busy: boolean;
}) {
  const dropped = el.status === "dropped";
  const [editing, setEditing] = useState(false);
  const ver = chosenVersion(el);
  const sliceSrc = ver ? versionUrl(ver) : null;
  const toggleMark = () => send({ type: "element.flag", id: el.id, flagged: !el.flagged });
  return (
    <li
      className={`rounded-md text-xs ${dropped ? "opacity-50" : "hover:bg-surface-3"} ${
        el.flagged ? "ring-1 ring-[var(--color-attention)]/50" : ""
      }`}
    >
      {/* identity line — badge, name, type, drop */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span
          className="text-[10px] font-bold px-1 rounded-sm shrink-0"
          style={{ background: typeColor(el.type), color: "var(--color-bg)" }}
        >
          {index}
        </span>
        {editing ? (
          <NameInput
            initial={el.name}
            onCommit={(name) => {
              if (name && name !== el.name)
                send({ type: "element.update", id: el.id, patch: { name } });
              setEditing(false);
            }}
          />
        ) : (
          <button
            type="button"
            title="Rename"
            onClick={() => setEditing(true)}
            className={`group flex-1 min-w-0 flex items-center gap-1 text-left text-ink ${
              dropped ? "line-through" : ""
            }`}
          >
            <span className="truncate">{el.name}</span>
            <Pencil className="w-3 h-3 shrink-0 opacity-0 group-hover:opacity-50" />
          </button>
        )}
        <TypeMenu
          value={el.type}
          color={typeColor(el.type)}
          onChange={(t) => send({ type: "element.update", id: el.id, patch: { type: t } })}
        />
        <button
          type="button"
          title={dropped ? "Restore this element" : "Drop this element"}
          onClick={() =>
            send({ type: "element.judge", id: el.id, status: dropped ? "confirmed" : "dropped" })
          }
          className="btn-ghost !p-1 shrink-0"
        >
          {dropped ? <RotateCcw className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>

      {/* slice strip — the raw crop (full rail width, natural aspect) + a
          flag-for-re-slice toggle + an immediate per-row re-cut (the scalpel).
          Click the crop to zoom it full-screen. */}
      {sliceSrc && !dropped && (
        <div className="px-2 pb-2 flex flex-col gap-1.5">
          <button
            type="button"
            title="Click to enlarge"
            onClick={() => onZoom(el.id)}
            className="group relative w-full rounded border border-edge overflow-hidden bg-surface-2 flex items-center justify-center px-2 py-2 cursor-zoom-in"
          >
            <img
              src={sliceSrc}
              alt={`${el.name} slice`}
              className="max-w-full max-h-40 object-contain"
            />
            <span className="absolute top-1 right-1 p-0.5 rounded bg-bg/70 text-faint opacity-0 group-hover:opacity-100 transition-opacity">
              <Maximize2 className="w-3 h-3" />
            </span>
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={el.flagged ? "Flagged for re-slice — click to clear" : "Flag for re-slice"}
              onClick={toggleMark}
              className={`btn-ghost !py-1 !px-1.5 gap-1 text-[11px] ${
                el.flagged ? "text-[var(--color-attention)]" : "text-faint"
              }`}
            >
              <Scissors className="w-3.5 h-3.5" />
              {el.flagged ? "Flagged" : "Re-slice"}
            </button>
            <button
              type="button"
              title={busy ? "Re-slicing…" : "Re-slice this one now"}
              onClick={() => send({ type: "extract", ids: [el.id] })}
              disabled={busy}
              className="btn-ghost !p-1 ml-auto disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// Focus mode — a full-screen view of one slice with prev/next cycling and the
// flag-for-re-slice toggle in place. Flagging here just MARKS the slice (for a
// later batch re-cut from the rail); it deliberately doesn't execute a re-cut.
// Arrow keys navigate, Esc closes.
function Lightbox({
  items,
  index,
  onIndex,
  send,
  onClose,
}: {
  items: Element[];
  index: number;
  onIndex: (i: number) => void;
  send: (m: ClientToServer) => void;
  onClose: () => void;
}) {
  const n = items.length;
  const el = items[index];
  const prev = () => onIndex((index - 1 + n) % n);
  const next = () => onIndex((index + 1) % n);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const ver = el ? chosenVersion(el) : undefined;
  if (!el || !ver) return null;
  const src = versionUrl(ver);
  const toggleMark = () => send({ type: "element.flag", id: el.id, flagged: !el.flagged });
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-8">
      {/* backdrop is a real button so click-to-dismiss is keyboard-reachable too */}
      <button
        type="button"
        aria-label="Close preview"
        onClick={onClose}
        className="absolute inset-0 bg-bg/85 backdrop-blur-sm cursor-zoom-out"
      />
      <button
        type="button"
        title="Close"
        onClick={onClose}
        className="absolute top-4 right-4 btn-ghost !p-2 text-ink"
      >
        <X className="w-5 h-5" />
      </button>
      {/* prev / image / next */}
      <div className="relative flex items-center gap-4 max-w-full max-h-full">
        <button
          type="button"
          title="Previous (←)"
          onClick={prev}
          disabled={n < 2}
          className="btn-ghost !p-2 text-ink disabled:opacity-30 shrink-0"
        >
          <ChevronLeft className="w-7 h-7" />
        </button>
        {/* No rounding/shadow on the image itself — in a review tool any styling
            that alters the apparent edges is misleading. The image renders with
            its true pixel bounds; the 1px frame is honest chrome (it hugs the
            exact rectangle so the real extent is obvious) and is offset by a
            ring so a same-colored image edge can't blend into it. */}
        <img
          src={src}
          alt={`${el.name} slice`}
          className="max-w-[70vw] max-h-[72vh] object-contain border border-edge-strong ring-1 ring-bg/80"
        />
        <button
          type="button"
          title="Next (→)"
          onClick={next}
          disabled={n < 2}
          className="btn-ghost !p-2 text-ink disabled:opacity-30 shrink-0"
        >
          <ChevronRight className="w-7 h-7" />
        </button>
      </div>
      {/* caption + flag — marks for re-slicing, never executes a re-cut here */}
      <div className="relative mt-4 flex flex-col items-center gap-2">
        <div className="text-xs text-faint">
          <span className="text-ink">{el.name}</span> · {el.type} · {index + 1} / {n}
        </div>
        <button
          type="button"
          title={el.flagged ? "Flagged for re-slice — click to clear" : "Flag for re-slice"}
          onClick={toggleMark}
          className="btn-outline !py-1.5 !px-3 text-xs gap-1.5"
          style={el.flagged ? { color: "var(--color-attention)" } : undefined}
        >
          <Scissors className="w-4 h-4" />{" "}
          {el.flagged ? "Flagged for re-slice" : "Flag for re-slice"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

// inline rename field for a list row — autofocus, Enter/blur commit, Esc cancel.
function NameInput({ initial, onCommit }: { initial: string; onCommit: (name: string) => void }) {
  const [val, setVal] = useState(initial);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: inline rename should grab focus immediately
      autoFocus
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(val.trim());
        else if (e.key === "Escape") onCommit("");
      }}
      onBlur={() => onCommit(val.trim())}
      className="flex-1 min-w-0 text-xs px-1 py-0.5 rounded-sm bg-surface-2 border border-accent text-ink outline-none"
    />
  );
}
