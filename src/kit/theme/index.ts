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

/** The attribute the light palette keys on; set on `<html>`. */
export const THEME_ATTRIBUTE = "data-theme";
