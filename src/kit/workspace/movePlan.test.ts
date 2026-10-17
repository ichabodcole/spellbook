// What a move would do, before it does it (kit-move-plan), and forgetting a
// document whose file is gone. The plan's one promise is checked against the
// move itself: for the same world, the links the plan says a move would break
// are exactly the links the move then finds broken, and the plan writes
// nothing. An app's verbs over these are tested with the app.
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { registerBundleType } from "../lib/bundles";
import type { LinkSlot } from "./linkEdges";
import { movedWorld, treeOrder } from "./movePlan";
import { SessionError, WorkspaceSession } from "./session";
import { TEST_BUNDLE, tempRoot, testApp } from "./testing";

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

/**
 * An app's slot, as a wiki app's is: a bare name lands on the FIRST document
 * of that stem the session hands over, so which one depends on the order the
 * documents come in; and a `related:` frontmatter edge.
 */
const wikiSlot: LinkSlot = {
  resolve: ({ target, documents }) =>
    target.includes("/")
      ? undefined
      : documents()
          .filter((d) => basename(d.path).replace(/\.[^.]+$/, "") === target)
          .map((d) => d.path),
  edges: ({ frontmatter }) =>
    typeof frontmatter?.related === "string"
      ? [{ kind: "related", target: frontmatter.related, key: "related" }]
      : [],
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

/** The plan, then the move: the plan's links and edges must be the move's. */
function planThenMove(path: string, into: string, s: WorkspaceSession = session()) {
  const before = snapshot();
  const plan = s.movePlan(path, into);
  expect(snapshot()).toEqual(before);
  const moved = s.move(path, into, { links: true });
  expect(plan.to).toBe(moved.path);
  expect(plan.links).toEqual(moved.links ?? []);
  expect(plan.wiki).toEqual(moved.wiki ?? []);
  expect(plan.edges).toEqual(moved.edges ?? []);
  return { plan, moved };
}

const withSlot = () => {
  const s = session();
  s.setLinkSlot(wikiSlot);
  return s;
};

describe("the order a set's scan lists documents in", () => {
  beforeAll(() => registerBundleType(TEST_BUNDLE));
  test("subfolders before files, each by name; a bundle among the files, its main file first", () => {
    const paths = [
      "z.md",
      "a.md",
      "b/x.md",
      "a/z/y.md",
      "a/b.md",
      "The well.boardbundle/board.board",
      "The well.boardbundle/notes/n.md",
    ];
    expect([...paths].sort(treeOrder)).toEqual([
      "a/z/y.md",
      "a/b.md",
      "b/x.md",
      "a.md",
      "The well.boardbundle/board.board",
      "The well.boardbundle/notes/n.md",
      "z.md",
    ]);
  });
});

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

  for (const link of ["[[keeper]]", "[k](keeper)"])
    test(`two documents of one name: the plan picks the one the move will pick (${link})`, () => {
      for (const d of ["b", "c", "d"]) mkdirSync(at(d));
      write("b/keeper.md", "# B's keeper\n");
      write("c/keeper.md", "# C's keeper\n");
      write("index.md", `# Index\n\n${link}\n`);
      const { plan } = planThenMove(at("b/keeper.md"), at("d"), withSlot());
      // Before the move the name lands on b's keeper, the first in the tree;
      // after it, c's comes before d's, so the name lands on c's: broken.
      const broke = [...plan.wiki.map((w) => w.line), ...plan.links.map((d) => d.fixes[0]?.line)];
      expect(broke).toEqual([3]);
    });

  test("a folder moved: a file the context does not show is looked for where it will be", () => {
    writeFileSync(at("places/data.csv"), "a,b\n");
    write("places/glade.md", "# Glade\n");
    write("index.md", "[data](./places/data.csv)\n");
    mkdirSync(at("lore"));
    const { plan } = planThenMove(at("places"), at("lore"));
    expect(plan.links.flatMap((d) => d.fixes.map((f) => f.to))).toEqual(["./lore/places/data.csv"]);
  });

  test("a bare name to a document moved up beside it is still found there, not where it was", () => {
    write("places/glade.md", "# Glade\n");
    write("places/other.md", "[g](glade.md)\n");
    const { plan } = planThenMove(at("places/glade.md"), set);
    expect(plan.links).toEqual([]);
  });

  test("a folder moved into the workspace becomes a set: links from its root are read from there", () => {
    // A workspace with a document of its own listed, whose root is the
    // workspace: the moved folder is no part of it, but a set of its own.
    writeFileSync(join(root, "solo.md"), "# Solo\n");
    write("places/glade.md", "# Glade\n");
    write("people/keeper.md", "[Glade](/places/glade.md) and [me](/keeper.md)\n");
    const s = session();
    s.addContext(join(root, "solo.md"));
    const { plan, moved } = planThenMove(at("people"), root, s);
    expect(s.context.some((e) => e.root === moved.path && e.membership === "mirrored")).toBe(true);
    expect(plan.links.flatMap((d) => d.fixes.map((f) => [f.from, f.to]))).toEqual([
      ["/places/glade.md", "../world/places/glade.md"],
    ]);
  });

  test("an app edge the move breaks is reported, counted and never rewritten", () => {
    write("a.md", "---\nrelated: ./b.md\n---\n# A\n");
    write("b.md", "# B\n");
    mkdirSync(at("sub"));
    const s = withSlot();
    const before = s.linkCheck().edges?.count;
    const { plan, moved } = planThenMove(at("b.md"), at("sub"), s);
    expect(plan.edges).toEqual([
      { kind: "related", source: at("a.md"), key: "related", raw: "./b.md" },
    ]);
    expect(moved.edges).toEqual(plan.edges);
    expect(plan.links).toEqual([]);
    expect(plan.checked).toBe(1);
    expect(readFileSync(at("a.md"), "utf8")).toContain("related: ./b.md");
    expect(s.linkCheck().edges?.count).toBe((before ?? 0) + 1);
  });

  test("an app edge written in the moved document, and one that still lands, each as the move finds it", () => {
    write("x.md", "# X\n");
    write("places/glade.md", "---\nrelated: ../x.md\n---\n# Glade\n");
    write("index.md", "---\nrelated: /places/glade.md\n---\n# Index\n");
    mkdirSync(at("places/deep"));
    const { plan } = planThenMove(at("places/glade.md"), at("places/deep"), withSlot());
    expect(plan.edges.map((e) => [e.source, e.raw])).toEqual([
      [at("places/deep/glade.md"), "../x.md"],
      [at("index.md"), "/places/glade.md"],
    ]);
    expect(plan.checked).toBe(2);
  });

  test("an app with no edges is told none, and the move's answer has no edges at all", () => {
    write("b.md", "# B\n");
    mkdirSync(at("sub"));
    const s = session();
    expect(s.movePlan(at("b.md"), at("sub")).edges).toEqual([]);
    expect("edges" in s.move(at("b.md"), at("sub"), { links: true })).toBe(false);
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

  test("the forgetting is kept: a session restored from disk no longer has the document", () => {
    write("solo.md", "# Solo\n");
    const s = session();
    const { slug } = s.openPath(at("solo.md"));
    rmSync(at("solo.md"));
    s.forgetDoc(slug);
    const back = WorkspaceSession.restore(join(root, "sessions"), testApp, s.id);
    expect(back.view().docs.map((d) => d.slug)).not.toContain(slug);
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
