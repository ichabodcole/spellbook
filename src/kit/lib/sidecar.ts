/**
 * An image's description: a markdown document beside it, named for the whole
 * file (`fox.png` has `fox.png.md`), of `type: image`. Its body says what the
 * image shows; its flat frontmatter says where the image came from (`source`)
 * and the fields that origin records.
 *
 * The sidecar is an ordinary document, so versions, Compare, search, links and
 * profiles already work on it. What is special is only how it is SHOWN: the
 * tree folds it into its image's row, and the viewer shows it beside the image.
 * The rules for both live here, pure (no `node:`), so the daemon and the
 * surface cannot disagree about which file describes which image.
 */

import { IMAGE_EXTENSIONS, isImageName } from "./docFormat.ts";

/** What a sidecar adds to its image's name. */
export const SIDECAR_SUFFIX = ".md";

/** The sidecar's name or path for an image's: `fox.png` gives `fox.png.md`. */
export function sidecarOf(image: string): string {
  return `${image}${SIDECAR_SUFFIX}`;
}

const SIDECAR_NAME = new RegExp(
  `(?:${IMAGE_EXTENSIONS.map((e) => e.replace(".", "\\.")).join("|")})\\.md$`,
  "i",
);

/** Whether a name has a sidecar's shape: an image's name, then `.md`. */
export function isSidecarName(name: string): boolean {
  return SIDECAR_NAME.test(name);
}

/**
 * The image a sidecar's name or path describes (`fox.png.md` gives `fox.png`),
 * or null for any other name. Says nothing about whether that image exists.
 */
export function imageOfSidecar(name: string): string | null {
  if (!isSidecarName(name)) return null;
  const image = name.slice(0, -SIDECAR_SUFFIX.length);
  return isImageName(image) ? image : null;
}

// ── provenance ──────────────────────────────────────────────────────────────

/**
 * Where an image came from: the user's own, or the web. A `source` written as
 * anything else is kept as written (`sourceWritten`), with no fields listed.
 */
export const IMAGE_SOURCES = ["user", "web"] as const;
export type ImageSource = (typeof IMAGE_SOURCES)[number];

/**
 * The fields each origin records, in the order they are shown. Flat, one value
 * each, so the frontmatter reads as plain text.
 */
export const PROVENANCE_FIELDS: Readonly<Record<ImageSource, readonly string[]>> = {
  user: ["original-name", "added-at"],
  web: ["url", "image-url", "credit", "licence", "fetched-at"],
};

/** How each origin's mark is named, for its hover and for a screen reader. */
export const SOURCE_LABEL: Readonly<Record<ImageSource, string>> = {
  user: "The user's own image",
  web: "From the web",
};

/** The licence written when none was found: never left out. */
export const LICENCE_UNKNOWN = "unknown";

/** The most of a description's body the snapshot carries; the document has the rest. */
export const DESCRIPTION_BODY_CAP = 1200;

/** One provenance field as the viewer lists it. */
export type ProvenanceField = { field: string; value: string };

/** An image's description as the viewer shows it, read from its sidecar. */
export type ImageDescription = {
  /** The sidecar's absolute path: the document "Edit description" opens. */
  path: string;
  title: string | null;
  /** The frontmatter's `description`: the one-line summary. */
  summary: string | null;
  /** The body, trimmed, cut at DESCRIPTION_BODY_CAP. */
  body: string;
  /** The body was longer than what `body` holds. */
  more?: true;
  /** The origin, when it is one the kit knows; null when absent or unrecognised. */
  source: ImageSource | null;
  /** `source` as written when it is not one the kit knows, so the hover can say so. */
  sourceWritten?: string;
  /** The origin's fields that are present, in the table's order. */
  provenance: ProvenanceField[];
  /** A web image's source page, when it is an http or https address: what the globe opens. */
  page?: string;
  /** A web image whose licence is `unknown` or missing: shown amber. */
  licenceUnknown?: true;
  /** The frontmatter would not parse: said, and the body still shown. */
  unparsed?: string;
};

/** A frontmatter value as one line of text: a list joined, a scalar as written. */
export function fieldText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const parts = v.map(fieldText).filter((s): s is string => s !== null && s !== "");
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** An http or https address, or null: the only kind of page the globe opens. */
export function webPage(raw: string | null): string | null {
  if (!raw) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a browser ignores these when it resolves a URL, so they are dropped before the scheme is read.
  const bare = raw.replace(/[\u0000-\u0020]/g, "");
  if (!/^https?:\/\//i.test(bare)) return null;
  try {
    const url = new URL(bare);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * What the viewer shows of a sidecar, from its parsed frontmatter (`fields`,
 * null when there is none or it does not parse) and its body.
 */
export function describeSidecar(
  path: string,
  fields: Readonly<Record<string, unknown>> | null,
  body: string,
  unparsed?: string | null,
): ImageDescription {
  const f = fields ?? {};
  const written = fieldText(f.source);
  const source = (IMAGE_SOURCES as readonly string[]).includes(written ?? "")
    ? (written as ImageSource)
    : null;
  const provenance: ProvenanceField[] = [];
  if (source)
    for (const field of PROVENANCE_FIELDS[source]) {
      const value = fieldText(f[field]);
      if (value !== null) provenance.push({ field, value });
    }
  const trimmed = body.trim();
  const cut = trimmed.length > DESCRIPTION_BODY_CAP;
  const licence = fieldText(f.licence);
  const page = source === "web" ? webPage(fieldText(f.url)) : null;
  return {
    path,
    title: fieldText(f.title),
    summary: fieldText(f.description),
    body: cut ? `${trimmed.slice(0, DESCRIPTION_BODY_CAP).trimEnd()}…` : trimmed,
    ...(cut ? { more: true as const } : {}),
    source,
    ...(written !== null && source === null ? { sourceWritten: written } : {}),
    provenance,
    ...(page ? { page } : {}),
    ...(source === "web" && (licence === null || licence.toLowerCase() === LICENCE_UNKNOWN)
      ? { licenceUnknown: true as const }
      : {}),
    ...(unparsed ? { unparsed } : {}),
  };
}

/** Today as the sidecar writes a date: `2026-10-04`. */
const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * A new sidecar's text for `imageName`: `type: image`, a title from the name,
 * an empty description, `source` and that origin's fields, and a body to fill
 * in. What `describe-image` writes before the agent writes the description as
 * a version. A field nobody knows yet is written empty, so it is there to fill;
 * a web licence starts `unknown`, never absent.
 */
export function sidecarSkeleton(
  imageName: string,
  source: ImageSource,
  now: Date = new Date(),
): string {
  const stem = imageName.replace(/\.[^.]+$/, "");
  const title = stem.replace(/[-_]+/g, " ").trim() || stem;
  const known: Record<string, string> = {
    "original-name": imageName,
    "added-at": today(now),
    licence: LICENCE_UNKNOWN,
  };
  const quote = (s: string) => JSON.stringify(s);
  const lines = [
    "---",
    "type: image",
    `title: ${quote(title)}`,
    'description: ""',
    `source: ${source}`,
    ...PROVENANCE_FIELDS[source].map((k) => {
      const v = source === "user" || k === "licence" ? known[k] : undefined;
      return `${k}: ${v === undefined ? '""' : quote(v)}`;
    }),
    "---",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * "Ask the agent to describe": the chat message, naming the image and the
 * sidecar the description goes in. The image itself rides along as what the
 * message is about.
 */
export function askDescribeText(imageShown: string, imageName: string): string {
  return `Please describe ${imageShown}: look at the image and write what it shows in its description, ${sidecarOf(imageName)}.`;
}
