import { expect, test } from "bun:test";
import { copyFeedback } from "./clipboard";

test("a REJECTED clipboard write does not report success", () => {
  // The defect this file exists for: the label used to read "Copied!" whether
  // or not the write resolved. Anything that reintroduces that reds here.
  const failed = copyFeedback(false);
  expect(failed.outcome).toBe("failed");
  expect(failed.label).not.toContain("Copied");
  // It also names the fallback, because the user's remedy is manual.
  expect(failed.label).toBe("Copy failed — select it");
});

test("a resolved write reports success, and briefly", () => {
  const ok = copyFeedback(true);
  expect(ok.outcome).toBe("copied");
  expect(ok.label).toBe("Copied!");
  expect(ok.holdMs).toBe(1200);
});

test("the failure message is held longer than the success flash", () => {
  // Not cosmetic: the success flash confirms something already done, while the
  // failure asks the user to do something instead.
  expect(copyFeedback(false).holdMs).toBeGreaterThan(copyFeedback(true).holdMs);
});
