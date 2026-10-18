// The kit's find bar, for the views that are not an editor: the rendered view
// (alone, or as the rendered half of split) and the compare view. The raw view is
// CodeMirror, which has its own; this one is styled to match it, so Cmd-F opens
// the same-looking tool in every view.
//
// MATCHES ARE PAINTED, NOT WRAPPED. Each match is a DOM Range over the text
// nodes as they are, shown with the CSS Custom Highlight API. Nothing is inserted
// into the rendered HTML, so the text nodes the rendered view aligns its source
// projection against (`renderedRange.ts`) are exactly the ones it rendered: a
// note, a selection and Add link map to the same source offsets with the bar open
// as with it shut. Where the API is missing the matches are counted and stepped
// through, just not painted.
//
// The rules (segments, offsets, stepping, which focus Cmd-F belongs to) are in
// `find.ts`, with tests; this file walks the DOM and owns the keyboard.

import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { onMac } from "../lib/platform.ts";
import {
  countLabel,
  type FindMatch,
  findKeyAct,
  findMatches,
  isFindKey,
  locate,
  paintWindow,
  stepIndex,
} from "./find.ts";
import { clearHighlight, paintHighlight } from "./highlight.ts";

/** The highlight registry's names, styled in the theme (`document.css`). */
export const FIND_MATCH_HL = "find-match";
export const FIND_CURRENT_HL = "find-current";

/** A side of the comparison the search can be kept to. */
export type FindSide = { value: string; label: string; title?: string };

/** Where one block's text begins and ends: a match never crosses one. */
const SEGMENT =
  "p,li,h1,h2,h3,h4,h5,h6,td,th,pre,blockquote,dt,dd,figcaption,summary,[data-find-segment]";
/** Text a reader does not read as the document: controls, gutters, the bar itself. */
const SKIP = "button,[data-find-skip],[data-slot=find-bar],script,style,[aria-hidden=true]";

/** The searchable text under `root`, in segments, kept to one side when `side` names one. */
function segmentsOf(root: HTMLElement, side: string): { nodes: Text[]; text: string }[] {
  const out: { nodes: Text[]; text: string; key: Element }[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const parent = n.parentElement;
    if (!parent || n.data === "") continue;
    if (parent.closest(SKIP)) continue;
    if (side !== "both") {
      const own = parent.closest("[data-find-side]")?.getAttribute("data-find-side");
      if (own !== side) continue;
    } else if (parent.closest("[data-find-dup]")) continue;
    const block = parent.closest(SEGMENT);
    const key = block && root.contains(block) ? block : root;
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.nodes.push(n);
      last.text += n.data;
    } else out.push({ nodes: [n], text: n.data, key });
  }
  return out;
}

type Segment = { nodes: Text[]; text: string };

/** One match as a Range over the text nodes, built without touching them. */
function rangeOf(segs: readonly Segment[], m: FindMatch): Range | null {
  const seg = segs[m.seg];
  if (!seg) return null;
  const lengths = seg.nodes.map((n) => n.data.length);
  const a = locate(lengths, m.from, "start");
  const b = locate(lengths, m.to, "end");
  const r = document.createRange();
  try {
    r.setStart(seg.nodes[a.node] as Text, a.offset);
    r.setEnd(seg.nodes[b.node] as Text, b.offset);
  } catch {
    return null;
  }
  return r;
}

/** Bring a match into the scroller's view when it is not already in it, a third of the way down. */
function scrollToRange(scroller: HTMLElement, r: Range) {
  const box = r.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.top >= view.top && box.bottom <= view.bottom && view.height > 0) return;
  scroller.scrollTop += box.top - view.top - view.height / 3;
}

/**
 * The first match whose top is in the view or below it: where a new search
 * starts, so a match already on screen is not scrolled to. Matches run in
 * document order, so this is a binary search, measuring a few dozen ranges
 * rather than every one.
 */
function firstInView(
  scroller: HTMLElement,
  count: number,
  at: (i: number) => Range | null,
): number {
  const top = scroller.getBoundingClientRect().top;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = at(mid);
    if (r && r.getBoundingClientRect().top >= top) hi = mid;
    else lo = mid + 1;
  }
  return lo < count ? lo : 0;
}

const isTextField = (el: Element | null) =>
  !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");

/**
 * Find in a view that is not an editor. `root` is what is searched and scrolled;
 * `scope` is the view as the keyboard sees it (Cmd-F with focus inside it opens
 * the bar). `watch` changes whenever the view draws new text. `sides`, in the
 * compare view, adds a filter: both sides, or one of them.
 */
export function useFind({
  root,
  scope,
  watch,
  sides,
}: {
  root: RefObject<HTMLElement | null>;
  scope: RefObject<HTMLElement | null>;
  watch?: unknown;
  sides?: readonly FindSide[];
}): { bar: ReactNode; open: boolean } {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [side, setSide] = useState("both");
  const [index, setIndex] = useState(-1);
  const [count, setCount] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const bar = useRef<HTMLElement>(null);
  /** The segments searched and the matches in them; a match's Range is built when needed. */
  const found = useRef<{ segs: Segment[]; matches: FindMatch[] }>({ segs: [], matches: [] });
  /** Where focus was when the bar opened: Escape gives it back. */
  const returnTo = useRef<HTMLElement | null>(null);
  /** The next recount should bring the current match into view (a step, or typing). */
  const reveal = useRef<"first" | "current" | null>(null);
  /** Bumped by a DOM change under the root while the bar is open: a recount. */
  const [redrawn, setRedrawn] = useState(0);
  /** Bumped by each Cmd-F that opens or refocuses the bar. */
  const [focusAsk, setFocusAsk] = useState(0);
  const indexRef = useRef(index);
  indexRef.current = index;

  // A side that is no longer offered (the comparison changed) falls back to both.
  useEffect(() => {
    if (side !== "both" && !(sides ?? []).some((s) => s.value === side)) setSide("both");
  }, [side, sides]);

  // ── matching and painting ───────────────────────────────────────────────
  const rangeAt = useCallback((i: number): Range | null => {
    const { segs, matches } = found.current;
    const m = matches[i];
    return m ? rangeOf(segs, m) : null;
  }, []);
  /**
   * Paint the current match, and the others near it. Capped, as CodeMirror caps
   * its own: a common word in a long document can match a hundred thousand
   * times, and painting every one is the slowest thing the page could do.
   */
  /** The matches painted now, `[from, to)`: where the reader is, or the current one. */
  const painted = useRef<[number, number]>([0, 0]);
  const paint = useCallback(
    (i: number, around: number = i) => {
      const n = found.current.matches.length;
      const [from, to] = paintWindow(around, n);
      painted.current = [from, to];
      const rest: Range[] = [];
      for (let k = from; k < to; k++) {
        if (k === i) continue;
        const r = rangeAt(k);
        if (r) rest.push(r);
      }
      const current = i >= 0 ? rangeAt(i) : null;
      paintHighlight(FIND_MATCH_HL, rest);
      paintHighlight(FIND_CURRENT_HL, current ? [current] : []);
      return current;
    },
    [rangeAt],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` and `redrawn` are triggers: the text under the root was redrawn.
  useLayoutEffect(() => {
    const r = root.current;
    if (!open || !r) {
      found.current = { segs: [], matches: [] };
      clearHighlight(FIND_MATCH_HL, FIND_CURRENT_HL);
      return;
    }
    const segs = segmentsOf(r, side);
    const matches = findMatches(
      segs.map((g) => g.text),
      query,
      { matchCase },
    );
    found.current = { segs, matches };
    setCount(matches.length);
    const want = reveal.current;
    reveal.current = null;
    let i = indexRef.current;
    if (want === "first") i = firstInView(r, matches.length, rangeAt);
    if (matches.length === 0) i = -1;
    else if (i < 0 || i >= matches.length) i = Math.min(Math.max(i, 0), matches.length - 1);
    setIndex(i);
    const current = paint(i);
    if (current && want) scrollToRange(r, current);
  }, [open, query, matchCase, side, watch, redrawn, root]);

  // The painted window follows the reader. Scrolled by hand past the matches
  // painted, the window moves to the ones now in view, a beat after the scroll
  // settles; the current match stays the current one.
  useEffect(() => {
    const r = root.current;
    if (!open || !r) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const n = found.current.matches.length;
        if (n === 0) return;
        const k = firstInView(r, n, rangeAt);
        const [from, to] = painted.current;
        if (k >= from && k < to) return;
        paint(indexRef.current, k);
      }, 120);
    };
    r.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(t);
      r.removeEventListener("scroll", onScroll);
    };
  }, [open, root, rangeAt, paint]);

  // Painted only while open, and never left behind by a view that goes.
  useEffect(() => () => clearHighlight(FIND_MATCH_HL, FIND_CURRENT_HL), []);

  // A view can redraw without `watch` changing (a widget mounting, the backlinks
  // arriving): a change under the root while the bar is open is a recount.
  useEffect(() => {
    const r = root.current;
    if (!open || !r || typeof MutationObserver === "undefined") return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => setRedrawn((n) => n + 1), 80);
    });
    mo.observe(r, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(t);
      mo.disconnect();
    };
  }, [open, root]);

  // ── acts ────────────────────────────────────────────────────────────────
  const step = useCallback(
    (dir: 1 | -1) => {
      const n = found.current.matches.length;
      if (n === 0) return;
      const i = stepIndex(indexRef.current, n, dir);
      indexRef.current = i;
      setIndex(i);
      const current = paint(i);
      if (current && root.current) scrollToRange(root.current, current);
    },
    [paint, root],
  );

  const openBar = useCallback(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!bar.current?.contains(active)) returnTo.current = active;
    // Opened again, it starts from what is in view, not from the match it was on
    // when it closed: the reader has usually moved since.
    if (!open) reveal.current = "first";
    // A short selection in the view is the first query, as in the raw editor.
    const r = root.current;
    const sel = window.getSelection();
    if (r && sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const text = sel.toString();
      if (r.contains(range.commonAncestorContainer) && text.length <= 200 && !text.includes("\n")) {
        reveal.current = "first";
        setQuery(text);
      }
    }
    setOpen(true);
    setFocusAsk((n) => n + 1);
  }, [root, open]);
  // Focused as the bar is drawn, before the next key can arrive: the keys typed
  // straight after Cmd-F are the query.
  useLayoutEffect(() => {
    if (focusAsk === 0) return;
    input.current?.focus();
    input.current?.select();
  }, [focusAsk]);

  const close = useCallback(() => {
    setOpen(false);
    const back = returnTo.current;
    returnTo.current = null;
    if (back && back !== document.body && document.contains(back))
      back.focus({ preventScroll: true });
    else root.current?.focus({ preventScroll: true });
  }, [root]);

  // Cmd-F, wherever the focus is, decided by `findKeyAct`. Bubbling, after the
  // raw editor has had its chance: CodeMirror takes its own Mod-F and says so.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target instanceof Element ? e.target : null;
      const view = scope.current;
      if (isFindKey(e, onMac())) {
        const act = findKeyAct({
          inBar: !!t && !!bar.current?.contains(t),
          textField: isTextField(t),
          inEditor: !!t?.closest?.(".cm-editor"),
          // The document pane around this view: a click on Rendered or Compare
          // leaves the focus on that button, and Cmd-F there is meant for the view.
          inPane:
            !!t &&
            !!view &&
            (view.contains(t) || !!t.closest?.('[data-pane="centre"]')?.contains(view)),
          nowhere: !t || t === document.body || t === document.documentElement,
        });
        if (act === "pass") return;
        e.preventDefault();
        if (act === "own") input.current?.select();
        else openBar();
        return;
      }
      // Escape in the view, outside the bar, also closes it.
      if (
        e.key === "Escape" &&
        open &&
        t &&
        view?.contains(t) &&
        !bar.current?.contains(t) &&
        !isTextField(t)
      ) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scope, open, openBar, close]);

  const field = cn(
    "h-6 rounded-md border border-edge bg-bg px-[7px] font-mono text-[12px] text-ink outline-none",
    "placeholder:text-ink-faint focus:border-brand focus:ring-2 focus:ring-brand/45",
  );
  const control = cn(
    "flex h-6 items-center gap-1 rounded-md border border-edge px-2 text-[12px] text-ink-dim outline-none",
    "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40",
  );

  const choices: FindSide[] = sides?.length
    ? [{ value: "both", label: "both", title: "Both sides" }, ...sides]
    : [];

  const node = open ? (
    <search
      ref={bar}
      aria-label="Find in this view"
      data-slot="find-bar"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-edge bg-surface-raised px-2.5 py-1.5 font-sans text-[12px] text-ink"
    >
      <input
        ref={input}
        type="text"
        value={query}
        placeholder="Find"
        aria-label="Find"
        spellCheck={false}
        className={cn(field, "w-52")}
        onChange={(e) => {
          reveal.current = "first";
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            close();
          } else if (e.key.toLowerCase() === "g" && (e.metaKey || e.ctrlKey) && !e.altKey) {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span
        aria-live="polite"
        data-slot="find-count"
        className="min-w-16 text-ink-faint tabular-nums"
      >
        {countLabel(index, count, query)}
      </span>
      <button
        type="button"
        className={control}
        onClick={() => step(1)}
        disabled={count === 0}
        title="Next match (Enter)"
      >
        <ChevronDownIcon aria-hidden className="size-3" />
        next
      </button>
      <button
        type="button"
        className={control}
        onClick={() => step(-1)}
        disabled={count === 0}
        title="Previous match (Shift-Enter)"
      >
        <ChevronUpIcon aria-hidden className="size-3" />
        previous
      </button>
      <label className="inline-flex items-center gap-1 text-ink-dim">
        <input
          type="checkbox"
          checked={matchCase}
          onChange={(e) => {
            reveal.current = "first";
            setMatchCase(e.target.checked);
          }}
        />
        match case
      </label>
      {choices.length > 0 && (
        <div
          role="radiogroup"
          aria-label="Search in"
          className="flex items-center gap-0.5 rounded-md border border-edge p-0.5"
          // A radio group moves with the arrow keys, and is one Tab stop.
          onKeyDown={(e) => {
            const dir =
              e.key === "ArrowRight" || e.key === "ArrowDown"
                ? 1
                : e.key === "ArrowLeft" || e.key === "ArrowUp"
                  ? -1
                  : 0;
            if (!dir) return;
            e.preventDefault();
            const at = choices.findIndex((c) => c.value === side);
            const next = choices[(at + dir + choices.length) % choices.length];
            if (!next) return;
            reveal.current = "first";
            setSide(next.value);
            e.currentTarget.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
          }}
        >
          {choices.map((s) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented control; radio inputs would not take this styling.
            <button
              key={s.value}
              type="button"
              role="radio"
              data-value={s.value}
              aria-checked={side === s.value}
              tabIndex={side === s.value ? 0 : -1}
              title={s.title ?? s.label}
              onClick={() => {
                reveal.current = "first";
                setSide(s.value);
              }}
              className={cn(
                "rounded-sm px-1.5 py-px text-[12px] text-ink-faint outline-none",
                "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                side === s.value && "bg-bg font-medium text-ink shadow-sm",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={close}
        className="ml-auto px-1 text-[16px] leading-none text-ink-dim outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </search>
  ) : null;

  return { bar: node, open };
}
