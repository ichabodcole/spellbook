import "../lib/registerDom.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installDom, removeDom } from "../lib/registerDom.ts";
import {
  applyTheme,
  BASE_CSS_PATH,
  BASE_CSS_SPECIFIER,
  readAppliedTheme,
  resolveInitialTheme,
  THEME_LAYERS,
  THEME_PREPAINT,
  THEME_STORAGE_KEY,
  THEME_TOKENS,
} from "./index.ts";

// The import registers a DOM once per process; a file that runs after another has
// removed it registers again.
beforeAll(installDom);
afterAll(removeDom);

const css = readFileSync(BASE_CSS_PATH, "utf8");

describe("the base stylesheet", () => {
  test("is where the theme says it is, and the specifier reaches it from a spell's surface", () => {
    expect(existsSync(BASE_CSS_PATH)).toBe(true);
    // Every surface keeps its sheet at src/<spell>/surface/styles.css.
    const surface = join(import.meta.dir, "..", "..", "scriptorium", "surface");
    expect(resolve(surface, BASE_CSS_SPECIFIER)).toBe(resolve(BASE_CSS_PATH));
  });

  test("keeps Spellbook's palette: the tokens it carried before the port hold their values", () => {
    const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const lightBlock = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const value = (block: string, token: string) =>
      new RegExp(`--color-${token}:\\s*([^;]+);`).exec(block)?.[1];
    const dark = { bg: "#020617", surface: "#0f172a", ink: "#e2e8f0", edge: "#1e293b" };
    const light = { bg: "#f7f6f3", surface: "#fdfcfa", ink: "#1e293b", edge: "#ddd8cf" };
    for (const [t, v] of Object.entries({ ...dark, "ink-faint": "#64748b" }))
      expect(value(themeBlock, t), `dark --color-${t}`).toBe(v);
    for (const [t, v] of Object.entries({ ...light, "ink-faint": "#8b93a1" }))
      expect(value(lightBlock, t), `light --color-${t}`).toBe(v);
  });

  test("declares every L0 token with a default, and the light mode overrides each", () => {
    const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const lightBlock = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(themeBlock).not.toBe("");
    expect(lightBlock).not.toBe("");
    for (const t of THEME_TOKENS) {
      expect(themeBlock, `@theme declares --color-${t}`).toContain(`--color-${t}:`);
      expect(lightBlock, `light overrides --color-${t}`).toContain(`--color-${t}:`);
    }
  });

  test("aliases the shadcn names onto L0 tokens, so the mode block is the only switch", () => {
    for (const alias of ["background", "primary", "popover", "border", "ring", "destructive"]) {
      expect(css).toMatch(new RegExp(`--color-${alias}: var\\(--color-`));
    }
  });

  test("scans the kit for its markup, and not its CLI module", () => {
    const sources = [...css.matchAll(/^@source (not )?"([^"]+)";/gm)].map((m) =>
      `${m[1] ?? ""}${m[2]}`.trim(),
    );
    expect(sources).toEqual(["../", "not ../cli"]);
  });

  test("keeps its L1 aliases out of the light block", () => {
    const lightBlock = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(lightBlock).not.toContain("--color-popover");
  });
});

describe("the layers", () => {
  test("are four, lowest first", () => {
    expect(Object.keys(THEME_LAYERS)).toEqual(["L0", "L1", "L2", "L3"]);
  });
});

describe("theme resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  test("a stored choice beats the OS preference, which beats dark", () => {
    expect(resolveInitialTheme("light", false)).toBe("light");
    expect(resolveInitialTheme("dark", true)).toBe("dark");
    expect(resolveInitialTheme(null, true)).toBe("light");
    expect(resolveInitialTheme(null, false)).toBe("dark");
    expect(resolveInitialTheme("purple", true)).toBe("light");
  });

  test("applyTheme sets the attribute and remembers the choice", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(readAppliedTheme()).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  test("the pre-paint script follows the same rule", () => {
    const run = (stored: string | null, prefersLight: boolean): string | undefined => {
      delete document.documentElement.dataset.theme;
      if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
      else localStorage.removeItem(THEME_STORAGE_KEY);
      const matchMedia = () => ({ matches: prefersLight });
      new Function("document", "localStorage", "matchMedia", THEME_PREPAINT)(
        document,
        localStorage,
        matchMedia,
      );
      return document.documentElement.dataset.theme as string | undefined;
    };
    expect(run("dark", true)).toBe(resolveInitialTheme("dark", true));
    expect(run(null, true)).toBe(resolveInitialTheme(null, true));
    expect(run(null, false)).toBe(resolveInitialTheme(null, false));
  });
});
