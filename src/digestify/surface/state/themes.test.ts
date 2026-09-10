import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME, resolveThemeName, THEMES, themeFor } from "./themes";

describe("the theme table (inventory T2, T3, T11)", () => {
  test("exactly the three names review.ts accepts", () => {
    expect(Object.keys(THEMES).sort()).toEqual(["classic", "cthulhu", "digestify"]);
  });

  test("⚠ the theme called `digestify` loads from the assets/classic/ folder", () => {
    // The single most likely wiring mistake in this port. An agent assuming
    // /assets/<theme>/ gets two of the three wrong and nothing red says so.
    for (const src of [
      THEMES.digestify.logoSrc,
      THEMES.digestify.mascotSrc,
      THEMES.digestify.sentMascotSrc,
    ]) {
      expect(src.startsWith("/assets/classic/")).toBe(true);
    }
  });

  test("⚠ the theme called `classic` loads NOTHING — every asset field is empty", () => {
    expect(THEMES.classic.logoSrc).toBe("");
    expect(THEMES.classic.mascotSrc).toBe("");
    expect(THEMES.classic.sentMascotSrc).toBe("");
  });

  test("cthulhu is the one theme whose folder matches its name", () => {
    for (const src of [
      THEMES.cthulhu.logoSrc,
      THEMES.cthulhu.mascotSrc,
      THEMES.cthulhu.sentMascotSrc,
    ]) {
      expect(src.startsWith("/assets/cthulhu/")).toBe(true);
    }
  });

  test("every asset path names a file that actually ships", async () => {
    // The citation check the playbook asks for: an inventory that names a path
    // is asserting the path exists. `assets/` is inside the tracked skill
    // subtree the marketplace copies, so these resolve at the destination too.
    const root = new URL("../../../../plugins/spellbook/skills/digestify/", import.meta.url);
    for (const theme of Object.values(THEMES)) {
      for (const src of [theme.logoSrc, theme.mascotSrc, theme.sentMascotSrc]) {
        if (src === "") continue;
        const file = Bun.file(new URL(`.${src}`, root));
        expect(await file.exists()).toBe(true);
      }
    }
  });

  test("submit / submitting copy differs per theme", () => {
    expect(THEMES.digestify.submit).toBe("Digest it");
    expect(THEMES.digestify.submitting).toBe("Digesting...");
    expect(THEMES.cthulhu.submitting).toBe("Summoning...");
    expect(THEMES.classic.submit).toBe("Submit");
    expect(THEMES.classic.submitting).toBe("Submitting...");
  });

  test("stamp lines: cthulhu two (the second small), digestify one, classic none", () => {
    expect(THEMES.cthulhu.stampLines).toEqual([
      { text: "Eldritch" },
      { text: "knowledge", small: true },
    ]);
    expect(THEMES.digestify.stampLines).toEqual([{ text: "nom nom" }]);
    expect(THEMES.classic.stampLines).toEqual([]);
  });
});

describe("resolveThemeName (inventory T4)", () => {
  test("a known name passes through", () => {
    expect(resolveThemeName("cthulhu")).toBe("cthulhu");
    expect(resolveThemeName("classic")).toBe("classic");
  });

  test("an unknown name falls back to digestify, silently", () => {
    expect(resolveThemeName("nope")).toBe(DEFAULT_THEME);
    expect(resolveThemeName("")).toBe(DEFAULT_THEME);
    expect(resolveThemeName(undefined)).toBe(DEFAULT_THEME);
  });

  test("a prototype key is not a theme (a DELIBERATE deviation — see T4)", () => {
    // The old page tests `themes[payload.theme]` for truthiness, so
    // `theme:"toString"` finds Object.prototype.toString, passes, and renders a
    // wordmark reading "undefined". `Object.hasOwn` closes it. Unreachable
    // through review.ts, which validates --theme before building the payload.
    expect(resolveThemeName("toString")).toBe(DEFAULT_THEME);
    expect(resolveThemeName("constructor")).toBe(DEFAULT_THEME);
    expect(themeFor("__proto__").brand).toBe("Digestify");
  });
});
