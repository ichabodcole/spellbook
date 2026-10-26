// "Linked from": the open document's backlinks, at the foot of the rendered view.
//
// At the foot because that is where a reader finishes a document and asks what
// else touches it, the way a wiki's "what links here" sits; because the rendered
// view is the reading surface, reader mode included (a sidebar tab would be shut
// in reader mode); and because a document nothing links to shows nothing at all,
// so a story or a script with no links (Sound Stage's) gains no chrome. Each entry
// is a button that opens the source at the link.
//
// It draws what the daemon answered (`link.backlinks`) and decides nothing about
// it but the arrangement (`backlinks.ts`), so another view, a graph, can draw the
// same answer.

import { useId } from "react";
import { withoutDocExtension } from "../lib/docFormat.ts";
import type {
  Backlinks as BacklinksData,
  BacklinkView,
  DocView,
  EdgeBacklinkView,
  ReferenceBacklinkView,
} from "../workspace/protocol";
import { groupBacklinks, snippetParts } from "./backlinks.ts";

/**
 * What an app adds to the "Linked from" heading: one more way to look at the
 * same links. The kit draws the button and knows nothing of what it opens; an
 * app that draws the links as a graph (Atlas) fills it.
 */
export type LinkedFromAction = {
  /** The button's text: short ("Show as a graph"). */
  label: string;
  onSelect: (doc: DocView) => void;
};

/** The folder part of a shown path, with its trailing slash, or "" at the root. */
function folderOf(shown: string): string {
  const slash = shown.lastIndexOf("/");
  return slash === -1 ? "" : shown.slice(0, slash + 1);
}

function Entry({ b, onOpen }: { b: BacklinkView; onOpen: (b: BacklinkView) => void }) {
  const snippetId = useId();
  const name = withoutDocExtension(b.name);
  return (
    <li>
      {/* Named by its source and line, described by the quoted line: read out
          whole, the button's text would run name, folder, line and quote together. */}
      <button
        type="button"
        aria-label={`${name}, line ${b.line}`}
        aria-describedby={snippetId}
        data-slot="backlink"
        data-source={b.source}
        data-line={b.line}
        onClick={() => onOpen(b)}
        title={`Open ${b.shown} at line ${b.line}`}
        className="group/backlink w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="flex items-baseline gap-1.5 text-[13px]">
          <span className="truncate font-medium text-ink group-hover/backlink:text-brand">
            {name}
          </span>
          {folderOf(b.shown) && (
            <span className="truncate text-[11px] text-ink-faint">{folderOf(b.shown)}</span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-faint">
            line {b.line}
          </span>
        </span>
        <span
          id={snippetId}
          className="mt-0.5 block text-[12px] leading-snug text-ink-dim"
          data-slot="snippet"
        >
          {snippetParts(b).map((p, i) =>
            p.mark ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts are a fixed split of one line.
              <mark key={i} className="rounded-sm bg-brand/15 px-0.5 text-ink">
                {p.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above.
              <span key={i}>{p.text}</span>
            ),
          )}
        </span>
      </button>
    </li>
  );
}

/**
 * An app's edges that land on the document (kit-link-edges-slot), grouped by
 * kind, in the order given: one group per kind, as the daemon sent them.
 */
export function groupEdges(
  edges: readonly EdgeBacklinkView[],
): { kind: string; edges: EdgeBacklinkView[] }[] {
  const by = new Map<string, EdgeBacklinkView[]>();
  for (const e of edges) {
    const list = by.get(e.edge);
    if (list) list.push(e);
    else by.set(e.edge, [e]);
  }
  return [...by].map(([kind, list]) => ({ kind, edges: list }));
}

/** What an edge's second line says: what carries it and its target as written ("related: ruin"). */
export function edgeLine(e: EdgeBacklinkView): string {
  return e.key ? `${e.key}: ${e.raw}` : e.raw;
}

/**
 * One document that refers to this one by an app's edge: a reference (a
 * frontmatter key, say), not a link in its text, so it has no line to quote.
 * Its kind is the app's word, and the entry says it. No line is shown: the
 * entry opens its source at the top, since opening takes no line.
 */
function EdgeEntry({
  e,
  onOpen,
  asOf,
}: {
  e: EdgeBacklinkView;
  onOpen: (e: EdgeBacklinkView) => void;
  asOf: ReadonlyMap<string, string>;
}) {
  const lineId = useId();
  const name = withoutDocExtension(e.name);
  return (
    <li>
      <button
        type="button"
        aria-label={`${name}: reference (${e.edge}), not a link in its text`}
        aria-describedby={lineId}
        data-slot="backlink-reference"
        data-source={e.source}
        data-edge={e.edge}
        {...(e.key !== undefined ? { "data-key": e.key } : {})}
        onClick={() => onOpen(e)}
        title={`Open ${e.shown}`}
        className="group/backlink w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="flex items-baseline gap-1.5 text-[13px]">
          <span className="truncate font-medium text-ink group-hover/backlink:text-brand">
            {name}
          </span>
          {folderOf(e.shown) && (
            <span className="truncate text-[11px] text-ink-faint">{folderOf(e.shown)}</span>
          )}
        </span>
        <span
          id={lineId}
          className="mt-0.5 block text-[12px] leading-snug text-ink-dim"
          data-slot="reference-line"
        >
          <span className="font-mono">{edgeLine(e)}</span>
          {e.rel.length > 0 && (
            <span className="text-ink-faint">
              {" "}
              · {e.rel.map((r) => asOf.get(r) ?? r).join(", ")}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

/** The heading's count: "3 links", and with an app's edges "3 links, 1 reference". */
function countText(links: number, references: number): string {
  const said: string[] = [];
  if (links > 0 || references === 0) said.push(`${links} ${links === 1 ? "link" : "links"}`);
  if (references > 0) said.push(`${references} ${references === 1 ? "reference" : "references"}`);
  return said.join(", ");
}

/** The cards on a board that point at the document, as the entry's second line says them. */
export function placesOn(b: ReferenceBacklinkView): string {
  const names = b.refs.map((r) => {
    const name = r.label ?? b.part;
    return r.subpath ? `${name} (${r.subpath.replace(/^#/, "")})` : name;
  });
  return b.refs.length === 1
    ? (names[0] as string)
    : `${b.refs.length} ${b.part}s: ${names.join(", ")}`;
}

/** The heading over the bundles a document is on: "On boards", by the type's noun. */
function onHeading(bundles: readonly ReferenceBacklinkView[]): string {
  const nouns = [...new Set(bundles.map((b) => b.noun))];
  if (nouns.length !== 1) return "Elsewhere";
  return bundles.length === 1 ? `On a ${nouns[0]}` : `On ${nouns[0]}s`;
}

/**
 * "On the board The well": the bundles a document is on (an app's boards),
 * under a heading of their own below "Linked from", since a board is not
 * canon. Each entry opens the board.
 */
function OnBundles({
  bundles,
  onOpen,
}: {
  bundles: readonly ReferenceBacklinkView[];
  onOpen: (b: ReferenceBacklinkView) => void;
}) {
  return (
    <ul data-slot="backlink-bundles" className="flex flex-col">
      {bundles.map((b) => (
        <li key={b.source}>
          <button
            type="button"
            data-slot="backlink-bundle"
            data-source={b.source}
            onClick={() => onOpen(b)}
            title={`Open the ${b.noun} ${b.name}`}
            className="group/backlink w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span className="flex items-baseline gap-1.5 text-[13px]">
              <span className="truncate text-ink group-hover/backlink:text-brand">
                On the {b.noun} <span className="font-medium">{b.name}</span>
              </span>
              {folderOf(b.shown) && (
                <span className="truncate text-[11px] text-ink-faint">{folderOf(b.shown)}</span>
              )}
            </span>
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-dim">
              {placesOn(b)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const HEADING =
  "flex items-baseline gap-2 border-t border-edge pt-4 pb-2 text-[11px] font-medium tracking-wide text-ink-dim uppercase";

export function Backlinks({
  data,
  onOpen,
  onOpenBundle,
  onOpenEdge,
  action,
}: {
  data: BacklinksData | null;
  onOpen: (b: BacklinkView) => void;
  /**
   * Open a document that refers to this one by an app's edge (a frontmatter
   * reference: kit-link-edges-slot). Absent: the edges are not listed, as
   * bundles are not without `onOpenBundle`.
   */
  onOpenEdge?: (e: EdgeBacklinkView) => void;
  /** Open a bundle the document is on (a board). Absent: the bundles are not listed. */
  onOpenBundle?: (b: ReferenceBacklinkView) => void;
  /** An app's button in the heading, already bound to the document. */
  action?: { label: string; onSelect: () => void };
}) {
  const bundles = onOpenBundle ? (data?.bundles ?? []) : [];
  // An app's edges (kit-link-edges-slot): present only when the app adds them.
  // A document that refers here only from its frontmatter is still "Linked
  // from", said as a reference rather than a link in the text.
  const edges = onOpenEdge ? (data?.edges ?? []) : [];
  const edgeCount = edges.length > 0 ? (data?.edgeCount ?? edges.length) : 0;
  if (!data || (data.count === 0 && edges.length === 0 && bundles.length === 0)) return null;
  const groups = groupBacklinks(data.backlinks);
  // How each relation reads from this end, when the world's vocabulary says
  // (kit-picker-relation-meanings): `grounded-in` written there reads "grounds"
  // here; a symmetric relation reads as its own label.
  const asOf = new Map(data.relations.flatMap((r) => (r.as ? [[r.rel, r.as] as const] : [])));
  return (
    <section
      aria-label="Linked from"
      data-slot="backlinks"
      className="mx-auto max-w-[76ch] px-8 pb-16"
    >
      {(data.count > 0 || edges.length > 0) && (
        <>
          <h2 className={HEADING}>
            Linked from
            <span className="font-normal text-ink-faint normal-case tracking-normal">
              {countText(data.count, edgeCount)}
            </span>
            {action && (
              <button
                type="button"
                data-slot="linked-from-action"
                onClick={action.onSelect}
                className="ml-auto rounded-md px-1.5 py-0.5 font-normal tracking-normal text-ink-dim normal-case outline-none hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {action.label}
              </button>
            )}
          </h2>
          <div className="flex flex-col gap-3">
            {groups.map((g) => (
              <div key={g.rel ?? ""} data-slot="backlink-group" data-rel={g.rel ?? ""}>
                <h3 className="mb-0.5 flex items-center gap-1.5 px-2 text-[11px] text-ink-faint">
                  {g.rel ? (
                    <span
                      data-slot="backlink-relation"
                      title={
                        asOf.has(g.rel)
                          ? `Written ${g.rel} in the documents below; read from here, ${asOf.get(g.rel)}`
                          : undefined
                      }
                      className="rounded-full border border-edge bg-surface-raised px-1.5 leading-[1.45] font-medium text-ink-dim"
                    >
                      {asOf.get(g.rel) ?? g.rel}
                    </span>
                  ) : (
                    <span className="text-ink-dim">no relation</span>
                  )}
                  <span>{g.links.length}</span>
                </h3>
                <ul className="flex flex-col">
                  {g.links.map((b) => (
                    <Entry key={`${b.source}:${b.from}`} b={b} onOpen={onOpen} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {data.truncated && data.backlinks.length < data.count && (
            <p className="mt-2 px-2 text-[11px] text-ink-faint">
              Showing the first {data.backlinks.length} of {data.count}.
            </p>
          )}
          {edges.length > 0 && onOpenEdge && (
            <div className={groups.length > 0 ? "mt-3 flex flex-col gap-3" : "flex flex-col gap-3"}>
              {groupEdges(edges).map((g) => (
                <div key={g.kind} data-slot="backlink-references" data-edge={g.kind}>
                  <h3 className="mb-0.5 flex items-center gap-1.5 px-2 text-[11px] text-ink-faint">
                    <span
                      data-slot="backlink-edge-kind"
                      className="rounded-full border border-edge bg-surface-raised px-1.5 leading-[1.45] font-medium text-ink-dim"
                    >
                      {g.kind}
                    </span>
                    <span className="text-ink-dim">references, not links in the text</span>
                    <span>{g.edges.length}</span>
                  </h3>
                  <ul className="flex flex-col">
                    {g.edges.map((e, i) => (
                      <EdgeEntry
                        // biome-ignore lint/suspicious/noArrayIndexKey: one source may name one target twice under the same key (two entries in a list); the list is the daemon's, fixed for this answer.
                        key={`${e.source}:${e.key ?? ""}:${e.raw}:${i}`}
                        e={e}
                        onOpen={onOpenEdge}
                        asOf={asOf}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
          {edges.length < edgeCount && (
            <p data-slot="references-cut" className="mt-2 px-2 text-[11px] text-ink-faint">
              Showing the first {edges.length} of {edgeCount} references.
            </p>
          )}
        </>
      )}
      {bundles.length > 0 && onOpenBundle && (
        <div data-slot="backlinks-on" className={data.count > 0 ? "mt-4" : ""}>
          <h2 className={HEADING}>
            {onHeading(bundles)}
            <span className="font-normal text-ink-faint normal-case tracking-normal">
              not canon
            </span>
          </h2>
          <OnBundles bundles={bundles} onOpen={onOpenBundle} />
        </div>
      )}
    </section>
  );
}
