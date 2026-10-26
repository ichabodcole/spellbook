// The undo arrow's confirmation for an undo that deletes, in a DOM: it says
// what goes and on what terms. A bundle goes whole while it is as made (not
// the empty-folder rule), a plain folder must be empty, and an app's act that
// made several things names every one in the dialog's message.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { registerBundleType, unregisterBundleType } from "../lib/bundles.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { HistoryView } from "../workspace/protocol";
import { TEST_BUNDLE } from "../workspace/testing";
import { HistoryArrows } from "./HistoryArrows.tsx";

beforeAll(() => {
  installDom();
  registerBundleType(TEST_BUNDLE);
});
afterEach(cleanup);
afterAll(async () => {
  unregisterBundleType(TEST_BUNDLE.extension);
  await removeDom();
});

let undone: boolean[] = [];

async function confirmFor(history: HistoryView) {
  undone = [];
  await mount(
    <HistoryArrows
      history={history}
      display={(p) => p}
      onUndo={(c) => undone.push(c)}
      onRedo={() => {}}
    />,
  );
  const arrow = document.querySelector('[data-action="history-undo"]');
  if (!arrow) throw new Error("no arrow");
  await settle(() => {
    arrow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await waitFor(() => document.querySelector("[data-slot=confirm-dialog]") !== null, "dialog");
  const dialog = document.querySelector("[data-slot=confirm-dialog]") as HTMLElement;
  return {
    title: dialog.querySelector("h2")?.textContent ?? "",
    message: dialog.querySelector("p")?.textContent ?? "",
    text: dialog.textContent ?? "",
  };
}

describe("the confirmation for an undo that deletes", () => {
  test("a bundle goes whole while as made; no empty-folder rule", async () => {
    const d = await confirmFor({
      canUndo: true,
      canRedo: false,
      undoLabel: "created The well",
      undoDeletes: { path: "/w/The well.boardbundle", dir: true },
    });
    expect(d.title).toBe("Delete this board?");
    expect(d.text).toContain("goes to the Trash whole");
    expect(d.text).not.toContain("must be empty");
    expect(undone).toEqual([]);
  });

  test("a plain folder must be empty", async () => {
    const d = await confirmFor({
      canUndo: true,
      canRedo: false,
      undoLabel: "created the folder notes",
      undoDeletes: { path: "/w/notes", dir: true },
    });
    expect(d.title).toBe("Delete this folder?");
    expect(d.text).toContain("The folder must be empty");
  });

  test("several made by one act: every path in the message", async () => {
    const d = await confirmFor({
      canUndo: true,
      canRedo: false,
      undoLabel: "copied two",
      undoDeletes: { path: "/w/s/docs/a.md", dir: false, also: ["/w/s/docs/b.md"] },
    });
    expect(d.title).toBe("Delete these?");
    expect(d.message).toBe('Undoing "copied two" removes /w/s/docs/a.md and /w/s/docs/b.md.');
  });
});
