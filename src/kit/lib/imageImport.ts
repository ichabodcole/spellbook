/**
 * How images brought in from outside are written (kit-image-import-settings):
 * kept as they are, or converted to WebP at a quality, and capped to a longest
 * side. An app preference, the same for every world and every session of the
 * app, kept in the app's `prefs.json` beside its sessions (the daemon's
 * `prefs`) under the three keys below. Read here by both sides: the daemon,
 * which applies it on the one import path every drop and paste goes through
 * (`optimiseImport` in `workspace/images.ts`), and the surface's settings
 * dialog, which shows and sets it.
 *
 * The defaults change nothing: keep the format, no cap.
 */

/** The prefs keys, as `prefs.json` and the snapshot's `prefs` hold them. */
export const IMAGE_PREF_KEYS = {
  format: "images.format",
  quality: "images.quality",
  maxSide: "images.max-side",
} as const;

export const IMAGE_IMPORT_FORMATS = ["keep", "webp"] as const;
export type ImageImportFormat = (typeof IMAGE_IMPORT_FORMATS)[number];

export type ImageImportSettings = {
  /** `keep`: written in the format it came in (a HEIC still becomes a JPEG); `webp`: converted. */
  format: ImageImportFormat;
  /** 1 to 100: WebP's quality, and a JPEG's when it is made smaller and kept as JPEG. */
  quality: number;
  /** The longest side, in pixels, an image is brought down to (never enlarged); null: no cap. */
  maxSide: number | null;
};

export const IMAGE_IMPORT_DEFAULTS: ImageImportSettings = {
  format: "keep",
  quality: 80,
  maxSide: null,
};

export const IMAGE_QUALITY_MIN = 1;
export const IMAGE_QUALITY_MAX = 100;
/** The smallest cap: below this a "photo" is an icon, and the setting is more likely a typo. */
export const IMAGE_MAX_SIDE_MIN = 64;
export const IMAGE_MAX_SIDE_MAX = 16384;

/** Whether the settings would change anything at all. */
export function importChangesImages(s: ImageImportSettings): boolean {
  return s.format !== "keep" || s.maxSide !== null;
}

const whole = (v: string): number | null => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/**
 * Why `value` cannot be stored under the image pref `key`, in words, or null
 * when it can (or when `key` is not one of these: other prefs are not ours).
 * The max side's "none" (or empty) means no cap.
 */
export function imagePrefRefusal(key: string, value: string): string | null {
  if (key === IMAGE_PREF_KEYS.format)
    return (IMAGE_IMPORT_FORMATS as readonly string[]).includes(value)
      ? null
      : `the image format is ${IMAGE_IMPORT_FORMATS.join(" or ")}, not ${JSON.stringify(value)}`;
  if (key === IMAGE_PREF_KEYS.quality) {
    const n = whole(value);
    return n !== null && n >= IMAGE_QUALITY_MIN && n <= IMAGE_QUALITY_MAX
      ? null
      : `the image quality is a whole number from ${IMAGE_QUALITY_MIN} to ${IMAGE_QUALITY_MAX}, not ${JSON.stringify(value)}`;
  }
  if (key === IMAGE_PREF_KEYS.maxSide) {
    if (value === "" || value === "none") return null;
    const n = whole(value);
    return n !== null && n >= IMAGE_MAX_SIDE_MIN && n <= IMAGE_MAX_SIDE_MAX
      ? null
      : `the longest side is a whole number of pixels from ${IMAGE_MAX_SIDE_MIN} to ${IMAGE_MAX_SIDE_MAX}, or none, not ${JSON.stringify(value)}`;
  }
  return null;
}

/**
 * The settings the prefs hold. A key that is absent, or holds a value that
 * would be refused (a file edited by hand), reads as its default: a bad
 * setting never converts anything it was not asked to.
 */
export function readImageImportSettings(prefs: Record<string, string>): ImageImportSettings {
  const get = (key: string): string | undefined => {
    const v = prefs[key];
    return v !== undefined && imagePrefRefusal(key, v) === null ? v : undefined;
  };
  const format = get(IMAGE_PREF_KEYS.format) as ImageImportFormat | undefined;
  const quality = get(IMAGE_PREF_KEYS.quality);
  const maxSide = get(IMAGE_PREF_KEYS.maxSide);
  return {
    format: format ?? IMAGE_IMPORT_DEFAULTS.format,
    quality: quality !== undefined ? Number(quality) : IMAGE_IMPORT_DEFAULTS.quality,
    maxSide:
      maxSide === undefined || maxSide === "" || maxSide === "none"
        ? IMAGE_IMPORT_DEFAULTS.maxSide
        : Number(maxSide),
  };
}

/** The settings as the prefs store them: three string values. */
export function imageImportPrefs(s: ImageImportSettings): Record<string, string> {
  return {
    [IMAGE_PREF_KEYS.format]: s.format,
    [IMAGE_PREF_KEYS.quality]: String(s.quality),
    [IMAGE_PREF_KEYS.maxSide]: s.maxSide === null ? "none" : String(s.maxSide),
  };
}

/** The settings in a few words: "WebP at quality 80, longest side 2048 px". */
export function describeImageImport(s: ImageImportSettings): string {
  if (!importChangesImages(s)) return "kept as they come in";
  const format = s.format === "webp" ? `WebP at quality ${s.quality}` : "in their own format";
  const cap = s.maxSide === null ? "any size" : `longest side ${s.maxSide} px`;
  return `${format}, ${cap}`;
}
