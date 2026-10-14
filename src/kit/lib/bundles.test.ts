// The bundle registry and `info.json`: what an app registers, how a path is
// read against it, and that a key the kit does not know survives a write.
import { afterEach, describe, expect, test } from "bun:test";
import {
  type BundleType,
  bundleDisplayName,
  bundleOf,
  bundleStem,
  bundleTypeOf,
  bundleTypes,
  isBundleMain,
  newBundleInfo,
  parseBundleInfo,
  registerBundleType,
  unregisterBundleType,
  writeBundleInfo,
} from "./bundles.ts";
import { docFormat, isDocName } from "./docFormat.ts";

const SHELF: BundleType = {
  extension: ".shelfbundle",
  type: "shelf",
  main: "shelf.json5x",
  format: "json",
  label: "shelf",
  mainTemplate: "{}\n",
};

afterEach(() => unregisterBundleType(SHELF.extension));

describe("the registry", () => {
  test("an app registers a type by extension, with its main file; nothing is one until then", () => {
    expect(bundleTypeOf("Books.shelfbundle")).toBeNull();
    registerBundleType(SHELF);
    expect(bundleTypeOf("Books.shelfbundle")?.main).toBe("shelf.json5x");
    expect(bundleTypeOf("/w/x/Books.SHELFBUNDLE")?.type).toBe("shelf");
    expect(bundleTypes().map((t) => t.extension)).toContain(".shelfbundle");
    // The extension alone is no bundle's name.
    expect(bundleTypeOf(".shelfbundle")).toBeNull();
    expect(bundleTypeOf("Books.shelfbundle.md")).toBeNull();
  });

  test("a registration is checked: a plain extension, a plain main file name", () => {
    expect(() => registerBundleType({ ...SHELF, extension: "shelf" })).toThrow();
    expect(() => registerBundleType({ ...SHELF, main: "a/b.json" })).toThrow();
    expect(() => registerBundleType({ ...SHELF, main: ".hidden" })).toThrow();
  });

  test("a path is read against it: the bundle it is in, and its place inside", () => {
    registerBundleType(SHELF);
    expect(bundleOf("/w/Books.shelfbundle/assets/fox.png")).toMatchObject({
      root: "/w/Books.shelfbundle",
      inner: "assets/fox.png",
    });
    expect(bundleOf("/w/Books.shelfbundle")).toMatchObject({ inner: "" });
    expect(bundleOf("/w/books/a.md")).toBeNull();
    expect(isBundleMain("/w/Books.shelfbundle/shelf.json5x")).toBe(true);
    expect(isBundleMain("/w/Books.shelfbundle/assets/shelf.json5x")).toBe(false);
    expect(bundleStem("Books.shelfbundle")).toBe("Books");
  });

  test("a main file is a document of its type's format, by its name; it is not a document name on its own", () => {
    expect(docFormat("shelf.json5x")).toBe("markdown");
    registerBundleType(SHELF);
    expect(docFormat("shelf.json5x")).toBe("json");
    expect(docFormat("/w/Books.shelfbundle/shelf.json5x")).toBe("json");
    // A stray main file outside a bundle is not shown in the tree.
    expect(isDocName("shelf.json5x")).toBe(false);
  });
});

describe("info.json", () => {
  test("a new bundle's: version, type and title", () => {
    registerBundleType(SHELF);
    expect(JSON.parse(newBundleInfo(SHELF, "Untitled"))).toEqual({
      version: 1,
      type: "shelf",
      title: "Untitled",
    });
  });

  test("written again, a key the kit does not know is kept, in its place", () => {
    const prev = parseBundleInfo(
      '{"version":1,"type":"shelf","title":"Books","colour":"teal","atlas":{"pinned":["a"]},"description":"Old ones"}',
    );
    const text = writeBundleInfo(prev, SHELF, { title: "Old books" });
    expect(Object.keys(JSON.parse(text))).toEqual([
      "version",
      "type",
      "title",
      "colour",
      "atlas",
      "description",
    ]);
    expect(JSON.parse(text)).toMatchObject({
      title: "Old books",
      colour: "teal",
      atlas: { pinned: ["a"] },
      description: "Old ones",
    });
    // A title set to nothing is removed; version and type are filled in when missing.
    expect(JSON.parse(writeBundleInfo({ colour: "red" }, SHELF, { title: undefined }))).toEqual({
      colour: "red",
      version: 1,
      type: "shelf",
    });
  });

  test("what is not a JSON object reads as nothing", () => {
    expect(parseBundleInfo("[1]")).toBeNull();
    expect(parseBundleInfo("{ nope")).toBeNull();
    expect(parseBundleInfo('"x"')).toBeNull();
  });

  test("a row's name is the title, else the folder's name without its extension", () => {
    registerBundleType(SHELF);
    expect(bundleDisplayName("books.shelfbundle", "Old books")).toBe("Old books");
    expect(bundleDisplayName("books.shelfbundle", "  ")).toBe("books");
    expect(bundleDisplayName("books.shelfbundle", undefined)).toBe("books");
  });
});
