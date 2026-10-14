// The relation vocabulary read from `_meta/profiles/_relations.json`: the
// format, a broken file said with its line and column, the reader's cache by
// stamp, the nearest file winning per relation, up to the entry's root, and
// the symmetric relations written one way.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRel } from "../lib/linkTarget";
import {
  NO_VOCABULARY,
  oneWaySymmetric,
  parseRelations,
  RELATIONS_FILE,
  RelationsReader,
  readsBack,
  relationOffers,
} from "./relations";
import { tempRoot } from "./testing";

/** The Dreamwood vocabulary, cut to three: one way with an inverse, symmetric, one way without. */
const DREAMWOOD = {
  $comment: "The relations the Bible's links may carry as ?rel=.",
  relations: {
    "grounded-in": {
      label: "grounded in",
      inverse: "grounds",
      means: "This document rests on the target's canon.",
      symmetric: false,
    },
    "contrasts-with": {
      label: "contrasts with",
      means: "This document is defined against the target.",
      symmetric: true,
    },
    "sourced-from": { label: "sourced from" },
  },
};

describe("parseRelations", () => {
  test("reads each relation in file order, with its words, ignoring keys it does not know", () => {
    const r = parseRelations(JSON.stringify({ ...DREAMWOOD, extra: 1 }), "/w/_relations.json");
    expect(r).toEqual({
      relations: [
        {
          rel: "grounded-in",
          label: "grounded in",
          means: "This document rests on the target's canon.",
          symmetric: false,
          inverse: "grounds",
          source: "/w/_relations.json",
        },
        {
          rel: "contrasts-with",
          label: "contrasts with",
          means: "This document is defined against the target.",
          symmetric: true,
          source: "/w/_relations.json",
        },
        {
          rel: "sourced-from",
          label: "sourced from",
          symmetric: false,
          source: "/w/_relations.json",
        },
      ],
    });
  });

  test("a relation may carry a colour: a JSON Canvas preset or a hex, as written", () => {
    const r = parseRelations(
      JSON.stringify({
        relations: {
          "sourced-from": { label: "sourced from", color: "#C0457A" },
          applies: { color: "4" },
          extends: { color: "#abc" },
        },
      }),
    );
    expect(r).toEqual({
      relations: [
        {
          rel: "sourced-from",
          label: "sourced from",
          symmetric: false,
          color: "#C0457A",
          source: "",
        },
        { rel: "applies", label: "applies", symmetric: false, color: "4", source: "" },
        { rel: "extends", label: "extends", symmetric: false, color: "#abc", source: "" },
      ],
    });
  });

  test("a relation with no label reads as its name", () => {
    const r = parseRelations('{"relations": {"extends": {}}}');
    expect(r).toEqual({
      relations: [{ rel: "extends", label: "extends", symmetric: false, source: "" }],
    });
  });

  test("a relation's name is case-folded, as `?rel=` reads it; its default label keeps the file's case", () => {
    const r = parseRelations(
      '{"relations": {"Extends": {}, "Grounded-In": {"label": "grounded in"}}}',
    );
    if (!("relations" in r)) throw new Error("broken");
    expect(r.relations.map((d) => [d.rel, d.label])).toEqual([
      ["extends", "Extends"],
      ["grounded-in", "grounded in"],
    ]);
  });

  test("a non-ASCII key folds as `?rel=` does, so a link written with it matches it", () => {
    const r = parseRelations('{"relations": {"İlgili": {}, "Über": {}, "Αναφέρεται": {}}}');
    if (!("relations" in r)) throw new Error("broken");
    expect(r.relations.map((d) => d.rel)).toEqual([
      ...parseRel("rel=İlgili"),
      ...parseRel("rel=Über"),
      ...parseRel("rel=Αναφέρεται"),
    ]);
    expect(r.relations.map((d) => d.label)).toEqual(["İlgili", "Über", "Αναφέρεται"]);
  });

  test("two keys that fold to one relation: the first stands, the later one is a warning", () => {
    const r = parseRelations(
      '{"relations": {"extends": {"label": "a"}, "Extends": {"label": "b"}}}',
    );
    if (!("relations" in r)) throw new Error("broken");
    expect(r.relations.map((d) => [d.rel, d.label])).toEqual([["extends", "a"]]);
    expect(r.warnings).toEqual([
      'relations.Extends is relations.extends again in another case (a relation is read case-insensitively, as "extends"); relations.extends stands and this one is ignored',
    ]);
    expect(r.folded).toEqual([{ key: "Extends", earlier: "extends" }]);
  });

  test("a file that does not parse is broken, with the line and column", () => {
    const r = parseRelations('{\n  "relations": {\n    "a": { "label": "x", }\n  }\n}');
    expect(r).toEqual({
      broken:
        'does not parse as JSON: line 3, column 24: a comma before "}" is not allowed in JSON',
    });
  });

  test.each([
    ["[]", "is not a JSON object"],
    ["{}", `has no "relations"; it should hold "relations": { "<name>": { … } }`],
    ['{"relations": []}', `"relations" must be an object`],
    ['{"relations": {"a": "b"}}', "relations.a must be an object"],
    ['{"relations": {"a": {"label": 3}}}', "relations.a.label must be a string"],
    ['{"relations": {"a": {"means": false}}}', "relations.a.means must be a string"],
    ['{"relations": {"a": {"symmetric": "yes"}}}', "relations.a.symmetric must be true or false"],
    [
      '{"relations": {"a": {"symmetric": true, "inverse": "b"}}}',
      'relations.a is symmetric and has an inverse; a symmetric relation reads the same from both ends, so drop "inverse"',
    ],
    ['{"relations": {"a": {"color": 4}}}', "relations.a.color must be a string"],
    [
      '{"relations": {"a": {"color": "green"}}}',
      'relations.a.color must be a colour: a preset "1" to "6", or a hex such as "#3b6fd8"',
    ],
    [
      '{"relations": {"a": {"color": "7"}}}',
      'relations.a.color must be a colour: a preset "1" to "6", or a hex such as "#3b6fd8"',
    ],
    [
      '{"relations": {"sourced from": {}}}',
      '"sourced from" cannot be written in ?rel=: a relation starts with a letter or a digit and holds only letters, digits, combining marks (after the first character), _, . and -',
    ],
    [
      // A combining mark carries the character before it, so it cannot come first.
      '{"relations": {"\u0301a": {}}}',
      '"\u0301a" cannot be written in ?rel=: a relation starts with a letter or a digit and holds only letters, digits, combining marks (after the first character), _, . and -',
    ],
  ])("%s is broken: %s", (text, why) => {
    expect(parseRelations(text)).toEqual({ broken: why });
  });
});

test("readsBack: the inverse, else a symmetric relation's own label, else nothing", () => {
  expect(readsBack({ label: "grounded in", symmetric: false, inverse: "grounds" })).toBe("grounds");
  expect(readsBack({ label: "contrasts with", symmetric: true })).toBe("contrasts with");
  expect(readsBack({ label: "sourced from", symmetric: false })).toBeUndefined();
});

describe("relationOffers", () => {
  const vocab = () => {
    const r = parseRelations(JSON.stringify(DREAMWOOD), "/w/x");
    if ("broken" in r) throw new Error(r.broken);
    return { relations: new Map(r.relations.map((d) => [d.rel, d])), any: true };
  };

  test("declared relations carry their words, used ones their counts, and both are offered", () => {
    const offers = relationOffers(
      new Map([
        ["applies", 11],
        ["contrasts-with", 6],
        ["sourced_from", 1],
      ]),
      vocab(),
    );
    expect(offers.map((o) => [o.rel, o.count, o.declared])).toEqual([
      ["applies", 11, false],
      ["contrasts-with", 6, true],
      ["sourced_from", 1, false],
      // Declared but unused: offered, after the used ones, by name.
      ["grounded-in", 0, true],
      ["sourced-from", 0, true],
    ]);
    expect(offers.find((o) => o.rel === "contrasts-with")).toEqual({
      rel: "contrasts-with",
      count: 6,
      declared: true,
      label: "contrasts with",
      means: "This document is defined against the target.",
      symmetric: true,
    });
    expect(offers.find((o) => o.rel === "grounded-in")?.inverse).toBe("grounds");
  });

  test("a relation declared in one case and used in another is offered once", () => {
    const r = parseRelations('{"relations": {"Extends": {"label": "extends"}}}');
    if (!("relations" in r)) throw new Error("broken");
    const offers = relationOffers(new Map([["extends", 3]]), {
      relations: new Map(r.relations.map((d) => [d.rel, d])),
      any: true,
    });
    expect(offers.map((o) => [o.rel, o.count, o.declared])).toEqual([["extends", 3, true]]);
  });

  test("with no vocabulary, exactly the relations in use, most used first", () => {
    expect(
      relationOffers(
        new Map([
          ["b", 2],
          ["a", 2],
          ["c", 5],
        ]),
        NO_VOCABULARY,
      ),
    ).toEqual([
      { rel: "c", count: 5, declared: false },
      { rel: "a", count: 2, declared: false },
      { rel: "b", count: 2, declared: false },
    ]);
  });
});

describe("RelationsReader", () => {
  let root: string;
  const write = (dir: string, body: unknown) => {
    mkdirSync(join(dir, "_meta", "profiles"), { recursive: true });
    writeFileSync(
      join(dir, "_meta", "profiles", RELATIONS_FILE),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  };
  const names = (m: ReadonlyMap<string, { source: string }>) =>
    Object.fromEntries([...m].map(([k, v]) => [k, v.source.slice(root.length)]));

  beforeEach(() => {
    root = tempRoot("relations");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("the nearest file wins per relation, relations defined only above still apply, and nothing above the root is read", () => {
    const world = join(root, "world");
    write(root, { relations: { outside: {} } });
    write(world, DREAMWOOD);
    write(join(world, "locations"), {
      relations: { "contrasts-with": { label: "stands against", symmetric: true }, "near-to": {} },
    });
    mkdirSync(join(world, "locations", "deep"), { recursive: true });
    const look = new RelationsReader().pass();
    const deep = look.at(join(world, "locations", "deep"), world);
    expect(deep.any).toBe(true);
    expect(names(deep.relations)).toEqual({
      "contrasts-with": "/world/locations/_meta/profiles/_relations.json",
      "near-to": "/world/locations/_meta/profiles/_relations.json",
      "grounded-in": "/world/_meta/profiles/_relations.json",
      "sourced-from": "/world/_meta/profiles/_relations.json",
    });
    expect(deep.relations.get("contrasts-with")?.label).toBe("stands against");
    // The world's root sees its own file only, never the one above it.
    expect(Object.keys(names(look.at(world, world).relations)).sort()).toEqual([
      "contrasts-with",
      "grounded-in",
      "sourced-from",
    ]);
    expect(look.files().map((f) => f.path.slice(root.length))).toEqual([
      "/world/_meta/profiles/_relations.json",
      "/world/locations/_meta/profiles/_relations.json",
    ]);
  });

  test("a broken nearer file defines nothing, the file above still applies, and the broken one is listed with why", () => {
    const world = join(root, "world");
    write(world, DREAMWOOD);
    write(join(world, "locations"), '{"relations": {"contrasts-with": {"symmetric": "yes"}}}');
    const look = new RelationsReader().pass();
    const v = look.at(join(world, "locations"), world);
    expect(v.relations.get("contrasts-with")?.label).toBe("contrasts with");
    expect(look.files().map((f) => ("broken" in f.read ? f.read.broken : "ok"))).toEqual([
      "ok",
      "relations.contrasts-with.symmetric must be true or false",
    ]);
  });

  test("a world with no file has no vocabulary; `_Meta` is not `_meta`", () => {
    const world = join(root, "world");
    mkdirSync(join(world, "_Meta", "profiles"), { recursive: true });
    writeFileSync(join(world, "_Meta", "profiles", RELATIONS_FILE), JSON.stringify(DREAMWOOD));
    const v = new RelationsReader().pass().at(world, world);
    expect(v).toBe(NO_VOCABULARY);
    expect(v.any).toBe(false);
  });

  test("a file is parsed once, and again only when it changes", () => {
    const world = join(root, "world");
    mkdirSync(join(world, "a", "b"), { recursive: true });
    write(world, DREAMWOOD);
    const reader = new RelationsReader();
    for (let i = 0; i < 3; i++) {
      const look = reader.pass();
      look.at(world, world);
      look.at(join(world, "a"), world);
      look.at(join(world, "a", "b"), world);
    }
    expect(reader.parsed).toBe(1);
    write(world, { relations: { only: {} } });
    expect([...reader.pass().at(join(world, "a"), world).relations.keys()]).toEqual(["only"]);
    expect(reader.parsed).toBe(2);
  });

  test("⛔ an edit that keeps the size and puts the mtime back is still read", () => {
    const world = join(root, "world");
    const file = join(world, "_meta", "profiles", RELATIONS_FILE);
    write(world, { relations: { aaaaa: {} } });
    const then = new Date("2026-01-02T03:04:05Z");
    utimesSync(file, then, then);
    const before = statSync(file);
    const reader = new RelationsReader();
    expect([...reader.pass().at(world, world).relations.keys()]).toEqual(["aaaaa"]);
    write(world, { relations: { bbbbb: {} } });
    utimesSync(file, before.atime, before.mtime);
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect([...reader.pass().at(world, world).relations.keys()]).toEqual(["bbbbb"]);
  });
});

describe("oneWaySymmetric", () => {
  const e = (from: string, to: string, rel: string, link = 0) => ({ from, to, rel, link });
  const symmetric = (_from: string, rel: string) => rel === "contrasts-with" || rel === "sister-of";
  const hints = (edges: ReturnType<typeof e>[]) =>
    oneWaySymmetric(edges, symmetric).map((h) => `${h.from}>${h.to} ${h.rel} #${h.link}`);

  test("a symmetric relation written one way is a hint; written both ways it is not", () => {
    expect(
      hints([
        e("ruin", "cave", "contrasts-with"),
        e("cave", "ruin", "contrasts-with"),
        e("ruin", "glade", "contrasts-with"),
      ]),
    ).toEqual(["ruin>glade contrasts-with #0"]);
  });

  test("the link back must carry the same relation", () => {
    expect(hints([e("08", "02", "sister-of"), e("02", "08", "contrasts-with")])).toEqual([
      "08>02 sister-of #0",
      "02>08 contrasts-with #0",
    ]);
  });

  test("a one-way relation, and a link to itself, are never hints", () => {
    expect(hints([e("a", "b", "grounded-in"), e("a", "a", "contrasts-with")])).toEqual([]);
  });

  test("one hint per pair and relation, the first link standing for the rest", () => {
    expect(
      hints([
        e("08", "02", "sister-of", 1),
        e("08", "02", "sister-of", 2),
        e("08", "02", "extends", 3),
      ]),
    ).toEqual(["08>02 sister-of #1"]);
  });

  test("symmetric at both ends: in the vocabularies of the document that writes it and the one it lands on", () => {
    const only = (doc: string, rel: string) => doc !== "east2" && rel === "sister-of";
    expect(
      oneWaySymmetric([e("east", "west", "sister-of"), e("west", "east2", "sister-of")], only).map(
        (h) => h.from,
      ),
    ).toEqual(["east"]);
  });
});

test("a key a relation does not read is a warning, never broken; a $-key is a note", () => {
  const r = parseRelations(
    JSON.stringify({
      $comment: "top-level note",
      relations: {
        extends: { label: "extends", symetric: true, $comment: "a note on extends" },
        "sister-of": { symmetric: true },
      },
    }),
  );
  expect(r).toEqual({
    relations: [
      { rel: "extends", label: "extends", symmetric: false, source: "" },
      { rel: "sister-of", label: "sister-of", symmetric: true, source: "" },
    ],
    warnings: [
      'relations.extends has "symetric", which is not read (a relation takes label, means, symmetric, inverse, color); it is ignored',
    ],
  });
  expect(parseRelations(JSON.stringify(DREAMWOOD))).not.toHaveProperty("warnings");
});
