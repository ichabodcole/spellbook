import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadTray,
  materializeCanon,
  projectKey,
  saveStyle,
  setStyleArchived,
} from "./styles.server";

/**
 * Read a value this test's own setup is contracted to have produced, and fail
 * NAMING that contract if it did not (type-debt T11/T22: a LOCAL copy — a test
 * under `src/` imports nothing from `grimoire/`). Not `?.`: an optional read
 * turns "the item has property X" into "there is no item", which a falsy or
 * `toBeUndefined()` assertion then passes for free.
 */
function must<T>(v: T | undefined, invariant: string): T {
  if (v === undefined) throw new Error(`INVARIANT VIOLATED — ${invariant}`);
  return v;
}

let HOME: string;
beforeAll(() => {
  HOME = mkdtempSync(join(tmpdir(), "glamour-styles-"));
});

test("projectKey is stable + filesystem-safe + path-distinguishing", () => {
  const a = projectKey("/Users/x/proj-one");
  const b = projectKey("/Users/x/proj-one");
  const c = projectKey("/Users/y/proj-one"); // same base, different path
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[a-zA-Z0-9_-]+$/);
});

test("saveStyle copies canonical blobs + writes the record; loadTray reads it back", () => {
  const key = projectKey("/tmp/projA");
  // a fake materialized canonical image on disk
  const filesDir = mkdtempSync(join(tmpdir(), "glamour-files-"));
  const blobPath = join(filesDir, "gen-1.webp");
  writeFileSync(blobPath, Buffer.from([1, 2, 3, 4]));

  const saved = saveStyle(HOME, key, {
    id: "st1",
    label: "house style",
    text: "ink + indigo",
    sections: [
      {
        key: "palette",
        label: "Palette",
        status: "agreed",
        content: "indigo",
        prompts: [],
        colors: [],
      },
    ],
    canonicalItems: [
      {
        id: "gen-1",
        kind: "gen",
        title: "hero",
        src: "",
        path: blobPath,
        text: "",
        mime: "image/webp",
        tags: [],
        starred: false,
        liked: false,
        annotations: { agent: "", human: "" },
        canonical: true,
        canon: [],
        archived: false,
        createdAt: 1,
        gen: null,
      },
    ],
    createdAt: 100,
  });

  expect(saved.id).toBe("st1");
  expect(saved.canonical).toHaveLength(1);
  expect(saved.canonical[0]).toMatchObject({
    id: "gen-1",
    title: "hero",
    mime: "image/webp",
  });

  const tray = loadTray(HOME, key);
  expect(tray.map((s) => s.id)).toContain("st1");
  expect(tray.find((s) => s.id === "st1")?.label).toBe("house style");
});

test("materializeCanon returns data-URLs for the copied blobs", () => {
  const key = projectKey("/tmp/projA");
  const style = loadTray(HOME, key).find((s) => s.id === "st1");
  if (!style) throw new Error("style not found");
  const canon = materializeCanon(HOME, key, style);
  expect(canon).toHaveLength(1);
  expect(must(canon[0], "the one canonical image this test saved").title).toBe("hero");
  expect(
    must(canon[0], "the one canonical image this test saved").src.startsWith(
      "data:image/webp;base64,",
    ),
  ).toBe(true);
});

test("setStyleArchived flips the flag on disk", () => {
  const key = projectKey("/tmp/projA");
  expect(setStyleArchived(HOME, key, "st1", true)).toBe(true);
  expect(loadTray(HOME, key).find((s) => s.id === "st1")?.archived).toBe(true);
  expect(setStyleArchived(HOME, key, "nope", true)).toBe(false);
});
