import { Check, FolderPlus, ShieldCheck } from "lucide-react";
import { type ChangeEvent, type KeyboardEvent, useEffect, useState } from "react";
import { Button } from "./Button";

// Register a project. Posts to the daemon's /cmd (the same write path the cli
// uses) so the daemon derives id + avatar and enforces dedupe — one source of
// truth, no slug/avatar logic mirrored here. The new card arrives via the WS
// state push; we just surface a rejection inline. Dismiss: Escape, Cancel, or
// the backdrop (a real <button> so it's keyboard-accessible, not a click-only div).
const INPUT =
  "w-full rounded-control border border-edge-strong bg-surface-2 px-3 py-2 text-sm text-ink-strong placeholder:text-faint-2 focus:border-accent focus:outline-none";
const LABEL = "text-xs font-medium text-muted";

type Draft = { name: string; path: string; description: string; avatar: string };
const EMPTY: Draft = { name: "", path: "", description: "", avatar: "" };

export function AddProjectModal({
  open,
  onClose,
  projectCount,
}: {
  open: boolean;
  onClose: () => void;
  projectCount: number;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(EMPTY);
      setError("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (k: keyof Draft) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => ({ ...d, [k]: e.target.value }));

  const register = async () => {
    if (busy) return;
    setError("");
    const name = draft.name.trim();
    const path = draft.path.trim();
    if (!name || !path) {
      setError("Name and path are both required.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/cmd", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "project.add",
          as: "user",
          project: {
            name,
            path,
            description: draft.description.trim() || undefined,
            avatar: draft.avatar.trim() || undefined,
          },
        }),
      });
      const r = (await res.json()) as { applied?: boolean; error?: string };
      if (r.applied) onClose();
      else setError(r.error || "Could not register that project.");
    } catch {
      setError("Request failed — is the daemon still running?");
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") register();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 py-16">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
      />
      <div className="relative rounded-card border border-edge bg-surface/60 shadow-sm w-full max-w-lg p-5">
        <div className="mb-4 flex items-center gap-2">
          <FolderPlus className="w-5 h-5 text-accent-ink" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-ink-strong">Register a project</h2>
        </div>
        <p className="text-muted text-sm mb-4">
          Registering only adds the card; an agent{" "}
          <span className="font-mono text-xs text-muted">join</span>ing later is what brings it
          online.
        </p>
        <div className="space-y-4">
          <div>
            <label className={LABEL} htmlFor="ap-name">
              Name
            </label>
            <input
              id="ap-name"
              className={`${INPUT} mt-1`}
              placeholder="Imago Layers"
              value={draft.name}
              onChange={set("name")}
              onKeyDown={onEnter}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="ap-path">
              Path
            </label>
            <input
              id="ap-path"
              className={`${INPUT} mt-1 font-mono text-xs`}
              placeholder="~/Projects/imago"
              value={draft.path}
              onChange={set("path")}
              onKeyDown={onEnter}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="ap-desc">
              Description <span className="text-faint">· optional</span>
            </label>
            <textarea
              id="ap-desc"
              rows={2}
              className={`${INPUT} mt-1 resize-none`}
              placeholder="What is this project?"
              value={draft.description}
              onChange={set("description")}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="ap-avatar">
              Avatar{" "}
              <span className="text-faint">
                · optional emoji — auto-seeded from the name if blank
              </span>
            </label>
            <input
              id="ap-avatar"
              className={`${INPUT} mt-1`}
              placeholder="🔭"
              maxLength={4}
              value={draft.avatar}
              onChange={set("avatar")}
            />
          </div>
          <div className="p-3 flex items-start gap-2 rounded-control border border-edge bg-surface-2/50">
            <ShieldCheck className="w-4 h-4 text-positive mt-0.5" aria-hidden="true" />
            <div className="text-xs text-muted">
              Checked against <strong className="text-ink">{projectCount}</strong> existing projects
              — a duplicate name or path is rejected.
            </div>
          </div>
          {error && (
            <div className="rounded-control border border-danger-strong/40 bg-danger-surface/30 p-3 text-sm text-danger-ink">
              {error}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={register}>
            <Check className="w-4 h-4" aria-hidden="true" /> {busy ? "Registering…" : "Register"}
          </Button>
        </div>
      </div>
    </div>
  );
}
