/**
 * End the process quietly when the reader of our stdout has gone.
 *
 * `cli schema | head -1` closes the pipe before we finish writing; the write
 * then raises an `error` event on `process.stdout`, and with no listener Bun
 * prints an `EPIPE` stack and exits 1. The reader left on purpose and printing
 * is a verb's last step, so the right ending is exit 0 with nothing on stderr.
 * Any other stdout error is rethrown so a real fault still surfaces.
 *
 * Ported from Image Farm (develop `30241167`, their item `cli-epipe-envelope`).
 * Dependency-free like `printJson`: it is bundled into each spell's emitted
 * CLI. `stream` and `exit` are parameters so a test can drive it without
 * ending the test process.
 */
export function exitOnBrokenPipe(
  stream: {
    on(event: "error", listener: (e: NodeJS.ErrnoException) => void): unknown;
  } = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") exit(0);
    else throw e;
  });
}
