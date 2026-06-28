// surface/state/reduce.ts
// Pure, in-place mutators over MagpieState + the lean projection. The daemon
// (server.ts) orchestrates these (it owns ids, broadcast, SSE); these functions
// just mutate canonical state and report whether anything changed, so they're
// unit-testable with no subprocess. Keep them THIN — the magpie-specific review
// machinery (judgment, cutouts) is mocked out for now; widen these as it lands.

import {
  type Backdrop,
  type Element,
  type ElementStatus,
  type ElementVersion,
  type MagpieState,
  type Message,
  type NewElement,
  PHASES,
  type PhaseKey,
  type Source,
} from "./types";

// ── id helpers ──────────────────────────────────────────────────────────────
function randHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function newId(prefix: string): string {
  return `${prefix}-${randHex(4)}`;
}

// ── mutators ────────────────────────────────────────────────────────────────

export function pushMessage(
  s: MagpieState,
  m: Omit<Message, "id" | "ts"> & { id?: string },
): Message {
  const msg: Message = { id: m.id ?? newId("m"), ts: Date.now(), ...m } as Message;
  s.conversation.push(msg);
  return msg;
}

export function setStatus(s: MagpieState, busy: boolean, text = ""): void {
  s.status = { busy, text };
}

export function setIntent(s: MagpieState, intent: string): void {
  s.intent = intent;
}

export function setSource(s: MagpieState, source: Source): void {
  s.source = source;
}

export function setElements(s: MagpieState, elements: Element[]): void {
  // Trust the agent's discovered breakdown wholesale; default any missing
  // status to "proposed" so the surface always has a judgeable element, and
  // (defensively) mint an id for any element posted without one — discover
  // assigns ids, but a hand-rolled `elements.set` body might not.
  s.elements = elements.map((e) => ({
    ...e,
    id: e.id || newId("e"),
    status: e.status ?? "proposed",
  }));
}

// Default name for an unnamed drawn region: region_<n>, where n is one past the
// count of existing region_\d+ names (so a delete-then-draw doesn't collide with
// a live one — it numbers off the current population, the cheap house heuristic).
const REGION_RE = /^region_\d+$/;
function nextRegionName(s: MagpieState): string {
  const n = s.elements.filter((e) => REGION_RE.test(e.name)).length + 1;
  return `region_${n}`;
}

// Add a user-drawn (or agent-boxed) region: mint an id, default name/type/status.
// Returns the materialized Element (the daemon emits it on the SSE/broadcast).
export function addElement(s: MagpieState, draft: NewElement): Element {
  const el: Element = {
    id: newId("e"),
    name: draft.name || nextRegionName(s),
    type: draft.type ?? "other",
    bbox: draft.bbox,
    status: draft.status ?? "confirmed",
  };
  s.elements.push(el);
  return el;
}

// Hard-delete an element by id (a user retracting a drawn box). Returns whether
// it existed.
export function removeElement(s: MagpieState, id: string): boolean {
  const i = s.elements.findIndex((e) => e.id === id);
  if (i < 0) return false;
  s.elements.splice(i, 1);
  return true;
}

// Partial-merge an element (the agent posting name/type/bbox/status edits lands
// here). Never lets `id` be overwritten. Returns true if the element existed.
// Version results do NOT flow through here — they append via addVersion (a list
// op, not a field merge).
export function updateElement(s: MagpieState, id: string, patch: Partial<Element>): boolean {
  const el = s.elements.find((e) => e.id === id);
  if (!el) return false;
  const { id: _drop, ...rest } = patch;
  Object.assign(el, rest);
  return true;
}

const ELEMENT_STATUSES: readonly ElementStatus[] = ["proposed", "confirmed", "dropped"];

export function judgeElement(s: MagpieState, id: string, status: ElementStatus): boolean {
  if (!ELEMENT_STATUSES.includes(status)) return false;
  const el = s.elements.find((e) => e.id === id);
  if (!el || el.status === status) return false;
  el.status = status;
  return true;
}

// Flag (or unflag) an element for a re-run — the sole review signal. Approval is
// the absence of a flag; discarding is status:"dropped". Returns whether the flag
// actually changed (the daemon only broadcasts on a change).
export function flagElement(s: MagpieState, id: string, flagged: boolean): boolean {
  const el = s.elements.find((e) => e.id === id);
  if (!el) return false;
  if ((el.flagged ?? false) === flagged) return false;
  el.flagged = flagged;
  return true;
}

// Append a produced version, UPSERTING by model: re-running the same model
// overwrites its path + bumps rev (cache-bust) and keeps the stable id; a new
// model appends a row. A fresh result clears `flagged` (the request is fulfilled)
// and — unless { choose:false } — becomes the chosen version. Returns the stored
// version, or null if the element is gone.
export function addVersion(
  s: MagpieState,
  id: string,
  v: ElementVersion,
  opts: { choose?: boolean } = {},
): ElementVersion | null {
  const el = s.elements.find((e) => e.id === id);
  if (!el) return null;
  if (!el.versions) el.versions = [];
  const existing = el.versions.find((x) => x.model === v.model);
  let stored: ElementVersion;
  if (existing) {
    existing.path = v.path;
    existing.rev = (existing.rev ?? 0) + 1;
    if (v.kind !== undefined) existing.kind = v.kind;
    if (v.note !== undefined) existing.note = v.note;
    stored = existing;
  } else {
    stored = { ...v, rev: v.rev ?? 0 };
    el.versions.push(stored);
  }
  if (opts.choose ?? true) el.chosenVersionId = stored.id;
  el.flagged = false;
  return stored;
}

// The user selecting a version → it becomes chosen (ambient). Returns whether it
// changed; rejects an unknown element or a versionId not present on it.
export function chooseVersion(s: MagpieState, id: string, versionId: string): boolean {
  const el = s.elements.find((e) => e.id === id);
  if (!el || !(el.versions ?? []).some((v) => v.id === versionId)) return false;
  if (el.chosenVersionId === versionId) return false;
  el.chosenVersionId = versionId;
  return true;
}

const BACKDROPS: readonly Backdrop[] = ["white", "gray", "black", "transparent"];

export function setBackdrop(s: MagpieState, backdrop: Backdrop): boolean {
  if (!BACKDROPS.includes(backdrop) || s.backdrop === backdrop) return false;
  s.backdrop = backdrop;
  return true;
}

// ── phase spine ───────────────────────────────────────────────────────────────

// Advance the linear phase cursor to the next phase — what the seal-and-hand-off
// gate fires. Returns the new phase, or null if already at the last (no-op).
export function advancePhase(s: MagpieState): PhaseKey | null {
  const i = PHASES.indexOf(s.phase);
  if (i < 0 || i >= PHASES.length - 1) return null;
  s.phase = PHASES[i + 1];
  return s.phase;
}

// Set the phase cursor directly (back-nav / jump). Validates against PHASES;
// reports whether it changed.
export function setPhase(s: MagpieState, phase: PhaseKey): boolean {
  if (!PHASES.includes(phase) || s.phase === phase) return false;
  s.phase = phase;
  return true;
}

// Record the built export bundle (the agent posts it after zipping). The surface
// offers it as a download via /assets/<name>.
export function setBundle(s: MagpieState, name: string, count: number): void {
  s.bundle = { name, count };
}

// ── lean projection ───────────────────────────────────────────────────────────
// Strip any (eventually heavy) inlined blobs from the agent-facing /state so the
// snapshot stays small; the agent reads on-disk version paths instead. Versions
// carry only `path` (not inlined image data), so this is near-identity — but it
// defensively drops any `src`/`cutouts` fields an element might inline, and never
// mutates the source state.
export function leanState(s: MagpieState): MagpieState {
  return {
    ...s,
    elements: s.elements.map((e) => {
      const lean = { ...e } as Element & { src?: unknown; cutouts?: unknown };
      delete lean.src;
      delete lean.cutouts;
      return lean;
    }),
  };
}
