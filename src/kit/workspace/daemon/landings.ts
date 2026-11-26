/**
 * Where things land: a typed-over text moved onto a link rewrite
 * (`rebaseLines`), a link's `#anchor` in a document (`headingLanding`), a
 * graph request's options and edge kinds as the wire sends them, and a path
 * typed in the surface (`surfacePath`, `anchorSurfacePaths`, `expandHome`),
 * and which watcher names are dot-paths (`isDotPath`). Tier 0 of the daemon
 * parts (docs/architecture/workspace-session.md): no daemon state;
 * `server.ts` re-exports every name it exported before.
 */

import { isAbsolute, join, resolve } from "node:path";
import { findHeading, headingPlainText, lineRange } from "../../lib/headingAnchor.ts";
import { headingsOf } from "../../lib/headings.ts";
import { homeDir } from "../../lib/home.ts";
import { decodePath } from "../../lib/linkTarget.ts";
import { diffText, splitLines } from "../diff";
import { extractLinks, swapLinkTargets } from "../links";
import type { GraphOptions, HeadingLanding, StructureOp } from "../protocol";
import { SessionError } from "../session/errors.ts";

/**
 * `mine`, typed over `pre`, moved onto `post` (`pre` with the link targets in
 * `swaps` rewritten, line for line).
 *
 * - A line of `mine` unchanged from `pre` takes `post`'s line.
 * - Within a changed run of lines, a link whose target `swaps` names is
 *   rewritten only as many times as that target was written in the run's
 *   lines of `pre`: those were the links the rewrite meant (in prose a link's
 *   line is its paragraph, so typing anywhere in it changes the line). A copy
 *   typed beyond that count was written on purpose and stays.
 * - A line added or changed otherwise keeps exactly what was typed.
 *
 * `kept` names the old targets left in the result (1-based line, as written),
 * so they are said rather than silently saved. Line counts that disagree, or a
 * diff too large to walk, keep `mine` with every old target in it named.
 */
export function rebaseLines(
  pre: string,
  post: string,
  mine: string,
  swaps: ReadonlyMap<string, string>,
): { text: string; kept: { line: number; raw: string }[] } {
  const keptIn = (lines: string[], from = 0) =>
    lines.flatMap((text, i) =>
      extractLinks(text)
        .filter((l) => l.kind === "markdown" && swaps.has(l.raw))
        .map((l) => ({ line: from + i + 1, raw: l.raw })),
    );
  const postLines = splitLines(post);
  const d = splitLines(pre).length === postLines.length ? diffText(pre, mine) : null;
  if (!d || d.coarse) return { text: mine, kept: keptIn(splitLines(mine)) };
  const out: string[] = [];
  const kept: { line: number; raw: string }[] = [];
  let i = 0;
  while (i < d.lines.length) {
    const l = d.lines[i] as (typeof d.lines)[number];
    if (l.op === "same") {
      out.push(postLines[l.a as number] as string);
      i++;
      continue;
    }
    // A changed run: what `pre` had in it, and what was typed for it.
    const was: string[] = [];
    const typed: string[] = [];
    for (; i < d.lines.length && (d.lines[i] as typeof l).op !== "same"; i++) {
      const x = d.lines[i] as typeof l;
      (x.op === "del" ? was : typed).push(x.text);
    }
    const budget = new Map<string, number>();
    for (const line of was)
      for (const link of extractLinks(line))
        if (link.kind === "markdown" && swaps.has(link.raw))
          budget.set(link.raw, (budget.get(link.raw) ?? 0) + 1);
    const from = out.length;
    for (const line of typed)
      out.push(
        swapLinkTargets(line, (raw) => {
          const left = budget.get(raw) ?? 0;
          if (left === 0) return undefined;
          budget.set(raw, left - 1);
          return swaps.get(raw);
        }).text,
      );
    kept.push(...keptIn(out.slice(from), from));
  }
  return { text: out.join("\n"), kept };
}

/**
 * Is a watcher's relative name under a dot-folder or a dot-file (`.git/…`,
 * `.DS_Store`, `.obsidian/…`)? Those churn on their own (a commit, Finder, an
 * editor's state) and hold no documents the context lists, so they never cue
 * `context.changed`.
 */
export function isDotPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.startsWith("."));
}

/**
 * Where a link's `#anchor` (as written, encoded) lands in a document's text
 * (kit-heading-links-build): the heading `findHeading` finds, with its line's
 * extent, or no `found` when none matches.
 */
export function headingLanding(
  opened: { slug: string; version: number; text: string },
  rawAnchor: string,
): HeadingLanding {
  const anchor = decodePath(rawAnchor);
  const base = { anchor, doc: opened.slug, version: opened.version };
  const m = findHeading(headingsOf(opened.text), anchor);
  if (!m) return base;
  const { from, to } = lineRange(opened.text, m.heading.line);
  return {
    ...base,
    found: {
      text: headingPlainText(m.heading.text),
      line: m.heading.line,
      from,
      to,
      ...(m.ambiguous ? { ambiguous: true as const } : {}),
    },
  };
}

/**
 * A graph request's options, from a frame or a command: each part checked for
 * its type, so a string where a list belongs is refused rather than read as one
 * relation per character.
 */
export function graphOptions(raw: Record<string, unknown>): GraphOptions {
  const out: GraphOptions = {};
  const strings = (key: string): string[] | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
      throw new SessionError(`graph: ${key} must be a list of names`, 400);
    return v as string[];
  };
  const count = (key: string): number | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "number") throw new SessionError(`graph: ${key} must be a number`, 400);
    return v;
  };
  const text = (key: string): string | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v === "")
      throw new SessionError(`graph: ${key} must be a name or a path`, 400);
    return v;
  };
  const focus = text("focus");
  const within = text("within");
  const hops = count("hops");
  const limit = count("limit");
  const rel = strings("rel");
  const kind = strings("kind");
  if (focus !== undefined) out.focus = focus;
  if (within !== undefined) out.within = within;
  if (hops !== undefined) out.hops = hops;
  if (limit !== undefined) out.limit = limit;
  if (rel !== undefined) out.rel = rel;
  if (kind !== undefined) out.kind = kind;
  if (raw.untyped !== undefined) {
    if (typeof raw.untyped !== "boolean")
      throw new SessionError("graph: untyped must be true or false", 400);
    out.untyped = raw.untyped;
  }
  if (raw.kindless !== undefined) {
    if (typeof raw.kindless !== "boolean")
      throw new SessionError("graph: kindless must be true or false", 400);
    out.kindless = raw.kindless;
  }
  if (raw.bundles !== undefined) {
    if (typeof raw.bundles !== "boolean")
      throw new SessionError("graph: bundles must be true or false", 400);
    out.bundles = raw.bundles;
  }
  const edge = edgeKinds(raw.edge, "graph");
  if (edge !== undefined) out.edge = edge;
  return out;
}

/** An `edge` filter as the wire sends it (kit-link-edges-slot): a list of edge kinds, or absent. */
export function edgeKinds(v: unknown, verb: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== ""))
    throw new SessionError(`${verb}: edge must be a list of edge kinds (link, or the app's)`, 400);
  return v as string[];
}

/** A path typed in the surface. It has no working directory, so it must be absolute or start at `~`. */
export function surfacePath(p: string): string {
  const t = p.trim();
  if (t === "~" || t.startsWith("~/")) return expandHome(t);
  if (!isAbsolute(t))
    throw new SessionError(`"${p}" is not a full path: start it with / or ~/`, 400);
  return resolve(t);
}

/**
 * A structure op with every path field through `surfacePath`: from the surface,
 * and from the agent's `/cmd` too. The daemon's working directory is the folder
 * `open` ran in, which no caller named, so an empty or relative `dir`, `into` or
 * `path` is refused rather than resolved against it. The kit's CLI resolves a
 * relative path in the agent's own directory before it posts.
 */
export function anchorSurfacePaths(op: StructureOp): StructureOp {
  const out: Record<string, unknown> = { ...op };
  for (const k of ["dir", "path", "into"] as const)
    if (typeof out[k] === "string") out[k] = surfacePath(out[k] as string);
  return out as StructureOp;
}

export function expandHome(p: string): string {
  if (p === "~") return homeDir();
  if (p.startsWith("~/")) return join(homeDir(), p.slice(2));
  return resolve(p);
}
