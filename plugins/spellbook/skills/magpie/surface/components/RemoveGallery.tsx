// surface/components/RemoveGallery.tsx
// The Remove phase body: a gallery of the confirmed crops previewed against a
// backdrop swatch, where the user asks for background removal (per item or batch),
// then judges the results. Selecting a card opens a DETAIL sidebar with the
// VERSION STRIP (one row per produced version — crop / rembg / cloud retries);
// clicking a version IS choosing it (version.choose). A card can EXPAND to fill
// the gallery while the sidebar stays open.
//
// removeBg / retryRemoval are model-agnostic (the agent picks). Nothing here names
// a model except as a label on a produced version (version.model).
import {
  Check,
  ChevronLeft,
  Eraser,
  Flag,
  Layers,
  Lock,
  Maximize2,
  RefreshCw,
  X,
} from "lucide-react";
import { useState } from "react";
import { isAlphaEligible, isKeptWhole } from "../state/alpha";
import type {
  Backdrop,
  ClientToServer,
  Element,
  ElementVersion,
  MagpieState,
} from "../state/types";
import { chosenVersion, versionUrl } from "../state/versions";
import { ActivityBars } from "./ActivityBars";
import { typeColor } from "./breakdown/typeColor";

// The literal backdrop colors the user previews alpha against — intrinsic preview
// values, not theme tokens (transparent → the .checker class).
type Cell = { className: string; style?: React.CSSProperties };
const BACKDROP_CELL: Record<Backdrop, Cell> = {
  white: { className: "", style: { background: "#ffffff" } },
  gray: { className: "", style: { background: "#8a8a8a" } },
  black: { className: "", style: { background: "#111111" } },
  transparent: { className: "checker" },
};
const BACKDROPS: Backdrop[] = ["white", "gray", "black", "transparent"];

// A removal version exists for this element (anything past the raw crop).
function hasRemoval(el: Element): boolean {
  return (el.versions ?? []).some((v) => v.model !== "crop");
}

export function RemoveGallery({
  state,
  send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [modelFilter, setModelFilter] = useState<string | null>(null);

  const live = state.elements.filter((e) => e.status !== "dropped");
  const pending = live.filter((e) => isAlphaEligible(e.type) && !hasRemoval(e));
  const flagged = live.filter((e) => e.flagged);
  const cell = BACKDROP_CELL[state.backdrop];
  const busy = state.status.busy;
  const selected = selectedId ? (live.find((e) => e.id === selectedId) ?? null) : null;

  // Filters derived DYNAMICALLY from the model each item currently has CHOSEN —
  // they populate as models get used; nothing hardcoded. "crop" = not yet removed.
  const chosenModelOf = (el: Element) => chosenVersion(el)?.model ?? "crop";
  const modelCounts: Record<string, number> = {};
  for (const el of live) {
    const m = chosenModelOf(el);
    modelCounts[m] = (modelCounts[m] ?? 0) + 1;
  }
  // crop (not-removed) sorts last; the rest alphabetical.
  const filterModels = Object.keys(modelCounts).sort((a, b) =>
    a === "crop" ? 1 : b === "crop" ? -1 : a.localeCompare(b),
  );
  // a stale filter (its model no longer chosen anywhere) falls back to "All"
  const activeFilter = modelFilter && modelCounts[modelFilter] ? modelFilter : null;
  const shown = activeFilter ? live.filter((el) => chosenModelOf(el) === activeFilter) : live;

  const select = (id: string) => {
    setSelectedId(id);
  };
  const closeDetail = () => {
    setSelectedId(null);
    setExpanded(false);
  };

  return (
    <div className="card flex flex-col min-h-0 flex-1">
      {/* toolbar — backdrop swatches + the batch removal trigger */}
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-divider">
        <span className="section-title">Background removal</span>
        <div className="flex items-center gap-1.5 ml-2" title="Preview backdrop">
          {BACKDROPS.map((b) => {
            const c = BACKDROP_CELL[b];
            return (
              <button
                type="button"
                key={b}
                title={b}
                onClick={() => send({ type: "backdrop.set", backdrop: b })}
                className={`w-6 h-6 rounded border border-edge-strong ${c.className} ${
                  state.backdrop === b ? "ring-2 ring-accent ring-offset-1 ring-offset-bg" : ""
                }`}
                style={c.style}
              />
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* model-agnostic retry — appears only when something is flagged. Signals
              intent ("try a different model on these"); the agent picks an unused
              model. addVersion auto-deflags each as its new version lands. */}
          {flagged.length > 0 && (
            <button
              type="button"
              onClick={() => send({ type: "retryRemoval", ids: flagged.map((e) => e.id) })}
              disabled={busy}
              title={`Ask magpie to try a different removal model on ${flagged.length} flagged`}
              className="btn-outline !py-1.5 text-xs disabled:opacity-40"
              style={{ color: "var(--color-attention)", borderColor: "var(--color-attention)" }}
            >
              <RefreshCw className="w-3.5 h-3.5" /> Try a different removal on {flagged.length}
            </button>
          )}
          <button
            type="button"
            onClick={() => send({ type: "removeBg", ids: pending.map((e) => e.id) })}
            disabled={pending.length === 0 || busy}
            title={
              pending.length === 0
                ? "No backgrounds left to remove"
                : `Remove backgrounds on ${pending.length} eligible slice${pending.length === 1 ? "" : "s"}`
            }
            className="btn-primary !py-1.5 text-xs disabled:opacity-40"
          >
            {busy ? (
              <>
                <ActivityBars /> Removing…
              </>
            ) : (
              <>
                <Eraser className="w-3.5 h-3.5" />
                {pending.length > 0
                  ? `Remove ${pending.length} background${pending.length === 1 ? "" : "s"}`
                  : "All removed"}
              </>
            )}
          </button>
        </div>
      </div>

      {/* model filter bar — only once more than one model is chosen across items
          (otherwise there's nothing to filter). Dynamic: one chip per model in use. */}
      {filterModels.length > 1 && !expanded && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-divider overflow-x-auto">
          <span className="text-faint shrink-0 mr-1">Chosen model:</span>
          <FilterChip
            label="All"
            count={live.length}
            active={!activeFilter}
            onClick={() => setModelFilter(null)}
          />
          {filterModels.map((m) => (
            <FilterChip
              key={m}
              label={m}
              count={modelCounts[m]}
              active={activeFilter === m}
              onClick={() => setModelFilter(m)}
            />
          ))}
        </div>
      )}

      {/* main (grid OR expanded item) + the detail sidebar */}
      <div className="flex-1 min-h-0 flex">
        <div className="relative flex-1 min-h-0 overflow-y-auto p-3">
          {expanded && selected ? (
            <ExpandedItem el={selected} cell={cell} onBack={() => setExpanded(false)} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {shown.map((el) => (
                <GalleryCard
                  key={el.id}
                  el={el}
                  cell={cell}
                  busy={busy}
                  selected={el.id === selectedId}
                  onSelect={() => select(el.id)}
                  onExpand={() => {
                    select(el.id);
                    setExpanded(true);
                  }}
                  send={send}
                />
              ))}
            </div>
          )}

          {/* the async-gap affordance — "stuff's happening, hold tight" while the
              agent orchestrates removal out-of-band. */}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg/70 backdrop-blur-[1px]">
              <div className="card px-6 py-5 flex flex-col items-center gap-3 text-center">
                <span className="text-accent-ink flex items-center gap-2">
                  <ActivityBars />
                </span>
                <p className="text-sm text-ink">{state.status.text || "Removing backgrounds…"}</p>
                <p className="text-faint">
                  magpie is working — hold tight, cutouts will appear here.
                </p>
              </div>
            </div>
          )}
        </div>

        {selected && (
          <DetailSidebar
            el={selected}
            cell={cell}
            busy={busy}
            expanded={expanded}
            onToggleExpand={() => setExpanded((x) => !x)}
            onClose={closeDetail}
            send={send}
          />
        )}
      </div>
    </div>
  );
}

// How many versions an element has tried (crop counts as one). A quiet signal of
// "how much model-work have I done on this?" — useful when the chosen version has
// flipped back to the crop and the strip isn't open.
function VersionCount({ n }: { n: number }) {
  return (
    <span
      className="ml-auto shrink-0 flex items-center gap-0.5 text-[10px] text-faint"
      title={`${n} version${n === 1 ? "" : "s"} (the crop counts as one)`}
    >
      <Layers className="w-3 h-3" /> {n}
    </span>
  );
}

// A dynamic model-filter pill (label + count). Active = accent-filled.
function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
        active
          ? "bg-accent text-accent-fg border-accent"
          : "border-edge-strong text-muted hover:text-ink hover:border-edge-hover"
      }`}
    >
      <span>{label}</span>
      <span className="opacity-70">{count}</span>
    </button>
  );
}

function GalleryCard({
  el,
  cell,
  busy,
  selected,
  onSelect,
  onExpand,
  send,
}: {
  el: Element;
  cell: Cell;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onExpand: () => void;
  send: (m: ClientToServer) => void;
}) {
  const ver = chosenVersion(el);
  const removed = hasRemoval(el);
  const eligible = isAlphaEligible(el.type);
  const keptWhole = isKeptWhole(el.type);

  return (
    <div
      className={`group rounded-lg border overflow-hidden bg-surface-2 ${
        selected
          ? "border-accent ring-1 ring-accent"
          : el.flagged
            ? "border-[var(--color-attention)]/60"
            : "border-edge"
      }`}
    >
      {/* preview on the chosen backdrop — click to select; expand sits over it
          (sibling buttons, never nested) */}
      <div className="relative">
        <button
          type="button"
          onClick={onSelect}
          title="Select"
          className={`w-full h-28 flex items-center justify-center cursor-pointer ${cell.className}`}
          style={cell.style}
        >
          {ver && (
            <img
              src={versionUrl(ver)}
              alt={`${el.name} cutout`}
              className="max-w-full max-h-full object-contain"
            />
          )}
        </button>
        <button
          type="button"
          onClick={onExpand}
          title="Expand"
          className="absolute top-1 right-1 p-0.5 rounded bg-bg/70 text-faint opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Maximize2 className="w-3 h-3" />
        </button>
      </div>
      {/* identity + action row */}
      <div className="px-2 py-1.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: typeColor(el.type) }}
          />
          <span className="text-[11px] text-ink truncate flex-1" title={el.name}>
            {el.name}
          </span>
          {removed && ver && (
            <span className="text-[10px] text-faint shrink-0" title="chosen removal model">
              {ver.model}
            </span>
          )}
        </div>
        {/* one footer row: the contextual action (or kept-whole note) on the left,
            the version count pinned right */}
        <div className="flex items-center gap-1">
          {keptWhole ? (
            <span
              className="text-[10px] text-faint flex items-center gap-1"
              title="flat color — rembg would destroy it"
            >
              <Lock className="w-3 h-3" /> kept whole
            </span>
          ) : eligible && !removed ? (
            <button
              type="button"
              onClick={() => send({ type: "removeBg", ids: [el.id] })}
              disabled={busy}
              className="btn-ghost !py-1 !px-1.5 gap-1 text-[11px] disabled:opacity-50"
              title="Remove this background"
            >
              <Eraser className="w-3.5 h-3.5" /> Remove bg
            </button>
          ) : removed ? (
            <button
              type="button"
              onClick={() => send({ type: "element.flag", id: el.id, flagged: !el.flagged })}
              className={`btn-ghost !py-1 !px-1.5 gap-1 text-[11px] ${
                el.flagged ? "text-[var(--color-attention)]" : "text-faint"
              }`}
              title={
                el.flagged ? "Flagged — wants another removal" : "Flag for a different removal"
              }
            >
              <Flag className="w-3.5 h-3.5" /> {el.flagged ? "Flagged" : "Flag"}
            </button>
          ) : null}
          <VersionCount n={(el.versions ?? []).length} />
        </div>
      </div>
    </div>
  );
}

// The selected item filling the gallery area (expand-in-place); the sidebar stays.
function ExpandedItem({ el, cell, onBack }: { el: Element; cell: Cell; onBack: () => void }) {
  const ver = chosenVersion(el);
  return (
    <div className="h-full flex flex-col gap-2">
      <button type="button" onClick={onBack} className="btn-ghost self-start !py-1 !px-2 gap-1">
        <ChevronLeft className="w-4 h-4" /> Back to gallery
      </button>
      <div
        className={`flex-1 min-h-0 rounded-lg border border-edge flex items-center justify-center p-4 ${cell.className}`}
        style={cell.style}
      >
        {ver && (
          <img
            src={versionUrl(ver)}
            alt={`${el.name} cutout`}
            className="max-w-full max-h-full object-contain"
          />
        )}
      </div>
    </div>
  );
}

// The detail of the selected element: a large preview + the version strip (one row
// per produced version; clicking a row chooses it) + the flag / kept-whole note.
function DetailSidebar({
  el,
  cell,
  busy,
  expanded,
  onToggleExpand,
  onClose,
  send,
}: {
  el: Element;
  cell: Cell;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  send: (m: ClientToServer) => void;
}) {
  const versions = el.versions ?? [];
  const chosen = chosenVersion(el);
  const removed = hasRemoval(el);
  const eligible = isAlphaEligible(el.type);
  const keptWhole = isKeptWhole(el.type);

  return (
    <aside className="w-72 shrink-0 border-l border-divider flex flex-col min-h-0">
      {/* header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-divider">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: typeColor(el.type) }}
        />
        <span className="text-sm text-ink truncate flex-1" title={el.name}>
          {el.name}
        </span>
        <button
          type="button"
          onClick={onToggleExpand}
          className="btn-ghost !p-1"
          title={expanded ? "Collapse" : "Expand"}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={onClose} className="btn-ghost !p-1" title="Close detail">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {/* large preview of the chosen version on the backdrop */}
        <div
          className={`h-40 rounded-lg border border-edge flex items-center justify-center ${cell.className}`}
          style={cell.style}
        >
          {chosen && (
            <img
              src={versionUrl(chosen)}
              alt={`${el.name} chosen`}
              className="max-w-full max-h-full object-contain"
            />
          )}
        </div>

        {keptWhole ? (
          <p className="text-xs text-faint">
            <Lock className="w-3 h-3 inline mr-1" />
            Kept whole — this is flat-color content (<span className="text-muted">{el.type}</span>),
            which background removal would destroy. No alpha versions.
          </p>
        ) : (
          <>
            {/* version strip — one row per produced version; click to choose */}
            <div className="flex flex-col gap-1.5">
              <span className="section-title">Versions</span>
              {versions.length === 0 && (
                <p className="text-xs text-faint">No cutout yet — remove the background below.</p>
              )}
              {versions.map((v) => (
                <VersionRow
                  key={v.id}
                  v={v}
                  cell={cell}
                  active={chosen?.id === v.id}
                  onChoose={() => send({ type: "version.choose", id: el.id, versionId: v.id })}
                />
              ))}
            </div>

            {/* actions: first removal, or flag for a different removal (retry = Task 4) */}
            {eligible && !removed ? (
              <button
                type="button"
                onClick={() => send({ type: "removeBg", ids: [el.id] })}
                disabled={busy}
                className="btn-primary !py-1.5 text-xs disabled:opacity-50"
              >
                <Eraser className="w-4 h-4" /> Remove background
              </button>
            ) : removed ? (
              <button
                type="button"
                onClick={() => send({ type: "element.flag", id: el.id, flagged: !el.flagged })}
                className="btn-outline !py-1.5 text-xs"
                style={el.flagged ? { color: "var(--color-attention)" } : undefined}
              >
                <Flag className="w-4 h-4" />{" "}
                {el.flagged ? "Flagged for a different removal" : "Flag for a different removal"}
              </button>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function VersionRow({
  v,
  cell,
  active,
  onChoose,
}: {
  v: ElementVersion;
  cell: Cell;
  active: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className={`flex items-center gap-2 p-1.5 rounded-lg border text-left ${
        active ? "border-accent ring-1 ring-accent bg-accent/10" : "border-edge hover:bg-surface-3"
      }`}
      title={active ? "Chosen" : "Choose this version"}
    >
      <span
        className={`w-10 h-10 shrink-0 rounded border border-edge flex items-center justify-center overflow-hidden ${cell.className}`}
        style={cell.style}
      >
        <img src={versionUrl(v)} alt={v.model} className="max-w-full max-h-full object-contain" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-ink">{v.model}</span>
          {v.kind && <span className="text-[10px] text-faint">{v.kind}</span>}
        </span>
        {v.note && <span className="block text-[10px] text-faint truncate">{v.note}</span>}
      </span>
      {active && <Check className="w-4 h-4 text-accent-ink shrink-0" />}
    </button>
  );
}
