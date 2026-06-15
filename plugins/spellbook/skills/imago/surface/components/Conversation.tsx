import { ImagePlus, SendHorizontal, Terminal, WandSparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import { variantLabel } from "../state/derive";
import { processFiles } from "../state/fileIntake";
import type { ClientToServer, ImagoState, Message } from "../state/types";

const LENSES: [string, string][] = [
  ["describe", "Describe this image in detail — literally what is in it."],
  ["palette", "Break down the color palette — the key colors and how they work together."],
  ["lighting", "Describe the lighting — direction, quality, mood — so I can reuse it."],
];

// Right pane: the dialogue spine + the composer. The composer is the single
// input; shortcuts (styles, capture-look, ask-lenses) WRITE into it, "do"
// controls (pins, attach ref) set state. Generation happens through the
// conversation, not a Generate button.
export function Conversation({
  state,
  send,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
}) {
  const [draft, setDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const focusLabel = (() => {
    if (!state.focus) return "new image";
    const bi = state.batches.findIndex((b) => b.id === state.focus?.batchId);
    const b = state.batches[bi];
    const vi = b?.variants.findIndex((v) => v.id === state.focus?.variantId) ?? -1;
    return bi >= 0 ? `about: Batch ${bi + 1} · ${variantLabel(vi)}` : "new image";
  })();

  function submit() {
    const t = draft.trim();
    if (!t) return;
    send({ type: "say", text: t });
    setDraft("");
  }

  return (
    <aside className="card flex flex-col min-h-0 h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-divider">
        <span className="section-title">Conversation</span>
        <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full border border-edge-strong bg-surface text-ink">
          {focusLabel}
        </span>
      </div>

      {/* THREAD */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {state.conversation.length === 0 && (
          <p className="text-faint italic text-center mt-8">
            tell imago what you want to make — rough is fine. it interprets, proposes a prompt, and
            asks if it needs to.
          </p>
        )}
        {state.conversation.map((m) => (
          <Bubble key={m.id} m={m} state={state} send={send} setDraft={setDraft} />
        ))}
      </div>

      {/* COMPOSER */}
      <div className="border-t border-divider p-3 flex flex-col gap-2">
        {state.pins.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-faint">pinned</span>
            {state.pins.map((p) => (
              <span
                key={p.key}
                className="text-[11px] px-2 py-0.5 rounded-full bg-accent/15 text-accent-ink border border-accent/30 flex items-center gap-1"
              >
                📌 {p.key}: {p.value}
                <button type="button" onClick={() => send({ type: "pin.remove", key: p.key })}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* styles + capture look */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="text-faint shrink-0">styles</span>
          {state.styles.map((s) => (
            <button
              type="button"
              key={s.name}
              onClick={() => send({ type: "style.toggle", name: s.name })}
              className={`${s.active ? "chip-on" : "chip"} shrink-0`}
            >
              {s.name}
            </button>
          ))}
          {state.focus && (
            <button
              type="button"
              onClick={() => send({ type: "style.capture" })}
              className="chip shrink-0 !border-capture/40 !text-capture-ink flex items-center gap-1"
              title="Capture this image's look as a reusable style"
            >
              <WandSparkles className="w-3 h-3" /> capture look
            </button>
          )}
        </div>

        {/* ask-lenses (shortcuts that fill the box) */}
        {state.focus && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-faint shrink-0">ask</span>
            {LENSES.map(([label, text]) => (
              <button type="button" key={label} className="chip" onClick={() => setDraft(text)}>
                {label}
              </button>
            ))}
          </div>
        )}

        {/* staged references */}
        {state.refs.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-faint shrink-0">refs</span>
            {state.refs.map((r) => (
              <span
                key={r.id}
                className="relative w-12 h-12 rounded-md overflow-hidden ring-1 ring-edge shrink-0"
              >
                <img src={r.src} alt={r.name} className="w-full h-full object-cover" />
                <button
                  type="button"
                  onClick={() => send({ type: "ref.remove", id: r.id })}
                  className="absolute top-0 right-0 bg-black/70 text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            }}
            rows={2}
            className="textarea pr-20"
            placeholder="talk to imago about this image… (rough is fine — ⌘↵ to send)"
          />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              processFiles(e.target.files, send);
              e.target.value = "";
            }}
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-1">
            <button
              type="button"
              className="btn-ghost !p-1.5"
              title="Attach a reference image"
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus className="w-4 h-4" />
            </button>
            <button type="button" className="btn-primary !p-1.5" title="Send" onClick={submit}>
              <SendHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>

        <p className="text-[11px] text-faint flex items-center gap-1">
          <Terminal className="w-3 h-3" /> imago is right here — and you can always talk to it in
          the terminal too.
        </p>
      </div>
    </aside>
  );
}

function Bubble({
  m,
  state,
  send,
  setDraft,
}: {
  m: Message;
  state: ImagoState;
  send: (m: ClientToServer) => void;
  setDraft: (s: string) => void;
}) {
  if (m.kind === "gesture") {
    return <div className="text-center text-[11px] text-faint italic py-0.5">{m.text}</div>;
  }

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] text-sm rounded-lg rounded-br-sm px-3 py-2 bg-accent/20 border border-accent/30 text-ink">
          {m.text}
        </div>
      </div>
    );
  }

  // agent messages
  const asking = m.kind === "question";
  return (
    <div className="flex gap-2">
      <span className="text-base shrink-0 mt-0.5" aria-hidden>
        🜛
      </span>
      <div className="flex flex-col gap-2 max-w-[88%]">
        {m.text && (
          <div
            className={`text-sm rounded-lg rounded-tl-sm px-3 py-2 ${
              asking
                ? "bg-attention/40 border border-attention/40 text-attention-ink"
                : "bg-surface border border-edge text-ink"
            }`}
          >
            {m.text}
          </div>
        )}

        {/* prompt proposal — a piece on the board */}
        {m.kind === "prompt" && m.proposal && (
          <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
            <p className="text-sm text-ink leading-relaxed italic">“{m.proposal.prompt}”</p>
            {m.proposal.status === "pending" ? (
              <div className="flex items-center gap-2 mt-2.5">
                <button
                  type="button"
                  className="btn-primary !px-3 !py-1.5 text-xs"
                  onClick={() => send({ type: "proposal.send", id: m.id })}
                >
                  Send ×{m.proposal.n}
                </button>
                <button
                  type="button"
                  className="btn-outline !px-2.5 !py-1.5 text-xs"
                  onClick={() => {
                    setDraft(m.proposal?.prompt ?? "");
                    send({ type: "proposal.dismiss", id: m.id });
                  }}
                >
                  tweak it
                </button>
                <span className="text-[11px] text-faint ml-auto">saved with the image ↩</span>
              </div>
            ) : (
              <p className="text-[11px] text-faint mt-1.5">{m.proposal.status}</p>
            )}
          </div>
        )}

        {/* result — mini thumbs of the produced batch */}
        {m.kind === "result" &&
          (() => {
            const b = state.batches.find((x) => x.id === m.batchId);
            if (!b) return null;
            return (
              <div className="flex gap-1.5">
                {b.variants.map((v, vi) => (
                  <button
                    type="button"
                    key={v.id}
                    onClick={() =>
                      send({
                        type: "focus.set",
                        batchId: b.id,
                        variantId: v.id,
                      })
                    }
                    className="w-12 h-12 rounded-md overflow-hidden ring-1 ring-edge hover:ring-accent"
                  >
                    <img
                      src={v.src}
                      alt={`variant ${variantLabel(vi)}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
              </div>
            );
          })()}

        {/* question quick-replies */}
        {m.kind === "question" && m.options && m.options.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {m.options.map((o) => (
              <button
                type="button"
                key={o}
                className="chip"
                onClick={() => send({ type: "say", text: o })}
              >
                {o}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
