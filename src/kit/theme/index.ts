// The kit's theme: one stylesheet and the names of its layers. Import only
// `lib`; there is no runtime here beyond a path, a few constants and the
// light/dark switch.

export * from "./mode.ts";

/** The absolute path of the kit's base stylesheet, for a build that needs it by path. */
export const BASE_CSS_PATH = `${import.meta.dir}/base.css`;

/**
 * What a spell writes in its own stylesheet to adopt the kit's theme. The kit is
 * not a package here, so the specifier is relative: it resolves from a spell's
 * `src/<spell>/surface/styles.css`, where every surface keeps its sheet.
 */
export const BASE_CSS_SPECIFIER = "../../kit/theme/base.css";

/**
 * The kit's rendered-markdown sheet: the prose body, embeds, typed link chips,
 * and the note, find and flash marks the chat and document panes draw. Kept out
 * of the base sheet, which every themed spell imports, so a spell with prose
 * rules of its own is not changed by it. A page that adopts either pane imports
 * it after the base sheet.
 */
export const DOCUMENT_CSS_PATH = `${import.meta.dir}/document.css`;

/** What a spell writes in its own stylesheet to take the kit's rendered-markdown sheet. */
export const DOCUMENT_CSS_SPECIFIER = "../../kit/theme/document.css";

/**
 * The kit's shell sheet: the scan of the shell's markup (its image viewer with
 * it) and the themed scrollbars. Kept out of the base sheet, which every themed
 * spell imports, so a spell without the shell gains none of its utilities. A
 * page that adopts the shell imports it after the base sheet.
 */
export const SHELL_CSS_PATH = `${import.meta.dir}/shell.css`;

/** What a spell writes in its own stylesheet to take the kit's shell sheet. */
export const SHELL_CSS_SPECIFIER = "../../kit/theme/shell.css";

/**
 * The four layers a surface's tokens come from, lowest first. Later layers win,
 * so a spell overrides a kit token by redeclaring it in its own `@theme` (L2) and
 * again in its mode block (L3).
 */
export const THEME_LAYERS = {
  /** The kit's semantic tokens (`--color-bg`, `--color-ink`, ...), each with a default. */
  L0: "kit tokens",
  /** The shadcn aliases the kit's components read, each a var() onto an L0 token. */
  L1: "component aliases",
  /** A spell's own `@theme`. */
  L2: "spell theme",
  /** The mode override, `[data-theme="light"]`, on the same token names. */
  L3: "mode override",
} as const;

export type ThemeLayer = keyof typeof THEME_LAYERS;

/** The semantic color tokens L0 defines. A consumer may redeclare any of them. */
export const THEME_TOKENS = [
  "bg",
  "surface",
  "surface-raised",
  "edge",
  "ink",
  "ink-dim",
  "ink-faint",
  "brand",
  "on-brand",
  "attention",
  "danger",
  "added",
  "removed",
  "selected",
  "pointed",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * Optional hooks: colours a theme MAY set to restyle one use of a token without
 * remapping the token everywhere. No kit sheet declares them, and every read has
 * a fallback that draws what the kit drew before the hook existed, so a theme
 * that sets none looks as it did. Each is a full colour (a mix included), set on
 * `:root`.
 */
export const THEME_HOOKS = [
  /** A rendered link's words (the brand), and the line under them (the words' colour). */
  "link",
  "link-underline",
  /** The `stable` status chip's words (the brand) and its tint (the brand at 12%). */
  "status-stable",
  "status-stable-tint",
  /** A tree row chosen to go with the next message (the brand at 10%), and a bar at its left edge (none). */
  "ref-row",
  "ref-row-bar",
  /** The compare view's change marks (the brand at 65%), and one hovered (the brand). */
  "change-tick",
  "change-tick-hover",
  /** Find's current match (pointed at 40%), and the line under it, or the raw view's frame (pointed). */
  "find-current",
  "find-current-mark",
  /** The line under a flashed passage, or a flashed row's left bar (none). */
  "flash-mark",
  /** The human's chat message (the brand at 10%), and an edge around it (none). */
  "human-bubble",
  "human-bubble-edge",
] as const;

export type ThemeHook = (typeof THEME_HOOKS)[number];

/** The attribute the light palette keys on; set on `<html>`. */
export const THEME_ATTRIBUTE = "data-theme";
