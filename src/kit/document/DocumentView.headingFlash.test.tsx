// A link followed to a heading marks the heading's line in the raw editor for a
// moment (kit-heading-links-build). The pane spends the reveal as soon as it is
// applied, which re-renders the editor with no reveal; the mark must still go
// when its moment is up, not stay for good.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { useState } from "react";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import { DocumentView, FLASH_MARK_MS } from "./DocumentView.tsx";

beforeAll(() => {
  installDom();
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON() {},
  };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => rect;
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterEach(async () => {
  jest.useRealTimers();
  await cleanup();
});
afterAll(async () => {
  await removeDom();
});

const TEXT = "# Title\n\nintro\n\n## The heading\n\nbody\n";
const at = TEXT.indexOf("## The heading");

function Host() {
  const [reveal, setReveal] = useState<{
    from: number;
    to: number;
    seq: number;
    heading: { from: number; to: number };
  } | null>({
    from: at,
    to: at,
    seq: 1,
    heading: { from: at, to: at + "## The heading".length },
  });
  // As the pane does: an applied reveal is spent, and the editor re-renders without it.
  return (
    <DocumentView
      docKey="d"
      text={TEXT}
      editable
      reveal={reveal}
      onRevealed={() => setReveal(null)}
    />
  );
}

// The moment is crossed on a fake clock, installed before the mount so the
// mark's timer is a fake one; nothing here polls (`waitFor` would, with timers).
test("the heading's mark clears after its moment, though the reveal was spent at once", async () => {
  jest.useFakeTimers();
  const m = await mount(<Host />);
  expect(document.querySelector(".cm-flash")?.textContent).toBe("## The heading");
  // Still there just before the moment is up: the spent reveal did not clear it.
  await settle(() => {
    jest.advanceTimersByTime(FLASH_MARK_MS - 50);
  });
  expect(document.querySelector(".cm-flash")?.textContent).toBe("## The heading");
  await settle(() => {
    jest.advanceTimersByTime(100);
  });
  expect(document.querySelector(".cm-flash")).toBeNull();
  await m.unmount();
});
