// exitOnBrokenPipe: a reader that closed our stdout has gone, so the process
// ends quietly; any other stdout fault is not ours to hide.

import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { exitOnBrokenPipe } from "./exitOnBrokenPipe";

const fault = (code: string) => Object.assign(new Error(code), { code });

test("an EPIPE on the stream exits 0", () => {
  const stream = new EventEmitter();
  const codes: number[] = [];
  exitOnBrokenPipe(stream, (code) => codes.push(code));
  stream.emit("error", fault("EPIPE"));
  expect(codes).toEqual([0]);
});

test("any other stream error is rethrown, not swallowed", () => {
  const stream = new EventEmitter();
  const codes: number[] = [];
  exitOnBrokenPipe(stream, (code) => codes.push(code));
  expect(() => stream.emit("error", fault("EIO"))).toThrow("EIO");
  expect(codes).toEqual([]);
});
