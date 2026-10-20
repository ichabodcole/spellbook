// The settings dialog in a DOM: it shows the image import settings the prefs
// hold (the defaults when there are none), refuses a bad quality before
// sending anything, and on Save sends only the prefs that changed.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { IMAGE_PREF_KEYS } from "../lib/imageImport.ts";
import { cleanup, installDom, mount, removeDom, settle, typeInto } from "../lib/testDom.ts";
import { SettingsDialog } from "./SettingsDialog.tsx";

beforeAll(installDom);
afterEach(cleanup);
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

type Sent = { op: "prefs.set"; key: string; value: string };

const field = (name: string) =>
  document.querySelector(`[data-field="${name}"]`) as HTMLInputElement | null;
const radio = (value: string) =>
  document.querySelector(`input[name="image-format"][value="${value}"]`) as HTMLInputElement | null;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === label) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const type = async (el: HTMLInputElement | null, value: string) => {
  if (!el) throw new Error("no field");
  await typeInto(el, value);
};

const open = async (prefs: Record<string, string>, sent: Sent[], closed: boolean[] = []) =>
  mount(
    <SettingsDialog
      open
      onOpenChange={(o) => closed.push(o)}
      prefs={prefs}
      send={(m) => sent.push(m)}
      connected
    />,
  );

describe("the settings dialog", () => {
  test("with no prefs it shows the defaults: keep, quality 80, no cap", async () => {
    await open({}, []);
    expect(radio("keep")?.checked).toBe(true);
    expect(radio("webp")?.checked).toBe(false);
    expect(field("quality")?.value).toBe("80");
    expect(field("capped")?.checked).toBe(false);
    expect(field("max-side")?.disabled).toBe(true);
  });

  test("Save sends only what changed, and closes", async () => {
    const sent: Sent[] = [];
    const closed: boolean[] = [];
    await open({ [IMAGE_PREF_KEYS.quality]: "70" }, sent, closed);
    expect(field("quality")?.value).toBe("70");
    await click(radio("webp"));
    await click(field("capped"));
    await type(field("max-side"), "1600");
    await click(button("Save"));
    expect(sent).toEqual([
      { op: "prefs.set", key: IMAGE_PREF_KEYS.format, value: "webp" },
      { op: "prefs.set", key: IMAGE_PREF_KEYS.maxSide, value: "1600" },
    ]);
    expect(closed).toEqual([false]);
  });

  test("a change the agent makes while it is open shows, and Save does not undo it", async () => {
    const sent: Sent[] = [];
    const props = {
      open: true,
      onOpenChange: () => {},
      send: (m: Sent) => sent.push(m),
      connected: true,
    };
    const m = await mount(<SettingsDialog {...props} prefs={{}} />);
    await click(radio("webp"));
    // The agent sets a longest side meanwhile.
    await m.render(<SettingsDialog {...props} prefs={{ [IMAGE_PREF_KEYS.maxSide]: "1500" }} />);
    expect(field("capped")?.checked).toBe(true);
    expect(field("max-side")?.value).toBe("1500");
    await click(button("Save"));
    expect(sent).toEqual([{ op: "prefs.set", key: IMAGE_PREF_KEYS.format, value: "webp" }]);
  });

  test("each field has a name of its own", async () => {
    await open({}, []);
    const named = (el: HTMLInputElement | null) =>
      !!el?.id && !!document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim();
    expect(named(field("quality"))).toBe(true);
    expect(named(field("capped"))).toBe(true);
    expect(named(field("max-side"))).toBe(true);
    expect(document.querySelector(`label[for="${field("max-side")?.id}"]`)?.textContent).toBe(
      "Longest side, in pixels",
    );
  });

  test("a bad quality is said, and Save sends nothing", async () => {
    const sent: Sent[] = [];
    await open({}, sent);
    await type(field("quality"), "0");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("1 to 100");
    expect(button("Save")?.disabled).toBe(true);
    await click(button("Save"));
    expect(sent).toEqual([]);
  });
});
