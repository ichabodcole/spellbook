#!/usr/bin/env bun
// @bun

// src/bounty/backend/join.ts
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseArgs } from "util";

// src/kit/wire/errors.ts
var EXIT_FOR = {
  usage: 2,
  internal: 1,
  not_found: 5,
  conflict: 6
};
var currentCommand = null;
function setCurrentCommand(command) {
  currentCommand = command;
}
function errorEnvelope(kind, message, extra) {
  return `${JSON.stringify({
    ok: false,
    error: {
      kind,
      exit_code: EXIT_FOR[kind],
      retryable: false,
      message,
      ...extra?.token ? { token: extra.token } : {},
      ...extra?.hint ? { hint: extra.hint } : {},
      ...extra?.choices ? { choices: extra.choices } : {},
      ...extra?.server !== undefined ? { server: extra.server } : {}
    },
    meta: { command: currentCommand }
  })}
`;
}

class CliError extends Error {
  kind;
  extra;
  constructor(kind, message, extra) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    this.extra = extra;
  }
  get exitCode() {
    return EXIT_FOR[this.kind];
  }
}
function die(message, kind = "usage", extra) {
  throw new CliError(kind, message, extra);
}
function reportCliError(e, err = process.stderr) {
  if (!(e instanceof CliError))
    return null;
  err.write(errorEnvelope(e.kind, e.message, e.extra));
  return e.exitCode;
}

// src/bounty/backend/join.ts
function emitToAgent(msg) {
  try {
    process.stdout.write(`${JSON.stringify(msg)}
`);
  } catch (e) {
    if (!(e && typeof e === "object" && ("code" in e) && e.code === "EPIPE"))
      throw e;
  }
}
function discover(args) {
  if (args.url) {
    return { url: args.url, port: 0, session_id: "(from --url)", title: "" };
  }
  const path = args.id ? join(tmpdir(), `bounty-${args.id}.json`) : join(tmpdir(), `bounty-latest.json`);
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    if (args.id) {
      throw new Error(`no session file for id '${args.id}' (looked at ${path})`);
    }
    throw new Error(`no bounty session found at ${path} \u2014 pass --url <url> or --id <session_id>, or start one with server.ts first`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`session file ${path} is malformed`);
  }
}
async function* readJsonLines() {
  if (process.stdin.isTTY) {
    yield null;
    return;
  }
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value)
        buffer += decoder.decode(value, { stream: true });
      for (let nl = buffer.indexOf(`
`);nl >= 0; nl = buffer.indexOf(`
`)) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line)
          continue;
        try {
          yield JSON.parse(line);
        } catch (e) {
          process.stderr.write(`join: bad json on stdin: ${e instanceof Error ? e.message : String(e)}
`);
        }
      }
      if (done) {
        const final = buffer.trim();
        if (final) {
          try {
            yield JSON.parse(final);
          } catch (e) {
            process.stderr.write(`join: bad json on stdin (final): ${e instanceof Error ? e.message : String(e)}
`);
          }
        }
        yield null;
        return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        id: { type: "string" },
        timeout: { type: "string", default: "1800" }
      },
      strict: true,
      allowPositionals: false
    });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e), "usage");
  }
  const v = parsed.values;
  const timeout = parseFloat(v.timeout);
  let info;
  try {
    info = discover({ url: v.url, id: v.id });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e), "not_found", {
      hint: "pass an explicit --url or --id, or open a board first"
    });
  }
  const wsUrl = `${info.url.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(wsUrl);
  let resolveDone;
  let settled = false;
  const done = new Promise((res) => {
    resolveDone = (v2) => {
      if (settled)
        return;
      settled = true;
      res(v2);
    };
  });
  let lastActivity = performance.now();
  const touch = () => {
    lastActivity = performance.now();
  };
  let initialEmitted = false;
  ws.addEventListener("open", () => {
    touch();
  });
  ws.addEventListener("message", (ev) => {
    touch();
    let payload;
    try {
      const data = ev.data;
      payload = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
    } catch (e) {
      process.stderr.write(`join: bad json from server: ${e instanceof Error ? e.message : String(e)}
`);
      return;
    }
    if (!initialEmitted && payload?.type === "init") {
      initialEmitted = true;
      emitToAgent({
        type: "joined",
        url: info.url,
        session_id: info.session_id,
        title: payload.title ?? info.title,
        tasks: Array.isArray(payload.tasks) ? payload.tasks : []
      });
      return;
    }
    emitToAgent({ type: "event", payload });
  });
  ws.addEventListener("close", () => {
    resolveDone({ code: 0, reason: "server_closed" });
  });
  let opened = false;
  ws.addEventListener("error", (e) => {
    const detail = e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message : "unknown";
    if (opened)
      process.stderr.write(`join: ws error: ${detail}
`);
    resolveDone({ code: 2, reason: "error" });
  });
  const openOk = await Promise.race([
    new Promise((r) => ws.addEventListener("open", () => r(true), { once: true })),
    new Promise((r) => ws.addEventListener("error", () => r(false), { once: true })),
    new Promise((r) => setTimeout(() => r(false), 3000))
  ]);
  if (!openOk) {
    die(`could not connect to ${wsUrl} (no host running?)`, "not_found", {
      hint: "the board may have closed; pass an explicit --url or --id, or open a new one"
    });
  }
  opened = true;
  (async () => {
    for await (const msg of readJsonLines()) {
      if (msg === null) {
        try {
          ws.close();
        } catch {}
        resolveDone({ code: 0, reason: "stdin_close" });
        return;
      }
      touch();
      if (msg.type === "close") {
        try {
          ws.close();
        } catch {}
        resolveDone({ code: 0, reason: "stdin_close" });
        return;
      }
      try {
        ws.send(JSON.stringify(msg));
      } catch (e) {
        process.stderr.write(`join: send failed: ${e instanceof Error ? e.message : String(e)}
`);
      }
    }
  })();
  const idleTimer = setInterval(() => {
    if ((performance.now() - lastActivity) / 1000 >= timeout) {
      resolveDone({ code: 0, reason: "timeout" });
      try {
        ws.close();
      } catch {}
    }
  }, 1000);
  const { code, reason } = await done;
  clearInterval(idleTimer);
  emitToAgent({ type: "disconnected", reason });
  return code;
}
async function run() {
  setCurrentCommand("join");
  try {
    return await main(process.argv.slice(2));
  } catch (e) {
    const code = reportCliError(e);
    if (code === null)
      throw e;
    return code;
  }
}
export {
  discover,
  main,
  run
};
