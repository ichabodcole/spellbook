import { describe, expect, test } from "bun:test";
import { carriesFiles, dropNotice, droppedFiles } from "./menus.tsx";

type Transfer = Parameters<typeof droppedFiles>[0];

const transfer = (
  entries: Array<{ name: string; dir?: boolean }>,
  opts: { webkit?: boolean } = {},
): Transfer =>
  ({
    types: ["Files"],
    files: entries.map((e) => new File([""], e.name)),
    items: entries.map((e) => ({
      webkitGetAsEntry: opts.webkit === false ? undefined : () => ({ isDirectory: !!e.dir }),
    })),
  }) as unknown as Transfer;

describe("carriesFiles", () => {
  test("a drag from Finder carries Files; a drag inside the page does not", () => {
    expect(carriesFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(
      carriesFiles({ types: ["application/x-workspace-path"] } as unknown as DataTransfer),
    ).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});

describe("droppedFiles", () => {
  test("sets folders apart from files, because a folder's text cannot be read", () => {
    const { files, folders } = droppedFiles(
      transfer([{ name: "a.md" }, { name: "manuscript", dir: true }, { name: "b.txt" }]),
    );
    expect(files.map((f) => f.name)).toEqual(["a.md", "b.txt"]);
    expect(folders).toEqual(["manuscript"]);
  });

  test("a browser that cannot tell treats everything as a file", () => {
    const { files, folders } = droppedFiles(transfer([{ name: "a.md" }], { webkit: false }));
    expect(files).toHaveLength(1);
    expect(folders).toEqual([]);
  });
});

describe("dropNotice", () => {
  test("says nothing when everything dropped was a document", () => {
    expect(dropNotice([], [])).toBeNull();
  });

  test("names the files that are not documents", () => {
    expect(dropNotice(["cover.psd", "a.zip"], [])).toBe(
      "Not documents or images, so not copied: cover.psd, a.zip.",
    );
  });

  test("refuses an SVG with its own reason: script", () => {
    const said = dropNotice([], [], ["logo.svg"]) ?? "";
    expect(said).toContain("logo.svg");
    expect(said).toContain("script");
  });

  test("refuses a folder, and points at the picker and the path box", () => {
    const said = dropNotice([], ["manuscript"]) ?? "";
    expect(said).toContain("manuscript");
    expect(said).toContain("folder button");
    expect(said).toContain("type its path");
    expect(said).toContain("linked instead of copied");
  });

  test("says both when a drop held both", () => {
    const said = dropNotice(["x.png"], ["dir"]) ?? "";
    expect(said).toContain("x.png");
    expect(said).toContain("dir");
  });
});
