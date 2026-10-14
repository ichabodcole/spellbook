// A run started under a preset NODE_ENV (`NODE_ENV=development bun test`): the
// under-test guards must hold in it. `home.test.ts` runs it so, and reads the
// markers it prints. Nothing here reaches the real home: the HOME it hands
// `homeDir()` is a made-up path that is never created.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { homeDir, underTest } from "../../home";

test("a preset NODE_ENV does not take the run out of test", () => {
  console.log(`NODE_ENV=${process.env.NODE_ENV}`);
  console.log(`UNDER_TEST=${underTest()}`);
  expect(process.env.NODE_ENV).toBe("test");
  expect(underTest()).toBe(true);
  const scratch = process.env.HOME;
  process.env.HOME = join("/", "nonexistent-not-a-scratch-home");
  try {
    expect(() => homeDir()).toThrow(/refusing the real home folder/);
    console.log("HOME_REFUSED=true");
  } finally {
    process.env.HOME = scratch;
  }
});
