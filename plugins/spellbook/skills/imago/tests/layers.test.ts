import { expect, test } from "bun:test";
import {
  byEffectiveZ,
  isMarkHidden,
  isMarkLocked,
  isMarkSelectable,
  layerBand,
  visibleSorted,
} from "../surface/components/annotations/coords";
import type { Layer, Mark } from "../surface/state/types";

// minimal marks (only the fields the comparator reads); cast through unknown so we
// don't have to spell out each tool's geometry for a pure-ordering test.
function pin(id: string, layerId: string | undefined, zOrder: number): Mark {
  return { id, tool: "pin", x: 0, y: 0, layerId, zOrder } as unknown as Mark;
}
const layers: Layer[] = [
  { id: "bg", name: "Annotations", kind: "annotation" },
  { id: "img", name: "Clipping", kind: "image" },
];

test("layerBand: maps layerId to its back→front index; unknown/none → -1", () => {
  expect(layerBand(layers, pin("a", "bg", 0))).toBe(0);
  expect(layerBand(layers, pin("b", "img", 0))).toBe(1);
  expect(layerBand(layers, pin("c", "ghost", 0))).toBe(-1); // not in the list
  expect(layerBand(layers, pin("d", undefined, 0))).toBe(-1); // unstamped
});

test("byEffectiveZ: layer order dominates, zOrder breaks ties within a layer", () => {
  // a top-layer element with a LOW zOrder still sorts above a bottom-layer element
  // with a HIGH zOrder — layer band wins first.
  const top = pin("top", "img", 0);
  const bottom = pin("bottom", "bg", 99);
  expect([bottom, top].sort(byEffectiveZ(layers)).map((m) => m.id)).toEqual(["bottom", "top"]);
  // within one layer, zOrder ascending
  const lo = pin("lo", "bg", 1);
  const hi = pin("hi", "bg", 5);
  expect([hi, lo].sort(byEffectiveZ(layers)).map((m) => m.id)).toEqual(["lo", "hi"]);
});

test("byEffectiveZ DESCENDING: the topHit inversion picks the higher-layer mark as topmost", () => {
  // SelectionOverlay.topHit sorts cmp(b, a) and takes the first hit — the visually
  // topmost. Two overlapping marks in different layers: the top-layer one must win.
  const cmp = byEffectiveZ(layers);
  const onBg = pin("onBg", "bg", 99); // bottom layer, high zOrder
  const onImg = pin("onImg", "img", 0); // top layer, low zOrder
  const topmost = [onBg, onImg].sort((a, b) => cmp(b, a))[0];
  expect(topmost.id).toBe("onImg");
});

test("byEffectiveZ: single (or empty) layer set reduces to zOrder-only — no-op vs today", () => {
  const one: Layer[] = [{ id: "bg", name: "Annotations", kind: "annotation" }];
  const a = pin("a", "bg", 2);
  const b = pin("b", "bg", 0);
  expect([a, b].sort(byEffectiveZ(one)).map((m) => m.id)).toEqual(["b", "a"]);
  // empty layers: every band is -1, so it's pure zOrder
  expect([a, b].sort(byEffectiveZ([])).map((m) => m.id)).toEqual(["b", "a"]);
});

test("isMarkHidden + visibleSorted: marks in hidden layers are dropped (handoff filter)", () => {
  const hidden: Layer[] = [
    { id: "bg", name: "Annotations", kind: "annotation" },
    { id: "img", name: "Clipping", kind: "image", hidden: true },
  ];
  const shown = pin("shown", "bg", 0);
  const buried = pin("buried", "img", 0);
  expect(isMarkHidden(hidden, buried)).toBe(true);
  expect(isMarkHidden(hidden, shown)).toBe(false);
  expect(visibleSorted([buried, shown], hidden).map((m) => m.id)).toEqual(["shown"]);
});

test("isMarkHidden: a mark with no/unknown layer is treated as visible", () => {
  expect(isMarkHidden(layers, pin("x", undefined, 0))).toBe(false);
  expect(isMarkHidden(layers, pin("y", "ghost", 0))).toBe(false);
});

test("isMarkLocked + isMarkSelectable: locked OR hidden layers are not selectable", () => {
  const mixed: Layer[] = [
    { id: "bg", name: "Annotations", kind: "annotation" },
    { id: "lk", name: "Locked", kind: "annotation", locked: true },
    { id: "hd", name: "Hidden", kind: "image", hidden: true },
  ];
  const free = pin("free", "bg", 0);
  const locked = pin("locked", "lk", 0);
  const hidden = pin("hidden", "hd", 0);
  // isMarkLocked tracks only the locked flag…
  expect(isMarkLocked(mixed, locked)).toBe(true);
  expect(isMarkLocked(mixed, hidden)).toBe(false);
  expect(isMarkLocked(mixed, free)).toBe(false);
  // …isMarkSelectable rejects BOTH locked and hidden, accepts a plain layer.
  expect(isMarkSelectable(mixed, free)).toBe(true);
  expect(isMarkSelectable(mixed, locked)).toBe(false);
  expect(isMarkSelectable(mixed, hidden)).toBe(false);
});

test("isMarkLocked + isMarkSelectable: a mark with no/unknown layer is unlocked + selectable", () => {
  expect(isMarkLocked(layers, pin("x", undefined, 0))).toBe(false);
  expect(isMarkSelectable(layers, pin("x", undefined, 0))).toBe(true);
  expect(isMarkSelectable(layers, pin("y", "ghost", 0))).toBe(true);
});
