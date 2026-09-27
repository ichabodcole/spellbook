// @bun
// src/scriptorium/backend/cli.ts
import { spawn } from "child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";

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
    const choices = flagsFor(row.name);
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
function tailCommand(prefix, since, once, epoch) {
  const mark = epoch ? `${since}@${epoch}` : String(since);
  const at = since < 0 ? [`--since=${mark}`] : ["--since", mark];
  return commandLine([...prefix, ...at, ...once ? ["--once"] : []]);
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
var DEFAULT_HEARTBEAT_MS = 15000;
var MISSED_BEATS = 3;
function tailIdleMs(beatMs) {
  return beatMs * MISSED_BEATS;
}

// src/scriptorium/backend/heartbeat.ts
var SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/scriptorium/backend/tree.ts
var DOC_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];
function isDocName(name) {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
var SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "coverage"]);

// src/scriptorium/backend/cli.ts
function daemonRefused(what, status, data) {
  const kind = status === 400 ? "usage" : status === 404 ? "not_found" : status === 409 ? "conflict" : "internal";
  const body = data ?? {};
  const choices = Array.isArray(body.choices) ? body.choices.map(String) : undefined;
  const hint = typeof body.hint === "string" ? body.hint : undefined;
  die(typeof body.error === "string" ? body.error : `${what} failed (HTTP ${status})`, kind, {
    ...hint ? { hint } : {},
    ...choices ? { choices } : {},
    ...data !== null && data !== undefined ? { server: data } : {}
  });
}
var SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "scriptorium");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
function scriptoriumHome() {
  return resolve(process.env.SCRIPTORIUM_HOME ?? join(homedir(), ".scriptorium"));
}
function restorable() {
  const dir = join(scriptoriumHome(), "sessions");
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "manifest.json"))).map((e) => ({ id: e.name, at: statSync(join(dir, e.name, "manifest.json")).mtimeMs })).sort((a, b) => b.at - a.at).map((e) => e.id);
  } catch {
    return [];
  }
}
function noSessionHint() {
  const ids = restorable();
  const newest = ids[0];
  if (newest === undefined)
    return { hint: "no session has been opened in this home yet \u2014 run: cli.ts open <path>" };
  return {
    hint: `no daemon is running, but the work is on disk \u2014 bring it back with: cli.ts open --restore ${newest}`,
    choices: ids.slice(0, 10)
  };
}
function sessionFilePath(session) {
  return join(tmpdir(), session ? `scriptorium-${session}.json` : "scriptorium-latest.json");
}
function readSession(session) {
  const path = sessionFilePath(session);
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = e.code;
    if (code === "ENOENT")
      return null;
    die(`cannot read the session pointer (${code ?? "unknown error"}): ${path}`, "internal");
  }
  try {
    return JSON.parse(raw);
  } catch {
    die(`the session pointer is not valid JSON: ${path}`, "internal");
  }
}
function requireSession(session) {
  const s = readSession(session);
  if (!s)
    die("no running scriptorium session", "not_found", noSessionHint());
  return s;
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
async function postCmd(session, msg) {
  const s = requireSession(session);
  let status;
  let data;
  try {
    ({ status, data } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    if (msg.type === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET")))
      return { ok: true };
    throw err;
  }
  if (status !== 200)
    daemonRefused(String(msg.type), status, data);
  return data;
}
var CLI_OPTIONS = {
  "body-file": { type: "string" },
  by: { type: "string" },
  context: { type: "string" },
  doc: { type: "string" },
  entry: { type: "string" },
  for: { type: "string" },
  from: { type: "string" },
  full: { type: "boolean" },
  quote: { type: "string" },
  reopen: { type: "boolean" },
  hunks: { type: "string" },
  into: { type: "string" },
  lifecycle: { type: "string" },
  limit: { type: "string" },
  label: { type: "string" },
  "no-open": { type: "boolean" },
  once: { type: "boolean" },
  patch: { type: "boolean" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  "start-timeout": { type: "string" },
  status: { type: "string" },
  stdin: { type: "boolean" },
  tag: { type: "string" },
  timeout: { type: "string" },
  type: { type: "string" }
};

class UsageError extends CliError {
  constructor(message, extra) {
    super("usage", message, extra);
  }
}
function parseTailSince(token) {
  const r = readSince(token, { epoch: true });
  if (!r.ok)
    die(r.message, "usage");
  return r.epoch ? { since: r.since, epoch: r.epoch } : { since: r.since };
}
function parseSinceDate(token) {
  const t = token.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t)))
    die(`find --since: "${token}" is not a date \u2014 write it as YYYY-MM-DD`, "usage");
  return t;
}
function parseVersion(token, what) {
  const m = /^v?(\d+)$/.exec(token.trim());
  if (!m || Number(m[1]) < 1)
    die(`${what}: "${token}" is not a version \u2014 write v1, v2, \u2026`, "usage", {
      hint: "run: cli.ts state (each doc lists its versions)"
    });
  return Number(m[1]);
}
function parseCount(token, what) {
  const t = token.trim();
  if (!/^\d+$/.test(t))
    die(`${what}: "${token}" is not a whole number`, "usage");
  return Number(t);
}
function parseSide(token, what) {
  const t = token.trim().toLowerCase();
  if (t === "original" || t === "file" || t === "saved")
    return "original";
  return parseVersion(token, what);
}
function contextPaths(pos) {
  const paths = pos.map((p) => resolve(p));
  for (const p of paths) {
    let st;
    try {
      st = statSync(p);
    } catch {
      die(`no such file or folder: ${p}`, "not_found");
    }
    if (!st.isDirectory() && !isDocName(p))
      die(`not a document scriptorium opens: ${p}`, "usage", {
        hint: "add a folder, or a file with one of these extensions",
        choices: [...DOC_EXTENSIONS]
      });
  }
  return paths;
}
function docArg(token) {
  if (token.includes("/") || existsSync(resolve(token)))
    return resolve(token);
  return token;
}
var LOG_KEEP = 10;
function pruneLogs(logDir) {
  let names = [];
  try {
    names = readdirSync(logDir).filter((n) => /^daemon-\d+-\d+\.log$/.test(n));
  } catch {
    return;
  }
  const byAge = names.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  for (const n of byAge.slice(0, Math.max(0, byAge.length - (LOG_KEEP - 1)))) {
    try {
      unlinkSync(join(logDir, n));
    } catch {}
  }
}
async function cmdOpen(pos, flags) {
  const paths = contextPaths(pos);
  if (typeof flags.restore === "string") {
    const home = scriptoriumHome();
    const manifest = join(home, "sessions", flags.restore, "manifest.json");
    if (!existsSync(manifest)) {
      let saved = [];
      try {
        saved = (await Array.fromAsync(new Bun.Glob("*/manifest.json").scan(join(home, "sessions")))).map((p) => p.split("/")[0]);
      } catch {}
      die(`no saved session "${flags.restore}" under ${home}`, "not_found", {
        choices: saved.sort(),
        ...saved.length === 0 ? { hint: "no saved sessions in this home" } : {}
      });
    }
    const live = readSession(flags.restore);
    if (live) {
      const alive = await api(live.port, "GET", "/state").then((r) => r.status === 200, () => false);
      if (alive)
        die(`session ${flags.restore} is already running at ${live.url}`, "conflict", {
          hint: `use it: cli.ts state --session ${flags.restore}`
        });
    }
  }
  const daemonArgs = ["run", SERVER_SCRIPT];
  if (typeof flags.timeout === "string")
    daemonArgs.push("--timeout", flags.timeout);
  if (typeof flags.restore === "string")
    daemonArgs.push("--restore", flags.restore);
  else
    daemonArgs.push("--workspace", process.cwd());
  const cwd = daemonCwd();
  if (!existsSync(cwd))
    die(`scriptorium cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}`, "internal", {
      hint: "dev mode was resolved (no dist/index.html and no SPELLBOOK_SURFACE_MODE=release), which needs src/scriptorium/ \u2014 reinstall the spell or build it"
    });
  const logDir = join(scriptoriumHome(), "logs");
  mkdirSync(logDir, { recursive: true });
  pruneLogs(logDir);
  const logPath = join(logDir, `daemon-${Date.now()}-${process.pid}.log`);
  daemonArgs.push("--log", logPath);
  const logFd = openSync(logPath, "a");
  const child = spawn("bun", daemonArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", logFd],
    env: process.env
  });
  closeSync(logFd);
  child.unref();
  const startTimeoutMs = typeof flags["start-timeout"] === "string" ? Math.max(5000, Number.parseInt(flags["start-timeout"], 10) * 1000) : 45000;
  const line = await new Promise((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => rej(new Error(`daemon start timeout (${startTimeoutMs / 1000}s) \u2014 pass --start-timeout <seconds>`)), startTimeoutMs);
    child.stdout?.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf(`
`);
      if (nl >= 0) {
        clearTimeout(timer);
        res(buf.slice(0, nl).trim());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rej(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`daemon exited with code ${code} before its handshake`));
    });
  }).catch((err) => {
    let tail = "";
    try {
      tail = readFileSync(logPath, "utf8").trim().slice(-800);
    } catch {}
    die(`scriptorium daemon failed to start: ${err instanceof Error ? err.message : String(err)}`, "internal", { hint: tail ? `daemon log (${logPath}): ${tail}` : `daemon log: ${logPath}` });
  });
  const out = child.stdout;
  if (!out || !("unref" in out) || typeof out.unref !== "function")
    throw new Error("scriptorium: the daemon's stdout pipe has no unref(); `open` would never exit");
  out.unref();
  let hs;
  try {
    hs = JSON.parse(line);
  } catch {
    die(`unexpected output from daemon: ${line}`, "internal");
  }
  if (hs.ok === false)
    daemonRefused("open", hs.status ?? 500, hs);
  let entries = [];
  if (paths.length > 0) {
    const r = await postCmd(hs.session_id, { type: "context.add", paths });
    entries = r.entries ?? [];
  }
  printJson({ ...hs, ...paths.length > 0 ? { entries } : {} });
  if (!flags["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [hs.url], { detached: true, stdio: "ignore" }).unref();
  }
}
async function cmdAdd(pos, session) {
  const paths = contextPaths(pos);
  printJson(await postCmd(session, { type: "context.add", paths }));
}
async function cmdState(session, full) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "?full=1" : ""}`);
  if (status !== 200)
    daemonRefused("state", status, data);
  printJson(data);
}
async function readSayBody(pos, flags) {
  const sources = [
    pos.length > 0,
    flags.stdin === true,
    typeof flags["body-file"] === "string"
  ].filter(Boolean).length;
  if (sources !== 1)
    die(sources === 0 ? "say needs a message" : "say takes its message from exactly one place: arguments, --stdin or --body-file", "usage", {
      hint: "give the text as arguments, or prose through --body-file <path> / --stdin (never an unquoted heredoc)",
      choices: ["--stdin", "--body-file"]
    });
  let text;
  if (flags.stdin === true)
    text = await new Response(Bun.stdin.stream()).text();
  else if (typeof flags["body-file"] === "string")
    text = readFileSync(flags["body-file"], "utf8");
  else
    text = pos.join(" ");
  if (!text.trim())
    die("say: the message is empty", "usage");
  return text.trim();
}
var disconnected = false;
async function cmdTail(session, since, o) {
  let boundId = session;
  const reArm = session !== undefined || o.sinceGiven;
  let grounded = o.sinceGiven;
  const pin = () => boundId !== undefined ? ["--session", boundId] : [];
  return await tailWithHandoff({
    resolve: () => {
      const s = readSession(boundId);
      if (!s)
        return null;
      if (!boundId)
        boundId = s.session_id;
      if (!grounded) {
        grounded = true;
        process.stdout.write(`${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}
`);
      }
      return `http://127.0.0.1:${s.port}`;
    },
    onUnresolved: ({ everResolved }) => {
      if (everResolved || reArm)
        return "stop";
      process.stderr.write(`# no session yet, retrying\u2026
`);
      return "retry";
    },
    path: "/events",
    since,
    ...o.epoch ? { sinceEpoch: o.epoch } : {},
    cursorOf: (ev) => typeof ev.id === "number" ? ev.id : undefined,
    epochOf: (ev) => typeof ev.epoch === "string" ? ev.epoch : undefined,
    onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
    terminal: (ev) => ev.type === "closed",
    idleMs: TAIL_IDLE_MS,
    onComment: () => {
      if (!disconnected)
        return ": scriptorium-keepalive";
      disconnected = false;
      return JSON.stringify({ type: "tail.reconnected" });
    },
    onDisconnect: ({ cause, status }) => {
      if (disconnected)
        return null;
      disconnected = true;
      return JSON.stringify({
        type: "tail.disconnected",
        cause,
        ...status !== undefined ? { status } : {},
        note: "retrying; the session may have closed or crashed"
      });
    }
  }, {
    spell: "scriptorium",
    mode: o.once ? "once" : "watch",
    presence: false,
    commands: {
      tail: ({ since: at, once, epoch }) => tailCommand(["tail", ...pin()], at, once, epoch),
      comeBack: () => commandLine(["open", "--restore", boundId ?? "<id>", "--no-open"])
    }
  });
}
function versionInfo() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "scriptorium", version: pkg.version };
  } catch {}
  return { name: "scriptorium", version: "unknown" };
}
async function structureCmd(session, op) {
  printJson(await postCmd(session, op));
}
async function cmdImport(file, into, session) {
  const abs = resolve(file);
  let st;
  try {
    st = statSync(abs);
  } catch {
    die(`no such file: ${abs}`, "not_found");
  }
  if (!st.isFile() || !isDocName(abs))
    die(`not a document scriptorium opens: ${abs}`, "usage", { choices: [...DOC_EXTENSIONS] });
  await structureCmd(session, {
    type: "import",
    name: abs.split("/").pop(),
    text: readFileSync(abs, "utf8"),
    ...into !== undefined ? { into: resolve(into) } : {}
  });
}
async function cmdWorkspace(dir, session) {
  if (dir !== undefined)
    return structureCmd(session, { type: "workspace.set", path: resolve(dir) });
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    daemonRefused("workspace", status, data);
  printJson({ workspace: data.workspace });
}
var on = (h) => (inv) => {
  const flags = inv.flags;
  return h(inv.pos, flags, typeof flags.session === "string" ? flags.session : undefined);
};
var DASH_HINT = "for free text containing dashes, put it after a bare --";
var SESSION = ["session"];
var ROWS = [
  {
    name: "open",
    flags: ["no-open", "restore", "timeout", "start-timeout"],
    positionals: [{ name: "path", required: false, variadic: true }],
    describe: "spawn a session (opens the browser), adding paths; prints {url, port, session_id}. --timeout <seconds> sets the idle close (default 1800); --timeout 0 stands until closed",
    run: (pos, flags) => cmdOpen(pos, flags)
  },
  {
    name: "add",
    flags: SESSION,
    positionals: [{ name: "path", required: true, variadic: true }],
    describe: "add files or folders to the context list",
    run: (pos, _flags, session) => cmdAdd(pos, session)
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: [],
    describe: "the session: context, docs + versions (with paths), active, dirty, selection",
    run: (_pos, flags, session) => cmdState(session, flags.full === true)
  },
  {
    name: "tail",
    flags: [...SESSION, "since", "once"],
    positionals: [],
    describe: "the human's messages (with selection + active path) as JSON lines \u2014 wrap with Monitor; its last line names the next act",
    run: (_pos, flags, session) => {
      const b = typeof flags.since === "string" ? parseTailSince(flags.since) : { since: -1 };
      return cmdTail(session, b.since, {
        once: flags.once === true,
        sinceGiven: typeof flags.since === "string",
        ...b.epoch ? { epoch: b.epoch } : {}
      });
    }
  },
  {
    name: "version-new",
    flags: [...SESSION, "doc", "from", "label"],
    positionals: [],
    describe: "copy a version (default: the active one) to a new file; prints its path to edit",
    run: async (_pos, flags, session) => {
      const from = typeof flags.from === "string" ? parseVersion(flags.from, "--from") : undefined;
      printJson(await postCmd(session, {
        type: "version.new",
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {},
        ...from !== undefined ? { from } : {},
        ...typeof flags.label === "string" ? { label: flags.label } : {}
      }));
    }
  },
  {
    name: "say",
    flags: [...SESSION, "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "post a chat message from the agent (prose: --body-file <path> or --stdin)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, { type: "say", text: await readSayBody(pos, flags) }));
    }
  },
  {
    name: "version-delete",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "vN", required: true }],
    describe: "remove a version and its file (never the active one \u2014 activate another first)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "version.delete",
        version: parseVersion(pos[0] ?? "", "version-delete"),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "task",
    flags: [...SESSION, "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "say you have started something; prints the id to finish it with",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, { type: "task.start", text: await readSayBody(pos, flags) }));
    }
  },
  {
    name: "task-status",
    flags: SESSION,
    positionals: [
      { name: "id", required: true },
      { name: "status", required: true, variadic: true }
    ],
    describe: "say what step a task is on (for work worth watching)",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, {
        type: "task.status",
        id: pos[0],
        status: pos.slice(1).join(" ")
      }));
    }
  },
  {
    name: "task-done",
    flags: SESSION,
    positionals: [
      { name: "id", required: true },
      { name: "outcome", required: false, variadic: true }
    ],
    describe: "mark a task finished, optionally saying what came of it",
    run: async (pos, _flags, session) => {
      const outcome = pos.slice(1).join(" ").trim();
      printJson(await postCmd(session, {
        type: "task.done",
        id: pos[0],
        ...outcome ? { outcome } : {}
      }));
    }
  },
  {
    name: "task-remove",
    flags: SESSION,
    positionals: [{ name: "id", required: true }],
    describe: "forget a task entirely \u2014 for one started by mistake",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, { type: "task.remove", id: pos[0] }));
    }
  },
  {
    name: "tasks-clear",
    flags: SESSION,
    positionals: [],
    describe: "forget every finished task; outstanding ones are left alone",
    run: async (_pos, _flags, session) => {
      printJson(await postCmd(session, { type: "tasks.clear" }));
    }
  },
  {
    name: "working",
    flags: [...SESSION, "for"],
    positionals: [],
    describe: "say you are still on it \u2014 silences the waiting nudge, keeps the human's pulse",
    run: async (_pos, flags, session) => {
      const seconds = typeof flags.for === "string" ? parseCount(flags.for, "working --for") : undefined;
      printJson(await postCmd(session, {
        type: "working",
        ...seconds !== undefined ? { seconds } : {}
      }));
    }
  },
  {
    name: "note",
    flags: [...SESSION, "doc", "quote", "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "note a passage of the active version (--quote 'exact text'; prose: --body-file or --stdin)",
    run: async (pos, flags, session) => {
      if (typeof flags.quote !== "string" || flags.quote.trim() === "")
        die("note: --quote is required \u2014 the exact text the note is about", "usage", {
          hint: "run: cli.ts state --full (the active version's text is on disk; quote from it)"
        });
      printJson(await postCmd(session, {
        type: "note.add",
        quote: flags.quote,
        body: await readSayBody(pos, flags),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "notes",
    flags: [...SESSION, "doc", "full"],
    positionals: [],
    describe: "the notes on a document, placed in the active version (--full includes resolved)",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "notes",
        ...flags.full ? { all: true } : {},
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "note-edit",
    flags: [...SESSION, "doc", "stdin", "body-file"],
    positionals: [
      { name: "id", required: true },
      { name: "text", required: false, variadic: true }
    ],
    describe: "rewrite what a note says (its passage is unchanged)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "note.edit",
        id: pos[0],
        body: await readSayBody(pos.slice(1), flags),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "note-resolve",
    flags: [...SESSION, "doc", "reopen"],
    positionals: [{ name: "id", required: true }],
    describe: "mark a note dealt with (--reopen puts it back)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "note.resolve",
        id: pos[0],
        resolved: !flags.reopen,
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "note-remove",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "id", required: true }],
    describe: "delete a note",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "note.remove",
        id: pos[0],
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "diff",
    flags: [...SESSION, "doc", "context", "patch"],
    positionals: [{ name: "against", required: true }],
    describe: "compare the active version with another (vN or 'saved' for the file on disk); --patch for plain unified text",
    run: async (pos, flags, session) => {
      const r = await postCmd(session, {
        type: "diff",
        against: parseSide(pos[0] ?? "", "diff"),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {},
        ...typeof flags.context === "string" ? { context: parseCount(flags.context, "--context") } : {}
      });
      if (flags.patch)
        process.stdout.write(String(r.unified ?? ""));
      else
        printJson(r);
    }
  },
  {
    name: "merge",
    flags: [...SESSION, "doc", "hunks"],
    positionals: [{ name: "against", required: true }],
    describe: "take changes from another version into the active one (--hunks 1,3; default: all of them)",
    run: async (pos, flags, session) => {
      const against = parseSide(pos[0] ?? "", "merge");
      const listed = typeof flags.hunks === "string" ? flags.hunks.split(",").map((h) => parseCount(h, "--hunks")) : null;
      const hunks = listed ?? (await postCmd(session, {
        type: "diff",
        against,
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      })).hunks?.map((h) => h.id) ?? [];
      printJson(await postCmd(session, {
        type: "merge",
        against,
        hunks,
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "activate",
    flags: [...SESSION, "doc"],
    positionals: [{ name: "vN", required: true }],
    describe: "make a version the active one (the one the human edits and Save writes)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "activate",
        version: parseVersion(pos[0] ?? "", "activate"),
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "new-doc",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "create an empty document (its folder must be a set, a folder in one, or the workspace)",
    run: (pos, _flags, session) => {
      const abs = resolve(pos[0]);
      return structureCmd(session, { type: "doc.create", dir: dirname(abs), name: basename(abs) });
    }
  },
  {
    name: "new-folder",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "create a folder \u2014 inside a set, or in the workspace as a new set",
    run: (pos, _flags, session) => {
      const abs = resolve(pos[0]);
      return structureCmd(session, {
        type: "folder.create",
        dir: dirname(abs),
        name: basename(abs)
      });
    }
  },
  {
    name: "move",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "into", required: true }
    ],
    describe: "move a document or folder into another folder (a real move on disk)",
    run: (pos, _flags, session) => structureCmd(session, {
      type: "move",
      path: resolve(pos[0]),
      into: resolve(pos[1])
    })
  },
  {
    name: "rename",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "name", required: true }
    ],
    describe: "rename a document or folder in place",
    run: (pos, _flags, session) => structureCmd(session, { type: "rename", path: resolve(pos[0]), name: pos[1] })
  },
  {
    name: "hide",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "remove a document, folder or set from Scriptorium \u2014 the files stay on disk",
    run: (pos, _flags, session) => structureCmd(session, { type: "hide", path: resolve(pos[0]) })
  },
  {
    name: "unhide",
    flags: SESSION,
    positionals: [{ name: "entry", required: true }],
    describe: "bring back everything hidden in a set (its entry id, from state)",
    run: (pos, _flags, session) => structureCmd(session, { type: "unhide", entry: pos[0] })
  },
  {
    name: "make-set",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "turn a single document into a set: a folder named for it, the document moved in",
    run: (pos, _flags, session) => structureCmd(session, { type: "set.make", path: resolve(pos[0]) })
  },
  {
    name: "import",
    flags: [...SESSION, "into"],
    positionals: [{ name: "file", required: true }],
    describe: "copy a document in (default: into the workspace) and show the copy",
    run: (pos, flags, session) => cmdImport(pos[0], typeof flags.into === "string" ? flags.into : undefined, session)
  },
  {
    name: "workspace",
    flags: SESSION,
    positionals: [{ name: "dir", required: false }],
    describe: "print the workspace (where drops and new top-level documents land), or set it",
    run: (pos, _flags, session) => cmdWorkspace(pos[0], session)
  },
  {
    name: "meta",
    flags: SESSION,
    positionals: [{ name: "path", required: false }],
    describe: "a document's frontmatter as the daemon read it (no path: every context document)",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, {
        type: "meta",
        ...pos[0] !== undefined ? { path: resolve(pos[0]) } : {}
      }));
    }
  },
  {
    name: "find",
    flags: [...SESSION, "type", "status", "lifecycle", "tag", "since"],
    positionals: [],
    describe: "documents by frontmatter \u2014 filters AND, all optional; an empty result is an answer (count)",
    run: async (_pos, flags, session) => {
      const filter = {};
      for (const k of ["type", "status", "lifecycle", "tag"])
        if (typeof flags[k] === "string")
          filter[k] = flags[k];
      if (typeof flags.since === "string")
        filter.since = parseSinceDate(flags.since);
      printJson(await postCmd(session, { type: "find", filter }));
    }
  },
  {
    name: "search",
    flags: [...SESSION, "limit"],
    positionals: [{ name: "query", required: true, variadic: true }],
    describe: "search the context: fuzzy on names, exact in text \u2014 searches the ACTIVE version of open documents, which grep cannot see",
    run: async (pos, flags, session) => {
      const limit = typeof flags.limit === "string" ? parseCount(flags.limit, "search --limit") : undefined;
      printJson(await postCmd(session, {
        type: "search",
        query: pos.join(" "),
        ...limit !== undefined ? { limit } : {}
      }));
    }
  },
  {
    name: "doctor",
    flags: SESSION,
    positionals: [],
    describe: "what is worth looking at in this session \u2014 each finding names the verb that fixes it",
    run: async (_pos, _flags, session) => {
      printJson(await postCmd(session, { type: "doctor" }));
    }
  },
  {
    name: "forget",
    flags: [...SESSION, "doc"],
    positionals: [],
    describe: "forget a document whose file of record is gone (refused while the file exists \u2014 use hide to take one out of the context)",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "forget",
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {}
      }));
    }
  },
  {
    name: "dangling",
    flags: [...SESSION, "entry"],
    positionals: [],
    describe: "links in a set that nothing answers \u2014 file, line, and the target as written",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "dangling",
        ...typeof flags.entry === "string" ? { entry: flags.entry } : {}
      }));
    }
  },
  {
    name: "graph",
    flags: [...SESSION, "entry"],
    positionals: [],
    describe: "a set's map as JSON \u2014 nodes, edges (body links and frontmatter kept apart), dangling",
    run: async (_pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "graph",
        ...typeof flags.entry === "string" ? { entry: flags.entry } : {}
      }));
    }
  },
  {
    name: "backlinks",
    flags: SESSION,
    positionals: [{ name: "path", required: true }],
    describe: "what cites a document \u2014 `related` (frontmatter) and `links` (body), kept apart",
    run: async (pos, _flags, session) => {
      printJson(await postCmd(session, { type: "backlinks", path: resolve(pos[0]) }));
    }
  },
  {
    name: "meta-init",
    flags: [...SESSION, "type", "by"],
    positionals: [{ name: "path", required: true }],
    describe: "add a frontmatter block to a document that has none (type guessed from its neighbours)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, {
        type: "meta.init",
        path: resolve(pos[0]),
        ...typeof flags.type === "string" ? { metaType: flags.type } : {},
        ...typeof flags.by === "string" ? { by: flags.by } : {}
      }));
    }
  },
  {
    name: "meta-set",
    flags: SESSION,
    positionals: [
      { name: "path", required: true },
      { name: "key=value", required: true, variadic: true }
    ],
    describe: "set frontmatter keys \u2014 one line edit each, everything else untouched",
    run: async (pos, _flags, session) => {
      const fields = {};
      for (const pair of pos.slice(1)) {
        const eq = pair.indexOf("=");
        if (eq <= 0)
          die(`"${pair}" is not key=value`, "usage", {
            hint: "meta-set <path> status=stable lifecycle=live"
          });
        fields[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      printJson(await postCmd(session, { type: "meta.set", path: resolve(pos[0]), fields }));
    }
  },
  {
    name: "info",
    flags: SESSION,
    positionals: [],
    describe: "print the resolved session pointer",
    run: (_pos, _flags, session) => {
      printJson(requireSession(session));
    }
  },
  {
    name: "close",
    flags: SESSION,
    positionals: [],
    describe: "shut the session down (the manifest stays, for open --restore)",
    run: async (_pos, _flags, session) => {
      await postCmd(session, { type: "close" });
      printJson({ ok: true, sent: "close" });
    }
  }
];
var cli = defineCli({
  name: "scriptorium",
  summary: "a co-present markdown editor: the human edits, you write new versions.",
  options: CLI_OPTIONS,
  commands: ROWS.map((r) => ({ ...r, run: on(r.run), rejectHint: DASH_HINT })),
  grammar: "flags-anywhere",
  verbPositional: "verb",
  usageHides: ["session"],
  version: versionInfo,
  helpFooter: `  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row.

  Output: JSON on stdout, one document per answer \u2014 except tail (one JSON line
  per event) and help (prose). Failures: one JSON envelope on stderr, exit
  2 = usage, 1 = internal, 5 = not found, 6 = conflict. tail waits for a
  session rather than failing, and ends 0 when its session closes. tail
  ${WINDOW_HELP}.`
});
var VERBS = cli.verbs;
var VERB_SPEC = Object.fromEntries(cli.rows.map((r) => [r.name, r.accepted]));
var flagsFor = (verb) => cli.flagsFor(verb);
var RECOGNIZED_FLAGS = cli.recognizedFlags;
async function main(argv) {
  try {
    return await cli.dispatch(argv);
  } catch (e) {
    const reported = reportCliError(e);
    if (reported !== null)
      return reported;
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "ENOENT")
      return reportCliError(new UsageError(msg)) ?? 2;
    return reportCliError(new CliError("internal", msg)) ?? 1;
  }
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  CLI_OPTIONS,
  RECOGNIZED_FLAGS,
  UsageError,
  VERBS,
  VERB_SPEC,
  cli,
  daemonCwd,
  docArg,
  flagsFor,
  main,
  parseCount,
  parseSide,
  parseSinceDate,
  parseTailSince,
  parseVersion,
  run
};

//# debugId=F3620999F2EAEC7364756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgKHRoZSBraXQgcmVnaXN0cnkgZGlzcGF0Y2hlcyksIG5vbmUgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAuIFRoZVxuICogc3dhbGxvd2luZyBjYXRjaGVzIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2AsIGBwb3N0Q21kYCdzIGNsb3NlXG4gKiBFQ09OTlJFU0VUKSBjb250YWluIG5vIGRpZS1yZWFjaGFibGUgY2FsbC5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgc3RhdFN5bmMsXG4gIHVubGlua1N5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0eXBlIENvbW1hbmRTcGVjLCBkZWZpbmVDbGksIHR5cGUgSW52b2NhdGlvbiB9IGZyb20gXCIuLi8uLi9raXQvY2xpL3JlZ2lzdHJ5XCI7XG5pbXBvcnQgeyBwcmludEpzb24gfSBmcm9tIFwiLi4vLi4va2l0L2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHR5cGUgRXJyS2luZCwgcmVwb3J0Q2xpRXJyb3IgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQge1xuICBjb21tYW5kTGluZSxcbiAgcmVhZFNpbmNlLFxuICB0YWlsQ29tbWFuZCxcbiAgdGFpbFdpdGhIYW5kb2ZmLFxuICBXSU5ET1dfSEVMUCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IERPQ19FWFRFTlNJT05TLCBpc0RvY05hbWUgfSBmcm9tIFwiLi90cmVlXCI7XG5cbi8vIOKaoCBERUNMQVJFRCBGSVJTVCwgQUJPVkUgRVZFUlkgT1RIRVIgRlVOQ1RJT04sIE9OIFBVUlBPU0UuIFRoZSBgY2hvaWNlc2Bcbi8vIGNlbnN1cydzIHJhaXNlciBydWxlIChhKSAoYGdyaW1vaXJlL2xpYi9lcnJvci1zaXRlcy50c2ApIG1hdGNoZXNcbi8vIGBmdW5jdGlvbiBOQU1FKGAgbGF6aWx5IHVwIHRvIHRoZSBuZXh0IGApOiBuZXZlcmAgd2l0aGluIDYwMCBjaGFyYWN0ZXJzLCBzb1xuLy8gQU5ZIGZ1bmN0aW9uIGRlY2xhcmVkIHNob3J0bHkgYWJvdmUgdGhpcyBvbmUg4oCUIGBhcGlgLCB0aGVuIGByZXF1aXJlU2Vzc2lvbmAg4oCUXG4vLyB3YXMgcmVhZCBhcyBhIHJhaXNlciBhbmQgaXRzIGNhbGxzIGNvdW50ZWQgYXMgcmFpc2Ugc2l0ZXMgKGZvdW5kIDIwMjYtMDktMTEsXG4vLyByZXBvcnRlZCBpbiB0aGUgc2xpY2UtQSBqb3VybmFsIGFzIGFuIGluc3RydW1lbnQgZGVmZWN0LCBub3QgZml4ZWQgaGVyZSkuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGNvbnN0IGJvZHkgPSAoZGF0YSA/PyB7fSkgYXMgeyBlcnJvcj86IHVua25vd247IGNob2ljZXM/OiB1bmtub3duOyBoaW50PzogdW5rbm93biB9O1xuICBjb25zdCBjaG9pY2VzID0gQXJyYXkuaXNBcnJheShib2R5LmNob2ljZXMpID8gYm9keS5jaG9pY2VzLm1hcChTdHJpbmcpIDogdW5kZWZpbmVkO1xuICAvLyDimqAgVGhlIGRhZW1vbidzIG93biBoaW50LCBmb3J3YXJkZWQuIEEgcmVmdXNhbCB0aGF0IGtub3dzIHdoYXQgdG8gZG8gbmV4dFxuICAvLyB1c2VkIHRvIGRyb3AgdGhhdCBrbm93bGVkZ2Ugb24gdGhlIGZsb29yIGF0IHRoaXMgbGluZS5cbiAgY29uc3QgaGludCA9IHR5cGVvZiBib2R5LmhpbnQgPT09IFwic3RyaW5nXCIgPyBib2R5LmhpbnQgOiB1bmRlZmluZWQ7XG4gIGRpZSh0eXBlb2YgYm9keS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuZXJyb3IgOiBgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBTZXNzaW9ucyB3aG9zZSB3b3JrIGlzIHN0aWxsIG9uIGRpc2ssIG5ld2VzdCBmaXJzdCAoRTU2KS5cbiAqXG4gKiDim5QgQSBERUFEIFNFU1NJT04gSVMgTk9UIEEgTE9TVCBPTkUsIGFuZCB0aGUgQ0xJIHVzZWQgdG8gaW1wbHkgb3RoZXJ3aXNlLiBUaGVcbiAqIG1hbmlmZXN0IGFuZCBldmVyeSB2ZXJzaW9uIGZpbGUgbGl2ZSB1bmRlciB0aGUgaG9tZSwgc28gYSBkYWVtb24gdGhhdCBoYXNcbiAqIGV4aXRlZCDigJQgdGhlIDMwLW1pbnV0ZSBpZGxlIHRpbWVvdXQsIGEgY3Jhc2gsIGEgcmVib290IOKAlCBjb3N0cyB0aGUgVVJMIGFuZFxuICogbm90aGluZyBlbHNlLiBDb2xlIGhpdCBleGFjdGx5IHRoaXMgKFwidGhhdCBsaW5rIGRvZXNuJ3Qgc2VlbSB0byBiZSBsaXZlXG4gKiBhbnltb3JlXCIpIGFuZCB0aGUgb25seSB0aGluZyB0aGUgdG9vbGluZyBzYWlkIHdhcyBcIm5vIHJ1bm5pbmcgc2NyaXB0b3JpdW1cbiAqIHNlc3Npb25cIiwgd2hpY2ggcmVhZHMgbGlrZSB0aGUgd29yayBpcyBnb25lLlxuICovXG5mdW5jdGlvbiByZXN0b3JhYmxlKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoKGUpID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCBlLm5hbWUsIFwibWFuaWZlc3QuanNvblwiKSkpXG4gICAgICAubWFwKChlKSA9PiAoeyBpZDogZS5uYW1lLCBhdDogc3RhdFN5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKS5tdGltZU1zIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYXQgLSBhLmF0KVxuICAgICAgLm1hcCgoZSkgPT4gZS5pZCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogV2hhdCB0byBzYXkgd2hlbiBubyBkYWVtb24gYW5zd2VycyDigJQgaW5jbHVkaW5nIHRoZSB3YXkgYmFjaywgd2hlbiB0aGVyZSBpcyBvbmUuICovXG5mdW5jdGlvbiBub1Nlc3Npb25IaW50KCk6IHsgaGludDogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGlkcyA9IHJlc3RvcmFibGUoKTtcbiAgY29uc3QgbmV3ZXN0ID0gaWRzWzBdO1xuICBpZiAobmV3ZXN0ID09PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHsgaGludDogXCJubyBzZXNzaW9uIGhhcyBiZWVuIG9wZW5lZCBpbiB0aGlzIGhvbWUgeWV0IOKAlCBydW46IGNsaS50cyBvcGVuIDxwYXRoPlwiIH07XG4gIHJldHVybiB7XG4gICAgLy8g4pqgIFRoZSBDT01NQU5ELCB3aXRoIHRoZSBpZCBhbHJlYWR5IGluIGl0LiBBIGhpbnQgdGhhdCBzYXlzIFwieW91IGNhblxuICAgIC8vIHJlc3RvcmUgYSBzZXNzaW9uXCIgbGVhdmVzIHRoZSByZWFkZXIgdG8gZmluZCB0aGUgaWQgYW5kIGd1ZXNzIHRoZSBmbGFnLlxuICAgIGhpbnQ6IGBubyBkYWVtb24gaXMgcnVubmluZywgYnV0IHRoZSB3b3JrIGlzIG9uIGRpc2sg4oCUIGJyaW5nIGl0IGJhY2sgd2l0aDogY2xpLnRzIG9wZW4gLS1yZXN0b3JlICR7bmV3ZXN0fWAsXG4gICAgY2hvaWNlczogaWRzLnNsaWNlKDAsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbih0bXBkaXIoKSwgc2Vzc2lvbiA/IGBzY3JpcHRvcml1bS0ke3Nlc3Npb259Lmpzb25gIDogXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0Ug4oCUIEVOT0VOVCBpcyB0aGUgb25seSBhYnNlbmNlLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb25Qb2ludGVyO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgbm9TZXNzaW9uSGludCgpKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBsZXQgc3RhdHVzOiBudW1iZXI7XG4gIGxldCBkYXRhOiB1bmtub3duO1xuICB0cnkge1xuICAgICh7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYGNsb3NlYCBzdG9wcyB0aGUgc2VydmVyOyBhIFJFU0VUIGlzIGl0cyBzdWNjZXNzLiBBIHJlZnVzZWQgY29ubmVjdGlvblxuICAgIC8vIChhIHN0YWxlIHBvaW50ZXIpIGlzIGEgdHJhbnNwb3J0IGZhaWx1cmUgbGlrZSBhbnkgb3RoZXIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zdCBjb2RlID0gZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyID8gU3RyaW5nKGVyci5jb2RlKSA6IFwiXCI7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSlcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChTdHJpbmcobXNnLnR5cGUpLCBzdGF0dXMsIGRhdGEpO1xuICByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuLy8g4pSA4pSAIHRoZSBmbGFnIHJlZ2lzdHJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIFRoZSBvcHRpb25zIHRhYmxlIHRoZSBraXQncyBwYXJzZXIgcmVhZHMgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2AsIHRocm91Z2hcbi8vIGBkZWZpbmVDbGlgIGJlbG93KS4gRXhwb3J0ZWQgc28gYSB0ZXN0IGNhbiBidWlsZCB0aGUgc2FtZSBwYXJzZSB0aGUgQ0xJIGRvZXMuXG5cbmV4cG9ydCBjb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJ5OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY29udGV4dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRvYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGVudHJ5OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZm9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVvdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZW9wZW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgaHVua3M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbnRvOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGlmZWN5Y2xlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGltaXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIG9uY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcGF0Y2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlc3Npb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwic3RhcnQtdGltZW91dFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGFnOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHR5cGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuZXhwb3J0IGNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBDbGlFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSB7XG4gICAgc3VwZXIoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuLyoqXG4gKiBgdGFpbCAtLXNpbmNlYCBpcyBhIEJPT0tNQVJLOiBhbiBldmVudCBpZCAoLTEgZm9yIFwiZXZlcnl0aGluZ1wiKSwgb3B0aW9uYWxseVxuICogd2l0aCB0aGUgZXBvY2ggb2YgdGhlIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgYXMgdGhlIHRhaWwncyBvd24gaGFuZG9mZiBsaW5lIHByaW50cyBpdCDigJRcbiAqIGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsIEQyKS4gVGhlIGVwb2NoIGlzIHdoYXQgbGV0cyB0aGUgdGFpbCBub3RpY2UgYVxuICogcmVzdGFydGVkIGRhZW1vbiB3aG9zZSBuZXcgbG9nIGlzIGFscmVhZHkgcGFzdCB0aGUgaWQuIFZlcmlmeS1wYXNzIGZpeCA5XG4gKiBzdGlsbCBob2xkczogYC0tc2luY2UgYWJjYCB1c2VkIHRvIHBhcnNlIHRvIE5hTiwgd2hpY2ggdGhlIGxvZyByZWFkcyBhcyBcImZyb21cbiAqIHRoZSBzdGFydFwiLCBzbyBhIHR5cG8gcmVwbGF5ZWQgdGhlIHdob2xlIGJ1ZmZlciBhdCBleGl0IDAg4oCUIGl0IGlzIHJlZnVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVRhaWxTaW5jZSh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHtcbiAgY29uc3QgciA9IHJlYWRTaW5jZSh0b2tlbiwgeyBlcG9jaDogdHJ1ZSB9KTtcbiAgaWYgKCFyLm9rKSBkaWUoci5tZXNzYWdlLCBcInVzYWdlXCIpO1xuICByZXR1cm4gci5lcG9jaCA/IHsgc2luY2U6IHIuc2luY2UsIGVwb2NoOiByLmVwb2NoIH0gOiB7IHNpbmNlOiByLnNpbmNlIH07XG59XG5cbi8qKlxuICogYGZpbmQgLS1zaW5jZWAgaXMgYSBEQVRFLCB3aGVyZSBgdGFpbCAtLXNpbmNlYCBpcyBhbiBldmVudCBpZCDigJQgdGhlIGZsYWcgaXNcbiAqIHNoYXJlZCwgdGhlIG1lYW5pbmcgaXMgdGhlIHZlcmIncywgYW5kIHBkb2NzIHNwZWxscyB0aGlzIG9uZSBgLS1zaW5jZWAgdG9vLlxuICogQSB0eXBvIG11c3Qgbm90IHNpbGVudGx5IHdpZGVuIHRoZSBzZWFyY2gsIHNvIGEgbm9uLWRhdGUgaXMgYSB1c2FnZSBlcnJvci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2luY2VEYXRlKHRva2VuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkezR9LVxcZHsyfS1cXGR7Mn0kLy50ZXN0KHQpIHx8IE51bWJlci5pc05hTihEYXRlLnBhcnNlKHQpKSlcbiAgICBkaWUoYGZpbmQgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhIGRhdGUg4oCUIHdyaXRlIGl0IGFzIFlZWVktTU0tRERgLCBcInVzYWdlXCIpO1xuICByZXR1cm4gdDtcbn1cblxuLyoqIGB2MmAgb3IgYDJgIOKGkiAyLiBBIHZlcnNpb24gbnVtYmVyIGlzIGFuIG9wZW4gc2V0LCBzbyB0aGUgcmVqZWN0aW9uIGNhcnJpZXMgYSBoaW50LCBub3QgY2hvaWNlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVZlcnNpb24odG9rZW46IHN0cmluZywgd2hhdDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgbSA9IC9edj8oXFxkKykkLy5leGVjKHRva2VuLnRyaW0oKSk7XG4gIGlmICghbSB8fCBOdW1iZXIobVsxXSkgPCAxKVxuICAgIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHZlcnNpb24g4oCUIHdyaXRlIHYxLCB2Miwg4oCmYCwgXCJ1c2FnZVwiLCB7XG4gICAgICBoaW50OiBcInJ1bjogY2xpLnRzIHN0YXRlIChlYWNoIGRvYyBsaXN0cyBpdHMgdmVyc2lvbnMpXCIsXG4gICAgfSk7XG4gIHJldHVybiBOdW1iZXIobVsxXSk7XG59XG5cbi8qKiBBIG5vbi1uZWdhdGl2ZSB3aG9sZSBudW1iZXIgZnJvbSBhIGZsYWcsIHJlZnVzZWQgcmF0aGVyIHRoYW4gY29lcmNlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvdW50KHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCk7XG4gIGlmICghL15cXGQrJC8udGVzdCh0KSkgZGllKGAke3doYXR9OiBcIiR7dG9rZW59XCIgaXMgbm90IGEgd2hvbGUgbnVtYmVyYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIE51bWJlcih0KTtcbn1cblxuLyoqXG4gKiBBIGNvbXBhcmlzb24gc2lkZTogYSB2ZXJzaW9uLCBvciB0aGUgZmlsZSBvZiByZWNvcmQuIGBvcmlnaW5hbGAgaXMgc3BlbGxlZFxuICogb3V0IHJhdGhlciB0aGFuIG9mZmVyZWQgYXMgYHYwYCDigJQgYSB6ZXJvdGggdmVyc2lvbiB3b3VsZCByZWFkIGxpa2UgdGhlXG4gKiBlYXJsaWVzdCBvbmUsIGFuZCB0aGUgb3JpZ2luYWwgaXMgbm90IHBhcnQgb2YgdGhlIHZlcnNpb24gbGluZSBhdCBhbGwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpZGUodG9rZW46IHN0cmluZywgd2hhdDogc3RyaW5nKTogbnVtYmVyIHwgXCJvcmlnaW5hbFwiIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAvLyBgc2F2ZWRgIGlzIHRoZSB3b3JkIHRoZSBTVVJGQUNFIHVzZXMgZm9yIHRoaXMgc2lkZSAoRTQzKTsgYG9yaWdpbmFsYCBhbmRcbiAgLy8gYGZpbGVgIGtlZXAgd29ya2luZyBiZWNhdXNlIHRoZXkgYXJlIHdoYXQgZWFybGllciBzZXNzaW9ucyBhbmQgbm90ZXMgc2F5LlxuICBpZiAodCA9PT0gXCJvcmlnaW5hbFwiIHx8IHQgPT09IFwiZmlsZVwiIHx8IHQgPT09IFwic2F2ZWRcIikgcmV0dXJuIFwib3JpZ2luYWxcIjtcbiAgcmV0dXJuIHBhcnNlVmVyc2lvbih0b2tlbiwgd2hhdCk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqXG4gKiDim5QgVkVSSUZZLVBBU1MgRklYIDU6IGV2ZXJ5IHBhdGggaXMgY2hlY2tlZCBIRVJFLCBiZWZvcmUgYW55IGRhZW1vbiBleGlzdHMuXG4gKiBgb3BlbiBkb2MubWQgcGljLnBuZ2AgdXNlZCB0byBzcGF3biBhIHNlc3Npb24sIHRoZW4gZmFpbCBvbiB0aGUgc2Vjb25kIHBhdGhcbiAqIGluc2lkZSBpdCDigJQgbGVhdmluZyBhIHJ1bm5pbmcgZGFlbW9uIGFuZCBhIGxpdmUgcG9pbnRlciBiZWhpbmQgYSBmYWlsZWRcbiAqIGNvbW1hbmQuIEEgZm9sZGVyIG9yIGEgZG9jdW1lbnQgaXMgYWNjZXB0ZWQ7IGEgbWlzc2luZyBwYXRoIGlzIG5vdF9mb3VuZCwgYVxuICogbm9uLWRvY3VtZW50IGZpbGUgaXMgdXNhZ2Ugd2l0aCB0aGUgYWNjZXB0ZWQgZXh0ZW5zaW9ucyBhcyBgY2hvaWNlc2AuXG4gKi9cbmZ1bmN0aW9uIGNvbnRleHRQYXRocyhwb3M6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBwYXRocyA9IHBvcy5tYXAoKHApID0+IHJlc29sdmUocCkpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcbiAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICB0cnkge1xuICAgICAgc3QgPSBzdGF0U3luYyhwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGRpZShgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHtwfWAsIFwibm90X2ZvdW5kXCIpO1xuICAgIH1cbiAgICBpZiAoIXN0LmlzRGlyZWN0b3J5KCkgJiYgIWlzRG9jTmFtZShwKSlcbiAgICAgIGRpZShgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7cH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogXCJhZGQgYSBmb2xkZXIsIG9yIGEgZmlsZSB3aXRoIG9uZSBvZiB0aGVzZSBleHRlbnNpb25zXCIsXG4gICAgICAgIGNob2ljZXM6IFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gcGF0aHM7XG59XG5cbi8qKlxuICogYC0tZG9jYCBhcyB0aGUgQ0xJJ3MgY2FsbGVyIG1lYW50IGl0ICh2ZXJpZnktcGFzcyBmaXggOCk6IGEgdG9rZW4gd2l0aCBhIHBhdGhcbiAqIHNlcGFyYXRvciwgb3Igb25lIG5hbWluZyBhIGZpbGUgaW4gVEhJUyBwcm9jZXNzJ3MgY3dkLCBpcyByZXNvbHZlZCBoZXJlIHRvIGFuXG4gKiBhYnNvbHV0ZSBwYXRoIOKAlCB0aGUgZGFlbW9uJ3MgY3dkIGlzIG5vdCB0aGUgY2FsbGVyJ3MuIEFueXRoaW5nIGVsc2UgKGEgc2x1ZyxcbiAqIGEgdW5pcXVlIGZpbGUgbmFtZSkgZ29lcyBhcyB0eXBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY0FyZyh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHRva2VuLmluY2x1ZGVzKFwiL1wiKSB8fCBleGlzdHNTeW5jKHJlc29sdmUodG9rZW4pKSkgcmV0dXJuIHJlc29sdmUodG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbi8qKiBLZWVwIHRoZSBuZXdlc3QgYExPR19LRUVQIC0gMWAgZGFlbW9uIGxvZ3MsIHNvIHRoZSBvbmUgYWJvdXQgdG8gYmUgd3JpdHRlbiBtYWtlcyBgTE9HX0tFRVBgLiAqL1xuY29uc3QgTE9HX0tFRVAgPSAxMDtcbmZ1bmN0aW9uIHBydW5lTG9ncyhsb2dEaXI6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgbmFtZXMgPSByZWFkZGlyU3luYyhsb2dEaXIpLmZpbHRlcigobikgPT4gL15kYWVtb24tXFxkKy1cXGQrXFwubG9nJC8udGVzdChuKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBieUFnZSA9IG5hbWVzLnNvcnQoKGEsIGIpID0+IE51bWJlcihhLnNwbGl0KFwiLVwiKVsxXSkgLSBOdW1iZXIoYi5zcGxpdChcIi1cIilbMV0pKTtcbiAgZm9yIChjb25zdCBuIG9mIGJ5QWdlLnNsaWNlKDAsIE1hdGgubWF4KDAsIGJ5QWdlLmxlbmd0aCAtIChMT0dfS0VFUCAtIDEpKSkpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhqb2luKGxvZ0RpciwgbikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG5cbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIGZsYWdzLnJlc3RvcmUsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWFuaWZlc3QpKSB7XG4gICAgICBsZXQgc2F2ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICB0cnkge1xuICAgICAgICBzYXZlZCA9IChcbiAgICAgICAgICBhd2FpdCBBcnJheS5mcm9tQXN5bmMobmV3IEJ1bi5HbG9iKFwiKi9tYW5pZmVzdC5qc29uXCIpLnNjYW4oam9pbihob21lLCBcInNlc3Npb25zXCIpKSlcbiAgICAgICAgKS5tYXAoKHApID0+IHAuc3BsaXQoXCIvXCIpWzBdIGFzIHN0cmluZyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm8gc2Vzc2lvbnMgZm9sZGVyOiB0aGUgc2V0IGlzIGVtcHR5LCBhbmQgc2F5cyBzbyAqL1xuICAgICAgfVxuICAgICAgZGllKGBubyBzYXZlZCBzZXNzaW9uIFwiJHtmbGFncy5yZXN0b3JlfVwiIHVuZGVyICR7aG9tZX1gLCBcIm5vdF9mb3VuZFwiLCB7XG4gICAgICAgIGNob2ljZXM6IHNhdmVkLnNvcnQoKSxcbiAgICAgICAgLi4uKHNhdmVkLmxlbmd0aCA9PT0gMCA/IHsgaGludDogXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWVcIiB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxpdmUgPSByZWFkU2Vzc2lvbihmbGFncy5yZXN0b3JlKTtcbiAgICBpZiAobGl2ZSkge1xuICAgICAgY29uc3QgYWxpdmUgPSBhd2FpdCBhcGkobGl2ZS5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKS50aGVuKFxuICAgICAgICAocikgPT4gci5zdGF0dXMgPT09IDIwMCxcbiAgICAgICAgKCkgPT4gZmFsc2UsXG4gICAgICApO1xuICAgICAgaWYgKGFsaXZlKVxuICAgICAgICBkaWUoYHNlc3Npb24gJHtmbGFncy5yZXN0b3JlfSBpcyBhbHJlYWR5IHJ1bm5pbmcgYXQgJHtsaXZlLnVybH1gLCBcImNvbmZsaWN0XCIsIHtcbiAgICAgICAgICBoaW50OiBgdXNlIGl0OiBjbGkudHMgc3RhdGUgLS1zZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX1gLFxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBkYWVtb25BcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAodHlwZW9mIGZsYWdzLnRpbWVvdXQgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBmbGFncy50aW1lb3V0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgZmxhZ3MucmVzdG9yZSk7XG4gIC8vIEUyMzogYSBuZXcgc2Vzc2lvbidzIHdvcmtzcGFjZSBpcyB3aGVyZSBgb3BlbmAgcmFuLiBBIHJlc3RvcmVkIG9uZSBrZWVwcyBpdHMgb3duLlxuICBlbHNlIGRhZW1vbkFyZ3MucHVzaChcIi0td29ya3NwYWNlXCIsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSlcbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCB3aGljaCBuZWVkcyBzcmMvc2NyaXB0b3JpdW0vIOKAlCByZWluc3RhbGwgdGhlIHNwZWxsIG9yIGJ1aWxkIGl0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIC8vIFRoZSBkYWVtb24ncyBzdGRlcnIgZ29lcyB0byBhIExPRyBGSUxFLCBub3QgdG8gdGhpcyBDTEkncyBzdGRlcnIuIEFuXG4gIC8vIGluaGVyaXRlZCBzdGRlcnIgb3V0bGl2ZXMgdGhlIENMSSBpbnNpZGUgdGhlIGRldGFjaGVkIGRhZW1vbiwgc28gYW55IGNhbGxlclxuICAvLyB0aGF0IHJlYWRzIGBvcGVuYCdzIHN0ZGVyciB0byBFT0YgKGEgdGVzdCBoYXJuZXNzLCBhIHRvb2wgcnVubmVyKSB3YWl0cyBmb3JcbiAgLy8gdGhlIHdob2xlIHNlc3Npb24g4oCUIG1lYXN1cmVkOiB0aGUgaW50ZWdyYXRpb24gY2VsbCBodW5nIGF0IGl0cyA2MCBzIHRpbWVvdXQuXG4gIC8vIEEgZmlsZSBob2xkcyBubyBwaXBlLCBhbmQgYSBzdGFydCBmYWlsdXJlIGJlbG93IHF1b3RlcyBpdHMgdGFpbC5cbiAgY29uc3QgbG9nRGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJsb2dzXCIpO1xuICBta2RpclN5bmMobG9nRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IHRoZSBsb2dzIHVzZWQgdG8gcGlsZSB1cCwgb25lIHBlciBgb3BlbmAsIGZvcmV2ZXIuXG4gIHBydW5lTG9ncyhsb2dEaXIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihsb2dEaXIsIGBkYWVtb24tJHtEYXRlLm5vdygpfS0ke3Byb2Nlc3MucGlkfS5sb2dgKTtcbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1sb2dcIiwgbG9nUGF0aCk7XG4gIGNvbnN0IGxvZ0ZkID0gb3BlblN5bmMobG9nUGF0aCwgXCJhXCIpO1xuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgbG9nRmRdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjbG9zZVN5bmMobG9nRmQpO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0sIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBsaW5lID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzLCByZWopID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWooXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgcGFzcyAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+YCxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgc3RhcnRUaW1lb3V0TXMsXG4gICAgKTtcbiAgICBjaGlsZC5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWooZXJyKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImV4aXRcIiwgKGNvZGUpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWoobmV3IEVycm9yKGBkYWVtb24gZXhpdGVkIHdpdGggY29kZSAke2NvZGV9IGJlZm9yZSBpdHMgaGFuZHNoYWtlYCkpO1xuICAgIH0pO1xuICB9KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgbGV0IHRhaWwgPSBcIlwiO1xuICAgIHRyeSB7XG4gICAgICB0YWlsID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmOFwiKS50cmltKCkuc2xpY2UoLTgwMCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBsb2cgd3JpdHRlbiAqL1xuICAgIH1cbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gZGFlbW9uIGZhaWxlZCB0byBzdGFydDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHsgaGludDogdGFpbCA/IGBkYWVtb24gbG9nICgke2xvZ1BhdGh9KTogJHt0YWlsfWAgOiBgZGFlbW9uIGxvZzogJHtsb2dQYXRofWAgfSxcbiAgICApO1xuICB9KTtcblxuICAvLyBSZWxlYXNlIHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSwgb3IgdGhpcyBDTEkncyBuYXR1cmFsIHJldHVybiB3YWl0cyBvbiBhXG4gIC8vIHN0cmVhbSB0aGF0IG5ldmVyIGNsb3NlcyAoZ2xhbW91ciBtZWFzdXJlZCA5MSBzIOKGkiAxIHMpLiBDaGVja2VkIGZvciB0aGVcbiAgLy8gTUVUSE9EOiB1bmRlciBCdW4gdGhpcyBwaXBlIGlzIGEgcGxhaW4gUmVhZGFibGUgdGhhdCBub25ldGhlbGVzcyBoYXMgdW5yZWYuXG4gIGNvbnN0IG91dCA9IGNoaWxkLnN0ZG91dDtcbiAgaWYgKCFvdXQgfHwgIShcInVucmVmXCIgaW4gb3V0KSB8fCB0eXBlb2Ygb3V0LnVucmVmICE9PSBcImZ1bmN0aW9uXCIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzY3JpcHRvcml1bTogdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlIGhhcyBubyB1bnJlZigpOyBgb3BlbmAgd291bGQgbmV2ZXIgZXhpdFwiLFxuICAgICk7XG4gIG91dC51bnJlZigpO1xuXG4gIGxldCBoczoge1xuICAgIHVybDogc3RyaW5nO1xuICAgIHBvcnQ6IG51bWJlcjtcbiAgICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gICAgb2s/OiBib29sZWFuO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfTtcbiAgdHJ5IHtcbiAgICBocyA9IEpTT04ucGFyc2UobGluZSk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7bGluZX1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIGlmIChocy5vayA9PT0gZmFsc2UpIGRhZW1vblJlZnVzZWQoXCJvcGVuXCIsIGhzLnN0YXR1cyA/PyA1MDAsIGhzKTtcblxuICBsZXQgZW50cmllczogdW5rbm93bltdID0gW107XG4gIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgciA9IGF3YWl0IHBvc3RDbWQoaHMuc2Vzc2lvbl9pZCwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pO1xuICAgIGVudHJpZXMgPSAoci5lbnRyaWVzIGFzIHVua25vd25bXSkgPz8gW107XG4gIH1cbiAgcHJpbnRKc29uKHsgLi4uaHMsIC4uLihwYXRocy5sZW5ndGggPiAwID8geyBlbnRyaWVzIH0gOiB7fSkgfSk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW2hzLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWRkKHBvczogc3RyaW5nW10sIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZ1bGw6IGJvb2xlYW4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiP2Z1bGw9MVwiIDogXCJcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IFwic2F5IG5lZWRzIGEgbWVzc2FnZVwiXG4gICAgICAgIDogXCJzYXkgdGFrZXMgaXRzIG1lc3NhZ2UgZnJvbSBleGFjdGx5IG9uZSBwbGFjZTogYXJndW1lbnRzLCAtLXN0ZGluIG9yIC0tYm9keS1maWxlXCIsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZ2l2ZSB0aGUgdGV4dCBhcyBhcmd1bWVudHMsIG9yIHByb3NlIHRocm91Z2ggLS1ib2R5LWZpbGUgPHBhdGg+IC8gLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIixcbiAgICAgICAgY2hvaWNlczogW1wiLS1zdGRpblwiLCBcIi0tYm9keS1maWxlXCJdLFxuICAgICAgfSxcbiAgICApO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBpZiAoZmxhZ3Muc3RkaW4gPT09IHRydWUpIHRleHQgPSBhd2FpdCBuZXcgUmVzcG9uc2UoQnVuLnN0ZGluLnN0cmVhbSgpKS50ZXh0KCk7XG4gIGVsc2UgaWYgKHR5cGVvZiBmbGFnc1tcImJvZHktZmlsZVwiXSA9PT0gXCJzdHJpbmdcIikgdGV4dCA9IHJlYWRGaWxlU3luYyhmbGFnc1tcImJvZHktZmlsZVwiXSwgXCJ1dGY4XCIpO1xuICBlbHNlIHRleHQgPSBwb3Muam9pbihcIiBcIik7XG4gIGlmICghdGV4dC50cmltKCkpIGRpZShcInNheTogdGhlIG1lc3NhZ2UgaXMgZW1wdHlcIiwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHRleHQudHJpbSgpO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIHRhaWwgaGFzIGFscmVhZHkgcmVwb3J0ZWQgdGhhdCBpdCBsb3N0IHRoZSBkYWVtb24gKEU1NSkuIE1vZHVsZVxuICogc2NvcGUgYmVjYXVzZSBhIHRhaWwgaXMgb25lIHByb2Nlc3MgZG9pbmcgb25lIHRoaW5nLCBhbmQgdGhlIHR3byBob29rcyB0aGF0XG4gKiByZWFkIGl0IGFyZSBoYW5kZWQgdG8gYSBjbGllbnQgdGhhdCBvd25zIGl0cyBvd24gbG9vcC5cbiAqL1xubGV0IGRpc2Nvbm5lY3RlZCA9IGZhbHNlO1xuXG4vKipcbiAqIFRoZSB3YXRjaC4gRW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyBjYXAgd2l0aCBvbmUgbGluZSBuYW1pbmcgdGhlIG5leHRcbiAqIGFjdCAoYHNyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50c2ApOiByZS1hcm0gTW9uaXRvciwgZ28gdG8gYSBiYWNrZ3JvdW5kXG4gKiBgLS1vbmNlYCwgb3IgY29tZSBiYWNrIGZyb20gYSBjbG9zZWQgb3IgbG9zdCBzZXNzaW9uIHdpdGggYG9wZW4gLS1yZXN0b3JlYC5cbiAqIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU6IHRoZSBhZ2VudCBhbHJlYWR5IGtub3dzIHRoZVxuICogc2Vzc2lvbiwgYW5kIHRoZSBsaW5lIHdvdWxkIGNvdW50IGFzIG5vaXNlIGluIHRoZSB3aW5kb3cncyB3YWtlLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKFxuICBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHNpbmNlOiBudW1iZXIsXG4gIG86IHsgb25jZTogYm9vbGVhbjsgc2luY2VHaXZlbjogYm9vbGVhbjsgZXBvY2g/OiBzdHJpbmcgfSxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgY29uc3QgcmVBcm0gPSBzZXNzaW9uICE9PSB1bmRlZmluZWQgfHwgby5zaW5jZUdpdmVuO1xuICBsZXQgZ3JvdW5kZWQgPSBvLnNpbmNlR2l2ZW47XG4gIGNvbnN0IHBpbiA9ICgpID0+IChib3VuZElkICE9PSB1bmRlZmluZWQgPyBbXCItLXNlc3Npb25cIiwgYm91bmRJZF0gOiBbXSk7XG4gIHJldHVybiBhd2FpdCB0YWlsV2l0aEhhbmRvZmY8eyBpZD86IG51bWJlcjsgZXBvY2g/OiBzdHJpbmc7IHR5cGU/OiBzdHJpbmcgfT4oXG4gICAge1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICAgIGlmICghcykgcmV0dXJuIG51bGw7XG4gICAgICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDtcbiAgICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHsgZXZlclJlc29sdmVkIH0pID0+IHtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCBnaXZlbiAtLXNlc3Npb24gb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkdcbiAgICAgICAgLy8gc2Vzc2lvbiwgc28gbm90IGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkIChpbiB0aGUgZ2FwLCBzYXkpIOKAlCB0aGVcbiAgICAgICAgLy8gaGFuZG9mZiBzYXlzIGB0YWlsLmNsb3NlZGAsIG5ldmVyIGEgc2lsZW50IHJldHJ5LWZvcmV2ZXIuXG4gICAgICAgIGlmIChldmVyUmVzb2x2ZWQgfHwgcmVBcm0pIHJldHVybiBcInN0b3BcIjtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgICAgcmV0dXJuIFwicmV0cnlcIjtcbiAgICAgIH0sXG4gICAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICAgIHNpbmNlLFxuICAgICAgLi4uKG8uZXBvY2ggPyB7IHNpbmNlRXBvY2g6IG8uZXBvY2ggfSA6IHt9KSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+ICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgPyBldi5pZCA6IHVuZGVmaW5lZCksXG4gICAgICBlcG9jaE9mOiAoZXYpID0+ICh0eXBlb2YgZXYuZXBvY2ggPT09IFwic3RyaW5nXCIgPyBldi5lcG9jaCA6IHVuZGVmaW5lZCksXG4gICAgICAvLyBBIGRpZmZlcmVudCBlcG9jaCBvbiByZWNvbm5lY3QgPSB0aGUgZGFlbW9uIHJlc3RhcnRlZDsgaWRzIGJlZ2FuIGFnYWluLlxuICAgICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICAgIC8vIOKblCBBIEtFRVBBTElWRSBJUyBQUk9PRiBPRiBMSUZFLCBzbyBpdCBpcyBhbHNvIHdoYXQgY2xlYXJzIGEgcmVwb3J0ZWRcbiAgICAgIC8vIGRpc2Nvbm5lY3Rpb24uIFRoZXJlIGlzIG5vIGBvbkNvbm5lY3RgIGhvb2sgYW5kIHRoaXMgaXMgdGhlIGhvbmVzdFxuICAgICAgLy8gc3Vic3RpdHV0ZTogdGhlIGRhZW1vbiBvbmx5IHNlbmRzIGNvbW1lbnRzIGRvd24gYSBsaXZlIHN0cmVhbS5cbiAgICAgIG9uQ29tbWVudDogKCkgPT4ge1xuICAgICAgICBpZiAoIWRpc2Nvbm5lY3RlZCkgcmV0dXJuIFwiOiBzY3JpcHRvcml1bS1rZWVwYWxpdmVcIjtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwidGFpbC5yZWNvbm5lY3RlZFwiIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIOKblCBPTkUgTElORSBQRVIgRVBJU09ERSwgTk9UIFBFUiBBVFRFTVBULiBUaGUgY2xpZW50IHJlY29ubmVjdHMgd2l0aFxuICAgICAgLy8gYmFja29mZiBmb3JldmVyLCBzbyBhIGhvb2sgdGhhdCBzcG9rZSBldmVyeSB0aW1lIHdvdWxkIGVtaXQgYSBsaW5lIGV2ZXJ5XG4gICAgICAvLyBmZXcgc2Vjb25kcyBmb3IgYXMgbG9uZyBhcyB0aGUgZGFlbW9uIHN0YXllZCBkb3duIOKAlCB3aGljaCBpcyBob3cgYVxuICAgICAgLy8gd2F0Y2hlciBnZXRzIG11dGVkLCBhbmQgdGhlbiBub2JvZHkgaGVhcnMgdGhlIG5leHQgcmVhbCB0aGluZy5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgV0hZIFRISVMgRVhJU1RTIEFUIEFMTDogd2l0aG91dCBpdCBhIERFQUQgZGFlbW9uIGFuZCBhIFFVSUVUIG9uZSBhcmVcbiAgICAgIC8vIHRoZSBzYW1lIHRoaW5nIGZyb20gb3V0IGhlcmUuIEEgZ3JhY2VmdWwgY2xvc2UgZW1pdHMgYGNsb3NlZGAgYW5kIGVuZHNcbiAgICAgIC8vIHRoZSB0YWlsOyBhIGNyYXNoLCBhIGtpbGwgLTkgb3IgYSBzbGVlcGluZyBsYXB0b3AgZW1pdHMgbm90aGluZywgdGhlXG4gICAgICAvLyBjbGllbnQgcmV0cmllcyBpbiBzaWxlbmNlLCBhbmQgdGhlIGFic2VuY2Ugb2YgZXZlbnRzIGlzIG5vdCBhbiBldmVudC4gQVxuICAgICAgLy8gd2F0Y2hlciB3YWl0aW5nIGZvciB0aGUgaHVtYW4ncyBuZXh0IG1lc3NhZ2Ugd291bGQgd2FpdCBmb3JldmVyIGFuZFxuICAgICAgLy8gbmV2ZXIgbGVhcm4gaXQgaGFkIHN0b3BwZWQgbGlzdGVuaW5nLiAoRm91bmQgMjAyNi0wOS0xNCB3aGlsZSBhbnN3ZXJpbmdcbiAgICAgIC8vIENvbGUncyBxdWVzdGlvbiBhYm91dCB3aGV0aGVyIGEgdGltZW91dCB3b3VsZCBub3RpZnkgbWUuIEl0IHdvdWxkIG5vdC4pXG4gICAgICBvbkRpc2Nvbm5lY3Q6ICh7IGNhdXNlLCBzdGF0dXMgfSkgPT4ge1xuICAgICAgICBpZiAoZGlzY29ubmVjdGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwuZGlzY29ubmVjdGVkXCIsXG4gICAgICAgICAgY2F1c2UsXG4gICAgICAgICAgLi4uKHN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBzdGF0dXMgfSA6IHt9KSxcbiAgICAgICAgICBub3RlOiBcInJldHJ5aW5nOyB0aGUgc2Vzc2lvbiBtYXkgaGF2ZSBjbG9zZWQgb3IgY3Jhc2hlZFwiLFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJzY3JpcHRvcml1bVwiLFxuICAgICAgbW9kZTogby5vbmNlID8gXCJvbmNlXCIgOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogZmFsc2UsXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQsIG9uY2UsIGVwb2NoIH0pID0+IHRhaWxDb21tYW5kKFtcInRhaWxcIiwgLi4ucGluKCldLCBhdCwgb25jZSwgZXBvY2gpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tcmVzdG9yZVwiLCBib3VuZElkID8/IFwiPGlkPlwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuLy9cbi8vIFRocm91Z2ggdGhlIGhvdXNlJ3Mgb25lIHJlZ2lzdHJ5IChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgKS4gc2NyaXB0b3JpdW0nc1xuLy8gb3duIGRpc3BhdGNoZXIsIGhlbHAgcmVuZGVyZXIgYW5kIGRlY2xhcmF0aW9uIGVtaXR0ZXIg4oCUIGEgY29weSBvZiBnbGFtb3VyJ3Mg4oCUXG4vLyB3ZXJlIGRlbGV0ZWQgd2hlbiBpdCBtb3ZlZCBvbnRvIHRoZSBtb2R1bGUuIGBoZWxwYCwgYHZlcnNpb25gIGFuZCBgc2NoZW1hYFxuLy8gYXJlIHRoZSBtb2R1bGUncyByb3dzOiBkZWNsYXJlZCBhbmQgc3RyaWN0LCBzbyBgdmVyc2lvbiAtLWJvZ3VzYCBpcyByZWZ1c2VkXG4vLyAoaXQgZXhpdGVkIDAgd2hpbGUgYHZlcnNpb25gIHdhcyBhbnN3ZXJlZCBiZWZvcmUgdGhlIHRhYmxlKS5cblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuLyoqIEEgcm93IGFzIHNjcmlwdG9yaXVtIHdyaXRlcyBpdDogdGhlIGhhbmRsZXIgdGFrZXMgYChwb3MsIGZsYWdzLCBzZXNzaW9uKWAsXG4gKiAgYW5kIGBvbmAgYWRhcHRzIGl0IHRvIHRoZSBraXQncyBgcnVuKGludilgLiBBIG51bWJlciByZXR1cm5lZCBpcyB0aGUgZXhpdFxuICogIGNvZGUgKGB0YWlsYCk7IGFueXRoaW5nIGVsc2UgaXMgMC4gKi9cbnR5cGUgUm93ID0gT21pdDxDb21tYW5kU3BlYzxGbGFnPiwgXCJydW5cIiB8IFwicmVqZWN0SGludFwiPiAmIHtcbiAgcnVuOiAocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHVua25vd247XG59O1xuXG4vKiogc2NyaXB0b3JpdW0gZGVjbGFyZXMgbm8gYG11bHRpcGxlYCBmbGFnLCBzbyBldmVyeSB2YWx1ZSBpcyBhIHN0cmluZyBvciBhXG4gKiAgYm9vbGVhbiDigJQgdGhlIGBGbGFnc2AgdGhlIGhhbmRsZXJzIHRha2UuICovXG5jb25zdCBvbiA9XG4gIChoOiBSb3dbXCJydW5cIl0pID0+XG4gIChpbnY6IEludm9jYXRpb248RmxhZz4pOiB1bmtub3duID0+IHtcbiAgICBjb25zdCBmbGFncyA9IGludi5mbGFncyBhcyBGbGFncztcbiAgICByZXR1cm4gaChpbnYucG9zLCBmbGFncywgdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkKTtcbiAgfTtcblxuLyoqIEV2ZXJ5IGZsYWcgcmVqZWN0aW9uJ3MgaGludDogdGhlIG9uZSByZXBhaXIgZm9yIHByb3NlIGluIHdoaWNoIGEgd29yZFxuICogIGhhcHBlbnMgdG8gc3RhcnQgd2l0aCBgLS1gLiAqL1xuY29uc3QgREFTSF9ISU5UID0gXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCI7XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IFJPV1M6IFJvd1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKSwgYWRkaW5nIHBhdGhzOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH0uIC0tdGltZW91dCA8c2Vjb25kcz4gc2V0cyB0aGUgaWRsZSBjbG9zZSAoZGVmYXVsdCAxODAwKTsgLS10aW1lb3V0IDAgc3RhbmRzIHVudGlsIGNsb3NlZFwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIiwgXCJvbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwidGhlIGh1bWFuJ3MgbWVzc2FnZXMgKHdpdGggc2VsZWN0aW9uICsgYWN0aXZlIHBhdGgpIGFzIEpTT04gbGluZXMg4oCUIHdyYXAgd2l0aCBNb25pdG9yOyBpdHMgbGFzdCBsaW5lIG5hbWVzIHRoZSBuZXh0IGFjdFwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBiID0gdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VUYWlsU2luY2UoZmxhZ3Muc2luY2UpIDogeyBzaW5jZTogLTEgfTtcbiAgICAgIHJldHVybiBjbWRUYWlsKHNlc3Npb24sIGIuc2luY2UsIHtcbiAgICAgICAgb25jZTogZmxhZ3Mub25jZSA9PT0gdHJ1ZSxcbiAgICAgICAgc2luY2VHaXZlbjogdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiLFxuICAgICAgICAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tbmV3XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZyb21cIiwgXCJsYWJlbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIHZlcnNpb24gKGRlZmF1bHQ6IHRoZSBhY3RpdmUgb25lKSB0byBhIG5ldyBmaWxlOyBwcmludHMgaXRzIHBhdGggdG8gZWRpdFwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gdHlwZW9mIGZsYWdzLmZyb20gPT09IFwic3RyaW5nXCIgPyBwYXJzZVZlcnNpb24oZmxhZ3MuZnJvbSwgXCItLWZyb21cIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIC4uLihmcm9tICE9PSB1bmRlZmluZWQgPyB7IGZyb20gfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8geyBsYWJlbDogZmxhZ3MubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNheVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicG9zdCBhIGNoYXQgbWVzc2FnZSBmcm9tIHRoZSBhZ2VudCAocHJvc2U6IC0tYm9keS1maWxlIDxwYXRoPiBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzYXlcIiwgdGV4dDogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncykgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ2TlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJyZW1vdmUgYSB2ZXJzaW9uIGFuZCBpdHMgZmlsZSAobmV2ZXIgdGhlIGFjdGl2ZSBvbmUg4oCUIGFjdGl2YXRlIGFub3RoZXIgZmlyc3QpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInZlcnNpb24uZGVsZXRlXCIsXG4gICAgICAgICAgdmVyc2lvbjogcGFyc2VWZXJzaW9uKHBvc1swXSA/PyBcIlwiLCBcInZlcnNpb24tZGVsZXRlXCIpLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJzYXkgeW91IGhhdmUgc3RhcnRlZCBzb21ldGhpbmc7IHByaW50cyB0aGUgaWQgdG8gZmluaXNoIGl0IHdpdGhcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInRhc2suc3RhcnRcIiwgdGV4dDogYXdhaXQgcmVhZFNheUJvZHkocG9zLCBmbGFncykgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2stc3RhdHVzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInN0YXR1c1wiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNheSB3aGF0IHN0ZXAgYSB0YXNrIGlzIG9uIChmb3Igd29yayB3b3J0aCB3YXRjaGluZylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suc3RhdHVzXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgc3RhdHVzOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIiksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLWRvbmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwib3V0Y29tZVwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgdGFzayBmaW5pc2hlZCwgb3B0aW9uYWxseSBzYXlpbmcgd2hhdCBjYW1lIG9mIGl0XCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IG91dGNvbWUgPSBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suZG9uZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLihvdXRjb21lID8geyBvdXRjb21lIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnJlbW92ZVwiLCBpZDogcG9zWzBdIGFzIHN0cmluZyB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza3MtY2xlYXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiZm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2s7IG91dHN0YW5kaW5nIG9uZXMgYXJlIGxlZnQgYWxvbmVcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrcy5jbGVhclwiIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3JraW5nXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZvclwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBhcmUgc3RpbGwgb24gaXQg4oCUIHNpbGVuY2VzIHRoZSB3YWl0aW5nIG51ZGdlLCBrZWVwcyB0aGUgaHVtYW4ncyBwdWxzZVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBzZWNvbmRzID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLmZvciA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MuZm9yLCBcIndvcmtpbmcgLS1mb3JcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwid29ya2luZ1wiLFxuICAgICAgICAgIC4uLihzZWNvbmRzICE9PSB1bmRlZmluZWQgPyB7IHNlY29uZHMgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwicXVvdGVcIiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcIm5vdGUgYSBwYXNzYWdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbiAoLS1xdW90ZSAnZXhhY3QgdGV4dCc7IHByb3NlOiAtLWJvZHktZmlsZSBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MucXVvdGUgIT09IFwic3RyaW5nXCIgfHwgZmxhZ3MucXVvdGUudHJpbSgpID09PSBcIlwiKVxuICAgICAgICBkaWUoXCJub3RlOiAtLXF1b3RlIGlzIHJlcXVpcmVkIOKAlCB0aGUgZXhhY3QgdGV4dCB0aGUgbm90ZSBpcyBhYm91dFwiLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIHN0YXRlIC0tZnVsbCAodGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBpcyBvbiBkaXNrOyBxdW90ZSBmcm9tIGl0KVwiLFxuICAgICAgICB9KTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZFwiLFxuICAgICAgICAgIHF1b3RlOiBmbGFncy5xdW90ZSxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZXNcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwiZnVsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwidGhlIG5vdGVzIG9uIGEgZG9jdW1lbnQsIHBsYWNlZCBpbiB0aGUgYWN0aXZlIHZlcnNpb24gKC0tZnVsbCBpbmNsdWRlcyByZXNvbHZlZClcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGVzXCIsXG4gICAgICAgICAgLi4uKGZsYWdzLmZ1bGwgPyB7IGFsbDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLWVkaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmV3cml0ZSB3aGF0IGEgbm90ZSBzYXlzIChpdHMgcGFzc2FnZSBpcyB1bmNoYW5nZWQpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuZWRpdFwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIGJvZHk6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcy5zbGljZSgxKSwgZmxhZ3MpLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlc29sdmVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwicmVvcGVuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcIm1hcmsgYSBub3RlIGRlYWx0IHdpdGggKC0tcmVvcGVuIHB1dHMgaXQgYmFjaylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibm90ZS5yZXNvbHZlXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgcmVzb2x2ZWQ6ICFmbGFncy5yZW9wZW4sXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGUtcmVtb3ZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBub3RlXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVtb3ZlXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRpZmZcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwiY29udGV4dFwiLCBcInBhdGNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImFnYWluc3RcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImNvbXBhcmUgdGhlIGFjdGl2ZSB2ZXJzaW9uIHdpdGggYW5vdGhlciAodk4gb3IgJ3NhdmVkJyBmb3IgdGhlIGZpbGUgb24gZGlzayk7IC0tcGF0Y2ggZm9yIHBsYWluIHVuaWZpZWQgdGV4dFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiZGlmZlwiLFxuICAgICAgICBhZ2FpbnN0OiBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwiZGlmZlwiKSxcbiAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5jb250ZXh0ID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgPyB7IGNvbnRleHQ6IHBhcnNlQ291bnQoZmxhZ3MuY29udGV4dCwgXCItLWNvbnRleHRcIikgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSkpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgaWYgKGZsYWdzLnBhdGNoKSBwcm9jZXNzLnN0ZG91dC53cml0ZShTdHJpbmcoci51bmlmaWVkID8/IFwiXCIpKTtcbiAgICAgIGVsc2UgcHJpbnRKc29uKHIpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1lcmdlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImh1bmtzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImFnYWluc3RcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInRha2UgY2hhbmdlcyBmcm9tIGFub3RoZXIgdmVyc2lvbiBpbnRvIHRoZSBhY3RpdmUgb25lICgtLWh1bmtzIDEsMzsgZGVmYXVsdDogYWxsIG9mIHRoZW0pXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWdhaW5zdCA9IHBhcnNlU2lkZShwb3NbMF0gPz8gXCJcIiwgXCJtZXJnZVwiKTtcbiAgICAgIC8vIOKblCBXaXRob3V0IC0taHVua3MgdGhpcyB0YWtlcyBFVkVSWSBodW5rLCB3aGljaCBpcyB0aGUgd2hvbGUtZG9jdW1lbnRcbiAgICAgIC8vIG1lcmdlLiBUaGUgaWRzIGNvbWUgZnJvbSBgZGlmZmAgYW5kIGFyZSBvbmx5IHZhbGlkIGFnYWluc3QgdGhlIHRleHQgaXRcbiAgICAgIC8vIHNhdzogdGhlIGRhZW1vbiByZS1kaWZmcyBhbmQgcmVmdXNlcyBpZHMgaXQgY2Fubm90IGZpbmQgcmF0aGVyIHRoYW5cbiAgICAgIC8vIGFwcGx5aW5nIGEgbnVtYmVyIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbW92ZWQgdW5kZXJuZWF0aCBpdC5cbiAgICAgIGNvbnN0IGxpc3RlZCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5odW5rcyA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8gZmxhZ3MuaHVua3Muc3BsaXQoXCIsXCIpLm1hcCgoaCkgPT4gcGFyc2VDb3VudChoLCBcIi0taHVua3NcIikpXG4gICAgICAgICAgOiBudWxsO1xuICAgICAgY29uc3QgaHVua3MgPVxuICAgICAgICBsaXN0ZWQgPz9cbiAgICAgICAgKFxuICAgICAgICAgIChhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZGlmZlwiLFxuICAgICAgICAgICAgYWdhaW5zdCxcbiAgICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgICAgfSkpIGFzIHsgaHVua3M/OiB7IGlkOiBudW1iZXIgfVtdIH1cbiAgICAgICAgKS5odW5rcz8ubWFwKChoKSA9PiBoLmlkKSA/P1xuICAgICAgICBbXTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJtZXJnZVwiLFxuICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgaHVua3MsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGl2YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ2TlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYWtlIGEgdmVyc2lvbiB0aGUgYWN0aXZlIG9uZSAodGhlIG9uZSB0aGUgaHVtYW4gZWRpdHMgYW5kIFNhdmUgd3JpdGVzKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJhY3RpdmF0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJhY3RpdmF0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibmV3LWRvY1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImNyZWF0ZSBhbiBlbXB0eSBkb2N1bWVudCAoaXRzIGZvbGRlciBtdXN0IGJlIGEgc2V0LCBhIGZvbGRlciBpbiBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFicyA9IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyk7XG4gICAgICByZXR1cm4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2MuY3JlYXRlXCIsIGRpcjogZGlybmFtZShhYnMpLCBuYW1lOiBiYXNlbmFtZShhYnMpIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1mb2xkZXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImNyZWF0ZSBhIGZvbGRlciDigJQgaW5zaWRlIGEgc2V0LCBvciBpbiB0aGUgd29ya3NwYWNlIGFzIGEgbmV3IHNldFwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgICAgICBkaXI6IGRpcm5hbWUoYWJzKSxcbiAgICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1vdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpbnRvXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtb3ZlIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGludG8gYW5vdGhlciBmb2xkZXIgKGEgcmVhbCBtb3ZlIG9uIGRpc2spXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcIm1vdmVcIixcbiAgICAgICAgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSxcbiAgICAgICAgaW50bzogcmVzb2x2ZShwb3NbMV0gYXMgc3RyaW5nKSxcbiAgICAgIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZW5hbWVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJyZW5hbWUgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gcGxhY2VcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwicmVuYW1lXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksIG5hbWU6IHBvc1sxXSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGlkZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgZG9jdW1lbnQsIGZvbGRlciBvciBzZXQgZnJvbSBTY3JpcHRvcml1bSDigJQgdGhlIGZpbGVzIHN0YXkgb24gZGlza1wiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJoaWRlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInVuaGlkZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImVudHJ5XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImJyaW5nIGJhY2sgZXZlcnl0aGluZyBoaWRkZW4gaW4gYSBzZXQgKGl0cyBlbnRyeSBpZCwgZnJvbSBzdGF0ZSlcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJ1bmhpZGVcIiwgZW50cnk6IHBvc1swXSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFrZS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInR1cm4gYSBzaW5nbGUgZG9jdW1lbnQgaW50byBhIHNldDogYSBmb2xkZXIgbmFtZWQgZm9yIGl0LCB0aGUgZG9jdW1lbnQgbW92ZWQgaW5cIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwic2V0Lm1ha2VcIiwgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW1wb3J0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImludG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiZmlsZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjb3B5IGEgZG9jdW1lbnQgaW4gKGRlZmF1bHQ6IGludG8gdGhlIHdvcmtzcGFjZSkgYW5kIHNob3cgdGhlIGNvcHlcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgY21kSW1wb3J0KHBvc1swXSBhcyBzdHJpbmcsIHR5cGVvZiBmbGFncy5pbnRvID09PSBcInN0cmluZ1wiID8gZmxhZ3MuaW50byA6IHVuZGVmaW5lZCwgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndvcmtzcGFjZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImRpclwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHdvcmtzcGFjZSAod2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQpLCBvciBzZXQgaXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kV29ya3NwYWNlKHBvc1swXSwgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ldGFcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBkZXNjcmliZTogXCJhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgYXMgdGhlIGRhZW1vbiByZWFkIGl0IChubyBwYXRoOiBldmVyeSBjb250ZXh0IGRvY3VtZW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWV0YVwiLFxuICAgICAgICAgIC4uLihwb3NbMF0gIT09IHVuZGVmaW5lZCA/IHsgcGF0aDogcmVzb2x2ZShwb3NbMF0pIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmaW5kXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInR5cGVcIiwgXCJzdGF0dXNcIiwgXCJsaWZlY3ljbGVcIiwgXCJ0YWdcIiwgXCJzaW5jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImRvY3VtZW50cyBieSBmcm9udG1hdHRlciDigJQgZmlsdGVycyBBTkQsIGFsbCBvcHRpb25hbDsgYW4gZW1wdHkgcmVzdWx0IGlzIGFuIGFuc3dlciAoY291bnQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpbHRlcjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrIG9mIFtcInR5cGVcIiwgXCJzdGF0dXNcIiwgXCJsaWZlY3ljbGVcIiwgXCJ0YWdcIl0gYXMgY29uc3QpXG4gICAgICAgIGlmICh0eXBlb2YgZmxhZ3Nba10gPT09IFwic3RyaW5nXCIpIGZpbHRlcltrXSA9IGZsYWdzW2tdO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIikgZmlsdGVyLnNpbmNlID0gcGFyc2VTaW5jZURhdGUoZmxhZ3Muc2luY2UpO1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImZpbmRcIiwgZmlsdGVyIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZWFyY2hcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwibGltaXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicXVlcnlcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzZWFyY2ggdGhlIGNvbnRleHQ6IGZ1enp5IG9uIG5hbWVzLCBleGFjdCBpbiB0ZXh0IOKAlCBzZWFyY2hlcyB0aGUgQUNUSVZFIHZlcnNpb24gb2Ygb3BlbiBkb2N1bWVudHMsIHdoaWNoIGdyZXAgY2Fubm90IHNlZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGxpbWl0ID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLmxpbWl0ID09PSBcInN0cmluZ1wiID8gcGFyc2VDb3VudChmbGFncy5saW1pdCwgXCJzZWFyY2ggLS1saW1pdFwiKSA6IHVuZGVmaW5lZDtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJzZWFyY2hcIixcbiAgICAgICAgICBxdWVyeTogcG9zLmpvaW4oXCIgXCIpLFxuICAgICAgICAgIC4uLihsaW1pdCAhPT0gdW5kZWZpbmVkID8geyBsaW1pdCB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9jdG9yXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ3aGF0IGlzIHdvcnRoIGxvb2tpbmcgYXQgaW4gdGhpcyBzZXNzaW9uIOKAlCBlYWNoIGZpbmRpbmcgbmFtZXMgdGhlIHZlcmIgdGhhdCBmaXhlcyBpdFwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImRvY3RvclwiIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmb3JnZXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwiZm9yZ2V0IGEgZG9jdW1lbnQgd2hvc2UgZmlsZSBvZiByZWNvcmQgaXMgZ29uZSAocmVmdXNlZCB3aGlsZSB0aGUgZmlsZSBleGlzdHMg4oCUIHVzZSBoaWRlIHRvIHRha2Ugb25lIG91dCBvZiB0aGUgY29udGV4dClcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcImZvcmdldFwiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkYW5nbGluZ1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJlbnRyeVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwibGlua3MgaW4gYSBzZXQgdGhhdCBub3RoaW5nIGFuc3dlcnMg4oCUIGZpbGUsIGxpbmUsIGFuZCB0aGUgdGFyZ2V0IGFzIHdyaXR0ZW5cIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcImRhbmdsaW5nXCIsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5lbnRyeSA9PT0gXCJzdHJpbmdcIiA/IHsgZW50cnk6IGZsYWdzLmVudHJ5IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmFwaFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJlbnRyeVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImEgc2V0J3MgbWFwIGFzIEpTT04g4oCUIG5vZGVzLCBlZGdlcyAoYm9keSBsaW5rcyBhbmQgZnJvbnRtYXR0ZXIga2VwdCBhcGFydCksIGRhbmdsaW5nXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYmFja2xpbmtzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ3aGF0IGNpdGVzIGEgZG9jdW1lbnQg4oCUIGByZWxhdGVkYCAoZnJvbnRtYXR0ZXIpIGFuZCBgbGlua3NgIChib2R5KSwga2VwdCBhcGFydFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiYmFja2xpbmtzXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ldGEtaW5pdFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwiYnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwiYWRkIGEgZnJvbnRtYXR0ZXIgYmxvY2sgdG8gYSBkb2N1bWVudCB0aGF0IGhhcyBub25lICh0eXBlIGd1ZXNzZWQgZnJvbSBpdHMgbmVpZ2hib3VycylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLnR5cGUgPT09IFwic3RyaW5nXCIgPyB7IG1ldGFUeXBlOiBmbGFncy50eXBlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5ieSA9PT0gXCJzdHJpbmdcIiA/IHsgYnk6IGZsYWdzLmJ5IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLXNldFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImtleT12YWx1ZVwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNldCBmcm9udG1hdHRlciBrZXlzIOKAlCBvbmUgbGluZSBlZGl0IGVhY2gsIGV2ZXJ5dGhpbmcgZWxzZSB1bnRvdWNoZWRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgICBmb3IgKGNvbnN0IHBhaXIgb2YgcG9zLnNsaWNlKDEpKSB7XG4gICAgICAgIGNvbnN0IGVxID0gcGFpci5pbmRleE9mKFwiPVwiKTtcbiAgICAgICAgaWYgKGVxIDw9IDApXG4gICAgICAgICAgZGllKGBcIiR7cGFpcn1cIiBpcyBub3Qga2V5PXZhbHVlYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBoaW50OiBcIm1ldGEtc2V0IDxwYXRoPiBzdGF0dXM9c3RhYmxlIGxpZmVjeWNsZT1saXZlXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGZpZWxkc1twYWlyLnNsaWNlKDAsIGVxKV0gPSBwYWlyLnNsaWNlKGVxICsgMSk7XG4gICAgICB9XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIm1ldGEuc2V0XCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksIGZpZWxkcyB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJwcmludCB0aGUgcmVzb2x2ZWQgc2Vzc2lvbiBwb2ludGVyXCIsXG4gICAgcnVuOiAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24ocmVxdWlyZVNlc3Npb24oc2Vzc2lvbikpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInNodXQgdGhlIHNlc3Npb24gZG93biAodGhlIG1hbmlmZXN0IHN0YXlzLCBmb3Igb3BlbiAtLXJlc3RvcmUpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pO1xuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IFwiY2xvc2VcIiB9KTtcbiAgICB9LFxuICB9LFxuXTtcblxuLy8g4puUIEJVSUxESU5HIFRIRSBUQUJMRSBIQVMgTk8gU0lERSBFRkZFQ1RTOiBgZGVmaW5lQ2xpYCBvbmx5IHZhbGlkYXRlcyBhbmRcbi8vIGluZGV4ZXMsIHNvIGEgd2FyZCBvciBhIHRlc3QgY2FuIGltcG9ydCB0aGlzIG1vZHVsZSBhbmQgcmVhZCB0aGUgdGFibGUuXG5leHBvcnQgY29uc3QgY2xpID0gZGVmaW5lQ2xpKHtcbiAgbmFtZTogXCJzY3JpcHRvcml1bVwiLFxuICBzdW1tYXJ5OiBcImEgY28tcHJlc2VudCBtYXJrZG93biBlZGl0b3I6IHRoZSBodW1hbiBlZGl0cywgeW91IHdyaXRlIG5ldyB2ZXJzaW9ucy5cIixcbiAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gIGNvbW1hbmRzOiBST1dTLm1hcCgocikgPT4gKHsgLi4uciwgcnVuOiBvbihyLnJ1biksIHJlamVjdEhpbnQ6IERBU0hfSElOVCB9KSksXG4gIC8vIGBzY3JpcHRvcml1bSAtLXNlc3Npb24geCBzdGF0ZWAgcnVucyBgc3RhdGVgOyBhIGJhcmUgYC0tYCBtYWtlcyB0aGUgbmV4dFxuICAvLyB0b2tlbiB0aGUgdmVyYiAoYWNjIEE2KS5cbiAgZ3JhbW1hcjogXCJmbGFncy1hbnl3aGVyZVwiLFxuICB2ZXJiUG9zaXRpb25hbDogXCJ2ZXJiXCIsXG4gIHVzYWdlSGlkZXM6IFtcInNlc3Npb25cIl0sXG4gIHZlcnNpb246IHZlcnNpb25JbmZvLFxuICBoZWxwRm9vdGVyOiBgICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gYW55IHZlcmIgdGhhdCB0YWxrcyB0byBhIHNlc3Npb24gKGRlZmF1bHQ6IG1vc3QgcmVjZW50KS5cbiAgRWFjaCB2ZXJiIGFjY2VwdHMgb25seSB0aGUgZmxhZ3Mgb24gaXRzIHJvdy5cblxuICBPdXRwdXQ6IEpTT04gb24gc3Rkb3V0LCBvbmUgZG9jdW1lbnQgcGVyIGFuc3dlciDigJQgZXhjZXB0IHRhaWwgKG9uZSBKU09OIGxpbmVcbiAgcGVyIGV2ZW50KSBhbmQgaGVscCAocHJvc2UpLiBGYWlsdXJlczogb25lIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyLCBleGl0XG4gIDIgPSB1c2FnZSwgMSA9IGludGVybmFsLCA1ID0gbm90IGZvdW5kLCA2ID0gY29uZmxpY3QuIHRhaWwgd2FpdHMgZm9yIGFcbiAgc2Vzc2lvbiByYXRoZXIgdGhhbiBmYWlsaW5nLCBhbmQgZW5kcyAwIHdoZW4gaXRzIHNlc3Npb24gY2xvc2VzLiB0YWlsXG4gICR7V0lORE9XX0hFTFB9LmAsXG59KTtcblxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS52ZXJicztcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgY2xpLnJvd3MubWFwKChyKSA9PiBbci5uYW1lLCByLmFjY2VwdGVkXSksXG4pO1xuZXhwb3J0IGNvbnN0IGZsYWdzRm9yID0gKHZlcmI6IHN0cmluZyk6IHN0cmluZ1tdID0+IGNsaS5mbGFnc0Zvcih2ZXJiKTtcbmV4cG9ydCBjb25zdCBSRUNPR05JWkVEX0ZMQUdTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS5yZWNvZ25pemVkRmxhZ3M7XG5cbi8vIGBkaXNwYXRjaGAsIG5vdCB0aGUgcmVnaXN0cnkncyBgbWFpbmA6IHRoZSBraXQgZG9lcyBub3QgdHJpYWdlIGEgbm9uLUNsaUVycm9yO1xuLy8gdGhpcyBkb2VzLiBBIG5hbWVkIGZpbGUgdGhhdCBpcyBub3QgdGhlcmUgKC0tYm9keS1maWxlKSBpcyB0aGUgY2FsbGVyJ3M7XG4vLyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBjbGkuZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IFVzYWdlRXJyb3IobXNnKSkgPz8gMjtcbiAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgbXNnKSkgPz8gMTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSByZWdpc3RyeTogb25lIHRhYmxlIGRyaXZlcyB0aGUgcGFyc2VyLCB0aGUgZGlzcGF0Y2hlcixcbiAqIGhlbHAsIHRoZSByZWplY3Rpb25zJyBgY2hvaWNlc2AsIGAtLXZlcnNpb25gIGFuZCB0aGUgYWNjIGRlY2xhcmF0aW9uXG4gKiAoYHNjaGVtYWAsIGZvcm1hdCB2MCkuXG4gKlxuICogR2VuZXJhbGlzZWQgZnJvbSB0aGUgdGhyZWUgaGFuZC1idWlsdCByZWdpc3RyaWVzIChncmFwZXZpbmUsIGdsYW1vdXIsXG4gKiBzY3JpcHRvcml1bSkgcGVyIGBkb2NzL2l0ZW1zL3NoYXJlZC1jbGktcmVnaXN0cnktaW4tdGhlLWtpdC93cml0ZS11cC5tZGAsIGFzXG4gKiBhbWVuZGVkIGJ5IGl0cyBjb2xkIHJlYWQgKGDigKYvYXJ0aWZhY3RzL2NvbGQtcmVhZC5tZGApLiBXaGVyZSB0aGV5IGRpc2FncmVlZCxcbiAqIHRoZSBjb2xkIHJlYWQgd29uLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGBub2RlOnV0aWxgIGFuZCBvdGhlciBraXRcbiAqIG1vZHVsZXMgKGAuLi93aXJlL2Vycm9yc2AsIGAuLi9saWIvcHJpbnRKc29uYCkuXG4gKlxuICog4puUIE5PIFNJREUgRUZGRUNUUyBBVCBJTVBPUlQsIEFORCBOT05FIElOIGBkZWZpbmVDbGlgLiBCdWlsZGluZyB0aGUgdGFibGUgb25seVxuICogdmFsaWRhdGVzIGFuZCBpbmRleGVzIGl0OyBub3RoaW5nIGlzIHBhcnNlZCwgcHJpbnRlZCBvciByZWFkIHVudGlsIGBtYWluYCBvclxuICogYGRpc3BhdGNoYCBpcyBjYWxsZWQuIEEgZ3JpbW9pcmUgd2FyZCBjYW4gaW1wb3J0IGEgc3BlbGwncyB0YWJsZSBhbmQgcmVhZFxuICogYHJlY29nbml6ZWRGbGFnc2AsIGBmbGFnc0ZvcmAsIGB2ZXJic2AgYW5kIGBkZWNsYXJhdGlvbigpYCB3aXRob3V0IHJ1bm5pbmcgaXQuXG4gKlxuICog4pSA4pSAIFRIRSBDT05UUkFDVCBBIFNQRUxMIENBTk5PVCBDSEFOR0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gYC0taGVscGAvYC1oYCBhbmQgYC0tdmVyc2lvbmAvYC1WYCBhcyBgYXJndlswXWAgcnVuIHRoZSBgaGVscGAgb3JcbiAqICAgIGB2ZXJzaW9uYCByb3cgYW5kIFBBU1MgVEhFIFJFTUFJTklORyBBUkdVTUVOVFMgT04gdG8gaXQsIHNvIHRoYXQgcm93J3Mgb3duXG4gKiAgICBmbGFnIGNoZWNrIGFwcGxpZXM6IGAtLXZlcnNpb24gLS1odW1hbmAgd29ya3Mgd2hlcmUgYHZlcnNpb25gIGFjY2VwdHNcbiAqICAgIGAtLWh1bWFuYCwgYW5kIGAtLXZlcnNpb24gLS1qdW5rYCBpcyBleGl0IDIgd2hlcmUgaXQgZG9lcyBub3QuXG4gKiAyLiBFbXB0eSBhcmd2IGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMjogb25lIGVudmVsb3BlIG9uIHN0ZGVyciwgZXhpdCAyLFxuICogICAgYGNob2ljZXNgID0gdGhlIHZlcmJzKSDigJQgdW5sZXNzIHRoZSBDTEkgaGFzIGEgdmVyYmxlc3MgYHJvb3RgIHJvdyB0aGF0XG4gKiAgICBhY2NlcHRzIGFuIGVtcHR5IGFyZ3YgKG5vIHJlcXVpcmVkIHBvc2l0aW9uYWxzOyBmbGFncyBkZWZhdWx0ZWQpLlxuICogMy4gVGhlIHZlcmIgaXMgZm91bmQgcGVyIHRoZSBncmFtbWFyOlxuICogICAgLSBgdmVyYi1maXJzdGAgKGRlZmF1bHQpOiBgYXJndlswXWAuIEEgZGFzaC1sZWQgYGFyZ3ZbMF1gIHRoYXQgaXMgbm90IGFuXG4gKiAgICAgIGludGVyY2VwdG9yIGlzIGFuIHVua25vd24gUk9PVCBmbGFnIChgY2hvaWNlc2AgPSB0aGUgaW50ZXJjZXB0b3JzLCBsb25nXG4gKiAgICAgIGZpcnN0KS4gRmxhZ3MgYmVmb3JlIHRoZSB2ZXJiIGFyZSByZWZ1c2VkLCBpbmNsdWRpbmcgZ2xvYmFsIG9uZXMuXG4gKiAgICAtIGBmbGFncy1hbnl3aGVyZWA6IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5laXRoZXIgYSBmbGFnIG5vciBhIHN0cmluZ1xuICogICAgICBmbGFnJ3MgdmFsdWUgKGBnbGFtb3VyIC0tc2Vzc2lvbiB4IGluZm9gIHJ1bnMgYGluZm9gKS4gVGhlXG4gKiAgICAgIHVua25vd24tcm9vdC1mbGFnIHJ1bGUgZG9lcyBOT1QgYXBwbHk7IGFuIGFyZ3Ygd2l0aCBubyB2ZXJiIGluIGl0IGlzXG4gKiAgICAgIHBhcnNlZCB3aG9sZSwgc28gYW4gdW5rbm93biBmbGFnIHRoZXJlIGlzIHJlZnVzZWQgd2l0aCB0aGUgcm9vdCdzIHNldC5cbiAqICAgIEluIGJvdGgsIGEgYmFyZSBgLS1gIGJlZm9yZSB0aGUgdmVyYiBtYWtlcyB0aGUgTkVYVCB0b2tlbiB0aGUgdmVyYlxuICogICAgY2FuZGlkYXRlIGFuZCBldmVyeXRoaW5nIGFmdGVyIGl0IHBvc2l0aW9uYWwgKGFjYyBBNik6IGBjbGkgLS0gLS14YCBpc1xuICogICAgYHVua25vd24gY29tbWFuZCBcIi0teFwiYCwgbmV2ZXIgYW4gb3B0aW9uLlxuICogNC4gTmVzdGluZyBpcyBvbmUgbGV2ZWw6IGEgcm93IG5hbWVkIGBcIm5vZGUgZWRpdFwiYC4gVGhlIHN1Yi12ZXJiIG9mIGEgZ3JvdXBcbiAqICAgIGlzIGZvdW5kIGJ5IHRoZSBncm91cCdzIGBzdWJWZXJiQXRgIChzZWUgYEdyb3VwU3BlY2ApLiBBIGdyb3VwIHdpdGggbm8gcm93XG4gKiAgICBvZiBpdHMgb3duIHJlamVjdHMgYSBtaXNzaW5nIG9yIHVua25vd24gc3ViLXZlcmIgd2l0aCBpdHMgc3ViLXZlcmJzIGFzXG4gKiAgICBgY2hvaWNlc2A7IGEgZ3JvdXAgV0lUSCBpdHMgb3duIHJvdyAoYGRvYyA8aWQ+YCkgcnVucyB0aGF0IHJvdyBpbnN0ZWFkLlxuICogNS4gVGhlIHJvdydzIGFyZ3MgYXJlIHBhcnNlZCBzdHJpY3QgYWdhaW5zdCB0aGUgV0hPTEUgb3B0aW9ucyB0YWJsZSAod2l0aFxuICogICAgYGRlZmF1bHRgcyBzdHJpcHBlZCksIHNvIGEgZmxhZyB0aGUgc3BlbGwga25vd3MgYnV0IHRoaXMgcm93IGRvZXMgbm90IHRha2VcbiAqICAgIGlzIHJlZnVzZWQgYXMgTUlTUExBQ0VEIChgLS14IGlzIG5vdCBhY2NlcHRlZCBieSBcXGB2ZXJiXFxgYCksIGFuZCBvbmUgdGhlXG4gKiAgICBzcGVsbCBkb2VzIG5vdCBrbm93IGFzIFVOS05PV04uIEJvdGggY2FycnkgYGNob2ljZXNgID0gdGhpcyByb3cncyBhY2NlcHRlZFxuICogICAgc2V0IChpdHMgb3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCkuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuXG4gKiA2LiBEZWZhdWx0cyBhcmUgYXBwbGllZCBBRlRFUiB0aGUgcGVyLXJvdyBjaGVjaywgYW5kIG9ubHkgZm9yIGZsYWdzIHRoZSByb3dcbiAqICAgIGFjY2VwdHMg4oCUIHNvIGEgZGVmYXVsdGVkIGZsYWcgbmV2ZXIgdHJpcHMgdGhlIG1pc3BsYWNlZC1mbGFnIGNoZWNrLCBhbmQgYVxuICogICAgcm93IG5ldmVyIHNlZXMgYW5vdGhlciByb3cncyBkZWZhdWx0LlxuICogNy4gQXJpdHkgaXMgZW5mb3JjZWQgZnJvbSBgcG9zaXRpb25hbHNgOyB0aGUgcmVqZWN0aW9uIG5hbWVzIHRoZSBtaXNzaW5nXG4gKiAgICBgPHBvc2l0aW9uYWw+YCBvciB0aGUgZXh0cmEgdG9rZW4uIEEgcm93J3MgYGNoZWNrYCBtYXkgdGhlbiByZWZ1c2UgYVxuICogICAgY29tYmluYXRpb24gdGhlIGRlY2xhcmF0aW9uIGNhbm5vdCBleHByZXNzIChmbGFnLWRlcGVuZGVudCBhcml0eSkuXG4gKiA4LiBUaGUgcm93IHJ1bnM7IGEgbnVtYmVyIGl0IHJldHVybnMgaXMgdGhlIGV4aXQgY29kZSwgYW55dGhpbmcgZWxzZSBpcyAwLlxuICpcbiAqIFRoZSBtb2R1bGUgYWRkcyBgaGVscGAsIGB2ZXJzaW9uYCBhbmQgYHNjaGVtYWAgcm93cyB1bmxlc3MgdGhlIHNwZWxsIGRlZmluZXNcbiAqIGEgcm93IG9mIHRoYXQgbmFtZSAoZ3JhcGV2aW5lJ3MgYHZlcnNpb24gLS1odW1hbmApLiBUaGV5IGFyZSBvcmRpbmFyeSByb3dzOlxuICogZGVjbGFyZWQsIHN0cmljdCwgYW5kIGdpdmVuIGBnbG9iYWxGbGFnc2AgbGlrZSBldmVyeSBvdGhlciByb3cuXG4gKi9cblxuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uL2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi93aXJlL2Vycm9yc1wiO1xuXG4vLyDilIDilIAgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZsYWdUeXBlID0gXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiO1xuXG4vKiogT25lIGBwYXJzZUFyZ3NgIG9wdGlvbiwgcGx1cyB0aGUgYGRlZmF1bHRgIG5vZGUncyBwYXJzZXIgYWxzbyB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIE9wdGlvblNwZWMgPSB7XG4gIHR5cGU6IEZsYWdUeXBlO1xuICBtdWx0aXBsZT86IGJvb2xlYW47XG4gIHNob3J0Pzogc3RyaW5nO1xuICBkZWZhdWx0Pzogc3RyaW5nIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgcmVhZG9ubHkgYm9vbGVhbltdO1xufTtcblxuZXhwb3J0IHR5cGUgT3B0aW9uc1RhYmxlID0gUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgT3B0aW9uU3BlYz4+O1xuXG5leHBvcnQgdHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbmV4cG9ydCB0eXBlIEZsYWdWYWx1ZSA9IHN0cmluZyB8IGJvb2xlYW4gfCAoc3RyaW5nIHwgYm9vbGVhbilbXTtcblxuZXhwb3J0IHR5cGUgSW52b2NhdGlvbjxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIFRoZSByZXNvbHZlZCByb3cgbmFtZTogYFwib3BlblwiYCwgYFwibm9kZSBlZGl0XCJgLCBvciBgXCJcImAgZm9yIGEgdmVyYmxlc3Mgcm9vdC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHNwZWxsaW5nIHRoZSBjYWxsZXIgdXNlZCDigJQgYW4gYWxpYXMsIHdoZW4gb25lIHdhcyB1c2VkLiAqL1xuICB0b2tlbjogc3RyaW5nO1xuICAvKiogUG9zaXRpb25hbHMgYWZ0ZXIgdGhlIHBhdGguICovXG4gIHBvczogc3RyaW5nW107XG4gIC8qKiBGbGFncyBnaXZlbiwgcGx1cyB0aGUgZGVmYXVsdHMgb2YgdGhlIGZsYWdzIHRoaXMgcm93IGFjY2VwdHMuICovXG4gIGZsYWdzOiBQYXJ0aWFsPFJlY29yZDxGLCBGbGFnVmFsdWU+Pjtcbn07XG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogYFwib3BlblwiYDsgb25lIHNwYWNlIG1lYW5zIG9uZSBsZXZlbCBvZiBuZXN0aW5nOiBgXCJub2RlIGVkaXRcImAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVhY2ggYWxpYXMgaXMgZGlzcGF0Y2hhYmxlLCBsaXN0ZWQgaW4gYHZlcmJzYCwgYW5kIGdldHMgaXRzIG93biBkZWNsYXJlZFxuICAgKiAgcm93LiBBbiBhbGlhcyBvZiBhIG5lc3RlZCByb3cgbXVzdCBzaGFyZSBpdHMgZ3JvdXA6IGBcIm5vZGUgY2hhbmdlXCJgLiAqL1xuICBhbGlhc2VzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGlzIHJvdydzIG93biBmbGFnczsgYGdsb2JhbEZsYWdzYCBhcmUgYWRkZWQgdG8gdGhlbS4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IEZbXTtcbiAgLyoqIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gdGhpcywgYW5kIGl0IGlzIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLiAqL1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIEFkZGVkIGFzIHRoZSBgaGludGAgb2YgdGhpcyByb3cncyBmbGFnIHJlamVjdGlvbnMuICovXG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIC8qKiBgZmFsc2VgIGhhbmRzIG5vZGUncyBvd24gXCJVbmV4cGVjdGVkIGFyZ3VtZW50XCIgcmVmdXNhbCBhbnkgcG9zaXRpb25hbC4gKi9cbiAgYWxsb3dQb3NpdGlvbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBGbGFnLWRlcGVuZGVudCBhcml0eSAoaW1hZ28gYGhhbmRvZmYgLS1jbGVhcmAsIG1pbmQtbWFwcGVyIGAtLXRvfC0tY2xlYXJgKVxuICAgKiBhbmQgYW55IG90aGVyIGNvbWJpbmF0aW9uIHJ1bGUuIFJ1bnMgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrOyBhIHJldHVybmVkXG4gICAqIHN0cmluZyBpcyByZWZ1c2VkIGFzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIHRoaXMgcm93LiDimqAgVGhlIGRlY2xhcmF0aW9uXG4gICAqIGNhbm5vdCBleHByZXNzIHN1Y2ggYSBydWxlOiBhIHBvc2l0aW9uYWwgdGhhdCBgLS1jbGVhcmAgbWFrZXMgdW5uZWNlc3NhcnlcbiAgICogY2FuIG9ubHkgYmUgZGVjbGFyZWQgYHJlcXVpcmVkOiBmYWxzZWAsIGFuZCB0aGlzIGhvb2sgZW5mb3JjZXMgdGhlIHJlc3QuXG4gICAqL1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb248Rj4pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgbnVtYmVyIGlzIHRoZSBleGl0IGNvZGU7IGFueXRoaW5nIGVsc2UgbWVhbnMgMC4gKi9cbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiB1bmtub3duO1xufTtcblxuLyoqIEEgdmVyYmxlc3MgQ0xJJ3Mgb25lIHJvdyAoZGlnZXN0aWZ5KS4gYHBhdGg6IFtdYCBpbiB0aGUgZGVjbGFyYXRpb24uICovXG5leHBvcnQgdHlwZSBSb290U3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IE9taXQ8Q29tbWFuZFNwZWM8Rj4sIFwibmFtZVwiIHwgXCJhbGlhc2VzXCI+O1xuXG4vKipcbiAqIFdoZXJlIGEgZ3JvdXAncyBzdWItdmVyYiBpcyBmb3VuZC5cbiAqIC0gYGFkamFjZW50YCAoZGVmYXVsdCk6IHRoZSB0b2tlbiByaWdodCBhZnRlciB0aGUgZ3JvdXAgKGBub2RlIGVkaXQgWGApLlxuICogLSBgZmlyc3QtcG9zaXRpb25hbGA6IHRoZSBmaXJzdCB0b2tlbiBhZnRlciB0aGUgZ3JvdXAgdGhhdCBpcyBuZWl0aGVyIGEgZmxhZ1xuICogICBub3IgYSBzdHJpbmcgZmxhZydzIHZhbHVlLCBzbyBmbGFncyBtYXkgY29tZSBmaXJzdDpcbiAqICAgYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWAgcmVzb2x2ZXMgdG8gYGRvYyBkZWxldGVgIChtaW5kLW1hcHBlcikuXG4gKiAgIFRoZSBzY2FuIHN0b3BzIGF0IGEgYmFyZSBgLS1gLCB3aGljaCBpcyB0aGUgZXNjYXBlIGhhdGNoIGZvciBhIHBvc2l0aW9uYWxcbiAqICAgbGl0ZXJhbGx5IG5hbWVkIGxpa2UgYSBzdWItdmVyYjogYGRvYyAtLSBkZWxldGVgIHJlYWRzIHRoZSBkb2MgXCJkZWxldGVcIi5cbiAqL1xuZXhwb3J0IHR5cGUgR3JvdXBTcGVjID0geyBzdWJWZXJiQXQ/OiBcImFkamFjZW50XCIgfCBcImZpcnN0LXBvc2l0aW9uYWxcIiB9O1xuXG5leHBvcnQgdHlwZSBDbGlTcGVjPE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+ID0ge1xuICAvKiogYFwiYm91bnR5XCJgLCB1c2VkIGluIG1lc3NhZ2VzIGFuZCB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogVGhlIHJlbmRlcmVkIGhlbHAncyBmaXJzdCBsaW5lOiBgJHtuYW1lfSDigJQgJHtzdW1tYXJ5fWAuICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIC8qKiBUaGUgbGl0ZXJhbCBgQ0xJX09QVElPTlNgIG9iamVjdC4gKi9cbiAgb3B0aW9uczogTztcbiAgY29tbWFuZHM/OiByZWFkb25seSBDb21tYW5kU3BlYzxrZXlvZiBPICYgc3RyaW5nPltdO1xuICAvKipcbiAgICogQSB2ZXJibGVzcyBDTEkncyByb3cuIFJlc2VydmVkIHRva2VucyBhcyBgYXJndlswXWAgc3RpbGwgc2VsZWN0IHRoZWlyIHJvd3NcbiAgICogKGBoZWxwYCwgYHZlcnNpb25gLCBgc2NoZW1hYCwgYW55IGBjb21tYW5kc2AsIGFuZCB0aGUgaW50ZXJjZXB0b3JzKTsgZXZlcnlcbiAgICogb3RoZXIgYXJndiwgdGhlIGVtcHR5IG9uZSBpbmNsdWRlZCwgYmVsb25ncyB0byB0aGUgcm9vdC4gQSBwb3NpdGlvbmFsIHRoYXRcbiAgICogaGFwcGVucyB0byBzcGVsbCBhIHJlc2VydmVkIHRva2VuIGdvZXMgYWZ0ZXIgYSBiYXJlIGAtLWAuXG4gICAqL1xuICByb290PzogUm9vdFNwZWM8a2V5b2YgTyAmIHN0cmluZz47XG4gIC8qKiBBY2NlcHRlZCBieSBldmVyeSByb3csIGJ5IGNvbnRyYWN0IChncmFwZXZpbmUncyBgLS1hc2AvYC0tZnJvbWApLiAqL1xuICBnbG9iYWxGbGFncz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICBncmFtbWFyPzogXCJ2ZXJiLWZpcnN0XCIgfCBcImZsYWdzLWFueXdoZXJlXCI7XG4gIC8qKiBQZXItZ3JvdXAgc3ViLXZlcmIgcGxhY2VtZW50LCBrZXllZCBieSB0aGUgZ3JvdXAgdG9rZW4gKGBcImRvY1wiYCkuICovXG4gIGdyb3Vwcz86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEdyb3VwU3BlYz4+O1xuICAvKiogVGhlIHJvb3Qgcm93J3MgcG9zaXRpb25hbCBuYW1lIGluIGBzY2hlbWFgIChgXCJjb21tYW5kXCJgOyBnbGFtb3VyOiBgXCJ2ZXJiXCJgKS4gKi9cbiAgdmVyYlBvc2l0aW9uYWw/OiBzdHJpbmc7XG4gIC8qKiBGbGFncyBsZWZ0IG9mZiBldmVyeSB1c2FnZSBsaW5lIChnbGFtb3VyJ3MgcGVyLXZlcmIgYHNlc3Npb25gKS4gKi9cbiAgdXNhZ2VIaWRlcz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICAvKiogVGhlIGB2ZXJzaW9uYCByb3cncyBwYXlsb2FkLCBge25hbWUsIHZlcnNpb259YC4gKi9cbiAgdmVyc2lvbjogKCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqIFJlcGxhY2VzIHRoZSByZW5kZXJlZCBoZWxwIChncmFwZXZpbmUpLiAqL1xuICBoZWxwPzogKCkgPT4gc3RyaW5nO1xuICAvKiogQXBwZW5kZWQgYmVsb3cgdGhlIHJlbmRlcmVkIHJvd3MuICovXG4gIGhlbHBGb290ZXI/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBEZWNsYXJlZEFyZyA9IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBGbGFnVHlwZTsgc3RhdHVzOiBcInZhbGlkXCIgfTtcbmV4cG9ydCB0eXBlIERlY2xhcmVkQ29tbWFuZCA9IHtcbiAgcGF0aDogc3RyaW5nW107XG4gIGFyZ3M6IERlY2xhcmVkQXJnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xufTtcbmV4cG9ydCB0eXBlIERlY2xhcmF0aW9uID0ge1xuICBmb3JtYXRWZXJzaW9uOiBcIjBcIjtcbiAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCI7XG4gIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBzdHJpbmdbXSB9O1xuICBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW107XG59O1xuXG4vKiogQSByb3cgYXMgdGhlIG1vZHVsZSBob2xkcyBpdCwgZm9yIHRlc3RzIGFuZCB3YXJkcy4gKi9cbmV4cG9ydCB0eXBlIFJvd1ZpZXcgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcm93J3Mgb3duIGZsYWdzLCBhcyBkZWNsYXJlZC4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogT3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCwgaW4gb3B0aW9ucy10YWJsZSBvcmRlci4gKi9cbiAgYWNjZXB0ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIGB0cnVlYCBmb3IgYSBgaGVscGAvYHZlcnNpb25gL2BzY2hlbWFgIHJvdyB0aGUgbW9kdWxlIGFkZGVkLiAqL1xuICBhdXRvOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQ2xpID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFbnZlbG9wZSBvbiBmYWlsdXJlLCByZXR1cm5zIHRoZSBleGl0IGNvZGUuIEZvciB0aGUgc3BlbGwncyBgcnVuKClgLiAqL1xuICBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhyb3dzIGBDbGlFcnJvcmAsIGZvciBhIHNwZWxsIHdob3NlIG1haW4gZG9lcyBpdHMgb3duIHRyaWFnZS4gKi9cbiAgZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIGRlY2xhcmF0aW9uKCk6IERlY2xhcmF0aW9uO1xuICByZW5kZXJIZWxwKCk6IHN0cmluZztcbiAgLyoqIEEgcm93J3MgdXNhZ2UgbGluZSAoYFwiY2xvc2UgPGlkPiBbLS1mb3JjZV1cImApOyBgXCJcImAgZm9yIGFuIHVua25vd24gcGF0aC4gKi9cbiAgdXNhZ2VPZihwYXRoOiBzdHJpbmcpOiBzdHJpbmc7XG4gIC8qKiBFdmVyeSBmaXJzdCB0b2tlbiB0aGF0IGRpc3BhdGNoZXM6IHZlcmJzLCBhbGlhc2VzIGFuZCBncm91cCB0b2tlbnMuICovXG4gIHZlcmJzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZ1bGwgcGF0aCB0aGF0IGRpc3BhdGNoZXMsIGFsaWFzZXMgaW5jbHVkZWQgKGBcIm5vZGUgZWRpdFwiYCkuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgcm93J3MgYWNjZXB0ZWQgc2V0IGFzIGAtLXhgIHNwZWxsaW5ncywgc29ydGVkLiBgXCJcImAgaXMgdGhlIHJvb3QuICovXG4gIGZsYWdzRm9yKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdO1xuICAvKiogRXZlcnkgZmxhZyBpbiB0aGUgb3B0aW9ucyB0YWJsZSwgYXMgYC0teGAsIGluIHRhYmxlIG9yZGVyLiAqL1xuICByZWNvZ25pemVkRmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICByb3dzOiByZWFkb25seSBSb3dWaWV3W107XG59O1xuXG4vLyDilIDilIAgaW50ZXJuYWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG50eXBlIFJvdyA9IFJvd1ZpZXcgJiB7XG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIGFsbG93UG9zaXRpb25hbHM6IGJvb2xlYW47XG4gIGNoZWNrPzogKGludjogSW52b2NhdGlvbikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBydW46IChpbnY6IEludm9jYXRpb24pID0+IHVua25vd247XG59O1xuXG4vKiogVGhlIHRva2VucyB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi4gRGVjbGFyZWQgYXQgYHBhdGg6IFtdYC4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbi8qKiBMb25nIGZpcnN0OiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHQgc3RvcHMgYXQgdGhlIGZpcnN0XG4gKiAgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLiAqL1xuY29uc3QgSU5URVJDRVBUT1JfQ0hPSUNFUyA9IElOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuc29ydChcbiAgKGEsIGIpID0+IE51bWJlcihiLnN0YXJ0c1dpdGgoXCItLVwiKSkgLSBOdW1iZXIoYS5zdGFydHNXaXRoKFwiLS1cIikpLFxuKTtcblxuY29uc3QgZXJyQ29kZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+XG4gIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuY29uc3QgZXJyTWVzc2FnZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+IChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmaW5lQ2xpPGNvbnN0IE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+KHNwZWM6IENsaVNwZWM8Tz4pOiBDbGkge1xuICBjb25zdCBjbGlOYW1lID0gc3BlYy5uYW1lO1xuICBjb25zdCBvcHRpb25LZXlzID0gT2JqZWN0LmtleXMoc3BlYy5vcHRpb25zKTtcbiAgY29uc3Qga25vd24gPSBuZXcgU2V0KG9wdGlvbktleXMpO1xuICBjb25zdCBncmFtbWFyID0gc3BlYy5ncmFtbWFyID8/IFwidmVyYi1maXJzdFwiO1xuICBjb25zdCBnbG9iYWxzID0gWy4uLihzcGVjLmdsb2JhbEZsYWdzID8/IFtdKV0gYXMgc3RyaW5nW107XG4gIGNvbnN0IGhpZGVzID0gbmV3IFNldDxzdHJpbmc+KChzcGVjLnVzYWdlSGlkZXMgPz8gW10pIGFzIHN0cmluZ1tdKTtcblxuICBmb3IgKGNvbnN0IGcgb2YgZ2xvYmFscykge1xuICAgIGlmICgha25vd24uaGFzKGcpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdsb2JhbCBmbGFnIFwiJHtnfVwiIGlzIG5vdCBpbiBvcHRpb25zYCk7XG4gIH1cbiAgaWYgKChzcGVjLmNvbW1hbmRzPy5sZW5ndGggPz8gMCkgPT09IDAgJiYgc3BlYy5yb290ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ2l2ZSBjb21tYW5kcywgYSByb290LCBvciBib3RoYCk7XG4gIH1cblxuICAvLyBgcGFyc2VBcmdzYCBnZXRzIHRoZSB0YWJsZSBXSVRIT1VUIGRlZmF1bHRzOiB3aGljaCBmbGFncyB0aGUgY2FsbGVyIGdhdmUgaXNcbiAgLy8gdGhlIHF1ZXN0aW9uIHRoZSBwZXItcm93IGNoZWNrIGFza3MsIGFuZCBhIGRlZmF1bHQgaXMgbm90IHNvbWV0aGluZyBnaXZlbi5cbiAgY29uc3QgcGFyc2VPcHRpb25zID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIG9wdGlvbktleXMubWFwKChrKSA9PiB7XG4gICAgICBjb25zdCB7IGRlZmF1bHQ6IF9kLCAuLi5yZXN0IH0gPSBzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYztcbiAgICAgIHJldHVybiBbaywgcmVzdF07XG4gICAgfSksXG4gICkgYXMgUmVjb3JkPHN0cmluZywgeyB0eXBlOiBGbGFnVHlwZTsgbXVsdGlwbGU/OiBib29sZWFuOyBzaG9ydD86IHN0cmluZyB9PjtcbiAgY29uc3Qgc2hvcnRUb0tleSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgayBvZiBvcHRpb25LZXlzKSB7XG4gICAgY29uc3QgcyA9IHNwZWMub3B0aW9uc1trXT8uc2hvcnQ7XG4gICAgaWYgKHMgIT09IHVuZGVmaW5lZCkgc2hvcnRUb0tleS5zZXQocywgayk7XG4gIH1cblxuICBjb25zdCBhY2NlcHRlZE9mID0gKG93bjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSA9PiB7XG4gICAgY29uc3Qgc2V0ID0gbmV3IFNldChbLi4uZ2xvYmFscywgLi4ub3duXSk7XG4gICAgcmV0dXJuIG9wdGlvbktleXMuZmlsdGVyKChrKSA9PiBzZXQuaGFzKGspKTtcbiAgfTtcblxuICBjb25zdCB0b1JvdyA9IChcbiAgICBjOiBPbWl0PENvbW1hbmRTcGVjLCBcInJ1blwiPiAmIHsgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duIH0sXG4gICAgYXV0bzogYm9vbGVhbixcbiAgKTogUm93ID0+IHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5mbGFncykge1xuICAgICAgaWYgKCFrbm93bi5oYXMoZikpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IHJvdyBcIiR7Yy5uYW1lfVwiIG5hbWVzIGZsYWcgXCIke2Z9XCIsIG5vdCBpbiBvcHRpb25zYCk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICBhbGlhc2VzOiBbLi4uKGMuYWxpYXNlcyA/PyBbXSldLFxuICAgICAgZmxhZ3M6IFsuLi5jLmZsYWdzXSxcbiAgICAgIGFjY2VwdGVkOiBhY2NlcHRlZE9mKGMuZmxhZ3MpLFxuICAgICAgcG9zaXRpb25hbHM6IGMucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgIGRlc2NyaWJlOiBjLmRlc2NyaWJlLFxuICAgICAgYXV0byxcbiAgICAgIHJlamVjdEhpbnQ6IGMucmVqZWN0SGludCxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IGMuYWxsb3dQb3NpdGlvbmFscyA/PyB0cnVlLFxuICAgICAgY2hlY2s6IGMuY2hlY2sgYXMgUm93W1wiY2hlY2tcIl0sXG4gICAgICBydW46IGMucnVuIGFzIFJvd1tcInJ1blwiXSxcbiAgICB9O1xuICB9O1xuXG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gKHNwZWMuY29tbWFuZHMgPz8gW10pLm1hcCgoYykgPT4gdG9Sb3coYyBhcyBDb21tYW5kU3BlYywgZmFsc2UpKTtcblxuICAvLyBUaGUgYXV0byByb3dzLiBBZGRlZCBsYXN0LCBpbiB0aGlzIG9yZGVyLCB1bmxlc3MgdGhlIHNwZWxsIGhhcyBpdHMgb3duLlxuICBjb25zdCBjbGkgPSB7fSBhcyBDbGk7XG4gIGNvbnN0IGF1dG9Sb3dzOiBDb21tYW5kU3BlY1tdID0gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTiAoYWxpYXM6IC0tdmVyc2lvbiwgLVYpXCIsXG4gICAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgICAgcHJpbnRKc29uKGF3YWl0IHNwZWMudmVyc2lvbigpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSAoYWNjIGRlY2xhcmF0aW9uIHYwKVwiLFxuICAgICAgcnVuOiAoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGNsaS5kZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcImhlbHBcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInNob3cgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0ID0gY2xpLnJlbmRlckhlbHAoKTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUodGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGEgb2YgYXV0b1Jvd3MpIHtcbiAgICBpZiAoIXJvd3Muc29tZSgocikgPT4gci5uYW1lID09PSBhLm5hbWUpKSByb3dzLnB1c2godG9Sb3coYSwgdHJ1ZSkpO1xuICB9XG5cbiAgY29uc3Qgcm9vdFJvdzogUm93IHwgdW5kZWZpbmVkID1cbiAgICBzcGVjLnJvb3QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvUm93KHsgLi4uKHNwZWMucm9vdCBhcyBSb290U3BlYyksIG5hbWU6IFwiXCIgfSwgZmFsc2UpO1xuXG4gIC8vIEluZGV4IGV2ZXJ5IHNwZWxsaW5nLCBhbmQgY2hlY2sgdGhlIHRhYmxlIGlzIHdlbGwgZm9ybWVkLlxuICBjb25zdCBieVRva2VuID0gbmV3IE1hcDxzdHJpbmcsIFJvdz4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgY29uc3QgcGFydHMgPSB0LnNwbGl0KFwiIFwiKTtcbiAgICAgIGlmICh0LnRyaW0oKSAhPT0gdCB8fCBwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+IHAgPT09IFwiXCIgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGJhZCBjb21tYW5kIG5hbWUgXCIke3R9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0ICE9PSByLm5hbWUgJiYgcGFydHMubGVuZ3RoICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBuZXN0IGxpa2UgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMiAmJiB0ICE9PSByLm5hbWUgJiYgcGFydHNbMF0gIT09IHIubmFtZS5zcGxpdChcIiBcIilbMF0pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3Qgc2hhcmUgdGhlIGdyb3VwIG9mIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChieVRva2VuLmhhcyh0KSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IFwiJHt0fVwiIGlzIGRlZmluZWQgdHdpY2VgKTtcbiAgICAgIGJ5VG9rZW4uc2V0KHQsIHIpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzdWJzT2YgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBieVRva2VuLmtleXMoKSkge1xuICAgIGNvbnN0IFtncm91cCwgc3ViXSA9IHQuc3BsaXQoXCIgXCIpO1xuICAgIGlmIChncm91cCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdWJzT2Yuc2V0KGdyb3VwLCBbLi4uKHN1YnNPZi5nZXQoZ3JvdXApID8/IFtdKSwgc3ViXSk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgZyBvZiBPYmplY3Qua2V5cyhzcGVjLmdyb3VwcyA/PyB7fSkpIHtcbiAgICBpZiAoIXN1YnNPZi5oYXMoZykpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBncm91cCBcIiR7Z31cIiBoYXMgbm8gc3ViLXZlcmJzYCk7XG4gIH1cblxuICBjb25zdCBwYXRocyA9IFsuLi5ieVRva2VuLmtleXMoKV07XG4gIGNvbnN0IHZlcmJzID0gWy4uLm5ldyBTZXQocGF0aHMubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbiAgY29uc3Qgcm93Rm9yID0gKHBhdGg6IHN0cmluZyk6IFJvdyB8IHVuZGVmaW5lZCA9PiAocGF0aCA9PT0gXCJcIiA/IHJvb3RSb3cgOiBieVRva2VuLmdldChwYXRoKSk7XG4gIGNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gICAgWy4uLihyb3dGb3IocGF0aCk/LmFjY2VwdGVkID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuICBjb25zdCBsYWJlbCA9IChyOiBSb3cpOiBzdHJpbmcgPT4gci5uYW1lIHx8IGNsaU5hbWU7XG5cbiAgLy8g4pSA4pSAIGhlbHAg4pSA4pSAXG5cbiAgY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgaW5uZXIgPSBwLnZhcmlhZGljID8gYCR7cC5uYW1lfS4uLmAgOiBwLm5hbWU7XG4gICAgcmV0dXJuIHAucmVxdWlyZWQgPyBgPCR7aW5uZXJ9PmAgOiBgWyR7aW5uZXJ9XWA7XG4gIH07XG4gIGNvbnN0IHJlbmRlckZsYWcgPSAoazogc3RyaW5nKTogc3RyaW5nID0+XG4gICAgc3BlYy5vcHRpb25zW2tdPy50eXBlID09PSBcImJvb2xlYW5cIiA/IGBbLS0ke2t9XWAgOiBgWy0tJHtrfSAuLl1gO1xuICBjb25zdCB1c2FnZUxpbmUgPSAocjogUm93KTogc3RyaW5nID0+XG4gICAgW1xuICAgICAgbGFiZWwociksXG4gICAgICAuLi5yLnBvc2l0aW9uYWxzLm1hcChyZW5kZXJQb3NpdGlvbmFsKSxcbiAgICAgIC4uLnIuZmxhZ3MuZmlsdGVyKChrKSA9PiAhaGlkZXMuaGFzKGspKS5tYXAocmVuZGVyRmxhZyksXG4gICAgXS5qb2luKFwiIFwiKTtcbiAgY29uc3QgZXhwZWN0cyA9IChyOiBSb3cpOiBzdHJpbmcgPT4gYGV4cGVjdHM6ICR7dXNhZ2VMaW5lKHIpfWA7XG5cbiAgY29uc3QgcmVuZGVySGVscCA9ICgpOiBzdHJpbmcgPT4ge1xuICAgIGlmIChzcGVjLmhlbHAgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHNwZWMuaGVscCgpO1xuICAgIGNvbnN0IGxpc3RlZCA9IFsuLi4ocm9vdFJvdyA/IFtyb290Um93XSA6IFtdKSwgLi4ucm93c107XG4gICAgY29uc3QgbGluZXMgPSBsaXN0ZWQubWFwKChyKSA9PiBbdXNhZ2VMaW5lKHIpLCByLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihNYXRoLm1heCguLi5saW5lcy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICAgIGNvbnN0IGJvZHkgPSBsaW5lc1xuICAgICAgLm1hcCgoW3UsIGRdKSA9PlxuICAgICAgICB1Lmxlbmd0aCA8PSB3aWR0aCA/IGAgICR7dS5wYWRFbmQod2lkdGgpfSAgJHtkfWAgOiBgICAke3V9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICAgKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZCA9IHNwZWMuc3VtbWFyeSA/IGAke2NsaU5hbWV9IOKAlCAke3NwZWMuc3VtbWFyeX1gIDogY2xpTmFtZTtcbiAgICBjb25zdCB0b2tlbnMgPSBgICAke0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTmA7XG4gICAgcmV0dXJuIGAke2hlYWR9XFxuXFxuJHtib2R5fVxcbiR7dG9rZW5zfSR7c3BlYy5oZWxwRm9vdGVyID8gYFxcblxcbiR7c3BlYy5oZWxwRm9vdGVyfWAgOiBcIlwifWA7XG4gIH07XG5cbiAgLy8g4pSA4pSAIHRoZSBkZWNsYXJhdGlvbiDilIDilIBcblxuICBjb25zdCBkZWNsYXJhdGlvbiA9ICgpOiBEZWNsYXJhdGlvbiA9PiB7XG4gICAgY29uc3QgYXJnID0gKGs6IHN0cmluZyk6IERlY2xhcmVkQXJnID0+ICh7XG4gICAgICBuYW1lOiBgLS0ke2t9YCxcbiAgICAgIHR5cGU6IChzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYykudHlwZSxcbiAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgIH0pO1xuICAgIGNvbnN0IGNvbW1hbmRzOiBEZWNsYXJlZENvbW1hbmRbXSA9IFtcbiAgICAgIHtcbiAgICAgICAgcGF0aDogW10sXG4gICAgICAgIGFyZ3M6IFtcbiAgICAgICAgICAuLi5JTlRFUkNFUFRPUlMubWFwKChpKSA9PiAoe1xuICAgICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgICAgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsXG4gICAgICAgICAgICBzdGF0dXM6IFwidmFsaWRcIiBhcyBjb25zdCxcbiAgICAgICAgICB9KSksXG4gICAgICAgICAgLi4uKHJvb3RSb3cgPyByb290Um93LmFjY2VwdGVkLm1hcChhcmcpIDogW10pLFxuICAgICAgICBdLFxuICAgICAgICBwb3NpdGlvbmFsczogcm9vdFJvd1xuICAgICAgICAgID8gcm9vdFJvdy5wb3NpdGlvbmFscy5tYXAoKHApID0+ICh7IC4uLnAgfSkpXG4gICAgICAgICAgOiBbeyBuYW1lOiBzcGVjLnZlcmJQb3NpdGlvbmFsID8/IFwiY29tbWFuZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IHIgb2Ygcm93cykge1xuICAgICAgZm9yIChjb25zdCB0IG9mIFtyLm5hbWUsIC4uLnIuYWxpYXNlc10pIHtcbiAgICAgICAgY29tbWFuZHMucHVzaCh7XG4gICAgICAgICAgcGF0aDogdC5zcGxpdChcIiBcIiksXG4gICAgICAgICAgYXJnczogci5hY2NlcHRlZC5tYXAoYXJnKSxcbiAgICAgICAgICBwb3NpdGlvbmFsczogci5wb3NpdGlvbmFscy5tYXAoKHApID0+ICh7IC4uLnAgfSkpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3Qgc2NoZW1hUm93ID0gYnlUb2tlbi5nZXQoXCJzY2hlbWFcIikgYXMgUm93O1xuICAgIHJldHVybiB7XG4gICAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtzY2hlbWFSb3cubmFtZV0gfSxcbiAgICAgIGNvbW1hbmRzLFxuICAgIH07XG4gIH07XG5cbiAgLy8g4pSA4pSAIGRpc3BhdGNoIOKUgOKUgFxuXG4gIC8qKlxuICAgKiBUaGUgaW5kZXggb2YgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbmVpdGhlciBhIGZsYWcgbm9yIGEgc3RyaW5nIGZsYWcnc1xuICAgKiB2YWx1ZSwgd2Fsa2luZyB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbDogYC0tayB2YCBjb25zdW1lcyBgdmAgd2hlbiBga2AgaXMgYVxuICAgKiBzdHJpbmcgZmxhZywgYC0taz12YCBjb25zdW1lcyBub3RoaW5nLCBgLXMgdmAgbGlrZXdpc2UgYnkgdGhlIHNob3J0J3MgdHlwZS5cbiAgICogQXQgYSBiYXJlIGAtLWA6IGAtMWAgd2hlbiBgc3RvcEF0VGVybWluYXRvcmAsIGVsc2UgdGhlIGluZGV4IGFmdGVyIGl0LlxuICAgKi9cbiAgY29uc3Qgc2NhblBvc2l0aW9uYWwgPSAoYXJnczogc3RyaW5nW10sIHN0b3BBdFRlcm1pbmF0b3I6IGJvb2xlYW4pOiBudW1iZXIgPT4ge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgYSA9IGFyZ3NbaV0gYXMgc3RyaW5nO1xuICAgICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIHN0b3BBdFRlcm1pbmF0b3IgfHwgaSArIDEgPj0gYXJncy5sZW5ndGggPyAtMSA6IGkgKyAxO1xuICAgICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICAgIGlmIChhLmluY2x1ZGVzKFwiPVwiKSkgY29udGludWU7XG4gICAgICAgIGlmIChzcGVjLm9wdGlvbnNbYS5zbGljZSgyKV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSAmJiBhLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgY29uc3Qga2V5ID0gYS5sZW5ndGggPT09IDIgPyBzaG9ydFRvS2V5LmdldChhLnNsaWNlKDEpKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKGtleSAhPT0gdW5kZWZpbmVkICYmIHNwZWMub3B0aW9uc1trZXldPy50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGk7XG4gICAgfVxuICAgIHJldHVybiAtMTtcbiAgfTtcblxuICBjb25zdCB3aXRob3V0ID0gKGFyZ3M6IHN0cmluZ1tdLCBpOiBudW1iZXIpOiBzdHJpbmdbXSA9PiBbXG4gICAgLi4uYXJncy5zbGljZSgwLCBpKSxcbiAgICAuLi5hcmdzLnNsaWNlKGkgKyAxKSxcbiAgXTtcblxuICBjb25zdCBub0NvbW1hbmQgPSAoKTogbmV2ZXIgPT5cbiAgICBkaWUoXCJleHBlY3RlZCBhIGNvbW1hbmRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgaGludDogYHJ1biBcXGAke2NsaU5hbWV9IGhlbHBcXGAgKG9yIC0taGVscCkgZm9yIHVzYWdlYCxcbiAgICB9KTtcblxuICAvKiogQSB2ZXJiIGNhbmRpZGF0ZSBhbmQgdGhlIGFyZ3MgYWZ0ZXIgaXQsIHRvIGEgcm93IGFuZCB0aGF0IHJvdydzIGFyZ3MuICovXG4gIGNvbnN0IHJlc29sdmUgPSAoY2FuZDogc3RyaW5nLCByZXN0OiBzdHJpbmdbXSk6IHsgcm93OiBSb3c7IHRva2VuOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdIH0gPT4ge1xuICAgIGNvbnN0IHN1YnMgPSBzdWJzT2YuZ2V0KGNhbmQpO1xuICAgIGlmIChzdWJzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGF0ID0gc3BlYy5ncm91cHM/LltjYW5kXT8uc3ViVmVyYkF0ID8/IFwiYWRqYWNlbnRcIjtcbiAgICAgIGxldCBpID0gLTE7XG4gICAgICBpZiAoYXQgPT09IFwiYWRqYWNlbnRcIikge1xuICAgICAgICBjb25zdCBuZXh0ID0gcmVzdFswXTtcbiAgICAgICAgaSA9IG5leHQgIT09IHVuZGVmaW5lZCAmJiAhbmV4dC5zdGFydHNXaXRoKFwiLVwiKSA/IDAgOiAtMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGkgPSBzY2FuUG9zaXRpb25hbChyZXN0LCB0cnVlKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHN1YiA9IGkgPj0gMCA/IChyZXN0W2ldIGFzIHN0cmluZykgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBmdWxsID0gc3ViID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBieVRva2VuLmdldChgJHtjYW5kfSAke3N1Yn1gKTtcbiAgICAgIGlmIChmdWxsICE9PSB1bmRlZmluZWQgJiYgc3ViICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHsgcm93OiBmdWxsLCB0b2tlbjogYCR7Y2FuZH0gJHtzdWJ9YCwgYXJnczogd2l0aG91dChyZXN0LCBpKSB9O1xuICAgICAgfVxuICAgICAgY29uc3Qgb3duID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgICBpZiAob3duICE9PSB1bmRlZmluZWQpIHJldHVybiB7IHJvdzogb3duLCB0b2tlbjogY2FuZCwgYXJnczogcmVzdCB9O1xuICAgICAgY29uc3QgZXh0cmEgPSB7IGNob2ljZXM6IFsuLi5zdWJzXSwgaGludDogYHJ1biBcXGAke2NsaU5hbWV9IGhlbHBcXGAgZm9yIHVzYWdlYCB9O1xuICAgICAgaWYgKHN1YiA9PT0gdW5kZWZpbmVkKSBkaWUoYCR7Y2FuZH06IGV4cGVjdGVkIGEgc3ViLWNvbW1hbmRgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICAgIGRpZShgdW5rbm93biAke2NhbmR9IHN1Yi1jb21tYW5kOiBcIiR7c3VifVwiYCwgXCJ1c2FnZVwiLCBleHRyYSk7XG4gICAgfVxuICAgIGNvbnN0IHJvdyA9IGJ5VG9rZW4uZ2V0KGNhbmQpO1xuICAgIGlmIChyb3cgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGllKGB1bmtub3duIGNvbW1hbmQgXCIke2NhbmR9XCJgLCBcInVzYWdlXCIsIHtcbiAgICAgICAgY2hvaWNlczogWy4uLnZlcmJzXSxcbiAgICAgICAgaGludDogYHJ1biBcXGAke2NsaU5hbWV9IGhlbHBcXGAgZm9yIHVzYWdlYCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyByb3csIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gIH07XG5cbiAgY29uc3QgcnVuUm93ID0gYXN5bmMgKHJvdzogUm93LCB0b2tlbjogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQocm93Lm5hbWUgPT09IFwiXCIgPyBudWxsIDogcm93Lm5hbWUpO1xuICAgIGNvbnN0IG5hbWUgPSBsYWJlbChyb3cpO1xuICAgIGNvbnN0IGFjY2VwdGVkID0gbmV3IFNldChyb3cuYWNjZXB0ZWQpO1xuICAgIGNvbnN0IGNob2ljZXMgPSBmbGFnc0Zvcihyb3cubmFtZSk7XG4gICAgY29uc3QgZmxhZ0hpbnQgPSAoKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICBbcm93LnJlamVjdEhpbnQsIGNob2ljZXMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gZmxhZ3NgIDogdW5kZWZpbmVkXVxuICAgICAgICAuZmlsdGVyKChzKTogcyBpcyBzdHJpbmcgPT4gcyAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAuam9pbihcIjsgXCIpIHx8IHVuZGVmaW5lZDtcblxuICAgIGxldCB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGxldCBwb3NpdGlvbmFsczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgICh7IHZhbHVlcywgcG9zaXRpb25hbHMgfSA9IHBhcnNlQXJncyh7XG4gICAgICAgIGFyZ3MsXG4gICAgICAgIG9wdGlvbnM6IHBhcnNlT3B0aW9ucyxcbiAgICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgICBhbGxvd1Bvc2l0aW9uYWxzOiByb3cuYWxsb3dQb3NpdGlvbmFscyxcbiAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZXJyQ29kZShlKSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiKSB7XG4gICAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0pO1xuICAgICAgfVxuICAgICAgLy8gQSBtaXNzaW5nIHZhbHVlIGlzIG5vdCBhIGNob2ljZSBmcm9tIGEgc2V0LCBzbyBubyBgY2hvaWNlc2AgaGVyZS5cbiAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBoaW50OiByb3cucmVqZWN0SGludCA/PyBleHBlY3RzKHJvdykgfSk7XG4gICAgfVxuXG4gICAgLy8gU3RhZ2UgMjoga25vd24gdG8gdGhlIHNwZWxsLCBub3QgdGFrZW4gYnkgdGhpcyByb3cg4oCUIE1JU1BMQUNFRCwgbm90XG4gICAgLy8gdW5rbm93bi4gT25seSBmbGFncyB0aGUgY2FsbGVyIEdBVkUgYXJlIGhlcmU6IGRlZmF1bHRzIGFyZSBub3QgYXBwbGllZCB5ZXQuXG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyh2YWx1ZXMpLmZpbmQoKGspID0+ICFhY2NlcHRlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke25hbWV9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgJHtjbGlOYW1lfSBmbGFnLCBqdXN0IG5vdCB0aGlzICR7cm93Lm5hbWUgPT09IFwiXCIgPyBcImNvbW1hbmRcIiA6IFwidmVyYlwifSdzKWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEFyaXR5LCBmcm9tIHRoZSBkZWNsYXJlZCBzaGFwZSwgbmFtaW5nIHRoZSBtaXNzaW5nIG9yIHRoZSBleHRyYSB0b2tlbi5cbiAgICBjb25zdCByZXF1aXJlZCA9IHJvdy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgICBjb25zdCB2YXJpYWRpYyA9IHJvdy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgICBpZiAocG9zaXRpb25hbHMubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSByb3cucG9zaXRpb25hbHNbcG9zaXRpb25hbHMubGVuZ3RoXTtcbiAgICAgIGRpZShgJHtuYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IGV4cGVjdHMocm93KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWxzLmxlbmd0aCA+IHJvdy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYCR7bmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsc1tyb3cucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGhpbnQ6IHJvdy5wb3NpdGlvbmFscy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBhcmd1bWVudHNgIDogZXhwZWN0cyhyb3cpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIERlZmF1bHRzIGxhc3QsIGFuZCBvbmx5IHRoaXMgcm93J3MuXG4gICAgY29uc3QgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4gPSB7IC4uLih2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPikgfTtcbiAgICBmb3IgKGNvbnN0IGsgb2Ygcm93LmFjY2VwdGVkKSB7XG4gICAgICBjb25zdCBkID0gKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS5kZWZhdWx0O1xuICAgICAgaWYgKGZsYWdzW2tdID09PSB1bmRlZmluZWQgJiYgZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZsYWdzW2tdID0gKEFycmF5LmlzQXJyYXkoZCkgPyBbLi4uZF0gOiBkKSBhcyBGbGFnVmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW52OiBJbnZvY2F0aW9uID0geyBwYXRoOiByb3cubmFtZSwgdG9rZW4sIHBvczogcG9zaXRpb25hbHMsIGZsYWdzIH07XG4gICAgY29uc3QgcmVmdXNlZCA9IHJvdy5jaGVjaz8uKGludik7XG4gICAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCkgZGllKGAke25hbWV9OiAke3JlZnVzZWR9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IGV4cGVjdHMocm93KSB9KTtcblxuICAgIGNvbnN0IG91dCA9IGF3YWl0IHJvdy5ydW4oaW52KTtcbiAgICByZXR1cm4gdHlwZW9mIG91dCA9PT0gXCJudW1iZXJcIiA/IG91dCA6IDA7XG4gIH07XG5cbiAgY29uc3QgZGlzcGF0Y2ggPSBhc3luYyAoYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4gPT4ge1xuICAgIHNldEN1cnJlbnRDb21tYW5kKGFyZ3ZbMF0gPz8gbnVsbCk7XG4gICAgY29uc3QgZmlyc3QgPSBhcmd2WzBdO1xuXG4gICAgLy8gMS4gSW50ZXJjZXB0b3JzIHBhc3MgdGhlIHJlc3Qgb2YgdGhlIGFyZ3Ygb24gdG8gdGhlaXIgcm93LlxuICAgIGNvbnN0IGludGVyY2VwdG9yID0gSU5URVJDRVBUT1JTLmZpbmQoKGkpID0+IGkubmFtZSA9PT0gZmlyc3QpO1xuICAgIGlmIChpbnRlcmNlcHRvciAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gcnVuUm93KGJ5VG9rZW4uZ2V0KGludGVyY2VwdG9yLnJ1bnMpIGFzIFJvdywgaW50ZXJjZXB0b3IucnVucywgYXJndi5zbGljZSgxKSk7XG4gICAgfVxuXG4gICAgLy8gMi4gQSB2ZXJibGVzcyByb290IG93bnMgZXZlcnkgYXJndiB0aGF0IGRvZXMgbm90IHN0YXJ0IHdpdGggYSByZXNlcnZlZCB0b2tlbi5cbiAgICBpZiAocm9vdFJvdyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBpZiAoZmlyc3QgIT09IHVuZGVmaW5lZCAmJiAoYnlUb2tlbi5oYXMoZmlyc3QpIHx8IHN1YnNPZi5oYXMoZmlyc3QpKSkge1xuICAgICAgICBjb25zdCByID0gcmVzb2x2ZShmaXJzdCwgYXJndi5zbGljZSgxKSk7XG4gICAgICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gICAgICB9XG4gICAgICByZXR1cm4gcnVuUm93KHJvb3RSb3csIFwiXCIsIGFyZ3YpO1xuICAgIH1cblxuICAgIC8vIDMuIEJhcmUgaW52b2NhdGlvbiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDIpLlxuICAgIGlmIChmaXJzdCA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG5cbiAgICAvLyA0LiBGaW5kIHRoZSB2ZXJiLlxuICAgIGxldCBjYW5kOiBzdHJpbmc7XG4gICAgbGV0IHJlc3Q6IHN0cmluZ1tdO1xuICAgIGlmIChncmFtbWFyID09PSBcInZlcmItZmlyc3RcIikge1xuICAgICAgaWYgKGZpcnN0ID09PSBcIi0tXCIpIHtcbiAgICAgICAgaWYgKGFyZ3ZbMV0gPT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vQ29tbWFuZCgpO1xuICAgICAgICBjYW5kID0gYXJndlsxXTtcbiAgICAgICAgcmVzdCA9IFtcIi0tXCIsIC4uLmFyZ3Yuc2xpY2UoMildO1xuICAgICAgfSBlbHNlIGlmIChmaXJzdC5zdGFydHNXaXRoKFwiLVwiKSkge1xuICAgICAgICByZXR1cm4gZGllKGB1bmtub3duIGZsYWcgYXQgdGhlIHJvb3Q6ICR7Zmlyc3R9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgIGhpbnQ6IGBjb21tYW5kcyAoZWFjaCB0YWtlcyBpdHMgb3duIGZsYWdzKTogJHt2ZXJicy5qb2luKFwiIFwiKX1gLFxuICAgICAgICB9KTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNhbmQgPSBmaXJzdDtcbiAgICAgICAgcmVzdCA9IGFyZ3Yuc2xpY2UoMSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGkgPSBzY2FuUG9zaXRpb25hbChhcmd2LCBmYWxzZSk7XG4gICAgICBpZiAoaSA8IDApIHtcbiAgICAgICAgLy8gTm8gdmVyYiBhbnl3aGVyZTogYW4gdW5rbm93biBmbGFnIGlzIHJlZnVzZWQgd2l0aCB0aGUgcm9vdCdzIHNldCxcbiAgICAgICAgLy8gYW5kIGEgY2xlYW4gcGFyc2UgaXMgYSBiYXJlIGludm9jYXRpb24uIE5laXRoZXIgcmFuIGEgY29tbWFuZCwgc29cbiAgICAgICAgLy8gdGhlIGVudmVsb3BlJ3MgYG1ldGEuY29tbWFuZGAgaXMgbnVsbCwgbm90IHRoZSBmaXJzdCBmbGFnJ3NcbiAgICAgICAgLy8gc3BlbGxpbmcgKGBnbGFtb3VyIC0tYm9ndXNgIG5hbWVzIG5vIHZlcmIpLlxuICAgICAgICBzZXRDdXJyZW50Q29tbWFuZChudWxsKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBwYXJzZUFyZ3MoeyBhcmdzOiBhcmd2LCBvcHRpb25zOiBwYXJzZU9wdGlvbnMsIHN0cmljdDogdHJ1ZSwgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSB9KTtcbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGRpZShlcnJNZXNzYWdlKGUpLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICAgIGNob2ljZXM6IFsuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXSxcbiAgICAgICAgICAgIGhpbnQ6IGBubyBjb21tYW5kIGdpdmVuIOKAlCBjb21tYW5kczogJHt2ZXJicy5qb2luKFwiIFwiKX0gKHJ1bjogJHtjbGlOYW1lfSBoZWxwKWAsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG5vQ29tbWFuZCgpO1xuICAgICAgfVxuICAgICAgY2FuZCA9IGFyZ3ZbaV0gYXMgc3RyaW5nO1xuICAgICAgLy8gQSB2ZXJiIGZvdW5kIHJpZ2h0IGFmdGVyIGEgYC0tYCBsZWF2ZXMgdGhhdCBgLS1gIGluIHBsYWNlLCBzbyB0aGVcbiAgICAgIC8vIHJlc3Qgb2YgdGhlIGFyZ3Ygc3RheXMgcG9zaXRpb25hbC5cbiAgICAgIHJlc3QgPSB3aXRob3V0KGFyZ3YsIGkpO1xuICAgIH1cbiAgICBzZXRDdXJyZW50Q29tbWFuZChjYW5kKTtcbiAgICBjb25zdCByID0gcmVzb2x2ZShjYW5kLCByZXN0KTtcbiAgICByZXR1cm4gcnVuUm93KHIucm93LCByLnRva2VuLCByLmFyZ3MpO1xuICB9O1xuXG4gIGNvbnN0IG1haW4gPSBhc3luYyAoYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4gPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc3QgcmVwb3J0ZWQgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgICAgLy8gVGhlIGhvdXNlIGNvbnRyYWN0IGlzIEpTT04gb24gc3RkZXJyIGZvciBFVkVSWSBmYWlsdXJlLiBBIHNwZWxsIHRoYXRcbiAgICAgIC8vIHRyaWFnZXMgaXRzIG93biAoZ2xhbW91cidzIEVOT0VOVCDihpIgdXNhZ2UpIGNhbGxzIGBkaXNwYXRjaGAgaW5zdGVhZC5cbiAgICAgIHJldHVybiByZXBvcnRDbGlFcnJvcihuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBlcnJNZXNzYWdlKGUpKSkgPz8gMTtcbiAgICB9XG4gIH07XG5cbiAgY29uc3QgdmlldyA9IChyOiBSb3cpOiBSb3dWaWV3ID0+ICh7XG4gICAgbmFtZTogci5uYW1lLFxuICAgIGFsaWFzZXM6IHIuYWxpYXNlcyxcbiAgICBmbGFnczogci5mbGFncyxcbiAgICBhY2NlcHRlZDogci5hY2NlcHRlZCxcbiAgICBwb3NpdGlvbmFsczogci5wb3NpdGlvbmFscyxcbiAgICBkZXNjcmliZTogci5kZXNjcmliZSxcbiAgICBhdXRvOiByLmF1dG8sXG4gIH0pO1xuXG4gIE9iamVjdC5hc3NpZ24oY2xpLCB7XG4gICAgbmFtZTogY2xpTmFtZSxcbiAgICBtYWluLFxuICAgIGRpc3BhdGNoLFxuICAgIGRlY2xhcmF0aW9uLFxuICAgIHJlbmRlckhlbHAsXG4gICAgdXNhZ2VPZjogKHBhdGg6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgciA9IHJvd0ZvcihwYXRoKTtcbiAgICAgIHJldHVybiByID09PSB1bmRlZmluZWQgPyBcIlwiIDogdXNhZ2VMaW5lKHIpO1xuICAgIH0sXG4gICAgdmVyYnMsXG4gICAgcGF0aHMsXG4gICAgZmxhZ3NGb3IsXG4gICAgcmVjb2duaXplZEZsYWdzOiBvcHRpb25LZXlzLm1hcCgoaykgPT4gYC0tJHtrfWApLFxuICAgIHJvd3M6IHJvd3MubWFwKHZpZXcpLFxuICB9IHNhdGlzZmllcyBDbGkpO1xuICByZXR1cm4gY2xpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIG9uZS1saW5lIEpTT04gZW1pdHRlciDigJQgT05FIGltcGxlbWVudGF0aW9uLCBpbXBvcnRlZCBieSBldmVyeVxuICogc3BlbGwgdGhhdCBzcGVha3MgdGhlIGFnZW50IHdpcmUuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBgc3JjL2tpdC9gJ3MgRklSU1QgSU5IQUJJVEFOVCwgYW5kIHRoYXQgaXMgbG9hZC1iZWFyaW5nIGJleW9uZFxuICogdGhlIHNoYXJpbmcgaXQgZG9lcy4gV2FyZCAyIChcInRoZSBraXQgaXMgYSBsZWFmXCIpIGhhcyBiZWVuIGdyZWVuIGJ5XG4gKiBDT05TVFJVQ1RJT04gc2luY2UgUGhhc2UgMCDigJQgaXQgaGFkIG5vdGhpbmcgdG8gd2FsaywgYW5kIHNhaWQgc28gb24gZXZlcnlcbiAqIHJ1bi4gVGhpcyBtb2R1bGUgaXMgdGhlIGZpcnN0IHRoaW5nIGl0IGFjdHVhbGx5IGd1YXJkcywgd2hpY2ggaXMgd2h5IHRoZVxuICogd2FyZCdzIHplcm8tZ3VhcmQgY2VsbCBkaXN0aW5ndWlzaGVzIGFuIEFCU0VOVCBraXQgZnJvbSBhbiBFTVBUWSBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgbm90IGEgc3BlbGwsXG4gKiBub3QgYSBzdXJmYWNlLCBub3QgYSBiYWNrZW5kLiBUaGF0IGlzIHdhcmQgMidzIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbixcbiAqIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoZSBraXQgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwncyBhcnRpZmFjdC5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgZGVwZW5kZW5jeS1mcmVlIGFuZCBkZWxpYmVyYXRlbHkgZHVsbDogaXQgaXMgYnVuZGxlZCBJTlRPIGVhY2hcbiAqIHNwZWxsJ3MgZW1pdHRlZCBDTEkgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIHNvIGFueXRoaW5nIGl0XG4gKiByZWFjaGVkIGZvciB3b3VsZCBiZWNvbWUgYSBkZXBlbmRlbmN5IG9mIHR3byBzaGlwcGVkIGFydGlmYWN0cyBhdCBvbmNlLlxuICpcbiAqIFRoZSB3aXJlIGNvbnRyYWN0IGl0IGVuY29kZXM6IGV4YWN0bHkgb25lIEpTT04gZG9jdW1lbnQsIG9uZSB0cmFpbGluZ1xuICogbmV3bGluZSwgbm90aGluZyBlbHNlIG9uIHN0ZG91dC4gQSBjYWxsZXIgcmVhZGluZyBvdXIgc3Rkb3V0IHdpdGggYVxuICogbGluZS1kZWxpbWl0ZWQgcGFyc2VyIGRlcGVuZHMgb24gdGhhdCBuZXdsaW5lOyBhIGNhbGxlciByZWFkaW5nIHRvIEVPRlxuICogZGVwZW5kcyBvbiB0aGVyZSBiZWluZyBubyBzZWNvbmQgZG9jdW1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bik6IHZvaWQge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIGZhaWx1cmUgY29udHJhY3Qg4oCUIHRoZSB0YXhvbm9teSwgdGhlIGV4aXQgY29kZXMsIHRoZVxuICogZW52ZWxvcGUsIGFuZCB0aGUgYGRpZWAgdGhhdCByYWlzZXMgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlXG4gKiBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZSAoc2VlIGAuLi9saWIvcHJpbnRKc29uLnRzYCwgdGhlIGtpdCdzIGZpcnN0XG4gKiBpbmhhYml0YW50LCBmb3IgdGhlIGZ1bGwgYWNjb3VudCkuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIElTIEEgQ09OVFJBQ1QgQU5EIE5PVCBBIFVUSUxJVFkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4gKiBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBBblxuICogYWdlbnQgcm91dGVzIG9uIGBraW5kYCBhbmQgb24gdGhlIGV4aXQgY29kZSwgc28gY2hhbmdpbmcgZWl0aGVyIGlzIGEgY2hhbmdlXG4gKiBhbiBhZ2VudCBPQlNFUlZFUyBhbmQgdGhlIHNwZWxsIG5lZWRzIGFuIGFjYyByZS1ncmFkZS4gVGhhdCBpcyB0aGUgY3V0IHRoaXNcbiAqIGRpcmVjdG9yeSBpcyBuYW1lZCBmb3IuXG4gKlxuICog4pSA4pSAIOKblCBgZGllYCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIFRIRSBQT0lOVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvXG4gKiBgcHJvY2Vzcy5leGl0KClgIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICogNjUsNTM2IGJ5dGVzLCBhbmQgdGhlIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzXG4gKiBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLCByZXBhaXJlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuXG4gKlxuICogVGhlIG9sZCBzaGFwZSB3cm90ZSBvbmUgc2hvcnQgZW52ZWxvcGUgdG8gc3RkZXJyIGFuZCBleGl0ZWQgaW1tZWRpYXRlbHksXG4gKiB3aGljaCBpcyBzYWZlIE9OTFkgd2hpbGUgdGhlIHBheWxvYWQgZml0cyB0aGUgNjQgS2lCIHBpcGUgYnVmZmVyIOKAlCBzdGRlcnJcbiAqIGlzIGN1dCBzaG9ydCBleGFjdGx5IGxpa2Ugc3Rkb3V0IChtZWFzdXJlZCkuIEl0IGFsc28gbWVhbnQgZXZlcnkgYGRpZWAgd2FzIGFcbiAqIHNlY29uZCBwbGFjZSB0aGUgcHJvY2VzcyBjb3VsZCBlbmQsIG9wYXF1ZSB0byB3aGF0ZXZlciB0aGUgdmVyYiBoYWRcbiAqIGFscmVhZHkgd3JpdHRlbiB0byBzdGRvdXQuXG4gKlxuICogU286IGBkaWVgIHJhaXNlcyBhIGBDbGlFcnJvcmAsIHRoZSBzcGVsbCdzIGBtYWluYCBjYXRjaGVzIGl0IHdpdGhcbiAqIGByZXBvcnRDbGlFcnJvcmAsIGFuZCB0aGUgcHJvY2VzcyBlbmRzIHRoZSBvbmUgd2F5IHRoZSBob3VzZSBzYW5jdGlvbnMg4oCUXG4gKiBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhIG5hdHVyYWwgcmV0dXJuLiBnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkXG4gKiB0aGlzIHNoYXBlIGluZGVwZW5kZW50bHkgYXQgdGhlaXIgYWNjIEwwIHBhc3NlczsgdGhpcyBtb2R1bGUgaXMgd2hlcmUgdGhlXG4gKiB0aHJlZSBjb3BpZXMgc3RvcCBiZWluZyB0aHJlZS5cbiAqXG4gKiDimqAgQSBgZGllYCBSRUFDSEFCTEUgZnJvbSBpbnNpZGUgYSBgdHJ5YCB3aG9zZSBgY2F0Y2hgIFNXQUxMT1dTIGlzIG5vdyBhXG4gKiBzaWxlbnQgY29udGludWUgcmF0aGVyIHRoYW4gYW4gZXhpdC4g4puUIFJFQUNIQUJJTElUWSwgTk9UIENBTEwgU0lURVM6IGFcbiAqIEhFTFBFUiB0aGF0IGRpZXMsIGludm9rZWQgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAsIGhhcyBpdHMgYGRpZWAgYXRcbiAqIGEgc2l0ZSB0aGF0IHJlYWRzIGFzIHBlcmZlY3RseSBzYWZlLiBBbiBhZG9wdGluZyBzcGVsbCBtdXN0IGZvbGxvdyB0aGUgY2FsbFxuICogZ3JhcGgsIG5vdCBncmVwIGZvciBgZGllKGAuIEF1ZGl0ZWQgdGhhdCB3YXkgb24gYWRvcHRpb24g4oCUIDE1IHNpdGVzIGluXG4gKiBhc3Ryb2xhYmUsIDI5IGluIG1hZ3BpZSwgcGx1cyB0aGUgaGVscGVycyByZWFjaGFibGUgZnJvbSB0aGVtIOKAlCBhbmQgZXZlcnlcbiAqIHBhdGggaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLCBmcm9tIHdoaWNoIHRoZSB0aHJvd1xuICogcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKipcbiAqIEV4dHJhIGZpZWxkcyBhIGZhaWx1cmUgbWF5IGNhcnJ5LiBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaXRlbXMvdGFpbC1yZWFkZXItY29udmVyZ2VuY2Uvd3JpdGUtdXAubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLlxuICAgKlxuICAgKiAg4puUIEFORCBXSEVOIFRIRSBORVcgTE9HIFdBUyBBTFJFQURZIFBBU1QgVEhFIEJPT0tNQVJLLCBUSEUgQ0xJRU5UXG4gICAqICBSRUNPTk5FQ1RTIEZST00gSVRTIFNUQVJULiBBIGRhZW1vbiB0aGF0IGJlbGlldmVzIHRoZSBjdXJzb3Igc2VuZHMgb25seVxuICAgKiAgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hbiBtZXNzYWdlIGF0XG4gICAqICBuZXcgaWQgMiB1bmRlciBhbiBvbGQgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHNpbGVudGx5LiBFdmVyeXRoaW5nIGluXG4gICAqICBhIG5ldyBlcG9jaCBpcyBuZXcgdG8gdGhpcyByZWFkZXIsIHNvIHRoZSBhdHRlbXB0IGlzIGRyb3BwZWQgYW5kIHJlLW1hZGVcbiAgICogIGZyb20gMCBhdCBvbmNlIChubyBiYWNrb2ZmKS4gQSBmcmFtZSBBVCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIG1lYW5zXG4gICAqICB0aGUgZGFlbW9uIGlzIGFscmVhZHkgcmVwbGF5aW5nIHdob2xlLCBhbmQgaXMga2VwdC4gKFJldmlld2VyJ3MgRDIgZ2FwLFxuICAgKiAgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYuKSAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBlcG9jaCB0aGUgc3RhcnRpbmcgYHNpbmNlYCBjYW1lIGZyb20sIHdoZW4gdGhlIGNhbGxlciBoYXMgb25lIChhXG4gICAqICBib29rbWFyayBwcmludGVkIGFzIGBOQDxlcG9jaD5gLCBgLi90YWlsSGFuZG9mZi50c2ApLiBUaGUgZmlyc3QgZnJhbWUgb2YgYVxuICAgKiAgZGlmZmVyZW50IGVwb2NoIGlzIHRoZW4gYW4gZXBvY2ggY2hhbmdlIGxpa2UgYW55IG90aGVyIOKAlCB3aGljaCBpcyB3aGF0XG4gICAqICBzdG9wcyBhIGJvb2ttYXJrIG91dGxpdmluZyBpdHMgbG9nIGFjcm9zcyBwcm9jZXNzZXMuICovXG4gIHNpbmNlRXBvY2g/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSZWFkIGEgZnJhbWUgd2hvc2UgaWQgaXMgQVQgT1IgQkVMT1cgdGhlIGN1cnNvciB0aGlzIGNvbm5lY3Rpb24gYXNrZWRcbiAgICogZnJvbSBhcyBcInRoZSBsb2cgcmVzdGFydGVkXCIsIHJlc2V0IHRoZSBjdXJzb3IgdG8gMCwgYW5kIGNhbGxcbiAgICogYG9uRXBvY2hDaGFuZ2VgICh3aXRoIHRoZSBmcmFtZSdzIGVwb2NoLCBvciBgXCJ1bmtub3duXCJgKS4gRGVmYXVsdCBmYWxzZS5cbiAgICpcbiAgICog4puUIFdIWSBJVCBJUyBIT05FU1Q6IHRoZSBraXQncyBldmVudCBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93blxuICAgKiBieSByZXBsYXlpbmcgV0hPTEUgKGAuL2V2ZW50TG9nLnRzYCwgcG9pbnQgMyksIGFuZCBvdGhlcndpc2Ugc2VuZHMgb25seVxuICAgKiBpZHMgYWJvdmUgdGhlIGN1cnNvci4gU28gYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGV4aXN0cyBvbmx5XG4gICAqIHdoZW4gdGhlIGRhZW1vbiBqdWRnZWQgdGhlIGN1cnNvciBmb3JlaWduIOKAlCBhIHJlc3RhcnRlZCBkYWVtb24sIHdob3NlIGlkc1xuICAgKiBiZWdhbiBhZ2FpbiBhdCAxLiBUaGUgZXBvY2ggY2F0Y2hlcyB0aGF0IFdJVEhJTiBvbmUgcHJvY2VzczsgdGhpcyBjYXRjaGVzXG4gICAqIGl0IEFDUk9TUyBwcm9jZXNzZXMsIHdoZXJlIGEgcmUtYXJtZWQgdGFpbCBjYXJyaWVzIGEgYm9va21hcmsgZnJvbSBhIGxvZ1xuICAgKiB0aGF0IG5vIGxvbmdlciBleGlzdHMgYW5kLCB3aXRob3V0IGl0LCBrZXB0IHRoYXQgYm9va21hcmsgZm9yZXZlcjogZXZlcnlcbiAgICogcmUtYXJtIHJlcGxheWVkIHRoZSB3aG9sZSBuZXcgbG9nLCBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcFxuICAgKiAoZm91bmQgYnkgdGhlIHZlcmlmaWVyIG9uIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCBhZnRlciBgdGFpbC5sb3N0YCDihpJcbiAgICogYG9wZW4gLS1yZXN0b3JlYCkuXG4gICAqXG4gICAqIOKaoCBPTkxZIEZPUiBBIERBRU1PTiBPTiBUSEUgS0lUJ1MgRVZFTlQgTE9HLiBHcmFwZXZpbmUncyBpZHMgYXJlIHJlY292ZXJlZFxuICAgKiBhY3Jvc3MgYSByZXN0YXJ0IGFuZCBpdHMgYC0tbGFzdGAgcXVlcnkgb3ZlcnJpZGVzIGBzaW5jZWAsIHNvIGl0IGxlYXZlc1xuICAgKiB0aGlzIG9mZi4gQW5kIHRoZSBibGluZCBzcG90IGlzIHN0YXRlZDogYSBib29rbWFyayB0aGF0IGhhcHBlbnMgdG8gYmUgYXRcbiAgICogb3IgYmVsb3cgdGhlIFJFU1RBUlRFRCBsb2cncyBvd24gbGVuZ3RoIGxvb2tzIHZhbGlkIHRvIHRoZSBkYWVtb24sIHdoaWNoXG4gICAqIHRoZW4gc2VuZHMgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQuIFRoZSBjb21lLWJhY2sgcGF0aCB0aGVyZWZvcmUgZHJvcHNcbiAgICogdGhlIGJvb2ttYXJrIGFsdG9nZXRoZXIgKGAuL3RhaWxIYW5kb2ZmLnRzYCwgRDIpLCBzbyB0aGlzIGlzIHRoZSBuZXQsIG5vdFxuICAgKiB0aGUgcnVsZS5cbiAgICovXG4gIHJlc3RhcnRPblJlcGxheT86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gYGFjY2VwdGVkYCBpcyBgYWNjZXB0YCdzXG4gICAqICB2ZXJkaWN0IG9uIHRoaXMgZnJhbWUsIHdoaWNoIGlzIHdoYXQgbGV0cyBgdGFpbCAtLW9uY2VgIGVuZCBvbiB0aGUgZmlyc3RcbiAgICogIGZyYW1lIGl0IGFjdHVhbGx5IERFTElWRVJTIChgLi90YWlsSGFuZG9mZi50c2ApLlxuICAgKlxuICAgKiAg4puUIEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OIGJlZm9yZSB0aGUgY2xpZW50IHJldHVybnMuIEl0XG4gICAqICB1c2VkIHRvIHJldHVybiBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIHdpdGggdGhlIFNTRSBzdHJlYW0gc3RpbGwgb3BlbixcbiAgICogIHdoaWNoIGtlcHQgdGhlIHByb2Nlc3MgYWxpdmUg4oCUIHVuc2VlbiBmb3IgYGNsb3NlZGAsIGJlY2F1c2UgdGhlIHNlcnZlclxuICAgKiAgZW5kcyB0aGF0IHN0cmVhbSBpdHNlbGYsIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFza1xuICAgKiAgd291bGQgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQuIChBZGp1c3RtZW50IDEgb2YgdGhlXG4gICAqICBNb25pdG9yLWV4cGlyeSBzcGlrZTsgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lLCBhY2NlcHRlZDogYm9vbGVhbikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBhcyB0aGUgdGFpbCBlbmRzLCB3aXRoIHRoZSBmaW5hbCBjdXJzb3IgKHRoZSBib29rbWFyayBhIHJlLWFybVxuICAgKiBwYXNzZXMgYXMgYC0tc2luY2VgKSBhbmQgd2h5IGl0IGVuZGVkLiBBIFJFUE9SVCBTSU5LIGxpa2UgYG9uRGlzY29ubmVjdGAsXG4gICAqIG5vdCBhIGJlaGF2aW91cmFsIGhhdGNoOiBpdCBjaGFuZ2VzIG5vdGhpbmcgdGhlIGNsaWVudCBkb2VzLiBJdCBleGlzdHNcbiAgICogZm9yIGAuL3RhaWxIYW5kb2ZmLnRzYCwgd2hvc2UgbGFzdCBsaW5lIG5hbWVzIHRoZSByZS1hcm0gYW5kIG11c3QgY2FycnlcbiAgICogdGhlIGN1cnNvciBleGFjdGx5IGFzIHRoaXMgbG9vcCBsZWZ0IGl0LCBlcG9jaCByZXNldHMgaW5jbHVkZWQuXG4gICAqL1xuICBvbkVuZD86IChlbmQ6IHtcbiAgICBjdXJzb3I6IG51bWJlcjtcbiAgICAvKiogVGhlIGVwb2NoIG9mIHRoZSBsb2cgdGhlIGN1cnNvciBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZS4gKi9cbiAgICBlcG9jaDogc3RyaW5nIHwgbnVsbDtcbiAgICByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCI7XG4gIH0pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7XG4gIGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7XG4gIGNvbW1lbnRzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBvcHRzLnNpbmNlRXBvY2ggPz8gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG4gIGxldCBlbmRpbmc6IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgPSBcInN0b3BwZWRcIjtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIC8vIOKblCBBIFNUT1AgVEhBVCBMQU5ERUQgV0hJTEUgYHJlc29sdmVgIFdBUyBBV0FJVEVEICh0aGUgaGFuZG9mZidzIHdpbmRvdyxcbiAgICAgIC8vIGEgc2lnbmFsKSBmb3VuZCBubyBhdHRlbXB0IHRvIGFib3J0LiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlIGxvb3Agd2VudFxuICAgICAgLy8gb24gdG8gZmV0Y2gsIHNraXBwZWQgdGhlIHJlYWQsIGFuZCByZXR1cm5lZCB3aXRoIHRoYXQgc3RyZWFtIHN0aWxsXG4gICAgICAvLyBvcGVuIOKAlCB3aGljaCBrZWVwcyBhIHByb2Nlc3MgYWxpdmUgZXhhY3RseSBsaWtlIHRoZSB0ZXJtaW5hbC1mcmFtZVxuICAgICAgLy8gaGFuZy4gKFN1c3BlY3RlZCBieSB0aGUgcmV2aWV3ZXIsIHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKVxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHtcbiAgICAgICAgc2luY2U6IFN0cmluZyhjdXJzb3IpLFxuICAgICAgfTtcbiAgICAgIC8vIFdoYXQgdGhpcyBjb25uZWN0aW9uIGFza2VkIGZyb20sIGZvciBgcmVzdGFydE9uUmVwbGF5YC5cbiAgICAgIGNvbnN0IGFza2VkU2luY2UgPSBjdXJzb3I7XG4gICAgICBsZXQgcmVzdGFydE5vdGVkID0gZmFsc2U7XG4gICAgICAvLyBTZXQgd2hlbiBhbiBlcG9jaCBjaGFuZ2UgZmluZHMgdGhlIG5ldyBsb2cgcGFzdCB0aGUgYm9va21hcmsuXG4gICAgICBsZXQgZnJvbVRvcCA9IGZhbHNlO1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcblxuICAgICAgICAgICAgbGV0IGVwb2NoUmVzZXQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGVwb2NoUmVzZXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICAgIC8vIFRoZSBuZXcgbG9nIGlzIHBhc3QgdGhlIGJvb2ttYXJrOiBpdHMgc3RhcnQgd2FzIHNraXBwZWQuXG4gICAgICAgICAgICAgICAgICAvLyBEcm9wIHRoaXMgYXR0ZW1wdCBhbmQgcmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIDAuXG4gICAgICAgICAgICAgICAgICBpZiAoYXNrZWRTaW5jZSA+IDAgJiYgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgbiA+IGFza2VkU2luY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICAgICAgICBmcm9tVG9wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBvcHRzLnJlc3RhcnRPblJlcGxheSA9PT0gdHJ1ZSAmJlxuICAgICAgICAgICAgICAhZXBvY2hSZXNldCAmJlxuICAgICAgICAgICAgICAhcmVzdGFydE5vdGVkICYmXG4gICAgICAgICAgICAgIGFza2VkU2luY2UgPj0gMCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICBuIDw9IGFza2VkU2luY2VcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyBUaGUgZGFlbW9uIHJlcGxheWVkIFdIT0xFOiBpdHMgbG9nIHJlc3RhcnRlZCAoc2VlIHRoZSBvcHRpb24pLlxuICAgICAgICAgICAgICByZXN0YXJ0Tm90ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4ob3B0cy5lcG9jaE9mPy4oZXYpID8/IFwidW5rbm93blwiKSA/PyBudWxsO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgIC8vIFJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSBpdHMgc3RhcnQsIG5vdzogbm90aGluZyBmYWlsZWQuXG4gICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gICAgb3B0cy5vbkVuZD8uKHsgY3Vyc29yLCBlcG9jaCwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvaXRlbXMvc2NyaXB0b3JpdW0tdGFpbC1tb25pdG9yLWV4cGlyeS13YWtlcy10aGUtYWdlbnQtZm9yLW5vdGhpbmcubWRgKVxuICogYW5kIHRoZSBmb3VyIGFkanVzdG1lbnRzIG9mIGl0cyBmZWFzaWJpbGl0eSBzcGlrZVxuICogKGBkb2NzL2l0ZW1zL21vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC93cml0ZS11cC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgKGFzdHJvbGFiZSwgZ3JhcGV2aW5lKSBhbHdheXMgZ2V0c1xuICogICAgIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsIHdvdWxkIGZsaWNrZXIgdGhlIHByZXNlbmNlIGl0c1xuICogICAgIGNvbm5lY3Rpb24gY2Fycmllcy4gTWluZC1tYXBwZXIgd2FzIG9uZSBhbmQgaXMgbm90IHNpbmNlIDIwMjYtMDktMjRcbiAqICAgICAoc2VlIFwiTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTXCIgYmVsb3cpLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMgYW5kIG1pbmQtbWFwcGVyKSwgZWFjaCBuYW1pbmcgaG93IHRvXG4gKiBjb21lIGJhY2sgaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMsIGBvcGVuIC0tbm8tb3BlbmAgZm9yXG4gKiAgICAgIG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmUgYVxuICogcmVhbC1kYWVtb24gY2VsbCBpbiBgc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdGFpbC1oYW5kb2ZmLmludGVncmF0aW9uLnRlc3QudHNgLlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4tcHJvY2Vzc1xuICogICAgICAgICAgICAoYXN0cm9sYWJlLCBvciBtaW5kLW1hcHBlciB3aGVuIGl0cyBkYWVtb24gaXMgYmFjayBiZWZvcmUgdGhlXG4gKiAgICAgICAgICAgIGxvc3QgcnVsZSBmaXJlcykgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHlcbiAqICAgICAgICAgICAgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBvcGVucyBub1xuICogYnJvd3NlciB0YWIuXG4gKlxuICog4pqgIEtOT1dOIEVER0UsIE5PVCBGSVhFRCAoZm91bmQgYnkgdGhlIHJlLXJldmlldyk6IGEga2V5ZWQgYm91bnR5IEZJUlNUIGFybVxuICogICAoYW4gYW50aGlsbCBzZWF0KSB3aG9zZSB3aW5kb3cgZW5kcyBiZWZvcmUgaXRzIGJvYXJkIGV2ZXIgb3BlbnMgcHJpbnRzIGFcbiAqICAgcmUtYXJtIHBpbm5lZCB0byB0aGUgZGVyaXZlZCBpZCB3aXRoIGFuIGVtcHR5IGJvb2ttYXJrXG4gKiAgIChgLS1zZXNzaW9uIGst4oCmIC0tc2luY2U9LTEgLS1vbmNlYCkuIFRoYXQgcmUtYXJtIGlzIGEgcmUtYXJtIGJ5IEQxJ3MgcnVsZSxcbiAqICAgc28gaWYgdGhlIGJvYXJkIGlzIHN0aWxsIG5vdCB1cCDigJQgdGhlIGxlYWQgbW9yZSB0aGFuIG9uZSB3aW5kb3cgKDI5IG1pbilcbiAqICAgbGF0ZSDigJQgdGhlIHNlYXQgZ2V0cyBgdGFpbC5jbG9zZWRgIGluc3RlYWQgb2Ygd2FpdGluZy4gTWlub3I6IHRoZVxuICogICBjb21lLWJhY2sgaXQgbmFtZXMgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApIGlzIHRoZSByaWdodCBuZXh0IHN0ZXAgYW55d2F5LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09NTUFORCBOQU1FUyBOTyBQQVRIIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbGluZSdzIGBjb21tYW5kYCBpcyB0aGUgVkVSQiBBTkQgSVRTIEFSR1VNRU5UUyBPTkxZXG4gKiAoYHRhaWwgLS1zZXNzaW9uIFggLS1zaW5jZSBOQEUgLS1vbmNlYCksIHBsdXMgYHNwZWxsYCwgYW5kIHRoZSBhZ2VudCBydW5zIGl0XG4gKiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzYC4gSXQgdXNlZFxuICogdG8gYmUgcnVubmFibGUgYXMgcHJpbnRlZCwgaGVhZGVkIGJ5IGBidW4gPGFyZ3ZbMV0+YCDigJQgYW5kIGZvciBhbiBpbnN0YWxsZWRcbiAqIHBsdWdpbiBgYXJndlsxXWAgaXMgaW5zaWRlIGEgVkVSU0lPTkVEIGNhY2hlIGRpcmVjdG9yeS4gQW4gdXBncmFkZSBtYXJrcyB0aGVcbiAqIG9sZCBkaXJlY3Rvcnkgb3JwaGFuZWQgYW5kIGRlbGV0ZXMgaXQgbGF0ZXIgKG1lYXN1cmVkIGluXG4gKiBgZG9jcy9pdGVtcy90YWlsLXJlYXJtLWNvbW1hbmQtbmFtZXMtYS12ZXJzaW9uZWQtcGx1Z2luLXBhdGgubWRgKSxcbiAqIHNvIGEgbGluZSBwcmludGVkIGJlZm9yZSBhbiB1cGdyYWRlIGZpcnN0IHJhbiBTVEFMRSBjb2RlIGFnYWluc3QgYSBuZXdlclxuICogZGFlbW9uLCB0aGVuIGZhaWxlZCB3aXRoIFwibW9kdWxlIG5vdCBmb3VuZFwiIG9uY2UgdGhlIGRpcmVjdG9yeSB3YXMgZ29uZS4gTm9cbiAqIHN0YWJsZSBwYXRoIGV4aXN0cyB0byBwcmludCBpbnN0ZWFkOiB0aGUgY2FjaGUsIGAkQ0xBVURFX1BMVUdJTl9ST09UYCBhbmQgdGhlXG4gKiBpbnN0YWxsIHJlY29yZCBhcmUgYWxsIHZlcnNpb25lZC5cbiAqICAgVGhlIHNraWxsJ3MgbGF1bmNoZXIgaXMgYWx3YXlzIHRoZSB2ZXJzaW9uIHRoZSBzZXNzaW9uIGxvYWRlZC4gQ29sZSdzXG4gKiByZWFzb25pbmc6IHRoZSB3b3JzdCBjYXNlIGlzIHRoYXQgdGhlIENMSSBjaGFuZ2VkIGFuZCB0aGUgYWdlbnQgZ2V0cyBhblxuICogZXJyb3Ig4oCUIGFuZCBpZiB0aGUgdG9vbHMgYXJlIGRlc2lnbmVkIHJpZ2h0LCB0aGF0IGVycm9yIHNheXMgd2hhdCB3ZW50XG4gKiB3cm9uZy4gU28gdGhlIHBhcnNlcnMgYXJlIHRoZSBvdGhlciBoYWxmIG9mIHRoaXMgcnVsaW5nOiBgcmVhZFNpbmNlYCByZWZ1c2VzXG4gKiBhbnkgYC0tc2luY2VgIGZvcm0gYSB0YWlsIGRvZXMgbm90IGFjY2VwdCB3aXRoIGEgdXNhZ2UgZXJyb3IgTkFNSU5HIHRoZVxuICogZm9ybXMgaXQgZG9lcywgdGhlIHNhbWUgd2F5IG9uIGFsbCBlaWdodCB0YWlscywgaW5zdGVhZCBvZiBtaXNwYXJzaW5nIGl0LlxuICogICBOb3QgdGFrZW46IHByaW50aW5nIHRoZSBwYXRoIEFORCB0aGUgYXJncyAob3B0aW9uIEEgb2YgdGhlIGl0ZW0g4oCUIHR3b1xuICogY29tbWFuZHMgd2hlcmUgb25lIGlzIHdyb25nIGFmdGVyIGFuIHVwZ3JhZGUpOyBhIGxhdW5jaGVyIHRoYXQgbm90aWNlcyBpdCBpc1xuICogb3JwaGFuZWQgYW5kIHJlLWV4ZWNzIGEgbmV3ZXIgc2libGluZyAoQiDigJQgaXQgbGVhbnMgb24gYSBDbGF1ZGUgQ29kZVxuICogaW50ZXJuYWwgbWFya2VyIGFuZCBkb2VzIG5vdGhpbmcgb25jZSB0aGUgZGlyZWN0b3J5IGlzIGRlbGV0ZWQpOyB2ZXJzaW9uXG4gKiBuZWdvdGlhdGlvbi5cbiAqXG4gKiDilIDilIAgTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC9taW5kLW1hcHBlci1xdWlldC1oYW5kb2ZmYC4gSXQgUkVWRVJTRVMgdGhlIGltcGxlbWVudGVyJ3NcbiAqIHJ1bGluZyBvZiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRoYXQgbWluZC1tYXBwZXIgaXMgYSBwcmVzZW5jZSBzcGVsbFxuICogKGl0cyBkYWVtb24gY291bnRzIGFuIG9wZW4gU1NFIHRhaWwgYXMgdGhlIGFnZW50IHByZXNlbnQsIHNvIHRoZSB3aW5kb3dcbiAqIGFsd2F5cyByZS1hcm1lZCBNb25pdG9yKS4gQ29sZSdzIHJlYXNvbmluZzogbWluZC1tYXBwZXIgc2Vzc2lvbnMgYXJlIHVzZWRcbiAqIGxpa2Ugc2NyaXB0b3JpdW0ncywgYnVyc3RzIG9mIGFjdGl2aXR5IHdpdGggYnJlYWtzLCBhbmQgaW4gYSBicmVhayB0aGUgYWdlbnRcbiAqIHNob3VsZCBub3QgYmUgd29rZW4gZXZlcnkgMzAgbWludXRlcy4gU28gbWluZC1tYXBwZXIgdGFrZXMgdGhlIHF1aWV0IGhhbmRvZmZcbiAqIHRvIGAtLW9uY2VgLCB0aGUgbG9zdCBjb21lLWJhY2sgKGBvcGVuIC0tbm8tb3BlbmApLCBhbmQga2VlcHMgaXRzXG4gKiBgLS1zaW5jZSBOQGVwb2NoYCBib29rbWFyay4gVGhyZWUgdGhpbmdzIGhhZCB0byBiZSBzZXR0bGVkIHRvIG1ha2UgdGhhdFxuICogaG9uZXN0LCBlYWNoIHBpbm5lZCBpbiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQve3RhaWwscHJlc2VuY2V9LnRlc3QudHNgXG4gKiBhbmQgbXV0YXRpb24tY29uZmlybWVkOlxuICpcbiAqIE0xIMK3IFBSRVNFTkNFIExJTkdFUlMgQUNST1NTIFRIRSBHQVBTICh0aGUgZGFlbW9uLCBgc2VydmVyLnRzYFxuICogICAgICBgYWRqdXN0QWdlbnRzYCkuIEEgb25lLXNob3QgaG9sZHMgYW4gU1NFIGNvbm5lY3Rpb24sIHNvIGl0IENPVU5UUyBhc1xuICogICAgICBwcmVzZW50LCB3aGljaCBpcyB0cnVlOiB0aGUgYWdlbnQgd2lsbCB3YWtlIG9uIHRoZSBuZXh0IGV2ZW50LiBUaGUgZ2Fwc1xuICogICAgICBhcmUgdGhlIHByb2JsZW06IHdpbmRvdyDihpIgcmUtYXJtLCBxdWlldCDihpIgYC0tb25jZWAsIGFuZCBhYm92ZSBhbGxcbiAqICAgICAgYHRhaWwud29rZWAg4oaSIHRoZSBhZ2VudCBoYW5kbGVzIHRoZSBldmVudCDihpIgTW9uaXRvciwgd2hpY2ggbGFzdHMgdGhlXG4gKiAgICAgIGFnZW50J3Mgd2hvbGUgdHVybi4gUmF3LCB0aGUgc3VyZmFjZSdzIGhlYWRlciBkb3QgKHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgIHByZXNlbmNlIGRyaXZlcyB0aGVyZSwgYmVzaWRlcyB0aGUgZGFlbW9uJ3MgYXV0by1gcmVjZWl2ZWRgIGZsaXAgb24gYVxuICogICAgICBodW1hbiBtZXNzYWdlKSByZWFkIFwiY29ubmVjdGVkIOKAlCBubyBhZ2VudCBvbiB0aGlzIHByb2plY3RcIiB3aGlsZSB0aGVcbiAqICAgICAgYWdlbnQgd2FzIHdvcmtpbmcgdGhlIGJvYXJkLCBhbmQgYSBtZXNzYWdlIHNlbnQgdGhlbiBnb3Qgbm9cbiAqICAgICAgYHJlY2VpdmVkYC4gVGhlIGRhZW1vbiBoYXMgbm8gaWRsZSBjbG9zZSwgc28gbm90aGluZyBlbHNlIHJlYWN0cy4gTm93XG4gKiAgICAgIHRoZSBjb3VudCBIT0xEUyBmb3IgYE1JTkRfTUFQUEVSX1BSRVNFTkNFX0xJTkdFUl9NU2AgKDE1MCBzLCB0aGUgc3RhbGxcbiAqICAgICAgd2luZG93J3MgYmVhdCkgYWZ0ZXIgdGhlIGxhc3QgdGFpbCBjbG9zZXM6IGEgdGFpbCBvcGVuaW5nIGluc2lkZSBpdFxuICogICAgICBlbWl0cyBub3RoaW5nLCBhbiBhZ2VudC1vbmx5IHdyaXRlIChgL2FjdGl2aXR5YCwgYW4gYWdlbnQgYC9zZW5kYClcbiAqICAgICAgcmVzdGFydHMgaXQsIGFuZCBzaWxlbmNlIHBhc3QgaXQgZHJvcHMgdGhlIGNvdW50IHRvIDAuXG4gKiAgICAgIOKaliBOb3QgdGFrZW46IHJlLWFybWluZyBNb25pdG9yIEJFRk9SRSBoYW5kbGluZyBhIHdva2VuIGV2ZW50ICh0aGF0IGlzXG4gKiAgICAgIHRoZSBzaGFyZWQgcnVsZSwgd29yZC1mb3Itd29yZCBpbiBldmVyeSBzcGVsbCk7IHJlZnJlc2hpbmcgb24gZXZlcnlcbiAqICAgICAgYm9hcmQgd3JpdGUgKHRoZSBicm93c2VyIFBPU1RzIHRoZSBzYW1lIHJvdXRlcywgc28gdGhlIGh1bWFuJ3Mgb3duXG4gKiAgICAgIGNsaWNrcyB3b3VsZCBrZWVwIHRoZSBkb3QgbGl0KS4gQ29zdDogYW4gYWdlbnQgdGhhdCByZWFsbHkgbGVmdCByZWFkc1xuICogICAgICBcImhlcmVcIiBmb3IgdXAgdG8gMTUwIHMuXG4gKiBNMiDCtyBgcHJlc2VuY2UuY2hhbmdlZGAgSVMgTk9UIENPVU5URUQgKG1pbmQtbWFwcGVyJ3MgYGNvdW50c2ApLiBJdCBpcyBPTlxuICogICAgICBUSEUgTE9HLCB3aXRoIGFuIGlkLCBhbmQgYSB0YWlsJ3Mgb3duIGNvbm5lY3QgZW1pdHMgb25lIG9udG8gaXRzIG93blxuICogICAgICBzdHJlYW0sIHNvIGNvdW50ZWQgaXQgbWFkZSBldmVyeSB3aW5kb3cgXCJhY3RpdmVcIiBhbmQgd291bGQgd2FrZSBldmVyeVxuICogICAgICBgLS1vbmNlYCBvbiBpdHNlbGYuIFRoZSBsaW5nZXIgcmVtb3ZlcyBtb3N0IG9mIHRoYXQgY2h1cm47IGBjb3VudHNgXG4gKiAgICAgIHJlbW92ZXMgdGhlIHJlc3QgKGEgZmlyc3QgYXJtLCBhbm90aGVyIGFnZW50IGNvbWluZyBvciBnb2luZykuXG4gKiBNMyDCtyBBIERFQUQgREFFTU9OIElTIExPU1QsIE5PVCBVTlJFU09MVkVEIChtaW5kLW1hcHBlcidzIGByZXNvbHZlYCkuIEl0c1xuICogICAgICBkaXNjb3ZlcnkgcHJvYmVzIHRoZSBkYWVtb24ncyBwaWQsIHNvIGEga2lsbGVkIGRhZW1vbiBtYWRlIGByZXNvbHZlYFxuICogICAgICBhbnN3ZXIgbnVsbCBhbmQgYW4gdW5yZXNvbHZlZCB0YWlsIHJldHJpZXMgZm9yZXZlcjogYSBgLS1vbmNlYCB3b3VsZFxuICogICAgICBoYXZlIHNsZXB0IGZvciBnb29kIChEMSdzIGRlZmVjdCkuIFRoZSB0YWlsIGtlZXBzIHRoZSBsYXN0IFVSTCBpdFxuICogICAgICByZXNvbHZlZCwgc28gdGhlIGRlYWQgcG9ydCByZWZ1c2VzIGFuZCBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgZW5kcyBpdFxuICogICAgICB3aXRoIGB0YWlsLmxvc3RgIOKGkiBgb3BlbiAtLW5vLW9wZW5gLCB0aGVuIGEgdGFpbCB3aXRoIG5vIGAtLXNpbmNlYC5cbiAqICAgICAgTWluZC1tYXBwZXIgaGFzIG5vIHNlc3Npb24gdG8gY2xvc2UsIHNvIGl0IG5ldmVyIHByaW50cyBgdGFpbC5jbG9zZWRgLlxuICogICAgICBNZWFzdXJlZCBvbiBhIHJlYWwgYGtpbGwgLTlgIHVuZGVyIGEgYC0tb25jZWA6IGB0YWlsLmxvc3RgIDcgcyBsYXRlcixcbiAqICAgICAgbm90IDAuNzUgcywgYmVjYXVzZSBtaW5kLW1hcHBlcidzIG93biBiYWNrb2ZmIHN0YXJ0cyBhdCAxIHMgKDEgKyAyICsgNCkuXG4gKiAgICAgIE0x4oCTTTMgd2VyZSBkcml2ZW4gb24gYSByZWFsIGRhZW1vbiB3aXRoIGEgNCBzIHdpbmRvdzogYWN0aXZlIOKGkiB3aW5kb3csXG4gKiAgICAgIHF1aWV0IOKGkiBgLS1vbmNlYCwgYSBodW1hbiBtZXNzYWdlIHdva2UgaXQsIGJhY2sgdG8gTW9uaXRvcjsgcHJlc2VuY2VcbiAqICAgICAgbmV2ZXIgZHJvcHBlZCBhY3Jvc3MgdGhlIGdhcHMuXG4gKlxuICog4pqWIGAtLW9uY2VgIEVORFMgT04gVEhFIEZJUlNUIEZSQU1FLCB3aXRoIG5vIGRyYWluLiBBIGJ1cnN0IGFycml2ZXMgc3BsaXQ6IHRoZVxuICogICBmaXJzdCBldmVudCBvbiB0aGUgb25lLXNob3QsIHRoZSByZXN0IG9uIHRoZSBNb25pdG9yIHJlLWFybSwgd2hpY2ggbG9zZXNcbiAqICAgbm90aGluZyBiZWNhdXNlIG9mIHRoZSBib29rbWFyay4gVGhlIHNwaWtlIG9mZmVyZWQgYSB+MjAwIG1zIGRyYWluIGFzIGFuXG4gKiAgIG9wdGlvbiwgbm90IGEgcmVxdWlyZW1lbnQ7IG5vdCB0YWtlbiwgYmVjYXVzZSBpdCBhZGRzIGEgdGltZXIgdG8gdGhlXG4gKiAgIGV4aXQgcGF0aCB3aG9zZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byBtYWtlIGltcG9zc2libGUuXG4gKiDimpYgVEhFIExJTkUnUyBgY29tbWFuZGAgSVMgQ09NUExFVEUgQlVUIEZPUiBUSEUgTEFVTkNIRVI6IHBpbm5lZCB0byB0aGVcbiAqICAgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlIHNraWxscyBuYW1lIHRoZVxuICogICBydWxlIG9uY2UsIGxhdW5jaGVyIGZvcm0gaW5jbHVkZWQ7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICAvKiogVGhlIHZlcmIgYW5kIGl0cyBhcmd1bWVudHMgT05MWSDigJQgbm8gbGF1bmNoZXIsIG5vIHBhdGguIFRoZSBhZ2VudCBydW5zXG4gICAqICBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5gLiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKiBIb3cgdGhlIGFnZW50IHJ1bnMgYSBwcmludGVkIGBjb21tYW5kYDogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBuZXZlciBhIHBhdGhcbiAqICB0aGlzIHByb2Nlc3MgbmFtZXMgKHRoZSBydWxpbmcgb24gdGhlIHZlcnNpb25lZCBwbHVnaW4gcGF0aCwgaW4gdGhlIGhlYWRlcikuICovXG5leHBvcnQgY29uc3QgUlVOX1dJVEhfTEFVTkNIRVIgPSBcImJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+XCI7XG5cbi8qKiBUaGUgY29tZS1iYWNrIGhpbnQsIHdpdGggaG93IHRvIFJFU1VNRSBhZnRlciBjb21pbmcgYmFjayAoRDIpOiBhIHJlc3RvcmVkXG4gKiAgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgbWVhbnMgbm90aGluZyB0aGVyZS4gKi9cbmNvbnN0IENPTUVfQkFDSyA9ICh3aHk6IHN0cmluZykgPT5cbiAgYCR7d2h5fSBUbyBicmluZyBpdCBiYWNrLCBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn07IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBzcGVsbDogcy5zcGVsbCwgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLS1zaW5jZT0tMSBmb3IgZXZlcnl0aGluZylcIlxuICAgICAgOiBgYW4gZXZlbnQgaWQgKGFuIGludGVnZXIsICR7bWlufSBvciBtb3JlKWA7XG4gIGNvbnN0IGZvcm1zID0gby5lcG9jaCA/IGAke2lkfSwgb3IgPGlkPkA8ZXBvY2g+IGFzIGEgaGFuZG9mZiBsaW5lIHByaW50cyBpdGAgOiBpZDtcbiAgY29uc3Qgd2h5ID1cbiAgICAhby5lcG9jaCAmJiB0b2tlbi5pbmNsdWRlcyhcIkBcIilcbiAgICAgID8gYDsgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgbm8gZXBvY2gsIHNvIHBhc3MgdGhlIGlkIHdpdGhvdXQgdGhlIFwiQOKAplwiIHBhcnRgXG4gICAgICA6IFwiXCI7XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIG1lc3NhZ2U6IGAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMg4oCUIGdpdmUgJHtmb3Jtc30ke3doeX1gLFxuICB9O1xufVxuXG4vKiogSm9pbiBhbiBhcmd2IGludG8gb25lIHJ1bm5hYmxlIGNvbW1hbmQgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kTGluZShhcmd2OiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBhcmd2Lm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOW0BlcG9jaF0gWy0tb25jZV1gLlxuICogIFBhc3MgYGVwb2NoYCBvbmx5IGZvciBhIHNwZWxsIHdob3NlIGAtLXNpbmNlYCBwYXJzZXMgaXQgKGBwYXJzZUJvb2ttYXJrYCkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQoXG4gIHByZWZpeDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHNpbmNlOiBudW1iZXIsXG4gIG9uY2U6IGJvb2xlYW4sXG4gIGVwb2NoPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgbWFyayA9IGVwb2NoID8gYCR7c2luY2V9QCR7ZXBvY2h9YCA6IFN0cmluZyhzaW5jZSk7XG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7bWFya31gXSA6IFtcIi0tc2luY2VcIiwgbWFya107XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICAvKiogVGhlIHNwZWxsJ3MgbmFtZSwgY2FycmllZCBvbiB0aGUgbGluZSAod2hvc2UgbGF1bmNoZXIgcnVucyBpdCkuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogQSBwcmVzZW5jZSBzcGVsbDogYWx3YXlzIGB0YWlsLndpbmRvd2AgYXQgdGhlIHdpbmRvdydzIGVuZCwgbmV2ZXIgbG9zdC4gKi9cbiAgcHJlc2VuY2U6IGJvb2xlYW47XG4gIC8qKiBEZWZhdWx0OiBgcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKWAuIGAwYCA9IG5vIHdpbmRvdy4gKi9cbiAgd2luZG93TXM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIGFuIGVtaXR0ZWQgZnJhbWUgaXMgYSBMT0cgZnJhbWUgKEEzKS4gRGVmYXVsdDogZXZlcnkgb25lLiAqL1xuICBjb3VudHM/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBXaGljaCB0ZXJtaW5hbCBmcmFtZSBtZWFucyB0aGUgc2Vzc2lvbiBjbG9zZWQuIERlZmF1bHQ6IGV2ZXJ5IHRlcm1pbmFsLiAqL1xuICBpc0Nsb3NlZD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIGNvbW1hbmRzOiBIYW5kb2ZmQ29tbWFuZHM7XG59O1xuXG4vKipcbiAqIFJ1biBgdGFpbEV2ZW50c2Agd2l0aCB0aGUgaGFuZG9mZjogdGhlIHdpbmRvdywgYC0tb25jZWAsIHRoZSBsb3N0IHJ1bGUsIGFuZFxuICogdGhlIGZpbmFsIGxpbmUuIFJldHVybnMgdGhlIGV4aXQgY29kZSwgbGlrZSBgdGFpbEV2ZW50c2AsIGFuZCBuZXZlciBleGl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxXaXRoSGFuZG9mZjxFdj4oXG4gIHRhaWw6IFRhaWxPcHRpb25zPEV2PixcbiAgaDogSGFuZG9mZk9wdGlvbnM8RXY+LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gdGFpbC5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IHdpbmRvd01zID0gaC53aW5kb3dNcyA/PyByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pO1xuICBjb25zdCBjb3VudHMgPSBoLmNvdW50cyA/PyAoKCkgPT4gdHJ1ZSk7XG4gIGNvbnN0IGVuZE9uTG9zdCA9ICFoLnByZXNlbmNlO1xuXG4gIGNvbnN0IGFjID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gYWMuYWJvcnQoKTtcbiAgdGFpbC5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKHRhaWwuc2lnbmFsPy5hYm9ydGVkKSBhYy5hYm9ydCgpO1xuXG4gIGxldCBldmVudHMgPSAwO1xuICBsZXQgY3Vyc29yID0gdGFpbC5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB0YWlsLnNpbmNlRXBvY2g7XG4gIGxldCBmcmFtZUhhc0lkID0gZmFsc2U7XG4gIC8qKiBBMyArIEQzOiBhIGZyYW1lIGNvdW50cywgYW5kIHdha2VzIGEgYC0tb25jZWAsIG9ubHkgd2hlbiBpdCBpcyBPTiBUSEVcbiAgICogIExPRyDigJQgaXQgY2FycmllcyBhIGxvZyBpZCDigJQgYW5kIHRoZSBzcGVsbCdzIG93biBgY291bnRzYCBhZ3JlZXMuIEEgdGFiJ3NcbiAgICogIGlkLWxlc3MgYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGAgcGluZyBpcyBub3Qgb24gdGhlIGxvZy4gKi9cbiAgY29uc3QgaXNMb2dGcmFtZSA9IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gZnJhbWVIYXNJZCAmJiBjb3VudHMoZXYsIGZyYW1lKTtcbiAgbGV0IGVuZDogVGFpbEVuZCB8IG51bGwgPSBudWxsO1xuICBsZXQgcmVmdXNhbHMgPSAwO1xuXG4gIGNvbnN0IGZpbmlzaCA9IChlOiBUYWlsRW5kKSA9PiB7XG4gICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gZTtcbiAgICBhYy5hYm9ydCgpO1xuICB9O1xuICBjb25zdCB0aW1lciA9XG4gICAgaC5tb2RlID09PSBcIndhdGNoXCIgJiYgd2luZG93TXMgPiAwID8gc2V0VGltZW91dCgoKSA9PiBmaW5pc2goXCJ3aW5kb3dcIiksIHdpbmRvd01zKSA6IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gYXdhaXQgdGFpbEV2ZW50czxFdj4oe1xuICAgICAgLi4udGFpbCxcbiAgICAgIHNpZ25hbDogYWMuc2lnbmFsLFxuICAgICAgLy8gRDIncyBuZXQuIE9uIGZvciBldmVyeSBzcGVsbDogYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yXG4gICAgICAvLyBtZWFucyBhIHdob2xlIHJlcGxheSBvbiB0aGUga2l0J3MgbG9nLCBhbmQgb24gZ3JhcGV2aW5lJ3MgZHVyYWJsZSBsb2dcbiAgICAgIC8vIGl0IGhhcHBlbnMgb25seSB3aGVuIGAtLWxhc3RgIHJlYWNoZXMgYmVsb3cgYC0tc2luY2VgLCB3aGVyZVxuICAgICAgLy8gcmUtcmVhZGluZyB0aGUgY3Vyc29yIGZyb20gdGhlIGZyYW1lcyBpcyB0aGUgbW9yZSBjb3JyZWN0IGFuc3dlci5cbiAgICAgIHJlc3RhcnRPblJlcGxheTogdHJ1ZSxcbiAgICAgIC8vIEQzOiByZW1lbWJlciB3aGV0aGVyIFRISVMgZnJhbWUgY2FycmllcyBhIGxvZyBpZC4gYHRhaWxFdmVudHNgIHJlYWRzXG4gICAgICAvLyB0aGUgY3Vyc29yIG9uY2UgcGVyIGZyYW1lLCBiZWZvcmUgYGFjY2VwdGAsIGB0ZXJtaW5hbGAgYW5kIGByZW5kZXJgLlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4ge1xuICAgICAgICBjb25zdCBuID0gdGFpbC5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgZnJhbWVIYXNJZCA9IHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKTtcbiAgICAgICAgcmV0dXJuIG47XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAocykgPT4ge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gdGFpbC5vblVucmVzb2x2ZWQ/LihzKSA/PyBcInJldHJ5XCI7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgdGhhdCBnaXZlcyB1cCBvbiBmaW5kaW5nIGl0cyBzZXNzaW9uIGlzIHdhdGNoaW5nIGFcbiAgICAgICAgLy8gc2Vzc2lvbiB0aGF0IGlzIGdvbmUg4oCUIHdoZXRoZXIgdGhpcyBwcm9jZXNzIGV2ZXIgcmVhY2hlZCBpdCAoaXRzXG4gICAgICAgIC8vIHBvaW50ZXIgdmFuaXNoZWQpIG9yIGl0IHdhcyByZS1hcm1lZCBhdCBvbmUgdGhhdCBjbG9zZWQgaW4gdGhlIGdhcC5cbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiICYmIGVuZCA9PT0gbnVsbCkgZW5kID0gXCJjbG9zZWRcIjtcbiAgICAgICAgcmV0dXJuIHZlcmRpY3Q7XG4gICAgICB9LFxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwucmVuZGVyID8gdGFpbC5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgIGlmIChsaW5lICE9PSBudWxsICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkgZXZlbnRzICs9IDE7XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIHRlcm1pbmFsOiAoZXYsIGZyYW1lLCBhY2NlcHRlZCkgPT4ge1xuICAgICAgICBpZiAodGFpbC50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gKGguaXNDbG9zZWQgPz8gKCgpID0+IHRydWUpKShldikgPyBcImNsb3NlZFwiIDogXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIGVwb2NoID0gcy5lcG9jaCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSksXG4gICAgICAgIHByZXNlbmNlOiBoLnByZXNlbmNlLFxuICAgICAgICBzcGVsbDogaC5zcGVsbCxcbiAgICAgIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7QUFnREE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVVBO0FBQ0E7OztBQ0NBOzs7QUN0Q08sU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBOzs7QUM2QjNDLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBYVosU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8s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
