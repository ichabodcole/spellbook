// surface/components/ExportView.tsx
// The Export phase body — the take-away. A grid of each element's FINAL chosen
// asset (cutout or kept-whole crop) on a checker backdrop, with per-asset include
// toggles (default all in). "Build & download bundle" fires the `export`
// imperative; the agent zips the chosen assets (+ raw crops + manifest.json +
// gallery.html) out of band and posts `bundle.set`, after which a Download link
// appears. The project is reopenable from its snapshot (the session-id hint).
import { Check, Download, Package } from "lucide-react";
import { useState } from "react";
import type { ClientToServer, Element, MagpieState } from "../state/types";
import { chosenVersion, versionUrl } from "../state/versions";
import { ActivityBars } from "./ActivityBars";
import { typeColor } from "./breakdown/typeColor";

function hasRemoval(el: Element): boolean {
  return (el.versions ?? []).some((v) => v.model !== "crop");
}

export function ExportView({
  state,
  send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  const live = state.elements.filter((e) => e.status !== "dropped");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const included = live.filter((e) => !excluded.has(e.id));
  const cutouts = included.filter(hasRemoval).length;
  const keptWhole = included.length - cutouts;
  const busy = state.status.busy;
  const bundle = state.bundle;

  const toggle = (id: string) =>
    setExcluded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="card flex flex-col min-h-0 flex-1">
      {/* header — summary + build / download */}
      <div className="flex items-center gap-3 px-3 py-2.5 border-b border-divider">
        <span className="section-title">Export</span>
        <span className="text-faint">
          {included.length} asset{included.length === 1 ? "" : "s"} · {cutouts} cutout
          {cutouts === 1 ? "" : "s"} · {keptWhole} kept whole
        </span>
        <div className="ml-auto flex items-center gap-2">
          {bundle && (
            <a
              href={`/assets/${bundle.name}?v=${bundle.count}`}
              download
              className="btn-outline !py-1.5 text-xs"
              style={{ color: "var(--color-positive)", borderColor: "var(--color-positive)" }}
            >
              <Download className="w-3.5 h-3.5" /> Download bundle ({bundle.count})
            </a>
          )}
          <button
            type="button"
            onClick={() => send({ type: "export", ids: included.map((e) => e.id) })}
            disabled={included.length === 0 || busy}
            className="btn-primary !py-1.5 text-xs disabled:opacity-40"
          >
            {busy ? (
              <>
                <ActivityBars /> Building…
              </>
            ) : (
              <>
                <Package className="w-3.5 h-3.5" /> {bundle ? "Rebuild bundle" : "Build & download"}
              </>
            )}
          </button>
        </div>
      </div>

      {/* asset grid (relative for the building overlay) */}
      <div className="relative flex-1 min-h-0 overflow-y-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {live.map((el) => {
            const ver = chosenVersion(el);
            const inc = !excluded.has(el.id);
            return (
              <button
                type="button"
                key={el.id}
                onClick={() => toggle(el.id)}
                title={inc ? "Included — click to exclude" : "Excluded — click to include"}
                className={`text-left rounded-lg border overflow-hidden bg-surface-2 transition-opacity ${
                  inc ? "border-edge" : "border-edge opacity-40"
                }`}
              >
                <div className="relative h-24 flex items-center justify-center checker">
                  {ver && (
                    <img
                      src={versionUrl(ver)}
                      alt={el.name}
                      className="max-w-full max-h-full object-contain"
                    />
                  )}
                  <span
                    className={`absolute top-1 left-1 w-4 h-4 rounded flex items-center justify-center border ${
                      inc ? "bg-accent border-accent" : "bg-bg/70 border-edge-strong"
                    }`}
                  >
                    {inc && <Check className="w-3 h-3 text-accent-fg" />}
                  </span>
                </div>
                <div className="px-2 py-1.5 flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: typeColor(el.type) }}
                  />
                  <span className="text-[11px] text-ink truncate flex-1">{el.name}</span>
                  {ver && <span className="text-[10px] text-faint shrink-0">{ver.model}</span>}
                </div>
              </button>
            );
          })}
        </div>

        {busy && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg/70 backdrop-blur-[1px]">
            <div className="card px-6 py-5 flex flex-col items-center gap-3 text-center">
              <span className="text-accent-ink">
                <ActivityBars />
              </span>
              <p className="text-sm text-ink">{state.status.text || "Building bundle…"}</p>
            </div>
          </div>
        )}
      </div>

      {/* reopen hint — the project persists as a snapshot */}
      <div className="px-3 py-2 border-t border-divider text-[11px] text-faint flex items-center gap-2">
        <span>Project saved ✓ — reopen anytime:</span>
        <code className="text-mono text-[11px] text-muted">
          magpie open --restore {state.sessionId ?? "<session>"}
        </code>
      </div>
    </div>
  );
}
