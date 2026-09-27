#!/usr/bin/env bun
// @bun

// src/grapevine/backend/cli.ts
import { spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// src/kit/cli/registry.ts
import { parseArgs } from "util";

// src/kit/lib/printJson.ts
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}

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

// src/kit/cli/registry.ts
var INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" }
];
var INTERCEPTOR_CHOICES = INTERCEPTORS.map((i) => i.name).sort((a, b) => Number(b.startsWith("--")) - Number(a.startsWith("--")));
var errCode = (e) => e && typeof e === "object" && ("code" in e) ? String(e.code) : "";
var errMessage = (e) => e instanceof Error ? e.message : String(e);
function defineCli(spec) {
  const cliName = spec.name;
  const optionKeys = Object.keys(spec.options);
  const known = new Set(optionKeys);
  const grammar = spec.grammar ?? "verb-first";
  const globals = [...spec.globalFlags ?? []];
  const hides = new Set(spec.usageHides ?? []);
  for (const g of globals) {
    if (!known.has(g))
      throw new Error(`defineCli(${cliName}): global flag "${g}" is not in options`);
  }
  if ((spec.commands?.length ?? 0) === 0 && spec.root === undefined) {
    throw new Error(`defineCli(${cliName}): give commands, a root, or both`);
  }
  const parseOptions = Object.fromEntries(optionKeys.map((k) => {
    const { default: _d, ...rest } = spec.options[k];
    return [k, rest];
  }));
  const shortToKey = new Map;
  for (const k of optionKeys) {
    const s = spec.options[k]?.short;
    if (s !== undefined)
      shortToKey.set(s, k);
  }
  const acceptedOf = (own) => {
    const set = new Set([...globals, ...own]);
    return optionKeys.filter((k) => set.has(k));
  };
  const toRow = (c, auto) => {
    for (const f of c.flags) {
      if (!known.has(f)) {
        throw new Error(`defineCli(${cliName}): row "${c.name}" names flag "${f}", not in options`);
      }
    }
    return {
      name: c.name,
      aliases: [...c.aliases ?? []],
      flags: [...c.flags],
      accepted: acceptedOf(c.flags),
      positionals: c.positionals.map((p) => ({ ...p })),
      describe: c.describe,
      auto,
      rejectHint: c.rejectHint,
      allowPositionals: c.allowPositionals ?? true,
      check: c.check,
      run: c.run
    };
  };
  const rows = (spec.commands ?? []).map((c) => toRow(c, false));
  const cli = {};
  const autoRows = [
    {
      name: "version",
      flags: [],
      positionals: [],
      describe: "this CLI's {name, version} as JSON (alias: --version, -V)",
      run: async () => {
        printJson(await spec.version());
      }
    },
    {
      name: "schema",
      flags: [],
      positionals: [],
      describe: "this CLI's machine-readable interface (acc declaration v0)",
      run: () => {
        process.stdout.write(`${JSON.stringify(cli.declaration(), null, 2)}
`);
      }
    },
    {
      name: "help",
      flags: [],
      positionals: [],
      describe: "show this message (alias: --help, -h)",
      run: () => {
        const text = cli.renderHelp();
        process.stdout.write(text.endsWith(`
`) ? text : `${text}
`);
      }
    }
  ];
  for (const a of autoRows) {
    if (!rows.some((r) => r.name === a.name))
      rows.push(toRow(a, true));
  }
  const rootRow = spec.root === undefined ? undefined : toRow({ ...spec.root, name: "" }, false);
  const byToken = new Map;
  for (const r of rows) {
    for (const t of [r.name, ...r.aliases]) {
      const parts = t.split(" ");
      if (t.trim() !== t || parts.length > 2 || parts.some((p) => p === "" || p.startsWith("-"))) {
        throw new Error(`defineCli(${cliName}): bad command name "${t}"`);
      }
      if (t !== r.name && parts.length !== r.name.split(" ").length) {
        throw new Error(`defineCli(${cliName}): alias "${t}" must nest like "${r.name}"`);
      }
      if (parts.length === 2 && t !== r.name && parts[0] !== r.name.split(" ")[0]) {
        throw new Error(`defineCli(${cliName}): alias "${t}" must share the group of "${r.name}"`);
      }
      if (byToken.has(t))
        throw new Error(`defineCli(${cliName}): "${t}" is defined twice`);
      byToken.set(t, r);
    }
  }
  const subsOf = new Map;
  for (const t of byToken.keys()) {
    const [group, sub] = t.split(" ");
    if (group !== undefined && sub !== undefined) {
      subsOf.set(group, [...subsOf.get(group) ?? [], sub]);
    }
  }
  for (const g of Object.keys(spec.groups ?? {})) {
    if (!subsOf.has(g))
      throw new Error(`defineCli(${cliName}): group "${g}" has no sub-verbs`);
  }
  const paths = [...byToken.keys()];
  const verbs = [...new Set(paths.map((p) => p.split(" ")[0]))];
  const rowFor = (path) => path === "" ? rootRow : byToken.get(path);
  const flagsFor = (path) => [...rowFor(path)?.accepted ?? []].map((k) => `--${k}`).sort();
  const label = (r) => r.name || cliName;
  const rootChoices = (() => {
    const all = [...flagsFor(""), ...INTERCEPTOR_CHOICES];
    const long = all.filter((f) => f.startsWith("--")).sort();
    return [...long, ...all.filter((f) => !f.startsWith("--"))];
  })();
  const renderPositional = (p) => {
    const inner = p.variadic ? `${p.name}...` : p.name;
    return p.required ? `<${inner}>` : `[${inner}]`;
  };
  const renderFlag = (k) => spec.options[k]?.type === "boolean" ? `[--${k}]` : `[--${k} ..]`;
  const usageLine = (r) => [
    label(r),
    ...r.positionals.map(renderPositional),
    ...r.flags.filter((k) => !hides.has(k)).map(renderFlag)
  ].join(" ");
  const expects = (r) => `expects: ${usageLine(r)}`;
  const renderHelp = () => {
    if (spec.help !== undefined)
      return spec.help();
    const listed = [...rootRow ? [rootRow] : [], ...rows];
    const lines = listed.map((r) => [usageLine(r), r.describe]);
    const width = Math.min(Math.max(...lines.map(([u]) => u.length)), 44);
    const body = lines.map(([u, d]) => u.length <= width ? `  ${u.padEnd(width)}  ${d}` : `  ${u}
  ${"".padEnd(width)}  ${d}`).join(`
`);
    const head = spec.summary ? `${cliName} \u2014 ${spec.summary}` : cliName;
    const tokens = `  ${INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON`;
    return `${head}

${body}
${tokens}${spec.helpFooter ? `

${spec.helpFooter}` : ""}`;
  };
  const declaration = () => {
    const arg = (k) => ({
      name: `--${k}`,
      type: spec.options[k].type,
      status: "valid"
    });
    const commands = [
      {
        path: [],
        args: [
          ...INTERCEPTORS.map((i) => ({
            name: i.name,
            type: "boolean",
            status: "valid"
          })),
          ...rootRow ? rootRow.accepted.map(arg) : []
        ],
        positionals: rootRow ? rootRow.positionals.map((p) => ({ ...p })) : [{ name: spec.verbPositional ?? "command", required: true }]
      }
    ];
    for (const r of rows) {
      for (const t of [r.name, ...r.aliases]) {
        commands.push({
          path: t.split(" "),
          args: r.accepted.map(arg),
          positionals: r.positionals.map((p) => ({ ...p }))
        });
      }
    }
    const schemaRow = byToken.get("schema");
    return {
      formatVersion: "0",
      provenance: "emitted",
      selfDescription: { args: [schemaRow.name] },
      commands
    };
  };
  const scanPositional = (args, stopAtTerminator) => {
    for (let i = 0;i < args.length; i++) {
      const a = args[i];
      if (a === "--")
        return stopAtTerminator || i + 1 >= args.length ? -1 : i + 1;
      if (a.startsWith("--")) {
        if (a.includes("="))
          continue;
        if (spec.options[a.slice(2)]?.type === "string")
          i++;
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        const key = a.length === 2 ? shortToKey.get(a.slice(1)) : undefined;
        if (key !== undefined && spec.options[key]?.type === "string")
          i++;
        continue;
      }
      return i;
    }
    return -1;
  };
  const without = (args, i) => [
    ...args.slice(0, i),
    ...args.slice(i + 1)
  ];
  const noCommand = () => die("expected a command", "usage", {
    choices: [...verbs],
    hint: `run \`${cliName} help\` (or --help) for usage`
  });
  const resolve = (cand, rest) => {
    const subs = subsOf.get(cand);
    if (subs !== undefined) {
      const at = spec.groups?.[cand]?.subVerbAt ?? "adjacent";
      let i = -1;
      if (at === "adjacent") {
        const next = rest[0];
        i = next !== undefined && !next.startsWith("-") ? 0 : -1;
      } else {
        i = scanPositional(rest, true);
      }
      const sub = i >= 0 ? rest[i] : undefined;
      const full = sub === undefined ? undefined : byToken.get(`${cand} ${sub}`);
      if (full !== undefined && sub !== undefined) {
        return { row: full, token: `${cand} ${sub}`, args: without(rest, i) };
      }
      const own = byToken.get(cand);
      if (own !== undefined)
        return { row: own, token: cand, args: rest };
      const extra = { choices: [...subs], hint: `run \`${cliName} help\` for usage` };
      if (sub === undefined)
        die(`${cand}: expected a sub-command`, "usage", extra);
      die(`unknown ${cand} sub-command: "${sub}"`, "usage", extra);
    }
    const row = byToken.get(cand);
    if (row === undefined) {
      die(`unknown command "${cand}"`, "usage", {
        choices: [...verbs],
        hint: `run \`${cliName} help\` for usage`
      });
    }
    return { row, token: cand, args: rest };
  };
  const runRow = async (row, token, args) => {
    setCurrentCommand(row.name === "" ? null : row.name);
    const name = label(row);
    const accepted = new Set(row.accepted);
    const choices = row.name === "" ? rootChoices : flagsFor(row.name);
    const flagHint = () => [row.rejectHint, choices.length === 0 ? `${name} takes no flags` : undefined].filter((s) => s !== undefined).join("; ") || undefined;
    let values;
    let positionals;
    try {
      ({ values, positionals } = parseArgs({
        args,
        options: parseOptions,
        strict: true,
        allowPositionals: row.allowPositionals
      }));
    } catch (e) {
      if (errCode(e) === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
        die(`${name}: ${errMessage(e)}`, "usage", { choices, hint: flagHint() });
      }
      die(`${name}: ${errMessage(e)}`, "usage", { hint: row.rejectHint ?? expects(row) });
    }
    const stray = Object.keys(values).find((k) => !accepted.has(k));
    if (stray !== undefined) {
      die(`--${stray} is not accepted by \`${name}\` (it is a recognized ${cliName} flag, just not this ${row.name === "" ? "command" : "verb"}'s)`, "usage", { choices, hint: flagHint() });
    }
    const required = row.positionals.filter((p) => p.required).length;
    const variadic = row.positionals.some((p) => p.variadic);
    if (positionals.length < required) {
      const missing = row.positionals[positionals.length];
      die(`${name}: missing required <${missing?.name ?? "argument"}>`, "usage", {
        hint: expects(row)
      });
    }
    if (!variadic && positionals.length > row.positionals.length) {
      die(`${name}: unexpected argument ${JSON.stringify(positionals[row.positionals.length])}`, "usage", { hint: row.positionals.length === 0 ? `${name} takes no arguments` : expects(row) });
    }
    const flags = { ...values };
    for (const k of row.accepted) {
      const d = spec.options[k].default;
      if (flags[k] === undefined && d !== undefined) {
        flags[k] = Array.isArray(d) ? [...d] : d;
      }
    }
    const inv = { path: row.name, token, pos: positionals, flags };
    const refused = row.check?.(inv);
    if (refused !== undefined)
      die(`${name}: ${refused}`, "usage", { hint: expects(row) });
    const out = await row.run(inv);
    return typeof out === "number" ? out : 0;
  };
  const dispatch = async (argv) => {
    setCurrentCommand(argv[0] ?? null);
    const first = argv[0];
    const interceptor = INTERCEPTORS.find((i) => i.name === first);
    if (interceptor !== undefined) {
      return runRow(byToken.get(interceptor.runs), interceptor.runs, argv.slice(1));
    }
    if (rootRow !== undefined) {
      if (first !== undefined && (byToken.has(first) || subsOf.has(first))) {
        const r2 = resolve(first, argv.slice(1));
        return runRow(r2.row, r2.token, r2.args);
      }
      return runRow(rootRow, "", argv);
    }
    if (first === undefined)
      return noCommand();
    let cand;
    let rest;
    if (grammar === "verb-first") {
      if (first === "--") {
        if (argv[1] === undefined)
          return noCommand();
        cand = argv[1];
        rest = ["--", ...argv.slice(2)];
      } else if (first.startsWith("-")) {
        return die(`unknown flag at the root: ${first}`, "usage", {
          choices: [...INTERCEPTOR_CHOICES],
          hint: `commands (each takes its own flags): ${verbs.join(" ")}`
        });
      } else {
        cand = first;
        rest = argv.slice(1);
      }
    } else {
      const i = scanPositional(argv, false);
      if (i < 0) {
        setCurrentCommand(null);
        try {
          parseArgs({ args: argv, options: parseOptions, strict: true, allowPositionals: true });
        } catch (e) {
          die(errMessage(e), "usage", {
            choices: [...INTERCEPTOR_CHOICES],
            hint: `no command given \u2014 commands: ${verbs.join(" ")} (run: ${cliName} help)`
          });
        }
        return noCommand();
      }
      cand = argv[i];
      rest = without(argv, i);
    }
    setCurrentCommand(cand);
    const r = resolve(cand, rest);
    return runRow(r.row, r.token, r.args);
  };
  const main = async (argv) => {
    try {
      return await dispatch(argv);
    } catch (e) {
      const reported = reportCliError(e);
      if (reported !== null)
        return reported;
      return reportCliError(new CliError("internal", errMessage(e))) ?? 1;
    }
  };
  const view = (r) => ({
    name: r.name,
    aliases: r.aliases,
    flags: r.flags,
    accepted: r.accepted,
    positionals: r.positionals,
    describe: r.describe,
    auto: r.auto
  });
  Object.assign(cli, {
    name: cliName,
    main,
    dispatch,
    declaration,
    renderHelp,
    usageOf: (path) => {
      const r = rowFor(path);
      return r === undefined ? "" : usageLine(r);
    },
    verbs,
    paths,
    flagsFor,
    recognizedFlags: optionKeys.map((k) => `--${k}`),
    rows: rows.map(view)
  });
  return cli;
}

// src/kit/wire/tailEvents.ts
var DEFAULT_IDLE_MS = 45000;
var DEFAULT_RETRY = { initialMs: 250, maxMs: 5000 };
function parseSseFrame(block) {
  const comments = [];
  const dataLines = [];
  let event = "message";
  let sawData = false;
  for (const line of block.split(`
`)) {
    if (line === "")
      continue;
    if (line.startsWith(":")) {
      comments.push(line.slice(1));
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" "))
      value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
      sawData = true;
    } else if (field === "event") {
      event = value;
    }
  }
  if (!sawData)
    return { frame: null, comments };
  return { frame: { event, data: dataLines.join(`
`) }, comments };
}
async function tailEvents(opts) {
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const cursorPolicy = opts.cursorPolicy ?? "monotonic";
  let cursor = opts.since;
  let epoch = opts.sinceEpoch ?? null;
  let everResolved = false;
  let everConnected = false;
  let firstConnect = true;
  let delay = retry.initialMs;
  let code = 0;
  let ending = "stopped";
  let stopped = false;
  let attempt = null;
  let wakeBackoff = null;
  const stop = (exitCode) => {
    stopped = true;
    code = exitCode;
    attempt?.abort();
    wakeBackoff?.();
  };
  const backoff = (ms) => new Promise((resolveSleep) => {
    if (stopped)
      return resolveSleep();
    const finish = () => {
      clearTimeout(timer);
      wakeBackoff = null;
      resolveSleep();
    };
    const timer = setTimeout(finish, ms);
    wakeBackoff = finish;
  });
  const onSignal = () => stop(0);
  const useSignals = opts.signals !== false;
  if (useSignals) {
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  const onOutError = (e) => {
    if (e?.code === "EPIPE")
      stop(0);
  };
  const outEmitter = out;
  outEmitter.on?.("error", onOutError);
  const onCallerAbort = () => stop(0);
  opts.signal?.addEventListener("abort", onCallerAbort);
  if (opts.signal?.aborted)
    stop(0);
  const emit = (line) => {
    out.write(`${line}
`);
  };
  const note = (line) => {
    if (line !== null && line !== undefined)
      err.write(`${line}
`);
  };
  try {
    while (!stopped) {
      const base = await opts.resolve();
      if (stopped)
        break;
      if (base === null) {
        const verdict = opts.onUnresolved?.({ everResolved, everConnected }) ?? "retry";
        if (verdict === "stop") {
          ending = "unresolved";
          return code;
        }
        await backoff(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      everResolved = true;
      const params = opts.query?.(cursor, firstConnect) ?? {
        since: String(cursor)
      };
      const askedSince = cursor;
      let restartNoted = false;
      let fromTop = false;
      const qs = new URLSearchParams(params).toString();
      const url = `${base}${opts.path}${qs ? `?${qs}` : ""}`;
      attempt = new AbortController;
      const controller = attempt;
      let watchdog = null;
      const resetWatchdog = () => {
        if (idleMs <= 0)
          return;
        if (watchdog !== null)
          clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), idleMs);
      };
      let res;
      try {
        res = await fetch(url, { signal: controller.signal });
      } catch (e) {
        if (watchdog !== null)
          clearTimeout(watchdog);
        attempt = null;
        if (stopped)
          break;
        note(opts.onDisconnect?.({ cause: "connect-failed", error: e }));
        await backoff(delay);
        delay = Math.min(delay * 2, retry.maxMs);
        continue;
      }
      try {
        if (!res.ok) {
          await opts.onHttpError?.(res);
          await res.body?.cancel().catch(() => {});
          note(opts.onDisconnect?.({ cause: "http", status: res.status }));
          await backoff(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        if (!res.body) {
          note(opts.onDisconnect?.({ cause: "no-body", status: res.status }));
          await backoff(delay);
          delay = Math.min(delay * 2, retry.maxMs);
          continue;
        }
        everConnected = true;
        firstConnect = false;
        resetWatchdog();
        const reader = res.body.getReader();
        const decoder = new TextDecoder;
        let buf = "";
        while (!stopped) {
          let chunk;
          try {
            chunk = await reader.read();
          } catch (e) {
            if (!stopped)
              note(opts.onDisconnect?.({ cause: "stream-error", error: e }));
            break;
          }
          if (chunk.done) {
            if (!stopped)
              note(opts.onDisconnect?.({ cause: "stream-end" }));
            break;
          }
          delay = retry.initialMs;
          resetWatchdog();
          buf += decoder.decode(chunk.value, { stream: true });
          for (let sep = buf.indexOf(`

`);sep >= 0; sep = buf.indexOf(`

`)) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const { frame, comments } = parseSseFrame(block);
            for (const text of comments)
              note(opts.onComment?.(text));
            if (!frame)
              continue;
            let ev;
            try {
              ev = JSON.parse(frame.data);
            } catch (e) {
              note(opts.onMalformed?.(frame, e));
              continue;
            }
            const n = opts.cursorOf?.(ev);
            let epochReset = false;
            if (opts.epochOf) {
              const next = opts.epochOf(ev);
              if (typeof next === "string") {
                if (epoch !== null && next !== epoch) {
                  cursor = 0;
                  epochReset = true;
                  const line = opts.onEpochChange?.(next) ?? null;
                  if (line !== null)
                    emit(line);
                  if (askedSince > 0 && typeof n === "number" && n > askedSince) {
                    epoch = next;
                    fromTop = true;
                    break;
                  }
                }
                epoch = next;
              }
            }
            if (opts.restartOnReplay === true && !epochReset && !restartNoted && askedSince >= 0 && typeof n === "number" && n <= askedSince) {
              restartNoted = true;
              cursor = 0;
              const line = opts.onEpochChange?.(opts.epochOf?.(ev) ?? "unknown") ?? null;
              if (line !== null)
                emit(line);
            }
            if (typeof n === "number" && Number.isFinite(n)) {
              cursor = cursorPolicy === "assign" ? n : Math.max(cursor, n);
            }
            const accepted = opts.accept?.(ev, frame) ?? true;
            const isTerminal = opts.terminal?.(ev, frame, accepted) ?? false;
            if (accepted || isTerminal && opts.terminalEmitsFiltered === true) {
              const line = opts.render ? opts.render(ev, frame) : frame.data;
              if (line !== null)
                emit(line);
            }
            if (isTerminal) {
              controller.abort();
              ending = "terminal";
              return code;
            }
          }
          if (fromTop) {
            controller.abort();
            break;
          }
        }
      } finally {
        if (watchdog !== null)
          clearTimeout(watchdog);
        attempt = null;
      }
      if (stopped)
        break;
      if (fromTop) {
        delay = retry.initialMs;
        continue;
      }
      await backoff(delay);
      delay = Math.min(delay * 2, retry.maxMs);
    }
    return code;
  } finally {
    if (useSignals) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    outEmitter.off?.("error", onOutError);
    opts.signal?.removeEventListener("abort", onCallerAbort);
    opts.onEnd?.({ cursor, epoch, reason: ending });
  }
}

// src/kit/wire/tailHandoff.ts
var MONITOR_CAP_MS = 1800000;
var WINDOW_MARGIN_MS = 60000;
var DEFAULT_WINDOW_MS = MONITOR_CAP_MS - WINDOW_MARGIN_MS;
var WINDOW_ENV = "SPELLBOOK_TAIL_WINDOW_MS";
var WINDOW_HELP = "ends itself before Monitor's 30-minute cap with a line naming the next act; a human watching a terminal keeps it open with SPELLBOOK_TAIL_WINDOW_MS=0";
var LOST_AFTER_REFUSALS = 3;
function resolveWindowMs(raw) {
  if (raw === undefined || raw.trim() === "")
    return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WINDOW_MS;
}
var RUN_WITH_LAUNCHER = "bun <this skill's directory>/scripts/cli.ts <command>";
var COME_BACK = (why) => `${why} To bring it back, run ${RUN_WITH_LAUNCHER}; then arm the tail again with no --since, on the session id it prints where there is one (a restarted daemon starts a new event log, so the old bookmark does not apply)`;
function handoff(s, cmd) {
  const base = { spell: s.spell, events: s.events, cursor: s.cursor };
  switch (s.end) {
    case "stopped":
      return null;
    case "closed":
      return {
        type: "tail.closed",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: COME_BACK("the session closed; there is nothing left to watch.")
      };
    case "lost":
      return {
        type: "tail.lost",
        ...base,
        next: "stop",
        command: cmd.comeBack(),
        hint: COME_BACK("lost the daemon (it crashed or was killed); nothing is listening.")
      };
    case "event":
      return {
        type: "tail.woke",
        ...base,
        next: "monitor",
        command: cmd.tail({ since: s.cursor, once: false, ...s.epoch ? { epoch: s.epoch } : {} }),
        hint: `handle the event above, then arm Monitor (timeout_ms 1800000) running ${RUN_WITH_LAUNCHER}`
      };
    case "window":
      if (s.presence || s.events > 0)
        return {
          type: "tail.window",
          ...base,
          next: "monitor",
          command: cmd.tail({
            since: s.cursor,
            once: false,
            ...s.epoch ? { epoch: s.epoch } : {}
          }),
          hint: `the window ended before Monitor's cap; arm Monitor (timeout_ms 1800000) running ${RUN_WITH_LAUNCHER}`
        };
      return {
        type: "tail.quiet",
        ...base,
        next: "background",
        command: cmd.tail({ since: s.cursor, once: true, ...s.epoch ? { epoch: s.epoch } : {} }),
        hint: `nothing on the log this window; run ${RUN_WITH_LAUNCHER} as a background Bash task (run_in_background) \u2014 it exits on the next event`
      };
  }
}
function shellQuote(arg) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}
function parseBookmark(token) {
  const at = token.indexOf("@");
  const id = at === -1 ? token : token.slice(0, at);
  const epoch = at === -1 ? "" : token.slice(at + 1);
  if (!/^-?\d+$/.test(id.trim()))
    return null;
  if (at !== -1 && epoch === "")
    return null;
  return { since: Number.parseInt(id, 10), ...epoch ? { epoch } : {} };
}
function readSince(token, o) {
  const min = o.min ?? -1;
  const b = parseBookmark(token);
  if (b !== null && b.since >= min && (b.epoch === undefined || o.epoch))
    return { ok: true, since: b.since, ...b.epoch ? { epoch: b.epoch } : {} };
  const id = min < 0 ? "an event id (an integer; --since=-1 for everything)" : `an event id (an integer, ${min} or more)`;
  const forms = o.epoch ? `${id}, or <id>@<epoch> as a handoff line prints it` : id;
  const why = !o.epoch && token.includes("@") ? `; this spell's log stamps no epoch, so pass the id without the "@\u2026" part` : "";
  return {
    ok: false,
    message: `--since: "${token}" is not a bookmark this tail accepts \u2014 give ${forms}${why}`
  };
}
function commandLine(argv) {
  return argv.map(shellQuote).join(" ");
}
async function tailWithHandoff(tail, h) {
  const out = tail.out ?? process.stdout;
  const windowMs = h.windowMs ?? resolveWindowMs(process.env[WINDOW_ENV]);
  const counts = h.counts ?? (() => true);
  const endOnLost = !h.presence;
  const ac = new AbortController;
  const onCallerAbort = () => ac.abort();
  tail.signal?.addEventListener("abort", onCallerAbort);
  if (tail.signal?.aborted)
    ac.abort();
  let events = 0;
  let cursor = tail.since;
  let epoch = tail.sinceEpoch;
  let frameHasId = false;
  const isLogFrame = (ev, frame) => frameHasId && counts(ev, frame);
  let end = null;
  let refusals = 0;
  const finish = (e) => {
    if (end === null)
      end = e;
    ac.abort();
  };
  const timer = h.mode === "watch" && windowMs > 0 ? setTimeout(() => finish("window"), windowMs) : null;
  try {
    const code = await tailEvents({
      ...tail,
      signal: ac.signal,
      restartOnReplay: true,
      cursorOf: (ev) => {
        const n = tail.cursorOf?.(ev);
        frameHasId = typeof n === "number" && Number.isFinite(n);
        return n;
      },
      onUnresolved: (s) => {
        const verdict = tail.onUnresolved?.(s) ?? "retry";
        if (verdict === "stop" && end === null)
          end = "closed";
        return verdict;
      },
      render: (ev, frame) => {
        refusals = 0;
        const line2 = tail.render ? tail.render(ev, frame) : frame.data;
        if (line2 !== null && isLogFrame(ev, frame))
          events += 1;
        return line2;
      },
      terminal: (ev, frame, accepted) => {
        if (tail.terminal?.(ev, frame, accepted)) {
          if (end === null)
            end = (h.isClosed ?? (() => true))(ev) ? "closed" : "event";
          return true;
        }
        if (h.mode === "once" && accepted && isLogFrame(ev, frame)) {
          if (end === null)
            end = "event";
          return true;
        }
        return false;
      },
      onComment: (text) => {
        refusals = 0;
        return tail.onComment?.(text) ?? null;
      },
      onDisconnect: (info) => {
        const line2 = tail.onDisconnect?.(info) ?? null;
        if (info.cause === "connect-failed") {
          refusals += 1;
          if (endOnLost && refusals >= LOST_AFTER_REFUSALS)
            finish("lost");
        } else {
          refusals = 0;
        }
        return line2;
      },
      onEnd: (s) => {
        cursor = s.cursor;
        epoch = s.epoch ?? undefined;
        tail.onEnd?.(s);
      }
    });
    const line = handoff({
      end: end ?? "stopped",
      mode: h.mode,
      events,
      cursor,
      ...epoch ? { epoch } : {},
      presence: h.presence,
      spell: h.spell
    }, h.commands);
    if (line !== null)
      out.write(`${JSON.stringify(line)}
`);
    return code;
  } finally {
    if (timer !== null)
      clearTimeout(timer);
    tail.signal?.removeEventListener("abort", onCallerAbort);
  }
}

// src/kit/wire/heartbeat.ts
var MAX_IDLE_TIMEOUT_SEC = 255;
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
var MIN_HEARTBEAT_MS = 500;
function intOr(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function idleTimeoutSec(raw, fallback = MAX_IDLE_TIMEOUT_SEC) {
  return Math.max(1, Math.min(MAX_IDLE_TIMEOUT_SEC, intOr(raw, fallback)));
}
function heartbeatMs(raw, idleSec, fallback = DEFAULT_HEARTBEAT_MS) {
  const ceiling = Math.max(MIN_HEARTBEAT_MS, Math.floor(idleSec * 1000 / 2));
  return Math.min(Math.max(intOr(raw, fallback), MIN_HEARTBEAT_MS), ceiling);
}
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/grapevine/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.GRAPEVINE_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var DEFAULT_SSE_HEARTBEAT_MS = 3000;
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.GRAPEVINE_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_SSE_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/grapevine/backend/cli.ts
var DATA_DIR = process.env.GRAPEVINE_HOME ?? join(homedir(), ".grapevine");
var PORT_FILE = join(DATA_DIR, "daemon.port");
var PID_FILE = join(DATA_DIR, "daemon.pid");
var HOLD_FILE = join(DATA_DIR, "daemon.hold");
var CONFIG_FILE = join(DATA_DIR, "config.json");
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var DAEMON_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "daemon.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "grapevine");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
function readPluginVersion() {
  try {
    const pluginJsonPath = join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    const raw = readFileSync(pluginJsonPath, "utf-8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var _versionCheckDone = false;
async function maybeWarnOnVersionMismatch(port) {
  if (_versionCheckDone)
    return;
  _versionCheckDone = true;
  if (!PLUGIN_VERSION)
    return;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    if (!res.ok)
      return;
    const data = await res.json();
    const daemonVersion = data?.version ?? null;
    if (daemonVersion === null) {
      process.stderr.write(`# grapevine: daemon is older than this CLI (no version reported). ` + `CLI is v${PLUGIN_VERSION}. Some features may silently degrade. ` + `Restart the daemon (drop tails, then \`stop\`, then any verb) to upgrade.
`);
    } else if (daemonVersion !== PLUGIN_VERSION) {
      process.stderr.write(`# grapevine: daemon version (v${daemonVersion}) differs from CLI version (v${PLUGIN_VERSION}). ` + `Some features may silently degrade. Restart the daemon to align.
`);
    }
  } catch {}
}
var DEFAULT_ALIAS = process.env.GRAPEVINE_FROM ?? undefined;
function resolveAlias(flags) {
  return flags.from ?? flags.as ?? DEFAULT_ALIAS;
}
var TRUNCATION_HINT_THRESHOLD = parseInt(process.env.GRAPEVINE_TRUNCATION_HINT_THRESHOLD ?? "2000", 10);
function resolveTailMax(flag) {
  const raw = typeof flag === "string" ? flag : process.env.GRAPEVINE_TAIL_MAX;
  if (raw === undefined)
    return;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function die2(msg, kind = "usage", extra) {
  die(msg, kind, extra);
}
function kindForStatus(status) {
  if (status === 404)
    return "not_found";
  if (status === 409)
    return "conflict";
  if (status >= 400 && status < 500)
    return "usage";
  return "internal";
}
async function readDaemonPort() {
  if (!existsSync(PORT_FILE))
    return null;
  const raw = readFileSync(PORT_FILE, "utf-8").trim();
  const port = parseInt(raw, 10);
  if (!port)
    return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(500)
    });
    if (res.ok) {
      maybeWarnOnVersionMismatch(port);
      return port;
    }
  } catch {}
  try {
    unlinkSync(PORT_FILE);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  return null;
}
function holdActive() {
  try {
    if (!existsSync(HOLD_FILE))
      return null;
    const until = parseInt(readFileSync(HOLD_FILE, "utf-8").trim(), 10);
    if (Number.isFinite(until) && until > Date.now())
      return until;
    try {
      unlinkSync(HOLD_FILE);
    } catch {}
    return null;
  } catch {
    return null;
  }
}
function releaseHold() {
  try {
    if (existsSync(HOLD_FILE))
      unlinkSync(HOLD_FILE);
  } catch {}
}
async function ensureDaemon() {
  let port = await readDaemonPort();
  if (port)
    return port;
  if (holdActive())
    die2("daemon is held (respawn suppressed) \u2014 wait for the hold to clear or run `grapevine roll`", "conflict");
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    die2(`grapevine cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}. ` + "No dist/index.html was found (or SPELLBOOK_SURFACE_MODE=dev is set), so the daemon " + "must run from src/grapevine/ to bundle the watch surface, which a source-free install " + "does not have. Either the shipped dist/ is missing (reinstall the spell) or you are in " + "a checkout without src/grapevine/.", "internal");
  }
  const proc = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd
  });
  proc.unref();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    port = await readDaemonPort();
    if (port)
      return port;
  }
  die2("daemon failed to start within 3s", "internal", {
    hint: "three unrelated causes report this one sentence: the daemon's launcher shape, " + "a wrong spawn path, and a dev-mode daemon dying at its surface import. " + "Run the daemon launcher alone to tell them apart \u2014 it is the launcher shape " + "iff it prints `listening on \u2026` and returns at exit 0. An empty " + "GRAPEVINE_HOME (no `channels/`) means the daemon never bound at all."
  });
}
async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
function printJson2(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function invocationPrefix() {
  const entry = process.argv[1];
  return entry ? `bun ${entry}` : "";
}
function dieApi(data, status) {
  const msg = data?.error ?? `HTTP ${status}`;
  const prefix = invocationPrefix();
  const hint = data?.hint ? prefix ? `try: ${prefix} ${data.hint}` : `try the \`${data.hint}\` verb` : undefined;
  die2(msg, kindForStatus(status), {
    ...hint ? { hint } : {},
    ...data !== null ? { server: data } : {}
  });
}
async function requireChannel(port, name) {
  const { status, data } = await api(port, "GET", `/channels/${name}/topic`);
  if (status >= 400)
    dieApi(data, status);
}
async function cmdOpen(name, opts) {
  if (!name)
    die2("usage: grapevine open <name> [--topic <text>] [--fresh]");
  const port = await ensureDaemon();
  const body = { name, explicit: true };
  if (opts.topic !== undefined)
    body.topic = opts.topic;
  if (opts.from !== undefined)
    body.from = opts.from;
  if (opts.fresh)
    body.fresh = true;
  const { status, data } = await api(port, "POST", "/channels", body);
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true, channel: data });
}
async function cmdTopic(name, text, from) {
  if (!name)
    die2("usage: grapevine topic <channel> [<text>]");
  const port = await ensureDaemon();
  if (text === undefined) {
    const { status: status2, data: data2 } = await api(port, "GET", `/channels/${name}/topic`);
    if (status2 >= 400)
      dieApi(data2, status2);
    printJson2({ ok: true, channel: name, topic: data2?.topic });
    return;
  }
  const ensure = await api(port, "POST", "/channels", { name });
  if (ensure.status >= 400)
    dieApi(ensure.data, ensure.status);
  const { status, data } = await api(port, "PUT", `/channels/${name}/topic`, {
    topic: text,
    from: from ?? "system"
  });
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true, channel: name, topic: data?.topic, id: data?.id });
}
async function cmdList() {
  const port = await readDaemonPort();
  if (!port) {
    printJson2({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { data } = await api(port, "GET", "/channels");
  printJson2({ ok: true, daemon: true, ...data });
}
async function cmdSend(name, from, text, opts) {
  if (!name || !from || !text)
    die2("usage: grapevine send <name> --from <alias> <text...>");
  const port = await ensureDaemon();
  const body = {
    from,
    text
  };
  if (opts.inReplyTo !== undefined)
    body.in_reply_to = opts.inReplyTo;
  const { status, data } = await api(port, "POST", `/channels/${name}/messages`, body);
  if (status >= 400 || !data)
    dieApi(data, status);
  const recip = data.recipients !== undefined ? `${data.recipients} recipient(s)` : `${data.subscribers ?? 0} subscriber(s)`;
  process.stderr.write(`# \u2192 ${data.channel} \xB7 ${recip}
`);
  if (opts.quiet)
    return;
  const out = {
    ok: true,
    id: data.id,
    channel: data.channel,
    subscribers: data.subscribers ?? 0
  };
  if (data.recipients !== undefined)
    out.recipients = data.recipients;
  if (data.subscribers === 0)
    out.warning = "channel has no subscribers";
  else if (data.recipients === 0)
    out.warning = "only you are subscribed";
  if (opts.verbose)
    out.subscriber_aliases = data.subscriber_aliases ?? [];
  printJson2(out);
}
async function cmdAnnounce(from, text, channels, opts) {
  if (!from || !text)
    die2("usage: grapevine announce --from <alias> <text...>");
  const port = await ensureDaemon();
  const body = { from, text };
  if (channels?.length)
    body.channels = channels;
  const { status, data } = await api(port, "POST", "/announce", body);
  if (status >= 400 || !data)
    dieApi(data, status);
  process.stderr.write(`# announced \u2192 ${data.channels.length} channel(s) \xB7 ${data.total_recipients} recipient(s)
`);
  if (opts.quiet)
    return;
  const out = {
    ok: true,
    channels: data.channels,
    total_recipients: data.total_recipients
  };
  if (data.skipped?.length)
    out.skipped = data.skipped;
  if (data.channels.length === 0)
    out.warning = "no active channels to announce to";
  printJson2(out);
}
async function cmdPull(name, since, opts = {}) {
  if (!name)
    die2("usage: grapevine pull <channel> [--since <id>] [--status <value>]");
  const port = await ensureDaemon();
  if (opts.status !== undefined) {
    await requireChannel(port, name);
    const badged = loadChannelMessagesBadged(name);
    const filtered = badged.filter((m) => {
      const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
      return opts.status === "open" ? m.kind === "message" && isOpen(dispArg) : m.disposition === opts.status;
    });
    const lastId = filtered.at(-1)?.id ?? 0;
    printJson2({ ok: true, messages: filtered, cursor: lastId });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${since}`);
  if (status >= 400)
    dieApi(data, status);
  const rawMsgs = data?.messages ?? [];
  const cursor = rawMsgs.at(-1)?.id ?? since;
  const disp = foldDispositions(name);
  const annotated = rawMsgs.filter((m) => !isDispositionFrame(m)).map((m) => {
    const d = disp.get(m.id);
    return d ? { ...m, disposition: d.disposition, reopens: d.reopens } : m;
  });
  printJson2({ ok: true, messages: annotated, cursor });
}
async function cmdRead(name, id, opts) {
  if (!name || !Number.isFinite(id))
    die2("usage: grapevine read <channel> <id> [--text]");
  const port = await ensureDaemon();
  const { status, data } = await api(port, "GET", `/channels/${name}/messages?since=${id - 1}`);
  if (status >= 400)
    dieApi(data, status);
  const msg = (data?.messages ?? []).find((m) => m.id === id);
  if (!msg)
    die2(`message ${id} not found in ${name}`, "not_found");
  const dispMap = foldDispositions(name);
  const d = dispMap.get(id);
  const annotatedMsg = d ? { ...msg, disposition: d.disposition, reopens: d.reopens } : msg;
  if (opts.text) {
    const ts = new Date(msg.ts).toISOString();
    const dispPrefix = d ? d.reopens > 0 ? `[${d.disposition} \u21BB${d.reopens}] ` : `[${d.disposition}] ` : "";
    process.stdout.write(`${dispPrefix}[${msg.id}] ${msg.from} \xB7 ${ts}
${msg.text}
`);
    return;
  }
  printJson2({ ok: true, message: annotatedMsg });
}
async function cmdWait(name, since, timeoutS, alias) {
  if (!name)
    die2("usage: grapevine wait <channel> [--as <alias>] [--since <id>] [--timeout <s>]");
  const port = await ensureDaemon();
  const asParam = alias ? `&as=${encodeURIComponent(alias)}` : "";
  const url = `http://127.0.0.1:${port}/channels/${name}/wait?since=${since}&timeout=${timeoutS}${asParam}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout((timeoutS + 5) * 1000)
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok)
    dieApi(data, res.status);
  printJson2({
    ok: true,
    messages: data?.messages ?? [],
    cursor: data?.cursor ?? since,
    timed_out: !!data?.timed_out
  });
}
async function cmdWho(name) {
  if (!name)
    die2("usage: grapevine who <channel>");
  const port = await readDaemonPort();
  if (!port) {
    printJson2({ ok: true, daemon: false, channel: name, subscribers: [] });
    return;
  }
  const { status, data } = await api(port, "GET", `/channels/${name}/subscribers`);
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true, ...data });
}
async function cmdWhoAll() {
  const port = await readDaemonPort();
  if (!port) {
    printJson2({ ok: true, daemon: false, channels: [] });
    return;
  }
  const { status, data } = await api(port, "GET", "/presence");
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true, ...data });
}
async function cmdAlias(name) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {}
  if (name === undefined) {
    const alias = typeof cfg.alias === "string" && cfg.alias.trim() ? cfg.alias.trim() : null;
    printJson2({ ok: true, alias });
    return;
  }
  const trimmed = name.trim();
  cfg.alias = trimmed;
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}
`);
  printJson2({ ok: true, alias: trimmed || null });
}
async function cmdTail(name, opts) {
  if (!name)
    die2("usage: grapevine tail <name> [--as <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]");
  const myAlias = opts.lurk ? undefined : opts.as;
  const since = opts.fromStart ? 0 : opts.since ?? -1;
  let grounded = opts.since !== undefined;
  let seedFromMarker = since < 0 && opts.last === undefined;
  const again = (at) => commandLine([
    "tail",
    name,
    ...opts.lurk ? ["--lurk"] : myAlias ? ["--as", myAlias] : [],
    ...opts.human && !opts.lurk ? ["--human"] : [],
    ...opts.max !== undefined ? ["--max", String(opts.max)] : [],
    ...at >= 0 ? ["--since", String(at)] : []
  ]);
  return await tailWithHandoff({
    resolve: async () => `http://127.0.0.1:${await ensureDaemon()}`,
    path: `/channels/${name}/tail`,
    since,
    query: (cursor, firstConnect) => {
      const q = { since: String(cursor) };
      if (opts.last !== undefined && firstConnect)
        q.last = String(opts.last);
      if (myAlias)
        q.as = myAlias;
      if (opts.human && !opts.lurk)
        q.human = "1";
      if (opts.lurk)
        q.lurk = "1";
      return q;
    },
    cursorOf: (ev) => {
      if (typeof ev.id === "number")
        return ev.id;
      if (seedFromMarker && typeof ev.latest_id === "number") {
        seedFromMarker = false;
        return ev.latest_id;
      }
      return;
    },
    accept: (ev, frame) => {
      if (frame.event === "subscribed")
        return true;
      if (isDispositionFrame(ev))
        return false;
      if (myAlias && ev.from === myAlias)
        return false;
      return true;
    },
    render: (payload, frame) => {
      if (frame.event === "subscribed")
        return renderSubscribed(payload);
      const readRef = `read ${name} ${payload.id}`;
      if (typeof payload.text === "string" && payload.text.length > (opts.max ?? TRUNCATION_HINT_THRESHOLD)) {
        const truncation_hint = `+${payload.text.length} chars \u2014 full: ${readRef}`;
        const text = opts.max !== undefined ? payload.text.slice(0, opts.max) : payload.text;
        return JSON.stringify({ truncation_hint, ...payload, text });
      }
      return JSON.stringify({ full: readRef, ...payload });
    },
    onComment: (text) => text.trimStart().startsWith("hb") ? ": grapevine-keepalive" : null,
    onMalformed: (_frame, e) => `# bad sse data: ${e instanceof Error ? e.message : String(e)}`,
    onDisconnect: (info) => {
      switch (info.cause) {
        case "connect-failed":
          return `# connect failed: ${info.error instanceof Error ? info.error.message : String(info.error)}, retrying\u2026`;
        case "http":
        case "no-body":
          return `# tail HTTP ${info.status}, retrying\u2026`;
        case "stream-error":
          return `# stream dropped: ${info.error instanceof Error ? info.error.message : String(info.error)}, reconnecting\u2026`;
        case "stream-end":
          return "# stream closed, reconnecting\u2026";
      }
    },
    idleMs: TAIL_IDLE_MS
  }, {
    spell: "grapevine",
    mode: "watch",
    presence: true,
    ...opts.human ? { windowMs: 0 } : {},
    counts: (_ev, frame) => frame.event !== "subscribed",
    commands: {
      tail: ({ since: at }) => again(at),
      comeBack: () => commandLine(["doctor"])
    }
  });
  function renderSubscribed(payload) {
    process.stderr.write(`# subscribed to ${payload.channel} (since=${payload.since})
`);
    if (payload.topic)
      process.stderr.write(`# topic: ${payload.topic}
`);
    if (payload.created)
      process.stderr.write(`# created ${payload.channel} \u2014 this tail brought it into being (check the name)
`);
    if (payload.archived)
      process.stderr.write(`# ${payload.channel} is archived \u2014 read-only; a send will be rejected
`);
    if (grounded)
      return null;
    grounded = true;
    const latest = typeof payload.latest_id === "number" ? payload.latest_id : 0;
    const earlier = since < 0 ? latest : Math.max(0, Math.min(since, latest));
    const hints = [];
    if (earlier > 0)
      hints.push(`${earlier} earlier message(s) exist \u2014 use --from-start or --since <id> to backfill`);
    if (payload.created)
      hints.push(`this tail created ${payload.channel} \u2014 no such channel existed; check the name, or another party has yet to open it`);
    if (payload.archived)
      hints.push(`${payload.channel} is archived \u2014 read-only; a send will be rejected until someone unarchives it`);
    if (!(earlier > 0 || payload.topic || payload.created || payload.archived))
      return null;
    const grounding = {
      kind: "grounding",
      channel: payload.channel,
      joined_at: since < 0 ? latest : Math.min(since, latest),
      earlier
    };
    if (payload.topic)
      grounding.topic = payload.topic;
    if (payload.created)
      grounding.created = true;
    if (payload.archived)
      grounding.archived = true;
    if (hints.length)
      grounding.hint = hints.join(" \xB7 ");
    return JSON.stringify(grounding);
  }
}
function foldDispositions(name) {
  const map = new Map;
  const path = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(path))
    return map;
  for (const line of readFileSync(path, "utf-8").split(`
`)) {
    if (!line.trim())
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind !== "status" || typeof m.target !== "number" || typeof m.disposition !== "string")
      continue;
    const prev = map.get(m.target);
    const reopens = (prev?.reopens ?? 0) + (m.disposition === "open" && prev && prev.disposition !== "open" ? 1 : 0);
    map.set(m.target, {
      disposition: m.disposition,
      from: m.from,
      ts: m.ts,
      note: m.text,
      reopens
    });
  }
  return map;
}
function isDispositionFrame(m) {
  return m.kind === "status" && typeof m.disposition === "string";
}
function isOpen(d) {
  return !d || d.disposition === "open";
}
function loadChannelMessagesBadged(name) {
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath))
    return [];
  const disp = foldDispositions(name);
  const messages = [];
  for (const line of readFileSync(logPath, "utf-8").split(`
`)) {
    if (!line.trim())
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.kind === "status")
      continue;
    const d = disp.get(m.id);
    if (d) {
      messages.push({ ...m, disposition: d.disposition, reopens: d.reopens });
    } else {
      messages.push(m);
    }
  }
  return messages;
}
function renderTriageHuman(name, open, by_status) {
  const line = (m) => {
    const ts = new Date(m.ts).toISOString().slice(0, 16).replace("T", " ");
    const reopen = m.reopens && m.reopens > 0 ? ` \u21BB${m.reopens}` : "";
    const nl = m.text.indexOf(`
`);
    const head = nl === -1 ? m.text : m.text.slice(0, nl);
    const preview = head.length > 100 ? `${head.slice(0, 99)}\u2026` : head;
    return `  [${m.id}${reopen}] ${m.from} \xB7 ${ts} \xB7 ${preview}`;
  };
  const sections = [`${name} \xB7 triage
`, `OPEN (${open.length})`];
  sections.push(open.length ? open.map(line).join(`
`) : "  \u2014");
  for (const [status, items] of Object.entries(by_status)) {
    sections.push(`
${status.toUpperCase()} (${items.length})`, items.map(line).join(`
`));
  }
  return `${sections.join(`
`)}
`;
}
async function cmdTriage(name, opts = {}) {
  if (!name)
    die2("usage: grapevine triage <channel> [--human]");
  const port = await ensureDaemon();
  await requireChannel(port, name);
  const badged = loadChannelMessagesBadged(name);
  const open = [];
  const by_status = {};
  for (const m of badged) {
    const dispArg = m.disposition !== undefined ? { disposition: m.disposition } : undefined;
    if (isOpen(dispArg)) {
      if (m.kind === "message")
        open.push(m);
    } else {
      const key = m.disposition ?? "unknown";
      if (!by_status[key])
        by_status[key] = [];
      by_status[key].push(m);
    }
  }
  if (opts.human) {
    process.stdout.write(renderTriageHuman(name, open, by_status));
    return;
  }
  printJson2({ ok: true, open, by_status });
}
async function cmdGrep(name, pattern, opts) {
  if (!name || !pattern)
    die2("usage: grapevine grep <channel> <pattern> [--literal|-F] [--from <alias>]");
  const logPath = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(logPath)) {
    printJson2({ ok: true, messages: [] });
    return;
  }
  let matcher;
  if (opts.literal) {
    const needle = pattern.toLowerCase();
    matcher = (text) => text.toLowerCase().includes(needle);
  } else {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      die2(`invalid regex: ${e instanceof Error ? e.message : String(e)}`, "usage");
    }
    matcher = (text) => re.test(text);
  }
  const raw = readFileSync(logPath, "utf-8");
  const messages = [];
  for (const line of raw.split(`
`)) {
    if (!line)
      continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof msg.text !== "string")
      continue;
    if (opts.from && msg.from !== opts.from)
      continue;
    if (!matcher(msg.text))
      continue;
    messages.push(msg);
  }
  printJson2({ ok: true, messages });
}
async function cmdClose(name) {
  if (!name)
    die2("usage: grapevine close <name>");
  const port = await readDaemonPort();
  if (!port)
    die2("no daemon running", "not_found");
  const { status, data } = await api(port, "DELETE", `/channels/${name}`);
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true });
}
async function cmdReset(name, opts) {
  if (!name)
    die2("usage: grapevine reset <name> [--force]");
  const port = await ensureDaemon();
  const body = {};
  if (opts.force)
    body.force = true;
  const { status, data } = await api(port, "POST", `/channels/${name}/reset`, body);
  if (status === 409 && data?.error === "live") {
    die2(`channel has ${data.subscribers} live subscriber(s) \u2014 refusing to clear a live session. Re-run with --force to clear anyway (the log is snapshotted first).`, "conflict");
  }
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true, ...data });
}
async function cmdMark(name, id, disposition, from, opts) {
  if (!name || !Number.isFinite(id) || !disposition)
    die2("usage: grapevine mark <channel> <id> <disposition> [--note <text>] [--as <alias>]");
  const port = await ensureDaemon();
  const body = { from, target: id, disposition };
  if (opts.note !== undefined)
    body.note = opts.note;
  const { status, data } = await api(port, "POST", `/channels/${name}/status`, body);
  if (status >= 400 || !data)
    dieApi(data, status);
  printJson2(data);
}
async function cmdArchive(name, unarchive, from) {
  const verb = unarchive ? "unarchive" : "archive";
  if (!name)
    die2(`usage: grapevine ${verb} <channel>`);
  const port = await ensureDaemon();
  const { status, data } = await api(port, "POST", `/channels/${name}/${verb}`, from ? { from } : undefined);
  if (status >= 400)
    dieApi(data, status);
  printJson2({ ok: true, ...data });
}
async function cmdStop(opts = {}) {
  let heldUntil;
  if (opts.holdSeconds && opts.holdSeconds > 0) {
    heldUntil = Date.now() + opts.holdSeconds * 1000;
    try {
      writeFileSync(HOLD_FILE, String(heldUntil));
    } catch {}
  }
  const port = await readDaemonPort();
  if (!port) {
    printJson2({
      ok: true,
      daemon: false,
      ...heldUntil !== undefined ? { held_until: heldUntil } : {}
    });
    return;
  }
  try {
    await api(port, "DELETE", "/");
  } catch {}
  printJson2({
    ok: true,
    stopped: true,
    ...heldUntil !== undefined ? { held_until: heldUntil } : {}
  });
}
async function fetchActiveSubscribers(port) {
  let total = 0;
  const channels = [];
  try {
    const { data } = await api(port, "GET", "/presence");
    for (const ch of data?.channels ?? []) {
      total += ch.connections;
      if (ch.connections > 0)
        channels.push({ name: ch.name, connections: ch.connections });
    }
  } catch {}
  return { total, channels };
}
async function cmdStart() {
  const existing = await readDaemonPort();
  if (!existing && holdActive()) {
    printJson2({ ok: true, held: true, port: null });
    return;
  }
  const port = existing ?? await ensureDaemon();
  printJson2({ ok: true, port, already_running: existing !== null });
}
async function cmdRestart(opts) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh2 = await ensureDaemon();
    printJson2({ ok: true, restarted: true, port: fresh2, previous_pid: null });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die2(`restart: ${total} active subscriber(s) across ${channels.length} channel(s) \u2014 ${where}. ` + "A restart would force them all to reconnect. Re-run with --force (or --yes) to proceed anyway.", "conflict");
  }
  let previousPid = null;
  try {
    const { data } = await api(port, "GET", "/");
    previousPid = data?.pid ?? null;
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      break;
  }
  const fresh = await ensureDaemon();
  printJson2({ ok: true, restarted: true, port: fresh, previous_pid: previousPid });
}
async function probeVersion(port) {
  try {
    const v = (await api(port, "GET", "/")).data?.version ?? null;
    if (v === null) {
      return {
        version: null,
        version_ok: null,
        version_unchecked_reason: "the daemon answered but reported no version"
      };
    }
    return { version: v, version_ok: v === PLUGIN_VERSION, version_unchecked_reason: null };
  } catch (e) {
    return {
      version: null,
      version_ok: null,
      version_unchecked_reason: `could not reach the daemon to verify: ${e instanceof Error ? e.message : String(e)}`
    };
  }
}
async function cmdRoll(opts) {
  const port = await readDaemonPort();
  if (!port) {
    const fresh2 = await ensureDaemon();
    printJson2({
      ok: true,
      rolled: true,
      previous_pid: null,
      port: fresh2,
      ...await probeVersion(fresh2)
    });
    return;
  }
  const { total, channels } = await fetchActiveSubscribers(port);
  if (total > 0 && !opts.force) {
    const where = channels.map((c) => `${c.name} (${c.connections})`).join(", ");
    die2(`roll: ${total} active subscriber(s) \u2014 ${where}. They'll auto-reconnect across the roll. Re-run with --force to proceed.`, "conflict");
  }
  let previousPid = null;
  try {
    previousPid = (await api(port, "GET", "/")).data?.pid ?? null;
  } catch {}
  const holdMs = 4000;
  try {
    writeFileSync(HOLD_FILE, String(Date.now() + holdMs));
  } catch {}
  try {
    await api(port, "DELETE", "/");
  } catch {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      break;
  }
  releaseHold();
  const fresh = await ensureDaemon();
  let pid = null;
  try {
    pid = (await api(fresh, "GET", "/")).data?.pid ?? null;
  } catch {}
  printJson2({
    ok: true,
    rolled: true,
    previous_pid: previousPid,
    pid,
    port: fresh,
    ...await probeVersion(fresh)
  });
}
async function cmdWatch(name) {
  const channel = name?.trim() ? name.trim() : "lobby";
  const port = await ensureDaemon();
  await api(port, "POST", "/channels", { name: channel });
  const url = `http://127.0.0.1:${port}/watch#${encodeURIComponent(channel)}`;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const p = spawn(opener, [url], {
      detached: true,
      stdio: "ignore"
    });
    p.unref();
  } catch {}
  printJson2({ ok: true, channel, url });
}
async function cmdDoctor() {
  const port = await readDaemonPort();
  let authoritative = null;
  let totalSubscribers = 0;
  const busyChannels = [];
  if (port) {
    try {
      const { data } = await api(port, "GET", "/");
      authoritative = { port, ...data };
    } catch {}
    try {
      const { data: presData } = await api(port, "GET", "/presence");
      for (const ch of presData?.channels ?? []) {
        totalSubscribers += ch.connections;
        busyChannels.push({
          name: ch.name,
          subscribers: ch.connections,
          connections: ch.connections,
          named: ch.named,
          anonymous: ch.anonymous
        });
      }
    } catch {}
  }
  const otherDaemons = [];
  const selfPid = authoritative?.pid;
  try {
    for (const pid of await listGrapevineDaemonPids()) {
      if (selfPid && pid === selfPid)
        continue;
      otherDaemons.push(await classifyDaemon(pid));
    }
  } catch {}
  const channelsOnDisk = [];
  try {
    const channelsDir = join(DATA_DIR, "channels");
    if (existsSync(channelsDir)) {
      for (const f of readdirSync(channelsDir)) {
        if (f.endsWith(".jsonl"))
          channelsOnDisk.push(f.replace(/\.jsonl$/, ""));
      }
    }
  } catch {}
  const hints = [];
  if (!authoritative) {
    hints.push("No authoritative daemon running for this HOME. Run any verb (e.g. `cli.ts list`) to spawn one.");
  }
  if (otherDaemons.length > 0) {
    hints.push(`Found ${otherDaemons.length} other grapevine daemon process(es) on this machine. ` + "They may be zombies from past runs OR daemons serving other HOMEs (different GRAPEVINE_HOME).");
    const reapableCount = otherDaemons.filter((d) => d.reapable).length;
    if (reapableCount > 0) {
      hints.push(`Found ${reapableCount} reapable orphan daemon(s). Run \`grapevine reap\` to clear them safely.`);
    }
    if (otherDaemons.some((d) => d.status === "unresponsive")) {
      hints.push("Some daemons are unresponsive; `grapevine reap --force` includes them.");
    }
  }
  if (authoritative && PLUGIN_VERSION && typeof authoritative.version === "string" && authoritative.version !== PLUGIN_VERSION) {
    hints.push(`Authoritative daemon version (${authoritative.version}) differs from this CLI's version (${PLUGIN_VERSION}). ` + "Restart the daemon to align \u2014 drop active tails, then `stop`, then any verb.");
  }
  if (authoritative && (authoritative.version === null || authoritative.version === undefined)) {
    hints.push("Authoritative daemon predates version reporting (pre-V1.6.2). Restart to align.");
  }
  if (totalSubscribers > 0) {
    hints.push(`${totalSubscribers} active subscriber(s) across ${busyChannels.length} channel(s). ` + "Daemon restart would force them to auto-reconnect (works, but disruptive) \u2014 coordinate first.");
  } else if (authoritative) {
    hints.push("No active subscribers \u2014 daemon restart is non-disruptive.");
  }
  for (const ch of busyChannels) {
    if (ch.anonymous > 0) {
      hints.push(`${ch.name}: ${ch.connections} connection(s), ${ch.named} named agent(s) + ` + `${ch.anonymous} anonymous (e.g. a watch tab). The count over the name list is expected, not a ghost.`);
    }
  }
  printJson2({
    ok: true,
    home: DATA_DIR,
    cli_version: PLUGIN_VERSION,
    authoritative,
    active_subscribers: {
      total: totalSubscribers,
      busy_channels: busyChannels
    },
    other_daemons_on_machine: otherDaemons,
    channels_on_disk: channelsOnDisk,
    hints
  });
}
async function cmdInfo() {
  const port = await readDaemonPort();
  if (!port) {
    printJson2({ ok: true, daemon: false });
    return;
  }
  const { data } = await api(port, "GET", "/");
  printJson2({ ok: true, daemon: true, ...data });
}
async function listGrapevineDaemonPids() {
  const pids = [];
  try {
    const proc = spawn("ps", ["-eo", "pid,command"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    proc.stdout?.on("data", (b) => chunks.push(b));
    await new Promise((resolve) => proc.on("exit", () => resolve()));
    const out = Buffer.concat(chunks).toString("utf-8");
    for (const line of out.split(`
`)) {
      if (!line.includes("daemon.ts"))
        continue;
      if (!line.toLowerCase().includes("grapevine"))
        continue;
      const digits = line.match(/^\s*(\d+)\s+/)?.[1];
      if (digits === undefined)
        continue;
      const pid = parseInt(digits, 10);
      if (pid)
        pids.push(pid);
    }
  } catch {}
  return pids;
}
async function lsofListenPort(pid) {
  try {
    const proc = spawn("lsof", ["-aiTCP", "-sTCP:LISTEN", "-p", String(pid), "-P", "-n"], {
      stdio: ["ignore", "pipe", "ignore"]
    });
    const chunks = [];
    proc.stdout?.on("data", (b) => chunks.push(b));
    await new Promise((r) => proc.on("exit", () => r()));
    const digits = Buffer.concat(chunks).toString("utf-8").match(/127\.0\.0\.1:(\d+)/)?.[1];
    return digits === undefined ? null : parseInt(digits, 10);
  } catch {
    return null;
  }
}
async function classifyDaemon(pid) {
  const port = await lsofListenPort(pid);
  if (!port)
    return { pid, port: null, status: "unknown", reapable: false };
  let info = null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(800)
    });
    if (res.ok)
      info = await res.json();
  } catch {}
  if (!info)
    return { pid, port, status: "unresponsive", reapable: false };
  const home = info.data_dir;
  let owns = false;
  try {
    const op = readFileSync(join(home, "daemon.port"), "utf-8").trim();
    const oi = readFileSync(join(home, "daemon.pid"), "utf-8").trim();
    owns = op === String(port) && oi === String(pid);
  } catch {}
  return owns ? {
    pid,
    port,
    home,
    version: info.version ?? null,
    status: "authoritative",
    reapable: false
  } : {
    pid,
    port,
    home,
    version: info.version ?? null,
    status: "orphan",
    reapable: true
  };
}
async function cmdReap(opts) {
  const selfPort = await readDaemonPort();
  let selfPid = null;
  if (selfPort) {
    try {
      selfPid = (await api(selfPort, "GET", "/")).data?.pid ?? null;
    } catch {}
  }
  const pids = await listGrapevineDaemonPids();
  const kept = [], reaped = [], skipped = [];
  for (const pid of pids) {
    const c = await classifyDaemon(pid);
    const isSelf = pid === selfPid;
    const shouldReap = !isSelf && (c.reapable || c.status === "unresponsive" && opts.force === true);
    if (!shouldReap) {
      kept.push(c);
      continue;
    }
    if (opts.dryRun) {
      skipped.push({ ...c, note: "dry-run" });
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      reaped.push(c);
    } catch {
      skipped.push({ ...c, note: "kill failed" });
    }
  }
  printJson2({ ok: true, dry_run: !!opts.dryRun, kept, reaped, skipped });
}
var LEAKED_SEND_RE = /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\b(?:send|announce)\b/;
function looksLikeLeakedSend(text) {
  return LEAKED_SEND_RE.test(text);
}
var SHELL_METACHAR_RE = /`|\$\(|\$\{/;
function looksShellRisky(text) {
  return SHELL_METACHAR_RE.test(text);
}
var CLI_OPTIONS = {
  as: { type: "string" },
  "body-file": { type: "string" },
  channels: { type: "string" },
  from: { type: "string" },
  hold: { type: "string" },
  "in-reply-to": { type: "string" },
  last: { type: "string" },
  max: { type: "string" },
  note: { type: "string" },
  since: { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  topic: { type: "string" },
  all: { type: "boolean" },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  fresh: { type: "boolean" },
  "from-start": { type: "boolean" },
  human: { type: "boolean" },
  literal: { type: "boolean" },
  lurk: { type: "boolean" },
  quiet: { type: "boolean" },
  stdin: { type: "boolean" },
  text: { type: "boolean" },
  verbose: { type: "boolean" },
  yes: { type: "boolean" }
};
var GLOBAL_FLAGS = ["as", "from"];
function sinceOrDie(token) {
  const r = readSince(token, { epoch: false, min: 0 });
  if (!r.ok)
    die2(`tail: ${r.message}`, "usage");
  return r.since;
}
function numericFlag(verb, name, raw, fallback) {
  if (raw === undefined)
    return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    die2(`${verb}: --${name} expects a non-negative number, got ${JSON.stringify(String(raw))}`);
  return n;
}
async function resolveBody(verb, inline, flags) {
  if (flags["body-file"]) {
    const path = flags["body-file"];
    const file = Bun.file(path);
    if (!await file.exists())
      die2(`${verb}: --body-file not found: ${path}`, "not_found");
    return { text: (await file.text()).replace(/\n$/, ""), fromInline: false };
  }
  if (flags.stdin || inline.length === 0 && !process.stdin.isTTY) {
    const buf = [];
    for await (const chunk of process.stdin)
      buf.push(chunk);
    return {
      text: Buffer.concat(buf).toString("utf-8").replace(/\n$/, ""),
      fromInline: false
    };
  }
  return { text: inline.join(" "), fromInline: true };
}
function guardBody(verb, text, fromInline, force) {
  if (!force && looksLikeLeakedSend(text)) {
    die2(`${verb}: that body looks like a leaked grapevine invocation (a fumbled ` + "heredoc?). Nothing was sent. Pipe the real body via --stdin or " + "--body-file <path>, or pass --force to send it anyway.");
  }
  if (fromInline && looksShellRisky(text)) {
    process.stderr.write("# \u26A0 inline body contains shell metacharacters (backtick, $(), curly-brace vars). " + "It was sent as-is, but the shell can command-substitute these before " + `grapevine sees them \u2014 use --body-file or --stdin for code-bearing messages.
`);
  }
}
var identityRequired = (verb) => die2(`${verb}: identity required`, "usage", {
  hint: `pass ${GLOBAL_FLAGS.map((f) => `--${f}`).join("/")} <alias>, or set GRAPEVINE_FROM`,
  choices: GLOBAL_FLAGS.map((f) => `--${f}`)
});
var ROWS = [
  {
    name: "open",
    flags: ["topic", "fresh"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdOpen(positional[0], {
        topic: flags.topic,
        from: resolveAlias(flags),
        fresh: flags.fresh === true
      });
    }
  },
  {
    name: "topic",
    flags: [],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdTopic(positional[0], positional.length > 1 ? positional.slice(1).join(" ") : undefined, resolveAlias(flags));
    }
  },
  {
    name: "list",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdList();
    }
  },
  {
    name: "send",
    flags: ["body-file", "stdin", "quiet", "verbose", "force", "in-reply-to"],
    positionals: [
      { name: "name", required: true },
      { name: "text", required: false, variadic: true }
    ],
    run: async (positional, flags) => {
      const name = positional[0];
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("send", positional.slice(1), flags);
      if (!from)
        identityRequired("send");
      guardBody("send", text, fromInline, !!flags.force);
      await cmdSend(name, from, text, {
        quiet: !!flags.quiet,
        verbose: !!flags.verbose,
        inReplyTo: flags["in-reply-to"] ? numericFlag("send", "in-reply-to", flags["in-reply-to"], 0) : undefined
      });
    }
  },
  {
    name: "announce",
    flags: ["body-file", "stdin", "quiet", "force", "channels"],
    positionals: [{ name: "text", required: false, variadic: true }],
    run: async (positional, flags) => {
      const from = resolveAlias(flags);
      const { text, fromInline } = await resolveBody("announce", positional, flags);
      if (!from)
        identityRequired("announce");
      guardBody("announce", text, fromInline, !!flags.force);
      const channels = flags.channels ? flags.channels.split(",").map((c) => c.trim()).filter(Boolean) : undefined;
      await cmdAnnounce(from, text, channels, { quiet: !!flags.quiet });
    }
  },
  {
    name: "pull",
    flags: ["since", "status"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("pull", "since", flags.since, 0);
      await cmdPull(positional[0], since, { status: flags.status });
    }
  },
  {
    name: "triage",
    flags: ["human"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdTriage(positional[0], { human: !!flags.human });
    }
  },
  {
    name: "read",
    flags: ["text"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true }
    ],
    run: async (positional, flags) => {
      const id = positional[1] ? parseInt(positional[1], 10) : NaN;
      await cmdRead(positional[0], id, { text: !!flags.text });
    }
  },
  {
    name: "wait",
    flags: ["since", "timeout"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      const since = numericFlag("wait", "since", flags.since, 0);
      const timeout = numericFlag("wait", "timeout", flags.timeout, 30);
      await cmdWait(positional[0], since, timeout, resolveAlias(flags));
    }
  },
  {
    name: "who",
    flags: ["all"],
    positionals: [{ name: "name", required: false }],
    run: async (positional, flags) => {
      if (flags.all)
        await cmdWhoAll();
      else
        await cmdWho(positional[0]);
    }
  },
  {
    name: "alias",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdAlias(positional[0]);
    }
  },
  {
    name: "tail",
    flags: ["since", "from-start", "last", "human", "lurk", "max"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      return await cmdTail(positional[0], {
        since: flags.since !== undefined ? sinceOrDie(String(flags.since)) : undefined,
        fromStart: !!flags["from-start"],
        last: flags.last !== undefined ? numericFlag("tail", "last", flags.last, 0) : undefined,
        as: resolveAlias(flags),
        human: !!flags.human,
        lurk: !!flags.lurk,
        max: resolveTailMax(flags.max)
      });
    }
  },
  {
    name: "grep",
    flags: ["literal"],
    positionals: [
      { name: "name", required: true },
      { name: "pattern", required: true, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdGrep(positional[0], positional.slice(1).join(" "), {
        literal: !!flags.literal,
        from: flags.from
      });
    }
  },
  {
    name: "close",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional) => {
      await cmdClose(positional[0]);
    }
  },
  {
    name: "reset",
    flags: ["force"],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdReset(positional[0], { force: flags.force === true });
    }
  },
  {
    name: "mark",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true },
      { name: "disposition", required: true, variadic: true }
    ],
    run: async (positional, flags) => {
      await cmdMark(positional[0], positional[1] === undefined ? Number.NaN : parseInt(positional[1], 10), positional.slice(2).join(" "), resolveAlias(flags) ?? identityRequired("mark"), { note: flags.note });
    }
  },
  {
    name: "reopen",
    flags: ["note"],
    positionals: [
      { name: "name", required: true },
      { name: "id", required: true }
    ],
    run: async (positional, flags) => {
      await cmdMark(positional[0], positional[1] === undefined ? Number.NaN : parseInt(positional[1], 10), "open", resolveAlias(flags) ?? identityRequired("reopen"), { note: flags.note });
    }
  },
  {
    name: "archive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdArchive(positional[0], false, resolveAlias(flags));
    }
  },
  {
    name: "unarchive",
    flags: [],
    positionals: [{ name: "name", required: true }],
    run: async (positional, flags) => {
      await cmdArchive(positional[0], true, resolveAlias(flags));
    }
  },
  {
    name: "start",
    aliases: ["up"],
    flags: [],
    positionals: [],
    run: async () => {
      await cmdStart();
    }
  },
  {
    name: "restart",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRestart({ force: !!flags.force || !!flags.yes });
    }
  },
  {
    name: "roll",
    flags: ["force", "yes"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdRoll({ force: flags.force === true || flags.yes === true });
    }
  },
  {
    name: "stop",
    flags: ["hold"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdStop({
        holdSeconds: flags.hold !== undefined ? numericFlag("stop", "hold", flags.hold, 0) : undefined
      });
    }
  },
  {
    name: "watch",
    flags: [],
    positionals: [{ name: "name", required: false }],
    run: async (positional) => {
      await cmdWatch(positional[0]);
    }
  },
  {
    name: "reap",
    aliases: ["prune"],
    flags: ["force", "dry-run"],
    positionals: [],
    run: async (_positional, flags) => {
      await cmdReap({ force: flags.force === true, dryRun: flags["dry-run"] === true });
    }
  },
  {
    name: "info",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdInfo();
    }
  },
  {
    name: "doctor",
    flags: [],
    positionals: [],
    run: async () => {
      await cmdDoctor();
    }
  },
  {
    name: "version",
    flags: ["human"],
    positionals: [],
    run: (_positional, flags) => {
      if (PLUGIN_VERSION === null)
        die2("version unavailable \u2014 could not read plugin.json", "internal");
      if (flags.human === true)
        process.stdout.write(`grapevine v${PLUGIN_VERSION}
`);
      else
        printJson2({ name: "grapevine", version: PLUGIN_VERSION });
    }
  }
];
var BODY_HINT = "for a message body containing dashes, use --stdin or --body-file, or put it after a bare --";
var on = (h) => (inv) => h(inv.pos, inv.flags);
var cli = defineCli({
  name: "grapevine",
  options: CLI_OPTIONS,
  commands: ROWS.map((r) => ({
    ...r,
    describe: "",
    run: on(r.run),
    ...r.name === "send" || r.name === "announce" ? { rejectHint: BODY_HINT } : {}
  })),
  globalFlags: GLOBAL_FLAGS,
  version: () => ({ name: "grapevine", version: PLUGIN_VERSION ?? "unknown" }),
  help: helpText
});
function helpText() {
  return `grapevine \u2014 agent-to-agent walkie-talkie

Usage:
  grapevine open <name> [--topic <text>] [--fresh]   open/create (auto-unarchives; --fresh clears a dormant channel)
  grapevine list
  grapevine send <name> [--from/--as <alias>] [--quiet] [--verbose] [--stdin] [--body-file <path>] [--force] [--in-reply-to <id>] [<text...>]
                                    # body: inline text, --stdin, --body-file, or piped stdin (default when no inline text)
  grapevine announce [--from/--as <alias>] [--channels a,b,c] [--stdin] [--body-file <path>] [--quiet] [<text...>]
                                    # broadcast one message to every active channel (or --channels)
  grapevine tail <name> [--as/--from <alias>] [--since <id>] [--from-start] [--last <n>] [--human] [--lurk] [--max <n>]
                                    # ${WINDOW_HELP} (--human never ends by itself)
       # --last <n>: backfill the most recent n messages then go live (bounded catch-up for a cold joiner)
  grapevine pull <name> [--since <id>] [--status <value>]   # --status = full-scan filter (open|wontfix|incorporated|\u2026)
  grapevine triage <name>             # full-scan: open messages on top + grouped by_status
  grapevine mark <name> <id> <disposition> [--note <text>]  # set disposition (incorporated|wontfix|deferred|\u2026)
  grapevine reopen <name> <id>        # bounce a message back to open
  grapevine read <name> <id> [--text]   # one full message by id (--text = prose)
  grapevine wait <name> [--since <id>] [--timeout <s>]
  grapevine grep <name> <pattern> [--literal] [--from <alias>]
  grapevine topic <name> [<text>]   # no text \u2192 read current; with text \u2192 update
  grapevine who <name>              # roster; the humans field lists humans
  grapevine alias [<name>]          # set/show your persisted alias (config.json)
  grapevine watch [<name>]          # open browser tab; live chat-bubble view
  grapevine reset <name> [--force]           snapshot the log \u2192 ~/.grapevine/archive, then clear it
  grapevine archive <name>          # read-only: keep history, reject sends
  grapevine unarchive <name>        # bring an archived channel back
  grapevine close <name>            # destructive: delete the message log
  grapevine start                   # ensure the daemon is running (alias: up); no channel
  grapevine restart [--force|--yes] # stop + respawn fresh; --force to override the live-fleet guard
  grapevine roll [--force]          # safe restart (stop+hold+respawn) + version verify \u2014 the recommended deploy step
  grapevine stop [--hold <seconds>] # kill the daemon; --hold suppresses auto-respawn for <s> seconds (upgrade window)
  grapevine info
  grapevine doctor                  # health check \u2014 labels each daemon: authoritative / orphan / unresponsive / unknown
  grapevine reap [--force] [--dry-run]  # kill orphan daemons; --force also kills unresponsive; alias: prune

  grapevine schema                  # this CLI's machine-readable interface description (acc declaration v0)
  grapevine --version               # this CLI's version (alias: -V, version)
  grapevine help                    # this usage (alias: --help, -h)

Output:
  Data commands emit JSON on stdout by DEFAULT; pass --human for prose where a
  command offers it. Diagnostics and warnings go to stderr, never stdout.
  Usage errors exit 2. Each command accepts its OWN flags (plus --as/--from,
  which are global) \u2014 an unknown flag for a verb enumerates that verb's set.

Env:
  GRAPEVINE_FROM   Default identity alias (--from/--as are interchangeable).
  GRAPEVINE_HOME   Data dir (default ~/.grapevine).
`;
}
async function main(argv) {
  try {
    return await cli.dispatch(argv);
  } catch (e) {
    const code = reportCliError(e);
    if (code !== null)
      return code;
    throw e;
  }
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  classifyDaemon,
  cli,
  daemonCwd,
  looksShellRisky,
  probeVersion,
  releaseHold,
  run
};

//# debugId=93C28A4767CD1F2A64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2NsaS9yZWdpc3RyeS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ3JhcGV2aW5lL2JhY2tlbmQvaGVhcnRiZWF0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBncmFwZXZpbmUgQ0xJIOKAlCB0aGluIHdyYXBwZXIgYXJvdW5kIHRoZSBkYWVtb24ncyBIVFRQIHN1cmZhY2UuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiA8bmFtZT5cbi8vICAgYnVuIGNsaS50cyBsaXN0XG4vLyAgIGJ1biBjbGkudHMgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XG4vLyAgIGJ1biBjbGkudHMgdGFpbCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dXG4vLyAgIGJ1biBjbGkudHMgcmVhZCA8bmFtZT4gPGlkPiBbLS10ZXh0XVxuLy8gICBidW4gY2xpLnRzIGNsb3NlIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIHN0b3Bcbi8vICAgYnVuIGNsaS50cyBpbmZvXG4vL1xuLy8gYHRhaWxgIHdyaXRlcyBlYWNoIGluY29taW5nIG1lc3NhZ2UgYXMgb25lIEpTT05MIGxpbmUgb24gc3Rkb3V0LiBQaXBlXG4vLyBvciB3cmFwIHdpdGggTW9uaXRvci5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyB0eXBlIENvbW1hbmRTcGVjLCBkZWZpbmVDbGksIHR5cGUgSW52b2NhdGlvbiB9IGZyb20gXCIuLi8uLi9raXQvY2xpL3JlZ2lzdHJ5LnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEVyckV4dHJhLFxuICB0eXBlIEVycktpbmQsXG4gIGRpZSBhcyByYWlzZSxcbiAgcmVwb3J0Q2xpRXJyb3IsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRMaW5lLFxuICByZWFkU2luY2UsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZi50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5cbmNvbnN0IERBVEFfRElSID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmdyYXBldmluZVwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBvcnRcIik7XG5jb25zdCBQSURfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBpZFwiKTtcbmNvbnN0IEhPTERfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLmhvbGRcIik7XG4vLyBQZXJzaXN0ZWQgaWRlbnRpdHkgY29uZmlnIChWMS43KSDigJQgYGdyYXBldmluZSBhbGlhcyA8bmFtZT5gIHdyaXRlcyBpdDsgdGhlXG4vLyBkYWVtb24gc2VydmVzIGl0IHRvIHRoZSB3YXRjaCB2aWEgR0VUIC9pZGVudGl0eS5cbmNvbnN0IENPTkZJR19GSUxFID0gam9pbihEQVRBX0RJUiwgXCJjb25maWcuanNvblwiKTtcbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG4vLyDim5QgVVAgQU5EIEJBQ0sgRE9XTiwgTkVWRVIgQSBGTEFUIFNJQkxJTkcgKHBsYXlib29rIEI0KS4gVGhpcyByZWFkXG4vLyBgam9pbihTQ1JJUFRfRElSLCBcImRhZW1vbi50c1wiKWAg4oCUIGdsYW1vdXIncyBleGFjdCBzaGlwcGVkIGRlZmVjdCDigJQgd2hpY2ggd2FzXG4vLyB0cnVlIGZvciBleGFjdGx5IGFzIGxvbmcgYXMgdGhlIENMSSBhbmQgdGhlIGRhZW1vbiBzaGFyZWQgYSBmb2xkZXIuIEZyb21cbi8vIGBkaXN0L2AgdGhhdCByZXNvbHZlcyB0byBgZGlzdC9kYWVtb24udHNgLCBhIGZpbGUgdGhhdCBkb2VzIG5vdCBhbmQgbXVzdCBub3Rcbi8vIGV4aXN0LiBUaGUgc3ltcHRvbSBpcyBub3QgYSBjcmFzaDogdGhlIHNwYXduIGZhaWxzIHNpbGVudGx5ICh0aGUgZGFlbW9uJ3Ncbi8vIHN0ZGlvIGlzIGlnbm9yZWQpLCBubyBwb3J0IGZpbGUgZXZlciBhcHBlYXJzLCBhbmQgdGhlIDMgcyBwb2xsIGxvb3AgYmVsb3dcbi8vIHJlcG9ydHMgYGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzYCDigJQgd2hpY2ggaXMgQUxTTyB3aGF0IGEgbGF1bmNoZXJcbi8vIHRoYXQgZXhpdHMgYSBsaXZlIGRhZW1vbiByZXBvcnRzIChENjkpIGFuZCBBTFNPIHdoYXQgYSBkZXYtbW9kZSBkYWVtb24gZHlpbmdcbi8vIGF0IGl0cyBzdXJmYWNlIGltcG9ydCByZXBvcnRzIChzZWUgYGVuc3VyZURhZW1vbmApLiBUaHJlZSBkZWZlY3QgY2xhc3Nlcywgb25lXG4vLyBzZW50ZW5jZTsgdGhpcyBpcyB0aGUgZmlyc3Qgb2YgdGhlIHRocmVlLlxuLy8gYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByZXNvbHZlcyB0aGlzIGFyaXRobWV0aWMgdGhlIHdheSB0aGVcbi8vIHJ1bnRpbWUgd2lsbCwgZnJvbSB0aGUgRU1JVFRFRCBmaWxlJ3Mgb3duIGRpcmVjdG9yeSwgYW5kIGFzc2VydHMgdGhlIGZpbGUgaXNcbi8vIHRoZXJlLlxuY29uc3QgREFFTU9OX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJkYWVtb24udHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIFRoZSB3YXRjaCBzdXJmYWNlIGlzIGJ1aWx0IChzcmMvZ3JhcGV2aW5lL3N1cmZhY2Ug4oaSIGRpc3QvKS4gQnVuIHJlYWRzXG4vLyBidW5maWcudG9tbCAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gaW4gREVWIG1vZGUgdGhlIGRhZW1vbidzXG4vLyBjd2QgTVVTVCBiZSBzcmMvZ3JhcGV2aW5lLyAoc2VhbXMgQ29udHJhY3QgNSkg4oCUIGxhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IGFuZCB0aGUgcGFnZSBmYWlscyAobWVhc3VyZWQgb25cbi8vIGdsYW1vdXI6IEhUVFAgNTAwLCBubyBzdHlsZXNoZWV0IGxpbmspLiBJbiBSRUxFQVNFIG1vZGUgZGlzdC8gaXMgc3RhdGljIGFuZFxuLy8gcHJlLWJ1aWx0LCBubyBidW5maWcgaXMgcmVhZCwgYW5kIHNyYy9ncmFwZXZpbmUvIG5lZWQgbm90IGV4aXN0IGF0IGFsbCAoYVxuLy8gc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSDigJQgc28gdGhlIGN3ZCBzdGF5cyBhdFxuLy8gdGhlIHNraWxsIHJvb3QuIFNhbWUgc2hhcGUgYXMgZ2xhbW91cidzIGRhZW1vbkN3ZCgpLiBFeHBvcnRlZCBmb3IgdGVzdHMuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ3JhcGV2aW5lXCIpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gSFRUUCBwcm90b2NvbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFJlc3BvbnNlIHNoYXBlcyB0aGUgZGFlbW9uIGVtaXRzLiBBbnkgZW5kcG9pbnQgY2FuIGFsc28gcmV0dXJuIGFuIGVycm9yXG4vLyBib2R5IHdpdGggYSA0eHgvNXh4IHN0YXR1cywgc28gZWFjaCBjYXJyaWVzIGFuIG9wdGlvbmFsIGBlcnJvcmAuXG5cbnR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgY2hhbm5lbDogc3RyaW5nO1xuICBmcm9tOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAga2luZDogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgaW5fcmVwbHlfdG8/OiBudW1iZXI7XG4gIHRhcmdldD86IG51bWJlcjtcbiAgZGlzcG9zaXRpb24/OiBzdHJpbmc7XG4gIC8vIENoYW5uZWwtbGV2ZWwgbGlmZWN5Y2xlIGZhY3QgKGFyY2hpdmUgLyB1bmFyY2hpdmUpLiBBIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZVxuICAvLyBjYXJyeWluZyBgZXZlbnRgIGFuZCBubyBgZGlzcG9zaXRpb25gIOKAlCBzZWUgaXNEaXNwb3NpdGlvbkZyYW1lLlxuICBldmVudD86IFwiYXJjaGl2ZWRcIiB8IFwidW5hcmNoaXZlZFwiO1xufTtcblxuLy8gR0VUIC8g4oCUIGRhZW1vbiBsaXZlbmVzcy9pbmZvLlxudHlwZSBSb290SW5mbyA9IHtcbiAgb2s/OiBib29sZWFuO1xuICBwaWQ/OiBudW1iZXI7XG4gIHN0YXJ0ZWRfYXQ/OiBudW1iZXI7XG4gIGNoYW5uZWxzPzogbnVtYmVyO1xuICBkYXRhX2Rpcj86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIOKAlCBtZXNzYWdlIHJlY2VpcHQgd2l0aCBkZWxpdmVyeSBhY2NvdW50aW5nLlxudHlwZSBTZW5kUmVjZWlwdCA9IE1lc3NhZ2UgJiB7XG4gIHN1YnNjcmliZXJzPzogbnVtYmVyO1xuICByZWNpcGllbnRzPzogbnVtYmVyO1xuICBzdWJzY3JpYmVyX2FsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9hbm5vdW5jZSDigJQgY3Jvc3MtY2hhbm5lbCBicm9hZGNhc3QgcmVjZWlwdC5cbnR5cGUgQW5ub3VuY2VSZWNlaXB0ID0ge1xuICBvazogYm9vbGVhbjtcbiAgY2hhbm5lbHM6IHsgbmFtZTogc3RyaW5nOyByZWNpcGllbnRzOiBudW1iZXIgfVtdO1xuICBza2lwcGVkOiB7IG5hbWU6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVtdO1xuICB0b3RhbF9yZWNpcGllbnRzOiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscyDigJQgY2hhbm5lbCBkaXJlY3RvcnkgbGlzdGluZy5cbnR5cGUgQ2hhbm5lbFN1bW1hcnkgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IG51bWJlcjtcbiAgLy8gbnVsbCA9IHRoZSBkYWVtb24gY291bGQgbm90IGVzdGFibGlzaCBhIGNvdW50ICh1bnJlYWRhYmxlIGZpbGUpLCBORVZFUiAwLlxuICAvLyAwIG1lYW5zIFwidGhpcyBjaGFubmVsIGlzIGdlbnVpbmVseSBlbXB0eVwiIGFuZCBub3RoaW5nIGVsc2Ug4oCUIGI1LlxuICBtZXNzYWdlX2NvdW50OiBudW1iZXIgfCBudWxsO1xuICBsYXN0X2FjdGl2aXR5OiBudW1iZXI7XG4gIGxvYWRlZDogYm9vbGVhbjtcbn07XG50eXBlIENoYW5uZWxzUmVzcG9uc2UgPSB7IGNoYW5uZWxzPzogQ2hhbm5lbFN1bW1hcnlbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gQW55IGVuZHBvaW50IG1heSByZXBseSB3aXRoIGp1c3QgYW4gZXJyb3Ivb2sgZW52ZWxvcGUuXG50eXBlIFN0YXR1c1Jlc3BvbnNlID0geyBvaz86IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIGFuZCA/c2luY2U9IHJhbmdlcy5cbnR5cGUgTWVzc2FnZXNSZXNwb25zZSA9IHsgbWVzc2FnZXM/OiBNZXNzYWdlW107IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3dhaXQg4oCUIGxvbmctcG9sbCBiYXRjaC5cbnR5cGUgV2FpdFJlc3BvbnNlID0ge1xuICBtZXNzYWdlcz86IE1lc3NhZ2VbXTtcbiAgY3Vyc29yPzogbnVtYmVyO1xuICB0aW1lZF9vdXQ/OiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbiAgLy8gQSByZWZ1c2FsIG5hbWVzIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0ICg0MDQgb24gYSBtaXNzaW5nIGNoYW5uZWwpLlxuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMg4oCUIG9wZW4vZW5zdXJlIGEgY2hhbm5lbC5cbnR5cGUgT3BlblJlc3BvbnNlID0ge1xuICBuYW1lPzogc3RyaW5nO1xuICBjcmVhdGVkX2F0PzogbnVtYmVyO1xuICBtZXNzYWdlX2NvdW50PzogbnVtYmVyO1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICB1bmFyY2hpdmVkPzogYm9vbGVhbjtcbiAgY2xlYXJlZD86IGJvb2xlYW47XG4gIHNuYXBzaG90Pzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi90b3BpYyBhbmQgUFVUIC9jaGFubmVscy88bmFtZT4vdG9waWMuXG50eXBlIFRvcGljUmVzcG9uc2UgPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBpZD86IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIGhpbnQ/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9zdWJzY3JpYmVycyDigJQgc2luZ2xlLWNoYW5uZWwgcm9zdGVyLlxudHlwZSBTdWJzY3JpYmVyc1Jlc3BvbnNlID0ge1xuICBjaGFubmVsPzogc3RyaW5nO1xuICBzdWJzY3JpYmVycz86IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY291bnQ/OiBudW1iZXI7XG4gIGNvbm5lY3Rpb25zPzogbnVtYmVyO1xuICBuYW1lZD86IG51bWJlcjtcbiAgYW5vbnltb3VzPzogbnVtYmVyO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUGVyLWNoYW5uZWwgcHJlc2VuY2UgZW50cnkgZnJvbSBHRVQgL3ByZXNlbmNlLlxudHlwZSBQcmVzZW5jZUNoYW5uZWwgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgbmFtZWQ6IG51bWJlcjtcbiAgYW5vbnltb3VzOiBudW1iZXI7XG59O1xudHlwZSBQcmVzZW5jZVJlc3BvbnNlID0geyBjaGFubmVscz86IFByZXNlbmNlQ2hhbm5lbFtdOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBTU0UgZnJhbWVzIHB1c2hlZCBvbiBHRVQgL2NoYW5uZWxzLzxuYW1lPi90YWlsLiBUd28gZnJhbWUga2luZHMgYXJyaXZlIG9uXG4vLyB0aGUgc2FtZSBgZGF0YTpgIGxpbmUg4oCUIGEgYHN1YnNjcmliZWRgIGV2ZW50IGFuZCBwZXItbWVzc2FnZSBmcmFtZXMg4oCUIHNvIHRoZVxuLy8gZGVjb2RlZCBwYXlsb2FkIGlzIGEgdW5pb24uIEFsbCBmaWVsZHMgb3B0aW9uYWwgYmVjYXVzZSB0aGUgZnJhbWUgaXNcbi8vIHVudHJ1c3RlZCB3aXJlIGRhdGEgbmFycm93ZWQgYXQgdGhlIHVzZSBzaXRlLlxudHlwZSBUYWlsUGF5bG9hZCA9IHtcbiAgLy8gc3Vic2NyaWJlZC1ldmVudCBmaWVsZHNcbiAgc2luY2U/OiBudW1iZXI7XG4gIGFzPzogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0X2lkPzogbnVtYmVyO1xuICAvLyBUcnVlIHdoZW4gVEhJUyBzdWJzY3JpYmUgY3JlYXRlZCB0aGUgY2hhbm5lbCDigJQgdGhlIHNpZ25hbCB0aGF0IHNlcGFyYXRlc1xuICAvLyBcInF1aWV0IGNoYW5uZWxcIiBmcm9tIFwieW91IHRhaWxlZCBhIG5hbWUgdGhhdCBkaWQgbm90IGV4aXN0XCIuXG4gIGNyZWF0ZWQ/OiBib29sZWFuO1xuICAvLyBUcnVlIHdoZW4gdGhlIGNoYW5uZWwgaXMgYWxyZWFkeSBhcmNoaXZlZCAocmVhZC1vbmx5KSBhdCBzdWJzY3JpYmUgdGltZSDigJRcbiAgLy8gdGhlIHNpZ25hbCBmb3IgYSBMQVRFIGpvaW5lciwgd2hvIHdvdWxkIG90aGVyd2lzZSBsZWFybiBpdCBmcm9tIGEgcmVqZWN0ZWRcbiAgLy8gc2VuZC4gVGhlIGxpZmVjeWNsZSBmcmFtZSBvbmx5IHJlYWNoZXMgYW4gYWdlbnQgdGhhdCB3YXMgY29ubmVjdGVkIGF0IHRoZVxuICAvLyBtb21lbnQsIG9yIHRoYXQgcHVsbHMgaGlzdG9yeS5cbiAgYXJjaGl2ZWQ/OiBib29sZWFuO1xuICAvLyBtZXNzYWdlIGZpZWxkc1xuICBpZD86IG51bWJlcjtcbiAgZnJvbT86IHN0cmluZztcbiAgdGV4dD86IHN0cmluZztcbiAgdHM/OiBudW1iZXI7XG4gIGtpbmQ/OiBcIm1lc3NhZ2VcIiB8IFwidG9waWNcIiB8IFwiYW5ub3VuY2VtZW50XCIgfCBcInN0YXR1c1wiO1xuICAvLyBzaGFyZWRcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuLy8gT3VyIHBsdWdpbiB2ZXJzaW9uIChmcm9tIHBsdWdpbi5qc29uKS4gVXNlZCB0byBkZXRlY3QgY2FjaGUtcGlubmluZ1xuLy8gbWlzbWF0Y2hlcyB3aGVuIHdlIHRhbGsgdG8gYSBkYWVtb24gc3Bhd25lZCBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZFxuLy8gcGF0aC4gQmVzdC1lZmZvcnQ7IG51bGwgaWYgcmVhZCBmYWlscy5cbmZ1bmN0aW9uIHJlYWRQbHVnaW5WZXJzaW9uKCk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBsdWdpbkpzb25QYXRoID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIik7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBsdWdpbkpzb25QYXRoLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykudmVyc2lvbiA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuY29uc3QgUExVR0lOX1ZFUlNJT04gPSByZWFkUGx1Z2luVmVyc2lvbigpO1xuXG4vLyBPbmUtc2hvdCB2ZXJzaW9uLW1pc21hdGNoIGNoZWNrLiBUaGUgZGFlbW9uIG1heSBiZSBmcm9tIGEgZGlmZmVyZW50XG4vLyBjYWNoZWQgcGx1Z2luIHBhdGggdGhhbiB0aGlzIENMSSAoZXhpc3RpbmcgdGFpbCBwcm9jZXNzZXMnIGF1dG8tcmVjb25uZWN0XG4vLyBjYW4gcmFjZSBhIGBzdG9wYCBhbmQgcmVzcGF3biB0aGUgb2xkIGRhZW1vbikuIFdhcm4gb25jZSBwZXIgaW52b2NhdGlvblxuLy8gc28gdGhlIHVzZXIgaGFzIGEgc2lnbmFsIGluc3RlYWQgb2Ygc2lsZW50bHkgZGVncmFkZWQgYmVoYXZpb3IuXG5sZXQgX3ZlcnNpb25DaGVja0RvbmUgPSBmYWxzZTtcbmFzeW5jIGZ1bmN0aW9uIG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKHBvcnQ6IG51bWJlcikge1xuICBpZiAoX3ZlcnNpb25DaGVja0RvbmUpIHJldHVybjtcbiAgX3ZlcnNpb25DaGVja0RvbmUgPSB0cnVlO1xuICBpZiAoIVBMVUdJTl9WRVJTSU9OKSByZXR1cm47IC8vIGNhbid0IGNvbXBhcmUgaWYgd2UgZG9uJ3Qga25vdyBvdXIgb3duIHZlcnNpb25cbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmICghcmVzLm9rKSByZXR1cm47XG4gICAgY29uc3QgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgICBjb25zdCBkYWVtb25WZXJzaW9uID0gZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmIChkYWVtb25WZXJzaW9uID09PSBudWxsKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgZ3JhcGV2aW5lOiBkYWVtb24gaXMgb2xkZXIgdGhhbiB0aGlzIENMSSAobm8gdmVyc2lvbiByZXBvcnRlZCkuIGAgK1xuICAgICAgICAgIGBDTEkgaXMgdiR7UExVR0lOX1ZFUlNJT059LiBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBgICtcbiAgICAgICAgICBgUmVzdGFydCB0aGUgZGFlbW9uIChkcm9wIHRhaWxzLCB0aGVuIFxcYHN0b3BcXGAsIHRoZW4gYW55IHZlcmIpIHRvIHVwZ3JhZGUuXFxuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChkYWVtb25WZXJzaW9uICE9PSBQTFVHSU5fVkVSU0lPTikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIHZlcnNpb24gKHYke2RhZW1vblZlcnNpb259KSBkaWZmZXJzIGZyb20gQ0xJIHZlcnNpb24gKHYke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICAgIGBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBSZXN0YXJ0IHRoZSBkYWVtb24gdG8gYWxpZ24uXFxuYCxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydFxuICB9XG59XG4vLyBHUkFQRVZJTkVfRlJPTSBzZXRzIHRoZSBkZWZhdWx0IC0tZnJvbSAvIC0tYXMgYWxpYXMgc28gYWdlbnRzIGRvbid0IGhhdmVcbi8vIHRvIHJlcGVhdCB0aGVpciBpZGVudGl0eSBvbiBldmVyeSB2ZXJiLiBQZXItdmVyYiBmbGFncyBzdGlsbCBvdmVycmlkZS5cbmNvbnN0IERFRkFVTFRfQUxJQVMgPSBwcm9jZXNzLmVudi5HUkFQRVZJTkVfRlJPTSA/PyB1bmRlZmluZWQ7XG5cbi8vIElkZW50aXR5IGZsYWdzIGFyZSBpbnRlcmNoYW5nZWFibGUgYWNyb3NzIHZlcmJzLiBgc2VuZGAgaGlzdG9yaWNhbGx5IHRvb2tcbi8vIGAtLWZyb21gIHdoaWxlIGB0YWlsYC9gd2FpdGAgdG9vayBgLS1hc2Ag4oCUIHNhbWUgY29uY2VwdCAod2hvIGFtIEkpLCBhbmQgdGhlXG4vLyBhc3ltbWV0cnkgdHJpcHMgeW91IG1pZC1mbG93LiBBY2NlcHQgZWl0aGVyIGV2ZXJ5d2hlcmUgaWRlbnRpdHkgaXMgbWVhbnQsXG4vLyBmYWxsaW5nIGJhY2sgdG8gR1JBUEVWSU5FX0ZST00uIChncmVwJ3MgYC0tZnJvbWAgaXMgYSBkaWZmZXJlbnQgdGhpbmcg4oCUIGFuXG4vLyBhdXRob3IgKmZpbHRlciosIG5vdCBpZGVudGl0eSDigJQgc28gaXQgZG9lc24ndCB1c2UgdGhpcy4pXG5mdW5jdGlvbiByZXNvbHZlQWxpYXMoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIChmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gKGZsYWdzLmFzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gREVGQVVMVF9BTElBUztcbn1cbi8vIFRydW5jYXRpb24taGludCB0aHJlc2hvbGQuIE1lc3NhZ2VzIGxvbmdlciB0aGFuIHRoaXMgZ2V0IGEgYHRydW5jYXRpb25faGludGBcbi8vIGZpZWxkIG9uIHRoZSB0YWlsIEpTT04gc28gY29uc3VtZXJzIChlLmcuIE1vbml0b3IpIGtub3cgdGhlIG5vdGlmaWNhdGlvblxuLy8gcHJldmlldyBpcyBpbmNvbXBsZXRlIGFuZCBzaG91bGQgYHJlYWRgIHRoZSBmdWxsIGJvZHkuIEluIGFnZW50LXRvLWFnZW50XG4vLyB0cmFmZmljLCBsb25nIG1lc3NhZ2VzIGFyZSB0aGUgTk9STSAodGhlIFYxLjYgcm91bmR0YWJsZSBzYXcgbW9zdCBzdWJzdGFudGl2ZVxuLy8gbWVzc2FnZXMgZXhjZWVkIDgwMCksIHNvIGFuIDgwMCBkZWZhdWx0IGZpcmVkIG9uIG5lYXJseSBldmVyeXRoaW5nIGFuZCB0aGVcbi8vIHJlY292ZXJ5IHBhdGggYmVjYW1lIHRoZSBtYWluIHBhdGguIERlZmF1bHQgcmFpc2VkIHRvIDIwMDAgc28gdGhlIGhpbnQgbWFya3Ncbi8vIHRoZSBnZW51aW5lbHktbG9uZyBvdXRsaWVycy4gT3ZlcnJpZGFibGUgdmlhIGVudiB2YXIgZm9yIHR1bmluZy5cbmNvbnN0IFRSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPSBwYXJzZUludChcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPz8gXCIyMDAwXCIsXG4gIDEwLFxuKTtcblxuLy8gT3B0aW9uYWwgaW5saW5lLWJvZHkgY2FwIGZvciBgdGFpbGAgKG9wdC1pbiB2aWEgLS1tYXggPG4+IG9yIEdSQVBFVklORV9UQUlMX01BWCkuXG4vLyBXaGVuIHNldCwgYSBib2R5IGxvbmdlciB0aGFuIHRoZSBjYXAgaXMgdHJ1bmNhdGVkIHRvIGBuYCBjaGFycyBpbiB0aGUgdGFpbFxuLy8gZnJhbWUgKHBsdXMgdGhlIHJlYWQtcG9pbnRlciBoaW50KSwgc28gYSBwdXNoIGNvbnN1bWVyIGNhbiBoYW5kIGl0c1xuLy8gbm90aWZpY2F0aW9uIHN1cmZhY2UgYSBkZWxpYmVyYXRlbHktc2l6ZWQgbGluZS4gVGhlIEZVTEwgbWVzc2FnZSBpcyBhbHdheXNcbi8vIHJldHJpZXZhYmxlIHZpYSBgcmVhZCA8Y2hhbm5lbD4gPGlkPmAuIFVuZGVmaW5lZCA9IG5vIGNhcCAoZnVsbCB0ZXh0IGlubGluZSDigJRcbi8vIHRvZGF5J3MgZGVmYXVsdCkuIE5vdGU6IHRoZSBoYXJkIGNsaXAgYSBjb25zdW1lciB1bHRpbWF0ZWx5IHNlZXMgaXMgc3RpbGwgdGhlXG4vLyBNb25pdG9yL25vdGlmaWNhdGlvbiBsYXllcidzOyAtLW1heCBvbmx5IGJvdW5kcyB0aGUgbGluZSBncmFwZXZpbmUgZW1pdHMuXG4vLyBSZWplY3RzIG5lZ2F0aXZlIC8gbm9uLW51bWVyaWMuXG5mdW5jdGlvbiByZXNvbHZlVGFpbE1heChmbGFnOiB1bmtub3duKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWcgPT09IFwic3RyaW5nXCIgPyBmbGFnIDogcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RBSUxfTUFYO1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3LCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+PSAwID8gbiA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUg4oCUIGBzcmMva2l0L3dpcmUvZXJyb3JzLnRzYCdzIGBkaWVgLCB1bmRlciB0aGlzXG4gKiBzcGVsbCdzIG93biBuYW1lIHNvIDQ2IGNhbGwgc2l0ZXMgZGlkIG5vdCBlYWNoIGhhdmUgdG8gYmUgcmUtc3BlbGxlZC5cbiAqXG4gKiDim5QgKipJVCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIEEgQ0FMTEVSLVZJU0lCTEUgQ0hBTkdFKipcbiAqIChQaGFzZSA2IGNoYXB0ZXIgMjsgdGhlIGRlbHRhIGlzIGRyaXZlbiBhbmQgcmVjb3JkZWQgaW4gdGhlIGpvdXJuYWwpLiBUaGlzXG4gKiBmdW5jdGlvbiB3YXMgYHByb2Nlc3Muc3RkZXJyLndyaXRlKFxcYGdyYXBldmluZTogJHttc2d9XFxuXFxgKTsgcHJvY2Vzcy5leGl0KGNvZGUpYFxuICog4oCUIFBST1NFIGF0IGV4aXQgMiBmb3IgZXZlcnkgZmFpbHVyZSBncmFwZXZpbmUgY291bGQgcHJvZHVjZSwgd2l0aCB0d28gc2l0ZXNcbiAqIHBhc3NpbmcgMS4gQWZ0ZXIgdGhlIGFkb3B0aW9uIGl0IGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciBhbmQgdGhlXG4gKiBhY2MgdGF4b25vbXkncyBjb2RlczogdXNhZ2UgMiwgaW50ZXJuYWwgMSwgbm90X2ZvdW5kIDUsIGNvbmZsaWN0IDYuIEFuIGFnZW50XG4gKiByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlOyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uIGFuZCByZXdvcmRpbmdcbiAqIGl0IG11c3QgbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRpZCB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVkIHByb3NlLlxuICpcbiAqIOKblCAqKkFORCBUSEUgRU5VTUVSQVRJT05TIE1PVkVEIEZST00gUFJPU0UgSU5UTyBgY2hvaWNlc2AuKiogZ3JhcGV2aW5lJ3NcbiAqIHJlamVjdGlvbnMgd2VyZSBzaGFwZWQgZm9yIGFjYydzIGZsYWctc2V0IGV4dHJhY3RvcnMg4oCUIGByZWNvZ25pemVkIGZsYWdzOiAtLWFcbiAqIC0tYmAsIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IGEgcXVhbGlmaWVyIGJldHdlZW4gdGhlIG5vdW4gYW5kIHRoZSBjb2xvblxuICogXCJyZWFkcyBhcyBwcm9zZSwgbm90IGEgc2V0XCIuIFdyYXBwZWQgaW4gSlNPTiB0aGF0IG1hcmtlciBiZWNvbWVzIGEgc3Vic3RyaW5nIG9mXG4gKiBhbiBlc2NhcGVkIHN0cmluZywgc28gaXQgZG9lcyBub3Qgc3RheSBpbiBwcm9zZTogZXZlcnkgZW51bWVyYXRpb24gaXMgbm93IGFcbiAqIGBjaG9pY2VzYCBhcnJheSwgd2hpY2ggaXMgd2hhdCBnbGFtb3VyIChDT05GT1JNQU5UIEwwKSBwdWJsaXNoZXMgYW5kIHdoYXQgdGhlXG4gKiBlbnZlbG9wZSBoYXMgYSBmaWVsZCBmb3IuIFRoZSBydW5uYWJsZSByZWNvdmVyeSDigJQgYHRyeTogYnVuIOKApi9jbGkudHMgb3BlbiB4YCDigJRcbiAqIG1vdmVkIGludG8gYGhpbnRgIGZvciB0aGUgc2FtZSByZWFzb24sIGFuZCBhIGNhbGxlciBub3cgcmVhZHMgYSBmaWVsZCBpbnN0ZWFkXG4gKiBvZiBzcGxpdHRpbmcgYSBzZW50ZW5jZS5cbiAqXG4gKiDimqAgYGRpZWAgaXMgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBzd2FsbG93cywgYW5kIHRoYXQgaXNcbiAqIG5vdyBhIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiBBdWRpdGVkIGJ5IGNhbGwgZ3JhcGggYXQgdGhlXG4gKiBhZG9wdGlvbiAocGxheWJvb2sgQjkpOyB0aGUgY291bnQgaXMgaW4gdGhlIGpvdXJuYWwuXG4gKi9cbmZ1bmN0aW9uIGRpZShtc2c6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgcmFpc2UobXNnLCBraW5kLCBleHRyYSk7XG59XG5cbi8qKlxuICogVGhlIHRheG9ub215IGBraW5kYCBmb3IgYW4gSFRUUCBzdGF0dXMgdGhlIGRhZW1vbiBhbnN3ZXJlZCB3aXRoLlxuICpcbiAqIOKblCBPTkUgTUFQUElORywgTk9UIEEgSlVER0VNRU5UIFBFUiBTSVRFLiBUd2VudHkgb2YgZ3JhcGV2aW5lJ3MgcmFpc2Ugc2l0ZXNcbiAqIGFyZSBcInRoZSBkYWVtb24gc2FpZCBub1wiOyBiZWZvcmUgdGhlIGFkb3B0aW9uIGV2ZXJ5IG9uZSBvZiB0aGVtIGNvbGxhcHNlZCB0b1xuICogZXhpdCAyLCBzbyBhIG1pc3NpbmcgY2hhbm5lbCwgYSBsaXZlLXNlc3Npb24gcmVmdXNhbCBhbmQgYSBicm9rZW4gZGFlbW9uIHdlcmVcbiAqIG9uZSBudW1iZXIgdG8gYW4gYWdlbnQuIFRoZSBkYWVtb24gYWxyZWFkeSBkaXN0aW5ndWlzaGVzIHRoZW0gYnkgc3RhdHVzIOKAlFxuICogNDA0IGZvciBhIGNoYW5uZWwgdGhhdCBkb2VzIG5vdCBleGlzdCwgNDA5IGZvciBhcmNoaXZlZCAvIGxpdmUgLyBhbHJlYWR5LW9wZW5cbiAqIOKAlCBzbyB0aGUgbWFwcGluZyBpcyBhIHJlLXJlYWRpbmcgb2Ygd2hhdCB3YXMgb24gdGhlIHdpcmUsIG5vdCBhIG5ldyBvcGluaW9uLlxuICovXG5mdW5jdGlvbiBraW5kRm9yU3RhdHVzKHN0YXR1czogbnVtYmVyKTogRXJyS2luZCB7XG4gIGlmIChzdGF0dXMgPT09IDQwNCkgcmV0dXJuIFwibm90X2ZvdW5kXCI7XG4gIGlmIChzdGF0dXMgPT09IDQwOSkgcmV0dXJuIFwiY29uZmxpY3RcIjtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgJiYgc3RhdHVzIDwgNTAwKSByZXR1cm4gXCJ1c2FnZVwiO1xuICByZXR1cm4gXCJpbnRlcm5hbFwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkRGFlbW9uUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgaWYgKCFleGlzdHNTeW5jKFBPUlRfRklMRSkpIHJldHVybiBudWxsO1xuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgY29uc3QgcG9ydCA9IHBhcnNlSW50KHJhdywgMTApO1xuICBpZiAoIXBvcnQpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDUwMCksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykge1xuICAgICAgLy8gRmlyZS1hbmQtZm9yZ2V0IG1pc21hdGNoIGNoZWNrICh3b24ndCBibG9jayB0aGUgdmVyYikuXG4gICAgICBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0KTtcbiAgICAgIHJldHVybiBwb3J0O1xuICAgIH1cbiAgfSBjYXRjaCB7fVxuICAvLyBTdGFsZSDigJQgY2xlYW4gdXAuXG4gIHRyeSB7XG4gICAgdW5saW5rU3luYyhQT1JUX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgdW5saW5rU3luYyhQSURfRklMRSk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGhvbGRBY3RpdmUoKTogbnVtYmVyIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKEhPTERfRklMRSkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHVudGlsID0gcGFyc2VJbnQocmVhZEZpbGVTeW5jKEhPTERfRklMRSwgXCJ1dGYtOFwiKS50cmltKCksIDEwKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHVudGlsKSAmJiB1bnRpbCA+IERhdGUubm93KCkpIHJldHVybiB1bnRpbDtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICAgIH0gY2F0Y2gge30gLy8gZXhwaXJlZCDihpIgY2xlYW5cbiAgICByZXR1cm4gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiByZWxlYXNlSG9sZCgpIHtcbiAgdHJ5IHtcbiAgICBpZiAoZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSB1bmxpbmtTeW5jKEhPTERfRklMRSk7XG4gIH0gY2F0Y2gge31cbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGFlbW9uKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKHBvcnQpIHJldHVybiBwb3J0O1xuICBpZiAoaG9sZEFjdGl2ZSgpKVxuICAgIGRpZShcbiAgICAgIFwiZGFlbW9uIGlzIGhlbGQgKHJlc3Bhd24gc3VwcHJlc3NlZCkg4oCUIHdhaXQgZm9yIHRoZSBob2xkIHRvIGNsZWFyIG9yIHJ1biBgZ3JhcGV2aW5lIHJvbGxgXCIsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgLy8gQ2hlY2sgdGhlIGN3ZCBFWElTVFMgYmVmb3JlIHNwYXduaW5nOiB0aGUgZGFlbW9uJ3Mgc3RkaW8gaXMgaWdub3JlZCwgc28gYVxuICAvLyBkZXYtbW9kZSBkYWVtb24gZHlpbmcgYXQgaXRzIHN1cmZhY2UgaW1wb3J0IHdvdWxkIG90aGVyd2lzZSBzdXJmYWNlIG9ubHkgYXNcbiAgLy8gXCJmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzXCIg4oCUIGFuZCBub2RlIHJlcG9ydHMgYSBtaXNzaW5nIGN3ZCBhcyBFTk9FTlQgb25cbiAgLy8gdGhlIGV4ZWN1dGFibGUsIHdoaWNoIHJlYWRzIGFzIFwiYnVuIGlzIG1pc3NpbmdcIi5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKSB7XG4gICAgZGllKFxuICAgICAgYGdyYXBldmluZSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfS4gYCArXG4gICAgICAgIFwiTm8gZGlzdC9pbmRleC5odG1sIHdhcyBmb3VuZCAob3IgU1BFTExCT09LX1NVUkZBQ0VfTU9ERT1kZXYgaXMgc2V0KSwgc28gdGhlIGRhZW1vbiBcIiArXG4gICAgICAgIFwibXVzdCBydW4gZnJvbSBzcmMvZ3JhcGV2aW5lLyB0byBidW5kbGUgdGhlIHdhdGNoIHN1cmZhY2UsIHdoaWNoIGEgc291cmNlLWZyZWUgaW5zdGFsbCBcIiArXG4gICAgICAgIFwiZG9lcyBub3QgaGF2ZS4gRWl0aGVyIHRoZSBzaGlwcGVkIGRpc3QvIGlzIG1pc3NpbmcgKHJlaW5zdGFsbCB0aGUgc3BlbGwpIG9yIHlvdSBhcmUgaW4gXCIgK1xuICAgICAgICBcImEgY2hlY2tvdXQgd2l0aG91dCBzcmMvZ3JhcGV2aW5lLy5cIixcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICApO1xuICB9XG4gIC8vIFNwYXduIGRldGFjaGVkIHNvIHRoZSBkYWVtb24gc3Vydml2ZXMgdGhpcyBDTEkgcHJvY2VzcyBleGl0LlxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgW0RBRU1PTl9TQ1JJUFRdLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIGN3ZCxcbiAgfSk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gV2FpdCB1cCB0byAzcyBmb3IgdGhlIHBvcnQgZmlsZSB0byBhcHBlYXIgYW5kIHJlc3BvbmQuXG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDMwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICAgIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgfVxuICBkaWUoXCJkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiLCBcImludGVybmFsXCIsIHtcbiAgICBoaW50OlxuICAgICAgXCJ0aHJlZSB1bnJlbGF0ZWQgY2F1c2VzIHJlcG9ydCB0aGlzIG9uZSBzZW50ZW5jZTogdGhlIGRhZW1vbidzIGxhdW5jaGVyIHNoYXBlLCBcIiArXG4gICAgICBcImEgd3Jvbmcgc3Bhd24gcGF0aCwgYW5kIGEgZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydC4gXCIgK1xuICAgICAgXCJSdW4gdGhlIGRhZW1vbiBsYXVuY2hlciBhbG9uZSB0byB0ZWxsIHRoZW0gYXBhcnQg4oCUIGl0IGlzIHRoZSBsYXVuY2hlciBzaGFwZSBcIiArXG4gICAgICBcImlmZiBpdCBwcmludHMgYGxpc3RlbmluZyBvbiDigKZgIGFuZCByZXR1cm5zIGF0IGV4aXQgMC4gQW4gZW1wdHkgXCIgK1xuICAgICAgXCJHUkFQRVZJTkVfSE9NRSAobm8gYGNoYW5uZWxzL2ApIG1lYW5zIHRoZSBkYWVtb24gbmV2ZXIgYm91bmQgYXQgYWxsLlwiLFxuICB9KTtcbn1cblxuLy8gR2VuZXJpYyBvdmVyIHRoZSBleHBlY3RlZCBzdWNjZXNzIGJvZHkuIGBkYXRhYCBtYXkgYmUgbnVsbCBpZiB0aGUgcmVzcG9uc2Vcbi8vIGhhZCBubyBKU09OIGJvZHksIHNvIGNhbGxlcnMgc2VlIGBUIHwgbnVsbGAuXG5hc3luYyBmdW5jdGlvbiBhcGk8VCA9IHVua25vd24+KFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiBUIHwgbnVsbCB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogVCB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgVDtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG5cbi8vIEhvdyBUSElTIENMSSB3YXMgaW52b2tlZCwgYXMgYSBydW5uYWJsZSBwcmVmaXguIGBwcm9jZXNzLmFyZ3ZbMV1gIGlzIHRoZVxuLy8gYWJzb2x1dGUgcGF0aCBvZiBjbGkudHMgdW5kZXIgYGJ1biDigKYvY2xpLnRzIDx2ZXJiPmAsIHdoaWNoIGlzIFNLSUxMLm1kJ3Ncbi8vIGNhbm9uaWNhbCBpbnZvY2F0aW9uIOKAlCBzbyB0aGUgbGluZSB3ZSBwcmludCBjYW4gYWN0dWFsbHkgYmUgcGFzdGVkLiBGYWxsc1xuLy8gYmFjayB0byB0aGUgYmFyZSB2ZXJiIGlmIGFyZ3YgaXMgbm90IHNoYXBlZCBhcyBleHBlY3RlZCwgd2hpY2ggaXMgYSB2ZXJiXG4vLyByZWZlcmVuY2UgcmF0aGVyIHRoYW4gYSBjb21tYW5kIHRoYXQgbGllcyBhYm91dCBiZWluZyBvbmUuXG5mdW5jdGlvbiBpbnZvY2F0aW9uUHJlZml4KCk6IHN0cmluZyB7XG4gIGNvbnN0IGVudHJ5ID0gcHJvY2Vzcy5hcmd2WzFdO1xuICByZXR1cm4gZW50cnkgPyBgYnVuICR7ZW50cnl9YCA6IFwiXCI7XG59XG5cbi8vIEEgZGFlbW9uIHJlZnVzYWwgY2FycmllcyBgaGludGAg4oCUIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0IChhIDQwNCBvbiBhXG4vLyByZWFkIG5hbWVzIHRoZSBgb3BlbmAgdGhhdCB3b3VsZCBjcmVhdGUgdGhlIGNoYW5uZWwpLlxuLy9cbi8vIOKaoCBgaGludGAgaXMgYSBWRVJCIElOVk9DQVRJT04sIG5vdCBhIHNoZWxsIGNvbW1hbmQ6IHRoZSBkYWVtb24gY2Fubm90IGtub3dcbi8vIGhvdyBpdHMgY2xpZW50IHdhcyBpbnZva2VkLCBzbyBpdCBuYW1lcyB0aGUgYWN0IGFuZCB3ZSByZW5kZXIgaXQuIEl0IHVzZWQgdG9cbi8vIGFycml2ZSBhcyBgZ3JhcGV2aW5lIG9wZW4gPG5hbWU+YCBhbmQgYmUgcHJpbnRlZCB2ZXJiYXRpbSBhZnRlciBgdHJ5OmAsIHdoaWNoXG4vLyByZWFkcyBhcyBzb21ldGhpbmcgdG8gcGFzdGUg4oCUIGFuZCBwYXN0aW5nIGl0IGdldHMgYGNvbW1hbmQgbm90IGZvdW5kYCxcbi8vIGJlY2F1c2Ugbm90aGluZyBpbnN0YWxscyBhIGBncmFwZXZpbmVgIGJpbmFyeS4gUnVsaW5nIDIgYXNrZWQgdGhhdCBhIHJlZnVzYWxcbi8vIG5hbWUgdGhlIG5leHQgYWN0OyBhIHJlY292ZXJ5IHRoYXQgZmFpbHMgd2hlbiB5b3UgcnVuIGl0IGRvZXMgbm90LlxuZnVuY3Rpb24gZGllQXBpKGRhdGE6IHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1czogbnVtYmVyKTogbmV2ZXIge1xuICBjb25zdCBtc2cgPSBkYXRhPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gO1xuICBjb25zdCBwcmVmaXggPSBpbnZvY2F0aW9uUHJlZml4KCk7XG4gIC8vIOKblCBUSEUgUkVDT1ZFUlkgSVMgQSBGSUVMRCBOT1csIE5PVCBBIFNFTlRFTkNFLiBJdCB1c2VkIHRvIGJlIGFwcGVuZGVkIHRvIHRoZVxuICAvLyBtZXNzYWdlIGFzIGDigJQgdHJ5OiA8Y21kPmAsIHdoaWNoIGEgY2FsbGVyIGhhZCB0byByZWNvdmVyIGJ5IHNwbGl0dGluZyBvblxuICAvLyBcInRyeTogXCIgKG9uZSBvZiBncmFwZXZpbmUncyBvd24gY2VsbHMgZGlkIGV4YWN0bHkgdGhhdCwgYW5kIHJhbiB3aGF0IGl0XG4gIC8vIGZvdW5kKS4gYGhpbnRgIGlzIHdoZXJlIHRoZSBlbnZlbG9wZSBjYXJyaWVzIGl0LCBzbyB0aGUgc2FtZSBjZWxsIG5vdyByZWFkc1xuICAvLyBhIGZpZWxkIGFuZCBydW5zIGl0IOKAlCB0aGUgcHJvcGVydHkgaXMgdW5jaGFuZ2VkIGFuZCB0aGUgcGFyc2UgaXMgbm90IGEgcGFyc2UuXG4gIGNvbnN0IGhpbnQgPSBkYXRhPy5oaW50XG4gICAgPyBwcmVmaXhcbiAgICAgID8gYHRyeTogJHtwcmVmaXh9ICR7ZGF0YS5oaW50fWBcbiAgICAgIDogYHRyeSB0aGUgXFxgJHtkYXRhLmhpbnR9XFxgIHZlcmJgXG4gICAgOiB1bmRlZmluZWQ7XG4gIGRpZShtc2csIGtpbmRGb3JTdGF0dXMoc3RhdHVzKSwge1xuICAgIC4uLihoaW50ID8geyBoaW50IH0gOiB7fSksXG4gICAgLy8gVGhlIHVwc3RyZWFtJ3MgYm9keSBWRVJCQVRJTSwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB3aGF0IHRoZSBkYWVtb25cbiAgICAvLyBhY3R1YWxseSBzYWlkIHJhdGhlciB0aGFuIG9uIHRoaXMgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQuXG4gICAgLi4uKGRhdGEgIT09IG51bGwgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuLy8gRXhpc3RlbmNlIHByb2JlIGZvciB0aGUgcmVhZCB2ZXJicyB0aGF0IGFuc3dlciBmcm9tIHRoZSBMT0cgRklMRSByYXRoZXIgdGhhblxuLy8gZnJvbSBhIHJvdXRlIChgdHJpYWdlYCwgYHB1bGwgLS1zdGF0dXNgKS4gVGhvc2UgY2Fubm90IDQwNCBvbiB0aGVpciBvd246IGFcbi8vIG1pc3NpbmcgbG9nIGlzIGFuIGVtcHR5IGFycmF5LCB3aGljaCBpcyB0aGUgc2FtZSBzaWxlbnQgbGllIHRoZSBkYWVtb24gZ3VhcmRcbi8vIGV4aXN0cyB0byBraWxsLiBHRVQgL3RvcGljIGlzIHRoZSBjaGVhcGVzdCBndWFyZGVkIHJvdXRlLCBzbyBpdCBpcyB0aGUgcHJvYmUuXG5hc3luYyBmdW5jdGlvbiByZXF1aXJlQ2hhbm5lbChwb3J0OiBudW1iZXIsIG5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2AsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7IHRvcGljPzogc3RyaW5nOyBmcm9tPzogc3RyaW5nOyBmcmVzaD86IGJvb2xlYW4gfSxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgb3BlbiA8bmFtZT4gWy0tdG9waWMgPHRleHQ+XSBbLS1mcmVzaF1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4gPSB7IG5hbWUsIGV4cGxpY2l0OiB0cnVlIH07XG4gIGlmIChvcHRzLnRvcGljICE9PSB1bmRlZmluZWQpIGJvZHkudG9waWMgPSBvcHRzLnRvcGljO1xuICBpZiAob3B0cy5mcm9tICE9PSB1bmRlZmluZWQpIGJvZHkuZnJvbSA9IG9wdHMuZnJvbTtcbiAgaWYgKG9wdHMuZnJlc2gpIGJvZHkuZnJlc2ggPSB0cnVlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE9wZW5SZXNwb25zZT4ocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBkYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUb3BpYyhcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICB0ZXh0OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGZyb206IHN0cmluZyB8IHVuZGVmaW5lZCxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgdG9waWMgPGNoYW5uZWw+IFs8dGV4dD5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGlmICh0ZXh0ID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBgdG9waWMgPG5hbWU+YCB3aXRoIG5vIHRleHQgaXMgYSBSRUFEIOKAlCBpdCBhc2tzIHdoYXQgdGhlIHRvcGljIGlzLCBhbmQgYVxuICAgIC8vIG1pc3NpbmcgY2hhbm5lbCBhbnN3ZXJzIHRoYXQgcXVlc3Rpb24gYnkgYmVpbmcgbWlzc2luZy4gTm8gZW5zdXJlOiB0aGVcbiAgICAvLyBlbnN1cmUgd2FzIHdoYXQgcmVzdXJyZWN0ZWQgYSBjbG9zZWQgY2hhbm5lbCBmcm9tIGEgcmVhZCB2ZXJiLlxuICAgIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8VG9waWNSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCk7XG4gICAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBuYW1lLCB0b3BpYzogZGF0YT8udG9waWMgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIGB0b3BpYyA8bmFtZT4gPHRleHQ+YCBpcyBhIFdSSVRFLCBzbyBpdCBtYXkgY3JlYXRlIOKAlCBidXQgaXQgbXVzdCBub3Qgd3JpdGVcbiAgLy8gdG8gYW4gQVJDSElWRUQgY2hhbm5lbC4gVGhlIFBVVCBlbmZvcmNlcyB0aGF0IGl0c2VsZiBub3c7IHRoaXMgZW5zdXJlIHN0YXlzXG4gIC8vIGJlY2F1c2UgRElTQ0FSRElORyBJVFMgU1RBVFVTIGlzIHByZWNpc2VseSB0aGUgYnVnIGJlaW5nIGZpeGVkIGhlcmUuIEJlZm9yZVxuICAvLyB0b2RheSB0aGUgNDA5IHRoYXQgYW5zd2VycyBmb3IgYW4gYXJjaGl2ZWQgbmFtZSB3YXMgdGhyb3duIGF3YXkgYW5kIHRoZSBQVVRcbiAgLy8gdGhhdCBmb2xsb3dlZCBsYW5kZWQ6IGBhcmNoaXZlIHg7IHRvcGljIHggXCJ0XCJgIHJldHVybmVkIG9rOnRydWUsIGV4aXQgMC5cbiAgY29uc3QgZW5zdXJlID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfT4ocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZSB9KTtcbiAgaWYgKGVuc3VyZS5zdGF0dXMgPj0gNDAwKSBkaWVBcGkoZW5zdXJlLmRhdGEsIGVuc3VyZS5zdGF0dXMpO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiUFVUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2AsIHtcbiAgICB0b3BpYzogdGV4dCxcbiAgICBmcm9tOiBmcm9tID8/IFwic3lzdGVtXCIsXG4gIH0pO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBuYW1lLCB0b3BpYzogZGF0YT8udG9waWMsIGlkOiBkYXRhPy5pZCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTGlzdCgpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPENoYW5uZWxzUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL2NoYW5uZWxzXCIpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTZW5kKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGZyb206IHN0cmluZyxcbiAgdGV4dDogc3RyaW5nLFxuICBvcHRzOiB7IHF1aWV0PzogYm9vbGVhbjsgdmVyYm9zZT86IGJvb2xlYW47IGluUmVwbHlUbz86IG51bWJlciB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhZnJvbSB8fCAhdGV4dCkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBzZW5kIDxuYW1lPiAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogeyBmcm9tOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgaW5fcmVwbHlfdG8/OiBudW1iZXIgfSA9IHtcbiAgICBmcm9tLFxuICAgIHRleHQsXG4gIH07XG4gIGlmIChvcHRzLmluUmVwbHlUbyAhPT0gdW5kZWZpbmVkKSBib2R5LmluX3JlcGx5X3RvID0gb3B0cy5pblJlcGx5VG87XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U2VuZFJlY2VpcHQ+KHBvcnQsIFwiUE9TVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICAvLyBUYXJnZXQgZWNobyBvbiBzdGRlcnIg4oCUIGNvbmZpcm1zIFdIRVJFIHRoZSBtZXNzYWdlIGxhbmRlZCBzbyBhIG1pc3JvdXRlZFxuICAvLyByZXBseSAocmlnaHQgcHJvbXB0LCB3cm9uZyBjaGFubmVsKSBpcyBjYXVnaHQgdGhlIGluc3RhbnQgaXQgaGFwcGVucyAoRjkpLlxuICAvLyBPbiBzdGRlcnIgc28gaXQgbmV2ZXIgcG9sbHV0ZXMgdGhlIHN0ZG91dCBKU09OIHJlY2VpcHQsIGFuZCBpdCBmaXJlcyBldmVuXG4gIC8vIHVuZGVyIC0tcXVpZXQgKHRoZSBzYWZldHkgc2lnbmFsIHNob3VsZG4ndCBiZSBzaWxlbmNlZCkuXG4gIGNvbnN0IHJlY2lwID1cbiAgICBkYXRhLnJlY2lwaWVudHMgIT09IHVuZGVmaW5lZFxuICAgICAgPyBgJHtkYXRhLnJlY2lwaWVudHN9IHJlY2lwaWVudChzKWBcbiAgICAgIDogYCR7ZGF0YS5zdWJzY3JpYmVycyA/PyAwfSBzdWJzY3JpYmVyKHMpYDtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMg4oaSICR7ZGF0YS5jaGFubmVsfSDCtyAke3JlY2lwfVxcbmApO1xuICBpZiAob3B0cy5xdWlldCkgcmV0dXJuO1xuICAvLyBUZXJzZSBkZWZhdWx0OiBpZCArIHN1YnNjcmliZXIgY291bnQgKyB2b2lkIHdhcm5pbmcuIC0tdmVyYm9zZSBhbHNvXG4gIC8vIGluY2x1ZGVzIHRoZSBzdWJzY3JpYmVyIGFsaWFzIGxpc3QgKHNhbWUgZGF0YSBhcyB0aGUgYHdob2AgdmVyYixcbiAgLy8gcGlnZ3liYWNrZWQgdG8gYXZvaWQgYW4gZXh0cmEgcm91bmQtdHJpcCB3aGVuIHRoZSBzZW5kZXIgY2FyZXMpLlxuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG9rOiB0cnVlLFxuICAgIGlkOiBkYXRhLmlkLFxuICAgIGNoYW5uZWw6IGRhdGEuY2hhbm5lbCxcbiAgICBzdWJzY3JpYmVyczogZGF0YS5zdWJzY3JpYmVycyA/PyAwLFxuICB9O1xuICAvLyBPbmx5IHN1cmZhY2UgcmVjaXBpZW50cyBpZiB0aGUgZGFlbW9uIGFjdHVhbGx5IGNvbXB1dGVkIGl0LiBEZWZhdWx0aW5nXG4gIC8vIHRvIDAgd2FzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gXCJyZWFsbHkgMFwiIGFuZCBoaWQgc2lsZW50IFYxLjUtZGFlbW9uXG4gIC8vIGRlZ3JhZGF0aW9uIGR1cmluZyBjcm9zcy12ZXJzaW9uIHNlc3Npb25zOyBtaXNzaW5nLW1lYW5zLW1pc3NpbmcgaXMgdGhlXG4gIC8vIGhvbmVzdCBzaWduYWwuXG4gIGlmIChkYXRhLnJlY2lwaWVudHMgIT09IHVuZGVmaW5lZCkgb3V0LnJlY2lwaWVudHMgPSBkYXRhLnJlY2lwaWVudHM7XG4gIGlmIChkYXRhLnN1YnNjcmliZXJzID09PSAwKSBvdXQud2FybmluZyA9IFwiY2hhbm5lbCBoYXMgbm8gc3Vic2NyaWJlcnNcIjtcbiAgZWxzZSBpZiAoZGF0YS5yZWNpcGllbnRzID09PSAwKSBvdXQud2FybmluZyA9IFwib25seSB5b3UgYXJlIHN1YnNjcmliZWRcIjtcbiAgaWYgKG9wdHMudmVyYm9zZSkgb3V0LnN1YnNjcmliZXJfYWxpYXNlcyA9IGRhdGEuc3Vic2NyaWJlcl9hbGlhc2VzID8/IFtdO1xuICBwcmludEpzb24ob3V0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQW5ub3VuY2UoXG4gIGZyb206IHN0cmluZyxcbiAgdGV4dDogc3RyaW5nLFxuICBjaGFubmVsczogc3RyaW5nW10gfCB1bmRlZmluZWQsXG4gIG9wdHM6IHsgcXVpZXQ/OiBib29sZWFuIH0sXG4pIHtcbiAgaWYgKCFmcm9tIHx8ICF0ZXh0KSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGFubm91bmNlIC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiB7IGZyb206IHN0cmluZzsgdGV4dDogc3RyaW5nOyBjaGFubmVscz86IHN0cmluZ1tdIH0gPSB7IGZyb20sIHRleHQgfTtcbiAgaWYgKGNoYW5uZWxzPy5sZW5ndGgpIGJvZHkuY2hhbm5lbHMgPSBjaGFubmVscztcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxBbm5vdW5jZVJlY2VpcHQ+KHBvcnQsIFwiUE9TVFwiLCBcIi9hbm5vdW5jZVwiLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgIyBhbm5vdW5jZWQg4oaSICR7ZGF0YS5jaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykgwrcgJHtkYXRhLnRvdGFsX3JlY2lwaWVudHN9IHJlY2lwaWVudChzKVxcbmAsXG4gICk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgY2hhbm5lbHM6IGRhdGEuY2hhbm5lbHMsXG4gICAgdG90YWxfcmVjaXBpZW50czogZGF0YS50b3RhbF9yZWNpcGllbnRzLFxuICB9O1xuICBpZiAoZGF0YS5za2lwcGVkPy5sZW5ndGgpIG91dC5za2lwcGVkID0gZGF0YS5za2lwcGVkO1xuICBpZiAoZGF0YS5jaGFubmVscy5sZW5ndGggPT09IDApIG91dC53YXJuaW5nID0gXCJubyBhY3RpdmUgY2hhbm5lbHMgdG8gYW5ub3VuY2UgdG9cIjtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFB1bGwobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBzaW5jZTogbnVtYmVyLCBvcHRzOiB7IHN0YXR1cz86IHN0cmluZyB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHB1bGwgPGNoYW5uZWw+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuXG4gIGlmIChvcHRzLnN0YXR1cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gVGhpcyBicmFuY2ggYW5zd2VycyBmcm9tIHRoZSBsb2cgZmlsZSwgc28gaXQgY2Fubm90IDQwNCBvbiBpdHMgb3duLlxuICAgIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICAgIC8vIEZ1bGwtY2hhbm5lbCBzY2FuOiBmaWx0ZXIgYnkgbGF0ZXN0IGRpc3Bvc2l0aW9uLCBzdGF0dXMgZnJhbWVzIGV4Y2x1ZGVkLlxuICAgIGNvbnN0IGJhZGdlZCA9IGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQobmFtZSk7XG4gICAgY29uc3QgZmlsdGVyZWQgPSBiYWRnZWQuZmlsdGVyKChtKSA9PiB7XG4gICAgICBjb25zdCBkaXNwQXJnID0gbS5kaXNwb3NpdGlvbiAhPT0gdW5kZWZpbmVkID8geyBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbiB9IDogdW5kZWZpbmVkO1xuICAgICAgLy8gYC0tc3RhdHVzIG9wZW5gIG1pcnJvcnMgdHJpYWdlJ3Mgb3BlbiBidWNrZXQ6IHNpZ25hbC1vbmx5LCBzbyBub24tbWVzc2FnZVxuICAgICAgLy8gRllJcyAodG9waWMvYW5ub3VuY2VtZW50KSBhcmUgZXhjbHVkZWQgZnJvbSB0aGUgYWN0aW9uYWJsZSBxdWV1ZS5cbiAgICAgIHJldHVybiBvcHRzLnN0YXR1cyA9PT0gXCJvcGVuXCJcbiAgICAgICAgPyBtLmtpbmQgPT09IFwibWVzc2FnZVwiICYmIGlzT3BlbihkaXNwQXJnKVxuICAgICAgICA6IG0uZGlzcG9zaXRpb24gPT09IG9wdHMuc3RhdHVzO1xuICAgIH0pO1xuICAgIGNvbnN0IGxhc3RJZCA9IGZpbHRlcmVkLmF0KC0xKT8uaWQgPz8gMDtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IGZpbHRlcmVkLCBjdXJzb3I6IGxhc3RJZCB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaW5jZS13aW5kb3cgcGF0aCAodW5jaGFuZ2VkIGZyb20gVGFzayAyKS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzP3NpbmNlPSR7c2luY2V9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBjb25zdCByYXdNc2dzID0gZGF0YT8ubWVzc2FnZXMgPz8gW107XG4gIGNvbnN0IGN1cnNvciA9IHJhd01zZ3MuYXQoLTEpPy5pZCA/PyBzaW5jZTtcbiAgY29uc3QgZGlzcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGFubm90YXRlZCA9IHJhd01zZ3NcbiAgICAvLyBEaXNwb3NpdGlvbiBmcmFtZXMgb25seSDigJQgYSBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSBzdGF5cyBpblxuICAgIC8vIHRoZSBoaXN0b3J5IGFuIGFnZW50IHB1bGxzOyBpdCBpcyBob3cgaXQgbGVhcm5zIHRoZSBjaGFubmVsIHdhcyByZXRpcmVkLlxuICAgIC5maWx0ZXIoKG0pID0+ICFpc0Rpc3Bvc2l0aW9uRnJhbWUobSkpXG4gICAgLm1hcCgobSkgPT4ge1xuICAgICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgICAgcmV0dXJuIGQgPyB7IC4uLm0sIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSA6IG07XG4gICAgfSk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogYW5ub3RhdGVkLCBjdXJzb3IgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYWQobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBpZDogbnVtYmVyLCBvcHRzOiB7IHRleHQ/OiBib29sZWFuIH0pIHtcbiAgaWYgKCFuYW1lIHx8ICFOdW1iZXIuaXNGaW5pdGUoaWQpKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHJlYWQgPGNoYW5uZWw+IDxpZD4gWy0tdGV4dF1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQnVpbHQgb24gdGhlIGV4aXN0aW5nIHJhbmdlIGZldGNoIOKAlCBgc2luY2U9aWQtMWAgcmV0dXJucyBpZCBhbmQgYmV5b25kO1xuICAvLyB3ZSBwaWNrIHRoZSBleGFjdCBpZC4gTm8gZGFlbW9uIEFQSSBjaGFuZ2UuIFRoaXMgaXMgdGhlIHRhcmdldGVkXG4gIC8vIFwiZ2l2ZSBtZSBtZXNzYWdlIE4gaW4gZnVsbFwiIHZlcmIgdGhhdCByZWNvdmVycyBhIGNsaXBwZWQgdGFpbCBwcmV2aWV3XG4gIC8vIHdpdGhvdXQgdGhlIHB1bGwtcmFuZ2UgKyBqcSBkYW5jZS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzP3NpbmNlPSR7aWQgLSAxfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgbXNnID0gKGRhdGE/Lm1lc3NhZ2VzID8/IFtdKS5maW5kKChtKSA9PiBtLmlkID09PSBpZCk7XG4gIGlmICghbXNnKSBkaWUoYG1lc3NhZ2UgJHtpZH0gbm90IGZvdW5kIGluICR7bmFtZX1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgZGlzcE1hcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGQgPSBkaXNwTWFwLmdldChpZCk7XG4gIGNvbnN0IGFubm90YXRlZE1zZyA9IGQgPyB7IC4uLm1zZywgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbXNnO1xuICBpZiAob3B0cy50ZXh0KSB7XG4gICAgLy8gUHJvc2UgbW9kZTogaGVhZGVyICsgYm9keSwgbm8gSlNPTiBlbnZlbG9wZSwgc28gYSBodW1hbiAob3IgYW4gYWdlbnRcbiAgICAvLyByZWNvdmVyaW5nIGEgdHJ1bmNhdGVkIG5vdGlmaWNhdGlvbikgY2FuIHJlYWQgaXQgZGlyZWN0bHkuXG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZShtc2cudHMpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgZGlzcFByZWZpeCA9IGRcbiAgICAgID8gZC5yZW9wZW5zID4gMFxuICAgICAgICA/IGBbJHtkLmRpc3Bvc2l0aW9ufSDihrske2QucmVvcGVuc31dIGBcbiAgICAgICAgOiBgWyR7ZC5kaXNwb3NpdGlvbn1dIGBcbiAgICAgIDogXCJcIjtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtkaXNwUHJlZml4fVske21zZy5pZH1dICR7bXNnLmZyb219IMK3ICR7dHN9XFxuJHttc2cudGV4dH1cXG5gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2U6IGFubm90YXRlZE1zZyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2FpdChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICB0aW1lb3V0UzogbnVtYmVyLFxuICBhbGlhczogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB3YWl0IDxjaGFubmVsPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS10aW1lb3V0IDxzPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gR2l2ZSB0aGUgSFRUUCBmZXRjaCBhIHNsaWdodGx5IGhpZ2hlciBhYm9ydCB0aW1lb3V0IHRoYW4gdGhlIGRhZW1vbidzXG4gIC8vIGxvbmctcG9sbCB0aW1lb3V0IHNvIHRoZSBkYWVtb24gYWx3YXlzIHdpbnMgdGhlIHRpbWVvdXQgcmFjZS5cbiAgLy8gYD9hcz08YWxpYXM+YCByZWdpc3RlcnMgcHJlc2VuY2Ugb24gdGhlIGNoYW5uZWwgZm9yIHRoZSB3YWl0IGR1cmF0aW9uIOKAlFxuICAvLyB3YWl0IGlzIGxvbmctcG9sbCAocHVzaC1zaGFwZWQgd2l0aCBhIGRlYWRsaW5lKSBzbyBpdCBkZXNlcnZlcyBwcmVzZW5jZS5cbiAgY29uc3QgYXNQYXJhbSA9IGFsaWFzID8gYCZhcz0ke2VuY29kZVVSSUNvbXBvbmVudChhbGlhcyl9YCA6IFwiXCI7XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vY2hhbm5lbHMvJHtuYW1lfS93YWl0P3NpbmNlPSR7c2luY2V9JnRpbWVvdXQ9JHt0aW1lb3V0U30ke2FzUGFyYW19YDtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KCh0aW1lb3V0UyArIDUpICogMTAwMCksXG4gIH0pO1xuICBsZXQgZGF0YTogV2FpdFJlc3BvbnNlIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBXYWl0UmVzcG9uc2U7XG4gIH0gY2F0Y2gge31cbiAgaWYgKCFyZXMub2spIGRpZUFwaShkYXRhLCByZXMuc3RhdHVzKTtcbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBtZXNzYWdlczogZGF0YT8ubWVzc2FnZXMgPz8gW10sXG4gICAgY3Vyc29yOiBkYXRhPy5jdXJzb3IgPz8gc2luY2UsXG4gICAgdGltZWRfb3V0OiAhIWRhdGE/LnRpbWVkX291dCxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdobyhuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdobyA8Y2hhbm5lbD5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbDogbmFtZSwgc3Vic2NyaWJlcnM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN1YnNjcmliZXJzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vc3Vic2NyaWJlcnNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXaG9BbGwoKSB7XG4gIC8vIENyb3NzLWNoYW5uZWwgcm9zdGVyIOKAlCBuYW1lcyDDlyBjaGFubmVsIGluIG9uZSBjYWxsLCBzbyB5b3UgZG9uJ3QgZmFuIG91dFxuICAvLyBOIGB3aG9gIGNhbGxzICsgYSBtYW51YWwgam9pbiB0byBhbnN3ZXIgXCJ3aG8gaXMgb24gd2hpY2ggdmluZT9cIi5cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEdldCBvciBzZXQgdGhlIHBlcnNpc3RlZCBkZWZhdWx0IGFsaWFzIChWMS43KS4gV2l0aCBubyBhcmd1bWVudCwgcHJpbnRzIHRoZVxuLy8gY3VycmVudCBhbGlhczsgd2l0aCBvbmUsIHdyaXRlcyBpdCB0byBjb25maWcuanNvbi4gUHVyZSBmaWxlIEkvTyDigJQgd29ya3Ncbi8vIHdpdGhvdXQgYSBydW5uaW5nIGRhZW1vbi4gVGhlIHdhdGNoIHN1cmZhY2UgcmVhZHMgaXQgdmlhIEdFVCAvaWRlbnRpdHkgc28gdGhlXG4vLyBodW1hbiBoYXMgYSBjb25zaXN0ZW50IG5hbWUgYWNyb3NzIGV2ZXJ5IGdyYXBldmluZS5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFsaWFzKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBsZXQgY2ZnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICB0cnkge1xuICAgIGNmZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKENPTkZJR19GSUxFLCBcInV0Zi04XCIpKTtcbiAgfSBjYXRjaCB7fVxuICBpZiAobmFtZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgYWxpYXMgPSB0eXBlb2YgY2ZnLmFsaWFzID09PSBcInN0cmluZ1wiICYmIGNmZy5hbGlhcy50cmltKCkgPyBjZmcuYWxpYXMudHJpbSgpIDogbnVsbDtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgYWxpYXMgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHRyaW1tZWQgPSBuYW1lLnRyaW0oKTtcbiAgY2ZnLmFsaWFzID0gdHJpbW1lZDtcbiAgbWtkaXJTeW5jKERBVEFfRElSLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhDT05GSUdfRklMRSwgYCR7SlNPTi5zdHJpbmdpZnkoY2ZnLCBudWxsLCAyKX1cXG5gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFsaWFzOiB0cmltbWVkIHx8IG51bGwgfSk7XG59XG5cbi8qKlxuICogVGhlIHN0YW5kaW5nIHRhaWwg4oCUIGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2AsIGFkb3B0ZWQgYXQgUGhhc2UgNiBjaGFwdGVyIDIuXG4gKlxuICog4puUIFdIQVQgVEhJUyBSRVBMQUNFRCwgQU5EIFdIQVQgSVQgQk9VR0hULiBUaGlzIHZlcmIgd2FzIDIyMCBsaW5lcyBvZlxuICogaGFuZC13cml0dGVuIHJlY29ubmVjdCBsb29wOiB0aHJlZSBuZXN0ZWQgbG9vcHMgKHJlY29ubmVjdCAvIHJlYWQgLyBmcmFtZVxuICogZHJhaW4pLCBpdHMgb3duIFNTRSBzcGxpdHRlciwgaXRzIG93biBiYWNrb2ZmLCBhbmQgYSBgcHJvY2Vzcy5leGl0KDApYCBpbiBhXG4gKiBzaWduYWwgaGFuZGxlciBzZXZlbiBsaW5lcyBpbi4gVGhlIHNoYXJlZCBjbGllbnQgaXMgdGhlIHNhbWUgZGVzaWduLCBvbmNlLCBhbmRcbiAqIHRocmVlIHRoaW5ncyBhcnJpdmUgd2l0aCBpdCB0aGF0IGdyYXBldmluZSBkaWQgbm90IGhhdmU6XG4gKlxuICogICAxLiAqKkFOIElETEUgV0FUQ0hET0cg4oCUIGdyYXBldmluZSBoYWQgTk9ORS4qKiBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgd2FzXG4gKiAgICAgIHVuYm91bmRlZCwgc28gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kIG9yIGFcbiAqICAgICAgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgRk9SRVZFUiwgYW5kIGEgcGFya2VkIHRhaWwgaXNcbiAqICAgICAgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHF1aWV0IGNoYW5uZWwuIGBUQUlMX0lETEVfTVNgIGlzIHRocmVlIG9mIFRISVNcbiAqICAgICAgc3BlbGwncyAzIHMgYmVhdHMgKGAuL2hlYXJ0YmVhdC50c2ApLCBuZXZlciBhIGNvcGllZCA0NSwwMDAuXG4gKiAgIDIuICoqQSBTUEVDLUNPUlJFQ1QgRlJBTUUgUEFSU0VSLioqIFRoZSBoYW5kLXdyaXR0ZW4gb25lIGRpZFxuICogICAgICBgbGluZS5zbGljZSg1KS50cmltKClgLCB3aGljaCBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gdGhlIG9uZVxuICogICAgICBsZWFkaW5nIHNwYWNlIHRoZSBzcGVjIHJlbW92ZXMg4oCUIGl0IHdvdWxkIGNvcnJ1cHQgYSBtZXNzYWdlIGJvZHkgd2hvc2VcbiAqICAgICAgZmlyc3QgbGluZSBpcyBpbmRlbnRlZC4gTm90aGluZyBpbiB0aGUgcm9zdGVyIGVtaXRzIG9uZSB0b2RheTsgdGhlIHBhcnNlXG4gKiAgICAgIGlzIHJpZ2h0IGFueXdheSBub3cuXG4gKiAgIDMuICoqQSBTSUdOQUwgUEFUSCBUSEFUIERSQUlOUy4qKiBUaGUgb2xkIGhhbmRsZXIgd2FzXG4gKiAgICAgIGBzdG9wcGVkID0gdHJ1ZTsgcHJvY2Vzcy5leGl0KDApYCDigJQgdGhlIFAwZiBkZWZlY3QgZXhhY3RseSwgYXBwbGllZCB0b1xuICogICAgICB0aGUgdGVybWluYWwgZnJhbWUgaW4gZml2ZSBzcGVsbHMgYW5kIE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlXG4gKiAgICAgIGxpbmVzIGFib3ZlIGl0LiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZFxuICogICAgICBzdGRvdXQuIFRoZSBjbGllbnQgUkVUVVJOUyBhbiBleGl0IGNvZGU7IGBtYWluYCBhc3NpZ25zIGl0IGFuZCByZXR1cm5zXG4gKiAgICAgIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucy5cbiAqXG4gKiDim5QgTk8gYGVwb2NoT2ZgIC8gYG9uRXBvY2hDaGFuZ2VgLCBBTkQgVEhBVCBJUyBBIFJVTElORywgTk9UIEFOIE9NSVNTSU9OXG4gKiAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZSBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCDigJQgYGxvYWRDaGFubmVsKClgXG4gKiBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIGhpZ2gtd2F0ZXIgbWFyayBvdmVyIHRoZSBkdXJhYmxlIGAuanNvbmxgIOKAlCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgY3Vyc29yIGlzIHN0aWxsIHZhbGlkIGFuZCB0aGUgY29uZGl0aW9uIGFuIGVwb2NoIGRldGVjdHMgY2Fubm90XG4gKiBvY2N1ciBoZXJlLiBXaXJpbmcgb25lIHdvdWxkIGJlIGEgUkVHUkVTU0lPTiB3aXRoIGEgbWVhc3VyZWQgbWVjaGFuaXNtOlxuICogYG9uRXBvY2hDaGFuZ2VgIHNldHMgYGN1cnNvciA9IDBgLCBhbmQgdGhpcyBkYWVtb24gYW5zd2VycyBgc2luY2U9MGAgd2l0aFxuICogYHJlYWRCYWNrbG9nKG5hbWUsIDApYCDigJQgdGhlIHdob2xlIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuIGFnZW50J3MgcGlwZSxcbiAqIG9uIGV2ZXJ5IGBncmFwZXZpbmUgcm9sbGAuXG4gKlxuICog4pqgIGByZXNvbHZlYCBDQUxMUyBgZW5zdXJlRGFlbW9uYCwgV0hJQ0ggQ0FOIFJBSVNFIOKAlCBkZWxpYmVyYXRlbHksIGFuZCB0aGUga2l0XG4gKiBkb2N1bWVudHMgdGhlIHByb3BlcnR5IHRoaXMgZGVwZW5kcyBvbjogaXRzIG91dGVyIGJsb2NrIGlzIGEgYHRyeWAvYGZpbmFsbHlgXG4gKiB3aXRoIE5PIGBjYXRjaGAsIHNvIGEgYENsaUVycm9yYCBmcm9tIHRocmVlIGZyYW1lcyBkb3duIHByb3BhZ2F0ZXMgaW50b1xuICogYG1haW5gIGluc3RlYWQgb2YgYmVpbmcgcmVhZCBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmQgcmV0cmllZCBmb3JldmVyLlxuICogQ2hlY2tlZCBhdCB0aGUgYWRvcHRpb24gcmF0aGVyIHRoYW4gYXNzdW1lZCAocGxheWJvb2sgQjkgc3RlcCA1KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7XG4gICAgc2luY2U/OiBudW1iZXI7XG4gICAgZnJvbVN0YXJ0PzogYm9vbGVhbjtcbiAgICBsYXN0PzogbnVtYmVyO1xuICAgIGFzPzogc3RyaW5nO1xuICAgIGh1bWFuPzogYm9vbGVhbjtcbiAgICBsdXJrPzogYm9vbGVhbjtcbiAgICBtYXg/OiBudW1iZXI7XG4gIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIW5hbWUpXG4gICAgZGllKFxuICAgICAgXCJ1c2FnZTogZ3JhcGV2aW5lIHRhaWwgPG5hbWU+IFstLWFzIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XSBbLS1odW1hbl0gWy0tbHVya10gWy0tbWF4IDxuPl1cIixcbiAgICApO1xuICAvLyAtLWx1cmsgcmVjZWl2ZXMgbWVzc2FnZXMgYnV0IHJlZ2lzdGVycyBubyBwcmVzZW5jZSDigJQgYW4gaW52aXNpYmxlIG9ic2VydmVyLlxuICAvLyBJdCBvdmVycmlkZXMgaWRlbnRpdHkgZmxhZ3MgKGEgbHVya2VyIGhhcyBubyBuYW1lIHRvIHNob3cpLlxuICBjb25zdCBteUFsaWFzID0gb3B0cy5sdXJrID8gdW5kZWZpbmVkIDogb3B0cy5hcztcbiAgY29uc3Qgc2luY2UgPSBvcHRzLmZyb21TdGFydCA/IDAgOiAob3B0cy5zaW5jZSA/PyAtMSk7XG4gIC8vIEVtaXQgdGhlIGdyb3VuZGluZyBsaW5lIG9ubHkgb24gdGhlIGZpcnN0IHN1YnNjcmliZSwgbmV2ZXIgb24gcmVjb25uZWN0c1xuICAvLyAoYSByZWNvbm5lY3QgcmVzdW1lcyBmcm9tIHRoZSBjdXJzb3Ig4oCUIHRoZXJlIGlzIG5vIHVuc2VlbiBoaXN0b3J5IHRoZW4pLlxuICAvLyDim5QgQU5EIE5FVkVSIE9OIEEgYC0tc2luY2VgIFJFLUFSTSAoYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCwgQTMpOiB0aGVcbiAgLy8gYWdlbnQgYWxyZWFkeSBrbm93cyB0aGUgY2hhbm5lbCwgYW5kIHRoZSBoaXN0b3J5IGhpbnQgd291bGQgYmUgbm9pc2UuXG4gIGxldCBncm91bmRlZCA9IG9wdHMuc2luY2UgIT09IHVuZGVmaW5lZDtcbiAgLy8g4puUIFRIRSBCT09LTUFSSyBGT1IgQSBMSVZFLU9OTFkgVEFJTC4gYHNpbmNlID0gLTFgIGFza3MgZm9yIG5vIGhpc3RvcnksIHNvIGFcbiAgLy8gdGFpbCB0aGF0IHNlZXMgbm8gbWVzc2FnZSBoYXMgbm8gaWQgdG8gaGFuZCBpdHMgcmUtYXJtLCBhbmQgdGhlIHJlLWFybVxuICAvLyB3b3VsZCBtaXNzIGV2ZXJ5dGhpbmcgc2VudCBpbiB0aGUgZ2FwLiBUaGUgYHN1YnNjcmliZWRgIG1hcmtlciBjYXJyaWVzIHRoZVxuICAvLyBjaGFubmVsJ3MgYGxhdGVzdF9pZGA6IHNlZWRpbmcgdGhlIGN1cnNvciBmcm9tIGl0IG1ha2VzIHRoZSBoYW5kb2ZmJ3NcbiAgLy8gYC0tc2luY2VgIGV4YWN0LiBPbmx5IGZvciBhIGxpdmUtb25seSBzdGFydCDigJQgYSBiYWNrZmlsbGluZyBvbmUgKGAtLWxhc3RgLFxuICAvLyBgLS1mcm9tLXN0YXJ0YCwgYC0tc2luY2VgKSBpcyBzdGlsbCByZWFkaW5nIGlkcyBhdCBvciBiZWxvdyBpdCwgYW5kIGFcbiAgLy8gcmVjb25uZWN0IG1pZC1iYWNrZmlsbCBtdXN0IG5vdCBza2lwIHBhc3QgdGhlbS5cbiAgLy8gT25jZTogYSBsYXRlciBtYXJrZXIgKGEgcmVjb25uZWN0KSBtdXN0IG5vdCBqdW1wIHRoZSBjdXJzb3IgcGFzdCBtZXNzYWdlc1xuICAvLyBpdHMgb3duIGJhY2tsb2cgaXMgYWJvdXQgdG8gcmVwbGF5LlxuICBsZXQgc2VlZEZyb21NYXJrZXIgPSBzaW5jZSA8IDAgJiYgb3B0cy5sYXN0ID09PSB1bmRlZmluZWQ7XG5cbiAgLy8g4puUIEEgUFJFU0VOQ0UgU1BFTEw6IHRoZSBjb25uZWN0aW9uIElTIGB3aG9gJ3MgcHJlc2VuY2UsIHNvIHRoZSB3aW5kb3dcbiAgLy8gYWx3YXlzIG5hbWVzIHRoZSBNb25pdG9yIHJlLWFybSwgbmV2ZXIgdGhlIHN0b3Atc3RhcnQgYC0tb25jZWAsIGFuZCBhIGxvc3RcbiAgLy8gZGFlbW9uIGlzIHJldHJpZWQgKGByZXNvbHZlYCByZXNwYXducyBpdCksIG5vdCByZXBvcnRlZC5cbiAgY29uc3QgYWdhaW4gPSAoYXQ6IG51bWJlcikgPT5cbiAgICBjb21tYW5kTGluZShbXG4gICAgICBcInRhaWxcIixcbiAgICAgIG5hbWUsXG4gICAgICAuLi4ob3B0cy5sdXJrID8gW1wiLS1sdXJrXCJdIDogbXlBbGlhcyA/IFtcIi0tYXNcIiwgbXlBbGlhc10gOiBbXSksXG4gICAgICAuLi4ob3B0cy5odW1hbiAmJiAhb3B0cy5sdXJrID8gW1wiLS1odW1hblwiXSA6IFtdKSxcbiAgICAgIC4uLihvcHRzLm1heCAhPT0gdW5kZWZpbmVkID8gW1wiLS1tYXhcIiwgU3RyaW5nKG9wdHMubWF4KV0gOiBbXSksXG4gICAgICAvLyBgLS1zaW5jZWAgdGFrZXMgbm8gbmVnYXRpdmUgaGVyZTsgYSB0YWlsIHRoYXQgbmV2ZXIgbGVhcm5lZCBhbiBpZFxuICAgICAgLy8gcmUtYXJtcyBsaXZlLW9ubHksIHdoaWNoIGlzIHdoYXQgLTEgbWVhbnQuXG4gICAgICAuLi4oYXQgPj0gMCA/IFtcIi0tc2luY2VcIiwgU3RyaW5nKGF0KV0gOiBbXSksXG4gICAgXSk7XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxXaXRoSGFuZG9mZjxUYWlsUGF5bG9hZD4oXG4gICAge1xuICAgICAgLy8g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRC4gQSB0YWlsIG91dGxpdmVzXG4gICAgICAvLyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCDigJQgYHJvbGxgIGFuZCBgcmVzdGFydGAgYm90aCByZXBsYWNlIGl0IOKAlCBhbmRcbiAgICAgIC8vIGBlbnN1cmVEYWVtb25gIHJlLXJlYWRzIHRoZSBwb3J0IGZpbGUgYW5kIHJlc3Bhd25zLCBzbyBhIHJlY29ubmVjdCBhZnRlciBhXG4gICAgICAvLyByb2xsIGxhbmRzIG9uIHRoZSBORVcgZGFlbW9uIHJhdGhlciB0aGFuIHNwaW5uaW5nIGFnYWluc3QgYSBkZWFkIHBvcnQuXG4gICAgICByZXNvbHZlOiBhc3luYyAoKSA9PiBgaHR0cDovLzEyNy4wLjAuMToke2F3YWl0IGVuc3VyZURhZW1vbigpfWAsXG4gICAgICBwYXRoOiBgL2NoYW5uZWxzLyR7bmFtZX0vdGFpbGAsXG4gICAgICBzaW5jZSxcbiAgICAgIC8vIOKaoCBOTyBlbnN1cmUgY2FsbCBiZWZvcmUgdGhlIHN1YnNjcmliZS4gQSBmcmVzaCBgdGFpbCBuYW1lYCBzdGlsbCB3b3Jrc1xuICAgICAgLy8gd2l0aG91dCBhbiBleHBsaWNpdCBvcGVuIOKAlCBHRVQg4oCmL3RhaWwgY3JlYXRlcyB0aGUgY2hhbm5lbCBpdHNlbGYg4oCUIGFuZFxuICAgICAgLy8gdGhhdCBpcyB0aGUgT05MWSB3YXkgdGhlIHN1YnNjcmliZWQgZXZlbnQncyBgY3JlYXRlZGAgZmxhZyBjYW4gZXZlciBiZVxuICAgICAgLy8gdHJ1ZTogYW4gZW5zdXJlIHNlbnQgZmlyc3QgY3JlYXRlcyB0aGUgY2hhbm5lbCwgc28gdGhlIHN1YnNjcmliZSB0aGF0XG4gICAgICAvLyBmb2xsb3dzIGFsd2F5cyByZXBvcnRzIGBjcmVhdGVkOmZhbHNlYCBhbmQgdGhlIG1pc3R5cGVkLW5hbWUgc2lnbmFsIG5ldmVyXG4gICAgICAvLyBmaXJlcy5cbiAgICAgIHF1ZXJ5OiAoY3Vyc29yLCBmaXJzdENvbm5lY3QpID0+IHtcbiAgICAgICAgY29uc3QgcTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICAgIC8vICM2OCDigJQgYC0tbGFzdCBOYCByaWRlcyB0aGUgRklSU1QgY29ubmVjdGlvbiBvbmx5LiBPbmNlIGFueSBtZXNzYWdlXG4gICAgICAgIC8vIGxhbmRzIHRoZSBjdXJzb3IgYWR2YW5jZXMgYW5kIGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSBpdCB2aWEgYHNpbmNlYCxcbiAgICAgICAgLy8gbmV2ZXIgcmUtYmFja2ZpbGxpbmcgdGhlIHdpbmRvdy4gYGZpcnN0Q29ubmVjdGAgaXMgdGhlIGtpdCdzIHBhcmFtZXRlclxuICAgICAgICAvLyBmb3IgZXhhY3RseSB0aGlzOyB0aGUgaGFuZC13cml0dGVuIGxvb3Agc3BlbGxlZCBpdCBgaGlnaGVzdFNlZW4gPCAwYCxcbiAgICAgICAgLy8gd2hpY2ggd2FzIHRoZSBzYW1lIHRlc3QgYnkgYWNjaWRlbnQgb2YgdGhlIHNlbnRpbmVsLlxuICAgICAgICBpZiAob3B0cy5sYXN0ICE9PSB1bmRlZmluZWQgJiYgZmlyc3RDb25uZWN0KSBxLmxhc3QgPSBTdHJpbmcob3B0cy5sYXN0KTtcbiAgICAgICAgaWYgKG15QWxpYXMpIHEuYXMgPSBteUFsaWFzO1xuICAgICAgICBpZiAob3B0cy5odW1hbiAmJiAhb3B0cy5sdXJrKSBxLmh1bWFuID0gXCIxXCI7XG4gICAgICAgIGlmIChvcHRzLmx1cmspIHEubHVyayA9IFwiMVwiO1xuICAgICAgICByZXR1cm4gcTtcbiAgICAgIH0sXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIpIHJldHVybiBldi5pZDtcbiAgICAgICAgaWYgKHNlZWRGcm9tTWFya2VyICYmIHR5cGVvZiBldi5sYXRlc3RfaWQgPT09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgICBzZWVkRnJvbU1hcmtlciA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiBldi5sYXRlc3RfaWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH0sXG4gICAgICBhY2NlcHQ6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgLy8gVGhlIHN1YnNjcmliZWQgbWFya2VyIGlzIG5vdCBhIG1lc3NhZ2U7IGByZW5kZXJgIGFuc3dlcnMgaXQuXG4gICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiB0cnVlO1xuICAgICAgICAvLyBEcm9wIERJU1BPU0lUSU9OIGZyYW1lcyDigJQgdGhleSBhcmUgbWV0YWRhdGEgYWJvdXQgYW5vdGhlciBtZXNzYWdlLiBBXG4gICAgICAgIC8vIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHBhc3NlcyB0aHJvdWdoOiBhbiBhZ2VudCB0YWlsaW5nIGFcbiAgICAgICAgLy8gY2hhbm5lbCBjb3VsZCBub3QgcHJldmlvdXNseSBzZWUgZWl0aGVyIHBhcnR5IHJldGlyZSBpdCwgYW5kIGZvdW5kIG91dFxuICAgICAgICAvLyB3aGVuIGl0cyBuZXh0IHNlbmQgd2FzIHJlamVjdGVkLlxuICAgICAgICBpZiAoaXNEaXNwb3NpdGlvbkZyYW1lKGV2KSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAvLyBTdXBwcmVzcyBzZWxmLWVjaG86IHdoZW4gLS1hcyBpcyBzZXQsIGRyb3AgbWVzc2FnZXMgd2Ugc2VudCBvdXJzZWx2ZXMuXG4gICAgICAgIC8vIFRoZSBzZW5kZXIgYWxyZWFkeSBnb3QgdGhlIHJlY2VpcHQgYXMgdGhlIFBPU1QgcmVzcG9uc2UsIHNvIHJlLWVtaXR0aW5nXG4gICAgICAgIC8vIGl0IG9uIHRhaWwgaXMgcHVyZSBub2lzZS5cbiAgICAgICAgaWYgKG15QWxpYXMgJiYgZXYuZnJvbSA9PT0gbXlBbGlhcykgcmV0dXJuIGZhbHNlO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChwYXlsb2FkLCBmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09IFwic3Vic2NyaWJlZFwiKSByZXR1cm4gcmVuZGVyU3Vic2NyaWJlZChwYXlsb2FkKTtcbiAgICAgICAgLy8gIzY3IOKAlCBmcm9udC1sb2FkIGEgcmVjb3ZlcnkgcG9pbnRlciBvbiBFVkVSWSBtZXNzYWdlIGZyYW1lLCBzbyB0aGUgcmVhZFxuICAgICAgICAvLyBjb29yZGluYXRlcyBzdXJ2aXZlIGEgZG93bnN0cmVhbSBub3RpZmljYXRpb24gY2xpcC4gTW9uaXRvciB0cnVuY2F0ZXMgYXRcbiAgICAgICAgLy8gaXRzIE9XTiBjYXAgKGJlbG93IG91ciBoaW50IHRocmVzaG9sZCwgYW5kIG9uZSB3ZSBjYW5ub3Qgb2JzZXJ2ZSBoZXJlKTsgYVxuICAgICAgICAvLyBtZXNzYWdlIGl0IGNsaXBzIHdvdWxkIG90aGVyd2lzZSBsb3NlIGl0cyB0cmFpbGluZyBgaWRgIGFuZCBiZWNvbWVcbiAgICAgICAgLy8gdW5yZWNvdmVyYWJsZSDigJQgdGhlIHJlYWRlciBpcyBsZWZ0IGluZmVycmluZyB0aGUgaWQuIEV2ZXJ5IGZyYW1lXG4gICAgICAgIC8vIHRoZXJlZm9yZSBjYXJyaWVzIGEgRlJPTlQtbG9hZGVkIGByZWFkIDxjaGFubmVsPiA8aWQ+YCwgZWl0aGVyIGFzIHRoZVxuICAgICAgICAvLyByaWNoZXIgYHRydW5jYXRpb25faGludGAgKGdlbnVpbmVseS1sb25nIG1lc3NhZ2VzIOKAlCB0aGUgXCIrTiBjaGFycyxcbiAgICAgICAgLy8geW91J3JlIGRlZmluaXRlbHkgbWlzc2luZyBjb250ZW50XCIgYWxhcm0pIG9yIGFzIHRoZSBjb21wYWN0IGBmdWxsYFxuICAgICAgICAvLyBwb2ludGVyLiBTZXJpYWxpemluZyBpdCBiZWZvcmUgdGhlIGxvbmcgYC50ZXh0YCBpcyB3aGF0IG1ha2VzIGl0IHN1cnZpdmVcbiAgICAgICAgLy8gdGhlIGNsaXAgKEYxNykuXG4gICAgICAgIGNvbnN0IHJlYWRSZWYgPSBgcmVhZCAke25hbWV9ICR7cGF5bG9hZC5pZH1gO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHlwZW9mIHBheWxvYWQudGV4dCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgIHBheWxvYWQudGV4dC5sZW5ndGggPiAob3B0cy5tYXggPz8gVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRClcbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc3QgdHJ1bmNhdGlvbl9oaW50ID0gYCske3BheWxvYWQudGV4dC5sZW5ndGh9IGNoYXJzIOKAlCBmdWxsOiAke3JlYWRSZWZ9YDtcbiAgICAgICAgICAvLyBDYXAgdGhlIElOTElORSBib2R5IHdoZW4gLS1tYXggaXMgc2V0ICh0aGUgZnVsbCBtZXNzYWdlIHN0YXlzIG9uIGRpc2tcbiAgICAgICAgICAvLyDihpIgYHJlYWRgKTsgd2l0aG91dCAtLW1heCwgZW1pdCB0aGUgZnVsbCB0ZXh0ICh0b2RheSdzIGRlZmF1bHQpLlxuICAgICAgICAgIGNvbnN0IHRleHQgPSBvcHRzLm1heCAhPT0gdW5kZWZpbmVkID8gcGF5bG9hZC50ZXh0LnNsaWNlKDAsIG9wdHMubWF4KSA6IHBheWxvYWQudGV4dDtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyB0cnVuY2F0aW9uX2hpbnQsIC4uLnBheWxvYWQsIHRleHQgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgZnVsbDogcmVhZFJlZiwgLi4ucGF5bG9hZCB9KTtcbiAgICAgIH0sXG4gICAgICAvLyBEYWVtb24gbGl2ZW5lc3MgaGVhcnRiZWF0IChgOiBoYiA8dHM+YCkuIFN1cmZhY2UgYSByZWNvZ25pemFibGUgc2VudGluZWxcbiAgICAgIC8vIG9uIHN0ZGVyciBzbyBhIGAyPiYxYCBjb25zdW1lciBjYW4gdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIgKEY2KS4gS2VwdFxuICAgICAgLy8gb2ZmIHN0ZG91dCDigJQgdGhlIEpTT05MIHN0cmVhbSBzdGF5cyBwdXJlLlxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4gKHRleHQudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcImhiXCIpID8gXCI6IGdyYXBldmluZS1rZWVwYWxpdmVcIiA6IG51bGwpLFxuICAgICAgb25NYWxmb3JtZWQ6IChfZnJhbWUsIGUpID0+IGAjIGJhZCBzc2UgZGF0YTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCxcbiAgICAgIC8vIFRoZSBmb3VyIGxpbmVzIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCB3cm90ZSwgcHJlc2VydmVkIHZlcmJhdGltIOKAlCBhIHRhaWxcbiAgICAgIC8vIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gb25lIHRoYXQgaXMgd29ya2luZy5cbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgc3dpdGNoIChpbmZvLmNhdXNlKSB7XG4gICAgICAgICAgY2FzZSBcImNvbm5lY3QtZmFpbGVkXCI6XG4gICAgICAgICAgICByZXR1cm4gYCMgY29ubmVjdCBmYWlsZWQ6ICR7aW5mby5lcnJvciBpbnN0YW5jZW9mIEVycm9yID8gaW5mby5lcnJvci5tZXNzYWdlIDogU3RyaW5nKGluZm8uZXJyb3IpfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJodHRwXCI6XG4gICAgICAgICAgY2FzZSBcIm5vLWJvZHlcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyB0YWlsIEhUVFAgJHtpbmZvLnN0YXR1c30sIHJldHJ5aW5n4oCmYDtcbiAgICAgICAgICBjYXNlIFwic3RyZWFtLWVycm9yXCI6XG4gICAgICAgICAgICByZXR1cm4gYCMgc3RyZWFtIGRyb3BwZWQ6ICR7aW5mby5lcnJvciBpbnN0YW5jZW9mIEVycm9yID8gaW5mby5lcnJvci5tZXNzYWdlIDogU3RyaW5nKGluZm8uZXJyb3IpfSwgcmVjb25uZWN0aW5n4oCmYDtcbiAgICAgICAgICBjYXNlIFwic3RyZWFtLWVuZFwiOlxuICAgICAgICAgICAgcmV0dXJuIFwiIyBzdHJlYW0gY2xvc2VkLCByZWNvbm5lY3RpbmfigKZcIjtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgIH0sXG4gICAge1xuICAgICAgc3BlbGw6IFwiZ3JhcGV2aW5lXCIsXG4gICAgICBtb2RlOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogdHJ1ZSxcbiAgICAgIC8vIEQ0OiBhIGh1bWFuIGF0IGEgdGVybWluYWwgKGAtLWh1bWFuYCkgaXMgbm90IGFuIGFnZW50IHVuZGVyXG4gICAgICAvLyBNb25pdG9yJ3MgY2FwLCBzbyB0aGVpciB3YXRjaCBuZXZlciBlbmRzIGJ5IGl0c2VsZi5cbiAgICAgIC4uLihvcHRzLmh1bWFuID8geyB3aW5kb3dNczogMCB9IDoge30pLFxuICAgICAgLy8gVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXIgKGFuZCB0aGUgZ3JvdW5kaW5nIGxpbmUgaXQgcmVuZGVycykgaXMgbm90IGFcbiAgICAgIC8vIG1lc3NhZ2Ugb24gdGhlIGNoYW5uZWwuXG4gICAgICBjb3VudHM6IChfZXYsIGZyYW1lKSA9PiBmcmFtZS5ldmVudCAhPT0gXCJzdWJzY3JpYmVkXCIsXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQgfSkgPT4gYWdhaW4oYXQpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wiZG9jdG9yXCJdKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcblxuICAvKiogVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXI6IHN0ZGVyciBjb250ZXh0LCBwbHVzIGEgc3RydWN0dXJlZCBncm91bmRpbmcgbGluZVxuICAgKiAgb24gc3Rkb3V0IHRoZSBGSVJTVCB0aW1lIG9ubHkuICovXG4gIGZ1bmN0aW9uIHJlbmRlclN1YnNjcmliZWQocGF5bG9hZDogVGFpbFBheWxvYWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyBzdWJzY3JpYmVkIHRvICR7cGF5bG9hZC5jaGFubmVsfSAoc2luY2U9JHtwYXlsb2FkLnNpbmNlfSlcXG5gKTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgdG9waWM6ICR7cGF5bG9hZC50b3BpY31cXG5gKTtcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCB0aGlzIHRhaWwgYnJvdWdodCBpdCBpbnRvIGJlaW5nIChjaGVjayB0aGUgbmFtZSlcXG5gLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWRcXG5gLFxuICAgICAgKTtcbiAgICAvLyBTdHJ1Y3R1cmVkIGdyb3VuZGluZyBvbiBzdGRvdXQgKEYzL0Y3KSDigJQgdW5kZXIgdGhlIGRlZmF1bHQgV2lyaW5nLUJcbiAgICAvLyBNb25pdG9yLCBzdGRvdXQgc3VyZmFjZXMgYXMgbm90aWZpY2F0aW9ucywgc28gYSBmcmVzaCBzdWJzY3JpYmVyIGFjdHVhbGx5XG4gICAgLy8gc2VlcyB0aGUgdG9waWMgKyB0aGF0IGVhcmxpZXIgaGlzdG9yeSBleGlzdHMuIEdhdGVkOiBvbmx5IHdoZW4gdGhlcmUnc1xuICAgIC8vIHNvbWV0aGluZyB0byBncm91bmQgKHVuc2VlbiBoaXN0b3J5IG9yIGEgdG9waWMpLCBhbmQgb25seSBvbiB0aGUgZmlyc3RcbiAgICAvLyBzdWJzY3JpYmUgKG5vdCByZWNvbm5lY3RzKS5cbiAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICBjb25zdCBsYXRlc3QgPSB0eXBlb2YgcGF5bG9hZC5sYXRlc3RfaWQgPT09IFwibnVtYmVyXCIgPyBwYXlsb2FkLmxhdGVzdF9pZCA6IDA7XG4gICAgY29uc3QgZWFybGllciA9IHNpbmNlIDwgMCA/IGxhdGVzdCA6IE1hdGgubWF4KDAsIE1hdGgubWluKHNpbmNlLCBsYXRlc3QpKTtcbiAgICAvLyBgY3JlYXRlZGAgYW5kIGBhcmNoaXZlZGAgam9pbiB0aGUgZ2F0ZSBvbiBwdXJwb3NlLiBBIGNoYW5uZWwgdGhpc1xuICAgIC8vIHN1YnNjcmliZSBqdXN0IG1hZGUgaGFzIG5vIHRvcGljIGFuZCBubyBoaXN0b3J5LCBzbyB0aGUgb2xkIGNvbmRpdGlvblxuICAgIC8vIChgZWFybGllciA+IDAgfHwgdG9waWNgKSBpcyBleGFjdGx5IHRoZSBjYXNlIHRoYXQgZW1pdHMgTk9USElORzsgYW5kIGFuXG4gICAgLy8gQVJDSElWRUQgY2hhbm5lbCdzIGdyb3VuZGluZyBsaW5lIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgaGVhbHRoeVxuICAgIC8vIG9uZSdzLCBzbyBhIGxhdGUgam9pbmVyIHN0aWxsIGxlYXJuZWQgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQgb25seSB3aGVuXG4gICAgLy8gaXRzIHNlbmQgYm91bmNlZC5cbiAgICAvL1xuICAgIC8vIOKaoCBUaGUgaGludHMgQUNDVU1VTEFURSBpbnRvIGEgbGlzdCByYXRoZXIgdGhhbiBhc3NpZ25pbmcgdG8gb25lIGZpZWxkLlxuICAgIC8vIFRoZXkgdXNlZCB0byBiZSB0aHJlZSBhc3NpZ25tZW50cyB0byBgZ3JvdW5kaW5nLmhpbnRgLCBvcmRlcmVkIHNvIHRoZSBtb3N0XG4gICAgLy8gaW1wb3J0YW50IHdvbiDigJQgd2hpY2ggaXMgYSBoaW50IHRoYXQgY2FuIHNpbGVudGx5IGxvc2UgdG8gYW5vdGhlciBoaW50LFxuICAgIC8vIHRoZSBmYWlsdXJlIG1vZGUgdGhpcyB3aG9sZSBicmFuY2ggaXMgYWJvdXQsIHNpdHRpbmcgaW4gdGhlIGZpeCBmb3IgaXQuIEFcbiAgICAvLyBsaXN0IGNhbm5vdCBvdmVyd3JpdGU6IGFuIGFyY2hpdmVkIGNoYW5uZWwgV0lUSCBoaXN0b3J5IG5vdyBzYXlzIGJvdGguXG4gICAgY29uc3QgaGludHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKGVhcmxpZXIgPiAwKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7ZWFybGllcn0gZWFybGllciBtZXNzYWdlKHMpIGV4aXN0IOKAlCB1c2UgLS1mcm9tLXN0YXJ0IG9yIC0tc2luY2UgPGlkPiB0byBiYWNrZmlsbGAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgdGhpcyB0YWlsIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCBubyBzdWNoIGNoYW5uZWwgZXhpc3RlZDsgY2hlY2sgdGhlIG5hbWUsIG9yIGFub3RoZXIgcGFydHkgaGFzIHlldCB0byBvcGVuIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkIHVudGlsIHNvbWVvbmUgdW5hcmNoaXZlcyBpdGAsXG4gICAgICApO1xuICAgIGlmICghKGVhcmxpZXIgPiAwIHx8IHBheWxvYWQudG9waWMgfHwgcGF5bG9hZC5jcmVhdGVkIHx8IHBheWxvYWQuYXJjaGl2ZWQpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBncm91bmRpbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAga2luZDogXCJncm91bmRpbmdcIixcbiAgICAgIGNoYW5uZWw6IHBheWxvYWQuY2hhbm5lbCxcbiAgICAgIGpvaW5lZF9hdDogc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5taW4oc2luY2UsIGxhdGVzdCksXG4gICAgICBlYXJsaWVyLFxuICAgIH07XG4gICAgaWYgKHBheWxvYWQudG9waWMpIGdyb3VuZGluZy50b3BpYyA9IHBheWxvYWQudG9waWM7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZCkgZ3JvdW5kaW5nLmNyZWF0ZWQgPSB0cnVlO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKSBncm91bmRpbmcuYXJjaGl2ZWQgPSB0cnVlO1xuICAgIGlmIChoaW50cy5sZW5ndGgpIGdyb3VuZGluZy5oaW50ID0gaGludHMuam9pbihcIiDCtyBcIik7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGdyb3VuZGluZyk7XG4gIH1cbn1cbmZ1bmN0aW9uIGZvbGREaXNwb3NpdGlvbnMobmFtZTogc3RyaW5nKSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8XG4gICAgbnVtYmVyLFxuICAgIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBzdHJpbmc7XG4gICAgICBmcm9tOiBzdHJpbmc7XG4gICAgICB0czogbnVtYmVyO1xuICAgICAgbm90ZTogc3RyaW5nO1xuICAgICAgcmVvcGVuczogbnVtYmVyO1xuICAgIH1cbiAgPigpO1xuICBjb25zdCBwYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBtYXA7XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgIT09IFwic3RhdHVzXCIgfHwgdHlwZW9mIG0udGFyZ2V0ICE9PSBcIm51bWJlclwiIHx8IHR5cGVvZiBtLmRpc3Bvc2l0aW9uICE9PSBcInN0cmluZ1wiKVxuICAgICAgY29udGludWU7XG4gICAgY29uc3QgcHJldiA9IG1hcC5nZXQobS50YXJnZXQpO1xuICAgIGNvbnN0IHJlb3BlbnMgPVxuICAgICAgKHByZXY/LnJlb3BlbnMgPz8gMCkgK1xuICAgICAgKG0uZGlzcG9zaXRpb24gPT09IFwib3BlblwiICYmIHByZXYgJiYgcHJldi5kaXNwb3NpdGlvbiAhPT0gXCJvcGVuXCIgPyAxIDogMCk7XG4gICAgbWFwLnNldChtLnRhcmdldCwge1xuICAgICAgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24sXG4gICAgICBmcm9tOiBtLmZyb20sXG4gICAgICB0czogbS50cyxcbiAgICAgIG5vdGU6IG0udGV4dCxcbiAgICAgIHJlb3BlbnMsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cbi8vIFRXTyB0aGluZ3Mgbm93IHdlYXIga2luZDpcInN0YXR1c1wiLiBBIERJU1BPU0lUSU9OIGZyYW1lIGFjdHMgb24gYSBzcGVjaWZpY1xuLy8gbWVzc2FnZSAoYHRhcmdldGAgKyBgZGlzcG9zaXRpb25gKSBhbmQgaXMgbWV0YWRhdGEg4oCUIGBwdWxsYCBhbmQgYHRhaWxgIGZvbGRcbi8vIGl0IGF3YXkgYW5kIGJhZGdlIHRoZSBtZXNzYWdlIGl0IHBvaW50cyBhdCBpbnN0ZWFkLiBBIExJRkVDWUNMRSBmcmFtZVxuLy8gKGFyY2hpdmUgLyB1bmFyY2hpdmUpIGlzIGEgZmFjdCBhYm91dCB0aGUgQ0hBTk5FTDogaXQgdGFyZ2V0cyBub3RoaW5nLCBhbmQgaXRcbi8vIGlzIHRoZSB3aG9sZSBwb2ludCB0aGF0IGEgcmVhZGVyIHNlZXMgaXQuIERpc2NyaW1pbmF0aW5nIG9uIGBkaXNwb3NpdGlvbmBcbi8vIHJhdGhlciB0aGFuIG9uIGBldmVudGAga2VlcHMgYSBmcmFtZSBmcm9tIHNvbWUgZnV0dXJlIGVtaXR0ZXIgdmlzaWJsZSBieVxuLy8gZGVmYXVsdCDigJQgdGhlIGZhaWx1cmUgbW9kZSBoZXJlIGlzIHN3YWxsb3dpbmcgYSBzaWduYWwsIG5vdCBzaG93aW5nIG9uZS5cbmZ1bmN0aW9uIGlzRGlzcG9zaXRpb25GcmFtZShtOiB7IGtpbmQ/OiBzdHJpbmc7IGRpc3Bvc2l0aW9uPzogc3RyaW5nIH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG0ua2luZCA9PT0gXCJzdGF0dXNcIiAmJiB0eXBlb2YgbS5kaXNwb3NpdGlvbiA9PT0gXCJzdHJpbmdcIjtcbn1cblxuLy8gXCJvcGVuXCIgPSBubyBlbnRyeSwgb3IgbGF0ZXN0IGRpc3Bvc2l0aW9uIGlzIFwib3BlblwiXG5mdW5jdGlvbiBpc09wZW4oZD86IHsgZGlzcG9zaXRpb246IHN0cmluZyB9KSB7XG4gIHJldHVybiAhZCB8fCBkLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIjtcbn1cblxuLy8gUmVhZHMgdGhlIGZ1bGwgY2hhbm5lbCBsb2csIGRyb3BzIEVWRVJZIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSwgYW5kIGJhZGdlcyBlYWNoXG4vLyByZW1haW5pbmcgbWVzc2FnZSB3aXRoIGl0cyBsYXRlc3QgZGlzcG9zaXRpb24gdmlhIGZvbGREaXNwb3NpdGlvbnMuXG4vL1xuLy8gRXZlcnkgb25lLCBkZWxpYmVyYXRlbHkg4oCUIGluY2x1ZGluZyBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpLFxuLy8gd2hpY2ggYHB1bGxgIGFuZCBgdGFpbGAgZG8gbGV0IHRocm91Z2guIFRoaXMgZmVlZHMgYHRyaWFnZWAsIHdob3NlIG9wZW4gcXVldWVcbi8vIGlzIFwid2hhdCBpcyBsZWZ0IHRvIGFjdCBvblwiLCBhbmQgYW4gYXJjaGl2ZSBpcyBhbiBGWUksIG5vdCBhIHdvcmsgaXRlbS4gU2FtZVxuLy8gcmVhc29uIGB0b3BpY2AgYW5kIGBhbm5vdW5jZW1lbnRgIGFyZSBmb2xkZWQgb3V0IG9mIHRoZSBvcGVuIGJ1Y2tldCBiZWxvdy5cbmZ1bmN0aW9uIGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQoXG4gIG5hbWU6IHN0cmluZyxcbik6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdIHtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSByZXR1cm4gW107XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBtZXNzYWdlczogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCA9PT0gXCJzdGF0dXNcIikgY29udGludWU7XG4gICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgIGlmIChkKSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWVzc2FnZXMucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1lc3NhZ2VzO1xufVxuXG50eXBlIEJhZGdlZE1lc3NhZ2UgPSBNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9O1xuXG4vLyBEYXNoYm9hcmQgcmVuZGVyIG9mIGEgdHJpYWdlIHNjYW46IHRoZSBvcGVuIHF1ZXVlIG9uIHRvcCwgdGhlbiBlYWNoXG4vLyBkaXNwb3NpdGlvbiBncm91cCwgb25lIHNjYW5uYWJsZSBsaW5lIHBlciBtZXNzYWdlLiBNaXJyb3JzIGByZWFkIC0tdGV4dGBcbi8vIHByb3NlIG1vZGUgc28gYSBodW1hbiAob3IgYW4gYWdlbnQpIHJlYWRzIGl0IHdpdGhvdXQgcGFyc2luZyBKU09OLlxuZnVuY3Rpb24gcmVuZGVyVHJpYWdlSHVtYW4oXG4gIG5hbWU6IHN0cmluZyxcbiAgb3BlbjogQmFkZ2VkTWVzc2FnZVtdLFxuICBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4sXG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lID0gKG06IEJhZGdlZE1lc3NhZ2UpID0+IHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG0udHMpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKTtcbiAgICBjb25zdCByZW9wZW4gPSBtLnJlb3BlbnMgJiYgbS5yZW9wZW5zID4gMCA/IGAg4oa7JHttLnJlb3BlbnN9YCA6IFwiXCI7XG4gICAgLy8gVGhlIGZpcnN0IGxpbmUsIHdpdGhvdXQgYW4gaW5kZXggcmVhZCBgc3BsaXRgIHdvdWxkIG1ha2UgdGhlIGNvbXBpbGVyXG4gICAgLy8gZG91YnQ6IGBzcGxpdGAgbmV2ZXIgcmV0dXJucyBhbiBlbXB0eSBhcnJheSwgYW5kIHRoaXMgc2F5cyB0aGUgc2FtZSB0aGluZy5cbiAgICBjb25zdCBubCA9IG0udGV4dC5pbmRleE9mKFwiXFxuXCIpO1xuICAgIGNvbnN0IGhlYWQgPSBubCA9PT0gLTEgPyBtLnRleHQgOiBtLnRleHQuc2xpY2UoMCwgbmwpO1xuICAgIGNvbnN0IHByZXZpZXcgPSBoZWFkLmxlbmd0aCA+IDEwMCA/IGAke2hlYWQuc2xpY2UoMCwgOTkpfeKApmAgOiBoZWFkO1xuICAgIHJldHVybiBgICBbJHttLmlkfSR7cmVvcGVufV0gJHttLmZyb219IMK3ICR7dHN9IMK3ICR7cHJldmlld31gO1xuICB9O1xuICBjb25zdCBzZWN0aW9ucyA9IFtgJHtuYW1lfSDCtyB0cmlhZ2VcXG5gLCBgT1BFTiAoJHtvcGVuLmxlbmd0aH0pYF07XG4gIHNlY3Rpb25zLnB1c2gob3Blbi5sZW5ndGggPyBvcGVuLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpIDogXCIgIOKAlFwiKTtcbiAgZm9yIChjb25zdCBbc3RhdHVzLCBpdGVtc10gb2YgT2JqZWN0LmVudHJpZXMoYnlfc3RhdHVzKSkge1xuICAgIHNlY3Rpb25zLnB1c2goYFxcbiR7c3RhdHVzLnRvVXBwZXJDYXNlKCl9ICgke2l0ZW1zLmxlbmd0aH0pYCwgaXRlbXMubWFwKGxpbmUpLmpvaW4oXCJcXG5cIikpO1xuICB9XG4gIHJldHVybiBgJHtzZWN0aW9ucy5qb2luKFwiXFxuXCIpfVxcbmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRyaWFnZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdHM6IHsgaHVtYW4/OiBib29sZWFuIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgdHJpYWdlIDxjaGFubmVsPiBbLS1odW1hbl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gdHJpYWdlIHJlYWRzIHRoZSBsb2cgZmlsZSwgbm90IGEgcm91dGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93biDigJQgYW5kXG4gIC8vIGFuIGVtcHR5IGRhc2hib2FyZCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QgaXMgdGhlIHNhbWUgc2lsZW50IGxpZVxuICAvLyBhcyBhbiBlbXB0eSBgcHVsbGAuXG4gIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICBjb25zdCBvcGVuOiBCYWRnZWRNZXNzYWdlW10gPSBbXTtcbiAgY29uc3QgYnlfc3RhdHVzOiBSZWNvcmQ8c3RyaW5nLCBCYWRnZWRNZXNzYWdlW10+ID0ge307XG4gIGZvciAoY29uc3QgbSBvZiBiYWRnZWQpIHtcbiAgICAvLyBpc09wZW4gZXhwZWN0cyBhIGRpc3Bvc2l0aW9uIGVudHJ5IG9iamVjdCAob3IgdW5kZWZpbmVkIGZvciBubyBlbnRyeSkuXG4gICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICBpZiAoaXNPcGVuKGRpc3BBcmcpKSB7XG4gICAgICAvLyBUaGUgb3BlbiBxdWV1ZSBpcyBzaWduYWwtb25seTogc2tpcCBub24tYWN0aW9uYWJsZSBmcmFtZXMgKHRvcGljL1xuICAgICAgLy8gYW5ub3VuY2VtZW50IEZZSXMgY2FuIG5ldmVyIGNhcnJ5IGEgZGlzcG9zaXRpb24sIHNvIHRoZXknZCBvdGhlcndpc2VcbiAgICAgIC8vIHBhZCBcIndoYXQncyBsZWZ0P1wiIGZvcmV2ZXIpLlxuICAgICAgaWYgKG0ua2luZCA9PT0gXCJtZXNzYWdlXCIpIG9wZW4ucHVzaChtKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qga2V5ID0gbS5kaXNwb3NpdGlvbiA/PyBcInVua25vd25cIjtcbiAgICAgIGlmICghYnlfc3RhdHVzW2tleV0pIGJ5X3N0YXR1c1trZXldID0gW107XG4gICAgICBieV9zdGF0dXNba2V5XS5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICBpZiAob3B0cy5odW1hbikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHJlbmRlclRyaWFnZUh1bWFuKG5hbWUsIG9wZW4sIGJ5X3N0YXR1cykpO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgb3BlbiwgYnlfc3RhdHVzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRHcmVwKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHBhdHRlcm46IHN0cmluZyxcbiAgb3B0czogeyBsaXRlcmFsPzogYm9vbGVhbjsgZnJvbT86IHN0cmluZyB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhcGF0dGVybilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGdyZXAgPGNoYW5uZWw+IDxwYXR0ZXJuPiBbLS1saXRlcmFsfC1GXSBbLS1mcm9tIDxhbGlhcz5dXCIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgbWF0Y2hlcjogKHRleHQ6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgaWYgKG9wdHMubGl0ZXJhbCkge1xuICAgIGNvbnN0IG5lZWRsZSA9IHBhdHRlcm4udG9Mb3dlckNhc2UoKTtcbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUpO1xuICB9IGVsc2Uge1xuICAgIGxldCByZTogUmVnRXhwO1xuICAgIHRyeSB7XG4gICAgICByZSA9IG5ldyBSZWdFeHAocGF0dGVybiwgXCJpXCIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRpZShgaW52YWxpZCByZWdleDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCwgXCJ1c2FnZVwiKTtcbiAgICB9XG4gICAgbWF0Y2hlciA9ICh0ZXh0KSA9PiByZS50ZXN0KHRleHQpO1xuICB9XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpO1xuICBjb25zdCBtZXNzYWdlczogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGxldCBtc2c6IFBhcnRpYWw8TWVzc2FnZT47XG4gICAgdHJ5IHtcbiAgICAgIG1zZyA9IEpTT04ucGFyc2UobGluZSkgYXMgUGFydGlhbDxNZXNzYWdlPjtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAob3B0cy5mcm9tICYmIG1zZy5mcm9tICE9PSBvcHRzLmZyb20pIGNvbnRpbnVlO1xuICAgIGlmICghbWF0Y2hlcihtc2cudGV4dCkpIGNvbnRpbnVlO1xuICAgIG1lc3NhZ2VzLnB1c2gobXNnKTtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXMgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZENsb3NlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgY2xvc2UgPG5hbWU+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSBkaWUoXCJubyBkYWVtb24gcnVubmluZ1wiLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdGF0dXNSZXNwb25zZT4ocG9ydCwgXCJERUxFVEVcIiwgYC9jaGFubmVscy8ke25hbWV9YCk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc2V0KG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgb3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9O1xuICBpZiAob3B0cy5mb3JjZSkgYm9keS5mb3JjZSA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgc3Vic2NyaWJlcnM/OiBudW1iZXIgfT4oXG4gICAgcG9ydCxcbiAgICBcIlBPU1RcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vcmVzZXRgLFxuICAgIGJvZHksXG4gICk7XG4gIGlmIChzdGF0dXMgPT09IDQwOSAmJiBkYXRhPy5lcnJvciA9PT0gXCJsaXZlXCIpIHtcbiAgICBkaWUoXG4gICAgICBgY2hhbm5lbCBoYXMgJHtkYXRhLnN1YnNjcmliZXJzfSBsaXZlIHN1YnNjcmliZXIocykg4oCUIHJlZnVzaW5nIHRvIGNsZWFyIGEgbGl2ZSBzZXNzaW9uLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIGNsZWFyIGFueXdheSAodGhlIGxvZyBpcyBzbmFwc2hvdHRlZCBmaXJzdCkuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEFyY2hpdmUgKHJlYWQtb25seSkgb3IgdW5hcmNoaXZlIGEgY2hhbm5lbCAoVjEuNykg4oCUIHRoZSBub24tZGVzdHJ1Y3RpdmVcbi8vIGFsdGVybmF0aXZlIHRvIGNsb3NlOiBoaXN0b3J5IGlzIHByZXNlcnZlZCwgc2VuZHMgYXJlIHJlamVjdGVkLCBhbmQgdGhlIG5hbWVcbi8vIGlzIGxvY2tlZCBmcm9tIHJlLW9wZW4gdW50aWwgdW5hcmNoaXZlZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZE1hcmsoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWQ6IG51bWJlcixcbiAgZGlzcG9zaXRpb246IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICBvcHRzOiB7IG5vdGU/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkgfHwgIWRpc3Bvc2l0aW9uKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgbWFyayA8Y2hhbm5lbD4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSBbLS1hcyA8YWxpYXM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgZnJvbSwgdGFyZ2V0OiBpZCwgZGlzcG9zaXRpb24gfTtcbiAgaWYgKG9wdHMubm90ZSAhPT0gdW5kZWZpbmVkKSBib2R5Lm5vdGUgPSBvcHRzLm5vdGU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZT4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9zdGF0dXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhIGFzIHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1cyk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQXJjaGl2ZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIHVuYXJjaGl2ZTogYm9vbGVhbiwgZnJvbT86IHN0cmluZykge1xuICBjb25zdCB2ZXJiID0gdW5hcmNoaXZlID8gXCJ1bmFyY2hpdmVcIiA6IFwiYXJjaGl2ZVwiO1xuICBpZiAoIW5hbWUpIGRpZShgdXNhZ2U6IGdyYXBldmluZSAke3ZlcmJ9IDxjaGFubmVsPmApO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJvdGggcm91dGVzIGFwcGVuZCBhIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSB0byB0aGUgbG9nLCBzbyB3aG8gZGlkIGl0IGlzIHdvcnRoXG4gIC8vIHJlY29yZGluZyB3aGVuIHRoZSBjYWxsZXIgdG9sZCB1cy4gSWRlbnRpdHkgaXMgb3B0aW9uYWwgaGVyZSAoaXQgaXMgb24gdGhlXG4gIC8vIGdsb2JhbGx5LWFjY2VwdGVkIC0tYXMvLS1mcm9tKSwgYW5kIHRoZSBkYWVtb24gc2lnbnMgXCJzeXN0ZW1cIiB3aXRob3V0IGl0LlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS8ke3ZlcmJ9YCxcbiAgICBmcm9tID8geyBmcm9tIH0gOiB1bmRlZmluZWQsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0b3Aob3B0czogeyBob2xkU2Vjb25kcz86IG51bWJlciB9ID0ge30pIHtcbiAgbGV0IGhlbGRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBpZiAob3B0cy5ob2xkU2Vjb25kcyAmJiBvcHRzLmhvbGRTZWNvbmRzID4gMCkge1xuICAgIGhlbGRVbnRpbCA9IERhdGUubm93KCkgKyBvcHRzLmhvbGRTZWNvbmRzICogMTAwMDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhIT0xEX0ZJTEUsIFN0cmluZyhoZWxkVW50aWwpKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGRhZW1vbjogZmFsc2UsXG4gICAgICAuLi4oaGVsZFVudGlsICE9PSB1bmRlZmluZWQgPyB7IGhlbGRfdW50aWw6IGhlbGRVbnRpbCB9IDoge30pLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wcGVkOiB0cnVlLFxuICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBQZXItY2hhbm5lbCBsaXZlLWNvbm5lY3Rpb24gc3VtbWFyeSDigJQgdGhlIHJlc3RhcnQtc2FmZXR5IHJlYWQuIE1pcnJvcnMgd2hhdFxuLy8gYGRvY3RvcmAgcmVwb3J0cyB1bmRlciBhY3RpdmVfc3Vic2NyaWJlcnM7IG9ubHkgcG9wdWxhdGVkIGNoYW5uZWxzIGFyZSBsaXN0ZWQuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKFxuICBwb3J0OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgdG90YWw6IG51bWJlcjsgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+IH0+IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgY29uc3QgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgZm9yIChjb25zdCBjaCBvZiBkYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgdG90YWwgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICBpZiAoY2guY29ubmVjdGlvbnMgPiAwKSBjaGFubmVscy5wdXNoKHsgbmFtZTogY2gubmFtZSwgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zIH0pO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnQg4oCUIGEgcHJlc2VuY2UgaGljY3VwIHNob3VsZG4ndCBjcmFzaCBhIGxpZmVjeWNsZSB2ZXJiXG4gIH1cbiAgcmV0dXJuIHsgdG90YWwsIGNoYW5uZWxzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXJ0KCkge1xuICAvLyBFbnN1cmUtcnVubmluZywgbm8gY2hhbm5lbCBzaWRlLWVmZmVjdC4gSWRlbXBvdGVudDogcmVwb3J0IGFuIGV4aXN0aW5nXG4gIC8vIGRhZW1vbiwgb3Igc3Bhd24gYSBmcmVzaCBvbmUuIFRoZSBleHBsaWNpdCBcImJyaW5nIGl0IHVwXCIgdmVyYiDigJQgZGlhZ25vc3RpY3NcbiAgLy8gKGRvY3Rvci9pbmZvL2xpc3QpIHN0YXkgcmVhZC1vbmx5IGFuZCBuZXZlciBzcGF3bi5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIWV4aXN0aW5nICYmIGhvbGRBY3RpdmUoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBoZWxkOiB0cnVlLCBwb3J0OiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwb3J0ID0gZXhpc3RpbmcgPz8gKGF3YWl0IGVuc3VyZURhZW1vbigpKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHBvcnQsIGFscmVhZHlfcnVubmluZzogZXhpc3RpbmcgIT09IG51bGwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc3RhcnQob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gTm90aGluZyB0byB0ZWFyIGRvd24g4oCUIGp1c3QgYnJpbmcgYSBmcmVzaCBkYWVtb24gdXAuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTQUZFVFk6IGEgcmVzdGFydCBmb3JjZXMgZXZlcnkgY29ubmVjdGVkIGNsaWVudCB0byBhdXRvLXJlY29ubmVjdC4gUmVmdXNlIHRvXG4gIC8vIHRlYXIgZG93biBhIHdvcmtpbmcgZmxlZXQgdW5sZXNzIGV4cGxpY2l0bHkgZm9yY2VkIOKAlCBuZXZlciBzaWxlbnRseSBkcm9wIGl0LlxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcmVzdGFydDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7Y2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIOKAlCAke3doZXJlfS4gYCArXG4gICAgICAgIFwiQSByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gYWxsIHRvIHJlY29ubmVjdC4gUmUtcnVuIHdpdGggLS1mb3JjZSAob3IgLS15ZXMpIHRvIHByb2NlZWQgYW55d2F5LlwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FwdHVyZSB0aGUgcGlkIHdlJ3JlIHJlcGxhY2luZywgZm9yIHRoZSByZWNlaXB0LlxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgcHJldmlvdXNQaWQgPSBkYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wLCB0aGVuIHdhaXQgZm9yIHRoZSBvbGQgZGFlbW9uIHRvIGFjdHVhbGx5IGdvIGF3YXkg4oCUIGl0IHVubGlua3MgaXRzXG4gIC8vIHBvcnQvcGlkIGZpbGVzIG9uIHNodXRkb3duLCBzbyBlbnN1cmVEYWVtb24gc3Bhd25zIGZyZXNoIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRpc2NvdmVyaW5nIHRoZSBkeWluZyBvbmUuXG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCB9KTtcbn1cblxuLy8gYjMg4oCUIFRIRSBWRVJTSU9OIFZFUklGWSwgQVMgT05FIFNPVVJDRSBGT1IgQk9USCBQQVRIUy5cbi8vXG4vLyBgcm9sbGAgaXMgZG9jdW1lbnRlZCBhcyBcInRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcCDigKYgKyB2ZXJzaW9uIHZlcmlmeVwiLCBhbmRcbi8vIHRoZSB2ZXJpZnkgaGFkIHR3byB3YXlzIHRvIHNheSBub3RoaW5nOlxuLy9cbi8vICAgQ09MRCBQQVRIIOKAlCBubyBkYWVtb24gcnVubmluZzogaXQgc3Bhd25lZCBvbmUgYW5kIHByaW50ZWQgbmVpdGhlciBgdmVyc2lvbmBcbi8vICAgbm9yIGB2ZXJzaW9uX29rYC4gVGhlIGZpZWxkcyB3ZXJlIEFCU0VOVCwgc28gYSBjYWxsZXIgY2hlY2tpbmcgdGhlIHZlcmlmeVxuLy8gICBnb3QgYHVuZGVmaW5lZGAgb24gdGhlIGV4YWN0IHBhdGggd2hlcmUgdGhlIHZlcmlmeSBuZXZlciBoYXBwZW5lZC5cbi8vXG4vLyAgIFdBUk0gUEFUSCDigJQgdGhlIHByb2JlIHdhcyB3cmFwcGVkIGluIGBjYXRjaCB7fWAsIGxlYXZpbmcgYHZlcnNpb24gPSBudWxsYCxcbi8vICAgYW5kIGB2ZXJzaW9uX29rOiBudWxsID09PSBQTFVHSU5fVkVSU0lPTmAgZXZhbHVhdGVzIHRvIEZBTFNFLiBcIkkgY291bGQgbm90XG4vLyAgIGNoZWNrXCIgd2FzIHJlcG9ydGVkIGFzIFwidGhlIHZlcnNpb24gaXMgV1JPTkdcIiDigJQgYSBib29sZWFuIHRoYXQgY2Fubm90IHNheVxuLy8gICBcInVua25vd25cIiBpcyB0aGUgY2Fub25pY2FsIHNoYXBlIG9mIHRoaXMgc3ByaW50J3MgZGVmZWN0LCBhbmQgZmFsc2UgaXMgdGhlXG4vLyAgIHdvcnN0IGF2YWlsYWJsZSBhbnN3ZXIgYmVjYXVzZSBpdCBpcyBhY3Rpb25hYmxlIGFuZCBpbmNvcnJlY3QuXG4vL1xuLy8gU28gYHZlcnNpb25fb2tgIGlzIG5vdyBgYm9vbGVhbiB8IG51bGxgOiBudWxsIG1lYW5zIFVOQ0hFQ0tFRCwgbmV2ZXIgZmFsc2UuXG4vLyBgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uYCBpcyBwcmVzZW50LWFuZC1udWxsIGJlc2lkZSBpdCwgYmVjYXVzZSBhIGJhcmUgbnVsbFxuLy8gdGVsbHMgYSBjYWxsZXIgdGhlIGNoZWNrIGRpZCBub3QgaGFwcGVuIGFuZCBub3Qgd2h5LlxuLy9cbi8vIE9uZSBoZWxwZXIgcmF0aGVyIHRoYW4gdHdvIGNhbGwgc2l0ZXM6IGEgc2Vjb25kIGNvcHkgb2YgdGhpcyBsb2dpYyBvbiB0aGUgY29sZFxuLy8gcGF0aCBpcyB0aGUgbWlycm9yLWRyaWZ0IHRyYXAsIGFuZCB0aGUgY29sZCBwYXRoIGlzIHByZWNpc2VseSB0aGUgb25lIG5vYm9keVxuLy8gcmUtcmVhZHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVWZXJzaW9uKHBvcnQ6IG51bWJlcik6IFByb21pc2U8e1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB2ZXJzaW9uX29rOiBib29sZWFuIHwgbnVsbDtcbiAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBzdHJpbmcgfCBudWxsO1xufT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHYgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAodiA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBcInRoZSBkYWVtb24gYW5zd2VyZWQgYnV0IHJlcG9ydGVkIG5vIHZlcnNpb25cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IHZlcnNpb246IHYsIHZlcnNpb25fb2s6IHYgPT09IFBMVUdJTl9WRVJTSU9OLCB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IG51bGwgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogYGNvdWxkIG5vdCByZWFjaCB0aGUgZGFlbW9uIHRvIHZlcmlmeTogJHtcbiAgICAgICAgZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJvbGwob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gQ09MRCBQQVRIIOKAlCBub3RoaW5nIHdhcyBydW5uaW5nLCBzbyB0aGlzIGlzIGEgc3RhcnQgcmF0aGVyIHRoYW4gYSByb2xsLlxuICAgIC8vIEl0IHN0aWxsIHJlcG9ydHMgdGhlIHZlcmlmeSwgYmVjYXVzZSBcIm5vIGRhZW1vbiB3YXMgdXBcIiBpcyBub3QgYSByZWFzb24gdG9cbiAgICAvLyBzdGF5IHNpbGVudCBhYm91dCB3aGljaCB2ZXJzaW9uIGlzIG5vdyBzZXJ2aW5nLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgcm9sbGVkOiB0cnVlLFxuICAgICAgcHJldmlvdXNfcGlkOiBudWxsLFxuICAgICAgcG9ydDogZnJlc2gsXG4gICAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByb2xsOiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSDigJQgJHt3aGVyZX0uIFRoZXknbGwgYXV0by1yZWNvbm5lY3QgYWNyb3NzIHRoZSByb2xsLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIHByb2NlZWQuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcHJldmlvdXNQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3Agd2l0aCBhIHNob3J0IGhvbGQgc28gYSBzdGFsZSBDTEkgY2FuJ3Qgd2luIHRoZSByZXNwYXduIHJhY2U7IHdlIGhvbGQgdGhlIHNwYXduIG91cnNlbHZlcy5cbiAgY29uc3QgaG9sZE1zID0gNDAwMDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKERhdGUubm93KCkgKyBob2xkTXMpKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgaWYgKChhd2FpdCByZWFkRGFlbW9uUG9ydCgpKSA9PT0gbnVsbCkgYnJlYWs7XG4gIH1cbiAgcmVsZWFzZUhvbGQoKTsgLy8gb3VyIHR1cm4gdG8gc3Bhd24gdGhlIG5ldyB2ZXJzaW9uXG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGxldCBwaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIHBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KGZyZXNoLCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgcm9sbGVkOiB0cnVlLFxuICAgIHByZXZpb3VzX3BpZDogcHJldmlvdXNQaWQsXG4gICAgcGlkLFxuICAgIHBvcnQ6IGZyZXNoLFxuICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhdGNoKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAvLyBDaGFubmVsIG5hbWUgaXMgb3B0aW9uYWwg4oCUIHRoZSBwYWdlIHJlYWRzIGl0IGZyb20gdGhlIFVSTCBoYXNoIGFuZFxuICAvLyBkZWZhdWx0cyB0byBcImxvYmJ5XCIgaWYgYWJzZW50LiBXZSBwYXNzIHRocm91Z2ggd2hhdGV2ZXIgdGhlIHVzZXIgZ2F2ZVxuICAvLyAob3IgXCJsb2JieVwiKSBhbmQgb3BlbiB0aGUgYnJvd3Nlci4gRGFlbW9uIGlzIGVuc3VyZWQgc28gdGhlIHNlcnZlZFxuICAvLyAvd2F0Y2ggSFRNTCBpcyByZWFjaGFibGUuXG4gIGNvbnN0IGNoYW5uZWwgPSBuYW1lPy50cmltKCkgPyBuYW1lLnRyaW0oKSA6IFwibG9iYnlcIjtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBFbnN1cmUgdGhlIGNoYW5uZWwgZXhpc3RzIHNvIHRoZSBwYWdlIHNlZXMgYSB2YWxpZCBiYWNrbG9nL3RvcGljLlxuICBhd2FpdCBhcGkocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZTogY2hhbm5lbCB9KTtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS93YXRjaCMke2VuY29kZVVSSUNvbXBvbmVudChjaGFubmVsKX1gO1xuICAvLyBPcGVuIHRoZSBicm93c2VyIHZpYSB0aGUgcGxhdGZvcm0ncyBkZWZhdWx0IG9wZW5lci4gQmVzdC1lZmZvcnQg4oCUXG4gIC8vIHByaW50IHRoZSBVUkwgc28gdGhlIHVzZXIgY2FuIGNsaWNrIGl0IGlmIGF1dG8tb3BlbiBmYWlscy5cbiAgY29uc3Qgb3BlbmVyID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcImV4cGxvcmVyXCIgOiBcInhkZy1vcGVuXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgcCA9IHNwYXduKG9wZW5lciwgW3VybF0sIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgfSk7XG4gICAgcC51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBvcGVuZXIgbWlzc2luZyDigJQganVzdCBwcmludCAqL1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsLCB1cmwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZERvY3RvcigpIHtcbiAgLy8gUmVhZC1vbmx5IGRpYWdub3N0aWMuIFJlcG9ydHMgdGhlIGF1dGhvcml0YXRpdmUgZGFlbW9uIChpZiBhbnkpLCBvdGhlclxuICAvLyBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3NlcyB2aXNpYmxlIG9uIHRoZSBtYWNoaW5lLCBjaGFubmVsIGZpbGVzIG9uXG4gIC8vIGRpc2ssIGFuZCBzdXJmYWNlcyBoaW50cy4gRG9lcyBOT1QgdGFrZSBkZXN0cnVjdGl2ZSBhY3Rpb24g4oCUIGNsZWFudXBcbiAgLy8gaXMgdGhlIG9wZXJhdG9yJ3MgY2FsbCwgd2l0aCBzdG9jayB1bml4IHRvb2xzLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgbGV0IGF1dGhvcml0YXRpdmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gIC8vIFBlci1jaGFubmVsIHN1YnNjcmliZXIgc3VtbWFyeSDigJQgYW5zd2VycyBcImlzIGl0IHNhZmUgdG8gcmVzdGFydCB0aGVcbiAgLy8gZGFlbW9uIHJpZ2h0IG5vdz9cIiB3aXRob3V0IG5lZWRpbmcgdG8gYWxzbyBydW4gYGxpc3RgIGFuZCByZWFkIHRoZVxuICAvLyBvdXRwdXQuIEVtcHR5IGlmIG5vIGRhZW1vbiBpcyBydW5uaW5nLlxuICBsZXQgdG90YWxTdWJzY3JpYmVycyA9IDA7XG4gIGNvbnN0IGJ1c3lDaGFubmVsczogQXJyYXk8e1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAgIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gICAgbmFtZWQ6IG51bWJlcjtcbiAgICBhbm9ueW1vdXM6IG51bWJlcjtcbiAgfT4gPSBbXTtcbiAgaWYgKHBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICAgIGF1dGhvcml0YXRpdmUgPSB7IHBvcnQsIC4uLmRhdGEgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGRhZW1vbiB3ZW50IGF3YXkgYmV0d2VlbiBwb3J0IGNoZWNrIGFuZCBhcGkgY2FsbFxuICAgIH1cbiAgICB0cnkge1xuICAgICAgLy8gL3ByZXNlbmNlIGdpdmVzIHRoZSBob25lc3QgcGVyLWNoYW5uZWwgYnJlYWtkb3duIChjb25uZWN0aW9ucyB2cyBuYW1lZFxuICAgICAgLy8gdnMgYW5vbnltb3VzKSDigJQgc28gdGhlIHJlc3RhcnQtc2FmZXR5IHRvdGFsIGlzbid0IGEgbXlzdGVyeSBhbmQgYW5cbiAgICAgIC8vIGFub255bW91cyB3YXRjaCB0YWIgcmVhZHMgYXMgYSB3YXRjaGVyLCBub3QgYSBnaG9zdC5cbiAgICAgIGNvbnN0IHsgZGF0YTogcHJlc0RhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgcHJlc0RhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICAgIHRvdGFsU3Vic2NyaWJlcnMgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICAgIGJ1c3lDaGFubmVscy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBjaC5uYW1lLFxuICAgICAgICAgIHN1YnNjcmliZXJzOiBjaC5jb25uZWN0aW9ucywgLy8gYmFjay1jb21wYXQ6IHByZXZpb3VzbHkgdGhlIHJhdyBjb3VudFxuICAgICAgICAgIGNvbm5lY3Rpb25zOiBjaC5jb25uZWN0aW9ucyxcbiAgICAgICAgICBuYW1lZDogY2gubmFtZWQsXG4gICAgICAgICAgYW5vbnltb3VzOiBjaC5hbm9ueW1vdXMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gYmVzdC1lZmZvcnRcbiAgICB9XG4gIH1cblxuICAvLyBFbnVtZXJhdGUgb3RoZXIgZGFlbW9uIHByb2Nlc3NlcyB2aWEgdGhlIHNoYXJlZCBjbGFzc2lmaWVyLiBFYWNoIGVudHJ5XG4gIC8vIGdhaW5zIHBvcnQvaG9tZS92ZXJzaW9uL3N0YXR1cy9yZWFwYWJsZSBzbyB0aGUgb3BlcmF0b3IgaGFzIHRoZSBmdWxsXG4gIC8vIHBpY3R1cmUgd2l0aG91dCBuZWVkaW5nIGEgc2VwYXJhdGUgYHJlYXAgLS1kcnktcnVuYC5cbiAgY29uc3Qgb3RoZXJEYWVtb25zOiBBcnJheTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGNsYXNzaWZ5RGFlbW9uPj4gJiB7IGNvbW1hbmQ/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3Qgc2VsZlBpZCA9IGF1dGhvcml0YXRpdmU/LnBpZCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBwaWQgb2YgYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKSkge1xuICAgICAgaWYgKHNlbGZQaWQgJiYgcGlkID09PSBzZWxmUGlkKSBjb250aW51ZTtcbiAgICAgIG90aGVyRGFlbW9ucy5wdXNoKGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCkpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IGNhcnJ5IG9uIHdpdGggZW1wdHkgbGlzdFxuICB9XG5cbiAgLy8gQ2hhbm5lbHMgb24gZGlzayB1bmRlciB0aGlzIEhPTUUuXG4gIGNvbnN0IGNoYW5uZWxzT25EaXNrOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGNoYW5uZWxzRGlyID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZiBvZiByZWFkZGlyU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgICAgaWYgKGYuZW5kc1dpdGgoXCIuanNvbmxcIikpIGNoYW5uZWxzT25EaXNrLnB1c2goZi5yZXBsYWNlKC9cXC5qc29ubCQvLCBcIlwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHt9XG5cbiAgLy8gSGludHMg4oCUIHN1cmZhY2UgdGhlIG1vc3QgYWN0aW9uYWJsZSBzaWduYWxzLlxuICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIFwiTm8gYXV0aG9yaXRhdGl2ZSBkYWVtb24gcnVubmluZyBmb3IgdGhpcyBIT01FLiBSdW4gYW55IHZlcmIgKGUuZy4gYGNsaS50cyBsaXN0YCkgdG8gc3Bhd24gb25lLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG90aGVyRGFlbW9ucy5sZW5ndGggPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBGb3VuZCAke290aGVyRGFlbW9ucy5sZW5ndGh9IG90aGVyIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzcyhlcykgb24gdGhpcyBtYWNoaW5lLiBgICtcbiAgICAgICAgXCJUaGV5IG1heSBiZSB6b21iaWVzIGZyb20gcGFzdCBydW5zIE9SIGRhZW1vbnMgc2VydmluZyBvdGhlciBIT01FcyAoZGlmZmVyZW50IEdSQVBFVklORV9IT01FKS5cIixcbiAgICApO1xuICAgIGNvbnN0IHJlYXBhYmxlQ291bnQgPSBvdGhlckRhZW1vbnMuZmlsdGVyKChkKSA9PiBkLnJlYXBhYmxlKS5sZW5ndGg7XG4gICAgaWYgKHJlYXBhYmxlQ291bnQgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgRm91bmQgJHtyZWFwYWJsZUNvdW50fSByZWFwYWJsZSBvcnBoYW4gZGFlbW9uKHMpLiBSdW4gXFxgZ3JhcGV2aW5lIHJlYXBcXGAgdG8gY2xlYXIgdGhlbSBzYWZlbHkuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvdGhlckRhZW1vbnMuc29tZSgoZCkgPT4gZC5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIpKSB7XG4gICAgICBoaW50cy5wdXNoKFwiU29tZSBkYWVtb25zIGFyZSB1bnJlc3BvbnNpdmU7IGBncmFwZXZpbmUgcmVhcCAtLWZvcmNlYCBpbmNsdWRlcyB0aGVtLlwiKTtcbiAgICB9XG4gIH1cbiAgaWYgKFxuICAgIGF1dGhvcml0YXRpdmUgJiZcbiAgICBQTFVHSU5fVkVSU0lPTiAmJlxuICAgIHR5cGVvZiBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IFwic3RyaW5nXCIgJiZcbiAgICBhdXRob3JpdGF0aXZlLnZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OXG4gICkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgQXV0aG9yaXRhdGl2ZSBkYWVtb24gdmVyc2lvbiAoJHthdXRob3JpdGF0aXZlLnZlcnNpb259KSBkaWZmZXJzIGZyb20gdGhpcyBDTEkncyB2ZXJzaW9uICgke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICBcIlJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbiDigJQgZHJvcCBhY3RpdmUgdGFpbHMsIHRoZW4gYHN0b3BgLCB0aGVuIGFueSB2ZXJiLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGF1dGhvcml0YXRpdmUgJiYgKGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gbnVsbCB8fCBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IHVuZGVmaW5lZCkpIHtcbiAgICBoaW50cy5wdXNoKFwiQXV0aG9yaXRhdGl2ZSBkYWVtb24gcHJlZGF0ZXMgdmVyc2lvbiByZXBvcnRpbmcgKHByZS1WMS42LjIpLiBSZXN0YXJ0IHRvIGFsaWduLlwiKTtcbiAgfVxuICBpZiAodG90YWxTdWJzY3JpYmVycyA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYCR7dG90YWxTdWJzY3JpYmVyc30gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7YnVzeUNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKS4gYCArXG4gICAgICAgIFwiRGFlbW9uIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSB0byBhdXRvLXJlY29ubmVjdCAod29ya3MsIGJ1dCBkaXNydXB0aXZlKSDigJQgY29vcmRpbmF0ZSBmaXJzdC5cIixcbiAgICApO1xuICB9IGVsc2UgaWYgKGF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFwiTm8gYWN0aXZlIHN1YnNjcmliZXJzIOKAlCBkYWVtb24gcmVzdGFydCBpcyBub24tZGlzcnVwdGl2ZS5cIik7XG4gIH1cbiAgLy8gRXhwbGFpbiBhbnkgY2hhbm5lbCB3aGVyZSB0aGUgY29ubmVjdGlvbiBjb3VudCBleGNlZWRzIG5hbWVkIGFnZW50cyDigJQgYW5cbiAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiBpbmZsYXRlcyBgY291bnRgL2Bjb25uZWN0aW9uc2AgYnV0IGlzbid0IGEgZ2hvc3QuXG4gIGZvciAoY29uc3QgY2ggb2YgYnVzeUNoYW5uZWxzKSB7XG4gICAgaWYgKGNoLmFub255bW91cyA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2NoLm5hbWV9OiAke2NoLmNvbm5lY3Rpb25zfSBjb25uZWN0aW9uKHMpLCAke2NoLm5hbWVkfSBuYW1lZCBhZ2VudChzKSArIGAgK1xuICAgICAgICAgIGAke2NoLmFub255bW91c30gYW5vbnltb3VzIChlLmcuIGEgd2F0Y2ggdGFiKS4gVGhlIGNvdW50IG92ZXIgdGhlIG5hbWUgbGlzdCBpcyBleHBlY3RlZCwgbm90IGEgZ2hvc3QuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBob21lOiBEQVRBX0RJUixcbiAgICBjbGlfdmVyc2lvbjogUExVR0lOX1ZFUlNJT04sXG4gICAgYXV0aG9yaXRhdGl2ZSxcbiAgICBhY3RpdmVfc3Vic2NyaWJlcnM6IHtcbiAgICAgIHRvdGFsOiB0b3RhbFN1YnNjcmliZXJzLFxuICAgICAgYnVzeV9jaGFubmVsczogYnVzeUNoYW5uZWxzLFxuICAgIH0sXG4gICAgb3RoZXJfZGFlbW9uc19vbl9tYWNoaW5lOiBvdGhlckRhZW1vbnMsXG4gICAgY2hhbm5lbHNfb25fZGlzazogY2hhbm5lbHNPbkRpc2ssXG4gICAgaGludHMsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRJbmZvKCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gZW51bWVyYXRpb24gKyBjbGFzc2lmaWVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogQWxsIGdyYXBldmluZSBkYWVtb24udHMgcGlkcyB2aXNpYmxlIG9uIHRoaXMgbWFjaGluZSAodmlhIGBwc2ApLiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuICBjb25zdCBwaWRzOiBudW1iZXJbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcInBzXCIsIFtcIi1lb1wiLCBcInBpZCxjb21tYW5kXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY29uc3Qgb3V0ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmLThcIik7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKFwiZGFlbW9uLnRzXCIpKSBjb250aW51ZTtcbiAgICAgIGlmICghbGluZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZ3JhcGV2aW5lXCIpKSBjb250aW51ZTtcbiAgICAgIC8vIFRoZSBwaWQgZ3JvdXAgaXMgbWFuZGF0b3J5OyBhbiB1bm1hdGNoZWQgbGluZSBpcyBza2lwcGVkLCBhcyBiZWZvcmUuXG4gICAgICBjb25zdCBkaWdpdHMgPSBsaW5lLm1hdGNoKC9eXFxzKihcXGQrKVxccysvKT8uWzFdO1xuICAgICAgaWYgKGRpZ2l0cyA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBpZCA9IHBhcnNlSW50KGRpZ2l0cywgMTApO1xuICAgICAgaWYgKHBpZCkgcGlkcy5wdXNoKHBpZCk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwcyB1bmF2YWlsYWJsZTsgcmV0dXJuIGVtcHR5XG4gIH1cbiAgcmV0dXJuIHBpZHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxzb2ZMaXN0ZW5Qb3J0KHBpZDogbnVtYmVyKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcHJvYyA9IHNwYXduKFwibHNvZlwiLCBbXCItYWlUQ1BcIiwgXCItc1RDUDpMSVNURU5cIiwgXCItcFwiLCBTdHJpbmcocGlkKSwgXCItUFwiLCBcIi1uXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcigpKSk7XG4gICAgLy8gVGhlIHBvcnQgZ3JvdXAgaXMgbWFuZGF0b3J5OyBubyBtYXRjaCBpcyB0aGlzIGZ1bmN0aW9uJ3Mgb3duIGBudWxsYC5cbiAgICBjb25zdCBkaWdpdHMgPSBCdWZmZXIuY29uY2F0KGNodW5rcylcbiAgICAgIC50b1N0cmluZyhcInV0Zi04XCIpXG4gICAgICAubWF0Y2goLzEyN1xcLjBcXC4wXFwuMTooXFxkKykvKT8uWzFdO1xuICAgIHJldHVybiBkaWdpdHMgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBwYXJzZUludChkaWdpdHMsIDEwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IHR5cGUgRGFlbW9uU3RhdHVzID0gXCJhdXRob3JpdGF0aXZlXCIgfCBcIm9ycGhhblwiIHwgXCJ1bnJlc3BvbnNpdmVcIiB8IFwidW5rbm93blwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnlEYWVtb24ocGlkOiBudW1iZXIpOiBQcm9taXNlPHtcbiAgcGlkOiBudW1iZXI7XG4gIHBvcnQ6IG51bWJlciB8IG51bGw7XG4gIGhvbWU/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IERhZW1vblN0YXR1cztcbiAgcmVhcGFibGU6IGJvb2xlYW47XG59PiB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBsc29mTGlzdGVuUG9ydChwaWQpO1xuICBpZiAoIXBvcnQpIHJldHVybiB7IHBpZCwgcG9ydDogbnVsbCwgc3RhdHVzOiBcInVua25vd25cIiwgcmVhcGFibGU6IGZhbHNlIH07XG4gIGxldCBpbmZvOiBSb290SW5mbyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDgwMCksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykgaW5mbyA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgfSBjYXRjaCB7fVxuICBpZiAoIWluZm8pIHJldHVybiB7IHBpZCwgcG9ydCwgc3RhdHVzOiBcInVucmVzcG9uc2l2ZVwiLCByZWFwYWJsZTogZmFsc2UgfTsgLy8gcmVhcCBvbmx5IHdpdGggLS1mb3JjZSAoaGFuZGxlZCBpbiBjbWRSZWFwKVxuICBjb25zdCBob21lID0gaW5mby5kYXRhX2RpciBhcyBzdHJpbmc7XG4gIGxldCBvd25zID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3AgPSByZWFkRmlsZVN5bmMoam9pbihob21lLCBcImRhZW1vbi5wb3J0XCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBjb25zdCBvaSA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBpZFwiKSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgb3ducyA9IG9wID09PSBTdHJpbmcocG9ydCkgJiYgb2kgPT09IFN0cmluZyhwaWQpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBvd25zXG4gICAgPyB7XG4gICAgICAgIHBpZCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgaG9tZSxcbiAgICAgICAgdmVyc2lvbjogaW5mby52ZXJzaW9uID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogXCJhdXRob3JpdGF0aXZlXCIsXG4gICAgICAgIHJlYXBhYmxlOiBmYWxzZSxcbiAgICAgIH1cbiAgICA6IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcIm9ycGhhblwiLFxuICAgICAgICByZWFwYWJsZTogdHJ1ZSxcbiAgICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYXAob3B0czogeyBmb3JjZT86IGJvb2xlYW47IGRyeVJ1bj86IGJvb2xlYW4gfSkge1xuICBjb25zdCBzZWxmUG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7IC8vIGN1cnJlbnQgSE9NRSBhdXRob3JpdGF0aXZlIChuZXZlciByZWFwKVxuICBsZXQgc2VsZlBpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGlmIChzZWxmUG9ydCkge1xuICAgIHRyeSB7XG4gICAgICBzZWxmUGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4oc2VsZlBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGNvbnN0IHBpZHMgPSBhd2FpdCBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpO1xuICBjb25zdCBrZXB0OiB1bmtub3duW10gPSBbXSxcbiAgICByZWFwZWQ6IHVua25vd25bXSA9IFtdLFxuICAgIHNraXBwZWQ6IHVua25vd25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBpZCBvZiBwaWRzKSB7XG4gICAgY29uc3QgYyA9IGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCk7XG4gICAgY29uc3QgaXNTZWxmID0gcGlkID09PSBzZWxmUGlkO1xuICAgIGNvbnN0IHNob3VsZFJlYXAgPVxuICAgICAgIWlzU2VsZiAmJiAoYy5yZWFwYWJsZSB8fCAoYy5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIgJiYgb3B0cy5mb3JjZSA9PT0gdHJ1ZSkpO1xuICAgIGlmICghc2hvdWxkUmVhcCkge1xuICAgICAga2VwdC5wdXNoKGMpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChvcHRzLmRyeVJ1bikge1xuICAgICAgc2tpcHBlZC5wdXNoKHsgLi4uYywgbm90ZTogXCJkcnktcnVuXCIgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3Mua2lsbChwaWQsIFwiU0lHVEVSTVwiKTtcbiAgICAgIHJlYXBlZC5wdXNoKGMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgc2tpcHBlZC5wdXNoKHsgLi4uYywgbm90ZTogXCJraWxsIGZhaWxlZFwiIH0pO1xuICAgIH1cbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZHJ5X3J1bjogISFvcHRzLmRyeVJ1biwga2VwdCwgcmVhcGVkLCBza2lwcGVkIH0pO1xufVxuXG4vLyAoQk9PTEVBTl9GTEFHUyB3YXMgaGVyZS4gSXQgbGlzdGVkIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUg4oCUIGhhbGYgYVxuLy8gcmVnaXN0cnksIGNvbnN1bHRlZCBieSB0aGUgaGFuZC1yb2xsZWQgcGFyc2VyLiBJdHMgMTMgZW50cmllcyBub3cgbGl2ZSBpblxuLy8gQ0xJX09QVElPTlMgYmVsb3cgYXMgYHt0eXBlOlwiYm9vbGVhblwifWAsIHZlcmlmaWVkIDEzLWZvci0xMyBhZ2FpbnN0IHRob3RoJ3Ncbi8vIGluZGVwZW5kZW50bHktZGVyaXZlZCBhcnRpZmFjdCBiZWZvcmUgdGhlIG1vdmUuIERlbGV0ZWQgcmF0aGVyIHRoYW4gbGVmdFxuLy8gYmVzaWRlIGl0cyByZXBsYWNlbWVudDogYSBzZWNvbmQgc291cmNlIG9mIHRydXRoIGZvciB0aGUgc2FtZSBmYWN0IGlzIHRoZVxuLy8gZHJpZnQgYnVnIHRoaXMgbGFuZSBleGlzdHMgdG8gcmVtb3ZlLCBhbmQgaXQgd291bGQgbm8gbG9uZ2VyIGJlIGNvbnN1bHRlZFxuLy8gYnkgYW55dGhpbmcuKVxuXG4vLyBTaWduYXR1cmUgb2YgYSBoZXJlZG9jIGZ1bWJsZTogYSBsaW5lIHRoYXQgaXMgKG9yIGJlZ2lucyB3aXRoKSBhXG4vLyBgYnVuIOKApiBjbGkudHMg4oCmIHNlbmRgIGludm9jYXRpb24uIFdoZW4gYSBgc2VuZCAtLXN0ZGluIDw8RU9GYCBpcyBib3RjaGVkLCB0aGVcbi8vIHNoZWxsIHBpcGVzIHRoZSBsaXRlcmFsIGNvbW1hbmQgbGluZSBpbiBhcyB0aGUgYm9keSwgd2hpY2ggdGhlbiBnZXRzIHBvc3RlZCDigJRcbi8vIGNvcnJ1cHRpbmcgdGhlIGNoYW5uZWwgd2l0aCBgYnVuIC/igKYvY2xpLnRzIHNlbmQgPGNoYW5uZWw+IC0tYXMg4oCmIDx0ZXh0PmAuXG4vLyBXZSByZWZ1c2UgdG8gcG9zdCBzdWNoIGEgYm9keSB1bmxlc3MgLS1mb3JjZSBpcyBwYXNzZWQuXG5jb25zdCBMRUFLRURfU0VORF9SRSA9IC8oPzpefFxcbilbIFxcdF0qYnVuXFxiW15cXG5dKlxcYmNsaVxcLnRzXFxiW15cXG5dKlxcYig/OnNlbmR8YW5ub3VuY2UpXFxiLztcbmZ1bmN0aW9uIGxvb2tzTGlrZUxlYWtlZFNlbmQodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBMRUFLRURfU0VORF9SRS50ZXN0KHRleHQpO1xufVxuXG4vLyBTaGVsbC1tZXRhY2hhcmFjdGVyIGZvb3RndW4gKCM2MCk6IGEgYm9keSBwYXNzZWQgYXMgYW4gSU5MSU5FIHBvc2l0aW9uYWwgYXJnXG4vLyBpcyBleHBvc2VkIHRvIHRoZSBjYWxsZXIncyBzaGVsbCwgd2hpY2ggY29tbWFuZC1zdWJzdGl0dXRlcyBiYWNrdGlja3MgL1xuLy8gYCQoLi4uKWAgLyBgJHsuLi59YCBCRUZPUkUgZ3JhcGV2aW5lIHNlZXMgaXQg4oCUIGNvcnJ1cHRpbmcgb3IgcGFydGlhbGx5XG4vLyBleGVjdXRpbmcgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLiBUaGUgQ0xJIGNhbid0IHVuLXN1YnN0aXR1dGUgd2hhdCB0aGUgc2hlbGxcbi8vIGFscmVhZHkgYXRlOyB0aGUgaG9uZXN0IGZpeCBpcyB0byBzdGVlciBjYWxsZXJzIHRvIHRoZSBzaGVsbC1mcmVlIHBhdGhzXG4vLyAoLS1ib2R5LWZpbGUgLyAtLXN0ZGluIC8gZGVmYXVsdC1zdGRpbikuIFdoZW4gbWV0YWNoYXJhY3RlcnMgU1VSVklWRSBpbnRvIGFuXG4vLyBpbmxpbmUgYm9keSAoZS5nLiB0aGUgY2FsbGVyIGhhcHBlbmVkIHRvIHNpbmdsZS1xdW90ZSksIHRoZXkncmUgaW50YWN0IHRoaXNcbi8vIHRpbWUg4oCUIGJ1dCB0aGUgcGF0dGVybiBpcyBhIGxhdGVudCBmb290Z3VuLCBzbyB3ZSB3YXJuIChuZXZlciBibG9jazogdGhlXG4vLyBtZXNzYWdlIGlzIGZpbmUgYXMgcmVjZWl2ZWQpLiBBYnNlbnQtbWV0YWNoYXIgaW5saW5lIGJvZGllcyBhcmUgZWl0aGVyIHBsYWluXG4vLyB0ZXh0IChzYWZlKSBvciBhbHJlYWR5LXN1YnN0aXR1dGVkICh1bmRldGVjdGFibGUpIOKAlCBzbyB3ZSBvbmx5IHdhcm4gb24gdGhlXG4vLyBkZXRlY3RhYmxlIHJpc2t5IHBhdHRlcm4uXG5jb25zdCBTSEVMTF9NRVRBQ0hBUl9SRSA9IC9gfFxcJFxcKHxcXCRcXHsvO1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzU2hlbGxSaXNreSh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFNIRUxMX01FVEFDSEFSX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS5cbi8vXG4vLyBncmFwZXZpbmUgYWxyZWFkeSBoYWQgSEFMRiBhIHJlZ2lzdHJ5OiBgQk9PTEVBTl9GTEFHU2AgYWJvdmUgdG9sZCB0aGUgcGFyc2VyXG4vLyB3aGljaCBmbGFncyB0YWtlIG5vIHZhbHVlLiBXaGF0IGl0IGhhZCBubyBub3Rpb24gb2Ygd2FzIHdoaWNoIGZsYWdzIEVYSVNULCBzb1xuLy8gYW4gdW5rbm93biBmbGFnIHdhcyBhY2NlcHRlZCBhdCBleGl0IDAgYW5kIHRoZSB2ZXJiIHJhbiBhbnl3YXksIGFuZCBmcmVlIHByb3NlXG4vLyBjb250YWluaW5nIGEgYC0td29yZGAgd2FzIHNpbGVudGx5IHRydW5jYXRlZCBhdCB0aGF0IHdvcmQuXG4vL1xuLy8g4pqgIGdyYXBldmluZSBpcyB0aGUgT1VUTElFUiBvZiB0aGUgc2l4LCBhbmQgaXQgaXMgd29ydGggc2F5aW5nIHdoeSBzbyBub2JvZHlcbi8vIHJlYWRzIGl0IGFzIG1lcmVseSBiZWhpbmQ6IGl0IHR5cGVzIGl0cyB2YWx1ZSBmbGFncyB3aXRoIGEgQ0FTVFxuLy8gKGBmbGFncy50b3BpYyBhcyBzdHJpbmcgfCB1bmRlZmluZWRgKSB3aGVyZSB0aGUgb3RoZXIgZW50cnkgcG9pbnRzIHVzZSBhXG4vLyBgdHlwZW9mYCBndWFyZC4gQSBjYXN0IGlzIGEgY2xhaW0gd2l0aCBOTyBSVU5USU1FIENIRUNLLCBzbyBncmFwZXZpbmUgY2FycmllZFxuLy8gYSBjbGFzcyBvZiBsYXRlbnQgdHlwZS1saWUgdGhlIG90aGVycyB3ZXJlIGd1YXJkZWQgYWdhaW5zdCDigJQgYW5kIGJhcmUgdmFsdWVcbi8vIGZsYWdzIHByb2R1Y2VkIHNpbGVudCB3cm9uZyB2YWx1ZXMgcmF0aGVyIHRoYW4gZXJyb3JzOlxuLy9cbi8vICAgLS1sYXN0ICAgYmFyZSAgLT4gIHBhcnNlSW50KHRydWUsIDEwKSAgLT4gIE5hTiwgc2lsZW50bHlcbi8vICAgLS10b3BpYyAgYmFyZSAgLT4gIGB0cnVlYCBpbiBhIGZpZWxkIERFQ0xBUkVEIGBzdHJpbmdgXG4vL1xuLy8gYHN0cmljdDogdHJ1ZWAgdHVybnMgZWFjaCBvZiB0aG9zZSBmcm9tIGEgc2lsZW50IHdyb25nIHZhbHVlIGludG8gYVxuLy8gY2FsbGVyLWZhY2luZyBlcnJvciwgd2hpY2ggaXMgdGhlIGxhbmUncyB3aG9sZSBwdXJwb3NlIGFuZCB0aGUgbGFyZ2VzdFxuLy8gYmVoYXZpb3VyIGRlbHRhIG9mIHRoZSBzaXggZW50cnkgcG9pbnRzLlxuLy9cbi8vIFRoZSBib29sZWFuIHNldCBiZWxvdyBpcyBCT09MRUFOX0ZMQUdTLCB1bmNoYW5nZWQg4oCUIGV4dHJhY3RlZCBmcm9tIHRoaXMgZmlsZVxuLy8gYW5kIGRpZmZlZCBhZ2FpbnN0IHRob3RoJ3MgaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0OiAxMyBmb3IgMTMsIGV4YWN0LFxuLy8gemVybyBkaXZlcmdlbmNlIGluIGVpdGhlciBkaXJlY3Rpb24uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hhbm5lbHM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaG9sZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiaW4tcmVwbHktdG9cIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBtYXg6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBub3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdG9waWM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBhbGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJkcnktcnVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZm9yY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZnJlc2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJmcm9tLXN0YXJ0XCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgaHVtYW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbGl0ZXJhbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsdXJrOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHF1aWV0OiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRleHQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdmVyYm9zZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB5ZXM6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbn0gYXMgY29uc3Q7XG5cbnR5cGUgRmxhZ05hbWUgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG5cbi8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgR0xPQkFMOiBTS0lMTC5tZCB0ZWxscyBhZ2VudHMgdG8gcGFzcyAtLWFzLy0tZnJvbVxuLy8gb24gRVZFUlkgdmVyYiAoYSBmcmVzaCBzaGVsbCBwZXIgY29tbWFuZCBtZWFucyBHUkFQRVZJTkVfRlJPTSBuZXZlclxuLy8gcGVyc2lzdHMpLCBzbyBldmVyeSBjb21tYW5kIGFjY2VwdHMgYm90aCDigJQgZXZlbiB3aGVyZSBhIHZlcmIgaGFzIG5vIHVzZSBmb3Jcbi8vIGlkZW50aXR5LCBhIGNhbGxlciBmb2xsb3dpbmcgb3VyIG93biBkb2NzIG11c3Qgbm90IGJlIHJlamVjdGVkIGZvciBvYmV5aW5nXG4vLyB0aGVtLiBPbiBgZ3JlcGAsIGAtLWZyb21gIGlzIGFuIGF1dGhvciBGSUxURVIgcmF0aGVyIHRoYW4gaWRlbnRpdHk6IGRpZmZlcmVudFxuLy8gc2VtYW50aWNzLCBzYW1lIGFjY2VwdGFuY2UuXG5jb25zdCBHTE9CQUxfRkxBR1M6IEZsYWdOYW1lW10gPSBbXCJhc1wiLCBcImZyb21cIl07XG5cbi8vIFRIRSBDT01NQU5EIFRBQkxFLCBBUyBBIFNUUlVDVFVSRSDigJQgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsIHRoZSBzY2hlbWFcbi8vIGVtaXR0ZXIgYW5kIHRoZSByb290IHJlamVjdGlvbiBhbGwgd2FsayBUSElTLiBJdCByZXBsYWNlZCBhIGJhcmUgYHN3aXRjaGAsXG4vLyB3aGljaCBvbmx5IHRoZSBkaXNwYXRjaGVyIGNvdWxkIHdhbGs6IGEgc2NoZW1hIGVtaXR0ZWQgZnJvbSBhbnl0aGluZyBvdGhlclxuLy8gdGhhbiB0aGUgc3RydWN0dXJlIHRoYXQgcm91dGVzIHRoZSBiZWhhdmlvdXIgaXMgYSBkb2N1bWVudCB0aGF0IGxpZXMgYXMgc29vblxuLy8gYXMgYW55b25lIGVkaXRzIHRoZSBvdGhlciBzaWRlIChhY2MgU1RBTkRBUkQubWQgUGFydCAxIMKnMjsgb3VyIG93biAjODEvRDRcbi8vIGxhbmUgbGVhcm5lZCB0aGUgc2FtZSBsZXNzb24gb25lIGFsdGl0dWRlIGRvd24gd2l0aCBCT09MRUFOX0ZMQUdTKS5cbi8vXG4vLyBgZmxhZ3NgIGlzIHRoZSB2ZXJiJ3MgT1dOIGFjY2VwdGVkIHNldCAoR0xPQkFMX0ZMQUdTIGFyZSBtZXJnZWQgaW4gYnkgdGhlXG4vLyBraXQgcmVnaXN0cnksIGBnbG9iYWxGbGFnc2ApLiBBIGZsYWcgbm90IGxpc3RlZCBoZXJlIGlzIFJFSkVDVEVEIGZvciB0aGlzIHZlcmIgd2l0aCB0aGVcbi8vIHZlcmIncyBvd24gc2V0IGVudW1lcmF0ZWQg4oCUIGFjY2VwdGVkLWFuZC1pZ25vcmVkIGlzIHRoZSBkaXNlYXNlIHRoaXMgdGFibGVcbi8vIGV4aXN0cyB0byBjdXJlIChhY2MgRFQtMTogYW50aGlsbCBhY2NlcHRpbmcgYSByb290IGAtLWZvcm1hdGAgaXQgc2lsZW50bHlcbi8vIGRpc2NhcmRzOyBncmFwZXZpbmUgYWNjZXB0aW5nIGBzZW5kIC0tZHJ5LXJ1bmAgYW5kIGRvaW5nIG5vdGhpbmcgd2FzIHRoZVxuLy8gc2FtZSBldmVudCB3aXRoIGEgZGlmZmVyZW50IHNwZWxsaW5nKS5cbi8qKlxuICogQSByb3cgYXMgZ3JhcGV2aW5lIHdyaXRlcyBpdDogdGhlIGtpdCdzIGBDb21tYW5kU3BlY2Agd2l0aCB0aGUgaGFuZGxlciB0YWtpbmdcbiAqIGAocG9zaXRpb25hbCwgZmxhZ3MpYCwgYWRhcHRlZCB0byB0aGUga2l0J3MgYHJ1bihpbnYpYCBieSBgb25gIGJlbG93LiBOb1xuICogYGRlc2NyaWJlYDogZ3JhcGV2aW5lJ3MgaGVscCBpcyBoYW5kLXdyaXR0ZW4gKGBoZWxwVGV4dGApLCBzbyB0aGUgcmVuZGVyZWRcbiAqIGhlbHAgdGhhdCByZWFkcyBpdCBpcyBuZXZlciBzaG93bi5cbiAqXG4gKiDimqAgVEhFIEhBTkRMRVIgTUFZIFJFVFVSTiBBTiBFWElUIENPREUsIEFORCBFWEFDVExZIE9ORSBWRVJCIERPRVMuIGB0YWlsYCBydW5zXG4gKiB0aGUgc2hhcmVkIGNsaWVudCAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoaWNoIFJFVFVSTlMgYSBjb2RlIHJhdGhlclxuICogdGhhbiBlbmRpbmcgdGhlIHByb2Nlc3MgZnJvbSBpbnNpZGUgdGhyZWUgbmVzdGVkIGxvb3BzIOKAlCBzbyB0aGUgY29kZSBoYXMgdG9cbiAqIHJlYWNoIGBtYWluYCwgYW5kIHRoaXMgaXMgdGhlIHNlYW0gaXQgY3Jvc3Nlcy4gQW55dGhpbmcgdGhhdCBpcyBub3QgYSBudW1iZXJcbiAqIG1lYW5zIDAsIHdoaWNoIGlzIHdoYXQgdGhlIG90aGVyIHR3ZW50eS1vZGQgdmVyYnMgcmV0dXJuLiBUeXBlZCBgdW5rbm93bmBcbiAqIHJhdGhlciB0aGFuIGEgdW5pb24gd2l0aCBgdm9pZGA6IGV2ZXJ5IGBhc3luY2AgdmVyYiB0aGF0IGVuZHMgd2l0aG91dCBhXG4gKiBgcmV0dXJuYCBpcyBgUHJvbWlzZTx2b2lkPmAuXG4gKi9cbnR5cGUgUm93ID0gT21pdDxDb21tYW5kU3BlYzxGbGFnTmFtZT4sIFwicnVuXCIgfCBcImRlc2NyaWJlXCIgfCBcInJlamVjdEhpbnRcIj4gJiB7XG4gIHJ1bjogKHBvc2l0aW9uYWw6IHN0cmluZ1tdLCBmbGFnczogRmxhZ3MpID0+IHVua25vd247XG59O1xuXG4vKiogYHRhaWwgLS1zaW5jZWAgdGhyb3VnaCB0aGUga2l0J3Mgb25lIHJlYWRlciAoYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCxcbiAqICBgcmVhZFNpbmNlYCk6IGFuIGlkIG9mIDAgb3IgbW9yZTsgYW4gZXBvY2ggYm9va21hcmsgcHJpbnRlZCBieSBhbm90aGVyXG4gKiAgc3BlbGwncyBoYW5kb2ZmIGxpbmUgaXMgcmVmdXNlZCB3aXRoIHRoZSBhY2NlcHRlZCBmb3JtcyBuYW1lZC4gKi9cbmZ1bmN0aW9uIHNpbmNlT3JEaWUodG9rZW46IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHIgPSByZWFkU2luY2UodG9rZW4sIHsgZXBvY2g6IGZhbHNlLCBtaW46IDAgfSk7XG4gIC8vIFRoZSBgdGFpbDpgIHByZWZpeCBldmVyeSBvdGhlciBncmFwZXZpbmUgZmxhZyByZWZ1c2FsIGNhcnJpZXMuXG4gIGlmICghci5vaykgZGllKGB0YWlsOiAke3IubWVzc2FnZX1gLCBcInVzYWdlXCIpO1xuICByZXR1cm4gci5zaW5jZTtcbn1cblxuLy8gQSBkZWNsYXJlZCB2YWx1ZSBmbGFnIHRoYXQgY2FycmllcyBhIG51bWJlciBtdXN0IFJFSkVDVCBhIG5vbi1udW1iZXIgYXMgYVxuLy8gdXNhZ2UgZXJyb3IgKGV4aXQgMiksIG5vdCBjcmFzaCBvbiBpdCBkb3duc3RyZWFtIOKAlCBgc2NoZW1hYCBwdWJsaXNoZXMgdGhlXG4vLyBmbGFnIGFzIHZhbGlkLCBzbyB0aGUgcGFyc2UgYm91bmRhcnkgaXMgd2hlcmUgYSBiYWQgdmFsdWUgZ2V0cyBpdHNcbi8vIGNhbGxlci1mYWNpbmcgYW5zd2VyLiAoYHdhaXQgLS10aW1lb3V0IG5vdGFudW1iZXJgIHVzZWQgdG8gdGhyb3cgYW5cbi8vIHVuaGFuZGxlZCBSYW5nZUVycm9yIGF0IGV4aXQgMSwgc3RhY2sgdHJhY2UgYW5kIGFsbC4pXG5mdW5jdGlvbiBudW1lcmljRmxhZyh2ZXJiOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmF3OiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8IDApXG4gICAgZGllKGAke3ZlcmJ9OiAtLSR7bmFtZX0gZXhwZWN0cyBhIG5vbi1uZWdhdGl2ZSBudW1iZXIsIGdvdCAke0pTT04uc3RyaW5naWZ5KFN0cmluZyhyYXcpKX1gKTtcbiAgcmV0dXJuIG47XG59XG5cbi8vIEJvZHkgcmVzb2x1dGlvbiBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZSDigJQgZmlyc3QgbWF0Y2ggd2luczogLS1ib2R5LWZpbGUsXG4vLyAtLXN0ZGluLCBpbmxpbmUgcG9zaXRpb25hbHMsIGRlZmF1bHQtc3RkaW4gd2hlbiBwaXBlZC4gU2VlIHRoZSBwZXItdmVyYlxuLy8gY29tbWVudHMgYXQgdGhlIG9yaWdpbmFsIHNpdGVzIChWMS42LyM2MCk7IGJlaGF2aW91ciB1bmNoYW5nZWQuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQm9keShcbiAgdmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsXG4gIGlubGluZTogc3RyaW5nW10sXG4gIGZsYWdzOiBGbGFncyxcbik6IFByb21pc2U8eyB0ZXh0OiBzdHJpbmc7IGZyb21JbmxpbmU6IGJvb2xlYW4gfT4ge1xuICBpZiAoZmxhZ3NbXCJib2R5LWZpbGVcIl0pIHtcbiAgICBjb25zdCBwYXRoID0gZmxhZ3NbXCJib2R5LWZpbGVcIl0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICByZXR1cm4geyB0ZXh0OiAoYXdhaXQgZmlsZS50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSwgZnJvbUlubGluZTogZmFsc2UgfTtcbiAgfVxuICBpZiAoZmxhZ3Muc3RkaW4gfHwgKGlubGluZS5sZW5ndGggPT09IDAgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpKSB7XG4gICAgY29uc3QgYnVmOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcHJvY2Vzcy5zdGRpbikgYnVmLnB1c2goY2h1bmsgYXMgQnVmZmVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGV4dDogQnVmZmVyLmNvbmNhdChidWYpLnRvU3RyaW5nKFwidXRmLThcIikucmVwbGFjZSgvXFxuJC8sIFwiXCIpLFxuICAgICAgZnJvbUlubGluZTogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyB0ZXh0OiBpbmxpbmUuam9pbihcIiBcIiksIGZyb21JbmxpbmU6IHRydWUgfTtcbn1cblxuLy8gVGhlIHR3byBib2R5IGd1YXJkcyBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZTogcmVmdXNlIGEgbGVha2VkIGludm9jYXRpb25cbi8vIChmdW1ibGVkIGhlcmVkb2MpIHVubGVzcyAtLWZvcmNlLCBhbmQgd2FybiBvbiBzaGVsbCBtZXRhY2hhcmFjdGVycyB0aGF0XG4vLyBzdXJ2aXZlZCBhbiBpbmxpbmUgYm9keSAoIzYwIOKAlCB3YXJuLCBuZXZlciBibG9jaykuXG5mdW5jdGlvbiBndWFyZEJvZHkodmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsIHRleHQ6IHN0cmluZywgZnJvbUlubGluZTogYm9vbGVhbiwgZm9yY2U6IGJvb2xlYW4pIHtcbiAgaWYgKCFmb3JjZSAmJiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQpKSB7XG4gICAgZGllKFxuICAgICAgYCR7dmVyYn06IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGdyYXBldmluZSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgYCArXG4gICAgICAgIFwiaGVyZWRvYz8pLiBOb3RoaW5nIHdhcyBzZW50LiBQaXBlIHRoZSByZWFsIGJvZHkgdmlhIC0tc3RkaW4gb3IgXCIgK1xuICAgICAgICBcIi0tYm9keS1maWxlIDxwYXRoPiwgb3IgcGFzcyAtLWZvcmNlIHRvIHNlbmQgaXQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZyb21JbmxpbmUgJiYgbG9va3NTaGVsbFJpc2t5KHRleHQpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBcIiMg4pqgIGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgYmVmb3JlIFwiICtcbiAgICAgICAgXCJncmFwZXZpbmUgc2VlcyB0aGVtIOKAlCB1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiDim5QgUkVHSVNURVIgQTEg4oCUIGBjaG9pY2VzYCBJUyBgR0xPQkFMX0ZMQUdTYCwgVEhFIFNFVCBgcmVzb2x2ZUFsaWFzYCBSRUFEUy5cbiAqIFRoaXMgaXMgYSBESVNKVU5DVElPTiAoZWl0aGVyIGZsYWcgc2F0aXNmaWVzIGl0KSwgc28gdGhlIGNhbGxlciBoYXMgdG8gcGljayxcbiAqIGFuZCBpdCBpcyB0aGUgb25lIGlkZW50aXR5IHJlZnVzYWwgZm91ciB2ZXJicyBzaGFyZS4gVGhlIGVudiB2YXIgc3RheXMgaW5cbiAqIGBoaW50YCBhbmQgZGVsaWJlcmF0ZWx5IE5PVCBpbiBgY2hvaWNlc2A6IGBjaG9pY2VzYCBlbnVtZXJhdGVzIENPTU1BTkRcbiAqIFRPS0VOUyDigJQgd2hhdCB3b3VsZCBoYXZlIGJlZW4gYWNjZXB0ZWQgSU4gVEhFIElOVk9DQVRJT04g4oCUIGFuZCBwdXR0aW5nIGFuXG4gKiBlbnZpcm9ubWVudCBuYW1lIGluIHRoZSBzYW1lIGFycmF5IHdvdWxkIGdpdmUgYSBjYWxsZXIgYSBcImNob2ljZVwiIGl0IGNhbm5vdFxuICogcGFzcyBvbiB0aGUgY29tbWFuZCBsaW5lLlxuICovXG5jb25zdCBpZGVudGl0eVJlcXVpcmVkID0gKHZlcmI6IHN0cmluZyk6IG5ldmVyID0+XG4gIGRpZShgJHt2ZXJifTogaWRlbnRpdHkgcmVxdWlyZWRgLCBcInVzYWdlXCIsIHtcbiAgICBoaW50OiBgcGFzcyAke0dMT0JBTF9GTEFHUy5tYXAoKGYpID0+IGAtLSR7Zn1gKS5qb2luKFwiL1wiKX0gPGFsaWFzPiwgb3Igc2V0IEdSQVBFVklORV9GUk9NYCxcbiAgICBjaG9pY2VzOiBHTE9CQUxfRkxBR1MubWFwKChmKSA9PiBgLS0ke2Z9YCksXG4gIH0pO1xuXG4vLyDimqAgRVZFUlkgQ09NTUFORCBGVU5DVElPTiBCRUxPVyBSRUZVU0VTIEEgTUlTU0lORyBQT1NJVElPTkFMIE9OIElUUyBPV04gRklSU1Rcbi8vIExJTkUgKGEgdXNhZ2UgcmVmdXNhbCB3aGVuIHRoZSBuYW1lIGlzIGZhbHN5KSwgYW5kIGVhY2ggbm93IGRlY2xhcmVzIHRoYXQgcGFyYW1ldGVyXG4vLyBgc3RyaW5nIHwgdW5kZWZpbmVkYCBzbyBpdHMgc2lnbmF0dXJlIHNheXMgd2hhdCB0aGF0IGxpbmUgZG9lcyAodHlwZS1kZWJ0XG4vLyBUMzUpLiBBcml0eSBkaXNwYXRjaCByZWZ1c2VzIGEgbWlzc2luZyByZXF1aXJlZCBwb3NpdGlvbmFsIGJlZm9yZSBhbnkgb2Zcbi8vIHRoZW0gcnVucywgc28gdGhlIGd1YXJkcyBhcmUgdGhlIHNlY29uZCBsaW5lIG9mIGRlZmVuY2UsIG5vdCB0aGUgZmlyc3QuXG5jb25zdCBST1dTOiBSb3dbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJ0b3BpY1wiLCBcImZyZXNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE9wZW4ocG9zaXRpb25hbFswXSwge1xuICAgICAgICB0b3BpYzogZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgICBmcm9tOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBmcmVzaDogZmxhZ3MuZnJlc2ggPT09IHRydWUsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0b3BpY1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUb3BpYyhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcG9zaXRpb25hbC5sZW5ndGggPiAxID8gcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGlzdFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRMaXN0KCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwidmVyYm9zZVwiLCBcImZvcmNlXCIsIFwiaW4tcmVwbHktdG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgbmFtZSA9IHBvc2l0aW9uYWxbMF07XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJzZW5kXCIsIHBvc2l0aW9uYWwuc2xpY2UoMSksIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcInNlbmRcIik7XG4gICAgICBndWFyZEJvZHkoXCJzZW5kXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgYXdhaXQgY21kU2VuZChuYW1lLCBmcm9tIGFzIHN0cmluZywgdGV4dCwge1xuICAgICAgICBxdWlldDogISFmbGFncy5xdWlldCxcbiAgICAgICAgdmVyYm9zZTogISFmbGFncy52ZXJib3NlLFxuICAgICAgICBpblJlcGx5VG86IGZsYWdzW1wiaW4tcmVwbHktdG9cIl1cbiAgICAgICAgICA/IG51bWVyaWNGbGFnKFwic2VuZFwiLCBcImluLXJlcGx5LXRvXCIsIGZsYWdzW1wiaW4tcmVwbHktdG9cIl0sIDApXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbm5vdW5jZVwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwiZm9yY2VcIiwgXCJjaGFubmVsc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSByZXNvbHZlQWxpYXMoZmxhZ3MpO1xuICAgICAgY29uc3QgeyB0ZXh0LCBmcm9tSW5saW5lIH0gPSBhd2FpdCByZXNvbHZlQm9keShcImFubm91bmNlXCIsIHBvc2l0aW9uYWwsIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcImFubm91bmNlXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwiYW5ub3VuY2VcIiwgdGV4dCwgZnJvbUlubGluZSwgISFmbGFncy5mb3JjZSk7XG4gICAgICBjb25zdCBjaGFubmVscyA9IGZsYWdzLmNoYW5uZWxzXG4gICAgICAgID8gKGZsYWdzLmNoYW5uZWxzIGFzIHN0cmluZylcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKGMpID0+IGMudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGF3YWl0IGNtZEFubm91bmNlKGZyb20gYXMgc3RyaW5nLCB0ZXh0LCBjaGFubmVscywgeyBxdWlldDogISFmbGFncy5xdWlldCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwdWxsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwic3RhdHVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJwdWxsXCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgYXdhaXQgY21kUHVsbChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgeyBzdGF0dXM6IGZsYWdzLnN0YXR1cyBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidHJpYWdlXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRyaWFnZShwb3NpdGlvbmFsWzBdLCB7IGh1bWFuOiAhIWZsYWdzLmh1bWFuIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYWRcIixcbiAgICBmbGFnczogW1widGV4dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zaXRpb25hbFsxXSA/IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSA6IE5hTjtcbiAgICAgIGF3YWl0IGNtZFJlYWQocG9zaXRpb25hbFswXSwgaWQsIHsgdGV4dDogISFmbGFncy50ZXh0IH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhaXRcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJ0aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJ3YWl0XCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgY29uc3QgdGltZW91dCA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCwgMzApO1xuICAgICAgYXdhaXQgY21kV2FpdChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgdGltZW91dCwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2hvXCIsXG4gICAgZmxhZ3M6IFtcImFsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgaWYgKGZsYWdzLmFsbCkgYXdhaXQgY21kV2hvQWxsKCk7XG4gICAgICBlbHNlIGF3YWl0IGNtZFdobyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbGlhc1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBbGlhcyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwiZnJvbS1zdGFydFwiLCBcImxhc3RcIiwgXCJodW1hblwiLCBcImx1cmtcIiwgXCJtYXhcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgcmV0dXJuIGF3YWl0IGNtZFRhaWwocG9zaXRpb25hbFswXSwge1xuICAgICAgICBzaW5jZTogZmxhZ3Muc2luY2UgIT09IHVuZGVmaW5lZCA/IHNpbmNlT3JEaWUoU3RyaW5nKGZsYWdzLnNpbmNlKSkgOiB1bmRlZmluZWQsXG4gICAgICAgIGZyb21TdGFydDogISFmbGFnc1tcImZyb20tc3RhcnRcIl0sXG4gICAgICAgIGxhc3Q6IGZsYWdzLmxhc3QgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcImxhc3RcIiwgZmxhZ3MubGFzdCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGFzOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBodW1hbjogISFmbGFncy5odW1hbixcbiAgICAgICAgbHVyazogISFmbGFncy5sdXJrLFxuICAgICAgICBtYXg6IHJlc29sdmVUYWlsTWF4KGZsYWdzLm1heCksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmVwXCIsXG4gICAgZmxhZ3M6IFtcImxpdGVyYWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwicGF0dGVyblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRHcmVwKHBvc2l0aW9uYWxbMF0sIHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIiksIHtcbiAgICAgICAgbGl0ZXJhbDogISFmbGFncy5saXRlcmFsLFxuICAgICAgICBmcm9tOiBmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQ2xvc2UocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzZXRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzZXQocG9zaXRpb25hbFswXSwgeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFya1wiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiZGlzcG9zaXRpb25cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgLy8gTmFOIGZvciBhIG1pc3NpbmcgaWQsIGV4YWN0bHkgd2hhdCBgcGFyc2VJbnQodW5kZWZpbmVkKWAgZ2F2ZSDigJQgYW5kXG4gICAgICAgIC8vIGBjbWRNYXJrYCByZWZ1c2VzIGEgbm9uLWZpbml0ZSBpZCBvbiBpdHMgZmlyc3QgbGluZS5cbiAgICAgICAgcG9zaXRpb25hbFsxXSA9PT0gdW5kZWZpbmVkID8gTnVtYmVyLk5hTiA6IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSxcbiAgICAgICAgcG9zaXRpb25hbC5zbGljZSgyKS5qb2luKFwiIFwiKSxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwibWFya1wiKSxcbiAgICAgICAgeyBub3RlOiBmbGFncy5ub3RlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9LFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZW9wZW5cIixcbiAgICBmbGFnczogW1wibm90ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE1hcmsoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIC8vIE5hTiBmb3IgYSBtaXNzaW5nIGlkLCBleGFjdGx5IHdoYXQgYHBhcnNlSW50KHVuZGVmaW5lZClgIGdhdmUg4oCUIGFuZFxuICAgICAgICAvLyBgY21kTWFya2AgcmVmdXNlcyBhIG5vbi1maW5pdGUgaWQgb24gaXRzIGZpcnN0IGxpbmUuXG4gICAgICAgIHBvc2l0aW9uYWxbMV0gPT09IHVuZGVmaW5lZCA/IE51bWJlci5OYU4gOiBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIFwib3BlblwiLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJyZW9wZW5cIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBcmNoaXZlKHBvc2l0aW9uYWxbMF0sIGZhbHNlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCB0cnVlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGFydFwiLFxuICAgIGFsaWFzZXM6IFtcInVwXCJdLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdGFydCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlc3RhcnRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzdGFydCh7IGZvcmNlOiAhIWZsYWdzLmZvcmNlIHx8ICEhZmxhZ3MueWVzIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJvbGxcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUm9sbCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB8fCBmbGFncy55ZXMgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RvcFwiLFxuICAgIGZsYWdzOiBbXCJob2xkXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFN0b3Aoe1xuICAgICAgICBob2xkU2Vjb25kczpcbiAgICAgICAgICBmbGFncy5ob2xkICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInN0b3BcIiwgXCJob2xkXCIsIGZsYWdzLmhvbGQsIDApIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2F0Y2hcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kV2F0Y2gocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhcFwiLFxuICAgIGFsaWFzZXM6IFtcInBydW5lXCJdLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcImRyeS1ydW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVhcCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSwgZHJ5UnVuOiBmbGFnc1tcImRyeS1ydW5cIl0gPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRJbmZvKCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9jdG9yXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZERvY3RvcigpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICBmbGFnczogW1wiaHVtYW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgLy8gVGhlIENMSSBjYW4gYmUgQVNLRUQgd2hhdCBpdCBpcy4gZ3JhcGV2aW5lIGFscmVhZHkgY2Fycmllc1xuICAgICAgLy8gUExVR0lOX1ZFUlNJT04gdG8gd2FybiB0aGF0IGEgZGFlbW9uIGlzIGZyb20gYSBkaWZmZXJlbnQgY2FjaGVkIHBsdWdpblxuICAgICAgLy8gcGF0aCB0aGFuIHRoaXMgQ0xJIChtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaCkg4oCUIGJ1dCBhIGNhbGxlciB0aGF0IGhpdFxuICAgICAgLy8gdGhhdCB3YXJuaW5nLCBvciB0aGF0IHJ1bnMgYHJvbGxgIGZvciBpdHMgdmVyc2lvbiB2ZXJpZnksIGhhZCBubyB3YXkgdG9cbiAgICAgIC8vIGFzayB0aGlzIHNpZGUgd2hhdCBpdCBpcyBob2xkaW5nLiBUaGUgdmFsdWUgd2FzIGFscmVhZHkgaW4gbWVtb3J5OyBvbmx5XG4gICAgICAvLyB0aGUgcXVlc3Rpb24gd2FzIG1pc3NpbmcuXG4gICAgICAvLyBKU09OIGJ5IGRlZmF1bHQsIG1hdGNoaW5nIGV2ZXJ5IGRhdGEgY29tbWFuZDsgLS1odW1hbiBmb3IgcHJvc2UuXG4gICAgICBpZiAoUExVR0lOX1ZFUlNJT04gPT09IG51bGwpXG4gICAgICAgIGRpZShcInZlcnNpb24gdW5hdmFpbGFibGUg4oCUIGNvdWxkIG5vdCByZWFkIHBsdWdpbi5qc29uXCIsIFwiaW50ZXJuYWxcIik7XG4gICAgICBpZiAoZmxhZ3MuaHVtYW4gPT09IHRydWUpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBncmFwZXZpbmUgdiR7UExVR0lOX1ZFUlNJT059XFxuYCk7XG4gICAgICBlbHNlIHByaW50SnNvbih7IG5hbWU6IFwiZ3JhcGV2aW5lXCIsIHZlcnNpb246IFBMVUdJTl9WRVJTSU9OIH0pO1xuICAgIH0sXG4gIH0sXG5dO1xuXG4vKiogVGhlIHJlamVjdGlvbiBoaW50IGBzZW5kYCBhbmQgYGFubm91bmNlYCBhZGQgdG8gZXZlcnkgZmxhZyByZWZ1c2FsOiBhXG4gKiAgbWVzc2FnZSBib2R5IGlzIHByb3NlLCBhbmQgcHJvc2Ugd2l0aCBhIGRhc2ggaW4gaXQgaGFzIHRocmVlIHNhZmUgcm91dGVzLiAqL1xuY29uc3QgQk9EWV9ISU5UID1cbiAgXCJmb3IgYSBtZXNzYWdlIGJvZHkgY29udGFpbmluZyBkYXNoZXMsIHVzZSAtLXN0ZGluIG9yIC0tYm9keS1maWxlLCBvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCI7XG5cbi8qKiBncmFwZXZpbmUgZGVjbGFyZXMgbm8gYG11bHRpcGxlYCBmbGFnLCBzbyBldmVyeSB2YWx1ZSBpcyBhIHN0cmluZyBvciBhXG4gKiAgYm9vbGVhbiDigJQgdGhlIGBGbGFnc2AgdGhlIGhhbmRsZXJzIHRha2UuICovXG5jb25zdCBvbiA9XG4gIChoOiBSb3dbXCJydW5cIl0pID0+XG4gIChpbnY6IEludm9jYXRpb248RmxhZ05hbWU+KTogdW5rbm93biA9PlxuICAgIGgoaW52LnBvcywgaW52LmZsYWdzIGFzIEZsYWdzKTtcblxuLy8gVEhFIFJFR0lTVFJZIOKAlCB0aGUgaG91c2UncyBvbmUgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2ApLiBncmFwZXZpbmUncyBvd25cbi8vIGRpc3BhdGNoZXIsIHBlci12ZXJiIHBhcnNlciwgcm9vdCByb3V0ZXIgYW5kIGRlY2xhcmF0aW9uIGVtaXR0ZXIgd2VyZSB0aGVcbi8vIHZlcmItZmlyc3QgaGFsZiBvZiB3aGF0IHRoYXQgbW9kdWxlIHdhcyBnZW5lcmFsaXNlZCBmcm9tLCBhbmQgd2VyZSBkZWxldGVkXG4vLyB3aGVuIGdyYXBldmluZSBtb3ZlZCBvbnRvIGl0LiBXaGF0IHRoZSBtb2R1bGUgbm93IGRvZXMgaGVyZSwgYW5kIGdyYXBldmluZVxuLy8gdXNlZCB0byBkbyBpdHNlbGY6XG4vL1xuLy8gICAtIFRoZSB2ZXJiIGlzIGBhcmd2WzBdYC4gQSBkYXNoLWxlZCBgYXJndlswXWAgdGhhdCBpcyBub3QgYW4gaW50ZXJjZXB0b3IgaXNcbi8vICAgICBhbiB1bmtub3duIFJPT1QgZmxhZywgcmVqZWN0ZWQgd2l0aCB0aGUgaW50ZXJjZXB0b3JzIChsb25nIGZpcnN0KSBhc1xuLy8gICAgIGBjaG9pY2VzYCBhbmQgdGhlIGNvbW1hbmRzIGluIHRoZSBoaW50LCBzbyBgZ3JhcGV2aW5lIC0tYXMgeCBsaXN0YCBpc1xuLy8gICAgIHJlZnVzZWQgcmF0aGVyIHRoYW4gcGFyc2VkLlxuLy8gICAtIGAtLWhlbHBgL2AtaGAvYC0tdmVyc2lvbmAvYC1WYCBhcyBgYXJndlswXWAgcnVuIHRoZSBgaGVscGAgb3IgYHZlcnNpb25gXG4vLyAgICAgcm93IGFuZCBQQVNTIFRIRSBSRVNUIE9OOiBgZ3JhcGV2aW5lIC0tdmVyc2lvbiAtLWh1bWFuYCBhbmRcbi8vICAgICBgLVYgLS1hcyBtZWAga2VlcCB3b3JraW5nLCBiZWNhdXNlIGB2ZXJzaW9uYCBhY2NlcHRzIHRoZW0uXG4vLyAgIC0gQSBiYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciBuYW1pbmcgZXZlcnkgY29tbWFuZCBhbmQgYWxpYXNcbi8vICAgICAoYWNjIEQyKSwgbmV2ZXIgaGVscCBhdCBleGl0IDA6IGdyYXBldmluZSdzIGNhbGxlcnMgYXJlIGFnZW50cywgYW5kIGFcbi8vICAgICBiYXJlIGNhbGwgaXMgYW4gdW5zZXQgc2hlbGwgdmFyaWFibGUgZXhwYW5kaW5nIHRvIG5vdGhpbmcuXG4vLyAgIC0gQSBmbGFnIGFub3RoZXIgdmVyYiB0YWtlcyBpcyBNSVNQTEFDRUQgKGAtLXggaXMgbm90IGFjY2VwdGVkIGJ5XG4vLyAgICAgXFxgc2VuZFxcYGApLCBhbiB1bmtub3duIG9uZSBVTktOT1dOOyBib3RoIGNhcnJ5IHRoaXMgdmVyYidzIGFjY2VwdGVkIHNldFxuLy8gICAgIChpdHMgb3duIGZsYWdzIHBsdXMgYC0tYXNgL2AtLWZyb21gKSBhcyBgY2hvaWNlc2AuXG4vLyAgIC0gQXJpdHkgaXMgZW5mb3JjZWQgZnJvbSBlYWNoIHJvdydzIHBvc2l0aW9uYWxzLCBuYW1pbmcgdGhlIG1pc3Npbmdcbi8vICAgICBgPHBvc2l0aW9uYWw+YCBvciB0aGUgZXh0cmEgdG9rZW4gKGFjYyBBNCkuXG4vLyAgIC0gYHNjaGVtYWAgYW5kIGBoZWxwYCBhcmUgdGhlIG1vZHVsZSdzIHJvd3M7IGB2ZXJzaW9uYCBpcyBncmFwZXZpbmUncyBvd24sXG4vLyAgICAgZm9yIGAtLWh1bWFuYC5cbi8vXG4vLyDim5QgQlVJTERJTkcgVEhFIFRBQkxFIEhBUyBOTyBTSURFIEVGRkVDVFM6IGBkZWZpbmVDbGlgIG9ubHkgdmFsaWRhdGVzIGFuZFxuLy8gaW5kZXhlcywgc28gYSB3YXJkIG9yIGEgdGVzdCBjYW4gaW1wb3J0IGl0IGFuZCByZWFkIHRoZSB0YWJsZS5cbmV4cG9ydCBjb25zdCBjbGkgPSBkZWZpbmVDbGkoe1xuICBuYW1lOiBcImdyYXBldmluZVwiLFxuICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgY29tbWFuZHM6IFJPV1MubWFwKChyKSA9PiAoe1xuICAgIC4uLnIsXG4gICAgZGVzY3JpYmU6IFwiXCIsXG4gICAgcnVuOiBvbihyLnJ1biksXG4gICAgLi4uKHIubmFtZSA9PT0gXCJzZW5kXCIgfHwgci5uYW1lID09PSBcImFubm91bmNlXCIgPyB7IHJlamVjdEhpbnQ6IEJPRFlfSElOVCB9IDoge30pLFxuICB9KSksXG4gIC8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgZ2xvYmFsIOKAlCBzZWUgR0xPQkFMX0ZMQUdTLlxuICBnbG9iYWxGbGFnczogR0xPQkFMX0ZMQUdTLFxuICAvLyBPbmx5IHRoZSBhdXRvIGB2ZXJzaW9uYCByb3cgcmVhZHMgdGhpcywgYW5kIGdyYXBldmluZSBkZWZpbmVzIGl0cyBvd24gcm93LlxuICB2ZXJzaW9uOiAoKSA9PiAoeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiA/PyBcInVua25vd25cIiB9KSxcbiAgaGVscDogaGVscFRleHQsXG59KTtcblxuZnVuY3Rpb24gaGVscFRleHQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBncmFwZXZpbmUg4oCUIGFnZW50LXRvLWFnZW50IHdhbGtpZS10YWxraWVcblxuVXNhZ2U6XG4gIGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXSAgIG9wZW4vY3JlYXRlIChhdXRvLXVuYXJjaGl2ZXM7IC0tZnJlc2ggY2xlYXJzIGEgZG9ybWFudCBjaGFubmVsKVxuICBncmFwZXZpbmUgbGlzdFxuICBncmFwZXZpbmUgc2VuZCA8bmFtZT4gWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLXF1aWV0XSBbLS12ZXJib3NlXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tZm9yY2VdIFstLWluLXJlcGx5LXRvIDxpZD5dIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJvZHk6IGlubGluZSB0ZXh0LCAtLXN0ZGluLCAtLWJvZHktZmlsZSwgb3IgcGlwZWQgc3RkaW4gKGRlZmF1bHQgd2hlbiBubyBpbmxpbmUgdGV4dClcbiAgZ3JhcGV2aW5lIGFubm91bmNlIFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1jaGFubmVscyBhLGIsY10gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLXF1aWV0XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBicm9hZGNhc3Qgb25lIG1lc3NhZ2UgdG8gZXZlcnkgYWN0aXZlIGNoYW5uZWwgKG9yIC0tY2hhbm5lbHMpXG4gIGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcy8tLWZyb20gPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyAke1dJTkRPV19IRUxQfSAoLS1odW1hbiBuZXZlciBlbmRzIGJ5IGl0c2VsZilcbiAgICAgICAjIC0tbGFzdCA8bj46IGJhY2tmaWxsIHRoZSBtb3N0IHJlY2VudCBuIG1lc3NhZ2VzIHRoZW4gZ28gbGl2ZSAoYm91bmRlZCBjYXRjaC11cCBmb3IgYSBjb2xkIGpvaW5lcilcbiAgZ3JhcGV2aW5lIHB1bGwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XSAgICMgLS1zdGF0dXMgPSBmdWxsLXNjYW4gZmlsdGVyIChvcGVufHdvbnRmaXh8aW5jb3Jwb3JhdGVkfOKApilcbiAgZ3JhcGV2aW5lIHRyaWFnZSA8bmFtZT4gICAgICAgICAgICAgIyBmdWxsLXNjYW46IG9wZW4gbWVzc2FnZXMgb24gdG9wICsgZ3JvdXBlZCBieV9zdGF0dXNcbiAgZ3JhcGV2aW5lIG1hcmsgPG5hbWU+IDxpZD4gPGRpc3Bvc2l0aW9uPiBbLS1ub3RlIDx0ZXh0Pl0gICMgc2V0IGRpc3Bvc2l0aW9uIChpbmNvcnBvcmF0ZWR8d29udGZpeHxkZWZlcnJlZHzigKYpXG4gIGdyYXBldmluZSByZW9wZW4gPG5hbWU+IDxpZD4gICAgICAgICMgYm91bmNlIGEgbWVzc2FnZSBiYWNrIHRvIG9wZW5cbiAgZ3JhcGV2aW5lIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF0gICAjIG9uZSBmdWxsIG1lc3NhZ2UgYnkgaWQgKC0tdGV4dCA9IHByb3NlKVxuICBncmFwZXZpbmUgd2FpdCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXG4gIGdyYXBldmluZSBncmVwIDxuYW1lPiA8cGF0dGVybj4gWy0tbGl0ZXJhbF0gWy0tZnJvbSA8YWxpYXM+XVxuICBncmFwZXZpbmUgdG9waWMgPG5hbWU+IFs8dGV4dD5dICAgIyBubyB0ZXh0IOKGkiByZWFkIGN1cnJlbnQ7IHdpdGggdGV4dCDihpIgdXBkYXRlXG4gIGdyYXBldmluZSB3aG8gPG5hbWU+ICAgICAgICAgICAgICAjIHJvc3RlcjsgdGhlIGh1bWFucyBmaWVsZCBsaXN0cyBodW1hbnNcbiAgZ3JhcGV2aW5lIGFsaWFzIFs8bmFtZT5dICAgICAgICAgICMgc2V0L3Nob3cgeW91ciBwZXJzaXN0ZWQgYWxpYXMgKGNvbmZpZy5qc29uKVxuICBncmFwZXZpbmUgd2F0Y2ggWzxuYW1lPl0gICAgICAgICAgIyBvcGVuIGJyb3dzZXIgdGFiOyBsaXZlIGNoYXQtYnViYmxlIHZpZXdcbiAgZ3JhcGV2aW5lIHJlc2V0IDxuYW1lPiBbLS1mb3JjZV0gICAgICAgICAgIHNuYXBzaG90IHRoZSBsb2cg4oaSIH4vLmdyYXBldmluZS9hcmNoaXZlLCB0aGVuIGNsZWFyIGl0XG4gIGdyYXBldmluZSBhcmNoaXZlIDxuYW1lPiAgICAgICAgICAjIHJlYWQtb25seToga2VlcCBoaXN0b3J5LCByZWplY3Qgc2VuZHNcbiAgZ3JhcGV2aW5lIHVuYXJjaGl2ZSA8bmFtZT4gICAgICAgICMgYnJpbmcgYW4gYXJjaGl2ZWQgY2hhbm5lbCBiYWNrXG4gIGdyYXBldmluZSBjbG9zZSA8bmFtZT4gICAgICAgICAgICAjIGRlc3RydWN0aXZlOiBkZWxldGUgdGhlIG1lc3NhZ2UgbG9nXG4gIGdyYXBldmluZSBzdGFydCAgICAgICAgICAgICAgICAgICAjIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHJ1bm5pbmcgKGFsaWFzOiB1cCk7IG5vIGNoYW5uZWxcbiAgZ3JhcGV2aW5lIHJlc3RhcnQgWy0tZm9yY2V8LS15ZXNdICMgc3RvcCArIHJlc3Bhd24gZnJlc2g7IC0tZm9yY2UgdG8gb3ZlcnJpZGUgdGhlIGxpdmUtZmxlZXQgZ3VhcmRcbiAgZ3JhcGV2aW5lIHJvbGwgWy0tZm9yY2VdICAgICAgICAgICMgc2FmZSByZXN0YXJ0IChzdG9wK2hvbGQrcmVzcGF3bikgKyB2ZXJzaW9uIHZlcmlmeSDigJQgdGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwXG4gIGdyYXBldmluZSBzdG9wIFstLWhvbGQgPHNlY29uZHM+XSAjIGtpbGwgdGhlIGRhZW1vbjsgLS1ob2xkIHN1cHByZXNzZXMgYXV0by1yZXNwYXduIGZvciA8cz4gc2Vjb25kcyAodXBncmFkZSB3aW5kb3cpXG4gIGdyYXBldmluZSBpbmZvXG4gIGdyYXBldmluZSBkb2N0b3IgICAgICAgICAgICAgICAgICAjIGhlYWx0aCBjaGVjayDigJQgbGFiZWxzIGVhY2ggZGFlbW9uOiBhdXRob3JpdGF0aXZlIC8gb3JwaGFuIC8gdW5yZXNwb25zaXZlIC8gdW5rbm93blxuICBncmFwZXZpbmUgcmVhcCBbLS1mb3JjZV0gWy0tZHJ5LXJ1bl0gICMga2lsbCBvcnBoYW4gZGFlbW9uczsgLS1mb3JjZSBhbHNvIGtpbGxzIHVucmVzcG9uc2l2ZTsgYWxpYXM6IHBydW5lXG5cbiAgZ3JhcGV2aW5lIHNjaGVtYSAgICAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSBkZXNjcmlwdGlvbiAoYWNjIGRlY2xhcmF0aW9uIHYwKVxuICBncmFwZXZpbmUgLS12ZXJzaW9uICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIHZlcnNpb24gKGFsaWFzOiAtViwgdmVyc2lvbilcbiAgZ3JhcGV2aW5lIGhlbHAgICAgICAgICAgICAgICAgICAgICMgdGhpcyB1c2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXG5cbk91dHB1dDpcbiAgRGF0YSBjb21tYW5kcyBlbWl0IEpTT04gb24gc3Rkb3V0IGJ5IERFRkFVTFQ7IHBhc3MgLS1odW1hbiBmb3IgcHJvc2Ugd2hlcmUgYVxuICBjb21tYW5kIG9mZmVycyBpdC4gRGlhZ25vc3RpY3MgYW5kIHdhcm5pbmdzIGdvIHRvIHN0ZGVyciwgbmV2ZXIgc3Rkb3V0LlxuICBVc2FnZSBlcnJvcnMgZXhpdCAyLiBFYWNoIGNvbW1hbmQgYWNjZXB0cyBpdHMgT1dOIGZsYWdzIChwbHVzIC0tYXMvLS1mcm9tLFxuICB3aGljaCBhcmUgZ2xvYmFsKSDigJQgYW4gdW5rbm93biBmbGFnIGZvciBhIHZlcmIgZW51bWVyYXRlcyB0aGF0IHZlcmIncyBzZXQuXG5cbkVudjpcbiAgR1JBUEVWSU5FX0ZST00gICBEZWZhdWx0IGlkZW50aXR5IGFsaWFzICgtLWZyb20vLS1hcyBhcmUgaW50ZXJjaGFuZ2VhYmxlKS5cbiAgR1JBUEVWSU5FX0hPTUUgICBEYXRhIGRpciAoZGVmYXVsdCB+Ly5ncmFwZXZpbmUpLlxuYDtcbn1cblxuLyoqXG4gKiBUaGUgb25lIHBsYWNlIHRoaXMgQ0xJIGNhbiBlbmQsIGFuZCB0aGUgb25lIHBsYWNlIGEgYENsaUVycm9yYCBiZWNvbWVzIGFuXG4gKiBleGl0IGNvZGUuXG4gKlxuICog4puUIEFEREVEIEFUIFBIQVNFIDYgQ0hBUFRFUiAyLCBBTkQgSVQgSVMgV0hBVCBNQUtFUyBgZGllYCBTQUZFIFRPIFRIUk9XLlxuICogYHJlcG9ydENsaUVycm9yYCB3cml0ZXMgdGhlIGVudmVsb3BlIGFuZCBoYW5kcyBiYWNrIHRoZSB0YXhvbm9teSBjb2RlOyBhXG4gKiB0aHJvdyBpdCBkb2VzIE5PVCByZWNvZ25pc2UgaXMgcmUtdGhyb3duLCBiZWNhdXNlIHN3YWxsb3dpbmcgYW4gdW5rbm93biBvbmVcbiAqIGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeSB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZVxuICogc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKlxuICog4pqgIGBkaXNwYXRjaGAsIE5PVCBUSEUgUkVHSVNUUlknUyBgbWFpbmAsIEZPUiBFWEFDVExZIFRIQVQgUkUtVEhST1c6IHRoZVxuICogcmVnaXN0cnkncyBgbWFpbmAgdHVybnMgYW4gdW5rbm93biB0aHJvdyBpbnRvIGFuIGludGVybmFsIGVudmVsb3BlLlxuICogYG1ldGEuY29tbWFuZGAg4oCUIHdoaWNoIHZlcmIgcHJvZHVjZWQgYW4gZW52ZWxvcGUg4oCUIGlzIHNldCBieSB0aGUgcmVnaXN0cnkgZnJvbVxuICogdGhlIHJhdyBmaXJzdCB0b2tlbiwgc28gYW4gdW5rbm93biB2ZXJiIHN0aWxsIG5hbWVzIGl0c2VsZiBpbiBpdHMgcmVqZWN0aW9uLlxuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgY2xpLmRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlICE9PSBudWxsKSByZXR1cm4gY29kZTtcbiAgICB0aHJvdyBlO1xuICB9XG59XG5cbi8vIOKblCBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBJVFMgQUJTRU5DRSBJUyBUSEUgU1RFUCAocGxheWJvb2sgQjMpLlxuLy8gYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSBgc2NyaXB0cy9jbGkudHNgLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuLy8gZW50cnksIHNvIHRoZSBndWFyZCB3b3VsZCBuZXZlciBydW4gYW5kIGV2ZXJ5IHZlcmIgd291bGQgcHJpbnQgbm90aGluZyBhbmRcbi8vIGV4aXQgMC4gTm9yIG1heSB0aGlzIGZpbGUgb2ZmZXIgYSBzZWNvbmQgZW50cnkgZnJvbSBpdHMgYXV0aG9yaW5nIGFkZHJlc3M6XG4vLyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAsIGBTVVJGQUNFX0NXRGAgYW5kIGBEQUVNT05fU0NSSVBUYCBhYm92ZSBhcmUgYWxsXG4vLyBjb21wdXRlZCBmcm9tIGBTQ1JJUFRfRElSYCBhbmQgYXJlIGNvcnJlY3Qgb25seSBmcm9tIGBkaXN0L2AuXG4vL1xuLy8gVGhlIGRyYWluIGNvbnRyYWN0IGxpdmVzIGF0IHRoZSBsYXVuY2hlciBub3cg4oCUIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbFxuLy8gcmV0dXJuLCBuZXZlciBhbiBleHBsaWNpdCBleGl0LCBiZWNhdXNlIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYVxuLy8gcGlwZSBhbmQgYHRhaWxgIHdyaXRlcyBKU09OTCBhIGNhbGxlciBwYXJzZXMuIFNlZVxuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9jbGkudHNgIGZvciB0aGUgZnVsbCBhY2NvdW50LlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuXG4gKiA2LiBEZWZhdWx0cyBhcmUgYXBwbGllZCBBRlRFUiB0aGUgcGVyLXJvdyBjaGVjaywgYW5kIG9ubHkgZm9yIGZsYWdzIHRoZSByb3dcbiAqICAgIGFjY2VwdHMg4oCUIHNvIGEgZGVmYXVsdGVkIGZsYWcgbmV2ZXIgdHJpcHMgdGhlIG1pc3BsYWNlZC1mbGFnIGNoZWNrLCBhbmQgYVxuICogICAgcm93IG5ldmVyIHNlZXMgYW5vdGhlciByb3cncyBkZWZhdWx0LlxuICogNy4gQXJpdHkgaXMgZW5mb3JjZWQgZnJvbSBgcG9zaXRpb25hbHNgOyB0aGUgcmVqZWN0aW9uIG5hbWVzIHRoZSBtaXNzaW5nXG4gKiAgICBgPHBvc2l0aW9uYWw+YCBvciB0aGUgZXh0cmEgdG9rZW4uIEEgcm93J3MgYGNoZWNrYCBtYXkgdGhlbiByZWZ1c2UgYVxuICogICAgY29tYmluYXRpb24gdGhlIGRlY2xhcmF0aW9uIGNhbm5vdCBleHByZXNzIChmbGFnLWRlcGVuZGVudCBhcml0eSkuXG4gKiA4LiBUaGUgcm93IHJ1bnM7IGEgbnVtYmVyIGl0IHJldHVybnMgaXMgdGhlIGV4aXQgY29kZSwgYW55dGhpbmcgZWxzZSBpcyAwLlxuICpcbiAqIFRoZSBtb2R1bGUgYWRkcyBgaGVscGAsIGB2ZXJzaW9uYCBhbmQgYHNjaGVtYWAgcm93cyB1bmxlc3MgdGhlIHNwZWxsIGRlZmluZXNcbiAqIGEgcm93IG9mIHRoYXQgbmFtZSAoZ3JhcGV2aW5lJ3MgYHZlcnNpb24gLS1odW1hbmApLiBUaGV5IGFyZSBvcmRpbmFyeSByb3dzOlxuICogZGVjbGFyZWQsIHN0cmljdCwgYW5kIGdpdmVuIGBnbG9iYWxGbGFnc2AgbGlrZSBldmVyeSBvdGhlciByb3cuXG4gKi9cblxuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uL2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi93aXJlL2Vycm9yc1wiO1xuXG4vLyDilIDilIAgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZsYWdUeXBlID0gXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiO1xuXG4vKiogT25lIGBwYXJzZUFyZ3NgIG9wdGlvbiwgcGx1cyB0aGUgYGRlZmF1bHRgIG5vZGUncyBwYXJzZXIgYWxzbyB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIE9wdGlvblNwZWMgPSB7XG4gIHR5cGU6IEZsYWdUeXBlO1xuICBtdWx0aXBsZT86IGJvb2xlYW47XG4gIHNob3J0Pzogc3RyaW5nO1xuICBkZWZhdWx0Pzogc3RyaW5nIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgcmVhZG9ubHkgYm9vbGVhbltdO1xufTtcblxuZXhwb3J0IHR5cGUgT3B0aW9uc1RhYmxlID0gUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgT3B0aW9uU3BlYz4+O1xuXG5leHBvcnQgdHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbmV4cG9ydCB0eXBlIEZsYWdWYWx1ZSA9IHN0cmluZyB8IGJvb2xlYW4gfCAoc3RyaW5nIHwgYm9vbGVhbilbXTtcblxuZXhwb3J0IHR5cGUgSW52b2NhdGlvbjxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIFRoZSByZXNvbHZlZCByb3cgbmFtZTogYFwib3BlblwiYCwgYFwibm9kZSBlZGl0XCJgLCBvciBgXCJcImAgZm9yIGEgdmVyYmxlc3Mgcm9vdC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHNwZWxsaW5nIHRoZSBjYWxsZXIgdXNlZCDigJQgYW4gYWxpYXMsIHdoZW4gb25lIHdhcyB1c2VkLiAqL1xuICB0b2tlbjogc3RyaW5nO1xuICAvKiogUG9zaXRpb25hbHMgYWZ0ZXIgdGhlIHBhdGguICovXG4gIHBvczogc3RyaW5nW107XG4gIC8qKiBGbGFncyBnaXZlbiwgcGx1cyB0aGUgZGVmYXVsdHMgb2YgdGhlIGZsYWdzIHRoaXMgcm93IGFjY2VwdHMuICovXG4gIGZsYWdzOiBQYXJ0aWFsPFJlY29yZDxGLCBGbGFnVmFsdWU+Pjtcbn07XG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogYFwib3BlblwiYDsgb25lIHNwYWNlIG1lYW5zIG9uZSBsZXZlbCBvZiBuZXN0aW5nOiBgXCJub2RlIGVkaXRcImAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVhY2ggYWxpYXMgaXMgZGlzcGF0Y2hhYmxlLCBsaXN0ZWQgaW4gYHZlcmJzYCwgYW5kIGdldHMgaXRzIG93biBkZWNsYXJlZFxuICAgKiAgcm93LiBBbiBhbGlhcyBvZiBhIG5lc3RlZCByb3cgbXVzdCBzaGFyZSBpdHMgZ3JvdXA6IGBcIm5vZGUgY2hhbmdlXCJgLiAqL1xuICBhbGlhc2VzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGlzIHJvdydzIG93biBmbGFnczsgYGdsb2JhbEZsYWdzYCBhcmUgYWRkZWQgdG8gdGhlbS4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IEZbXTtcbiAgLyoqIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gdGhpcywgYW5kIGl0IGlzIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLiAqL1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIEFkZGVkIGFzIHRoZSBgaGludGAgb2YgdGhpcyByb3cncyBmbGFnIHJlamVjdGlvbnMuICovXG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIC8qKiBgZmFsc2VgIGhhbmRzIG5vZGUncyBvd24gXCJVbmV4cGVjdGVkIGFyZ3VtZW50XCIgcmVmdXNhbCBhbnkgcG9zaXRpb25hbC4gKi9cbiAgYWxsb3dQb3NpdGlvbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBGbGFnLWRlcGVuZGVudCBhcml0eSAoaW1hZ28gYGhhbmRvZmYgLS1jbGVhcmAsIG1pbmQtbWFwcGVyIGAtLXRvfC0tY2xlYXJgKVxuICAgKiBhbmQgYW55IG90aGVyIGNvbWJpbmF0aW9uIHJ1bGUuIFJ1bnMgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrOyBhIHJldHVybmVkXG4gICAqIHN0cmluZyBpcyByZWZ1c2VkIGFzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIHRoaXMgcm93LiDimqAgVGhlIGRlY2xhcmF0aW9uXG4gICAqIGNhbm5vdCBleHByZXNzIHN1Y2ggYSBydWxlOiBhIHBvc2l0aW9uYWwgdGhhdCBgLS1jbGVhcmAgbWFrZXMgdW5uZWNlc3NhcnlcbiAgICogY2FuIG9ubHkgYmUgZGVjbGFyZWQgYHJlcXVpcmVkOiBmYWxzZWAsIGFuZCB0aGlzIGhvb2sgZW5mb3JjZXMgdGhlIHJlc3QuXG4gICAqL1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb248Rj4pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgbnVtYmVyIGlzIHRoZSBleGl0IGNvZGU7IGFueXRoaW5nIGVsc2UgbWVhbnMgMC4gKi9cbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiB1bmtub3duO1xufTtcblxuLyoqIEEgdmVyYmxlc3MgQ0xJJ3Mgb25lIHJvdyAoZGlnZXN0aWZ5KS4gYHBhdGg6IFtdYCBpbiB0aGUgZGVjbGFyYXRpb24uICovXG5leHBvcnQgdHlwZSBSb290U3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IE9taXQ8Q29tbWFuZFNwZWM8Rj4sIFwibmFtZVwiIHwgXCJhbGlhc2VzXCI+O1xuXG4vKipcbiAqIFdoZXJlIGEgZ3JvdXAncyBzdWItdmVyYiBpcyBmb3VuZC5cbiAqIC0gYGFkamFjZW50YCAoZGVmYXVsdCk6IHRoZSB0b2tlbiByaWdodCBhZnRlciB0aGUgZ3JvdXAgKGBub2RlIGVkaXQgWGApLlxuICogLSBgZmlyc3QtcG9zaXRpb25hbGA6IHRoZSBmaXJzdCB0b2tlbiBhZnRlciB0aGUgZ3JvdXAgdGhhdCBpcyBuZWl0aGVyIGEgZmxhZ1xuICogICBub3IgYSBzdHJpbmcgZmxhZydzIHZhbHVlLCBzbyBmbGFncyBtYXkgY29tZSBmaXJzdDpcbiAqICAgYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWAgcmVzb2x2ZXMgdG8gYGRvYyBkZWxldGVgIChtaW5kLW1hcHBlcikuXG4gKiAgIFRoZSBzY2FuIHN0b3BzIGF0IGEgYmFyZSBgLS1gLCB3aGljaCBpcyB0aGUgZXNjYXBlIGhhdGNoIGZvciBhIHBvc2l0aW9uYWxcbiAqICAgbGl0ZXJhbGx5IG5hbWVkIGxpa2UgYSBzdWItdmVyYjogYGRvYyAtLSBkZWxldGVgIHJlYWRzIHRoZSBkb2MgXCJkZWxldGVcIi5cbiAqL1xuZXhwb3J0IHR5cGUgR3JvdXBTcGVjID0geyBzdWJWZXJiQXQ/OiBcImFkamFjZW50XCIgfCBcImZpcnN0LXBvc2l0aW9uYWxcIiB9O1xuXG5leHBvcnQgdHlwZSBDbGlTcGVjPE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+ID0ge1xuICAvKiogYFwiYm91bnR5XCJgLCB1c2VkIGluIG1lc3NhZ2VzIGFuZCB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogVGhlIHJlbmRlcmVkIGhlbHAncyBmaXJzdCBsaW5lOiBgJHtuYW1lfSDigJQgJHtzdW1tYXJ5fWAuICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIC8qKiBUaGUgbGl0ZXJhbCBgQ0xJX09QVElPTlNgIG9iamVjdC4gKi9cbiAgb3B0aW9uczogTztcbiAgY29tbWFuZHM/OiByZWFkb25seSBDb21tYW5kU3BlYzxrZXlvZiBPICYgc3RyaW5nPltdO1xuICAvKipcbiAgICogQSB2ZXJibGVzcyBDTEkncyByb3cuIFJlc2VydmVkIHRva2VucyBhcyBgYXJndlswXWAgc3RpbGwgc2VsZWN0IHRoZWlyIHJvd3NcbiAgICogKGBoZWxwYCwgYHZlcnNpb25gLCBgc2NoZW1hYCwgYW55IGBjb21tYW5kc2AsIGFuZCB0aGUgaW50ZXJjZXB0b3JzKTsgZXZlcnlcbiAgICogb3RoZXIgYXJndiwgdGhlIGVtcHR5IG9uZSBpbmNsdWRlZCwgYmVsb25ncyB0byB0aGUgcm9vdC4gQSBwb3NpdGlvbmFsIHRoYXRcbiAgICogaGFwcGVucyB0byBzcGVsbCBhIHJlc2VydmVkIHRva2VuIGdvZXMgYWZ0ZXIgYSBiYXJlIGAtLWAuXG4gICAqL1xuICByb290PzogUm9vdFNwZWM8a2V5b2YgTyAmIHN0cmluZz47XG4gIC8qKiBBY2NlcHRlZCBieSBldmVyeSByb3csIGJ5IGNvbnRyYWN0IChncmFwZXZpbmUncyBgLS1hc2AvYC0tZnJvbWApLiAqL1xuICBnbG9iYWxGbGFncz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICBncmFtbWFyPzogXCJ2ZXJiLWZpcnN0XCIgfCBcImZsYWdzLWFueXdoZXJlXCI7XG4gIC8qKiBQZXItZ3JvdXAgc3ViLXZlcmIgcGxhY2VtZW50LCBrZXllZCBieSB0aGUgZ3JvdXAgdG9rZW4gKGBcImRvY1wiYCkuICovXG4gIGdyb3Vwcz86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEdyb3VwU3BlYz4+O1xuICAvKiogVGhlIHJvb3Qgcm93J3MgcG9zaXRpb25hbCBuYW1lIGluIGBzY2hlbWFgIChgXCJjb21tYW5kXCJgOyBnbGFtb3VyOiBgXCJ2ZXJiXCJgKS4gKi9cbiAgdmVyYlBvc2l0aW9uYWw/OiBzdHJpbmc7XG4gIC8qKiBGbGFncyBsZWZ0IG9mZiBldmVyeSB1c2FnZSBsaW5lIChnbGFtb3VyJ3MgcGVyLXZlcmIgYHNlc3Npb25gKS4gKi9cbiAgdXNhZ2VIaWRlcz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICAvKiogVGhlIGB2ZXJzaW9uYCByb3cncyBwYXlsb2FkLCBge25hbWUsIHZlcnNpb259YC4gKi9cbiAgdmVyc2lvbjogKCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqIFJlcGxhY2VzIHRoZSByZW5kZXJlZCBoZWxwIChncmFwZXZpbmUpLiAqL1xuICBoZWxwPzogKCkgPT4gc3RyaW5nO1xuICAvKiogQXBwZW5kZWQgYmVsb3cgdGhlIHJlbmRlcmVkIHJvd3MuICovXG4gIGhlbHBGb290ZXI/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBEZWNsYXJlZEFyZyA9IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBGbGFnVHlwZTsgc3RhdHVzOiBcInZhbGlkXCIgfTtcbmV4cG9ydCB0eXBlIERlY2xhcmVkQ29tbWFuZCA9IHtcbiAgcGF0aDogc3RyaW5nW107XG4gIGFyZ3M6IERlY2xhcmVkQXJnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xufTtcbmV4cG9ydCB0eXBlIERlY2xhcmF0aW9uID0ge1xuICBmb3JtYXRWZXJzaW9uOiBcIjBcIjtcbiAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCI7XG4gIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBzdHJpbmdbXSB9O1xuICBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW107XG59O1xuXG4vKiogQSByb3cgYXMgdGhlIG1vZHVsZSBob2xkcyBpdCwgZm9yIHRlc3RzIGFuZCB3YXJkcy4gKi9cbmV4cG9ydCB0eXBlIFJvd1ZpZXcgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcm93J3Mgb3duIGZsYWdzLCBhcyBkZWNsYXJlZC4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogT3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCwgaW4gb3B0aW9ucy10YWJsZSBvcmRlci4gKi9cbiAgYWNjZXB0ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIGB0cnVlYCBmb3IgYSBgaGVscGAvYHZlcnNpb25gL2BzY2hlbWFgIHJvdyB0aGUgbW9kdWxlIGFkZGVkLiAqL1xuICBhdXRvOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQ2xpID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFbnZlbG9wZSBvbiBmYWlsdXJlLCByZXR1cm5zIHRoZSBleGl0IGNvZGUuIEZvciB0aGUgc3BlbGwncyBgcnVuKClgLiAqL1xuICBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhyb3dzIGBDbGlFcnJvcmAsIGZvciBhIHNwZWxsIHdob3NlIG1haW4gZG9lcyBpdHMgb3duIHRyaWFnZS4gKi9cbiAgZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIGRlY2xhcmF0aW9uKCk6IERlY2xhcmF0aW9uO1xuICByZW5kZXJIZWxwKCk6IHN0cmluZztcbiAgLyoqIEEgcm93J3MgdXNhZ2UgbGluZSAoYFwiY2xvc2UgPGlkPiBbLS1mb3JjZV1cImApOyBgXCJcImAgZm9yIGFuIHVua25vd24gcGF0aC4gKi9cbiAgdXNhZ2VPZihwYXRoOiBzdHJpbmcpOiBzdHJpbmc7XG4gIC8qKiBFdmVyeSBmaXJzdCB0b2tlbiB0aGF0IGRpc3BhdGNoZXM6IHZlcmJzLCBhbGlhc2VzIGFuZCBncm91cCB0b2tlbnMuICovXG4gIHZlcmJzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZ1bGwgcGF0aCB0aGF0IGRpc3BhdGNoZXMsIGFsaWFzZXMgaW5jbHVkZWQgKGBcIm5vZGUgZWRpdFwiYCkuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgcm93J3MgYWNjZXB0ZWQgc2V0IGFzIGAtLXhgIHNwZWxsaW5ncywgc29ydGVkLiBgXCJcImAgaXMgdGhlIHJvb3QuICovXG4gIGZsYWdzRm9yKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdO1xuICAvKiogRXZlcnkgZmxhZyBpbiB0aGUgb3B0aW9ucyB0YWJsZSwgYXMgYC0teGAsIGluIHRhYmxlIG9yZGVyLiAqL1xuICByZWNvZ25pemVkRmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICByb3dzOiByZWFkb25seSBSb3dWaWV3W107XG59O1xuXG4vLyDilIDilIAgaW50ZXJuYWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG50eXBlIFJvdyA9IFJvd1ZpZXcgJiB7XG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIGFsbG93UG9zaXRpb25hbHM6IGJvb2xlYW47XG4gIGNoZWNrPzogKGludjogSW52b2NhdGlvbikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBydW46IChpbnY6IEludm9jYXRpb24pID0+IHVua25vd247XG59O1xuXG4vKiogVGhlIHRva2VucyB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi4gRGVjbGFyZWQgYXQgYHBhdGg6IFtdYC4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbi8qKiBMb25nIGZpcnN0OiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHQgc3RvcHMgYXQgdGhlIGZpcnN0XG4gKiAgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLiAqL1xuY29uc3QgSU5URVJDRVBUT1JfQ0hPSUNFUyA9IElOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuc29ydChcbiAgKGEsIGIpID0+IE51bWJlcihiLnN0YXJ0c1dpdGgoXCItLVwiKSkgLSBOdW1iZXIoYS5zdGFydHNXaXRoKFwiLS1cIikpLFxuKTtcblxuY29uc3QgZXJyQ29kZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+XG4gIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuY29uc3QgZXJyTWVzc2FnZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+IChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmaW5lQ2xpPGNvbnN0IE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+KHNwZWM6IENsaVNwZWM8Tz4pOiBDbGkge1xuICBjb25zdCBjbGlOYW1lID0gc3BlYy5uYW1lO1xuICBjb25zdCBvcHRpb25LZXlzID0gT2JqZWN0LmtleXMoc3BlYy5vcHRpb25zKTtcbiAgY29uc3Qga25vd24gPSBuZXcgU2V0KG9wdGlvbktleXMpO1xuICBjb25zdCBncmFtbWFyID0gc3BlYy5ncmFtbWFyID8/IFwidmVyYi1maXJzdFwiO1xuICBjb25zdCBnbG9iYWxzID0gWy4uLihzcGVjLmdsb2JhbEZsYWdzID8/IFtdKV0gYXMgc3RyaW5nW107XG4gIGNvbnN0IGhpZGVzID0gbmV3IFNldDxzdHJpbmc+KChzcGVjLnVzYWdlSGlkZXMgPz8gW10pIGFzIHN0cmluZ1tdKTtcblxuICBmb3IgKGNvbnN0IGcgb2YgZ2xvYmFscykge1xuICAgIGlmICgha25vd24uaGFzKGcpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdsb2JhbCBmbGFnIFwiJHtnfVwiIGlzIG5vdCBpbiBvcHRpb25zYCk7XG4gIH1cbiAgaWYgKChzcGVjLmNvbW1hbmRzPy5sZW5ndGggPz8gMCkgPT09IDAgJiYgc3BlYy5yb290ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ2l2ZSBjb21tYW5kcywgYSByb290LCBvciBib3RoYCk7XG4gIH1cblxuICAvLyBgcGFyc2VBcmdzYCBnZXRzIHRoZSB0YWJsZSBXSVRIT1VUIGRlZmF1bHRzOiB3aGljaCBmbGFncyB0aGUgY2FsbGVyIGdhdmUgaXNcbiAgLy8gdGhlIHF1ZXN0aW9uIHRoZSBwZXItcm93IGNoZWNrIGFza3MsIGFuZCBhIGRlZmF1bHQgaXMgbm90IHNvbWV0aGluZyBnaXZlbi5cbiAgY29uc3QgcGFyc2VPcHRpb25zID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIG9wdGlvbktleXMubWFwKChrKSA9PiB7XG4gICAgICBjb25zdCB7IGRlZmF1bHQ6IF9kLCAuLi5yZXN0IH0gPSBzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYztcbiAgICAgIHJldHVybiBbaywgcmVzdF07XG4gICAgfSksXG4gICkgYXMgUmVjb3JkPHN0cmluZywgeyB0eXBlOiBGbGFnVHlwZTsgbXVsdGlwbGU/OiBib29sZWFuOyBzaG9ydD86IHN0cmluZyB9PjtcbiAgY29uc3Qgc2hvcnRUb0tleSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgayBvZiBvcHRpb25LZXlzKSB7XG4gICAgY29uc3QgcyA9IHNwZWMub3B0aW9uc1trXT8uc2hvcnQ7XG4gICAgaWYgKHMgIT09IHVuZGVmaW5lZCkgc2hvcnRUb0tleS5zZXQocywgayk7XG4gIH1cblxuICBjb25zdCBhY2NlcHRlZE9mID0gKG93bjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSA9PiB7XG4gICAgY29uc3Qgc2V0ID0gbmV3IFNldChbLi4uZ2xvYmFscywgLi4ub3duXSk7XG4gICAgcmV0dXJuIG9wdGlvbktleXMuZmlsdGVyKChrKSA9PiBzZXQuaGFzKGspKTtcbiAgfTtcblxuICBjb25zdCB0b1JvdyA9IChcbiAgICBjOiBPbWl0PENvbW1hbmRTcGVjLCBcInJ1blwiPiAmIHsgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duIH0sXG4gICAgYXV0bzogYm9vbGVhbixcbiAgKTogUm93ID0+IHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5mbGFncykge1xuICAgICAgaWYgKCFrbm93bi5oYXMoZikpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IHJvdyBcIiR7Yy5uYW1lfVwiIG5hbWVzIGZsYWcgXCIke2Z9XCIsIG5vdCBpbiBvcHRpb25zYCk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICBhbGlhc2VzOiBbLi4uKGMuYWxpYXNlcyA/PyBbXSldLFxuICAgICAgZmxhZ3M6IFsuLi5jLmZsYWdzXSxcbiAgICAgIGFjY2VwdGVkOiBhY2NlcHRlZE9mKGMuZmxhZ3MpLFxuICAgICAgcG9zaXRpb25hbHM6IGMucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgIGRlc2NyaWJlOiBjLmRlc2NyaWJlLFxuICAgICAgYXV0byxcbiAgICAgIHJlamVjdEhpbnQ6IGMucmVqZWN0SGludCxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IGMuYWxsb3dQb3NpdGlvbmFscyA/PyB0cnVlLFxuICAgICAgY2hlY2s6IGMuY2hlY2sgYXMgUm93W1wiY2hlY2tcIl0sXG4gICAgICBydW46IGMucnVuIGFzIFJvd1tcInJ1blwiXSxcbiAgICB9O1xuICB9O1xuXG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gKHNwZWMuY29tbWFuZHMgPz8gW10pLm1hcCgoYykgPT4gdG9Sb3coYyBhcyBDb21tYW5kU3BlYywgZmFsc2UpKTtcblxuICAvLyBUaGUgYXV0byByb3dzLiBBZGRlZCBsYXN0LCBpbiB0aGlzIG9yZGVyLCB1bmxlc3MgdGhlIHNwZWxsIGhhcyBpdHMgb3duLlxuICBjb25zdCBjbGkgPSB7fSBhcyBDbGk7XG4gIGNvbnN0IGF1dG9Sb3dzOiBDb21tYW5kU3BlY1tdID0gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTiAoYWxpYXM6IC0tdmVyc2lvbiwgLVYpXCIsXG4gICAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgICAgcHJpbnRKc29uKGF3YWl0IHNwZWMudmVyc2lvbigpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSAoYWNjIGRlY2xhcmF0aW9uIHYwKVwiLFxuICAgICAgcnVuOiAoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGNsaS5kZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcImhlbHBcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInNob3cgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0ID0gY2xpLnJlbmRlckhlbHAoKTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUodGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGEgb2YgYXV0b1Jvd3MpIHtcbiAgICBpZiAoIXJvd3Muc29tZSgocikgPT4gci5uYW1lID09PSBhLm5hbWUpKSByb3dzLnB1c2godG9Sb3coYSwgdHJ1ZSkpO1xuICB9XG5cbiAgY29uc3Qgcm9vdFJvdzogUm93IHwgdW5kZWZpbmVkID1cbiAgICBzcGVjLnJvb3QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvUm93KHsgLi4uKHNwZWMucm9vdCBhcyBSb290U3BlYyksIG5hbWU6IFwiXCIgfSwgZmFsc2UpO1xuXG4gIC8vIEluZGV4IGV2ZXJ5IHNwZWxsaW5nLCBhbmQgY2hlY2sgdGhlIHRhYmxlIGlzIHdlbGwgZm9ybWVkLlxuICBjb25zdCBieVRva2VuID0gbmV3IE1hcDxzdHJpbmcsIFJvdz4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgY29uc3QgcGFydHMgPSB0LnNwbGl0KFwiIFwiKTtcbiAgICAgIGlmICh0LnRyaW0oKSAhPT0gdCB8fCBwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+IHAgPT09IFwiXCIgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGJhZCBjb21tYW5kIG5hbWUgXCIke3R9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0ICE9PSByLm5hbWUgJiYgcGFydHMubGVuZ3RoICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBuZXN0IGxpa2UgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMiAmJiB0ICE9PSByLm5hbWUgJiYgcGFydHNbMF0gIT09IHIubmFtZS5zcGxpdChcIiBcIilbMF0pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3Qgc2hhcmUgdGhlIGdyb3VwIG9mIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChieVRva2VuLmhhcyh0KSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IFwiJHt0fVwiIGlzIGRlZmluZWQgdHdpY2VgKTtcbiAgICAgIGJ5VG9rZW4uc2V0KHQsIHIpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzdWJzT2YgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBieVRva2VuLmtleXMoKSkge1xuICAgIGNvbnN0IFtncm91cCwgc3ViXSA9IHQuc3BsaXQoXCIgXCIpO1xuICAgIGlmIChncm91cCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdWJzT2Yuc2V0KGdyb3VwLCBbLi4uKHN1YnNPZi5nZXQoZ3JvdXApID8/IFtdKSwgc3ViXSk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgZyBvZiBPYmplY3Qua2V5cyhzcGVjLmdyb3VwcyA/PyB7fSkpIHtcbiAgICBpZiAoIXN1YnNPZi5oYXMoZykpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBncm91cCBcIiR7Z31cIiBoYXMgbm8gc3ViLXZlcmJzYCk7XG4gIH1cblxuICBjb25zdCBwYXRocyA9IFsuLi5ieVRva2VuLmtleXMoKV07XG4gIGNvbnN0IHZlcmJzID0gWy4uLm5ldyBTZXQocGF0aHMubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbiAgY29uc3Qgcm93Rm9yID0gKHBhdGg6IHN0cmluZyk6IFJvdyB8IHVuZGVmaW5lZCA9PiAocGF0aCA9PT0gXCJcIiA/IHJvb3RSb3cgOiBieVRva2VuLmdldChwYXRoKSk7XG4gIGNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gICAgWy4uLihyb3dGb3IocGF0aCk/LmFjY2VwdGVkID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuICBjb25zdCBsYWJlbCA9IChyOiBSb3cpOiBzdHJpbmcgPT4gci5uYW1lIHx8IGNsaU5hbWU7XG5cbiAgLyoqXG4gICAqIEEgdmVyYmxlc3Mgcm9vdCdzIHJlamVjdGlvbiBgY2hvaWNlc2A6IGl0cyBvd24gZmxhZ3MgUExVUyB0aGUgaW50ZXJjZXB0b3JzLFxuICAgKiBiZWNhdXNlIHRoZSBkZWNsYXJhdGlvbiBwdWJsaXNoZXMgYm90aCBhdCBgcGF0aDogW11gIGFuZCB0aGUgcm9vdCBhbnN3ZXJzXG4gICAqIGJvdGggKHRoZSBpbnRlcmNlcHRvcnMgYXMgYGFyZ3ZbMF1gKS4gTGVhdmluZyB0aGUgaW50ZXJjZXB0b3JzIG91dCBtYWRlXG4gICAqIG9uZSBwcm9jZXNzIHNheSB0d28gdGhpbmdzIGFib3V0IGl0cyByb290IOKAlCBhY2MncyBjZW5zdXMgcmVhZCBgLS1oZWxwYCxcbiAgICogYC1oYCwgYC0tdmVyc2lvbmAgYW5kIGAtVmAgYXMgZGVjbGFyZWQtbm90LWFjY2VwdGVkLiBMb25nIHNwZWxsaW5ncyBmaXJzdFxuICAgKiAoc29ydGVkKSwgdGhlbiB0aGUgc2hvcnRzOiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHRcbiAgICogc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy5cbiAgICovXG4gIGNvbnN0IHJvb3RDaG9pY2VzOiBzdHJpbmdbXSA9ICgoKSA9PiB7XG4gICAgY29uc3QgYWxsID0gWy4uLmZsYWdzRm9yKFwiXCIpLCAuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXTtcbiAgICBjb25zdCBsb25nID0gYWxsLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKFwiLS1cIikpLnNvcnQoKTtcbiAgICByZXR1cm4gWy4uLmxvbmcsIC4uLmFsbC5maWx0ZXIoKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCItLVwiKSldO1xuICB9KSgpO1xuXG4gIC8vIOKUgOKUgCBoZWxwIOKUgOKUgFxuXG4gIGNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICAgIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xuICB9O1xuICBjb25zdCByZW5kZXJGbGFnID0gKGs6IHN0cmluZyk6IHN0cmluZyA9PlxuICAgIHNwZWMub3B0aW9uc1trXT8udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgWy0tJHtrfV1gIDogYFstLSR7a30gLi5dYDtcbiAgY29uc3QgdXNhZ2VMaW5lID0gKHI6IFJvdyk6IHN0cmluZyA9PlxuICAgIFtcbiAgICAgIGxhYmVsKHIpLFxuICAgICAgLi4uci5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgICAuLi5yLmZsYWdzLmZpbHRlcigoaykgPT4gIWhpZGVzLmhhcyhrKSkubWFwKHJlbmRlckZsYWcpLFxuICAgIF0uam9pbihcIiBcIik7XG4gIGNvbnN0IGV4cGVjdHMgPSAocjogUm93KTogc3RyaW5nID0+IGBleHBlY3RzOiAke3VzYWdlTGluZShyKX1gO1xuXG4gIGNvbnN0IHJlbmRlckhlbHAgPSAoKTogc3RyaW5nID0+IHtcbiAgICBpZiAoc3BlYy5oZWxwICE9PSB1bmRlZmluZWQpIHJldHVybiBzcGVjLmhlbHAoKTtcbiAgICBjb25zdCBsaXN0ZWQgPSBbLi4uKHJvb3RSb3cgPyBbcm9vdFJvd10gOiBbXSksIC4uLnJvd3NdO1xuICAgIGNvbnN0IGxpbmVzID0gbGlzdGVkLm1hcCgocikgPT4gW3VzYWdlTGluZShyKSwgci5kZXNjcmliZV0gYXMgY29uc3QpO1xuICAgIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ubGluZXMubWFwKChbdV0pID0+IHUubGVuZ3RoKSksIDQ0KTtcbiAgICBjb25zdCBib2R5ID0gbGluZXNcbiAgICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgICAgdS5sZW5ndGggPD0gd2lkdGggPyBgICAke3UucGFkRW5kKHdpZHRoKX0gICR7ZH1gIDogYCAgJHt1fVxcbiAgJHtcIlwiLnBhZEVuZCh3aWR0aCl9ICAke2R9YCxcbiAgICAgIClcbiAgICAgIC5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGhlYWQgPSBzcGVjLnN1bW1hcnkgPyBgJHtjbGlOYW1lfSDigJQgJHtzcGVjLnN1bW1hcnl9YCA6IGNsaU5hbWU7XG4gICAgY29uc3QgdG9rZW5zID0gYCAgJHtJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLmpvaW4oXCIgfCBcIil9ICByb290IHRva2VuczogaGVscCwgb3Ige25hbWUsIHZlcnNpb259IGFzIEpTT05gO1xuICAgIHJldHVybiBgJHtoZWFkfVxcblxcbiR7Ym9keX1cXG4ke3Rva2Vuc30ke3NwZWMuaGVscEZvb3RlciA/IGBcXG5cXG4ke3NwZWMuaGVscEZvb3Rlcn1gIDogXCJcIn1gO1xuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgZGVjbGFyYXRpb24g4pSA4pSAXG5cbiAgY29uc3QgZGVjbGFyYXRpb24gPSAoKTogRGVjbGFyYXRpb24gPT4ge1xuICAgIGNvbnN0IGFyZyA9IChrOiBzdHJpbmcpOiBEZWNsYXJlZEFyZyA9PiAoe1xuICAgICAgbmFtZTogYC0tJHtrfWAsXG4gICAgICB0eXBlOiAoc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWMpLnR5cGUsXG4gICAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW10gPSBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdLFxuICAgICAgICBhcmdzOiBbXG4gICAgICAgICAgLi4uSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgICAgIG5hbWU6IGkubmFtZSxcbiAgICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIgYXMgY29uc3QsXG4gICAgICAgICAgfSkpLFxuICAgICAgICAgIC4uLihyb290Um93ID8gcm9vdFJvdy5hY2NlcHRlZC5tYXAoYXJnKSA6IFtdKSxcbiAgICAgICAgXSxcbiAgICAgICAgcG9zaXRpb25hbHM6IHJvb3RSb3dcbiAgICAgICAgICA/IHJvb3RSb3cucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKVxuICAgICAgICAgIDogW3sgbmFtZTogc3BlYy52ZXJiUG9zaXRpb25hbCA/PyBcImNvbW1hbmRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICAgIGZvciAoY29uc3QgdCBvZiBbci5uYW1lLCAuLi5yLmFsaWFzZXNdKSB7XG4gICAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICAgIHBhdGg6IHQuc3BsaXQoXCIgXCIpLFxuICAgICAgICAgIGFyZ3M6IHIuYWNjZXB0ZWQubWFwKGFyZyksXG4gICAgICAgICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHNjaGVtYVJvdyA9IGJ5VG9rZW4uZ2V0KFwic2NoZW1hXCIpIGFzIFJvdztcbiAgICByZXR1cm4ge1xuICAgICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbc2NoZW1hUm93Lm5hbWVdIH0sXG4gICAgICBjb21tYW5kcyxcbiAgICB9O1xuICB9O1xuXG4gIC8vIOKUgOKUgCBkaXNwYXRjaCDilIDilIBcblxuICAvKipcbiAgICogVGhlIGluZGV4IG9mIHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5laXRoZXIgYSBmbGFnIG5vciBhIHN0cmluZyBmbGFnJ3NcbiAgICogdmFsdWUsIHdhbGtpbmcgdGhlIHdheSB0aGUgcGFyc2VyIHdpbGw6IGAtLWsgdmAgY29uc3VtZXMgYHZgIHdoZW4gYGtgIGlzIGFcbiAgICogc3RyaW5nIGZsYWcsIGAtLWs9dmAgY29uc3VtZXMgbm90aGluZywgYC1zIHZgIGxpa2V3aXNlIGJ5IHRoZSBzaG9ydCdzIHR5cGUuXG4gICAqIEF0IGEgYmFyZSBgLS1gOiBgLTFgIHdoZW4gYHN0b3BBdFRlcm1pbmF0b3JgLCBlbHNlIHRoZSBpbmRleCBhZnRlciBpdC5cbiAgICovXG4gIGNvbnN0IHNjYW5Qb3NpdGlvbmFsID0gKGFyZ3M6IHN0cmluZ1tdLCBzdG9wQXRUZXJtaW5hdG9yOiBib29sZWFuKTogbnVtYmVyID0+IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGEgPSBhcmdzW2ldIGFzIHN0cmluZztcbiAgICAgIGlmIChhID09PSBcIi0tXCIpIHJldHVybiBzdG9wQXRUZXJtaW5hdG9yIHx8IGkgKyAxID49IGFyZ3MubGVuZ3RoID8gLTEgOiBpICsgMTtcbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItLVwiKSkge1xuICAgICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoc3BlYy5vcHRpb25zW2Euc2xpY2UoMildPy50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGEuc3RhcnRzV2l0aChcIi1cIikgJiYgYS5sZW5ndGggPiAxKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGEubGVuZ3RoID09PSAyID8gc2hvcnRUb0tleS5nZXQoYS5zbGljZSgxKSkgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBzcGVjLm9wdGlvbnNba2V5XT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBpO1xuICAgIH1cbiAgICByZXR1cm4gLTE7XG4gIH07XG5cbiAgY29uc3Qgd2l0aG91dCA9IChhcmdzOiBzdHJpbmdbXSwgaTogbnVtYmVyKTogc3RyaW5nW10gPT4gW1xuICAgIC4uLmFyZ3Muc2xpY2UoMCwgaSksXG4gICAgLi4uYXJncy5zbGljZShpICsgMSksXG4gIF07XG5cbiAgY29uc3Qgbm9Db21tYW5kID0gKCk6IG5ldmVyID0+XG4gICAgZGllKFwiZXhwZWN0ZWQgYSBjb21tYW5kXCIsIFwidXNhZ2VcIiwge1xuICAgICAgY2hvaWNlczogWy4uLnZlcmJzXSxcbiAgICAgIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIChvciAtLWhlbHApIGZvciB1c2FnZWAsXG4gICAgfSk7XG5cbiAgLyoqIEEgdmVyYiBjYW5kaWRhdGUgYW5kIHRoZSBhcmdzIGFmdGVyIGl0LCB0byBhIHJvdyBhbmQgdGhhdCByb3cncyBhcmdzLiAqL1xuICBjb25zdCByZXNvbHZlID0gKGNhbmQ6IHN0cmluZywgcmVzdDogc3RyaW5nW10pOiB7IHJvdzogUm93OyB0b2tlbjogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXSB9ID0+IHtcbiAgICBjb25zdCBzdWJzID0gc3Vic09mLmdldChjYW5kKTtcbiAgICBpZiAoc3VicyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhdCA9IHNwZWMuZ3JvdXBzPy5bY2FuZF0/LnN1YlZlcmJBdCA/PyBcImFkamFjZW50XCI7XG4gICAgICBsZXQgaSA9IC0xO1xuICAgICAgaWYgKGF0ID09PSBcImFkamFjZW50XCIpIHtcbiAgICAgICAgY29uc3QgbmV4dCA9IHJlc3RbMF07XG4gICAgICAgIGkgPSBuZXh0ICE9PSB1bmRlZmluZWQgJiYgIW5leHQuc3RhcnRzV2l0aChcIi1cIikgPyAwIDogLTE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpID0gc2NhblBvc2l0aW9uYWwocmVzdCwgdHJ1ZSk7XG4gICAgICB9XG4gICAgICBjb25zdCBzdWIgPSBpID49IDAgPyAocmVzdFtpXSBhcyBzdHJpbmcpIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgZnVsbCA9IHN1YiA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogYnlUb2tlbi5nZXQoYCR7Y2FuZH0gJHtzdWJ9YCk7XG4gICAgICBpZiAoZnVsbCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiB7IHJvdzogZnVsbCwgdG9rZW46IGAke2NhbmR9ICR7c3VifWAsIGFyZ3M6IHdpdGhvdXQocmVzdCwgaSkgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG93biA9IGJ5VG9rZW4uZ2V0KGNhbmQpO1xuICAgICAgaWYgKG93biAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyByb3c6IG93biwgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgICAgIGNvbnN0IGV4dHJhID0geyBjaG9pY2VzOiBbLi4uc3Vic10sIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIGZvciB1c2FnZWAgfTtcbiAgICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCkgZGllKGAke2NhbmR9OiBleHBlY3RlZCBhIHN1Yi1jb21tYW5kYCwgXCJ1c2FnZVwiLCBleHRyYSk7XG4gICAgICBkaWUoYHVua25vd24gJHtjYW5kfSBzdWItY29tbWFuZDogXCIke3N1Yn1cImAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgIH1cbiAgICBjb25zdCByb3cgPSBieVRva2VuLmdldChjYW5kKTtcbiAgICBpZiAocm93ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRpZShgdW5rbm93biBjb21tYW5kIFwiJHtjYW5kfVwiYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICAgIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIGZvciB1c2FnZWAsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcm93LCB0b2tlbjogY2FuZCwgYXJnczogcmVzdCB9O1xuICB9O1xuXG4gIGNvbnN0IHJ1blJvdyA9IGFzeW5jIChyb3c6IFJvdywgdG9rZW46IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4gPT4ge1xuICAgIHNldEN1cnJlbnRDb21tYW5kKHJvdy5uYW1lID09PSBcIlwiID8gbnVsbCA6IHJvdy5uYW1lKTtcbiAgICBjb25zdCBuYW1lID0gbGFiZWwocm93KTtcbiAgICBjb25zdCBhY2NlcHRlZCA9IG5ldyBTZXQocm93LmFjY2VwdGVkKTtcbiAgICBjb25zdCBjaG9pY2VzID0gcm93Lm5hbWUgPT09IFwiXCIgPyByb290Q2hvaWNlcyA6IGZsYWdzRm9yKHJvdy5uYW1lKTtcbiAgICBjb25zdCBmbGFnSGludCA9ICgpOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cbiAgICAgIFtyb3cucmVqZWN0SGludCwgY2hvaWNlcy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBmbGFnc2AgOiB1bmRlZmluZWRdXG4gICAgICAgIC5maWx0ZXIoKHMpOiBzIGlzIHN0cmluZyA9PiBzICE9PSB1bmRlZmluZWQpXG4gICAgICAgIC5qb2luKFwiOyBcIikgfHwgdW5kZWZpbmVkO1xuXG4gICAgbGV0IHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgbGV0IHBvc2l0aW9uYWxzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgKHsgdmFsdWVzLCBwb3NpdGlvbmFscyB9ID0gcGFyc2VBcmdzKHtcbiAgICAgICAgYXJncyxcbiAgICAgICAgb3B0aW9uczogcGFyc2VPcHRpb25zLFxuICAgICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICAgIGFsbG93UG9zaXRpb25hbHM6IHJvdy5hbGxvd1Bvc2l0aW9uYWxzLFxuICAgICAgfSkpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlcnJDb2RlKGUpID09PSBcIkVSUl9QQVJTRV9BUkdTX1VOS05PV05fT1BUSU9OXCIpIHtcbiAgICAgICAgZGllKGAke25hbWV9OiAke2Vyck1lc3NhZ2UoZSl9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXMsIGhpbnQ6IGZsYWdIaW50KCkgfSk7XG4gICAgICB9XG4gICAgICAvLyBBIG1pc3NpbmcgdmFsdWUgaXMgbm90IGEgY2hvaWNlIGZyb20gYSBzZXQsIHNvIG5vIGBjaG9pY2VzYCBoZXJlLlxuICAgICAgZGllKGAke25hbWV9OiAke2Vyck1lc3NhZ2UoZSl9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IHJvdy5yZWplY3RIaW50ID8/IGV4cGVjdHMocm93KSB9KTtcbiAgICB9XG5cbiAgICAvLyBTdGFnZSAyOiBrbm93biB0byB0aGUgc3BlbGwsIG5vdCB0YWtlbiBieSB0aGlzIHJvdyDigJQgTUlTUExBQ0VELCBub3RcbiAgICAvLyB1bmtub3duLiBPbmx5IGZsYWdzIHRoZSBjYWxsZXIgR0FWRSBhcmUgaGVyZTogZGVmYXVsdHMgYXJlIG5vdCBhcHBsaWVkIHlldC5cbiAgICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKHZhbHVlcykuZmluZCgoaykgPT4gIWFjY2VwdGVkLmhhcyhrKSk7XG4gICAgaWYgKHN0cmF5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7bmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCAke2NsaU5hbWV9IGZsYWcsIGp1c3Qgbm90IHRoaXMgJHtyb3cubmFtZSA9PT0gXCJcIiA/IFwiY29tbWFuZFwiIDogXCJ2ZXJiXCJ9J3MpYCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGNob2ljZXMsIGhpbnQ6IGZsYWdIaW50KCkgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQXJpdHksIGZyb20gdGhlIGRlY2xhcmVkIHNoYXBlLCBuYW1pbmcgdGhlIG1pc3Npbmcgb3IgdGhlIGV4dHJhIHRva2VuLlxuICAgIGNvbnN0IHJlcXVpcmVkID0gcm93LnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICAgIGNvbnN0IHZhcmlhZGljID0gcm93LnBvc2l0aW9uYWxzLnNvbWUoKHApID0+IHAudmFyaWFkaWMpO1xuICAgIGlmIChwb3NpdGlvbmFscy5sZW5ndGggPCByZXF1aXJlZCkge1xuICAgICAgY29uc3QgbWlzc2luZyA9IHJvdy5wb3NpdGlvbmFsc1twb3NpdGlvbmFscy5sZW5ndGhdO1xuICAgICAgZGllKGAke25hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIDwke21pc3Npbmc/Lm5hbWUgPz8gXCJhcmd1bWVudFwifT5gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogZXhwZWN0cyhyb3cpLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmICghdmFyaWFkaWMgJiYgcG9zaXRpb25hbHMubGVuZ3RoID4gcm93LnBvc2l0aW9uYWxzLmxlbmd0aCkge1xuICAgICAgZGllKFxuICAgICAgICBgJHtuYW1lfTogdW5leHBlY3RlZCBhcmd1bWVudCAke0pTT04uc3RyaW5naWZ5KHBvc2l0aW9uYWxzW3Jvdy5wb3NpdGlvbmFscy5sZW5ndGhdKX1gLFxuICAgICAgICBcInVzYWdlXCIsXG4gICAgICAgIHsgaGludDogcm93LnBvc2l0aW9uYWxzLmxlbmd0aCA9PT0gMCA/IGAke25hbWV9IHRha2VzIG5vIGFyZ3VtZW50c2AgOiBleHBlY3RzKHJvdykgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gRGVmYXVsdHMgbGFzdCwgYW5kIG9ubHkgdGhpcyByb3cncy5cbiAgICBjb25zdCBmbGFnczogUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPiA9IHsgLi4uKHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBGbGFnVmFsdWU+KSB9O1xuICAgIGZvciAoY29uc3QgayBvZiByb3cuYWNjZXB0ZWQpIHtcbiAgICAgIGNvbnN0IGQgPSAoc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWMpLmRlZmF1bHQ7XG4gICAgICBpZiAoZmxhZ3Nba10gPT09IHVuZGVmaW5lZCAmJiBkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZmxhZ3Nba10gPSAoQXJyYXkuaXNBcnJheShkKSA/IFsuLi5kXSA6IGQpIGFzIEZsYWdWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpbnY6IEludm9jYXRpb24gPSB7IHBhdGg6IHJvdy5uYW1lLCB0b2tlbiwgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3MgfTtcbiAgICBjb25zdCByZWZ1c2VkID0gcm93LmNoZWNrPy4oaW52KTtcbiAgICBpZiAocmVmdXNlZCAhPT0gdW5kZWZpbmVkKSBkaWUoYCR7bmFtZX06ICR7cmVmdXNlZH1gLCBcInVzYWdlXCIsIHsgaGludDogZXhwZWN0cyhyb3cpIH0pO1xuXG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgcm93LnJ1bihpbnYpO1xuICAgIHJldHVybiB0eXBlb2Ygb3V0ID09PSBcIm51bWJlclwiID8gb3V0IDogMDtcbiAgfTtcblxuICBjb25zdCBkaXNwYXRjaCA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgICBjb25zdCBmaXJzdCA9IGFyZ3ZbMF07XG5cbiAgICAvLyAxLiBJbnRlcmNlcHRvcnMgcGFzcyB0aGUgcmVzdCBvZiB0aGUgYXJndiBvbiB0byB0aGVpciByb3cuXG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBJTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBmaXJzdCk7XG4gICAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBydW5Sb3coYnlUb2tlbi5nZXQoaW50ZXJjZXB0b3IucnVucykgYXMgUm93LCBpbnRlcmNlcHRvci5ydW5zLCBhcmd2LnNsaWNlKDEpKTtcbiAgICB9XG5cbiAgICAvLyAyLiBBIHZlcmJsZXNzIHJvb3Qgb3ducyBldmVyeSBhcmd2IHRoYXQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlc2VydmVkIHRva2VuLlxuICAgIGlmIChyb290Um93ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkICYmIChieVRva2VuLmhhcyhmaXJzdCkgfHwgc3Vic09mLmhhcyhmaXJzdCkpKSB7XG4gICAgICAgIGNvbnN0IHIgPSByZXNvbHZlKGZpcnN0LCBhcmd2LnNsaWNlKDEpKTtcbiAgICAgICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBydW5Sb3cocm9vdFJvdywgXCJcIiwgYXJndik7XG4gICAgfVxuXG4gICAgLy8gMy4gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMikuXG4gICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcblxuICAgIC8vIDQuIEZpbmQgdGhlIHZlcmIuXG4gICAgbGV0IGNhbmQ6IHN0cmluZztcbiAgICBsZXQgcmVzdDogc3RyaW5nW107XG4gICAgaWYgKGdyYW1tYXIgPT09IFwidmVyYi1maXJzdFwiKSB7XG4gICAgICBpZiAoZmlyc3QgPT09IFwiLS1cIikge1xuICAgICAgICBpZiAoYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICAgIGNhbmQgPSBhcmd2WzFdO1xuICAgICAgICByZXN0ID0gW1wiLS1cIiwgLi4uYXJndi5zbGljZSgyKV07XG4gICAgICB9IGVsc2UgaWYgKGZpcnN0LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgIHJldHVybiBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtmaXJzdH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke3ZlcmJzLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZCA9IGZpcnN0O1xuICAgICAgICByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IHNjYW5Qb3NpdGlvbmFsKGFyZ3YsIGZhbHNlKTtcbiAgICAgIGlmIChpIDwgMCkge1xuICAgICAgICAvLyBObyB2ZXJiIGFueXdoZXJlOiBhbiB1bmtub3duIGZsYWcgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LFxuICAgICAgICAvLyBhbmQgYSBjbGVhbiBwYXJzZSBpcyBhIGJhcmUgaW52b2NhdGlvbi4gTmVpdGhlciByYW4gYSBjb21tYW5kLCBzb1xuICAgICAgICAvLyB0aGUgZW52ZWxvcGUncyBgbWV0YS5jb21tYW5kYCBpcyBudWxsLCBub3QgdGhlIGZpcnN0IGZsYWcnc1xuICAgICAgICAvLyBzcGVsbGluZyAoYGdsYW1vdXIgLS1ib2d1c2AgbmFtZXMgbm8gdmVyYikuXG4gICAgICAgIHNldEN1cnJlbnRDb21tYW5kKG51bGwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IHBhcnNlT3B0aW9ucywgc3RyaWN0OiB0cnVlLCBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgZGllKGVyck1lc3NhZ2UoZSksIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgICAgaGludDogYG5vIGNvbW1hbmQgZ2l2ZW4g4oCUIGNvbW1hbmRzOiAke3ZlcmJzLmpvaW4oXCIgXCIpfSAocnVuOiAke2NsaU5hbWV9IGhlbHApYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICB9XG4gICAgICBjYW5kID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgICAvLyBBIHZlcmIgZm91bmQgcmlnaHQgYWZ0ZXIgYSBgLS1gIGxlYXZlcyB0aGF0IGAtLWAgaW4gcGxhY2UsIHNvIHRoZVxuICAgICAgLy8gcmVzdCBvZiB0aGUgYXJndiBzdGF5cyBwb3NpdGlvbmFsLlxuICAgICAgcmVzdCA9IHdpdGhvdXQoYXJndiwgaSk7XG4gICAgfVxuICAgIHNldEN1cnJlbnRDb21tYW5kKGNhbmQpO1xuICAgIGNvbnN0IHIgPSByZXNvbHZlKGNhbmQsIHJlc3QpO1xuICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gIH07XG5cbiAgY29uc3QgbWFpbiA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgICAvLyBUaGUgaG91c2UgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuIEEgc3BlbGwgdGhhdFxuICAgICAgLy8gdHJpYWdlcyBpdHMgb3duIChnbGFtb3VyJ3MgRU5PRU5UIOKGkiB1c2FnZSkgY2FsbHMgYGRpc3BhdGNoYCBpbnN0ZWFkLlxuICAgICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIGVyck1lc3NhZ2UoZSkpKSA/PyAxO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2aWV3ID0gKHI6IFJvdyk6IFJvd1ZpZXcgPT4gKHtcbiAgICBuYW1lOiByLm5hbWUsXG4gICAgYWxpYXNlczogci5hbGlhc2VzLFxuICAgIGZsYWdzOiByLmZsYWdzLFxuICAgIGFjY2VwdGVkOiByLmFjY2VwdGVkLFxuICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLFxuICAgIGRlc2NyaWJlOiByLmRlc2NyaWJlLFxuICAgIGF1dG86IHIuYXV0byxcbiAgfSk7XG5cbiAgT2JqZWN0LmFzc2lnbihjbGksIHtcbiAgICBuYW1lOiBjbGlOYW1lLFxuICAgIG1haW4sXG4gICAgZGlzcGF0Y2gsXG4gICAgZGVjbGFyYXRpb24sXG4gICAgcmVuZGVySGVscCxcbiAgICB1c2FnZU9mOiAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByID0gcm93Rm9yKHBhdGgpO1xuICAgICAgcmV0dXJuIHIgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiB1c2FnZUxpbmUocik7XG4gICAgfSxcbiAgICB2ZXJicyxcbiAgICBwYXRocyxcbiAgICBmbGFnc0ZvcixcbiAgICByZWNvZ25pemVkRmxhZ3M6IG9wdGlvbktleXMubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgcm93czogcm93cy5tYXAodmlldyksXG4gIH0gc2F0aXNmaWVzIENsaSk7XG4gIHJldHVybiBjbGk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pdGVtcy90YWlsLXJlYWRlci1jb252ZXJnZW5jZS93cml0ZS11cC5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuXG4gICAqXG4gICAqICDim5QgQU5EIFdIRU4gVEhFIE5FVyBMT0cgV0FTIEFMUkVBRFkgUEFTVCBUSEUgQk9PS01BUkssIFRIRSBDTElFTlRcbiAgICogIFJFQ09OTkVDVFMgRlJPTSBJVFMgU1RBUlQuIEEgZGFlbW9uIHRoYXQgYmVsaWV2ZXMgdGhlIGN1cnNvciBzZW5kcyBvbmx5XG4gICAqICB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuIG1lc3NhZ2UgYXRcbiAgICogIG5ldyBpZCAyIHVuZGVyIGFuIG9sZCBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgc2lsZW50bHkuIEV2ZXJ5dGhpbmcgaW5cbiAgICogIGEgbmV3IGVwb2NoIGlzIG5ldyB0byB0aGlzIHJlYWRlciwgc28gdGhlIGF0dGVtcHQgaXMgZHJvcHBlZCBhbmQgcmUtbWFkZVxuICAgKiAgZnJvbSAwIGF0IG9uY2UgKG5vIGJhY2tvZmYpLiBBIGZyYW1lIEFUIG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgbWVhbnNcbiAgICogIHRoZSBkYWVtb24gaXMgYWxyZWFkeSByZXBsYXlpbmcgd2hvbGUsIGFuZCBpcyBrZXB0LiAoUmV2aWV3ZXIncyBEMiBnYXAsXG4gICAqICBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZi4pICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKiogVGhlIGVwb2NoIHRoZSBzdGFydGluZyBgc2luY2VgIGNhbWUgZnJvbSwgd2hlbiB0aGUgY2FsbGVyIGhhcyBvbmUgKGFcbiAgICogIGJvb2ttYXJrIHByaW50ZWQgYXMgYE5APGVwb2NoPmAsIGAuL3RhaWxIYW5kb2ZmLnRzYCkuIFRoZSBmaXJzdCBmcmFtZSBvZiBhXG4gICAqICBkaWZmZXJlbnQgZXBvY2ggaXMgdGhlbiBhbiBlcG9jaCBjaGFuZ2UgbGlrZSBhbnkgb3RoZXIg4oCUIHdoaWNoIGlzIHdoYXRcbiAgICogIHN0b3BzIGEgYm9va21hcmsgb3V0bGl2aW5nIGl0cyBsb2cgYWNyb3NzIHByb2Nlc3Nlcy4gKi9cbiAgc2luY2VFcG9jaD86IHN0cmluZztcbiAgLyoqXG4gICAqIFJlYWQgYSBmcmFtZSB3aG9zZSBpZCBpcyBBVCBPUiBCRUxPVyB0aGUgY3Vyc29yIHRoaXMgY29ubmVjdGlvbiBhc2tlZFxuICAgKiBmcm9tIGFzIFwidGhlIGxvZyByZXN0YXJ0ZWRcIiwgcmVzZXQgdGhlIGN1cnNvciB0byAwLCBhbmQgY2FsbFxuICAgKiBgb25FcG9jaENoYW5nZWAgKHdpdGggdGhlIGZyYW1lJ3MgZXBvY2gsIG9yIGBcInVua25vd25cImApLiBEZWZhdWx0IGZhbHNlLlxuICAgKlxuICAgKiDim5QgV0hZIElUIElTIEhPTkVTVDogdGhlIGtpdCdzIGV2ZW50IGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duXG4gICAqIGJ5IHJlcGxheWluZyBXSE9MRSAoYC4vZXZlbnRMb2cudHNgLCBwb2ludCAzKSwgYW5kIG90aGVyd2lzZSBzZW5kcyBvbmx5XG4gICAqIGlkcyBhYm92ZSB0aGUgY3Vyc29yLiBTbyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgZXhpc3RzIG9ubHlcbiAgICogd2hlbiB0aGUgZGFlbW9uIGp1ZGdlZCB0aGUgY3Vyc29yIGZvcmVpZ24g4oCUIGEgcmVzdGFydGVkIGRhZW1vbiwgd2hvc2UgaWRzXG4gICAqIGJlZ2FuIGFnYWluIGF0IDEuIFRoZSBlcG9jaCBjYXRjaGVzIHRoYXQgV0lUSElOIG9uZSBwcm9jZXNzOyB0aGlzIGNhdGNoZXNcbiAgICogaXQgQUNST1NTIHByb2Nlc3Nlcywgd2hlcmUgYSByZS1hcm1lZCB0YWlsIGNhcnJpZXMgYSBib29rbWFyayBmcm9tIGEgbG9nXG4gICAqIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cyBhbmQsIHdpdGhvdXQgaXQsIGtlcHQgdGhhdCBib29rbWFyayBmb3JldmVyOiBldmVyeVxuICAgKiByZS1hcm0gcmVwbGF5ZWQgdGhlIHdob2xlIG5ldyBsb2csIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wXG4gICAqIChmb3VuZCBieSB0aGUgdmVyaWZpZXIgb24gZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIGFmdGVyIGB0YWlsLmxvc3RgIOKGklxuICAgKiBgb3BlbiAtLXJlc3RvcmVgKS5cbiAgICpcbiAgICog4pqgIE9OTFkgRk9SIEEgREFFTU9OIE9OIFRIRSBLSVQnUyBFVkVOVCBMT0cuIEdyYXBldmluZSdzIGlkcyBhcmUgcmVjb3ZlcmVkXG4gICAqIGFjcm9zcyBhIHJlc3RhcnQgYW5kIGl0cyBgLS1sYXN0YCBxdWVyeSBvdmVycmlkZXMgYHNpbmNlYCwgc28gaXQgbGVhdmVzXG4gICAqIHRoaXMgb2ZmLiBBbmQgdGhlIGJsaW5kIHNwb3QgaXMgc3RhdGVkOiBhIGJvb2ttYXJrIHRoYXQgaGFwcGVucyB0byBiZSBhdFxuICAgKiBvciBiZWxvdyB0aGUgUkVTVEFSVEVEIGxvZydzIG93biBsZW5ndGggbG9va3MgdmFsaWQgdG8gdGhlIGRhZW1vbiwgd2hpY2hcbiAgICogdGhlbiBzZW5kcyBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdC4gVGhlIGNvbWUtYmFjayBwYXRoIHRoZXJlZm9yZSBkcm9wc1xuICAgKiB0aGUgYm9va21hcmsgYWx0b2dldGhlciAoYC4vdGFpbEhhbmRvZmYudHNgLCBEMiksIHNvIHRoaXMgaXMgdGhlIG5ldCwgbm90XG4gICAqIHRoZSBydWxlLlxuICAgKi9cbiAgcmVzdGFydE9uUmVwbGF5PzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiBgYWNjZXB0ZWRgIGlzIGBhY2NlcHRgJ3NcbiAgICogIHZlcmRpY3Qgb24gdGhpcyBmcmFtZSwgd2hpY2ggaXMgd2hhdCBsZXRzIGB0YWlsIC0tb25jZWAgZW5kIG9uIHRoZSBmaXJzdFxuICAgKiAgZnJhbWUgaXQgYWN0dWFsbHkgREVMSVZFUlMgKGAuL3RhaWxIYW5kb2ZmLnRzYCkuXG4gICAqXG4gICAqICDim5QgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04gYmVmb3JlIHRoZSBjbGllbnQgcmV0dXJucy4gSXRcbiAgICogIHVzZWQgdG8gcmV0dXJuIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3Agd2l0aCB0aGUgU1NFIHN0cmVhbSBzdGlsbCBvcGVuLFxuICAgKiAgd2hpY2gga2VwdCB0aGUgcHJvY2VzcyBhbGl2ZSDigJQgdW5zZWVuIGZvciBgY2xvc2VkYCwgYmVjYXVzZSB0aGUgc2VydmVyXG4gICAqICBlbmRzIHRoYXQgc3RyZWFtIGl0c2VsZiwgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrXG4gICAqICB3b3VsZCBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudC4gKEFkanVzdG1lbnQgMSBvZiB0aGVcbiAgICogIE1vbml0b3ItZXhwaXJ5IHNwaWtlOyBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLikgKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUsIGFjY2VwdGVkOiBib29sZWFuKSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIENhbGxlZCBvbmNlIGFzIHRoZSB0YWlsIGVuZHMsIHdpdGggdGhlIGZpbmFsIGN1cnNvciAodGhlIGJvb2ttYXJrIGEgcmUtYXJtXG4gICAqIHBhc3NlcyBhcyBgLS1zaW5jZWApIGFuZCB3aHkgaXQgZW5kZWQuIEEgUkVQT1JUIFNJTksgbGlrZSBgb25EaXNjb25uZWN0YCxcbiAgICogbm90IGEgYmVoYXZpb3VyYWwgaGF0Y2g6IGl0IGNoYW5nZXMgbm90aGluZyB0aGUgY2xpZW50IGRvZXMuIEl0IGV4aXN0c1xuICAgKiBmb3IgYC4vdGFpbEhhbmRvZmYudHNgLCB3aG9zZSBsYXN0IGxpbmUgbmFtZXMgdGhlIHJlLWFybSBhbmQgbXVzdCBjYXJyeVxuICAgKiB0aGUgY3Vyc29yIGV4YWN0bHkgYXMgdGhpcyBsb29wIGxlZnQgaXQsIGVwb2NoIHJlc2V0cyBpbmNsdWRlZC5cbiAgICovXG4gIG9uRW5kPzogKGVuZDoge1xuICAgIGN1cnNvcjogbnVtYmVyO1xuICAgIC8qKiBUaGUgZXBvY2ggb2YgdGhlIGxvZyB0aGUgY3Vyc29yIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgb25lLiAqL1xuICAgIGVwb2NoOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlYXNvbjogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIjtcbiAgfSkgPT4gdm9pZDtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHtcbiAgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDtcbiAgY29tbWVudHM6IHN0cmluZ1tdO1xufSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG9wdHMuc2luY2VFcG9jaCA/PyBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcbiAgbGV0IGVuZGluZzogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIiA9IFwic3RvcHBlZFwiO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgLy8g4puUIEEgU1RPUCBUSEFUIExBTkRFRCBXSElMRSBgcmVzb2x2ZWAgV0FTIEFXQUlURUQgKHRoZSBoYW5kb2ZmJ3Mgd2luZG93LFxuICAgICAgLy8gYSBzaWduYWwpIGZvdW5kIG5vIGF0dGVtcHQgdG8gYWJvcnQuIFdpdGhvdXQgdGhpcyBjaGVjayB0aGUgbG9vcCB3ZW50XG4gICAgICAvLyBvbiB0byBmZXRjaCwgc2tpcHBlZCB0aGUgcmVhZCwgYW5kIHJldHVybmVkIHdpdGggdGhhdCBzdHJlYW0gc3RpbGxcbiAgICAgIC8vIG9wZW4g4oCUIHdoaWNoIGtlZXBzIGEgcHJvY2VzcyBhbGl2ZSBleGFjdGx5IGxpa2UgdGhlIHRlcm1pbmFsLWZyYW1lXG4gICAgICAvLyBoYW5nLiAoU3VzcGVjdGVkIGJ5IHRoZSByZXZpZXdlciwgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikge1xuICAgICAgICAgIGVuZGluZyA9IFwidW5yZXNvbHZlZFwiO1xuICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8ge1xuICAgICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICB9O1xuICAgICAgLy8gV2hhdCB0aGlzIGNvbm5lY3Rpb24gYXNrZWQgZnJvbSwgZm9yIGByZXN0YXJ0T25SZXBsYXlgLlxuICAgICAgY29uc3QgYXNrZWRTaW5jZSA9IGN1cnNvcjtcbiAgICAgIGxldCByZXN0YXJ0Tm90ZWQgPSBmYWxzZTtcbiAgICAgIC8vIFNldCB3aGVuIGFuIGVwb2NoIGNoYW5nZSBmaW5kcyB0aGUgbmV3IGxvZyBwYXN0IHRoZSBib29rbWFyay5cbiAgICAgIGxldCBmcm9tVG9wID0gZmFsc2U7XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuXG4gICAgICAgICAgICBsZXQgZXBvY2hSZXNldCA9IGZhbHNlO1xuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgZXBvY2hSZXNldCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgICAgLy8gVGhlIG5ldyBsb2cgaXMgcGFzdCB0aGUgYm9va21hcms6IGl0cyBzdGFydCB3YXMgc2tpcHBlZC5cbiAgICAgICAgICAgICAgICAgIC8vIERyb3AgdGhpcyBhdHRlbXB0IGFuZCByZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gMC5cbiAgICAgICAgICAgICAgICAgIGlmIChhc2tlZFNpbmNlID4gMCAmJiB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBuID4gYXNrZWRTaW5jZSkge1xuICAgICAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgICAgICAgIGZyb21Ub3AgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIG9wdHMucmVzdGFydE9uUmVwbGF5ID09PSB0cnVlICYmXG4gICAgICAgICAgICAgICFlcG9jaFJlc2V0ICYmXG4gICAgICAgICAgICAgICFyZXN0YXJ0Tm90ZWQgJiZcbiAgICAgICAgICAgICAgYXNrZWRTaW5jZSA+PSAwICYmXG4gICAgICAgICAgICAgIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmXG4gICAgICAgICAgICAgIG4gPD0gYXNrZWRTaW5jZVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIFRoZSBkYWVtb24gcmVwbGF5ZWQgV0hPTEU6IGl0cyBsb2cgcmVzdGFydGVkIChzZWUgdGhlIG9wdGlvbikuXG4gICAgICAgICAgICAgIHJlc3RhcnROb3RlZCA9IHRydWU7XG4gICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihvcHRzLmVwb2NoT2Y/LihldikgPz8gXCJ1bmtub3duXCIpID8/IG51bGw7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHtcbiAgICAgICAgICAgICAgLy8g4puUIENMT1NFIFRIRSBDT05ORUNUSU9OLiBTZWUgYHRlcm1pbmFsYCdzIGRvYzogd2l0aG91dCB0aGlzIHRoZVxuICAgICAgICAgICAgICAvLyBvcGVuIHN0cmVhbSBrZWVwcyB0aGUgcHJvY2VzcyBhbGl2ZSBhZnRlciB3ZSByZXR1cm4uXG4gICAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgICAgZW5kaW5nID0gXCJ0ZXJtaW5hbFwiO1xuICAgICAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGZyb21Ub3ApIHtcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGZyb21Ub3ApIHtcbiAgICAgICAgLy8gUmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIGl0cyBzdGFydCwgbm93OiBub3RoaW5nIGZhaWxlZC5cbiAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgICBvcHRzLm9uRW5kPy4oeyBjdXJzb3IsIGVwb2NoLCByZWFzb246IGVuZGluZyB9KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSB0YWlsJ3MgSEFORE9GRjogaG93IGEgc3BlbGwncyBgdGFpbGAgZW5kcyBpdHMgb3duIHdhdGNoIGp1c3QgYmVmb3JlIHRoZVxuICogaGFybmVzcydzIE1vbml0b3IgY2FwLCBhbmQgdGhlIG9uZSBzdGRvdXQgbGluZSB0aGF0IG5hbWVzIHRoZSBhZ2VudCdzIG5leHRcbiAqIGFjdCwgYm9va21hcmsgaW5jbHVkZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBUaGlzIG1vZHVsZSBpbXBvcnRzIG9ubHkgaXRzIHNpYmxpbmcgYC4vdGFpbEV2ZW50c2AuXG4gKlxuICogQnVpbHQgb24gYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0byBDb2xlJ3MgcnVsaW5nIG9mIDIwMjYtMDktMjMgKHRoZVxuICogXCJSdWxpbmdcIiBzZWN0aW9uIG9mXG4gKiBgZG9jcy9pdGVtcy9zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaXRlbXMvbW9uaXRvci1leHBpcnktYW5kLXRoZS10YWlsL3dyaXRlLXVwLm1kYCkuXG4gKlxuICog4pSA4pSAIFRIRSBQUk9CTEVNLCBPTkUgUEFSQUdSQVBIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBraWxscyBldmVyeSB3YXRjaCBhdCAxLDgwMCwwMDAgbXMuIEV2ZXJ5IHNwZWxsIHRlbGxzXG4gKiB0aGUgYWdlbnQgdG8gd3JhcCBgdGFpbGAgaW4gTW9uaXRvciwgc28gYW4gaWRsZSBzZXNzaW9uIHdva2UgdGhlIGFnZW50IGV2ZXJ5XG4gKiAzMCBtaW51dGVzIHRvIHJlLWFybSwgYW5kIGEgYmFyZSByZS1hcm0gcmVwbGF5ZWQgdXAgdG8gdGhlIGxhc3QgMTAwMCBldmVudHMsXG4gKiBhbnN3ZXJlZCBodW1hbiBtZXNzYWdlcyBpbmNsdWRlZC4gVGhlIHJlcGxheSBpcyBhIGNvcnJlY3RuZXNzIGJ1ZzsgdGhlIGlkbGVcbiAqIHdha2VzIGFyZSBhIGNvc3QgQ29sZSBydWxlZCBhZ2FpbnN0LlxuICpcbiAqIOKUgOKUgCBUSEUgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVHdvIG1vZGVzLCBvbmUgbGluZSBhdCB0aGUgZW5kIG9mIGVhY2g6XG4gKlxuICogICDigKIgYHdhdGNoYCAodGhlIGRlZmF1bHQsIHJ1biB1bmRlciBNb25pdG9yKTogc3RyZWFtcyB1bnRpbCBpdHMgV0lORE9XIGVuZHMsXG4gKiAgICAgdGhlbiBwcmludHMgYHRhaWwud2luZG93YCAoaXQgc2F3IGV2ZW50cyDihpIgcmUtYXJtIE1vbml0b3IpIG9yXG4gKiAgICAgYHRhaWwucXVpZXRgIChpdCBzYXcgbm9uZSDihpIgcnVuIGB0YWlsIC0tb25jZWAgYXMgYSBiYWNrZ3JvdW5kIEJhc2hcbiAqICAgICB0YXNrKS4gQSBQUkVTRU5DRSBzcGVsbCAoYXN0cm9sYWJlLCBncmFwZXZpbmUpIGFsd2F5cyBnZXRzXG4gKiAgICAgYHRhaWwud2luZG93YDogYSBzdG9wLXN0YXJ0IHRhaWwgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzXG4gKiAgICAgY29ubmVjdGlvbiBjYXJyaWVzLiBNaW5kLW1hcHBlciB3YXMgb25lIGFuZCBpcyBub3Qgc2luY2UgMjAyNi0wOS0yNFxuICogICAgIChzZWUgXCJNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFNcIiBiZWxvdykuXG4gKiAgIOKAoiBgb25jZWAgKHJ1biBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrKTogc2xlZXBzIHVudGlsIHRoZSBmaXJzdCBsb2cgZXZlbnQsXG4gKiAgICAgcHJpbnRzIGl0LCBwcmludHMgYHRhaWwud29rZWAgKOKGkiBiYWNrIHRvIE1vbml0b3IpIGFuZCBFWElUUywgd2hpY2ggaXNcbiAqICAgICB3aGF0IHdha2VzIHRoZSBhZ2VudC5cbiAqXG4gKiBFaXRoZXIgbW9kZSBlbmRzIHdpdGggYHRhaWwuY2xvc2VkYCB3aGVuIHRoZSBzZXNzaW9uIGNsb3NlcyBhbmQgYHRhaWwubG9zdGBcbiAqIHdoZW4gdGhlIGRhZW1vbiBpcyBnb25lIChzZXNzaW9uIHNwZWxscyBhbmQgbWluZC1tYXBwZXIpLCBlYWNoIG5hbWluZyBob3cgdG9cbiAqIGNvbWUgYmFjayBpbnN0ZWFkIG9mIGEgcmUtYXJtLiBBIHNpZ25hbCBvciBhIGNhbGxlcidzIGFib3J0IHByaW50cyBub3RoaW5nLlxuICpcbiAqIEV2ZXJ5IHJlLWFybSBjYXJyaWVzIGAtLXNpbmNlIDxjdXJzb3I+YCwgc28gbm90aGluZyByZXBsYXlzOyB0aGUgZGFlbW9uJ3NcbiAqIGJ1ZmZlciBjb3ZlcnMgd2hhdGV2ZXIgbGFuZHMgYmV0d2VlbiBvbmUgd2F0Y2gncyBleGl0IGFuZCB0aGUgbmV4dCdzIGFybS5cbiAqXG4gKiDilIDilIAgREVDSVNJT04gTE9HIChmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogS2l0IGRlY2lzaW9ucyBsaXZlIGluIG1vZHVsZSBoZWFkZXJzICh0aGUgYXJjaGl0ZWN0dXJlIGRvYydzIMKnNCBydWxlOiBcImVhY2hcbiAqIG1vZHVsZSdzIGhlYWRlciBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhY2NvdW50XCIpLiBSdWxlZCBieSBDb2xlOiB0aGUgaHlicmlkLFxuICogdGhlIGFsd2F5cy1ib29rbWFyaywgcHJlc2VuY2Ugc3BlbGxzIGFsd2F5cyByZS1hcm0gTW9uaXRvciwgYm91bnR5J3MgZXhhbXBsZVxuICogZml4ZWQuIFRoZSBmb3VyIGFkanVzdG1lbnRzIHdlcmUgdGhlIHNwaWtlJ3MgcmVxdWlyZW1lbnRzLiBUaGUgcmVzdCBhcmUgdGhlXG4gKiBpbXBsZW1lbnRlcidzIHJ1bGluZ3MsIG1hcmtlZCDimpYgd2l0aCB0aGUgb3B0aW9ucyBub3QgdGFrZW4uXG4gKlxuICogQTEgwrcgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04uIGB0YWlsRXZlbnRzYCBub3cgYWJvcnRzIHRoZVxuICogICAgICBpbi1mbGlnaHQgZmV0Y2ggYmVmb3JlIGl0IHJldHVybnMgb24gYSB0ZXJtaW5hbCBmcmFtZS4gQmVmb3JlLCBpdFxuICogICAgICByZXR1cm5lZCBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIGFuZCBsZWZ0IHRoZSBTU0Ugc3RyZWFtIG9wZW4sIHNvIHRoZVxuICogICAgICBwcm9jZXNzIHN0YXllZCBhbGl2ZTogdW5zZWVuIGZvciBgY2xvc2VkYCAodGhlIHNlcnZlciBlbmRzIHRoYXRcbiAqICAgICAgc3RyZWFtIGl0c2VsZikgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrIHdvdWxkXG4gKiAgICAgIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LCBzaWxlbnRseS4gUGlubmVkIGluXG4gKiAgICAgIGB0YWlsSGFuZG9mZi50ZXN0LnRzYCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQga2VlcHMgdGhlIHN0cmVhbSBvcGVuLlxuICpcbiAqIEEyIMK3IFRIRSBORVhUIEFDVCBERVBFTkRTIE9OIFNUQVRFLiBgaGFuZG9mZigpYCBiZWxvdyBpcyB0aGUgcHVyZSBkZWNpc2lvbjpcbiAqICAgICAgcXVpZXQg4oaSIGJhY2tncm91bmQsIGFjdGl2ZSBvciBwcmVzZW5jZSDihpIgTW9uaXRvciwgd29rZSDihpIgTW9uaXRvcixcbiAqICAgICAgY2xvc2VkIOKGkiBjb21lIGJhY2ssIGxvc3Qg4oaSIGNvbWUgYmFjay4gQ29tZSBiYWNrIGlzIHRoZSBzcGVsbCdzIG93biB2ZXJiXG4gKiAgICAgIChgb3BlbiAtLXJlc3RvcmUgPGlkPmAgZm9yIHRoZSBzZXNzaW9uIHNwZWxscywgYG9wZW4gLS1uby1vcGVuYCBmb3JcbiAqICAgICAgbWluZC1tYXBwZXIgYW5kIGFzdHJvbGFiZSkuXG4gKiAgICAgIOKaliBUSEUgRElTQ09OTkVDVCBERUNJU0lPTjogZm9yIGEgc2Vzc2lvbiBzcGVsbCwgYSBMT1NUIGRhZW1vbiBlbmRzIHRoZVxuICogICAgICB0YWlsIGluIEJPVEggbW9kZXMgd2l0aCBhIHN0ZG91dCBgdGFpbC5sb3N0YCBsaW5lLiBNb25pdG9yIG5vdGlmaWVzIG9ubHlcbiAqICAgICAgb24gc3Rkb3V0LCBzbyB0aGUgb2xkIHN0ZGVyci1vbmx5IGB0YWlsLmRpc2Nvbm5lY3RlZGAgbGVmdCBhXG4gKiAgICAgIE1vbml0b3Itd3JhcHBlZCBhZ2VudCB1bmF3YXJlIG9mIGEgYGtpbGwgLTlgIChFNTUncyBwdXJwb3NlIHVubWV0KSwgYW5kXG4gKiAgICAgIGEgYC0tb25jZWAgb24gYSBkZWFkIGRhZW1vbiB3b3VsZCBoYXZlIHNsZXB0IGZvcmV2ZXIuIFwiTG9zdFwiIGlzXG4gKiAgICAgIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBjb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93LCBuZXZlciBhIGRyb3BwZWRcbiAqICAgICAgc3RyZWFtIGFsb25lOiBhIGxhcHRvcCB0aGF0IHNsZWVwcyBkcm9wcyB0aGUgc3RyZWFtLCByZWNvbm5lY3RzIG9uIHRoZVxuICogICAgICBmaXJzdCB0cnksIGFuZCBtdXN0IHN0YXkgc2lsZW50LlxuICogICAgICAgIE5vdCB0YWtlbjogKGEpIGtlZXAgcmV0cnlpbmcgYW5kIG9ubHkgTU9WRSB0aGUgZGlzY29ubmVjdCBsaW5lIHRvXG4gKiAgICAgICAgc3Rkb3V0IOKAlCBhIHNlc3Npb24gZGFlbW9uIGlzIG5ldmVyIHJlc3Bhd25lZCBieSBpdHMgdGFpbCwgc28gdGhlXG4gKiAgICAgICAgcmV0cmllcyBidXkgbm90aGluZyBhbmQgdGhlIGFnZW50IGlzIHdva2VuIHRvIGJlIHRvbGQgdG8gd2FpdDsgKGIpXG4gKiAgICAgICAgbGVhdmUgaXQgb24gc3RkZXJyIOKAlCB0aGUgZGVmZWN0LlxuICogICAgICDimpYgUHJlc2VuY2Ugc3BlbGxzIGtlZXAgcmV0cnlpbmcsIGFzIGJlZm9yZTogZ3JhcGV2aW5lJ3MgdGFpbCByZXNwYXduc1xuICogICAgICBpdHMgZGFlbW9uIGFuZCBhc3Ryb2xhYmUncyBgam9pbmAgd2FpdHMgZm9yIHRoZSBodW1hbiB0byByZW9wZW4gdGhlXG4gKiAgICAgIGJvYXJkLCBib3RoIGJ5IGRlc2lnbi4gVGhlaXIgZGlzY29ubmVjdCBub3RlcyBzdGF5IHdoZXJlIHRoZXkgd2VyZS5cbiAqXG4gKiBBMyDCtyBRVUlFVCBJUyBUSEUgVEFJTCdTIE9XTiBDT1VOVC4gYGV2ZW50c2AgY291bnRzIHRoZSBsb2cgZnJhbWVzIHRoaXNcbiAqICAgICAgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQuIFRoZSBncm91bmRpbmcgbGluZSwgYSBzcGVsbCdzIGBzdWJzY3JpYmVkYFxuICogICAgICBtYXJrZXIsIGBlcG9jaC5jaGFuZ2VkYCBhbmQgdGhlIGhhbmRvZmYgbGluZSBpdHNlbGYgYXJlIG5vdCBsb2cgZnJhbWVzXG4gKiAgICAgIGFuZCBhcmUgbm90IGNvdW50ZWQ6IGEgZnJhbWUgY291bnRzIG9ubHkgaWYgaXQgY2FycmllcyBhIGxvZyBpZCAoRDMpLFxuICogICAgICBhbmQgYGNvdW50c2AgbGV0cyBhIHNwZWxsIGV4Y2x1ZGUgYSBmcmFtZSB0aGF0IGRvZXMgKGdyYXBldmluZSdzXG4gKiAgICAgIGBzdWJzY3JpYmVkYCBtYXJrZXIsIHdoaWNoIHNlZWRzIHRoZSBib29rbWFyayBmcm9tIGBsYXRlc3RfaWRgKS4gQW55IGxvZyBmcmFtZSBjb3VudHMsIHRoZSBkYWVtb24ncyBgd2FpdGluZ2AgcmVtaW5kZXJcbiAqICAgICAgaW5jbHVkZWQsIHNvIFwicXVpZXRcIiBtZWFucyBub3RoaW5nIG9uIHRoZSBsb2cuXG4gKiAgICAgIOKaliBBIGZyYW1lIHRoZSB0YWlsJ3Mgb3duIGZpbHRlciByZWplY3RzIChib3VudHkncyBvd25lciBzY29wZSwgYVxuICogICAgICBzZWxmLWVjaG8pIGlzIE5PVCBjb3VudGVkIGFuZCBkb2VzIG5vdCBlbmQgYSBgLS1vbmNlYDogaXQgd2FzIG5ldmVyXG4gKiAgICAgIGRlbGl2ZXJlZCwgYW5kIHdha2luZyBvbiBpdCB3b3VsZCBiZSBhIHdha2Ugd2l0aCBub3RoaW5nIHRvIGFjdCBvbiDigJRcbiAqICAgICAgdGhlIGRlZmVjdCB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcmVtb3ZlLiBUaGUgY3Vyc29yIHN0aWxsIGFkdmFuY2VzXG4gKiAgICAgIHBhc3QgaXQgKHRhaWxFdmVudHMnIHJ1bGUpLCBzbyBpdCBuZXZlciByZXBsYXlzIGVpdGhlci5cbiAqICAgICAgQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTsgdGhhdCBoYWxmIGxpdmVzIGluIGVhY2hcbiAqICAgICAgc3BlbGwncyBgdGFpbGAsIHdoaWNoIGtub3dzIHdoZXRoZXIgYC0tc2luY2VgIHdhcyBnaXZlbi5cbiAqXG4gKiBBNCDCtyBUSEUgV0lORE9XLiBgREVGQVVMVF9XSU5ET1dfTVNgID0gdGhlIGNhcCBtaW51cyBgV0lORE9XX01BUkdJTl9NU2BcbiAqICAgICAgKDYwIHMpLCBzbyAxLDc0MCwwMDAgbXMuIFRoZSBtYXJnaW4gaGFzIHRvIGNvdmVyIHRoZSBnYXAgYmV0d2VlbiB0aGVcbiAqICAgICAgaGFybmVzcyBzdGFydGluZyBpdHMgY2xvY2sgYW5kIHRoaXMgcHJvY2VzcyBzdGFydGluZyBpdHMgb3duIChCdW5cbiAqICAgICAgc3RhcnQtdXAsIGEgc2Vzc2lvbiBsb29rdXAsIGEgZGFlbW9uIHNwYXduIG9uIHRoZSBzcGVsbHMgd2hvc2UgYHJlc29sdmVgXG4gKiAgICAgIHNwYXducyBvbmUg4oCUIGJvdW5kZWQgYnkgdGhlaXIgc3RhcnQgdGltZW91dHMsIHdoaWNoIGFyZSBzZWNvbmRzKSBwbHVzXG4gKiAgICAgIHRoZSBsYXN0IGxpbmUncyBmbHVzaCBhbmQgTW9uaXRvcidzIDIwMCBtcyBiYXRjaGluZy4gQSBtaW51dGUgY292ZXJzXG4gKiAgICAgIGFsbCBvZiB0aGF0IG1hbnkgdGltZXMgb3Zlci4gVGhlIHNwaWtlIG1lYXN1cmVkIGEgMTIgc1xuICogICAgICB3aW5kb3cgdW5kZXIgYSAyMCBzIGNhcCBlbmRpbmcgY2xlYW5seTsgbm90aGluZyBoZXJlIGRlcGVuZHMgb24gYVxuICogICAgICBtYXJnaW4gdGhhdCB0aWdodC4gSWYgdGhlIGNhcCB3aW5zIGFueXdheSwgdGhlIGFnZW50IGdldHMgTW9uaXRvcidzXG4gKiAgICAgIGJhcmUgZXhwaXJ5IG5vdGljZSBhbmQgcmUtYXJtcyBzaWxlbnRseSBmcm9tIHRoZSBsYXN0IGlkIGl0IHNhdyDigJQgdGhlXG4gKiAgICAgIHJ1bGluZydzIGZhbGxiYWNrLCBzdGF0ZWQgaW4gZXZlcnkgc2tpbGwuXG4gKiAgICAgIOKaliBUaGUgd2luZG93IGlzIGluamVjdGFibGUgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gdGhyb3VnaFxuICogICAgICBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TYCAoYSBjb3VudCBvZiBtczsgYDBgIHR1cm5zIHRoZSB3aW5kb3cgb2ZmLFxuICogICAgICBmb3IgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsKS4gQW4gZW52IHZhciBhbmQgbm90IGEgZmxhZzogaXQgaXNcbiAqICAgICAgbm90IGFuIGFnZW50J3MgYWN0LCBzbyBpdCBzdGF5cyBvdXQgb2YgZWlnaHQgdmVyYnMnIHNjaGVtYXMuXG4gKlxuICog4pSA4pSAIFRIRSBWRVJJRklFUidTIERFRkVDVFMsIEZJWEVEIE9OIFRIRSBTQU1FIEJSQU5DSCAoMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIG5vLXN0YWtlIHZlcmlmaWVyIHJhbiBldmVyeSBzcGVsbCdzIHJlYWwgdGFpbCBhbmQgZm91bmQgZm91ciB3YXlzIHRoZVxuICogbG9vcCBicm9rZS4gRWFjaCBoYXMgYSBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYDsgRDEgYW5kIEQyIGFsc28gaGF2ZSBhXG4gKiByZWFsLWRhZW1vbiBjZWxsIGluIGBzcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90YWlsLWhhbmRvZmYuaW50ZWdyYXRpb24udGVzdC50c2AuXG4gKlxuICogRDEgwrcgQSBSRS1BUk0gQVQgQSBTRVNTSU9OIFRIQVQgQ0xPU0VEIElOIFRIRSBHQVAgRU5EUyBgdGFpbC5jbG9zZWRgLiBUaGVcbiAqICAgICAgdHJpZ2dlciBpcyBvcmRpbmFyeTogdGhlIGh1bWFuIHByZXNzZXMgQ2xvc2Ugd2hpbGUgdGhlIGFnZW50IGhhbmRsZXNcbiAqICAgICAgYHRhaWwud29rZWAuIFRoZSBzZXNzaW9uIHNwZWxscyBzdG9wcGVkIG9ubHkgd2hlbiBUSElTIHByb2Nlc3MgaGFkXG4gKiAgICAgIG9uY2UgcmVhY2hlZCB0aGUgc2Vzc2lvbiwgc28gdGhlIHJlLWFybSByZXRyaWVkIFwibm8gc2Vzc2lvbiB5ZXRcIiBvblxuICogICAgICBzdGRlcnIgZm9yZXZlciDigJQgYW5kIGl0cyBgLS1vbmNlYCBuZXZlciBleGl0ZWQuIFJ1bGU6IGEgdGFpbCBnaXZlblxuICogICAgICBgLS1zZXNzaW9uYCBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElORyBzZXNzaW9uLCBzbyBub3RcbiAqICAgICAgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQ7IHRoZSBzcGVsbCdzIGBvblVucmVzb2x2ZWRgIHNheXMgXCJzdG9wXCJcbiAqICAgICAgYW5kIHRoaXMgbW9kdWxlIHJlYWRzIEFOWSBzdG9wIGFzIGNsb3NlZC4gQSBiYXJlIGZpcnN0IGFybSBzdGlsbFxuICogICAgICB3YWl0cyBmb3IgYSBzZXNzaW9uIHRvIGFwcGVhci4g4pqgIFwiR2l2ZW5cIiBtZWFucyBPTiBUSEUgQ09NTUFORCBMSU5FXG4gKiAgICAgIChyZXZpZXcgQjEpOiBib3VudHkgYWxzbyByZXNvbHZlcyBhIHNlc3Npb24gZnJvbVxuICogICAgICBgJEJPVU5UWV9TRVNTSU9OX0tFWWAsIGAkQk9VTlRZX1NFU1NJT05gIG9yIGEgYC5ib3VudHktc2Vzc2lvbmAgZmlsZSxcbiAqICAgICAgd2hpY2ggZXZlcnkgYW50aGlsbCBzZWF0IGhhcywgYW5kIGEgc2VhdCdzIGZpcnN0IGFybSBtdXN0IHdhaXQuIEFcbiAqICAgICAga2V5ZWQgYm91bnR5IGJvYXJkIGNvbWVzIGJhY2sgYnkgaXRzIGtleSAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCk7XG4gKiAgICAgIHJlc3RvcmluZyBpdCBieSBpZCBzcGF3bnMgYW4gdW5rZXllZCBzdHJheS5cbiAqIEQyIMK3IEEgQk9PS01BUksgQ0FOTk9UIE9VVExJVkUgSVRTIExPRy4gQSByZXN0b3JlZCBkYWVtb24ncyBpZHMgYmVnaW4gYXQgMSxcbiAqICAgICAgYW5kIHRoZSBraXQncyBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93biBieSByZXBsYXlpbmcgd2hvbGU7XG4gKiAgICAgIHRoZSB0YWlsIGtlcHQgaXRzIGhpZ2hlciBjdXJzb3IsIHNvIGV2ZXJ5IHJlLWFybSByZXBsYXllZCB0aGUgbmV3IGxvZ1xuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVHdvIGhhbHZlczpcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFRocmVlIHBhcnRzOlxuICogICAgICAgIChhKSB0aGUgbmV0IOKAlCBgdGFpbEV2ZW50c2AnIGByZXN0YXJ0T25SZXBsYXlgLCBvbiBmb3IgZXZlcnkgc3BlbGwsXG4gKiAgICAgICAgICAgIHJlYWRzIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBhcyBhIHJlc3RhcnRlZCBsb2dcbiAqICAgICAgICAgICAgYW5kIHJlc2V0cyB0aGUgY3Vyc29yO1xuICogICAgICAgIChiKSB0aGUgcnVsZSDigJQgdGhlIGB0YWlsLmNsb3NlZGAvYHRhaWwubG9zdGAgaGludCwgYW5kIGV2ZXJ5IHNraWxsLFxuICogICAgICAgICAgICBzYXk6IHJ1biB0aGUgY29tbWFuZCB0aGUgbGluZSBuYW1lcywgdGhlbiB0YWlsIFdJVEggTk9cbiAqICAgICAgICAgICAgYC0tc2luY2VgIChhIHJlc3RvcmVkIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nOyBib3VudHkncyByZXN0b3JlXG4gKiAgICAgICAgICAgIGV2ZW4gbWludHMgYSBuZXcgaWQpO1xuICogICAgICAgIChjKSBUSEUgRVBPQ0ggSU4gVEhFIEJPT0tNQVJLIOKAlCDimpYgQSBSRVZFUlNBTC4gVGhlIGZpcnN0IHZlcnNpb24gb2ZcbiAqICAgICAgICAgICAgdGhpcyBlbnRyeSBsaXN0ZWQgXCJjYXJyeSB0aGUgZXBvY2ggaW4gdGhlIGJvb2ttYXJrXCIgYXMgbm90IHRha2VuXG4gKiAgICAgICAgICAgIChhIG5ldyBmbGFnIG9uIGVpZ2h0IHZlcmJzOyBhbiBlcG9jaCBzZWVuIG9ubHkgb25jZSBhIGZyYW1lXG4gKiAgICAgICAgICAgIGFycml2ZXMpLiBUaGUgcmV2aWV3ZXIgdGhlbiBzaG93ZWQgKGEpJ3MgYmxpbmQgc3BvdCBMSVZFOiBhbiBvbGRcbiAqICAgICAgICAgICAgYm9va21hcmsgYXQgb3IgYmVsb3cgdGhlIE5FVyBsb2cncyBsZW5ndGggbWFrZXMgdGhlIGRhZW1vbiBzZW5kXG4gKiAgICAgICAgICAgIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hblxuICogICAgICAgICAgICBtZXNzYWdlIGF0IG5ldyBpZCAyIHVuZGVyIGEgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHdpdGggbm9cbiAqICAgICAgICAgICAgbm90aWNlLiBUaHJlZSBwYXRocyByZWFjaCBpdDogY29taW5nIGJhY2sgd2l0aG91dCBmb2xsb3dpbmcgKGIpO1xuICogICAgICAgICAgICB0aGUgTW9uaXRvci1jYXAgZmFsbGJhY2sgKFwicmUtYXJtIGZyb20gdGhlIGxhc3QgaWQgeW91IHNhd1wiKVxuICogICAgICAgICAgICBhY3Jvc3MgYSByZXN0YXJ0OyBhbmQgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbi1wcm9jZXNzXG4gKiAgICAgICAgICAgIChhc3Ryb2xhYmUsIG9yIG1pbmQtbWFwcGVyIHdoZW4gaXRzIGRhZW1vbiBpcyBiYWNrIGJlZm9yZSB0aGVcbiAqICAgICAgICAgICAgbG9zdCBydWxlIGZpcmVzKSB3aG9zZSBmaXJzdCBmcmFtZSBhZnRlciBhIHJlc3RhcnQgaXMgYWxyZWFkeVxuICogICAgICAgICAgICBwYXN0IGl0cyBib29rbWFyay5cbiAqICAgICAgICAgICAgVGhlIGZpeCBuZWVkcyBubyBuZXcgZmxhZyBhbmQgbm8gd2lyZSBjaGFuZ2U6IHRoZSBib29rbWFyayBpc1xuICogICAgICAgICAgICBwcmludGVkIGAtLXNpbmNlIE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCksIHRoZSBjbGllbnQgc3RhcnRzXG4gKiAgICAgICAgICAgIHdpdGggdGhhdCBlcG9jaCAoYHNpbmNlRXBvY2hgKSwgYW5kIGFuIGVwb2NoIGNoYW5nZSB3aG9zZSBmcmFtZVxuICogICAgICAgICAgICBpcyBwYXN0IHRoZSBhc2tlZCBjdXJzb3IgcmUtcmVhZHMgdGhlIG5ldyBsb2cgZnJvbSAwLiBUaGUgc2FtZVxuICogICAgICAgICAgICByZWNvbm5lY3QgY292ZXJzIHRoZSBpbi1wcm9jZXNzIHByZXNlbmNlIGNhc2UuXG4gKiAgICAgIOKaoCBTVEFURUQgTElNSVQ6IG9ubHkgZGFlbW9ucyB0aGF0IHN0YW1wIGFuIGVwb2NoIGdldCAoYykg4oCUXG4gKiAgICAgIHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUgYW5kIG1pbmQtbWFwcGVyLiBHbGFtb3VyLCBpbWFnbywgbWFncGllIGFuZFxuICogICAgICBib3VudHkgc3RhbXAgbm9uZSAoc2Vzc2lvbi1zY29wZWQgbG9ncywgcnVsZWQgc28gaW4gRDM5L0I4OyBib3VudHknc1xuICogICAgICBzZXJ2ZXIgaGVhZGVyIG5hbWVzIHRoaXMgcmVzaWR1ZSksIHNvIGZvciB0aGVtIHRoZSBnYXAgc3RheXMgb3BlbiBvblxuICogICAgICB0aGUgZmFsbGJhY2sgcGF0aCwgKGEpIGNvdmVycyB0aGUgd2hvbGUtcmVwbGF5IGNhc2UgYW5kIChiKSB0aGVcbiAqICAgICAgY29tZS1iYWNrIHBhdGguIENsb3NpbmcgaXQgdGhlcmUgaXMgYSBkYWVtb24gY2hhbmdlOiBhbiBlcG9jaCBvblxuICogICAgICBgY3JlYXRlRXZlbnRMb2dgLiBFdmVyeSBzcGVsbCBwcmludHMgdGhlIG5ldCdzIHJlc2V0IGFzXG4gKiAgICAgIGBlcG9jaC5jaGFuZ2VkYCAoYFwiZXBvY2hcIjogXCJ1bmtub3duXCJgIHdoZXJlIHRoZXJlIGlzIG5vbmUpLlxuICogRDMgwrcgT05MWSBBIEZSQU1FIFdJVEggQSBMT0cgSUQgQ09VTlRTLiBHbGFtb3VyJ3MgYW5kIGltYWdvJ3MgdGFiIHBpbmdzXG4gKiAgICAgIChgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCkgY2Fycnkgbm8gaWQ6IG5vdCBvbiB0aGUgbG9nLCBzbyBhIGxhcHRvcFxuICogICAgICBsaWQgbm8gbG9uZ2VyIHdha2VzIGEgYC0tb25jZWAsIGFuZCBpbWFnbydzIGdyZXAgbm8gbG9uZ2VyIHNob3dzIGFcbiAqICAgICAgYHRhaWwud29rZWAgd2l0aCBub3RoaW5nIGFib3ZlIGl0LlxuICogRDQgwrcgQSBIVU1BTidTIFdBVENIIEhBUyBOTyBXSU5ET1cuIGBncmFwZXZpbmUgdGFpbCAtLWh1bWFuYCBwYXNzZXNcbiAqICAgICAgYHdpbmRvd01zOiAwYDsgbm8gb3RoZXIgc3BlbGwgaGFzIGEgaHVtYW4gbW9kZS4gRXZlcnkgYHRhaWxgJ3MgaGVscFxuICogICAgICBjYXJyaWVzIGBXSU5ET1dfSEVMUGAsIHdoaWNoIG5hbWVzIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MGAuXG4gKiBBbHNvOiBldmVyeSBjb21lLWJhY2sgY29tbWFuZCBjYXJyaWVzIGAtLW5vLW9wZW5gLCBzbyBydW5uaW5nIGl0IG9wZW5zIG5vXG4gKiBicm93c2VyIHRhYi5cbiAqXG4gKiDimqAgS05PV04gRURHRSwgTk9UIEZJWEVEIChmb3VuZCBieSB0aGUgcmUtcmV2aWV3KTogYSBrZXllZCBib3VudHkgRklSU1QgYXJtXG4gKiAgIChhbiBhbnRoaWxsIHNlYXQpIHdob3NlIHdpbmRvdyBlbmRzIGJlZm9yZSBpdHMgYm9hcmQgZXZlciBvcGVucyBwcmludHMgYVxuICogICByZS1hcm0gcGlubmVkIHRvIHRoZSBkZXJpdmVkIGlkIHdpdGggYW4gZW1wdHkgYm9va21hcmtcbiAqICAgKGAtLXNlc3Npb24gay3igKYgLS1zaW5jZT0tMSAtLW9uY2VgKS4gVGhhdCByZS1hcm0gaXMgYSByZS1hcm0gYnkgRDEncyBydWxlLFxuICogICBzbyBpZiB0aGUgYm9hcmQgaXMgc3RpbGwgbm90IHVwIOKAlCB0aGUgbGVhZCBtb3JlIHRoYW4gb25lIHdpbmRvdyAoMjkgbWluKVxuICogICBsYXRlIOKAlCB0aGUgc2VhdCBnZXRzIGB0YWlsLmNsb3NlZGAgaW5zdGVhZCBvZiB3YWl0aW5nLiBNaW5vcjogdGhlXG4gKiAgIGNvbWUtYmFjayBpdCBuYW1lcyAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCkgaXMgdGhlIHJpZ2h0IG5leHQgc3RlcCBhbnl3YXkuXG4gKlxuICog4pSA4pSAIFRIRSBDT01NQU5EIE5BTUVTIE5PIFBBVEggKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBsaW5lJ3MgYGNvbW1hbmRgIGlzIHRoZSBWRVJCIEFORCBJVFMgQVJHVU1FTlRTIE9OTFlcbiAqIChgdGFpbCAtLXNlc3Npb24gWCAtLXNpbmNlIE5ARSAtLW9uY2VgKSwgcGx1cyBgc3BlbGxgLCBhbmQgdGhlIGFnZW50IHJ1bnMgaXRcbiAqIHdpdGggSVRTIE9XTiBsYXVuY2hlciwgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHNgLiBJdCB1c2VkXG4gKiB0byBiZSBydW5uYWJsZSBhcyBwcmludGVkLCBoZWFkZWQgYnkgYGJ1biA8YXJndlsxXT5gIOKAlCBhbmQgZm9yIGFuIGluc3RhbGxlZFxuICogcGx1Z2luIGBhcmd2WzFdYCBpcyBpbnNpZGUgYSBWRVJTSU9ORUQgY2FjaGUgZGlyZWN0b3J5LiBBbiB1cGdyYWRlIG1hcmtzIHRoZVxuICogb2xkIGRpcmVjdG9yeSBvcnBoYW5lZCBhbmQgZGVsZXRlcyBpdCBsYXRlciAobWVhc3VyZWQgaW5cbiAqIGBkb2NzL2l0ZW1zL3RhaWwtcmVhcm0tY29tbWFuZC1uYW1lcy1hLXZlcnNpb25lZC1wbHVnaW4tcGF0aC5tZGApLFxuICogc28gYSBsaW5lIHByaW50ZWQgYmVmb3JlIGFuIHVwZ3JhZGUgZmlyc3QgcmFuIFNUQUxFIGNvZGUgYWdhaW5zdCBhIG5ld2VyXG4gKiBkYWVtb24sIHRoZW4gZmFpbGVkIHdpdGggXCJtb2R1bGUgbm90IGZvdW5kXCIgb25jZSB0aGUgZGlyZWN0b3J5IHdhcyBnb25lLiBOb1xuICogc3RhYmxlIHBhdGggZXhpc3RzIHRvIHByaW50IGluc3RlYWQ6IHRoZSBjYWNoZSwgYCRDTEFVREVfUExVR0lOX1JPT1RgIGFuZCB0aGVcbiAqIGluc3RhbGwgcmVjb3JkIGFyZSBhbGwgdmVyc2lvbmVkLlxuICogICBUaGUgc2tpbGwncyBsYXVuY2hlciBpcyBhbHdheXMgdGhlIHZlcnNpb24gdGhlIHNlc3Npb24gbG9hZGVkLiBDb2xlJ3NcbiAqIHJlYXNvbmluZzogdGhlIHdvcnN0IGNhc2UgaXMgdGhhdCB0aGUgQ0xJIGNoYW5nZWQgYW5kIHRoZSBhZ2VudCBnZXRzIGFuXG4gKiBlcnJvciDigJQgYW5kIGlmIHRoZSB0b29scyBhcmUgZGVzaWduZWQgcmlnaHQsIHRoYXQgZXJyb3Igc2F5cyB3aGF0IHdlbnRcbiAqIHdyb25nLiBTbyB0aGUgcGFyc2VycyBhcmUgdGhlIG90aGVyIGhhbGYgb2YgdGhpcyBydWxpbmc6IGByZWFkU2luY2VgIHJlZnVzZXNcbiAqIGFueSBgLS1zaW5jZWAgZm9ybSBhIHRhaWwgZG9lcyBub3QgYWNjZXB0IHdpdGggYSB1c2FnZSBlcnJvciBOQU1JTkcgdGhlXG4gKiBmb3JtcyBpdCBkb2VzLCB0aGUgc2FtZSB3YXkgb24gYWxsIGVpZ2h0IHRhaWxzLCBpbnN0ZWFkIG9mIG1pc3BhcnNpbmcgaXQuXG4gKiAgIE5vdCB0YWtlbjogcHJpbnRpbmcgdGhlIHBhdGggQU5EIHRoZSBhcmdzIChvcHRpb24gQSBvZiB0aGUgaXRlbSDigJQgdHdvXG4gKiBjb21tYW5kcyB3aGVyZSBvbmUgaXMgd3JvbmcgYWZ0ZXIgYW4gdXBncmFkZSk7IGEgbGF1bmNoZXIgdGhhdCBub3RpY2VzIGl0IGlzXG4gKiBvcnBoYW5lZCBhbmQgcmUtZXhlY3MgYSBuZXdlciBzaWJsaW5nIChCIOKAlCBpdCBsZWFucyBvbiBhIENsYXVkZSBDb2RlXG4gKiBpbnRlcm5hbCBtYXJrZXIgYW5kIGRvZXMgbm90aGluZyBvbmNlIHRoZSBkaXJlY3RvcnkgaXMgZGVsZXRlZCk7IHZlcnNpb25cbiAqIG5lZ290aWF0aW9uLlxuICpcbiAqIOKUgOKUgCBNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFMgKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L21pbmQtbWFwcGVyLXF1aWV0LWhhbmRvZmZgLiBJdCBSRVZFUlNFUyB0aGUgaW1wbGVtZW50ZXInc1xuICogcnVsaW5nIG9mIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdGhhdCBtaW5kLW1hcHBlciBpcyBhIHByZXNlbmNlIHNwZWxsXG4gKiAoaXRzIGRhZW1vbiBjb3VudHMgYW4gb3BlbiBTU0UgdGFpbCBhcyB0aGUgYWdlbnQgcHJlc2VudCwgc28gdGhlIHdpbmRvd1xuICogYWx3YXlzIHJlLWFybWVkIE1vbml0b3IpLiBDb2xlJ3MgcmVhc29uaW5nOiBtaW5kLW1hcHBlciBzZXNzaW9ucyBhcmUgdXNlZFxuICogbGlrZSBzY3JpcHRvcml1bSdzLCBidXJzdHMgb2YgYWN0aXZpdHkgd2l0aCBicmVha3MsIGFuZCBpbiBhIGJyZWFrIHRoZSBhZ2VudFxuICogc2hvdWxkIG5vdCBiZSB3b2tlbiBldmVyeSAzMCBtaW51dGVzLiBTbyBtaW5kLW1hcHBlciB0YWtlcyB0aGUgcXVpZXQgaGFuZG9mZlxuICogdG8gYC0tb25jZWAsIHRoZSBsb3N0IGNvbWUtYmFjayAoYG9wZW4gLS1uby1vcGVuYCksIGFuZCBrZWVwcyBpdHNcbiAqIGAtLXNpbmNlIE5AZXBvY2hgIGJvb2ttYXJrLiBUaHJlZSB0aGluZ3MgaGFkIHRvIGJlIHNldHRsZWQgdG8gbWFrZSB0aGF0XG4gKiBob25lc3QsIGVhY2ggcGlubmVkIGluIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC97dGFpbCxwcmVzZW5jZX0udGVzdC50c2BcbiAqIGFuZCBtdXRhdGlvbi1jb25maXJtZWQ6XG4gKlxuICogTTEgwrcgUFJFU0VOQ0UgTElOR0VSUyBBQ1JPU1MgVEhFIEdBUFMgKHRoZSBkYWVtb24sIGBzZXJ2ZXIudHNgXG4gKiAgICAgIGBhZGp1c3RBZ2VudHNgKS4gQSBvbmUtc2hvdCBob2xkcyBhbiBTU0UgY29ubmVjdGlvbiwgc28gaXQgQ09VTlRTIGFzXG4gKiAgICAgIHByZXNlbnQsIHdoaWNoIGlzIHRydWU6IHRoZSBhZ2VudCB3aWxsIHdha2Ugb24gdGhlIG5leHQgZXZlbnQuIFRoZSBnYXBzXG4gKiAgICAgIGFyZSB0aGUgcHJvYmxlbTogd2luZG93IOKGkiByZS1hcm0sIHF1aWV0IOKGkiBgLS1vbmNlYCwgYW5kIGFib3ZlIGFsbFxuICogICAgICBgdGFpbC53b2tlYCDihpIgdGhlIGFnZW50IGhhbmRsZXMgdGhlIGV2ZW50IOKGkiBNb25pdG9yLCB3aGljaCBsYXN0cyB0aGVcbiAqICAgICAgYWdlbnQncyB3aG9sZSB0dXJuLiBSYXcsIHRoZSBzdXJmYWNlJ3MgaGVhZGVyIGRvdCAodGhlIG9ubHkgdGhpbmdcbiAqICAgICAgcHJlc2VuY2UgZHJpdmVzIHRoZXJlLCBiZXNpZGVzIHRoZSBkYWVtb24ncyBhdXRvLWByZWNlaXZlZGAgZmxpcCBvbiBhXG4gKiAgICAgIGh1bWFuIG1lc3NhZ2UpIHJlYWQgXCJjb25uZWN0ZWQg4oCUIG5vIGFnZW50IG9uIHRoaXMgcHJvamVjdFwiIHdoaWxlIHRoZVxuICogICAgICBhZ2VudCB3YXMgd29ya2luZyB0aGUgYm9hcmQsIGFuZCBhIG1lc3NhZ2Ugc2VudCB0aGVuIGdvdCBub1xuICogICAgICBgcmVjZWl2ZWRgLiBUaGUgZGFlbW9uIGhhcyBubyBpZGxlIGNsb3NlLCBzbyBub3RoaW5nIGVsc2UgcmVhY3RzLiBOb3dcbiAqICAgICAgdGhlIGNvdW50IEhPTERTIGZvciBgTUlORF9NQVBQRVJfUFJFU0VOQ0VfTElOR0VSX01TYCAoMTUwIHMsIHRoZSBzdGFsbFxuICogICAgICB3aW5kb3cncyBiZWF0KSBhZnRlciB0aGUgbGFzdCB0YWlsIGNsb3NlczogYSB0YWlsIG9wZW5pbmcgaW5zaWRlIGl0XG4gKiAgICAgIGVtaXRzIG5vdGhpbmcsIGFuIGFnZW50LW9ubHkgd3JpdGUgKGAvYWN0aXZpdHlgLCBhbiBhZ2VudCBgL3NlbmRgKVxuICogICAgICByZXN0YXJ0cyBpdCwgYW5kIHNpbGVuY2UgcGFzdCBpdCBkcm9wcyB0aGUgY291bnQgdG8gMC5cbiAqICAgICAg4pqWIE5vdCB0YWtlbjogcmUtYXJtaW5nIE1vbml0b3IgQkVGT1JFIGhhbmRsaW5nIGEgd29rZW4gZXZlbnQgKHRoYXQgaXNcbiAqICAgICAgdGhlIHNoYXJlZCBydWxlLCB3b3JkLWZvci13b3JkIGluIGV2ZXJ5IHNwZWxsKTsgcmVmcmVzaGluZyBvbiBldmVyeVxuICogICAgICBib2FyZCB3cml0ZSAodGhlIGJyb3dzZXIgUE9TVHMgdGhlIHNhbWUgcm91dGVzLCBzbyB0aGUgaHVtYW4ncyBvd25cbiAqICAgICAgY2xpY2tzIHdvdWxkIGtlZXAgdGhlIGRvdCBsaXQpLiBDb3N0OiBhbiBhZ2VudCB0aGF0IHJlYWxseSBsZWZ0IHJlYWRzXG4gKiAgICAgIFwiaGVyZVwiIGZvciB1cCB0byAxNTAgcy5cbiAqIE0yIMK3IGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBOT1QgQ09VTlRFRCAobWluZC1tYXBwZXIncyBgY291bnRzYCkuIEl0IGlzIE9OXG4gKiAgICAgIFRIRSBMT0csIHdpdGggYW4gaWQsIGFuZCBhIHRhaWwncyBvd24gY29ubmVjdCBlbWl0cyBvbmUgb250byBpdHMgb3duXG4gKiAgICAgIHN0cmVhbSwgc28gY291bnRlZCBpdCBtYWRlIGV2ZXJ5IHdpbmRvdyBcImFjdGl2ZVwiIGFuZCB3b3VsZCB3YWtlIGV2ZXJ5XG4gKiAgICAgIGAtLW9uY2VgIG9uIGl0c2VsZi4gVGhlIGxpbmdlciByZW1vdmVzIG1vc3Qgb2YgdGhhdCBjaHVybjsgYGNvdW50c2BcbiAqICAgICAgcmVtb3ZlcyB0aGUgcmVzdCAoYSBmaXJzdCBhcm0sIGFub3RoZXIgYWdlbnQgY29taW5nIG9yIGdvaW5nKS5cbiAqIE0zIMK3IEEgREVBRCBEQUVNT04gSVMgTE9TVCwgTk9UIFVOUkVTT0xWRUQgKG1pbmQtbWFwcGVyJ3MgYHJlc29sdmVgKS4gSXRzXG4gKiAgICAgIGRpc2NvdmVyeSBwcm9iZXMgdGhlIGRhZW1vbidzIHBpZCwgc28gYSBraWxsZWQgZGFlbW9uIG1hZGUgYHJlc29sdmVgXG4gKiAgICAgIGFuc3dlciBudWxsIGFuZCBhbiB1bnJlc29sdmVkIHRhaWwgcmV0cmllcyBmb3JldmVyOiBhIGAtLW9uY2VgIHdvdWxkXG4gKiAgICAgIGhhdmUgc2xlcHQgZm9yIGdvb2QgKEQxJ3MgZGVmZWN0KS4gVGhlIHRhaWwga2VlcHMgdGhlIGxhc3QgVVJMIGl0XG4gKiAgICAgIHJlc29sdmVkLCBzbyB0aGUgZGVhZCBwb3J0IHJlZnVzZXMgYW5kIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBlbmRzIGl0XG4gKiAgICAgIHdpdGggYHRhaWwubG9zdGAg4oaSIGBvcGVuIC0tbm8tb3BlbmAsIHRoZW4gYSB0YWlsIHdpdGggbm8gYC0tc2luY2VgLlxuICogICAgICBNaW5kLW1hcHBlciBoYXMgbm8gc2Vzc2lvbiB0byBjbG9zZSwgc28gaXQgbmV2ZXIgcHJpbnRzIGB0YWlsLmNsb3NlZGAuXG4gKiAgICAgIE1lYXN1cmVkIG9uIGEgcmVhbCBga2lsbCAtOWAgdW5kZXIgYSBgLS1vbmNlYDogYHRhaWwubG9zdGAgNyBzIGxhdGVyLFxuICogICAgICBub3QgMC43NSBzLCBiZWNhdXNlIG1pbmQtbWFwcGVyJ3Mgb3duIGJhY2tvZmYgc3RhcnRzIGF0IDEgcyAoMSArIDIgKyA0KS5cbiAqICAgICAgTTHigJNNMyB3ZXJlIGRyaXZlbiBvbiBhIHJlYWwgZGFlbW9uIHdpdGggYSA0IHMgd2luZG93OiBhY3RpdmUg4oaSIHdpbmRvdyxcbiAqICAgICAgcXVpZXQg4oaSIGAtLW9uY2VgLCBhIGh1bWFuIG1lc3NhZ2Ugd29rZSBpdCwgYmFjayB0byBNb25pdG9yOyBwcmVzZW5jZVxuICogICAgICBuZXZlciBkcm9wcGVkIGFjcm9zcyB0aGUgZ2Fwcy5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBDT01QTEVURSBCVVQgRk9SIFRIRSBMQVVOQ0hFUjogcGlubmVkIHRvIHRoZVxuICogICBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGUgc2tpbGxzIG5hbWUgdGhlXG4gKiAgIHJ1bGUgb25jZSwgbGF1bmNoZXIgZm9ybSBpbmNsdWRlZDsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBUaGUgb25lIHNlbnRlbmNlIGV2ZXJ5IGB0YWlsYCdzIGhlbHAgY2Fycmllcywgc28gYSBodW1hbiB3YXRjaGluZyBpbiBhXG4gKiAgdGVybWluYWwgZmluZHMgdGhlIGVzY2FwZSBoYXRjaCB3aGVyZSB0aGV5IGxvb2sgKEQ0KS4gV29yZGVkIG9uY2UgaGVyZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfSEVMUCA9XG4gIFwiZW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyAzMC1taW51dGUgY2FwIHdpdGggYSBsaW5lIG5hbWluZyB0aGUgbmV4dCBhY3Q7IGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCBrZWVwcyBpdCBvcGVuIHdpdGggU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBcIjtcblxuLyoqIENvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3cgdGhhdCBtYWtlIHRoZSBkYWVtb24gXCJsb3N0XCIgKHNlZSBBMikuIFRocmVlXG4gKiAgc3BhbiBhYm91dCAwLjc1IHMgdW5kZXIgdGhlIGtpdCdzIGRlZmF1bHQgYmFja29mZiAoMjUwICsgNTAwIG1zIGJldHdlZW5cbiAqICB0aGVtKTogYSBsaXZlIGRhZW1vbiBuZXZlciByZWZ1c2VzIGl0cyBvd24gcG9ydCwgYW5kIHRoZSB0d28gZXh0cmEgYXR0ZW1wdHNcbiAqICBvbmx5IGJ1eSB0b2xlcmFuY2UgZm9yIGEgcmVzdGFydCB0aGF0IHJlYmluZHMgdGhlIHNhbWUgcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBMT1NUX0FGVEVSX1JFRlVTQUxTID0gMztcblxuLyoqIFRoZSB3aW5kb3cgbGVuZ3RoOiB0aGUgZW52IHZhbHVlIHdoZW4gaXQgaXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZWxzZSB0aGVcbiAqICBkZWZhdWx0LiBgMGAgbWVhbnMgbm8gd2luZG93LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXaW5kb3dNcyhyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcudHJpbSgpID09PSBcIlwiKSByZXR1cm4gREVGQVVMVF9XSU5ET1dfTVM7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIobikgJiYgbiA+PSAwID8gbiA6IERFRkFVTFRfV0lORE9XX01TO1xufVxuXG5leHBvcnQgdHlwZSBUYWlsTW9kZSA9IFwid2F0Y2hcIiB8IFwib25jZVwiO1xuXG4vKiogSG93IGEgdGFpbCBlbmRlZC4gYHdpbmRvd2AgaXMgb3VyIG93biBkZWFkbGluZSwgYGV2ZW50YCBpcyBhIGAtLW9uY2VgJ3NcbiAqICBmaXJzdCBmcmFtZSwgYGNsb3NlZGAgaXMgdGhlIHNlc3Npb24gZW5kaW5nIChhIGBjbG9zZWRgIGZyYW1lIG9yIHRoZSBwaW5uZWRcbiAqICBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcpLCBgbG9zdGAgaXMgdGhlIGRhZW1vbiByZWZ1c2luZyBjb25uZWN0aW9ucyxcbiAqICBhbmQgYHN0b3BwZWRgIGlzIGEgc2lnbmFsLCBhIGNhbGxlcidzIGFib3J0IG9yIGEgY2xvc2VkIHN0ZG91dC4gKi9cbmV4cG9ydCB0eXBlIFRhaWxFbmQgPSBcIndpbmRvd1wiIHwgXCJldmVudFwiIHwgXCJjbG9zZWRcIiB8IFwibG9zdFwiIHwgXCJzdG9wcGVkXCI7XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZJbnB1dCA9IHtcbiAgLyoqIFRoZSBzcGVsbCB3aG9zZSB0YWlsIHRoaXMgaXMsIHNvIHRoZSBhZ2VudCBrbm93cyB3aG9zZSBsYXVuY2hlciBydW5zIGl0LiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBlbmQ6IFRhaWxFbmQ7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogVGhlIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaC4gKi9cbiAgZXBvY2g/OiBzdHJpbmc7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiBgZXBvY2hgIGlzIHRoZVxuICAgKiAgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZTogYSBzcGVsbCB3aG9zZVxuICAgKiAgYC0tc2luY2VgIHBhcnNlcyBgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSBwcmludHMgaXQuICovXG4gIHRhaWw6IChvOiB7IHNpbmNlOiBudW1iZXI7IG9uY2U6IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIC8qKiBXaG9zZSBsYXVuY2hlciBydW5zIGBjb21tYW5kYC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZXZlbnRzOiBudW1iZXI7XG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogYG1vbml0b3JgOiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYC5cbiAgICogIGBiYWNrZ3JvdW5kYDogcnVuIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrLlxuICAgKiAgYHN0b3BgOiBub3RoaW5nIHRvIHdhdGNoOyBgY29tbWFuZGAgaXMgaG93IHRvIGNvbWUgYmFjaywgaWYgd2FudGVkLiAqL1xuICBuZXh0OiBcIm1vbml0b3JcIiB8IFwiYmFja2dyb3VuZFwiIHwgXCJzdG9wXCI7XG4gIC8qKiBUaGUgdmVyYiBhbmQgaXRzIGFyZ3VtZW50cyBPTkxZIOKAlCBubyBsYXVuY2hlciwgbm8gcGF0aC4gVGhlIGFnZW50IHJ1bnNcbiAgICogIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPmAuICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgaGludDogc3RyaW5nO1xufTtcblxuLyoqIEhvdyB0aGUgYWdlbnQgcnVucyBhIHByaW50ZWQgYGNvbW1hbmRgOiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIG5ldmVyIGEgcGF0aFxuICogIHRoaXMgcHJvY2VzcyBuYW1lcyAodGhlIHJ1bGluZyBvbiB0aGUgdmVyc2lvbmVkIHBsdWdpbiBwYXRoLCBpbiB0aGUgaGVhZGVyKS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fV0lUSF9MQVVOQ0hFUiA9IFwiYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5cIjtcblxuLyoqIFRoZSBjb21lLWJhY2sgaGludCwgd2l0aCBob3cgdG8gUkVTVU1FIGFmdGVyIGNvbWluZyBiYWNrIChEMik6IGEgcmVzdG9yZWRcbiAqICBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBtZWFucyBub3RoaW5nIHRoZXJlLiAqL1xuY29uc3QgQ09NRV9CQUNLID0gKHdoeTogc3RyaW5nKSA9PlxuICBgJHt3aHl9IFRvIGJyaW5nIGl0IGJhY2ssIHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfTsgdGhlbiBhcm0gdGhlIHRhaWwgYWdhaW4gd2l0aCBubyAtLXNpbmNlLCBvbiB0aGUgc2Vzc2lvbiBpZCBpdCBwcmludHMgd2hlcmUgdGhlcmUgaXMgb25lIChhIHJlc3RhcnRlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBkb2VzIG5vdCBhcHBseSlgO1xuXG4vKipcbiAqIFRIRSBERUNJU0lPTjogZ2l2ZW4gaG93IHRoZSB0YWlsIGVuZGVkLCB3aGljaCBsaW5lIGl0IHByaW50cy4gUHVyZSwgc28gZXZlcnlcbiAqIHN0YXRlIGlzIGEgbGl0ZXJhbCBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4gUmV0dXJucyBudWxsIGZvciBgc3RvcHBlZGA6XG4gKiBhIGh1bWFuJ3MgQ3RybC1DIG9yIGEgY2FsbGVyJ3MgYWJvcnQgaXMgbm90IGEgaGFuZG9mZi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhbmRvZmYoczogSGFuZG9mZklucHV0LCBjbWQ6IEhhbmRvZmZDb21tYW5kcyk6IEhhbmRvZmZMaW5lIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSB7IHNwZWxsOiBzLnNwZWxsLCBldmVudHM6IHMuZXZlbnRzLCBjdXJzb3I6IHMuY3Vyc29yIH07XG4gIHN3aXRjaCAocy5lbmQpIHtcbiAgICBjYXNlIFwic3RvcHBlZFwiOlxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgY2FzZSBcImNsb3NlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmNsb3NlZFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoe1xuICAgICAgICAgICAgc2luY2U6IHMuY3Vyc29yLFxuICAgICAgICAgICAgb25jZTogZmFsc2UsXG4gICAgICAgICAgICAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoaW50OiBgdGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYG5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9IGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2sgKHJ1bl9pbl9iYWNrZ3JvdW5kKSDigJQgaXQgZXhpdHMgb24gdGhlIG5leHQgZXZlbnRgLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQgYWZ0ZXIgdGhlIGFnZW50J3Mgb3duIGxhdW5jaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoZWxsUXVvdGUoYXJnOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bQS1aYS16MC05X0AlKz06LC4vLV0rJC8udGVzdChhcmcpID8gYXJnIDogYCcke2FyZy5yZXBsYWNlQWxsKFwiJ1wiLCBgJ1xcXFwnJ2ApfSdgO1xufVxuXG4vKipcbiAqIFJlYWQgYSBgLS1zaW5jZWAgdmFsdWU6IGFuIGV2ZW50IGlkLCBvcHRpb25hbGx5IGNhcnJ5aW5nIHRoZSBlcG9jaCBvZiB0aGVcbiAqIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgRDIpLiBOdWxsIHdoZW4gdGhlIGlkIGlzIG5vdCBhbiBpbnRlZ2VyLlxuICogRm9yIHRoZSBzcGVsbHMgd2hvc2UgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaDsgdGhlIHJlc3QgdGFrZSBhIHBsYWluIGlkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCb29rbWFyayh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGF0ID0gdG9rZW4uaW5kZXhPZihcIkBcIik7XG4gIGNvbnN0IGlkID0gYXQgPT09IC0xID8gdG9rZW4gOiB0b2tlbi5zbGljZSgwLCBhdCk7XG4gIGNvbnN0IGVwb2NoID0gYXQgPT09IC0xID8gXCJcIiA6IHRva2VuLnNsaWNlKGF0ICsgMSk7XG4gIGlmICghL14tP1xcZCskLy50ZXN0KGlkLnRyaW0oKSkpIHJldHVybiBudWxsO1xuICBpZiAoYXQgIT09IC0xICYmIGVwb2NoID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc2luY2U6IE51bWJlci5wYXJzZUludChpZCwgMTApLCAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSkgfTtcbn1cblxuLyoqXG4gKiBFdmVyeSB0YWlsJ3MgYC0tc2luY2VgLCByZWFkIHRoZSBzYW1lIHdheTogYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cywgb3IgYVxuICogcmVmdXNhbCB0aGF0IE5BTUVTIHRoZSBhY2NlcHRlZCBmb3Jtcy4g4puUIE5FVkVSIEEgU0lMRU5UIE1JU1BBUlNFLiBUaGUgZm91clxuICogbm8tZXBvY2ggc3BlbGxzIHVzZWQgYHBhcnNlSW50YCwgd2hpY2ggcmVhZCBhbiBlcG9jaCBib29rbWFyayAoYDRAZTFgLCBmcm9tXG4gKiBhIGhhbmRvZmYgbGluZSBhbm90aGVyIHZlcnNpb24gb3Igc3BlbGwgcHJpbnRlZCkgYXMgYDRgIGFuZCBkcm9wcGVkIHRoZVxuICogcmVzdCB3aXRob3V0IGEgd29yZDsgbWluZC1tYXBwZXIgcmVhZCBqdW5rIGFzIDAgYW5kIGFzdHJvbGFiZSBhcyAtMSwgYm90aCBhXG4gKiB3aG9sZSByZXBsYXkuIEEgcHJpbnRlZCBjb21tYW5kIG91dGxpdmVzIHRoZSBDTEkgdGhhdCBwcmludGVkIGl0ICh0aGVcbiAqIGxhdW5jaGVyLWZyZWUgcnVsaW5nLCBpbiB0aGUgaGVhZGVyKSwgc28gdGhlIHBhcnNlciBpcyB3aGVyZSBhbiBvbGRlciBvclxuICogbmV3ZXIgZm9ybSBtdXN0IHNheSB3aGF0IHdlbnQgd3JvbmcuXG4gKlxuICogYGVwb2NoYDogd2hldGhlciB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBvbmUgKHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUsXG4gKiBtaW5kLW1hcHBlcikuIGBtaW5gOiB0aGUgc21hbGxlc3QgaWQgYWNjZXB0ZWQgKGdyYXBldmluZSB0YWtlcyBubyAtMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkU2luY2UoXG4gIHRva2VuOiBzdHJpbmcsXG4gIG86IHsgZXBvY2g6IGJvb2xlYW47IG1pbj86IG51bWJlciB9LFxuKTogeyBvazogdHJ1ZTsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IHsgb2s6IGZhbHNlOyBtZXNzYWdlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1pbiA9IG8ubWluID8/IC0xO1xuICBjb25zdCBiID0gcGFyc2VCb29rbWFyayh0b2tlbik7XG4gIGlmIChiICE9PSBudWxsICYmIGIuc2luY2UgPj0gbWluICYmIChiLmVwb2NoID09PSB1bmRlZmluZWQgfHwgby5lcG9jaCkpXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNpbmNlOiBiLnNpbmNlLCAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSB9O1xuICBjb25zdCBpZCA9XG4gICAgbWluIDwgMFxuICAgICAgPyBcImFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyOyAtLXNpbmNlPS0xIGZvciBldmVyeXRoaW5nKVwiXG4gICAgICA6IGBhbiBldmVudCBpZCAoYW4gaW50ZWdlciwgJHttaW59IG9yIG1vcmUpYDtcbiAgY29uc3QgZm9ybXMgPSBvLmVwb2NoID8gYCR7aWR9LCBvciA8aWQ+QDxlcG9jaD4gYXMgYSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0YCA6IGlkO1xuICBjb25zdCB3aHkgPVxuICAgICFvLmVwb2NoICYmIHRva2VuLmluY2x1ZGVzKFwiQFwiKVxuICAgICAgPyBgOyB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBubyBlcG9jaCwgc28gcGFzcyB0aGUgaWQgd2l0aG91dCB0aGUgXCJA4oCmXCIgcGFydGBcbiAgICAgIDogXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgbWVzc2FnZTogYC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cyDigJQgZ2l2ZSAke2Zvcm1zfSR7d2h5fWAsXG4gIH07XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogVGhlIHJlLWFybSBmb3IgYSBzcGVsbCB3aG9zZSB0YWlsIGlzIGA8cHJlZml44oCmPiAtLXNpbmNlIE5bQGVwb2NoXSBbLS1vbmNlXWAuXG4gKiAgUGFzcyBgZXBvY2hgIG9ubHkgZm9yIGEgc3BlbGwgd2hvc2UgYC0tc2luY2VgIHBhcnNlcyBpdCAoYHBhcnNlQm9va21hcmtgKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChcbiAgcHJlZml4OiByZWFkb25seSBzdHJpbmdbXSxcbiAgc2luY2U6IG51bWJlcixcbiAgb25jZTogYm9vbGVhbixcbiAgZXBvY2g/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICAvLyDimqAgQSBuZWdhdGl2ZSBib29rbWFyayAobm90aGluZyBzZWVuIHlldCkgaXMgc3BlbGxlZCBgLS1zaW5jZT0tMWA6IHRoZVxuICAvLyBwYXJzZXJzIHJlYWQgYSBiYXJlIGAtMWAgYWZ0ZXIgYSBmbGFnIGFzIGFub3RoZXIgZmxhZyBhbmQgcmVmdXNlIGl0LlxuICBjb25zdCBtYXJrID0gZXBvY2ggPyBgJHtzaW5jZX1AJHtlcG9jaH1gIDogU3RyaW5nKHNpbmNlKTtcbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHttYXJrfWBdIDogW1wiLS1zaW5jZVwiLCBtYXJrXTtcbiAgcmV0dXJuIGNvbW1hbmRMaW5lKFsuLi5wcmVmaXgsIC4uLmF0LCAuLi4ob25jZSA/IFtcIi0tb25jZVwiXSA6IFtdKV0pO1xufVxuXG5leHBvcnQgdHlwZSBIYW5kb2ZmT3B0aW9uczxFdj4gPSB7XG4gIC8qKiBUaGUgc3BlbGwncyBuYW1lLCBjYXJyaWVkIG9uIHRoZSBsaW5lICh3aG9zZSBsYXVuY2hlciBydW5zIGl0KS4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgY29tbWFuZHM6IEhhbmRvZmZDb21tYW5kcztcbn07XG5cbi8qKlxuICogUnVuIGB0YWlsRXZlbnRzYCB3aXRoIHRoZSBoYW5kb2ZmOiB0aGUgd2luZG93LCBgLS1vbmNlYCwgdGhlIGxvc3QgcnVsZSwgYW5kXG4gKiB0aGUgZmluYWwgbGluZS4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLCBsaWtlIGB0YWlsRXZlbnRzYCwgYW5kIG5ldmVyIGV4aXRzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbFdpdGhIYW5kb2ZmPEV2PihcbiAgdGFpbDogVGFpbE9wdGlvbnM8RXY+LFxuICBoOiBIYW5kb2ZmT3B0aW9uczxFdj4sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSB0YWlsLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3Qgd2luZG93TXMgPSBoLndpbmRvd01zID8/IHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSk7XG4gIGNvbnN0IGNvdW50cyA9IGguY291bnRzID8/ICgoKSA9PiB0cnVlKTtcbiAgY29uc3QgZW5kT25Mb3N0ID0gIWgucHJlc2VuY2U7XG5cbiAgY29uc3QgYWMgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBhYy5hYm9ydCgpO1xuICB0YWlsLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAodGFpbC5zaWduYWw/LmFib3J0ZWQpIGFjLmFib3J0KCk7XG5cbiAgbGV0IGV2ZW50cyA9IDA7XG4gIGxldCBjdXJzb3IgPSB0YWlsLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZCA9IHRhaWwuc2luY2VFcG9jaDtcbiAgbGV0IGZyYW1lSGFzSWQgPSBmYWxzZTtcbiAgLyoqIEEzICsgRDM6IGEgZnJhbWUgY291bnRzLCBhbmQgd2FrZXMgYSBgLS1vbmNlYCwgb25seSB3aGVuIGl0IGlzIE9OIFRIRVxuICAgKiAgTE9HIOKAlCBpdCBjYXJyaWVzIGEgbG9nIGlkIOKAlCBhbmQgdGhlIHNwZWxsJ3Mgb3duIGBjb3VudHNgIGFncmVlcy4gQSB0YWInc1xuICAgKiAgaWQtbGVzcyBgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCBwaW5nIGlzIG5vdCBvbiB0aGUgbG9nLiAqL1xuICBjb25zdCBpc0xvZ0ZyYW1lID0gKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBmcmFtZUhhc0lkICYmIGNvdW50cyhldiwgZnJhbWUpO1xuICBsZXQgZW5kOiBUYWlsRW5kIHwgbnVsbCA9IG51bGw7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICAvLyBEMidzIG5ldC4gT24gZm9yIGV2ZXJ5IHNwZWxsOiBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3JcbiAgICAgIC8vIG1lYW5zIGEgd2hvbGUgcmVwbGF5IG9uIHRoZSBraXQncyBsb2csIGFuZCBvbiBncmFwZXZpbmUncyBkdXJhYmxlIGxvZ1xuICAgICAgLy8gaXQgaGFwcGVucyBvbmx5IHdoZW4gYC0tbGFzdGAgcmVhY2hlcyBiZWxvdyBgLS1zaW5jZWAsIHdoZXJlXG4gICAgICAvLyByZS1yZWFkaW5nIHRoZSBjdXJzb3IgZnJvbSB0aGUgZnJhbWVzIGlzIHRoZSBtb3JlIGNvcnJlY3QgYW5zd2VyLlxuICAgICAgcmVzdGFydE9uUmVwbGF5OiB0cnVlLFxuICAgICAgLy8gRDM6IHJlbWVtYmVyIHdoZXRoZXIgVEhJUyBmcmFtZSBjYXJyaWVzIGEgbG9nIGlkLiBgdGFpbEV2ZW50c2AgcmVhZHNcbiAgICAgIC8vIHRoZSBjdXJzb3Igb25jZSBwZXIgZnJhbWUsIGJlZm9yZSBgYWNjZXB0YCwgYHRlcm1pbmFsYCBhbmQgYHJlbmRlcmAuXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGNvbnN0IG4gPSB0YWlsLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICBmcmFtZUhhc0lkID0gdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pO1xuICAgICAgICByZXR1cm4gbjtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCB0aGF0IGdpdmVzIHVwIG9uIGZpbmRpbmcgaXRzIHNlc3Npb24gaXMgd2F0Y2hpbmcgYVxuICAgICAgICAvLyBzZXNzaW9uIHRoYXQgaXMgZ29uZSDigJQgd2hldGhlciB0aGlzIHByb2Nlc3MgZXZlciByZWFjaGVkIGl0IChpdHNcbiAgICAgICAgLy8gcG9pbnRlciB2YW5pc2hlZCkgb3IgaXQgd2FzIHJlLWFybWVkIGF0IG9uZSB0aGF0IGNsb3NlZCBpbiB0aGUgZ2FwLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgZW5kID09PSBudWxsKSBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSBldmVudHMgKz0gMTtcbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgdGVybWluYWw6IChldiwgZnJhbWUsIGFjY2VwdGVkKSA9PiB7XG4gICAgICAgIGlmICh0YWlsLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSAoaC5pc0Nsb3NlZCA/PyAoKCkgPT4gdHJ1ZSkpKGV2KSA/IFwiY2xvc2VkXCIgOiBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGgubW9kZSA9PT0gXCJvbmNlXCIgJiYgYWNjZXB0ZWQgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgcmV0dXJuIHRhaWwub25Db21tZW50Py4odGV4dCkgPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLm9uRGlzY29ubmVjdD8uKGluZm8pID8/IG51bGw7XG4gICAgICAgIGlmIChpbmZvLmNhdXNlID09PSBcImNvbm5lY3QtZmFpbGVkXCIpIHtcbiAgICAgICAgICByZWZ1c2FscyArPSAxO1xuICAgICAgICAgIGlmIChlbmRPbkxvc3QgJiYgcmVmdXNhbHMgPj0gTE9TVF9BRlRFUl9SRUZVU0FMUykgZmluaXNoKFwibG9zdFwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUaGUgZGFlbW9uIGFuc3dlcmVkIChhIHN0YXR1cywgb3IgYSBzdHJlYW0gdGhhdCBvcGVuZWQgYW5kIHRoZW5cbiAgICAgICAgICAvLyBlbmRlZCk6IGl0IGlzIGFsaXZlLCBzbyB0aGUgcmVmdXNhbHMgd2VyZSBub3QgaW4gYSByb3cuXG4gICAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIG9uRW5kOiAocykgPT4ge1xuICAgICAgICBjdXJzb3IgPSBzLmN1cnNvcjtcbiAgICAgICAgZXBvY2ggPSBzLmVwb2NoID8/IHVuZGVmaW5lZDtcbiAgICAgICAgdGFpbC5vbkVuZD8uKHMpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaW5lID0gaGFuZG9mZihcbiAgICAgIHtcbiAgICAgICAgZW5kOiBlbmQgPz8gXCJzdG9wcGVkXCIsXG4gICAgICAgIG1vZGU6IGgubW9kZSxcbiAgICAgICAgZXZlbnRzLFxuICAgICAgICBjdXJzb3IsXG4gICAgICAgIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgcHJlc2VuY2U6IGgucHJlc2VuY2UsXG4gICAgICAgIHNwZWxsOiBoLnNwZWxsLFxuICAgICAgfSxcbiAgICAgIGguY29tbWFuZHMsXG4gICAgKTtcbiAgICBpZiAobGluZSAhPT0gbnVsbCkgb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGxpbmUpfVxcbmApO1xuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0YWlsLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBHcmFwZXZpbmUncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIG9mIHRoZSBzcGVsbCwgYW5kIFRIRSBPTkUgUExBQ0UgVEhFIEVOViBJUyBSRUFELlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0sIEFORCBGT1IgR1JBUEVWSU5FIFRIRSBTRUFNIElTIFJFQUwg4oCUIHRoZSBmaXJzdCB0aW1lXG4gKiBpbiBmb3VyIHBvcnRzIChwbGF5Ym9vayBCOCwgZW50cnktYmxvY2sgcXVlc3Rpb24gMykuIEJlZm9yZSBQaGFzZSA2IHRoZVxuICogaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDMwMDBgIGluc2lkZSBgZGFlbW9uLnRzYCdzIFNTRSBzdHJlYW0sIGBpZGxlVGltZW91dDpcbiAqIDI1NWAgd2FzIGEgc2Vjb25kIGxpdGVyYWwgdGVuIGxpbmVzIGF3YXkgd2l0aCB0aGUgcmVsYXRpb25zaGlwIHdyaXR0ZW4gb25seSBpblxuICogcHJvc2UsIGFuZCBgY2xpLnRzYCdzIHRhaWwgaGFkIE5PIHdhdGNoZG9nIGF0IGFsbCDigJQgaXQgYmxvY2tlZCBvblxuICogYHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIHRoZSBraXQncyB3YXRjaGRvZyBleGlzdHMgdG9cbiAqIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uXG4gKiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHNcbiAqIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqIEEgdmFsdWUgdGhhdCBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBHUkFQRVZJTkUnUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgdGhlIHJ1bGUgYXN0cm9sYWJlIHBhaWQgZm9yOiBhIGhhcmQtY29kZWQgNDUgc1xuICogd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcyxcbiAqICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZVxuICogYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4g4pqgIEdyYXBldmluZSBpcyB0aGUgc3BlbGwgdGhhdFxuICogbWFrZXMgdGhlIHBvaW50IHNoYXJwZXN0OiBpdCBiZWF0cyBhdCAqKjMgcyoqLCBhIGZpZnRoIG9mIHRoZSBob3VzZSBkZWZhdWx0LFxuICogc28gYSBjb3BpZWQgNDUsMDAwIHdvdWxkIHRvbGVyYXRlIEZJRlRFRU4gbWlzc2VkIGJlYXRzIHdoZXJlIGV2ZXJ5IHNpYmxpbmdcbiAqIHRvbGVyYXRlcyB0aHJlZS4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBiZWF0IGl0XG4gKiBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDim5QgKipBTkQgXCJXSEFURVZFUiBUSEUgQkVBVCBCRUNPTUVTXCIgSVMgV0hZIFRIRSBFTlYgSVMgUkVTT0xWRUQgSEVSRSBBTkRcbiAqIE5PV0hFUkUgRUxTRSAoRDc1KS4gVEhFIFBPUlQgUkUtQ1JFQVRFRCBBU1RST0xBQkUnUyBERUZFQ1QgSU4gVEhJUyBGSUxFLioqXG4gKiBDaGFwdGVyIDIgc2hpcHBlZCBgSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMocHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hFQVJUQkVBVF9NUyxcbiAqIOKApilgIGF0IGBkYWVtb24udHM6MTEyYCB3aGlsZSB0aGlzIGZpbGUga2VwdCBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWBcbiAqIGFnYWluc3QgdGhlIExJVEVSQUwgMywwMDA6IHRoZSBkYWVtb24ncyBiZWF0IHdhcyB0dW5hYmxlIGFuZCB0aGUgQ0xJJ3NcbiAqIHdhdGNoZG9nIHdhcyBub3QsIHNvICoqYW55IHZhbHVlIGFib3ZlIDMsMDAwIGJyb2tlIGV2ZXJ5IHRhaWwuKiogTUVBU1VSRUQgYXRcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTIwMDAwYCBhZ2FpbnN0IGEgaGVhbHRoeSBkYWVtb24sIGJlZm9yZSB0aGUgcmVwYWlyOiBhXG4gKiByZWFsIGBjbGkudHMgdGFpbGAgcmUtc3Vic2NyaWJlZCAqKjQgdGltZXMgaW4gMzAgcyoqICh+OSBzIGFwYXJ0LCBpdHMgd2F0Y2hkb2dcbiAqIGZpcmluZyBiZWZvcmUgYSBzaW5nbGUgMjAgcyBiZWF0IGNvdWxkIGxhbmQg4oCUICoqMCBrZWVwYWxpdmVzIGFycml2ZWQqKiksIGFuZFxuICogYC9jaGFubmVscy93ZC9zdWJzY3JpYmVyc2AgcmVwb3J0ZWQgYGNvdW50OiAyLCBjb25uZWN0aW9uczogMiwgbmFtZWQ6IDJgIGZvclxuICogKipvbmUqKiBsaXZlIHRhaWwsIGJlY2F1c2UgdGhlIGFiYW5kb25lZCBzdHJlYW1zIGFyZSBub3QgcmVhcGVkIHVudGlsIHRoZVxuICogbm93LTIwIHMgYmVhdCBmYWlscyB0byBlbnF1ZXVlLiBUaGF0IGlzIHRoZSBhc3Ryb2xhYmUgc2NhciB0d28gcGFyYWdyYXBocyB1cCxcbiAqIHJlLWNyZWF0ZWQgaW5zaWRlIHRoZSBmaWxlIHRoYXQgZG9jdW1lbnRzIGl0LiAqKk9uZSBoYWxmIG9mIHRoZSBwYWlyIHR1bmFibGVcbiAqIGFuZCB0aGUgb3RoZXIgYSBjb25zdGFudCBJUyB0aGUgZGVmZWN0Kiog4oCUIHRoZSBkZXJpdmF0aW9uIG9ubHkgaG9sZHMgaWYgaXRcbiAqIGRlcml2ZXMgZnJvbSB0aGUgdmFsdWUgdGhhdCBhY3R1YWxseSBzaGlwcGVkLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqIGBwcm9jZXNzLmVudmAgaXMgbm90IHN1Y2ggYW4gaW1wb3J0OiBpdCBpcyBhbWJpZW50IGluIGJvdGggaGFsdmVzLCB3aGljaCBpc1xuICogZXhhY3RseSB3aHkgdGhpcyBmaWxlIOKAlCBhbmQgbm90IGBkYWVtb24udHNgIOKAlCBjYW4gaG9sZCB0aGUgcmVzb2x1dGlvbi4gKFRoaXNcbiAqIGlzIGJvdW50eSdzIHNoYXBlLCB1bmNoYW5nZWQ6IGBzcmMvYm91bnR5L2JhY2tlbmQvaGVhcnRiZWF0LnRzYCByZXNvbHZlc1xuICogYEJPVU5UWV9JRExFX1RJTUVPVVRfU0VDYCBhbmQgYEJPVU5UWV9IRUFSVEJFQVRfTVNgIGluIHRoZSBzZWFtIGZpbGUgZm9yIHRoZVxuICogc2FtZSByZWFzb24uKVxuICovXG5cbmltcG9ydCB7XG4gIGhlYXJ0YmVhdE1zLFxuICBpZGxlVGltZW91dFNlYyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtLCBpbiBzZWNvbmRzLiBHcmFwZXZpbmUncyBvd24gbWVhc3VyZWQgdmFsdWUsIG5vdCBhbiBpbmhlcml0ZWRcbiAqIG9uZTogYGRhZW1vbi50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50IHJlY29yZGluZyB0aGF0XG4gKiBCdW4ncyBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhc1xuICogc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcyDigJQgYW5kIHRoYXQgYDBgIGlzIG5vdCBcImRpc2FibGVkXCIsIGl0IGlzIHRoZVxuICogZGVmYXVsdC5cbiAqXG4gKiDimqAgYEdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDYCBpcyBhY2NlcHRlZCBzbyB0aGUgUEFJUiBjYW4gYmUgdHVuZWQgdG9nZXRoZXIsXG4gKiBhbmQgdGhlIGNsYW1wIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuIChUaGlzIGZpbGUgdXNlZCB0byBzYXlcbiAqIGdyYXBldmluZSBcImRvZXMgbm90IGVudi10dW5lIGl0XCIgd2hpbGUgYGRhZW1vbi50c2AgZW52LXR1bmVkIGl0IHRlbiBsaW5lcyBmcm9tXG4gKiB3aGVyZSBpdCBpbXBvcnRlZCB0aGlzIGNvbnN0YW50IOKAlCB0aGUgc2FtZSBvbmUtaGFsZi10dW5hYmxlIHNwbGl0IGFzIHRoZSBiZWF0LFxuICogYW5kIGNvcnJlY3RlZCBpbiB0aGUgc2FtZSBjaGFwdGVyLilcbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBpZGxlVGltZW91dFNlYyhcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqXG4gKiBUaGUgU1NFIGtlZXBhbGl2ZSwgaW4gbXMg4oCUIHRoZSBERUZBVUxULCBiZWZvcmUgdGhlIGVudiBpcyBjb25zdWx0ZWQuXG4gKiDimqAgKiozIHMsIGFuZCBpdCBpcyBOT1QgdGhlIGhvdXNlIGRlZmF1bHQgb2YgMTUgcyoqIOKAlCBncmFwZXZpbmUgaXMgdGhlIG9ubHlcbiAqIHNwZWxsIGluIHRoZSByb3N0ZXIgdGhhdCBiZWF0cyB0aGlzIGZhc3QsIGFuZCB0aGUgbnVtYmVyIGlzIGxvYWQtYmVhcmluZ1xuICogcmF0aGVyIHRoYW4gaW5jaWRlbnRhbDogdGhlIGJlYXQgaXMgYWxzbyBncmFwZXZpbmUncyBkZWFkLXN1YnNjcmliZXIgcHJvYmUuIEFcbiAqIHRhaWwgd2hvc2Ugc29ja2V0IGhhcyBnb25lIGF3YXkgaXMgZGlzY292ZXJlZCB3aGVuIHRoZSBlbnF1ZXVlIGZhaWxzLCBhbmRcbiAqIHVudGlsIGl0IGlzIGRpc2NvdmVyZWQgYHdob2AsIGAvcHJlc2VuY2VgIGFuZCBldmVyeSBzZW5kJ3MgcmVjaXBpZW50IGNvdW50XG4gKiByZXBvcnQgYSBnaG9zdC4gRXZlcnkgb3RoZXIgc3BlbGwncyBoZWFydGJlYXQgb25seSBoYXMgdG8ga2VlcCBhIGNvbm5lY3Rpb25cbiAqIG9wZW47IHRoaXMgb25lIGFsc28gaGFzIHRvIGtlZXAgYSBST1NURVIgaG9uZXN0LCB3aGljaCBpcyBhIGh1bWFuLXZpc2libGVcbiAqIG51bWJlciBpbiB0aGUgd2F0Y2ggc3VyZmFjZS4g4puUICoqU28gcmFpc2luZyB0aGlzIGtub2IgbWFrZXMgcHJlc2VuY2VcbiAqIHN0YWxlciwgbm90IGp1c3QgcXVpZXRlcioqIOKAlCBpdCBpcyB0aGUgb25lIHRoaW5nIGFuIG9wZXJhdG9yIHR1bmluZyBpdCBzaG91bGRcbiAqIGtub3cuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMgPSAzXzAwMDtcblxuLyoqXG4gKiBUaGUgYmVhdCBhcyBpdCB3aWxsIGFjdHVhbGx5IGJlIHVzZWQsIGVudi1yZXNvbHZlZCBhbmQgY2xhbXBlZCBhdCBib3RoIGVuZHMgYnlcbiAqIHRoZSBraXQ6IG5ldmVyIGFib3ZlIGBJRExFX1RJTUVPVVRfU0VDIC8gMmAgKG9yIEJ1biBjbG9zZXMgdGhlIGNvbm5lY3Rpb24gdGhlXG4gKiBrZWVwYWxpdmUgd2FzIHByZXNlcnZpbmcpLCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICog4puUIFRIRSBGTE9PUiBJUyBOT1QgREVDT1JBVElPTiAoRDc2KS4gYGludE9yYCBwYXJzZXMgd2l0aCBgcGFyc2VJbnRgLCB3aGljaFxuICogcmVhZHMgYFwiMWU5XCJgIOKAlCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0IGh1Z2VcIiDigJQgYXMgKioxKiouXG4gKiBEcml2ZW4gYmVmb3JlIHRoZSBmbG9vciBleGlzdGVkOiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4XG4gKiBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRSBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAg4oaSIDMgbXMgYW5kXG4gKiBgXCI1YWJjXCJgIOKGkiA1IG1zIGFycml2ZSB0aGUgc2FtZSB3YXkuIFRoZSBmbG9vciBsaXZlcyBpbiB0aGUga2l0J3NcbiAqIGBoZWFydGJlYXRNc2AgYmVzaWRlIHRoZSBjZWlsaW5nIGl0IGNhbm5vdCBjcm9zcywgTk9UIGluIGBpbnRPcmAsIHdoaWNoIGV2ZXJ5XG4gKiBvdGhlciBrbm9iIGluIHRoZSBob3VzZSBzaGFyZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC4gOSwwMDAgbXMgYXQgdGhlIGRlZmF1bHQuXG4gKlxuICog4puUICoqVEhFIFRBSUwgSEFEIE5PIFdBVENIRE9HIEFUIEFMTCBCRUZPUkUgVEhJUy4qKiBgY21kVGFpbGAncyBpbm5lciBsb29wXG4gKiBhd2FpdGVkIGByZWFkZXIucmVhZCgpYCB3aXRoIG5vdGhpbmcgYm91bmRpbmcgaXQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlclxuICogbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYSBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSIOKAlCBhbmRcbiAqIGEgcGFya2VkIHRhaWwgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHF1aWV0IGNoYW5uZWwsIHdoaWNoIGlzIHRoZSBzdGF0ZVxuICogZ3JhcGV2aW5lJ3MgY2FsbGVycyBzcGVuZCBtb3N0IG9mIHRoZWlyIHRpbWUgaW4uXG4gKlxuICog4pqgIDkgcyBpcyBhZ2dyZXNzaXZlIGJ5IGhvdXNlIHN0YW5kYXJkcyAoNDUgcyBldmVyeXdoZXJlIGVsc2UpIGFuZCB0aGF0IGlzIHRoZVxuICogZGVyaXZhdGlvbiB3b3JraW5nLCBub3QgYSBtaXN0YWtlOiBpdCBpcyB0aHJlZSBvZiBUSElTIHNwZWxsJ3MgYmVhdHMuIEhvbGRpbmdcbiAqIHRoZSBjb25uZWN0aW9uIG9wZW4gSVMgYSB0YWlsJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzXG4gKiBhIG5hbWUgaW4gYSBodW1hbidzIHJvc3RlciDigJQgd2hpY2ggaXMgd2h5IGl0IGlzIHRocmVlIGJlYXRzIGFuZCBub3QgdHdvLlxuICpcbiAqIOKblCBERVJJVkVEIEZST00gVEhFIFJFU09MVkVEIEJFQVQsIE5FVkVSIEZST00gVEhFIERFRkFVTFQuIEl0IGlzXG4gKiBgU1NFX0hFQVJUQkVBVF9NU2AgYWJvdmUgYW5kIG5vdCBgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TYCBvbiBwdXJwb3NlOyB0aGVcbiAqIHJlcGFpciBjaGFwdGVyIGlzIHdoYXQgdGhlIGRpZmZlcmVuY2UgY29zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMo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QUEsTUFDZixNQUFNLFVBQVU7QUFBQTtBQUFBLEVBRXBCO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLE9BQU87QUFBQSxJQUNmLGFBQWEsQ0FBQztBQUFBLElBQ2QsS0FBSyxDQUFDLGFBQWEsVUFBVTtBQUFBLE1BUTNCLElBQUksbUJBQW1CO0FBQUEsUUFDckIsS0FBSSx5REFBb0QsVUFBVTtBQUFBLE1BQ3BFLElBQUksTUFBTSxVQUFVO0FBQUEsUUFBTSxRQUFRLE9BQU8sTUFBTSxjQUFjO0FBQUEsQ0FBa0I7QUFBQSxNQUMxRTtBQUFBLG1CQUFVLEVBQUUsTUFBTSxhQUFhLFNBQVMsZUFBZSxDQUFDO0FBQUE7QUFBQSxFQUVqRTtBQUNGO0FBSUEsSUFBTSxZQUNKO0FBSUYsSUFBTSxLQUNKLENBQUMsTUFDRCxDQUFDLFFBQ0MsRUFBRSxJQUFJLEtBQUssSUFBSSxLQUFjO0FBNEIxQixJQUFNLE1BQU0sVUFBVTtBQUFBLEVBQzNCLE1BQU07QUFBQSxFQUNOLFNBQVM7QUFBQSxFQUNULFVBQVUsS0FBSyxJQUFJLENBQUMsT0FBTztBQUFBLE9BQ3RCO0FBQUEsSUFDSCxVQUFVO0FBQUEsSUFDVixLQUFLLEdBQUcsRUFBRSxHQUFHO0FBQUEsT0FDVCxFQUFFLFNBQVMsVUFBVSxFQUFFLFNBQVMsYUFBYSxFQUFFLFlBQVksVUFBVSxJQUFJLENBQUM7QUFBQSxFQUNoRixFQUFFO0FBQUEsRUFFRixhQUFhO0FBQUEsRUFFYixTQUFTLE9BQU8sRUFBRSxNQUFNLGFBQWEsU0FBUyxrQkFBa0IsVUFBVTtBQUFBLEVBQzFFLE1BQU07QUFDUixDQUFDO0FBRUQsU0FBUyxRQUFRLEdBQVc7QUFBQSxFQUMxQixPQUFPO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsd0NBVStCO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBd0R4QyxlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxJQUFJLFNBQVMsSUFBSTtBQUFBLElBQzlCLE9BQU8sR0FBRztBQUFBLElBQ1YsTUFBTSxPQUFPLGVBQWUsQ0FBQztBQUFBLElBQzdCLElBQUksU0FBUztBQUFBLE1BQU0sT0FBTztBQUFBLElBQzFCLE1BQU07QUFBQTtBQUFBO0FBZVYsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiOTNDMjhBNDc2N0NEMUYyQTY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
