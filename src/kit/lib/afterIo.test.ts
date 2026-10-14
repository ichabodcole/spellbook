import { describe, expect, test } from "bun:test";
import { lastLook, probed } from "./afterIo.ts";
import { waitFor } from "./testDom.ts";

// An `async` probe returns a Promise, which is always truthy: the wait would
// end at once and the test pass for the wrong reason. Every wait refuses it
// (`waitUntil` is tested beside the daemon harness).
describe("a wait probe that returns a Promise", () => {
  const asyncProbe = async () => false;

  test("waitFor throws", async () => {
    await expect(waitFor(asyncProbe as never, "never")).rejects.toThrow(/returned a Promise/);
  });

  test("the last look throws", async () => {
    await expect(lastLook(asyncProbe)).rejects.toThrow(/returned a Promise/);
  });

  test("plain answers pass, falsy or not", () => {
    for (const v of [false, null, undefined, 0, "", 5, { a: 1 }, [1]]) expect(probed(v)).toBe(v);
  });
});
