// P1 — project lifecycle: dumb by design (a project is a directory name + a
// store.sqlite + a docs/ subfolder).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, listProjects, resolveProject } from "./project.ts";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "mind-mapper-project-test-"));
}

test("resolveProject with no id returns the default project, creating it", () => {
  const home = tempHome();
  try {
    const p = resolveProject(home);
    expect(p.id).toBe("default");
    expect(existsSync(join(home, "projects", "default", "docs"))).toBe(true);
    expect(existsSync(join(home, "projects", "default", "store.sqlite"))).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveProject with an id resolves that project without creating a new one", () => {
  const home = tempHome();
  try {
    createProject(home, "hollowbrook", "Hollowbrook");
    const p = resolveProject(home, "hollowbrook");
    expect(p.id).toBe("hollowbrook");
    expect(p.title).toBe("Hollowbrook");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveProject with an unknown id throws rather than silently creating one", () => {
  const home = tempHome();
  try {
    expect(() => resolveProject(home, "nope")).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listProjects lists every project directory with a title", () => {
  const home = tempHome();
  try {
    createProject(home, "hollowbrook", "Hollowbrook");
    createProject(home, "second-idea", "Second Idea");
    const projects = listProjects(home);
    expect(projects.map((p) => p.id).sort()).toEqual(["hollowbrook", "second-idea"]);
    expect(projects.find((p) => p.id === "hollowbrook")?.title).toBe("Hollowbrook");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("createProject rejects a duplicate id", () => {
  const home = tempHome();
  try {
    createProject(home, "hollowbrook", "Hollowbrook");
    expect(() => createProject(home, "hollowbrook", "Again")).toThrow();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
