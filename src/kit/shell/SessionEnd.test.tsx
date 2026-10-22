// Long text stays inside the End session dialog and the ended popover.
//
// A restore command with a long CLI path once pushed the whole confirm dialog,
// its buttons with it, past the edge of the screen: the dialog is a grid, and a
// grid's implicit column grows to its widest child's minimum, which one unbroken
// token sets. happy-dom lays nothing out, so this pins the classes that hold it
// (measured in a real Chromium when they went in): every grid keeps a
// `minmax(0,1fr)` column, every line of text sits in an element that wraps
// inside a long token, and the dialog is capped at the window's height and
// scrolls. It checks classes, not layout, so a `whitespace-nowrap`, a minimum width,
// or long text inside a button can still get past it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import { EndedChip, EndedDetails, SessionEndDialog } from "./SessionEnd.tsx";

beforeAll(installDom);
afterEach(cleanup);
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

const LONG_PATH = `/Users/someone/${"aDeeplyNestedDirectory/".repeat(12)}scripts/cli.ts`;
const COMMAND = `bun ${LONG_PATH} open --restore ${"s".repeat(80)}`;
const LONG_ID = "s".repeat(80);
const WARNING = `v1 of ${"x".repeat(180)}.md has unsaved changes.`;
const NOTICE = `The close did not reach the daemon at ${"h".repeat(120)}.`;

/** The column that cannot grow past the box. */
const FIT = "grid-cols-[minmax(0,1fr)]";
/** Classes that let a line break inside one long unbroken token. */
const WRAPS = ["wrap-anywhere", "break-all"];
/** What keeps a tall dialog inside a short window: a height cap, and scrolling within. */
const TALL = ["max-h-[calc(100dvh-2rem)]", "overflow-y-auto"];

const has = (el: Element, cls: string) => el.classList.contains(cls);

/**
 * What would overflow `root`: each grid without the fitting column, and each
 * line of text (outside a button, whose labels are short and the kit's own)
 * with no element between it and `root` that wraps.
 */
function overflowRisks(root: Element): string[] {
  const risks: string[] = [];
  const grids = [root, ...root.querySelectorAll("*")].filter((el) => has(el, "grid"));
  for (const g of grids)
    if (!has(g, FIT))
      risks.push(`grid without ${FIT}: ${g.getAttribute("data-slot") ?? g.tagName}`);
  const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    let wraps = false;
    let inButton = false;
    for (let el = n.parentElement; el; el = el.parentElement) {
      if (el.tagName === "BUTTON") inButton = true;
      if (WRAPS.some((c) => has(el as Element, c))) wraps = true;
      if (el === root) break;
    }
    if (!wraps && !inButton) risks.push(`text that will not wrap: ${n.textContent.slice(0, 30)}`);
  }
  return risks;
}

const dialog = () => document.querySelector('[data-slot="session-end-dialog"]');

const open = (phase: "confirm" | "ending" | "ended") =>
  mount(
    <SessionEndDialog
      phase={phase}
      onOpenChange={() => {}}
      onConfirm={() => {}}
      sessionId={LONG_ID}
      command={COMMAND}
      by="human"
      connected
      notice={NOTICE}
      warning={WARNING}
    />,
  );

describe("long text in the End session dialog", () => {
  test("asking: the title, the command in the question, the warning and the notice all wrap", async () => {
    await open("confirm");
    const d = dialog();
    expect(d).not.toBeNull();
    // Everything the long values reach is in the dialog, so the check covers them.
    expect(d?.textContent).toContain(LONG_ID);
    expect(d?.textContent).toContain(LONG_PATH);
    expect(d?.querySelector('[data-slot="end-warning"]')?.textContent).toBe(WARNING);
    expect(d?.querySelector('[data-slot="end-notice"]')?.textContent).toBe(NOTICE);
    expect(overflowRisks(d as Element)).toEqual([]);
  });

  test("ending (waiting on the daemon): the same holds", async () => {
    await open("ending");
    expect(overflowRisks(dialog() as Element)).toEqual([]);
  });

  test("ended: the sentence and the restore command wrap, and the grids fit", async () => {
    await open("ended");
    const d = dialog() as Element;
    expect(d.querySelector('[data-slot="restore-command"]')?.textContent).toBe(COMMAND);
    expect(overflowRisks(d)).toEqual([]);
  });

  test("in every phase, the dialog is no taller than the window and scrolls inside", async () => {
    for (const phase of ["confirm", "ending", "ended"] as const) {
      await open(phase);
      const d = dialog() as Element;
      expect(TALL.filter((c) => !has(d, c))).toEqual([]);
      await cleanup();
    }
  });
});

describe("long text in the ended popover", () => {
  test("its details fit and wrap", async () => {
    await mount(<EndedDetails command={COMMAND} by="agent" />);
    const details = document.querySelector('[data-slot="session-ended-details"]') as Element;
    expect(details.textContent).toContain(LONG_PATH);
    expect(overflowRisks(details)).toEqual([]);
  });

  test("the whole popover, its title included, fits and wraps", async () => {
    await mount(<EndedChip command={COMMAND} by="timeout" />);
    const chip = document.querySelector('[data-slot="ended-chip"]');
    await settle(() => {
      chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const pop = document.querySelector('[data-slot="ended-popover"]');
    expect(pop).not.toBeNull();
    expect(has(pop as Element, FIT)).toBe(true);
    expect(pop?.textContent).toContain(LONG_PATH);
    expect(overflowRisks(pop as Element)).toEqual([]);
  });
});
