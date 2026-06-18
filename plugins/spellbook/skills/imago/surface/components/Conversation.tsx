import {
  ChevronDown,
  ChevronLeft,
  ImagePlus,
  Link,
  Pencil,
  Plus,
  SendHorizontal,
  Terminal,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { resolveSet } from "../state/contextLibrary";
import { variantLabel } from "../state/derive";
import { processFiles } from "../state/fileIntake";
import type { ClientToServer, ContextEntry, ImagoState, Message } from "../state/types";
import { flattenMarks } from "./annotations/flatten";
import { ContentModal } from "./ContentModal";
import { LibraryPicker } from "./LibraryPicker";

// Right pane: the dialogue spine + the composer. The composer is the single
// input; shortcuts (the quick-prompt library) WRITE into it, "do" controls
// (pins, attach ref) set state. Generation happens through the conversation,
// not a Generate button.
export function Conversation({
  state,
  send,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
}) {
  const [draft, setDraft] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const focusLabel = (() => {
    if (!state.focus) return "new image";
    const bi = state.batches.findIndex((b) => b.id === state.focus?.batchId);
    const b = state.batches[bi];
    const vi = b?.variants.findIndex((v) => v.id === state.focus?.variantId) ?? -1;
    return bi >= 0 ? `about: Batch ${bi + 1} · ${variantLabel(vi)}` : "new image";
  })();

  async function submit() {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    // Auto-attach the marked image when the focused image has marks the agent
    // hasn't seen yet (marksUnseen) — same visual handoff as the commit button,
    // off the same flag. Otherwise a plain say (don't re-send what's already in).
    const focus = state.focus;
    const variant = focus
      ? state.batches
          .find((b) => b.id === focus.batchId)
          ?.variants.find((v) => v.id === focus.variantId)
      : undefined;
    const focusMarks = focus ? (state.marksByVariant[focus.variantId] ?? []) : [];
    const focusLayers = focus ? (state.layersByVariant[focus.variantId] ?? []) : [];
    if (variant?.src && focusMarks.length > 0 && state.marksUnseen) {
      const png = await flattenMarks(variant.src, focusMarks, undefined, undefined, focusLayers);
      send({ type: "say", text: t, flattenedSrc: png || undefined });
    } else {
      send({ type: "say", text: t });
    }
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

      {/* COMPOSER — also a forgiving drop target for reference images */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drag-drop file zone */}
      <div
        className={`border-t p-3 flex flex-col gap-2 transition-colors ${
          dragging ? "border-accent/60 bg-accent/5" : "border-divider"
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
          processFiles(e.dataTransfer.files, send);
        }}
      >
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

        {/* quick-prompt library — picks populate the box (never fire behind the
            glass); editable/extensible by the user OR the agent */}
        <div className="flex items-center gap-1.5">
          <QuickPrompts
            library={state.library}
            quickPromptIds={state.quickPromptIds}
            send={send}
            onPick={setDraft}
          />
        </div>

        {/* the box — taller by default, and resizable for a longer ramble */}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={3}
          className="textarea !resize-y min-h-[84px]"
          placeholder="talk to imago about this image… (rough is fine)"
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

        {/* actions — below the input, not crowded inside it */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-faint flex items-center gap-1">
            <Terminal className="w-3 h-3" /> also in your terminal
          </span>
          <span className="text-[11px] text-faint ml-auto">⌘↵</span>
          <button
            type="button"
            title="Attach a reference image"
            onClick={() => fileInput.current?.click()}
            className="btn-ghost !p-1.5"
          >
            <ImagePlus className="w-4 h-4" />
          </button>
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" onClick={submit}>
            <SendHorizontal className="w-4 h-4" /> Send
          </button>
        </div>
      </div>
    </aside>
  );
}

// The quick-prompt library: a dropdown of reusable prompts that POPULATE the box
// on pick (language-first — never fires behind the glass), with inline add/edit/
// unlink. Opens upward (it sits just above the textarea). Closes on pick / Esc /
// outside-press (same document-pointerdown pattern as the toolbar flyouts).
//
// Data source: resolveSet(library, quickPromptIds) — only entries linked into the
// quickPrompts set are shown here. ✕ unlinks (not delete); true delete lives in
// the Context pane. "Link from library" opens LibraryPicker to link an existing
// prompt. "+ New prompt" creates + links in one step (context.add with link).
type QuickPromptsModal = { mode: "new" } | { mode: "edit"; entry: ContextEntry } | null;

function QuickPrompts({
  library,
  quickPromptIds,
  send,
  onPick,
}: {
  library: ContextEntry[];
  quickPromptIds: string[];
  send: (m: ClientToServer) => void;
  onPick: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<QuickPromptsModal>(null);
  const [showPicker, setShowPicker] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Bug 1 fix: reset picker state whenever the dropdown closes or opens so
  // reopening always shows the default prompt list, not a stale picker state.
  function openDropdown() {
    setOpen(true);
    setShowPicker(false);
  }
  function closeDropdown() {
    setOpen(false);
    setShowPicker(false);
  }

  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setOpen(false);
      setShowPicker(false);
    };
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) dismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      // Only dismiss dropdown on Escape when no modal is open (modal handles its own Escape)
      if (e.key === "Escape" && !modal) dismiss();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, modal]);

  const prompts = resolveSet(library, quickPromptIds);

  function handleModalSave(name: string, content: string) {
    if (!modal) return;
    if (modal.mode === "new") {
      send({ type: "context.add", kind: "prompt", name, content, link: "quickPrompts" });
    } else {
      send({ type: "context.update", id: modal.entry.id, name, content });
    }
    setModal(null);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => (open ? closeDropdown() : openDropdown())}
        className="chip flex items-center gap-1"
      >
        <Zap className="w-3 h-3" /> quick prompts <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-30 w-72 card p-1.5 flex flex-col gap-0.5 max-h-80 overflow-y-auto">
          {/* Bug 3 fix: hide the prompt list and action buttons while the picker
              is open so only one panel is visible at a time. The picker renders
              via a portal above, so the dropdown slot stays quiet. */}
          {!showPicker && (
            <>
              {prompts.map((p) => (
                <div key={p.id} className="flex items-center gap-1 rounded hover:bg-accent/10">
                  <button
                    type="button"
                    onClick={() => {
                      onPick(p.content);
                      closeDropdown();
                    }}
                    title={p.content}
                    className="flex-1 min-w-0 text-left px-2 py-1 text-[12px] text-ink truncate"
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    title="Edit prompt"
                    onClick={() => {
                      setModal({ mode: "edit", entry: p });
                      setOpen(false);
                    }}
                    className="shrink-0 p-1 text-faint hover:text-ink"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    title="Remove from quick prompts"
                    onClick={() => send({ type: "context.unlink", id: p.id, set: "quickPrompts" })}
                    className="shrink-0 p-1 text-faint hover:text-ink"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              <div className="flex flex-col gap-0.5 border-t border-divider mt-1 pt-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setModal({ mode: "new" });
                    setOpen(false);
                  }}
                  className="flex items-center gap-1 px-2 py-1 text-[12px] text-accent-ink"
                >
                  <Plus className="w-3 h-3" /> New prompt
                </button>
                <button
                  type="button"
                  onClick={() => setShowPicker((s) => !s)}
                  className="flex items-center gap-1 px-2 py-1 text-[12px] text-accent-ink"
                >
                  <Link className="w-3 h-3" /> Link from library
                </button>
              </div>
            </>
          )}
          {showPicker && (
            <>
              <button
                type="button"
                onClick={() => setShowPicker(false)}
                className="flex items-center gap-1 px-2 py-1 text-[12px] text-faint hover:text-ink"
              >
                <ChevronLeft className="w-3 h-3" /> back to quick prompts
              </button>
              <LibraryPicker
                inline
                library={library}
                kind="prompt"
                excludeIds={quickPromptIds}
                onPick={(id) => {
                  send({ type: "context.link", id, set: "quickPrompts" });
                  setShowPicker(false);
                }}
                onClose={() => setShowPicker(false)}
              />
            </>
          )}
        </div>
      )}

      {/* Modal — portaled, independent of dropdown open state */}
      {modal && (
        <ContentModal
          title={modal.mode === "new" ? "New prompt" : "Edit prompt"}
          initialName={modal.mode === "edit" ? modal.entry.name : ""}
          initialContent={modal.mode === "edit" ? modal.entry.content : ""}
          saveLabel={modal.mode === "new" ? "Add" : "Save"}
          onSave={handleModalSave}
          onClose={() => setModal(null)}
        />
      )}
    </div>
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
    return (
      <div className="text-center text-[11px] text-faint italic py-0.5 break-words [overflow-wrap:anywhere]">
        {m.text}
      </div>
    );
  }

  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] text-sm rounded-lg rounded-br-sm px-3 py-2 bg-accent/20 border border-accent/30 text-ink break-words [overflow-wrap:anywhere]">
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
            className={`text-sm rounded-lg rounded-tl-sm px-3 py-2 break-words [overflow-wrap:anywhere] ${
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
