#!/usr/bin/env bun
// @bun

// src/mind-mapper/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
function getCurrentCommand() {
  return currentCommand;
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
  const warnDemoted = (row, accepted, tokens) => {
    const end = tokens?.findIndex((t) => t.kind === "option-terminator") ?? -1;
    if (tokens === undefined || end < 0)
      return;
    const demoted = [];
    for (const t of tokens.slice(end + 1)) {
      if (t.kind !== "positional")
        continue;
      const v = t.value;
      let key;
      if (v.startsWith("--"))
        key = v.slice(2).split("=")[0];
      else if (v.length === 2 && v.startsWith("-"))
        key = shortToKey.get(v.slice(1));
      if (key !== undefined && key !== "" && accepted.has(key))
        demoted.push(v);
    }
    if (demoted.length === 0)
      return;
    const which = demoted.join(", ");
    const one = demoted.length === 1;
    const it = one ? "it" : "them";
    const was = one ? "was" : "were";
    const asFlag = one ? "as a flag" : "as flags";
    process.stderr.write(`# warning: ${cliName}${row.name === "" ? "" : ` ${row.name}`}: ${which} after \`--\` ${was} read as text, not ${asFlag}; to use ${it} ${asFlag}, move ${it} before \`--\`
`);
  };
  const runRow = async (row, token, args) => {
    setCurrentCommand(row.name === "" ? null : row.name);
    const name = label(row);
    const accepted = new Set(row.accepted);
    const choices = row.name === "" ? rootChoices : flagsFor(row.name);
    const flagHint = () => [row.rejectHint, choices.length === 0 ? `${name} takes no flags` : undefined].filter((s) => s !== undefined).join("; ") || undefined;
    let values;
    let positionals;
    let tokens;
    try {
      ({ values, positionals, tokens } = parseArgs({
        args,
        options: parseOptions,
        strict: true,
        allowPositionals: row.allowPositionals,
        tokens: true
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
    warnDemoted(row, accepted, tokens);
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
var COME_BACK = (why, lead = "To bring it back") => `${why} ${lead}, run ${RUN_WITH_LAUNCHER}; then arm the tail again with no --since, on the session id it prints where there is one (a restarted daemon starts a new event log, so the old bookmark does not apply)`;
function handoff(s, cmd) {
  const base = { spell: s.spell, events: s.events, cursor: s.cursor };
  switch (s.end) {
    case "stopped":
      return null;
    case "closed":
      return {
        type: "tail.closed",
        ...base,
        ...s.by ? { by: s.by } : {},
        next: "stop",
        command: cmd.comeBack(),
        hint: s.by === "human" ? COME_BACK("the human ended this session on purpose; stop watching, and do not reopen it unless they ask.", "If they ask") : COME_BACK("the session closed; there is nothing left to watch.")
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
  let closedBy;
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
        if (verdict === "stop" && end === null) {
          end = "closed";
          closedBy = h.goneBy?.();
        }
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
          if (end === null) {
            end = (h.isClosed ?? (() => true))(ev) ? "closed" : "event";
            if (end === "closed")
              closedBy = h.closedBy?.(ev);
          }
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
      ...closedBy ? { by: closedBy } : {},
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

// src/mind-mapper/backend/heartbeat.ts
function intOr2(raw, fallback) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.MIND_MAPPER_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var DEFAULT_SSE_HEARTBEAT_MS = DEFAULT_HEARTBEAT_MS;
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.MIND_MAPPER_KEEPALIVE_MS, IDLE_TIMEOUT_SEC, DEFAULT_SSE_HEARTBEAT_MS);
var TAIL_IDLE_MS = intOr2(process.env.MIND_MAPPER_TAIL_IDLE_MS, tailIdleMs(SSE_HEARTBEAT_MS));
var TAIL_RETRY_MS = intOr2(process.env.MIND_MAPPER_TAIL_RETRY_MS, 1000);
var TAIL_RETRY_MAX_MS = 5000;

// src/mind-mapper/backend/cli.ts
var SCRIPT_DIR = import.meta.dir;
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "mind-mapper");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var HOME = process.env.MIND_MAPPER_HOME ?? join(homedir(), ".mind-mapper");
var PORT_FILE = join(HOME, "daemon.port");
var PID_FILE = join(HOME, "daemon.pid");
function livePort() {
  if (!existsSync(PORT_FILE) || !existsSync(PID_FILE))
    return null;
  const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  const port = Number.parseInt(readFileSync(PORT_FILE, "utf8").trim(), 10);
  if (!Number.isFinite(pid) || !Number.isFinite(port))
    return null;
  try {
    process.kill(pid, 0);
    return port;
  } catch {
    return null;
  }
}
async function ensureDaemon(port) {
  const running = livePort();
  if (running !== null)
    return running;
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open", ...port ? ["--port", String(port)] : []], {
    detached: true,
    stdio: "ignore",
    cwd: daemonCwd()
  });
  proc.unref();
  for (let i = 0;i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const port2 = livePort();
    if (port2 !== null)
      return port2;
  }
  throw new CliError2("internal", "daemon did not come up within 10s");
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

class CliError2 extends CliError {
  constructor(kind, message, extra) {
    super(kind, message, extra);
  }
}
var usageError = (message, extra) => new CliError2("usage", message, extra);
function reportUsage(message, extra) {
  process.stderr.write(errorEnvelope("usage", message, extra));
  return EXIT_FOR.usage;
}
async function passOrThrow(res) {
  const text = await res.text();
  if (res.ok)
    return text;
  let server = text;
  try {
    server = JSON.parse(text);
  } catch {}
  const kind = res.status === 404 ? "not_found" : res.status === 409 ? "conflict" : res.status === 400 ? "usage" : "internal";
  throw new CliError2(kind, `${getCurrentCommand() ?? "request"} refused (HTTP ${res.status})`, {
    server
  });
}
function requireDaemon() {
  const port = livePort();
  if (port === null) {
    throw new CliError2("not_found", "no daemon running (use `open` first)");
  }
  return port;
}
function toSkeleton(state) {
  const degree = new Map;
  for (const e of state.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  return {
    nodes: state.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      tier: n.tier,
      degree: degree.get(n.id) ?? 0
    }))
  };
}
var CLI_OPTIONS = {
  add: { type: "string" },
  anchor: { type: "string" },
  author: { type: "string" },
  batch: { type: "string" },
  "body-file": { type: "string" },
  check: { type: "string" },
  clear: { type: "boolean" },
  create: { type: "string" },
  deliverable: { type: "string" },
  depth: { type: "string" },
  detail: { type: "string" },
  doc: { type: "string" },
  "doc-edit": { type: "string" },
  file: { type: "string" },
  force: { type: "boolean" },
  ground: { type: "string", multiple: true },
  inbound: { type: "boolean" },
  kind: { type: "string" },
  message: { type: "string" },
  "no-open": { type: "boolean" },
  node: { type: "string" },
  note: { type: "string" },
  once: { type: "boolean" },
  owner: { type: "string" },
  port: { type: "string" },
  project: { type: "string" },
  role: { type: "string" },
  ruling: { type: "string" },
  set: { type: "string" },
  since: { type: "string" },
  skeleton: { type: "boolean" },
  span: { type: "string" },
  status: { type: "string" },
  stdin: { type: "boolean" },
  synopsis: { type: "string" },
  title: { type: "string" },
  to: { type: "string" },
  uncheck: { type: "string" },
  yes: { type: "boolean" },
  zone: { type: "string" }
};
var on = (h) => (inv) => h({ values: inv.flags, positionals: inv.pos });
var ACTIVITY_STATES = ["received", "thinking", "idle"];
var HELP = `mind-mapper \u2014 a co-present knowledge map: a dumb daemon holds the graph, the casting agent does the thinking.

  open   [--project <id>] [--port <n>] [--no-open]   spawn (or find) the daemon, print its url
  state  [--skeleton] [--batch <id>]                 the project snapshot (skeleton = ids/titles/degree)
  changes --since <epochSeconds>                     bounded delta, ADDITIONS ONLY (notCovered names the rest)
  tail   [--since N] [--inbound] [--once]            SSE events as JSONL (wrap with Monitor; see below)
  projects [--create <title>]                        list projects / create one
  ingest --title <t> (--file <p> | --stdin)          add a doc
  propose-node --stdin                               stage a node proposal (JSON {draft, evidence, ...})
  propose-edge --stdin [--zone <id>]                 stage an edge proposal
  propose-batch --stdin                              stage a set in one txn ({nodes, edges})
  ratify-batch --stdin                               ratify a set in one txn ({ruling, ids, anchors?})
  delete-batch --stdin                               delete a proposal set in one txn ({ids}, all-or-nothing)
  ratify <id> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <t>] [--anchor <parentId>]
  zone   create <name> | list | delete <id> [--yes]  staging pens for proposals
  promote <id>                                       move a zoned proposal to the main queue
  proposal zone <id> (--to <z> | --clear) | proposal delete <id>
  node   anchor <id> (--to <p> | --clear) | edit <id> [--title/--synopsis/--stdin] | delete <id> [--force]
  doc    <id> | delete <id> [--force] | kind <docId> (<kind> [--author a] | --clear)
         flags may precede the sub-verb (doc --project P delete <id>); doc -- <id> reads a doc named "delete" or "kind"
  mark   <docId> --status <s> [--note <t>]           append a doc status mark
  actions <targetId> (--set <json> | --stdin | --clear)   action slots on a node/pending proposal
  tags   <targetId> (--set <json> | --stdin | --clear)    freeform tags, same targets
  job    create|update|claim|release|subtask|list|delete  persisted units of agent work
  search <query...>                                  FTS over nodes, docs, messages
  neighbors <id> [--depth 1]                         local hood + edge reasons
  lens   set (--node <id> [--depth n] | --doc <id>) | lens clear
  look-here <nodeId>                                 fire-once attention nudge
  read   <messageId>                                 one full message row (alias: message <id>)
  send   <text...> | --body-file <p> | --stdin       post a message ([--role] [--kind] [--ground])
  activity <received|thinking|idle> [--message <id>] the casting-loop liveness signal
  version                                            {name, version} as JSON (alias: --version, -V)
  schema                                             the machine-readable interface (acc declaration v0)
  help                                               this message (alias: --help, -h)

  --project <id> goes after the verb; every verb that reads a map accepts it (projects, help,
  version and schema do not). Omit it for the default project. Each verb accepts only the flags on its line: a flag on the wrong verb is
  refused, and the rejection lists that verb's own flags.

  Output: every verb prints JSON on stdout by default, one document per answer \u2014
  except tail, a stream that prints one JSON line per event, and help, which is
  prose. Prose, warnings and
  diagnostics go to stderr; failures exit non-zero (2 = usage).

  Keep watching past Monitor's 30-minute cap. Arm the tail with Monitor at
  timeout_ms: 1800000. It ends itself just before the cap, and its last line
  (type: "tail.\u2026") names your next act. That line's command is the verb and its
  arguments only, bookmark (--since) included, with no launcher and no path.
  Always run it with this skill's own launcher, the one you use for its other
  verbs: bun <this skill's directory>/scripts/cli.ts <command>. A command of
  tail --since 12 runs as bun <this skill's directory>/scripts/cli.ts tail --since 12.
  Never reuse a launcher path from an earlier line or session: the plugin's
  directory changes when it updates. Do what next says:

  - monitor: arm Monitor again with the launcher and command.
  - background: nothing happened; the human is away. Run the launcher and
    command as a background Bash task (run_in_background). It exits on the
    next event, which wakes you. Handle the event, then follow its line back to
    Monitor.
  - stop: the session closed or its daemon is gone. Do not re-arm; the launcher
    and command bring it back. If you run it, arm the tail again with no
    --since (and the session id it prints, where there is one): a restarted
    daemon starts a new event log.

  If Monitor expires before that line arrives, re-arm silently with
  --since <the last id you saw>, written <id>@<its epoch> when events carry an
  epoch. Never re-arm without --since: that replays events you have already
  handled. If the launcher refuses a command with a usage error, its message
  names the forms it accepts; fix the arguments to match.
  tail ${WINDOW_HELP}.`;
function versionInfo() {
  try {
    const raw = readFileSync(join(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "mind-mapper", version: pkg.version };
  } catch {}
  return { name: "mind-mapper", version: "unknown" };
}
async function cmdOpen(parsed) {
  const port = await ensureDaemon(parsed.values.port);
  const project = parsed.values.project;
  if (project !== undefined) {
    const res = await fetch(`http://127.0.0.1:${port}/projects`);
    const body = await res.json();
    if (!body.projects.some((p) => p.id === project)) {
      throw usageError(`unknown project: ${project} (open never creates one \u2014 use \`projects --create <title>\` first)`, { choices: body.projects.map((p) => p.id) });
    }
  }
  const url = `http://127.0.0.1:${port}${project ? `/?project=${encodeURIComponent(project)}` : ""}`;
  if (!parsed.values["no-open"])
    openBrowser(url);
  process.stdout.write(`${JSON.stringify({ ok: true, url })}
`);
  return 0;
}
async function cmdState(parsed) {
  const port = requireDaemon();
  const params = new URLSearchParams;
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  if (parsed.values.batch)
    params.set("batch", parsed.values.batch);
  const qs = params.size > 0 ? `?${params}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/state${qs}`);
  const stateText = await passOrThrow(res);
  if (parsed.values.skeleton) {
    const state = JSON.parse(stateText);
    process.stdout.write(`${JSON.stringify(toSkeleton(state))}
`);
  } else {
    process.stdout.write(`${stateText}
`);
  }
  return 0;
}
async function cmdChanges(parsed) {
  if (parsed.values.since === undefined) {
    throw usageError("changes requires --since <epochSeconds> (use 0 for everything, then pass back the `now` from the previous response)", {
      hint: "ADDITIONS ONLY \u2014 the response's notCovered names what it cannot see; a full `state` read is still the only way to reconcile deletions, rejections and in-place edits"
    });
  }
  const port = requireDaemon();
  const params = new URLSearchParams({ since: parsed.values.since });
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  const res = await fetch(`http://127.0.0.1:${port}/changes?${params}`);
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdTail(parsed) {
  const inbound = parsed.values.inbound === true;
  const once = parsed.values.once === true;
  const read = typeof parsed.values.since === "string" ? readSince(parsed.values.since, { epoch: true }) : null;
  if (read !== null && !read.ok)
    throw usageError(read.message);
  const mark = read?.ok ? read : null;
  const since = mark?.since ?? Number.NaN;
  requireDaemon();
  const sinceGiven = parsed.values.since !== undefined;
  let grounded = sinceGiven;
  let lastUrl = null;
  return await tailWithHandoff({
    resolve: () => {
      const port = livePort();
      if (port !== null)
        lastUrl = `http://127.0.0.1:${port}`;
      return lastUrl;
    },
    path: "/events",
    since: Number.isFinite(since) ? since : 0,
    ...mark?.epoch ? { sinceEpoch: mark.epoch } : {},
    query: (cursor) => ({
      since: String(cursor),
      ...parsed.values.project ? { project: parsed.values.project } : {},
      ...inbound ? { inbound: "1" } : {}
    }),
    cursorOf: (ev) => typeof ev.id === "number" ? ev.id : undefined,
    epochOf: (ev) => typeof ev.epoch === "string" ? ev.epoch : undefined,
    onEpochChange: (epoch) => JSON.stringify({ kind: "epoch.changed", epoch }),
    render: (ev, frame) => {
      if (ev.kind === "grounding") {
        if (grounded)
          return null;
        grounded = true;
      }
      return frame.data;
    },
    onHttpError: async (res) => {
      if (res.status === 409 || res.status === 404)
        await passOrThrow(res);
      return "retry";
    },
    onMalformed: (frame) => {
      process.stdout.write(`${frame.data}
`);
      return null;
    },
    idleMs: TAIL_IDLE_MS,
    retry: { initialMs: TAIL_RETRY_MS, maxMs: TAIL_RETRY_MAX_MS }
  }, {
    spell: "mind-mapper",
    mode: once ? "once" : "watch",
    presence: false,
    counts: (ev) => ev.kind !== "presence.changed",
    commands: {
      tail: ({ since: at, once: nextOnce, epoch }) => tailCommand([
        "tail",
        ...inbound ? ["--inbound"] : [],
        ...parsed.values.project ? ["--project", parsed.values.project] : []
      ], at, nextOnce, epoch),
      comeBack: () => commandLine(["open", "--no-open"])
    }
  });
}
async function cmdProjects(parsed) {
  const port = requireDaemon();
  if (parsed.values.create) {
    const title = parsed.values.create;
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const res2 = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: "POST",
      body: JSON.stringify({ id, title })
    });
    process.stdout.write(`${await passOrThrow(res2)}
`);
    return 0;
  }
  const res = await fetch(`http://127.0.0.1:${port}/projects`);
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdIngest(parsed) {
  if (!parsed.values.title) {
    throw usageError("ingest requires --title");
  }
  if (!parsed.values.file && !parsed.values.stdin) {
    throw usageError("ingest requires --file <path> or --stdin");
  }
  const text = parsed.values.file ? readFileSync(parsed.values.file, "utf8") : await Bun.stdin.text();
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/ingest${qs}`, {
    method: "POST",
    body: JSON.stringify({ title: parsed.values.title, text })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdPropose(verb, parsed) {
  if (!parsed.values.stdin) {
    throw usageError(`${verb} requires --stdin JSON {draft, evidence[, suggestedTier, author, tags, batchId]}`, {
      hint: 'propose-edge endpoints: a node id, a pending node-proposal id, or "title:<exact node title>" ' + "(title refs resolve at INTAKE against ratified nodes only, exact + case-sensitive; " + "an ambiguous title errors and names every candidate id)"
    });
  }
  const input = JSON.parse(await Bun.stdin.text());
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/proposals${qs}`, {
    method: "POST",
    body: JSON.stringify({
      kind: verb === "propose-node" ? "node" : "edge",
      draft: input.draft,
      evidence: input.evidence ?? {},
      suggestedTier: input.suggestedTier,
      author: input.author,
      zone: parsed.values.zone,
      tags: input.tags,
      batchId: input.batchId
    })
  });
  const responseText = await passOrThrow(res);
  process.stdout.write(`${responseText}
`);
  if (verb === "propose-edge") {
    try {
      const { warning } = JSON.parse(responseText);
      if (typeof warning === "string")
        process.stderr.write(`# warning: ${warning}
`);
    } catch {}
  }
  return 0;
}
async function cmdProposeBatch(parsed) {
  if (!parsed.values.stdin) {
    throw usageError("propose-batch requires --stdin JSON {nodes:[{ref, draft, suggestedTier?, evidence?}], edges:[{draft:{source, target, label?}}]}", {
      hint: "an edge endpoint may be a node LOCAL REF (matches a node's ref in this batch), " + 'a real node id, a pending proposal id, or "title:<exact node title>" \u2014 local refs ' + "resolve to minted ids and title refs to ratified node ids, both server-side; " + "optional batchId: omit and one is MINTED + returned; supply one to extend that act"
    });
  }
  const input = JSON.parse(await Bun.stdin.text());
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/proposals/batch${qs}`, {
    method: "POST",
    body: JSON.stringify({
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
      batchId: input.batchId
    })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdRatifyBatch(parsed) {
  if (!parsed.values.stdin) {
    throw usageError('ratify-batch requires --stdin JSON {ruling: "canon|thread|story-local", ids: [proposalId], anchors?: [{node, parent}]}', {
      hint: "ratifies the set in ONE call/txn; nodes ratify before edges (auto-partitioned), " + "edge endpoints + anchor refs resolve old proposal ids \u2192 minted node ids via the " + "returned idMap. NO auto-include of unlisted edges; reject is not a batch act"
    });
  }
  const input = JSON.parse(await Bun.stdin.text());
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/proposals/ratify-batch${qs}`, {
    method: "POST",
    body: JSON.stringify({
      ruling: input.ruling,
      ids: input.ids ?? [],
      anchors: input.anchors
    })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdDeleteBatch(parsed) {
  if (!parsed.values.stdin) {
    throw usageError('delete-batch requires --stdin JSON {ids: ["<proposalId>", ...]}', {
      hint: "deletes the set in ONE txn \u2014 all-or-nothing: if any id is unknown, NOTHING is " + "deleted and the error names every unknown id. There is deliberately no " + "{batch: <id>} shorthand \u2014 run `state --batch <id>` and look before you sweep " + "(drive #10's bug was an over-broad cleanup that took the edges with it)"
    });
  }
  const input = JSON.parse(await Bun.stdin.text());
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/proposals/delete-batch${qs}`, {
    method: "POST",
    body: JSON.stringify({ ids: input.ids ?? [] })
  });
  const deleteBatchBody = await passOrThrow(res);
  process.stdout.write(`${deleteBatchBody}
`);
  try {
    const { warning } = JSON.parse(deleteBatchBody);
    if (typeof warning === "string")
      process.stderr.write(`# warning: ${warning}
`);
  } catch {}
  return 0;
}
var projectQs = (parsed) => parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
async function cmdNodeDelete(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const params = new URLSearchParams;
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  if (parsed.values.force)
    params.set("force", "1");
  const dqs = params.size > 0 ? `?${params}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}${dqs}`, { method: "DELETE" });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdNodeEdit(parsed) {
  const id = parsed.positionals[0];
  const patch = {};
  if (parsed.values.stdin) {
    Object.assign(patch, JSON.parse(await Bun.stdin.text()));
  }
  if (parsed.values.title !== undefined)
    patch.title = parsed.values.title;
  if (parsed.values.synopsis !== undefined)
    patch.synopsis = parsed.values.synopsis;
  if (patch.title === undefined && patch.synopsis === undefined) {
    throw usageError(`usage: cli.ts node edit <nodeId> (--title <t> | --synopsis <s> | --stdin '{"synopsis": "..."}')`, {
      hint: "writes exactly what it is given (no inference); only title/synopsis are editable \u2014 " + "tier is the human's ruling and kind is a ratification-time classification"
    });
  }
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({
      ...patch.title !== undefined ? { title: patch.title } : {},
      ...patch.synopsis !== undefined ? { synopsis: patch.synopsis } : {}
    })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
var toXorClear = (inv) => {
  const hasTo = inv.flags.to !== undefined;
  const clear = inv.flags.clear === true;
  if (hasTo && clear)
    return "give --to <id> or --clear, not both";
  if (!hasTo && !clear)
    return "give --to <id> or --clear";
  return;
};
async function cmdNodeAnchor(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/nodes/${id}/anchor${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({ parentId: parsed.values.clear ? null : parsed.values.to })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdRead(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/message/${id}${projectQs(parsed)}`);
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdZoneCreate(parsed) {
  const name = parsed.positionals.join(" ");
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/zones${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({ name })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdZoneList(parsed) {
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/zones${projectQs(parsed)}`);
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdZoneDelete(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const params = new URLSearchParams;
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  if (parsed.values.yes)
    params.set("yes", "1");
  const dqs = params.size > 0 ? `?${params}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/zones/${id}${dqs}`, { method: "DELETE" });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdPromote(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/promote${projectQs(parsed)}`, {
    method: "POST"
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdProposalZone(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}/zone${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({ zoneId: parsed.values.clear ? null : parsed.values.to })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdProposalDelete(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${id}${projectQs(parsed)}`, {
    method: "DELETE"
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdDoc(isDelete, parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const params = new URLSearchParams;
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  if (isDelete && parsed.values.force)
    params.set("force", "1");
  const qs = params.size > 0 ? `?${params}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/doc/${id}${qs}`, {
    method: isDelete ? "DELETE" : "GET"
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdDocKind(parsed) {
  const docId = parsed.positionals[0];
  const kindWords = parsed.positionals.slice(1).join(" ");
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/doc/${docId}/kind${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify(parsed.values.clear ? { kind: null } : { kind: kindWords, author: parsed.values.author ?? "agent" })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdMark(parsed) {
  const docId = parsed.positionals[0];
  if (!docId || !parsed.values.status) {
    throw usageError("usage: cli.ts mark <docId> --status <s> [--note <t>]");
  }
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/doc/${docId}/mark${qs}`, {
    method: "POST",
    body: JSON.stringify({
      author: parsed.values.author ?? "agent",
      note: parsed.values.note,
      status: parsed.values.status
    })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdSearch(parsed) {
  const query = parsed.positionals.join(" ");
  if (!query) {
    throw usageError("usage: cli.ts search <query...>");
  }
  const port = requireDaemon();
  const params = new URLSearchParams({ q: query });
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  const res = await fetch(`http://127.0.0.1:${port}/search?${params}`);
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdNeighbors(parsed) {
  const id = parsed.positionals[0];
  if (!id) {
    throw usageError("usage: cli.ts neighbors <nodeId> [--depth 1]");
  }
  const port = requireDaemon();
  const params = new URLSearchParams({ depth: parsed.values.depth ?? "1" });
  if (parsed.values.project)
    params.set("project", parsed.values.project);
  const res = await fetch(`http://127.0.0.1:${port}/neighbors/${id}?${params}`);
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdRatify(parsed) {
  const proposalId = parsed.positionals[0];
  if (!proposalId || !parsed.values.ruling) {
    throw usageError(`usage: cli.ts ratify <proposalId> --ruling <r> [--doc-edit <file>] [--doc <docId> --span <text>] [--anchor <parentId>]
`);
  }
  if (parsed.values.doc && !parsed.values["doc-edit"]) {
    throw usageError("--doc requires --doc-edit (the drafted doc home)");
  }
  const docEdit = parsed.values["doc-edit"] ? readFileSync(parsed.values["doc-edit"], "utf8") : undefined;
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/proposals/${proposalId}/ruling${qs}`, {
    method: "POST",
    body: JSON.stringify({
      ruling: parsed.values.ruling,
      docEdit,
      docId: parsed.values.doc,
      span: parsed.values.span,
      anchor: parsed.values.anchor
    })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdLensSet(parsed) {
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/lens${projectQs(parsed)}`, {
    method: "POST",
    body: JSON.stringify({
      owner: parsed.values.owner ?? "agent",
      nodeId: parsed.values.node,
      docId: parsed.values.doc,
      depth: parsed.values.depth ? Number.parseInt(parsed.values.depth, 10) : undefined
    })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdLensClear(parsed) {
  const port = requireDaemon();
  const res = await fetch(`http://127.0.0.1:${port}/lens${projectQs(parsed)}`, {
    method: "DELETE"
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdLookHere(parsed) {
  const id = parsed.positionals[0];
  if (!id) {
    throw usageError("usage: cli.ts look-here <nodeId>");
  }
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/look-here/${id}${qs}`, { method: "POST" });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
var exactlyOneMode = (inv) => {
  const modes = [inv.flags.set !== undefined, inv.flags.stdin === true, inv.flags.clear === true];
  return modes.filter(Boolean).length === 1 ? undefined : "give exactly one of --set <json>, --stdin or --clear";
};
async function cmdActions(parsed) {
  const targetId = parsed.positionals[0];
  const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
  if (!targetId || modes.filter(Boolean).length !== 1) {
    throw usageError(`usage: cli.ts actions <targetId> (--set <json> | --stdin | --clear)
` + `  target is a node id or a PENDING proposal id; json is an array of
` + `  {"id", "label", "seed"} \u2014 empty array (or --clear) removes the slots
`);
  }
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const target = `http://127.0.0.1:${port}/actions/${targetId}${qs}`;
  const res = parsed.values.clear ? await fetch(target, { method: "DELETE" }) : await fetch(target, {
    method: "PUT",
    body: parsed.values.stdin ? await Bun.stdin.text() : parsed.values.set
  });
  const responseText = await passOrThrow(res);
  process.stdout.write(`${responseText}
`);
  try {
    const { warning } = JSON.parse(responseText);
    if (typeof warning === "string")
      process.stderr.write(`# warning: ${warning}
`);
  } catch {}
  return 0;
}
async function cmdTags(parsed) {
  const targetId = parsed.positionals[0];
  const modes = [parsed.values.set !== undefined, parsed.values.stdin, parsed.values.clear];
  if (!targetId || modes.filter(Boolean).length !== 1) {
    throw usageError(`usage: cli.ts tags <targetId> (--set <json> | --stdin | --clear)
` + `  target is a node id or a PENDING proposal id; json is an array of
` + `  freeform strings \u2014 empty array (or --clear) removes the tags
`);
  }
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const target = `http://127.0.0.1:${port}/tags/${targetId}${qs}`;
  const res = parsed.values.clear ? await fetch(target, { method: "DELETE" }) : await fetch(target, {
    method: "PUT",
    body: parsed.values.stdin ? await Bun.stdin.text() : parsed.values.set
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
var jobUrl = (port, parsed, suffix = "") => `http://127.0.0.1:${port}/jobs${suffix}${projectQs(parsed)}`;
async function jobBodyFromSource(parsed) {
  if (parsed.values["body-file"] !== undefined) {
    const p = parsed.values["body-file"];
    if (!existsSync(p)) {
      throw usageError(`job: --body-file not found: ${p}`);
    }
    return JSON.parse(readFileSync(p, "utf8"));
  }
  if (parsed.values.stdin)
    return JSON.parse(await Bun.stdin.text());
  return null;
}
async function cmdJobList(parsed) {
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed));
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdJobCreate(parsed) {
  const override = await jobBodyFromSource(parsed);
  const body = override ?? {
    title: parsed.values.title,
    status: parsed.values.status,
    deliverable: parsed.values.deliverable,
    detail: parsed.values.detail
  };
  if (typeof body.title !== "string" || body.title === "") {
    throw usageError(`usage: cli.ts job create --title <t> [--status <s>] [--deliverable <ref>] [--detail <x>]
` + `  or: cli.ts job create (--stdin | --body-file <path>) with JSON {title, status?, deliverable?, detail?}
`);
  }
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed), { method: "POST", body: JSON.stringify(body) });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdJobUpdate(parsed) {
  const id = parsed.positionals[0];
  const override = await jobBodyFromSource(parsed);
  const body = override ?? Object.fromEntries(["title", "status", "deliverable", "detail"].filter((k) => parsed.values[k] !== undefined).map((k) => [k, parsed.values[k]]));
  if (Object.keys(body).length === 0) {
    throw usageError(`usage: cli.ts job update <id> (at least one of --title|--status|--deliverable|--detail)
`);
  }
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}`), {
    method: "POST",
    body: JSON.stringify(body)
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdJobClaim(parsed) {
  const id = parsed.positionals[0];
  if (parsed.values.owner === undefined) {
    throw usageError("usage: cli.ts job claim <id> --owner <who>");
  }
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}/claim`), {
    method: "POST",
    body: JSON.stringify({ owner: parsed.values.owner })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdJobRelease(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}/release`), { method: "POST" });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
var oneSubtaskOp = (inv) => {
  const modes = [inv.flags.add, inv.flags.check, inv.flags.uncheck].filter((v) => v !== undefined);
  return modes.length === 1 ? undefined : "give exactly one of --add <label>, --check <subtaskId> or --uncheck <subtaskId>";
};
async function cmdJobSubtask(parsed) {
  const id = parsed.positionals[0];
  const jobBody = parsed.values.add !== undefined ? { op: "add", label: parsed.values.add } : parsed.values.check !== undefined ? { op: "check", subtaskId: parsed.values.check } : { op: "uncheck", subtaskId: parsed.values.uncheck };
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}/subtask`), {
    method: "POST",
    body: JSON.stringify(jobBody)
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdJobDelete(parsed) {
  const id = parsed.positionals[0];
  const port = requireDaemon();
  const res = await fetch(jobUrl(port, parsed, `/${id}`), { method: "DELETE" });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdActivity(parsed) {
  const state = parsed.positionals[0];
  if (!ACTIVITY_STATES.includes(state)) {
    throw usageError("usage: cli.ts activity <state> [--message <id>]", {
      hint: "state is the first positional",
      choices: [...ACTIVITY_STATES]
    });
  }
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/activity${qs}`, {
    method: "POST",
    body: JSON.stringify({ state, messageId: parsed.values.message })
  });
  process.stdout.write(`${await passOrThrow(res)}
`);
  return 0;
}
async function cmdSend(parsed) {
  const hasInline = parsed.positionals.length > 0;
  let text;
  let fromInline = false;
  if (parsed.values["body-file"] !== undefined) {
    const path = parsed.values["body-file"];
    if (!existsSync(path)) {
      throw usageError(`send: --body-file not found: ${path}`);
    }
    text = readFileSync(path, "utf8").replace(/\n$/, "");
  } else if (parsed.values.stdin || !hasInline && !process.stdin.isTTY) {
    text = (await Bun.stdin.text()).replace(/\n$/, "");
  } else {
    text = parsed.positionals.join(" ");
    fromInline = true;
  }
  if (text === "") {
    throw usageError(`usage: cli.ts send <text...> | --body-file <path> | --stdin
` + `mind-mapper: send resolved an empty body \u2014 nothing sent
`);
  }
  if (!parsed.values.force && /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\bsend\b/.test(text)) {
    throw usageError("mind-mapper: that body looks like a leaked cli invocation (a fumbled heredoc?). " + "Nothing was sent. Pipe the real body via --stdin or --body-file <path>, " + `or pass --force to send it anyway.
`);
  }
  if (fromInline && /`|\$\(|\$\{/.test(text)) {
    process.stderr.write("# warning: inline body contains shell metacharacters (backtick, $(), curly-brace vars). " + "It was sent as-is, but the shell can command-substitute these first \u2014 " + `use --body-file or --stdin for code-bearing messages.
`);
  }
  const port = requireDaemon();
  const qs = parsed.values.project ? `?project=${encodeURIComponent(parsed.values.project)}` : "";
  const res = await fetch(`http://127.0.0.1:${port}/send${qs}`, {
    method: "POST",
    body: JSON.stringify({
      role: parsed.values.role ?? "agent",
      kind: parsed.values.kind ?? "turn",
      text,
      ground: (() => {
        const refs = (parsed.values.ground ?? []).flatMap((g) => g.split(",")).map((g) => g.trim()).filter((g) => g !== "");
        return refs.length > 0 ? refs : undefined;
      })()
    })
  });
  const responseText = await passOrThrow(res);
  process.stdout.write(`${responseText}
`);
  try {
    const { warning } = JSON.parse(responseText);
    if (typeof warning === "string")
      process.stderr.write(`# warning: ${warning}
`);
  } catch {}
  return 0;
}
var one = (name) => [{ name, required: true }];
var words = (name) => [{ name, required: true, variadic: true }];
var NONE = [];
var ROWS = [
  {
    name: "open",
    flags: ["no-open", "port", "project"],
    positionals: NONE,
    describe: "spawn (or find) the daemon, print its url",
    run: on(cmdOpen)
  },
  {
    name: "state",
    flags: ["skeleton", "batch", "project"],
    positionals: NONE,
    describe: "the project snapshot",
    run: on(cmdState)
  },
  {
    name: "changes",
    flags: ["since", "project"],
    positionals: NONE,
    describe: "bounded delta, additions only",
    run: on(cmdChanges)
  },
  {
    name: "tail",
    flags: ["since", "inbound", "once", "project"],
    positionals: NONE,
    describe: "SSE events as JSONL",
    run: on(cmdTail)
  },
  {
    name: "projects",
    flags: ["create"],
    positionals: NONE,
    describe: "list projects / create one",
    run: on(cmdProjects)
  },
  {
    name: "ingest",
    flags: ["title", "file", "stdin", "project"],
    positionals: NONE,
    describe: "add a doc",
    run: on(cmdIngest)
  },
  {
    name: "propose-node",
    flags: ["stdin", "zone", "project"],
    positionals: NONE,
    describe: "stage a node proposal",
    run: on((p) => cmdPropose("propose-node", p))
  },
  {
    name: "propose-edge",
    flags: ["stdin", "zone", "project"],
    positionals: NONE,
    describe: "stage an edge proposal",
    run: on((p) => cmdPropose("propose-edge", p))
  },
  {
    name: "propose-batch",
    flags: ["stdin", "project"],
    positionals: NONE,
    describe: "stage a set in one txn",
    run: on(cmdProposeBatch)
  },
  {
    name: "ratify-batch",
    flags: ["stdin", "project"],
    positionals: NONE,
    describe: "ratify a set in one txn",
    run: on(cmdRatifyBatch)
  },
  {
    name: "delete-batch",
    flags: ["stdin", "project"],
    positionals: NONE,
    describe: "delete a proposal set in one txn",
    run: on(cmdDeleteBatch)
  },
  {
    name: "node anchor",
    flags: ["to", "clear", "project"],
    positionals: one("nodeId"),
    describe: "anchor a node under a parent (--to) or back to top-level (--clear)",
    check: toXorClear,
    run: on(cmdNodeAnchor)
  },
  {
    name: "node edit",
    flags: ["title", "synopsis", "stdin", "project"],
    positionals: one("nodeId"),
    describe: "edit a node's title/synopsis",
    run: on(cmdNodeEdit)
  },
  {
    name: "node delete",
    flags: ["force", "project"],
    positionals: one("nodeId"),
    describe: "delete a node (--force cascades)",
    run: on(cmdNodeDelete)
  },
  {
    name: "read",
    aliases: ["message"],
    flags: ["project"],
    positionals: one("messageId"),
    describe: "one full message row",
    run: on(cmdRead)
  },
  {
    name: "zone create",
    flags: ["project"],
    positionals: words("name"),
    describe: "create a staging zone",
    run: on(cmdZoneCreate)
  },
  {
    name: "zone list",
    flags: ["project"],
    positionals: NONE,
    describe: "list zones",
    run: on(cmdZoneList)
  },
  {
    name: "zone delete",
    flags: ["yes", "project"],
    positionals: one("zoneId"),
    describe: "delete a zone (--yes when populated)",
    run: on(cmdZoneDelete)
  },
  {
    name: "promote",
    flags: ["project"],
    positionals: one("proposalId"),
    describe: "move a zoned proposal to the main queue",
    run: on(cmdPromote)
  },
  {
    name: "proposal zone",
    flags: ["to", "clear", "project"],
    positionals: one("proposalId"),
    describe: "move a pending proposal into a zone (--to) or back to main (--clear)",
    check: toXorClear,
    run: on(cmdProposalZone)
  },
  {
    name: "proposal delete",
    flags: ["project"],
    positionals: one("proposalId"),
    describe: "delete a proposal",
    run: on(cmdProposalDelete)
  },
  {
    name: "doc",
    flags: ["project"],
    positionals: one("docId"),
    describe: "the doc envelope",
    run: on((p) => cmdDoc(false, p))
  },
  {
    name: "doc delete",
    flags: ["force", "project"],
    positionals: one("docId"),
    describe: "delete a doc (--force cascades)",
    run: on((p) => cmdDoc(true, p))
  },
  {
    name: "doc kind",
    flags: ["author", "clear", "project"],
    positionals: [
      { name: "docId", required: true },
      { name: "kind", required: false, variadic: true }
    ],
    describe: "assert (<kind>) or clear (--clear) a doc's kind",
    check: (inv) => {
      const clear = inv.flags.clear === true;
      if (clear && inv.pos.length > 1)
        return "--clear takes no <kind>";
      if (!clear && inv.pos.length < 2)
        return "missing required <kind> (or pass --clear)";
      return;
    },
    run: on(cmdDocKind)
  },
  {
    name: "mark",
    flags: ["status", "note", "author", "project"],
    positionals: one("docId"),
    describe: "append a doc status mark",
    run: on(cmdMark)
  },
  {
    name: "search",
    flags: ["project"],
    positionals: words("query"),
    describe: "FTS over nodes, docs, messages",
    run: on(cmdSearch)
  },
  {
    name: "neighbors",
    flags: ["depth", "project"],
    positionals: one("nodeId"),
    describe: "local hood + edge reasons",
    run: on(cmdNeighbors)
  },
  {
    name: "ratify",
    flags: ["ruling", "doc-edit", "doc", "span", "anchor", "project"],
    positionals: one("proposalId"),
    describe: "rule on a proposal",
    run: on(cmdRatify)
  },
  {
    name: "lens set",
    flags: ["node", "doc", "depth", "owner", "project"],
    positionals: NONE,
    describe: "set the lens on a node (--node) or a doc (--doc)",
    check: (inv) => {
      if (inv.flags.node !== undefined && inv.flags.doc !== undefined) {
        return "lens set takes --node OR --doc, not both";
      }
      if (inv.flags.doc !== undefined && inv.flags.depth !== undefined) {
        return "--depth applies to a node lens only";
      }
      return;
    },
    run: on(cmdLensSet)
  },
  {
    name: "lens clear",
    flags: ["project"],
    positionals: NONE,
    describe: "clear the lens",
    run: on(cmdLensClear)
  },
  {
    name: "look-here",
    flags: ["project"],
    positionals: one("nodeId"),
    describe: "fire-once attention nudge",
    run: on(cmdLookHere)
  },
  {
    name: "actions",
    flags: ["set", "stdin", "clear", "project"],
    positionals: one("targetId"),
    describe: "action slots on a node/pending proposal",
    check: exactlyOneMode,
    run: on(cmdActions)
  },
  {
    name: "tags",
    flags: ["set", "stdin", "clear", "project"],
    positionals: one("targetId"),
    describe: "freeform tags on a node/pending proposal",
    check: exactlyOneMode,
    run: on(cmdTags)
  },
  {
    name: "job create",
    flags: ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
    positionals: NONE,
    describe: "create a job",
    run: on(cmdJobCreate)
  },
  {
    name: "job update",
    flags: ["title", "status", "deliverable", "detail", "stdin", "body-file", "project"],
    positionals: one("jobId"),
    describe: "update a job",
    run: on(cmdJobUpdate)
  },
  {
    name: "job claim",
    flags: ["owner", "project"],
    positionals: one("jobId"),
    describe: "claim a job (atomic lease)",
    run: on(cmdJobClaim)
  },
  {
    name: "job release",
    flags: ["project"],
    positionals: one("jobId"),
    describe: "release a job",
    run: on(cmdJobRelease)
  },
  {
    name: "job subtask",
    flags: ["add", "check", "uncheck", "project"],
    positionals: one("jobId"),
    describe: "add, check or uncheck a job's sub-task",
    check: oneSubtaskOp,
    run: on(cmdJobSubtask)
  },
  {
    name: "job list",
    flags: ["project"],
    positionals: NONE,
    describe: "list jobs",
    run: on(cmdJobList)
  },
  {
    name: "job delete",
    flags: ["project"],
    positionals: one("jobId"),
    describe: "delete a job",
    run: on(cmdJobDelete)
  },
  {
    name: "activity",
    flags: ["message", "project"],
    positionals: one("state"),
    describe: "the casting-loop liveness signal (received|thinking|idle)",
    run: on(cmdActivity)
  },
  {
    name: "send",
    flags: ["role", "kind", "ground", "body-file", "stdin", "force", "project"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "post a message",
    run: on(cmdSend)
  }
];
var cli = defineCli({
  name: "mind-mapper",
  options: CLI_OPTIONS,
  commands: ROWS,
  grammar: "verb-first",
  groups: { doc: { subVerbAt: "first-positional" } },
  version: versionInfo,
  help: () => HELP
});
var VERBS = cli.verbs;
var VERB_SPEC = Object.fromEntries(cli.rows.map((r) => [r.name, r.accepted]));
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
    if (e instanceof SyntaxError)
      return reportUsage(`invalid JSON: ${msg}`);
    if (code === "ENOENT")
      return reportUsage(msg);
    process.stderr.write(errorEnvelope("internal", msg));
    return EXIT_FOR.internal;
  }
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  ACTIVITY_STATES,
  RECOGNIZED_FLAGS,
  VERBS,
  VERB_SPEC,
  cli,
  run
};

//# debugId=36A88C37A0C555C864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2hlYXJ0YmVhdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gbWluZC1tYXBwZXIg4oCUIHRoZSBmdWxsIHZlcmIgc2V0IChWMSArIFYxLnggKyBSb3VuZCAzKTpcbi8vICAgb3BlbiAgICAgICAgICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybCwgb3BlbiB0aGUgYnJvd3NlclxuLy8gICAgICAgICAgICAgICAgIC0tcHJvamVjdCA8aWQ+IHNjb3BlcyB0aGUgdXJsICg/cHJvamVjdD0pOyBvcGVuIG5ldmVyIG1pbnRzIOKAlFxuLy8gICAgICAgICAgICAgICAgIGFuIHVua25vd24gaWQgZXJyb3JzICh1c2UgcHJvamVjdHMgLS1jcmVhdGUgZmlyc3QpXG4vLyAgICAgICAgICAgICAgICAgLS1wb3J0IDxuPiBiaW5kcyBhIFNUQUJMRSBwb3J0IHNvIGEgYnJvd3NlciByZWZyZXNoIHJlY29ubmVjdHNcbi8vICAgICAgICAgICAgICAgICBhY3Jvc3MgYW4gZW52aXJvbm1lbnQtcmVhcCArIHJlc3RhcnQuIFR3byB3cmlua2xlczogKDEpIGFnYWluc3Rcbi8vICAgICAgICAgICAgICAgICBhIExJVkUgZGFlbW9uIC0tcG9ydCBOIGlzIElHTk9SRUQgKG9wZW4gcmV0dXJucyB0aGUgZXhpc3Rpbmdcbi8vICAgICAgICAgICAgICAgICBkYWVtb24pIOKAlCB0aGUgc3RhYmxlIHVybCBob2xkcyBvbmx5IGlmIHRoZSBGSVJTVCBvcGVuIHNldCBpdDtcbi8vICAgICAgICAgICAgICAgICAoMikgaWYgcG9ydCBOIGlzIGFscmVhZHkgaW4gdXNlIHRoZSBkYWVtb24gZXhpdHMgYW5kIHRoaXMgcG9sbFxuLy8gICAgICAgICAgICAgICAgIHRpbWVzIG91dCAoXCJkYWVtb24gZGlkIG5vdCBjb21lIHVwXCIpIOKAlCBwaWNrIGEgZnJlZSBwb3J0LlxuLy8gICBzdGF0ZSAgICAgICAgIEdFVCAvc3RhdGUg4oaSIHRoZSByZWFsIHByb2plY3Qgc25hcHNob3Qgb24gc3Rkb3V0XG4vLyAgICAgICAgICAgICAgICAgLS1za2VsZXRvbiByZXR1cm5zIGlkcy90aXRsZXMvZGVncmVlIG9ubHkgKGNvbnRleHQgYnVkZ2V0aW5nKVxuLy8gICAgICAgICAgICAgICAgIGZyZXNoIHN0b3JlIHdpdGggbm8gcHJvamVjdCDihpIgdGhlIG5lZWRzLXByb2plY3QgNDA5IHJpZGVzXG4vLyAgICAgICAgICAgICAgICAgdGhlIGVycm9yIGVudmVsb3BlIChjb25mbGljdCwgZXhpdCA2OyBib2R5IHVuZGVyIGVycm9yLnNlcnZlcilcbi8vICAgdGFpbCAgICAgICAgICBNb25pdG9yLXNoYXBlZDogR0VUIC9ldmVudHM/c2luY2U9PGN1cnNvcj4gU1NFIOKGkiBvbmUgSlNPTlxuLy8gICAgICAgICAgICAgICAgIGxpbmUgcGVyIGV2ZW50IG9uIHN0ZG91dFxuLy8gICAgICAgICAgICAgICAgIC0taW5ib3VuZCBmaWx0ZXJzIHNlcnZlci1zaWRlIHRvIGh1bWFuLW9yaWdpbmF0ZWQgZXZlbnRzXG4vLyAgICAgICAgICAgICAgICAgKGNoYXQgKyBkcm9wcGVkIG5vZGVzKSArIG9wZW5zIHdpdGggYSBraW5kOlwiZ3JvdW5kaW5nXCIgbGluZVxuLy8gICAgICAgICAgICAgICAgIC0tb25jZSBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCwgcHJpbnRzIGl0LCBleGl0c1xuLy8gICAgICAgICAgICAgICAgICh0aGUgcXVpZXQgaGFuZG9mZidzIGJhY2tncm91bmQgb25lLXNob3QpXG4vLyAgIHByb2plY3RzICAgICAgbGlzdCBzYXZlZCBwcm9qZWN0czsgLS1jcmVhdGUgPHRpdGxlPiBtYWtlcyBhIG5ldyBvbmVcbi8vICAgaW5nZXN0ICAgICAgICAtLXRpdGxlIFQgKC0tZmlsZSBQIHwgLS1zdGRpbikg4oaSIFBPU1QgL2luZ2VzdFxuLy8gICBwcm9wb3NlLW5vZGUgIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlLCBzdWdnZXN0ZWRUaWVyP30g4oaSIFBPU1QgL3Byb3Bvc2Fsc1xuLy8gICBwcm9wb3NlLWVkZ2UgIHNhbWUgc2hhcGUsIGtpbmQ6IFwiZWRnZVwiIChzb3VyY2UvdGFyZ2V0IG1heSBiZSBhIHJlYWwgbm9kZVxuLy8gICAgICAgICAgICAgICAgIGlkIE9SIGEgcGVuZGluZyBwcm9wb3NhbCdzIGlkIOKAlCByYXRpZnkgcmVzb2x2ZXMgdGhlIGxhdHRlcilcbi8vICAgICAgICAgICAgICAgICAtLXpvbmUgPGlkPiBzdGFnZXMgdGhlIHByb3Bvc2FsIGluIGEgem9uZVxuLy8gICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCAuLi59XSwgZWRnZXM6W3tkcmFmdDp7XG4vLyAgICAgICAgICAgICAgICAgc291cmNlLCB0YXJnZXQsIGxhYmVsP319XX0g4oCUIG9uZSB0cmFuc2FjdGlvbjsgYW4gZWRnZVxuLy8gICAgICAgICAgICAgICAgIGVuZHBvaW50IG1heSBiZSBhIG5vZGUncyBMT0NBTCBSRUYgKHJlc29sdmVkIHRvIHRoZSBtaW50ZWRcbi8vICAgICAgICAgICAgICAgICBpZCBzZXJ2ZXItc2lkZSksIGEgcmVhbCBub2RlIGlkLCBvciBhIHBlbmRpbmcgcHJvcG9zYWwgaWQuXG4vLyAgICAgICAgICAgICAgICAgUmV0dXJucyB7cmVmVG9JZCwgcHJvcG9zYWxzfVxuLy8gICByZWFkIDxpZD4gICAgIEdFVCAvbWVzc2FnZS86aWQg4oaSIHRoZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuLy8gICBub2RlIGFuY2hvciA8aWQ+ICgtLXRvIDxwYXJlbnRJZD4gfCAtLWNsZWFyKSAgUE9TVCAvbm9kZXMvOmlkL2FuY2hvciDigJRcbi8vICAgICAgICAgICAgICAgICBhbmNob3IgYSByZWFsIG5vZGUgdW5kZXIgYSBwYXJlbnQgaW4gdGhlIHN1Ym1hcCB0cmVlLCBvclxuLy8gICAgICAgICAgICAgICAgIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIHRvcC1sZXZlbCAoY3ljbGVzIHJlamVjdGVkKVxuLy8gICB6b25lICAgICAgICAgIGNyZWF0ZSA8bmFtZT4gKHNsdWcgaWQgZGVyaXZlZCkgfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXVxuLy8gICAgICAgICAgICAgICAgIChkZWxldGUgY2FzY2FkZXMgdGhlIHpvbmUncyBwcm9wb3NhbHM7IHBvcHVsYXRlZCB6b25lcyA0MDlcbi8vICAgICAgICAgICAgICAgICB3aXRob3V0IC0teWVzKVxuLy8gICBwcm9tb3RlIDxpZD4gIG1vdmUgYSB6b25lZCBwZW5kaW5nIHByb3Bvc2FsIHRvIHRoZSBtYWluIHJldmlldyBxdWV1ZVxuLy8gICAgICAgICAgICAgICAgIChlZGdlIGVuZHBvaW50cyBtdXN0IHByb21vdGUgZmlyc3Qg4oCUIGVycm9yIG5hbWVzIHRoZW0pXG4vLyAgIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpICBQT1NUIC9wcm9wb3NhbHMvOmlkL3pvbmUg4oCUXG4vLyAgICAgICAgICAgICAgICAgbW92ZSBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyBhIHpvbmUgKHRoZSBpbnZlcnNlIG9mIHByb21vdGUpLFxuLy8gICAgICAgICAgICAgICAgIG9yIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIG1haW5cbi8vICAgZG9jIDxpZD4gICAgICBHRVQgL2RvYy86aWQg4oaSIHRoZSBkb2MgZW52ZWxvcGUgb24gc3Rkb3V0LiBGbGFncyBtYXkgY29tZVxuLy8gICAgICAgICAgICAgICAgIGJlZm9yZSBkb2MncyBzdWItdmVyYiAoYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDFgKTsgYSBkb2Ncbi8vICAgICAgICAgICAgICAgICBsaXRlcmFsbHkgbmFtZWQgXCJkZWxldGVcIiBvciBcImtpbmRcIiByZWFkcyBhcyBgZG9jIC0tIGRlbGV0ZWBcbi8vICAgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSAgREVMRVRFIC9kb2MvOmlkIOKGkiA0MDkge2Vycm9yOlwiY2l0ZWRcIiwgY2l0ZWRCeX1cbi8vICAgICAgICAgICAgICAgICB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuLy8gICBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kPiBbLS1hdXRob3IgdXNlcnxhZ2VudF0gfCBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJcbi8vICAgICAgICAgICAgICAgICBQT1NUIC9kb2MvOmlkL2tpbmQg4oCUIGFzc2VydCAob3IgY2xlYXIpIGEgZG9jJ3Mga2luZDsgaW5nZXN0XG4vLyAgICAgICAgICAgICAgICAgbmV2ZXIgZ3Vlc3NlcyBvbmUgKHVudHlwZWQgPSBraW5kIG51bGwgb24gdGhlIHdpcmUpXG4vLyAgIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICBQT1NUIC9kb2MvOmlkL21hcmsg4oaSIGFwcGVuZCBhXG4vLyAgICAgICAgICAgICAgICAgc3RhdHVzIG1hcmsgKGRvYy5tYXJrZWQgY2FycmllcyB0aGUgZnVsbCBtYXJrIGlubGluZSlcbi8vICAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgIFBVVC9ERUxFVEVcbi8vICAgICAgICAgICAgICAgICAvYWN0aW9ucy86dGFyZ2V0SWQg4oCUIHJlcGxhY2UgKHdob2xlc2FsZSkgb3IgY2xlYXIgdGhlXG4vLyAgICAgICAgICAgICAgICAgYWN0aW9uIHNsb3RzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuXG4vLyAgICAgICAgICAgICAgICAgYXJyYXkgb2Yge2lkLCBsYWJlbCwgc2VlZH07ID40IGVudHJpZXMgd2FybnMgKHNvZnQgY2FwKVxuLy8gICB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgUFVUL0RFTEVURVxuLy8gICAgICAgICAgICAgICAgIC90YWdzLzp0YXJnZXRJZCDigJQgcmVwbGFjZSAod2hvbGVzYWxlKSBvciBjbGVhciB0aGUgZnJlZWZvcm1cbi8vICAgICAgICAgICAgICAgICB0YWdzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuIGFycmF5IG9mXG4vLyAgICAgICAgICAgICAgICAgc3RyaW5nczsgdGFncyBhbHNvIHJpZGUgcHJvcG9zZS0qIHN0ZGluIEpTT04gKGEgYHRhZ3NgIGtleSlcbi8vICAgam9iICAgICAgICAgICBjcmVhdGUgLS10aXRsZSBUIFstLXN0YXR1cyBzXSBbLS1kZWxpdmVyYWJsZSByZWZdIFstLWRldGFpbCB4XVxuLy8gICAgICAgICAgICAgICAgIHwgdXBkYXRlIDxpZD4gWy0tdGl0bGUvLS1zdGF0dXMvLS1kZWxpdmVyYWJsZS8tLWRldGFpbF1cbi8vICAgICAgICAgICAgICAgICB8IGNsYWltIDxpZD4gLS1vd25lciA8d2hvPiAoYXRvbWljIGxlYXNlOyA0MDkgaWYgaGVsZCBieVxuLy8gICAgICAgICAgICAgICAgICAgYW5vdGhlciBvd25lcikgfCByZWxlYXNlIDxpZD4gfCBzdWJ0YXNrIDxpZD4gKC0tYWRkIDxsYWJlbD5cbi8vICAgICAgICAgICAgICAgICAgIHwgLS1jaGVjayA8c3VidGFza0lkPiB8IC0tdW5jaGVjayA8c3VidGFza0lkPikgfCBsaXN0XG4vLyAgICAgICAgICAgICAgICAgfCBkZWxldGUgPGlkPi4gQSBwZXJzaXN0ZWQgdW5pdCBvZiBBR0VOVCBXT1JLIChzdGF0dXMgK1xuLy8gICAgICAgICAgICAgICAgIHN1Yi10YXNrcyArIGRlbGl2ZXJhYmxlICsgb3duZXIpOyBjcmVhdGUvdXBkYXRlIGFsc28gdGFrZSBhXG4vLyAgICAgICAgICAgICAgICAgZnVsbCBKU09OIGJvZHkgdmlhIC0tc3RkaW4gLyAtLWJvZHktZmlsZVxuLy8gICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gIFBPU1QgL2FjdGl2aXR5IOKGkiBmaXJlLWFuZC1mb3JnZXRcbi8vICAgICAgICAgICAgICAgICBhZ2VudC5hY3Rpdml0eSBzaWduYWwgKH42MHMgVFRMIGVtaXRzIHN5bnRoZXRpYyBpZGxlKVxuLy8gICBzZWFyY2ggPHEuLi4+IEdFVCAvc2VhcmNoIOKGkiB7aGl0czogW3traW5kOiBub2RlfGRvY3xtZXNzYWdlLCAuLi59XX1cbi8vICAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gIEdFVCAvbmVpZ2hib3JzLzppZCDihpIgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuLy8gICByYXRpZnkgPGlkPiAtLXJ1bGluZyBjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWx8cmVqZWN0IFstLWRvYy1lZGl0IDxmaWxlPl1cbi8vICAgICAgICAgICAgICAgICBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSAgcmF0aWZ5LXRpbWUgZXZpZGVuY2UgYXR0YWNoOlxuLy8gICAgICAgICAgICAgICAgIGZvciBhbiBFVklERU5DRS1MRVNTIG5vZGUgcHJvcG9zYWwgb25seSwgLS1kb2MgbmFtZXMgdGhlIGRvY1xuLy8gICAgICAgICAgICAgICAgIGhvbWUgKG11c3QgZXhpc3Q7IHJlcXVpcmVzIC0tZG9jLWVkaXQpIGFuZCBtaW50cyB0aGUgbm9kZSdzXG4vLyAgICAgICAgICAgICAgICAgc291cmNlcyByb3cgd2l0aCB0aGUgb3B0aW9uYWwgLS1zcGFuIGV4Y2VycHRcbi8vICAgbGVucyBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGRvY0lkPikgfCBsZW5zIGNsZWFyXG4vLyAgIGxvb2staGVyZSA8bm9kZUlkPiAgZmlyZS1vbmNlIGF0dGVudGlvbiBudWRnZSwgbm90IHBlcnNpc3RlZFxuLy8gICBzZW5kICAgICAgICAgIGJvZHkgY2hhaW46IC0tYm9keS1maWxlIDxwYXRoPiA+IC0tc3RkaW4gPiBpbmxpbmUgPHRleHQuLi4+ID5cbi8vICAgICAgICAgICAgICAgICBwaXBlZCBzdGRpbjsgWy0tcm9sZSB1c2VyfGFnZW50XSBbLS1raW5kXSBbLS1ncm91bmQgYSxiXVxuLy8gICAgICAgICAgICAgICAgIChyZXBlYXRhYmxlIOKAlCByZXBlYXRzIGFjY3VtdWxhdGUsIGNvbW1hcyBzcGxpdCBlaXRoZXIgd2F5KVxuLy8gICAgICAgICAgICAgICAgIFstLWZvcmNlXSDihpIgUE9TVCAvc2VuZC4gRW1wdHkgcmVzb2x2ZWQgYm9keSA9IHVzYWdlIGVycm9yLiBUaGVcbi8vICAgICAgICAgICAgICAgICBwaXBlZCBkZWZhdWx0IEhBTkdTIHdpdGggbm8gcGlwZSB1bmRlciBhZ2VudCBzaGVsbHMg4oCUIGFsd2F5c1xuLy8gICAgICAgICAgICAgICAgIHBhc3MgYSBib2R5ICgtLWJvZHktZmlsZSBwcmVmZXJyZWQgZm9yIHByb3NlKS5cbi8vICAgICAgICAgICAgICAgICBSMTE6IC0ta2luZCBpcyB0aGUgQ0hBTk5FTCB0aGUgbWVzc2FnZSBhcnJpdmVkIHRocm91Z2hcbi8vICAgICAgICAgICAgICAgICAodHVybnxhbmFseXplfGNhbnZhczsgb3BlbiBzZXQg4oCUIGFuIHVua25vd24gb25lIGlzIHN0b3JlZFxuLy8gICAgICAgICAgICAgICAgIHdpdGggYSBzdGRlcnIgYWR2aXNvcnksIG5ldmVyIHJlamVjdGVkKS5cbi8vICAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gIOKGkiBQT1NUIC9hY3Rpdml0eS4gVGhlXG4vLyAgICAgICAgICAgICAgICAgbWVzc2FnZUlkIHRpZXMgdGhlIHNpZ25hbCB0byBPTkUgbWVzc2FnZSBzbyB0aGUgaHVtYW4gc2Vlc1xuLy8gICAgICAgICAgICAgICAgIHdoaWNoIG9uZSBpcyBiZWluZyB3b3JrZWQ7IG9taXR0ZWQsIGl0IGluaGVyaXRzIHRoZSBvcGVuXG4vLyAgICAgICAgICAgICAgICAgbGFkZGVyJ3MgbWVzc2FnZS4gaWRsZSBjbG9zZXMgdGhlIGxhZGRlciAodGhlcmUgaXMgbm8gYGRvbmVgXG4vLyAgICAgICAgICAgICAgICAg4oCUIGFuIGFnZW50IGBzZW5kYCBJUyB0aGUgY29tcGxldGlvbiBzaWduYWwpLlxuLy9cbi8vIC0tcHJvamVjdCA8aWQ+IGlzIGFjY2VwdGVkIGJ5IGV2ZXJ5IHZlcmIgYWJvdmUgZXhjZXB0IHByb2plY3RzIChzY29wZXMgdG8gYVxuLy8gbm9uLWRlZmF1bHQgcHJvamVjdDsgb21pdCBmb3IgdGhlIGRlZmF1bHQgcHJvamVjdCkuXG4vL1xuLy8gRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgc3RhdGVkIE9OQ0Ug4oCUIHBlci12ZXJiIHByb3NlIGFib3ZlIG5hbWVzIEhUVFBcbi8vIHN0YXR1c2VzLCB0aGlzIHRhYmxlIGlzIHdoYXQgdGhlIFBST0NFU1MgZG9lcyB3aXRoIHRoZW0pOiBldmVyeSBmYWlsdXJlIGlzXG4vLyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgZW1wdHkg4oCUXG4vLyAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sXG4vLyAgICBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4vLyAgIHVzYWdlIOKGkiBleGl0IDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IChIVFRQIDQwNCkgwrcgY29uZmxpY3Qg4oaSIDZcbi8vICAgKEhUVFAgNDA5KTsgSFRUUCA0MDAgbWFwcyB0byB1c2FnZS4gQSBkYWVtb24gcmVmdXNhbCBjYXJyaWVzIHRoZSBzZXJ2ZXInc1xuLy8gICBvd24gSlNPTiBib2R5IFZFUkJBVElNIHVuZGVyIGVycm9yLnNlcnZlciAobmVlZHMtcHJvamVjdCwgY2l0ZWQsIHpvbmVkLFxuLy8gICB6b25lLW5vdC1lbXB0eSwgY2xhaW0gY29uZmxpY3RzLCDigKYpIOKAlCBicmFuY2ggb24ga2luZC9zZXJ2ZXIsIG5ldmVyIHByb3NlLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICB0eXBlIENvbW1hbmRTcGVjLFxuICBkZWZpbmVDbGksXG4gIHR5cGUgSW52b2NhdGlvbixcbiAgdHlwZSBQb3NpdGlvbmFsU3BlYyxcbn0gZnJvbSBcIi4uLy4uL2tpdC9jbGkvcmVnaXN0cnkudHNcIjtcbmltcG9ydCB7XG4gIEVYSVRfRk9SLFxuICBlcnJvckVudmVsb3BlLFxuICBnZXRDdXJyZW50Q29tbWFuZCxcbiAgQ2xpRXJyb3IgYXMgS2l0Q2xpRXJyb3IsXG4gIHR5cGUgRXJyS2luZCBhcyBLaXRFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHJlYWRTaW5jZSxcbiAgdGFpbENvbW1hbmQsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZi50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TLCBUQUlMX1JFVFJZX01BWF9NUywgVEFJTF9SRVRSWV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG4vLyDim5QgRVZFUlkgUEFUSCBCRUxPVyBJUyBDT01QVVRFRCBGUk9NIFRIRSBBUlRJRkFDVCdTIEFERFJFU1MsIFdISUNIIElTXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21pbmQtbWFwcGVyL2Rpc3QvY2xpLmpzYCDigJQgTk9UIEZST00gVEhJUyBTT1VSQ0Vcbi8vIEZJTEUuIFRoYXQgaXMgd2hhdCBtYWtlcyB0aGUgYGltcG9ydC5tZXRhLm1haW5gIGJsb2NrJ3MgYWJzZW5jZSBhdCB0aGUgYm90dG9tXG4vLyBvZiB0aGlzIGZpbGUgYSByZXF1aXJlbWVudCByYXRoZXIgdGhhbiBhIHRpZHk6IHJ1biBmcm9tXG4vLyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvYCB0aGVzZSByZXNvbHZlIGludG8gYHNyYy9taW5kLW1hcHBlci9gLCB3aGljaCBoYXMgbm9cbi8vIGBkaXN0L2luZGV4Lmh0bWxgLCBzbyB0aGUgQ0xJIHdvdWxkIGNob29zZSBERVYgYW5kIHRoZW4gc3Bhd24gYSBkYWVtb24gZnJvbVxuLy8gdGhlIHdyb25nIGFuY2hvci4gYGRpc3QvYCBzaXRzIGF0IHRoZSBzYW1lIGRlcHRoIHVuZGVyIHRoZSBza2lsbCByb290IGFzIHRoZVxuLy8gYHNjcmlwdHMvYCBpdCByZXBsYWNlZCwgc28gZXZlcnkgYW5jZXN0b3IgY2xpbWIgYmVsb3cgaXMgdW5jaGFuZ2VkIOKAlCBhXG4vLyBDT0lOQ0lERU5DRSBPRiBERVBUSCwgYXNzZXJ0ZWQgYnkgYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByYXRoZXJcbi8vIHRoYW4gdHJ1c3RlZCAocGxheWJvb2sgQjQvQjUpLlxuY29uc3QgU0NSSVBUX0RJUiA9IGltcG9ydC5tZXRhLmRpcjtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBOT1QgQSBGTEFUIFNJQkxJTkcuIFRoaXMgd2FzIGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgdW50aWwgdGhlIGJhY2tlbmQgcG9ydCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IHNoYXBlLFxuLy8gY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tIGBkaXN0L2AgdGhlXG4vLyBmbGF0IGZvcm0gbmFtZXMgYGRpc3Qvc2VydmVyLnRzYCwgd2hpY2ggZG9lcyBub3QgZXhpc3Q7IHRoZSBzeW1wdG9tIGlzIG5vdCBhXG4vLyBjcmFzaCBidXQgYGVuc3VyZURhZW1vbmAncyBwb2xsIHJ1bm5pbmcgb3V0IHRvIFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW5cbi8vIDEwc1wiLiBUaGUgbGF1bmNoZXIgaXMgdGhlIHByb2Nlc3MgYSBjYWxsZXIgcnVucywgYW5kIGl0IGxpdmVzIGluIGBzY3JpcHRzL2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2U7IEJ1biByZWFkcyBidW5maWcudG9tbFxuLy8gKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2QgTVVTVCBiZVxuLy8gc3JjL21pbmQtbWFwcGVyLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBwYWdlIDUwMHM7XG4vLyBtaW5kLW1hcHBlcidzIG93biBmYWlsdXJlIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnXG4vLyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lXG4vLyBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkIGJyZWFrIHNwYXduLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1pbmQtbWFwcGVyXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuY29uc3QgSE9NRSA9IHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLm1pbmQtbWFwcGVyXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihIT01FLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKEhPTUUsIFwiZGFlbW9uLnBpZFwiKTtcblxuZnVuY3Rpb24gbGl2ZVBvcnQoKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpIHx8ICFleGlzdHNTeW5jKFBJRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpZCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUElEX0ZJTEUsIFwidXRmOFwiKS50cmltKCksIDEwKTtcbiAgY29uc3QgcG9ydCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0ZjhcIikudHJpbSgpLCAxMCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHBpZCkgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKHBpZCwgMCk7IC8vIGxpdmVuZXNzIHByb2JlLCBubyBzaWduYWwgZGVsaXZlcmVkXG4gICAgcmV0dXJuIHBvcnQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsOyAvLyBzdGFsZSBkaXNjb3ZlcnkgZmlsZXNcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24ocG9ydD86IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJ1bm5pbmcgPSBsaXZlUG9ydCgpO1xuICAvLyBSb3VuZCA3IChQT1JUKTogYSBsaXZlIGRhZW1vbiBJR05PUkVTIC0tcG9ydCDigJQgdGhlIHN0YWJsZS11cmwgZ3VhcmFudGVlXG4gIC8vIG9ubHkgaG9sZHMgaWYgdGhlIEZJUlNUIG9wZW4gc2V0IHRoZSBwb3J0ICh0aGUgZGFlbW9uIGJpbmRzIG9uY2UgYXQgYm9vdCkuXG4gIGlmIChydW5uaW5nICE9PSBudWxsKSByZXR1cm4gcnVubmluZztcbiAgY29uc3QgcHJvYyA9IHNwYXduKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCIsIC4uLihwb3J0ID8gW1wiLS1wb3J0XCIsIFN0cmluZyhwb3J0KV0gOiBbXSldLFxuICAgIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICAgIH0sXG4gICk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gUG9sbCBkaXNjb3ZlcnkgdW50aWwgdGhlIGRhZW1vbiB3cml0ZXMgaXRzIHBvcnQgKGNvbGQgQnVuIGJ1bmRsZSBjYW4gbGFnKS5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwMCkpO1xuICAgIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICAgIGlmIChwb3J0ICE9PSBudWxsKSByZXR1cm4gcG9ydDtcbiAgfVxuICB0aHJvdyBuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBcImRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDEwc1wiKTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY21kID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gIHNwYXduKGNtZCwgW3VybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG59XG5cbi8vIOKblCBgZW52TXNgIElTIEdPTkUsIEFORCBJVFMgVFdPIEtOT0JTIE1PVkVEIFJBVEhFUiBUSEFOIERJU0FQUEVBUkVELlxuLy8gYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCBhcmUgcmVzb2x2ZWQgaW5cbi8vIGAuL2hlYXJ0YmVhdC50c2Ag4oCUIHRoZSBzZWFtIGZpbGUgQk9USCBoYWx2ZXMgaW1wb3J0IOKAlCBiZWNhdXNlIHRoZSB3YXRjaGRvZyBpc1xuLy8gREVSSVZFRCBmcm9tIHRoZSBkYWVtb24ncyBiZWF0IGFuZCBhIGtub2IgcmVzb2x2ZWQgYWJvdmUgdGhlIGRlcml2YXRpb24gc3BsaXRzXG4vLyB0aGUgcGFpciBzaWxlbnRseSwgaW52aXNpYmx5IGF0IHRoZSBkZWZhdWx0IChENzUpLlxuXG4vLyDilIDilIAgdGhlIGZhaWx1cmUgY29udHJhY3Q6IFRIRSBIT1VTRSdTIE9ORSBDT1BZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBERS1EVVBMSUNBVEVELCBBTkQgTUlORC1NQVBQRVIgSVMgT05FIE9GIFRIRSBUV08gU1BFTExTIFRISVMgTU9EVUxFJ1MgT1dOXG4vLyBIRUFERVIgTkFNRVMgQVMgSEFWSU5HIFJFQUNIRUQgSVRTIFNIQVBFIElOREVQRU5ERU5UTFkgKGBlcnJvcnMudHM6MzNgOlxuLy8gXCJnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDBcbi8vIHBhc3Nlc1wiKS4gVGhlIGRlbHRhIG9uIHRoZSBXSVJFIGlzIE5JTCwgYW5kIHRoYXQgaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhblxuLy8gYSBob3BlOiB0aGUgYEVycktpbmRgIHVuaW9uIHdhcyBjaGFyYWN0ZXItZm9yLWNoYXJhY3RlciBpZGVudGljYWwsIGBFWElUX0ZPUmBcbi8vIHdhcyB0aGUgc2FtZSBgMi8xLzUvNmAsIGFuZCB0aGUgZW52ZWxvcGUgaGFkIHRoZSBzYW1lIGtleXMgaW4gdGhlIHNhbWUgb3JkZXJcbi8vIOKAlCBge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1gIOKAlCBpbmNsdWRpbmcgYHNlcnZlcmAgTEFTVCwgd2hpY2ggdGhlIGtpdCdzIG93blxuLy8gY29tbWVudCBzYXlzIGlzIGRlbGliZXJhdGUgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCBpdCBrZWVwcyBpdHMgYnl0ZVxuLy8gb3JkZXIuIOKaoCBPTkUgbGF0ZW50IGRpZmZlcmVuY2UsIGNoZWNrZWQgYW5kIGVtcHR5OiB0aGUga2l0IGd1YXJkcyBgaGludGAgYW5kXG4vLyBgY2hvaWNlc2Agb24gVFJVVEhJTkVTUyB3aGVyZSB0aGlzIGZpbGUgZ3VhcmRlZCBvbiBQUkVTRU5DRSwgc28gYVxuLy8gYGhpbnQ6IFwiXCJgIHdvdWxkIHNoaXAgZnJvbSBvbmUgYW5kIG5vdCB0aGUgb3RoZXIuIEdyZXBwZWQ6IHRoaXMgQ0xJIGhhcyBub1xuLy8gZW1wdHktc3RyaW5nIGhpbnQgYXQgYW55IG9mIGl0cyA2NCByYWlzZSBzaXRlcywgc28gdGhlIHBvcHVsYXRpb25zIGFncmVlLlxuLy9cbi8vIG1pbmQtbWFwcGVyIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0XG4vLyBFVkVSWSBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXNcbi8vIHByZXNlbnRhdGlvbiDigJQgcmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzXG4vLyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBEZWxpdmVyeSBpcyBib3VudHkncywgbm90IG1hZ3BpZSdzOiBUSFJPV1xuLy8gYW5kIGxldCBtYWluKCkgY2F0Y2ggYW5kIFJFVFVSTiB0aGUgY29kZSDigJQgdGhpcyBDTEkgc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4vLyBwYXlsb2FkcywgYW5kIGEgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgYGRpZSgpYCB3b3VsZCB0cnVuY2F0ZSB0aGVtIGF0IDY1LDUzNlxuLy8gYnl0ZXMgKHNlZSB0aGUgZHJhaW4gaWRpb20gYXQgdGhlIGJvdHRvbSBvZiB0aGlzIGZpbGUpLiBUaGUga2l0J3MgYGRpZWBcbi8vIHRocm93cyBmb3IgZXhhY3RseSB0aGF0IHJlYXNvbiwgc28gdGhlIGFkb3B0aW9uIGNoYW5nZXMgbm8gZGVsaXZlcnkgZWl0aGVyLlxuLy9cbi8vIOKblCBBTkQgVEhJUyBJUyBUSEUgT05FIFNURVAgT0YgVEhFIFdIT0xFIFBIQVNFIFdIRVJFIFRIRSBLSVQgSVMgTUVBU1VSQUJMWVxuLy8gV0VBS0VSLCBXSElDSCBJUyBXSFkgVEhFIFRSSUFHRSBDSEFJTiBJTiBgbWFpbmAgQkVMT1cgSVMgS0VQVCBBTkQgTk9UXG4vLyBSRVBMQUNFRC4gYGVycm9ycy50c2AgaXMgVFdPIHRoaW5ncyDigJQgYW4gRU5WRUxPUEUgYW5kIGEgQ0xBU1NJRklFUiDigJQgYW5kIG9ubHlcbi8vIHRoZSBlbnZlbG9wZSBjb252ZXJnZWQuIGByZXBvcnRDbGlFcnJvcmAgcmV0dXJucyBgbnVsbGAgZm9yIGFueXRoaW5nIHRoYXQgaXNcbi8vIG5vdCBhIGBDbGlFcnJvcmAgYW5kIGRlbWFuZHMgdGhlIGNhbGxlciByZXRocm93OyB0aGlzIENMSSB0cmlhZ2VzIFRIUkVFXG4vLyBkb2N1bWVudGVkIHVzYWdlIGNsYXNzZXMgb3V0IG9mIHJhdyB0aHJvd3MgKGBFUlJfUEFSU0VfQVJHUypgLCBhXG4vLyBgU3ludGF4RXJyb3JgIGZyb20gYSBKU09OIGJvZHksIGFuZCBgRU5PRU5UYCBvbiBhIG5hbWVkIGZpbGUpLiBBZG9wdGluZyB0aGVcbi8vIGNsYXNzaWZpZXIgbmFpdmVseSB3b3VsZCByZWdyZXNzIGFsbCB0aHJlZSBpbnRvIGEgc3RhY2stdHJhY2UgY3Jhc2gg4oCUIHRoZVxuLy8gZXhhY3QgZGVmZWN0IHRoaXMgZmlsZSdzIG93biBjb21tZW50IHJlY29yZHMgYXMgY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nLFxuLy8gcmUtY3JlYXRlZCBieSB0aGUgYWRvcHRpb24gbWVhbnQgdG8gc3RhbmRhcmRpc2UgaXQuIFNvIGByZXBvcnRDbGlFcnJvcmAgaXNcbi8vIGNhbGxlZCBJTlNJREUgdGhlIGNoYWluLCBhdCB0aGUgcG9zaXRpb24gdGhlIGNoYWluIHJlYWNoZXMgZm9yIGEgdHlwZWRcbi8vIGZhaWx1cmUsIGFuZCB0aGUgY2hhaW4ga2VlcHMgdGhlIHRocmVlIGJyYW5jaGVzIHRoZSBraXQgZG9lcyBub3QgY2FycnkuXG50eXBlIEVycktpbmQgPSBLaXRFcnJLaW5kO1xuXG4vKipcbiAqIG1pbmQtbWFwcGVyJ3MgcmFpc2UgdHlwZSBpcyBub3cgdGhlIGtpdCdzIGBDbGlFcnJvcmAsIHJlLWV4cG9ydGVkIHVuZGVyIHRoZVxuICogbmFtZSA2MiBjYWxsIHNpdGVzIGFscmVhZHkgdXNlLiDimqAgVGhlIEZJRUxEIFNIQVBFIGRpZmZlcnM6IHRoaXMgZmlsZSdzIGNsYXNzXG4gKiBoZWxkIGBoaW50YC9gY2hvaWNlc2AvYHNlcnZlcmAgYXMgb3duIHByb3BlcnRpZXMgYW5kIHRoZSBraXQgaG9sZHMgdGhlbSBpbiBhblxuICogYGV4dHJhYCBiYWcsIHNvIHRoZSBjb25zdHJ1Y3RvciBiZWxvdyBhZGFwdHMgcmF0aGVyIHRoYW4gdGhlIGNhbGwgc2l0ZXNcbiAqIGNoYW5naW5nIOKAlCBhIHJlbG9jYXRpb24tc2hhcGVkIGVkaXQgYXQgNjIgc2l0ZXMgaW5zaWRlIGEgY2hhcHRlciB0aXRsZWRcbiAqIFwiYmVoYXZpb3VyIGNoYW5nZXMsIGFuZCBlYWNoIGNoYW5nZSBpcyBuYW1lZFwiIGlzIGhvdyBhIHJlYWwgY2hhbmdlIGhpZGVzLlxuICovXG5jbGFzcyBDbGlFcnJvciBleHRlbmRzIEtpdENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAga2luZDogRXJyS2luZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9LFxuICApIHtcbiAgICBzdXBlcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuY29uc3QgdXNhZ2VFcnJvciA9IChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkgPT5cbiAgbmV3IENsaUVycm9yKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuXG4vKipcbiAqIFJlcG9ydCBvbmUgb2YgdGhlIHRocmVlIFJBVyB0aHJvd3MgdGhlIGtpdCdzIGNsYXNzaWZpZXIgZG9lcyBub3QgcmVjb2duaXNlIGFzXG4gKiBhIGB1c2FnZWAgZW52ZWxvcGUsIGFuZCBoYW5kIGJhY2sgaXRzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgVEhFIENMQVNTSUZJRVIgSVMgVEhFIEhBTEYgVEhBVCBESUQgTk9UIENPTlZFUkdFLiBUaGVzZVxuICogdGhyZWUgYXJlIG5vdCBgQ2xpRXJyb3JgcyDigJQgdGhleSBhcmUgYSBgbm9kZTp1dGlsYCBwYXJzZSByZWplY3Rpb24sIGFcbiAqIGBTeW50YXhFcnJvcmAgb3V0IG9mIGBKU09OLnBhcnNlYCwgYW5kIGFuIGBFTk9FTlRgIGZyb20gYSBuYW1lZCBwYXRoIOKAlCBhbmRcbiAqIGByZXBvcnRDbGlFcnJvcmAgYW5zd2VycyBgbnVsbGAgZm9yIGFsbCB0aHJlZS4gUm91dGluZyB0aGVtIHRocm91Z2ggdGhlXG4gKiBFTlZFTE9QRSAod2hpY2ggZGlkIGNvbnZlcmdlKSBpcyB0aGUgd2hvbGUgb2YgdGhlIHJlcGFpcjogc2FtZSBieXRlcyBvblxuICogc3RkZXJyLCBzYW1lIGV4aXQgMiwgYW5kIHRoZSB0cmlhZ2Ugc3RheXMgd2hlcmUgdGhlIHNwZWxsIGNhbiBzZWUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlcG9ydFVzYWdlKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KTogbnVtYmVyIHtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKSk7XG4gIHJldHVybiBFWElUX0ZPUi51c2FnZTtcbn1cblxuLy8gVGhlIG9uZSBleGl0IGZvciBldmVyeSBkYWVtb24gcm91bmQtdHJpcDogb2sg4oaSIHRoZSBib2R5IHRleHQgKGNhbGxlciBwcmludHNcbi8vIGl0IG9uIHN0ZG91dCksIHJlZnVzZWQg4oaSIGEgdHlwZWQgQ2xpRXJyb3Igd2hvc2Uga2luZCBtYXBzIG9mZiB0aGUgSFRUUFxuLy8gc3RhdHVzIGFuZCB3aG9zZSBgc2VydmVyYCBmaWVsZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gSlNPTiBib2R5LlxuYXN5bmMgZnVuY3Rpb24gcGFzc09yVGhyb3cocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICBpZiAocmVzLm9rKSByZXR1cm4gdGV4dDtcbiAgbGV0IHNlcnZlcjogdW5rbm93biA9IHRleHQ7XG4gIHRyeSB7XG4gICAgc2VydmVyID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gZGFlbW9uIGJvZHkgcmlkZXMgYXMgdGhlIHJhdyBzdHJpbmcgKi9cbiAgfVxuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICByZXMuc3RhdHVzID09PSA0MDRcbiAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgOiByZXMuc3RhdHVzID09PSA0MDlcbiAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgOiByZXMuc3RhdHVzID09PSA0MDBcbiAgICAgICAgICA/IFwidXNhZ2VcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgYCR7Z2V0Q3VycmVudENvbW1hbmQoKSA/PyBcInJlcXVlc3RcIn0gcmVmdXNlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHtcbiAgICBzZXJ2ZXIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlRGFlbW9uKCk6IG51bWJlciB7XG4gIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICBpZiAocG9ydCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBDbGlFcnJvcihcIm5vdF9mb3VuZFwiLCBcIm5vIGRhZW1vbiBydW5uaW5nICh1c2UgYG9wZW5gIGZpcnN0KVwiKTtcbiAgfVxuICByZXR1cm4gcG9ydDtcbn1cblxuLy8gU2tlbGV0b24gcHJvamVjdGlvbiDigJQgaWRzL3RpdGxlcy9kZWdyZWUgb25seSwgbm8gc3lub3BzaXMvY29udGVudC4gS2VwdCBhc1xuLy8gYSBjbGllbnQtc2lkZSB0cmFuc2Zvcm0gKHRoZSBkYWVtb24gc3RheXMgZHVtYiBhbmQgYWx3YXlzIHNlcnZlcyB0aGUgZnVsbFxuLy8gc25hcHNob3Q7IHNrZWxldG9uIGlzIGEgY291cnRlc3kgc2hhcGUgZm9yIGNvbnRleHQtYnVkZ2V0ZWQgYWdlbnQgcmVhZHMpLlxuZnVuY3Rpb24gdG9Ta2VsZXRvbihzdGF0ZToge1xuICBub2RlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBraW5kOiBzdHJpbmc7IHRpZXI6IHN0cmluZyB9PjtcbiAgZWRnZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgc291cmNlOiBzdHJpbmc7IHRhcmdldDogc3RyaW5nIH0+O1xufSkge1xuICBjb25zdCBkZWdyZWUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2Ygc3RhdGUuZWRnZXMpIHtcbiAgICBkZWdyZWUuc2V0KGUuc291cmNlLCAoZGVncmVlLmdldChlLnNvdXJjZSkgPz8gMCkgKyAxKTtcbiAgICBkZWdyZWUuc2V0KGUudGFyZ2V0LCAoZGVncmVlLmdldChlLnRhcmdldCkgPz8gMCkgKyAxKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG5vZGVzOiBzdGF0ZS5ub2Rlcy5tYXAoKG4pID0+ICh7XG4gICAgICBpZDogbi5pZCxcbiAgICAgIHRpdGxlOiBuLnRpdGxlLFxuICAgICAga2luZDogbi5raW5kLFxuICAgICAgdGllcjogbi50aWVyLFxuICAgICAgZGVncmVlOiBkZWdyZWUuZ2V0KG4uaWQpID8/IDAsXG4gICAgfSkpLFxuICB9O1xufVxuXG4vLyDilIDilIAgdGhlIGZsYWcgcmVnaXN0cnkgKyB0aGUgY29tbWFuZCB0YWJsZSwgT04gVEhFIEtJVCBSRUdJU1RSWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS4gRXZlcnkgaW52b2NhdGlvbiBpcyBwYXJzZWQgc3RyaWN0XG4vLyBhZ2FpbnN0IHRoaXMgd2hvbGUgdGFibGUsIHNvIGEgdG9rZW4gbWluZC1tYXBwZXIgaGFzIG5ldmVyIGhlYXJkIG9mIGlzXG4vLyByZWZ1c2VkIGFzIFVOS05PV047IHRoZSByZWdpc3RyeSB0aGVuIGFza3MgdGhlIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OlxuLy8gaXMgdGhpcyBmbGFnIGFjY2VwdGVkIEFUIFRISVMgVkVSQi4gQSByZWNvZ25pemVkIGZsYWcgb24gdGhlIHdyb25nIHZlcmIgaXNcbi8vIHJlZnVzZWQgYXMgTUlTUExBQ0VEIChgc3RhdGUgLS1ydWxpbmdgIGlzIG5vdCBhIHR5cG8pLCBhbmQgYm90aCByZWplY3Rpb25zXG4vLyBjYXJyeSB0aGF0IHZlcmIncyBhY2NlcHRlZCBzZXQgYXMgYGNob2ljZXNgLlxuLy9cbi8vIE5PIERFRkFVTFRTIGluIHRoZSB0YWJsZTogcGVyLXZlcmIgZGVmYXVsdHMgbGl2ZSBhdCB0aGUgY29uc3VtcHRpb24gc2l0ZVxuLy8gKGA/PyBcImFnZW50XCJgLCBgPz8gXCIxXCJgKSwgd2hlcmUgdGhlIGRhZW1vbidzIGNvbnRyYWN0IGlzIHdyaXR0ZW4uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYWRkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYW5jaG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYXV0aG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYmF0Y2g6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hlY2s6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBjcmVhdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkZWxpdmVyYWJsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRlcHRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZGV0YWlsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJkb2MtZWRpdFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZmlsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIC8vIHNlbmQgLS1ncm91bmQgaXMgcGFyc2VBcmdzLWBtdWx0aXBsZWAgQlkgU0VBTSAoQ29udHJhY3QgOSBSNDogcmVwZWF0c1xuICAvLyBhY2N1bXVsYXRlLCBjb21tYXMgc3BsaXQpIOKAlCBhbnkgdmVyYiBjb3B5aW5nIHRoZSBwYXR0ZXJuIGNvcGllcyB0aGlzIHRvby5cbiAgZ3JvdW5kOiB7IHR5cGU6IFwic3RyaW5nXCIsIG11bHRpcGxlOiB0cnVlIH0sXG4gIGluYm91bmQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1lc3NhZ2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBub2RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9uY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgb3duZXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvamVjdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJvbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBydWxpbmc6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNrZWxldG9uOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHNwYW46IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzeW5vcHNpczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB1bmNoZWNrOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgeWVzOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHpvbmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxudHlwZSBPcHRzID0gdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFnID0ga2V5b2YgT3B0cyAmIHN0cmluZztcbi8qKiBUaGUgcGFyc2VkIHZhbHVlcywgdHlwZWQgb2ZmIHRoZSB0YWJsZTogYSBgbXVsdGlwbGVgIGZsYWcgaXMgYW4gYXJyYXksIGFcbiAqICBzdHJpbmcgZmxhZyBhIHN0cmluZywgYSBib29sZWFuIGZsYWcgYSBib29sZWFuLiAqL1xudHlwZSBGbGFncyA9IHtcbiAgLXJlYWRvbmx5IFtLIGluIEZsYWddPzogT3B0c1tLXSBleHRlbmRzIHsgbXVsdGlwbGU6IHRydWUgfVxuICAgID8gc3RyaW5nW11cbiAgICA6IE9wdHNbS11bXCJ0eXBlXCJdIGV4dGVuZHMgXCJzdHJpbmdcIlxuICAgICAgPyBzdHJpbmdcbiAgICAgIDogYm9vbGVhbjtcbn07XG4vKiogV2hhdCBldmVyeSBoYW5kbGVyIGJlbG93IHJlYWRzIOKAlCB0aGUgc2hhcGUgYHBhcnNlQXJnc2AgdXNlZCB0byBoYW5kIHRoZW0sXG4gKiAgc28gZWFjaCBib2R5IG1vdmVkIG9udG8gdGhlIHJlZ2lzdHJ5IHVuY2hhbmdlZC4gKi9cbnR5cGUgUGFyc2VkID0geyB2YWx1ZXM6IEZsYWdzOyBwb3NpdGlvbmFsczogc3RyaW5nW10gfTtcbmNvbnN0IG9uID1cbiAgKGg6IChwYXJzZWQ6IFBhcnNlZCkgPT4gdW5rbm93bikgPT5cbiAgKGludjogSW52b2NhdGlvbjxGbGFnPik6IHVua25vd24gPT5cbiAgICBoKHsgdmFsdWVzOiBpbnYuZmxhZ3MgYXMgRmxhZ3MsIHBvc2l0aW9uYWxzOiBpbnYucG9zIH0pO1xuXG4vKipcbiAqIGBhY3Rpdml0eSA8c3RhdGU+YCdzIGFjY2VwdGVkIHZhbHVlcyDigJQgdGhlIG9uZSBFTlVNRVJBVEVEIFBPU0lUSU9OQUwgaW4gdGhpc1xuICogQ0xJLCBhbmQgdGhlIG9uZSBjbG9zZWQgc2V0IHRoYXQgd2FzIG5vdCBhbHJlYWR5IHB1Ymxpc2hlZCBhcyBgY2hvaWNlc2AuXG4gKi9cbmV4cG9ydCBjb25zdCBBQ1RJVklUWV9TVEFURVMgPSBbXCJyZWNlaXZlZFwiLCBcInRoaW5raW5nXCIsIFwiaWRsZVwiXSBhcyBjb25zdDtcblxuY29uc3QgSEVMUCA9IGBtaW5kLW1hcHBlciDigJQgYSBjby1wcmVzZW50IGtub3dsZWRnZSBtYXA6IGEgZHVtYiBkYWVtb24gaG9sZHMgdGhlIGdyYXBoLCB0aGUgY2FzdGluZyBhZ2VudCBkb2VzIHRoZSB0aGlua2luZy5cblxuICBvcGVuICAgWy0tcHJvamVjdCA8aWQ+XSBbLS1wb3J0IDxuPl0gWy0tbm8tb3Blbl0gICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybFxuICBzdGF0ZSAgWy0tc2tlbGV0b25dIFstLWJhdGNoIDxpZD5dICAgICAgICAgICAgICAgICB0aGUgcHJvamVjdCBzbmFwc2hvdCAoc2tlbGV0b24gPSBpZHMvdGl0bGVzL2RlZ3JlZSlcbiAgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+ICAgICAgICAgICAgICAgICAgICAgYm91bmRlZCBkZWx0YSwgQURESVRJT05TIE9OTFkgKG5vdENvdmVyZWQgbmFtZXMgdGhlIHJlc3QpXG4gIHRhaWwgICBbLS1zaW5jZSBOXSBbLS1pbmJvdW5kXSBbLS1vbmNlXSAgICAgICAgICAgIFNTRSBldmVudHMgYXMgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yOyBzZWUgYmVsb3cpXG4gIHByb2plY3RzIFstLWNyZWF0ZSA8dGl0bGU+XSAgICAgICAgICAgICAgICAgICAgICAgIGxpc3QgcHJvamVjdHMgLyBjcmVhdGUgb25lXG4gIGluZ2VzdCAtLXRpdGxlIDx0PiAoLS1maWxlIDxwPiB8IC0tc3RkaW4pICAgICAgICAgIGFkZCBhIGRvY1xuICBwcm9wb3NlLW5vZGUgLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFnZSBhIG5vZGUgcHJvcG9zYWwgKEpTT04ge2RyYWZ0LCBldmlkZW5jZSwgLi4ufSlcbiAgcHJvcG9zZS1lZGdlIC0tc3RkaW4gWy0tem9uZSA8aWQ+XSAgICAgICAgICAgICAgICAgc3RhZ2UgYW4gZWRnZSBwcm9wb3NhbFxuICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFnZSBhIHNldCBpbiBvbmUgdHhuICh7bm9kZXMsIGVkZ2VzfSlcbiAgcmF0aWZ5LWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF0aWZ5IGEgc2V0IGluIG9uZSB0eG4gKHtydWxpbmcsIGlkcywgYW5jaG9ycz99KVxuICBkZWxldGUtYmF0Y2ggLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWxldGUgYSBwcm9wb3NhbCBzZXQgaW4gb25lIHR4biAoe2lkc30sIGFsbC1vci1ub3RoaW5nKVxuICByYXRpZnkgPGlkPiAtLXJ1bGluZyA8cj4gWy0tZG9jLWVkaXQgPGZpbGU+XSBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHQ+XSBbLS1hbmNob3IgPHBhcmVudElkPl1cbiAgem9uZSAgIGNyZWF0ZSA8bmFtZT4gfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXSAgc3RhZ2luZyBwZW5zIGZvciBwcm9wb3NhbHNcbiAgcHJvbW90ZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbW92ZSBhIHpvbmVkIHByb3Bvc2FsIHRvIHRoZSBtYWluIHF1ZXVlXG4gIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8ej4gfCAtLWNsZWFyKSB8IHByb3Bvc2FsIGRlbGV0ZSA8aWQ+XG4gIG5vZGUgICBhbmNob3IgPGlkPiAoLS10byA8cD4gfCAtLWNsZWFyKSB8IGVkaXQgPGlkPiBbLS10aXRsZS8tLXN5bm9wc2lzLy0tc3RkaW5dIHwgZGVsZXRlIDxpZD4gWy0tZm9yY2VdXG4gIGRvYyAgICA8aWQ+IHwgZGVsZXRlIDxpZD4gWy0tZm9yY2VdIHwga2luZCA8ZG9jSWQ+ICg8a2luZD4gWy0tYXV0aG9yIGFdIHwgLS1jbGVhcilcbiAgICAgICAgIGZsYWdzIG1heSBwcmVjZWRlIHRoZSBzdWItdmVyYiAoZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSA8aWQ+KTsgZG9jIC0tIDxpZD4gcmVhZHMgYSBkb2MgbmFtZWQgXCJkZWxldGVcIiBvciBcImtpbmRcIlxuICBtYXJrICAgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICAgICAgICAgICBhcHBlbmQgYSBkb2Mgc3RhdHVzIG1hcmtcbiAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgICBhY3Rpb24gc2xvdHMgb24gYSBub2RlL3BlbmRpbmcgcHJvcG9zYWxcbiAgdGFncyAgIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgICBmcmVlZm9ybSB0YWdzLCBzYW1lIHRhcmdldHNcbiAgam9iICAgIGNyZWF0ZXx1cGRhdGV8Y2xhaW18cmVsZWFzZXxzdWJ0YXNrfGxpc3R8ZGVsZXRlICBwZXJzaXN0ZWQgdW5pdHMgb2YgYWdlbnQgd29ya1xuICBzZWFyY2ggPHF1ZXJ5Li4uPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBGVFMgb3ZlciBub2RlcywgZG9jcywgbWVzc2FnZXNcbiAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuICBsZW5zICAgc2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxpZD4pIHwgbGVucyBjbGVhclxuICBsb29rLWhlcmUgPG5vZGVJZD4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXG4gIHJlYWQgICA8bWVzc2FnZUlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuICBzZW5kICAgPHRleHQuLi4+IHwgLS1ib2R5LWZpbGUgPHA+IHwgLS1zdGRpbiAgICAgICBwb3N0IGEgbWVzc2FnZSAoWy0tcm9sZV0gWy0ta2luZF0gWy0tZ3JvdW5kXSlcbiAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gdGhlIGNhc3RpbmctbG9vcCBsaXZlbmVzcyBzaWduYWxcbiAgdmVyc2lvbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVxuICBzY2hlbWEgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGUgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcbiAgaGVscCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaClcblxuICAtLXByb2plY3QgPGlkPiBnb2VzIGFmdGVyIHRoZSB2ZXJiOyBldmVyeSB2ZXJiIHRoYXQgcmVhZHMgYSBtYXAgYWNjZXB0cyBpdCAocHJvamVjdHMsIGhlbHAsXG4gIHZlcnNpb24gYW5kIHNjaGVtYSBkbyBub3QpLiBPbWl0IGl0IGZvciB0aGUgZGVmYXVsdCBwcm9qZWN0LiBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgbGluZTogYSBmbGFnIG9uIHRoZSB3cm9uZyB2ZXJiIGlzXG4gIHJlZnVzZWQsIGFuZCB0aGUgcmVqZWN0aW9uIGxpc3RzIHRoYXQgdmVyYidzIG93biBmbGFncy5cblxuICBPdXRwdXQ6IGV2ZXJ5IHZlcmIgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlFxuICBleGNlcHQgdGFpbCwgYSBzdHJlYW0gdGhhdCBwcmludHMgb25lIEpTT04gbGluZSBwZXIgZXZlbnQsIGFuZCBoZWxwLCB3aGljaCBpc1xuICBwcm9zZS4gUHJvc2UsIHdhcm5pbmdzIGFuZFxuICBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnI7IGZhaWx1cmVzIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG5cbiAgS2VlcCB3YXRjaGluZyBwYXN0IE1vbml0b3IncyAzMC1taW51dGUgY2FwLiBBcm0gdGhlIHRhaWwgd2l0aCBNb25pdG9yIGF0XG4gIHRpbWVvdXRfbXM6IDE4MDAwMDAuIEl0IGVuZHMgaXRzZWxmIGp1c3QgYmVmb3JlIHRoZSBjYXAsIGFuZCBpdHMgbGFzdCBsaW5lXG4gICh0eXBlOiBcInRhaWwu4oCmXCIpIG5hbWVzIHlvdXIgbmV4dCBhY3QuIFRoYXQgbGluZSdzIGNvbW1hbmQgaXMgdGhlIHZlcmIgYW5kIGl0c1xuICBhcmd1bWVudHMgb25seSwgYm9va21hcmsgKC0tc2luY2UpIGluY2x1ZGVkLCB3aXRoIG5vIGxhdW5jaGVyIGFuZCBubyBwYXRoLlxuICBBbHdheXMgcnVuIGl0IHdpdGggdGhpcyBza2lsbCdzIG93biBsYXVuY2hlciwgdGhlIG9uZSB5b3UgdXNlIGZvciBpdHMgb3RoZXJcbiAgdmVyYnM6IGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+LiBBIGNvbW1hbmQgb2ZcbiAgdGFpbCAtLXNpbmNlIDEyIHJ1bnMgYXMgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyB0YWlsIC0tc2luY2UgMTIuXG4gIE5ldmVyIHJldXNlIGEgbGF1bmNoZXIgcGF0aCBmcm9tIGFuIGVhcmxpZXIgbGluZSBvciBzZXNzaW9uOiB0aGUgcGx1Z2luJ3NcbiAgZGlyZWN0b3J5IGNoYW5nZXMgd2hlbiBpdCB1cGRhdGVzLiBEbyB3aGF0IG5leHQgc2F5czpcblxuICAtIG1vbml0b3I6IGFybSBNb25pdG9yIGFnYWluIHdpdGggdGhlIGxhdW5jaGVyIGFuZCBjb21tYW5kLlxuICAtIGJhY2tncm91bmQ6IG5vdGhpbmcgaGFwcGVuZWQ7IHRoZSBodW1hbiBpcyBhd2F5LiBSdW4gdGhlIGxhdW5jaGVyIGFuZFxuICAgIGNvbW1hbmQgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpLiBJdCBleGl0cyBvbiB0aGVcbiAgICBuZXh0IGV2ZW50LCB3aGljaCB3YWtlcyB5b3UuIEhhbmRsZSB0aGUgZXZlbnQsIHRoZW4gZm9sbG93IGl0cyBsaW5lIGJhY2sgdG9cbiAgICBNb25pdG9yLlxuICAtIHN0b3A6IHRoZSBzZXNzaW9uIGNsb3NlZCBvciBpdHMgZGFlbW9uIGlzIGdvbmUuIERvIG5vdCByZS1hcm07IHRoZSBsYXVuY2hlclxuICAgIGFuZCBjb21tYW5kIGJyaW5nIGl0IGJhY2suIElmIHlvdSBydW4gaXQsIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vXG4gICAgLS1zaW5jZSAoYW5kIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cywgd2hlcmUgdGhlcmUgaXMgb25lKTogYSByZXN0YXJ0ZWRcbiAgICBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZy5cblxuICBJZiBNb25pdG9yIGV4cGlyZXMgYmVmb3JlIHRoYXQgbGluZSBhcnJpdmVzLCByZS1hcm0gc2lsZW50bHkgd2l0aFxuICAtLXNpbmNlIDx0aGUgbGFzdCBpZCB5b3Ugc2F3Piwgd3JpdHRlbiA8aWQ+QDxpdHMgZXBvY2g+IHdoZW4gZXZlbnRzIGNhcnJ5IGFuXG4gIGVwb2NoLiBOZXZlciByZS1hcm0gd2l0aG91dCAtLXNpbmNlOiB0aGF0IHJlcGxheXMgZXZlbnRzIHlvdSBoYXZlIGFscmVhZHlcbiAgaGFuZGxlZC4gSWYgdGhlIGxhdW5jaGVyIHJlZnVzZXMgYSBjb21tYW5kIHdpdGggYSB1c2FnZSBlcnJvciwgaXRzIG1lc3NhZ2VcbiAgbmFtZXMgdGhlIGZvcm1zIGl0IGFjY2VwdHM7IGZpeCB0aGUgYXJndW1lbnRzIHRvIG1hdGNoLlxuICB0YWlsICR7V0lORE9XX0hFTFB9LmA7XG5cbi8vIFRoZSBwbHVnaW4gbWFuaWZlc3QgaXMgdGhlIG9uZSB2ZXJzaW9uIHNvdXJjZTsgdGhlIENMSSByZWFkcyBpdCByYXRoZXIgdGhhblxuLy8gbWlycm9yaW5nIHRoZSBudW1iZXIgKGFzdHJvbGFiZSdzIHBhdHRlcm4pLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlXG4vLyBkZWdyYWRlcyB0byBcInVua25vd25cIiBpbnN0ZWFkIG9mIGludmVudGluZyBvbmUuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhcbiAgICAgIGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpLFxuICAgICAgXCJ1dGY4XCIsXG4gICAgKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwibWluZC1tYXBwZXJcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoIHRvIHVua25vd24gKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcIm1pbmQtbWFwcGVyXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8vIOKUgOKUgCB0aGUgaGFuZGxlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gT25lIHBlciBjb21tYW5kIHBhdGguIFRoZSByZWdpc3RyeSBoYXMgYWxyZWFkeSByZWZ1c2VkIGFuIHVua25vd24gb3Jcbi8vIG1pc3BsYWNlZCBmbGFnIGFuZCBlbmZvcmNlZCB0aGUgZGVjbGFyZWQgYXJpdHkgYmVmb3JlIGFueSBvZiB0aGVzZSBydW5zLCBzb1xuLy8gYSByZXF1aXJlZCBwb3NpdGlvbmFsIGlzIGFsd2F5cyBwcmVzZW50IGhlcmUuXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKHBhcnNlZC52YWx1ZXMucG9ydCk7XG4gIC8vIC0tcHJvamVjdCBzY29wZXMgdGhlIHByaW50ZWQgVVJMICsgc3Bhd25lZCBicm93c2VyICg/cHJvamVjdD0gcmlkZXNcbiAgLy8gYWxvbmcpLiBPcGVuIG5ldmVyIG1pbnRzOiBhbiB1bmtub3duIGlkIGlzIGEgdXNhZ2UgZXJyb3IgcG9pbnRpbmcgYXRcbiAgLy8gYHByb2plY3RzIC0tY3JlYXRlYCwgbm90IGEgc2lsZW50IG5ldyBzdG9yZS5cbiAgY29uc3QgcHJvamVjdCA9IHBhcnNlZC52YWx1ZXMucHJvamVjdDtcbiAgaWYgKHByb2plY3QgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvamVjdHNgKTtcbiAgICBjb25zdCBib2R5ID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgIGlmICghYm9keS5wcm9qZWN0cy5zb21lKChwKSA9PiBwLmlkID09PSBwcm9qZWN0KSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgYHVua25vd24gcHJvamVjdDogJHtwcm9qZWN0fSAob3BlbiBuZXZlciBjcmVhdGVzIG9uZSDigJQgdXNlIFxcYHByb2plY3RzIC0tY3JlYXRlIDx0aXRsZT5cXGAgZmlyc3QpYCxcbiAgICAgICAgeyBjaG9pY2VzOiBib2R5LnByb2plY3RzLm1hcCgocCkgPT4gcC5pZCkgfSxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3Byb2plY3QgPyBgLz9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHByb2plY3QpfWAgOiBcIlwifWA7XG4gIGlmICghcGFyc2VkLnZhbHVlc1tcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHVybCB9KX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICBpZiAocGFyc2VkLnZhbHVlcy5iYXRjaCkgcGFyYW1zLnNldChcImJhdGNoXCIsIHBhcnNlZC52YWx1ZXMuYmF0Y2gpO1xuICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3RhdGUke3FzfWApO1xuICAvLyBBIG5vbi1vayAvc3RhdGUgKDQwOSBuZWVkcy1wcm9qZWN0IG9uIGEgZnJlc2ggc3RvcmUsIDQwNCB1bmtub3duXG4gIC8vIHByb2plY3QpIHJpZGVzIHRoZSBlcnJvciBlbnZlbG9wZSB3aXRoIHRoZSBkYWVtb24gYm9keSB1bmRlclxuICAvLyBlcnJvci5zZXJ2ZXIg4oCUIHRoZSBza2VsZXRvbiB0cmFuc2Zvcm0gb25seSBydW5zIG9uIGEgcmVhbCBzbmFwc2hvdC5cbiAgY29uc3Qgc3RhdGVUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc2tlbGV0b24pIHtcbiAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGVUZXh0KSBhcyBQYXJhbWV0ZXJzPHR5cGVvZiB0b1NrZWxldG9uPlswXTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh0b1NrZWxldG9uKHN0YXRlKSl9XFxuYCk7XG4gIH0gZWxzZSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7c3RhdGVUZXh0fVxcbmApO1xuICB9XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCAxMiAoU0VBTSAzKTogYGNoYW5nZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPmAg4oCUIHRoZSBib3VuZGVkIGRlbHRhLlxuLy8gUmVhZCB0aGUgcmVzcG9uc2UncyBub3RDb3ZlcmVkIGJlZm9yZSB0cnVzdGluZyBhbiBlbXB0eSBvbmU6IFwibm90aGluZ1xuLy8gYWRkZWRcIiBpcyBOT1QgXCJub3RoaW5nIGNoYW5nZWRcIiAoZGVsZXRpb25zLCByZWplY3Rpb25zIGFuZCBpbi1wbGFjZSBlZGl0c1xuLy8gYXJlIGludmlzaWJsZSBoZXJlIGJ5IGNvbnN0cnVjdGlvbikuXG5hc3luYyBmdW5jdGlvbiBjbWRDaGFuZ2VzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc2luY2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcImNoYW5nZXMgcmVxdWlyZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPiAodXNlIDAgZm9yIGV2ZXJ5dGhpbmcsIHRoZW4gcGFzcyBiYWNrIHRoZSBgbm93YCBmcm9tIHRoZSBwcmV2aW91cyByZXNwb25zZSlcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogXCJBRERJVElPTlMgT05MWSDigJQgdGhlIHJlc3BvbnNlJ3Mgbm90Q292ZXJlZCBuYW1lcyB3aGF0IGl0IGNhbm5vdCBzZWU7IGEgZnVsbCBgc3RhdGVgIHJlYWQgaXMgc3RpbGwgdGhlIG9ubHkgd2F5IHRvIHJlY29uY2lsZSBkZWxldGlvbnMsIHJlamVjdGlvbnMgYW5kIGluLXBsYWNlIGVkaXRzXCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7IHNpbmNlOiBwYXJzZWQudmFsdWVzLnNpbmNlIH0pO1xuICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5nZXM/JHtwYXJhbXN9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaW5ib3VuZCA9IHBhcnNlZC52YWx1ZXMuaW5ib3VuZCA9PT0gdHJ1ZTtcbiAgY29uc3Qgb25jZSA9IHBhcnNlZC52YWx1ZXMub25jZSA9PT0gdHJ1ZTtcbiAgLy8gQSBib29rbWFyaywgYE5gIG9yIGBOQDxlcG9jaD5gIGFzIHRoZSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0XG4gIC8vIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBEMikuIEEgZm9ybSBpdCBkb2VzIG5vdCBhY2NlcHQgaXMgcmVmdXNlZCB3aXRoXG4gIC8vIHRoZSBhY2NlcHRlZCBmb3JtcyBuYW1lZCDigJQgcmVhZCBCRUZPUkUgdGhlIGRhZW1vbiBjaGVjaywgc28gdGhlIGFuc3dlclxuICAvLyBkb2VzIG5vdCBkZXBlbmQgb24gd2hldGhlciBvbmUgaXMgdXAuXG4gIGNvbnN0IHJlYWQgPVxuICAgIHR5cGVvZiBwYXJzZWQudmFsdWVzLnNpbmNlID09PSBcInN0cmluZ1wiXG4gICAgICA/IHJlYWRTaW5jZShwYXJzZWQudmFsdWVzLnNpbmNlLCB7IGVwb2NoOiB0cnVlIH0pXG4gICAgICA6IG51bGw7XG4gIGlmIChyZWFkICE9PSBudWxsICYmICFyZWFkLm9rKSB0aHJvdyB1c2FnZUVycm9yKHJlYWQubWVzc2FnZSk7XG4gIGNvbnN0IG1hcmsgPSByZWFkPy5vayA/IHJlYWQgOiBudWxsO1xuICBjb25zdCBzaW5jZSA9IG1hcms/LnNpbmNlID8/IE51bWJlci5OYU47XG4gIHJlcXVpcmVEYWVtb24oKTsgLy8gbm8gZGFlbW9uIGF0IHN0YXJ0IGlzIGEgdXNhZ2UgZXJyb3I7IG1pZC10YWlsIGRlYXRoIGlzIHNlbGYtaGVhbGVkIGJlbG93XG4gIC8vIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBBMykuXG4gIGNvbnN0IHNpbmNlR2l2ZW4gPSBwYXJzZWQudmFsdWVzLnNpbmNlICE9PSB1bmRlZmluZWQ7XG4gIC8vIFRoZSBzZXJ2ZXIgKHJlLSllbWl0cyBhIGdyb3VuZGluZyBmcmFtZSBhdCB0aGUgdG9wIG9mIEVWRVJZIGluYm91bmQgU1NFXG4gIC8vIGNvbm5lY3Q7IGZvcndhcmQgb25seSB0aGUgRklSU1Qgc28gdGhlIGFnZW50J3MgTW9uaXRvciBzZWVzIGV4YWN0bHkgb25lXG4gIC8vIGdyb3VuZGluZyBsaW5lLCBub3Qgb25lIHBlciByZWNvbm5lY3QgKEY1OiBmaXJzdC1jb25uZWN0IGxpbmUpLlxuICAvL1xuICAvLyDim5QgVEhFIFNVUFBSRVNTSU9OJ1MgU1RBVEUgTElWRVMgSU4gVEhJUyBDTE9TVVJFLCBPVVRTSURFIFRIRSBUSElORyBUSEFUXG4gIC8vIE9XTlMgVEhFIFJFQ09OTkVDVFMsIEFORCBUSEFUIElTIFRIRSBPTkUgSE9ORVNUIEdBUCBJTiBUSElTIEFET1BUSU9OLlxuICAvLyBgcmVuZGVyYCBpcyBhIGNhbGxlci13cml0dGVuIGNsb3N1cmUsIHNvIGBncm91bmRlZGAgc3Vydml2ZXMgdGhlXG4gIC8vIHJlY29ubmVjdHMgYHRhaWxFdmVudHNgIHBlcmZvcm1zIOKAlCB3aGljaCBpcyBleGFjdGx5IHdoeSBpdCBXT1JLUywgYW5kIGFsc29cbiAgLy8gd2h5IG5vdGhpbmcgaW4gdGhlIGtpdCBndWFyYW50ZWVzIGl0OiB0aGVyZSBpcyBubyBkZWRpY2F0ZWRcbiAgLy8gZmlyc3QtZnJhbWUtb25jZSBhZmZvcmRhbmNlIGFuZCBubyB3b3JrZWQgZXhhbXBsZSBvZiBvbmUsIGFuZCBhIGZ1dHVyZVxuICAvLyBjaGFuZ2UgdG8gd2hlbiBgdGFpbEV2ZW50c2AgcmUtaW52b2tlcyBpdHMgaG9va3Mgd291bGQgbW92ZSB0aGlzXG4gIC8vIGJlaGF2aW91ciB3aXRob3V0IHRvdWNoaW5nIHRoaXMgZmlsZS4gVGhlIGFsdGVybmF0aXZlIHdhcyBhc2tpbmcgdGhlIGtpdFxuICAvLyBmb3IgYSBgZmlyc3RGcmFtZU9uY2VgIG9wdGlvbiwgd2hpY2ggaXMgYSB3aWRlbmluZyBmb3IgYSBjbG9zdXJlIHRoZVxuICAvLyBjYWxsZXIgY2FuIHdyaXRlIGluIHRocmVlIGxpbmVzIChEODIncyBub3QtdGFrZW4pLlxuICBsZXQgZ3JvdW5kZWQgPSBzaW5jZUdpdmVuO1xuXG4gIC8vIOKblCBPTkUgQ0FMTCBJTlRPIFRIRSBIT1VTRSdTIFNIQVJFRCBUQUlMIENMSUVOVFxuICAvLyAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIFJFUExBQ0lORyBBIEhBTkQtUk9MTEVEXG4gIC8vIFRIUkVFLUxFVkVMIExPT1Ag4oCUIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGwgdGhhdCBtb2R1bGUncyBvd25cbiAgLy8gY29uc3RhbnQtYmFja29mZiB3YXJuaW5nIHdhcyB3cml0dGVuIGFib3V0OiB0aGUgbG9vcCBiZWxvdyB1c2VkIHRvIHNsZWVwXG4gIC8vIGByZXRyeU1zYCBhZnRlciBFVkVSWSBmYWlsZWQgYXR0ZW1wdCwgZmxhdCwgZm9yZXZlciwgd2hpY2ggaXMgYVxuICAvLyByZWNvbm5lY3Qgc3Rvcm0gcmF0aGVyIHRoYW4gYSBiYWNrb2ZmLiBXaGF0IHRoZSBzd2FwIGNsb3NlcyBoZXJlLCBub25lIG9mXG4gIC8vIGl0IGJ5IGFueW9uZSBlZGl0aW5nIGl0OlxuICAvL1xuICAvLyAgIMK3IEJBQ0tPRkYuIDEsMDAwIG1zIGZsYXQgYmVjb21lcyAxLDAwMCDCtyAyLDAwMCDCtyA0LDAwMCDCtyA1LDAwMCDCtyA1LDAwMCxcbiAgLy8gICAgIHJlc2V0IG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBEcml2ZW4gb24gZ2xhbW91ciBiZWZvcmUgYW5kIGFmdGVyXG4gIC8vICAgICBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgZHJvcHM6IDUxIGF0dGVtcHRzIGluXG4gIC8vICAgICAxNCBzIGF0IGEgZmxhdCB+MjUyIG1zIGJlY2FtZSA2IGF0dGVtcHRzIGF0IDI1MiDCtyA1MDMgwrcgMTAwMSDCtyAyMDAyIMK3XG4gIC8vICAgICA0MDAyLlxuICAvLyAgIMK3IFRIRSBTUEVDLiBUaGUgaGFuZC1yb2xsZWQgZnJhbWUgcGFyc2VyIG1hdGNoZWQgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgXG4gIC8vICAgICBhbmQga2VwdCBvbmx5IHRoZSBGSVJTVCBkYXRhIGxpbmUsIHNvIGEgc3BlYy1sZWdhbCBgZGF0YTp7Li4ufWAgd2FzXG4gIC8vICAgICBzaWxlbnRseSBEUk9QUEVEICoqYW5kIHRoZSBjdXJzb3IgZGlkIG5vdCBhZHZhbmNlKiog4oCUIGEgZnJhbWUgbm9ib2R5XG4gIC8vICAgICBjYW4gcmVhZCBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgLy8gICAgIFRoZSBraXQgc3BsaXRzIGF0IHRoZSBmaXJzdCBjb2xvbiBhbmQgc3RyaXBzIGF0IG1vc3Qgb25lIHNwYWNlLCBwZXJcbiAgLy8gICAgIFdIQVRXRywgd2hpY2ggaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGggZXZlcnkgaG91c2VcbiAgLy8gICAgIGRhZW1vbi5cbiAgLy8gICDCtyBUSEUgU0lHTkFMIEhBTkRMRVJTLiBUaGVyZSB3ZXJlIG5vbmUuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhXG4gIC8vICAgICByZWFkZXIgbm93IGVuZHMgdGhlIHdhdGNoIGJ5IFJFVFVSTklORywgc28gdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dFxuICAvLyAgICAgZmlyc3Qg4oCUIHRoZSBoYWxmIG9mIHRoZSBQMGYgZHJhaW4gZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gIC8vICAgwrcgVEhFIEVYSVQgQ09ERSBDUk9TU0VTIFRIRSBMT09QUy4gVGhlIGNsaWVudCBSRVRVUk5TIGEgY29kZSBpbnN0ZWFkIG9mXG4gIC8vICAgICBlbmRpbmcgdGhlIHByb2Nlc3MgZnJvbSBpbnNpZGUgdGhyZWUgbmVzdGVkIGxvb3BzLCB3aGljaCBpcyB3aGF0XG4gIC8vICAgICByZXRpcmVzIHRoZSBwZXItc2l0ZSBxdWVzdGlvbiBvZiB3aGV0aGVyIGEgYHJldHVybmAgZXNjYXBlcyB0aGVtIGFsbC5cbiAgLy9cbiAgLy8g4pqgIEFORCBgaWRsZU1zYC9gcmV0cnlgIEFSRSBERVJJVkVELCBOT1QgQ09QSUVEIChCOCdzIG9uZSB1bmNvcHlhYmxlIHJ1bGUpLlxuICAvLyBUaGV5IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB0aGUgc2VhbSBmaWxlIGJvdGggaGFsdmVzIGltcG9ydCwgd2hlcmVcbiAgLy8gdGhlIHdhdGNoZG9nIGlzIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCDigJQgdGhyZWUgb2YgVEhJUyBkYWVtb24nc1xuICAvLyBiZWF0cywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcyDigJQgYW5kIHdoZXJlIHRoZSB0d28gZW52IGtub2JzIHRoaXNcbiAgLy8gc3BlbGwncyBvd24gdGFpbCBzdWl0ZSBkcml2ZXMgYXJlIHJlc29sdmVkIChENzUpLiBUaGUgbnVtYmVyIGlzIDQ1LDAwMCBhdFxuICAvLyB0aGUgZGVmYXVsdCwgd2hpY2ggaXMgd2hhdCB0aGlzIGZpbGUgaGFyZC1jb2RlZDsgdGhlIEVYUFJFU1NJT04gaXMgd2hhdFxuICAvLyBjaGFuZ2VkLlxuICAvL1xuICAvLyDim5QgQU5EIFRIRSBRVUlFVCBIQU5ET0ZGLCBMSUtFIFRIRSBTRVNTSU9OIFNQRUxMUyAoQ29sZSdzIHJ1bGluZyxcbiAgLy8gMjAyNi0wOS0yNDsgYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCwgXCJNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTlxuICAvLyBTUEVMTFNcIikuIEEgcXVpZXQgd2luZG93IG5hbWVzIGEgYmFja2dyb3VuZCBgLS1vbmNlYDsgYSB3b2tlbiBvbmUtc2hvdFxuICAvLyBuYW1lcyBNb25pdG9yOyBhIGRhZW1vbiB0aGF0IGRpZWQgbmFtZXMgYG9wZW4gLS1uby1vcGVuYC4gVGhlIHRhaWwnc1xuICAvLyBzdG9wLXN0YXJ0IGlzIHdoYXQgdGhlIGRhZW1vbidzIHByZXNlbmNlIExJTkdFUiAoYHNlcnZlci50c2AsXG4gIC8vIGBhZGp1c3RBZ2VudHNgKSBleGlzdHMgdG8gaGlkZSBmcm9tIHRoZSBodW1hbi5cbiAgLy9cbiAgLy8g4pqgIFRIRSBMQVNUIFVSTCBJUyBLRVBULCBzbyBhIGRlYWQgZGFlbW9uIGlzIExPU1QgcmF0aGVyIHRoYW4gdW5yZXNvbHZlZC5cbiAgLy8gYGxpdmVQb3J0KClgIGFuc3dlcnMgbnVsbCBvbmNlIHRoZSBkYWVtb24ncyBwaWQgaXMgZGVhZCwgYW5kIGFuXG4gIC8vIHVucmVzb2x2ZWQgdGFpbCByZXRyaWVzIGZvcmV2ZXIg4oCUIGEgYC0tb25jZWAgd291bGQgc2xlZXAgZm9yIGdvb2QgYW5kIGFcbiAgLy8gTW9uaXRvciB3YXRjaCB3b3VsZCBuZXZlciBoZWFyIGl0LiBBc2tpbmcgdGhlIGxhc3QgcG9ydCBpbnN0ZWFkIGdldHNcbiAgLy8gcmVmdXNlZCwgYW5kIHRoZSBraXQncyBsb3N0IHJ1bGUgZW5kcyB0aGUgdGFpbCB3aXRoIHRoZSB3YXkgYmFjay4gQSBsaXZlXG4gIC8vIGRhZW1vbiBvbiBhIE5FVyBwb3J0IChzb21lb25lIHJhbiBgb3BlbmAgYWdhaW4pIGlzIHN0aWxsIGZvdW5kIGZpcnN0LlxuICBsZXQgbGFzdFVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHJldHVybiBhd2FpdCB0YWlsV2l0aEhhbmRvZmY8eyBpZD86IHVua25vd247IGVwb2NoPzogdW5rbm93bjsga2luZD86IHVua25vd24gfT4oXG4gICAge1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBwb3J0ID0gbGl2ZVBvcnQoKTtcbiAgICAgICAgaWYgKHBvcnQgIT09IG51bGwpIGxhc3RVcmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YDtcbiAgICAgICAgcmV0dXJuIGxhc3RVcmw7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZTogTnVtYmVyLmlzRmluaXRlKHNpbmNlKSA/IHNpbmNlIDogMCxcbiAgICAgIC4uLihtYXJrPy5lcG9jaCA/IHsgc2luY2VFcG9jaDogbWFyay5lcG9jaCB9IDoge30pLFxuICAgICAgcXVlcnk6IChjdXJzb3IpID0+ICh7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgICAgLi4uKHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IHsgcHJvamVjdDogcGFyc2VkLnZhbHVlcy5wcm9qZWN0IGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAuLi4oaW5ib3VuZCA/IHsgaW5ib3VuZDogXCIxXCIgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLy8g4puUIGBpZGAsIE5PVCBgc2VxYCDigJQgdGhlIGRhZW1vbidzIGVudmVsb3BlIGZpZWxkIHdhcyByZW5hbWVkIGJ5IHRoZVxuICAgICAgLy8gYGNyZWF0ZUV2ZW50TG9nYCBhZG9wdGlvbiAoRDgxKSwgYW5kIHRoaXMgaXMgdGhlIENMSS1zaWRlIHJlYWRlciBvZiBpdC5cbiAgICAgIC8vIOKaoCBUaGUgQ0xJIGhhbGYgRk9SQ0VEIG5vdGhpbmc6IGBjdXJzb3JPZmAgaXMgY2FsbGVyLXN1cHBsaWVkLCBzb1xuICAgICAgLy8gYChldikgPT4gZXYuc2VxYCB3b3VsZCBoYXZlIGNvbXBpbGVkIGFuZCBydW4uIEl0IHdvdWxkIGFsc28gaGF2ZSByZWFkIGFcbiAgICAgIC8vIGZpZWxkIHRoZSBkYWVtb24gbm8gbG9uZ2VyIGVtaXRzLCBzbyB0aGUgY3Vyc29yIHdvdWxkIG5ldmVyIGFkdmFuY2UgYW5kXG4gICAgICAvLyBldmVyeSByZWNvbm5lY3Qgd291bGQgcmUtcmVxdWVzdCBgc2luY2U9MGAg4oCUIHRoZSB3aG9sZSByZXBsYXkgd2luZG93XG4gICAgICAvLyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgc2lsZW50bHksIGZvcmV2ZXIuICoqQSBjYWxsZXItc3VwcGxpZWQgYWNjZXNzb3IgaXNcbiAgICAgIC8vIHdoZXJlIGEgd2lyZSByZW5hbWUgZ29lcyB3cm9uZyBxdWlldGx5LioqXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgICAgZXBvY2hPZjogKGV2KSA9PiAodHlwZW9mIGV2LmVwb2NoID09PSBcInN0cmluZ1wiID8gZXYuZXBvY2ggOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSByZWNvbm5lY3QgdGhhdCBsYW5kcyBvbiBhIGRpZmZlcmVudCBlcG9jaCBtZWFucyB0aGUgZGFlbW9uIHJlc3RhcnRlZDpcbiAgICAgIC8vIHRoZSBraXQgcmVzZXRzIHRoZSBjdXJzb3IgdG8gMCBhbmQgdGhpcyBsaW5lIHRlbGxzIHRoZSBjYXN0aW5nIGFnZW50IHRvXG4gICAgICAvLyByZWZldGNoIHN0YXRlLiBDTEktc3ludGhlc2l6ZWQgb25seSwgbmV2ZXIgYSBidXMgZXZlbnQgKHRoZSBicm93c2VyIFdTXG4gICAgICAvLyBuZXZlciBzZWVzIGl0KSwgYW5kIGl0IGNhcnJpZXMgbm8gYGlkYCDigJQgc28gaXQgbmV2ZXIgYWR2YW5jZXMgdGhlXG4gICAgICAvLyBjdXJzb3IsIHdoaWNoIGlzIHRoZSBzYW1lIHNlcGFyYXRpb24gdGhlIGdyb3VuZGluZyBsaW5lIG1ha2VzLlxuICAgICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IGtpbmQ6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICAgIC8vIEdyb3VuZGluZyBpcyBhIHN5bnRoZXRpYywgaWQtbGVzcyBmaXJzdC1jb25uZWN0IGZyYW1lOiBmb3J3YXJkIHRoZVxuICAgICAgLy8gZmlyc3QsIHN1cHByZXNzIHJlLWdyb3VuZGluZ3Mgb24gcmVjb25uZWN0IChleGFjdGx5IG9uZSBwZXIgcHJvY2VzcykuXG4gICAgICAvLyBSZXR1cm5pbmcgbnVsbCB3cml0ZXMgbm90aGluZzsgaXQgbmV2ZXIgY2FycmllcyBpZC9lcG9jaCwgc28gdGhlXG4gICAgICAvLyBjdXJzb3IgYW5kIHRoZSBlcG9jaCBhcmUgdW50b3VjaGVkIGVpdGhlciB3YXkuXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGV2LmtpbmQgPT09IFwiZ3JvdW5kaW5nXCIpIHtcbiAgICAgICAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZnJhbWUuZGF0YTtcbiAgICAgIH0sXG4gICAgICAvLyBBIHJlZnVzZWQgY29ubmVjdGlvbiAoNDA5IG5lZWRzLXByb2plY3Qgb24gYSBwcm9qZWN0bGVzcyBzdG9yZSwgNDA0XG4gICAgICAvLyB1bmtub3duIHByb2plY3QpIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIHRyYW5zcG9ydCBibGlwIOKAlCByZXRyeWluZyBpdFxuICAgICAgLy8gZm9yZXZlciB3b3VsZCBqdXN0IHNwaW4gc2lsZW50bHkuIGBwYXNzT3JUaHJvd2AgYWx3YXlzIHRocm93cyBoZXJlLCBhbmRcbiAgICAgIC8vIHRoZSB0aHJvdyBwcm9wYWdhdGVzIG91dCBvZiB0aGUgY2xpZW50IGludG8gYG1haW5gJ3MgY2F0Y2gsIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIHJhaXNlIHJlYWNoYWJsZSBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLlxuICAgICAgLy8gQW5ub3RhdGVkOiBhbiBhc3luYyBhcnJvdydzIGByZXR1cm4gXCJyZXRyeVwiYCB3aWRlbnMgdG8gYFByb21pc2U8c3RyaW5nPmBcbiAgICAgIC8vIHVubGVzcyB0aGUgcmV0dXJuIHR5cGUgaXMgc3RhdGVkLCBhbmQgdGhlIGNsaWVudCBhY2NlcHRzIG9ubHkgdGhlXG4gICAgICAvLyBsaXRlcmFsICh0eXBlLWRlYnQgVDM2KS5cbiAgICAgIG9uSHR0cEVycm9yOiBhc3luYyAocmVzKTogUHJvbWlzZTxcInJldHJ5XCI+ID0+IHtcbiAgICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwOSB8fCByZXMuc3RhdHVzID09PSA0MDQpIGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gICAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgICB9LFxuICAgICAgLy8g4puUIFRIRSBVTlBBUlNFQUJMRSBMSU5FIEdPRVMgVE8gU1RET1VULCBXSElDSCBJUyBUSElTIFNQRUxMJ1MgT1dOXG4gICAgICAvLyBCRUhBVklPVVIgQU5EIFRIRSBPTkUgVEhFIEtJVCdTIERFRkFVTFQgV09VTEQgSEFWRSBDSEFOR0VELiBUaGVcbiAgICAgIC8vIGhhbmQtcm9sbGVkIGxvb3AgY2F1Z2h0IHRoZSBgSlNPTi5wYXJzZWAgYW5kIHBhc3NlZCB0aGUgcmF3IGxpbmVcbiAgICAgIC8vIHRocm91Z2ggdW50cmFja2VkOyB0aGUga2l0J3MgYG9uTWFsZm9ybWVkYCByZXR1cm4gdmFsdWUgZ29lcyB0byBgZXJyYFxuICAgICAgLy8gaW5zdGVhZCwgYmVjYXVzZSBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSBpcyBub3QgZGF0YS4gbWluZC1tYXBwZXJcbiAgICAgIC8vIGlzIHRoZSBcIm9uZSBzcGVsbFwiIHRoYXQgbW9kdWxlJ3MgaGVhZGVyIG5hbWVzIGFzIGdlbnVpbmVseSB3YW50aW5nIGl0IG9uXG4gICAgICAvLyBzdGRvdXQsIGFuZCB0aGUgd2F5IHRvIGtlZXAgdGhhdCBpcyB0byB3cml0ZSBpdCBmcm9tIGluc2lkZSB0aGUgaG9vayBhbmRcbiAgICAgIC8vIHJldHVybiBudWxsLlxuICAgICAgb25NYWxmb3JtZWQ6IChmcmFtZSkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtmcmFtZS5kYXRhfVxcbmApO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICAgIHJldHJ5OiB7IGluaXRpYWxNczogVEFJTF9SRVRSWV9NUywgbWF4TXM6IFRBSUxfUkVUUllfTUFYX01TIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJtaW5kLW1hcHBlclwiLFxuICAgICAgbW9kZTogb25jZSA/IFwib25jZVwiIDogXCJ3YXRjaFwiLFxuICAgICAgcHJlc2VuY2U6IGZhbHNlLFxuICAgICAgLy8g4puUIGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBPTiBUSEUgTE9HIEFORCBJUyBOT1QgQ09VTlRFRC4gVGhlIGRhZW1vblxuICAgICAgLy8gZW1pdHMgaXQsIHdpdGggYSBsb2cgaWQsIHdoZW4gYSB0YWlsIG9wZW5zIG9yIChwYXN0IHRoZSBsaW5nZXIpIHRoZVxuICAgICAgLy8gbGFzdCBvbmUgY2xvc2VzIOKAlCBzbyBhIHRhaWwncyBPV04gY29ubmVjdCBsYW5kcyBvbiBpdHMgb3duIHN0cmVhbS5cbiAgICAgIC8vIENvdW50ZWQsIGV2ZXJ5IHdpbmRvdyB3b3VsZCBiZSBcImFjdGl2ZVwiIGFuZCBldmVyeSBgLS1vbmNlYCB3b3VsZCB3YWtlXG4gICAgICAvLyBvbiBpdHNlbGYgYXQgb25jZS4gSXQgaXMgY2h1cm4sIG5vdCBhbiBhY3QgdG8gYW5zd2VyLiAoVGhlIGdyb3VuZGluZ1xuICAgICAgLy8gZnJhbWUgY2FycmllcyBubyBsb2cgaWQsIHNvIEQzJ3MgcnVsZSBhbHJlYWR5IGxlYXZlcyBpdCBvdXQuKVxuICAgICAgY291bnRzOiAoZXYpID0+IGV2LmtpbmQgIT09IFwicHJlc2VuY2UuY2hhbmdlZFwiLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2U6IGF0LCBvbmNlOiBuZXh0T25jZSwgZXBvY2ggfSkgPT5cbiAgICAgICAgICB0YWlsQ29tbWFuZChcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgXCJ0YWlsXCIsXG4gICAgICAgICAgICAgIC4uLihpbmJvdW5kID8gW1wiLS1pbmJvdW5kXCJdIDogW10pLFxuICAgICAgICAgICAgICAuLi4ocGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gW1wiLS1wcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCBhcyBzdHJpbmddIDogW10pLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGF0LFxuICAgICAgICAgICAgbmV4dE9uY2UsXG4gICAgICAgICAgICBlcG9jaCxcbiAgICAgICAgICApLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb2plY3RzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuY3JlYXRlKSB7XG4gICAgY29uc3QgdGl0bGUgPSBwYXJzZWQudmFsdWVzLmNyZWF0ZTtcbiAgICBjb25zdCBpZCA9IHRpdGxlXG4gICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb2plY3RzYCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgaWQsIHRpdGxlIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2ApO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5nZXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFwYXJzZWQudmFsdWVzLnRpdGxlKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcImluZ2VzdCByZXF1aXJlcyAtLXRpdGxlXCIpO1xuICB9XG4gIGlmICghcGFyc2VkLnZhbHVlcy5maWxlICYmICFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcImluZ2VzdCByZXF1aXJlcyAtLWZpbGUgPHBhdGg+IG9yIC0tc3RkaW5cIik7XG4gIH1cbiAgY29uc3QgdGV4dCA9IHBhcnNlZC52YWx1ZXMuZmlsZVxuICAgID8gcmVhZEZpbGVTeW5jKHBhcnNlZC52YWx1ZXMuZmlsZSwgXCJ1dGY4XCIpXG4gICAgOiBhd2FpdCBCdW4uc3RkaW4udGV4dCgpO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2luZ2VzdCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB0aXRsZTogcGFyc2VkLnZhbHVlcy50aXRsZSwgdGV4dCB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQcm9wb3NlKHZlcmI6IFwicHJvcG9zZS1ub2RlXCIgfCBcInByb3Bvc2UtZWRnZVwiLCBwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghcGFyc2VkLnZhbHVlcy5zdGRpbikge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBgJHt2ZXJifSByZXF1aXJlcyAtLXN0ZGluIEpTT04ge2RyYWZ0LCBldmlkZW5jZVssIHN1Z2dlc3RlZFRpZXIsIGF1dGhvciwgdGFncywgYmF0Y2hJZF19YCxcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICAncHJvcG9zZS1lZGdlIGVuZHBvaW50czogYSBub2RlIGlkLCBhIHBlbmRpbmcgbm9kZS1wcm9wb3NhbCBpZCwgb3IgXCJ0aXRsZTo8ZXhhY3Qgbm9kZSB0aXRsZT5cIiAnICtcbiAgICAgICAgICBcIih0aXRsZSByZWZzIHJlc29sdmUgYXQgSU5UQUtFIGFnYWluc3QgcmF0aWZpZWQgbm9kZXMgb25seSwgZXhhY3QgKyBjYXNlLXNlbnNpdGl2ZTsgXCIgK1xuICAgICAgICAgIFwiYW4gYW1iaWd1b3VzIHRpdGxlIGVycm9ycyBhbmQgbmFtZXMgZXZlcnkgY2FuZGlkYXRlIGlkKVwiLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7XG4gICAgZHJhZnQ6IHVua25vd247XG4gICAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgICBzdWdnZXN0ZWRUaWVyPzogc3RyaW5nO1xuICAgIGF1dGhvcj86IHN0cmluZztcbiAgICAvLyBSb3VuZCA3IChUQUdTKTogcHJvcG9zZS10aW1lIHRhZ3MgcmlkZSB0aGUgc3RkaW4gSlNPTiDigJQgbXVzdCBiZVxuICAgIC8vIGZvcndhcmRlZCBpbnRvIHRoZSBQT1NUIGJvZHksIG9yIHRoZSAvcHJvcG9zYWxzIHJvdXRlIG5ldmVyIHNlZXMgdGhlbVxuICAgIC8vICh0aGUgYmF0Y2ggcGF0aCBmb3J3YXJkcyBpdHMgbm9kZSB0YWdzOyB0aGUgc2luZ2xlIHZlcmIgbXVzdCB0b28pLlxuICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAvLyBSb3VuZCAxMiAoU0VBTSAxKTogam9pbiBhbiBleGlzdGluZyBzdGFnaW5nIGFjdCAoZnJvbSBwcm9wb3NlLWJhdGNoKS5cbiAgICBiYXRjaElkPzogc3RyaW5nO1xuICB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2FscyR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAga2luZDogdmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiA/IFwibm9kZVwiIDogXCJlZGdlXCIsXG4gICAgICBkcmFmdDogaW5wdXQuZHJhZnQsXG4gICAgICBldmlkZW5jZTogaW5wdXQuZXZpZGVuY2UgPz8ge30sXG4gICAgICBzdWdnZXN0ZWRUaWVyOiBpbnB1dC5zdWdnZXN0ZWRUaWVyLFxuICAgICAgYXV0aG9yOiBpbnB1dC5hdXRob3IsXG4gICAgICAvLyAtLXpvbmUgc3RhZ2VzIHRoZSBwcm9wb3NhbCBpbiBhIHpvbmUgKGZsYWcgd2luczsgdGhlIHN0ZGluIEpTT05cbiAgICAgIC8vIHN0YXlzIHRoZSBkcmFmdC9ldmlkZW5jZSBzaGFwZSDigJQgem9uZSBpcyByb3V0aW5nLCBub3QgY29udGVudCkuXG4gICAgICB6b25lOiBwYXJzZWQudmFsdWVzLnpvbmUsXG4gICAgICAvLyBUQUdTOiBmb3J3YXJkIHRoZSBzdGRpbiB0YWdzICh0aGUgcm91dGUgdmFsaWRhdGVzIHRoZSBzaGFwZSkuXG4gICAgICB0YWdzOiBpbnB1dC50YWdzLFxuICAgICAgLy8gU0VBTSAxOiBmb3J3YXJkIHRoZSBzdGRpbiBiYXRjaElkICh0aGUgYm9keS1taXJyb3IgZGlzY2lwbGluZSDigJQgYVxuICAgICAgLy8gZmllbGQgYWRkZWQgdG8gdGhlIHNoYXJlZCAvcHJvcG9zYWxzIGJvZHkgbXVzdCBiZSB0aHJlYWRlZCBpbnRvIEVWRVJZXG4gICAgICAvLyBDTEkgdmVyYiB0aGF0IHBvc3RzIHRvIGl0OyB0aGUgcHJvcG9zZS1ub2RlLXRhZ3Mgc2NhcikuXG4gICAgICBiYXRjaElkOiBpbnB1dC5iYXRjaElkLFxuICAgIH0pLFxuICB9KTtcbiAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVzcG9uc2VUZXh0fVxcbmApO1xuICAvLyBNaXJyb3IgdGhlIGRhZW1vbidzIGFkZGl0aXZlIGVkZ2UtZHJhZnQgd2FybmluZyB0byBzdGRlcnIg4oCUIGEgY29sZFxuICAvLyBhZ2VudCBzY2FubmluZyBmb3IgcHJvYmxlbXMgc2VlcyBpdCBldmVuIGlmIGl0IGRvZXNuJ3QgcGFyc2Ugc3Rkb3V0LlxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLWVkZ2VcIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gICAgfVxuICB9XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQcm9wb3NlQmF0Y2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJwcm9wb3NlLWJhdGNoIHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCBzdWdnZXN0ZWRUaWVyPywgZXZpZGVuY2U/fV0sIGVkZ2VzOlt7ZHJhZnQ6e3NvdXJjZSwgdGFyZ2V0LCBsYWJlbD99fV19XCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgXCJhbiBlZGdlIGVuZHBvaW50IG1heSBiZSBhIG5vZGUgTE9DQUwgUkVGIChtYXRjaGVzIGEgbm9kZSdzIHJlZiBpbiB0aGlzIGJhdGNoKSwgXCIgK1xuICAgICAgICAgICdhIHJlYWwgbm9kZSBpZCwgYSBwZW5kaW5nIHByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIOKAlCBsb2NhbCByZWZzICcgK1xuICAgICAgICAgIFwicmVzb2x2ZSB0byBtaW50ZWQgaWRzIGFuZCB0aXRsZSByZWZzIHRvIHJhdGlmaWVkIG5vZGUgaWRzLCBib3RoIHNlcnZlci1zaWRlOyBcIiArXG4gICAgICAgICAgXCJvcHRpb25hbCBiYXRjaElkOiBvbWl0IGFuZCBvbmUgaXMgTUlOVEVEICsgcmV0dXJuZWQ7IHN1cHBseSBvbmUgdG8gZXh0ZW5kIHRoYXQgYWN0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICBub2Rlcz86IHVua25vd247XG4gICAgZWRnZXM/OiB1bmtub3duO1xuICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy9iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbm9kZXM6IGlucHV0Lm5vZGVzID8/IFtdLFxuICAgICAgZWRnZXM6IGlucHV0LmVkZ2VzID8/IFtdLFxuICAgICAgLy8gU0VBTSAxOiBvbWl0dGVkIOKGkiB0aGUgZGFlbW9uIG1pbnRzIGEgYmF0Y2hJZCBhbmQgcmV0dXJucyBpdDsgc3VwcGxpZWRcbiAgICAgIC8vIOKGkiB0aGlzIGNhbGwgam9pbnMgdGhhdCBhY3QgKHRoZSBcIkkgZm9yZ290IHRoZSBlZGdlc1wiIHJlcGFpcikuXG4gICAgICBiYXRjaElkOiBpbnB1dC5iYXRjaElkLFxuICAgIH0pLFxuICB9KTtcbiAgLy8gUmVzcG9uc2UgY2FycmllcyB7YmF0Y2hJZCwgcmVmVG9JZDogezxyZWY+OiA8bWludGVkSWQ+fSwgcHJvcG9zYWxzOiBbLi4uXX1cbiAgLy8g4oCUIHRoZSByZWbihpJpZCBtYXAgaXMgdGhlIHBvaW50IGZvciBUSElTIGNhbGwsIGFuZCBiYXRjaElkIGlzIHRoZSBwb2ludCBmb3JcbiAgLy8gZXZlcnkgbGF0ZXIgb25lIChgc3RhdGUgLS1iYXRjaCA8aWQ+YCByZWNvbmNpbGVzIGEgcGFydGlhbCByYXRpZmljYXRpb24pLlxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmF0aWZ5QmF0Y2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgJ3JhdGlmeS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge3J1bGluZzogXCJjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWxcIiwgaWRzOiBbcHJvcG9zYWxJZF0sIGFuY2hvcnM/OiBbe25vZGUsIHBhcmVudH1dfScsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgXCJyYXRpZmllcyB0aGUgc2V0IGluIE9ORSBjYWxsL3R4bjsgbm9kZXMgcmF0aWZ5IGJlZm9yZSBlZGdlcyAoYXV0by1wYXJ0aXRpb25lZCksIFwiICtcbiAgICAgICAgICBcImVkZ2UgZW5kcG9pbnRzICsgYW5jaG9yIHJlZnMgcmVzb2x2ZSBvbGQgcHJvcG9zYWwgaWRzIOKGkiBtaW50ZWQgbm9kZSBpZHMgdmlhIHRoZSBcIiArXG4gICAgICAgICAgXCJyZXR1cm5lZCBpZE1hcC4gTk8gYXV0by1pbmNsdWRlIG9mIHVubGlzdGVkIGVkZ2VzOyByZWplY3QgaXMgbm90IGEgYmF0Y2ggYWN0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICBydWxpbmc/OiB1bmtub3duO1xuICAgIGlkcz86IHVua25vd247XG4gICAgYW5jaG9ycz86IHVua25vd247XG4gIH07XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL3JhdGlmeS1iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsaW5nOiBpbnB1dC5ydWxpbmcsXG4gICAgICBpZHM6IGlucHV0LmlkcyA/PyBbXSxcbiAgICAgIGFuY2hvcnM6IGlucHV0LmFuY2hvcnMsXG4gICAgfSksXG4gIH0pO1xuICAvLyBSZXNwb25zZSBjYXJyaWVzIHtpZE1hcDogezxvbGRQcm9wb3NhbElkPjogPG1pbnRlZE5vZGVJZD59LCByYXRpZmllZDpbLi4uXX1cbiAgLy8g4oCUIHRoZSBpZE1hcCBpcyB0aGUgcG9pbnQgKHJlY29ubmVjdCBhbiBlZGdlL2FuY2hvciB0byB0aGUgcmVhbCBub2RlKS5cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDUpIOKAlCB0aGUgaW52ZXJzZSBvZiByYXRpZnktYmF0Y2g6IGNsZWFyIGEgc2V0IG9mIHByb3Bvc2Fsc1xuLy8gaW4gT05FIHRyYW5zYWN0aW9uYWwgY2FsbCBpbnN0ZWFkIG9mIE4gSFRUUCBkZWxldGVzIGluIGEgbG9vcC5cbmFzeW5jIGZ1bmN0aW9uIGNtZERlbGV0ZUJhdGNoKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcignZGVsZXRlLWJhdGNoIHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7aWRzOiBbXCI8cHJvcG9zYWxJZD5cIiwgLi4uXX0nLCB7XG4gICAgICBoaW50OlxuICAgICAgICBcImRlbGV0ZXMgdGhlIHNldCBpbiBPTkUgdHhuIOKAlCBhbGwtb3Itbm90aGluZzogaWYgYW55IGlkIGlzIHVua25vd24sIE5PVEhJTkcgaXMgXCIgK1xuICAgICAgICBcImRlbGV0ZWQgYW5kIHRoZSBlcnJvciBuYW1lcyBldmVyeSB1bmtub3duIGlkLiBUaGVyZSBpcyBkZWxpYmVyYXRlbHkgbm8gXCIgK1xuICAgICAgICBcIntiYXRjaDogPGlkPn0gc2hvcnRoYW5kIOKAlCBydW4gYHN0YXRlIC0tYmF0Y2ggPGlkPmAgYW5kIGxvb2sgYmVmb3JlIHlvdSBzd2VlcCBcIiArXG4gICAgICAgIFwiKGRyaXZlICMxMCdzIGJ1ZyB3YXMgYW4gb3Zlci1icm9hZCBjbGVhbnVwIHRoYXQgdG9vayB0aGUgZWRnZXMgd2l0aCBpdClcIixcbiAgICB9KTtcbiAgfVxuICBjb25zdCBpbnB1dCA9IEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyBpZHM/OiB1bmtub3duIH07XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL2RlbGV0ZS1iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZHM6IGlucHV0LmlkcyA/PyBbXSB9KSxcbiAgfSk7XG4gIGNvbnN0IGRlbGV0ZUJhdGNoQm9keSA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RlbGV0ZUJhdGNoQm9keX1cXG5gKTtcbiAgLy8gUjEyIGdhdGUgZmluZGluZyAxOiBtaXJyb3IgdGhlIHN0cmFuZGVkLW5vZGUgYWR2aXNvcnkgdG8gc3RkZXJyLCB0aGUgc2FtZVxuICAvLyB3YXkgcHJvcG9zZS1lZGdlIG1pcnJvcnMgZWRnZURyYWZ0V2FybmluZyDigJQgYSBjb2xkIGFnZW50IHNjYW5uaW5nIGZvclxuICAvLyBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgbmV2ZXIgcGFyc2VzIHN0ZG91dC4gQWR2aXNvcnksIG5vdCBhIGZhaWx1cmU6XG4gIC8vIHRoZSBleGl0IGNvZGUgaXMgdW5jaGFuZ2VkLlxuICB0cnkge1xuICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShkZWxldGVCYXRjaEJvZHkpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICB9IGNhdGNoIHtcbiAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgfVxuICByZXR1cm4gMDtcbn1cblxuY29uc3QgcHJvamVjdFFzID0gKHBhcnNlZDogUGFyc2VkKTogc3RyaW5nID0+XG4gIHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuXG4vLyBSb3VuZCA2IChERUwpOiBgbm9kZSBkZWxldGUgPGlkPiBbLS1mb3JjZV1gIOKAlCA0MDkge2Vycm9yOlwiY2l0ZWRcIixcbi8vIGNpdGVkQnk6e2VkZ2VzLCBjaGlsZHJlbn19IHdoZW4gY2l0ZWQgYW5kIHVuZm9yY2VkOyAtLWZvcmNlIGNhc2NhZGVzXG4vLyAoZWRnZXMgZ29uZSwgY2hpbGRyZW4gcmUtcGFyZW50ZWQgdG8gdG9wLWxldmVsLCBkZXRyaXR1cyBnb25lKS5cbmFzeW5jIGZ1bmN0aW9uIGNtZE5vZGVEZWxldGUocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuZm9yY2UpIHBhcmFtcy5zZXQoXCJmb3JjZVwiLCBcIjFcIik7XG4gIGNvbnN0IGRxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDQpOiBgbm9kZSBlZGl0IDxpZD4gWy0tdGl0bGUgVF0gWy0tc3lub3BzaXMgU10gfCAtLXN0ZGluYFxuLy8g4oCUIGEgcmF0aWZpZWQgbm9kZSBjYW4gZmluYWxseSBnYWluIGEgc3lub3BzaXMgKEYyKS4gV3JpdGVzIGV4YWN0bHkgd2hhdFxuLy8gaXQgaXMgZ2l2ZW47IHRpZXIgYW5kIGtpbmQgYXJlIE5PVCBlZGl0YWJsZSAoc2VlIGVkaXQudHMgZm9yIHdoeSkuXG5hc3luYyBmdW5jdGlvbiBjbWROb2RlRWRpdChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcGF0Y2g6IHsgdGl0bGU/OiBzdHJpbmc7IHN5bm9wc2lzPzogc3RyaW5nIH0gPSB7fTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAvLyBQcm9zZSBiZWxvbmdzIG9uIHN0ZGluIOKAlCBhIHN5bm9wc2lzIGlzIGEgcGFyYWdyYXBoLCBub3QgYSBmbGFnIHZhbHVlLlxuICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICBwYXRjaCxcbiAgICAgIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyB0aXRsZT86IHN0cmluZzsgc3lub3BzaXM/OiBzdHJpbmcgfSxcbiAgICApO1xuICB9XG4gIGlmIChwYXJzZWQudmFsdWVzLnRpdGxlICE9PSB1bmRlZmluZWQpIHBhdGNoLnRpdGxlID0gcGFyc2VkLnZhbHVlcy50aXRsZTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc3lub3BzaXMgIT09IHVuZGVmaW5lZCkgcGF0Y2guc3lub3BzaXMgPSBwYXJzZWQudmFsdWVzLnN5bm9wc2lzO1xuICBpZiAocGF0Y2gudGl0bGUgPT09IHVuZGVmaW5lZCAmJiBwYXRjaC5zeW5vcHNpcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICd1c2FnZTogY2xpLnRzIG5vZGUgZWRpdCA8bm9kZUlkPiAoLS10aXRsZSA8dD4gfCAtLXN5bm9wc2lzIDxzPiB8IC0tc3RkaW4gXFwne1wic3lub3BzaXNcIjogXCIuLi5cIn1cXCcpJyxcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICBcIndyaXRlcyBleGFjdGx5IHdoYXQgaXQgaXMgZ2l2ZW4gKG5vIGluZmVyZW5jZSk7IG9ubHkgdGl0bGUvc3lub3BzaXMgYXJlIGVkaXRhYmxlIOKAlCBcIiArXG4gICAgICAgICAgXCJ0aWVyIGlzIHRoZSBodW1hbidzIHJ1bGluZyBhbmQga2luZCBpcyBhIHJhdGlmaWNhdGlvbi10aW1lIGNsYXNzaWZpY2F0aW9uXCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9ub2Rlcy8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgLy8gQm9keS1taXJyb3IgZGlzY2lwbGluZTogdGhyZWFkIGV2ZXJ5IGZpZWxkIGV4cGxpY2l0bHkgKHRoZVxuICAgIC8vIHByb3Bvc2Utbm9kZS10YWdzIHNjYXIpIOKAlCBhbiBvbWl0dGVkIGtleSBtdXN0IHN0YXkgb21pdHRlZCBzbyB0aGVcbiAgICAvLyByb3V0ZSBwYXRjaGVzIGluc3RlYWQgb2YgYmxhbmtpbmcuXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgLi4uKHBhdGNoLnRpdGxlICE9PSB1bmRlZmluZWQgPyB7IHRpdGxlOiBwYXRjaC50aXRsZSB9IDoge30pLFxuICAgICAgLi4uKHBhdGNoLnN5bm9wc2lzICE9PSB1bmRlZmluZWQgPyB7IHN5bm9wc2lzOiBwYXRjaC5zeW5vcHNpcyB9IDoge30pLFxuICAgIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogYC0tdG8gPGlkPiB8IC0tY2xlYXJgLCBleGFjdGx5IG9uZSDigJQgYG5vZGUgYW5jaG9yYCBhbmQgYHByb3Bvc2FsIHpvbmVgLiBBXG4gKiBydWxlIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3Qgc3RhdGUgKGl0IHB1Ymxpc2hlcyBib3RoIGZsYWdzIGFzIHZhbGlkKSwgc28gaXRcbiAqIHJpZGVzIHRoZSByb3cncyBgY2hlY2tgIGFuZCBpcyByZWZ1c2VkIGJlZm9yZSB0aGUgaGFuZGxlciBydW5zLlxuICovXG5jb25zdCB0b1hvckNsZWFyID0gKGludjogSW52b2NhdGlvbjxGbGFnPik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gIGNvbnN0IGhhc1RvID0gaW52LmZsYWdzLnRvICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGNsZWFyID0gaW52LmZsYWdzLmNsZWFyID09PSB0cnVlO1xuICBpZiAoaGFzVG8gJiYgY2xlYXIpIHJldHVybiBcImdpdmUgLS10byA8aWQ+IG9yIC0tY2xlYXIsIG5vdCBib3RoXCI7XG4gIGlmICghaGFzVG8gJiYgIWNsZWFyKSByZXR1cm4gXCJnaXZlIC0tdG8gPGlkPiBvciAtLWNsZWFyXCI7XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjbWROb2RlQW5jaG9yKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L25vZGVzLyR7aWR9L2FuY2hvciR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJlbnRJZDogcGFyc2VkLnZhbHVlcy5jbGVhciA/IG51bGwgOiBwYXJzZWQudmFsdWVzLnRvIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYWQocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbWVzc2FnZS8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRab25lQ3JlYXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgbmFtZSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS96b25lcyR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFpvbmVMaXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS96b25lcyR7cHJvamVjdFFzKHBhcnNlZCl9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRab25lRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnllcykgcGFyYW1zLnNldChcInllc1wiLCBcIjFcIik7XG4gIGNvbnN0IGRxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb21vdGUocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzLyR7aWR9L3Byb21vdGUke3Byb2plY3RRcyhwYXJzZWQpfWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb3Bvc2FsWm9uZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vem9uZSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB6b25lSWQ6IHBhcnNlZC52YWx1ZXMuY2xlYXIgPyBudWxsIDogcGFyc2VkLnZhbHVlcy50byB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCA2IChERUwpOiBgcHJvcG9zYWwgZGVsZXRlIDxpZD5gIOKAlCB0aGluLCBubyBndWFyZCAoZHJvcCByb3cgK1xuLy8gY2FzY2FkZSBub2RlX2FjdGlvbnMpLiBUaGUgbGl0dGVyLWNsZWFyaW5nIHBhdGggKGNsZWFyIGEgcmF3XG4vLyBpbnN0cnVjdGlvbi1ub2RlIHRocm91Z2ggREVMRVRFLCBub3QgcmVqZWN0KS5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb3Bvc2FsRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJERUxFVEVcIixcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBgZG9jIDxpZD5gIHJlYWRzIGFuZCBgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXWAgZGVsZXRlcy4gVGhlIGBkb2NgIGdyb3VwXG4vLyBmaW5kcyBpdHMgc3ViLXZlcmIgYXQgdGhlIEZJUlNUIFBPU0lUSU9OQUwsIHNvIGZsYWdzIG1heSBjb21lIGZpcnN0XG4vLyAoYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWApOyBhIGRvYyBsaXRlcmFsbHkgbmFtZWQgXCJkZWxldGVcIiBvclxuLy8gXCJraW5kXCIgaXMgcmVhZCB3aXRoIGBkb2MgLS0gZGVsZXRlYCwgc2luY2UgdGhlIHNjYW4gc3RvcHMgYXQgYSBiYXJlIGAtLWAuXG5hc3luYyBmdW5jdGlvbiBjbWREb2MoaXNEZWxldGU6IGJvb2xlYW4sIHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGlmIChpc0RlbGV0ZSAmJiBwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vZG9jLyR7aWR9JHtxc31gLCB7XG4gICAgbWV0aG9kOiBpc0RlbGV0ZSA/IFwiREVMRVRFXCIgOiBcIkdFVFwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDQgKEsxKTogYGRvYyBraW5kIDxkb2NJZD4gPGtpbmQuLi4+IFstLWF1dGhvciB1c2VyfGFnZW50XWAgc2V0cyxcbi8vIGBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJgIGNsZWFycyAoYXV0aG9yIG51bGxzIHdpdGggaXQpLiBUaGUgaW5nZXN0XG4vLyBkZWZhdWx0cyBkaWVkIOKAlCB0aGlzIHZlcmIgaXMgaG93IGEgZG9jIGdldHMgdHlwZWQgYXQgYWxsLlxuYXN5bmMgZnVuY3Rpb24gY21kRG9jS2luZChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGRvY0lkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3Qga2luZFdvcmRzID0gcGFyc2VkLnBvc2l0aW9uYWxzLnNsaWNlKDEpLmpvaW4oXCIgXCIpO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9raW5kJHtwcm9qZWN0UXMocGFyc2VkKX1gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShcbiAgICAgIHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgICAgPyB7IGtpbmQ6IG51bGwgfVxuICAgICAgICA6IHsga2luZDoga2luZFdvcmRzLCBhdXRob3I6IHBhcnNlZC52YWx1ZXMuYXV0aG9yID8/IFwiYWdlbnRcIiB9LFxuICAgICksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTWFyayhwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGRvY0lkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICBpZiAoIWRvY0lkIHx8ICFwYXJzZWQudmFsdWVzLnN0YXR1cykge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dXCIpO1xuICB9XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vZG9jLyR7ZG9jSWR9L21hcmske3FzfWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGF1dGhvcjogcGFyc2VkLnZhbHVlcy5hdXRob3IgPz8gXCJhZ2VudFwiLFxuICAgICAgbm90ZTogcGFyc2VkLnZhbHVlcy5ub3RlLFxuICAgICAgc3RhdHVzOiBwYXJzZWQudmFsdWVzLnN0YXR1cyxcbiAgICB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTZWFyY2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBxdWVyeSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgaWYgKCFxdWVyeSkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHNlYXJjaCA8cXVlcnkuLi4+XCIpO1xuICB9XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBxOiBxdWVyeSB9KTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zZWFyY2g/JHtwYXJhbXN9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWROZWlnaGJvcnMocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFpZCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXVwiKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPz8gXCIxXCIgfSk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbmVpZ2hib3JzLyR7aWR9PyR7cGFyYW1zfWApO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmF0aWZ5KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcHJvcG9zYWxJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFwcm9wb3NhbElkIHx8ICFwYXJzZWQudmFsdWVzLnJ1bGluZykge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgcmF0aWZ5IDxwcm9wb3NhbElkPiAtLXJ1bGluZyA8cj4gWy0tZG9jLWVkaXQgPGZpbGU+XSBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSBbLS1hbmNob3IgPHBhcmVudElkPl1cXG5cIixcbiAgICApO1xuICB9XG4gIC8vIC0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQg4oCUIHRoZSBkYWVtb24gZW5mb3JjZXMgaXQgdG9vLCBidXQgYSBsb2NhbFxuICAvLyB1c2FnZSBlcnJvciBiZWF0cyBhIHJvdW5kLXRyaXAgZm9yIHRoZSBjb21tb24gc2xpcC5cbiAgaWYgKHBhcnNlZC52YWx1ZXMuZG9jICYmICFwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl0pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFwiLS1kb2MgcmVxdWlyZXMgLS1kb2MtZWRpdCAodGhlIGRyYWZ0ZWQgZG9jIGhvbWUpXCIpO1xuICB9XG4gIGNvbnN0IGRvY0VkaXQgPSBwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl1cbiAgICA/IHJlYWRGaWxlU3luYyhwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl0sIFwidXRmOFwiKVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke3Byb3Bvc2FsSWR9L3J1bGluZyR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsaW5nOiBwYXJzZWQudmFsdWVzLnJ1bGluZyxcbiAgICAgIGRvY0VkaXQsXG4gICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICBzcGFuOiBwYXJzZWQudmFsdWVzLnNwYW4sXG4gICAgICAvLyBSb3VuZCA2IChSQik6IC0tYW5jaG9yIDxwYXJlbnRJZD4gcmF0aWZpZXMgdGhlbiBuZXN0cyB0aGUgbWludGVkXG4gICAgICAvLyBub2RlIHVuZGVyIDxwYXJlbnRJZD4gaW4gb25lIGF0b21pYyBjYWxsIChub2RlIHByb3Bvc2FscyBvbmx5KS5cbiAgICAgIGFuY2hvcjogcGFyc2VkLnZhbHVlcy5hbmNob3IsXG4gICAgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuLy8gUm91bmQgMyAoQ2xhaW0gVjIpOiBvbmUgbGVucywgdHdvIG1vZGVzIOKAlCAtLW5vZGUgYW5kIC0tZG9jIGFyZSBleGNsdXNpdmVcbi8vICh0aGUgZGFlbW9uIGVuZm9yY2VzIHRoZSBYT1IgdG9vLCBidXQgdGhlIGNvbW1vbiBzbGlwIHNob3VsZCBmYWlsIGJlZm9yZSBhXG4vLyByb3VuZC10cmlwKS4gVGhlIHJvdydzIGBjaGVja2AgcmVmdXNlcyB0aGUgc2xpcDsgdGhpcyBvbmx5IHBvc3RzLlxuYXN5bmMgZnVuY3Rpb24gY21kTGVuc1NldChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbGVucyR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgb3duZXI6IHBhcnNlZC52YWx1ZXMub3duZXIgPz8gXCJhZ2VudFwiLFxuICAgICAgbm9kZUlkOiBwYXJzZWQudmFsdWVzLm5vZGUsXG4gICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICBkZXB0aDogcGFyc2VkLnZhbHVlcy5kZXB0aCA/IE51bWJlci5wYXJzZUludChwYXJzZWQudmFsdWVzLmRlcHRoLCAxMCkgOiB1bmRlZmluZWQsXG4gICAgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTGVuc0NsZWFyKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9sZW5zJHtwcm9qZWN0UXMocGFyc2VkKX1gLCB7XG4gICAgbWV0aG9kOiBcIkRFTEVURVwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExvb2tIZXJlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGlmICghaWQpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBsb29rLWhlcmUgPG5vZGVJZD5cIik7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9sb29rLWhlcmUvJHtpZH0ke3FzfWAsIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogYC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyYCwgZXhhY3RseSBvbmUg4oCUIGBhY3Rpb25zYCBhbmQgYHRhZ3NgLiBUaGVcbiAqIGRlY2xhcmF0aW9uIHB1Ymxpc2hlcyBhbGwgdGhyZWUgYXMgdmFsaWQ7IHRoZSBydWxlIHJpZGVzIHRoZSByb3cncyBgY2hlY2tgLlxuICovXG5jb25zdCBleGFjdGx5T25lTW9kZSA9IChpbnY6IEludm9jYXRpb248RmxhZz4pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT4ge1xuICBjb25zdCBtb2RlcyA9IFtpbnYuZmxhZ3Muc2V0ICE9PSB1bmRlZmluZWQsIGludi5mbGFncy5zdGRpbiA9PT0gdHJ1ZSwgaW52LmZsYWdzLmNsZWFyID09PSB0cnVlXTtcbiAgcmV0dXJuIG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggPT09IDFcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogXCJnaXZlIGV4YWN0bHkgb25lIG9mIC0tc2V0IDxqc29uPiwgLS1zdGRpbiBvciAtLWNsZWFyXCI7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjbWRBY3Rpb25zKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdGFyZ2V0SWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGNvbnN0IG1vZGVzID0gW3BhcnNlZC52YWx1ZXMuc2V0ICE9PSB1bmRlZmluZWQsIHBhcnNlZC52YWx1ZXMuc3RkaW4sIHBhcnNlZC52YWx1ZXMuY2xlYXJdO1xuICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIGFjdGlvbnMgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpXFxuXCIgK1xuICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICcgIHtcImlkXCIsIFwibGFiZWxcIiwgXCJzZWVkXCJ9IOKAlCBlbXB0eSBhcnJheSAob3IgLS1jbGVhcikgcmVtb3ZlcyB0aGUgc2xvdHNcXG4nLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpb25zLyR7dGFyZ2V0SWR9JHtxc31gO1xuICBjb25zdCByZXMgPSBwYXJzZWQudmFsdWVzLmNsZWFyXG4gICAgPyBhd2FpdCBmZXRjaCh0YXJnZXQsIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pXG4gICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBVVFwiLFxuICAgICAgICBib2R5OiBwYXJzZWQudmFsdWVzLnN0ZGluID8gYXdhaXQgQnVuLnN0ZGluLnRleHQoKSA6IChwYXJzZWQudmFsdWVzLnNldCBhcyBzdHJpbmcpLFxuICAgICAgfSk7XG4gIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgLy8gTWlycm9yIHRoZSBkYWVtb24ncyBhZGRpdGl2ZSBzb2Z0LWNhcCB3YXJuaW5nIHRvIHN0ZGVyciAodGhlXG4gIC8vIGVkZ2VEcmFmdFdhcm5pbmcgcGF0dGVybiDigJQgYSBjb2xkIGFnZW50IHNjYW5uaW5nIGZvciBwcm9ibGVtcyBzZWVzIGl0KS5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDcgKFRBR1MpIOKAlCB0d2luIG9mIHRoZSBhY3Rpb25zIHZlcmI6IHdob2xlc2FsZSByZXBsYWNlIC8gY2xlYXIgYVxuLy8gdGFyZ2V0J3MgZnJlZWZvcm0gdGFncy4gVGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWdzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdGFyZ2V0SWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGNvbnN0IG1vZGVzID0gW3BhcnNlZC52YWx1ZXMuc2V0ICE9PSB1bmRlZmluZWQsIHBhcnNlZC52YWx1ZXMuc3RkaW4sIHBhcnNlZC52YWx1ZXMuY2xlYXJdO1xuICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIHRhZ3MgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpXFxuXCIgK1xuICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgIFwiICBmcmVlZm9ybSBzdHJpbmdzIOKAlCBlbXB0eSBhcnJheSAob3IgLS1jbGVhcikgcmVtb3ZlcyB0aGUgdGFnc1xcblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS90YWdzLyR7dGFyZ2V0SWR9JHtxc31gO1xuICBjb25zdCByZXMgPSBwYXJzZWQudmFsdWVzLmNsZWFyXG4gICAgPyBhd2FpdCBmZXRjaCh0YXJnZXQsIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pXG4gICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBVVFwiLFxuICAgICAgICBib2R5OiBwYXJzZWQudmFsdWVzLnN0ZGluID8gYXdhaXQgQnVuLnN0ZGluLnRleHQoKSA6IChwYXJzZWQudmFsdWVzLnNldCBhcyBzdHJpbmcpLFxuICAgICAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCA5IChKb2IgUXVldWUpIOKAlCB0aGUgYGpvYmAgZ3JvdXA6IGNyZWF0ZS91cGRhdGUvY2xhaW0vcmVsZWFzZS9zdWJ0YXNrL1xuLy8gbGlzdC9kZWxldGUsIGNvcHlpbmcgdGhlIGBwcm9wb3NhbCA8c3ViPmAgbGlmZWN5Y2xlIHNoYXBlICsgdGhlIHRhZ3Ncbi8vIGJvZHktYnVpbGRlciBkaXNjaXBsaW5lLiBFVkVSWSBmaWVsZCBpcyB0aHJlYWRlZCBpbnRvIHRoZSBQT1NUIGJvZHkgKHRoZSBSN1xuLy8gZ2F0ZSBzY2FyOiBhIGhhbmQtd3JpdHRlbiBib2R5LWJ1aWxkZXIgaXMgYSBNSVJST1Igb2YgdGhlIHJvdXRlJ3MgZmllbGQgc2V0XG4vLyBhbmQgZHJpZnRzIHNpbGVudGx5IOKAlCBzbyB1cGRhdGUgZm9yd2FyZHMgZWFjaCBwcm92aWRlZCBzY2FsYXIsIHN1YnRhc2tcbi8vIGZvcndhcmRzIG9wICsgbGFiZWx8c3VidGFza0lkLCBjbGFpbSBmb3J3YXJkcyBvd25lcikuXG5jb25zdCBqb2JVcmwgPSAocG9ydDogbnVtYmVyLCBwYXJzZWQ6IFBhcnNlZCwgc3VmZml4ID0gXCJcIik6IHN0cmluZyA9PlxuICBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2pvYnMke3N1ZmZpeH0ke3Byb2plY3RRcyhwYXJzZWQpfWA7XG5cbi8vIEEgSlNPTiBib2R5IGZyb20gLS1ib2R5LWZpbGUgPiAtLXN0ZGluIG92ZXJyaWRlcyB0aGUgZmxhZy1idWlsdCBib2R5ICh0aGVcbi8vIHNlbmQgcHJlY2VkZW5jZSBjaGFpbiksIHNvIGEgZnVsbCBqb2IgY2FuIGJlIHBpcGVkIGluIG9uZSBzaG90LlxuYXN5bmMgZnVuY3Rpb24gam9iQm9keUZyb21Tb3VyY2UocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbD4ge1xuICBpZiAocGFyc2VkLnZhbHVlc1tcImJvZHktZmlsZVwiXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgaWYgKCFleGlzdHNTeW5jKHApKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKGBqb2I6IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwfWApO1xuICAgIH1cbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfVxuICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRKb2JMaXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goam9iVXJsKHBvcnQsIHBhcnNlZCkpO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iQ3JlYXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBqb2JCb2R5RnJvbVNvdXJjZShwYXJzZWQpO1xuICBjb25zdCBib2R5ID0gb3ZlcnJpZGUgPz8ge1xuICAgIHRpdGxlOiBwYXJzZWQudmFsdWVzLnRpdGxlLFxuICAgIHN0YXR1czogcGFyc2VkLnZhbHVlcy5zdGF0dXMsXG4gICAgZGVsaXZlcmFibGU6IHBhcnNlZC52YWx1ZXMuZGVsaXZlcmFibGUsXG4gICAgZGV0YWlsOiBwYXJzZWQudmFsdWVzLmRldGFpbCxcbiAgfTtcbiAgaWYgKHR5cGVvZiBib2R5LnRpdGxlICE9PSBcInN0cmluZ1wiIHx8IGJvZHkudGl0bGUgPT09IFwiXCIpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiBjcmVhdGUgLS10aXRsZSA8dD4gWy0tc3RhdHVzIDxzPl0gWy0tZGVsaXZlcmFibGUgPHJlZj5dIFstLWRldGFpbCA8eD5dXFxuXCIgK1xuICAgICAgICBcIiAgb3I6IGNsaS50cyBqb2IgY3JlYXRlICgtLXN0ZGluIHwgLS1ib2R5LWZpbGUgPHBhdGg+KSB3aXRoIEpTT04ge3RpdGxlLCBzdGF0dXM/LCBkZWxpdmVyYWJsZT8sIGRldGFpbD99XFxuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkKSwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYlVwZGF0ZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBqb2JCb2R5RnJvbVNvdXJjZShwYXJzZWQpO1xuICAvLyBGb3J3YXJkIG9ubHkgdGhlIGZsYWdzIHRoYXQgd2VyZSBQUk9WSURFRCAodGhyZWFkIGV2ZXJ5IGZpZWxkIOKAlCB0aGUgUjdcbiAgLy8gYm9keS1taXJyb3Igc2Nhcik7IGEgYmFyZSBgam9iIHVwZGF0ZSA8aWQ+YCB3aXRoIG5vIGZpZWxkcyBpcyBhIHVzYWdlXG4gIC8vIGVycm9yLCBub3QgYSBzaWxlbnQgbm8tb3AgUE9TVC5cbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPVxuICAgIG92ZXJyaWRlID8/XG4gICAgT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgKFtcInRpdGxlXCIsIFwic3RhdHVzXCIsIFwiZGVsaXZlcmFibGVcIiwgXCJkZXRhaWxcIl0gYXMgY29uc3QpXG4gICAgICAgIC5maWx0ZXIoKGspID0+IHBhcnNlZC52YWx1ZXNba10gIT09IHVuZGVmaW5lZClcbiAgICAgICAgLm1hcCgoaykgPT4gW2ssIHBhcnNlZC52YWx1ZXNba11dKSxcbiAgICApO1xuICBpZiAoT2JqZWN0LmtleXMoYm9keSkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIFwidXNhZ2U6IGNsaS50cyBqb2IgdXBkYXRlIDxpZD4gKGF0IGxlYXN0IG9uZSBvZiAtLXRpdGxlfC0tc3RhdHVzfC0tZGVsaXZlcmFibGV8LS1kZXRhaWwpXFxuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9YCksIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYkNsYWltKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBpZiAocGFyc2VkLnZhbHVlcy5vd25lciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgam9iIGNsYWltIDxpZD4gLS1vd25lciA8d2hvPlwiKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9L2NsYWltYCksIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgb3duZXI6IHBhcnNlZC52YWx1ZXMub3duZXIgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iUmVsZWFzZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goam9iVXJsKHBvcnQsIHBhcnNlZCwgYC8ke2lkfS9yZWxlYXNlYCksIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKiBgLS1hZGQgfCAtLWNoZWNrIHwgLS11bmNoZWNrYCwgZXhhY3RseSBvbmUg4oCUIGBqb2Igc3VidGFza2AncyBgY2hlY2tgLiAqL1xuY29uc3Qgb25lU3VidGFza09wID0gKGludjogSW52b2NhdGlvbjxGbGFnPik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gIGNvbnN0IG1vZGVzID0gW2ludi5mbGFncy5hZGQsIGludi5mbGFncy5jaGVjaywgaW52LmZsYWdzLnVuY2hlY2tdLmZpbHRlcigodikgPT4gdiAhPT0gdW5kZWZpbmVkKTtcbiAgcmV0dXJuIG1vZGVzLmxlbmd0aCA9PT0gMVxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBcImdpdmUgZXhhY3RseSBvbmUgb2YgLS1hZGQgPGxhYmVsPiwgLS1jaGVjayA8c3VidGFza0lkPiBvciAtLXVuY2hlY2sgPHN1YnRhc2tJZD5cIjtcbn07XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYlN1YnRhc2socGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IGpvYkJvZHkgPVxuICAgIHBhcnNlZC52YWx1ZXMuYWRkICE9PSB1bmRlZmluZWRcbiAgICAgID8geyBvcDogXCJhZGRcIiwgbGFiZWw6IHBhcnNlZC52YWx1ZXMuYWRkIH1cbiAgICAgIDogcGFyc2VkLnZhbHVlcy5jaGVjayAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8geyBvcDogXCJjaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMuY2hlY2sgfVxuICAgICAgICA6IHsgb3A6IFwidW5jaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMudW5jaGVjayB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9L3N1YnRhc2tgKSwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoam9iQm9keSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9YCksIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWN0aXZpdHkocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBzdGF0ZSA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFBQ1RJVklUWV9TVEFURVMuaW5jbHVkZXMoc3RhdGUgYXMgKHR5cGVvZiBBQ1RJVklUWV9TVEFURVMpW251bWJlcl0pKSB7XG4gICAgLy8g4puUIE9ORSBBUlJBWSwgQ0hFQ0tFRCBBTkQgUFVCTElTSEVEIChBMSkuIFRoZSBtZW1iZXJzIHdlcmUgYSB0aHJlZS13YXlcbiAgICAvLyBgIT09YCBjaGFpbiBmb3IgdGhlIGNoZWNrIGFuZCB0aGUgc3RyaW5nIGA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT5gIGZvclxuICAgIC8vIHRoZSBtZXNzYWdlIOKAlCB0d28gY29waWVzIG9mIG9uZSBjbG9zZWQgc2V0LCBhbmQgdGhlIG1hY2hpbmUtcmVhZGFibGVcbiAgICAvLyBvbmUgZGlkIG5vdCBleGlzdC4gVGhpcyBpcyB0aGUgTEFTVCBlbnVtZXJhdGVkIHZhbHVlIGluIHRoaXMgZmlsZSB0aGF0XG4gICAgLy8gd2FzIHN0aWxsIHByb3NlLW9ubHk7IGV2ZXJ5IG90aGVyIHJlamVjdGlvbiBoZXJlIGFscmVhZHkgaGFkIGBjaG9pY2VzYC5cbiAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBhY3Rpdml0eSA8c3RhdGU+IFstLW1lc3NhZ2UgPGlkPl1cIiwge1xuICAgICAgaGludDogXCJzdGF0ZSBpcyB0aGUgZmlyc3QgcG9zaXRpb25hbFwiLFxuICAgICAgY2hvaWNlczogWy4uLkFDVElWSVRZX1NUQVRFU10sXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpdml0eSR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0ZSwgbWVzc2FnZUlkOiBwYXJzZWQudmFsdWVzLm1lc3NhZ2UgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vIFJvdW5kIDMgKENsYWltIEMxKTogZ3JhcGV2aW5lJ3MgYm9keS1yZXNvbHV0aW9uIGNoYWluLCBwcmVjZWRlbmNlXG4gIC8vIC0tYm9keS1maWxlID4gLS1zdGRpbiA+IGlubGluZSBwb3NpdGlvbmFsID4gcGlwZWQtc3RkaW4gZGVmYXVsdC5cbiAgLy8gU2hhcnAgZWRnZSAobWVhc3VyZWQsIGhvdXNlLXdpZGUpOiB0aGUgcGlwZWQtc3RkaW4gZGVmYXVsdCBIQU5HU1xuICAvLyBGT1JFVkVSIHVuZGVyIGFnZW50IHNoZWxscyAoaXNUVFkgbnVsbCwgbm8gRU9GKSDigJQgbm8gcmVhZCB0aW1lb3V0IG9uXG4gIC8vIHB1cnBvc2UgKGl0IHdvdWxkIGJyZWFrIHNsb3cgcGlwZXMpOyBhbHdheXMgcGFzcyBhIGJvZHkuXG4gIGNvbnN0IGhhc0lubGluZSA9IHBhcnNlZC5wb3NpdGlvbmFscy5sZW5ndGggPiAwO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBsZXQgZnJvbUlubGluZSA9IGZhbHNlO1xuICBpZiAocGFyc2VkLnZhbHVlc1tcImJvZHktZmlsZVwiXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcGF0aCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKGBzZW5kOiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gKTtcbiAgICB9XG4gICAgLy8gVHJhaWxpbmcgbmV3bGluZSBzdHJpcHBlZCAoZmlsZXMgYW5kIGhlcmVkb2NzIGVuZCB3aXRoIG9uZTsgdGhlXG4gICAgLy8gbWVzc2FnZSBzaG91bGRuJ3QpIOKAlCBtYXRjaGluZyAtLXN0ZGluLCBhbmQgZ3JhcGV2aW5lLlxuICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKTtcbiAgfSBlbHNlIGlmIChwYXJzZWQudmFsdWVzLnN0ZGluIHx8ICghaGFzSW5saW5lICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgIHRleHQgPSAoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkucmVwbGFjZSgvXFxuJC8sIFwiXCIpO1xuICB9IGVsc2Uge1xuICAgIHRleHQgPSBwYXJzZWQucG9zaXRpb25hbHMuam9pbihcIiBcIik7XG4gICAgZnJvbUlubGluZSA9IHRydWU7XG4gIH1cbiAgLy8gQW4gRU1QVFkgcmVzb2x2ZWQgYm9keSBpcyBhIHVzYWdlIGVycm9yIChleGl0IDIpLCB3aGF0ZXZlciBwYXRoXG4gIC8vIHByb2R1Y2VkIGl0IOKAlCBhIGJsYW5rIG1lc3NhZ2UgaGVscHMgbm9ib2R5IGFuZCB1c3VhbGx5IG1lYW5zIGEgZnVtYmxlLlxuICBpZiAodGV4dCA9PT0gXCJcIikge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgc2VuZCA8dGV4dC4uLj4gfCAtLWJvZHktZmlsZSA8cGF0aD4gfCAtLXN0ZGluXFxuXCIgK1xuICAgICAgICBcIm1pbmQtbWFwcGVyOiBzZW5kIHJlc29sdmVkIGFuIGVtcHR5IGJvZHkg4oCUIG5vdGhpbmcgc2VudFxcblwiLFxuICAgICk7XG4gIH1cbiAgLy8gQSBmdW1ibGVkIGhlcmVkb2MgcGlwZXMgdGhlIGxpdGVyYWwgc2VuZCBpbnZvY2F0aW9uIGluIGFzIHRoZSBib2R5IOKAlFxuICAvLyByZWZ1c2UgdG8gcG9zdCB0aGF0IChuYXJyb3dlZCB0byB0aGUgc2VuZCB2ZXJiOyAtLWZvcmNlIG92ZXJyaWRlcyBmb3JcbiAgLy8gYSBib2R5IHRoYXQgZ2VudWluZWx5IHF1b3RlcyB0aGUgY29tbWFuZCkuXG4gIGlmICghcGFyc2VkLnZhbHVlcy5mb3JjZSAmJiAvKD86XnxcXG4pWyBcXHRdKmJ1blxcYlteXFxuXSpcXGJjbGlcXC50c1xcYlteXFxuXSpcXGJzZW5kXFxiLy50ZXN0KHRleHQpKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIFwibWluZC1tYXBwZXI6IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGNsaSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgaGVyZWRvYz8pLiBcIiArXG4gICAgICAgIFwiTm90aGluZyB3YXMgc2VudC4gUGlwZSB0aGUgcmVhbCBib2R5IHZpYSAtLXN0ZGluIG9yIC0tYm9keS1maWxlIDxwYXRoPiwgXCIgK1xuICAgICAgICBcIm9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cXG5cIixcbiAgICApO1xuICB9XG4gIC8vIElubGluZSBib2RpZXMgd2l0aCBzdXJ2aXZpbmcgc2hlbGwgbWV0YWNoYXJhY3RlcnMgbWFkZSBpdCB0aHJvdWdoIFRISVNcbiAgLy8gdGltZSDigJQgd2FybiAoc3RkZXJyLCBuZXZlciBibG9ja3MpIGFuZCBzdGVlciB0byB0aGUgc2hlbGwtZnJlZSBwYXRocy5cbiAgaWYgKGZyb21JbmxpbmUgJiYgL2B8XFwkXFwofFxcJFxcey8udGVzdCh0ZXh0KSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgXCIjIHdhcm5pbmc6IGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgZmlyc3Qg4oCUIFwiICtcbiAgICAgICAgXCJ1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zZW5kJHtxc31gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICByb2xlOiBwYXJzZWQudmFsdWVzLnJvbGUgPz8gXCJhZ2VudFwiLFxuICAgICAga2luZDogcGFyc2VkLnZhbHVlcy5raW5kID8/IFwidHVyblwiLFxuICAgICAgdGV4dCxcbiAgICAgIC8vIEZsYXR0ZW4gcmVwZWF0cywgc3BsaXQgY29tbWFzLCBkcm9wIGJsYW5rIGZyYWdtZW50cyDigJQgYW4gZW1wdHlcbiAgICAgIC8vIHJlc29sdmVkIGxpc3QgcG9zdHMgYXMgbm8gZ3JvdW5kIGF0IGFsbCAobmV2ZXIgW1wiXCJdKS5cbiAgICAgIGdyb3VuZDogKCgpID0+IHtcbiAgICAgICAgY29uc3QgcmVmcyA9IChwYXJzZWQudmFsdWVzLmdyb3VuZCA/PyBbXSlcbiAgICAgICAgICAuZmxhdE1hcCgoZykgPT4gZy5zcGxpdChcIixcIikpXG4gICAgICAgICAgLm1hcCgoZykgPT4gZy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcigoZykgPT4gZyAhPT0gXCJcIik7XG4gICAgICAgIHJldHVybiByZWZzLmxlbmd0aCA+IDAgPyByZWZzIDogdW5kZWZpbmVkO1xuICAgICAgfSkoKSxcbiAgICB9KSxcbiAgfSk7XG4gIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgLy8gUm91bmQgMTEgKFNFQU0gMSk6IG1pcnJvciB0aGUgZGFlbW9uJ3MgdW5rbm93bi1jaGFubmVsIGFkdmlzb3J5IHRvIHN0ZGVycixcbiAgLy8gc2FtZSBhcyBwcm9wb3NlLWVkZ2UncyBkcmFmdCB3YXJuaW5nIOKAlCBhIHR5cG8nZCBgLS1raW5kYCBpcyBvdGhlcndpc2UgYVxuICAvLyBtZXNzYWdlIHRoYXQgc2lsZW50bHkgcmVuZGVycyBhcyBhIHBsYWluIGNoYXQgdHVybi5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8vIOKUgOKUgCBUSEUgQ09NTUFORCBUQUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgZGlzcGF0Y2hlciwgdGhlIHBlci1wYXRoIGZsYWcgY2hlY2ssIHRoZSByZWplY3Rpb25zJyBgY2hvaWNlc2AsIGFyaXR5LFxuLy8gYC0tdmVyc2lvbmAgYW5kIHRoZSBgc2NoZW1hYCBkZWNsYXJhdGlvbiBhbGwgd2FsayBUSElTLCB0aHJvdWdoIHRoZSBob3VzZSdzXG4vLyBvbmUgcmVnaXN0cnkgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2ApLiBBIHBhdGggYWRkZWQgaGVyZSBpcyBkaXNwYXRjaGVkIGFuZFxuLy8gcHVibGlzaGVkIGJ5IGBzY2hlbWFgIGF0IG9uY2UuIFRoZSBoZWxwIHRleHQgaXMgdGhlIG9uZSBoYW5kLXdyaXR0ZW4gdmlld1xuLy8gKGBIRUxQYCBhYm92ZSk7IGBjbGktY29udHJhY3QudGVzdC50c2AgYmluZHMgaXQgdG8gdGhpcyB0YWJsZS5cblxuY29uc3Qgb25lID0gKG5hbWU6IHN0cmluZyk6IFBvc2l0aW9uYWxTcGVjW10gPT4gW3sgbmFtZSwgcmVxdWlyZWQ6IHRydWUgfV07XG5jb25zdCB3b3JkcyA9IChuYW1lOiBzdHJpbmcpOiBQb3NpdGlvbmFsU3BlY1tdID0+IFt7IG5hbWUsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XTtcbmNvbnN0IE5PTkU6IFBvc2l0aW9uYWxTcGVjW10gPSBbXTtcblxuY29uc3QgUk9XUzogQ29tbWFuZFNwZWM8RmxhZz5bXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJuby1vcGVuXCIsIFwicG9ydFwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3Bhd24gKG9yIGZpbmQpIHRoZSBkYWVtb24sIHByaW50IGl0cyB1cmxcIixcbiAgICBydW46IG9uKGNtZE9wZW4pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbXCJza2VsZXRvblwiLCBcImJhdGNoXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJ0aGUgcHJvamVjdCBzbmFwc2hvdFwiLFxuICAgIHJ1bjogb24oY21kU3RhdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjaGFuZ2VzXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJib3VuZGVkIGRlbHRhLCBhZGRpdGlvbnMgb25seVwiLFxuICAgIHJ1bjogb24oY21kQ2hhbmdlcyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJpbmJvdW5kXCIsIFwib25jZVwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwiU1NFIGV2ZW50cyBhcyBKU09OTFwiLFxuICAgIHJ1bjogb24oY21kVGFpbCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb2plY3RzXCIsXG4gICAgZmxhZ3M6IFtcImNyZWF0ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJsaXN0IHByb2plY3RzIC8gY3JlYXRlIG9uZVwiLFxuICAgIHJ1bjogb24oY21kUHJvamVjdHMpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbmdlc3RcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJmaWxlXCIsIFwic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImFkZCBhIGRvY1wiLFxuICAgIHJ1bjogb24oY21kSW5nZXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJvcG9zZS1ub2RlXCIsXG4gICAgZmxhZ3M6IFtcInN0ZGluXCIsIFwiem9uZVwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3RhZ2UgYSBub2RlIHByb3Bvc2FsXCIsXG4gICAgcnVuOiBvbigocCkgPT4gY21kUHJvcG9zZShcInByb3Bvc2Utbm9kZVwiLCBwKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb3Bvc2UtZWRnZVwiLFxuICAgIGZsYWdzOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcInN0YWdlIGFuIGVkZ2UgcHJvcG9zYWxcIixcbiAgICBydW46IG9uKChwKSA9PiBjbWRQcm9wb3NlKFwicHJvcG9zZS1lZGdlXCIsIHApKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJvcG9zZS1iYXRjaFwiLFxuICAgIGZsYWdzOiBbXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3RhZ2UgYSBzZXQgaW4gb25lIHR4blwiLFxuICAgIHJ1bjogb24oY21kUHJvcG9zZUJhdGNoKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmF0aWZ5LWJhdGNoXCIsXG4gICAgZmxhZ3M6IFtcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJyYXRpZnkgYSBzZXQgaW4gb25lIHR4blwiLFxuICAgIHJ1bjogb24oY21kUmF0aWZ5QmF0Y2gpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkZWxldGUtYmF0Y2hcIixcbiAgICBmbGFnczogW1wic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIHByb3Bvc2FsIHNldCBpbiBvbmUgdHhuXCIsXG4gICAgcnVuOiBvbihjbWREZWxldGVCYXRjaCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vZGUgYW5jaG9yXCIsXG4gICAgZmxhZ3M6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJub2RlSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiYW5jaG9yIGEgbm9kZSB1bmRlciBhIHBhcmVudCAoLS10bykgb3IgYmFjayB0byB0b3AtbGV2ZWwgKC0tY2xlYXIpXCIsXG4gICAgY2hlY2s6IHRvWG9yQ2xlYXIsXG4gICAgcnVuOiBvbihjbWROb2RlQW5jaG9yKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm9kZSBlZGl0XCIsXG4gICAgZmxhZ3M6IFtcInRpdGxlXCIsIFwic3lub3BzaXNcIiwgXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcIm5vZGVJZFwiKSxcbiAgICBkZXNjcmliZTogXCJlZGl0IGEgbm9kZSdzIHRpdGxlL3N5bm9wc2lzXCIsXG4gICAgcnVuOiBvbihjbWROb2RlRWRpdCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vZGUgZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibm9kZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIG5vZGUgKC0tZm9yY2UgY2FzY2FkZXMpXCIsXG4gICAgcnVuOiBvbihjbWROb2RlRGVsZXRlKSxcbiAgfSxcbiAge1xuICAgIC8vIGBtZXNzYWdlYCBpcyBhbiBhZHZlcnRpc2VkIEFMSUFTIG9mIGByZWFkYCAob25lIG1lc3NhZ2UtZmV0Y2ggdmVyYiwgdHdvXG4gICAgLy8gc3BlbGxpbmdzKTogZGlzcGF0Y2hhYmxlLCBpbiBgdmVyYnNgLCBhbmQgZGVjbGFyZWQgb24gaXRzIG93biByb3cuXG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgYWxpYXNlczogW1wibWVzc2FnZVwiXSxcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibWVzc2FnZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcIm9uZSBmdWxsIG1lc3NhZ2Ugcm93XCIsXG4gICAgcnVuOiBvbihjbWRSZWFkKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiem9uZSBjcmVhdGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogd29yZHMoXCJuYW1lXCIpLFxuICAgIGRlc2NyaWJlOiBcImNyZWF0ZSBhIHN0YWdpbmcgem9uZVwiLFxuICAgIHJ1bjogb24oY21kWm9uZUNyZWF0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInpvbmUgbGlzdFwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImxpc3Qgem9uZXNcIixcbiAgICBydW46IG9uKGNtZFpvbmVMaXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiem9uZSBkZWxldGVcIixcbiAgICBmbGFnczogW1wieWVzXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiem9uZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIHpvbmUgKC0teWVzIHdoZW4gcG9wdWxhdGVkKVwiLFxuICAgIHJ1bjogb24oY21kWm9uZURlbGV0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb21vdGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwicHJvcG9zYWxJZFwiKSxcbiAgICBkZXNjcmliZTogXCJtb3ZlIGEgem9uZWQgcHJvcG9zYWwgdG8gdGhlIG1haW4gcXVldWVcIixcbiAgICBydW46IG9uKGNtZFByb21vdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcm9wb3NhbCB6b25lXCIsXG4gICAgZmxhZ3M6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJwcm9wb3NhbElkXCIpLFxuICAgIGRlc2NyaWJlOiBcIm1vdmUgYSBwZW5kaW5nIHByb3Bvc2FsIGludG8gYSB6b25lICgtLXRvKSBvciBiYWNrIHRvIG1haW4gKC0tY2xlYXIpXCIsXG4gICAgY2hlY2s6IHRvWG9yQ2xlYXIsXG4gICAgcnVuOiBvbihjbWRQcm9wb3NhbFpvbmUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcm9wb3NhbCBkZWxldGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwicHJvcG9zYWxJZFwiKSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBwcm9wb3NhbFwiLFxuICAgIHJ1bjogb24oY21kUHJvcG9zYWxEZWxldGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2NcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiZG9jSWRcIiksXG4gICAgZGVzY3JpYmU6IFwidGhlIGRvYyBlbnZlbG9wZVwiLFxuICAgIHJ1bjogb24oKHApID0+IGNtZERvYyhmYWxzZSwgcCkpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2MgZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiZG9jSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgZG9jICgtLWZvcmNlIGNhc2NhZGVzKVwiLFxuICAgIHJ1bjogb24oKHApID0+IGNtZERvYyh0cnVlLCBwKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvYyBraW5kXCIsXG4gICAgZmxhZ3M6IFtcImF1dGhvclwiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgICAvLyDimqAgRkxBRy1ERVBFTkRFTlQgQVJJVFk6IGBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kLi4uPmAgc2V0cywgYGRvYyBraW5kXG4gICAgLy8gPGRvY0lkPiAtLWNsZWFyYCBjbGVhcnMgYW5kIHRha2VzIG5vIGtpbmQuIFRoZSBkZWNsYXJhdGlvbiBjYW5ub3Qgc2F5XG4gICAgLy8gXCJyZXF1aXJlZCB1bmxlc3MgLS1jbGVhclwiLCBzbyBpdCBjYW4gb25seSBtYXJrIDxraW5kPiBvcHRpb25hbDsgYGNoZWNrYFxuICAgIC8vIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiZG9jSWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJraW5kXCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcImFzc2VydCAoPGtpbmQ+KSBvciBjbGVhciAoLS1jbGVhcikgYSBkb2MncyBraW5kXCIsXG4gICAgY2hlY2s6IChpbnYpID0+IHtcbiAgICAgIGNvbnN0IGNsZWFyID0gaW52LmZsYWdzLmNsZWFyID09PSB0cnVlO1xuICAgICAgaWYgKGNsZWFyICYmIGludi5wb3MubGVuZ3RoID4gMSkgcmV0dXJuIFwiLS1jbGVhciB0YWtlcyBubyA8a2luZD5cIjtcbiAgICAgIGlmICghY2xlYXIgJiYgaW52LnBvcy5sZW5ndGggPCAyKSByZXR1cm4gXCJtaXNzaW5nIHJlcXVpcmVkIDxraW5kPiAob3IgcGFzcyAtLWNsZWFyKVwiO1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICAgIHJ1bjogb24oY21kRG9jS2luZCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1hcmtcIixcbiAgICBmbGFnczogW1wic3RhdHVzXCIsIFwibm90ZVwiLCBcImF1dGhvclwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcImRvY0lkXCIpLFxuICAgIGRlc2NyaWJlOiBcImFwcGVuZCBhIGRvYyBzdGF0dXMgbWFya1wiLFxuICAgIHJ1bjogb24oY21kTWFyayksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlYXJjaFwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiB3b3JkcyhcInF1ZXJ5XCIpLFxuICAgIGRlc2NyaWJlOiBcIkZUUyBvdmVyIG5vZGVzLCBkb2NzLCBtZXNzYWdlc1wiLFxuICAgIHJ1bjogb24oY21kU2VhcmNoKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibmVpZ2hib3JzXCIsXG4gICAgZmxhZ3M6IFtcImRlcHRoXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibm9kZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImxvY2FsIGhvb2QgKyBlZGdlIHJlYXNvbnNcIixcbiAgICBydW46IG9uKGNtZE5laWdoYm9ycyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJhdGlmeVwiLFxuICAgIGZsYWdzOiBbXCJydWxpbmdcIiwgXCJkb2MtZWRpdFwiLCBcImRvY1wiLCBcInNwYW5cIiwgXCJhbmNob3JcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJwcm9wb3NhbElkXCIpLFxuICAgIGRlc2NyaWJlOiBcInJ1bGUgb24gYSBwcm9wb3NhbFwiLFxuICAgIHJ1bjogb24oY21kUmF0aWZ5KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGVucyBzZXRcIixcbiAgICBmbGFnczogW1wibm9kZVwiLCBcImRvY1wiLCBcImRlcHRoXCIsIFwib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcInNldCB0aGUgbGVucyBvbiBhIG5vZGUgKC0tbm9kZSkgb3IgYSBkb2MgKC0tZG9jKVwiLFxuICAgIGNoZWNrOiAoaW52KSA9PiB7XG4gICAgICBpZiAoaW52LmZsYWdzLm5vZGUgIT09IHVuZGVmaW5lZCAmJiBpbnYuZmxhZ3MuZG9jICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIFwibGVucyBzZXQgdGFrZXMgLS1ub2RlIE9SIC0tZG9jLCBub3QgYm90aFwiO1xuICAgICAgfVxuICAgICAgaWYgKGludi5mbGFncy5kb2MgIT09IHVuZGVmaW5lZCAmJiBpbnYuZmxhZ3MuZGVwdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gXCItLWRlcHRoIGFwcGxpZXMgdG8gYSBub2RlIGxlbnMgb25seVwiO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICAgIHJ1bjogb24oY21kTGVuc1NldCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxlbnMgY2xlYXJcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJjbGVhciB0aGUgbGVuc1wiLFxuICAgIHJ1bjogb24oY21kTGVuc0NsZWFyKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibG9vay1oZXJlXCIsXG4gICAgZmxhZ3M6IFtcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcIm5vZGVJZFwiKSxcbiAgICBkZXNjcmliZTogXCJmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXCIsXG4gICAgcnVuOiBvbihjbWRMb29rSGVyZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGlvbnNcIixcbiAgICBmbGFnczogW1wic2V0XCIsIFwic3RkaW5cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcInRhcmdldElkXCIpLFxuICAgIGRlc2NyaWJlOiBcImFjdGlvbiBzbG90cyBvbiBhIG5vZGUvcGVuZGluZyBwcm9wb3NhbFwiLFxuICAgIGNoZWNrOiBleGFjdGx5T25lTW9kZSxcbiAgICBydW46IG9uKGNtZEFjdGlvbnMpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWdzXCIsXG4gICAgZmxhZ3M6IFtcInNldFwiLCBcInN0ZGluXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJ0YXJnZXRJZFwiKSxcbiAgICBkZXNjcmliZTogXCJmcmVlZm9ybSB0YWdzIG9uIGEgbm9kZS9wZW5kaW5nIHByb3Bvc2FsXCIsXG4gICAgY2hlY2s6IGV4YWN0bHlPbmVNb2RlLFxuICAgIHJ1bjogb24oY21kVGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiBjcmVhdGVcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBqb2JcIixcbiAgICBydW46IG9uKGNtZEpvYkNyZWF0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiB1cGRhdGVcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiam9iSWRcIiksXG4gICAgZGVzY3JpYmU6IFwidXBkYXRlIGEgam9iXCIsXG4gICAgcnVuOiBvbihjbWRKb2JVcGRhdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJqb2IgY2xhaW1cIixcbiAgICBmbGFnczogW1wib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJjbGFpbSBhIGpvYiAoYXRvbWljIGxlYXNlKVwiLFxuICAgIHJ1bjogb24oY21kSm9iQ2xhaW0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJqb2IgcmVsZWFzZVwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJyZWxlYXNlIGEgam9iXCIsXG4gICAgcnVuOiBvbihjbWRKb2JSZWxlYXNlKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiam9iIHN1YnRhc2tcIixcbiAgICBmbGFnczogW1wiYWRkXCIsIFwiY2hlY2tcIiwgXCJ1bmNoZWNrXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiam9iSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiYWRkLCBjaGVjayBvciB1bmNoZWNrIGEgam9iJ3Mgc3ViLXRhc2tcIixcbiAgICBjaGVjazogb25lU3VidGFza09wLFxuICAgIHJ1bjogb24oY21kSm9iU3VidGFzayksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiBsaXN0XCIsXG4gICAgZmxhZ3M6IFtcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwibGlzdCBqb2JzXCIsXG4gICAgcnVuOiBvbihjbWRKb2JMaXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiam9iIGRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBqb2JcIixcbiAgICBydW46IG9uKGNtZEpvYkRlbGV0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGl2aXR5XCIsXG4gICAgZmxhZ3M6IFtcIm1lc3NhZ2VcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJzdGF0ZVwiKSxcbiAgICBkZXNjcmliZTogXCJ0aGUgY2FzdGluZy1sb29wIGxpdmVuZXNzIHNpZ25hbCAocmVjZWl2ZWR8dGhpbmtpbmd8aWRsZSlcIixcbiAgICBydW46IG9uKGNtZEFjdGl2aXR5KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJyb2xlXCIsIFwia2luZFwiLCBcImdyb3VuZFwiLCBcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwiZm9yY2VcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJwb3N0IGEgbWVzc2FnZVwiLFxuICAgIHJ1bjogb24oY21kU2VuZCksXG4gIH0sXG5dO1xuXG4vLyDim5QgQlVJTERJTkcgVEhFIFRBQkxFIEhBUyBOTyBTSURFIEVGRkVDVFMuIGBkZWZpbmVDbGlgIG9ubHkgdmFsaWRhdGVzIGFuZFxuLy8gaW5kZXhlczsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgcnVucy4gU28gYSBncmltb2lyZVxuLy8gd2FyZCwgb3IgYSB0ZXN0LCBjYW4gaW1wb3J0IHRoaXMgbW9kdWxlIGFuZCByZWFkIGBjbGkucmVjb2duaXplZEZsYWdzYCxcbi8vIGBjbGkuZmxhZ3NGb3JgIGFuZCBgY2xpLmRlY2xhcmF0aW9uKClgIHdpdGhvdXQgcnVubmluZyB0aGUgQ0xJLlxuZXhwb3J0IGNvbnN0IGNsaSA9IGRlZmluZUNsaSh7XG4gIG5hbWU6IFwibWluZC1tYXBwZXJcIixcbiAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gIGNvbW1hbmRzOiBST1dTLFxuICAvLyBUaGUgdmVyYiBpcyB0aGUgZmlyc3QgYXJndW1lbnQ6IGBtaW5kLW1hcHBlciAtLXByb2plY3QgcCBzdGF0ZWAgaXMgcmVmdXNlZFxuICAvLyBhcyBhbiB1bmtub3duIHJvb3QgZmxhZy4gQSBiYXJlIGAtLWAgbWFrZXMgdGhlIG5leHQgdG9rZW4gdGhlIHZlcmIgKGFjYyBBNikuXG4gIGdyYW1tYXI6IFwidmVyYi1maXJzdFwiLFxuICAvLyBgZG9jYCB0YWtlcyBmbGFncyBCRUZPUkUgaXRzIHN1Yi12ZXJiIChgZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSBEMWApLCBzb1xuICAvLyBpdHMgc3ViLXZlcmIgaXMgdGhlIGZpcnN0IHBvc2l0aW9uYWwsIG5vdCB0aGUgYWRqYWNlbnQgdG9rZW4uIFRoZSBvdGhlclxuICAvLyBncm91cHMgKG5vZGUsIHpvbmUsIHByb3Bvc2FsLCBsZW5zLCBqb2IpIGtlZXAgdGhlIGRlZmF1bHQ6IGFkamFjZW50LlxuICBncm91cHM6IHsgZG9jOiB7IHN1YlZlcmJBdDogXCJmaXJzdC1wb3NpdGlvbmFsXCIgfSB9LFxuICB2ZXJzaW9uOiB2ZXJzaW9uSW5mbyxcbiAgaGVscDogKCkgPT4gSEVMUCxcbn0pO1xuXG4vLyBUaGUgZGVyaXZlZCB2aWV3cyB0aGUgdGVzdHMgcmVhZC4gVkVSQlMgaXMgdGhlIHJvc3RlciAodGhlIG1vZHVsZSdzIG93blxuLy8gYHZlcnNpb25gLCBgc2NoZW1hYCBhbmQgYGhlbHBgIHJvd3MgaW5jbHVkZWQpOyBWRVJCX1NQRUMgaXMgZWFjaCBwYXRoJ3Ncbi8vIGFjY2VwdGVkIGZsYWdzLCBrZXllZCBieSBwYXRoIChgXCJub2RlIGVkaXRcImApLlxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS52ZXJicztcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgY2xpLnJvd3MubWFwKChyKSA9PiBbci5uYW1lLCByLmFjY2VwdGVkXSksXG4pO1xuZXhwb3J0IGNvbnN0IFJFQ09HTklaRURfRkxBR1M6IHJlYWRvbmx5IHN0cmluZ1tdID0gY2xpLnJlY29nbml6ZWRGbGFncztcblxuLyoqXG4gKiBUSEUgT05FIFBMQUNFIEEgRkFJTFVSRSBCRUNPTUVTIEFOIEVYSVQgQ09ERS4gRXZlcnkgcmFpc2UgaW4gdGhpcyBmaWxlIFRIUk9XU1xuICogKHRoZSBraXQncyBgZGllYC9gQ2xpRXJyb3JgKSwgYXJyaXZlcyBoZXJlLCBpcyB3cml0dGVuIGFzIE9ORSBKU09OIGVudmVsb3BlXG4gKiBvbiBzdGRlcnIsIGFuZCBiZWNvbWVzIGEgdGF4b25vbXkgZXhpdCBjb2RlIOKAlCBub3RoaW5nIGV4aXRzIGZyb20gaW5zaWRlIGFcbiAqIHZlcmIsIHNvIGEgbGFyZ2Ugc3Rkb3V0IHBheWxvYWQgaXMgbmV2ZXIgdHJ1bmNhdGVkLlxuICpcbiAqIGBjbGkuZGlzcGF0Y2hgLCBub3QgdGhlIHJlZ2lzdHJ5J3MgYG1haW5gLCBiZWNhdXNlIG1pbmQtbWFwcGVyIHRyaWFnZXMgdHdvXG4gKiByYXcgdGhyb3dzIHRoZSByZWdpc3RyeSBjYW5ub3Qga25vdyBhYm91dC5cbiAqXG4gKiDim5QgVEhFIEtJVCdTIFJFUE9SVEVSIFNJVFMgSU5TSURFIFRISVMgQ0hBSU4sIE5PVCBJTiBQTEFDRSBPRiBJVC4gSXQgd3JpdGVzXG4gKiB0aGUgZW52ZWxvcGUgZm9yIGEgdHlwZWQgZmFpbHVyZSBhbmQgcmV0dXJucyBgbnVsbGAgZm9yIGV2ZXJ5dGhpbmcgZWxzZSwgc29cbiAqIHRoZSB0d28gdXNhZ2UgY2xhc3NlcyBiZWxvdyBhcmUgY2xhc3NpZmllZCBIRVJFOiBhIGJvZHkgdGhhdCBmYWlsZWQgdG8gcGFyc2VcbiAqIGFzIEpTT04gKHN0ZGluLy0tYm9keS1maWxlKSwgYW5kIGEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICogKC0tZmlsZS8tLWRvYy1lZGl0KS4gQSBiYXJlIGByZXBvcnRDbGlFcnJvcihlKSA/PyByZXRocm93YCB3b3VsZCB0dXJuIGJvdGhcbiAqIGludG8gc3RhY2stdHJhY2UgY3Jhc2hlcyAoY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nKS4gTm9kZSdzIG93biBwYXJzZVxuICogcmVqZWN0aW9ucyBubyBsb25nZXIgcmVhY2ggaGVyZTogdGhlIHJlZ2lzdHJ5IGNhdGNoZXMgdGhlbSBhbmQgYW5zd2VycyB3aXRoXG4gKiB0aGUgdmVyYidzIGFjY2VwdGVkIHNldCBhcyBgY2hvaWNlc2AuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBjbGkuZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIEEgYm9keSB0aGF0IGZhaWxlZCB0byBwYXJzZSAoc3RkaW4vLS1ib2R5LWZpbGUgSlNPTikg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoZSBpbnN0YW5jZW9mIFN5bnRheEVycm9yKSByZXR1cm4gcmVwb3J0VXNhZ2UoYGludmFsaWQgSlNPTjogJHttc2d9YCk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUvLS1kb2MtZWRpdCBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydFVzYWdlKG1zZyk7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGZhdWx0OiBvbmUgSU5URVJOQUwgZW52ZWxvcGUsIG5ldmVyXG4gICAgLy8gYSBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcImludGVybmFsXCIsIG1zZykpO1xuICAgIHJldHVybiBFWElUX0ZPUi5pbnRlcm5hbDtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBDTEkncyBvbmUgZW50cnksIGNhbGxlZCBieSB0aGUgbGF1bmNoZXIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWluZC1tYXBwZXIvc2NyaXB0cy9jbGkudHNgLlxuICpcbiAqIOKblCBUSEVSRSBJUyBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBUSEFUIElTIFRIRSBQT0lOVC5cbiAqIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuICogZW50cnksIHNvIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGUgYnVuZGxlOiBhIGJsb2NrIGhlcmUgd291bGQgbmV2ZXJcbiAqIHJ1biBhbmQgdGhlIENMSSB3b3VsZCBwcmludCBub3RoaW5nIGFuZCBleGl0IDAgZm9yIGV2ZXJ5IHZlcmIuIFRoaXMgZXhwb3J0IGlzXG4gKiB3aGF0IHJlcGxhY2VzIGl0LiBBbmQgdGhlIHNvdXJjZSBrZWVwcyBubyBzZWNvbmQgZW50cnkgZGVsaWJlcmF0ZWx5IOKAlCB0aGVcbiAqIGFyaXRobWV0aWMgYWJvdmUgaXMgdHJ1ZSBhdCB0aGUgYXJ0aWZhY3QncyBhZGRyZXNzIGFuZCBmYWxzZSBhdCB0aGlzIGZpbGUncyxcbiAqIHNvIG9mZmVyaW5nIGBidW4gc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzYCB3b3VsZCBiZSBvZmZlcmluZyBhIHdyb25nXG4gKiBwcm9jZXNzIChwbGF5Ym9vayBCMykuXG4gKlxuICog4puUIElUIFJFVFVSTlMgVEhFIENPREUgUkFUSEVSIFRIQU4gU0VUVElORyBJVC4gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4gKiByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZVxuICogKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAqIGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seVxuICogdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lXG4gKiBzaGFwZSwgc2FtZSByZWFzb24uIFRoZSBhc3NpZ25tZW50IGhhcHBlbnMgb25jZSwgaW4gdGhlIGxhdW5jaGVyLiBEbyBub3QgdGlkeVxuICogdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUzogdGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgUEFSU0VTXG4gKiBpdCwgd2hpY2ggaXMgdGhpcyBvbmUuIEEgbGF1bmNoZXIgcmVhZGluZyB0aGUgYXJndW1lbnQgdmVjdG9yIHdvdWxkIG1hdGNoIHRoZVxuICogYXJnLXBhcnNpbmcgcHJlZGljYXRlIGluIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBUaGUgbW9kdWxlIGFkZHMgYGhlbHBgLCBgdmVyc2lvbmAgYW5kIGBzY2hlbWFgIHJvd3MgdW5sZXNzIHRoZSBzcGVsbCBkZWZpbmVzXG4gKiBhIHJvdyBvZiB0aGF0IG5hbWUgKGdyYXBldmluZSdzIGB2ZXJzaW9uIC0taHVtYW5gKS4gVGhleSBhcmUgb3JkaW5hcnkgcm93czpcbiAqIGRlY2xhcmVkLCBzdHJpY3QsIGFuZCBnaXZlbiBgZ2xvYmFsRmxhZ3NgIGxpa2UgZXZlcnkgb3RoZXIgcm93LlxuICovXG5cbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBDbGlFcnJvciwgZGllLCByZXBvcnRDbGlFcnJvciwgc2V0Q3VycmVudENvbW1hbmQgfSBmcm9tIFwiLi4vd2lyZS9lcnJvcnNcIjtcblxuLy8g4pSA4pSAIHR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgdHlwZSBGbGFnVHlwZSA9IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjtcblxuLyoqIE9uZSBgcGFyc2VBcmdzYCBvcHRpb24sIHBsdXMgdGhlIGBkZWZhdWx0YCBub2RlJ3MgcGFyc2VyIGFsc28gdGFrZXMuICovXG5leHBvcnQgdHlwZSBPcHRpb25TcGVjID0ge1xuICB0eXBlOiBGbGFnVHlwZTtcbiAgbXVsdGlwbGU/OiBib29sZWFuO1xuICBzaG9ydD86IHN0cmluZztcbiAgZGVmYXVsdD86IHN0cmluZyB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHJlYWRvbmx5IGJvb2xlYW5bXTtcbn07XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnNUYWJsZSA9IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIE9wdGlvblNwZWM+PjtcblxuZXhwb3J0IHR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG5leHBvcnQgdHlwZSBGbGFnVmFsdWUgPSBzdHJpbmcgfCBib29sZWFuIHwgKHN0cmluZyB8IGJvb2xlYW4pW107XG5cbmV4cG9ydCB0eXBlIEludm9jYXRpb248RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSB7XG4gIC8qKiBUaGUgcmVzb2x2ZWQgcm93IG5hbWU6IGBcIm9wZW5cImAsIGBcIm5vZGUgZWRpdFwiYCwgb3IgYFwiXCJgIGZvciBhIHZlcmJsZXNzIHJvb3QuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzcGVsbGluZyB0aGUgY2FsbGVyIHVzZWQg4oCUIGFuIGFsaWFzLCB3aGVuIG9uZSB3YXMgdXNlZC4gKi9cbiAgdG9rZW46IHN0cmluZztcbiAgLyoqIFBvc2l0aW9uYWxzIGFmdGVyIHRoZSBwYXRoLiAqL1xuICBwb3M6IHN0cmluZ1tdO1xuICAvKiogRmxhZ3MgZ2l2ZW4sIHBsdXMgdGhlIGRlZmF1bHRzIG9mIHRoZSBmbGFncyB0aGlzIHJvdyBhY2NlcHRzLiAqL1xuICBmbGFnczogUGFydGlhbDxSZWNvcmQ8RiwgRmxhZ1ZhbHVlPj47XG59O1xuXG5leHBvcnQgdHlwZSBDb21tYW5kU3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIGBcIm9wZW5cImA7IG9uZSBzcGFjZSBtZWFucyBvbmUgbGV2ZWwgb2YgbmVzdGluZzogYFwibm9kZSBlZGl0XCJgLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFYWNoIGFsaWFzIGlzIGRpc3BhdGNoYWJsZSwgbGlzdGVkIGluIGB2ZXJic2AsIGFuZCBnZXRzIGl0cyBvd24gZGVjbGFyZWRcbiAgICogIHJvdy4gQW4gYWxpYXMgb2YgYSBuZXN0ZWQgcm93IG11c3Qgc2hhcmUgaXRzIGdyb3VwOiBgXCJub2RlIGNoYW5nZVwiYC4gKi9cbiAgYWxpYXNlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhpcyByb3cncyBvd24gZmxhZ3M7IGBnbG9iYWxGbGFnc2AgYXJlIGFkZGVkIHRvIHRoZW0uICovXG4gIGZsYWdzOiByZWFkb25seSBGW107XG4gIC8qKiBBcml0eSBpcyBlbmZvcmNlZCBmcm9tIHRoaXMsIGFuZCBpdCBpcyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcy4gKi9cbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIC8qKiBPbmUgbGluZSBmb3IgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBBZGRlZCBhcyB0aGUgYGhpbnRgIG9mIHRoaXMgcm93J3MgZmxhZyByZWplY3Rpb25zLiAqL1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICAvKiogYGZhbHNlYCBoYW5kcyBub2RlJ3Mgb3duIFwiVW5leHBlY3RlZCBhcmd1bWVudFwiIHJlZnVzYWwgYW55IHBvc2l0aW9uYWwuICovXG4gIGFsbG93UG9zaXRpb25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogRmxhZy1kZXBlbmRlbnQgYXJpdHkgKGltYWdvIGBoYW5kb2ZmIC0tY2xlYXJgLCBtaW5kLW1hcHBlciBgLS10b3wtLWNsZWFyYClcbiAgICogYW5kIGFueSBvdGhlciBjb21iaW5hdGlvbiBydWxlLiBSdW5zIGFmdGVyIHRoZSBhcml0eSBjaGVjazsgYSByZXR1cm5lZFxuICAgKiBzdHJpbmcgaXMgcmVmdXNlZCBhcyBhIHVzYWdlIGVycm9yIG5hbWluZyB0aGlzIHJvdy4g4pqgIFRoZSBkZWNsYXJhdGlvblxuICAgKiBjYW5ub3QgZXhwcmVzcyBzdWNoIGEgcnVsZTogYSBwb3NpdGlvbmFsIHRoYXQgYC0tY2xlYXJgIG1ha2VzIHVubmVjZXNzYXJ5XG4gICAqIGNhbiBvbmx5IGJlIGRlY2xhcmVkIGByZXF1aXJlZDogZmFsc2VgLCBhbmQgdGhpcyBob29rIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgKi9cbiAgY2hlY2s/OiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIG51bWJlciBpcyB0aGUgZXhpdCBjb2RlOyBhbnl0aGluZyBlbHNlIG1lYW5zIDAuICovXG4gIHJ1bjogKGludjogSW52b2NhdGlvbjxGPikgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBBIHZlcmJsZXNzIENMSSdzIG9uZSByb3cgKGRpZ2VzdGlmeSkuIGBwYXRoOiBbXWAgaW4gdGhlIGRlY2xhcmF0aW9uLiAqL1xuZXhwb3J0IHR5cGUgUm9vdFNwZWM8RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSBPbWl0PENvbW1hbmRTcGVjPEY+LCBcIm5hbWVcIiB8IFwiYWxpYXNlc1wiPjtcblxuLyoqXG4gKiBXaGVyZSBhIGdyb3VwJ3Mgc3ViLXZlcmIgaXMgZm91bmQuXG4gKiAtIGBhZGphY2VudGAgKGRlZmF1bHQpOiB0aGUgdG9rZW4gcmlnaHQgYWZ0ZXIgdGhlIGdyb3VwIChgbm9kZSBlZGl0IFhgKS5cbiAqIC0gYGZpcnN0LXBvc2l0aW9uYWxgOiB0aGUgZmlyc3QgdG9rZW4gYWZ0ZXIgdGhlIGdyb3VwIHRoYXQgaXMgbmVpdGhlciBhIGZsYWdcbiAqICAgbm9yIGEgc3RyaW5nIGZsYWcncyB2YWx1ZSwgc28gZmxhZ3MgbWF5IGNvbWUgZmlyc3Q6XG4gKiAgIGBkb2MgLS1wcm9qZWN0IFAgZGVsZXRlIEQxIC0tZm9yY2VgIHJlc29sdmVzIHRvIGBkb2MgZGVsZXRlYCAobWluZC1tYXBwZXIpLlxuICogICBUaGUgc2NhbiBzdG9wcyBhdCBhIGJhcmUgYC0tYCwgd2hpY2ggaXMgdGhlIGVzY2FwZSBoYXRjaCBmb3IgYSBwb3NpdGlvbmFsXG4gKiAgIGxpdGVyYWxseSBuYW1lZCBsaWtlIGEgc3ViLXZlcmI6IGBkb2MgLS0gZGVsZXRlYCByZWFkcyB0aGUgZG9jIFwiZGVsZXRlXCIuXG4gKi9cbmV4cG9ydCB0eXBlIEdyb3VwU3BlYyA9IHsgc3ViVmVyYkF0PzogXCJhZGphY2VudFwiIHwgXCJmaXJzdC1wb3NpdGlvbmFsXCIgfTtcblxuZXhwb3J0IHR5cGUgQ2xpU3BlYzxPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPiA9IHtcbiAgLyoqIGBcImJvdW50eVwiYCwgdXNlZCBpbiBtZXNzYWdlcyBhbmQgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSByZW5kZXJlZCBoZWxwJ3MgZmlyc3QgbGluZTogYCR7bmFtZX0g4oCUICR7c3VtbWFyeX1gLiAqL1xuICBzdW1tYXJ5Pzogc3RyaW5nO1xuICAvKiogVGhlIGxpdGVyYWwgYENMSV9PUFRJT05TYCBvYmplY3QuICovXG4gIG9wdGlvbnM6IE87XG4gIGNvbW1hbmRzPzogcmVhZG9ubHkgQ29tbWFuZFNwZWM8a2V5b2YgTyAmIHN0cmluZz5bXTtcbiAgLyoqXG4gICAqIEEgdmVyYmxlc3MgQ0xJJ3Mgcm93LiBSZXNlcnZlZCB0b2tlbnMgYXMgYGFyZ3ZbMF1gIHN0aWxsIHNlbGVjdCB0aGVpciByb3dzXG4gICAqIChgaGVscGAsIGB2ZXJzaW9uYCwgYHNjaGVtYWAsIGFueSBgY29tbWFuZHNgLCBhbmQgdGhlIGludGVyY2VwdG9ycyk7IGV2ZXJ5XG4gICAqIG90aGVyIGFyZ3YsIHRoZSBlbXB0eSBvbmUgaW5jbHVkZWQsIGJlbG9uZ3MgdG8gdGhlIHJvb3QuIEEgcG9zaXRpb25hbCB0aGF0XG4gICAqIGhhcHBlbnMgdG8gc3BlbGwgYSByZXNlcnZlZCB0b2tlbiBnb2VzIGFmdGVyIGEgYmFyZSBgLS1gLlxuICAgKi9cbiAgcm9vdD86IFJvb3RTcGVjPGtleW9mIE8gJiBzdHJpbmc+O1xuICAvKiogQWNjZXB0ZWQgYnkgZXZlcnkgcm93LCBieSBjb250cmFjdCAoZ3JhcGV2aW5lJ3MgYC0tYXNgL2AtLWZyb21gKS4gKi9cbiAgZ2xvYmFsRmxhZ3M/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgZ3JhbW1hcj86IFwidmVyYi1maXJzdFwiIHwgXCJmbGFncy1hbnl3aGVyZVwiO1xuICAvKiogUGVyLWdyb3VwIHN1Yi12ZXJiIHBsYWNlbWVudCwga2V5ZWQgYnkgdGhlIGdyb3VwIHRva2VuIChgXCJkb2NcImApLiAqL1xuICBncm91cHM/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBHcm91cFNwZWM+PjtcbiAgLyoqIFRoZSByb290IHJvdydzIHBvc2l0aW9uYWwgbmFtZSBpbiBgc2NoZW1hYCAoYFwiY29tbWFuZFwiYDsgZ2xhbW91cjogYFwidmVyYlwiYCkuICovXG4gIHZlcmJQb3NpdGlvbmFsPzogc3RyaW5nO1xuICAvKiogRmxhZ3MgbGVmdCBvZmYgZXZlcnkgdXNhZ2UgbGluZSAoZ2xhbW91cidzIHBlci12ZXJiIGBzZXNzaW9uYCkuICovXG4gIHVzYWdlSGlkZXM/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgLyoqIFRoZSBgdmVyc2lvbmAgcm93J3MgcGF5bG9hZCwgYHtuYW1lLCB2ZXJzaW9ufWAuICovXG4gIHZlcnNpb246ICgpID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gIC8qKiBSZXBsYWNlcyB0aGUgcmVuZGVyZWQgaGVscCAoZ3JhcGV2aW5lKS4gKi9cbiAgaGVscD86ICgpID0+IHN0cmluZztcbiAgLyoqIEFwcGVuZGVkIGJlbG93IHRoZSByZW5kZXJlZCByb3dzLiAqL1xuICBoZWxwRm9vdGVyPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgRGVjbGFyZWRBcmcgPSB7IG5hbWU6IHN0cmluZzsgdHlwZTogRmxhZ1R5cGU7IHN0YXR1czogXCJ2YWxpZFwiIH07XG5leHBvcnQgdHlwZSBEZWNsYXJlZENvbW1hbmQgPSB7XG4gIHBhdGg6IHN0cmluZ1tdO1xuICBhcmdzOiBEZWNsYXJlZEFyZ1tdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbn07XG5leHBvcnQgdHlwZSBEZWNsYXJhdGlvbiA9IHtcbiAgZm9ybWF0VmVyc2lvbjogXCIwXCI7XG4gIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiO1xuICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogc3RyaW5nW10gfTtcbiAgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdO1xufTtcblxuLyoqIEEgcm93IGFzIHRoZSBtb2R1bGUgaG9sZHMgaXQsIGZvciB0ZXN0cyBhbmQgd2FyZHMuICovXG5leHBvcnQgdHlwZSBSb3dWaWV3ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhlIHJvdydzIG93biBmbGFncywgYXMgZGVjbGFyZWQuICovXG4gIGZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIE93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2AsIGluIG9wdGlvbnMtdGFibGUgb3JkZXIuICovXG4gIGFjY2VwdGVkOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBgdHJ1ZWAgZm9yIGEgYGhlbHBgL2B2ZXJzaW9uYC9gc2NoZW1hYCByb3cgdGhlIG1vZHVsZSBhZGRlZC4gKi9cbiAgYXV0bzogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIENsaSA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogRW52ZWxvcGUgb24gZmFpbHVyZSwgcmV0dXJucyB0aGUgZXhpdCBjb2RlLiBGb3IgdGhlIHNwZWxsJ3MgYHJ1bigpYC4gKi9cbiAgbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPjtcbiAgLyoqIFRocm93cyBgQ2xpRXJyb3JgLCBmb3IgYSBzcGVsbCB3aG9zZSBtYWluIGRvZXMgaXRzIG93biB0cmlhZ2UuICovXG4gIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICBkZWNsYXJhdGlvbigpOiBEZWNsYXJhdGlvbjtcbiAgcmVuZGVySGVscCgpOiBzdHJpbmc7XG4gIC8qKiBBIHJvdydzIHVzYWdlIGxpbmUgKGBcImNsb3NlIDxpZD4gWy0tZm9yY2VdXCJgKTsgYFwiXCJgIGZvciBhbiB1bmtub3duIHBhdGguICovXG4gIHVzYWdlT2YocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogRXZlcnkgZmlyc3QgdG9rZW4gdGhhdCBkaXNwYXRjaGVzOiB2ZXJicywgYWxpYXNlcyBhbmQgZ3JvdXAgdG9rZW5zLiAqL1xuICB2ZXJiczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmdWxsIHBhdGggdGhhdCBkaXNwYXRjaGVzLCBhbGlhc2VzIGluY2x1ZGVkIChgXCJub2RlIGVkaXRcImApLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIHJvdydzIGFjY2VwdGVkIHNldCBhcyBgLS14YCBzcGVsbGluZ3MsIHNvcnRlZC4gYFwiXCJgIGlzIHRoZSByb290LiAqL1xuICBmbGFnc0ZvcihwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZsYWcgaW4gdGhlIG9wdGlvbnMgdGFibGUsIGFzIGAtLXhgLCBpbiB0YWJsZSBvcmRlci4gKi9cbiAgcmVjb2duaXplZEZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcm93czogcmVhZG9ubHkgUm93Vmlld1tdO1xufTtcblxuLy8g4pSA4pSAIGludGVybmFscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxudHlwZSBSb3cgPSBSb3dWaWV3ICYge1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICBhbGxvd1Bvc2l0aW9uYWxzOiBib29sZWFuO1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGNoZWNrOiBjLmNoZWNrIGFzIFJvd1tcImNoZWNrXCJdLFxuICAgICAgcnVuOiBjLnJ1biBhcyBSb3dbXCJydW5cIl0sXG4gICAgfTtcbiAgfTtcblxuICBjb25zdCByb3dzOiBSb3dbXSA9IChzcGVjLmNvbW1hbmRzID8/IFtdKS5tYXAoKGMpID0+IHRvUm93KGMgYXMgQ29tbWFuZFNwZWMsIGZhbHNlKSk7XG5cbiAgLy8gVGhlIGF1dG8gcm93cy4gQWRkZWQgbGFzdCwgaW4gdGhpcyBvcmRlciwgdW5sZXNzIHRoZSBzcGVsbCBoYXMgaXRzIG93bi5cbiAgY29uc3QgY2xpID0ge30gYXMgQ2xpO1xuICBjb25zdCBhdXRvUm93czogQ29tbWFuZFNwZWNbXSA9IFtcbiAgICB7XG4gICAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3Mge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVwiLFxuICAgICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHByaW50SnNvbihhd2FpdCBzcGVjLnZlcnNpb24oKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShjbGkuZGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJoZWxwXCIsXG4gICAgICBmbGFnczogW10sXG4gICAgICBwb3NpdGlvbmFsczogW10sXG4gICAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXCIsXG4gICAgICBydW46ICgpID0+IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGNsaS5yZW5kZXJIZWxwKCk7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHRleHQuZW5kc1dpdGgoXCJcXG5cIikgPyB0ZXh0IDogYCR7dGV4dH1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgXTtcbiAgZm9yIChjb25zdCBhIG9mIGF1dG9Sb3dzKSB7XG4gICAgaWYgKCFyb3dzLnNvbWUoKHIpID0+IHIubmFtZSA9PT0gYS5uYW1lKSkgcm93cy5wdXNoKHRvUm93KGEsIHRydWUpKTtcbiAgfVxuXG4gIGNvbnN0IHJvb3RSb3c6IFJvdyB8IHVuZGVmaW5lZCA9XG4gICAgc3BlYy5yb290ID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB0b1Jvdyh7IC4uLihzcGVjLnJvb3QgYXMgUm9vdFNwZWMpLCBuYW1lOiBcIlwiIH0sIGZhbHNlKTtcblxuICAvLyBJbmRleCBldmVyeSBzcGVsbGluZywgYW5kIGNoZWNrIHRoZSB0YWJsZSBpcyB3ZWxsIGZvcm1lZC5cbiAgY29uc3QgYnlUb2tlbiA9IG5ldyBNYXA8c3RyaW5nLCBSb3c+KCk7XG4gIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgZm9yIChjb25zdCB0IG9mIFtyLm5hbWUsIC4uLnIuYWxpYXNlc10pIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gdC5zcGxpdChcIiBcIik7XG4gICAgICBpZiAodC50cmltKCkgIT09IHQgfHwgcGFydHMubGVuZ3RoID4gMiB8fCBwYXJ0cy5zb21lKChwKSA9PiBwID09PSBcIlwiIHx8IHAuc3RhcnRzV2l0aChcIi1cIikpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBiYWQgY29tbWFuZCBuYW1lIFwiJHt0fVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAodCAhPT0gci5uYW1lICYmIHBhcnRzLmxlbmd0aCAhPT0gci5uYW1lLnNwbGl0KFwiIFwiKS5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3QgbmVzdCBsaWtlIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPT09IDIgJiYgdCAhPT0gci5uYW1lICYmIHBhcnRzWzBdICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpWzBdKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBhbGlhcyBcIiR7dH1cIiBtdXN0IHNoYXJlIHRoZSBncm91cCBvZiBcIiR7ci5uYW1lfVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAoYnlUb2tlbi5oYXModCkpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBcIiR7dH1cIiBpcyBkZWZpbmVkIHR3aWNlYCk7XG4gICAgICBieVRva2VuLnNldCh0LCByKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc3Vic09mID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IHQgb2YgYnlUb2tlbi5rZXlzKCkpIHtcbiAgICBjb25zdCBbZ3JvdXAsIHN1Yl0gPSB0LnNwbGl0KFwiIFwiKTtcbiAgICBpZiAoZ3JvdXAgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgc3Vic09mLnNldChncm91cCwgWy4uLihzdWJzT2YuZ2V0KGdyb3VwKSA/PyBbXSksIHN1Yl0pO1xuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IGcgb2YgT2JqZWN0LmtleXMoc3BlYy5ncm91cHMgPz8ge30pKSB7XG4gICAgaWYgKCFzdWJzT2YuaGFzKGcpKSB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ3JvdXAgXCIke2d9XCIgaGFzIG5vIHN1Yi12ZXJic2ApO1xuICB9XG5cbiAgY29uc3QgcGF0aHMgPSBbLi4uYnlUb2tlbi5rZXlzKCldO1xuICBjb25zdCB2ZXJicyA9IFsuLi5uZXcgU2V0KHBhdGhzLm1hcCgocCkgPT4gcC5zcGxpdChcIiBcIilbMF0gYXMgc3RyaW5nKSldO1xuXG4gIGNvbnN0IHJvd0ZvciA9IChwYXRoOiBzdHJpbmcpOiBSb3cgfCB1bmRlZmluZWQgPT4gKHBhdGggPT09IFwiXCIgPyByb290Um93IDogYnlUb2tlbi5nZXQocGF0aCkpO1xuICBjb25zdCBmbGFnc0ZvciA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICAgIFsuLi4ocm93Rm9yKHBhdGgpPy5hY2NlcHRlZCA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcbiAgY29uc3QgbGFiZWwgPSAocjogUm93KTogc3RyaW5nID0+IHIubmFtZSB8fCBjbGlOYW1lO1xuXG4gIC8qKlxuICAgKiBBIHZlcmJsZXNzIHJvb3QncyByZWplY3Rpb24gYGNob2ljZXNgOiBpdHMgb3duIGZsYWdzIFBMVVMgdGhlIGludGVyY2VwdG9ycyxcbiAgICogYmVjYXVzZSB0aGUgZGVjbGFyYXRpb24gcHVibGlzaGVzIGJvdGggYXQgYHBhdGg6IFtdYCBhbmQgdGhlIHJvb3QgYW5zd2Vyc1xuICAgKiBib3RoICh0aGUgaW50ZXJjZXB0b3JzIGFzIGBhcmd2WzBdYCkuIExlYXZpbmcgdGhlIGludGVyY2VwdG9ycyBvdXQgbWFkZVxuICAgKiBvbmUgcHJvY2VzcyBzYXkgdHdvIHRoaW5ncyBhYm91dCBpdHMgcm9vdCDigJQgYWNjJ3MgY2Vuc3VzIHJlYWQgYC0taGVscGAsXG4gICAqIGAtaGAsIGAtLXZlcnNpb25gIGFuZCBgLVZgIGFzIGRlY2xhcmVkLW5vdC1hY2NlcHRlZC4gTG9uZyBzcGVsbGluZ3MgZmlyc3RcbiAgICogKHNvcnRlZCksIHRoZW4gdGhlIHNob3J0czogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0XG4gICAqIHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcuXG4gICAqL1xuICBjb25zdCByb290Q2hvaWNlczogc3RyaW5nW10gPSAoKCkgPT4ge1xuICAgIGNvbnN0IGFsbCA9IFsuLi5mbGFnc0ZvcihcIlwiKSwgLi4uSU5URVJDRVBUT1JfQ0hPSUNFU107XG4gICAgY29uc3QgbG9uZyA9IGFsbC5maWx0ZXIoKGYpID0+IGYuc3RhcnRzV2l0aChcIi0tXCIpKS5zb3J0KCk7XG4gICAgcmV0dXJuIFsuLi5sb25nLCAuLi5hbGwuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLS1cIikpXTtcbiAgfSkoKTtcblxuICAvLyDilIDilIAgaGVscCDilIDilIBcblxuICBjb25zdCByZW5kZXJQb3NpdGlvbmFsID0gKHA6IFBvc2l0aW9uYWxTcGVjKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBpbm5lciA9IHAudmFyaWFkaWMgPyBgJHtwLm5hbWV9Li4uYCA6IHAubmFtZTtcbiAgICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbiAgfTtcbiAgY29uc3QgcmVuZGVyRmxhZyA9IChrOiBzdHJpbmcpOiBzdHJpbmcgPT5cbiAgICBzcGVjLm9wdGlvbnNba10/LnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG4gIGNvbnN0IHVzYWdlTGluZSA9IChyOiBSb3cpOiBzdHJpbmcgPT5cbiAgICBbXG4gICAgICBsYWJlbChyKSxcbiAgICAgIC4uLnIucG9zaXRpb25hbHMubWFwKHJlbmRlclBvc2l0aW9uYWwpLFxuICAgICAgLi4uci5mbGFncy5maWx0ZXIoKGspID0+ICFoaWRlcy5oYXMoaykpLm1hcChyZW5kZXJGbGFnKSxcbiAgICBdLmpvaW4oXCIgXCIpO1xuICBjb25zdCBleHBlY3RzID0gKHI6IFJvdyk6IHN0cmluZyA9PiBgZXhwZWN0czogJHt1c2FnZUxpbmUocil9YDtcblxuICBjb25zdCByZW5kZXJIZWxwID0gKCk6IHN0cmluZyA9PiB7XG4gICAgaWYgKHNwZWMuaGVscCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gc3BlYy5oZWxwKCk7XG4gICAgY29uc3QgbGlzdGVkID0gWy4uLihyb290Um93ID8gW3Jvb3RSb3ddIDogW10pLCAuLi5yb3dzXTtcbiAgICBjb25zdCBsaW5lcyA9IGxpc3RlZC5tYXAoKHIpID0+IFt1c2FnZUxpbmUociksIHIuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLmxpbmVzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gICAgY29uc3QgYm9keSA9IGxpbmVzXG4gICAgICAubWFwKChbdSwgZF0pID0+XG4gICAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gc3BlYy5zdW1tYXJ5ID8gYCR7Y2xpTmFtZX0g4oCUICR7c3BlYy5zdW1tYXJ5fWAgOiBjbGlOYW1lO1xuICAgIGNvbnN0IHRva2VucyA9IGAgICR7SU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OYDtcbiAgICByZXR1cm4gYCR7aGVhZH1cXG5cXG4ke2JvZHl9XFxuJHt0b2tlbnN9JHtzcGVjLmhlbHBGb290ZXIgPyBgXFxuXFxuJHtzcGVjLmhlbHBGb290ZXJ9YCA6IFwiXCJ9YDtcbiAgfTtcblxuICAvLyDilIDilIAgdGhlIGRlY2xhcmF0aW9uIOKUgOKUgFxuXG4gIGNvbnN0IGRlY2xhcmF0aW9uID0gKCk6IERlY2xhcmF0aW9uID0+IHtcbiAgICBjb25zdCBhcmcgPSAoazogc3RyaW5nKTogRGVjbGFyZWRBcmcgPT4gKHtcbiAgICAgIG5hbWU6IGAtLSR7a31gLFxuICAgICAgdHlwZTogKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS50eXBlLFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXRoOiBbXSxcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgIC4uLklOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICAuLi4ocm9vdFJvdyA/IHJvb3RSb3cuYWNjZXB0ZWQubWFwKGFyZykgOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHBvc2l0aW9uYWxzOiByb290Um93XG4gICAgICAgICAgPyByb290Um93LnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSlcbiAgICAgICAgICA6IFt7IG5hbWU6IHNwZWMudmVyYlBvc2l0aW9uYWwgPz8gXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiB0LnNwbGl0KFwiIFwiKSxcbiAgICAgICAgICBhcmdzOiByLmFjY2VwdGVkLm1hcChhcmcpLFxuICAgICAgICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzY2hlbWFSb3cgPSBieVRva2VuLmdldChcInNjaGVtYVwiKSBhcyBSb3c7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW3NjaGVtYVJvdy5uYW1lXSB9LFxuICAgICAgY29tbWFuZHMsXG4gICAgfTtcbiAgfTtcblxuICAvLyDilIDilIAgZGlzcGF0Y2gg4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSBpbmRleCBvZiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmcgZmxhZydzXG4gICAqIHZhbHVlLCB3YWxraW5nIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsOiBgLS1rIHZgIGNvbnN1bWVzIGB2YCB3aGVuIGBrYCBpcyBhXG4gICAqIHN0cmluZyBmbGFnLCBgLS1rPXZgIGNvbnN1bWVzIG5vdGhpbmcsIGAtcyB2YCBsaWtld2lzZSBieSB0aGUgc2hvcnQncyB0eXBlLlxuICAgKiBBdCBhIGJhcmUgYC0tYDogYC0xYCB3aGVuIGBzdG9wQXRUZXJtaW5hdG9yYCwgZWxzZSB0aGUgaW5kZXggYWZ0ZXIgaXQuXG4gICAqL1xuICBjb25zdCBzY2FuUG9zaXRpb25hbCA9IChhcmdzOiBzdHJpbmdbXSwgc3RvcEF0VGVybWluYXRvcjogYm9vbGVhbik6IG51bWJlciA9PiB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBhID0gYXJnc1tpXSBhcyBzdHJpbmc7XG4gICAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gc3RvcEF0VGVybWluYXRvciB8fCBpICsgMSA+PSBhcmdzLmxlbmd0aCA/IC0xIDogaSArIDE7XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNwZWMub3B0aW9uc1thLnNsaWNlKDIpXT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpICYmIGEubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBrZXkgPSBhLmxlbmd0aCA9PT0gMiA/IHNob3J0VG9LZXkuZ2V0KGEuc2xpY2UoMSkpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgc3BlYy5vcHRpb25zW2tleV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIGNvbnN0IHdpdGhvdXQgPSAoYXJnczogc3RyaW5nW10sIGk6IG51bWJlcik6IHN0cmluZ1tdID0+IFtcbiAgICAuLi5hcmdzLnNsaWNlKDAsIGkpLFxuICAgIC4uLmFyZ3Muc2xpY2UoaSArIDEpLFxuICBdO1xuXG4gIGNvbnN0IG5vQ29tbWFuZCA9ICgpOiBuZXZlciA9PlxuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VgLFxuICAgIH0pO1xuXG4gIC8qKiBBIHZlcmIgY2FuZGlkYXRlIGFuZCB0aGUgYXJncyBhZnRlciBpdCwgdG8gYSByb3cgYW5kIHRoYXQgcm93J3MgYXJncy4gKi9cbiAgY29uc3QgcmVzb2x2ZSA9IChjYW5kOiBzdHJpbmcsIHJlc3Q6IHN0cmluZ1tdKTogeyByb3c6IFJvdzsgdG9rZW46IHN0cmluZzsgYXJnczogc3RyaW5nW10gfSA9PiB7XG4gICAgY29uc3Qgc3VicyA9IHN1YnNPZi5nZXQoY2FuZCk7XG4gICAgaWYgKHN1YnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXQgPSBzcGVjLmdyb3Vwcz8uW2NhbmRdPy5zdWJWZXJiQXQgPz8gXCJhZGphY2VudFwiO1xuICAgICAgbGV0IGkgPSAtMTtcbiAgICAgIGlmIChhdCA9PT0gXCJhZGphY2VudFwiKSB7XG4gICAgICAgIGNvbnN0IG5leHQgPSByZXN0WzBdO1xuICAgICAgICBpID0gbmV4dCAhPT0gdW5kZWZpbmVkICYmICFuZXh0LnN0YXJ0c1dpdGgoXCItXCIpID8gMCA6IC0xO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaSA9IHNjYW5Qb3NpdGlvbmFsKHJlc3QsIHRydWUpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3ViID0gaSA+PSAwID8gKHJlc3RbaV0gYXMgc3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZ1bGwgPSBzdWIgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGJ5VG9rZW4uZ2V0KGAke2NhbmR9ICR7c3VifWApO1xuICAgICAgaWYgKGZ1bGwgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4geyByb3c6IGZ1bGwsIHRva2VuOiBgJHtjYW5kfSAke3N1Yn1gLCBhcmdzOiB3aXRob3V0KHJlc3QsIGkpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBvd24gPSBieVRva2VuLmdldChjYW5kKTtcbiAgICAgIGlmIChvd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcm93OiBvd24sIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gICAgICBjb25zdCBleHRyYSA9IHsgY2hvaWNlczogWy4uLnN1YnNdLCBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgIH07XG4gICAgICBpZiAoc3ViID09PSB1bmRlZmluZWQpIGRpZShgJHtjYW5kfTogZXhwZWN0ZWQgYSBzdWItY29tbWFuZGAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgICAgZGllKGB1bmtub3duICR7Y2FuZH0gc3ViLWNvbW1hbmQ6IFwiJHtzdWJ9XCJgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICB9XG4gICAgY29uc3Qgcm93ID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoYHVua25vd24gY29tbWFuZCBcIiR7Y2FuZH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJvdywgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgfTtcblxuICAvKipcbiAgICogQ29udHJhY3QgNSdzIGAtLWAgbWFkZSB0aGUgY2FsbGVyJ3MgZmxhZyBURVhUOyBzYXkgc28gKGMxLFxuICAgKiBgZG9jcy9pdGVtcy90ZXJtaW5hdG9yLWVhdHMtc2Vzc2lvbi1rZXkubWRgKS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHNcbiAgICogYSBmbGFnIHRoaXMgcm93IGFjY2VwdHMg4oCUIGAtLWtgLCBgLS1rPXZgLCBvciB0aGUgc2hvcnQgYC1zYCBvZiBhbiBhY2NlcHRlZFxuICAgKiBga2AsIGdsb2JhbHMgaW5jbHVkZWQg4oCUIGlzIG5hbWVkIGluIE9ORSBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIsIHdpdGhcbiAgICogdGhlIG1vdmUgdGhhdCByZWNvdmVycyBpdC4gU3Rkb3V0IGFuZCB0aGUgZXhpdCBjb2RlIGRvIG5vdCBjaGFuZ2UsIGFuZCB0aGVcbiAgICogcm93IHN0aWxsIHJ1bnM6IHRleHQgY29udGFpbmluZyBhIGZsYWcgbmFtZSBpcyBsZWdpdGltYXRlLCB3aGljaCBpcyB3aGF0XG4gICAqIGAtLWAgaXMgZm9yLiBBIHRva2VuIHRoZSByb3cgZG9lcyBub3QgYWNjZXB0IGlzIGp1c3QgdGV4dCwgYW5kIHNheXMgbm90aGluZy5cbiAgICpcbiAgICog4pqgIENhbGxlZCBvbmx5IG9uY2UgZXZlcnkgcmVmdXNhbCBoYXMgcGFzc2VkLCBzbyBhIHJlZnVzZWQgaW52b2NhdGlvbidzXG4gICAqIHN0ZGVyciBpcyBzdGlsbCBleGFjdGx5IG9uZSBlbnZlbG9wZS4gVGhlIGAjIGAgcHJlZml4IGlzIHRoZSBob3VzZSdzXG4gICAqIHN1Y2Nlc3MtcGF0aCBzdGRlcnIgZm9ybSAoYCMgd2FybmluZzpgIGluIG1pbmQtbWFwcGVyLCBgIyBwaW5uZWQgYm9hcmRgLFxuICAgKiBgIyDihpIgY2hhbm5lbGApOiBhbiBlbnZlbG9wZSByZWFkZXIgbG9va3MgZm9yIGEgYHtgIGxpbmUgYW5kIHNraXBzIGl0LlxuICAgKi9cbiAgY29uc3Qgd2FybkRlbW90ZWQgPSAoXG4gICAgcm93OiBSb3csXG4gICAgYWNjZXB0ZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gICAgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBlbmQgPSB0b2tlbnM/LmZpbmRJbmRleCgodCkgPT4gdC5raW5kID09PSBcIm9wdGlvbi10ZXJtaW5hdG9yXCIpID8/IC0xO1xuICAgIGlmICh0b2tlbnMgPT09IHVuZGVmaW5lZCB8fCBlbmQgPCAwKSByZXR1cm47XG4gICAgY29uc3QgZGVtb3RlZDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rZW5zLnNsaWNlKGVuZCArIDEpKSB7XG4gICAgICBpZiAodC5raW5kICE9PSBcInBvc2l0aW9uYWxcIikgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gdC52YWx1ZTtcbiAgICAgIGxldCBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICh2LnN0YXJ0c1dpdGgoXCItLVwiKSkga2V5ID0gdi5zbGljZSgyKS5zcGxpdChcIj1cIilbMF07XG4gICAgICBlbHNlIGlmICh2Lmxlbmd0aCA9PT0gMiAmJiB2LnN0YXJ0c1dpdGgoXCItXCIpKSBrZXkgPSBzaG9ydFRvS2V5LmdldCh2LnNsaWNlKDEpKTtcbiAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBrZXkgIT09IFwiXCIgJiYgYWNjZXB0ZWQuaGFzKGtleSkpIGRlbW90ZWQucHVzaCh2KTtcbiAgICB9XG4gICAgaWYgKGRlbW90ZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgd2hpY2ggPSBkZW1vdGVkLmpvaW4oXCIsIFwiKTtcbiAgICBjb25zdCBvbmUgPSBkZW1vdGVkLmxlbmd0aCA9PT0gMTtcbiAgICBjb25zdCBpdCA9IG9uZSA/IFwiaXRcIiA6IFwidGhlbVwiO1xuICAgIGNvbnN0IHdhcyA9IG9uZSA/IFwid2FzXCIgOiBcIndlcmVcIjtcbiAgICBjb25zdCBhc0ZsYWcgPSBvbmUgPyBcImFzIGEgZmxhZ1wiIDogXCJhcyBmbGFnc1wiO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCMgd2FybmluZzogJHtjbGlOYW1lfSR7cm93Lm5hbWUgPT09IFwiXCIgPyBcIlwiIDogYCAke3Jvdy5uYW1lfWB9OiAke3doaWNofSBhZnRlciBcXGAtLVxcYCAke3dhc30gcmVhZCBhcyB0ZXh0LCBub3QgJHthc0ZsYWd9OyB0byB1c2UgJHtpdH0gJHthc0ZsYWd9LCBtb3ZlICR7aXR9IGJlZm9yZSBcXGAtLVxcYFxcbmAsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBydW5Sb3cgPSBhc3luYyAocm93OiBSb3csIHRva2VuOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChyb3cubmFtZSA9PT0gXCJcIiA/IG51bGwgOiByb3cubmFtZSk7XG4gICAgY29uc3QgbmFtZSA9IGxhYmVsKHJvdyk7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBuZXcgU2V0KHJvdy5hY2NlcHRlZCk7XG4gICAgY29uc3QgY2hvaWNlcyA9IHJvdy5uYW1lID09PSBcIlwiID8gcm9vdENob2ljZXMgOiBmbGFnc0Zvcihyb3cubmFtZSk7XG4gICAgY29uc3QgZmxhZ0hpbnQgPSAoKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICBbcm93LnJlamVjdEhpbnQsIGNob2ljZXMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gZmxhZ3NgIDogdW5kZWZpbmVkXVxuICAgICAgICAuZmlsdGVyKChzKTogcyBpcyBzdHJpbmcgPT4gcyAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAuam9pbihcIjsgXCIpIHx8IHVuZGVmaW5lZDtcblxuICAgIGxldCB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGxldCBwb3NpdGlvbmFsczogc3RyaW5nW107XG4gICAgbGV0IHRva2VuczogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPltcInRva2Vuc1wiXTtcbiAgICB0cnkge1xuICAgICAgKHsgdmFsdWVzLCBwb3NpdGlvbmFscywgdG9rZW5zIH0gPSBwYXJzZUFyZ3Moe1xuICAgICAgICBhcmdzLFxuICAgICAgICBvcHRpb25zOiBwYXJzZU9wdGlvbnMsXG4gICAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgICAgYWxsb3dQb3NpdGlvbmFsczogcm93LmFsbG93UG9zaXRpb25hbHMsXG4gICAgICAgIHRva2VuczogdHJ1ZSxcbiAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZXJyQ29kZShlKSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiKSB7XG4gICAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0pO1xuICAgICAgfVxuICAgICAgLy8gQSBtaXNzaW5nIHZhbHVlIGlzIG5vdCBhIGNob2ljZSBmcm9tIGEgc2V0LCBzbyBubyBgY2hvaWNlc2AgaGVyZS5cbiAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBoaW50OiByb3cucmVqZWN0SGludCA/PyBleHBlY3RzKHJvdykgfSk7XG4gICAgfVxuXG4gICAgLy8gU3RhZ2UgMjoga25vd24gdG8gdGhlIHNwZWxsLCBub3QgdGFrZW4gYnkgdGhpcyByb3cg4oCUIE1JU1BMQUNFRCwgbm90XG4gICAgLy8gdW5rbm93bi4gT25seSBmbGFncyB0aGUgY2FsbGVyIEdBVkUgYXJlIGhlcmU6IGRlZmF1bHRzIGFyZSBub3QgYXBwbGllZCB5ZXQuXG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyh2YWx1ZXMpLmZpbmQoKGspID0+ICFhY2NlcHRlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke25hbWV9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgJHtjbGlOYW1lfSBmbGFnLCBqdXN0IG5vdCB0aGlzICR7cm93Lm5hbWUgPT09IFwiXCIgPyBcImNvbW1hbmRcIiA6IFwidmVyYlwifSdzKWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEFyaXR5LCBmcm9tIHRoZSBkZWNsYXJlZCBzaGFwZSwgbmFtaW5nIHRoZSBtaXNzaW5nIG9yIHRoZSBleHRyYSB0b2tlbi5cbiAgICBjb25zdCByZXF1aXJlZCA9IHJvdy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgICBjb25zdCB2YXJpYWRpYyA9IHJvdy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgICBpZiAocG9zaXRpb25hbHMubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSByb3cucG9zaXRpb25hbHNbcG9zaXRpb25hbHMubGVuZ3RoXTtcbiAgICAgIGRpZShgJHtuYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IGV4cGVjdHMocm93KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWxzLmxlbmd0aCA+IHJvdy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYCR7bmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsc1tyb3cucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGhpbnQ6IHJvdy5wb3NpdGlvbmFscy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBhcmd1bWVudHNgIDogZXhwZWN0cyhyb3cpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIERlZmF1bHRzIGxhc3QsIGFuZCBvbmx5IHRoaXMgcm93J3MuXG4gICAgY29uc3QgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4gPSB7IC4uLih2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPikgfTtcbiAgICBmb3IgKGNvbnN0IGsgb2Ygcm93LmFjY2VwdGVkKSB7XG4gICAgICBjb25zdCBkID0gKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS5kZWZhdWx0O1xuICAgICAgaWYgKGZsYWdzW2tdID09PSB1bmRlZmluZWQgJiYgZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZsYWdzW2tdID0gKEFycmF5LmlzQXJyYXkoZCkgPyBbLi4uZF0gOiBkKSBhcyBGbGFnVmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW52OiBJbnZvY2F0aW9uID0geyBwYXRoOiByb3cubmFtZSwgdG9rZW4sIHBvczogcG9zaXRpb25hbHMsIGZsYWdzIH07XG4gICAgY29uc3QgcmVmdXNlZCA9IHJvdy5jaGVjaz8uKGludik7XG4gICAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCkgZGllKGAke25hbWV9OiAke3JlZnVzZWR9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IGV4cGVjdHMocm93KSB9KTtcblxuICAgIHdhcm5EZW1vdGVkKHJvdywgYWNjZXB0ZWQsIHRva2Vucyk7XG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgcm93LnJ1bihpbnYpO1xuICAgIHJldHVybiB0eXBlb2Ygb3V0ID09PSBcIm51bWJlclwiID8gb3V0IDogMDtcbiAgfTtcblxuICBjb25zdCBkaXNwYXRjaCA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgICBjb25zdCBmaXJzdCA9IGFyZ3ZbMF07XG5cbiAgICAvLyAxLiBJbnRlcmNlcHRvcnMgcGFzcyB0aGUgcmVzdCBvZiB0aGUgYXJndiBvbiB0byB0aGVpciByb3cuXG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBJTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBmaXJzdCk7XG4gICAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBydW5Sb3coYnlUb2tlbi5nZXQoaW50ZXJjZXB0b3IucnVucykgYXMgUm93LCBpbnRlcmNlcHRvci5ydW5zLCBhcmd2LnNsaWNlKDEpKTtcbiAgICB9XG5cbiAgICAvLyAyLiBBIHZlcmJsZXNzIHJvb3Qgb3ducyBldmVyeSBhcmd2IHRoYXQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlc2VydmVkIHRva2VuLlxuICAgIGlmIChyb290Um93ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkICYmIChieVRva2VuLmhhcyhmaXJzdCkgfHwgc3Vic09mLmhhcyhmaXJzdCkpKSB7XG4gICAgICAgIGNvbnN0IHIgPSByZXNvbHZlKGZpcnN0LCBhcmd2LnNsaWNlKDEpKTtcbiAgICAgICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBydW5Sb3cocm9vdFJvdywgXCJcIiwgYXJndik7XG4gICAgfVxuXG4gICAgLy8gMy4gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMikuXG4gICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcblxuICAgIC8vIDQuIEZpbmQgdGhlIHZlcmIuXG4gICAgbGV0IGNhbmQ6IHN0cmluZztcbiAgICBsZXQgcmVzdDogc3RyaW5nW107XG4gICAgaWYgKGdyYW1tYXIgPT09IFwidmVyYi1maXJzdFwiKSB7XG4gICAgICBpZiAoZmlyc3QgPT09IFwiLS1cIikge1xuICAgICAgICBpZiAoYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICAgIGNhbmQgPSBhcmd2WzFdO1xuICAgICAgICByZXN0ID0gW1wiLS1cIiwgLi4uYXJndi5zbGljZSgyKV07XG4gICAgICB9IGVsc2UgaWYgKGZpcnN0LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgIHJldHVybiBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtmaXJzdH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke3ZlcmJzLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZCA9IGZpcnN0O1xuICAgICAgICByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IHNjYW5Qb3NpdGlvbmFsKGFyZ3YsIGZhbHNlKTtcbiAgICAgIGlmIChpIDwgMCkge1xuICAgICAgICAvLyBObyB2ZXJiIGFueXdoZXJlOiBhbiB1bmtub3duIGZsYWcgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LFxuICAgICAgICAvLyBhbmQgYSBjbGVhbiBwYXJzZSBpcyBhIGJhcmUgaW52b2NhdGlvbi4gTmVpdGhlciByYW4gYSBjb21tYW5kLCBzb1xuICAgICAgICAvLyB0aGUgZW52ZWxvcGUncyBgbWV0YS5jb21tYW5kYCBpcyBudWxsLCBub3QgdGhlIGZpcnN0IGZsYWcnc1xuICAgICAgICAvLyBzcGVsbGluZyAoYGdsYW1vdXIgLS1ib2d1c2AgbmFtZXMgbm8gdmVyYikuXG4gICAgICAgIHNldEN1cnJlbnRDb21tYW5kKG51bGwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IHBhcnNlT3B0aW9ucywgc3RyaWN0OiB0cnVlLCBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgZGllKGVyck1lc3NhZ2UoZSksIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgICAgaGludDogYG5vIGNvbW1hbmQgZ2l2ZW4g4oCUIGNvbW1hbmRzOiAke3ZlcmJzLmpvaW4oXCIgXCIpfSAocnVuOiAke2NsaU5hbWV9IGhlbHApYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICB9XG4gICAgICBjYW5kID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgICAvLyBBIHZlcmIgZm91bmQgcmlnaHQgYWZ0ZXIgYSBgLS1gIGxlYXZlcyB0aGF0IGAtLWAgaW4gcGxhY2UsIHNvIHRoZVxuICAgICAgLy8gcmVzdCBvZiB0aGUgYXJndiBzdGF5cyBwb3NpdGlvbmFsLlxuICAgICAgcmVzdCA9IHdpdGhvdXQoYXJndiwgaSk7XG4gICAgfVxuICAgIHNldEN1cnJlbnRDb21tYW5kKGNhbmQpO1xuICAgIGNvbnN0IHIgPSByZXNvbHZlKGNhbmQsIHJlc3QpO1xuICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gIH07XG5cbiAgY29uc3QgbWFpbiA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgICAvLyBUaGUgaG91c2UgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuIEEgc3BlbGwgdGhhdFxuICAgICAgLy8gdHJpYWdlcyBpdHMgb3duIChnbGFtb3VyJ3MgRU5PRU5UIOKGkiB1c2FnZSkgY2FsbHMgYGRpc3BhdGNoYCBpbnN0ZWFkLlxuICAgICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIGVyck1lc3NhZ2UoZSkpKSA/PyAxO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2aWV3ID0gKHI6IFJvdyk6IFJvd1ZpZXcgPT4gKHtcbiAgICBuYW1lOiByLm5hbWUsXG4gICAgYWxpYXNlczogci5hbGlhc2VzLFxuICAgIGZsYWdzOiByLmZsYWdzLFxuICAgIGFjY2VwdGVkOiByLmFjY2VwdGVkLFxuICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLFxuICAgIGRlc2NyaWJlOiByLmRlc2NyaWJlLFxuICAgIGF1dG86IHIuYXV0byxcbiAgfSk7XG5cbiAgT2JqZWN0LmFzc2lnbihjbGksIHtcbiAgICBuYW1lOiBjbGlOYW1lLFxuICAgIG1haW4sXG4gICAgZGlzcGF0Y2gsXG4gICAgZGVjbGFyYXRpb24sXG4gICAgcmVuZGVySGVscCxcbiAgICB1c2FnZU9mOiAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByID0gcm93Rm9yKHBhdGgpO1xuICAgICAgcmV0dXJuIHIgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiB1c2FnZUxpbmUocik7XG4gICAgfSxcbiAgICB2ZXJicyxcbiAgICBwYXRocyxcbiAgICBmbGFnc0ZvcixcbiAgICByZWNvZ25pemVkRmxhZ3M6IG9wdGlvbktleXMubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgcm93czogcm93cy5tYXAodmlldyksXG4gIH0gc2F0aXNmaWVzIENsaSk7XG4gIHJldHVybiBjbGk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8vIFNlc3Npb24gZW5kaW5ncyBhcmUgb3V0Y29tZXMsIG5vdCBmYWlsdXJlcywgYW5kIHN0YXkgb3V0c2lkZSB0aGUgdGF4b25vbXk6XG4vLyBhbiBhZ2VudCByZWFkcyB0aGVtIGFzIFwidGhlIHNlc3Npb24gZW5kZWQgdGhpcyB3YXlcIiwgbm90IFwidGhlIHZlcmIgYnJva2VcIi5cbi8vIFRoZSBudW1iZXJzIGFyZSB0aGUgc2hlbGwncyAoYHRpbWVvdXRgJ3MgMTI0LCBTSUdJTlQncyAxMjggKyAyKSwgc28gYVxuLy8gd3JhcHBlciB0aGF0IGFscmVhZHkga25vd3MgdGhlbSBuZWVkcyBubyB0YWJsZS5cbi8qKiBBIGRhZW1vbiB0aGF0IGNsb3NlZCBpdHNlbGYgYWZ0ZXIgaXRzIGlkbGUgdGltZW91dC4gQW4gb3V0Y29tZSwgbm90IGEgZmFpbHVyZS4gKi9cbmV4cG9ydCBjb25zdCBFWElUX0lETEVfVElNRU9VVCA9IDEyNDtcbi8qKiBUaGUgdXNlciBjYW5jZWxsZWQuIEFuIG91dGNvbWUsIG5vdCBhIGZhaWx1cmUuICovXG5leHBvcnQgY29uc3QgRVhJVF9DQU5DRUxMRUQgPSAxMzA7XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGB0b2tlbmAgaXMgYSBzdGFibGUgbWFjaGluZS1yZWFkYWJsZSBuYW1lXG4gKiBmb3IgdGhlIGNhdXNlIChgbm9fc2Vzc2lvbmApLCBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyB0b2tlbj86IHN0cmluZzsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLy8gT25seSBwcmVzZW50IHdoZW4gZ2l2ZW4sIHNvIGFuIGVudmVsb3BlIHdpdGhvdXQgb25lIGtlZXBzIGl0cyBieXRlcy5cbiAgICAgIC4uLihleHRyYT8udG9rZW4gPyB7IHRva2VuOiBleHRyYS50b2tlbiB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2l0ZW1zL3RhaWwtcmVhZGVyLWNvbnZlcmdlbmNlL3dyaXRlLXVwLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2l0ZW1zL3NjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pdGVtcy9tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwvd3JpdGUtdXAubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIChhc3Ryb2xhYmUsIGdyYXBldmluZSkgYWx3YXlzIGdldHNcbiAqICAgICBgdGFpbC53aW5kb3dgOiBhIHN0b3Atc3RhcnQgdGFpbCB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHNcbiAqICAgICBjb25uZWN0aW9uIGNhcnJpZXMuIE1pbmQtbWFwcGVyIHdhcyBvbmUgYW5kIGlzIG5vdCBzaW5jZSAyMDI2LTA5LTI0XG4gKiAgICAgKHNlZSBcIk1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMU1wiIGJlbG93KS5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzIGFuZCBtaW5kLW1hcHBlciksIGVhY2ggbmFtaW5nIGhvdyB0b1xuICogY29tZSBiYWNrIGluc3RlYWQgb2YgYSByZS1hcm0uIEEgc2lnbmFsIG9yIGEgY2FsbGVyJ3MgYWJvcnQgcHJpbnRzIG5vdGhpbmcuXG4gKlxuICogRXZlcnkgcmUtYXJtIGNhcnJpZXMgYC0tc2luY2UgPGN1cnNvcj5gLCBzbyBub3RoaW5nIHJlcGxheXM7IHRoZSBkYWVtb24nc1xuICogYnVmZmVyIGNvdmVycyB3aGF0ZXZlciBsYW5kcyBiZXR3ZWVuIG9uZSB3YXRjaCdzIGV4aXQgYW5kIHRoZSBuZXh0J3MgYXJtLlxuICpcbiAqIOKUgOKUgCBERUNJU0lPTiBMT0cgKGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCAyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBLaXQgZGVjaXNpb25zIGxpdmUgaW4gbW9kdWxlIGhlYWRlcnMgKHRoZSBhcmNoaXRlY3R1cmUgZG9jJ3Mgwqc0IHJ1bGU6IFwiZWFjaFxuICogbW9kdWxlJ3MgaGVhZGVyIGlzIHRoZSBhdXRob3JpdGF0aXZlIGFjY291bnRcIikuIFJ1bGVkIGJ5IENvbGU6IHRoZSBoeWJyaWQsXG4gKiB0aGUgYWx3YXlzLWJvb2ttYXJrLCBwcmVzZW5jZSBzcGVsbHMgYWx3YXlzIHJlLWFybSBNb25pdG9yLCBib3VudHkncyBleGFtcGxlXG4gKiBmaXhlZC4gVGhlIGZvdXIgYWRqdXN0bWVudHMgd2VyZSB0aGUgc3Bpa2UncyByZXF1aXJlbWVudHMuIFRoZSByZXN0IGFyZSB0aGVcbiAqIGltcGxlbWVudGVyJ3MgcnVsaW5ncywgbWFya2VkIOKaliB3aXRoIHRoZSBvcHRpb25zIG5vdCB0YWtlbi5cbiAqXG4gKiBBMSDCtyBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTi4gYHRhaWxFdmVudHNgIG5vdyBhYm9ydHMgdGhlXG4gKiAgICAgIGluLWZsaWdodCBmZXRjaCBiZWZvcmUgaXQgcmV0dXJucyBvbiBhIHRlcm1pbmFsIGZyYW1lLiBCZWZvcmUsIGl0XG4gKiAgICAgIHJldHVybmVkIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3AgYW5kIGxlZnQgdGhlIFNTRSBzdHJlYW0gb3Blbiwgc28gdGhlXG4gKiAgICAgIHByb2Nlc3Mgc3RheWVkIGFsaXZlOiB1bnNlZW4gZm9yIGBjbG9zZWRgICh0aGUgc2VydmVyIGVuZHMgdGhhdFxuICogICAgICBzdHJlYW0gaXRzZWxmKSBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2sgd291bGRcbiAqICAgICAgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQsIHNpbGVudGx5LiBQaW5uZWQgaW5cbiAqICAgICAgYHRhaWxIYW5kb2ZmLnRlc3QudHNgIGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBrZWVwcyB0aGUgc3RyZWFtIG9wZW4uXG4gKlxuICogQTIgwrcgVEhFIE5FWFQgQUNUIERFUEVORFMgT04gU1RBVEUuIGBoYW5kb2ZmKClgIGJlbG93IGlzIHRoZSBwdXJlIGRlY2lzaW9uOlxuICogICAgICBxdWlldCDihpIgYmFja2dyb3VuZCwgYWN0aXZlIG9yIHByZXNlbmNlIOKGkiBNb25pdG9yLCB3b2tlIOKGkiBNb25pdG9yLFxuICogICAgICBjbG9zZWQg4oaSIGNvbWUgYmFjaywgbG9zdCDihpIgY29tZSBiYWNrLiBDb21lIGJhY2sgaXMgdGhlIHNwZWxsJ3Mgb3duIHZlcmJcbiAqICAgICAgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCBmb3IgdGhlIHNlc3Npb24gc3BlbGxzLCBgb3BlbiAtLW5vLW9wZW5gIGZvclxuICogICAgICBtaW5kLW1hcHBlciBhbmQgYXN0cm9sYWJlKS5cbiAqICAgICAg4pqWIFRIRSBESVNDT05ORUNUIERFQ0lTSU9OOiBmb3IgYSBzZXNzaW9uIHNwZWxsLCBhIExPU1QgZGFlbW9uIGVuZHMgdGhlXG4gKiAgICAgIHRhaWwgaW4gQk9USCBtb2RlcyB3aXRoIGEgc3Rkb3V0IGB0YWlsLmxvc3RgIGxpbmUuIE1vbml0b3Igbm90aWZpZXMgb25seVxuICogICAgICBvbiBzdGRvdXQsIHNvIHRoZSBvbGQgc3RkZXJyLW9ubHkgYHRhaWwuZGlzY29ubmVjdGVkYCBsZWZ0IGFcbiAqICAgICAgTW9uaXRvci13cmFwcGVkIGFnZW50IHVuYXdhcmUgb2YgYSBga2lsbCAtOWAgKEU1NSdzIHB1cnBvc2UgdW5tZXQpLCBhbmRcbiAqICAgICAgYSBgLS1vbmNlYCBvbiBhIGRlYWQgZGFlbW9uIHdvdWxkIGhhdmUgc2xlcHQgZm9yZXZlci4gXCJMb3N0XCIgaXNcbiAqICAgICAgYExPU1RfQUZURVJfUkVGVVNBTFNgIGNvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3csIG5ldmVyIGEgZHJvcHBlZFxuICogICAgICBzdHJlYW0gYWxvbmU6IGEgbGFwdG9wIHRoYXQgc2xlZXBzIGRyb3BzIHRoZSBzdHJlYW0sIHJlY29ubmVjdHMgb24gdGhlXG4gKiAgICAgIGZpcnN0IHRyeSwgYW5kIG11c3Qgc3RheSBzaWxlbnQuXG4gKiAgICAgICAgTm90IHRha2VuOiAoYSkga2VlcCByZXRyeWluZyBhbmQgb25seSBNT1ZFIHRoZSBkaXNjb25uZWN0IGxpbmUgdG9cbiAqICAgICAgICBzdGRvdXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24gaXMgbmV2ZXIgcmVzcGF3bmVkIGJ5IGl0cyB0YWlsLCBzbyB0aGVcbiAqICAgICAgICByZXRyaWVzIGJ1eSBub3RoaW5nIGFuZCB0aGUgYWdlbnQgaXMgd29rZW4gdG8gYmUgdG9sZCB0byB3YWl0OyAoYilcbiAqICAgICAgICBsZWF2ZSBpdCBvbiBzdGRlcnIg4oCUIHRoZSBkZWZlY3QuXG4gKiAgICAgIOKaliBQcmVzZW5jZSBzcGVsbHMga2VlcCByZXRyeWluZywgYXMgYmVmb3JlOiBncmFwZXZpbmUncyB0YWlsIHJlc3Bhd25zXG4gKiAgICAgIGl0cyBkYWVtb24gYW5kIGFzdHJvbGFiZSdzIGBqb2luYCB3YWl0cyBmb3IgdGhlIGh1bWFuIHRvIHJlb3BlbiB0aGVcbiAqICAgICAgYm9hcmQsIGJvdGggYnkgZGVzaWduLiBUaGVpciBkaXNjb25uZWN0IG5vdGVzIHN0YXkgd2hlcmUgdGhleSB3ZXJlLlxuICpcbiAqIEEzIMK3IFFVSUVUIElTIFRIRSBUQUlMJ1MgT1dOIENPVU5ULiBgZXZlbnRzYCBjb3VudHMgdGhlIGxvZyBmcmFtZXMgdGhpc1xuICogICAgICBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dC4gVGhlIGdyb3VuZGluZyBsaW5lLCBhIHNwZWxsJ3MgYHN1YnNjcmliZWRgXG4gKiAgICAgIG1hcmtlciwgYGVwb2NoLmNoYW5nZWRgIGFuZCB0aGUgaGFuZG9mZiBsaW5lIGl0c2VsZiBhcmUgbm90IGxvZyBmcmFtZXNcbiAqICAgICAgYW5kIGFyZSBub3QgY291bnRlZDogYSBmcmFtZSBjb3VudHMgb25seSBpZiBpdCBjYXJyaWVzIGEgbG9nIGlkIChEMyksXG4gKiAgICAgIGFuZCBgY291bnRzYCBsZXRzIGEgc3BlbGwgZXhjbHVkZSBhIGZyYW1lIHRoYXQgZG9lcyAoZ3JhcGV2aW5lJ3NcbiAqICAgICAgYHN1YnNjcmliZWRgIG1hcmtlciwgd2hpY2ggc2VlZHMgdGhlIGJvb2ttYXJrIGZyb20gYGxhdGVzdF9pZGApLiBBbnkgbG9nIGZyYW1lIGNvdW50cywgdGhlIGRhZW1vbidzIGB3YWl0aW5nYCByZW1pbmRlclxuICogICAgICBpbmNsdWRlZCwgc28gXCJxdWlldFwiIG1lYW5zIG5vdGhpbmcgb24gdGhlIGxvZy5cbiAqICAgICAg4pqWIEEgZnJhbWUgdGhlIHRhaWwncyBvd24gZmlsdGVyIHJlamVjdHMgKGJvdW50eSdzIG93bmVyIHNjb3BlLCBhXG4gKiAgICAgIHNlbGYtZWNobykgaXMgTk9UIGNvdW50ZWQgYW5kIGRvZXMgbm90IGVuZCBhIGAtLW9uY2VgOiBpdCB3YXMgbmV2ZXJcbiAqICAgICAgZGVsaXZlcmVkLCBhbmQgd2FraW5nIG9uIGl0IHdvdWxkIGJlIGEgd2FrZSB3aXRoIG5vdGhpbmcgdG8gYWN0IG9uIOKAlFxuICogICAgICB0aGUgZGVmZWN0IHRoaXMgbW9kdWxlIGV4aXN0cyB0byByZW1vdmUuIFRoZSBjdXJzb3Igc3RpbGwgYWR2YW5jZXNcbiAqICAgICAgcGFzdCBpdCAodGFpbEV2ZW50cycgcnVsZSksIHNvIGl0IG5ldmVyIHJlcGxheXMgZWl0aGVyLlxuICogICAgICBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOyB0aGF0IGhhbGYgbGl2ZXMgaW4gZWFjaFxuICogICAgICBzcGVsbCdzIGB0YWlsYCwgd2hpY2gga25vd3Mgd2hldGhlciBgLS1zaW5jZWAgd2FzIGdpdmVuLlxuICpcbiAqIEE0IMK3IFRIRSBXSU5ET1cuIGBERUZBVUxUX1dJTkRPV19NU2AgPSB0aGUgY2FwIG1pbnVzIGBXSU5ET1dfTUFSR0lOX01TYFxuICogICAgICAoNjAgcyksIHNvIDEsNzQwLDAwMCBtcy4gVGhlIG1hcmdpbiBoYXMgdG8gY292ZXIgdGhlIGdhcCBiZXR3ZWVuIHRoZVxuICogICAgICBoYXJuZXNzIHN0YXJ0aW5nIGl0cyBjbG9jayBhbmQgdGhpcyBwcm9jZXNzIHN0YXJ0aW5nIGl0cyBvd24gKEJ1blxuICogICAgICBzdGFydC11cCwgYSBzZXNzaW9uIGxvb2t1cCwgYSBkYWVtb24gc3Bhd24gb24gdGhlIHNwZWxscyB3aG9zZSBgcmVzb2x2ZWBcbiAqICAgICAgc3Bhd25zIG9uZSDigJQgYm91bmRlZCBieSB0aGVpciBzdGFydCB0aW1lb3V0cywgd2hpY2ggYXJlIHNlY29uZHMpIHBsdXNcbiAqICAgICAgdGhlIGxhc3QgbGluZSdzIGZsdXNoIGFuZCBNb25pdG9yJ3MgMjAwIG1zIGJhdGNoaW5nLiBBIG1pbnV0ZSBjb3ZlcnNcbiAqICAgICAgYWxsIG9mIHRoYXQgbWFueSB0aW1lcyBvdmVyLiBUaGUgc3Bpa2UgbWVhc3VyZWQgYSAxMiBzXG4gKiAgICAgIHdpbmRvdyB1bmRlciBhIDIwIHMgY2FwIGVuZGluZyBjbGVhbmx5OyBub3RoaW5nIGhlcmUgZGVwZW5kcyBvbiBhXG4gKiAgICAgIG1hcmdpbiB0aGF0IHRpZ2h0LiBJZiB0aGUgY2FwIHdpbnMgYW55d2F5LCB0aGUgYWdlbnQgZ2V0cyBNb25pdG9yJ3NcbiAqICAgICAgYmFyZSBleHBpcnkgbm90aWNlIGFuZCByZS1hcm1zIHNpbGVudGx5IGZyb20gdGhlIGxhc3QgaWQgaXQgc2F3IOKAlCB0aGVcbiAqICAgICAgcnVsaW5nJ3MgZmFsbGJhY2ssIHN0YXRlZCBpbiBldmVyeSBza2lsbC5cbiAqICAgICAg4pqWIFRoZSB3aW5kb3cgaXMgaW5qZWN0YWJsZSBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiB0aHJvdWdoXG4gKiAgICAgIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNgIChhIGNvdW50IG9mIG1zOyBgMGAgdHVybnMgdGhlIHdpbmRvdyBvZmYsXG4gKiAgICAgIGZvciBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwpLiBBbiBlbnYgdmFyIGFuZCBub3QgYSBmbGFnOiBpdCBpc1xuICogICAgICBub3QgYW4gYWdlbnQncyBhY3QsIHNvIGl0IHN0YXlzIG91dCBvZiBlaWdodCB2ZXJicycgc2NoZW1hcy5cbiAqXG4gKiDilIDilIAgVEhFIFZFUklGSUVSJ1MgREVGRUNUUywgRklYRUQgT04gVEhFIFNBTUUgQlJBTkNIICgyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbm8tc3Rha2UgdmVyaWZpZXIgcmFuIGV2ZXJ5IHNwZWxsJ3MgcmVhbCB0YWlsIGFuZCBmb3VuZCBmb3VyIHdheXMgdGhlXG4gKiBsb29wIGJyb2tlLiBFYWNoIGhhcyBhIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgOyBEMSBhbmQgRDIgYWxzbyBoYXZlIGFcbiAqIHJlYWwtZGFlbW9uIGNlbGwgaW4gYHNyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RhaWwtaGFuZG9mZi5pbnRlZ3JhdGlvbi50ZXN0LnRzYC5cbiAqXG4gKiBEMSDCtyBBIFJFLUFSTSBBVCBBIFNFU1NJT04gVEhBVCBDTE9TRUQgSU4gVEhFIEdBUCBFTkRTIGB0YWlsLmNsb3NlZGAuIFRoZVxuICogICAgICB0cmlnZ2VyIGlzIG9yZGluYXJ5OiB0aGUgaHVtYW4gcHJlc3NlcyBDbG9zZSB3aGlsZSB0aGUgYWdlbnQgaGFuZGxlc1xuICogICAgICBgdGFpbC53b2tlYC4gVGhlIHNlc3Npb24gc3BlbGxzIHN0b3BwZWQgb25seSB3aGVuIFRISVMgcHJvY2VzcyBoYWRcbiAqICAgICAgb25jZSByZWFjaGVkIHRoZSBzZXNzaW9uLCBzbyB0aGUgcmUtYXJtIHJldHJpZWQgXCJubyBzZXNzaW9uIHlldFwiIG9uXG4gKiAgICAgIHN0ZGVyciBmb3JldmVyIOKAlCBhbmQgaXRzIGAtLW9uY2VgIG5ldmVyIGV4aXRlZC4gUnVsZTogYSB0YWlsIGdpdmVuXG4gKiAgICAgIGAtLXNlc3Npb25gIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HIHNlc3Npb24sIHNvIG5vdFxuICogICAgICBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZDsgdGhlIHNwZWxsJ3MgYG9uVW5yZXNvbHZlZGAgc2F5cyBcInN0b3BcIlxuICogICAgICBhbmQgdGhpcyBtb2R1bGUgcmVhZHMgQU5ZIHN0b3AgYXMgY2xvc2VkLiBBIGJhcmUgZmlyc3QgYXJtIHN0aWxsXG4gKiAgICAgIHdhaXRzIGZvciBhIHNlc3Npb24gdG8gYXBwZWFyLiDimqAgXCJHaXZlblwiIG1lYW5zIE9OIFRIRSBDT01NQU5EIExJTkVcbiAqICAgICAgKHJldmlldyBCMSk6IGJvdW50eSBhbHNvIHJlc29sdmVzIGEgc2Vzc2lvbiBmcm9tXG4gKiAgICAgIGAkQk9VTlRZX1NFU1NJT05fS0VZYCwgYCRCT1VOVFlfU0VTU0lPTmAgb3IgYSBgLmJvdW50eS1zZXNzaW9uYCBmaWxlLFxuICogICAgICB3aGljaCBldmVyeSBhbnRoaWxsIHNlYXQgaGFzLCBhbmQgYSBzZWF0J3MgZmlyc3QgYXJtIG11c3Qgd2FpdC4gQVxuICogICAgICBrZXllZCBib3VudHkgYm9hcmQgY29tZXMgYmFjayBieSBpdHMga2V5IChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKTtcbiAqICAgICAgcmVzdG9yaW5nIGl0IGJ5IGlkIHNwYXducyBhbiB1bmtleWVkIHN0cmF5LlxuICogRDIgwrcgQSBCT09LTUFSSyBDQU5OT1QgT1VUTElWRSBJVFMgTE9HLiBBIHJlc3RvcmVkIGRhZW1vbidzIGlkcyBiZWdpbiBhdCAxLFxuICogICAgICBhbmQgdGhlIGtpdCdzIGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duIGJ5IHJlcGxheWluZyB3aG9sZTtcbiAqICAgICAgdGhlIHRhaWwga2VwdCBpdHMgaGlnaGVyIGN1cnNvciwgc28gZXZlcnkgcmUtYXJtIHJlcGxheWVkIHRoZSBuZXcgbG9nXG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUd28gaGFsdmVzOlxuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVGhyZWUgcGFydHM6XG4gKiAgICAgICAgKGEpIHRoZSBuZXQg4oCUIGB0YWlsRXZlbnRzYCcgYHJlc3RhcnRPblJlcGxheWAsIG9uIGZvciBldmVyeSBzcGVsbCxcbiAqICAgICAgICAgICAgcmVhZHMgYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGFzIGEgcmVzdGFydGVkIGxvZ1xuICogICAgICAgICAgICBhbmQgcmVzZXRzIHRoZSBjdXJzb3I7XG4gKiAgICAgICAgKGIpIHRoZSBydWxlIOKAlCB0aGUgYHRhaWwuY2xvc2VkYC9gdGFpbC5sb3N0YCBoaW50LCBhbmQgZXZlcnkgc2tpbGwsXG4gKiAgICAgICAgICAgIHNheTogcnVuIHRoZSBjb21tYW5kIHRoZSBsaW5lIG5hbWVzLCB0aGVuIHRhaWwgV0lUSCBOT1xuICogICAgICAgICAgICBgLS1zaW5jZWAgKGEgcmVzdG9yZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2c7IGJvdW50eSdzIHJlc3RvcmVcbiAqICAgICAgICAgICAgZXZlbiBtaW50cyBhIG5ldyBpZCk7XG4gKiAgICAgICAgKGMpIFRIRSBFUE9DSCBJTiBUSEUgQk9PS01BUksg4oCUIOKaliBBIFJFVkVSU0FMLiBUaGUgZmlyc3QgdmVyc2lvbiBvZlxuICogICAgICAgICAgICB0aGlzIGVudHJ5IGxpc3RlZCBcImNhcnJ5IHRoZSBlcG9jaCBpbiB0aGUgYm9va21hcmtcIiBhcyBub3QgdGFrZW5cbiAqICAgICAgICAgICAgKGEgbmV3IGZsYWcgb24gZWlnaHQgdmVyYnM7IGFuIGVwb2NoIHNlZW4gb25seSBvbmNlIGEgZnJhbWVcbiAqICAgICAgICAgICAgYXJyaXZlcykuIFRoZSByZXZpZXdlciB0aGVuIHNob3dlZCAoYSkncyBibGluZCBzcG90IExJVkU6IGFuIG9sZFxuICogICAgICAgICAgICBib29rbWFyayBhdCBvciBiZWxvdyB0aGUgTkVXIGxvZydzIGxlbmd0aCBtYWtlcyB0aGUgZGFlbW9uIHNlbmRcbiAqICAgICAgICAgICAgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuXG4gKiAgICAgICAgICAgIG1lc3NhZ2UgYXQgbmV3IGlkIDIgdW5kZXIgYSBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgd2l0aCBub1xuICogICAgICAgICAgICBub3RpY2UuIFRocmVlIHBhdGhzIHJlYWNoIGl0OiBjb21pbmcgYmFjayB3aXRob3V0IGZvbGxvd2luZyAoYik7XG4gKiAgICAgICAgICAgIHRoZSBNb25pdG9yLWNhcCBmYWxsYmFjayAoXCJyZS1hcm0gZnJvbSB0aGUgbGFzdCBpZCB5b3Ugc2F3XCIpXG4gKiAgICAgICAgICAgIGFjcm9zcyBhIHJlc3RhcnQ7IGFuZCBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluLXByb2Nlc3NcbiAqICAgICAgICAgICAgKGFzdHJvbGFiZSwgb3IgbWluZC1tYXBwZXIgd2hlbiBpdHMgZGFlbW9uIGlzIGJhY2sgYmVmb3JlIHRoZVxuICogICAgICAgICAgICBsb3N0IHJ1bGUgZmlyZXMpIHdob3NlIGZpcnN0IGZyYW1lIGFmdGVyIGEgcmVzdGFydCBpcyBhbHJlYWR5XG4gKiAgICAgICAgICAgIHBhc3QgaXRzIGJvb2ttYXJrLlxuICogICAgICAgICAgICBUaGUgZml4IG5lZWRzIG5vIG5ldyBmbGFnIGFuZCBubyB3aXJlIGNoYW5nZTogdGhlIGJvb2ttYXJrIGlzXG4gKiAgICAgICAgICAgIHByaW50ZWQgYC0tc2luY2UgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSwgdGhlIGNsaWVudCBzdGFydHNcbiAqICAgICAgICAgICAgd2l0aCB0aGF0IGVwb2NoIChgc2luY2VFcG9jaGApLCBhbmQgYW4gZXBvY2ggY2hhbmdlIHdob3NlIGZyYW1lXG4gKiAgICAgICAgICAgIGlzIHBhc3QgdGhlIGFza2VkIGN1cnNvciByZS1yZWFkcyB0aGUgbmV3IGxvZyBmcm9tIDAuIFRoZSBzYW1lXG4gKiAgICAgICAgICAgIHJlY29ubmVjdCBjb3ZlcnMgdGhlIGluLXByb2Nlc3MgcHJlc2VuY2UgY2FzZS5cbiAqICAgICAg4pqgIFNUQVRFRCBMSU1JVDogb25seSBkYWVtb25zIHRoYXQgc3RhbXAgYW4gZXBvY2ggZ2V0IChjKSDigJRcbiAqICAgICAgc2NyaXB0b3JpdW0sIGFzdHJvbGFiZSBhbmQgbWluZC1tYXBwZXIuIEdsYW1vdXIsIGltYWdvLCBtYWdwaWUgYW5kXG4gKiAgICAgIGJvdW50eSBzdGFtcCBub25lIChzZXNzaW9uLXNjb3BlZCBsb2dzLCBydWxlZCBzbyBpbiBEMzkvQjg7IGJvdW50eSdzXG4gKiAgICAgIHNlcnZlciBoZWFkZXIgbmFtZXMgdGhpcyByZXNpZHVlKSwgc28gZm9yIHRoZW0gdGhlIGdhcCBzdGF5cyBvcGVuIG9uXG4gKiAgICAgIHRoZSBmYWxsYmFjayBwYXRoLCAoYSkgY292ZXJzIHRoZSB3aG9sZS1yZXBsYXkgY2FzZSBhbmQgKGIpIHRoZVxuICogICAgICBjb21lLWJhY2sgcGF0aC4gQ2xvc2luZyBpdCB0aGVyZSBpcyBhIGRhZW1vbiBjaGFuZ2U6IGFuIGVwb2NoIG9uXG4gKiAgICAgIGBjcmVhdGVFdmVudExvZ2AuIEV2ZXJ5IHNwZWxsIHByaW50cyB0aGUgbmV0J3MgcmVzZXQgYXNcbiAqICAgICAgYGVwb2NoLmNoYW5nZWRgIChgXCJlcG9jaFwiOiBcInVua25vd25cImAgd2hlcmUgdGhlcmUgaXMgbm9uZSkuXG4gKiBEMyDCtyBPTkxZIEEgRlJBTUUgV0lUSCBBIExPRyBJRCBDT1VOVFMuIEdsYW1vdXIncyBhbmQgaW1hZ28ncyB0YWIgcGluZ3NcbiAqICAgICAgKGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgKSBjYXJyeSBubyBpZDogbm90IG9uIHRoZSBsb2csIHNvIGEgbGFwdG9wXG4gKiAgICAgIGxpZCBubyBsb25nZXIgd2FrZXMgYSBgLS1vbmNlYCwgYW5kIGltYWdvJ3MgZ3JlcCBubyBsb25nZXIgc2hvd3MgYVxuICogICAgICBgdGFpbC53b2tlYCB3aXRoIG5vdGhpbmcgYWJvdmUgaXQuXG4gKiBENCDCtyBBIEhVTUFOJ1MgV0FUQ0ggSEFTIE5PIFdJTkRPVy4gYGdyYXBldmluZSB0YWlsIC0taHVtYW5gIHBhc3Nlc1xuICogICAgICBgd2luZG93TXM6IDBgOyBubyBvdGhlciBzcGVsbCBoYXMgYSBodW1hbiBtb2RlLiBFdmVyeSBgdGFpbGAncyBoZWxwXG4gKiAgICAgIGNhcnJpZXMgYFdJTkRPV19IRUxQYCwgd2hpY2ggbmFtZXMgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wYC5cbiAqIEFsc286IGV2ZXJ5IGNvbWUtYmFjayBjb21tYW5kIGNhcnJpZXMgYC0tbm8tb3BlbmAsIHNvIHJ1bm5pbmcgaXQgb3BlbnMgbm9cbiAqIGJyb3dzZXIgdGFiLlxuICpcbiAqIOKaoCBLTk9XTiBFREdFLCBOT1QgRklYRUQgKGZvdW5kIGJ5IHRoZSByZS1yZXZpZXcpOiBhIGtleWVkIGJvdW50eSBGSVJTVCBhcm1cbiAqICAgKGFuIGFudGhpbGwgc2VhdCkgd2hvc2Ugd2luZG93IGVuZHMgYmVmb3JlIGl0cyBib2FyZCBldmVyIG9wZW5zIHByaW50cyBhXG4gKiAgIHJlLWFybSBwaW5uZWQgdG8gdGhlIGRlcml2ZWQgaWQgd2l0aCBhbiBlbXB0eSBib29rbWFya1xuICogICAoYC0tc2Vzc2lvbiBrLeKApiAtLXNpbmNlPS0xIC0tb25jZWApLiBUaGF0IHJlLWFybSBpcyBhIHJlLWFybSBieSBEMSdzIHJ1bGUsXG4gKiAgIHNvIGlmIHRoZSBib2FyZCBpcyBzdGlsbCBub3QgdXAg4oCUIHRoZSBsZWFkIG1vcmUgdGhhbiBvbmUgd2luZG93ICgyOSBtaW4pXG4gKiAgIGxhdGUg4oCUIHRoZSBzZWF0IGRvZXMgbm90IHdhaXQuIE1pbm9yOiB0aGUgbmV4dCBzdGVwIGl0IG5hbWVzXG4gKiAgIChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKSBpcyB0aGUgcmlnaHQgb25lIGFueXdheS4gU2luY2UgIzk4ICgyMDI2LTA5LTI3KVxuICogICBpdCBubyBsb25nZXIgc2F5cyBgdGFpbC5jbG9zZWRgIGFib3V0IGEgYm9hcmQgdGhhdCBuZXZlciBvcGVuZWQ6IGEgbmFtZWRcbiAqICAgYC0tc2Vzc2lvbmAgd2l0aCBubyBzbmFwc2hvdCBvbiBkaXNrIGV4aXRzIGBub3RfZm91bmRgIGFmdGVyIGEgZ3JhY2UuXG4gKlxuICog4pSA4pSAIFRIRSBDT01NQU5EIE5BTUVTIE5PIFBBVEggKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBsaW5lJ3MgYGNvbW1hbmRgIGlzIHRoZSBWRVJCIEFORCBJVFMgQVJHVU1FTlRTIE9OTFlcbiAqIChgdGFpbCAtLXNlc3Npb24gWCAtLXNpbmNlIE5ARSAtLW9uY2VgKSwgcGx1cyBgc3BlbGxgLCBhbmQgdGhlIGFnZW50IHJ1bnMgaXRcbiAqIHdpdGggSVRTIE9XTiBsYXVuY2hlciwgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHNgLiBJdCB1c2VkXG4gKiB0byBiZSBydW5uYWJsZSBhcyBwcmludGVkLCBoZWFkZWQgYnkgYGJ1biA8YXJndlsxXT5gIOKAlCBhbmQgZm9yIGFuIGluc3RhbGxlZFxuICogcGx1Z2luIGBhcmd2WzFdYCBpcyBpbnNpZGUgYSBWRVJTSU9ORUQgY2FjaGUgZGlyZWN0b3J5LiBBbiB1cGdyYWRlIG1hcmtzIHRoZVxuICogb2xkIGRpcmVjdG9yeSBvcnBoYW5lZCBhbmQgZGVsZXRlcyBpdCBsYXRlciAobWVhc3VyZWQgaW5cbiAqIGBkb2NzL2l0ZW1zL3RhaWwtcmVhcm0tY29tbWFuZC1uYW1lcy1hLXZlcnNpb25lZC1wbHVnaW4tcGF0aC5tZGApLFxuICogc28gYSBsaW5lIHByaW50ZWQgYmVmb3JlIGFuIHVwZ3JhZGUgZmlyc3QgcmFuIFNUQUxFIGNvZGUgYWdhaW5zdCBhIG5ld2VyXG4gKiBkYWVtb24sIHRoZW4gZmFpbGVkIHdpdGggXCJtb2R1bGUgbm90IGZvdW5kXCIgb25jZSB0aGUgZGlyZWN0b3J5IHdhcyBnb25lLiBOb1xuICogc3RhYmxlIHBhdGggZXhpc3RzIHRvIHByaW50IGluc3RlYWQ6IHRoZSBjYWNoZSwgYCRDTEFVREVfUExVR0lOX1JPT1RgIGFuZCB0aGVcbiAqIGluc3RhbGwgcmVjb3JkIGFyZSBhbGwgdmVyc2lvbmVkLlxuICogICBUaGUgc2tpbGwncyBsYXVuY2hlciBpcyBhbHdheXMgdGhlIHZlcnNpb24gdGhlIHNlc3Npb24gbG9hZGVkLiBDb2xlJ3NcbiAqIHJlYXNvbmluZzogdGhlIHdvcnN0IGNhc2UgaXMgdGhhdCB0aGUgQ0xJIGNoYW5nZWQgYW5kIHRoZSBhZ2VudCBnZXRzIGFuXG4gKiBlcnJvciDigJQgYW5kIGlmIHRoZSB0b29scyBhcmUgZGVzaWduZWQgcmlnaHQsIHRoYXQgZXJyb3Igc2F5cyB3aGF0IHdlbnRcbiAqIHdyb25nLiBTbyB0aGUgcGFyc2VycyBhcmUgdGhlIG90aGVyIGhhbGYgb2YgdGhpcyBydWxpbmc6IGByZWFkU2luY2VgIHJlZnVzZXNcbiAqIGFueSBgLS1zaW5jZWAgZm9ybSBhIHRhaWwgZG9lcyBub3QgYWNjZXB0IHdpdGggYSB1c2FnZSBlcnJvciBOQU1JTkcgdGhlXG4gKiBmb3JtcyBpdCBkb2VzLCB0aGUgc2FtZSB3YXkgb24gYWxsIGVpZ2h0IHRhaWxzLCBpbnN0ZWFkIG9mIG1pc3BhcnNpbmcgaXQuXG4gKiAgIE5vdCB0YWtlbjogcHJpbnRpbmcgdGhlIHBhdGggQU5EIHRoZSBhcmdzIChvcHRpb24gQSBvZiB0aGUgaXRlbSDigJQgdHdvXG4gKiBjb21tYW5kcyB3aGVyZSBvbmUgaXMgd3JvbmcgYWZ0ZXIgYW4gdXBncmFkZSk7IGEgbGF1bmNoZXIgdGhhdCBub3RpY2VzIGl0IGlzXG4gKiBvcnBoYW5lZCBhbmQgcmUtZXhlY3MgYSBuZXdlciBzaWJsaW5nIChCIOKAlCBpdCBsZWFucyBvbiBhIENsYXVkZSBDb2RlXG4gKiBpbnRlcm5hbCBtYXJrZXIgYW5kIGRvZXMgbm90aGluZyBvbmNlIHRoZSBkaXJlY3RvcnkgaXMgZGVsZXRlZCk7IHZlcnNpb25cbiAqIG5lZ290aWF0aW9uLlxuICpcbiAqIOKUgOKUgCBNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFMgKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L21pbmQtbWFwcGVyLXF1aWV0LWhhbmRvZmZgLiBJdCBSRVZFUlNFUyB0aGUgaW1wbGVtZW50ZXInc1xuICogcnVsaW5nIG9mIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdGhhdCBtaW5kLW1hcHBlciBpcyBhIHByZXNlbmNlIHNwZWxsXG4gKiAoaXRzIGRhZW1vbiBjb3VudHMgYW4gb3BlbiBTU0UgdGFpbCBhcyB0aGUgYWdlbnQgcHJlc2VudCwgc28gdGhlIHdpbmRvd1xuICogYWx3YXlzIHJlLWFybWVkIE1vbml0b3IpLiBDb2xlJ3MgcmVhc29uaW5nOiBtaW5kLW1hcHBlciBzZXNzaW9ucyBhcmUgdXNlZFxuICogbGlrZSBzY3JpcHRvcml1bSdzLCBidXJzdHMgb2YgYWN0aXZpdHkgd2l0aCBicmVha3MsIGFuZCBpbiBhIGJyZWFrIHRoZSBhZ2VudFxuICogc2hvdWxkIG5vdCBiZSB3b2tlbiBldmVyeSAzMCBtaW51dGVzLiBTbyBtaW5kLW1hcHBlciB0YWtlcyB0aGUgcXVpZXQgaGFuZG9mZlxuICogdG8gYC0tb25jZWAsIHRoZSBsb3N0IGNvbWUtYmFjayAoYG9wZW4gLS1uby1vcGVuYCksIGFuZCBrZWVwcyBpdHNcbiAqIGAtLXNpbmNlIE5AZXBvY2hgIGJvb2ttYXJrLiBUaHJlZSB0aGluZ3MgaGFkIHRvIGJlIHNldHRsZWQgdG8gbWFrZSB0aGF0XG4gKiBob25lc3QsIGVhY2ggcGlubmVkIGluIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC97dGFpbCxwcmVzZW5jZX0udGVzdC50c2BcbiAqIGFuZCBtdXRhdGlvbi1jb25maXJtZWQ6XG4gKlxuICogTTEgwrcgUFJFU0VOQ0UgTElOR0VSUyBBQ1JPU1MgVEhFIEdBUFMgKHRoZSBkYWVtb24sIGBzZXJ2ZXIudHNgXG4gKiAgICAgIGBhZGp1c3RBZ2VudHNgKS4gQSBvbmUtc2hvdCBob2xkcyBhbiBTU0UgY29ubmVjdGlvbiwgc28gaXQgQ09VTlRTIGFzXG4gKiAgICAgIHByZXNlbnQsIHdoaWNoIGlzIHRydWU6IHRoZSBhZ2VudCB3aWxsIHdha2Ugb24gdGhlIG5leHQgZXZlbnQuIFRoZSBnYXBzXG4gKiAgICAgIGFyZSB0aGUgcHJvYmxlbTogd2luZG93IOKGkiByZS1hcm0sIHF1aWV0IOKGkiBgLS1vbmNlYCwgYW5kIGFib3ZlIGFsbFxuICogICAgICBgdGFpbC53b2tlYCDihpIgdGhlIGFnZW50IGhhbmRsZXMgdGhlIGV2ZW50IOKGkiBNb25pdG9yLCB3aGljaCBsYXN0cyB0aGVcbiAqICAgICAgYWdlbnQncyB3aG9sZSB0dXJuLiBSYXcsIHRoZSBzdXJmYWNlJ3MgaGVhZGVyIGRvdCAodGhlIG9ubHkgdGhpbmdcbiAqICAgICAgcHJlc2VuY2UgZHJpdmVzIHRoZXJlLCBiZXNpZGVzIHRoZSBkYWVtb24ncyBhdXRvLWByZWNlaXZlZGAgZmxpcCBvbiBhXG4gKiAgICAgIGh1bWFuIG1lc3NhZ2UpIHJlYWQgXCJjb25uZWN0ZWQg4oCUIG5vIGFnZW50IG9uIHRoaXMgcHJvamVjdFwiIHdoaWxlIHRoZVxuICogICAgICBhZ2VudCB3YXMgd29ya2luZyB0aGUgYm9hcmQsIGFuZCBhIG1lc3NhZ2Ugc2VudCB0aGVuIGdvdCBub1xuICogICAgICBgcmVjZWl2ZWRgLiBUaGUgZGFlbW9uIGhhcyBubyBpZGxlIGNsb3NlLCBzbyBub3RoaW5nIGVsc2UgcmVhY3RzLiBOb3dcbiAqICAgICAgdGhlIGNvdW50IEhPTERTIGZvciBgTUlORF9NQVBQRVJfUFJFU0VOQ0VfTElOR0VSX01TYCAoMTUwIHMsIHRoZSBzdGFsbFxuICogICAgICB3aW5kb3cncyBiZWF0KSBhZnRlciB0aGUgbGFzdCB0YWlsIGNsb3NlczogYSB0YWlsIG9wZW5pbmcgaW5zaWRlIGl0XG4gKiAgICAgIGVtaXRzIG5vdGhpbmcsIGFuIGFnZW50LW9ubHkgd3JpdGUgKGAvYWN0aXZpdHlgLCBhbiBhZ2VudCBgL3NlbmRgKVxuICogICAgICByZXN0YXJ0cyBpdCwgYW5kIHNpbGVuY2UgcGFzdCBpdCBkcm9wcyB0aGUgY291bnQgdG8gMC5cbiAqICAgICAg4pqWIE5vdCB0YWtlbjogcmUtYXJtaW5nIE1vbml0b3IgQkVGT1JFIGhhbmRsaW5nIGEgd29rZW4gZXZlbnQgKHRoYXQgaXNcbiAqICAgICAgdGhlIHNoYXJlZCBydWxlLCB3b3JkLWZvci13b3JkIGluIGV2ZXJ5IHNwZWxsKTsgcmVmcmVzaGluZyBvbiBldmVyeVxuICogICAgICBib2FyZCB3cml0ZSAodGhlIGJyb3dzZXIgUE9TVHMgdGhlIHNhbWUgcm91dGVzLCBzbyB0aGUgaHVtYW4ncyBvd25cbiAqICAgICAgY2xpY2tzIHdvdWxkIGtlZXAgdGhlIGRvdCBsaXQpLiBDb3N0OiBhbiBhZ2VudCB0aGF0IHJlYWxseSBsZWZ0IHJlYWRzXG4gKiAgICAgIFwiaGVyZVwiIGZvciB1cCB0byAxNTAgcy5cbiAqIE0yIMK3IGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBOT1QgQ09VTlRFRCAobWluZC1tYXBwZXIncyBgY291bnRzYCkuIEl0IGlzIE9OXG4gKiAgICAgIFRIRSBMT0csIHdpdGggYW4gaWQsIGFuZCBhIHRhaWwncyBvd24gY29ubmVjdCBlbWl0cyBvbmUgb250byBpdHMgb3duXG4gKiAgICAgIHN0cmVhbSwgc28gY291bnRlZCBpdCBtYWRlIGV2ZXJ5IHdpbmRvdyBcImFjdGl2ZVwiIGFuZCB3b3VsZCB3YWtlIGV2ZXJ5XG4gKiAgICAgIGAtLW9uY2VgIG9uIGl0c2VsZi4gVGhlIGxpbmdlciByZW1vdmVzIG1vc3Qgb2YgdGhhdCBjaHVybjsgYGNvdW50c2BcbiAqICAgICAgcmVtb3ZlcyB0aGUgcmVzdCAoYSBmaXJzdCBhcm0sIGFub3RoZXIgYWdlbnQgY29taW5nIG9yIGdvaW5nKS5cbiAqIE0zIMK3IEEgREVBRCBEQUVNT04gSVMgTE9TVCwgTk9UIFVOUkVTT0xWRUQgKG1pbmQtbWFwcGVyJ3MgYHJlc29sdmVgKS4gSXRzXG4gKiAgICAgIGRpc2NvdmVyeSBwcm9iZXMgdGhlIGRhZW1vbidzIHBpZCwgc28gYSBraWxsZWQgZGFlbW9uIG1hZGUgYHJlc29sdmVgXG4gKiAgICAgIGFuc3dlciBudWxsIGFuZCBhbiB1bnJlc29sdmVkIHRhaWwgcmV0cmllcyBmb3JldmVyOiBhIGAtLW9uY2VgIHdvdWxkXG4gKiAgICAgIGhhdmUgc2xlcHQgZm9yIGdvb2QgKEQxJ3MgZGVmZWN0KS4gVGhlIHRhaWwga2VlcHMgdGhlIGxhc3QgVVJMIGl0XG4gKiAgICAgIHJlc29sdmVkLCBzbyB0aGUgZGVhZCBwb3J0IHJlZnVzZXMgYW5kIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBlbmRzIGl0XG4gKiAgICAgIHdpdGggYHRhaWwubG9zdGAg4oaSIGBvcGVuIC0tbm8tb3BlbmAsIHRoZW4gYSB0YWlsIHdpdGggbm8gYC0tc2luY2VgLlxuICogICAgICBNaW5kLW1hcHBlciBoYXMgbm8gc2Vzc2lvbiB0byBjbG9zZSwgc28gaXQgbmV2ZXIgcHJpbnRzIGB0YWlsLmNsb3NlZGAuXG4gKiAgICAgIE1lYXN1cmVkIG9uIGEgcmVhbCBga2lsbCAtOWAgdW5kZXIgYSBgLS1vbmNlYDogYHRhaWwubG9zdGAgNyBzIGxhdGVyLFxuICogICAgICBub3QgMC43NSBzLCBiZWNhdXNlIG1pbmQtbWFwcGVyJ3Mgb3duIGJhY2tvZmYgc3RhcnRzIGF0IDEgcyAoMSArIDIgKyA0KS5cbiAqICAgICAgTTHigJNNMyB3ZXJlIGRyaXZlbiBvbiBhIHJlYWwgZGFlbW9uIHdpdGggYSA0IHMgd2luZG93OiBhY3RpdmUg4oaSIHdpbmRvdyxcbiAqICAgICAgcXVpZXQg4oaSIGAtLW9uY2VgLCBhIGh1bWFuIG1lc3NhZ2Ugd29rZSBpdCwgYmFjayB0byBNb25pdG9yOyBwcmVzZW5jZVxuICogICAgICBuZXZlciBkcm9wcGVkIGFjcm9zcyB0aGUgZ2Fwcy5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBDT01QTEVURSBCVVQgRk9SIFRIRSBMQVVOQ0hFUjogcGlubmVkIHRvIHRoZVxuICogICBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGUgc2tpbGxzIG5hbWUgdGhlXG4gKiAgIHJ1bGUgb25jZSwgbGF1bmNoZXIgZm9ybSBpbmNsdWRlZDsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICpcbiAqIFMxIMK3IFdITyBDTE9TRUQgSVQgUklERVMgVEhFIExJTkUgKHNjcmlwdG9yaXVtJ3MgRW5kIHNlc3Npb24sIDIwMjYtMTAtMDEpLlxuICogICAgICBBIHNwZWxsIHdob3NlIGBjbG9zZWRgIGZyYW1lIHNheXMgd2hvIGVuZGVkIHRoZSBzZXNzaW9uIHBhc3Nlc1xuICogICAgICBgY2xvc2VkQnlgLCBhbmQgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzIGBieWAuIGBieTogXCJodW1hblwiYCBjaGFuZ2VzXG4gKiAgICAgIHRoZSBoaW50OiB0aGUgaHVtYW4gZW5kZWQgaXQgT04gUFVSUE9TRSwgc28gdGhlIGFnZW50IHN0b3BzIGFuZCBkb2VzIG5vdFxuICogICAgICByZW9wZW4gdW5sZXNzIGFza2VkIOKAlCB0aGUgd2F5IGJhY2sgaXMgc3RpbGwgbmFtZWQsIGNvbmRpdGlvbmVkIG9uIHRoYXQuXG4gKiAgICAgIFRoZSBhZ2VudCByb3V0ZXMgb24gYGJ5YCwgbmV2ZXIgb24gdGhlIGhpbnQncyBwcm9zZS4gQSByZS1hcm0gYWZ0ZXJcbiAqICAgICAgdGhlIGVuZCBzZWVzIG5vIGNsb3NpbmcgZnJhbWUgKEQxJ3MgcGF0aCksIHNvIHRoZSBzcGVsbCBhbHNvIHBhc3Nlc1xuICogICAgICBgZ29uZUJ5YCwgcmVhZCBmcm9tIHdoZXJlIHRoZSBmYWN0IG91dGxpdmVzIHRoZSBkYWVtb247IHdpdGhvdXQgaXQgdGhlXG4gKiAgICAgIHJlLWFybWVkIGxpbmUgZHJvcHBlZCBgYnlgIGFuZCBpbnZpdGVkIHRoZSByZW9wZW4gKHZlcmlmaWVyLCAyMDI2LTEwLTAxKS5cbiAqICAgICAg4pqWIE9wdGlvbnMgbm90IHRha2VuOiBhIHNwZWxsLXNpZGUgcmV3cml0ZSBvZiB0aGUgcHJpbnRlZCBsaW5lIChhIHNlY29uZFxuICogICAgICB3cml0ZXIgb2YgdGhlIHNhbWUgbGluZSksIG9yIGEgc3BlbGwtc3VwcGxpZWQgaGludCAoZWFjaCBzcGVsbCB3b3VsZFxuICogICAgICB3b3JkIFwib24gcHVycG9zZVwiIGl0cyBvd24gd2F5KS5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICAvKiogV2hvIGVuZGVkIGEgYGNsb3NlZGAgc2Vzc2lvbiwgd2hlbiBpdHMgY2xvc2luZyBmcmFtZSBzYWlkIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGB0YWlsLmNsb3NlZGAgb25seTogd2hvIGVuZGVkIHRoZSBzZXNzaW9uLCB3aGVuIHRoZSBzcGVsbCBzYXlzIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICAvKiogYG1vbml0b3JgOiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYC5cbiAgICogIGBiYWNrZ3JvdW5kYDogcnVuIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrLlxuICAgKiAgYHN0b3BgOiBub3RoaW5nIHRvIHdhdGNoOyBgY29tbWFuZGAgaXMgaG93IHRvIGNvbWUgYmFjaywgaWYgd2FudGVkLiAqL1xuICBuZXh0OiBcIm1vbml0b3JcIiB8IFwiYmFja2dyb3VuZFwiIHwgXCJzdG9wXCI7XG4gIC8qKiBUaGUgdmVyYiBhbmQgaXRzIGFyZ3VtZW50cyBPTkxZIOKAlCBubyBsYXVuY2hlciwgbm8gcGF0aC4gVGhlIGFnZW50IHJ1bnNcbiAgICogIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPmAuICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgaGludDogc3RyaW5nO1xufTtcblxuLyoqIEhvdyB0aGUgYWdlbnQgcnVucyBhIHByaW50ZWQgYGNvbW1hbmRgOiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIG5ldmVyIGEgcGF0aFxuICogIHRoaXMgcHJvY2VzcyBuYW1lcyAodGhlIHJ1bGluZyBvbiB0aGUgdmVyc2lvbmVkIHBsdWdpbiBwYXRoLCBpbiB0aGUgaGVhZGVyKS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fV0lUSF9MQVVOQ0hFUiA9IFwiYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5cIjtcblxuLyoqIFRoZSBjb21lLWJhY2sgaGludCwgd2l0aCBob3cgdG8gUkVTVU1FIGFmdGVyIGNvbWluZyBiYWNrIChEMik6IGEgcmVzdG9yZWRcbiAqICBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBtZWFucyBub3RoaW5nIHRoZXJlLiAqL1xuY29uc3QgQ09NRV9CQUNLID0gKHdoeTogc3RyaW5nLCBsZWFkID0gXCJUbyBicmluZyBpdCBiYWNrXCIpID0+XG4gIGAke3doeX0gJHtsZWFkfSwgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9OyB0aGVuIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vIC0tc2luY2UsIG9uIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cyB3aGVyZSB0aGVyZSBpcyBvbmUgKGEgcmVzdGFydGVkIGRhZW1vbiBzdGFydHMgYSBuZXcgZXZlbnQgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIGRvZXMgbm90IGFwcGx5KWA7XG5cbi8qKlxuICogVEhFIERFQ0lTSU9OOiBnaXZlbiBob3cgdGhlIHRhaWwgZW5kZWQsIHdoaWNoIGxpbmUgaXQgcHJpbnRzLiBQdXJlLCBzbyBldmVyeVxuICogc3RhdGUgaXMgYSBsaXRlcmFsIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLiBSZXR1cm5zIG51bGwgZm9yIGBzdG9wcGVkYDpcbiAqIGEgaHVtYW4ncyBDdHJsLUMgb3IgYSBjYWxsZXIncyBhYm9ydCBpcyBub3QgYSBoYW5kb2ZmLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFuZG9mZihzOiBIYW5kb2ZmSW5wdXQsIGNtZDogSGFuZG9mZkNvbW1hbmRzKTogSGFuZG9mZkxpbmUgfCBudWxsIHtcbiAgY29uc3QgYmFzZSA9IHsgc3BlbGw6IHMuc3BlbGwsIGV2ZW50czogcy5ldmVudHMsIGN1cnNvcjogcy5jdXJzb3IgfTtcbiAgc3dpdGNoIChzLmVuZCkge1xuICAgIGNhc2UgXCJzdG9wcGVkXCI6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBjYXNlIFwiY2xvc2VkXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwuY2xvc2VkXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIC4uLihzLmJ5ID8geyBieTogcy5ieSB9IDoge30pLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgcy5ieSA9PT0gXCJodW1hblwiXG4gICAgICAgICAgICA/IENPTUVfQkFDSyhcbiAgICAgICAgICAgICAgICBcInRoZSBodW1hbiBlbmRlZCB0aGlzIHNlc3Npb24gb24gcHVycG9zZTsgc3RvcCB3YXRjaGluZywgYW5kIGRvIG5vdCByZW9wZW4gaXQgdW5sZXNzIHRoZXkgYXNrLlwiLFxuICAgICAgICAgICAgICAgIFwiSWYgdGhleSBhc2tcIixcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgOiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLS1zaW5jZT0tMSBmb3IgZXZlcnl0aGluZylcIlxuICAgICAgOiBgYW4gZXZlbnQgaWQgKGFuIGludGVnZXIsICR7bWlufSBvciBtb3JlKWA7XG4gIGNvbnN0IGZvcm1zID0gby5lcG9jaCA/IGAke2lkfSwgb3IgPGlkPkA8ZXBvY2g+IGFzIGEgaGFuZG9mZiBsaW5lIHByaW50cyBpdGAgOiBpZDtcbiAgY29uc3Qgd2h5ID1cbiAgICAhby5lcG9jaCAmJiB0b2tlbi5pbmNsdWRlcyhcIkBcIilcbiAgICAgID8gYDsgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgbm8gZXBvY2gsIHNvIHBhc3MgdGhlIGlkIHdpdGhvdXQgdGhlIFwiQOKAplwiIHBhcnRgXG4gICAgICA6IFwiXCI7XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIG1lc3NhZ2U6IGAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMg4oCUIGdpdmUgJHtmb3Jtc30ke3doeX1gLFxuICB9O1xufVxuXG4vKiogSm9pbiBhbiBhcmd2IGludG8gb25lIHJ1bm5hYmxlIGNvbW1hbmQgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kTGluZShhcmd2OiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBhcmd2Lm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOW0BlcG9jaF0gWy0tb25jZV1gLlxuICogIFBhc3MgYGVwb2NoYCBvbmx5IGZvciBhIHNwZWxsIHdob3NlIGAtLXNpbmNlYCBwYXJzZXMgaXQgKGBwYXJzZUJvb2ttYXJrYCkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQoXG4gIHByZWZpeDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHNpbmNlOiBudW1iZXIsXG4gIG9uY2U6IGJvb2xlYW4sXG4gIGVwb2NoPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgbWFyayA9IGVwb2NoID8gYCR7c2luY2V9QCR7ZXBvY2h9YCA6IFN0cmluZyhzaW5jZSk7XG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7bWFya31gXSA6IFtcIi0tc2luY2VcIiwgbWFya107XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICAvKiogVGhlIHNwZWxsJ3MgbmFtZSwgY2FycmllZCBvbiB0aGUgbGluZSAod2hvc2UgbGF1bmNoZXIgcnVucyBpdCkuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogQSBwcmVzZW5jZSBzcGVsbDogYWx3YXlzIGB0YWlsLndpbmRvd2AgYXQgdGhlIHdpbmRvdydzIGVuZCwgbmV2ZXIgbG9zdC4gKi9cbiAgcHJlc2VuY2U6IGJvb2xlYW47XG4gIC8qKiBEZWZhdWx0OiBgcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKWAuIGAwYCA9IG5vIHdpbmRvdy4gKi9cbiAgd2luZG93TXM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIGFuIGVtaXR0ZWQgZnJhbWUgaXMgYSBMT0cgZnJhbWUgKEEzKS4gRGVmYXVsdDogZXZlcnkgb25lLiAqL1xuICBjb3VudHM/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBXaGljaCB0ZXJtaW5hbCBmcmFtZSBtZWFucyB0aGUgc2Vzc2lvbiBjbG9zZWQuIERlZmF1bHQ6IGV2ZXJ5IHRlcm1pbmFsLiAqL1xuICBpc0Nsb3NlZD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBXaG8gdGhlIGNsb3NpbmcgZnJhbWUgc2F5cyBlbmRlZCB0aGUgc2Vzc2lvbiAoUzEpOyBjYXJyaWVkIG9uIGB0YWlsLmNsb3NlZGAuICovXG4gIGNsb3NlZEJ5PzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogV2hvIGVuZGVkIGEgc2Vzc2lvbiBmb3VuZCBHT05FIChEMTogcmUtYXJtZWQgYWZ0ZXIgaXQgY2xvc2VkLCBzbyBub1xuICAgKiAgY2xvc2luZyBmcmFtZSBpcyBldmVyIHNlZW4pLCByZWFkIGZyb20gd2hlcmV2ZXIgdGhlIHNwZWxsIGtlZXBzIGl0IOKAlCBhXG4gICAqICBtYW5pZmVzdCB0aGF0IG91dGxpdmVzIHRoZSBkYWVtb24uIENhcnJpZWQgb24gYHRhaWwuY2xvc2VkYCBhcyBgYnlgLCBzb1xuICAgKiAgdGhlIGxpbmUgc2F5cyB3aGF0IHRoZSBsaXZlIHBhdGgncyBgY2xvc2VkQnlgIHdvdWxkIGhhdmUgKFMxKS4gKi9cbiAgZ29uZUJ5PzogKCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gdGFpbC5zaW5jZUVwb2NoO1xuICBsZXQgZnJhbWVIYXNJZCA9IGZhbHNlO1xuICAvKiogQTMgKyBEMzogYSBmcmFtZSBjb3VudHMsIGFuZCB3YWtlcyBhIGAtLW9uY2VgLCBvbmx5IHdoZW4gaXQgaXMgT04gVEhFXG4gICAqICBMT0cg4oCUIGl0IGNhcnJpZXMgYSBsb2cgaWQg4oCUIGFuZCB0aGUgc3BlbGwncyBvd24gYGNvdW50c2AgYWdyZWVzLiBBIHRhYidzXG4gICAqICBpZC1sZXNzIGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgIHBpbmcgaXMgbm90IG9uIHRoZSBsb2cuICovXG4gIGNvbnN0IGlzTG9nRnJhbWUgPSAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGZyYW1lSGFzSWQgJiYgY291bnRzKGV2LCBmcmFtZSk7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZEJ5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICAvLyBEMidzIG5ldC4gT24gZm9yIGV2ZXJ5IHNwZWxsOiBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3JcbiAgICAgIC8vIG1lYW5zIGEgd2hvbGUgcmVwbGF5IG9uIHRoZSBraXQncyBsb2csIGFuZCBvbiBncmFwZXZpbmUncyBkdXJhYmxlIGxvZ1xuICAgICAgLy8gaXQgaGFwcGVucyBvbmx5IHdoZW4gYC0tbGFzdGAgcmVhY2hlcyBiZWxvdyBgLS1zaW5jZWAsIHdoZXJlXG4gICAgICAvLyByZS1yZWFkaW5nIHRoZSBjdXJzb3IgZnJvbSB0aGUgZnJhbWVzIGlzIHRoZSBtb3JlIGNvcnJlY3QgYW5zd2VyLlxuICAgICAgcmVzdGFydE9uUmVwbGF5OiB0cnVlLFxuICAgICAgLy8gRDM6IHJlbWVtYmVyIHdoZXRoZXIgVEhJUyBmcmFtZSBjYXJyaWVzIGEgbG9nIGlkLiBgdGFpbEV2ZW50c2AgcmVhZHNcbiAgICAgIC8vIHRoZSBjdXJzb3Igb25jZSBwZXIgZnJhbWUsIGJlZm9yZSBgYWNjZXB0YCwgYHRlcm1pbmFsYCBhbmQgYHJlbmRlcmAuXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGNvbnN0IG4gPSB0YWlsLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICBmcmFtZUhhc0lkID0gdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pO1xuICAgICAgICByZXR1cm4gbjtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCB0aGF0IGdpdmVzIHVwIG9uIGZpbmRpbmcgaXRzIHNlc3Npb24gaXMgd2F0Y2hpbmcgYVxuICAgICAgICAvLyBzZXNzaW9uIHRoYXQgaXMgZ29uZSDigJQgd2hldGhlciB0aGlzIHByb2Nlc3MgZXZlciByZWFjaGVkIGl0IChpdHNcbiAgICAgICAgLy8gcG9pbnRlciB2YW5pc2hlZCkgb3IgaXQgd2FzIHJlLWFybWVkIGF0IG9uZSB0aGF0IGNsb3NlZCBpbiB0aGUgZ2FwLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgZW5kID0gXCJjbG9zZWRcIjtcbiAgICAgICAgICBjbG9zZWRCeSA9IGguZ29uZUJ5Py4oKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSBldmVudHMgKz0gMTtcbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgdGVybWluYWw6IChldiwgZnJhbWUsIGFjY2VwdGVkKSA9PiB7XG4gICAgICAgIGlmICh0YWlsLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgICBlbmQgPSAoaC5pc0Nsb3NlZCA/PyAoKCkgPT4gdHJ1ZSkpKGV2KSA/IFwiY2xvc2VkXCIgOiBcImV2ZW50XCI7XG4gICAgICAgICAgICBpZiAoZW5kID09PSBcImNsb3NlZFwiKSBjbG9zZWRCeSA9IGguY2xvc2VkQnk/Lihldik7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIGVwb2NoID0gcy5lcG9jaCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICAuLi4oY2xvc2VkQnkgPyB7IGJ5OiBjbG9zZWRCeSB9IDoge30pLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSksXG4gICAgICAgIHByZXNlbmNlOiBoLnByZXNlbmNlLFxuICAgICAgICBzcGVsbDogaC5zcGVsbCxcbiAgICAgIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogTWluZC1tYXBwZXIncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIG9mIHRoZSBzcGVsbCwgYW5kIFRIRSBPTkUgUExBQ0UgVEhFIEVOViBJUyBSRUFELlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0sIEFORCBGT1IgTUlORC1NQVBQRVIgVEhFIFNFQU0gV0FTIFJFQUwgQU5EXG4gKiBIQU5ELU1JUlJPUkVELiBCZWZvcmUgUGhhc2UgNyB0aGUga2VlcGFsaXZlIHdhcyBhIGxpdGVyYWwgYDE1XzAwMGAgaW5zaWRlXG4gKiBgc2VydmVyLnRzYCdzIGBrZWVwYWxpdmVNcygpYCwgYGlkbGVUaW1lb3V0OiAyNTVgIHdhcyBhIHNlY29uZCBsaXRlcmFsIGFcbiAqIGh1bmRyZWQgbGluZXMgYXdheSB3aXRoIHRoZSByZWxhdGlvbnNoaXAgd3JpdHRlbiBvbmx5IGluIHByb3NlLCBhbmQgdGhlXG4gKiBDTEkncyB0YWlsIGNhcnJpZWQgYSBIQVJELUNPREVEIGA0NV8wMDBgIHdhdGNoZG9nIHVuZGVyIGEgY29tbWVudCBzYXlpbmdcbiAqIFwi4omIIDMgbWlzc2VkIHNlcnZlciBrZWVwYWxpdmVzICgxNXMgdGljaywgQ2xhaW0gRilcIiDigJQgdGhyZWUgbnVtYmVycywgdHdvXG4gKiBmaWxlcywgYW5kIHRoZSBhcml0aG1ldGljIHR5aW5nIHRoZW0gdG9nZXRoZXIgbGl2aW5nIGluIGEgc2VudGVuY2UuIE5laXRoZXJcbiAqIGZpbGUgY291bGQgaW1wb3J0IHRoZSBvdGhlcjogdGhlIENMSSByZWFjaGluZyBpbnRvIHRoZSBkYWVtb24gd291bGQgZHJhZyB0aGVcbiAqIHdob2xlIDIzLW1vZHVsZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aG9zZSBvbmx5IGltcG9ydHNcbiAqIGFyZSB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqICoqQSB2YWx1ZSB0aGF0IGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0KiosIGFuZCB0aGVcbiAqIFwi4omIXCIgaW4gdGhhdCBjb21tZW50IGlzIG5vdyBhbiBgPWAuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gTUlORC1NQVBQRVInUyBPV04gSEVBUlRCRUFULCBORVZFUlxuICogQ09QSUVEIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgdGhlIHJ1bGUgYXN0cm9sYWJlIHBhaWQgZm9yOiBhIGhhcmQtY29kZWRcbiAqIDQ1IHMgd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcyxcbiAqICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHlcbiAqIGJlY2F1c2UgYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4g4pqgIE1pbmQtbWFwcGVyIGlzIHRoZVxuICogc3BlbGwgdGhhdCB3YXMgT05FIEVOViBWQVIgYXdheSBmcm9tIHRoYXQgZXhhY3QgZGVmZWN0OiBpdHMga2VlcGFsaXZlIGFscmVhZHlcbiAqIHRvb2sgYE1JTkRfTUFQUEVSX0tFRVBBTElWRV9NU2AgKGl0cyBvd24gcHJlc2VuY2Ugc3VpdGUgZHJpdmVzIGl0IGF0IDI1IG1zKVxuICogd2hpbGUgdGhlIHdhdGNoZG9nIHdhcyBhIGxpdGVyYWwsIHNvIGFueSBrZWVwYWxpdmUgYWJvdmUgMTUgcyBhbHJlYWR5IGJyb2tlXG4gKiBldmVyeSB0YWlsIGFuZCBhbnkga2VlcGFsaXZlIGJlbG93IGl0IG1hZGUgdGhlIHdhdGNoZG9nIHRvbGVyYXRlIGZhciBtb3JlXG4gKiB0aGFuIHRocmVlIG1pc3NlZCBiZWF0cy4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tIHRoZVxuICogYmVhdCBpdCBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDim5QgKipUSEUgRU5WIElTIFJFU09MVkVEIEhFUkUgQU5EIE5PV0hFUkUgRUxTRSAoRDc1KSwgQU5EIEZPUiBUSElTIFNQRUxMIFRIQVRcbiAqIFJVTEUgSVMgTE9BRC1CRUFSSU5HIFJBVEhFUiBUSEFOIFRJRFkuKiogR3JhcGV2aW5lJ3MgcG9ydCBzaGlwcGVkIHRoZSBiZWF0J3NcbiAqIGtub2IgaW4gYGRhZW1vbi50c2AgYW5kIGxlZnQgaXRzIHNlYW0gZmlsZSBkZXJpdmluZyB0aGUgd2F0Y2hkb2cgZnJvbSB0aGVcbiAqIExJVEVSQUwgZGVmYXVsdDogdGhlIGRhZW1vbidzIGJlYXQgd2FzIHR1bmFibGUgYW5kIHRoZSBDTEkncyB3YXRjaGRvZyB3YXNcbiAqIG5vdCwgYW5kIGFueSB2YWx1ZSBhYm92ZSB0aGUgZGVmYXVsdCBicm9rZSBldmVyeSB0YWlsIOKAlCBpbnZpc2libGUgYXQgdGhlXG4gKiBkZWZhdWx0LCB3aGljaCBpcyB3aHkgaXQgc2hpcHBlZC4gVGhlIGdlbmVyYWxpc2F0aW9uOiAqKmFuIGVudiBrbm9iIG11c3QgYmVcbiAqIHJlc29sdmVkIGF0IHRoZSBMT1dFU1QgcG9pbnQgZXZlcnkgY29uc3VtZXIgb2YgdGhlIGRlcml2ZWQgdmFsdWUgY2FuIHNlZS4qKlxuICogYHByb2Nlc3MuZW52YCBpcyBhbWJpZW50IGluIGJvdGggaGFsdmVzLCB3aGljaCBpcyBleGFjdGx5IHdoeSB0aGlzIGZpbGUg4oCUIGFuZFxuICogbm90IGBzZXJ2ZXIudHNgIOKAlCBjYW4gaG9sZCB0aGUgcmVzb2x1dGlvbiwgYW5kIHJlYWRpbmcgaXQgaGVyZSBpcyBub3QgdGhlXG4gKiBraW5kIG9mIGltcG9ydCB0aGF0IGNsb3NlcyB0aGUgc2VhbS5cbiAqXG4gKiDim5QgKipBTkQgVEhFIERFUklWQVRJT04gU1VQUExJRVMgVEhFIERFRkFVTFQsIE5PVCBUSEUgVkFMVUUgKEQ4MikuKiogVGhlIHR3b1xuICogdGFpbCBrbm9icyBiZWxvdyBhcmUgdGhlIHJlYXNvbjogYGJhY2tlbmQvdGFpbC50ZXN0LnRzYCBpcyB0aGUgcmVwbydzIE9OTFlcbiAqIGV4ZWN1dGFibGUgdGFpbCBzcGVjaWZpY2F0aW9uLCBpdCBpcyB0aGlzIHBvcnQncyBPUkFDTEUsIGFuZCBhbGwgZm91ciBvZiBpdHNcbiAqIGNlbGxzIGRyaXZlIGBNSU5EX01BUFBFUl9UQUlMX0lETEVfTVM9MjAwYCAvIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TPTUwYC5cbiAqIFdyaXR0ZW4gZ2xhbW91cidzIHdheSDigJQgdGhyZWUgcGxhaW4gYGV4cG9ydCBjb25zdGBzIHdpdGggbm8gb3ZlcnJpZGUgYW55d2hlcmVcbiAqIOKAlCB0aGUgaWRsZS13YXRjaGRvZyBjZWxsIEZBSUxTIChhIDQ1LDAwMCBtcyB3YXRjaGRvZyBjYW5ub3QgZmlyZSBpbnNpZGUgaXRzXG4gKiA1IHMgZGVhZGxpbmUsIGFuZCBpdCByZWFkcyBhcyBhIGJyb2tlbiB3YXRjaGRvZykgYW5kIHRoZSBrZWVwYWxpdmUgY2VsbFxuICogKipQQVNTRVMgVkFDVU9VU0xZKio6IGl0IGFzc2VydHMgdGhhdCBub3RoaW5nIHdhcyBhYm9ydGVkLCBhbmQgNDUgcyBjYW5ub3RcbiAqIGFib3J0IGFueXRoaW5nIGluc2lkZSBpdHMgODAwIG1zIHdpbmRvdy4gQSBncmVlbiBjZWxsIHRoYXQgbG9zdCBpdHMgc3ViamVjdFxuICogaXMgd29yc2UgdGhhbiBhIHJlZCBvbmUuIOKaoCBBbmQgdGhlIGtub2IgY2Fubm90IGJlIHJvdXRlZCB0aHJvdWdoIHRoZSBCRUFUXG4gKiBpbnN0ZWFkOiB0aGUga2l0IGZsb29ycyBgaGVhcnRiZWF0TXNgIGF0IGBNSU5fSEVBUlRCRUFUX01TID0gNTAwYCAoRDc2IOKAlCB0aGVcbiAqIGZsb29yIGxpdmVzIGF0IHRoZSBkZXJpdmF0aW9uKSwgc28gdGhlIHNtYWxsZXN0IHdhdGNoZG9nIHJlYWNoYWJsZSB0aHJvdWdoXG4gKiBgdGFpbElkbGVNc2AgaXMgMSw1MDAgbXMgYW5kICoqMjAwIG1zIGlzIHVucmVhY2hhYmxlIHRoYXQgd2F5IGJ5XG4gKiBjb25zdHJ1Y3Rpb24uKiogYHRhaWxJZGxlTXNgIGNhcnJpZXMgbm8gZmxvb3Igb2YgaXRzIG93biwgc28gYSBkaXJlY3RcbiAqIG92ZXJyaWRlIHJlYWNoZXMgaXQuXG4gKlxuICog4pqgICoqVGhlIG1hcHBpbmcgYmVsb3cgd2FzIHdyaXR0ZW4gZWlnaHQgbW9udGhzIGVhcmx5IGFuZCBhZGRyZXNzZWQgdG9cbiAqIG5vYm9keSoqIOKAlCBgcGhhc2UtMS1qb3VybmFsLm1kOjE1MS0xNTVgIG5hbWVkIGBNSU5EX01BUFBFUl9UQUlMX0lETEVfTVNgIOKGklxuICogYGlkbGVNc2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCDihpIgYHJldHJ5LmluaXRpYWxNc2AgYW5kIGNvbmNsdWRlZFxuICogXCJhIHNwZWxsIHdob3NlIHRlc3RzIGRyaXZlIGEgc2hvcnQgd2luZG93IHdpbGwgbmVlZCBvbmUsIGFuZCBpdCBzaG91bGQgYmVcbiAqIHRoYXQgc3BlbGwncyBlbnYgdmFyLCBub3QgdGhlIGtpdCdzXCIuIFRoaXMgaXMgdGhhdCBzcGVsbCAoRDg0KS5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIGhlYXJ0YmVhdE1zLFxuICBpZGxlVGltZW91dFNlYyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBBIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIG9yIHRoZSBmYWxsYmFjay5cbiAqXG4gKiDimqAgVEhFIEtJVCdTIGBpbnRPcmAgSVMgTk9UIEVYUE9SVEVELCBkZWxpYmVyYXRlbHkg4oCUIGl0IGlzIHRoZSBwcml2YXRlIHBhcnNlclxuICogYmVoaW5kIGBoZWFydGJlYXRNc2AvYGlkbGVUaW1lb3V0U2VjYCwgYW5kIEQ3NiBydWxlZCB0aGF0IGEga25vYiB3aXRoIGEga25vd25cbiAqIHNhZmUgbWluaW11bSBjbGFtcHMgYXQgaXRzIERFUklWQVRJT04gcmF0aGVyIHRoYW4gaW4gdGhlIHNoYXJlZCBwYXJzZXIuIFNvXG4gKiB0aGlzIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGNvcHkgb2YgdGhlIHNhbWUgdGhyZWUgbGluZXMsIHdpdGggdGhlIHNhbWVcbiAqIGBwYXJzZUludGAgc2VtYW50aWNzIHRoZSBraXQgZG9jdW1lbnRzIChgXCIxZTlcImAgaXMgMSwgYFwiNWFiY1wiYCBpcyA1KSBhbmQgdGhlXG4gKiBzYW1lIFwiYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlIHRha2VzIHRoZSBmYWxsYmFja1wiIHJ1bGUuXG4gKiBJdCBpcyB0aGUgZXhwcmVzc2lvbiB0aGUgQ0xJJ3Mgb3duIGBlbnZNc2AgdXNlZCBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQuXG4gKlxuICog4puUIEFORCBUSEUgVFdPIFRBSUwgS05PQlMgQkVMT1cgREVMSUJFUkFURUxZIEhBVkUgTk8gRkxPT1IuIEEgd2F0Y2hkb2cgYW5kIGFcbiAqIHJlY29ubmVjdCBkZWxheSBhcmUgdGhlIHR3byB2YWx1ZXMgdGhpcyBzcGVsbCdzIG93biB0ZXN0IHN1aXRlIG11c3QgYmUgYWJsZVxuICogdG8gZHJpdmUgRE9XTiB0byAyMDAgbXMgYW5kIDUwIG1zOyBhIGZsb29yIGhlcmUgd291bGQgbWFrZSB0aGUgb3JhY2xlXG4gKiB1bnJlYWNoYWJsZSwgd2hpY2ggaXMgdGhlIGRlZmVjdCBEODIgd2FzIHdyaXR0ZW4gYWJvdXQuIFRoZSBmbG9vciBleGlzdHNcbiAqIHdoZXJlIHRoZSBmbG9vZCByaXNrIGlzIOKAlCBvbiB0aGUgQkVBVCwgaW4gdGhlIGtpdC5cbiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBNaW5kLW1hcHBlcidzIG93biBtZWFzdXJlZCB2YWx1ZSxcbiAqIG5vdCBhbiBpbmhlcml0ZWQgb25lOiBgc2VydmVyLnRzYCBjYXJyaWVkIGBpZGxlVGltZW91dDogMjU1YCB1bmRlciBhIGNvbW1lbnRcbiAqIHJlY29yZGluZyB0aGF0IFNTRSBhbmQgV1MgY29ubmVjdGlvbnMgb24gYC9ldmVudHNgIHNpdCBpZGxlIGJldHdlZW4gZW1pdHMgYnlcbiAqIGRlc2lnbiwgdGhhdCBCdW4ncyBkZWZhdWx0IDEwIHMgd291bGQgcmVzZXQgYSBxdWlldCBzdHJlYW0sIGFuZCB0aGF0IGAwYCBpc1xuICogbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgc3RhbGxzIHRoZSBpbml0aWFsIHJlc3BvbnNlIOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYVxuICogY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uXG4gKlxuICog4pqgIGBNSU5EX01BUFBFUl9JRExFX1RJTUVPVVRfU0VDYCBpcyBhY2NlcHRlZCBzbyB0aGUgUEFJUiBjYW4gYmUgdHVuZWRcbiAqIHRvZ2V0aGVyLCBhbmQgdGhlIGNsYW1wIGluIGBoZWFydGJlYXRNc2AgYmVsb3cgaXMgd2hhdCBrZWVwcyB0aGVtIGEgcGFpci5cbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBpZGxlVGltZW91dFNlYyhcbiAgcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfSURMRV9USU1FT1VUX1NFQyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4pO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBhbmQgbWluZC1tYXBwZXIncyBvd24gbGl0ZXJhbCAoQ2xhaW0gRidzIDE1IHNcbiAqICB0aWNrKSBiZWZvcmUgdGhpcyBmaWxlIGV4aXN0ZWQg4oCUIHRoZSBERUZBVUxULCBiZWZvcmUgdGhlIGVudiBpcyBjb25zdWx0ZWQuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKlxuICogVGhlIFNTRSBrZWVwYWxpdmUsIGluIG1zLCBlbnYtcmVzb2x2ZWQgYW5kIGNsYW1wZWQgYXQgYm90aCBlbmRzIGJ5IHRoZSBraXQ6XG4gKiBuZXZlciBhYm92ZSBgSURMRV9USU1FT1VUX1NFQyAvIDJgIChvciBCdW4gY2xvc2VzIHRoZSBjb25uZWN0aW9uIHRoZVxuICoga2VlcGFsaXZlIHdhcyBwcmVzZXJ2aW5nKSwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIOKblCBUSEUgRkxPT1IgSVMgTk9UIERFQ09SQVRJT04gKEQ3NikuIGBNSU5EX01BUFBFUl9LRUVQQUxJVkVfTVNgIGlzIGEga25vYlxuICogbWluZC1tYXBwZXIncyBvd24gcHJlc2VuY2Ugc3VpdGUgZHJpdmVzLCBhbmQgYHBhcnNlSW50YCByZWFkcyBgXCIxZTlcImAg4oCUIHRoZVxuICogbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0IGh1Z2VcIiDigJQgYXMgKioxKiouIERyaXZlbiBhdCBncmFwZXZpbmUnc1xuICogcmVwYWlyIGJlZm9yZSB0aGUgZmxvb3IgZXhpc3RlZDogYSAxIG1zIGJlYXQgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG9cbiAqIGV2ZXJ5IG9wZW4gU1NFIGNsaWVudCBpbiA1MjggbXMuXG4gKlxuICog4pqgIEFORCBGT1IgVEhJUyBTUEVMTCBUSEUgQkVBVCBBTFNPIEJPVU5EUyBBIEhVTUFOLVZJU0lCTEUgTlVNQkVSLiBQcmVzZW5jZVxuICogKENsYWltIEMpIGlzIGNvdW50ZWQgYXQgU1NFIHN1YnNjcmliZS91bnN1YnNjcmliZSBhbmQgYSBkZWFkIHNvY2tldCBpcyBvbmx5XG4gKiByZWNsYWltZWQgd2hlbiB0aGUgbmV4dCBrZWVwYWxpdmUgd3JpdGUgZmFpbHMsIHNvIHJhaXNpbmcgdGhpcyBrbm9iIG1ha2VzIHRoZVxuICogYWdlbnQgY291bnQgaW4gdGhlIGJvYXJkJ3MgYWN0aXZpdHkgaW5kaWNhdG9yIHN0YWxlciwgbm90IGp1c3QgcXVpZXRlci5cbiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBoZWFydGJlYXRNcyhcbiAgcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfS0VFUEFMSVZFX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuIDQ1LDAwMCBtcyBhdCB0aGUgZGVmYXVsdCDigJRcbiAqIHdoaWNoIGlzIHRoZSBudW1iZXIgYGNsaS50c2AgdXNlZCB0byBoYXJkLWNvZGUsIHNvIHRoZSBwb3J0IGNoYW5nZXMgbm9cbiAqIGRlZmF1bHQgd2hpbGUgbWFraW5nIHRoZSByZWxhdGlvbnNoaXAgdHJ1ZSBhdCBldmVyeSBvdGhlciB2YWx1ZS5cbiAqXG4gKiDim5QgREVSSVZFRCBGUk9NIFRIRSBSRVNPTFZFRCBCRUFULCBORVZFUiBGUk9NIFRIRSBERUZBVUxUIOKAlCBncmFwZXZpbmUnc1xuICogcmVwYWlyIGNoYXB0ZXIgaXMgd2hhdCB0aGUgZGlmZmVyZW5jZSBjb3N0LiBBbmQgdGhlIGVudiBvdmVycmlkZSBpcyB0aGVcbiAqIEZBTExCQUNLJ3MgcmVwbGFjZW1lbnQsIG5vdCB0aGUgZGVyaXZhdGlvbidzOiB0aGUgZGVyaXZhdGlvbiBpcyB3aGF0IHRoZSBrbm9iXG4gKiBmYWxscyBiYWNrIHRvLCBzbyBhbiB1bnR1bmVkIHRhaWwgc3RpbGwgd2F0Y2hlcyB0aHJlZSBvZiB0aGlzIGRhZW1vbidzIGJlYXRzLlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gaW50T3IoXG4gIHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX1RBSUxfSURMRV9NUyxcbiAgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKSxcbik7XG5cbi8qKlxuICogVGhlIHJlY29ubmVjdCBiYWNrb2ZmJ3MgRklSU1QgZGVsYXksIGluIG1zLiAxLDAwMCB0b2RheSwgd2hpY2ggaXMgd2hhdFxuICogYGNsaS50c2AncyBgcmV0cnlNc2AgZGVmYXVsdGVkIHRvLlxuICpcbiAqIOKblCBBTkQgVEhFIFNIQVBFIENIQU5HRVMgRVZFTiBUSE9VR0ggVEhFIE5VTUJFUiBET0VTIE5PVDogdGhlIGhhbmQtcm9sbGVkXG4gKiBsb29wIHNsZXB0IHRoaXMgbG9uZyBhZnRlciBFVkVSWSBmYWlsZWQgYXR0ZW1wdCwgZmxhdCwgZm9yZXZlciDigJQgYVxuICogY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtLCBhbmQgbWluZC1tYXBwZXIgaXMgdGhlIHNwZWxsXG4gKiBgdGFpbEV2ZW50c2AncyBvd24gd2FybmluZyBhYm91dCB0aGF0IGJyYW5jaCB3YXMgd3JpdHRlbiBhYm91dC4gVGhlIGtpdFxuICogZG91YmxlcyBpdCB0byBgbWF4TXNgIGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4sIHNvIGEgZGVhZCBkYWVtb24gaXNcbiAqIGJhY2tlZCBvZmYgZnJvbSBpbnN0ZWFkIG9mIGhhbW1lcmVkLlxuICovXG5leHBvcnQgY29uc3QgVEFJTF9SRVRSWV9NUyA9IGludE9yKHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX1RBSUxfUkVUUllfTVMsIDFfMDAwKTtcblxuLyoqIFRoZSBiYWNrb2ZmIGNlaWxpbmcsIHRoZSBraXQncyBkZWZhdWx0LCBzdGF0ZWQgaGVyZSBzbyBib3RoIGhhbHZlcyBjYW4gc2VlXG4gKiAgdGhlIHdob2xlIHJldHJ5IHNoYXBlIGluIG9uZSBwbGFjZSByYXRoZXIgdGhhbiBoYWxmIG9mIGl0LiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfUkVUUllfTUFYX01TID0gNV8wMDA7XG4i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
