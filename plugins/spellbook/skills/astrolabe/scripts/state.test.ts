import { describe, expect, test } from "bun:test";
import {
  applyAttention,
  applyProjectAdd,
  applyProjectRemove,
  applySetPresence,
  applyStatus,
  emptyState,
  fallbackAvatar,
  findDuplicate,
  type ObservatoryState,
  type Project,
  slugify,
} from "./state.ts";

const proj = (over: Partial<Project> = {}): Project => ({
  id: "imago",
  name: "Imago Layers",
  path: "~/Projects/imago",
  ...over,
});

// A state with one registered project, no presence/status yet.
function seeded(): ObservatoryState {
  const r = applyProjectAdd(emptyState(), proj());
  expect(r.applied).toBe(true);
  return r.state;
}

describe("emptyState", () => {
  test("is empty across all three layers", () => {
    const s = emptyState("Observatory");
    expect(s).toEqual({ title: "Observatory", projects: [], presence: {}, status: {} });
  });
});

describe("applyProjectAdd", () => {
  test("registers a project and initializes disconnected presence", () => {
    const { state, applied } = applyProjectAdd(emptyState(), proj());
    expect(applied).toBe(true);
    expect(state.projects).toHaveLength(1);
    expect(state.presence.imago).toEqual({ connected: false });
    expect(state.status.imago).toBeUndefined(); // no status until the first post
  });

  test("does not mutate the input state", () => {
    const before = emptyState();
    applyProjectAdd(before, proj());
    expect(before.projects).toHaveLength(0);
    expect(before.presence).toEqual({});
  });

  test("rejects a duplicate name (case/whitespace-insensitive)", () => {
    const { state, applied, error } = applyProjectAdd(
      seeded(),
      proj({ id: "other", name: "  imago layers  ", path: "~/elsewhere" }),
    );
    expect(applied).toBe(false);
    expect(error).toContain("duplicate");
    expect(state.projects).toHaveLength(1);
  });

  test("rejects a duplicate path (trailing slash ignored)", () => {
    const { applied, error } = applyProjectAdd(
      seeded(),
      proj({ id: "other", name: "Different", path: "~/Projects/imago/" }),
    );
    expect(applied).toBe(false);
    expect(error).toContain("duplicate");
  });

  test("rejects a re-used id", () => {
    const { applied, error } = applyProjectAdd(seeded(), proj({ name: "New", path: "~/new" }));
    expect(applied).toBe(false);
    expect(error).toContain("already registered");
  });

  test("rejects a missing name or path (id is optional — derived)", () => {
    expect(applyProjectAdd(emptyState(), proj({ name: "  " })).applied).toBe(false);
    expect(applyProjectAdd(emptyState(), proj({ path: "" })).applied).toBe(false);
  });

  test("seeds a deterministic fallback avatar when none is given", () => {
    const { state } = applyProjectAdd(emptyState(), proj({ avatar: undefined }));
    expect(state.projects[0].avatar).toBe(fallbackAvatar("Imago Layers"));
  });

  test("keeps an explicitly provided avatar", () => {
    const { state } = applyProjectAdd(emptyState(), proj({ avatar: "🦊" }));
    expect(state.projects[0].avatar).toBe("🦊");
  });

  test("derives the id from the name when none is given (slugified)", () => {
    const { state, applied } = applyProjectAdd(
      emptyState(),
      { name: "Imago Layers", path: "~/imago" } as Project, // no id
    );
    expect(applied).toBe(true);
    expect(state.projects[0].id).toBe("imago-layers");
    expect(state.presence["imago-layers"]).toEqual({ connected: false });
  });
});

describe("fallbackAvatar / slugify", () => {
  test("fallbackAvatar is deterministic (case/space-insensitive) and non-empty", () => {
    expect(fallbackAvatar("Imago Layers")).toBe(fallbackAvatar("  imago layers  "));
    expect(fallbackAvatar("Anything").length).toBeGreaterThan(0);
  });
  test("slugify normalizes a name into an id", () => {
    expect(slugify("Imago Layers")).toBe("imago-layers");
    expect(slugify("  Wand CLI!!  ")).toBe("wand-cli");
    expect(slugify("Operator/Sync v2")).toBe("operator-sync-v2");
    expect(slugify("")).toBe("project");
    expect(slugify("***")).toBe("project");
  });
});

describe("findDuplicate", () => {
  test("excludes a project by id (so a self-update is not a collision)", () => {
    expect(findDuplicate(seeded(), "Imago Layers", "~/Projects/imago", "imago")).toBeUndefined();
  });
});

describe("applyProjectRemove", () => {
  test("removes the project from all three layers", () => {
    let s = seeded();
    s = applySetPresence(s, "imago", true).state;
    s = applyStatus(s, "imago", { summary: "working" }, 1000).state;
    const { state, applied } = applyProjectRemove(s, "imago");
    expect(applied).toBe(true);
    expect(state.projects).toHaveLength(0);
    expect(state.presence.imago).toBeUndefined();
    expect(state.status.imago).toBeUndefined();
  });

  test("rejects an unknown project", () => {
    expect(applyProjectRemove(emptyState(), "ghost").applied).toBe(false);
  });
});

describe("presence", () => {
  test("connect flips connected true; disconnect flips it false", () => {
    let s = seeded();
    s = applySetPresence(s, "imago", true).state;
    expect(s.presence.imago.connected).toBe(true);
    s = applySetPresence(s, "imago", false).state;
    expect(s.presence.imago.connected).toBe(false);
  });

  test("setting the same presence is a no-op (applied:false, no error)", () => {
    const r = applySetPresence(seeded(), "imago", false); // already disconnected
    expect(r.applied).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test("rejects an unknown project", () => {
    expect(applySetPresence(emptyState(), "ghost", true).applied).toBe(false);
  });
});

describe("applyStatus", () => {
  test("replaces summary/phase and stamps lastUpdated", () => {
    const { state } = applyStatus(seeded(), "imago", { summary: "phase 3", phase: "3/5" }, 1234);
    expect(state.status.imago).toEqual({
      summary: "phase 3",
      phase: "3/5",
      needsAttention: false,
      question: undefined,
      lastUpdated: 1234,
    });
  });

  test("a second post replaces the first (no history) and re-stamps", () => {
    let s = seeded();
    s = applyStatus(s, "imago", { summary: "first", phase: "a" }, 100).state;
    s = applyStatus(s, "imago", { summary: "second" }, 200).state;
    expect(s.status.imago.summary).toBe("second");
    expect(s.status.imago.phase).toBeUndefined(); // replace, not merge
    expect(s.status.imago.lastUpdated).toBe(200);
  });

  test("preserves a raised attention flag across a status post", () => {
    let s = seeded();
    s = applyAttention(s, "imago", true, "which merge strategy?", 100).state;
    s = applyStatus(s, "imago", { summary: "still paused" }, 200).state;
    expect(s.status.imago.needsAttention).toBe(true);
    expect(s.status.imago.question).toBe("which merge strategy?");
  });

  test("rejects an unknown project", () => {
    expect(applyStatus(emptyState(), "ghost", { summary: "x" }, 1).applied).toBe(false);
  });
});

describe("applyAttention", () => {
  test("raises the gate with a question, creating a status entry if none", () => {
    const { state, applied } = applyAttention(seeded(), "imago", true, "approve delete?", 500);
    expect(applied).toBe(true);
    expect(state.status.imago.needsAttention).toBe(true);
    expect(state.status.imago.question).toBe("approve delete?");
    expect(state.status.imago.summary).toBe(""); // no prior status
    expect(state.status.imago.lastUpdated).toBe(500);
  });

  test("clearing drops the question and preserves the summary", () => {
    let s = seeded();
    s = applyStatus(s, "imago", { summary: "working", phase: "2" }, 100).state;
    s = applyAttention(s, "imago", true, "blocked on X", 200).state;
    s = applyAttention(s, "imago", false, undefined, 300).state;
    expect(s.status.imago.needsAttention).toBe(false);
    expect(s.status.imago.question).toBeUndefined();
    expect(s.status.imago.summary).toBe("working");
    expect(s.status.imago.phase).toBe("2");
  });

  test("re-raising the identical gate is a no-op", () => {
    let s = seeded();
    s = applyAttention(s, "imago", true, "same", 100).state;
    const r = applyAttention(s, "imago", true, "same", 200);
    expect(r.applied).toBe(false);
    expect(r.error).toBeUndefined();
  });

  test("rejects an unknown project", () => {
    expect(applyAttention(emptyState(), "ghost", true, "q", 1).applied).toBe(false);
  });
});
