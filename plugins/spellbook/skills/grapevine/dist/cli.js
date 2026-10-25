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
async function untilDaemonGone(verb) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (await readDaemonPort() === null)
      return;
  }
  let pid = null;
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10) || null;
  } catch {}
  const prefix = invocationPrefix();
  die2(`${verb}: the daemon${pid ? ` (pid ${pid})` : ""} was told to stop and still answers after 5 s, ` + `so ${verb === "stop" ? "it was not stopped" : "no new daemon was started"}. ` + `Stop it by its pid${pid ? ` (kill ${pid})` : ""}, then run ${verb} again.`, "internal", {
    token: "daemon_still_running",
    hint: prefix ? `try: ${prefix} doctor` : "try the `doctor` verb"
  });
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
  await untilDaemonGone("stop");
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
  await untilDaemonGone("restart");
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
  try {
    await untilDaemonGone("roll");
  } finally {
    releaseHold();
  }
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

//# debugId=D83C5A9C38DC8A6464756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2NsaS9yZWdpc3RyeS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ3JhcGV2aW5lL2JhY2tlbmQvaGVhcnRiZWF0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBncmFwZXZpbmUgQ0xJIOKAlCB0aGluIHdyYXBwZXIgYXJvdW5kIHRoZSBkYWVtb24ncyBIVFRQIHN1cmZhY2UuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiA8bmFtZT5cbi8vICAgYnVuIGNsaS50cyBsaXN0XG4vLyAgIGJ1biBjbGkudHMgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XG4vLyAgIGJ1biBjbGkudHMgdGFpbCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dXG4vLyAgIGJ1biBjbGkudHMgcmVhZCA8bmFtZT4gPGlkPiBbLS10ZXh0XVxuLy8gICBidW4gY2xpLnRzIGNsb3NlIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIHN0b3Bcbi8vICAgYnVuIGNsaS50cyBpbmZvXG4vL1xuLy8gYHRhaWxgIHdyaXRlcyBlYWNoIGluY29taW5nIG1lc3NhZ2UgYXMgb25lIEpTT05MIGxpbmUgb24gc3Rkb3V0LiBQaXBlXG4vLyBvciB3cmFwIHdpdGggTW9uaXRvci5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyB0eXBlIENvbW1hbmRTcGVjLCBkZWZpbmVDbGksIHR5cGUgSW52b2NhdGlvbiB9IGZyb20gXCIuLi8uLi9raXQvY2xpL3JlZ2lzdHJ5LnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEVyckV4dHJhLFxuICB0eXBlIEVycktpbmQsXG4gIGRpZSBhcyByYWlzZSxcbiAgcmVwb3J0Q2xpRXJyb3IsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRMaW5lLFxuICByZWFkU2luY2UsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZi50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5cbmNvbnN0IERBVEFfRElSID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmdyYXBldmluZVwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBvcnRcIik7XG5jb25zdCBQSURfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBpZFwiKTtcbmNvbnN0IEhPTERfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLmhvbGRcIik7XG4vLyBQZXJzaXN0ZWQgaWRlbnRpdHkgY29uZmlnIChWMS43KSDigJQgYGdyYXBldmluZSBhbGlhcyA8bmFtZT5gIHdyaXRlcyBpdDsgdGhlXG4vLyBkYWVtb24gc2VydmVzIGl0IHRvIHRoZSB3YXRjaCB2aWEgR0VUIC9pZGVudGl0eS5cbmNvbnN0IENPTkZJR19GSUxFID0gam9pbihEQVRBX0RJUiwgXCJjb25maWcuanNvblwiKTtcbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG4vLyDim5QgVVAgQU5EIEJBQ0sgRE9XTiwgTkVWRVIgQSBGTEFUIFNJQkxJTkcgKHBsYXlib29rIEI0KS4gVGhpcyByZWFkXG4vLyBgam9pbihTQ1JJUFRfRElSLCBcImRhZW1vbi50c1wiKWAg4oCUIGdsYW1vdXIncyBleGFjdCBzaGlwcGVkIGRlZmVjdCDigJQgd2hpY2ggd2FzXG4vLyB0cnVlIGZvciBleGFjdGx5IGFzIGxvbmcgYXMgdGhlIENMSSBhbmQgdGhlIGRhZW1vbiBzaGFyZWQgYSBmb2xkZXIuIEZyb21cbi8vIGBkaXN0L2AgdGhhdCByZXNvbHZlcyB0byBgZGlzdC9kYWVtb24udHNgLCBhIGZpbGUgdGhhdCBkb2VzIG5vdCBhbmQgbXVzdCBub3Rcbi8vIGV4aXN0LiBUaGUgc3ltcHRvbSBpcyBub3QgYSBjcmFzaDogdGhlIHNwYXduIGZhaWxzIHNpbGVudGx5ICh0aGUgZGFlbW9uJ3Ncbi8vIHN0ZGlvIGlzIGlnbm9yZWQpLCBubyBwb3J0IGZpbGUgZXZlciBhcHBlYXJzLCBhbmQgdGhlIDMgcyBwb2xsIGxvb3AgYmVsb3dcbi8vIHJlcG9ydHMgYGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzYCDigJQgd2hpY2ggaXMgQUxTTyB3aGF0IGEgbGF1bmNoZXJcbi8vIHRoYXQgZXhpdHMgYSBsaXZlIGRhZW1vbiByZXBvcnRzIChENjkpIGFuZCBBTFNPIHdoYXQgYSBkZXYtbW9kZSBkYWVtb24gZHlpbmdcbi8vIGF0IGl0cyBzdXJmYWNlIGltcG9ydCByZXBvcnRzIChzZWUgYGVuc3VyZURhZW1vbmApLiBUaHJlZSBkZWZlY3QgY2xhc3Nlcywgb25lXG4vLyBzZW50ZW5jZTsgdGhpcyBpcyB0aGUgZmlyc3Qgb2YgdGhlIHRocmVlLlxuLy8gYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByZXNvbHZlcyB0aGlzIGFyaXRobWV0aWMgdGhlIHdheSB0aGVcbi8vIHJ1bnRpbWUgd2lsbCwgZnJvbSB0aGUgRU1JVFRFRCBmaWxlJ3Mgb3duIGRpcmVjdG9yeSwgYW5kIGFzc2VydHMgdGhlIGZpbGUgaXNcbi8vIHRoZXJlLlxuY29uc3QgREFFTU9OX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJkYWVtb24udHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIFRoZSB3YXRjaCBzdXJmYWNlIGlzIGJ1aWx0IChzcmMvZ3JhcGV2aW5lL3N1cmZhY2Ug4oaSIGRpc3QvKS4gQnVuIHJlYWRzXG4vLyBidW5maWcudG9tbCAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gaW4gREVWIG1vZGUgdGhlIGRhZW1vbidzXG4vLyBjd2QgTVVTVCBiZSBzcmMvZ3JhcGV2aW5lLyAoc2VhbXMgQ29udHJhY3QgNSkg4oCUIGxhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IGFuZCB0aGUgcGFnZSBmYWlscyAobWVhc3VyZWQgb25cbi8vIGdsYW1vdXI6IEhUVFAgNTAwLCBubyBzdHlsZXNoZWV0IGxpbmspLiBJbiBSRUxFQVNFIG1vZGUgZGlzdC8gaXMgc3RhdGljIGFuZFxuLy8gcHJlLWJ1aWx0LCBubyBidW5maWcgaXMgcmVhZCwgYW5kIHNyYy9ncmFwZXZpbmUvIG5lZWQgbm90IGV4aXN0IGF0IGFsbCAoYVxuLy8gc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSDigJQgc28gdGhlIGN3ZCBzdGF5cyBhdFxuLy8gdGhlIHNraWxsIHJvb3QuIFNhbWUgc2hhcGUgYXMgZ2xhbW91cidzIGRhZW1vbkN3ZCgpLiBFeHBvcnRlZCBmb3IgdGVzdHMuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ3JhcGV2aW5lXCIpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gSFRUUCBwcm90b2NvbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFJlc3BvbnNlIHNoYXBlcyB0aGUgZGFlbW9uIGVtaXRzLiBBbnkgZW5kcG9pbnQgY2FuIGFsc28gcmV0dXJuIGFuIGVycm9yXG4vLyBib2R5IHdpdGggYSA0eHgvNXh4IHN0YXR1cywgc28gZWFjaCBjYXJyaWVzIGFuIG9wdGlvbmFsIGBlcnJvcmAuXG5cbnR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgY2hhbm5lbDogc3RyaW5nO1xuICBmcm9tOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAga2luZDogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgaW5fcmVwbHlfdG8/OiBudW1iZXI7XG4gIHRhcmdldD86IG51bWJlcjtcbiAgZGlzcG9zaXRpb24/OiBzdHJpbmc7XG4gIC8vIENoYW5uZWwtbGV2ZWwgbGlmZWN5Y2xlIGZhY3QgKGFyY2hpdmUgLyB1bmFyY2hpdmUpLiBBIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZVxuICAvLyBjYXJyeWluZyBgZXZlbnRgIGFuZCBubyBgZGlzcG9zaXRpb25gIOKAlCBzZWUgaXNEaXNwb3NpdGlvbkZyYW1lLlxuICBldmVudD86IFwiYXJjaGl2ZWRcIiB8IFwidW5hcmNoaXZlZFwiO1xufTtcblxuLy8gR0VUIC8g4oCUIGRhZW1vbiBsaXZlbmVzcy9pbmZvLlxudHlwZSBSb290SW5mbyA9IHtcbiAgb2s/OiBib29sZWFuO1xuICBwaWQ/OiBudW1iZXI7XG4gIHN0YXJ0ZWRfYXQ/OiBudW1iZXI7XG4gIGNoYW5uZWxzPzogbnVtYmVyO1xuICBkYXRhX2Rpcj86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIOKAlCBtZXNzYWdlIHJlY2VpcHQgd2l0aCBkZWxpdmVyeSBhY2NvdW50aW5nLlxudHlwZSBTZW5kUmVjZWlwdCA9IE1lc3NhZ2UgJiB7XG4gIHN1YnNjcmliZXJzPzogbnVtYmVyO1xuICByZWNpcGllbnRzPzogbnVtYmVyO1xuICBzdWJzY3JpYmVyX2FsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9hbm5vdW5jZSDigJQgY3Jvc3MtY2hhbm5lbCBicm9hZGNhc3QgcmVjZWlwdC5cbnR5cGUgQW5ub3VuY2VSZWNlaXB0ID0ge1xuICBvazogYm9vbGVhbjtcbiAgY2hhbm5lbHM6IHsgbmFtZTogc3RyaW5nOyByZWNpcGllbnRzOiBudW1iZXIgfVtdO1xuICBza2lwcGVkOiB7IG5hbWU6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVtdO1xuICB0b3RhbF9yZWNpcGllbnRzOiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscyDigJQgY2hhbm5lbCBkaXJlY3RvcnkgbGlzdGluZy5cbnR5cGUgQ2hhbm5lbFN1bW1hcnkgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IG51bWJlcjtcbiAgLy8gbnVsbCA9IHRoZSBkYWVtb24gY291bGQgbm90IGVzdGFibGlzaCBhIGNvdW50ICh1bnJlYWRhYmxlIGZpbGUpLCBORVZFUiAwLlxuICAvLyAwIG1lYW5zIFwidGhpcyBjaGFubmVsIGlzIGdlbnVpbmVseSBlbXB0eVwiIGFuZCBub3RoaW5nIGVsc2Ug4oCUIGI1LlxuICBtZXNzYWdlX2NvdW50OiBudW1iZXIgfCBudWxsO1xuICBsYXN0X2FjdGl2aXR5OiBudW1iZXI7XG4gIGxvYWRlZDogYm9vbGVhbjtcbn07XG50eXBlIENoYW5uZWxzUmVzcG9uc2UgPSB7IGNoYW5uZWxzPzogQ2hhbm5lbFN1bW1hcnlbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gQW55IGVuZHBvaW50IG1heSByZXBseSB3aXRoIGp1c3QgYW4gZXJyb3Ivb2sgZW52ZWxvcGUuXG50eXBlIFN0YXR1c1Jlc3BvbnNlID0geyBvaz86IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIGFuZCA/c2luY2U9IHJhbmdlcy5cbnR5cGUgTWVzc2FnZXNSZXNwb25zZSA9IHsgbWVzc2FnZXM/OiBNZXNzYWdlW107IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3dhaXQg4oCUIGxvbmctcG9sbCBiYXRjaC5cbnR5cGUgV2FpdFJlc3BvbnNlID0ge1xuICBtZXNzYWdlcz86IE1lc3NhZ2VbXTtcbiAgY3Vyc29yPzogbnVtYmVyO1xuICB0aW1lZF9vdXQ/OiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbiAgLy8gQSByZWZ1c2FsIG5hbWVzIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0ICg0MDQgb24gYSBtaXNzaW5nIGNoYW5uZWwpLlxuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMg4oCUIG9wZW4vZW5zdXJlIGEgY2hhbm5lbC5cbnR5cGUgT3BlblJlc3BvbnNlID0ge1xuICBuYW1lPzogc3RyaW5nO1xuICBjcmVhdGVkX2F0PzogbnVtYmVyO1xuICBtZXNzYWdlX2NvdW50PzogbnVtYmVyO1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICB1bmFyY2hpdmVkPzogYm9vbGVhbjtcbiAgY2xlYXJlZD86IGJvb2xlYW47XG4gIHNuYXBzaG90Pzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi90b3BpYyBhbmQgUFVUIC9jaGFubmVscy88bmFtZT4vdG9waWMuXG50eXBlIFRvcGljUmVzcG9uc2UgPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBpZD86IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIGhpbnQ/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9zdWJzY3JpYmVycyDigJQgc2luZ2xlLWNoYW5uZWwgcm9zdGVyLlxudHlwZSBTdWJzY3JpYmVyc1Jlc3BvbnNlID0ge1xuICBjaGFubmVsPzogc3RyaW5nO1xuICBzdWJzY3JpYmVycz86IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY291bnQ/OiBudW1iZXI7XG4gIGNvbm5lY3Rpb25zPzogbnVtYmVyO1xuICBuYW1lZD86IG51bWJlcjtcbiAgYW5vbnltb3VzPzogbnVtYmVyO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUGVyLWNoYW5uZWwgcHJlc2VuY2UgZW50cnkgZnJvbSBHRVQgL3ByZXNlbmNlLlxudHlwZSBQcmVzZW5jZUNoYW5uZWwgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgbmFtZWQ6IG51bWJlcjtcbiAgYW5vbnltb3VzOiBudW1iZXI7XG59O1xudHlwZSBQcmVzZW5jZVJlc3BvbnNlID0geyBjaGFubmVscz86IFByZXNlbmNlQ2hhbm5lbFtdOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBTU0UgZnJhbWVzIHB1c2hlZCBvbiBHRVQgL2NoYW5uZWxzLzxuYW1lPi90YWlsLiBUd28gZnJhbWUga2luZHMgYXJyaXZlIG9uXG4vLyB0aGUgc2FtZSBgZGF0YTpgIGxpbmUg4oCUIGEgYHN1YnNjcmliZWRgIGV2ZW50IGFuZCBwZXItbWVzc2FnZSBmcmFtZXMg4oCUIHNvIHRoZVxuLy8gZGVjb2RlZCBwYXlsb2FkIGlzIGEgdW5pb24uIEFsbCBmaWVsZHMgb3B0aW9uYWwgYmVjYXVzZSB0aGUgZnJhbWUgaXNcbi8vIHVudHJ1c3RlZCB3aXJlIGRhdGEgbmFycm93ZWQgYXQgdGhlIHVzZSBzaXRlLlxudHlwZSBUYWlsUGF5bG9hZCA9IHtcbiAgLy8gc3Vic2NyaWJlZC1ldmVudCBmaWVsZHNcbiAgc2luY2U/OiBudW1iZXI7XG4gIGFzPzogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0X2lkPzogbnVtYmVyO1xuICAvLyBUcnVlIHdoZW4gVEhJUyBzdWJzY3JpYmUgY3JlYXRlZCB0aGUgY2hhbm5lbCDigJQgdGhlIHNpZ25hbCB0aGF0IHNlcGFyYXRlc1xuICAvLyBcInF1aWV0IGNoYW5uZWxcIiBmcm9tIFwieW91IHRhaWxlZCBhIG5hbWUgdGhhdCBkaWQgbm90IGV4aXN0XCIuXG4gIGNyZWF0ZWQ/OiBib29sZWFuO1xuICAvLyBUcnVlIHdoZW4gdGhlIGNoYW5uZWwgaXMgYWxyZWFkeSBhcmNoaXZlZCAocmVhZC1vbmx5KSBhdCBzdWJzY3JpYmUgdGltZSDigJRcbiAgLy8gdGhlIHNpZ25hbCBmb3IgYSBMQVRFIGpvaW5lciwgd2hvIHdvdWxkIG90aGVyd2lzZSBsZWFybiBpdCBmcm9tIGEgcmVqZWN0ZWRcbiAgLy8gc2VuZC4gVGhlIGxpZmVjeWNsZSBmcmFtZSBvbmx5IHJlYWNoZXMgYW4gYWdlbnQgdGhhdCB3YXMgY29ubmVjdGVkIGF0IHRoZVxuICAvLyBtb21lbnQsIG9yIHRoYXQgcHVsbHMgaGlzdG9yeS5cbiAgYXJjaGl2ZWQ/OiBib29sZWFuO1xuICAvLyBtZXNzYWdlIGZpZWxkc1xuICBpZD86IG51bWJlcjtcbiAgZnJvbT86IHN0cmluZztcbiAgdGV4dD86IHN0cmluZztcbiAgdHM/OiBudW1iZXI7XG4gIGtpbmQ/OiBcIm1lc3NhZ2VcIiB8IFwidG9waWNcIiB8IFwiYW5ub3VuY2VtZW50XCIgfCBcInN0YXR1c1wiO1xuICAvLyBzaGFyZWRcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuLy8gT3VyIHBsdWdpbiB2ZXJzaW9uIChmcm9tIHBsdWdpbi5qc29uKS4gVXNlZCB0byBkZXRlY3QgY2FjaGUtcGlubmluZ1xuLy8gbWlzbWF0Y2hlcyB3aGVuIHdlIHRhbGsgdG8gYSBkYWVtb24gc3Bhd25lZCBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZFxuLy8gcGF0aC4gQmVzdC1lZmZvcnQ7IG51bGwgaWYgcmVhZCBmYWlscy5cbmZ1bmN0aW9uIHJlYWRQbHVnaW5WZXJzaW9uKCk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBsdWdpbkpzb25QYXRoID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIik7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBsdWdpbkpzb25QYXRoLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykudmVyc2lvbiA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuY29uc3QgUExVR0lOX1ZFUlNJT04gPSByZWFkUGx1Z2luVmVyc2lvbigpO1xuXG4vLyBPbmUtc2hvdCB2ZXJzaW9uLW1pc21hdGNoIGNoZWNrLiBUaGUgZGFlbW9uIG1heSBiZSBmcm9tIGEgZGlmZmVyZW50XG4vLyBjYWNoZWQgcGx1Z2luIHBhdGggdGhhbiB0aGlzIENMSSAoZXhpc3RpbmcgdGFpbCBwcm9jZXNzZXMnIGF1dG8tcmVjb25uZWN0XG4vLyBjYW4gcmFjZSBhIGBzdG9wYCBhbmQgcmVzcGF3biB0aGUgb2xkIGRhZW1vbikuIFdhcm4gb25jZSBwZXIgaW52b2NhdGlvblxuLy8gc28gdGhlIHVzZXIgaGFzIGEgc2lnbmFsIGluc3RlYWQgb2Ygc2lsZW50bHkgZGVncmFkZWQgYmVoYXZpb3IuXG5sZXQgX3ZlcnNpb25DaGVja0RvbmUgPSBmYWxzZTtcbmFzeW5jIGZ1bmN0aW9uIG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKHBvcnQ6IG51bWJlcikge1xuICBpZiAoX3ZlcnNpb25DaGVja0RvbmUpIHJldHVybjtcbiAgX3ZlcnNpb25DaGVja0RvbmUgPSB0cnVlO1xuICBpZiAoIVBMVUdJTl9WRVJTSU9OKSByZXR1cm47IC8vIGNhbid0IGNvbXBhcmUgaWYgd2UgZG9uJ3Qga25vdyBvdXIgb3duIHZlcnNpb25cbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmICghcmVzLm9rKSByZXR1cm47XG4gICAgY29uc3QgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgICBjb25zdCBkYWVtb25WZXJzaW9uID0gZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmIChkYWVtb25WZXJzaW9uID09PSBudWxsKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgZ3JhcGV2aW5lOiBkYWVtb24gaXMgb2xkZXIgdGhhbiB0aGlzIENMSSAobm8gdmVyc2lvbiByZXBvcnRlZCkuIGAgK1xuICAgICAgICAgIGBDTEkgaXMgdiR7UExVR0lOX1ZFUlNJT059LiBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBgICtcbiAgICAgICAgICBgUmVzdGFydCB0aGUgZGFlbW9uIChkcm9wIHRhaWxzLCB0aGVuIFxcYHN0b3BcXGAsIHRoZW4gYW55IHZlcmIpIHRvIHVwZ3JhZGUuXFxuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChkYWVtb25WZXJzaW9uICE9PSBQTFVHSU5fVkVSU0lPTikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIHZlcnNpb24gKHYke2RhZW1vblZlcnNpb259KSBkaWZmZXJzIGZyb20gQ0xJIHZlcnNpb24gKHYke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICAgIGBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBSZXN0YXJ0IHRoZSBkYWVtb24gdG8gYWxpZ24uXFxuYCxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydFxuICB9XG59XG4vLyBHUkFQRVZJTkVfRlJPTSBzZXRzIHRoZSBkZWZhdWx0IC0tZnJvbSAvIC0tYXMgYWxpYXMgc28gYWdlbnRzIGRvbid0IGhhdmVcbi8vIHRvIHJlcGVhdCB0aGVpciBpZGVudGl0eSBvbiBldmVyeSB2ZXJiLiBQZXItdmVyYiBmbGFncyBzdGlsbCBvdmVycmlkZS5cbmNvbnN0IERFRkFVTFRfQUxJQVMgPSBwcm9jZXNzLmVudi5HUkFQRVZJTkVfRlJPTSA/PyB1bmRlZmluZWQ7XG5cbi8vIElkZW50aXR5IGZsYWdzIGFyZSBpbnRlcmNoYW5nZWFibGUgYWNyb3NzIHZlcmJzLiBgc2VuZGAgaGlzdG9yaWNhbGx5IHRvb2tcbi8vIGAtLWZyb21gIHdoaWxlIGB0YWlsYC9gd2FpdGAgdG9vayBgLS1hc2Ag4oCUIHNhbWUgY29uY2VwdCAod2hvIGFtIEkpLCBhbmQgdGhlXG4vLyBhc3ltbWV0cnkgdHJpcHMgeW91IG1pZC1mbG93LiBBY2NlcHQgZWl0aGVyIGV2ZXJ5d2hlcmUgaWRlbnRpdHkgaXMgbWVhbnQsXG4vLyBmYWxsaW5nIGJhY2sgdG8gR1JBUEVWSU5FX0ZST00uIChncmVwJ3MgYC0tZnJvbWAgaXMgYSBkaWZmZXJlbnQgdGhpbmcg4oCUIGFuXG4vLyBhdXRob3IgKmZpbHRlciosIG5vdCBpZGVudGl0eSDigJQgc28gaXQgZG9lc24ndCB1c2UgdGhpcy4pXG5mdW5jdGlvbiByZXNvbHZlQWxpYXMoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIChmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gKGZsYWdzLmFzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gREVGQVVMVF9BTElBUztcbn1cbi8vIFRydW5jYXRpb24taGludCB0aHJlc2hvbGQuIE1lc3NhZ2VzIGxvbmdlciB0aGFuIHRoaXMgZ2V0IGEgYHRydW5jYXRpb25faGludGBcbi8vIGZpZWxkIG9uIHRoZSB0YWlsIEpTT04gc28gY29uc3VtZXJzIChlLmcuIE1vbml0b3IpIGtub3cgdGhlIG5vdGlmaWNhdGlvblxuLy8gcHJldmlldyBpcyBpbmNvbXBsZXRlIGFuZCBzaG91bGQgYHJlYWRgIHRoZSBmdWxsIGJvZHkuIEluIGFnZW50LXRvLWFnZW50XG4vLyB0cmFmZmljLCBsb25nIG1lc3NhZ2VzIGFyZSB0aGUgTk9STSAodGhlIFYxLjYgcm91bmR0YWJsZSBzYXcgbW9zdCBzdWJzdGFudGl2ZVxuLy8gbWVzc2FnZXMgZXhjZWVkIDgwMCksIHNvIGFuIDgwMCBkZWZhdWx0IGZpcmVkIG9uIG5lYXJseSBldmVyeXRoaW5nIGFuZCB0aGVcbi8vIHJlY292ZXJ5IHBhdGggYmVjYW1lIHRoZSBtYWluIHBhdGguIERlZmF1bHQgcmFpc2VkIHRvIDIwMDAgc28gdGhlIGhpbnQgbWFya3Ncbi8vIHRoZSBnZW51aW5lbHktbG9uZyBvdXRsaWVycy4gT3ZlcnJpZGFibGUgdmlhIGVudiB2YXIgZm9yIHR1bmluZy5cbmNvbnN0IFRSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPSBwYXJzZUludChcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPz8gXCIyMDAwXCIsXG4gIDEwLFxuKTtcblxuLy8gT3B0aW9uYWwgaW5saW5lLWJvZHkgY2FwIGZvciBgdGFpbGAgKG9wdC1pbiB2aWEgLS1tYXggPG4+IG9yIEdSQVBFVklORV9UQUlMX01BWCkuXG4vLyBXaGVuIHNldCwgYSBib2R5IGxvbmdlciB0aGFuIHRoZSBjYXAgaXMgdHJ1bmNhdGVkIHRvIGBuYCBjaGFycyBpbiB0aGUgdGFpbFxuLy8gZnJhbWUgKHBsdXMgdGhlIHJlYWQtcG9pbnRlciBoaW50KSwgc28gYSBwdXNoIGNvbnN1bWVyIGNhbiBoYW5kIGl0c1xuLy8gbm90aWZpY2F0aW9uIHN1cmZhY2UgYSBkZWxpYmVyYXRlbHktc2l6ZWQgbGluZS4gVGhlIEZVTEwgbWVzc2FnZSBpcyBhbHdheXNcbi8vIHJldHJpZXZhYmxlIHZpYSBgcmVhZCA8Y2hhbm5lbD4gPGlkPmAuIFVuZGVmaW5lZCA9IG5vIGNhcCAoZnVsbCB0ZXh0IGlubGluZSDigJRcbi8vIHRvZGF5J3MgZGVmYXVsdCkuIE5vdGU6IHRoZSBoYXJkIGNsaXAgYSBjb25zdW1lciB1bHRpbWF0ZWx5IHNlZXMgaXMgc3RpbGwgdGhlXG4vLyBNb25pdG9yL25vdGlmaWNhdGlvbiBsYXllcidzOyAtLW1heCBvbmx5IGJvdW5kcyB0aGUgbGluZSBncmFwZXZpbmUgZW1pdHMuXG4vLyBSZWplY3RzIG5lZ2F0aXZlIC8gbm9uLW51bWVyaWMuXG5mdW5jdGlvbiByZXNvbHZlVGFpbE1heChmbGFnOiB1bmtub3duKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWcgPT09IFwic3RyaW5nXCIgPyBmbGFnIDogcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RBSUxfTUFYO1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3LCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+PSAwID8gbiA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUg4oCUIGBzcmMva2l0L3dpcmUvZXJyb3JzLnRzYCdzIGBkaWVgLCB1bmRlciB0aGlzXG4gKiBzcGVsbCdzIG93biBuYW1lIHNvIDQ2IGNhbGwgc2l0ZXMgZGlkIG5vdCBlYWNoIGhhdmUgdG8gYmUgcmUtc3BlbGxlZC5cbiAqXG4gKiDim5QgKipJVCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIEEgQ0FMTEVSLVZJU0lCTEUgQ0hBTkdFKipcbiAqIChQaGFzZSA2IGNoYXB0ZXIgMjsgdGhlIGRlbHRhIGlzIGRyaXZlbiBhbmQgcmVjb3JkZWQgaW4gdGhlIGpvdXJuYWwpLiBUaGlzXG4gKiBmdW5jdGlvbiB3YXMgYHByb2Nlc3Muc3RkZXJyLndyaXRlKFxcYGdyYXBldmluZTogJHttc2d9XFxuXFxgKTsgcHJvY2Vzcy5leGl0KGNvZGUpYFxuICog4oCUIFBST1NFIGF0IGV4aXQgMiBmb3IgZXZlcnkgZmFpbHVyZSBncmFwZXZpbmUgY291bGQgcHJvZHVjZSwgd2l0aCB0d28gc2l0ZXNcbiAqIHBhc3NpbmcgMS4gQWZ0ZXIgdGhlIGFkb3B0aW9uIGl0IGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciBhbmQgdGhlXG4gKiBhY2MgdGF4b25vbXkncyBjb2RlczogdXNhZ2UgMiwgaW50ZXJuYWwgMSwgbm90X2ZvdW5kIDUsIGNvbmZsaWN0IDYuIEFuIGFnZW50XG4gKiByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlOyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uIGFuZCByZXdvcmRpbmdcbiAqIGl0IG11c3QgbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRpZCB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVkIHByb3NlLlxuICpcbiAqIOKblCAqKkFORCBUSEUgRU5VTUVSQVRJT05TIE1PVkVEIEZST00gUFJPU0UgSU5UTyBgY2hvaWNlc2AuKiogZ3JhcGV2aW5lJ3NcbiAqIHJlamVjdGlvbnMgd2VyZSBzaGFwZWQgZm9yIGFjYydzIGZsYWctc2V0IGV4dHJhY3RvcnMg4oCUIGByZWNvZ25pemVkIGZsYWdzOiAtLWFcbiAqIC0tYmAsIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IGEgcXVhbGlmaWVyIGJldHdlZW4gdGhlIG5vdW4gYW5kIHRoZSBjb2xvblxuICogXCJyZWFkcyBhcyBwcm9zZSwgbm90IGEgc2V0XCIuIFdyYXBwZWQgaW4gSlNPTiB0aGF0IG1hcmtlciBiZWNvbWVzIGEgc3Vic3RyaW5nIG9mXG4gKiBhbiBlc2NhcGVkIHN0cmluZywgc28gaXQgZG9lcyBub3Qgc3RheSBpbiBwcm9zZTogZXZlcnkgZW51bWVyYXRpb24gaXMgbm93IGFcbiAqIGBjaG9pY2VzYCBhcnJheSwgd2hpY2ggaXMgd2hhdCBnbGFtb3VyIChDT05GT1JNQU5UIEwwKSBwdWJsaXNoZXMgYW5kIHdoYXQgdGhlXG4gKiBlbnZlbG9wZSBoYXMgYSBmaWVsZCBmb3IuIFRoZSBydW5uYWJsZSByZWNvdmVyeSDigJQgYHRyeTogYnVuIOKApi9jbGkudHMgb3BlbiB4YCDigJRcbiAqIG1vdmVkIGludG8gYGhpbnRgIGZvciB0aGUgc2FtZSByZWFzb24sIGFuZCBhIGNhbGxlciBub3cgcmVhZHMgYSBmaWVsZCBpbnN0ZWFkXG4gKiBvZiBzcGxpdHRpbmcgYSBzZW50ZW5jZS5cbiAqXG4gKiDimqAgYGRpZWAgaXMgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBzd2FsbG93cywgYW5kIHRoYXQgaXNcbiAqIG5vdyBhIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiBBdWRpdGVkIGJ5IGNhbGwgZ3JhcGggYXQgdGhlXG4gKiBhZG9wdGlvbiAocGxheWJvb2sgQjkpOyB0aGUgY291bnQgaXMgaW4gdGhlIGpvdXJuYWwuXG4gKi9cbmZ1bmN0aW9uIGRpZShtc2c6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgcmFpc2UobXNnLCBraW5kLCBleHRyYSk7XG59XG5cbi8qKlxuICogVGhlIHRheG9ub215IGBraW5kYCBmb3IgYW4gSFRUUCBzdGF0dXMgdGhlIGRhZW1vbiBhbnN3ZXJlZCB3aXRoLlxuICpcbiAqIOKblCBPTkUgTUFQUElORywgTk9UIEEgSlVER0VNRU5UIFBFUiBTSVRFLiBUd2VudHkgb2YgZ3JhcGV2aW5lJ3MgcmFpc2Ugc2l0ZXNcbiAqIGFyZSBcInRoZSBkYWVtb24gc2FpZCBub1wiOyBiZWZvcmUgdGhlIGFkb3B0aW9uIGV2ZXJ5IG9uZSBvZiB0aGVtIGNvbGxhcHNlZCB0b1xuICogZXhpdCAyLCBzbyBhIG1pc3NpbmcgY2hhbm5lbCwgYSBsaXZlLXNlc3Npb24gcmVmdXNhbCBhbmQgYSBicm9rZW4gZGFlbW9uIHdlcmVcbiAqIG9uZSBudW1iZXIgdG8gYW4gYWdlbnQuIFRoZSBkYWVtb24gYWxyZWFkeSBkaXN0aW5ndWlzaGVzIHRoZW0gYnkgc3RhdHVzIOKAlFxuICogNDA0IGZvciBhIGNoYW5uZWwgdGhhdCBkb2VzIG5vdCBleGlzdCwgNDA5IGZvciBhcmNoaXZlZCAvIGxpdmUgLyBhbHJlYWR5LW9wZW5cbiAqIOKAlCBzbyB0aGUgbWFwcGluZyBpcyBhIHJlLXJlYWRpbmcgb2Ygd2hhdCB3YXMgb24gdGhlIHdpcmUsIG5vdCBhIG5ldyBvcGluaW9uLlxuICovXG5mdW5jdGlvbiBraW5kRm9yU3RhdHVzKHN0YXR1czogbnVtYmVyKTogRXJyS2luZCB7XG4gIGlmIChzdGF0dXMgPT09IDQwNCkgcmV0dXJuIFwibm90X2ZvdW5kXCI7XG4gIGlmIChzdGF0dXMgPT09IDQwOSkgcmV0dXJuIFwiY29uZmxpY3RcIjtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgJiYgc3RhdHVzIDwgNTAwKSByZXR1cm4gXCJ1c2FnZVwiO1xuICByZXR1cm4gXCJpbnRlcm5hbFwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkRGFlbW9uUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgaWYgKCFleGlzdHNTeW5jKFBPUlRfRklMRSkpIHJldHVybiBudWxsO1xuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgY29uc3QgcG9ydCA9IHBhcnNlSW50KHJhdywgMTApO1xuICBpZiAoIXBvcnQpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDUwMCksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykge1xuICAgICAgLy8gRmlyZS1hbmQtZm9yZ2V0IG1pc21hdGNoIGNoZWNrICh3b24ndCBibG9jayB0aGUgdmVyYikuXG4gICAgICBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0KTtcbiAgICAgIHJldHVybiBwb3J0O1xuICAgIH1cbiAgfSBjYXRjaCB7fVxuICAvLyBTdGFsZSDigJQgY2xlYW4gdXAuXG4gIHRyeSB7XG4gICAgdW5saW5rU3luYyhQT1JUX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgdW5saW5rU3luYyhQSURfRklMRSk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogV2FpdCwgdXAgdG8gNSBzLCB1bnRpbCBubyBkYWVtb24gYW5zd2VycyBvbiB0aGUgcG9ydCBmaWxlOiBhIGRhZW1vbiB0b2xkIHRvXG4gKiBzdG9wIHVubGlua3MgaXRzIHBvcnQgYW5kIHBpZCBmaWxlcyBhcyBpdCBzaHV0cyBkb3duLiBGb3Igc3RvcCwgcmVzdGFydCBhbmRcbiAqIHJvbGwgYWxpa2UuIEEgZGFlbW9uIHN0aWxsIGFuc3dlcmluZyBhZnRlciB0aGF0IGlzIGEgZmFpbHVyZSwgbm90IGEgc3RvcDpcbiAqIHRoZSB2ZXJiIHJlZnVzZXMsIG5hbWVzIHRoZSBkYWVtb24ncyBwaWQsIGFuZCBwb2ludHMgYXQgYGRvY3RvcmAsIHdoaWNoXG4gKiByZXBvcnRzIGl0LiAoYHJlYXBgIG5ldmVyIGtpbGxzIHRoZSBhdXRob3JpdGF0aXZlIGRhZW1vbiwgc28gaXQgaXMgbm90IHRoZVxuICogYW5zd2VyIGhlcmUuKVxuICovXG5hc3luYyBmdW5jdGlvbiB1bnRpbERhZW1vbkdvbmUodmVyYjogXCJzdG9wXCIgfCBcInJlc3RhcnRcIiB8IFwicm9sbFwiKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIGlmICgoYXdhaXQgcmVhZERhZW1vblBvcnQoKSkgPT09IG51bGwpIHJldHVybjtcbiAgfVxuICBsZXQgcGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBwaWQgPSBOdW1iZXIucGFyc2VJbnQocmVhZEZpbGVTeW5jKFBJRF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKSwgMTApIHx8IG51bGw7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgcHJlZml4ID0gaW52b2NhdGlvblByZWZpeCgpO1xuICBkaWUoXG4gICAgYCR7dmVyYn06IHRoZSBkYWVtb24ke3BpZCA/IGAgKHBpZCAke3BpZH0pYCA6IFwiXCJ9IHdhcyB0b2xkIHRvIHN0b3AgYW5kIHN0aWxsIGFuc3dlcnMgYWZ0ZXIgNSBzLCBgICtcbiAgICAgIGBzbyAke3ZlcmIgPT09IFwic3RvcFwiID8gXCJpdCB3YXMgbm90IHN0b3BwZWRcIiA6IFwibm8gbmV3IGRhZW1vbiB3YXMgc3RhcnRlZFwifS4gYCArXG4gICAgICBgU3RvcCBpdCBieSBpdHMgcGlkJHtwaWQgPyBgIChraWxsICR7cGlkfSlgIDogXCJcIn0sIHRoZW4gcnVuICR7dmVyYn0gYWdhaW4uYCxcbiAgICBcImludGVybmFsXCIsXG4gICAge1xuICAgICAgdG9rZW46IFwiZGFlbW9uX3N0aWxsX3J1bm5pbmdcIixcbiAgICAgIGhpbnQ6IHByZWZpeCA/IGB0cnk6ICR7cHJlZml4fSBkb2N0b3JgIDogXCJ0cnkgdGhlIGBkb2N0b3JgIHZlcmJcIixcbiAgICB9LFxuICApO1xufVxuXG5mdW5jdGlvbiBob2xkQWN0aXZlKCk6IG51bWJlciB8IG51bGwge1xuICB0cnkge1xuICAgIGlmICghZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCB1bnRpbCA9IHBhcnNlSW50KHJlYWRGaWxlU3luYyhIT0xEX0ZJTEUsIFwidXRmLThcIikudHJpbSgpLCAxMCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZSh1bnRpbCkgJiYgdW50aWwgPiBEYXRlLm5vdygpKSByZXR1cm4gdW50aWw7XG4gICAgdHJ5IHtcbiAgICAgIHVubGlua1N5bmMoSE9MRF9GSUxFKTtcbiAgICB9IGNhdGNoIHt9IC8vIGV4cGlyZWQg4oaSIGNsZWFuXG4gICAgcmV0dXJuIG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5leHBvcnQgZnVuY3Rpb24gcmVsZWFzZUhvbGQoKSB7XG4gIHRyeSB7XG4gICAgaWYgKGV4aXN0c1N5bmMoSE9MRF9GSUxFKSkgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZURhZW1vbigpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgaWYgKGhvbGRBY3RpdmUoKSlcbiAgICBkaWUoXG4gICAgICBcImRhZW1vbiBpcyBoZWxkIChyZXNwYXduIHN1cHByZXNzZWQpIOKAlCB3YWl0IGZvciB0aGUgaG9sZCB0byBjbGVhciBvciBydW4gYGdyYXBldmluZSByb2xsYFwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIC8vIENoZWNrIHRoZSBjd2QgRVhJU1RTIGJlZm9yZSBzcGF3bmluZzogdGhlIGRhZW1vbidzIHN0ZGlvIGlzIGlnbm9yZWQsIHNvIGFcbiAgLy8gZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydCB3b3VsZCBvdGhlcndpc2Ugc3VyZmFjZSBvbmx5IGFzXG4gIC8vIFwiZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiIOKAlCBhbmQgbm9kZSByZXBvcnRzIGEgbWlzc2luZyBjd2QgYXMgRU5PRU5UIG9uXG4gIC8vIHRoZSBleGVjdXRhYmxlLCB3aGljaCByZWFkcyBhcyBcImJ1biBpcyBtaXNzaW5nXCIuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBncmFwZXZpbmUgY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH0uIGAgK1xuICAgICAgICBcIk5vIGRpc3QvaW5kZXguaHRtbCB3YXMgZm91bmQgKG9yIFNQRUxMQk9PS19TVVJGQUNFX01PREU9ZGV2IGlzIHNldCksIHNvIHRoZSBkYWVtb24gXCIgK1xuICAgICAgICBcIm11c3QgcnVuIGZyb20gc3JjL2dyYXBldmluZS8gdG8gYnVuZGxlIHRoZSB3YXRjaCBzdXJmYWNlLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgXCIgK1xuICAgICAgICBcImRvZXMgbm90IGhhdmUuIEVpdGhlciB0aGUgc2hpcHBlZCBkaXN0LyBpcyBtaXNzaW5nIChyZWluc3RhbGwgdGhlIHNwZWxsKSBvciB5b3UgYXJlIGluIFwiICtcbiAgICAgICAgXCJhIGNoZWNrb3V0IHdpdGhvdXQgc3JjL2dyYXBldmluZS8uXCIsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgKTtcbiAgfVxuICAvLyBTcGF3biBkZXRhY2hlZCBzbyB0aGUgZGFlbW9uIHN1cnZpdmVzIHRoaXMgQ0xJIHByb2Nlc3MgZXhpdC5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIFtEQUVNT05fU0NSSVBUXSwge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2QsXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG4gIC8vIFdhaXQgdXAgdG8gM3MgZm9yIHRoZSBwb3J0IGZpbGUgdG8gYXBwZWFyIGFuZCByZXNwb25kLlxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyAzMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgICBpZiAocG9ydCkgcmV0dXJuIHBvcnQ7XG4gIH1cbiAgZGllKFwiZGFlbW9uIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gM3NcIiwgXCJpbnRlcm5hbFwiLCB7XG4gICAgaGludDpcbiAgICAgIFwidGhyZWUgdW5yZWxhdGVkIGNhdXNlcyByZXBvcnQgdGhpcyBvbmUgc2VudGVuY2U6IHRoZSBkYWVtb24ncyBsYXVuY2hlciBzaGFwZSwgXCIgK1xuICAgICAgXCJhIHdyb25nIHNwYXduIHBhdGgsIGFuZCBhIGRldi1tb2RlIGRhZW1vbiBkeWluZyBhdCBpdHMgc3VyZmFjZSBpbXBvcnQuIFwiICtcbiAgICAgIFwiUnVuIHRoZSBkYWVtb24gbGF1bmNoZXIgYWxvbmUgdG8gdGVsbCB0aGVtIGFwYXJ0IOKAlCBpdCBpcyB0aGUgbGF1bmNoZXIgc2hhcGUgXCIgK1xuICAgICAgXCJpZmYgaXQgcHJpbnRzIGBsaXN0ZW5pbmcgb24g4oCmYCBhbmQgcmV0dXJucyBhdCBleGl0IDAuIEFuIGVtcHR5IFwiICtcbiAgICAgIFwiR1JBUEVWSU5FX0hPTUUgKG5vIGBjaGFubmVscy9gKSBtZWFucyB0aGUgZGFlbW9uIG5ldmVyIGJvdW5kIGF0IGFsbC5cIixcbiAgfSk7XG59XG5cbi8vIEdlbmVyaWMgb3ZlciB0aGUgZXhwZWN0ZWQgc3VjY2VzcyBib2R5LiBgZGF0YWAgbWF5IGJlIG51bGwgaWYgdGhlIHJlc3BvbnNlXG4vLyBoYWQgbm8gSlNPTiBib2R5LCBzbyBjYWxsZXJzIHNlZSBgVCB8IG51bGxgLlxuYXN5bmMgZnVuY3Rpb24gYXBpPFQgPSB1bmtub3duPihcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogVCB8IG51bGwgfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IFQgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFQ7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKSB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuXG4vLyBIb3cgVEhJUyBDTEkgd2FzIGludm9rZWQsIGFzIGEgcnVubmFibGUgcHJlZml4LiBgcHJvY2Vzcy5hcmd2WzFdYCBpcyB0aGVcbi8vIGFic29sdXRlIHBhdGggb2YgY2xpLnRzIHVuZGVyIGBidW4g4oCmL2NsaS50cyA8dmVyYj5gLCB3aGljaCBpcyBTS0lMTC5tZCdzXG4vLyBjYW5vbmljYWwgaW52b2NhdGlvbiDigJQgc28gdGhlIGxpbmUgd2UgcHJpbnQgY2FuIGFjdHVhbGx5IGJlIHBhc3RlZC4gRmFsbHNcbi8vIGJhY2sgdG8gdGhlIGJhcmUgdmVyYiBpZiBhcmd2IGlzIG5vdCBzaGFwZWQgYXMgZXhwZWN0ZWQsIHdoaWNoIGlzIGEgdmVyYlxuLy8gcmVmZXJlbmNlIHJhdGhlciB0aGFuIGEgY29tbWFuZCB0aGF0IGxpZXMgYWJvdXQgYmVpbmcgb25lLlxuZnVuY3Rpb24gaW52b2NhdGlvblByZWZpeCgpOiBzdHJpbmcge1xuICBjb25zdCBlbnRyeSA9IHByb2Nlc3MuYXJndlsxXTtcbiAgcmV0dXJuIGVudHJ5ID8gYGJ1biAke2VudHJ5fWAgOiBcIlwiO1xufVxuXG4vLyBBIGRhZW1vbiByZWZ1c2FsIGNhcnJpZXMgYGhpbnRgIOKAlCB0aGUgYWN0IHRoYXQgcmVjb3ZlcnMgZnJvbSBpdCAoYSA0MDQgb24gYVxuLy8gcmVhZCBuYW1lcyB0aGUgYG9wZW5gIHRoYXQgd291bGQgY3JlYXRlIHRoZSBjaGFubmVsKS5cbi8vXG4vLyDimqAgYGhpbnRgIGlzIGEgVkVSQiBJTlZPQ0FUSU9OLCBub3QgYSBzaGVsbCBjb21tYW5kOiB0aGUgZGFlbW9uIGNhbm5vdCBrbm93XG4vLyBob3cgaXRzIGNsaWVudCB3YXMgaW52b2tlZCwgc28gaXQgbmFtZXMgdGhlIGFjdCBhbmQgd2UgcmVuZGVyIGl0LiBJdCB1c2VkIHRvXG4vLyBhcnJpdmUgYXMgYGdyYXBldmluZSBvcGVuIDxuYW1lPmAgYW5kIGJlIHByaW50ZWQgdmVyYmF0aW0gYWZ0ZXIgYHRyeTpgLCB3aGljaFxuLy8gcmVhZHMgYXMgc29tZXRoaW5nIHRvIHBhc3RlIOKAlCBhbmQgcGFzdGluZyBpdCBnZXRzIGBjb21tYW5kIG5vdCBmb3VuZGAsXG4vLyBiZWNhdXNlIG5vdGhpbmcgaW5zdGFsbHMgYSBgZ3JhcGV2aW5lYCBiaW5hcnkuIFJ1bGluZyAyIGFza2VkIHRoYXQgYSByZWZ1c2FsXG4vLyBuYW1lIHRoZSBuZXh0IGFjdDsgYSByZWNvdmVyeSB0aGF0IGZhaWxzIHdoZW4geW91IHJ1biBpdCBkb2VzIG5vdC5cbmZ1bmN0aW9uIGRpZUFwaShkYXRhOiB7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0gfCBudWxsLCBzdGF0dXM6IG51bWJlcik6IG5ldmVyIHtcbiAgY29uc3QgbXNnID0gZGF0YT8uZXJyb3IgPz8gYEhUVFAgJHtzdGF0dXN9YDtcbiAgY29uc3QgcHJlZml4ID0gaW52b2NhdGlvblByZWZpeCgpO1xuICAvLyDim5QgVEhFIFJFQ09WRVJZIElTIEEgRklFTEQgTk9XLCBOT1QgQSBTRU5URU5DRS4gSXQgdXNlZCB0byBiZSBhcHBlbmRlZCB0byB0aGVcbiAgLy8gbWVzc2FnZSBhcyBg4oCUIHRyeTogPGNtZD5gLCB3aGljaCBhIGNhbGxlciBoYWQgdG8gcmVjb3ZlciBieSBzcGxpdHRpbmcgb25cbiAgLy8gXCJ0cnk6IFwiIChvbmUgb2YgZ3JhcGV2aW5lJ3Mgb3duIGNlbGxzIGRpZCBleGFjdGx5IHRoYXQsIGFuZCByYW4gd2hhdCBpdFxuICAvLyBmb3VuZCkuIGBoaW50YCBpcyB3aGVyZSB0aGUgZW52ZWxvcGUgY2FycmllcyBpdCwgc28gdGhlIHNhbWUgY2VsbCBub3cgcmVhZHNcbiAgLy8gYSBmaWVsZCBhbmQgcnVucyBpdCDigJQgdGhlIHByb3BlcnR5IGlzIHVuY2hhbmdlZCBhbmQgdGhlIHBhcnNlIGlzIG5vdCBhIHBhcnNlLlxuICBjb25zdCBoaW50ID0gZGF0YT8uaGludFxuICAgID8gcHJlZml4XG4gICAgICA/IGB0cnk6ICR7cHJlZml4fSAke2RhdGEuaGludH1gXG4gICAgICA6IGB0cnkgdGhlIFxcYCR7ZGF0YS5oaW50fVxcYCB2ZXJiYFxuICAgIDogdW5kZWZpbmVkO1xuICBkaWUobXNnLCBraW5kRm9yU3RhdHVzKHN0YXR1cyksIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC8vIFRoZSB1cHN0cmVhbSdzIGJvZHkgVkVSQkFUSU0sIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gd2hhdCB0aGUgZGFlbW9uXG4gICAgLy8gYWN0dWFsbHkgc2FpZCByYXRoZXIgdGhhbiBvbiB0aGlzIENMSSdzIHByb3NlIGFib3V0IGl0LlxuICAgIC4uLihkYXRhICE9PSBudWxsID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8vIEV4aXN0ZW5jZSBwcm9iZSBmb3IgdGhlIHJlYWQgdmVyYnMgdGhhdCBhbnN3ZXIgZnJvbSB0aGUgTE9HIEZJTEUgcmF0aGVyIHRoYW5cbi8vIGZyb20gYSByb3V0ZSAoYHRyaWFnZWAsIGBwdWxsIC0tc3RhdHVzYCkuIFRob3NlIGNhbm5vdCA0MDQgb24gdGhlaXIgb3duOiBhXG4vLyBtaXNzaW5nIGxvZyBpcyBhbiBlbXB0eSBhcnJheSwgd2hpY2ggaXMgdGhlIHNhbWUgc2lsZW50IGxpZSB0aGUgZGFlbW9uIGd1YXJkXG4vLyBleGlzdHMgdG8ga2lsbC4gR0VUIC90b3BpYyBpcyB0aGUgY2hlYXBlc3QgZ3VhcmRlZCByb3V0ZSwgc28gaXQgaXMgdGhlIHByb2JlLlxuYXN5bmMgZnVuY3Rpb24gcmVxdWlyZUNoYW5uZWwocG9ydDogbnVtYmVyLCBuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgb3B0czogeyB0b3BpYz86IHN0cmluZzsgZnJvbT86IHN0cmluZzsgZnJlc2g/OiBib29sZWFuIH0sXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIG9wZW4gPG5hbWU+IFstLXRvcGljIDx0ZXh0Pl0gWy0tZnJlc2hdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+ID0geyBuYW1lLCBleHBsaWNpdDogdHJ1ZSB9O1xuICBpZiAob3B0cy50b3BpYyAhPT0gdW5kZWZpbmVkKSBib2R5LnRvcGljID0gb3B0cy50b3BpYztcbiAgaWYgKG9wdHMuZnJvbSAhPT0gdW5kZWZpbmVkKSBib2R5LmZyb20gPSBvcHRzLmZyb207XG4gIGlmIChvcHRzLmZyZXNoKSBib2R5LmZyZXNoID0gdHJ1ZTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxPcGVuUmVzcG9uc2U+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVG9waWMoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgdGV4dDogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBmcm9tOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRvcGljIDxjaGFubmVsPiBbPHRleHQ+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBpZiAodGV4dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gYHRvcGljIDxuYW1lPmAgd2l0aCBubyB0ZXh0IGlzIGEgUkVBRCDigJQgaXQgYXNrcyB3aGF0IHRoZSB0b3BpYyBpcywgYW5kIGFcbiAgICAvLyBtaXNzaW5nIGNoYW5uZWwgYW5zd2VycyB0aGF0IHF1ZXN0aW9uIGJ5IGJlaW5nIG1pc3NpbmcuIE5vIGVuc3VyZTogdGhlXG4gICAgLy8gZW5zdXJlIHdhcyB3aGF0IHJlc3VycmVjdGVkIGEgY2xvc2VkIGNoYW5uZWwgZnJvbSBhIHJlYWQgdmVyYi5cbiAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2ApO1xuICAgIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBgdG9waWMgPG5hbWU+IDx0ZXh0PmAgaXMgYSBXUklURSwgc28gaXQgbWF5IGNyZWF0ZSDigJQgYnV0IGl0IG11c3Qgbm90IHdyaXRlXG4gIC8vIHRvIGFuIEFSQ0hJVkVEIGNoYW5uZWwuIFRoZSBQVVQgZW5mb3JjZXMgdGhhdCBpdHNlbGYgbm93OyB0aGlzIGVuc3VyZSBzdGF5c1xuICAvLyBiZWNhdXNlIERJU0NBUkRJTkcgSVRTIFNUQVRVUyBpcyBwcmVjaXNlbHkgdGhlIGJ1ZyBiZWluZyBmaXhlZCBoZXJlLiBCZWZvcmVcbiAgLy8gdG9kYXkgdGhlIDQwOSB0aGF0IGFuc3dlcnMgZm9yIGFuIGFyY2hpdmVkIG5hbWUgd2FzIHRocm93biBhd2F5IGFuZCB0aGUgUFVUXG4gIC8vIHRoYXQgZm9sbG93ZWQgbGFuZGVkOiBgYXJjaGl2ZSB4OyB0b3BpYyB4IFwidFwiYCByZXR1cm5lZCBvazp0cnVlLCBleGl0IDAuXG4gIGNvbnN0IGVuc3VyZSA9IGF3YWl0IGFwaTx7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0+KHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCB7IG5hbWUgfSk7XG4gIGlmIChlbnN1cmUuc3RhdHVzID49IDQwMCkgZGllQXBpKGVuc3VyZS5kYXRhLCBlbnN1cmUuc3RhdHVzKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxUb3BpY1Jlc3BvbnNlPihwb3J0LCBcIlBVVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vdG9waWNgLCB7XG4gICAgdG9waWM6IHRleHQsXG4gICAgZnJvbTogZnJvbSA/PyBcInN5c3RlbVwiLFxuICB9KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbDogbmFtZSwgdG9waWM6IGRhdGE/LnRvcGljLCBpZDogZGF0YT8uaWQgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExpc3QoKSB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxDaGFubmVsc1Jlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9jaGFubmVsc1wiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgb3B0czogeyBxdWlldD86IGJvb2xlYW47IHZlcmJvc2U/OiBib29sZWFuOyBpblJlcGx5VG8/OiBudW1iZXIgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIWZyb20gfHwgIXRleHQpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGNvbnN0IGJvZHk6IHsgZnJvbTogc3RyaW5nOyB0ZXh0OiBzdHJpbmc7IGluX3JlcGx5X3RvPzogbnVtYmVyIH0gPSB7XG4gICAgZnJvbSxcbiAgICB0ZXh0LFxuICB9O1xuICBpZiAob3B0cy5pblJlcGx5VG8gIT09IHVuZGVmaW5lZCkgYm9keS5pbl9yZXBseV90byA9IG9wdHMuaW5SZXBseVRvO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFNlbmRSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgLy8gVGFyZ2V0IGVjaG8gb24gc3RkZXJyIOKAlCBjb25maXJtcyBXSEVSRSB0aGUgbWVzc2FnZSBsYW5kZWQgc28gYSBtaXNyb3V0ZWRcbiAgLy8gcmVwbHkgKHJpZ2h0IHByb21wdCwgd3JvbmcgY2hhbm5lbCkgaXMgY2F1Z2h0IHRoZSBpbnN0YW50IGl0IGhhcHBlbnMgKEY5KS5cbiAgLy8gT24gc3RkZXJyIHNvIGl0IG5ldmVyIHBvbGx1dGVzIHRoZSBzdGRvdXQgSlNPTiByZWNlaXB0LCBhbmQgaXQgZmlyZXMgZXZlblxuICAvLyB1bmRlciAtLXF1aWV0ICh0aGUgc2FmZXR5IHNpZ25hbCBzaG91bGRuJ3QgYmUgc2lsZW5jZWQpLlxuICBjb25zdCByZWNpcCA9XG4gICAgZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWRcbiAgICAgID8gYCR7ZGF0YS5yZWNpcGllbnRzfSByZWNpcGllbnQocylgXG4gICAgICA6IGAke2RhdGEuc3Vic2NyaWJlcnMgPz8gMH0gc3Vic2NyaWJlcihzKWA7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIOKGkiAke2RhdGEuY2hhbm5lbH0gwrcgJHtyZWNpcH1cXG5gKTtcbiAgaWYgKG9wdHMucXVpZXQpIHJldHVybjtcbiAgLy8gVGVyc2UgZGVmYXVsdDogaWQgKyBzdWJzY3JpYmVyIGNvdW50ICsgdm9pZCB3YXJuaW5nLiAtLXZlcmJvc2UgYWxzb1xuICAvLyBpbmNsdWRlcyB0aGUgc3Vic2NyaWJlciBhbGlhcyBsaXN0IChzYW1lIGRhdGEgYXMgdGhlIGB3aG9gIHZlcmIsXG4gIC8vIHBpZ2d5YmFja2VkIHRvIGF2b2lkIGFuIGV4dHJhIHJvdW5kLXRyaXAgd2hlbiB0aGUgc2VuZGVyIGNhcmVzKS5cbiAgY29uc3Qgb3V0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICBvazogdHJ1ZSxcbiAgICBpZDogZGF0YS5pZCxcbiAgICBjaGFubmVsOiBkYXRhLmNoYW5uZWwsXG4gICAgc3Vic2NyaWJlcnM6IGRhdGEuc3Vic2NyaWJlcnMgPz8gMCxcbiAgfTtcbiAgLy8gT25seSBzdXJmYWNlIHJlY2lwaWVudHMgaWYgdGhlIGRhZW1vbiBhY3R1YWxseSBjb21wdXRlZCBpdC4gRGVmYXVsdGluZ1xuICAvLyB0byAwIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIFwicmVhbGx5IDBcIiBhbmQgaGlkIHNpbGVudCBWMS41LWRhZW1vblxuICAvLyBkZWdyYWRhdGlvbiBkdXJpbmcgY3Jvc3MtdmVyc2lvbiBzZXNzaW9uczsgbWlzc2luZy1tZWFucy1taXNzaW5nIGlzIHRoZVxuICAvLyBob25lc3Qgc2lnbmFsLlxuICBpZiAoZGF0YS5yZWNpcGllbnRzICE9PSB1bmRlZmluZWQpIG91dC5yZWNpcGllbnRzID0gZGF0YS5yZWNpcGllbnRzO1xuICBpZiAoZGF0YS5zdWJzY3JpYmVycyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcImNoYW5uZWwgaGFzIG5vIHN1YnNjcmliZXJzXCI7XG4gIGVsc2UgaWYgKGRhdGEucmVjaXBpZW50cyA9PT0gMCkgb3V0Lndhcm5pbmcgPSBcIm9ubHkgeW91IGFyZSBzdWJzY3JpYmVkXCI7XG4gIGlmIChvcHRzLnZlcmJvc2UpIG91dC5zdWJzY3JpYmVyX2FsaWFzZXMgPSBkYXRhLnN1YnNjcmliZXJfYWxpYXNlcyA/PyBbXTtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFubm91bmNlKFxuICBmcm9tOiBzdHJpbmcsXG4gIHRleHQ6IHN0cmluZyxcbiAgY2hhbm5lbHM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7IHF1aWV0PzogYm9vbGVhbiB9LFxuKSB7XG4gIGlmICghZnJvbSB8fCAhdGV4dCkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBhbm5vdW5jZSAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogeyBmcm9tOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgY2hhbm5lbHM/OiBzdHJpbmdbXSB9ID0geyBmcm9tLCB0ZXh0IH07XG4gIGlmIChjaGFubmVscz8ubGVuZ3RoKSBib2R5LmNoYW5uZWxzID0gY2hhbm5lbHM7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8QW5ub3VuY2VSZWNlaXB0Pihwb3J0LCBcIlBPU1RcIiwgXCIvYW5ub3VuY2VcIiwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgYCMgYW5ub3VuY2VkIOKGkiAke2RhdGEuY2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIMK3ICR7ZGF0YS50b3RhbF9yZWNpcGllbnRzfSByZWNpcGllbnQocylcXG5gLFxuICApO1xuICBpZiAob3B0cy5xdWlldCkgcmV0dXJuO1xuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG9rOiB0cnVlLFxuICAgIGNoYW5uZWxzOiBkYXRhLmNoYW5uZWxzLFxuICAgIHRvdGFsX3JlY2lwaWVudHM6IGRhdGEudG90YWxfcmVjaXBpZW50cyxcbiAgfTtcbiAgaWYgKGRhdGEuc2tpcHBlZD8ubGVuZ3RoKSBvdXQuc2tpcHBlZCA9IGRhdGEuc2tpcHBlZDtcbiAgaWYgKGRhdGEuY2hhbm5lbHMubGVuZ3RoID09PSAwKSBvdXQud2FybmluZyA9IFwibm8gYWN0aXZlIGNoYW5uZWxzIHRvIGFubm91bmNlIHRvXCI7XG4gIHByaW50SnNvbihvdXQpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQdWxsKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2U6IG51bWJlciwgb3B0czogeyBzdGF0dXM/OiBzdHJpbmcgfSA9IHt9KSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBwdWxsIDxjaGFubmVsPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcblxuICBpZiAob3B0cy5zdGF0dXMgIT09IHVuZGVmaW5lZCkge1xuICAgIC8vIFRoaXMgYnJhbmNoIGFuc3dlcnMgZnJvbSB0aGUgbG9nIGZpbGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93bi5cbiAgICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgICAvLyBGdWxsLWNoYW5uZWwgc2NhbjogZmlsdGVyIGJ5IGxhdGVzdCBkaXNwb3NpdGlvbiwgc3RhdHVzIGZyYW1lcyBleGNsdWRlZC5cbiAgICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICAgIGNvbnN0IGZpbHRlcmVkID0gYmFkZ2VkLmZpbHRlcigobSkgPT4ge1xuICAgICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICAgIC8vIGAtLXN0YXR1cyBvcGVuYCBtaXJyb3JzIHRyaWFnZSdzIG9wZW4gYnVja2V0OiBzaWduYWwtb25seSwgc28gbm9uLW1lc3NhZ2VcbiAgICAgIC8vIEZZSXMgKHRvcGljL2Fubm91bmNlbWVudCkgYXJlIGV4Y2x1ZGVkIGZyb20gdGhlIGFjdGlvbmFibGUgcXVldWUuXG4gICAgICByZXR1cm4gb3B0cy5zdGF0dXMgPT09IFwib3BlblwiXG4gICAgICAgID8gbS5raW5kID09PSBcIm1lc3NhZ2VcIiAmJiBpc09wZW4oZGlzcEFyZylcbiAgICAgICAgOiBtLmRpc3Bvc2l0aW9uID09PSBvcHRzLnN0YXR1cztcbiAgICB9KTtcbiAgICBjb25zdCBsYXN0SWQgPSBmaWx0ZXJlZC5hdCgtMSk/LmlkID8/IDA7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBmaWx0ZXJlZCwgY3Vyc29yOiBsYXN0SWQgfSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU2luY2Utd2luZG93IHBhdGggKHVuY2hhbmdlZCBmcm9tIFRhc2sgMikuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke3NpbmNlfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgcmF3TXNncyA9IGRhdGE/Lm1lc3NhZ2VzID8/IFtdO1xuICBjb25zdCBjdXJzb3IgPSByYXdNc2dzLmF0KC0xKT8uaWQgPz8gc2luY2U7XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBhbm5vdGF0ZWQgPSByYXdNc2dzXG4gICAgLy8gRGlzcG9zaXRpb24gZnJhbWVzIG9ubHkg4oCUIGEgbGlmZWN5Y2xlIGZyYW1lIChhcmNoaXZlL3VuYXJjaGl2ZSkgc3RheXMgaW5cbiAgICAvLyB0aGUgaGlzdG9yeSBhbiBhZ2VudCBwdWxsczsgaXQgaXMgaG93IGl0IGxlYXJucyB0aGUgY2hhbm5lbCB3YXMgcmV0aXJlZC5cbiAgICAuZmlsdGVyKChtKSA9PiAhaXNEaXNwb3NpdGlvbkZyYW1lKG0pKVxuICAgIC5tYXAoKG0pID0+IHtcbiAgICAgIGNvbnN0IGQgPSBkaXNwLmdldChtLmlkKTtcbiAgICAgIHJldHVybiBkID8geyAuLi5tLCBkaXNwb3NpdGlvbjogZC5kaXNwb3NpdGlvbiwgcmVvcGVuczogZC5yZW9wZW5zIH0gOiBtO1xuICAgIH0pO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IGFubm90YXRlZCwgY3Vyc29yIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZWFkKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgaWQ6IG51bWJlciwgb3B0czogeyB0ZXh0PzogYm9vbGVhbiB9KSB7XG4gIGlmICghbmFtZSB8fCAhTnVtYmVyLmlzRmluaXRlKGlkKSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSByZWFkIDxjaGFubmVsPiA8aWQ+IFstLXRleHRdXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJ1aWx0IG9uIHRoZSBleGlzdGluZyByYW5nZSBmZXRjaCDigJQgYHNpbmNlPWlkLTFgIHJldHVybnMgaWQgYW5kIGJleW9uZDtcbiAgLy8gd2UgcGljayB0aGUgZXhhY3QgaWQuIE5vIGRhZW1vbiBBUEkgY2hhbmdlLiBUaGlzIGlzIHRoZSB0YXJnZXRlZFxuICAvLyBcImdpdmUgbWUgbWVzc2FnZSBOIGluIGZ1bGxcIiB2ZXJiIHRoYXQgcmVjb3ZlcnMgYSBjbGlwcGVkIHRhaWwgcHJldmlld1xuICAvLyB3aXRob3V0IHRoZSBwdWxsLXJhbmdlICsganEgZGFuY2UuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS9tZXNzYWdlcz9zaW5jZT0ke2lkIC0gMX1gLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIGNvbnN0IG1zZyA9IChkYXRhPy5tZXNzYWdlcyA/PyBbXSkuZmluZCgobSkgPT4gbS5pZCA9PT0gaWQpO1xuICBpZiAoIW1zZykgZGllKGBtZXNzYWdlICR7aWR9IG5vdCBmb3VuZCBpbiAke25hbWV9YCwgXCJub3RfZm91bmRcIik7XG4gIGNvbnN0IGRpc3BNYXAgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBkID0gZGlzcE1hcC5nZXQoaWQpO1xuICBjb25zdCBhbm5vdGF0ZWRNc2cgPSBkID8geyAuLi5tc2csIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSA6IG1zZztcbiAgaWYgKG9wdHMudGV4dCkge1xuICAgIC8vIFByb3NlIG1vZGU6IGhlYWRlciArIGJvZHksIG5vIEpTT04gZW52ZWxvcGUsIHNvIGEgaHVtYW4gKG9yIGFuIGFnZW50XG4gICAgLy8gcmVjb3ZlcmluZyBhIHRydW5jYXRlZCBub3RpZmljYXRpb24pIGNhbiByZWFkIGl0IGRpcmVjdGx5LlxuICAgIGNvbnN0IHRzID0gbmV3IERhdGUobXNnLnRzKS50b0lTT1N0cmluZygpO1xuICAgIGNvbnN0IGRpc3BQcmVmaXggPSBkXG4gICAgICA/IGQucmVvcGVucyA+IDBcbiAgICAgICAgPyBgWyR7ZC5kaXNwb3NpdGlvbn0g4oa7JHtkLnJlb3BlbnN9XSBgXG4gICAgICAgIDogYFske2QuZGlzcG9zaXRpb259XSBgXG4gICAgICA6IFwiXCI7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7ZGlzcFByZWZpeH1bJHttc2cuaWR9XSAke21zZy5mcm9tfSDCtyAke3RzfVxcbiR7bXNnLnRleHR9XFxuYCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlOiBhbm5vdGF0ZWRNc2cgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhaXQoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgc2luY2U6IG51bWJlcixcbiAgdGltZW91dFM6IG51bWJlcixcbiAgYWxpYXM6IHN0cmluZyB8IHVuZGVmaW5lZCxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgd2FpdCA8Y2hhbm5lbD4gWy0tYXMgPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEdpdmUgdGhlIEhUVFAgZmV0Y2ggYSBzbGlnaHRseSBoaWdoZXIgYWJvcnQgdGltZW91dCB0aGFuIHRoZSBkYWVtb24nc1xuICAvLyBsb25nLXBvbGwgdGltZW91dCBzbyB0aGUgZGFlbW9uIGFsd2F5cyB3aW5zIHRoZSB0aW1lb3V0IHJhY2UuXG4gIC8vIGA/YXM9PGFsaWFzPmAgcmVnaXN0ZXJzIHByZXNlbmNlIG9uIHRoZSBjaGFubmVsIGZvciB0aGUgd2FpdCBkdXJhdGlvbiDigJRcbiAgLy8gd2FpdCBpcyBsb25nLXBvbGwgKHB1c2gtc2hhcGVkIHdpdGggYSBkZWFkbGluZSkgc28gaXQgZGVzZXJ2ZXMgcHJlc2VuY2UuXG4gIGNvbnN0IGFzUGFyYW0gPSBhbGlhcyA/IGAmYXM9JHtlbmNvZGVVUklDb21wb25lbnQoYWxpYXMpfWAgOiBcIlwiO1xuICBjb25zdCB1cmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5uZWxzLyR7bmFtZX0vd2FpdD9zaW5jZT0ke3NpbmNlfSZ0aW1lb3V0PSR7dGltZW91dFN9JHthc1BhcmFtfWA7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCwge1xuICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCgodGltZW91dFMgKyA1KSAqIDEwMDApLFxuICB9KTtcbiAgbGV0IGRhdGE6IFdhaXRSZXNwb25zZSB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgV2FpdFJlc3BvbnNlO1xuICB9IGNhdGNoIHt9XG4gIGlmICghcmVzLm9rKSBkaWVBcGkoZGF0YSwgcmVzLnN0YXR1cyk7XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgbWVzc2FnZXM6IGRhdGE/Lm1lc3NhZ2VzID8/IFtdLFxuICAgIGN1cnNvcjogZGF0YT8uY3Vyc29yID8/IHNpbmNlLFxuICAgIHRpbWVkX291dDogISFkYXRhPy50aW1lZF9vdXQsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXaG8obmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB3aG8gPGNoYW5uZWw+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UsIGNoYW5uZWw6IG5hbWUsIHN1YnNjcmliZXJzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdWJzY3JpYmVyc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3N1YnNjcmliZXJzYCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgLi4uZGF0YSB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2hvQWxsKCkge1xuICAvLyBDcm9zcy1jaGFubmVsIHJvc3RlciDigJQgbmFtZXMgw5cgY2hhbm5lbCBpbiBvbmUgY2FsbCwgc28geW91IGRvbid0IGZhbiBvdXRcbiAgLy8gTiBgd2hvYCBjYWxscyArIGEgbWFudWFsIGpvaW4gdG8gYW5zd2VyIFwid2hvIGlzIG9uIHdoaWNoIHZpbmU/XCIuXG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbHM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFByZXNlbmNlUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL3ByZXNlbmNlXCIpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyBHZXQgb3Igc2V0IHRoZSBwZXJzaXN0ZWQgZGVmYXVsdCBhbGlhcyAoVjEuNykuIFdpdGggbm8gYXJndW1lbnQsIHByaW50cyB0aGVcbi8vIGN1cnJlbnQgYWxpYXM7IHdpdGggb25lLCB3cml0ZXMgaXQgdG8gY29uZmlnLmpzb24uIFB1cmUgZmlsZSBJL08g4oCUIHdvcmtzXG4vLyB3aXRob3V0IGEgcnVubmluZyBkYWVtb24uIFRoZSB3YXRjaCBzdXJmYWNlIHJlYWRzIGl0IHZpYSBHRVQgL2lkZW50aXR5IHNvIHRoZVxuLy8gaHVtYW4gaGFzIGEgY29uc2lzdGVudCBuYW1lIGFjcm9zcyBldmVyeSBncmFwZXZpbmUuXG5hc3luYyBmdW5jdGlvbiBjbWRBbGlhcyhuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgbGV0IGNmZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fTtcbiAgdHJ5IHtcbiAgICBjZmcgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhDT05GSUdfRklMRSwgXCJ1dGYtOFwiKSk7XG4gIH0gY2F0Y2gge31cbiAgaWYgKG5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IGFsaWFzID0gdHlwZW9mIGNmZy5hbGlhcyA9PT0gXCJzdHJpbmdcIiAmJiBjZmcuYWxpYXMudHJpbSgpID8gY2ZnLmFsaWFzLnRyaW0oKSA6IG51bGw7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFsaWFzIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB0cmltbWVkID0gbmFtZS50cmltKCk7XG4gIGNmZy5hbGlhcyA9IHRyaW1tZWQ7XG4gIG1rZGlyU3luYyhEQVRBX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHdyaXRlRmlsZVN5bmMoQ09ORklHX0ZJTEUsIGAke0pTT04uc3RyaW5naWZ5KGNmZywgbnVsbCwgMil9XFxuYCk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBhbGlhczogdHJpbW1lZCB8fCBudWxsIH0pO1xufVxuXG4vKipcbiAqIFRoZSBzdGFuZGluZyB0YWlsIOKAlCBgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgLCBhZG9wdGVkIGF0IFBoYXNlIDYgY2hhcHRlciAyLlxuICpcbiAqIOKblCBXSEFUIFRISVMgUkVQTEFDRUQsIEFORCBXSEFUIElUIEJPVUdIVC4gVGhpcyB2ZXJiIHdhcyAyMjAgbGluZXMgb2ZcbiAqIGhhbmQtd3JpdHRlbiByZWNvbm5lY3QgbG9vcDogdGhyZWUgbmVzdGVkIGxvb3BzIChyZWNvbm5lY3QgLyByZWFkIC8gZnJhbWVcbiAqIGRyYWluKSwgaXRzIG93biBTU0Ugc3BsaXR0ZXIsIGl0cyBvd24gYmFja29mZiwgYW5kIGEgYHByb2Nlc3MuZXhpdCgwKWAgaW4gYVxuICogc2lnbmFsIGhhbmRsZXIgc2V2ZW4gbGluZXMgaW4uIFRoZSBzaGFyZWQgY2xpZW50IGlzIHRoZSBzYW1lIGRlc2lnbiwgb25jZSwgYW5kXG4gKiB0aHJlZSB0aGluZ3MgYXJyaXZlIHdpdGggaXQgdGhhdCBncmFwZXZpbmUgZGlkIG5vdCBoYXZlOlxuICpcbiAqICAgMS4gKipBTiBJRExFIFdBVENIRE9HIOKAlCBncmFwZXZpbmUgaGFkIE5PTkUuKiogYGF3YWl0IHJlYWRlci5yZWFkKClgIHdhc1xuICogICAgICB1bmJvdW5kZWQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhXG4gKiAgICAgIFNJR0tJTExlZCBkYWVtb24gcGFya2VkIHRoZSB0YWlsIEZPUkVWRVIsIGFuZCBhIHBhcmtlZCB0YWlsIGlzXG4gKiAgICAgIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLiBgVEFJTF9JRExFX01TYCBpcyB0aHJlZSBvZiBUSElTXG4gKiAgICAgIHNwZWxsJ3MgMyBzIGJlYXRzIChgLi9oZWFydGJlYXQudHNgKSwgbmV2ZXIgYSBjb3BpZWQgNDUsMDAwLlxuICogICAyLiAqKkEgU1BFQy1DT1JSRUNUIEZSQU1FIFBBUlNFUi4qKiBUaGUgaGFuZC13cml0dGVuIG9uZSBkaWRcbiAqICAgICAgYGxpbmUuc2xpY2UoNSkudHJpbSgpYCwgd2hpY2ggc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIHRoZSBvbmVcbiAqICAgICAgbGVhZGluZyBzcGFjZSB0aGUgc3BlYyByZW1vdmVzIOKAlCBpdCB3b3VsZCBjb3JydXB0IGEgbWVzc2FnZSBib2R5IHdob3NlXG4gKiAgICAgIGZpcnN0IGxpbmUgaXMgaW5kZW50ZWQuIE5vdGhpbmcgaW4gdGhlIHJvc3RlciBlbWl0cyBvbmUgdG9kYXk7IHRoZSBwYXJzZVxuICogICAgICBpcyByaWdodCBhbnl3YXkgbm93LlxuICogICAzLiAqKkEgU0lHTkFMIFBBVEggVEhBVCBEUkFJTlMuKiogVGhlIG9sZCBoYW5kbGVyIHdhc1xuICogICAgICBgc3RvcHBlZCA9IHRydWU7IHByb2Nlc3MuZXhpdCgwKWAg4oCUIHRoZSBQMGYgZGVmZWN0IGV4YWN0bHksIGFwcGxpZWQgdG9cbiAqICAgICAgdGhlIHRlcm1pbmFsIGZyYW1lIGluIGZpdmUgc3BlbGxzIGFuZCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZVxuICogICAgICBsaW5lcyBhYm92ZSBpdC4gQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWRcbiAqICAgICAgc3Rkb3V0LiBUaGUgY2xpZW50IFJFVFVSTlMgYW4gZXhpdCBjb2RlOyBgbWFpbmAgYXNzaWducyBpdCBhbmQgcmV0dXJuc1xuICogICAgICBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMuXG4gKlxuICog4puUIE5PIGBlcG9jaE9mYCAvIGBvbkVwb2NoQ2hhbmdlYCwgQU5EIFRIQVQgSVMgQSBSVUxJTkcsIE5PVCBBTiBPTUlTU0lPTlxuICogKEQ3MCkuIEdyYXBldmluZSdzIGlkcyBhcmUgUkVDT1ZFUkVEIGFjcm9zcyBhIHJlc3RhcnQg4oCUIGBsb2FkQ2hhbm5lbCgpYFxuICogZGVyaXZlcyBgbmV4dF9pZGAgYXMgYSBoaWdoLXdhdGVyIG1hcmsgb3ZlciB0aGUgZHVyYWJsZSBgLmpzb25sYCDigJQgc28gYVxuICogcmVjb25uZWN0aW5nIGN1cnNvciBpcyBzdGlsbCB2YWxpZCBhbmQgdGhlIGNvbmRpdGlvbiBhbiBlcG9jaCBkZXRlY3RzIGNhbm5vdFxuICogb2NjdXIgaGVyZS4gV2lyaW5nIG9uZSB3b3VsZCBiZSBhIFJFR1JFU1NJT04gd2l0aCBhIG1lYXN1cmVkIG1lY2hhbmlzbTpcbiAqIGBvbkVwb2NoQ2hhbmdlYCBzZXRzIGBjdXJzb3IgPSAwYCwgYW5kIHRoaXMgZGFlbW9uIGFuc3dlcnMgYHNpbmNlPTBgIHdpdGhcbiAqIGByZWFkQmFja2xvZyhuYW1lLCAwKWAg4oCUIHRoZSB3aG9sZSBjaGFubmVsIGxvZyBvZmYgZGlzaywgaW50byBhbiBhZ2VudCdzIHBpcGUsXG4gKiBvbiBldmVyeSBgZ3JhcGV2aW5lIHJvbGxgLlxuICpcbiAqIOKaoCBgcmVzb2x2ZWAgQ0FMTFMgYGVuc3VyZURhZW1vbmAsIFdISUNIIENBTiBSQUlTRSDigJQgZGVsaWJlcmF0ZWx5LCBhbmQgdGhlIGtpdFxuICogZG9jdW1lbnRzIHRoZSBwcm9wZXJ0eSB0aGlzIGRlcGVuZHMgb246IGl0cyBvdXRlciBibG9jayBpcyBhIGB0cnlgL2BmaW5hbGx5YFxuICogd2l0aCBOTyBgY2F0Y2hgLCBzbyBhIGBDbGlFcnJvcmAgZnJvbSB0aHJlZSBmcmFtZXMgZG93biBwcm9wYWdhdGVzIGludG9cbiAqIGBtYWluYCBpbnN0ZWFkIG9mIGJlaW5nIHJlYWQgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kIHJldHJpZWQgZm9yZXZlci5cbiAqIENoZWNrZWQgYXQgdGhlIGFkb3B0aW9uIHJhdGhlciB0aGFuIGFzc3VtZWQgKHBsYXlib29rIEI5IHN0ZXAgNSkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgb3B0czoge1xuICAgIHNpbmNlPzogbnVtYmVyO1xuICAgIGZyb21TdGFydD86IGJvb2xlYW47XG4gICAgbGFzdD86IG51bWJlcjtcbiAgICBhcz86IHN0cmluZztcbiAgICBodW1hbj86IGJvb2xlYW47XG4gICAgbHVyaz86IGJvb2xlYW47XG4gICAgbWF4PzogbnVtYmVyO1xuICB9LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFuYW1lKVxuICAgIGRpZShcbiAgICAgIFwidXNhZ2U6IGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS1mcm9tLXN0YXJ0XSBbLS1sYXN0IDxuPl0gWy0taHVtYW5dIFstLWx1cmtdIFstLW1heCA8bj5dXCIsXG4gICAgKTtcbiAgLy8gLS1sdXJrIHJlY2VpdmVzIG1lc3NhZ2VzIGJ1dCByZWdpc3RlcnMgbm8gcHJlc2VuY2Ug4oCUIGFuIGludmlzaWJsZSBvYnNlcnZlci5cbiAgLy8gSXQgb3ZlcnJpZGVzIGlkZW50aXR5IGZsYWdzIChhIGx1cmtlciBoYXMgbm8gbmFtZSB0byBzaG93KS5cbiAgY29uc3QgbXlBbGlhcyA9IG9wdHMubHVyayA/IHVuZGVmaW5lZCA6IG9wdHMuYXM7XG4gIGNvbnN0IHNpbmNlID0gb3B0cy5mcm9tU3RhcnQgPyAwIDogKG9wdHMuc2luY2UgPz8gLTEpO1xuICAvLyBFbWl0IHRoZSBncm91bmRpbmcgbGluZSBvbmx5IG9uIHRoZSBmaXJzdCBzdWJzY3JpYmUsIG5ldmVyIG9uIHJlY29ubmVjdHNcbiAgLy8gKGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSB0aGUgY3Vyc29yIOKAlCB0aGVyZSBpcyBubyB1bnNlZW4gaGlzdG9yeSB0aGVuKS5cbiAgLy8g4puUIEFORCBORVZFUiBPTiBBIGAtLXNpbmNlYCBSRS1BUk0gKGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsIEEzKTogdGhlXG4gIC8vIGFnZW50IGFscmVhZHkga25vd3MgdGhlIGNoYW5uZWwsIGFuZCB0aGUgaGlzdG9yeSBoaW50IHdvdWxkIGJlIG5vaXNlLlxuICBsZXQgZ3JvdW5kZWQgPSBvcHRzLnNpbmNlICE9PSB1bmRlZmluZWQ7XG4gIC8vIOKblCBUSEUgQk9PS01BUksgRk9SIEEgTElWRS1PTkxZIFRBSUwuIGBzaW5jZSA9IC0xYCBhc2tzIGZvciBubyBoaXN0b3J5LCBzbyBhXG4gIC8vIHRhaWwgdGhhdCBzZWVzIG5vIG1lc3NhZ2UgaGFzIG5vIGlkIHRvIGhhbmQgaXRzIHJlLWFybSwgYW5kIHRoZSByZS1hcm1cbiAgLy8gd291bGQgbWlzcyBldmVyeXRoaW5nIHNlbnQgaW4gdGhlIGdhcC4gVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXIgY2FycmllcyB0aGVcbiAgLy8gY2hhbm5lbCdzIGBsYXRlc3RfaWRgOiBzZWVkaW5nIHRoZSBjdXJzb3IgZnJvbSBpdCBtYWtlcyB0aGUgaGFuZG9mZidzXG4gIC8vIGAtLXNpbmNlYCBleGFjdC4gT25seSBmb3IgYSBsaXZlLW9ubHkgc3RhcnQg4oCUIGEgYmFja2ZpbGxpbmcgb25lIChgLS1sYXN0YCxcbiAgLy8gYC0tZnJvbS1zdGFydGAsIGAtLXNpbmNlYCkgaXMgc3RpbGwgcmVhZGluZyBpZHMgYXQgb3IgYmVsb3cgaXQsIGFuZCBhXG4gIC8vIHJlY29ubmVjdCBtaWQtYmFja2ZpbGwgbXVzdCBub3Qgc2tpcCBwYXN0IHRoZW0uXG4gIC8vIE9uY2U6IGEgbGF0ZXIgbWFya2VyIChhIHJlY29ubmVjdCkgbXVzdCBub3QganVtcCB0aGUgY3Vyc29yIHBhc3QgbWVzc2FnZXNcbiAgLy8gaXRzIG93biBiYWNrbG9nIGlzIGFib3V0IHRvIHJlcGxheS5cbiAgbGV0IHNlZWRGcm9tTWFya2VyID0gc2luY2UgPCAwICYmIG9wdHMubGFzdCA9PT0gdW5kZWZpbmVkO1xuXG4gIC8vIOKblCBBIFBSRVNFTkNFIFNQRUxMOiB0aGUgY29ubmVjdGlvbiBJUyBgd2hvYCdzIHByZXNlbmNlLCBzbyB0aGUgd2luZG93XG4gIC8vIGFsd2F5cyBuYW1lcyB0aGUgTW9uaXRvciByZS1hcm0sIG5ldmVyIHRoZSBzdG9wLXN0YXJ0IGAtLW9uY2VgLCBhbmQgYSBsb3N0XG4gIC8vIGRhZW1vbiBpcyByZXRyaWVkIChgcmVzb2x2ZWAgcmVzcGF3bnMgaXQpLCBub3QgcmVwb3J0ZWQuXG4gIGNvbnN0IGFnYWluID0gKGF0OiBudW1iZXIpID0+XG4gICAgY29tbWFuZExpbmUoW1xuICAgICAgXCJ0YWlsXCIsXG4gICAgICBuYW1lLFxuICAgICAgLi4uKG9wdHMubHVyayA/IFtcIi0tbHVya1wiXSA6IG15QWxpYXMgPyBbXCItLWFzXCIsIG15QWxpYXNdIDogW10pLFxuICAgICAgLi4uKG9wdHMuaHVtYW4gJiYgIW9wdHMubHVyayA/IFtcIi0taHVtYW5cIl0gOiBbXSksXG4gICAgICAuLi4ob3B0cy5tYXggIT09IHVuZGVmaW5lZCA/IFtcIi0tbWF4XCIsIFN0cmluZyhvcHRzLm1heCldIDogW10pLFxuICAgICAgLy8gYC0tc2luY2VgIHRha2VzIG5vIG5lZ2F0aXZlIGhlcmU7IGEgdGFpbCB0aGF0IG5ldmVyIGxlYXJuZWQgYW4gaWRcbiAgICAgIC8vIHJlLWFybXMgbGl2ZS1vbmx5LCB3aGljaCBpcyB3aGF0IC0xIG1lYW50LlxuICAgICAgLi4uKGF0ID49IDAgPyBbXCItLXNpbmNlXCIsIFN0cmluZyhhdCldIDogW10pLFxuICAgIF0pO1xuXG4gIHJldHVybiBhd2FpdCB0YWlsV2l0aEhhbmRvZmY8VGFpbFBheWxvYWQ+KFxuICAgIHtcbiAgICAgIC8vIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRUQuIEEgdGFpbCBvdXRsaXZlc1xuICAgICAgLy8gdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3Qg4oCUIGByb2xsYCBhbmQgYHJlc3RhcnRgIGJvdGggcmVwbGFjZSBpdCDigJQgYW5kXG4gICAgICAvLyBgZW5zdXJlRGFlbW9uYCByZS1yZWFkcyB0aGUgcG9ydCBmaWxlIGFuZCByZXNwYXducywgc28gYSByZWNvbm5lY3QgYWZ0ZXIgYVxuICAgICAgLy8gcm9sbCBsYW5kcyBvbiB0aGUgTkVXIGRhZW1vbiByYXRoZXIgdGhhbiBzcGlubmluZyBhZ2FpbnN0IGEgZGVhZCBwb3J0LlxuICAgICAgcmVzb2x2ZTogYXN5bmMgKCkgPT4gYGh0dHA6Ly8xMjcuMC4wLjE6JHthd2FpdCBlbnN1cmVEYWVtb24oKX1gLFxuICAgICAgcGF0aDogYC9jaGFubmVscy8ke25hbWV9L3RhaWxgLFxuICAgICAgc2luY2UsXG4gICAgICAvLyDimqAgTk8gZW5zdXJlIGNhbGwgYmVmb3JlIHRoZSBzdWJzY3JpYmUuIEEgZnJlc2ggYHRhaWwgbmFtZWAgc3RpbGwgd29ya3NcbiAgICAgIC8vIHdpdGhvdXQgYW4gZXhwbGljaXQgb3BlbiDigJQgR0VUIOKApi90YWlsIGNyZWF0ZXMgdGhlIGNoYW5uZWwgaXRzZWxmIOKAlCBhbmRcbiAgICAgIC8vIHRoYXQgaXMgdGhlIE9OTFkgd2F5IHRoZSBzdWJzY3JpYmVkIGV2ZW50J3MgYGNyZWF0ZWRgIGZsYWcgY2FuIGV2ZXIgYmVcbiAgICAgIC8vIHRydWU6IGFuIGVuc3VyZSBzZW50IGZpcnN0IGNyZWF0ZXMgdGhlIGNoYW5uZWwsIHNvIHRoZSBzdWJzY3JpYmUgdGhhdFxuICAgICAgLy8gZm9sbG93cyBhbHdheXMgcmVwb3J0cyBgY3JlYXRlZDpmYWxzZWAgYW5kIHRoZSBtaXN0eXBlZC1uYW1lIHNpZ25hbCBuZXZlclxuICAgICAgLy8gZmlyZXMuXG4gICAgICBxdWVyeTogKGN1cnNvciwgZmlyc3RDb25uZWN0KSA9PiB7XG4gICAgICAgIGNvbnN0IHE6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9O1xuICAgICAgICAvLyAjNjgg4oCUIGAtLWxhc3QgTmAgcmlkZXMgdGhlIEZJUlNUIGNvbm5lY3Rpb24gb25seS4gT25jZSBhbnkgbWVzc2FnZVxuICAgICAgICAvLyBsYW5kcyB0aGUgY3Vyc29yIGFkdmFuY2VzIGFuZCBhIHJlY29ubmVjdCByZXN1bWVzIGZyb20gaXQgdmlhIGBzaW5jZWAsXG4gICAgICAgIC8vIG5ldmVyIHJlLWJhY2tmaWxsaW5nIHRoZSB3aW5kb3cuIGBmaXJzdENvbm5lY3RgIGlzIHRoZSBraXQncyBwYXJhbWV0ZXJcbiAgICAgICAgLy8gZm9yIGV4YWN0bHkgdGhpczsgdGhlIGhhbmQtd3JpdHRlbiBsb29wIHNwZWxsZWQgaXQgYGhpZ2hlc3RTZWVuIDwgMGAsXG4gICAgICAgIC8vIHdoaWNoIHdhcyB0aGUgc2FtZSB0ZXN0IGJ5IGFjY2lkZW50IG9mIHRoZSBzZW50aW5lbC5cbiAgICAgICAgaWYgKG9wdHMubGFzdCAhPT0gdW5kZWZpbmVkICYmIGZpcnN0Q29ubmVjdCkgcS5sYXN0ID0gU3RyaW5nKG9wdHMubGFzdCk7XG4gICAgICAgIGlmIChteUFsaWFzKSBxLmFzID0gbXlBbGlhcztcbiAgICAgICAgaWYgKG9wdHMuaHVtYW4gJiYgIW9wdHMubHVyaykgcS5odW1hbiA9IFwiMVwiO1xuICAgICAgICBpZiAob3B0cy5sdXJrKSBxLmx1cmsgPSBcIjFcIjtcbiAgICAgICAgcmV0dXJuIHE7XG4gICAgICB9LFxuICAgICAgY3Vyc29yT2Y6IChldikgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiKSByZXR1cm4gZXYuaWQ7XG4gICAgICAgIGlmIChzZWVkRnJvbU1hcmtlciAmJiB0eXBlb2YgZXYubGF0ZXN0X2lkID09PSBcIm51bWJlclwiKSB7XG4gICAgICAgICAgc2VlZEZyb21NYXJrZXIgPSBmYWxzZTtcbiAgICAgICAgICByZXR1cm4gZXYubGF0ZXN0X2lkO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICB9LFxuICAgICAgYWNjZXB0OiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIC8vIFRoZSBzdWJzY3JpYmVkIG1hcmtlciBpcyBub3QgYSBtZXNzYWdlOyBgcmVuZGVyYCBhbnN3ZXJzIGl0LlxuICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09IFwic3Vic2NyaWJlZFwiKSByZXR1cm4gdHJ1ZTtcbiAgICAgICAgLy8gRHJvcCBESVNQT1NJVElPTiBmcmFtZXMg4oCUIHRoZXkgYXJlIG1ldGFkYXRhIGFib3V0IGFub3RoZXIgbWVzc2FnZS4gQVxuICAgICAgICAvLyBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSBwYXNzZXMgdGhyb3VnaDogYW4gYWdlbnQgdGFpbGluZyBhXG4gICAgICAgIC8vIGNoYW5uZWwgY291bGQgbm90IHByZXZpb3VzbHkgc2VlIGVpdGhlciBwYXJ0eSByZXRpcmUgaXQsIGFuZCBmb3VuZCBvdXRcbiAgICAgICAgLy8gd2hlbiBpdHMgbmV4dCBzZW5kIHdhcyByZWplY3RlZC5cbiAgICAgICAgaWYgKGlzRGlzcG9zaXRpb25GcmFtZShldikpIHJldHVybiBmYWxzZTtcbiAgICAgICAgLy8gU3VwcHJlc3Mgc2VsZi1lY2hvOiB3aGVuIC0tYXMgaXMgc2V0LCBkcm9wIG1lc3NhZ2VzIHdlIHNlbnQgb3Vyc2VsdmVzLlxuICAgICAgICAvLyBUaGUgc2VuZGVyIGFscmVhZHkgZ290IHRoZSByZWNlaXB0IGFzIHRoZSBQT1NUIHJlc3BvbnNlLCBzbyByZS1lbWl0dGluZ1xuICAgICAgICAvLyBpdCBvbiB0YWlsIGlzIHB1cmUgbm9pc2UuXG4gICAgICAgIGlmIChteUFsaWFzICYmIGV2LmZyb20gPT09IG15QWxpYXMpIHJldHVybiBmYWxzZTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9LFxuICAgICAgcmVuZGVyOiAocGF5bG9hZCwgZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGZyYW1lLmV2ZW50ID09PSBcInN1YnNjcmliZWRcIikgcmV0dXJuIHJlbmRlclN1YnNjcmliZWQocGF5bG9hZCk7XG4gICAgICAgIC8vICM2NyDigJQgZnJvbnQtbG9hZCBhIHJlY292ZXJ5IHBvaW50ZXIgb24gRVZFUlkgbWVzc2FnZSBmcmFtZSwgc28gdGhlIHJlYWRcbiAgICAgICAgLy8gY29vcmRpbmF0ZXMgc3Vydml2ZSBhIGRvd25zdHJlYW0gbm90aWZpY2F0aW9uIGNsaXAuIE1vbml0b3IgdHJ1bmNhdGVzIGF0XG4gICAgICAgIC8vIGl0cyBPV04gY2FwIChiZWxvdyBvdXIgaGludCB0aHJlc2hvbGQsIGFuZCBvbmUgd2UgY2Fubm90IG9ic2VydmUgaGVyZSk7IGFcbiAgICAgICAgLy8gbWVzc2FnZSBpdCBjbGlwcyB3b3VsZCBvdGhlcndpc2UgbG9zZSBpdHMgdHJhaWxpbmcgYGlkYCBhbmQgYmVjb21lXG4gICAgICAgIC8vIHVucmVjb3ZlcmFibGUg4oCUIHRoZSByZWFkZXIgaXMgbGVmdCBpbmZlcnJpbmcgdGhlIGlkLiBFdmVyeSBmcmFtZVxuICAgICAgICAvLyB0aGVyZWZvcmUgY2FycmllcyBhIEZST05ULWxvYWRlZCBgcmVhZCA8Y2hhbm5lbD4gPGlkPmAsIGVpdGhlciBhcyB0aGVcbiAgICAgICAgLy8gcmljaGVyIGB0cnVuY2F0aW9uX2hpbnRgIChnZW51aW5lbHktbG9uZyBtZXNzYWdlcyDigJQgdGhlIFwiK04gY2hhcnMsXG4gICAgICAgIC8vIHlvdSdyZSBkZWZpbml0ZWx5IG1pc3NpbmcgY29udGVudFwiIGFsYXJtKSBvciBhcyB0aGUgY29tcGFjdCBgZnVsbGBcbiAgICAgICAgLy8gcG9pbnRlci4gU2VyaWFsaXppbmcgaXQgYmVmb3JlIHRoZSBsb25nIGAudGV4dGAgaXMgd2hhdCBtYWtlcyBpdCBzdXJ2aXZlXG4gICAgICAgIC8vIHRoZSBjbGlwIChGMTcpLlxuICAgICAgICBjb25zdCByZWFkUmVmID0gYHJlYWQgJHtuYW1lfSAke3BheWxvYWQuaWR9YDtcbiAgICAgICAgaWYgKFxuICAgICAgICAgIHR5cGVvZiBwYXlsb2FkLnRleHQgPT09IFwic3RyaW5nXCIgJiZcbiAgICAgICAgICBwYXlsb2FkLnRleHQubGVuZ3RoID4gKG9wdHMubWF4ID8/IFRSVU5DQVRJT05fSElOVF9USFJFU0hPTEQpXG4gICAgICAgICkge1xuICAgICAgICAgIGNvbnN0IHRydW5jYXRpb25faGludCA9IGArJHtwYXlsb2FkLnRleHQubGVuZ3RofSBjaGFycyDigJQgZnVsbDogJHtyZWFkUmVmfWA7XG4gICAgICAgICAgLy8gQ2FwIHRoZSBJTkxJTkUgYm9keSB3aGVuIC0tbWF4IGlzIHNldCAodGhlIGZ1bGwgbWVzc2FnZSBzdGF5cyBvbiBkaXNrXG4gICAgICAgICAgLy8g4oaSIGByZWFkYCk7IHdpdGhvdXQgLS1tYXgsIGVtaXQgdGhlIGZ1bGwgdGV4dCAodG9kYXkncyBkZWZhdWx0KS5cbiAgICAgICAgICBjb25zdCB0ZXh0ID0gb3B0cy5tYXggIT09IHVuZGVmaW5lZCA/IHBheWxvYWQudGV4dC5zbGljZSgwLCBvcHRzLm1heCkgOiBwYXlsb2FkLnRleHQ7XG4gICAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgdHJ1bmNhdGlvbl9oaW50LCAuLi5wYXlsb2FkLCB0ZXh0IH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IGZ1bGw6IHJlYWRSZWYsIC4uLnBheWxvYWQgfSk7XG4gICAgICB9LFxuICAgICAgLy8gRGFlbW9uIGxpdmVuZXNzIGhlYXJ0YmVhdCAoYDogaGIgPHRzPmApLiBTdXJmYWNlIGEgcmVjb2duaXphYmxlIHNlbnRpbmVsXG4gICAgICAvLyBvbiBzdGRlcnIgc28gYSBgMj4mMWAgY29uc3VtZXIgY2FuIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIChGNikuIEtlcHRcbiAgICAgIC8vIG9mZiBzdGRvdXQg4oCUIHRoZSBKU09OTCBzdHJlYW0gc3RheXMgcHVyZS5cbiAgICAgIG9uQ29tbWVudDogKHRleHQpID0+ICh0ZXh0LnRyaW1TdGFydCgpLnN0YXJ0c1dpdGgoXCJoYlwiKSA/IFwiOiBncmFwZXZpbmUta2VlcGFsaXZlXCIgOiBudWxsKSxcbiAgICAgIG9uTWFsZm9ybWVkOiAoX2ZyYW1lLCBlKSA9PiBgIyBiYWQgc3NlIGRhdGE6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsXG4gICAgICAvLyBUaGUgZm91ciBsaW5lcyB0aGUgaGFuZC13cml0dGVuIGxvb3Agd3JvdGUsIHByZXNlcnZlZCB2ZXJiYXRpbSDigJQgYSB0YWlsXG4gICAgICAvLyB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIG9uZSB0aGF0IGlzIHdvcmtpbmcuXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIHN3aXRjaCAoaW5mby5jYXVzZSkge1xuICAgICAgICAgIGNhc2UgXCJjb25uZWN0LWZhaWxlZFwiOlxuICAgICAgICAgICAgcmV0dXJuIGAjIGNvbm5lY3QgZmFpbGVkOiAke2luZm8uZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGluZm8uZXJyb3IubWVzc2FnZSA6IFN0cmluZyhpbmZvLmVycm9yKX0sIHJldHJ5aW5n4oCmYDtcbiAgICAgICAgICBjYXNlIFwiaHR0cFwiOlxuICAgICAgICAgIGNhc2UgXCJuby1ib2R5XCI6XG4gICAgICAgICAgICByZXR1cm4gYCMgdGFpbCBIVFRQICR7aW5mby5zdGF0dXN9LCByZXRyeWluZ+KApmA7XG4gICAgICAgICAgY2FzZSBcInN0cmVhbS1lcnJvclwiOlxuICAgICAgICAgICAgcmV0dXJuIGAjIHN0cmVhbSBkcm9wcGVkOiAke2luZm8uZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGluZm8uZXJyb3IubWVzc2FnZSA6IFN0cmluZyhpbmZvLmVycm9yKX0sIHJlY29ubmVjdGluZ+KApmA7XG4gICAgICAgICAgY2FzZSBcInN0cmVhbS1lbmRcIjpcbiAgICAgICAgICAgIHJldHVybiBcIiMgc3RyZWFtIGNsb3NlZCwgcmVjb25uZWN0aW5n4oCmXCI7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICB9LFxuICAgIHtcbiAgICAgIHNwZWxsOiBcImdyYXBldmluZVwiLFxuICAgICAgbW9kZTogXCJ3YXRjaFwiLFxuICAgICAgcHJlc2VuY2U6IHRydWUsXG4gICAgICAvLyBENDogYSBodW1hbiBhdCBhIHRlcm1pbmFsIChgLS1odW1hbmApIGlzIG5vdCBhbiBhZ2VudCB1bmRlclxuICAgICAgLy8gTW9uaXRvcidzIGNhcCwgc28gdGhlaXIgd2F0Y2ggbmV2ZXIgZW5kcyBieSBpdHNlbGYuXG4gICAgICAuLi4ob3B0cy5odW1hbiA/IHsgd2luZG93TXM6IDAgfSA6IHt9KSxcbiAgICAgIC8vIFRoZSBgc3Vic2NyaWJlZGAgbWFya2VyIChhbmQgdGhlIGdyb3VuZGluZyBsaW5lIGl0IHJlbmRlcnMpIGlzIG5vdCBhXG4gICAgICAvLyBtZXNzYWdlIG9uIHRoZSBjaGFubmVsLlxuICAgICAgY291bnRzOiAoX2V2LCBmcmFtZSkgPT4gZnJhbWUuZXZlbnQgIT09IFwic3Vic2NyaWJlZFwiLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2U6IGF0IH0pID0+IGFnYWluKGF0KSxcbiAgICAgICAgY29tZUJhY2s6ICgpID0+IGNvbW1hbmRMaW5lKFtcImRvY3RvclwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG5cbiAgLyoqIFRoZSBgc3Vic2NyaWJlZGAgbWFya2VyOiBzdGRlcnIgY29udGV4dCwgcGx1cyBhIHN0cnVjdHVyZWQgZ3JvdW5kaW5nIGxpbmVcbiAgICogIG9uIHN0ZG91dCB0aGUgRklSU1QgdGltZSBvbmx5LiAqL1xuICBmdW5jdGlvbiByZW5kZXJTdWJzY3JpYmVkKHBheWxvYWQ6IFRhaWxQYXlsb2FkKTogc3RyaW5nIHwgbnVsbCB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgc3Vic2NyaWJlZCB0byAke3BheWxvYWQuY2hhbm5lbH0gKHNpbmNlPSR7cGF5bG9hZC5zaW5jZX0pXFxuYCk7XG4gICAgaWYgKHBheWxvYWQudG9waWMpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHRvcGljOiAke3BheWxvYWQudG9waWN9XFxuYCk7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZClcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyBjcmVhdGVkICR7cGF5bG9hZC5jaGFubmVsfSDigJQgdGhpcyB0YWlsIGJyb3VnaHQgaXQgaW50byBiZWluZyAoY2hlY2sgdGhlIG5hbWUpXFxuYCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkXFxuYCxcbiAgICAgICk7XG4gICAgLy8gU3RydWN0dXJlZCBncm91bmRpbmcgb24gc3Rkb3V0IChGMy9GNykg4oCUIHVuZGVyIHRoZSBkZWZhdWx0IFdpcmluZy1CXG4gICAgLy8gTW9uaXRvciwgc3Rkb3V0IHN1cmZhY2VzIGFzIG5vdGlmaWNhdGlvbnMsIHNvIGEgZnJlc2ggc3Vic2NyaWJlciBhY3R1YWxseVxuICAgIC8vIHNlZXMgdGhlIHRvcGljICsgdGhhdCBlYXJsaWVyIGhpc3RvcnkgZXhpc3RzLiBHYXRlZDogb25seSB3aGVuIHRoZXJlJ3NcbiAgICAvLyBzb21ldGhpbmcgdG8gZ3JvdW5kICh1bnNlZW4gaGlzdG9yeSBvciBhIHRvcGljKSwgYW5kIG9ubHkgb24gdGhlIGZpcnN0XG4gICAgLy8gc3Vic2NyaWJlIChub3QgcmVjb25uZWN0cykuXG4gICAgaWYgKGdyb3VuZGVkKSByZXR1cm4gbnVsbDtcbiAgICBncm91bmRlZCA9IHRydWU7XG4gICAgY29uc3QgbGF0ZXN0ID0gdHlwZW9mIHBheWxvYWQubGF0ZXN0X2lkID09PSBcIm51bWJlclwiID8gcGF5bG9hZC5sYXRlc3RfaWQgOiAwO1xuICAgIGNvbnN0IGVhcmxpZXIgPSBzaW5jZSA8IDAgPyBsYXRlc3QgOiBNYXRoLm1heCgwLCBNYXRoLm1pbihzaW5jZSwgbGF0ZXN0KSk7XG4gICAgLy8gYGNyZWF0ZWRgIGFuZCBgYXJjaGl2ZWRgIGpvaW4gdGhlIGdhdGUgb24gcHVycG9zZS4gQSBjaGFubmVsIHRoaXNcbiAgICAvLyBzdWJzY3JpYmUganVzdCBtYWRlIGhhcyBubyB0b3BpYyBhbmQgbm8gaGlzdG9yeSwgc28gdGhlIG9sZCBjb25kaXRpb25cbiAgICAvLyAoYGVhcmxpZXIgPiAwIHx8IHRvcGljYCkgaXMgZXhhY3RseSB0aGUgY2FzZSB0aGF0IGVtaXRzIE5PVEhJTkc7IGFuZCBhblxuICAgIC8vIEFSQ0hJVkVEIGNoYW5uZWwncyBncm91bmRpbmcgbGluZSB3YXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIGhlYWx0aHlcbiAgICAvLyBvbmUncywgc28gYSBsYXRlIGpvaW5lciBzdGlsbCBsZWFybmVkIHRoZSBjaGFubmVsIHdhcyByZXRpcmVkIG9ubHkgd2hlblxuICAgIC8vIGl0cyBzZW5kIGJvdW5jZWQuXG4gICAgLy9cbiAgICAvLyDimqAgVGhlIGhpbnRzIEFDQ1VNVUxBVEUgaW50byBhIGxpc3QgcmF0aGVyIHRoYW4gYXNzaWduaW5nIHRvIG9uZSBmaWVsZC5cbiAgICAvLyBUaGV5IHVzZWQgdG8gYmUgdGhyZWUgYXNzaWdubWVudHMgdG8gYGdyb3VuZGluZy5oaW50YCwgb3JkZXJlZCBzbyB0aGUgbW9zdFxuICAgIC8vIGltcG9ydGFudCB3b24g4oCUIHdoaWNoIGlzIGEgaGludCB0aGF0IGNhbiBzaWxlbnRseSBsb3NlIHRvIGFub3RoZXIgaGludCxcbiAgICAvLyB0aGUgZmFpbHVyZSBtb2RlIHRoaXMgd2hvbGUgYnJhbmNoIGlzIGFib3V0LCBzaXR0aW5nIGluIHRoZSBmaXggZm9yIGl0LiBBXG4gICAgLy8gbGlzdCBjYW5ub3Qgb3ZlcndyaXRlOiBhbiBhcmNoaXZlZCBjaGFubmVsIFdJVEggaGlzdG9yeSBub3cgc2F5cyBib3RoLlxuICAgIGNvbnN0IGhpbnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGlmIChlYXJsaWVyID4gMClcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2VhcmxpZXJ9IGVhcmxpZXIgbWVzc2FnZShzKSBleGlzdCDigJQgdXNlIC0tZnJvbS1zdGFydCBvciAtLXNpbmNlIDxpZD4gdG8gYmFja2ZpbGxgLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYHRoaXMgdGFpbCBjcmVhdGVkICR7cGF5bG9hZC5jaGFubmVsfSDigJQgbm8gc3VjaCBjaGFubmVsIGV4aXN0ZWQ7IGNoZWNrIHRoZSBuYW1lLCBvciBhbm90aGVyIHBhcnR5IGhhcyB5ZXQgdG8gb3BlbiBpdGAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7cGF5bG9hZC5jaGFubmVsfSBpcyBhcmNoaXZlZCDigJQgcmVhZC1vbmx5OyBhIHNlbmQgd2lsbCBiZSByZWplY3RlZCB1bnRpbCBzb21lb25lIHVuYXJjaGl2ZXMgaXRgLFxuICAgICAgKTtcbiAgICBpZiAoIShlYXJsaWVyID4gMCB8fCBwYXlsb2FkLnRvcGljIHx8IHBheWxvYWQuY3JlYXRlZCB8fCBwYXlsb2FkLmFyY2hpdmVkKSkgcmV0dXJuIG51bGw7XG4gICAgY29uc3QgZ3JvdW5kaW5nOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgIGtpbmQ6IFwiZ3JvdW5kaW5nXCIsXG4gICAgICBjaGFubmVsOiBwYXlsb2FkLmNoYW5uZWwsXG4gICAgICBqb2luZWRfYXQ6IHNpbmNlIDwgMCA/IGxhdGVzdCA6IE1hdGgubWluKHNpbmNlLCBsYXRlc3QpLFxuICAgICAgZWFybGllcixcbiAgICB9O1xuICAgIGlmIChwYXlsb2FkLnRvcGljKSBncm91bmRpbmcudG9waWMgPSBwYXlsb2FkLnRvcGljO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpIGdyb3VuZGluZy5jcmVhdGVkID0gdHJ1ZTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZCkgZ3JvdW5kaW5nLmFyY2hpdmVkID0gdHJ1ZTtcbiAgICBpZiAoaGludHMubGVuZ3RoKSBncm91bmRpbmcuaGludCA9IGhpbnRzLmpvaW4oXCIgwrcgXCIpO1xuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShncm91bmRpbmcpO1xuICB9XG59XG5mdW5jdGlvbiBmb2xkRGlzcG9zaXRpb25zKG5hbWU6IHN0cmluZykge1xuICBjb25zdCBtYXAgPSBuZXcgTWFwPFxuICAgIG51bWJlcixcbiAgICB7XG4gICAgICBkaXNwb3NpdGlvbjogc3RyaW5nO1xuICAgICAgZnJvbTogc3RyaW5nO1xuICAgICAgdHM6IG51bWJlcjtcbiAgICAgIG5vdGU6IHN0cmluZztcbiAgICAgIHJlb3BlbnM6IG51bWJlcjtcbiAgICB9XG4gID4oKTtcbiAgY29uc3QgcGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSByZXR1cm4gbWFwO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmLThcIikuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUudHJpbSgpKSBjb250aW51ZTtcbiAgICBsZXQgbTogTWVzc2FnZTtcbiAgICB0cnkge1xuICAgICAgbSA9IEpTT04ucGFyc2UobGluZSkgYXMgTWVzc2FnZTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobS5raW5kICE9PSBcInN0YXR1c1wiIHx8IHR5cGVvZiBtLnRhcmdldCAhPT0gXCJudW1iZXJcIiB8fCB0eXBlb2YgbS5kaXNwb3NpdGlvbiAhPT0gXCJzdHJpbmdcIilcbiAgICAgIGNvbnRpbnVlO1xuICAgIGNvbnN0IHByZXYgPSBtYXAuZ2V0KG0udGFyZ2V0KTtcbiAgICBjb25zdCByZW9wZW5zID1cbiAgICAgIChwcmV2Py5yZW9wZW5zID8/IDApICtcbiAgICAgIChtLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIiAmJiBwcmV2ICYmIHByZXYuZGlzcG9zaXRpb24gIT09IFwib3BlblwiID8gMSA6IDApO1xuICAgIG1hcC5zZXQobS50YXJnZXQsIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uLFxuICAgICAgZnJvbTogbS5mcm9tLFxuICAgICAgdHM6IG0udHMsXG4gICAgICBub3RlOiBtLnRleHQsXG4gICAgICByZW9wZW5zLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBtYXA7XG59XG4vLyBUV08gdGhpbmdzIG5vdyB3ZWFyIGtpbmQ6XCJzdGF0dXNcIi4gQSBESVNQT1NJVElPTiBmcmFtZSBhY3RzIG9uIGEgc3BlY2lmaWNcbi8vIG1lc3NhZ2UgKGB0YXJnZXRgICsgYGRpc3Bvc2l0aW9uYCkgYW5kIGlzIG1ldGFkYXRhIOKAlCBgcHVsbGAgYW5kIGB0YWlsYCBmb2xkXG4vLyBpdCBhd2F5IGFuZCBiYWRnZSB0aGUgbWVzc2FnZSBpdCBwb2ludHMgYXQgaW5zdGVhZC4gQSBMSUZFQ1lDTEUgZnJhbWVcbi8vIChhcmNoaXZlIC8gdW5hcmNoaXZlKSBpcyBhIGZhY3QgYWJvdXQgdGhlIENIQU5ORUw6IGl0IHRhcmdldHMgbm90aGluZywgYW5kIGl0XG4vLyBpcyB0aGUgd2hvbGUgcG9pbnQgdGhhdCBhIHJlYWRlciBzZWVzIGl0LiBEaXNjcmltaW5hdGluZyBvbiBgZGlzcG9zaXRpb25gXG4vLyByYXRoZXIgdGhhbiBvbiBgZXZlbnRgIGtlZXBzIGEgZnJhbWUgZnJvbSBzb21lIGZ1dHVyZSBlbWl0dGVyIHZpc2libGUgYnlcbi8vIGRlZmF1bHQg4oCUIHRoZSBmYWlsdXJlIG1vZGUgaGVyZSBpcyBzd2FsbG93aW5nIGEgc2lnbmFsLCBub3Qgc2hvd2luZyBvbmUuXG5mdW5jdGlvbiBpc0Rpc3Bvc2l0aW9uRnJhbWUobTogeyBraW5kPzogc3RyaW5nOyBkaXNwb3NpdGlvbj86IHN0cmluZyB9KTogYm9vbGVhbiB7XG4gIHJldHVybiBtLmtpbmQgPT09IFwic3RhdHVzXCIgJiYgdHlwZW9mIG0uZGlzcG9zaXRpb24gPT09IFwic3RyaW5nXCI7XG59XG5cbi8vIFwib3BlblwiID0gbm8gZW50cnksIG9yIGxhdGVzdCBkaXNwb3NpdGlvbiBpcyBcIm9wZW5cIlxuZnVuY3Rpb24gaXNPcGVuKGQ/OiB7IGRpc3Bvc2l0aW9uOiBzdHJpbmcgfSkge1xuICByZXR1cm4gIWQgfHwgZC5kaXNwb3NpdGlvbiA9PT0gXCJvcGVuXCI7XG59XG5cbi8vIFJlYWRzIHRoZSBmdWxsIGNoYW5uZWwgbG9nLCBkcm9wcyBFVkVSWSBraW5kOlwic3RhdHVzXCIgZnJhbWUsIGFuZCBiYWRnZXMgZWFjaFxuLy8gcmVtYWluaW5nIG1lc3NhZ2Ugd2l0aCBpdHMgbGF0ZXN0IGRpc3Bvc2l0aW9uIHZpYSBmb2xkRGlzcG9zaXRpb25zLlxuLy9cbi8vIEV2ZXJ5IG9uZSwgZGVsaWJlcmF0ZWx5IOKAlCBpbmNsdWRpbmcgYSBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSxcbi8vIHdoaWNoIGBwdWxsYCBhbmQgYHRhaWxgIGRvIGxldCB0aHJvdWdoLiBUaGlzIGZlZWRzIGB0cmlhZ2VgLCB3aG9zZSBvcGVuIHF1ZXVlXG4vLyBpcyBcIndoYXQgaXMgbGVmdCB0byBhY3Qgb25cIiwgYW5kIGFuIGFyY2hpdmUgaXMgYW4gRllJLCBub3QgYSB3b3JrIGl0ZW0uIFNhbWVcbi8vIHJlYXNvbiBgdG9waWNgIGFuZCBgYW5ub3VuY2VtZW50YCBhcmUgZm9sZGVkIG91dCBvZiB0aGUgb3BlbiBidWNrZXQgYmVsb3cuXG5mdW5jdGlvbiBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKFxuICBuYW1lOiBzdHJpbmcsXG4pOiAoTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfSlbXSB7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKERBVEFfRElSLCBcImNoYW5uZWxzXCIsIGAke25hbWV9Lmpzb25sYCk7XG4gIGlmICghZXhpc3RzU3luYyhsb2dQYXRoKSkgcmV0dXJuIFtdO1xuICBjb25zdCBkaXNwID0gZm9sZERpc3Bvc2l0aW9ucyhuYW1lKTtcbiAgY29uc3QgbWVzc2FnZXM6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgPT09IFwic3RhdHVzXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGQgPSBkaXNwLmdldChtLmlkKTtcbiAgICBpZiAoZCkge1xuICAgICAgbWVzc2FnZXMucHVzaCh7IC4uLm0sIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2gobSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBtZXNzYWdlcztcbn1cblxudHlwZSBCYWRnZWRNZXNzYWdlID0gTWVzc2FnZSAmIHsgZGlzcG9zaXRpb24/OiBzdHJpbmc7IHJlb3BlbnM/OiBudW1iZXIgfTtcblxuLy8gRGFzaGJvYXJkIHJlbmRlciBvZiBhIHRyaWFnZSBzY2FuOiB0aGUgb3BlbiBxdWV1ZSBvbiB0b3AsIHRoZW4gZWFjaFxuLy8gZGlzcG9zaXRpb24gZ3JvdXAsIG9uZSBzY2FubmFibGUgbGluZSBwZXIgbWVzc2FnZS4gTWlycm9ycyBgcmVhZCAtLXRleHRgXG4vLyBwcm9zZSBtb2RlIHNvIGEgaHVtYW4gKG9yIGFuIGFnZW50KSByZWFkcyBpdCB3aXRob3V0IHBhcnNpbmcgSlNPTi5cbmZ1bmN0aW9uIHJlbmRlclRyaWFnZUh1bWFuKFxuICBuYW1lOiBzdHJpbmcsXG4gIG9wZW46IEJhZGdlZE1lc3NhZ2VbXSxcbiAgYnlfc3RhdHVzOiBSZWNvcmQ8c3RyaW5nLCBCYWRnZWRNZXNzYWdlW10+LFxuKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZSA9IChtOiBCYWRnZWRNZXNzYWdlKSA9PiB7XG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZShtLnRzKS50b0lTT1N0cmluZygpLnNsaWNlKDAsIDE2KS5yZXBsYWNlKFwiVFwiLCBcIiBcIik7XG4gICAgY29uc3QgcmVvcGVuID0gbS5yZW9wZW5zICYmIG0ucmVvcGVucyA+IDAgPyBgIOKGuyR7bS5yZW9wZW5zfWAgOiBcIlwiO1xuICAgIC8vIFRoZSBmaXJzdCBsaW5lLCB3aXRob3V0IGFuIGluZGV4IHJlYWQgYHNwbGl0YCB3b3VsZCBtYWtlIHRoZSBjb21waWxlclxuICAgIC8vIGRvdWJ0OiBgc3BsaXRgIG5ldmVyIHJldHVybnMgYW4gZW1wdHkgYXJyYXksIGFuZCB0aGlzIHNheXMgdGhlIHNhbWUgdGhpbmcuXG4gICAgY29uc3QgbmwgPSBtLnRleHQuaW5kZXhPZihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gbmwgPT09IC0xID8gbS50ZXh0IDogbS50ZXh0LnNsaWNlKDAsIG5sKTtcbiAgICBjb25zdCBwcmV2aWV3ID0gaGVhZC5sZW5ndGggPiAxMDAgPyBgJHtoZWFkLnNsaWNlKDAsIDk5KX3igKZgIDogaGVhZDtcbiAgICByZXR1cm4gYCAgWyR7bS5pZH0ke3Jlb3Blbn1dICR7bS5mcm9tfSDCtyAke3RzfSDCtyAke3ByZXZpZXd9YDtcbiAgfTtcbiAgY29uc3Qgc2VjdGlvbnMgPSBbYCR7bmFtZX0gwrcgdHJpYWdlXFxuYCwgYE9QRU4gKCR7b3Blbi5sZW5ndGh9KWBdO1xuICBzZWN0aW9ucy5wdXNoKG9wZW4ubGVuZ3RoID8gb3Blbi5tYXAobGluZSkuam9pbihcIlxcblwiKSA6IFwiICDigJRcIik7XG4gIGZvciAoY29uc3QgW3N0YXR1cywgaXRlbXNdIG9mIE9iamVjdC5lbnRyaWVzKGJ5X3N0YXR1cykpIHtcbiAgICBzZWN0aW9ucy5wdXNoKGBcXG4ke3N0YXR1cy50b1VwcGVyQ2FzZSgpfSAoJHtpdGVtcy5sZW5ndGh9KWAsIGl0ZW1zLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpKTtcbiAgfVxuICByZXR1cm4gYCR7c2VjdGlvbnMuam9pbihcIlxcblwiKX1cXG5gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUcmlhZ2UobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcHRzOiB7IGh1bWFuPzogYm9vbGVhbiB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHRyaWFnZSA8Y2hhbm5lbD4gWy0taHVtYW5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIHRyaWFnZSByZWFkcyB0aGUgbG9nIGZpbGUsIG5vdCBhIHJvdXRlLCBzbyBpdCBjYW5ub3QgNDA0IG9uIGl0cyBvd24g4oCUIGFuZFxuICAvLyBhbiBlbXB0eSBkYXNoYm9hcmQgZm9yIGEgY2hhbm5lbCB0aGF0IGRvZXMgbm90IGV4aXN0IGlzIHRoZSBzYW1lIHNpbGVudCBsaWVcbiAgLy8gYXMgYW4gZW1wdHkgYHB1bGxgLlxuICBhd2FpdCByZXF1aXJlQ2hhbm5lbChwb3J0LCBuYW1lKTtcbiAgY29uc3QgYmFkZ2VkID0gbG9hZENoYW5uZWxNZXNzYWdlc0JhZGdlZChuYW1lKTtcbiAgY29uc3Qgb3BlbjogQmFkZ2VkTWVzc2FnZVtdID0gW107XG4gIGNvbnN0IGJ5X3N0YXR1czogUmVjb3JkPHN0cmluZywgQmFkZ2VkTWVzc2FnZVtdPiA9IHt9O1xuICBmb3IgKGNvbnN0IG0gb2YgYmFkZ2VkKSB7XG4gICAgLy8gaXNPcGVuIGV4cGVjdHMgYSBkaXNwb3NpdGlvbiBlbnRyeSBvYmplY3QgKG9yIHVuZGVmaW5lZCBmb3Igbm8gZW50cnkpLlxuICAgIGNvbnN0IGRpc3BBcmcgPSBtLmRpc3Bvc2l0aW9uICE9PSB1bmRlZmluZWQgPyB7IGRpc3Bvc2l0aW9uOiBtLmRpc3Bvc2l0aW9uIH0gOiB1bmRlZmluZWQ7XG4gICAgaWYgKGlzT3BlbihkaXNwQXJnKSkge1xuICAgICAgLy8gVGhlIG9wZW4gcXVldWUgaXMgc2lnbmFsLW9ubHk6IHNraXAgbm9uLWFjdGlvbmFibGUgZnJhbWVzICh0b3BpYy9cbiAgICAgIC8vIGFubm91bmNlbWVudCBGWUlzIGNhbiBuZXZlciBjYXJyeSBhIGRpc3Bvc2l0aW9uLCBzbyB0aGV5J2Qgb3RoZXJ3aXNlXG4gICAgICAvLyBwYWQgXCJ3aGF0J3MgbGVmdD9cIiBmb3JldmVyKS5cbiAgICAgIGlmIChtLmtpbmQgPT09IFwibWVzc2FnZVwiKSBvcGVuLnB1c2gobSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGtleSA9IG0uZGlzcG9zaXRpb24gPz8gXCJ1bmtub3duXCI7XG4gICAgICBpZiAoIWJ5X3N0YXR1c1trZXldKSBieV9zdGF0dXNba2V5XSA9IFtdO1xuICAgICAgYnlfc3RhdHVzW2tleV0ucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgaWYgKG9wdHMuaHVtYW4pIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShyZW5kZXJUcmlhZ2VIdW1hbihuYW1lLCBvcGVuLCBieV9zdGF0dXMpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG9wZW4sIGJ5X3N0YXR1cyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kR3JlcChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBwYXR0ZXJuOiBzdHJpbmcsXG4gIG9wdHM6IHsgbGl0ZXJhbD86IGJvb2xlYW47IGZyb20/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIXBhdHRlcm4pXG4gICAgZGllKFwidXNhZ2U6IGdyYXBldmluZSBncmVwIDxjaGFubmVsPiA8cGF0dGVybj4gWy0tbGl0ZXJhbHwtRl0gWy0tZnJvbSA8YWxpYXM+XVwiKTtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgbGV0IG1hdGNoZXI6ICh0ZXh0OiBzdHJpbmcpID0+IGJvb2xlYW47XG4gIGlmIChvcHRzLmxpdGVyYWwpIHtcbiAgICBjb25zdCBuZWVkbGUgPSBwYXR0ZXJuLnRvTG93ZXJDYXNlKCk7XG4gICAgbWF0Y2hlciA9ICh0ZXh0KSA9PiB0ZXh0LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMobmVlZGxlKTtcbiAgfSBlbHNlIHtcbiAgICBsZXQgcmU6IFJlZ0V4cDtcbiAgICB0cnkge1xuICAgICAgcmUgPSBuZXcgUmVnRXhwKHBhdHRlcm4sIFwiaVwiKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBkaWUoYGludmFsaWQgcmVnZXg6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfWAsIFwidXNhZ2VcIik7XG4gICAgfVxuICAgIG1hdGNoZXIgPSAodGV4dCkgPT4gcmUudGVzdCh0ZXh0KTtcbiAgfVxuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKTtcbiAgY29uc3QgbWVzc2FnZXM6IHVua25vd25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgcmF3LnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lKSBjb250aW51ZTtcbiAgICBsZXQgbXNnOiBQYXJ0aWFsPE1lc3NhZ2U+O1xuICAgIHRyeSB7XG4gICAgICBtc2cgPSBKU09OLnBhcnNlKGxpbmUpIGFzIFBhcnRpYWw8TWVzc2FnZT47XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHR5cGVvZiBtc2cudGV4dCAhPT0gXCJzdHJpbmdcIikgY29udGludWU7XG4gICAgaWYgKG9wdHMuZnJvbSAmJiBtc2cuZnJvbSAhPT0gb3B0cy5mcm9tKSBjb250aW51ZTtcbiAgICBpZiAoIW1hdGNoZXIobXNnLnRleHQpKSBjb250aW51ZTtcbiAgICBtZXNzYWdlcy5wdXNoKG1zZyk7XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2VzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRDbG9zZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGNsb3NlIDxuYW1lPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkgZGllKFwibm8gZGFlbW9uIHJ1bm5pbmdcIiwgXCJub3RfZm91bmRcIik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U3RhdHVzUmVzcG9uc2U+KHBvcnQsIFwiREVMRVRFXCIsIGAvY2hhbm5lbHMvJHtuYW1lfWApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZXNldChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdHM6IHsgZm9yY2U/OiBib29sZWFuIH0pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHJlc2V0IDxuYW1lPiBbLS1mb3JjZV1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgYm9vbGVhbj4gPSB7fTtcbiAgaWYgKG9wdHMuZm9yY2UpIGJvZHkuZm9yY2UgPSB0cnVlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IHN1YnNjcmliZXJzPzogbnVtYmVyIH0+KFxuICAgIHBvcnQsXG4gICAgXCJQT1NUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L3Jlc2V0YCxcbiAgICBib2R5LFxuICApO1xuICBpZiAoc3RhdHVzID09PSA0MDkgJiYgZGF0YT8uZXJyb3IgPT09IFwibGl2ZVwiKSB7XG4gICAgZGllKFxuICAgICAgYGNoYW5uZWwgaGFzICR7ZGF0YS5zdWJzY3JpYmVyc30gbGl2ZSBzdWJzY3JpYmVyKHMpIOKAlCByZWZ1c2luZyB0byBjbGVhciBhIGxpdmUgc2Vzc2lvbi4gUmUtcnVuIHdpdGggLS1mb3JjZSB0byBjbGVhciBhbnl3YXkgKHRoZSBsb2cgaXMgc25hcHNob3R0ZWQgZmlyc3QpLmAsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgfVxuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyBBcmNoaXZlIChyZWFkLW9ubHkpIG9yIHVuYXJjaGl2ZSBhIGNoYW5uZWwgKFYxLjcpIOKAlCB0aGUgbm9uLWRlc3RydWN0aXZlXG4vLyBhbHRlcm5hdGl2ZSB0byBjbG9zZTogaGlzdG9yeSBpcyBwcmVzZXJ2ZWQsIHNlbmRzIGFyZSByZWplY3RlZCwgYW5kIHRoZSBuYW1lXG4vLyBpcyBsb2NrZWQgZnJvbSByZS1vcGVuIHVudGlsIHVuYXJjaGl2ZWQuXG5hc3luYyBmdW5jdGlvbiBjbWRNYXJrKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkOiBudW1iZXIsXG4gIGRpc3Bvc2l0aW9uOiBzdHJpbmcsXG4gIGZyb206IHN0cmluZyxcbiAgb3B0czogeyBub3RlPzogc3RyaW5nIH0sXG4pIHtcbiAgaWYgKCFuYW1lIHx8ICFOdW1iZXIuaXNGaW5pdGUoaWQpIHx8ICFkaXNwb3NpdGlvbilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIG1hcmsgPGNoYW5uZWw+IDxpZD4gPGRpc3Bvc2l0aW9uPiBbLS1ub3RlIDx0ZXh0Pl0gWy0tYXMgPGFsaWFzPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IGZyb20sIHRhcmdldDogaWQsIGRpc3Bvc2l0aW9uIH07XG4gIGlmIChvcHRzLm5vdGUgIT09IHVuZGVmaW5lZCkgYm9keS5ub3RlID0gb3B0cy5ub3RlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE1lc3NhZ2U+KHBvcnQsIFwiUE9TVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vc3RhdHVzYCwgYm9keSk7XG4gIGlmIChzdGF0dXMgPj0gNDAwIHx8ICFkYXRhKSBkaWVBcGkoZGF0YSBhcyB7IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH0gfCBudWxsLCBzdGF0dXMpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFyY2hpdmUobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCB1bmFyY2hpdmU6IGJvb2xlYW4sIGZyb20/OiBzdHJpbmcpIHtcbiAgY29uc3QgdmVyYiA9IHVuYXJjaGl2ZSA/IFwidW5hcmNoaXZlXCIgOiBcImFyY2hpdmVcIjtcbiAgaWYgKCFuYW1lKSBkaWUoYHVzYWdlOiBncmFwZXZpbmUgJHt2ZXJifSA8Y2hhbm5lbD5gKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBCb3RoIHJvdXRlcyBhcHBlbmQgYSBraW5kOlwic3RhdHVzXCIgZnJhbWUgdG8gdGhlIGxvZywgc28gd2hvIGRpZCBpdCBpcyB3b3J0aFxuICAvLyByZWNvcmRpbmcgd2hlbiB0aGUgY2FsbGVyIHRvbGQgdXMuIElkZW50aXR5IGlzIG9wdGlvbmFsIGhlcmUgKGl0IGlzIG9uIHRoZVxuICAvLyBnbG9iYWxseS1hY2NlcHRlZCAtLWFzLy0tZnJvbSksIGFuZCB0aGUgZGFlbW9uIHNpZ25zIFwic3lzdGVtXCIgd2l0aG91dCBpdC5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdGF0dXNSZXNwb25zZT4oXG4gICAgcG9ydCxcbiAgICBcIlBPU1RcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vJHt2ZXJifWAsXG4gICAgZnJvbSA/IHsgZnJvbSB9IDogdW5kZWZpbmVkLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdG9wKG9wdHM6IHsgaG9sZFNlY29uZHM/OiBudW1iZXIgfSA9IHt9KSB7XG4gIGxldCBoZWxkVW50aWw6IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgaWYgKG9wdHMuaG9sZFNlY29uZHMgJiYgb3B0cy5ob2xkU2Vjb25kcyA+IDApIHtcbiAgICBoZWxkVW50aWwgPSBEYXRlLm5vdygpICsgb3B0cy5ob2xkU2Vjb25kcyAqIDEwMDA7XG4gICAgdHJ5IHtcbiAgICAgIHdyaXRlRmlsZVN5bmMoSE9MRF9GSUxFLCBTdHJpbmcoaGVsZFVudGlsKSk7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oe1xuICAgICAgb2s6IHRydWUsXG4gICAgICBkYWVtb246IGZhbHNlLFxuICAgICAgLi4uKGhlbGRVbnRpbCAhPT0gdW5kZWZpbmVkID8geyBoZWxkX3VudGlsOiBoZWxkVW50aWwgfSA6IHt9KSxcbiAgICB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHJ5IHtcbiAgICBhd2FpdCBhcGkocG9ydCwgXCJERUxFVEVcIiwgXCIvXCIpO1xuICB9IGNhdGNoIHt9XG4gIC8vIFRoZSBkYWVtb24gYW5zd2VycywgdGhlbiBzaHV0cyBkb3duLiBSZXR1cm4gb25jZSBpdCBoYXMgZ29uZSwgc28gdGhlIG5leHRcbiAgLy8gdmVyYiBmaW5kcyBubyBkYWVtb24gKGFuZCwgdW5kZXIgLS1ob2xkLCBzZWVzIHRoZSBob2xkKSByYXRoZXIgdGhhbiB0aGVcbiAgLy8gZHlpbmcgb25lIHN0aWxsIGFuc3dlcmluZy5cbiAgYXdhaXQgdW50aWxEYWVtb25Hb25lKFwic3RvcFwiKTtcbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wcGVkOiB0cnVlLFxuICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBQZXItY2hhbm5lbCBsaXZlLWNvbm5lY3Rpb24gc3VtbWFyeSDigJQgdGhlIHJlc3RhcnQtc2FmZXR5IHJlYWQuIE1pcnJvcnMgd2hhdFxuLy8gYGRvY3RvcmAgcmVwb3J0cyB1bmRlciBhY3RpdmVfc3Vic2NyaWJlcnM7IG9ubHkgcG9wdWxhdGVkIGNoYW5uZWxzIGFyZSBsaXN0ZWQuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKFxuICBwb3J0OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgdG90YWw6IG51bWJlcjsgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+IH0+IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgY29uc3QgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgZm9yIChjb25zdCBjaCBvZiBkYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgdG90YWwgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICBpZiAoY2guY29ubmVjdGlvbnMgPiAwKSBjaGFubmVscy5wdXNoKHsgbmFtZTogY2gubmFtZSwgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zIH0pO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnQg4oCUIGEgcHJlc2VuY2UgaGljY3VwIHNob3VsZG4ndCBjcmFzaCBhIGxpZmVjeWNsZSB2ZXJiXG4gIH1cbiAgcmV0dXJuIHsgdG90YWwsIGNoYW5uZWxzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXJ0KCkge1xuICAvLyBFbnN1cmUtcnVubmluZywgbm8gY2hhbm5lbCBzaWRlLWVmZmVjdC4gSWRlbXBvdGVudDogcmVwb3J0IGFuIGV4aXN0aW5nXG4gIC8vIGRhZW1vbiwgb3Igc3Bhd24gYSBmcmVzaCBvbmUuIFRoZSBleHBsaWNpdCBcImJyaW5nIGl0IHVwXCIgdmVyYiDigJQgZGlhZ25vc3RpY3NcbiAgLy8gKGRvY3Rvci9pbmZvL2xpc3QpIHN0YXkgcmVhZC1vbmx5IGFuZCBuZXZlciBzcGF3bi5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIWV4aXN0aW5nICYmIGhvbGRBY3RpdmUoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBoZWxkOiB0cnVlLCBwb3J0OiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwb3J0ID0gZXhpc3RpbmcgPz8gKGF3YWl0IGVuc3VyZURhZW1vbigpKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHBvcnQsIGFscmVhZHlfcnVubmluZzogZXhpc3RpbmcgIT09IG51bGwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc3RhcnQob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gTm90aGluZyB0byB0ZWFyIGRvd24g4oCUIGp1c3QgYnJpbmcgYSBmcmVzaCBkYWVtb24gdXAuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTQUZFVFk6IGEgcmVzdGFydCBmb3JjZXMgZXZlcnkgY29ubmVjdGVkIGNsaWVudCB0byBhdXRvLXJlY29ubmVjdC4gUmVmdXNlIHRvXG4gIC8vIHRlYXIgZG93biBhIHdvcmtpbmcgZmxlZXQgdW5sZXNzIGV4cGxpY2l0bHkgZm9yY2VkIOKAlCBuZXZlciBzaWxlbnRseSBkcm9wIGl0LlxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcmVzdGFydDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7Y2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIOKAlCAke3doZXJlfS4gYCArXG4gICAgICAgIFwiQSByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gYWxsIHRvIHJlY29ubmVjdC4gUmUtcnVuIHdpdGggLS1mb3JjZSAob3IgLS15ZXMpIHRvIHByb2NlZWQgYW55d2F5LlwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FwdHVyZSB0aGUgcGlkIHdlJ3JlIHJlcGxhY2luZywgZm9yIHRoZSByZWNlaXB0LlxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgcHJldmlvdXNQaWQgPSBkYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wLCB0aGVuIHdhaXQgZm9yIHRoZSBvbGQgZGFlbW9uIHRvIGFjdHVhbGx5IGdvIGF3YXkg4oCUIGl0IHVubGlua3MgaXRzXG4gIC8vIHBvcnQvcGlkIGZpbGVzIG9uIHNodXRkb3duLCBzbyBlbnN1cmVEYWVtb24gc3Bhd25zIGZyZXNoIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRpc2NvdmVyaW5nIHRoZSBkeWluZyBvbmUuXG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBhd2FpdCB1bnRpbERhZW1vbkdvbmUoXCJyZXN0YXJ0XCIpO1xuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCB9KTtcbn1cblxuLy8gYjMg4oCUIFRIRSBWRVJTSU9OIFZFUklGWSwgQVMgT05FIFNPVVJDRSBGT1IgQk9USCBQQVRIUy5cbi8vXG4vLyBgcm9sbGAgaXMgZG9jdW1lbnRlZCBhcyBcInRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcCDigKYgKyB2ZXJzaW9uIHZlcmlmeVwiLCBhbmRcbi8vIHRoZSB2ZXJpZnkgaGFkIHR3byB3YXlzIHRvIHNheSBub3RoaW5nOlxuLy9cbi8vICAgQ09MRCBQQVRIIOKAlCBubyBkYWVtb24gcnVubmluZzogaXQgc3Bhd25lZCBvbmUgYW5kIHByaW50ZWQgbmVpdGhlciBgdmVyc2lvbmBcbi8vICAgbm9yIGB2ZXJzaW9uX29rYC4gVGhlIGZpZWxkcyB3ZXJlIEFCU0VOVCwgc28gYSBjYWxsZXIgY2hlY2tpbmcgdGhlIHZlcmlmeVxuLy8gICBnb3QgYHVuZGVmaW5lZGAgb24gdGhlIGV4YWN0IHBhdGggd2hlcmUgdGhlIHZlcmlmeSBuZXZlciBoYXBwZW5lZC5cbi8vXG4vLyAgIFdBUk0gUEFUSCDigJQgdGhlIHByb2JlIHdhcyB3cmFwcGVkIGluIGBjYXRjaCB7fWAsIGxlYXZpbmcgYHZlcnNpb24gPSBudWxsYCxcbi8vICAgYW5kIGB2ZXJzaW9uX29rOiBudWxsID09PSBQTFVHSU5fVkVSU0lPTmAgZXZhbHVhdGVzIHRvIEZBTFNFLiBcIkkgY291bGQgbm90XG4vLyAgIGNoZWNrXCIgd2FzIHJlcG9ydGVkIGFzIFwidGhlIHZlcnNpb24gaXMgV1JPTkdcIiDigJQgYSBib29sZWFuIHRoYXQgY2Fubm90IHNheVxuLy8gICBcInVua25vd25cIiBpcyB0aGUgY2Fub25pY2FsIHNoYXBlIG9mIHRoaXMgc3ByaW50J3MgZGVmZWN0LCBhbmQgZmFsc2UgaXMgdGhlXG4vLyAgIHdvcnN0IGF2YWlsYWJsZSBhbnN3ZXIgYmVjYXVzZSBpdCBpcyBhY3Rpb25hYmxlIGFuZCBpbmNvcnJlY3QuXG4vL1xuLy8gU28gYHZlcnNpb25fb2tgIGlzIG5vdyBgYm9vbGVhbiB8IG51bGxgOiBudWxsIG1lYW5zIFVOQ0hFQ0tFRCwgbmV2ZXIgZmFsc2UuXG4vLyBgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uYCBpcyBwcmVzZW50LWFuZC1udWxsIGJlc2lkZSBpdCwgYmVjYXVzZSBhIGJhcmUgbnVsbFxuLy8gdGVsbHMgYSBjYWxsZXIgdGhlIGNoZWNrIGRpZCBub3QgaGFwcGVuIGFuZCBub3Qgd2h5LlxuLy9cbi8vIE9uZSBoZWxwZXIgcmF0aGVyIHRoYW4gdHdvIGNhbGwgc2l0ZXM6IGEgc2Vjb25kIGNvcHkgb2YgdGhpcyBsb2dpYyBvbiB0aGUgY29sZFxuLy8gcGF0aCBpcyB0aGUgbWlycm9yLWRyaWZ0IHRyYXAsIGFuZCB0aGUgY29sZCBwYXRoIGlzIHByZWNpc2VseSB0aGUgb25lIG5vYm9keVxuLy8gcmUtcmVhZHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVWZXJzaW9uKHBvcnQ6IG51bWJlcik6IFByb21pc2U8e1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB2ZXJzaW9uX29rOiBib29sZWFuIHwgbnVsbDtcbiAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBzdHJpbmcgfCBudWxsO1xufT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHYgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAodiA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBcInRoZSBkYWVtb24gYW5zd2VyZWQgYnV0IHJlcG9ydGVkIG5vIHZlcnNpb25cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IHZlcnNpb246IHYsIHZlcnNpb25fb2s6IHYgPT09IFBMVUdJTl9WRVJTSU9OLCB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IG51bGwgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogYGNvdWxkIG5vdCByZWFjaCB0aGUgZGFlbW9uIHRvIHZlcmlmeTogJHtcbiAgICAgICAgZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJvbGwob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gQ09MRCBQQVRIIOKAlCBub3RoaW5nIHdhcyBydW5uaW5nLCBzbyB0aGlzIGlzIGEgc3RhcnQgcmF0aGVyIHRoYW4gYSByb2xsLlxuICAgIC8vIEl0IHN0aWxsIHJlcG9ydHMgdGhlIHZlcmlmeSwgYmVjYXVzZSBcIm5vIGRhZW1vbiB3YXMgdXBcIiBpcyBub3QgYSByZWFzb24gdG9cbiAgICAvLyBzdGF5IHNpbGVudCBhYm91dCB3aGljaCB2ZXJzaW9uIGlzIG5vdyBzZXJ2aW5nLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgcm9sbGVkOiB0cnVlLFxuICAgICAgcHJldmlvdXNfcGlkOiBudWxsLFxuICAgICAgcG9ydDogZnJlc2gsXG4gICAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByb2xsOiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSDigJQgJHt3aGVyZX0uIFRoZXknbGwgYXV0by1yZWNvbm5lY3QgYWNyb3NzIHRoZSByb2xsLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIHByb2NlZWQuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcHJldmlvdXNQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3Agd2l0aCBhIHNob3J0IGhvbGQgc28gYSBzdGFsZSBDTEkgY2FuJ3Qgd2luIHRoZSByZXNwYXduIHJhY2U7IHdlIGhvbGQgdGhlIHNwYXduIG91cnNlbHZlcy5cbiAgY29uc3QgaG9sZE1zID0gNDAwMDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKERhdGUubm93KCkgKyBob2xkTXMpKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgdHJ5IHtcbiAgICBhd2FpdCB1bnRpbERhZW1vbkdvbmUoXCJyb2xsXCIpO1xuICB9IGZpbmFsbHkge1xuICAgIHJlbGVhc2VIb2xkKCk7IC8vIG91ciB0dXJuIHRvIHNwYXduIHRoZSBuZXcgdmVyc2lvbiwgb3Igbm9ib2R5J3NcbiAgfVxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBsZXQgcGlkOiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBwaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihmcmVzaCwgXCJHRVRcIiwgXCIvXCIpKS5kYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICBwcmludEpzb24oe1xuICAgIG9rOiB0cnVlLFxuICAgIHJvbGxlZDogdHJ1ZSxcbiAgICBwcmV2aW91c19waWQ6IHByZXZpb3VzUGlkLFxuICAgIHBpZCxcbiAgICBwb3J0OiBmcmVzaCxcbiAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXYXRjaChuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgLy8gQ2hhbm5lbCBuYW1lIGlzIG9wdGlvbmFsIOKAlCB0aGUgcGFnZSByZWFkcyBpdCBmcm9tIHRoZSBVUkwgaGFzaCBhbmRcbiAgLy8gZGVmYXVsdHMgdG8gXCJsb2JieVwiIGlmIGFic2VudC4gV2UgcGFzcyB0aHJvdWdoIHdoYXRldmVyIHRoZSB1c2VyIGdhdmVcbiAgLy8gKG9yIFwibG9iYnlcIikgYW5kIG9wZW4gdGhlIGJyb3dzZXIuIERhZW1vbiBpcyBlbnN1cmVkIHNvIHRoZSBzZXJ2ZWRcbiAgLy8gL3dhdGNoIEhUTUwgaXMgcmVhY2hhYmxlLlxuICBjb25zdCBjaGFubmVsID0gbmFtZT8udHJpbSgpID8gbmFtZS50cmltKCkgOiBcImxvYmJ5XCI7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gRW5zdXJlIHRoZSBjaGFubmVsIGV4aXN0cyBzbyB0aGUgcGFnZSBzZWVzIGEgdmFsaWQgYmFja2xvZy90b3BpYy5cbiAgYXdhaXQgYXBpKHBvcnQsIFwiUE9TVFwiLCBcIi9jaGFubmVsc1wiLCB7IG5hbWU6IGNoYW5uZWwgfSk7XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vd2F0Y2gjJHtlbmNvZGVVUklDb21wb25lbnQoY2hhbm5lbCl9YDtcbiAgLy8gT3BlbiB0aGUgYnJvd3NlciB2aWEgdGhlIHBsYXRmb3JtJ3MgZGVmYXVsdCBvcGVuZXIuIEJlc3QtZWZmb3J0IOKAlFxuICAvLyBwcmludCB0aGUgVVJMIHNvIHRoZSB1c2VyIGNhbiBjbGljayBpdCBpZiBhdXRvLW9wZW4gZmFpbHMuXG4gIGNvbnN0IG9wZW5lciA9XG4gICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJleHBsb3JlclwiIDogXCJ4ZGctb3BlblwiO1xuICB0cnkge1xuICAgIGNvbnN0IHAgPSBzcGF3bihvcGVuZXIsIFt1cmxdLCB7XG4gICAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICAgIHN0ZGlvOiBcImlnbm9yZVwiLFxuICAgIH0pO1xuICAgIHAudW5yZWYoKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogb3BlbmVyIG1pc3Npbmcg4oCUIGp1c3QgcHJpbnQgKi9cbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgY2hhbm5lbCwgdXJsIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWREb2N0b3IoKSB7XG4gIC8vIFJlYWQtb25seSBkaWFnbm9zdGljLiBSZXBvcnRzIHRoZSBhdXRob3JpdGF0aXZlIGRhZW1vbiAoaWYgYW55KSwgb3RoZXJcbiAgLy8gZ3JhcGV2aW5lIGRhZW1vbiBwcm9jZXNzZXMgdmlzaWJsZSBvbiB0aGUgbWFjaGluZSwgY2hhbm5lbCBmaWxlcyBvblxuICAvLyBkaXNrLCBhbmQgc3VyZmFjZXMgaGludHMuIERvZXMgTk9UIHRha2UgZGVzdHJ1Y3RpdmUgYWN0aW9uIOKAlCBjbGVhbnVwXG4gIC8vIGlzIHRoZSBvcGVyYXRvcidzIGNhbGwsIHdpdGggc3RvY2sgdW5peCB0b29scy5cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGxldCBhdXRob3JpdGF0aXZlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgPSBudWxsO1xuICAvLyBQZXItY2hhbm5lbCBzdWJzY3JpYmVyIHN1bW1hcnkg4oCUIGFuc3dlcnMgXCJpcyBpdCBzYWZlIHRvIHJlc3RhcnQgdGhlXG4gIC8vIGRhZW1vbiByaWdodCBub3c/XCIgd2l0aG91dCBuZWVkaW5nIHRvIGFsc28gcnVuIGBsaXN0YCBhbmQgcmVhZCB0aGVcbiAgLy8gb3V0cHV0LiBFbXB0eSBpZiBubyBkYWVtb24gaXMgcnVubmluZy5cbiAgbGV0IHRvdGFsU3Vic2NyaWJlcnMgPSAwO1xuICBjb25zdCBidXN5Q2hhbm5lbHM6IEFycmF5PHtcbiAgICBuYW1lOiBzdHJpbmc7XG4gICAgc3Vic2NyaWJlcnM6IG51bWJlcjtcbiAgICBjb25uZWN0aW9uczogbnVtYmVyO1xuICAgIG5hbWVkOiBudW1iZXI7XG4gICAgYW5vbnltb3VzOiBudW1iZXI7XG4gIH0+ID0gW107XG4gIGlmIChwb3J0KSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgICBhdXRob3JpdGF0aXZlID0geyBwb3J0LCAuLi5kYXRhIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBkYWVtb24gd2VudCBhd2F5IGJldHdlZW4gcG9ydCBjaGVjayBhbmQgYXBpIGNhbGxcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIC8vIC9wcmVzZW5jZSBnaXZlcyB0aGUgaG9uZXN0IHBlci1jaGFubmVsIGJyZWFrZG93biAoY29ubmVjdGlvbnMgdnMgbmFtZWRcbiAgICAgIC8vIHZzIGFub255bW91cykg4oCUIHNvIHRoZSByZXN0YXJ0LXNhZmV0eSB0b3RhbCBpc24ndCBhIG15c3RlcnkgYW5kIGFuXG4gICAgICAvLyBhbm9ueW1vdXMgd2F0Y2ggdGFiIHJlYWRzIGFzIGEgd2F0Y2hlciwgbm90IGEgZ2hvc3QuXG4gICAgICBjb25zdCB7IGRhdGE6IHByZXNEYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgICBmb3IgKGNvbnN0IGNoIG9mIHByZXNEYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgICB0b3RhbFN1YnNjcmliZXJzICs9IGNoLmNvbm5lY3Rpb25zO1xuICAgICAgICBidXN5Q2hhbm5lbHMucHVzaCh7XG4gICAgICAgICAgbmFtZTogY2gubmFtZSxcbiAgICAgICAgICBzdWJzY3JpYmVyczogY2guY29ubmVjdGlvbnMsIC8vIGJhY2stY29tcGF0OiBwcmV2aW91c2x5IHRoZSByYXcgY291bnRcbiAgICAgICAgICBjb25uZWN0aW9uczogY2guY29ubmVjdGlvbnMsXG4gICAgICAgICAgbmFtZWQ6IGNoLm5hbWVkLFxuICAgICAgICAgIGFub255bW91czogY2guYW5vbnltb3VzLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGJlc3QtZWZmb3J0XG4gICAgfVxuICB9XG5cbiAgLy8gRW51bWVyYXRlIG90aGVyIGRhZW1vbiBwcm9jZXNzZXMgdmlhIHRoZSBzaGFyZWQgY2xhc3NpZmllci4gRWFjaCBlbnRyeVxuICAvLyBnYWlucyBwb3J0L2hvbWUvdmVyc2lvbi9zdGF0dXMvcmVhcGFibGUgc28gdGhlIG9wZXJhdG9yIGhhcyB0aGUgZnVsbFxuICAvLyBwaWN0dXJlIHdpdGhvdXQgbmVlZGluZyBhIHNlcGFyYXRlIGByZWFwIC0tZHJ5LXJ1bmAuXG4gIGNvbnN0IG90aGVyRGFlbW9uczogQXJyYXk8QXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBjbGFzc2lmeURhZW1vbj4+ICYgeyBjb21tYW5kPzogc3RyaW5nIH0+ID0gW107XG4gIGNvbnN0IHNlbGZQaWQgPSBhdXRob3JpdGF0aXZlPy5waWQgYXMgbnVtYmVyIHwgdW5kZWZpbmVkO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgcGlkIG9mIGF3YWl0IGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCkpIHtcbiAgICAgIGlmIChzZWxmUGlkICYmIHBpZCA9PT0gc2VsZlBpZCkgY29udGludWU7XG4gICAgICBvdGhlckRhZW1vbnMucHVzaChhd2FpdCBjbGFzc2lmeURhZW1vbihwaWQpKTtcbiAgICB9XG4gIH0gY2F0Y2gge1xuICAgIC8vIHBzIHVuYXZhaWxhYmxlOyBjYXJyeSBvbiB3aXRoIGVtcHR5IGxpc3RcbiAgfVxuXG4gIC8vIENoYW5uZWxzIG9uIGRpc2sgdW5kZXIgdGhpcyBIT01FLlxuICBjb25zdCBjaGFubmVsc09uRGlzazogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjaGFubmVsc0RpciA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIik7XG4gICAgaWYgKGV4aXN0c1N5bmMoY2hhbm5lbHNEaXIpKSB7XG4gICAgICBmb3IgKGNvbnN0IGYgb2YgcmVhZGRpclN5bmMoY2hhbm5lbHNEaXIpKSB7XG4gICAgICAgIGlmIChmLmVuZHNXaXRoKFwiLmpzb25sXCIpKSBjaGFubmVsc09uRGlzay5wdXNoKGYucmVwbGFjZSgvXFwuanNvbmwkLywgXCJcIikpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7fVxuXG4gIC8vIEhpbnRzIOKAlCBzdXJmYWNlIHRoZSBtb3N0IGFjdGlvbmFibGUgc2lnbmFscy5cbiAgY29uc3QgaGludHM6IHN0cmluZ1tdID0gW107XG4gIGlmICghYXV0aG9yaXRhdGl2ZSkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBcIk5vIGF1dGhvcml0YXRpdmUgZGFlbW9uIHJ1bm5pbmcgZm9yIHRoaXMgSE9NRS4gUnVuIGFueSB2ZXJiIChlLmcuIGBjbGkudHMgbGlzdGApIHRvIHNwYXduIG9uZS5cIixcbiAgICApO1xuICB9XG4gIGlmIChvdGhlckRhZW1vbnMubGVuZ3RoID4gMCkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgRm91bmQgJHtvdGhlckRhZW1vbnMubGVuZ3RofSBvdGhlciBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3MoZXMpIG9uIHRoaXMgbWFjaGluZS4gYCArXG4gICAgICAgIFwiVGhleSBtYXkgYmUgem9tYmllcyBmcm9tIHBhc3QgcnVucyBPUiBkYWVtb25zIHNlcnZpbmcgb3RoZXIgSE9NRXMgKGRpZmZlcmVudCBHUkFQRVZJTkVfSE9NRSkuXCIsXG4gICAgKTtcbiAgICBjb25zdCByZWFwYWJsZUNvdW50ID0gb3RoZXJEYWVtb25zLmZpbHRlcigoZCkgPT4gZC5yZWFwYWJsZSkubGVuZ3RoO1xuICAgIGlmIChyZWFwYWJsZUNvdW50ID4gMCkge1xuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYEZvdW5kICR7cmVhcGFibGVDb3VudH0gcmVhcGFibGUgb3JwaGFuIGRhZW1vbihzKS4gUnVuIFxcYGdyYXBldmluZSByZWFwXFxgIHRvIGNsZWFyIHRoZW0gc2FmZWx5LmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAob3RoZXJEYWVtb25zLnNvbWUoKGQpID0+IGQuc3RhdHVzID09PSBcInVucmVzcG9uc2l2ZVwiKSkge1xuICAgICAgaGludHMucHVzaChcIlNvbWUgZGFlbW9ucyBhcmUgdW5yZXNwb25zaXZlOyBgZ3JhcGV2aW5lIHJlYXAgLS1mb3JjZWAgaW5jbHVkZXMgdGhlbS5cIik7XG4gICAgfVxuICB9XG4gIGlmIChcbiAgICBhdXRob3JpdGF0aXZlICYmXG4gICAgUExVR0lOX1ZFUlNJT04gJiZcbiAgICB0eXBlb2YgYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSBcInN0cmluZ1wiICYmXG4gICAgYXV0aG9yaXRhdGl2ZS52ZXJzaW9uICE9PSBQTFVHSU5fVkVSU0lPTlxuICApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYEF1dGhvcml0YXRpdmUgZGFlbW9uIHZlcnNpb24gKCR7YXV0aG9yaXRhdGl2ZS52ZXJzaW9ufSkgZGlmZmVycyBmcm9tIHRoaXMgQ0xJJ3MgdmVyc2lvbiAoJHtQTFVHSU5fVkVSU0lPTn0pLiBgICtcbiAgICAgICAgXCJSZXN0YXJ0IHRoZSBkYWVtb24gdG8gYWxpZ24g4oCUIGRyb3AgYWN0aXZlIHRhaWxzLCB0aGVuIGBzdG9wYCwgdGhlbiBhbnkgdmVyYi5cIixcbiAgICApO1xuICB9XG4gIGlmIChhdXRob3JpdGF0aXZlICYmIChhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IG51bGwgfHwgYXV0aG9yaXRhdGl2ZS52ZXJzaW9uID09PSB1bmRlZmluZWQpKSB7XG4gICAgaGludHMucHVzaChcIkF1dGhvcml0YXRpdmUgZGFlbW9uIHByZWRhdGVzIHZlcnNpb24gcmVwb3J0aW5nIChwcmUtVjEuNi4yKS4gUmVzdGFydCB0byBhbGlnbi5cIik7XG4gIH1cbiAgaWYgKHRvdGFsU3Vic2NyaWJlcnMgPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGAke3RvdGFsU3Vic2NyaWJlcnN9IGFjdGl2ZSBzdWJzY3JpYmVyKHMpIGFjcm9zcyAke2J1c3lDaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykuIGAgK1xuICAgICAgICBcIkRhZW1vbiByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gdG8gYXV0by1yZWNvbm5lY3QgKHdvcmtzLCBidXQgZGlzcnVwdGl2ZSkg4oCUIGNvb3JkaW5hdGUgZmlyc3QuXCIsXG4gICAgKTtcbiAgfSBlbHNlIGlmIChhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcIk5vIGFjdGl2ZSBzdWJzY3JpYmVycyDigJQgZGFlbW9uIHJlc3RhcnQgaXMgbm9uLWRpc3J1cHRpdmUuXCIpO1xuICB9XG4gIC8vIEV4cGxhaW4gYW55IGNoYW5uZWwgd2hlcmUgdGhlIGNvbm5lY3Rpb24gY291bnQgZXhjZWVkcyBuYW1lZCBhZ2VudHMg4oCUIGFuXG4gIC8vIGFub255bW91cyB3YXRjaCB0YWIgaW5mbGF0ZXMgYGNvdW50YC9gY29ubmVjdGlvbnNgIGJ1dCBpc24ndCBhIGdob3N0LlxuICBmb3IgKGNvbnN0IGNoIG9mIGJ1c3lDaGFubmVscykge1xuICAgIGlmIChjaC5hbm9ueW1vdXMgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtjaC5uYW1lfTogJHtjaC5jb25uZWN0aW9uc30gY29ubmVjdGlvbihzKSwgJHtjaC5uYW1lZH0gbmFtZWQgYWdlbnQocykgKyBgICtcbiAgICAgICAgICBgJHtjaC5hbm9ueW1vdXN9IGFub255bW91cyAoZS5nLiBhIHdhdGNoIHRhYikuIFRoZSBjb3VudCBvdmVyIHRoZSBuYW1lIGxpc3QgaXMgZXhwZWN0ZWQsIG5vdCBhIGdob3N0LmAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgaG9tZTogREFUQV9ESVIsXG4gICAgY2xpX3ZlcnNpb246IFBMVUdJTl9WRVJTSU9OLFxuICAgIGF1dGhvcml0YXRpdmUsXG4gICAgYWN0aXZlX3N1YnNjcmliZXJzOiB7XG4gICAgICB0b3RhbDogdG90YWxTdWJzY3JpYmVycyxcbiAgICAgIGJ1c3lfY2hhbm5lbHM6IGJ1c3lDaGFubmVscyxcbiAgICB9LFxuICAgIG90aGVyX2RhZW1vbnNfb25fbWFjaGluZTogb3RoZXJEYWVtb25zLFxuICAgIGNoYW5uZWxzX29uX2Rpc2s6IGNoYW5uZWxzT25EaXNrLFxuICAgIGhpbnRzLFxuICB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5mbygpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IGFwaTxSb290SW5mbz4ocG9ydCwgXCJHRVRcIiwgXCIvXCIpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG4vLyDilIDilIAgRGFlbW9uIGVudW1lcmF0aW9uICsgY2xhc3NpZmllciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqIEFsbCBncmFwZXZpbmUgZGFlbW9uLnRzIHBpZHMgdmlzaWJsZSBvbiB0aGlzIG1hY2hpbmUgKHZpYSBgcHNgKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxpc3RHcmFwZXZpbmVEYWVtb25QaWRzKCk6IFByb21pc2U8bnVtYmVyW10+IHtcbiAgY29uc3QgcGlkczogbnVtYmVyW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBjb25zdCBwcm9jID0gc3Bhd24oXCJwc1wiLCBbXCItZW9cIiwgXCJwaWQsY29tbWFuZFwiXSwge1xuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpZ25vcmVcIl0sXG4gICAgfSk7XG4gICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgIHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGIpID0+IGNodW5rcy5wdXNoKGIgYXMgQnVmZmVyKSk7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUpID0+IHByb2Mub24oXCJleGl0XCIsICgpID0+IHJlc29sdmUoKSkpO1xuICAgIGNvbnN0IG91dCA9IEJ1ZmZlci5jb25jYXQoY2h1bmtzKS50b1N0cmluZyhcInV0Zi04XCIpO1xuICAgIGZvciAoY29uc3QgbGluZSBvZiBvdXQuc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgIGlmICghbGluZS5pbmNsdWRlcyhcImRhZW1vbi50c1wiKSkgY29udGludWU7XG4gICAgICBpZiAoIWxpbmUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhcImdyYXBldmluZVwiKSkgY29udGludWU7XG4gICAgICAvLyBUaGUgcGlkIGdyb3VwIGlzIG1hbmRhdG9yeTsgYW4gdW5tYXRjaGVkIGxpbmUgaXMgc2tpcHBlZCwgYXMgYmVmb3JlLlxuICAgICAgY29uc3QgZGlnaXRzID0gbGluZS5tYXRjaCgvXlxccyooXFxkKylcXHMrLyk/LlsxXTtcbiAgICAgIGlmIChkaWdpdHMgPT09IHVuZGVmaW5lZCkgY29udGludWU7XG4gICAgICBjb25zdCBwaWQgPSBwYXJzZUludChkaWdpdHMsIDEwKTtcbiAgICAgIGlmIChwaWQpIHBpZHMucHVzaChwaWQpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IHJldHVybiBlbXB0eVxuICB9XG4gIHJldHVybiBwaWRzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsc29mTGlzdGVuUG9ydChwaWQ6IG51bWJlcik6IFByb21pc2U8bnVtYmVyIHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcImxzb2ZcIiwgW1wiLWFpVENQXCIsIFwiLXNUQ1A6TElTVEVOXCIsIFwiLXBcIiwgU3RyaW5nKHBpZCksIFwiLVBcIiwgXCItblwiXSwge1xuICAgICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpZ25vcmVcIl0sXG4gICAgfSk7XG4gICAgY29uc3QgY2h1bmtzOiBCdWZmZXJbXSA9IFtdO1xuICAgIHByb2Muc3Rkb3V0Py5vbihcImRhdGFcIiwgKGIpID0+IGNodW5rcy5wdXNoKGIgYXMgQnVmZmVyKSk7XG4gICAgYXdhaXQgbmV3IFByb21pc2U8dm9pZD4oKHIpID0+IHByb2Mub24oXCJleGl0XCIsICgpID0+IHIoKSkpO1xuICAgIC8vIFRoZSBwb3J0IGdyb3VwIGlzIG1hbmRhdG9yeTsgbm8gbWF0Y2ggaXMgdGhpcyBmdW5jdGlvbidzIG93biBgbnVsbGAuXG4gICAgY29uc3QgZGlnaXRzID0gQnVmZmVyLmNvbmNhdChjaHVua3MpXG4gICAgICAudG9TdHJpbmcoXCJ1dGYtOFwiKVxuICAgICAgLm1hdGNoKC8xMjdcXC4wXFwuMFxcLjE6KFxcZCspLyk/LlsxXTtcbiAgICByZXR1cm4gZGlnaXRzID09PSB1bmRlZmluZWQgPyBudWxsIDogcGFyc2VJbnQoZGlnaXRzLCAxMCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmV4cG9ydCB0eXBlIERhZW1vblN0YXR1cyA9IFwiYXV0aG9yaXRhdGl2ZVwiIHwgXCJvcnBoYW5cIiB8IFwidW5yZXNwb25zaXZlXCIgfCBcInVua25vd25cIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsYXNzaWZ5RGFlbW9uKHBpZDogbnVtYmVyKTogUHJvbWlzZTx7XG4gIHBpZDogbnVtYmVyO1xuICBwb3J0OiBudW1iZXIgfCBudWxsO1xuICBob21lPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nIHwgbnVsbDtcbiAgc3RhdHVzOiBEYWVtb25TdGF0dXM7XG4gIHJlYXBhYmxlOiBib29sZWFuO1xufT4ge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgbHNvZkxpc3RlblBvcnQocGlkKTtcbiAgaWYgKCFwb3J0KSByZXR1cm4geyBwaWQsIHBvcnQ6IG51bGwsIHN0YXR1czogXCJ1bmtub3duXCIsIHJlYXBhYmxlOiBmYWxzZSB9O1xuICBsZXQgaW5mbzogUm9vdEluZm8gfCBudWxsID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg4MDApLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIGluZm8gPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUm9vdEluZm87XG4gIH0gY2F0Y2gge31cbiAgaWYgKCFpbmZvKSByZXR1cm4geyBwaWQsIHBvcnQsIHN0YXR1czogXCJ1bnJlc3BvbnNpdmVcIiwgcmVhcGFibGU6IGZhbHNlIH07IC8vIHJlYXAgb25seSB3aXRoIC0tZm9yY2UgKGhhbmRsZWQgaW4gY21kUmVhcClcbiAgY29uc3QgaG9tZSA9IGluZm8uZGF0YV9kaXIgYXMgc3RyaW5nO1xuICBsZXQgb3ducyA9IGZhbHNlO1xuICB0cnkge1xuICAgIGNvbnN0IG9wID0gcmVhZEZpbGVTeW5jKGpvaW4oaG9tZSwgXCJkYWVtb24ucG9ydFwiKSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgY29uc3Qgb2kgPSByZWFkRmlsZVN5bmMoam9pbihob21lLCBcImRhZW1vbi5waWRcIiksIFwidXRmLThcIikudHJpbSgpO1xuICAgIG93bnMgPSBvcCA9PT0gU3RyaW5nKHBvcnQpICYmIG9pID09PSBTdHJpbmcocGlkKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4gb3duc1xuICAgID8ge1xuICAgICAgICBwaWQsXG4gICAgICAgIHBvcnQsXG4gICAgICAgIGhvbWUsXG4gICAgICAgIHZlcnNpb246IGluZm8udmVyc2lvbiA/PyBudWxsLFxuICAgICAgICBzdGF0dXM6IFwiYXV0aG9yaXRhdGl2ZVwiLFxuICAgICAgICByZWFwYWJsZTogZmFsc2UsXG4gICAgICB9XG4gICAgOiB7XG4gICAgICAgIHBpZCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgaG9tZSxcbiAgICAgICAgdmVyc2lvbjogaW5mby52ZXJzaW9uID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogXCJvcnBoYW5cIixcbiAgICAgICAgcmVhcGFibGU6IHRydWUsXG4gICAgICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRSZWFwKG9wdHM6IHsgZm9yY2U/OiBib29sZWFuOyBkcnlSdW4/OiBib29sZWFuIH0pIHtcbiAgY29uc3Qgc2VsZlBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpOyAvLyBjdXJyZW50IEhPTUUgYXV0aG9yaXRhdGl2ZSAobmV2ZXIgcmVhcClcbiAgbGV0IHNlbGZQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBpZiAoc2VsZlBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgc2VsZlBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KHNlbGZQb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICAgIH0gY2F0Y2gge31cbiAgfVxuICBjb25zdCBwaWRzID0gYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTtcbiAgY29uc3Qga2VwdDogdW5rbm93bltdID0gW10sXG4gICAgcmVhcGVkOiB1bmtub3duW10gPSBbXSxcbiAgICBza2lwcGVkOiB1bmtub3duW10gPSBbXTtcbiAgZm9yIChjb25zdCBwaWQgb2YgcGlkcykge1xuICAgIGNvbnN0IGMgPSBhd2FpdCBjbGFzc2lmeURhZW1vbihwaWQpO1xuICAgIGNvbnN0IGlzU2VsZiA9IHBpZCA9PT0gc2VsZlBpZDtcbiAgICBjb25zdCBzaG91bGRSZWFwID1cbiAgICAgICFpc1NlbGYgJiYgKGMucmVhcGFibGUgfHwgKGMuc3RhdHVzID09PSBcInVucmVzcG9uc2l2ZVwiICYmIG9wdHMuZm9yY2UgPT09IHRydWUpKTtcbiAgICBpZiAoIXNob3VsZFJlYXApIHtcbiAgICAgIGtlcHQucHVzaChjKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAob3B0cy5kcnlSdW4pIHtcbiAgICAgIHNraXBwZWQucHVzaCh7IC4uLmMsIG5vdGU6IFwiZHJ5LXJ1blwiIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBwcm9jZXNzLmtpbGwocGlkLCBcIlNJR1RFUk1cIik7XG4gICAgICByZWFwZWQucHVzaChjKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHNraXBwZWQucHVzaCh7IC4uLmMsIG5vdGU6IFwia2lsbCBmYWlsZWRcIiB9KTtcbiAgICB9XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRyeV9ydW46ICEhb3B0cy5kcnlSdW4sIGtlcHQsIHJlYXBlZCwgc2tpcHBlZCB9KTtcbn1cblxuLy8gKEJPT0xFQU5fRkxBR1Mgd2FzIGhlcmUuIEl0IGxpc3RlZCB3aGljaCBmbGFncyB0YWtlIG5vIHZhbHVlIOKAlCBoYWxmIGFcbi8vIHJlZ2lzdHJ5LCBjb25zdWx0ZWQgYnkgdGhlIGhhbmQtcm9sbGVkIHBhcnNlci4gSXRzIDEzIGVudHJpZXMgbm93IGxpdmUgaW5cbi8vIENMSV9PUFRJT05TIGJlbG93IGFzIGB7dHlwZTpcImJvb2xlYW5cIn1gLCB2ZXJpZmllZCAxMy1mb3ItMTMgYWdhaW5zdCB0aG90aCdzXG4vLyBpbmRlcGVuZGVudGx5LWRlcml2ZWQgYXJ0aWZhY3QgYmVmb3JlIHRoZSBtb3ZlLiBEZWxldGVkIHJhdGhlciB0aGFuIGxlZnRcbi8vIGJlc2lkZSBpdHMgcmVwbGFjZW1lbnQ6IGEgc2Vjb25kIHNvdXJjZSBvZiB0cnV0aCBmb3IgdGhlIHNhbWUgZmFjdCBpcyB0aGVcbi8vIGRyaWZ0IGJ1ZyB0aGlzIGxhbmUgZXhpc3RzIHRvIHJlbW92ZSwgYW5kIGl0IHdvdWxkIG5vIGxvbmdlciBiZSBjb25zdWx0ZWRcbi8vIGJ5IGFueXRoaW5nLilcblxuLy8gU2lnbmF0dXJlIG9mIGEgaGVyZWRvYyBmdW1ibGU6IGEgbGluZSB0aGF0IGlzIChvciBiZWdpbnMgd2l0aCkgYVxuLy8gYGJ1biDigKYgY2xpLnRzIOKApiBzZW5kYCBpbnZvY2F0aW9uLiBXaGVuIGEgYHNlbmQgLS1zdGRpbiA8PEVPRmAgaXMgYm90Y2hlZCwgdGhlXG4vLyBzaGVsbCBwaXBlcyB0aGUgbGl0ZXJhbCBjb21tYW5kIGxpbmUgaW4gYXMgdGhlIGJvZHksIHdoaWNoIHRoZW4gZ2V0cyBwb3N0ZWQg4oCUXG4vLyBjb3JydXB0aW5nIHRoZSBjaGFubmVsIHdpdGggYGJ1biAv4oCmL2NsaS50cyBzZW5kIDxjaGFubmVsPiAtLWFzIOKApiA8dGV4dD5gLlxuLy8gV2UgcmVmdXNlIHRvIHBvc3Qgc3VjaCBhIGJvZHkgdW5sZXNzIC0tZm9yY2UgaXMgcGFzc2VkLlxuY29uc3QgTEVBS0VEX1NFTkRfUkUgPSAvKD86XnxcXG4pWyBcXHRdKmJ1blxcYlteXFxuXSpcXGJjbGlcXC50c1xcYlteXFxuXSpcXGIoPzpzZW5kfGFubm91bmNlKVxcYi87XG5mdW5jdGlvbiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gTEVBS0VEX1NFTkRfUkUudGVzdCh0ZXh0KTtcbn1cblxuLy8gU2hlbGwtbWV0YWNoYXJhY3RlciBmb290Z3VuICgjNjApOiBhIGJvZHkgcGFzc2VkIGFzIGFuIElOTElORSBwb3NpdGlvbmFsIGFyZ1xuLy8gaXMgZXhwb3NlZCB0byB0aGUgY2FsbGVyJ3Mgc2hlbGwsIHdoaWNoIGNvbW1hbmQtc3Vic3RpdHV0ZXMgYmFja3RpY2tzIC9cbi8vIGAkKC4uLilgIC8gYCR7Li4ufWAgQkVGT1JFIGdyYXBldmluZSBzZWVzIGl0IOKAlCBjb3JydXB0aW5nIG9yIHBhcnRpYWxseVxuLy8gZXhlY3V0aW5nIGNvZGUtYmVhcmluZyBtZXNzYWdlcy4gVGhlIENMSSBjYW4ndCB1bi1zdWJzdGl0dXRlIHdoYXQgdGhlIHNoZWxsXG4vLyBhbHJlYWR5IGF0ZTsgdGhlIGhvbmVzdCBmaXggaXMgdG8gc3RlZXIgY2FsbGVycyB0byB0aGUgc2hlbGwtZnJlZSBwYXRoc1xuLy8gKC0tYm9keS1maWxlIC8gLS1zdGRpbiAvIGRlZmF1bHQtc3RkaW4pLiBXaGVuIG1ldGFjaGFyYWN0ZXJzIFNVUlZJVkUgaW50byBhblxuLy8gaW5saW5lIGJvZHkgKGUuZy4gdGhlIGNhbGxlciBoYXBwZW5lZCB0byBzaW5nbGUtcXVvdGUpLCB0aGV5J3JlIGludGFjdCB0aGlzXG4vLyB0aW1lIOKAlCBidXQgdGhlIHBhdHRlcm4gaXMgYSBsYXRlbnQgZm9vdGd1biwgc28gd2Ugd2FybiAobmV2ZXIgYmxvY2s6IHRoZVxuLy8gbWVzc2FnZSBpcyBmaW5lIGFzIHJlY2VpdmVkKS4gQWJzZW50LW1ldGFjaGFyIGlubGluZSBib2RpZXMgYXJlIGVpdGhlciBwbGFpblxuLy8gdGV4dCAoc2FmZSkgb3IgYWxyZWFkeS1zdWJzdGl0dXRlZCAodW5kZXRlY3RhYmxlKSDigJQgc28gd2Ugb25seSB3YXJuIG9uIHRoZVxuLy8gZGV0ZWN0YWJsZSByaXNreSBwYXR0ZXJuLlxuY29uc3QgU0hFTExfTUVUQUNIQVJfUkUgPSAvYHxcXCRcXCh8XFwkXFx7LztcbmV4cG9ydCBmdW5jdGlvbiBsb29rc1NoZWxsUmlza3kodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBTSEVMTF9NRVRBQ0hBUl9SRS50ZXN0KHRleHQpO1xufVxuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gZ3JhcGV2aW5lIGFscmVhZHkgaGFkIEhBTEYgYSByZWdpc3RyeTogYEJPT0xFQU5fRkxBR1NgIGFib3ZlIHRvbGQgdGhlIHBhcnNlclxuLy8gd2hpY2ggZmxhZ3MgdGFrZSBubyB2YWx1ZS4gV2hhdCBpdCBoYWQgbm8gbm90aW9uIG9mIHdhcyB3aGljaCBmbGFncyBFWElTVCwgc29cbi8vIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZSBwcm9zZVxuLy8gY29udGFpbmluZyBhIGAtLXdvcmRgIHdhcyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLlxuLy9cbi8vIOKaoCBncmFwZXZpbmUgaXMgdGhlIE9VVExJRVIgb2YgdGhlIHNpeCwgYW5kIGl0IGlzIHdvcnRoIHNheWluZyB3aHkgc28gbm9ib2R5XG4vLyByZWFkcyBpdCBhcyBtZXJlbHkgYmVoaW5kOiBpdCB0eXBlcyBpdHMgdmFsdWUgZmxhZ3Mgd2l0aCBhIENBU1Rcbi8vIChgZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkYCkgd2hlcmUgdGhlIG90aGVyIGVudHJ5IHBvaW50cyB1c2UgYVxuLy8gYHR5cGVvZmAgZ3VhcmQuIEEgY2FzdCBpcyBhIGNsYWltIHdpdGggTk8gUlVOVElNRSBDSEVDSywgc28gZ3JhcGV2aW5lIGNhcnJpZWRcbi8vIGEgY2xhc3Mgb2YgbGF0ZW50IHR5cGUtbGllIHRoZSBvdGhlcnMgd2VyZSBndWFyZGVkIGFnYWluc3Qg4oCUIGFuZCBiYXJlIHZhbHVlXG4vLyBmbGFncyBwcm9kdWNlZCBzaWxlbnQgd3JvbmcgdmFsdWVzIHJhdGhlciB0aGFuIGVycm9yczpcbi8vXG4vLyAgIC0tbGFzdCAgIGJhcmUgIC0+ICBwYXJzZUludCh0cnVlLCAxMCkgIC0+ICBOYU4sIHNpbGVudGx5XG4vLyAgIC0tdG9waWMgIGJhcmUgIC0+ICBgdHJ1ZWAgaW4gYSBmaWVsZCBERUNMQVJFRCBgc3RyaW5nYFxuLy9cbi8vIGBzdHJpY3Q6IHRydWVgIHR1cm5zIGVhY2ggb2YgdGhvc2UgZnJvbSBhIHNpbGVudCB3cm9uZyB2YWx1ZSBpbnRvIGFcbi8vIGNhbGxlci1mYWNpbmcgZXJyb3IsIHdoaWNoIGlzIHRoZSBsYW5lJ3Mgd2hvbGUgcHVycG9zZSBhbmQgdGhlIGxhcmdlc3Rcbi8vIGJlaGF2aW91ciBkZWx0YSBvZiB0aGUgc2l4IGVudHJ5IHBvaW50cy5cbi8vXG4vLyBUaGUgYm9vbGVhbiBzZXQgYmVsb3cgaXMgQk9PTEVBTl9GTEFHUywgdW5jaGFuZ2VkIOKAlCBleHRyYWN0ZWQgZnJvbSB0aGlzIGZpbGVcbi8vIGFuZCBkaWZmZWQgYWdhaW5zdCB0aG90aCdzIGluZGVwZW5kZW50bHktZGVyaXZlZCBhcnRpZmFjdDogMTMgZm9yIDEzLCBleGFjdCxcbi8vIHplcm8gZGl2ZXJnZW5jZSBpbiBlaXRoZXIgZGlyZWN0aW9uLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNoYW5uZWxzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGhvbGQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImluLXJlcGx5LXRvXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYXN0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbWF4OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRvcGljOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwiZHJ5LXJ1blwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGZyZXNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwiZnJvbS1zdGFydFwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGh1bWFuOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGxpdGVyYWw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbHVyazogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBxdWlldDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB0ZXh0OiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHZlcmJvc2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgeWVzOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG50eXBlIEZsYWdOYW1lID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuXG4vLyBJZGVudGl0eSBpcyBjb250cmFjdHVhbGx5IEdMT0JBTDogU0tJTEwubWQgdGVsbHMgYWdlbnRzIHRvIHBhc3MgLS1hcy8tLWZyb21cbi8vIG9uIEVWRVJZIHZlcmIgKGEgZnJlc2ggc2hlbGwgcGVyIGNvbW1hbmQgbWVhbnMgR1JBUEVWSU5FX0ZST00gbmV2ZXJcbi8vIHBlcnNpc3RzKSwgc28gZXZlcnkgY29tbWFuZCBhY2NlcHRzIGJvdGgg4oCUIGV2ZW4gd2hlcmUgYSB2ZXJiIGhhcyBubyB1c2UgZm9yXG4vLyBpZGVudGl0eSwgYSBjYWxsZXIgZm9sbG93aW5nIG91ciBvd24gZG9jcyBtdXN0IG5vdCBiZSByZWplY3RlZCBmb3Igb2JleWluZ1xuLy8gdGhlbS4gT24gYGdyZXBgLCBgLS1mcm9tYCBpcyBhbiBhdXRob3IgRklMVEVSIHJhdGhlciB0aGFuIGlkZW50aXR5OiBkaWZmZXJlbnRcbi8vIHNlbWFudGljcywgc2FtZSBhY2NlcHRhbmNlLlxuY29uc3QgR0xPQkFMX0ZMQUdTOiBGbGFnTmFtZVtdID0gW1wiYXNcIiwgXCJmcm9tXCJdO1xuXG4vLyBUSEUgQ09NTUFORCBUQUJMRSwgQVMgQSBTVFJVQ1RVUkUg4oCUIHRoZSBwYXJzZXIsIHRoZSBkaXNwYXRjaGVyLCB0aGUgc2NoZW1hXG4vLyBlbWl0dGVyIGFuZCB0aGUgcm9vdCByZWplY3Rpb24gYWxsIHdhbGsgVEhJUy4gSXQgcmVwbGFjZWQgYSBiYXJlIGBzd2l0Y2hgLFxuLy8gd2hpY2ggb25seSB0aGUgZGlzcGF0Y2hlciBjb3VsZCB3YWxrOiBhIHNjaGVtYSBlbWl0dGVkIGZyb20gYW55dGhpbmcgb3RoZXJcbi8vIHRoYW4gdGhlIHN0cnVjdHVyZSB0aGF0IHJvdXRlcyB0aGUgYmVoYXZpb3VyIGlzIGEgZG9jdW1lbnQgdGhhdCBsaWVzIGFzIHNvb25cbi8vIGFzIGFueW9uZSBlZGl0cyB0aGUgb3RoZXIgc2lkZSAoYWNjIFNUQU5EQVJELm1kIFBhcnQgMSDCpzI7IG91ciBvd24gIzgxL0Q0XG4vLyBsYW5lIGxlYXJuZWQgdGhlIHNhbWUgbGVzc29uIG9uZSBhbHRpdHVkZSBkb3duIHdpdGggQk9PTEVBTl9GTEFHUykuXG4vL1xuLy8gYGZsYWdzYCBpcyB0aGUgdmVyYidzIE9XTiBhY2NlcHRlZCBzZXQgKEdMT0JBTF9GTEFHUyBhcmUgbWVyZ2VkIGluIGJ5IHRoZVxuLy8ga2l0IHJlZ2lzdHJ5LCBgZ2xvYmFsRmxhZ3NgKS4gQSBmbGFnIG5vdCBsaXN0ZWQgaGVyZSBpcyBSRUpFQ1RFRCBmb3IgdGhpcyB2ZXJiIHdpdGggdGhlXG4vLyB2ZXJiJ3Mgb3duIHNldCBlbnVtZXJhdGVkIOKAlCBhY2NlcHRlZC1hbmQtaWdub3JlZCBpcyB0aGUgZGlzZWFzZSB0aGlzIHRhYmxlXG4vLyBleGlzdHMgdG8gY3VyZSAoYWNjIERULTE6IGFudGhpbGwgYWNjZXB0aW5nIGEgcm9vdCBgLS1mb3JtYXRgIGl0IHNpbGVudGx5XG4vLyBkaXNjYXJkczsgZ3JhcGV2aW5lIGFjY2VwdGluZyBgc2VuZCAtLWRyeS1ydW5gIGFuZCBkb2luZyBub3RoaW5nIHdhcyB0aGVcbi8vIHNhbWUgZXZlbnQgd2l0aCBhIGRpZmZlcmVudCBzcGVsbGluZykuXG4vKipcbiAqIEEgcm93IGFzIGdyYXBldmluZSB3cml0ZXMgaXQ6IHRoZSBraXQncyBgQ29tbWFuZFNwZWNgIHdpdGggdGhlIGhhbmRsZXIgdGFraW5nXG4gKiBgKHBvc2l0aW9uYWwsIGZsYWdzKWAsIGFkYXB0ZWQgdG8gdGhlIGtpdCdzIGBydW4oaW52KWAgYnkgYG9uYCBiZWxvdy4gTm9cbiAqIGBkZXNjcmliZWA6IGdyYXBldmluZSdzIGhlbHAgaXMgaGFuZC13cml0dGVuIChgaGVscFRleHRgKSwgc28gdGhlIHJlbmRlcmVkXG4gKiBoZWxwIHRoYXQgcmVhZHMgaXQgaXMgbmV2ZXIgc2hvd24uXG4gKlxuICog4pqgIFRIRSBIQU5ETEVSIE1BWSBSRVRVUk4gQU4gRVhJVCBDT0RFLCBBTkQgRVhBQ1RMWSBPTkUgVkVSQiBET0VTLiBgdGFpbGAgcnVuc1xuICogdGhlIHNoYXJlZCBjbGllbnQgKGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2ApLCB3aGljaCBSRVRVUk5TIGEgY29kZSByYXRoZXJcbiAqIHRoYW4gZW5kaW5nIHRoZSBwcm9jZXNzIGZyb20gaW5zaWRlIHRocmVlIG5lc3RlZCBsb29wcyDigJQgc28gdGhlIGNvZGUgaGFzIHRvXG4gKiByZWFjaCBgbWFpbmAsIGFuZCB0aGlzIGlzIHRoZSBzZWFtIGl0IGNyb3NzZXMuIEFueXRoaW5nIHRoYXQgaXMgbm90IGEgbnVtYmVyXG4gKiBtZWFucyAwLCB3aGljaCBpcyB3aGF0IHRoZSBvdGhlciB0d2VudHktb2RkIHZlcmJzIHJldHVybi4gVHlwZWQgYHVua25vd25gXG4gKiByYXRoZXIgdGhhbiBhIHVuaW9uIHdpdGggYHZvaWRgOiBldmVyeSBgYXN5bmNgIHZlcmIgdGhhdCBlbmRzIHdpdGhvdXQgYVxuICogYHJldHVybmAgaXMgYFByb21pc2U8dm9pZD5gLlxuICovXG50eXBlIFJvdyA9IE9taXQ8Q29tbWFuZFNwZWM8RmxhZ05hbWU+LCBcInJ1blwiIHwgXCJkZXNjcmliZVwiIHwgXCJyZWplY3RIaW50XCI+ICYge1xuICBydW46IChwb3NpdGlvbmFsOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzKSA9PiB1bmtub3duO1xufTtcblxuLyoqIGB0YWlsIC0tc2luY2VgIHRocm91Z2ggdGhlIGtpdCdzIG9uZSByZWFkZXIgKGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsXG4gKiAgYHJlYWRTaW5jZWApOiBhbiBpZCBvZiAwIG9yIG1vcmU7IGFuIGVwb2NoIGJvb2ttYXJrIHByaW50ZWQgYnkgYW5vdGhlclxuICogIHNwZWxsJ3MgaGFuZG9mZiBsaW5lIGlzIHJlZnVzZWQgd2l0aCB0aGUgYWNjZXB0ZWQgZm9ybXMgbmFtZWQuICovXG5mdW5jdGlvbiBzaW5jZU9yRGllKHRva2VuOiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCByID0gcmVhZFNpbmNlKHRva2VuLCB7IGVwb2NoOiBmYWxzZSwgbWluOiAwIH0pO1xuICAvLyBUaGUgYHRhaWw6YCBwcmVmaXggZXZlcnkgb3RoZXIgZ3JhcGV2aW5lIGZsYWcgcmVmdXNhbCBjYXJyaWVzLlxuICBpZiAoIXIub2spIGRpZShgdGFpbDogJHtyLm1lc3NhZ2V9YCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHIuc2luY2U7XG59XG5cbi8vIEEgZGVjbGFyZWQgdmFsdWUgZmxhZyB0aGF0IGNhcnJpZXMgYSBudW1iZXIgbXVzdCBSRUpFQ1QgYSBub24tbnVtYmVyIGFzIGFcbi8vIHVzYWdlIGVycm9yIChleGl0IDIpLCBub3QgY3Jhc2ggb24gaXQgZG93bnN0cmVhbSDigJQgYHNjaGVtYWAgcHVibGlzaGVzIHRoZVxuLy8gZmxhZyBhcyB2YWxpZCwgc28gdGhlIHBhcnNlIGJvdW5kYXJ5IGlzIHdoZXJlIGEgYmFkIHZhbHVlIGdldHMgaXRzXG4vLyBjYWxsZXItZmFjaW5nIGFuc3dlci4gKGB3YWl0IC0tdGltZW91dCBub3RhbnVtYmVyYCB1c2VkIHRvIHRocm93IGFuXG4vLyB1bmhhbmRsZWQgUmFuZ2VFcnJvciBhdCBleGl0IDEsIHN0YWNrIHRyYWNlIGFuZCBhbGwuKVxuZnVuY3Rpb24gbnVtZXJpY0ZsYWcodmVyYjogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIHJhdzogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbGxiYWNrO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKG4pIHx8IG4gPCAwKVxuICAgIGRpZShgJHt2ZXJifTogLS0ke25hbWV9IGV4cGVjdHMgYSBub24tbmVnYXRpdmUgbnVtYmVyLCBnb3QgJHtKU09OLnN0cmluZ2lmeShTdHJpbmcocmF3KSl9YCk7XG4gIHJldHVybiBuO1xufVxuXG4vLyBCb2R5IHJlc29sdXRpb24gc2hhcmVkIGJ5IHNlbmQvYW5ub3VuY2Ug4oCUIGZpcnN0IG1hdGNoIHdpbnM6IC0tYm9keS1maWxlLFxuLy8gLS1zdGRpbiwgaW5saW5lIHBvc2l0aW9uYWxzLCBkZWZhdWx0LXN0ZGluIHdoZW4gcGlwZWQuIFNlZSB0aGUgcGVyLXZlcmJcbi8vIGNvbW1lbnRzIGF0IHRoZSBvcmlnaW5hbCBzaXRlcyAoVjEuNi8jNjApOyBiZWhhdmlvdXIgdW5jaGFuZ2VkLlxuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUJvZHkoXG4gIHZlcmI6IFwic2VuZFwiIHwgXCJhbm5vdW5jZVwiLFxuICBpbmxpbmU6IHN0cmluZ1tdLFxuICBmbGFnczogRmxhZ3MsXG4pOiBQcm9taXNlPHsgdGV4dDogc3RyaW5nOyBmcm9tSW5saW5lOiBib29sZWFuIH0+IHtcbiAgaWYgKGZsYWdzW1wiYm9keS1maWxlXCJdKSB7XG4gICAgY29uc3QgcGF0aCA9IGZsYWdzW1wiYm9keS1maWxlXCJdIGFzIHN0cmluZztcbiAgICBjb25zdCBmaWxlID0gQnVuLmZpbGUocGF0aCk7XG4gICAgaWYgKCEoYXdhaXQgZmlsZS5leGlzdHMoKSkpIGRpZShgJHt2ZXJifTogLS1ib2R5LWZpbGUgbm90IGZvdW5kOiAke3BhdGh9YCwgXCJub3RfZm91bmRcIik7XG4gICAgcmV0dXJuIHsgdGV4dDogKGF3YWl0IGZpbGUudGV4dCgpKS5yZXBsYWNlKC9cXG4kLywgXCJcIiksIGZyb21JbmxpbmU6IGZhbHNlIH07XG4gIH1cbiAgaWYgKGZsYWdzLnN0ZGluIHx8IChpbmxpbmUubGVuZ3RoID09PSAwICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgIGNvbnN0IGJ1ZjogQnVmZmVyW10gPSBbXTtcbiAgICBmb3IgYXdhaXQgKGNvbnN0IGNodW5rIG9mIHByb2Nlc3Muc3RkaW4pIGJ1Zi5wdXNoKGNodW5rIGFzIEJ1ZmZlcik7XG4gICAgcmV0dXJuIHtcbiAgICAgIHRleHQ6IEJ1ZmZlci5jb25jYXQoYnVmKS50b1N0cmluZyhcInV0Zi04XCIpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSxcbiAgICAgIGZyb21JbmxpbmU6IGZhbHNlLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgdGV4dDogaW5saW5lLmpvaW4oXCIgXCIpLCBmcm9tSW5saW5lOiB0cnVlIH07XG59XG5cbi8vIFRoZSB0d28gYm9keSBndWFyZHMgc2hhcmVkIGJ5IHNlbmQvYW5ub3VuY2U6IHJlZnVzZSBhIGxlYWtlZCBpbnZvY2F0aW9uXG4vLyAoZnVtYmxlZCBoZXJlZG9jKSB1bmxlc3MgLS1mb3JjZSwgYW5kIHdhcm4gb24gc2hlbGwgbWV0YWNoYXJhY3RlcnMgdGhhdFxuLy8gc3Vydml2ZWQgYW4gaW5saW5lIGJvZHkgKCM2MCDigJQgd2FybiwgbmV2ZXIgYmxvY2spLlxuZnVuY3Rpb24gZ3VhcmRCb2R5KHZlcmI6IFwic2VuZFwiIHwgXCJhbm5vdW5jZVwiLCB0ZXh0OiBzdHJpbmcsIGZyb21JbmxpbmU6IGJvb2xlYW4sIGZvcmNlOiBib29sZWFuKSB7XG4gIGlmICghZm9yY2UgJiYgbG9va3NMaWtlTGVha2VkU2VuZCh0ZXh0KSkge1xuICAgIGRpZShcbiAgICAgIGAke3ZlcmJ9OiB0aGF0IGJvZHkgbG9va3MgbGlrZSBhIGxlYWtlZCBncmFwZXZpbmUgaW52b2NhdGlvbiAoYSBmdW1ibGVkIGAgK1xuICAgICAgICBcImhlcmVkb2M/KS4gTm90aGluZyB3YXMgc2VudC4gUGlwZSB0aGUgcmVhbCBib2R5IHZpYSAtLXN0ZGluIG9yIFwiICtcbiAgICAgICAgXCItLWJvZHktZmlsZSA8cGF0aD4sIG9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cIixcbiAgICApO1xuICB9XG4gIGlmIChmcm9tSW5saW5lICYmIGxvb2tzU2hlbGxSaXNreSh0ZXh0KSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgXCIjIOKaoCBpbmxpbmUgYm9keSBjb250YWlucyBzaGVsbCBtZXRhY2hhcmFjdGVycyAoYmFja3RpY2ssICQoKSwgY3VybHktYnJhY2UgdmFycykuIFwiICtcbiAgICAgICAgXCJJdCB3YXMgc2VudCBhcy1pcywgYnV0IHRoZSBzaGVsbCBjYW4gY29tbWFuZC1zdWJzdGl0dXRlIHRoZXNlIGJlZm9yZSBcIiArXG4gICAgICAgIFwiZ3JhcGV2aW5lIHNlZXMgdGhlbSDigJQgdXNlIC0tYm9keS1maWxlIG9yIC0tc3RkaW4gZm9yIGNvZGUtYmVhcmluZyBtZXNzYWdlcy5cXG5cIixcbiAgICApO1xuICB9XG59XG5cbi8qKlxuICog4puUIFJFR0lTVEVSIEExIOKAlCBgY2hvaWNlc2AgSVMgYEdMT0JBTF9GTEFHU2AsIFRIRSBTRVQgYHJlc29sdmVBbGlhc2AgUkVBRFMuXG4gKiBUaGlzIGlzIGEgRElTSlVOQ1RJT04gKGVpdGhlciBmbGFnIHNhdGlzZmllcyBpdCksIHNvIHRoZSBjYWxsZXIgaGFzIHRvIHBpY2ssXG4gKiBhbmQgaXQgaXMgdGhlIG9uZSBpZGVudGl0eSByZWZ1c2FsIGZvdXIgdmVyYnMgc2hhcmUuIFRoZSBlbnYgdmFyIHN0YXlzIGluXG4gKiBgaGludGAgYW5kIGRlbGliZXJhdGVseSBOT1QgaW4gYGNob2ljZXNgOiBgY2hvaWNlc2AgZW51bWVyYXRlcyBDT01NQU5EXG4gKiBUT0tFTlMg4oCUIHdoYXQgd291bGQgaGF2ZSBiZWVuIGFjY2VwdGVkIElOIFRIRSBJTlZPQ0FUSU9OIOKAlCBhbmQgcHV0dGluZyBhblxuICogZW52aXJvbm1lbnQgbmFtZSBpbiB0aGUgc2FtZSBhcnJheSB3b3VsZCBnaXZlIGEgY2FsbGVyIGEgXCJjaG9pY2VcIiBpdCBjYW5ub3RcbiAqIHBhc3Mgb24gdGhlIGNvbW1hbmQgbGluZS5cbiAqL1xuY29uc3QgaWRlbnRpdHlSZXF1aXJlZCA9ICh2ZXJiOiBzdHJpbmcpOiBuZXZlciA9PlxuICBkaWUoYCR7dmVyYn06IGlkZW50aXR5IHJlcXVpcmVkYCwgXCJ1c2FnZVwiLCB7XG4gICAgaGludDogYHBhc3MgJHtHTE9CQUxfRkxBR1MubWFwKChmKSA9PiBgLS0ke2Z9YCkuam9pbihcIi9cIil9IDxhbGlhcz4sIG9yIHNldCBHUkFQRVZJTkVfRlJPTWAsXG4gICAgY2hvaWNlczogR0xPQkFMX0ZMQUdTLm1hcCgoZikgPT4gYC0tJHtmfWApLFxuICB9KTtcblxuLy8g4pqgIEVWRVJZIENPTU1BTkQgRlVOQ1RJT04gQkVMT1cgUkVGVVNFUyBBIE1JU1NJTkcgUE9TSVRJT05BTCBPTiBJVFMgT1dOIEZJUlNUXG4vLyBMSU5FIChhIHVzYWdlIHJlZnVzYWwgd2hlbiB0aGUgbmFtZSBpcyBmYWxzeSksIGFuZCBlYWNoIG5vdyBkZWNsYXJlcyB0aGF0IHBhcmFtZXRlclxuLy8gYHN0cmluZyB8IHVuZGVmaW5lZGAgc28gaXRzIHNpZ25hdHVyZSBzYXlzIHdoYXQgdGhhdCBsaW5lIGRvZXMgKHR5cGUtZGVidFxuLy8gVDM1KS4gQXJpdHkgZGlzcGF0Y2ggcmVmdXNlcyBhIG1pc3NpbmcgcmVxdWlyZWQgcG9zaXRpb25hbCBiZWZvcmUgYW55IG9mXG4vLyB0aGVtIHJ1bnMsIHNvIHRoZSBndWFyZHMgYXJlIHRoZSBzZWNvbmQgbGluZSBvZiBkZWZlbmNlLCBub3QgdGhlIGZpcnN0LlxuY29uc3QgUk9XUzogUm93W10gPSBbXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5cIixcbiAgICBmbGFnczogW1widG9waWNcIiwgXCJmcmVzaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRPcGVuKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgdG9waWM6IGZsYWdzLnRvcGljIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgZnJvbTogcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICAgZnJlc2g6IGZsYWdzLmZyZXNoID09PSB0cnVlLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidG9waWNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kVG9waWMoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIHBvc2l0aW9uYWwubGVuZ3RoID4gMSA/IHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIikgOiB1bmRlZmluZWQsXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncyksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxpc3RcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kTGlzdCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlbmRcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcInZlcmJvc2VcIiwgXCJmb3JjZVwiLCBcImluLXJlcGx5LXRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IG5hbWUgPSBwb3NpdGlvbmFsWzBdO1xuICAgICAgY29uc3QgZnJvbSA9IHJlc29sdmVBbGlhcyhmbGFncyk7XG4gICAgICBjb25zdCB7IHRleHQsIGZyb21JbmxpbmUgfSA9IGF3YWl0IHJlc29sdmVCb2R5KFwic2VuZFwiLCBwb3NpdGlvbmFsLnNsaWNlKDEpLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJzZW5kXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwic2VuZFwiLCB0ZXh0LCBmcm9tSW5saW5lLCAhIWZsYWdzLmZvcmNlKTtcbiAgICAgIGF3YWl0IGNtZFNlbmQobmFtZSwgZnJvbSBhcyBzdHJpbmcsIHRleHQsIHtcbiAgICAgICAgcXVpZXQ6ICEhZmxhZ3MucXVpZXQsXG4gICAgICAgIHZlcmJvc2U6ICEhZmxhZ3MudmVyYm9zZSxcbiAgICAgICAgaW5SZXBseVRvOiBmbGFnc1tcImluLXJlcGx5LXRvXCJdXG4gICAgICAgICAgPyBudW1lcmljRmxhZyhcInNlbmRcIiwgXCJpbi1yZXBseS10b1wiLCBmbGFnc1tcImluLXJlcGx5LXRvXCJdLCAwKVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYW5ub3VuY2VcIixcbiAgICBmbGFnczogW1wiYm9keS1maWxlXCIsIFwic3RkaW5cIiwgXCJxdWlldFwiLCBcImZvcmNlXCIsIFwiY2hhbm5lbHNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJhbm5vdW5jZVwiLCBwb3NpdGlvbmFsLCBmbGFncyk7XG4gICAgICBpZiAoIWZyb20pIGlkZW50aXR5UmVxdWlyZWQoXCJhbm5vdW5jZVwiKTtcbiAgICAgIGd1YXJkQm9keShcImFubm91bmNlXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgY29uc3QgY2hhbm5lbHMgPSBmbGFncy5jaGFubmVsc1xuICAgICAgICA/IChmbGFncy5jaGFubmVscyBhcyBzdHJpbmcpXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKChjKSA9PiBjLnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBhd2FpdCBjbWRBbm5vdW5jZShmcm9tIGFzIHN0cmluZywgdGV4dCwgY2hhbm5lbHMsIHsgcXVpZXQ6ICEhZmxhZ3MucXVpZXQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHVsbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcInN0YXR1c1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwicHVsbFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGF3YWl0IGNtZFB1bGwocG9zaXRpb25hbFswXSwgc2luY2UsIHsgc3RhdHVzOiBmbGFncy5zdGF0dXMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRyaWFnZVwiLFxuICAgIGZsYWdzOiBbXCJodW1hblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUcmlhZ2UocG9zaXRpb25hbFswXSwgeyBodW1hbjogISFmbGFncy5odW1hbiB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgZmxhZ3M6IFtcInRleHRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBpZCA9IHBvc2l0aW9uYWxbMV0gPyBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCkgOiBOYU47XG4gICAgICBhd2FpdCBjbWRSZWFkKHBvc2l0aW9uYWxbMF0sIGlkLCB7IHRleHQ6ICEhZmxhZ3MudGV4dCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3YWl0XCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwidGltZW91dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBjb25zdCBzaW5jZSA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInNpbmNlXCIsIGZsYWdzLnNpbmNlLCAwKTtcbiAgICAgIGNvbnN0IHRpbWVvdXQgPSBudW1lcmljRmxhZyhcIndhaXRcIiwgXCJ0aW1lb3V0XCIsIGZsYWdzLnRpbWVvdXQsIDMwKTtcbiAgICAgIGF3YWl0IGNtZFdhaXQocG9zaXRpb25hbFswXSwgc2luY2UsIHRpbWVvdXQsIHJlc29sdmVBbGlhcyhmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndob1wiLFxuICAgIGZsYWdzOiBbXCJhbGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGlmIChmbGFncy5hbGwpIGF3YWl0IGNtZFdob0FsbCgpO1xuICAgICAgZWxzZSBhd2FpdCBjbWRXaG8ocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYWxpYXNcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQWxpYXMocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFpbFwiLFxuICAgIGZsYWdzOiBbXCJzaW5jZVwiLCBcImZyb20tc3RhcnRcIiwgXCJsYXN0XCIsIFwiaHVtYW5cIiwgXCJsdXJrXCIsIFwibWF4XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIHJldHVybiBhd2FpdCBjbWRUYWlsKHBvc2l0aW9uYWxbMF0sIHtcbiAgICAgICAgc2luY2U6IGZsYWdzLnNpbmNlICE9PSB1bmRlZmluZWQgPyBzaW5jZU9yRGllKFN0cmluZyhmbGFncy5zaW5jZSkpIDogdW5kZWZpbmVkLFxuICAgICAgICBmcm9tU3RhcnQ6ICEhZmxhZ3NbXCJmcm9tLXN0YXJ0XCJdLFxuICAgICAgICBsYXN0OiBmbGFncy5sYXN0ICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInRhaWxcIiwgXCJsYXN0XCIsIGZsYWdzLmxhc3QsIDApIDogdW5kZWZpbmVkLFxuICAgICAgICBhczogcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICAgaHVtYW46ICEhZmxhZ3MuaHVtYW4sXG4gICAgICAgIGx1cms6ICEhZmxhZ3MubHVyayxcbiAgICAgICAgbWF4OiByZXNvbHZlVGFpbE1heChmbGFncy5tYXgpLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JlcFwiLFxuICAgIGZsYWdzOiBbXCJsaXRlcmFsXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInBhdHRlcm5cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kR3JlcChwb3NpdGlvbmFsWzBdLCBwb3NpdGlvbmFsLnNsaWNlKDEpLmpvaW4oXCIgXCIpLCB7XG4gICAgICAgIGxpdGVyYWw6ICEhZmxhZ3MubGl0ZXJhbCxcbiAgICAgICAgZnJvbTogZmxhZ3MuZnJvbSBhcyBzdHJpbmcgfCB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZENsb3NlKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlc2V0XCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlc2V0KHBvc2l0aW9uYWxbMF0sIHsgZm9yY2U6IGZsYWdzLmZvcmNlID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1hcmtcIixcbiAgICBmbGFnczogW1wibm90ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImRpc3Bvc2l0aW9uXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE1hcmsoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIC8vIE5hTiBmb3IgYSBtaXNzaW5nIGlkLCBleGFjdGx5IHdoYXQgYHBhcnNlSW50KHVuZGVmaW5lZClgIGdhdmUg4oCUIGFuZFxuICAgICAgICAvLyBgY21kTWFya2AgcmVmdXNlcyBhIG5vbi1maW5pdGUgaWQgb24gaXRzIGZpcnN0IGxpbmUuXG4gICAgICAgIHBvc2l0aW9uYWxbMV0gPT09IHVuZGVmaW5lZCA/IE51bWJlci5OYU4gOiBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIHBvc2l0aW9uYWwuc2xpY2UoMikuam9pbihcIiBcIiksXG4gICAgICAgIHJlc29sdmVBbGlhcyhmbGFncykgPz8gaWRlbnRpdHlSZXF1aXJlZChcIm1hcmtcIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRNYXJrKFxuICAgICAgICBwb3NpdGlvbmFsWzBdLFxuICAgICAgICAvLyBOYU4gZm9yIGEgbWlzc2luZyBpZCwgZXhhY3RseSB3aGF0IGBwYXJzZUludCh1bmRlZmluZWQpYCBnYXZlIOKAlCBhbmRcbiAgICAgICAgLy8gYGNtZE1hcmtgIHJlZnVzZXMgYSBub24tZmluaXRlIGlkIG9uIGl0cyBmaXJzdCBsaW5lLlxuICAgICAgICBwb3NpdGlvbmFsWzFdID09PSB1bmRlZmluZWQgPyBOdW1iZXIuTmFOIDogcGFyc2VJbnQocG9zaXRpb25hbFsxXSwgMTApLFxuICAgICAgICBcIm9wZW5cIixcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwicmVvcGVuXCIpLFxuICAgICAgICB7IG5vdGU6IGZsYWdzLm5vdGUgYXMgc3RyaW5nIHwgdW5kZWZpbmVkIH0sXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCBmYWxzZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidW5hcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZEFyY2hpdmUocG9zaXRpb25hbFswXSwgdHJ1ZSwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhcnRcIixcbiAgICBhbGlhc2VzOiBbXCJ1cFwiXSxcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kU3RhcnQoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZXN0YXJ0XCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlc3RhcnQoeyBmb3JjZTogISFmbGFncy5mb3JjZSB8fCAhIWZsYWdzLnllcyB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyb2xsXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwieWVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJvbGwoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfHwgZmxhZ3MueWVzID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0b3BcIixcbiAgICBmbGFnczogW1wiaG9sZFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoX3Bvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdG9wKHtcbiAgICAgICAgaG9sZFNlY29uZHM6XG4gICAgICAgICAgZmxhZ3MuaG9sZCAhPT0gdW5kZWZpbmVkID8gbnVtZXJpY0ZsYWcoXCJzdG9wXCIsIFwiaG9sZFwiLCBmbGFncy5ob2xkLCAwKSA6IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhdGNoXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwpID0+IHtcbiAgICAgIGF3YWl0IGNtZFdhdGNoKHBvc2l0aW9uYWxbMF0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYXBcIixcbiAgICBhbGlhc2VzOiBbXCJwcnVuZVwiXSxcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJkcnktcnVuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFJlYXAoeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUsIGRyeVJ1bjogZmxhZ3NbXCJkcnktcnVuXCJdID09PSB0cnVlIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgYXdhaXQgY21kSW5mbygpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWREb2N0b3IoKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIC8vIFRoZSBDTEkgY2FuIGJlIEFTS0VEIHdoYXQgaXQgaXMuIGdyYXBldmluZSBhbHJlYWR5IGNhcnJpZXNcbiAgICAgIC8vIFBMVUdJTl9WRVJTSU9OIHRvIHdhcm4gdGhhdCBhIGRhZW1vbiBpcyBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZCBwbHVnaW5cbiAgICAgIC8vIHBhdGggdGhhbiB0aGlzIENMSSAobWF5YmVXYXJuT25WZXJzaW9uTWlzbWF0Y2gpIOKAlCBidXQgYSBjYWxsZXIgdGhhdCBoaXRcbiAgICAgIC8vIHRoYXQgd2FybmluZywgb3IgdGhhdCBydW5zIGByb2xsYCBmb3IgaXRzIHZlcnNpb24gdmVyaWZ5LCBoYWQgbm8gd2F5IHRvXG4gICAgICAvLyBhc2sgdGhpcyBzaWRlIHdoYXQgaXQgaXMgaG9sZGluZy4gVGhlIHZhbHVlIHdhcyBhbHJlYWR5IGluIG1lbW9yeTsgb25seVxuICAgICAgLy8gdGhlIHF1ZXN0aW9uIHdhcyBtaXNzaW5nLlxuICAgICAgLy8gSlNPTiBieSBkZWZhdWx0LCBtYXRjaGluZyBldmVyeSBkYXRhIGNvbW1hbmQ7IC0taHVtYW4gZm9yIHByb3NlLlxuICAgICAgaWYgKFBMVUdJTl9WRVJTSU9OID09PSBudWxsKVxuICAgICAgICBkaWUoXCJ2ZXJzaW9uIHVuYXZhaWxhYmxlIOKAlCBjb3VsZCBub3QgcmVhZCBwbHVnaW4uanNvblwiLCBcImludGVybmFsXCIpO1xuICAgICAgaWYgKGZsYWdzLmh1bWFuID09PSB0cnVlKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgZ3JhcGV2aW5lIHYke1BMVUdJTl9WRVJTSU9OfVxcbmApO1xuICAgICAgZWxzZSBwcmludEpzb24oeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiB9KTtcbiAgICB9LFxuICB9LFxuXTtcblxuLyoqIFRoZSByZWplY3Rpb24gaGludCBgc2VuZGAgYW5kIGBhbm5vdW5jZWAgYWRkIHRvIGV2ZXJ5IGZsYWcgcmVmdXNhbDogYVxuICogIG1lc3NhZ2UgYm9keSBpcyBwcm9zZSwgYW5kIHByb3NlIHdpdGggYSBkYXNoIGluIGl0IGhhcyB0aHJlZSBzYWZlIHJvdXRlcy4gKi9cbmNvbnN0IEJPRFlfSElOVCA9XG4gIFwiZm9yIGEgbWVzc2FnZSBib2R5IGNvbnRhaW5pbmcgZGFzaGVzLCB1c2UgLS1zdGRpbiBvciAtLWJvZHktZmlsZSwgb3IgcHV0IGl0IGFmdGVyIGEgYmFyZSAtLVwiO1xuXG4vKiogZ3JhcGV2aW5lIGRlY2xhcmVzIG5vIGBtdWx0aXBsZWAgZmxhZywgc28gZXZlcnkgdmFsdWUgaXMgYSBzdHJpbmcgb3IgYVxuICogIGJvb2xlYW4g4oCUIHRoZSBgRmxhZ3NgIHRoZSBoYW5kbGVycyB0YWtlLiAqL1xuY29uc3Qgb24gPVxuICAoaDogUm93W1wicnVuXCJdKSA9PlxuICAoaW52OiBJbnZvY2F0aW9uPEZsYWdOYW1lPik6IHVua25vd24gPT5cbiAgICBoKGludi5wb3MsIGludi5mbGFncyBhcyBGbGFncyk7XG5cbi8vIFRIRSBSRUdJU1RSWSDigJQgdGhlIGhvdXNlJ3Mgb25lIChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgKS4gZ3JhcGV2aW5lJ3Mgb3duXG4vLyBkaXNwYXRjaGVyLCBwZXItdmVyYiBwYXJzZXIsIHJvb3Qgcm91dGVyIGFuZCBkZWNsYXJhdGlvbiBlbWl0dGVyIHdlcmUgdGhlXG4vLyB2ZXJiLWZpcnN0IGhhbGYgb2Ygd2hhdCB0aGF0IG1vZHVsZSB3YXMgZ2VuZXJhbGlzZWQgZnJvbSwgYW5kIHdlcmUgZGVsZXRlZFxuLy8gd2hlbiBncmFwZXZpbmUgbW92ZWQgb250byBpdC4gV2hhdCB0aGUgbW9kdWxlIG5vdyBkb2VzIGhlcmUsIGFuZCBncmFwZXZpbmVcbi8vIHVzZWQgdG8gZG8gaXRzZWxmOlxuLy9cbi8vICAgLSBUaGUgdmVyYiBpcyBgYXJndlswXWAuIEEgZGFzaC1sZWQgYGFyZ3ZbMF1gIHRoYXQgaXMgbm90IGFuIGludGVyY2VwdG9yIGlzXG4vLyAgICAgYW4gdW5rbm93biBST09UIGZsYWcsIHJlamVjdGVkIHdpdGggdGhlIGludGVyY2VwdG9ycyAobG9uZyBmaXJzdCkgYXNcbi8vICAgICBgY2hvaWNlc2AgYW5kIHRoZSBjb21tYW5kcyBpbiB0aGUgaGludCwgc28gYGdyYXBldmluZSAtLWFzIHggbGlzdGAgaXNcbi8vICAgICByZWZ1c2VkIHJhdGhlciB0aGFuIHBhcnNlZC5cbi8vICAgLSBgLS1oZWxwYC9gLWhgL2AtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yIGB2ZXJzaW9uYFxuLy8gICAgIHJvdyBhbmQgUEFTUyBUSEUgUkVTVCBPTjogYGdyYXBldmluZSAtLXZlcnNpb24gLS1odW1hbmAgYW5kXG4vLyAgICAgYC1WIC0tYXMgbWVgIGtlZXAgd29ya2luZywgYmVjYXVzZSBgdmVyc2lvbmAgYWNjZXB0cyB0aGVtLlxuLy8gICAtIEEgYmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIGV2ZXJ5IGNvbW1hbmQgYW5kIGFsaWFzXG4vLyAgICAgKGFjYyBEMiksIG5ldmVyIGhlbHAgYXQgZXhpdCAwOiBncmFwZXZpbmUncyBjYWxsZXJzIGFyZSBhZ2VudHMsIGFuZCBhXG4vLyAgICAgYmFyZSBjYWxsIGlzIGFuIHVuc2V0IHNoZWxsIHZhcmlhYmxlIGV4cGFuZGluZyB0byBub3RoaW5nLlxuLy8gICAtIEEgZmxhZyBhbm90aGVyIHZlcmIgdGFrZXMgaXMgTUlTUExBQ0VEIChgLS14IGlzIG5vdCBhY2NlcHRlZCBieVxuLy8gICAgIFxcYHNlbmRcXGBgKSwgYW4gdW5rbm93biBvbmUgVU5LTk9XTjsgYm90aCBjYXJyeSB0aGlzIHZlcmIncyBhY2NlcHRlZCBzZXRcbi8vICAgICAoaXRzIG93biBmbGFncyBwbHVzIGAtLWFzYC9gLS1mcm9tYCkgYXMgYGNob2ljZXNgLlxuLy8gICAtIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gZWFjaCByb3cncyBwb3NpdGlvbmFscywgbmFtaW5nIHRoZSBtaXNzaW5nXG4vLyAgICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuIChhY2MgQTQpLlxuLy8gICAtIGBzY2hlbWFgIGFuZCBgaGVscGAgYXJlIHRoZSBtb2R1bGUncyByb3dzOyBgdmVyc2lvbmAgaXMgZ3JhcGV2aW5lJ3Mgb3duLFxuLy8gICAgIGZvciBgLS1odW1hbmAuXG4vL1xuLy8g4puUIEJVSUxESU5HIFRIRSBUQUJMRSBIQVMgTk8gU0lERSBFRkZFQ1RTOiBgZGVmaW5lQ2xpYCBvbmx5IHZhbGlkYXRlcyBhbmRcbi8vIGluZGV4ZXMsIHNvIGEgd2FyZCBvciBhIHRlc3QgY2FuIGltcG9ydCBpdCBhbmQgcmVhZCB0aGUgdGFibGUuXG5leHBvcnQgY29uc3QgY2xpID0gZGVmaW5lQ2xpKHtcbiAgbmFtZTogXCJncmFwZXZpbmVcIixcbiAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gIGNvbW1hbmRzOiBST1dTLm1hcCgocikgPT4gKHtcbiAgICAuLi5yLFxuICAgIGRlc2NyaWJlOiBcIlwiLFxuICAgIHJ1bjogb24oci5ydW4pLFxuICAgIC4uLihyLm5hbWUgPT09IFwic2VuZFwiIHx8IHIubmFtZSA9PT0gXCJhbm5vdW5jZVwiID8geyByZWplY3RIaW50OiBCT0RZX0hJTlQgfSA6IHt9KSxcbiAgfSkpLFxuICAvLyBJZGVudGl0eSBpcyBjb250cmFjdHVhbGx5IGdsb2JhbCDigJQgc2VlIEdMT0JBTF9GTEFHUy5cbiAgZ2xvYmFsRmxhZ3M6IEdMT0JBTF9GTEFHUyxcbiAgLy8gT25seSB0aGUgYXV0byBgdmVyc2lvbmAgcm93IHJlYWRzIHRoaXMsIGFuZCBncmFwZXZpbmUgZGVmaW5lcyBpdHMgb3duIHJvdy5cbiAgdmVyc2lvbjogKCkgPT4gKHsgbmFtZTogXCJncmFwZXZpbmVcIiwgdmVyc2lvbjogUExVR0lOX1ZFUlNJT04gPz8gXCJ1bmtub3duXCIgfSksXG4gIGhlbHA6IGhlbHBUZXh0LFxufSk7XG5cbmZ1bmN0aW9uIGhlbHBUZXh0KCk6IHN0cmluZyB7XG4gIHJldHVybiBgZ3JhcGV2aW5lIOKAlCBhZ2VudC10by1hZ2VudCB3YWxraWUtdGFsa2llXG5cblVzYWdlOlxuICBncmFwZXZpbmUgb3BlbiA8bmFtZT4gWy0tdG9waWMgPHRleHQ+XSBbLS1mcmVzaF0gICBvcGVuL2NyZWF0ZSAoYXV0by11bmFyY2hpdmVzOyAtLWZyZXNoIGNsZWFycyBhIGRvcm1hbnQgY2hhbm5lbClcbiAgZ3JhcGV2aW5lIGxpc3RcbiAgZ3JhcGV2aW5lIHNlbmQgPG5hbWU+IFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1xdWlldF0gWy0tdmVyYm9zZV0gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLWZvcmNlXSBbLS1pbi1yZXBseS10byA8aWQ+XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBib2R5OiBpbmxpbmUgdGV4dCwgLS1zdGRpbiwgLS1ib2R5LWZpbGUsIG9yIHBpcGVkIHN0ZGluIChkZWZhdWx0IHdoZW4gbm8gaW5saW5lIHRleHQpXG4gIGdyYXBldmluZSBhbm5vdW5jZSBbLS1mcm9tLy0tYXMgPGFsaWFzPl0gWy0tY2hhbm5lbHMgYSxiLGNdIFstLXN0ZGluXSBbLS1ib2R5LWZpbGUgPHBhdGg+XSBbLS1xdWlldF0gWzx0ZXh0Li4uPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgYnJvYWRjYXN0IG9uZSBtZXNzYWdlIHRvIGV2ZXJ5IGFjdGl2ZSBjaGFubmVsIChvciAtLWNoYW5uZWxzKVxuICBncmFwZXZpbmUgdGFpbCA8bmFtZT4gWy0tYXMvLS1mcm9tIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XSBbLS1odW1hbl0gWy0tbHVya10gWy0tbWF4IDxuPl1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgJHtXSU5ET1dfSEVMUH0gKC0taHVtYW4gbmV2ZXIgZW5kcyBieSBpdHNlbGYpXG4gICAgICAgIyAtLWxhc3QgPG4+OiBiYWNrZmlsbCB0aGUgbW9zdCByZWNlbnQgbiBtZXNzYWdlcyB0aGVuIGdvIGxpdmUgKGJvdW5kZWQgY2F0Y2gtdXAgZm9yIGEgY29sZCBqb2luZXIpXG4gIGdyYXBldmluZSBwdWxsIDxuYW1lPiBbLS1zaW5jZSA8aWQ+XSBbLS1zdGF0dXMgPHZhbHVlPl0gICAjIC0tc3RhdHVzID0gZnVsbC1zY2FuIGZpbHRlciAob3Blbnx3b250Zml4fGluY29ycG9yYXRlZHzigKYpXG4gIGdyYXBldmluZSB0cmlhZ2UgPG5hbWU+ICAgICAgICAgICAgICMgZnVsbC1zY2FuOiBvcGVuIG1lc3NhZ2VzIG9uIHRvcCArIGdyb3VwZWQgYnlfc3RhdHVzXG4gIGdyYXBldmluZSBtYXJrIDxuYW1lPiA8aWQ+IDxkaXNwb3NpdGlvbj4gWy0tbm90ZSA8dGV4dD5dICAjIHNldCBkaXNwb3NpdGlvbiAoaW5jb3Jwb3JhdGVkfHdvbnRmaXh8ZGVmZXJyZWR84oCmKVxuICBncmFwZXZpbmUgcmVvcGVuIDxuYW1lPiA8aWQ+ICAgICAgICAjIGJvdW5jZSBhIG1lc3NhZ2UgYmFjayB0byBvcGVuXG4gIGdyYXBldmluZSByZWFkIDxuYW1lPiA8aWQ+IFstLXRleHRdICAgIyBvbmUgZnVsbCBtZXNzYWdlIGJ5IGlkICgtLXRleHQgPSBwcm9zZSlcbiAgZ3JhcGV2aW5lIHdhaXQgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXRpbWVvdXQgPHM+XVxuICBncmFwZXZpbmUgZ3JlcCA8bmFtZT4gPHBhdHRlcm4+IFstLWxpdGVyYWxdIFstLWZyb20gPGFsaWFzPl1cbiAgZ3JhcGV2aW5lIHRvcGljIDxuYW1lPiBbPHRleHQ+XSAgICMgbm8gdGV4dCDihpIgcmVhZCBjdXJyZW50OyB3aXRoIHRleHQg4oaSIHVwZGF0ZVxuICBncmFwZXZpbmUgd2hvIDxuYW1lPiAgICAgICAgICAgICAgIyByb3N0ZXI7IHRoZSBodW1hbnMgZmllbGQgbGlzdHMgaHVtYW5zXG4gIGdyYXBldmluZSBhbGlhcyBbPG5hbWU+XSAgICAgICAgICAjIHNldC9zaG93IHlvdXIgcGVyc2lzdGVkIGFsaWFzIChjb25maWcuanNvbilcbiAgZ3JhcGV2aW5lIHdhdGNoIFs8bmFtZT5dICAgICAgICAgICMgb3BlbiBicm93c2VyIHRhYjsgbGl2ZSBjaGF0LWJ1YmJsZSB2aWV3XG4gIGdyYXBldmluZSByZXNldCA8bmFtZT4gWy0tZm9yY2VdICAgICAgICAgICBzbmFwc2hvdCB0aGUgbG9nIOKGkiB+Ly5ncmFwZXZpbmUvYXJjaGl2ZSwgdGhlbiBjbGVhciBpdFxuICBncmFwZXZpbmUgYXJjaGl2ZSA8bmFtZT4gICAgICAgICAgIyByZWFkLW9ubHk6IGtlZXAgaGlzdG9yeSwgcmVqZWN0IHNlbmRzXG4gIGdyYXBldmluZSB1bmFyY2hpdmUgPG5hbWU+ICAgICAgICAjIGJyaW5nIGFuIGFyY2hpdmVkIGNoYW5uZWwgYmFja1xuICBncmFwZXZpbmUgY2xvc2UgPG5hbWU+ICAgICAgICAgICAgIyBkZXN0cnVjdGl2ZTogZGVsZXRlIHRoZSBtZXNzYWdlIGxvZ1xuICBncmFwZXZpbmUgc3RhcnQgICAgICAgICAgICAgICAgICAgIyBlbnN1cmUgdGhlIGRhZW1vbiBpcyBydW5uaW5nIChhbGlhczogdXApOyBubyBjaGFubmVsXG4gIGdyYXBldmluZSByZXN0YXJ0IFstLWZvcmNlfC0teWVzXSAjIHN0b3AgKyByZXNwYXduIGZyZXNoOyAtLWZvcmNlIHRvIG92ZXJyaWRlIHRoZSBsaXZlLWZsZWV0IGd1YXJkXG4gIGdyYXBldmluZSByb2xsIFstLWZvcmNlXSAgICAgICAgICAjIHNhZmUgcmVzdGFydCAoc3RvcCtob2xkK3Jlc3Bhd24pICsgdmVyc2lvbiB2ZXJpZnkg4oCUIHRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcFxuICBncmFwZXZpbmUgc3RvcCBbLS1ob2xkIDxzZWNvbmRzPl0gIyBraWxsIHRoZSBkYWVtb247IC0taG9sZCBzdXBwcmVzc2VzIGF1dG8tcmVzcGF3biBmb3IgPHM+IHNlY29uZHMgKHVwZ3JhZGUgd2luZG93KVxuICBncmFwZXZpbmUgaW5mb1xuICBncmFwZXZpbmUgZG9jdG9yICAgICAgICAgICAgICAgICAgIyBoZWFsdGggY2hlY2sg4oCUIGxhYmVscyBlYWNoIGRhZW1vbjogYXV0aG9yaXRhdGl2ZSAvIG9ycGhhbiAvIHVucmVzcG9uc2l2ZSAvIHVua25vd25cbiAgZ3JhcGV2aW5lIHJlYXAgWy0tZm9yY2VdIFstLWRyeS1ydW5dICAjIGtpbGwgb3JwaGFuIGRhZW1vbnM7IC0tZm9yY2UgYWxzbyBraWxscyB1bnJlc3BvbnNpdmU7IGFsaWFzOiBwcnVuZVxuXG4gIGdyYXBldmluZSBzY2hlbWEgICAgICAgICAgICAgICAgICAjIHRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgZGVzY3JpcHRpb24gKGFjYyBkZWNsYXJhdGlvbiB2MClcbiAgZ3JhcGV2aW5lIC0tdmVyc2lvbiAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyB2ZXJzaW9uIChhbGlhczogLVYsIHZlcnNpb24pXG4gIGdyYXBldmluZSBoZWxwICAgICAgICAgICAgICAgICAgICAjIHRoaXMgdXNhZ2UgKGFsaWFzOiAtLWhlbHAsIC1oKVxuXG5PdXRwdXQ6XG4gIERhdGEgY29tbWFuZHMgZW1pdCBKU09OIG9uIHN0ZG91dCBieSBERUZBVUxUOyBwYXNzIC0taHVtYW4gZm9yIHByb3NlIHdoZXJlIGFcbiAgY29tbWFuZCBvZmZlcnMgaXQuIERpYWdub3N0aWNzIGFuZCB3YXJuaW5ncyBnbyB0byBzdGRlcnIsIG5ldmVyIHN0ZG91dC5cbiAgVXNhZ2UgZXJyb3JzIGV4aXQgMi4gRWFjaCBjb21tYW5kIGFjY2VwdHMgaXRzIE9XTiBmbGFncyAocGx1cyAtLWFzLy0tZnJvbSxcbiAgd2hpY2ggYXJlIGdsb2JhbCkg4oCUIGFuIHVua25vd24gZmxhZyBmb3IgYSB2ZXJiIGVudW1lcmF0ZXMgdGhhdCB2ZXJiJ3Mgc2V0LlxuXG5FbnY6XG4gIEdSQVBFVklORV9GUk9NICAgRGVmYXVsdCBpZGVudGl0eSBhbGlhcyAoLS1mcm9tLy0tYXMgYXJlIGludGVyY2hhbmdlYWJsZSkuXG4gIEdSQVBFVklORV9IT01FICAgRGF0YSBkaXIgKGRlZmF1bHQgfi8uZ3JhcGV2aW5lKS5cbmA7XG59XG5cbi8qKlxuICogVGhlIG9uZSBwbGFjZSB0aGlzIENMSSBjYW4gZW5kLCBhbmQgdGhlIG9uZSBwbGFjZSBhIGBDbGlFcnJvcmAgYmVjb21lcyBhblxuICogZXhpdCBjb2RlLlxuICpcbiAqIOKblCBBRERFRCBBVCBQSEFTRSA2IENIQVBURVIgMiwgQU5EIElUIElTIFdIQVQgTUFLRVMgYGRpZWAgU0FGRSBUTyBUSFJPVy5cbiAqIGByZXBvcnRDbGlFcnJvcmAgd3JpdGVzIHRoZSBlbnZlbG9wZSBhbmQgaGFuZHMgYmFjayB0aGUgdGF4b25vbXkgY29kZTsgYVxuICogdGhyb3cgaXQgZG9lcyBOT1QgcmVjb2duaXNlIGlzIHJlLXRocm93biwgYmVjYXVzZSBzd2FsbG93aW5nIGFuIHVua25vd24gb25lXG4gKiBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGVcbiAqIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICpcbiAqIOKaoCBgZGlzcGF0Y2hgLCBOT1QgVEhFIFJFR0lTVFJZJ1MgYG1haW5gLCBGT1IgRVhBQ1RMWSBUSEFUIFJFLVRIUk9XOiB0aGVcbiAqIHJlZ2lzdHJ5J3MgYG1haW5gIHR1cm5zIGFuIHVua25vd24gdGhyb3cgaW50byBhbiBpbnRlcm5hbCBlbnZlbG9wZS5cbiAqIGBtZXRhLmNvbW1hbmRgIOKAlCB3aGljaCB2ZXJiIHByb2R1Y2VkIGFuIGVudmVsb3BlIOKAlCBpcyBzZXQgYnkgdGhlIHJlZ2lzdHJ5IGZyb21cbiAqIHRoZSByYXcgZmlyc3QgdG9rZW4sIHNvIGFuIHVua25vd24gdmVyYiBzdGlsbCBuYW1lcyBpdHNlbGYgaW4gaXRzIHJlamVjdGlvbi5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIGF3YWl0IGNsaS5kaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAoY29kZSAhPT0gbnVsbCkgcmV0dXJuIGNvZGU7XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG4vLyDim5QgTk8gYGltcG9ydC5tZXRhLm1haW5gIEJMT0NLLCBBTkQgSVRTIEFCU0VOQ0UgSVMgVEhFIFNURVAgKHBsYXlib29rIEIzKS5cbi8vIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgYHNjcmlwdHMvY2xpLnRzYCwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3Ncbi8vIGVudHJ5LCBzbyB0aGUgZ3VhcmQgd291bGQgbmV2ZXIgcnVuIGFuZCBldmVyeSB2ZXJiIHdvdWxkIHByaW50IG5vdGhpbmcgYW5kXG4vLyBleGl0IDAuIE5vciBtYXkgdGhpcyBmaWxlIG9mZmVyIGEgc2Vjb25kIGVudHJ5IGZyb20gaXRzIGF1dGhvcmluZyBhZGRyZXNzOlxuLy8gYFNLSUxMX1JPT1RgLCBgRElTVF9ESVJgLCBgU1VSRkFDRV9DV0RgIGFuZCBgREFFTU9OX1NDUklQVGAgYWJvdmUgYXJlIGFsbFxuLy8gY29tcHV0ZWQgZnJvbSBgU0NSSVBUX0RJUmAgYW5kIGFyZSBjb3JyZWN0IG9ubHkgZnJvbSBgZGlzdC9gLlxuLy9cbi8vIFRoZSBkcmFpbiBjb250cmFjdCBsaXZlcyBhdCB0aGUgbGF1bmNoZXIgbm93IOKAlCBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWxcbi8vIHJldHVybiwgbmV2ZXIgYW4gZXhwbGljaXQgZXhpdCwgYmVjYXVzZSBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGFcbi8vIHBpcGUgYW5kIGB0YWlsYCB3cml0ZXMgSlNPTkwgYSBjYWxsZXIgcGFyc2VzLiBTZWVcbi8vIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvZ3JhcGV2aW5lL3NjcmlwdHMvY2xpLnRzYCBmb3IgdGhlIGZ1bGwgYWNjb3VudC5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgQ0xJIHJlZ2lzdHJ5OiBvbmUgdGFibGUgZHJpdmVzIHRoZSBwYXJzZXIsIHRoZSBkaXNwYXRjaGVyLFxuICogaGVscCwgdGhlIHJlamVjdGlvbnMnIGBjaG9pY2VzYCwgYC0tdmVyc2lvbmAgYW5kIHRoZSBhY2MgZGVjbGFyYXRpb25cbiAqIChgc2NoZW1hYCwgZm9ybWF0IHYwKS5cbiAqXG4gKiBHZW5lcmFsaXNlZCBmcm9tIHRoZSB0aHJlZSBoYW5kLWJ1aWx0IHJlZ2lzdHJpZXMgKGdyYXBldmluZSwgZ2xhbW91cixcbiAqIHNjcmlwdG9yaXVtKSBwZXIgYGRvY3MvaXRlbXMvX2FyY2hpdmUvc2hhcmVkLWNsaS1yZWdpc3RyeS1pbi10aGUta2l0L3dyaXRlLXVwLm1kYCwgYXNcbiAqIGFtZW5kZWQgYnkgaXRzIGNvbGQgcmVhZCAoYOKApi9hcnRpZmFjdHMvY29sZC1yZWFkLm1kYCkuIFdoZXJlIHRoZXkgZGlzYWdyZWVkLFxuICogdGhlIGNvbGQgcmVhZCB3b24uXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBUaGlzIG1vZHVsZSBpbXBvcnRzIG9ubHkgYG5vZGU6dXRpbGAgYW5kIG90aGVyIGtpdFxuICogbW9kdWxlcyAoYC4uL3dpcmUvZXJyb3JzYCwgYC4uL2xpYi9wcmludEpzb25gKS5cbiAqXG4gKiDim5QgTk8gU0lERSBFRkZFQ1RTIEFUIElNUE9SVCwgQU5EIE5PTkUgSU4gYGRlZmluZUNsaWAuIEJ1aWxkaW5nIHRoZSB0YWJsZSBvbmx5XG4gKiB2YWxpZGF0ZXMgYW5kIGluZGV4ZXMgaXQ7IG5vdGhpbmcgaXMgcGFyc2VkLCBwcmludGVkIG9yIHJlYWQgdW50aWwgYG1haW5gIG9yXG4gKiBgZGlzcGF0Y2hgIGlzIGNhbGxlZC4gQSBncmltb2lyZSB3YXJkIGNhbiBpbXBvcnQgYSBzcGVsbCdzIHRhYmxlIGFuZCByZWFkXG4gKiBgcmVjb2duaXplZEZsYWdzYCwgYGZsYWdzRm9yYCwgYHZlcmJzYCBhbmQgYGRlY2xhcmF0aW9uKClgIHdpdGhvdXQgcnVubmluZyBpdC5cbiAqXG4gKiDilIDilIAgVEhFIENPTlRSQUNUIEEgU1BFTEwgQ0FOTk9UIENIQU5HRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAxLiBgLS1oZWxwYC9gLWhgIGFuZCBgLS12ZXJzaW9uYC9gLVZgIGFzIGBhcmd2WzBdYCBydW4gdGhlIGBoZWxwYCBvclxuICogICAgYHZlcnNpb25gIHJvdyBhbmQgUEFTUyBUSEUgUkVNQUlOSU5HIEFSR1VNRU5UUyBPTiB0byBpdCwgc28gdGhhdCByb3cncyBvd25cbiAqICAgIGZsYWcgY2hlY2sgYXBwbGllczogYC0tdmVyc2lvbiAtLWh1bWFuYCB3b3JrcyB3aGVyZSBgdmVyc2lvbmAgYWNjZXB0c1xuICogICAgYC0taHVtYW5gLCBhbmQgYC0tdmVyc2lvbiAtLWp1bmtgIGlzIGV4aXQgMiB3aGVyZSBpdCBkb2VzIG5vdC5cbiAqIDIuIEVtcHR5IGFyZ3YgaXMgYSB1c2FnZSBlcnJvciAoYWNjIEMyL0QyOiBvbmUgZW52ZWxvcGUgb24gc3RkZXJyLCBleGl0IDIsXG4gKiAgICBgY2hvaWNlc2AgPSB0aGUgdmVyYnMpIOKAlCB1bmxlc3MgdGhlIENMSSBoYXMgYSB2ZXJibGVzcyBgcm9vdGAgcm93IHRoYXRcbiAqICAgIGFjY2VwdHMgYW4gZW1wdHkgYXJndiAobm8gcmVxdWlyZWQgcG9zaXRpb25hbHM7IGZsYWdzIGRlZmF1bHRlZCkuXG4gKiAzLiBUaGUgdmVyYiBpcyBmb3VuZCBwZXIgdGhlIGdyYW1tYXI6XG4gKiAgICAtIGB2ZXJiLWZpcnN0YCAoZGVmYXVsdCk6IGBhcmd2WzBdYC4gQSBkYXNoLWxlZCBgYXJndlswXWAgdGhhdCBpcyBub3QgYW5cbiAqICAgICAgaW50ZXJjZXB0b3IgaXMgYW4gdW5rbm93biBST09UIGZsYWcgKGBjaG9pY2VzYCA9IHRoZSBpbnRlcmNlcHRvcnMsIGxvbmdcbiAqICAgICAgZmlyc3QpLiBGbGFncyBiZWZvcmUgdGhlIHZlcmIgYXJlIHJlZnVzZWQsIGluY2x1ZGluZyBnbG9iYWwgb25lcy5cbiAqICAgIC0gYGZsYWdzLWFueXdoZXJlYDogdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbmVpdGhlciBhIGZsYWcgbm9yIGEgc3RyaW5nXG4gKiAgICAgIGZsYWcncyB2YWx1ZSAoYGdsYW1vdXIgLS1zZXNzaW9uIHggaW5mb2AgcnVucyBgaW5mb2ApLiBUaGVcbiAqICAgICAgdW5rbm93bi1yb290LWZsYWcgcnVsZSBkb2VzIE5PVCBhcHBseTsgYW4gYXJndiB3aXRoIG5vIHZlcmIgaW4gaXQgaXNcbiAqICAgICAgcGFyc2VkIHdob2xlLCBzbyBhbiB1bmtub3duIGZsYWcgdGhlcmUgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LlxuICogICAgSW4gYm90aCwgYSBiYXJlIGAtLWAgYmVmb3JlIHRoZSB2ZXJiIG1ha2VzIHRoZSBORVhUIHRva2VuIHRoZSB2ZXJiXG4gKiAgICBjYW5kaWRhdGUgYW5kIGV2ZXJ5dGhpbmcgYWZ0ZXIgaXQgcG9zaXRpb25hbCAoYWNjIEE2KTogYGNsaSAtLSAtLXhgIGlzXG4gKiAgICBgdW5rbm93biBjb21tYW5kIFwiLS14XCJgLCBuZXZlciBhbiBvcHRpb24uXG4gKiA0LiBOZXN0aW5nIGlzIG9uZSBsZXZlbDogYSByb3cgbmFtZWQgYFwibm9kZSBlZGl0XCJgLiBUaGUgc3ViLXZlcmIgb2YgYSBncm91cFxuICogICAgaXMgZm91bmQgYnkgdGhlIGdyb3VwJ3MgYHN1YlZlcmJBdGAgKHNlZSBgR3JvdXBTcGVjYCkuIEEgZ3JvdXAgd2l0aCBubyByb3dcbiAqICAgIG9mIGl0cyBvd24gcmVqZWN0cyBhIG1pc3Npbmcgb3IgdW5rbm93biBzdWItdmVyYiB3aXRoIGl0cyBzdWItdmVyYnMgYXNcbiAqICAgIGBjaG9pY2VzYDsgYSBncm91cCBXSVRIIGl0cyBvd24gcm93IChgZG9jIDxpZD5gKSBydW5zIHRoYXQgcm93IGluc3RlYWQuXG4gKiA1LiBUaGUgcm93J3MgYXJncyBhcmUgcGFyc2VkIHN0cmljdCBhZ2FpbnN0IHRoZSBXSE9MRSBvcHRpb25zIHRhYmxlICh3aXRoXG4gKiAgICBgZGVmYXVsdGBzIHN0cmlwcGVkKSwgc28gYSBmbGFnIHRoZSBzcGVsbCBrbm93cyBidXQgdGhpcyByb3cgZG9lcyBub3QgdGFrZVxuICogICAgaXMgcmVmdXNlZCBhcyBNSVNQTEFDRUQgKGAtLXggaXMgbm90IGFjY2VwdGVkIGJ5IFxcYHZlcmJcXGBgKSwgYW5kIG9uZSB0aGVcbiAqICAgIHNwZWxsIGRvZXMgbm90IGtub3cgYXMgVU5LTk9XTi4gQm90aCBjYXJyeSBgY2hvaWNlc2AgPSB0aGlzIHJvdydzIGFjY2VwdGVkXG4gKiAgICBzZXQgKGl0cyBvd24gZmxhZ3MgcGx1cyBgZ2xvYmFsRmxhZ3NgOyBhIHZlcmJsZXNzIHJvb3QncyBhZGRzIHRoZVxuICogICAgaW50ZXJjZXB0b3JzLCBhcyBpdHMgZGVjbGFyZWQgcm93IGRvZXMpLiBBZnRlciBhIGAtLWAgZXZlcnl0aGluZyBpcyBhXG4gKiAgICBwb3NpdGlvbmFsIChub2RlJ3MgcGFyc2VyIGhvbm91cnMgaXQpLiBBIHBvc3QtYC0tYCB0b2tlbiB0aGF0IHNwZWxscyBhXG4gKiAgICBmbGFnIHRoaXMgcm93IGFjY2VwdHMgaXMgc3RpbGwgYSBwb3NpdGlvbmFsLCBidXQgaXQgZWFybnMgb25lXG4gKiAgICBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIgbmFtaW5nIHRoZSByZWNvdmVyeSAoYHdhcm5EZW1vdGVkYCk7IHN0ZG91dFxuICogICAgYW5kIHRoZSBleGl0IGNvZGUgYXJlIHVuY2hhbmdlZC5cbiAqIDYuIERlZmF1bHRzIGFyZSBhcHBsaWVkIEFGVEVSIHRoZSBwZXItcm93IGNoZWNrLCBhbmQgb25seSBmb3IgZmxhZ3MgdGhlIHJvd1xuICogICAgYWNjZXB0cyDigJQgc28gYSBkZWZhdWx0ZWQgZmxhZyBuZXZlciB0cmlwcyB0aGUgbWlzcGxhY2VkLWZsYWcgY2hlY2ssIGFuZCBhXG4gKiAgICByb3cgbmV2ZXIgc2VlcyBhbm90aGVyIHJvdydzIGRlZmF1bHQuXG4gKiA3LiBBcml0eSBpcyBlbmZvcmNlZCBmcm9tIGBwb3NpdGlvbmFsc2A7IHRoZSByZWplY3Rpb24gbmFtZXMgdGhlIG1pc3NpbmdcbiAqICAgIGA8cG9zaXRpb25hbD5gIG9yIHRoZSBleHRyYSB0b2tlbi4gQSByb3cncyBgY2hlY2tgIG1heSB0aGVuIHJlZnVzZSBhXG4gKiAgICBjb21iaW5hdGlvbiB0aGUgZGVjbGFyYXRpb24gY2Fubm90IGV4cHJlc3MgKGZsYWctZGVwZW5kZW50IGFyaXR5KS5cbiAqIDguIFRoZSByb3cgcnVuczsgYSBudW1iZXIgaXQgcmV0dXJucyBpcyB0aGUgZXhpdCBjb2RlLCBhbnl0aGluZyBlbHNlIGlzIDAuXG4gKlxuICogUGVyLXZlcmIgaGVscCAocG9ydGVkIGZyb20gU3RvcnkgU3R1ZGlvJ3Mga2l0KTogYGhlbHAgPHZlcmI+YCBhbmRcbiAqIGA8dmVyYj4gLS1oZWxwYCAob3IgYC1oYCwgd2hlbiBubyBmbGFnIGNsYWltcyB0aGF0IHNob3J0KSBwcmludCBvbmUgcm93J3NcbiAqIHVzYWdlLCBpdHMgbGluZSwgZWFjaCBvd24gZmxhZyB3aXRoIGl0cyBgZmxhZ0hlbHBgIGxpbmUsIHRoZSBnbG9iYWwgZmxhZ3MgaW5cbiAqIHRoZWlyIG93biBibG9jaywgYW5kIGl0cyBgZXhhbXBsZXNgLiBFdmVyeSByb3cgYW5zd2VycyBgLS1oZWxwYCwgdGhlIGF1dG9cbiAqIHJvd3MgYW5kIGEgdmVyYmxlc3Mgcm9vdCBpbmNsdWRlZC4gVGhlIGNoZWNrIHJ1bnMgYmVmb3JlIGNvbnRyYWN0IDUsIG9uIHRoZVxuICogd2hvbGUgYXJndiwgYW5kIGNvdW50cyBgLS1oZWxwYCBvbmx5IHdoZW4gYSBzdHJpY3QgcGFyc2UgKHRoZSB0YWJsZSBwbHVzIGFcbiAqIGBoZWxwYCBib29sZWFuKSByZWFkcyBpdCBhcyB0aGUgZmxhZyAoYGFza3NGb3JIZWxwYCksIHNvIGEgdmFsdWUtc2xvdFxuICogYC0taGVscGAgc3RheXMgdGhlIHBhcnNlcidzIHJlZnVzYWwuIEEgcm93J3NcbiAqIGByZXF1aXJlZEZsYWdzYCBkcm9wIHRoZWlyIGJyYWNrZXRzIGluIGl0cyB1c2FnZSBhbmQgYXJlIHJlZnVzZWQgYXMgbWlzc2luZ1xuICogYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrLlxuICpcbiAqIFRoZSBtb2R1bGUgYWRkcyBgaGVscGAsIGB2ZXJzaW9uYCBhbmQgYHNjaGVtYWAgcm93cyB1bmxlc3MgdGhlIHNwZWxsIGRlZmluZXNcbiAqIGEgcm93IG9mIHRoYXQgbmFtZSAoZ3JhcGV2aW5lJ3MgYHZlcnNpb24gLS1odW1hbmApLiBUaGV5IGFyZSBvcmRpbmFyeSByb3dzOlxuICogZGVjbGFyZWQsIHN0cmljdCwgYW5kIGdpdmVuIGBnbG9iYWxGbGFnc2AgbGlrZSBldmVyeSBvdGhlciByb3cuXG4gKi9cblxuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uL2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi93aXJlL2Vycm9yc1wiO1xuXG4vLyDilIDilIAgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZsYWdUeXBlID0gXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiO1xuXG4vKiogT25lIGBwYXJzZUFyZ3NgIG9wdGlvbiwgcGx1cyB0aGUgYGRlZmF1bHRgIG5vZGUncyBwYXJzZXIgYWxzbyB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIE9wdGlvblNwZWMgPSB7XG4gIHR5cGU6IEZsYWdUeXBlO1xuICBtdWx0aXBsZT86IGJvb2xlYW47XG4gIHNob3J0Pzogc3RyaW5nO1xuICBkZWZhdWx0Pzogc3RyaW5nIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgcmVhZG9ubHkgYm9vbGVhbltdO1xufTtcblxuZXhwb3J0IHR5cGUgT3B0aW9uc1RhYmxlID0gUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgT3B0aW9uU3BlYz4+O1xuXG5leHBvcnQgdHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbmV4cG9ydCB0eXBlIEZsYWdWYWx1ZSA9IHN0cmluZyB8IGJvb2xlYW4gfCAoc3RyaW5nIHwgYm9vbGVhbilbXTtcblxuZXhwb3J0IHR5cGUgSW52b2NhdGlvbjxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIFRoZSByZXNvbHZlZCByb3cgbmFtZTogYFwib3BlblwiYCwgYFwibm9kZSBlZGl0XCJgLCBvciBgXCJcImAgZm9yIGEgdmVyYmxlc3Mgcm9vdC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHNwZWxsaW5nIHRoZSBjYWxsZXIgdXNlZCDigJQgYW4gYWxpYXMsIHdoZW4gb25lIHdhcyB1c2VkLiAqL1xuICB0b2tlbjogc3RyaW5nO1xuICAvKiogUG9zaXRpb25hbHMgYWZ0ZXIgdGhlIHBhdGguICovXG4gIHBvczogc3RyaW5nW107XG4gIC8qKiBGbGFncyBnaXZlbiwgcGx1cyB0aGUgZGVmYXVsdHMgb2YgdGhlIGZsYWdzIHRoaXMgcm93IGFjY2VwdHMuICovXG4gIGZsYWdzOiBQYXJ0aWFsPFJlY29yZDxGLCBGbGFnVmFsdWU+Pjtcbn07XG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogYFwib3BlblwiYDsgb25lIHNwYWNlIG1lYW5zIG9uZSBsZXZlbCBvZiBuZXN0aW5nOiBgXCJub2RlIGVkaXRcImAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVhY2ggYWxpYXMgaXMgZGlzcGF0Y2hhYmxlLCBsaXN0ZWQgaW4gYHZlcmJzYCwgYW5kIGdldHMgaXRzIG93biBkZWNsYXJlZFxuICAgKiAgcm93LiBBbiBhbGlhcyBvZiBhIG5lc3RlZCByb3cgbXVzdCBzaGFyZSBpdHMgZ3JvdXA6IGBcIm5vZGUgY2hhbmdlXCJgLiAqL1xuICBhbGlhc2VzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGlzIHJvdydzIG93biBmbGFnczsgYGdsb2JhbEZsYWdzYCBhcmUgYWRkZWQgdG8gdGhlbS4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IEZbXTtcbiAgLyoqIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gdGhpcywgYW5kIGl0IGlzIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLiAqL1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIEFkZGVkIGFzIHRoZSBgaGludGAgb2YgdGhpcyByb3cncyBmbGFnIHJlamVjdGlvbnMuICovXG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIC8qKiBgZmFsc2VgIGhhbmRzIG5vZGUncyBvd24gXCJVbmV4cGVjdGVkIGFyZ3VtZW50XCIgcmVmdXNhbCBhbnkgcG9zaXRpb25hbC4gKi9cbiAgYWxsb3dQb3NpdGlvbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGF0IGVhY2ggb2YgdGhpcyByb3cncyBmbGFncyBkb2VzLCBvbmUgbGluZSBlYWNoLCBmb3IgYGhlbHAgPHZlcmI+YC4gQVxuICAgKiBmbGFnIHdpdGggbm8gbGluZSBpcyBsaXN0ZWQgYnkgbmFtZSBvbmx5LlxuICAgKi9cbiAgZmxhZ0hlbHA/OiBSZWFkb25seTxQYXJ0aWFsPFJlY29yZDxGLCBzdHJpbmc+Pj47XG4gIC8qKiBXaG9sZSBjb21tYW5kIGxpbmVzIHRoYXQgc2hvdyB0aGUgcm93IGluIHVzZSwgZm9yIGBoZWxwIDx2ZXJiPmAuICovXG4gIGV4YW1wbGVzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBGbGFncyBvZiB0aGlzIHJvdyB0aGF0IG11c3QgYmUgZ2l2ZW46IHNob3duIHdpdGhvdXQgYnJhY2tldHMgaW4gaXRzXG4gICAqIHVzYWdlLCBhbmQgcmVmdXNlZCBhcyBtaXNzaW5nLCBsaWtlIGEgcmVxdWlyZWQgcG9zaXRpb25hbC5cbiAgICovXG4gIHJlcXVpcmVkRmxhZ3M/OiByZWFkb25seSBGW107XG4gIC8qKlxuICAgKiBGbGFnLWRlcGVuZGVudCBhcml0eSAoaW1hZ28gYGhhbmRvZmYgLS1jbGVhcmAsIG1pbmQtbWFwcGVyIGAtLXRvfC0tY2xlYXJgKVxuICAgKiBhbmQgYW55IG90aGVyIGNvbWJpbmF0aW9uIHJ1bGUuIFJ1bnMgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrOyBhIHJldHVybmVkXG4gICAqIHN0cmluZyBpcyByZWZ1c2VkIGFzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIHRoaXMgcm93LiDimqAgVGhlIGRlY2xhcmF0aW9uXG4gICAqIGNhbm5vdCBleHByZXNzIHN1Y2ggYSBydWxlOiBhIHBvc2l0aW9uYWwgdGhhdCBgLS1jbGVhcmAgbWFrZXMgdW5uZWNlc3NhcnlcbiAgICogY2FuIG9ubHkgYmUgZGVjbGFyZWQgYHJlcXVpcmVkOiBmYWxzZWAsIGFuZCB0aGlzIGhvb2sgZW5mb3JjZXMgdGhlIHJlc3QuXG4gICAqL1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb248Rj4pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgbnVtYmVyIGlzIHRoZSBleGl0IGNvZGU7IGFueXRoaW5nIGVsc2UgbWVhbnMgMC4gKi9cbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiB1bmtub3duO1xufTtcblxuLyoqIEEgdmVyYmxlc3MgQ0xJJ3Mgb25lIHJvdyAoZGlnZXN0aWZ5KS4gYHBhdGg6IFtdYCBpbiB0aGUgZGVjbGFyYXRpb24uICovXG5leHBvcnQgdHlwZSBSb290U3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IE9taXQ8Q29tbWFuZFNwZWM8Rj4sIFwibmFtZVwiIHwgXCJhbGlhc2VzXCI+O1xuXG4vKipcbiAqIFdoZXJlIGEgZ3JvdXAncyBzdWItdmVyYiBpcyBmb3VuZC5cbiAqIC0gYGFkamFjZW50YCAoZGVmYXVsdCk6IHRoZSB0b2tlbiByaWdodCBhZnRlciB0aGUgZ3JvdXAgKGBub2RlIGVkaXQgWGApLlxuICogLSBgZmlyc3QtcG9zaXRpb25hbGA6IHRoZSBmaXJzdCB0b2tlbiBhZnRlciB0aGUgZ3JvdXAgdGhhdCBpcyBuZWl0aGVyIGEgZmxhZ1xuICogICBub3IgYSBzdHJpbmcgZmxhZydzIHZhbHVlLCBzbyBmbGFncyBtYXkgY29tZSBmaXJzdDpcbiAqICAgYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWAgcmVzb2x2ZXMgdG8gYGRvYyBkZWxldGVgIChtaW5kLW1hcHBlcikuXG4gKiAgIFRoZSBzY2FuIHN0b3BzIGF0IGEgYmFyZSBgLS1gLCB3aGljaCBpcyB0aGUgZXNjYXBlIGhhdGNoIGZvciBhIHBvc2l0aW9uYWxcbiAqICAgbGl0ZXJhbGx5IG5hbWVkIGxpa2UgYSBzdWItdmVyYjogYGRvYyAtLSBkZWxldGVgIHJlYWRzIHRoZSBkb2MgXCJkZWxldGVcIi5cbiAqL1xuZXhwb3J0IHR5cGUgR3JvdXBTcGVjID0geyBzdWJWZXJiQXQ/OiBcImFkamFjZW50XCIgfCBcImZpcnN0LXBvc2l0aW9uYWxcIiB9O1xuXG5leHBvcnQgdHlwZSBDbGlTcGVjPE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+ID0ge1xuICAvKiogYFwiYm91bnR5XCJgLCB1c2VkIGluIG1lc3NhZ2VzIGFuZCB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogVGhlIHJlbmRlcmVkIGhlbHAncyBmaXJzdCBsaW5lOiBgJHtuYW1lfSDigJQgJHtzdW1tYXJ5fWAuICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIC8qKiBUaGUgbGl0ZXJhbCBgQ0xJX09QVElPTlNgIG9iamVjdC4gKi9cbiAgb3B0aW9uczogTztcbiAgY29tbWFuZHM/OiByZWFkb25seSBDb21tYW5kU3BlYzxrZXlvZiBPICYgc3RyaW5nPltdO1xuICAvKipcbiAgICogQSB2ZXJibGVzcyBDTEkncyByb3cuIFJlc2VydmVkIHRva2VucyBhcyBgYXJndlswXWAgc3RpbGwgc2VsZWN0IHRoZWlyIHJvd3NcbiAgICogKGBoZWxwYCwgYHZlcnNpb25gLCBgc2NoZW1hYCwgYW55IGBjb21tYW5kc2AsIGFuZCB0aGUgaW50ZXJjZXB0b3JzKTsgZXZlcnlcbiAgICogb3RoZXIgYXJndiwgdGhlIGVtcHR5IG9uZSBpbmNsdWRlZCwgYmVsb25ncyB0byB0aGUgcm9vdC4gQSBwb3NpdGlvbmFsIHRoYXRcbiAgICogaGFwcGVucyB0byBzcGVsbCBhIHJlc2VydmVkIHRva2VuIGdvZXMgYWZ0ZXIgYSBiYXJlIGAtLWAuXG4gICAqL1xuICByb290PzogUm9vdFNwZWM8a2V5b2YgTyAmIHN0cmluZz47XG4gIC8qKiBBY2NlcHRlZCBieSBldmVyeSByb3csIGJ5IGNvbnRyYWN0IChncmFwZXZpbmUncyBgLS1hc2AvYC0tZnJvbWApLiAqL1xuICBnbG9iYWxGbGFncz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICBncmFtbWFyPzogXCJ2ZXJiLWZpcnN0XCIgfCBcImZsYWdzLWFueXdoZXJlXCI7XG4gIC8qKiBQZXItZ3JvdXAgc3ViLXZlcmIgcGxhY2VtZW50LCBrZXllZCBieSB0aGUgZ3JvdXAgdG9rZW4gKGBcImRvY1wiYCkuICovXG4gIGdyb3Vwcz86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEdyb3VwU3BlYz4+O1xuICAvKiogVGhlIHJvb3Qgcm93J3MgcG9zaXRpb25hbCBuYW1lIGluIGBzY2hlbWFgIChgXCJjb21tYW5kXCJgOyBnbGFtb3VyOiBgXCJ2ZXJiXCJgKS4gKi9cbiAgdmVyYlBvc2l0aW9uYWw/OiBzdHJpbmc7XG4gIC8qKiBGbGFncyBsZWZ0IG9mZiBldmVyeSB1c2FnZSBsaW5lIChnbGFtb3VyJ3MgcGVyLXZlcmIgYHNlc3Npb25gKS4gKi9cbiAgdXNhZ2VIaWRlcz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICAvKiogVGhlIGB2ZXJzaW9uYCByb3cncyBwYXlsb2FkLCBge25hbWUsIHZlcnNpb259YC4gKi9cbiAgdmVyc2lvbjogKCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqIFJlcGxhY2VzIHRoZSByZW5kZXJlZCBoZWxwIChncmFwZXZpbmUpLiAqL1xuICBoZWxwPzogKCkgPT4gc3RyaW5nO1xuICAvKiogQXBwZW5kZWQgYmVsb3cgdGhlIHJlbmRlcmVkIHJvd3MuICovXG4gIGhlbHBGb290ZXI/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBEZWNsYXJlZEFyZyA9IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBGbGFnVHlwZTsgc3RhdHVzOiBcInZhbGlkXCIgfTtcbmV4cG9ydCB0eXBlIERlY2xhcmVkQ29tbWFuZCA9IHtcbiAgcGF0aDogc3RyaW5nW107XG4gIGFyZ3M6IERlY2xhcmVkQXJnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xufTtcbmV4cG9ydCB0eXBlIERlY2xhcmF0aW9uID0ge1xuICBmb3JtYXRWZXJzaW9uOiBcIjBcIjtcbiAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCI7XG4gIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBzdHJpbmdbXSB9O1xuICBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW107XG59O1xuXG4vKiogQSByb3cgYXMgdGhlIG1vZHVsZSBob2xkcyBpdCwgZm9yIHRlc3RzIGFuZCB3YXJkcy4gKi9cbmV4cG9ydCB0eXBlIFJvd1ZpZXcgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcm93J3Mgb3duIGZsYWdzLCBhcyBkZWNsYXJlZC4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogT3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCwgaW4gb3B0aW9ucy10YWJsZSBvcmRlci4gKi9cbiAgYWNjZXB0ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIGB0cnVlYCBmb3IgYSBgaGVscGAvYHZlcnNpb25gL2BzY2hlbWFgIHJvdyB0aGUgbW9kdWxlIGFkZGVkLiAqL1xuICBhdXRvOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQ2xpID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFbnZlbG9wZSBvbiBmYWlsdXJlLCByZXR1cm5zIHRoZSBleGl0IGNvZGUuIEZvciB0aGUgc3BlbGwncyBgcnVuKClgLiAqL1xuICBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhyb3dzIGBDbGlFcnJvcmAsIGZvciBhIHNwZWxsIHdob3NlIG1haW4gZG9lcyBpdHMgb3duIHRyaWFnZS4gKi9cbiAgZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIGRlY2xhcmF0aW9uKCk6IERlY2xhcmF0aW9uO1xuICByZW5kZXJIZWxwKCk6IHN0cmluZztcbiAgLyoqIE9uZSB2ZXJiJ3MgaGVscCAoYGhlbHAgPHZlcmI+YCk7IGEgdXNhZ2UgZXJyb3IgZm9yIGEgdmVyYiB0aGF0IGlzIG5vdCB0aGVyZS4gKi9cbiAgcmVuZGVyVmVyYkhlbHAocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogQSByb3cncyB1c2FnZSBsaW5lIChgXCJjbG9zZSA8aWQ+IFstLWZvcmNlXVwiYCk7IGBcIlwiYCBmb3IgYW4gdW5rbm93biBwYXRoLiAqL1xuICB1c2FnZU9mKHBhdGg6IHN0cmluZyk6IHN0cmluZztcbiAgLyoqIEV2ZXJ5IGZpcnN0IHRva2VuIHRoYXQgZGlzcGF0Y2hlczogdmVyYnMsIGFsaWFzZXMgYW5kIGdyb3VwIHRva2Vucy4gKi9cbiAgdmVyYnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogRXZlcnkgZnVsbCBwYXRoIHRoYXQgZGlzcGF0Y2hlcywgYWxpYXNlcyBpbmNsdWRlZCAoYFwibm9kZSBlZGl0XCJgKS4gKi9cbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogQSByb3cncyBhY2NlcHRlZCBzZXQgYXMgYC0teGAgc3BlbGxpbmdzLCBzb3J0ZWQuIGBcIlwiYCBpcyB0aGUgcm9vdC4gKi9cbiAgZmxhZ3NGb3IocGF0aDogc3RyaW5nKTogc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmbGFnIGluIHRoZSBvcHRpb25zIHRhYmxlLCBhcyBgLS14YCwgaW4gdGFibGUgb3JkZXIuICovXG4gIHJlY29nbml6ZWRGbGFnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJvd3M6IHJlYWRvbmx5IFJvd1ZpZXdbXTtcbn07XG5cbi8vIOKUgOKUgCBpbnRlcm5hbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbnR5cGUgUm93ID0gUm93VmlldyAmIHtcbiAgcmVqZWN0SGludD86IHN0cmluZztcbiAgYWxsb3dQb3NpdGlvbmFsczogYm9vbGVhbjtcbiAgZmxhZ0hlbHA6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4+O1xuICBleGFtcGxlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlcXVpcmVkOiBSZWFkb25seVNldDxzdHJpbmc+O1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5yZXF1aXJlZEZsYWdzID8/IFtdKSB7XG4gICAgICBpZiAoIWMuZmxhZ3MuaW5jbHVkZXMoZikpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiByZXF1aXJlcyBmbGFnIFwiJHtmfVwiLCBub3Qgb25lIG9mIGl0cyBvd25gLFxuICAgICAgICApO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGZsYWdIZWxwOiB7IC4uLihjLmZsYWdIZWxwID8/IHt9KSB9IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gICAgICBleGFtcGxlczogWy4uLihjLmV4YW1wbGVzID8/IFtdKV0sXG4gICAgICByZXF1aXJlZDogbmV3IFNldChjLnJlcXVpcmVkRmxhZ3MgPz8gW10pLFxuICAgICAgY2hlY2s6IGMuY2hlY2sgYXMgUm93W1wiY2hlY2tcIl0sXG4gICAgICBydW46IGMucnVuIGFzIFJvd1tcInJ1blwiXSxcbiAgICB9O1xuICB9O1xuXG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gKHNwZWMuY29tbWFuZHMgPz8gW10pLm1hcCgoYykgPT4gdG9Sb3coYyBhcyBDb21tYW5kU3BlYywgZmFsc2UpKTtcblxuICAvLyBUaGUgYXV0byByb3dzLiBBZGRlZCBsYXN0LCBpbiB0aGlzIG9yZGVyLCB1bmxlc3MgdGhlIHNwZWxsIGhhcyBpdHMgb3duLlxuICBjb25zdCBjbGkgPSB7fSBhcyBDbGk7XG4gIGNvbnN0IGF1dG9Sb3dzOiBDb21tYW5kU3BlY1tdID0gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTiAoYWxpYXM6IC0tdmVyc2lvbiwgLVYpXCIsXG4gICAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgICAgcHJpbnRKc29uKGF3YWl0IHNwZWMudmVyc2lvbigpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSAoYWNjIGRlY2xhcmF0aW9uIHYwKVwiLFxuICAgICAgcnVuOiAoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGNsaS5kZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcImhlbHBcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICAgIGRlc2NyaWJlOlxuICAgICAgICBcInNob3cgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaCk7IGBoZWxwIDx2ZXJiPmAgc2hvd3Mgb25lIHZlcmI6IGl0cyB1c2FnZSwgZWFjaCBmbGFnLCBhbmQgZXhhbXBsZXNcIixcbiAgICAgIHJ1bjogKGludikgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0ID0gaW52LnBvcy5sZW5ndGggPiAwID8gY2xpLnJlbmRlclZlcmJIZWxwKGludi5wb3Muam9pbihcIiBcIikpIDogY2xpLnJlbmRlckhlbHAoKTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUodGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGEgb2YgYXV0b1Jvd3MpIHtcbiAgICBpZiAoIXJvd3Muc29tZSgocikgPT4gci5uYW1lID09PSBhLm5hbWUpKSByb3dzLnB1c2godG9Sb3coYSwgdHJ1ZSkpO1xuICB9XG5cbiAgY29uc3Qgcm9vdFJvdzogUm93IHwgdW5kZWZpbmVkID1cbiAgICBzcGVjLnJvb3QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvUm93KHsgLi4uKHNwZWMucm9vdCBhcyBSb290U3BlYyksIG5hbWU6IFwiXCIgfSwgZmFsc2UpO1xuXG4gIC8vIEluZGV4IGV2ZXJ5IHNwZWxsaW5nLCBhbmQgY2hlY2sgdGhlIHRhYmxlIGlzIHdlbGwgZm9ybWVkLlxuICBjb25zdCBieVRva2VuID0gbmV3IE1hcDxzdHJpbmcsIFJvdz4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgY29uc3QgcGFydHMgPSB0LnNwbGl0KFwiIFwiKTtcbiAgICAgIGlmICh0LnRyaW0oKSAhPT0gdCB8fCBwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+IHAgPT09IFwiXCIgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGJhZCBjb21tYW5kIG5hbWUgXCIke3R9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0ICE9PSByLm5hbWUgJiYgcGFydHMubGVuZ3RoICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBuZXN0IGxpa2UgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMiAmJiB0ICE9PSByLm5hbWUgJiYgcGFydHNbMF0gIT09IHIubmFtZS5zcGxpdChcIiBcIilbMF0pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3Qgc2hhcmUgdGhlIGdyb3VwIG9mIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChieVRva2VuLmhhcyh0KSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IFwiJHt0fVwiIGlzIGRlZmluZWQgdHdpY2VgKTtcbiAgICAgIGJ5VG9rZW4uc2V0KHQsIHIpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzdWJzT2YgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBieVRva2VuLmtleXMoKSkge1xuICAgIGNvbnN0IFtncm91cCwgc3ViXSA9IHQuc3BsaXQoXCIgXCIpO1xuICAgIGlmIChncm91cCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdWJzT2Yuc2V0KGdyb3VwLCBbLi4uKHN1YnNPZi5nZXQoZ3JvdXApID8/IFtdKSwgc3ViXSk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgZyBvZiBPYmplY3Qua2V5cyhzcGVjLmdyb3VwcyA/PyB7fSkpIHtcbiAgICBpZiAoIXN1YnNPZi5oYXMoZykpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBncm91cCBcIiR7Z31cIiBoYXMgbm8gc3ViLXZlcmJzYCk7XG4gIH1cblxuICBjb25zdCBwYXRocyA9IFsuLi5ieVRva2VuLmtleXMoKV07XG4gIGNvbnN0IHZlcmJzID0gWy4uLm5ldyBTZXQocGF0aHMubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbiAgY29uc3Qgcm93Rm9yID0gKHBhdGg6IHN0cmluZyk6IFJvdyB8IHVuZGVmaW5lZCA9PiAocGF0aCA9PT0gXCJcIiA/IHJvb3RSb3cgOiBieVRva2VuLmdldChwYXRoKSk7XG4gIGNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gICAgWy4uLihyb3dGb3IocGF0aCk/LmFjY2VwdGVkID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuICBjb25zdCBsYWJlbCA9IChyOiBSb3cpOiBzdHJpbmcgPT4gci5uYW1lIHx8IGNsaU5hbWU7XG5cbiAgLyoqXG4gICAqIEEgdmVyYmxlc3Mgcm9vdCdzIHJlamVjdGlvbiBgY2hvaWNlc2A6IGl0cyBvd24gZmxhZ3MgUExVUyB0aGUgaW50ZXJjZXB0b3JzLFxuICAgKiBiZWNhdXNlIHRoZSBkZWNsYXJhdGlvbiBwdWJsaXNoZXMgYm90aCBhdCBgcGF0aDogW11gIGFuZCB0aGUgcm9vdCBhbnN3ZXJzXG4gICAqIGJvdGggKHRoZSBpbnRlcmNlcHRvcnMgYXMgYGFyZ3ZbMF1gKS4gTGVhdmluZyB0aGUgaW50ZXJjZXB0b3JzIG91dCBtYWRlXG4gICAqIG9uZSBwcm9jZXNzIHNheSB0d28gdGhpbmdzIGFib3V0IGl0cyByb290IOKAlCBhY2MncyBjZW5zdXMgcmVhZCBgLS1oZWxwYCxcbiAgICogYC1oYCwgYC0tdmVyc2lvbmAgYW5kIGAtVmAgYXMgZGVjbGFyZWQtbm90LWFjY2VwdGVkLiBMb25nIHNwZWxsaW5ncyBmaXJzdFxuICAgKiAoc29ydGVkKSwgdGhlbiB0aGUgc2hvcnRzOiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHRcbiAgICogc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy5cbiAgICovXG4gIGNvbnN0IHJvb3RDaG9pY2VzOiBzdHJpbmdbXSA9ICgoKSA9PiB7XG4gICAgY29uc3QgYWxsID0gWy4uLmZsYWdzRm9yKFwiXCIpLCAuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXTtcbiAgICBjb25zdCBsb25nID0gYWxsLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKFwiLS1cIikpLnNvcnQoKTtcbiAgICByZXR1cm4gWy4uLmxvbmcsIC4uLmFsbC5maWx0ZXIoKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCItLVwiKSldO1xuICB9KSgpO1xuXG4gIC8vIOKUgOKUgCBoZWxwIOKUgOKUgFxuXG4gIGNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICAgIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xuICB9O1xuICBjb25zdCByZW5kZXJGbGFnID0gKGs6IHN0cmluZywgcmVxdWlyZWQgPSBmYWxzZSk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgZmxhZyA9IHNwZWMub3B0aW9uc1trXT8udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgLS0ke2t9YCA6IGAtLSR7a30gLi5gO1xuICAgIHJldHVybiByZXF1aXJlZCA/IGZsYWcgOiBgWyR7ZmxhZ31dYDtcbiAgfTtcbiAgY29uc3QgdXNhZ2VMaW5lID0gKHI6IFJvdyk6IHN0cmluZyA9PlxuICAgIFtcbiAgICAgIGxhYmVsKHIpLFxuICAgICAgLi4uci5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgICAuLi5yLmZsYWdzLmZpbHRlcigoaykgPT4gIWhpZGVzLmhhcyhrKSkubWFwKChrKSA9PiByZW5kZXJGbGFnKGssIHIucmVxdWlyZWQuaGFzKGspKSksXG4gICAgXS5qb2luKFwiIFwiKTtcbiAgY29uc3QgZXhwZWN0cyA9IChyOiBSb3cpOiBzdHJpbmcgPT4gYGV4cGVjdHM6ICR7dXNhZ2VMaW5lKHIpfWA7XG5cbiAgY29uc3QgcmVuZGVySGVscCA9ICgpOiBzdHJpbmcgPT4ge1xuICAgIGlmIChzcGVjLmhlbHAgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHNwZWMuaGVscCgpO1xuICAgIGNvbnN0IGxpc3RlZCA9IFsuLi4ocm9vdFJvdyA/IFtyb290Um93XSA6IFtdKSwgLi4ucm93c107XG4gICAgY29uc3QgbGluZXMgPSBsaXN0ZWQubWFwKChyKSA9PiBbdXNhZ2VMaW5lKHIpLCByLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihNYXRoLm1heCguLi5saW5lcy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICAgIGNvbnN0IGJvZHkgPSBsaW5lc1xuICAgICAgLm1hcCgoW3UsIGRdKSA9PlxuICAgICAgICB1Lmxlbmd0aCA8PSB3aWR0aCA/IGAgICR7dS5wYWRFbmQod2lkdGgpfSAgJHtkfWAgOiBgICAke3V9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICAgKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZCA9IHNwZWMuc3VtbWFyeSA/IGAke2NsaU5hbWV9IOKAlCAke3NwZWMuc3VtbWFyeX1gIDogY2xpTmFtZTtcbiAgICBjb25zdCB0b2tlbnMgPSBgICAke0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTmA7XG4gICAgcmV0dXJuIGAke2hlYWR9XFxuXFxuJHtib2R5fVxcbiR7dG9rZW5zfSR7c3BlYy5oZWxwRm9vdGVyID8gYFxcblxcbiR7c3BlYy5oZWxwRm9vdGVyfWAgOiBcIlwifWA7XG4gIH07XG5cbiAgLyoqXG4gICAqIE9uZSByb3cncyBoZWxwOiBpdHMgdXNhZ2UgbGluZSwgd2hhdCBpdCBkb2VzICh3aGVuIGl0IHNheXMpLCBlYWNoIGZsYWcgaXRcbiAgICogdGFrZXMgd2l0aCB3aGF0IGl0IGRvZXMsIGFuZCBpdHMgZXhhbXBsZXMuIFRoZSByb3cncyBvd24gZmxhZ3MgY29tZSBmaXJzdDtcbiAgICogdGhlIGBnbG9iYWxGbGFnc2AgZXZlcnkgcm93IHRha2VzIGZvbGxvdyBpbiB0aGVpciBvd24gYmxvY2ssIHRoZW4gYW55XG4gICAqIGB1c2FnZUhpZGVzYCBmbGFnIHRoZSByb3cgYWNjZXB0cywgc28gYSB2ZXJiJ3Mgb3duIGZsYWdzIHJlYWQgb24gdGhlaXIgb3duLlxuICAgKi9cbiAgY29uc3QgcmVuZGVyUm93SGVscCA9IChyOiBSb3cpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGxpbmUgPSAoazogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHNwZWMub3B0aW9uc1trXT8udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgLS0ke2t9YCA6IGAtLSR7a30gPCR7a30+YDtcbiAgICAgIHJldHVybiBbdmFsdWUsIHIuZmxhZ0hlbHBba10gPz8gXCJcIl0gYXMgY29uc3Q7XG4gICAgfTtcbiAgICBjb25zdCBpc0dsb2JhbCA9IChrOiBzdHJpbmcpID0+ICFyLmZsYWdzLmluY2x1ZGVzKGspIHx8IGdsb2JhbHMuaW5jbHVkZXMoayk7XG4gICAgY29uc3Qgb3duID0gci5hY2NlcHRlZC5maWx0ZXIoKGspID0+ICFpc0dsb2JhbChrKSAmJiAhaGlkZXMuaGFzKGspKS5tYXAobGluZSk7XG4gICAgY29uc3QgZ2xvYmFsID0gci5hY2NlcHRlZC5maWx0ZXIoaXNHbG9iYWwpLm1hcChsaW5lKTtcbiAgICAvLyBgdXNhZ2VIaWRlc2AgZmxhZ3MgKGJvdW50eSdzIGAtLXNlc3Npb25gL2AtLWFzYCwgYXN0cm9sYWJlJ3MgbGVnYWN5XG4gICAgLy8gYC0tdGltZW91dGApOiBhY2NlcHRlZCwga2VwdCBvZmYgdGhlIHVzYWdlIGxpbmUsIGxpc3RlZCBhZnRlciB0aGUgcmVzdC5cbiAgICBjb25zdCBoaWRkZW4gPSByLmFjY2VwdGVkLmZpbHRlcigoaykgPT4gIWlzR2xvYmFsKGspICYmIGhpZGVzLmhhcyhrKSkubWFwKGxpbmUpO1xuICAgIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oXG4gICAgICBNYXRoLm1heCgwLCAuLi5bLi4ub3duLCAuLi5nbG9iYWwsIC4uLmhpZGRlbl0ubWFwKChbZl0pID0+IGYubGVuZ3RoKSksXG4gICAgICAyOCxcbiAgICApO1xuICAgIGNvbnN0IHJlbmRlciA9IChmbGFnczogKHJlYWRvbmx5IFtzdHJpbmcsIHN0cmluZ10pW10pID0+XG4gICAgICBmbGFncy5tYXAoKFtmLCBkXSkgPT5cbiAgICAgICAgZCA9PT0gXCJcIlxuICAgICAgICAgID8gYCAgJHtmfWBcbiAgICAgICAgICA6IGYubGVuZ3RoIDw9IHdpZHRoXG4gICAgICAgICAgICA/IGAgICR7Zi5wYWRFbmQod2lkdGgpfSAgJHtkfWBcbiAgICAgICAgICAgIDogYCAgJHtmfVxcbiAgJHtcIlwiLnBhZEVuZCh3aWR0aCl9ICAke2R9YCxcbiAgICAgICk7XG4gICAgcmV0dXJuIFtcbiAgICAgIGB1c2FnZTogJHt1c2FnZUxpbmUocil9YCxcbiAgICAgIC4uLihyLmRlc2NyaWJlICE9PSBcIlwiID8gW1wiXCIsIHIuZGVzY3JpYmVdIDogW10pLFxuICAgICAgLi4uKG93bi5sZW5ndGggPiAwID8gW1wiXCIsIFwiZmxhZ3M6XCIsIC4uLnJlbmRlcihvd24pXSA6IFtdKSxcbiAgICAgIC4uLihnbG9iYWwubGVuZ3RoID4gMCA/IFtcIlwiLCBcImdsb2JhbCBmbGFnczpcIiwgLi4ucmVuZGVyKGdsb2JhbCldIDogW10pLFxuICAgICAgLi4uKGhpZGRlbi5sZW5ndGggPiAwID8gW1wiXCIsIFwiYWxzbyBhY2NlcHRlZDpcIiwgLi4ucmVuZGVyKGhpZGRlbildIDogW10pLFxuICAgICAgLi4uKHIuZXhhbXBsZXMubGVuZ3RoID4gMCA/IFtcIlwiLCBcImV4YW1wbGVzOlwiLCAuLi5yLmV4YW1wbGVzLm1hcCgoZSkgPT4gYCAgJHtlfWApXSA6IFtdKSxcbiAgICBdLmpvaW4oXCJcXG5cIik7XG4gIH07XG5cbiAgLyoqIE9uZSB2ZXJiJ3MgaGVscCAoYGhlbHAgPHZlcmI+YCk7IGFuIHVua25vd24gdmVyYiBpcyBhIHVzYWdlIGVycm9yIGxpc3RpbmcgdGhlIHZlcmJzLiAqL1xuICBjb25zdCByZW5kZXJWZXJiSGVscCA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHIgPSBieVRva2VuLmdldChwYXRoKTtcbiAgICBpZiAociA9PT0gdW5kZWZpbmVkKVxuICAgICAgcmV0dXJuIGRpZShgaGVscDogbm8gdmVyYiBcIiR7cGF0aH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBwYXRocyxcbiAgICAgICAgaGludDogXCJoZWxwIHdpdGggbm8gdmVyYiBsaXN0cyB0aGVtIGFsbFwiLFxuICAgICAgfSk7XG4gICAgcmV0dXJuIHJlbmRlclJvd0hlbHAocik7XG4gIH07XG5cbiAgLyoqXG4gICAqIERvZXMgYGFyZ3NgIGFzayBmb3IgdGhpcyByb3cncyBoZWxwPyBUSEUgUEFSU0VSIERFQ0lERVMsIHdpdGggbm8gc2hhcGVcbiAgICogcnVsZXM6IG9uZSBzdHJpY3QgcGFyc2Ugb2YgdGhlIE9SSUdJTkFMIGFyZ3YgYWdhaW5zdCB0aGUgd2hvbGUgdGFibGUgcGx1c1xuICAgKiBhIHJlZ2lzdGVyZWQgYGhlbHBgIGJvb2xlYW4gKHNob3J0IGBoYCB1bmxlc3MgYSBzcGVsbCBjbGFpbXMgYC1oYCkuIEl0IGlzXG4gICAqIGEgcmVxdWVzdCBpZmYgdGhhdCBwYXJzZSBzdWNjZWVkcyBBTkQgcmVhZHMgYGhlbHBgIGFzIGFuIG9wdGlvbiB0b2tlbiDigJRcbiAgICogdGhlIGZsYWcgaXRzZWxmLCBuZXZlciBhIHZhbHVlIGl0IHRvb2sgKGAtLW5vdGVzPS0taGVscGApIG5vciB0ZXh0IGFmdGVyXG4gICAqIGAtLWAuIEEgZmFpbGVkIHBhcnNlIGlzIG5vdCBhIHJlcXVlc3Q6IHRoZSBub3JtYWwgcGF0aCB0aGVuIHJlZnVzZXMgdGhlXG4gICAqIG9yaWdpbmFsIGFyZ3YgZXhhY3RseSBhcyBpdCBkaWQgd2hlbiBgLS1oZWxwYCB3YXMgYW4gdW5rbm93biBmbGFnLiBBXG4gICAqIGRhc2gtbGVkIHRva2VuIGluIGEgc3RyaW5nIGZsYWcncyB2YWx1ZSBzbG90IGlzIHRoZSBwYXJzZXIncyBcImFyZ3VtZW50IGlzXG4gICAqIGFtYmlndW91c1wiIGluIHN0cmljdCBtb2RlLCBzbyBgLS1ub3RlcyAtLWhlbHAgW21vcmUgd29yZHNdYCwgYC1xbiAtaGAsXG4gICAqIGAtLW5vdGVzIC0tIC0taGVscGAgYW5kIGV2ZXJ5IG90aGVyIHZhbHVlLXNsb3Qgc2hhcGUgc3RheSBleGl0IDIsIGFuZCB0aGVcbiAgICogY29tbWFuZCBpcyBuZXZlciBkcm9wcGVkIHNpbGVudGx5LiBBcml0eSBhbmQgYGNoZWNrYCBhcmUgTk9UIGNvbnN1bHRlZDpcbiAgICogaGVscCBmb3IgYW4gaW5jb21wbGV0ZSBjb21tYW5kIGlzIHRoZSBwb2ludCBvZiBhc2tpbmcuXG4gICAqL1xuICBjb25zdCBoZWxwT3B0aW9ucyA9IGtub3duLmhhcyhcImhlbHBcIilcbiAgICA/IHVuZGVmaW5lZFxuICAgIDoge1xuICAgICAgICAuLi5wYXJzZU9wdGlvbnMsXG4gICAgICAgIGhlbHA6IHNob3J0VG9LZXkuaGFzKFwiaFwiKVxuICAgICAgICAgID8geyB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCB9XG4gICAgICAgICAgOiB7IHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LCBzaG9ydDogXCJoXCIgfSxcbiAgICAgIH07XG4gIGNvbnN0IGFza3NGb3JIZWxwID0gKHJvdzogUm93LCBhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IGJvb2xlYW4gPT4ge1xuICAgIC8vIEEgc3BlbGwgdGhhdCBkZWNsYXJlcyBpdHMgb3duIGBoZWxwYCBvcHRpb24gb3ducyB0aGUgdG9rZW4gb3V0cmlnaHQuXG4gICAgaWYgKGhlbHBPcHRpb25zID09PSB1bmRlZmluZWQpIHJldHVybiBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyB0b2tlbnMgfSA9IHBhcnNlQXJncyh7XG4gICAgICAgIGFyZ3M6IFsuLi5hcmdzXSxcbiAgICAgICAgb3B0aW9uczogaGVscE9wdGlvbnMsXG4gICAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgICAgYWxsb3dQb3NpdGlvbmFsczogcm93LmFsbG93UG9zaXRpb25hbHMsXG4gICAgICAgIHRva2VuczogdHJ1ZSxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIHRva2Vucy5zb21lKCh0KSA9PiB0LmtpbmQgPT09IFwib3B0aW9uXCIgJiYgdC5uYW1lID09PSBcImhlbHBcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgZGVjbGFyYXRpb24g4pSA4pSAXG5cbiAgY29uc3QgZGVjbGFyYXRpb24gPSAoKTogRGVjbGFyYXRpb24gPT4ge1xuICAgIGNvbnN0IGFyZyA9IChrOiBzdHJpbmcpOiBEZWNsYXJlZEFyZyA9PiAoe1xuICAgICAgbmFtZTogYC0tJHtrfWAsXG4gICAgICB0eXBlOiAoc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWMpLnR5cGUsXG4gICAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW10gPSBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdLFxuICAgICAgICBhcmdzOiBbXG4gICAgICAgICAgLi4uSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgICAgIG5hbWU6IGkubmFtZSxcbiAgICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIgYXMgY29uc3QsXG4gICAgICAgICAgfSkpLFxuICAgICAgICAgIC4uLihyb290Um93ID8gcm9vdFJvdy5hY2NlcHRlZC5tYXAoYXJnKSA6IFtdKSxcbiAgICAgICAgXSxcbiAgICAgICAgcG9zaXRpb25hbHM6IHJvb3RSb3dcbiAgICAgICAgICA/IHJvb3RSb3cucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKVxuICAgICAgICAgIDogW3sgbmFtZTogc3BlYy52ZXJiUG9zaXRpb25hbCA/PyBcImNvbW1hbmRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICAgIGZvciAoY29uc3QgdCBvZiBbci5uYW1lLCAuLi5yLmFsaWFzZXNdKSB7XG4gICAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICAgIHBhdGg6IHQuc3BsaXQoXCIgXCIpLFxuICAgICAgICAgIGFyZ3M6IHIuYWNjZXB0ZWQubWFwKGFyZyksXG4gICAgICAgICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHNjaGVtYVJvdyA9IGJ5VG9rZW4uZ2V0KFwic2NoZW1hXCIpIGFzIFJvdztcbiAgICByZXR1cm4ge1xuICAgICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbc2NoZW1hUm93Lm5hbWVdIH0sXG4gICAgICBjb21tYW5kcyxcbiAgICB9O1xuICB9O1xuXG4gIC8vIOKUgOKUgCBkaXNwYXRjaCDilIDilIBcblxuICAvKipcbiAgICogVGhlIGluZGV4IG9mIHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5laXRoZXIgYSBmbGFnIG5vciBhIHN0cmluZyBmbGFnJ3NcbiAgICogdmFsdWUsIHdhbGtpbmcgdGhlIHdheSB0aGUgcGFyc2VyIHdpbGw6IGAtLWsgdmAgY29uc3VtZXMgYHZgIHdoZW4gYGtgIGlzIGFcbiAgICogc3RyaW5nIGZsYWcsIGAtLWs9dmAgY29uc3VtZXMgbm90aGluZywgYC1zIHZgIGxpa2V3aXNlIGJ5IHRoZSBzaG9ydCdzIHR5cGUuXG4gICAqIEF0IGEgYmFyZSBgLS1gOiBgLTFgIHdoZW4gYHN0b3BBdFRlcm1pbmF0b3JgLCBlbHNlIHRoZSBpbmRleCBhZnRlciBpdC5cbiAgICovXG4gIGNvbnN0IHNjYW5Qb3NpdGlvbmFsID0gKGFyZ3M6IHN0cmluZ1tdLCBzdG9wQXRUZXJtaW5hdG9yOiBib29sZWFuKTogbnVtYmVyID0+IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGEgPSBhcmdzW2ldIGFzIHN0cmluZztcbiAgICAgIGlmIChhID09PSBcIi0tXCIpIHJldHVybiBzdG9wQXRUZXJtaW5hdG9yIHx8IGkgKyAxID49IGFyZ3MubGVuZ3RoID8gLTEgOiBpICsgMTtcbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItLVwiKSkge1xuICAgICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoc3BlYy5vcHRpb25zW2Euc2xpY2UoMildPy50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGEuc3RhcnRzV2l0aChcIi1cIikgJiYgYS5sZW5ndGggPiAxKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGEubGVuZ3RoID09PSAyID8gc2hvcnRUb0tleS5nZXQoYS5zbGljZSgxKSkgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBzcGVjLm9wdGlvbnNba2V5XT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBpO1xuICAgIH1cbiAgICByZXR1cm4gLTE7XG4gIH07XG5cbiAgY29uc3Qgd2l0aG91dCA9IChhcmdzOiBzdHJpbmdbXSwgaTogbnVtYmVyKTogc3RyaW5nW10gPT4gW1xuICAgIC4uLmFyZ3Muc2xpY2UoMCwgaSksXG4gICAgLi4uYXJncy5zbGljZShpICsgMSksXG4gIF07XG5cbiAgY29uc3Qgbm9Db21tYW5kID0gKCk6IG5ldmVyID0+XG4gICAgZGllKFwiZXhwZWN0ZWQgYSBjb21tYW5kXCIsIFwidXNhZ2VcIiwge1xuICAgICAgY2hvaWNlczogWy4uLnZlcmJzXSxcbiAgICAgIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIChvciAtLWhlbHApIGZvciB1c2FnZWAsXG4gICAgfSk7XG5cbiAgLyoqIEEgdmVyYiBjYW5kaWRhdGUgYW5kIHRoZSBhcmdzIGFmdGVyIGl0LCB0byBhIHJvdyBhbmQgdGhhdCByb3cncyBhcmdzLiAqL1xuICBjb25zdCByZXNvbHZlID0gKGNhbmQ6IHN0cmluZywgcmVzdDogc3RyaW5nW10pOiB7IHJvdzogUm93OyB0b2tlbjogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXSB9ID0+IHtcbiAgICBjb25zdCBzdWJzID0gc3Vic09mLmdldChjYW5kKTtcbiAgICBpZiAoc3VicyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhdCA9IHNwZWMuZ3JvdXBzPy5bY2FuZF0/LnN1YlZlcmJBdCA/PyBcImFkamFjZW50XCI7XG4gICAgICBsZXQgaSA9IC0xO1xuICAgICAgaWYgKGF0ID09PSBcImFkamFjZW50XCIpIHtcbiAgICAgICAgY29uc3QgbmV4dCA9IHJlc3RbMF07XG4gICAgICAgIGkgPSBuZXh0ICE9PSB1bmRlZmluZWQgJiYgIW5leHQuc3RhcnRzV2l0aChcIi1cIikgPyAwIDogLTE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpID0gc2NhblBvc2l0aW9uYWwocmVzdCwgdHJ1ZSk7XG4gICAgICB9XG4gICAgICBjb25zdCBzdWIgPSBpID49IDAgPyAocmVzdFtpXSBhcyBzdHJpbmcpIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgZnVsbCA9IHN1YiA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogYnlUb2tlbi5nZXQoYCR7Y2FuZH0gJHtzdWJ9YCk7XG4gICAgICBpZiAoZnVsbCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiB7IHJvdzogZnVsbCwgdG9rZW46IGAke2NhbmR9ICR7c3VifWAsIGFyZ3M6IHdpdGhvdXQocmVzdCwgaSkgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG93biA9IGJ5VG9rZW4uZ2V0KGNhbmQpO1xuICAgICAgaWYgKG93biAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyByb3c6IG93biwgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgICAgIGNvbnN0IGV4dHJhID0geyBjaG9pY2VzOiBbLi4uc3Vic10sIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIGZvciB1c2FnZWAgfTtcbiAgICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCkgZGllKGAke2NhbmR9OiBleHBlY3RlZCBhIHN1Yi1jb21tYW5kYCwgXCJ1c2FnZVwiLCBleHRyYSk7XG4gICAgICBkaWUoYHVua25vd24gJHtjYW5kfSBzdWItY29tbWFuZDogXCIke3N1Yn1cImAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgIH1cbiAgICBjb25zdCByb3cgPSBieVRva2VuLmdldChjYW5kKTtcbiAgICBpZiAocm93ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRpZShgdW5rbm93biBjb21tYW5kIFwiJHtjYW5kfVwiYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICAgIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIGZvciB1c2FnZWAsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcm93LCB0b2tlbjogY2FuZCwgYXJnczogcmVzdCB9O1xuICB9O1xuXG4gIC8qKlxuICAgKiBDb250cmFjdCA1J3MgYC0tYCBtYWRlIHRoZSBjYWxsZXIncyBmbGFnIFRFWFQ7IHNheSBzbyAoYzEsXG4gICAqIGBkb2NzL2l0ZW1zL19hcmNoaXZlL3Rlcm1pbmF0b3ItZWF0cy1zZXNzaW9uLWtleS5tZGApLiBBIHBvc3QtYC0tYCB0b2tlbiB0aGF0IHNwZWxsc1xuICAgKiBhIGZsYWcgdGhpcyByb3cgYWNjZXB0cyDigJQgYC0ta2AsIGAtLWs9dmAsIG9yIHRoZSBzaG9ydCBgLXNgIG9mIGFuIGFjY2VwdGVkXG4gICAqIGBrYCwgZ2xvYmFscyBpbmNsdWRlZCDigJQgaXMgbmFtZWQgaW4gT05FIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciwgd2l0aFxuICAgKiB0aGUgbW92ZSB0aGF0IHJlY292ZXJzIGl0LiBTdGRvdXQgYW5kIHRoZSBleGl0IGNvZGUgZG8gbm90IGNoYW5nZSwgYW5kIHRoZVxuICAgKiByb3cgc3RpbGwgcnVuczogdGV4dCBjb250YWluaW5nIGEgZmxhZyBuYW1lIGlzIGxlZ2l0aW1hdGUsIHdoaWNoIGlzIHdoYXRcbiAgICogYC0tYCBpcyBmb3IuIEEgdG9rZW4gdGhlIHJvdyBkb2VzIG5vdCBhY2NlcHQgaXMganVzdCB0ZXh0LCBhbmQgc2F5cyBub3RoaW5nLlxuICAgKlxuICAgKiDimqAgQ2FsbGVkIG9ubHkgb25jZSBldmVyeSByZWZ1c2FsIGhhcyBwYXNzZWQsIHNvIGEgcmVmdXNlZCBpbnZvY2F0aW9uJ3NcbiAgICogc3RkZXJyIGlzIHN0aWxsIGV4YWN0bHkgb25lIGVudmVsb3BlLiBUaGUgYCMgYCBwcmVmaXggaXMgdGhlIGhvdXNlJ3NcbiAgICogc3VjY2Vzcy1wYXRoIHN0ZGVyciBmb3JtIChgIyB3YXJuaW5nOmAgaW4gbWluZC1tYXBwZXIsIGAjIHBpbm5lZCBib2FyZGAsXG4gICAqIGAjIOKGkiBjaGFubmVsYCk6IGFuIGVudmVsb3BlIHJlYWRlciBsb29rcyBmb3IgYSBge2AgbGluZSBhbmQgc2tpcHMgaXQuXG4gICAqL1xuICBjb25zdCB3YXJuRGVtb3RlZCA9IChcbiAgICByb3c6IFJvdyxcbiAgICBhY2NlcHRlZDogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbiAgICB0b2tlbnM6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz5bXCJ0b2tlbnNcIl0sXG4gICk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGVuZCA9IHRva2Vucz8uZmluZEluZGV4KCh0KSA9PiB0LmtpbmQgPT09IFwib3B0aW9uLXRlcm1pbmF0b3JcIikgPz8gLTE7XG4gICAgaWYgKHRva2VucyA9PT0gdW5kZWZpbmVkIHx8IGVuZCA8IDApIHJldHVybjtcbiAgICBjb25zdCBkZW1vdGVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgdCBvZiB0b2tlbnMuc2xpY2UoZW5kICsgMSkpIHtcbiAgICAgIGlmICh0LmtpbmQgIT09IFwicG9zaXRpb25hbFwiKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHYgPSB0LnZhbHVlO1xuICAgICAgbGV0IGtleTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKHYuc3RhcnRzV2l0aChcIi0tXCIpKSBrZXkgPSB2LnNsaWNlKDIpLnNwbGl0KFwiPVwiKVswXTtcbiAgICAgIGVsc2UgaWYgKHYubGVuZ3RoID09PSAyICYmIHYuc3RhcnRzV2l0aChcIi1cIikpIGtleSA9IHNob3J0VG9LZXkuZ2V0KHYuc2xpY2UoMSkpO1xuICAgICAgaWYgKGtleSAhPT0gdW5kZWZpbmVkICYmIGtleSAhPT0gXCJcIiAmJiBhY2NlcHRlZC5oYXMoa2V5KSkgZGVtb3RlZC5wdXNoKHYpO1xuICAgIH1cbiAgICBpZiAoZGVtb3RlZC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCB3aGljaCA9IGRlbW90ZWQuam9pbihcIiwgXCIpO1xuICAgIGNvbnN0IG9uZSA9IGRlbW90ZWQubGVuZ3RoID09PSAxO1xuICAgIGNvbnN0IGl0ID0gb25lID8gXCJpdFwiIDogXCJ0aGVtXCI7XG4gICAgY29uc3Qgd2FzID0gb25lID8gXCJ3YXNcIiA6IFwid2VyZVwiO1xuICAgIGNvbnN0IGFzRmxhZyA9IG9uZSA/IFwiYXMgYSBmbGFnXCIgOiBcImFzIGZsYWdzXCI7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgIyB3YXJuaW5nOiAke2NsaU5hbWV9JHtyb3cubmFtZSA9PT0gXCJcIiA/IFwiXCIgOiBgICR7cm93Lm5hbWV9YH06ICR7d2hpY2h9IGFmdGVyIFxcYC0tXFxgICR7d2FzfSByZWFkIGFzIHRleHQsIG5vdCAke2FzRmxhZ307IHRvIHVzZSAke2l0fSAke2FzRmxhZ30sIG1vdmUgJHtpdH0gYmVmb3JlIFxcYC0tXFxgXFxuYCxcbiAgICApO1xuICB9O1xuXG4gIGNvbnN0IHJ1blJvdyA9IGFzeW5jIChyb3c6IFJvdywgdG9rZW46IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4gPT4ge1xuICAgIHNldEN1cnJlbnRDb21tYW5kKHJvdy5uYW1lID09PSBcIlwiID8gbnVsbCA6IHJvdy5uYW1lKTtcbiAgICBjb25zdCBuYW1lID0gbGFiZWwocm93KTtcbiAgICAvLyBgPHZlcmI+IC0taGVscGAgKG9yIGAtaGAsIHVubGVzcyB0aGUgc3BlbGwgZ2F2ZSBgLWhgIGEgZmxhZyBvZiBpdHMgb3duKSBpc1xuICAgIC8vIGBoZWxwIDx2ZXJiPmA6IGFza2VkIGJlZm9yZSBhbnl0aGluZyBlbHNlIGlzIGNoZWNrZWQuIEV2ZXJ5IHJvdyBhbnN3ZXJzXG4gICAgLy8gaXQg4oCUIHRoZSBhdXRvIHJvd3MgKGBoZWxwIC0taGVscGAsIGBzY2hlbWEgLS1oZWxwYCkgYW5kIGEgdmVyYmxlc3Mgcm9vdFxuICAgIC8vIChgZGlnZXN0aWZ5IC0tZmlsZSB4IC0taGVscGApIGluY2x1ZGVkLiBgYXNrc0ZvckhlbHBgIG5hbWVzIHRoZSBvbmUgcGxhY2VcbiAgICAvLyBhIGAtLWhlbHBgIHRva2VuIGlzIG5vdCBhIHJlcXVlc3QuXG4gICAgaWYgKGFza3NGb3JIZWxwKHJvdywgYXJncykpIHtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3JlbmRlclJvd0hlbHAocm93KX1cXG5gKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgICBjb25zdCBhY2NlcHRlZCA9IG5ldyBTZXQocm93LmFjY2VwdGVkKTtcbiAgICBjb25zdCBjaG9pY2VzID0gcm93Lm5hbWUgPT09IFwiXCIgPyByb290Q2hvaWNlcyA6IGZsYWdzRm9yKHJvdy5uYW1lKTtcbiAgICBjb25zdCBmbGFnSGludCA9ICgpOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cbiAgICAgIFtyb3cucmVqZWN0SGludCwgY2hvaWNlcy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBmbGFnc2AgOiB1bmRlZmluZWRdXG4gICAgICAgIC5maWx0ZXIoKHMpOiBzIGlzIHN0cmluZyA9PiBzICE9PSB1bmRlZmluZWQpXG4gICAgICAgIC5qb2luKFwiOyBcIikgfHwgdW5kZWZpbmVkO1xuXG4gICAgbGV0IHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgbGV0IHBvc2l0aW9uYWxzOiBzdHJpbmdbXTtcbiAgICBsZXQgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdO1xuICAgIHRyeSB7XG4gICAgICAoeyB2YWx1ZXMsIHBvc2l0aW9uYWxzLCB0b2tlbnMgfSA9IHBhcnNlQXJncyh7XG4gICAgICAgIGFyZ3MsXG4gICAgICAgIG9wdGlvbnM6IHBhcnNlT3B0aW9ucyxcbiAgICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgICBhbGxvd1Bvc2l0aW9uYWxzOiByb3cuYWxsb3dQb3NpdGlvbmFscyxcbiAgICAgICAgdG9rZW5zOiB0cnVlLFxuICAgICAgfSkpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlcnJDb2RlKGUpID09PSBcIkVSUl9QQVJTRV9BUkdTX1VOS05PV05fT1BUSU9OXCIpIHtcbiAgICAgICAgZGllKGAke25hbWV9OiAke2Vyck1lc3NhZ2UoZSl9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXMsIGhpbnQ6IGZsYWdIaW50KCkgfSk7XG4gICAgICB9XG4gICAgICAvLyBBIG1pc3NpbmcgdmFsdWUgaXMgbm90IGEgY2hvaWNlIGZyb20gYSBzZXQsIHNvIG5vIGBjaG9pY2VzYCBoZXJlLlxuICAgICAgZGllKGAke25hbWV9OiAke2Vyck1lc3NhZ2UoZSl9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IHJvdy5yZWplY3RIaW50ID8/IGV4cGVjdHMocm93KSB9KTtcbiAgICB9XG5cbiAgICAvLyBTdGFnZSAyOiBrbm93biB0byB0aGUgc3BlbGwsIG5vdCB0YWtlbiBieSB0aGlzIHJvdyDigJQgTUlTUExBQ0VELCBub3RcbiAgICAvLyB1bmtub3duLiBPbmx5IGZsYWdzIHRoZSBjYWxsZXIgR0FWRSBhcmUgaGVyZTogZGVmYXVsdHMgYXJlIG5vdCBhcHBsaWVkIHlldC5cbiAgICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKHZhbHVlcykuZmluZCgoaykgPT4gIWFjY2VwdGVkLmhhcyhrKSk7XG4gICAgaWYgKHN0cmF5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7bmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCAke2NsaU5hbWV9IGZsYWcsIGp1c3Qgbm90IHRoaXMgJHtyb3cubmFtZSA9PT0gXCJcIiA/IFwiY29tbWFuZFwiIDogXCJ2ZXJiXCJ9J3MpYCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGNob2ljZXMsIGhpbnQ6IGZsYWdIaW50KCkgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQXJpdHksIGZyb20gdGhlIGRlY2xhcmVkIHNoYXBlLCBuYW1pbmcgdGhlIG1pc3Npbmcgb3IgdGhlIGV4dHJhIHRva2VuLlxuICAgIGNvbnN0IHJlcXVpcmVkID0gcm93LnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICAgIGNvbnN0IHZhcmlhZGljID0gcm93LnBvc2l0aW9uYWxzLnNvbWUoKHApID0+IHAudmFyaWFkaWMpO1xuICAgIGlmIChwb3NpdGlvbmFscy5sZW5ndGggPCByZXF1aXJlZCkge1xuICAgICAgY29uc3QgbWlzc2luZyA9IHJvdy5wb3NpdGlvbmFsc1twb3NpdGlvbmFscy5sZW5ndGhdO1xuICAgICAgZGllKGAke25hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIDwke21pc3Npbmc/Lm5hbWUgPz8gXCJhcmd1bWVudFwifT5gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogZXhwZWN0cyhyb3cpLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmICghdmFyaWFkaWMgJiYgcG9zaXRpb25hbHMubGVuZ3RoID4gcm93LnBvc2l0aW9uYWxzLmxlbmd0aCkge1xuICAgICAgZGllKFxuICAgICAgICBgJHtuYW1lfTogdW5leHBlY3RlZCBhcmd1bWVudCAke0pTT04uc3RyaW5naWZ5KHBvc2l0aW9uYWxzW3Jvdy5wb3NpdGlvbmFscy5sZW5ndGhdKX1gLFxuICAgICAgICBcInVzYWdlXCIsXG4gICAgICAgIHsgaGludDogcm93LnBvc2l0aW9uYWxzLmxlbmd0aCA9PT0gMCA/IGAke25hbWV9IHRha2VzIG5vIGFyZ3VtZW50c2AgOiBleHBlY3RzKHJvdykgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gRGVmYXVsdHMgbGFzdCwgYW5kIG9ubHkgdGhpcyByb3cncy5cbiAgICBjb25zdCBmbGFnczogUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPiA9IHsgLi4uKHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBGbGFnVmFsdWU+KSB9O1xuICAgIGZvciAoY29uc3QgayBvZiByb3cuYWNjZXB0ZWQpIHtcbiAgICAgIGNvbnN0IGQgPSAoc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWMpLmRlZmF1bHQ7XG4gICAgICBpZiAoZmxhZ3Nba10gPT09IHVuZGVmaW5lZCAmJiBkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZmxhZ3Nba10gPSAoQXJyYXkuaXNBcnJheShkKSA/IFsuLi5kXSA6IGQpIGFzIEZsYWdWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGsgb2Ygcm93LnJlcXVpcmVkKVxuICAgICAgaWYgKGZsYWdzW2tdID09PSB1bmRlZmluZWQpXG4gICAgICAgIGRpZShgJHtuYW1lfTogbWlzc2luZyByZXF1aXJlZCAtLSR7a31gLCBcInVzYWdlXCIsIHsgaGludDogZXhwZWN0cyhyb3cpIH0pO1xuXG4gICAgY29uc3QgaW52OiBJbnZvY2F0aW9uID0geyBwYXRoOiByb3cubmFtZSwgdG9rZW4sIHBvczogcG9zaXRpb25hbHMsIGZsYWdzIH07XG4gICAgY29uc3QgcmVmdXNlZCA9IHJvdy5jaGVjaz8uKGludik7XG4gICAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCkgZGllKGAke25hbWV9OiAke3JlZnVzZWR9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IGV4cGVjdHMocm93KSB9KTtcblxuICAgIHdhcm5EZW1vdGVkKHJvdywgYWNjZXB0ZWQsIHRva2Vucyk7XG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgcm93LnJ1bihpbnYpO1xuICAgIHJldHVybiB0eXBlb2Ygb3V0ID09PSBcIm51bWJlclwiID8gb3V0IDogMDtcbiAgfTtcblxuICBjb25zdCBkaXNwYXRjaCA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgICBjb25zdCBmaXJzdCA9IGFyZ3ZbMF07XG5cbiAgICAvLyAxLiBJbnRlcmNlcHRvcnMgcGFzcyB0aGUgcmVzdCBvZiB0aGUgYXJndiBvbiB0byB0aGVpciByb3cuXG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBJTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBmaXJzdCk7XG4gICAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBydW5Sb3coYnlUb2tlbi5nZXQoaW50ZXJjZXB0b3IucnVucykgYXMgUm93LCBpbnRlcmNlcHRvci5ydW5zLCBhcmd2LnNsaWNlKDEpKTtcbiAgICB9XG5cbiAgICAvLyAyLiBBIHZlcmJsZXNzIHJvb3Qgb3ducyBldmVyeSBhcmd2IHRoYXQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlc2VydmVkIHRva2VuLlxuICAgIGlmIChyb290Um93ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkICYmIChieVRva2VuLmhhcyhmaXJzdCkgfHwgc3Vic09mLmhhcyhmaXJzdCkpKSB7XG4gICAgICAgIGNvbnN0IHIgPSByZXNvbHZlKGZpcnN0LCBhcmd2LnNsaWNlKDEpKTtcbiAgICAgICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBydW5Sb3cocm9vdFJvdywgXCJcIiwgYXJndik7XG4gICAgfVxuXG4gICAgLy8gMy4gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMikuXG4gICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcblxuICAgIC8vIDQuIEZpbmQgdGhlIHZlcmIuXG4gICAgbGV0IGNhbmQ6IHN0cmluZztcbiAgICBsZXQgcmVzdDogc3RyaW5nW107XG4gICAgaWYgKGdyYW1tYXIgPT09IFwidmVyYi1maXJzdFwiKSB7XG4gICAgICBpZiAoZmlyc3QgPT09IFwiLS1cIikge1xuICAgICAgICBpZiAoYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICAgIGNhbmQgPSBhcmd2WzFdO1xuICAgICAgICByZXN0ID0gW1wiLS1cIiwgLi4uYXJndi5zbGljZSgyKV07XG4gICAgICB9IGVsc2UgaWYgKGZpcnN0LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgIHJldHVybiBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtmaXJzdH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke3ZlcmJzLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZCA9IGZpcnN0O1xuICAgICAgICByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IHNjYW5Qb3NpdGlvbmFsKGFyZ3YsIGZhbHNlKTtcbiAgICAgIGlmIChpIDwgMCkge1xuICAgICAgICAvLyBObyB2ZXJiIGFueXdoZXJlOiBhbiB1bmtub3duIGZsYWcgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LFxuICAgICAgICAvLyBhbmQgYSBjbGVhbiBwYXJzZSBpcyBhIGJhcmUgaW52b2NhdGlvbi4gTmVpdGhlciByYW4gYSBjb21tYW5kLCBzb1xuICAgICAgICAvLyB0aGUgZW52ZWxvcGUncyBgbWV0YS5jb21tYW5kYCBpcyBudWxsLCBub3QgdGhlIGZpcnN0IGZsYWcnc1xuICAgICAgICAvLyBzcGVsbGluZyAoYGdsYW1vdXIgLS1ib2d1c2AgbmFtZXMgbm8gdmVyYikuXG4gICAgICAgIHNldEN1cnJlbnRDb21tYW5kKG51bGwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IHBhcnNlT3B0aW9ucywgc3RyaWN0OiB0cnVlLCBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgZGllKGVyck1lc3NhZ2UoZSksIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgICAgaGludDogYG5vIGNvbW1hbmQgZ2l2ZW4g4oCUIGNvbW1hbmRzOiAke3ZlcmJzLmpvaW4oXCIgXCIpfSAocnVuOiAke2NsaU5hbWV9IGhlbHApYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICB9XG4gICAgICBjYW5kID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgICAvLyBBIHZlcmIgZm91bmQgcmlnaHQgYWZ0ZXIgYSBgLS1gIGxlYXZlcyB0aGF0IGAtLWAgaW4gcGxhY2UsIHNvIHRoZVxuICAgICAgLy8gcmVzdCBvZiB0aGUgYXJndiBzdGF5cyBwb3NpdGlvbmFsLlxuICAgICAgcmVzdCA9IHdpdGhvdXQoYXJndiwgaSk7XG4gICAgfVxuICAgIHNldEN1cnJlbnRDb21tYW5kKGNhbmQpO1xuICAgIGNvbnN0IHIgPSByZXNvbHZlKGNhbmQsIHJlc3QpO1xuICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gIH07XG5cbiAgY29uc3QgbWFpbiA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgICAvLyBUaGUgaG91c2UgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuIEEgc3BlbGwgdGhhdFxuICAgICAgLy8gdHJpYWdlcyBpdHMgb3duIChnbGFtb3VyJ3MgRU5PRU5UIOKGkiB1c2FnZSkgY2FsbHMgYGRpc3BhdGNoYCBpbnN0ZWFkLlxuICAgICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIGVyck1lc3NhZ2UoZSkpKSA/PyAxO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2aWV3ID0gKHI6IFJvdyk6IFJvd1ZpZXcgPT4gKHtcbiAgICBuYW1lOiByLm5hbWUsXG4gICAgYWxpYXNlczogci5hbGlhc2VzLFxuICAgIGZsYWdzOiByLmZsYWdzLFxuICAgIGFjY2VwdGVkOiByLmFjY2VwdGVkLFxuICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLFxuICAgIGRlc2NyaWJlOiByLmRlc2NyaWJlLFxuICAgIGF1dG86IHIuYXV0byxcbiAgfSk7XG5cbiAgT2JqZWN0LmFzc2lnbihjbGksIHtcbiAgICBuYW1lOiBjbGlOYW1lLFxuICAgIG1haW4sXG4gICAgZGlzcGF0Y2gsXG4gICAgZGVjbGFyYXRpb24sXG4gICAgcmVuZGVySGVscCxcbiAgICByZW5kZXJWZXJiSGVscCxcbiAgICB1c2FnZU9mOiAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByID0gcm93Rm9yKHBhdGgpO1xuICAgICAgcmV0dXJuIHIgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiB1c2FnZUxpbmUocik7XG4gICAgfSxcbiAgICB2ZXJicyxcbiAgICBwYXRocyxcbiAgICBmbGFnc0ZvcixcbiAgICByZWNvZ25pemVkRmxhZ3M6IG9wdGlvbktleXMubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgcm93czogcm93cy5tYXAodmlldyksXG4gIH0gc2F0aXNmaWVzIENsaSk7XG4gIHJldHVybiBjbGk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8vIFNlc3Npb24gZW5kaW5ncyBhcmUgb3V0Y29tZXMsIG5vdCBmYWlsdXJlcywgYW5kIHN0YXkgb3V0c2lkZSB0aGUgdGF4b25vbXk6XG4vLyBhbiBhZ2VudCByZWFkcyB0aGVtIGFzIFwidGhlIHNlc3Npb24gZW5kZWQgdGhpcyB3YXlcIiwgbm90IFwidGhlIHZlcmIgYnJva2VcIi5cbi8vIFRoZSBudW1iZXJzIGFyZSB0aGUgc2hlbGwncyAoYHRpbWVvdXRgJ3MgMTI0LCBTSUdJTlQncyAxMjggKyAyKSwgc28gYVxuLy8gd3JhcHBlciB0aGF0IGFscmVhZHkga25vd3MgdGhlbSBuZWVkcyBubyB0YWJsZS5cbi8qKiBBIGRhZW1vbiB0aGF0IGNsb3NlZCBpdHNlbGYgYWZ0ZXIgaXRzIGlkbGUgdGltZW91dC4gQW4gb3V0Y29tZSwgbm90IGEgZmFpbHVyZS4gKi9cbmV4cG9ydCBjb25zdCBFWElUX0lETEVfVElNRU9VVCA9IDEyNDtcbi8qKiBUaGUgdXNlciBjYW5jZWxsZWQuIEFuIG91dGNvbWUsIG5vdCBhIGZhaWx1cmUuICovXG5leHBvcnQgY29uc3QgRVhJVF9DQU5DRUxMRUQgPSAxMzA7XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGB0b2tlbmAgaXMgYSBzdGFibGUgbWFjaGluZS1yZWFkYWJsZSBuYW1lXG4gKiBmb3IgdGhlIGNhdXNlIChgbm9fc2Vzc2lvbmApLCBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyB0b2tlbj86IHN0cmluZzsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLy8gT25seSBwcmVzZW50IHdoZW4gZ2l2ZW4sIHNvIGFuIGVudmVsb3BlIHdpdGhvdXQgb25lIGtlZXBzIGl0cyBieXRlcy5cbiAgICAgIC4uLihleHRyYT8udG9rZW4gPyB7IHRva2VuOiBleHRyYS50b2tlbiB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2l0ZW1zL19hcmNoaXZlL3RhaWwtcmVhZGVyLWNvbnZlcmdlbmNlL3dyaXRlLXVwLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2l0ZW1zL19hcmNoaXZlL3NjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pdGVtcy9fYXJjaGl2ZS9tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwvd3JpdGUtdXAubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIChhc3Ryb2xhYmUsIGdyYXBldmluZSkgYWx3YXlzIGdldHNcbiAqICAgICBgdGFpbC53aW5kb3dgOiBhIHN0b3Atc3RhcnQgdGFpbCB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHNcbiAqICAgICBjb25uZWN0aW9uIGNhcnJpZXMuIE1pbmQtbWFwcGVyIHdhcyBvbmUgYW5kIGlzIG5vdCBzaW5jZSAyMDI2LTA5LTI0XG4gKiAgICAgKHNlZSBcIk1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMU1wiIGJlbG93KS5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzIGFuZCBtaW5kLW1hcHBlciksIGVhY2ggbmFtaW5nIGhvdyB0b1xuICogY29tZSBiYWNrIGluc3RlYWQgb2YgYSByZS1hcm0uIEEgc2lnbmFsIG9yIGEgY2FsbGVyJ3MgYWJvcnQgcHJpbnRzIG5vdGhpbmcuXG4gKlxuICogRXZlcnkgcmUtYXJtIGNhcnJpZXMgYC0tc2luY2UgPGN1cnNvcj5gLCBzbyBub3RoaW5nIHJlcGxheXM7IHRoZSBkYWVtb24nc1xuICogYnVmZmVyIGNvdmVycyB3aGF0ZXZlciBsYW5kcyBiZXR3ZWVuIG9uZSB3YXRjaCdzIGV4aXQgYW5kIHRoZSBuZXh0J3MgYXJtLlxuICpcbiAqIOKUgOKUgCBERUNJU0lPTiBMT0cgKGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCAyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBLaXQgZGVjaXNpb25zIGxpdmUgaW4gbW9kdWxlIGhlYWRlcnMgKHRoZSBhcmNoaXRlY3R1cmUgZG9jJ3Mgwqc0IHJ1bGU6IFwiZWFjaFxuICogbW9kdWxlJ3MgaGVhZGVyIGlzIHRoZSBhdXRob3JpdGF0aXZlIGFjY291bnRcIikuIFJ1bGVkIGJ5IENvbGU6IHRoZSBoeWJyaWQsXG4gKiB0aGUgYWx3YXlzLWJvb2ttYXJrLCBwcmVzZW5jZSBzcGVsbHMgYWx3YXlzIHJlLWFybSBNb25pdG9yLCBib3VudHkncyBleGFtcGxlXG4gKiBmaXhlZC4gVGhlIGZvdXIgYWRqdXN0bWVudHMgd2VyZSB0aGUgc3Bpa2UncyByZXF1aXJlbWVudHMuIFRoZSByZXN0IGFyZSB0aGVcbiAqIGltcGxlbWVudGVyJ3MgcnVsaW5ncywgbWFya2VkIOKaliB3aXRoIHRoZSBvcHRpb25zIG5vdCB0YWtlbi5cbiAqXG4gKiBBMSDCtyBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTi4gYHRhaWxFdmVudHNgIG5vdyBhYm9ydHMgdGhlXG4gKiAgICAgIGluLWZsaWdodCBmZXRjaCBiZWZvcmUgaXQgcmV0dXJucyBvbiBhIHRlcm1pbmFsIGZyYW1lLiBCZWZvcmUsIGl0XG4gKiAgICAgIHJldHVybmVkIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3AgYW5kIGxlZnQgdGhlIFNTRSBzdHJlYW0gb3Blbiwgc28gdGhlXG4gKiAgICAgIHByb2Nlc3Mgc3RheWVkIGFsaXZlOiB1bnNlZW4gZm9yIGBjbG9zZWRgICh0aGUgc2VydmVyIGVuZHMgdGhhdFxuICogICAgICBzdHJlYW0gaXRzZWxmKSBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2sgd291bGRcbiAqICAgICAgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQsIHNpbGVudGx5LiBQaW5uZWQgaW5cbiAqICAgICAgYHRhaWxIYW5kb2ZmLnRlc3QudHNgIGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBrZWVwcyB0aGUgc3RyZWFtIG9wZW4uXG4gKlxuICogQTIgwrcgVEhFIE5FWFQgQUNUIERFUEVORFMgT04gU1RBVEUuIGBoYW5kb2ZmKClgIGJlbG93IGlzIHRoZSBwdXJlIGRlY2lzaW9uOlxuICogICAgICBxdWlldCDihpIgYmFja2dyb3VuZCwgYWN0aXZlIG9yIHByZXNlbmNlIOKGkiBNb25pdG9yLCB3b2tlIOKGkiBNb25pdG9yLFxuICogICAgICBjbG9zZWQg4oaSIGNvbWUgYmFjaywgbG9zdCDihpIgY29tZSBiYWNrLiBDb21lIGJhY2sgaXMgdGhlIHNwZWxsJ3Mgb3duIHZlcmJcbiAqICAgICAgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCBmb3IgdGhlIHNlc3Npb24gc3BlbGxzLCBgb3BlbiAtLW5vLW9wZW5gIGZvclxuICogICAgICBtaW5kLW1hcHBlciBhbmQgYXN0cm9sYWJlKS5cbiAqICAgICAg4pqWIFRIRSBESVNDT05ORUNUIERFQ0lTSU9OOiBmb3IgYSBzZXNzaW9uIHNwZWxsLCBhIExPU1QgZGFlbW9uIGVuZHMgdGhlXG4gKiAgICAgIHRhaWwgaW4gQk9USCBtb2RlcyB3aXRoIGEgc3Rkb3V0IGB0YWlsLmxvc3RgIGxpbmUuIE1vbml0b3Igbm90aWZpZXMgb25seVxuICogICAgICBvbiBzdGRvdXQsIHNvIHRoZSBvbGQgc3RkZXJyLW9ubHkgYHRhaWwuZGlzY29ubmVjdGVkYCBsZWZ0IGFcbiAqICAgICAgTW9uaXRvci13cmFwcGVkIGFnZW50IHVuYXdhcmUgb2YgYSBga2lsbCAtOWAgKEU1NSdzIHB1cnBvc2UgdW5tZXQpLCBhbmRcbiAqICAgICAgYSBgLS1vbmNlYCBvbiBhIGRlYWQgZGFlbW9uIHdvdWxkIGhhdmUgc2xlcHQgZm9yZXZlci4gXCJMb3N0XCIgaXNcbiAqICAgICAgYExPU1RfQUZURVJfUkVGVVNBTFNgIGNvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3csIG5ldmVyIGEgZHJvcHBlZFxuICogICAgICBzdHJlYW0gYWxvbmU6IGEgbGFwdG9wIHRoYXQgc2xlZXBzIGRyb3BzIHRoZSBzdHJlYW0sIHJlY29ubmVjdHMgb24gdGhlXG4gKiAgICAgIGZpcnN0IHRyeSwgYW5kIG11c3Qgc3RheSBzaWxlbnQuXG4gKiAgICAgICAgTm90IHRha2VuOiAoYSkga2VlcCByZXRyeWluZyBhbmQgb25seSBNT1ZFIHRoZSBkaXNjb25uZWN0IGxpbmUgdG9cbiAqICAgICAgICBzdGRvdXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24gaXMgbmV2ZXIgcmVzcGF3bmVkIGJ5IGl0cyB0YWlsLCBzbyB0aGVcbiAqICAgICAgICByZXRyaWVzIGJ1eSBub3RoaW5nIGFuZCB0aGUgYWdlbnQgaXMgd29rZW4gdG8gYmUgdG9sZCB0byB3YWl0OyAoYilcbiAqICAgICAgICBsZWF2ZSBpdCBvbiBzdGRlcnIg4oCUIHRoZSBkZWZlY3QuXG4gKiAgICAgIOKaliBQcmVzZW5jZSBzcGVsbHMga2VlcCByZXRyeWluZywgYXMgYmVmb3JlOiBncmFwZXZpbmUncyB0YWlsIHJlc3Bhd25zXG4gKiAgICAgIGl0cyBkYWVtb24gYW5kIGFzdHJvbGFiZSdzIGBqb2luYCB3YWl0cyBmb3IgdGhlIGh1bWFuIHRvIHJlb3BlbiB0aGVcbiAqICAgICAgYm9hcmQsIGJvdGggYnkgZGVzaWduLiBUaGVpciBkaXNjb25uZWN0IG5vdGVzIHN0YXkgd2hlcmUgdGhleSB3ZXJlLlxuICpcbiAqIEEzIMK3IFFVSUVUIElTIFRIRSBUQUlMJ1MgT1dOIENPVU5ULiBgZXZlbnRzYCBjb3VudHMgdGhlIGxvZyBmcmFtZXMgdGhpc1xuICogICAgICBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dC4gVGhlIGdyb3VuZGluZyBsaW5lLCBhIHNwZWxsJ3MgYHN1YnNjcmliZWRgXG4gKiAgICAgIG1hcmtlciwgYGVwb2NoLmNoYW5nZWRgIGFuZCB0aGUgaGFuZG9mZiBsaW5lIGl0c2VsZiBhcmUgbm90IGxvZyBmcmFtZXNcbiAqICAgICAgYW5kIGFyZSBub3QgY291bnRlZDogYSBmcmFtZSBjb3VudHMgb25seSBpZiBpdCBjYXJyaWVzIGEgbG9nIGlkIChEMyksXG4gKiAgICAgIGFuZCBgY291bnRzYCBsZXRzIGEgc3BlbGwgZXhjbHVkZSBhIGZyYW1lIHRoYXQgZG9lcyAoZ3JhcGV2aW5lJ3NcbiAqICAgICAgYHN1YnNjcmliZWRgIG1hcmtlciwgd2hpY2ggc2VlZHMgdGhlIGJvb2ttYXJrIGZyb20gYGxhdGVzdF9pZGApLiBBbnkgbG9nIGZyYW1lIGNvdW50cywgdGhlIGRhZW1vbidzIGB3YWl0aW5nYCByZW1pbmRlclxuICogICAgICBpbmNsdWRlZCwgc28gXCJxdWlldFwiIG1lYW5zIG5vdGhpbmcgb24gdGhlIGxvZy5cbiAqICAgICAg4pqWIEEgZnJhbWUgdGhlIHRhaWwncyBvd24gZmlsdGVyIHJlamVjdHMgKGJvdW50eSdzIG93bmVyIHNjb3BlLCBhXG4gKiAgICAgIHNlbGYtZWNobykgaXMgTk9UIGNvdW50ZWQgYW5kIGRvZXMgbm90IGVuZCBhIGAtLW9uY2VgOiBpdCB3YXMgbmV2ZXJcbiAqICAgICAgZGVsaXZlcmVkLCBhbmQgd2FraW5nIG9uIGl0IHdvdWxkIGJlIGEgd2FrZSB3aXRoIG5vdGhpbmcgdG8gYWN0IG9uIOKAlFxuICogICAgICB0aGUgZGVmZWN0IHRoaXMgbW9kdWxlIGV4aXN0cyB0byByZW1vdmUuIFRoZSBjdXJzb3Igc3RpbGwgYWR2YW5jZXNcbiAqICAgICAgcGFzdCBpdCAodGFpbEV2ZW50cycgcnVsZSksIHNvIGl0IG5ldmVyIHJlcGxheXMgZWl0aGVyLlxuICogICAgICBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOyB0aGF0IGhhbGYgbGl2ZXMgaW4gZWFjaFxuICogICAgICBzcGVsbCdzIGB0YWlsYCwgd2hpY2gga25vd3Mgd2hldGhlciBgLS1zaW5jZWAgd2FzIGdpdmVuLlxuICpcbiAqIEE0IMK3IFRIRSBXSU5ET1cuIGBERUZBVUxUX1dJTkRPV19NU2AgPSB0aGUgY2FwIG1pbnVzIGBXSU5ET1dfTUFSR0lOX01TYFxuICogICAgICAoNjAgcyksIHNvIDEsNzQwLDAwMCBtcy4gVGhlIG1hcmdpbiBoYXMgdG8gY292ZXIgdGhlIGdhcCBiZXR3ZWVuIHRoZVxuICogICAgICBoYXJuZXNzIHN0YXJ0aW5nIGl0cyBjbG9jayBhbmQgdGhpcyBwcm9jZXNzIHN0YXJ0aW5nIGl0cyBvd24gKEJ1blxuICogICAgICBzdGFydC11cCwgYSBzZXNzaW9uIGxvb2t1cCwgYSBkYWVtb24gc3Bhd24gb24gdGhlIHNwZWxscyB3aG9zZSBgcmVzb2x2ZWBcbiAqICAgICAgc3Bhd25zIG9uZSDigJQgYm91bmRlZCBieSB0aGVpciBzdGFydCB0aW1lb3V0cywgd2hpY2ggYXJlIHNlY29uZHMpIHBsdXNcbiAqICAgICAgdGhlIGxhc3QgbGluZSdzIGZsdXNoIGFuZCBNb25pdG9yJ3MgMjAwIG1zIGJhdGNoaW5nLiBBIG1pbnV0ZSBjb3ZlcnNcbiAqICAgICAgYWxsIG9mIHRoYXQgbWFueSB0aW1lcyBvdmVyLiBUaGUgc3Bpa2UgbWVhc3VyZWQgYSAxMiBzXG4gKiAgICAgIHdpbmRvdyB1bmRlciBhIDIwIHMgY2FwIGVuZGluZyBjbGVhbmx5OyBub3RoaW5nIGhlcmUgZGVwZW5kcyBvbiBhXG4gKiAgICAgIG1hcmdpbiB0aGF0IHRpZ2h0LiBJZiB0aGUgY2FwIHdpbnMgYW55d2F5LCB0aGUgYWdlbnQgZ2V0cyBNb25pdG9yJ3NcbiAqICAgICAgYmFyZSBleHBpcnkgbm90aWNlIGFuZCByZS1hcm1zIHNpbGVudGx5IGZyb20gdGhlIGxhc3QgaWQgaXQgc2F3IOKAlCB0aGVcbiAqICAgICAgcnVsaW5nJ3MgZmFsbGJhY2ssIHN0YXRlZCBpbiBldmVyeSBza2lsbC5cbiAqICAgICAg4pqWIFRoZSB3aW5kb3cgaXMgaW5qZWN0YWJsZSBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiB0aHJvdWdoXG4gKiAgICAgIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNgIChhIGNvdW50IG9mIG1zOyBgMGAgdHVybnMgdGhlIHdpbmRvdyBvZmYsXG4gKiAgICAgIGZvciBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwpLiBBbiBlbnYgdmFyIGFuZCBub3QgYSBmbGFnOiBpdCBpc1xuICogICAgICBub3QgYW4gYWdlbnQncyBhY3QsIHNvIGl0IHN0YXlzIG91dCBvZiBlaWdodCB2ZXJicycgc2NoZW1hcy5cbiAqXG4gKiDilIDilIAgVEhFIFZFUklGSUVSJ1MgREVGRUNUUywgRklYRUQgT04gVEhFIFNBTUUgQlJBTkNIICgyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbm8tc3Rha2UgdmVyaWZpZXIgcmFuIGV2ZXJ5IHNwZWxsJ3MgcmVhbCB0YWlsIGFuZCBmb3VuZCBmb3VyIHdheXMgdGhlXG4gKiBsb29wIGJyb2tlLiBFYWNoIGhhcyBhIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgOyBEMSBhbmQgRDIgYWxzbyBoYXZlXG4gKiByZWFsLWRhZW1vbiBjZWxscywgaW4gYHNyYy9raXQvd29ya3NwYWNlL3RhaWwtaGFuZG9mZi5jbG9zZWQuaW50ZWdyYXRpb24udGVzdC50c2BcbiAqIChEMSkgYW5kIGB0YWlsLWhhbmRvZmYucmVzdGFydC5pbnRlZ3JhdGlvbi50ZXN0LnRzYCAoRDIpIGJlc2lkZSBpdC5cbiAqXG4gKiBEMSDCtyBBIFJFLUFSTSBBVCBBIFNFU1NJT04gVEhBVCBDTE9TRUQgSU4gVEhFIEdBUCBFTkRTIGB0YWlsLmNsb3NlZGAuIFRoZVxuICogICAgICB0cmlnZ2VyIGlzIG9yZGluYXJ5OiB0aGUgaHVtYW4gcHJlc3NlcyBDbG9zZSB3aGlsZSB0aGUgYWdlbnQgaGFuZGxlc1xuICogICAgICBgdGFpbC53b2tlYC4gVGhlIHNlc3Npb24gc3BlbGxzIHN0b3BwZWQgb25seSB3aGVuIFRISVMgcHJvY2VzcyBoYWRcbiAqICAgICAgb25jZSByZWFjaGVkIHRoZSBzZXNzaW9uLCBzbyB0aGUgcmUtYXJtIHJldHJpZWQgXCJubyBzZXNzaW9uIHlldFwiIG9uXG4gKiAgICAgIHN0ZGVyciBmb3JldmVyIOKAlCBhbmQgaXRzIGAtLW9uY2VgIG5ldmVyIGV4aXRlZC4gUnVsZTogYSB0YWlsIGdpdmVuXG4gKiAgICAgIGAtLXNlc3Npb25gIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HIHNlc3Npb24sIHNvIG5vdFxuICogICAgICBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZDsgdGhlIHNwZWxsJ3MgYG9uVW5yZXNvbHZlZGAgc2F5cyBcInN0b3BcIlxuICogICAgICBhbmQgdGhpcyBtb2R1bGUgcmVhZHMgQU5ZIHN0b3AgYXMgY2xvc2VkLiBBIGJhcmUgZmlyc3QgYXJtIHN0aWxsXG4gKiAgICAgIHdhaXRzIGZvciBhIHNlc3Npb24gdG8gYXBwZWFyLiDimqAgXCJHaXZlblwiIG1lYW5zIE9OIFRIRSBDT01NQU5EIExJTkVcbiAqICAgICAgKHJldmlldyBCMSk6IGJvdW50eSBhbHNvIHJlc29sdmVzIGEgc2Vzc2lvbiBmcm9tXG4gKiAgICAgIGAkQk9VTlRZX1NFU1NJT05fS0VZYCwgYCRCT1VOVFlfU0VTU0lPTmAgb3IgYSBgLmJvdW50eS1zZXNzaW9uYCBmaWxlLFxuICogICAgICB3aGljaCBldmVyeSBhbnRoaWxsIHNlYXQgaGFzLCBhbmQgYSBzZWF0J3MgZmlyc3QgYXJtIG11c3Qgd2FpdC4gQVxuICogICAgICBrZXllZCBib3VudHkgYm9hcmQgY29tZXMgYmFjayBieSBpdHMga2V5IChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKTtcbiAqICAgICAgcmVzdG9yaW5nIGl0IGJ5IGlkIHNwYXducyBhbiB1bmtleWVkIHN0cmF5LlxuICogRDIgwrcgQSBCT09LTUFSSyBDQU5OT1QgT1VUTElWRSBJVFMgTE9HLiBBIHJlc3RvcmVkIGRhZW1vbidzIGlkcyBiZWdpbiBhdCAxLFxuICogICAgICBhbmQgdGhlIGtpdCdzIGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duIGJ5IHJlcGxheWluZyB3aG9sZTtcbiAqICAgICAgdGhlIHRhaWwga2VwdCBpdHMgaGlnaGVyIGN1cnNvciwgc28gZXZlcnkgcmUtYXJtIHJlcGxheWVkIHRoZSBuZXcgbG9nXG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUd28gaGFsdmVzOlxuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVGhyZWUgcGFydHM6XG4gKiAgICAgICAgKGEpIHRoZSBuZXQg4oCUIGB0YWlsRXZlbnRzYCcgYHJlc3RhcnRPblJlcGxheWAsIG9uIGZvciBldmVyeSBzcGVsbCxcbiAqICAgICAgICAgICAgcmVhZHMgYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGFzIGEgcmVzdGFydGVkIGxvZ1xuICogICAgICAgICAgICBhbmQgcmVzZXRzIHRoZSBjdXJzb3I7XG4gKiAgICAgICAgKGIpIHRoZSBydWxlIOKAlCB0aGUgYHRhaWwuY2xvc2VkYC9gdGFpbC5sb3N0YCBoaW50LCBhbmQgZXZlcnkgc2tpbGwsXG4gKiAgICAgICAgICAgIHNheTogcnVuIHRoZSBjb21tYW5kIHRoZSBsaW5lIG5hbWVzLCB0aGVuIHRhaWwgV0lUSCBOT1xuICogICAgICAgICAgICBgLS1zaW5jZWAgKGEgcmVzdG9yZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2c7IGJvdW50eSdzIHJlc3RvcmVcbiAqICAgICAgICAgICAgZXZlbiBtaW50cyBhIG5ldyBpZCk7XG4gKiAgICAgICAgKGMpIFRIRSBFUE9DSCBJTiBUSEUgQk9PS01BUksg4oCUIOKaliBBIFJFVkVSU0FMLiBUaGUgZmlyc3QgdmVyc2lvbiBvZlxuICogICAgICAgICAgICB0aGlzIGVudHJ5IGxpc3RlZCBcImNhcnJ5IHRoZSBlcG9jaCBpbiB0aGUgYm9va21hcmtcIiBhcyBub3QgdGFrZW5cbiAqICAgICAgICAgICAgKGEgbmV3IGZsYWcgb24gZWlnaHQgdmVyYnM7IGFuIGVwb2NoIHNlZW4gb25seSBvbmNlIGEgZnJhbWVcbiAqICAgICAgICAgICAgYXJyaXZlcykuIFRoZSByZXZpZXdlciB0aGVuIHNob3dlZCAoYSkncyBibGluZCBzcG90IExJVkU6IGFuIG9sZFxuICogICAgICAgICAgICBib29rbWFyayBhdCBvciBiZWxvdyB0aGUgTkVXIGxvZydzIGxlbmd0aCBtYWtlcyB0aGUgZGFlbW9uIHNlbmRcbiAqICAgICAgICAgICAgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuXG4gKiAgICAgICAgICAgIG1lc3NhZ2UgYXQgbmV3IGlkIDIgdW5kZXIgYSBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgd2l0aCBub1xuICogICAgICAgICAgICBub3RpY2UuIFRocmVlIHBhdGhzIHJlYWNoIGl0OiBjb21pbmcgYmFjayB3aXRob3V0IGZvbGxvd2luZyAoYik7XG4gKiAgICAgICAgICAgIHRoZSBNb25pdG9yLWNhcCBmYWxsYmFjayAoXCJyZS1hcm0gZnJvbSB0aGUgbGFzdCBpZCB5b3Ugc2F3XCIpXG4gKiAgICAgICAgICAgIGFjcm9zcyBhIHJlc3RhcnQ7IGFuZCBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluLXByb2Nlc3NcbiAqICAgICAgICAgICAgKGFzdHJvbGFiZSwgb3IgbWluZC1tYXBwZXIgd2hlbiBpdHMgZGFlbW9uIGlzIGJhY2sgYmVmb3JlIHRoZVxuICogICAgICAgICAgICBsb3N0IHJ1bGUgZmlyZXMpIHdob3NlIGZpcnN0IGZyYW1lIGFmdGVyIGEgcmVzdGFydCBpcyBhbHJlYWR5XG4gKiAgICAgICAgICAgIHBhc3QgaXRzIGJvb2ttYXJrLlxuICogICAgICAgICAgICBUaGUgZml4IG5lZWRzIG5vIG5ldyBmbGFnIGFuZCBubyB3aXJlIGNoYW5nZTogdGhlIGJvb2ttYXJrIGlzXG4gKiAgICAgICAgICAgIHByaW50ZWQgYC0tc2luY2UgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSwgdGhlIGNsaWVudCBzdGFydHNcbiAqICAgICAgICAgICAgd2l0aCB0aGF0IGVwb2NoIChgc2luY2VFcG9jaGApLCBhbmQgYW4gZXBvY2ggY2hhbmdlIHdob3NlIGZyYW1lXG4gKiAgICAgICAgICAgIGlzIHBhc3QgdGhlIGFza2VkIGN1cnNvciByZS1yZWFkcyB0aGUgbmV3IGxvZyBmcm9tIDAuIFRoZSBzYW1lXG4gKiAgICAgICAgICAgIHJlY29ubmVjdCBjb3ZlcnMgdGhlIGluLXByb2Nlc3MgcHJlc2VuY2UgY2FzZS5cbiAqICAgICAg4pqgIFNUQVRFRCBMSU1JVDogb25seSBkYWVtb25zIHRoYXQgc3RhbXAgYW4gZXBvY2ggZ2V0IChjKSDigJRcbiAqICAgICAgc2NyaXB0b3JpdW0sIGFzdHJvbGFiZSBhbmQgbWluZC1tYXBwZXIuIEdsYW1vdXIsIGltYWdvLCBtYWdwaWUgYW5kXG4gKiAgICAgIGJvdW50eSBzdGFtcCBub25lIChzZXNzaW9uLXNjb3BlZCBsb2dzLCBydWxlZCBzbyBpbiBEMzkvQjg7IGJvdW50eSdzXG4gKiAgICAgIHNlcnZlciBoZWFkZXIgbmFtZXMgdGhpcyByZXNpZHVlKSwgc28gZm9yIHRoZW0gdGhlIGdhcCBzdGF5cyBvcGVuIG9uXG4gKiAgICAgIHRoZSBmYWxsYmFjayBwYXRoLCAoYSkgY292ZXJzIHRoZSB3aG9sZS1yZXBsYXkgY2FzZSBhbmQgKGIpIHRoZVxuICogICAgICBjb21lLWJhY2sgcGF0aC4gQ2xvc2luZyBpdCB0aGVyZSBpcyBhIGRhZW1vbiBjaGFuZ2U6IGFuIGVwb2NoIG9uXG4gKiAgICAgIGBjcmVhdGVFdmVudExvZ2AuIEV2ZXJ5IHNwZWxsIHByaW50cyB0aGUgbmV0J3MgcmVzZXQgYXNcbiAqICAgICAgYGVwb2NoLmNoYW5nZWRgIChgXCJlcG9jaFwiOiBcInVua25vd25cImAgd2hlcmUgdGhlcmUgaXMgbm9uZSkuXG4gKiBEMyDCtyBPTkxZIEEgRlJBTUUgV0lUSCBBIExPRyBJRCBDT1VOVFMuIEdsYW1vdXIncyBhbmQgaW1hZ28ncyB0YWIgcGluZ3NcbiAqICAgICAgKGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgKSBjYXJyeSBubyBpZDogbm90IG9uIHRoZSBsb2csIHNvIGEgbGFwdG9wXG4gKiAgICAgIGxpZCBubyBsb25nZXIgd2FrZXMgYSBgLS1vbmNlYCwgYW5kIGltYWdvJ3MgZ3JlcCBubyBsb25nZXIgc2hvd3MgYVxuICogICAgICBgdGFpbC53b2tlYCB3aXRoIG5vdGhpbmcgYWJvdmUgaXQuXG4gKiBENCDCtyBBIEhVTUFOJ1MgV0FUQ0ggSEFTIE5PIFdJTkRPVy4gYGdyYXBldmluZSB0YWlsIC0taHVtYW5gIHBhc3Nlc1xuICogICAgICBgd2luZG93TXM6IDBgOyBubyBvdGhlciBzcGVsbCBoYXMgYSBodW1hbiBtb2RlLiBFdmVyeSBgdGFpbGAncyBoZWxwXG4gKiAgICAgIGNhcnJpZXMgYFdJTkRPV19IRUxQYCwgd2hpY2ggbmFtZXMgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wYC5cbiAqIEFsc286IGV2ZXJ5IGNvbWUtYmFjayBjb21tYW5kIGNhcnJpZXMgYC0tbm8tb3BlbmAsIHNvIHJ1bm5pbmcgaXQgb3BlbnMgbm9cbiAqIGJyb3dzZXIgdGFiLlxuICpcbiAqIOKaoCBLTk9XTiBFREdFLCBOT1QgRklYRUQgKGZvdW5kIGJ5IHRoZSByZS1yZXZpZXcpOiBhIGtleWVkIGJvdW50eSBGSVJTVCBhcm1cbiAqICAgKGFuIGFudGhpbGwgc2VhdCkgd2hvc2Ugd2luZG93IGVuZHMgYmVmb3JlIGl0cyBib2FyZCBldmVyIG9wZW5zIHByaW50cyBhXG4gKiAgIHJlLWFybSBwaW5uZWQgdG8gdGhlIGRlcml2ZWQgaWQgd2l0aCBhbiBlbXB0eSBib29rbWFya1xuICogICAoYC0tc2Vzc2lvbiBrLeKApiAtLXNpbmNlPS0xIC0tb25jZWApLiBUaGF0IHJlLWFybSBpcyBhIHJlLWFybSBieSBEMSdzIHJ1bGUsXG4gKiAgIHNvIGlmIHRoZSBib2FyZCBpcyBzdGlsbCBub3QgdXAg4oCUIHRoZSBsZWFkIG1vcmUgdGhhbiBvbmUgd2luZG93ICgyOSBtaW4pXG4gKiAgIGxhdGUg4oCUIHRoZSBzZWF0IGRvZXMgbm90IHdhaXQuIE1pbm9yOiB0aGUgbmV4dCBzdGVwIGl0IG5hbWVzXG4gKiAgIChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKSBpcyB0aGUgcmlnaHQgb25lIGFueXdheS4gU2luY2UgIzk4ICgyMDI2LTA5LTI3KVxuICogICBpdCBubyBsb25nZXIgc2F5cyBgdGFpbC5jbG9zZWRgIGFib3V0IGEgYm9hcmQgdGhhdCBuZXZlciBvcGVuZWQ6IGEgbmFtZWRcbiAqICAgYC0tc2Vzc2lvbmAgd2l0aCBubyBzbmFwc2hvdCBvbiBkaXNrIGV4aXRzIGBub3RfZm91bmRgIGFmdGVyIGEgZ3JhY2UuXG4gKlxuICog4pSA4pSAIFRIRSBDT01NQU5EIE5BTUVTIE5PIFBBVEggKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBsaW5lJ3MgYGNvbW1hbmRgIGlzIHRoZSBWRVJCIEFORCBJVFMgQVJHVU1FTlRTIE9OTFlcbiAqIChgdGFpbCAtLXNlc3Npb24gWCAtLXNpbmNlIE5ARSAtLW9uY2VgKSwgcGx1cyBgc3BlbGxgLCBhbmQgdGhlIGFnZW50IHJ1bnMgaXRcbiAqIHdpdGggSVRTIE9XTiBsYXVuY2hlciwgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHNgLiBJdCB1c2VkXG4gKiB0byBiZSBydW5uYWJsZSBhcyBwcmludGVkLCBoZWFkZWQgYnkgYGJ1biA8YXJndlsxXT5gIOKAlCBhbmQgZm9yIGFuIGluc3RhbGxlZFxuICogcGx1Z2luIGBhcmd2WzFdYCBpcyBpbnNpZGUgYSBWRVJTSU9ORUQgY2FjaGUgZGlyZWN0b3J5LiBBbiB1cGdyYWRlIG1hcmtzIHRoZVxuICogb2xkIGRpcmVjdG9yeSBvcnBoYW5lZCBhbmQgZGVsZXRlcyBpdCBsYXRlciAobWVhc3VyZWQgaW5cbiAqIGBkb2NzL2l0ZW1zL19hcmNoaXZlL3RhaWwtcmVhcm0tY29tbWFuZC1uYW1lcy1hLXZlcnNpb25lZC1wbHVnaW4tcGF0aC5tZGApLFxuICogc28gYSBsaW5lIHByaW50ZWQgYmVmb3JlIGFuIHVwZ3JhZGUgZmlyc3QgcmFuIFNUQUxFIGNvZGUgYWdhaW5zdCBhIG5ld2VyXG4gKiBkYWVtb24sIHRoZW4gZmFpbGVkIHdpdGggXCJtb2R1bGUgbm90IGZvdW5kXCIgb25jZSB0aGUgZGlyZWN0b3J5IHdhcyBnb25lLiBOb1xuICogc3RhYmxlIHBhdGggZXhpc3RzIHRvIHByaW50IGluc3RlYWQ6IHRoZSBjYWNoZSwgYCRDTEFVREVfUExVR0lOX1JPT1RgIGFuZCB0aGVcbiAqIGluc3RhbGwgcmVjb3JkIGFyZSBhbGwgdmVyc2lvbmVkLlxuICogICBUaGUgc2tpbGwncyBsYXVuY2hlciBpcyBhbHdheXMgdGhlIHZlcnNpb24gdGhlIHNlc3Npb24gbG9hZGVkLiBDb2xlJ3NcbiAqIHJlYXNvbmluZzogdGhlIHdvcnN0IGNhc2UgaXMgdGhhdCB0aGUgQ0xJIGNoYW5nZWQgYW5kIHRoZSBhZ2VudCBnZXRzIGFuXG4gKiBlcnJvciDigJQgYW5kIGlmIHRoZSB0b29scyBhcmUgZGVzaWduZWQgcmlnaHQsIHRoYXQgZXJyb3Igc2F5cyB3aGF0IHdlbnRcbiAqIHdyb25nLiBTbyB0aGUgcGFyc2VycyBhcmUgdGhlIG90aGVyIGhhbGYgb2YgdGhpcyBydWxpbmc6IGByZWFkU2luY2VgIHJlZnVzZXNcbiAqIGFueSBgLS1zaW5jZWAgZm9ybSBhIHRhaWwgZG9lcyBub3QgYWNjZXB0IHdpdGggYSB1c2FnZSBlcnJvciBOQU1JTkcgdGhlXG4gKiBmb3JtcyBpdCBkb2VzLCB0aGUgc2FtZSB3YXkgb24gYWxsIGVpZ2h0IHRhaWxzLCBpbnN0ZWFkIG9mIG1pc3BhcnNpbmcgaXQuXG4gKiAgIE5vdCB0YWtlbjogcHJpbnRpbmcgdGhlIHBhdGggQU5EIHRoZSBhcmdzIChvcHRpb24gQSBvZiB0aGUgaXRlbSDigJQgdHdvXG4gKiBjb21tYW5kcyB3aGVyZSBvbmUgaXMgd3JvbmcgYWZ0ZXIgYW4gdXBncmFkZSk7IGEgbGF1bmNoZXIgdGhhdCBub3RpY2VzIGl0IGlzXG4gKiBvcnBoYW5lZCBhbmQgcmUtZXhlY3MgYSBuZXdlciBzaWJsaW5nIChCIOKAlCBpdCBsZWFucyBvbiBhIENsYXVkZSBDb2RlXG4gKiBpbnRlcm5hbCBtYXJrZXIgYW5kIGRvZXMgbm90aGluZyBvbmNlIHRoZSBkaXJlY3RvcnkgaXMgZGVsZXRlZCk7IHZlcnNpb25cbiAqIG5lZ290aWF0aW9uLlxuICpcbiAqIOKUgOKUgCBNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFMgKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L21pbmQtbWFwcGVyLXF1aWV0LWhhbmRvZmZgLiBJdCBSRVZFUlNFUyB0aGUgaW1wbGVtZW50ZXInc1xuICogcnVsaW5nIG9mIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdGhhdCBtaW5kLW1hcHBlciBpcyBhIHByZXNlbmNlIHNwZWxsXG4gKiAoaXRzIGRhZW1vbiBjb3VudHMgYW4gb3BlbiBTU0UgdGFpbCBhcyB0aGUgYWdlbnQgcHJlc2VudCwgc28gdGhlIHdpbmRvd1xuICogYWx3YXlzIHJlLWFybWVkIE1vbml0b3IpLiBDb2xlJ3MgcmVhc29uaW5nOiBtaW5kLW1hcHBlciBzZXNzaW9ucyBhcmUgdXNlZFxuICogbGlrZSBzY3JpcHRvcml1bSdzLCBidXJzdHMgb2YgYWN0aXZpdHkgd2l0aCBicmVha3MsIGFuZCBpbiBhIGJyZWFrIHRoZSBhZ2VudFxuICogc2hvdWxkIG5vdCBiZSB3b2tlbiBldmVyeSAzMCBtaW51dGVzLiBTbyBtaW5kLW1hcHBlciB0YWtlcyB0aGUgcXVpZXQgaGFuZG9mZlxuICogdG8gYC0tb25jZWAsIHRoZSBsb3N0IGNvbWUtYmFjayAoYG9wZW4gLS1uby1vcGVuYCksIGFuZCBrZWVwcyBpdHNcbiAqIGAtLXNpbmNlIE5AZXBvY2hgIGJvb2ttYXJrLiBUaHJlZSB0aGluZ3MgaGFkIHRvIGJlIHNldHRsZWQgdG8gbWFrZSB0aGF0XG4gKiBob25lc3QsIGVhY2ggcGlubmVkIGluIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC97dGFpbCxwcmVzZW5jZX0udGVzdC50c2BcbiAqIGFuZCBtdXRhdGlvbi1jb25maXJtZWQ6XG4gKlxuICogTTEgwrcgUFJFU0VOQ0UgTElOR0VSUyBBQ1JPU1MgVEhFIEdBUFMgKHRoZSBkYWVtb24sIGBzZXJ2ZXIudHNgXG4gKiAgICAgIGBhZGp1c3RBZ2VudHNgKS4gQSBvbmUtc2hvdCBob2xkcyBhbiBTU0UgY29ubmVjdGlvbiwgc28gaXQgQ09VTlRTIGFzXG4gKiAgICAgIHByZXNlbnQsIHdoaWNoIGlzIHRydWU6IHRoZSBhZ2VudCB3aWxsIHdha2Ugb24gdGhlIG5leHQgZXZlbnQuIFRoZSBnYXBzXG4gKiAgICAgIGFyZSB0aGUgcHJvYmxlbTogd2luZG93IOKGkiByZS1hcm0sIHF1aWV0IOKGkiBgLS1vbmNlYCwgYW5kIGFib3ZlIGFsbFxuICogICAgICBgdGFpbC53b2tlYCDihpIgdGhlIGFnZW50IGhhbmRsZXMgdGhlIGV2ZW50IOKGkiBNb25pdG9yLCB3aGljaCBsYXN0cyB0aGVcbiAqICAgICAgYWdlbnQncyB3aG9sZSB0dXJuLiBSYXcsIHRoZSBzdXJmYWNlJ3MgaGVhZGVyIGRvdCAodGhlIG9ubHkgdGhpbmdcbiAqICAgICAgcHJlc2VuY2UgZHJpdmVzIHRoZXJlLCBiZXNpZGVzIHRoZSBkYWVtb24ncyBhdXRvLWByZWNlaXZlZGAgZmxpcCBvbiBhXG4gKiAgICAgIGh1bWFuIG1lc3NhZ2UpIHJlYWQgXCJjb25uZWN0ZWQg4oCUIG5vIGFnZW50IG9uIHRoaXMgcHJvamVjdFwiIHdoaWxlIHRoZVxuICogICAgICBhZ2VudCB3YXMgd29ya2luZyB0aGUgYm9hcmQsIGFuZCBhIG1lc3NhZ2Ugc2VudCB0aGVuIGdvdCBub1xuICogICAgICBgcmVjZWl2ZWRgLiBUaGUgZGFlbW9uIGhhcyBubyBpZGxlIGNsb3NlLCBzbyBub3RoaW5nIGVsc2UgcmVhY3RzLiBOb3dcbiAqICAgICAgdGhlIGNvdW50IEhPTERTIGZvciBgTUlORF9NQVBQRVJfUFJFU0VOQ0VfTElOR0VSX01TYCAoMTUwIHMsIHRoZSBzdGFsbFxuICogICAgICB3aW5kb3cncyBiZWF0KSBhZnRlciB0aGUgbGFzdCB0YWlsIGNsb3NlczogYSB0YWlsIG9wZW5pbmcgaW5zaWRlIGl0XG4gKiAgICAgIGVtaXRzIG5vdGhpbmcsIGFuIGFnZW50LW9ubHkgd3JpdGUgKGAvYWN0aXZpdHlgLCBhbiBhZ2VudCBgL3NlbmRgKVxuICogICAgICByZXN0YXJ0cyBpdCwgYW5kIHNpbGVuY2UgcGFzdCBpdCBkcm9wcyB0aGUgY291bnQgdG8gMC5cbiAqICAgICAg4pqWIE5vdCB0YWtlbjogcmUtYXJtaW5nIE1vbml0b3IgQkVGT1JFIGhhbmRsaW5nIGEgd29rZW4gZXZlbnQgKHRoYXQgaXNcbiAqICAgICAgdGhlIHNoYXJlZCBydWxlLCB3b3JkLWZvci13b3JkIGluIGV2ZXJ5IHNwZWxsKTsgcmVmcmVzaGluZyBvbiBldmVyeVxuICogICAgICBib2FyZCB3cml0ZSAodGhlIGJyb3dzZXIgUE9TVHMgdGhlIHNhbWUgcm91dGVzLCBzbyB0aGUgaHVtYW4ncyBvd25cbiAqICAgICAgY2xpY2tzIHdvdWxkIGtlZXAgdGhlIGRvdCBsaXQpLiBDb3N0OiBhbiBhZ2VudCB0aGF0IHJlYWxseSBsZWZ0IHJlYWRzXG4gKiAgICAgIFwiaGVyZVwiIGZvciB1cCB0byAxNTAgcy5cbiAqIE0yIMK3IGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBOT1QgQ09VTlRFRCAobWluZC1tYXBwZXIncyBgY291bnRzYCkuIEl0IGlzIE9OXG4gKiAgICAgIFRIRSBMT0csIHdpdGggYW4gaWQsIGFuZCBhIHRhaWwncyBvd24gY29ubmVjdCBlbWl0cyBvbmUgb250byBpdHMgb3duXG4gKiAgICAgIHN0cmVhbSwgc28gY291bnRlZCBpdCBtYWRlIGV2ZXJ5IHdpbmRvdyBcImFjdGl2ZVwiIGFuZCB3b3VsZCB3YWtlIGV2ZXJ5XG4gKiAgICAgIGAtLW9uY2VgIG9uIGl0c2VsZi4gVGhlIGxpbmdlciByZW1vdmVzIG1vc3Qgb2YgdGhhdCBjaHVybjsgYGNvdW50c2BcbiAqICAgICAgcmVtb3ZlcyB0aGUgcmVzdCAoYSBmaXJzdCBhcm0sIGFub3RoZXIgYWdlbnQgY29taW5nIG9yIGdvaW5nKS5cbiAqIE0zIMK3IEEgREVBRCBEQUVNT04gSVMgTE9TVCwgTk9UIFVOUkVTT0xWRUQgKG1pbmQtbWFwcGVyJ3MgYHJlc29sdmVgKS4gSXRzXG4gKiAgICAgIGRpc2NvdmVyeSBwcm9iZXMgdGhlIGRhZW1vbidzIHBpZCwgc28gYSBraWxsZWQgZGFlbW9uIG1hZGUgYHJlc29sdmVgXG4gKiAgICAgIGFuc3dlciBudWxsIGFuZCBhbiB1bnJlc29sdmVkIHRhaWwgcmV0cmllcyBmb3JldmVyOiBhIGAtLW9uY2VgIHdvdWxkXG4gKiAgICAgIGhhdmUgc2xlcHQgZm9yIGdvb2QgKEQxJ3MgZGVmZWN0KS4gVGhlIHRhaWwga2VlcHMgdGhlIGxhc3QgVVJMIGl0XG4gKiAgICAgIHJlc29sdmVkLCBzbyB0aGUgZGVhZCBwb3J0IHJlZnVzZXMgYW5kIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBlbmRzIGl0XG4gKiAgICAgIHdpdGggYHRhaWwubG9zdGAg4oaSIGBvcGVuIC0tbm8tb3BlbmAsIHRoZW4gYSB0YWlsIHdpdGggbm8gYC0tc2luY2VgLlxuICogICAgICBNaW5kLW1hcHBlciBoYXMgbm8gc2Vzc2lvbiB0byBjbG9zZSwgc28gaXQgbmV2ZXIgcHJpbnRzIGB0YWlsLmNsb3NlZGAuXG4gKiAgICAgIE1lYXN1cmVkIG9uIGEgcmVhbCBga2lsbCAtOWAgdW5kZXIgYSBgLS1vbmNlYDogYHRhaWwubG9zdGAgNyBzIGxhdGVyLFxuICogICAgICBub3QgMC43NSBzLCBiZWNhdXNlIG1pbmQtbWFwcGVyJ3Mgb3duIGJhY2tvZmYgc3RhcnRzIGF0IDEgcyAoMSArIDIgKyA0KS5cbiAqICAgICAgTTHigJNNMyB3ZXJlIGRyaXZlbiBvbiBhIHJlYWwgZGFlbW9uIHdpdGggYSA0IHMgd2luZG93OiBhY3RpdmUg4oaSIHdpbmRvdyxcbiAqICAgICAgcXVpZXQg4oaSIGAtLW9uY2VgLCBhIGh1bWFuIG1lc3NhZ2Ugd29rZSBpdCwgYmFjayB0byBNb25pdG9yOyBwcmVzZW5jZVxuICogICAgICBuZXZlciBkcm9wcGVkIGFjcm9zcyB0aGUgZ2Fwcy5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBDT01QTEVURSBCVVQgRk9SIFRIRSBMQVVOQ0hFUjogcGlubmVkIHRvIHRoZVxuICogICBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGUgc2tpbGxzIG5hbWUgdGhlXG4gKiAgIHJ1bGUgb25jZSwgbGF1bmNoZXIgZm9ybSBpbmNsdWRlZDsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICpcbiAqIFMxIMK3IFdITyBDTE9TRUQgSVQgUklERVMgVEhFIExJTkUgKHNjcmlwdG9yaXVtJ3MgRW5kIHNlc3Npb24sIDIwMjYtMTAtMDEpLlxuICogICAgICBBIHNwZWxsIHdob3NlIGBjbG9zZWRgIGZyYW1lIHNheXMgd2hvIGVuZGVkIHRoZSBzZXNzaW9uIHBhc3Nlc1xuICogICAgICBgY2xvc2VkQnlgLCBhbmQgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzIGBieWAuIGBieTogXCJodW1hblwiYCBjaGFuZ2VzXG4gKiAgICAgIHRoZSBoaW50OiB0aGUgaHVtYW4gZW5kZWQgaXQgT04gUFVSUE9TRSwgc28gdGhlIGFnZW50IHN0b3BzIGFuZCBkb2VzIG5vdFxuICogICAgICByZW9wZW4gdW5sZXNzIGFza2VkIOKAlCB0aGUgd2F5IGJhY2sgaXMgc3RpbGwgbmFtZWQsIGNvbmRpdGlvbmVkIG9uIHRoYXQuXG4gKiAgICAgIFRoZSBhZ2VudCByb3V0ZXMgb24gYGJ5YCwgbmV2ZXIgb24gdGhlIGhpbnQncyBwcm9zZS4gQSByZS1hcm0gYWZ0ZXJcbiAqICAgICAgdGhlIGVuZCBzZWVzIG5vIGNsb3NpbmcgZnJhbWUgKEQxJ3MgcGF0aCksIHNvIHRoZSBzcGVsbCBhbHNvIHBhc3Nlc1xuICogICAgICBgZ29uZUJ5YCwgcmVhZCBmcm9tIHdoZXJlIHRoZSBmYWN0IG91dGxpdmVzIHRoZSBkYWVtb247IHdpdGhvdXQgaXQgdGhlXG4gKiAgICAgIHJlLWFybWVkIGxpbmUgZHJvcHBlZCBgYnlgIGFuZCBpbnZpdGVkIHRoZSByZW9wZW4gKHZlcmlmaWVyLCAyMDI2LTEwLTAxKS5cbiAqICAgICAg4pqWIE9wdGlvbnMgbm90IHRha2VuOiBhIHNwZWxsLXNpZGUgcmV3cml0ZSBvZiB0aGUgcHJpbnRlZCBsaW5lIChhIHNlY29uZFxuICogICAgICB3cml0ZXIgb2YgdGhlIHNhbWUgbGluZSksIG9yIGEgc3BlbGwtc3VwcGxpZWQgaGludCAoZWFjaCBzcGVsbCB3b3VsZFxuICogICAgICB3b3JkIFwib24gcHVycG9zZVwiIGl0cyBvd24gd2F5KS5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICAvKiogV2hvIGVuZGVkIGEgYGNsb3NlZGAgc2Vzc2lvbiwgd2hlbiBpdHMgY2xvc2luZyBmcmFtZSBzYWlkIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGB0YWlsLmNsb3NlZGAgb25seTogd2hvIGVuZGVkIHRoZSBzZXNzaW9uLCB3aGVuIHRoZSBzcGVsbCBzYXlzIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICAvKiogYG1vbml0b3JgOiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYC5cbiAgICogIGBiYWNrZ3JvdW5kYDogcnVuIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrLlxuICAgKiAgYHN0b3BgOiBub3RoaW5nIHRvIHdhdGNoOyBgY29tbWFuZGAgaXMgaG93IHRvIGNvbWUgYmFjaywgaWYgd2FudGVkLiAqL1xuICBuZXh0OiBcIm1vbml0b3JcIiB8IFwiYmFja2dyb3VuZFwiIHwgXCJzdG9wXCI7XG4gIC8qKiBUaGUgdmVyYiBhbmQgaXRzIGFyZ3VtZW50cyBPTkxZIOKAlCBubyBsYXVuY2hlciwgbm8gcGF0aC4gVGhlIGFnZW50IHJ1bnNcbiAgICogIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPmAuICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgaGludDogc3RyaW5nO1xufTtcblxuLyoqIEhvdyB0aGUgYWdlbnQgcnVucyBhIHByaW50ZWQgYGNvbW1hbmRgOiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIG5ldmVyIGEgcGF0aFxuICogIHRoaXMgcHJvY2VzcyBuYW1lcyAodGhlIHJ1bGluZyBvbiB0aGUgdmVyc2lvbmVkIHBsdWdpbiBwYXRoLCBpbiB0aGUgaGVhZGVyKS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fV0lUSF9MQVVOQ0hFUiA9IFwiYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5cIjtcblxuLyoqIFRoZSBjb21lLWJhY2sgaGludCwgd2l0aCBob3cgdG8gUkVTVU1FIGFmdGVyIGNvbWluZyBiYWNrIChEMik6IGEgcmVzdG9yZWRcbiAqICBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBtZWFucyBub3RoaW5nIHRoZXJlLiAqL1xuY29uc3QgQ09NRV9CQUNLID0gKHdoeTogc3RyaW5nLCBsZWFkID0gXCJUbyBicmluZyBpdCBiYWNrXCIpID0+XG4gIGAke3doeX0gJHtsZWFkfSwgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9OyB0aGVuIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vIC0tc2luY2UsIG9uIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cyB3aGVyZSB0aGVyZSBpcyBvbmUgKGEgcmVzdGFydGVkIGRhZW1vbiBzdGFydHMgYSBuZXcgZXZlbnQgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIGRvZXMgbm90IGFwcGx5KWA7XG5cbi8qKlxuICogVEhFIERFQ0lTSU9OOiBnaXZlbiBob3cgdGhlIHRhaWwgZW5kZWQsIHdoaWNoIGxpbmUgaXQgcHJpbnRzLiBQdXJlLCBzbyBldmVyeVxuICogc3RhdGUgaXMgYSBsaXRlcmFsIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLiBSZXR1cm5zIG51bGwgZm9yIGBzdG9wcGVkYDpcbiAqIGEgaHVtYW4ncyBDdHJsLUMgb3IgYSBjYWxsZXIncyBhYm9ydCBpcyBub3QgYSBoYW5kb2ZmLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFuZG9mZihzOiBIYW5kb2ZmSW5wdXQsIGNtZDogSGFuZG9mZkNvbW1hbmRzKTogSGFuZG9mZkxpbmUgfCBudWxsIHtcbiAgY29uc3QgYmFzZSA9IHsgc3BlbGw6IHMuc3BlbGwsIGV2ZW50czogcy5ldmVudHMsIGN1cnNvcjogcy5jdXJzb3IgfTtcbiAgc3dpdGNoIChzLmVuZCkge1xuICAgIGNhc2UgXCJzdG9wcGVkXCI6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBjYXNlIFwiY2xvc2VkXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwuY2xvc2VkXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIC4uLihzLmJ5ID8geyBieTogcy5ieSB9IDoge30pLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgcy5ieSA9PT0gXCJodW1hblwiXG4gICAgICAgICAgICA/IENPTUVfQkFDSyhcbiAgICAgICAgICAgICAgICBcInRoZSBodW1hbiBlbmRlZCB0aGlzIHNlc3Npb24gb24gcHVycG9zZTsgc3RvcCB3YXRjaGluZywgYW5kIGRvIG5vdCByZW9wZW4gaXQgdW5sZXNzIHRoZXkgYXNrLlwiLFxuICAgICAgICAgICAgICAgIFwiSWYgdGhleSBhc2tcIixcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgOiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLS1zaW5jZT0tMSBmb3IgZXZlcnl0aGluZylcIlxuICAgICAgOiBgYW4gZXZlbnQgaWQgKGFuIGludGVnZXIsICR7bWlufSBvciBtb3JlKWA7XG4gIGNvbnN0IGZvcm1zID0gby5lcG9jaCA/IGAke2lkfSwgb3IgPGlkPkA8ZXBvY2g+IGFzIGEgaGFuZG9mZiBsaW5lIHByaW50cyBpdGAgOiBpZDtcbiAgY29uc3Qgd2h5ID1cbiAgICAhby5lcG9jaCAmJiB0b2tlbi5pbmNsdWRlcyhcIkBcIilcbiAgICAgID8gYDsgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgbm8gZXBvY2gsIHNvIHBhc3MgdGhlIGlkIHdpdGhvdXQgdGhlIFwiQOKAplwiIHBhcnRgXG4gICAgICA6IFwiXCI7XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIG1lc3NhZ2U6IGAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMg4oCUIGdpdmUgJHtmb3Jtc30ke3doeX1gLFxuICB9O1xufVxuXG4vKiogSm9pbiBhbiBhcmd2IGludG8gb25lIHJ1bm5hYmxlIGNvbW1hbmQgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kTGluZShhcmd2OiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBhcmd2Lm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOW0BlcG9jaF0gWy0tb25jZV1gLlxuICogIFBhc3MgYGVwb2NoYCBvbmx5IGZvciBhIHNwZWxsIHdob3NlIGAtLXNpbmNlYCBwYXJzZXMgaXQgKGBwYXJzZUJvb2ttYXJrYCkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQoXG4gIHByZWZpeDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHNpbmNlOiBudW1iZXIsXG4gIG9uY2U6IGJvb2xlYW4sXG4gIGVwb2NoPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgbWFyayA9IGVwb2NoID8gYCR7c2luY2V9QCR7ZXBvY2h9YCA6IFN0cmluZyhzaW5jZSk7XG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7bWFya31gXSA6IFtcIi0tc2luY2VcIiwgbWFya107XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICAvKiogVGhlIHNwZWxsJ3MgbmFtZSwgY2FycmllZCBvbiB0aGUgbGluZSAod2hvc2UgbGF1bmNoZXIgcnVucyBpdCkuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogQSBwcmVzZW5jZSBzcGVsbDogYWx3YXlzIGB0YWlsLndpbmRvd2AgYXQgdGhlIHdpbmRvdydzIGVuZCwgbmV2ZXIgbG9zdC4gKi9cbiAgcHJlc2VuY2U6IGJvb2xlYW47XG4gIC8qKiBEZWZhdWx0OiBgcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKWAuIGAwYCA9IG5vIHdpbmRvdy4gKi9cbiAgd2luZG93TXM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIGFuIGVtaXR0ZWQgZnJhbWUgaXMgYSBMT0cgZnJhbWUgKEEzKS4gRGVmYXVsdDogZXZlcnkgb25lLiAqL1xuICBjb3VudHM/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBXaGljaCB0ZXJtaW5hbCBmcmFtZSBtZWFucyB0aGUgc2Vzc2lvbiBjbG9zZWQuIERlZmF1bHQ6IGV2ZXJ5IHRlcm1pbmFsLiAqL1xuICBpc0Nsb3NlZD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBXaG8gdGhlIGNsb3NpbmcgZnJhbWUgc2F5cyBlbmRlZCB0aGUgc2Vzc2lvbiAoUzEpOyBjYXJyaWVkIG9uIGB0YWlsLmNsb3NlZGAuICovXG4gIGNsb3NlZEJ5PzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogV2hvIGVuZGVkIGEgc2Vzc2lvbiBmb3VuZCBHT05FIChEMTogcmUtYXJtZWQgYWZ0ZXIgaXQgY2xvc2VkLCBzbyBub1xuICAgKiAgY2xvc2luZyBmcmFtZSBpcyBldmVyIHNlZW4pLCByZWFkIGZyb20gd2hlcmV2ZXIgdGhlIHNwZWxsIGtlZXBzIGl0IOKAlCBhXG4gICAqICBtYW5pZmVzdCB0aGF0IG91dGxpdmVzIHRoZSBkYWVtb24uIENhcnJpZWQgb24gYHRhaWwuY2xvc2VkYCBhcyBgYnlgLCBzb1xuICAgKiAgdGhlIGxpbmUgc2F5cyB3aGF0IHRoZSBsaXZlIHBhdGgncyBgY2xvc2VkQnlgIHdvdWxkIGhhdmUgKFMxKS4gKi9cbiAgZ29uZUJ5PzogKCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gdGFpbC5zaW5jZUVwb2NoO1xuICBsZXQgZnJhbWVIYXNJZCA9IGZhbHNlO1xuICAvKiogQTMgKyBEMzogYSBmcmFtZSBjb3VudHMsIGFuZCB3YWtlcyBhIGAtLW9uY2VgLCBvbmx5IHdoZW4gaXQgaXMgT04gVEhFXG4gICAqICBMT0cg4oCUIGl0IGNhcnJpZXMgYSBsb2cgaWQg4oCUIGFuZCB0aGUgc3BlbGwncyBvd24gYGNvdW50c2AgYWdyZWVzLiBBIHRhYidzXG4gICAqICBpZC1sZXNzIGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgIHBpbmcgaXMgbm90IG9uIHRoZSBsb2cuICovXG4gIGNvbnN0IGlzTG9nRnJhbWUgPSAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGZyYW1lSGFzSWQgJiYgY291bnRzKGV2LCBmcmFtZSk7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZEJ5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICAvLyBEMidzIG5ldC4gT24gZm9yIGV2ZXJ5IHNwZWxsOiBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3JcbiAgICAgIC8vIG1lYW5zIGEgd2hvbGUgcmVwbGF5IG9uIHRoZSBraXQncyBsb2csIGFuZCBvbiBncmFwZXZpbmUncyBkdXJhYmxlIGxvZ1xuICAgICAgLy8gaXQgaGFwcGVucyBvbmx5IHdoZW4gYC0tbGFzdGAgcmVhY2hlcyBiZWxvdyBgLS1zaW5jZWAsIHdoZXJlXG4gICAgICAvLyByZS1yZWFkaW5nIHRoZSBjdXJzb3IgZnJvbSB0aGUgZnJhbWVzIGlzIHRoZSBtb3JlIGNvcnJlY3QgYW5zd2VyLlxuICAgICAgcmVzdGFydE9uUmVwbGF5OiB0cnVlLFxuICAgICAgLy8gRDM6IHJlbWVtYmVyIHdoZXRoZXIgVEhJUyBmcmFtZSBjYXJyaWVzIGEgbG9nIGlkLiBgdGFpbEV2ZW50c2AgcmVhZHNcbiAgICAgIC8vIHRoZSBjdXJzb3Igb25jZSBwZXIgZnJhbWUsIGJlZm9yZSBgYWNjZXB0YCwgYHRlcm1pbmFsYCBhbmQgYHJlbmRlcmAuXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGNvbnN0IG4gPSB0YWlsLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICBmcmFtZUhhc0lkID0gdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pO1xuICAgICAgICByZXR1cm4gbjtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCB0aGF0IGdpdmVzIHVwIG9uIGZpbmRpbmcgaXRzIHNlc3Npb24gaXMgd2F0Y2hpbmcgYVxuICAgICAgICAvLyBzZXNzaW9uIHRoYXQgaXMgZ29uZSDigJQgd2hldGhlciB0aGlzIHByb2Nlc3MgZXZlciByZWFjaGVkIGl0IChpdHNcbiAgICAgICAgLy8gcG9pbnRlciB2YW5pc2hlZCkgb3IgaXQgd2FzIHJlLWFybWVkIGF0IG9uZSB0aGF0IGNsb3NlZCBpbiB0aGUgZ2FwLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgZW5kID0gXCJjbG9zZWRcIjtcbiAgICAgICAgICBjbG9zZWRCeSA9IGguZ29uZUJ5Py4oKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSBldmVudHMgKz0gMTtcbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgdGVybWluYWw6IChldiwgZnJhbWUsIGFjY2VwdGVkKSA9PiB7XG4gICAgICAgIGlmICh0YWlsLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgICBlbmQgPSAoaC5pc0Nsb3NlZCA/PyAoKCkgPT4gdHJ1ZSkpKGV2KSA/IFwiY2xvc2VkXCIgOiBcImV2ZW50XCI7XG4gICAgICAgICAgICBpZiAoZW5kID09PSBcImNsb3NlZFwiKSBjbG9zZWRCeSA9IGguY2xvc2VkQnk/Lihldik7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIGVwb2NoID0gcy5lcG9jaCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICAuLi4oY2xvc2VkQnkgPyB7IGJ5OiBjbG9zZWRCeSB9IDoge30pLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSksXG4gICAgICAgIHByZXNlbmNlOiBoLnByZXNlbmNlLFxuICAgICAgICBzcGVsbDogaC5zcGVsbCxcbiAgICAgIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogR3JhcGV2aW5lJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyBvZiB0aGUgc3BlbGwsIGFuZCBUSEUgT05FIFBMQUNFIFRIRSBFTlYgSVMgUkVBRC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLCBBTkQgRk9SIEdSQVBFVklORSBUSEUgU0VBTSBJUyBSRUFMIOKAlCB0aGUgZmlyc3QgdGltZVxuICogaW4gZm91ciBwb3J0cyAocGxheWJvb2sgQjgsIGVudHJ5LWJsb2NrIHF1ZXN0aW9uIDMpLiBCZWZvcmUgUGhhc2UgNiB0aGVcbiAqIGhlYXJ0YmVhdCB3YXMgYSBMSVRFUkFMIGAzMDAwYCBpbnNpZGUgYGRhZW1vbi50c2AncyBTU0Ugc3RyZWFtLCBgaWRsZVRpbWVvdXQ6XG4gKiAyNTVgIHdhcyBhIHNlY29uZCBsaXRlcmFsIHRlbiBsaW5lcyBhd2F5IHdpdGggdGhlIHJlbGF0aW9uc2hpcCB3cml0dGVuIG9ubHkgaW5cbiAqIHByb3NlLCBhbmQgYGNsaS50c2AncyB0YWlsIGhhZCBOTyB3YXRjaGRvZyBhdCBhbGwg4oCUIGl0IGJsb2NrZWQgb25cbiAqIGByZWFkZXIucmVhZCgpYCBmb3JldmVyLCB3aGljaCBpcyB0aGUgZmFpbHVyZSB0aGUga2l0J3Mgd2F0Y2hkb2cgZXhpc3RzIHRvXG4gKiBlbmQuIE5laXRoZXIgZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vblxuICogd291bGQgZHJhZyB0aGUgd2hvbGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2l0aCBubyBpbXBvcnRzXG4gKiBidXQgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKiBBIHZhbHVlIHRoYXQgY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKlxuICog4puUICoqQU5EIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gR1JBUEVWSU5FJ1MgT1dOIEhFQVJUQkVBVCwgTkVWRVIgQ09QSUVEXG4gKiBGUk9NIEEgU0lCTElORy4qKiBUaGlzIGlzIHRoZSBydWxlIGFzdHJvbGFiZSBwYWlkIGZvcjogYSBoYXJkLWNvZGVkIDQ1IHNcbiAqIHdhdGNoZG9nIGFnYWluc3QgYW4gZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZCByZWNvbm5lY3RzIGF0ICs0Ny40IHMsXG4gKiArOTIuNiBzIGFuZCArMTM3LjkgcyBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLCBoYXJtbGVzcyBvbmx5IGJlY2F1c2VcbiAqIGFuIHVucmVsYXRlZCB0aGlyZCBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uIOKaoCBHcmFwZXZpbmUgaXMgdGhlIHNwZWxsIHRoYXRcbiAqIG1ha2VzIHRoZSBwb2ludCBzaGFycGVzdDogaXQgYmVhdHMgYXQgKiozIHMqKiwgYSBmaWZ0aCBvZiB0aGUgaG91c2UgZGVmYXVsdCxcbiAqIHNvIGEgY29waWVkIDQ1LDAwMCB3b3VsZCB0b2xlcmF0ZSBGSUZURUVOIG1pc3NlZCBiZWF0cyB3aGVyZSBldmVyeSBzaWJsaW5nXG4gKiB0b2xlcmF0ZXMgdGhyZWUuIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbSB0aGUgYmVhdCBpdFxuICogaXMgd2F0Y2hpbmcsIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4puUICoqQU5EIFwiV0hBVEVWRVIgVEhFIEJFQVQgQkVDT01FU1wiIElTIFdIWSBUSEUgRU5WIElTIFJFU09MVkVEIEhFUkUgQU5EXG4gKiBOT1dIRVJFIEVMU0UgKEQ3NSkuIFRIRSBQT1JUIFJFLUNSRUFURUQgQVNUUk9MQUJFJ1MgREVGRUNUIElOIFRISVMgRklMRS4qKlxuICogQ2hhcHRlciAyIHNoaXBwZWQgYEhFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gKiDigKYpYCBhdCBgZGFlbW9uLnRzOjExMmAgd2hpbGUgdGhpcyBmaWxlIGtlcHQgYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgXG4gKiBhZ2FpbnN0IHRoZSBMSVRFUkFMIDMsMDAwOiB0aGUgZGFlbW9uJ3MgYmVhdCB3YXMgdHVuYWJsZSBhbmQgdGhlIENMSSdzXG4gKiB3YXRjaGRvZyB3YXMgbm90LCBzbyAqKmFueSB2YWx1ZSBhYm92ZSAzLDAwMCBicm9rZSBldmVyeSB0YWlsLioqIE1FQVNVUkVEIGF0XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0yMDAwMGAgYWdhaW5zdCBhIGhlYWx0aHkgZGFlbW9uLCBiZWZvcmUgdGhlIHJlcGFpcjogYVxuICogcmVhbCBgY2xpLnRzIHRhaWxgIHJlLXN1YnNjcmliZWQgKio0IHRpbWVzIGluIDMwIHMqKiAofjkgcyBhcGFydCwgaXRzIHdhdGNoZG9nXG4gKiBmaXJpbmcgYmVmb3JlIGEgc2luZ2xlIDIwIHMgYmVhdCBjb3VsZCBsYW5kIOKAlCAqKjAga2VlcGFsaXZlcyBhcnJpdmVkKiopLCBhbmRcbiAqIGAvY2hhbm5lbHMvd2Qvc3Vic2NyaWJlcnNgIHJlcG9ydGVkIGBjb3VudDogMiwgY29ubmVjdGlvbnM6IDIsIG5hbWVkOiAyYCBmb3JcbiAqICoqb25lKiogbGl2ZSB0YWlsLCBiZWNhdXNlIHRoZSBhYmFuZG9uZWQgc3RyZWFtcyBhcmUgbm90IHJlYXBlZCB1bnRpbCB0aGVcbiAqIG5vdy0yMCBzIGJlYXQgZmFpbHMgdG8gZW5xdWV1ZS4gVGhhdCBpcyB0aGUgYXN0cm9sYWJlIHNjYXIgdHdvIHBhcmFncmFwaHMgdXAsXG4gKiByZS1jcmVhdGVkIGluc2lkZSB0aGUgZmlsZSB0aGF0IGRvY3VtZW50cyBpdC4gKipPbmUgaGFsZiBvZiB0aGUgcGFpciB0dW5hYmxlXG4gKiBhbmQgdGhlIG90aGVyIGEgY29uc3RhbnQgSVMgdGhlIGRlZmVjdCoqIOKAlCB0aGUgZGVyaXZhdGlvbiBvbmx5IGhvbGRzIGlmIGl0XG4gKiBkZXJpdmVzIGZyb20gdGhlIHZhbHVlIHRoYXQgYWN0dWFsbHkgc2hpcHBlZC5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIHRoZSBDTEkgaXMgYmFjayB0byBkcmFnZ2luZyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKiBgcHJvY2Vzcy5lbnZgIGlzIG5vdCBzdWNoIGFuIGltcG9ydDogaXQgaXMgYW1iaWVudCBpbiBib3RoIGhhbHZlcywgd2hpY2ggaXNcbiAqIGV4YWN0bHkgd2h5IHRoaXMgZmlsZSDigJQgYW5kIG5vdCBgZGFlbW9uLnRzYCDigJQgY2FuIGhvbGQgdGhlIHJlc29sdXRpb24uIChUaGlzXG4gKiBpcyBib3VudHkncyBzaGFwZSwgdW5jaGFuZ2VkOiBgc3JjL2JvdW50eS9iYWNrZW5kL2hlYXJ0YmVhdC50c2AgcmVzb2x2ZXNcbiAqIGBCT1VOVFlfSURMRV9USU1FT1VUX1NFQ2AgYW5kIGBCT1VOVFlfSEVBUlRCRUFUX01TYCBpbiB0aGUgc2VhbSBmaWxlIGZvciB0aGVcbiAqIHNhbWUgcmVhc29uLilcbiAqL1xuXG5pbXBvcnQge1xuICBoZWFydGJlYXRNcyxcbiAgaWRsZVRpbWVvdXRTZWMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQnVuJ3MgbWF4aW11bSwgaW4gc2Vjb25kcy4gR3JhcGV2aW5lJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLCBub3QgYW4gaW5oZXJpdGVkXG4gKiBvbmU6IGBkYWVtb24udHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHVuZGVyIGEgY29tbWVudCByZWNvcmRpbmcgdGhhdFxuICogQnVuJ3MgZGVmYXVsdCAxMCBzIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXNcbiAqIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMg4oCUIGFuZCB0aGF0IGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiLCBpdCBpcyB0aGVcbiAqIGRlZmF1bHQuXG4gKlxuICog4pqgIGBHUkFQRVZJTkVfSURMRV9USU1FT1VUX1NFQ2AgaXMgYWNjZXB0ZWQgc28gdGhlIFBBSVIgY2FuIGJlIHR1bmVkIHRvZ2V0aGVyLFxuICogYW5kIHRoZSBjbGFtcCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLiAoVGhpcyBmaWxlIHVzZWQgdG8gc2F5XG4gKiBncmFwZXZpbmUgXCJkb2VzIG5vdCBlbnYtdHVuZSBpdFwiIHdoaWxlIGBkYWVtb24udHNgIGVudi10dW5lZCBpdCB0ZW4gbGluZXMgZnJvbVxuICogd2hlcmUgaXQgaW1wb3J0ZWQgdGhpcyBjb25zdGFudCDigJQgdGhlIHNhbWUgb25lLWhhbGYtdHVuYWJsZSBzcGxpdCBhcyB0aGUgYmVhdCxcbiAqIGFuZCBjb3JyZWN0ZWQgaW4gdGhlIHNhbWUgY2hhcHRlci4pXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKlxuICogVGhlIFNTRSBrZWVwYWxpdmUsIGluIG1zIOKAlCB0aGUgREVGQVVMVCwgYmVmb3JlIHRoZSBlbnYgaXMgY29uc3VsdGVkLlxuICog4pqgICoqMyBzLCBhbmQgaXQgaXMgTk9UIHRoZSBob3VzZSBkZWZhdWx0IG9mIDE1IHMqKiDigJQgZ3JhcGV2aW5lIGlzIHRoZSBvbmx5XG4gKiBzcGVsbCBpbiB0aGUgcm9zdGVyIHRoYXQgYmVhdHMgdGhpcyBmYXN0LCBhbmQgdGhlIG51bWJlciBpcyBsb2FkLWJlYXJpbmdcbiAqIHJhdGhlciB0aGFuIGluY2lkZW50YWw6IHRoZSBiZWF0IGlzIGFsc28gZ3JhcGV2aW5lJ3MgZGVhZC1zdWJzY3JpYmVyIHByb2JlLiBBXG4gKiB0YWlsIHdob3NlIHNvY2tldCBoYXMgZ29uZSBhd2F5IGlzIGRpc2NvdmVyZWQgd2hlbiB0aGUgZW5xdWV1ZSBmYWlscywgYW5kXG4gKiB1bnRpbCBpdCBpcyBkaXNjb3ZlcmVkIGB3aG9gLCBgL3ByZXNlbmNlYCBhbmQgZXZlcnkgc2VuZCdzIHJlY2lwaWVudCBjb3VudFxuICogcmVwb3J0IGEgZ2hvc3QuIEV2ZXJ5IG90aGVyIHNwZWxsJ3MgaGVhcnRiZWF0IG9ubHkgaGFzIHRvIGtlZXAgYSBjb25uZWN0aW9uXG4gKiBvcGVuOyB0aGlzIG9uZSBhbHNvIGhhcyB0byBrZWVwIGEgUk9TVEVSIGhvbmVzdCwgd2hpY2ggaXMgYSBodW1hbi12aXNpYmxlXG4gKiBudW1iZXIgaW4gdGhlIHdhdGNoIHN1cmZhY2UuIOKblCAqKlNvIHJhaXNpbmcgdGhpcyBrbm9iIG1ha2VzIHByZXNlbmNlXG4gKiBzdGFsZXIsIG5vdCBqdXN0IHF1aWV0ZXIqKiDigJQgaXQgaXMgdGhlIG9uZSB0aGluZyBhbiBvcGVyYXRvciB0dW5pbmcgaXQgc2hvdWxkXG4gKiBrbm93LlxuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TID0gM18wMDA7XG5cbi8qKlxuICogVGhlIGJlYXQgYXMgaXQgd2lsbCBhY3R1YWxseSBiZSB1c2VkLCBlbnYtcmVzb2x2ZWQgYW5kIGNsYW1wZWQgYXQgYm90aCBlbmRzIGJ5XG4gKiB0aGUga2l0OiBuZXZlciBhYm92ZSBgSURMRV9USU1FT1VUX1NFQyAvIDJgIChvciBCdW4gY2xvc2VzIHRoZSBjb25uZWN0aW9uIHRoZVxuICoga2VlcGFsaXZlIHdhcyBwcmVzZXJ2aW5nKSwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIOKblCBUSEUgRkxPT1IgSVMgTk9UIERFQ09SQVRJT04gKEQ3NikuIGBpbnRPcmAgcGFyc2VzIHdpdGggYHBhcnNlSW50YCwgd2hpY2hcbiAqIHJlYWRzIGBcIjFlOVwiYCDigJQgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdCBodWdlXCIg4oCUIGFzICoqMSoqLlxuICogRHJpdmVuIGJlZm9yZSB0aGUgZmxvb3IgZXhpc3RlZDogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOFxuICoga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0UgY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIOKGkiAzIG1zIGFuZFxuICogYFwiNWFiY1wiYCDihpIgNSBtcyBhcnJpdmUgdGhlIHNhbWUgd2F5LiBUaGUgZmxvb3IgbGl2ZXMgaW4gdGhlIGtpdCdzXG4gKiBgaGVhcnRiZWF0TXNgIGJlc2lkZSB0aGUgY2VpbGluZyBpdCBjYW5ub3QgY3Jvc3MsIE5PVCBpbiBgaW50T3JgLCB3aGljaCBldmVyeVxuICogb3RoZXIga25vYiBpbiB0aGUgaG91c2Ugc2hhcmVzLlxuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKFxuICBwcm9jZXNzLmVudi5HUkFQRVZJTkVfSEVBUlRCRUFUX01TLFxuICBJRExFX1RJTUVPVVRfU0VDLFxuICBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMsXG4pO1xuXG4vKipcbiAqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMsIERFUklWRUQuIDksMDAwIG1zIGF0IHRoZSBkZWZhdWx0LlxuICpcbiAqIOKblCAqKlRIRSBUQUlMIEhBRCBOTyBXQVRDSERPRyBBVCBBTEwgQkVGT1JFIFRISVMuKiogYGNtZFRhaWxgJ3MgaW5uZXIgbG9vcFxuICogYXdhaXRlZCBgcmVhZGVyLnJlYWQoKWAgd2l0aCBub3RoaW5nIGJvdW5kaW5nIGl0LCBzbyBhIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXJcbiAqIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kIG9yIGEgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgRk9SRVZFUiDigJQgYW5kXG4gKiBhIHBhcmtlZCB0YWlsIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gYSBxdWlldCBjaGFubmVsLCB3aGljaCBpcyB0aGUgc3RhdGVcbiAqIGdyYXBldmluZSdzIGNhbGxlcnMgc3BlbmQgbW9zdCBvZiB0aGVpciB0aW1lIGluLlxuICpcbiAqIOKaoCA5IHMgaXMgYWdncmVzc2l2ZSBieSBob3VzZSBzdGFuZGFyZHMgKDQ1IHMgZXZlcnl3aGVyZSBlbHNlKSBhbmQgdGhhdCBpcyB0aGVcbiAqIGRlcml2YXRpb24gd29ya2luZywgbm90IGEgbWlzdGFrZTogaXQgaXMgdGhyZWUgb2YgVEhJUyBzcGVsbCdzIGJlYXRzLiBIb2xkaW5nXG4gKiB0aGUgY29ubmVjdGlvbiBvcGVuIElTIGEgdGFpbCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwc1xuICogYSBuYW1lIGluIGEgaHVtYW4ncyByb3N0ZXIg4oCUIHdoaWNoIGlzIHdoeSBpdCBpcyB0aHJlZSBiZWF0cyBhbmQgbm90IHR3by5cbiAqXG4gKiDim5QgREVSSVZFRCBGUk9NIFRIRSBSRVNPTFZFRCBCRUFULCBORVZFUiBGUk9NIFRIRSBERUZBVUxULiBJdCBpc1xuICogYFNTRV9IRUFSVEJFQVRfTVNgIGFib3ZlIGFuZCBub3QgYERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NU2Agb24gcHVycG9zZTsgdGhlXG4gKiByZXBhaXIgY2hhcHRlciBpcyB3aGF0IHRoZSBkaWZmZXJlbmNlIGNvc3QuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQWlCQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFRQTtBQUNBO0FBQ0E7OztBQ2dEQTs7O0FDckRPLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBaUNBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FFSSxPQUFPLFFBQVEsRUFBRSxPQUFPLE1BQU0sTUFBTSxJQUFJLENBQUM7QUFBQSxTQUN6QyxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUlJLE1BQU0saUJBQWlCLE1BQU07QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUVULFdBQVcsQ0FBQyxNQUFlLFNBQWlCLE9BQWtCO0FBQUEsSUFDNUQsTUFBTSxPQUFPO0FBQUEsSUFDYixLQUFLLE9BQU87QUFBQSxJQUNaLEtBQUssT0FBTztBQUFBLElBQ1osS0FBSyxRQUFRO0FBQUE7QUFBQSxNQUdYLFFBQVEsR0FBVztBQUFBLElBQ3JCLE9BQU8sU0FBUyxLQUFLO0FBQUE7QUFFekI7QUFLTyxTQUFTLEdBQUcsQ0FBQyxTQUFpQixPQUFnQixTQUFTLE9BQXlCO0FBQUEsRUFDckYsTUFBTSxJQUFJLFNBQVMsTUFBTSxTQUFTLEtBQUs7QUFBQTtBQVNsQyxTQUFTLGNBQWMsQ0FDNUIsR0FDQSxNQUF5QyxRQUFRLFFBQ2xDO0FBQUEsRUFDZixJQUFJLEVBQUUsYUFBYTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQ3JDLElBQUksTUFBTSxjQUFjLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUNuRCxPQUFPLEVBQUU7QUFBQTs7O0FGK0ZYLElBQU0sZUFBZTtBQUFBLEVBQ25CLEVBQUUsTUFBTSxVQUFVLE1BQU0sT0FBTztBQUFBLEVBQy9CLEVBQUUsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLEVBQzNCLEVBQUUsTUFBTSxhQUFhLE1BQU0sVUFBVTtBQUFBLEVBQ3JDLEVBQUUsTUFBTSxNQUFNLE1BQU0sVUFBVTtBQUNoQztBQUlBLElBQU0sc0JBQXNCLGFBQWEsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FDMUQsQ0FBQyxHQUFHLE1BQU0sT0FBTyxFQUFFLFdBQVcsSUFBSSxDQUFDLElBQUksT0FBTyxFQUFFLFdBQVcsSUFBSSxDQUFDLENBQ2xFO0FBRUEsSUFBTSxVQUFVLENBQUMsTUFDZixLQUFLLE9BQU8sTUFBTSxhQUFZLFVBQVUsS0FBSSxPQUFRLEVBQXdCLElBQUksSUFBSTtBQUN0RixJQUFNLGFBQWEsQ0FBQyxNQUF3QixhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUU5RSxTQUFTLFNBQXVDLENBQUMsTUFBdUI7QUFBQSxFQUM3RSxNQUFNLFVBQVUsS0FBSztBQUFBLEVBQ3JCLE1BQU0sYUFBYSxPQUFPLEtBQUssS0FBSyxPQUFPO0FBQUEsRUFDM0MsTUFBTSxRQUFRLElBQUksSUFBSSxVQUFVO0FBQUEsRUFDaEMsTUFBTSxVQUFVLEtBQUssV0FBVztBQUFBLEVBQ2hDLE1BQU0sVUFBVSxDQUFDLEdBQUksS0FBSyxlQUFlLENBQUMsQ0FBRTtBQUFBLEVBQzVDLE1BQU0sUUFBUSxJQUFJLElBQWEsS0FBSyxjQUFjLENBQUMsQ0FBYztBQUFBLEVBRWpFLFdBQVcsS0FBSyxTQUFTO0FBQUEsSUFDdkIsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDO0FBQUEsTUFDZCxNQUFNLElBQUksTUFBTSxhQUFhLDBCQUEwQixzQkFBc0I7QUFBQSxFQUNqRjtBQUFBLEVBQ0EsS0FBSyxLQUFLLFVBQVUsVUFBVSxPQUFPLEtBQUssS0FBSyxTQUFTLFdBQVc7QUFBQSxJQUNqRSxNQUFNLElBQUksTUFBTSxhQUFhLDBDQUEwQztBQUFBLEVBQ3pFO0FBQUEsRUFJQSxNQUFNLGVBQWUsT0FBTyxZQUMxQixXQUFXLElBQUksQ0FBQyxNQUFNO0FBQUEsSUFDcEIsUUFBUSxTQUFTLE9BQU8sU0FBUyxLQUFLLFFBQVE7QUFBQSxJQUM5QyxPQUFPLENBQUMsR0FBRyxJQUFJO0FBQUEsR0FDaEIsQ0FDSDtBQUFBLEVBQ0EsTUFBTSxhQUFhLElBQUk7QUFBQSxFQUN2QixXQUFXLEtBQUssWUFBWTtBQUFBLElBQzFCLE1BQU0sSUFBSSxLQUFLLFFBQVEsSUFBSTtBQUFBLElBQzNCLElBQUksTUFBTTtBQUFBLE1BQVcsV0FBVyxJQUFJLEdBQUcsQ0FBQztBQUFBLEVBQzFDO0FBQUEsRUFFQSxNQUFNLGFBQWEsQ0FBQyxRQUFxQztBQUFBLElBQ3ZELE1BQU0sTUFBTSxJQUFJLElBQUksQ0FBQyxHQUFHLFNBQVMsR0FBRyxHQUFHLENBQUM7QUFBQSxJQUN4QyxPQUFPLFdBQVcsT0FBTyxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsQ0FBQztBQUFBO0FBQUEsRUFHNUMsTUFBTSxRQUFRLENBQ1osR0FDQSxTQUNRO0FBQUEsSUFDUixXQUFXLEtBQUssRUFBRSxPQUFPO0FBQUEsTUFDdkIsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLEdBQUc7QUFBQSxRQUNqQixNQUFNLElBQUksTUFBTSxhQUFhLGtCQUFrQixFQUFFLHFCQUFxQixvQkFBb0I7QUFBQSxNQUM1RjtBQUFBLElBQ0Y7QUFBQSxJQUNBLFdBQVcsS0FBSyxFQUFFLGlCQUFpQixDQUFDLEdBQUc7QUFBQSxNQUNyQyxJQUFJLENBQUMsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUFBLFFBQ3JCLE1BQU0sSUFBSSxNQUNSLGFBQWEsa0JBQWtCLEVBQUUsd0JBQXdCLHdCQUMzRDtBQUFBLElBQ0o7QUFBQSxJQUNBLE9BQU87QUFBQSxNQUNMLE1BQU0sRUFBRTtBQUFBLE1BQ1IsU0FBUyxDQUFDLEdBQUksRUFBRSxXQUFXLENBQUMsQ0FBRTtBQUFBLE1BQzlCLE9BQU8sQ0FBQyxHQUFHLEVBQUUsS0FBSztBQUFBLE1BQ2xCLFVBQVUsV0FBVyxFQUFFLEtBQUs7QUFBQSxNQUM1QixhQUFhLEVBQUUsWUFBWSxJQUFJLENBQUMsT0FBTyxLQUFLLEVBQUUsRUFBRTtBQUFBLE1BQ2hELFVBQVUsRUFBRTtBQUFBLE1BQ1o7QUFBQSxNQUNBLFlBQVksRUFBRTtBQUFBLE1BQ2Qsa0JBQWtCLEVBQUUsb0JBQW9CO0FBQUEsTUFDeEMsVUFBVSxLQUFNLEVBQUUsWUFBWSxDQUFDLEVBQUc7QUFBQSxNQUNsQyxVQUFVLENBQUMsR0FBSSxFQUFFLFlBQVksQ0FBQyxDQUFFO0FBQUEsTUFDaEMsVUFBVSxJQUFJLElBQUksRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO0FBQUEsTUFDdkMsT0FBTyxFQUFFO0FBQUEsTUFDVCxLQUFLLEVBQUU7QUFBQSxJQUNUO0FBQUE7QUFBQSxFQUdGLE1BQU0sUUFBZSxLQUFLLFlBQVksQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLE1BQU0sR0FBa0IsS0FBSyxDQUFDO0FBQUEsRUFHbkYsTUFBTSxNQUFNLENBQUM7QUFBQSxFQUNiLE1BQU0sV0FBMEI7QUFBQSxJQUM5QjtBQUFBLE1BQ0UsTUFBTTtBQUFBLE1BQ04sT0FBTyxDQUFDO0FBQUEsTUFDUixhQUFhLENBQUM7QUFBQSxNQUNkLFVBQVU7QUFBQSxNQUNWLEtBQUssWUFBWTtBQUFBLFFBQ2YsVUFBVSxNQUFNLEtBQUssUUFBUSxDQUFDO0FBQUE7QUFBQSxJQUVsQztBQUFBLElBQ0E7QUFBQSxNQUNFLE1BQU07QUFBQSxNQUNOLE9BQU8sQ0FBQztBQUFBLE1BQ1IsYUFBYSxDQUFDO0FBQUEsTUFDZCxVQUFVO0FBQUEsTUFDVixLQUFLLE1BQU07QUFBQSxRQUNULFFBQVEsT0FBTyxNQUFNLEdBQUcsS0FBSyxVQUFVLElBQUksWUFBWSxHQUFHLE1BQU0sQ0FBQztBQUFBLENBQUs7QUFBQTtBQUFBLElBRTFFO0FBQUEsSUFDQTtBQUFBLE1BQ0UsTUFBTTtBQUFBLE1BQ04sT0FBTyxDQUFDO0FBQUEsTUFDUixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxPQUFPLFVBQVUsS0FBSyxDQUFDO0FBQUEsTUFDL0QsVUFDRTtBQUFBLE1BQ0YsS0FBSyxDQUFDLFFBQVE7QUFBQSxRQUNaLE1BQU0sT0FBTyxJQUFJLElBQUksU0FBUyxJQUFJLElBQUksZUFBZSxJQUFJLElBQUksS0FBSyxHQUFHLENBQUMsSUFBSSxJQUFJLFdBQVc7QUFBQSxRQUN6RixRQUFRLE9BQU8sTUFBTSxLQUFLLFNBQVM7QUFBQSxDQUFJLElBQUksT0FBTyxHQUFHO0FBQUEsQ0FBUTtBQUFBO0FBQUEsSUFFakU7QUFBQSxFQUNGO0FBQUEsRUFDQSxXQUFXLEtBQUssVUFBVTtBQUFBLElBQ3hCLElBQUksQ0FBQyxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxFQUFFLElBQUk7QUFBQSxNQUFHLEtBQUssS0FBSyxNQUFNLEdBQUcsSUFBSSxDQUFDO0FBQUEsRUFDcEU7QUFBQSxFQUVBLE1BQU0sVUFDSixLQUFLLFNBQVMsWUFBWSxZQUFZLE1BQU0sS0FBTSxLQUFLLE1BQW1CLE1BQU0sR0FBRyxHQUFHLEtBQUs7QUFBQSxFQUc3RixNQUFNLFVBQVUsSUFBSTtBQUFBLEVBQ3BCLFdBQVcsS0FBSyxNQUFNO0FBQUEsSUFDcEIsV0FBVyxLQUFLLENBQUMsRUFBRSxNQUFNLEdBQUcsRUFBRSxPQUFPLEdBQUc7QUFBQSxNQUN0QyxNQUFNLFFBQVEsRUFBRSxNQUFNLEdBQUc7QUFBQSxNQUN6QixJQUFJLEVBQUUsS0FBSyxNQUFNLEtBQUssTUFBTSxTQUFTLEtBQUssTUFBTSxLQUFLLENBQUMsTUFBTSxNQUFNLE1BQU0sRUFBRSxXQUFXLEdBQUcsQ0FBQyxHQUFHO0FBQUEsUUFDMUYsTUFBTSxJQUFJLE1BQU0sYUFBYSwrQkFBK0IsSUFBSTtBQUFBLE1BQ2xFO0FBQUEsTUFDQSxJQUFJLE1BQU0sRUFBRSxRQUFRLE1BQU0sV0FBVyxFQUFFLEtBQUssTUFBTSxHQUFHLEVBQUUsUUFBUTtBQUFBLFFBQzdELE1BQU0sSUFBSSxNQUFNLGFBQWEsb0JBQW9CLHNCQUFzQixFQUFFLE9BQU87QUFBQSxNQUNsRjtBQUFBLE1BQ0EsSUFBSSxNQUFNLFdBQVcsS0FBSyxNQUFNLEVBQUUsUUFBUSxNQUFNLE9BQU8sRUFBRSxLQUFLLE1BQU0sR0FBRyxFQUFFLElBQUk7QUFBQSxRQUMzRSxNQUFNLElBQUksTUFBTSxhQUFhLG9CQUFvQiwrQkFBK0IsRUFBRSxPQUFPO0FBQUEsTUFDM0Y7QUFBQSxNQUNBLElBQUksUUFBUSxJQUFJLENBQUM7QUFBQSxRQUFHLE1BQU0sSUFBSSxNQUFNLGFBQWEsY0FBYyxxQkFBcUI7QUFBQSxNQUNwRixRQUFRLElBQUksR0FBRyxDQUFDO0FBQUEsSUFDbEI7QUFBQSxFQUNGO0FBQUEsRUFDQSxNQUFNLFNBQVMsSUFBSTtBQUFBLEVBQ25CLFdBQVcsS0FBSyxRQUFRLEtBQUssR0FBRztBQUFBLElBQzlCLE9BQU8sT0FBTyxPQUFPLEVBQUUsTUFBTSxHQUFHO0FBQUEsSUFDaEMsSUFBSSxVQUFVLGFBQWEsUUFBUSxXQUFXO0FBQUEsTUFDNUMsT0FBTyxJQUFJLE9BQU8sQ0FBQyxHQUFJLE9BQU8sSUFBSSxLQUFLLEtBQUssQ0FBQyxHQUFJLEdBQUcsQ0FBQztBQUFBLElBQ3ZEO0FBQUEsRUFDRjtBQUFBLEVBQ0EsV0FBVyxLQUFLLE9BQU8sS0FBSyxLQUFLLFVBQVUsQ0FBQyxDQUFDLEdBQUc7QUFBQSxJQUM5QyxJQUFJLENBQUMsT0FBTyxJQUFJLENBQUM7QUFBQSxNQUFHLE1BQU0sSUFBSSxNQUFNLGFBQWEsb0JBQW9CLHFCQUFxQjtBQUFBLEVBQzVGO0FBQUEsRUFFQSxNQUFNLFFBQVEsQ0FBQyxHQUFHLFFBQVEsS0FBSyxDQUFDO0FBQUEsRUFDaEMsTUFBTSxRQUFRLENBQUMsR0FBRyxJQUFJLElBQUksTUFBTSxJQUFJLENBQUMsTUFBTSxFQUFFLE1BQU0sR0FBRyxFQUFFLEVBQVksQ0FBQyxDQUFDO0FBQUEsRUFFdEUsTUFBTSxTQUFTLENBQUMsU0FBbUMsU0FBUyxLQUFLLFVBQVUsUUFBUSxJQUFJLElBQUk7QUFBQSxFQUMzRixNQUFNLFdBQVcsQ0FBQyxTQUNoQixDQUFDLEdBQUksT0FBTyxJQUFJLEdBQUcsWUFBWSxDQUFDLENBQUUsRUFBRSxJQUFJLENBQUMsTUFBTSxLQUFLLEdBQUcsRUFBRSxLQUFLO0FBQUEsRUFDaEUsTUFBTSxRQUFRLENBQUMsTUFBbUIsRUFBRSxRQUFRO0FBQUEsRUFXNUMsTUFBTSxlQUF5QixNQUFNO0FBQUEsSUFDbkMsTUFBTSxNQUFNLENBQUMsR0FBRyxTQUFTLEVBQUUsR0FBRyxHQUFHLG1CQUFtQjtBQUFBLElBQ3BELE1BQU0sT0FBTyxJQUFJLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxJQUFJLENBQUMsRUFBRSxLQUFLO0FBQUEsSUFDeEQsT0FBTyxDQUFDLEdBQUcsTUFBTSxHQUFHLElBQUksT0FBTyxDQUFDLE1BQU0sQ0FBQyxFQUFFLFdBQVcsSUFBSSxDQUFDLENBQUM7QUFBQSxLQUN6RDtBQUFBLEVBSUgsTUFBTSxtQkFBbUIsQ0FBQyxNQUE4QjtBQUFBLElBQ3RELE1BQU0sUUFBUSxFQUFFLFdBQVcsR0FBRyxFQUFFLFlBQVksRUFBRTtBQUFBLElBQzlDLE9BQU8sRUFBRSxXQUFXLElBQUksV0FBVyxJQUFJO0FBQUE7QUFBQSxFQUV6QyxNQUFNLGFBQWEsQ0FBQyxHQUFXLFdBQVcsVUFBa0I7QUFBQSxJQUMxRCxNQUFNLE9BQU8sS0FBSyxRQUFRLElBQUksU0FBUyxZQUFZLEtBQUssTUFBTSxLQUFLO0FBQUEsSUFDbkUsT0FBTyxXQUFXLE9BQU8sSUFBSTtBQUFBO0FBQUEsRUFFL0IsTUFBTSxZQUFZLENBQUMsTUFDakI7QUFBQSxJQUNFLE1BQU0sQ0FBQztBQUFBLElBQ1AsR0FBRyxFQUFFLFlBQVksSUFBSSxnQkFBZ0I7QUFBQSxJQUNyQyxHQUFHLEVBQUUsTUFBTSxPQUFPLENBQUMsTUFBTSxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUMsRUFBRSxJQUFJLENBQUMsTUFBTSxXQUFXLEdBQUcsRUFBRSxTQUFTLElBQUksQ0FBQyxDQUFDLENBQUM7QUFBQSxFQUNyRixFQUFFLEtBQUssR0FBRztBQUFBLEVBQ1osTUFBTSxVQUFVLENBQUMsTUFBbUIsWUFBWSxVQUFVLENBQUM7QUFBQSxFQUUzRCxNQUFNLGFBQWEsTUFBYztBQUFBLElBQy9CLElBQUksS0FBSyxTQUFTO0FBQUEsTUFBVyxPQUFPLEtBQUssS0FBSztBQUFBLElBQzlDLE1BQU0sU0FBUyxDQUFDLEdBQUksVUFBVSxDQUFDLE9BQU8sSUFBSSxDQUFDLEdBQUksR0FBRyxJQUFJO0FBQUEsSUFDdEQsTUFBTSxRQUFRLE9BQU8sSUFBSSxDQUFDLE1BQU0sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLFFBQVEsQ0FBVTtBQUFBLElBQ25FLE1BQU0sUUFBUSxLQUFLLElBQUksS0FBSyxJQUFJLEdBQUcsTUFBTSxJQUFJLEVBQUUsT0FBTyxFQUFFLE1BQU0sQ0FBQyxHQUFHLEVBQUU7QUFBQSxJQUNwRSxNQUFNLE9BQU8sTUFDVixJQUFJLEVBQUUsR0FBRyxPQUNSLEVBQUUsVUFBVSxRQUFRLEtBQUssRUFBRSxPQUFPLEtBQUssTUFBTSxNQUFNLEtBQUs7QUFBQSxJQUFRLEdBQUcsT0FBTyxLQUFLLE1BQU0sR0FDdkYsRUFDQyxLQUFLO0FBQUEsQ0FBSTtBQUFBLElBQ1osTUFBTSxPQUFPLEtBQUssVUFBVSxHQUFHLGtCQUFhLEtBQUssWUFBWTtBQUFBLElBQzdELE1BQU0sU0FBUyxLQUFLLGFBQWEsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxLQUFLO0FBQUEsSUFDOUQsT0FBTyxHQUFHO0FBQUE7QUFBQSxFQUFXO0FBQUEsRUFBUyxTQUFTLEtBQUssYUFBYTtBQUFBO0FBQUEsRUFBTyxLQUFLLGVBQWU7QUFBQTtBQUFBLEVBU3RGLE1BQU0sZ0JBQWdCLENBQUMsTUFBbUI7QUFBQSxJQUN4QyxNQUFNLE9BQU8sQ0FBQyxNQUFjO0FBQUEsTUFDMUIsTUFBTSxRQUFRLEtBQUssUUFBUSxJQUFJLFNBQVMsWUFBWSxLQUFLLE1BQU0sS0FBSyxNQUFNO0FBQUEsTUFDMUUsT0FBTyxDQUFDLE9BQU8sRUFBRSxTQUFTLE1BQU0sRUFBRTtBQUFBO0FBQUEsSUFFcEMsTUFBTSxXQUFXLENBQUMsTUFBYyxDQUFDLEVBQUUsTUFBTSxTQUFTLENBQUMsS0FBSyxRQUFRLFNBQVMsQ0FBQztBQUFBLElBQzFFLE1BQU0sTUFBTSxFQUFFLFNBQVMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLE1BQU0sSUFBSSxDQUFDLENBQUMsRUFBRSxJQUFJLElBQUk7QUFBQSxJQUM1RSxNQUFNLFNBQVMsRUFBRSxTQUFTLE9BQU8sUUFBUSxFQUFFLElBQUksSUFBSTtBQUFBLElBR25ELE1BQU0sU0FBUyxFQUFFLFNBQVMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsS0FBSyxNQUFNLElBQUksQ0FBQyxDQUFDLEVBQUUsSUFBSSxJQUFJO0FBQUEsSUFDOUUsTUFBTSxRQUFRLEtBQUssSUFDakIsS0FBSyxJQUFJLEdBQUcsR0FBRyxDQUFDLEdBQUcsS0FBSyxHQUFHLFFBQVEsR0FBRyxNQUFNLEVBQUUsSUFBSSxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsR0FDcEUsRUFDRjtBQUFBLElBQ0EsTUFBTSxTQUFTLENBQUMsVUFDZCxNQUFNLElBQUksRUFBRSxHQUFHLE9BQ2IsTUFBTSxLQUNGLEtBQUssTUFDTCxFQUFFLFVBQVUsUUFDVixLQUFLLEVBQUUsT0FBTyxLQUFLLE1BQU0sTUFDekIsS0FBSztBQUFBLElBQVEsR0FBRyxPQUFPLEtBQUssTUFBTSxHQUMxQztBQUFBLElBQ0YsT0FBTztBQUFBLE1BQ0wsVUFBVSxVQUFVLENBQUM7QUFBQSxNQUNyQixHQUFJLEVBQUUsYUFBYSxLQUFLLENBQUMsSUFBSSxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsTUFDNUMsR0FBSSxJQUFJLFNBQVMsSUFBSSxDQUFDLElBQUksVUFBVSxHQUFHLE9BQU8sR0FBRyxDQUFDLElBQUksQ0FBQztBQUFBLE1BQ3ZELEdBQUksT0FBTyxTQUFTLElBQUksQ0FBQyxJQUFJLGlCQUFpQixHQUFHLE9BQU8sTUFBTSxDQUFDLElBQUksQ0FBQztBQUFBLE1BQ3BFLEdBQUksT0FBTyxTQUFTLElBQUksQ0FBQyxJQUFJLGtCQUFrQixHQUFHLE9BQU8sTUFBTSxDQUFDLElBQUksQ0FBQztBQUFBLE1BQ3JFLEdBQUksRUFBRSxTQUFTLFNBQVMsSUFBSSxDQUFDLElBQUksYUFBYSxHQUFHLEVBQUUsU0FBUyxJQUFJLENBQUMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFBQSxJQUN2RixFQUFFLEtBQUs7QUFBQSxDQUFJO0FBQUE7QUFBQSxFQUliLE1BQU0saUJBQWlCLENBQUMsU0FBeUI7QUFBQSxJQUMvQyxNQUFNLElBQUksUUFBUSxJQUFJLElBQUk7QUFBQSxJQUMxQixJQUFJLE1BQU07QUFBQSxNQUNSLE9BQU8sSUFBSSxrQkFBa0IsU0FBUyxTQUFTO0FBQUEsUUFDN0MsU0FBUztBQUFBLFFBQ1QsTUFBTTtBQUFBLE1BQ1IsQ0FBQztBQUFBLElBQ0gsT0FBTyxjQUFjLENBQUM7QUFBQTtBQUFBLEVBaUJ4QixNQUFNLGNBQWMsTUFBTSxJQUFJLE1BQU0sSUFDaEMsWUFDQTtBQUFBLE9BQ0s7QUFBQSxJQUNILE1BQU0sV0FBVyxJQUFJLEdBQUcsSUFDcEIsRUFBRSxNQUFNLFVBQW1CLElBQzNCLEVBQUUsTUFBTSxXQUFvQixPQUFPLElBQUk7QUFBQSxFQUM3QztBQUFBLEVBQ0osTUFBTSxjQUFjLENBQUMsS0FBVSxTQUFxQztBQUFBLElBRWxFLElBQUksZ0JBQWdCO0FBQUEsTUFBVyxPQUFPO0FBQUEsSUFDdEMsSUFBSTtBQUFBLE1BQ0YsUUFBUSxXQUFXLFVBQVU7QUFBQSxRQUMzQixNQUFNLENBQUMsR0FBRyxJQUFJO0FBQUEsUUFDZCxTQUFTO0FBQUEsUUFDVCxRQUFRO0FBQUEsUUFDUixrQkFBa0IsSUFBSTtBQUFBLFFBQ3RCLFFBQVE7QUFBQSxNQUNWLENBQUM7QUFBQSxNQUNELE9BQU8sT0FBTyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsWUFBWSxFQUFFLFNBQVMsTUFBTTtBQUFBLE1BQ2xFLE1BQU07QUFBQSxNQUNOLE9BQU87QUFBQTtBQUFBO0FBQUEsRUFNWCxNQUFNLGNBQWMsTUFBbUI7QUFBQSxJQUNyQyxNQUFNLE1BQU0sQ0FBQyxPQUE0QjtBQUFBLE1BQ3ZDLE1BQU0sS0FBSztBQUFBLE1BQ1gsTUFBTyxLQUFLLFFBQVEsR0FBa0I7QUFBQSxNQUN0QyxRQUFRO0FBQUEsSUFDVjtBQUFBLElBQ0EsTUFBTSxXQUE4QjtBQUFBLE1BQ2xDO0FBQUEsUUFDRSxNQUFNLENBQUM7QUFBQSxRQUNQLE1BQU07QUFBQSxVQUNKLEdBQUcsYUFBYSxJQUFJLENBQUMsT0FBTztBQUFBLFlBQzFCLE1BQU0sRUFBRTtBQUFBLFlBQ1IsTUFBTTtBQUFBLFlBQ04sUUFBUTtBQUFBLFVBQ1YsRUFBRTtBQUFBLFVBQ0YsR0FBSSxVQUFVLFFBQVEsU0FBUyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQUEsUUFDN0M7QUFBQSxRQUNBLGFBQWEsVUFDVCxRQUFRLFlBQVksSUFBSSxDQUFDLE9BQU8sS0FBSyxFQUFFLEVBQUUsSUFDekMsQ0FBQyxFQUFFLE1BQU0sS0FBSyxrQkFBa0IsV0FBVyxVQUFVLEtBQUssQ0FBQztBQUFBLE1BQ2pFO0FBQUEsSUFDRjtBQUFBLElBQ0EsV0FBVyxLQUFLLE1BQU07QUFBQSxNQUNwQixXQUFXLEtBQUssQ0FBQyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sR0FBRztBQUFBLFFBQ3RDLFNBQVMsS0FBSztBQUFBLFVBQ1osTUFBTSxFQUFFLE1BQU0sR0FBRztBQUFBLFVBQ2pCLE1BQU0sRUFBRSxTQUFTLElBQUksR0FBRztBQUFBLFVBQ3hCLGFBQWEsRUFBRSxZQUFZLElBQUksQ0FBQyxPQUFPLEtBQUssRUFBRSxFQUFFO0FBQUEsUUFDbEQsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLFlBQVksUUFBUSxJQUFJLFFBQVE7QUFBQSxJQUN0QyxPQUFPO0FBQUEsTUFDTCxlQUFlO0FBQUEsTUFDZixZQUFZO0FBQUEsTUFDWixpQkFBaUIsRUFBRSxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUU7QUFBQSxNQUMxQztBQUFBLElBQ0Y7QUFBQTtBQUFBLEVBV0YsTUFBTSxpQkFBaUIsQ0FBQyxNQUFnQixxQkFBc0M7QUFBQSxJQUM1RSxTQUFTLElBQUksRUFBRyxJQUFJLEtBQUssUUFBUSxLQUFLO0FBQUEsTUFDcEMsTUFBTSxJQUFJLEtBQUs7QUFBQSxNQUNmLElBQUksTUFBTTtBQUFBLFFBQU0sT0FBTyxvQkFBb0IsSUFBSSxLQUFLLEtBQUssU0FBUyxLQUFLLElBQUk7QUFBQSxNQUMzRSxJQUFJLEVBQUUsV0FBVyxJQUFJLEdBQUc7QUFBQSxRQUN0QixJQUFJLEVBQUUsU0FBUyxHQUFHO0FBQUEsVUFBRztBQUFBLFFBQ3JCLElBQUksS0FBSyxRQUFRLEVBQUUsTUFBTSxDQUFDLElBQUksU0FBUztBQUFBLFVBQVU7QUFBQSxRQUNqRDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLElBQUksRUFBRSxXQUFXLEdBQUcsS0FBSyxFQUFFLFNBQVMsR0FBRztBQUFBLFFBQ3JDLE1BQU0sTUFBTSxFQUFFLFdBQVcsSUFBSSxXQUFXLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQyxJQUFJO0FBQUEsUUFDMUQsSUFBSSxRQUFRLGFBQWEsS0FBSyxRQUFRLE1BQU0sU0FBUztBQUFBLFVBQVU7QUFBQSxRQUMvRDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLE9BQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUdULE1BQU0sVUFBVSxDQUFDLE1BQWdCLE1BQXdCO0FBQUEsSUFDdkQsR0FBRyxLQUFLLE1BQU0sR0FBRyxDQUFDO0FBQUEsSUFDbEIsR0FBRyxLQUFLLE1BQU0sSUFBSSxDQUFDO0FBQUEsRUFDckI7QUFBQSxFQUVBLE1BQU0sWUFBWSxNQUNoQixJQUFJLHNCQUFzQixTQUFTO0FBQUEsSUFDakMsU0FBUyxDQUFDLEdBQUcsS0FBSztBQUFBLElBQ2xCLE1BQU0sU0FBUztBQUFBLEVBQ2pCLENBQUM7QUFBQSxFQUdILE1BQU0sVUFBVSxDQUFDLE1BQWMsU0FBZ0U7QUFBQSxJQUM3RixNQUFNLE9BQU8sT0FBTyxJQUFJLElBQUk7QUFBQSxJQUM1QixJQUFJLFNBQVMsV0FBVztBQUFBLE1BQ3RCLE1BQU0sS0FBSyxLQUFLLFNBQVMsT0FBTyxhQUFhO0FBQUEsTUFDN0MsSUFBSSxJQUFJO0FBQUEsTUFDUixJQUFJLE9BQU8sWUFBWTtBQUFBLFFBQ3JCLE1BQU0sT0FBTyxLQUFLO0FBQUEsUUFDbEIsSUFBSSxTQUFTLGFBQWEsQ0FBQyxLQUFLLFdBQVcsR0FBRyxJQUFJLElBQUk7QUFBQSxNQUN4RCxFQUFPO0FBQUEsUUFDTCxJQUFJLGVBQWUsTUFBTSxJQUFJO0FBQUE7QUFBQSxNQUUvQixNQUFNLE1BQU0sS0FBSyxJQUFLLEtBQUssS0FBZ0I7QUFBQSxNQUMzQyxNQUFNLE9BQU8sUUFBUSxZQUFZLFlBQVksUUFBUSxJQUFJLEdBQUcsUUFBUSxLQUFLO0FBQUEsTUFDekUsSUFBSSxTQUFTLGFBQWEsUUFBUSxXQUFXO0FBQUEsUUFDM0MsT0FBTyxFQUFFLEtBQUssTUFBTSxPQUFPLEdBQUcsUUFBUSxPQUFPLE1BQU0sUUFBUSxNQUFNLENBQUMsRUFBRTtBQUFBLE1BQ3RFO0FBQUEsTUFDQSxNQUFNLE1BQU0sUUFBUSxJQUFJLElBQUk7QUFBQSxNQUM1QixJQUFJLFFBQVE7QUFBQSxRQUFXLE9BQU8sRUFBRSxLQUFLLEtBQUssT0FBTyxNQUFNLE1BQU0sS0FBSztBQUFBLE1BQ2xFLE1BQU0sUUFBUSxFQUFFLFNBQVMsQ0FBQyxHQUFHLElBQUksR0FBRyxNQUFNLFNBQVMsMkJBQTJCO0FBQUEsTUFDOUUsSUFBSSxRQUFRO0FBQUEsUUFBVyxJQUFJLEdBQUcsZ0NBQWdDLFNBQVMsS0FBSztBQUFBLE1BQzVFLElBQUksV0FBVyxzQkFBc0IsUUFBUSxTQUFTLEtBQUs7QUFBQSxJQUM3RDtBQUFBLElBQ0EsTUFBTSxNQUFNLFFBQVEsSUFBSSxJQUFJO0FBQUEsSUFDNUIsSUFBSSxRQUFRLFdBQVc7QUFBQSxNQUNyQixJQUFJLG9CQUFvQixTQUFTLFNBQVM7QUFBQSxRQUN4QyxTQUFTLENBQUMsR0FBRyxLQUFLO0FBQUEsUUFDbEIsTUFBTSxTQUFTO0FBQUEsTUFDakIsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBLE9BQU8sRUFBRSxLQUFLLE9BQU8sTUFBTSxNQUFNLEtBQUs7QUFBQTtBQUFBLEVBaUJ4QyxNQUFNLGNBQWMsQ0FDbEIsS0FDQSxVQUNBLFdBQ1M7QUFBQSxJQUNULE1BQU0sTUFBTSxRQUFRLFVBQVUsQ0FBQyxNQUFNLEVBQUUsU0FBUyxtQkFBbUIsS0FBSztBQUFBLElBQ3hFLElBQUksV0FBVyxhQUFhLE1BQU07QUFBQSxNQUFHO0FBQUEsSUFDckMsTUFBTSxVQUFvQixDQUFDO0FBQUEsSUFDM0IsV0FBVyxLQUFLLE9BQU8sTUFBTSxNQUFNLENBQUMsR0FBRztBQUFBLE1BQ3JDLElBQUksRUFBRSxTQUFTO0FBQUEsUUFBYztBQUFBLE1BQzdCLE1BQU0sSUFBSSxFQUFFO0FBQUEsTUFDWixJQUFJO0FBQUEsTUFDSixJQUFJLEVBQUUsV0FBVyxJQUFJO0FBQUEsUUFBRyxNQUFNLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFBQSxNQUMvQyxTQUFJLEVBQUUsV0FBVyxLQUFLLEVBQUUsV0FBVyxHQUFHO0FBQUEsUUFBRyxNQUFNLFdBQVcsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDN0UsSUFBSSxRQUFRLGFBQWEsUUFBUSxNQUFNLFNBQVMsSUFBSSxHQUFHO0FBQUEsUUFBRyxRQUFRLEtBQUssQ0FBQztBQUFBLElBQzFFO0FBQUEsSUFDQSxJQUFJLFFBQVEsV0FBVztBQUFBLE1BQUc7QUFBQSxJQUMxQixNQUFNLFFBQVEsUUFBUSxLQUFLLElBQUk7QUFBQSxJQUMvQixNQUFNLE1BQU0sUUFBUSxXQUFXO0FBQUEsSUFDL0IsTUFBTSxLQUFLLE1BQU0sT0FBTztBQUFBLElBQ3hCLE1BQU0sTUFBTSxNQUFNLFFBQVE7QUFBQSxJQUMxQixNQUFNLFNBQVMsTUFBTSxjQUFjO0FBQUEsSUFDbkMsUUFBUSxPQUFPLE1BQ2IsY0FBYyxVQUFVLElBQUksU0FBUyxLQUFLLEtBQUssSUFBSSxJQUFJLFdBQVcsc0JBQXNCLHlCQUF5QixrQkFBa0IsTUFBTSxnQkFBZ0I7QUFBQSxDQUMzSjtBQUFBO0FBQUEsRUFHRixNQUFNLFNBQVMsT0FBTyxLQUFVLE9BQWUsU0FBb0M7QUFBQSxJQUNqRixrQkFBa0IsSUFBSSxTQUFTLEtBQUssT0FBTyxJQUFJLElBQUk7QUFBQSxJQUNuRCxNQUFNLE9BQU8sTUFBTSxHQUFHO0FBQUEsSUFNdEIsSUFBSSxZQUFZLEtBQUssSUFBSSxHQUFHO0FBQUEsTUFDMUIsUUFBUSxPQUFPLE1BQU0sR0FBRyxjQUFjLEdBQUc7QUFBQSxDQUFLO0FBQUEsTUFDOUMsT0FBTztBQUFBLElBQ1Q7QUFBQSxJQUNBLE1BQU0sV0FBVyxJQUFJLElBQUksSUFBSSxRQUFRO0FBQUEsSUFDckMsTUFBTSxVQUFVLElBQUksU0FBUyxLQUFLLGNBQWMsU0FBUyxJQUFJLElBQUk7QUFBQSxJQUNqRSxNQUFNLFdBQVcsTUFDZixDQUFDLElBQUksWUFBWSxRQUFRLFdBQVcsSUFBSSxHQUFHLHdCQUF3QixTQUFTLEVBQ3pFLE9BQU8sQ0FBQyxNQUFtQixNQUFNLFNBQVMsRUFDMUMsS0FBSyxJQUFJLEtBQUs7QUFBQSxJQUVuQixJQUFJO0FBQUEsSUFDSixJQUFJO0FBQUEsSUFDSixJQUFJO0FBQUEsSUFDSixJQUFJO0FBQUEsT0FDRCxFQUFFLFFBQVEsYUFBYSxPQUFPLElBQUksVUFBVTtBQUFBLFFBQzNDO0FBQUEsUUFDQSxTQUFTO0FBQUEsUUFDVCxRQUFRO0FBQUEsUUFDUixrQkFBa0IsSUFBSTtBQUFBLFFBQ3RCLFFBQVE7QUFBQSxNQUNWLENBQUM7QUFBQSxNQUNELE9BQU8sR0FBRztBQUFBLE1BQ1YsSUFBSSxRQUFRLENBQUMsTUFBTSxpQ0FBaUM7QUFBQSxRQUNsRCxJQUFJLEdBQUcsU0FBUyxXQUFXLENBQUMsS0FBSyxTQUFTLEVBQUUsU0FBUyxNQUFNLFNBQVMsRUFBRSxDQUFDO0FBQUEsTUFDekU7QUFBQSxNQUVBLElBQUksR0FBRyxTQUFTLFdBQVcsQ0FBQyxLQUFLLFNBQVMsRUFBRSxNQUFNLElBQUksY0FBYyxRQUFRLEdBQUcsRUFBRSxDQUFDO0FBQUE7QUFBQSxJQUtwRixNQUFNLFFBQVEsT0FBTyxLQUFLLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFNBQVMsSUFBSSxDQUFDLENBQUM7QUFBQSxJQUM5RCxJQUFJLFVBQVUsV0FBVztBQUFBLE1BQ3ZCLElBQ0UsS0FBSyw4QkFBOEIsOEJBQThCLCtCQUErQixJQUFJLFNBQVMsS0FBSyxZQUFZLGFBQzlILFNBQ0EsRUFBRSxTQUFTLE1BQU0sU0FBUyxFQUFFLENBQzlCO0FBQUEsSUFDRjtBQUFBLElBR0EsTUFBTSxXQUFXLElBQUksWUFBWSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLElBQzNELE1BQU0sV0FBVyxJQUFJLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsSUFDdkQsSUFBSSxZQUFZLFNBQVMsVUFBVTtBQUFBLE1BQ2pDLE1BQU0sVUFBVSxJQUFJLFlBQVksWUFBWTtBQUFBLE1BQzVDLElBQUksR0FBRywyQkFBMkIsU0FBUyxRQUFRLGVBQWUsU0FBUztBQUFBLFFBQ3pFLE1BQU0sUUFBUSxHQUFHO0FBQUEsTUFDbkIsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBLElBQUksQ0FBQyxZQUFZLFlBQVksU0FBUyxJQUFJLFlBQVksUUFBUTtBQUFBLE1BQzVELElBQ0UsR0FBRyw2QkFBNkIsS0FBSyxVQUFVLFlBQVksSUFBSSxZQUFZLE9BQU8sS0FDbEYsU0FDQSxFQUFFLE1BQU0sSUFBSSxZQUFZLFdBQVcsSUFBSSxHQUFHLDRCQUE0QixRQUFRLEdBQUcsRUFBRSxDQUNyRjtBQUFBLElBQ0Y7QUFBQSxJQUdBLE1BQU0sUUFBbUMsS0FBTSxPQUFxQztBQUFBLElBQ3BGLFdBQVcsS0FBSyxJQUFJLFVBQVU7QUFBQSxNQUM1QixNQUFNLElBQUssS0FBSyxRQUFRLEdBQWtCO0FBQUEsTUFDMUMsSUFBSSxNQUFNLE9BQU8sYUFBYSxNQUFNLFdBQVc7QUFBQSxRQUM3QyxNQUFNLEtBQU0sTUFBTSxRQUFRLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJO0FBQUEsTUFDMUM7QUFBQSxJQUNGO0FBQUEsSUFFQSxXQUFXLEtBQUssSUFBSTtBQUFBLE1BQ2xCLElBQUksTUFBTSxPQUFPO0FBQUEsUUFDZixJQUFJLEdBQUcsNEJBQTRCLEtBQUssU0FBUyxFQUFFLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUFBLElBRTNFLE1BQU0sTUFBa0IsRUFBRSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUssYUFBYSxNQUFNO0FBQUEsSUFDekUsTUFBTSxVQUFVLElBQUksUUFBUSxHQUFHO0FBQUEsSUFDL0IsSUFBSSxZQUFZO0FBQUEsTUFBVyxJQUFJLEdBQUcsU0FBUyxXQUFXLFNBQVMsRUFBRSxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFBQSxJQUVyRixZQUFZLEtBQUssVUFBVSxNQUFNO0FBQUEsSUFDakMsTUFBTSxNQUFNLE1BQU0sSUFBSSxJQUFJLEdBQUc7QUFBQSxJQUM3QixPQUFPLE9BQU8sUUFBUSxXQUFXLE1BQU07QUFBQTtBQUFBLEVBR3pDLE1BQU0sV0FBVyxPQUFPLFNBQW9DO0FBQUEsSUFDMUQsa0JBQWtCLEtBQUssTUFBTSxJQUFJO0FBQUEsSUFDakMsTUFBTSxRQUFRLEtBQUs7QUFBQSxJQUduQixNQUFNLGNBQWMsYUFBYSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsS0FBSztBQUFBLElBQzdELElBQUksZ0JBQWdCLFdBQVc7QUFBQSxNQUM3QixPQUFPLE9BQU8sUUFBUSxJQUFJLFlBQVksSUFBSSxHQUFVLFlBQVksTUFBTSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsSUFDckY7QUFBQSxJQUdBLElBQUksWUFBWSxXQUFXO0FBQUEsTUFDekIsSUFBSSxVQUFVLGNBQWMsUUFBUSxJQUFJLEtBQUssS0FBSyxPQUFPLElBQUksS0FBSyxJQUFJO0FBQUEsUUFDcEUsTUFBTSxLQUFJLFFBQVEsT0FBTyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsUUFDdEMsT0FBTyxPQUFPLEdBQUUsS0FBSyxHQUFFLE9BQU8sR0FBRSxJQUFJO0FBQUEsTUFDdEM7QUFBQSxNQUNBLE9BQU8sT0FBTyxTQUFTLElBQUksSUFBSTtBQUFBLElBQ2pDO0FBQUEsSUFHQSxJQUFJLFVBQVU7QUFBQSxNQUFXLE9BQU8sVUFBVTtBQUFBLElBRzFDLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxJQUNKLElBQUksWUFBWSxjQUFjO0FBQUEsTUFDNUIsSUFBSSxVQUFVLE1BQU07QUFBQSxRQUNsQixJQUFJLEtBQUssT0FBTztBQUFBLFVBQVcsT0FBTyxVQUFVO0FBQUEsUUFDNUMsT0FBTyxLQUFLO0FBQUEsUUFDWixPQUFPLENBQUMsTUFBTSxHQUFHLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQSxNQUNoQyxFQUFPLFNBQUksTUFBTSxXQUFXLEdBQUcsR0FBRztBQUFBLFFBQ2hDLE9BQU8sSUFBSSw2QkFBNkIsU0FBUyxTQUFTO0FBQUEsVUFDeEQsU0FBUyxDQUFDLEdBQUcsbUJBQW1CO0FBQUEsVUFDaEMsTUFBTSx3Q0FBd0MsTUFBTSxLQUFLLEdBQUc7QUFBQSxRQUM5RCxDQUFDO0FBQUEsTUFDSCxFQUFPO0FBQUEsUUFDTCxPQUFPO0FBQUEsUUFDUCxPQUFPLEtBQUssTUFBTSxDQUFDO0FBQUE7QUFBQSxJQUV2QixFQUFPO0FBQUEsTUFDTCxNQUFNLElBQUksZUFBZSxNQUFNLEtBQUs7QUFBQSxNQUNwQyxJQUFJLElBQUksR0FBRztBQUFBLFFBS1Qsa0JBQWtCLElBQUk7QUFBQSxRQUN0QixJQUFJO0FBQUEsVUFDRixVQUFVLEVBQUUsTUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRLE1BQU0sa0JBQWtCLEtBQUssQ0FBQztBQUFBLFVBQ3JGLE9BQU8sR0FBRztBQUFBLFVBQ1YsSUFBSSxXQUFXLENBQUMsR0FBRyxTQUFTO0FBQUEsWUFDMUIsU0FBUyxDQUFDLEdBQUcsbUJBQW1CO0FBQUEsWUFDaEMsTUFBTSxxQ0FBZ0MsTUFBTSxLQUFLLEdBQUcsV0FBVztBQUFBLFVBQ2pFLENBQUM7QUFBQTtBQUFBLFFBRUgsT0FBTyxVQUFVO0FBQUEsTUFDbkI7QUFBQSxNQUNBLE9BQU8sS0FBSztBQUFBLE1BR1osT0FBTyxRQUFRLE1BQU0sQ0FBQztBQUFBO0FBQUEsSUFFeEIsa0JBQWtCLElBQUk7QUFBQSxJQUN0QixNQUFNLElBQUksUUFBUSxNQUFNLElBQUk7QUFBQSxJQUM1QixPQUFPLE9BQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLElBQUk7QUFBQTtBQUFBLEVBR3RDLE1BQU0sT0FBTyxPQUFPLFNBQW9DO0FBQUEsSUFDdEQsSUFBSTtBQUFBLE1BQ0YsT0FBTyxNQUFNLFNBQVMsSUFBSTtBQUFBLE1BQzFCLE9BQU8sR0FBRztBQUFBLE1BQ1YsTUFBTSxXQUFXLGVBQWUsQ0FBQztBQUFBLE1BQ2pDLElBQUksYUFBYTtBQUFBLFFBQU0sT0FBTztBQUFBLE1BRzlCLE9BQU8sZUFBZSxJQUFJLFNBQVMsWUFBWSxXQUFXLENBQUMsQ0FBQyxDQUFDLEtBQUs7QUFBQTtBQUFBO0FBQUEsRUFJdEUsTUFBTSxPQUFPLENBQUMsT0FBcUI7QUFBQSxJQUNqQyxNQUFNLEVBQUU7QUFBQSxJQUNSLFNBQVMsRUFBRTtBQUFBLElBQ1gsT0FBTyxFQUFFO0FBQUEsSUFDVCxVQUFVLEVBQUU7QUFBQSxJQUNaLGFBQWEsRUFBRTtBQUFBLElBQ2YsVUFBVSxFQUFFO0FBQUEsSUFDWixNQUFNLEVBQUU7QUFBQSxFQUNWO0FBQUEsRUFFQSxPQUFPLE9BQU8sS0FBSztBQUFBLElBQ2pCLE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsU0FBUyxDQUFDLFNBQWlCO0FBQUEsTUFDekIsTUFBTSxJQUFJLE9BQU8sSUFBSTtBQUFBLE1BQ3JCLE9BQU8sTUFBTSxZQUFZLEtBQUssVUFBVSxDQUFDO0FBQUE7QUFBQSxJQUUzQztBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxpQkFBaUIsV0FBVyxJQUFJLENBQUMsTUFBTSxLQUFLLEdBQUc7QUFBQSxJQUMvQyxNQUFNLEtBQUssSUFBSSxJQUFJO0FBQUEsRUFDckIsQ0FBZTtBQUFBLEVBQ2YsT0FBTztBQUFBOzs7QUd0a0JULElBQU0sa0JBQWtCO0FBQ3hCLElBQU0sZ0JBQWdCLEVBQUUsV0FBVyxLQUFLLE9BQU8sS0FBSztBQVU3QyxTQUFTLGFBQWEsQ0FBQyxPQUc1QjtBQUFBLEVBQ0EsTUFBTSxXQUFxQixDQUFDO0FBQUEsRUFDNUIsTUFBTSxZQUFzQixDQUFDO0FBQUEsRUFDN0IsSUFBSSxRQUFRO0FBQUEsRUFDWixJQUFJLFVBQVU7QUFBQSxFQUVkLFdBQVcsUUFBUSxNQUFNLE1BQU07QUFBQSxDQUFJLEdBQUc7QUFBQSxJQUNwQyxJQUFJLFNBQVM7QUFBQSxNQUFJO0FBQUEsSUFDakIsSUFBSSxLQUFLLFdBQVcsR0FBRyxHQUFHO0FBQUEsTUFDeEIsU0FBUyxLQUFLLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQSxNQUMzQjtBQUFBLElBQ0Y7QUFBQSxJQUNBLE1BQU0sUUFBUSxLQUFLLFFBQVEsR0FBRztBQUFBLElBQzlCLE1BQU0sUUFBUSxVQUFVLEtBQUssT0FBTyxLQUFLLE1BQU0sR0FBRyxLQUFLO0FBQUEsSUFDdkQsSUFBSSxRQUFRLFVBQVUsS0FBSyxLQUFLLEtBQUssTUFBTSxRQUFRLENBQUM7QUFBQSxJQUNwRCxJQUFJLE1BQU0sV0FBVyxHQUFHO0FBQUEsTUFBRyxRQUFRLE1BQU0sTUFBTSxDQUFDO0FBQUEsSUFDaEQsSUFBSSxVQUFVLFFBQVE7QUFBQSxNQUNwQixVQUFVLEtBQUssS0FBSztBQUFBLE1BQ3BCLFVBQVU7QUFBQSxJQUNaLEVBQU8sU0FBSSxVQUFVLFNBQVM7QUFBQSxNQUM1QixRQUFRO0FBQUEsSUFDVjtBQUFBLEVBRUY7QUFBQSxFQUVBLElBQUksQ0FBQztBQUFBLElBQVMsT0FBTyxFQUFFLE9BQU8sTUFBTSxTQUFTO0FBQUEsRUFDN0MsT0FBTyxFQUFFLE9BQU8sRUFBRSxPQUFPLE1BQU0sVUFBVSxLQUFLO0FBQUEsQ0FBSSxFQUFFLEdBQUcsU0FBUztBQUFBO0FBVWxFLGVBQXNCLFVBQWMsQ0FBQyxNQUF3QztBQUFBLEVBQzNFLE1BQU0sTUFBTSxLQUFLLE9BQU8sUUFBUTtBQUFBLEVBQ2hDLE1BQU0sTUFBTSxLQUFLLE9BQU8sUUFBUTtBQUFBLEVBQ2hDLE1BQU0sU0FBUyxLQUFLLFVBQVU7QUFBQSxFQUM5QixNQUFNLFFBQVEsS0FBSyxTQUFTO0FBQUEsRUFDNUIsTUFBTSxlQUFlLEtBQUssZ0JBQWdCO0FBQUEsRUFFMUMsSUFBSSxTQUFTLEtBQUs7QUFBQSxFQUNsQixJQUFJLFFBQXVCLEtBQUssY0FBYztBQUFBLEVBQzlDLElBQUksZUFBZTtBQUFBLEVBQ25CLElBQUksZ0JBQWdCO0FBQUEsRUFDcEIsSUFBSSxlQUFlO0FBQUEsRUFDbkIsSUFBSSxRQUFRLE1BQU07QUFBQSxFQUNsQixJQUFJLE9BQU87QUFBQSxFQUNYLElBQUksU0FBZ0Q7QUFBQSxFQWdCcEQsSUFBSSxVQUFVO0FBQUEsRUFDZCxJQUFJLFVBQWtDO0FBQUEsRUFDdEMsSUFBSSxjQUFtQztBQUFBLEVBQ3ZDLE1BQU0sT0FBTyxDQUFDLGFBQXFCO0FBQUEsSUFDakMsVUFBVTtBQUFBLElBQ1YsT0FBTztBQUFBLElBQ1AsU0FBUyxNQUFNO0FBQUEsSUFDZixjQUFjO0FBQUE7QUFBQSxFQUloQixNQUFNLFVBQVUsQ0FBQyxPQUNmLElBQUksUUFBYyxDQUFDLGlCQUFpQjtBQUFBLElBQ2xDLElBQUk7QUFBQSxNQUFTLE9BQU8sYUFBYTtBQUFBLElBQ2pDLE1BQU0sU0FBUyxNQUFNO0FBQUEsTUFDbkIsYUFBYSxLQUFLO0FBQUEsTUFDbEIsY0FBYztBQUFBLE1BQ2QsYUFBYTtBQUFBO0FBQUEsSUFFZixNQUFNLFFBQVEsV0FBVyxRQUFRLEVBQUU7QUFBQSxJQUNuQyxjQUFjO0FBQUEsR0FDZjtBQUFBLEVBRUgsTUFBTSxXQUFXLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDN0IsTUFBTSxhQUFhLEtBQUssWUFBWTtBQUFBLEVBQ3BDLElBQUksWUFBWTtBQUFBLElBQ2QsUUFBUSxHQUFHLFVBQVUsUUFBUTtBQUFBLElBQzdCLFFBQVEsR0FBRyxXQUFXLFFBQVE7QUFBQSxFQUNoQztBQUFBLEVBSUEsTUFBTSxhQUFhLENBQUMsTUFBZTtBQUFBLElBQ2pDLElBQUssR0FBeUMsU0FBUztBQUFBLE1BQVMsS0FBSyxDQUFDO0FBQUE7QUFBQSxFQUV4RSxNQUFNLGFBQWE7QUFBQSxFQUluQixXQUFXLEtBQUssU0FBUyxVQUFVO0FBQUEsRUFFbkMsTUFBTSxnQkFBZ0IsTUFBTSxLQUFLLENBQUM7QUFBQSxFQUNsQyxLQUFLLFFBQVEsaUJBQWlCLFNBQVMsYUFBYTtBQUFBLEVBQ3BELElBQUksS0FBSyxRQUFRO0FBQUEsSUFBUyxLQUFLLENBQUM7QUFBQSxFQUVoQyxNQUFNLE9BQU8sQ0FBQyxTQUFpQjtBQUFBLElBQzdCLElBQUksTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBO0FBQUEsRUFJdkIsTUFBTSxPQUFPLENBQUMsU0FBb0M7QUFBQSxJQUNoRCxJQUFJLFNBQVMsUUFBUSxTQUFTO0FBQUEsTUFBVyxJQUFJLE1BQU0sR0FBRztBQUFBLENBQVE7QUFBQTtBQUFBLEVBR2hFLElBQUk7QUFBQSxJQUNGLE9BQU8sQ0FBQyxTQUFTO0FBQUEsTUFNZixNQUFNLE9BQU8sTUFBTSxLQUFLLFFBQVE7QUFBQSxNQU1oQyxJQUFJO0FBQUEsUUFBUztBQUFBLE1BQ2IsSUFBSSxTQUFTLE1BQU07QUFBQSxRQUNqQixNQUFNLFVBQVUsS0FBSyxlQUFlLEVBQUUsY0FBYyxjQUFjLENBQUMsS0FBSztBQUFBLFFBQ3hFLElBQUksWUFBWSxRQUFRO0FBQUEsVUFDdEIsU0FBUztBQUFBLFVBQ1QsT0FBTztBQUFBLFFBQ1Q7QUFBQSxRQUNBLE1BQU0sUUFBUSxLQUFLO0FBQUEsUUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFFBQ3ZDO0FBQUEsTUFDRjtBQUFBLE1BQ0EsZUFBZTtBQUFBLE1BRWYsTUFBTSxTQUFTLEtBQUssUUFBUSxRQUFRLFlBQVksS0FBSztBQUFBLFFBQ25ELE9BQU8sT0FBTyxNQUFNO0FBQUEsTUFDdEI7QUFBQSxNQUVBLE1BQU0sYUFBYTtBQUFBLE1BQ25CLElBQUksZUFBZTtBQUFBLE1BRW5CLElBQUksVUFBVTtBQUFBLE1BQ2QsTUFBTSxLQUFLLElBQUksZ0JBQWdCLE1BQU0sRUFBRSxTQUFTO0FBQUEsTUFDaEQsTUFBTSxNQUFNLEdBQUcsT0FBTyxLQUFLLE9BQU8sS0FBSyxJQUFJLE9BQU87QUFBQSxNQUVsRCxVQUFVLElBQUk7QUFBQSxNQUNkLE1BQU0sYUFBYTtBQUFBLE1BQ25CLElBQUksV0FBaUQ7QUFBQSxNQUNyRCxNQUFNLGdCQUFnQixNQUFNO0FBQUEsUUFDMUIsSUFBSSxVQUFVO0FBQUEsVUFBRztBQUFBLFFBQ2pCLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsV0FBVyxXQUFXLE1BQU0sV0FBVyxNQUFNLEdBQUcsTUFBTTtBQUFBO0FBQUEsTUFVeEQsSUFBSTtBQUFBLE1BQ0osSUFBSTtBQUFBLFFBQ0YsTUFBTSxNQUFNLE1BQU0sS0FBSyxFQUFFLFFBQVEsV0FBVyxPQUFPLENBQUM7QUFBQSxRQUNwRCxPQUFPLEdBQUc7QUFBQSxRQUNWLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsVUFBVTtBQUFBLFFBQ1YsSUFBSTtBQUFBLFVBQVM7QUFBQSxRQUNiLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxrQkFBa0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFFBQy9ELE1BQU0sUUFBUSxLQUFLO0FBQUEsUUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFFBQ3ZDO0FBQUE7QUFBQSxNQUdGLElBQUk7QUFBQSxRQUNGLElBQUksQ0FBQyxJQUFJLElBQUk7QUFBQSxVQUVYLE1BQU0sS0FBSyxjQUFjLEdBQUc7QUFBQSxVQUs1QixNQUFNLElBQUksTUFBTSxPQUFPLEVBQUUsTUFBTSxNQUFNLEVBQUU7QUFBQSxVQUN2QyxLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sUUFBUSxRQUFRLElBQUksT0FBTyxDQUFDLENBQUM7QUFBQSxVQUMvRCxNQUFNLFFBQVEsS0FBSztBQUFBLFVBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxVQUN2QztBQUFBLFFBQ0Y7QUFBQSxRQUNBLElBQUksQ0FBQyxJQUFJLE1BQU07QUFBQSxVQUliLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxXQUFXLFFBQVEsSUFBSSxPQUFPLENBQUMsQ0FBQztBQUFBLFVBQ2xFLE1BQU0sUUFBUSxLQUFLO0FBQUEsVUFDbkIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLE1BQU0sS0FBSztBQUFBLFVBQ3ZDO0FBQUEsUUFDRjtBQUFBLFFBRUEsZ0JBQWdCO0FBQUEsUUFDaEIsZUFBZTtBQUFBLFFBQ2YsY0FBYztBQUFBLFFBRWQsTUFBTSxTQUFTLElBQUksS0FBSyxVQUFVO0FBQUEsUUFDbEMsTUFBTSxVQUFVLElBQUk7QUFBQSxRQUNwQixJQUFJLE1BQU07QUFBQSxRQUVWLE9BQU8sQ0FBQyxTQUFTO0FBQUEsVUFDZixJQUFJO0FBQUEsVUFDSixJQUFJO0FBQUEsWUFDRixRQUFRLE1BQU0sT0FBTyxLQUFLO0FBQUEsWUFDMUIsT0FBTyxHQUFHO0FBQUEsWUFHVixJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxnQkFBZ0IsT0FBTyxFQUFFLENBQUMsQ0FBQztBQUFBLFlBQzNFO0FBQUE7QUFBQSxVQUVGLElBQUksTUFBTSxNQUFNO0FBQUEsWUFDZCxJQUFJLENBQUM7QUFBQSxjQUFTLEtBQUssS0FBSyxlQUFlLEVBQUUsT0FBTyxhQUFhLENBQUMsQ0FBQztBQUFBLFlBQy9EO0FBQUEsVUFDRjtBQUFBLFVBVUEsUUFBUSxNQUFNO0FBQUEsVUFLZCxjQUFjO0FBQUEsVUFDZCxPQUFPLFFBQVEsT0FBTyxNQUFNLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUFBLFVBRW5ELFNBQVMsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sRUFBRyxPQUFPLEdBQUcsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sR0FBRztBQUFBLFlBQ3ZFLE1BQU0sUUFBUSxJQUFJLE1BQU0sR0FBRyxHQUFHO0FBQUEsWUFDOUIsTUFBTSxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQUEsWUFDdkIsUUFBUSxPQUFPLGFBQWEsY0FBYyxLQUFLO0FBQUEsWUFDL0MsV0FBVyxRQUFRO0FBQUEsY0FBVSxLQUFLLEtBQUssWUFBWSxJQUFJLENBQUM7QUFBQSxZQUN4RCxJQUFJLENBQUM7QUFBQSxjQUFPO0FBQUEsWUFFWixJQUFJO0FBQUEsWUFDSixJQUFJO0FBQUEsY0FDRixLQUFLLEtBQUssTUFBTSxNQUFNLElBQUk7QUFBQSxjQUMxQixPQUFPLEdBQUc7QUFBQSxjQUNWLEtBQUssS0FBSyxjQUFjLE9BQU8sQ0FBQyxDQUFDO0FBQUEsY0FDakM7QUFBQTtBQUFBLFlBT0YsTUFBTSxJQUFJLEtBQUssV0FBVyxFQUFFO0FBQUEsWUFFNUIsSUFBSSxhQUFhO0FBQUEsWUFDakIsSUFBSSxLQUFLLFNBQVM7QUFBQSxjQUNoQixNQUFNLE9BQU8sS0FBSyxRQUFRLEVBQUU7QUFBQSxjQUM1QixJQUFJLE9BQU8sU0FBUyxVQUFVO0FBQUEsZ0JBQzVCLElBQUksVUFBVSxRQUFRLFNBQVMsT0FBTztBQUFBLGtCQUNwQyxTQUFTO0FBQUEsa0JBQ1QsYUFBYTtBQUFBLGtCQUNiLE1BQU0sT0FBTyxLQUFLLGdCQUFnQixJQUFJLEtBQUs7QUFBQSxrQkFDM0MsSUFBSSxTQUFTO0FBQUEsb0JBQU0sS0FBSyxJQUFJO0FBQUEsa0JBRzVCLElBQUksYUFBYSxLQUFLLE9BQU8sTUFBTSxZQUFZLElBQUksWUFBWTtBQUFBLG9CQUM3RCxRQUFRO0FBQUEsb0JBQ1IsVUFBVTtBQUFBLG9CQUNWO0FBQUEsa0JBQ0Y7QUFBQSxnQkFDRjtBQUFBLGdCQUNBLFFBQVE7QUFBQSxjQUNWO0FBQUEsWUFDRjtBQUFBLFlBQ0EsSUFDRSxLQUFLLG9CQUFvQixRQUN6QixDQUFDLGNBQ0QsQ0FBQyxnQkFDRCxjQUFjLEtBQ2QsT0FBTyxNQUFNLFlBQ2IsS0FBSyxZQUNMO0FBQUEsY0FFQSxlQUFlO0FBQUEsY0FDZixTQUFTO0FBQUEsY0FDVCxNQUFNLE9BQU8sS0FBSyxnQkFBZ0IsS0FBSyxVQUFVLEVBQUUsS0FBSyxTQUFTLEtBQUs7QUFBQSxjQUN0RSxJQUFJLFNBQVM7QUFBQSxnQkFBTSxLQUFLLElBQUk7QUFBQSxZQUM5QjtBQUFBLFlBQ0EsSUFBSSxPQUFPLE1BQU0sWUFBWSxPQUFPLFNBQVMsQ0FBQyxHQUFHO0FBQUEsY0FDL0MsU0FBUyxpQkFBaUIsV0FBVyxJQUFJLEtBQUssSUFBSSxRQUFRLENBQUM7QUFBQSxZQUM3RDtBQUFBLFlBRUEsTUFBTSxXQUFXLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSztBQUFBLFlBQzdDLE1BQU0sYUFBYSxLQUFLLFdBQVcsSUFBSSxPQUFPLFFBQVEsS0FBSztBQUFBLFlBRTNELElBQUksWUFBYSxjQUFjLEtBQUssMEJBQTBCLE1BQU87QUFBQSxjQUNuRSxNQUFNLE9BQU8sS0FBSyxTQUFTLEtBQUssT0FBTyxJQUFJLEtBQUssSUFBSSxNQUFNO0FBQUEsY0FDMUQsSUFBSSxTQUFTO0FBQUEsZ0JBQU0sS0FBSyxJQUFJO0FBQUEsWUFDOUI7QUFBQSxZQUNBLElBQUksWUFBWTtBQUFBLGNBR2QsV0FBVyxNQUFNO0FBQUEsY0FDakIsU0FBUztBQUFBLGNBQ1QsT0FBTztBQUFBLFlBQ1Q7QUFBQSxVQUNGO0FBQUEsVUFDQSxJQUFJLFNBQVM7QUFBQSxZQUNYLFdBQVcsTUFBTTtBQUFBLFlBQ2pCO0FBQUEsVUFDRjtBQUFBLFFBQ0Y7QUFBQSxnQkFDQTtBQUFBLFFBQ0EsSUFBSSxhQUFhO0FBQUEsVUFBTSxhQUFhLFFBQVE7QUFBQSxRQUM1QyxVQUFVO0FBQUE7QUFBQSxNQUdaLElBQUk7QUFBQSxRQUFTO0FBQUEsTUFDYixJQUFJLFNBQVM7QUFBQSxRQUVYLFFBQVEsTUFBTTtBQUFBLFFBQ2Q7QUFBQSxNQUNGO0FBQUEsTUFRQSxNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxJQUN6QztBQUFBLElBQ0EsT0FBTztBQUFBLFlBQ1A7QUFBQSxJQUNBLElBQUksWUFBWTtBQUFBLE1BQ2QsUUFBUSxJQUFJLFVBQVUsUUFBUTtBQUFBLE1BQzlCLFFBQVEsSUFBSSxXQUFXLFFBQVE7QUFBQSxJQUNqQztBQUFBLElBQ0EsV0FBVyxNQUFNLFNBQVMsVUFBVTtBQUFBLElBQ3BDLEtBQUssUUFBUSxvQkFBb0IsU0FBUyxhQUFhO0FBQUEsSUFDdkQsS0FBSyxRQUFRLEVBQUUsUUFBUSxPQUFPLFFBQVEsT0FBTyxDQUFDO0FBQUE7QUFBQTs7O0FDcFozQyxJQUFNLGlCQUFpQjtBQUV2QixJQUFNLG1CQUFtQjtBQUN6QixJQUFNLG9CQUFvQixpQkFBaUI7QUFFM0MsSUFBTSxhQUFhO0FBR25CLElBQU0sY0FDWDtBQU1LLElBQU0sc0JBQXNCO0FBSTVCLFNBQVMsZUFBZSxDQUFDLEtBQWlDO0FBQUEsRUFDL0QsSUFBSSxRQUFRLGFBQWEsSUFBSSxLQUFLLE1BQU07QUFBQSxJQUFJLE9BQU87QUFBQSxFQUNuRCxNQUFNLElBQUksT0FBTyxHQUFHO0FBQUEsRUFDcEIsT0FBTyxPQUFPLFVBQVUsQ0FBQyxLQUFLLEtBQUssSUFBSSxJQUFJO0FBQUE7QUF3RHRDLElBQU0sb0JBQW9CO0FBSWpDLElBQU0sWUFBWSxDQUFDLEtBQWEsT0FBTyx1QkFDckMsR0FBRyxPQUFPLGFBQWE7QUFPbEIsU0FBUyxPQUFPLENBQUMsR0FBaUIsS0FBMEM7QUFBQSxFQUNqRixNQUFNLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxRQUFRLEVBQUUsUUFBUSxRQUFRLEVBQUUsT0FBTztBQUFBLEVBQ2xFLFFBQVEsRUFBRTtBQUFBLFNBQ0g7QUFBQSxNQUNILE9BQU87QUFBQSxTQUNKO0FBQUEsTUFDSCxPQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsV0FDSDtBQUFBLFdBQ0MsRUFBRSxLQUFLLEVBQUUsSUFBSSxFQUFFLEdBQUcsSUFBSSxDQUFDO0FBQUEsUUFDM0IsTUFBTTtBQUFBLFFBQ04sU0FBUyxJQUFJLFNBQVM7QUFBQSxRQUN0QixNQUNFLEVBQUUsT0FBTyxVQUNMLFVBQ0UsaUdBQ0EsYUFDRixJQUNBLFVBQVUscURBQXFEO0FBQUEsTUFDdkU7QUFBQSxTQUNHO0FBQUEsTUFDSCxPQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsV0FDSDtBQUFBLFFBQ0gsTUFBTTtBQUFBLFFBQ04sU0FBUyxJQUFJLFNBQVM7QUFBQSxRQUN0QixNQUFNLFVBQVUsbUVBQW1FO0FBQUEsTUFDckY7QUFBQSxTQUNHO0FBQUEsTUFDSCxPQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsV0FDSDtBQUFBLFFBQ0gsTUFBTTtBQUFBLFFBQ04sU0FBUyxJQUFJLEtBQUssRUFBRSxPQUFPLEVBQUUsUUFBUSxNQUFNLFVBQVcsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLE1BQU0sSUFBSSxDQUFDLEVBQUcsQ0FBQztBQUFBLFFBQzFGLE1BQU0seUVBQXlFO0FBQUEsTUFDakY7QUFBQSxTQUNHO0FBQUEsTUFDSCxJQUFJLEVBQUUsWUFBWSxFQUFFLFNBQVM7QUFBQSxRQUMzQixPQUFPO0FBQUEsVUFDTCxNQUFNO0FBQUEsYUFDSDtBQUFBLFVBQ0gsTUFBTTtBQUFBLFVBQ04sU0FBUyxJQUFJLEtBQUs7QUFBQSxZQUNoQixPQUFPLEVBQUU7QUFBQSxZQUNULE1BQU07QUFBQSxlQUNGLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLElBQUksQ0FBQztBQUFBLFVBQ3RDLENBQUM7QUFBQSxVQUNELE1BQU0sbUZBQW1GO0FBQUEsUUFDM0Y7QUFBQSxNQUNGLE9BQU87QUFBQSxRQUNMLE1BQU07QUFBQSxXQUNIO0FBQUEsUUFDSCxNQUFNO0FBQUEsUUFDTixTQUFTLElBQUksS0FBSyxFQUFFLE9BQU8sRUFBRSxRQUFRLE1BQU0sU0FBVSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxJQUFJLENBQUMsRUFBRyxDQUFDO0FBQUEsUUFDekYsTUFBTSx1Q0FBdUM7QUFBQSxNQUMvQztBQUFBO0FBQUE7QUFNQyxTQUFTLFVBQVUsQ0FBQyxLQUFxQjtBQUFBLEVBQzlDLE9BQU8sMkJBQTJCLEtBQUssR0FBRyxJQUFJLE1BQU0sSUFBSSxJQUFJLFdBQVcsS0FBSyxPQUFPO0FBQUE7QUFROUUsU0FBUyxhQUFhLENBQUMsT0FBeUQ7QUFBQSxFQUNyRixNQUFNLEtBQUssTUFBTSxRQUFRLEdBQUc7QUFBQSxFQUM1QixNQUFNLEtBQUssT0FBTyxLQUFLLFFBQVEsTUFBTSxNQUFNLEdBQUcsRUFBRTtBQUFBLEVBQ2hELE1BQU0sUUFBUSxPQUFPLEtBQUssS0FBSyxNQUFNLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDakQsSUFBSSxDQUFDLFVBQVUsS0FBSyxHQUFHLEtBQUssQ0FBQztBQUFBLElBQUcsT0FBTztBQUFBLEVBQ3ZDLElBQUksT0FBTyxNQUFNLFVBQVU7QUFBQSxJQUFJLE9BQU87QUFBQSxFQUN0QyxPQUFPLEVBQUUsT0FBTyxPQUFPLFNBQVMsSUFBSSxFQUFFLE1BQU8sUUFBUSxFQUFFLE1BQU0sSUFBSSxDQUFDLEVBQUc7QUFBQTtBQWdCaEUsU0FBUyxTQUFTLENBQ3ZCLE9BQ0EsR0FDOEU7QUFBQSxFQUM5RSxNQUFNLE1BQU0sRUFBRSxPQUFPO0FBQUEsRUFDckIsTUFBTSxJQUFJLGNBQWMsS0FBSztBQUFBLEVBQzdCLElBQUksTUFBTSxRQUFRLEVBQUUsU0FBUyxRQUFRLEVBQUUsVUFBVSxhQUFhLEVBQUU7QUFBQSxJQUM5RCxPQUFPLEVBQUUsSUFBSSxNQUFNLE9BQU8sRUFBRSxVQUFXLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLElBQUksQ0FBQyxFQUFHO0FBQUEsRUFDNUUsTUFBTSxLQUNKLE1BQU0sSUFDRix3REFDQSw0QkFBNEI7QUFBQSxFQUNsQyxNQUFNLFFBQVEsRUFBRSxRQUFRLEdBQUcsb0RBQW9EO0FBQUEsRUFDL0UsTUFBTSxNQUNKLENBQUMsRUFBRSxTQUFTLE1BQU0sU0FBUyxHQUFHLElBQzFCLGtGQUNBO0FBQUEsRUFDTixPQUFPO0FBQUEsSUFDTCxJQUFJO0FBQUEsSUFDSixTQUFTLGFBQWEsMERBQXFELFFBQVE7QUFBQSxFQUNyRjtBQUFBO0FBSUssU0FBUyxXQUFXLENBQUMsTUFBaUM7QUFBQSxFQUMzRCxPQUFPLEtBQUssSUFBSSxVQUFVLEVBQUUsS0FBSyxHQUFHO0FBQUE7QUE0Q3RDLGVBQXNCLGVBQW1CLENBQ3ZDLE1BQ0EsR0FDaUI7QUFBQSxFQUNqQixNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLFdBQVcsRUFBRSxZQUFZLGdCQUFnQixRQUFRLElBQUksV0FBVztBQUFBLEVBQ3RFLE1BQU0sU0FBUyxFQUFFLFdBQVcsTUFBTTtBQUFBLEVBQ2xDLE1BQU0sWUFBWSxDQUFDLEVBQUU7QUFBQSxFQUVyQixNQUFNLEtBQUssSUFBSTtBQUFBLEVBQ2YsTUFBTSxnQkFBZ0IsTUFBTSxHQUFHLE1BQU07QUFBQSxFQUNyQyxLQUFLLFFBQVEsaUJBQWlCLFNBQVMsYUFBYTtBQUFBLEVBQ3BELElBQUksS0FBSyxRQUFRO0FBQUEsSUFBUyxHQUFHLE1BQU07QUFBQSxFQUVuQyxJQUFJLFNBQVM7QUFBQSxFQUNiLElBQUksU0FBUyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxRQUE0QixLQUFLO0FBQUEsRUFDckMsSUFBSSxhQUFhO0FBQUEsRUFJakIsTUFBTSxhQUFhLENBQUMsSUFBUSxVQUFvQixjQUFjLE9BQU8sSUFBSSxLQUFLO0FBQUEsRUFDOUUsSUFBSSxNQUFzQjtBQUFBLEVBQzFCLElBQUk7QUFBQSxFQUNKLElBQUksV0FBVztBQUFBLEVBRWYsTUFBTSxTQUFTLENBQUMsTUFBZTtBQUFBLElBQzdCLElBQUksUUFBUTtBQUFBLE1BQU0sTUFBTTtBQUFBLElBQ3hCLEdBQUcsTUFBTTtBQUFBO0FBQUEsRUFFWCxNQUFNLFFBQ0osRUFBRSxTQUFTLFdBQVcsV0FBVyxJQUFJLFdBQVcsTUFBTSxPQUFPLFFBQVEsR0FBRyxRQUFRLElBQUk7QUFBQSxFQUV0RixJQUFJO0FBQUEsSUFDRixNQUFNLE9BQU8sTUFBTSxXQUFlO0FBQUEsU0FDN0I7QUFBQSxNQUNILFFBQVEsR0FBRztBQUFBLE1BS1gsaUJBQWlCO0FBQUEsTUFHakIsVUFBVSxDQUFDLE9BQU87QUFBQSxRQUNoQixNQUFNLElBQUksS0FBSyxXQUFXLEVBQUU7QUFBQSxRQUM1QixhQUFhLE9BQU8sTUFBTSxZQUFZLE9BQU8sU0FBUyxDQUFDO0FBQUEsUUFDdkQsT0FBTztBQUFBO0FBQUEsTUFFVCxjQUFjLENBQUMsTUFBTTtBQUFBLFFBQ25CLE1BQU0sVUFBVSxLQUFLLGVBQWUsQ0FBQyxLQUFLO0FBQUEsUUFJMUMsSUFBSSxZQUFZLFVBQVUsUUFBUSxNQUFNO0FBQUEsVUFDdEMsTUFBTTtBQUFBLFVBQ04sV0FBVyxFQUFFLFNBQVM7QUFBQSxRQUN4QjtBQUFBLFFBQ0EsT0FBTztBQUFBO0FBQUEsTUFFVCxRQUFRLENBQUMsSUFBSSxVQUFVO0FBQUEsUUFDckIsV0FBVztBQUFBLFFBQ1gsTUFBTSxRQUFPLEtBQUssU0FBUyxLQUFLLE9BQU8sSUFBSSxLQUFLLElBQUksTUFBTTtBQUFBLFFBQzFELElBQUksVUFBUyxRQUFRLFdBQVcsSUFBSSxLQUFLO0FBQUEsVUFBRyxVQUFVO0FBQUEsUUFDdEQsT0FBTztBQUFBO0FBQUEsTUFFVCxVQUFVLENBQUMsSUFBSSxPQUFPLGFBQWE7QUFBQSxRQUNqQyxJQUFJLEtBQUssV0FBVyxJQUFJLE9BQU8sUUFBUSxHQUFHO0FBQUEsVUFDeEMsSUFBSSxRQUFRLE1BQU07QUFBQSxZQUNoQixPQUFPLEVBQUUsYUFBYSxNQUFNLE9BQU8sRUFBRSxJQUFJLFdBQVc7QUFBQSxZQUNwRCxJQUFJLFFBQVE7QUFBQSxjQUFVLFdBQVcsRUFBRSxXQUFXLEVBQUU7QUFBQSxVQUNsRDtBQUFBLFVBQ0EsT0FBTztBQUFBLFFBQ1Q7QUFBQSxRQUNBLElBQUksRUFBRSxTQUFTLFVBQVUsWUFBWSxXQUFXLElBQUksS0FBSyxHQUFHO0FBQUEsVUFDMUQsSUFBSSxRQUFRO0FBQUEsWUFBTSxNQUFNO0FBQUEsVUFDeEIsT0FBTztBQUFBLFFBQ1Q7QUFBQSxRQUNBLE9BQU87QUFBQTtBQUFBLE1BRVQsV0FBVyxDQUFDLFNBQVM7QUFBQSxRQUNuQixXQUFXO0FBQUEsUUFDWCxPQUFPLEtBQUssWUFBWSxJQUFJLEtBQUs7QUFBQTtBQUFBLE1BRW5DLGNBQWMsQ0FBQyxTQUFTO0FBQUEsUUFDdEIsTUFBTSxRQUFPLEtBQUssZUFBZSxJQUFJLEtBQUs7QUFBQSxRQUMxQyxJQUFJLEtBQUssVUFBVSxrQkFBa0I7QUFBQSxVQUNuQyxZQUFZO0FBQUEsVUFDWixJQUFJLGFBQWEsWUFBWTtBQUFBLFlBQXFCLE9BQU8sTUFBTTtBQUFBLFFBQ2pFLEVBQU87QUFBQSxVQUdMLFdBQVc7QUFBQTtBQUFBLFFBRWIsT0FBTztBQUFBO0FBQUEsTUFFVCxPQUFPLENBQUMsTUFBTTtBQUFBLFFBQ1osU0FBUyxFQUFFO0FBQUEsUUFDWCxRQUFRLEVBQUUsU0FBUztBQUFBLFFBQ25CLEtBQUssUUFBUSxDQUFDO0FBQUE7QUFBQSxJQUVsQixDQUFDO0FBQUEsSUFDRCxNQUFNLE9BQU8sUUFDWDtBQUFBLE1BQ0UsS0FBSyxPQUFPO0FBQUEsU0FDUixXQUFXLEVBQUUsSUFBSSxTQUFTLElBQUksQ0FBQztBQUFBLE1BQ25DLE1BQU0sRUFBRTtBQUFBLE1BQ1I7QUFBQSxNQUNBO0FBQUEsU0FDSSxRQUFRLEVBQUUsTUFBTSxJQUFJLENBQUM7QUFBQSxNQUN6QixVQUFVLEVBQUU7QUFBQSxNQUNaLE9BQU8sRUFBRTtBQUFBLElBQ1gsR0FDQSxFQUFFLFFBQ0o7QUFBQSxJQUNBLElBQUksU0FBUztBQUFBLE1BQU0sSUFBSSxNQUFNLEdBQUcsS0FBSyxVQUFVLElBQUk7QUFBQSxDQUFLO0FBQUEsSUFDeEQsT0FBTztBQUFBLFlBQ1A7QUFBQSxJQUNBLElBQUksVUFBVTtBQUFBLE1BQU0sYUFBYSxLQUFLO0FBQUEsSUFDdEMsS0FBSyxRQUFRLG9CQUFvQixTQUFTLGFBQWE7QUFBQTtBQUFBOzs7QUNqbkJwRCxJQUFNLHVCQUF1QjtBQUc3QixJQUFNLHVCQUF1QjtBQU83QixJQUFNLGVBQWU7QUF3QnJCLElBQU0sbUJBQW1CO0FBTWhDLFNBQVMsS0FBSyxDQUFDLEtBQXlCLFVBQTBCO0FBQUEsRUFDaEUsTUFBTSxJQUFJLE9BQU8sU0FBUyxPQUFPLElBQUksRUFBRTtBQUFBLEVBQ3ZDLE9BQU8sT0FBTyxTQUFTLENBQUMsS0FBSyxJQUFJLElBQUksSUFBSTtBQUFBO0FBSXBDLFNBQVMsY0FBYyxDQUFDLEtBQTBCLFdBQVcsc0JBQThCO0FBQUEsRUFDaEcsT0FBTyxLQUFLLElBQUksR0FBRyxLQUFLLElBQUksc0JBQXNCLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQztBQUFBO0FBaUJsRSxTQUFTLFdBQVcsQ0FDekIsS0FDQSxTQUNBLFdBQVcsc0JBQ0g7QUFBQSxFQUNSLE1BQU0sVUFBVSxLQUFLLElBQUksa0JBQWtCLEtBQUssTUFBTyxVQUFVLE9BQVEsQ0FBQyxDQUFDO0FBQUEsRUFDM0UsT0FBTyxLQUFLLElBQUksS0FBSyxJQUFJLE1BQU0sS0FBSyxRQUFRLEdBQUcsZ0JBQWdCLEdBQUcsT0FBTztBQUFBO0FBSXBFLFNBQVMsVUFBVSxDQUFDLFFBQXdCO0FBQUEsRUFDakQsT0FBTyxTQUFTO0FBQUE7OztBQzFDWCxJQUFNLG1CQUFtQixlQUM5QixRQUFRLElBQUksNEJBQ1osb0JBQ0Y7QUFlTyxJQUFNLDJCQUEyQjtBQWVqQyxJQUFNLG1CQUFtQixZQUM5QixRQUFRLElBQUksd0JBQ1osa0JBQ0Esd0JBQ0Y7QUFvQk8sSUFBTSxlQUFlLFdBQVcsZ0JBQWdCOzs7QVBuRnZELElBQU0sV0FBVyxRQUFRLElBQUksa0JBQWtCLEtBQUssUUFBUSxHQUFHLFlBQVk7QUFDM0UsSUFBTSxZQUFZLEtBQUssVUFBVSxhQUFhO0FBQzlDLElBQU0sV0FBVyxLQUFLLFVBQVUsWUFBWTtBQUM1QyxJQUFNLFlBQVksS0FBSyxVQUFVLGFBQWE7QUFHOUMsSUFBTSxjQUFjLEtBQUssVUFBVSxhQUFhO0FBQ2hELElBQU0sYUFBYSxRQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFjekQsSUFBTSxnQkFBZ0IsS0FBSyxZQUFZLE1BQU0sV0FBVyxXQUFXO0FBQ25FLElBQU0sYUFBYSxLQUFLLFlBQVksSUFBSTtBQUN4QyxJQUFNLFdBQVcsS0FBSyxZQUFZLE1BQU07QUFTeEMsSUFBTSxjQUFjLEtBQUssWUFBWSxNQUFNLE1BQU0sTUFBTSxNQUFNLE1BQU0sT0FBTyxXQUFXO0FBRTlFLFNBQVMsU0FBUyxHQUFXO0FBQUEsRUFDbEMsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBVyxPQUFPO0FBQUEsRUFDN0QsSUFBSSxRQUFRLElBQUksMkJBQTJCO0FBQUEsSUFBTyxPQUFPO0FBQUEsRUFDekQsT0FBTyxXQUFXLEtBQUssVUFBVSxZQUFZLENBQUMsSUFBSSxhQUFhO0FBQUE7QUE0SmpFLFNBQVMsaUJBQWlCLEdBQWtCO0FBQUEsRUFDMUMsSUFBSTtBQUFBLElBQ0YsTUFBTSxpQkFBaUIsS0FBSyxZQUFZLE1BQU0sTUFBTSxNQUFNLGtCQUFrQixhQUFhO0FBQUEsSUFDekYsTUFBTSxNQUFNLGFBQWEsZ0JBQWdCLE9BQU87QUFBQSxJQUNoRCxPQUFPLEtBQUssTUFBTSxHQUFHLEVBQUUsV0FBVztBQUFBLElBQ2xDLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBO0FBR1gsSUFBTSxpQkFBaUIsa0JBQWtCO0FBTXpDLElBQUksb0JBQW9CO0FBQ3hCLGVBQWUsMEJBQTBCLENBQUMsTUFBYztBQUFBLEVBQ3RELElBQUk7QUFBQSxJQUFtQjtBQUFBLEVBQ3ZCLG9CQUFvQjtBQUFBLEVBQ3BCLElBQUksQ0FBQztBQUFBLElBQWdCO0FBQUEsRUFDckIsSUFBSTtBQUFBLElBQ0YsTUFBTSxNQUFNLE1BQU0sTUFBTSxvQkFBb0IsU0FBUztBQUFBLE1BQ25ELFFBQVEsWUFBWSxRQUFRLEdBQUc7QUFBQSxJQUNqQyxDQUFDO0FBQUEsSUFDRCxJQUFJLENBQUMsSUFBSTtBQUFBLE1BQUk7QUFBQSxJQUNiLE1BQU0sT0FBUSxNQUFNLElBQUksS0FBSztBQUFBLElBQzdCLE1BQU0sZ0JBQWdCLE1BQU0sV0FBVztBQUFBLElBQ3ZDLElBQUksa0JBQWtCLE1BQU07QUFBQSxNQUMxQixRQUFRLE9BQU8sTUFDYix1RUFDRSxXQUFXLHlEQUNYO0FBQUEsQ0FDSjtBQUFBLElBQ0YsRUFBTyxTQUFJLGtCQUFrQixnQkFBZ0I7QUFBQSxNQUMzQyxRQUFRLE9BQU8sTUFDYixpQ0FBaUMsNkNBQTZDLHNCQUM1RTtBQUFBLENBQ0o7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNO0FBQUE7QUFNVixJQUFNLGdCQUFnQixRQUFRLElBQUksa0JBQWtCO0FBT3BELFNBQVMsWUFBWSxDQUFDLE9BQTZEO0FBQUEsRUFDakYsT0FBUSxNQUFNLFFBQWdDLE1BQU0sTUFBNkI7QUFBQTtBQVNuRixJQUFNLDRCQUE0QixTQUNoQyxRQUFRLElBQUksdUNBQXVDLFFBQ25ELEVBQ0Y7QUFVQSxTQUFTLGNBQWMsQ0FBQyxNQUFtQztBQUFBLEVBQ3pELE1BQU0sTUFBTSxPQUFPLFNBQVMsV0FBVyxPQUFPLFFBQVEsSUFBSTtBQUFBLEVBQzFELElBQUksUUFBUTtBQUFBLElBQVc7QUFBQSxFQUN2QixNQUFNLElBQUksT0FBTyxTQUFTLEtBQUssRUFBRTtBQUFBLEVBQ2pDLE9BQU8sT0FBTyxTQUFTLENBQUMsS0FBSyxLQUFLLElBQUksSUFBSTtBQUFBO0FBOEI1QyxTQUFTLElBQUcsQ0FBQyxLQUFhLE9BQWdCLFNBQVMsT0FBeUI7QUFBQSxFQUMxRSxJQUFNLEtBQUssTUFBTSxLQUFLO0FBQUE7QUFheEIsU0FBUyxhQUFhLENBQUMsUUFBeUI7QUFBQSxFQUM5QyxJQUFJLFdBQVc7QUFBQSxJQUFLLE9BQU87QUFBQSxFQUMzQixJQUFJLFdBQVc7QUFBQSxJQUFLLE9BQU87QUFBQSxFQUMzQixJQUFJLFVBQVUsT0FBTyxTQUFTO0FBQUEsSUFBSyxPQUFPO0FBQUEsRUFDMUMsT0FBTztBQUFBO0FBR1QsZUFBZSxjQUFjLEdBQTJCO0FBQUEsRUFDdEQsSUFBSSxDQUFDLFdBQVcsU0FBUztBQUFBLElBQUcsT0FBTztBQUFBLEVBQ25DLE1BQU0sTUFBTSxhQUFhLFdBQVcsT0FBTyxFQUFFLEtBQUs7QUFBQSxFQUNsRCxNQUFNLE9BQU8sU0FBUyxLQUFLLEVBQUU7QUFBQSxFQUM3QixJQUFJLENBQUM7QUFBQSxJQUFNLE9BQU87QUFBQSxFQUNsQixJQUFJO0FBQUEsSUFDRixNQUFNLE1BQU0sTUFBTSxNQUFNLG9CQUFvQixTQUFTO0FBQUEsTUFDbkQsUUFBUSxZQUFZLFFBQVEsR0FBRztBQUFBLElBQ2pDLENBQUM7QUFBQSxJQUNELElBQUksSUFBSSxJQUFJO0FBQUEsTUFFViwyQkFBMkIsSUFBSTtBQUFBLE1BQy9CLE9BQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxNQUFNO0FBQUEsRUFFUixJQUFJO0FBQUEsSUFDRixXQUFXLFNBQVM7QUFBQSxJQUNwQixNQUFNO0FBQUEsRUFDUixJQUFJO0FBQUEsSUFDRixXQUFXLFFBQVE7QUFBQSxJQUNuQixNQUFNO0FBQUEsRUFDUixPQUFPO0FBQUE7QUFXVCxlQUFlLGVBQWUsQ0FBQyxNQUFrRDtBQUFBLEVBQy9FLE1BQU0sV0FBVyxLQUFLLElBQUksSUFBSTtBQUFBLEVBQzlCLE9BQU8sS0FBSyxJQUFJLElBQUksVUFBVTtBQUFBLElBQzVCLE1BQU0sSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDO0FBQUEsSUFDMUMsSUFBSyxNQUFNLGVBQWUsTUFBTztBQUFBLE1BQU07QUFBQSxFQUN6QztBQUFBLEVBQ0EsSUFBSSxNQUFxQjtBQUFBLEVBQ3pCLElBQUk7QUFBQSxJQUNGLE1BQU0sT0FBTyxTQUFTLGFBQWEsVUFBVSxPQUFPLEVBQUUsS0FBSyxHQUFHLEVBQUUsS0FBSztBQUFBLElBQ3JFLE1BQU07QUFBQSxFQUNSLE1BQU0sU0FBUyxpQkFBaUI7QUFBQSxFQUNoQyxLQUNFLEdBQUcsbUJBQW1CLE1BQU0sU0FBUyxTQUFTLHNEQUM1QyxNQUFNLFNBQVMsU0FBUyx1QkFBdUIsa0NBQy9DLHFCQUFxQixNQUFNLFVBQVUsU0FBUyxnQkFBZ0IsZUFDaEUsWUFDQTtBQUFBLElBQ0UsT0FBTztBQUFBLElBQ1AsTUFBTSxTQUFTLFFBQVEsa0JBQWtCO0FBQUEsRUFDM0MsQ0FDRjtBQUFBO0FBR0YsU0FBUyxVQUFVLEdBQWtCO0FBQUEsRUFDbkMsSUFBSTtBQUFBLElBQ0YsSUFBSSxDQUFDLFdBQVcsU0FBUztBQUFBLE1BQUcsT0FBTztBQUFBLElBQ25DLE1BQU0sUUFBUSxTQUFTLGFBQWEsV0FBVyxPQUFPLEVBQUUsS0FBSyxHQUFHLEVBQUU7QUFBQSxJQUNsRSxJQUFJLE9BQU8sU0FBUyxLQUFLLEtBQUssUUFBUSxLQUFLLElBQUk7QUFBQSxNQUFHLE9BQU87QUFBQSxJQUN6RCxJQUFJO0FBQUEsTUFDRixXQUFXLFNBQVM7QUFBQSxNQUNwQixNQUFNO0FBQUEsSUFDUixPQUFPO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUE7QUFBQTtBQUdKLFNBQVMsV0FBVyxHQUFHO0FBQUEsRUFDNUIsSUFBSTtBQUFBLElBQ0YsSUFBSSxXQUFXLFNBQVM7QUFBQSxNQUFHLFdBQVcsU0FBUztBQUFBLElBQy9DLE1BQU07QUFBQTtBQUdWLGVBQWUsWUFBWSxHQUFvQjtBQUFBLEVBQzdDLElBQUksT0FBTyxNQUFNLGVBQWU7QUFBQSxFQUNoQyxJQUFJO0FBQUEsSUFBTSxPQUFPO0FBQUEsRUFDakIsSUFBSSxXQUFXO0FBQUEsSUFDYixLQUNFLGlHQUNBLFVBQ0Y7QUFBQSxFQUtGLE1BQU0sTUFBTSxVQUFVO0FBQUEsRUFDdEIsSUFBSSxDQUFDLFdBQVcsR0FBRyxHQUFHO0FBQUEsSUFDcEIsS0FDRSx1RkFBa0YsVUFDaEYsd0ZBQ0EsMkZBQ0EsNEZBQ0Esc0NBQ0YsVUFDRjtBQUFBLEVBQ0Y7QUFBQSxFQUVBLE1BQU0sT0FBTyxNQUFNLFFBQVEsVUFBVSxDQUFDLGFBQWEsR0FBRztBQUFBLElBQ3BELFVBQVU7QUFBQSxJQUNWLE9BQU8sQ0FBQyxVQUFVLFVBQVUsUUFBUTtBQUFBLElBQ3BDLEtBQUssUUFBUTtBQUFBLElBQ2I7QUFBQSxFQUNGLENBQUM7QUFBQSxFQUNELEtBQUssTUFBTTtBQUFBLEVBRVgsTUFBTSxXQUFXLEtBQUssSUFBSSxJQUFJO0FBQUEsRUFDOUIsT0FBTyxLQUFLLElBQUksSUFBSSxVQUFVO0FBQUEsSUFDNUIsTUFBTSxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUM7QUFBQSxJQUMxQyxPQUFPLE1BQU0sZUFBZTtBQUFBLElBQzVCLElBQUk7QUFBQSxNQUFNLE9BQU87QUFBQSxFQUNuQjtBQUFBLEVBQ0EsS0FBSSxvQ0FBb0MsWUFBWTtBQUFBLElBQ2xELE1BQ0UsbUZBQ0EsNEVBQ0Esc0ZBQ0EseUVBQ0E7QUFBQSxFQUNKLENBQUM7QUFBQTtBQUtILGVBQWUsR0FBZ0IsQ0FDN0IsTUFDQSxRQUNBLE1BQ0EsTUFDNkM7QUFBQSxFQUM3QyxNQUFNLE1BQU0sTUFBTSxNQUFNLG9CQUFvQixPQUFPLFFBQVE7QUFBQSxJQUN6RDtBQUFBLElBQ0EsU0FBUyxTQUFTLFlBQVksRUFBRSxnQkFBZ0IsbUJBQW1CLElBQUk7QUFBQSxJQUN2RSxNQUFNLFNBQVMsWUFBWSxLQUFLLFVBQVUsSUFBSSxJQUFJO0FBQUEsRUFDcEQsQ0FBQztBQUFBLEVBQ0QsSUFBSSxPQUFpQjtBQUFBLEVBQ3JCLElBQUk7QUFBQSxJQUNGLE9BQVEsTUFBTSxJQUFJLEtBQUs7QUFBQSxJQUN2QixNQUFNO0FBQUEsRUFDUixPQUFPLEVBQUUsUUFBUSxJQUFJLFFBQVEsS0FBSztBQUFBO0FBR3BDLFNBQVMsVUFBUyxDQUFDLE1BQWU7QUFBQSxFQUNoQyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBO0FBUWxELFNBQVMsZ0JBQWdCLEdBQVc7QUFBQSxFQUNsQyxNQUFNLFFBQVEsUUFBUSxLQUFLO0FBQUEsRUFDM0IsT0FBTyxRQUFRLE9BQU8sVUFBVTtBQUFBO0FBWWxDLFNBQVMsTUFBTSxDQUFDLE1BQWdELFFBQXVCO0FBQUEsRUFDckYsTUFBTSxNQUFNLE1BQU0sU0FBUyxRQUFRO0FBQUEsRUFDbkMsTUFBTSxTQUFTLGlCQUFpQjtBQUFBLEVBTWhDLE1BQU0sT0FBTyxNQUFNLE9BQ2YsU0FDRSxRQUFRLFVBQVUsS0FBSyxTQUN2QixhQUFhLEtBQUssZ0JBQ3BCO0FBQUEsRUFDSixLQUFJLEtBQUssY0FBYyxNQUFNLEdBQUc7QUFBQSxPQUMxQixPQUFPLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFBQSxPQUduQixTQUFTLE9BQU8sRUFBRSxRQUFRLEtBQUssSUFBSSxDQUFDO0FBQUEsRUFDMUMsQ0FBQztBQUFBO0FBT0gsZUFBZSxjQUFjLENBQUMsTUFBYyxNQUE2QjtBQUFBLEVBQ3ZFLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFDN0IsTUFDQSxPQUNBLGFBQWEsWUFDZjtBQUFBLEVBQ0EsSUFBSSxVQUFVO0FBQUEsSUFBSyxPQUFPLE1BQU0sTUFBTTtBQUFBO0FBR3hDLGVBQWUsT0FBTyxDQUNwQixNQUNBLE1BQ0E7QUFBQSxFQUNBLElBQUksQ0FBQztBQUFBLElBQU0sS0FBSSx5REFBeUQ7QUFBQSxFQUN4RSxNQUFNLE9BQU8sTUFBTSxhQUFhO0FBQUEsRUFDaEMsTUFBTSxPQUF5QyxFQUFFLE1BQU0sVUFBVSxLQUFLO0FBQUEsRUFDdEUsSUFBSSxLQUFLLFVBQVU7QUFBQSxJQUFXLEtBQUssUUFBUSxLQUFLO0FBQUEsRUFDaEQsSUFBSSxLQUFLLFNBQVM7QUFBQSxJQUFXLEtBQUssT0FBTyxLQUFLO0FBQUEsRUFDOUMsSUFBSSxLQUFLO0FBQUEsSUFBTyxLQUFLLFFBQVE7QUFBQSxFQUM3QixRQUFRLFFBQVEsU0FBUyxNQUFNLElBQWtCLE1BQU0sUUFBUSxhQUFhLElBQUk7QUFBQSxFQUNoRixJQUFJLFVBQVU7QUFBQSxJQUFLLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFDdEMsV0FBVSxFQUFFLElBQUksTUFBTSxTQUFTLEtBQUssQ0FBQztBQUFBO0FBR3ZDLGVBQWUsUUFBUSxDQUNyQixNQUNBLE1BQ0EsTUFDQTtBQUFBLEVBQ0EsSUFBSSxDQUFDO0FBQUEsSUFBTSxLQUFJLDJDQUEyQztBQUFBLEVBQzFELE1BQU0sT0FBTyxNQUFNLGFBQWE7QUFBQSxFQUNoQyxJQUFJLFNBQVMsV0FBVztBQUFBLElBSXRCLFFBQVEsaUJBQVEsZ0JBQVMsTUFBTSxJQUFtQixNQUFNLE9BQU8sYUFBYSxZQUFZO0FBQUEsSUFDeEYsSUFBSSxXQUFVO0FBQUEsTUFBSyxPQUFPLE9BQU0sT0FBTTtBQUFBLElBQ3RDLFdBQVUsRUFBRSxJQUFJLE1BQU0sU0FBUyxNQUFNLE9BQU8sT0FBTSxNQUFNLENBQUM7QUFBQSxJQUN6RDtBQUFBLEVBQ0Y7QUFBQSxFQU1BLE1BQU0sU0FBUyxNQUFNLElBQXVDLE1BQU0sUUFBUSxhQUFhLEVBQUUsS0FBSyxDQUFDO0FBQUEsRUFDL0YsSUFBSSxPQUFPLFVBQVU7QUFBQSxJQUFLLE9BQU8sT0FBTyxNQUFNLE9BQU8sTUFBTTtBQUFBLEVBQzNELFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBbUIsTUFBTSxPQUFPLGFBQWEsY0FBYztBQUFBLElBQ3hGLE9BQU87QUFBQSxJQUNQLE1BQU0sUUFBUTtBQUFBLEVBQ2hCLENBQUM7QUFBQSxFQUNELElBQUksVUFBVTtBQUFBLElBQUssT0FBTyxNQUFNLE1BQU07QUFBQSxFQUN0QyxXQUFVLEVBQUUsSUFBSSxNQUFNLFNBQVMsTUFBTSxPQUFPLE1BQU0sT0FBTyxJQUFJLE1BQU0sR0FBRyxDQUFDO0FBQUE7QUFHekUsZUFBZSxPQUFPLEdBQUc7QUFBQSxFQUN2QixNQUFNLE9BQU8sTUFBTSxlQUFlO0FBQUEsRUFDbEMsSUFBSSxDQUFDLE1BQU07QUFBQSxJQUNULFdBQVUsRUFBRSxJQUFJLE1BQU0sUUFBUSxPQUFPLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUNuRDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVEsU0FBUyxNQUFNLElBQXNCLE1BQU0sT0FBTyxXQUFXO0FBQUEsRUFDckUsV0FBVSxFQUFFLElBQUksTUFBTSxRQUFRLFNBQVMsS0FBSyxDQUFDO0FBQUE7QUFHL0MsZUFBZSxPQUFPLENBQ3BCLE1BQ0EsTUFDQSxNQUNBLE1BQ0E7QUFBQSxFQUNBLElBQUksQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDO0FBQUEsSUFBTSxLQUFJLHVEQUF1RDtBQUFBLEVBQ3hGLE1BQU0sT0FBTyxNQUFNLGFBQWE7QUFBQSxFQUNoQyxNQUFNLE9BQTZEO0FBQUEsSUFDakU7QUFBQSxJQUNBO0FBQUEsRUFDRjtBQUFBLEVBQ0EsSUFBSSxLQUFLLGNBQWM7QUFBQSxJQUFXLEtBQUssY0FBYyxLQUFLO0FBQUEsRUFDMUQsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFpQixNQUFNLFFBQVEsYUFBYSxpQkFBaUIsSUFBSTtBQUFBLEVBQ2hHLElBQUksVUFBVSxPQUFPLENBQUM7QUFBQSxJQUFNLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFLL0MsTUFBTSxRQUNKLEtBQUssZUFBZSxZQUNoQixHQUFHLEtBQUssNEJBQ1IsR0FBRyxLQUFLLGVBQWU7QUFBQSxFQUM3QixRQUFRLE9BQU8sTUFBTSxZQUFPLEtBQUssZ0JBQWE7QUFBQSxDQUFTO0FBQUEsRUFDdkQsSUFBSSxLQUFLO0FBQUEsSUFBTztBQUFBLEVBSWhCLE1BQU0sTUFBK0I7QUFBQSxJQUNuQyxJQUFJO0FBQUEsSUFDSixJQUFJLEtBQUs7QUFBQSxJQUNULFNBQVMsS0FBSztBQUFBLElBQ2QsYUFBYSxLQUFLLGVBQWU7QUFBQSxFQUNuQztBQUFBLEVBS0EsSUFBSSxLQUFLLGVBQWU7QUFBQSxJQUFXLElBQUksYUFBYSxLQUFLO0FBQUEsRUFDekQsSUFBSSxLQUFLLGdCQUFnQjtBQUFBLElBQUcsSUFBSSxVQUFVO0FBQUEsRUFDckMsU0FBSSxLQUFLLGVBQWU7QUFBQSxJQUFHLElBQUksVUFBVTtBQUFBLEVBQzlDLElBQUksS0FBSztBQUFBLElBQVMsSUFBSSxxQkFBcUIsS0FBSyxzQkFBc0IsQ0FBQztBQUFBLEVBQ3ZFLFdBQVUsR0FBRztBQUFBO0FBR2YsZUFBZSxXQUFXLENBQ3hCLE1BQ0EsTUFDQSxVQUNBLE1BQ0E7QUFBQSxFQUNBLElBQUksQ0FBQyxRQUFRLENBQUM7QUFBQSxJQUFNLEtBQUksb0RBQW9EO0FBQUEsRUFDNUUsTUFBTSxPQUFPLE1BQU0sYUFBYTtBQUFBLEVBQ2hDLE1BQU0sT0FBNEQsRUFBRSxNQUFNLEtBQUs7QUFBQSxFQUMvRSxJQUFJLFVBQVU7QUFBQSxJQUFRLEtBQUssV0FBVztBQUFBLEVBQ3RDLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBcUIsTUFBTSxRQUFRLGFBQWEsSUFBSTtBQUFBLEVBQ25GLElBQUksVUFBVSxPQUFPLENBQUM7QUFBQSxJQUFNLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFDL0MsUUFBUSxPQUFPLE1BQ2Isc0JBQWlCLEtBQUssU0FBUywwQkFBdUIsS0FBSztBQUFBLENBQzdEO0FBQUEsRUFDQSxJQUFJLEtBQUs7QUFBQSxJQUFPO0FBQUEsRUFDaEIsTUFBTSxNQUErQjtBQUFBLElBQ25DLElBQUk7QUFBQSxJQUNKLFVBQVUsS0FBSztBQUFBLElBQ2Ysa0JBQWtCLEtBQUs7QUFBQSxFQUN6QjtBQUFBLEVBQ0EsSUFBSSxLQUFLLFNBQVM7QUFBQSxJQUFRLElBQUksVUFBVSxLQUFLO0FBQUEsRUFDN0MsSUFBSSxLQUFLLFNBQVMsV0FBVztBQUFBLElBQUcsSUFBSSxVQUFVO0FBQUEsRUFDOUMsV0FBVSxHQUFHO0FBQUE7QUFHZixlQUFlLE9BQU8sQ0FBQyxNQUEwQixPQUFlLE9BQTRCLENBQUMsR0FBRztBQUFBLEVBQzlGLElBQUksQ0FBQztBQUFBLElBQU0sS0FBSSxtRUFBbUU7QUFBQSxFQUNsRixNQUFNLE9BQU8sTUFBTSxhQUFhO0FBQUEsRUFFaEMsSUFBSSxLQUFLLFdBQVcsV0FBVztBQUFBLElBRTdCLE1BQU0sZUFBZSxNQUFNLElBQUk7QUFBQSxJQUUvQixNQUFNLFNBQVMsMEJBQTBCLElBQUk7QUFBQSxJQUM3QyxNQUFNLFdBQVcsT0FBTyxPQUFPLENBQUMsTUFBTTtBQUFBLE1BQ3BDLE1BQU0sVUFBVSxFQUFFLGdCQUFnQixZQUFZLEVBQUUsYUFBYSxFQUFFLFlBQVksSUFBSTtBQUFBLE1BRy9FLE9BQU8sS0FBSyxXQUFXLFNBQ25CLEVBQUUsU0FBUyxhQUFhLE9BQU8sT0FBTyxJQUN0QyxFQUFFLGdCQUFnQixLQUFLO0FBQUEsS0FDNUI7QUFBQSxJQUNELE1BQU0sU0FBUyxTQUFTLEdBQUcsRUFBRSxHQUFHLE1BQU07QUFBQSxJQUN0QyxXQUFVLEVBQUUsSUFBSSxNQUFNLFVBQVUsVUFBVSxRQUFRLE9BQU8sQ0FBQztBQUFBLElBQzFEO0FBQUEsRUFDRjtBQUFBLEVBR0EsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUM3QixNQUNBLE9BQ0EsYUFBYSx1QkFBdUIsT0FDdEM7QUFBQSxFQUNBLElBQUksVUFBVTtBQUFBLElBQUssT0FBTyxNQUFNLE1BQU07QUFBQSxFQUN0QyxNQUFNLFVBQVUsTUFBTSxZQUFZLENBQUM7QUFBQSxFQUNuQyxNQUFNLFNBQVMsUUFBUSxHQUFHLEVBQUUsR0FBRyxNQUFNO0FBQUEsRUFDckMsTUFBTSxPQUFPLGlCQUFpQixJQUFJO0FBQUEsRUFDbEMsTUFBTSxZQUFZLFFBR2YsT0FBTyxDQUFDLE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxDQUFDLEVBQ3BDLElBQUksQ0FBQyxNQUFNO0FBQUEsSUFDVixNQUFNLElBQUksS0FBSyxJQUFJLEVBQUUsRUFBRTtBQUFBLElBQ3ZCLE9BQU8sSUFBSSxLQUFLLEdBQUcsYUFBYSxFQUFFLGFBQWEsU0FBUyxFQUFFLFFBQVEsSUFBSTtBQUFBLEdBQ3ZFO0FBQUEsRUFDSCxXQUFVLEVBQUUsSUFBSSxNQUFNLFVBQVUsV0FBVyxPQUFPLENBQUM7QUFBQTtBQUdyRCxlQUFlLE9BQU8sQ0FBQyxNQUEwQixJQUFZLE1BQTBCO0FBQUEsRUFDckYsSUFBSSxDQUFDLFFBQVEsQ0FBQyxPQUFPLFNBQVMsRUFBRTtBQUFBLElBQUcsS0FBSSwrQ0FBK0M7QUFBQSxFQUN0RixNQUFNLE9BQU8sTUFBTSxhQUFhO0FBQUEsRUFLaEMsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUM3QixNQUNBLE9BQ0EsYUFBYSx1QkFBdUIsS0FBSyxHQUMzQztBQUFBLEVBQ0EsSUFBSSxVQUFVO0FBQUEsSUFBSyxPQUFPLE1BQU0sTUFBTTtBQUFBLEVBQ3RDLE1BQU0sT0FBTyxNQUFNLFlBQVksQ0FBQyxHQUFHLEtBQUssQ0FBQyxNQUFNLEVBQUUsT0FBTyxFQUFFO0FBQUEsRUFDMUQsSUFBSSxDQUFDO0FBQUEsSUFBSyxLQUFJLFdBQVcsbUJBQW1CLFFBQVEsV0FBVztBQUFBLEVBQy9ELE1BQU0sVUFBVSxpQkFBaUIsSUFBSTtBQUFBLEVBQ3JDLE1BQU0sSUFBSSxRQUFRLElBQUksRUFBRTtBQUFBLEVBQ3hCLE1BQU0sZUFBZSxJQUFJLEtBQUssS0FBSyxhQUFhLEVBQUUsYUFBYSxTQUFTLEVBQUUsUUFBUSxJQUFJO0FBQUEsRUFDdEYsSUFBSSxLQUFLLE1BQU07QUFBQSxJQUdiLE1BQU0sS0FBSyxJQUFJLEtBQUssSUFBSSxFQUFFLEVBQUUsWUFBWTtBQUFBLElBQ3hDLE1BQU0sYUFBYSxJQUNmLEVBQUUsVUFBVSxJQUNWLElBQUksRUFBRSxxQkFBZ0IsRUFBRSxjQUN4QixJQUFJLEVBQUUsa0JBQ1I7QUFBQSxJQUNKLFFBQVEsT0FBTyxNQUFNLEdBQUcsY0FBYyxJQUFJLE9BQU8sSUFBSSxhQUFVO0FBQUEsRUFBTyxJQUFJO0FBQUEsQ0FBUTtBQUFBLElBQ2xGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsV0FBVSxFQUFFLElBQUksTUFBTSxTQUFTLGFBQWEsQ0FBQztBQUFBO0FBRy9DLGVBQWUsT0FBTyxDQUNwQixNQUNBLE9BQ0EsVUFDQSxPQUNBO0FBQUEsRUFDQSxJQUFJLENBQUM7QUFBQSxJQUFNLEtBQUksK0VBQStFO0FBQUEsRUFDOUYsTUFBTSxPQUFPLE1BQU0sYUFBYTtBQUFBLEVBS2hDLE1BQU0sVUFBVSxRQUFRLE9BQU8sbUJBQW1CLEtBQUssTUFBTTtBQUFBLEVBQzdELE1BQU0sTUFBTSxvQkFBb0IsaUJBQWlCLG1CQUFtQixpQkFBaUIsV0FBVztBQUFBLEVBQ2hHLE1BQU0sTUFBTSxNQUFNLE1BQU0sS0FBSztBQUFBLElBQzNCLFFBQVEsWUFBWSxTQUFTLFdBQVcsS0FBSyxJQUFJO0FBQUEsRUFDbkQsQ0FBQztBQUFBLEVBQ0QsSUFBSSxPQUE0QjtBQUFBLEVBQ2hDLElBQUk7QUFBQSxJQUNGLE9BQVEsTUFBTSxJQUFJLEtBQUs7QUFBQSxJQUN2QixNQUFNO0FBQUEsRUFDUixJQUFJLENBQUMsSUFBSTtBQUFBLElBQUksT0FBTyxNQUFNLElBQUksTUFBTTtBQUFBLEVBQ3BDLFdBQVU7QUFBQSxJQUNSLElBQUk7QUFBQSxJQUNKLFVBQVUsTUFBTSxZQUFZLENBQUM7QUFBQSxJQUM3QixRQUFRLE1BQU0sVUFBVTtBQUFBLElBQ3hCLFdBQVcsQ0FBQyxDQUFDLE1BQU07QUFBQSxFQUNyQixDQUFDO0FBQUE7QUFHSCxlQUFlLE1BQU0sQ0FBQyxNQUEwQjtBQUFBLEVBQzlDLElBQUksQ0FBQztBQUFBLElBQU0sS0FBSSxnQ0FBZ0M7QUFBQSxFQUMvQyxNQUFNLE9BQU8sTUFBTSxlQUFlO0FBQUEsRUFDbEMsSUFBSSxDQUFDLE1BQU07QUFBQSxJQUNULFdBQVUsRUFBRSxJQUFJLE1BQU0sUUFBUSxPQUFPLFNBQVMsTUFBTSxhQUFhLENBQUMsRUFBRSxDQUFDO0FBQUEsSUFDckU7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRLFFBQVEsU0FBUyxNQUFNLElBQzdCLE1BQ0EsT0FDQSxhQUFhLGtCQUNmO0FBQUEsRUFDQSxJQUFJLFVBQVU7QUFBQSxJQUFLLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFDdEMsV0FBVSxFQUFFLElBQUksU0FBUyxLQUFLLENBQUM7QUFBQTtBQUdqQyxlQUFlLFNBQVMsR0FBRztBQUFBLEVBR3pCLE1BQU0sT0FBTyxNQUFNLGVBQWU7QUFBQSxFQUNsQyxJQUFJLENBQUMsTUFBTTtBQUFBLElBQ1QsV0FBVSxFQUFFLElBQUksTUFBTSxRQUFRLE9BQU8sVUFBVSxDQUFDLEVBQUUsQ0FBQztBQUFBLElBQ25EO0FBQUEsRUFDRjtBQUFBLEVBQ0EsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFzQixNQUFNLE9BQU8sV0FBVztBQUFBLEVBQzdFLElBQUksVUFBVTtBQUFBLElBQUssT0FBTyxNQUFNLE1BQU07QUFBQSxFQUN0QyxXQUFVLEVBQUUsSUFBSSxTQUFTLEtBQUssQ0FBQztBQUFBO0FBT2pDLGVBQWUsUUFBUSxDQUFDLE1BQTBCO0FBQUEsRUFDaEQsSUFBSSxNQUErQixDQUFDO0FBQUEsRUFDcEMsSUFBSTtBQUFBLElBQ0YsTUFBTSxLQUFLLE1BQU0sYUFBYSxhQUFhLE9BQU8sQ0FBQztBQUFBLElBQ25ELE1BQU07QUFBQSxFQUNSLElBQUksU0FBUyxXQUFXO0FBQUEsSUFDdEIsTUFBTSxRQUFRLE9BQU8sSUFBSSxVQUFVLFlBQVksSUFBSSxNQUFNLEtBQUssSUFBSSxJQUFJLE1BQU0sS0FBSyxJQUFJO0FBQUEsSUFDckYsV0FBVSxFQUFFLElBQUksTUFBTSxNQUFNLENBQUM7QUFBQSxJQUM3QjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE1BQU0sVUFBVSxLQUFLLEtBQUs7QUFBQSxFQUMxQixJQUFJLFFBQVE7QUFBQSxFQUNaLFVBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsRUFDdkMsY0FBYyxhQUFhLEdBQUcsS0FBSyxVQUFVLEtBQUssTUFBTSxDQUFDO0FBQUEsQ0FBSztBQUFBLEVBQzlELFdBQVUsRUFBRSxJQUFJLE1BQU0sT0FBTyxXQUFXLEtBQUssQ0FBQztBQUFBO0FBNENoRCxlQUFlLE9BQU8sQ0FDcEIsTUFDQSxNQVNpQjtBQUFBLEVBQ2pCLElBQUksQ0FBQztBQUFBLElBQ0gsS0FDRSx1SEFDRjtBQUFBLEVBR0YsTUFBTSxVQUFVLEtBQUssT0FBTyxZQUFZLEtBQUs7QUFBQSxFQUM3QyxNQUFNLFFBQVEsS0FBSyxZQUFZLElBQUssS0FBSyxTQUFTO0FBQUEsRUFLbEQsSUFBSSxXQUFXLEtBQUssVUFBVTtBQUFBLEVBVTlCLElBQUksaUJBQWlCLFFBQVEsS0FBSyxLQUFLLFNBQVM7QUFBQSxFQUtoRCxNQUFNLFFBQVEsQ0FBQyxPQUNiLFlBQVk7QUFBQSxJQUNWO0FBQUEsSUFDQTtBQUFBLElBQ0EsR0FBSSxLQUFLLE9BQU8sQ0FBQyxRQUFRLElBQUksVUFBVSxDQUFDLFFBQVEsT0FBTyxJQUFJLENBQUM7QUFBQSxJQUM1RCxHQUFJLEtBQUssU0FBUyxDQUFDLEtBQUssT0FBTyxDQUFDLFNBQVMsSUFBSSxDQUFDO0FBQUEsSUFDOUMsR0FBSSxLQUFLLFFBQVEsWUFBWSxDQUFDLFNBQVMsT0FBTyxLQUFLLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFBQSxJQUc1RCxHQUFJLE1BQU0sSUFBSSxDQUFDLFdBQVcsT0FBTyxFQUFFLENBQUMsSUFBSSxDQUFDO0FBQUEsRUFDM0MsQ0FBQztBQUFBLEVBRUgsT0FBTyxNQUFNLGdCQUNYO0FBQUEsSUFLRSxTQUFTLFlBQVksb0JBQW9CLE1BQU0sYUFBYTtBQUFBLElBQzVELE1BQU0sYUFBYTtBQUFBLElBQ25CO0FBQUEsSUFPQSxPQUFPLENBQUMsUUFBUSxpQkFBaUI7QUFBQSxNQUMvQixNQUFNLElBQTRCLEVBQUUsT0FBTyxPQUFPLE1BQU0sRUFBRTtBQUFBLE1BTTFELElBQUksS0FBSyxTQUFTLGFBQWE7QUFBQSxRQUFjLEVBQUUsT0FBTyxPQUFPLEtBQUssSUFBSTtBQUFBLE1BQ3RFLElBQUk7QUFBQSxRQUFTLEVBQUUsS0FBSztBQUFBLE1BQ3BCLElBQUksS0FBSyxTQUFTLENBQUMsS0FBSztBQUFBLFFBQU0sRUFBRSxRQUFRO0FBQUEsTUFDeEMsSUFBSSxLQUFLO0FBQUEsUUFBTSxFQUFFLE9BQU87QUFBQSxNQUN4QixPQUFPO0FBQUE7QUFBQSxJQUVULFVBQVUsQ0FBQyxPQUFPO0FBQUEsTUFDaEIsSUFBSSxPQUFPLEdBQUcsT0FBTztBQUFBLFFBQVUsT0FBTyxHQUFHO0FBQUEsTUFDekMsSUFBSSxrQkFBa0IsT0FBTyxHQUFHLGNBQWMsVUFBVTtBQUFBLFFBQ3RELGlCQUFpQjtBQUFBLFFBQ2pCLE9BQU8sR0FBRztBQUFBLE1BQ1o7QUFBQSxNQUNBO0FBQUE7QUFBQSxJQUVGLFFBQVEsQ0FBQyxJQUFJLFVBQVU7QUFBQSxNQUVyQixJQUFJLE1BQU0sVUFBVTtBQUFBLFFBQWMsT0FBTztBQUFBLE1BS3pDLElBQUksbUJBQW1CLEVBQUU7QUFBQSxRQUFHLE9BQU87QUFBQSxNQUluQyxJQUFJLFdBQVcsR0FBRyxTQUFTO0FBQUEsUUFBUyxPQUFPO0FBQUEsTUFDM0MsT0FBTztBQUFBO0FBQUEsSUFFVCxRQUFRLENBQUMsU0FBUyxVQUFVO0FBQUEsTUFDMUIsSUFBSSxNQUFNLFVBQVU7QUFBQSxRQUFjLE9BQU8saUJBQWlCLE9BQU87QUFBQSxNQVdqRSxNQUFNLFVBQVUsUUFBUSxRQUFRLFFBQVE7QUFBQSxNQUN4QyxJQUNFLE9BQU8sUUFBUSxTQUFTLFlBQ3hCLFFBQVEsS0FBSyxVQUFVLEtBQUssT0FBTyw0QkFDbkM7QUFBQSxRQUNBLE1BQU0sa0JBQWtCLElBQUksUUFBUSxLQUFLLDZCQUF3QjtBQUFBLFFBR2pFLE1BQU0sT0FBTyxLQUFLLFFBQVEsWUFBWSxRQUFRLEtBQUssTUFBTSxHQUFHLEtBQUssR0FBRyxJQUFJLFFBQVE7QUFBQSxRQUNoRixPQUFPLEtBQUssVUFBVSxFQUFFLG9CQUFvQixTQUFTLEtBQUssQ0FBQztBQUFBLE1BQzdEO0FBQUEsTUFDQSxPQUFPLEtBQUssVUFBVSxFQUFFLE1BQU0sWUFBWSxRQUFRLENBQUM7QUFBQTtBQUFBLElBS3JELFdBQVcsQ0FBQyxTQUFVLEtBQUssVUFBVSxFQUFFLFdBQVcsSUFBSSxJQUFJLDBCQUEwQjtBQUFBLElBQ3BGLGFBQWEsQ0FBQyxRQUFRLE1BQU0sbUJBQW1CLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsSUFHeEYsY0FBYyxDQUFDLFNBQVM7QUFBQSxNQUN0QixRQUFRLEtBQUs7QUFBQSxhQUNOO0FBQUEsVUFDSCxPQUFPLHFCQUFxQixLQUFLLGlCQUFpQixRQUFRLEtBQUssTUFBTSxVQUFVLE9BQU8sS0FBSyxLQUFLO0FBQUEsYUFDN0Y7QUFBQSxhQUNBO0FBQUEsVUFDSCxPQUFPLGVBQWUsS0FBSztBQUFBLGFBQ3hCO0FBQUEsVUFDSCxPQUFPLHFCQUFxQixLQUFLLGlCQUFpQixRQUFRLEtBQUssTUFBTSxVQUFVLE9BQU8sS0FBSyxLQUFLO0FBQUEsYUFDN0Y7QUFBQSxVQUNILE9BQU87QUFBQTtBQUFBO0FBQUEsSUFHYixRQUFRO0FBQUEsRUFDVixHQUNBO0FBQUEsSUFDRSxPQUFPO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixVQUFVO0FBQUEsT0FHTixLQUFLLFFBQVEsRUFBRSxVQUFVLEVBQUUsSUFBSSxDQUFDO0FBQUEsSUFHcEMsUUFBUSxDQUFDLEtBQUssVUFBVSxNQUFNLFVBQVU7QUFBQSxJQUN4QyxVQUFVO0FBQUEsTUFDUixNQUFNLEdBQUcsT0FBTyxTQUFTLE1BQU0sRUFBRTtBQUFBLE1BQ2pDLFVBQVUsTUFBTSxZQUFZLENBQUMsUUFBUSxDQUFDO0FBQUEsSUFDeEM7QUFBQSxFQUNGLENBQ0Y7QUFBQSxFQUlBLFNBQVMsZ0JBQWdCLENBQUMsU0FBcUM7QUFBQSxJQUM3RCxRQUFRLE9BQU8sTUFBTSxtQkFBbUIsUUFBUSxrQkFBa0IsUUFBUTtBQUFBLENBQVU7QUFBQSxJQUNwRixJQUFJLFFBQVE7QUFBQSxNQUFPLFFBQVEsT0FBTyxNQUFNLFlBQVksUUFBUTtBQUFBLENBQVM7QUFBQSxJQUNyRSxJQUFJLFFBQVE7QUFBQSxNQUNWLFFBQVEsT0FBTyxNQUNiLGFBQWEsUUFBUTtBQUFBLENBQ3ZCO0FBQUEsSUFDRixJQUFJLFFBQVE7QUFBQSxNQUNWLFFBQVEsT0FBTyxNQUNiLEtBQUssUUFBUTtBQUFBLENBQ2Y7QUFBQSxJQU1GLElBQUk7QUFBQSxNQUFVLE9BQU87QUFBQSxJQUNyQixXQUFXO0FBQUEsSUFDWCxNQUFNLFNBQVMsT0FBTyxRQUFRLGNBQWMsV0FBVyxRQUFRLFlBQVk7QUFBQSxJQUMzRSxNQUFNLFVBQVUsUUFBUSxJQUFJLFNBQVMsS0FBSyxJQUFJLEdBQUcsS0FBSyxJQUFJLE9BQU8sTUFBTSxDQUFDO0FBQUEsSUFheEUsTUFBTSxRQUFrQixDQUFDO0FBQUEsSUFDekIsSUFBSSxVQUFVO0FBQUEsTUFDWixNQUFNLEtBQ0osR0FBRyxzRkFDTDtBQUFBLElBQ0YsSUFBSSxRQUFRO0FBQUEsTUFDVixNQUFNLEtBQ0oscUJBQXFCLFFBQVEsNkZBQy9CO0FBQUEsSUFDRixJQUFJLFFBQVE7QUFBQSxNQUNWLE1BQU0sS0FDSixHQUFHLFFBQVEsMkZBQ2I7QUFBQSxJQUNGLElBQUksRUFBRSxVQUFVLEtBQUssUUFBUSxTQUFTLFFBQVEsV0FBVyxRQUFRO0FBQUEsTUFBVyxPQUFPO0FBQUEsSUFDbkYsTUFBTSxZQUFxQztBQUFBLE1BQ3pDLE1BQU07QUFBQSxNQUNOLFNBQVMsUUFBUTtBQUFBLE1BQ2pCLFdBQVcsUUFBUSxJQUFJLFNBQVMsS0FBSyxJQUFJLE9BQU8sTUFBTTtBQUFBLE1BQ3REO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSSxRQUFRO0FBQUEsTUFBTyxVQUFVLFFBQVEsUUFBUTtBQUFBLElBQzdDLElBQUksUUFBUTtBQUFBLE1BQVMsVUFBVSxVQUFVO0FBQUEsSUFDekMsSUFBSSxRQUFRO0FBQUEsTUFBVSxVQUFVLFdBQVc7QUFBQSxJQUMzQyxJQUFJLE1BQU07QUFBQSxNQUFRLFVBQVUsT0FBTyxNQUFNLEtBQUssUUFBSztBQUFBLElBQ25ELE9BQU8sS0FBSyxVQUFVLFNBQVM7QUFBQTtBQUFBO0FBR25DLFNBQVMsZ0JBQWdCLENBQUMsTUFBYztBQUFBLEVBQ3RDLE1BQU0sTUFBTSxJQUFJO0FBQUEsRUFVaEIsTUFBTSxPQUFPLEtBQUssVUFBVSxZQUFZLEdBQUcsWUFBWTtBQUFBLEVBQ3ZELElBQUksQ0FBQyxXQUFXLElBQUk7QUFBQSxJQUFHLE9BQU87QUFBQSxFQUM5QixXQUFXLFFBQVEsYUFBYSxNQUFNLE9BQU8sRUFBRSxNQUFNO0FBQUEsQ0FBSSxHQUFHO0FBQUEsSUFDMUQsSUFBSSxDQUFDLEtBQUssS0FBSztBQUFBLE1BQUc7QUFBQSxJQUNsQixJQUFJO0FBQUEsSUFDSixJQUFJO0FBQUEsTUFDRixJQUFJLEtBQUssTUFBTSxJQUFJO0FBQUEsTUFDbkIsTUFBTTtBQUFBLE1BQ047QUFBQTtBQUFBLElBRUYsSUFBSSxFQUFFLFNBQVMsWUFBWSxPQUFPLEVBQUUsV0FBVyxZQUFZLE9BQU8sRUFBRSxnQkFBZ0I7QUFBQSxNQUNsRjtBQUFBLElBQ0YsTUFBTSxPQUFPLElBQUksSUFBSSxFQUFFLE1BQU07QUFBQSxJQUM3QixNQUFNLFdBQ0gsTUFBTSxXQUFXLE1BQ2pCLEVBQUUsZ0JBQWdCLFVBQVUsUUFBUSxLQUFLLGdCQUFnQixTQUFTLElBQUk7QUFBQSxJQUN6RSxJQUFJLElBQUksRUFBRSxRQUFRO0FBQUEsTUFDaEIsYUFBYSxFQUFFO0FBQUEsTUFDZixNQUFNLEVBQUU7QUFBQSxNQUNSLElBQUksRUFBRTtBQUFBLE1BQ04sTUFBTSxFQUFFO0FBQUEsTUFDUjtBQUFBLElBQ0YsQ0FBQztBQUFBLEVBQ0g7QUFBQSxFQUNBLE9BQU87QUFBQTtBQVNULFNBQVMsa0JBQWtCLENBQUMsR0FBcUQ7QUFBQSxFQUMvRSxPQUFPLEVBQUUsU0FBUyxZQUFZLE9BQU8sRUFBRSxnQkFBZ0I7QUFBQTtBQUl6RCxTQUFTLE1BQU0sQ0FBQyxHQUE2QjtBQUFBLEVBQzNDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsZ0JBQWdCO0FBQUE7QUFVakMsU0FBUyx5QkFBeUIsQ0FDaEMsTUFDMEQ7QUFBQSxFQUMxRCxNQUFNLFVBQVUsS0FBSyxVQUFVLFlBQVksR0FBRyxZQUFZO0FBQUEsRUFDMUQsSUFBSSxDQUFDLFdBQVcsT0FBTztBQUFBLElBQUcsT0FBTyxDQUFDO0FBQUEsRUFDbEMsTUFBTSxPQUFPLGlCQUFpQixJQUFJO0FBQUEsRUFDbEMsTUFBTSxXQUFxRSxDQUFDO0FBQUEsRUFDNUUsV0FBVyxRQUFRLGFBQWEsU0FBUyxPQUFPLEVBQUUsTUFBTTtBQUFBLENBQUksR0FBRztBQUFBLElBQzdELElBQUksQ0FBQyxLQUFLLEtBQUs7QUFBQSxNQUFHO0FBQUEsSUFDbEIsSUFBSTtBQUFBLElBQ0osSUFBSTtBQUFBLE1BQ0YsSUFBSSxLQUFLLE1BQU0sSUFBSTtBQUFBLE1BQ25CLE1BQU07QUFBQSxNQUNOO0FBQUE7QUFBQSxJQUVGLElBQUksRUFBRSxTQUFTO0FBQUEsTUFBVTtBQUFBLElBQ3pCLE1BQU0sSUFBSSxLQUFLLElBQUksRUFBRSxFQUFFO0FBQUEsSUFDdkIsSUFBSSxHQUFHO0FBQUEsTUFDTCxTQUFTLEtBQUssS0FBSyxHQUFHLGFBQWEsRUFBRSxhQUFhLFNBQVMsRUFBRSxRQUFRLENBQUM7QUFBQSxJQUN4RSxFQUFPO0FBQUEsTUFDTCxTQUFTLEtBQUssQ0FBQztBQUFBO0FBQUEsRUFFbkI7QUFBQSxFQUNBLE9BQU87QUFBQTtBQVFULFNBQVMsaUJBQWlCLENBQ3hCLE1BQ0EsTUFDQSxXQUNRO0FBQUEsRUFDUixNQUFNLE9BQU8sQ0FBQyxNQUFxQjtBQUFBLElBQ2pDLE1BQU0sS0FBSyxJQUFJLEtBQUssRUFBRSxFQUFFLEVBQUUsWUFBWSxFQUFFLE1BQU0sR0FBRyxFQUFFLEVBQUUsUUFBUSxLQUFLLEdBQUc7QUFBQSxJQUNyRSxNQUFNLFNBQVMsRUFBRSxXQUFXLEVBQUUsVUFBVSxJQUFJLFVBQUssRUFBRSxZQUFZO0FBQUEsSUFHL0QsTUFBTSxLQUFLLEVBQUUsS0FBSyxRQUFRO0FBQUEsQ0FBSTtBQUFBLElBQzlCLE1BQU0sT0FBTyxPQUFPLEtBQUssRUFBRSxPQUFPLEVBQUUsS0FBSyxNQUFNLEdBQUcsRUFBRTtBQUFBLElBQ3BELE1BQU0sVUFBVSxLQUFLLFNBQVMsTUFBTSxHQUFHLEtBQUssTUFBTSxHQUFHLEVBQUUsWUFBTztBQUFBLElBQzlELE9BQU8sTUFBTSxFQUFFLEtBQUssV0FBVyxFQUFFLGFBQVUsV0FBUTtBQUFBO0FBQUEsRUFFckQsTUFBTSxXQUFXLENBQUMsR0FBRztBQUFBLEdBQW1CLFNBQVMsS0FBSyxTQUFTO0FBQUEsRUFDL0QsU0FBUyxLQUFLLEtBQUssU0FBUyxLQUFLLElBQUksSUFBSSxFQUFFLEtBQUs7QUFBQSxDQUFJLElBQUksVUFBSztBQUFBLEVBQzdELFlBQVksUUFBUSxVQUFVLE9BQU8sUUFBUSxTQUFTLEdBQUc7QUFBQSxJQUN2RCxTQUFTLEtBQUs7QUFBQSxFQUFLLE9BQU8sWUFBWSxNQUFNLE1BQU0sV0FBVyxNQUFNLElBQUksSUFBSSxFQUFFLEtBQUs7QUFBQSxDQUFJLENBQUM7QUFBQSxFQUN6RjtBQUFBLEVBQ0EsT0FBTyxHQUFHLFNBQVMsS0FBSztBQUFBLENBQUk7QUFBQTtBQUFBO0FBRzlCLGVBQWUsU0FBUyxDQUFDLE1BQTBCLE9BQTRCLENBQUMsR0FBRztBQUFBLEVBQ2pGLElBQUksQ0FBQztBQUFBLElBQU0sS0FBSSw2Q0FBNkM7QUFBQSxFQUM1RCxNQUFNLE9BQU8sTUFBTSxhQUFhO0FBQUEsRUFJaEMsTUFBTSxlQUFlLE1BQU0sSUFBSTtBQUFBLEVBQy9CLE1BQU0sU0FBUywwQkFBMEIsSUFBSTtBQUFBLEVBQzdDLE1BQU0sT0FBd0IsQ0FBQztBQUFBLEVBQy9CLE1BQU0sWUFBNkMsQ0FBQztBQUFBLEVBQ3BELFdBQVcsS0FBSyxRQUFRO0FBQUEsSUFFdEIsTUFBTSxVQUFVLEVBQUUsZ0JBQWdCLFlBQVksRUFBRSxhQUFhLEVBQUUsWUFBWSxJQUFJO0FBQUEsSUFDL0UsSUFBSSxPQUFPLE9BQU8sR0FBRztBQUFBLE1BSW5CLElBQUksRUFBRSxTQUFTO0FBQUEsUUFBVyxLQUFLLEtBQUssQ0FBQztBQUFBLElBQ3ZDLEVBQU87QUFBQSxNQUNMLE1BQU0sTUFBTSxFQUFFLGVBQWU7QUFBQSxNQUM3QixJQUFJLENBQUMsVUFBVTtBQUFBLFFBQU0sVUFBVSxPQUFPLENBQUM7QUFBQSxNQUN2QyxVQUFVLEtBQUssS0FBSyxDQUFDO0FBQUE7QUFBQSxFQUV6QjtBQUFBLEVBQ0EsSUFBSSxLQUFLLE9BQU87QUFBQSxJQUNkLFFBQVEsT0FBTyxNQUFNLGtCQUFrQixNQUFNLE1BQU0sU0FBUyxDQUFDO0FBQUEsSUFDN0Q7QUFBQSxFQUNGO0FBQUEsRUFDQSxXQUFVLEVBQUUsSUFBSSxNQUFNLE1BQU0sVUFBVSxDQUFDO0FBQUE7QUFHekMsZUFBZSxPQUFPLENBQ3BCLE1BQ0EsU0FDQSxNQUNBO0FBQUEsRUFDQSxJQUFJLENBQUMsUUFBUSxDQUFDO0FBQUEsSUFDWixLQUFJLDJFQUEyRTtBQUFBLEVBQ2pGLE1BQU0sVUFBVSxLQUFLLFVBQVUsWUFBWSxHQUFHLFlBQVk7QUFBQSxFQUMxRCxJQUFJLENBQUMsV0FBVyxPQUFPLEdBQUc7QUFBQSxJQUN4QixXQUFVLEVBQUUsSUFBSSxNQUFNLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUNwQztBQUFBLEVBQ0Y7QUFBQSxFQUNBLElBQUk7QUFBQSxFQUNKLElBQUksS0FBSyxTQUFTO0FBQUEsSUFDaEIsTUFBTSxTQUFTLFFBQVEsWUFBWTtBQUFBLElBQ25DLFVBQVUsQ0FBQyxTQUFTLEtBQUssWUFBWSxFQUFFLFNBQVMsTUFBTTtBQUFBLEVBQ3hELEVBQU87QUFBQSxJQUNMLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxNQUNGLEtBQUssSUFBSSxPQUFPLFNBQVMsR0FBRztBQUFBLE1BQzVCLE9BQU8sR0FBRztBQUFBLE1BQ1YsS0FBSSxrQkFBa0IsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUMsS0FBSyxPQUFPO0FBQUE7QUFBQSxJQUU3RSxVQUFVLENBQUMsU0FBUyxHQUFHLEtBQUssSUFBSTtBQUFBO0FBQUEsRUFFbEMsTUFBTSxNQUFNLGFBQWEsU0FBUyxPQUFPO0FBQUEsRUFDekMsTUFBTSxXQUFzQixDQUFDO0FBQUEsRUFDN0IsV0FBVyxRQUFRLElBQUksTUFBTTtBQUFBLENBQUksR0FBRztBQUFBLElBQ2xDLElBQUksQ0FBQztBQUFBLE1BQU07QUFBQSxJQUNYLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxNQUNGLE1BQU0sS0FBSyxNQUFNLElBQUk7QUFBQSxNQUNyQixNQUFNO0FBQUEsTUFDTjtBQUFBO0FBQUEsSUFFRixJQUFJLE9BQU8sSUFBSSxTQUFTO0FBQUEsTUFBVTtBQUFBLElBQ2xDLElBQUksS0FBSyxRQUFRLElBQUksU0FBUyxLQUFLO0FBQUEsTUFBTTtBQUFBLElBQ3pDLElBQUksQ0FBQyxRQUFRLElBQUksSUFBSTtBQUFBLE1BQUc7QUFBQSxJQUN4QixTQUFTLEtBQUssR0FBRztBQUFBLEVBQ25CO0FBQUEsRUFDQSxXQUFVLEVBQUUsSUFBSSxNQUFNLFNBQVMsQ0FBQztBQUFBO0FBR2xDLGVBQWUsUUFBUSxDQUFDLE1BQTBCO0FBQUEsRUFDaEQsSUFBSSxDQUFDO0FBQUEsSUFBTSxLQUFJLCtCQUErQjtBQUFBLEVBQzlDLE1BQU0sT0FBTyxNQUFNLGVBQWU7QUFBQSxFQUNsQyxJQUFJLENBQUM7QUFBQSxJQUFNLEtBQUkscUJBQXFCLFdBQVc7QUFBQSxFQUMvQyxRQUFRLFFBQVEsU0FBUyxNQUFNLElBQW9CLE1BQU0sVUFBVSxhQUFhLE1BQU07QUFBQSxFQUN0RixJQUFJLFVBQVU7QUFBQSxJQUFLLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFDdEMsV0FBVSxFQUFFLElBQUksS0FBSyxDQUFDO0FBQUE7QUFHeEIsZUFBZSxRQUFRLENBQUMsTUFBMEIsTUFBMkI7QUFBQSxFQUMzRSxJQUFJLENBQUM7QUFBQSxJQUFNLEtBQUkseUNBQXlDO0FBQUEsRUFDeEQsTUFBTSxPQUFPLE1BQU0sYUFBYTtBQUFBLEVBQ2hDLE1BQU0sT0FBZ0MsQ0FBQztBQUFBLEVBQ3ZDLElBQUksS0FBSztBQUFBLElBQU8sS0FBSyxRQUFRO0FBQUEsRUFDN0IsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUM3QixNQUNBLFFBQ0EsYUFBYSxjQUNiLElBQ0Y7QUFBQSxFQUNBLElBQUksV0FBVyxPQUFPLE1BQU0sVUFBVSxRQUFRO0FBQUEsSUFDNUMsS0FDRSxlQUFlLEtBQUssK0lBQ3BCLFVBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxJQUFJLFVBQVU7QUFBQSxJQUFLLE9BQU8sTUFBTSxNQUFNO0FBQUEsRUFDdEMsV0FBVSxFQUFFLElBQUksU0FBUyxLQUFLLENBQUM7QUFBQTtBQU1qQyxlQUFlLE9BQU8sQ0FDcEIsTUFDQSxJQUNBLGFBQ0EsTUFDQSxNQUNBO0FBQUEsRUFDQSxJQUFJLENBQUMsUUFBUSxDQUFDLE9BQU8sU0FBUyxFQUFFLEtBQUssQ0FBQztBQUFBLElBQ3BDLEtBQUksbUZBQW1GO0FBQUEsRUFDekYsTUFBTSxPQUFPLE1BQU0sYUFBYTtBQUFBLEVBQ2hDLE1BQU0sT0FBZ0MsRUFBRSxNQUFNLFFBQVEsSUFBSSxZQUFZO0FBQUEsRUFDdEUsSUFBSSxLQUFLLFNBQVM7QUFBQSxJQUFXLEtBQUssT0FBTyxLQUFLO0FBQUEsRUFDOUMsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFhLE1BQU0sUUFBUSxhQUFhLGVBQWUsSUFBSTtBQUFBLEVBQzFGLElBQUksVUFBVSxPQUFPLENBQUM7QUFBQSxJQUFNLE9BQU8sTUFBa0QsTUFBTTtBQUFBLEVBQzNGLFdBQVUsSUFBSTtBQUFBO0FBR2hCLGVBQWUsVUFBVSxDQUFDLE1BQTBCLFdBQW9CLE1BQWU7QUFBQSxFQUNyRixNQUFNLE9BQU8sWUFBWSxjQUFjO0FBQUEsRUFDdkMsSUFBSSxDQUFDO0FBQUEsSUFBTSxLQUFJLG9CQUFvQixnQkFBZ0I7QUFBQSxFQUNuRCxNQUFNLE9BQU8sTUFBTSxhQUFhO0FBQUEsRUFJaEMsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUM3QixNQUNBLFFBQ0EsYUFBYSxRQUFRLFFBQ3JCLE9BQU8sRUFBRSxLQUFLLElBQUksU0FDcEI7QUFBQSxFQUNBLElBQUksVUFBVTtBQUFBLElBQUssT0FBTyxNQUFNLE1BQU07QUFBQSxFQUN0QyxXQUFVLEVBQUUsSUFBSSxTQUFTLEtBQUssQ0FBQztBQUFBO0FBR2pDLGVBQWUsT0FBTyxDQUFDLE9BQWlDLENBQUMsR0FBRztBQUFBLEVBQzFELElBQUk7QUFBQSxFQUNKLElBQUksS0FBSyxlQUFlLEtBQUssY0FBYyxHQUFHO0FBQUEsSUFDNUMsWUFBWSxLQUFLLElBQUksSUFBSSxLQUFLLGNBQWM7QUFBQSxJQUM1QyxJQUFJO0FBQUEsTUFDRixjQUFjLFdBQVcsT0FBTyxTQUFTLENBQUM7QUFBQSxNQUMxQyxNQUFNO0FBQUEsRUFDVjtBQUFBLEVBQ0EsTUFBTSxPQUFPLE1BQU0sZUFBZTtBQUFBLEVBQ2xDLElBQUksQ0FBQyxNQUFNO0FBQUEsSUFDVCxXQUFVO0FBQUEsTUFDUixJQUFJO0FBQUEsTUFDSixRQUFRO0FBQUEsU0FDSixjQUFjLFlBQVksRUFBRSxZQUFZLFVBQVUsSUFBSSxDQUFDO0FBQUEsSUFDN0QsQ0FBQztBQUFBLElBQ0Q7QUFBQSxFQUNGO0FBQUEsRUFDQSxJQUFJO0FBQUEsSUFDRixNQUFNLElBQUksTUFBTSxVQUFVLEdBQUc7QUFBQSxJQUM3QixNQUFNO0FBQUEsRUFJUixNQUFNLGdCQUFnQixNQUFNO0FBQUEsRUFDNUIsV0FBVTtBQUFBLElBQ1IsSUFBSTtBQUFBLElBQ0osU0FBUztBQUFBLE9BQ0wsY0FBYyxZQUFZLEVBQUUsWUFBWSxVQUFVLElBQUksQ0FBQztBQUFBLEVBQzdELENBQUM7QUFBQTtBQUtILGVBQWUsc0JBQXNCLENBQ25DLE1BQ29GO0FBQUEsRUFDcEYsSUFBSSxRQUFRO0FBQUEsRUFDWixNQUFNLFdBQXlELENBQUM7QUFBQSxFQUNoRSxJQUFJO0FBQUEsSUFDRixRQUFRLFNBQVMsTUFBTSxJQUFzQixNQUFNLE9BQU8sV0FBVztBQUFBLElBQ3JFLFdBQVcsTUFBTSxNQUFNLFlBQVksQ0FBQyxHQUFHO0FBQUEsTUFDckMsU0FBUyxHQUFHO0FBQUEsTUFDWixJQUFJLEdBQUcsY0FBYztBQUFBLFFBQUcsU0FBUyxLQUFLLEVBQUUsTUFBTSxHQUFHLE1BQU0sYUFBYSxHQUFHLFlBQVksQ0FBQztBQUFBLElBQ3RGO0FBQUEsSUFDQSxNQUFNO0FBQUEsRUFHUixPQUFPLEVBQUUsT0FBTyxTQUFTO0FBQUE7QUFHM0IsZUFBZSxRQUFRLEdBQUc7QUFBQSxFQUl4QixNQUFNLFdBQVcsTUFBTSxlQUFlO0FBQUEsRUFDdEMsSUFBSSxDQUFDLFlBQVksV0FBVyxHQUFHO0FBQUEsSUFDN0IsV0FBVSxFQUFFLElBQUksTUFBTSxNQUFNLE1BQU0sTUFBTSxLQUFLLENBQUM7QUFBQSxJQUM5QztBQUFBLEVBQ0Y7QUFBQSxFQUNBLE1BQU0sT0FBTyxZQUFhLE1BQU0sYUFBYTtBQUFBLEVBQzdDLFdBQVUsRUFBRSxJQUFJLE1BQU0sTUFBTSxpQkFBaUIsYUFBYSxLQUFLLENBQUM7QUFBQTtBQUdsRSxlQUFlLFVBQVUsQ0FBQyxNQUEyQjtBQUFBLEVBQ25ELE1BQU0sT0FBTyxNQUFNLGVBQWU7QUFBQSxFQUNsQyxJQUFJLENBQUMsTUFBTTtBQUFBLElBRVQsTUFBTSxTQUFRLE1BQU0sYUFBYTtBQUFBLElBQ2pDLFdBQVUsRUFBRSxJQUFJLE1BQU0sV0FBVyxNQUFNLE1BQU0sUUFBTyxjQUFjLEtBQUssQ0FBQztBQUFBLElBQ3hFO0FBQUEsRUFDRjtBQUFBLEVBR0EsUUFBUSxPQUFPLGFBQWEsTUFBTSx1QkFBdUIsSUFBSTtBQUFBLEVBQzdELElBQUksUUFBUSxLQUFLLENBQUMsS0FBSyxPQUFPO0FBQUEsSUFDNUIsTUFBTSxRQUFRLFNBQVMsSUFBSSxDQUFDLE1BQU0sR0FBRyxFQUFFLFNBQVMsRUFBRSxjQUFjLEVBQUUsS0FBSyxJQUFJO0FBQUEsSUFDM0UsS0FDRSxZQUFZLHFDQUFxQyxTQUFTLDRCQUF1QixZQUMvRSxrR0FDRixVQUNGO0FBQUEsRUFDRjtBQUFBLEVBRUEsSUFBSSxjQUE2QjtBQUFBLEVBQ2pDLElBQUk7QUFBQSxJQUNGLFFBQVEsU0FBUyxNQUFNLElBQWMsTUFBTSxPQUFPLEdBQUc7QUFBQSxJQUNyRCxjQUFjLE1BQU0sT0FBTztBQUFBLElBQzNCLE1BQU07QUFBQSxFQUlSLElBQUk7QUFBQSxJQUNGLE1BQU0sSUFBSSxNQUFNLFVBQVUsR0FBRztBQUFBLElBQzdCLE1BQU07QUFBQSxFQUNSLE1BQU0sZ0JBQWdCLFNBQVM7QUFBQSxFQUMvQixNQUFNLFFBQVEsTUFBTSxhQUFhO0FBQUEsRUFDakMsV0FBVSxFQUFFLElBQUksTUFBTSxXQUFXLE1BQU0sTUFBTSxPQUFPLGNBQWMsWUFBWSxDQUFDO0FBQUE7QUF5QmpGLGVBQXNCLFlBQVksQ0FBQyxNQUloQztBQUFBLEVBQ0QsSUFBSTtBQUFBLElBQ0YsTUFBTSxLQUFLLE1BQU0sSUFBYyxNQUFNLE9BQU8sR0FBRyxHQUFHLE1BQU0sV0FBVztBQUFBLElBQ25FLElBQUksTUFBTSxNQUFNO0FBQUEsTUFDZCxPQUFPO0FBQUEsUUFDTCxTQUFTO0FBQUEsUUFDVCxZQUFZO0FBQUEsUUFDWiwwQkFBMEI7QUFBQSxNQUM1QjtBQUFBLElBQ0Y7QUFBQSxJQUNBLE9BQU8sRUFBRSxTQUFTLEdBQUcsWUFBWSxNQUFNLGdCQUFnQiwwQkFBMEIsS0FBSztBQUFBLElBQ3RGLE9BQU8sR0FBRztBQUFBLElBQ1YsT0FBTztBQUFBLE1BQ0wsU0FBUztBQUFBLE1BQ1QsWUFBWTtBQUFBLE1BQ1osMEJBQTBCLHlDQUN4QixhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLElBRTdDO0FBQUE7QUFBQTtBQUlKLGVBQWUsT0FBTyxDQUFDLE1BQTJCO0FBQUEsRUFDaEQsTUFBTSxPQUFPLE1BQU0sZUFBZTtBQUFBLEVBQ2xDLElBQUksQ0FBQyxNQUFNO0FBQUEsSUFJVCxNQUFNLFNBQVEsTUFBTSxhQUFhO0FBQUEsSUFDakMsV0FBVTtBQUFBLE1BQ1IsSUFBSTtBQUFBLE1BQ0osUUFBUTtBQUFBLE1BQ1IsY0FBYztBQUFBLE1BQ2QsTUFBTTtBQUFBLFNBQ0YsTUFBTSxhQUFhLE1BQUs7QUFBQSxJQUM5QixDQUFDO0FBQUEsSUFDRDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVEsT0FBTyxhQUFhLE1BQU0sdUJBQXVCLElBQUk7QUFBQSxFQUM3RCxJQUFJLFFBQVEsS0FBSyxDQUFDLEtBQUssT0FBTztBQUFBLElBQzVCLE1BQU0sUUFBUSxTQUFTLElBQUksQ0FBQyxNQUFNLEdBQUcsRUFBRSxTQUFTLEVBQUUsY0FBYyxFQUFFLEtBQUssSUFBSTtBQUFBLElBQzNFLEtBQ0UsU0FBUyxxQ0FBZ0Msa0ZBQ3pDLFVBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxJQUFJLGNBQTZCO0FBQUEsRUFDakMsSUFBSTtBQUFBLElBQ0YsZUFBZSxNQUFNLElBQWMsTUFBTSxPQUFPLEdBQUcsR0FBRyxNQUFNLE9BQU87QUFBQSxJQUNuRSxNQUFNO0FBQUEsRUFFUixNQUFNLFNBQVM7QUFBQSxFQUNmLElBQUk7QUFBQSxJQUNGLGNBQWMsV0FBVyxPQUFPLEtBQUssSUFBSSxJQUFJLE1BQU0sQ0FBQztBQUFBLElBQ3BELE1BQU07QUFBQSxFQUNSLElBQUk7QUFBQSxJQUNGLE1BQU0sSUFBSSxNQUFNLFVBQVUsR0FBRztBQUFBLElBQzdCLE1BQU07QUFBQSxFQUNSLElBQUk7QUFBQSxJQUNGLE1BQU0sZ0JBQWdCLE1BQU07QUFBQSxZQUM1QjtBQUFBLElBQ0EsWUFBWTtBQUFBO0FBQUEsRUFFZCxNQUFNLFFBQVEsTUFBTSxhQUFhO0FBQUEsRUFDakMsSUFBSSxNQUFxQjtBQUFBLEVBQ3pCLElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxJQUFjLE9BQU8sT0FBTyxHQUFHLEdBQUcsTUFBTSxPQUFPO0FBQUEsSUFDNUQsTUFBTTtBQUFBLEVBQ1IsV0FBVTtBQUFBLElBQ1IsSUFBSTtBQUFBLElBQ0osUUFBUTtBQUFBLElBQ1IsY0FBYztBQUFBLElBQ2Q7QUFBQSxJQUNBLE1BQU07QUFBQSxPQUNGLE1BQU0sYUFBYSxLQUFLO0FBQUEsRUFDOUIsQ0FBQztBQUFBO0FBR0gsZUFBZSxRQUFRLENBQUMsTUFBMEI7QUFBQSxFQUtoRCxNQUFNLFVBQVUsTUFBTSxLQUFLLElBQUksS0FBSyxLQUFLLElBQUk7QUFBQSxFQUM3QyxNQUFNLE9BQU8sTUFBTSxhQUFhO0FBQUEsRUFFaEMsTUFBTSxJQUFJLE1BQU0sUUFBUSxhQUFhLEVBQUUsTUFBTSxRQUFRLENBQUM7QUFBQSxFQUN0RCxNQUFNLE1BQU0sb0JBQW9CLGNBQWMsbUJBQW1CLE9BQU87QUFBQSxFQUd4RSxNQUFNLFNBQ0osUUFBUSxhQUFhLFdBQVcsU0FBUyxRQUFRLGFBQWEsVUFBVSxhQUFhO0FBQUEsRUFDdkYsSUFBSTtBQUFBLElBQ0YsTUFBTSxJQUFJLE1BQU0sUUFBUSxDQUFDLEdBQUcsR0FBRztBQUFBLE1BQzdCLFVBQVU7QUFBQSxNQUNWLE9BQU87QUFBQSxJQUNULENBQUM7QUFBQSxJQUNELEVBQUUsTUFBTTtBQUFBLElBQ1IsTUFBTTtBQUFBLEVBR1IsV0FBVSxFQUFFLElBQUksTUFBTSxTQUFTLElBQUksQ0FBQztBQUFBO0FBR3RDLGVBQWUsU0FBUyxHQUFHO0FBQUEsRUFLekIsTUFBTSxPQUFPLE1BQU0sZUFBZTtBQUFBLEVBQ2xDLElBQUksZ0JBQWdEO0FBQUEsRUFJcEQsSUFBSSxtQkFBbUI7QUFBQSxFQUN2QixNQUFNLGVBTUQsQ0FBQztBQUFBLEVBQ04sSUFBSSxNQUFNO0FBQUEsSUFDUixJQUFJO0FBQUEsTUFDRixRQUFRLFNBQVMsTUFBTSxJQUFjLE1BQU0sT0FBTyxHQUFHO0FBQUEsTUFDckQsZ0JBQWdCLEVBQUUsU0FBUyxLQUFLO0FBQUEsTUFDaEMsTUFBTTtBQUFBLElBR1IsSUFBSTtBQUFBLE1BSUYsUUFBUSxNQUFNLGFBQWEsTUFBTSxJQUFzQixNQUFNLE9BQU8sV0FBVztBQUFBLE1BQy9FLFdBQVcsTUFBTSxVQUFVLFlBQVksQ0FBQyxHQUFHO0FBQUEsUUFDekMsb0JBQW9CLEdBQUc7QUFBQSxRQUN2QixhQUFhLEtBQUs7QUFBQSxVQUNoQixNQUFNLEdBQUc7QUFBQSxVQUNULGFBQWEsR0FBRztBQUFBLFVBQ2hCLGFBQWEsR0FBRztBQUFBLFVBQ2hCLE9BQU8sR0FBRztBQUFBLFVBQ1YsV0FBVyxHQUFHO0FBQUEsUUFDaEIsQ0FBQztBQUFBLE1BQ0g7QUFBQSxNQUNBLE1BQU07QUFBQSxFQUdWO0FBQUEsRUFLQSxNQUFNLGVBQXlGLENBQUM7QUFBQSxFQUNoRyxNQUFNLFVBQVUsZUFBZTtBQUFBLEVBQy9CLElBQUk7QUFBQSxJQUNGLFdBQVcsT0FBTyxNQUFNLHdCQUF3QixHQUFHO0FBQUEsTUFDakQsSUFBSSxXQUFXLFFBQVE7QUFBQSxRQUFTO0FBQUEsTUFDaEMsYUFBYSxLQUFLLE1BQU0sZUFBZSxHQUFHLENBQUM7QUFBQSxJQUM3QztBQUFBLElBQ0EsTUFBTTtBQUFBLEVBS1IsTUFBTSxpQkFBMkIsQ0FBQztBQUFBLEVBQ2xDLElBQUk7QUFBQSxJQUNGLE1BQU0sY0FBYyxLQUFLLFVBQVUsVUFBVTtBQUFBLElBQzdDLElBQUksV0FBVyxXQUFXLEdBQUc7QUFBQSxNQUMzQixXQUFXLEtBQUssWUFBWSxXQUFXLEdBQUc7QUFBQSxRQUN4QyxJQUFJLEVBQUUsU0FBUyxRQUFRO0FBQUEsVUFBRyxlQUFlLEtBQUssRUFBRSxRQUFRLFlBQVksRUFBRSxDQUFDO0FBQUEsTUFDekU7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNO0FBQUEsRUFHUixNQUFNLFFBQWtCLENBQUM7QUFBQSxFQUN6QixJQUFJLENBQUMsZUFBZTtBQUFBLElBQ2xCLE1BQU0sS0FDSixnR0FDRjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLElBQUksYUFBYSxTQUFTLEdBQUc7QUFBQSxJQUMzQixNQUFNLEtBQ0osU0FBUyxhQUFhLGdFQUNwQiwrRkFDSjtBQUFBLElBQ0EsTUFBTSxnQkFBZ0IsYUFBYSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLElBQzdELElBQUksZ0JBQWdCLEdBQUc7QUFBQSxNQUNyQixNQUFNLEtBQ0osU0FBUyx1RkFDWDtBQUFBLElBQ0Y7QUFBQSxJQUNBLElBQUksYUFBYSxLQUFLLENBQUMsTUFBTSxFQUFFLFdBQVcsY0FBYyxHQUFHO0FBQUEsTUFDekQsTUFBTSxLQUFLLHdFQUF3RTtBQUFBLElBQ3JGO0FBQUEsRUFDRjtBQUFBLEVBQ0EsSUFDRSxpQkFDQSxrQkFDQSxPQUFPLGNBQWMsWUFBWSxZQUNqQyxjQUFjLFlBQVksZ0JBQzFCO0FBQUEsSUFDQSxNQUFNLEtBQ0osaUNBQWlDLGNBQWMsNkNBQTZDLHNCQUMxRixtRkFDSjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLElBQUksa0JBQWtCLGNBQWMsWUFBWSxRQUFRLGNBQWMsWUFBWSxZQUFZO0FBQUEsSUFDNUYsTUFBTSxLQUFLLGlGQUFpRjtBQUFBLEVBQzlGO0FBQUEsRUFDQSxJQUFJLG1CQUFtQixHQUFHO0FBQUEsSUFDeEIsTUFBTSxLQUNKLEdBQUcsZ0RBQWdELGFBQWEsd0JBQzlELG9HQUNKO0FBQUEsRUFDRixFQUFPLFNBQUksZUFBZTtBQUFBLElBQ3hCLE1BQU0sS0FBSyxnRUFBMkQ7QUFBQSxFQUN4RTtBQUFBLEVBR0EsV0FBVyxNQUFNLGNBQWM7QUFBQSxJQUM3QixJQUFJLEdBQUcsWUFBWSxHQUFHO0FBQUEsTUFDcEIsTUFBTSxLQUNKLEdBQUcsR0FBRyxTQUFTLEdBQUcsOEJBQThCLEdBQUcsNEJBQ2pELEdBQUcsR0FBRyxnR0FDVjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFFQSxXQUFVO0FBQUEsSUFDUixJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixhQUFhO0FBQUEsSUFDYjtBQUFBLElBQ0Esb0JBQW9CO0FBQUEsTUFDbEIsT0FBTztBQUFBLE1BQ1AsZUFBZTtBQUFBLElBQ2pCO0FBQUEsSUFDQSwwQkFBMEI7QUFBQSxJQUMxQixrQkFBa0I7QUFBQSxJQUNsQjtBQUFBLEVBQ0YsQ0FBQztBQUFBO0FBR0gsZUFBZSxPQUFPLEdBQUc7QUFBQSxFQUN2QixNQUFNLE9BQU8sTUFBTSxlQUFlO0FBQUEsRUFDbEMsSUFBSSxDQUFDLE1BQU07QUFBQSxJQUNULFdBQVUsRUFBRSxJQUFJLE1BQU0sUUFBUSxNQUFNLENBQUM7QUFBQSxJQUNyQztBQUFBLEVBQ0Y7QUFBQSxFQUNBLFFBQVEsU0FBUyxNQUFNLElBQWMsTUFBTSxPQUFPLEdBQUc7QUFBQSxFQUNyRCxXQUFVLEVBQUUsSUFBSSxNQUFNLFFBQVEsU0FBUyxLQUFLLENBQUM7QUFBQTtBQU0vQyxlQUFlLHVCQUF1QixHQUFzQjtBQUFBLEVBQzFELE1BQU0sT0FBaUIsQ0FBQztBQUFBLEVBQ3hCLElBQUk7QUFBQSxJQUNGLE1BQU0sT0FBTyxNQUFNLE1BQU0sQ0FBQyxPQUFPLGFBQWEsR0FBRztBQUFBLE1BQy9DLE9BQU8sQ0FBQyxVQUFVLFFBQVEsUUFBUTtBQUFBLElBQ3BDLENBQUM7QUFBQSxJQUNELE1BQU0sU0FBbUIsQ0FBQztBQUFBLElBQzFCLEtBQUssUUFBUSxHQUFHLFFBQVEsQ0FBQyxNQUFNLE9BQU8sS0FBSyxDQUFXLENBQUM7QUFBQSxJQUN2RCxNQUFNLElBQUksUUFBYyxDQUFDLFlBQVksS0FBSyxHQUFHLFFBQVEsTUFBTSxRQUFRLENBQUMsQ0FBQztBQUFBLElBQ3JFLE1BQU0sTUFBTSxPQUFPLE9BQU8sTUFBTSxFQUFFLFNBQVMsT0FBTztBQUFBLElBQ2xELFdBQVcsUUFBUSxJQUFJLE1BQU07QUFBQSxDQUFJLEdBQUc7QUFBQSxNQUNsQyxJQUFJLENBQUMsS0FBSyxTQUFTLFdBQVc7QUFBQSxRQUFHO0FBQUEsTUFDakMsSUFBSSxDQUFDLEtBQUssWUFBWSxFQUFFLFNBQVMsV0FBVztBQUFBLFFBQUc7QUFBQSxNQUUvQyxNQUFNLFNBQVMsS0FBSyxNQUFNLGNBQWMsSUFBSTtBQUFBLE1BQzVDLElBQUksV0FBVztBQUFBLFFBQVc7QUFBQSxNQUMxQixNQUFNLE1BQU0sU0FBUyxRQUFRLEVBQUU7QUFBQSxNQUMvQixJQUFJO0FBQUEsUUFBSyxLQUFLLEtBQUssR0FBRztBQUFBLElBQ3hCO0FBQUEsSUFDQSxNQUFNO0FBQUEsRUFHUixPQUFPO0FBQUE7QUFHVCxlQUFlLGNBQWMsQ0FBQyxLQUFxQztBQUFBLEVBQ2pFLElBQUk7QUFBQSxJQUNGLE1BQU0sT0FBTyxNQUFNLFFBQVEsQ0FBQyxVQUFVLGdCQUFnQixNQUFNLE9BQU8sR0FBRyxHQUFHLE1BQU0sSUFBSSxHQUFHO0FBQUEsTUFDcEYsT0FBTyxDQUFDLFVBQVUsUUFBUSxRQUFRO0FBQUEsSUFDcEMsQ0FBQztBQUFBLElBQ0QsTUFBTSxTQUFtQixDQUFDO0FBQUEsSUFDMUIsS0FBSyxRQUFRLEdBQUcsUUFBUSxDQUFDLE1BQU0sT0FBTyxLQUFLLENBQVcsQ0FBQztBQUFBLElBQ3ZELE1BQU0sSUFBSSxRQUFjLENBQUMsTUFBTSxLQUFLLEdBQUcsUUFBUSxNQUFNLEVBQUUsQ0FBQyxDQUFDO0FBQUEsSUFFekQsTUFBTSxTQUFTLE9BQU8sT0FBTyxNQUFNLEVBQ2hDLFNBQVMsT0FBTyxFQUNoQixNQUFNLG9CQUFvQixJQUFJO0FBQUEsSUFDakMsT0FBTyxXQUFXLFlBQVksT0FBTyxTQUFTLFFBQVEsRUFBRTtBQUFBLElBQ3hELE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBO0FBTVgsZUFBc0IsY0FBYyxDQUFDLEtBT2xDO0FBQUEsRUFDRCxNQUFNLE9BQU8sTUFBTSxlQUFlLEdBQUc7QUFBQSxFQUNyQyxJQUFJLENBQUM7QUFBQSxJQUFNLE9BQU8sRUFBRSxLQUFLLE1BQU0sTUFBTSxRQUFRLFdBQVcsVUFBVSxNQUFNO0FBQUEsRUFDeEUsSUFBSSxPQUF3QjtBQUFBLEVBQzVCLElBQUk7QUFBQSxJQUNGLE1BQU0sTUFBTSxNQUFNLE1BQU0sb0JBQW9CLFNBQVM7QUFBQSxNQUNuRCxRQUFRLFlBQVksUUFBUSxHQUFHO0FBQUEsSUFDakMsQ0FBQztBQUFBLElBQ0QsSUFBSSxJQUFJO0FBQUEsTUFBSSxPQUFRLE1BQU0sSUFBSSxLQUFLO0FBQUEsSUFDbkMsTUFBTTtBQUFBLEVBQ1IsSUFBSSxDQUFDO0FBQUEsSUFBTSxPQUFPLEVBQUUsS0FBSyxNQUFNLFFBQVEsZ0JBQWdCLFVBQVUsTUFBTTtBQUFBLEVBQ3ZFLE1BQU0sT0FBTyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxPQUFPO0FBQUEsRUFDWCxJQUFJO0FBQUEsSUFDRixNQUFNLEtBQUssYUFBYSxLQUFLLE1BQU0sYUFBYSxHQUFHLE9BQU8sRUFBRSxLQUFLO0FBQUEsSUFDakUsTUFBTSxLQUFLLGFBQWEsS0FBSyxNQUFNLFlBQVksR0FBRyxPQUFPLEVBQUUsS0FBSztBQUFBLElBQ2hFLE9BQU8sT0FBTyxPQUFPLElBQUksS0FBSyxPQUFPLE9BQU8sR0FBRztBQUFBLElBQy9DLE1BQU07QUFBQSxFQUNSLE9BQU8sT0FDSDtBQUFBLElBQ0U7QUFBQSxJQUNBO0FBQUEsSUFDQTtBQUFBLElBQ0EsU0FBUyxLQUFLLFdBQVc7QUFBQSxJQUN6QixRQUFRO0FBQUEsSUFDUixVQUFVO0FBQUEsRUFDWixJQUNBO0FBQUEsSUFDRTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxTQUFTLEtBQUssV0FBVztBQUFBLElBQ3pCLFFBQVE7QUFBQSxJQUNSLFVBQVU7QUFBQSxFQUNaO0FBQUE7QUFHTixlQUFlLE9BQU8sQ0FBQyxNQUE2QztBQUFBLEVBQ2xFLE1BQU0sV0FBVyxNQUFNLGVBQWU7QUFBQSxFQUN0QyxJQUFJLFVBQXlCO0FBQUEsRUFDN0IsSUFBSSxVQUFVO0FBQUEsSUFDWixJQUFJO0FBQUEsTUFDRixXQUFXLE1BQU0sSUFBYyxVQUFVLE9BQU8sR0FBRyxHQUFHLE1BQU0sT0FBTztBQUFBLE1BQ25FLE1BQU07QUFBQSxFQUNWO0FBQUEsRUFDQSxNQUFNLE9BQU8sTUFBTSx3QkFBd0I7QUFBQSxFQUMzQyxNQUFNLE9BQWtCLENBQUMsR0FDdkIsU0FBb0IsQ0FBQyxHQUNyQixVQUFxQixDQUFDO0FBQUEsRUFDeEIsV0FBVyxPQUFPLE1BQU07QUFBQSxJQUN0QixNQUFNLElBQUksTUFBTSxlQUFlLEdBQUc7QUFBQSxJQUNsQyxNQUFNLFNBQVMsUUFBUTtBQUFBLElBQ3ZCLE1BQU0sYUFDSixDQUFDLFdBQVcsRUFBRSxZQUFhLEVBQUUsV0FBVyxrQkFBa0IsS0FBSyxVQUFVO0FBQUEsSUFDM0UsSUFBSSxDQUFDLFlBQVk7QUFBQSxNQUNmLEtBQUssS0FBSyxDQUFDO0FBQUEsTUFDWDtBQUFBLElBQ0Y7QUFBQSxJQUNBLElBQUksS0FBSyxRQUFRO0FBQUEsTUFDZixRQUFRLEtBQUssS0FBSyxHQUFHLE1BQU0sVUFBVSxDQUFDO0FBQUEsTUFDdEM7QUFBQSxJQUNGO0FBQUEsSUFDQSxJQUFJO0FBQUEsTUFDRixRQUFRLEtBQUssS0FBSyxTQUFTO0FBQUEsTUFDM0IsT0FBTyxLQUFLLENBQUM7QUFBQSxNQUNiLE1BQU07QUFBQSxNQUNOLFFBQVEsS0FBSyxLQUFLLEdBQUcsTUFBTSxjQUFjLENBQUM7QUFBQTtBQUFBLEVBRTlDO0FBQUEsRUFDQSxXQUFVLEVBQUUsSUFBSSxNQUFNLFNBQVMsQ0FBQyxDQUFDLEtBQUssUUFBUSxNQUFNLFFBQVEsUUFBUSxDQUFDO0FBQUE7QUFnQnZFLElBQU0saUJBQWlCO0FBQ3ZCLFNBQVMsbUJBQW1CLENBQUMsTUFBdUI7QUFBQSxFQUNsRCxPQUFPLGVBQWUsS0FBSyxJQUFJO0FBQUE7QUFjakMsSUFBTSxvQkFBb0I7QUFDbkIsU0FBUyxlQUFlLENBQUMsTUFBdUI7QUFBQSxFQUNyRCxPQUFPLGtCQUFrQixLQUFLLElBQUk7QUFBQTtBQTJCcEMsSUFBTSxjQUFjO0FBQUEsRUFDbEIsSUFBSSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3JCLGFBQWEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUM5QixVQUFVLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDM0IsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixlQUFlLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDaEMsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLEtBQUssRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN2QixXQUFXLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDN0IsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLE9BQU8sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN6QixjQUFjLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDaEMsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLFNBQVMsRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUMzQixNQUFNLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDeEIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLE9BQU8sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN6QixNQUFNLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDeEIsU0FBUyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQzNCLEtBQUssRUFBRSxNQUFNLFVBQVU7QUFDekI7QUFXQSxJQUFNLGVBQTJCLENBQUMsTUFBTSxNQUFNO0FBb0M5QyxTQUFTLFVBQVUsQ0FBQyxPQUF1QjtBQUFBLEVBQ3pDLE1BQU0sSUFBSSxVQUFVLE9BQU8sRUFBRSxPQUFPLE9BQU8sS0FBSyxFQUFFLENBQUM7QUFBQSxFQUVuRCxJQUFJLENBQUMsRUFBRTtBQUFBLElBQUksS0FBSSxTQUFTLEVBQUUsV0FBVyxPQUFPO0FBQUEsRUFDNUMsT0FBTyxFQUFFO0FBQUE7QUFRWCxTQUFTLFdBQVcsQ0FBQyxNQUFjLE1BQWMsS0FBYyxVQUEwQjtBQUFBLEVBQ3ZGLElBQUksUUFBUTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQzlCLE1BQU0sSUFBSSxPQUFPLEdBQUc7QUFBQSxFQUNwQixJQUFJLENBQUMsT0FBTyxTQUFTLENBQUMsS0FBSyxJQUFJO0FBQUEsSUFDN0IsS0FBSSxHQUFHLFdBQVcsMkNBQTJDLEtBQUssVUFBVSxPQUFPLEdBQUcsQ0FBQyxHQUFHO0FBQUEsRUFDNUYsT0FBTztBQUFBO0FBTVQsZUFBZSxXQUFXLENBQ3hCLE1BQ0EsUUFDQSxPQUNnRDtBQUFBLEVBQ2hELElBQUksTUFBTSxjQUFjO0FBQUEsSUFDdEIsTUFBTSxPQUFPLE1BQU07QUFBQSxJQUNuQixNQUFNLE9BQU8sSUFBSSxLQUFLLElBQUk7QUFBQSxJQUMxQixJQUFJLENBQUUsTUFBTSxLQUFLLE9BQU87QUFBQSxNQUFJLEtBQUksR0FBRyxnQ0FBZ0MsUUFBUSxXQUFXO0FBQUEsSUFDdEYsT0FBTyxFQUFFLE9BQU8sTUFBTSxLQUFLLEtBQUssR0FBRyxRQUFRLE9BQU8sRUFBRSxHQUFHLFlBQVksTUFBTTtBQUFBLEVBQzNFO0FBQUEsRUFDQSxJQUFJLE1BQU0sU0FBVSxPQUFPLFdBQVcsS0FBSyxDQUFDLFFBQVEsTUFBTSxPQUFRO0FBQUEsSUFDaEUsTUFBTSxNQUFnQixDQUFDO0FBQUEsSUFDdkIsaUJBQWlCLFNBQVMsUUFBUTtBQUFBLE1BQU8sSUFBSSxLQUFLLEtBQWU7QUFBQSxJQUNqRSxPQUFPO0FBQUEsTUFDTCxNQUFNLE9BQU8sT0FBTyxHQUFHLEVBQUUsU0FBUyxPQUFPLEVBQUUsUUFBUSxPQUFPLEVBQUU7QUFBQSxNQUM1RCxZQUFZO0FBQUEsSUFDZDtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE9BQU8sRUFBRSxNQUFNLE9BQU8sS0FBSyxHQUFHLEdBQUcsWUFBWSxLQUFLO0FBQUE7QUFNcEQsU0FBUyxTQUFTLENBQUMsTUFBMkIsTUFBYyxZQUFxQixPQUFnQjtBQUFBLEVBQy9GLElBQUksQ0FBQyxTQUFTLG9CQUFvQixJQUFJLEdBQUc7QUFBQSxJQUN2QyxLQUNFLEdBQUcseUVBQ0Qsb0VBQ0Esd0RBQ0o7QUFBQSxFQUNGO0FBQUEsRUFDQSxJQUFJLGNBQWMsZ0JBQWdCLElBQUksR0FBRztBQUFBLElBQ3ZDLFFBQVEsT0FBTyxNQUNiLDJGQUNFLDBFQUNBO0FBQUEsQ0FDSjtBQUFBLEVBQ0Y7QUFBQTtBQVlGLElBQU0sbUJBQW1CLENBQUMsU0FDeEIsS0FBSSxHQUFHLDJCQUEyQixTQUFTO0FBQUEsRUFDekMsTUFBTSxRQUFRLGFBQWEsSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQUUsS0FBSyxHQUFHO0FBQUEsRUFDeEQsU0FBUyxhQUFhLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRztBQUMzQyxDQUFDO0FBT0gsSUFBTSxPQUFjO0FBQUEsRUFDbEI7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxTQUFTLE9BQU87QUFBQSxJQUN4QixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5QyxLQUFLLE9BQU8sWUFBWSxVQUFVO0FBQUEsTUFDaEMsTUFBTSxRQUFRLFdBQVcsSUFBSTtBQUFBLFFBQzNCLE9BQU8sTUFBTTtBQUFBLFFBQ2IsTUFBTSxhQUFhLEtBQUs7QUFBQSxRQUN4QixPQUFPLE1BQU0sVUFBVTtBQUFBLE1BQ3pCLENBQUM7QUFBQTtBQUFBLEVBRUw7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUM7QUFBQSxJQUNSLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLE1BQy9CLEVBQUUsTUFBTSxRQUFRLFVBQVUsT0FBTyxVQUFVLEtBQUs7QUFBQSxJQUNsRDtBQUFBLElBQ0EsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLE1BQU0sU0FDSixXQUFXLElBQ1gsV0FBVyxTQUFTLElBQUksV0FBVyxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsSUFBSSxXQUN4RCxhQUFhLEtBQUssQ0FDcEI7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUM7QUFBQSxJQUNSLGFBQWEsQ0FBQztBQUFBLElBQ2QsS0FBSyxZQUFZO0FBQUEsTUFDZixNQUFNLFFBQVE7QUFBQTtBQUFBLEVBRWxCO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLGFBQWEsU0FBUyxTQUFTLFdBQVcsU0FBUyxhQUFhO0FBQUEsSUFDeEUsYUFBYTtBQUFBLE1BQ1gsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLO0FBQUEsTUFDL0IsRUFBRSxNQUFNLFFBQVEsVUFBVSxPQUFPLFVBQVUsS0FBSztBQUFBLElBQ2xEO0FBQUEsSUFDQSxLQUFLLE9BQU8sWUFBWSxVQUFVO0FBQUEsTUFDaEMsTUFBTSxPQUFPLFdBQVc7QUFBQSxNQUN4QixNQUFNLE9BQU8sYUFBYSxLQUFLO0FBQUEsTUFDL0IsUUFBUSxNQUFNLGVBQWUsTUFBTSxZQUFZLFFBQVEsV0FBVyxNQUFNLENBQUMsR0FBRyxLQUFLO0FBQUEsTUFDakYsSUFBSSxDQUFDO0FBQUEsUUFBTSxpQkFBaUIsTUFBTTtBQUFBLE1BQ2xDLFVBQVUsUUFBUSxNQUFNLFlBQVksQ0FBQyxDQUFDLE1BQU0sS0FBSztBQUFBLE1BQ2pELE1BQU0sUUFBUSxNQUFNLE1BQWdCLE1BQU07QUFBQSxRQUN4QyxPQUFPLENBQUMsQ0FBQyxNQUFNO0FBQUEsUUFDZixTQUFTLENBQUMsQ0FBQyxNQUFNO0FBQUEsUUFDakIsV0FBVyxNQUFNLGlCQUNiLFlBQVksUUFBUSxlQUFlLE1BQU0sZ0JBQWdCLENBQUMsSUFDMUQ7QUFBQSxNQUNOLENBQUM7QUFBQTtBQUFBLEVBRUw7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsYUFBYSxTQUFTLFNBQVMsU0FBUyxVQUFVO0FBQUEsSUFDMUQsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsT0FBTyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQy9ELEtBQUssT0FBTyxZQUFZLFVBQVU7QUFBQSxNQUNoQyxNQUFNLE9BQU8sYUFBYSxLQUFLO0FBQUEsTUFDL0IsUUFBUSxNQUFNLGVBQWUsTUFBTSxZQUFZLFlBQVksWUFBWSxLQUFLO0FBQUEsTUFDNUUsSUFBSSxDQUFDO0FBQUEsUUFBTSxpQkFBaUIsVUFBVTtBQUFBLE1BQ3RDLFVBQVUsWUFBWSxNQUFNLFlBQVksQ0FBQyxDQUFDLE1BQU0sS0FBSztBQUFBLE1BQ3JELE1BQU0sV0FBVyxNQUFNLFdBQ2xCLE1BQU0sU0FDSixNQUFNLEdBQUcsRUFDVCxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUNuQixPQUFPLE9BQU8sSUFDakI7QUFBQSxNQUNKLE1BQU0sWUFBWSxNQUFnQixNQUFNLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQyxNQUFNLE1BQU0sQ0FBQztBQUFBO0FBQUEsRUFFOUU7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsU0FBUyxRQUFRO0FBQUEsSUFDekIsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLE1BQU0sUUFBUSxZQUFZLFFBQVEsU0FBUyxNQUFNLE9BQU8sQ0FBQztBQUFBLE1BQ3pELE1BQU0sUUFBUSxXQUFXLElBQUksT0FBTyxFQUFFLFFBQVEsTUFBTSxPQUE2QixDQUFDO0FBQUE7QUFBQSxFQUV0RjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxPQUFPO0FBQUEsSUFDZixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5QyxLQUFLLE9BQU8sWUFBWSxVQUFVO0FBQUEsTUFDaEMsTUFBTSxVQUFVLFdBQVcsSUFBSSxFQUFFLE9BQU8sQ0FBQyxDQUFDLE1BQU0sTUFBTSxDQUFDO0FBQUE7QUFBQSxFQUUzRDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxNQUFNO0FBQUEsSUFDZCxhQUFhO0FBQUEsTUFDWCxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUs7QUFBQSxNQUMvQixFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUs7QUFBQSxJQUMvQjtBQUFBLElBQ0EsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLE1BQU0sS0FBSyxXQUFXLEtBQUssU0FBUyxXQUFXLElBQUksRUFBRSxJQUFJO0FBQUEsTUFDekQsTUFBTSxRQUFRLFdBQVcsSUFBSSxJQUFJLEVBQUUsTUFBTSxDQUFDLENBQUMsTUFBTSxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRTNEO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLFNBQVMsU0FBUztBQUFBLElBQzFCLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLEtBQUssT0FBTyxZQUFZLFVBQVU7QUFBQSxNQUNoQyxNQUFNLFFBQVEsWUFBWSxRQUFRLFNBQVMsTUFBTSxPQUFPLENBQUM7QUFBQSxNQUN6RCxNQUFNLFVBQVUsWUFBWSxRQUFRLFdBQVcsTUFBTSxTQUFTLEVBQUU7QUFBQSxNQUNoRSxNQUFNLFFBQVEsV0FBVyxJQUFJLE9BQU8sU0FBUyxhQUFhLEtBQUssQ0FBQztBQUFBO0FBQUEsRUFFcEU7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsS0FBSztBQUFBLElBQ2IsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsTUFBTSxDQUFDO0FBQUEsSUFDL0MsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLElBQUksTUFBTTtBQUFBLFFBQUssTUFBTSxVQUFVO0FBQUEsTUFDMUI7QUFBQSxjQUFNLE9BQU8sV0FBVyxFQUFFO0FBQUE7QUFBQSxFQUVuQztBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQztBQUFBLElBQ1IsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsTUFBTSxDQUFDO0FBQUEsSUFDL0MsS0FBSyxPQUFPLGVBQWU7QUFBQSxNQUN6QixNQUFNLFNBQVMsV0FBVyxFQUFFO0FBQUE7QUFBQSxFQUVoQztBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxTQUFTLGNBQWMsUUFBUSxTQUFTLFFBQVEsS0FBSztBQUFBLElBQzdELGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLEtBQUssT0FBTyxZQUFZLFVBQVU7QUFBQSxNQUNoQyxPQUFPLE1BQU0sUUFBUSxXQUFXLElBQUk7QUFBQSxRQUNsQyxPQUFPLE1BQU0sVUFBVSxZQUFZLFdBQVcsT0FBTyxNQUFNLEtBQUssQ0FBQyxJQUFJO0FBQUEsUUFDckUsV0FBVyxDQUFDLENBQUMsTUFBTTtBQUFBLFFBQ25CLE1BQU0sTUFBTSxTQUFTLFlBQVksWUFBWSxRQUFRLFFBQVEsTUFBTSxNQUFNLENBQUMsSUFBSTtBQUFBLFFBQzlFLElBQUksYUFBYSxLQUFLO0FBQUEsUUFDdEIsT0FBTyxDQUFDLENBQUMsTUFBTTtBQUFBLFFBQ2YsTUFBTSxDQUFDLENBQUMsTUFBTTtBQUFBLFFBQ2QsS0FBSyxlQUFlLE1BQU0sR0FBRztBQUFBLE1BQy9CLENBQUM7QUFBQTtBQUFBLEVBRUw7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsU0FBUztBQUFBLElBQ2pCLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLE1BQy9CLEVBQUUsTUFBTSxXQUFXLFVBQVUsTUFBTSxVQUFVLEtBQUs7QUFBQSxJQUNwRDtBQUFBLElBQ0EsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLE1BQU0sUUFBUSxXQUFXLElBQUksV0FBVyxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsR0FBRztBQUFBLFFBQzFELFNBQVMsQ0FBQyxDQUFDLE1BQU07QUFBQSxRQUNqQixNQUFNLE1BQU07QUFBQSxNQUNkLENBQUM7QUFBQTtBQUFBLEVBRUw7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUM7QUFBQSxJQUNSLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLEtBQUssT0FBTyxlQUFlO0FBQUEsTUFDekIsTUFBTSxTQUFTLFdBQVcsRUFBRTtBQUFBO0FBQUEsRUFFaEM7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsT0FBTztBQUFBLElBQ2YsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLE1BQU0sU0FBUyxXQUFXLElBQUksRUFBRSxPQUFPLE1BQU0sVUFBVSxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRWpFO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLE1BQU07QUFBQSxJQUNkLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLE1BQy9CLEVBQUUsTUFBTSxNQUFNLFVBQVUsS0FBSztBQUFBLE1BQzdCLEVBQUUsTUFBTSxlQUFlLFVBQVUsTUFBTSxVQUFVLEtBQUs7QUFBQSxJQUN4RDtBQUFBLElBQ0EsS0FBSyxPQUFPLFlBQVksVUFBVTtBQUFBLE1BQ2hDLE1BQU0sUUFDSixXQUFXLElBR1gsV0FBVyxPQUFPLFlBQVksT0FBTyxNQUFNLFNBQVMsV0FBVyxJQUFJLEVBQUUsR0FDckUsV0FBVyxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUcsR0FDNUIsYUFBYSxLQUFLLEtBQUssaUJBQWlCLE1BQU0sR0FDOUMsRUFBRSxNQUFNLE1BQU0sS0FBMkIsQ0FDM0M7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsYUFBYTtBQUFBLE1BQ1gsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLO0FBQUEsTUFDL0IsRUFBRSxNQUFNLE1BQU0sVUFBVSxLQUFLO0FBQUEsSUFDL0I7QUFBQSxJQUNBLEtBQUssT0FBTyxZQUFZLFVBQVU7QUFBQSxNQUNoQyxNQUFNLFFBQ0osV0FBVyxJQUdYLFdBQVcsT0FBTyxZQUFZLE9BQU8sTUFBTSxTQUFTLFdBQVcsSUFBSSxFQUFFLEdBQ3JFLFFBQ0EsYUFBYSxLQUFLLEtBQUssaUJBQWlCLFFBQVEsR0FDaEQsRUFBRSxNQUFNLE1BQU0sS0FBMkIsQ0FDM0M7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUM7QUFBQSxJQUNSLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLEtBQUssT0FBTyxZQUFZLFVBQVU7QUFBQSxNQUNoQyxNQUFNLFdBQVcsV0FBVyxJQUFJLE9BQU8sYUFBYSxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRTlEO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDO0FBQUEsSUFDUixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5QyxLQUFLLE9BQU8sWUFBWSxVQUFVO0FBQUEsTUFDaEMsTUFBTSxXQUFXLFdBQVcsSUFBSSxNQUFNLGFBQWEsS0FBSyxDQUFDO0FBQUE7QUFBQSxFQUU3RDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLFNBQVMsQ0FBQyxJQUFJO0FBQUEsSUFDZCxPQUFPLENBQUM7QUFBQSxJQUNSLGFBQWEsQ0FBQztBQUFBLElBQ2QsS0FBSyxZQUFZO0FBQUEsTUFDZixNQUFNLFNBQVM7QUFBQTtBQUFBLEVBRW5CO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLFNBQVMsS0FBSztBQUFBLElBQ3RCLGFBQWEsQ0FBQztBQUFBLElBQ2QsS0FBSyxPQUFPLGFBQWEsVUFBVTtBQUFBLE1BQ2pDLE1BQU0sV0FBVyxFQUFFLE9BQU8sQ0FBQyxDQUFDLE1BQU0sU0FBUyxDQUFDLENBQUMsTUFBTSxJQUFJLENBQUM7QUFBQTtBQUFBLEVBRTVEO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLFNBQVMsS0FBSztBQUFBLElBQ3RCLGFBQWEsQ0FBQztBQUFBLElBQ2QsS0FBSyxPQUFPLGFBQWEsVUFBVTtBQUFBLE1BQ2pDLE1BQU0sUUFBUSxFQUFFLE9BQU8sTUFBTSxVQUFVLFFBQVEsTUFBTSxRQUFRLEtBQUssQ0FBQztBQUFBO0FBQUEsRUFFdkU7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsTUFBTTtBQUFBLElBQ2QsYUFBYSxDQUFDO0FBQUEsSUFDZCxLQUFLLE9BQU8sYUFBYSxVQUFVO0FBQUEsTUFDakMsTUFBTSxRQUFRO0FBQUEsUUFDWixhQUNFLE1BQU0sU0FBUyxZQUFZLFlBQVksUUFBUSxRQUFRLE1BQU0sTUFBTSxDQUFDLElBQUk7QUFBQSxNQUM1RSxDQUFDO0FBQUE7QUFBQSxFQUVMO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDO0FBQUEsSUFDUixhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxNQUFNLENBQUM7QUFBQSxJQUMvQyxLQUFLLE9BQU8sZUFBZTtBQUFBLE1BQ3pCLE1BQU0sU0FBUyxXQUFXLEVBQUU7QUFBQTtBQUFBLEVBRWhDO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sU0FBUyxDQUFDLE9BQU87QUFBQSxJQUNqQixPQUFPLENBQUMsU0FBUyxTQUFTO0FBQUEsSUFDMUIsYUFBYSxDQUFDO0FBQUEsSUFDZCxLQUFLLE9BQU8sYUFBYSxVQUFVO0FBQUEsTUFDakMsTUFBTSxRQUFRLEVBQUUsT0FBTyxNQUFNLFVBQVUsTUFBTSxRQUFRLE1BQU0sZUFBZSxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRXBGO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDO0FBQUEsSUFDUixhQUFhLENBQUM7QUFBQSxJQUNkLEtBQUssWUFBWTtBQUFBLE1BQ2YsTUFBTSxRQUFRO0FBQUE7QUFBQSxFQUVsQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQztBQUFBLElBQ1IsYUFBYSxDQUFDO0FBQUEsSUFDZCxLQUFLLFlBQVk7QUFBQSxNQUNmLE1BQU0sVUFBVTtBQUFBO0FBQUEsRUFFcEI7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsT0FBTztBQUFBLElBQ2YsYUFBYSxDQUFDO0FBQUEsSUFDZCxLQUFLLENBQUMsYUFBYSxVQUFVO0FBQUEsTUFRM0IsSUFBSSxtQkFBbUI7QUFBQSxRQUNyQixLQUFJLHlEQUFvRCxVQUFVO0FBQUEsTUFDcEUsSUFBSSxNQUFNLFVBQVU7QUFBQSxRQUFNLFFBQVEsT0FBTyxNQUFNLGNBQWM7QUFBQSxDQUFrQjtBQUFBLE1BQzFFO0FBQUEsbUJBQVUsRUFBRSxNQUFNLGFBQWEsU0FBUyxlQUFlLENBQUM7QUFBQTtBQUFBLEVBRWpFO0FBQ0Y7QUFJQSxJQUFNLFlBQ0o7QUFJRixJQUFNLEtBQ0osQ0FBQyxNQUNELENBQUMsUUFDQyxFQUFFLElBQUksS0FBSyxJQUFJLEtBQWM7QUE0QjFCLElBQU0sTUFBTSxVQUFVO0FBQUEsRUFDM0IsTUFBTTtBQUFBLEVBQ04sU0FBUztBQUFBLEVBQ1QsVUFBVSxLQUFLLElBQUksQ0FBQyxPQUFPO0FBQUEsT0FDdEI7QUFBQSxJQUNILFVBQVU7QUFBQSxJQUNWLEtBQUssR0FBRyxFQUFFLEdBQUc7QUFBQSxPQUNULEVBQUUsU0FBUyxVQUFVLEVBQUUsU0FBUyxhQUFhLEVBQUUsWUFBWSxVQUFVLElBQUksQ0FBQztBQUFBLEVBQ2hGLEVBQUU7QUFBQSxFQUVGLGFBQWE7QUFBQSxFQUViLFNBQVMsT0FBTyxFQUFFLE1BQU0sYUFBYSxTQUFTLGtCQUFrQixVQUFVO0FBQUEsRUFDMUUsTUFBTTtBQUNSLENBQUM7QUFFRCxTQUFTLFFBQVEsR0FBVztBQUFBLEVBQzFCLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSx3Q0FVK0I7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUF3RHhDLGVBQWUsSUFBSSxDQUFDLE1BQWlDO0FBQUEsRUFDbkQsSUFBSTtBQUFBLElBQ0YsT0FBTyxNQUFNLElBQUksU0FBUyxJQUFJO0FBQUEsSUFDOUIsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQU8sZUFBZSxDQUFDO0FBQUEsSUFDN0IsSUFBSSxTQUFTO0FBQUEsTUFBTSxPQUFPO0FBQUEsSUFDMUIsTUFBTTtBQUFBO0FBQUE7QUFlVixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJEODNDNUE5QzM4REM4QTY0NjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
