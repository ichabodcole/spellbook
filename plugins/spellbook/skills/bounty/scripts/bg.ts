#!/usr/bin/env bun

// Bounty Board — background-host wrapper for long-running / loop-driven
// agent use cases.
//
// `server.ts` is designed for a one-shot agent that holds the board's
// stdin and stdout for its entire session. That doesn't work for
// chat-style agents (Claude Code, etc.) whose tool calls block one turn
// at a time — they can't keep stdin open across turns.
//
// This wrapper bridges the gap. It spawns `server.ts` and exposes the
// same protocol through two append-only files:
//
//   - **events file**  (write-only by us, read-only by the agent)
//                      everything the server writes to stdout, plus a
//                      synthetic `{type:"meta", ...}` first line with
//                      the session URL, port, session_id, and the two
//                      file paths.
//   - **commands file** (append-only by the agent, read-only by us)
//                      the agent appends JSON-lines here; we tail it
//                      and forward each line to the server's stdin.
//
// Agent usage:
//   bun run bg.ts --title "..." --no-open >/tmp/bg-meta.json &
//   # read the meta JSON for events_file / cmds_file paths
//   # to push: echo '{"type":"task.add", ...}' >> "$CMDS_FILE"
//   # to poll: read new lines from $EVENTS_FILE since last offset
//   # session ends when an event with type "closed" appears
//
// Exit codes mirror server.ts (0 submit, 130 cancel, 124 timeout, 2 bad
// args / spawn failure).

import {
  appendFileSync,
  closeSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// The subset of server.ts's stdout protocol that this wrapper inspects.
// Parsed from each JSON line the server emits; untrusted, so all optional.
type ServerEvent = {
  type?: string;
  session_id?: string;
  url?: string;
  port?: number;
};

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        title: { type: "string", default: "Bounty Board" },
        timeout: { type: "string", default: "43200" },
        "no-open": { type: "boolean", default: false },
        port: { type: "string", default: "0" },
        host: { type: "string", default: "127.0.0.1" },
        id: { type: "string" },
        // Override the auto-derived file paths (rare; useful for tests).
        "events-file": { type: "string" },
        "cmds-file": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const v = parsed.values;

  // Forward the relevant CLI flags to server.ts. --no-open is forwarded
  // only when the caller passed it; the wrapper otherwise inherits
  // server.ts's default of opening the user's browser to the board URL.
  const serverArgs = [
    "run",
    join(SCRIPT_DIR, "server.ts"),
    "--title",
    v.title as string,
    "--timeout",
    v.timeout as string,
    "--port",
    v.port as string,
    "--host",
    v.host as string,
  ];
  if (v.id) serverArgs.push("--id", v.id as string);
  if (v["no-open"]) serverArgs.push("--no-open");

  // Spawn the server.
  const server = Bun.spawn({
    cmd: ["bun", ...serverArgs],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });

  // We can't know the final session id until the server emits `ready`,
  // and we want it in the file paths. So buffer the first event,
  // resolve the paths from its session_id, then create the files.
  let eventsFile: string | null = (v["events-file"] as string) ?? null;
  let cmdsFile: string | null = (v["cmds-file"] as string) ?? null;
  let sessionId = "";

  // Tail the server's stdout — write each line to the events file (once
  // we know the path), and also emit a synthetic `meta` line as the
  // first record so the agent knows where to read/write.
  const stdoutReader = server.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let metaEmitted = false;

  const writeEventLine = (line: string) => {
    if (!eventsFile) return; // not yet resolved — should not happen post-ready
    try {
      appendFileSync(eventsFile, `${line}\n`);
    } catch (e) {
      process.stderr.write(
        `bg: append to events file failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  };

  const emitMeta = (url: string, port: number) => {
    if (metaEmitted) return;
    // Both paths are resolved before emitMeta is ever called (on `ready`).
    // Guard rather than assert so a future caller can't slip a null through.
    if (eventsFile === null || cmdsFile === null) return;
    metaEmitted = true;
    const meta = {
      type: "meta",
      url,
      port,
      session_id: sessionId,
      events_file: eventsFile,
      cmds_file: cmdsFile,
    };
    // Print meta to our OWN stdout so the launching agent can read it
    // without tailing a file. Also write it as the first line of the
    // events file so a later-joining reader gets the same info.
    process.stdout.write(`${JSON.stringify(meta)}\n`);
    writeEventLine(JSON.stringify(meta));
  };

  // Tracks whether the server's stdout has emitted a final {type:"closed"}
  // so we know to wind down the commands pump.
  let _serverClosed = false;

  const stdoutPump = (async () => {
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (value) buf += dec.decode(value, { stream: true });
        // Re-scan each pass so the `continue` below doesn't skip the advance.
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsedLine: ServerEvent | null = null;
          try {
            parsedLine = JSON.parse(line) as ServerEvent;
          } catch {
            /* not JSON — still echo into events file */
          }

          // First-ready triggers file creation and meta emission.
          if (parsedLine?.type === "ready" && !metaEmitted) {
            sessionId = parsedLine.session_id ?? "";
            // session_id already starts with "bounty-" — don't double-prefix.
            if (!eventsFile) eventsFile = join(tmpdir(), `${sessionId}-events.log`);
            if (!cmdsFile) cmdsFile = join(tmpdir(), `${sessionId}-cmds.log`);
            // Truncate / create the files fresh.
            try {
              writeFileSync(eventsFile, "");
            } catch {}
            try {
              writeFileSync(cmdsFile, "");
            } catch {}
            emitMeta(parsedLine.url ?? "", parsedLine.port ?? 0);
          }
          writeEventLine(line);
          if (parsedLine?.type === "closed") _serverClosed = true;
        }
        if (done) break;
      }
    } finally {
      try {
        stdoutReader.releaseLock();
      } catch {}
    }
  })();

  // Wait until the server has emitted `ready` and we've resolved file
  // paths before starting the commands pump. Cheap poll on the metaEmitted
  // flag; the stdoutPump above flips it within a few hundred ms.
  while (!metaEmitted && server.exitCode === null) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!metaEmitted) {
    // Drain the stdout pump so any error lines the server emitted before
    // exiting reach our stderr (via inherit), not just disappear when we
    // return.
    await stdoutPump;
    process.stderr.write(`bg: server exited before emitting ready (code ${server.exitCode})\n`);
    return 2;
  }

  // Commands pump: tail the cmdsFile and forward each new line to the
  // server's stdin. We poll the file size (250ms cadence is plenty —
  // the agent typically writes in bursts, not continuously).
  const enc = new TextEncoder();
  let cmdOffset = 0;
  let cmdBuf = "";

  const pollCmds = async () => {
    if (!cmdsFile) return;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(cmdsFile);
    } catch {
      return;
    }
    if (st.size <= cmdOffset) return;

    // Read just the new bytes.
    const fd = openSync(cmdsFile, "r");
    try {
      const newBytes = st.size - cmdOffset;
      const buffer = Buffer.alloc(newBytes);
      readSync(fd, buffer, 0, newBytes, cmdOffset);
      cmdOffset = st.size;
      cmdBuf += buffer.toString("utf-8");
    } finally {
      closeSync(fd);
    }

    // Re-scan each pass so the `continue` below doesn't skip the advance.
    for (let nl = cmdBuf.indexOf("\n"); nl >= 0; nl = cmdBuf.indexOf("\n")) {
      const line = cmdBuf.slice(0, nl).trim();
      cmdBuf = cmdBuf.slice(nl + 1);
      if (!line) continue;
      // Pass through to server stdin as-is. The server validates the
      // shape — bad lines surface as stderr warnings from the server.
      try {
        server.stdin.write(enc.encode(`${line}\n`));
      } catch (e) {
        process.stderr.write(
          `bg: forwarding cmd to server failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        return; // server is gone
      }
    }
  };

  const cmdsInterval = setInterval(() => {
    void pollCmds();
  }, 250);

  // When the server exits, stop polling commands and resolve.
  const exitCode = await server.exited;
  clearInterval(cmdsInterval);
  // One last drain in case commands landed right before exit.
  await pollCmds();
  await stdoutPump;

  // Cleanup. Leave the events file in place so the agent can read the
  // final state; remove the commands file (nothing more to send).
  if (cmdsFile) {
    try {
      unlinkSync(cmdsFile);
    } catch {}
  }
  return exitCode ?? 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

export { main };
