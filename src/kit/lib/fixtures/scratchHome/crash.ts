// A run that dies before its cleanup: the scratch-home ward runs it under
// `bun test` to leave a folder behind, for the next run to remove.
import { test } from "bun:test";

test("a run killed mid-test", () => {
  process.kill(process.pid, "SIGKILL");
});
