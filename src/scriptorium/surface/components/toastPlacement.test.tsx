// WHERE the toasts sit (Cole's ruling, 2026-09-28): at the bottom of the
// DOCUMENT pane, not the bottom-right of the window. Pinned to the window they
// landed on the conversation column and their cards swallowed clicks on the
// composer and Send. The document pane is resized by the human, so the stack
// is placed BY the pane (drawn inside it, positioned against it) rather than
// by window coordinates that stop meaning "the pane" the moment it moves.
//
// Rendered to static markup and read as cells; the browser check (three toasts,
// composer still clickable, both themes, narrow, chat collapsed) is the rest.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentPane } from "./DocumentPane";
import { Toasts } from "./Toasts";

const noop = () => {};

describe("the toast stack", () => {
  test("is positioned by its container, never pinned to the window", () => {
    const out = renderToStaticMarkup(
      <Toasts toasts={[{ id: 1, title: "Now editing v2" }]} onDismiss={noop} />,
    );
    const stack = /<div role="status"[^>]*class="([^"]*)"/.exec(out)?.[1] ?? "";
    expect(stack.split(/\s+/)).toContain("absolute");
    expect(stack.split(/\s+/)).not.toContain("fixed");
  });

  test("is drawn inside the document pane, above its dock", () => {
    const out = renderToStaticMarkup(
      <DocumentPane
        doc={null}
        text={undefined}
        mode="rendered"
        onMode={noop}
        diff={null}
        onAgainst={noop}
        onTake={noop}
        onActivate={noop}
        onNewVersion={noop}
        onDeleteVersion={noop}
        onRevealVersion={noop}
        onSelect={noop}
        reveal={null}
        onRevealed={noop}
        clearSeq={0}
        focusedNote={null}
        notesWaiting={new Map()}
        onAddNote={noop}
        onShowNote={noop}
        onDeleteNote={noop}
        onEdit={noop}
        onSave={noop}
        onRevert={noop}
        onFollowLink={noop}
        onAddFrontmatter={noop}
        splitLayout={{ defaultLayout: undefined, onLayoutChanged: undefined }}
        toasts={<span data-probe="toasts" />}
        dock={<span data-probe="dock" />}
      />,
    );
    const toasts = out.indexOf('data-probe="toasts"');
    const dock = out.indexOf('data-probe="dock"');
    expect(toasts).toBeGreaterThan(-1);
    // Above the floating composer, so a collapsed chat's composer stays clear.
    expect(toasts).toBeLessThan(dock);
  });
});
