import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
// ⛔ THE PATH CELLS IMPORT THE ARTIFACT, NOT THE SOURCE, AND THAT IS THE WHOLE
// POINT OF THE RELOCATION. `daemonCwd()` and `SKILL_ROOT_FOR_TEST` are computed
// from `import.meta.url`, so their value depends on WHERE THE MODULE IS. Read
// out of `src/glamour/backend/cli.ts` they answer `src/glamour/` — a directory
// with no `SKILL.md`, no `dist/`, and a `SURFACE_CWD` five levels above the repo.
// Read out of the emitted `dist/cli.js` — the module the launcher imports and the
// only one that ever runs — they answer the skill root. Importing the source here
// would assert arithmetic nothing executes.
//
// ⚠ THIS MAKES THE CELL DEPEND ON A BUILT `dist/`. `bun run gate` is
// `build && check && test`, so the artifact is always fresh when it runs, and the
// thing being asserted is the thing that ships (D14, Contract 18 one level down).
import {
  daemonCwd,
  SKILL_ROOT_FOR_TEST,
} from "../../../plugins/spellbook/skills/glamour/dist/cli.js";
import {
  buildFocusCmd,
  buildGenCmd,
  buildGenCostCmd,
  buildSayCmd,
  buildSectionCmd,
  buildStyleArchiveCmd,
  buildStyleSaveCmd,
  parseArgs,
  parseCustom,
} from "./cli";

describe("cli command construction", () => {
  test("section: key + flags → typed command, prompts split on ||", () => {
    const { pos, flags } = parseArgs([
      "prompts",
      "--status",
      "agreed",
      "--prompts",
      "hand-inked, indigo||warm amber accent",
    ]);
    expect(buildSectionCmd(pos, flags)).toEqual({
      type: "section",
      key: "prompts",
      status: "agreed",
      prompts: ["hand-inked, indigo", "warm amber accent"],
    });
  });

  test("section: content only", () => {
    const { pos, flags } = parseArgs(["palette", "--content", "indigo + amber"]);
    expect(buildSectionCmd(pos, flags)).toEqual({
      type: "section",
      key: "palette",
      content: "indigo + amber",
    });
  });

  test("section: --colors parses into swatches (hex + optional name)", () => {
    const { pos, flags } = parseArgs([
      "palette",
      "--status",
      "agreed",
      "--colors",
      "#FACC3E:Treasure Gold||#293D36:Sunken Charcoal||#000000",
    ]);
    expect(buildSectionCmd(pos, flags)).toEqual({
      type: "section",
      key: "palette",
      status: "agreed",
      colors: [
        { hex: "#FACC3E", name: "Treasure Gold" },
        { hex: "#293D36", name: "Sunken Charcoal" },
        { hex: "#000000" },
      ],
    });
  });

  test("say: text + kind", () => {
    expect(buildSayCmd(["here", "is", "what"], { kind: "result" })).toEqual({
      type: "say",
      text: "here is what",
      kind: "result",
    });
  });

  test("say: bare text defaults to no kind", () => {
    expect(buildSayCmd(["hi"], {})).toEqual({ type: "say", text: "hi" });
  });
});

describe("slice 3 cli builders", () => {
  test("buildGenCmd assembles gen.add with parsed numerics + custom", () => {
    const { flags } = parseArgs([
      "--prompt",
      "indigo twilight",
      "--model",
      "nano-banana",
      "--round",
      "2",
      "--seed",
      "42817",
      "--cost",
      "0.011",
      "--label",
      "r2 · A",
      "--custom",
      "guidance=7,steps=30",
    ]);
    expect(buildGenCmd("data:image/webp;base64,ZZ", flags)).toEqual({
      type: "gen.add",
      src: "data:image/webp;base64,ZZ",
      prompt: "indigo twilight",
      model: "nano-banana",
      round: 2,
      seed: 42817,
      cost: 0.011,
      label: "r2 · A",
      custom: { guidance: "7", steps: "30" },
    });
  });

  test("buildGenCmd omits absent optionals", () => {
    const { flags } = parseArgs(["--prompt", "p", "--model", "m", "--round", "1"]);
    expect(buildGenCmd("data:image/webp;base64,ZZ", flags)).toEqual({
      type: "gen.add",
      src: "data:image/webp;base64,ZZ",
      prompt: "p",
      model: "m",
      round: 1,
    });
  });

  test("buildGenCostCmd parses id + numeric cost", () => {
    const { pos, flags } = parseArgs(["gen-7", "--cost", "0.02"]);
    expect(buildGenCostCmd(pos, flags)).toEqual({
      type: "gen.cost",
      id: "gen-7",
      cost: 0.02,
    });
  });

  test("buildFocusCmd takes positional ids + optional note", () => {
    const { pos, flags } = parseArgs(["g1", "g2", "--note", "which reads most like X?"]);
    expect(buildFocusCmd(pos, flags)).toEqual({
      type: "focus.push",
      ids: ["g1", "g2"],
      note: "which reads most like X?",
    });
  });

  test("parseCustom splits k=v pairs; undefined when absent", () => {
    expect(parseCustom("a=1,b=2")).toEqual({ a: "1", b: "2" });
    expect(parseCustom(undefined)).toBeUndefined();
    expect(parseCustom(true)).toBeUndefined();
  });
});

describe("slice 4 cli builders", () => {
  test("style-save joins the label", () => {
    const { pos } = parseArgs(["house", "style"]);
    expect(buildStyleSaveCmd(pos)).toEqual({
      type: "style.save",
      label: "house style",
    });
  });
  // RENAMED per Cole's A9 ruling: this verb's un-archive flag was `--restore`,
  // which had no correct type — boolean here, string in `open`'s daemon spawn,
  // and node:util takes ONE options map per entry point. `--restore` keeps the
  // house-wide string spelling; this one becomes `--unarchive`.
  test("style-archive defaults archived true; --unarchive flips it", () => {
    expect(buildStyleArchiveCmd(["s1"], {})).toEqual({
      type: "style.archive",
      id: "s1",
      archived: true,
    });
    expect(buildStyleArchiveCmd(["s1"], { unarchive: true })).toEqual({
      type: "style.archive",
      id: "s1",
      archived: false,
    });
  });

  // ⚠ THE LIVE BUG THE RENAME KILLS BY CONSTRUCTION. The old predicate was
  // `flags.restore !== true`, so passing a STRING — which `--restore foo` did,
  // and which `open`'s own `--restore <id>` spelling invites — evaluated
  // truthy-but-not-`true` and ARCHIVED instead of restoring, at exit 0 with no
  // signal. `!flags.unarchive` cannot express that: a boolean-typed flag can
  // never hold a string, so the failure is now unrepresentable rather than
  // merely unlikely.
  test("un-archiving cannot be silently inverted by a stray value", () => {
    expect(buildStyleArchiveCmd(["s1"], { unarchive: true }).archived).toBe(false);
    // and the old spelling is simply not recognised any more
    expect(buildStyleArchiveCmd(["s1"], { restore: "foo" }).archived).toBe(true);
  });
});

describe("Contract 5 — the daemon's cwd pin (daemonCwd)", () => {
  // The failure this guards is SILENT on the surface side (an unstyled board,
  // every request 200) and is circe's cell to red; this one proves only that the
  // pin points where Contract 5 says, in both modes, and that the dev target is
  // a directory that exists in this repo — the five `..` turned into a line that
  // runs instead of a count in a comment.
  const saved = process.env.SPELLBOOK_SURFACE_MODE;
  const restore = () => {
    if (saved === undefined) delete process.env.SPELLBOOK_SURFACE_MODE;
    else process.env.SPELLBOOK_SURFACE_MODE = saved;
  };
  test("forced dev → src/glamour/, and it exists", () => {
    process.env.SPELLBOOK_SURFACE_MODE = "dev";
    try {
      const cwd = daemonCwd();
      expect(basename(cwd)).toBe("glamour");
      expect(basename(dirname(cwd))).toBe("src");
      expect(existsSync(cwd)).toBe(true);
      expect(existsSync(join(cwd, "bunfig.toml"))).toBe(true); // ruling 3: bunfig moved WITH the pin
    } finally {
      restore();
    }
  });
  test("forced release → the skill root (dist/ is absolute, no bunfig needed)", () => {
    process.env.SPELLBOOK_SURFACE_MODE = "release";
    try {
      expect(daemonCwd()).toBe(SKILL_ROOT_FOR_TEST);
      expect(existsSync(join(daemonCwd(), "SKILL.md"))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("S2 — the one src/-naming specifier resolves (ask 6's by-hand check, as a cell)", () => {
  test("server.ts's dev-branch dynamic import points at a file that exists", () => {
    // Ward 1a's pinned inventory compares STRINGS and calls no existsSync, so a
    // broken specifier launders straight into the pin (cassandra, ratify). This
    // cell is the check the ruling said a human must run before pinning.
    // ⛔ READ AT THE ADDRESS WHERE THE SPECIFIER EXECUTES. The five `..` in that
    // import are counted from `plugins/spellbook/skills/glamour/dist/`, NOT from
    // this source file — the build passes `--external` for the surface-HTML glob,
    // so the string survives into `dist/server.js` byte-for-byte and is resolved
    // there at runtime (D11). Read as an ordinary relative import of the .ts it
    // is written in, it climbs out of the repo. It happens to be the SAME string
    // as before the relocation because `dist/` sits at the same depth as the
    // `scripts/` it replaced — a coincidence of depth, not a property, which is
    // why this cell resolves it rather than reasoning about it.
    const emittedServer = join(SKILL_ROOT_FOR_TEST, "dist", "server.js");
    const src = readFileSync(emittedServer, "utf8");
    const specs = [...src.matchAll(/await import\("([^"]+src\/glamour[^"]+)"\)/g)].map((m) => m[1]);
    expect(specs).toHaveLength(1); // S2: EXACTLY one src/-naming specifier
    const resolved = resolve(dirname(emittedServer), specs[0] as string);
    expect(existsSync(resolved)).toBe(true);
    expect(basename(resolved)).toBe("index.html");
  });
});
