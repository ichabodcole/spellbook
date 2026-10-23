// The rendered half of the document pane. The markdown is turned into HTML by
// `rendered.ts` (the kit's renderer, with an app's inline widgets given a span
// each), styled by the kit's `.md-prose` rules, and shown read-only. Each widget's
// node is mounted into its span.
//
// Clicks are the one piece of behaviour here. A rendered document is full of links,
// and this page is not a browser: following one in place would replace the surface
// with a web page and take the human's session with it. An external link opens in a
// new tab, a link to a document goes to the daemon, and a link the renderer refused
// does nothing (`onRenderedLinkClick`, shared with the chat log).
//
// And selection. Reading is where a passage is worth talking about, so a selection
// here has to mean the same thing as one made in the raw view: SOURCE offsets, which
// the chat attaches and a note anchors to. `projection.ts` makes that
// possible; this component is the part that watches the DOM.
//
// A leading frontmatter block is not part of the rendered body: `FrontmatterHeader`
// draws it above the body and outside the element the projection is aligned
// against, and the projection skips it, so every offset this view reports is still
// a whole-text offset.
//
// Embeds (`![alt](x.png)`) arrive as empty spans, nothing fetched (`embeds.tsx`):
// the view reports their targets (`onEmbedTargets`), the pane asks the daemon what
// each one is, and the answers (`embeds`) draw each image, or say why not, into its
// span, as a widget is drawn.
//
// Note highlights are painted, not wrapped. They use the CSS Custom Highlight API, so
// nothing is inserted into the rendered HTML, which matters because that HTML is the
// one sink. Where the API is missing, notes are simply not highlighted and everything
// else still works.
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { onRenderedLinkClick } from "../chat/renderedLink.ts";
import { contextPressAfter, renderedSelectionAct } from "../context/selection.ts";
import { TooltipProvider } from "../ui/tooltip.tsx";
import type { DocumentProfile, PlacedNote } from "../workspace/protocol";
import { useCoalescedText } from "./coalesce.ts";
import type { SelectionReport } from "./DocumentView.tsx";
import { Embed, type EmbedSource, pendingEmbeds } from "./embeds.tsx";
import { useFind } from "./FindBar.tsx";
import {
  type FrontmatterChips,
  FrontmatterHeader,
  headerFieldElements,
} from "./FrontmatterHeader.tsx";
import { frontmatterKeyAt, readFrontmatter } from "./frontmatter.ts";
import { highlightRegistry, makeHighlight } from "./highlight.ts";
import type { AskProfileFix } from "./ProfileChip.tsx";
import { type Anchor, anchorCache, lineAtTop, type Place, topForLine } from "./place.ts";
import { lineAt, project } from "./projection.ts";
import { type InlineWidget, renderDocument } from "./rendered.ts";
import { align, lineAnchors, paintRange, resolveRange } from "./renderedRange.ts";
import { invertChange, lineThrough, minimalChange, rangeThrough } from "./text.ts";

/** No widgets: one array, so the rendering is not redone on every render. */
const NO_WIDGETS: readonly InlineWidget[] = [];

/** The highlight registry's names: one for notes, one for the focused note, one for the pending one. */
const NOTE_HL = "doc-note";
const FOCUS_HL = "doc-note-focus";
const PENDING_HL = "doc-note-pending";
/** A passage just brought into view: painted for `FLASH_PAINT_MS`, then gone. */
const FLASH_HL = "doc-flash";
const FLASH_PAINT_MS = 1600;

/** The source offset under a point: what decides which notes were clicked. */
function pointOffset(
  root: HTMLElement,
  projection: ReturnType<typeof project>,
  x: number,
  y: number,
): number | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(x, y);
  else if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.setEnd(pos.offsetNode, pos.offset);
    }
  }
  if (!range || !root.contains(range.startContainer)) return null;
  // A caret is a POINT; `resolveRange` refuses an empty range, so widen it by one
  // character and take the start of what comes back.
  const probe = document.createRange();
  probe.setStart(range.startContainer, range.startOffset);
  const node = range.startContainer;
  const len = node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : 0;
  probe.setEnd(node, Math.min(range.startOffset + 1, len));
  return resolveRange(root, projection, probe)?.from ?? null;
}

export function MarkdownView({
  text: textIn,
  textKey = "",
  notes: notesIn,
  focusedNote,
  pendingNote: pendingIn,
  onFollowLink,
  onFollowHeading,
  onSelect,
  clearSeq,
  onContextMenu,
  place,
  widgets = NO_WIDGETS,
  frontmatterChips,
  frontmatterTrust = true,
  profile,
  onAskProfileFix,
  footer,
  flash: flashIn,
  embeds,
  onEmbedTargets,
}: {
  text: string;
  /**
   * What `text` is the text of (a document and version). A large document's text
   * that changes again while the last one is still being drawn is coalesced
   * (`useCoalescedText`); a new key is drawn at once.
   */
  textKey?: string;
  /** The document's notes, already placed by the daemon. */
  notes?: PlacedNote[];
  /** The note the panel has focused: painted differently. */
  focusedNote?: string | null;
  /**
   * The passage a note is being written about, painted while its composer is open:
   * the right-click that opened the composer collapsed the browser's own selection,
   * so without a mark of our own the human writes a note about text that no longer
   * looks chosen.
   */
  pendingNote?: { from: number; to: number } | null;
  /** A link to another document: the daemon resolves it against the set. */
  onFollowLink?: (target: string) => void;
  /**
   * A fragment-only link (`#Heading`) that no element here carries as an id
   * (a footnote does): the heading it names in this document is looked for.
   */
  onFollowHeading?: (anchor: string) => void;
  /** The same values the raw view reports, in source coordinates. */
  onSelect?: (s: SelectionReport) => void;
  /** Bumped when the held selection goes away: the highlight goes with it. */
  clearSeq?: number;
  onContextMenu?: (at: {
    x: number;
    y: number;
    from: number;
    to: number;
    noteIds: string[];
  }) => void;
  /** The source line at the top of this pane, shared with the raw one. */
  place?: Place;
  /** An app's inline widgets: spans of the text drawn as its own nodes. */
  widgets?: readonly InlineWidget[];
  /** An app's chips for the frontmatter header: see `FrontmatterChips`. */
  frontmatterChips?: FrontmatterChips;
  /** The frontmatter header's trust chip: see `DefaultChipOptions`. On by default. */
  frontmatterTrust?: boolean;
  /** The document's profile, for the frontmatter header: see `FrontmatterHeader`. */
  profile?: DocumentProfile | null;
  /** The header's "Ask the agent to fix". */
  onAskProfileFix?: AskProfileFix;
  /**
   * Drawn below the body, in the same scroll (the backlinks). Outside the element
   * the projection aligns against, so nothing in it is a source offset.
   */
  footer?: ReactNode;
  /**
   * A passage just brought into view (a reveal, or the agent pointing at it),
   * in source offsets: marked for a moment, since the rendered view has no
   * selection to move. A new `seq` marks again.
   */
  flash?: { from: number; to: number; seq: number } | null;
  /** What each embed shows, and how to draw and open it. Without it, embeds stay placeholders. */
  embeds?: EmbedSource;
  /** The distinct embed targets in this rendering, said once per rendering: what to ask the daemon. */
  onEmbedTargets?: (targets: string[]) => void;
}) {
  // Everything below reads the text drawn, which trails `textIn` only while a
  // costly redraw's pause runs. Every position crossing between this view and
  // the pane is mapped between the two: what the pane hands in (notes, the
  // pending note, a flash) is in `textIn` and is painted on the drawn text, and
  // what this view reports (a selection, a context menu) is measured on the
  // drawn text and reported in `textIn`. A position inside what changed means
  // nothing in the other text, so it is dropped, never guessed.
  const text = useCoalescedText(textIn, textKey);
  const toShown = useMemo(() => minimalChange(text, textIn), [text, textIn]);
  const toDrawn = useMemo(() => (toShown ? invertChange(toShown, text) : null), [toShown, text]);
  const notes = useMemo(
    () =>
      !toDrawn || !notesIn
        ? notesIn
        : notesIn.flatMap((n) => {
            if (n.from === null || n.to === null) return [n];
            const m = rangeThrough({ from: n.from, to: n.to }, toDrawn);
            return m ? [{ ...n, ...m }] : [];
          }),
    [notesIn, toDrawn],
  );
  const pendingNote = useMemo(
    () => (pendingIn && toDrawn ? rangeThrough(pendingIn, toDrawn) : pendingIn),
    [pendingIn, toDrawn],
  );
  const flash = useMemo(() => {
    if (!flashIn || !toDrawn) return flashIn;
    const m = rangeThrough(flashIn, toDrawn);
    return m ? { ...m, seq: flashIn.seq } : null;
  }, [flashIn, toDrawn]);
  /** A range measured on the drawn text, in `textIn`; null when it cannot be mapped. */
  const reportable = useRef<
    (r: { from: number; to: number }) => { from: number; to: number } | null
  >((r) => r);
  reportable.current = (r) => rangeThrough(r, toShown);
  const currentText = useRef(textIn);
  currentText.current = textIn;
  /**
   * The shared place speaks lines of the pane's text: a line asked for is moved
   * onto the drawn text, and the line at the top is said in the pane's. A line
   * inside what changed goes to the nearer edge of the change, so a reveal still
   * scrolls.
   */
  const placeLines = useRef({
    toDrawn: (line: number) => line,
    toShown: (line: number) => line,
  });
  placeLines.current = {
    toDrawn: (line) => lineThrough(line, textIn, text, toDrawn),
    toShown: (line) => lineThrough(line, text, textIn, toShown),
  };
  const frontmatter = useMemo(() => readFrontmatter(text), [text]);
  const html = useMemo(() => renderDocument(text, widgets), [text, widgets]);
  // Memoised, and everything about selection depends on it. React compares the
  // `dangerouslySetInnerHTML` prop OBJECT, not the `__html` string inside it, so a
  // fresh literal per render would replace the entire subtree on every commit, even
  // when the markup is character-for-character identical. Reporting a selection
  // re-renders, the re-render would rebuild every text node, and the browser would
  // re-anchor the now-homeless selection to the start of the container.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);
  // The same text, as the reader sees it, carrying where each part came from.
  const projection = useMemo(() => project(text), [text]);
  const body = useRef<HTMLDivElement>(null);
  /** The frontmatter header's box: where a reveal in the frontmatter is marked. */
  const headerBox = useRef<HTMLDivElement>(null);
  // Every widget's span in the current rendering, and the node drawn into it.
  // Collected after the HTML is in the DOM, and again whenever it is replaced (the old
  // spans are gone with it).
  const [widgetSpans, setWidgetSpans] = useState<{ el: Element; node: ReactNode }[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new rendering replaces the spans, so `html` is the trigger.
  useLayoutEffect(() => {
    const found: { el: Element; node: ReactNode }[] = [];
    for (const w of widgets) {
      for (const el of body.current?.getElementsByClassName(w.className) ?? []) {
        const node = w.render(el.textContent ?? "");
        if (node !== null && node !== undefined) found.push({ el, node });
      }
    }
    setWidgetSpans(found);
  }, [html]);
  // Every embed waiting on the daemon in this rendering, found as the widgets
  // are, and its targets said to whoever asks the daemon about them.
  const [embedSpans, setEmbedSpans] = useState<{ el: HTMLElement; target: string }[]>([]);
  const onEmbedTargetsRef = useRef(onEmbedTargets);
  onEmbedTargetsRef.current = onEmbedTargets;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new rendering replaces the spans, so `html` is the trigger.
  useLayoutEffect(() => {
    const found = body.current ? pendingEmbeds(body.current) : [];
    setEmbedSpans(found);
    onEmbedTargetsRef.current?.([...new Set(found.map((e) => e.target))]);
  }, [html]);
  /**
   * The last selection this pane resolved. A right-click destroys the thing it is
   * asking about: the raw view survives that because CodeMirror's selection is a
   * model, but the rendered view has only the DOM's, and pressing a button
   * collapses it. It is only trusted when the pointer is INSIDE the remembered
   * range, so a right-click elsewhere never offers a note on the previous passage.
   */
  const lastRange = useRef<{ from: number; to: number } | null>(null);

  // Keeping your place.
  const scroller = useRef<HTMLDivElement>(null);
  // Read through a ref rather than a dependency, so a keystroke (which makes a new
  // projection every pause) does not tear down and re-arm the scroll listeners, and
  // above all does not re-run the arrival scroll: that would jump the reader to the
  // remembered line every time they typed.
  const measureRef = useRef<() => Anchor[]>(() => []);
  const measureFrom = useRef({ projection, text });
  measureFrom.current = { projection, text };
  const anchors = useRef<ReturnType<typeof anchorCache> | null>(null);
  if (!anchors.current)
    anchors.current = anchorCache(
      () => {
        const root = body.current;
        const sc = scroller.current;
        if (!root || !sc) return [];
        return lineAnchors(root, sc, measureFrom.current.projection, measureFrom.current.text);
      },
      () => scroller.current?.clientWidth ?? 0,
    );
  measureRef.current = () =>
    body.current && scroller.current ? (anchors.current?.get() ?? []) : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new rendering is the trigger.
  useEffect(() => {
    anchors.current?.clear();
    const sc = scroller.current;
    if (!sc || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      anchors.current?.clear();
    });
    ro.observe(sc);
    // And the content, not just the scroller: the scroller's own box does not
    // change when what is inside it grows, so a late font swap would move every
    // block and leave the table describing where they used to be.
    if (body.current) ro.observe(body.current);
    return () => ro.disconnect();
  }, [html, projection]);

  // Reported synchronously, not throttled to a frame. The place tells a drive's own
  // scroll event apart from the human's by ORDER (a scroll event is dispatched before
  // that frame's animation callbacks), and deferring the report would put it on the
  // wrong side of that line.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !place) return;
    const onScroll = () =>
      place.report(
        "rendered",
        placeLines.current.toShown(lineAtTop(measureRef.current(), sc.scrollTop)),
      );
    sc.addEventListener("scroll", onScroll, { passive: true });
    const leave = place.join("rendered", {
      to: (line) => {
        sc.scrollTop = topForLine(measureRef.current(), placeLines.current.toDrawn(line));
      },
      at: () => sc.scrollTop,
    });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      leave();
    };
  }, [place]);

  /**
   * The part of `range` inside the rendered body, or null when there is none or
   * the range reaches outside this pane. A drag from the prose into the footer
   * (the backlinks) or up into the frontmatter header keeps only the prose: those
   * are drawn outside the body and have no source offsets, so they are never
   * part of what a selection reports.
   */
  const inBody = useCallback((range: Range): Range | null => {
    const root = body.current;
    const pane = scroller.current;
    if (!root || !pane) return null;
    if (root.contains(range.commonAncestorContainer)) return range;
    if (!pane.contains(range.commonAncestorContainer) || !range.intersectsNode(root)) return null;
    // Clamped to the body's first and last TEXT, which is what `resolveRange`
    // maps; an element boundary has no source offset of its own.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let first: Text | null = null;
    let last: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      first ??= n as Text;
      last = n as Text;
    }
    if (!first || !last) return null;
    const all = document.createRange();
    all.setStart(first, 0);
    all.setEnd(last, last.data.length);
    const r = range.cloneRange();
    if (r.compareBoundaryPoints(Range.START_TO_START, all) < 0) r.setStart(first, 0);
    if (r.compareBoundaryPoints(Range.END_TO_END, all) > 0) r.setEnd(last, last.data.length);
    return r.collapsed ? null : r;
  }, []);

  /** The current DOM selection as source offsets, or null. */
  const selectedRange = useCallback((): { from: number; to: number } | null => {
    const root = body.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    // A selection that started outside this pane is not ours to report.
    const range = inBody(sel.getRangeAt(0));
    return range ? resolveRange(root, projection, range) : null;
  }, [projection, inBody]);

  /**
   * Whether the last press in this pane was a context-menu press OVER the selection.
   * A right-click collapses the selection before `contextmenu` fires, and that
   * collapse must not clear the passage the menu is about to offer a note on.
   */
  const contextPress = useRef(false);
  /**
   * Whether the last pointer press in the document landed inside this pane. It is the
   * attribution for a selection that is gone: when Chrome empties the selection there
   * is no node left to ask whose it was, and without this a click into the chat
   * composer would read like a click in the text and clear the passage the human is
   * about to write about.
   */
  const pressedHere = useRef(false);

  // Reported on `selectionchange`, not on `mouseup`: a keyboard selection and a
  // double-click both land here, and mouseup misses the first. A collapse is news
  // too: clicking in the text clears the selection, so it has to clear the chip.
  // `renderedSelectionAct` holds the rules. There is no dedupe here: the shell's held
  // selection dedupes against what is actually held.
  useEffect(() => {
    if (!onSelect) return;
    const handler = () => {
      const root = body.current;
      const sel = window.getSelection();
      if (!root || !sel) return;
      // No range at all is news too: Chrome empties the selection, rather than
      // collapsing it, when a click lands inside the selected text.
      const gone = sel.rangeCount === 0;
      const r = gone || sel.isCollapsed ? null : selectedRange();
      const act = renderedSelectionAct({
        gone,
        ours:
          !gone &&
          (root.contains(sel.getRangeAt(0).commonAncestorContainer) ||
            (!sel.isCollapsed && inBody(sel.getRangeAt(0)) !== null)),
        collapsed: gone || sel.isCollapsed,
        resolved: r,
        contextClick: contextPress.current,
        pressedHere: pressedHere.current,
      });
      // Measured on the drawn text, reported in the pane's: a selection whose ends
      // fall in what changed since is cleared, never sent with the wrong lines.
      const m = act === "report" && r ? reportable.current(r) : null;
      if (act === "report" && r && m) {
        lastRange.current = r;
        const now = currentText.current;
        onSelect({
          from: m.from,
          to: m.to,
          fromLine: lineAt(now, m.from),
          toLine: lineAt(now, m.to),
          text: now.slice(m.from, m.to),
        });
      } else if (act === "clear" || (act === "report" && r)) {
        lastRange.current = null;
        onSelect({ from: 0, to: 0, fromLine: 1, toLine: 1, text: "" });
      }
    };
    // A key ends a context press: the collapse it is about to cause is a caret move.
    const keyed = () => {
      contextPress.current = contextPressAfter({ kind: "keydown" });
    };
    // On the document, not the pane, because the fact needed is where the press
    // LANDED, and the press that must not clear the passage (into the chat composer)
    // lands outside this pane.
    const pressed = (e: PointerEvent) => {
      const pane = scroller.current;
      pressedHere.current = !!pane && pane.contains(e.target as Node);
    };
    document.addEventListener("selectionchange", handler);
    document.addEventListener("keydown", keyed, true);
    document.addEventListener("pointerdown", pressed, true);
    return () => {
      document.removeEventListener("selectionchange", handler);
      document.removeEventListener("keydown", keyed, true);
      document.removeEventListener("pointerdown", pressed, true);
    };
  }, [onSelect, selectedRange, inBody]);

  // A clear clears the highlight too: dropping the chip is clearing the selection, so
  // the browser's own must not stay painted over a passage nothing is holding.
  const unpainted = useRef(clearSeq);
  useEffect(() => {
    if (clearSeq === undefined || clearSeq === unpainted.current) return;
    unpainted.current = clearSeq;
    lastRange.current = null;
    const root = body.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0) return;
    if (root.contains(sel.getRangeAt(0).commonAncestorContainer)) sel.removeAllRanges();
  }, [clearSeq]);

  // The notes, painted over the rendered text. Re-runs when the HTML changes,
  // because every text node it aligned against has been replaced.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new rendering replaces the text nodes, so `html` is the trigger.
  useEffect(() => {
    const reg = highlightRegistry();
    const root = body.current;
    if (!reg || !root) return;
    const placed = (notes ?? []).filter((n) => n.from !== null && n.to !== null);
    const a = align(root, projection);
    const plain: Range[] = [];
    const focused: Range[] = [];
    for (const n of placed) {
      const r = paintRange(a, projection, n.from as number, n.to as number);
      if (!r) continue;
      (n.id === focusedNote ? focused : plain).push(r);
    }
    const pending =
      pendingNote && pendingNote.from < pendingNote.to
        ? paintRange(a, projection, pendingNote.from, pendingNote.to)
        : null;
    const one = makeHighlight(plain);
    const two = makeHighlight(focused);
    const three = makeHighlight(pending ? [pending] : []);
    if (one) reg.set(NOTE_HL, one);
    if (two) reg.set(FOCUS_HL, two);
    if (three) reg.set(PENDING_HL, three);
    return () => {
      reg.delete(NOTE_HL);
      reg.delete(FOCUS_HL);
      reg.delete(PENDING_HL);
    };
  }, [notes, projection, focusedNote, pendingNote, html]);

  // The flash: the same painting, for a moment. Keyed on `seq`, so a re-render
  // during it does not restart the clock, and a new reveal does.
  const flashSeq = flash?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request's seq is the trigger; its offsets are read with it.
  useEffect(() => {
    // In the frontmatter, which is drawn as the header and not as text: the field
    // the range is in is marked instead, the way the compare view marks a row.
    const key = flash ? frontmatterKeyAt(text, flash.from) : null;
    const box = headerBox.current?.querySelector<HTMLElement>('[data-slot="frontmatter-header"]');
    if (key !== null && box) {
      const marked = headerFieldElements(box, key);
      for (const el of marked) el.setAttribute("data-flash", "on");
      marked[0]?.scrollIntoView?.({ block: "center" });
      const t = setTimeout(() => {
        for (const el of marked) el.removeAttribute("data-flash");
      }, FLASH_PAINT_MS);
      return () => {
        clearTimeout(t);
        for (const el of marked) el.removeAttribute("data-flash");
      };
    }
    const reg = highlightRegistry();
    const root = body.current;
    if (!reg || !root || !flash || flash.from >= flash.to) return;
    const r = paintRange(align(root, projection), projection, flash.from, flash.to);
    const hl = makeHighlight(r ? [r] : []);
    if (!hl) return;
    reg.set(FLASH_HL, hl);
    const t = setTimeout(() => reg.delete(FLASH_HL), FLASH_PAINT_MS);
    return () => {
      clearTimeout(t);
      reg.delete(FLASH_HL);
    };
  }, [flashSeq]);

  // Cmd-F: the kit's find bar, above the scroller and outside the body, so its
  // own text is never part of what the projection aligns against.
  const view = useRef<HTMLDivElement>(null);
  const { bar } = useFind({ root: scroller, scope: view, watch: html });

  return (
    <div ref={view} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {bar}
      {/* Focusable by script only (-1), so it is the nearest focusable ancestor of a
          press on the rendered text. Otherwise the press focuses the shell's centre
          pane, the pane hands that focus to the raw editor (in split it exists), and
          CodeMirror taking focus collapses the selection the human is dragging. */}
      <div
        ref={scroller}
        tabIndex={-1}
        className="min-h-0 flex-1 overflow-auto outline-none"
        data-slot="markdown-view"
      >
        {frontmatter && (
          <div ref={headerBox} className="mx-auto max-w-[76ch] px-8 pt-7">
            <FrontmatterHeader
              frontmatter={frontmatter}
              chips={frontmatterChips}
              trust={frontmatterTrust}
              profile={profile}
              onAskProfileFix={onAskProfileFix}
            />
          </div>
        )}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler exists to intercept clicks on ANCHORS inside rendered markdown, and an anchor already fires click on Enter; a keyboard handler here would double-handle it. */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: same reason: the interactive elements are the anchors the renderer minted inside this container, each already focusable. */}
        <div
          ref={body}
          className={
            frontmatter
              ? "md-prose mx-auto max-w-[76ch] px-8 pb-16"
              : "md-prose mx-auto max-w-[76ch] px-8 pt-7 pb-16"
          }
          onClick={(e) => onRenderedLinkClick(e, onFollowLink, onFollowHeading)}
          onPointerDown={(e) => {
            // A right button, or macOS's ctrl-click, is a context-menu press.
            const isContext = e.button === 2 || (e.button === 0 && e.ctrlKey);
            const root = body.current;
            const held = lastRange.current;
            const point =
              isContext && root ? pointOffset(root, projection, e.clientX, e.clientY) : null;
            contextPress.current = contextPressAfter({
              kind: "pointerdown",
              context:
                isContext &&
                held !== null &&
                point !== null &&
                point >= held.from &&
                point <= held.to,
            });
          }}
          onContextMenu={(e) => {
            if (!onContextMenu) return;
            const root = body.current;
            // Over a selection OR over a note, the rule the raw view holds: with
            // neither, the browser's own menu is left alone.
            const point = root ? pointOffset(root, projection, e.clientX, e.clientY) : null;
            // The live selection if the click spared it, else the remembered one, but
            // only when the pointer is inside it.
            const remembered = lastRange.current;
            const r =
              selectedRange() ??
              (remembered && point !== null && point >= remembered.from && point <= remembered.to
                ? remembered
                : null);
            const noteIds =
              point === null
                ? []
                : (notes ?? [])
                    .filter(
                      (n) =>
                        n.from !== null &&
                        n.to !== null &&
                        point >= (n.from as number) &&
                        point <= (n.to as number),
                    )
                    .map((n) => n.id);
            // In the pane's text; a selection in what changed since offers nothing.
            const m = r ? reportable.current(r) : null;
            if (!m && noteIds.length === 0) return;
            e.preventDefault();
            onContextMenu({
              x: e.clientX,
              y: e.clientY,
              from: m?.from ?? 0,
              to: m?.to ?? 0,
              noteIds,
            });
          }}
          // THE ONE HTML SINK IN THIS SURFACE, and what makes it safe is upstream:
          // markdown renderer output only, so raw HTML in the document is encoded and
          // every link target has been checked. A test fails if another sink appears,
          // or if this one is ever fed by anything but `renderDocument`.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: the sink the comment above describes.
          dangerouslySetInnerHTML={htmlProp}
        />
        {footer}
        <TooltipProvider delay={200}>
          {widgetSpans.map(({ el, node }, i) => createPortal(node, el, `widget-${i}`))}
        </TooltipProvider>
        {embeds &&
          embedSpans.map(({ el, target }, i) =>
            createPortal(
              <Embed
                el={el}
                view={embeds.views.get(target)}
                source={embeds}
                onFollowLink={onFollowLink}
              />,
              el,
              `embed-${i}`,
            ),
          )}
      </div>
    </div>
  );
}
