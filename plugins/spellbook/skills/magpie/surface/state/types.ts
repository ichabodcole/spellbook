// surface/state/types.ts
// The single shared contract for magpie's conjuration. Imported by server.ts,
// reduce.ts, cli.ts, AND the React client.
//
// magpie (rebuilt) is a STANDING REVIEW SURFACE over a composite image: the
// daemon holds the extraction state, the React surface shows the element
// breakdown, and the user judges each cutout, compares removal-model results,
// and selectively retries. The agent drives discovery + extraction; the surface
// is where the user steers.
//
// PROVISIONAL — this state shape is a design-independent skeleton. The
// magpie-specific surface + the final settled shape are being designed in
// parallel. Everything marked `// TODO(mock): …` is a deliberate placeholder the
// mock track will replace; keep mutators (reduce.ts) thin around it.

// The element type taxonomy ported from the Python original — drives the (future)
// background-removal decision in extract.
export type ElementType =
  | "wordmark"
  | "tagline"
  | "icon"
  | "illustration"
  | "sticker"
  | "palette"
  | "typography"
  | "screenshot"
  | "other";

export const ELEMENT_TYPES: readonly ElementType[] = [
  "wordmark",
  "tagline",
  "icon",
  "illustration",
  "sticker",
  "palette",
  "typography",
  "screenshot",
  "other",
] as const;

// The linear process spine (the top-bar stepper). One active phase at a time;
// the cursor advances when the user seals a phase. Status is DERIVED from the
// cursor — phases before it are sealed, the cursor is active, after is upcoming.
export type PhaseKey = "intake" | "slice" | "remove" | "export";
export const PHASES: readonly PhaseKey[] = ["intake", "slice", "remove", "export"] as const;

// A pixel bounding box [x1, y1, x2, y2] in source-image coordinates (matches
// the Python original's `bbox_pixel`).
export type Bbox = [number, number, number, number];

// The backdrop the surface previews cutouts against (a checker for transparent).
export type Backdrop = "white" | "gray" | "black" | "transparent";

// One extractable element. MINIMAL provisional shape — the review/judgment
// machinery is mocked out for now. `bbox` is canonical in SOURCE PIXELS (what
// discover produces and crop consumes); the canvas converts px↔fraction via
// `source.size` for rendering/editing.
export type ElementStatus = "proposed" | "confirmed" | "dropped";

// A produced asset for one element: the raw crop (model:"crop") or a removal
// result. `path` is the on-disk PNG served via /assets; `rev` bumps on every
// (re-)run of the SAME model — the file is overwritten in place, so the surface
// appends ?v=<rev> to bust the browser cache. `kind` is a label-chip hint the
// agent supplies; never inferred in the UI.
export type ElementVersion = {
  id: string;
  model: string; // "crop" | "rembg" | "bria" | "ideogram" | … (agent-defined)
  kind?: "raw" | "local" | "cloud";
  path: string;
  rev: number;
  note?: string;
};

export type Element = {
  id: string;
  name: string;
  type: ElementType;
  bbox: Bbox;
  status: ElementStatus;
  // ── extraction ──
  // Produced assets, one row per model. crop = versions[0] (model:"crop").
  // Absent until the first cut; treat undefined as []. The chosen version is
  // what the rail/gallery render (chosenVersion() falls back to versions[0]).
  versions?: ElementVersion[];
  chosenVersionId?: string;
  // The sole review signal: the user flagged this element to be re-run (re-slice
  // in the slices phase, re-remove in the bg phase). Approval is the ABSENCE of a
  // flag; discarding is status:"dropped". Cleared when a fresh version lands.
  flagged?: boolean;
};

// ── the conversation (the spine, ported settled from imago) ──
export type MessageKind =
  | "text" // plain dialogue (either role)
  | "gesture" // a surface action surfaced as a message (user judged/retried/…)
  | "question"; // agent needs the user (an unanswered one → "asking" presence)

export type Message = {
  id: string;
  role: "user" | "agent";
  kind: MessageKind;
  text: string;
  ts: number;
  // kind: "question" — optional quick replies (the full answer can be free text)
  options?: string[];
  // kind: "gesture" — what the user did, and to what
  gesture?: { kind: string; targetId?: string };
  // An optional one-click CTA the agent attaches to a message — a SHORTCUT for a
  // conversational act (the user could have just said it). Clicking dispatches
  // `command` (e.g. { type: "phase.advance" }). Conversation stays the primary
  // capability; this is sugar on top, surfaced by the agent at its discretion.
  action?: { label: string; command: ClientToServer };
};

// A box before the daemon assigns it an id — drawn by the user ("mark a missed
// region") or by the agent boxing incrementally. The daemon fills `id` and
// defaults name/type/status on element.add.
export type NewElement = {
  bbox: Bbox;
  name?: string;
  type?: ElementType;
  status?: ElementStatus;
};

// The source composite image under review. `path` is the on-disk file the agent
// reads; `size` is [w, h] in px; `sha` is the first-16 of the sha256 (matches
// the Python original's `source_sha256_16`).
export type Source = {
  path: string;
  size: [number, number];
  sha: string;
};

// ── the whole state (PROVISIONAL) ──
export type MagpieState = {
  title: string;
  intent: string; // what the user wants out of this board (free text the agent sets)
  phase: PhaseKey; // the linear process cursor (Intake → Slice → Remove → Export)
  source: Source | null;
  elements: Element[];
  conversation: Message[];
  backdrop: Backdrop;
  status: { busy: boolean; text: string };
  // The built export bundle (Export phase), if any — served via /assets/<name>.
  bundle?: { name: string; count: number };
  // The current session id (runtime; the daemon sets it at start, NOT persisted-
  // meaningful since restore mints a new one) — shown in Export's reopen hint.
  sessionId?: string;
};

export function defaultState(title: string): MagpieState {
  return {
    title,
    intent: "",
    phase: "intake",
    source: null,
    elements: [],
    conversation: [],
    backdrop: "transparent",
    status: { busy: false, text: "" },
  };
}

// ── Server → browser (WebSocket). The browser handles exactly these. ──
export type ServerToClient =
  | { type: "state"; state: MagpieState }
  | { type: "message"; text: string }
  // agent presence — is at least one agent tailing /events (watching the board)?
  // pushed on change + on browser connect; runtime-only, never persisted in state.
  | { type: "presence"; agent: boolean }
  | { type: "submit" }
  | { type: "cancel" };

// ── Browser → server (WebSocket). The client sends exactly these. ──
// Each either mutates state (re-broadcast) and/or emits an SSE event the agent
// reacts to.
export type ClientToServer =
  | { type: "say"; text: string } // user posts a message / instruction
  | { type: "source.import"; name: string; dataUrl: string } // user dropped a composite → daemon materializes it
  | { type: "element.add"; element: NewElement } // user drew a missed region on the canvas
  | { type: "element.update"; id: string; patch: Partial<Element> } // move / resize / rename / retype
  | { type: "element.remove"; id: string } // hard-delete a box (usually a user-drawn one)
  | { type: "element.judge"; id: string; status: ElementStatus } // soft confirm/drop a discovered element
  | { type: "extract"; ids?: string[] } // cut slices for all confirmed elements, or a subset (re-cut)
  | { type: "element.flag"; id: string; flagged: boolean } // flag/unflag for re-run (re-slice or re-remove)
  | { type: "version.choose"; id: string; versionId: string } // user picked a version → it becomes chosen (ambient)
  | { type: "removeBg"; ids?: string[] } // remove backgrounds for these alpha-eligible elements (absent → all eligible)
  | { type: "retryRemoval"; ids: string[] } // "try a different removal" — agent picks an UNUSED model; payload is ids only
  | { type: "backdrop.set"; backdrop: Backdrop } // ambient preview backdrop
  | { type: "phase.advance" } // seal the active phase, move the cursor to the next (imperative hand-off)
  | { type: "phase.set"; phase: PhaseKey } // back-nav / jump to a phase (ambient)
  | { type: "export"; ids?: string[] } // build the downloadable asset bundle (chosen versions of these / all non-dropped)
  | { type: "submit" }
  | { type: "cancel" };

// ── Agent → server (POST /cmd). The agent drives the daemon with exactly these. ──
export type AgentCommand =
  | { type: "init"; title?: string; intent?: string }
  | {
      type: "say";
      text: string;
      action?: { label: string; command: ClientToServer };
    } // post agent dialogue (kind:"text"); optional inline CTA shortcut
  | { type: "ask"; text: string; options?: string[] } // post an in-thread question
  | { type: "source.set"; path: string; size: [number, number]; sha: string } // the composite under review
  | { type: "elements.set"; elements: Element[] } // post the discovered breakdown
  | { type: "element.add"; element: NewElement } // agent boxes a region incrementally
  | { type: "element.update"; id: string; patch: Partial<Element> } // move/resize/rename/retype (versions append via element.addVersion)
  | { type: "element.remove"; id: string } // agent retracts a box
  | { type: "element.addVersion"; id: string; version: ElementVersion; choose?: boolean } // agent appends a produced version
  | { type: "phase.set"; phase: PhaseKey } // agent advances/moves the cursor on the user's conversational request
  | { type: "bundle.set"; name: string; count: number } // agent posts the built export bundle (served via /assets/<name>)
  | { type: "status"; busy: boolean; text?: string }
  | { type: "close" };

// The agent event set (server → agent SSE) — IMPERATIVES ONLY: the moves where
// the user *hands work to the agent*, plus lifecycle. Ambient editing of the
// breakdown is deliberately NOT here — box move/resize/rename/retype
// (element.update), draw (element.add), delete (element.remove), confirm/drop
// (element.judge), re-run flag (element.flag), version pick (version.choose), and
// backdrop are all reachable from /state, which the agent reads at the moment an
// imperative fires. Pushing each edit would just narrate the user's busy work.
// The imperatives: `say`, `source.added` (→ discover), `extract` (→ cut the
// current boxes), `removeBg` (→ remove backgrounds, agent picks the model),
// `retryRemoval` (→ try a different removal, agent picks an unused model),
// `phase.advance` (→ user sealed a phase; a hand-off to the next leg),
// `phase.set` (→ user stepped BACK to a phase — not an action to take, but
// context for what's coming, e.g. re-cuts), `submit`, + lifecycle. A phase switch
// is a deliberate relocation, NOT ambient editing — so both directions are pushed.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "say",
  "source.added", // user dropped a composite — the agent runs discover on it
  "extract", // user asked to (re-)cut — the agent reads the boxes from /state
  "removeBg", // user asked to remove backgrounds — the agent picks the model
  "retryRemoval", // user asked to try a different removal — the agent picks an UNUSED model
  "phase.advance", // user sealed the active phase — a hand-off to the next leg of work
  "phase.set", // user stepped BACK to a phase — context (re-cuts likely), no action required
  "export", // user asked to build the downloadable asset bundle — the agent zips it
  "submit",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// Typed payloads for the events that carry data.
export type AgentEventPayload = {
  say: { text: string };
  "source.added": { path: string; size: [number, number]; sha: string };
  extract: { ids?: string[] }; // which elements to (re-)cut; absent → all confirmed
  removeBg: { ids?: string[] }; // which elements to remove bg for; absent → all eligible
  retryRemoval: { ids: string[] }; // which (flagged) elements to re-remove; model is the agent's call
  "phase.advance": { phase: PhaseKey }; // the NEW phase the user advanced to
  "phase.set": { phase: PhaseKey }; // the phase the user stepped back to
  export: { ids?: string[] }; // which elements to bundle (absent → all non-dropped)
};
