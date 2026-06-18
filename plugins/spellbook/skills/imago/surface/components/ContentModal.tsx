import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ContentModalProps {
  title: string;
  initialName: string;
  initialContent: string;
  saveLabel?: string;
  onSave: (name: string, content: string) => void;
  onClose: () => void;
}

export function ContentModal({
  title,
  initialName,
  initialContent,
  saveLabel = "Save",
  onSave,
  onClose,
}: ContentModalProps) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const nameRef = useRef<HTMLInputElement>(null);

  // Focus name input on mount
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSave = name.trim().length > 0 && content.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave(name.trim(), content.trim());
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop as a button — avoids noStaticElementInteractions lint */}
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className="absolute inset-0 w-full h-full bg-black/60 cursor-default"
        style={{ border: "none", padding: 0 }}
      />

      {/* Panel — stop propagation so panel clicks don't close */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation guard, not interactive */}
      <div
        className="relative z-10 card flex flex-col gap-4 p-5 w-[min(32rem,92vw)] max-w-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {/* Heading */}
        <h2 className="text-sm font-semibold text-ink-strong">{title}</h2>

        {/* Name input */}
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="modal-name">
            Name
          </label>
          <input
            id="modal-name"
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Entry name"
            className="w-full bg-surface-2 border border-edge-2 text-sm text-ink px-3 py-2 rounded-lg placeholder-faint focus:outline-none focus:border-accent/60"
          />
        </div>

        {/* Content textarea — large, resize-y */}
        <div className="flex flex-col gap-1">
          <label className="label" htmlFor="modal-content">
            Content
          </label>
          <textarea
            id="modal-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Enter content…"
            rows={10}
            className="textarea resize-y"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="chip">
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="btn-primary !px-4 !py-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saveLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
