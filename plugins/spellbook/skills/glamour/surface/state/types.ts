// surface/state/types.ts
// The single shared contract. Imported by server.ts AND the React client.

export type Phase = "gather" | "analysis" | "direction" | "prompts" | "variants" | "spec";
export const VALID_PHASE: readonly Phase[] = [
  "gather",
  "analysis",
  "direction",
  "prompts",
  "variants",
  "spec",
] as const;

export type Influence = {
  id: string;
  src: string;
  path: string;
  name: string;
  aspects: string[];
  starred: boolean;
  note: string;
  read: string;
};
export type Context = {
  id: string;
  name: string;
  text: string;
  path: string;
  starred: boolean;
  note: string;
};
export type Prompt = { id: string; text: string };
export type Variant = {
  id: string;
  src: string;
  prompt: string;
  label: string;
  round: number;
  liked: boolean;
  canonical: boolean;
};
export type SpecModule = {
  key: string;
  label: string;
  on: boolean;
  content: string;
};

// Agent→user narration: a one-way activity feed (NOT a chat).
export type NarrationKind = "info" | "working" | "result" | "error";
export type Narration = {
  id: string;
  kind: NarrationKind;
  text: string;
  ts: number;
};

export type GlamourState = {
  title: string;
  intent: string;
  phase: Phase;
  influences: Influence[];
  contexts: Context[];
  direction: { revision: number; understanding: string };
  prompts: Prompt[];
  variants: Variant[];
  round: number;
  status: { busy: boolean; text: string };
  narration: Narration[];
  spec: {
    understanding: string;
    modules: SpecModule[];
    recreatePrompt: string;
    model: string;
  };
};

// Server → browser (WebSocket). The browser handles exactly these.
export type ServerToClient =
  | { type: "state"; state: GlamourState }
  | { type: "message"; text: string }
  | { type: "submit" }
  | { type: "cancel" };

// The complete agent event set (server → agent SSE). The agent MUST listen for
// all of these — incompleteness here is what dropped user input in the dogfood.
export const AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "intent.set",
  "influence.add",
  "influence.annotate",
  "influence.remove",
  "context.add",
  "context.annotate",
  "context.remove",
  "analysis.comment",
  "direction.correct",
  "prompt.comment",
  "prompts.comment",
  "variant.like",
  "variant.canonical",
  "feedback",
  "steer",
  "generate",
  "nudge",
  "spec.module",
  "submit",
  "closed",
] as const);
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export function defaultState(title: string, intent: string): GlamourState {
  return {
    title,
    intent,
    phase: "gather",
    influences: [],
    contexts: [],
    direction: { revision: 0, understanding: "" },
    prompts: [],
    variants: [],
    round: 0,
    status: { busy: false, text: "" },
    narration: [],
    spec: {
      understanding: "",
      modules: [
        { key: "palette", label: "palette", on: false, content: "" },
        {
          key: "consistency",
          label: "consistency rules",
          on: false,
          content: "",
        },
        {
          key: "motifs",
          label: "motifs / iconography",
          on: false,
          content: "",
        },
        { key: "dosdonts", label: "do / don't", on: false, content: "" },
      ],
      recreatePrompt: "",
      model: "",
    },
  };
}
