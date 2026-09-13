// Comparing the active version with another, and taking changes from it (E36).
//
// ⛔ ONE SCROLL CONTAINER, TWO COLUMNS. The halves are cells of a single grid
// inside a single scroller, so they cannot drift out of alignment and there is
// no scroll listener syncing anything. The raw/rendered split next door DOES
// have the drift problem precisely because it is two independent scrollers of
// two different renderings; here the two sides are the same lines, so the
// cheap structure is also the correct one.
//
// ⛔ NOTHING IS COMPUTED HERE. The hunks, the line pairing and the word-level
// spans all arrive from the daemon (`diff.ts`), and "Take" sends hunk IDS back
// — never text. That is what makes the thing the human accepted and the thing
// the daemon applies the same object rather than two hopefully-equal ones.
import { cn } from "cn";
import { CheckIcon, GitCompareIcon } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/ui/button";
import type { DiffLine, DiffPayload, DiffSide, DiffSpan, Version } from "../../backend/protocol";

/**
 * How a comparison side reads to a human (E43).
 *
 * ⛔ THE FILE IS NAMED, NOT DESCRIBED. `original` is the code's word for the
 * file of record and it misleads in prose — it sounds TEMPORAL, "the first
 * one", which is exactly what v1 is. "The saved file" fixed the tense and then
 * failed as a DESTINATION ("save to the saved file"). No noun carries "this
 * file, at this place", so the file is called by its name. Truncated in the
 * middle rather than the end, because the extension is the half that says what
 * kind of thing it is and a long name's tail is often the distinguishing part.
 */
export function fileLabel(name: string, max = 22): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - (max - 1 - head))}`;
}

export function sideLabel(side: DiffSide, file: string, max?: number): string {
  return side === "original" ? fileLabel(file, max) : `v${side}`;
}

/** One rendered row: the same line on both sides, or one side of a change. */
type Row =
  | { kind: "same"; line: DiffLine }
  | { kind: "change"; hunk: number; first: boolean; del?: DiffLine; add?: DiffLine };

/**
 * Walk the line ops into rows. A change run occupies `max(dels, adds)` rows on
 * BOTH sides, the shorter side padded — which is what keeps the line that
 * follows a 2-for-3 replacement level across the gutter.
 *
 * The n-th change run is the n-th hunk: `collect` in `diff.ts` numbers them in
 * exactly this order, so the ids line up without matching on line numbers.
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
          // Spans are positional and their text repeats; the index IS the identity.
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
    <span className="inline-block w-10 shrink-0 select-none pr-3 text-right text-ink-faint">
      {n === undefined ? "" : n + 1}
    </span>
  );
}

function Cell({
  line,
  tone,
  side,
  reserve,
}: {
  line: DiffLine | undefined;
  tone: "same" | "del" | "add";
  side: "a" | "b";
  /** Keep the Take button's corner clear — it sits over this cell. */
  reserve?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 whitespace-pre-wrap border-edge px-2 py-px",
        side === "b" && "border-l",
        reserve && "pr-16",
        tone === "del" && "bg-removed/10",
        tone === "add" && "bg-added/12",
        // A padded row on the short side of an uneven change: nothing is there,
        // and showing it as blank rather than absent is what keeps the columns level.
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

export function CompareView({
  payload,
  file,
  versions,
  onAgainst,
  onTake,
  busy,
}: {
  payload: DiffPayload;
  /** The document's file name — the saved side is called by it. */
  file: string;
  versions: Version[];
  onAgainst: (side: DiffSide) => void;
  onTake: (hunks: number[]) => void;
  busy?: boolean;
}) {
  const { diff, active, against } = payload;
  const rows = rowsOf(
    diff.lines,
    diff.hunks.map((h) => h.id),
  );
  const sides: DiffSide[] = ["original", ...versions.map((v) => v.n).filter((n) => n !== active)];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          {diff.same
            ? "identical"
            : `${diff.hunks.length} change${diff.hunks.length === 1 ? "" : "s"}`}
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

      {diff.coarse && (
        // ⛔ SAID, NOT SWALLOWED. Past the engine's edit cap the whole
        // difference is one hunk, and a human told "1 change" would read that
        // as a small edit. The count above is honest only with this beside it.
        <p
          role="status"
          className="shrink-0 border-b border-attention/40 bg-attention/10 px-3 py-1.5 text-xs text-ink"
        >
          These two are too different to walk change by change, so the whole document is offered as
          one — take it or leave it.
        </p>
      )}

      {diff.same ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-faint">
          <CheckIcon aria-hidden className="size-4" />
          These two versions are identical.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto font-mono text-[13px] leading-[1.65]">
          <div className="grid min-w-fit grid-cols-2 items-stretch">
            {rows.map((row, i) => {
              const key = `${i}-${row.kind}`;
              if (row.kind === "same")
                return (
                  <Fragment key={key}>
                    <Cell line={row.line} tone="same" side="a" />
                    <Cell line={row.line} tone="same" side="b" />
                  </Fragment>
                );
              return (
                <Fragment key={key}>
                  <Cell line={row.del} tone="del" side="a" />
                  <div className="relative">
                    <Cell line={row.add} tone="add" side="b" reserve={row.first} />
                    {row.first && (
                      // One button per HUNK, on its first row — taking half a
                      // hunk is not a thing the engine can express, so the UI
                      // does not offer it.
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
      )}
    </div>
  );
}
