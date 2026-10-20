// enforces: none in house-style — the shell cycle's scriptorium-kit-keepers (2026-10-19): the flagged Scriptorium borrows nothing from the shipped one, so the cutover can delete it
//
// THE KIT-PATH WARD. No file on Scriptorium's kit path
// (`src/scriptorium/backend/kit/`, `src/scriptorium/surface/kit/`, tests and
// fixtures included) imports the shipped Scriptorium: anything else under
// `src/scriptorium/`. The kit (`src/kit/`), packages and builtins are allowed;
// the kit path's two folders may import each other.
//
// Why: the cutover deletes the shipped backend and surface. Until
// scriptorium-kit-keepers the flagged path imported them in nine places
// (frontmatter, protocol types, `gitRootOf`, `fieldRefs`, `forceLayout`,
// `statusMark`, the shipped stylesheet, and tests building fixtures with the
// shipped `Session`), so deleting them would have broken it. Those pieces now
// live on the kit path; this ward keeps a new import from bringing one back.
// The direction it does NOT police is the other one: the shipped code may
// import the kit path (its `frontmatter.ts`, `protocol.ts`, `session.ts` and
// `links.ts` re-export what moved), because the shipped side is what goes.
//
// What it reads, in the house style of `import-boundary-wards.test.ts` (its
// scanner, `lib/import-graph.ts`, and its rules for what a scan can miss):
// - every relative specifier in a `.ts`/`.tsx` file, of every kind (`static`,
//   type-only, `type` queries and `dynamic`), resolved against its importer;
// - every `@import` in a `.css` file, the way the frame's stylesheet once
//   reached the shipped one (`@import "../styles.css"`), and every `@source`
//   (a sheet that SCANS the shipped surface borrows its classes as surely);
//   a `@source not` excludes, so it may name anything;
// - every `src` and `href` in an `.html` page (the frame's `index.html`: its
//   script and its stylesheet), a data: or absolute URL aside.
//
// And the other direction, which no import shows: the SHIPPED sheet must not
// scan the kit path, or every class the frame or the shell writes grows the
// shipped stylesheet. Its `@source not "./kit"` is what stops that, and the
// last cell builds a copy of the shipped sheet (and of the kit page's) with
// the real Tailwind plugin, over a probe class planted only in a `kit/`
// folder: the shipped build must not carry it, the kit page's must.
//
// ⛔ KNOWN LIMITS. A computed path is not a specifier, so the scanner cannot
// see it: `import(join(...))` (the frame's dev page, `FRAME_DEV_ENTRY`, which
// names the kit path's own page), and a file READ by path rather than imported
// (`readFileSync(join(dir, "../components/…"))`, which a test here did until
// this item). The import-graph header lists the scanner's other blind spots
// (template-literal and concatenated specifiers, a parenthesised `require`).
// Review catches those.
//
// ── CALIBRATION ─────────────────────────────────────────────────────────────
//   zero-guard   `SCRIPTORIUM_KIT_PATHS=/abs/empty/dir bun test <this> -t ZERO`
//                must FAIL: a ward that walked nothing is not green.
//   violation    Add `import { Session } from "../session";` to any file in
//                `src/scriptorium/backend/kit/` (or `@import "../styles.css";`
//                to `surface/kit/styles.css`) and run this file: the escape
//                cell reddens and names the file, the specifier and where it
//                lands. Both were run for this ward's first commit; so were
//                `@source "../components"` in `surface/kit/theme.css` and
//                `<script src="../main.tsx">` in `surface/kit/index.html`.
//                Also red: an UNQUOTED `src=../main.tsx` in the page, and
//                `@reference "../styles.css"` in `kit/theme.css` (both cells:
//                the escape, and the shipped control leaking into the kit sheet).
//   the scan     Delete `@source not "./kit"` from `surface/styles.css`: the
//                probe cell reddens (the probe class is in the shipped build).
//   not a leak   A kit-local `url("./x.svg")` with the file beside it stays
//                green; one with no file says "THE BUILD BROKE (not a leak)".
//
// ⚠ ACCEPTED DEBT: `surface/kit/theme.css` is a copy of the shipped
// `surface/styles.css`, and nothing here holds the twins equal. A palette change
// is made in both until the cutover deletes the shipped one.

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import { isRelative, scanSpecifiers } from "./lib/import-graph.ts";

const REPO_ROOT =
  process.env.SPELLBOOK_REPO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The spell's source: everything here that is not the kit path is the shipped code. */
const SCRIPTORIUM = resolve(REPO_ROOT, "src", "scriptorium");

/** The kit path's folders. Overridable (comma-separated, absolute) for calibration. */
const KIT_PATHS: string[] = (
  process.env.SCRIPTORIUM_KIT_PATHS ??
  [join(SCRIPTORIUM, "backend", "kit"), join(SCRIPTORIUM, "surface", "kit")].join(",")
)
  .split(",")
  .map((p) => resolve(REPO_ROOT, p));

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** `null` when a folder does not exist: absent is not empty (the house's zero-guard rule). */
function sources(dir: string): string[] | null {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (statSync(p).isDirectory()) {
        if (name !== "node_modules" && name !== "dist") walk(p);
      } else if (/\.(ts|tsx|css|html)$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

/** Every match of `re` in `code`: its first group that matched, with its line. */
function matches(code: string, re: RegExp): { spec: string; line: number }[] {
  return [...code.matchAll(re)].map((m) => ({
    spec: m.slice(1).find((g) => g !== undefined) as string,
    line: code.slice(0, m.index).split("\n").length,
  }));
}

/**
 * The relative paths a file names: the import scanner's for code, `@import`,
 * `@reference` and `@source` (not `@source not`) for a sheet, and `src` and
 * `href` for a page, quoted or not (an unquoted `src=../main.tsx` is HTML too).
 */
function specifiers(file: string): { spec: string; line: number }[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".css")) {
    // Comments first, so a sheet that DESCRIBES its old import is not read as one.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    return [
      ...matches(code, /@(?:import|reference)\s+(?:url\(\s*)?["']([^"']+)["']/g),
      ...matches(code, /@source\s+(?!not\b)(?:inline\(\s*)?["']([^"']+)["']/g),
    ].filter((r) => isRelative(r.spec));
  }
  if (file.endsWith(".html")) {
    const code = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
    return matches(code, /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g).filter(
      (r) => isRelative(r.spec),
    );
  }
  return scanSpecifiers(text)
    .filter((r) => isRelative(r.spec))
    .map((r) => ({ spec: r.spec, line: r.line }));
}

/** Every import on the kit path that lands in the shipped Scriptorium. */
function escapes(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files)
    for (const { spec, line } of specifiers(file)) {
      const target = resolve(dirname(file), spec);
      if (!inside(target, SCRIPTORIUM)) continue; // the kit, or anything not this spell
      if (KIT_PATHS.some((k) => inside(target, k))) continue; // the kit path itself
      out.push(`${relative(REPO_ROOT, file)}:${line} -> ${spec} (${relative(REPO_ROOT, target)})`);
    }
  return out.sort();
}

describe("Scriptorium's kit path borrows nothing from the shipped Scriptorium", () => {
  const walked = KIT_PATHS.map((k) => ({ dir: k, files: sources(k) }));

  test("ZERO-GUARD: each kit-path folder exists and was walked", () => {
    for (const { dir, files } of walked) {
      expect({ dir: relative(REPO_ROOT, dir), present: files !== null }).toEqual({
        dir: relative(REPO_ROOT, dir),
        present: true,
      });
      expect(files?.length ?? 0).toBeGreaterThan(0);
    }
    // A sheet and a page are in the population too, or those halves are vacuous.
    expect(walked.some(({ files }) => files?.some((f) => f.endsWith(".css")))).toBe(true);
    expect(walked.some(({ files }) => files?.some((f) => f.endsWith(".html")))).toBe(true);
  });

  test("no import on the kit path lands in the shipped backend or surface", () => {
    expect(escapes(walked.flatMap(({ files }) => files ?? []))).toEqual([]);
  });

  test("the rule reaches what it claims: a shipped target is an escape, the kit and the kit path are not", () => {
    // Synthetic, so the predicate is calibrated whatever the tree holds today.
    const from = join(KIT_PATHS[0] as string, "x.ts");
    const lands = (spec: string) => {
      const target = resolve(dirname(from), spec);
      return inside(target, SCRIPTORIUM) && !KIT_PATHS.some((k) => inside(target, k));
    };
    if (process.env.SCRIPTORIUM_KIT_PATHS) return; // calibration runs move the roots
    expect(lands("../session")).toBe(true);
    expect(lands("../../surface/components/context/model")).toBe(true);
    expect(lands("../../surface/styles.css")).toBe(true);
    expect(lands("./frontmatter")).toBe(false);
    expect(lands("../../surface/kit/statusMark")).toBe(false);
    expect(lands("../../../kit/workspace/anchors")).toBe(false);
  });
});

describe("the shipped sheet does not scan the kit path", () => {
  // A copy of the real sheets in a temp tree that mirrors `src/`, with the kit
  // (`src/kit`) and `node_modules` linked in so every import resolves, built
  // with the real Tailwind plugin. The whole `surface/kit/` folder is copied,
  // so a sheet's kit-local asset (`url("./x.svg")`) resolves as it does in the
  // real build, and a red means a leak, not a missing file. Two probe classes:
  // one in the shipped surface (a control: the build scans there), one in a
  // `kit/` folder only. A build that breaks says so, apart from a leak.
  const SURFACE = join(SCRIPTORIUM, "surface");

  test("a class written only on the kit path is in the kit page's sheet and not the shipped one", async () => {
    if (process.env.SCRIPTORIUM_KIT_PATHS) return; // calibration runs move the roots
    const t = mkdtempSync(join(tmpdir(), "kit-path-ward-"));
    try {
      symlinkSync(join(REPO_ROOT, "node_modules"), join(t, "node_modules"));
      const surface = join(t, "src", "scriptorium", "surface");
      mkdirSync(surface, { recursive: true });
      symlinkSync(join(REPO_ROOT, "src", "kit"), join(t, "src", "kit"));
      copyFileSync(join(SURFACE, "styles.css"), join(surface, "styles.css"));
      cpSync(join(SURFACE, "kit"), join(surface, "kit"), { recursive: true });
      writeFileSync(join(surface, "control.tsx"), 'export const c = "bg-[#0a0b0c]";\n');
      writeFileSync(join(surface, "kit", "probe.tsx"), 'export const p = "bg-[#0d0e0f]";\n');
      const sheet = async (entry: string) => {
        const which = relative(surface, entry);
        let r: Awaited<ReturnType<typeof Bun.build>>;
        try {
          r = await Bun.build({
            entrypoints: [entry],
            plugins: [tailwind],
            outdir: join(t, "out", which.replaceAll("/", "_")),
          });
        } catch (e) {
          const inner = (e as { errors?: unknown[] }).errors?.map(String).join("; ");
          throw new Error(`THE BUILD BROKE (not a leak): ${which}: ${inner || String(e)}`);
        }
        if (!r.success)
          throw new Error(`THE BUILD BROKE (not a leak): ${which}: ${r.logs.join("; ")}`);
        return (await r.outputs[0]?.text()) ?? "";
      };
      const shipped = await sheet(join(surface, "styles.css"));
      const kit = await sheet(join(surface, "kit", "styles.css"));
      // A LEAK, not a broken build, if either of these is red.
      expect({
        sheet: "shipped",
        control: shipped.includes("0a0b0c"),
        kitProbeLeaked: shipped.includes("0d0e0f"),
      }).toEqual({ sheet: "shipped", control: true, kitProbeLeaked: false });
      expect({
        sheet: "kit",
        shippedControlLeaked: kit.includes("0a0b0c"),
        probe: kit.includes("0d0e0f"),
      }).toEqual({ sheet: "kit", shippedControlLeaked: false, probe: true });
    } finally {
      rmSync(t, { recursive: true, force: true });
    }
  }, 60_000);
});
