// A run that makes a temp folder as it loads, as many test files do: the
// scratch-home ward runs it under `bun test --rerun-each`, where the preload's
// cleanup fires after every rerun.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "load-temp-"));

test("a temp folder made at load exists", () => {
  expect(dir.startsWith(tmpdir())).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});
