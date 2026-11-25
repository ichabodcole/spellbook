// Architecture test: the session parts import only downward. `session.ts` is
// to be split into parts in `src/kit/workspace/session/`, each in a tier
// (docs/architecture/workspace-session.md). A part imports only parts in
// lower tiers, or in its own tier where the call graph already goes one way;
// so there are no import cycles among the parts, tiers 0 (pure) and 1 (the
// core) import no part above them, and nothing in `session/` imports the
// facade (`session.ts`) or `server.ts`, directly or through a sibling module
// (`tasks.ts`, the `index.ts` barrel and others import the facade at run
// time). Where a lower part needs a higher one, it exposes a hook instead.
//
// Ported from Story Studio's `tests/architecture/session-tiers.test.ts`
// (develop b2abead4), near verbatim, so a port either way is a diff between
// files of the same name. What differs: our paths (`src/kit/`, not
// `packages/kit/src/`); the tables, which list our parts and start empty
// (kit-split G1), each split step adding its parts here and on the
// architecture page as it builds them; the fixtures, which run against
// Story Studio's table (`FIXTURE_TIERS`) since ours is empty; and no
// package-name rule, since our kit has no package name to import it by.
//
// It is strict from the start: every part in the table must be a file in
// `session/`, and every file there must have a tier, so the table and the
// folder say the same thing. A file not in the table fails until it is given
// a tier here and on the architecture page; a part in the table with no file
// fails until its row goes, here and there. Tests in `session/` are left out.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { importSpecifiers, REPO_ROOT, rel, resolveRelative, sourceFiles } from "./walk.ts";

const KIT_SRC = join(REPO_ROOT, "src", "kit");
const WORKSPACE = join(KIT_SRC, "workspace");
const SESSION_DIR = join(WORKSPACE, "session");

/**
 * Each part's tier, from the write-up's module tables
 * (docs/items/kit-split-oversized-modules/write-up.md). Each step adds the
 * rows for the parts it builds.
 */
export const TIERS: Record<string, number> = {
  // Tier 0: pure, no session state (S2).
  errors: 0,
  names: 0,
  paths: 0,
  facts: 0,
  types: 0,
  manifest: 0,
  // Tier 1: the core, which every part takes (S3). Within it, `places` and
  // `writes` take `state`, and `writes` takes `places`, one way.
  state: 1,
  places: 1,
  writes: 1,
  // Tier 2: the tree, what is on screen, the conversation (S4 built `chats`).
  chats: 2,
  // Tier 3: documents (S4 built `tasks`, which needs only the core).
  tasks: 3,
  // Tier 4: what reads across documents (S5 builds the read side).
  readIndex: 4,
};

/**
 * Story Studio's table on their develop (b2abead4), which the fixtures below
 * were written against: our own table holds only the parts built so far, and a
 * fixture needs parts in every tier to break the rule with.
 */
const FIXTURE_TIERS: Record<string, number> = {
  // Tier 0: pure, no session state.
  errors: 0,
  names: 0,
  paths: 0,
  facts: 0,
  types: 0,
  // Tier 1: the core, which every part takes.
  state: 1,
  places: 1,
  writes: 1,
  // Tier 2: the tree, what is on screen, the conversation.
  bundleStamps: 2,
  context: 2,
  top: 2,
  placing: 2,
  viewer: 2,
  media: 2,
  sidecars: 2,
  chats: 2,
  copyIn: 2,
  // Tier 3: documents.
  documents: 3,
  follow: 3,
  tasks: 3,
  unseen: 3,
  images: 3,
  audio: 3,
  orders: 3,
  // Tier 4: what reacts, saves and reads across documents.
  reconcile: 4,
  saving: 4,
  compare: 4,
  notes: 4,
  readIndex: 4,
  linkResolve: 4,
  profiles: 4,
  relations: 4,
  markers: 4,
  search: 4,
  trash: 4,
  copyRecords: 4,
  libraryLinks: 4,
  // Tier 5: changes that span the tree, and the whole view.
  linkCheck: 5,
  linkReports: 5,
  relinkOnMove: 5,
  structure: 5,
  imageImport: 5,
  copySource: 5,
  projectMeta: 5,
  views: 5,
};

/** A test file: the rule is for the parts, not their tests. */
const isTest = (file: string) => /\.test\.[cm]?[jt]sx?$/.test(file);

/** A path without its source extension. */
const stem = (path: string) => path.replace(/\.(?:ts|tsx|mts|cts|js|jsx|mjs)$/, "");

/** A part's name: its file name without the extension. */
const partOf = (file: string) => stem(basename(file));

/** The files a part may never import: the facade and the server. */
const FORBIDDEN = new Map([
  [join(WORKSPACE, "session"), "the facade (session.ts)"],
  [join(WORKSPACE, "server"), "server.ts"],
]);

type Source = { file: string; text: string };

/** Reads a source file, or undefined when there is none at `path`. */
export type Read = (path: string) => string | undefined;

const readDisk: Read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * The specifiers `text` imports at run time: Bun's own scan, which leaves out
 * `import type`, `export type` and imports used only as types.
 */
function runtimeSpecifiers(file: string, text: string): string[] {
  const loader = file.endsWith(".tsx") ? "tsx" : "ts";
  return new Bun.Transpiler({ loader }).scanImports(text).map((i) => i.path);
}

/** The source file a relative import resolves to, or undefined when none exists. */
function resolveFile(target: string, read: Read): string | undefined {
  const tries = target === stem(target) ? [] : [target];
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) tries.push(stem(target) + ext);
  return tries.find((p) => read(p) !== undefined);
}

/**
 * The chain from `start`, a module outside `session/`, to the facade or
 * `server.ts` through run-time relative imports within the kit's source, or
 * null when it reaches neither. Files in `dir` are not followed: each part
 * is checked on its own.
 */
function forbiddenChain(
  start: string,
  dir: string,
  read: Read,
  forbiddenFiles: ReadonlyMap<string, string> = FORBIDDEN,
): string[] | null {
  const from = new Map<string, string | null>([[start, null]]);
  const chainTo = (file: string, last: string) => {
    const chain = [last];
    for (let at: string | null = file; at; at = from.get(at) ?? null) chain.unshift(rel(at));
    return chain;
  };
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const text = read(file);
    if (text === undefined) continue;
    for (const spec of runtimeSpecifiers(file, text)) {
      if (!spec.startsWith(".")) continue;
      const target = resolveRelative(file, spec);
      const forbidden = forbiddenFiles.get(stem(target));
      if (forbidden) return chainTo(file, forbidden);
      const next = resolveFile(target, read);
      if (!next || from.has(next)) continue;
      if (!next.startsWith(KIT_SRC + sep) || next.startsWith(dir + sep)) continue;
      from.set(next, file);
      queue.push(next);
    }
  }
  return null;
}

/** What breaks the tier rule among `files` (the parts in `dir`), one line per break. */
export function tierBreaks(
  files: Source[],
  dir: string = SESSION_DIR,
  tiers: Record<string, number> = TIERS,
  read: Read = readDisk,
): string[] {
  const out: string[] = [];
  const parts = files.filter((f) => !isTest(f.file));
  const edges = new Map<string, string[]>();
  for (const { file, text } of parts) {
    const part = partOf(file);
    const tier = tiers[part];
    if (tier === undefined) {
      out.push(
        `${rel(file)} has no tier: add it to TIERS in tests/architecture/session-tiers.test.ts and to docs/architecture/workspace-session.md`,
      );
      continue;
    }
    const to: string[] = [];
    const runtime = new Set(runtimeSpecifiers(file, text));
    for (const spec of importSpecifiers(text, file)) {
      if (!spec.startsWith(".")) continue;
      const target = stem(resolveRelative(file, spec));
      const forbidden = FORBIDDEN.get(target);
      if (forbidden) {
        out.push(`${rel(file)} imports ${forbidden} (${spec})`);
        continue;
      }
      if (stem(join(dir, basename(target))) !== target) {
        // Not a part: a sibling module, which must not lead back to the facade.
        if (!runtime.has(spec)) continue;
        const start = resolveFile(resolveRelative(file, spec), read);
        const chain = start && forbiddenChain(start, dir, read);
        if (chain)
          out.push(
            `${rel(file)} reaches ${chain.at(-1)} through ${chain.slice(0, -1).join(" -> ")}`,
          );
        continue;
      }
      const other = basename(target);
      const otherTier = tiers[other];
      if (otherTier === undefined) continue; // reported as the other file's own break
      to.push(other);
      if (tier <= 1 && otherTier > 1)
        out.push(`${rel(file)} (tier ${tier}) imports the part ${other} (tier ${otherTier})`);
      else if (otherTier > tier)
        out.push(`${rel(file)} (tier ${tier}) imports ${other} from a higher tier (${otherTier})`);
    }
    edges.set(part, to);
  }
  // Import cycles among the parts, each reported once, from its first part by name.
  const seen = new Set<string>();
  const cycles = new Set<string>();
  const visit = (part: string, path: string[]) => {
    const at = path.indexOf(part);
    if (at >= 0) {
      const loop = path.slice(at);
      const first = loop.indexOf([...loop].sort()[0] as string);
      const turned = [...loop.slice(first), ...loop.slice(0, first)];
      cycles.add([...turned, turned[0]].join(" -> "));
      return;
    }
    if (seen.has(part)) return;
    for (const next of edges.get(part) ?? []) visit(next, [...path, part]);
    if (path.length === 0) seen.add(part);
  };
  for (const part of [...edges.keys()].sort()) {
    visit(part, []);
    seen.add(part);
  }
  for (const c of [...cycles].sort()) out.push(`import cycle in session/: ${c}`);
  return out;
}

/**
 * The parts in `tiers` with no file among `files` (strict: every part in the
 * table is built), one line each.
 */
export function unbuiltParts(
  files: readonly Pick<Source, "file">[],
  tiers: Record<string, number> = TIERS,
): string[] {
  const built = new Set(files.filter((f) => !isTest(f.file)).map((f) => partOf(f.file)));
  return Object.keys(tiers)
    .filter((part) => !built.has(part))
    .sort()
    .map(
      (part) =>
        `${part} has a tier but no file in src/kit/workspace/session/: build it, or take its row out of TIERS in tests/architecture/session-tiers.test.ts and docs/architecture/workspace-session.md`,
    );
}

describe("the session parts import only downward", () => {
  const tree = () =>
    sourceFiles(SESSION_DIR).map((file) => ({
      file,
      text: readFileSync(file, "utf8"),
    }));

  test("the parts in workspace/session/ keep their tiers", () => {
    expect(tierBreaks(tree())).toEqual([]);
  });

  test("every part in the table is built: the folder and the table name the same parts (strict)", () => {
    expect(unbuiltParts(tree())).toEqual([]);
  });

  test("the strict check names a part in the table with no file, and ignores tests (fixtures, not the tree)", () => {
    const at = (p: string) => join(SESSION_DIR, p);
    const tiers = { state: 1, views: 5, images: 3 };
    expect(unbuiltParts([{ file: at("state.ts") }, { file: at("images.test.ts") }], tiers)).toEqual(
      [
        "images has a tier but no file in src/kit/workspace/session/: build it, or take its row out of TIERS in tests/architecture/session-tiers.test.ts and docs/architecture/workspace-session.md",
        "views has a tier but no file in src/kit/workspace/session/: build it, or take its row out of TIERS in tests/architecture/session-tiers.test.ts and docs/architecture/workspace-session.md",
      ],
    );
  });

  test("every planned part has a tier from 0 to 5", () => {
    for (const [part, tier] of Object.entries(TIERS)) {
      expect({ part, ok: Number.isInteger(tier) && tier >= 0 && tier <= 5 }).toEqual({
        part,
        ok: true,
      });
    }
  });

  test("the rule catches an upward import, a cycle, the facade, the server and an unknown part (fixtures, not the tree)", () => {
    const at = (p: string) => join(SESSION_DIR, p);
    // The siblings the fixtures import: none leads to the facade at run time.
    const siblings: Record<string, string> = {
      [join(WORKSPACE, "links.ts")]: `import type { WorkspaceSession } from "./session";`,
    };
    const files: Source[] = [
      // Allowed: downward, and within a tier one way.
      { file: at("documents.ts"), text: `import { m } from "./state.ts";\nimport "./errors";` },
      { file: at("readIndex.ts"), text: `import { docs } from "./documents.ts";` },
      { file: at("profiles.ts"), text: `import { readOf } from "./readIndex.ts";` },
      { file: at("errors.ts"), text: `import { join } from "node:path";\nimport "../links.ts";` },
      // Broken.
      { file: at("names.ts"), text: `import { m } from "./state.ts";\nimport "./chats.ts";` },
      { file: at("places.ts"), text: `import { docs } from "./documents.ts";` },
      { file: at("context.ts"), text: `import { save } from "./saving.ts";` },
      { file: at("saving.ts"), text: `import { context } from "./context.ts";` },
      { file: at("search.ts"), text: `import { WorkspaceSession } from "../session.ts";` },
      { file: at("views.ts"), text: `import { createWorkspaceDaemon } from "../server";` },
      { file: at("compare.ts"), text: `import "./merge.ts";` },
      { file: at("merge.ts"), text: `import "./compare.ts";` },
      { file: at("tasks.ts"), text: `import "./unseen.ts";` },
      { file: at("unseen.ts"), text: `import "./tasks.ts";` },
      // A test may import anything.
      { file: at("views.test.ts"), text: `import "../session.ts";\nimport "./structure.ts";` },
    ];
    expect(tierBreaks(files, SESSION_DIR, FIXTURE_TIERS, (p) => siblings[p])).toEqual([
      "src/kit/workspace/session/names.ts (tier 0) imports state from a higher tier (1)",
      "src/kit/workspace/session/names.ts (tier 0) imports the part chats (tier 2)",
      "src/kit/workspace/session/places.ts (tier 1) imports the part documents (tier 3)",
      "src/kit/workspace/session/context.ts (tier 2) imports saving from a higher tier (4)",
      "src/kit/workspace/session/search.ts imports the facade (session.ts) (../session.ts)",
      "src/kit/workspace/session/views.ts imports server.ts (../server)",
      "src/kit/workspace/session/merge.ts has no tier: add it to TIERS in tests/architecture/session-tiers.test.ts and to docs/architecture/workspace-session.md",
      "import cycle in session/: context -> saving -> context",
      "import cycle in session/: tasks -> unseen -> tasks",
    ]);
  });

  test("the rule follows sibling modules to the facade and the server (fixtures, not the tree)", () => {
    const at = (p: string) => join(SESSION_DIR, p);
    const w = (p: string) => join(WORKSPACE, p);
    const siblings: Record<string, string> = {
      // Imports the facade at run time, as tasks.ts does today.
      [w("tasks.ts")]:
        `import { SessionError } from "./session";\nexport const isFinished = () => SessionError;`,
      // A barrel that leads to the server two steps on.
      [w("index.ts")]: `export { helper } from "./helper.ts";`,
      [w("helper.ts")]: `import { serve } from "./server.ts";\nexport const helper = serve;`,
      // Names the facade only as a type: nothing of it runs.
      [w("links.ts")]:
        `import type { WorkspaceSession } from "./session";\nexport const only = (s: WorkspaceSession) => s;`,
      // Leads into a part, which is checked on its own and not followed.
      [w("tree.ts")]: `import { m } from "./session/state.ts";\nexport const walk = m;`,
    };
    const files: Source[] = [
      {
        file: at("documents.ts"),
        text: `import { isFinished } from "../tasks.ts";\nisFinished();`,
      },
      { file: at("chats.ts"), text: `import { helper } from "../index.ts";\nhelper();` },
      // Allowed: a type-only import of a sibling that reaches the facade, a
      // sibling that names it only as a type, and one that leads into a part.
      {
        file: at("media.ts"),
        text: `import type { isFinished } from "../tasks.ts";\nexport type T = typeof isFinished;`,
      },
      { file: at("sidecars.ts"), text: `import { only } from "../links.ts";\nonly();` },
      { file: at("placing.ts"), text: `import { walk } from "../tree.ts";\nwalk();` },
      { file: at("state.ts"), text: `export const m = {};` },
    ];
    expect(tierBreaks(files, SESSION_DIR, FIXTURE_TIERS, (p) => siblings[p])).toEqual([
      "src/kit/workspace/session/documents.ts reaches the facade (session.ts) through src/kit/workspace/tasks.ts",
      "src/kit/workspace/session/chats.ts reaches server.ts through src/kit/workspace/index.ts -> src/kit/workspace/helper.ts",
    ]);
  });
});

// ── the daemon's parts ───────────────────────────────────────────────────────
//
// `server.ts` is to be split the same way, into `src/kit/workspace/daemon/`
// (the kit-split D steps). Its tiers are on the same page
// (docs/architecture/workspace-session.md): 0 is the pure code (types, rules,
// landings), 1 the kernel (`core`) and the views over it, 2 the parts over
// those (prefs, presence, messages, watching), 3 the parts over those
// (saving, trash, picker), 4 the parts over those (imagesIn, linkFollow,
// structure, appWork), 5 the dispatchers and the routes (`surfaceOps` with
// its topic maps in `surfaceOps/`, `agentOps` and `http`), which take every
// part's types. A module in a subfolder is named with it
// (`surfaceOps/tree`). A module there imports only lower tiers, or its own
// tier one way, so there are no import cycles; the kernel imports no part
// (only tier 0); and nothing in `daemon/` imports `server.ts`, directly or
// through a sibling module at run time. Parts may import the session and its
// parts, and nothing in `session/` imports `daemon/`. Strict from the start:
// each step of the split adds its parts here and on the page as it builds
// them, so the table is empty until D1.

const DAEMON_DIR = join(WORKSPACE, "daemon");

/**
 * A daemon module's name: its path in `dir` without the extension, so a
 * module in a subfolder is named with it (`surfaceOps/tree`).
 */
const daemonPartOf = (file: string, dir: string = DAEMON_DIR) =>
  stem(relative(dir, file)).split(sep).join("/");

/**
 * Each daemon module's tier, as the architecture page gives it. Empty until D1
 * builds the first modules; each step adds the rows for the modules it builds.
 */
export const DAEMON_TIERS: Record<string, number> = {};

/** The kernel: it imports no part, only tier 0. */
const KERNEL = "core";

/** The file no daemon module may import. */
const DAEMON_FORBIDDEN = new Map([[join(WORKSPACE, "server"), "server.ts"]]);

/** What breaks the daemon's tier rule among `files` (the modules in `dir`), one line per break. */
export function daemonBreaks(
  files: Source[],
  dir: string = DAEMON_DIR,
  tiers: Record<string, number> = DAEMON_TIERS,
  read: Read = readDisk,
): string[] {
  const out: string[] = [];
  const edges = new Map<string, string[]>();
  for (const { file, text } of files.filter((f) => !isTest(f.file))) {
    const part = daemonPartOf(file, dir);
    const tier = tiers[part];
    if (tier === undefined) {
      out.push(
        `${rel(file)} has no tier: add it to DAEMON_TIERS in tests/architecture/session-tiers.test.ts and to docs/architecture/workspace-session.md`,
      );
      continue;
    }
    const to: string[] = [];
    const runtime = new Set(runtimeSpecifiers(file, text));
    for (const spec of importSpecifiers(text, file)) {
      if (!spec.startsWith(".")) continue;
      const target = stem(resolveRelative(file, spec));
      const forbidden = DAEMON_FORBIDDEN.get(target);
      if (forbidden) {
        out.push(`${rel(file)} imports ${forbidden} (${spec})`);
        continue;
      }
      if (!target.startsWith(dir + sep)) {
        // Not a daemon module: a sibling, which must not lead back to the server.
        if (!runtime.has(spec)) continue;
        const start = resolveFile(resolveRelative(file, spec), read);
        const chain = start && forbiddenChain(start, dir, read, DAEMON_FORBIDDEN);
        if (chain)
          out.push(
            `${rel(file)} reaches ${chain.at(-1)} through ${chain.slice(0, -1).join(" -> ")}`,
          );
        continue;
      }
      const other = daemonPartOf(target, dir);
      const otherTier = tiers[other];
      if (otherTier === undefined) continue; // reported as the other file's own break
      to.push(other);
      if (part === KERNEL && otherTier > 0)
        out.push(`${rel(file)} (the kernel) imports the part ${other} (tier ${otherTier})`);
      else if (otherTier > tier)
        out.push(`${rel(file)} (tier ${tier}) imports ${other} from a higher tier (${otherTier})`);
    }
    edges.set(part, to);
  }
  // Import cycles among the modules, each reported once, from its first module by name.
  const seen = new Set<string>();
  const cycles = new Set<string>();
  const visit = (part: string, path: string[]) => {
    const at = path.indexOf(part);
    if (at >= 0) {
      const loop = path.slice(at);
      const first = loop.indexOf([...loop].sort()[0] as string);
      const turned = [...loop.slice(first), ...loop.slice(0, first)];
      cycles.add([...turned, turned[0]].join(" -> "));
      return;
    }
    if (seen.has(part)) return;
    for (const next of edges.get(part) ?? []) visit(next, [...path, part]);
    if (path.length === 0) seen.add(part);
  };
  for (const part of [...edges.keys()].sort()) {
    visit(part, []);
    seen.add(part);
  }
  for (const c of [...cycles].sort()) out.push(`import cycle in daemon/: ${c}`);
  return out;
}

/** The files in `session/` that import a module in `daemon/`, one line each. */
export function sessionReachesDaemon(files: Source[]): string[] {
  const out: string[] = [];
  for (const { file, text } of files) {
    for (const spec of importSpecifiers(text, file)) {
      if (!spec.startsWith(".")) continue;
      if (resolveRelative(file, spec).startsWith(DAEMON_DIR + sep))
        out.push(`${rel(file)} imports the daemon (${spec})`);
    }
  }
  return out;
}

describe("the daemon's parts import only downward", () => {
  test("a module in a subfolder is named with it, and keeps the rule (fixtures, not the tree)", () => {
    const at = (p: string) => join(DAEMON_DIR, p);
    const tiers = { core: 1, asks: 3, surfaceOps: 5, "surfaceOps/tree": 5, "surfaceOps/low": 2 };
    const files: Source[] = [
      // Allowed: a subfolder module on a lower part, and the merge on its own tier one way.
      { file: at("surfaceOps/tree.ts"), text: `import type { DaemonAsks } from "../asks.ts";` },
      { file: at("surfaceOps.ts"), text: `import { createTreeOps } from "./surfaceOps/tree.ts";` },
      // Broken: an upward import from a subfolder, the kernel on a subfolder
      // module, and a subfolder module with no tier (which is reported for
      // that alone, before its import of the server is read).
      { file: at("surfaceOps/low.ts"), text: `import "./tree.ts";` },
      { file: at("core.ts"), text: `import "./surfaceOps/low.ts";` },
      { file: at("surfaceOps/chats.ts"), text: `import "../../server.ts";` },
    ];
    expect(daemonBreaks(files, DAEMON_DIR, tiers)).toEqual([
      "src/kit/workspace/daemon/surfaceOps/low.ts (tier 2) imports surfaceOps/tree from a higher tier (5)",
      "src/kit/workspace/daemon/core.ts (the kernel) imports the part surfaceOps/low (tier 2)",
      "src/kit/workspace/daemon/surfaceOps/chats.ts has no tier: add it to DAEMON_TIERS in tests/architecture/session-tiers.test.ts and to docs/architecture/workspace-session.md",
    ]);
  });

  const tree = (dir: string) =>
    sourceFiles(dir).map((file) => ({ file, text: readFileSync(file, "utf8") }));

  test("the modules in workspace/daemon/ keep their tiers", () => {
    expect(daemonBreaks(tree(DAEMON_DIR))).toEqual([]);
  });

  test("every daemon module in the table is built (strict)", () => {
    const built = new Set(
      tree(DAEMON_DIR)
        .filter((f) => !isTest(f.file))
        .map((f) => daemonPartOf(f.file)),
    );
    expect(Object.keys(DAEMON_TIERS).filter((p) => !built.has(p))).toEqual([]);
  });

  test("nothing in workspace/session/ imports workspace/daemon/", () => {
    expect(sessionReachesDaemon(tree(SESSION_DIR))).toEqual([]);
  });

  test("the rule catches the kernel importing a part, an upward import, a cycle, the server and an unknown module (fixtures, not the tree)", () => {
    const at = (p: string) => join(DAEMON_DIR, p);
    const w = (p: string) => join(WORKSPACE, p);
    const siblings: Record<string, string> = {
      // A sibling that leads to the server at run time.
      [w("index.ts")]: `export { createWorkspaceDaemon } from "./server.ts";`,
    };
    const tiers = { types: 0, rules: 0, core: 1, views: 1, asks: 3, saving: 3 };
    const files: Source[] = [
      // Allowed: the kernel on tier 0, a view on the kernel, a module on the session.
      { file: at("core.ts"), text: `import { QUIET } from "./rules.ts";\nimport "./types.ts";` },
      { file: at("rules.ts"), text: `import type { WorkspaceSession } from "../session";` },
      // Broken.
      { file: at("types.ts"), text: `import type { Asks } from "./asks.ts";` },
      {
        file: at("views.ts"),
        text: `import type { DaemonCore } from "./core.ts";\nimport "./asks.ts";`,
      },
      { file: at("asks.ts"), text: `import "./saving.ts";\nimport type { X } from "../server";` },
      {
        file: at("saving.ts"),
        text: `import "./asks.ts";\nimport { x } from "../index.ts";\nx();`,
      },
      { file: at("http.ts"), text: `export const http = 1;` },
      // A test may import anything.
      { file: at("core.test.ts"), text: `import "../server.ts";` },
    ];
    expect(daemonBreaks(files, DAEMON_DIR, tiers, (p) => siblings[p])).toEqual([
      "src/kit/workspace/daemon/types.ts (tier 0) imports asks from a higher tier (3)",
      "src/kit/workspace/daemon/views.ts (tier 1) imports asks from a higher tier (3)",
      "src/kit/workspace/daemon/asks.ts imports server.ts (../server)",
      "src/kit/workspace/daemon/saving.ts reaches server.ts through src/kit/workspace/index.ts",
      "src/kit/workspace/daemon/http.ts has no tier: add it to DAEMON_TIERS in tests/architecture/session-tiers.test.ts and to docs/architecture/workspace-session.md",
      "import cycle in daemon/: asks -> saving -> asks",
    ]);
    const kernelOnPart: Source = { file: at("core.ts"), text: `import "./views.ts";` };
    expect(daemonBreaks([kernelOnPart], DAEMON_DIR, tiers)).toEqual([
      "src/kit/workspace/daemon/core.ts (the kernel) imports the part views (tier 1)",
    ]);
    expect(
      sessionReachesDaemon([
        {
          file: join(SESSION_DIR, "views.ts"),
          text: `import type { DaemonCore } from "../daemon/core.ts";`,
        },
        { file: join(SESSION_DIR, "state.ts"), text: `import "../batch.ts";` },
      ]),
    ).toEqual(["src/kit/workspace/session/views.ts imports the daemon (../daemon/core.ts)"]);
  });
});
