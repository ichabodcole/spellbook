import type {
  AgentCommand,
  CanonImg,
  GenMeta,
  GlamourState,
  ItemKind,
  LeanItem,
  LeanState,
  LibraryItem,
  Message,
  SavedStyle,
  SectionKey,
  SectionStatus,
  Swatch,
} from "./types";

export function makeItem(p: {
  id: string;
  kind: ItemKind;
  title: string;
  src?: string;
  path?: string;
  text?: string;
  mime?: string;
  tags?: string[];
  createdAt: number;
  gen?: GenMeta | null;
}): LibraryItem {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    src: p.src ?? "",
    path: p.path ?? "",
    text: p.text ?? "",
    mime: p.mime ?? "",
    tags: p.tags ?? [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon: [],
    archived: false,
    createdAt: p.createdAt,
    gen: p.gen ?? null,
  };
}

export function addItem(state: GlamourState, item: LibraryItem): boolean {
  if (state.library.some((i) => i.id === item.id)) return false;
  state.library.push(item);
  return true;
}

export function selectItems(state: GlamourState, ids: string[]): void {
  state.selectedIds = [...ids];
}

export function setStar(state: GlamourState, id: string, starred: boolean): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.starred = starred;
  return true;
}

export function setLike(state: GlamourState, id: string, liked: boolean): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.liked = liked;
  return true;
}

export function annotate(
  state: GlamourState,
  id: string,
  who: "agent" | "human",
  text: string,
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.annotations[who] = text;
  return true;
}

export function addMessage(state: GlamourState, m: Message): void {
  state.messages.push(m);
}

export function updateSection(
  state: GlamourState,
  key: SectionKey,
  patch: { content?: string; status?: SectionStatus; prompts?: string[]; colors?: Swatch[] },
): boolean {
  const sec = state.styleGuide.find((s) => s.key === key);
  if (!sec) return false;
  if (patch.content !== undefined) sec.content = patch.content;
  if (patch.status !== undefined) sec.status = patch.status;
  if (patch.prompts !== undefined) sec.prompts = patch.prompts;
  if (patch.colors !== undefined) sec.colors = patch.colors;
  return true;
}

export function setFocus(
  state: GlamourState,
  ids: string[],
  owner: "you" | "agent",
  note = "",
): void {
  state.scope = "focus";
  state.focusSet = [...ids];
  state.focusOwner = owner;
  state.focusNote = note;
}

export function clearFocus(state: GlamourState): void {
  state.scope = "all";
  state.focusSet = [];
  state.focusOwner = null;
  state.focusNote = "";
}

export function setCanonical(state: GlamourState, id: string, canonical: boolean): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.canonical = canonical;
  return true;
}

export function archiveTrayStyle(state: GlamourState, id: string, archived: boolean): boolean {
  const st = state.tray.find((s) => s.id === id);
  if (!st) return false;
  st.archived = archived;
  return true;
}

export function buildStyleItem(
  style: SavedStyle,
  canon: CanonImg[],
  createdAt: number,
): LibraryItem {
  return {
    id: `style-${style.id}`,
    kind: "style",
    title: style.label,
    src: "",
    path: "",
    text: style.text,
    mime: "",
    tags: [],
    starred: false,
    liked: false,
    annotations: { agent: "", human: "" },
    canonical: false,
    canon,
    archived: false,
    createdAt,
    gen: null,
  };
}

export function setItemArchived(state: GlamourState, id: string, archived: boolean): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it) return false;
  it.archived = archived;
  return true;
}

export function setGenCost(state: GlamourState, id: string, cost: number): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it?.gen) return false;
  it.gen.cost = cost;
  return true;
}

// Backfill the real prompt and/or refs onto a gen after the fact, so its stored
// metadata is the reproducible prompt (not a label) — no session bounce needed.
export function setGenMeta(
  state: GlamourState,
  id: string,
  patch: { prompt?: string; custom?: Record<string, string> },
): boolean {
  const it = state.library.find((i) => i.id === id);
  if (!it?.gen) return false;
  if (typeof patch.prompt === "string") it.gen.prompt = patch.prompt;
  if (patch.custom) it.gen.custom = { ...(it.gen.custom ?? {}), ...patch.custom };
  return true;
}

export function itemsByKind(items: LibraryItem[], kind: ItemKind | "all"): LibraryItem[] {
  const live = items.filter((i) => !i.archived);
  return kind === "all" ? live : live.filter((i) => i.kind === kind);
}

// Mark filters compose as a UNION: with none active, everything passes; with one
// or more active, an item passes if it carries ANY active mark. (pinned ⇄ the
// item's `canonical` flag — see the marks vocabulary.)
export type MarkFilter = { liked: boolean; starred: boolean; pinned: boolean };
export function matchesMarks(it: LibraryItem, f: MarkFilter): boolean {
  if (!f.liked && !f.starred && !f.pinned) return true;
  return (f.liked && it.liked) || (f.starred && it.starred) || (f.pinned && it.canonical);
}

export function leanItem(it: LibraryItem): LeanItem {
  const { src: _s, text: _t, canon: _c, ...rest } = it;
  return rest;
}

export function leanState(s: GlamourState): LeanState {
  return { ...s, library: s.library.map(leanItem) };
}

// Board moves that mutate state + broadcast but emit NO agent event.
export const AMBIENT_CLIENT = new Set<string>([
  "item.select",
  "item.star",
  "item.like",
  "focus.set",
  "focus.clear",
  "item.canonical",
  "item.archive",
  "item.annotate", // a per-item note: stored + read on demand, not pushed as an event
]);
export function isImperative(type: string): boolean {
  return !AMBIENT_CLIENT.has(type);
}

export function agentRepliedSince(messages: Message[], sinceTs: number): boolean {
  return messages.some((m) => m.who === "agent" && m.ts > sinceTs);
}

export function applyAgentMsg(state: GlamourState, msg: AgentCommand): void {
  switch (msg.type) {
    case "init":
      if (typeof msg.title === "string") state.title = msg.title;
      if (typeof msg.intent === "string") state.intent = msg.intent;
      break;
    case "intent":
      state.intent = msg.text;
      break;
    case "item.annotate": {
      const it = state.library.find((i) => i.id === msg.id);
      if (it) it.annotations.agent = msg.agent;
      break;
    }
    case "section":
      updateSection(state, msg.key, {
        content: msg.content,
        status: msg.status,
        prompts: msg.prompts,
        colors: msg.colors,
      });
      break;
    case "focus.push":
      setFocus(state, msg.ids, "agent", msg.note ?? "");
      break;
    case "gen.cost":
      setGenCost(state, msg.id, msg.cost);
      break;
    case "gen.meta":
      setGenMeta(state, msg.id, { prompt: msg.prompt, custom: msg.custom });
      break;
    case "status":
      state.status = { busy: msg.busy, text: msg.text ?? "" };
      break;
    case "style.archive":
      archiveTrayStyle(state, msg.id, msg.archived);
      break;
    case "say":
    case "close":
      break; // handled by the server (appended to conversation / shutdown)
  }
}
