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
    for (const f of c.requiredFlags ?? []) {
      if (!c.flags.includes(f))
        throw new Error(`defineCli(${cliName}): row "${c.name}" requires flag "${f}", not one of its own`);
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
      flagHelp: { ...c.flagHelp ?? {} },
      examples: [...c.examples ?? []],
      required: new Set(c.requiredFlags ?? []),
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
      positionals: [{ name: "verb", required: false, variadic: true }],
      describe: "show this message (alias: --help, -h); `help <verb>` shows one verb: its usage, each flag, and examples",
      run: (inv) => {
        const text = inv.pos.length > 0 ? cli.renderVerbHelp(inv.pos.join(" ")) : cli.renderHelp();
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
  const renderFlag = (k, required = false) => {
    const flag = spec.options[k]?.type === "boolean" ? `--${k}` : `--${k} ..`;
    return required ? flag : `[${flag}]`;
  };
  const usageLine = (r) => [
    label(r),
    ...r.positionals.map(renderPositional),
    ...r.flags.filter((k) => !hides.has(k)).map((k) => renderFlag(k, r.required.has(k)))
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
  const renderRowHelp = (r) => {
    const line = (k) => {
      const value = spec.options[k]?.type === "boolean" ? `--${k}` : `--${k} <${k}>`;
      return [value, r.flagHelp[k] ?? ""];
    };
    const isGlobal = (k) => !r.flags.includes(k) || globals.includes(k);
    const own = r.accepted.filter((k) => !isGlobal(k) && !hides.has(k)).map(line);
    const global = r.accepted.filter(isGlobal).map(line);
    const hidden = r.accepted.filter((k) => !isGlobal(k) && hides.has(k)).map(line);
    const width = Math.min(Math.max(0, ...[...own, ...global, ...hidden].map(([f]) => f.length)), 28);
    const render = (flags) => flags.map(([f, d]) => d === "" ? `  ${f}` : f.length <= width ? `  ${f.padEnd(width)}  ${d}` : `  ${f}
  ${"".padEnd(width)}  ${d}`);
    return [
      `usage: ${usageLine(r)}`,
      ...r.describe !== "" ? ["", r.describe] : [],
      ...own.length > 0 ? ["", "flags:", ...render(own)] : [],
      ...global.length > 0 ? ["", "global flags:", ...render(global)] : [],
      ...hidden.length > 0 ? ["", "also accepted:", ...render(hidden)] : [],
      ...r.examples.length > 0 ? ["", "examples:", ...r.examples.map((e) => `  ${e}`)] : []
    ].join(`
`);
  };
  const renderVerbHelp = (path) => {
    const r = byToken.get(path);
    if (r === undefined)
      return die(`help: no verb "${path}"`, "usage", {
        choices: paths,
        hint: "help with no verb lists them all"
      });
    return renderRowHelp(r);
  };
  const helpOptions = known.has("help") ? undefined : {
    ...parseOptions,
    help: shortToKey.has("h") ? { type: "boolean" } : { type: "boolean", short: "h" }
  };
  const asksForHelp = (row, args) => {
    if (helpOptions === undefined)
      return false;
    try {
      const { tokens } = parseArgs({
        args: [...args],
        options: helpOptions,
        strict: true,
        allowPositionals: row.allowPositionals,
        tokens: true
      });
      return tokens.some((t) => t.kind === "option" && t.name === "help");
    } catch {
      return false;
    }
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
    if (asksForHelp(row, args)) {
      process.stdout.write(`${renderRowHelp(row)}
`);
      return 0;
    }
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
    for (const k of row.required)
      if (flags[k] === undefined)
        die(`${name}: missing required --${k}`, "usage", { hint: expects(row) });
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
    renderVerbHelp,
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
  const stopBase = s.cursor >= 0 ? base : { spell: s.spell, events: s.events };
  switch (s.end) {
    case "stopped":
      return null;
    case "closed":
      return {
        type: "tail.closed",
        ...stopBase,
        ...s.by ? { by: s.by } : {},
        next: "stop",
        command: cmd.comeBack(),
        hint: s.by === "human" ? COME_BACK("the human ended this session on purpose; stop watching, and do not reopen it unless they ask.", "If they ask") : COME_BACK("the session closed; there is nothing left to watch.")
      };
    case "lost":
      return {
        type: "tail.lost",
        ...stopBase,
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
