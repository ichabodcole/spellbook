#!/usr/bin/env bun
// @bun

// src/bounty/backend/cli.ts
import { spawn } from "child_process";
import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  openSync,
  readdirSync,
  readFileSync as readFileSync2,
  statSync,
  writeFileSync as writeFileSync2
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname as dirname2, join as join2, resolve } from "path";
import { fileURLToPath } from "url";

// plugins/spellbook/skills/bounty/shared/types.ts
var VALID_STATUS = ["todo", "doing", "review", "done"];

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

// src/bounty/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.BOUNTY_IDLE_TIMEOUT_SEC, MAX_IDLE_TIMEOUT_SEC);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.BOUNTY_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, DEFAULT_HEARTBEAT_MS);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/bounty/backend/lock.ts
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
function lockPath(home, id) {
  return join(home, "locks", `${id}.lock`);
}
function readLock(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return typeof raw.pid === "number" ? raw : null;
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function holderLiveness(holder, id) {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0)
    return { state: "stale" };
  if (holder.pid === process.pid)
    return { state: "stale" };
  if (!pidAlive(holder.pid))
    return { state: "stale" };
  let ps;
  try {
    ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(holder.pid)]);
  } catch (e) {
    return {
      state: "unknown",
      why: `\`ps\` could not be run (${e instanceof Error ? e.message : String(e)})`
    };
  }
  const argv = new TextDecoder().decode(ps.stdout ?? new Uint8Array);
  if (ps.exitCode !== 0) {
    if (!pidAlive(holder.pid))
      return { state: "stale" };
    const err = new TextDecoder().decode(ps.stderr ?? new Uint8Array).trim();
    return {
      state: "unknown",
      why: `\`ps\` exited ${ps.exitCode}${err ? ` (${err.split(`
`)[0]})` : ""} for a pid that is alive`
    };
  }
  if (!argv.trim())
    return { state: "unknown", why: "`ps` answered with no command line" };
  return argv.includes(`--id ${id}`) ? { state: "live" } : { state: "stale" };
}
function holderIsLive(holder, id) {
  return holderLiveness(holder, id).state !== "stale";
}
function unknownHolderRefusal(path, id, pid, why) {
  return {
    message: `board ${id} cannot start: its lock ${path} is held by pid ${pid}, which is alive, and bounty cannot tell whether it is this board's daemon because ${why}; refusing rather than risk two daemons for one board`,
    hint: `put a working \`ps\` on PATH and run open again; or, if pid ${pid} is not a bounty daemon for ${id} (check: ps -o command= -p ${pid}), remove the lock (rm ${path}) and run open again`
  };
}

// src/bounty/backend/cli.ts
var SCRIPT_DIR = dirname2(fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join2(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join2(SCRIPT_DIR, "..");
var DIST_DIR = join2(SKILL_ROOT, "dist");
var SURFACE_CWD = join2(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "bounty");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join2(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var BOUNTY_HOME = process.env.BOUNTY_HOME ?? join2(homedir(), ".bounty");
var SNAPSHOTS_DIR = join2(BOUNTY_HOME, "snapshots");
var DAEMON_ANSWER_TIMEOUT_MS = 2000;
function lockHolderPid(id) {
  return readLock(lockPath(BOUNTY_HOME, id))?.pid ?? null;
}
function notAnsweringHint(pid) {
  return pid ? `if pid ${pid} was stopped, resume it (kill -CONT ${pid}) and retry; otherwise end it (kill -9 ${pid}; its last saved snapshot is kept) and run open again` : "find the board's daemon (ps aux | grep bounty), end it, and run open again";
}
var NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function printJson2(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function sessionFilePath(session) {
  return session ? join2(tmpdir(), `bounty-${session}.json`) : join2(tmpdir(), "bounty-latest.json");
}
function slugifyKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
function findScopeRoot(startDir, exists = existsSync) {
  let dir = startDir;
  while (true) {
    if (exists(join2(dir, ".git")))
      return dir;
    const parent = dirname2(dir);
    if (parent === dir)
      return startDir;
    dir = parent;
  }
}
function deriveSessionId(key, scopeRoot) {
  const slug = slugifyKey(key);
  const scopeHash = createHash("sha256").update(scopeRoot).digest("hex").slice(0, 8);
  return slug ? `k-${slug}-${scopeHash}` : `k-${scopeHash}`;
}
function sessionKeyToId(key, startDir = process.cwd(), exists = existsSync) {
  return deriveSessionId(key, findScopeRoot(startDir, exists));
}
function resolveSession(flags, env = process.env, startDir = process.cwd(), readFile = (p) => {
  try {
    return readFileSync2(p, "utf8");
  } catch {
    return null;
  }
}, exists = existsSync) {
  return resolveSessionSource(flags, env, startDir, readFile, exists).id;
}
function derivedFrom(label, key, startDir, exists) {
  const root = findScopeRoot(startDir, exists);
  const scope = root === startDir ? "" : `, scope root ${root}`;
  return `derived from ${label} '${key}' + cwd ${startDir}${scope}`;
}
function resolveSessionSource(flags, env = process.env, startDir = process.cwd(), readFile = (p) => {
  try {
    return readFileSync2(p, "utf8");
  } catch {
    return null;
  }
}, exists = existsSync) {
  const flagKey = flags["session-key"];
  if (typeof flagKey === "string")
    return {
      id: sessionKeyToId(flagKey, startDir, exists),
      from: derivedFrom("--session-key", flagKey, startDir, exists),
      named: true,
      key: flagKey
    };
  if (typeof flags.session === "string")
    return { id: flags.session, from: "from --session", named: true };
  if (env.BOUNTY_SESSION_KEY)
    return {
      id: sessionKeyToId(env.BOUNTY_SESSION_KEY, startDir, exists),
      from: derivedFrom("$BOUNTY_SESSION_KEY", env.BOUNTY_SESSION_KEY, startDir, exists),
      named: false,
      key: env.BOUNTY_SESSION_KEY
    };
  if (env.BOUNTY_SESSION)
    return { id: env.BOUNTY_SESSION, from: "from $BOUNTY_SESSION", named: false };
  let dir = startDir;
  while (true) {
    const marker = join2(dir, ".bounty-session");
    const id = readFile(marker)?.trim();
    if (id)
      return { id, from: `from ${marker}`, named: false };
    const parent = dirname2(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return { from: `looked for the latest-board pointer ${sessionFilePath()}`, named: false };
}
function readSession(session) {
  const path = sessionFilePath(session);
  let raw;
  try {
    raw = readFileSync2(path, "utf8");
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
    die("no running bounty session \u2014 run: cli.ts open", "not_found", NO_SESSION_HINT);
  return s;
}
function pickTailSession(pinned, read) {
  const s = read(pinned);
  if (!s)
    return null;
  return { session: s, pinned: pinned ?? s.session_id };
}
function sameOwner(a, b) {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
function ownerInScope(owner, scope) {
  if (scope.owner)
    return sameOwner(owner, scope.owner);
  if (scope.mine)
    return sameOwner(owner, scope.as) || !owner;
  return true;
}
function parseTags(value) {
  const out = [];
  for (const raw of value.split(",")) {
    const t = raw.trim();
    if (t && !out.includes(t))
      out.push(t);
  }
  return out;
}
function parseSize(value) {
  if (typeof value !== "string")
    return;
  const s = value.trim().toUpperCase();
  return s === "S" || s === "M" || s === "L" ? s : undefined;
}
function parseExpect(value) {
  if (typeof value !== "string")
    return;
  const m = Number(value.trim());
  return Number.isFinite(m) && m > 0 ? m : undefined;
}
function ignoredValues(flags) {
  const out = [];
  if (typeof flags.size === "string" && parseSize(flags.size) === undefined)
    out.push({ flag: "size", value: flags.size, reason: "not one of S|M|L" });
  if (typeof flags.expect === "string" && parseExpect(flags.expect) === undefined)
    out.push({ flag: "expect", value: flags.expect, reason: "not a positive number" });
  return out;
}
function warnIgnored(ignored) {
  for (const i of ignored)
    process.stderr.write(`bounty: ignored --${i.flag} ${JSON.stringify(i.value)} \u2014 ${i.reason}
`);
}
async function api(port, method, path, body, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}
var CLI_OPTIONS = {
  as: { type: "string" },
  expect: { type: "string" },
  id: { type: "string" },
  notes: { type: "string" },
  on: { type: "string" },
  owner: { type: "string" },
  restore: { type: "string" },
  session: { type: "string" },
  "session-key": { type: "string" },
  since: { type: "string" },
  once: { type: "boolean" },
  size: { type: "string" },
  status: { type: "string" },
  tag: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  fresh: { type: "boolean" },
  full: { type: "boolean" },
  mine: { type: "boolean" },
  "no-open": { type: "boolean" },
  pin: { type: "boolean" },
  stdin: { type: "boolean" },
  "stdin-tasks": { type: "boolean" },
  "clear-notes": { type: "boolean" },
  replace: { type: "boolean" }
};
var UPDATE_PATCH_FLAGS = [
  "--status",
  "--title",
  "--notes",
  "--owner",
  "--tag",
  "--size",
  "--expect",
  "--stdin",
  "--clear-notes"
];
function keyFromFlags(flags) {
  return typeof flags["session-key"] === "string" ? flags["session-key"] : process.env.BOUNTY_SESSION_KEY ?? undefined;
}
function nameBackups(records, sessionId, key) {
  const keyed = key !== undefined && sessionKeyToId(key) === sessionId;
  return (records ?? []).map((b) => {
    const bak = resolve(dirname2(b.path)) === resolve(SNAPSHOTS_DIR) ? basename(b.path).replace(/\.json$/, "") : b.path;
    const argv = keyed && key !== undefined ? ["open", "--session-key", key, "--fresh", "--restore", bak, "--no-open"] : ["open", "--restore", bak, "--no-open"];
    return {
      ...b,
      restore: b.taskCount === null || b.superseded ? null : commandLine(argv)
    };
  });
}
function announceBackups(named) {
  for (const b of named) {
    if (b.superseded) {
      process.stderr.write(`bounty: ${b.path} (an unsaved dump of ${b.taskCount} task(s)) is superseded, nothing to do: ${b.superseded}
`);
      continue;
    }
    const held = b.taskCount === null ? "an unreadable snapshot" : `${b.taskCount} task(s)`;
    process.stderr.write(`bounty: backed up ${held} to ${b.path} (${b.reason})${b.restore ? `; recover with: ${b.restore}` : "; kept for repair, it cannot be restored as it stands"}
`);
  }
}
function refuseFromDaemon(res, fallback) {
  return die(res.error ?? fallback, res.kind ?? "conflict", { server: res });
}
function resolveAs(flags) {
  if (typeof flags.as === "string")
    return flags.as;
  return process.env.BOUNTY_AS || undefined;
}
async function postCmd(session, msg, opts = {}) {
  const s = requireSession(session);
  const body = opts.as ? { ...msg, as: opts.as } : msg;
  let reply;
  try {
    reply = await api(s.port, "POST", "/cmd", body, opts.timeoutMs);
  } catch (e) {
    if (!(e instanceof Error && e.name === "TimeoutError"))
      throw e;
    const pid = lockHolderPid(s.session_id);
    die(`board ${s.session_id}'s daemon${pid ? ` (pid ${pid})` : ""} on port ${s.port} is not answering: no reply to ${String(msg.type)} within ${opts.timeoutMs} ms (a stopped daemon still runs it if it is resumed)`, "internal", { hint: notAnsweringHint(pid) });
  }
  const { status, data } = reply;
  if (status !== 200)
    die(`cmd failed (HTTP ${status}) \u2014 is the session still alive?`, "internal", { server: body });
  if (!opts.quiet)
    printJson2({ ok: true, sent: msg.type });
  return data ?? {};
}
function ackOrFail(type, res) {
  if (res.applied === false) {
    refuseFromDaemon(res, `the daemon did not apply ${String(type)} \u2014 the board is unchanged`);
  }
  const dropped = res.tasksDropped;
  const replaced = res.tasksReplaced;
  if (dropped !== undefined) {
    printJson2({
      ok: true,
      sent: type,
      tasksDropped: dropped,
      ...replaced !== undefined ? { tasksReplaced: replaced } : {}
    });
    if (dropped && typeof dropped === "object") {
      const d = dropped;
      process.stderr.write(`bounty: ${d.dropped.length} of ${d.requested} task(s) were DROPPED and not seeded:
`);
      for (const item of d.dropped)
        process.stderr.write(`  [${item.index}] ${item.reason}
`);
    }
    return 0;
  }
  printJson2({ ok: true, sent: type });
  return 0;
}
function newTaskId() {
  return `t-${crypto.randomUUID().slice(0, 8)}`;
}
async function boardIfLive(session) {
  const s = readSession(session);
  if (!s)
    return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/state`, {
      signal: AbortSignal.timeout(DAEMON_ANSWER_TIMEOUT_MS)
    });
    return r.ok ? s : null;
  } catch {
    return null;
  }
}
function writePin(sessionId) {
  const pinPath = join2(process.cwd(), ".bounty-session");
  try {
    writeFileSync2(pinPath, `${sessionId}
`);
    process.stderr.write(`# pinned board ${sessionId} \u2192 ${pinPath}
`);
  } catch (e) {
    process.stderr.write(`bounty: could not write ${pinPath}: ${e instanceof Error ? e.message : String(e)}
`);
  }
}
var ATTACH_LOST_FLAGS = ["title", "timeout", "restore"];
function restoreCandidates(arg) {
  return [resolve(daemonCwd(), arg), join2(SNAPSHOTS_DIR, `${arg}.json`)];
}
function mayExist(path) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    const code = e.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
function refuseMissingRestore(flags) {
  if (typeof flags.restore !== "string")
    return;
  if (restoreCandidates(flags.restore).some((p) => mayExist(p)))
    return;
  die(`no snapshot ${JSON.stringify(flags.restore)} to restore; no board was started`, "not_found", {
    hint: "`sessions` lists the snapshots this host can restore; a keyed board comes back with open --session-key <key>"
  });
}
function copyAsideBeforeTeardown(flags, id) {
  if (typeof flags.restore !== "string")
    return null;
  const own = join2(SNAPSHOTS_DIR, `${id}.json`);
  const source = restoreCandidates(flags.restore).find((p) => existsSync(p));
  if (!source || resolve(source) !== resolve(own))
    return null;
  const path = join2(SNAPSHOTS_DIR, `${id}.pre-fresh-${Date.now()}.bak.json`);
  try {
    copyFileSync(own, path);
  } catch (e) {
    die(`the snapshot ${own} could not be copied aside (${e instanceof Error ? e.message : String(e)}) before --fresh tore board ${id} down, whose close would write over it; the live board was left running and nothing was restored`, "conflict", { hint: `make the folder ${SNAPSHOTS_DIR} writable, then run the same open again` });
  }
  let taskCount = null;
  try {
    const tasks = JSON.parse(readFileSync2(path, "utf8")).tasks;
    taskCount = Array.isArray(tasks) ? tasks.length : null;
  } catch {}
  return {
    kind: "pre-fresh",
    path,
    taskCount,
    reason: "copied before --fresh tore the live board down, whose close writes over this snapshot; the new board was restored from this copy"
  };
}
function refuseUnknownHolder(id) {
  const path = lockPath(BOUNTY_HOME, id);
  const holder = readLock(path);
  if (!holder)
    return;
  const live = holderLiveness(holder, id);
  if (live.state !== "unknown")
    return;
  const r = unknownHolderRefusal(path, id, holder.pid, live.why);
  die(r.message, "conflict", { hint: r.hint });
}
async function cmdOpen(flags) {
  const key = typeof flags["session-key"] === "string" ? flags["session-key"] : process.env.BOUNTY_SESSION_KEY ?? undefined;
  const forcedId = key ? sessionKeyToId(key) : undefined;
  let teardownBackups = [];
  let preFresh = null;
  let restoreArg = typeof flags.restore === "string" ? flags.restore : undefined;
  if (forcedId) {
    const live = await boardIfLive(forcedId);
    if (live && !flags.fresh) {
      const requested = ATTACH_LOST_FLAGS.filter((f) => Boolean(flags[f]));
      const named = requested.map((f) => `--${f}`).join(", ");
      if (requested.length) {
        printJson2({
          ...live,
          restoreSkipped: {
            requested,
            reason: `a live board already exists for this key, so open attached to it instead of spawning a daemon; ${named} ${requested.length === 1 ? "configures" : "configure"} a daemon at spawn time and the running board was left unchanged`
          },
          snapshotBackups: [],
          snapshotBackupFailed: null
        });
        process.stderr.write(`bounty: refusing to attach \u2014 ${named} cannot take effect on a board that is already running (key "${key}", board ${forcedId})
`);
        if (flags.pin)
          writePin(forcedId);
        return 2;
      }
      printJson2({ ...live, restoreSkipped: null, snapshotBackups: [], snapshotBackupFailed: null });
      process.stderr.write(`# attached to existing board ${forcedId} (key "${key}")
`);
      if (flags.pin)
        writePin(forcedId);
      return 0;
    }
    if (!live)
      refuseUnknownHolder(forcedId);
    refuseMissingRestore(flags);
    if (live && flags.fresh) {
      preFresh = copyAsideBeforeTeardown(flags, forcedId);
      if (preFresh)
        restoreArg = basename(preFresh.path).replace(/\.json$/, "");
      try {
        const res = await api(live.port, "POST", "/cmd", { type: "close" }, DAEMON_ANSWER_TIMEOUT_MS);
        teardownBackups = res.data?.snapshotBackups ?? [];
      } catch {}
      const gone = Date.now() + 3000;
      while (Date.now() < gone && await boardIfLive(forcedId))
        await sleep(80);
    }
  }
  if (!forcedId)
    refuseMissingRestore(flags);
  const args = ["run", SERVER_SCRIPT];
  if (flags.title)
    args.push("--title", String(flags.title));
  if (flags.timeout)
    args.push("--timeout", String(flags.timeout));
  if (forcedId && !flags.restore && !flags.fresh && mayExist(join2(SNAPSHOTS_DIR, `${forcedId}.json`))) {
    args.push("--restore", forcedId);
  }
  if (restoreArg)
    args.push("--restore", restoreArg);
  if (flags["no-open"])
    args.push("--no-open");
  if (forcedId)
    args.push("--id", forcedId);
  const prevId = readSession()?.session_id;
  let stderr = "ignore";
  try {
    const bountyHome = process.env.BOUNTY_HOME ?? join2(homedir(), ".bounty");
    mkdirSync2(bountyHome, { recursive: true });
    stderr = openSync(join2(bountyHome, "daemon.log"), "a");
  } catch {
    stderr = "ignore";
  }
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    printJson2({
      error: `bounty cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}. No dist/index.html was found (or SPELLBOOK_SURFACE_MODE=dev is set), so the daemon would run in dev mode and needs the surface source at that path.`
    });
    return 2;
  }
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", stderr],
    env: process.env,
    cwd
  });
  proc.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(80);
    const s = forcedId ? readSession(forcedId) : readSession();
    const isUp = forcedId ? !!s : !!(s && s.session_id !== prevId);
    if (s && isUp) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/state`, {
          signal: AbortSignal.timeout(DAEMON_ANSWER_TIMEOUT_MS)
        });
        if (r.ok) {
          const holder2 = forcedId ? readLock(lockPath(BOUNTY_HOME, forcedId)) : null;
          const lostRace = holder2 !== null && holder2.pid !== proc.pid;
          const lost = lostRace ? ATTACH_LOST_FLAGS.filter((f) => Boolean(flags[f])) : [];
          if (lost.length) {
            const named = lost.map((f) => `--${f}`).join(", ");
            printJson2({
              ...s,
              restoreSkipped: {
                requested: lost,
                reason: `another open started this board first, so the daemon this open spawned exited without touching it; ${named} ${lost.length === 1 ? "configures" : "configure"} a daemon at spawn time and the running board was left unchanged`
              },
              snapshotBackups: nameBackups([...preFresh ? [preFresh] : [], ...teardownBackups], s.session_id, key),
              snapshotBackupFailed: null
            });
            process.stderr.write(`bounty: refusing to report success \u2014 another open started board ${forcedId} first, so ${named} did not take effect (key "${key}")
`);
            if (flags.pin)
              writePin(s.session_id);
            return 2;
          }
          const boot = s.snapshotBackups;
          const snapshotBackups = nameBackups([...preFresh ? [preFresh] : [], ...teardownBackups, ...boot ?? []], s.session_id, key);
          const backupFailed = s.snapshotBackupFailed ?? null;
          printJson2({
            ...s,
            restoreSkipped: null,
            snapshotBackups,
            snapshotBackupFailed: backupFailed
          });
          announceBackups(snapshotBackups);
          if (backupFailed)
            process.stderr.write(`bounty: could not copy ${backupFailed.path} aside before the board writes over it (${backupFailed.error}); it is not written over until a copy can be made: ${backupFailed.fix}
`);
          if (lostRace)
            process.stderr.write(`# another open started board ${forcedId} first; attached to it (key "${key}")
`);
          if (flags.pin)
            writePin(s.session_id);
          return 0;
        }
      } catch {}
    }
  }
  if (forcedId)
    refuseUnknownHolder(forcedId);
  const holder = forcedId ? readLock(lockPath(BOUNTY_HOME, forcedId)) : null;
  const wedged = holder && forcedId && holderIsLive(holder, forcedId) ? holder : null;
  return die(wedged ? `bounty daemon failed to start within 5s: board ${forcedId} is held by a running daemon (pid ${wedged.pid}) that is not answering` : "bounty daemon failed to start within 5s", "internal", wedged ? { hint: notAnsweringHint(wedged.pid) } : undefined);
}
async function cmdState(session, scope = {}) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    die(`state failed (HTTP ${status})`, "internal", { server: data });
  if (scope.owner || scope.mine) {
    const d = data;
    if (d.state?.tasks) {
      d.state.tasks = d.state.tasks.filter((t) => ownerInScope(t.owner, scope));
    }
  }
  printJson2({ ...data, readMode: "full" });
}
var NAMED_TARGET_GRACE_MS = 5000;
function namedTargetGraceMs(raw = process.env.BOUNTY_TAIL_GRACE_MS) {
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : NAMED_TARGET_GRACE_MS;
}
function hasSnapshot(id) {
  return existsSync(join2(SNAPSHOTS_DIR, `${id}.json`));
}
function sinceOrDie(token) {
  const r = readSince(token, { epoch: false });
  if (!r.ok)
    die(r.message, "usage");
  return r.since;
}
async function cmdTail(session, sinceArg, scope = {}, once = false, arm = {}) {
  const owner = scope.owner;
  const self = scope.as;
  const scopeable = (t) => typeof t === "string" && (t.startsWith("task.") || t === "unblocked" || t === "heartbeat");
  const inScope = (ev) => !scopeable(ev.type) || ownerInScope(ev.owner, scope);
  if (owner)
    process.stderr.write(`# scoped to owner=${owner}
`);
  else if (scope.mine)
    process.stderr.write(`# scoped to --mine (owner=${self ?? "?"} + claimable)
`);
  let pinned = session;
  const reArm = arm.sessionFlag === true || arm.sinceGiven === true;
  let announcedPin = false;
  const source = arm.source ?? {
    ...session !== undefined ? { id: session } : {},
    from: session !== undefined ? "resolved" : `looked for the latest-board pointer ${sessionFilePath()}`,
    named: false
  };
  const named = source.named && source.id !== undefined;
  const graceMs = namedTargetGraceMs();
  const startedAt = Date.now();
  const lookedFor = () => source.id !== undefined ? `for ${source.id} (${source.from})` : pinned !== undefined ? `for ${pinned} (pinned off the latest-board pointer)` : `(${source.from})`;
  const keyedComeBack = () => arm.key !== undefined && pinned !== undefined && sessionKeyToId(arm.key) === pinned;
  const comeBackCmd = () => commandLine(keyedComeBack() && arm.key !== undefined ? ["open", "--session-key", arm.key, "--no-open"] : ["open", "--restore", pinned ?? "<id>", "--no-open"]);
  const again = () => [
    "tail",
    ...pinned !== undefined ? ["--session", pinned] : [],
    ...owner ? ["--owner", owner] : [],
    ...scope.mine ? ["--mine"] : [],
    ...self !== undefined ? ["--as", self] : []
  ];
  return await tailWithHandoff({
    resolve: () => {
      const resolved = pickTailSession(pinned, readSession);
      if (!resolved)
        return null;
      if (pinned === undefined) {
        pinned = resolved.pinned;
      }
      if (!announcedPin) {
        announcedPin = true;
        process.stderr.write(`# pinned to session ${pinned} \u2014 a long-lived tail won't migrate to a newer board (pass --session to choose another)
`);
      }
      return `http://127.0.0.1:${resolved.session.port}`;
    },
    onUnresolved: ({ everResolved }) => {
      const existed = everResolved || pinned !== undefined && hasSnapshot(pinned);
      if (reArm && (!named || existed))
        return "stop";
      if (named && existed)
        return "stop";
      if (named && Date.now() - startedAt >= graceMs) {
        const hint = keyedComeBack() ? `no board is running under this key and none left a close snapshot; the id is project-scoped (it hashes the repo root), so check the key and the cwd, or open it: ${comeBackCmd()}` : "no board with this id is running here and none left a snapshot; check the id (`sessions` lists the boards this host can restore)";
        die(`no session ${pinned} found (${source.from}) \u2014 a named target; gave up after ${graceMs}ms`, "not_found", { hint });
      }
      process.stderr.write(`# no session yet ${lookedFor()} \u2014 retrying\u2026
`);
      return "retry";
    },
    path: "/events",
    since: sinceArg,
    cursorOf: (ev) => ev.id,
    accept: (ev) => inScope(ev) && !(self !== undefined && ev.by === self),
    terminal: (ev) => ev.type === "closed",
    terminalEmitsFiltered: true,
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": bounty-keepalive",
    onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch })
  }, {
    spell: "bounty",
    mode: once ? "once" : "watch",
    presence: false,
    commands: {
      tail: ({ since, once: o }) => tailCommand(again(), since, o),
      comeBack: comeBackCmd
    }
  });
}
function cmdInfo(session) {
  const s = readSession(session);
  if (!s)
    die("no running bounty session", "not_found", NO_SESSION_HINT);
  printJson2(s);
}
function cmdSessions() {
  let files;
  try {
    files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    process.stdout.write(`no saved sessions
`);
    return;
  }
  const rows = [];
  for (const f of files) {
    const path = join2(SNAPSHOTS_DIR, f);
    try {
      const st = JSON.parse(readFileSync2(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        tasks: Array.isArray(st.tasks) ? st.tasks.length : 0,
        mtime: statSync(path).mtimeMs
      });
    } catch {}
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.tasks} tasks  \u2014 ${r.title}
`);
  }
  if (!rows.length)
    process.stdout.write(`no saved sessions
`);
}
async function liveBoards(discovered, probe) {
  const probed = await Promise.all(discovered.map(async (s) => {
    const probed2 = await probe(s);
    return probed2 === null ? null : { session_id: s.session_id, title: s.title, url: s.url, tasks: probed2.tasks };
  }));
  return probed.filter((b) => b !== null);
}
async function probeBoard(s) {
  try {
    const res = await fetch(`${s.url}/state?lean=1`, { signal: AbortSignal.timeout(600) });
    if (!res.ok)
      return null;
    const body = await res.json();
    return { tasks: Array.isArray(body.state?.tasks) ? body.state.tasks.length : null };
  } catch {
    return null;
  }
}
async function cmdList() {
  let files;
  try {
    files = readdirSync(tmpdir()).filter((f) => f.startsWith("bounty-") && f.endsWith(".json") && f !== "bounty-latest.json");
  } catch {
    files = [];
  }
  const discovered = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync2(join2(tmpdir(), f), "utf8"));
      if (s && typeof s.url === "string" && typeof s.session_id === "string")
        discovered.push(s);
    } catch {}
  }
  const live = await liveBoards(discovered, probeBoard);
  live.sort((a, b) => a.session_id.localeCompare(b.session_id));
  process.stdout.write(`${live.length} running board${live.length === 1 ? "" : "s"}
`);
  for (const b of live) {
    const count = b.tasks === null ? "? (unreadable)" : `${b.tasks} tasks`;
    process.stdout.write(`${b.session_id}  ${count}  ${b.url}  \u2014 ${b.title}
`);
  }
  if (!live.length)
    process.stdout.write("this lists BOARDS, not tasks \u2014 for the cards ON a board use `bounty state`\n");
}
async function readStdin() {
  return (await Bun.stdin.text()).replace(/\n$/, "");
}
var on = (h) => (inv) => {
  const flags = inv.flags;
  return h(inv.pos, flags, resolveSession(flags), resolveAs(flags));
};
var DASH_HINT = "for free text containing dashes, use --stdin, or put it after a bare --";
var BOARD = ["session", "session-key"];
var WRITE = [...BOARD, "as"];
async function cmdAdd(pos, flags, session, as) {
  const title = flags.stdin === true ? await readStdin() : pos.join(" ");
  if (!title)
    die("usage: add <title...> [--status ..] [--notes ..] [--stdin]");
  const status = typeof flags.status === "string" ? flags.status : "todo";
  const task = {
    id: typeof flags.id === "string" ? flags.id : newTaskId(),
    title,
    status
  };
  if (typeof flags.notes === "string")
    task.notes = flags.notes;
  if (typeof flags.owner === "string")
    task.owner = flags.owner;
  if (typeof flags.tag === "string")
    task.tags = parseTags(flags.tag);
  const addSize = parseSize(flags.size);
  if (addSize)
    task.size = addSize;
  const addExpect = parseExpect(flags.expect);
  if (addExpect !== undefined)
    task.expect = addExpect;
  const addIgnored = ignoredValues(flags);
  warnIgnored(addIgnored);
  const res = await postCmd(session, { type: "task.add", task }, { as, quiet: true });
  if (!res.applied)
    refuseFromDaemon(res, `task ${task.id} was not added`);
  printJson2({ ok: true, added: task.id, valuesIgnored: addIgnored.length ? addIgnored : null });
}
async function cmdUpdate(pos, flags, session, as) {
  const id = pos[0];
  const patch = {};
  if (flags.stdin === true) {
    const title = await readStdin();
    if (!title)
      die("update: --stdin read an empty title, and a title is never cleared; pipe the new title, or use --notes <text> / --clear-notes for the notes");
    patch.title = title;
  } else if (typeof flags.title === "string")
    patch.title = flags.title;
  if (typeof flags.status === "string")
    patch.status = flags.status;
  if (typeof flags.notes === "string")
    patch.notes = flags.notes;
  else if (flags["clear-notes"] === true)
    patch.notes = "";
  if (typeof flags.owner === "string")
    patch.owner = flags.owner;
  if (typeof flags.tag === "string")
    patch.tags = parseTags(flags.tag);
  const upSize = parseSize(flags.size);
  if (upSize)
    patch.size = upSize;
  const upExpect = parseExpect(flags.expect);
  if (upExpect !== undefined)
    patch.expect = upExpect;
  const upIgnored = ignoredValues(flags);
  warnIgnored(upIgnored);
  if (Object.keys(patch).length === 0) {
    const why = upIgnored.length ? ` \u2014 ${upIgnored.map((i) => `--${i.flag} ${JSON.stringify(i.value)} was ignored (${i.reason})`).join("; ")}` : "";
    die(`update: nothing to change${why}`, "usage", {
      hint: `give one of ${UPDATE_PATCH_FLAGS.join(" ")}`,
      choices: [...UPDATE_PATCH_FLAGS]
    });
  }
  const res = await postCmd(session, { type: "task.update", id, patch }, { as, quiet: true });
  const fields = Object.keys(patch);
  if (res.applied) {
    printJson2({
      ok: true,
      updated: id,
      fields,
      valuesIgnored: upIgnored.length ? upIgnored : null
    });
  } else if (res.error) {
    refuseFromDaemon(res, `no such task ${id}`);
  } else {
    printJson2({
      ok: true,
      updated: id,
      noop: true,
      fields: [],
      valuesIgnored: upIgnored.length ? upIgnored : null
    });
  }
}
async function cmdClaim(id, session, as) {
  if (!as)
    die("claim needs an identity \u2014 pass --as <name> or set BOUNTY_AS");
  const res = await postCmd(session, { type: "task.update", id, patch: { owner: as }, claim: true }, { as, quiet: true });
  if (res.applied) {
    printJson2({ ok: true, claimed: id, owner: as });
  } else {
    refuseFromDaemon(res, `could not claim ${id}`);
  }
}
async function cmdBlock(verb, id, flags, session, as) {
  if (typeof flags.on !== "string")
    die(`usage: ${verb} <id> --on <id>[,<id>...]`);
  const on2 = flags.on.split(",").map((x) => x.trim()).filter(Boolean);
  if (!on2.length)
    die(`${verb}: --on needs at least one task id`);
  const res = await postCmd(session, { type: verb === "block" ? "task.block" : "task.unblock", id, on: on2 }, { as, quiet: true });
  if (res.applied) {
    printJson2({ ok: true, [verb === "block" ? "blocked" : "unblocked"]: id, on: on2 });
  } else {
    refuseFromDaemon(res, `could not ${verb} ${id}`);
  }
}
async function cmdRemove(id, session, as) {
  const res = await postCmd(session, { type: "task.remove", id }, { as, quiet: true });
  if (res.applied) {
    printJson2({ ok: true, removed: id });
  } else {
    refuseFromDaemon(res, `no such task ${id} (wrong board? pass --session)`);
  }
}
async function cmdMessage(pos, flags, session, as) {
  const text = flags.stdin === true ? await readStdin() : pos.join(" ");
  if (!text)
    die("usage: message <text...> [--stdin]");
  return ackOrFail("message", await postCmd(session, { type: "message", text }, { as, quiet: true }));
}
async function cmdInit(flags, session, as) {
  const msg = { type: "init" };
  if (typeof flags.title === "string")
    msg.title = flags.title;
  if (flags["stdin-tasks"] === true) {
    const raw = await readStdin();
    try {
      const tasks = JSON.parse(raw);
      if (!Array.isArray(tasks))
        die("init --stdin-tasks: stdin must be a JSON array of tasks");
      msg.tasks = tasks;
    } catch (e) {
      if (e instanceof CliError)
        throw e;
      die("init --stdin-tasks: invalid JSON on stdin", "usage");
    }
  }
  if (flags.replace === true)
    msg.replace = true;
  const res = await postCmd(session, msg, { as, quiet: true });
  if (res.applied === false && res.kind === "conflict")
    die(res.error ?? "init: the board already has tasks", "conflict", {
      hint: "to replace them, pass --replace (the reply counts them in tasksReplaced); to add to the board, use add",
      server: res
    });
  return ackOrFail(msg.type, res);
}
async function cmdClose(session, as, flags = {}) {
  const closeRes = await postCmd(session, { type: "close" }, { as, quiet: true, timeoutMs: DAEMON_ANSWER_TIMEOUT_MS });
  if (!closeRes.applied && closeRes.kind === "conflict" && closeRes.snapshotSaveFailed) {
    const failed2 = closeRes.snapshotSaveFailed;
    const resolved2 = requireSession(session);
    die(closeRes.error ?? "board not closed: nowhere could take its snapshot", "conflict", {
      hint: `the board is still running and holds the only copy of its ${failed2.taskCount} task(s). ${failed2.fix ?? `Make ${failed2.path} writable`}, or make ${BOUNTY_HOME} writable so the board can be dumped there, then run: ${commandLine(["close", "--session", resolved2.session_id])}`,
      server: closeRes
    });
  }
  if (!closeRes.applied)
    return ackOrFail("close", closeRes);
  const resolved = requireSession(session);
  const deadline = Date.now() + 3000;
  let down = false;
  while (Date.now() < deadline) {
    if (!await boardIfLive(resolved.session_id)) {
      down = true;
      break;
    }
    await sleep(80);
  }
  const snapshotBackups = nameBackups(closeRes.snapshotBackups, resolved.session_id, keyFromFlags(flags));
  const failed = closeRes.snapshotSaveFailed;
  if (failed) {
    const dump = snapshotBackups.find((b) => b.kind === "unsaved" && b.path === failed.unsaved);
    die(`board ${resolved.session_id} is closed, but its final save failed: the snapshot ${failed.path} could not be written (${failed.error}); its ${failed.taskCount} task(s) were saved to ${failed.unsaved} instead`, "conflict", {
      hint: `${failed.fix ?? `fix ${failed.path} (remove it if it is a directory, or make it and its folder writable)`}, then run: ${dump?.restore ?? `open --restore ${failed.unsaved} --no-open`}`,
      server: closeRes
    });
  }
  printJson2({ ok: true, sent: "close", down, snapshotBackups });
  announceBackups(snapshotBackups);
  if (!down)
    process.stderr.write(`bounty: close acked but the daemon was still answering after 3s \u2014 a reopen may attach to it
`);
  return 0;
}
function scopeOf(flags, as) {
  const mine = flags.mine === true;
  if (mine && !as)
    die("--mine needs an identity \u2014 pass --as <name> or set BOUNTY_AS");
  return { owner: typeof flags.owner === "string" ? flags.owner : undefined, mine, as };
}
function checkStatus(verb, f) {
  if (typeof f.status === "string" && !VALID_STATUS.includes(f.status))
    die(`${verb}: --status ${JSON.stringify(f.status)} is not a status`, "usage", {
      choices: [...VALID_STATUS]
    });
}
function checkAdd(inv) {
  const f = inv.flags;
  checkStatus("add", f);
  if (f.stdin === true && inv.pos.length > 0)
    return "a title and --stdin both set the title; pass one of them (for the notes, use --notes <text>)";
  return;
}
function checkUpdate(inv) {
  const f = inv.flags;
  checkStatus("update", f);
  if (f.stdin === true && typeof f.title === "string")
    return "--stdin and --title both set the title; pass one of them (for the notes, use --notes <text>)";
  if (f["clear-notes"] === true && typeof f.notes === "string")
    return "--clear-notes and --notes both set the notes; pass --notes <text> to replace them, or --clear-notes alone to clear them";
  if (f.title === "")
    return "--title is empty, and a title is never cleared (add refuses one too); pass the new title text";
  if (f.notes === "")
    return "--notes is empty, which would erase the notes; to clear notes on purpose, pass --clear-notes";
  return;
}
function checkOpen(inv) {
  const f = inv.flags;
  if (f.restore === "")
    return "--restore is empty, so it names no snapshot; pass the id to restore (`sessions` lists them), or drop --restore for a fresh board";
  return;
}
function checkMessage(inv) {
  const f = inv.flags;
  if (f.stdin === true && inv.pos.length > 0)
    return "a text and --stdin both set the message; pass one of them";
  return;
}
function checkInit(inv) {
  const f = inv.flags;
  if (f.replace === true && f["stdin-tasks"] !== true)
    return "--replace replaces the board's tasks with the ones on stdin, so it needs --stdin-tasks";
  return;
}
var ROWS = [
  {
    name: "open",
    flags: ["title", "timeout", "no-open", "restore", "pin", "session-key", "fresh"],
    positionals: [],
    describe: "spawn a board daemon; prints {url, port, session_id, restoreSkipped, snapshotBackups}. --pin binds it to cwd; --session-key <key> binds it to a caller-owned key, idempotently (--fresh forces a clean board)",
    check: checkOpen,
    run: (_pos, flags) => cmdOpen(flags)
  },
  {
    name: "state",
    flags: [...WRITE, "owner", "mine", "full"],
    positionals: [],
    describe: "read-back: {state, cursor, readMode}; --mine | --owner <name> scope it (--full is accepted but redundant: the read is full by default \u2014 b6)",
    run: (_pos, flags, session, as) => cmdState(session, scopeOf(flags, as))
  },
  {
    name: "tail",
    flags: [...WRITE, "since", "once", "owner", "mine"],
    positionals: [],
    describe: `board events as JSON lines \u2014 wrap with Monitor; it ${WINDOW_HELP}`,
    run: (_pos, flags, session, as) => cmdTail(session, typeof flags.since === "string" ? sinceOrDie(flags.since) : -1, scopeOf(flags, as), flags.once === true, {
      sinceGiven: typeof flags.since === "string",
      sessionFlag: typeof flags.session === "string",
      source: resolveSessionSource(flags),
      ...typeof flags["session-key"] === "string" ? { key: flags["session-key"] } : process.env.BOUNTY_SESSION_KEY ? { key: process.env.BOUNTY_SESSION_KEY } : {}
    })
  },
  {
    name: "add",
    flags: [...WRITE, "status", "notes", "owner", "tag", "size", "expect", "id", "stdin"],
    positionals: [{ name: "title", required: false, variadic: true }],
    describe: "add a task (the title, or --stdin); --size S|M|L is a heartbeat estimate (5/10/20 min), --expect <min> overrides it",
    check: checkAdd,
    run: cmdAdd
  },
  {
    name: "update",
    flags: [
      ...WRITE,
      "status",
      "title",
      "notes",
      "clear-notes",
      "owner",
      "tag",
      "size",
      "expect",
      "stdin"
    ],
    positionals: [{ name: "id", required: true }],
    describe: 'patch a task; --stdin reads the new TITLE; --clear-notes clears the notes (an empty --notes is refused); --tag "" clears the tags',
    check: checkUpdate,
    run: cmdUpdate
  },
  {
    name: "claim",
    flags: WRITE,
    positionals: [{ name: "id", required: true }],
    describe: "self-claim an UNOWNED task as --as <name> (rejected if another owns it)",
    run: (pos, _flags, session, as) => cmdClaim(pos[0], session, as)
  },
  {
    name: "block",
    flags: [...WRITE, "on"],
    positionals: [{ name: "id", required: true }],
    describe: "mark <id> blocked on --on <id>[,<id>...] (rejected on a cycle)",
    run: (pos, flags, session, as) => cmdBlock("block", pos[0], flags, session, as)
  },
  {
    name: "unblock",
    flags: [...WRITE, "on"],
    positionals: [{ name: "id", required: true }],
    describe: "remove blocker edge(s) --on <id>[,<id>...]",
    run: (pos, flags, session, as) => cmdBlock("unblock", pos[0], flags, session, as)
  },
  {
    name: "remove",
    flags: WRITE,
    positionals: [{ name: "id", required: true }],
    describe: "delete a task",
    run: (pos, _flags, session, as) => cmdRemove(pos[0], session, as)
  },
  {
    name: "message",
    flags: [...WRITE, "stdin"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "show a toast on the board (the text, or --stdin)",
    check: checkMessage,
    run: cmdMessage
  },
  {
    name: "init",
    flags: [...WRITE, "title", "stdin-tasks", "replace"],
    positionals: [],
    describe: "seed the board (tasks = JSON array on stdin; each task REQUIRES id + title + status \u2014 init does NOT mint ids, unlike add; any dropped task is reported per-entry in tasksDropped). Over a board that has tasks it is refused (exit 6) unless --replace, which reports tasksReplaced",
    check: checkInit,
    run: (_pos, flags, session, as) => cmdInit(flags, session, as)
  },
  {
    name: "close",
    flags: WRITE,
    positionals: [],
    describe: "end the board (writes its snapshot); prints {ok, sent, down, snapshotBackups} \u2014 any backup the board wrote, and the act that recovers it",
    run: (_pos, flags, session, as) => cmdClose(session, as, flags)
  },
  {
    name: "info",
    flags: BOARD,
    positionals: [],
    describe: "the resolved board's {url, port, session_id, title}",
    run: (_pos, _flags, session) => cmdInfo(session)
  },
  {
    name: "list",
    flags: [],
    positionals: [],
    describe: "list currently-RUNNING boards (id/tasks/url/title) \u2014 prose, see below",
    run: () => cmdList()
  },
  {
    name: "sessions",
    flags: [],
    positionals: [],
    describe: "list saved SNAPSHOTS, incl. closed boards (id/tasks/title) \u2014 prose, see below",
    run: () => cmdSessions()
  }
];
function versionInfo() {
  try {
    const raw = readFileSync2(join2(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "bounty", version: pkg.version };
  } catch {}
  return { name: "bounty", version: "unknown" };
}
var cli = defineCli({
  name: "bounty",
  summary: "an agent-driven task board.",
  options: CLI_OPTIONS,
  commands: ROWS.map((r) => ({ ...r, run: on(r.run), rejectHint: DASH_HINT })),
  grammar: "verb-first",
  usageHides: ["session", "session-key", "as"],
  version: versionInfo,
  helpFooter: `  Every verb that talks to a board takes --session <id> and --session-key <key>;
  those that act on it also take --as <name>. Each verb accepts only the flags
  on its row.

  --as <name> (or $BOUNTY_AS) is your identity \u2014 stamped on events (for scoped
  tail + self-echo suppression) and used by claim/--mine. --owner assigns a task.
  --stdin reads the title from stdin (verbatim \u2014 survives apostrophes, quotes,
  &, <, >). Session targeting resolves --session-key <key> > --session <id> >
  $BOUNTY_SESSION_KEY > $BOUNTY_SESSION > nearest .bounty-session (walking up
  from cwd) > most-recent board. A --session-key is a caller-owned handle: it
  derives a stable, project-scoped board id, so open --session-key K is
  idempotent (attaches to a live board for K, respawns a dead one; --fresh
  forces a clean one), and every verb re-derives the same id \u2014 deterministic
  board binding with no stored/latest pointer. Or use open --pin to write
  cwd/.bounty-session and bind a board to this directory.

  Output: JSON on stdout, one document per answer \u2014 except tail (one JSON line
  per event), and list, sessions and help (prose lines). Failures: one JSON
  envelope on stderr, exit 2 = usage, 1 = internal, 5 = not found, 6 =
  conflict. schema prints the machine-readable interface.`
});
var VERBS = cli.verbs;
var RECOGNIZED_FLAGS = [...cli.recognizedFlags].sort();
async function run() {
  return await main(process.argv.slice(2));
}
async function main(argv) {
  try {
    return await cli.dispatch(argv);
  } catch (e) {
    const code = reportCliError(e);
    if (code === null)
      throw e;
    return code;
  }
}
export {
  RECOGNIZED_FLAGS,
  UPDATE_PATCH_FLAGS,
  VERBS,
  cli,
  deriveSessionId,
  findScopeRoot,
  liveBoards,
  main,
  ownerInScope,
  parseTags,
  pickTailSession,
  resolveSession,
  resolveSessionSource,
  run,
  sessionKeyToId,
  slugifyKey
};
