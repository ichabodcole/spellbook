// The centre pane's document, READ-ONLY for now (E16: view before edit).
// CodeMirror 6, hand-wrapped (investigation §1: the spell must dispatch its own
// transactions — remote changes, later the human's edits — so the view's
// lifecycle is ours, not a wrapper library's). ONE view per document — not per
// version — so a new text (the agent's version made active, the original
// reloaded from disk) is applied as the SMALLEST change that turns the old text
// into the new, and the reader keeps their place. (It first remounted per
// version and replaced the whole text, which put a reader 300,000px down back at
// the top — the verify pass drove it.)
//
// ⚠ NO MARKDOWN LANGUAGE YET, deliberately. `@codemirror/lang-markdown` imports
// `@codemirror/lang-html` at module scope (for inline HTML), which drags the
// HTML, CSS and JavaScript languages into the bundle — and the JavaScript
// language's snippet strings (`import … from "${module}"`) trip the
// import-boundary ward's text scan (ward 1b), a false positive on a string
// literal. A read-only view with no highlight style gets nothing from the
// language anyway. The editing slice adds it back and must settle both: the
// ward reading string literals as imports, and the bundle weight.
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";

/** The editor's look, from the spell's semantic tokens — so both themes follow. */
const scriptoriumTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--color-ink)",
    backgroundColor: "var(--color-bg)",
    fontSize: "14px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
  },
  ".cm-content": {
    maxWidth: "76ch",
    margin: "0 auto",
    padding: "28px 32px 64px",
    caretColor: "var(--color-rubric)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--color-rubric) 28%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
});

/** The smallest single replacement turning `a` into `b`: common prefix and suffix kept. */
export function minimalChange(
  a: string,
  b: string,
): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export function DocumentView({ docKey, text }: { docKey: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initial = useRef(text);
  initial.current = text;

  // One view per document: remount only when the document itself changes.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initial.current,
        extensions: [
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          scriptoriumTheme,
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [docKey]);

  // The document's text changed: apply the minimal change, then put the scroll
  // back where it was — a change above the viewport would otherwise push the
  // reader's place down the page.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const change = minimalChange(v.state.doc.toString(), text);
    if (!change) return;
    const top = v.scrollDOM.scrollTop;
    v.dispatch({ changes: change });
    v.requestMeasure({
      read: () => null,
      write: () => {
        v.scrollDOM.scrollTop = top;
      },
    });
  }, [text]);

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" data-slot="document-view" />;
}
