import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSnapshot,
  materializeItem,
  saveDataUrl,
  saveSnapshot,
} from "../surface/state/persist.server";
import { makeItem } from "../surface/state/reduce";
import { defaultState } from "../surface/state/types";

const tmp = () => mkdtempSync(join(tmpdir(), "glamour-persist-"));

test("saveDataUrl decodes base64 and writes a file", () => {
  const dir = tmp();
  // "hi" base64 = aGk=
  const path = saveDataUrl(dir, "x", "data:image/webp;base64,aGk=");
  expect(path).toBe(join(dir, "x.webp"));
  expect(readFileSync(path, "utf8")).toBe("hi");
});

test("materializeItem sets path for image and text items", () => {
  const dir = tmp();
  const imgIt = makeItem({
    id: "a",
    kind: "ref",
    title: "a",
    src: "data:image/webp;base64,aGk=",
    createdAt: 1,
  });
  materializeItem(dir, imgIt);
  expect(existsSync(imgIt.path)).toBe(true);

  const txtIt = makeItem({
    id: "b",
    kind: "context",
    title: "brief.md",
    text: "hello",
    createdAt: 2,
  });
  materializeItem(dir, txtIt);
  expect(readFileSync(txtIt.path, "utf8")).toBe("hello");
});

test("snapshot round-trips and merges over defaults", () => {
  const dir = tmp();
  const s = defaultState("T", "intent");
  s.library.push(makeItem({ id: "a", kind: "ref", title: "a", createdAt: 1 }));
  saveSnapshot(dir, "sess1", s);
  const loaded = loadSnapshot(join(dir, "sess1.json"), "T", "intent");
  expect(loaded.library.map((i) => i.id)).toEqual(["a"]);

  // A snapshot missing a newer field gains the default.
  const legacy = join(dir, "legacy.json");
  Bun.write(legacy, JSON.stringify({ title: "Old", library: [] }));
  const migrated = loadSnapshot(legacy, "Old", "");
  expect(migrated.selectedIds).toEqual([]);
  expect(migrated.status).toEqual({ busy: false, text: "" });
});
