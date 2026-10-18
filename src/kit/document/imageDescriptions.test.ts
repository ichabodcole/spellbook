// An image's description, the pure parts: which file describes which image,
// what the viewer is told of it, the skeleton `describe-image` writes, how the
// tree and the list fold a sidecar into its image and count it, how the link
// picker matches an image by its description, and what the Delete dialog says.

import { describe, expect, test } from "bun:test";
import { countEntry, foldListedSidecars, foldSidecars, indexTree } from "../context/model.ts";
import { trashDialog } from "../context/trashDialog.ts";
import {
  askDescribeText,
  describeSidecar,
  imageOfSidecar,
  isSidecarName,
  sidecarOf,
  sidecarSkeleton,
  webPage,
} from "../lib/sidecar.ts";
import type { ContextEntry, ContextNode, LinkTarget } from "../workspace/protocol";
import { matchesDescription, rankTargets } from "./linkInsert.ts";

const doc = (rel: string): ContextNode => ({ kind: "doc", rel });
const sidecar = (rel: string): ContextNode => ({ kind: "doc", rel, sidecar: true });
const image = (rel: string): ContextNode => ({ kind: "image", rel });
const group = (rel: string, children: ContextNode[]): ContextNode => ({
  kind: "group",
  rel,
  children,
});

describe("names", () => {
  test("a sidecar is named for the whole image file", () => {
    expect(sidecarOf("images/fox.png")).toBe("images/fox.png.md");
    expect(imageOfSidecar("images/fox.png.md")).toBe("images/fox.png");
    expect(imageOfSidecar("/w/a/Photo.JPEG.md")).toBe("/w/a/Photo.JPEG");
    expect(isSidecarName("fox.md")).toBe(false);
    expect(imageOfSidecar("fox.md")).toBeNull();
    expect(imageOfSidecar("fox.svg.md")).toBeNull();
    expect(imageOfSidecar("fox.png.markdown")).toBeNull();
  });
});

describe("what the viewer is told", () => {
  test("a web image: its fields in the table's order, its page, and an unknown licence", () => {
    const d = describeSidecar(
      "/w/fox.png.md",
      {
        source: "web",
        title: "Fox",
        licence: "unknown",
        credit: "A. P.",
        url: "https://example.org/fox",
        stray: "not shown",
      },
      "\n\nA fox.\n",
    );
    expect(d.provenance).toEqual([
      { field: "url", value: "https://example.org/fox" },
      { field: "credit", value: "A. P." },
      { field: "licence", value: "unknown" },
    ]);
    expect(d.page).toBe("https://example.org/fox");
    expect(d.licenceUnknown).toBe(true);
    expect(d.body).toBe("A fox.");
  });

  test("a missing licence is unknown too; a known one is not amber", () => {
    expect(describeSidecar("/p", { source: "web" }, "").licenceUnknown).toBe(true);
    expect(describeSidecar("/p", { source: "web", licence: "CC BY 4.0" }, "").licenceUnknown).toBe(
      undefined,
    );
    // Only a web image has a licence to know.
    expect(describeSidecar("/p", { source: "user" }, "").licenceUnknown).toBeUndefined();
  });

  test("the globe opens only an http or https page", () => {
    expect(webPage("javascript:alert(1)")).toBeNull();
    expect(webPage("java\tscript:alert(1)")).toBeNull();
    expect(webPage("data:text/html,x")).toBeNull();
    expect(webPage("//example.org")).toBeNull();
    expect(webPage("https://example.org/a b")).toBe("https://example.org/ab");
    const d = describeSidecar("/p", { source: "web", url: "javascript:alert(1)" }, "");
    expect(d.page).toBeUndefined();
  });

  test("a generated image's lists and numbers read as text; an unknown origin is said", () => {
    const d = describeSidecar(
      "/p",
      { source: "generated", seed: 42, "cost-usd": 0.03, refs: ["a.png", "b.png"] },
      "",
    );
    expect(d.provenance).toEqual([
      { field: "seed", value: "42" },
      { field: "refs", value: "a.png, b.png" },
      { field: "cost-usd", value: "0.03" },
    ]);
    const odd = describeSidecar("/p", { source: "dream" }, "");
    expect(odd.source).toBeNull();
    expect(odd.sourceWritten).toBe("dream");
    expect(odd.provenance).toEqual([]);
  });

  test("a long body is cut, and says there is more", () => {
    const d = describeSidecar("/p", null, "word ".repeat(400));
    expect(d.more).toBe(true);
    expect(d.body.endsWith("…")).toBe(true);
    expect(d.title).toBeNull();
  });
});

describe("the skeleton", () => {
  test("names the type, the origin and its fields; a web licence starts unknown", () => {
    const at = new Date("2026-10-04T12:00:00Z");
    expect(sidecarSkeleton("fox-before_the-arch.png", "user", at)).toBe(
      [
        "---",
        "type: image",
        'title: "fox before the arch"',
        'description: ""',
        "source: user",
        'original-name: "fox-before_the-arch.png"',
        'added-at: "2026-10-04"',
        "---",
        "",
        "",
      ].join("\n"),
    );
    const w = sidecarSkeleton("fox.png", "web", at);
    expect(w).toContain('licence: "unknown"\n');
    expect(w).toContain('url: ""\n');
    const g = sidecarSkeleton("fox.png", "generated", at);
    for (const f of ["provider", "model", "prompt", "seed", "made-from", "job", "cost-usd"])
      expect(g).toContain(`${f}: ""\n`);
  });

  test("the ask names the image and where its description goes", () => {
    expect(askDescribeText("~/world/fox.png", "fox.png")).toBe(
      "Please describe ~/world/fox.png: look at the image and write what it shows in its description, fox.png.md.",
    );
  });
});

describe("folding in the tree, and the counts", () => {
  const nodes = [
    doc("story.md"),
    image("fox.png"),
    sidecar("fox.png.md"),
    doc("ghost.png.md"),
    group("g", [image("g/a.jpg"), sidecar("g/a.jpg.md"), doc("g/b.jpg.md")]),
    // Named like a sidecar, but not one (its type is not image): kept.
    image("loc.png"),
    doc("loc.png.md"),
  ];

  test("a sidecar beside its image has no row; an orphan keeps one", () => {
    const { nodes: folded, sidecars } = foldSidecars(nodes);
    expect(folded.map((n) => n.rel)).toEqual([
      "story.md",
      "fox.png",
      "ghost.png.md",
      "g",
      "loc.png",
      "loc.png.md",
    ]);
    expect(sidecars).toEqual(
      new Map([
        ["fox.png", "fox.png.md"],
        ["g/a.jpg", "g/a.jpg.md"],
      ]),
    );
    const idx = indexTree(nodes);
    expect(idx.byId.has("fox.png.md")).toBe(false);
    expect(idx.children.get("g")).toEqual(["g/a.jpg", "g/b.jpg.md"]);
    expect(idx.imageOf.get("g/a.jpg.md")).toBe("g/a.jpg");
  });

  test("a folded sidecar is no document in the counts; an orphan is one", () => {
    expect(countEntry(nodes)).toEqual({ docs: 4, images: 3 });
  });

  test("a sidecar in another folder than its image does not fold", () => {
    expect(foldSidecars([image("a.png"), group("x", [sidecar("x/a.png.md")])]).sidecars.size).toBe(
      0,
    );
  });

  test("a loose image's listed sidecar folds into the image's row", () => {
    const entry = (id: string, root: string, n: ContextNode): ContextEntry => ({
      id,
      label: n.rel,
      root,
      membership: "listed",
      nodes: [n],
    });
    const img = entry("i", "/w", image("moth.jpg"));
    const md = entry("m", "/w", sidecar("moth.jpg.md"));
    const elsewhere = entry("o", "/other", sidecar("moth.jpg.md"));
    const { entries, described } = foldListedSidecars([img, md, elsewhere]);
    expect(entries.map((e) => e.id)).toEqual(["i", "o"]);
    expect(described.get("i")?.id).toBe("m");
  });
});

describe("the link picker", () => {
  const t = (name: string, description?: string): LinkTarget => ({
    path: `/w/${name}`,
    name,
    href: name,
    shown: name,
    ...(description ? { image: true as const, description } : {}),
  });

  test("an image matches by its description, below every name match", () => {
    const targets = [
      t("fox.png", "The fox before the archway: a fox at the forest's edge."),
      t("archway.md"),
      t("plain.png"),
    ];
    expect(rankTargets(targets, "arch").map((x) => x.name)).toEqual(["archway.md", "fox.png"]);
    expect(rankTargets(targets, "forest fox").map((x) => x.name)).toEqual(["fox.png"]);
    expect(rankTargets(targets, "lighthouse")).toEqual([]);
  });

  test("description matching is by words, not scattered letters", () => {
    expect(matchesDescription("The fox before the archway", "fx")).toBe(false);
    expect(matchesDescription("The fox before the archway", "ARCH fox")).toBe(true);
    expect(matchesDescription(undefined, "fox")).toBe(false);
  });
});

test("the Delete dialog says an image's description goes with it", () => {
  const d = trashDialog({
    path: "/w/fox.png",
    shown: "world/fox.png",
    dir: false,
    files: 2,
    folders: 0,
    docs: [],
    sidecar: "/w/fox.png.md",
  });
  expect(d.message).toBe(
    "world/fox.png and its description, fox.png.md, go to the Trash. You can put them back from there.",
  );
});
