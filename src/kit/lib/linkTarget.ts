// What a written link target says, before anything is resolved: its path (decoded),
// its query, its anchor, and the relations its `?rel=` asserts. Pure string work, no
// `node:path`, so the rendered view can read a link's relations in the browser with
// the same rule the daemon counts them by. `workspace/links.ts` re-exports these;
// resolving a target against the disk stays there.

/**
 * Percent-decoding, which a markdown link target carries whenever the file it
 * names has a space in it: `Maren's%20Bakery.md`.
 *
 * ⛔ IT MUST NOT THROW. `decodeURIComponent` rejects a lone `%`, and a file
 * called `100% done.md` is a perfectly ordinary thing to link to. An
 * undecodable target is returned as it stands: worst case it fails to resolve,
 * rather than taking the click (or a backlinks list) down with it.
 */
export function decodePath(raw: string): string {
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * What a link path is written with encoded: only what would break the link.
 * Whitespace ends a markdown destination, `(` and `)` can end it early, `<`,
 * `>`, `[` and `]` confuse the link syntax, `?` and `#` would start the query or
 * the anchor, `%` would read as an escape, and a backslash is markdown's own
 * escape. Everything else (an apostrophe, an accent) stays as typed, so the link
 * reads like the file's name. `decodePath` reverses it.
 */
const UNSAFE_IN_PATH = /[\s%()<>[\]?#\\]/gu;

/** One path segment, encoded for a markdown link target. */
export function encodeLinkSegment(segment: string): string {
  return segment.replace(UNSAFE_IN_PATH, (ch) =>
    [...new TextEncoder().encode(ch)]
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );
}

/**
 * A written target split into its path, its query and its anchor. The path is
 * decoded; the query is left as written, for whoever reads `?rel=`.
 */
export function splitTarget(raw: string): { path: string; query?: string; anchor?: string } {
  const hash = raw.indexOf("#");
  const withoutAnchor = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? undefined : raw.slice(hash + 1);
  const q = withoutAnchor.indexOf("?");
  return {
    path: decodePath((q === -1 ? withoutAnchor : withoutAnchor.slice(0, q)).trim()),
    ...(q === -1 ? {} : { query: withoutAnchor.slice(q + 1) }),
    ...(anchor ? { anchor } : {}),
  };
}

/** Anything that starts like a scheme: letters, then `:`. */
const SCHEME_LIKE = /^[a-z][a-z0-9+.-]*:/i;
/** A document's name: the workspace's DOC_EXTENSIONS (tree.ts), held equal by a test. */
export const DOC_NAME = /\.(?:md|markdown|txt|json)$/i;
/** Schemes that are always schemes, whatever follows: the ones a browser would run or load. */
const ALWAYS_A_SCHEME = /^(?:javascript|vbscript|data|file|blob|about):/i;

/**
 * A written target's scheme, lower-cased and without its colon, or undefined
 * when it names a path. One rule for the daemon's link check and the rendered
 * view's link filter, so they cannot disagree about what is a link to a file.
 *
 * Something that only looks like a scheme is a path: a colon followed by a bare
 * document name, no `/` in it (`Chapter2:intro.md`), is a file name with a
 * colon in it. `op:doc/<id>`, `https://…` and `mailto:…` stay schemes, so does
 * `op:doc/x.md`, and `javascript:`, `data:` and their kin always do.
 */
export function linkScheme(raw: string): string | undefined {
  const m = SCHEME_LIKE.exec(raw);
  if (!m) return undefined;
  const rest = raw.slice(m[0].length).split(/[?#]/)[0] ?? "";
  if (!ALWAYS_A_SCHEME.test(raw) && !rest.includes("/") && DOC_NAME.test(rest)) return undefined;
  return m[0].slice(0, -1).toLowerCase();
}

/**
 * A relation worth offering: a word or a hyphenated phrase, never prose or a
 * placeholder. A combining mark (`\p{M}`) may follow the first character, since
 * folding case can make one: `İlgili` lower-cases to `i` + U+0307 + `lgili`, and
 * the folded word must still read as a relation, written back or not.
 */
export const RELATION = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u;

/**
 * The relations in a target's query (`rel=a,b`), decoded, lower-cased, in
 * order, without repeats. Other query parameters are ignored, and so is a value
 * that is not a relation word (empty, or a placeholder like `<relationship>`).
 *
 * Case is folded on READ, as Scriptorium does (the kit-links-differential item,
 * `relCase`): `rel=Extends,extends` is one relation, `extends`, so the same
 * relation never shows up twice with different case, in a count, a filter or a
 * picker. A written link keeps its author's text; nothing rewrites a file to
 * change a relation's case.
 *
 * ⛔ A BARE LINK ASSERTS NOTHING: no `rel` is `[]`, never an implied
 * `references`. Whatever groups or draws links must not invent a claim nobody
 * made.
 */
export function parseRel(query: string | undefined): string[] {
  if (!query) return [];
  const out: string[] = [];
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq) !== "rel") continue;
    for (const raw of pair.slice(eq + 1).split(",")) {
      const v = decodePath(raw).trim().toLowerCase();
      if (RELATION.test(v) && !out.includes(v)) out.push(v);
    }
  }
  return out;
}
