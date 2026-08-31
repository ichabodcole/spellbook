// surface/components/annotations/style.ts
// The user-chosen draw style for annotations. These are deliberately NOT theme
// chrome — they're the colors the user marks WITH — so named values are fine.
// `accent`/`amber` reuse theme tokens (amber = the default unset look).

export type DrawStyle = { color?: string; width?: number; fontSize?: number };

export const COLORS: { name: string; value: string }[] = [
  { name: "accent", value: "var(--color-accent)" },
  { name: "red", value: "#ef4444" },
  { name: "blue", value: "#3b82f6" },
  { name: "green", value: "#22c55e" },
  { name: "amber", value: "var(--color-attention)" },
  { name: "white", value: "#ffffff" },
];

export const WIDTHS: { name: string; value: number }[] = [
  { name: "S", value: 2 },
  { name: "M", value: 4 },
  { name: "L", value: 8 },
];

// Pin/note text sizes in px — big jumps (~1.7×) so S is a subtle note and L is a
// real headline. Used both for the size flyout previews and the rendered label.
export const TEXT_SIZES: { name: string; value: number }[] = [
  { name: "S", value: 14 },
  { name: "M", value: 24 },
  { name: "L", value: 40 },
];

// Fallback label size for pins with no fontSize (older marks).
export const DEFAULT_TEXT_SIZE = 14;

// Max width of a note, as a fraction of the image box, so a long label wraps
// instead of sprawling across the image. Image-relative → it scales with zoom
// like fontSize does (the rendered box stays welded). Shared by the rendered pin
// (CSS %) and the editor (measured px), so editing wraps where the note will.
export const PIN_MAX_W_FRACTION = 0.45;

// The style new marks start with: amber (= the default-look color, so marks look
// the same as before) at L width (the largest), shown ring-selected on load, and
// S text. Marks always carry a width, so the old "unset renders bigger than L"
// quirk is gone.
export const DEFAULT_DRAW_STYLE: DrawStyle = {
  color: COLORS.find((c) => c.name === "amber")?.value,
  width: WIDTHS.find((w) => w.name === "L")?.value,
  fontSize: TEXT_SIZES.find((t) => t.name === "S")?.value,
};

// Defaults when a mark carries no color/width (older marks). Stroke widths are
// authored px "at 100% zoom" and multiplied by the viewport scale at render so
// marks weld to the image.
export const DEFAULT_STROKE = "var(--color-attention)";
export const DEFAULT_WIDTH = 2;
