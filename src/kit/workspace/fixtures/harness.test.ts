// The test harness's own guard: a probe must answer synchronously.
import { expect, test } from "bun:test";
import { waitUntil } from "./harness.ts";

test("waitUntil refuses a probe that returns a Promise, naming the problem", async () => {
  await expect(waitUntil("never", (async () => false) as never)).rejects.toThrow(
    /returned a Promise/,
  );
});
