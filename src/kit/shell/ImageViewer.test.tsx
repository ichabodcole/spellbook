// The image viewer in a DOM: fitted to the pane when the image loads, zoomed
// by keys, buttons and the wheel, sharp pixels when zoomed in, and a footer
// that says what the image is.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import { formatBytes, ImageViewer } from "./ImageViewer.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const text = (slot: string) => q(`[data-slot="${slot}"]`)?.textContent ?? "";

/** happy-dom loads no image: say it loaded, at this natural size. */
async function loaded(w: number, h: number) {
  const img = q<HTMLImageElement>('[data-slot="image"]');
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
  await settle(() => {
    img.dispatchEvent(new window.Event("load"));
  });
  return img;
}
const key = async (k: string) => {
  await settle(() => {
    q('[data-slot="image-viewer"] [role="application"]').dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
};
const zoom = () => Number(q('[role="application"]').dataset.zoom);

describe("the image viewer", () => {
  test("fits the image to the pane when it loads, and the footer says what it is", async () => {
    await mount(
      <ImageViewer
        name="fox.png"
        src="/fs/file?path=/w/fox.png"
        size={2_500_000}
        type="image/png"
      />,
    );
    const img = q<HTMLImageElement>('[data-slot="image"]');
    expect(img.getAttribute("src")).toBe("/fs/file?path=/w/fox.png");
    expect(img.getAttribute("alt")).toBe("fox.png");
    expect(text("image-dimensions")).toBe("…");
    await loaded(1600, 600);
    // The pane reads as 800 × 600 in a DOM with no layout: half size, centred.
    expect(zoom()).toBeCloseTo(0.5);
    expect(img.style.transform).toBe("translate(0px, 150px) scale(0.5)");
    expect(text("image-dimensions")).toBe("1600 × 600 px");
    expect(text("image-size")).toBe("2.4 MB");
    expect(text("image-type")).toBe("PNG");
    expect(text("image-zoom")).toBe("50%");
  });

  test("a small image shows at its own size, never enlarged", async () => {
    await mount(<ImageViewer name="dot.gif" src="/x" size={43} type="image/gif" />);
    await loaded(40, 30);
    expect(zoom()).toBe(1);
    expect(text("image-size")).toBe("43 bytes");
  });

  test("+, −, 0 and 1 zoom in, out, fit and actual size; the buttons do the same", async () => {
    await mount(<ImageViewer name="a.jpg" src="/x" size={10} type="image/jpeg" />);
    await loaded(1600, 1200);
    expect(zoom()).toBeCloseTo(0.5);
    await key("+");
    expect(zoom()).toBeCloseTo(0.625);
    await key("-");
    await key("-");
    expect(zoom()).toBeCloseTo(0.4);
    await key("1");
    expect(zoom()).toBe(1);
    await key("0");
    expect(zoom()).toBeCloseTo(0.5);
    const button = (label: string) => q(`button[aria-label^="${label}"]`);
    await settle(() => button("Zoom in").click());
    expect(zoom()).toBeCloseTo(0.625);
    await settle(() => button("Fit the image").click());
    expect(zoom()).toBeCloseTo(0.5);
    await settle(() => button("Actual size").click());
    expect(zoom()).toBe(1);
  });

  test("a wheel zooms, a two-finger scroll pans, and zoomed in the pixels stay sharp", async () => {
    await mount(<ImageViewer name="pixel.png" src="/x" size={10} type="image/png" />);
    const img = await loaded(64, 64);
    expect(zoom()).toBe(1);
    expect(img.style.imageRendering).toBe("auto");
    const pane = q('[role="application"]');
    // Five notches of a mouse wheel, away from the reader: in.
    for (let i = 0; i < 5; i++)
      await settle(() => {
        pane.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -100, cancelable: true }));
      });
    expect(zoom()).toBeGreaterThan(2);
    expect(img.style.imageRendering).toBe("pixelated");
    const before = img.style.transform;
    await settle(() => {
      pane.dispatchEvent(
        new window.WheelEvent("wheel", { deltaX: 12, deltaY: 3.5, cancelable: true }),
      );
    });
    expect(img.style.transform).not.toBe(before);
    expect(zoom()).toBeGreaterThan(2);
  });

  test("bytes that are no image say so, and a broken file says so", async () => {
    const m = await mount(<ImageViewer name="fake.png" src="/x" size={10} type={null} />);
    expect(text("image-failed")).toContain("not a PNG, JPEG, WebP, GIF or AVIF image");
    expect(q('[data-slot="image"]')).toBeNull();
    expect(text("image-type")).toBe("not an image");
    await m.render(<ImageViewer name="bad.png" src="/y" size={10} type="image/png" />);
    await settle(() => {
      q('[data-slot="image"]').dispatchEvent(new window.Event("error"));
    });
    expect(text("image-failed")).toContain("could not be shown");
  });

  test("Close puts it away", async () => {
    let closed = 0;
    await mount(
      <ImageViewer
        name="fox.png"
        src="/x"
        size={10}
        type="image/png"
        onClose={() => {
          closed++;
        }}
      />,
    );
    await settle(() => q('button[aria-label="Close fox.png"]').click());
    expect(closed).toBe(1);
  });
});

test("formatBytes reads as a person reads a file's size", () => {
  expect(formatBytes(1)).toBe("1 byte");
  expect(formatBytes(900)).toBe("900 bytes");
  expect(formatBytes(640 * 1024)).toBe("640 KB");
  expect(formatBytes(2.4 * 1024 * 1024)).toBe("2.4 MB");
  expect(formatBytes(48 * 1024 * 1024)).toBe("48 MB");
});
