// The link check, for the human: a mark in the status bar when the session has
// links that answer nothing or file names that collide, and a list behind it.
//
// In the status bar because the check is about the whole session, not one
// document or one folder: it sits beside the connection mark, where a glance
// finds it in Atlas and in Sound Stage alike, and every app built on the shell
// gets it without asking. A set's context menu would hide it until someone
// thought to look; a toast would say it once and then be gone. And because a
// clean session shows NOTHING here, a story or a script without links gains no
// chrome at all.
//
// It draws what the daemon answered (`link.check`) and decides nothing about it.
// Each entry is a button that opens its source at the link, through the same
// `openAt` path search results and backlinks use. Nothing here renames: a shared
// name shows the name it could take, and the rename stays the human's.

import { Link2OffIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ServerFrame } from "../context/daemonClient.ts";
import { cn } from "../lib/cn.ts";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover.tsx";
import type {
  CheckedEdgeView,
  CheckedLinkView,
  ClientOp,
  LeavingLinkView,
  LinkCheck as LinkCheckData,
} from "../workspace/protocol";

/**
 * The pause after a cue before asking: a burst of cues (typing, a snapshot per
 * keystroke's write) is one ask. Longer than backlinks' pause, since this reads
 * the whole session.
 */
export const LINK_CHECK_PAUSE_MS = 1200;

/**
 * A long fallback ask. The daemon's `context.changed` covers changes on disk,
 * but a folder it cannot watch (gone, permissions, some network disks) is
 * silent; this bounds how long the mark can be wrong there.
 */
export const LINK_CHECK_FALLBACK_MS = 300_000;

/**
 * Everything the list has to show: the link problems (`count`), the images
 * nothing links to or embeds, the symmetric relations written one way, and the
 * links leaving their set, which the daemon counts apart because none of them
 * is a broken link.
 */
export const linkCheckTotal = (d: LinkCheckData): number =>
  d.count +
  d.unusedImages.count +
  d.symmetry.count +
  d.ambiguousHeadings.count +
  (d.leaving?.count ?? 0);

/**
 * Everything the list shows: the sign's total, and the app's references
 * nothing answers that are not written as paths (`LinkCheck.unresolved`),
 * which the sign does not count: the kit cannot tell a broken one from one
 * another tool resolves.
 */
export const linkCheckListed = (d: LinkCheckData): number =>
  linkCheckTotal(d) + (d.unresolved?.count ?? 0);

/**
 * The app's word for a set (`LinkCheck.noun`, from `WorkspaceDaemonOptions.linkCheck`),
 * else `folder`: the kit names none of its own.
 */
const nounOf = (d: LinkCheckData) => d.noun ?? "folder";

/** "frontmatter reference", or "reference" for edges of more than one kind. */
const edgeNoun = (kinds: readonly string[]) =>
  kinds.length === 1 ? `${kinds[0]} reference` : "reference";

/** "1 shared name", "12 unsupported links": both forms written out. */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the status bar says, in the popover's order: the sections that have
 * something. The same words as the doctor's findings.
 */
export function linkCheckLabel(d: LinkCheckData): string {
  const parts: string[] = [];
  if (d.duplicates.count > 0)
    parts.push(count(d.duplicates.count, "shared file name", "shared file names"));
  if (d.dangling.count > 0) parts.push(count(d.dangling.count, "broken link", "broken links"));
  if (d.proposed && d.proposed.count > 0)
    parts.push(
      count(
        d.proposed.count,
        "broken link in a proposed version",
        "broken links in proposed versions",
      ),
    );
  if (d.references.count > 0)
    parts.push(count(d.references.count, "broken reference", "broken references"));
  if (d.edges && d.edges.count > 0) {
    const noun = edgeNoun(d.edges.kinds);
    parts.push(count(d.edges.count, `broken ${noun}`, `broken ${noun}s`));
  }
  if (d.unsupported.count > 0)
    parts.push(count(d.unsupported.count, "unsupported link", "unsupported links"));
  if (d.headings.count > 0)
    parts.push(count(d.headings.count, "link to a missing heading", "links to a missing heading"));
  // Only for an app that asks for them, in its word: "1 leaving the set".
  if (d.leaving && d.leaving.count > 0) parts.push(`${d.leaving.count} leaving the ${nounOf(d)}`);
  if (d.unusedImages.count > 0)
    parts.push(
      count(
        d.unusedImages.count,
        "image nothing links to or embeds",
        "images nothing links to or embeds",
      ),
    );
  if (d.symmetry.count > 0)
    parts.push(count(d.symmetry.count, "one-way symmetric link", "one-way symmetric links"));
  if (d.ambiguousHeadings.count > 0)
    parts.push(
      count(d.ambiguousHeadings.count, "link to a repeated heading", "links to a repeated heading"),
    );
  return parts.join(", ");
}

const ENTRY =
  "group/entry w-full rounded-md px-2 py-1 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60";

function LinkEntry({
  link,
  note,
  onOpen,
}: {
  link: CheckedLinkView;
  /** A short line under the link: where it looked. */
  note?: string;
  onOpen: (link: CheckedLinkView) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-slot="link-check-entry"
        data-source={link.source}
        data-line={link.line}
        onClick={() => onOpen(link)}
        title={`Open ${link.shown} at line ${link.line}`}
        className={ENTRY}
      >
        <span className="flex items-baseline gap-1.5 text-[12px]">
          <span className="truncate text-ink group-hover/entry:text-brand">{link.shown}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
            line {link.line}
          </span>
        </span>
        <span className="block truncate font-mono text-[11px] text-ink-dim" data-slot="raw">
          {link.raw}
        </span>
        {note && <span className="block truncate text-[10px] text-ink-faint">{note}</span>}
      </button>
    </li>
  );
}

/** A broken app edge (a frontmatter reference): opens its source where it is written. */
function EdgeEntry({
  edge,
  unresolved,
  onOpen,
}: {
  edge: CheckedEdgeView;
  /** Not written as a path: listed, not broken (`LinkCheck.unresolved`). */
  unresolved?: boolean;
  onOpen: (path: string, at?: { from: number; to: number }) => void;
}) {
  const at =
    edge.from !== undefined && edge.to !== undefined ? { from: edge.from, to: edge.to } : undefined;
  return (
    <li>
      <button
        type="button"
        data-slot="link-check-entry"
        data-edge={edge.edge}
        data-unresolved={unresolved ? "" : undefined}
        data-source={edge.source}
        data-line={edge.line}
        onClick={() => onOpen(edge.source, at)}
        title={edge.line ? `Open ${edge.shown} at line ${edge.line}` : `Open ${edge.shown}`}
        className={ENTRY}
      >
        <span className="flex items-baseline gap-1.5 text-[12px]">
          <span className="truncate text-ink group-hover/entry:text-brand">{edge.shown}</span>
          {edge.line !== undefined && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
              line {edge.line}
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[11px] text-ink-dim" data-slot="raw">
          {edge.key ? `${edge.key}: ` : ""}
          {edge.raw}
        </span>
        {/* An unresolved reference was never meant as a path: where it looked says nothing. */}
        {!unresolved && edge.tried.length > 0 && (
          <span className="block truncate text-[10px] text-ink-faint">
            nothing at {edge.tried.join(", ")}
          </span>
        )}
      </button>
    </li>
  );
}

/** A link leaving its set: opens its source at the link, and says where it lands. */
function LeavingEntry({
  link,
  noun,
  onOpen,
}: {
  link: LeavingLinkView;
  noun: string;
  onOpen: (path: string, at?: { from: number; to: number }) => void;
}) {
  const at =
    link.from !== undefined && link.to !== undefined ? { from: link.from, to: link.to } : undefined;
  return (
    <li>
      <button
        type="button"
        data-slot="link-check-entry"
        data-leaving=""
        data-source={link.source}
        data-line={link.line}
        onClick={() => onOpen(link.source, at)}
        title={link.line ? `Open ${link.shown} at line ${link.line}` : `Open ${link.shown}`}
        className={ENTRY}
      >
        <span className="flex items-baseline gap-1.5 text-[12px]">
          <span className="truncate text-ink group-hover/entry:text-brand">{link.shown}</span>
          {link.line !== undefined && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
              line {link.line}
            </span>
          )}
        </span>
        <span className="block truncate font-mono text-[11px] text-ink-dim" data-slot="raw">
          {link.key ? `${link.key}: ` : ""}
          {link.raw}
        </span>
        <span className="block truncate text-[10px] text-ink-faint" data-slot="lands">
          {link.targetSet
            ? `lands in ${link.targetSet}: ${link.targetShown}`
            : `lands outside every ${noun}: ${link.targetShown}`}
        </span>
      </button>
    </li>
  );
}

function Section({
  title,
  note,
  total,
  shown,
  children,
}: {
  title: string;
  /** Said once, in the header, rather than under every entry. */
  note?: string;
  total: number;
  shown: number;
  children: ReactNode;
}) {
  if (total === 0) return null;
  return (
    <section aria-label={title} data-slot="link-check-section" className="flex flex-col">
      {/* Sticky, so a long section still says what it is while it scrolls. */}
      <h3 className="sticky top-0 z-10 bg-surface px-2 pt-2 pb-0.5">
        <span className="flex items-baseline gap-1.5 text-[11px] font-medium tracking-wide text-ink-dim uppercase">
          {title}
          <span className="font-normal text-ink-faint normal-case tracking-normal">{total}</span>
        </span>
        {note && (
          <span data-slot="section-note" className="block text-[10px] font-normal text-ink-faint">
            {note}
          </span>
        )}
      </h3>
      <ul className="flex flex-col">{children}</ul>
      {shown < total && (
        <p className="px-2 text-[10px] text-ink-faint">
          Showing the first {shown} of {total}.
        </p>
      )}
    </section>
  );
}

/** Keep the entries whose set passes `keep`, each section counted from what is kept. */
function onlySet(d: LinkCheckData, keep: (set: string | undefined) => boolean): LinkCheckData {
  function pick<T extends { set?: string }>(list: readonly T[]): T[] {
    return list.filter((x) => keep(x.set));
  }
  const dangling = pick(d.dangling.links);
  const proposed = d.proposed ? pick(d.proposed.links) : undefined;
  const unsupported = pick(d.unsupported.links);
  const headings = pick(d.headings.links);
  const references = pick(d.references.links);
  const edges = d.edges ? pick(d.edges.links) : undefined;
  const unresolved = d.unresolved ? pick(d.unresolved.links) : undefined;
  const images = pick(d.unusedImages.images);
  const symmetry = pick(d.symmetry.hints);
  const ambiguous = pick(d.ambiguousHeadings.hints);
  const leaving = d.leaving ? pick(d.leaving.links) : undefined;
  return {
    count:
      dangling.length +
      unsupported.length +
      headings.length +
      references.length +
      (edges?.length ?? 0) +
      (proposed?.length ?? 0),
    dangling: { count: dangling.length, links: dangling },
    ...(proposed ? { proposed: { count: proposed.length, links: proposed } } : {}),
    unsupported: {
      count: unsupported.length,
      schemes: [...new Set(unsupported.map((l) => l.scheme))].sort(),
      links: unsupported,
    },
    // Shared names are the session's, listed once above the sets.
    duplicates: { count: 0, names: [] },
    unusedImages: { count: images.length, images },
    symmetry: { count: symmetry.length, hints: symmetry },
    headings: { count: headings.length, links: headings },
    ambiguousHeadings: { count: ambiguous.length, hints: ambiguous },
    references: { count: references.length, links: references },
    ...(d.edges && edges
      ? {
          edges: {
            count: edges.length,
            kinds: [...new Set(edges.map((e) => e.edge))].sort(),
            links: edges,
          },
        }
      : {}),
    ...(unresolved
      ? {
          unresolved: {
            count: unresolved.length,
            kinds: [...new Set(unresolved.map((e) => e.edge))].sort(),
            links: unresolved,
          },
        }
      : {}),
    ...(leaving ? { leaving: { count: leaving.length, links: leaving } } : {}),
    ...(d.noun !== undefined ? { noun: d.noun } : {}),
  };
}

/**
 * The sets the list groups by, in the daemon's order, each with what it has to
 * show; entries in no set the answer names come last, under no set's name.
 */
export function linkCheckGroups(
  d: LinkCheckData,
): { id: string | null; label: string | null; total?: number; data: LinkCheckData }[] {
  const sets = d.sets ?? [];
  const known = new Set(sets.map((x) => x.id));
  const groups: { id: string | null; label: string | null; total?: number; data: LinkCheckData }[] =
    sets.map((x) => ({
      id: x.id,
      label: x.label,
      total: x.total,
      data: onlySet(d, (set) => set === x.id),
    }));
  groups.push({
    id: null,
    label: null,
    data: onlySet(d, (set) => set === undefined || !known.has(set)),
  });
  return groups.filter((g) => linkCheckListed(g.data) > 0);
}

/**
 * One set's sections (or, from a daemon that names no sets, the session's):
 * broken links, then broken references of each sort, unsupported links and
 * links to a missing heading; then the links leaving the set; then the
 * images nothing uses, and the two hints. Each entry opens its source (an
 * image, in the viewer), at the link where the daemon says where it is.
 */
function KindSections({
  data,
  onOpen,
}: {
  data: LinkCheckData;
  onOpen: (path: string, at?: { from: number; to: number }) => void;
}) {
  const openLink = (l: CheckedLinkView) => onOpen(l.source, { from: l.from, to: l.to });
  const schemes = data.unsupported.schemes.map((s) => `${s}:`).join(", ");
  return (
    <>
      <Section title="Broken links" total={data.dangling.count} shown={data.dangling.links.length}>
        {data.dangling.links.map((l) => (
          <LinkEntry
            key={`${l.source}:${l.from}`}
            link={l}
            note={l.tried.length > 0 ? `nothing at ${l.tried.join(", ")}` : undefined}
            onOpen={openLink}
          />
        ))}
      </Section>
      {data.proposed && (
        <Section
          title="Broken in a proposed version"
          note="A version the agent proposed, never made active, links to nothing here, often because a move updated only the active version. Activated as it is, the link is broken."
          total={data.proposed.count}
          shown={data.proposed.links.length}
        >
          {data.proposed.links.map((l) => (
            <LinkEntry
              key={`${l.source}:${l.version}:${l.from}`}
              link={l}
              note={`in v${l.version}${l.suggest ? `; its target moved to ${l.suggest}` : ""}`}
              // Its place is in that version's text, not the active one's: open the document.
              onOpen={(x) => onOpen(x.source)}
            />
          ))}
        </Section>
      )}
      {data.edges && (
        <Section
          title={`Broken ${edgeNoun(data.edges.kinds)}s`}
          note="References the app reads beside the links, and nothing answers them."
          total={data.edges.count}
          shown={data.edges.links.length}
        >
          {data.edges.links.map((e) => (
            <EdgeEntry
              key={`${e.source}:${e.key ?? ""}:${e.raw}:${e.from ?? ""}`}
              edge={e}
              onOpen={onOpen}
            />
          ))}
        </Section>
      )}
      <Section
        title="Broken references"
        total={data.references.count}
        shown={data.references.links.length}
      >
        {data.references.links.map((r) => (
          <li key={`${r.source}:${r.id}:${r.from}`}>
            <button
              type="button"
              data-slot="link-check-reference"
              data-source={r.source}
              data-line={r.line}
              onClick={() => onOpen(r.source)}
              title={`Open the ${r.noun} ${r.name}`}
              className={ENTRY}
            >
              <span className="flex items-baseline gap-1.5 text-[12px]">
                <span className="truncate text-ink group-hover/entry:text-brand">{r.shown}</span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
                  line {r.line}
                </span>
              </span>
              <span className="block truncate text-[11px] text-ink-dim" data-slot="text">
                {r.text}
              </span>
            </button>
          </li>
        ))}
      </Section>
      <Section
        title="Unsupported links"
        note={`${schemes} links do not open here.`}
        total={data.unsupported.count}
        shown={data.unsupported.links.length}
      >
        {data.unsupported.links.map((l) => (
          <LinkEntry key={`${l.source}:${l.from}`} link={l} onOpen={openLink} />
        ))}
      </Section>
      <Section
        title="Links to a heading that is not there"
        note="The document opens, but no heading has this name: often a heading reworded since."
        total={data.headings.count}
        shown={data.headings.links.length}
      >
        {data.headings.links.map((l) => (
          <LinkEntry
            key={`${l.source}:${l.from}`}
            link={l}
            note={`no “${l.heading}” in ${l.targetShown}${l.nearest ? `; nearest: “${l.nearest}”` : ""}`}
            onOpen={openLink}
          />
        ))}
      </Section>
      {data.unresolved && (
        <Section
          title="Unresolved references"
          note="Not counted as broken: written as a name, not a path, and nothing here answers it. Another tool may know what it names."
          total={data.unresolved.count}
          shown={data.unresolved.links.length}
        >
          {data.unresolved.links.map((e) => (
            <EdgeEntry
              key={`${e.source}:${e.key ?? ""}:${e.raw}:${e.from ?? ""}`}
              edge={e}
              unresolved
              onOpen={onOpen}
            />
          ))}
        </Section>
      )}
      {data.leaving && (
        <Section
          title={`Leaving the ${nounOf(data)}`}
          note={`Not broken: these land on a file this session does not hold. The ${nounOf(data)} is not self-contained.`}
          total={data.leaving.count}
          shown={data.leaving.links.length}
        >
          {data.leaving.links.map((l) => (
            <LeavingEntry
              key={`${l.source}:${l.edge ?? "link"}:${l.from ?? l.raw}:${l.key ?? ""}`}
              link={l}
              noun={nounOf(data)}
              onOpen={onOpen}
            />
          ))}
        </Section>
      )}
      <Section
        title="Images nothing links to or embeds"
        note="In an images folder beside a document, and no link or embed reaches them (an undone paste leaves its file). Open one to look, then embed it or move it to the Trash."
        total={data.unusedImages.count}
        shown={data.unusedImages.images.length}
      >
        {data.unusedImages.images.map((i) => (
          <li key={i.path}>
            <button
              type="button"
              data-slot="link-check-entry"
              data-source={i.path}
              onClick={() => onOpen(i.path)}
              title={`Open ${i.shown}`}
              className={ENTRY}
            >
              <span className="block truncate text-[12px] text-ink group-hover/entry:text-brand">
                {i.shown}
              </span>
            </button>
          </li>
        ))}
      </Section>
      <Section
        title="Symmetric links written one way"
        note="A hint, not a problem: these relations read the same both ways, and the document linked to does not link back. Add the link back if you want it."
        total={data.symmetry.count}
        shown={data.symmetry.hints.length}
      >
        {data.symmetry.hints.map((h) => (
          <LinkEntry
            key={`${h.source}:${h.from}:${h.rel}`}
            link={h}
            note={h.hint}
            onOpen={openLink}
          />
        ))}
      </Section>
      <Section
        title="Links to a repeated heading"
        note="A hint, not a problem: more than one heading has this name, and the link opens at the first. Its path of headings (Parent#Child) names one alone."
        total={data.ambiguousHeadings.count}
        shown={data.ambiguousHeadings.hints.length}
      >
        {data.ambiguousHeadings.hints.map((l) => (
          <LinkEntry
            key={`${l.source}:${l.from}`}
            link={l}
            note={`“${l.heading}” is repeated in ${l.targetShown}`}
            onOpen={openLink}
          />
        ))}
      </Section>
    </>
  );
}

/**
 * The list behind the mark: shared names first, for the whole session (a
 * rename is the bigger, rarer decision, a short list, and a name may be
 * shared across sets); then each set with something to report, in the
 * context's order, its sections beneath its name. A daemon that names no sets
 * gets one list, as before the grouping.
 */
export function LinkCheckList({
  data,
  onOpen,
}: {
  data: LinkCheckData;
  onOpen: (path: string, at?: { from: number; to: number }) => void;
}) {
  if (linkCheckListed(data) === 0)
    return (
      <p data-slot="link-check-list" className="pt-2 text-[12px] text-ink-dim">
        Nothing to report now: every link answers, and no two documents share a name.
      </p>
    );
  const groups = data.sets ? linkCheckGroups(data) : null;
  /** The group of entries in no set the answer names (rare: a document opened by path). */
  const elsewhere = data.noun ? `In no ${data.noun}` : "Elsewhere";
  return (
    <div data-slot="link-check-list" className="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto">
      <Section
        title="Shared file names"
        note="A link to the name may open the other file. Each could be renamed as shown."
        total={data.duplicates.count}
        shown={data.duplicates.names.length}
      >
        {data.duplicates.names.map((d) => (
          <li key={d.name} data-slot="link-check-name" className="flex flex-col">
            <span className="px-2 pt-1 font-mono text-[11px] text-ink-dim">{d.name}</span>
            <ul className="flex flex-col">
              {d.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    data-slot="link-check-entry"
                    data-source={f.path}
                    onClick={() => onOpen(f.path)}
                    title={`Open ${f.shown}`}
                    className={ENTRY}
                  >
                    <span className="block truncate text-[12px] text-ink group-hover/entry:text-brand">
                      {f.shown}
                    </span>
                    <span className="block truncate text-[10px] text-ink-faint" data-slot="suggest">
                      could be {f.suggest}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </Section>
      {groups === null ? (
        <KindSections data={data} onOpen={onOpen} />
      ) : (
        groups.map((g) => (
          <section
            key={g.id ?? ""}
            data-slot="link-check-set"
            data-set={g.id ?? undefined}
            aria-label={g.label ? `In ${g.label}` : elsewhere}
            className="flex flex-col"
          >
            <h3 className="mx-2 mt-3 flex items-baseline gap-1.5 border-b border-edge pb-0.5 text-[12px] font-medium text-ink">
              <span className="truncate">{g.label ?? elsewhere}</span>
              <span className="font-normal text-ink-faint" data-slot="set-total">
                {/* What the sign counts, so the groups add up to it (unresolved references are listed, not counted). */}
                {g.total !== undefined && g.total > linkCheckTotal(g.data)
                  ? `${linkCheckTotal(g.data)} of ${g.total}`
                  : linkCheckTotal(g.data)}
              </span>
            </h3>
            <KindSections data={g.data} onOpen={onOpen} />
          </section>
        ))
      )}
      {groups !== null && data.truncated && (
        <p className="px-2 pt-2 text-[10px] text-ink-faint">
          Each list was cut at its first entries, and a group shows only what was kept of it (“N of
          M”); the status bar's counts are the whole.
        </p>
      )}
    </div>
  );
}

/**
 * The status bar's mark, and its list. Asks the daemon:
 *
 * - on connecting, at once;
 * - a pause after a snapshot, after this viewer's own edit is sent (`edits`: a
 *   plain edit sends no snapshot unless it flips a document's dirty mark), or
 *   after the daemon says the context changed on disk (`context.changed`);
 * - at once when the list is opened;
 * - and every LINK_CHECK_FALLBACK_MS, for a folder the daemon cannot watch.
 *
 * The daemon re-reads only what changed. Renders nothing while there is
 * nothing to say.
 */
export function LinkCheck({
  request,
  onFrame,
  connected,
  snapshot,
  edits,
  onOpen,
  className,
}: {
  request: (op: ClientOp) => Promise<ServerFrame>;
  /** The daemon's frame listener, for `context.changed`. */
  onFrame: (listener: (frame: ServerFrame) => void) => () => void;
  connected: boolean;
  /** Any value that changes with the session's state: a change is the cue to ask again. */
  snapshot: unknown;
  /** Any value that changes when this viewer's edits are sent (the daemon client's `texts`). */
  edits: unknown;
  onOpen: (path: string, at?: { from: number; to: number }) => void;
  className?: string;
}) {
  const [data, setData] = useState<LinkCheckData | null>(null);
  const [open, setOpen] = useState(false);
  const last = useRef("");
  const [pushed, setPushed] = useState(0);
  useEffect(
    () =>
      onFrame((f) => {
        if (f.op === "context.changed") setPushed((n) => n + 1);
      }),
    [onFrame],
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!connected) return;
    const i = setInterval(() => setTick((n) => n + 1), LINK_CHECK_FALLBACK_MS);
    return () => clearInterval(i);
  }, [connected]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each cue (snapshot, edit, push, tick) is a trigger to ask again.
  useEffect(() => {
    if (!connected) return;
    let current = true;
    const t = setTimeout(
      () => {
        request({ op: "link.check" })
          .then((frame) => {
            if (!current) return;
            const {
              op: _op,
              requestId: _rid,
              ...rest
            } = frame as unknown as LinkCheckData & { op: string; requestId?: unknown };
            const key = JSON.stringify(rest);
            if (key === last.current) return;
            last.current = key;
            setData(rest);
          })
          // A convenience: a refusal leaves the mark as it was.
          .catch(() => {});
      },
      // The first ask, on connecting, and the ask on opening need not wait.
      last.current === "" || open ? 0 : LINK_CHECK_PAUSE_MS,
    );
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [connected, request, snapshot, edits, pushed, open, tick]);

  // While the list is open it stays, even when a fresh answer has emptied it.
  if (!data || (linkCheckTotal(data) === 0 && !open)) return null;
  const label = linkCheckLabel(data);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-slot="link-check"
        aria-label={`Link check: ${label}`}
        title={label}
        className={cn(
          "flex min-w-0 shrink items-center gap-1 rounded px-1 text-ink-dim outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
          className,
        )}
      >
        <Link2OffIcon aria-hidden className="size-3.5 shrink-0" />
        {/* Narrow: the icon and the total. The words are in the label either way. */}
        <span data-slot="link-check-total" aria-hidden className="sm:hidden">
          {linkCheckTotal(data)}
        </span>
        <span data-slot="link-check-label" aria-hidden className="hidden truncate sm:inline">
          {label}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[min(30rem,calc(100vw-1rem))]">
        <PopoverTitle>Link check</PopoverTitle>
        <PopoverDescription className="text-[12px]">
          Reported, not errors. Choose one to open it.
        </PopoverDescription>
        <LinkCheckList
          data={data}
          onOpen={(path, at) => {
            setOpen(false);
            onOpen(path, at);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
