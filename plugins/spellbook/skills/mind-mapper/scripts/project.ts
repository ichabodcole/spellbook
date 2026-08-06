// P1 — project lifecycle. A project is a directory name + a store.sqlite + a
// docs/ subfolder + a project.json ({title}) — nothing fancier (Claim A/B:
// the daemon is a dumb state authority; keep the dumbest shape that works).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./db.ts";

const DEFAULT_PROJECT_ID = "default";
// Shared slug guard — project ids AND doc ids are agreed slugs; anything else
// (path traversal, separators) must be rejected before it reaches a
// filesystem path. Single source: every read AND write path imports this.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ID_RE = SLUG_RE;

interface ProjectMeta {
  id: string;
  title: string;
}

function projectDir(home: string, id: string): string {
  return join(home, "projects", id);
}

function readMeta(dir: string, id: string): ProjectMeta {
  const metaFile = join(dir, "project.json");
  if (existsSync(metaFile)) {
    try {
      const parsed = JSON.parse(readFileSync(metaFile, "utf8")) as { title?: unknown };
      if (typeof parsed.title === "string") return { id, title: parsed.title };
    } catch {
      /* fall through to id-as-title */
    }
  }
  return { id, title: id };
}

function ensureProjectDirs(dir: string): void {
  mkdirSync(join(dir, "docs"), { recursive: true });
}

function createProject(home: string, id: string, title: string): ProjectMeta {
  if (!ID_RE.test(id)) throw new Error(`invalid project id: ${id}`);
  const dir = projectDir(home, id);
  if (existsSync(dir)) throw new Error(`project already exists: ${id}`);
  ensureProjectDirs(dir);
  writeFileSync(join(dir, "project.json"), JSON.stringify({ title }, null, 2));
  openStore(join(dir, "store.sqlite")).close();
  return { id, title };
}

// Round 3 (Claim P1, as corrected): a projectless store boots EMPTY — the
// default project is never auto-minted (and the demo-seed path is gone with
// it, lead ruling). An unscoped request resolves to "default" iff its dir
// already exists (legacy stores keep working unscoped, no migration); else
// this typed error surfaces as 409 {error:"needs-project", projects:[...]}
// from every scoped endpoint, and the surface renders pick-or-create.
class NeedsProjectError extends Error {
  constructor() {
    super("no project scope and no default project — create or pick one");
    this.name = "NeedsProjectError";
  }
}

// Unknown-but-named scope stays its own failure (a 404, per Contract 9) —
// distinct from the projectless 409: the caller named something that isn't
// there, not nothing at all.
class UnknownProjectError extends Error {
  constructor(id: string) {
    super(`unknown project: ${id}`);
    this.name = "UnknownProjectError";
  }
}

function resolveProject(home: string, id?: string): ProjectMeta {
  if (id === undefined) {
    const dir = projectDir(home, DEFAULT_PROJECT_ID);
    if (!existsSync(dir)) throw new NeedsProjectError();
    return readMeta(dir, DEFAULT_PROJECT_ID);
  }
  const dir = projectDir(home, id);
  if (!existsSync(dir)) throw new UnknownProjectError(id);
  return readMeta(dir, id);
}

function listProjects(home: string): ProjectMeta[] {
  const root = join(home, "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readMeta(join(root, entry.name), entry.name));
}

export type { ProjectMeta };
export {
  createProject,
  listProjects,
  NeedsProjectError,
  projectDir,
  resolveProject,
  UnknownProjectError,
};
