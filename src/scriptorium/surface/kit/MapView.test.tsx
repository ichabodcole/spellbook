// The map view on its own, mounted in happy-dom: what its header says, when
// its edges wait for a hover, how a node's dot reads, the layout mode it hands
// back, and Escape.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../../../kit/lib/testDom";
import { DRAW_CAP, type MapMode, MapView } from "./MapView";
import type { MapEdge, MapGraph, MapNode } from "./mapGraph";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const node = (path: string, extra: Partial<MapNode> = {}): MapNode => ({
  path,
  rel: path.slice(1),
  title: path.slice(1),
  stale: false,
  tags: [],
  linksIn: 0,
  linksOut: 0,
  ...extra,
});
const graphOf = (nodes: MapNode[], edges: MapEdge[] = [], cut = 0): MapGraph => ({
  nodes,
  edges,
  links: edges.reduce((s, e) => s + e.count, 0),
  cut,
});
const link = (from: string, to: string, count: number): MapEdge => ({
  from,
  to,
  source: "link",
  rel: [],
  count,
});

async function view(
  graph: MapGraph,
  o: { mode?: MapMode; onMode?: (m: MapMode) => void; onClose?: () => void } = {},
) {
  return mount(
    <div>
      <MapView
        graph={graph}
        label="set"
        mode={o.mode ?? "columns"}
        onMode={o.onMode ?? (() => {})}
        onOpenDoc={() => {}}
        onClose={o.onClose ?? (() => {})}
      />
    </div>,
  );
}

const summary = () => document.querySelector('[data-slot="map-summary"]')?.textContent ?? "";
const everyLink = () =>
  document.querySelector<HTMLInputElement>('[data-slot="map"] input[type="checkbox"]');
const dot = (path: string) =>
  document.querySelector(`[data-slot="map-columns"] g[data-path="${path}"] circle`);
const key = async (target: EventTarget, k: string) =>
  settle(() => {
    target.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });

describe("MapView", () => {
  test("the dense threshold counts links, not folded lines: 151 links on one line wait for a hover", async () => {
    await view(graphOf([node("/a"), node("/b")], [link("/a", "/b", 151)]));
    expect(everyLink()?.checked).toBe(false);
    expect(document.querySelector('[data-slot="map"]')?.textContent).toContain(
      "hover a document to see its own",
    );
    await cleanup();
    await view(graphOf([node("/a"), node("/b")], [link("/a", "/b", 150)]));
    expect(everyLink()?.checked).toBe(true);
  });

  test("the header says what the kit's cut left out", async () => {
    await view(graphOf([node("/a")], [], 5));
    expect(summary()).toContain("5 more not read");
    await cleanup();
    await view(graphOf([node("/a")]));
    expect(summary()).not.toContain("not read");
  });

  test("past the cap the header says the drawn ones are the best connected", async () => {
    const many = Array.from({ length: DRAW_CAP + 1 }, (_, i) => node(`/n${i}`));
    await view(graphOf(many));
    expect(summary()).toContain(`drawing the ${DRAW_CAP} best-connected`);
    expect(summary()).not.toContain("the first");
  });

  test("a stale document's dot is the attention colour, whatever its status says", async () => {
    await view(
      graphOf([
        node("/old", { status: "stable", stale: true }),
        node("/new", { status: "stable" }),
        node("/gone", { status: "deprecated" }),
      ]),
    );
    expect(dot("/old")?.getAttribute("class")).toContain("fill-attention");
    expect(dot("/new")?.getAttribute("class")).toContain("fill-ink-faint");
    expect(dot("/gone")?.getAttribute("class")).toContain("fill-danger");
  });

  test("the layout buttons hand the mode back; the mode drawn is the one given", async () => {
    const chosen: MapMode[] = [];
    await view(graphOf([node("/a")]), { mode: "force", onMode: (m) => chosen.push(m) });
    expect(document.querySelector('[data-slot="map-force"]')).not.toBeNull();
    const columns = [
      ...document.querySelectorAll('[aria-label="How to lay the map out"] button'),
    ].find((b) => b.textContent === "columns");
    await settle(() => {
      columns?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(chosen).toEqual(["columns"]);
  });

  test("Escape goes back to the document, but not from a field outside the map", async () => {
    let closed = 0;
    await view(graphOf([node("/a")]), { onClose: () => closed++ });
    await key(document.body, "Escape");
    expect(closed).toBe(1);
    // A field outside the map: the composer's, the sidebar's path box.
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    await key(outside, "Escape");
    expect(closed).toBe(1);
    await key(document.body, "Enter");
    expect(closed).toBe(1);
  });
});
