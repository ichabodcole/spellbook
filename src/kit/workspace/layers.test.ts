// What stayed behind. The wiki layer of the editor this was ported from (links,
// frontmatter, the map, move plans, the workspace and hide model) is
// absent, not dormant: a file or an export that names it fails here.
//
// Two pieces of that layer were admitted, each by name and each kept and tested
// below, reaching the world through the daemon, not the barrel:
//
// - search (the kit-search item), also through the CLI;
// - links (the kit-follow-links item), because Atlas needs them: a world is held
//   together by its links. Resolving and following came first (`links.ts` and
//   the surface's `link.open`), then writing (kit-link-insert), then reading
//   (kit-link-relations-backlinks: extraction and backlinks, through the
//   daemon's `link.backlinks` and the `backlinks` verb), then the check
//   (kit-link-check: dangling links and shared file names, through the daemon's
//   `link.check` and the `link-check` verb), then the graph (kit-link-graph:
//   `linkGraph`, the documents and typed links as data, through the daemon's
//   `link.graph` and the `graph` verb). Drawing it, the map, is an app's and
//   stays excluded, as do move plans.
// - profiles (the kit-document-profiles item): a world's
//   `_meta/profiles/<kind>.json` files, the nearest per kind, and the warnings
//   a document's frontmatter gets against its kind, through the daemon and the
//   `profiles`, `profile` and `profile-check` verbs, and to the surface's
//   frontmatter header through the daemon's `profile` (the
//   kit-header-from-profiles item). The frontmatter itself is
//   read by the session, in the link cache's read; no frontmatter module comes
//   back.
// - relations (the kit-picker-relation-meanings item): a world's
//   `_meta/profiles/_relations.json`, the nearest file per relation, read for
//   the link picker's meanings, backlinks' inverses and the `relations` verb.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_EXTENSIONS } from "../lib/docFormat.ts";
import * as workspace from "./index";
import * as links from "./links";
import * as profiles from "./profiles";
import * as relations from "./relations";

const here = dirname(fileURLToPath(import.meta.url));

test("the modules the resolution leaves out are not in the folder", () => {
  const files = readdirSync(here);
  for (const gone of ["frontmatter", "map", "graph", "move-plan", "workspace"])
    expect(
      files.filter((f) => f.startsWith(`${gone}.`)),
      gone,
    ).toEqual([]);
});

/**
 * Files anywhere in the kit whose names may say "graph": the link graph's own
 * tests. The graph's code lives in `links.ts`, admitted by export name below;
 * no file may be named for a map at all.
 */
/** The words that name the graph's drawing or the graph itself. */
const GRAPH_WORDS = ["graph", "map"];

/**
 * Whether a name says one of `words` as a WORD, singular or plural: split at
 * dots, dashes, underscores and camelCase humps, so `linkMap`, `graph-view` and
 * `links.graph.test` say it and `keymap`, `bitmap`, `paragraphs`, `paragraphOf`
 * and `remapSelection` do not.
 */
function namesA(name: string, words: readonly string[]): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase().replace(/s$/, ""))
    .some((w) => words.includes(w));
}

const ADMITTED_GRAPH_FILES = [
  "workspace/link-graph.cost.test.ts",
  "workspace/links.graph.session.test.ts",
  "workspace/links.graph.test.ts",
];

test("no file in the kit is named for a graph or a map, but the graph's admitted tests", () => {
  const src = dirname(here);
  const named = readdirSync(src, { recursive: true })
    .map(String)
    .filter((f) => !f.includes("node_modules") && namesA(basename(f), GRAPH_WORDS))
    .sort();
  expect(named).toEqual(ADMITTED_GRAPH_FILES);
});

// The document pane arrives with its own port (a later cycle); until then there
// is nothing here to read, and the test waits for it rather than passing empty.
const DOCUMENT_DIR = join(dirname(here), "document");
test.skipIf(!existsSync(DOCUMENT_DIR))(
  "the document pane exports no map, and no graph view of its own",
  () => {
    // "Linked from" offers an app's action (`linkedFromAction`); drawing the
    // links as a graph is the app's (a map an app draws), not the kit's. Read
    // from the source, not imported: the workspace may not import the document
    // subpath.
    const dir = DOCUMENT_DIR;
    const named: string[] = [];
    for (const f of readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !f.includes(".test.")))
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(
        /export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+(\w+)|export\s+(?:type\s+)?\{([^}]*)\}/g,
      ))
        named.push(
          ...(m[1]
            ? [m[1]]
            : (m[2] ?? "").split(",").map(
                (s) =>
                  s
                    .trim()
                    .split(/\s+as\s+/)
                    .pop() ?? "",
              )),
        );
    expect(named.length).toBeGreaterThan(20);
    expect(
      named.filter((n) => namesA(n, [...GRAPH_WORDS, "neighbourhood", "neighborhood", "ring"])),
    ).toEqual([]);
  },
);

test("the modules the plan names are all here, each with its tests where it has logic", () => {
  const files = readdirSync(here);
  for (const kept of [
    "session",
    "tree",
    "protocol",
    "history",
    "diff",
    "selection",
    "waiting",
    "picker",
    "doctor",
    "heartbeat",
    "search",
    "links",
    "profiles",
    "relations",
  ])
    expect(files, kept).toContain(`${kept}.ts`);
  for (const tested of [
    "session",
    "tree",
    "history",
    "diff",
    "selection",
    "waiting",
    "picker",
    "doctor",
    "heartbeat",
    "search",
    "links",
    "profiles",
    "relations",
  ])
    expect(files, `${tested} tests`).toContain(`${tested}.test.ts`);
});

test("nothing exported belongs to the wiki layer", () => {
  const names = Object.keys(workspace);
  for (const gone of [
    /link/i, // admitted links are reached through the daemon's `link.open`, like search
    /frontmatter/i,
    /search/i, // the module is reached through the daemon, not exported from the barrel
    /graph/i,
    /backlink/i,
    /profile/i, // reached through the daemon, like links and search
    /movePlan/i,
    /hide/i,
    /setWorkspace/i,
    /makeSet/i,
  ])
    expect(
      names.filter((n) => gone.test(n)),
      String(gone),
    ).toEqual([]);
});

test("the links module holds resolving, following, writing, backlinks, the check and the graph's data, and nothing of the map", () => {
  // kit-link-insert added the writing half: the relative target, and the
  // relation vocabulary (`parseRel`, `collectRelations`).
  // kit-link-relations-backlinks added the reading half: `extractLinks` and
  // `backlinksTo`. kit-link-check added the check: `danglingLinks` and
  // `duplicateNames`. kit-link-graph added `linkGraph`. kit-rename-updates-references
  // added `retarget` and `swapLinkTargets`. sound-stage-stage-bundle added
  // `rebaseCopy`, a copy's links rewritten to keep resolving. kit-link-edges-slot
  // added `landingName`, the name sift its app edges share with backlinks. Widen
  // this by name, as each item did.
  expect(Object.keys(links).sort()).toEqual([
    "backlinksTo",
    "collectRelations",
    "danglingLinks",
    "decodePath",
    "duplicateNames",
    "encodeLinkSegment",
    "extractLinks",
    "landingName",
    "linkGraph",
    "parseRel",
    "rebaseCopy",
    "relativeHref",
    "resolveTarget",
    "retarget",
    "splitTarget",
    "swapLinkTargets",
  ]);
  // Named, so widening the list above by accident still fails here. `dangling`
  // left this list with kit-link-check, which admitted `danglingLinks` by name;
  // `graph` left it with kit-link-graph, which admitted `linkGraph` and nothing
  // else of that name. The map stays an app's.
  expect(Object.keys(links).filter((n) => /graph/i.test(n))).toEqual(["linkGraph"]);
  for (const gone of [/map/i, /move/i])
    expect(
      Object.keys(links).filter((n) => gone.test(n)),
      String(gone),
    ).toEqual([]);
});

test("no barrel re-exports a value of the links, profiles or relations modules, under any name", async () => {
  // By identity, not by name: a name check let `checkFields` through, and an
  // export renamed on the way out would pass one too.
  const src = dirname(here);
  // Spellbook's kit has fewer barrels than the kit this came from: its spells
  // import modules by path. Every barrel that exists is checked, and the
  // workspace's own is one of them.
  const barrels = [
    "index.ts",
    "wire/index.ts",
    "cli/index.ts",
    "workspace/index.ts",
    "lib/index.ts",
  ].filter((b) => existsSync(join(src, b)));
  expect(barrels).toContain("workspace/index.ts");
  const guarded = new Set<unknown>(
    [...Object.values(links), ...Object.values(profiles), ...Object.values(relations)].filter(
      (v) => typeof v === "function" || (typeof v === "object" && v !== null),
    ),
  );
  expect(guarded.size).toBeGreaterThan(10);
  for (const b of barrels) {
    const mod = (await import(join(src, b))) as Record<string, unknown>;
    const leaked = Object.entries(mod)
      .filter(([, v]) => guarded.has(v))
      .map(([k]) => k);
    expect(leaked, b).toEqual([]);
  }
});

test("the profiles module reads profile files and checks frontmatter, and writes nothing", () => {
  // kit-document-profiles admitted it. Widen this by name, as the links items did.
  expect(Object.keys(profiles).sort()).toEqual([
    "NO_MATCH",
    "PROFILES_DIR",
    "ProfileLookup",
    "ProfileReader",
    "REF_DEPTH_MAX",
    "VALUE_SHOWN_MAX",
    "checkFields",
    "fixFor",
    "kindOfFile",
    "parseProfile",
    "profileFolders",
    "sameJson",
  ]);
  const source = readFileSync(join(here, "profiles.ts"), "utf8");
  expect(source).not.toMatch(/\b(writeFileSync|renameSync|unlinkSync|rmSync|mkdirSync)\b/);
});

test("the relations module reads a world's relation vocabulary, and writes nothing", () => {
  // kit-picker-relation-meanings admitted it, beside profiles and not inside
  // them: `_meta/profiles/_relations.json` is not a kind; kit-link-check-symmetry
  // added `oneWaySymmetric`, the link check's hint. Widen this by name.
  expect(Object.keys(relations).sort()).toEqual([
    "NO_VOCABULARY",
    "RELATIONS_FILE",
    "RelationsLookup",
    "RelationsReader",
    "oneWaySymmetric",
    "parseRelations",
    "readsBack",
    "relationOffers",
  ]);
  const source = readFileSync(join(here, "relations.ts"), "utf8");
  expect(source).not.toMatch(/\b(writeFileSync|renameSync|unlinkSync|rmSync|mkdirSync)\b/);
});

test("the document types admitted are prose, and JSON edited raw (kit-json-documents)", () => {
  expect([...workspace.DOC_EXTENSIONS]).toEqual([".md", ".markdown", ".txt", ".json"]);
});

test("images are a kind of their own, never a document, and the images module reads no text (kit-image-files)", () => {
  expect([...IMAGE_EXTENSIONS]).toEqual([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
  for (const ext of IMAGE_EXTENSIONS) expect(workspace.isDocName(`fox${ext}`)).toBe(false);
  // Its bytes leave through Bun.file and come in as bytes; nothing decodes them as text.
  const source = readFileSync(join(here, "images.ts"), "utf8");
  expect(source).not.toMatch(/readFileSync|["']utf-?8["']|\.text\(\)|TextDecoder/);
  // SVG and HEIC are never shown as they are.
  expect(IMAGE_EXTENSIONS.some((e) => /svg|heic|heif/.test(e))).toBe(false);
});
