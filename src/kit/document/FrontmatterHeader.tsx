// A document's frontmatter, shown rather than dumped: a row of chips, the
// description as a paragraph, the tags, and every other key as a labelled value.
// It sits above the rendered body and outside it, so nothing here is part of the
// rendered text a selection or a note is resolved against.
//
// WHAT THE KIT KNOWS BY NAME IS A SHORT LIST, AND EVERYTHING ELSE IS STILL SHOWN.
// `type`, `status`, `lifecycle`, `verified` (as a trust chip, when the app
// keeps it on and the document has the key), `title`, `description` and `tags`
// get their own treatment; any other key, including one
// invented tomorrow, is listed with its value. An app adds or restyles chips for
// its own keys through `chips` (the pane's `frontmatterChips` slot), and a key a
// chip names leaves the list.
//
// A DOCUMENT'S PROFILE, WHEN IT HAS ONE. Given the daemon's `profile` answer, the
// `type` chip shows the profile's label ("Location") and names its file on hover,
// and the profile's warnings collapse into one amber chip at the end of the row
// (`ProfileChip`). A document with no profile renders exactly as without one.
import { BadgeCheckIcon, TriangleAlertIcon, UserCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import type { DocumentProfile } from "../workspace/protocol";
import {
  type Frontmatter,
  generatedAt,
  listField,
  showValue,
  stringField,
  trustTier,
} from "./frontmatter.ts";
import { type AskProfileFix, ProfileChip } from "./ProfileChip.tsx";
import { profileFits, withProfileLabel } from "./profileHeader.ts";

/**
 * How a chip is coloured, in theme tokens. `faint` is bare text (a date), `outline`
 * is a tag, and `none` adds nothing, for an app that styles a chip wholly through
 * its `className` (the classes are joined, not merged, so a tone and a class that
 * set the same property do not decide between them).
 */
export type ChipTone =
  | "plain"
  | "dim"
  | "faint"
  | "outline"
  | "brand"
  | "attention"
  | "danger"
  | "none";

/** One chip in the header's first row. */
export type FrontmatterChip = {
  /**
   * The frontmatter key the chip shows, left out of the field list. A dotted key
   * (`generated.at`) claims one entry of a mapping: the rest of it is still listed,
   * and the row goes when nothing is left.
   */
  key?: string;
  label: ReactNode;
  tone?: ChipTone;
  /** Classes added after the tone's, for an app's own look. */
  className?: string;
  /** Hover text. */
  title?: string;
};

/**
 * The pane's chip slot: given the fields and the kit's own chips, the chips to show.
 * Return `chips` with yours added to add some, a mapped copy to restyle one, or a
 * filtered copy to drop one.
 */
export type FrontmatterChips = (
  fields: Readonly<Record<string, unknown>>,
  chips: readonly FrontmatterChip[],
) => readonly FrontmatterChip[];

const TONE: Record<ChipTone, string> = {
  plain: "px-1.5 font-medium bg-surface-raised text-ink",
  dim: "px-1.5 font-medium bg-surface-raised text-ink-dim",
  faint: "text-ink-faint",
  outline: "px-1.5 font-medium bg-bg text-ink-dim ring-1 ring-edge",
  brand: "px-1.5 font-medium bg-brand/12 text-brand",
  attention: "px-1.5 font-medium bg-attention/15 text-attention",
  danger: "px-1.5 font-medium bg-danger/15 text-danger",
  none: "",
};

/** The tone of a `status` value: the three common ones, and anything else plain. */
const STATUS_TONE: Record<string, ChipTone> = {
  draft: "attention",
  stable: "brand",
  deprecated: "danger",
};

/** The key is in the block, whatever its value (`verified: []` still says something). */
function hasField(fields: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(fields, key) && fields[key] !== null && fields[key] !== undefined;
}

/** Keys the header shows in its own way, chip or not; the rest are listed. */
const NAMED = new Set(["title", "description", "tags"]);

/** What the kit's chips include. */
export type DefaultChipOptions = {
  /**
   * The trust chip, derived from `verified`. On by default, and even on it shows only
   * for a document that has a `verified` key: a document that never says reads as
   * nothing, not as "unverified", which sounds like a judgement on it. An app whose
   * documents do not use the key (Atlas) turns it off, and `verified` is then listed
   * with the other fields.
   */
  trust?: boolean;
};

/**
 * The kit's chips for a block's fields: type, status (coloured by value), lifecycle,
 * trust, and the date from `generated.at`. A key that is absent has no chip.
 */
export function defaultChips(
  fields: Readonly<Record<string, unknown>>,
  { trust: showTrust = true }: DefaultChipOptions = {},
): FrontmatterChip[] {
  const chips: FrontmatterChip[] = [];
  const type = stringField(fields, "type");
  if (type) chips.push({ key: "type", label: type, tone: "plain" });
  const status = stringField(fields, "status");
  if (status)
    chips.push({ key: "status", label: status, tone: STATUS_TONE[status.toLowerCase()] ?? "dim" });
  const lifecycle = stringField(fields, "lifecycle");
  if (lifecycle) chips.push({ key: "lifecycle", label: lifecycle, tone: "dim" });
  if (showTrust && hasField(fields, "verified")) {
    const trust = trustTier(fields);
    chips.push({
      key: "verified",
      title: "Derived from the verified key",
      tone: "dim",
      label: (
        <>
          {trust === "human-reviewed" ? (
            <UserCheckIcon aria-hidden className="size-3" />
          ) : trust === "machine-confirmed" ? (
            <BadgeCheckIcon aria-hidden className="size-3" />
          ) : null}
          {trust}
        </>
      ),
    });
  }
  const date = generatedAt(fields);
  if (date) chips.push({ key: "generated.at", label: date, tone: "faint", title: "generated at" });
  return chips;
}

/**
 * The fields no chip or named treatment claimed, as rows. A mapping loses the
 * entries a dotted key claimed, and a mapping with nothing left loses its row.
 */
function unclaimed(
  fields: Readonly<Record<string, unknown>>,
  claimed: ReadonlySet<string>,
): [string, unknown][] {
  const rows: [string, unknown][] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (claimed.has(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const rest = Object.entries(v as Record<string, unknown>).filter(
        ([sub]) => !claimed.has(`${k}.${sub}`),
      );
      if (rest.length > 0) rows.push([k, Object.fromEntries(rest)]);
      continue;
    }
    rows.push([k, v]);
  }
  return rows;
}

function Chip({ chip }: { chip: FrontmatterChip }) {
  return (
    <span
      data-chip={chip.key}
      title={chip.title}
      className={cn(
        "inline-flex items-center gap-1 rounded-sm py-0.5 text-[11px]",
        TONE[chip.tone ?? "dim"],
        chip.className,
      )}
    >
      {chip.label}
    </span>
  );
}

/**
 * What in a drawn header shows `key` (`frontmatterKeyAt`'s answer): its chip, a
 * chip on one of its entries (`generated.at` for `generated`), its paragraph, its
 * tags, or its row. With none (an empty key, a block that would not parse, or a
 * key the header shows nowhere, like `title`), the header itself, so a reveal in
 * the frontmatter always marks something.
 */
export function headerFieldElements(header: HTMLElement, key: string): HTMLElement[] {
  const hits =
    key === ""
      ? []
      : [...header.querySelectorAll<HTMLElement>("[data-field], [data-chip]")].filter((el) => {
          const field = el.getAttribute("data-field");
          const chip = el.getAttribute("data-chip");
          return field === key || chip === key || (chip?.startsWith(`${key}.`) ?? false);
        });
  return hits.length > 0 ? hits : [header];
}

export function FrontmatterHeader({
  frontmatter,
  chips: chipSlot,
  trust = true,
  profile,
  onAskProfileFix,
}: {
  frontmatter: Frontmatter;
  chips?: FrontmatterChips;
  /** Show the trust chip for a document with a `verified` key: see `DefaultChipOptions`. */
  trust?: boolean;
  /**
   * The document's profile, as the daemon answered `profile`. Null, absent, or
   * `match: "none"` changes nothing. It is applied to the kit's chips before
   * the app's slot sees them, so an app restyling the `type` chip gets the label.
   */
  profile?: DocumentProfile | null;
  /** "Ask the agent to fix": posts the message as the human's. */
  onAskProfileFix?: AskProfileFix;
}) {
  const { fields, error, raw } = frontmatter;

  if (error)
    return (
      <header
        data-slot="frontmatter-header"
        data-invalid=""
        className="mb-6 flex flex-col gap-2 border-b border-edge pb-4 text-sm"
      >
        <pre className="overflow-x-auto rounded-md bg-surface-raised px-3 py-2 font-mono text-xs text-ink-dim">
          {raw}
        </pre>
        <p className="flex items-start gap-1.5 text-xs text-ink-faint">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-3 shrink-0 text-attention" />
          <span>The frontmatter could not be read, so it is shown as written: {error}</span>
        </p>
      </header>
    );

  const fits = profileFits(profile, fields) ? profile : null;
  const base = withProfileLabel(defaultChips(fields, { trust }), fits);
  const chips = chipSlot ? chipSlot(fields, base) : base;
  const profileChip = fits ? <ProfileChip profile={fits} onAsk={onAskProfileFix} /> : null;
  const claimed = new Set([...NAMED, ...chips.flatMap((c) => (c.key ? [c.key] : []))]);
  const description = stringField(fields, "description");
  const tags = [...new Set(listField(fields, "tags"))];
  const others = unclaimed(fields, claimed);

  return (
    <header
      data-slot="frontmatter-header"
      className="mb-6 flex flex-col gap-2 border-b border-edge pb-4 text-sm"
    >
      {(chips.length > 0 || profileChip) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: chips have no identity beyond their place, and an app's may share a key.
            <Chip key={i} chip={c} />
          ))}
          {profileChip}
        </div>
      )}

      {description && (
        <p data-field="description" className="text-ink-dim">
          {description}
        </p>
      )}

      {tags.length > 0 && (
        <div data-field="tags" className="flex flex-wrap items-center gap-1">
          {tags.map((t) => (
            <Chip key={t} chip={{ label: `#${t}`, tone: "outline" }} />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {others.map(([k, v]) => (
            <div key={k} className="contents">
              <dt data-field={k} className="font-mono text-ink-faint">
                {k}
              </dt>
              <dd data-field={k} className="min-w-0 break-words text-ink-dim">
                {showValue(v)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </header>
  );
}
