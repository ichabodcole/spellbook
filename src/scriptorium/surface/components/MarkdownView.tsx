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
import { lineAt, project } from "../state/projection";
import { align, paintRange, resolveRange } from "../state/renderedRange";
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
  onContextMenu,
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
  /** E46's composer, reached from the rendered view too. */
  onContextMenu?: (at: {
    x: number;
    y: number;
    from: number;
    to: number;
    noteIds: string[];
  }) => void;
}) {
  // The frontmatter is METADATA, so it leaves the rendered body and becomes the
  // header above it (E32). The raw view still shows it: there, it IS the file.
  const html = useMemo(() => renderMarkdown(splitFrontmatter(text).body), [text]);
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

  // ⛔ REPORTED ON `selectionchange`, NOT ON `mouseup`. A keyboard selection
  // (shift-arrow) and a double-click both land here, and mouseup misses the
  // first. The document-level listener is the only one the API offers.
  useEffect(() => {
    if (!onSelect) return;
    const handler = () => {
      const root = body.current;
      const sel = window.getSelection();
      if (!root || !sel) return;
      // Only speak when the selection is in THIS pane; a selection in the chat
      // or the raw half must not clear or overwrite what the editor reported.
      if (sel.rangeCount > 0 && !root.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
      const r = selectedRange();
      if (!r) return;
      lastRange.current = r;
      onSelect(r.from, r.to, lineAt(text, r.from), lineAt(text, r.to), text.slice(r.from, r.to));
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [onSelect, selectedRange, text]);

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
    <div className="min-h-0 flex-1 overflow-auto" data-slot="markdown-view">
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
        dangerouslySetInnerHTML={{ __html: html }}
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
