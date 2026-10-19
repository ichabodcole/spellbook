/**
 * The worlds on disk that the captured fixtures beside this file were written
 * over, one place for both the capture (`../../kitFixtures.capture.ts`, on the
 * shipped side, which runs the shipped `Session`) and the kit tests that read
 * what it captured (scriptorium-kit-keepers). A test lays the same world down
 * in its own temp folder and compares against the capture, so the kit path
 * never imports the shipped code.
 *
 * Pure data: each reader writes the files itself (a test into its temp root,
 * the capture into its own), so nothing on this path writes to disk.
 *
 * Placeholders in the captured JSON: `@ROOT@` (the world's temp root),
 * `@DOCS@` (its documents folder) and `@TODAY@` (the capture's date, which a
 * suggested block carries as `generated.at`).
 */
/** `suggestMeta.test.ts`'s documents, under `<root>/docs`. */
export const SUGGEST_WORLD: Readonly<Record<string, string>> = {
  // Neighbours that say: two `decision`, one `memo`, so the majority wins.
  "notes/a.md": "---\ntype: decision\n---\n# A\n",
  "notes/b.md": "---\ntype: decision\n---\n# B\n",
  "notes/c.md": "---\ntype: memo\n---\n# C\n",
  "notes/bare.md": "# The bare one\n\nBody.\n",
  // A neighbour whose block will not parse says nothing.
  "notes/broken.md": "---\ntype: [unclosed\n---\n# Broken\n",
  // Nobody beside it says: the folder's name, de-pluralised.
  "stories/tale.md": "Prose before any heading.\n\n# Not the title\n",
  "categories/one.md": "# One: a title that needs quoting\n",
  // A tie between neighbours: the name that sorts first.
  "tie/x.md": "---\ntype: zeta\n---\n",
  "tie/y.md": "---\ntype: alpha\n---\n",
  "tie/z.md": "# Zed\n",
  // Already has a block, readable or not: refused, both ways.
  "notes/has.md": "---\ntitle: Has\n---\n# Has\n",
  "notes/bad.md": "---\n: : :\n---\n# Bad\n",
  "solo.md": "# Solo\n",
};

/** The documents `suggestMeta` answers for, and the two it refuses. */
export const SUGGESTED = [
  "notes/bare.md",
  "stories/tale.md",
  "categories/one.md",
  "tie/z.md",
  "solo.md",
] as const;
export const REFUSED = ["notes/has.md", "notes/bad.md"] as const;

/** `convert.test.ts`'s world: `<root>/docs/{set/a.md,solo.md}` and `<root>/ws/w.md`. */
export const CONVERT_WORLD: Readonly<Record<string, string>> = {
  "docs/set/a.md": "# A\n\none\n",
  "docs/solo.md": "# Solo\n",
  "ws/w.md": "# W\n",
};
