import "../lib/registerDom.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { installDom, removeDom } from "../lib/registerDom.ts";
import {
  applyTheme,
  BASE_CSS_PATH,
  BASE_CSS_SPECIFIER,
  DOCUMENT_CSS_PATH,
  DOCUMENT_CSS_SPECIFIER,
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

  test("keeps Spellbook's palette: every L0 token holds its value in both modes", () => {
    const themeBlock = /@theme\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const lightBlock = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const value = (block: string, token: string) =>
      new RegExp(`--color-${token}:\\s*([^;]+);`).exec(block)?.[1];
    const dark = {
      bg: "#020617",
      surface: "#0f172a",
      ink: "#e2e8f0",
      edge: "#1e293b",
      "ink-faint": "#64748b",
      // Derived from that palette in the port, and Spellbook's from then on.
      "surface-raised": "#16213b",
      "ink-dim": "#94a3b8",
      brand: "#a78bfa",
      "on-brand": "#020617",
      attention: "#f59e0b",
      danger: "#f87171",
      added: "#4ade80",
      removed: "#fb7185",
      selected: "#60a5fa",
      pointed: "#e879f9",
    };
    const light = {
      bg: "#f7f6f3",
      surface: "#fdfcfa",
      ink: "#1e293b",
      edge: "#ddd8cf",
      "ink-faint": "#8b93a1",
      "surface-raised": "#efece6",
      "ink-dim": "#475569",
      brand: "#7c3aed",
      "on-brand": "#ffffff",
      attention: "#b45309",
      danger: "#b91c1c",
      added: "#15803d",
      removed: "#be123c",
      selected: "#1d4ed8",
      pointed: "#a21caf",
    };
    // Every L0 token is pinned, in both modes: a token added later fails here
    // until its values are written down too.
    expect(Object.keys(dark).sort()).toEqual([...THEME_TOKENS].sort());
    expect(Object.keys(light).sort()).toEqual([...THEME_TOKENS].sort());
    for (const [t, v] of Object.entries(dark))
      expect(value(themeBlock, t), `dark --color-${t}`).toBe(v);
    for (const [t, v] of Object.entries(light))
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

  test("scans the kit's shared markup modules by name, and not its CLI, workspace, lib or test files", () => {
    const sources = [...css.matchAll(/^@source (not )?"([^"]+)";/gm)].map((m) =>
      `${m[1] ?? ""}${m[2]}`.trim(),
    );
    expect(sources).toEqual([
      "../chat",
      "../context",
      "../theme",
      "../ui",
      "../wire",
      "not ../cli",
      "not ../workspace",
      "not ../lib",
      "not ./document.css",
      "not ../**/*.test.*",
    ]);
  });

  test("scans every kit module with markup, the document pane's through its own sheet only", () => {
    // A module holding .tsx is markup; one nobody scans ships its components
    // with none of their utilities, silently. So each is scanned by one of the
    // two sheets, and the document pane never by the base sheet, which every
    // themed spell imports: its utilities would ship to all of them.
    const kit = join(import.meta.dir, "..");
    const scans = (path: string) =>
      [...readFileSync(path, "utf8").matchAll(/^@source "([^"]+)";/gm)].map((m) =>
        resolve(dirname(path), m[1] as string),
      );
    const base = scans(BASE_CSS_PATH);
    const docs = scans(DOCUMENT_CSS_PATH);
    const reaches = (roots: string[], dir: string) =>
      roots.some((r) => dir === r || dir.startsWith(`${r}/`));
    const markup = readdirSync(kit, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(kit, e.name))
      .filter((d) => readdirSync(d).some((f) => f.endsWith(".tsx") && !f.includes(".test.")));
    const documentPane = join(kit, "document");
    expect(markup).toContain(documentPane);
    expect(markup.length).toBeGreaterThan(1);
    for (const dir of markup) {
      if (dir === documentPane) {
        expect(reaches(base, dir), "the base sheet reaches the document pane").toBe(false);
        expect(reaches(docs, dir), "document.css scans the document pane").toBe(true);
      } else {
        expect(reaches(base, dir), `the base sheet scans ${dir}`).toBe(true);
      }
    }
  });

  test("keeps its L1 aliases out of the light block", () => {
    const lightBlock = /\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(lightBlock).not.toContain("--color-popover");
  });
});

describe("the rendered-markdown sheet", () => {
  const doc = readFileSync(DOCUMENT_CSS_PATH, "utf8");
  const kit = join(import.meta.dir, "..");
  /** Every highlight name a kit module paints with (`const X_HL = "name"`). */
  const paintedNames = () =>
    ["document/MarkdownView.tsx", "document/FindBar.tsx"].flatMap((f) =>
      [...readFileSync(join(kit, f), "utf8").matchAll(/_HL = "([\w-]+)"/g)].map((m) => m[1]),
    );

  test("is where the theme says it is, and the specifier reaches it from a spell's surface", () => {
    expect(existsSync(DOCUMENT_CSS_PATH)).toBe(true);
    const surface = join(import.meta.dir, "..", "..", "scriptorium", "surface");
    expect(resolve(surface, DOCUMENT_CSS_SPECIFIER)).toBe(resolve(DOCUMENT_CSS_PATH));
  });

  test("styles every highlight the panes paint, the flash, embeds and relation chips", () => {
    const names = paintedNames();
    expect(names.sort()).toEqual([
      "doc-flash",
      "doc-note",
      "doc-note-focus",
      "doc-note-pending",
      "find-current",
      "find-match",
    ]);
    for (const n of names) expect(doc, `::highlight(${n})`).toContain(`::highlight(${n}) {`);
    expect(doc).toContain('[data-flash="on"] {');
    expect(doc).toContain(".md-prose .md-embed {");
    expect(doc).toContain(".md-prose a[data-rel]::after {");
    expect(doc).toContain(".md-prose a[data-blocked-link] {");
  });

  test("stays out of the base sheet, so a spell with prose rules of its own is unchanged", () => {
    expect(css).not.toContain(".md-prose");
    expect(css).not.toContain("::highlight(");
    expect(css).not.toContain("data-flash");
  });

  test("uses the kit's tokens, never a fixed colour", () => {
    const body = doc.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(body).toContain("var(--color-");
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
