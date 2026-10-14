// A small Dreamwood for the relation vocabulary's tests (kit-picker-relation-
// meanings, kit-link-check-symmetry): three locations that contrast, a
// cosmology they apply, rituals sourced from the touchstones, one misspelt
// relation (`sourced_from`) and an Operator link the export could not rewrite.
// Shaped like the real bible's links, which the write-up counts. Not exported
// from the subpath.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const VOCABULARY = {
  $comment: "The relations the world's links may carry.",
  relations: {
    "grounded-in": {
      label: "grounded in",
      inverse: "grounds",
      means: "This document rests on the target's canon.",
      symmetric: false,
    },
    applies: {
      label: "applies",
      inverse: "applied in",
      means: "Uses a framework the target defines.",
    },
    "sourced-from": {
      label: "sourced from",
      inverse: "source for",
      means: "Draws on the target.",
    },
    "contrasts-with": {
      label: "contrasts with",
      means: "Defined against the target; each sharpens the other.",
      symmetric: true,
    },
    "sister-of": { label: "sister of", means: "A peer.", symmetric: true },
  },
};

/** Write a `_meta/profiles/_relations.json` in `dir`: an object as JSON, or text as it is. */
export function writeVocabulary(dir: string, body: unknown): void {
  mkdirSync(join(dir, "_meta", "profiles"), { recursive: true });
  writeFileSync(
    join(dir, "_meta", "profiles", "_relations.json"),
    typeof body === "string" ? body : JSON.stringify(body, null, 2),
  );
}

/** Write one document under `world`, with a `type` when given; its absolute path. */
export function writeDoc(world: string, rel: string, type: string | null, body: string): string {
  const path = join(world, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${type ? `---\ntype: ${type}\n---\n` : ""}${body}`);
  return path;
}

/** The small Dreamwood, in `world`, with its vocabulary unless told not to. */
export function smallDreamwood(world: string, withVocabulary = true): void {
  if (withVocabulary) writeVocabulary(world, VOCABULARY);
  const doc = (rel: string, type: string | null, body: string) => writeDoc(world, rel, type, body);
  doc(
    "locations/the-ruin.md",
    "location",
    "# The Ruin\n\n[the Cave](./the-cave.md?rel=contrasts-with), [the Glade](./the-glade.md?rel=contrasts-with), [cosmology](../03-cosmology.md?rel=applies)\n",
  );
  doc(
    "locations/the-cave.md",
    "location",
    "# The Cave\n\n[the Ruin](./the-ruin.md?rel=contrasts-with), [the Glade](./the-glade.md?rel=contrasts-with)\n",
  );
  doc(
    "locations/the-glade.md",
    "location",
    "# The Glade\n\n[cosmology](../03-cosmology.md?rel=applies)\n",
  );
  doc("03-cosmology.md", "foundation", "# Cosmology\n\n[the overview](./00-overview.md)\n");
  doc("00-overview.md", "index", "# Overview\n\n[the Glade](./locations/the-glade.md)\n");
  doc("touchstones/00-touchstones.md", "reference", "# Touchstones\n");
  doc(
    "the-eight-marks.md",
    "ritual",
    "# The Eight Marks\n\n[touchstones](./touchstones/00-touchstones.md?rel=sourced-from), [cosmology](./03-cosmology.md?rel=applies)\n",
  );
  doc(
    "the-apprenticeship.md",
    "ritual",
    "# The Apprenticeship\n\n[touchstones](./touchstones/00-touchstones.md?rel=sourced-from), [marks](./the-eight-marks.md?rel=grounded-in)\n",
  );
  doc(
    "the-dreamwood-mark.md",
    "ritual",
    "# The Dreamwood Mark\n\n[touchstones](./touchstones/00-touchstones.md?rel=sourced_from), [Op](op:doc/123?rel=sourced-from)\n",
  );
}
