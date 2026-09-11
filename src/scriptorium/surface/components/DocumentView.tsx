// The centre pane's document, READ-ONLY for now (E16: view before edit).
// CodeMirror 6, hand-wrapped (investigation §1: the spell must dispatch its own
// transactions — remote changes, later the human's edits — so the view's
// lifecycle is ours, not a wrapper library's). One view per mounted document;
// a new text for the same document is applied as a change, not a remount, so
// scroll position survives an agent rewriting the version underneath.
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

  // The same document's text changed (the agent wrote it, an original reloaded):
  // apply it as a change so the view — and the reader's place in it — stays.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === text) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden" data-slot="document-view" />;
}
