import { expect, test } from "bun:test";
import type { Element, ElementVersion } from "../surface/state/types";
import { chosenVersion, versionUrl } from "../surface/state/versions";

function v(id: string, model: string, rev = 0): ElementVersion {
  return { id, model, path: `/tmp/files/${model}.png`, rev };
}
function el(versions?: ElementVersion[], chosenVersionId?: string): Element {
  return {
    id: "e1",
    name: "icon",
    type: "icon",
    bbox: [0, 0, 10, 10],
    status: "confirmed",
    versions,
    chosenVersionId,
  };
}

test("chosenVersion returns the chosen id, else versions[0], else undefined", () => {
  const a = v("v1", "crop");
  const b = v("v2", "rembg");
  expect(chosenVersion(el([a, b], "v2"))).toBe(b);
  expect(chosenVersion(el([a, b]))).toBe(a); // no chosen → first (the crop)
  expect(chosenVersion(el([a, b], "gone"))).toBe(a); // stale chosen → first
  expect(chosenVersion(el([]))).toBeUndefined();
  expect(chosenVersion(el(undefined))).toBeUndefined();
});

test("versionUrl is the basename with a cache-busting rev", () => {
  expect(versionUrl(v("v1", "crop", 3))).toBe("/assets/crop.png?v=3");
  expect(versionUrl({ id: "v2", model: "rembg", path: "/a/b/wordmark.png", rev: 0 })).toBe(
    "/assets/wordmark.png?v=0",
  );
});
