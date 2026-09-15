import { describe, expect, test } from "bun:test";
import {
  type MarkdownDeps,
  parseMarkdown,
  renderMarkdown,
  renderMd,
  SANITIZE_CONFIG,
  sanitizerIsLive,
} from "./markdown";

/**
 * ⛔ WHAT THIS FILE CAN AND CANNOT PROVE, SAID OUT LOUD.
 *
 * Bun has no DOM. `DOMPurify` without a `window` reports `isSupported === false`
 * and RETURNS ITS INPUT UNCHANGED — so a cell here asserting "a script tag is
 * stripped" would pass against a sanitiser that is not running, which is the
 * exact failure this port must not ship. The assertion below is therefore about
 * the COMPOSITION (the sanitiser wraps the parser, in that order, with this
 * config), and it is one of three guards:
 *
 *   1. this file        — the composition, with both dependencies injected
 *   2. `sinks.test.ts`  — no HTML sink in this surface is fed by anything else
 *   3. the browser drive — real attack payloads through both sinks, in Chrome
 *      (behaviour inventory M1)
 */

const spies = () => {
  const calls: string[] = [];
  const deps: MarkdownDeps = {
    parse: (md) => {
      calls.push(`parse(${md})`);
      return `<parsed>${md}</parsed>`;
    },
    sanitize: (html, config) => {
      calls.push(`sanitize(${html},${JSON.stringify(config)})`);
      return `<clean>${html}</clean>`;
    },
  };
  return { calls, deps };
};

describe("renderMarkdown — the composition IS the security boundary", () => {
  test("the sanitiser wraps the parser, never the other way round", () => {
    const { calls, deps } = spies();
    const out = renderMarkdown("# hi", deps);
    expect(calls).toEqual([
      "parse(# hi)",
      `sanitize(<parsed># hi</parsed>,${JSON.stringify(SANITIZE_CONFIG)})`,
    ]);
    expect(out).toBe("<clean><parsed># hi</parsed></clean>");
  });

  test("the sanitiser's output is what is returned — nothing is appended after it", () => {
    const { deps } = spies();
    expect(renderMarkdown("x", { ...deps, sanitize: () => "SAFE" })).toBe("SAFE");
  });

  test("a sanitiser that strips everything yields an empty string, not the parse", () => {
    const { deps } = spies();
    expect(renderMarkdown("<script>alert(1)</script>", { ...deps, sanitize: () => "" })).toBe("");
  });

  test("the config is the old page's, exactly", () => {
    expect(SANITIZE_CONFIG).toEqual({ USE_PROFILES: { html: true } });
  });

  test("the sanitiser is called EXACTLY once per render — no unsanitised second path", () => {
    let n = 0;
    const { deps } = spies();
    renderMarkdown("a\n\nb", {
      ...deps,
      sanitize: (h) => {
        n++;
        return h;
      },
    });
    expect(n).toBe(1);
  });
});

describe("parseMarkdown — the half bun CAN exercise (marked needs no DOM)", () => {
  test("marked@12 stock options: a single newline is NOT a <br> (inventory M8)", () => {
    expect(parseMarkdown("a\nb")).not.toContain("<br");
    expect(parseMarkdown("# h")).toContain("<h1");
    expect(parseMarkdown("```js\nconst x = 1;\n```")).toContain("<code");
  });

  test("the qblock marker survives as a top-level div, and the next heading is NOT swallowed (M7)", () => {
    // review.ts surrounds the marker with blank lines precisely so marked reads
    // it as a self-contained CommonMark type-6 HTML block. Without the trailing
    // blank line the raw HTML swallows the next heading — that is the bug the
    // blank lines exist to prevent, asserted here rather than trusted.
    const out = parseMarkdown('text\n\n<div data-qblock="scope"></div>\n\n# after');
    expect(out).toContain('data-qblock="scope"');
    expect(out).toContain("<h1");
  });

  test("marked emits raw HTML verbatim — which is exactly why the sanitiser is not optional", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toContain("<script>");
    expect(parseMarkdown('<img src=x onerror="alert(1)">')).toContain("onerror");
  });
});

describe("the sanitiser, under bun", () => {
  test("⚠ IT IS NOT LIVE HERE, AND renderMd THROWS RATHER THAN PASSING TEXT THROUGH", () => {
    // Outside a browser `dompurify`'s default export is the FACTORY, so
    // `.sanitize` is undefined. The failure is LOUD — a surface that lost its
    // sanitiser dies on the first document instead of rendering an attack.
    // If this ever reports live, Bun grew a DOM and the composition cells above
    // can be upgraded to real stripping assertions.
    expect(sanitizerIsLive()).toBe(false);
    expect(() => renderMd("# hi")).toThrow();
  });
});
