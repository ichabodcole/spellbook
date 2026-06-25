// The single shared contract — imported by server.ts, cli.ts, and the surface.

export type ItemKind = "ref" | "context" | "gen" | "style";
export const VALID_KIND: readonly ItemKind[] = ["ref", "context", "gen", "style"] as const;

// Generation metadata (G1). Fully populated for kind === "gen" in Slice 3;
// the field exists now so the contract and the details fly-out are stable.
export type GenMeta = {
  model: string;
  prompt: string;
  seed: number | null;
  cost: number | null;
  custom: Record<string, string>;
  round: number; // batch index the agent stamps; UI groups gen items by it
};

// One catalog entry. Shape follows imago's ContextEntry conventions:
// blobs (`src`, `text`) are stripped in the lean agent projection; the agent
// reads `path`. Archival is non-destructive (the `archived` flag; the item
// survives in the library).
export type LibraryItem = {
  id: string;
  kind: ItemKind;
  title: string;
  src: string; // image data-URL (ref/gen); "" otherwise — stripped in lean
  path: string; // on-disk materialized blob the agent can Read; "" if none
  text: string; // context body; "" otherwise — stripped in lean
  mime: string; // e.g. "image/webp", "text/markdown"
  tags: string[];
  starred: boolean;
  liked: boolean;
  annotations: { agent: string; human: string };
  canonical: boolean; // marked canonical for the style being built (multi, not single-select)
  canon: CanonImg[]; // a kind:"style" item's canonical thumbnails; [] otherwise — stripped in lean
  archived: boolean;
  createdAt: number;
  gen: GenMeta | null;
};

// Conversation. Agent message kinds carry V1's narration semantics
// (info | working | result | error); user messages are always "info".
export type MessageKind = "info" | "working" | "result" | "error";
export type Message = {
  id: string;
  who: "user" | "agent";
  kind: MessageKind;
  text: string;
  ground: string[]; // item ids grounding this message (snapshot of selectedIds); [] if none
  ts: number;
};

// A brought-in style's canonical thumbnail (data-URL `src` — stripped in lean).
export type CanonImg = { title: string; src: string };

// A canonical image inside a SavedStyle: the blob is copied into the style's
// dir on save and referenced by `file` (so the saved style is self-contained).
export type CanonicalRef = {
  id: string;
  title: string;
  file: string;
  mime: string;
};

// A style saved to the project tray — a compound "canonical shape": the codified
// style-guide sections (text) + canonical images. Project-scoped, non-destructive.
export type SavedStyle = {
  id: string;
  label: string;
  text: string; // short human description (e.g. the Understanding/Direction gist)
  sections: StyleSection[]; // the codified style guide at save time
  canonical: CanonicalRef[];
  createdAt: number;
  archived: boolean;
};

// The agent-assembled style guide. Section set + labels are the mockup's
// (the converged surface). Sections fill in: empty → forming → agreed.
export type SectionStatus = "empty" | "forming" | "agreed";
export type SectionKey =
  | "understanding"
  | "direction"
  | "palette"
  | "consistency"
  | "prompts"
  | "canonical";
// A palette swatch — structured color for the "palette" section.
export type Swatch = { hex: string; name?: string };
export type StyleSection = {
  key: SectionKey;
  label: string;
  status: SectionStatus;
  content: string; // prose
  prompts: string[]; // populated for the "prompts" section; [] elsewhere
  colors: Swatch[]; // populated for the "palette" section; [] elsewhere
};

// The zoom/focus co-presence lens. Either party can scope the set.
export type FocusScope = "all" | "focus";
export type FocusOwner = "you" | "agent" | null;

export type GlamourState = {
  title: string;
  intent: string;
  library: LibraryItem[];
  selectedIds: string[]; // linked set — the grounding set (unselect ≠ delete)
  messages: Message[];
  styleGuide: StyleSection[];
  tray: SavedStyle[];
  scope: FocusScope;
  focusSet: string[]; // item ids in the focused set; empty when scope === "all"
  focusOwner: FocusOwner; // who scoped the focus
  focusNote: string; // agent's contextual question for the focus drawer; "" otherwise
  status: { busy: boolean; text: string };
};

// Lean projection sent to the agent: blobs stripped, paths kept.
export type LeanItem = Omit<LibraryItem, "src" | "text" | "canon">;
export type LeanState = Omit<GlamourState, "library"> & {
  library: LeanItem[];
};

// Server → browser (WebSocket). Full-state broadcast is the only frame.
export type ServerToClient = { type: "state"; state: GlamourState };

// Browser → server (WebSocket).
export type ClientToServer =
  | {
      type: "item.add";
      item: {
        kind: "ref" | "context";
        title: string;
        src?: string;
        text?: string;
        mime?: string;
      };
    }
  | { type: "item.select"; ids: string[] } // ambient
  | { type: "item.star"; id: string; starred: boolean } // ambient
  | { type: "item.like"; id: string; liked: boolean } // ambient
  | { type: "item.annotate"; id: string; human: string } // ambient — stored + read on demand, not pushed as an event
  | { type: "message.send"; text: string } // imperative
  | { type: "focus.set"; ids: string[] } // ambient — human scopes a focus set
  | { type: "focus.clear" } // ambient — human zooms back out
  | { type: "item.canonical"; id: string; canonical: boolean } // ambient
  | { type: "item.archive"; id: string; archived: boolean } // ambient
  | { type: "style.bringIn"; id: string }; // imperative — adds a kind:"style" item

// Agent → server (HTTP POST /cmd).
export type AgentCommand =
  | { type: "init"; title?: string; intent?: string }
  | { type: "intent"; text: string }
  | { type: "item.annotate"; id: string; agent: string }
  | { type: "say"; text: string; kind?: MessageKind }
  | {
      type: "section";
      key: SectionKey;
      content?: string;
      status?: SectionStatus;
      prompts?: string[];
      colors?: Swatch[];
    }
  | {
      type: "gen.add";
      src: string; // an ALREADY-optimized webp data-URL (CLI does the optimization)
      prompt: string;
      model: string;
      round: number;
      seed?: number;
      cost?: number;
      label?: string;
      custom?: Record<string, string>;
    }
  | { type: "gen.cost"; id: string; cost: number } // backfill cost once media-forge finalizes it
  | { type: "gen.meta"; id: string; prompt?: string; custom?: Record<string, string> } // backfill the real prompt / refs onto a gen
  | { type: "focus.push"; ids: string[]; note?: string } // agent scopes a focus set + asks
  | { type: "style.save"; label: string }
  | { type: "style.archive"; id: string; archived: boolean }
  | { type: "status"; busy: boolean; text?: string }
  | { type: "close" };

// The complete agent-event set (server → agent SSE). Only these are emitted.
// Imperatives only — board moves (select/star/like) are ambient.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "item.add",
  "message.user",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function defaultStyleGuide(): StyleSection[] {
  return [
    {
      key: "understanding",
      label: "Understanding",
      status: "empty",
      content: "",
      prompts: [],
      colors: [],
    },
    {
      key: "direction",
      label: "Direction",
      status: "empty",
      content: "",
      prompts: [],
      colors: [],
    },
    {
      key: "palette",
      label: "Palette",
      status: "empty",
      content: "",
      prompts: [],
      colors: [],
    },
    {
      key: "consistency",
      label: "Consistency",
      status: "empty",
      content: "",
      prompts: [],
      colors: [],
    },
    {
      key: "prompts",
      label: "Re-cast prompts",
      status: "empty",
      content: "",
      prompts: [],
      colors: [],
    },
    {
      key: "canonical",
      label: "Canonical images",
      status: "empty",
      content: "",
      prompts: [],
      colors: [],
    },
  ];
}

export function defaultState(title: string, intent: string): GlamourState {
  return {
    title,
    intent,
    library: [],
    selectedIds: [],
    messages: [],
    styleGuide: defaultStyleGuide(),
    tray: [],
    scope: "all",
    focusSet: [],
    focusOwner: null,
    focusNote: "",
    status: { busy: false, text: "" },
  };
}
