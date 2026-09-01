import { cn } from "../lib/cn";

/**
 * Dot — the status/presence dot five surfaces had each drawn by hand (a
 * width+height pair, `rounded-full`, and a tone class): mind-mapper App.tsx,
 * imago Header ×2 and LayersPanel, magpie MagpieShell, astrolabe PresenceDot.
 *
 * ⛔ NO COMMENT IN THIS DIRECTORY MAY SPELL A CLASS THE CODE DOES NOT PLACE.
 * The mechanism is the last paragraph of this header; the enforcement is
 * grimoire/kit-prose-ward.test.ts. `rounded-full` is written out because the
 * code below genuinely places it — which is also what keeps that ward's
 * "used in both code and prose, must stay green" route live in the tree.
 *
 * Slice 3's rule: prefer the MOST BORING shared module, never the most
 * valuable one. This is the most boring thing five surfaces agreed on.
 *
 * THE FILL IS THE CALLER'S. A dot's colour is the caller's meaning
 * ("connected", "the agent needs you") and it is spell-local vocabulary —
 * mind-mapper's story-local fill and imago's positive fill do not exist in
 * each other's spells (and naming either one here would ship BOTH to BOTH), so
 * a kit component cannot own the fill without inventing a status taxonomy this
 * phase has no mandate for. The DEFAULT tone is L0 (`ink-faint`), which imago
 * does not define and therefore inherits from ../theme/base.css — that
 * inheritance is what makes the kit's stylesheet load-bearing rather than
 * decorative.
 *
 * ⚠ A 1px RIM ON THE L0 EDGE TOKEN WAS BUILT AND WITHHELD — Cole's call, not
 * this seat's. It would have made the "same file, two computed colours" proof
 * theme-INDEPENDENT (`--color-edge` is #1e293b in mind-mapper and #2e2640 in
 * imago, in both palettes), because `edge` is the only shared token whose value
 * genuinely differs between the two spells — they happen to agree on tertiary
 * ink. But `box-sizing: border-box` means a 1px rim shrinks an 8px dot's
 * visible fill to 6px on two SHIPPED surfaces, and that is something a human
 * SEES. Measured side by side and visible. Restoring it is one line here; the
 * override proof meanwhile lives mechanically in the ward's divergence cell,
 * which compares the emitted token values and needs no rendering at all.
 *
 * ⛔ NO L1 SHADCN ALIAS. Nothing here may reach a utility built on a shadcn
 * alias token — a fill, ink or rim carrying `--color-accent`, `--color-popover`
 * or `--color-muted` &c — see the header of ../theme/base.css for why that
 * would put a 95-site rename on this phase's critical path. (This rule used to
 * spell those three utilities out, and thereby SHIPPED all three to every
 * adopting spell: the muted fill was a real rule in imago's stylesheet that
 * imago's own source never asked for. The alias TOKEN names are safe to write —
 * a custom property is not a Tailwind candidate.)
 *
 * The square-size shorthand below is deliberate and is NOT a synonym swap for
 * the width+height pair every hand-written dot uses: it is the sentinel the
 * built-CSS ward keys on, and nothing else in the roster spells it that way.
 *
 * ⛔ THIS COMMENT MUST NOT WRITE THAT CLASS OUT — NOR ANY OTHER THE CODE DOES
 * NOT PLACE. Tailwind scans source as LITERAL TEXT and cannot tell prose from
 * code. So a comment naming the sentinel KEEPS IT EMITTED after the code stops
 * using it, which makes the built-CSS ward unfalsifiable; and a comment naming
 * a class the code NEVER used ships that class to every spell that imports
 * ../theme/base.css. Measured twice: the sentinel survived its own deletion
 * from this file on the strength of the paragraph that used to sit here; and
 * eight utilities were named only in this header, three of which were LIVE
 * rules in a shipped stylesheet (imago 347 -> 346 class selectors, mind-mapper
 * 390 -> 388, when this header was rewritten). The other five were one theme
 * token away from joining them. Enforced now, not remembered.
 */
export function Dot({
  tone = "bg-ink-faint",
  pulse = false,
  className,
  title,
}: {
  /** Fill class — the caller's status vocabulary. Defaults to the L0 rim colour
   *  so an unspecified dot reads as "nothing to report" rather than invisible.
   *  `ink-faint` is the kit's own L0 default and imago does not define it —
   *  which is precisely what makes the kit's stylesheet load-bearing there. */
  tone?: string;
  pulse?: boolean;
  className?: string;
  /** Native tooltip. Preserved because imago's connection dot already had one —
   *  adopting a component must not silently drop an affordance. */
  title?: string;
}) {
  return (
    <span
      aria-hidden
      title={title}
      className={cn("size-2 shrink-0 rounded-full", tone, pulse && "animate-pulse", className)}
    />
  );
}
