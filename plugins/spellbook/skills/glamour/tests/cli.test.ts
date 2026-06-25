import { describe, expect, test } from "bun:test";
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
} from "../scripts/cli";

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
  test("style-archive defaults archived true; --restore flips it", () => {
    expect(buildStyleArchiveCmd(["s1"], {})).toEqual({
      type: "style.archive",
      id: "s1",
      archived: true,
    });
    expect(buildStyleArchiveCmd(["s1"], { restore: true })).toEqual({
      type: "style.archive",
      id: "s1",
      archived: false,
    });
  });
});
