// The one invariant the heartbeat file exists to keep: the two processes that
// share it agree on timing, so a healthy connection is never dropped between beats
// and a healthy tail never gives up.
import { expect, test } from "bun:test";
import { IDLE_TIMEOUT_SEC, SSE_HEARTBEAT_MS, TAIL_IDLE_MS } from "./heartbeat";

test("the server's idle timeout outlasts the beat, and the tail's watchdog outlasts it too", () => {
  expect(IDLE_TIMEOUT_SEC * 1000).toBeGreaterThan(SSE_HEARTBEAT_MS);
  expect(TAIL_IDLE_MS).toBeGreaterThan(SSE_HEARTBEAT_MS);
});

test("the watchdog is derived from the beat, three missed beats, never a second number", () => {
  expect(TAIL_IDLE_MS).toBe(SSE_HEARTBEAT_MS * 3);
});

test("the idle timeout is Bun's maximum: a held tail must outlive Bun's 10 s default", () => {
  expect(IDLE_TIMEOUT_SEC).toBe(255);
});
