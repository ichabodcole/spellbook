/**
 * References in frontmatter, by their shape: kept on the kit path
 * (scriptorium-kit-keepers) from the shipped `links.ts`, which re-exports them
 * until the cutover deletes it.
 */

/** A reference found in frontmatter, with the key that carried it. */
export type FieldRef = { key: string; value: string };

/**
 * A value with a scheme (`https:`, `mailto:`): external, never a document.
 * The same rule as the shipped `links.ts`'s, whose copy goes at the cutover.
 */
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
/**
 * `//cdn.example.com/x`: a URL that borrows the page's scheme, so a host and
 * not a path. A browser opens it on the web (http or https), so it is neither
 * an edge nor a scheme to report.
 */
const PROTOCOL_RELATIVE = /^\/\/[^/]/;
/** The longest file or folder name a disk holds (macOS, Linux, Windows: 255). */
const NAME_MAX = 255;
/** A name's extension, as a value ending in one has it: `.md`, `.png`. */
const ENDS_IN_EXTENSION = /\.[a-z0-9]{1,8}$/i;
/** Where prose breaks: a clause mark followed by a space, or a spaced dash. */
const SENTENCE_BREAK = /[.,;:!?][ \t]|[ \t][—–][ \t]/;
/** A value that opens as a path does: `./`, `../` or `/`. */
const ANCHORED = /^(?:\.{1,2})?\//;

/**
 * Does this frontmatter value LOOK like a document reference?
 *
 * ⛔ A SLASH IN PROSE IS NOT A PATH (round three of this cycle). `graph` and
 * `dangling` threw ENAMETOOLONG on this repo's own docs/ while `doctor` called
 * it clean: a session's `description` read "… the CLI/server pair … finalize.",
 * the slash made it a reference, and the disk refused to look it up. 53 titles
 * and descriptions there were references by that rule, each a dangling link
 * nobody wrote. Story Studio's kit reads no frontmatter references at all, so
 * the rule is this one's own: a value is a reference when it could name a
 * file. Not when it has a line break or a name longer than any disk holds;
 * and when it has a space (`places/Maren's Bakery.md` does), only when it ends
 * in an extension and has no break that prose has (`, ` or ` — `).
 *
 * ⛔ AN ANCHORED VALUE IS A PATH, WHATEVER ITS PUNCTUATION (round four). The
 * prose rule then dropped references that counted before it:
 * `./notes/Chapter 1, Part 2.md`, `./notes/Dawn — Dusk.md`,
 * `./notes/my chapter.md#scene`, `../research/field notes`. Prose does not open
 * with `./`, `../` or `/`, so a value that does is a path, and only the limits
 * a disk sets (a line break, a name over 255 bytes) can refuse it. The prose
 * rule is for values without that anchor.
 */
export function looksLikeRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "" || EXTERNAL.test(v) || PROTOCOL_RELATIVE.test(v)) return false;
  if (!(v.includes("/") || v.toLowerCase().endsWith(".md"))) return false;
  if (/[\r\n]/.test(v)) return false;
  if (v.split("/").some((name) => Buffer.byteLength(name) > NAME_MAX)) return false;
  if (ANCHORED.test(v)) return true;
  if (/\s/.test(v)) return ENDS_IN_EXTENSION.test(v) && !SENTENCE_BREAK.test(v);
  return true;
}

/**
 * References inside frontmatter, whatever key carries them — `related`,
 * `supersedes`, `sources[].resource`, or a key invented tomorrow. The SHAPE
 * decides (a slash or a `.md`), which is why bare `tags` are not references.
 */
export function fieldRefs(fields: Record<string, unknown>, maxDepth = 4): FieldRef[] {
  const out: FieldRef[] = [];
  const walk = (key: string, value: unknown, depth: number) => {
    if (depth > maxDepth) return;
    if (looksLikeRef(value)) out.push({ key, value: value.trim() });
    else if (Array.isArray(value)) for (const v of value) walk(key, v, depth + 1);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        walk(`${key}.${k}`, v, depth + 1);
  };
  for (const [k, v] of Object.entries(fields)) walk(k, v, 0);
  return out;
}
