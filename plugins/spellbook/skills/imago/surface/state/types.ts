// surface/state/types.ts
// The single shared contract. Imported by server.ts AND the React client.
//
// imago is a GROUNDED CONVERSATION about an image: the user and the agent talk
// (the `conversation`), the surface holds the artifacts they're talking about
// (`batches` of kept generations, the `focus`ed one on the canvas), and surface
// gestures (liking, marking, attaching a ref) are themselves messages the agent
// hears. There is no "phase" pipeline — it's a loop, not a funnel.

// ── the artifacts (pieces on the board) ──

export type Variant = {
  id: string;
  src: string; // base64 webp; stripped in lean projection (agent reads `path`)
  path: string; // on-disk materialized file for the agent to Read
  seed?: number;
  model?: string;
  liked: boolean;
  analysis: string; // the agent's read of THIS image — durable, updatable metadata
  // (distinct from the Batch prompt, which is fixed provenance). Shown in details.
  // No per-variant prompt: the settled prompt lives on the Batch (one prompt,
  // many seeds). The display label ("a"/"b"/…) is derived from array index.
};

// A batch is one round of generation kept together (all variants kept by
// default — no select-one-discard). kind distinguishes a fresh generate from an
// edit of an existing variant. The Batch.prompt is THE settled prompt saved
// with these images (the brief's "prompt saved with the image"). Display order /
// "Batch N" label is derived from array index.
export type Batch = {
  id: string;
  kind: "generate" | "edit" | "import"; // import = a working image the user brought in
  prompt: string; // the settled prompt for this batch ("" for imports)
  tag?: string; // short human summary ("a fox reading under an oak")
  editedFromVariantId?: string; // set when kind === "edit"
  variants: Variant[];
};

export type Focus = { batchId: string; variantId: string };

// ── the conversation (the spine) ──

// Every turn at the table is a Message. Most are plain `text`; a few carry
// structured pieces the surface renders specially.
export type MessageKind =
  | "text" // plain dialogue (either role)
  | "prompt" // agent proposes a prompt to send (a piece on the board)
  | "result" // agent reports a produced batch (links `batchId`)
  | "gesture" // a surface action surfaced as a message (user liked/marked/…)
  | "question"; // agent needs the user (an unanswered one → "asking" presence)

export type Message = {
  id: string;
  role: "user" | "agent";
  kind: MessageKind;
  text: string;
  ts: number;
  // kind: "prompt" — the proposal the user confirms (Send) or dismisses. The
  // server flips `status` on proposal.send / proposal.dismiss (no agent command
  // needed — it owns the conversation array).
  proposal?: {
    prompt: string;
    n: number;
    status: "pending" | "sent" | "dismissed";
  };
  // kind: "result" — the batch this message announced
  batchId?: string;
  // kind: "gesture" — what the user did, and to what
  gesture?: {
    kind: "liked" | "marked" | "ref-added" | "focus" | "imported";
    targetId?: string;
  };
  // kind: "question" — optional quick replies (the full answer can be free text)
  options?: string[];
};

// ── steering pieces (grounded shortcuts) ──

// A reusable style: clicking tells the agent to apply its technique for that
// look. `captured` marks ones extracted from an image (the catalog loop-closer).
// `name` is the key — normalized (trimmed, lowercased) on write so casing /
// whitespace can't create duplicates.
export type StyleEntry = { name: string; active: boolean; captured?: boolean };

// A value the user pins to lock for the next generate (agent picks the rest).
export type Pin = { key: string; value: string };

// A reference image in the drawer. The user keeps a library and `selected`s a
// subset to point at "use these for this generation" (default false; at
// generate time the agent uses the selected set, or all if none are selected).
export type Reference = {
  id: string;
  src: string; // base64 webp (same as Variant.src)
  path: string;
  name: string;
  selected: boolean;
  hash: string; // content hash — dedupes identical adds + keys the analysis cache
  analysis: string; // the agent's read of this image, shown on the board (click to view)
};

// An annotation mark on the focused image. Coords are fractions (0–1) of the
// image box. `marks` are transient — committed to the conversation, then cleared.
// V1 tools: "pin" (a labeled point) and "arrow" ("move this → there"). The mask
// "region" tool is deferred with the masking flow (see brief).
export type Mark =
  | { id: string; tool: "pin"; label: string; x: number; y: number }
  | {
      id: string;
      tool: "arrow";
      label?: string;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

// ── the whole state ──

export type ImagoState = {
  title: string;
  batches: Batch[];
  focus: Focus | null; // the image on the canvas (null = blank "new" frame)
  conversation: Message[];
  styles: StyleEntry[];
  pins: Pin[];
  refs: Reference[];
  marks: Mark[]; // annotation marks on the focused image (transient)
  analysisCache: Record<string, string>; // hash → agent analysis; survives a ref delete/re-add (daemon-maintained)
  aspect: string; // aspect ratio for a NEW (fresh) generation
  size: ImageSize; // output resolution for a NEW generation
  status: { busy: boolean; text: string };
  cost: string; // pre-formatted for display, e.g. "$0.18"
  handoff: string; // agent escalated to a terminal AskUserQuestion (presence: asking)
};

export type ImageSize = "1K" | "2K";
export const ASPECTS: readonly string[] = ["1:1", "3:2", "2:3", "16:9", "9:16"] as const;
export const SIZES: readonly ImageSize[] = ["1K", "2K"] as const;

// Presence ("asking") is DERIVED, not a stored flag — so it can't drift from the
// thread: the agent is "asking" when `handoff` is set OR the last message is an
// unanswered question. (Helper lives in the surface.)

// ── Server → browser (WebSocket). The browser handles exactly these. ──
export type ServerToClient =
  | { type: "state"; state: ImagoState }
  | { type: "message"; text: string }
  | { type: "submit" }
  | { type: "cancel" };

// ── Browser → server (WebSocket). The client sends exactly these. ──
// Each either mutates state (re-broadcast) and/or emits an SSE event the agent
// reacts to. The conversation is the primary channel; gestures are first-class.
export type ClientToServer =
  | { type: "say"; text: string } // user posts a message / instruction
  | { type: "proposal.send"; id: string } // confirm a prompt proposal → generate
  | { type: "proposal.dismiss"; id: string }
  | { type: "focus.set"; batchId: string; variantId: string } // focus an image
  | { type: "focus.clear" } // back to a blank "new" frame
  | { type: "variant.like"; id: string; liked: boolean }
  | { type: "style.toggle"; name: string }
  | { type: "style.capture" } // ask the agent to extract this image's look
  | { type: "pin.add"; key: string; value: string }
  | { type: "pin.remove"; key: string }
  | { type: "ref.add"; reference: { src: string; name: string; id?: string } }
  | { type: "ref.remove"; id: string }
  | { type: "image.import"; image: { src: string; name?: string } } // drop on canvas → working image
  | { type: "ref.select"; id: string; selected: boolean } // point at a ref for the next gen
  | { type: "mark.add"; mark: Mark } // local-ish; no agent event until commit
  | { type: "marks.clear" }
  | { type: "marks.commit"; text: string; batchId: string; variantId: string } // "take marks to the conversation →"
  | { type: "aspect.set"; aspect: string }
  | { type: "size.set"; size: ImageSize }
  | { type: "submit" }
  | { type: "cancel" };

// ── Agent → server (POST /cmd). The agent drives the daemon with exactly these. ──
export type AgentCommand =
  | { type: "init"; title?: string }
  | { type: "say"; text: string } // post agent dialogue (kind:"text")
  | { type: "propose"; prompt: string; n?: number } // post a prompt proposal
  | { type: "ask"; text: string; options?: string[] } // post an in-thread question
  | {
      // add a produced batch + (auto) a "result" message announcing it
      type: "batch.add";
      kind: "generate" | "edit";
      prompt: string;
      tag?: string;
      editedFromVariantId?: string;
      summary?: string; // the result message text
      variants: { src: string; seed?: number; model?: string; id?: string }[];
    }
  | { type: "focus"; batchId: string; variantId: string } // agent focuses an image
  | { type: "ref.select"; id: string; selected: boolean } // agent points at a ref (the user sees it highlight)
  | { type: "ref.analyze"; id: string; text: string } // write your read onto a ref (the user can see it)
  | { type: "variant.analyze"; id: string; text: string } // write your read onto a generated/imported image
  | { type: "style.add"; name: string } // add a captured style to the catalog
  | { type: "status"; busy: boolean; text?: string }
  | { type: "cost"; text: string }
  | { type: "handoff"; text: string } // "" clears (terminal-ask escape)
  | { type: "close" };

// The complete agent event set (server → agent SSE). The agent MUST listen for
// all of these — incompleteness here is what drops user input. Incremental
// annotation (mark.add/marks.clear) is intentionally NOT here: the agent reacts
// when the user COMMITS marks, not on every stroke.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "say",
  "proposal.send",
  "proposal.dismiss",
  "focus.set",
  "focus.clear",
  "variant.like",
  "style.toggle",
  "style.capture",
  "pin.add",
  "pin.remove",
  "ref.add",
  "ref.remove",
  "ref.select",
  "image.import",
  "marks.commit",
  "aspect.set",
  "size.set",
  "submit",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// Typed payloads for the events that carry data — so the agent isn't guessing
// shapes and the server's emit calls are checked. Events not listed carry no
// payload.
export type AgentEventPayload = {
  say: { text: string };
  "proposal.send": { id: string };
  "proposal.dismiss": { id: string };
  "focus.set": { batchId: string; variantId: string };
  "variant.like": { id: string; liked: boolean };
  "style.toggle": { name: string; active: boolean };
  "pin.add": { key: string; value: string };
  "pin.remove": { key: string };
  "ref.add": { id: string; name: string };
  "ref.remove": { id: string };
  "ref.select": { id: string; selected: boolean };
  "image.import": { batchId: string; variantId: string; name: string };
  "marks.commit": {
    text: string;
    batchId: string;
    variantId: string;
    marks: Mark[];
  };
  "aspect.set": { aspect: string };
  "size.set": { size: ImageSize };
};

// The default catalog — clicking a chip tells the agent to apply its technique
// for that look (not just append a keyword).
const DEFAULT_STYLES: StyleEntry[] = [
  { name: "anime", active: false },
  { name: "painterly", active: false },
  { name: "photoreal", active: false },
  { name: "3d", active: false },
  { name: "watercolor", active: false },
  { name: "line art", active: false },
];

export function defaultState(title: string): ImagoState {
  return {
    title,
    batches: [],
    focus: null,
    conversation: [],
    styles: DEFAULT_STYLES.map((s) => ({ ...s })),
    pins: [],
    refs: [],
    marks: [],
    analysisCache: {},
    aspect: "1:1",
    size: "1K",
    status: { busy: false, text: "" },
    cost: "",
    handoff: "",
  };
}
