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

function resolveProject(home: string, id?: string): ProjectMeta {
  if (id === undefined) {
    const dir = projectDir(home, DEFAULT_PROJECT_ID);
    if (!existsSync(dir)) return createProject(home, DEFAULT_PROJECT_ID, "Default");
    return readMeta(dir, DEFAULT_PROJECT_ID);
  }
  const dir = projectDir(home, id);
  if (!existsSync(dir)) throw new Error(`unknown project: ${id}`);
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
export { createProject, listProjects, projectDir, resolveProject };
