// The log's vocabulary: the kit events, the facts a `system` event carries, and
// the typed payloads agree with each other.
import { expect, test } from "bun:test";
import {
  KIT_EVENTS,
  type KitEvent,
  type KitLogEvent,
  SYSTEM_FACTS,
  type SystemFact,
} from "./events";
import type { StateSnapshot } from "./protocol";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// Every kit event has a payload shape, and no shape names an event that is not one.
const _events: Same<KitLogEvent["type"], KitEvent> = true;
const _facts: Same<Extract<KitLogEvent, { type: "system" }>["fact"], SystemFact> = true;
void _events;
void _facts;

test("the list of kit events and of system facts are what the contract names", () => {
  expect(KIT_EVENTS).toHaveLength(21);
  expect(new Set(KIT_EVENTS).size).toBe(21);
  expect([...SYSTEM_FACTS].sort() as string[]).toEqual(
    [
      "active.outside",
      "json.invalid",
      "original.reloaded",
      "relink",
      "relink.kept",
      "relink.left",
      "original.conflict",
      "original.missing",
      "original.back",
      "trash",
      "doc.create",
      "folder.create",
      "folder.add",
      "set.make",
      "bundle.create",
      "duplicate",
      "bundle.changed",
      "move",
      "rename",
      "import",
      "image.import",
      "image.replace",
      "image.pasted",
      "image.describe",
      "workspace.set",
      "workspace.defaulted",
      "workspace.added",
      "workspace.overlap",
      "history.undo",
      "history.redo",
      "note.edited",
      "note.removed",
      "reveal",
      "slot.migrated",
      "manifest.migrated",
      "doctor",
    ].sort(),
  );
});

test("a payload narrows by its type, and a system payload by its fact", () => {
  const ev = { id: 1, type: "system", fact: "move", path: "/a/b", from: "/a/c" } as KitLogEvent;
  if (ev.type === "system" && ev.fact === "move") expect(ev.from).toBe("/a/c");
  else throw new Error("did not narrow");
});

test("the state snapshot type has the log's position and the chat's length", () => {
  const keys: (keyof StateSnapshot)[] = [
    "chatTotal",
    "active",
    "cursor",
    "epoch",
    "appState",
    "tasks",
  ];
  expect(keys).toHaveLength(6);
});

test("every `fact` the daemon emits is in SYSTEM_FACTS", async () => {
  const src = await Bun.file(new URL("./server.ts", import.meta.url)).text();
  const used = [...src.matchAll(/fact: "([a-z.]+)"/g)].map((m) => m[1] as string);
  const via = [...src.matchAll(/fact: op\.op/g)].length;
  expect(via).toBe(1); // the structure ops, by name
  for (const f of used) expect(SYSTEM_FACTS as readonly string[], f).toContain(f);
});
