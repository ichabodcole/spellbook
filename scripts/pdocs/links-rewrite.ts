// The link rewriter: when documents move, every relative link that pointed at
// them — and every relative link inside them — is respelled to point at the
// same thing from where it now sits.
//
// PURE: text in, text out, and a count. It reads no disk and writes none, so
// `promote`, `archive` and the migration can each decide what to read and what
// to write, and the rewriting itself is tested without a tree.
//
// It reads links with the checker's own grammar (`MARKDOWN_LINK_RE`, scanned
// over `stripCode`), so a link inside code is not rewritten and a link the
// checker would read is never missed.

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MARKDOWN_LINK_RE, stripCode } from "./docs-lint/index.ts";

/**
 * A reference-style link definition: `[label]: destination`, up to three
 * spaces of indent. Group 1 is everything before the destination; group 2 the
 * destination (pointy-bracketed or bare). The line may end there or carry a
 * title (`"…"`, `'…'`, `(…)`) — anything else after a bare word is prose, not
 * a destination. A label starting `^` is a footnote and never matches.
 */
const REFERENCE_DEFINITION_RE =
  /^( {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*)(<[^>\n]*>|[^\s<]\S*)(?=[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))?[ \t]*$)/gm;

/**
 * Where `abs` lives after the move. `moveMap` maps absolute old paths to
 * absolute new ones; a key may be a FILE or a FOLDER, and a folder carries
 * everything under it. The longest matching key wins.
 */
export function movedTo(abs: string, moveMap: ReadonlyMap<string, string>): string {
  const exact = moveMap.get(abs);
  if (exact !== undefined) return exact;
  let best: string | null = null;
  for (const key of moveMap.keys())
    if (abs.startsWith(key + sep) && (best === null || key.length > best.length)) best = key;
  return best === null ? abs : (moveMap.get(best) as string) + abs.slice(best.length);
}

/**
 * Rewrite one file's links.
 *
 * `fromFile` is where the file sits now (its links resolve against that);
 * `toFile` is where it will sit (equal to `fromFile` when it does not move).
 * A link is respelled only when its target moves or the file itself does; any
 * other link keeps its exact spelling. URLs, `mailto:`, absolute paths and
 * same-file anchors are never touched. The anchor, a trailing `/` and pointy
 * brackets survive, and a `./` prefix is kept where the new path does not
 * climb.
 */
export function rewriteLinks(
  text: string,
  fromFile: string,
  toFile: string,
  moveMap: ReadonlyMap<string, string>,
  /**
   * Whether a path exists before the move. A reference DEFINITION is rewritten
   * only when its destination is a real target — in the move map, or on disk —
   * because `[label]: word` is also how people write glossaries. Inline links
   * are always links. Defaults to "nothing exists", keeping this pure; the
   * caller that moves files passes `existsSync`.
   */
  exists: (abs: string) => boolean = () => false
): { text: string; changed: number } {
  const fileMoves = fromFile !== toFile;
  const fromDir = dirname(fromFile);
  const toDir = dirname(toFile);
  const edits: Array<{ start: number; end: number; value: string }> = [];

  const stripped = stripCode(text);
  // Inline links, and reference-style definitions (`[r]: ./x.md`). The
  // checker reads only the first form; a move still must not break the second.
  const found: Array<{ start: number; raw: string; definition?: true }> = [];
  for (const m of stripped.matchAll(MARKDOWN_LINK_RE))
    if (m[1] !== undefined && m.index !== undefined)
      // The destination's position in the ORIGINAL text: `](` is two characters.
      found.push({ start: m.index + 2, raw: m[1] });
  for (const m of stripped.matchAll(REFERENCE_DEFINITION_RE))
    if (m[2] !== undefined && m.index !== undefined)
      found.push({ start: m.index + (m[1] as string).length, raw: m[2], definition: true });
  found.sort((a, b) => a.start - b.start);

  for (const { start, raw, definition } of found) {
    const written = text.slice(start, start + raw.length);
    const pointy = /^<.*>$/.test(written.trim());
    const target = written.trim().replace(/^<(.*)>$/, "$1");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // a URL, mailto:, …
    const hash = target.indexOf("#");
    const pathPart = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? "" : target.slice(hash);
    if (pathPart === "" || isAbsolute(pathPart)) continue;

    const oldAbs = resolve(fromDir, pathPart);
    const newAbs = movedTo(oldAbs, moveMap);
    if (definition && newAbs === oldAbs && !exists(oldAbs)) continue;
    if (newAbs === oldAbs && !fileMoves) continue;

    let rel = relative(toDir, newAbs).split(sep).join("/");
    if (rel === "") rel = ".";
    if (pathPart.endsWith("/") && !rel.endsWith("/")) rel += "/";
    if (pathPart.startsWith("./") && !rel.startsWith("../") && !rel.startsWith("./"))
      rel = `./${rel}`;
    if (rel === pathPart) continue;

    const dest = pointy ? `<${rel}${anchor}>` : `${rel}${anchor}`;
    const lead = written.match(/^\s*/)?.[0] ?? "";
    const trail = written.match(/\s*$/)?.[0] ?? "";
    edits.push({ start, end: start + raw.length, value: `${lead}${dest}${trail}` });
  }

  let out = text;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.value + out.slice(e.end);
  return { text: out, changed: edits.length };
}

/**
 * Rewrite a work entity's `from:` when it is a docs-root-relative PATH (D6)
 * into something that moved. The id, `feature/<slug>`, `cycle/<slug>` and
 * `item/<slug>` forms name an entity rather than a place, so a move leaves
 * them alone. Only the frontmatter block is read; quoting and a trailing
 * comment are kept.
 */
export function rewriteFromField(
  text: string,
  docsRoot: string,
  moveMap: ReadonlyMap<string, string>
): { text: string; changed: number } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return { text, changed: 0 };
  const line = /^from:([ \t]*)(["']?)([^"'#\n]*?)\2([ \t]*(?:#.*)?)$/m.exec(fm[1] as string);
  if (!line) return { text, changed: 0 };
  const [whole, gap, quote, value, tail] = line as unknown as [string, string, string, string, string];
  if (!value.endsWith(".md") || /^(feature|cycle|item)\//.test(value) || isAbsolute(value))
    return { text, changed: 0 };
  const abs = join(docsRoot, value);
  const moved = movedTo(abs, moveMap);
  if (moved === abs) return { text, changed: 0 };
  const next = relative(docsRoot, moved).split(sep).join("/");
  const start = 4 + line.index; // past the opening `---\n`
  const replaced = `from:${gap}${quote}${next}${quote}${tail}`;
  return {
    text: text.slice(0, start) + replaced + text.slice(start + whole.length),
    changed: 1,
  };
}
