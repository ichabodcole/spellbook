// surface/state/types.ts
// The single shared contract. Imported by server.ts AND the React client.
//
// imago is a GROUNDED CONVERSATION about an image: the user and the agent talk
// (the `conversation`), the surface holds the artifacts they're talking about
// (`batches` of kept generations, the `focus`ed one on the canvas), and surface
// gestures (liking, marking, attaching a ref) are themselves messages the agent
// hears. There is no "phase" pipeline — it's a loop, not a funnel.

// ── the artifacts (pieces on the board) ──

// A Variant is THE universal image asset — generated, imported, or brought in as
// a reference. "Being a reference" is a flag (`refSelected`), not a separate type:
// any variant can be focused, annotated, AND pointed at for the next generation.
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
  name?: string; // editable label; blank for generated (use the derived label), filename for imports
  refSelected?: boolean; // pointed at as a reference for the next generation
  hash?: string; // content hash (imports only) — import dedup + analysisCache key
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
// A reusable style — durable, toggleable CONTEXT (like a selected reference, not
// an ask-shortcut): when `active`, the agent factors it into generation. A
// captured style carries a `description` (the look in words) AND a canonical
// `image` (which "anime" — Akira vs Ghibli vs manga; the picture pins it). The
// agent reads `description` + `imagePath` at generate time, like a selected ref.
export type StyleEntry = {
  name: string;
  active: boolean;
  captured?: boolean;
  description?: string; // the agent's read of the look, in words
  image?: string; // base64 canonical example (stripped in the lean agent projection)
  imagePath?: string; // on-disk canonical image the agent can --ref
};

// A reusable quick-prompt: a named snippet that populates the composer (the
// describe/palette/lighting "lenses" generalized into an editable library). The
// user OR the agent can add/edit/remove; picking one fills the input box (a
// shortcut for language — never fires behind the glass). Surfaced as a dropdown.
export type PromptEntry = { id: string; label: string; text: string };

// A value the user pins to lock for the next generate (agent picks the rest).
export type Pin = { key: string; value: string };

// (References are no longer a separate type — they're Variants with `refSelected`.
// "Use these for this generation" = the set of variants where refSelected; at
// generate time the agent uses that set, or all if none are selected.)

// An annotation mark on a variant. Coords are fractions (0–1) of the image box,
// so marks transform with pan/zoom; stroke width + text size are authored at
// 100% zoom and the surface scales them with the zoom so they stay welded to the
// image. Marks are DURABLE per image — kept in `marksByVariant` keyed by variant
// id, so switching away and back preserves them; cleared explicitly (marks.clear)
// or when committed to the conversation. Tools: pin (labeled point), arrow ("move
// this → there"), line, rect, ellipse. The mask tool drops onto the same union later.
// `zOrder` is server-assigned on mark.add (higher = on top); the surface omits
// it. See docs/projects/imago/annotation-architecture.md.
// color = stroke/accent color (a theme token name or CSS color); width = stroke
// width in px; fontSize = label text size in px (pins use it; other marks ignore
// it). All optional — the surface picks sensible defaults.
export type MarkBase = {
  id: string;
  zOrder?: number; // order WITHIN the element's layer (server-authoritative)
  layerId?: string; // which Layer (container) this element belongs to; backfilled on migration
  rotation?: number; // degrees clockwise about the element's bbox center; image-first (absent = 0 = today)
  label?: string;
  color?: string;
  width?: number;
  fontSize?: number;
};
export type Mark =
  | (MarkBase & { tool: "pin"; x: number; y: number })
  | (MarkBase & {
      tool: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    })
  | (MarkBase & {
      tool: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    })
  | (MarkBase & { tool: "rect"; x: number; y: number; w: number; h: number })
  | (MarkBase & {
      tool: "ellipse";
      cx: number;
      cy: number;
      rx: number;
      ry: number;
    })
  // freeform sketch — an ordered list of fraction-space points (a polyline). The
  // visual handoff (flattened image) is what the model reads; doubles as a future
  // inpaint-mask region.
  | (MarkBase & { tool: "draw"; points: { x: number; y: number }[] })
  // an image LAYER element — a dropped clipping/reference composited onto the
  // image. Reuses rect geometry (x,y,w,h fractions) so it inherits
  // bounds/hit/resize/translate; `src` is a base64 webp (stripped in the lean
  // agent projection — the agent reads the flattened composite, not layer bitmaps).
  | (MarkBase & {
      tool: "image";
      src: string;
      x: number;
      y: number;
      w: number;
      h: number;
    });
export const MARK_TOOLS: readonly Mark["tool"][] = [
  "pin",
  "arrow",
  "line",
  "rect",
  "ellipse",
  "draw",
  "image",
] as const;

// A LAYER is a CONTAINER of marks (elements) on a variant — the grouping unit for
// z-order, visibility, and lock. Elements reference it via Mark.layerId. Effective
// z = layer order (array index in `layersByVariant`, back→front) then the element's
// `zOrder` WITHIN the layer. A "group-of-one" (a standalone arrow) is just a layer
// with a single element; a sketch layer accretes many pen strokes. The base image
// (the focused Variant) is shown as a synthetic locked "Background" row and is NOT
// stored here. `hidden` doubles as the agent-handoff filter: hidden layers don't
// render, so they don't flatten, so the agent never receives them.
export type Layer = {
  id: string;
  name: string; // editable; the panel label
  kind: "annotation" | "sketch" | "image"; // auto-name + icon; "sketch" accretes pen strokes
  hidden?: boolean;
  locked?: boolean;
};

// ── the whole state ──

export type ImagoState = {
  title: string;
  batches: Batch[];
  focus: Focus | null; // the image on the canvas (null = blank "new" frame)
  conversation: Message[];
  styles: StyleEntry[];
  prompts: PromptEntry[]; // reusable quick-prompts (the editable lens library)
  pins: Pin[];
  marksByVariant: Record<string, Mark[]>; // durable annotation marks per variant id
  // CONTAINER metadata per variant: an ordered list of Layers (back→front) that
  // group the marks above. Each Mark carries a `layerId` into this list; effective
  // z = layer order, then Mark.zOrder within the layer. See type Layer.
  layersByVariant: Record<string, Layer[]>;
  analysisCache: Record<string, string>; // hash → agent analysis; survives a ref delete/re-add (daemon-maintained)
  aspect: string; // aspect ratio for a NEW (fresh) generation
  size: ImageSize; // output resolution for a NEW generation
  status: { busy: boolean; text: string };
  cost: string; // pre-formatted for display, e.g. "$0.18"
  handoff: string; // agent escalated to a terminal AskUserQuestion (presence: asking)
  // undo/redo availability for the FOCUSED variant's mark edits (server-derived
  // from an in-memory, per-variant history; situational, not persisted). Lets the
  // toolbar enable/disable the buttons.
  history: { canUndo: boolean; canRedo: boolean };
  // ONE freshness signal shared by both channels: true when the FOCUSED image has
  // annotation changes the agent hasn't received yet. Set on any mark edit;
  // cleared when the agent gets the marked image — via the commit button OR a chat
  // message that carries it. Drives the commit button ("Take marks" vs "Shared")
  // and the chat-send auto-attach. Server-derived for the focused variant.
  marksUnseen: boolean;
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
  | {
      type: "say"; // user posts a message / instruction
      text: string;
      // when the focused image has unseen marks, the surface flattens it and
      // rides the marked image along with the message (one freshness signal).
      flattenedSrc?: string;
    }
  | { type: "proposal.send"; id: string } // confirm a prompt proposal → generate
  | { type: "proposal.dismiss"; id: string }
  | { type: "focus.set"; batchId: string; variantId: string } // focus an image
  | { type: "focus.clear" } // back to a blank "new" frame
  | { type: "variant.like"; id: string; liked: boolean }
  | { type: "variant.remove"; batchId: string; variantId: string } // delete a variant from the library (+ its marks/layers; drops the batch when empty); ambient (no agent event)
  | { type: "style.toggle"; name: string }
  | { type: "style.remove"; name: string } // drop a style from the catalog
  | { type: "style.capture" } // ask the agent to extract this image's look
  | { type: "prompt.add"; label: string; text: string } // add a reusable quick-prompt (server assigns id)
  | { type: "prompt.update"; id: string; label: string; text: string }
  | { type: "prompt.remove"; id: string }
  | { type: "pin.add"; key: string; value: string }
  | { type: "pin.remove"; key: string }
  | { type: "ref.add"; image: { src: string; name?: string } } // import an external image as a variant + select it as a ref (dedup by hash → selects the existing one)
  | { type: "ref.remove"; id: string } // DESELECT a variant as a ref (it stays in the library; to delete the image use variant.remove)
  | { type: "image.import"; image: { src: string; name?: string } } // drop on canvas → working image
  | {
      // drop an image as a LAYER onto the focused image (collage) — distinct from
      // image.import, which REPLACES. The client supplies the fraction-space box
      // (it knows the base image box + the dropped bitmap's aspect); the server
      // optimizes the src + stores it. Geometry optional → server centers a 40% box.
      type: "layer.addImage";
      src: string;
      name?: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
    }
  // ── layer (container) ops — Phase 2 inspector panel. All server-authoritative
  // and undoable via the widened {marks,layers} history; local until commit (the
  // flatten respects `hidden`), so no agent event — same rule as mark.* ops.
  | { type: "layer.add"; name?: string; kind?: Layer["kind"] } // blank layer on top
  | { type: "layer.rename"; id: string; name: string }
  | { type: "layer.setHidden"; id: string; hidden: boolean } // visibility + handoff filter
  | { type: "layer.setLocked"; id: string; locked: boolean } // not hit-testable / selectable
  | { type: "layer.reorder"; id: string; toIndex: number } // absolute placement (drag-drop)
  | { type: "layer.remove"; id: string } // deletes the layer AND its elements
  | { type: "group"; markIds: string[]; name?: string } // wrap selected marks in a new layer
  | { type: "ungroup"; id: string } // dissolve → each element becomes its own group-of-one layer
  // NOTE: there is no `layer.setActive` — the active layer (where new marks drop)
  // is surface-owned. The client stamps `mark.layerId` on mark.add; the server
  // honors a valid one, else drops into the topmost non-image layer.
  | { type: "ref.select"; id: string; selected: boolean } // point a VARIANT at the next gen (id = variantId; toggles refSelected)
  | { type: "mark.add"; mark: Mark } // local-ish; no agent event until commit (server assigns zOrder; honors a valid mark.layerId as the active layer, else topmost non-image layer)
  | { type: "mark.remove"; id: string } // delete one mark (complements marks.clear)
  | {
      // move/resize/label (server merges; never id/tool/zOrder). Values are
      // scalars (geometry/label/style) or a draw mark's whole `points` array.
      type: "mark.update";
      id: string;
      patch: Record<string, number | string | { x: number; y: number }[]>;
    }
  | {
      type: "mark.reorder";
      id: string;
      direction: "forward" | "back" | "front" | "back-most";
    } // z-order
  | { type: "marks.clear" }
  | { type: "marks.replace"; marks: Mark[] } // swap the focused image's marks wholesale (one history step) — used by the pen eraser, which trims/splits strokes
  | { type: "undo" } // step the focused image's mark history back
  | { type: "redo" } // step it forward
  | {
      type: "marks.commit"; // "take marks to the conversation →"
      text: string;
      batchId: string;
      variantId: string;
      flattenedSrc?: string; // data-url PNG: the image with marks burned in (the visual handoff). Optional — capture is best-effort.
    }
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
  | { type: "ref.select"; id: string; selected: boolean } // agent points a variant at the next gen (id = variantId; the user sees it highlight)
  // (ref.analyze removed — write a read onto any image via variant.analyze; refs are variants now)
  | { type: "variant.analyze"; id: string; text: string } // write your read onto a generated/imported image
  | {
      // add/define a captured style in the catalog (the response to style.capture):
      // a name + the look in words + a canonical example image (src → server
      // materializes a path). Re-defining an existing name updates it.
      type: "style.add";
      name: string;
      description?: string;
      image?: string; // base64 data-url; server saves it + sets imagePath
    }
  | { type: "prompt.add"; label: string; text: string } // save a reusable quick-prompt to the library
  | { type: "status"; busy: boolean; text?: string }
  | { type: "cost"; text: string }
  | { type: "handoff"; text: string } // "" clears (terminal-ask escape)
  | { type: "close" };

// The agent event set (server → agent SSE) — IMPERATIVES ONLY: the moves where
// the user is asking the agent for something or handing work off, plus lifecycle.
// The agent reacts to these.
//
// AMBIENT BOARD STATE is deliberately NOT here — focus, ref selection, likes,
// style toggles, aspect/size, pins, ref-library adds, image imports. Those are
// pieces moving on the board; the agent READS them from /state when it's its move,
// it does not get pinged on every toggle (that was just noise). To make that safe,
// the imperatives that are "about an image" carry their board context: `say` and
// `marks.commit` ride the focused variant + selected ref ids; `style.capture`
// rides the focus. Incremental annotation (mark.add/marks.clear) is likewise NOT
// here — the agent reacts when the user COMMITS marks, not on every stroke.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "say",
  "proposal.send",
  "proposal.dismiss",
  "style.capture",
  "marks.commit",
  "submit",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

// Typed payloads for the events that carry data — so the agent isn't guessing
// shapes and the server's emit calls are checked. Events not listed carry no
// payload.
export type AgentEventPayload = {
  // a chat message. It carries the AMBIENT BOARD CONTEXT so the agent doesn't need
  // the (now-removed) focus.set/ref.select pings: `focus` is the image on the
  // canvas when the user sent (null = blank frame), `selectedRefIds` the refs the
  // user pointed at for this turn. If the focused image had unseen marks, the
  // marked image (flattenedImagePath, --ref it) + the mark geometry ride along too.
  say: {
    text: string;
    focus: Focus | null;
    selectedRefIds: string[];
    flattenedImagePath?: string;
    marks?: Mark[];
  };
  "proposal.send": { id: string };
  "proposal.dismiss": { id: string };
  // "extract this image's look" — carries the focused variant so the agent knows
  // which image to read (focus.set no longer notifies).
  "style.capture": { focus: Focus | null };
  "marks.commit": {
    text: string;
    batchId: string;
    variantId: string;
    marks: Mark[];
    selectedRefIds: string[]; // refs the user pointed at (ambient board context)
    // on-disk PNG path of the image with marks burned in (the visual handoff —
    // pass as --ref). Absent if capture failed; fall back to the variant path.
    flattenedImagePath?: string;
  };
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

// The default quick-prompt library — the old describe/palette/lighting lenses,
// now editable. Stable ids so they survive restarts.
const DEFAULT_PROMPTS: PromptEntry[] = [
  {
    id: "describe",
    label: "describe",
    text: "Describe this image in detail — literally what is in it.",
  },
  {
    id: "palette",
    label: "palette",
    text: "Break down the color palette — the key colors and how they work together.",
  },
  {
    id: "lighting",
    label: "lighting",
    text: "Describe the lighting — direction, quality, mood — so I can reuse it.",
  },
];

export function defaultState(title: string): ImagoState {
  return {
    title,
    batches: [],
    focus: null,
    conversation: [],
    styles: DEFAULT_STYLES.map((s) => ({ ...s })),
    prompts: DEFAULT_PROMPTS.map((p) => ({ ...p })),
    pins: [],
    marksByVariant: {},
    layersByVariant: {},
    analysisCache: {},
    aspect: "1:1",
    size: "1K",
    status: { busy: false, text: "" },
    cost: "",
    handoff: "",
    history: { canUndo: false, canRedo: false },
    marksUnseen: false,
  };
}
