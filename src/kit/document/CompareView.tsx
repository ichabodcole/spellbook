// Comparing the active version with another, and taking changes from it.
//
// ONE SCROLL CONTAINER, TWO COLUMNS. The halves are cells of a single grid inside a
// single scroller, so they cannot drift out of alignment and there is no scroll
// listener syncing anything: the two sides are the same lines.
//
// NOTHING IS COMPUTED HERE. The hunks, the line pairing and the word-level spans
// all arrive from the daemon, and "Take" sends hunk IDS back, never text. That is
// what makes the thing the human accepted and the thing the daemon applies the same
// object rather than two hopefully-equal ones.

import { CheckIcon, ChevronDownIcon, GitCompareIcon } from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/index.ts";
import type {
  DiffHunk,
  DiffLine,
  DiffPayload,
  DiffSide,
  DiffSpan,
  DocView,
  Version,
} from "../workspace/protocol";
import {
  hunkLine,
  hunkSpans,
  hunkSummary,
  markPlace,
  type RowSpan,
  rowOfLine,
} from "./compareNav.ts";
import { useFind } from "./FindBar.tsx";

/**
 * How a comparison side reads to a human. The file is named, not described:
 * "original" is the code's word for the file of record and it misleads in prose,
 * and "the saved file" fails as a destination ("save to the saved file"). Truncated
 * in the middle rather than the end, because the extension says what kind of thing
 * it is and a long name's tail is often the distinguishing part.
 */
export function fileLabel(name: string, max = 22): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
}

export function sideLabel(side: DiffSide, file: string, max?: number): string {
  return side === "original" ? fileLabel(file, max) : `v${side}`;
}

/** What the compare control and the compare view say when there is no other side. */
export const NOTHING_TO_COMPARE = "Only one version — nothing to compare";

/**
 * True when a comparison could only ever say "identical": one version, and that
 * version is the file. NOT JUST "ONE VERSION". The file of record is a side of its
 * own, so one version with unsaved edits, or whose file changed on disk, has a real
 * difference to show.
 */
export function nothingToCompare(doc: Pick<DocView, "versions" | "dirty" | "outsideChanged">) {
  return doc.versions.length < 2 && !doc.dirty && !doc.outsideChanged;
}

/** What the compare view says when the active version and the file on disk are the same. */
export const matchesFile = (active: number) => `v${active} matches the file on disk.`;

/**
 * What it says when the daemon looked for a side that differs and found none
 * (`everyMatches`): the file and every other version are the active one's text.
 */
export const everyVersionMatches = (active: number) =>
  `v${active} matches the file on disk, and so does every other version.`;

/** Where the compare view would be, when there is nothing to put in it. */
export function NothingToCompare({ active }: { active?: number }) {
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-faint"
    >
      <GitCompareIcon aria-hidden className="size-4" />
      {/* With the version known, said as what it is: it and the file match. */}
      {active === undefined ? `${NOTHING_TO_COMPARE}.` : nothingButTheFile(active)}
    </div>
  );
}

/** The compare view of the one version, when it matches its file. */
export const nothingButTheFile = (active: number) =>
  `${matchesFile(active)} There is no other version to compare it with.`;

/** One rendered row: the same line on both sides, or one side of a change. */
export type Row =
  | { kind: "same"; line: DiffLine }
  | { kind: "change"; hunk: number; first: boolean; del?: DiffLine; add?: DiffLine };

/**
 * Walk the line ops into rows. A change run occupies `max(dels, adds)` rows on BOTH
 * sides, the shorter side padded, which keeps the line that follows a 2-for-3
 * replacement level across the gutter. The n-th change run is the n-th hunk: the
 * daemon numbers them in exactly this order, so the ids line up without matching on
 * line numbers.
 */
export function rowsOf(lines: DiffLine[], hunkIds: number[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  let run = 0;
  while (i < lines.length) {
    const line = lines[i] as DiffLine;
    if (line.op === "same") {
      rows.push({ kind: "same", line });
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && (lines[i] as DiffLine).op !== "same") i++;
    const block = lines.slice(start, i);
    const dels = block.filter((l) => l.op === "del");
    const adds = block.filter((l) => l.op === "add");
    const hunk = hunkIds[run] ?? run + 1;
    run++;
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      rows.push({
        kind: "change",
        hunk,
        first: k === 0,
        ...(dels[k] ? { del: dels[k] as DiffLine } : {}),
        ...(adds[k] ? { add: adds[k] as DiffLine } : {}),
      });
  }
  return rows;
}

/** A line's text, with the words that differ from its pair picked out. */
function Spans({ line, tone }: { line: DiffLine | undefined; tone: "del" | "add" }) {
  if (!line) return null;
  if (!line.spans) return <>{line.text}</>;
  return (
    <>
      {line.spans.map((s: DiffSpan, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: spans are positional and their text repeats; the index IS the identity.
          key={`${i}-${s.text}`}
          className={cn(
            s.changed && "rounded-[2px]",
            s.changed && (tone === "del" ? "bg-removed/28" : "bg-added/28"),
          )}
        >
          {s.text}
        </span>
      ))}
    </>
  );
}

function Gutter({ n }: { n: number | undefined }) {
  return (
    <span
      data-find-skip
      className="inline-block w-10 shrink-0 select-none pr-3 text-right text-ink-faint"
    >
      {n === undefined ? "" : n + 1}
    </span>
  );
}

function Cell({
  line,
  tone,
  side,
  row,
  flash,
  dup,
  reserve,
}: {
  line: DiffLine | undefined;
  tone: "same" | "del" | "add";
  side: "a" | "b";
  /** The row's index: what scrolling to a change looks for. */
  row: number;
  /** Briefly marked: the change a click or the agent just brought into view. */
  flash?: boolean;
  /**
   * The right-hand copy of an unchanged line: the same text as the left, so a
   * search of both sides counts it once (on the left).
   */
  dup?: boolean;
  /** Keep the Take button's corner clear: it sits over this cell. */
  reserve?: boolean;
}) {
  return (
    <div
      data-row={side === "a" ? row : undefined}
      data-flash={flash ? "on" : undefined}
      // One segment for find, on one side: a match never runs into the next line
      // or across to the other side.
      data-find-segment
      data-find-side={side}
      data-find-dup={dup || undefined}
      className={cn(
        "flex min-w-0 whitespace-pre-wrap border-edge px-2 py-px",
        side === "b" && "border-l",
        reserve && "pr-16",
        tone === "del" && "bg-removed/10",
        tone === "add" && "bg-added/12",
        // A padded row on the short side of an uneven change: nothing is there, and
        // showing it as blank rather than absent keeps the columns level.
        !line && tone !== "same" && "bg-surface-raised/40",
      )}
    >
      <Gutter n={line?.[side]} />
      <span className="min-w-0 flex-1 break-words">
        {tone === "same" ? line?.text : <Spans line={line} tone={tone === "del" ? "del" : "add"} />}
      </span>
    </div>
  );
}

/** How long a change stays marked after it is brought into view. */
export const FLASH_MS = 1600;

/**
 * A request, from outside the view, to bring something into it: a change by its
 * hunk id (only once the comparison is against `against`, since ids are
 * numbered per comparison), or a 0-based line of the active version. Applied
 * once per `seq`.
 */
export type CompareFocus =
  | { seq: number; hunk: number; against?: DiffSide }
  | { seq: number; line: number };

/** "1 change", "3 changes". */
export function changesLabel(n: number): string {
  return `${n} change${n === 1 ? "" : "s"}`;
}

/**
 * The header's count of changes, as a way to reach them. With one change it
 * goes straight there; with several it lists them and goes to the one picked.
 */
function ChangePicker({ hunks, onPick }: { hunks: DiffHunk[]; onPick: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = cn(
    "flex h-6 items-center gap-1 rounded-sm px-1.5 text-ink-dim outline-none",
    "hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
  );
  const only = hunks.length === 1 ? hunks[0] : undefined;
  if (only)
    return (
      <button
        type="button"
        className={trigger}
        onClick={() => onPick(only.id)}
        aria-label={`1 change: go to it, at line ${hunkLine(only)}`}
        title={`Go to the change, at line ${hunkLine(only)}`}
        data-slot="change-picker"
      >
        {changesLabel(1)}
      </button>
    );
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className={trigger}
        aria-label={`${changesLabel(hunks.length)}: go to one`}
        data-slot="change-picker"
      >
        {changesLabel(hunks.length)}
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-ink-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <div className="max-h-72 overflow-y-auto py-0.5">
          {hunks.map((h, i) => (
            <DropdownMenuItem
              key={h.id}
              onClick={() => {
                setOpen(false);
                onPick(h.id);
              }}
              className="flex-col items-start gap-0 py-1"
            >
              <span className="flex w-full items-baseline gap-2 text-xs">
                <span className="font-medium text-ink">Change {i + 1}</span>
                <span className="ml-auto shrink-0 text-ink-faint tabular-nums">
                  line {hunkLine(h)}
                </span>
              </span>
              <span className="w-full truncate font-mono text-[11px] text-ink-faint">
                {hunkSummary(h)}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A strip beside the comparison with a mark where each change is, so a change
 * in a long document can be seen without scrolling to it. A mark is a button:
 * clicking it brings that change into view.
 */
function Minimap({
  hunks,
  spans,
  total,
  measured,
  onPick,
}: {
  hunks: DiffHunk[];
  spans: Map<number, RowSpan>;
  total: number;
  measured: { tops: number[]; height: number } | null;
  onPick: (id: number) => void;
}) {
  return (
    <nav
      aria-label="Changes"
      data-slot="change-minimap"
      className="relative w-3.5 shrink-0 border-l border-edge bg-surface-raised/40"
    >
      {hunks.map((h, i) => {
        const span = spans.get(h.id);
        if (!span) return null;
        const at = markPlace(span, total, measured);
        return (
          <button
            key={h.id}
            type="button"
            onClick={() => onPick(h.id)}
            aria-label={`Change ${i + 1} of ${hunks.length}, line ${hunkLine(h)}`}
            title={`Change ${i + 1}: ${hunkSummary(h)}`}
            style={{ top: `${at.top}%`, height: `${at.height}%` }}
            // The mark is drawn thin; the button around it is taller, so a
            // one-line change is still easy to hit.
            className={cn(
              "group absolute inset-x-0 -my-1.5 box-content min-h-1 py-1.5 outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring/60",
            )}
          >
            {/* The brand unless a theme sets the two hooks (the tick, and the tick hovered). */}
            <span
              aria-hidden
              className="mx-0.5 block h-full min-h-1 rounded-[1px] bg-[color:var(--color-change-tick,color-mix(in_oklab,var(--color-brand)_65%,transparent))] group-hover:bg-[color:var(--color-change-tick-hover,var(--color-brand))]"
            />
          </button>
        );
      })}
    </nav>
  );
}

export function CompareView({
  payload,
  file,
  versions,
  onAgainst,
  onTake,
  busy,
  focus,
  onFocused,
}: {
  payload: DiffPayload;
  /** The document's file name: the saved side is called by it. */
  file: string;
  versions: Version[];
  onAgainst: (side: DiffSide) => void;
  onTake: (hunks: number[]) => void;
  busy?: boolean;
  /** Something to bring into view: a change, or a line of the active version. */
  focus?: CompareFocus | null;
  /** The focus request has been applied: spent, so a later mount does not apply it again. */
  onFocused?: (seq: number) => void;
}) {
  const { diff, active, against } = payload;
  const rows = useMemo(
    () =>
      rowsOf(
        diff.lines,
        diff.hunks.map((h) => h.id),
      ),
    [diff],
  );
  const spans = useMemo(() => hunkSpans(rows), [rows]);
  const sides: DiffSide[] = ["original", ...versions.map((v) => v.n).filter((n) => n !== active)];

  // ── finding your way between the changes ────────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<(RowSpan & { seq: number }) | null>(null);
  const flashSeq = useRef(0);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  /** Scroll so row `i` sits a third of the way down: the lines before it are context. */
  const scrollToRow = (i: number) => {
    const sc = scroller.current;
    const el = sc?.querySelector<HTMLElement>(`[data-row="${i}"]`);
    if (!sc || !el) return;
    const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = Math.max(0, top - sc.clientHeight / 3);
  };
  const mark = (span: RowSpan) => setFlash({ ...span, seq: ++flashSeq.current });
  const goToHunk = (id: number, marked = true): boolean => {
    const span = spans.get(id);
    if (!span) return false;
    scrollToRow(span.start);
    if (marked) mark(span);
    return true;
  };

  // Opening a comparison lands on its first change, not the top of the document:
  // a one-line change in a long file is otherwise scrolled past unseen. Once per
  // comparison (the document and the side), so a Take that refreshes the payload
  // leaves the reader where they are. A focus request, from the agent, wins.
  const comparison = `${payload.doc}\u0000${String(against)}`;
  const landedOn = useRef<string | null>(null);
  const focusedSeq = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the comparison, its rows and the request are the triggers; the scrolling helpers read the current ones.
  useLayoutEffect(() => {
    if (focus && focus.seq !== focusedSeq.current) {
      if ("hunk" in focus) {
        // Hunk ids are numbered per comparison: wait for the one they were named in.
        if (focus.against !== undefined && focus.against !== against) return;
        focusedSeq.current = focus.seq;
        landedOn.current = comparison;
        goToHunk(focus.hunk);
        onFocused?.(focus.seq);
        return;
      }
      focusedSeq.current = focus.seq;
      landedOn.current = comparison;
      const i = rowOfLine(rows, focus.line);
      scrollToRow(i);
      mark({ start: i, end: i + 1 });
      onFocused?.(focus.seq);
      return;
    }
    if (landedOn.current === comparison) return;
    landedOn.current = comparison;
    const first = diff.hunks[0];
    if (first) goToHunk(first.id, false);
  }, [comparison, rows, focus]);

  // Where each row is, measured, so the minimap's marks sit where the changes are
  // even when long lines wrap. Re-measured when the content's size changes.
  const [measured, setMeasured] = useState<{ tops: number[]; height: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows are new cells to measure.
  useLayoutEffect(() => {
    const g = grid.current;
    if (!g) return;
    const measure = () => {
      const height = g.getBoundingClientRect().height;
      if (height <= 0) {
        setMeasured(null);
        return;
      }
      const origin = g.getBoundingClientRect().top;
      const tops = [...g.querySelectorAll<HTMLElement>("[data-row]")].map(
        (el) => el.getBoundingClientRect().top - origin,
      );
      setMeasured({ tops, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(g);
    return () => ro.disconnect();
  }, [rows]);

  // Cmd-F: one search over both sides, or kept to one. The left is the active
  // version, the right the side it is compared with, named as the header names them.
  const view = useRef<HTMLDivElement>(null);
  const findSides = useMemo(
    () => [
      { value: "a", label: `v${active}`, title: `Only v${active}, the left side` },
      {
        value: "b",
        label: sideLabel(against, file),
        title: `Only ${sideLabel(against, file, 60)}, the right side`,
      },
    ],
    [active, against, file],
  );
  const { bar: findBar } = useFind({ root: scroller, scope: view, watch: diff, sides: findSides });

  // One version, the same as its file: say there is nothing to compare, never
  // "identical", which implies a comparison that did not happen.
  if (diff.same && sides.length < 2) return <NothingToCompare active={active} />;

  const flashing = (i: number) => !!flash && i >= flash.start && i < flash.end;

  return (
    <div ref={view} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-edge px-3 py-1.5 text-xs">
        <GitCompareIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
        <span className="text-ink-dim">
          v{active} <span className="text-ink-faint">compared with</span>
        </span>
        <div
          role="toolbar"
          aria-label="Compare against"
          className="flex flex-wrap items-center gap-1"
        >
          {sides.map((s) => (
            <button
              key={String(s)}
              type="button"
              onClick={() => onAgainst(s)}
              aria-pressed={s === against}
              title={s === "original" ? file : `version ${s}`}
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-ink-faint outline-none",
                "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                s === against && "bg-surface-raised font-medium text-ink",
              )}
            >
              {sideLabel(s, file)}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-2 text-ink-faint">
          {diff.same ? "identical" : <ChangePicker hunks={diff.hunks} onPick={goToHunk} />}
          {!diff.same && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onTake(diff.hunks.map((h) => h.id))}
              title={`Take every change from ${sideLabel(against, file, 60)} into v${active}`}
              className="h-6 px-2 text-xs"
            >
              Take all
            </Button>
          )}
        </span>
      </div>

      {findBar}

      {diff.coarse && (
        // Said, not swallowed. Past the engine's edit cap the whole difference is one
        // hunk, and a human told "1 change" would read that as a small edit.
        <p
          role="status"
          className="shrink-0 border-b border-attention/40 bg-attention/10 px-3 py-1.5 text-xs text-ink"
        >
          These two are too different to walk change by change, so the whole document is offered as
          one: take it or leave it.
        </p>
      )}

      {diff.same ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-faint">
          <CheckIcon aria-hidden className="size-4" />
          {/* The file is not a version: said as itself. */}
          {payload.everyMatches
            ? everyVersionMatches(active)
            : against === "original"
              ? matchesFile(active)
              : "These two versions are identical."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            ref={scroller}
            // Focusable by script, so a click in the rows puts the keyboard in this
            // view (Cmd-F opens its find) and Escape from the bar has somewhere to go.
            tabIndex={-1}
            data-slot="compare-scroller"
            className="min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-[1.65] outline-none"
          >
            <div ref={grid} className="grid min-w-fit grid-cols-2 items-stretch">
              {rows.map((row, i) => {
                const key = `${i}-${row.kind}`;
                const lit = flashing(i);
                if (row.kind === "same")
                  return (
                    <Fragment key={key}>
                      <Cell line={row.line} tone="same" side="a" row={i} flash={lit} />
                      <Cell line={row.line} tone="same" side="b" row={i} flash={lit} dup />
                    </Fragment>
                  );
                return (
                  <Fragment key={key}>
                    <Cell line={row.del} tone="del" side="a" row={i} flash={lit} />
                    <div className="relative">
                      <Cell
                        line={row.add}
                        tone="add"
                        side="b"
                        row={i}
                        flash={lit}
                        reserve={row.first}
                      />
                      {row.first && (
                        // One button per HUNK, on its first row: taking half a hunk is
                        // not a thing the engine can express, so the UI does not offer it.
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => onTake([row.hunk])}
                          title={`Take change ${row.hunk} into v${active}`}
                          className="absolute top-0 right-1 h-5 bg-bg px-1.5 font-sans text-[11px] shadow-sm"
                        >
                          Take
                        </Button>
                      )}
                    </div>
                  </Fragment>
                );
              })}
            </div>
          </div>
          <Minimap
            hunks={diff.hunks}
            spans={spans}
            total={rows.length}
            measured={measured}
            onPick={goToHunk}
          />
        </div>
      )}
    </div>
  );
}
