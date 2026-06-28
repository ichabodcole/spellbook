// Pure unit tests for the synchronous state mutators + projection in reduce.ts
// and the defaultState shape in types.ts. No subprocess — fast and deterministic.
//
// SCAFFOLD — the magpie-specific review machinery (judgment, candidate cutouts)
// is mocked out; widen these as reduce.ts grows. They lock the skeleton's
// invariants so the mock track has a regression net.

import { expect, test } from "bun:test";
import {
  addElement,
  addVersion,
  advancePhase,
  chooseVersion,
  flagElement,
  judgeElement,
  leanState,
  pushMessage,
  removeElement,
  setBackdrop,
  setElements,
  setPhase,
  setSource,
  setStatus,
  updateElement,
} from "../surface/state/reduce";
import { defaultState, type Element, type MagpieState } from "../surface/state/types";

function el(id: string, status: Element["status"] = "proposed"): Element {
  return { id, name: id, type: "icon", bbox: [0, 0, 10, 10], status };
}

// ── defaultState shape ───────────────────────────────────────────────────────

test("defaultState carries the title and empty collections", () => {
  const s = defaultState("my board");
  expect(s.title).toBe("my board");
  expect(s.intent).toBe("");
  expect(s.source).toBeNull();
  expect(s.elements).toEqual([]);
  expect(s.conversation).toEqual([]);
  expect(s.backdrop).toBe("transparent");
  expect(s.status).toEqual({ busy: false, text: "" });
});

// ── mutators ─────────────────────────────────────────────────────────────────

test("pushMessage appends a message with an id + ts", () => {
  const s = defaultState("t");
  const m = pushMessage(s, { role: "agent", kind: "text", text: "hi" });
  expect(s.conversation).toHaveLength(1);
  expect(m.id).toBeTruthy();
  expect(typeof m.ts).toBe("number");
  expect(s.conversation[0].text).toBe("hi");
});

test("setStatus / setSource set the canonical fields", () => {
  const s = defaultState("t");
  setStatus(s, true, "discovering…");
  expect(s.status).toEqual({ busy: true, text: "discovering…" });
  setSource(s, { path: "/b.png", size: [100, 50], sha: "abcd1234abcd1234" });
  expect(s.source).toEqual({ path: "/b.png", size: [100, 50], sha: "abcd1234abcd1234" });
});

test("setElements defaults a missing status to 'proposed'", () => {
  const s = defaultState("t");
  setElements(s, [{ id: "e1", name: "x", type: "icon", bbox: [0, 0, 1, 1] } as Element]);
  expect(s.elements[0].status).toBe("proposed");
});

test("setElements backfills an id for an element posted without one", () => {
  const s = defaultState("t");
  setElements(s, [{ name: "x", type: "icon", bbox: [0, 0, 1, 1], status: "proposed" } as Element]);
  expect(s.elements[0].id).toBeTruthy();
  expect(s.elements[0].name).toBe("x");
});

test("addElement mints an id and defaults name/type/status; numbers region_<n>", () => {
  const s = defaultState("t");
  const a = addElement(s, { bbox: [1, 2, 3, 4] });
  expect(a.id).toBeTruthy();
  expect(a.name).toBe("region_1");
  expect(a.type).toBe("other");
  expect(a.status).toBe("confirmed");
  expect(s.elements).toHaveLength(1);
  const b = addElement(s, { bbox: [5, 6, 7, 8] });
  expect(b.name).toBe("region_2");
  // explicit name/type are honored
  const c = addElement(s, { bbox: [0, 0, 1, 1], name: "hero", type: "icon" });
  expect(c.name).toBe("hero");
  expect(c.type).toBe("icon");
  // numbering counts existing region_\d+ names → region_3 (region_1, region_2 live)
  const d = addElement(s, { bbox: [0, 0, 1, 1] });
  expect(d.name).toBe("region_3");
});

test("removeElement splices by id; unknown id → false", () => {
  const s = defaultState("t");
  const a = addElement(s, { bbox: [0, 0, 1, 1] });
  addElement(s, { bbox: [1, 1, 2, 2] });
  expect(removeElement(s, a.id)).toBe(true);
  expect(s.elements.find((e) => e.id === a.id)).toBeUndefined();
  expect(s.elements).toHaveLength(1);
  expect(removeElement(s, "nope")).toBe(false);
});

test("judgeElement flips status and reports change; no-op returns false", () => {
  const s = defaultState("t");
  s.elements = [el("e1")];
  expect(judgeElement(s, "e1", "confirmed")).toBe(true);
  expect(s.elements[0].status).toBe("confirmed");
  // same status again → no change
  expect(judgeElement(s, "e1", "confirmed")).toBe(false);
  // unknown id → false
  expect(judgeElement(s, "nope", "dropped")).toBe(false);
});

test("updateElement partial-merges but never overwrites id", () => {
  const s = defaultState("t");
  s.elements = [el("e1")];
  expect(updateElement(s, "e1", { name: "renamed", id: "HACK" } as Partial<Element>)).toBe(true);
  expect(s.elements[0].name).toBe("renamed");
  expect(s.elements[0].id).toBe("e1"); // id is protected
  expect(updateElement(s, "missing", { name: "x" })).toBe(false);
});

test("flagElement flags/unflags an element, reports change; unknown id → false", () => {
  const s = defaultState("t");
  s.elements = [el("e1")];
  expect(flagElement(s, "e1", true)).toBe(true);
  expect(s.elements[0].flagged).toBe(true);
  expect(flagElement(s, "e1", true)).toBe(false); // no-op
  expect(flagElement(s, "e1", false)).toBe(true);
  expect(s.elements[0].flagged).toBe(false);
  expect(flagElement(s, "nope", true)).toBe(false);
});

test("addVersion appends a new model, upserts (bumps rev) on the same model, sets chosen + clears flag", () => {
  const s = defaultState("t");
  s.elements = [{ ...el("e1", "confirmed"), flagged: true }];
  // first crop
  const crop = addVersion(s, "e1", { id: "vC", model: "crop", path: "/f/crop.png", rev: 0 });
  expect(crop?.id).toBe("vC");
  expect(s.elements[0].versions).toHaveLength(1);
  expect(s.elements[0].chosenVersionId).toBe("vC");
  expect(s.elements[0].flagged).toBe(false); // a fresh result clears the flag
  // re-run the SAME model → upsert in place, bump rev, keep the id, stay chosen
  s.elements[0].flagged = true;
  const crop2 = addVersion(s, "e1", { id: "ignored", model: "crop", path: "/f/crop.png", rev: 0 });
  expect(s.elements[0].versions).toHaveLength(1);
  expect(crop2?.id).toBe("vC"); // stable id on upsert
  expect(crop2?.rev).toBe(1); // bumped
  expect(s.elements[0].flagged).toBe(false);
  // a different model → append, become chosen
  const rembg = addVersion(s, "e1", {
    id: "vR",
    model: "rembg",
    path: "/f/rembg.png",
    rev: 0,
    kind: "local",
  });
  expect(rembg?.id).toBe("vR");
  expect(s.elements[0].versions).toHaveLength(2);
  expect(s.elements[0].chosenVersionId).toBe("vR");
  // choose:false keeps the current chosen
  addVersion(s, "e1", { id: "vB", model: "bria", path: "/f/bria.png", rev: 0 }, { choose: false });
  expect(s.elements[0].chosenVersionId).toBe("vR");
  // unknown id → null
  expect(addVersion(s, "nope", { id: "x", model: "crop", path: "/p", rev: 0 })).toBeNull();
});

test("chooseVersion sets chosenVersionId when the version exists; reports change", () => {
  const s = defaultState("t");
  s.elements = [el("e1", "confirmed")];
  addVersion(s, "e1", { id: "vC", model: "crop", path: "/f/crop.png", rev: 0 });
  addVersion(s, "e1", { id: "vR", model: "rembg", path: "/f/rembg.png", rev: 0 });
  expect(chooseVersion(s, "e1", "vC")).toBe(true);
  expect(s.elements[0].chosenVersionId).toBe("vC");
  expect(chooseVersion(s, "e1", "vC")).toBe(false); // no-op
  expect(chooseVersion(s, "e1", "ghost")).toBe(false); // unknown version
  expect(chooseVersion(s, "nope", "vC")).toBe(false); // unknown element
});

test("setBackdrop validates the value and reports change", () => {
  const s = defaultState("t");
  expect(setBackdrop(s, "white")).toBe(true);
  expect(s.backdrop).toBe("white");
  expect(setBackdrop(s, "white")).toBe(false); // no-op
  // @ts-expect-error — invalid backdrop is rejected
  expect(setBackdrop(s, "rainbow")).toBe(false);
});

// ── phase spine ──────────────────────────────────────────────────────────────

test("defaultState starts at intake", () => {
  expect(defaultState("t").phase).toBe("intake");
});

test("advancePhase moves the cursor to the next phase; null at the last", () => {
  const s = defaultState("t");
  expect(s.phase).toBe("intake");
  expect(advancePhase(s)).toBe("slice");
  expect(s.phase).toBe("slice");
  expect(advancePhase(s)).toBe("remove");
  expect(advancePhase(s)).toBe("export");
  expect(advancePhase(s)).toBeNull(); // already last → no-op
  expect(s.phase).toBe("export");
});

test("setPhase sets the cursor (back-nav), validates, reports change", () => {
  const s = defaultState("t");
  advancePhase(s);
  advancePhase(s); // → remove
  expect(setPhase(s, "slice")).toBe(true);
  expect(s.phase).toBe("slice");
  expect(setPhase(s, "slice")).toBe(false); // no-op
  // @ts-expect-error — invalid phase rejected
  expect(setPhase(s, "nope")).toBe(false);
});

// ── leanState projection ─────────────────────────────────────────────────────

test("leanState defensively strips inlined element blobs without mutating source", () => {
  const s = defaultState("t");
  // simulate a (future, mock-track) element carrying an inlined blob
  const withBlob = { ...el("e1"), src: "data:image/png;base64,BLOB" } as Element & { src: string };
  s.elements = [withBlob];
  const lean = leanState(s);
  expect((lean.elements[0] as Record<string, unknown>).src).toBeUndefined();
  // canonical state is untouched
  expect((s.elements[0] as unknown as { src: string }).src).toBe("data:image/png;base64,BLOB");
});

test("leanState preserves a blob-free element verbatim", () => {
  const s: MagpieState = defaultState("t");
  s.elements = [el("e1", "confirmed")];
  const lean = leanState(s);
  expect(lean.elements[0]).toEqual(s.elements[0]);
});
