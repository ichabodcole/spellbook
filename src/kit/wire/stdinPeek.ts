/**
 * Whether text is waiting on stdin, found WITHOUT reading it. A verb that takes
 * a body only with `--stdin` must still notice text piped in without the flag
 * (or it is silently dropped), and must not consume it while it looks: in
 * `printf 'a\nb\n' | while read f; do verb $f; done` the rest of the pipe is the
 * loop's, not the verb's. Nor may it wait long: an idle stdin a parent holds
 * open (Node's spawn default, Python's `Popen(stdin=PIPE)`) must not slow a
 * plain call.
 *
 * - A terminal or another character device (`/dev/null`): never touched.
 * - A regular file (`< file`): text when it is not empty.
 * - A pipe or a socket: `poll(2)` for at most `graceMs`, ending at the first
 *   byte or the end; then a look that leaves the bytes where they are: on
 *   macOS `fstat` gives the bytes buffered on both; elsewhere a socket is
 *   peeked with `recv(MSG_PEEK)`, and a pipe is readable only when it holds
 *   bytes (an emptied, closed pipe polls as a hangup).
 *
 * Anything that cannot be looked at (no libc to call) answers "none": the
 * verb copies, as it always did.
 */

import { fstatSync } from "node:fs";

/** How long a verb looks at a piped stdin before deciding nothing is waiting. */
export const STDIN_PEEK_MS = 100;

const POLLIN = 0x1;
const MSG_PEEK = 0x2;
const MSG_DONTWAIT = process.platform === "darwin" ? 0x80 : 0x40;

type Libc = {
  poll: (fds: Int16Array, nfds: number, timeoutMs: number) => number;
  recvPeek: (fd: number) => number;
};

let libc: Libc | null | undefined;

async function loadLibc(): Promise<Libc | null> {
  if (libc !== undefined) return libc;
  try {
    const { dlopen, FFIType, ptr } = await import("bun:ffi");
    const name = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
    const { symbols } = dlopen(name, {
      poll: {
        // nfds_t is an unsigned int on macOS, an unsigned long on Linux.
        args: [FFIType.ptr, process.platform === "darwin" ? FFIType.u32 : FFIType.u64, FFIType.i32],
        returns: FFIType.i32,
      },
      recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    });
    const one = new Uint8Array(1);
    libc = {
      poll: (fds, nfds, timeoutMs) => symbols.poll(ptr(fds), nfds, timeoutMs),
      recvPeek: (fd) => Number(symbols.recv(fd, ptr(one), 1, MSG_PEEK | MSG_DONTWAIT)),
    };
  } catch {
    libc = null;
  }
  return libc;
}

/**
 * "text" when bytes are waiting on stdin; "silent" when a pipe or socket is
 * still open but sent nothing within the look (a slow writer, or a parent
 * holding it idle); "none" otherwise. Never reads them.
 */
export async function stdinWaiting(graceMs = STDIN_PEEK_MS): Promise<"text" | "silent" | "none"> {
  try {
    const st = fstatSync(0);
    if (st.isFile()) return st.size > 0 ? "text" : "none";
    const fifo = st.isFIFO();
    if (!fifo && !st.isSocket()) return "none";
    const c = await loadLibc();
    if (!c) return process.platform === "darwin" && st.size > 0 ? "text" : "none";
    // struct pollfd { int fd; short events; short revents; }: fd 0, POLLIN.
    const pfd = new Int16Array(4);
    pfd[2] = POLLIN;
    const ready = c.poll(pfd, 1, graceMs);
    if (ready === 0) return "silent";
    if (ready < 0) return "none";
    if (process.platform === "darwin") return fstatSync(0).size > 0 ? "text" : "none";
    if (!fifo) return c.recvPeek(0) > 0 ? "text" : "none";
    return ((pfd[3] ?? 0) & POLLIN) !== 0 ? "text" : "none";
  } catch {
    return "none";
  }
}
