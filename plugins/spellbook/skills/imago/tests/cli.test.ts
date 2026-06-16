// Unit tests for the cli's hand-rolled flag parser. The bug this guards: the
// EQUALS form (`--flag=value`) used to be mis-parsed — the whole `flag=value`
// became a boolean key and the value was silently dropped (it bit a real
// batch.add, losing --prompt/--tag/--summary). Both forms must work now.

import { expect, test } from "bun:test";
import { parseArgs } from "../scripts/cli";

test("space form: --key value", () => {
  const { pos, flags } = parseArgs(["--kind", "edit", "src1", "src2"]);
  expect(flags.kind).toBe("edit");
  expect(pos).toEqual(["src1", "src2"]);
});

test("equals form: --key=value (the regression)", () => {
  const { flags } = parseArgs(["--prompt=make it warmer", "--tag=hero"]);
  expect(flags.prompt).toBe("make it warmer");
  expect(flags.tag).toBe("hero");
});

test("equals form splits on the FIRST = so the value can contain =", () => {
  const { flags } = parseArgs(["--text=a=b=c"]);
  expect(flags.text).toBe("a=b=c");
});

test("empty equals value is the string '' (not a boolean)", () => {
  const { flags } = parseArgs(["--summary="]);
  expect(flags.summary).toBe("");
});

test("bare flag (no value, or followed by another flag) is boolean true", () => {
  const { flags } = parseArgs(["--no-open", "--kind", "generate"]);
  expect(flags["no-open"]).toBe(true);
  expect(flags.kind).toBe("generate");
});

test("mixed forms + positionals in one line", () => {
  const { pos, flags } = parseArgs([
    "--kind",
    "edit",
    "--prompt=harmonize the collage",
    "--edited-from=v-123",
    "https://x/0.png",
    "https://x/1.png",
  ]);
  expect(flags.kind).toBe("edit");
  expect(flags.prompt).toBe("harmonize the collage");
  expect(flags["edited-from"]).toBe("v-123");
  expect(pos).toEqual(["https://x/0.png", "https://x/1.png"]);
});
