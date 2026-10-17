// What a move would do, before it does it (kit-move-plan), and forgetting a
// document whose file is gone. The plan's one promise is checked against the
// move itself: for the same world, the links the plan says a move would break
// are exactly the links the move then finds broken, and the plan writes
// nothing. Scriptorium's verbs over these are in
// `src/scriptorium/backend/kit/wiki.integration.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { movedWorld } from "./movePlan";
import { SessionError, WorkspaceSession } from "./session";
import { tempRoot, testApp } from "./testing";

let root: string;
let set: string;

beforeEach(() => {
  root = tempRoot("workspace-move-plan");
  set = join(root, "world");
  mkdirSync(join(set, "places"), { recursive: true });
  mkdirSync(join(set, "people"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const at = (rel: string) => join(set, rel);
const write = (rel: string, text: string) => writeFileSync(at(rel), text);
const session = () => {
  const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
  s.addContext(set);
  return s;
};

/** Every file under the root, with its bytes and mtime: what "writes nothing" is checked against. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out[relative(root, p)] = `${st.mtimeMs}:${readFileSync(p, "utf8")}`;
    }
  };
  walk(root);
  return out;
}

const refusal = (f: () => unknown): SessionError => {
  try {
    f();
  } catch (e) {
    if (e instanceof SessionError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

/** The plan, then the move: the plan's links must be the move's. */
function planThenMove(path: string, into: string) {
  const s = session();
  const before = snapshot();
  const plan = s.movePlan(path, into);
  expect(snapshot()).toEqual(before);
  const moved = s.move(path, into, { links: true });
  expect(plan.to).toBe(moved.path);
  expect(plan.links).toEqual(moved.links ?? []);
  expect(plan.wiki).toEqual(moved.wiki ?? []);
  return { plan, moved };
}

describe("the world after a move", () => {
  test("forward maps the moved place and what is under it; back undoes it, and the old place is gone", () => {
    const w = movedWorld([[at("places"), at("lore/places")]]);
    expect(w.forward(at("places/glade.md"))).toBe(at("lore/places/glade.md"));
    expect(w.forward(at("placesX.md"))).toBe(at("placesX.md"));
    expect(w.back(at("lore/places/glade.md"))).toBe(at("places/glade.md"));
    expect(w.back(at("places/glade.md"))).toBeNull();
    expect(w.back(at("index.md"))).toBe(at("index.md"));
  });
});

describe("movePlan: the move's links, found before the move", () => {
  test("a document moved: links to it and its own links out, each with the move's rewrite", () => {
    write("places/glade.md", "# The Glade\n");
    write("keeper.md", "[the Glade](./places/glade.md) and [me](./keeper.md)\n");
    write("index.md", "[Keeper](keeper.md?rel=x#Top)\n");
    const { plan } = planThenMove(at("keeper.md"), at("people"));
    expect(plan).toMatchObject({
      from: at("keeper.md"),
      into: at("people"),
      name: "keeper.md",
      folder: false,
      docs: 1,
      references: 0,
    });
    const byDoc = Object.fromEntries(plan.links.map((d) => [d.path, d.fixes.map((f) => f.to)]));
    expect(byDoc).toEqual({
      [at("people/keeper.md")]: ["../places/glade.md"],
      [at("index.md")]: ["./people/keeper.md?rel=x#Top"],
    });
  });

  test("a folder moved: links into it are offered, links inside it are left alone", () => {
    write("places/glade.md", "[the Well](./well.md)\n");
    write("places/well.md", "# Well\n");
    write("index.md", "[Glade](./places/glade.md) ![map](places/map.png)\n");
    writeFileSync(at("places/map.png"), "png");
    mkdirSync(at("lore"));
    const { plan } = planThenMove(at("places"), at("lore"));
    expect(plan.folder).toBe(true);
    expect(plan.docs).toBe(2);
    expect(plan.links.map((d) => d.path)).toEqual([at("index.md")]);
  });

  test("a link from the root stays from the root, and is not offered when it still lands", () => {
    write("places/glade.md", "# Glade\n");
    write("people/keeper.md", "[Glade](/places/glade.md)\n");
    mkdirSync(at("people/old"));
    const { plan } = planThenMove(at("people/keeper.md"), at("people/old"));
    expect(plan.links).toEqual([]);
  });

  test("a wiki link written as a path is counted as broken, and never rewritten", () => {
    write("places/glade.md", "# Glade\n");
    write("index.md", "[[glade]] and [[places/glade]]\n");
    mkdirSync(at("lore"));
    const { plan } = planThenMove(at("places/glade.md"), at("lore"));
    expect(plan.wiki.map((w) => w.raw)).toEqual(["places/glade"]);
    // `[[glade]]` lands on nothing here (the kit resolves names by path; an
    // app resolver answers names), so only the path-written one is checked.
    expect(plan.checked).toBe(1);
  });

  test("an image moves with its description, and the plan says where the description goes", () => {
    writeFileSync(at("places/fox.png"), "png");
    write("places/fox.png.md", "---\ntype: image\n---\nA fox.\n");
    write("index.md", "![a fox](./places/fox.png)\n");
    const { plan } = planThenMove(at("places/fox.png"), at("people"));
    expect(plan.sidecar).toBe(at("people/fox.png.md"));
    expect(plan.links[0]?.fixes[0]).toMatchObject({ to: "./people/fox.png", embed: true });
  });

  test("a whole set moved into another: its root-written links follow it", () => {
    const other = join(root, "other");
    mkdirSync(other);
    write("places/glade.md", "# Glade\n");
    write("people/keeper.md", "[Glade](/places/glade.md) and [far](../../other/x.md)\n");
    writeFileSync(join(other, "x.md"), "# X\n");
    const s = session();
    s.addContext(other);
    const before = snapshot();
    const plan = s.movePlan(at("people"), other);
    expect(snapshot()).toEqual(before);
    const moved = s.move(at("people"), other, { links: true });
    expect(plan.links).toEqual(moved.links ?? []);
    // Its root went with it: the link from the old root is broken, the one
    // out of the set by a relative path still lands.
    expect(plan.links.flatMap((d) => d.fixes.map((f) => f.from))).toEqual(["/places/glade.md"]);
  });

  for (const order of ["the set moved first", "the set moved into first"] as const)
    test(`a whole set moved into another set: links from its root read as the move reads them (${order})`, () => {
      const other = join(root, "other");
      mkdirSync(other);
      writeFileSync(join(other, "x.md"), "[y](/y.md) and [glade](../world/places/glade.md)\n");
      writeFileSync(join(other, "y.md"), "# Y\n");
      write("places/glade.md", "# Glade\n");
      write("y.md", "# The world's Y\n");
      const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, root);
      if (order === "the set moved first") {
        s.addContext(other);
        s.addContext(set);
      } else {
        s.addContext(set);
        s.addContext(other);
      }
      const before = snapshot();
      const plan = s.movePlan(other, at("places"));
      expect(snapshot()).toEqual(before);
      const moved = s.move(other, at("places"), { links: true });
      expect(plan.links).toEqual(moved.links ?? []);
      expect(plan.wiki).toEqual(moved.wiki ?? []);
    });

  test("a whole set moved into the workspace keeps its entry: its root goes with it", () => {
    const ws = join(root, "ws");
    const other = join(root, "other");
    mkdirSync(ws);
    mkdirSync(join(other, "sub"), { recursive: true });
    writeFileSync(
      join(other, "sub", "x.md"),
      "[y](/y.md) and [far](../../world/places/glade.md)\n",
    );
    writeFileSync(join(other, "y.md"), "# Y\n");
    write("places/glade.md", "# Glade\n");
    const s = WorkspaceSession.create(join(root, "sessions"), testApp, undefined, ws);
    s.addContext(set);
    s.addContext(other);
    const before = snapshot();
    const plan = s.movePlan(other, ws);
    expect(snapshot()).toEqual(before);
    const moved = s.move(other, ws, { links: true });
    expect(plan.links).toEqual(moved.links ?? []);
    // `/y.md` still lands from the set's root, wherever it is; the relative
    // link out of the set does not.
    expect(plan.links.flatMap((d) => d.fixes.map((f) => f.from))).toEqual([
      "../../world/places/glade.md",
    ]);
  });

  test("it refuses exactly what a move refuses, with the same status", () => {
    write("places/glade.md", "# Glade\n");
    write("people/glade.md", "# Another\n");
    writeFileSync(join(root, "loose.md"), "# Loose\n");
    const s = session();
    const cases: [string, string][] = [
      [join(root, "loose.md"), at("people")], // not shown
      [at("places/glade.md"), join(root, "nowhere")], // no such folder
      [at("places/glade.md"), at("places")], // already there
      [at("places"), at("places")], // into itself
      [at("places/glade.md"), at("people")], // a file of that name is there
    ];
    for (const [path, into] of cases) {
      const planned = refusal(() => s.movePlan(path, into));
      const moved = refusal(() => s.move(path, into));
      expect([planned.status, planned.message]).toEqual([moved.status, moved.message]);
    }
    expect(existsSync(at("places/glade.md"))).toBe(true);
  });
});

describe("forgetDoc: the answer to a document whose file is gone", () => {
  test("forgets a document whose file is gone, and says how many versions go with it", () => {
    write("solo.md", "# Solo\n");
    const s = session();
    const { slug } = s.openPath(at("solo.md"));
    rmSync(at("solo.md"));
    const f = s.forgetDoc(slug);
    expect(f).toMatchObject({ slug, name: "solo.md", original: at("solo.md"), versions: 1 });
    expect(s.view().docs.map((d) => d.slug)).not.toContain(slug);
  });

  test("refused while the file exists: the record and its history stay", () => {
    write("solo.md", "# Solo\n");
    const s = session();
    const { slug } = s.openPath(at("solo.md"));
    const e = refusal(() => s.forgetDoc(slug));
    expect(e.status).toBe(409);
    expect(e.message).toContain("is still on disk");
    expect(s.view().docs.map((d) => d.slug)).toContain(slug);
  });

  test("the version files are left: nothing reads them, and nobody asked", () => {
    write("solo.md", "# Solo\n");
    const s = session();
    const { slug } = s.openPath(at("solo.md"));
    const v1 = s.doc(slug).versions[0]?.path as string;
    rmSync(at("solo.md"));
    s.forgetDoc(slug);
    expect(existsSync(v1)).toBe(true);
  });

  test("forgetting the open document leaves another open, not a dangling name", () => {
    write("sibling.md", "# Sibling\n");
    write("solo.md", "# Solo\n");
    const s = session();
    s.openPath(at("sibling.md"));
    const { slug } = s.openPath(at("solo.md"));
    expect(s.openDocSlug).toBe(slug);
    rmSync(at("solo.md"));
    s.forgetDoc(slug);
    const open = s.openDocSlug;
    expect(open).not.toBe(slug);
    expect(s.view().docs.some((d) => d.slug === open)).toBe(true);
  });

  test("an unknown document is a refusal", () => {
    const s = session();
    expect(refusal(() => s.forgetDoc("nothing-like-this")).message).toContain("no document");
  });

  test("the slug is free again: the next file of that name takes it", () => {
    write("solo.md", "# Solo\n");
    const s = session();
    const { slug } = s.openPath(at("solo.md"));
    rmSync(at("solo.md"));
    s.forgetDoc(slug);
    write("solo.md", "# Solo again\n");
    expect(s.openPath(at("solo.md")).slug).toBe(slug);
  });
});
