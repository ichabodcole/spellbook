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

//# debugId=0D68AA74DE98258164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dyYXBldmluZS9iYWNrZW5kL2NsaS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2NsaS9yZWdpc3RyeS50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvZ3JhcGV2aW5lL2JhY2tlbmQvaGVhcnRiZWF0LnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuXG4vLyBncmFwZXZpbmUgQ0xJIOKAlCB0aGluIHdyYXBwZXIgYXJvdW5kIHRoZSBkYWVtb24ncyBIVFRQIHN1cmZhY2UuXG4vL1xuLy8gVXNhZ2U6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiA8bmFtZT5cbi8vICAgYnVuIGNsaS50cyBsaXN0XG4vLyAgIGJ1biBjbGkudHMgc2VuZCA8bmFtZT4gLS1mcm9tIDxhbGlhcz4gPHRleHQuLi4+XG4vLyAgIGJ1biBjbGkudHMgdGFpbCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dXG4vLyAgIGJ1biBjbGkudHMgcmVhZCA8bmFtZT4gPGlkPiBbLS10ZXh0XVxuLy8gICBidW4gY2xpLnRzIGNsb3NlIDxuYW1lPlxuLy8gICBidW4gY2xpLnRzIHN0b3Bcbi8vICAgYnVuIGNsaS50cyBpbmZvXG4vL1xuLy8gYHRhaWxgIHdyaXRlcyBlYWNoIGluY29taW5nIG1lc3NhZ2UgYXMgb25lIEpTT05MIGxpbmUgb24gc3Rkb3V0LiBQaXBlXG4vLyBvciB3cmFwIHdpdGggTW9uaXRvci5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHVubGlua1N5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyB0eXBlIENvbW1hbmRTcGVjLCBkZWZpbmVDbGksIHR5cGUgSW52b2NhdGlvbiB9IGZyb20gXCIuLi8uLi9raXQvY2xpL3JlZ2lzdHJ5LnRzXCI7XG5pbXBvcnQge1xuICB0eXBlIEVyckV4dHJhLFxuICB0eXBlIEVycktpbmQsXG4gIGRpZSBhcyByYWlzZSxcbiAgcmVwb3J0Q2xpRXJyb3IsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnMudHNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRMaW5lLFxuICByZWFkU2luY2UsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZi50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TIH0gZnJvbSBcIi4vaGVhcnRiZWF0LnRzXCI7XG5cbmNvbnN0IERBVEFfRElSID0gcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLmdyYXBldmluZVwiKTtcbmNvbnN0IFBPUlRfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBvcnRcIik7XG5jb25zdCBQSURfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLnBpZFwiKTtcbmNvbnN0IEhPTERfRklMRSA9IGpvaW4oREFUQV9ESVIsIFwiZGFlbW9uLmhvbGRcIik7XG4vLyBQZXJzaXN0ZWQgaWRlbnRpdHkgY29uZmlnIChWMS43KSDigJQgYGdyYXBldmluZSBhbGlhcyA8bmFtZT5gIHdyaXRlcyBpdDsgdGhlXG4vLyBkYWVtb24gc2VydmVzIGl0IHRvIHRoZSB3YXRjaCB2aWEgR0VUIC9pZGVudGl0eS5cbmNvbnN0IENPTkZJR19GSUxFID0gam9pbihEQVRBX0RJUiwgXCJjb25maWcuanNvblwiKTtcbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKGZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG4vLyDim5QgVVAgQU5EIEJBQ0sgRE9XTiwgTkVWRVIgQSBGTEFUIFNJQkxJTkcgKHBsYXlib29rIEI0KS4gVGhpcyByZWFkXG4vLyBgam9pbihTQ1JJUFRfRElSLCBcImRhZW1vbi50c1wiKWAg4oCUIGdsYW1vdXIncyBleGFjdCBzaGlwcGVkIGRlZmVjdCDigJQgd2hpY2ggd2FzXG4vLyB0cnVlIGZvciBleGFjdGx5IGFzIGxvbmcgYXMgdGhlIENMSSBhbmQgdGhlIGRhZW1vbiBzaGFyZWQgYSBmb2xkZXIuIEZyb21cbi8vIGBkaXN0L2AgdGhhdCByZXNvbHZlcyB0byBgZGlzdC9kYWVtb24udHNgLCBhIGZpbGUgdGhhdCBkb2VzIG5vdCBhbmQgbXVzdCBub3Rcbi8vIGV4aXN0LiBUaGUgc3ltcHRvbSBpcyBub3QgYSBjcmFzaDogdGhlIHNwYXduIGZhaWxzIHNpbGVudGx5ICh0aGUgZGFlbW9uJ3Ncbi8vIHN0ZGlvIGlzIGlnbm9yZWQpLCBubyBwb3J0IGZpbGUgZXZlciBhcHBlYXJzLCBhbmQgdGhlIDMgcyBwb2xsIGxvb3AgYmVsb3dcbi8vIHJlcG9ydHMgYGRhZW1vbiBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzYCDigJQgd2hpY2ggaXMgQUxTTyB3aGF0IGEgbGF1bmNoZXJcbi8vIHRoYXQgZXhpdHMgYSBsaXZlIGRhZW1vbiByZXBvcnRzIChENjkpIGFuZCBBTFNPIHdoYXQgYSBkZXYtbW9kZSBkYWVtb24gZHlpbmdcbi8vIGF0IGl0cyBzdXJmYWNlIGltcG9ydCByZXBvcnRzIChzZWUgYGVuc3VyZURhZW1vbmApLiBUaHJlZSBkZWZlY3QgY2xhc3Nlcywgb25lXG4vLyBzZW50ZW5jZTsgdGhpcyBpcyB0aGUgZmlyc3Qgb2YgdGhlIHRocmVlLlxuLy8gYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByZXNvbHZlcyB0aGlzIGFyaXRobWV0aWMgdGhlIHdheSB0aGVcbi8vIHJ1bnRpbWUgd2lsbCwgZnJvbSB0aGUgRU1JVFRFRCBmaWxlJ3Mgb3duIGRpcmVjdG9yeSwgYW5kIGFzc2VydHMgdGhlIGZpbGUgaXNcbi8vIHRoZXJlLlxuY29uc3QgREFFTU9OX1NDUklQVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcInNjcmlwdHNcIiwgXCJkYWVtb24udHNcIik7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbi8vIFRoZSB3YXRjaCBzdXJmYWNlIGlzIGJ1aWx0IChzcmMvZ3JhcGV2aW5lL3N1cmZhY2Ug4oaSIGRpc3QvKS4gQnVuIHJlYWRzXG4vLyBidW5maWcudG9tbCAodGhlIFRhaWx3aW5kIHBsdWdpbikgZnJvbSBjd2QgT05MWSwgc28gaW4gREVWIG1vZGUgdGhlIGRhZW1vbidzXG4vLyBjd2QgTVVTVCBiZSBzcmMvZ3JhcGV2aW5lLyAoc2VhbXMgQ29udHJhY3QgNSkg4oCUIGxhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IGFuZCB0aGUgcGFnZSBmYWlscyAobWVhc3VyZWQgb25cbi8vIGdsYW1vdXI6IEhUVFAgNTAwLCBubyBzdHlsZXNoZWV0IGxpbmspLiBJbiBSRUxFQVNFIG1vZGUgZGlzdC8gaXMgc3RhdGljIGFuZFxuLy8gcHJlLWJ1aWx0LCBubyBidW5maWcgaXMgcmVhZCwgYW5kIHNyYy9ncmFwZXZpbmUvIG5lZWQgbm90IGV4aXN0IGF0IGFsbCAoYVxuLy8gc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSDigJQgc28gdGhlIGN3ZCBzdGF5cyBhdFxuLy8gdGhlIHNraWxsIHJvb3QuIFNhbWUgc2hhcGUgYXMgZ2xhbW91cidzIGRhZW1vbkN3ZCgpLiBFeHBvcnRlZCBmb3IgdGVzdHMuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ3JhcGV2aW5lXCIpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gSFRUUCBwcm90b2NvbCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFJlc3BvbnNlIHNoYXBlcyB0aGUgZGFlbW9uIGVtaXRzLiBBbnkgZW5kcG9pbnQgY2FuIGFsc28gcmV0dXJuIGFuIGVycm9yXG4vLyBib2R5IHdpdGggYSA0eHgvNXh4IHN0YXR1cywgc28gZWFjaCBjYXJyaWVzIGFuIG9wdGlvbmFsIGBlcnJvcmAuXG5cbnR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IG51bWJlcjtcbiAgY2hhbm5lbDogc3RyaW5nO1xuICBmcm9tOiBzdHJpbmc7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAga2luZDogXCJtZXNzYWdlXCIgfCBcInRvcGljXCIgfCBcImFubm91bmNlbWVudFwiIHwgXCJzdGF0dXNcIjtcbiAgaW5fcmVwbHlfdG8/OiBudW1iZXI7XG4gIHRhcmdldD86IG51bWJlcjtcbiAgZGlzcG9zaXRpb24/OiBzdHJpbmc7XG4gIC8vIENoYW5uZWwtbGV2ZWwgbGlmZWN5Y2xlIGZhY3QgKGFyY2hpdmUgLyB1bmFyY2hpdmUpLiBBIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZVxuICAvLyBjYXJyeWluZyBgZXZlbnRgIGFuZCBubyBgZGlzcG9zaXRpb25gIOKAlCBzZWUgaXNEaXNwb3NpdGlvbkZyYW1lLlxuICBldmVudD86IFwiYXJjaGl2ZWRcIiB8IFwidW5hcmNoaXZlZFwiO1xufTtcblxuLy8gR0VUIC8g4oCUIGRhZW1vbiBsaXZlbmVzcy9pbmZvLlxudHlwZSBSb290SW5mbyA9IHtcbiAgb2s/OiBib29sZWFuO1xuICBwaWQ/OiBudW1iZXI7XG4gIHN0YXJ0ZWRfYXQ/OiBudW1iZXI7XG4gIGNoYW5uZWxzPzogbnVtYmVyO1xuICBkYXRhX2Rpcj86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIOKAlCBtZXNzYWdlIHJlY2VpcHQgd2l0aCBkZWxpdmVyeSBhY2NvdW50aW5nLlxudHlwZSBTZW5kUmVjZWlwdCA9IE1lc3NhZ2UgJiB7XG4gIHN1YnNjcmliZXJzPzogbnVtYmVyO1xuICByZWNpcGllbnRzPzogbnVtYmVyO1xuICBzdWJzY3JpYmVyX2FsaWFzZXM/OiBzdHJpbmdbXTtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBQT1NUIC9hbm5vdW5jZSDigJQgY3Jvc3MtY2hhbm5lbCBicm9hZGNhc3QgcmVjZWlwdC5cbnR5cGUgQW5ub3VuY2VSZWNlaXB0ID0ge1xuICBvazogYm9vbGVhbjtcbiAgY2hhbm5lbHM6IHsgbmFtZTogc3RyaW5nOyByZWNpcGllbnRzOiBudW1iZXIgfVtdO1xuICBza2lwcGVkOiB7IG5hbWU6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfVtdO1xuICB0b3RhbF9yZWNpcGllbnRzOiBudW1iZXI7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gR0VUIC9jaGFubmVscyDigJQgY2hhbm5lbCBkaXJlY3RvcnkgbGlzdGluZy5cbnR5cGUgQ2hhbm5lbFN1bW1hcnkgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IG51bWJlcjtcbiAgLy8gbnVsbCA9IHRoZSBkYWVtb24gY291bGQgbm90IGVzdGFibGlzaCBhIGNvdW50ICh1bnJlYWRhYmxlIGZpbGUpLCBORVZFUiAwLlxuICAvLyAwIG1lYW5zIFwidGhpcyBjaGFubmVsIGlzIGdlbnVpbmVseSBlbXB0eVwiIGFuZCBub3RoaW5nIGVsc2Ug4oCUIGI1LlxuICBtZXNzYWdlX2NvdW50OiBudW1iZXIgfCBudWxsO1xuICBsYXN0X2FjdGl2aXR5OiBudW1iZXI7XG4gIGxvYWRlZDogYm9vbGVhbjtcbn07XG50eXBlIENoYW5uZWxzUmVzcG9uc2UgPSB7IGNoYW5uZWxzPzogQ2hhbm5lbFN1bW1hcnlbXTsgZXJyb3I/OiBzdHJpbmcgfTtcblxuLy8gQW55IGVuZHBvaW50IG1heSByZXBseSB3aXRoIGp1c3QgYW4gZXJyb3Ivb2sgZW52ZWxvcGUuXG50eXBlIFN0YXR1c1Jlc3BvbnNlID0geyBvaz86IGJvb2xlYW47IGVycm9yPzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L21lc3NhZ2VzIGFuZCA/c2luY2U9IHJhbmdlcy5cbnR5cGUgTWVzc2FnZXNSZXNwb25zZSA9IHsgbWVzc2FnZXM/OiBNZXNzYWdlW107IGVycm9yPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nIH07XG5cbi8vIEdFVCAvY2hhbm5lbHMvPG5hbWU+L3dhaXQg4oCUIGxvbmctcG9sbCBiYXRjaC5cbnR5cGUgV2FpdFJlc3BvbnNlID0ge1xuICBtZXNzYWdlcz86IE1lc3NhZ2VbXTtcbiAgY3Vyc29yPzogbnVtYmVyO1xuICB0aW1lZF9vdXQ/OiBib29sZWFuO1xuICBlcnJvcj86IHN0cmluZztcbiAgLy8gQSByZWZ1c2FsIG5hbWVzIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0ICg0MDQgb24gYSBtaXNzaW5nIGNoYW5uZWwpLlxuICBoaW50Pzogc3RyaW5nO1xufTtcblxuLy8gUE9TVCAvY2hhbm5lbHMg4oCUIG9wZW4vZW5zdXJlIGEgY2hhbm5lbC5cbnR5cGUgT3BlblJlc3BvbnNlID0ge1xuICBuYW1lPzogc3RyaW5nO1xuICBjcmVhdGVkX2F0PzogbnVtYmVyO1xuICBtZXNzYWdlX2NvdW50PzogbnVtYmVyO1xuICBzdWJzY3JpYmVycz86IG51bWJlcjtcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICB1bmFyY2hpdmVkPzogYm9vbGVhbjtcbiAgY2xlYXJlZD86IGJvb2xlYW47XG4gIHNuYXBzaG90Pzogc3RyaW5nIHwgbnVsbDtcbiAgZXJyb3I/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi90b3BpYyBhbmQgUFVUIC9jaGFubmVscy88bmFtZT4vdG9waWMuXG50eXBlIFRvcGljUmVzcG9uc2UgPSB7XG4gIG9rPzogYm9vbGVhbjtcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xuICBpZD86IG51bWJlcjtcbiAgZXJyb3I/OiBzdHJpbmc7XG4gIGhpbnQ/OiBzdHJpbmc7XG59O1xuXG4vLyBHRVQgL2NoYW5uZWxzLzxuYW1lPi9zdWJzY3JpYmVycyDigJQgc2luZ2xlLWNoYW5uZWwgcm9zdGVyLlxudHlwZSBTdWJzY3JpYmVyc1Jlc3BvbnNlID0ge1xuICBjaGFubmVsPzogc3RyaW5nO1xuICBzdWJzY3JpYmVycz86IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY291bnQ/OiBudW1iZXI7XG4gIGNvbm5lY3Rpb25zPzogbnVtYmVyO1xuICBuYW1lZD86IG51bWJlcjtcbiAgYW5vbnltb3VzPzogbnVtYmVyO1xuICB0b3BpYz86IHN0cmluZyB8IG51bGw7XG4gIGVycm9yPzogc3RyaW5nO1xufTtcblxuLy8gUGVyLWNoYW5uZWwgcHJlc2VuY2UgZW50cnkgZnJvbSBHRVQgL3ByZXNlbmNlLlxudHlwZSBQcmVzZW5jZUNoYW5uZWwgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgc3Vic2NyaWJlcnM6IHN0cmluZ1tdO1xuICBodW1hbnM/OiBzdHJpbmdbXTtcbiAgY29ubmVjdGlvbnM6IG51bWJlcjtcbiAgbmFtZWQ6IG51bWJlcjtcbiAgYW5vbnltb3VzOiBudW1iZXI7XG59O1xudHlwZSBQcmVzZW5jZVJlc3BvbnNlID0geyBjaGFubmVscz86IFByZXNlbmNlQ2hhbm5lbFtdOyBlcnJvcj86IHN0cmluZyB9O1xuXG4vLyBTU0UgZnJhbWVzIHB1c2hlZCBvbiBHRVQgL2NoYW5uZWxzLzxuYW1lPi90YWlsLiBUd28gZnJhbWUga2luZHMgYXJyaXZlIG9uXG4vLyB0aGUgc2FtZSBgZGF0YTpgIGxpbmUg4oCUIGEgYHN1YnNjcmliZWRgIGV2ZW50IGFuZCBwZXItbWVzc2FnZSBmcmFtZXMg4oCUIHNvIHRoZVxuLy8gZGVjb2RlZCBwYXlsb2FkIGlzIGEgdW5pb24uIEFsbCBmaWVsZHMgb3B0aW9uYWwgYmVjYXVzZSB0aGUgZnJhbWUgaXNcbi8vIHVudHJ1c3RlZCB3aXJlIGRhdGEgbmFycm93ZWQgYXQgdGhlIHVzZSBzaXRlLlxudHlwZSBUYWlsUGF5bG9hZCA9IHtcbiAgLy8gc3Vic2NyaWJlZC1ldmVudCBmaWVsZHNcbiAgc2luY2U/OiBudW1iZXI7XG4gIGFzPzogc3RyaW5nIHwgbnVsbDtcbiAgbGF0ZXN0X2lkPzogbnVtYmVyO1xuICAvLyBUcnVlIHdoZW4gVEhJUyBzdWJzY3JpYmUgY3JlYXRlZCB0aGUgY2hhbm5lbCDigJQgdGhlIHNpZ25hbCB0aGF0IHNlcGFyYXRlc1xuICAvLyBcInF1aWV0IGNoYW5uZWxcIiBmcm9tIFwieW91IHRhaWxlZCBhIG5hbWUgdGhhdCBkaWQgbm90IGV4aXN0XCIuXG4gIGNyZWF0ZWQ/OiBib29sZWFuO1xuICAvLyBUcnVlIHdoZW4gdGhlIGNoYW5uZWwgaXMgYWxyZWFkeSBhcmNoaXZlZCAocmVhZC1vbmx5KSBhdCBzdWJzY3JpYmUgdGltZSDigJRcbiAgLy8gdGhlIHNpZ25hbCBmb3IgYSBMQVRFIGpvaW5lciwgd2hvIHdvdWxkIG90aGVyd2lzZSBsZWFybiBpdCBmcm9tIGEgcmVqZWN0ZWRcbiAgLy8gc2VuZC4gVGhlIGxpZmVjeWNsZSBmcmFtZSBvbmx5IHJlYWNoZXMgYW4gYWdlbnQgdGhhdCB3YXMgY29ubmVjdGVkIGF0IHRoZVxuICAvLyBtb21lbnQsIG9yIHRoYXQgcHVsbHMgaGlzdG9yeS5cbiAgYXJjaGl2ZWQ/OiBib29sZWFuO1xuICAvLyBtZXNzYWdlIGZpZWxkc1xuICBpZD86IG51bWJlcjtcbiAgZnJvbT86IHN0cmluZztcbiAgdGV4dD86IHN0cmluZztcbiAgdHM/OiBudW1iZXI7XG4gIGtpbmQ/OiBcIm1lc3NhZ2VcIiB8IFwidG9waWNcIiB8IFwiYW5ub3VuY2VtZW50XCIgfCBcInN0YXR1c1wiO1xuICAvLyBzaGFyZWRcbiAgY2hhbm5lbD86IHN0cmluZztcbiAgdG9waWM/OiBzdHJpbmcgfCBudWxsO1xufTtcblxuLy8gT3VyIHBsdWdpbiB2ZXJzaW9uIChmcm9tIHBsdWdpbi5qc29uKS4gVXNlZCB0byBkZXRlY3QgY2FjaGUtcGlubmluZ1xuLy8gbWlzbWF0Y2hlcyB3aGVuIHdlIHRhbGsgdG8gYSBkYWVtb24gc3Bhd25lZCBmcm9tIGEgZGlmZmVyZW50IGNhY2hlZFxuLy8gcGF0aC4gQmVzdC1lZmZvcnQ7IG51bGwgaWYgcmVhZCBmYWlscy5cbmZ1bmN0aW9uIHJlYWRQbHVnaW5WZXJzaW9uKCk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBsdWdpbkpzb25QYXRoID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIik7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKHBsdWdpbkpzb25QYXRoLCBcInV0Zi04XCIpO1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykudmVyc2lvbiA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuY29uc3QgUExVR0lOX1ZFUlNJT04gPSByZWFkUGx1Z2luVmVyc2lvbigpO1xuXG4vLyBPbmUtc2hvdCB2ZXJzaW9uLW1pc21hdGNoIGNoZWNrLiBUaGUgZGFlbW9uIG1heSBiZSBmcm9tIGEgZGlmZmVyZW50XG4vLyBjYWNoZWQgcGx1Z2luIHBhdGggdGhhbiB0aGlzIENMSSAoZXhpc3RpbmcgdGFpbCBwcm9jZXNzZXMnIGF1dG8tcmVjb25uZWN0XG4vLyBjYW4gcmFjZSBhIGBzdG9wYCBhbmQgcmVzcGF3biB0aGUgb2xkIGRhZW1vbikuIFdhcm4gb25jZSBwZXIgaW52b2NhdGlvblxuLy8gc28gdGhlIHVzZXIgaGFzIGEgc2lnbmFsIGluc3RlYWQgb2Ygc2lsZW50bHkgZGVncmFkZWQgYmVoYXZpb3IuXG5sZXQgX3ZlcnNpb25DaGVja0RvbmUgPSBmYWxzZTtcbmFzeW5jIGZ1bmN0aW9uIG1heWJlV2Fybk9uVmVyc2lvbk1pc21hdGNoKHBvcnQ6IG51bWJlcikge1xuICBpZiAoX3ZlcnNpb25DaGVja0RvbmUpIHJldHVybjtcbiAgX3ZlcnNpb25DaGVja0RvbmUgPSB0cnVlO1xuICBpZiAoIVBMVUdJTl9WRVJTSU9OKSByZXR1cm47IC8vIGNhbid0IGNvbXBhcmUgaWYgd2UgZG9uJ3Qga25vdyBvdXIgb3duIHZlcnNpb25cbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2AsIHtcbiAgICAgIHNpZ25hbDogQWJvcnRTaWduYWwudGltZW91dCg1MDApLFxuICAgIH0pO1xuICAgIGlmICghcmVzLm9rKSByZXR1cm47XG4gICAgY29uc3QgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgICBjb25zdCBkYWVtb25WZXJzaW9uID0gZGF0YT8udmVyc2lvbiA/PyBudWxsO1xuICAgIGlmIChkYWVtb25WZXJzaW9uID09PSBudWxsKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgYCMgZ3JhcGV2aW5lOiBkYWVtb24gaXMgb2xkZXIgdGhhbiB0aGlzIENMSSAobm8gdmVyc2lvbiByZXBvcnRlZCkuIGAgK1xuICAgICAgICAgIGBDTEkgaXMgdiR7UExVR0lOX1ZFUlNJT059LiBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBgICtcbiAgICAgICAgICBgUmVzdGFydCB0aGUgZGFlbW9uIChkcm9wIHRhaWxzLCB0aGVuIFxcYHN0b3BcXGAsIHRoZW4gYW55IHZlcmIpIHRvIHVwZ3JhZGUuXFxuYCxcbiAgICAgICk7XG4gICAgfSBlbHNlIGlmIChkYWVtb25WZXJzaW9uICE9PSBQTFVHSU5fVkVSU0lPTikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGdyYXBldmluZTogZGFlbW9uIHZlcnNpb24gKHYke2RhZW1vblZlcnNpb259KSBkaWZmZXJzIGZyb20gQ0xJIHZlcnNpb24gKHYke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICAgIGBTb21lIGZlYXR1cmVzIG1heSBzaWxlbnRseSBkZWdyYWRlLiBSZXN0YXJ0IHRoZSBkYWVtb24gdG8gYWxpZ24uXFxuYCxcbiAgICAgICk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBiZXN0LWVmZm9ydFxuICB9XG59XG4vLyBHUkFQRVZJTkVfRlJPTSBzZXRzIHRoZSBkZWZhdWx0IC0tZnJvbSAvIC0tYXMgYWxpYXMgc28gYWdlbnRzIGRvbid0IGhhdmVcbi8vIHRvIHJlcGVhdCB0aGVpciBpZGVudGl0eSBvbiBldmVyeSB2ZXJiLiBQZXItdmVyYiBmbGFncyBzdGlsbCBvdmVycmlkZS5cbmNvbnN0IERFRkFVTFRfQUxJQVMgPSBwcm9jZXNzLmVudi5HUkFQRVZJTkVfRlJPTSA/PyB1bmRlZmluZWQ7XG5cbi8vIElkZW50aXR5IGZsYWdzIGFyZSBpbnRlcmNoYW5nZWFibGUgYWNyb3NzIHZlcmJzLiBgc2VuZGAgaGlzdG9yaWNhbGx5IHRvb2tcbi8vIGAtLWZyb21gIHdoaWxlIGB0YWlsYC9gd2FpdGAgdG9vayBgLS1hc2Ag4oCUIHNhbWUgY29uY2VwdCAod2hvIGFtIEkpLCBhbmQgdGhlXG4vLyBhc3ltbWV0cnkgdHJpcHMgeW91IG1pZC1mbG93LiBBY2NlcHQgZWl0aGVyIGV2ZXJ5d2hlcmUgaWRlbnRpdHkgaXMgbWVhbnQsXG4vLyBmYWxsaW5nIGJhY2sgdG8gR1JBUEVWSU5FX0ZST00uIChncmVwJ3MgYC0tZnJvbWAgaXMgYSBkaWZmZXJlbnQgdGhpbmcg4oCUIGFuXG4vLyBhdXRob3IgKmZpbHRlciosIG5vdCBpZGVudGl0eSDigJQgc28gaXQgZG9lc24ndCB1c2UgdGhpcy4pXG5mdW5jdGlvbiByZXNvbHZlQWxpYXMoZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIChmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gKGZsYWdzLmFzIGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz8gREVGQVVMVF9BTElBUztcbn1cbi8vIFRydW5jYXRpb24taGludCB0aHJlc2hvbGQuIE1lc3NhZ2VzIGxvbmdlciB0aGFuIHRoaXMgZ2V0IGEgYHRydW5jYXRpb25faGludGBcbi8vIGZpZWxkIG9uIHRoZSB0YWlsIEpTT04gc28gY29uc3VtZXJzIChlLmcuIE1vbml0b3IpIGtub3cgdGhlIG5vdGlmaWNhdGlvblxuLy8gcHJldmlldyBpcyBpbmNvbXBsZXRlIGFuZCBzaG91bGQgYHJlYWRgIHRoZSBmdWxsIGJvZHkuIEluIGFnZW50LXRvLWFnZW50XG4vLyB0cmFmZmljLCBsb25nIG1lc3NhZ2VzIGFyZSB0aGUgTk9STSAodGhlIFYxLjYgcm91bmR0YWJsZSBzYXcgbW9zdCBzdWJzdGFudGl2ZVxuLy8gbWVzc2FnZXMgZXhjZWVkIDgwMCksIHNvIGFuIDgwMCBkZWZhdWx0IGZpcmVkIG9uIG5lYXJseSBldmVyeXRoaW5nIGFuZCB0aGVcbi8vIHJlY292ZXJ5IHBhdGggYmVjYW1lIHRoZSBtYWluIHBhdGguIERlZmF1bHQgcmFpc2VkIHRvIDIwMDAgc28gdGhlIGhpbnQgbWFya3Ncbi8vIHRoZSBnZW51aW5lbHktbG9uZyBvdXRsaWVycy4gT3ZlcnJpZGFibGUgdmlhIGVudiB2YXIgZm9yIHR1bmluZy5cbmNvbnN0IFRSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPSBwYXJzZUludChcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RSVU5DQVRJT05fSElOVF9USFJFU0hPTEQgPz8gXCIyMDAwXCIsXG4gIDEwLFxuKTtcblxuLy8gT3B0aW9uYWwgaW5saW5lLWJvZHkgY2FwIGZvciBgdGFpbGAgKG9wdC1pbiB2aWEgLS1tYXggPG4+IG9yIEdSQVBFVklORV9UQUlMX01BWCkuXG4vLyBXaGVuIHNldCwgYSBib2R5IGxvbmdlciB0aGFuIHRoZSBjYXAgaXMgdHJ1bmNhdGVkIHRvIGBuYCBjaGFycyBpbiB0aGUgdGFpbFxuLy8gZnJhbWUgKHBsdXMgdGhlIHJlYWQtcG9pbnRlciBoaW50KSwgc28gYSBwdXNoIGNvbnN1bWVyIGNhbiBoYW5kIGl0c1xuLy8gbm90aWZpY2F0aW9uIHN1cmZhY2UgYSBkZWxpYmVyYXRlbHktc2l6ZWQgbGluZS4gVGhlIEZVTEwgbWVzc2FnZSBpcyBhbHdheXNcbi8vIHJldHJpZXZhYmxlIHZpYSBgcmVhZCA8Y2hhbm5lbD4gPGlkPmAuIFVuZGVmaW5lZCA9IG5vIGNhcCAoZnVsbCB0ZXh0IGlubGluZSDigJRcbi8vIHRvZGF5J3MgZGVmYXVsdCkuIE5vdGU6IHRoZSBoYXJkIGNsaXAgYSBjb25zdW1lciB1bHRpbWF0ZWx5IHNlZXMgaXMgc3RpbGwgdGhlXG4vLyBNb25pdG9yL25vdGlmaWNhdGlvbiBsYXllcidzOyAtLW1heCBvbmx5IGJvdW5kcyB0aGUgbGluZSBncmFwZXZpbmUgZW1pdHMuXG4vLyBSZWplY3RzIG5lZ2F0aXZlIC8gbm9uLW51bWVyaWMuXG5mdW5jdGlvbiByZXNvbHZlVGFpbE1heChmbGFnOiB1bmtub3duKTogbnVtYmVyIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWcgPT09IFwic3RyaW5nXCIgPyBmbGFnIDogcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX1RBSUxfTUFYO1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3LCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+PSAwID8gbiA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUg4oCUIGBzcmMva2l0L3dpcmUvZXJyb3JzLnRzYCdzIGBkaWVgLCB1bmRlciB0aGlzXG4gKiBzcGVsbCdzIG93biBuYW1lIHNvIDQ2IGNhbGwgc2l0ZXMgZGlkIG5vdCBlYWNoIGhhdmUgdG8gYmUgcmUtc3BlbGxlZC5cbiAqXG4gKiDim5QgKipJVCBUSFJPV1MuIElUIERPRVMgTk9UIEVYSVQsIEFORCBUSEFUIElTIEEgQ0FMTEVSLVZJU0lCTEUgQ0hBTkdFKipcbiAqIChQaGFzZSA2IGNoYXB0ZXIgMjsgdGhlIGRlbHRhIGlzIGRyaXZlbiBhbmQgcmVjb3JkZWQgaW4gdGhlIGpvdXJuYWwpLiBUaGlzXG4gKiBmdW5jdGlvbiB3YXMgYHByb2Nlc3Muc3RkZXJyLndyaXRlKFxcYGdyYXBldmluZTogJHttc2d9XFxuXFxgKTsgcHJvY2Vzcy5leGl0KGNvZGUpYFxuICog4oCUIFBST1NFIGF0IGV4aXQgMiBmb3IgZXZlcnkgZmFpbHVyZSBncmFwZXZpbmUgY291bGQgcHJvZHVjZSwgd2l0aCB0d28gc2l0ZXNcbiAqIHBhc3NpbmcgMS4gQWZ0ZXIgdGhlIGFkb3B0aW9uIGl0IGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciBhbmQgdGhlXG4gKiBhY2MgdGF4b25vbXkncyBjb2RlczogdXNhZ2UgMiwgaW50ZXJuYWwgMSwgbm90X2ZvdW5kIDUsIGNvbmZsaWN0IDYuIEFuIGFnZW50XG4gKiByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlOyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uIGFuZCByZXdvcmRpbmdcbiAqIGl0IG11c3QgbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRpZCB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVkIHByb3NlLlxuICpcbiAqIOKblCAqKkFORCBUSEUgRU5VTUVSQVRJT05TIE1PVkVEIEZST00gUFJPU0UgSU5UTyBgY2hvaWNlc2AuKiogZ3JhcGV2aW5lJ3NcbiAqIHJlamVjdGlvbnMgd2VyZSBzaGFwZWQgZm9yIGFjYydzIGZsYWctc2V0IGV4dHJhY3RvcnMg4oCUIGByZWNvZ25pemVkIGZsYWdzOiAtLWFcbiAqIC0tYmAsIHdpdGggYSBjb21tZW50IHJlY29yZGluZyB0aGF0IGEgcXVhbGlmaWVyIGJldHdlZW4gdGhlIG5vdW4gYW5kIHRoZSBjb2xvblxuICogXCJyZWFkcyBhcyBwcm9zZSwgbm90IGEgc2V0XCIuIFdyYXBwZWQgaW4gSlNPTiB0aGF0IG1hcmtlciBiZWNvbWVzIGEgc3Vic3RyaW5nIG9mXG4gKiBhbiBlc2NhcGVkIHN0cmluZywgc28gaXQgZG9lcyBub3Qgc3RheSBpbiBwcm9zZTogZXZlcnkgZW51bWVyYXRpb24gaXMgbm93IGFcbiAqIGBjaG9pY2VzYCBhcnJheSwgd2hpY2ggaXMgd2hhdCBnbGFtb3VyIChDT05GT1JNQU5UIEwwKSBwdWJsaXNoZXMgYW5kIHdoYXQgdGhlXG4gKiBlbnZlbG9wZSBoYXMgYSBmaWVsZCBmb3IuIFRoZSBydW5uYWJsZSByZWNvdmVyeSDigJQgYHRyeTogYnVuIOKApi9jbGkudHMgb3BlbiB4YCDigJRcbiAqIG1vdmVkIGludG8gYGhpbnRgIGZvciB0aGUgc2FtZSByZWFzb24sIGFuZCBhIGNhbGxlciBub3cgcmVhZHMgYSBmaWVsZCBpbnN0ZWFkXG4gKiBvZiBzcGxpdHRpbmcgYSBzZW50ZW5jZS5cbiAqXG4gKiDimqAgYGRpZWAgaXMgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBzd2FsbG93cywgYW5kIHRoYXQgaXNcbiAqIG5vdyBhIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiBBdWRpdGVkIGJ5IGNhbGwgZ3JhcGggYXQgdGhlXG4gKiBhZG9wdGlvbiAocGxheWJvb2sgQjkpOyB0aGUgY291bnQgaXMgaW4gdGhlIGpvdXJuYWwuXG4gKi9cbmZ1bmN0aW9uIGRpZShtc2c6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgcmFpc2UobXNnLCBraW5kLCBleHRyYSk7XG59XG5cbi8qKlxuICogVGhlIHRheG9ub215IGBraW5kYCBmb3IgYW4gSFRUUCBzdGF0dXMgdGhlIGRhZW1vbiBhbnN3ZXJlZCB3aXRoLlxuICpcbiAqIOKblCBPTkUgTUFQUElORywgTk9UIEEgSlVER0VNRU5UIFBFUiBTSVRFLiBUd2VudHkgb2YgZ3JhcGV2aW5lJ3MgcmFpc2Ugc2l0ZXNcbiAqIGFyZSBcInRoZSBkYWVtb24gc2FpZCBub1wiOyBiZWZvcmUgdGhlIGFkb3B0aW9uIGV2ZXJ5IG9uZSBvZiB0aGVtIGNvbGxhcHNlZCB0b1xuICogZXhpdCAyLCBzbyBhIG1pc3NpbmcgY2hhbm5lbCwgYSBsaXZlLXNlc3Npb24gcmVmdXNhbCBhbmQgYSBicm9rZW4gZGFlbW9uIHdlcmVcbiAqIG9uZSBudW1iZXIgdG8gYW4gYWdlbnQuIFRoZSBkYWVtb24gYWxyZWFkeSBkaXN0aW5ndWlzaGVzIHRoZW0gYnkgc3RhdHVzIOKAlFxuICogNDA0IGZvciBhIGNoYW5uZWwgdGhhdCBkb2VzIG5vdCBleGlzdCwgNDA5IGZvciBhcmNoaXZlZCAvIGxpdmUgLyBhbHJlYWR5LW9wZW5cbiAqIOKAlCBzbyB0aGUgbWFwcGluZyBpcyBhIHJlLXJlYWRpbmcgb2Ygd2hhdCB3YXMgb24gdGhlIHdpcmUsIG5vdCBhIG5ldyBvcGluaW9uLlxuICovXG5mdW5jdGlvbiBraW5kRm9yU3RhdHVzKHN0YXR1czogbnVtYmVyKTogRXJyS2luZCB7XG4gIGlmIChzdGF0dXMgPT09IDQwNCkgcmV0dXJuIFwibm90X2ZvdW5kXCI7XG4gIGlmIChzdGF0dXMgPT09IDQwOSkgcmV0dXJuIFwiY29uZmxpY3RcIjtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgJiYgc3RhdHVzIDwgNTAwKSByZXR1cm4gXCJ1c2FnZVwiO1xuICByZXR1cm4gXCJpbnRlcm5hbFwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkRGFlbW9uUG9ydCgpOiBQcm9taXNlPG51bWJlciB8IG51bGw+IHtcbiAgaWYgKCFleGlzdHNTeW5jKFBPUlRfRklMRSkpIHJldHVybiBudWxsO1xuICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgY29uc3QgcG9ydCA9IHBhcnNlSW50KHJhdywgMTApO1xuICBpZiAoIXBvcnQpIHJldHVybiBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDUwMCksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykge1xuICAgICAgLy8gRmlyZS1hbmQtZm9yZ2V0IG1pc21hdGNoIGNoZWNrICh3b24ndCBibG9jayB0aGUgdmVyYikuXG4gICAgICBtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaChwb3J0KTtcbiAgICAgIHJldHVybiBwb3J0O1xuICAgIH1cbiAgfSBjYXRjaCB7fVxuICAvLyBTdGFsZSDigJQgY2xlYW4gdXAuXG4gIHRyeSB7XG4gICAgdW5saW5rU3luYyhQT1JUX0ZJTEUpO1xuICB9IGNhdGNoIHt9XG4gIHRyeSB7XG4gICAgdW5saW5rU3luYyhQSURfRklMRSk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIG51bGw7XG59XG5cbmZ1bmN0aW9uIGhvbGRBY3RpdmUoKTogbnVtYmVyIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgaWYgKCFleGlzdHNTeW5jKEhPTERfRklMRSkpIHJldHVybiBudWxsO1xuICAgIGNvbnN0IHVudGlsID0gcGFyc2VJbnQocmVhZEZpbGVTeW5jKEhPTERfRklMRSwgXCJ1dGYtOFwiKS50cmltKCksIDEwKTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHVudGlsKSAmJiB1bnRpbCA+IERhdGUubm93KCkpIHJldHVybiB1bnRpbDtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhIT0xEX0ZJTEUpO1xuICAgIH0gY2F0Y2gge30gLy8gZXhwaXJlZCDihpIgY2xlYW5cbiAgICByZXR1cm4gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmV4cG9ydCBmdW5jdGlvbiByZWxlYXNlSG9sZCgpIHtcbiAgdHJ5IHtcbiAgICBpZiAoZXhpc3RzU3luYyhIT0xEX0ZJTEUpKSB1bmxpbmtTeW5jKEhPTERfRklMRSk7XG4gIH0gY2F0Y2gge31cbn1cblxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGFlbW9uKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKHBvcnQpIHJldHVybiBwb3J0O1xuICBpZiAoaG9sZEFjdGl2ZSgpKVxuICAgIGRpZShcbiAgICAgIFwiZGFlbW9uIGlzIGhlbGQgKHJlc3Bhd24gc3VwcHJlc3NlZCkg4oCUIHdhaXQgZm9yIHRoZSBob2xkIHRvIGNsZWFyIG9yIHJ1biBgZ3JhcGV2aW5lIHJvbGxgXCIsXG4gICAgICBcImNvbmZsaWN0XCIsXG4gICAgKTtcbiAgLy8gQ2hlY2sgdGhlIGN3ZCBFWElTVFMgYmVmb3JlIHNwYXduaW5nOiB0aGUgZGFlbW9uJ3Mgc3RkaW8gaXMgaWdub3JlZCwgc28gYVxuICAvLyBkZXYtbW9kZSBkYWVtb24gZHlpbmcgYXQgaXRzIHN1cmZhY2UgaW1wb3J0IHdvdWxkIG90aGVyd2lzZSBzdXJmYWNlIG9ubHkgYXNcbiAgLy8gXCJmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDNzXCIg4oCUIGFuZCBub2RlIHJlcG9ydHMgYSBtaXNzaW5nIGN3ZCBhcyBFTk9FTlQgb25cbiAgLy8gdGhlIGV4ZWN1dGFibGUsIHdoaWNoIHJlYWRzIGFzIFwiYnVuIGlzIG1pc3NpbmdcIi5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKSB7XG4gICAgZGllKFxuICAgICAgYGdyYXBldmluZSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfS4gYCArXG4gICAgICAgIFwiTm8gZGlzdC9pbmRleC5odG1sIHdhcyBmb3VuZCAob3IgU1BFTExCT09LX1NVUkZBQ0VfTU9ERT1kZXYgaXMgc2V0KSwgc28gdGhlIGRhZW1vbiBcIiArXG4gICAgICAgIFwibXVzdCBydW4gZnJvbSBzcmMvZ3JhcGV2aW5lLyB0byBidW5kbGUgdGhlIHdhdGNoIHN1cmZhY2UsIHdoaWNoIGEgc291cmNlLWZyZWUgaW5zdGFsbCBcIiArXG4gICAgICAgIFwiZG9lcyBub3QgaGF2ZS4gRWl0aGVyIHRoZSBzaGlwcGVkIGRpc3QvIGlzIG1pc3NpbmcgKHJlaW5zdGFsbCB0aGUgc3BlbGwpIG9yIHlvdSBhcmUgaW4gXCIgK1xuICAgICAgICBcImEgY2hlY2tvdXQgd2l0aG91dCBzcmMvZ3JhcGV2aW5lLy5cIixcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICApO1xuICB9XG4gIC8vIFNwYXduIGRldGFjaGVkIHNvIHRoZSBkYWVtb24gc3Vydml2ZXMgdGhpcyBDTEkgcHJvY2VzcyBleGl0LlxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgW0RBRU1PTl9TQ1JJUFRdLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIGN3ZCxcbiAgfSk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gV2FpdCB1cCB0byAzcyBmb3IgdGhlIHBvcnQgZmlsZSB0byBhcHBlYXIgYW5kIHJlc3BvbmQuXG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDMwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCA1MCkpO1xuICAgIHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICAgIGlmIChwb3J0KSByZXR1cm4gcG9ydDtcbiAgfVxuICBkaWUoXCJkYWVtb24gZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiAzc1wiLCBcImludGVybmFsXCIsIHtcbiAgICBoaW50OlxuICAgICAgXCJ0aHJlZSB1bnJlbGF0ZWQgY2F1c2VzIHJlcG9ydCB0aGlzIG9uZSBzZW50ZW5jZTogdGhlIGRhZW1vbidzIGxhdW5jaGVyIHNoYXBlLCBcIiArXG4gICAgICBcImEgd3Jvbmcgc3Bhd24gcGF0aCwgYW5kIGEgZGV2LW1vZGUgZGFlbW9uIGR5aW5nIGF0IGl0cyBzdXJmYWNlIGltcG9ydC4gXCIgK1xuICAgICAgXCJSdW4gdGhlIGRhZW1vbiBsYXVuY2hlciBhbG9uZSB0byB0ZWxsIHRoZW0gYXBhcnQg4oCUIGl0IGlzIHRoZSBsYXVuY2hlciBzaGFwZSBcIiArXG4gICAgICBcImlmZiBpdCBwcmludHMgYGxpc3RlbmluZyBvbiDigKZgIGFuZCByZXR1cm5zIGF0IGV4aXQgMC4gQW4gZW1wdHkgXCIgK1xuICAgICAgXCJHUkFQRVZJTkVfSE9NRSAobm8gYGNoYW5uZWxzL2ApIG1lYW5zIHRoZSBkYWVtb24gbmV2ZXIgYm91bmQgYXQgYWxsLlwiLFxuICB9KTtcbn1cblxuLy8gR2VuZXJpYyBvdmVyIHRoZSBleHBlY3RlZCBzdWNjZXNzIGJvZHkuIGBkYXRhYCBtYXkgYmUgbnVsbCBpZiB0aGUgcmVzcG9uc2Vcbi8vIGhhZCBubyBKU09OIGJvZHksIHNvIGNhbGxlcnMgc2VlIGBUIHwgbnVsbGAuXG5hc3luYyBmdW5jdGlvbiBhcGk8VCA9IHVua25vd24+KFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiBUIHwgbnVsbCB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogVCB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSAoYXdhaXQgcmVzLmpzb24oKSkgYXMgVDtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG5cbi8vIEhvdyBUSElTIENMSSB3YXMgaW52b2tlZCwgYXMgYSBydW5uYWJsZSBwcmVmaXguIGBwcm9jZXNzLmFyZ3ZbMV1gIGlzIHRoZVxuLy8gYWJzb2x1dGUgcGF0aCBvZiBjbGkudHMgdW5kZXIgYGJ1biDigKYvY2xpLnRzIDx2ZXJiPmAsIHdoaWNoIGlzIFNLSUxMLm1kJ3Ncbi8vIGNhbm9uaWNhbCBpbnZvY2F0aW9uIOKAlCBzbyB0aGUgbGluZSB3ZSBwcmludCBjYW4gYWN0dWFsbHkgYmUgcGFzdGVkLiBGYWxsc1xuLy8gYmFjayB0byB0aGUgYmFyZSB2ZXJiIGlmIGFyZ3YgaXMgbm90IHNoYXBlZCBhcyBleHBlY3RlZCwgd2hpY2ggaXMgYSB2ZXJiXG4vLyByZWZlcmVuY2UgcmF0aGVyIHRoYW4gYSBjb21tYW5kIHRoYXQgbGllcyBhYm91dCBiZWluZyBvbmUuXG5mdW5jdGlvbiBpbnZvY2F0aW9uUHJlZml4KCk6IHN0cmluZyB7XG4gIGNvbnN0IGVudHJ5ID0gcHJvY2Vzcy5hcmd2WzFdO1xuICByZXR1cm4gZW50cnkgPyBgYnVuICR7ZW50cnl9YCA6IFwiXCI7XG59XG5cbi8vIEEgZGFlbW9uIHJlZnVzYWwgY2FycmllcyBgaGludGAg4oCUIHRoZSBhY3QgdGhhdCByZWNvdmVycyBmcm9tIGl0IChhIDQwNCBvbiBhXG4vLyByZWFkIG5hbWVzIHRoZSBgb3BlbmAgdGhhdCB3b3VsZCBjcmVhdGUgdGhlIGNoYW5uZWwpLlxuLy9cbi8vIOKaoCBgaGludGAgaXMgYSBWRVJCIElOVk9DQVRJT04sIG5vdCBhIHNoZWxsIGNvbW1hbmQ6IHRoZSBkYWVtb24gY2Fubm90IGtub3dcbi8vIGhvdyBpdHMgY2xpZW50IHdhcyBpbnZva2VkLCBzbyBpdCBuYW1lcyB0aGUgYWN0IGFuZCB3ZSByZW5kZXIgaXQuIEl0IHVzZWQgdG9cbi8vIGFycml2ZSBhcyBgZ3JhcGV2aW5lIG9wZW4gPG5hbWU+YCBhbmQgYmUgcHJpbnRlZCB2ZXJiYXRpbSBhZnRlciBgdHJ5OmAsIHdoaWNoXG4vLyByZWFkcyBhcyBzb21ldGhpbmcgdG8gcGFzdGUg4oCUIGFuZCBwYXN0aW5nIGl0IGdldHMgYGNvbW1hbmQgbm90IGZvdW5kYCxcbi8vIGJlY2F1c2Ugbm90aGluZyBpbnN0YWxscyBhIGBncmFwZXZpbmVgIGJpbmFyeS4gUnVsaW5nIDIgYXNrZWQgdGhhdCBhIHJlZnVzYWxcbi8vIG5hbWUgdGhlIG5leHQgYWN0OyBhIHJlY292ZXJ5IHRoYXQgZmFpbHMgd2hlbiB5b3UgcnVuIGl0IGRvZXMgbm90LlxuZnVuY3Rpb24gZGllQXBpKGRhdGE6IHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1czogbnVtYmVyKTogbmV2ZXIge1xuICBjb25zdCBtc2cgPSBkYXRhPy5lcnJvciA/PyBgSFRUUCAke3N0YXR1c31gO1xuICBjb25zdCBwcmVmaXggPSBpbnZvY2F0aW9uUHJlZml4KCk7XG4gIC8vIOKblCBUSEUgUkVDT1ZFUlkgSVMgQSBGSUVMRCBOT1csIE5PVCBBIFNFTlRFTkNFLiBJdCB1c2VkIHRvIGJlIGFwcGVuZGVkIHRvIHRoZVxuICAvLyBtZXNzYWdlIGFzIGDigJQgdHJ5OiA8Y21kPmAsIHdoaWNoIGEgY2FsbGVyIGhhZCB0byByZWNvdmVyIGJ5IHNwbGl0dGluZyBvblxuICAvLyBcInRyeTogXCIgKG9uZSBvZiBncmFwZXZpbmUncyBvd24gY2VsbHMgZGlkIGV4YWN0bHkgdGhhdCwgYW5kIHJhbiB3aGF0IGl0XG4gIC8vIGZvdW5kKS4gYGhpbnRgIGlzIHdoZXJlIHRoZSBlbnZlbG9wZSBjYXJyaWVzIGl0LCBzbyB0aGUgc2FtZSBjZWxsIG5vdyByZWFkc1xuICAvLyBhIGZpZWxkIGFuZCBydW5zIGl0IOKAlCB0aGUgcHJvcGVydHkgaXMgdW5jaGFuZ2VkIGFuZCB0aGUgcGFyc2UgaXMgbm90IGEgcGFyc2UuXG4gIGNvbnN0IGhpbnQgPSBkYXRhPy5oaW50XG4gICAgPyBwcmVmaXhcbiAgICAgID8gYHRyeTogJHtwcmVmaXh9ICR7ZGF0YS5oaW50fWBcbiAgICAgIDogYHRyeSB0aGUgXFxgJHtkYXRhLmhpbnR9XFxgIHZlcmJgXG4gICAgOiB1bmRlZmluZWQ7XG4gIGRpZShtc2csIGtpbmRGb3JTdGF0dXMoc3RhdHVzKSwge1xuICAgIC4uLihoaW50ID8geyBoaW50IH0gOiB7fSksXG4gICAgLy8gVGhlIHVwc3RyZWFtJ3MgYm9keSBWRVJCQVRJTSwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB3aGF0IHRoZSBkYWVtb25cbiAgICAvLyBhY3R1YWxseSBzYWlkIHJhdGhlciB0aGFuIG9uIHRoaXMgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQuXG4gICAgLi4uKGRhdGEgIT09IG51bGwgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuLy8gRXhpc3RlbmNlIHByb2JlIGZvciB0aGUgcmVhZCB2ZXJicyB0aGF0IGFuc3dlciBmcm9tIHRoZSBMT0cgRklMRSByYXRoZXIgdGhhblxuLy8gZnJvbSBhIHJvdXRlIChgdHJpYWdlYCwgYHB1bGwgLS1zdGF0dXNgKS4gVGhvc2UgY2Fubm90IDQwNCBvbiB0aGVpciBvd246IGFcbi8vIG1pc3NpbmcgbG9nIGlzIGFuIGVtcHR5IGFycmF5LCB3aGljaCBpcyB0aGUgc2FtZSBzaWxlbnQgbGllIHRoZSBkYWVtb24gZ3VhcmRcbi8vIGV4aXN0cyB0byBraWxsLiBHRVQgL3RvcGljIGlzIHRoZSBjaGVhcGVzdCBndWFyZGVkIHJvdXRlLCBzbyBpdCBpcyB0aGUgcHJvYmUuXG5hc3luYyBmdW5jdGlvbiByZXF1aXJlQ2hhbm5lbChwb3J0OiBudW1iZXIsIG5hbWU6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfT4oXG4gICAgcG9ydCxcbiAgICBcIkdFVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2AsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7IHRvcGljPzogc3RyaW5nOyBmcm9tPzogc3RyaW5nOyBmcmVzaD86IGJvb2xlYW4gfSxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgb3BlbiA8bmFtZT4gWy0tdG9waWMgPHRleHQ+XSBbLS1mcmVzaF1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4gPSB7IG5hbWUsIGV4cGxpY2l0OiB0cnVlIH07XG4gIGlmIChvcHRzLnRvcGljICE9PSB1bmRlZmluZWQpIGJvZHkudG9waWMgPSBvcHRzLnRvcGljO1xuICBpZiAob3B0cy5mcm9tICE9PSB1bmRlZmluZWQpIGJvZHkuZnJvbSA9IG9wdHMuZnJvbTtcbiAgaWYgKG9wdHMuZnJlc2gpIGJvZHkuZnJlc2ggPSB0cnVlO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPE9wZW5SZXNwb25zZT4ocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIGJvZHkpO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBkYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUb3BpYyhcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICB0ZXh0OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGZyb206IHN0cmluZyB8IHVuZGVmaW5lZCxcbikge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgdG9waWMgPGNoYW5uZWw+IFs8dGV4dD5dXCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGlmICh0ZXh0ID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBgdG9waWMgPG5hbWU+YCB3aXRoIG5vIHRleHQgaXMgYSBSRUFEIOKAlCBpdCBhc2tzIHdoYXQgdGhlIHRvcGljIGlzLCBhbmQgYVxuICAgIC8vIG1pc3NpbmcgY2hhbm5lbCBhbnN3ZXJzIHRoYXQgcXVlc3Rpb24gYnkgYmVpbmcgbWlzc2luZy4gTm8gZW5zdXJlOiB0aGVcbiAgICAvLyBlbnN1cmUgd2FzIHdoYXQgcmVzdXJyZWN0ZWQgYSBjbG9zZWQgY2hhbm5lbCBmcm9tIGEgcmVhZCB2ZXJiLlxuICAgIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8VG9waWNSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgYC9jaGFubmVscy8ke25hbWV9L3RvcGljYCk7XG4gICAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBuYW1lLCB0b3BpYzogZGF0YT8udG9waWMgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIGB0b3BpYyA8bmFtZT4gPHRleHQ+YCBpcyBhIFdSSVRFLCBzbyBpdCBtYXkgY3JlYXRlIOKAlCBidXQgaXQgbXVzdCBub3Qgd3JpdGVcbiAgLy8gdG8gYW4gQVJDSElWRUQgY2hhbm5lbC4gVGhlIFBVVCBlbmZvcmNlcyB0aGF0IGl0c2VsZiBub3c7IHRoaXMgZW5zdXJlIHN0YXlzXG4gIC8vIGJlY2F1c2UgRElTQ0FSRElORyBJVFMgU1RBVFVTIGlzIHByZWNpc2VseSB0aGUgYnVnIGJlaW5nIGZpeGVkIGhlcmUuIEJlZm9yZVxuICAvLyB0b2RheSB0aGUgNDA5IHRoYXQgYW5zd2VycyBmb3IgYW4gYXJjaGl2ZWQgbmFtZSB3YXMgdGhyb3duIGF3YXkgYW5kIHRoZSBQVVRcbiAgLy8gdGhhdCBmb2xsb3dlZCBsYW5kZWQ6IGBhcmNoaXZlIHg7IHRvcGljIHggXCJ0XCJgIHJldHVybmVkIG9rOnRydWUsIGV4aXQgMC5cbiAgY29uc3QgZW5zdXJlID0gYXdhaXQgYXBpPHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfT4ocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZSB9KTtcbiAgaWYgKGVuc3VyZS5zdGF0dXMgPj0gNDAwKSBkaWVBcGkoZW5zdXJlLmRhdGEsIGVuc3VyZS5zdGF0dXMpO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFRvcGljUmVzcG9uc2U+KHBvcnQsIFwiUFVUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS90b3BpY2AsIHtcbiAgICB0b3BpYzogdGV4dCxcbiAgICBmcm9tOiBmcm9tID8/IFwic3lzdGVtXCIsXG4gIH0pO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsOiBuYW1lLCB0b3BpYzogZGF0YT8udG9waWMsIGlkOiBkYXRhPy5pZCB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTGlzdCgpIHtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPENoYW5uZWxzUmVzcG9uc2U+KHBvcnQsIFwiR0VUXCIsIFwiL2NoYW5uZWxzXCIpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTZW5kKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGZyb206IHN0cmluZyxcbiAgdGV4dDogc3RyaW5nLFxuICBvcHRzOiB7IHF1aWV0PzogYm9vbGVhbjsgdmVyYm9zZT86IGJvb2xlYW47IGluUmVwbHlUbz86IG51bWJlciB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhZnJvbSB8fCAhdGV4dCkgZGllKFwidXNhZ2U6IGdyYXBldmluZSBzZW5kIDxuYW1lPiAtLWZyb20gPGFsaWFzPiA8dGV4dC4uLj5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgY29uc3QgYm9keTogeyBmcm9tOiBzdHJpbmc7IHRleHQ6IHN0cmluZzsgaW5fcmVwbHlfdG8/OiBudW1iZXIgfSA9IHtcbiAgICBmcm9tLFxuICAgIHRleHQsXG4gIH07XG4gIGlmIChvcHRzLmluUmVwbHlUbyAhPT0gdW5kZWZpbmVkKSBib2R5LmluX3JlcGx5X3RvID0gb3B0cy5pblJlcGx5VG87XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8U2VuZFJlY2VpcHQ+KHBvcnQsIFwiUE9TVFwiLCBgL2NoYW5uZWxzLyR7bmFtZX0vbWVzc2FnZXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICAvLyBUYXJnZXQgZWNobyBvbiBzdGRlcnIg4oCUIGNvbmZpcm1zIFdIRVJFIHRoZSBtZXNzYWdlIGxhbmRlZCBzbyBhIG1pc3JvdXRlZFxuICAvLyByZXBseSAocmlnaHQgcHJvbXB0LCB3cm9uZyBjaGFubmVsKSBpcyBjYXVnaHQgdGhlIGluc3RhbnQgaXQgaGFwcGVucyAoRjkpLlxuICAvLyBPbiBzdGRlcnIgc28gaXQgbmV2ZXIgcG9sbHV0ZXMgdGhlIHN0ZG91dCBKU09OIHJlY2VpcHQsIGFuZCBpdCBmaXJlcyBldmVuXG4gIC8vIHVuZGVyIC0tcXVpZXQgKHRoZSBzYWZldHkgc2lnbmFsIHNob3VsZG4ndCBiZSBzaWxlbmNlZCkuXG4gIGNvbnN0IHJlY2lwID1cbiAgICBkYXRhLnJlY2lwaWVudHMgIT09IHVuZGVmaW5lZFxuICAgICAgPyBgJHtkYXRhLnJlY2lwaWVudHN9IHJlY2lwaWVudChzKWBcbiAgICAgIDogYCR7ZGF0YS5zdWJzY3JpYmVycyA/PyAwfSBzdWJzY3JpYmVyKHMpYDtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMg4oaSICR7ZGF0YS5jaGFubmVsfSDCtyAke3JlY2lwfVxcbmApO1xuICBpZiAob3B0cy5xdWlldCkgcmV0dXJuO1xuICAvLyBUZXJzZSBkZWZhdWx0OiBpZCArIHN1YnNjcmliZXIgY291bnQgKyB2b2lkIHdhcm5pbmcuIC0tdmVyYm9zZSBhbHNvXG4gIC8vIGluY2x1ZGVzIHRoZSBzdWJzY3JpYmVyIGFsaWFzIGxpc3QgKHNhbWUgZGF0YSBhcyB0aGUgYHdob2AgdmVyYixcbiAgLy8gcGlnZ3liYWNrZWQgdG8gYXZvaWQgYW4gZXh0cmEgcm91bmQtdHJpcCB3aGVuIHRoZSBzZW5kZXIgY2FyZXMpLlxuICBjb25zdCBvdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgIG9rOiB0cnVlLFxuICAgIGlkOiBkYXRhLmlkLFxuICAgIGNoYW5uZWw6IGRhdGEuY2hhbm5lbCxcbiAgICBzdWJzY3JpYmVyczogZGF0YS5zdWJzY3JpYmVycyA/PyAwLFxuICB9O1xuICAvLyBPbmx5IHN1cmZhY2UgcmVjaXBpZW50cyBpZiB0aGUgZGFlbW9uIGFjdHVhbGx5IGNvbXB1dGVkIGl0LiBEZWZhdWx0aW5nXG4gIC8vIHRvIDAgd2FzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gXCJyZWFsbHkgMFwiIGFuZCBoaWQgc2lsZW50IFYxLjUtZGFlbW9uXG4gIC8vIGRlZ3JhZGF0aW9uIGR1cmluZyBjcm9zcy12ZXJzaW9uIHNlc3Npb25zOyBtaXNzaW5nLW1lYW5zLW1pc3NpbmcgaXMgdGhlXG4gIC8vIGhvbmVzdCBzaWduYWwuXG4gIGlmIChkYXRhLnJlY2lwaWVudHMgIT09IHVuZGVmaW5lZCkgb3V0LnJlY2lwaWVudHMgPSBkYXRhLnJlY2lwaWVudHM7XG4gIGlmIChkYXRhLnN1YnNjcmliZXJzID09PSAwKSBvdXQud2FybmluZyA9IFwiY2hhbm5lbCBoYXMgbm8gc3Vic2NyaWJlcnNcIjtcbiAgZWxzZSBpZiAoZGF0YS5yZWNpcGllbnRzID09PSAwKSBvdXQud2FybmluZyA9IFwib25seSB5b3UgYXJlIHN1YnNjcmliZWRcIjtcbiAgaWYgKG9wdHMudmVyYm9zZSkgb3V0LnN1YnNjcmliZXJfYWxpYXNlcyA9IGRhdGEuc3Vic2NyaWJlcl9hbGlhc2VzID8/IFtdO1xuICBwcmludEpzb24ob3V0KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQW5ub3VuY2UoXG4gIGZyb206IHN0cmluZyxcbiAgdGV4dDogc3RyaW5nLFxuICBjaGFubmVsczogc3RyaW5nW10gfCB1bmRlZmluZWQsXG4gIG9wdHM6IHsgcXVpZXQ/OiBib29sZWFuIH0sXG4pIHtcbiAgaWYgKCFmcm9tIHx8ICF0ZXh0KSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGFubm91bmNlIC0tZnJvbSA8YWxpYXM+IDx0ZXh0Li4uPlwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiB7IGZyb206IHN0cmluZzsgdGV4dDogc3RyaW5nOyBjaGFubmVscz86IHN0cmluZ1tdIH0gPSB7IGZyb20sIHRleHQgfTtcbiAgaWYgKGNoYW5uZWxzPy5sZW5ndGgpIGJvZHkuY2hhbm5lbHMgPSBjaGFubmVscztcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxBbm5vdW5jZVJlY2VpcHQ+KHBvcnQsIFwiUE9TVFwiLCBcIi9hbm5vdW5jZVwiLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgIyBhbm5vdW5jZWQg4oaSICR7ZGF0YS5jaGFubmVscy5sZW5ndGh9IGNoYW5uZWwocykgwrcgJHtkYXRhLnRvdGFsX3JlY2lwaWVudHN9IHJlY2lwaWVudChzKVxcbmAsXG4gICk7XG4gIGlmIChvcHRzLnF1aWV0KSByZXR1cm47XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgb2s6IHRydWUsXG4gICAgY2hhbm5lbHM6IGRhdGEuY2hhbm5lbHMsXG4gICAgdG90YWxfcmVjaXBpZW50czogZGF0YS50b3RhbF9yZWNpcGllbnRzLFxuICB9O1xuICBpZiAoZGF0YS5za2lwcGVkPy5sZW5ndGgpIG91dC5za2lwcGVkID0gZGF0YS5za2lwcGVkO1xuICBpZiAoZGF0YS5jaGFubmVscy5sZW5ndGggPT09IDApIG91dC53YXJuaW5nID0gXCJubyBhY3RpdmUgY2hhbm5lbHMgdG8gYW5ub3VuY2UgdG9cIjtcbiAgcHJpbnRKc29uKG91dCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFB1bGwobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBzaW5jZTogbnVtYmVyLCBvcHRzOiB7IHN0YXR1cz86IHN0cmluZyB9ID0ge30pIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHB1bGwgPGNoYW5uZWw+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuXG4gIGlmIChvcHRzLnN0YXR1cyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgLy8gVGhpcyBicmFuY2ggYW5zd2VycyBmcm9tIHRoZSBsb2cgZmlsZSwgc28gaXQgY2Fubm90IDQwNCBvbiBpdHMgb3duLlxuICAgIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICAgIC8vIEZ1bGwtY2hhbm5lbCBzY2FuOiBmaWx0ZXIgYnkgbGF0ZXN0IGRpc3Bvc2l0aW9uLCBzdGF0dXMgZnJhbWVzIGV4Y2x1ZGVkLlxuICAgIGNvbnN0IGJhZGdlZCA9IGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQobmFtZSk7XG4gICAgY29uc3QgZmlsdGVyZWQgPSBiYWRnZWQuZmlsdGVyKChtKSA9PiB7XG4gICAgICBjb25zdCBkaXNwQXJnID0gbS5kaXNwb3NpdGlvbiAhPT0gdW5kZWZpbmVkID8geyBkaXNwb3NpdGlvbjogbS5kaXNwb3NpdGlvbiB9IDogdW5kZWZpbmVkO1xuICAgICAgLy8gYC0tc3RhdHVzIG9wZW5gIG1pcnJvcnMgdHJpYWdlJ3Mgb3BlbiBidWNrZXQ6IHNpZ25hbC1vbmx5LCBzbyBub24tbWVzc2FnZVxuICAgICAgLy8gRllJcyAodG9waWMvYW5ub3VuY2VtZW50KSBhcmUgZXhjbHVkZWQgZnJvbSB0aGUgYWN0aW9uYWJsZSBxdWV1ZS5cbiAgICAgIHJldHVybiBvcHRzLnN0YXR1cyA9PT0gXCJvcGVuXCJcbiAgICAgICAgPyBtLmtpbmQgPT09IFwibWVzc2FnZVwiICYmIGlzT3BlbihkaXNwQXJnKVxuICAgICAgICA6IG0uZGlzcG9zaXRpb24gPT09IG9wdHMuc3RhdHVzO1xuICAgIH0pO1xuICAgIGNvbnN0IGxhc3RJZCA9IGZpbHRlcmVkLmF0KC0xKT8uaWQgPz8gMDtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IGZpbHRlcmVkLCBjdXJzb3I6IGxhc3RJZCB9KTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTaW5jZS13aW5kb3cgcGF0aCAodW5jaGFuZ2VkIGZyb20gVGFzayAyKS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzP3NpbmNlPSR7c2luY2V9YCxcbiAgKTtcbiAgaWYgKHN0YXR1cyA+PSA0MDApIGRpZUFwaShkYXRhLCBzdGF0dXMpO1xuICBjb25zdCByYXdNc2dzID0gZGF0YT8ubWVzc2FnZXMgPz8gW107XG4gIGNvbnN0IGN1cnNvciA9IHJhd01zZ3MuYXQoLTEpPy5pZCA/PyBzaW5jZTtcbiAgY29uc3QgZGlzcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGFubm90YXRlZCA9IHJhd01zZ3NcbiAgICAvLyBEaXNwb3NpdGlvbiBmcmFtZXMgb25seSDigJQgYSBsaWZlY3ljbGUgZnJhbWUgKGFyY2hpdmUvdW5hcmNoaXZlKSBzdGF5cyBpblxuICAgIC8vIHRoZSBoaXN0b3J5IGFuIGFnZW50IHB1bGxzOyBpdCBpcyBob3cgaXQgbGVhcm5zIHRoZSBjaGFubmVsIHdhcyByZXRpcmVkLlxuICAgIC5maWx0ZXIoKG0pID0+ICFpc0Rpc3Bvc2l0aW9uRnJhbWUobSkpXG4gICAgLm1hcCgobSkgPT4ge1xuICAgICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgICAgcmV0dXJuIGQgPyB7IC4uLm0sIGRpc3Bvc2l0aW9uOiBkLmRpc3Bvc2l0aW9uLCByZW9wZW5zOiBkLnJlb3BlbnMgfSA6IG07XG4gICAgfSk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBtZXNzYWdlczogYW5ub3RhdGVkLCBjdXJzb3IgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYWQobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBpZDogbnVtYmVyLCBvcHRzOiB7IHRleHQ/OiBib29sZWFuIH0pIHtcbiAgaWYgKCFuYW1lIHx8ICFOdW1iZXIuaXNGaW5pdGUoaWQpKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHJlYWQgPGNoYW5uZWw+IDxpZD4gWy0tdGV4dF1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gQnVpbHQgb24gdGhlIGV4aXN0aW5nIHJhbmdlIGZldGNoIOKAlCBgc2luY2U9aWQtMWAgcmV0dXJucyBpZCBhbmQgYmV5b25kO1xuICAvLyB3ZSBwaWNrIHRoZSBleGFjdCBpZC4gTm8gZGFlbW9uIEFQSSBjaGFuZ2UuIFRoaXMgaXMgdGhlIHRhcmdldGVkXG4gIC8vIFwiZ2l2ZSBtZSBtZXNzYWdlIE4gaW4gZnVsbFwiIHZlcmIgdGhhdCByZWNvdmVycyBhIGNsaXBwZWQgdGFpbCBwcmV2aWV3XG4gIC8vIHdpdGhvdXQgdGhlIHB1bGwtcmFuZ2UgKyBqcSBkYW5jZS5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxNZXNzYWdlc1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiR0VUXCIsXG4gICAgYC9jaGFubmVscy8ke25hbWV9L21lc3NhZ2VzP3NpbmNlPSR7aWQgLSAxfWAsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgY29uc3QgbXNnID0gKGRhdGE/Lm1lc3NhZ2VzID8/IFtdKS5maW5kKChtKSA9PiBtLmlkID09PSBpZCk7XG4gIGlmICghbXNnKSBkaWUoYG1lc3NhZ2UgJHtpZH0gbm90IGZvdW5kIGluICR7bmFtZX1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgZGlzcE1hcCA9IGZvbGREaXNwb3NpdGlvbnMobmFtZSk7XG4gIGNvbnN0IGQgPSBkaXNwTWFwLmdldChpZCk7XG4gIGNvbnN0IGFubm90YXRlZE1zZyA9IGQgPyB7IC4uLm1zZywgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9IDogbXNnO1xuICBpZiAob3B0cy50ZXh0KSB7XG4gICAgLy8gUHJvc2UgbW9kZTogaGVhZGVyICsgYm9keSwgbm8gSlNPTiBlbnZlbG9wZSwgc28gYSBodW1hbiAob3IgYW4gYWdlbnRcbiAgICAvLyByZWNvdmVyaW5nIGEgdHJ1bmNhdGVkIG5vdGlmaWNhdGlvbikgY2FuIHJlYWQgaXQgZGlyZWN0bHkuXG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZShtc2cudHMpLnRvSVNPU3RyaW5nKCk7XG4gICAgY29uc3QgZGlzcFByZWZpeCA9IGRcbiAgICAgID8gZC5yZW9wZW5zID4gMFxuICAgICAgICA/IGBbJHtkLmRpc3Bvc2l0aW9ufSDihrske2QucmVvcGVuc31dIGBcbiAgICAgICAgOiBgWyR7ZC5kaXNwb3NpdGlvbn1dIGBcbiAgICAgIDogXCJcIjtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtkaXNwUHJlZml4fVske21zZy5pZH1dICR7bXNnLmZyb219IMK3ICR7dHN9XFxuJHttc2cudGV4dH1cXG5gKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIG1lc3NhZ2U6IGFubm90YXRlZE1zZyB9KTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kV2FpdChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICB0aW1lb3V0UzogbnVtYmVyLFxuICBhbGlhczogc3RyaW5nIHwgdW5kZWZpbmVkLFxuKSB7XG4gIGlmICghbmFtZSkgZGllKFwidXNhZ2U6IGdyYXBldmluZSB3YWl0IDxjaGFubmVsPiBbLS1hcyA8YWxpYXM+XSBbLS1zaW5jZSA8aWQ+XSBbLS10aW1lb3V0IDxzPl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gR2l2ZSB0aGUgSFRUUCBmZXRjaCBhIHNsaWdodGx5IGhpZ2hlciBhYm9ydCB0aW1lb3V0IHRoYW4gdGhlIGRhZW1vbidzXG4gIC8vIGxvbmctcG9sbCB0aW1lb3V0IHNvIHRoZSBkYWVtb24gYWx3YXlzIHdpbnMgdGhlIHRpbWVvdXQgcmFjZS5cbiAgLy8gYD9hcz08YWxpYXM+YCByZWdpc3RlcnMgcHJlc2VuY2Ugb24gdGhlIGNoYW5uZWwgZm9yIHRoZSB3YWl0IGR1cmF0aW9uIOKAlFxuICAvLyB3YWl0IGlzIGxvbmctcG9sbCAocHVzaC1zaGFwZWQgd2l0aCBhIGRlYWRsaW5lKSBzbyBpdCBkZXNlcnZlcyBwcmVzZW5jZS5cbiAgY29uc3QgYXNQYXJhbSA9IGFsaWFzID8gYCZhcz0ke2VuY29kZVVSSUNvbXBvbmVudChhbGlhcyl9YCA6IFwiXCI7XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vY2hhbm5lbHMvJHtuYW1lfS93YWl0P3NpbmNlPSR7c2luY2V9JnRpbWVvdXQ9JHt0aW1lb3V0U30ke2FzUGFyYW19YDtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7XG4gICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KCh0aW1lb3V0UyArIDUpICogMTAwMCksXG4gIH0pO1xuICBsZXQgZGF0YTogV2FpdFJlc3BvbnNlIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IChhd2FpdCByZXMuanNvbigpKSBhcyBXYWl0UmVzcG9uc2U7XG4gIH0gY2F0Y2gge31cbiAgaWYgKCFyZXMub2spIGRpZUFwaShkYXRhLCByZXMuc3RhdHVzKTtcbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBtZXNzYWdlczogZGF0YT8ubWVzc2FnZXMgPz8gW10sXG4gICAgY3Vyc29yOiBkYXRhPy5jdXJzb3IgPz8gc2luY2UsXG4gICAgdGltZWRfb3V0OiAhIWRhdGE/LnRpbWVkX291dCxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdobyhuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKCFuYW1lKSBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIHdobyA8Y2hhbm5lbD5cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIXBvcnQpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgZGFlbW9uOiBmYWxzZSwgY2hhbm5lbDogbmFtZSwgc3Vic2NyaWJlcnM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN1YnNjcmliZXJzUmVzcG9uc2U+KFxuICAgIHBvcnQsXG4gICAgXCJHRVRcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vc3Vic2NyaWJlcnNgLFxuICApO1xuICBpZiAoc3RhdHVzID49IDQwMCkgZGllQXBpKGRhdGEsIHN0YXR1cyk7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCAuLi5kYXRhIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRXaG9BbGwoKSB7XG4gIC8vIENyb3NzLWNoYW5uZWwgcm9zdGVyIOKAlCBuYW1lcyDDlyBjaGFubmVsIGluIG9uZSBjYWxsLCBzbyB5b3UgZG9uJ3QgZmFuIG91dFxuICAvLyBOIGB3aG9gIGNhbGxzICsgYSBtYW51YWwgam9pbiB0byBhbnN3ZXIgXCJ3aG8gaXMgb24gd2hpY2ggdmluZT9cIi5cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IGZhbHNlLCBjaGFubmVsczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEdldCBvciBzZXQgdGhlIHBlcnNpc3RlZCBkZWZhdWx0IGFsaWFzIChWMS43KS4gV2l0aCBubyBhcmd1bWVudCwgcHJpbnRzIHRoZVxuLy8gY3VycmVudCBhbGlhczsgd2l0aCBvbmUsIHdyaXRlcyBpdCB0byBjb25maWcuanNvbi4gUHVyZSBmaWxlIEkvTyDigJQgd29ya3Ncbi8vIHdpdGhvdXQgYSBydW5uaW5nIGRhZW1vbi4gVGhlIHdhdGNoIHN1cmZhY2UgcmVhZHMgaXQgdmlhIEdFVCAvaWRlbnRpdHkgc28gdGhlXG4vLyBodW1hbiBoYXMgYSBjb25zaXN0ZW50IG5hbWUgYWNyb3NzIGV2ZXJ5IGdyYXBldmluZS5cbmFzeW5jIGZ1bmN0aW9uIGNtZEFsaWFzKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBsZXQgY2ZnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9O1xuICB0cnkge1xuICAgIGNmZyA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKENPTkZJR19GSUxFLCBcInV0Zi04XCIpKTtcbiAgfSBjYXRjaCB7fVxuICBpZiAobmFtZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgYWxpYXMgPSB0eXBlb2YgY2ZnLmFsaWFzID09PSBcInN0cmluZ1wiICYmIGNmZy5hbGlhcy50cmltKCkgPyBjZmcuYWxpYXMudHJpbSgpIDogbnVsbDtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgYWxpYXMgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHRyaW1tZWQgPSBuYW1lLnRyaW0oKTtcbiAgY2ZnLmFsaWFzID0gdHJpbW1lZDtcbiAgbWtkaXJTeW5jKERBVEFfRElSLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgd3JpdGVGaWxlU3luYyhDT05GSUdfRklMRSwgYCR7SlNPTi5zdHJpbmdpZnkoY2ZnLCBudWxsLCAyKX1cXG5gKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGFsaWFzOiB0cmltbWVkIHx8IG51bGwgfSk7XG59XG5cbi8qKlxuICogVGhlIHN0YW5kaW5nIHRhaWwg4oCUIGBzcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50c2AsIGFkb3B0ZWQgYXQgUGhhc2UgNiBjaGFwdGVyIDIuXG4gKlxuICog4puUIFdIQVQgVEhJUyBSRVBMQUNFRCwgQU5EIFdIQVQgSVQgQk9VR0hULiBUaGlzIHZlcmIgd2FzIDIyMCBsaW5lcyBvZlxuICogaGFuZC13cml0dGVuIHJlY29ubmVjdCBsb29wOiB0aHJlZSBuZXN0ZWQgbG9vcHMgKHJlY29ubmVjdCAvIHJlYWQgLyBmcmFtZVxuICogZHJhaW4pLCBpdHMgb3duIFNTRSBzcGxpdHRlciwgaXRzIG93biBiYWNrb2ZmLCBhbmQgYSBgcHJvY2Vzcy5leGl0KDApYCBpbiBhXG4gKiBzaWduYWwgaGFuZGxlciBzZXZlbiBsaW5lcyBpbi4gVGhlIHNoYXJlZCBjbGllbnQgaXMgdGhlIHNhbWUgZGVzaWduLCBvbmNlLCBhbmRcbiAqIHRocmVlIHRoaW5ncyBhcnJpdmUgd2l0aCBpdCB0aGF0IGdyYXBldmluZSBkaWQgbm90IGhhdmU6XG4gKlxuICogICAxLiAqKkFOIElETEUgV0FUQ0hET0cg4oCUIGdyYXBldmluZSBoYWQgTk9ORS4qKiBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgd2FzXG4gKiAgICAgIHVuYm91bmRlZCwgc28gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kIG9yIGFcbiAqICAgICAgU0lHS0lMTGVkIGRhZW1vbiBwYXJrZWQgdGhlIHRhaWwgRk9SRVZFUiwgYW5kIGEgcGFya2VkIHRhaWwgaXNcbiAqICAgICAgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHF1aWV0IGNoYW5uZWwuIGBUQUlMX0lETEVfTVNgIGlzIHRocmVlIG9mIFRISVNcbiAqICAgICAgc3BlbGwncyAzIHMgYmVhdHMgKGAuL2hlYXJ0YmVhdC50c2ApLCBuZXZlciBhIGNvcGllZCA0NSwwMDAuXG4gKiAgIDIuICoqQSBTUEVDLUNPUlJFQ1QgRlJBTUUgUEFSU0VSLioqIFRoZSBoYW5kLXdyaXR0ZW4gb25lIGRpZFxuICogICAgICBgbGluZS5zbGljZSg1KS50cmltKClgLCB3aGljaCBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gdGhlIG9uZVxuICogICAgICBsZWFkaW5nIHNwYWNlIHRoZSBzcGVjIHJlbW92ZXMg4oCUIGl0IHdvdWxkIGNvcnJ1cHQgYSBtZXNzYWdlIGJvZHkgd2hvc2VcbiAqICAgICAgZmlyc3QgbGluZSBpcyBpbmRlbnRlZC4gTm90aGluZyBpbiB0aGUgcm9zdGVyIGVtaXRzIG9uZSB0b2RheTsgdGhlIHBhcnNlXG4gKiAgICAgIGlzIHJpZ2h0IGFueXdheSBub3cuXG4gKiAgIDMuICoqQSBTSUdOQUwgUEFUSCBUSEFUIERSQUlOUy4qKiBUaGUgb2xkIGhhbmRsZXIgd2FzXG4gKiAgICAgIGBzdG9wcGVkID0gdHJ1ZTsgcHJvY2Vzcy5leGl0KDApYCDigJQgdGhlIFAwZiBkZWZlY3QgZXhhY3RseSwgYXBwbGllZCB0b1xuICogICAgICB0aGUgdGVybWluYWwgZnJhbWUgaW4gZml2ZSBzcGVsbHMgYW5kIE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlXG4gKiAgICAgIGxpbmVzIGFib3ZlIGl0LiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZFxuICogICAgICBzdGRvdXQuIFRoZSBjbGllbnQgUkVUVVJOUyBhbiBleGl0IGNvZGU7IGBtYWluYCBhc3NpZ25zIGl0IGFuZCByZXR1cm5zXG4gKiAgICAgIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucy5cbiAqXG4gKiDim5QgTk8gYGVwb2NoT2ZgIC8gYG9uRXBvY2hDaGFuZ2VgLCBBTkQgVEhBVCBJUyBBIFJVTElORywgTk9UIEFOIE9NSVNTSU9OXG4gKiAoRDcwKS4gR3JhcGV2aW5lJ3MgaWRzIGFyZSBSRUNPVkVSRUQgYWNyb3NzIGEgcmVzdGFydCDigJQgYGxvYWRDaGFubmVsKClgXG4gKiBkZXJpdmVzIGBuZXh0X2lkYCBhcyBhIGhpZ2gtd2F0ZXIgbWFyayBvdmVyIHRoZSBkdXJhYmxlIGAuanNvbmxgIOKAlCBzbyBhXG4gKiByZWNvbm5lY3RpbmcgY3Vyc29yIGlzIHN0aWxsIHZhbGlkIGFuZCB0aGUgY29uZGl0aW9uIGFuIGVwb2NoIGRldGVjdHMgY2Fubm90XG4gKiBvY2N1ciBoZXJlLiBXaXJpbmcgb25lIHdvdWxkIGJlIGEgUkVHUkVTU0lPTiB3aXRoIGEgbWVhc3VyZWQgbWVjaGFuaXNtOlxuICogYG9uRXBvY2hDaGFuZ2VgIHNldHMgYGN1cnNvciA9IDBgLCBhbmQgdGhpcyBkYWVtb24gYW5zd2VycyBgc2luY2U9MGAgd2l0aFxuICogYHJlYWRCYWNrbG9nKG5hbWUsIDApYCDigJQgdGhlIHdob2xlIGNoYW5uZWwgbG9nIG9mZiBkaXNrLCBpbnRvIGFuIGFnZW50J3MgcGlwZSxcbiAqIG9uIGV2ZXJ5IGBncmFwZXZpbmUgcm9sbGAuXG4gKlxuICog4pqgIGByZXNvbHZlYCBDQUxMUyBgZW5zdXJlRGFlbW9uYCwgV0hJQ0ggQ0FOIFJBSVNFIOKAlCBkZWxpYmVyYXRlbHksIGFuZCB0aGUga2l0XG4gKiBkb2N1bWVudHMgdGhlIHByb3BlcnR5IHRoaXMgZGVwZW5kcyBvbjogaXRzIG91dGVyIGJsb2NrIGlzIGEgYHRyeWAvYGZpbmFsbHlgXG4gKiB3aXRoIE5PIGBjYXRjaGAsIHNvIGEgYENsaUVycm9yYCBmcm9tIHRocmVlIGZyYW1lcyBkb3duIHByb3BhZ2F0ZXMgaW50b1xuICogYG1haW5gIGluc3RlYWQgb2YgYmVpbmcgcmVhZCBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmQgcmV0cmllZCBmb3JldmVyLlxuICogQ2hlY2tlZCBhdCB0aGUgYWRvcHRpb24gcmF0aGVyIHRoYW4gYXNzdW1lZCAocGxheWJvb2sgQjkgc3RlcCA1KS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgbmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBvcHRzOiB7XG4gICAgc2luY2U/OiBudW1iZXI7XG4gICAgZnJvbVN0YXJ0PzogYm9vbGVhbjtcbiAgICBsYXN0PzogbnVtYmVyO1xuICAgIGFzPzogc3RyaW5nO1xuICAgIGh1bWFuPzogYm9vbGVhbjtcbiAgICBsdXJrPzogYm9vbGVhbjtcbiAgICBtYXg/OiBudW1iZXI7XG4gIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIW5hbWUpXG4gICAgZGllKFxuICAgICAgXCJ1c2FnZTogZ3JhcGV2aW5lIHRhaWwgPG5hbWU+IFstLWFzIDxhbGlhcz5dIFstLXNpbmNlIDxpZD5dIFstLWZyb20tc3RhcnRdIFstLWxhc3QgPG4+XSBbLS1odW1hbl0gWy0tbHVya10gWy0tbWF4IDxuPl1cIixcbiAgICApO1xuICAvLyAtLWx1cmsgcmVjZWl2ZXMgbWVzc2FnZXMgYnV0IHJlZ2lzdGVycyBubyBwcmVzZW5jZSDigJQgYW4gaW52aXNpYmxlIG9ic2VydmVyLlxuICAvLyBJdCBvdmVycmlkZXMgaWRlbnRpdHkgZmxhZ3MgKGEgbHVya2VyIGhhcyBubyBuYW1lIHRvIHNob3cpLlxuICBjb25zdCBteUFsaWFzID0gb3B0cy5sdXJrID8gdW5kZWZpbmVkIDogb3B0cy5hcztcbiAgY29uc3Qgc2luY2UgPSBvcHRzLmZyb21TdGFydCA/IDAgOiAob3B0cy5zaW5jZSA/PyAtMSk7XG4gIC8vIEVtaXQgdGhlIGdyb3VuZGluZyBsaW5lIG9ubHkgb24gdGhlIGZpcnN0IHN1YnNjcmliZSwgbmV2ZXIgb24gcmVjb25uZWN0c1xuICAvLyAoYSByZWNvbm5lY3QgcmVzdW1lcyBmcm9tIHRoZSBjdXJzb3Ig4oCUIHRoZXJlIGlzIG5vIHVuc2VlbiBoaXN0b3J5IHRoZW4pLlxuICAvLyDim5QgQU5EIE5FVkVSIE9OIEEgYC0tc2luY2VgIFJFLUFSTSAoYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCwgQTMpOiB0aGVcbiAgLy8gYWdlbnQgYWxyZWFkeSBrbm93cyB0aGUgY2hhbm5lbCwgYW5kIHRoZSBoaXN0b3J5IGhpbnQgd291bGQgYmUgbm9pc2UuXG4gIGxldCBncm91bmRlZCA9IG9wdHMuc2luY2UgIT09IHVuZGVmaW5lZDtcbiAgLy8g4puUIFRIRSBCT09LTUFSSyBGT1IgQSBMSVZFLU9OTFkgVEFJTC4gYHNpbmNlID0gLTFgIGFza3MgZm9yIG5vIGhpc3RvcnksIHNvIGFcbiAgLy8gdGFpbCB0aGF0IHNlZXMgbm8gbWVzc2FnZSBoYXMgbm8gaWQgdG8gaGFuZCBpdHMgcmUtYXJtLCBhbmQgdGhlIHJlLWFybVxuICAvLyB3b3VsZCBtaXNzIGV2ZXJ5dGhpbmcgc2VudCBpbiB0aGUgZ2FwLiBUaGUgYHN1YnNjcmliZWRgIG1hcmtlciBjYXJyaWVzIHRoZVxuICAvLyBjaGFubmVsJ3MgYGxhdGVzdF9pZGA6IHNlZWRpbmcgdGhlIGN1cnNvciBmcm9tIGl0IG1ha2VzIHRoZSBoYW5kb2ZmJ3NcbiAgLy8gYC0tc2luY2VgIGV4YWN0LiBPbmx5IGZvciBhIGxpdmUtb25seSBzdGFydCDigJQgYSBiYWNrZmlsbGluZyBvbmUgKGAtLWxhc3RgLFxuICAvLyBgLS1mcm9tLXN0YXJ0YCwgYC0tc2luY2VgKSBpcyBzdGlsbCByZWFkaW5nIGlkcyBhdCBvciBiZWxvdyBpdCwgYW5kIGFcbiAgLy8gcmVjb25uZWN0IG1pZC1iYWNrZmlsbCBtdXN0IG5vdCBza2lwIHBhc3QgdGhlbS5cbiAgLy8gT25jZTogYSBsYXRlciBtYXJrZXIgKGEgcmVjb25uZWN0KSBtdXN0IG5vdCBqdW1wIHRoZSBjdXJzb3IgcGFzdCBtZXNzYWdlc1xuICAvLyBpdHMgb3duIGJhY2tsb2cgaXMgYWJvdXQgdG8gcmVwbGF5LlxuICBsZXQgc2VlZEZyb21NYXJrZXIgPSBzaW5jZSA8IDAgJiYgb3B0cy5sYXN0ID09PSB1bmRlZmluZWQ7XG5cbiAgLy8g4puUIEEgUFJFU0VOQ0UgU1BFTEw6IHRoZSBjb25uZWN0aW9uIElTIGB3aG9gJ3MgcHJlc2VuY2UsIHNvIHRoZSB3aW5kb3dcbiAgLy8gYWx3YXlzIG5hbWVzIHRoZSBNb25pdG9yIHJlLWFybSwgbmV2ZXIgdGhlIHN0b3Atc3RhcnQgYC0tb25jZWAsIGFuZCBhIGxvc3RcbiAgLy8gZGFlbW9uIGlzIHJldHJpZWQgKGByZXNvbHZlYCByZXNwYXducyBpdCksIG5vdCByZXBvcnRlZC5cbiAgY29uc3QgYWdhaW4gPSAoYXQ6IG51bWJlcikgPT5cbiAgICBjb21tYW5kTGluZShbXG4gICAgICBcInRhaWxcIixcbiAgICAgIG5hbWUsXG4gICAgICAuLi4ob3B0cy5sdXJrID8gW1wiLS1sdXJrXCJdIDogbXlBbGlhcyA/IFtcIi0tYXNcIiwgbXlBbGlhc10gOiBbXSksXG4gICAgICAuLi4ob3B0cy5odW1hbiAmJiAhb3B0cy5sdXJrID8gW1wiLS1odW1hblwiXSA6IFtdKSxcbiAgICAgIC4uLihvcHRzLm1heCAhPT0gdW5kZWZpbmVkID8gW1wiLS1tYXhcIiwgU3RyaW5nKG9wdHMubWF4KV0gOiBbXSksXG4gICAgICAvLyBgLS1zaW5jZWAgdGFrZXMgbm8gbmVnYXRpdmUgaGVyZTsgYSB0YWlsIHRoYXQgbmV2ZXIgbGVhcm5lZCBhbiBpZFxuICAgICAgLy8gcmUtYXJtcyBsaXZlLW9ubHksIHdoaWNoIGlzIHdoYXQgLTEgbWVhbnQuXG4gICAgICAuLi4oYXQgPj0gMCA/IFtcIi0tc2luY2VcIiwgU3RyaW5nKGF0KV0gOiBbXSksXG4gICAgXSk7XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxXaXRoSGFuZG9mZjxUYWlsUGF5bG9hZD4oXG4gICAge1xuICAgICAgLy8g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRC4gQSB0YWlsIG91dGxpdmVzXG4gICAgICAvLyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCDigJQgYHJvbGxgIGFuZCBgcmVzdGFydGAgYm90aCByZXBsYWNlIGl0IOKAlCBhbmRcbiAgICAgIC8vIGBlbnN1cmVEYWVtb25gIHJlLXJlYWRzIHRoZSBwb3J0IGZpbGUgYW5kIHJlc3Bhd25zLCBzbyBhIHJlY29ubmVjdCBhZnRlciBhXG4gICAgICAvLyByb2xsIGxhbmRzIG9uIHRoZSBORVcgZGFlbW9uIHJhdGhlciB0aGFuIHNwaW5uaW5nIGFnYWluc3QgYSBkZWFkIHBvcnQuXG4gICAgICByZXNvbHZlOiBhc3luYyAoKSA9PiBgaHR0cDovLzEyNy4wLjAuMToke2F3YWl0IGVuc3VyZURhZW1vbigpfWAsXG4gICAgICBwYXRoOiBgL2NoYW5uZWxzLyR7bmFtZX0vdGFpbGAsXG4gICAgICBzaW5jZSxcbiAgICAgIC8vIOKaoCBOTyBlbnN1cmUgY2FsbCBiZWZvcmUgdGhlIHN1YnNjcmliZS4gQSBmcmVzaCBgdGFpbCBuYW1lYCBzdGlsbCB3b3Jrc1xuICAgICAgLy8gd2l0aG91dCBhbiBleHBsaWNpdCBvcGVuIOKAlCBHRVQg4oCmL3RhaWwgY3JlYXRlcyB0aGUgY2hhbm5lbCBpdHNlbGYg4oCUIGFuZFxuICAgICAgLy8gdGhhdCBpcyB0aGUgT05MWSB3YXkgdGhlIHN1YnNjcmliZWQgZXZlbnQncyBgY3JlYXRlZGAgZmxhZyBjYW4gZXZlciBiZVxuICAgICAgLy8gdHJ1ZTogYW4gZW5zdXJlIHNlbnQgZmlyc3QgY3JlYXRlcyB0aGUgY2hhbm5lbCwgc28gdGhlIHN1YnNjcmliZSB0aGF0XG4gICAgICAvLyBmb2xsb3dzIGFsd2F5cyByZXBvcnRzIGBjcmVhdGVkOmZhbHNlYCBhbmQgdGhlIG1pc3R5cGVkLW5hbWUgc2lnbmFsIG5ldmVyXG4gICAgICAvLyBmaXJlcy5cbiAgICAgIHF1ZXJ5OiAoY3Vyc29yLCBmaXJzdENvbm5lY3QpID0+IHtcbiAgICAgICAgY29uc3QgcTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICAgIC8vICM2OCDigJQgYC0tbGFzdCBOYCByaWRlcyB0aGUgRklSU1QgY29ubmVjdGlvbiBvbmx5LiBPbmNlIGFueSBtZXNzYWdlXG4gICAgICAgIC8vIGxhbmRzIHRoZSBjdXJzb3IgYWR2YW5jZXMgYW5kIGEgcmVjb25uZWN0IHJlc3VtZXMgZnJvbSBpdCB2aWEgYHNpbmNlYCxcbiAgICAgICAgLy8gbmV2ZXIgcmUtYmFja2ZpbGxpbmcgdGhlIHdpbmRvdy4gYGZpcnN0Q29ubmVjdGAgaXMgdGhlIGtpdCdzIHBhcmFtZXRlclxuICAgICAgICAvLyBmb3IgZXhhY3RseSB0aGlzOyB0aGUgaGFuZC13cml0dGVuIGxvb3Agc3BlbGxlZCBpdCBgaGlnaGVzdFNlZW4gPCAwYCxcbiAgICAgICAgLy8gd2hpY2ggd2FzIHRoZSBzYW1lIHRlc3QgYnkgYWNjaWRlbnQgb2YgdGhlIHNlbnRpbmVsLlxuICAgICAgICBpZiAob3B0cy5sYXN0ICE9PSB1bmRlZmluZWQgJiYgZmlyc3RDb25uZWN0KSBxLmxhc3QgPSBTdHJpbmcob3B0cy5sYXN0KTtcbiAgICAgICAgaWYgKG15QWxpYXMpIHEuYXMgPSBteUFsaWFzO1xuICAgICAgICBpZiAob3B0cy5odW1hbiAmJiAhb3B0cy5sdXJrKSBxLmh1bWFuID0gXCIxXCI7XG4gICAgICAgIGlmIChvcHRzLmx1cmspIHEubHVyayA9IFwiMVwiO1xuICAgICAgICByZXR1cm4gcTtcbiAgICAgIH0sXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGlmICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIpIHJldHVybiBldi5pZDtcbiAgICAgICAgaWYgKHNlZWRGcm9tTWFya2VyICYmIHR5cGVvZiBldi5sYXRlc3RfaWQgPT09IFwibnVtYmVyXCIpIHtcbiAgICAgICAgICBzZWVkRnJvbU1hcmtlciA9IGZhbHNlO1xuICAgICAgICAgIHJldHVybiBldi5sYXRlc3RfaWQ7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH0sXG4gICAgICBhY2NlcHQ6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgLy8gVGhlIHN1YnNjcmliZWQgbWFya2VyIGlzIG5vdCBhIG1lc3NhZ2U7IGByZW5kZXJgIGFuc3dlcnMgaXQuXG4gICAgICAgIGlmIChmcmFtZS5ldmVudCA9PT0gXCJzdWJzY3JpYmVkXCIpIHJldHVybiB0cnVlO1xuICAgICAgICAvLyBEcm9wIERJU1BPU0lUSU9OIGZyYW1lcyDigJQgdGhleSBhcmUgbWV0YWRhdGEgYWJvdXQgYW5vdGhlciBtZXNzYWdlLiBBXG4gICAgICAgIC8vIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpIHBhc3NlcyB0aHJvdWdoOiBhbiBhZ2VudCB0YWlsaW5nIGFcbiAgICAgICAgLy8gY2hhbm5lbCBjb3VsZCBub3QgcHJldmlvdXNseSBzZWUgZWl0aGVyIHBhcnR5IHJldGlyZSBpdCwgYW5kIGZvdW5kIG91dFxuICAgICAgICAvLyB3aGVuIGl0cyBuZXh0IHNlbmQgd2FzIHJlamVjdGVkLlxuICAgICAgICBpZiAoaXNEaXNwb3NpdGlvbkZyYW1lKGV2KSkgcmV0dXJuIGZhbHNlO1xuICAgICAgICAvLyBTdXBwcmVzcyBzZWxmLWVjaG86IHdoZW4gLS1hcyBpcyBzZXQsIGRyb3AgbWVzc2FnZXMgd2Ugc2VudCBvdXJzZWx2ZXMuXG4gICAgICAgIC8vIFRoZSBzZW5kZXIgYWxyZWFkeSBnb3QgdGhlIHJlY2VpcHQgYXMgdGhlIFBPU1QgcmVzcG9uc2UsIHNvIHJlLWVtaXR0aW5nXG4gICAgICAgIC8vIGl0IG9uIHRhaWwgaXMgcHVyZSBub2lzZS5cbiAgICAgICAgaWYgKG15QWxpYXMgJiYgZXYuZnJvbSA9PT0gbXlBbGlhcykgcmV0dXJuIGZhbHNlO1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChwYXlsb2FkLCBmcmFtZSkgPT4ge1xuICAgICAgICBpZiAoZnJhbWUuZXZlbnQgPT09IFwic3Vic2NyaWJlZFwiKSByZXR1cm4gcmVuZGVyU3Vic2NyaWJlZChwYXlsb2FkKTtcbiAgICAgICAgLy8gIzY3IOKAlCBmcm9udC1sb2FkIGEgcmVjb3ZlcnkgcG9pbnRlciBvbiBFVkVSWSBtZXNzYWdlIGZyYW1lLCBzbyB0aGUgcmVhZFxuICAgICAgICAvLyBjb29yZGluYXRlcyBzdXJ2aXZlIGEgZG93bnN0cmVhbSBub3RpZmljYXRpb24gY2xpcC4gTW9uaXRvciB0cnVuY2F0ZXMgYXRcbiAgICAgICAgLy8gaXRzIE9XTiBjYXAgKGJlbG93IG91ciBoaW50IHRocmVzaG9sZCwgYW5kIG9uZSB3ZSBjYW5ub3Qgb2JzZXJ2ZSBoZXJlKTsgYVxuICAgICAgICAvLyBtZXNzYWdlIGl0IGNsaXBzIHdvdWxkIG90aGVyd2lzZSBsb3NlIGl0cyB0cmFpbGluZyBgaWRgIGFuZCBiZWNvbWVcbiAgICAgICAgLy8gdW5yZWNvdmVyYWJsZSDigJQgdGhlIHJlYWRlciBpcyBsZWZ0IGluZmVycmluZyB0aGUgaWQuIEV2ZXJ5IGZyYW1lXG4gICAgICAgIC8vIHRoZXJlZm9yZSBjYXJyaWVzIGEgRlJPTlQtbG9hZGVkIGByZWFkIDxjaGFubmVsPiA8aWQ+YCwgZWl0aGVyIGFzIHRoZVxuICAgICAgICAvLyByaWNoZXIgYHRydW5jYXRpb25faGludGAgKGdlbnVpbmVseS1sb25nIG1lc3NhZ2VzIOKAlCB0aGUgXCIrTiBjaGFycyxcbiAgICAgICAgLy8geW91J3JlIGRlZmluaXRlbHkgbWlzc2luZyBjb250ZW50XCIgYWxhcm0pIG9yIGFzIHRoZSBjb21wYWN0IGBmdWxsYFxuICAgICAgICAvLyBwb2ludGVyLiBTZXJpYWxpemluZyBpdCBiZWZvcmUgdGhlIGxvbmcgYC50ZXh0YCBpcyB3aGF0IG1ha2VzIGl0IHN1cnZpdmVcbiAgICAgICAgLy8gdGhlIGNsaXAgKEYxNykuXG4gICAgICAgIGNvbnN0IHJlYWRSZWYgPSBgcmVhZCAke25hbWV9ICR7cGF5bG9hZC5pZH1gO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgdHlwZW9mIHBheWxvYWQudGV4dCA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICAgIHBheWxvYWQudGV4dC5sZW5ndGggPiAob3B0cy5tYXggPz8gVFJVTkNBVElPTl9ISU5UX1RIUkVTSE9MRClcbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc3QgdHJ1bmNhdGlvbl9oaW50ID0gYCske3BheWxvYWQudGV4dC5sZW5ndGh9IGNoYXJzIOKAlCBmdWxsOiAke3JlYWRSZWZ9YDtcbiAgICAgICAgICAvLyBDYXAgdGhlIElOTElORSBib2R5IHdoZW4gLS1tYXggaXMgc2V0ICh0aGUgZnVsbCBtZXNzYWdlIHN0YXlzIG9uIGRpc2tcbiAgICAgICAgICAvLyDihpIgYHJlYWRgKTsgd2l0aG91dCAtLW1heCwgZW1pdCB0aGUgZnVsbCB0ZXh0ICh0b2RheSdzIGRlZmF1bHQpLlxuICAgICAgICAgIGNvbnN0IHRleHQgPSBvcHRzLm1heCAhPT0gdW5kZWZpbmVkID8gcGF5bG9hZC50ZXh0LnNsaWNlKDAsIG9wdHMubWF4KSA6IHBheWxvYWQudGV4dDtcbiAgICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyB0cnVuY2F0aW9uX2hpbnQsIC4uLnBheWxvYWQsIHRleHQgfSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgZnVsbDogcmVhZFJlZiwgLi4ucGF5bG9hZCB9KTtcbiAgICAgIH0sXG4gICAgICAvLyBEYWVtb24gbGl2ZW5lc3MgaGVhcnRiZWF0IChgOiBoYiA8dHM+YCkuIFN1cmZhY2UgYSByZWNvZ25pemFibGUgc2VudGluZWxcbiAgICAgIC8vIG9uIHN0ZGVyciBzbyBhIGAyPiYxYCBjb25zdW1lciBjYW4gdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIgKEY2KS4gS2VwdFxuICAgICAgLy8gb2ZmIHN0ZG91dCDigJQgdGhlIEpTT05MIHN0cmVhbSBzdGF5cyBwdXJlLlxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4gKHRleHQudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcImhiXCIpID8gXCI6IGdyYXBldmluZS1rZWVwYWxpdmVcIiA6IG51bGwpLFxuICAgICAgb25NYWxmb3JtZWQ6IChfZnJhbWUsIGUpID0+IGAjIGJhZCBzc2UgZGF0YTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCxcbiAgICAgIC8vIFRoZSBmb3VyIGxpbmVzIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcCB3cm90ZSwgcHJlc2VydmVkIHZlcmJhdGltIOKAlCBhIHRhaWxcbiAgICAgIC8vIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlIGZyb20gb25lIHRoYXQgaXMgd29ya2luZy5cbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgc3dpdGNoIChpbmZvLmNhdXNlKSB7XG4gICAgICAgICAgY2FzZSBcImNvbm5lY3QtZmFpbGVkXCI6XG4gICAgICAgICAgICByZXR1cm4gYCMgY29ubmVjdCBmYWlsZWQ6ICR7aW5mby5lcnJvciBpbnN0YW5jZW9mIEVycm9yID8gaW5mby5lcnJvci5tZXNzYWdlIDogU3RyaW5nKGluZm8uZXJyb3IpfSwgcmV0cnlpbmfigKZgO1xuICAgICAgICAgIGNhc2UgXCJodHRwXCI6XG4gICAgICAgICAgY2FzZSBcIm5vLWJvZHlcIjpcbiAgICAgICAgICAgIHJldHVybiBgIyB0YWlsIEhUVFAgJHtpbmZvLnN0YXR1c30sIHJldHJ5aW5n4oCmYDtcbiAgICAgICAgICBjYXNlIFwic3RyZWFtLWVycm9yXCI6XG4gICAgICAgICAgICByZXR1cm4gYCMgc3RyZWFtIGRyb3BwZWQ6ICR7aW5mby5lcnJvciBpbnN0YW5jZW9mIEVycm9yID8gaW5mby5lcnJvci5tZXNzYWdlIDogU3RyaW5nKGluZm8uZXJyb3IpfSwgcmVjb25uZWN0aW5n4oCmYDtcbiAgICAgICAgICBjYXNlIFwic3RyZWFtLWVuZFwiOlxuICAgICAgICAgICAgcmV0dXJuIFwiIyBzdHJlYW0gY2xvc2VkLCByZWNvbm5lY3RpbmfigKZcIjtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgIH0sXG4gICAge1xuICAgICAgc3BlbGw6IFwiZ3JhcGV2aW5lXCIsXG4gICAgICBtb2RlOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogdHJ1ZSxcbiAgICAgIC8vIEQ0OiBhIGh1bWFuIGF0IGEgdGVybWluYWwgKGAtLWh1bWFuYCkgaXMgbm90IGFuIGFnZW50IHVuZGVyXG4gICAgICAvLyBNb25pdG9yJ3MgY2FwLCBzbyB0aGVpciB3YXRjaCBuZXZlciBlbmRzIGJ5IGl0c2VsZi5cbiAgICAgIC4uLihvcHRzLmh1bWFuID8geyB3aW5kb3dNczogMCB9IDoge30pLFxuICAgICAgLy8gVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXIgKGFuZCB0aGUgZ3JvdW5kaW5nIGxpbmUgaXQgcmVuZGVycykgaXMgbm90IGFcbiAgICAgIC8vIG1lc3NhZ2Ugb24gdGhlIGNoYW5uZWwuXG4gICAgICBjb3VudHM6IChfZXYsIGZyYW1lKSA9PiBmcmFtZS5ldmVudCAhPT0gXCJzdWJzY3JpYmVkXCIsXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQgfSkgPT4gYWdhaW4oYXQpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wiZG9jdG9yXCJdKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcblxuICAvKiogVGhlIGBzdWJzY3JpYmVkYCBtYXJrZXI6IHN0ZGVyciBjb250ZXh0LCBwbHVzIGEgc3RydWN0dXJlZCBncm91bmRpbmcgbGluZVxuICAgKiAgb24gc3Rkb3V0IHRoZSBGSVJTVCB0aW1lIG9ubHkuICovXG4gIGZ1bmN0aW9uIHJlbmRlclN1YnNjcmliZWQocGF5bG9hZDogVGFpbFBheWxvYWQpOiBzdHJpbmcgfCBudWxsIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgIyBzdWJzY3JpYmVkIHRvICR7cGF5bG9hZC5jaGFubmVsfSAoc2luY2U9JHtwYXlsb2FkLnNpbmNlfSlcXG5gKTtcbiAgICBpZiAocGF5bG9hZC50b3BpYykgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgdG9waWM6ICR7cGF5bG9hZC50b3BpY31cXG5gKTtcbiAgICBpZiAocGF5bG9hZC5jcmVhdGVkKVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgIGAjIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCB0aGlzIHRhaWwgYnJvdWdodCBpdCBpbnRvIGJlaW5nIChjaGVjayB0aGUgbmFtZSlcXG5gLFxuICAgICAgKTtcbiAgICBpZiAocGF5bG9hZC5hcmNoaXZlZClcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICBgIyAke3BheWxvYWQuY2hhbm5lbH0gaXMgYXJjaGl2ZWQg4oCUIHJlYWQtb25seTsgYSBzZW5kIHdpbGwgYmUgcmVqZWN0ZWRcXG5gLFxuICAgICAgKTtcbiAgICAvLyBTdHJ1Y3R1cmVkIGdyb3VuZGluZyBvbiBzdGRvdXQgKEYzL0Y3KSDigJQgdW5kZXIgdGhlIGRlZmF1bHQgV2lyaW5nLUJcbiAgICAvLyBNb25pdG9yLCBzdGRvdXQgc3VyZmFjZXMgYXMgbm90aWZpY2F0aW9ucywgc28gYSBmcmVzaCBzdWJzY3JpYmVyIGFjdHVhbGx5XG4gICAgLy8gc2VlcyB0aGUgdG9waWMgKyB0aGF0IGVhcmxpZXIgaGlzdG9yeSBleGlzdHMuIEdhdGVkOiBvbmx5IHdoZW4gdGhlcmUnc1xuICAgIC8vIHNvbWV0aGluZyB0byBncm91bmQgKHVuc2VlbiBoaXN0b3J5IG9yIGEgdG9waWMpLCBhbmQgb25seSBvbiB0aGUgZmlyc3RcbiAgICAvLyBzdWJzY3JpYmUgKG5vdCByZWNvbm5lY3RzKS5cbiAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICBjb25zdCBsYXRlc3QgPSB0eXBlb2YgcGF5bG9hZC5sYXRlc3RfaWQgPT09IFwibnVtYmVyXCIgPyBwYXlsb2FkLmxhdGVzdF9pZCA6IDA7XG4gICAgY29uc3QgZWFybGllciA9IHNpbmNlIDwgMCA/IGxhdGVzdCA6IE1hdGgubWF4KDAsIE1hdGgubWluKHNpbmNlLCBsYXRlc3QpKTtcbiAgICAvLyBgY3JlYXRlZGAgYW5kIGBhcmNoaXZlZGAgam9pbiB0aGUgZ2F0ZSBvbiBwdXJwb3NlLiBBIGNoYW5uZWwgdGhpc1xuICAgIC8vIHN1YnNjcmliZSBqdXN0IG1hZGUgaGFzIG5vIHRvcGljIGFuZCBubyBoaXN0b3J5LCBzbyB0aGUgb2xkIGNvbmRpdGlvblxuICAgIC8vIChgZWFybGllciA+IDAgfHwgdG9waWNgKSBpcyBleGFjdGx5IHRoZSBjYXNlIHRoYXQgZW1pdHMgTk9USElORzsgYW5kIGFuXG4gICAgLy8gQVJDSElWRUQgY2hhbm5lbCdzIGdyb3VuZGluZyBsaW5lIHdhcyBpbmRpc3Rpbmd1aXNoYWJsZSBmcm9tIGEgaGVhbHRoeVxuICAgIC8vIG9uZSdzLCBzbyBhIGxhdGUgam9pbmVyIHN0aWxsIGxlYXJuZWQgdGhlIGNoYW5uZWwgd2FzIHJldGlyZWQgb25seSB3aGVuXG4gICAgLy8gaXRzIHNlbmQgYm91bmNlZC5cbiAgICAvL1xuICAgIC8vIOKaoCBUaGUgaGludHMgQUNDVU1VTEFURSBpbnRvIGEgbGlzdCByYXRoZXIgdGhhbiBhc3NpZ25pbmcgdG8gb25lIGZpZWxkLlxuICAgIC8vIFRoZXkgdXNlZCB0byBiZSB0aHJlZSBhc3NpZ25tZW50cyB0byBgZ3JvdW5kaW5nLmhpbnRgLCBvcmRlcmVkIHNvIHRoZSBtb3N0XG4gICAgLy8gaW1wb3J0YW50IHdvbiDigJQgd2hpY2ggaXMgYSBoaW50IHRoYXQgY2FuIHNpbGVudGx5IGxvc2UgdG8gYW5vdGhlciBoaW50LFxuICAgIC8vIHRoZSBmYWlsdXJlIG1vZGUgdGhpcyB3aG9sZSBicmFuY2ggaXMgYWJvdXQsIHNpdHRpbmcgaW4gdGhlIGZpeCBmb3IgaXQuIEFcbiAgICAvLyBsaXN0IGNhbm5vdCBvdmVyd3JpdGU6IGFuIGFyY2hpdmVkIGNoYW5uZWwgV0lUSCBoaXN0b3J5IG5vdyBzYXlzIGJvdGguXG4gICAgY29uc3QgaGludHM6IHN0cmluZ1tdID0gW107XG4gICAgaWYgKGVhcmxpZXIgPiAwKVxuICAgICAgaGludHMucHVzaChcbiAgICAgICAgYCR7ZWFybGllcn0gZWFybGllciBtZXNzYWdlKHMpIGV4aXN0IOKAlCB1c2UgLS1mcm9tLXN0YXJ0IG9yIC0tc2luY2UgPGlkPiB0byBiYWNrZmlsbGAsXG4gICAgICApO1xuICAgIGlmIChwYXlsb2FkLmNyZWF0ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgdGhpcyB0YWlsIGNyZWF0ZWQgJHtwYXlsb2FkLmNoYW5uZWx9IOKAlCBubyBzdWNoIGNoYW5uZWwgZXhpc3RlZDsgY2hlY2sgdGhlIG5hbWUsIG9yIGFub3RoZXIgcGFydHkgaGFzIHlldCB0byBvcGVuIGl0YCxcbiAgICAgICk7XG4gICAgaWYgKHBheWxvYWQuYXJjaGl2ZWQpXG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgJHtwYXlsb2FkLmNoYW5uZWx9IGlzIGFyY2hpdmVkIOKAlCByZWFkLW9ubHk7IGEgc2VuZCB3aWxsIGJlIHJlamVjdGVkIHVudGlsIHNvbWVvbmUgdW5hcmNoaXZlcyBpdGAsXG4gICAgICApO1xuICAgIGlmICghKGVhcmxpZXIgPiAwIHx8IHBheWxvYWQudG9waWMgfHwgcGF5bG9hZC5jcmVhdGVkIHx8IHBheWxvYWQuYXJjaGl2ZWQpKSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBncm91bmRpbmc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge1xuICAgICAga2luZDogXCJncm91bmRpbmdcIixcbiAgICAgIGNoYW5uZWw6IHBheWxvYWQuY2hhbm5lbCxcbiAgICAgIGpvaW5lZF9hdDogc2luY2UgPCAwID8gbGF0ZXN0IDogTWF0aC5taW4oc2luY2UsIGxhdGVzdCksXG4gICAgICBlYXJsaWVyLFxuICAgIH07XG4gICAgaWYgKHBheWxvYWQudG9waWMpIGdyb3VuZGluZy50b3BpYyA9IHBheWxvYWQudG9waWM7XG4gICAgaWYgKHBheWxvYWQuY3JlYXRlZCkgZ3JvdW5kaW5nLmNyZWF0ZWQgPSB0cnVlO1xuICAgIGlmIChwYXlsb2FkLmFyY2hpdmVkKSBncm91bmRpbmcuYXJjaGl2ZWQgPSB0cnVlO1xuICAgIGlmIChoaW50cy5sZW5ndGgpIGdyb3VuZGluZy5oaW50ID0gaGludHMuam9pbihcIiDCtyBcIik7XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KGdyb3VuZGluZyk7XG4gIH1cbn1cbmZ1bmN0aW9uIGZvbGREaXNwb3NpdGlvbnMobmFtZTogc3RyaW5nKSB7XG4gIGNvbnN0IG1hcCA9IG5ldyBNYXA8XG4gICAgbnVtYmVyLFxuICAgIHtcbiAgICAgIGRpc3Bvc2l0aW9uOiBzdHJpbmc7XG4gICAgICBmcm9tOiBzdHJpbmc7XG4gICAgICB0czogbnVtYmVyO1xuICAgICAgbm90ZTogc3RyaW5nO1xuICAgICAgcmVvcGVuczogbnVtYmVyO1xuICAgIH1cbiAgPigpO1xuICBjb25zdCBwYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIHJldHVybiBtYXA7XG4gIGZvciAoY29uc3QgbGluZSBvZiByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmICghbGluZS50cmltKCkpIGNvbnRpbnVlO1xuICAgIGxldCBtOiBNZXNzYWdlO1xuICAgIHRyeSB7XG4gICAgICBtID0gSlNPTi5wYXJzZShsaW5lKSBhcyBNZXNzYWdlO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChtLmtpbmQgIT09IFwic3RhdHVzXCIgfHwgdHlwZW9mIG0udGFyZ2V0ICE9PSBcIm51bWJlclwiIHx8IHR5cGVvZiBtLmRpc3Bvc2l0aW9uICE9PSBcInN0cmluZ1wiKVxuICAgICAgY29udGludWU7XG4gICAgY29uc3QgcHJldiA9IG1hcC5nZXQobS50YXJnZXQpO1xuICAgIGNvbnN0IHJlb3BlbnMgPVxuICAgICAgKHByZXY/LnJlb3BlbnMgPz8gMCkgK1xuICAgICAgKG0uZGlzcG9zaXRpb24gPT09IFwib3BlblwiICYmIHByZXYgJiYgcHJldi5kaXNwb3NpdGlvbiAhPT0gXCJvcGVuXCIgPyAxIDogMCk7XG4gICAgbWFwLnNldChtLnRhcmdldCwge1xuICAgICAgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24sXG4gICAgICBmcm9tOiBtLmZyb20sXG4gICAgICB0czogbS50cyxcbiAgICAgIG5vdGU6IG0udGV4dCxcbiAgICAgIHJlb3BlbnMsXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIG1hcDtcbn1cbi8vIFRXTyB0aGluZ3Mgbm93IHdlYXIga2luZDpcInN0YXR1c1wiLiBBIERJU1BPU0lUSU9OIGZyYW1lIGFjdHMgb24gYSBzcGVjaWZpY1xuLy8gbWVzc2FnZSAoYHRhcmdldGAgKyBgZGlzcG9zaXRpb25gKSBhbmQgaXMgbWV0YWRhdGEg4oCUIGBwdWxsYCBhbmQgYHRhaWxgIGZvbGRcbi8vIGl0IGF3YXkgYW5kIGJhZGdlIHRoZSBtZXNzYWdlIGl0IHBvaW50cyBhdCBpbnN0ZWFkLiBBIExJRkVDWUNMRSBmcmFtZVxuLy8gKGFyY2hpdmUgLyB1bmFyY2hpdmUpIGlzIGEgZmFjdCBhYm91dCB0aGUgQ0hBTk5FTDogaXQgdGFyZ2V0cyBub3RoaW5nLCBhbmQgaXRcbi8vIGlzIHRoZSB3aG9sZSBwb2ludCB0aGF0IGEgcmVhZGVyIHNlZXMgaXQuIERpc2NyaW1pbmF0aW5nIG9uIGBkaXNwb3NpdGlvbmBcbi8vIHJhdGhlciB0aGFuIG9uIGBldmVudGAga2VlcHMgYSBmcmFtZSBmcm9tIHNvbWUgZnV0dXJlIGVtaXR0ZXIgdmlzaWJsZSBieVxuLy8gZGVmYXVsdCDigJQgdGhlIGZhaWx1cmUgbW9kZSBoZXJlIGlzIHN3YWxsb3dpbmcgYSBzaWduYWwsIG5vdCBzaG93aW5nIG9uZS5cbmZ1bmN0aW9uIGlzRGlzcG9zaXRpb25GcmFtZShtOiB7IGtpbmQ/OiBzdHJpbmc7IGRpc3Bvc2l0aW9uPzogc3RyaW5nIH0pOiBib29sZWFuIHtcbiAgcmV0dXJuIG0ua2luZCA9PT0gXCJzdGF0dXNcIiAmJiB0eXBlb2YgbS5kaXNwb3NpdGlvbiA9PT0gXCJzdHJpbmdcIjtcbn1cblxuLy8gXCJvcGVuXCIgPSBubyBlbnRyeSwgb3IgbGF0ZXN0IGRpc3Bvc2l0aW9uIGlzIFwib3BlblwiXG5mdW5jdGlvbiBpc09wZW4oZD86IHsgZGlzcG9zaXRpb246IHN0cmluZyB9KSB7XG4gIHJldHVybiAhZCB8fCBkLmRpc3Bvc2l0aW9uID09PSBcIm9wZW5cIjtcbn1cblxuLy8gUmVhZHMgdGhlIGZ1bGwgY2hhbm5lbCBsb2csIGRyb3BzIEVWRVJZIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSwgYW5kIGJhZGdlcyBlYWNoXG4vLyByZW1haW5pbmcgbWVzc2FnZSB3aXRoIGl0cyBsYXRlc3QgZGlzcG9zaXRpb24gdmlhIGZvbGREaXNwb3NpdGlvbnMuXG4vL1xuLy8gRXZlcnkgb25lLCBkZWxpYmVyYXRlbHkg4oCUIGluY2x1ZGluZyBhIGxpZmVjeWNsZSBmcmFtZSAoYXJjaGl2ZS91bmFyY2hpdmUpLFxuLy8gd2hpY2ggYHB1bGxgIGFuZCBgdGFpbGAgZG8gbGV0IHRocm91Z2guIFRoaXMgZmVlZHMgYHRyaWFnZWAsIHdob3NlIG9wZW4gcXVldWVcbi8vIGlzIFwid2hhdCBpcyBsZWZ0IHRvIGFjdCBvblwiLCBhbmQgYW4gYXJjaGl2ZSBpcyBhbiBGWUksIG5vdCBhIHdvcmsgaXRlbS4gU2FtZVxuLy8gcmVhc29uIGB0b3BpY2AgYW5kIGBhbm5vdW5jZW1lbnRgIGFyZSBmb2xkZWQgb3V0IG9mIHRoZSBvcGVuIGJ1Y2tldCBiZWxvdy5cbmZ1bmN0aW9uIGxvYWRDaGFubmVsTWVzc2FnZXNCYWRnZWQoXG4gIG5hbWU6IHN0cmluZyxcbik6IChNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9KVtdIHtcbiAgY29uc3QgbG9nUGF0aCA9IGpvaW4oREFUQV9ESVIsIFwiY2hhbm5lbHNcIiwgYCR7bmFtZX0uanNvbmxgKTtcbiAgaWYgKCFleGlzdHNTeW5jKGxvZ1BhdGgpKSByZXR1cm4gW107XG4gIGNvbnN0IGRpc3AgPSBmb2xkRGlzcG9zaXRpb25zKG5hbWUpO1xuICBjb25zdCBtZXNzYWdlczogKE1lc3NhZ2UgJiB7IGRpc3Bvc2l0aW9uPzogc3RyaW5nOyByZW9wZW5zPzogbnVtYmVyIH0pW10gPSBbXTtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKCFsaW5lLnRyaW0oKSkgY29udGludWU7XG4gICAgbGV0IG06IE1lc3NhZ2U7XG4gICAgdHJ5IHtcbiAgICAgIG0gPSBKU09OLnBhcnNlKGxpbmUpIGFzIE1lc3NhZ2U7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG0ua2luZCA9PT0gXCJzdGF0dXNcIikgY29udGludWU7XG4gICAgY29uc3QgZCA9IGRpc3AuZ2V0KG0uaWQpO1xuICAgIGlmIChkKSB7XG4gICAgICBtZXNzYWdlcy5wdXNoKHsgLi4ubSwgZGlzcG9zaXRpb246IGQuZGlzcG9zaXRpb24sIHJlb3BlbnM6IGQucmVvcGVucyB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWVzc2FnZXMucHVzaChtKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG1lc3NhZ2VzO1xufVxuXG50eXBlIEJhZGdlZE1lc3NhZ2UgPSBNZXNzYWdlICYgeyBkaXNwb3NpdGlvbj86IHN0cmluZzsgcmVvcGVucz86IG51bWJlciB9O1xuXG4vLyBEYXNoYm9hcmQgcmVuZGVyIG9mIGEgdHJpYWdlIHNjYW46IHRoZSBvcGVuIHF1ZXVlIG9uIHRvcCwgdGhlbiBlYWNoXG4vLyBkaXNwb3NpdGlvbiBncm91cCwgb25lIHNjYW5uYWJsZSBsaW5lIHBlciBtZXNzYWdlLiBNaXJyb3JzIGByZWFkIC0tdGV4dGBcbi8vIHByb3NlIG1vZGUgc28gYSBodW1hbiAob3IgYW4gYWdlbnQpIHJlYWRzIGl0IHdpdGhvdXQgcGFyc2luZyBKU09OLlxuZnVuY3Rpb24gcmVuZGVyVHJpYWdlSHVtYW4oXG4gIG5hbWU6IHN0cmluZyxcbiAgb3BlbjogQmFkZ2VkTWVzc2FnZVtdLFxuICBieV9zdGF0dXM6IFJlY29yZDxzdHJpbmcsIEJhZGdlZE1lc3NhZ2VbXT4sXG4pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lID0gKG06IEJhZGdlZE1lc3NhZ2UpID0+IHtcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKG0udHMpLnRvSVNPU3RyaW5nKCkuc2xpY2UoMCwgMTYpLnJlcGxhY2UoXCJUXCIsIFwiIFwiKTtcbiAgICBjb25zdCByZW9wZW4gPSBtLnJlb3BlbnMgJiYgbS5yZW9wZW5zID4gMCA/IGAg4oa7JHttLnJlb3BlbnN9YCA6IFwiXCI7XG4gICAgLy8gVGhlIGZpcnN0IGxpbmUsIHdpdGhvdXQgYW4gaW5kZXggcmVhZCBgc3BsaXRgIHdvdWxkIG1ha2UgdGhlIGNvbXBpbGVyXG4gICAgLy8gZG91YnQ6IGBzcGxpdGAgbmV2ZXIgcmV0dXJucyBhbiBlbXB0eSBhcnJheSwgYW5kIHRoaXMgc2F5cyB0aGUgc2FtZSB0aGluZy5cbiAgICBjb25zdCBubCA9IG0udGV4dC5pbmRleE9mKFwiXFxuXCIpO1xuICAgIGNvbnN0IGhlYWQgPSBubCA9PT0gLTEgPyBtLnRleHQgOiBtLnRleHQuc2xpY2UoMCwgbmwpO1xuICAgIGNvbnN0IHByZXZpZXcgPSBoZWFkLmxlbmd0aCA+IDEwMCA/IGAke2hlYWQuc2xpY2UoMCwgOTkpfeKApmAgOiBoZWFkO1xuICAgIHJldHVybiBgICBbJHttLmlkfSR7cmVvcGVufV0gJHttLmZyb219IMK3ICR7dHN9IMK3ICR7cHJldmlld31gO1xuICB9O1xuICBjb25zdCBzZWN0aW9ucyA9IFtgJHtuYW1lfSDCtyB0cmlhZ2VcXG5gLCBgT1BFTiAoJHtvcGVuLmxlbmd0aH0pYF07XG4gIHNlY3Rpb25zLnB1c2gob3Blbi5sZW5ndGggPyBvcGVuLm1hcChsaW5lKS5qb2luKFwiXFxuXCIpIDogXCIgIOKAlFwiKTtcbiAgZm9yIChjb25zdCBbc3RhdHVzLCBpdGVtc10gb2YgT2JqZWN0LmVudHJpZXMoYnlfc3RhdHVzKSkge1xuICAgIHNlY3Rpb25zLnB1c2goYFxcbiR7c3RhdHVzLnRvVXBwZXJDYXNlKCl9ICgke2l0ZW1zLmxlbmd0aH0pYCwgaXRlbXMubWFwKGxpbmUpLmpvaW4oXCJcXG5cIikpO1xuICB9XG4gIHJldHVybiBgJHtzZWN0aW9ucy5qb2luKFwiXFxuXCIpfVxcbmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRyaWFnZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdHM6IHsgaHVtYW4/OiBib29sZWFuIH0gPSB7fSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgdHJpYWdlIDxjaGFubmVsPiBbLS1odW1hbl1cIik7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgLy8gdHJpYWdlIHJlYWRzIHRoZSBsb2cgZmlsZSwgbm90IGEgcm91dGUsIHNvIGl0IGNhbm5vdCA0MDQgb24gaXRzIG93biDigJQgYW5kXG4gIC8vIGFuIGVtcHR5IGRhc2hib2FyZCBmb3IgYSBjaGFubmVsIHRoYXQgZG9lcyBub3QgZXhpc3QgaXMgdGhlIHNhbWUgc2lsZW50IGxpZVxuICAvLyBhcyBhbiBlbXB0eSBgcHVsbGAuXG4gIGF3YWl0IHJlcXVpcmVDaGFubmVsKHBvcnQsIG5hbWUpO1xuICBjb25zdCBiYWRnZWQgPSBsb2FkQ2hhbm5lbE1lc3NhZ2VzQmFkZ2VkKG5hbWUpO1xuICBjb25zdCBvcGVuOiBCYWRnZWRNZXNzYWdlW10gPSBbXTtcbiAgY29uc3QgYnlfc3RhdHVzOiBSZWNvcmQ8c3RyaW5nLCBCYWRnZWRNZXNzYWdlW10+ID0ge307XG4gIGZvciAoY29uc3QgbSBvZiBiYWRnZWQpIHtcbiAgICAvLyBpc09wZW4gZXhwZWN0cyBhIGRpc3Bvc2l0aW9uIGVudHJ5IG9iamVjdCAob3IgdW5kZWZpbmVkIGZvciBubyBlbnRyeSkuXG4gICAgY29uc3QgZGlzcEFyZyA9IG0uZGlzcG9zaXRpb24gIT09IHVuZGVmaW5lZCA/IHsgZGlzcG9zaXRpb246IG0uZGlzcG9zaXRpb24gfSA6IHVuZGVmaW5lZDtcbiAgICBpZiAoaXNPcGVuKGRpc3BBcmcpKSB7XG4gICAgICAvLyBUaGUgb3BlbiBxdWV1ZSBpcyBzaWduYWwtb25seTogc2tpcCBub24tYWN0aW9uYWJsZSBmcmFtZXMgKHRvcGljL1xuICAgICAgLy8gYW5ub3VuY2VtZW50IEZZSXMgY2FuIG5ldmVyIGNhcnJ5IGEgZGlzcG9zaXRpb24sIHNvIHRoZXknZCBvdGhlcndpc2VcbiAgICAgIC8vIHBhZCBcIndoYXQncyBsZWZ0P1wiIGZvcmV2ZXIpLlxuICAgICAgaWYgKG0ua2luZCA9PT0gXCJtZXNzYWdlXCIpIG9wZW4ucHVzaChtKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qga2V5ID0gbS5kaXNwb3NpdGlvbiA/PyBcInVua25vd25cIjtcbiAgICAgIGlmICghYnlfc3RhdHVzW2tleV0pIGJ5X3N0YXR1c1trZXldID0gW107XG4gICAgICBieV9zdGF0dXNba2V5XS5wdXNoKG0pO1xuICAgIH1cbiAgfVxuICBpZiAob3B0cy5odW1hbikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHJlbmRlclRyaWFnZUh1bWFuKG5hbWUsIG9wZW4sIGJ5X3N0YXR1cykpO1xuICAgIHJldHVybjtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgb3BlbiwgYnlfc3RhdHVzIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRHcmVwKFxuICBuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHBhdHRlcm46IHN0cmluZyxcbiAgb3B0czogeyBsaXRlcmFsPzogYm9vbGVhbjsgZnJvbT86IHN0cmluZyB9LFxuKSB7XG4gIGlmICghbmFtZSB8fCAhcGF0dGVybilcbiAgICBkaWUoXCJ1c2FnZTogZ3JhcGV2aW5lIGdyZXAgPGNoYW5uZWw+IDxwYXR0ZXJuPiBbLS1saXRlcmFsfC1GXSBbLS1mcm9tIDxhbGlhcz5dXCIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiLCBgJHtuYW1lfS5qc29ubGApO1xuICBpZiAoIWV4aXN0c1N5bmMobG9nUGF0aCkpIHtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXM6IFtdIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBsZXQgbWF0Y2hlcjogKHRleHQ6IHN0cmluZykgPT4gYm9vbGVhbjtcbiAgaWYgKG9wdHMubGl0ZXJhbCkge1xuICAgIGNvbnN0IG5lZWRsZSA9IHBhdHRlcm4udG9Mb3dlckNhc2UoKTtcbiAgICBtYXRjaGVyID0gKHRleHQpID0+IHRleHQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhuZWVkbGUpO1xuICB9IGVsc2Uge1xuICAgIGxldCByZTogUmVnRXhwO1xuICAgIHRyeSB7XG4gICAgICByZSA9IG5ldyBSZWdFeHAocGF0dGVybiwgXCJpXCIpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGRpZShgaW52YWxpZCByZWdleDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9YCwgXCJ1c2FnZVwiKTtcbiAgICB9XG4gICAgbWF0Y2hlciA9ICh0ZXh0KSA9PiByZS50ZXN0KHRleHQpO1xuICB9XG4gIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpO1xuICBjb25zdCBtZXNzYWdlczogdW5rbm93bltdID0gW107XG4gIGZvciAoY29uc3QgbGluZSBvZiByYXcuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGxldCBtc2c6IFBhcnRpYWw8TWVzc2FnZT47XG4gICAgdHJ5IHtcbiAgICAgIG1zZyA9IEpTT04ucGFyc2UobGluZSkgYXMgUGFydGlhbDxNZXNzYWdlPjtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHlwZW9mIG1zZy50ZXh0ICE9PSBcInN0cmluZ1wiKSBjb250aW51ZTtcbiAgICBpZiAob3B0cy5mcm9tICYmIG1zZy5mcm9tICE9PSBvcHRzLmZyb20pIGNvbnRpbnVlO1xuICAgIGlmICghbWF0Y2hlcihtc2cudGV4dCkpIGNvbnRpbnVlO1xuICAgIG1lc3NhZ2VzLnB1c2gobXNnKTtcbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgbWVzc2FnZXMgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZENsb3NlKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgY2xvc2UgPG5hbWU+XCIpO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSBkaWUoXCJubyBkYWVtb24gcnVubmluZ1wiLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaTxTdGF0dXNSZXNwb25zZT4ocG9ydCwgXCJERUxFVEVcIiwgYC9jaGFubmVscy8ke25hbWV9YCk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc2V0KG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgb3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBpZiAoIW5hbWUpIGRpZShcInVzYWdlOiBncmFwZXZpbmUgcmVzZXQgPG5hbWU+IFstLWZvcmNlXVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9O1xuICBpZiAob3B0cy5mb3JjZSkgYm9keS5mb3JjZSA9IHRydWU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8eyBlcnJvcj86IHN0cmluZzsgc3Vic2NyaWJlcnM/OiBudW1iZXIgfT4oXG4gICAgcG9ydCxcbiAgICBcIlBPU1RcIixcbiAgICBgL2NoYW5uZWxzLyR7bmFtZX0vcmVzZXRgLFxuICAgIGJvZHksXG4gICk7XG4gIGlmIChzdGF0dXMgPT09IDQwOSAmJiBkYXRhPy5lcnJvciA9PT0gXCJsaXZlXCIpIHtcbiAgICBkaWUoXG4gICAgICBgY2hhbm5lbCBoYXMgJHtkYXRhLnN1YnNjcmliZXJzfSBsaXZlIHN1YnNjcmliZXIocykg4oCUIHJlZnVzaW5nIHRvIGNsZWFyIGEgbGl2ZSBzZXNzaW9uLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIGNsZWFyIGFueXdheSAodGhlIGxvZyBpcyBzbmFwc2hvdHRlZCBmaXJzdCkuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIEFyY2hpdmUgKHJlYWQtb25seSkgb3IgdW5hcmNoaXZlIGEgY2hhbm5lbCAoVjEuNykg4oCUIHRoZSBub24tZGVzdHJ1Y3RpdmVcbi8vIGFsdGVybmF0aXZlIHRvIGNsb3NlOiBoaXN0b3J5IGlzIHByZXNlcnZlZCwgc2VuZHMgYXJlIHJlamVjdGVkLCBhbmQgdGhlIG5hbWVcbi8vIGlzIGxvY2tlZCBmcm9tIHJlLW9wZW4gdW50aWwgdW5hcmNoaXZlZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZE1hcmsoXG4gIG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWQ6IG51bWJlcixcbiAgZGlzcG9zaXRpb246IHN0cmluZyxcbiAgZnJvbTogc3RyaW5nLFxuICBvcHRzOiB7IG5vdGU/OiBzdHJpbmcgfSxcbikge1xuICBpZiAoIW5hbWUgfHwgIU51bWJlci5pc0Zpbml0ZShpZCkgfHwgIWRpc3Bvc2l0aW9uKVxuICAgIGRpZShcInVzYWdlOiBncmFwZXZpbmUgbWFyayA8Y2hhbm5lbD4gPGlkPiA8ZGlzcG9zaXRpb24+IFstLW5vdGUgPHRleHQ+XSBbLS1hcyA8YWxpYXM+XVwiKTtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBjb25zdCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgZnJvbSwgdGFyZ2V0OiBpZCwgZGlzcG9zaXRpb24gfTtcbiAgaWYgKG9wdHMubm90ZSAhPT0gdW5kZWZpbmVkKSBib2R5Lm5vdGUgPSBvcHRzLm5vdGU7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGk8TWVzc2FnZT4ocG9ydCwgXCJQT1NUXCIsIGAvY2hhbm5lbHMvJHtuYW1lfS9zdGF0dXNgLCBib2R5KTtcbiAgaWYgKHN0YXR1cyA+PSA0MDAgfHwgIWRhdGEpIGRpZUFwaShkYXRhIGFzIHsgZXJyb3I/OiBzdHJpbmc7IGhpbnQ/OiBzdHJpbmcgfSB8IG51bGwsIHN0YXR1cyk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQXJjaGl2ZShuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsIHVuYXJjaGl2ZTogYm9vbGVhbiwgZnJvbT86IHN0cmluZykge1xuICBjb25zdCB2ZXJiID0gdW5hcmNoaXZlID8gXCJ1bmFyY2hpdmVcIiA6IFwiYXJjaGl2ZVwiO1xuICBpZiAoIW5hbWUpIGRpZShgdXNhZ2U6IGdyYXBldmluZSAke3ZlcmJ9IDxjaGFubmVsPmApO1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIC8vIEJvdGggcm91dGVzIGFwcGVuZCBhIGtpbmQ6XCJzdGF0dXNcIiBmcmFtZSB0byB0aGUgbG9nLCBzbyB3aG8gZGlkIGl0IGlzIHdvcnRoXG4gIC8vIHJlY29yZGluZyB3aGVuIHRoZSBjYWxsZXIgdG9sZCB1cy4gSWRlbnRpdHkgaXMgb3B0aW9uYWwgaGVyZSAoaXQgaXMgb24gdGhlXG4gIC8vIGdsb2JhbGx5LWFjY2VwdGVkIC0tYXMvLS1mcm9tKSwgYW5kIHRoZSBkYWVtb24gc2lnbnMgXCJzeXN0ZW1cIiB3aXRob3V0IGl0LlxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpPFN0YXR1c1Jlc3BvbnNlPihcbiAgICBwb3J0LFxuICAgIFwiUE9TVFwiLFxuICAgIGAvY2hhbm5lbHMvJHtuYW1lfS8ke3ZlcmJ9YCxcbiAgICBmcm9tID8geyBmcm9tIH0gOiB1bmRlZmluZWQsXG4gICk7XG4gIGlmIChzdGF0dXMgPj0gNDAwKSBkaWVBcGkoZGF0YSwgc3RhdHVzKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0b3Aob3B0czogeyBob2xkU2Vjb25kcz86IG51bWJlciB9ID0ge30pIHtcbiAgbGV0IGhlbGRVbnRpbDogbnVtYmVyIHwgdW5kZWZpbmVkO1xuICBpZiAob3B0cy5ob2xkU2Vjb25kcyAmJiBvcHRzLmhvbGRTZWNvbmRzID4gMCkge1xuICAgIGhlbGRVbnRpbCA9IERhdGUubm93KCkgKyBvcHRzLmhvbGRTZWNvbmRzICogMTAwMDtcbiAgICB0cnkge1xuICAgICAgd3JpdGVGaWxlU3luYyhIT0xEX0ZJTEUsIFN0cmluZyhoZWxkVW50aWwpKTtcbiAgICB9IGNhdGNoIHt9XG4gIH1cbiAgY29uc3QgcG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7XG4gIGlmICghcG9ydCkge1xuICAgIHByaW50SnNvbih7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIGRhZW1vbjogZmFsc2UsXG4gICAgICAuLi4oaGVsZFVudGlsICE9PSB1bmRlZmluZWQgPyB7IGhlbGRfdW50aWw6IGhlbGRVbnRpbCB9IDoge30pLFxuICAgIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBzdG9wcGVkOiB0cnVlLFxuICAgIC4uLihoZWxkVW50aWwgIT09IHVuZGVmaW5lZCA/IHsgaGVsZF91bnRpbDogaGVsZFVudGlsIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vLyBQZXItY2hhbm5lbCBsaXZlLWNvbm5lY3Rpb24gc3VtbWFyeSDigJQgdGhlIHJlc3RhcnQtc2FmZXR5IHJlYWQuIE1pcnJvcnMgd2hhdFxuLy8gYGRvY3RvcmAgcmVwb3J0cyB1bmRlciBhY3RpdmVfc3Vic2NyaWJlcnM7IG9ubHkgcG9wdWxhdGVkIGNoYW5uZWxzIGFyZSBsaXN0ZWQuXG5hc3luYyBmdW5jdGlvbiBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKFxuICBwb3J0OiBudW1iZXIsXG4pOiBQcm9taXNlPHsgdG90YWw6IG51bWJlcjsgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+IH0+IHtcbiAgbGV0IHRvdGFsID0gMDtcbiAgY29uc3QgY2hhbm5lbHM6IEFycmF5PHsgbmFtZTogc3RyaW5nOyBjb25uZWN0aW9uczogbnVtYmVyIH0+ID0gW107XG4gIHRyeSB7XG4gICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8UHJlc2VuY2VSZXNwb25zZT4ocG9ydCwgXCJHRVRcIiwgXCIvcHJlc2VuY2VcIik7XG4gICAgZm9yIChjb25zdCBjaCBvZiBkYXRhPy5jaGFubmVscyA/PyBbXSkge1xuICAgICAgdG90YWwgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICBpZiAoY2guY29ubmVjdGlvbnMgPiAwKSBjaGFubmVscy5wdXNoKHsgbmFtZTogY2gubmFtZSwgY29ubmVjdGlvbnM6IGNoLmNvbm5lY3Rpb25zIH0pO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gYmVzdC1lZmZvcnQg4oCUIGEgcHJlc2VuY2UgaGljY3VwIHNob3VsZG4ndCBjcmFzaCBhIGxpZmVjeWNsZSB2ZXJiXG4gIH1cbiAgcmV0dXJuIHsgdG90YWwsIGNoYW5uZWxzIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXJ0KCkge1xuICAvLyBFbnN1cmUtcnVubmluZywgbm8gY2hhbm5lbCBzaWRlLWVmZmVjdC4gSWRlbXBvdGVudDogcmVwb3J0IGFuIGV4aXN0aW5nXG4gIC8vIGRhZW1vbiwgb3Igc3Bhd24gYSBmcmVzaCBvbmUuIFRoZSBleHBsaWNpdCBcImJyaW5nIGl0IHVwXCIgdmVyYiDigJQgZGlhZ25vc3RpY3NcbiAgLy8gKGRvY3Rvci9pbmZvL2xpc3QpIHN0YXkgcmVhZC1vbmx5IGFuZCBuZXZlciBzcGF3bi5cbiAgY29uc3QgZXhpc3RpbmcgPSBhd2FpdCByZWFkRGFlbW9uUG9ydCgpO1xuICBpZiAoIWV4aXN0aW5nICYmIGhvbGRBY3RpdmUoKSkge1xuICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBoZWxkOiB0cnVlLCBwb3J0OiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBwb3J0ID0gZXhpc3RpbmcgPz8gKGF3YWl0IGVuc3VyZURhZW1vbigpKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHBvcnQsIGFscmVhZHlfcnVubmluZzogZXhpc3RpbmcgIT09IG51bGwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlc3RhcnQob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gTm90aGluZyB0byB0ZWFyIGRvd24g4oCUIGp1c3QgYnJpbmcgYSBmcmVzaCBkYWVtb24gdXAuXG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBlbnN1cmVEYWVtb24oKTtcbiAgICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBudWxsIH0pO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBTQUZFVFk6IGEgcmVzdGFydCBmb3JjZXMgZXZlcnkgY29ubmVjdGVkIGNsaWVudCB0byBhdXRvLXJlY29ubmVjdC4gUmVmdXNlIHRvXG4gIC8vIHRlYXIgZG93biBhIHdvcmtpbmcgZmxlZXQgdW5sZXNzIGV4cGxpY2l0bHkgZm9yY2VkIOKAlCBuZXZlciBzaWxlbnRseSBkcm9wIGl0LlxuICBjb25zdCB7IHRvdGFsLCBjaGFubmVscyB9ID0gYXdhaXQgZmV0Y2hBY3RpdmVTdWJzY3JpYmVycyhwb3J0KTtcbiAgaWYgKHRvdGFsID4gMCAmJiAhb3B0cy5mb3JjZSkge1xuICAgIGNvbnN0IHdoZXJlID0gY2hhbm5lbHMubWFwKChjKSA9PiBgJHtjLm5hbWV9ICgke2MuY29ubmVjdGlvbnN9KWApLmpvaW4oXCIsIFwiKTtcbiAgICBkaWUoXG4gICAgICBgcmVzdGFydDogJHt0b3RhbH0gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7Y2hhbm5lbHMubGVuZ3RofSBjaGFubmVsKHMpIOKAlCAke3doZXJlfS4gYCArXG4gICAgICAgIFwiQSByZXN0YXJ0IHdvdWxkIGZvcmNlIHRoZW0gYWxsIHRvIHJlY29ubmVjdC4gUmUtcnVuIHdpdGggLS1mb3JjZSAob3IgLS15ZXMpIHRvIHByb2NlZWQgYW55d2F5LlwiLFxuICAgICAgXCJjb25mbGljdFwiLFxuICAgICk7XG4gIH1cbiAgLy8gQ2FwdHVyZSB0aGUgcGlkIHdlJ3JlIHJlcGxhY2luZywgZm9yIHRoZSByZWNlaXB0LlxuICBsZXQgcHJldmlvdXNQaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gICAgcHJldmlvdXNQaWQgPSBkYXRhPy5waWQgPz8gbnVsbDtcbiAgfSBjYXRjaCB7fVxuICAvLyBTdG9wLCB0aGVuIHdhaXQgZm9yIHRoZSBvbGQgZGFlbW9uIHRvIGFjdHVhbGx5IGdvIGF3YXkg4oCUIGl0IHVubGlua3MgaXRzXG4gIC8vIHBvcnQvcGlkIGZpbGVzIG9uIHNodXRkb3duLCBzbyBlbnN1cmVEYWVtb24gc3Bhd25zIGZyZXNoIHJhdGhlciB0aGFuXG4gIC8vIHJlLWRpc2NvdmVyaW5nIHRoZSBkeWluZyBvbmUuXG4gIHRyeSB7XG4gICAgYXdhaXQgYXBpKHBvcnQsIFwiREVMRVRFXCIsIFwiL1wiKTtcbiAgfSBjYXRjaCB7fVxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgNTApKTtcbiAgICBpZiAoKGF3YWl0IHJlYWREYWVtb25Qb3J0KCkpID09PSBudWxsKSBicmVhaztcbiAgfVxuICBjb25zdCBmcmVzaCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgcmVzdGFydGVkOiB0cnVlLCBwb3J0OiBmcmVzaCwgcHJldmlvdXNfcGlkOiBwcmV2aW91c1BpZCB9KTtcbn1cblxuLy8gYjMg4oCUIFRIRSBWRVJTSU9OIFZFUklGWSwgQVMgT05FIFNPVVJDRSBGT1IgQk9USCBQQVRIUy5cbi8vXG4vLyBgcm9sbGAgaXMgZG9jdW1lbnRlZCBhcyBcInRoZSByZWNvbW1lbmRlZCBkZXBsb3kgc3RlcCDigKYgKyB2ZXJzaW9uIHZlcmlmeVwiLCBhbmRcbi8vIHRoZSB2ZXJpZnkgaGFkIHR3byB3YXlzIHRvIHNheSBub3RoaW5nOlxuLy9cbi8vICAgQ09MRCBQQVRIIOKAlCBubyBkYWVtb24gcnVubmluZzogaXQgc3Bhd25lZCBvbmUgYW5kIHByaW50ZWQgbmVpdGhlciBgdmVyc2lvbmBcbi8vICAgbm9yIGB2ZXJzaW9uX29rYC4gVGhlIGZpZWxkcyB3ZXJlIEFCU0VOVCwgc28gYSBjYWxsZXIgY2hlY2tpbmcgdGhlIHZlcmlmeVxuLy8gICBnb3QgYHVuZGVmaW5lZGAgb24gdGhlIGV4YWN0IHBhdGggd2hlcmUgdGhlIHZlcmlmeSBuZXZlciBoYXBwZW5lZC5cbi8vXG4vLyAgIFdBUk0gUEFUSCDigJQgdGhlIHByb2JlIHdhcyB3cmFwcGVkIGluIGBjYXRjaCB7fWAsIGxlYXZpbmcgYHZlcnNpb24gPSBudWxsYCxcbi8vICAgYW5kIGB2ZXJzaW9uX29rOiBudWxsID09PSBQTFVHSU5fVkVSU0lPTmAgZXZhbHVhdGVzIHRvIEZBTFNFLiBcIkkgY291bGQgbm90XG4vLyAgIGNoZWNrXCIgd2FzIHJlcG9ydGVkIGFzIFwidGhlIHZlcnNpb24gaXMgV1JPTkdcIiDigJQgYSBib29sZWFuIHRoYXQgY2Fubm90IHNheVxuLy8gICBcInVua25vd25cIiBpcyB0aGUgY2Fub25pY2FsIHNoYXBlIG9mIHRoaXMgc3ByaW50J3MgZGVmZWN0LCBhbmQgZmFsc2UgaXMgdGhlXG4vLyAgIHdvcnN0IGF2YWlsYWJsZSBhbnN3ZXIgYmVjYXVzZSBpdCBpcyBhY3Rpb25hYmxlIGFuZCBpbmNvcnJlY3QuXG4vL1xuLy8gU28gYHZlcnNpb25fb2tgIGlzIG5vdyBgYm9vbGVhbiB8IG51bGxgOiBudWxsIG1lYW5zIFVOQ0hFQ0tFRCwgbmV2ZXIgZmFsc2UuXG4vLyBgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uYCBpcyBwcmVzZW50LWFuZC1udWxsIGJlc2lkZSBpdCwgYmVjYXVzZSBhIGJhcmUgbnVsbFxuLy8gdGVsbHMgYSBjYWxsZXIgdGhlIGNoZWNrIGRpZCBub3QgaGFwcGVuIGFuZCBub3Qgd2h5LlxuLy9cbi8vIE9uZSBoZWxwZXIgcmF0aGVyIHRoYW4gdHdvIGNhbGwgc2l0ZXM6IGEgc2Vjb25kIGNvcHkgb2YgdGhpcyBsb2dpYyBvbiB0aGUgY29sZFxuLy8gcGF0aCBpcyB0aGUgbWlycm9yLWRyaWZ0IHRyYXAsIGFuZCB0aGUgY29sZCBwYXRoIGlzIHByZWNpc2VseSB0aGUgb25lIG5vYm9keVxuLy8gcmUtcmVhZHMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcHJvYmVWZXJzaW9uKHBvcnQ6IG51bWJlcik6IFByb21pc2U8e1xuICB2ZXJzaW9uOiBzdHJpbmcgfCBudWxsO1xuICB2ZXJzaW9uX29rOiBib29sZWFuIHwgbnVsbDtcbiAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBzdHJpbmcgfCBudWxsO1xufT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHYgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnZlcnNpb24gPz8gbnVsbDtcbiAgICBpZiAodiA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgICAgdmVyc2lvbl91bmNoZWNrZWRfcmVhc29uOiBcInRoZSBkYWVtb24gYW5zd2VyZWQgYnV0IHJlcG9ydGVkIG5vIHZlcnNpb25cIixcbiAgICAgIH07XG4gICAgfVxuICAgIHJldHVybiB7IHZlcnNpb246IHYsIHZlcnNpb25fb2s6IHYgPT09IFBMVUdJTl9WRVJTSU9OLCB2ZXJzaW9uX3VuY2hlY2tlZF9yZWFzb246IG51bGwgfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJldHVybiB7XG4gICAgICB2ZXJzaW9uOiBudWxsLFxuICAgICAgdmVyc2lvbl9vazogbnVsbCxcbiAgICAgIHZlcnNpb25fdW5jaGVja2VkX3JlYXNvbjogYGNvdWxkIG5vdCByZWFjaCB0aGUgZGFlbW9uIHRvIHZlcmlmeTogJHtcbiAgICAgICAgZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpXG4gICAgICB9YCxcbiAgICB9O1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJvbGwob3B0czogeyBmb3JjZT86IGJvb2xlYW4gfSkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgLy8gQ09MRCBQQVRIIOKAlCBub3RoaW5nIHdhcyBydW5uaW5nLCBzbyB0aGlzIGlzIGEgc3RhcnQgcmF0aGVyIHRoYW4gYSByb2xsLlxuICAgIC8vIEl0IHN0aWxsIHJlcG9ydHMgdGhlIHZlcmlmeSwgYmVjYXVzZSBcIm5vIGRhZW1vbiB3YXMgdXBcIiBpcyBub3QgYSByZWFzb24gdG9cbiAgICAvLyBzdGF5IHNpbGVudCBhYm91dCB3aGljaCB2ZXJzaW9uIGlzIG5vdyBzZXJ2aW5nLlxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gICAgcHJpbnRKc29uKHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgcm9sbGVkOiB0cnVlLFxuICAgICAgcHJldmlvdXNfcGlkOiBudWxsLFxuICAgICAgcG9ydDogZnJlc2gsXG4gICAgICAuLi4oYXdhaXQgcHJvYmVWZXJzaW9uKGZyZXNoKSksXG4gICAgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgdG90YWwsIGNoYW5uZWxzIH0gPSBhd2FpdCBmZXRjaEFjdGl2ZVN1YnNjcmliZXJzKHBvcnQpO1xuICBpZiAodG90YWwgPiAwICYmICFvcHRzLmZvcmNlKSB7XG4gICAgY29uc3Qgd2hlcmUgPSBjaGFubmVscy5tYXAoKGMpID0+IGAke2MubmFtZX0gKCR7Yy5jb25uZWN0aW9uc30pYCkuam9pbihcIiwgXCIpO1xuICAgIGRpZShcbiAgICAgIGByb2xsOiAke3RvdGFsfSBhY3RpdmUgc3Vic2NyaWJlcihzKSDigJQgJHt3aGVyZX0uIFRoZXknbGwgYXV0by1yZWNvbm5lY3QgYWNyb3NzIHRoZSByb2xsLiBSZS1ydW4gd2l0aCAtLWZvcmNlIHRvIHByb2NlZWQuYCxcbiAgICAgIFwiY29uZmxpY3RcIixcbiAgICApO1xuICB9XG4gIGxldCBwcmV2aW91c1BpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIHRyeSB7XG4gICAgcHJldmlvdXNQaWQgPSAoYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIC8vIFN0b3Agd2l0aCBhIHNob3J0IGhvbGQgc28gYSBzdGFsZSBDTEkgY2FuJ3Qgd2luIHRoZSByZXNwYXduIHJhY2U7IHdlIGhvbGQgdGhlIHNwYXduIG91cnNlbHZlcy5cbiAgY29uc3QgaG9sZE1zID0gNDAwMDtcbiAgdHJ5IHtcbiAgICB3cml0ZUZpbGVTeW5jKEhPTERfRklMRSwgU3RyaW5nKERhdGUubm93KCkgKyBob2xkTXMpKTtcbiAgfSBjYXRjaCB7fVxuICB0cnkge1xuICAgIGF3YWl0IGFwaShwb3J0LCBcIkRFTEVURVwiLCBcIi9cIik7XG4gIH0gY2F0Y2gge31cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDUwKSk7XG4gICAgaWYgKChhd2FpdCByZWFkRGFlbW9uUG9ydCgpKSA9PT0gbnVsbCkgYnJlYWs7XG4gIH1cbiAgcmVsZWFzZUhvbGQoKTsgLy8gb3VyIHR1cm4gdG8gc3Bhd24gdGhlIG5ldyB2ZXJzaW9uXG4gIGNvbnN0IGZyZXNoID0gYXdhaXQgZW5zdXJlRGFlbW9uKCk7XG4gIGxldCBwaWQ6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIHBpZCA9IChhd2FpdCBhcGk8Um9vdEluZm8+KGZyZXNoLCBcIkdFVFwiLCBcIi9cIikpLmRhdGE/LnBpZCA/PyBudWxsO1xuICB9IGNhdGNoIHt9XG4gIHByaW50SnNvbih7XG4gICAgb2s6IHRydWUsXG4gICAgcm9sbGVkOiB0cnVlLFxuICAgIHByZXZpb3VzX3BpZDogcHJldmlvdXNQaWQsXG4gICAgcGlkLFxuICAgIHBvcnQ6IGZyZXNoLFxuICAgIC4uLihhd2FpdCBwcm9iZVZlcnNpb24oZnJlc2gpKSxcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFdhdGNoKG5hbWU6IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICAvLyBDaGFubmVsIG5hbWUgaXMgb3B0aW9uYWwg4oCUIHRoZSBwYWdlIHJlYWRzIGl0IGZyb20gdGhlIFVSTCBoYXNoIGFuZFxuICAvLyBkZWZhdWx0cyB0byBcImxvYmJ5XCIgaWYgYWJzZW50LiBXZSBwYXNzIHRocm91Z2ggd2hhdGV2ZXIgdGhlIHVzZXIgZ2F2ZVxuICAvLyAob3IgXCJsb2JieVwiKSBhbmQgb3BlbiB0aGUgYnJvd3Nlci4gRGFlbW9uIGlzIGVuc3VyZWQgc28gdGhlIHNlcnZlZFxuICAvLyAvd2F0Y2ggSFRNTCBpcyByZWFjaGFibGUuXG4gIGNvbnN0IGNoYW5uZWwgPSBuYW1lPy50cmltKCkgPyBuYW1lLnRyaW0oKSA6IFwibG9iYnlcIjtcbiAgY29uc3QgcG9ydCA9IGF3YWl0IGVuc3VyZURhZW1vbigpO1xuICAvLyBFbnN1cmUgdGhlIGNoYW5uZWwgZXhpc3RzIHNvIHRoZSBwYWdlIHNlZXMgYSB2YWxpZCBiYWNrbG9nL3RvcGljLlxuICBhd2FpdCBhcGkocG9ydCwgXCJQT1NUXCIsIFwiL2NoYW5uZWxzXCIsIHsgbmFtZTogY2hhbm5lbCB9KTtcbiAgY29uc3QgdXJsID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS93YXRjaCMke2VuY29kZVVSSUNvbXBvbmVudChjaGFubmVsKX1gO1xuICAvLyBPcGVuIHRoZSBicm93c2VyIHZpYSB0aGUgcGxhdGZvcm0ncyBkZWZhdWx0IG9wZW5lci4gQmVzdC1lZmZvcnQg4oCUXG4gIC8vIHByaW50IHRoZSBVUkwgc28gdGhlIHVzZXIgY2FuIGNsaWNrIGl0IGlmIGF1dG8tb3BlbiBmYWlscy5cbiAgY29uc3Qgb3BlbmVyID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcImV4cGxvcmVyXCIgOiBcInhkZy1vcGVuXCI7XG4gIHRyeSB7XG4gICAgY29uc3QgcCA9IHNwYXduKG9wZW5lciwgW3VybF0sIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgfSk7XG4gICAgcC51bnJlZigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBvcGVuZXIgbWlzc2luZyDigJQganVzdCBwcmludCAqL1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjaGFubmVsLCB1cmwgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZERvY3RvcigpIHtcbiAgLy8gUmVhZC1vbmx5IGRpYWdub3N0aWMuIFJlcG9ydHMgdGhlIGF1dGhvcml0YXRpdmUgZGFlbW9uIChpZiBhbnkpLCBvdGhlclxuICAvLyBncmFwZXZpbmUgZGFlbW9uIHByb2Nlc3NlcyB2aXNpYmxlIG9uIHRoZSBtYWNoaW5lLCBjaGFubmVsIGZpbGVzIG9uXG4gIC8vIGRpc2ssIGFuZCBzdXJmYWNlcyBoaW50cy4gRG9lcyBOT1QgdGFrZSBkZXN0cnVjdGl2ZSBhY3Rpb24g4oCUIGNsZWFudXBcbiAgLy8gaXMgdGhlIG9wZXJhdG9yJ3MgY2FsbCwgd2l0aCBzdG9jayB1bml4IHRvb2xzLlxuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgbGV0IGF1dGhvcml0YXRpdmU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCA9IG51bGw7XG4gIC8vIFBlci1jaGFubmVsIHN1YnNjcmliZXIgc3VtbWFyeSDigJQgYW5zd2VycyBcImlzIGl0IHNhZmUgdG8gcmVzdGFydCB0aGVcbiAgLy8gZGFlbW9uIHJpZ2h0IG5vdz9cIiB3aXRob3V0IG5lZWRpbmcgdG8gYWxzbyBydW4gYGxpc3RgIGFuZCByZWFkIHRoZVxuICAvLyBvdXRwdXQuIEVtcHR5IGlmIG5vIGRhZW1vbiBpcyBydW5uaW5nLlxuICBsZXQgdG90YWxTdWJzY3JpYmVycyA9IDA7XG4gIGNvbnN0IGJ1c3lDaGFubmVsczogQXJyYXk8e1xuICAgIG5hbWU6IHN0cmluZztcbiAgICBzdWJzY3JpYmVyczogbnVtYmVyO1xuICAgIGNvbm5lY3Rpb25zOiBudW1iZXI7XG4gICAgbmFtZWQ6IG51bWJlcjtcbiAgICBhbm9ueW1vdXM6IG51bWJlcjtcbiAgfT4gPSBbXTtcbiAgaWYgKHBvcnQpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3QgeyBkYXRhIH0gPSBhd2FpdCBhcGk8Um9vdEluZm8+KHBvcnQsIFwiR0VUXCIsIFwiL1wiKTtcbiAgICAgIGF1dGhvcml0YXRpdmUgPSB7IHBvcnQsIC4uLmRhdGEgfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIGRhZW1vbiB3ZW50IGF3YXkgYmV0d2VlbiBwb3J0IGNoZWNrIGFuZCBhcGkgY2FsbFxuICAgIH1cbiAgICB0cnkge1xuICAgICAgLy8gL3ByZXNlbmNlIGdpdmVzIHRoZSBob25lc3QgcGVyLWNoYW5uZWwgYnJlYWtkb3duIChjb25uZWN0aW9ucyB2cyBuYW1lZFxuICAgICAgLy8gdnMgYW5vbnltb3VzKSDigJQgc28gdGhlIHJlc3RhcnQtc2FmZXR5IHRvdGFsIGlzbid0IGEgbXlzdGVyeSBhbmQgYW5cbiAgICAgIC8vIGFub255bW91cyB3YXRjaCB0YWIgcmVhZHMgYXMgYSB3YXRjaGVyLCBub3QgYSBnaG9zdC5cbiAgICAgIGNvbnN0IHsgZGF0YTogcHJlc0RhdGEgfSA9IGF3YWl0IGFwaTxQcmVzZW5jZVJlc3BvbnNlPihwb3J0LCBcIkdFVFwiLCBcIi9wcmVzZW5jZVwiKTtcbiAgICAgIGZvciAoY29uc3QgY2ggb2YgcHJlc0RhdGE/LmNoYW5uZWxzID8/IFtdKSB7XG4gICAgICAgIHRvdGFsU3Vic2NyaWJlcnMgKz0gY2guY29ubmVjdGlvbnM7XG4gICAgICAgIGJ1c3lDaGFubmVscy5wdXNoKHtcbiAgICAgICAgICBuYW1lOiBjaC5uYW1lLFxuICAgICAgICAgIHN1YnNjcmliZXJzOiBjaC5jb25uZWN0aW9ucywgLy8gYmFjay1jb21wYXQ6IHByZXZpb3VzbHkgdGhlIHJhdyBjb3VudFxuICAgICAgICAgIGNvbm5lY3Rpb25zOiBjaC5jb25uZWN0aW9ucyxcbiAgICAgICAgICBuYW1lZDogY2gubmFtZWQsXG4gICAgICAgICAgYW5vbnltb3VzOiBjaC5hbm9ueW1vdXMsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gYmVzdC1lZmZvcnRcbiAgICB9XG4gIH1cblxuICAvLyBFbnVtZXJhdGUgb3RoZXIgZGFlbW9uIHByb2Nlc3NlcyB2aWEgdGhlIHNoYXJlZCBjbGFzc2lmaWVyLiBFYWNoIGVudHJ5XG4gIC8vIGdhaW5zIHBvcnQvaG9tZS92ZXJzaW9uL3N0YXR1cy9yZWFwYWJsZSBzbyB0aGUgb3BlcmF0b3IgaGFzIHRoZSBmdWxsXG4gIC8vIHBpY3R1cmUgd2l0aG91dCBuZWVkaW5nIGEgc2VwYXJhdGUgYHJlYXAgLS1kcnktcnVuYC5cbiAgY29uc3Qgb3RoZXJEYWVtb25zOiBBcnJheTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIGNsYXNzaWZ5RGFlbW9uPj4gJiB7IGNvbW1hbmQ/OiBzdHJpbmcgfT4gPSBbXTtcbiAgY29uc3Qgc2VsZlBpZCA9IGF1dGhvcml0YXRpdmU/LnBpZCBhcyBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBwaWQgb2YgYXdhaXQgbGlzdEdyYXBldmluZURhZW1vblBpZHMoKSkge1xuICAgICAgaWYgKHNlbGZQaWQgJiYgcGlkID09PSBzZWxmUGlkKSBjb250aW51ZTtcbiAgICAgIG90aGVyRGFlbW9ucy5wdXNoKGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCkpO1xuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gcHMgdW5hdmFpbGFibGU7IGNhcnJ5IG9uIHdpdGggZW1wdHkgbGlzdFxuICB9XG5cbiAgLy8gQ2hhbm5lbHMgb24gZGlzayB1bmRlciB0aGlzIEhPTUUuXG4gIGNvbnN0IGNoYW5uZWxzT25EaXNrOiBzdHJpbmdbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IGNoYW5uZWxzRGlyID0gam9pbihEQVRBX0RJUiwgXCJjaGFubmVsc1wiKTtcbiAgICBpZiAoZXhpc3RzU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgIGZvciAoY29uc3QgZiBvZiByZWFkZGlyU3luYyhjaGFubmVsc0RpcikpIHtcbiAgICAgICAgaWYgKGYuZW5kc1dpdGgoXCIuanNvbmxcIikpIGNoYW5uZWxzT25EaXNrLnB1c2goZi5yZXBsYWNlKC9cXC5qc29ubCQvLCBcIlwiKSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHt9XG5cbiAgLy8gSGludHMg4oCUIHN1cmZhY2UgdGhlIG1vc3QgYWN0aW9uYWJsZSBzaWduYWxzLlxuICBjb25zdCBoaW50czogc3RyaW5nW10gPSBbXTtcbiAgaWYgKCFhdXRob3JpdGF0aXZlKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIFwiTm8gYXV0aG9yaXRhdGl2ZSBkYWVtb24gcnVubmluZyBmb3IgdGhpcyBIT01FLiBSdW4gYW55IHZlcmIgKGUuZy4gYGNsaS50cyBsaXN0YCkgdG8gc3Bhd24gb25lLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKG90aGVyRGFlbW9ucy5sZW5ndGggPiAwKSB7XG4gICAgaGludHMucHVzaChcbiAgICAgIGBGb3VuZCAke290aGVyRGFlbW9ucy5sZW5ndGh9IG90aGVyIGdyYXBldmluZSBkYWVtb24gcHJvY2Vzcyhlcykgb24gdGhpcyBtYWNoaW5lLiBgICtcbiAgICAgICAgXCJUaGV5IG1heSBiZSB6b21iaWVzIGZyb20gcGFzdCBydW5zIE9SIGRhZW1vbnMgc2VydmluZyBvdGhlciBIT01FcyAoZGlmZmVyZW50IEdSQVBFVklORV9IT01FKS5cIixcbiAgICApO1xuICAgIGNvbnN0IHJlYXBhYmxlQ291bnQgPSBvdGhlckRhZW1vbnMuZmlsdGVyKChkKSA9PiBkLnJlYXBhYmxlKS5sZW5ndGg7XG4gICAgaWYgKHJlYXBhYmxlQ291bnQgPiAwKSB7XG4gICAgICBoaW50cy5wdXNoKFxuICAgICAgICBgRm91bmQgJHtyZWFwYWJsZUNvdW50fSByZWFwYWJsZSBvcnBoYW4gZGFlbW9uKHMpLiBSdW4gXFxgZ3JhcGV2aW5lIHJlYXBcXGAgdG8gY2xlYXIgdGhlbSBzYWZlbHkuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChvdGhlckRhZW1vbnMuc29tZSgoZCkgPT4gZC5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIpKSB7XG4gICAgICBoaW50cy5wdXNoKFwiU29tZSBkYWVtb25zIGFyZSB1bnJlc3BvbnNpdmU7IGBncmFwZXZpbmUgcmVhcCAtLWZvcmNlYCBpbmNsdWRlcyB0aGVtLlwiKTtcbiAgICB9XG4gIH1cbiAgaWYgKFxuICAgIGF1dGhvcml0YXRpdmUgJiZcbiAgICBQTFVHSU5fVkVSU0lPTiAmJlxuICAgIHR5cGVvZiBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IFwic3RyaW5nXCIgJiZcbiAgICBhdXRob3JpdGF0aXZlLnZlcnNpb24gIT09IFBMVUdJTl9WRVJTSU9OXG4gICkge1xuICAgIGhpbnRzLnB1c2goXG4gICAgICBgQXV0aG9yaXRhdGl2ZSBkYWVtb24gdmVyc2lvbiAoJHthdXRob3JpdGF0aXZlLnZlcnNpb259KSBkaWZmZXJzIGZyb20gdGhpcyBDTEkncyB2ZXJzaW9uICgke1BMVUdJTl9WRVJTSU9OfSkuIGAgK1xuICAgICAgICBcIlJlc3RhcnQgdGhlIGRhZW1vbiB0byBhbGlnbiDigJQgZHJvcCBhY3RpdmUgdGFpbHMsIHRoZW4gYHN0b3BgLCB0aGVuIGFueSB2ZXJiLlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGF1dGhvcml0YXRpdmUgJiYgKGF1dGhvcml0YXRpdmUudmVyc2lvbiA9PT0gbnVsbCB8fCBhdXRob3JpdGF0aXZlLnZlcnNpb24gPT09IHVuZGVmaW5lZCkpIHtcbiAgICBoaW50cy5wdXNoKFwiQXV0aG9yaXRhdGl2ZSBkYWVtb24gcHJlZGF0ZXMgdmVyc2lvbiByZXBvcnRpbmcgKHByZS1WMS42LjIpLiBSZXN0YXJ0IHRvIGFsaWduLlwiKTtcbiAgfVxuICBpZiAodG90YWxTdWJzY3JpYmVycyA+IDApIHtcbiAgICBoaW50cy5wdXNoKFxuICAgICAgYCR7dG90YWxTdWJzY3JpYmVyc30gYWN0aXZlIHN1YnNjcmliZXIocykgYWNyb3NzICR7YnVzeUNoYW5uZWxzLmxlbmd0aH0gY2hhbm5lbChzKS4gYCArXG4gICAgICAgIFwiRGFlbW9uIHJlc3RhcnQgd291bGQgZm9yY2UgdGhlbSB0byBhdXRvLXJlY29ubmVjdCAod29ya3MsIGJ1dCBkaXNydXB0aXZlKSDigJQgY29vcmRpbmF0ZSBmaXJzdC5cIixcbiAgICApO1xuICB9IGVsc2UgaWYgKGF1dGhvcml0YXRpdmUpIHtcbiAgICBoaW50cy5wdXNoKFwiTm8gYWN0aXZlIHN1YnNjcmliZXJzIOKAlCBkYWVtb24gcmVzdGFydCBpcyBub24tZGlzcnVwdGl2ZS5cIik7XG4gIH1cbiAgLy8gRXhwbGFpbiBhbnkgY2hhbm5lbCB3aGVyZSB0aGUgY29ubmVjdGlvbiBjb3VudCBleGNlZWRzIG5hbWVkIGFnZW50cyDigJQgYW5cbiAgLy8gYW5vbnltb3VzIHdhdGNoIHRhYiBpbmZsYXRlcyBgY291bnRgL2Bjb25uZWN0aW9uc2AgYnV0IGlzbid0IGEgZ2hvc3QuXG4gIGZvciAoY29uc3QgY2ggb2YgYnVzeUNoYW5uZWxzKSB7XG4gICAgaWYgKGNoLmFub255bW91cyA+IDApIHtcbiAgICAgIGhpbnRzLnB1c2goXG4gICAgICAgIGAke2NoLm5hbWV9OiAke2NoLmNvbm5lY3Rpb25zfSBjb25uZWN0aW9uKHMpLCAke2NoLm5hbWVkfSBuYW1lZCBhZ2VudChzKSArIGAgK1xuICAgICAgICAgIGAke2NoLmFub255bW91c30gYW5vbnltb3VzIChlLmcuIGEgd2F0Y2ggdGFiKS4gVGhlIGNvdW50IG92ZXIgdGhlIG5hbWUgbGlzdCBpcyBleHBlY3RlZCwgbm90IGEgZ2hvc3QuYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcHJpbnRKc29uKHtcbiAgICBvazogdHJ1ZSxcbiAgICBob21lOiBEQVRBX0RJUixcbiAgICBjbGlfdmVyc2lvbjogUExVR0lOX1ZFUlNJT04sXG4gICAgYXV0aG9yaXRhdGl2ZSxcbiAgICBhY3RpdmVfc3Vic2NyaWJlcnM6IHtcbiAgICAgIHRvdGFsOiB0b3RhbFN1YnNjcmliZXJzLFxuICAgICAgYnVzeV9jaGFubmVsczogYnVzeUNoYW5uZWxzLFxuICAgIH0sXG4gICAgb3RoZXJfZGFlbW9uc19vbl9tYWNoaW5lOiBvdGhlckRhZW1vbnMsXG4gICAgY2hhbm5lbHNfb25fZGlzazogY2hhbm5lbHNPbkRpc2ssXG4gICAgaGludHMsXG4gIH0pO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRJbmZvKCkge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgcmVhZERhZW1vblBvcnQoKTtcbiAgaWYgKCFwb3J0KSB7XG4gICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGRhZW1vbjogZmFsc2UgfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHsgZGF0YSB9ID0gYXdhaXQgYXBpPFJvb3RJbmZvPihwb3J0LCBcIkdFVFwiLCBcIi9cIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBkYWVtb246IHRydWUsIC4uLmRhdGEgfSk7XG59XG5cbi8vIOKUgOKUgCBEYWVtb24gZW51bWVyYXRpb24gKyBjbGFzc2lmaWVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKiogQWxsIGdyYXBldmluZSBkYWVtb24udHMgcGlkcyB2aXNpYmxlIG9uIHRoaXMgbWFjaGluZSAodmlhIGBwc2ApLiAqL1xuYXN5bmMgZnVuY3Rpb24gbGlzdEdyYXBldmluZURhZW1vblBpZHMoKTogUHJvbWlzZTxudW1iZXJbXT4ge1xuICBjb25zdCBwaWRzOiBudW1iZXJbXSA9IFtdO1xuICB0cnkge1xuICAgIGNvbnN0IHByb2MgPSBzcGF3bihcInBzXCIsIFtcIi1lb1wiLCBcInBpZCxjb21tYW5kXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcmVzb2x2ZSgpKSk7XG4gICAgY29uc3Qgb3V0ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKFwidXRmLThcIik7XG4gICAgZm9yIChjb25zdCBsaW5lIG9mIG91dC5zcGxpdChcIlxcblwiKSkge1xuICAgICAgaWYgKCFsaW5lLmluY2x1ZGVzKFwiZGFlbW9uLnRzXCIpKSBjb250aW51ZTtcbiAgICAgIGlmICghbGluZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKFwiZ3JhcGV2aW5lXCIpKSBjb250aW51ZTtcbiAgICAgIC8vIFRoZSBwaWQgZ3JvdXAgaXMgbWFuZGF0b3J5OyBhbiB1bm1hdGNoZWQgbGluZSBpcyBza2lwcGVkLCBhcyBiZWZvcmUuXG4gICAgICBjb25zdCBkaWdpdHMgPSBsaW5lLm1hdGNoKC9eXFxzKihcXGQrKVxccysvKT8uWzFdO1xuICAgICAgaWYgKGRpZ2l0cyA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBpZCA9IHBhcnNlSW50KGRpZ2l0cywgMTApO1xuICAgICAgaWYgKHBpZCkgcGlkcy5wdXNoKHBpZCk7XG4gICAgfVxuICB9IGNhdGNoIHtcbiAgICAvLyBwcyB1bmF2YWlsYWJsZTsgcmV0dXJuIGVtcHR5XG4gIH1cbiAgcmV0dXJuIHBpZHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxzb2ZMaXN0ZW5Qb3J0KHBpZDogbnVtYmVyKTogUHJvbWlzZTxudW1iZXIgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgcHJvYyA9IHNwYXduKFwibHNvZlwiLCBbXCItYWlUQ1BcIiwgXCItc1RDUDpMSVNURU5cIiwgXCItcFwiLCBTdHJpbmcocGlkKSwgXCItUFwiLCBcIi1uXCJdLCB7XG4gICAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBcImlnbm9yZVwiXSxcbiAgICB9KTtcbiAgICBjb25zdCBjaHVua3M6IEJ1ZmZlcltdID0gW107XG4gICAgcHJvYy5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoYikgPT4gY2h1bmtzLnB1c2goYiBhcyBCdWZmZXIpKTtcbiAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocikgPT4gcHJvYy5vbihcImV4aXRcIiwgKCkgPT4gcigpKSk7XG4gICAgLy8gVGhlIHBvcnQgZ3JvdXAgaXMgbWFuZGF0b3J5OyBubyBtYXRjaCBpcyB0aGlzIGZ1bmN0aW9uJ3Mgb3duIGBudWxsYC5cbiAgICBjb25zdCBkaWdpdHMgPSBCdWZmZXIuY29uY2F0KGNodW5rcylcbiAgICAgIC50b1N0cmluZyhcInV0Zi04XCIpXG4gICAgICAubWF0Y2goLzEyN1xcLjBcXC4wXFwuMTooXFxkKykvKT8uWzFdO1xuICAgIHJldHVybiBkaWdpdHMgPT09IHVuZGVmaW5lZCA/IG51bGwgOiBwYXJzZUludChkaWdpdHMsIDEwKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuZXhwb3J0IHR5cGUgRGFlbW9uU3RhdHVzID0gXCJhdXRob3JpdGF0aXZlXCIgfCBcIm9ycGhhblwiIHwgXCJ1bnJlc3BvbnNpdmVcIiB8IFwidW5rbm93blwiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnlEYWVtb24ocGlkOiBudW1iZXIpOiBQcm9taXNlPHtcbiAgcGlkOiBudW1iZXI7XG4gIHBvcnQ6IG51bWJlciB8IG51bGw7XG4gIGhvbWU/OiBzdHJpbmc7XG4gIHZlcnNpb24/OiBzdHJpbmcgfCBudWxsO1xuICBzdGF0dXM6IERhZW1vblN0YXR1cztcbiAgcmVhcGFibGU6IGJvb2xlYW47XG59PiB7XG4gIGNvbnN0IHBvcnQgPSBhd2FpdCBsc29mTGlzdGVuUG9ydChwaWQpO1xuICBpZiAoIXBvcnQpIHJldHVybiB7IHBpZCwgcG9ydDogbnVsbCwgc3RhdHVzOiBcInVua25vd25cIiwgcmVhcGFibGU6IGZhbHNlIH07XG4gIGxldCBpbmZvOiBSb290SW5mbyB8IG51bGwgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vYCwge1xuICAgICAgc2lnbmFsOiBBYm9ydFNpZ25hbC50aW1lb3V0KDgwMCksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykgaW5mbyA9IChhd2FpdCByZXMuanNvbigpKSBhcyBSb290SW5mbztcbiAgfSBjYXRjaCB7fVxuICBpZiAoIWluZm8pIHJldHVybiB7IHBpZCwgcG9ydCwgc3RhdHVzOiBcInVucmVzcG9uc2l2ZVwiLCByZWFwYWJsZTogZmFsc2UgfTsgLy8gcmVhcCBvbmx5IHdpdGggLS1mb3JjZSAoaGFuZGxlZCBpbiBjbWRSZWFwKVxuICBjb25zdCBob21lID0gaW5mby5kYXRhX2RpciBhcyBzdHJpbmc7XG4gIGxldCBvd25zID0gZmFsc2U7XG4gIHRyeSB7XG4gICAgY29uc3Qgb3AgPSByZWFkRmlsZVN5bmMoam9pbihob21lLCBcImRhZW1vbi5wb3J0XCIpLCBcInV0Zi04XCIpLnRyaW0oKTtcbiAgICBjb25zdCBvaSA9IHJlYWRGaWxlU3luYyhqb2luKGhvbWUsIFwiZGFlbW9uLnBpZFwiKSwgXCJ1dGYtOFwiKS50cmltKCk7XG4gICAgb3ducyA9IG9wID09PSBTdHJpbmcocG9ydCkgJiYgb2kgPT09IFN0cmluZyhwaWQpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiBvd25zXG4gICAgPyB7XG4gICAgICAgIHBpZCxcbiAgICAgICAgcG9ydCxcbiAgICAgICAgaG9tZSxcbiAgICAgICAgdmVyc2lvbjogaW5mby52ZXJzaW9uID8/IG51bGwsXG4gICAgICAgIHN0YXR1czogXCJhdXRob3JpdGF0aXZlXCIsXG4gICAgICAgIHJlYXBhYmxlOiBmYWxzZSxcbiAgICAgIH1cbiAgICA6IHtcbiAgICAgICAgcGlkLFxuICAgICAgICBwb3J0LFxuICAgICAgICBob21lLFxuICAgICAgICB2ZXJzaW9uOiBpbmZvLnZlcnNpb24gPz8gbnVsbCxcbiAgICAgICAgc3RhdHVzOiBcIm9ycGhhblwiLFxuICAgICAgICByZWFwYWJsZTogdHJ1ZSxcbiAgICAgIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYXAob3B0czogeyBmb3JjZT86IGJvb2xlYW47IGRyeVJ1bj86IGJvb2xlYW4gfSkge1xuICBjb25zdCBzZWxmUG9ydCA9IGF3YWl0IHJlYWREYWVtb25Qb3J0KCk7IC8vIGN1cnJlbnQgSE9NRSBhdXRob3JpdGF0aXZlIChuZXZlciByZWFwKVxuICBsZXQgc2VsZlBpZDogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGlmIChzZWxmUG9ydCkge1xuICAgIHRyeSB7XG4gICAgICBzZWxmUGlkID0gKGF3YWl0IGFwaTxSb290SW5mbz4oc2VsZlBvcnQsIFwiR0VUXCIsIFwiL1wiKSkuZGF0YT8ucGlkID8/IG51bGw7XG4gICAgfSBjYXRjaCB7fVxuICB9XG4gIGNvbnN0IHBpZHMgPSBhd2FpdCBsaXN0R3JhcGV2aW5lRGFlbW9uUGlkcygpO1xuICBjb25zdCBrZXB0OiB1bmtub3duW10gPSBbXSxcbiAgICByZWFwZWQ6IHVua25vd25bXSA9IFtdLFxuICAgIHNraXBwZWQ6IHVua25vd25bXSA9IFtdO1xuICBmb3IgKGNvbnN0IHBpZCBvZiBwaWRzKSB7XG4gICAgY29uc3QgYyA9IGF3YWl0IGNsYXNzaWZ5RGFlbW9uKHBpZCk7XG4gICAgY29uc3QgaXNTZWxmID0gcGlkID09PSBzZWxmUGlkO1xuICAgIGNvbnN0IHNob3VsZFJlYXAgPVxuICAgICAgIWlzU2VsZiAmJiAoYy5yZWFwYWJsZSB8fCAoYy5zdGF0dXMgPT09IFwidW5yZXNwb25zaXZlXCIgJiYgb3B0cy5mb3JjZSA9PT0gdHJ1ZSkpO1xuICAgIGlmICghc2hvdWxkUmVhcCkge1xuICAgICAga2VwdC5wdXNoKGMpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChvcHRzLmRyeVJ1bikge1xuICAgICAgc2tpcHBlZC5wdXNoKHsgLi4uYywgbm90ZTogXCJkcnktcnVuXCIgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHByb2Nlc3Mua2lsbChwaWQsIFwiU0lHVEVSTVwiKTtcbiAgICAgIHJlYXBlZC5wdXNoKGMpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgc2tpcHBlZC5wdXNoKHsgLi4uYywgbm90ZTogXCJraWxsIGZhaWxlZFwiIH0pO1xuICAgIH1cbiAgfVxuICBwcmludEpzb24oeyBvazogdHJ1ZSwgZHJ5X3J1bjogISFvcHRzLmRyeVJ1biwga2VwdCwgcmVhcGVkLCBza2lwcGVkIH0pO1xufVxuXG4vLyAoQk9PTEVBTl9GTEFHUyB3YXMgaGVyZS4gSXQgbGlzdGVkIHdoaWNoIGZsYWdzIHRha2Ugbm8gdmFsdWUg4oCUIGhhbGYgYVxuLy8gcmVnaXN0cnksIGNvbnN1bHRlZCBieSB0aGUgaGFuZC1yb2xsZWQgcGFyc2VyLiBJdHMgMTMgZW50cmllcyBub3cgbGl2ZSBpblxuLy8gQ0xJX09QVElPTlMgYmVsb3cgYXMgYHt0eXBlOlwiYm9vbGVhblwifWAsIHZlcmlmaWVkIDEzLWZvci0xMyBhZ2FpbnN0IHRob3RoJ3Ncbi8vIGluZGVwZW5kZW50bHktZGVyaXZlZCBhcnRpZmFjdCBiZWZvcmUgdGhlIG1vdmUuIERlbGV0ZWQgcmF0aGVyIHRoYW4gbGVmdFxuLy8gYmVzaWRlIGl0cyByZXBsYWNlbWVudDogYSBzZWNvbmQgc291cmNlIG9mIHRydXRoIGZvciB0aGUgc2FtZSBmYWN0IGlzIHRoZVxuLy8gZHJpZnQgYnVnIHRoaXMgbGFuZSBleGlzdHMgdG8gcmVtb3ZlLCBhbmQgaXQgd291bGQgbm8gbG9uZ2VyIGJlIGNvbnN1bHRlZFxuLy8gYnkgYW55dGhpbmcuKVxuXG4vLyBTaWduYXR1cmUgb2YgYSBoZXJlZG9jIGZ1bWJsZTogYSBsaW5lIHRoYXQgaXMgKG9yIGJlZ2lucyB3aXRoKSBhXG4vLyBgYnVuIOKApiBjbGkudHMg4oCmIHNlbmRgIGludm9jYXRpb24uIFdoZW4gYSBgc2VuZCAtLXN0ZGluIDw8RU9GYCBpcyBib3RjaGVkLCB0aGVcbi8vIHNoZWxsIHBpcGVzIHRoZSBsaXRlcmFsIGNvbW1hbmQgbGluZSBpbiBhcyB0aGUgYm9keSwgd2hpY2ggdGhlbiBnZXRzIHBvc3RlZCDigJRcbi8vIGNvcnJ1cHRpbmcgdGhlIGNoYW5uZWwgd2l0aCBgYnVuIC/igKYvY2xpLnRzIHNlbmQgPGNoYW5uZWw+IC0tYXMg4oCmIDx0ZXh0PmAuXG4vLyBXZSByZWZ1c2UgdG8gcG9zdCBzdWNoIGEgYm9keSB1bmxlc3MgLS1mb3JjZSBpcyBwYXNzZWQuXG5jb25zdCBMRUFLRURfU0VORF9SRSA9IC8oPzpefFxcbilbIFxcdF0qYnVuXFxiW15cXG5dKlxcYmNsaVxcLnRzXFxiW15cXG5dKlxcYig/OnNlbmR8YW5ub3VuY2UpXFxiLztcbmZ1bmN0aW9uIGxvb2tzTGlrZUxlYWtlZFNlbmQodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBMRUFLRURfU0VORF9SRS50ZXN0KHRleHQpO1xufVxuXG4vLyBTaGVsbC1tZXRhY2hhcmFjdGVyIGZvb3RndW4gKCM2MCk6IGEgYm9keSBwYXNzZWQgYXMgYW4gSU5MSU5FIHBvc2l0aW9uYWwgYXJnXG4vLyBpcyBleHBvc2VkIHRvIHRoZSBjYWxsZXIncyBzaGVsbCwgd2hpY2ggY29tbWFuZC1zdWJzdGl0dXRlcyBiYWNrdGlja3MgL1xuLy8gYCQoLi4uKWAgLyBgJHsuLi59YCBCRUZPUkUgZ3JhcGV2aW5lIHNlZXMgaXQg4oCUIGNvcnJ1cHRpbmcgb3IgcGFydGlhbGx5XG4vLyBleGVjdXRpbmcgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLiBUaGUgQ0xJIGNhbid0IHVuLXN1YnN0aXR1dGUgd2hhdCB0aGUgc2hlbGxcbi8vIGFscmVhZHkgYXRlOyB0aGUgaG9uZXN0IGZpeCBpcyB0byBzdGVlciBjYWxsZXJzIHRvIHRoZSBzaGVsbC1mcmVlIHBhdGhzXG4vLyAoLS1ib2R5LWZpbGUgLyAtLXN0ZGluIC8gZGVmYXVsdC1zdGRpbikuIFdoZW4gbWV0YWNoYXJhY3RlcnMgU1VSVklWRSBpbnRvIGFuXG4vLyBpbmxpbmUgYm9keSAoZS5nLiB0aGUgY2FsbGVyIGhhcHBlbmVkIHRvIHNpbmdsZS1xdW90ZSksIHRoZXkncmUgaW50YWN0IHRoaXNcbi8vIHRpbWUg4oCUIGJ1dCB0aGUgcGF0dGVybiBpcyBhIGxhdGVudCBmb290Z3VuLCBzbyB3ZSB3YXJuIChuZXZlciBibG9jazogdGhlXG4vLyBtZXNzYWdlIGlzIGZpbmUgYXMgcmVjZWl2ZWQpLiBBYnNlbnQtbWV0YWNoYXIgaW5saW5lIGJvZGllcyBhcmUgZWl0aGVyIHBsYWluXG4vLyB0ZXh0IChzYWZlKSBvciBhbHJlYWR5LXN1YnN0aXR1dGVkICh1bmRldGVjdGFibGUpIOKAlCBzbyB3ZSBvbmx5IHdhcm4gb24gdGhlXG4vLyBkZXRlY3RhYmxlIHJpc2t5IHBhdHRlcm4uXG5jb25zdCBTSEVMTF9NRVRBQ0hBUl9SRSA9IC9gfFxcJFxcKHxcXCRcXHsvO1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzU2hlbGxSaXNreSh0ZXh0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFNIRUxMX01FVEFDSEFSX1JFLnRlc3QodGV4dCk7XG59XG5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS5cbi8vXG4vLyBncmFwZXZpbmUgYWxyZWFkeSBoYWQgSEFMRiBhIHJlZ2lzdHJ5OiBgQk9PTEVBTl9GTEFHU2AgYWJvdmUgdG9sZCB0aGUgcGFyc2VyXG4vLyB3aGljaCBmbGFncyB0YWtlIG5vIHZhbHVlLiBXaGF0IGl0IGhhZCBubyBub3Rpb24gb2Ygd2FzIHdoaWNoIGZsYWdzIEVYSVNULCBzb1xuLy8gYW4gdW5rbm93biBmbGFnIHdhcyBhY2NlcHRlZCBhdCBleGl0IDAgYW5kIHRoZSB2ZXJiIHJhbiBhbnl3YXksIGFuZCBmcmVlIHByb3NlXG4vLyBjb250YWluaW5nIGEgYC0td29yZGAgd2FzIHNpbGVudGx5IHRydW5jYXRlZCBhdCB0aGF0IHdvcmQuXG4vL1xuLy8g4pqgIGdyYXBldmluZSBpcyB0aGUgT1VUTElFUiBvZiB0aGUgc2l4LCBhbmQgaXQgaXMgd29ydGggc2F5aW5nIHdoeSBzbyBub2JvZHlcbi8vIHJlYWRzIGl0IGFzIG1lcmVseSBiZWhpbmQ6IGl0IHR5cGVzIGl0cyB2YWx1ZSBmbGFncyB3aXRoIGEgQ0FTVFxuLy8gKGBmbGFncy50b3BpYyBhcyBzdHJpbmcgfCB1bmRlZmluZWRgKSB3aGVyZSB0aGUgb3RoZXIgZW50cnkgcG9pbnRzIHVzZSBhXG4vLyBgdHlwZW9mYCBndWFyZC4gQSBjYXN0IGlzIGEgY2xhaW0gd2l0aCBOTyBSVU5USU1FIENIRUNLLCBzbyBncmFwZXZpbmUgY2FycmllZFxuLy8gYSBjbGFzcyBvZiBsYXRlbnQgdHlwZS1saWUgdGhlIG90aGVycyB3ZXJlIGd1YXJkZWQgYWdhaW5zdCDigJQgYW5kIGJhcmUgdmFsdWVcbi8vIGZsYWdzIHByb2R1Y2VkIHNpbGVudCB3cm9uZyB2YWx1ZXMgcmF0aGVyIHRoYW4gZXJyb3JzOlxuLy9cbi8vICAgLS1sYXN0ICAgYmFyZSAgLT4gIHBhcnNlSW50KHRydWUsIDEwKSAgLT4gIE5hTiwgc2lsZW50bHlcbi8vICAgLS10b3BpYyAgYmFyZSAgLT4gIGB0cnVlYCBpbiBhIGZpZWxkIERFQ0xBUkVEIGBzdHJpbmdgXG4vL1xuLy8gYHN0cmljdDogdHJ1ZWAgdHVybnMgZWFjaCBvZiB0aG9zZSBmcm9tIGEgc2lsZW50IHdyb25nIHZhbHVlIGludG8gYVxuLy8gY2FsbGVyLWZhY2luZyBlcnJvciwgd2hpY2ggaXMgdGhlIGxhbmUncyB3aG9sZSBwdXJwb3NlIGFuZCB0aGUgbGFyZ2VzdFxuLy8gYmVoYXZpb3VyIGRlbHRhIG9mIHRoZSBzaXggZW50cnkgcG9pbnRzLlxuLy9cbi8vIFRoZSBib29sZWFuIHNldCBiZWxvdyBpcyBCT09MRUFOX0ZMQUdTLCB1bmNoYW5nZWQg4oCUIGV4dHJhY3RlZCBmcm9tIHRoaXMgZmlsZVxuLy8gYW5kIGRpZmZlZCBhZ2FpbnN0IHRob3RoJ3MgaW5kZXBlbmRlbnRseS1kZXJpdmVkIGFydGlmYWN0OiAxMyBmb3IgMTMsIGV4YWN0LFxuLy8gemVybyBkaXZlcmdlbmNlIGluIGVpdGhlciBkaXJlY3Rpb24uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hhbm5lbHM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaG9sZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwiaW4tcmVwbHktdG9cIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBtYXg6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBub3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdG9waWM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBhbGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJkcnktcnVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZm9yY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgZnJlc2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJmcm9tLXN0YXJ0XCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgaHVtYW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgbGl0ZXJhbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBsdXJrOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHF1aWV0OiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRleHQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdmVyYm9zZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB5ZXM6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbn0gYXMgY29uc3Q7XG5cbnR5cGUgRmxhZ05hbWUgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG5cbi8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgR0xPQkFMOiBTS0lMTC5tZCB0ZWxscyBhZ2VudHMgdG8gcGFzcyAtLWFzLy0tZnJvbVxuLy8gb24gRVZFUlkgdmVyYiAoYSBmcmVzaCBzaGVsbCBwZXIgY29tbWFuZCBtZWFucyBHUkFQRVZJTkVfRlJPTSBuZXZlclxuLy8gcGVyc2lzdHMpLCBzbyBldmVyeSBjb21tYW5kIGFjY2VwdHMgYm90aCDigJQgZXZlbiB3aGVyZSBhIHZlcmIgaGFzIG5vIHVzZSBmb3Jcbi8vIGlkZW50aXR5LCBhIGNhbGxlciBmb2xsb3dpbmcgb3VyIG93biBkb2NzIG11c3Qgbm90IGJlIHJlamVjdGVkIGZvciBvYmV5aW5nXG4vLyB0aGVtLiBPbiBgZ3JlcGAsIGAtLWZyb21gIGlzIGFuIGF1dGhvciBGSUxURVIgcmF0aGVyIHRoYW4gaWRlbnRpdHk6IGRpZmZlcmVudFxuLy8gc2VtYW50aWNzLCBzYW1lIGFjY2VwdGFuY2UuXG5jb25zdCBHTE9CQUxfRkxBR1M6IEZsYWdOYW1lW10gPSBbXCJhc1wiLCBcImZyb21cIl07XG5cbi8vIFRIRSBDT01NQU5EIFRBQkxFLCBBUyBBIFNUUlVDVFVSRSDigJQgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsIHRoZSBzY2hlbWFcbi8vIGVtaXR0ZXIgYW5kIHRoZSByb290IHJlamVjdGlvbiBhbGwgd2FsayBUSElTLiBJdCByZXBsYWNlZCBhIGJhcmUgYHN3aXRjaGAsXG4vLyB3aGljaCBvbmx5IHRoZSBkaXNwYXRjaGVyIGNvdWxkIHdhbGs6IGEgc2NoZW1hIGVtaXR0ZWQgZnJvbSBhbnl0aGluZyBvdGhlclxuLy8gdGhhbiB0aGUgc3RydWN0dXJlIHRoYXQgcm91dGVzIHRoZSBiZWhhdmlvdXIgaXMgYSBkb2N1bWVudCB0aGF0IGxpZXMgYXMgc29vblxuLy8gYXMgYW55b25lIGVkaXRzIHRoZSBvdGhlciBzaWRlIChhY2MgU1RBTkRBUkQubWQgUGFydCAxIMKnMjsgb3VyIG93biAjODEvRDRcbi8vIGxhbmUgbGVhcm5lZCB0aGUgc2FtZSBsZXNzb24gb25lIGFsdGl0dWRlIGRvd24gd2l0aCBCT09MRUFOX0ZMQUdTKS5cbi8vXG4vLyBgZmxhZ3NgIGlzIHRoZSB2ZXJiJ3MgT1dOIGFjY2VwdGVkIHNldCAoR0xPQkFMX0ZMQUdTIGFyZSBtZXJnZWQgaW4gYnkgdGhlXG4vLyBraXQgcmVnaXN0cnksIGBnbG9iYWxGbGFnc2ApLiBBIGZsYWcgbm90IGxpc3RlZCBoZXJlIGlzIFJFSkVDVEVEIGZvciB0aGlzIHZlcmIgd2l0aCB0aGVcbi8vIHZlcmIncyBvd24gc2V0IGVudW1lcmF0ZWQg4oCUIGFjY2VwdGVkLWFuZC1pZ25vcmVkIGlzIHRoZSBkaXNlYXNlIHRoaXMgdGFibGVcbi8vIGV4aXN0cyB0byBjdXJlIChhY2MgRFQtMTogYW50aGlsbCBhY2NlcHRpbmcgYSByb290IGAtLWZvcm1hdGAgaXQgc2lsZW50bHlcbi8vIGRpc2NhcmRzOyBncmFwZXZpbmUgYWNjZXB0aW5nIGBzZW5kIC0tZHJ5LXJ1bmAgYW5kIGRvaW5nIG5vdGhpbmcgd2FzIHRoZVxuLy8gc2FtZSBldmVudCB3aXRoIGEgZGlmZmVyZW50IHNwZWxsaW5nKS5cbi8qKlxuICogQSByb3cgYXMgZ3JhcGV2aW5lIHdyaXRlcyBpdDogdGhlIGtpdCdzIGBDb21tYW5kU3BlY2Agd2l0aCB0aGUgaGFuZGxlciB0YWtpbmdcbiAqIGAocG9zaXRpb25hbCwgZmxhZ3MpYCwgYWRhcHRlZCB0byB0aGUga2l0J3MgYHJ1bihpbnYpYCBieSBgb25gIGJlbG93LiBOb1xuICogYGRlc2NyaWJlYDogZ3JhcGV2aW5lJ3MgaGVscCBpcyBoYW5kLXdyaXR0ZW4gKGBoZWxwVGV4dGApLCBzbyB0aGUgcmVuZGVyZWRcbiAqIGhlbHAgdGhhdCByZWFkcyBpdCBpcyBuZXZlciBzaG93bi5cbiAqXG4gKiDimqAgVEhFIEhBTkRMRVIgTUFZIFJFVFVSTiBBTiBFWElUIENPREUsIEFORCBFWEFDVExZIE9ORSBWRVJCIERPRVMuIGB0YWlsYCBydW5zXG4gKiB0aGUgc2hhcmVkIGNsaWVudCAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoaWNoIFJFVFVSTlMgYSBjb2RlIHJhdGhlclxuICogdGhhbiBlbmRpbmcgdGhlIHByb2Nlc3MgZnJvbSBpbnNpZGUgdGhyZWUgbmVzdGVkIGxvb3BzIOKAlCBzbyB0aGUgY29kZSBoYXMgdG9cbiAqIHJlYWNoIGBtYWluYCwgYW5kIHRoaXMgaXMgdGhlIHNlYW0gaXQgY3Jvc3Nlcy4gQW55dGhpbmcgdGhhdCBpcyBub3QgYSBudW1iZXJcbiAqIG1lYW5zIDAsIHdoaWNoIGlzIHdoYXQgdGhlIG90aGVyIHR3ZW50eS1vZGQgdmVyYnMgcmV0dXJuLiBUeXBlZCBgdW5rbm93bmBcbiAqIHJhdGhlciB0aGFuIGEgdW5pb24gd2l0aCBgdm9pZGA6IGV2ZXJ5IGBhc3luY2AgdmVyYiB0aGF0IGVuZHMgd2l0aG91dCBhXG4gKiBgcmV0dXJuYCBpcyBgUHJvbWlzZTx2b2lkPmAuXG4gKi9cbnR5cGUgUm93ID0gT21pdDxDb21tYW5kU3BlYzxGbGFnTmFtZT4sIFwicnVuXCIgfCBcImRlc2NyaWJlXCIgfCBcInJlamVjdEhpbnRcIj4gJiB7XG4gIHJ1bjogKHBvc2l0aW9uYWw6IHN0cmluZ1tdLCBmbGFnczogRmxhZ3MpID0+IHVua25vd247XG59O1xuXG4vKiogYHRhaWwgLS1zaW5jZWAgdGhyb3VnaCB0aGUga2l0J3Mgb25lIHJlYWRlciAoYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCxcbiAqICBgcmVhZFNpbmNlYCk6IGFuIGlkIG9mIDAgb3IgbW9yZTsgYW4gZXBvY2ggYm9va21hcmsgcHJpbnRlZCBieSBhbm90aGVyXG4gKiAgc3BlbGwncyBoYW5kb2ZmIGxpbmUgaXMgcmVmdXNlZCB3aXRoIHRoZSBhY2NlcHRlZCBmb3JtcyBuYW1lZC4gKi9cbmZ1bmN0aW9uIHNpbmNlT3JEaWUodG9rZW46IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHIgPSByZWFkU2luY2UodG9rZW4sIHsgZXBvY2g6IGZhbHNlLCBtaW46IDAgfSk7XG4gIC8vIFRoZSBgdGFpbDpgIHByZWZpeCBldmVyeSBvdGhlciBncmFwZXZpbmUgZmxhZyByZWZ1c2FsIGNhcnJpZXMuXG4gIGlmICghci5vaykgZGllKGB0YWlsOiAke3IubWVzc2FnZX1gLCBcInVzYWdlXCIpO1xuICByZXR1cm4gci5zaW5jZTtcbn1cblxuLy8gQSBkZWNsYXJlZCB2YWx1ZSBmbGFnIHRoYXQgY2FycmllcyBhIG51bWJlciBtdXN0IFJFSkVDVCBhIG5vbi1udW1iZXIgYXMgYVxuLy8gdXNhZ2UgZXJyb3IgKGV4aXQgMiksIG5vdCBjcmFzaCBvbiBpdCBkb3duc3RyZWFtIOKAlCBgc2NoZW1hYCBwdWJsaXNoZXMgdGhlXG4vLyBmbGFnIGFzIHZhbGlkLCBzbyB0aGUgcGFyc2UgYm91bmRhcnkgaXMgd2hlcmUgYSBiYWQgdmFsdWUgZ2V0cyBpdHNcbi8vIGNhbGxlci1mYWNpbmcgYW5zd2VyLiAoYHdhaXQgLS10aW1lb3V0IG5vdGFudW1iZXJgIHVzZWQgdG8gdGhyb3cgYW5cbi8vIHVuaGFuZGxlZCBSYW5nZUVycm9yIGF0IGV4aXQgMSwgc3RhY2sgdHJhY2UgYW5kIGFsbC4pXG5mdW5jdGlvbiBudW1lcmljRmxhZyh2ZXJiOiBzdHJpbmcsIG5hbWU6IHN0cmluZywgcmF3OiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkKSByZXR1cm4gZmFsbGJhY2s7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUobikgfHwgbiA8IDApXG4gICAgZGllKGAke3ZlcmJ9OiAtLSR7bmFtZX0gZXhwZWN0cyBhIG5vbi1uZWdhdGl2ZSBudW1iZXIsIGdvdCAke0pTT04uc3RyaW5naWZ5KFN0cmluZyhyYXcpKX1gKTtcbiAgcmV0dXJuIG47XG59XG5cbi8vIEJvZHkgcmVzb2x1dGlvbiBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZSDigJQgZmlyc3QgbWF0Y2ggd2luczogLS1ib2R5LWZpbGUsXG4vLyAtLXN0ZGluLCBpbmxpbmUgcG9zaXRpb25hbHMsIGRlZmF1bHQtc3RkaW4gd2hlbiBwaXBlZC4gU2VlIHRoZSBwZXItdmVyYlxuLy8gY29tbWVudHMgYXQgdGhlIG9yaWdpbmFsIHNpdGVzIChWMS42LyM2MCk7IGJlaGF2aW91ciB1bmNoYW5nZWQuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlQm9keShcbiAgdmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsXG4gIGlubGluZTogc3RyaW5nW10sXG4gIGZsYWdzOiBGbGFncyxcbik6IFByb21pc2U8eyB0ZXh0OiBzdHJpbmc7IGZyb21JbmxpbmU6IGJvb2xlYW4gfT4ge1xuICBpZiAoZmxhZ3NbXCJib2R5LWZpbGVcIl0pIHtcbiAgICBjb25zdCBwYXRoID0gZmxhZ3NbXCJib2R5LWZpbGVcIl0gYXMgc3RyaW5nO1xuICAgIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICByZXR1cm4geyB0ZXh0OiAoYXdhaXQgZmlsZS50ZXh0KCkpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKSwgZnJvbUlubGluZTogZmFsc2UgfTtcbiAgfVxuICBpZiAoZmxhZ3Muc3RkaW4gfHwgKGlubGluZS5sZW5ndGggPT09IDAgJiYgIXByb2Nlc3Muc3RkaW4uaXNUVFkpKSB7XG4gICAgY29uc3QgYnVmOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciBhd2FpdCAoY29uc3QgY2h1bmsgb2YgcHJvY2Vzcy5zdGRpbikgYnVmLnB1c2goY2h1bmsgYXMgQnVmZmVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgdGV4dDogQnVmZmVyLmNvbmNhdChidWYpLnRvU3RyaW5nKFwidXRmLThcIikucmVwbGFjZSgvXFxuJC8sIFwiXCIpLFxuICAgICAgZnJvbUlubGluZTogZmFsc2UsXG4gICAgfTtcbiAgfVxuICByZXR1cm4geyB0ZXh0OiBpbmxpbmUuam9pbihcIiBcIiksIGZyb21JbmxpbmU6IHRydWUgfTtcbn1cblxuLy8gVGhlIHR3byBib2R5IGd1YXJkcyBzaGFyZWQgYnkgc2VuZC9hbm5vdW5jZTogcmVmdXNlIGEgbGVha2VkIGludm9jYXRpb25cbi8vIChmdW1ibGVkIGhlcmVkb2MpIHVubGVzcyAtLWZvcmNlLCBhbmQgd2FybiBvbiBzaGVsbCBtZXRhY2hhcmFjdGVycyB0aGF0XG4vLyBzdXJ2aXZlZCBhbiBpbmxpbmUgYm9keSAoIzYwIOKAlCB3YXJuLCBuZXZlciBibG9jaykuXG5mdW5jdGlvbiBndWFyZEJvZHkodmVyYjogXCJzZW5kXCIgfCBcImFubm91bmNlXCIsIHRleHQ6IHN0cmluZywgZnJvbUlubGluZTogYm9vbGVhbiwgZm9yY2U6IGJvb2xlYW4pIHtcbiAgaWYgKCFmb3JjZSAmJiBsb29rc0xpa2VMZWFrZWRTZW5kKHRleHQpKSB7XG4gICAgZGllKFxuICAgICAgYCR7dmVyYn06IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGdyYXBldmluZSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgYCArXG4gICAgICAgIFwiaGVyZWRvYz8pLiBOb3RoaW5nIHdhcyBzZW50LiBQaXBlIHRoZSByZWFsIGJvZHkgdmlhIC0tc3RkaW4gb3IgXCIgK1xuICAgICAgICBcIi0tYm9keS1maWxlIDxwYXRoPiwgb3IgcGFzcyAtLWZvcmNlIHRvIHNlbmQgaXQgYW55d2F5LlwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZyb21JbmxpbmUgJiYgbG9va3NTaGVsbFJpc2t5KHRleHQpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBcIiMg4pqgIGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgYmVmb3JlIFwiICtcbiAgICAgICAgXCJncmFwZXZpbmUgc2VlcyB0aGVtIOKAlCB1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiDim5QgUkVHSVNURVIgQTEg4oCUIGBjaG9pY2VzYCBJUyBgR0xPQkFMX0ZMQUdTYCwgVEhFIFNFVCBgcmVzb2x2ZUFsaWFzYCBSRUFEUy5cbiAqIFRoaXMgaXMgYSBESVNKVU5DVElPTiAoZWl0aGVyIGZsYWcgc2F0aXNmaWVzIGl0KSwgc28gdGhlIGNhbGxlciBoYXMgdG8gcGljayxcbiAqIGFuZCBpdCBpcyB0aGUgb25lIGlkZW50aXR5IHJlZnVzYWwgZm91ciB2ZXJicyBzaGFyZS4gVGhlIGVudiB2YXIgc3RheXMgaW5cbiAqIGBoaW50YCBhbmQgZGVsaWJlcmF0ZWx5IE5PVCBpbiBgY2hvaWNlc2A6IGBjaG9pY2VzYCBlbnVtZXJhdGVzIENPTU1BTkRcbiAqIFRPS0VOUyDigJQgd2hhdCB3b3VsZCBoYXZlIGJlZW4gYWNjZXB0ZWQgSU4gVEhFIElOVk9DQVRJT04g4oCUIGFuZCBwdXR0aW5nIGFuXG4gKiBlbnZpcm9ubWVudCBuYW1lIGluIHRoZSBzYW1lIGFycmF5IHdvdWxkIGdpdmUgYSBjYWxsZXIgYSBcImNob2ljZVwiIGl0IGNhbm5vdFxuICogcGFzcyBvbiB0aGUgY29tbWFuZCBsaW5lLlxuICovXG5jb25zdCBpZGVudGl0eVJlcXVpcmVkID0gKHZlcmI6IHN0cmluZyk6IG5ldmVyID0+XG4gIGRpZShgJHt2ZXJifTogaWRlbnRpdHkgcmVxdWlyZWRgLCBcInVzYWdlXCIsIHtcbiAgICBoaW50OiBgcGFzcyAke0dMT0JBTF9GTEFHUy5tYXAoKGYpID0+IGAtLSR7Zn1gKS5qb2luKFwiL1wiKX0gPGFsaWFzPiwgb3Igc2V0IEdSQVBFVklORV9GUk9NYCxcbiAgICBjaG9pY2VzOiBHTE9CQUxfRkxBR1MubWFwKChmKSA9PiBgLS0ke2Z9YCksXG4gIH0pO1xuXG4vLyDimqAgRVZFUlkgQ09NTUFORCBGVU5DVElPTiBCRUxPVyBSRUZVU0VTIEEgTUlTU0lORyBQT1NJVElPTkFMIE9OIElUUyBPV04gRklSU1Rcbi8vIExJTkUgKGEgdXNhZ2UgcmVmdXNhbCB3aGVuIHRoZSBuYW1lIGlzIGZhbHN5KSwgYW5kIGVhY2ggbm93IGRlY2xhcmVzIHRoYXQgcGFyYW1ldGVyXG4vLyBgc3RyaW5nIHwgdW5kZWZpbmVkYCBzbyBpdHMgc2lnbmF0dXJlIHNheXMgd2hhdCB0aGF0IGxpbmUgZG9lcyAodHlwZS1kZWJ0XG4vLyBUMzUpLiBBcml0eSBkaXNwYXRjaCByZWZ1c2VzIGEgbWlzc2luZyByZXF1aXJlZCBwb3NpdGlvbmFsIGJlZm9yZSBhbnkgb2Zcbi8vIHRoZW0gcnVucywgc28gdGhlIGd1YXJkcyBhcmUgdGhlIHNlY29uZCBsaW5lIG9mIGRlZmVuY2UsIG5vdCB0aGUgZmlyc3QuXG5jb25zdCBST1dTOiBSb3dbXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJ0b3BpY1wiLCBcImZyZXNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE9wZW4ocG9zaXRpb25hbFswXSwge1xuICAgICAgICB0b3BpYzogZmxhZ3MudG9waWMgYXMgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICAgICAgICBmcm9tOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBmcmVzaDogZmxhZ3MuZnJlc2ggPT09IHRydWUsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0b3BpY1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRUb3BpYyhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgcG9zaXRpb25hbC5sZW5ndGggPiAxID8gcG9zaXRpb25hbC5zbGljZSgxKS5qb2luKFwiIFwiKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGlzdFwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRMaXN0KCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwidmVyYm9zZVwiLCBcImZvcmNlXCIsIFwiaW4tcmVwbHktdG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgY29uc3QgbmFtZSA9IHBvc2l0aW9uYWxbMF07XG4gICAgICBjb25zdCBmcm9tID0gcmVzb2x2ZUFsaWFzKGZsYWdzKTtcbiAgICAgIGNvbnN0IHsgdGV4dCwgZnJvbUlubGluZSB9ID0gYXdhaXQgcmVzb2x2ZUJvZHkoXCJzZW5kXCIsIHBvc2l0aW9uYWwuc2xpY2UoMSksIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcInNlbmRcIik7XG4gICAgICBndWFyZEJvZHkoXCJzZW5kXCIsIHRleHQsIGZyb21JbmxpbmUsICEhZmxhZ3MuZm9yY2UpO1xuICAgICAgYXdhaXQgY21kU2VuZChuYW1lLCBmcm9tIGFzIHN0cmluZywgdGV4dCwge1xuICAgICAgICBxdWlldDogISFmbGFncy5xdWlldCxcbiAgICAgICAgdmVyYm9zZTogISFmbGFncy52ZXJib3NlLFxuICAgICAgICBpblJlcGx5VG86IGZsYWdzW1wiaW4tcmVwbHktdG9cIl1cbiAgICAgICAgICA/IG51bWVyaWNGbGFnKFwic2VuZFwiLCBcImluLXJlcGx5LXRvXCIsIGZsYWdzW1wiaW4tcmVwbHktdG9cIl0sIDApXG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbm5vdW5jZVwiLFxuICAgIGZsYWdzOiBbXCJib2R5LWZpbGVcIiwgXCJzdGRpblwiLCBcInF1aWV0XCIsIFwiZm9yY2VcIiwgXCJjaGFubmVsc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSByZXNvbHZlQWxpYXMoZmxhZ3MpO1xuICAgICAgY29uc3QgeyB0ZXh0LCBmcm9tSW5saW5lIH0gPSBhd2FpdCByZXNvbHZlQm9keShcImFubm91bmNlXCIsIHBvc2l0aW9uYWwsIGZsYWdzKTtcbiAgICAgIGlmICghZnJvbSkgaWRlbnRpdHlSZXF1aXJlZChcImFubm91bmNlXCIpO1xuICAgICAgZ3VhcmRCb2R5KFwiYW5ub3VuY2VcIiwgdGV4dCwgZnJvbUlubGluZSwgISFmbGFncy5mb3JjZSk7XG4gICAgICBjb25zdCBjaGFubmVscyA9IGZsYWdzLmNoYW5uZWxzXG4gICAgICAgID8gKGZsYWdzLmNoYW5uZWxzIGFzIHN0cmluZylcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKGMpID0+IGMudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGF3YWl0IGNtZEFubm91bmNlKGZyb20gYXMgc3RyaW5nLCB0ZXh0LCBjaGFubmVscywgeyBxdWlldDogISFmbGFncy5xdWlldCB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwdWxsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwic3RhdHVzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJwdWxsXCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgYXdhaXQgY21kUHVsbChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgeyBzdGF0dXM6IGZsYWdzLnN0YXR1cyBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidHJpYWdlXCIsXG4gICAgZmxhZ3M6IFtcImh1bWFuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFRyaWFnZShwb3NpdGlvbmFsWzBdLCB7IGh1bWFuOiAhIWZsYWdzLmh1bWFuIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlYWRcIixcbiAgICBmbGFnczogW1widGV4dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IGlkID0gcG9zaXRpb25hbFsxXSA/IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSA6IE5hTjtcbiAgICAgIGF3YWl0IGNtZFJlYWQocG9zaXRpb25hbFswXSwgaWQsIHsgdGV4dDogISFmbGFncy50ZXh0IH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndhaXRcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJ0aW1lb3V0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGNvbnN0IHNpbmNlID0gbnVtZXJpY0ZsYWcoXCJ3YWl0XCIsIFwic2luY2VcIiwgZmxhZ3Muc2luY2UsIDApO1xuICAgICAgY29uc3QgdGltZW91dCA9IG51bWVyaWNGbGFnKFwid2FpdFwiLCBcInRpbWVvdXRcIiwgZmxhZ3MudGltZW91dCwgMzApO1xuICAgICAgYXdhaXQgY21kV2FpdChwb3NpdGlvbmFsWzBdLCBzaW5jZSwgdGltZW91dCwgcmVzb2x2ZUFsaWFzKGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2hvXCIsXG4gICAgZmxhZ3M6IFtcImFsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgaWYgKGZsYWdzLmFsbCkgYXdhaXQgY21kV2hvQWxsKCk7XG4gICAgICBlbHNlIGF3YWl0IGNtZFdobyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhbGlhc1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBbGlhcyhwb3NpdGlvbmFsWzBdKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWlsXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwiZnJvbS1zdGFydFwiLCBcImxhc3RcIiwgXCJodW1hblwiLCBcImx1cmtcIiwgXCJtYXhcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgcmV0dXJuIGF3YWl0IGNtZFRhaWwocG9zaXRpb25hbFswXSwge1xuICAgICAgICBzaW5jZTogZmxhZ3Muc2luY2UgIT09IHVuZGVmaW5lZCA/IHNpbmNlT3JEaWUoU3RyaW5nKGZsYWdzLnNpbmNlKSkgOiB1bmRlZmluZWQsXG4gICAgICAgIGZyb21TdGFydDogISFmbGFnc1tcImZyb20tc3RhcnRcIl0sXG4gICAgICAgIGxhc3Q6IGZsYWdzLmxhc3QgIT09IHVuZGVmaW5lZCA/IG51bWVyaWNGbGFnKFwidGFpbFwiLCBcImxhc3RcIiwgZmxhZ3MubGFzdCwgMCkgOiB1bmRlZmluZWQsXG4gICAgICAgIGFzOiByZXNvbHZlQWxpYXMoZmxhZ3MpLFxuICAgICAgICBodW1hbjogISFmbGFncy5odW1hbixcbiAgICAgICAgbHVyazogISFmbGFncy5sdXJrLFxuICAgICAgICBtYXg6IHJlc29sdmVUYWlsTWF4KGZsYWdzLm1heCksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmVwXCIsXG4gICAgZmxhZ3M6IFtcImxpdGVyYWxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwicGF0dGVyblwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRHcmVwKHBvc2l0aW9uYWxbMF0sIHBvc2l0aW9uYWwuc2xpY2UoMSkuam9pbihcIiBcIiksIHtcbiAgICAgICAgbGl0ZXJhbDogISFmbGFncy5saXRlcmFsLFxuICAgICAgICBmcm9tOiBmbGFncy5mcm9tIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kQ2xvc2UocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVzZXRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzZXQocG9zaXRpb25hbFswXSwgeyBmb3JjZTogZmxhZ3MuZm9yY2UgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFya1wiLFxuICAgIGZsYWdzOiBbXCJub3RlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiZGlzcG9zaXRpb25cIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kTWFyayhcbiAgICAgICAgcG9zaXRpb25hbFswXSxcbiAgICAgICAgLy8gTmFOIGZvciBhIG1pc3NpbmcgaWQsIGV4YWN0bHkgd2hhdCBgcGFyc2VJbnQodW5kZWZpbmVkKWAgZ2F2ZSDigJQgYW5kXG4gICAgICAgIC8vIGBjbWRNYXJrYCByZWZ1c2VzIGEgbm9uLWZpbml0ZSBpZCBvbiBpdHMgZmlyc3QgbGluZS5cbiAgICAgICAgcG9zaXRpb25hbFsxXSA9PT0gdW5kZWZpbmVkID8gTnVtYmVyLk5hTiA6IHBhcnNlSW50KHBvc2l0aW9uYWxbMV0sIDEwKSxcbiAgICAgICAgcG9zaXRpb25hbC5zbGljZSgyKS5qb2luKFwiIFwiKSxcbiAgICAgICAgcmVzb2x2ZUFsaWFzKGZsYWdzKSA/PyBpZGVudGl0eVJlcXVpcmVkKFwibWFya1wiKSxcbiAgICAgICAgeyBub3RlOiBmbGFncy5ub3RlIGFzIHN0cmluZyB8IHVuZGVmaW5lZCB9LFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZW9wZW5cIixcbiAgICBmbGFnczogW1wibm90ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcIm5hbWVcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZE1hcmsoXG4gICAgICAgIHBvc2l0aW9uYWxbMF0sXG4gICAgICAgIC8vIE5hTiBmb3IgYSBtaXNzaW5nIGlkLCBleGFjdGx5IHdoYXQgYHBhcnNlSW50KHVuZGVmaW5lZClgIGdhdmUg4oCUIGFuZFxuICAgICAgICAvLyBgY21kTWFya2AgcmVmdXNlcyBhIG5vbi1maW5pdGUgaWQgb24gaXRzIGZpcnN0IGxpbmUuXG4gICAgICAgIHBvc2l0aW9uYWxbMV0gPT09IHVuZGVmaW5lZCA/IE51bWJlci5OYU4gOiBwYXJzZUludChwb3NpdGlvbmFsWzFdLCAxMCksXG4gICAgICAgIFwib3BlblwiLFxuICAgICAgICByZXNvbHZlQWxpYXMoZmxhZ3MpID8/IGlkZW50aXR5UmVxdWlyZWQoXCJyZW9wZW5cIiksXG4gICAgICAgIHsgbm90ZTogZmxhZ3Mubm90ZSBhcyBzdHJpbmcgfCB1bmRlZmluZWQgfSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYXJjaGl2ZVwiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIHJ1bjogYXN5bmMgKHBvc2l0aW9uYWwsIGZsYWdzKSA9PiB7XG4gICAgICBhd2FpdCBjbWRBcmNoaXZlKHBvc2l0aW9uYWxbMF0sIGZhbHNlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmFyY2hpdmVcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBydW46IGFzeW5jIChwb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kQXJjaGl2ZShwb3NpdGlvbmFsWzBdLCB0cnVlLCByZXNvbHZlQWxpYXMoZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGFydFwiLFxuICAgIGFsaWFzZXM6IFtcInVwXCJdLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRTdGFydCgpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJlc3RhcnRcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVzdGFydCh7IGZvcmNlOiAhIWZsYWdzLmZvcmNlIHx8ICEhZmxhZ3MueWVzIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJvbGxcIixcbiAgICBmbGFnczogW1wiZm9yY2VcIiwgXCJ5ZXNcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUm9sbCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSB8fCBmbGFncy55ZXMgPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RvcFwiLFxuICAgIGZsYWdzOiBbXCJob2xkXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jIChfcG9zaXRpb25hbCwgZmxhZ3MpID0+IHtcbiAgICAgIGF3YWl0IGNtZFN0b3Aoe1xuICAgICAgICBob2xkU2Vjb25kczpcbiAgICAgICAgICBmbGFncy5ob2xkICE9PSB1bmRlZmluZWQgPyBudW1lcmljRmxhZyhcInN0b3BcIiwgXCJob2xkXCIsIGZsYWdzLmhvbGQsIDApIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwid2F0Y2hcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgcnVuOiBhc3luYyAocG9zaXRpb25hbCkgPT4ge1xuICAgICAgYXdhaXQgY21kV2F0Y2gocG9zaXRpb25hbFswXSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVhcFwiLFxuICAgIGFsaWFzZXM6IFtcInBydW5lXCJdLFxuICAgIGZsYWdzOiBbXCJmb3JjZVwiLCBcImRyeS1ydW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogYXN5bmMgKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgYXdhaXQgY21kUmVhcCh7IGZvcmNlOiBmbGFncy5mb3JjZSA9PT0gdHJ1ZSwgZHJ5UnVuOiBmbGFnc1tcImRyeS1ydW5cIl0gPT09IHRydWUgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBbXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICBhd2FpdCBjbWRJbmZvKCk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9jdG9yXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgIGF3YWl0IGNtZERvY3RvcigpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICBmbGFnczogW1wiaHVtYW5cIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIHJ1bjogKF9wb3NpdGlvbmFsLCBmbGFncykgPT4ge1xuICAgICAgLy8gVGhlIENMSSBjYW4gYmUgQVNLRUQgd2hhdCBpdCBpcy4gZ3JhcGV2aW5lIGFscmVhZHkgY2Fycmllc1xuICAgICAgLy8gUExVR0lOX1ZFUlNJT04gdG8gd2FybiB0aGF0IGEgZGFlbW9uIGlzIGZyb20gYSBkaWZmZXJlbnQgY2FjaGVkIHBsdWdpblxuICAgICAgLy8gcGF0aCB0aGFuIHRoaXMgQ0xJIChtYXliZVdhcm5PblZlcnNpb25NaXNtYXRjaCkg4oCUIGJ1dCBhIGNhbGxlciB0aGF0IGhpdFxuICAgICAgLy8gdGhhdCB3YXJuaW5nLCBvciB0aGF0IHJ1bnMgYHJvbGxgIGZvciBpdHMgdmVyc2lvbiB2ZXJpZnksIGhhZCBubyB3YXkgdG9cbiAgICAgIC8vIGFzayB0aGlzIHNpZGUgd2hhdCBpdCBpcyBob2xkaW5nLiBUaGUgdmFsdWUgd2FzIGFscmVhZHkgaW4gbWVtb3J5OyBvbmx5XG4gICAgICAvLyB0aGUgcXVlc3Rpb24gd2FzIG1pc3NpbmcuXG4gICAgICAvLyBKU09OIGJ5IGRlZmF1bHQsIG1hdGNoaW5nIGV2ZXJ5IGRhdGEgY29tbWFuZDsgLS1odW1hbiBmb3IgcHJvc2UuXG4gICAgICBpZiAoUExVR0lOX1ZFUlNJT04gPT09IG51bGwpXG4gICAgICAgIGRpZShcInZlcnNpb24gdW5hdmFpbGFibGUg4oCUIGNvdWxkIG5vdCByZWFkIHBsdWdpbi5qc29uXCIsIFwiaW50ZXJuYWxcIik7XG4gICAgICBpZiAoZmxhZ3MuaHVtYW4gPT09IHRydWUpIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBncmFwZXZpbmUgdiR7UExVR0lOX1ZFUlNJT059XFxuYCk7XG4gICAgICBlbHNlIHByaW50SnNvbih7IG5hbWU6IFwiZ3JhcGV2aW5lXCIsIHZlcnNpb246IFBMVUdJTl9WRVJTSU9OIH0pO1xuICAgIH0sXG4gIH0sXG5dO1xuXG4vKiogVGhlIHJlamVjdGlvbiBoaW50IGBzZW5kYCBhbmQgYGFubm91bmNlYCBhZGQgdG8gZXZlcnkgZmxhZyByZWZ1c2FsOiBhXG4gKiAgbWVzc2FnZSBib2R5IGlzIHByb3NlLCBhbmQgcHJvc2Ugd2l0aCBhIGRhc2ggaW4gaXQgaGFzIHRocmVlIHNhZmUgcm91dGVzLiAqL1xuY29uc3QgQk9EWV9ISU5UID1cbiAgXCJmb3IgYSBtZXNzYWdlIGJvZHkgY29udGFpbmluZyBkYXNoZXMsIHVzZSAtLXN0ZGluIG9yIC0tYm9keS1maWxlLCBvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCI7XG5cbi8qKiBncmFwZXZpbmUgZGVjbGFyZXMgbm8gYG11bHRpcGxlYCBmbGFnLCBzbyBldmVyeSB2YWx1ZSBpcyBhIHN0cmluZyBvciBhXG4gKiAgYm9vbGVhbiDigJQgdGhlIGBGbGFnc2AgdGhlIGhhbmRsZXJzIHRha2UuICovXG5jb25zdCBvbiA9XG4gIChoOiBSb3dbXCJydW5cIl0pID0+XG4gIChpbnY6IEludm9jYXRpb248RmxhZ05hbWU+KTogdW5rbm93biA9PlxuICAgIGgoaW52LnBvcywgaW52LmZsYWdzIGFzIEZsYWdzKTtcblxuLy8gVEhFIFJFR0lTVFJZIOKAlCB0aGUgaG91c2UncyBvbmUgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2ApLiBncmFwZXZpbmUncyBvd25cbi8vIGRpc3BhdGNoZXIsIHBlci12ZXJiIHBhcnNlciwgcm9vdCByb3V0ZXIgYW5kIGRlY2xhcmF0aW9uIGVtaXR0ZXIgd2VyZSB0aGVcbi8vIHZlcmItZmlyc3QgaGFsZiBvZiB3aGF0IHRoYXQgbW9kdWxlIHdhcyBnZW5lcmFsaXNlZCBmcm9tLCBhbmQgd2VyZSBkZWxldGVkXG4vLyB3aGVuIGdyYXBldmluZSBtb3ZlZCBvbnRvIGl0LiBXaGF0IHRoZSBtb2R1bGUgbm93IGRvZXMgaGVyZSwgYW5kIGdyYXBldmluZVxuLy8gdXNlZCB0byBkbyBpdHNlbGY6XG4vL1xuLy8gICAtIFRoZSB2ZXJiIGlzIGBhcmd2WzBdYC4gQSBkYXNoLWxlZCBgYXJndlswXWAgdGhhdCBpcyBub3QgYW4gaW50ZXJjZXB0b3IgaXNcbi8vICAgICBhbiB1bmtub3duIFJPT1QgZmxhZywgcmVqZWN0ZWQgd2l0aCB0aGUgaW50ZXJjZXB0b3JzIChsb25nIGZpcnN0KSBhc1xuLy8gICAgIGBjaG9pY2VzYCBhbmQgdGhlIGNvbW1hbmRzIGluIHRoZSBoaW50LCBzbyBgZ3JhcGV2aW5lIC0tYXMgeCBsaXN0YCBpc1xuLy8gICAgIHJlZnVzZWQgcmF0aGVyIHRoYW4gcGFyc2VkLlxuLy8gICAtIGAtLWhlbHBgL2AtaGAvYC0tdmVyc2lvbmAvYC1WYCBhcyBgYXJndlswXWAgcnVuIHRoZSBgaGVscGAgb3IgYHZlcnNpb25gXG4vLyAgICAgcm93IGFuZCBQQVNTIFRIRSBSRVNUIE9OOiBgZ3JhcGV2aW5lIC0tdmVyc2lvbiAtLWh1bWFuYCBhbmRcbi8vICAgICBgLVYgLS1hcyBtZWAga2VlcCB3b3JraW5nLCBiZWNhdXNlIGB2ZXJzaW9uYCBhY2NlcHRzIHRoZW0uXG4vLyAgIC0gQSBiYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciBuYW1pbmcgZXZlcnkgY29tbWFuZCBhbmQgYWxpYXNcbi8vICAgICAoYWNjIEQyKSwgbmV2ZXIgaGVscCBhdCBleGl0IDA6IGdyYXBldmluZSdzIGNhbGxlcnMgYXJlIGFnZW50cywgYW5kIGFcbi8vICAgICBiYXJlIGNhbGwgaXMgYW4gdW5zZXQgc2hlbGwgdmFyaWFibGUgZXhwYW5kaW5nIHRvIG5vdGhpbmcuXG4vLyAgIC0gQSBmbGFnIGFub3RoZXIgdmVyYiB0YWtlcyBpcyBNSVNQTEFDRUQgKGAtLXggaXMgbm90IGFjY2VwdGVkIGJ5XG4vLyAgICAgXFxgc2VuZFxcYGApLCBhbiB1bmtub3duIG9uZSBVTktOT1dOOyBib3RoIGNhcnJ5IHRoaXMgdmVyYidzIGFjY2VwdGVkIHNldFxuLy8gICAgIChpdHMgb3duIGZsYWdzIHBsdXMgYC0tYXNgL2AtLWZyb21gKSBhcyBgY2hvaWNlc2AuXG4vLyAgIC0gQXJpdHkgaXMgZW5mb3JjZWQgZnJvbSBlYWNoIHJvdydzIHBvc2l0aW9uYWxzLCBuYW1pbmcgdGhlIG1pc3Npbmdcbi8vICAgICBgPHBvc2l0aW9uYWw+YCBvciB0aGUgZXh0cmEgdG9rZW4gKGFjYyBBNCkuXG4vLyAgIC0gYHNjaGVtYWAgYW5kIGBoZWxwYCBhcmUgdGhlIG1vZHVsZSdzIHJvd3M7IGB2ZXJzaW9uYCBpcyBncmFwZXZpbmUncyBvd24sXG4vLyAgICAgZm9yIGAtLWh1bWFuYC5cbi8vXG4vLyDim5QgQlVJTERJTkcgVEhFIFRBQkxFIEhBUyBOTyBTSURFIEVGRkVDVFM6IGBkZWZpbmVDbGlgIG9ubHkgdmFsaWRhdGVzIGFuZFxuLy8gaW5kZXhlcywgc28gYSB3YXJkIG9yIGEgdGVzdCBjYW4gaW1wb3J0IGl0IGFuZCByZWFkIHRoZSB0YWJsZS5cbmV4cG9ydCBjb25zdCBjbGkgPSBkZWZpbmVDbGkoe1xuICBuYW1lOiBcImdyYXBldmluZVwiLFxuICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgY29tbWFuZHM6IFJPV1MubWFwKChyKSA9PiAoe1xuICAgIC4uLnIsXG4gICAgZGVzY3JpYmU6IFwiXCIsXG4gICAgcnVuOiBvbihyLnJ1biksXG4gICAgLi4uKHIubmFtZSA9PT0gXCJzZW5kXCIgfHwgci5uYW1lID09PSBcImFubm91bmNlXCIgPyB7IHJlamVjdEhpbnQ6IEJPRFlfSElOVCB9IDoge30pLFxuICB9KSksXG4gIC8vIElkZW50aXR5IGlzIGNvbnRyYWN0dWFsbHkgZ2xvYmFsIOKAlCBzZWUgR0xPQkFMX0ZMQUdTLlxuICBnbG9iYWxGbGFnczogR0xPQkFMX0ZMQUdTLFxuICAvLyBPbmx5IHRoZSBhdXRvIGB2ZXJzaW9uYCByb3cgcmVhZHMgdGhpcywgYW5kIGdyYXBldmluZSBkZWZpbmVzIGl0cyBvd24gcm93LlxuICB2ZXJzaW9uOiAoKSA9PiAoeyBuYW1lOiBcImdyYXBldmluZVwiLCB2ZXJzaW9uOiBQTFVHSU5fVkVSU0lPTiA/PyBcInVua25vd25cIiB9KSxcbiAgaGVscDogaGVscFRleHQsXG59KTtcblxuZnVuY3Rpb24gaGVscFRleHQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBncmFwZXZpbmUg4oCUIGFnZW50LXRvLWFnZW50IHdhbGtpZS10YWxraWVcblxuVXNhZ2U6XG4gIGdyYXBldmluZSBvcGVuIDxuYW1lPiBbLS10b3BpYyA8dGV4dD5dIFstLWZyZXNoXSAgIG9wZW4vY3JlYXRlIChhdXRvLXVuYXJjaGl2ZXM7IC0tZnJlc2ggY2xlYXJzIGEgZG9ybWFudCBjaGFubmVsKVxuICBncmFwZXZpbmUgbGlzdFxuICBncmFwZXZpbmUgc2VuZCA8bmFtZT4gWy0tZnJvbS8tLWFzIDxhbGlhcz5dIFstLXF1aWV0XSBbLS12ZXJib3NlXSBbLS1zdGRpbl0gWy0tYm9keS1maWxlIDxwYXRoPl0gWy0tZm9yY2VdIFstLWluLXJlcGx5LXRvIDxpZD5dIFs8dGV4dC4uLj5dXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIGJvZHk6IGlubGluZSB0ZXh0LCAtLXN0ZGluLCAtLWJvZHktZmlsZSwgb3IgcGlwZWQgc3RkaW4gKGRlZmF1bHQgd2hlbiBubyBpbmxpbmUgdGV4dClcbiAgZ3JhcGV2aW5lIGFubm91bmNlIFstLWZyb20vLS1hcyA8YWxpYXM+XSBbLS1jaGFubmVscyBhLGIsY10gWy0tc3RkaW5dIFstLWJvZHktZmlsZSA8cGF0aD5dIFstLXF1aWV0XSBbPHRleHQuLi4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBicm9hZGNhc3Qgb25lIG1lc3NhZ2UgdG8gZXZlcnkgYWN0aXZlIGNoYW5uZWwgKG9yIC0tY2hhbm5lbHMpXG4gIGdyYXBldmluZSB0YWlsIDxuYW1lPiBbLS1hcy8tLWZyb20gPGFsaWFzPl0gWy0tc2luY2UgPGlkPl0gWy0tZnJvbS1zdGFydF0gWy0tbGFzdCA8bj5dIFstLWh1bWFuXSBbLS1sdXJrXSBbLS1tYXggPG4+XVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyAke1dJTkRPV19IRUxQfSAoLS1odW1hbiBuZXZlciBlbmRzIGJ5IGl0c2VsZilcbiAgICAgICAjIC0tbGFzdCA8bj46IGJhY2tmaWxsIHRoZSBtb3N0IHJlY2VudCBuIG1lc3NhZ2VzIHRoZW4gZ28gbGl2ZSAoYm91bmRlZCBjYXRjaC11cCBmb3IgYSBjb2xkIGpvaW5lcilcbiAgZ3JhcGV2aW5lIHB1bGwgPG5hbWU+IFstLXNpbmNlIDxpZD5dIFstLXN0YXR1cyA8dmFsdWU+XSAgICMgLS1zdGF0dXMgPSBmdWxsLXNjYW4gZmlsdGVyIChvcGVufHdvbnRmaXh8aW5jb3Jwb3JhdGVkfOKApilcbiAgZ3JhcGV2aW5lIHRyaWFnZSA8bmFtZT4gICAgICAgICAgICAgIyBmdWxsLXNjYW46IG9wZW4gbWVzc2FnZXMgb24gdG9wICsgZ3JvdXBlZCBieV9zdGF0dXNcbiAgZ3JhcGV2aW5lIG1hcmsgPG5hbWU+IDxpZD4gPGRpc3Bvc2l0aW9uPiBbLS1ub3RlIDx0ZXh0Pl0gICMgc2V0IGRpc3Bvc2l0aW9uIChpbmNvcnBvcmF0ZWR8d29udGZpeHxkZWZlcnJlZHzigKYpXG4gIGdyYXBldmluZSByZW9wZW4gPG5hbWU+IDxpZD4gICAgICAgICMgYm91bmNlIGEgbWVzc2FnZSBiYWNrIHRvIG9wZW5cbiAgZ3JhcGV2aW5lIHJlYWQgPG5hbWU+IDxpZD4gWy0tdGV4dF0gICAjIG9uZSBmdWxsIG1lc3NhZ2UgYnkgaWQgKC0tdGV4dCA9IHByb3NlKVxuICBncmFwZXZpbmUgd2FpdCA8bmFtZT4gWy0tc2luY2UgPGlkPl0gWy0tdGltZW91dCA8cz5dXG4gIGdyYXBldmluZSBncmVwIDxuYW1lPiA8cGF0dGVybj4gWy0tbGl0ZXJhbF0gWy0tZnJvbSA8YWxpYXM+XVxuICBncmFwZXZpbmUgdG9waWMgPG5hbWU+IFs8dGV4dD5dICAgIyBubyB0ZXh0IOKGkiByZWFkIGN1cnJlbnQ7IHdpdGggdGV4dCDihpIgdXBkYXRlXG4gIGdyYXBldmluZSB3aG8gPG5hbWU+ICAgICAgICAgICAgICAjIHJvc3RlcjsgdGhlIGh1bWFucyBmaWVsZCBsaXN0cyBodW1hbnNcbiAgZ3JhcGV2aW5lIGFsaWFzIFs8bmFtZT5dICAgICAgICAgICMgc2V0L3Nob3cgeW91ciBwZXJzaXN0ZWQgYWxpYXMgKGNvbmZpZy5qc29uKVxuICBncmFwZXZpbmUgd2F0Y2ggWzxuYW1lPl0gICAgICAgICAgIyBvcGVuIGJyb3dzZXIgdGFiOyBsaXZlIGNoYXQtYnViYmxlIHZpZXdcbiAgZ3JhcGV2aW5lIHJlc2V0IDxuYW1lPiBbLS1mb3JjZV0gICAgICAgICAgIHNuYXBzaG90IHRoZSBsb2cg4oaSIH4vLmdyYXBldmluZS9hcmNoaXZlLCB0aGVuIGNsZWFyIGl0XG4gIGdyYXBldmluZSBhcmNoaXZlIDxuYW1lPiAgICAgICAgICAjIHJlYWQtb25seToga2VlcCBoaXN0b3J5LCByZWplY3Qgc2VuZHNcbiAgZ3JhcGV2aW5lIHVuYXJjaGl2ZSA8bmFtZT4gICAgICAgICMgYnJpbmcgYW4gYXJjaGl2ZWQgY2hhbm5lbCBiYWNrXG4gIGdyYXBldmluZSBjbG9zZSA8bmFtZT4gICAgICAgICAgICAjIGRlc3RydWN0aXZlOiBkZWxldGUgdGhlIG1lc3NhZ2UgbG9nXG4gIGdyYXBldmluZSBzdGFydCAgICAgICAgICAgICAgICAgICAjIGVuc3VyZSB0aGUgZGFlbW9uIGlzIHJ1bm5pbmcgKGFsaWFzOiB1cCk7IG5vIGNoYW5uZWxcbiAgZ3JhcGV2aW5lIHJlc3RhcnQgWy0tZm9yY2V8LS15ZXNdICMgc3RvcCArIHJlc3Bhd24gZnJlc2g7IC0tZm9yY2UgdG8gb3ZlcnJpZGUgdGhlIGxpdmUtZmxlZXQgZ3VhcmRcbiAgZ3JhcGV2aW5lIHJvbGwgWy0tZm9yY2VdICAgICAgICAgICMgc2FmZSByZXN0YXJ0IChzdG9wK2hvbGQrcmVzcGF3bikgKyB2ZXJzaW9uIHZlcmlmeSDigJQgdGhlIHJlY29tbWVuZGVkIGRlcGxveSBzdGVwXG4gIGdyYXBldmluZSBzdG9wIFstLWhvbGQgPHNlY29uZHM+XSAjIGtpbGwgdGhlIGRhZW1vbjsgLS1ob2xkIHN1cHByZXNzZXMgYXV0by1yZXNwYXduIGZvciA8cz4gc2Vjb25kcyAodXBncmFkZSB3aW5kb3cpXG4gIGdyYXBldmluZSBpbmZvXG4gIGdyYXBldmluZSBkb2N0b3IgICAgICAgICAgICAgICAgICAjIGhlYWx0aCBjaGVjayDigJQgbGFiZWxzIGVhY2ggZGFlbW9uOiBhdXRob3JpdGF0aXZlIC8gb3JwaGFuIC8gdW5yZXNwb25zaXZlIC8gdW5rbm93blxuICBncmFwZXZpbmUgcmVhcCBbLS1mb3JjZV0gWy0tZHJ5LXJ1bl0gICMga2lsbCBvcnBoYW4gZGFlbW9uczsgLS1mb3JjZSBhbHNvIGtpbGxzIHVucmVzcG9uc2l2ZTsgYWxpYXM6IHBydW5lXG5cbiAgZ3JhcGV2aW5lIHNjaGVtYSAgICAgICAgICAgICAgICAgICMgdGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSBkZXNjcmlwdGlvbiAoYWNjIGRlY2xhcmF0aW9uIHYwKVxuICBncmFwZXZpbmUgLS12ZXJzaW9uICAgICAgICAgICAgICAgIyB0aGlzIENMSSdzIHZlcnNpb24gKGFsaWFzOiAtViwgdmVyc2lvbilcbiAgZ3JhcGV2aW5lIGhlbHAgICAgICAgICAgICAgICAgICAgICMgdGhpcyB1c2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXG5cbk91dHB1dDpcbiAgRGF0YSBjb21tYW5kcyBlbWl0IEpTT04gb24gc3Rkb3V0IGJ5IERFRkFVTFQ7IHBhc3MgLS1odW1hbiBmb3IgcHJvc2Ugd2hlcmUgYVxuICBjb21tYW5kIG9mZmVycyBpdC4gRGlhZ25vc3RpY3MgYW5kIHdhcm5pbmdzIGdvIHRvIHN0ZGVyciwgbmV2ZXIgc3Rkb3V0LlxuICBVc2FnZSBlcnJvcnMgZXhpdCAyLiBFYWNoIGNvbW1hbmQgYWNjZXB0cyBpdHMgT1dOIGZsYWdzIChwbHVzIC0tYXMvLS1mcm9tLFxuICB3aGljaCBhcmUgZ2xvYmFsKSDigJQgYW4gdW5rbm93biBmbGFnIGZvciBhIHZlcmIgZW51bWVyYXRlcyB0aGF0IHZlcmIncyBzZXQuXG5cbkVudjpcbiAgR1JBUEVWSU5FX0ZST00gICBEZWZhdWx0IGlkZW50aXR5IGFsaWFzICgtLWZyb20vLS1hcyBhcmUgaW50ZXJjaGFuZ2VhYmxlKS5cbiAgR1JBUEVWSU5FX0hPTUUgICBEYXRhIGRpciAoZGVmYXVsdCB+Ly5ncmFwZXZpbmUpLlxuYDtcbn1cblxuLyoqXG4gKiBUaGUgb25lIHBsYWNlIHRoaXMgQ0xJIGNhbiBlbmQsIGFuZCB0aGUgb25lIHBsYWNlIGEgYENsaUVycm9yYCBiZWNvbWVzIGFuXG4gKiBleGl0IGNvZGUuXG4gKlxuICog4puUIEFEREVEIEFUIFBIQVNFIDYgQ0hBUFRFUiAyLCBBTkQgSVQgSVMgV0hBVCBNQUtFUyBgZGllYCBTQUZFIFRPIFRIUk9XLlxuICogYHJlcG9ydENsaUVycm9yYCB3cml0ZXMgdGhlIGVudmVsb3BlIGFuZCBoYW5kcyBiYWNrIHRoZSB0YXhvbm9teSBjb2RlOyBhXG4gKiB0aHJvdyBpdCBkb2VzIE5PVCByZWNvZ25pc2UgaXMgcmUtdGhyb3duLCBiZWNhdXNlIHN3YWxsb3dpbmcgYW4gdW5rbm93biBvbmVcbiAqIGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeSB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZVxuICogc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKlxuICog4pqgIGBkaXNwYXRjaGAsIE5PVCBUSEUgUkVHSVNUUlknUyBgbWFpbmAsIEZPUiBFWEFDVExZIFRIQVQgUkUtVEhST1c6IHRoZVxuICogcmVnaXN0cnkncyBgbWFpbmAgdHVybnMgYW4gdW5rbm93biB0aHJvdyBpbnRvIGFuIGludGVybmFsIGVudmVsb3BlLlxuICogYG1ldGEuY29tbWFuZGAg4oCUIHdoaWNoIHZlcmIgcHJvZHVjZWQgYW4gZW52ZWxvcGUg4oCUIGlzIHNldCBieSB0aGUgcmVnaXN0cnkgZnJvbVxuICogdGhlIHJhdyBmaXJzdCB0b2tlbiwgc28gYW4gdW5rbm93biB2ZXJiIHN0aWxsIG5hbWVzIGl0c2VsZiBpbiBpdHMgcmVqZWN0aW9uLlxuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgY2xpLmRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChjb2RlICE9PSBudWxsKSByZXR1cm4gY29kZTtcbiAgICB0aHJvdyBlO1xuICB9XG59XG5cbi8vIOKblCBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBJVFMgQUJTRU5DRSBJUyBUSEUgU1RFUCAocGxheWJvb2sgQjMpLlxuLy8gYGRpc3QvY2xpLmpzYCBpcyBJTVBPUlRFRCBieSBgc2NyaXB0cy9jbGkudHNgLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuLy8gZW50cnksIHNvIHRoZSBndWFyZCB3b3VsZCBuZXZlciBydW4gYW5kIGV2ZXJ5IHZlcmIgd291bGQgcHJpbnQgbm90aGluZyBhbmRcbi8vIGV4aXQgMC4gTm9yIG1heSB0aGlzIGZpbGUgb2ZmZXIgYSBzZWNvbmQgZW50cnkgZnJvbSBpdHMgYXV0aG9yaW5nIGFkZHJlc3M6XG4vLyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAsIGBTVVJGQUNFX0NXRGAgYW5kIGBEQUVNT05fU0NSSVBUYCBhYm92ZSBhcmUgYWxsXG4vLyBjb21wdXRlZCBmcm9tIGBTQ1JJUFRfRElSYCBhbmQgYXJlIGNvcnJlY3Qgb25seSBmcm9tIGBkaXN0L2AuXG4vL1xuLy8gVGhlIGRyYWluIGNvbnRyYWN0IGxpdmVzIGF0IHRoZSBsYXVuY2hlciBub3cg4oCUIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbFxuLy8gcmV0dXJuLCBuZXZlciBhbiBleHBsaWNpdCBleGl0LCBiZWNhdXNlIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYVxuLy8gcGlwZSBhbmQgYHRhaWxgIHdyaXRlcyBKU09OTCBhIGNhbGxlciBwYXJzZXMuIFNlZVxuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9ncmFwZXZpbmUvc2NyaXB0cy9jbGkudHNgIGZvciB0aGUgZnVsbCBhY2NvdW50LlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9fYXJjaGl2ZS9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBQZXItdmVyYiBoZWxwIChwb3J0ZWQgZnJvbSBTdG9yeSBTdHVkaW8ncyBraXQpOiBgaGVscCA8dmVyYj5gIGFuZFxuICogYDx2ZXJiPiAtLWhlbHBgIChvciBgLWhgLCB3aGVuIG5vIGZsYWcgY2xhaW1zIHRoYXQgc2hvcnQpIHByaW50IG9uZSByb3cnc1xuICogdXNhZ2UsIGl0cyBsaW5lLCBlYWNoIG93biBmbGFnIHdpdGggaXRzIGBmbGFnSGVscGAgbGluZSwgdGhlIGdsb2JhbCBmbGFncyBpblxuICogdGhlaXIgb3duIGJsb2NrLCBhbmQgaXRzIGBleGFtcGxlc2AuIEV2ZXJ5IHJvdyBhbnN3ZXJzIGAtLWhlbHBgLCB0aGUgYXV0b1xuICogcm93cyBhbmQgYSB2ZXJibGVzcyByb290IGluY2x1ZGVkLiBUaGUgY2hlY2sgcnVucyBiZWZvcmUgY29udHJhY3QgNSwgb24gdGhlXG4gKiB3aG9sZSBhcmd2LCBhbmQgY291bnRzIGAtLWhlbHBgIG9ubHkgd2hlbiBhIHN0cmljdCBwYXJzZSAodGhlIHRhYmxlIHBsdXMgYVxuICogYGhlbHBgIGJvb2xlYW4pIHJlYWRzIGl0IGFzIHRoZSBmbGFnIChgYXNrc0ZvckhlbHBgKSwgc28gYSB2YWx1ZS1zbG90XG4gKiBgLS1oZWxwYCBzdGF5cyB0aGUgcGFyc2VyJ3MgcmVmdXNhbC4gQSByb3cnc1xuICogYHJlcXVpcmVkRmxhZ3NgIGRyb3AgdGhlaXIgYnJhY2tldHMgaW4gaXRzIHVzYWdlIGFuZCBhcmUgcmVmdXNlZCBhcyBtaXNzaW5nXG4gKiBhZnRlciB0aGUgYXJpdHkgY2hlY2suXG4gKlxuICogVGhlIG1vZHVsZSBhZGRzIGBoZWxwYCwgYHZlcnNpb25gIGFuZCBgc2NoZW1hYCByb3dzIHVubGVzcyB0aGUgc3BlbGwgZGVmaW5lc1xuICogYSByb3cgb2YgdGhhdCBuYW1lIChncmFwZXZpbmUncyBgdmVyc2lvbiAtLWh1bWFuYCkuIFRoZXkgYXJlIG9yZGluYXJ5IHJvd3M6XG4gKiBkZWNsYXJlZCwgc3RyaWN0LCBhbmQgZ2l2ZW4gYGdsb2JhbEZsYWdzYCBsaWtlIGV2ZXJ5IG90aGVyIHJvdy5cbiAqL1xuXG5pbXBvcnQgeyBwYXJzZUFyZ3MgfSBmcm9tIFwibm9kZTp1dGlsXCI7XG5pbXBvcnQgeyBwcmludEpzb24gfSBmcm9tIFwiLi4vbGliL3ByaW50SnNvblwiO1xuaW1wb3J0IHsgQ2xpRXJyb3IsIGRpZSwgcmVwb3J0Q2xpRXJyb3IsIHNldEN1cnJlbnRDb21tYW5kIH0gZnJvbSBcIi4uL3dpcmUvZXJyb3JzXCI7XG5cbi8vIOKUgOKUgCB0eXBlcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IHR5cGUgRmxhZ1R5cGUgPSBcInN0cmluZ1wiIHwgXCJib29sZWFuXCI7XG5cbi8qKiBPbmUgYHBhcnNlQXJnc2Agb3B0aW9uLCBwbHVzIHRoZSBgZGVmYXVsdGAgbm9kZSdzIHBhcnNlciBhbHNvIHRha2VzLiAqL1xuZXhwb3J0IHR5cGUgT3B0aW9uU3BlYyA9IHtcbiAgdHlwZTogRmxhZ1R5cGU7XG4gIG11bHRpcGxlPzogYm9vbGVhbjtcbiAgc2hvcnQ/OiBzdHJpbmc7XG4gIGRlZmF1bHQ/OiBzdHJpbmcgfCBib29sZWFuIHwgcmVhZG9ubHkgc3RyaW5nW10gfCByZWFkb25seSBib29sZWFuW107XG59O1xuXG5leHBvcnQgdHlwZSBPcHRpb25zVGFibGUgPSBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBPcHRpb25TcGVjPj47XG5cbmV4cG9ydCB0eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcblxuZXhwb3J0IHR5cGUgRmxhZ1ZhbHVlID0gc3RyaW5nIHwgYm9vbGVhbiB8IChzdHJpbmcgfCBib29sZWFuKVtdO1xuXG5leHBvcnQgdHlwZSBJbnZvY2F0aW9uPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogVGhlIHJlc29sdmVkIHJvdyBuYW1lOiBgXCJvcGVuXCJgLCBgXCJub2RlIGVkaXRcImAsIG9yIGBcIlwiYCBmb3IgYSB2ZXJibGVzcyByb290LiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3BlbGxpbmcgdGhlIGNhbGxlciB1c2VkIOKAlCBhbiBhbGlhcywgd2hlbiBvbmUgd2FzIHVzZWQuICovXG4gIHRva2VuOiBzdHJpbmc7XG4gIC8qKiBQb3NpdGlvbmFscyBhZnRlciB0aGUgcGF0aC4gKi9cbiAgcG9zOiBzdHJpbmdbXTtcbiAgLyoqIEZsYWdzIGdpdmVuLCBwbHVzIHRoZSBkZWZhdWx0cyBvZiB0aGUgZmxhZ3MgdGhpcyByb3cgYWNjZXB0cy4gKi9cbiAgZmxhZ3M6IFBhcnRpYWw8UmVjb3JkPEYsIEZsYWdWYWx1ZT4+O1xufTtcblxuZXhwb3J0IHR5cGUgQ29tbWFuZFNwZWM8RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSB7XG4gIC8qKiBgXCJvcGVuXCJgOyBvbmUgc3BhY2UgbWVhbnMgb25lIGxldmVsIG9mIG5lc3Rpbmc6IGBcIm5vZGUgZWRpdFwiYC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogRWFjaCBhbGlhcyBpcyBkaXNwYXRjaGFibGUsIGxpc3RlZCBpbiBgdmVyYnNgLCBhbmQgZ2V0cyBpdHMgb3duIGRlY2xhcmVkXG4gICAqICByb3cuIEFuIGFsaWFzIG9mIGEgbmVzdGVkIHJvdyBtdXN0IHNoYXJlIGl0cyBncm91cDogYFwibm9kZSBjaGFuZ2VcImAuICovXG4gIGFsaWFzZXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFRoaXMgcm93J3Mgb3duIGZsYWdzOyBgZ2xvYmFsRmxhZ3NgIGFyZSBhZGRlZCB0byB0aGVtLiAqL1xuICBmbGFnczogcmVhZG9ubHkgRltdO1xuICAvKiogQXJpdHkgaXMgZW5mb3JjZWQgZnJvbSB0aGlzLCBhbmQgaXQgaXMgd2hhdCBgc2NoZW1hYCBwdWJsaXNoZXMuICovXG4gIHBvc2l0aW9uYWxzOiByZWFkb25seSBQb3NpdGlvbmFsU3BlY1tdO1xuICAvKiogT25lIGxpbmUgZm9yIHRoZSByZW5kZXJlZCBoZWxwLiAqL1xuICBkZXNjcmliZTogc3RyaW5nO1xuICAvKiogQWRkZWQgYXMgdGhlIGBoaW50YCBvZiB0aGlzIHJvdydzIGZsYWcgcmVqZWN0aW9ucy4gKi9cbiAgcmVqZWN0SGludD86IHN0cmluZztcbiAgLyoqIGBmYWxzZWAgaGFuZHMgbm9kZSdzIG93biBcIlVuZXhwZWN0ZWQgYXJndW1lbnRcIiByZWZ1c2FsIGFueSBwb3NpdGlvbmFsLiAqL1xuICBhbGxvd1Bvc2l0aW9uYWxzPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIFdoYXQgZWFjaCBvZiB0aGlzIHJvdydzIGZsYWdzIGRvZXMsIG9uZSBsaW5lIGVhY2gsIGZvciBgaGVscCA8dmVyYj5gLiBBXG4gICAqIGZsYWcgd2l0aCBubyBsaW5lIGlzIGxpc3RlZCBieSBuYW1lIG9ubHkuXG4gICAqL1xuICBmbGFnSGVscD86IFJlYWRvbmx5PFBhcnRpYWw8UmVjb3JkPEYsIHN0cmluZz4+PjtcbiAgLyoqIFdob2xlIGNvbW1hbmQgbGluZXMgdGhhdCBzaG93IHRoZSByb3cgaW4gdXNlLCBmb3IgYGhlbHAgPHZlcmI+YC4gKi9cbiAgZXhhbXBsZXM/OiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIEZsYWdzIG9mIHRoaXMgcm93IHRoYXQgbXVzdCBiZSBnaXZlbjogc2hvd24gd2l0aG91dCBicmFja2V0cyBpbiBpdHNcbiAgICogdXNhZ2UsIGFuZCByZWZ1c2VkIGFzIG1pc3NpbmcsIGxpa2UgYSByZXF1aXJlZCBwb3NpdGlvbmFsLlxuICAgKi9cbiAgcmVxdWlyZWRGbGFncz86IHJlYWRvbmx5IEZbXTtcbiAgLyoqXG4gICAqIEZsYWctZGVwZW5kZW50IGFyaXR5IChpbWFnbyBgaGFuZG9mZiAtLWNsZWFyYCwgbWluZC1tYXBwZXIgYC0tdG98LS1jbGVhcmApXG4gICAqIGFuZCBhbnkgb3RoZXIgY29tYmluYXRpb24gcnVsZS4gUnVucyBhZnRlciB0aGUgYXJpdHkgY2hlY2s7IGEgcmV0dXJuZWRcbiAgICogc3RyaW5nIGlzIHJlZnVzZWQgYXMgYSB1c2FnZSBlcnJvciBuYW1pbmcgdGhpcyByb3cuIOKaoCBUaGUgZGVjbGFyYXRpb25cbiAgICogY2Fubm90IGV4cHJlc3Mgc3VjaCBhIHJ1bGU6IGEgcG9zaXRpb25hbCB0aGF0IGAtLWNsZWFyYCBtYWtlcyB1bm5lY2Vzc2FyeVxuICAgKiBjYW4gb25seSBiZSBkZWNsYXJlZCBgcmVxdWlyZWQ6IGZhbHNlYCwgYW5kIHRoaXMgaG9vayBlbmZvcmNlcyB0aGUgcmVzdC5cbiAgICovXG4gIGNoZWNrPzogKGludjogSW52b2NhdGlvbjxGPikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSBudW1iZXIgaXMgdGhlIGV4aXQgY29kZTsgYW55dGhpbmcgZWxzZSBtZWFucyAwLiAqL1xuICBydW46IChpbnY6IEludm9jYXRpb248Rj4pID0+IHVua25vd247XG59O1xuXG4vKiogQSB2ZXJibGVzcyBDTEkncyBvbmUgcm93IChkaWdlc3RpZnkpLiBgcGF0aDogW11gIGluIHRoZSBkZWNsYXJhdGlvbi4gKi9cbmV4cG9ydCB0eXBlIFJvb3RTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0gT21pdDxDb21tYW5kU3BlYzxGPiwgXCJuYW1lXCIgfCBcImFsaWFzZXNcIj47XG5cbi8qKlxuICogV2hlcmUgYSBncm91cCdzIHN1Yi12ZXJiIGlzIGZvdW5kLlxuICogLSBgYWRqYWNlbnRgIChkZWZhdWx0KTogdGhlIHRva2VuIHJpZ2h0IGFmdGVyIHRoZSBncm91cCAoYG5vZGUgZWRpdCBYYCkuXG4gKiAtIGBmaXJzdC1wb3NpdGlvbmFsYDogdGhlIGZpcnN0IHRva2VuIGFmdGVyIHRoZSBncm91cCB0aGF0IGlzIG5laXRoZXIgYSBmbGFnXG4gKiAgIG5vciBhIHN0cmluZyBmbGFnJ3MgdmFsdWUsIHNvIGZsYWdzIG1heSBjb21lIGZpcnN0OlxuICogICBgZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSBEMSAtLWZvcmNlYCByZXNvbHZlcyB0byBgZG9jIGRlbGV0ZWAgKG1pbmQtbWFwcGVyKS5cbiAqICAgVGhlIHNjYW4gc3RvcHMgYXQgYSBiYXJlIGAtLWAsIHdoaWNoIGlzIHRoZSBlc2NhcGUgaGF0Y2ggZm9yIGEgcG9zaXRpb25hbFxuICogICBsaXRlcmFsbHkgbmFtZWQgbGlrZSBhIHN1Yi12ZXJiOiBgZG9jIC0tIGRlbGV0ZWAgcmVhZHMgdGhlIGRvYyBcImRlbGV0ZVwiLlxuICovXG5leHBvcnQgdHlwZSBHcm91cFNwZWMgPSB7IHN1YlZlcmJBdD86IFwiYWRqYWNlbnRcIiB8IFwiZmlyc3QtcG9zaXRpb25hbFwiIH07XG5cbmV4cG9ydCB0eXBlIENsaVNwZWM8TyBleHRlbmRzIE9wdGlvbnNUYWJsZT4gPSB7XG4gIC8qKiBgXCJib3VudHlcImAsIHVzZWQgaW4gbWVzc2FnZXMgYW5kIHRoZSByZW5kZXJlZCBoZWxwLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBUaGUgcmVuZGVyZWQgaGVscCdzIGZpcnN0IGxpbmU6IGAke25hbWV9IOKAlCAke3N1bW1hcnl9YC4gKi9cbiAgc3VtbWFyeT86IHN0cmluZztcbiAgLyoqIFRoZSBsaXRlcmFsIGBDTElfT1BUSU9OU2Agb2JqZWN0LiAqL1xuICBvcHRpb25zOiBPO1xuICBjb21tYW5kcz86IHJlYWRvbmx5IENvbW1hbmRTcGVjPGtleW9mIE8gJiBzdHJpbmc+W107XG4gIC8qKlxuICAgKiBBIHZlcmJsZXNzIENMSSdzIHJvdy4gUmVzZXJ2ZWQgdG9rZW5zIGFzIGBhcmd2WzBdYCBzdGlsbCBzZWxlY3QgdGhlaXIgcm93c1xuICAgKiAoYGhlbHBgLCBgdmVyc2lvbmAsIGBzY2hlbWFgLCBhbnkgYGNvbW1hbmRzYCwgYW5kIHRoZSBpbnRlcmNlcHRvcnMpOyBldmVyeVxuICAgKiBvdGhlciBhcmd2LCB0aGUgZW1wdHkgb25lIGluY2x1ZGVkLCBiZWxvbmdzIHRvIHRoZSByb290LiBBIHBvc2l0aW9uYWwgdGhhdFxuICAgKiBoYXBwZW5zIHRvIHNwZWxsIGEgcmVzZXJ2ZWQgdG9rZW4gZ29lcyBhZnRlciBhIGJhcmUgYC0tYC5cbiAgICovXG4gIHJvb3Q/OiBSb290U3BlYzxrZXlvZiBPICYgc3RyaW5nPjtcbiAgLyoqIEFjY2VwdGVkIGJ5IGV2ZXJ5IHJvdywgYnkgY29udHJhY3QgKGdyYXBldmluZSdzIGAtLWFzYC9gLS1mcm9tYCkuICovXG4gIGdsb2JhbEZsYWdzPzogcmVhZG9ubHkgKGtleW9mIE8gJiBzdHJpbmcpW107XG4gIGdyYW1tYXI/OiBcInZlcmItZmlyc3RcIiB8IFwiZmxhZ3MtYW55d2hlcmVcIjtcbiAgLyoqIFBlci1ncm91cCBzdWItdmVyYiBwbGFjZW1lbnQsIGtleWVkIGJ5IHRoZSBncm91cCB0b2tlbiAoYFwiZG9jXCJgKS4gKi9cbiAgZ3JvdXBzPzogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgR3JvdXBTcGVjPj47XG4gIC8qKiBUaGUgcm9vdCByb3cncyBwb3NpdGlvbmFsIG5hbWUgaW4gYHNjaGVtYWAgKGBcImNvbW1hbmRcImA7IGdsYW1vdXI6IGBcInZlcmJcImApLiAqL1xuICB2ZXJiUG9zaXRpb25hbD86IHN0cmluZztcbiAgLyoqIEZsYWdzIGxlZnQgb2ZmIGV2ZXJ5IHVzYWdlIGxpbmUgKGdsYW1vdXIncyBwZXItdmVyYiBgc2Vzc2lvbmApLiAqL1xuICB1c2FnZUhpZGVzPzogcmVhZG9ubHkgKGtleW9mIE8gJiBzdHJpbmcpW107XG4gIC8qKiBUaGUgYHZlcnNpb25gIHJvdydzIHBheWxvYWQsIGB7bmFtZSwgdmVyc2lvbn1gLiAqL1xuICB2ZXJzaW9uOiAoKSA9PiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICAvKiogUmVwbGFjZXMgdGhlIHJlbmRlcmVkIGhlbHAgKGdyYXBldmluZSkuICovXG4gIGhlbHA/OiAoKSA9PiBzdHJpbmc7XG4gIC8qKiBBcHBlbmRlZCBiZWxvdyB0aGUgcmVuZGVyZWQgcm93cy4gKi9cbiAgaGVscEZvb3Rlcj86IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIERlY2xhcmVkQXJnID0geyBuYW1lOiBzdHJpbmc7IHR5cGU6IEZsYWdUeXBlOyBzdGF0dXM6IFwidmFsaWRcIiB9O1xuZXhwb3J0IHR5cGUgRGVjbGFyZWRDb21tYW5kID0ge1xuICBwYXRoOiBzdHJpbmdbXTtcbiAgYXJnczogRGVjbGFyZWRBcmdbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG59O1xuZXhwb3J0IHR5cGUgRGVjbGFyYXRpb24gPSB7XG4gIGZvcm1hdFZlcnNpb246IFwiMFwiO1xuICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIjtcbiAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IHN0cmluZ1tdIH07XG4gIGNvbW1hbmRzOiBEZWNsYXJlZENvbW1hbmRbXTtcbn07XG5cbi8qKiBBIHJvdyBhcyB0aGUgbW9kdWxlIGhvbGRzIGl0LCBmb3IgdGVzdHMgYW5kIHdhcmRzLiAqL1xuZXhwb3J0IHR5cGUgUm93VmlldyA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICBhbGlhc2VzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIFRoZSByb3cncyBvd24gZmxhZ3MsIGFzIGRlY2xhcmVkLiAqL1xuICBmbGFnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBPd24gZmxhZ3MgcGx1cyBgZ2xvYmFsRmxhZ3NgLCBpbiBvcHRpb25zLXRhYmxlIG9yZGVyLiAqL1xuICBhY2NlcHRlZDogcmVhZG9ubHkgc3RyaW5nW107XG4gIHBvc2l0aW9uYWxzOiByZWFkb25seSBQb3NpdGlvbmFsU3BlY1tdO1xuICBkZXNjcmliZTogc3RyaW5nO1xuICAvKiogYHRydWVgIGZvciBhIGBoZWxwYC9gdmVyc2lvbmAvYHNjaGVtYWAgcm93IHRoZSBtb2R1bGUgYWRkZWQuICovXG4gIGF1dG86IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBDbGkgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVudmVsb3BlIG9uIGZhaWx1cmUsIHJldHVybnMgdGhlIGV4aXQgY29kZS4gRm9yIHRoZSBzcGVsbCdzIGBydW4oKWAuICovXG4gIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIC8qKiBUaHJvd3MgYENsaUVycm9yYCwgZm9yIGEgc3BlbGwgd2hvc2UgbWFpbiBkb2VzIGl0cyBvd24gdHJpYWdlLiAqL1xuICBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPjtcbiAgZGVjbGFyYXRpb24oKTogRGVjbGFyYXRpb247XG4gIHJlbmRlckhlbHAoKTogc3RyaW5nO1xuICAvKiogT25lIHZlcmIncyBoZWxwIChgaGVscCA8dmVyYj5gKTsgYSB1c2FnZSBlcnJvciBmb3IgYSB2ZXJiIHRoYXQgaXMgbm90IHRoZXJlLiAqL1xuICByZW5kZXJWZXJiSGVscChwYXRoOiBzdHJpbmcpOiBzdHJpbmc7XG4gIC8qKiBBIHJvdydzIHVzYWdlIGxpbmUgKGBcImNsb3NlIDxpZD4gWy0tZm9yY2VdXCJgKTsgYFwiXCJgIGZvciBhbiB1bmtub3duIHBhdGguICovXG4gIHVzYWdlT2YocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogRXZlcnkgZmlyc3QgdG9rZW4gdGhhdCBkaXNwYXRjaGVzOiB2ZXJicywgYWxpYXNlcyBhbmQgZ3JvdXAgdG9rZW5zLiAqL1xuICB2ZXJiczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmdWxsIHBhdGggdGhhdCBkaXNwYXRjaGVzLCBhbGlhc2VzIGluY2x1ZGVkIChgXCJub2RlIGVkaXRcImApLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIHJvdydzIGFjY2VwdGVkIHNldCBhcyBgLS14YCBzcGVsbGluZ3MsIHNvcnRlZC4gYFwiXCJgIGlzIHRoZSByb290LiAqL1xuICBmbGFnc0ZvcihwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZsYWcgaW4gdGhlIG9wdGlvbnMgdGFibGUsIGFzIGAtLXhgLCBpbiB0YWJsZSBvcmRlci4gKi9cbiAgcmVjb2duaXplZEZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcm93czogcmVhZG9ubHkgUm93Vmlld1tdO1xufTtcblxuLy8g4pSA4pSAIGludGVybmFscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxudHlwZSBSb3cgPSBSb3dWaWV3ICYge1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICBhbGxvd1Bvc2l0aW9uYWxzOiBib29sZWFuO1xuICBmbGFnSGVscDogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPj47XG4gIGV4YW1wbGVzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcmVxdWlyZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz47XG4gIGNoZWNrPzogKGludjogSW52b2NhdGlvbikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBydW46IChpbnY6IEludm9jYXRpb24pID0+IHVua25vd247XG59O1xuXG4vKiogVGhlIHRva2VucyB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi4gRGVjbGFyZWQgYXQgYHBhdGg6IFtdYC4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbi8qKiBMb25nIGZpcnN0OiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHQgc3RvcHMgYXQgdGhlIGZpcnN0XG4gKiAgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLiAqL1xuY29uc3QgSU5URVJDRVBUT1JfQ0hPSUNFUyA9IElOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuc29ydChcbiAgKGEsIGIpID0+IE51bWJlcihiLnN0YXJ0c1dpdGgoXCItLVwiKSkgLSBOdW1iZXIoYS5zdGFydHNXaXRoKFwiLS1cIikpLFxuKTtcblxuY29uc3QgZXJyQ29kZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+XG4gIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuY29uc3QgZXJyTWVzc2FnZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+IChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmaW5lQ2xpPGNvbnN0IE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+KHNwZWM6IENsaVNwZWM8Tz4pOiBDbGkge1xuICBjb25zdCBjbGlOYW1lID0gc3BlYy5uYW1lO1xuICBjb25zdCBvcHRpb25LZXlzID0gT2JqZWN0LmtleXMoc3BlYy5vcHRpb25zKTtcbiAgY29uc3Qga25vd24gPSBuZXcgU2V0KG9wdGlvbktleXMpO1xuICBjb25zdCBncmFtbWFyID0gc3BlYy5ncmFtbWFyID8/IFwidmVyYi1maXJzdFwiO1xuICBjb25zdCBnbG9iYWxzID0gWy4uLihzcGVjLmdsb2JhbEZsYWdzID8/IFtdKV0gYXMgc3RyaW5nW107XG4gIGNvbnN0IGhpZGVzID0gbmV3IFNldDxzdHJpbmc+KChzcGVjLnVzYWdlSGlkZXMgPz8gW10pIGFzIHN0cmluZ1tdKTtcblxuICBmb3IgKGNvbnN0IGcgb2YgZ2xvYmFscykge1xuICAgIGlmICgha25vd24uaGFzKGcpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdsb2JhbCBmbGFnIFwiJHtnfVwiIGlzIG5vdCBpbiBvcHRpb25zYCk7XG4gIH1cbiAgaWYgKChzcGVjLmNvbW1hbmRzPy5sZW5ndGggPz8gMCkgPT09IDAgJiYgc3BlYy5yb290ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ2l2ZSBjb21tYW5kcywgYSByb290LCBvciBib3RoYCk7XG4gIH1cblxuICAvLyBgcGFyc2VBcmdzYCBnZXRzIHRoZSB0YWJsZSBXSVRIT1VUIGRlZmF1bHRzOiB3aGljaCBmbGFncyB0aGUgY2FsbGVyIGdhdmUgaXNcbiAgLy8gdGhlIHF1ZXN0aW9uIHRoZSBwZXItcm93IGNoZWNrIGFza3MsIGFuZCBhIGRlZmF1bHQgaXMgbm90IHNvbWV0aGluZyBnaXZlbi5cbiAgY29uc3QgcGFyc2VPcHRpb25zID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIG9wdGlvbktleXMubWFwKChrKSA9PiB7XG4gICAgICBjb25zdCB7IGRlZmF1bHQ6IF9kLCAuLi5yZXN0IH0gPSBzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYztcbiAgICAgIHJldHVybiBbaywgcmVzdF07XG4gICAgfSksXG4gICkgYXMgUmVjb3JkPHN0cmluZywgeyB0eXBlOiBGbGFnVHlwZTsgbXVsdGlwbGU/OiBib29sZWFuOyBzaG9ydD86IHN0cmluZyB9PjtcbiAgY29uc3Qgc2hvcnRUb0tleSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgayBvZiBvcHRpb25LZXlzKSB7XG4gICAgY29uc3QgcyA9IHNwZWMub3B0aW9uc1trXT8uc2hvcnQ7XG4gICAgaWYgKHMgIT09IHVuZGVmaW5lZCkgc2hvcnRUb0tleS5zZXQocywgayk7XG4gIH1cblxuICBjb25zdCBhY2NlcHRlZE9mID0gKG93bjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSA9PiB7XG4gICAgY29uc3Qgc2V0ID0gbmV3IFNldChbLi4uZ2xvYmFscywgLi4ub3duXSk7XG4gICAgcmV0dXJuIG9wdGlvbktleXMuZmlsdGVyKChrKSA9PiBzZXQuaGFzKGspKTtcbiAgfTtcblxuICBjb25zdCB0b1JvdyA9IChcbiAgICBjOiBPbWl0PENvbW1hbmRTcGVjLCBcInJ1blwiPiAmIHsgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duIH0sXG4gICAgYXV0bzogYm9vbGVhbixcbiAgKTogUm93ID0+IHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5mbGFncykge1xuICAgICAgaWYgKCFrbm93bi5oYXMoZikpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IHJvdyBcIiR7Yy5uYW1lfVwiIG5hbWVzIGZsYWcgXCIke2Z9XCIsIG5vdCBpbiBvcHRpb25zYCk7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAoY29uc3QgZiBvZiBjLnJlcXVpcmVkRmxhZ3MgPz8gW10pIHtcbiAgICAgIGlmICghYy5mbGFncy5pbmNsdWRlcyhmKSlcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IHJvdyBcIiR7Yy5uYW1lfVwiIHJlcXVpcmVzIGZsYWcgXCIke2Z9XCIsIG5vdCBvbmUgb2YgaXRzIG93bmAsXG4gICAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICBhbGlhc2VzOiBbLi4uKGMuYWxpYXNlcyA/PyBbXSldLFxuICAgICAgZmxhZ3M6IFsuLi5jLmZsYWdzXSxcbiAgICAgIGFjY2VwdGVkOiBhY2NlcHRlZE9mKGMuZmxhZ3MpLFxuICAgICAgcG9zaXRpb25hbHM6IGMucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgIGRlc2NyaWJlOiBjLmRlc2NyaWJlLFxuICAgICAgYXV0byxcbiAgICAgIHJlamVjdEhpbnQ6IGMucmVqZWN0SGludCxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IGMuYWxsb3dQb3NpdGlvbmFscyA/PyB0cnVlLFxuICAgICAgZmxhZ0hlbHA6IHsgLi4uKGMuZmxhZ0hlbHAgPz8ge30pIH0gYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgdW5kZWZpbmVkPixcbiAgICAgIGV4YW1wbGVzOiBbLi4uKGMuZXhhbXBsZXMgPz8gW10pXSxcbiAgICAgIHJlcXVpcmVkOiBuZXcgU2V0KGMucmVxdWlyZWRGbGFncyA/PyBbXSksXG4gICAgICBjaGVjazogYy5jaGVjayBhcyBSb3dbXCJjaGVja1wiXSxcbiAgICAgIHJ1bjogYy5ydW4gYXMgUm93W1wicnVuXCJdLFxuICAgIH07XG4gIH07XG5cbiAgY29uc3Qgcm93czogUm93W10gPSAoc3BlYy5jb21tYW5kcyA/PyBbXSkubWFwKChjKSA9PiB0b1JvdyhjIGFzIENvbW1hbmRTcGVjLCBmYWxzZSkpO1xuXG4gIC8vIFRoZSBhdXRvIHJvd3MuIEFkZGVkIGxhc3QsIGluIHRoaXMgb3JkZXIsIHVubGVzcyB0aGUgc3BlbGwgaGFzIGl0cyBvd24uXG4gIGNvbnN0IGNsaSA9IHt9IGFzIENsaTtcbiAgY29uc3QgYXV0b1Jvd3M6IENvbW1hbmRTcGVjW10gPSBbXG4gICAge1xuICAgICAgbmFtZTogXCJ2ZXJzaW9uXCIsXG4gICAgICBmbGFnczogW10sXG4gICAgICBwb3NpdGlvbmFsczogW10sXG4gICAgICBkZXNjcmliZTogXCJ0aGlzIENMSSdzIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OIChhbGlhczogLS12ZXJzaW9uLCAtVilcIixcbiAgICAgIHJ1bjogYXN5bmMgKCkgPT4ge1xuICAgICAgICBwcmludEpzb24oYXdhaXQgc3BlYy52ZXJzaW9uKCkpO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgICBmbGFnczogW10sXG4gICAgICBwb3NpdGlvbmFsczogW10sXG4gICAgICBkZXNjcmliZTogXCJ0aGlzIENMSSdzIG1hY2hpbmUtcmVhZGFibGUgaW50ZXJmYWNlIChhY2MgZGVjbGFyYXRpb24gdjApXCIsXG4gICAgICBydW46ICgpID0+IHtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoY2xpLmRlY2xhcmF0aW9uKCksIG51bGwsIDIpfVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIG5hbWU6IFwiaGVscFwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidmVyYlwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgICAgZGVzY3JpYmU6XG4gICAgICAgIFwic2hvdyB0aGlzIG1lc3NhZ2UgKGFsaWFzOiAtLWhlbHAsIC1oKTsgYGhlbHAgPHZlcmI+YCBzaG93cyBvbmUgdmVyYjogaXRzIHVzYWdlLCBlYWNoIGZsYWcsIGFuZCBleGFtcGxlc1wiLFxuICAgICAgcnVuOiAoaW52KSA9PiB7XG4gICAgICAgIGNvbnN0IHRleHQgPSBpbnYucG9zLmxlbmd0aCA+IDAgPyBjbGkucmVuZGVyVmVyYkhlbHAoaW52LnBvcy5qb2luKFwiIFwiKSkgOiBjbGkucmVuZGVySGVscCgpO1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZSh0ZXh0LmVuZHNXaXRoKFwiXFxuXCIpID8gdGV4dCA6IGAke3RleHR9XFxuYCk7XG4gICAgICB9LFxuICAgIH0sXG4gIF07XG4gIGZvciAoY29uc3QgYSBvZiBhdXRvUm93cykge1xuICAgIGlmICghcm93cy5zb21lKChyKSA9PiByLm5hbWUgPT09IGEubmFtZSkpIHJvd3MucHVzaCh0b1JvdyhhLCB0cnVlKSk7XG4gIH1cblxuICBjb25zdCByb290Um93OiBSb3cgfCB1bmRlZmluZWQgPVxuICAgIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogdG9Sb3coeyAuLi4oc3BlYy5yb290IGFzIFJvb3RTcGVjKSwgbmFtZTogXCJcIiB9LCBmYWxzZSk7XG5cbiAgLy8gSW5kZXggZXZlcnkgc3BlbGxpbmcsIGFuZCBjaGVjayB0aGUgdGFibGUgaXMgd2VsbCBmb3JtZWQuXG4gIGNvbnN0IGJ5VG9rZW4gPSBuZXcgTWFwPHN0cmluZywgUm93PigpO1xuICBmb3IgKGNvbnN0IHIgb2Ygcm93cykge1xuICAgIGZvciAoY29uc3QgdCBvZiBbci5uYW1lLCAuLi5yLmFsaWFzZXNdKSB7XG4gICAgICBjb25zdCBwYXJ0cyA9IHQuc3BsaXQoXCIgXCIpO1xuICAgICAgaWYgKHQudHJpbSgpICE9PSB0IHx8IHBhcnRzLmxlbmd0aCA+IDIgfHwgcGFydHMuc29tZSgocCkgPT4gcCA9PT0gXCJcIiB8fCBwLnN0YXJ0c1dpdGgoXCItXCIpKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYmFkIGNvbW1hbmQgbmFtZSBcIiR7dH1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHQgIT09IHIubmFtZSAmJiBwYXJ0cy5sZW5ndGggIT09IHIubmFtZS5zcGxpdChcIiBcIikubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBhbGlhcyBcIiR7dH1cIiBtdXN0IG5lc3QgbGlrZSBcIiR7ci5uYW1lfVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAocGFydHMubGVuZ3RoID09PSAyICYmIHQgIT09IHIubmFtZSAmJiBwYXJ0c1swXSAhPT0gci5uYW1lLnNwbGl0KFwiIFwiKVswXSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBzaGFyZSB0aGUgZ3JvdXAgb2YgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKGJ5VG9rZW4uaGFzKHQpKSB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogXCIke3R9XCIgaXMgZGVmaW5lZCB0d2ljZWApO1xuICAgICAgYnlUb2tlbi5zZXQodCwgcik7XG4gICAgfVxuICB9XG4gIGNvbnN0IHN1YnNPZiA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCB0IG9mIGJ5VG9rZW4ua2V5cygpKSB7XG4gICAgY29uc3QgW2dyb3VwLCBzdWJdID0gdC5zcGxpdChcIiBcIik7XG4gICAgaWYgKGdyb3VwICE9PSB1bmRlZmluZWQgJiYgc3ViICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHN1YnNPZi5zZXQoZ3JvdXAsIFsuLi4oc3Vic09mLmdldChncm91cCkgPz8gW10pLCBzdWJdKTtcbiAgICB9XG4gIH1cbiAgZm9yIChjb25zdCBnIG9mIE9iamVjdC5rZXlzKHNwZWMuZ3JvdXBzID8/IHt9KSkge1xuICAgIGlmICghc3Vic09mLmhhcyhnKSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdyb3VwIFwiJHtnfVwiIGhhcyBubyBzdWItdmVyYnNgKTtcbiAgfVxuXG4gIGNvbnN0IHBhdGhzID0gWy4uLmJ5VG9rZW4ua2V5cygpXTtcbiAgY29uc3QgdmVyYnMgPSBbLi4ubmV3IFNldChwYXRocy5tYXAoKHApID0+IHAuc3BsaXQoXCIgXCIpWzBdIGFzIHN0cmluZykpXTtcblxuICBjb25zdCByb3dGb3IgPSAocGF0aDogc3RyaW5nKTogUm93IHwgdW5kZWZpbmVkID0+IChwYXRoID09PSBcIlwiID8gcm9vdFJvdyA6IGJ5VG9rZW4uZ2V0KHBhdGgpKTtcbiAgY29uc3QgZmxhZ3NGb3IgPSAocGF0aDogc3RyaW5nKTogc3RyaW5nW10gPT5cbiAgICBbLi4uKHJvd0ZvcihwYXRoKT8uYWNjZXB0ZWQgPz8gW10pXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG4gIGNvbnN0IGxhYmVsID0gKHI6IFJvdyk6IHN0cmluZyA9PiByLm5hbWUgfHwgY2xpTmFtZTtcblxuICAvKipcbiAgICogQSB2ZXJibGVzcyByb290J3MgcmVqZWN0aW9uIGBjaG9pY2VzYDogaXRzIG93biBmbGFncyBQTFVTIHRoZSBpbnRlcmNlcHRvcnMsXG4gICAqIGJlY2F1c2UgdGhlIGRlY2xhcmF0aW9uIHB1Ymxpc2hlcyBib3RoIGF0IGBwYXRoOiBbXWAgYW5kIHRoZSByb290IGFuc3dlcnNcbiAgICogYm90aCAodGhlIGludGVyY2VwdG9ycyBhcyBgYXJndlswXWApLiBMZWF2aW5nIHRoZSBpbnRlcmNlcHRvcnMgb3V0IG1hZGVcbiAgICogb25lIHByb2Nlc3Mgc2F5IHR3byB0aGluZ3MgYWJvdXQgaXRzIHJvb3Qg4oCUIGFjYydzIGNlbnN1cyByZWFkIGAtLWhlbHBgLFxuICAgKiBgLWhgLCBgLS12ZXJzaW9uYCBhbmQgYC1WYCBhcyBkZWNsYXJlZC1ub3QtYWNjZXB0ZWQuIExvbmcgc3BlbGxpbmdzIGZpcnN0XG4gICAqIChzb3J0ZWQpLCB0aGVuIHRoZSBzaG9ydHM6IGEgZmxhZy1zZXQgZXh0cmFjdG9yIHJlYWRpbmcgbGVmdCB0byByaWdodFxuICAgKiBzdG9wcyBhdCB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLlxuICAgKi9cbiAgY29uc3Qgcm9vdENob2ljZXM6IHN0cmluZ1tdID0gKCgpID0+IHtcbiAgICBjb25zdCBhbGwgPSBbLi4uZmxhZ3NGb3IoXCJcIiksIC4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdO1xuICAgIGNvbnN0IGxvbmcgPSBhbGwuZmlsdGVyKChmKSA9PiBmLnN0YXJ0c1dpdGgoXCItLVwiKSkuc29ydCgpO1xuICAgIHJldHVybiBbLi4ubG9uZywgLi4uYWxsLmZpbHRlcigoZikgPT4gIWYuc3RhcnRzV2l0aChcIi0tXCIpKV07XG4gIH0pKCk7XG5cbiAgLy8g4pSA4pSAIGhlbHAg4pSA4pSAXG5cbiAgY29uc3QgcmVuZGVyUG9zaXRpb25hbCA9IChwOiBQb3NpdGlvbmFsU3BlYyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgaW5uZXIgPSBwLnZhcmlhZGljID8gYCR7cC5uYW1lfS4uLmAgOiBwLm5hbWU7XG4gICAgcmV0dXJuIHAucmVxdWlyZWQgPyBgPCR7aW5uZXJ9PmAgOiBgWyR7aW5uZXJ9XWA7XG4gIH07XG4gIGNvbnN0IHJlbmRlckZsYWcgPSAoazogc3RyaW5nLCByZXF1aXJlZCA9IGZhbHNlKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBmbGFnID0gc3BlYy5vcHRpb25zW2tdPy50eXBlID09PSBcImJvb2xlYW5cIiA/IGAtLSR7a31gIDogYC0tJHtrfSAuLmA7XG4gICAgcmV0dXJuIHJlcXVpcmVkID8gZmxhZyA6IGBbJHtmbGFnfV1gO1xuICB9O1xuICBjb25zdCB1c2FnZUxpbmUgPSAocjogUm93KTogc3RyaW5nID0+XG4gICAgW1xuICAgICAgbGFiZWwociksXG4gICAgICAuLi5yLnBvc2l0aW9uYWxzLm1hcChyZW5kZXJQb3NpdGlvbmFsKSxcbiAgICAgIC4uLnIuZmxhZ3MuZmlsdGVyKChrKSA9PiAhaGlkZXMuaGFzKGspKS5tYXAoKGspID0+IHJlbmRlckZsYWcoaywgci5yZXF1aXJlZC5oYXMoaykpKSxcbiAgICBdLmpvaW4oXCIgXCIpO1xuICBjb25zdCBleHBlY3RzID0gKHI6IFJvdyk6IHN0cmluZyA9PiBgZXhwZWN0czogJHt1c2FnZUxpbmUocil9YDtcblxuICBjb25zdCByZW5kZXJIZWxwID0gKCk6IHN0cmluZyA9PiB7XG4gICAgaWYgKHNwZWMuaGVscCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gc3BlYy5oZWxwKCk7XG4gICAgY29uc3QgbGlzdGVkID0gWy4uLihyb290Um93ID8gW3Jvb3RSb3ddIDogW10pLCAuLi5yb3dzXTtcbiAgICBjb25zdCBsaW5lcyA9IGxpc3RlZC5tYXAoKHIpID0+IFt1c2FnZUxpbmUociksIHIuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLmxpbmVzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gICAgY29uc3QgYm9keSA9IGxpbmVzXG4gICAgICAubWFwKChbdSwgZF0pID0+XG4gICAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gc3BlYy5zdW1tYXJ5ID8gYCR7Y2xpTmFtZX0g4oCUICR7c3BlYy5zdW1tYXJ5fWAgOiBjbGlOYW1lO1xuICAgIGNvbnN0IHRva2VucyA9IGAgICR7SU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OYDtcbiAgICByZXR1cm4gYCR7aGVhZH1cXG5cXG4ke2JvZHl9XFxuJHt0b2tlbnN9JHtzcGVjLmhlbHBGb290ZXIgPyBgXFxuXFxuJHtzcGVjLmhlbHBGb290ZXJ9YCA6IFwiXCJ9YDtcbiAgfTtcblxuICAvKipcbiAgICogT25lIHJvdydzIGhlbHA6IGl0cyB1c2FnZSBsaW5lLCB3aGF0IGl0IGRvZXMgKHdoZW4gaXQgc2F5cyksIGVhY2ggZmxhZyBpdFxuICAgKiB0YWtlcyB3aXRoIHdoYXQgaXQgZG9lcywgYW5kIGl0cyBleGFtcGxlcy4gVGhlIHJvdydzIG93biBmbGFncyBjb21lIGZpcnN0O1xuICAgKiB0aGUgYGdsb2JhbEZsYWdzYCBldmVyeSByb3cgdGFrZXMgZm9sbG93IGluIHRoZWlyIG93biBibG9jaywgdGhlbiBhbnlcbiAgICogYHVzYWdlSGlkZXNgIGZsYWcgdGhlIHJvdyBhY2NlcHRzLCBzbyBhIHZlcmIncyBvd24gZmxhZ3MgcmVhZCBvbiB0aGVpciBvd24uXG4gICAqL1xuICBjb25zdCByZW5kZXJSb3dIZWxwID0gKHI6IFJvdyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgbGluZSA9IChrOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc3BlYy5vcHRpb25zW2tdPy50eXBlID09PSBcImJvb2xlYW5cIiA/IGAtLSR7a31gIDogYC0tJHtrfSA8JHtrfT5gO1xuICAgICAgcmV0dXJuIFt2YWx1ZSwgci5mbGFnSGVscFtrXSA/PyBcIlwiXSBhcyBjb25zdDtcbiAgICB9O1xuICAgIGNvbnN0IGlzR2xvYmFsID0gKGs6IHN0cmluZykgPT4gIXIuZmxhZ3MuaW5jbHVkZXMoaykgfHwgZ2xvYmFscy5pbmNsdWRlcyhrKTtcbiAgICBjb25zdCBvd24gPSByLmFjY2VwdGVkLmZpbHRlcigoaykgPT4gIWlzR2xvYmFsKGspICYmICFoaWRlcy5oYXMoaykpLm1hcChsaW5lKTtcbiAgICBjb25zdCBnbG9iYWwgPSByLmFjY2VwdGVkLmZpbHRlcihpc0dsb2JhbCkubWFwKGxpbmUpO1xuICAgIC8vIGB1c2FnZUhpZGVzYCBmbGFncyAoYm91bnR5J3MgYC0tc2Vzc2lvbmAvYC0tYXNgLCBhc3Ryb2xhYmUncyBsZWdhY3lcbiAgICAvLyBgLS10aW1lb3V0YCk6IGFjY2VwdGVkLCBrZXB0IG9mZiB0aGUgdXNhZ2UgbGluZSwgbGlzdGVkIGFmdGVyIHRoZSByZXN0LlxuICAgIGNvbnN0IGhpZGRlbiA9IHIuYWNjZXB0ZWQuZmlsdGVyKChrKSA9PiAhaXNHbG9iYWwoaykgJiYgaGlkZXMuaGFzKGspKS5tYXAobGluZSk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihcbiAgICAgIE1hdGgubWF4KDAsIC4uLlsuLi5vd24sIC4uLmdsb2JhbCwgLi4uaGlkZGVuXS5tYXAoKFtmXSkgPT4gZi5sZW5ndGgpKSxcbiAgICAgIDI4LFxuICAgICk7XG4gICAgY29uc3QgcmVuZGVyID0gKGZsYWdzOiAocmVhZG9ubHkgW3N0cmluZywgc3RyaW5nXSlbXSkgPT5cbiAgICAgIGZsYWdzLm1hcCgoW2YsIGRdKSA9PlxuICAgICAgICBkID09PSBcIlwiXG4gICAgICAgICAgPyBgICAke2Z9YFxuICAgICAgICAgIDogZi5sZW5ndGggPD0gd2lkdGhcbiAgICAgICAgICAgID8gYCAgJHtmLnBhZEVuZCh3aWR0aCl9ICAke2R9YFxuICAgICAgICAgICAgOiBgICAke2Z9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICAgKTtcbiAgICByZXR1cm4gW1xuICAgICAgYHVzYWdlOiAke3VzYWdlTGluZShyKX1gLFxuICAgICAgLi4uKHIuZGVzY3JpYmUgIT09IFwiXCIgPyBbXCJcIiwgci5kZXNjcmliZV0gOiBbXSksXG4gICAgICAuLi4ob3duLmxlbmd0aCA+IDAgPyBbXCJcIiwgXCJmbGFnczpcIiwgLi4ucmVuZGVyKG93bildIDogW10pLFxuICAgICAgLi4uKGdsb2JhbC5sZW5ndGggPiAwID8gW1wiXCIsIFwiZ2xvYmFsIGZsYWdzOlwiLCAuLi5yZW5kZXIoZ2xvYmFsKV0gOiBbXSksXG4gICAgICAuLi4oaGlkZGVuLmxlbmd0aCA+IDAgPyBbXCJcIiwgXCJhbHNvIGFjY2VwdGVkOlwiLCAuLi5yZW5kZXIoaGlkZGVuKV0gOiBbXSksXG4gICAgICAuLi4oci5leGFtcGxlcy5sZW5ndGggPiAwID8gW1wiXCIsIFwiZXhhbXBsZXM6XCIsIC4uLnIuZXhhbXBsZXMubWFwKChlKSA9PiBgICAke2V9YCldIDogW10pLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgfTtcblxuICAvKiogT25lIHZlcmIncyBoZWxwIChgaGVscCA8dmVyYj5gKTsgYW4gdW5rbm93biB2ZXJiIGlzIGEgdXNhZ2UgZXJyb3IgbGlzdGluZyB0aGUgdmVyYnMuICovXG4gIGNvbnN0IHJlbmRlclZlcmJIZWxwID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgciA9IGJ5VG9rZW4uZ2V0KHBhdGgpO1xuICAgIGlmIChyID09PSB1bmRlZmluZWQpXG4gICAgICByZXR1cm4gZGllKGBoZWxwOiBubyB2ZXJiIFwiJHtwYXRofVwiYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGNob2ljZXM6IHBhdGhzLFxuICAgICAgICBoaW50OiBcImhlbHAgd2l0aCBubyB2ZXJiIGxpc3RzIHRoZW0gYWxsXCIsXG4gICAgICB9KTtcbiAgICByZXR1cm4gcmVuZGVyUm93SGVscChyKTtcbiAgfTtcblxuICAvKipcbiAgICogRG9lcyBgYXJnc2AgYXNrIGZvciB0aGlzIHJvdydzIGhlbHA/IFRIRSBQQVJTRVIgREVDSURFUywgd2l0aCBubyBzaGFwZVxuICAgKiBydWxlczogb25lIHN0cmljdCBwYXJzZSBvZiB0aGUgT1JJR0lOQUwgYXJndiBhZ2FpbnN0IHRoZSB3aG9sZSB0YWJsZSBwbHVzXG4gICAqIGEgcmVnaXN0ZXJlZCBgaGVscGAgYm9vbGVhbiAoc2hvcnQgYGhgIHVubGVzcyBhIHNwZWxsIGNsYWltcyBgLWhgKS4gSXQgaXNcbiAgICogYSByZXF1ZXN0IGlmZiB0aGF0IHBhcnNlIHN1Y2NlZWRzIEFORCByZWFkcyBgaGVscGAgYXMgYW4gb3B0aW9uIHRva2VuIOKAlFxuICAgKiB0aGUgZmxhZyBpdHNlbGYsIG5ldmVyIGEgdmFsdWUgaXQgdG9vayAoYC0tbm90ZXM9LS1oZWxwYCkgbm9yIHRleHQgYWZ0ZXJcbiAgICogYC0tYC4gQSBmYWlsZWQgcGFyc2UgaXMgbm90IGEgcmVxdWVzdDogdGhlIG5vcm1hbCBwYXRoIHRoZW4gcmVmdXNlcyB0aGVcbiAgICogb3JpZ2luYWwgYXJndiBleGFjdGx5IGFzIGl0IGRpZCB3aGVuIGAtLWhlbHBgIHdhcyBhbiB1bmtub3duIGZsYWcuIEFcbiAgICogZGFzaC1sZWQgdG9rZW4gaW4gYSBzdHJpbmcgZmxhZydzIHZhbHVlIHNsb3QgaXMgdGhlIHBhcnNlcidzIFwiYXJndW1lbnQgaXNcbiAgICogYW1iaWd1b3VzXCIgaW4gc3RyaWN0IG1vZGUsIHNvIGAtLW5vdGVzIC0taGVscCBbbW9yZSB3b3Jkc11gLCBgLXFuIC1oYCxcbiAgICogYC0tbm90ZXMgLS0gLS1oZWxwYCBhbmQgZXZlcnkgb3RoZXIgdmFsdWUtc2xvdCBzaGFwZSBzdGF5IGV4aXQgMiwgYW5kIHRoZVxuICAgKiBjb21tYW5kIGlzIG5ldmVyIGRyb3BwZWQgc2lsZW50bHkuIEFyaXR5IGFuZCBgY2hlY2tgIGFyZSBOT1QgY29uc3VsdGVkOlxuICAgKiBoZWxwIGZvciBhbiBpbmNvbXBsZXRlIGNvbW1hbmQgaXMgdGhlIHBvaW50IG9mIGFza2luZy5cbiAgICovXG4gIGNvbnN0IGhlbHBPcHRpb25zID0ga25vd24uaGFzKFwiaGVscFwiKVxuICAgID8gdW5kZWZpbmVkXG4gICAgOiB7XG4gICAgICAgIC4uLnBhcnNlT3B0aW9ucyxcbiAgICAgICAgaGVscDogc2hvcnRUb0tleS5oYXMoXCJoXCIpXG4gICAgICAgICAgPyB7IHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0IH1cbiAgICAgICAgICA6IHsgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsIHNob3J0OiBcImhcIiB9LFxuICAgICAgfTtcbiAgY29uc3QgYXNrc0ZvckhlbHAgPSAocm93OiBSb3csIGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogYm9vbGVhbiA9PiB7XG4gICAgLy8gQSBzcGVsbCB0aGF0IGRlY2xhcmVzIGl0cyBvd24gYGhlbHBgIG9wdGlvbiBvd25zIHRoZSB0b2tlbiBvdXRyaWdodC5cbiAgICBpZiAoaGVscE9wdGlvbnMgPT09IHVuZGVmaW5lZCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHRva2VucyB9ID0gcGFyc2VBcmdzKHtcbiAgICAgICAgYXJnczogWy4uLmFyZ3NdLFxuICAgICAgICBvcHRpb25zOiBoZWxwT3B0aW9ucyxcbiAgICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgICBhbGxvd1Bvc2l0aW9uYWxzOiByb3cuYWxsb3dQb3NpdGlvbmFscyxcbiAgICAgICAgdG9rZW5zOiB0cnVlLFxuICAgICAgfSk7XG4gICAgICByZXR1cm4gdG9rZW5zLnNvbWUoKHQpID0+IHQua2luZCA9PT0gXCJvcHRpb25cIiAmJiB0Lm5hbWUgPT09IFwiaGVscFwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gIH07XG5cbiAgLy8g4pSA4pSAIHRoZSBkZWNsYXJhdGlvbiDilIDilIBcblxuICBjb25zdCBkZWNsYXJhdGlvbiA9ICgpOiBEZWNsYXJhdGlvbiA9PiB7XG4gICAgY29uc3QgYXJnID0gKGs6IHN0cmluZyk6IERlY2xhcmVkQXJnID0+ICh7XG4gICAgICBuYW1lOiBgLS0ke2t9YCxcbiAgICAgIHR5cGU6IChzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYykudHlwZSxcbiAgICAgIHN0YXR1czogXCJ2YWxpZFwiLFxuICAgIH0pO1xuICAgIGNvbnN0IGNvbW1hbmRzOiBEZWNsYXJlZENvbW1hbmRbXSA9IFtcbiAgICAgIHtcbiAgICAgICAgcGF0aDogW10sXG4gICAgICAgIGFyZ3M6IFtcbiAgICAgICAgICAuLi5JTlRFUkNFUFRPUlMubWFwKChpKSA9PiAoe1xuICAgICAgICAgICAgbmFtZTogaS5uYW1lLFxuICAgICAgICAgICAgdHlwZTogXCJib29sZWFuXCIgYXMgY29uc3QsXG4gICAgICAgICAgICBzdGF0dXM6IFwidmFsaWRcIiBhcyBjb25zdCxcbiAgICAgICAgICB9KSksXG4gICAgICAgICAgLi4uKHJvb3RSb3cgPyByb290Um93LmFjY2VwdGVkLm1hcChhcmcpIDogW10pLFxuICAgICAgICBdLFxuICAgICAgICBwb3NpdGlvbmFsczogcm9vdFJvd1xuICAgICAgICAgID8gcm9vdFJvdy5wb3NpdGlvbmFscy5tYXAoKHApID0+ICh7IC4uLnAgfSkpXG4gICAgICAgICAgOiBbeyBuYW1lOiBzcGVjLnZlcmJQb3NpdGlvbmFsID8/IFwiY29tbWFuZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICAgIH0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IHIgb2Ygcm93cykge1xuICAgICAgZm9yIChjb25zdCB0IG9mIFtyLm5hbWUsIC4uLnIuYWxpYXNlc10pIHtcbiAgICAgICAgY29tbWFuZHMucHVzaCh7XG4gICAgICAgICAgcGF0aDogdC5zcGxpdChcIiBcIiksXG4gICAgICAgICAgYXJnczogci5hY2NlcHRlZC5tYXAoYXJnKSxcbiAgICAgICAgICBwb3NpdGlvbmFsczogci5wb3NpdGlvbmFscy5tYXAoKHApID0+ICh7IC4uLnAgfSkpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgY29uc3Qgc2NoZW1hUm93ID0gYnlUb2tlbi5nZXQoXCJzY2hlbWFcIikgYXMgUm93O1xuICAgIHJldHVybiB7XG4gICAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICAgIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiLFxuICAgICAgc2VsZkRlc2NyaXB0aW9uOiB7IGFyZ3M6IFtzY2hlbWFSb3cubmFtZV0gfSxcbiAgICAgIGNvbW1hbmRzLFxuICAgIH07XG4gIH07XG5cbiAgLy8g4pSA4pSAIGRpc3BhdGNoIOKUgOKUgFxuXG4gIC8qKlxuICAgKiBUaGUgaW5kZXggb2YgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbmVpdGhlciBhIGZsYWcgbm9yIGEgc3RyaW5nIGZsYWcnc1xuICAgKiB2YWx1ZSwgd2Fsa2luZyB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbDogYC0tayB2YCBjb25zdW1lcyBgdmAgd2hlbiBga2AgaXMgYVxuICAgKiBzdHJpbmcgZmxhZywgYC0taz12YCBjb25zdW1lcyBub3RoaW5nLCBgLXMgdmAgbGlrZXdpc2UgYnkgdGhlIHNob3J0J3MgdHlwZS5cbiAgICogQXQgYSBiYXJlIGAtLWA6IGAtMWAgd2hlbiBgc3RvcEF0VGVybWluYXRvcmAsIGVsc2UgdGhlIGluZGV4IGFmdGVyIGl0LlxuICAgKi9cbiAgY29uc3Qgc2NhblBvc2l0aW9uYWwgPSAoYXJnczogc3RyaW5nW10sIHN0b3BBdFRlcm1pbmF0b3I6IGJvb2xlYW4pOiBudW1iZXIgPT4ge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYXJncy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgYSA9IGFyZ3NbaV0gYXMgc3RyaW5nO1xuICAgICAgaWYgKGEgPT09IFwiLS1cIikgcmV0dXJuIHN0b3BBdFRlcm1pbmF0b3IgfHwgaSArIDEgPj0gYXJncy5sZW5ndGggPyAtMSA6IGkgKyAxO1xuICAgICAgaWYgKGEuc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICAgIGlmIChhLmluY2x1ZGVzKFwiPVwiKSkgY29udGludWU7XG4gICAgICAgIGlmIChzcGVjLm9wdGlvbnNbYS5zbGljZSgyKV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLVwiKSAmJiBhLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgY29uc3Qga2V5ID0gYS5sZW5ndGggPT09IDIgPyBzaG9ydFRvS2V5LmdldChhLnNsaWNlKDEpKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKGtleSAhPT0gdW5kZWZpbmVkICYmIHNwZWMub3B0aW9uc1trZXldPy50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGk7XG4gICAgfVxuICAgIHJldHVybiAtMTtcbiAgfTtcblxuICBjb25zdCB3aXRob3V0ID0gKGFyZ3M6IHN0cmluZ1tdLCBpOiBudW1iZXIpOiBzdHJpbmdbXSA9PiBbXG4gICAgLi4uYXJncy5zbGljZSgwLCBpKSxcbiAgICAuLi5hcmdzLnNsaWNlKGkgKyAxKSxcbiAgXTtcblxuICBjb25zdCBub0NvbW1hbmQgPSAoKTogbmV2ZXIgPT5cbiAgICBkaWUoXCJleHBlY3RlZCBhIGNvbW1hbmRcIiwgXCJ1c2FnZVwiLCB7XG4gICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgaGludDogYHJ1biBcXGAke2NsaU5hbWV9IGhlbHBcXGAgKG9yIC0taGVscCkgZm9yIHVzYWdlYCxcbiAgICB9KTtcblxuICAvKiogQSB2ZXJiIGNhbmRpZGF0ZSBhbmQgdGhlIGFyZ3MgYWZ0ZXIgaXQsIHRvIGEgcm93IGFuZCB0aGF0IHJvdydzIGFyZ3MuICovXG4gIGNvbnN0IHJlc29sdmUgPSAoY2FuZDogc3RyaW5nLCByZXN0OiBzdHJpbmdbXSk6IHsgcm93OiBSb3c7IHRva2VuOiBzdHJpbmc7IGFyZ3M6IHN0cmluZ1tdIH0gPT4ge1xuICAgIGNvbnN0IHN1YnMgPSBzdWJzT2YuZ2V0KGNhbmQpO1xuICAgIGlmIChzdWJzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbnN0IGF0ID0gc3BlYy5ncm91cHM/LltjYW5kXT8uc3ViVmVyYkF0ID8/IFwiYWRqYWNlbnRcIjtcbiAgICAgIGxldCBpID0gLTE7XG4gICAgICBpZiAoYXQgPT09IFwiYWRqYWNlbnRcIikge1xuICAgICAgICBjb25zdCBuZXh0ID0gcmVzdFswXTtcbiAgICAgICAgaSA9IG5leHQgIT09IHVuZGVmaW5lZCAmJiAhbmV4dC5zdGFydHNXaXRoKFwiLVwiKSA/IDAgOiAtMTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGkgPSBzY2FuUG9zaXRpb25hbChyZXN0LCB0cnVlKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHN1YiA9IGkgPj0gMCA/IChyZXN0W2ldIGFzIHN0cmluZykgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBmdWxsID0gc3ViID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiBieVRva2VuLmdldChgJHtjYW5kfSAke3N1Yn1gKTtcbiAgICAgIGlmIChmdWxsICE9PSB1bmRlZmluZWQgJiYgc3ViICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIHsgcm93OiBmdWxsLCB0b2tlbjogYCR7Y2FuZH0gJHtzdWJ9YCwgYXJnczogd2l0aG91dChyZXN0LCBpKSB9O1xuICAgICAgfVxuICAgICAgY29uc3Qgb3duID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgICBpZiAob3duICE9PSB1bmRlZmluZWQpIHJldHVybiB7IHJvdzogb3duLCB0b2tlbjogY2FuZCwgYXJnczogcmVzdCB9O1xuICAgICAgY29uc3QgZXh0cmEgPSB7IGNob2ljZXM6IFsuLi5zdWJzXSwgaGludDogYHJ1biBcXGAke2NsaU5hbWV9IGhlbHBcXGAgZm9yIHVzYWdlYCB9O1xuICAgICAgaWYgKHN1YiA9PT0gdW5kZWZpbmVkKSBkaWUoYCR7Y2FuZH06IGV4cGVjdGVkIGEgc3ViLWNvbW1hbmRgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICAgIGRpZShgdW5rbm93biAke2NhbmR9IHN1Yi1jb21tYW5kOiBcIiR7c3VifVwiYCwgXCJ1c2FnZVwiLCBleHRyYSk7XG4gICAgfVxuICAgIGNvbnN0IHJvdyA9IGJ5VG9rZW4uZ2V0KGNhbmQpO1xuICAgIGlmIChyb3cgPT09IHVuZGVmaW5lZCkge1xuICAgICAgZGllKGB1bmtub3duIGNvbW1hbmQgXCIke2NhbmR9XCJgLCBcInVzYWdlXCIsIHtcbiAgICAgICAgY2hvaWNlczogWy4uLnZlcmJzXSxcbiAgICAgICAgaGludDogYHJ1biBcXGAke2NsaU5hbWV9IGhlbHBcXGAgZm9yIHVzYWdlYCxcbiAgICAgIH0pO1xuICAgIH1cbiAgICByZXR1cm4geyByb3csIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gIH07XG5cbiAgLyoqXG4gICAqIENvbnRyYWN0IDUncyBgLS1gIG1hZGUgdGhlIGNhbGxlcidzIGZsYWcgVEVYVDsgc2F5IHNvIChjMSxcbiAgICogYGRvY3MvaXRlbXMvX2FyY2hpdmUvdGVybWluYXRvci1lYXRzLXNlc3Npb24ta2V5Lm1kYCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzXG4gICAqIGEgZmxhZyB0aGlzIHJvdyBhY2NlcHRzIOKAlCBgLS1rYCwgYC0taz12YCwgb3IgdGhlIHNob3J0IGAtc2Agb2YgYW4gYWNjZXB0ZWRcbiAgICogYGtgLCBnbG9iYWxzIGluY2x1ZGVkIOKAlCBpcyBuYW1lZCBpbiBPTkUgYCMgd2FybmluZzpgIGxpbmUgb24gc3RkZXJyLCB3aXRoXG4gICAqIHRoZSBtb3ZlIHRoYXQgcmVjb3ZlcnMgaXQuIFN0ZG91dCBhbmQgdGhlIGV4aXQgY29kZSBkbyBub3QgY2hhbmdlLCBhbmQgdGhlXG4gICAqIHJvdyBzdGlsbCBydW5zOiB0ZXh0IGNvbnRhaW5pbmcgYSBmbGFnIG5hbWUgaXMgbGVnaXRpbWF0ZSwgd2hpY2ggaXMgd2hhdFxuICAgKiBgLS1gIGlzIGZvci4gQSB0b2tlbiB0aGUgcm93IGRvZXMgbm90IGFjY2VwdCBpcyBqdXN0IHRleHQsIGFuZCBzYXlzIG5vdGhpbmcuXG4gICAqXG4gICAqIOKaoCBDYWxsZWQgb25seSBvbmNlIGV2ZXJ5IHJlZnVzYWwgaGFzIHBhc3NlZCwgc28gYSByZWZ1c2VkIGludm9jYXRpb24nc1xuICAgKiBzdGRlcnIgaXMgc3RpbGwgZXhhY3RseSBvbmUgZW52ZWxvcGUuIFRoZSBgIyBgIHByZWZpeCBpcyB0aGUgaG91c2Unc1xuICAgKiBzdWNjZXNzLXBhdGggc3RkZXJyIGZvcm0gKGAjIHdhcm5pbmc6YCBpbiBtaW5kLW1hcHBlciwgYCMgcGlubmVkIGJvYXJkYCxcbiAgICogYCMg4oaSIGNoYW5uZWxgKTogYW4gZW52ZWxvcGUgcmVhZGVyIGxvb2tzIGZvciBhIGB7YCBsaW5lIGFuZCBza2lwcyBpdC5cbiAgICovXG4gIGNvbnN0IHdhcm5EZW1vdGVkID0gKFxuICAgIHJvdzogUm93LFxuICAgIGFjY2VwdGVkOiBSZWFkb25seVNldDxzdHJpbmc+LFxuICAgIHRva2VuczogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPltcInRva2Vuc1wiXSxcbiAgKTogdm9pZCA9PiB7XG4gICAgY29uc3QgZW5kID0gdG9rZW5zPy5maW5kSW5kZXgoKHQpID0+IHQua2luZCA9PT0gXCJvcHRpb24tdGVybWluYXRvclwiKSA/PyAtMTtcbiAgICBpZiAodG9rZW5zID09PSB1bmRlZmluZWQgfHwgZW5kIDwgMCkgcmV0dXJuO1xuICAgIGNvbnN0IGRlbW90ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCB0IG9mIHRva2Vucy5zbGljZShlbmQgKyAxKSkge1xuICAgICAgaWYgKHQua2luZCAhPT0gXCJwb3NpdGlvbmFsXCIpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgdiA9IHQudmFsdWU7XG4gICAgICBsZXQga2V5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgICBpZiAodi5zdGFydHNXaXRoKFwiLS1cIikpIGtleSA9IHYuc2xpY2UoMikuc3BsaXQoXCI9XCIpWzBdO1xuICAgICAgZWxzZSBpZiAodi5sZW5ndGggPT09IDIgJiYgdi5zdGFydHNXaXRoKFwiLVwiKSkga2V5ID0gc2hvcnRUb0tleS5nZXQodi5zbGljZSgxKSk7XG4gICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYga2V5ICE9PSBcIlwiICYmIGFjY2VwdGVkLmhhcyhrZXkpKSBkZW1vdGVkLnB1c2godik7XG4gICAgfVxuICAgIGlmIChkZW1vdGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IHdoaWNoID0gZGVtb3RlZC5qb2luKFwiLCBcIik7XG4gICAgY29uc3Qgb25lID0gZGVtb3RlZC5sZW5ndGggPT09IDE7XG4gICAgY29uc3QgaXQgPSBvbmUgPyBcIml0XCIgOiBcInRoZW1cIjtcbiAgICBjb25zdCB3YXMgPSBvbmUgPyBcIndhc1wiIDogXCJ3ZXJlXCI7XG4gICAgY29uc3QgYXNGbGFnID0gb25lID8gXCJhcyBhIGZsYWdcIiA6IFwiYXMgZmxhZ3NcIjtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGAjIHdhcm5pbmc6ICR7Y2xpTmFtZX0ke3Jvdy5uYW1lID09PSBcIlwiID8gXCJcIiA6IGAgJHtyb3cubmFtZX1gfTogJHt3aGljaH0gYWZ0ZXIgXFxgLS1cXGAgJHt3YXN9IHJlYWQgYXMgdGV4dCwgbm90ICR7YXNGbGFnfTsgdG8gdXNlICR7aXR9ICR7YXNGbGFnfSwgbW92ZSAke2l0fSBiZWZvcmUgXFxgLS1cXGBcXG5gLFxuICAgICk7XG4gIH07XG5cbiAgY29uc3QgcnVuUm93ID0gYXN5bmMgKHJvdzogUm93LCB0b2tlbjogc3RyaW5nLCBhcmdzOiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQocm93Lm5hbWUgPT09IFwiXCIgPyBudWxsIDogcm93Lm5hbWUpO1xuICAgIGNvbnN0IG5hbWUgPSBsYWJlbChyb3cpO1xuICAgIC8vIGA8dmVyYj4gLS1oZWxwYCAob3IgYC1oYCwgdW5sZXNzIHRoZSBzcGVsbCBnYXZlIGAtaGAgYSBmbGFnIG9mIGl0cyBvd24pIGlzXG4gICAgLy8gYGhlbHAgPHZlcmI+YDogYXNrZWQgYmVmb3JlIGFueXRoaW5nIGVsc2UgaXMgY2hlY2tlZC4gRXZlcnkgcm93IGFuc3dlcnNcbiAgICAvLyBpdCDigJQgdGhlIGF1dG8gcm93cyAoYGhlbHAgLS1oZWxwYCwgYHNjaGVtYSAtLWhlbHBgKSBhbmQgYSB2ZXJibGVzcyByb290XG4gICAgLy8gKGBkaWdlc3RpZnkgLS1maWxlIHggLS1oZWxwYCkgaW5jbHVkZWQuIGBhc2tzRm9ySGVscGAgbmFtZXMgdGhlIG9uZSBwbGFjZVxuICAgIC8vIGEgYC0taGVscGAgdG9rZW4gaXMgbm90IGEgcmVxdWVzdC5cbiAgICBpZiAoYXNrc0ZvckhlbHAocm93LCBhcmdzKSkge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVyUm93SGVscChyb3cpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGNvbnN0IGFjY2VwdGVkID0gbmV3IFNldChyb3cuYWNjZXB0ZWQpO1xuICAgIGNvbnN0IGNob2ljZXMgPSByb3cubmFtZSA9PT0gXCJcIiA/IHJvb3RDaG9pY2VzIDogZmxhZ3NGb3Iocm93Lm5hbWUpO1xuICAgIGNvbnN0IGZsYWdIaW50ID0gKCk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxuICAgICAgW3Jvdy5yZWplY3RIaW50LCBjaG9pY2VzLmxlbmd0aCA9PT0gMCA/IGAke25hbWV9IHRha2VzIG5vIGZsYWdzYCA6IHVuZGVmaW5lZF1cbiAgICAgICAgLmZpbHRlcigocyk6IHMgaXMgc3RyaW5nID0+IHMgIT09IHVuZGVmaW5lZClcbiAgICAgICAgLmpvaW4oXCI7IFwiKSB8fCB1bmRlZmluZWQ7XG5cbiAgICBsZXQgdmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBsZXQgcG9zaXRpb25hbHM6IHN0cmluZ1tdO1xuICAgIGxldCB0b2tlbnM6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz5bXCJ0b2tlbnNcIl07XG4gICAgdHJ5IHtcbiAgICAgICh7IHZhbHVlcywgcG9zaXRpb25hbHMsIHRva2VucyB9ID0gcGFyc2VBcmdzKHtcbiAgICAgICAgYXJncyxcbiAgICAgICAgb3B0aW9uczogcGFyc2VPcHRpb25zLFxuICAgICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICAgIGFsbG93UG9zaXRpb25hbHM6IHJvdy5hbGxvd1Bvc2l0aW9uYWxzLFxuICAgICAgICB0b2tlbnM6IHRydWUsXG4gICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGVyckNvZGUoZSkgPT09IFwiRVJSX1BBUlNFX0FSR1NfVU5LTk9XTl9PUFRJT05cIikge1xuICAgICAgICBkaWUoYCR7bmFtZX06ICR7ZXJyTWVzc2FnZShlKX1gLCBcInVzYWdlXCIsIHsgY2hvaWNlcywgaGludDogZmxhZ0hpbnQoKSB9KTtcbiAgICAgIH1cbiAgICAgIC8vIEEgbWlzc2luZyB2YWx1ZSBpcyBub3QgYSBjaG9pY2UgZnJvbSBhIHNldCwgc28gbm8gYGNob2ljZXNgIGhlcmUuXG4gICAgICBkaWUoYCR7bmFtZX06ICR7ZXJyTWVzc2FnZShlKX1gLCBcInVzYWdlXCIsIHsgaGludDogcm93LnJlamVjdEhpbnQgPz8gZXhwZWN0cyhyb3cpIH0pO1xuICAgIH1cblxuICAgIC8vIFN0YWdlIDI6IGtub3duIHRvIHRoZSBzcGVsbCwgbm90IHRha2VuIGJ5IHRoaXMgcm93IOKAlCBNSVNQTEFDRUQsIG5vdFxuICAgIC8vIHVua25vd24uIE9ubHkgZmxhZ3MgdGhlIGNhbGxlciBHQVZFIGFyZSBoZXJlOiBkZWZhdWx0cyBhcmUgbm90IGFwcGxpZWQgeWV0LlxuICAgIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXModmFsdWVzKS5maW5kKChrKSA9PiAhYWNjZXB0ZWQuaGFzKGspKTtcbiAgICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgZGllKFxuICAgICAgICBgLS0ke3N0cmF5fSBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgJHtuYW1lfVxcYCAoaXQgaXMgYSByZWNvZ25pemVkICR7Y2xpTmFtZX0gZmxhZywganVzdCBub3QgdGhpcyAke3Jvdy5uYW1lID09PSBcIlwiID8gXCJjb21tYW5kXCIgOiBcInZlcmJcIn0ncylgLFxuICAgICAgICBcInVzYWdlXCIsXG4gICAgICAgIHsgY2hvaWNlcywgaGludDogZmxhZ0hpbnQoKSB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBBcml0eSwgZnJvbSB0aGUgZGVjbGFyZWQgc2hhcGUsIG5hbWluZyB0aGUgbWlzc2luZyBvciB0aGUgZXh0cmEgdG9rZW4uXG4gICAgY29uc3QgcmVxdWlyZWQgPSByb3cucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gICAgY29uc3QgdmFyaWFkaWMgPSByb3cucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gICAgaWYgKHBvc2l0aW9uYWxzLmxlbmd0aCA8IHJlcXVpcmVkKSB7XG4gICAgICBjb25zdCBtaXNzaW5nID0gcm93LnBvc2l0aW9uYWxzW3Bvc2l0aW9uYWxzLmxlbmd0aF07XG4gICAgICBkaWUoYCR7bmFtZX06IG1pc3NpbmcgcmVxdWlyZWQgPCR7bWlzc2luZz8ubmFtZSA/PyBcImFyZ3VtZW50XCJ9PmAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBleHBlY3RzKHJvdyksXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKCF2YXJpYWRpYyAmJiBwb3NpdGlvbmFscy5sZW5ndGggPiByb3cucG9zaXRpb25hbHMubGVuZ3RoKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAke25hbWV9OiB1bmV4cGVjdGVkIGFyZ3VtZW50ICR7SlNPTi5zdHJpbmdpZnkocG9zaXRpb25hbHNbcm93LnBvc2l0aW9uYWxzLmxlbmd0aF0pfWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBoaW50OiByb3cucG9zaXRpb25hbHMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gYXJndW1lbnRzYCA6IGV4cGVjdHMocm93KSB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBEZWZhdWx0cyBsYXN0LCBhbmQgb25seSB0aGlzIHJvdydzLlxuICAgIGNvbnN0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBGbGFnVmFsdWU+ID0geyAuLi4odmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4pIH07XG4gICAgZm9yIChjb25zdCBrIG9mIHJvdy5hY2NlcHRlZCkge1xuICAgICAgY29uc3QgZCA9IChzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYykuZGVmYXVsdDtcbiAgICAgIGlmIChmbGFnc1trXSA9PT0gdW5kZWZpbmVkICYmIGQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBmbGFnc1trXSA9IChBcnJheS5pc0FycmF5KGQpID8gWy4uLmRdIDogZCkgYXMgRmxhZ1ZhbHVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoY29uc3QgayBvZiByb3cucmVxdWlyZWQpXG4gICAgICBpZiAoZmxhZ3Nba10gPT09IHVuZGVmaW5lZClcbiAgICAgICAgZGllKGAke25hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIC0tJHtrfWAsIFwidXNhZ2VcIiwgeyBoaW50OiBleHBlY3RzKHJvdykgfSk7XG5cbiAgICBjb25zdCBpbnY6IEludm9jYXRpb24gPSB7IHBhdGg6IHJvdy5uYW1lLCB0b2tlbiwgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3MgfTtcbiAgICBjb25zdCByZWZ1c2VkID0gcm93LmNoZWNrPy4oaW52KTtcbiAgICBpZiAocmVmdXNlZCAhPT0gdW5kZWZpbmVkKSBkaWUoYCR7bmFtZX06ICR7cmVmdXNlZH1gLCBcInVzYWdlXCIsIHsgaGludDogZXhwZWN0cyhyb3cpIH0pO1xuXG4gICAgd2FybkRlbW90ZWQocm93LCBhY2NlcHRlZCwgdG9rZW5zKTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCByb3cucnVuKGludik7XG4gICAgcmV0dXJuIHR5cGVvZiBvdXQgPT09IFwibnVtYmVyXCIgPyBvdXQgOiAwO1xuICB9O1xuXG4gIGNvbnN0IGRpc3BhdGNoID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChhcmd2WzBdID8/IG51bGwpO1xuICAgIGNvbnN0IGZpcnN0ID0gYXJndlswXTtcblxuICAgIC8vIDEuIEludGVyY2VwdG9ycyBwYXNzIHRoZSByZXN0IG9mIHRoZSBhcmd2IG9uIHRvIHRoZWlyIHJvdy5cbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IElOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGZpcnN0KTtcbiAgICBpZiAoaW50ZXJjZXB0b3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHJ1blJvdyhieVRva2VuLmdldChpbnRlcmNlcHRvci5ydW5zKSBhcyBSb3csIGludGVyY2VwdG9yLnJ1bnMsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgIH1cblxuICAgIC8vIDIuIEEgdmVyYmxlc3Mgcm9vdCBvd25zIGV2ZXJ5IGFyZ3YgdGhhdCBkb2VzIG5vdCBzdGFydCB3aXRoIGEgcmVzZXJ2ZWQgdG9rZW4uXG4gICAgaWYgKHJvb3RSb3cgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpcnN0ICE9PSB1bmRlZmluZWQgJiYgKGJ5VG9rZW4uaGFzKGZpcnN0KSB8fCBzdWJzT2YuaGFzKGZpcnN0KSkpIHtcbiAgICAgICAgY29uc3QgciA9IHJlc29sdmUoZmlyc3QsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgICAgICByZXR1cm4gcnVuUm93KHIucm93LCByLnRva2VuLCByLmFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJ1blJvdyhyb290Um93LCBcIlwiLCBhcmd2KTtcbiAgICB9XG5cbiAgICAvLyAzLiBCYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciAoYWNjIEMyL0QyKS5cbiAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vQ29tbWFuZCgpO1xuXG4gICAgLy8gNC4gRmluZCB0aGUgdmVyYi5cbiAgICBsZXQgY2FuZDogc3RyaW5nO1xuICAgIGxldCByZXN0OiBzdHJpbmdbXTtcbiAgICBpZiAoZ3JhbW1hciA9PT0gXCJ2ZXJiLWZpcnN0XCIpIHtcbiAgICAgIGlmIChmaXJzdCA9PT0gXCItLVwiKSB7XG4gICAgICAgIGlmIChhcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgICAgY2FuZCA9IGFyZ3ZbMV07XG4gICAgICAgIHJlc3QgPSBbXCItLVwiLCAuLi5hcmd2LnNsaWNlKDIpXTtcbiAgICAgIH0gZWxzZSBpZiAoZmlyc3Quc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICAgICAgcmV0dXJuIGRpZShgdW5rbm93biBmbGFnIGF0IHRoZSByb290OiAke2ZpcnN0fWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGNob2ljZXM6IFsuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXSxcbiAgICAgICAgICBoaW50OiBgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7dmVyYnMuam9pbihcIiBcIil9YCxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjYW5kID0gZmlyc3Q7XG4gICAgICAgIHJlc3QgPSBhcmd2LnNsaWNlKDEpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpID0gc2NhblBvc2l0aW9uYWwoYXJndiwgZmFsc2UpO1xuICAgICAgaWYgKGkgPCAwKSB7XG4gICAgICAgIC8vIE5vIHZlcmIgYW55d2hlcmU6IGFuIHVua25vd24gZmxhZyBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQsXG4gICAgICAgIC8vIGFuZCBhIGNsZWFuIHBhcnNlIGlzIGEgYmFyZSBpbnZvY2F0aW9uLiBOZWl0aGVyIHJhbiBhIGNvbW1hbmQsIHNvXG4gICAgICAgIC8vIHRoZSBlbnZlbG9wZSdzIGBtZXRhLmNvbW1hbmRgIGlzIG51bGwsIG5vdCB0aGUgZmlyc3QgZmxhZydzXG4gICAgICAgIC8vIHNwZWxsaW5nIChgZ2xhbW91ciAtLWJvZ3VzYCBuYW1lcyBubyB2ZXJiKS5cbiAgICAgICAgc2V0Q3VycmVudENvbW1hbmQobnVsbCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogcGFyc2VPcHRpb25zLCBzdHJpY3Q6IHRydWUsIGFsbG93UG9zaXRpb25hbHM6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBkaWUoZXJyTWVzc2FnZShlKSwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgICBoaW50OiBgbm8gY29tbWFuZCBnaXZlbiDigJQgY29tbWFuZHM6ICR7dmVyYnMuam9pbihcIiBcIil9IChydW46ICR7Y2xpTmFtZX0gaGVscClgLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgIH1cbiAgICAgIGNhbmQgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICAgIC8vIEEgdmVyYiBmb3VuZCByaWdodCBhZnRlciBhIGAtLWAgbGVhdmVzIHRoYXQgYC0tYCBpbiBwbGFjZSwgc28gdGhlXG4gICAgICAvLyByZXN0IG9mIHRoZSBhcmd2IHN0YXlzIHBvc2l0aW9uYWwuXG4gICAgICByZXN0ID0gd2l0aG91dChhcmd2LCBpKTtcbiAgICB9XG4gICAgc2V0Q3VycmVudENvbW1hbmQoY2FuZCk7XG4gICAgY29uc3QgciA9IHJlc29sdmUoY2FuZCwgcmVzdCk7XG4gICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgfTtcblxuICBjb25zdCBtYWluID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICAgIC8vIFRoZSBob3VzZSBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS4gQSBzcGVsbCB0aGF0XG4gICAgICAvLyB0cmlhZ2VzIGl0cyBvd24gKGdsYW1vdXIncyBFTk9FTlQg4oaSIHVzYWdlKSBjYWxscyBgZGlzcGF0Y2hgIGluc3RlYWQuXG4gICAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgZXJyTWVzc2FnZShlKSkpID8/IDE7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHZpZXcgPSAocjogUm93KTogUm93VmlldyA9PiAoe1xuICAgIG5hbWU6IHIubmFtZSxcbiAgICBhbGlhc2VzOiByLmFsaWFzZXMsXG4gICAgZmxhZ3M6IHIuZmxhZ3MsXG4gICAgYWNjZXB0ZWQ6IHIuYWNjZXB0ZWQsXG4gICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMsXG4gICAgZGVzY3JpYmU6IHIuZGVzY3JpYmUsXG4gICAgYXV0bzogci5hdXRvLFxuICB9KTtcblxuICBPYmplY3QuYXNzaWduKGNsaSwge1xuICAgIG5hbWU6IGNsaU5hbWUsXG4gICAgbWFpbixcbiAgICBkaXNwYXRjaCxcbiAgICBkZWNsYXJhdGlvbixcbiAgICByZW5kZXJIZWxwLFxuICAgIHJlbmRlclZlcmJIZWxwLFxuICAgIHVzYWdlT2Y6IChwYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHIgPSByb3dGb3IocGF0aCk7XG4gICAgICByZXR1cm4gciA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IHVzYWdlTGluZShyKTtcbiAgICB9LFxuICAgIHZlcmJzLFxuICAgIHBhdGhzLFxuICAgIGZsYWdzRm9yLFxuICAgIHJlY29nbml6ZWRGbGFnczogb3B0aW9uS2V5cy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICByb3dzOiByb3dzLm1hcCh2aWV3KSxcbiAgfSBzYXRpc2ZpZXMgQ2xpKTtcbiAgcmV0dXJuIGNsaTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRlcGVuZGVuY3ktZnJlZSBhbmQgZGVsaWJlcmF0ZWx5IGR1bGw6IGl0IGlzIGJ1bmRsZWQgSU5UTyBlYWNoXG4gKiBzcGVsbCdzIGVtaXR0ZWQgQ0xJIChDb250cmFjdCA0J3MgYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLCBzbyBhbnl0aGluZyBpdFxuICogcmVhY2hlZCBmb3Igd291bGQgYmVjb21lIGEgZGVwZW5kZW5jeSBvZiB0d28gc2hpcHBlZCBhcnRpZmFjdHMgYXQgb25jZS5cbiAqXG4gKiBUaGUgd2lyZSBjb250cmFjdCBpdCBlbmNvZGVzOiBleGFjdGx5IG9uZSBKU09OIGRvY3VtZW50LCBvbmUgdHJhaWxpbmdcbiAqIG5ld2xpbmUsIG5vdGhpbmcgZWxzZSBvbiBzdGRvdXQuIEEgY2FsbGVyIHJlYWRpbmcgb3VyIHN0ZG91dCB3aXRoIGFcbiAqIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBkZXBlbmRzIG9uIHRoYXQgbmV3bGluZTsgYSBjYWxsZXIgcmVhZGluZyB0byBFT0ZcbiAqIGRlcGVuZHMgb24gdGhlcmUgYmVpbmcgbm8gc2Vjb25kIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pOiB2b2lkIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLy8gU2Vzc2lvbiBlbmRpbmdzIGFyZSBvdXRjb21lcywgbm90IGZhaWx1cmVzLCBhbmQgc3RheSBvdXRzaWRlIHRoZSB0YXhvbm9teTpcbi8vIGFuIGFnZW50IHJlYWRzIHRoZW0gYXMgXCJ0aGUgc2Vzc2lvbiBlbmRlZCB0aGlzIHdheVwiLCBub3QgXCJ0aGUgdmVyYiBicm9rZVwiLlxuLy8gVGhlIG51bWJlcnMgYXJlIHRoZSBzaGVsbCdzIChgdGltZW91dGAncyAxMjQsIFNJR0lOVCdzIDEyOCArIDIpLCBzbyBhXG4vLyB3cmFwcGVyIHRoYXQgYWxyZWFkeSBrbm93cyB0aGVtIG5lZWRzIG5vIHRhYmxlLlxuLyoqIEEgZGFlbW9uIHRoYXQgY2xvc2VkIGl0c2VsZiBhZnRlciBpdHMgaWRsZSB0aW1lb3V0LiBBbiBvdXRjb21lLCBub3QgYSBmYWlsdXJlLiAqL1xuZXhwb3J0IGNvbnN0IEVYSVRfSURMRV9USU1FT1VUID0gMTI0O1xuLyoqIFRoZSB1c2VyIGNhbmNlbGxlZC4gQW4gb3V0Y29tZSwgbm90IGEgZmFpbHVyZS4gKi9cbmV4cG9ydCBjb25zdCBFWElUX0NBTkNFTExFRCA9IDEzMDtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYHRva2VuYCBpcyBhIHN0YWJsZSBtYWNoaW5lLXJlYWRhYmxlIG5hbWVcbiAqIGZvciB0aGUgY2F1c2UgKGBub19zZXNzaW9uYCksIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IHRva2VuPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAvLyBPbmx5IHByZXNlbnQgd2hlbiBnaXZlbiwgc28gYW4gZW52ZWxvcGUgd2l0aG91dCBvbmUga2VlcHMgaXRzIGJ5dGVzLlxuICAgICAgLi4uKGV4dHJhPy50b2tlbiA/IHsgdG9rZW46IGV4dHJhLnRva2VuIH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaXRlbXMvX2FyY2hpdmUvdGFpbC1yZWFkZXItY29udmVyZ2VuY2Uvd3JpdGUtdXAubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLlxuICAgKlxuICAgKiAg4puUIEFORCBXSEVOIFRIRSBORVcgTE9HIFdBUyBBTFJFQURZIFBBU1QgVEhFIEJPT0tNQVJLLCBUSEUgQ0xJRU5UXG4gICAqICBSRUNPTk5FQ1RTIEZST00gSVRTIFNUQVJULiBBIGRhZW1vbiB0aGF0IGJlbGlldmVzIHRoZSBjdXJzb3Igc2VuZHMgb25seVxuICAgKiAgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hbiBtZXNzYWdlIGF0XG4gICAqICBuZXcgaWQgMiB1bmRlciBhbiBvbGQgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHNpbGVudGx5LiBFdmVyeXRoaW5nIGluXG4gICAqICBhIG5ldyBlcG9jaCBpcyBuZXcgdG8gdGhpcyByZWFkZXIsIHNvIHRoZSBhdHRlbXB0IGlzIGRyb3BwZWQgYW5kIHJlLW1hZGVcbiAgICogIGZyb20gMCBhdCBvbmNlIChubyBiYWNrb2ZmKS4gQSBmcmFtZSBBVCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIG1lYW5zXG4gICAqICB0aGUgZGFlbW9uIGlzIGFscmVhZHkgcmVwbGF5aW5nIHdob2xlLCBhbmQgaXMga2VwdC4gKFJldmlld2VyJ3MgRDIgZ2FwLFxuICAgKiAgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYuKSAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBlcG9jaCB0aGUgc3RhcnRpbmcgYHNpbmNlYCBjYW1lIGZyb20sIHdoZW4gdGhlIGNhbGxlciBoYXMgb25lIChhXG4gICAqICBib29rbWFyayBwcmludGVkIGFzIGBOQDxlcG9jaD5gLCBgLi90YWlsSGFuZG9mZi50c2ApLiBUaGUgZmlyc3QgZnJhbWUgb2YgYVxuICAgKiAgZGlmZmVyZW50IGVwb2NoIGlzIHRoZW4gYW4gZXBvY2ggY2hhbmdlIGxpa2UgYW55IG90aGVyIOKAlCB3aGljaCBpcyB3aGF0XG4gICAqICBzdG9wcyBhIGJvb2ttYXJrIG91dGxpdmluZyBpdHMgbG9nIGFjcm9zcyBwcm9jZXNzZXMuICovXG4gIHNpbmNlRXBvY2g/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSZWFkIGEgZnJhbWUgd2hvc2UgaWQgaXMgQVQgT1IgQkVMT1cgdGhlIGN1cnNvciB0aGlzIGNvbm5lY3Rpb24gYXNrZWRcbiAgICogZnJvbSBhcyBcInRoZSBsb2cgcmVzdGFydGVkXCIsIHJlc2V0IHRoZSBjdXJzb3IgdG8gMCwgYW5kIGNhbGxcbiAgICogYG9uRXBvY2hDaGFuZ2VgICh3aXRoIHRoZSBmcmFtZSdzIGVwb2NoLCBvciBgXCJ1bmtub3duXCJgKS4gRGVmYXVsdCBmYWxzZS5cbiAgICpcbiAgICog4puUIFdIWSBJVCBJUyBIT05FU1Q6IHRoZSBraXQncyBldmVudCBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93blxuICAgKiBieSByZXBsYXlpbmcgV0hPTEUgKGAuL2V2ZW50TG9nLnRzYCwgcG9pbnQgMyksIGFuZCBvdGhlcndpc2Ugc2VuZHMgb25seVxuICAgKiBpZHMgYWJvdmUgdGhlIGN1cnNvci4gU28gYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGV4aXN0cyBvbmx5XG4gICAqIHdoZW4gdGhlIGRhZW1vbiBqdWRnZWQgdGhlIGN1cnNvciBmb3JlaWduIOKAlCBhIHJlc3RhcnRlZCBkYWVtb24sIHdob3NlIGlkc1xuICAgKiBiZWdhbiBhZ2FpbiBhdCAxLiBUaGUgZXBvY2ggY2F0Y2hlcyB0aGF0IFdJVEhJTiBvbmUgcHJvY2VzczsgdGhpcyBjYXRjaGVzXG4gICAqIGl0IEFDUk9TUyBwcm9jZXNzZXMsIHdoZXJlIGEgcmUtYXJtZWQgdGFpbCBjYXJyaWVzIGEgYm9va21hcmsgZnJvbSBhIGxvZ1xuICAgKiB0aGF0IG5vIGxvbmdlciBleGlzdHMgYW5kLCB3aXRob3V0IGl0LCBrZXB0IHRoYXQgYm9va21hcmsgZm9yZXZlcjogZXZlcnlcbiAgICogcmUtYXJtIHJlcGxheWVkIHRoZSB3aG9sZSBuZXcgbG9nLCBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcFxuICAgKiAoZm91bmQgYnkgdGhlIHZlcmlmaWVyIG9uIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCBhZnRlciBgdGFpbC5sb3N0YCDihpJcbiAgICogYG9wZW4gLS1yZXN0b3JlYCkuXG4gICAqXG4gICAqIOKaoCBPTkxZIEZPUiBBIERBRU1PTiBPTiBUSEUgS0lUJ1MgRVZFTlQgTE9HLiBHcmFwZXZpbmUncyBpZHMgYXJlIHJlY292ZXJlZFxuICAgKiBhY3Jvc3MgYSByZXN0YXJ0IGFuZCBpdHMgYC0tbGFzdGAgcXVlcnkgb3ZlcnJpZGVzIGBzaW5jZWAsIHNvIGl0IGxlYXZlc1xuICAgKiB0aGlzIG9mZi4gQW5kIHRoZSBibGluZCBzcG90IGlzIHN0YXRlZDogYSBib29rbWFyayB0aGF0IGhhcHBlbnMgdG8gYmUgYXRcbiAgICogb3IgYmVsb3cgdGhlIFJFU1RBUlRFRCBsb2cncyBvd24gbGVuZ3RoIGxvb2tzIHZhbGlkIHRvIHRoZSBkYWVtb24sIHdoaWNoXG4gICAqIHRoZW4gc2VuZHMgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQuIFRoZSBjb21lLWJhY2sgcGF0aCB0aGVyZWZvcmUgZHJvcHNcbiAgICogdGhlIGJvb2ttYXJrIGFsdG9nZXRoZXIgKGAuL3RhaWxIYW5kb2ZmLnRzYCwgRDIpLCBzbyB0aGlzIGlzIHRoZSBuZXQsIG5vdFxuICAgKiB0aGUgcnVsZS5cbiAgICovXG4gIHJlc3RhcnRPblJlcGxheT86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gYGFjY2VwdGVkYCBpcyBgYWNjZXB0YCdzXG4gICAqICB2ZXJkaWN0IG9uIHRoaXMgZnJhbWUsIHdoaWNoIGlzIHdoYXQgbGV0cyBgdGFpbCAtLW9uY2VgIGVuZCBvbiB0aGUgZmlyc3RcbiAgICogIGZyYW1lIGl0IGFjdHVhbGx5IERFTElWRVJTIChgLi90YWlsSGFuZG9mZi50c2ApLlxuICAgKlxuICAgKiAg4puUIEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OIGJlZm9yZSB0aGUgY2xpZW50IHJldHVybnMuIEl0XG4gICAqICB1c2VkIHRvIHJldHVybiBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIHdpdGggdGhlIFNTRSBzdHJlYW0gc3RpbGwgb3BlbixcbiAgICogIHdoaWNoIGtlcHQgdGhlIHByb2Nlc3MgYWxpdmUg4oCUIHVuc2VlbiBmb3IgYGNsb3NlZGAsIGJlY2F1c2UgdGhlIHNlcnZlclxuICAgKiAgZW5kcyB0aGF0IHN0cmVhbSBpdHNlbGYsIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFza1xuICAgKiAgd291bGQgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQuIChBZGp1c3RtZW50IDEgb2YgdGhlXG4gICAqICBNb25pdG9yLWV4cGlyeSBzcGlrZTsgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lLCBhY2NlcHRlZDogYm9vbGVhbikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBhcyB0aGUgdGFpbCBlbmRzLCB3aXRoIHRoZSBmaW5hbCBjdXJzb3IgKHRoZSBib29rbWFyayBhIHJlLWFybVxuICAgKiBwYXNzZXMgYXMgYC0tc2luY2VgKSBhbmQgd2h5IGl0IGVuZGVkLiBBIFJFUE9SVCBTSU5LIGxpa2UgYG9uRGlzY29ubmVjdGAsXG4gICAqIG5vdCBhIGJlaGF2aW91cmFsIGhhdGNoOiBpdCBjaGFuZ2VzIG5vdGhpbmcgdGhlIGNsaWVudCBkb2VzLiBJdCBleGlzdHNcbiAgICogZm9yIGAuL3RhaWxIYW5kb2ZmLnRzYCwgd2hvc2UgbGFzdCBsaW5lIG5hbWVzIHRoZSByZS1hcm0gYW5kIG11c3QgY2FycnlcbiAgICogdGhlIGN1cnNvciBleGFjdGx5IGFzIHRoaXMgbG9vcCBsZWZ0IGl0LCBlcG9jaCByZXNldHMgaW5jbHVkZWQuXG4gICAqL1xuICBvbkVuZD86IChlbmQ6IHtcbiAgICBjdXJzb3I6IG51bWJlcjtcbiAgICAvKiogVGhlIGVwb2NoIG9mIHRoZSBsb2cgdGhlIGN1cnNvciBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZS4gKi9cbiAgICBlcG9jaDogc3RyaW5nIHwgbnVsbDtcbiAgICByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCI7XG4gIH0pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7XG4gIGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7XG4gIGNvbW1lbnRzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBvcHRzLnNpbmNlRXBvY2ggPz8gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG4gIGxldCBlbmRpbmc6IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgPSBcInN0b3BwZWRcIjtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIC8vIOKblCBBIFNUT1AgVEhBVCBMQU5ERUQgV0hJTEUgYHJlc29sdmVgIFdBUyBBV0FJVEVEICh0aGUgaGFuZG9mZidzIHdpbmRvdyxcbiAgICAgIC8vIGEgc2lnbmFsKSBmb3VuZCBubyBhdHRlbXB0IHRvIGFib3J0LiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlIGxvb3Agd2VudFxuICAgICAgLy8gb24gdG8gZmV0Y2gsIHNraXBwZWQgdGhlIHJlYWQsIGFuZCByZXR1cm5lZCB3aXRoIHRoYXQgc3RyZWFtIHN0aWxsXG4gICAgICAvLyBvcGVuIOKAlCB3aGljaCBrZWVwcyBhIHByb2Nlc3MgYWxpdmUgZXhhY3RseSBsaWtlIHRoZSB0ZXJtaW5hbC1mcmFtZVxuICAgICAgLy8gaGFuZy4gKFN1c3BlY3RlZCBieSB0aGUgcmV2aWV3ZXIsIHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKVxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHtcbiAgICAgICAgc2luY2U6IFN0cmluZyhjdXJzb3IpLFxuICAgICAgfTtcbiAgICAgIC8vIFdoYXQgdGhpcyBjb25uZWN0aW9uIGFza2VkIGZyb20sIGZvciBgcmVzdGFydE9uUmVwbGF5YC5cbiAgICAgIGNvbnN0IGFza2VkU2luY2UgPSBjdXJzb3I7XG4gICAgICBsZXQgcmVzdGFydE5vdGVkID0gZmFsc2U7XG4gICAgICAvLyBTZXQgd2hlbiBhbiBlcG9jaCBjaGFuZ2UgZmluZHMgdGhlIG5ldyBsb2cgcGFzdCB0aGUgYm9va21hcmsuXG4gICAgICBsZXQgZnJvbVRvcCA9IGZhbHNlO1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcblxuICAgICAgICAgICAgbGV0IGVwb2NoUmVzZXQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGVwb2NoUmVzZXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICAgIC8vIFRoZSBuZXcgbG9nIGlzIHBhc3QgdGhlIGJvb2ttYXJrOiBpdHMgc3RhcnQgd2FzIHNraXBwZWQuXG4gICAgICAgICAgICAgICAgICAvLyBEcm9wIHRoaXMgYXR0ZW1wdCBhbmQgcmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIDAuXG4gICAgICAgICAgICAgICAgICBpZiAoYXNrZWRTaW5jZSA+IDAgJiYgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgbiA+IGFza2VkU2luY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICAgICAgICBmcm9tVG9wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBvcHRzLnJlc3RhcnRPblJlcGxheSA9PT0gdHJ1ZSAmJlxuICAgICAgICAgICAgICAhZXBvY2hSZXNldCAmJlxuICAgICAgICAgICAgICAhcmVzdGFydE5vdGVkICYmXG4gICAgICAgICAgICAgIGFza2VkU2luY2UgPj0gMCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICBuIDw9IGFza2VkU2luY2VcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyBUaGUgZGFlbW9uIHJlcGxheWVkIFdIT0xFOiBpdHMgbG9nIHJlc3RhcnRlZCAoc2VlIHRoZSBvcHRpb24pLlxuICAgICAgICAgICAgICByZXN0YXJ0Tm90ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4ob3B0cy5lcG9jaE9mPy4oZXYpID8/IFwidW5rbm93blwiKSA/PyBudWxsO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgIC8vIFJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSBpdHMgc3RhcnQsIG5vdzogbm90aGluZyBmYWlsZWQuXG4gICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gICAgb3B0cy5vbkVuZD8uKHsgY3Vyc29yLCBlcG9jaCwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvaXRlbXMvX2FyY2hpdmUvc2NyaXB0b3JpdW0tdGFpbC1tb25pdG9yLWV4cGlyeS13YWtlcy10aGUtYWdlbnQtZm9yLW5vdGhpbmcubWRgKVxuICogYW5kIHRoZSBmb3VyIGFkanVzdG1lbnRzIG9mIGl0cyBmZWFzaWJpbGl0eSBzcGlrZVxuICogKGBkb2NzL2l0ZW1zL19hcmNoaXZlL21vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC93cml0ZS11cC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgKGFzdHJvbGFiZSwgZ3JhcGV2aW5lKSBhbHdheXMgZ2V0c1xuICogICAgIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsIHdvdWxkIGZsaWNrZXIgdGhlIHByZXNlbmNlIGl0c1xuICogICAgIGNvbm5lY3Rpb24gY2Fycmllcy4gTWluZC1tYXBwZXIgd2FzIG9uZSBhbmQgaXMgbm90IHNpbmNlIDIwMjYtMDktMjRcbiAqICAgICAoc2VlIFwiTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTXCIgYmVsb3cpLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMgYW5kIG1pbmQtbWFwcGVyKSwgZWFjaCBuYW1pbmcgaG93IHRvXG4gKiBjb21lIGJhY2sgaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMsIGBvcGVuIC0tbm8tb3BlbmAgZm9yXG4gKiAgICAgIG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmVcbiAqIHJlYWwtZGFlbW9uIGNlbGxzLCBpbiBgc3JjL2tpdC93b3Jrc3BhY2UvdGFpbC1oYW5kb2ZmLmNsb3NlZC5pbnRlZ3JhdGlvbi50ZXN0LnRzYFxuICogKEQxKSBhbmQgYHRhaWwtaGFuZG9mZi5yZXN0YXJ0LmludGVncmF0aW9uLnRlc3QudHNgIChEMikgYmVzaWRlIGl0LlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4tcHJvY2Vzc1xuICogICAgICAgICAgICAoYXN0cm9sYWJlLCBvciBtaW5kLW1hcHBlciB3aGVuIGl0cyBkYWVtb24gaXMgYmFjayBiZWZvcmUgdGhlXG4gKiAgICAgICAgICAgIGxvc3QgcnVsZSBmaXJlcykgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHlcbiAqICAgICAgICAgICAgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBvcGVucyBub1xuICogYnJvd3NlciB0YWIuXG4gKlxuICog4pqgIEtOT1dOIEVER0UsIE5PVCBGSVhFRCAoZm91bmQgYnkgdGhlIHJlLXJldmlldyk6IGEga2V5ZWQgYm91bnR5IEZJUlNUIGFybVxuICogICAoYW4gYW50aGlsbCBzZWF0KSB3aG9zZSB3aW5kb3cgZW5kcyBiZWZvcmUgaXRzIGJvYXJkIGV2ZXIgb3BlbnMgcHJpbnRzIGFcbiAqICAgcmUtYXJtIHBpbm5lZCB0byB0aGUgZGVyaXZlZCBpZCB3aXRoIGFuIGVtcHR5IGJvb2ttYXJrXG4gKiAgIChgLS1zZXNzaW9uIGst4oCmIC0tc2luY2U9LTEgLS1vbmNlYCkuIFRoYXQgcmUtYXJtIGlzIGEgcmUtYXJtIGJ5IEQxJ3MgcnVsZSxcbiAqICAgc28gaWYgdGhlIGJvYXJkIGlzIHN0aWxsIG5vdCB1cCDigJQgdGhlIGxlYWQgbW9yZSB0aGFuIG9uZSB3aW5kb3cgKDI5IG1pbilcbiAqICAgbGF0ZSDigJQgdGhlIHNlYXQgZG9lcyBub3Qgd2FpdC4gTWlub3I6IHRoZSBuZXh0IHN0ZXAgaXQgbmFtZXNcbiAqICAgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApIGlzIHRoZSByaWdodCBvbmUgYW55d2F5LiBTaW5jZSAjOTggKDIwMjYtMDktMjcpXG4gKiAgIGl0IG5vIGxvbmdlciBzYXlzIGB0YWlsLmNsb3NlZGAgYWJvdXQgYSBib2FyZCB0aGF0IG5ldmVyIG9wZW5lZDogYSBuYW1lZFxuICogICBgLS1zZXNzaW9uYCB3aXRoIG5vIHNuYXBzaG90IG9uIGRpc2sgZXhpdHMgYG5vdF9mb3VuZGAgYWZ0ZXIgYSBncmFjZS5cbiAqXG4gKiDilIDilIAgVEhFIENPTU1BTkQgTkFNRVMgTk8gUEFUSCAoQ29sZSdzIHJ1bGluZywgMjAyNi0wOS0yNCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIGxpbmUncyBgY29tbWFuZGAgaXMgdGhlIFZFUkIgQU5EIElUUyBBUkdVTUVOVFMgT05MWVxuICogKGB0YWlsIC0tc2Vzc2lvbiBYIC0tc2luY2UgTkBFIC0tb25jZWApLCBwbHVzIGBzcGVsbGAsIGFuZCB0aGUgYWdlbnQgcnVucyBpdFxuICogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50c2AuIEl0IHVzZWRcbiAqIHRvIGJlIHJ1bm5hYmxlIGFzIHByaW50ZWQsIGhlYWRlZCBieSBgYnVuIDxhcmd2WzFdPmAg4oCUIGFuZCBmb3IgYW4gaW5zdGFsbGVkXG4gKiBwbHVnaW4gYGFyZ3ZbMV1gIGlzIGluc2lkZSBhIFZFUlNJT05FRCBjYWNoZSBkaXJlY3RvcnkuIEFuIHVwZ3JhZGUgbWFya3MgdGhlXG4gKiBvbGQgZGlyZWN0b3J5IG9ycGhhbmVkIGFuZCBkZWxldGVzIGl0IGxhdGVyIChtZWFzdXJlZCBpblxuICogYGRvY3MvaXRlbXMvX2FyY2hpdmUvdGFpbC1yZWFybS1jb21tYW5kLW5hbWVzLWEtdmVyc2lvbmVkLXBsdWdpbi1wYXRoLm1kYCksXG4gKiBzbyBhIGxpbmUgcHJpbnRlZCBiZWZvcmUgYW4gdXBncmFkZSBmaXJzdCByYW4gU1RBTEUgY29kZSBhZ2FpbnN0IGEgbmV3ZXJcbiAqIGRhZW1vbiwgdGhlbiBmYWlsZWQgd2l0aCBcIm1vZHVsZSBub3QgZm91bmRcIiBvbmNlIHRoZSBkaXJlY3Rvcnkgd2FzIGdvbmUuIE5vXG4gKiBzdGFibGUgcGF0aCBleGlzdHMgdG8gcHJpbnQgaW5zdGVhZDogdGhlIGNhY2hlLCBgJENMQVVERV9QTFVHSU5fUk9PVGAgYW5kIHRoZVxuICogaW5zdGFsbCByZWNvcmQgYXJlIGFsbCB2ZXJzaW9uZWQuXG4gKiAgIFRoZSBza2lsbCdzIGxhdW5jaGVyIGlzIGFsd2F5cyB0aGUgdmVyc2lvbiB0aGUgc2Vzc2lvbiBsb2FkZWQuIENvbGUnc1xuICogcmVhc29uaW5nOiB0aGUgd29yc3QgY2FzZSBpcyB0aGF0IHRoZSBDTEkgY2hhbmdlZCBhbmQgdGhlIGFnZW50IGdldHMgYW5cbiAqIGVycm9yIOKAlCBhbmQgaWYgdGhlIHRvb2xzIGFyZSBkZXNpZ25lZCByaWdodCwgdGhhdCBlcnJvciBzYXlzIHdoYXQgd2VudFxuICogd3JvbmcuIFNvIHRoZSBwYXJzZXJzIGFyZSB0aGUgb3RoZXIgaGFsZiBvZiB0aGlzIHJ1bGluZzogYHJlYWRTaW5jZWAgcmVmdXNlc1xuICogYW55IGAtLXNpbmNlYCBmb3JtIGEgdGFpbCBkb2VzIG5vdCBhY2NlcHQgd2l0aCBhIHVzYWdlIGVycm9yIE5BTUlORyB0aGVcbiAqIGZvcm1zIGl0IGRvZXMsIHRoZSBzYW1lIHdheSBvbiBhbGwgZWlnaHQgdGFpbHMsIGluc3RlYWQgb2YgbWlzcGFyc2luZyBpdC5cbiAqICAgTm90IHRha2VuOiBwcmludGluZyB0aGUgcGF0aCBBTkQgdGhlIGFyZ3MgKG9wdGlvbiBBIG9mIHRoZSBpdGVtIOKAlCB0d29cbiAqIGNvbW1hbmRzIHdoZXJlIG9uZSBpcyB3cm9uZyBhZnRlciBhbiB1cGdyYWRlKTsgYSBsYXVuY2hlciB0aGF0IG5vdGljZXMgaXQgaXNcbiAqIG9ycGhhbmVkIGFuZCByZS1leGVjcyBhIG5ld2VyIHNpYmxpbmcgKEIg4oCUIGl0IGxlYW5zIG9uIGEgQ2xhdWRlIENvZGVcbiAqIGludGVybmFsIG1hcmtlciBhbmQgZG9lcyBub3RoaW5nIG9uY2UgdGhlIGRpcmVjdG9yeSBpcyBkZWxldGVkKTsgdmVyc2lvblxuICogbmVnb3RpYXRpb24uXG4gKlxuICog4pSA4pSAIE1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMUyAoQ29sZSdzIHJ1bGluZywgMjAyNi0wOS0yNCkg4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVpbHQgb24gYGZlYXQvbWluZC1tYXBwZXItcXVpZXQtaGFuZG9mZmAuIEl0IFJFVkVSU0VTIHRoZSBpbXBsZW1lbnRlcidzXG4gKiBydWxpbmcgb2YgYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0aGF0IG1pbmQtbWFwcGVyIGlzIGEgcHJlc2VuY2Ugc3BlbGxcbiAqIChpdHMgZGFlbW9uIGNvdW50cyBhbiBvcGVuIFNTRSB0YWlsIGFzIHRoZSBhZ2VudCBwcmVzZW50LCBzbyB0aGUgd2luZG93XG4gKiBhbHdheXMgcmUtYXJtZWQgTW9uaXRvcikuIENvbGUncyByZWFzb25pbmc6IG1pbmQtbWFwcGVyIHNlc3Npb25zIGFyZSB1c2VkXG4gKiBsaWtlIHNjcmlwdG9yaXVtJ3MsIGJ1cnN0cyBvZiBhY3Rpdml0eSB3aXRoIGJyZWFrcywgYW5kIGluIGEgYnJlYWsgdGhlIGFnZW50XG4gKiBzaG91bGQgbm90IGJlIHdva2VuIGV2ZXJ5IDMwIG1pbnV0ZXMuIFNvIG1pbmQtbWFwcGVyIHRha2VzIHRoZSBxdWlldCBoYW5kb2ZmXG4gKiB0byBgLS1vbmNlYCwgdGhlIGxvc3QgY29tZS1iYWNrIChgb3BlbiAtLW5vLW9wZW5gKSwgYW5kIGtlZXBzIGl0c1xuICogYC0tc2luY2UgTkBlcG9jaGAgYm9va21hcmsuIFRocmVlIHRoaW5ncyBoYWQgdG8gYmUgc2V0dGxlZCB0byBtYWtlIHRoYXRcbiAqIGhvbmVzdCwgZWFjaCBwaW5uZWQgaW4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3t0YWlsLHByZXNlbmNlfS50ZXN0LnRzYFxuICogYW5kIG11dGF0aW9uLWNvbmZpcm1lZDpcbiAqXG4gKiBNMSDCtyBQUkVTRU5DRSBMSU5HRVJTIEFDUk9TUyBUSEUgR0FQUyAodGhlIGRhZW1vbiwgYHNlcnZlci50c2BcbiAqICAgICAgYGFkanVzdEFnZW50c2ApLiBBIG9uZS1zaG90IGhvbGRzIGFuIFNTRSBjb25uZWN0aW9uLCBzbyBpdCBDT1VOVFMgYXNcbiAqICAgICAgcHJlc2VudCwgd2hpY2ggaXMgdHJ1ZTogdGhlIGFnZW50IHdpbGwgd2FrZSBvbiB0aGUgbmV4dCBldmVudC4gVGhlIGdhcHNcbiAqICAgICAgYXJlIHRoZSBwcm9ibGVtOiB3aW5kb3cg4oaSIHJlLWFybSwgcXVpZXQg4oaSIGAtLW9uY2VgLCBhbmQgYWJvdmUgYWxsXG4gKiAgICAgIGB0YWlsLndva2VgIOKGkiB0aGUgYWdlbnQgaGFuZGxlcyB0aGUgZXZlbnQg4oaSIE1vbml0b3IsIHdoaWNoIGxhc3RzIHRoZVxuICogICAgICBhZ2VudCdzIHdob2xlIHR1cm4uIFJhdywgdGhlIHN1cmZhY2UncyBoZWFkZXIgZG90ICh0aGUgb25seSB0aGluZ1xuICogICAgICBwcmVzZW5jZSBkcml2ZXMgdGhlcmUsIGJlc2lkZXMgdGhlIGRhZW1vbidzIGF1dG8tYHJlY2VpdmVkYCBmbGlwIG9uIGFcbiAqICAgICAgaHVtYW4gbWVzc2FnZSkgcmVhZCBcImNvbm5lY3RlZCDigJQgbm8gYWdlbnQgb24gdGhpcyBwcm9qZWN0XCIgd2hpbGUgdGhlXG4gKiAgICAgIGFnZW50IHdhcyB3b3JraW5nIHRoZSBib2FyZCwgYW5kIGEgbWVzc2FnZSBzZW50IHRoZW4gZ290IG5vXG4gKiAgICAgIGByZWNlaXZlZGAuIFRoZSBkYWVtb24gaGFzIG5vIGlkbGUgY2xvc2UsIHNvIG5vdGhpbmcgZWxzZSByZWFjdHMuIE5vd1xuICogICAgICB0aGUgY291bnQgSE9MRFMgZm9yIGBNSU5EX01BUFBFUl9QUkVTRU5DRV9MSU5HRVJfTVNgICgxNTAgcywgdGhlIHN0YWxsXG4gKiAgICAgIHdpbmRvdydzIGJlYXQpIGFmdGVyIHRoZSBsYXN0IHRhaWwgY2xvc2VzOiBhIHRhaWwgb3BlbmluZyBpbnNpZGUgaXRcbiAqICAgICAgZW1pdHMgbm90aGluZywgYW4gYWdlbnQtb25seSB3cml0ZSAoYC9hY3Rpdml0eWAsIGFuIGFnZW50IGAvc2VuZGApXG4gKiAgICAgIHJlc3RhcnRzIGl0LCBhbmQgc2lsZW5jZSBwYXN0IGl0IGRyb3BzIHRoZSBjb3VudCB0byAwLlxuICogICAgICDimpYgTm90IHRha2VuOiByZS1hcm1pbmcgTW9uaXRvciBCRUZPUkUgaGFuZGxpbmcgYSB3b2tlbiBldmVudCAodGhhdCBpc1xuICogICAgICB0aGUgc2hhcmVkIHJ1bGUsIHdvcmQtZm9yLXdvcmQgaW4gZXZlcnkgc3BlbGwpOyByZWZyZXNoaW5nIG9uIGV2ZXJ5XG4gKiAgICAgIGJvYXJkIHdyaXRlICh0aGUgYnJvd3NlciBQT1NUcyB0aGUgc2FtZSByb3V0ZXMsIHNvIHRoZSBodW1hbidzIG93blxuICogICAgICBjbGlja3Mgd291bGQga2VlcCB0aGUgZG90IGxpdCkuIENvc3Q6IGFuIGFnZW50IHRoYXQgcmVhbGx5IGxlZnQgcmVhZHNcbiAqICAgICAgXCJoZXJlXCIgZm9yIHVwIHRvIDE1MCBzLlxuICogTTIgwrcgYHByZXNlbmNlLmNoYW5nZWRgIElTIE5PVCBDT1VOVEVEIChtaW5kLW1hcHBlcidzIGBjb3VudHNgKS4gSXQgaXMgT05cbiAqICAgICAgVEhFIExPRywgd2l0aCBhbiBpZCwgYW5kIGEgdGFpbCdzIG93biBjb25uZWN0IGVtaXRzIG9uZSBvbnRvIGl0cyBvd25cbiAqICAgICAgc3RyZWFtLCBzbyBjb3VudGVkIGl0IG1hZGUgZXZlcnkgd2luZG93IFwiYWN0aXZlXCIgYW5kIHdvdWxkIHdha2UgZXZlcnlcbiAqICAgICAgYC0tb25jZWAgb24gaXRzZWxmLiBUaGUgbGluZ2VyIHJlbW92ZXMgbW9zdCBvZiB0aGF0IGNodXJuOyBgY291bnRzYFxuICogICAgICByZW1vdmVzIHRoZSByZXN0IChhIGZpcnN0IGFybSwgYW5vdGhlciBhZ2VudCBjb21pbmcgb3IgZ29pbmcpLlxuICogTTMgwrcgQSBERUFEIERBRU1PTiBJUyBMT1NULCBOT1QgVU5SRVNPTFZFRCAobWluZC1tYXBwZXIncyBgcmVzb2x2ZWApLiBJdHNcbiAqICAgICAgZGlzY292ZXJ5IHByb2JlcyB0aGUgZGFlbW9uJ3MgcGlkLCBzbyBhIGtpbGxlZCBkYWVtb24gbWFkZSBgcmVzb2x2ZWBcbiAqICAgICAgYW5zd2VyIG51bGwgYW5kIGFuIHVucmVzb2x2ZWQgdGFpbCByZXRyaWVzIGZvcmV2ZXI6IGEgYC0tb25jZWAgd291bGRcbiAqICAgICAgaGF2ZSBzbGVwdCBmb3IgZ29vZCAoRDEncyBkZWZlY3QpLiBUaGUgdGFpbCBrZWVwcyB0aGUgbGFzdCBVUkwgaXRcbiAqICAgICAgcmVzb2x2ZWQsIHNvIHRoZSBkZWFkIHBvcnQgcmVmdXNlcyBhbmQgYExPU1RfQUZURVJfUkVGVVNBTFNgIGVuZHMgaXRcbiAqICAgICAgd2l0aCBgdGFpbC5sb3N0YCDihpIgYG9wZW4gLS1uby1vcGVuYCwgdGhlbiBhIHRhaWwgd2l0aCBubyBgLS1zaW5jZWAuXG4gKiAgICAgIE1pbmQtbWFwcGVyIGhhcyBubyBzZXNzaW9uIHRvIGNsb3NlLCBzbyBpdCBuZXZlciBwcmludHMgYHRhaWwuY2xvc2VkYC5cbiAqICAgICAgTWVhc3VyZWQgb24gYSByZWFsIGBraWxsIC05YCB1bmRlciBhIGAtLW9uY2VgOiBgdGFpbC5sb3N0YCA3IHMgbGF0ZXIsXG4gKiAgICAgIG5vdCAwLjc1IHMsIGJlY2F1c2UgbWluZC1tYXBwZXIncyBvd24gYmFja29mZiBzdGFydHMgYXQgMSBzICgxICsgMiArIDQpLlxuICogICAgICBNMeKAk00zIHdlcmUgZHJpdmVuIG9uIGEgcmVhbCBkYWVtb24gd2l0aCBhIDQgcyB3aW5kb3c6IGFjdGl2ZSDihpIgd2luZG93LFxuICogICAgICBxdWlldCDihpIgYC0tb25jZWAsIGEgaHVtYW4gbWVzc2FnZSB3b2tlIGl0LCBiYWNrIHRvIE1vbml0b3I7IHByZXNlbmNlXG4gKiAgICAgIG5ldmVyIGRyb3BwZWQgYWNyb3NzIHRoZSBnYXBzLlxuICpcbiAqIOKaliBgLS1vbmNlYCBFTkRTIE9OIFRIRSBGSVJTVCBGUkFNRSwgd2l0aCBubyBkcmFpbi4gQSBidXJzdCBhcnJpdmVzIHNwbGl0OiB0aGVcbiAqICAgZmlyc3QgZXZlbnQgb24gdGhlIG9uZS1zaG90LCB0aGUgcmVzdCBvbiB0aGUgTW9uaXRvciByZS1hcm0sIHdoaWNoIGxvc2VzXG4gKiAgIG5vdGhpbmcgYmVjYXVzZSBvZiB0aGUgYm9va21hcmsuIFRoZSBzcGlrZSBvZmZlcmVkIGEgfjIwMCBtcyBkcmFpbiBhcyBhblxuICogICBvcHRpb24sIG5vdCBhIHJlcXVpcmVtZW50OyBub3QgdGFrZW4sIGJlY2F1c2UgaXQgYWRkcyBhIHRpbWVyIHRvIHRoZVxuICogICBleGl0IHBhdGggd2hvc2UgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gbWFrZSBpbXBvc3NpYmxlLlxuICog4pqWIFRIRSBMSU5FJ1MgYGNvbW1hbmRgIElTIENPTVBMRVRFIEJVVCBGT1IgVEhFIExBVU5DSEVSOiBwaW5uZWQgdG8gdGhlXG4gKiAgIHNlc3Npb24gdGhpcyB0YWlsIHdhcyBib3VuZCB0bywgd2l0aCBpdHMgc2NvcGUgZmxhZ3MuIFRoZSBza2lsbHMgbmFtZSB0aGVcbiAqICAgcnVsZSBvbmNlLCBsYXVuY2hlciBmb3JtIGluY2x1ZGVkOyB0aGUgbGluZSBjYXJyaWVzIHRoZSBzcGVjaWZpY3MuXG4gKlxuICogUzEgwrcgV0hPIENMT1NFRCBJVCBSSURFUyBUSEUgTElORSAoc2NyaXB0b3JpdW0ncyBFbmQgc2Vzc2lvbiwgMjAyNi0xMC0wMSkuXG4gKiAgICAgIEEgc3BlbGwgd2hvc2UgYGNsb3NlZGAgZnJhbWUgc2F5cyB3aG8gZW5kZWQgdGhlIHNlc3Npb24gcGFzc2VzXG4gKiAgICAgIGBjbG9zZWRCeWAsIGFuZCBgdGFpbC5jbG9zZWRgIGNhcnJpZXMgaXQgYXMgYGJ5YC4gYGJ5OiBcImh1bWFuXCJgIGNoYW5nZXNcbiAqICAgICAgdGhlIGhpbnQ6IHRoZSBodW1hbiBlbmRlZCBpdCBPTiBQVVJQT1NFLCBzbyB0aGUgYWdlbnQgc3RvcHMgYW5kIGRvZXMgbm90XG4gKiAgICAgIHJlb3BlbiB1bmxlc3MgYXNrZWQg4oCUIHRoZSB3YXkgYmFjayBpcyBzdGlsbCBuYW1lZCwgY29uZGl0aW9uZWQgb24gdGhhdC5cbiAqICAgICAgVGhlIGFnZW50IHJvdXRlcyBvbiBgYnlgLCBuZXZlciBvbiB0aGUgaGludCdzIHByb3NlLiBBIHJlLWFybSBhZnRlclxuICogICAgICB0aGUgZW5kIHNlZXMgbm8gY2xvc2luZyBmcmFtZSAoRDEncyBwYXRoKSwgc28gdGhlIHNwZWxsIGFsc28gcGFzc2VzXG4gKiAgICAgIGBnb25lQnlgLCByZWFkIGZyb20gd2hlcmUgdGhlIGZhY3Qgb3V0bGl2ZXMgdGhlIGRhZW1vbjsgd2l0aG91dCBpdCB0aGVcbiAqICAgICAgcmUtYXJtZWQgbGluZSBkcm9wcGVkIGBieWAgYW5kIGludml0ZWQgdGhlIHJlb3BlbiAodmVyaWZpZXIsIDIwMjYtMTAtMDEpLlxuICogICAgICDimpYgT3B0aW9ucyBub3QgdGFrZW46IGEgc3BlbGwtc2lkZSByZXdyaXRlIG9mIHRoZSBwcmludGVkIGxpbmUgKGEgc2Vjb25kXG4gKiAgICAgIHdyaXRlciBvZiB0aGUgc2FtZSBsaW5lKSwgb3IgYSBzcGVsbC1zdXBwbGllZCBoaW50IChlYWNoIHNwZWxsIHdvdWxkXG4gKiAgICAgIHdvcmQgXCJvbiBwdXJwb3NlXCIgaXRzIG93biB3YXkpLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBUaGUgb25lIHNlbnRlbmNlIGV2ZXJ5IGB0YWlsYCdzIGhlbHAgY2Fycmllcywgc28gYSBodW1hbiB3YXRjaGluZyBpbiBhXG4gKiAgdGVybWluYWwgZmluZHMgdGhlIGVzY2FwZSBoYXRjaCB3aGVyZSB0aGV5IGxvb2sgKEQ0KS4gV29yZGVkIG9uY2UgaGVyZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfSEVMUCA9XG4gIFwiZW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyAzMC1taW51dGUgY2FwIHdpdGggYSBsaW5lIG5hbWluZyB0aGUgbmV4dCBhY3Q7IGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCBrZWVwcyBpdCBvcGVuIHdpdGggU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBcIjtcblxuLyoqIENvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3cgdGhhdCBtYWtlIHRoZSBkYWVtb24gXCJsb3N0XCIgKHNlZSBBMikuIFRocmVlXG4gKiAgc3BhbiBhYm91dCAwLjc1IHMgdW5kZXIgdGhlIGtpdCdzIGRlZmF1bHQgYmFja29mZiAoMjUwICsgNTAwIG1zIGJldHdlZW5cbiAqICB0aGVtKTogYSBsaXZlIGRhZW1vbiBuZXZlciByZWZ1c2VzIGl0cyBvd24gcG9ydCwgYW5kIHRoZSB0d28gZXh0cmEgYXR0ZW1wdHNcbiAqICBvbmx5IGJ1eSB0b2xlcmFuY2UgZm9yIGEgcmVzdGFydCB0aGF0IHJlYmluZHMgdGhlIHNhbWUgcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBMT1NUX0FGVEVSX1JFRlVTQUxTID0gMztcblxuLyoqIFRoZSB3aW5kb3cgbGVuZ3RoOiB0aGUgZW52IHZhbHVlIHdoZW4gaXQgaXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZWxzZSB0aGVcbiAqICBkZWZhdWx0LiBgMGAgbWVhbnMgbm8gd2luZG93LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXaW5kb3dNcyhyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcudHJpbSgpID09PSBcIlwiKSByZXR1cm4gREVGQVVMVF9XSU5ET1dfTVM7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIobikgJiYgbiA+PSAwID8gbiA6IERFRkFVTFRfV0lORE9XX01TO1xufVxuXG5leHBvcnQgdHlwZSBUYWlsTW9kZSA9IFwid2F0Y2hcIiB8IFwib25jZVwiO1xuXG4vKiogSG93IGEgdGFpbCBlbmRlZC4gYHdpbmRvd2AgaXMgb3VyIG93biBkZWFkbGluZSwgYGV2ZW50YCBpcyBhIGAtLW9uY2VgJ3NcbiAqICBmaXJzdCBmcmFtZSwgYGNsb3NlZGAgaXMgdGhlIHNlc3Npb24gZW5kaW5nIChhIGBjbG9zZWRgIGZyYW1lIG9yIHRoZSBwaW5uZWRcbiAqICBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcpLCBgbG9zdGAgaXMgdGhlIGRhZW1vbiByZWZ1c2luZyBjb25uZWN0aW9ucyxcbiAqICBhbmQgYHN0b3BwZWRgIGlzIGEgc2lnbmFsLCBhIGNhbGxlcidzIGFib3J0IG9yIGEgY2xvc2VkIHN0ZG91dC4gKi9cbmV4cG9ydCB0eXBlIFRhaWxFbmQgPSBcIndpbmRvd1wiIHwgXCJldmVudFwiIHwgXCJjbG9zZWRcIiB8IFwibG9zdFwiIHwgXCJzdG9wcGVkXCI7XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZJbnB1dCA9IHtcbiAgLyoqIFRoZSBzcGVsbCB3aG9zZSB0YWlsIHRoaXMgaXMsIHNvIHRoZSBhZ2VudCBrbm93cyB3aG9zZSBsYXVuY2hlciBydW5zIGl0LiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBlbmQ6IFRhaWxFbmQ7XG4gIC8qKiBXaG8gZW5kZWQgYSBgY2xvc2VkYCBzZXNzaW9uLCB3aGVuIGl0cyBjbG9zaW5nIGZyYW1lIHNhaWQgKFMxKS4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogVGhlIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaC4gKi9cbiAgZXBvY2g/OiBzdHJpbmc7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiBgZXBvY2hgIGlzIHRoZVxuICAgKiAgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZTogYSBzcGVsbCB3aG9zZVxuICAgKiAgYC0tc2luY2VgIHBhcnNlcyBgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSBwcmludHMgaXQuICovXG4gIHRhaWw6IChvOiB7IHNpbmNlOiBudW1iZXI7IG9uY2U6IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIC8qKiBXaG9zZSBsYXVuY2hlciBydW5zIGBjb21tYW5kYC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZXZlbnRzOiBudW1iZXI7XG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogYHRhaWwuY2xvc2VkYCBvbmx5OiB3aG8gZW5kZWQgdGhlIHNlc3Npb24sIHdoZW4gdGhlIHNwZWxsIHNheXMgKFMxKS4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIC8qKiBgbW9uaXRvcmA6IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggdGhlIGxhdW5jaGVyICsgYGNvbW1hbmRgLlxuICAgKiAgYGJhY2tncm91bmRgOiBydW4gdGhlIGxhdW5jaGVyICsgYGNvbW1hbmRgIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2suXG4gICAqICBgc3RvcGA6IG5vdGhpbmcgdG8gd2F0Y2g7IGBjb21tYW5kYCBpcyBob3cgdG8gY29tZSBiYWNrLCBpZiB3YW50ZWQuICovXG4gIG5leHQ6IFwibW9uaXRvclwiIHwgXCJiYWNrZ3JvdW5kXCIgfCBcInN0b3BcIjtcbiAgLyoqIFRoZSB2ZXJiIGFuZCBpdHMgYXJndW1lbnRzIE9OTFkg4oCUIG5vIGxhdW5jaGVyLCBubyBwYXRoLiBUaGUgYWdlbnQgcnVuc1xuICAgKiAgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+YC4gKi9cbiAgY29tbWFuZDogc3RyaW5nO1xuICBoaW50OiBzdHJpbmc7XG59O1xuXG4vKiogSG93IHRoZSBhZ2VudCBydW5zIGEgcHJpbnRlZCBgY29tbWFuZGA6IHdpdGggSVRTIE9XTiBsYXVuY2hlciwgbmV2ZXIgYSBwYXRoXG4gKiAgdGhpcyBwcm9jZXNzIG5hbWVzICh0aGUgcnVsaW5nIG9uIHRoZSB2ZXJzaW9uZWQgcGx1Z2luIHBhdGgsIGluIHRoZSBoZWFkZXIpLiAqL1xuZXhwb3J0IGNvbnN0IFJVTl9XSVRIX0xBVU5DSEVSID0gXCJidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPlwiO1xuXG4vKiogVGhlIGNvbWUtYmFjayBoaW50LCB3aXRoIGhvdyB0byBSRVNVTUUgYWZ0ZXIgY29taW5nIGJhY2sgKEQyKTogYSByZXN0b3JlZFxuICogIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIG1lYW5zIG5vdGhpbmcgdGhlcmUuICovXG5jb25zdCBDT01FX0JBQ0sgPSAod2h5OiBzdHJpbmcsIGxlYWQgPSBcIlRvIGJyaW5nIGl0IGJhY2tcIikgPT5cbiAgYCR7d2h5fSAke2xlYWR9LCBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn07IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBzcGVsbDogcy5zcGVsbCwgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgLi4uKHMuYnkgPyB7IGJ5OiBzLmJ5IH0gOiB7fSksXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDpcbiAgICAgICAgICBzLmJ5ID09PSBcImh1bWFuXCJcbiAgICAgICAgICAgID8gQ09NRV9CQUNLKFxuICAgICAgICAgICAgICAgIFwidGhlIGh1bWFuIGVuZGVkIHRoaXMgc2Vzc2lvbiBvbiBwdXJwb3NlOyBzdG9wIHdhdGNoaW5nLCBhbmQgZG8gbm90IHJlb3BlbiBpdCB1bmxlc3MgdGhleSBhc2suXCIsXG4gICAgICAgICAgICAgICAgXCJJZiB0aGV5IGFza1wiLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICA6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoe1xuICAgICAgICAgICAgc2luY2U6IHMuY3Vyc29yLFxuICAgICAgICAgICAgb25jZTogZmFsc2UsXG4gICAgICAgICAgICAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoaW50OiBgdGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYG5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9IGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2sgKHJ1bl9pbl9iYWNrZ3JvdW5kKSDigJQgaXQgZXhpdHMgb24gdGhlIG5leHQgZXZlbnRgLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQgYWZ0ZXIgdGhlIGFnZW50J3Mgb3duIGxhdW5jaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoZWxsUXVvdGUoYXJnOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bQS1aYS16MC05X0AlKz06LC4vLV0rJC8udGVzdChhcmcpID8gYXJnIDogYCcke2FyZy5yZXBsYWNlQWxsKFwiJ1wiLCBgJ1xcXFwnJ2ApfSdgO1xufVxuXG4vKipcbiAqIFJlYWQgYSBgLS1zaW5jZWAgdmFsdWU6IGFuIGV2ZW50IGlkLCBvcHRpb25hbGx5IGNhcnJ5aW5nIHRoZSBlcG9jaCBvZiB0aGVcbiAqIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgRDIpLiBOdWxsIHdoZW4gdGhlIGlkIGlzIG5vdCBhbiBpbnRlZ2VyLlxuICogRm9yIHRoZSBzcGVsbHMgd2hvc2UgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaDsgdGhlIHJlc3QgdGFrZSBhIHBsYWluIGlkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCb29rbWFyayh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGF0ID0gdG9rZW4uaW5kZXhPZihcIkBcIik7XG4gIGNvbnN0IGlkID0gYXQgPT09IC0xID8gdG9rZW4gOiB0b2tlbi5zbGljZSgwLCBhdCk7XG4gIGNvbnN0IGVwb2NoID0gYXQgPT09IC0xID8gXCJcIiA6IHRva2VuLnNsaWNlKGF0ICsgMSk7XG4gIGlmICghL14tP1xcZCskLy50ZXN0KGlkLnRyaW0oKSkpIHJldHVybiBudWxsO1xuICBpZiAoYXQgIT09IC0xICYmIGVwb2NoID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc2luY2U6IE51bWJlci5wYXJzZUludChpZCwgMTApLCAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSkgfTtcbn1cblxuLyoqXG4gKiBFdmVyeSB0YWlsJ3MgYC0tc2luY2VgLCByZWFkIHRoZSBzYW1lIHdheTogYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cywgb3IgYVxuICogcmVmdXNhbCB0aGF0IE5BTUVTIHRoZSBhY2NlcHRlZCBmb3Jtcy4g4puUIE5FVkVSIEEgU0lMRU5UIE1JU1BBUlNFLiBUaGUgZm91clxuICogbm8tZXBvY2ggc3BlbGxzIHVzZWQgYHBhcnNlSW50YCwgd2hpY2ggcmVhZCBhbiBlcG9jaCBib29rbWFyayAoYDRAZTFgLCBmcm9tXG4gKiBhIGhhbmRvZmYgbGluZSBhbm90aGVyIHZlcnNpb24gb3Igc3BlbGwgcHJpbnRlZCkgYXMgYDRgIGFuZCBkcm9wcGVkIHRoZVxuICogcmVzdCB3aXRob3V0IGEgd29yZDsgbWluZC1tYXBwZXIgcmVhZCBqdW5rIGFzIDAgYW5kIGFzdHJvbGFiZSBhcyAtMSwgYm90aCBhXG4gKiB3aG9sZSByZXBsYXkuIEEgcHJpbnRlZCBjb21tYW5kIG91dGxpdmVzIHRoZSBDTEkgdGhhdCBwcmludGVkIGl0ICh0aGVcbiAqIGxhdW5jaGVyLWZyZWUgcnVsaW5nLCBpbiB0aGUgaGVhZGVyKSwgc28gdGhlIHBhcnNlciBpcyB3aGVyZSBhbiBvbGRlciBvclxuICogbmV3ZXIgZm9ybSBtdXN0IHNheSB3aGF0IHdlbnQgd3JvbmcuXG4gKlxuICogYGVwb2NoYDogd2hldGhlciB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBvbmUgKHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUsXG4gKiBtaW5kLW1hcHBlcikuIGBtaW5gOiB0aGUgc21hbGxlc3QgaWQgYWNjZXB0ZWQgKGdyYXBldmluZSB0YWtlcyBubyAtMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkU2luY2UoXG4gIHRva2VuOiBzdHJpbmcsXG4gIG86IHsgZXBvY2g6IGJvb2xlYW47IG1pbj86IG51bWJlciB9LFxuKTogeyBvazogdHJ1ZTsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IHsgb2s6IGZhbHNlOyBtZXNzYWdlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1pbiA9IG8ubWluID8/IC0xO1xuICBjb25zdCBiID0gcGFyc2VCb29rbWFyayh0b2tlbik7XG4gIGlmIChiICE9PSBudWxsICYmIGIuc2luY2UgPj0gbWluICYmIChiLmVwb2NoID09PSB1bmRlZmluZWQgfHwgby5lcG9jaCkpXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNpbmNlOiBiLnNpbmNlLCAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSB9O1xuICBjb25zdCBpZCA9XG4gICAgbWluIDwgMFxuICAgICAgPyBcImFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyOyAtLXNpbmNlPS0xIGZvciBldmVyeXRoaW5nKVwiXG4gICAgICA6IGBhbiBldmVudCBpZCAoYW4gaW50ZWdlciwgJHttaW59IG9yIG1vcmUpYDtcbiAgY29uc3QgZm9ybXMgPSBvLmVwb2NoID8gYCR7aWR9LCBvciA8aWQ+QDxlcG9jaD4gYXMgYSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0YCA6IGlkO1xuICBjb25zdCB3aHkgPVxuICAgICFvLmVwb2NoICYmIHRva2VuLmluY2x1ZGVzKFwiQFwiKVxuICAgICAgPyBgOyB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBubyBlcG9jaCwgc28gcGFzcyB0aGUgaWQgd2l0aG91dCB0aGUgXCJA4oCmXCIgcGFydGBcbiAgICAgIDogXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgbWVzc2FnZTogYC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cyDigJQgZ2l2ZSAke2Zvcm1zfSR7d2h5fWAsXG4gIH07XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogVGhlIHJlLWFybSBmb3IgYSBzcGVsbCB3aG9zZSB0YWlsIGlzIGA8cHJlZml44oCmPiAtLXNpbmNlIE5bQGVwb2NoXSBbLS1vbmNlXWAuXG4gKiAgUGFzcyBgZXBvY2hgIG9ubHkgZm9yIGEgc3BlbGwgd2hvc2UgYC0tc2luY2VgIHBhcnNlcyBpdCAoYHBhcnNlQm9va21hcmtgKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChcbiAgcHJlZml4OiByZWFkb25seSBzdHJpbmdbXSxcbiAgc2luY2U6IG51bWJlcixcbiAgb25jZTogYm9vbGVhbixcbiAgZXBvY2g/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICAvLyDimqAgQSBuZWdhdGl2ZSBib29rbWFyayAobm90aGluZyBzZWVuIHlldCkgaXMgc3BlbGxlZCBgLS1zaW5jZT0tMWA6IHRoZVxuICAvLyBwYXJzZXJzIHJlYWQgYSBiYXJlIGAtMWAgYWZ0ZXIgYSBmbGFnIGFzIGFub3RoZXIgZmxhZyBhbmQgcmVmdXNlIGl0LlxuICBjb25zdCBtYXJrID0gZXBvY2ggPyBgJHtzaW5jZX1AJHtlcG9jaH1gIDogU3RyaW5nKHNpbmNlKTtcbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHttYXJrfWBdIDogW1wiLS1zaW5jZVwiLCBtYXJrXTtcbiAgcmV0dXJuIGNvbW1hbmRMaW5lKFsuLi5wcmVmaXgsIC4uLmF0LCAuLi4ob25jZSA/IFtcIi0tb25jZVwiXSA6IFtdKV0pO1xufVxuXG5leHBvcnQgdHlwZSBIYW5kb2ZmT3B0aW9uczxFdj4gPSB7XG4gIC8qKiBUaGUgc3BlbGwncyBuYW1lLCBjYXJyaWVkIG9uIHRoZSBsaW5lICh3aG9zZSBsYXVuY2hlciBydW5zIGl0KS4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIFdobyB0aGUgY2xvc2luZyBmcmFtZSBzYXlzIGVuZGVkIHRoZSBzZXNzaW9uIChTMSk7IGNhcnJpZWQgb24gYHRhaWwuY2xvc2VkYC4gKi9cbiAgY2xvc2VkQnk/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBXaG8gZW5kZWQgYSBzZXNzaW9uIGZvdW5kIEdPTkUgKEQxOiByZS1hcm1lZCBhZnRlciBpdCBjbG9zZWQsIHNvIG5vXG4gICAqICBjbG9zaW5nIGZyYW1lIGlzIGV2ZXIgc2VlbiksIHJlYWQgZnJvbSB3aGVyZXZlciB0aGUgc3BlbGwga2VlcHMgaXQg4oCUIGFcbiAgICogIG1hbmlmZXN0IHRoYXQgb3V0bGl2ZXMgdGhlIGRhZW1vbi4gQ2FycmllZCBvbiBgdGFpbC5jbG9zZWRgIGFzIGBieWAsIHNvXG4gICAqICB0aGUgbGluZSBzYXlzIHdoYXQgdGhlIGxpdmUgcGF0aCdzIGBjbG9zZWRCeWAgd291bGQgaGF2ZSAoUzEpLiAqL1xuICBnb25lQnk/OiAoKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbW1hbmRzOiBIYW5kb2ZmQ29tbWFuZHM7XG59O1xuXG4vKipcbiAqIFJ1biBgdGFpbEV2ZW50c2Agd2l0aCB0aGUgaGFuZG9mZjogdGhlIHdpbmRvdywgYC0tb25jZWAsIHRoZSBsb3N0IHJ1bGUsIGFuZFxuICogdGhlIGZpbmFsIGxpbmUuIFJldHVybnMgdGhlIGV4aXQgY29kZSwgbGlrZSBgdGFpbEV2ZW50c2AsIGFuZCBuZXZlciBleGl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxXaXRoSGFuZG9mZjxFdj4oXG4gIHRhaWw6IFRhaWxPcHRpb25zPEV2PixcbiAgaDogSGFuZG9mZk9wdGlvbnM8RXY+LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gdGFpbC5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IHdpbmRvd01zID0gaC53aW5kb3dNcyA/PyByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pO1xuICBjb25zdCBjb3VudHMgPSBoLmNvdW50cyA/PyAoKCkgPT4gdHJ1ZSk7XG4gIGNvbnN0IGVuZE9uTG9zdCA9ICFoLnByZXNlbmNlO1xuXG4gIGNvbnN0IGFjID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gYWMuYWJvcnQoKTtcbiAgdGFpbC5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKHRhaWwuc2lnbmFsPy5hYm9ydGVkKSBhYy5hYm9ydCgpO1xuXG4gIGxldCBldmVudHMgPSAwO1xuICBsZXQgY3Vyc29yID0gdGFpbC5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB0YWlsLnNpbmNlRXBvY2g7XG4gIGxldCBmcmFtZUhhc0lkID0gZmFsc2U7XG4gIC8qKiBBMyArIEQzOiBhIGZyYW1lIGNvdW50cywgYW5kIHdha2VzIGEgYC0tb25jZWAsIG9ubHkgd2hlbiBpdCBpcyBPTiBUSEVcbiAgICogIExPRyDigJQgaXQgY2FycmllcyBhIGxvZyBpZCDigJQgYW5kIHRoZSBzcGVsbCdzIG93biBgY291bnRzYCBhZ3JlZXMuIEEgdGFiJ3NcbiAgICogIGlkLWxlc3MgYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGAgcGluZyBpcyBub3Qgb24gdGhlIGxvZy4gKi9cbiAgY29uc3QgaXNMb2dGcmFtZSA9IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gZnJhbWVIYXNJZCAmJiBjb3VudHMoZXYsIGZyYW1lKTtcbiAgbGV0IGVuZDogVGFpbEVuZCB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkQnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlZnVzYWxzID0gMDtcblxuICBjb25zdCBmaW5pc2ggPSAoZTogVGFpbEVuZCkgPT4ge1xuICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IGU7XG4gICAgYWMuYWJvcnQoKTtcbiAgfTtcbiAgY29uc3QgdGltZXIgPVxuICAgIGgubW9kZSA9PT0gXCJ3YXRjaFwiICYmIHdpbmRvd01zID4gMCA/IHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKFwid2luZG93XCIpLCB3aW5kb3dNcykgOiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29kZSA9IGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICAgIC4uLnRhaWwsXG4gICAgICBzaWduYWw6IGFjLnNpZ25hbCxcbiAgICAgIC8vIEQyJ3MgbmV0LiBPbiBmb3IgZXZlcnkgc3BlbGw6IGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvclxuICAgICAgLy8gbWVhbnMgYSB3aG9sZSByZXBsYXkgb24gdGhlIGtpdCdzIGxvZywgYW5kIG9uIGdyYXBldmluZSdzIGR1cmFibGUgbG9nXG4gICAgICAvLyBpdCBoYXBwZW5zIG9ubHkgd2hlbiBgLS1sYXN0YCByZWFjaGVzIGJlbG93IGAtLXNpbmNlYCwgd2hlcmVcbiAgICAgIC8vIHJlLXJlYWRpbmcgdGhlIGN1cnNvciBmcm9tIHRoZSBmcmFtZXMgaXMgdGhlIG1vcmUgY29ycmVjdCBhbnN3ZXIuXG4gICAgICByZXN0YXJ0T25SZXBsYXk6IHRydWUsXG4gICAgICAvLyBEMzogcmVtZW1iZXIgd2hldGhlciBUSElTIGZyYW1lIGNhcnJpZXMgYSBsb2cgaWQuIGB0YWlsRXZlbnRzYCByZWFkc1xuICAgICAgLy8gdGhlIGN1cnNvciBvbmNlIHBlciBmcmFtZSwgYmVmb3JlIGBhY2NlcHRgLCBgdGVybWluYWxgIGFuZCBgcmVuZGVyYC5cbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgY29uc3QgbiA9IHRhaWwuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgIGZyYW1lSGFzSWQgPSB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobik7XG4gICAgICAgIHJldHVybiBuO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBEMTogYSB0YWlsIHRoYXQgZ2l2ZXMgdXAgb24gZmluZGluZyBpdHMgc2Vzc2lvbiBpcyB3YXRjaGluZyBhXG4gICAgICAgIC8vIHNlc3Npb24gdGhhdCBpcyBnb25lIOKAlCB3aGV0aGVyIHRoaXMgcHJvY2VzcyBldmVyIHJlYWNoZWQgaXQgKGl0c1xuICAgICAgICAvLyBwb2ludGVyIHZhbmlzaGVkKSBvciBpdCB3YXMgcmUtYXJtZWQgYXQgb25lIHRoYXQgY2xvc2VkIGluIHRoZSBnYXAuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBlbmQgPT09IG51bGwpIHtcbiAgICAgICAgICBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICAgIGNsb3NlZEJ5ID0gaC5nb25lQnk/LigpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIHtcbiAgICAgICAgICAgIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICAgIGlmIChlbmQgPT09IFwiY2xvc2VkXCIpIGNsb3NlZEJ5ID0gaC5jbG9zZWRCeT8uKGV2KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGgubW9kZSA9PT0gXCJvbmNlXCIgJiYgYWNjZXB0ZWQgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgcmV0dXJuIHRhaWwub25Db21tZW50Py4odGV4dCkgPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLm9uRGlzY29ubmVjdD8uKGluZm8pID8/IG51bGw7XG4gICAgICAgIGlmIChpbmZvLmNhdXNlID09PSBcImNvbm5lY3QtZmFpbGVkXCIpIHtcbiAgICAgICAgICByZWZ1c2FscyArPSAxO1xuICAgICAgICAgIGlmIChlbmRPbkxvc3QgJiYgcmVmdXNhbHMgPj0gTE9TVF9BRlRFUl9SRUZVU0FMUykgZmluaXNoKFwibG9zdFwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUaGUgZGFlbW9uIGFuc3dlcmVkIChhIHN0YXR1cywgb3IgYSBzdHJlYW0gdGhhdCBvcGVuZWQgYW5kIHRoZW5cbiAgICAgICAgICAvLyBlbmRlZCk6IGl0IGlzIGFsaXZlLCBzbyB0aGUgcmVmdXNhbHMgd2VyZSBub3QgaW4gYSByb3cuXG4gICAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIG9uRW5kOiAocykgPT4ge1xuICAgICAgICBjdXJzb3IgPSBzLmN1cnNvcjtcbiAgICAgICAgZXBvY2ggPSBzLmVwb2NoID8/IHVuZGVmaW5lZDtcbiAgICAgICAgdGFpbC5vbkVuZD8uKHMpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaW5lID0gaGFuZG9mZihcbiAgICAgIHtcbiAgICAgICAgZW5kOiBlbmQgPz8gXCJzdG9wcGVkXCIsXG4gICAgICAgIC4uLihjbG9zZWRCeSA/IHsgYnk6IGNsb3NlZEJ5IH0gOiB7fSksXG4gICAgICAgIG1vZGU6IGgubW9kZSxcbiAgICAgICAgZXZlbnRzLFxuICAgICAgICBjdXJzb3IsXG4gICAgICAgIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgcHJlc2VuY2U6IGgucHJlc2VuY2UsXG4gICAgICAgIHNwZWxsOiBoLnNwZWxsLFxuICAgICAgfSxcbiAgICAgIGguY29tbWFuZHMsXG4gICAgKTtcbiAgICBpZiAobGluZSAhPT0gbnVsbCkgb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGxpbmUpfVxcbmApO1xuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0YWlsLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBHcmFwZXZpbmUncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIG9mIHRoZSBzcGVsbCwgYW5kIFRIRSBPTkUgUExBQ0UgVEhFIEVOViBJUyBSRUFELlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgVEhFIFNFQU0sIEFORCBGT1IgR1JBUEVWSU5FIFRIRSBTRUFNIElTIFJFQUwg4oCUIHRoZSBmaXJzdCB0aW1lXG4gKiBpbiBmb3VyIHBvcnRzIChwbGF5Ym9vayBCOCwgZW50cnktYmxvY2sgcXVlc3Rpb24gMykuIEJlZm9yZSBQaGFzZSA2IHRoZVxuICogaGVhcnRiZWF0IHdhcyBhIExJVEVSQUwgYDMwMDBgIGluc2lkZSBgZGFlbW9uLnRzYCdzIFNTRSBzdHJlYW0sIGBpZGxlVGltZW91dDpcbiAqIDI1NWAgd2FzIGEgc2Vjb25kIGxpdGVyYWwgdGVuIGxpbmVzIGF3YXkgd2l0aCB0aGUgcmVsYXRpb25zaGlwIHdyaXR0ZW4gb25seSBpblxuICogcHJvc2UsIGFuZCBgY2xpLnRzYCdzIHRhaWwgaGFkIE5PIHdhdGNoZG9nIGF0IGFsbCDigJQgaXQgYmxvY2tlZCBvblxuICogYHJlYWRlci5yZWFkKClgIGZvcmV2ZXIsIHdoaWNoIGlzIHRoZSBmYWlsdXJlIHRoZSBraXQncyB3YXRjaGRvZyBleGlzdHMgdG9cbiAqIGVuZC4gTmVpdGhlciBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uXG4gKiB3b3VsZCBkcmFnIHRoZSB3aG9sZSBzZXJ2ZXIgZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBBIG1vZHVsZSB3aXRoIG5vIGltcG9ydHNcbiAqIGJ1dCB0aGUga2l0J3MgZGVyaXZhdGlvbnMgaGFzIG5vIHN1Y2ggZ3JhcGgsIHNvIGJvdGggaGFsdmVzIGltcG9ydCB0aGlzIG9uZS5cbiAqIEEgdmFsdWUgdGhhdCBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBHUkFQRVZJTkUnUyBPV04gSEVBUlRCRUFULCBORVZFUiBDT1BJRURcbiAqIEZST00gQSBTSUJMSU5HLioqIFRoaXMgaXMgdGhlIHJ1bGUgYXN0cm9sYWJlIHBhaWQgZm9yOiBhIGhhcmQtY29kZWQgNDUgc1xuICogd2F0Y2hkb2cgYWdhaW5zdCBhbiBlbnYtdHVuZWQgaGVhcnRiZWF0IHByb2R1Y2VkIHJlY29ubmVjdHMgYXQgKzQ3LjQgcyxcbiAqICs5Mi42IHMgYW5kICsxMzcuOSBzIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24sIGhhcm1sZXNzIG9ubHkgYmVjYXVzZVxuICogYW4gdW5yZWxhdGVkIHRoaXJkIGNvbnN0YW50IGFic29yYmVkIHRoZSBjaHVybi4g4pqgIEdyYXBldmluZSBpcyB0aGUgc3BlbGwgdGhhdFxuICogbWFrZXMgdGhlIHBvaW50IHNoYXJwZXN0OiBpdCBiZWF0cyBhdCAqKjMgcyoqLCBhIGZpZnRoIG9mIHRoZSBob3VzZSBkZWZhdWx0LFxuICogc28gYSBjb3BpZWQgNDUsMDAwIHdvdWxkIHRvbGVyYXRlIEZJRlRFRU4gbWlzc2VkIGJlYXRzIHdoZXJlIGV2ZXJ5IHNpYmxpbmdcbiAqIHRvbGVyYXRlcyB0aHJlZS4gYHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUylgIGNhbm5vdCBkcmlmdCBmcm9tIHRoZSBiZWF0IGl0XG4gKiBpcyB3YXRjaGluZywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcy5cbiAqXG4gKiDim5QgKipBTkQgXCJXSEFURVZFUiBUSEUgQkVBVCBCRUNPTUVTXCIgSVMgV0hZIFRIRSBFTlYgSVMgUkVTT0xWRUQgSEVSRSBBTkRcbiAqIE5PV0hFUkUgRUxTRSAoRDc1KS4gVEhFIFBPUlQgUkUtQ1JFQVRFRCBBU1RST0xBQkUnUyBERUZFQ1QgSU4gVEhJUyBGSUxFLioqXG4gKiBDaGFwdGVyIDIgc2hpcHBlZCBgSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMocHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0hFQVJUQkVBVF9NUyxcbiAqIOKApilgIGF0IGBkYWVtb24udHM6MTEyYCB3aGlsZSB0aGlzIGZpbGUga2VwdCBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWBcbiAqIGFnYWluc3QgdGhlIExJVEVSQUwgMywwMDA6IHRoZSBkYWVtb24ncyBiZWF0IHdhcyB0dW5hYmxlIGFuZCB0aGUgQ0xJJ3NcbiAqIHdhdGNoZG9nIHdhcyBub3QsIHNvICoqYW55IHZhbHVlIGFib3ZlIDMsMDAwIGJyb2tlIGV2ZXJ5IHRhaWwuKiogTUVBU1VSRUQgYXRcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTIwMDAwYCBhZ2FpbnN0IGEgaGVhbHRoeSBkYWVtb24sIGJlZm9yZSB0aGUgcmVwYWlyOiBhXG4gKiByZWFsIGBjbGkudHMgdGFpbGAgcmUtc3Vic2NyaWJlZCAqKjQgdGltZXMgaW4gMzAgcyoqICh+OSBzIGFwYXJ0LCBpdHMgd2F0Y2hkb2dcbiAqIGZpcmluZyBiZWZvcmUgYSBzaW5nbGUgMjAgcyBiZWF0IGNvdWxkIGxhbmQg4oCUICoqMCBrZWVwYWxpdmVzIGFycml2ZWQqKiksIGFuZFxuICogYC9jaGFubmVscy93ZC9zdWJzY3JpYmVyc2AgcmVwb3J0ZWQgYGNvdW50OiAyLCBjb25uZWN0aW9uczogMiwgbmFtZWQ6IDJgIGZvclxuICogKipvbmUqKiBsaXZlIHRhaWwsIGJlY2F1c2UgdGhlIGFiYW5kb25lZCBzdHJlYW1zIGFyZSBub3QgcmVhcGVkIHVudGlsIHRoZVxuICogbm93LTIwIHMgYmVhdCBmYWlscyB0byBlbnF1ZXVlLiBUaGF0IGlzIHRoZSBhc3Ryb2xhYmUgc2NhciB0d28gcGFyYWdyYXBocyB1cCxcbiAqIHJlLWNyZWF0ZWQgaW5zaWRlIHRoZSBmaWxlIHRoYXQgZG9jdW1lbnRzIGl0LiAqKk9uZSBoYWxmIG9mIHRoZSBwYWlyIHR1bmFibGVcbiAqIGFuZCB0aGUgb3RoZXIgYSBjb25zdGFudCBJUyB0aGUgZGVmZWN0Kiog4oCUIHRoZSBkZXJpdmF0aW9uIG9ubHkgaG9sZHMgaWYgaXRcbiAqIGRlcml2ZXMgZnJvbSB0aGUgdmFsdWUgdGhhdCBhY3R1YWxseSBzaGlwcGVkLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqIGBwcm9jZXNzLmVudmAgaXMgbm90IHN1Y2ggYW4gaW1wb3J0OiBpdCBpcyBhbWJpZW50IGluIGJvdGggaGFsdmVzLCB3aGljaCBpc1xuICogZXhhY3RseSB3aHkgdGhpcyBmaWxlIOKAlCBhbmQgbm90IGBkYWVtb24udHNgIOKAlCBjYW4gaG9sZCB0aGUgcmVzb2x1dGlvbi4gKFRoaXNcbiAqIGlzIGJvdW50eSdzIHNoYXBlLCB1bmNoYW5nZWQ6IGBzcmMvYm91bnR5L2JhY2tlbmQvaGVhcnRiZWF0LnRzYCByZXNvbHZlc1xuICogYEJPVU5UWV9JRExFX1RJTUVPVVRfU0VDYCBhbmQgYEJPVU5UWV9IRUFSVEJFQVRfTVNgIGluIHRoZSBzZWFtIGZpbGUgZm9yIHRoZVxuICogc2FtZSByZWFzb24uKVxuICovXG5cbmltcG9ydCB7XG4gIGhlYXJ0YmVhdE1zLFxuICBpZGxlVGltZW91dFNlYyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtLCBpbiBzZWNvbmRzLiBHcmFwZXZpbmUncyBvd24gbWVhc3VyZWQgdmFsdWUsIG5vdCBhbiBpbmhlcml0ZWRcbiAqIG9uZTogYGRhZW1vbi50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50IHJlY29yZGluZyB0aGF0XG4gKiBCdW4ncyBkZWZhdWx0IDEwIHMgY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmUgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhc1xuICogc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcyDigJQgYW5kIHRoYXQgYDBgIGlzIG5vdCBcImRpc2FibGVkXCIsIGl0IGlzIHRoZVxuICogZGVmYXVsdC5cbiAqXG4gKiDimqAgYEdSQVBFVklORV9JRExFX1RJTUVPVVRfU0VDYCBpcyBhY2NlcHRlZCBzbyB0aGUgUEFJUiBjYW4gYmUgdHVuZWQgdG9nZXRoZXIsXG4gKiBhbmQgdGhlIGNsYW1wIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuIChUaGlzIGZpbGUgdXNlZCB0byBzYXlcbiAqIGdyYXBldmluZSBcImRvZXMgbm90IGVudi10dW5lIGl0XCIgd2hpbGUgYGRhZW1vbi50c2AgZW52LXR1bmVkIGl0IHRlbiBsaW5lcyBmcm9tXG4gKiB3aGVyZSBpdCBpbXBvcnRlZCB0aGlzIGNvbnN0YW50IOKAlCB0aGUgc2FtZSBvbmUtaGFsZi10dW5hYmxlIHNwbGl0IGFzIHRoZSBiZWF0LFxuICogYW5kIGNvcnJlY3RlZCBpbiB0aGUgc2FtZSBjaGFwdGVyLilcbiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBpZGxlVGltZW91dFNlYyhcbiAgcHJvY2Vzcy5lbnYuR1JBUEVWSU5FX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqXG4gKiBUaGUgU1NFIGtlZXBhbGl2ZSwgaW4gbXMg4oCUIHRoZSBERUZBVUxULCBiZWZvcmUgdGhlIGVudiBpcyBjb25zdWx0ZWQuXG4gKiDimqAgKiozIHMsIGFuZCBpdCBpcyBOT1QgdGhlIGhvdXNlIGRlZmF1bHQgb2YgMTUgcyoqIOKAlCBncmFwZXZpbmUgaXMgdGhlIG9ubHlcbiAqIHNwZWxsIGluIHRoZSByb3N0ZXIgdGhhdCBiZWF0cyB0aGlzIGZhc3QsIGFuZCB0aGUgbnVtYmVyIGlzIGxvYWQtYmVhcmluZ1xuICogcmF0aGVyIHRoYW4gaW5jaWRlbnRhbDogdGhlIGJlYXQgaXMgYWxzbyBncmFwZXZpbmUncyBkZWFkLXN1YnNjcmliZXIgcHJvYmUuIEFcbiAqIHRhaWwgd2hvc2Ugc29ja2V0IGhhcyBnb25lIGF3YXkgaXMgZGlzY292ZXJlZCB3aGVuIHRoZSBlbnF1ZXVlIGZhaWxzLCBhbmRcbiAqIHVudGlsIGl0IGlzIGRpc2NvdmVyZWQgYHdob2AsIGAvcHJlc2VuY2VgIGFuZCBldmVyeSBzZW5kJ3MgcmVjaXBpZW50IGNvdW50XG4gKiByZXBvcnQgYSBnaG9zdC4gRXZlcnkgb3RoZXIgc3BlbGwncyBoZWFydGJlYXQgb25seSBoYXMgdG8ga2VlcCBhIGNvbm5lY3Rpb25cbiAqIG9wZW47IHRoaXMgb25lIGFsc28gaGFzIHRvIGtlZXAgYSBST1NURVIgaG9uZXN0LCB3aGljaCBpcyBhIGh1bWFuLXZpc2libGVcbiAqIG51bWJlciBpbiB0aGUgd2F0Y2ggc3VyZmFjZS4g4puUICoqU28gcmFpc2luZyB0aGlzIGtub2IgbWFrZXMgcHJlc2VuY2VcbiAqIHN0YWxlciwgbm90IGp1c3QgcXVpZXRlcioqIOKAlCBpdCBpcyB0aGUgb25lIHRoaW5nIGFuIG9wZXJhdG9yIHR1bmluZyBpdCBzaG91bGRcbiAqIGtub3cuXG4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMgPSAzXzAwMDtcblxuLyoqXG4gKiBUaGUgYmVhdCBhcyBpdCB3aWxsIGFjdHVhbGx5IGJlIHVzZWQsIGVudi1yZXNvbHZlZCBhbmQgY2xhbXBlZCBhdCBib3RoIGVuZHMgYnlcbiAqIHRoZSBraXQ6IG5ldmVyIGFib3ZlIGBJRExFX1RJTUVPVVRfU0VDIC8gMmAgKG9yIEJ1biBjbG9zZXMgdGhlIGNvbm5lY3Rpb24gdGhlXG4gKiBrZWVwYWxpdmUgd2FzIHByZXNlcnZpbmcpLCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICog4puUIFRIRSBGTE9PUiBJUyBOT1QgREVDT1JBVElPTiAoRDc2KS4gYGludE9yYCBwYXJzZXMgd2l0aCBgcGFyc2VJbnRgLCB3aGljaFxuICogcmVhZHMgYFwiMWU5XCJgIOKAlCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0IGh1Z2VcIiDigJQgYXMgKioxKiouXG4gKiBEcml2ZW4gYmVmb3JlIHRoZSBmbG9vciBleGlzdGVkOiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4XG4gKiBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRSBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAg4oaSIDMgbXMgYW5kXG4gKiBgXCI1YWJjXCJgIOKGkiA1IG1zIGFycml2ZSB0aGUgc2FtZSB3YXkuIFRoZSBmbG9vciBsaXZlcyBpbiB0aGUga2l0J3NcbiAqIGBoZWFydGJlYXRNc2AgYmVzaWRlIHRoZSBjZWlsaW5nIGl0IGNhbm5vdCBjcm9zcywgTk9UIGluIGBpbnRPcmAsIHdoaWNoIGV2ZXJ5XG4gKiBvdGhlciBrbm9iIGluIHRoZSBob3VzZSBzaGFyZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52LkdSQVBFVklORV9IRUFSVEJFQVRfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC4gOSwwMDAgbXMgYXQgdGhlIGRlZmF1bHQuXG4gKlxuICog4puUICoqVEhFIFRBSUwgSEFEIE5PIFdBVENIRE9HIEFUIEFMTCBCRUZPUkUgVEhJUy4qKiBgY21kVGFpbGAncyBpbm5lciBsb29wXG4gKiBhd2FpdGVkIGByZWFkZXIucmVhZCgpYCB3aXRoIG5vdGhpbmcgYm91bmRpbmcgaXQsIHNvIGEgaGFsZi1vcGVuIHNvY2tldCBhZnRlclxuICogbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQgb3IgYSBTSUdLSUxMZWQgZGFlbW9uIHBhcmtlZCB0aGUgdGFpbCBGT1JFVkVSIOKAlCBhbmRcbiAqIGEgcGFya2VkIHRhaWwgaXMgaW5kaXN0aW5ndWlzaGFibGUgZnJvbSBhIHF1aWV0IGNoYW5uZWwsIHdoaWNoIGlzIHRoZSBzdGF0ZVxuICogZ3JhcGV2aW5lJ3MgY2FsbGVycyBzcGVuZCBtb3N0IG9mIHRoZWlyIHRpbWUgaW4uXG4gKlxuICog4pqgIDkgcyBpcyBhZ2dyZXNzaXZlIGJ5IGhvdXNlIHN0YW5kYXJkcyAoNDUgcyBldmVyeXdoZXJlIGVsc2UpIGFuZCB0aGF0IGlzIHRoZVxuICogZGVyaXZhdGlvbiB3b3JraW5nLCBub3QgYSBtaXN0YWtlOiBpdCBpcyB0aHJlZSBvZiBUSElTIHNwZWxsJ3MgYmVhdHMuIEhvbGRpbmdcbiAqIHRoZSBjb25uZWN0aW9uIG9wZW4gSVMgYSB0YWlsJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzXG4gKiBhIG5hbWUgaW4gYSBodW1hbidzIHJvc3RlciDigJQgd2hpY2ggaXMgd2h5IGl0IGlzIHRocmVlIGJlYXRzIGFuZCBub3QgdHdvLlxuICpcbiAqIOKblCBERVJJVkVEIEZST00gVEhFIFJFU09MVkVEIEJFQVQsIE5FVkVSIEZST00gVEhFIERFRkFVTFQuIEl0IGlzXG4gKiBgU1NFX0hFQVJUQkVBVF9NU2AgYWJvdmUgYW5kIG5vdCBgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TYCBvbiBwdXJwb3NlOyB0aGVcbiAqIHJlcGFpciBjaGFwdGVyIGlzIHdoYXQgdGhlIGRpZmZlcmVuY2UgY29zdC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBaUJBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVFBO0FBQ0E7QUFDQTs7O0FDZ0RBOzs7QUNyRE8sU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJ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Q0FBQztBQUVELFNBQVMsUUFBUSxHQUFXO0FBQUEsRUFDMUIsT0FBTztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHdDQVUrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQXdEeEMsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sSUFBSSxTQUFTLElBQUk7QUFBQSxJQUM5QixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sT0FBTyxlQUFlLENBQUM7QUFBQSxJQUM3QixJQUFJLFNBQVM7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUMxQixNQUFNO0FBQUE7QUFBQTtBQWVWLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIjBENjhBQTc0REU5ODI1ODE2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
