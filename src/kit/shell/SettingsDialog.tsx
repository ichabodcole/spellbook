// The app's settings, from the top bar: for now how images brought in are
// written (kit-image-import-settings). App preferences, the same for every world
// and every session of the app: the daemon keeps them in the app's `prefs.json`
// and applies them itself, so the dialog only shows them and sends a change.

import { useEffect, useId, useState } from "react";
import { cn } from "../lib/cn.ts";
import {
  IMAGE_PREF_KEYS,
  IMAGE_QUALITY_MAX,
  IMAGE_QUALITY_MIN,
  type ImageImportFormat,
  imageImportPrefs,
  imagePrefRefusal,
  readImageImportSettings,
} from "../lib/imageImport.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/index.ts";

const BUTTON =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50";
const FIELD =
  "h-7 w-20 rounded-md border border-edge bg-bg px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 aria-invalid:border-attention";

/** A draft of the settings as the fields hold them: text, until saved. */
type Draft = { format: ImageImportFormat; quality: string; capped: boolean; maxSide: string };
/** A setting the dialog shows, as `IMAGE_PREF_KEYS` names it. */
type Field = keyof typeof IMAGE_PREF_KEYS;

const draftOf = (prefs: Record<string, string>): Draft => {
  const s = readImageImportSettings(prefs);
  return {
    format: s.format,
    quality: String(s.quality),
    capped: s.maxSide !== null,
    maxSide: s.maxSide === null ? "2048" : String(s.maxSide),
  };
};

export function SettingsDialog({
  open,
  onOpenChange,
  prefs,
  send,
  connected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The app's prefs, as the snapshot carries them. */
  prefs: Record<string, string>;
  send: (msg: { op: "prefs.set"; key: string; value: string }) => void;
  /** Whether the daemon can hear a change: Save waits on it. */
  connected: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(prefs));
  /**
   * The settings the human has changed since opening. Only these are sent on
   * Save, and only the others follow the prefs while the dialog is open: the
   * agent may change one meanwhile, and a stale field must not undo it.
   */
  const [touched, setTouched] = useState<ReadonlySet<Field>>(() => new Set());
  const edit = (field: Field, change: Partial<Draft>) => {
    setTouched((t) => (t.has(field) ? t : new Set([...t, field])));
    setDraft((d) => ({ ...d, ...change }));
  };
  // Opened afresh, the fields show what is set now, not an abandoned draft.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on opening
  useEffect(() => {
    if (!open) return;
    setDraft(draftOf(prefs));
    setTouched(new Set());
  }, [open]);
  // While open, what the human has not touched follows the prefs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on the prefs only
  useEffect(() => {
    if (!open) return;
    const now = draftOf(prefs);
    setDraft((d) => ({
      format: touched.has("format") ? d.format : now.format,
      quality: touched.has("quality") ? d.quality : now.quality,
      capped: touched.has("maxSide") ? d.capped : now.capped,
      maxSide: touched.has("maxSide") ? d.maxSide : now.maxSide,
    }));
  }, [prefs]);
  const ids = { quality: useId(), capped: useId(), maxSide: useId() };
  const qualityWhy = imagePrefRefusal(IMAGE_PREF_KEYS.quality, draft.quality.trim());
  const maxSideWhy = draft.capped
    ? imagePrefRefusal(IMAGE_PREF_KEYS.maxSide, draft.maxSide.trim() || "x")
    : null;
  const valid = qualityWhy === null && maxSideWhy === null;
  const save = () => {
    if (!valid) return;
    const next = imageImportPrefs({
      format: draft.format,
      quality: Number(draft.quality.trim()),
      maxSide: draft.capped ? Number(draft.maxSide.trim()) : null,
    });
    for (const field of touched) {
      const key = IMAGE_PREF_KEYS[field];
      const value = next[key] as string;
      if (prefs[key] !== value && !(prefs[key] === undefined && isDefault(key, value)))
        send({ op: "prefs.set", key, value });
    }
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="settings-dialog"
        className="border border-edge bg-surface text-ink sm:max-w-md"
      >
        <DialogTitle className="text-sm font-semibold text-ink">Settings</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed text-ink-dim">
          For this app, the same in every world.
        </DialogDescription>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <fieldset data-slot="image-import-settings" className="grid gap-2.5">
            <legend className="mb-1 text-xs font-semibold tracking-wide text-ink-faint uppercase">
              Images you drop or paste in
            </legend>
            <div role="radiogroup" aria-label="Format" className="grid gap-1.5">
              {(
                [
                  ["keep", "Keep the format they come in"],
                  ["webp", "Convert to WebP"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="radio"
                    name="image-format"
                    value={value}
                    checked={draft.format === value}
                    onChange={() => edit("format", { format: value })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm text-ink">
              <label htmlFor={ids.quality} className="w-28 shrink-0">
                Quality
              </label>
              <input
                id={ids.quality}
                data-field="quality"
                inputMode="numeric"
                className={FIELD}
                value={draft.quality}
                aria-invalid={qualityWhy !== null}
                onChange={(e) => edit("quality", { quality: e.target.value })}
              />
              <span className="text-xs text-ink-faint">
                {IMAGE_QUALITY_MIN} to {IMAGE_QUALITY_MAX}, for WebP and a JPEG made smaller
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-ink">
              <input
                id={ids.capped}
                type="checkbox"
                data-field="capped"
                checked={draft.capped}
                onChange={(e) => edit("maxSide", { capped: e.target.checked })}
              />
              <label htmlFor={ids.capped} className="w-[5.6rem] shrink-0">
                Limit size
              </label>
              <label htmlFor={ids.maxSide} className="sr-only">
                Longest side, in pixels
              </label>
              <input
                id={ids.maxSide}
                data-field="max-side"
                inputMode="numeric"
                className={FIELD}
                value={draft.maxSide}
                disabled={!draft.capped}
                aria-invalid={maxSideWhy !== null}
                onChange={(e) => edit("maxSide", { maxSide: e.target.value })}
              />
              <span className="text-xs text-ink-faint">px on the longest side, never enlarged</span>
            </div>
            {(qualityWhy ?? maxSideWhy) && (
              <p role="alert" className="text-xs text-ink">
                {qualityWhy ?? maxSideWhy}.
              </p>
            )}
            <p className="text-xs leading-relaxed text-ink-faint">
              Every image brought in loses its camera details and location, converted or not; an
              image kept as it came keeps its pixels exactly and still shows upright. A converted
              image is turned upright first. Animated images, AVIF, and images that would be no
              smaller are not converted, and an AVIF keeps its metadata. The file you dropped is
              never changed.
            </p>
          </fieldset>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className={cn(BUTTON, "border border-edge bg-surface text-ink hover:bg-bg")}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || !connected}
              className={cn(BUTTON, "border border-brand bg-brand text-on-brand hover:opacity-90")}
            >
              Save
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Whether `value` is what an absent `key` already reads as: not written, so a file stays empty. */
function isDefault(key: string, value: string): boolean {
  const d = imageImportPrefs(readImageImportSettings({}));
  return d[key] === value;
}
