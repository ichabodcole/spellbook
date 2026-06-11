import { FileText, ImagePlus, Plus, ScanEye, Star } from "lucide-react";
import { useRef } from "react";
import { processFiles } from "../state/fileIntake";
import type { ClientToServer, GlamourState } from "../state/types";

export function InfluencePane({
  state,
  send,
  selInf,
  selCtx,
  onSelInf,
  onSelCtx,
}: {
  state: GlamourState;
  send: (m: ClientToServer) => void;
  selInf: string | null;
  selCtx: string | null;
  onSelInf: (id: string | null) => void;
  onSelCtx: (id: string | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    fileInputRef.current?.click();
  }

  const hasInfluences = state.influences.length > 0;
  const hasContexts = state.contexts.length > 0;
  const hasAny = hasInfluences || hasContexts;

  return (
    <div className="card p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center">
        <div className="section-title">Influences</div>
        {hasInfluences && <span className="text-faint ml-auto">click a tile to annotate</span>}
      </div>

      {/* Empty dropzone — label wraps the hidden input for click-to-browse;
          onDrop/onDragOver on the label are drop handlers only (not click handlers) */}
      {!hasAny && (
        <label
          htmlFor="glamour-file-pick"
          onDrop={(e) => {
            e.preventDefault();
            processFiles(e.dataTransfer.files, send).catch((err) => console.error(err));
          }}
          onDragOver={(e) => e.preventDefault()}
          className="inset border-dashed border-2 border-[#34294a] rounded-xl py-10 px-4 text-center cursor-pointer block"
        >
          <ImagePlus className="w-7 h-7 text-violet-400/70 mx-auto mb-2" />
          <div className="text-muted">Drop images or context files</div>
          <div className="text-faint mt-1">
            references + .md / .txt world-building — or click to browse
          </div>
        </label>
      )}

      {/* Influence tiles grid — fieldset satisfies useSemanticElements for aria group */}
      {hasInfluences && (
        <fieldset
          aria-label="Influence images drop zone"
          onDrop={(e) => {
            e.preventDefault();
            processFiles(e.dataTransfer.files, send).catch((err) => console.error(err));
          }}
          onDragOver={(e) => e.preventDefault()}
          className="space-y-2 border-0 p-0 m-0"
        >
          <div className="grid grid-cols-2 gap-2">
            {state.influences.map((inf) => (
              <button
                key={inf.id}
                type="button"
                className={`tile text-left${selInf === inf.id ? " ring-2 ring-violet-500" : ""}`}
                onClick={() => {
                  onSelInf(inf.id);
                  onSelCtx(null);
                }}
              >
                <img src={inf.src} alt={inf.name} />
                {inf.aspects.length > 0 && (
                  <div className="absolute top-1 left-1 flex flex-wrap gap-0.5">
                    {inf.aspects.map((a) => (
                      <span key={a} className="text-[9px] px-1 rounded bg-black/55 text-white/90">
                        {a}
                      </span>
                    ))}
                  </div>
                )}
                {inf.starred && (
                  <div className="absolute top-1 right-1">
                    <Star className="w-3.5 h-3.5 text-amber-300 fill-current drop-shadow" />
                  </div>
                )}
                <div className="absolute bottom-0 inset-x-0 bg-black/45 px-1.5 py-1">
                  <div className="text-[10px] text-white/80 font-mono truncate">{inf.name}</div>
                </div>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* Context list — fieldset satisfies useSemanticElements for aria group */}
      {hasContexts && (
        <fieldset
          aria-label="Context files drop zone"
          onDrop={(e) => {
            e.preventDefault();
            processFiles(e.dataTransfer.files, send).catch((err) => console.error(err));
          }}
          onDragOver={(e) => e.preventDefault()}
          className="space-y-1.5 border-0 p-0 m-0"
        >
          <div className="section-title">Context</div>
          {state.contexts.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`w-full inset p-2 flex items-center gap-2 text-left${selCtx === c.id ? " ring-2 ring-violet-500" : ""}`}
              onClick={() => {
                onSelCtx(c.id);
                onSelInf(null);
              }}
            >
              <FileText className="w-4 h-4 text-violet-300 shrink-0" />
              <span className="text-[12px] text-slate-300 truncate flex-1">{c.name}</span>
              {c.starred && <Star className="w-3.5 h-3.5 text-amber-300 fill-current shrink-0" />}
            </button>
          ))}
        </fieldset>
      )}

      {/* Add more files button */}
      {hasAny && (
        <button type="button" className="btn-ghost w-full" onClick={openPicker}>
          <Plus className="w-3.5 h-3.5" /> add images or context files
        </button>
      )}

      {/* Hidden file input — shared by the label (empty state) and the openPicker button */}
      <input
        ref={fileInputRef}
        id="glamour-file-pick"
        type="file"
        multiple
        className="hidden"
        accept="image/*,.md,.markdown,.mdx,.txt,.json,.yaml,.yml,text/*"
        onChange={(e) => {
          processFiles(e.target.files, send).catch((err) => console.error(err));
          e.currentTarget.value = "";
        }}
      />

      {/* Intent textarea */}
      <div className="space-y-1.5">
        <div className="section-title">What you're going for</div>
        <textarea
          className="textarea h-24"
          defaultValue={state.intent}
          onBlur={(e) => {
            if (e.target.value !== state.intent) send({ type: "intent.set", text: e.target.value });
          }}
          placeholder="Describe the look you're chasing…"
        />
      </div>

      {/* Read the influences nudge */}
      {state.phase === "gather" && hasInfluences && (
        <button
          type="button"
          className="btn-primary w-full"
          onClick={() => send({ type: "nudge", label: "read the influences" })}
        >
          <ScanEye className="w-4 h-4" /> Read the influences
        </button>
      )}
    </div>
  );
}
