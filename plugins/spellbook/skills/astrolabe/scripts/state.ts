// astrolabe state — the data model + pure reducers (t2).
//
// Three layers kept deliberately separate (proposal §"Data model"):
//   1. Project  — DURABLE registry (persisted to disk, restored on daemon start)
//   2. Presence — LIVE (an agent joined + watching → the card is "active"); never persisted
//   3. Status   — CURRENT only, no history (each post REPLACES the prior; the card
//                 always reflects the present state)
//
// Reducers are PURE: `(state, …, now) => ReducerResult`. They never mutate the
// input and never read the clock — the caller passes `now` (unix ms) so the
// daemon and the tests share one deterministic path. `applied:false` (+ `error`)
// flags a rejected/no-op command so cli read-back can tell a write took.

export type Project = {
  id: string;
  name: string;
  description?: string;
  path: string;
  avatar?: string; // project identity; a seeded/random fallback is assigned upstream (t6)
};

// LIVE — presence is what flips a card to "active": an agent is joined and
// watching. Not persisted (a restored daemon starts with everyone disconnected).
export type Presence = { connected: boolean };

// CURRENT — replaced wholesale by each status post; no history kept (MVP guardrail).
export type Status = {
  summary: string;
  phase?: string;
  needsAttention: boolean; // the human gate (agent → human)
  question?: string; // the prompt shown when needsAttention is raised
  lastUpdated: number; // unix ms
};

export type ObservatoryState = {
  title: string;
  projects: Project[]; // durable registry
  presence: Record<string, Presence>; // by project id — live
  status: Record<string, Status>; // by project id — current only
};

// applied:false means the command was a no-op or rejected; `error` explains a
// rejection (a benign no-op carries no error). `id` is set by applyProjectAdd to
// the id it derived/used, so callers don't re-derive the slug.
export type ReducerResult = {
  state: ObservatoryState;
  applied: boolean;
  error?: string;
  id?: string;
};

// ── Surface projection / wire contract ───────────────────────────────
// The daemon projects the three internal layers into per-project CARDS for the
// surface (readback-parity — an agent reading /state sees what the board
// renders). `zone` is the coarse floor (attention > active > quiet); the surface
// refines quiet → idle/stale from `connected` + `lastUpdated`. This is the exact
// shape the WS {type:"state"} frame and GET /state carry, so server.ts and the
// React surface share ONE contract and neither re-derives it.
export type ProjectStatusView = { summary: string; phase?: string; lastUpdated: number };
export type ProjectCard = Project & {
  connected: boolean;
  needsAttention: boolean;
  question?: string;
  status: ProjectStatusView | null;
  zone: "attention" | "active" | "quiet";
};
export type ObservatoryView = { title: string; projects: ProjectCard[] };

// WebSocket protocol (browser ↔ daemon). The daemon pushes the full projected
// board; the browser sends pokes / dismiss (project registration is POST /cmd).
export type ServerToClient = { type: "state" } & ObservatoryView;
export type ClientToServer = { type: "poke"; id: string } | { type: "close" };

export function emptyState(title = "Observatory"): ObservatoryState {
  return { title, projects: [], presence: {}, status: {} };
}

// A project-identity glyph seeded deterministically from the name, so a card is
// never avatar-less and the SAME name always yields the SAME face. Lives here
// (the pure layer) and is applied by applyProjectAdd, so EVERY registration path
// — cli `add` and the surface's add-form — inherits one source of truth.
const AVATAR_GLYPHS = ["🔭", "🪄", "🌿", "🔮", "⚡", "🛰️", "✨", "🧭", "📡", "🗺️", "⭐", "🌙"];
function hashString(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}
export function fallbackAvatar(name: string): string {
  return AVATAR_GLYPHS[hashString(name.trim().toLowerCase()) % AVATAR_GLYPHS.length];
}

// A registry id derived from a display name. Lives here (the pure layer) and is
// applied by applyProjectAdd when no explicit id is given, so every path — cli
// `add` and the surface's add-form — shares one source (no slug mirror to drift).
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

const normName = (s: string): string => s.trim().toLowerCase();
const normPath = (s: string): string => s.trim().replace(/\/+$/, ""); // ignore a trailing slash

// Dedupe is on name OR path (either colliding is a duplicate): two cards must
// never point at the same path, nor share a name the human can't tell apart.
export function findDuplicate(
  state: ObservatoryState,
  name: string,
  path: string,
  exceptId?: string,
): Project | undefined {
  const n = normName(name);
  const p = normPath(path);
  return state.projects.find(
    (pr) => pr.id !== exceptId && (normName(pr.name) === n || normPath(pr.path) === p),
  );
}

const hasProject = (state: ObservatoryState, id: string): boolean =>
  state.projects.some((p) => p.id === id);

// ── Registry (durable) ───────────────────────────────────────────────

export function applyProjectAdd(state: ObservatoryState, project: Project): ReducerResult {
  const name = project.name?.trim();
  const path = project.path?.trim();
  if (!name || !path) {
    return { state, applied: false, error: "project requires a name and path" };
  }
  // id + avatar are DERIVED from the name when not explicitly given, so the
  // daemon is the single source for both (cli-add and the add-form inherit it).
  const id = project.id?.trim() || slugify(name);
  if (hasProject(state, id)) {
    return { state, applied: false, error: `id '${id}' already registered` };
  }
  const dup = findDuplicate(state, name, path);
  if (dup) {
    return { state, applied: false, error: `duplicate of '${dup.id}' (same name or path)` };
  }
  const registered: Project = {
    ...project,
    id,
    name,
    path,
    avatar: project.avatar?.trim() || fallbackAvatar(name),
  };
  return {
    state: {
      ...state,
      projects: [...state.projects, registered],
      presence: { ...state.presence, [id]: { connected: false } },
    },
    applied: true,
    id,
  };
}

export function applyProjectRemove(state: ObservatoryState, id: string): ReducerResult {
  if (!hasProject(state, id)) {
    return { state, applied: false, error: `unknown project '${id}'` };
  }
  const { [id]: _p, ...presence } = state.presence;
  const { [id]: _s, ...status } = state.status;
  return {
    state: { ...state, projects: state.projects.filter((p) => p.id !== id), presence, status },
    applied: true,
  };
}

// ── Presence (live) ──────────────────────────────────────────────────

export function applySetPresence(
  state: ObservatoryState,
  id: string,
  connected: boolean,
): ReducerResult {
  if (!hasProject(state, id)) {
    return { state, applied: false, error: `unknown project '${id}'` };
  }
  if ((state.presence[id]?.connected ?? false) === connected) {
    return { state, applied: false }; // no-op
  }
  return {
    state: { ...state, presence: { ...state.presence, [id]: { connected } } },
    applied: true,
  };
}

// ── Status (current only) ────────────────────────────────────────────

// A status post REPLACES summary/phase and bumps lastUpdated; the attention
// flag is owned by applyAttention, so it's preserved across a status post.
export function applyStatus(
  state: ObservatoryState,
  id: string,
  update: { summary: string; phase?: string },
  now: number,
): ReducerResult {
  if (!hasProject(state, id)) {
    return { state, applied: false, error: `unknown project '${id}'` };
  }
  const prev = state.status[id];
  const next: Status = {
    summary: update.summary,
    phase: update.phase,
    needsAttention: prev?.needsAttention ?? false,
    question: prev?.question,
    lastUpdated: now,
  };
  return { state: { ...state, status: { ...state.status, [id]: next } }, applied: true };
}

// Raise or clear the human gate. Preserves the current summary/phase; clearing
// drops the question.
export function applyAttention(
  state: ObservatoryState,
  id: string,
  raised: boolean,
  question: string | undefined,
  now: number,
): ReducerResult {
  if (!hasProject(state, id)) {
    return { state, applied: false, error: `unknown project '${id}'` };
  }
  const prev = state.status[id];
  const nextQuestion = raised ? question : undefined;
  if (
    (prev?.needsAttention ?? false) === raised &&
    (prev?.question ?? undefined) === nextQuestion
  ) {
    return { state, applied: false }; // no-op
  }
  const next: Status = {
    summary: prev?.summary ?? "",
    phase: prev?.phase,
    needsAttention: raised,
    question: nextQuestion,
    lastUpdated: now,
  };
  return { state: { ...state, status: { ...state.status, [id]: next } }, applied: true };
}
