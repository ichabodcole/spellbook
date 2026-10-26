// A run that passes: the scratch-home ward runs it under `bun test` and reads
// the scratch folder it was given from stdout.
import { expect, test } from "bun:test";

test("a run that passes", () => {
  console.log(`SCRATCH_HOME=${process.env.HOME}`);
  expect(true).toBe(true);
});
