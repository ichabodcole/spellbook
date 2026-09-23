// The rendered half of the document pane (E29). The markdown is turned into
// HTML by `state/markdown.ts` — the ONLY thing in this surface allowed to feed
// an HTML sink, which `src/scriptorium/sinks.test.ts` holds — and styled by the
// `.md-prose` rules in styles.css, which are written in the spell's own tokens
// so both themes follow.
//
// Clicks are the one piece of behaviour here. A rendered document is full of
// links, and this page is not a browser: following one in place would replace
// the surface with a web page and take the human's session with it. An external
// link opens in a new tab; an INTERNAL one goes to the daemon (E33), which
// knows what the bundle is and is the only side allowed to open a file. A link
// the renderer refused (`data-blocked-link`) does nothing at all.
//
// ⛔ AND SELECTION, WHICH IS E51. Reading is where a passage is worth talking
// about, and the rendered view is where reading happens — so a selection here
// has to mean the same thing as one made in the raw view: SOURCE offsets, which
// the chat attaches and a note anchors to. `state/projection.ts` is what makes
// that possible; this component is the part that watches the DOM.
//
// ⚠ NOTE HIGHLIGHTS ARE PAINTED, NOT WRAPPED. They use the CSS Custom Highlight
// API, so nothing is inserted into the rendered HTML — which matters because
// that HTML is the one sink, and wrapping a note's passage in a `<mark>` would
// mean this component editing the renderer's output. Where the API is missing,
// the notes are simply not highlighted and everything else still works.
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { DocMeta, PlacedNote } from "../../backend/protocol";
import { renderMarkdown, splitFrontmatter } from "../state/markdown";
import { type Anchor, lineAtTop, type Place, topForLine } from "../state/place";
import { lineAt, project } from "../state/projection";
import { align, lineAnchors, paintRange, resolveRange } from "../state/renderedRange";
import { contextPressAfter, renderedSelectionAct } from "../state/selection";
import { MetaHeader } from "./MetaHeader";

/** http(s) and mailto open outward; everything else is inert for now. */
const OPENS_OUTWARD = /^(https?:|mailto:)/i;

/** The highlight registry's names — one for notes, one for the focused note. */
const NOTE_HL = "scriptorium-note";
const FOCUS_HL = "scriptorium-note-focus";
const PENDING_HL = "scriptorium-note-pending";

/** `Highlight` and `CSS.highlights` are recent; treat both as optional. */
type HighlightRegistry = Map<string, unknown> & { delete(name: string): boolean };
function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const has = typeof (globalThis as { Highlight?: unknown }).Highlight === "function";
  return has && css?.highlights ? css.highlights : null;
}
function makeHighlight(ranges: Range[]): unknown | null {
  const Ctor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  return Ctor ? new Ctor(...ranges) : null;
}

export function MarkdownView({
  text,
  meta,
  notes,
  focusedNote,
  pendingNote,
  onFollowLink,
  onSelect,
  clearSeq,
  onContextMenu,
  place,
}: {
  text: string;
  meta?: DocMeta | null;
  /** The document's notes, already placed by the daemon (E45). */
  notes?: PlacedNote[];
  /** The note the panel has focused (E47) — painted differently. */
  focusedNote?: string | null;
  /**
   * The passage a note is being written about, painted while the composer is
   * open (E46). ⛔ THIS IS WHAT KEEPS THE PASSAGE VISIBLE: the right-click that
   * opened the composer collapsed the browser's own selection, so without a
   * mark of our own the human writes a note about text that no longer looks
   * chosen. The raw view paints `cm-note-pending` for exactly this reason.
   */
  pendingNote?: { from: number; to: number } | null;
  /** A link to another document: the daemon resolves it against the set (E33). */
  onFollowLink?: (target: string) => void;
  /** E51: the same five values the raw view reports, in source coordinates. */
  onSelect?: (from: number, to: number, fromLine: number, toLine: number, text: string) => void;
  /** Bumped when the held selection goes away — the highlight goes with it. */
  clearSeq?: number;
  /** E46's composer, reached from the rendered view too. */
  onContextMenu?: (at: {
    x: number;
    y: number;
    from: number;
    to: number;
    noteIds: string[];
  }) => void;
  /** E63: the source line at the top of this pane, shared with the raw one. */
  place?: Place;
}) {
  // The frontmatter is METADATA, so it leaves the rendered body and becomes the
  // header above it (E32). The raw view still shows it: there, it IS the file.
  const html = useMemo(() => renderMarkdown(splitFrontmatter(text).body), [text]);
  /**
   * ⛔ MEMOISED, AND THE WHOLE OF E51 DEPENDS ON IT. React 19 compares the
   * `dangerouslySetInnerHTML` PROP OBJECT, not the `__html` string inside it —
   * so a fresh `{ __html: html }` literal per render makes every commit call
   * `setInnerHTML` again and REPLACE THE ENTIRE SUBTREE, even when the markup is
   * character-for-character identical.
   *
   * That was harmless while nothing in this pane cared about the DOM. It stopped
   * being harmless the moment a selection lived here: reporting a selection
   * re-renders, the re-render rebuilt every text node, and the browser re-anchored
   * the now-homeless selection to the start of the container. Which is exactly
   * what Cole saw — "any selection I make is actually starting from the beginning
   * of the content", plus a selection that flickered and died on mouse-up.
   *
   * MEASURED, not reasoned: a MutationObserver on `.md-prose` recorded 10 childList
   * records for a single drag, each removing all ten children and adding ten new
   * ones, and a patched `innerHTML` setter named the writer —
   * `setProp → updateProperties → commitUpdate`, i.e. React on every commit.
   */
  const htmlProp = useMemo(() => ({ __html: html }), [html]);
  // The same text, as the human sees it, carrying where each part came from.
  const projection = useMemo(() => project(text), [text]);
  const body = useRef<HTMLDivElement>(null);
  /**
   * The last selection this pane resolved.
   *
   * ⛔ THIS EXISTS BECAUSE A RIGHT-CLICK DESTROYS THE THING IT IS ASKING ABOUT.
   * The raw view survives that by holding its own selection — CodeMirror's
   * `state.selection` is a model, so the contextmenu handler reads a selection
   * the click cannot touch. The rendered view has only the DOM's, and pressing
   * a button collapses it: MEASURED in the browser, where right-clicking the
   * passage that was selected opened a menu with nothing to act on. Remembering
   * it is what makes "select, then right-click" work here at all, and it is
   * only trusted when the pointer is INSIDE the remembered range — otherwise a
   * right-click elsewhere would silently offer a note on the previous passage.
   */
  const lastRange = useRef<{ from: number; to: number } | null>(null);

  // ── keeping your place (E63) ───────────────────────────────────────────────
  const scroller = useRef<HTMLDivElement>(null);
  /**
   * The block anchors, measured once and kept until the rendering changes.
   *
   * ⛔ NOT ON EVERY SCROLL. Measuring walks every element and reads a rect from
   * each, which forces layout; doing that per scroll event in a split would
   * make the pane the human is dragging stutter. The rendering only moves when
   * the html or the pane's width does, so those are what clear it.
   */
  const anchors = useRef<Anchor[] | null>(null);
  /**
   * Read through a ref rather than a dependency, so a keystroke — which makes a
   * new projection every 250 ms — does not tear down and re-arm the scroll
   * listeners, and above all does not re-run the arrival scroll: that would
   * jump the reader to the remembered line every time they typed.
   */
  const measureRef = useRef<() => Anchor[]>(() => []);
  /**
   * The scroller width the anchors were measured at.
   *
   * ⛔ THE RESIZE OBSERVER BELOW IS TOO LATE FOR ONE EVENT (E64). A column
   * collapsing widens this pane in a single layout, the browser's scroll
   * anchoring moves `scrollTop` to keep the same text at the top, and that
   * scroll event is dispatched BEFORE the observer's callback runs — so it was
   * reported through anchors measured at the OLD width, which named a line
   * dozens above the real one (measured: a heading at the top reported as the
   * section before it), and the split that the extra width then mounted landed
   * there. A width that differs from the one measured at is exact evidence the
   * table is stale; no timing is involved.
   */
  const measuredWidth = useRef(-1);
  measureRef.current = () => {
    const root = body.current;
    const sc = scroller.current;
    if (!root || !sc) return [];
    if (!anchors.current || measuredWidth.current !== sc.clientWidth) {
      anchors.current = lineAnchors(root, sc, projection, text);
      measuredWidth.current = sc.clientWidth;
    }
    return anchors.current;
  };

  useEffect(() => {
    anchors.current = null;
    const sc = scroller.current;
    if (!sc) return;
    const ro = new ResizeObserver(() => {
      anchors.current = null;
    });
    ro.observe(sc);
    // ⛔ AND THE CONTENT, NOT JUST THE SCROLLER. The scroller's own border box
    // does not change when what is inside it grows, so a late font swap or an
    // image finishing would move every block and leave the table describing
    // where they used to be. The prose div's box does change, so it is the one
    // that notices.
    if (body.current) ro.observe(body.current);
    return () => ro.disconnect();
  }, [html, projection]);

  // ⛔ REPORTED SYNCHRONOUSLY, NOT THROTTLED TO A FRAME. The place tells a
  // drive's own scroll event apart from the human's by ORDER — a scroll event
  // is dispatched before that frame's animation callbacks — and deferring the
  // report into a `requestAnimationFrame` puts it on the wrong side of that
  // line. `lineAtTop` is a scan of a few hundred cached anchors, so there is
  // nothing to throttle.
  useEffect(() => {
    const sc = scroller.current;
    if (!sc || !place) return;
    const onScroll = () => place.report("rendered", lineAtTop(measureRef.current(), sc.scrollTop));
    sc.addEventListener("scroll", onScroll, { passive: true });
    const leave = place.join("rendered", {
      to: (line) => {
        sc.scrollTop = topForLine(measureRef.current(), line);
      },
      at: () => sc.scrollTop,
    });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      leave();
    };
  }, [place]);

  /** The current DOM selection as source offsets, or null. */
  const selectedRange = useCallback((): { from: number; to: number } | null => {
    const root = body.current;
    const sel = window.getSelection();
    if (!root || !sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    // A selection that started outside this pane is not ours to report.
    if (!root.contains(range.commonAncestorContainer)) return null;
    return resolveRange(root, projection, range);
  }, [projection]);

  /**
   * Whether the last press in this pane was a context-menu press OVER the
   * selection. A right-click collapses the selection before `contextmenu`
   * fires (browser-dependent), and that collapse must not clear the passage the
   * menu is about to offer a note on. A context press ANYWHERE ELSE is an
   * ordinary click as far as the selection goes, and clears it.
   */
  const contextPress = useRef(false);

  /**
   * Whether the last pointer press in the document landed inside this pane.
   *
   * ⛔ THE ATTRIBUTION FOR A SELECTION THAT IS GONE, and nothing else. When
   * Chrome empties the selection there is no node left to ask whose it was, so
   * without this a click into the chat composer would read exactly like a click
   * in the text and clear the passage the human is about to write about.
   * Transient, like `contextPress` above — a fact about the last INPUT, not a
   * second copy of the selection.
   */
  const pressedHere = useRef(false);

  // ⛔ REPORTED ON `selectionchange`, NOT ON `mouseup`. A keyboard selection
  // (shift-arrow) and a double-click both land here, and mouseup misses the
  // first. The document-level listener is the only one the API offers.
  //
  // ⛔ AND A COLLAPSE IS NEWS TOO. Clicking in the text clears the selection,
  // so it has to clear the chip — the raw view gets this for free, because
  // CodeMirror reports the empty range. `renderedSelectionAct` holds the rules.
  //
  // ⚠ NO DEDUPE HERE. This pane used to skip a range equal to `lastRange`, and
  // that memory went stale whenever the selection was cleared from outside (the
  // chip's X, a note consuming it): re-selecting the same passage then reported
  // nothing and selection "stopped working" until the pane remounted. App's
  // `heldAfter` dedupes against what is actually held.
  useEffect(() => {
    if (!onSelect) return;
    const handler = () => {
      const root = body.current;
      const sel = window.getSelection();
      if (!root || !sel) return;
      // ⛔ NO RANGE AT ALL IS NEWS TOO — this used to return here. Chrome EMPTIES
      // the selection, rather than collapsing it, when the click lands inside
      // the selected text, so the one gesture most likely to mean "never mind"
      // was the one gesture that reported nothing: the paint went and the chip
      // stayed. `renderedSelectionAct` holds what an emptied selection means.
      // ⚠ WIDER THAN "THE HUMAN CLICKED": anything that destroys the selection
      // lands here, including this subtree being replaced when the daemon
      // pushes a new version of the document. That now reports a clear where it
      // used to report nothing, which is the right answer — the passage the
      // chip named is gone with the text it pointed into — but it is a
      // behaviour change beyond the defect, so it is written down rather than
      // discovered.
      const gone = sel.rangeCount === 0;
      const r = gone || sel.isCollapsed ? null : selectedRange();
      const act = renderedSelectionAct({
        gone,
        ours: !gone && root.contains(sel.getRangeAt(0).commonAncestorContainer),
        collapsed: gone || sel.isCollapsed,
        resolved: r,
        contextClick: contextPress.current,
        pressedHere: pressedHere.current,
      });
      if (act === "report" && r) {
        lastRange.current = r;
        onSelect(r.from, r.to, lineAt(text, r.from), lineAt(text, r.to), text.slice(r.from, r.to));
      } else if (act === "clear") {
        lastRange.current = null;
        onSelect(0, 0, 1, 1, "");
      }
    };
    // A key ends a context press: the collapse it is about to cause is a caret
    // move, not the note menu (`contextPressAfter`).
    const keyed = () => {
      contextPress.current = contextPressAfter({ kind: "keydown" });
    };
    // ⛔ ON THE DOCUMENT, NOT THE PANE, because the fact needed is where the
    // press LANDED — and the press that must NOT clear the passage (into the
    // chat composer, to write about it) lands outside this pane, so the pane's
    // own handler would never hear it and the flag would stay stale.
    const pressed = (e: PointerEvent) => {
      // The whole PANE, not just the prose: a press on the metadata header or
      // in the margin beside the text is still a press in this half, and
      // dismissing a selection by clicking the white space is exactly the
      // gesture this has to attribute.
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
  }, [onSelect, selectedRange, text]);

  // A CLEAR CLEARS THE HIGHLIGHT TOO (Cole, 2026-09-22): dropping the chip, or
  // clicking in the other pane, is clearing the selection — so the browser's
  // own must not stay painted over a passage nothing is holding. Removing the
  // range fires `selectionchange` with no range at all, which the handler above
  // ignores: there is nothing to report and nothing left to clear.
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
  useEffect(() => {
    const reg = registry();
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

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto" data-slot="markdown-view">
      <div className="mx-auto max-w-[76ch] px-8 pt-7">{meta && <MetaHeader meta={meta} />}</div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler exists to intercept clicks on ANCHORS inside rendered markdown, and an anchor already fires click on Enter — a keyboard handler here would double-handle it. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: same reason — the interactive elements are the anchors the renderer minted inside this container, each already focusable. */}
      <div
        ref={body}
        className="md-prose mx-auto max-w-[76ch] px-8 pb-16"
        onClick={(e) => {
          const anchor = (e.target as HTMLElement).closest("a");
          if (!anchor) return;
          e.preventDefault();
          const href = anchor.getAttribute("href");
          if (!href || anchor.hasAttribute("data-blocked-link")) return;
          if (OPENS_OUTWARD.test(href)) {
            window.open(href, "_blank", "noopener,noreferrer");
            return;
          }
          // E33: an internal link is a document reference. The DAEMON resolves
          // it — only it knows the bundle, and only it may open a file.
          onFollowLink?.(href);
        }}
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
          // ⛔ OVER A SELECTION **OR** OVER A NOTE, the same rule the raw view
          // holds: with neither, the browser's own menu is left alone rather
          // than replaced with an empty one of ours.
          const point = root ? pointOffset(root, projection, e.clientX, e.clientY) : null;
          // The live selection if the click spared it, else the remembered one
          // — but only when the pointer is inside it (see `lastRange`).
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
          if (!r && noteIds.length === 0) return;
          e.preventDefault();
          onContextMenu({
            x: e.clientX,
            y: e.clientY,
            from: r?.from ?? 0,
            to: r?.to ?? 0,
            noteIds,
          });
        }}
        // THE ONE HTML SINK IN THIS SURFACE, and what makes it safe is upstream:
        // micromark output only, so raw HTML in the document is encoded and
        // every link target has been checked (state/markdown.ts, with cells).
        // `src/scriptorium/sinks.test.ts` fails if a second sink appears, or if
        // this one is ever fed by anything but `renderMarkdown`.
        dangerouslySetInnerHTML={htmlProp}
      />
    </div>
  );
}

/** The source offset under a point — what decides which notes were clicked. */
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
  // A caret is a POINT; `resolveRange` refuses an empty range, so widen it by
  // one character and take the start of what comes back.
  const probe = document.createRange();
  probe.setStart(range.startContainer, range.startOffset);
  const node = range.startContainer;
  const len = node.nodeType === Node.TEXT_NODE ? (node as Text).data.length : 0;
  probe.setEnd(node, Math.min(range.startOffset + 1, len));
  const resolved = resolveRange(root, projection, probe);
  return resolved?.from ?? null;
}
