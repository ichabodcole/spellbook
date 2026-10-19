// The viewer's description panel in a DOM: the title, the one-line description
// and the body beside the image; the origin mark (upload, globe) whose
// popover lists the provenance; an unknown licence in amber; the globe opening
// the source page with no opener; and, with no sidecar, a quiet "No
// description yet" whose "Ask the agent to describe" posts once and takes no focus.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { describeSidecar } from "../lib/sidecar.ts";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import { ImageDescriptionPanel, paragraphs } from "./ImageDescription.tsx";
import { ImageViewer } from "./ImageViewer.tsx";

beforeAll(installDom);
afterEach(cleanup);
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

const slot = (name: string) => document.querySelector(`[data-slot="${name}"]`);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const web = describeSidecar(
  "/w/images/fox.png.md",
  {
    type: "image",
    title: "The fox before the archway",
    description: "A small fox at the edge of a forest.",
    source: "web",
    url: "https://commons.example.org/wiki/File:Fox.png",
    credit: "A. Photographer",
    licence: "unknown",
  },
  "\nPixel art. A small fox, seen from behind.\n",
);
const user = describeSidecar(
  "/w/images/sketch.png.md",
  { type: "image", title: "A sketch", source: "user", "original-name": "IMG_0042.png" },
  "Pencil on paper.",
);

describe("the description panel", () => {
  test("shows the title, the description and the body, and Edit opens the sidecar", async () => {
    const edited: string[] = [];
    await mount(
      <ImageDescriptionPanel name="fox.png" description={web} onEdit={(p) => edited.push(p)} />,
    );
    expect(slot("description-title")?.textContent).toBe("The fox before the archway");
    expect(slot("description-summary")?.textContent).toBe("A small fox at the edge of a forest.");
    expect(slot("description-body")?.textContent).toBe("Pixel art. A small fox, seen from behind.");
    await click(slot("description-edit"));
    expect(edited).toEqual(["/w/images/fox.png.md"]);
  });

  test("a web image's mark is a globe, amber for an unknown licence, and opens the page safely", async () => {
    const opened: unknown[][] = [];
    const was = window.open;
    window.open = ((...args: unknown[]) => {
      opened.push(args);
      return null;
    }) as typeof window.open;
    try {
      await mount(<ImageDescriptionPanel name="fox.png" description={web} />);
      const mark = slot("origin-mark");
      expect(mark?.getAttribute("data-source")).toBe("web");
      expect(mark?.getAttribute("data-licence")).toBe("unknown");
      expect(mark?.className).toContain("text-attention");
      await click(mark);
      expect(opened).toEqual([
        ["https://commons.example.org/wiki/File:Fox.png", "_blank", "noopener,noreferrer"],
      ]);
      await waitFor(() => slot("origin-popover") !== null, "the provenance");
      const licence = document.querySelector('[data-field="licence"] dd');
      expect(licence?.textContent).toBe("unknown");
      expect(licence?.className).toContain("text-attention");
      const link = slot("source-page") as HTMLAnchorElement | null;
      expect(link?.getAttribute("href")).toBe("https://commons.example.org/wiki/File:Fox.png");
      expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link?.getAttribute("target")).toBe("_blank");
    } finally {
      window.open = was;
    }
  });

  test("the user's own image is an upload mark whose popover lists its fields", async () => {
    await mount(<ImageDescriptionPanel name="sketch.png" description={user} />);
    const mark = slot("origin-mark");
    expect(mark?.getAttribute("data-source")).toBe("user");
    expect(mark?.getAttribute("data-licence")).toBeNull();
    await click(mark);
    await waitFor(() => slot("origin-popover") !== null, "the provenance");
    expect(document.querySelector('[data-field="original-name"] dd')?.textContent).toBe(
      "IMG_0042.png",
    );
    expect(slot("source-page")).toBeNull();
  });

  test("an origin the kit does not know is said as written, with the ones it does", async () => {
    // Spellbook: no `generated` origin (no Media Forge provenance), so one is unknown here.
    const generated = describeSidecar(
      "/w/images/dream.png.md",
      { type: "image", title: "A dream", source: "generated", model: "m1" },
      "",
    );
    await mount(<ImageDescriptionPanel name="dream.png" description={generated} />);
    const mark = slot("origin-mark");
    expect(mark?.getAttribute("data-source")).toBe("none");
    expect(mark?.getAttribute("aria-label")).toBe(
      'Origin "generated" is not one of user or web: show where it came from',
    );
  });

  test("with no description: a quiet line, and Ask posts once, taking no focus", async () => {
    const asked: number[] = [];
    await mount(
      <div>
        <input data-testid="elsewhere" />
        <ImageDescriptionPanel name="plain.png" onAsk={() => asked.push(1)} />
      </div>,
    );
    expect(slot("no-description")?.textContent).toBe("No description yet");
    const field = document.querySelector<HTMLInputElement>('[data-testid="elsewhere"]');
    field?.focus();
    const ask = slot("describe-ask") as HTMLButtonElement;
    const down = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    ask.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await click(ask);
    expect(asked).toEqual([1]);
    expect(ask.textContent).toContain("Asked in the chat");
    expect(ask.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(field);
    await click(ask);
    expect(asked).toEqual([1]);
  });

  test("the viewer draws it beside the image", async () => {
    await mount(
      <div style={{ width: 900, height: 600, display: "flex" }}>
        <ImageViewer
          name="fox.png"
          src="/fs/file?path=/w/images/fox.png"
          size={1024}
          type="image/png"
          aside={<ImageDescriptionPanel name="fox.png" description={web} />}
        />
      </div>,
    );
    const aside = slot("image-aside");
    expect(aside?.querySelector('[data-slot="image-description"]')).not.toBeNull();
  });
});

test("a body's source line breaks are spaces; a blank line parts paragraphs", () => {
  expect(paragraphs("A fox\nat the edge.\n\n  Light\nahead.  \n")).toEqual([
    "A fox at the edge.",
    "Light ahead.",
  ]);
});
