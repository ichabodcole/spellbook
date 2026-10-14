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
  const renderVerbHelp = (path) => {
    const r = byToken.get(path);
    if (r === undefined)
      return die(`help: no verb "${path}"`, "usage", {
        choices: paths,
        hint: "help with no verb lists them all"
      });
    const flags = r.accepted.map((k) => {
      const value = spec.options[k]?.type === "boolean" ? `--${k}` : `--${k} <${k}>`;
      return [value, r.flagHelp[k] ?? ""];
    });
    const width = Math.min(Math.max(0, ...flags.map(([f]) => f.length)), 28);
    const flagLines = flags.map(([f, d]) => d === "" ? `  ${f}` : f.length <= width ? `  ${f.padEnd(width)}  ${d}` : `  ${f}
  ${"".padEnd(width)}  ${d}`);
    return [
      `usage: ${usageLine(r)}`,
      "",
      r.describe,
      ...flagLines.length > 0 ? ["", "flags:", ...flagLines] : [],
      ...r.examples.length > 0 ? ["", "examples:", ...r.examples.map((e) => `  ${e}`)] : []
    ].join(`
`);
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
    const end = args.indexOf("--");
    const before = end === -1 ? args : args.slice(0, end);
    if (row.name !== "" && !row.auto && (before.includes("--help") || before.includes("-h") && !shortToKey.has("h"))) {
      process.stdout.write(`${renderVerbHelp(row.name)}
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

//# debugId=FE9F16CE8083853164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2hlYXJ0YmVhdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gbWluZC1tYXBwZXIg4oCUIHRoZSBmdWxsIHZlcmIgc2V0IChWMSArIFYxLnggKyBSb3VuZCAzKTpcbi8vICAgb3BlbiAgICAgICAgICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybCwgb3BlbiB0aGUgYnJvd3NlclxuLy8gICAgICAgICAgICAgICAgIC0tcHJvamVjdCA8aWQ+IHNjb3BlcyB0aGUgdXJsICg/cHJvamVjdD0pOyBvcGVuIG5ldmVyIG1pbnRzIOKAlFxuLy8gICAgICAgICAgICAgICAgIGFuIHVua25vd24gaWQgZXJyb3JzICh1c2UgcHJvamVjdHMgLS1jcmVhdGUgZmlyc3QpXG4vLyAgICAgICAgICAgICAgICAgLS1wb3J0IDxuPiBiaW5kcyBhIFNUQUJMRSBwb3J0IHNvIGEgYnJvd3NlciByZWZyZXNoIHJlY29ubmVjdHNcbi8vICAgICAgICAgICAgICAgICBhY3Jvc3MgYW4gZW52aXJvbm1lbnQtcmVhcCArIHJlc3RhcnQuIFR3byB3cmlua2xlczogKDEpIGFnYWluc3Rcbi8vICAgICAgICAgICAgICAgICBhIExJVkUgZGFlbW9uIC0tcG9ydCBOIGlzIElHTk9SRUQgKG9wZW4gcmV0dXJucyB0aGUgZXhpc3Rpbmdcbi8vICAgICAgICAgICAgICAgICBkYWVtb24pIOKAlCB0aGUgc3RhYmxlIHVybCBob2xkcyBvbmx5IGlmIHRoZSBGSVJTVCBvcGVuIHNldCBpdDtcbi8vICAgICAgICAgICAgICAgICAoMikgaWYgcG9ydCBOIGlzIGFscmVhZHkgaW4gdXNlIHRoZSBkYWVtb24gZXhpdHMgYW5kIHRoaXMgcG9sbFxuLy8gICAgICAgICAgICAgICAgIHRpbWVzIG91dCAoXCJkYWVtb24gZGlkIG5vdCBjb21lIHVwXCIpIOKAlCBwaWNrIGEgZnJlZSBwb3J0LlxuLy8gICBzdGF0ZSAgICAgICAgIEdFVCAvc3RhdGUg4oaSIHRoZSByZWFsIHByb2plY3Qgc25hcHNob3Qgb24gc3Rkb3V0XG4vLyAgICAgICAgICAgICAgICAgLS1za2VsZXRvbiByZXR1cm5zIGlkcy90aXRsZXMvZGVncmVlIG9ubHkgKGNvbnRleHQgYnVkZ2V0aW5nKVxuLy8gICAgICAgICAgICAgICAgIGZyZXNoIHN0b3JlIHdpdGggbm8gcHJvamVjdCDihpIgdGhlIG5lZWRzLXByb2plY3QgNDA5IHJpZGVzXG4vLyAgICAgICAgICAgICAgICAgdGhlIGVycm9yIGVudmVsb3BlIChjb25mbGljdCwgZXhpdCA2OyBib2R5IHVuZGVyIGVycm9yLnNlcnZlcilcbi8vICAgdGFpbCAgICAgICAgICBNb25pdG9yLXNoYXBlZDogR0VUIC9ldmVudHM/c2luY2U9PGN1cnNvcj4gU1NFIOKGkiBvbmUgSlNPTlxuLy8gICAgICAgICAgICAgICAgIGxpbmUgcGVyIGV2ZW50IG9uIHN0ZG91dFxuLy8gICAgICAgICAgICAgICAgIC0taW5ib3VuZCBmaWx0ZXJzIHNlcnZlci1zaWRlIHRvIGh1bWFuLW9yaWdpbmF0ZWQgZXZlbnRzXG4vLyAgICAgICAgICAgICAgICAgKGNoYXQgKyBkcm9wcGVkIG5vZGVzKSArIG9wZW5zIHdpdGggYSBraW5kOlwiZ3JvdW5kaW5nXCIgbGluZVxuLy8gICAgICAgICAgICAgICAgIC0tb25jZSBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCwgcHJpbnRzIGl0LCBleGl0c1xuLy8gICAgICAgICAgICAgICAgICh0aGUgcXVpZXQgaGFuZG9mZidzIGJhY2tncm91bmQgb25lLXNob3QpXG4vLyAgIHByb2plY3RzICAgICAgbGlzdCBzYXZlZCBwcm9qZWN0czsgLS1jcmVhdGUgPHRpdGxlPiBtYWtlcyBhIG5ldyBvbmVcbi8vICAgaW5nZXN0ICAgICAgICAtLXRpdGxlIFQgKC0tZmlsZSBQIHwgLS1zdGRpbikg4oaSIFBPU1QgL2luZ2VzdFxuLy8gICBwcm9wb3NlLW5vZGUgIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlLCBzdWdnZXN0ZWRUaWVyP30g4oaSIFBPU1QgL3Byb3Bvc2Fsc1xuLy8gICBwcm9wb3NlLWVkZ2UgIHNhbWUgc2hhcGUsIGtpbmQ6IFwiZWRnZVwiIChzb3VyY2UvdGFyZ2V0IG1heSBiZSBhIHJlYWwgbm9kZVxuLy8gICAgICAgICAgICAgICAgIGlkIE9SIGEgcGVuZGluZyBwcm9wb3NhbCdzIGlkIOKAlCByYXRpZnkgcmVzb2x2ZXMgdGhlIGxhdHRlcilcbi8vICAgICAgICAgICAgICAgICAtLXpvbmUgPGlkPiBzdGFnZXMgdGhlIHByb3Bvc2FsIGluIGEgem9uZVxuLy8gICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCAuLi59XSwgZWRnZXM6W3tkcmFmdDp7XG4vLyAgICAgICAgICAgICAgICAgc291cmNlLCB0YXJnZXQsIGxhYmVsP319XX0g4oCUIG9uZSB0cmFuc2FjdGlvbjsgYW4gZWRnZVxuLy8gICAgICAgICAgICAgICAgIGVuZHBvaW50IG1heSBiZSBhIG5vZGUncyBMT0NBTCBSRUYgKHJlc29sdmVkIHRvIHRoZSBtaW50ZWRcbi8vICAgICAgICAgICAgICAgICBpZCBzZXJ2ZXItc2lkZSksIGEgcmVhbCBub2RlIGlkLCBvciBhIHBlbmRpbmcgcHJvcG9zYWwgaWQuXG4vLyAgICAgICAgICAgICAgICAgUmV0dXJucyB7cmVmVG9JZCwgcHJvcG9zYWxzfVxuLy8gICByZWFkIDxpZD4gICAgIEdFVCAvbWVzc2FnZS86aWQg4oaSIHRoZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuLy8gICBub2RlIGFuY2hvciA8aWQ+ICgtLXRvIDxwYXJlbnRJZD4gfCAtLWNsZWFyKSAgUE9TVCAvbm9kZXMvOmlkL2FuY2hvciDigJRcbi8vICAgICAgICAgICAgICAgICBhbmNob3IgYSByZWFsIG5vZGUgdW5kZXIgYSBwYXJlbnQgaW4gdGhlIHN1Ym1hcCB0cmVlLCBvclxuLy8gICAgICAgICAgICAgICAgIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIHRvcC1sZXZlbCAoY3ljbGVzIHJlamVjdGVkKVxuLy8gICB6b25lICAgICAgICAgIGNyZWF0ZSA8bmFtZT4gKHNsdWcgaWQgZGVyaXZlZCkgfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXVxuLy8gICAgICAgICAgICAgICAgIChkZWxldGUgY2FzY2FkZXMgdGhlIHpvbmUncyBwcm9wb3NhbHM7IHBvcHVsYXRlZCB6b25lcyA0MDlcbi8vICAgICAgICAgICAgICAgICB3aXRob3V0IC0teWVzKVxuLy8gICBwcm9tb3RlIDxpZD4gIG1vdmUgYSB6b25lZCBwZW5kaW5nIHByb3Bvc2FsIHRvIHRoZSBtYWluIHJldmlldyBxdWV1ZVxuLy8gICAgICAgICAgICAgICAgIChlZGdlIGVuZHBvaW50cyBtdXN0IHByb21vdGUgZmlyc3Qg4oCUIGVycm9yIG5hbWVzIHRoZW0pXG4vLyAgIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpICBQT1NUIC9wcm9wb3NhbHMvOmlkL3pvbmUg4oCUXG4vLyAgICAgICAgICAgICAgICAgbW92ZSBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyBhIHpvbmUgKHRoZSBpbnZlcnNlIG9mIHByb21vdGUpLFxuLy8gICAgICAgICAgICAgICAgIG9yIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIG1haW5cbi8vICAgZG9jIDxpZD4gICAgICBHRVQgL2RvYy86aWQg4oaSIHRoZSBkb2MgZW52ZWxvcGUgb24gc3Rkb3V0LiBGbGFncyBtYXkgY29tZVxuLy8gICAgICAgICAgICAgICAgIGJlZm9yZSBkb2MncyBzdWItdmVyYiAoYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDFgKTsgYSBkb2Ncbi8vICAgICAgICAgICAgICAgICBsaXRlcmFsbHkgbmFtZWQgXCJkZWxldGVcIiBvciBcImtpbmRcIiByZWFkcyBhcyBgZG9jIC0tIGRlbGV0ZWBcbi8vICAgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSAgREVMRVRFIC9kb2MvOmlkIOKGkiA0MDkge2Vycm9yOlwiY2l0ZWRcIiwgY2l0ZWRCeX1cbi8vICAgICAgICAgICAgICAgICB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuLy8gICBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kPiBbLS1hdXRob3IgdXNlcnxhZ2VudF0gfCBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJcbi8vICAgICAgICAgICAgICAgICBQT1NUIC9kb2MvOmlkL2tpbmQg4oCUIGFzc2VydCAob3IgY2xlYXIpIGEgZG9jJ3Mga2luZDsgaW5nZXN0XG4vLyAgICAgICAgICAgICAgICAgbmV2ZXIgZ3Vlc3NlcyBvbmUgKHVudHlwZWQgPSBraW5kIG51bGwgb24gdGhlIHdpcmUpXG4vLyAgIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICBQT1NUIC9kb2MvOmlkL21hcmsg4oaSIGFwcGVuZCBhXG4vLyAgICAgICAgICAgICAgICAgc3RhdHVzIG1hcmsgKGRvYy5tYXJrZWQgY2FycmllcyB0aGUgZnVsbCBtYXJrIGlubGluZSlcbi8vICAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgIFBVVC9ERUxFVEVcbi8vICAgICAgICAgICAgICAgICAvYWN0aW9ucy86dGFyZ2V0SWQg4oCUIHJlcGxhY2UgKHdob2xlc2FsZSkgb3IgY2xlYXIgdGhlXG4vLyAgICAgICAgICAgICAgICAgYWN0aW9uIHNsb3RzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuXG4vLyAgICAgICAgICAgICAgICAgYXJyYXkgb2Yge2lkLCBsYWJlbCwgc2VlZH07ID40IGVudHJpZXMgd2FybnMgKHNvZnQgY2FwKVxuLy8gICB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgUFVUL0RFTEVURVxuLy8gICAgICAgICAgICAgICAgIC90YWdzLzp0YXJnZXRJZCDigJQgcmVwbGFjZSAod2hvbGVzYWxlKSBvciBjbGVhciB0aGUgZnJlZWZvcm1cbi8vICAgICAgICAgICAgICAgICB0YWdzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuIGFycmF5IG9mXG4vLyAgICAgICAgICAgICAgICAgc3RyaW5nczsgdGFncyBhbHNvIHJpZGUgcHJvcG9zZS0qIHN0ZGluIEpTT04gKGEgYHRhZ3NgIGtleSlcbi8vICAgam9iICAgICAgICAgICBjcmVhdGUgLS10aXRsZSBUIFstLXN0YXR1cyBzXSBbLS1kZWxpdmVyYWJsZSByZWZdIFstLWRldGFpbCB4XVxuLy8gICAgICAgICAgICAgICAgIHwgdXBkYXRlIDxpZD4gWy0tdGl0bGUvLS1zdGF0dXMvLS1kZWxpdmVyYWJsZS8tLWRldGFpbF1cbi8vICAgICAgICAgICAgICAgICB8IGNsYWltIDxpZD4gLS1vd25lciA8d2hvPiAoYXRvbWljIGxlYXNlOyA0MDkgaWYgaGVsZCBieVxuLy8gICAgICAgICAgICAgICAgICAgYW5vdGhlciBvd25lcikgfCByZWxlYXNlIDxpZD4gfCBzdWJ0YXNrIDxpZD4gKC0tYWRkIDxsYWJlbD5cbi8vICAgICAgICAgICAgICAgICAgIHwgLS1jaGVjayA8c3VidGFza0lkPiB8IC0tdW5jaGVjayA8c3VidGFza0lkPikgfCBsaXN0XG4vLyAgICAgICAgICAgICAgICAgfCBkZWxldGUgPGlkPi4gQSBwZXJzaXN0ZWQgdW5pdCBvZiBBR0VOVCBXT1JLIChzdGF0dXMgK1xuLy8gICAgICAgICAgICAgICAgIHN1Yi10YXNrcyArIGRlbGl2ZXJhYmxlICsgb3duZXIpOyBjcmVhdGUvdXBkYXRlIGFsc28gdGFrZSBhXG4vLyAgICAgICAgICAgICAgICAgZnVsbCBKU09OIGJvZHkgdmlhIC0tc3RkaW4gLyAtLWJvZHktZmlsZVxuLy8gICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gIFBPU1QgL2FjdGl2aXR5IOKGkiBmaXJlLWFuZC1mb3JnZXRcbi8vICAgICAgICAgICAgICAgICBhZ2VudC5hY3Rpdml0eSBzaWduYWwgKH42MHMgVFRMIGVtaXRzIHN5bnRoZXRpYyBpZGxlKVxuLy8gICBzZWFyY2ggPHEuLi4+IEdFVCAvc2VhcmNoIOKGkiB7aGl0czogW3traW5kOiBub2RlfGRvY3xtZXNzYWdlLCAuLi59XX1cbi8vICAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gIEdFVCAvbmVpZ2hib3JzLzppZCDihpIgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuLy8gICByYXRpZnkgPGlkPiAtLXJ1bGluZyBjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWx8cmVqZWN0IFstLWRvYy1lZGl0IDxmaWxlPl1cbi8vICAgICAgICAgICAgICAgICBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSAgcmF0aWZ5LXRpbWUgZXZpZGVuY2UgYXR0YWNoOlxuLy8gICAgICAgICAgICAgICAgIGZvciBhbiBFVklERU5DRS1MRVNTIG5vZGUgcHJvcG9zYWwgb25seSwgLS1kb2MgbmFtZXMgdGhlIGRvY1xuLy8gICAgICAgICAgICAgICAgIGhvbWUgKG11c3QgZXhpc3Q7IHJlcXVpcmVzIC0tZG9jLWVkaXQpIGFuZCBtaW50cyB0aGUgbm9kZSdzXG4vLyAgICAgICAgICAgICAgICAgc291cmNlcyByb3cgd2l0aCB0aGUgb3B0aW9uYWwgLS1zcGFuIGV4Y2VycHRcbi8vICAgbGVucyBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGRvY0lkPikgfCBsZW5zIGNsZWFyXG4vLyAgIGxvb2staGVyZSA8bm9kZUlkPiAgZmlyZS1vbmNlIGF0dGVudGlvbiBudWRnZSwgbm90IHBlcnNpc3RlZFxuLy8gICBzZW5kICAgICAgICAgIGJvZHkgY2hhaW46IC0tYm9keS1maWxlIDxwYXRoPiA+IC0tc3RkaW4gPiBpbmxpbmUgPHRleHQuLi4+ID5cbi8vICAgICAgICAgICAgICAgICBwaXBlZCBzdGRpbjsgWy0tcm9sZSB1c2VyfGFnZW50XSBbLS1raW5kXSBbLS1ncm91bmQgYSxiXVxuLy8gICAgICAgICAgICAgICAgIChyZXBlYXRhYmxlIOKAlCByZXBlYXRzIGFjY3VtdWxhdGUsIGNvbW1hcyBzcGxpdCBlaXRoZXIgd2F5KVxuLy8gICAgICAgICAgICAgICAgIFstLWZvcmNlXSDihpIgUE9TVCAvc2VuZC4gRW1wdHkgcmVzb2x2ZWQgYm9keSA9IHVzYWdlIGVycm9yLiBUaGVcbi8vICAgICAgICAgICAgICAgICBwaXBlZCBkZWZhdWx0IEhBTkdTIHdpdGggbm8gcGlwZSB1bmRlciBhZ2VudCBzaGVsbHMg4oCUIGFsd2F5c1xuLy8gICAgICAgICAgICAgICAgIHBhc3MgYSBib2R5ICgtLWJvZHktZmlsZSBwcmVmZXJyZWQgZm9yIHByb3NlKS5cbi8vICAgICAgICAgICAgICAgICBSMTE6IC0ta2luZCBpcyB0aGUgQ0hBTk5FTCB0aGUgbWVzc2FnZSBhcnJpdmVkIHRocm91Z2hcbi8vICAgICAgICAgICAgICAgICAodHVybnxhbmFseXplfGNhbnZhczsgb3BlbiBzZXQg4oCUIGFuIHVua25vd24gb25lIGlzIHN0b3JlZFxuLy8gICAgICAgICAgICAgICAgIHdpdGggYSBzdGRlcnIgYWR2aXNvcnksIG5ldmVyIHJlamVjdGVkKS5cbi8vICAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gIOKGkiBQT1NUIC9hY3Rpdml0eS4gVGhlXG4vLyAgICAgICAgICAgICAgICAgbWVzc2FnZUlkIHRpZXMgdGhlIHNpZ25hbCB0byBPTkUgbWVzc2FnZSBzbyB0aGUgaHVtYW4gc2Vlc1xuLy8gICAgICAgICAgICAgICAgIHdoaWNoIG9uZSBpcyBiZWluZyB3b3JrZWQ7IG9taXR0ZWQsIGl0IGluaGVyaXRzIHRoZSBvcGVuXG4vLyAgICAgICAgICAgICAgICAgbGFkZGVyJ3MgbWVzc2FnZS4gaWRsZSBjbG9zZXMgdGhlIGxhZGRlciAodGhlcmUgaXMgbm8gYGRvbmVgXG4vLyAgICAgICAgICAgICAgICAg4oCUIGFuIGFnZW50IGBzZW5kYCBJUyB0aGUgY29tcGxldGlvbiBzaWduYWwpLlxuLy9cbi8vIC0tcHJvamVjdCA8aWQ+IGlzIGFjY2VwdGVkIGJ5IGV2ZXJ5IHZlcmIgYWJvdmUgZXhjZXB0IHByb2plY3RzIChzY29wZXMgdG8gYVxuLy8gbm9uLWRlZmF1bHQgcHJvamVjdDsgb21pdCBmb3IgdGhlIGRlZmF1bHQgcHJvamVjdCkuXG4vL1xuLy8gRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgc3RhdGVkIE9OQ0Ug4oCUIHBlci12ZXJiIHByb3NlIGFib3ZlIG5hbWVzIEhUVFBcbi8vIHN0YXR1c2VzLCB0aGlzIHRhYmxlIGlzIHdoYXQgdGhlIFBST0NFU1MgZG9lcyB3aXRoIHRoZW0pOiBldmVyeSBmYWlsdXJlIGlzXG4vLyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgZW1wdHkg4oCUXG4vLyAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sXG4vLyAgICBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4vLyAgIHVzYWdlIOKGkiBleGl0IDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IChIVFRQIDQwNCkgwrcgY29uZmxpY3Qg4oaSIDZcbi8vICAgKEhUVFAgNDA5KTsgSFRUUCA0MDAgbWFwcyB0byB1c2FnZS4gQSBkYWVtb24gcmVmdXNhbCBjYXJyaWVzIHRoZSBzZXJ2ZXInc1xuLy8gICBvd24gSlNPTiBib2R5IFZFUkJBVElNIHVuZGVyIGVycm9yLnNlcnZlciAobmVlZHMtcHJvamVjdCwgY2l0ZWQsIHpvbmVkLFxuLy8gICB6b25lLW5vdC1lbXB0eSwgY2xhaW0gY29uZmxpY3RzLCDigKYpIOKAlCBicmFuY2ggb24ga2luZC9zZXJ2ZXIsIG5ldmVyIHByb3NlLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICB0eXBlIENvbW1hbmRTcGVjLFxuICBkZWZpbmVDbGksXG4gIHR5cGUgSW52b2NhdGlvbixcbiAgdHlwZSBQb3NpdGlvbmFsU3BlYyxcbn0gZnJvbSBcIi4uLy4uL2tpdC9jbGkvcmVnaXN0cnkudHNcIjtcbmltcG9ydCB7XG4gIEVYSVRfRk9SLFxuICBlcnJvckVudmVsb3BlLFxuICBnZXRDdXJyZW50Q29tbWFuZCxcbiAgQ2xpRXJyb3IgYXMgS2l0Q2xpRXJyb3IsXG4gIHR5cGUgRXJyS2luZCBhcyBLaXRFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHJlYWRTaW5jZSxcbiAgdGFpbENvbW1hbmQsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZi50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TLCBUQUlMX1JFVFJZX01BWF9NUywgVEFJTF9SRVRSWV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG4vLyDim5QgRVZFUlkgUEFUSCBCRUxPVyBJUyBDT01QVVRFRCBGUk9NIFRIRSBBUlRJRkFDVCdTIEFERFJFU1MsIFdISUNIIElTXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21pbmQtbWFwcGVyL2Rpc3QvY2xpLmpzYCDigJQgTk9UIEZST00gVEhJUyBTT1VSQ0Vcbi8vIEZJTEUuIFRoYXQgaXMgd2hhdCBtYWtlcyB0aGUgYGltcG9ydC5tZXRhLm1haW5gIGJsb2NrJ3MgYWJzZW5jZSBhdCB0aGUgYm90dG9tXG4vLyBvZiB0aGlzIGZpbGUgYSByZXF1aXJlbWVudCByYXRoZXIgdGhhbiBhIHRpZHk6IHJ1biBmcm9tXG4vLyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvYCB0aGVzZSByZXNvbHZlIGludG8gYHNyYy9taW5kLW1hcHBlci9gLCB3aGljaCBoYXMgbm9cbi8vIGBkaXN0L2luZGV4Lmh0bWxgLCBzbyB0aGUgQ0xJIHdvdWxkIGNob29zZSBERVYgYW5kIHRoZW4gc3Bhd24gYSBkYWVtb24gZnJvbVxuLy8gdGhlIHdyb25nIGFuY2hvci4gYGRpc3QvYCBzaXRzIGF0IHRoZSBzYW1lIGRlcHRoIHVuZGVyIHRoZSBza2lsbCByb290IGFzIHRoZVxuLy8gYHNjcmlwdHMvYCBpdCByZXBsYWNlZCwgc28gZXZlcnkgYW5jZXN0b3IgY2xpbWIgYmVsb3cgaXMgdW5jaGFuZ2VkIOKAlCBhXG4vLyBDT0lOQ0lERU5DRSBPRiBERVBUSCwgYXNzZXJ0ZWQgYnkgYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByYXRoZXJcbi8vIHRoYW4gdHJ1c3RlZCAocGxheWJvb2sgQjQvQjUpLlxuY29uc3QgU0NSSVBUX0RJUiA9IGltcG9ydC5tZXRhLmRpcjtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBOT1QgQSBGTEFUIFNJQkxJTkcuIFRoaXMgd2FzIGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgdW50aWwgdGhlIGJhY2tlbmQgcG9ydCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IHNoYXBlLFxuLy8gY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tIGBkaXN0L2AgdGhlXG4vLyBmbGF0IGZvcm0gbmFtZXMgYGRpc3Qvc2VydmVyLnRzYCwgd2hpY2ggZG9lcyBub3QgZXhpc3Q7IHRoZSBzeW1wdG9tIGlzIG5vdCBhXG4vLyBjcmFzaCBidXQgYGVuc3VyZURhZW1vbmAncyBwb2xsIHJ1bm5pbmcgb3V0IHRvIFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW5cbi8vIDEwc1wiLiBUaGUgbGF1bmNoZXIgaXMgdGhlIHByb2Nlc3MgYSBjYWxsZXIgcnVucywgYW5kIGl0IGxpdmVzIGluIGBzY3JpcHRzL2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2U7IEJ1biByZWFkcyBidW5maWcudG9tbFxuLy8gKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2QgTVVTVCBiZVxuLy8gc3JjL21pbmQtbWFwcGVyLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBwYWdlIDUwMHM7XG4vLyBtaW5kLW1hcHBlcidzIG93biBmYWlsdXJlIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnXG4vLyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lXG4vLyBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkIGJyZWFrIHNwYXduLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1pbmQtbWFwcGVyXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuY29uc3QgSE9NRSA9IHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLm1pbmQtbWFwcGVyXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihIT01FLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKEhPTUUsIFwiZGFlbW9uLnBpZFwiKTtcblxuZnVuY3Rpb24gbGl2ZVBvcnQoKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpIHx8ICFleGlzdHNTeW5jKFBJRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpZCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUElEX0ZJTEUsIFwidXRmOFwiKS50cmltKCksIDEwKTtcbiAgY29uc3QgcG9ydCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0ZjhcIikudHJpbSgpLCAxMCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHBpZCkgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKHBpZCwgMCk7IC8vIGxpdmVuZXNzIHByb2JlLCBubyBzaWduYWwgZGVsaXZlcmVkXG4gICAgcmV0dXJuIHBvcnQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsOyAvLyBzdGFsZSBkaXNjb3ZlcnkgZmlsZXNcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24ocG9ydD86IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJ1bm5pbmcgPSBsaXZlUG9ydCgpO1xuICAvLyBSb3VuZCA3IChQT1JUKTogYSBsaXZlIGRhZW1vbiBJR05PUkVTIC0tcG9ydCDigJQgdGhlIHN0YWJsZS11cmwgZ3VhcmFudGVlXG4gIC8vIG9ubHkgaG9sZHMgaWYgdGhlIEZJUlNUIG9wZW4gc2V0IHRoZSBwb3J0ICh0aGUgZGFlbW9uIGJpbmRzIG9uY2UgYXQgYm9vdCkuXG4gIGlmIChydW5uaW5nICE9PSBudWxsKSByZXR1cm4gcnVubmluZztcbiAgY29uc3QgcHJvYyA9IHNwYXduKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCIsIC4uLihwb3J0ID8gW1wiLS1wb3J0XCIsIFN0cmluZyhwb3J0KV0gOiBbXSldLFxuICAgIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICAgIH0sXG4gICk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gUG9sbCBkaXNjb3ZlcnkgdW50aWwgdGhlIGRhZW1vbiB3cml0ZXMgaXRzIHBvcnQgKGNvbGQgQnVuIGJ1bmRsZSBjYW4gbGFnKS5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwMCkpO1xuICAgIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICAgIGlmIChwb3J0ICE9PSBudWxsKSByZXR1cm4gcG9ydDtcbiAgfVxuICB0aHJvdyBuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBcImRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDEwc1wiKTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY21kID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gIHNwYXduKGNtZCwgW3VybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG59XG5cbi8vIOKblCBgZW52TXNgIElTIEdPTkUsIEFORCBJVFMgVFdPIEtOT0JTIE1PVkVEIFJBVEhFUiBUSEFOIERJU0FQUEVBUkVELlxuLy8gYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCBhcmUgcmVzb2x2ZWQgaW5cbi8vIGAuL2hlYXJ0YmVhdC50c2Ag4oCUIHRoZSBzZWFtIGZpbGUgQk9USCBoYWx2ZXMgaW1wb3J0IOKAlCBiZWNhdXNlIHRoZSB3YXRjaGRvZyBpc1xuLy8gREVSSVZFRCBmcm9tIHRoZSBkYWVtb24ncyBiZWF0IGFuZCBhIGtub2IgcmVzb2x2ZWQgYWJvdmUgdGhlIGRlcml2YXRpb24gc3BsaXRzXG4vLyB0aGUgcGFpciBzaWxlbnRseSwgaW52aXNpYmx5IGF0IHRoZSBkZWZhdWx0IChENzUpLlxuXG4vLyDilIDilIAgdGhlIGZhaWx1cmUgY29udHJhY3Q6IFRIRSBIT1VTRSdTIE9ORSBDT1BZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBERS1EVVBMSUNBVEVELCBBTkQgTUlORC1NQVBQRVIgSVMgT05FIE9GIFRIRSBUV08gU1BFTExTIFRISVMgTU9EVUxFJ1MgT1dOXG4vLyBIRUFERVIgTkFNRVMgQVMgSEFWSU5HIFJFQUNIRUQgSVRTIFNIQVBFIElOREVQRU5ERU5UTFkgKGBlcnJvcnMudHM6MzNgOlxuLy8gXCJnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDBcbi8vIHBhc3Nlc1wiKS4gVGhlIGRlbHRhIG9uIHRoZSBXSVJFIGlzIE5JTCwgYW5kIHRoYXQgaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhblxuLy8gYSBob3BlOiB0aGUgYEVycktpbmRgIHVuaW9uIHdhcyBjaGFyYWN0ZXItZm9yLWNoYXJhY3RlciBpZGVudGljYWwsIGBFWElUX0ZPUmBcbi8vIHdhcyB0aGUgc2FtZSBgMi8xLzUvNmAsIGFuZCB0aGUgZW52ZWxvcGUgaGFkIHRoZSBzYW1lIGtleXMgaW4gdGhlIHNhbWUgb3JkZXJcbi8vIOKAlCBge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1gIOKAlCBpbmNsdWRpbmcgYHNlcnZlcmAgTEFTVCwgd2hpY2ggdGhlIGtpdCdzIG93blxuLy8gY29tbWVudCBzYXlzIGlzIGRlbGliZXJhdGUgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCBpdCBrZWVwcyBpdHMgYnl0ZVxuLy8gb3JkZXIuIOKaoCBPTkUgbGF0ZW50IGRpZmZlcmVuY2UsIGNoZWNrZWQgYW5kIGVtcHR5OiB0aGUga2l0IGd1YXJkcyBgaGludGAgYW5kXG4vLyBgY2hvaWNlc2Agb24gVFJVVEhJTkVTUyB3aGVyZSB0aGlzIGZpbGUgZ3VhcmRlZCBvbiBQUkVTRU5DRSwgc28gYVxuLy8gYGhpbnQ6IFwiXCJgIHdvdWxkIHNoaXAgZnJvbSBvbmUgYW5kIG5vdCB0aGUgb3RoZXIuIEdyZXBwZWQ6IHRoaXMgQ0xJIGhhcyBub1xuLy8gZW1wdHktc3RyaW5nIGhpbnQgYXQgYW55IG9mIGl0cyA2NCByYWlzZSBzaXRlcywgc28gdGhlIHBvcHVsYXRpb25zIGFncmVlLlxuLy9cbi8vIG1pbmQtbWFwcGVyIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0XG4vLyBFVkVSWSBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXNcbi8vIHByZXNlbnRhdGlvbiDigJQgcmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzXG4vLyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBEZWxpdmVyeSBpcyBib3VudHkncywgbm90IG1hZ3BpZSdzOiBUSFJPV1xuLy8gYW5kIGxldCBtYWluKCkgY2F0Y2ggYW5kIFJFVFVSTiB0aGUgY29kZSDigJQgdGhpcyBDTEkgc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4vLyBwYXlsb2FkcywgYW5kIGEgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgYGRpZSgpYCB3b3VsZCB0cnVuY2F0ZSB0aGVtIGF0IDY1LDUzNlxuLy8gYnl0ZXMgKHNlZSB0aGUgZHJhaW4gaWRpb20gYXQgdGhlIGJvdHRvbSBvZiB0aGlzIGZpbGUpLiBUaGUga2l0J3MgYGRpZWBcbi8vIHRocm93cyBmb3IgZXhhY3RseSB0aGF0IHJlYXNvbiwgc28gdGhlIGFkb3B0aW9uIGNoYW5nZXMgbm8gZGVsaXZlcnkgZWl0aGVyLlxuLy9cbi8vIOKblCBBTkQgVEhJUyBJUyBUSEUgT05FIFNURVAgT0YgVEhFIFdIT0xFIFBIQVNFIFdIRVJFIFRIRSBLSVQgSVMgTUVBU1VSQUJMWVxuLy8gV0VBS0VSLCBXSElDSCBJUyBXSFkgVEhFIFRSSUFHRSBDSEFJTiBJTiBgbWFpbmAgQkVMT1cgSVMgS0VQVCBBTkQgTk9UXG4vLyBSRVBMQUNFRC4gYGVycm9ycy50c2AgaXMgVFdPIHRoaW5ncyDigJQgYW4gRU5WRUxPUEUgYW5kIGEgQ0xBU1NJRklFUiDigJQgYW5kIG9ubHlcbi8vIHRoZSBlbnZlbG9wZSBjb252ZXJnZWQuIGByZXBvcnRDbGlFcnJvcmAgcmV0dXJucyBgbnVsbGAgZm9yIGFueXRoaW5nIHRoYXQgaXNcbi8vIG5vdCBhIGBDbGlFcnJvcmAgYW5kIGRlbWFuZHMgdGhlIGNhbGxlciByZXRocm93OyB0aGlzIENMSSB0cmlhZ2VzIFRIUkVFXG4vLyBkb2N1bWVudGVkIHVzYWdlIGNsYXNzZXMgb3V0IG9mIHJhdyB0aHJvd3MgKGBFUlJfUEFSU0VfQVJHUypgLCBhXG4vLyBgU3ludGF4RXJyb3JgIGZyb20gYSBKU09OIGJvZHksIGFuZCBgRU5PRU5UYCBvbiBhIG5hbWVkIGZpbGUpLiBBZG9wdGluZyB0aGVcbi8vIGNsYXNzaWZpZXIgbmFpdmVseSB3b3VsZCByZWdyZXNzIGFsbCB0aHJlZSBpbnRvIGEgc3RhY2stdHJhY2UgY3Jhc2gg4oCUIHRoZVxuLy8gZXhhY3QgZGVmZWN0IHRoaXMgZmlsZSdzIG93biBjb21tZW50IHJlY29yZHMgYXMgY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nLFxuLy8gcmUtY3JlYXRlZCBieSB0aGUgYWRvcHRpb24gbWVhbnQgdG8gc3RhbmRhcmRpc2UgaXQuIFNvIGByZXBvcnRDbGlFcnJvcmAgaXNcbi8vIGNhbGxlZCBJTlNJREUgdGhlIGNoYWluLCBhdCB0aGUgcG9zaXRpb24gdGhlIGNoYWluIHJlYWNoZXMgZm9yIGEgdHlwZWRcbi8vIGZhaWx1cmUsIGFuZCB0aGUgY2hhaW4ga2VlcHMgdGhlIHRocmVlIGJyYW5jaGVzIHRoZSBraXQgZG9lcyBub3QgY2FycnkuXG50eXBlIEVycktpbmQgPSBLaXRFcnJLaW5kO1xuXG4vKipcbiAqIG1pbmQtbWFwcGVyJ3MgcmFpc2UgdHlwZSBpcyBub3cgdGhlIGtpdCdzIGBDbGlFcnJvcmAsIHJlLWV4cG9ydGVkIHVuZGVyIHRoZVxuICogbmFtZSA2MiBjYWxsIHNpdGVzIGFscmVhZHkgdXNlLiDimqAgVGhlIEZJRUxEIFNIQVBFIGRpZmZlcnM6IHRoaXMgZmlsZSdzIGNsYXNzXG4gKiBoZWxkIGBoaW50YC9gY2hvaWNlc2AvYHNlcnZlcmAgYXMgb3duIHByb3BlcnRpZXMgYW5kIHRoZSBraXQgaG9sZHMgdGhlbSBpbiBhblxuICogYGV4dHJhYCBiYWcsIHNvIHRoZSBjb25zdHJ1Y3RvciBiZWxvdyBhZGFwdHMgcmF0aGVyIHRoYW4gdGhlIGNhbGwgc2l0ZXNcbiAqIGNoYW5naW5nIOKAlCBhIHJlbG9jYXRpb24tc2hhcGVkIGVkaXQgYXQgNjIgc2l0ZXMgaW5zaWRlIGEgY2hhcHRlciB0aXRsZWRcbiAqIFwiYmVoYXZpb3VyIGNoYW5nZXMsIGFuZCBlYWNoIGNoYW5nZSBpcyBuYW1lZFwiIGlzIGhvdyBhIHJlYWwgY2hhbmdlIGhpZGVzLlxuICovXG5jbGFzcyBDbGlFcnJvciBleHRlbmRzIEtpdENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAga2luZDogRXJyS2luZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9LFxuICApIHtcbiAgICBzdXBlcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuY29uc3QgdXNhZ2VFcnJvciA9IChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkgPT5cbiAgbmV3IENsaUVycm9yKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuXG4vKipcbiAqIFJlcG9ydCBvbmUgb2YgdGhlIHRocmVlIFJBVyB0aHJvd3MgdGhlIGtpdCdzIGNsYXNzaWZpZXIgZG9lcyBub3QgcmVjb2duaXNlIGFzXG4gKiBhIGB1c2FnZWAgZW52ZWxvcGUsIGFuZCBoYW5kIGJhY2sgaXRzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgVEhFIENMQVNTSUZJRVIgSVMgVEhFIEhBTEYgVEhBVCBESUQgTk9UIENPTlZFUkdFLiBUaGVzZVxuICogdGhyZWUgYXJlIG5vdCBgQ2xpRXJyb3JgcyDigJQgdGhleSBhcmUgYSBgbm9kZTp1dGlsYCBwYXJzZSByZWplY3Rpb24sIGFcbiAqIGBTeW50YXhFcnJvcmAgb3V0IG9mIGBKU09OLnBhcnNlYCwgYW5kIGFuIGBFTk9FTlRgIGZyb20gYSBuYW1lZCBwYXRoIOKAlCBhbmRcbiAqIGByZXBvcnRDbGlFcnJvcmAgYW5zd2VycyBgbnVsbGAgZm9yIGFsbCB0aHJlZS4gUm91dGluZyB0aGVtIHRocm91Z2ggdGhlXG4gKiBFTlZFTE9QRSAod2hpY2ggZGlkIGNvbnZlcmdlKSBpcyB0aGUgd2hvbGUgb2YgdGhlIHJlcGFpcjogc2FtZSBieXRlcyBvblxuICogc3RkZXJyLCBzYW1lIGV4aXQgMiwgYW5kIHRoZSB0cmlhZ2Ugc3RheXMgd2hlcmUgdGhlIHNwZWxsIGNhbiBzZWUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlcG9ydFVzYWdlKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KTogbnVtYmVyIHtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKSk7XG4gIHJldHVybiBFWElUX0ZPUi51c2FnZTtcbn1cblxuLy8gVGhlIG9uZSBleGl0IGZvciBldmVyeSBkYWVtb24gcm91bmQtdHJpcDogb2sg4oaSIHRoZSBib2R5IHRleHQgKGNhbGxlciBwcmludHNcbi8vIGl0IG9uIHN0ZG91dCksIHJlZnVzZWQg4oaSIGEgdHlwZWQgQ2xpRXJyb3Igd2hvc2Uga2luZCBtYXBzIG9mZiB0aGUgSFRUUFxuLy8gc3RhdHVzIGFuZCB3aG9zZSBgc2VydmVyYCBmaWVsZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gSlNPTiBib2R5LlxuYXN5bmMgZnVuY3Rpb24gcGFzc09yVGhyb3cocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICBpZiAocmVzLm9rKSByZXR1cm4gdGV4dDtcbiAgbGV0IHNlcnZlcjogdW5rbm93biA9IHRleHQ7XG4gIHRyeSB7XG4gICAgc2VydmVyID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gZGFlbW9uIGJvZHkgcmlkZXMgYXMgdGhlIHJhdyBzdHJpbmcgKi9cbiAgfVxuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICByZXMuc3RhdHVzID09PSA0MDRcbiAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgOiByZXMuc3RhdHVzID09PSA0MDlcbiAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgOiByZXMuc3RhdHVzID09PSA0MDBcbiAgICAgICAgICA/IFwidXNhZ2VcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgYCR7Z2V0Q3VycmVudENvbW1hbmQoKSA/PyBcInJlcXVlc3RcIn0gcmVmdXNlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHtcbiAgICBzZXJ2ZXIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlRGFlbW9uKCk6IG51bWJlciB7XG4gIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICBpZiAocG9ydCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBDbGlFcnJvcihcIm5vdF9mb3VuZFwiLCBcIm5vIGRhZW1vbiBydW5uaW5nICh1c2UgYG9wZW5gIGZpcnN0KVwiKTtcbiAgfVxuICByZXR1cm4gcG9ydDtcbn1cblxuLy8gU2tlbGV0b24gcHJvamVjdGlvbiDigJQgaWRzL3RpdGxlcy9kZWdyZWUgb25seSwgbm8gc3lub3BzaXMvY29udGVudC4gS2VwdCBhc1xuLy8gYSBjbGllbnQtc2lkZSB0cmFuc2Zvcm0gKHRoZSBkYWVtb24gc3RheXMgZHVtYiBhbmQgYWx3YXlzIHNlcnZlcyB0aGUgZnVsbFxuLy8gc25hcHNob3Q7IHNrZWxldG9uIGlzIGEgY291cnRlc3kgc2hhcGUgZm9yIGNvbnRleHQtYnVkZ2V0ZWQgYWdlbnQgcmVhZHMpLlxuZnVuY3Rpb24gdG9Ta2VsZXRvbihzdGF0ZToge1xuICBub2RlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBraW5kOiBzdHJpbmc7IHRpZXI6IHN0cmluZyB9PjtcbiAgZWRnZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgc291cmNlOiBzdHJpbmc7IHRhcmdldDogc3RyaW5nIH0+O1xufSkge1xuICBjb25zdCBkZWdyZWUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2Ygc3RhdGUuZWRnZXMpIHtcbiAgICBkZWdyZWUuc2V0KGUuc291cmNlLCAoZGVncmVlLmdldChlLnNvdXJjZSkgPz8gMCkgKyAxKTtcbiAgICBkZWdyZWUuc2V0KGUudGFyZ2V0LCAoZGVncmVlLmdldChlLnRhcmdldCkgPz8gMCkgKyAxKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG5vZGVzOiBzdGF0ZS5ub2Rlcy5tYXAoKG4pID0+ICh7XG4gICAgICBpZDogbi5pZCxcbiAgICAgIHRpdGxlOiBuLnRpdGxlLFxuICAgICAga2luZDogbi5raW5kLFxuICAgICAgdGllcjogbi50aWVyLFxuICAgICAgZGVncmVlOiBkZWdyZWUuZ2V0KG4uaWQpID8/IDAsXG4gICAgfSkpLFxuICB9O1xufVxuXG4vLyDilIDilIAgdGhlIGZsYWcgcmVnaXN0cnkgKyB0aGUgY29tbWFuZCB0YWJsZSwgT04gVEhFIEtJVCBSRUdJU1RSWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS4gRXZlcnkgaW52b2NhdGlvbiBpcyBwYXJzZWQgc3RyaWN0XG4vLyBhZ2FpbnN0IHRoaXMgd2hvbGUgdGFibGUsIHNvIGEgdG9rZW4gbWluZC1tYXBwZXIgaGFzIG5ldmVyIGhlYXJkIG9mIGlzXG4vLyByZWZ1c2VkIGFzIFVOS05PV047IHRoZSByZWdpc3RyeSB0aGVuIGFza3MgdGhlIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OlxuLy8gaXMgdGhpcyBmbGFnIGFjY2VwdGVkIEFUIFRISVMgVkVSQi4gQSByZWNvZ25pemVkIGZsYWcgb24gdGhlIHdyb25nIHZlcmIgaXNcbi8vIHJlZnVzZWQgYXMgTUlTUExBQ0VEIChgc3RhdGUgLS1ydWxpbmdgIGlzIG5vdCBhIHR5cG8pLCBhbmQgYm90aCByZWplY3Rpb25zXG4vLyBjYXJyeSB0aGF0IHZlcmIncyBhY2NlcHRlZCBzZXQgYXMgYGNob2ljZXNgLlxuLy9cbi8vIE5PIERFRkFVTFRTIGluIHRoZSB0YWJsZTogcGVyLXZlcmIgZGVmYXVsdHMgbGl2ZSBhdCB0aGUgY29uc3VtcHRpb24gc2l0ZVxuLy8gKGA/PyBcImFnZW50XCJgLCBgPz8gXCIxXCJgKSwgd2hlcmUgdGhlIGRhZW1vbidzIGNvbnRyYWN0IGlzIHdyaXR0ZW4uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYWRkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYW5jaG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYXV0aG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYmF0Y2g6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hlY2s6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBjcmVhdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkZWxpdmVyYWJsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRlcHRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZGV0YWlsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJkb2MtZWRpdFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZmlsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIC8vIHNlbmQgLS1ncm91bmQgaXMgcGFyc2VBcmdzLWBtdWx0aXBsZWAgQlkgU0VBTSAoQ29udHJhY3QgOSBSNDogcmVwZWF0c1xuICAvLyBhY2N1bXVsYXRlLCBjb21tYXMgc3BsaXQpIOKAlCBhbnkgdmVyYiBjb3B5aW5nIHRoZSBwYXR0ZXJuIGNvcGllcyB0aGlzIHRvby5cbiAgZ3JvdW5kOiB7IHR5cGU6IFwic3RyaW5nXCIsIG11bHRpcGxlOiB0cnVlIH0sXG4gIGluYm91bmQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1lc3NhZ2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBub2RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9uY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgb3duZXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvamVjdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJvbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBydWxpbmc6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNrZWxldG9uOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHNwYW46IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzeW5vcHNpczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB1bmNoZWNrOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgeWVzOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHpvbmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxudHlwZSBPcHRzID0gdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFnID0ga2V5b2YgT3B0cyAmIHN0cmluZztcbi8qKiBUaGUgcGFyc2VkIHZhbHVlcywgdHlwZWQgb2ZmIHRoZSB0YWJsZTogYSBgbXVsdGlwbGVgIGZsYWcgaXMgYW4gYXJyYXksIGFcbiAqICBzdHJpbmcgZmxhZyBhIHN0cmluZywgYSBib29sZWFuIGZsYWcgYSBib29sZWFuLiAqL1xudHlwZSBGbGFncyA9IHtcbiAgLXJlYWRvbmx5IFtLIGluIEZsYWddPzogT3B0c1tLXSBleHRlbmRzIHsgbXVsdGlwbGU6IHRydWUgfVxuICAgID8gc3RyaW5nW11cbiAgICA6IE9wdHNbS11bXCJ0eXBlXCJdIGV4dGVuZHMgXCJzdHJpbmdcIlxuICAgICAgPyBzdHJpbmdcbiAgICAgIDogYm9vbGVhbjtcbn07XG4vKiogV2hhdCBldmVyeSBoYW5kbGVyIGJlbG93IHJlYWRzIOKAlCB0aGUgc2hhcGUgYHBhcnNlQXJnc2AgdXNlZCB0byBoYW5kIHRoZW0sXG4gKiAgc28gZWFjaCBib2R5IG1vdmVkIG9udG8gdGhlIHJlZ2lzdHJ5IHVuY2hhbmdlZC4gKi9cbnR5cGUgUGFyc2VkID0geyB2YWx1ZXM6IEZsYWdzOyBwb3NpdGlvbmFsczogc3RyaW5nW10gfTtcbmNvbnN0IG9uID1cbiAgKGg6IChwYXJzZWQ6IFBhcnNlZCkgPT4gdW5rbm93bikgPT5cbiAgKGludjogSW52b2NhdGlvbjxGbGFnPik6IHVua25vd24gPT5cbiAgICBoKHsgdmFsdWVzOiBpbnYuZmxhZ3MgYXMgRmxhZ3MsIHBvc2l0aW9uYWxzOiBpbnYucG9zIH0pO1xuXG4vKipcbiAqIGBhY3Rpdml0eSA8c3RhdGU+YCdzIGFjY2VwdGVkIHZhbHVlcyDigJQgdGhlIG9uZSBFTlVNRVJBVEVEIFBPU0lUSU9OQUwgaW4gdGhpc1xuICogQ0xJLCBhbmQgdGhlIG9uZSBjbG9zZWQgc2V0IHRoYXQgd2FzIG5vdCBhbHJlYWR5IHB1Ymxpc2hlZCBhcyBgY2hvaWNlc2AuXG4gKi9cbmV4cG9ydCBjb25zdCBBQ1RJVklUWV9TVEFURVMgPSBbXCJyZWNlaXZlZFwiLCBcInRoaW5raW5nXCIsIFwiaWRsZVwiXSBhcyBjb25zdDtcblxuY29uc3QgSEVMUCA9IGBtaW5kLW1hcHBlciDigJQgYSBjby1wcmVzZW50IGtub3dsZWRnZSBtYXA6IGEgZHVtYiBkYWVtb24gaG9sZHMgdGhlIGdyYXBoLCB0aGUgY2FzdGluZyBhZ2VudCBkb2VzIHRoZSB0aGlua2luZy5cblxuICBvcGVuICAgWy0tcHJvamVjdCA8aWQ+XSBbLS1wb3J0IDxuPl0gWy0tbm8tb3Blbl0gICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybFxuICBzdGF0ZSAgWy0tc2tlbGV0b25dIFstLWJhdGNoIDxpZD5dICAgICAgICAgICAgICAgICB0aGUgcHJvamVjdCBzbmFwc2hvdCAoc2tlbGV0b24gPSBpZHMvdGl0bGVzL2RlZ3JlZSlcbiAgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+ICAgICAgICAgICAgICAgICAgICAgYm91bmRlZCBkZWx0YSwgQURESVRJT05TIE9OTFkgKG5vdENvdmVyZWQgbmFtZXMgdGhlIHJlc3QpXG4gIHRhaWwgICBbLS1zaW5jZSBOXSBbLS1pbmJvdW5kXSBbLS1vbmNlXSAgICAgICAgICAgIFNTRSBldmVudHMgYXMgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yOyBzZWUgYmVsb3cpXG4gIHByb2plY3RzIFstLWNyZWF0ZSA8dGl0bGU+XSAgICAgICAgICAgICAgICAgICAgICAgIGxpc3QgcHJvamVjdHMgLyBjcmVhdGUgb25lXG4gIGluZ2VzdCAtLXRpdGxlIDx0PiAoLS1maWxlIDxwPiB8IC0tc3RkaW4pICAgICAgICAgIGFkZCBhIGRvY1xuICBwcm9wb3NlLW5vZGUgLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFnZSBhIG5vZGUgcHJvcG9zYWwgKEpTT04ge2RyYWZ0LCBldmlkZW5jZSwgLi4ufSlcbiAgcHJvcG9zZS1lZGdlIC0tc3RkaW4gWy0tem9uZSA8aWQ+XSAgICAgICAgICAgICAgICAgc3RhZ2UgYW4gZWRnZSBwcm9wb3NhbFxuICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFnZSBhIHNldCBpbiBvbmUgdHhuICh7bm9kZXMsIGVkZ2VzfSlcbiAgcmF0aWZ5LWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF0aWZ5IGEgc2V0IGluIG9uZSB0eG4gKHtydWxpbmcsIGlkcywgYW5jaG9ycz99KVxuICBkZWxldGUtYmF0Y2ggLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWxldGUgYSBwcm9wb3NhbCBzZXQgaW4gb25lIHR4biAoe2lkc30sIGFsbC1vci1ub3RoaW5nKVxuICByYXRpZnkgPGlkPiAtLXJ1bGluZyA8cj4gWy0tZG9jLWVkaXQgPGZpbGU+XSBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHQ+XSBbLS1hbmNob3IgPHBhcmVudElkPl1cbiAgem9uZSAgIGNyZWF0ZSA8bmFtZT4gfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXSAgc3RhZ2luZyBwZW5zIGZvciBwcm9wb3NhbHNcbiAgcHJvbW90ZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbW92ZSBhIHpvbmVkIHByb3Bvc2FsIHRvIHRoZSBtYWluIHF1ZXVlXG4gIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8ej4gfCAtLWNsZWFyKSB8IHByb3Bvc2FsIGRlbGV0ZSA8aWQ+XG4gIG5vZGUgICBhbmNob3IgPGlkPiAoLS10byA8cD4gfCAtLWNsZWFyKSB8IGVkaXQgPGlkPiBbLS10aXRsZS8tLXN5bm9wc2lzLy0tc3RkaW5dIHwgZGVsZXRlIDxpZD4gWy0tZm9yY2VdXG4gIGRvYyAgICA8aWQ+IHwgZGVsZXRlIDxpZD4gWy0tZm9yY2VdIHwga2luZCA8ZG9jSWQ+ICg8a2luZD4gWy0tYXV0aG9yIGFdIHwgLS1jbGVhcilcbiAgICAgICAgIGZsYWdzIG1heSBwcmVjZWRlIHRoZSBzdWItdmVyYiAoZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSA8aWQ+KTsgZG9jIC0tIDxpZD4gcmVhZHMgYSBkb2MgbmFtZWQgXCJkZWxldGVcIiBvciBcImtpbmRcIlxuICBtYXJrICAgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICAgICAgICAgICBhcHBlbmQgYSBkb2Mgc3RhdHVzIG1hcmtcbiAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgICBhY3Rpb24gc2xvdHMgb24gYSBub2RlL3BlbmRpbmcgcHJvcG9zYWxcbiAgdGFncyAgIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgICBmcmVlZm9ybSB0YWdzLCBzYW1lIHRhcmdldHNcbiAgam9iICAgIGNyZWF0ZXx1cGRhdGV8Y2xhaW18cmVsZWFzZXxzdWJ0YXNrfGxpc3R8ZGVsZXRlICBwZXJzaXN0ZWQgdW5pdHMgb2YgYWdlbnQgd29ya1xuICBzZWFyY2ggPHF1ZXJ5Li4uPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBGVFMgb3ZlciBub2RlcywgZG9jcywgbWVzc2FnZXNcbiAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuICBsZW5zICAgc2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxpZD4pIHwgbGVucyBjbGVhclxuICBsb29rLWhlcmUgPG5vZGVJZD4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXG4gIHJlYWQgICA8bWVzc2FnZUlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuICBzZW5kICAgPHRleHQuLi4+IHwgLS1ib2R5LWZpbGUgPHA+IHwgLS1zdGRpbiAgICAgICBwb3N0IGEgbWVzc2FnZSAoWy0tcm9sZV0gWy0ta2luZF0gWy0tZ3JvdW5kXSlcbiAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gdGhlIGNhc3RpbmctbG9vcCBsaXZlbmVzcyBzaWduYWxcbiAgdmVyc2lvbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVxuICBzY2hlbWEgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGUgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcbiAgaGVscCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaClcblxuICAtLXByb2plY3QgPGlkPiBnb2VzIGFmdGVyIHRoZSB2ZXJiOyBldmVyeSB2ZXJiIHRoYXQgcmVhZHMgYSBtYXAgYWNjZXB0cyBpdCAocHJvamVjdHMsIGhlbHAsXG4gIHZlcnNpb24gYW5kIHNjaGVtYSBkbyBub3QpLiBPbWl0IGl0IGZvciB0aGUgZGVmYXVsdCBwcm9qZWN0LiBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgbGluZTogYSBmbGFnIG9uIHRoZSB3cm9uZyB2ZXJiIGlzXG4gIHJlZnVzZWQsIGFuZCB0aGUgcmVqZWN0aW9uIGxpc3RzIHRoYXQgdmVyYidzIG93biBmbGFncy5cblxuICBPdXRwdXQ6IGV2ZXJ5IHZlcmIgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlFxuICBleGNlcHQgdGFpbCwgYSBzdHJlYW0gdGhhdCBwcmludHMgb25lIEpTT04gbGluZSBwZXIgZXZlbnQsIGFuZCBoZWxwLCB3aGljaCBpc1xuICBwcm9zZS4gUHJvc2UsIHdhcm5pbmdzIGFuZFxuICBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnI7IGZhaWx1cmVzIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG5cbiAgS2VlcCB3YXRjaGluZyBwYXN0IE1vbml0b3IncyAzMC1taW51dGUgY2FwLiBBcm0gdGhlIHRhaWwgd2l0aCBNb25pdG9yIGF0XG4gIHRpbWVvdXRfbXM6IDE4MDAwMDAuIEl0IGVuZHMgaXRzZWxmIGp1c3QgYmVmb3JlIHRoZSBjYXAsIGFuZCBpdHMgbGFzdCBsaW5lXG4gICh0eXBlOiBcInRhaWwu4oCmXCIpIG5hbWVzIHlvdXIgbmV4dCBhY3QuIFRoYXQgbGluZSdzIGNvbW1hbmQgaXMgdGhlIHZlcmIgYW5kIGl0c1xuICBhcmd1bWVudHMgb25seSwgYm9va21hcmsgKC0tc2luY2UpIGluY2x1ZGVkLCB3aXRoIG5vIGxhdW5jaGVyIGFuZCBubyBwYXRoLlxuICBBbHdheXMgcnVuIGl0IHdpdGggdGhpcyBza2lsbCdzIG93biBsYXVuY2hlciwgdGhlIG9uZSB5b3UgdXNlIGZvciBpdHMgb3RoZXJcbiAgdmVyYnM6IGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+LiBBIGNvbW1hbmQgb2ZcbiAgdGFpbCAtLXNpbmNlIDEyIHJ1bnMgYXMgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyB0YWlsIC0tc2luY2UgMTIuXG4gIE5ldmVyIHJldXNlIGEgbGF1bmNoZXIgcGF0aCBmcm9tIGFuIGVhcmxpZXIgbGluZSBvciBzZXNzaW9uOiB0aGUgcGx1Z2luJ3NcbiAgZGlyZWN0b3J5IGNoYW5nZXMgd2hlbiBpdCB1cGRhdGVzLiBEbyB3aGF0IG5leHQgc2F5czpcblxuICAtIG1vbml0b3I6IGFybSBNb25pdG9yIGFnYWluIHdpdGggdGhlIGxhdW5jaGVyIGFuZCBjb21tYW5kLlxuICAtIGJhY2tncm91bmQ6IG5vdGhpbmcgaGFwcGVuZWQ7IHRoZSBodW1hbiBpcyBhd2F5LiBSdW4gdGhlIGxhdW5jaGVyIGFuZFxuICAgIGNvbW1hbmQgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpLiBJdCBleGl0cyBvbiB0aGVcbiAgICBuZXh0IGV2ZW50LCB3aGljaCB3YWtlcyB5b3UuIEhhbmRsZSB0aGUgZXZlbnQsIHRoZW4gZm9sbG93IGl0cyBsaW5lIGJhY2sgdG9cbiAgICBNb25pdG9yLlxuICAtIHN0b3A6IHRoZSBzZXNzaW9uIGNsb3NlZCBvciBpdHMgZGFlbW9uIGlzIGdvbmUuIERvIG5vdCByZS1hcm07IHRoZSBsYXVuY2hlclxuICAgIGFuZCBjb21tYW5kIGJyaW5nIGl0IGJhY2suIElmIHlvdSBydW4gaXQsIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vXG4gICAgLS1zaW5jZSAoYW5kIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cywgd2hlcmUgdGhlcmUgaXMgb25lKTogYSByZXN0YXJ0ZWRcbiAgICBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZy5cblxuICBJZiBNb25pdG9yIGV4cGlyZXMgYmVmb3JlIHRoYXQgbGluZSBhcnJpdmVzLCByZS1hcm0gc2lsZW50bHkgd2l0aFxuICAtLXNpbmNlIDx0aGUgbGFzdCBpZCB5b3Ugc2F3Piwgd3JpdHRlbiA8aWQ+QDxpdHMgZXBvY2g+IHdoZW4gZXZlbnRzIGNhcnJ5IGFuXG4gIGVwb2NoLiBOZXZlciByZS1hcm0gd2l0aG91dCAtLXNpbmNlOiB0aGF0IHJlcGxheXMgZXZlbnRzIHlvdSBoYXZlIGFscmVhZHlcbiAgaGFuZGxlZC4gSWYgdGhlIGxhdW5jaGVyIHJlZnVzZXMgYSBjb21tYW5kIHdpdGggYSB1c2FnZSBlcnJvciwgaXRzIG1lc3NhZ2VcbiAgbmFtZXMgdGhlIGZvcm1zIGl0IGFjY2VwdHM7IGZpeCB0aGUgYXJndW1lbnRzIHRvIG1hdGNoLlxuICB0YWlsICR7V0lORE9XX0hFTFB9LmA7XG5cbi8vIFRoZSBwbHVnaW4gbWFuaWZlc3QgaXMgdGhlIG9uZSB2ZXJzaW9uIHNvdXJjZTsgdGhlIENMSSByZWFkcyBpdCByYXRoZXIgdGhhblxuLy8gbWlycm9yaW5nIHRoZSBudW1iZXIgKGFzdHJvbGFiZSdzIHBhdHRlcm4pLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlXG4vLyBkZWdyYWRlcyB0byBcInVua25vd25cIiBpbnN0ZWFkIG9mIGludmVudGluZyBvbmUuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhcbiAgICAgIGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpLFxuICAgICAgXCJ1dGY4XCIsXG4gICAgKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwibWluZC1tYXBwZXJcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoIHRvIHVua25vd24gKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcIm1pbmQtbWFwcGVyXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8vIOKUgOKUgCB0aGUgaGFuZGxlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gT25lIHBlciBjb21tYW5kIHBhdGguIFRoZSByZWdpc3RyeSBoYXMgYWxyZWFkeSByZWZ1c2VkIGFuIHVua25vd24gb3Jcbi8vIG1pc3BsYWNlZCBmbGFnIGFuZCBlbmZvcmNlZCB0aGUgZGVjbGFyZWQgYXJpdHkgYmVmb3JlIGFueSBvZiB0aGVzZSBydW5zLCBzb1xuLy8gYSByZXF1aXJlZCBwb3NpdGlvbmFsIGlzIGFsd2F5cyBwcmVzZW50IGhlcmUuXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKHBhcnNlZC52YWx1ZXMucG9ydCk7XG4gIC8vIC0tcHJvamVjdCBzY29wZXMgdGhlIHByaW50ZWQgVVJMICsgc3Bhd25lZCBicm93c2VyICg/cHJvamVjdD0gcmlkZXNcbiAgLy8gYWxvbmcpLiBPcGVuIG5ldmVyIG1pbnRzOiBhbiB1bmtub3duIGlkIGlzIGEgdXNhZ2UgZXJyb3IgcG9pbnRpbmcgYXRcbiAgLy8gYHByb2plY3RzIC0tY3JlYXRlYCwgbm90IGEgc2lsZW50IG5ldyBzdG9yZS5cbiAgY29uc3QgcHJvamVjdCA9IHBhcnNlZC52YWx1ZXMucHJvamVjdDtcbiAgaWYgKHByb2plY3QgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvamVjdHNgKTtcbiAgICBjb25zdCBib2R5ID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgIGlmICghYm9keS5wcm9qZWN0cy5zb21lKChwKSA9PiBwLmlkID09PSBwcm9qZWN0KSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgYHVua25vd24gcHJvamVjdDogJHtwcm9qZWN0fSAob3BlbiBuZXZlciBjcmVhdGVzIG9uZSDigJQgdXNlIFxcYHByb2plY3RzIC0tY3JlYXRlIDx0aXRsZT5cXGAgZmlyc3QpYCxcbiAgICAgICAgeyBjaG9pY2VzOiBib2R5LnByb2plY3RzLm1hcCgocCkgPT4gcC5pZCkgfSxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3Byb2plY3QgPyBgLz9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHByb2plY3QpfWAgOiBcIlwifWA7XG4gIGlmICghcGFyc2VkLnZhbHVlc1tcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHVybCB9KX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICBpZiAocGFyc2VkLnZhbHVlcy5iYXRjaCkgcGFyYW1zLnNldChcImJhdGNoXCIsIHBhcnNlZC52YWx1ZXMuYmF0Y2gpO1xuICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3RhdGUke3FzfWApO1xuICAvLyBBIG5vbi1vayAvc3RhdGUgKDQwOSBuZWVkcy1wcm9qZWN0IG9uIGEgZnJlc2ggc3RvcmUsIDQwNCB1bmtub3duXG4gIC8vIHByb2plY3QpIHJpZGVzIHRoZSBlcnJvciBlbnZlbG9wZSB3aXRoIHRoZSBkYWVtb24gYm9keSB1bmRlclxuICAvLyBlcnJvci5zZXJ2ZXIg4oCUIHRoZSBza2VsZXRvbiB0cmFuc2Zvcm0gb25seSBydW5zIG9uIGEgcmVhbCBzbmFwc2hvdC5cbiAgY29uc3Qgc3RhdGVUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc2tlbGV0b24pIHtcbiAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGVUZXh0KSBhcyBQYXJhbWV0ZXJzPHR5cGVvZiB0b1NrZWxldG9uPlswXTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh0b1NrZWxldG9uKHN0YXRlKSl9XFxuYCk7XG4gIH0gZWxzZSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7c3RhdGVUZXh0fVxcbmApO1xuICB9XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCAxMiAoU0VBTSAzKTogYGNoYW5nZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPmAg4oCUIHRoZSBib3VuZGVkIGRlbHRhLlxuLy8gUmVhZCB0aGUgcmVzcG9uc2UncyBub3RDb3ZlcmVkIGJlZm9yZSB0cnVzdGluZyBhbiBlbXB0eSBvbmU6IFwibm90aGluZ1xuLy8gYWRkZWRcIiBpcyBOT1QgXCJub3RoaW5nIGNoYW5nZWRcIiAoZGVsZXRpb25zLCByZWplY3Rpb25zIGFuZCBpbi1wbGFjZSBlZGl0c1xuLy8gYXJlIGludmlzaWJsZSBoZXJlIGJ5IGNvbnN0cnVjdGlvbikuXG5hc3luYyBmdW5jdGlvbiBjbWRDaGFuZ2VzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc2luY2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcImNoYW5nZXMgcmVxdWlyZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPiAodXNlIDAgZm9yIGV2ZXJ5dGhpbmcsIHRoZW4gcGFzcyBiYWNrIHRoZSBgbm93YCBmcm9tIHRoZSBwcmV2aW91cyByZXNwb25zZSlcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogXCJBRERJVElPTlMgT05MWSDigJQgdGhlIHJlc3BvbnNlJ3Mgbm90Q292ZXJlZCBuYW1lcyB3aGF0IGl0IGNhbm5vdCBzZWU7IGEgZnVsbCBgc3RhdGVgIHJlYWQgaXMgc3RpbGwgdGhlIG9ubHkgd2F5IHRvIHJlY29uY2lsZSBkZWxldGlvbnMsIHJlamVjdGlvbnMgYW5kIGluLXBsYWNlIGVkaXRzXCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7IHNpbmNlOiBwYXJzZWQudmFsdWVzLnNpbmNlIH0pO1xuICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5nZXM/JHtwYXJhbXN9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaW5ib3VuZCA9IHBhcnNlZC52YWx1ZXMuaW5ib3VuZCA9PT0gdHJ1ZTtcbiAgY29uc3Qgb25jZSA9IHBhcnNlZC52YWx1ZXMub25jZSA9PT0gdHJ1ZTtcbiAgLy8gQSBib29rbWFyaywgYE5gIG9yIGBOQDxlcG9jaD5gIGFzIHRoZSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0XG4gIC8vIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBEMikuIEEgZm9ybSBpdCBkb2VzIG5vdCBhY2NlcHQgaXMgcmVmdXNlZCB3aXRoXG4gIC8vIHRoZSBhY2NlcHRlZCBmb3JtcyBuYW1lZCDigJQgcmVhZCBCRUZPUkUgdGhlIGRhZW1vbiBjaGVjaywgc28gdGhlIGFuc3dlclxuICAvLyBkb2VzIG5vdCBkZXBlbmQgb24gd2hldGhlciBvbmUgaXMgdXAuXG4gIGNvbnN0IHJlYWQgPVxuICAgIHR5cGVvZiBwYXJzZWQudmFsdWVzLnNpbmNlID09PSBcInN0cmluZ1wiXG4gICAgICA/IHJlYWRTaW5jZShwYXJzZWQudmFsdWVzLnNpbmNlLCB7IGVwb2NoOiB0cnVlIH0pXG4gICAgICA6IG51bGw7XG4gIGlmIChyZWFkICE9PSBudWxsICYmICFyZWFkLm9rKSB0aHJvdyB1c2FnZUVycm9yKHJlYWQubWVzc2FnZSk7XG4gIGNvbnN0IG1hcmsgPSByZWFkPy5vayA/IHJlYWQgOiBudWxsO1xuICBjb25zdCBzaW5jZSA9IG1hcms/LnNpbmNlID8/IE51bWJlci5OYU47XG4gIHJlcXVpcmVEYWVtb24oKTsgLy8gbm8gZGFlbW9uIGF0IHN0YXJ0IGlzIGEgdXNhZ2UgZXJyb3I7IG1pZC10YWlsIGRlYXRoIGlzIHNlbGYtaGVhbGVkIGJlbG93XG4gIC8vIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBBMykuXG4gIGNvbnN0IHNpbmNlR2l2ZW4gPSBwYXJzZWQudmFsdWVzLnNpbmNlICE9PSB1bmRlZmluZWQ7XG4gIC8vIFRoZSBzZXJ2ZXIgKHJlLSllbWl0cyBhIGdyb3VuZGluZyBmcmFtZSBhdCB0aGUgdG9wIG9mIEVWRVJZIGluYm91bmQgU1NFXG4gIC8vIGNvbm5lY3Q7IGZvcndhcmQgb25seSB0aGUgRklSU1Qgc28gdGhlIGFnZW50J3MgTW9uaXRvciBzZWVzIGV4YWN0bHkgb25lXG4gIC8vIGdyb3VuZGluZyBsaW5lLCBub3Qgb25lIHBlciByZWNvbm5lY3QgKEY1OiBmaXJzdC1jb25uZWN0IGxpbmUpLlxuICAvL1xuICAvLyDim5QgVEhFIFNVUFBSRVNTSU9OJ1MgU1RBVEUgTElWRVMgSU4gVEhJUyBDTE9TVVJFLCBPVVRTSURFIFRIRSBUSElORyBUSEFUXG4gIC8vIE9XTlMgVEhFIFJFQ09OTkVDVFMsIEFORCBUSEFUIElTIFRIRSBPTkUgSE9ORVNUIEdBUCBJTiBUSElTIEFET1BUSU9OLlxuICAvLyBgcmVuZGVyYCBpcyBhIGNhbGxlci13cml0dGVuIGNsb3N1cmUsIHNvIGBncm91bmRlZGAgc3Vydml2ZXMgdGhlXG4gIC8vIHJlY29ubmVjdHMgYHRhaWxFdmVudHNgIHBlcmZvcm1zIOKAlCB3aGljaCBpcyBleGFjdGx5IHdoeSBpdCBXT1JLUywgYW5kIGFsc29cbiAgLy8gd2h5IG5vdGhpbmcgaW4gdGhlIGtpdCBndWFyYW50ZWVzIGl0OiB0aGVyZSBpcyBubyBkZWRpY2F0ZWRcbiAgLy8gZmlyc3QtZnJhbWUtb25jZSBhZmZvcmRhbmNlIGFuZCBubyB3b3JrZWQgZXhhbXBsZSBvZiBvbmUsIGFuZCBhIGZ1dHVyZVxuICAvLyBjaGFuZ2UgdG8gd2hlbiBgdGFpbEV2ZW50c2AgcmUtaW52b2tlcyBpdHMgaG9va3Mgd291bGQgbW92ZSB0aGlzXG4gIC8vIGJlaGF2aW91ciB3aXRob3V0IHRvdWNoaW5nIHRoaXMgZmlsZS4gVGhlIGFsdGVybmF0aXZlIHdhcyBhc2tpbmcgdGhlIGtpdFxuICAvLyBmb3IgYSBgZmlyc3RGcmFtZU9uY2VgIG9wdGlvbiwgd2hpY2ggaXMgYSB3aWRlbmluZyBmb3IgYSBjbG9zdXJlIHRoZVxuICAvLyBjYWxsZXIgY2FuIHdyaXRlIGluIHRocmVlIGxpbmVzIChEODIncyBub3QtdGFrZW4pLlxuICBsZXQgZ3JvdW5kZWQgPSBzaW5jZUdpdmVuO1xuXG4gIC8vIOKblCBPTkUgQ0FMTCBJTlRPIFRIRSBIT1VTRSdTIFNIQVJFRCBUQUlMIENMSUVOVFxuICAvLyAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIFJFUExBQ0lORyBBIEhBTkQtUk9MTEVEXG4gIC8vIFRIUkVFLUxFVkVMIExPT1Ag4oCUIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGwgdGhhdCBtb2R1bGUncyBvd25cbiAgLy8gY29uc3RhbnQtYmFja29mZiB3YXJuaW5nIHdhcyB3cml0dGVuIGFib3V0OiB0aGUgbG9vcCBiZWxvdyB1c2VkIHRvIHNsZWVwXG4gIC8vIGByZXRyeU1zYCBhZnRlciBFVkVSWSBmYWlsZWQgYXR0ZW1wdCwgZmxhdCwgZm9yZXZlciwgd2hpY2ggaXMgYVxuICAvLyByZWNvbm5lY3Qgc3Rvcm0gcmF0aGVyIHRoYW4gYSBiYWNrb2ZmLiBXaGF0IHRoZSBzd2FwIGNsb3NlcyBoZXJlLCBub25lIG9mXG4gIC8vIGl0IGJ5IGFueW9uZSBlZGl0aW5nIGl0OlxuICAvL1xuICAvLyAgIMK3IEJBQ0tPRkYuIDEsMDAwIG1zIGZsYXQgYmVjb21lcyAxLDAwMCDCtyAyLDAwMCDCtyA0LDAwMCDCtyA1LDAwMCDCtyA1LDAwMCxcbiAgLy8gICAgIHJlc2V0IG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBEcml2ZW4gb24gZ2xhbW91ciBiZWZvcmUgYW5kIGFmdGVyXG4gIC8vICAgICBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgZHJvcHM6IDUxIGF0dGVtcHRzIGluXG4gIC8vICAgICAxNCBzIGF0IGEgZmxhdCB+MjUyIG1zIGJlY2FtZSA2IGF0dGVtcHRzIGF0IDI1MiDCtyA1MDMgwrcgMTAwMSDCtyAyMDAyIMK3XG4gIC8vICAgICA0MDAyLlxuICAvLyAgIMK3IFRIRSBTUEVDLiBUaGUgaGFuZC1yb2xsZWQgZnJhbWUgcGFyc2VyIG1hdGNoZWQgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgXG4gIC8vICAgICBhbmQga2VwdCBvbmx5IHRoZSBGSVJTVCBkYXRhIGxpbmUsIHNvIGEgc3BlYy1sZWdhbCBgZGF0YTp7Li4ufWAgd2FzXG4gIC8vICAgICBzaWxlbnRseSBEUk9QUEVEICoqYW5kIHRoZSBjdXJzb3IgZGlkIG5vdCBhZHZhbmNlKiog4oCUIGEgZnJhbWUgbm9ib2R5XG4gIC8vICAgICBjYW4gcmVhZCBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgLy8gICAgIFRoZSBraXQgc3BsaXRzIGF0IHRoZSBmaXJzdCBjb2xvbiBhbmQgc3RyaXBzIGF0IG1vc3Qgb25lIHNwYWNlLCBwZXJcbiAgLy8gICAgIFdIQVRXRywgd2hpY2ggaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGggZXZlcnkgaG91c2VcbiAgLy8gICAgIGRhZW1vbi5cbiAgLy8gICDCtyBUSEUgU0lHTkFMIEhBTkRMRVJTLiBUaGVyZSB3ZXJlIG5vbmUuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhXG4gIC8vICAgICByZWFkZXIgbm93IGVuZHMgdGhlIHdhdGNoIGJ5IFJFVFVSTklORywgc28gdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dFxuICAvLyAgICAgZmlyc3Qg4oCUIHRoZSBoYWxmIG9mIHRoZSBQMGYgZHJhaW4gZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gIC8vICAgwrcgVEhFIEVYSVQgQ09ERSBDUk9TU0VTIFRIRSBMT09QUy4gVGhlIGNsaWVudCBSRVRVUk5TIGEgY29kZSBpbnN0ZWFkIG9mXG4gIC8vICAgICBlbmRpbmcgdGhlIHByb2Nlc3MgZnJvbSBpbnNpZGUgdGhyZWUgbmVzdGVkIGxvb3BzLCB3aGljaCBpcyB3aGF0XG4gIC8vICAgICByZXRpcmVzIHRoZSBwZXItc2l0ZSBxdWVzdGlvbiBvZiB3aGV0aGVyIGEgYHJldHVybmAgZXNjYXBlcyB0aGVtIGFsbC5cbiAgLy9cbiAgLy8g4pqgIEFORCBgaWRsZU1zYC9gcmV0cnlgIEFSRSBERVJJVkVELCBOT1QgQ09QSUVEIChCOCdzIG9uZSB1bmNvcHlhYmxlIHJ1bGUpLlxuICAvLyBUaGV5IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB0aGUgc2VhbSBmaWxlIGJvdGggaGFsdmVzIGltcG9ydCwgd2hlcmVcbiAgLy8gdGhlIHdhdGNoZG9nIGlzIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCDigJQgdGhyZWUgb2YgVEhJUyBkYWVtb24nc1xuICAvLyBiZWF0cywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcyDigJQgYW5kIHdoZXJlIHRoZSB0d28gZW52IGtub2JzIHRoaXNcbiAgLy8gc3BlbGwncyBvd24gdGFpbCBzdWl0ZSBkcml2ZXMgYXJlIHJlc29sdmVkIChENzUpLiBUaGUgbnVtYmVyIGlzIDQ1LDAwMCBhdFxuICAvLyB0aGUgZGVmYXVsdCwgd2hpY2ggaXMgd2hhdCB0aGlzIGZpbGUgaGFyZC1jb2RlZDsgdGhlIEVYUFJFU1NJT04gaXMgd2hhdFxuICAvLyBjaGFuZ2VkLlxuICAvL1xuICAvLyDim5QgQU5EIFRIRSBRVUlFVCBIQU5ET0ZGLCBMSUtFIFRIRSBTRVNTSU9OIFNQRUxMUyAoQ29sZSdzIHJ1bGluZyxcbiAgLy8gMjAyNi0wOS0yNDsgYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCwgXCJNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTlxuICAvLyBTUEVMTFNcIikuIEEgcXVpZXQgd2luZG93IG5hbWVzIGEgYmFja2dyb3VuZCBgLS1vbmNlYDsgYSB3b2tlbiBvbmUtc2hvdFxuICAvLyBuYW1lcyBNb25pdG9yOyBhIGRhZW1vbiB0aGF0IGRpZWQgbmFtZXMgYG9wZW4gLS1uby1vcGVuYC4gVGhlIHRhaWwnc1xuICAvLyBzdG9wLXN0YXJ0IGlzIHdoYXQgdGhlIGRhZW1vbidzIHByZXNlbmNlIExJTkdFUiAoYHNlcnZlci50c2AsXG4gIC8vIGBhZGp1c3RBZ2VudHNgKSBleGlzdHMgdG8gaGlkZSBmcm9tIHRoZSBodW1hbi5cbiAgLy9cbiAgLy8g4pqgIFRIRSBMQVNUIFVSTCBJUyBLRVBULCBzbyBhIGRlYWQgZGFlbW9uIGlzIExPU1QgcmF0aGVyIHRoYW4gdW5yZXNvbHZlZC5cbiAgLy8gYGxpdmVQb3J0KClgIGFuc3dlcnMgbnVsbCBvbmNlIHRoZSBkYWVtb24ncyBwaWQgaXMgZGVhZCwgYW5kIGFuXG4gIC8vIHVucmVzb2x2ZWQgdGFpbCByZXRyaWVzIGZvcmV2ZXIg4oCUIGEgYC0tb25jZWAgd291bGQgc2xlZXAgZm9yIGdvb2QgYW5kIGFcbiAgLy8gTW9uaXRvciB3YXRjaCB3b3VsZCBuZXZlciBoZWFyIGl0LiBBc2tpbmcgdGhlIGxhc3QgcG9ydCBpbnN0ZWFkIGdldHNcbiAgLy8gcmVmdXNlZCwgYW5kIHRoZSBraXQncyBsb3N0IHJ1bGUgZW5kcyB0aGUgdGFpbCB3aXRoIHRoZSB3YXkgYmFjay4gQSBsaXZlXG4gIC8vIGRhZW1vbiBvbiBhIE5FVyBwb3J0IChzb21lb25lIHJhbiBgb3BlbmAgYWdhaW4pIGlzIHN0aWxsIGZvdW5kIGZpcnN0LlxuICBsZXQgbGFzdFVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHJldHVybiBhd2FpdCB0YWlsV2l0aEhhbmRvZmY8eyBpZD86IHVua25vd247IGVwb2NoPzogdW5rbm93bjsga2luZD86IHVua25vd24gfT4oXG4gICAge1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBwb3J0ID0gbGl2ZVBvcnQoKTtcbiAgICAgICAgaWYgKHBvcnQgIT09IG51bGwpIGxhc3RVcmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YDtcbiAgICAgICAgcmV0dXJuIGxhc3RVcmw7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZTogTnVtYmVyLmlzRmluaXRlKHNpbmNlKSA/IHNpbmNlIDogMCxcbiAgICAgIC4uLihtYXJrPy5lcG9jaCA/IHsgc2luY2VFcG9jaDogbWFyay5lcG9jaCB9IDoge30pLFxuICAgICAgcXVlcnk6IChjdXJzb3IpID0+ICh7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgICAgLi4uKHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IHsgcHJvamVjdDogcGFyc2VkLnZhbHVlcy5wcm9qZWN0IGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAuLi4oaW5ib3VuZCA/IHsgaW5ib3VuZDogXCIxXCIgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLy8g4puUIGBpZGAsIE5PVCBgc2VxYCDigJQgdGhlIGRhZW1vbidzIGVudmVsb3BlIGZpZWxkIHdhcyByZW5hbWVkIGJ5IHRoZVxuICAgICAgLy8gYGNyZWF0ZUV2ZW50TG9nYCBhZG9wdGlvbiAoRDgxKSwgYW5kIHRoaXMgaXMgdGhlIENMSS1zaWRlIHJlYWRlciBvZiBpdC5cbiAgICAgIC8vIOKaoCBUaGUgQ0xJIGhhbGYgRk9SQ0VEIG5vdGhpbmc6IGBjdXJzb3JPZmAgaXMgY2FsbGVyLXN1cHBsaWVkLCBzb1xuICAgICAgLy8gYChldikgPT4gZXYuc2VxYCB3b3VsZCBoYXZlIGNvbXBpbGVkIGFuZCBydW4uIEl0IHdvdWxkIGFsc28gaGF2ZSByZWFkIGFcbiAgICAgIC8vIGZpZWxkIHRoZSBkYWVtb24gbm8gbG9uZ2VyIGVtaXRzLCBzbyB0aGUgY3Vyc29yIHdvdWxkIG5ldmVyIGFkdmFuY2UgYW5kXG4gICAgICAvLyBldmVyeSByZWNvbm5lY3Qgd291bGQgcmUtcmVxdWVzdCBgc2luY2U9MGAg4oCUIHRoZSB3aG9sZSByZXBsYXkgd2luZG93XG4gICAgICAvLyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgc2lsZW50bHksIGZvcmV2ZXIuICoqQSBjYWxsZXItc3VwcGxpZWQgYWNjZXNzb3IgaXNcbiAgICAgIC8vIHdoZXJlIGEgd2lyZSByZW5hbWUgZ29lcyB3cm9uZyBxdWlldGx5LioqXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgICAgZXBvY2hPZjogKGV2KSA9PiAodHlwZW9mIGV2LmVwb2NoID09PSBcInN0cmluZ1wiID8gZXYuZXBvY2ggOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSByZWNvbm5lY3QgdGhhdCBsYW5kcyBvbiBhIGRpZmZlcmVudCBlcG9jaCBtZWFucyB0aGUgZGFlbW9uIHJlc3RhcnRlZDpcbiAgICAgIC8vIHRoZSBraXQgcmVzZXRzIHRoZSBjdXJzb3IgdG8gMCBhbmQgdGhpcyBsaW5lIHRlbGxzIHRoZSBjYXN0aW5nIGFnZW50IHRvXG4gICAgICAvLyByZWZldGNoIHN0YXRlLiBDTEktc3ludGhlc2l6ZWQgb25seSwgbmV2ZXIgYSBidXMgZXZlbnQgKHRoZSBicm93c2VyIFdTXG4gICAgICAvLyBuZXZlciBzZWVzIGl0KSwgYW5kIGl0IGNhcnJpZXMgbm8gYGlkYCDigJQgc28gaXQgbmV2ZXIgYWR2YW5jZXMgdGhlXG4gICAgICAvLyBjdXJzb3IsIHdoaWNoIGlzIHRoZSBzYW1lIHNlcGFyYXRpb24gdGhlIGdyb3VuZGluZyBsaW5lIG1ha2VzLlxuICAgICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IGtpbmQ6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICAgIC8vIEdyb3VuZGluZyBpcyBhIHN5bnRoZXRpYywgaWQtbGVzcyBmaXJzdC1jb25uZWN0IGZyYW1lOiBmb3J3YXJkIHRoZVxuICAgICAgLy8gZmlyc3QsIHN1cHByZXNzIHJlLWdyb3VuZGluZ3Mgb24gcmVjb25uZWN0IChleGFjdGx5IG9uZSBwZXIgcHJvY2VzcykuXG4gICAgICAvLyBSZXR1cm5pbmcgbnVsbCB3cml0ZXMgbm90aGluZzsgaXQgbmV2ZXIgY2FycmllcyBpZC9lcG9jaCwgc28gdGhlXG4gICAgICAvLyBjdXJzb3IgYW5kIHRoZSBlcG9jaCBhcmUgdW50b3VjaGVkIGVpdGhlciB3YXkuXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGV2LmtpbmQgPT09IFwiZ3JvdW5kaW5nXCIpIHtcbiAgICAgICAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZnJhbWUuZGF0YTtcbiAgICAgIH0sXG4gICAgICAvLyBBIHJlZnVzZWQgY29ubmVjdGlvbiAoNDA5IG5lZWRzLXByb2plY3Qgb24gYSBwcm9qZWN0bGVzcyBzdG9yZSwgNDA0XG4gICAgICAvLyB1bmtub3duIHByb2plY3QpIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIHRyYW5zcG9ydCBibGlwIOKAlCByZXRyeWluZyBpdFxuICAgICAgLy8gZm9yZXZlciB3b3VsZCBqdXN0IHNwaW4gc2lsZW50bHkuIGBwYXNzT3JUaHJvd2AgYWx3YXlzIHRocm93cyBoZXJlLCBhbmRcbiAgICAgIC8vIHRoZSB0aHJvdyBwcm9wYWdhdGVzIG91dCBvZiB0aGUgY2xpZW50IGludG8gYG1haW5gJ3MgY2F0Y2gsIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIHJhaXNlIHJlYWNoYWJsZSBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLlxuICAgICAgLy8gQW5ub3RhdGVkOiBhbiBhc3luYyBhcnJvdydzIGByZXR1cm4gXCJyZXRyeVwiYCB3aWRlbnMgdG8gYFByb21pc2U8c3RyaW5nPmBcbiAgICAgIC8vIHVubGVzcyB0aGUgcmV0dXJuIHR5cGUgaXMgc3RhdGVkLCBhbmQgdGhlIGNsaWVudCBhY2NlcHRzIG9ubHkgdGhlXG4gICAgICAvLyBsaXRlcmFsICh0eXBlLWRlYnQgVDM2KS5cbiAgICAgIG9uSHR0cEVycm9yOiBhc3luYyAocmVzKTogUHJvbWlzZTxcInJldHJ5XCI+ID0+IHtcbiAgICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwOSB8fCByZXMuc3RhdHVzID09PSA0MDQpIGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gICAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgICB9LFxuICAgICAgLy8g4puUIFRIRSBVTlBBUlNFQUJMRSBMSU5FIEdPRVMgVE8gU1RET1VULCBXSElDSCBJUyBUSElTIFNQRUxMJ1MgT1dOXG4gICAgICAvLyBCRUhBVklPVVIgQU5EIFRIRSBPTkUgVEhFIEtJVCdTIERFRkFVTFQgV09VTEQgSEFWRSBDSEFOR0VELiBUaGVcbiAgICAgIC8vIGhhbmQtcm9sbGVkIGxvb3AgY2F1Z2h0IHRoZSBgSlNPTi5wYXJzZWAgYW5kIHBhc3NlZCB0aGUgcmF3IGxpbmVcbiAgICAgIC8vIHRocm91Z2ggdW50cmFja2VkOyB0aGUga2l0J3MgYG9uTWFsZm9ybWVkYCByZXR1cm4gdmFsdWUgZ29lcyB0byBgZXJyYFxuICAgICAgLy8gaW5zdGVhZCwgYmVjYXVzZSBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSBpcyBub3QgZGF0YS4gbWluZC1tYXBwZXJcbiAgICAgIC8vIGlzIHRoZSBcIm9uZSBzcGVsbFwiIHRoYXQgbW9kdWxlJ3MgaGVhZGVyIG5hbWVzIGFzIGdlbnVpbmVseSB3YW50aW5nIGl0IG9uXG4gICAgICAvLyBzdGRvdXQsIGFuZCB0aGUgd2F5IHRvIGtlZXAgdGhhdCBpcyB0byB3cml0ZSBpdCBmcm9tIGluc2lkZSB0aGUgaG9vayBhbmRcbiAgICAgIC8vIHJldHVybiBudWxsLlxuICAgICAgb25NYWxmb3JtZWQ6IChmcmFtZSkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtmcmFtZS5kYXRhfVxcbmApO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICAgIHJldHJ5OiB7IGluaXRpYWxNczogVEFJTF9SRVRSWV9NUywgbWF4TXM6IFRBSUxfUkVUUllfTUFYX01TIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJtaW5kLW1hcHBlclwiLFxuICAgICAgbW9kZTogb25jZSA/IFwib25jZVwiIDogXCJ3YXRjaFwiLFxuICAgICAgcHJlc2VuY2U6IGZhbHNlLFxuICAgICAgLy8g4puUIGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBPTiBUSEUgTE9HIEFORCBJUyBOT1QgQ09VTlRFRC4gVGhlIGRhZW1vblxuICAgICAgLy8gZW1pdHMgaXQsIHdpdGggYSBsb2cgaWQsIHdoZW4gYSB0YWlsIG9wZW5zIG9yIChwYXN0IHRoZSBsaW5nZXIpIHRoZVxuICAgICAgLy8gbGFzdCBvbmUgY2xvc2VzIOKAlCBzbyBhIHRhaWwncyBPV04gY29ubmVjdCBsYW5kcyBvbiBpdHMgb3duIHN0cmVhbS5cbiAgICAgIC8vIENvdW50ZWQsIGV2ZXJ5IHdpbmRvdyB3b3VsZCBiZSBcImFjdGl2ZVwiIGFuZCBldmVyeSBgLS1vbmNlYCB3b3VsZCB3YWtlXG4gICAgICAvLyBvbiBpdHNlbGYgYXQgb25jZS4gSXQgaXMgY2h1cm4sIG5vdCBhbiBhY3QgdG8gYW5zd2VyLiAoVGhlIGdyb3VuZGluZ1xuICAgICAgLy8gZnJhbWUgY2FycmllcyBubyBsb2cgaWQsIHNvIEQzJ3MgcnVsZSBhbHJlYWR5IGxlYXZlcyBpdCBvdXQuKVxuICAgICAgY291bnRzOiAoZXYpID0+IGV2LmtpbmQgIT09IFwicHJlc2VuY2UuY2hhbmdlZFwiLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2U6IGF0LCBvbmNlOiBuZXh0T25jZSwgZXBvY2ggfSkgPT5cbiAgICAgICAgICB0YWlsQ29tbWFuZChcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgXCJ0YWlsXCIsXG4gICAgICAgICAgICAgIC4uLihpbmJvdW5kID8gW1wiLS1pbmJvdW5kXCJdIDogW10pLFxuICAgICAgICAgICAgICAuLi4ocGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gW1wiLS1wcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCBhcyBzdHJpbmddIDogW10pLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGF0LFxuICAgICAgICAgICAgbmV4dE9uY2UsXG4gICAgICAgICAgICBlcG9jaCxcbiAgICAgICAgICApLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb2plY3RzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuY3JlYXRlKSB7XG4gICAgY29uc3QgdGl0bGUgPSBwYXJzZWQudmFsdWVzLmNyZWF0ZTtcbiAgICBjb25zdCBpZCA9IHRpdGxlXG4gICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb2plY3RzYCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgaWQsIHRpdGxlIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2ApO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5nZXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFwYXJzZWQudmFsdWVzLnRpdGxlKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcImluZ2VzdCByZXF1aXJlcyAtLXRpdGxlXCIpO1xuICB9XG4gIGlmICghcGFyc2VkLnZhbHVlcy5maWxlICYmICFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcImluZ2VzdCByZXF1aXJlcyAtLWZpbGUgPHBhdGg+IG9yIC0tc3RkaW5cIik7XG4gIH1cbiAgY29uc3QgdGV4dCA9IHBhcnNlZC52YWx1ZXMuZmlsZVxuICAgID8gcmVhZEZpbGVTeW5jKHBhcnNlZC52YWx1ZXMuZmlsZSwgXCJ1dGY4XCIpXG4gICAgOiBhd2FpdCBCdW4uc3RkaW4udGV4dCgpO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2luZ2VzdCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB0aXRsZTogcGFyc2VkLnZhbHVlcy50aXRsZSwgdGV4dCB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQcm9wb3NlKHZlcmI6IFwicHJvcG9zZS1ub2RlXCIgfCBcInByb3Bvc2UtZWRnZVwiLCBwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghcGFyc2VkLnZhbHVlcy5zdGRpbikge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBgJHt2ZXJifSByZXF1aXJlcyAtLXN0ZGluIEpTT04ge2RyYWZ0LCBldmlkZW5jZVssIHN1Z2dlc3RlZFRpZXIsIGF1dGhvciwgdGFncywgYmF0Y2hJZF19YCxcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICAncHJvcG9zZS1lZGdlIGVuZHBvaW50czogYSBub2RlIGlkLCBhIHBlbmRpbmcgbm9kZS1wcm9wb3NhbCBpZCwgb3IgXCJ0aXRsZTo8ZXhhY3Qgbm9kZSB0aXRsZT5cIiAnICtcbiAgICAgICAgICBcIih0aXRsZSByZWZzIHJlc29sdmUgYXQgSU5UQUtFIGFnYWluc3QgcmF0aWZpZWQgbm9kZXMgb25seSwgZXhhY3QgKyBjYXNlLXNlbnNpdGl2ZTsgXCIgK1xuICAgICAgICAgIFwiYW4gYW1iaWd1b3VzIHRpdGxlIGVycm9ycyBhbmQgbmFtZXMgZXZlcnkgY2FuZGlkYXRlIGlkKVwiLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7XG4gICAgZHJhZnQ6IHVua25vd247XG4gICAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgICBzdWdnZXN0ZWRUaWVyPzogc3RyaW5nO1xuICAgIGF1dGhvcj86IHN0cmluZztcbiAgICAvLyBSb3VuZCA3IChUQUdTKTogcHJvcG9zZS10aW1lIHRhZ3MgcmlkZSB0aGUgc3RkaW4gSlNPTiDigJQgbXVzdCBiZVxuICAgIC8vIGZvcndhcmRlZCBpbnRvIHRoZSBQT1NUIGJvZHksIG9yIHRoZSAvcHJvcG9zYWxzIHJvdXRlIG5ldmVyIHNlZXMgdGhlbVxuICAgIC8vICh0aGUgYmF0Y2ggcGF0aCBmb3J3YXJkcyBpdHMgbm9kZSB0YWdzOyB0aGUgc2luZ2xlIHZlcmIgbXVzdCB0b28pLlxuICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAvLyBSb3VuZCAxMiAoU0VBTSAxKTogam9pbiBhbiBleGlzdGluZyBzdGFnaW5nIGFjdCAoZnJvbSBwcm9wb3NlLWJhdGNoKS5cbiAgICBiYXRjaElkPzogc3RyaW5nO1xuICB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2FscyR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAga2luZDogdmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiA/IFwibm9kZVwiIDogXCJlZGdlXCIsXG4gICAgICBkcmFmdDogaW5wdXQuZHJhZnQsXG4gICAgICBldmlkZW5jZTogaW5wdXQuZXZpZGVuY2UgPz8ge30sXG4gICAgICBzdWdnZXN0ZWRUaWVyOiBpbnB1dC5zdWdnZXN0ZWRUaWVyLFxuICAgICAgYXV0aG9yOiBpbnB1dC5hdXRob3IsXG4gICAgICAvLyAtLXpvbmUgc3RhZ2VzIHRoZSBwcm9wb3NhbCBpbiBhIHpvbmUgKGZsYWcgd2luczsgdGhlIHN0ZGluIEpTT05cbiAgICAgIC8vIHN0YXlzIHRoZSBkcmFmdC9ldmlkZW5jZSBzaGFwZSDigJQgem9uZSBpcyByb3V0aW5nLCBub3QgY29udGVudCkuXG4gICAgICB6b25lOiBwYXJzZWQudmFsdWVzLnpvbmUsXG4gICAgICAvLyBUQUdTOiBmb3J3YXJkIHRoZSBzdGRpbiB0YWdzICh0aGUgcm91dGUgdmFsaWRhdGVzIHRoZSBzaGFwZSkuXG4gICAgICB0YWdzOiBpbnB1dC50YWdzLFxuICAgICAgLy8gU0VBTSAxOiBmb3J3YXJkIHRoZSBzdGRpbiBiYXRjaElkICh0aGUgYm9keS1taXJyb3IgZGlzY2lwbGluZSDigJQgYVxuICAgICAgLy8gZmllbGQgYWRkZWQgdG8gdGhlIHNoYXJlZCAvcHJvcG9zYWxzIGJvZHkgbXVzdCBiZSB0aHJlYWRlZCBpbnRvIEVWRVJZXG4gICAgICAvLyBDTEkgdmVyYiB0aGF0IHBvc3RzIHRvIGl0OyB0aGUgcHJvcG9zZS1ub2RlLXRhZ3Mgc2NhcikuXG4gICAgICBiYXRjaElkOiBpbnB1dC5iYXRjaElkLFxuICAgIH0pLFxuICB9KTtcbiAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVzcG9uc2VUZXh0fVxcbmApO1xuICAvLyBNaXJyb3IgdGhlIGRhZW1vbidzIGFkZGl0aXZlIGVkZ2UtZHJhZnQgd2FybmluZyB0byBzdGRlcnIg4oCUIGEgY29sZFxuICAvLyBhZ2VudCBzY2FubmluZyBmb3IgcHJvYmxlbXMgc2VlcyBpdCBldmVuIGlmIGl0IGRvZXNuJ3QgcGFyc2Ugc3Rkb3V0LlxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLWVkZ2VcIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gICAgfVxuICB9XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQcm9wb3NlQmF0Y2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJwcm9wb3NlLWJhdGNoIHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCBzdWdnZXN0ZWRUaWVyPywgZXZpZGVuY2U/fV0sIGVkZ2VzOlt7ZHJhZnQ6e3NvdXJjZSwgdGFyZ2V0LCBsYWJlbD99fV19XCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgXCJhbiBlZGdlIGVuZHBvaW50IG1heSBiZSBhIG5vZGUgTE9DQUwgUkVGIChtYXRjaGVzIGEgbm9kZSdzIHJlZiBpbiB0aGlzIGJhdGNoKSwgXCIgK1xuICAgICAgICAgICdhIHJlYWwgbm9kZSBpZCwgYSBwZW5kaW5nIHByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIOKAlCBsb2NhbCByZWZzICcgK1xuICAgICAgICAgIFwicmVzb2x2ZSB0byBtaW50ZWQgaWRzIGFuZCB0aXRsZSByZWZzIHRvIHJhdGlmaWVkIG5vZGUgaWRzLCBib3RoIHNlcnZlci1zaWRlOyBcIiArXG4gICAgICAgICAgXCJvcHRpb25hbCBiYXRjaElkOiBvbWl0IGFuZCBvbmUgaXMgTUlOVEVEICsgcmV0dXJuZWQ7IHN1cHBseSBvbmUgdG8gZXh0ZW5kIHRoYXQgYWN0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICBub2Rlcz86IHVua25vd247XG4gICAgZWRnZXM/OiB1bmtub3duO1xuICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy9iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbm9kZXM6IGlucHV0Lm5vZGVzID8/IFtdLFxuICAgICAgZWRnZXM6IGlucHV0LmVkZ2VzID8/IFtdLFxuICAgICAgLy8gU0VBTSAxOiBvbWl0dGVkIOKGkiB0aGUgZGFlbW9uIG1pbnRzIGEgYmF0Y2hJZCBhbmQgcmV0dXJucyBpdDsgc3VwcGxpZWRcbiAgICAgIC8vIOKGkiB0aGlzIGNhbGwgam9pbnMgdGhhdCBhY3QgKHRoZSBcIkkgZm9yZ290IHRoZSBlZGdlc1wiIHJlcGFpcikuXG4gICAgICBiYXRjaElkOiBpbnB1dC5iYXRjaElkLFxuICAgIH0pLFxuICB9KTtcbiAgLy8gUmVzcG9uc2UgY2FycmllcyB7YmF0Y2hJZCwgcmVmVG9JZDogezxyZWY+OiA8bWludGVkSWQ+fSwgcHJvcG9zYWxzOiBbLi4uXX1cbiAgLy8g4oCUIHRoZSByZWbihpJpZCBtYXAgaXMgdGhlIHBvaW50IGZvciBUSElTIGNhbGwsIGFuZCBiYXRjaElkIGlzIHRoZSBwb2ludCBmb3JcbiAgLy8gZXZlcnkgbGF0ZXIgb25lIChgc3RhdGUgLS1iYXRjaCA8aWQ+YCByZWNvbmNpbGVzIGEgcGFydGlhbCByYXRpZmljYXRpb24pLlxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmF0aWZ5QmF0Y2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgJ3JhdGlmeS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge3J1bGluZzogXCJjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWxcIiwgaWRzOiBbcHJvcG9zYWxJZF0sIGFuY2hvcnM/OiBbe25vZGUsIHBhcmVudH1dfScsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgXCJyYXRpZmllcyB0aGUgc2V0IGluIE9ORSBjYWxsL3R4bjsgbm9kZXMgcmF0aWZ5IGJlZm9yZSBlZGdlcyAoYXV0by1wYXJ0aXRpb25lZCksIFwiICtcbiAgICAgICAgICBcImVkZ2UgZW5kcG9pbnRzICsgYW5jaG9yIHJlZnMgcmVzb2x2ZSBvbGQgcHJvcG9zYWwgaWRzIOKGkiBtaW50ZWQgbm9kZSBpZHMgdmlhIHRoZSBcIiArXG4gICAgICAgICAgXCJyZXR1cm5lZCBpZE1hcC4gTk8gYXV0by1pbmNsdWRlIG9mIHVubGlzdGVkIGVkZ2VzOyByZWplY3QgaXMgbm90IGEgYmF0Y2ggYWN0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICBydWxpbmc/OiB1bmtub3duO1xuICAgIGlkcz86IHVua25vd247XG4gICAgYW5jaG9ycz86IHVua25vd247XG4gIH07XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL3JhdGlmeS1iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsaW5nOiBpbnB1dC5ydWxpbmcsXG4gICAgICBpZHM6IGlucHV0LmlkcyA/PyBbXSxcbiAgICAgIGFuY2hvcnM6IGlucHV0LmFuY2hvcnMsXG4gICAgfSksXG4gIH0pO1xuICAvLyBSZXNwb25zZSBjYXJyaWVzIHtpZE1hcDogezxvbGRQcm9wb3NhbElkPjogPG1pbnRlZE5vZGVJZD59LCByYXRpZmllZDpbLi4uXX1cbiAgLy8g4oCUIHRoZSBpZE1hcCBpcyB0aGUgcG9pbnQgKHJlY29ubmVjdCBhbiBlZGdlL2FuY2hvciB0byB0aGUgcmVhbCBub2RlKS5cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDUpIOKAlCB0aGUgaW52ZXJzZSBvZiByYXRpZnktYmF0Y2g6IGNsZWFyIGEgc2V0IG9mIHByb3Bvc2Fsc1xuLy8gaW4gT05FIHRyYW5zYWN0aW9uYWwgY2FsbCBpbnN0ZWFkIG9mIE4gSFRUUCBkZWxldGVzIGluIGEgbG9vcC5cbmFzeW5jIGZ1bmN0aW9uIGNtZERlbGV0ZUJhdGNoKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcignZGVsZXRlLWJhdGNoIHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7aWRzOiBbXCI8cHJvcG9zYWxJZD5cIiwgLi4uXX0nLCB7XG4gICAgICBoaW50OlxuICAgICAgICBcImRlbGV0ZXMgdGhlIHNldCBpbiBPTkUgdHhuIOKAlCBhbGwtb3Itbm90aGluZzogaWYgYW55IGlkIGlzIHVua25vd24sIE5PVEhJTkcgaXMgXCIgK1xuICAgICAgICBcImRlbGV0ZWQgYW5kIHRoZSBlcnJvciBuYW1lcyBldmVyeSB1bmtub3duIGlkLiBUaGVyZSBpcyBkZWxpYmVyYXRlbHkgbm8gXCIgK1xuICAgICAgICBcIntiYXRjaDogPGlkPn0gc2hvcnRoYW5kIOKAlCBydW4gYHN0YXRlIC0tYmF0Y2ggPGlkPmAgYW5kIGxvb2sgYmVmb3JlIHlvdSBzd2VlcCBcIiArXG4gICAgICAgIFwiKGRyaXZlICMxMCdzIGJ1ZyB3YXMgYW4gb3Zlci1icm9hZCBjbGVhbnVwIHRoYXQgdG9vayB0aGUgZWRnZXMgd2l0aCBpdClcIixcbiAgICB9KTtcbiAgfVxuICBjb25zdCBpbnB1dCA9IEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyBpZHM/OiB1bmtub3duIH07XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL2RlbGV0ZS1iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZHM6IGlucHV0LmlkcyA/PyBbXSB9KSxcbiAgfSk7XG4gIGNvbnN0IGRlbGV0ZUJhdGNoQm9keSA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RlbGV0ZUJhdGNoQm9keX1cXG5gKTtcbiAgLy8gUjEyIGdhdGUgZmluZGluZyAxOiBtaXJyb3IgdGhlIHN0cmFuZGVkLW5vZGUgYWR2aXNvcnkgdG8gc3RkZXJyLCB0aGUgc2FtZVxuICAvLyB3YXkgcHJvcG9zZS1lZGdlIG1pcnJvcnMgZWRnZURyYWZ0V2FybmluZyDigJQgYSBjb2xkIGFnZW50IHNjYW5uaW5nIGZvclxuICAvLyBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgbmV2ZXIgcGFyc2VzIHN0ZG91dC4gQWR2aXNvcnksIG5vdCBhIGZhaWx1cmU6XG4gIC8vIHRoZSBleGl0IGNvZGUgaXMgdW5jaGFuZ2VkLlxuICB0cnkge1xuICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShkZWxldGVCYXRjaEJvZHkpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICB9IGNhdGNoIHtcbiAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgfVxuICByZXR1cm4gMDtcbn1cblxuY29uc3QgcHJvamVjdFFzID0gKHBhcnNlZDogUGFyc2VkKTogc3RyaW5nID0+XG4gIHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuXG4vLyBSb3VuZCA2IChERUwpOiBgbm9kZSBkZWxldGUgPGlkPiBbLS1mb3JjZV1gIOKAlCA0MDkge2Vycm9yOlwiY2l0ZWRcIixcbi8vIGNpdGVkQnk6e2VkZ2VzLCBjaGlsZHJlbn19IHdoZW4gY2l0ZWQgYW5kIHVuZm9yY2VkOyAtLWZvcmNlIGNhc2NhZGVzXG4vLyAoZWRnZXMgZ29uZSwgY2hpbGRyZW4gcmUtcGFyZW50ZWQgdG8gdG9wLWxldmVsLCBkZXRyaXR1cyBnb25lKS5cbmFzeW5jIGZ1bmN0aW9uIGNtZE5vZGVEZWxldGUocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuZm9yY2UpIHBhcmFtcy5zZXQoXCJmb3JjZVwiLCBcIjFcIik7XG4gIGNvbnN0IGRxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDQpOiBgbm9kZSBlZGl0IDxpZD4gWy0tdGl0bGUgVF0gWy0tc3lub3BzaXMgU10gfCAtLXN0ZGluYFxuLy8g4oCUIGEgcmF0aWZpZWQgbm9kZSBjYW4gZmluYWxseSBnYWluIGEgc3lub3BzaXMgKEYyKS4gV3JpdGVzIGV4YWN0bHkgd2hhdFxuLy8gaXQgaXMgZ2l2ZW47IHRpZXIgYW5kIGtpbmQgYXJlIE5PVCBlZGl0YWJsZSAoc2VlIGVkaXQudHMgZm9yIHdoeSkuXG5hc3luYyBmdW5jdGlvbiBjbWROb2RlRWRpdChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcGF0Y2g6IHsgdGl0bGU/OiBzdHJpbmc7IHN5bm9wc2lzPzogc3RyaW5nIH0gPSB7fTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAvLyBQcm9zZSBiZWxvbmdzIG9uIHN0ZGluIOKAlCBhIHN5bm9wc2lzIGlzIGEgcGFyYWdyYXBoLCBub3QgYSBmbGFnIHZhbHVlLlxuICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICBwYXRjaCxcbiAgICAgIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyB0aXRsZT86IHN0cmluZzsgc3lub3BzaXM/OiBzdHJpbmcgfSxcbiAgICApO1xuICB9XG4gIGlmIChwYXJzZWQudmFsdWVzLnRpdGxlICE9PSB1bmRlZmluZWQpIHBhdGNoLnRpdGxlID0gcGFyc2VkLnZhbHVlcy50aXRsZTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc3lub3BzaXMgIT09IHVuZGVmaW5lZCkgcGF0Y2guc3lub3BzaXMgPSBwYXJzZWQudmFsdWVzLnN5bm9wc2lzO1xuICBpZiAocGF0Y2gudGl0bGUgPT09IHVuZGVmaW5lZCAmJiBwYXRjaC5zeW5vcHNpcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICd1c2FnZTogY2xpLnRzIG5vZGUgZWRpdCA8bm9kZUlkPiAoLS10aXRsZSA8dD4gfCAtLXN5bm9wc2lzIDxzPiB8IC0tc3RkaW4gXFwne1wic3lub3BzaXNcIjogXCIuLi5cIn1cXCcpJyxcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICBcIndyaXRlcyBleGFjdGx5IHdoYXQgaXQgaXMgZ2l2ZW4gKG5vIGluZmVyZW5jZSk7IG9ubHkgdGl0bGUvc3lub3BzaXMgYXJlIGVkaXRhYmxlIOKAlCBcIiArXG4gICAgICAgICAgXCJ0aWVyIGlzIHRoZSBodW1hbidzIHJ1bGluZyBhbmQga2luZCBpcyBhIHJhdGlmaWNhdGlvbi10aW1lIGNsYXNzaWZpY2F0aW9uXCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9ub2Rlcy8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgLy8gQm9keS1taXJyb3IgZGlzY2lwbGluZTogdGhyZWFkIGV2ZXJ5IGZpZWxkIGV4cGxpY2l0bHkgKHRoZVxuICAgIC8vIHByb3Bvc2Utbm9kZS10YWdzIHNjYXIpIOKAlCBhbiBvbWl0dGVkIGtleSBtdXN0IHN0YXkgb21pdHRlZCBzbyB0aGVcbiAgICAvLyByb3V0ZSBwYXRjaGVzIGluc3RlYWQgb2YgYmxhbmtpbmcuXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgLi4uKHBhdGNoLnRpdGxlICE9PSB1bmRlZmluZWQgPyB7IHRpdGxlOiBwYXRjaC50aXRsZSB9IDoge30pLFxuICAgICAgLi4uKHBhdGNoLnN5bm9wc2lzICE9PSB1bmRlZmluZWQgPyB7IHN5bm9wc2lzOiBwYXRjaC5zeW5vcHNpcyB9IDoge30pLFxuICAgIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogYC0tdG8gPGlkPiB8IC0tY2xlYXJgLCBleGFjdGx5IG9uZSDigJQgYG5vZGUgYW5jaG9yYCBhbmQgYHByb3Bvc2FsIHpvbmVgLiBBXG4gKiBydWxlIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3Qgc3RhdGUgKGl0IHB1Ymxpc2hlcyBib3RoIGZsYWdzIGFzIHZhbGlkKSwgc28gaXRcbiAqIHJpZGVzIHRoZSByb3cncyBgY2hlY2tgIGFuZCBpcyByZWZ1c2VkIGJlZm9yZSB0aGUgaGFuZGxlciBydW5zLlxuICovXG5jb25zdCB0b1hvckNsZWFyID0gKGludjogSW52b2NhdGlvbjxGbGFnPik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gIGNvbnN0IGhhc1RvID0gaW52LmZsYWdzLnRvICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGNsZWFyID0gaW52LmZsYWdzLmNsZWFyID09PSB0cnVlO1xuICBpZiAoaGFzVG8gJiYgY2xlYXIpIHJldHVybiBcImdpdmUgLS10byA8aWQ+IG9yIC0tY2xlYXIsIG5vdCBib3RoXCI7XG4gIGlmICghaGFzVG8gJiYgIWNsZWFyKSByZXR1cm4gXCJnaXZlIC0tdG8gPGlkPiBvciAtLWNsZWFyXCI7XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjbWROb2RlQW5jaG9yKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L25vZGVzLyR7aWR9L2FuY2hvciR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJlbnRJZDogcGFyc2VkLnZhbHVlcy5jbGVhciA/IG51bGwgOiBwYXJzZWQudmFsdWVzLnRvIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYWQocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbWVzc2FnZS8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRab25lQ3JlYXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgbmFtZSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS96b25lcyR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFpvbmVMaXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS96b25lcyR7cHJvamVjdFFzKHBhcnNlZCl9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRab25lRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnllcykgcGFyYW1zLnNldChcInllc1wiLCBcIjFcIik7XG4gIGNvbnN0IGRxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb21vdGUocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzLyR7aWR9L3Byb21vdGUke3Byb2plY3RRcyhwYXJzZWQpfWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb3Bvc2FsWm9uZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vem9uZSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB6b25lSWQ6IHBhcnNlZC52YWx1ZXMuY2xlYXIgPyBudWxsIDogcGFyc2VkLnZhbHVlcy50byB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCA2IChERUwpOiBgcHJvcG9zYWwgZGVsZXRlIDxpZD5gIOKAlCB0aGluLCBubyBndWFyZCAoZHJvcCByb3cgK1xuLy8gY2FzY2FkZSBub2RlX2FjdGlvbnMpLiBUaGUgbGl0dGVyLWNsZWFyaW5nIHBhdGggKGNsZWFyIGEgcmF3XG4vLyBpbnN0cnVjdGlvbi1ub2RlIHRocm91Z2ggREVMRVRFLCBub3QgcmVqZWN0KS5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb3Bvc2FsRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJERUxFVEVcIixcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBgZG9jIDxpZD5gIHJlYWRzIGFuZCBgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXWAgZGVsZXRlcy4gVGhlIGBkb2NgIGdyb3VwXG4vLyBmaW5kcyBpdHMgc3ViLXZlcmIgYXQgdGhlIEZJUlNUIFBPU0lUSU9OQUwsIHNvIGZsYWdzIG1heSBjb21lIGZpcnN0XG4vLyAoYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWApOyBhIGRvYyBsaXRlcmFsbHkgbmFtZWQgXCJkZWxldGVcIiBvclxuLy8gXCJraW5kXCIgaXMgcmVhZCB3aXRoIGBkb2MgLS0gZGVsZXRlYCwgc2luY2UgdGhlIHNjYW4gc3RvcHMgYXQgYSBiYXJlIGAtLWAuXG5hc3luYyBmdW5jdGlvbiBjbWREb2MoaXNEZWxldGU6IGJvb2xlYW4sIHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGlmIChpc0RlbGV0ZSAmJiBwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vZG9jLyR7aWR9JHtxc31gLCB7XG4gICAgbWV0aG9kOiBpc0RlbGV0ZSA/IFwiREVMRVRFXCIgOiBcIkdFVFwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDQgKEsxKTogYGRvYyBraW5kIDxkb2NJZD4gPGtpbmQuLi4+IFstLWF1dGhvciB1c2VyfGFnZW50XWAgc2V0cyxcbi8vIGBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJgIGNsZWFycyAoYXV0aG9yIG51bGxzIHdpdGggaXQpLiBUaGUgaW5nZXN0XG4vLyBkZWZhdWx0cyBkaWVkIOKAlCB0aGlzIHZlcmIgaXMgaG93IGEgZG9jIGdldHMgdHlwZWQgYXQgYWxsLlxuYXN5bmMgZnVuY3Rpb24gY21kRG9jS2luZChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGRvY0lkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3Qga2luZFdvcmRzID0gcGFyc2VkLnBvc2l0aW9uYWxzLnNsaWNlKDEpLmpvaW4oXCIgXCIpO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9raW5kJHtwcm9qZWN0UXMocGFyc2VkKX1gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShcbiAgICAgIHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgICAgPyB7IGtpbmQ6IG51bGwgfVxuICAgICAgICA6IHsga2luZDoga2luZFdvcmRzLCBhdXRob3I6IHBhcnNlZC52YWx1ZXMuYXV0aG9yID8/IFwiYWdlbnRcIiB9LFxuICAgICksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTWFyayhwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGRvY0lkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICBpZiAoIWRvY0lkIHx8ICFwYXJzZWQudmFsdWVzLnN0YXR1cykge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dXCIpO1xuICB9XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vZG9jLyR7ZG9jSWR9L21hcmske3FzfWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGF1dGhvcjogcGFyc2VkLnZhbHVlcy5hdXRob3IgPz8gXCJhZ2VudFwiLFxuICAgICAgbm90ZTogcGFyc2VkLnZhbHVlcy5ub3RlLFxuICAgICAgc3RhdHVzOiBwYXJzZWQudmFsdWVzLnN0YXR1cyxcbiAgICB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTZWFyY2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBxdWVyeSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgaWYgKCFxdWVyeSkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHNlYXJjaCA8cXVlcnkuLi4+XCIpO1xuICB9XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBxOiBxdWVyeSB9KTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zZWFyY2g/JHtwYXJhbXN9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWROZWlnaGJvcnMocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFpZCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXVwiKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPz8gXCIxXCIgfSk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbmVpZ2hib3JzLyR7aWR9PyR7cGFyYW1zfWApO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmF0aWZ5KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcHJvcG9zYWxJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFwcm9wb3NhbElkIHx8ICFwYXJzZWQudmFsdWVzLnJ1bGluZykge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgcmF0aWZ5IDxwcm9wb3NhbElkPiAtLXJ1bGluZyA8cj4gWy0tZG9jLWVkaXQgPGZpbGU+XSBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSBbLS1hbmNob3IgPHBhcmVudElkPl1cXG5cIixcbiAgICApO1xuICB9XG4gIC8vIC0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQg4oCUIHRoZSBkYWVtb24gZW5mb3JjZXMgaXQgdG9vLCBidXQgYSBsb2NhbFxuICAvLyB1c2FnZSBlcnJvciBiZWF0cyBhIHJvdW5kLXRyaXAgZm9yIHRoZSBjb21tb24gc2xpcC5cbiAgaWYgKHBhcnNlZC52YWx1ZXMuZG9jICYmICFwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl0pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFwiLS1kb2MgcmVxdWlyZXMgLS1kb2MtZWRpdCAodGhlIGRyYWZ0ZWQgZG9jIGhvbWUpXCIpO1xuICB9XG4gIGNvbnN0IGRvY0VkaXQgPSBwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl1cbiAgICA/IHJlYWRGaWxlU3luYyhwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl0sIFwidXRmOFwiKVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke3Byb3Bvc2FsSWR9L3J1bGluZyR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsaW5nOiBwYXJzZWQudmFsdWVzLnJ1bGluZyxcbiAgICAgIGRvY0VkaXQsXG4gICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICBzcGFuOiBwYXJzZWQudmFsdWVzLnNwYW4sXG4gICAgICAvLyBSb3VuZCA2IChSQik6IC0tYW5jaG9yIDxwYXJlbnRJZD4gcmF0aWZpZXMgdGhlbiBuZXN0cyB0aGUgbWludGVkXG4gICAgICAvLyBub2RlIHVuZGVyIDxwYXJlbnRJZD4gaW4gb25lIGF0b21pYyBjYWxsIChub2RlIHByb3Bvc2FscyBvbmx5KS5cbiAgICAgIGFuY2hvcjogcGFyc2VkLnZhbHVlcy5hbmNob3IsXG4gICAgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuLy8gUm91bmQgMyAoQ2xhaW0gVjIpOiBvbmUgbGVucywgdHdvIG1vZGVzIOKAlCAtLW5vZGUgYW5kIC0tZG9jIGFyZSBleGNsdXNpdmVcbi8vICh0aGUgZGFlbW9uIGVuZm9yY2VzIHRoZSBYT1IgdG9vLCBidXQgdGhlIGNvbW1vbiBzbGlwIHNob3VsZCBmYWlsIGJlZm9yZSBhXG4vLyByb3VuZC10cmlwKS4gVGhlIHJvdydzIGBjaGVja2AgcmVmdXNlcyB0aGUgc2xpcDsgdGhpcyBvbmx5IHBvc3RzLlxuYXN5bmMgZnVuY3Rpb24gY21kTGVuc1NldChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbGVucyR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgb3duZXI6IHBhcnNlZC52YWx1ZXMub3duZXIgPz8gXCJhZ2VudFwiLFxuICAgICAgbm9kZUlkOiBwYXJzZWQudmFsdWVzLm5vZGUsXG4gICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICBkZXB0aDogcGFyc2VkLnZhbHVlcy5kZXB0aCA/IE51bWJlci5wYXJzZUludChwYXJzZWQudmFsdWVzLmRlcHRoLCAxMCkgOiB1bmRlZmluZWQsXG4gICAgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTGVuc0NsZWFyKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9sZW5zJHtwcm9qZWN0UXMocGFyc2VkKX1gLCB7XG4gICAgbWV0aG9kOiBcIkRFTEVURVwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExvb2tIZXJlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGlmICghaWQpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBsb29rLWhlcmUgPG5vZGVJZD5cIik7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9sb29rLWhlcmUvJHtpZH0ke3FzfWAsIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogYC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyYCwgZXhhY3RseSBvbmUg4oCUIGBhY3Rpb25zYCBhbmQgYHRhZ3NgLiBUaGVcbiAqIGRlY2xhcmF0aW9uIHB1Ymxpc2hlcyBhbGwgdGhyZWUgYXMgdmFsaWQ7IHRoZSBydWxlIHJpZGVzIHRoZSByb3cncyBgY2hlY2tgLlxuICovXG5jb25zdCBleGFjdGx5T25lTW9kZSA9IChpbnY6IEludm9jYXRpb248RmxhZz4pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT4ge1xuICBjb25zdCBtb2RlcyA9IFtpbnYuZmxhZ3Muc2V0ICE9PSB1bmRlZmluZWQsIGludi5mbGFncy5zdGRpbiA9PT0gdHJ1ZSwgaW52LmZsYWdzLmNsZWFyID09PSB0cnVlXTtcbiAgcmV0dXJuIG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggPT09IDFcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogXCJnaXZlIGV4YWN0bHkgb25lIG9mIC0tc2V0IDxqc29uPiwgLS1zdGRpbiBvciAtLWNsZWFyXCI7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjbWRBY3Rpb25zKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdGFyZ2V0SWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGNvbnN0IG1vZGVzID0gW3BhcnNlZC52YWx1ZXMuc2V0ICE9PSB1bmRlZmluZWQsIHBhcnNlZC52YWx1ZXMuc3RkaW4sIHBhcnNlZC52YWx1ZXMuY2xlYXJdO1xuICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIGFjdGlvbnMgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpXFxuXCIgK1xuICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICcgIHtcImlkXCIsIFwibGFiZWxcIiwgXCJzZWVkXCJ9IOKAlCBlbXB0eSBhcnJheSAob3IgLS1jbGVhcikgcmVtb3ZlcyB0aGUgc2xvdHNcXG4nLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpb25zLyR7dGFyZ2V0SWR9JHtxc31gO1xuICBjb25zdCByZXMgPSBwYXJzZWQudmFsdWVzLmNsZWFyXG4gICAgPyBhd2FpdCBmZXRjaCh0YXJnZXQsIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pXG4gICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBVVFwiLFxuICAgICAgICBib2R5OiBwYXJzZWQudmFsdWVzLnN0ZGluID8gYXdhaXQgQnVuLnN0ZGluLnRleHQoKSA6IChwYXJzZWQudmFsdWVzLnNldCBhcyBzdHJpbmcpLFxuICAgICAgfSk7XG4gIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgLy8gTWlycm9yIHRoZSBkYWVtb24ncyBhZGRpdGl2ZSBzb2Z0LWNhcCB3YXJuaW5nIHRvIHN0ZGVyciAodGhlXG4gIC8vIGVkZ2VEcmFmdFdhcm5pbmcgcGF0dGVybiDigJQgYSBjb2xkIGFnZW50IHNjYW5uaW5nIGZvciBwcm9ibGVtcyBzZWVzIGl0KS5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDcgKFRBR1MpIOKAlCB0d2luIG9mIHRoZSBhY3Rpb25zIHZlcmI6IHdob2xlc2FsZSByZXBsYWNlIC8gY2xlYXIgYVxuLy8gdGFyZ2V0J3MgZnJlZWZvcm0gdGFncy4gVGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWdzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdGFyZ2V0SWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGNvbnN0IG1vZGVzID0gW3BhcnNlZC52YWx1ZXMuc2V0ICE9PSB1bmRlZmluZWQsIHBhcnNlZC52YWx1ZXMuc3RkaW4sIHBhcnNlZC52YWx1ZXMuY2xlYXJdO1xuICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIHRhZ3MgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpXFxuXCIgK1xuICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgIFwiICBmcmVlZm9ybSBzdHJpbmdzIOKAlCBlbXB0eSBhcnJheSAob3IgLS1jbGVhcikgcmVtb3ZlcyB0aGUgdGFnc1xcblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS90YWdzLyR7dGFyZ2V0SWR9JHtxc31gO1xuICBjb25zdCByZXMgPSBwYXJzZWQudmFsdWVzLmNsZWFyXG4gICAgPyBhd2FpdCBmZXRjaCh0YXJnZXQsIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pXG4gICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBVVFwiLFxuICAgICAgICBib2R5OiBwYXJzZWQudmFsdWVzLnN0ZGluID8gYXdhaXQgQnVuLnN0ZGluLnRleHQoKSA6IChwYXJzZWQudmFsdWVzLnNldCBhcyBzdHJpbmcpLFxuICAgICAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCA5IChKb2IgUXVldWUpIOKAlCB0aGUgYGpvYmAgZ3JvdXA6IGNyZWF0ZS91cGRhdGUvY2xhaW0vcmVsZWFzZS9zdWJ0YXNrL1xuLy8gbGlzdC9kZWxldGUsIGNvcHlpbmcgdGhlIGBwcm9wb3NhbCA8c3ViPmAgbGlmZWN5Y2xlIHNoYXBlICsgdGhlIHRhZ3Ncbi8vIGJvZHktYnVpbGRlciBkaXNjaXBsaW5lLiBFVkVSWSBmaWVsZCBpcyB0aHJlYWRlZCBpbnRvIHRoZSBQT1NUIGJvZHkgKHRoZSBSN1xuLy8gZ2F0ZSBzY2FyOiBhIGhhbmQtd3JpdHRlbiBib2R5LWJ1aWxkZXIgaXMgYSBNSVJST1Igb2YgdGhlIHJvdXRlJ3MgZmllbGQgc2V0XG4vLyBhbmQgZHJpZnRzIHNpbGVudGx5IOKAlCBzbyB1cGRhdGUgZm9yd2FyZHMgZWFjaCBwcm92aWRlZCBzY2FsYXIsIHN1YnRhc2tcbi8vIGZvcndhcmRzIG9wICsgbGFiZWx8c3VidGFza0lkLCBjbGFpbSBmb3J3YXJkcyBvd25lcikuXG5jb25zdCBqb2JVcmwgPSAocG9ydDogbnVtYmVyLCBwYXJzZWQ6IFBhcnNlZCwgc3VmZml4ID0gXCJcIik6IHN0cmluZyA9PlxuICBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2pvYnMke3N1ZmZpeH0ke3Byb2plY3RRcyhwYXJzZWQpfWA7XG5cbi8vIEEgSlNPTiBib2R5IGZyb20gLS1ib2R5LWZpbGUgPiAtLXN0ZGluIG92ZXJyaWRlcyB0aGUgZmxhZy1idWlsdCBib2R5ICh0aGVcbi8vIHNlbmQgcHJlY2VkZW5jZSBjaGFpbiksIHNvIGEgZnVsbCBqb2IgY2FuIGJlIHBpcGVkIGluIG9uZSBzaG90LlxuYXN5bmMgZnVuY3Rpb24gam9iQm9keUZyb21Tb3VyY2UocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbD4ge1xuICBpZiAocGFyc2VkLnZhbHVlc1tcImJvZHktZmlsZVwiXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgaWYgKCFleGlzdHNTeW5jKHApKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKGBqb2I6IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwfWApO1xuICAgIH1cbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfVxuICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRKb2JMaXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goam9iVXJsKHBvcnQsIHBhcnNlZCkpO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iQ3JlYXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBqb2JCb2R5RnJvbVNvdXJjZShwYXJzZWQpO1xuICBjb25zdCBib2R5ID0gb3ZlcnJpZGUgPz8ge1xuICAgIHRpdGxlOiBwYXJzZWQudmFsdWVzLnRpdGxlLFxuICAgIHN0YXR1czogcGFyc2VkLnZhbHVlcy5zdGF0dXMsXG4gICAgZGVsaXZlcmFibGU6IHBhcnNlZC52YWx1ZXMuZGVsaXZlcmFibGUsXG4gICAgZGV0YWlsOiBwYXJzZWQudmFsdWVzLmRldGFpbCxcbiAgfTtcbiAgaWYgKHR5cGVvZiBib2R5LnRpdGxlICE9PSBcInN0cmluZ1wiIHx8IGJvZHkudGl0bGUgPT09IFwiXCIpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiBjcmVhdGUgLS10aXRsZSA8dD4gWy0tc3RhdHVzIDxzPl0gWy0tZGVsaXZlcmFibGUgPHJlZj5dIFstLWRldGFpbCA8eD5dXFxuXCIgK1xuICAgICAgICBcIiAgb3I6IGNsaS50cyBqb2IgY3JlYXRlICgtLXN0ZGluIHwgLS1ib2R5LWZpbGUgPHBhdGg+KSB3aXRoIEpTT04ge3RpdGxlLCBzdGF0dXM/LCBkZWxpdmVyYWJsZT8sIGRldGFpbD99XFxuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkKSwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYlVwZGF0ZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBqb2JCb2R5RnJvbVNvdXJjZShwYXJzZWQpO1xuICAvLyBGb3J3YXJkIG9ubHkgdGhlIGZsYWdzIHRoYXQgd2VyZSBQUk9WSURFRCAodGhyZWFkIGV2ZXJ5IGZpZWxkIOKAlCB0aGUgUjdcbiAgLy8gYm9keS1taXJyb3Igc2Nhcik7IGEgYmFyZSBgam9iIHVwZGF0ZSA8aWQ+YCB3aXRoIG5vIGZpZWxkcyBpcyBhIHVzYWdlXG4gIC8vIGVycm9yLCBub3QgYSBzaWxlbnQgbm8tb3AgUE9TVC5cbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPVxuICAgIG92ZXJyaWRlID8/XG4gICAgT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgKFtcInRpdGxlXCIsIFwic3RhdHVzXCIsIFwiZGVsaXZlcmFibGVcIiwgXCJkZXRhaWxcIl0gYXMgY29uc3QpXG4gICAgICAgIC5maWx0ZXIoKGspID0+IHBhcnNlZC52YWx1ZXNba10gIT09IHVuZGVmaW5lZClcbiAgICAgICAgLm1hcCgoaykgPT4gW2ssIHBhcnNlZC52YWx1ZXNba11dKSxcbiAgICApO1xuICBpZiAoT2JqZWN0LmtleXMoYm9keSkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIFwidXNhZ2U6IGNsaS50cyBqb2IgdXBkYXRlIDxpZD4gKGF0IGxlYXN0IG9uZSBvZiAtLXRpdGxlfC0tc3RhdHVzfC0tZGVsaXZlcmFibGV8LS1kZXRhaWwpXFxuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9YCksIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYkNsYWltKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBpZiAocGFyc2VkLnZhbHVlcy5vd25lciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgam9iIGNsYWltIDxpZD4gLS1vd25lciA8d2hvPlwiKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9L2NsYWltYCksIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgb3duZXI6IHBhcnNlZC52YWx1ZXMub3duZXIgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iUmVsZWFzZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goam9iVXJsKHBvcnQsIHBhcnNlZCwgYC8ke2lkfS9yZWxlYXNlYCksIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKiBgLS1hZGQgfCAtLWNoZWNrIHwgLS11bmNoZWNrYCwgZXhhY3RseSBvbmUg4oCUIGBqb2Igc3VidGFza2AncyBgY2hlY2tgLiAqL1xuY29uc3Qgb25lU3VidGFza09wID0gKGludjogSW52b2NhdGlvbjxGbGFnPik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gIGNvbnN0IG1vZGVzID0gW2ludi5mbGFncy5hZGQsIGludi5mbGFncy5jaGVjaywgaW52LmZsYWdzLnVuY2hlY2tdLmZpbHRlcigodikgPT4gdiAhPT0gdW5kZWZpbmVkKTtcbiAgcmV0dXJuIG1vZGVzLmxlbmd0aCA9PT0gMVxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBcImdpdmUgZXhhY3RseSBvbmUgb2YgLS1hZGQgPGxhYmVsPiwgLS1jaGVjayA8c3VidGFza0lkPiBvciAtLXVuY2hlY2sgPHN1YnRhc2tJZD5cIjtcbn07XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYlN1YnRhc2socGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IGpvYkJvZHkgPVxuICAgIHBhcnNlZC52YWx1ZXMuYWRkICE9PSB1bmRlZmluZWRcbiAgICAgID8geyBvcDogXCJhZGRcIiwgbGFiZWw6IHBhcnNlZC52YWx1ZXMuYWRkIH1cbiAgICAgIDogcGFyc2VkLnZhbHVlcy5jaGVjayAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8geyBvcDogXCJjaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMuY2hlY2sgfVxuICAgICAgICA6IHsgb3A6IFwidW5jaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMudW5jaGVjayB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9L3N1YnRhc2tgKSwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoam9iQm9keSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9YCksIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWN0aXZpdHkocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBzdGF0ZSA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFBQ1RJVklUWV9TVEFURVMuaW5jbHVkZXMoc3RhdGUgYXMgKHR5cGVvZiBBQ1RJVklUWV9TVEFURVMpW251bWJlcl0pKSB7XG4gICAgLy8g4puUIE9ORSBBUlJBWSwgQ0hFQ0tFRCBBTkQgUFVCTElTSEVEIChBMSkuIFRoZSBtZW1iZXJzIHdlcmUgYSB0aHJlZS13YXlcbiAgICAvLyBgIT09YCBjaGFpbiBmb3IgdGhlIGNoZWNrIGFuZCB0aGUgc3RyaW5nIGA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT5gIGZvclxuICAgIC8vIHRoZSBtZXNzYWdlIOKAlCB0d28gY29waWVzIG9mIG9uZSBjbG9zZWQgc2V0LCBhbmQgdGhlIG1hY2hpbmUtcmVhZGFibGVcbiAgICAvLyBvbmUgZGlkIG5vdCBleGlzdC4gVGhpcyBpcyB0aGUgTEFTVCBlbnVtZXJhdGVkIHZhbHVlIGluIHRoaXMgZmlsZSB0aGF0XG4gICAgLy8gd2FzIHN0aWxsIHByb3NlLW9ubHk7IGV2ZXJ5IG90aGVyIHJlamVjdGlvbiBoZXJlIGFscmVhZHkgaGFkIGBjaG9pY2VzYC5cbiAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBhY3Rpdml0eSA8c3RhdGU+IFstLW1lc3NhZ2UgPGlkPl1cIiwge1xuICAgICAgaGludDogXCJzdGF0ZSBpcyB0aGUgZmlyc3QgcG9zaXRpb25hbFwiLFxuICAgICAgY2hvaWNlczogWy4uLkFDVElWSVRZX1NUQVRFU10sXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpdml0eSR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0ZSwgbWVzc2FnZUlkOiBwYXJzZWQudmFsdWVzLm1lc3NhZ2UgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vIFJvdW5kIDMgKENsYWltIEMxKTogZ3JhcGV2aW5lJ3MgYm9keS1yZXNvbHV0aW9uIGNoYWluLCBwcmVjZWRlbmNlXG4gIC8vIC0tYm9keS1maWxlID4gLS1zdGRpbiA+IGlubGluZSBwb3NpdGlvbmFsID4gcGlwZWQtc3RkaW4gZGVmYXVsdC5cbiAgLy8gU2hhcnAgZWRnZSAobWVhc3VyZWQsIGhvdXNlLXdpZGUpOiB0aGUgcGlwZWQtc3RkaW4gZGVmYXVsdCBIQU5HU1xuICAvLyBGT1JFVkVSIHVuZGVyIGFnZW50IHNoZWxscyAoaXNUVFkgbnVsbCwgbm8gRU9GKSDigJQgbm8gcmVhZCB0aW1lb3V0IG9uXG4gIC8vIHB1cnBvc2UgKGl0IHdvdWxkIGJyZWFrIHNsb3cgcGlwZXMpOyBhbHdheXMgcGFzcyBhIGJvZHkuXG4gIGNvbnN0IGhhc0lubGluZSA9IHBhcnNlZC5wb3NpdGlvbmFscy5sZW5ndGggPiAwO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBsZXQgZnJvbUlubGluZSA9IGZhbHNlO1xuICBpZiAocGFyc2VkLnZhbHVlc1tcImJvZHktZmlsZVwiXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcGF0aCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKGBzZW5kOiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gKTtcbiAgICB9XG4gICAgLy8gVHJhaWxpbmcgbmV3bGluZSBzdHJpcHBlZCAoZmlsZXMgYW5kIGhlcmVkb2NzIGVuZCB3aXRoIG9uZTsgdGhlXG4gICAgLy8gbWVzc2FnZSBzaG91bGRuJ3QpIOKAlCBtYXRjaGluZyAtLXN0ZGluLCBhbmQgZ3JhcGV2aW5lLlxuICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKTtcbiAgfSBlbHNlIGlmIChwYXJzZWQudmFsdWVzLnN0ZGluIHx8ICghaGFzSW5saW5lICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgIHRleHQgPSAoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkucmVwbGFjZSgvXFxuJC8sIFwiXCIpO1xuICB9IGVsc2Uge1xuICAgIHRleHQgPSBwYXJzZWQucG9zaXRpb25hbHMuam9pbihcIiBcIik7XG4gICAgZnJvbUlubGluZSA9IHRydWU7XG4gIH1cbiAgLy8gQW4gRU1QVFkgcmVzb2x2ZWQgYm9keSBpcyBhIHVzYWdlIGVycm9yIChleGl0IDIpLCB3aGF0ZXZlciBwYXRoXG4gIC8vIHByb2R1Y2VkIGl0IOKAlCBhIGJsYW5rIG1lc3NhZ2UgaGVscHMgbm9ib2R5IGFuZCB1c3VhbGx5IG1lYW5zIGEgZnVtYmxlLlxuICBpZiAodGV4dCA9PT0gXCJcIikge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgc2VuZCA8dGV4dC4uLj4gfCAtLWJvZHktZmlsZSA8cGF0aD4gfCAtLXN0ZGluXFxuXCIgK1xuICAgICAgICBcIm1pbmQtbWFwcGVyOiBzZW5kIHJlc29sdmVkIGFuIGVtcHR5IGJvZHkg4oCUIG5vdGhpbmcgc2VudFxcblwiLFxuICAgICk7XG4gIH1cbiAgLy8gQSBmdW1ibGVkIGhlcmVkb2MgcGlwZXMgdGhlIGxpdGVyYWwgc2VuZCBpbnZvY2F0aW9uIGluIGFzIHRoZSBib2R5IOKAlFxuICAvLyByZWZ1c2UgdG8gcG9zdCB0aGF0IChuYXJyb3dlZCB0byB0aGUgc2VuZCB2ZXJiOyAtLWZvcmNlIG92ZXJyaWRlcyBmb3JcbiAgLy8gYSBib2R5IHRoYXQgZ2VudWluZWx5IHF1b3RlcyB0aGUgY29tbWFuZCkuXG4gIGlmICghcGFyc2VkLnZhbHVlcy5mb3JjZSAmJiAvKD86XnxcXG4pWyBcXHRdKmJ1blxcYlteXFxuXSpcXGJjbGlcXC50c1xcYlteXFxuXSpcXGJzZW5kXFxiLy50ZXN0KHRleHQpKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIFwibWluZC1tYXBwZXI6IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGNsaSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgaGVyZWRvYz8pLiBcIiArXG4gICAgICAgIFwiTm90aGluZyB3YXMgc2VudC4gUGlwZSB0aGUgcmVhbCBib2R5IHZpYSAtLXN0ZGluIG9yIC0tYm9keS1maWxlIDxwYXRoPiwgXCIgK1xuICAgICAgICBcIm9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cXG5cIixcbiAgICApO1xuICB9XG4gIC8vIElubGluZSBib2RpZXMgd2l0aCBzdXJ2aXZpbmcgc2hlbGwgbWV0YWNoYXJhY3RlcnMgbWFkZSBpdCB0aHJvdWdoIFRISVNcbiAgLy8gdGltZSDigJQgd2FybiAoc3RkZXJyLCBuZXZlciBibG9ja3MpIGFuZCBzdGVlciB0byB0aGUgc2hlbGwtZnJlZSBwYXRocy5cbiAgaWYgKGZyb21JbmxpbmUgJiYgL2B8XFwkXFwofFxcJFxcey8udGVzdCh0ZXh0KSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgXCIjIHdhcm5pbmc6IGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgZmlyc3Qg4oCUIFwiICtcbiAgICAgICAgXCJ1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zZW5kJHtxc31gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICByb2xlOiBwYXJzZWQudmFsdWVzLnJvbGUgPz8gXCJhZ2VudFwiLFxuICAgICAga2luZDogcGFyc2VkLnZhbHVlcy5raW5kID8/IFwidHVyblwiLFxuICAgICAgdGV4dCxcbiAgICAgIC8vIEZsYXR0ZW4gcmVwZWF0cywgc3BsaXQgY29tbWFzLCBkcm9wIGJsYW5rIGZyYWdtZW50cyDigJQgYW4gZW1wdHlcbiAgICAgIC8vIHJlc29sdmVkIGxpc3QgcG9zdHMgYXMgbm8gZ3JvdW5kIGF0IGFsbCAobmV2ZXIgW1wiXCJdKS5cbiAgICAgIGdyb3VuZDogKCgpID0+IHtcbiAgICAgICAgY29uc3QgcmVmcyA9IChwYXJzZWQudmFsdWVzLmdyb3VuZCA/PyBbXSlcbiAgICAgICAgICAuZmxhdE1hcCgoZykgPT4gZy5zcGxpdChcIixcIikpXG4gICAgICAgICAgLm1hcCgoZykgPT4gZy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcigoZykgPT4gZyAhPT0gXCJcIik7XG4gICAgICAgIHJldHVybiByZWZzLmxlbmd0aCA+IDAgPyByZWZzIDogdW5kZWZpbmVkO1xuICAgICAgfSkoKSxcbiAgICB9KSxcbiAgfSk7XG4gIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgLy8gUm91bmQgMTEgKFNFQU0gMSk6IG1pcnJvciB0aGUgZGFlbW9uJ3MgdW5rbm93bi1jaGFubmVsIGFkdmlzb3J5IHRvIHN0ZGVycixcbiAgLy8gc2FtZSBhcyBwcm9wb3NlLWVkZ2UncyBkcmFmdCB3YXJuaW5nIOKAlCBhIHR5cG8nZCBgLS1raW5kYCBpcyBvdGhlcndpc2UgYVxuICAvLyBtZXNzYWdlIHRoYXQgc2lsZW50bHkgcmVuZGVycyBhcyBhIHBsYWluIGNoYXQgdHVybi5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8vIOKUgOKUgCBUSEUgQ09NTUFORCBUQUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgZGlzcGF0Y2hlciwgdGhlIHBlci1wYXRoIGZsYWcgY2hlY2ssIHRoZSByZWplY3Rpb25zJyBgY2hvaWNlc2AsIGFyaXR5LFxuLy8gYC0tdmVyc2lvbmAgYW5kIHRoZSBgc2NoZW1hYCBkZWNsYXJhdGlvbiBhbGwgd2FsayBUSElTLCB0aHJvdWdoIHRoZSBob3VzZSdzXG4vLyBvbmUgcmVnaXN0cnkgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2ApLiBBIHBhdGggYWRkZWQgaGVyZSBpcyBkaXNwYXRjaGVkIGFuZFxuLy8gcHVibGlzaGVkIGJ5IGBzY2hlbWFgIGF0IG9uY2UuIFRoZSBoZWxwIHRleHQgaXMgdGhlIG9uZSBoYW5kLXdyaXR0ZW4gdmlld1xuLy8gKGBIRUxQYCBhYm92ZSk7IGBjbGktY29udHJhY3QudGVzdC50c2AgYmluZHMgaXQgdG8gdGhpcyB0YWJsZS5cblxuY29uc3Qgb25lID0gKG5hbWU6IHN0cmluZyk6IFBvc2l0aW9uYWxTcGVjW10gPT4gW3sgbmFtZSwgcmVxdWlyZWQ6IHRydWUgfV07XG5jb25zdCB3b3JkcyA9IChuYW1lOiBzdHJpbmcpOiBQb3NpdGlvbmFsU3BlY1tdID0+IFt7IG5hbWUsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XTtcbmNvbnN0IE5PTkU6IFBvc2l0aW9uYWxTcGVjW10gPSBbXTtcblxuY29uc3QgUk9XUzogQ29tbWFuZFNwZWM8RmxhZz5bXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJuby1vcGVuXCIsIFwicG9ydFwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3Bhd24gKG9yIGZpbmQpIHRoZSBkYWVtb24sIHByaW50IGl0cyB1cmxcIixcbiAgICBydW46IG9uKGNtZE9wZW4pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbXCJza2VsZXRvblwiLCBcImJhdGNoXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJ0aGUgcHJvamVjdCBzbmFwc2hvdFwiLFxuICAgIHJ1bjogb24oY21kU3RhdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjaGFuZ2VzXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJib3VuZGVkIGRlbHRhLCBhZGRpdGlvbnMgb25seVwiLFxuICAgIHJ1bjogb24oY21kQ2hhbmdlcyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJpbmJvdW5kXCIsIFwib25jZVwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwiU1NFIGV2ZW50cyBhcyBKU09OTFwiLFxuICAgIHJ1bjogb24oY21kVGFpbCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb2plY3RzXCIsXG4gICAgZmxhZ3M6IFtcImNyZWF0ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJsaXN0IHByb2plY3RzIC8gY3JlYXRlIG9uZVwiLFxuICAgIHJ1bjogb24oY21kUHJvamVjdHMpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbmdlc3RcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJmaWxlXCIsIFwic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImFkZCBhIGRvY1wiLFxuICAgIHJ1bjogb24oY21kSW5nZXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJvcG9zZS1ub2RlXCIsXG4gICAgZmxhZ3M6IFtcInN0ZGluXCIsIFwiem9uZVwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3RhZ2UgYSBub2RlIHByb3Bvc2FsXCIsXG4gICAgcnVuOiBvbigocCkgPT4gY21kUHJvcG9zZShcInByb3Bvc2Utbm9kZVwiLCBwKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb3Bvc2UtZWRnZVwiLFxuICAgIGZsYWdzOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcInN0YWdlIGFuIGVkZ2UgcHJvcG9zYWxcIixcbiAgICBydW46IG9uKChwKSA9PiBjbWRQcm9wb3NlKFwicHJvcG9zZS1lZGdlXCIsIHApKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJvcG9zZS1iYXRjaFwiLFxuICAgIGZsYWdzOiBbXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3RhZ2UgYSBzZXQgaW4gb25lIHR4blwiLFxuICAgIHJ1bjogb24oY21kUHJvcG9zZUJhdGNoKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmF0aWZ5LWJhdGNoXCIsXG4gICAgZmxhZ3M6IFtcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJyYXRpZnkgYSBzZXQgaW4gb25lIHR4blwiLFxuICAgIHJ1bjogb24oY21kUmF0aWZ5QmF0Y2gpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkZWxldGUtYmF0Y2hcIixcbiAgICBmbGFnczogW1wic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIHByb3Bvc2FsIHNldCBpbiBvbmUgdHhuXCIsXG4gICAgcnVuOiBvbihjbWREZWxldGVCYXRjaCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vZGUgYW5jaG9yXCIsXG4gICAgZmxhZ3M6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJub2RlSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiYW5jaG9yIGEgbm9kZSB1bmRlciBhIHBhcmVudCAoLS10bykgb3IgYmFjayB0byB0b3AtbGV2ZWwgKC0tY2xlYXIpXCIsXG4gICAgY2hlY2s6IHRvWG9yQ2xlYXIsXG4gICAgcnVuOiBvbihjbWROb2RlQW5jaG9yKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm9kZSBlZGl0XCIsXG4gICAgZmxhZ3M6IFtcInRpdGxlXCIsIFwic3lub3BzaXNcIiwgXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcIm5vZGVJZFwiKSxcbiAgICBkZXNjcmliZTogXCJlZGl0IGEgbm9kZSdzIHRpdGxlL3N5bm9wc2lzXCIsXG4gICAgcnVuOiBvbihjbWROb2RlRWRpdCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vZGUgZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibm9kZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIG5vZGUgKC0tZm9yY2UgY2FzY2FkZXMpXCIsXG4gICAgcnVuOiBvbihjbWROb2RlRGVsZXRlKSxcbiAgfSxcbiAge1xuICAgIC8vIGBtZXNzYWdlYCBpcyBhbiBhZHZlcnRpc2VkIEFMSUFTIG9mIGByZWFkYCAob25lIG1lc3NhZ2UtZmV0Y2ggdmVyYiwgdHdvXG4gICAgLy8gc3BlbGxpbmdzKTogZGlzcGF0Y2hhYmxlLCBpbiBgdmVyYnNgLCBhbmQgZGVjbGFyZWQgb24gaXRzIG93biByb3cuXG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgYWxpYXNlczogW1wibWVzc2FnZVwiXSxcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibWVzc2FnZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcIm9uZSBmdWxsIG1lc3NhZ2Ugcm93XCIsXG4gICAgcnVuOiBvbihjbWRSZWFkKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiem9uZSBjcmVhdGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogd29yZHMoXCJuYW1lXCIpLFxuICAgIGRlc2NyaWJlOiBcImNyZWF0ZSBhIHN0YWdpbmcgem9uZVwiLFxuICAgIHJ1bjogb24oY21kWm9uZUNyZWF0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInpvbmUgbGlzdFwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImxpc3Qgem9uZXNcIixcbiAgICBydW46IG9uKGNtZFpvbmVMaXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiem9uZSBkZWxldGVcIixcbiAgICBmbGFnczogW1wieWVzXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiem9uZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIHpvbmUgKC0teWVzIHdoZW4gcG9wdWxhdGVkKVwiLFxuICAgIHJ1bjogb24oY21kWm9uZURlbGV0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb21vdGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwicHJvcG9zYWxJZFwiKSxcbiAgICBkZXNjcmliZTogXCJtb3ZlIGEgem9uZWQgcHJvcG9zYWwgdG8gdGhlIG1haW4gcXVldWVcIixcbiAgICBydW46IG9uKGNtZFByb21vdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcm9wb3NhbCB6b25lXCIsXG4gICAgZmxhZ3M6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJwcm9wb3NhbElkXCIpLFxuICAgIGRlc2NyaWJlOiBcIm1vdmUgYSBwZW5kaW5nIHByb3Bvc2FsIGludG8gYSB6b25lICgtLXRvKSBvciBiYWNrIHRvIG1haW4gKC0tY2xlYXIpXCIsXG4gICAgY2hlY2s6IHRvWG9yQ2xlYXIsXG4gICAgcnVuOiBvbihjbWRQcm9wb3NhbFpvbmUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcm9wb3NhbCBkZWxldGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwicHJvcG9zYWxJZFwiKSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBwcm9wb3NhbFwiLFxuICAgIHJ1bjogb24oY21kUHJvcG9zYWxEZWxldGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2NcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiZG9jSWRcIiksXG4gICAgZGVzY3JpYmU6IFwidGhlIGRvYyBlbnZlbG9wZVwiLFxuICAgIHJ1bjogb24oKHApID0+IGNtZERvYyhmYWxzZSwgcCkpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2MgZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiZG9jSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgZG9jICgtLWZvcmNlIGNhc2NhZGVzKVwiLFxuICAgIHJ1bjogb24oKHApID0+IGNtZERvYyh0cnVlLCBwKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvYyBraW5kXCIsXG4gICAgZmxhZ3M6IFtcImF1dGhvclwiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgICAvLyDimqAgRkxBRy1ERVBFTkRFTlQgQVJJVFk6IGBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kLi4uPmAgc2V0cywgYGRvYyBraW5kXG4gICAgLy8gPGRvY0lkPiAtLWNsZWFyYCBjbGVhcnMgYW5kIHRha2VzIG5vIGtpbmQuIFRoZSBkZWNsYXJhdGlvbiBjYW5ub3Qgc2F5XG4gICAgLy8gXCJyZXF1aXJlZCB1bmxlc3MgLS1jbGVhclwiLCBzbyBpdCBjYW4gb25seSBtYXJrIDxraW5kPiBvcHRpb25hbDsgYGNoZWNrYFxuICAgIC8vIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiZG9jSWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJraW5kXCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcImFzc2VydCAoPGtpbmQ+KSBvciBjbGVhciAoLS1jbGVhcikgYSBkb2MncyBraW5kXCIsXG4gICAgY2hlY2s6IChpbnYpID0+IHtcbiAgICAgIGNvbnN0IGNsZWFyID0gaW52LmZsYWdzLmNsZWFyID09PSB0cnVlO1xuICAgICAgaWYgKGNsZWFyICYmIGludi5wb3MubGVuZ3RoID4gMSkgcmV0dXJuIFwiLS1jbGVhciB0YWtlcyBubyA8a2luZD5cIjtcbiAgICAgIGlmICghY2xlYXIgJiYgaW52LnBvcy5sZW5ndGggPCAyKSByZXR1cm4gXCJtaXNzaW5nIHJlcXVpcmVkIDxraW5kPiAob3IgcGFzcyAtLWNsZWFyKVwiO1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICAgIHJ1bjogb24oY21kRG9jS2luZCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1hcmtcIixcbiAgICBmbGFnczogW1wic3RhdHVzXCIsIFwibm90ZVwiLCBcImF1dGhvclwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcImRvY0lkXCIpLFxuICAgIGRlc2NyaWJlOiBcImFwcGVuZCBhIGRvYyBzdGF0dXMgbWFya1wiLFxuICAgIHJ1bjogb24oY21kTWFyayksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlYXJjaFwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiB3b3JkcyhcInF1ZXJ5XCIpLFxuICAgIGRlc2NyaWJlOiBcIkZUUyBvdmVyIG5vZGVzLCBkb2NzLCBtZXNzYWdlc1wiLFxuICAgIHJ1bjogb24oY21kU2VhcmNoKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibmVpZ2hib3JzXCIsXG4gICAgZmxhZ3M6IFtcImRlcHRoXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibm9kZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImxvY2FsIGhvb2QgKyBlZGdlIHJlYXNvbnNcIixcbiAgICBydW46IG9uKGNtZE5laWdoYm9ycyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJhdGlmeVwiLFxuICAgIGZsYWdzOiBbXCJydWxpbmdcIiwgXCJkb2MtZWRpdFwiLCBcImRvY1wiLCBcInNwYW5cIiwgXCJhbmNob3JcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJwcm9wb3NhbElkXCIpLFxuICAgIGRlc2NyaWJlOiBcInJ1bGUgb24gYSBwcm9wb3NhbFwiLFxuICAgIHJ1bjogb24oY21kUmF0aWZ5KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGVucyBzZXRcIixcbiAgICBmbGFnczogW1wibm9kZVwiLCBcImRvY1wiLCBcImRlcHRoXCIsIFwib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcInNldCB0aGUgbGVucyBvbiBhIG5vZGUgKC0tbm9kZSkgb3IgYSBkb2MgKC0tZG9jKVwiLFxuICAgIGNoZWNrOiAoaW52KSA9PiB7XG4gICAgICBpZiAoaW52LmZsYWdzLm5vZGUgIT09IHVuZGVmaW5lZCAmJiBpbnYuZmxhZ3MuZG9jICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIFwibGVucyBzZXQgdGFrZXMgLS1ub2RlIE9SIC0tZG9jLCBub3QgYm90aFwiO1xuICAgICAgfVxuICAgICAgaWYgKGludi5mbGFncy5kb2MgIT09IHVuZGVmaW5lZCAmJiBpbnYuZmxhZ3MuZGVwdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gXCItLWRlcHRoIGFwcGxpZXMgdG8gYSBub2RlIGxlbnMgb25seVwiO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICAgIHJ1bjogb24oY21kTGVuc1NldCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxlbnMgY2xlYXJcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJjbGVhciB0aGUgbGVuc1wiLFxuICAgIHJ1bjogb24oY21kTGVuc0NsZWFyKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibG9vay1oZXJlXCIsXG4gICAgZmxhZ3M6IFtcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcIm5vZGVJZFwiKSxcbiAgICBkZXNjcmliZTogXCJmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXCIsXG4gICAgcnVuOiBvbihjbWRMb29rSGVyZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGlvbnNcIixcbiAgICBmbGFnczogW1wic2V0XCIsIFwic3RkaW5cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcInRhcmdldElkXCIpLFxuICAgIGRlc2NyaWJlOiBcImFjdGlvbiBzbG90cyBvbiBhIG5vZGUvcGVuZGluZyBwcm9wb3NhbFwiLFxuICAgIGNoZWNrOiBleGFjdGx5T25lTW9kZSxcbiAgICBydW46IG9uKGNtZEFjdGlvbnMpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWdzXCIsXG4gICAgZmxhZ3M6IFtcInNldFwiLCBcInN0ZGluXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJ0YXJnZXRJZFwiKSxcbiAgICBkZXNjcmliZTogXCJmcmVlZm9ybSB0YWdzIG9uIGEgbm9kZS9wZW5kaW5nIHByb3Bvc2FsXCIsXG4gICAgY2hlY2s6IGV4YWN0bHlPbmVNb2RlLFxuICAgIHJ1bjogb24oY21kVGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiBjcmVhdGVcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBqb2JcIixcbiAgICBydW46IG9uKGNtZEpvYkNyZWF0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiB1cGRhdGVcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiam9iSWRcIiksXG4gICAgZGVzY3JpYmU6IFwidXBkYXRlIGEgam9iXCIsXG4gICAgcnVuOiBvbihjbWRKb2JVcGRhdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJqb2IgY2xhaW1cIixcbiAgICBmbGFnczogW1wib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJjbGFpbSBhIGpvYiAoYXRvbWljIGxlYXNlKVwiLFxuICAgIHJ1bjogb24oY21kSm9iQ2xhaW0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJqb2IgcmVsZWFzZVwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJyZWxlYXNlIGEgam9iXCIsXG4gICAgcnVuOiBvbihjbWRKb2JSZWxlYXNlKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiam9iIHN1YnRhc2tcIixcbiAgICBmbGFnczogW1wiYWRkXCIsIFwiY2hlY2tcIiwgXCJ1bmNoZWNrXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiam9iSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiYWRkLCBjaGVjayBvciB1bmNoZWNrIGEgam9iJ3Mgc3ViLXRhc2tcIixcbiAgICBjaGVjazogb25lU3VidGFza09wLFxuICAgIHJ1bjogb24oY21kSm9iU3VidGFzayksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiBsaXN0XCIsXG4gICAgZmxhZ3M6IFtcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwibGlzdCBqb2JzXCIsXG4gICAgcnVuOiBvbihjbWRKb2JMaXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiam9iIGRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBqb2JcIixcbiAgICBydW46IG9uKGNtZEpvYkRlbGV0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGl2aXR5XCIsXG4gICAgZmxhZ3M6IFtcIm1lc3NhZ2VcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJzdGF0ZVwiKSxcbiAgICBkZXNjcmliZTogXCJ0aGUgY2FzdGluZy1sb29wIGxpdmVuZXNzIHNpZ25hbCAocmVjZWl2ZWR8dGhpbmtpbmd8aWRsZSlcIixcbiAgICBydW46IG9uKGNtZEFjdGl2aXR5KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJyb2xlXCIsIFwia2luZFwiLCBcImdyb3VuZFwiLCBcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwiZm9yY2VcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJwb3N0IGEgbWVzc2FnZVwiLFxuICAgIHJ1bjogb24oY21kU2VuZCksXG4gIH0sXG5dO1xuXG4vLyDim5QgQlVJTERJTkcgVEhFIFRBQkxFIEhBUyBOTyBTSURFIEVGRkVDVFMuIGBkZWZpbmVDbGlgIG9ubHkgdmFsaWRhdGVzIGFuZFxuLy8gaW5kZXhlczsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgcnVucy4gU28gYSBncmltb2lyZVxuLy8gd2FyZCwgb3IgYSB0ZXN0LCBjYW4gaW1wb3J0IHRoaXMgbW9kdWxlIGFuZCByZWFkIGBjbGkucmVjb2duaXplZEZsYWdzYCxcbi8vIGBjbGkuZmxhZ3NGb3JgIGFuZCBgY2xpLmRlY2xhcmF0aW9uKClgIHdpdGhvdXQgcnVubmluZyB0aGUgQ0xJLlxuZXhwb3J0IGNvbnN0IGNsaSA9IGRlZmluZUNsaSh7XG4gIG5hbWU6IFwibWluZC1tYXBwZXJcIixcbiAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gIGNvbW1hbmRzOiBST1dTLFxuICAvLyBUaGUgdmVyYiBpcyB0aGUgZmlyc3QgYXJndW1lbnQ6IGBtaW5kLW1hcHBlciAtLXByb2plY3QgcCBzdGF0ZWAgaXMgcmVmdXNlZFxuICAvLyBhcyBhbiB1bmtub3duIHJvb3QgZmxhZy4gQSBiYXJlIGAtLWAgbWFrZXMgdGhlIG5leHQgdG9rZW4gdGhlIHZlcmIgKGFjYyBBNikuXG4gIGdyYW1tYXI6IFwidmVyYi1maXJzdFwiLFxuICAvLyBgZG9jYCB0YWtlcyBmbGFncyBCRUZPUkUgaXRzIHN1Yi12ZXJiIChgZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSBEMWApLCBzb1xuICAvLyBpdHMgc3ViLXZlcmIgaXMgdGhlIGZpcnN0IHBvc2l0aW9uYWwsIG5vdCB0aGUgYWRqYWNlbnQgdG9rZW4uIFRoZSBvdGhlclxuICAvLyBncm91cHMgKG5vZGUsIHpvbmUsIHByb3Bvc2FsLCBsZW5zLCBqb2IpIGtlZXAgdGhlIGRlZmF1bHQ6IGFkamFjZW50LlxuICBncm91cHM6IHsgZG9jOiB7IHN1YlZlcmJBdDogXCJmaXJzdC1wb3NpdGlvbmFsXCIgfSB9LFxuICB2ZXJzaW9uOiB2ZXJzaW9uSW5mbyxcbiAgaGVscDogKCkgPT4gSEVMUCxcbn0pO1xuXG4vLyBUaGUgZGVyaXZlZCB2aWV3cyB0aGUgdGVzdHMgcmVhZC4gVkVSQlMgaXMgdGhlIHJvc3RlciAodGhlIG1vZHVsZSdzIG93blxuLy8gYHZlcnNpb25gLCBgc2NoZW1hYCBhbmQgYGhlbHBgIHJvd3MgaW5jbHVkZWQpOyBWRVJCX1NQRUMgaXMgZWFjaCBwYXRoJ3Ncbi8vIGFjY2VwdGVkIGZsYWdzLCBrZXllZCBieSBwYXRoIChgXCJub2RlIGVkaXRcImApLlxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS52ZXJicztcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgY2xpLnJvd3MubWFwKChyKSA9PiBbci5uYW1lLCByLmFjY2VwdGVkXSksXG4pO1xuZXhwb3J0IGNvbnN0IFJFQ09HTklaRURfRkxBR1M6IHJlYWRvbmx5IHN0cmluZ1tdID0gY2xpLnJlY29nbml6ZWRGbGFncztcblxuLyoqXG4gKiBUSEUgT05FIFBMQUNFIEEgRkFJTFVSRSBCRUNPTUVTIEFOIEVYSVQgQ09ERS4gRXZlcnkgcmFpc2UgaW4gdGhpcyBmaWxlIFRIUk9XU1xuICogKHRoZSBraXQncyBgZGllYC9gQ2xpRXJyb3JgKSwgYXJyaXZlcyBoZXJlLCBpcyB3cml0dGVuIGFzIE9ORSBKU09OIGVudmVsb3BlXG4gKiBvbiBzdGRlcnIsIGFuZCBiZWNvbWVzIGEgdGF4b25vbXkgZXhpdCBjb2RlIOKAlCBub3RoaW5nIGV4aXRzIGZyb20gaW5zaWRlIGFcbiAqIHZlcmIsIHNvIGEgbGFyZ2Ugc3Rkb3V0IHBheWxvYWQgaXMgbmV2ZXIgdHJ1bmNhdGVkLlxuICpcbiAqIGBjbGkuZGlzcGF0Y2hgLCBub3QgdGhlIHJlZ2lzdHJ5J3MgYG1haW5gLCBiZWNhdXNlIG1pbmQtbWFwcGVyIHRyaWFnZXMgdHdvXG4gKiByYXcgdGhyb3dzIHRoZSByZWdpc3RyeSBjYW5ub3Qga25vdyBhYm91dC5cbiAqXG4gKiDim5QgVEhFIEtJVCdTIFJFUE9SVEVSIFNJVFMgSU5TSURFIFRISVMgQ0hBSU4sIE5PVCBJTiBQTEFDRSBPRiBJVC4gSXQgd3JpdGVzXG4gKiB0aGUgZW52ZWxvcGUgZm9yIGEgdHlwZWQgZmFpbHVyZSBhbmQgcmV0dXJucyBgbnVsbGAgZm9yIGV2ZXJ5dGhpbmcgZWxzZSwgc29cbiAqIHRoZSB0d28gdXNhZ2UgY2xhc3NlcyBiZWxvdyBhcmUgY2xhc3NpZmllZCBIRVJFOiBhIGJvZHkgdGhhdCBmYWlsZWQgdG8gcGFyc2VcbiAqIGFzIEpTT04gKHN0ZGluLy0tYm9keS1maWxlKSwgYW5kIGEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICogKC0tZmlsZS8tLWRvYy1lZGl0KS4gQSBiYXJlIGByZXBvcnRDbGlFcnJvcihlKSA/PyByZXRocm93YCB3b3VsZCB0dXJuIGJvdGhcbiAqIGludG8gc3RhY2stdHJhY2UgY3Jhc2hlcyAoY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nKS4gTm9kZSdzIG93biBwYXJzZVxuICogcmVqZWN0aW9ucyBubyBsb25nZXIgcmVhY2ggaGVyZTogdGhlIHJlZ2lzdHJ5IGNhdGNoZXMgdGhlbSBhbmQgYW5zd2VycyB3aXRoXG4gKiB0aGUgdmVyYidzIGFjY2VwdGVkIHNldCBhcyBgY2hvaWNlc2AuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBjbGkuZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIEEgYm9keSB0aGF0IGZhaWxlZCB0byBwYXJzZSAoc3RkaW4vLS1ib2R5LWZpbGUgSlNPTikg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoZSBpbnN0YW5jZW9mIFN5bnRheEVycm9yKSByZXR1cm4gcmVwb3J0VXNhZ2UoYGludmFsaWQgSlNPTjogJHttc2d9YCk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUvLS1kb2MtZWRpdCBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydFVzYWdlKG1zZyk7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGZhdWx0OiBvbmUgSU5URVJOQUwgZW52ZWxvcGUsIG5ldmVyXG4gICAgLy8gYSBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcImludGVybmFsXCIsIG1zZykpO1xuICAgIHJldHVybiBFWElUX0ZPUi5pbnRlcm5hbDtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBDTEkncyBvbmUgZW50cnksIGNhbGxlZCBieSB0aGUgbGF1bmNoZXIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWluZC1tYXBwZXIvc2NyaXB0cy9jbGkudHNgLlxuICpcbiAqIOKblCBUSEVSRSBJUyBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBUSEFUIElTIFRIRSBQT0lOVC5cbiAqIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuICogZW50cnksIHNvIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGUgYnVuZGxlOiBhIGJsb2NrIGhlcmUgd291bGQgbmV2ZXJcbiAqIHJ1biBhbmQgdGhlIENMSSB3b3VsZCBwcmludCBub3RoaW5nIGFuZCBleGl0IDAgZm9yIGV2ZXJ5IHZlcmIuIFRoaXMgZXhwb3J0IGlzXG4gKiB3aGF0IHJlcGxhY2VzIGl0LiBBbmQgdGhlIHNvdXJjZSBrZWVwcyBubyBzZWNvbmQgZW50cnkgZGVsaWJlcmF0ZWx5IOKAlCB0aGVcbiAqIGFyaXRobWV0aWMgYWJvdmUgaXMgdHJ1ZSBhdCB0aGUgYXJ0aWZhY3QncyBhZGRyZXNzIGFuZCBmYWxzZSBhdCB0aGlzIGZpbGUncyxcbiAqIHNvIG9mZmVyaW5nIGBidW4gc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzYCB3b3VsZCBiZSBvZmZlcmluZyBhIHdyb25nXG4gKiBwcm9jZXNzIChwbGF5Ym9vayBCMykuXG4gKlxuICog4puUIElUIFJFVFVSTlMgVEhFIENPREUgUkFUSEVSIFRIQU4gU0VUVElORyBJVC4gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4gKiByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZVxuICogKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAqIGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seVxuICogdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lXG4gKiBzaGFwZSwgc2FtZSByZWFzb24uIFRoZSBhc3NpZ25tZW50IGhhcHBlbnMgb25jZSwgaW4gdGhlIGxhdW5jaGVyLiBEbyBub3QgdGlkeVxuICogdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUzogdGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgUEFSU0VTXG4gKiBpdCwgd2hpY2ggaXMgdGhpcyBvbmUuIEEgbGF1bmNoZXIgcmVhZGluZyB0aGUgYXJndW1lbnQgdmVjdG9yIHdvdWxkIG1hdGNoIHRoZVxuICogYXJnLXBhcnNpbmcgcHJlZGljYXRlIGluIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBQZXItdmVyYiBoZWxwIChwb3J0ZWQgZnJvbSBTdG9yeSBTdHVkaW8ncyBraXQpOiBgaGVscCA8dmVyYj5gIGFuZFxuICogYDx2ZXJiPiAtLWhlbHBgIChvciBgLWhgLCB3aGVuIG5vIGZsYWcgY2xhaW1zIHRoYXQgc2hvcnQpIHByaW50IG9uZSByb3cnc1xuICogdXNhZ2UsIGl0cyBsaW5lLCBlYWNoIGFjY2VwdGVkIGZsYWcgd2l0aCBpdHMgYGZsYWdIZWxwYCBsaW5lLCBhbmQgaXRzXG4gKiBgZXhhbXBsZXNgLiBUaGUgYC0taGVscGAgY2hlY2sgcnVucyBiZWZvcmUgY29udHJhY3QgNSwgb24gdGhlIHRva2VucyBiZWZvcmVcbiAqIGFueSBgLS1gLiBBIHJvdydzIGByZXF1aXJlZEZsYWdzYCBkcm9wIHRoZWlyIGJyYWNrZXRzIGluIGl0cyB1c2FnZSBhbmQgYXJlXG4gKiByZWZ1c2VkIGFzIG1pc3NpbmcgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrLlxuICpcbiAqIFRoZSBtb2R1bGUgYWRkcyBgaGVscGAsIGB2ZXJzaW9uYCBhbmQgYHNjaGVtYWAgcm93cyB1bmxlc3MgdGhlIHNwZWxsIGRlZmluZXNcbiAqIGEgcm93IG9mIHRoYXQgbmFtZSAoZ3JhcGV2aW5lJ3MgYHZlcnNpb24gLS1odW1hbmApLiBUaGV5IGFyZSBvcmRpbmFyeSByb3dzOlxuICogZGVjbGFyZWQsIHN0cmljdCwgYW5kIGdpdmVuIGBnbG9iYWxGbGFnc2AgbGlrZSBldmVyeSBvdGhlciByb3cuXG4gKi9cblxuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uL2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi93aXJlL2Vycm9yc1wiO1xuXG4vLyDilIDilIAgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZsYWdUeXBlID0gXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiO1xuXG4vKiogT25lIGBwYXJzZUFyZ3NgIG9wdGlvbiwgcGx1cyB0aGUgYGRlZmF1bHRgIG5vZGUncyBwYXJzZXIgYWxzbyB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIE9wdGlvblNwZWMgPSB7XG4gIHR5cGU6IEZsYWdUeXBlO1xuICBtdWx0aXBsZT86IGJvb2xlYW47XG4gIHNob3J0Pzogc3RyaW5nO1xuICBkZWZhdWx0Pzogc3RyaW5nIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgcmVhZG9ubHkgYm9vbGVhbltdO1xufTtcblxuZXhwb3J0IHR5cGUgT3B0aW9uc1RhYmxlID0gUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgT3B0aW9uU3BlYz4+O1xuXG5leHBvcnQgdHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbmV4cG9ydCB0eXBlIEZsYWdWYWx1ZSA9IHN0cmluZyB8IGJvb2xlYW4gfCAoc3RyaW5nIHwgYm9vbGVhbilbXTtcblxuZXhwb3J0IHR5cGUgSW52b2NhdGlvbjxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIFRoZSByZXNvbHZlZCByb3cgbmFtZTogYFwib3BlblwiYCwgYFwibm9kZSBlZGl0XCJgLCBvciBgXCJcImAgZm9yIGEgdmVyYmxlc3Mgcm9vdC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHNwZWxsaW5nIHRoZSBjYWxsZXIgdXNlZCDigJQgYW4gYWxpYXMsIHdoZW4gb25lIHdhcyB1c2VkLiAqL1xuICB0b2tlbjogc3RyaW5nO1xuICAvKiogUG9zaXRpb25hbHMgYWZ0ZXIgdGhlIHBhdGguICovXG4gIHBvczogc3RyaW5nW107XG4gIC8qKiBGbGFncyBnaXZlbiwgcGx1cyB0aGUgZGVmYXVsdHMgb2YgdGhlIGZsYWdzIHRoaXMgcm93IGFjY2VwdHMuICovXG4gIGZsYWdzOiBQYXJ0aWFsPFJlY29yZDxGLCBGbGFnVmFsdWU+Pjtcbn07XG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogYFwib3BlblwiYDsgb25lIHNwYWNlIG1lYW5zIG9uZSBsZXZlbCBvZiBuZXN0aW5nOiBgXCJub2RlIGVkaXRcImAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVhY2ggYWxpYXMgaXMgZGlzcGF0Y2hhYmxlLCBsaXN0ZWQgaW4gYHZlcmJzYCwgYW5kIGdldHMgaXRzIG93biBkZWNsYXJlZFxuICAgKiAgcm93LiBBbiBhbGlhcyBvZiBhIG5lc3RlZCByb3cgbXVzdCBzaGFyZSBpdHMgZ3JvdXA6IGBcIm5vZGUgY2hhbmdlXCJgLiAqL1xuICBhbGlhc2VzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGlzIHJvdydzIG93biBmbGFnczsgYGdsb2JhbEZsYWdzYCBhcmUgYWRkZWQgdG8gdGhlbS4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IEZbXTtcbiAgLyoqIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gdGhpcywgYW5kIGl0IGlzIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLiAqL1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIEFkZGVkIGFzIHRoZSBgaGludGAgb2YgdGhpcyByb3cncyBmbGFnIHJlamVjdGlvbnMuICovXG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIC8qKiBgZmFsc2VgIGhhbmRzIG5vZGUncyBvd24gXCJVbmV4cGVjdGVkIGFyZ3VtZW50XCIgcmVmdXNhbCBhbnkgcG9zaXRpb25hbC4gKi9cbiAgYWxsb3dQb3NpdGlvbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGF0IGVhY2ggb2YgdGhpcyByb3cncyBmbGFncyBkb2VzLCBvbmUgbGluZSBlYWNoLCBmb3IgYGhlbHAgPHZlcmI+YC4gQVxuICAgKiBmbGFnIHdpdGggbm8gbGluZSBpcyBsaXN0ZWQgYnkgbmFtZSBvbmx5LlxuICAgKi9cbiAgZmxhZ0hlbHA/OiBSZWFkb25seTxQYXJ0aWFsPFJlY29yZDxGLCBzdHJpbmc+Pj47XG4gIC8qKiBXaG9sZSBjb21tYW5kIGxpbmVzIHRoYXQgc2hvdyB0aGUgcm93IGluIHVzZSwgZm9yIGBoZWxwIDx2ZXJiPmAuICovXG4gIGV4YW1wbGVzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBGbGFncyBvZiB0aGlzIHJvdyB0aGF0IG11c3QgYmUgZ2l2ZW46IHNob3duIHdpdGhvdXQgYnJhY2tldHMgaW4gaXRzXG4gICAqIHVzYWdlLCBhbmQgcmVmdXNlZCBhcyBtaXNzaW5nLCBsaWtlIGEgcmVxdWlyZWQgcG9zaXRpb25hbC5cbiAgICovXG4gIHJlcXVpcmVkRmxhZ3M/OiByZWFkb25seSBGW107XG4gIC8qKlxuICAgKiBGbGFnLWRlcGVuZGVudCBhcml0eSAoaW1hZ28gYGhhbmRvZmYgLS1jbGVhcmAsIG1pbmQtbWFwcGVyIGAtLXRvfC0tY2xlYXJgKVxuICAgKiBhbmQgYW55IG90aGVyIGNvbWJpbmF0aW9uIHJ1bGUuIFJ1bnMgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrOyBhIHJldHVybmVkXG4gICAqIHN0cmluZyBpcyByZWZ1c2VkIGFzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIHRoaXMgcm93LiDimqAgVGhlIGRlY2xhcmF0aW9uXG4gICAqIGNhbm5vdCBleHByZXNzIHN1Y2ggYSBydWxlOiBhIHBvc2l0aW9uYWwgdGhhdCBgLS1jbGVhcmAgbWFrZXMgdW5uZWNlc3NhcnlcbiAgICogY2FuIG9ubHkgYmUgZGVjbGFyZWQgYHJlcXVpcmVkOiBmYWxzZWAsIGFuZCB0aGlzIGhvb2sgZW5mb3JjZXMgdGhlIHJlc3QuXG4gICAqL1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb248Rj4pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgbnVtYmVyIGlzIHRoZSBleGl0IGNvZGU7IGFueXRoaW5nIGVsc2UgbWVhbnMgMC4gKi9cbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiB1bmtub3duO1xufTtcblxuLyoqIEEgdmVyYmxlc3MgQ0xJJ3Mgb25lIHJvdyAoZGlnZXN0aWZ5KS4gYHBhdGg6IFtdYCBpbiB0aGUgZGVjbGFyYXRpb24uICovXG5leHBvcnQgdHlwZSBSb290U3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IE9taXQ8Q29tbWFuZFNwZWM8Rj4sIFwibmFtZVwiIHwgXCJhbGlhc2VzXCI+O1xuXG4vKipcbiAqIFdoZXJlIGEgZ3JvdXAncyBzdWItdmVyYiBpcyBmb3VuZC5cbiAqIC0gYGFkamFjZW50YCAoZGVmYXVsdCk6IHRoZSB0b2tlbiByaWdodCBhZnRlciB0aGUgZ3JvdXAgKGBub2RlIGVkaXQgWGApLlxuICogLSBgZmlyc3QtcG9zaXRpb25hbGA6IHRoZSBmaXJzdCB0b2tlbiBhZnRlciB0aGUgZ3JvdXAgdGhhdCBpcyBuZWl0aGVyIGEgZmxhZ1xuICogICBub3IgYSBzdHJpbmcgZmxhZydzIHZhbHVlLCBzbyBmbGFncyBtYXkgY29tZSBmaXJzdDpcbiAqICAgYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWAgcmVzb2x2ZXMgdG8gYGRvYyBkZWxldGVgIChtaW5kLW1hcHBlcikuXG4gKiAgIFRoZSBzY2FuIHN0b3BzIGF0IGEgYmFyZSBgLS1gLCB3aGljaCBpcyB0aGUgZXNjYXBlIGhhdGNoIGZvciBhIHBvc2l0aW9uYWxcbiAqICAgbGl0ZXJhbGx5IG5hbWVkIGxpa2UgYSBzdWItdmVyYjogYGRvYyAtLSBkZWxldGVgIHJlYWRzIHRoZSBkb2MgXCJkZWxldGVcIi5cbiAqL1xuZXhwb3J0IHR5cGUgR3JvdXBTcGVjID0geyBzdWJWZXJiQXQ/OiBcImFkamFjZW50XCIgfCBcImZpcnN0LXBvc2l0aW9uYWxcIiB9O1xuXG5leHBvcnQgdHlwZSBDbGlTcGVjPE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+ID0ge1xuICAvKiogYFwiYm91bnR5XCJgLCB1c2VkIGluIG1lc3NhZ2VzIGFuZCB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogVGhlIHJlbmRlcmVkIGhlbHAncyBmaXJzdCBsaW5lOiBgJHtuYW1lfSDigJQgJHtzdW1tYXJ5fWAuICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIC8qKiBUaGUgbGl0ZXJhbCBgQ0xJX09QVElPTlNgIG9iamVjdC4gKi9cbiAgb3B0aW9uczogTztcbiAgY29tbWFuZHM/OiByZWFkb25seSBDb21tYW5kU3BlYzxrZXlvZiBPICYgc3RyaW5nPltdO1xuICAvKipcbiAgICogQSB2ZXJibGVzcyBDTEkncyByb3cuIFJlc2VydmVkIHRva2VucyBhcyBgYXJndlswXWAgc3RpbGwgc2VsZWN0IHRoZWlyIHJvd3NcbiAgICogKGBoZWxwYCwgYHZlcnNpb25gLCBgc2NoZW1hYCwgYW55IGBjb21tYW5kc2AsIGFuZCB0aGUgaW50ZXJjZXB0b3JzKTsgZXZlcnlcbiAgICogb3RoZXIgYXJndiwgdGhlIGVtcHR5IG9uZSBpbmNsdWRlZCwgYmVsb25ncyB0byB0aGUgcm9vdC4gQSBwb3NpdGlvbmFsIHRoYXRcbiAgICogaGFwcGVucyB0byBzcGVsbCBhIHJlc2VydmVkIHRva2VuIGdvZXMgYWZ0ZXIgYSBiYXJlIGAtLWAuXG4gICAqL1xuICByb290PzogUm9vdFNwZWM8a2V5b2YgTyAmIHN0cmluZz47XG4gIC8qKiBBY2NlcHRlZCBieSBldmVyeSByb3csIGJ5IGNvbnRyYWN0IChncmFwZXZpbmUncyBgLS1hc2AvYC0tZnJvbWApLiAqL1xuICBnbG9iYWxGbGFncz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICBncmFtbWFyPzogXCJ2ZXJiLWZpcnN0XCIgfCBcImZsYWdzLWFueXdoZXJlXCI7XG4gIC8qKiBQZXItZ3JvdXAgc3ViLXZlcmIgcGxhY2VtZW50LCBrZXllZCBieSB0aGUgZ3JvdXAgdG9rZW4gKGBcImRvY1wiYCkuICovXG4gIGdyb3Vwcz86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEdyb3VwU3BlYz4+O1xuICAvKiogVGhlIHJvb3Qgcm93J3MgcG9zaXRpb25hbCBuYW1lIGluIGBzY2hlbWFgIChgXCJjb21tYW5kXCJgOyBnbGFtb3VyOiBgXCJ2ZXJiXCJgKS4gKi9cbiAgdmVyYlBvc2l0aW9uYWw/OiBzdHJpbmc7XG4gIC8qKiBGbGFncyBsZWZ0IG9mZiBldmVyeSB1c2FnZSBsaW5lIChnbGFtb3VyJ3MgcGVyLXZlcmIgYHNlc3Npb25gKS4gKi9cbiAgdXNhZ2VIaWRlcz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICAvKiogVGhlIGB2ZXJzaW9uYCByb3cncyBwYXlsb2FkLCBge25hbWUsIHZlcnNpb259YC4gKi9cbiAgdmVyc2lvbjogKCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqIFJlcGxhY2VzIHRoZSByZW5kZXJlZCBoZWxwIChncmFwZXZpbmUpLiAqL1xuICBoZWxwPzogKCkgPT4gc3RyaW5nO1xuICAvKiogQXBwZW5kZWQgYmVsb3cgdGhlIHJlbmRlcmVkIHJvd3MuICovXG4gIGhlbHBGb290ZXI/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBEZWNsYXJlZEFyZyA9IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBGbGFnVHlwZTsgc3RhdHVzOiBcInZhbGlkXCIgfTtcbmV4cG9ydCB0eXBlIERlY2xhcmVkQ29tbWFuZCA9IHtcbiAgcGF0aDogc3RyaW5nW107XG4gIGFyZ3M6IERlY2xhcmVkQXJnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xufTtcbmV4cG9ydCB0eXBlIERlY2xhcmF0aW9uID0ge1xuICBmb3JtYXRWZXJzaW9uOiBcIjBcIjtcbiAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCI7XG4gIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBzdHJpbmdbXSB9O1xuICBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW107XG59O1xuXG4vKiogQSByb3cgYXMgdGhlIG1vZHVsZSBob2xkcyBpdCwgZm9yIHRlc3RzIGFuZCB3YXJkcy4gKi9cbmV4cG9ydCB0eXBlIFJvd1ZpZXcgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcm93J3Mgb3duIGZsYWdzLCBhcyBkZWNsYXJlZC4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogT3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCwgaW4gb3B0aW9ucy10YWJsZSBvcmRlci4gKi9cbiAgYWNjZXB0ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIGB0cnVlYCBmb3IgYSBgaGVscGAvYHZlcnNpb25gL2BzY2hlbWFgIHJvdyB0aGUgbW9kdWxlIGFkZGVkLiAqL1xuICBhdXRvOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQ2xpID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFbnZlbG9wZSBvbiBmYWlsdXJlLCByZXR1cm5zIHRoZSBleGl0IGNvZGUuIEZvciB0aGUgc3BlbGwncyBgcnVuKClgLiAqL1xuICBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhyb3dzIGBDbGlFcnJvcmAsIGZvciBhIHNwZWxsIHdob3NlIG1haW4gZG9lcyBpdHMgb3duIHRyaWFnZS4gKi9cbiAgZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIGRlY2xhcmF0aW9uKCk6IERlY2xhcmF0aW9uO1xuICByZW5kZXJIZWxwKCk6IHN0cmluZztcbiAgLyoqIE9uZSB2ZXJiJ3MgaGVscCAoYGhlbHAgPHZlcmI+YCk7IGEgdXNhZ2UgZXJyb3IgZm9yIGEgdmVyYiB0aGF0IGlzIG5vdCB0aGVyZS4gKi9cbiAgcmVuZGVyVmVyYkhlbHAocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogQSByb3cncyB1c2FnZSBsaW5lIChgXCJjbG9zZSA8aWQ+IFstLWZvcmNlXVwiYCk7IGBcIlwiYCBmb3IgYW4gdW5rbm93biBwYXRoLiAqL1xuICB1c2FnZU9mKHBhdGg6IHN0cmluZyk6IHN0cmluZztcbiAgLyoqIEV2ZXJ5IGZpcnN0IHRva2VuIHRoYXQgZGlzcGF0Y2hlczogdmVyYnMsIGFsaWFzZXMgYW5kIGdyb3VwIHRva2Vucy4gKi9cbiAgdmVyYnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogRXZlcnkgZnVsbCBwYXRoIHRoYXQgZGlzcGF0Y2hlcywgYWxpYXNlcyBpbmNsdWRlZCAoYFwibm9kZSBlZGl0XCJgKS4gKi9cbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogQSByb3cncyBhY2NlcHRlZCBzZXQgYXMgYC0teGAgc3BlbGxpbmdzLCBzb3J0ZWQuIGBcIlwiYCBpcyB0aGUgcm9vdC4gKi9cbiAgZmxhZ3NGb3IocGF0aDogc3RyaW5nKTogc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmbGFnIGluIHRoZSBvcHRpb25zIHRhYmxlLCBhcyBgLS14YCwgaW4gdGFibGUgb3JkZXIuICovXG4gIHJlY29nbml6ZWRGbGFnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJvd3M6IHJlYWRvbmx5IFJvd1ZpZXdbXTtcbn07XG5cbi8vIOKUgOKUgCBpbnRlcm5hbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbnR5cGUgUm93ID0gUm93VmlldyAmIHtcbiAgcmVqZWN0SGludD86IHN0cmluZztcbiAgYWxsb3dQb3NpdGlvbmFsczogYm9vbGVhbjtcbiAgZmxhZ0hlbHA6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4+O1xuICBleGFtcGxlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlcXVpcmVkOiBSZWFkb25seVNldDxzdHJpbmc+O1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5yZXF1aXJlZEZsYWdzID8/IFtdKSB7XG4gICAgICBpZiAoIWMuZmxhZ3MuaW5jbHVkZXMoZikpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiByZXF1aXJlcyBmbGFnIFwiJHtmfVwiLCBub3Qgb25lIG9mIGl0cyBvd25gLFxuICAgICAgICApO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGZsYWdIZWxwOiB7IC4uLihjLmZsYWdIZWxwID8/IHt9KSB9IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gICAgICBleGFtcGxlczogWy4uLihjLmV4YW1wbGVzID8/IFtdKV0sXG4gICAgICByZXF1aXJlZDogbmV3IFNldChjLnJlcXVpcmVkRmxhZ3MgPz8gW10pLFxuICAgICAgY2hlY2s6IGMuY2hlY2sgYXMgUm93W1wiY2hlY2tcIl0sXG4gICAgICBydW46IGMucnVuIGFzIFJvd1tcInJ1blwiXSxcbiAgICB9O1xuICB9O1xuXG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gKHNwZWMuY29tbWFuZHMgPz8gW10pLm1hcCgoYykgPT4gdG9Sb3coYyBhcyBDb21tYW5kU3BlYywgZmFsc2UpKTtcblxuICAvLyBUaGUgYXV0byByb3dzLiBBZGRlZCBsYXN0LCBpbiB0aGlzIG9yZGVyLCB1bmxlc3MgdGhlIHNwZWxsIGhhcyBpdHMgb3duLlxuICBjb25zdCBjbGkgPSB7fSBhcyBDbGk7XG4gIGNvbnN0IGF1dG9Sb3dzOiBDb21tYW5kU3BlY1tdID0gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTiAoYWxpYXM6IC0tdmVyc2lvbiwgLVYpXCIsXG4gICAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgICAgcHJpbnRKc29uKGF3YWl0IHNwZWMudmVyc2lvbigpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSAoYWNjIGRlY2xhcmF0aW9uIHYwKVwiLFxuICAgICAgcnVuOiAoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGNsaS5kZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcImhlbHBcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICAgIGRlc2NyaWJlOlxuICAgICAgICBcInNob3cgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaCk7IGBoZWxwIDx2ZXJiPmAgc2hvd3Mgb25lIHZlcmI6IGl0cyB1c2FnZSwgZWFjaCBmbGFnLCBhbmQgZXhhbXBsZXNcIixcbiAgICAgIHJ1bjogKGludikgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0ID0gaW52LnBvcy5sZW5ndGggPiAwID8gY2xpLnJlbmRlclZlcmJIZWxwKGludi5wb3Muam9pbihcIiBcIikpIDogY2xpLnJlbmRlckhlbHAoKTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUodGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGEgb2YgYXV0b1Jvd3MpIHtcbiAgICBpZiAoIXJvd3Muc29tZSgocikgPT4gci5uYW1lID09PSBhLm5hbWUpKSByb3dzLnB1c2godG9Sb3coYSwgdHJ1ZSkpO1xuICB9XG5cbiAgY29uc3Qgcm9vdFJvdzogUm93IHwgdW5kZWZpbmVkID1cbiAgICBzcGVjLnJvb3QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvUm93KHsgLi4uKHNwZWMucm9vdCBhcyBSb290U3BlYyksIG5hbWU6IFwiXCIgfSwgZmFsc2UpO1xuXG4gIC8vIEluZGV4IGV2ZXJ5IHNwZWxsaW5nLCBhbmQgY2hlY2sgdGhlIHRhYmxlIGlzIHdlbGwgZm9ybWVkLlxuICBjb25zdCBieVRva2VuID0gbmV3IE1hcDxzdHJpbmcsIFJvdz4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgY29uc3QgcGFydHMgPSB0LnNwbGl0KFwiIFwiKTtcbiAgICAgIGlmICh0LnRyaW0oKSAhPT0gdCB8fCBwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+IHAgPT09IFwiXCIgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGJhZCBjb21tYW5kIG5hbWUgXCIke3R9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0ICE9PSByLm5hbWUgJiYgcGFydHMubGVuZ3RoICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBuZXN0IGxpa2UgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMiAmJiB0ICE9PSByLm5hbWUgJiYgcGFydHNbMF0gIT09IHIubmFtZS5zcGxpdChcIiBcIilbMF0pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3Qgc2hhcmUgdGhlIGdyb3VwIG9mIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChieVRva2VuLmhhcyh0KSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IFwiJHt0fVwiIGlzIGRlZmluZWQgdHdpY2VgKTtcbiAgICAgIGJ5VG9rZW4uc2V0KHQsIHIpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzdWJzT2YgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBieVRva2VuLmtleXMoKSkge1xuICAgIGNvbnN0IFtncm91cCwgc3ViXSA9IHQuc3BsaXQoXCIgXCIpO1xuICAgIGlmIChncm91cCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdWJzT2Yuc2V0KGdyb3VwLCBbLi4uKHN1YnNPZi5nZXQoZ3JvdXApID8/IFtdKSwgc3ViXSk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgZyBvZiBPYmplY3Qua2V5cyhzcGVjLmdyb3VwcyA/PyB7fSkpIHtcbiAgICBpZiAoIXN1YnNPZi5oYXMoZykpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBncm91cCBcIiR7Z31cIiBoYXMgbm8gc3ViLXZlcmJzYCk7XG4gIH1cblxuICBjb25zdCBwYXRocyA9IFsuLi5ieVRva2VuLmtleXMoKV07XG4gIGNvbnN0IHZlcmJzID0gWy4uLm5ldyBTZXQocGF0aHMubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbiAgY29uc3Qgcm93Rm9yID0gKHBhdGg6IHN0cmluZyk6IFJvdyB8IHVuZGVmaW5lZCA9PiAocGF0aCA9PT0gXCJcIiA/IHJvb3RSb3cgOiBieVRva2VuLmdldChwYXRoKSk7XG4gIGNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gICAgWy4uLihyb3dGb3IocGF0aCk/LmFjY2VwdGVkID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuICBjb25zdCBsYWJlbCA9IChyOiBSb3cpOiBzdHJpbmcgPT4gci5uYW1lIHx8IGNsaU5hbWU7XG5cbiAgLyoqXG4gICAqIEEgdmVyYmxlc3Mgcm9vdCdzIHJlamVjdGlvbiBgY2hvaWNlc2A6IGl0cyBvd24gZmxhZ3MgUExVUyB0aGUgaW50ZXJjZXB0b3JzLFxuICAgKiBiZWNhdXNlIHRoZSBkZWNsYXJhdGlvbiBwdWJsaXNoZXMgYm90aCBhdCBgcGF0aDogW11gIGFuZCB0aGUgcm9vdCBhbnN3ZXJzXG4gICAqIGJvdGggKHRoZSBpbnRlcmNlcHRvcnMgYXMgYGFyZ3ZbMF1gKS4gTGVhdmluZyB0aGUgaW50ZXJjZXB0b3JzIG91dCBtYWRlXG4gICAqIG9uZSBwcm9jZXNzIHNheSB0d28gdGhpbmdzIGFib3V0IGl0cyByb290IOKAlCBhY2MncyBjZW5zdXMgcmVhZCBgLS1oZWxwYCxcbiAgICogYC1oYCwgYC0tdmVyc2lvbmAgYW5kIGAtVmAgYXMgZGVjbGFyZWQtbm90LWFjY2VwdGVkLiBMb25nIHNwZWxsaW5ncyBmaXJzdFxuICAgKiAoc29ydGVkKSwgdGhlbiB0aGUgc2hvcnRzOiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHRcbiAgICogc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy5cbiAgICovXG4gIGNvbnN0IHJvb3RDaG9pY2VzOiBzdHJpbmdbXSA9ICgoKSA9PiB7XG4gICAgY29uc3QgYWxsID0gWy4uLmZsYWdzRm9yKFwiXCIpLCAuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXTtcbiAgICBjb25zdCBsb25nID0gYWxsLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKFwiLS1cIikpLnNvcnQoKTtcbiAgICByZXR1cm4gWy4uLmxvbmcsIC4uLmFsbC5maWx0ZXIoKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCItLVwiKSldO1xuICB9KSgpO1xuXG4gIC8vIOKUgOKUgCBoZWxwIOKUgOKUgFxuXG4gIGNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICAgIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xuICB9O1xuICBjb25zdCByZW5kZXJGbGFnID0gKGs6IHN0cmluZywgcmVxdWlyZWQgPSBmYWxzZSk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgZmxhZyA9IHNwZWMub3B0aW9uc1trXT8udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgLS0ke2t9YCA6IGAtLSR7a30gLi5gO1xuICAgIHJldHVybiByZXF1aXJlZCA/IGZsYWcgOiBgWyR7ZmxhZ31dYDtcbiAgfTtcbiAgY29uc3QgdXNhZ2VMaW5lID0gKHI6IFJvdyk6IHN0cmluZyA9PlxuICAgIFtcbiAgICAgIGxhYmVsKHIpLFxuICAgICAgLi4uci5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgICAuLi5yLmZsYWdzLmZpbHRlcigoaykgPT4gIWhpZGVzLmhhcyhrKSkubWFwKChrKSA9PiByZW5kZXJGbGFnKGssIHIucmVxdWlyZWQuaGFzKGspKSksXG4gICAgXS5qb2luKFwiIFwiKTtcbiAgY29uc3QgZXhwZWN0cyA9IChyOiBSb3cpOiBzdHJpbmcgPT4gYGV4cGVjdHM6ICR7dXNhZ2VMaW5lKHIpfWA7XG5cbiAgY29uc3QgcmVuZGVySGVscCA9ICgpOiBzdHJpbmcgPT4ge1xuICAgIGlmIChzcGVjLmhlbHAgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHNwZWMuaGVscCgpO1xuICAgIGNvbnN0IGxpc3RlZCA9IFsuLi4ocm9vdFJvdyA/IFtyb290Um93XSA6IFtdKSwgLi4ucm93c107XG4gICAgY29uc3QgbGluZXMgPSBsaXN0ZWQubWFwKChyKSA9PiBbdXNhZ2VMaW5lKHIpLCByLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihNYXRoLm1heCguLi5saW5lcy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICAgIGNvbnN0IGJvZHkgPSBsaW5lc1xuICAgICAgLm1hcCgoW3UsIGRdKSA9PlxuICAgICAgICB1Lmxlbmd0aCA8PSB3aWR0aCA/IGAgICR7dS5wYWRFbmQod2lkdGgpfSAgJHtkfWAgOiBgICAke3V9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICAgKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZCA9IHNwZWMuc3VtbWFyeSA/IGAke2NsaU5hbWV9IOKAlCAke3NwZWMuc3VtbWFyeX1gIDogY2xpTmFtZTtcbiAgICBjb25zdCB0b2tlbnMgPSBgICAke0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTmA7XG4gICAgcmV0dXJuIGAke2hlYWR9XFxuXFxuJHtib2R5fVxcbiR7dG9rZW5zfSR7c3BlYy5oZWxwRm9vdGVyID8gYFxcblxcbiR7c3BlYy5oZWxwRm9vdGVyfWAgOiBcIlwifWA7XG4gIH07XG5cbiAgLyoqXG4gICAqIE9uZSB2ZXJiJ3MgaGVscDogaXRzIHVzYWdlIGxpbmUsIHdoYXQgaXQgZG9lcywgZWFjaCBmbGFnIGl0IHRha2VzIHdpdGhcbiAgICogd2hhdCBpdCBkb2VzLCBhbmQgaXRzIGV4YW1wbGVzLiBBbiB1bmtub3duIHZlcmIgaXMgYSB1c2FnZSBlcnJvciB0aGF0XG4gICAqIGxpc3RzIHRoZSB2ZXJicyB0aGVyZSBhcmUuXG4gICAqL1xuICBjb25zdCByZW5kZXJWZXJiSGVscCA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHIgPSBieVRva2VuLmdldChwYXRoKTtcbiAgICBpZiAociA9PT0gdW5kZWZpbmVkKVxuICAgICAgcmV0dXJuIGRpZShgaGVscDogbm8gdmVyYiBcIiR7cGF0aH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBwYXRocyxcbiAgICAgICAgaGludDogXCJoZWxwIHdpdGggbm8gdmVyYiBsaXN0cyB0aGVtIGFsbFwiLFxuICAgICAgfSk7XG4gICAgY29uc3QgZmxhZ3MgPSByLmFjY2VwdGVkLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzcGVjLm9wdGlvbnNba10/LnR5cGUgPT09IFwiYm9vbGVhblwiID8gYC0tJHtrfWAgOiBgLS0ke2t9IDwke2t9PmA7XG4gICAgICByZXR1cm4gW3ZhbHVlLCByLmZsYWdIZWxwW2tdID8/IFwiXCJdIGFzIGNvbnN0O1xuICAgIH0pO1xuICAgIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoMCwgLi4uZmxhZ3MubWFwKChbZl0pID0+IGYubGVuZ3RoKSksIDI4KTtcbiAgICBjb25zdCBmbGFnTGluZXMgPSBmbGFncy5tYXAoKFtmLCBkXSkgPT5cbiAgICAgIGQgPT09IFwiXCJcbiAgICAgICAgPyBgICAke2Z9YFxuICAgICAgICA6IGYubGVuZ3RoIDw9IHdpZHRoXG4gICAgICAgICAgPyBgICAke2YucGFkRW5kKHdpZHRoKX0gICR7ZH1gXG4gICAgICAgICAgOiBgICAke2Z9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICk7XG4gICAgcmV0dXJuIFtcbiAgICAgIGB1c2FnZTogJHt1c2FnZUxpbmUocil9YCxcbiAgICAgIFwiXCIsXG4gICAgICByLmRlc2NyaWJlLFxuICAgICAgLi4uKGZsYWdMaW5lcy5sZW5ndGggPiAwID8gW1wiXCIsIFwiZmxhZ3M6XCIsIC4uLmZsYWdMaW5lc10gOiBbXSksXG4gICAgICAuLi4oci5leGFtcGxlcy5sZW5ndGggPiAwID8gW1wiXCIsIFwiZXhhbXBsZXM6XCIsIC4uLnIuZXhhbXBsZXMubWFwKChlKSA9PiBgICAke2V9YCldIDogW10pLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgfTtcblxuICAvLyDilIDilIAgdGhlIGRlY2xhcmF0aW9uIOKUgOKUgFxuXG4gIGNvbnN0IGRlY2xhcmF0aW9uID0gKCk6IERlY2xhcmF0aW9uID0+IHtcbiAgICBjb25zdCBhcmcgPSAoazogc3RyaW5nKTogRGVjbGFyZWRBcmcgPT4gKHtcbiAgICAgIG5hbWU6IGAtLSR7a31gLFxuICAgICAgdHlwZTogKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS50eXBlLFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXRoOiBbXSxcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgIC4uLklOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICAuLi4ocm9vdFJvdyA/IHJvb3RSb3cuYWNjZXB0ZWQubWFwKGFyZykgOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHBvc2l0aW9uYWxzOiByb290Um93XG4gICAgICAgICAgPyByb290Um93LnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSlcbiAgICAgICAgICA6IFt7IG5hbWU6IHNwZWMudmVyYlBvc2l0aW9uYWwgPz8gXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiB0LnNwbGl0KFwiIFwiKSxcbiAgICAgICAgICBhcmdzOiByLmFjY2VwdGVkLm1hcChhcmcpLFxuICAgICAgICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzY2hlbWFSb3cgPSBieVRva2VuLmdldChcInNjaGVtYVwiKSBhcyBSb3c7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW3NjaGVtYVJvdy5uYW1lXSB9LFxuICAgICAgY29tbWFuZHMsXG4gICAgfTtcbiAgfTtcblxuICAvLyDilIDilIAgZGlzcGF0Y2gg4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSBpbmRleCBvZiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmcgZmxhZydzXG4gICAqIHZhbHVlLCB3YWxraW5nIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsOiBgLS1rIHZgIGNvbnN1bWVzIGB2YCB3aGVuIGBrYCBpcyBhXG4gICAqIHN0cmluZyBmbGFnLCBgLS1rPXZgIGNvbnN1bWVzIG5vdGhpbmcsIGAtcyB2YCBsaWtld2lzZSBieSB0aGUgc2hvcnQncyB0eXBlLlxuICAgKiBBdCBhIGJhcmUgYC0tYDogYC0xYCB3aGVuIGBzdG9wQXRUZXJtaW5hdG9yYCwgZWxzZSB0aGUgaW5kZXggYWZ0ZXIgaXQuXG4gICAqL1xuICBjb25zdCBzY2FuUG9zaXRpb25hbCA9IChhcmdzOiBzdHJpbmdbXSwgc3RvcEF0VGVybWluYXRvcjogYm9vbGVhbik6IG51bWJlciA9PiB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBhID0gYXJnc1tpXSBhcyBzdHJpbmc7XG4gICAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gc3RvcEF0VGVybWluYXRvciB8fCBpICsgMSA+PSBhcmdzLmxlbmd0aCA/IC0xIDogaSArIDE7XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNwZWMub3B0aW9uc1thLnNsaWNlKDIpXT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpICYmIGEubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBrZXkgPSBhLmxlbmd0aCA9PT0gMiA/IHNob3J0VG9LZXkuZ2V0KGEuc2xpY2UoMSkpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgc3BlYy5vcHRpb25zW2tleV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIGNvbnN0IHdpdGhvdXQgPSAoYXJnczogc3RyaW5nW10sIGk6IG51bWJlcik6IHN0cmluZ1tdID0+IFtcbiAgICAuLi5hcmdzLnNsaWNlKDAsIGkpLFxuICAgIC4uLmFyZ3Muc2xpY2UoaSArIDEpLFxuICBdO1xuXG4gIGNvbnN0IG5vQ29tbWFuZCA9ICgpOiBuZXZlciA9PlxuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VgLFxuICAgIH0pO1xuXG4gIC8qKiBBIHZlcmIgY2FuZGlkYXRlIGFuZCB0aGUgYXJncyBhZnRlciBpdCwgdG8gYSByb3cgYW5kIHRoYXQgcm93J3MgYXJncy4gKi9cbiAgY29uc3QgcmVzb2x2ZSA9IChjYW5kOiBzdHJpbmcsIHJlc3Q6IHN0cmluZ1tdKTogeyByb3c6IFJvdzsgdG9rZW46IHN0cmluZzsgYXJnczogc3RyaW5nW10gfSA9PiB7XG4gICAgY29uc3Qgc3VicyA9IHN1YnNPZi5nZXQoY2FuZCk7XG4gICAgaWYgKHN1YnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXQgPSBzcGVjLmdyb3Vwcz8uW2NhbmRdPy5zdWJWZXJiQXQgPz8gXCJhZGphY2VudFwiO1xuICAgICAgbGV0IGkgPSAtMTtcbiAgICAgIGlmIChhdCA9PT0gXCJhZGphY2VudFwiKSB7XG4gICAgICAgIGNvbnN0IG5leHQgPSByZXN0WzBdO1xuICAgICAgICBpID0gbmV4dCAhPT0gdW5kZWZpbmVkICYmICFuZXh0LnN0YXJ0c1dpdGgoXCItXCIpID8gMCA6IC0xO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaSA9IHNjYW5Qb3NpdGlvbmFsKHJlc3QsIHRydWUpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3ViID0gaSA+PSAwID8gKHJlc3RbaV0gYXMgc3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZ1bGwgPSBzdWIgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGJ5VG9rZW4uZ2V0KGAke2NhbmR9ICR7c3VifWApO1xuICAgICAgaWYgKGZ1bGwgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4geyByb3c6IGZ1bGwsIHRva2VuOiBgJHtjYW5kfSAke3N1Yn1gLCBhcmdzOiB3aXRob3V0KHJlc3QsIGkpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBvd24gPSBieVRva2VuLmdldChjYW5kKTtcbiAgICAgIGlmIChvd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcm93OiBvd24sIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gICAgICBjb25zdCBleHRyYSA9IHsgY2hvaWNlczogWy4uLnN1YnNdLCBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgIH07XG4gICAgICBpZiAoc3ViID09PSB1bmRlZmluZWQpIGRpZShgJHtjYW5kfTogZXhwZWN0ZWQgYSBzdWItY29tbWFuZGAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgICAgZGllKGB1bmtub3duICR7Y2FuZH0gc3ViLWNvbW1hbmQ6IFwiJHtzdWJ9XCJgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICB9XG4gICAgY29uc3Qgcm93ID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoYHVua25vd24gY29tbWFuZCBcIiR7Y2FuZH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJvdywgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgfTtcblxuICAvKipcbiAgICogQ29udHJhY3QgNSdzIGAtLWAgbWFkZSB0aGUgY2FsbGVyJ3MgZmxhZyBURVhUOyBzYXkgc28gKGMxLFxuICAgKiBgZG9jcy9pdGVtcy90ZXJtaW5hdG9yLWVhdHMtc2Vzc2lvbi1rZXkubWRgKS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHNcbiAgICogYSBmbGFnIHRoaXMgcm93IGFjY2VwdHMg4oCUIGAtLWtgLCBgLS1rPXZgLCBvciB0aGUgc2hvcnQgYC1zYCBvZiBhbiBhY2NlcHRlZFxuICAgKiBga2AsIGdsb2JhbHMgaW5jbHVkZWQg4oCUIGlzIG5hbWVkIGluIE9ORSBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIsIHdpdGhcbiAgICogdGhlIG1vdmUgdGhhdCByZWNvdmVycyBpdC4gU3Rkb3V0IGFuZCB0aGUgZXhpdCBjb2RlIGRvIG5vdCBjaGFuZ2UsIGFuZCB0aGVcbiAgICogcm93IHN0aWxsIHJ1bnM6IHRleHQgY29udGFpbmluZyBhIGZsYWcgbmFtZSBpcyBsZWdpdGltYXRlLCB3aGljaCBpcyB3aGF0XG4gICAqIGAtLWAgaXMgZm9yLiBBIHRva2VuIHRoZSByb3cgZG9lcyBub3QgYWNjZXB0IGlzIGp1c3QgdGV4dCwgYW5kIHNheXMgbm90aGluZy5cbiAgICpcbiAgICog4pqgIENhbGxlZCBvbmx5IG9uY2UgZXZlcnkgcmVmdXNhbCBoYXMgcGFzc2VkLCBzbyBhIHJlZnVzZWQgaW52b2NhdGlvbidzXG4gICAqIHN0ZGVyciBpcyBzdGlsbCBleGFjdGx5IG9uZSBlbnZlbG9wZS4gVGhlIGAjIGAgcHJlZml4IGlzIHRoZSBob3VzZSdzXG4gICAqIHN1Y2Nlc3MtcGF0aCBzdGRlcnIgZm9ybSAoYCMgd2FybmluZzpgIGluIG1pbmQtbWFwcGVyLCBgIyBwaW5uZWQgYm9hcmRgLFxuICAgKiBgIyDihpIgY2hhbm5lbGApOiBhbiBlbnZlbG9wZSByZWFkZXIgbG9va3MgZm9yIGEgYHtgIGxpbmUgYW5kIHNraXBzIGl0LlxuICAgKi9cbiAgY29uc3Qgd2FybkRlbW90ZWQgPSAoXG4gICAgcm93OiBSb3csXG4gICAgYWNjZXB0ZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gICAgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBlbmQgPSB0b2tlbnM/LmZpbmRJbmRleCgodCkgPT4gdC5raW5kID09PSBcIm9wdGlvbi10ZXJtaW5hdG9yXCIpID8/IC0xO1xuICAgIGlmICh0b2tlbnMgPT09IHVuZGVmaW5lZCB8fCBlbmQgPCAwKSByZXR1cm47XG4gICAgY29uc3QgZGVtb3RlZDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rZW5zLnNsaWNlKGVuZCArIDEpKSB7XG4gICAgICBpZiAodC5raW5kICE9PSBcInBvc2l0aW9uYWxcIikgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gdC52YWx1ZTtcbiAgICAgIGxldCBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICh2LnN0YXJ0c1dpdGgoXCItLVwiKSkga2V5ID0gdi5zbGljZSgyKS5zcGxpdChcIj1cIilbMF07XG4gICAgICBlbHNlIGlmICh2Lmxlbmd0aCA9PT0gMiAmJiB2LnN0YXJ0c1dpdGgoXCItXCIpKSBrZXkgPSBzaG9ydFRvS2V5LmdldCh2LnNsaWNlKDEpKTtcbiAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBrZXkgIT09IFwiXCIgJiYgYWNjZXB0ZWQuaGFzKGtleSkpIGRlbW90ZWQucHVzaCh2KTtcbiAgICB9XG4gICAgaWYgKGRlbW90ZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgd2hpY2ggPSBkZW1vdGVkLmpvaW4oXCIsIFwiKTtcbiAgICBjb25zdCBvbmUgPSBkZW1vdGVkLmxlbmd0aCA9PT0gMTtcbiAgICBjb25zdCBpdCA9IG9uZSA/IFwiaXRcIiA6IFwidGhlbVwiO1xuICAgIGNvbnN0IHdhcyA9IG9uZSA/IFwid2FzXCIgOiBcIndlcmVcIjtcbiAgICBjb25zdCBhc0ZsYWcgPSBvbmUgPyBcImFzIGEgZmxhZ1wiIDogXCJhcyBmbGFnc1wiO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCMgd2FybmluZzogJHtjbGlOYW1lfSR7cm93Lm5hbWUgPT09IFwiXCIgPyBcIlwiIDogYCAke3Jvdy5uYW1lfWB9OiAke3doaWNofSBhZnRlciBcXGAtLVxcYCAke3dhc30gcmVhZCBhcyB0ZXh0LCBub3QgJHthc0ZsYWd9OyB0byB1c2UgJHtpdH0gJHthc0ZsYWd9LCBtb3ZlICR7aXR9IGJlZm9yZSBcXGAtLVxcYFxcbmAsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBydW5Sb3cgPSBhc3luYyAocm93OiBSb3csIHRva2VuOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChyb3cubmFtZSA9PT0gXCJcIiA/IG51bGwgOiByb3cubmFtZSk7XG4gICAgY29uc3QgbmFtZSA9IGxhYmVsKHJvdyk7XG4gICAgLy8gYDx2ZXJiPiAtLWhlbHBgIChvciBgLWhgLCB1bmxlc3MgdGhlIHNwZWxsIGdhdmUgYC1oYCBhIGZsYWcgb2YgaXRzIG93bikgaXNcbiAgICAvLyBgaGVscCA8dmVyYj5gOiBhc2tlZCBiZWZvcmUgYW55dGhpbmcgZWxzZSBpcyBjaGVja2VkLlxuICAgIGNvbnN0IGVuZCA9IGFyZ3MuaW5kZXhPZihcIi0tXCIpO1xuICAgIGNvbnN0IGJlZm9yZSA9IGVuZCA9PT0gLTEgPyBhcmdzIDogYXJncy5zbGljZSgwLCBlbmQpO1xuICAgIGlmIChcbiAgICAgIHJvdy5uYW1lICE9PSBcIlwiICYmXG4gICAgICAhcm93LmF1dG8gJiZcbiAgICAgIChiZWZvcmUuaW5jbHVkZXMoXCItLWhlbHBcIikgfHwgKGJlZm9yZS5pbmNsdWRlcyhcIi1oXCIpICYmICFzaG9ydFRvS2V5LmhhcyhcImhcIikpKVxuICAgICkge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVyVmVyYkhlbHAocm93Lm5hbWUpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGNvbnN0IGFjY2VwdGVkID0gbmV3IFNldChyb3cuYWNjZXB0ZWQpO1xuICAgIGNvbnN0IGNob2ljZXMgPSByb3cubmFtZSA9PT0gXCJcIiA/IHJvb3RDaG9pY2VzIDogZmxhZ3NGb3Iocm93Lm5hbWUpO1xuICAgIGNvbnN0IGZsYWdIaW50ID0gKCk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxuICAgICAgW3Jvdy5yZWplY3RIaW50LCBjaG9pY2VzLmxlbmd0aCA9PT0gMCA/IGAke25hbWV9IHRha2VzIG5vIGZsYWdzYCA6IHVuZGVmaW5lZF1cbiAgICAgICAgLmZpbHRlcigocyk6IHMgaXMgc3RyaW5nID0+IHMgIT09IHVuZGVmaW5lZClcbiAgICAgICAgLmpvaW4oXCI7IFwiKSB8fCB1bmRlZmluZWQ7XG5cbiAgICBsZXQgdmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBsZXQgcG9zaXRpb25hbHM6IHN0cmluZ1tdO1xuICAgIGxldCB0b2tlbnM6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz5bXCJ0b2tlbnNcIl07XG4gICAgdHJ5IHtcbiAgICAgICh7IHZhbHVlcywgcG9zaXRpb25hbHMsIHRva2VucyB9ID0gcGFyc2VBcmdzKHtcbiAgICAgICAgYXJncyxcbiAgICAgICAgb3B0aW9uczogcGFyc2VPcHRpb25zLFxuICAgICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICAgIGFsbG93UG9zaXRpb25hbHM6IHJvdy5hbGxvd1Bvc2l0aW9uYWxzLFxuICAgICAgICB0b2tlbnM6IHRydWUsXG4gICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGVyckNvZGUoZSkgPT09IFwiRVJSX1BBUlNFX0FSR1NfVU5LTk9XTl9PUFRJT05cIikge1xuICAgICAgICBkaWUoYCR7bmFtZX06ICR7ZXJyTWVzc2FnZShlKX1gLCBcInVzYWdlXCIsIHsgY2hvaWNlcywgaGludDogZmxhZ0hpbnQoKSB9KTtcbiAgICAgIH1cbiAgICAgIC8vIEEgbWlzc2luZyB2YWx1ZSBpcyBub3QgYSBjaG9pY2UgZnJvbSBhIHNldCwgc28gbm8gYGNob2ljZXNgIGhlcmUuXG4gICAgICBkaWUoYCR7bmFtZX06ICR7ZXJyTWVzc2FnZShlKX1gLCBcInVzYWdlXCIsIHsgaGludDogcm93LnJlamVjdEhpbnQgPz8gZXhwZWN0cyhyb3cpIH0pO1xuICAgIH1cblxuICAgIC8vIFN0YWdlIDI6IGtub3duIHRvIHRoZSBzcGVsbCwgbm90IHRha2VuIGJ5IHRoaXMgcm93IOKAlCBNSVNQTEFDRUQsIG5vdFxuICAgIC8vIHVua25vd24uIE9ubHkgZmxhZ3MgdGhlIGNhbGxlciBHQVZFIGFyZSBoZXJlOiBkZWZhdWx0cyBhcmUgbm90IGFwcGxpZWQgeWV0LlxuICAgIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXModmFsdWVzKS5maW5kKChrKSA9PiAhYWNjZXB0ZWQuaGFzKGspKTtcbiAgICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgZGllKFxuICAgICAgICBgLS0ke3N0cmF5fSBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgJHtuYW1lfVxcYCAoaXQgaXMgYSByZWNvZ25pemVkICR7Y2xpTmFtZX0gZmxhZywganVzdCBub3QgdGhpcyAke3Jvdy5uYW1lID09PSBcIlwiID8gXCJjb21tYW5kXCIgOiBcInZlcmJcIn0ncylgLFxuICAgICAgICBcInVzYWdlXCIsXG4gICAgICAgIHsgY2hvaWNlcywgaGludDogZmxhZ0hpbnQoKSB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBBcml0eSwgZnJvbSB0aGUgZGVjbGFyZWQgc2hhcGUsIG5hbWluZyB0aGUgbWlzc2luZyBvciB0aGUgZXh0cmEgdG9rZW4uXG4gICAgY29uc3QgcmVxdWlyZWQgPSByb3cucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gICAgY29uc3QgdmFyaWFkaWMgPSByb3cucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gICAgaWYgKHBvc2l0aW9uYWxzLmxlbmd0aCA8IHJlcXVpcmVkKSB7XG4gICAgICBjb25zdCBtaXNzaW5nID0gcm93LnBvc2l0aW9uYWxzW3Bvc2l0aW9uYWxzLmxlbmd0aF07XG4gICAgICBkaWUoYCR7bmFtZX06IG1pc3NpbmcgcmVxdWlyZWQgPCR7bWlzc2luZz8ubmFtZSA/PyBcImFyZ3VtZW50XCJ9PmAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBleHBlY3RzKHJvdyksXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKCF2YXJpYWRpYyAmJiBwb3NpdGlvbmFscy5sZW5ndGggPiByb3cucG9zaXRpb25hbHMubGVuZ3RoKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAke25hbWV9OiB1bmV4cGVjdGVkIGFyZ3VtZW50ICR7SlNPTi5zdHJpbmdpZnkocG9zaXRpb25hbHNbcm93LnBvc2l0aW9uYWxzLmxlbmd0aF0pfWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBoaW50OiByb3cucG9zaXRpb25hbHMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gYXJndW1lbnRzYCA6IGV4cGVjdHMocm93KSB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBEZWZhdWx0cyBsYXN0LCBhbmQgb25seSB0aGlzIHJvdydzLlxuICAgIGNvbnN0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBGbGFnVmFsdWU+ID0geyAuLi4odmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4pIH07XG4gICAgZm9yIChjb25zdCBrIG9mIHJvdy5hY2NlcHRlZCkge1xuICAgICAgY29uc3QgZCA9IChzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYykuZGVmYXVsdDtcbiAgICAgIGlmIChmbGFnc1trXSA9PT0gdW5kZWZpbmVkICYmIGQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBmbGFnc1trXSA9IChBcnJheS5pc0FycmF5KGQpID8gWy4uLmRdIDogZCkgYXMgRmxhZ1ZhbHVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoY29uc3QgayBvZiByb3cucmVxdWlyZWQpXG4gICAgICBpZiAoZmxhZ3Nba10gPT09IHVuZGVmaW5lZClcbiAgICAgICAgZGllKGAke25hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIC0tJHtrfWAsIFwidXNhZ2VcIiwgeyBoaW50OiBleHBlY3RzKHJvdykgfSk7XG5cbiAgICBjb25zdCBpbnY6IEludm9jYXRpb24gPSB7IHBhdGg6IHJvdy5uYW1lLCB0b2tlbiwgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3MgfTtcbiAgICBjb25zdCByZWZ1c2VkID0gcm93LmNoZWNrPy4oaW52KTtcbiAgICBpZiAocmVmdXNlZCAhPT0gdW5kZWZpbmVkKSBkaWUoYCR7bmFtZX06ICR7cmVmdXNlZH1gLCBcInVzYWdlXCIsIHsgaGludDogZXhwZWN0cyhyb3cpIH0pO1xuXG4gICAgd2FybkRlbW90ZWQocm93LCBhY2NlcHRlZCwgdG9rZW5zKTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCByb3cucnVuKGludik7XG4gICAgcmV0dXJuIHR5cGVvZiBvdXQgPT09IFwibnVtYmVyXCIgPyBvdXQgOiAwO1xuICB9O1xuXG4gIGNvbnN0IGRpc3BhdGNoID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChhcmd2WzBdID8/IG51bGwpO1xuICAgIGNvbnN0IGZpcnN0ID0gYXJndlswXTtcblxuICAgIC8vIDEuIEludGVyY2VwdG9ycyBwYXNzIHRoZSByZXN0IG9mIHRoZSBhcmd2IG9uIHRvIHRoZWlyIHJvdy5cbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IElOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGZpcnN0KTtcbiAgICBpZiAoaW50ZXJjZXB0b3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHJ1blJvdyhieVRva2VuLmdldChpbnRlcmNlcHRvci5ydW5zKSBhcyBSb3csIGludGVyY2VwdG9yLnJ1bnMsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgIH1cblxuICAgIC8vIDIuIEEgdmVyYmxlc3Mgcm9vdCBvd25zIGV2ZXJ5IGFyZ3YgdGhhdCBkb2VzIG5vdCBzdGFydCB3aXRoIGEgcmVzZXJ2ZWQgdG9rZW4uXG4gICAgaWYgKHJvb3RSb3cgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpcnN0ICE9PSB1bmRlZmluZWQgJiYgKGJ5VG9rZW4uaGFzKGZpcnN0KSB8fCBzdWJzT2YuaGFzKGZpcnN0KSkpIHtcbiAgICAgICAgY29uc3QgciA9IHJlc29sdmUoZmlyc3QsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgICAgICByZXR1cm4gcnVuUm93KHIucm93LCByLnRva2VuLCByLmFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJ1blJvdyhyb290Um93LCBcIlwiLCBhcmd2KTtcbiAgICB9XG5cbiAgICAvLyAzLiBCYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciAoYWNjIEMyL0QyKS5cbiAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vQ29tbWFuZCgpO1xuXG4gICAgLy8gNC4gRmluZCB0aGUgdmVyYi5cbiAgICBsZXQgY2FuZDogc3RyaW5nO1xuICAgIGxldCByZXN0OiBzdHJpbmdbXTtcbiAgICBpZiAoZ3JhbW1hciA9PT0gXCJ2ZXJiLWZpcnN0XCIpIHtcbiAgICAgIGlmIChmaXJzdCA9PT0gXCItLVwiKSB7XG4gICAgICAgIGlmIChhcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgICAgY2FuZCA9IGFyZ3ZbMV07XG4gICAgICAgIHJlc3QgPSBbXCItLVwiLCAuLi5hcmd2LnNsaWNlKDIpXTtcbiAgICAgIH0gZWxzZSBpZiAoZmlyc3Quc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICAgICAgcmV0dXJuIGRpZShgdW5rbm93biBmbGFnIGF0IHRoZSByb290OiAke2ZpcnN0fWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGNob2ljZXM6IFsuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXSxcbiAgICAgICAgICBoaW50OiBgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7dmVyYnMuam9pbihcIiBcIil9YCxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjYW5kID0gZmlyc3Q7XG4gICAgICAgIHJlc3QgPSBhcmd2LnNsaWNlKDEpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpID0gc2NhblBvc2l0aW9uYWwoYXJndiwgZmFsc2UpO1xuICAgICAgaWYgKGkgPCAwKSB7XG4gICAgICAgIC8vIE5vIHZlcmIgYW55d2hlcmU6IGFuIHVua25vd24gZmxhZyBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQsXG4gICAgICAgIC8vIGFuZCBhIGNsZWFuIHBhcnNlIGlzIGEgYmFyZSBpbnZvY2F0aW9uLiBOZWl0aGVyIHJhbiBhIGNvbW1hbmQsIHNvXG4gICAgICAgIC8vIHRoZSBlbnZlbG9wZSdzIGBtZXRhLmNvbW1hbmRgIGlzIG51bGwsIG5vdCB0aGUgZmlyc3QgZmxhZydzXG4gICAgICAgIC8vIHNwZWxsaW5nIChgZ2xhbW91ciAtLWJvZ3VzYCBuYW1lcyBubyB2ZXJiKS5cbiAgICAgICAgc2V0Q3VycmVudENvbW1hbmQobnVsbCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogcGFyc2VPcHRpb25zLCBzdHJpY3Q6IHRydWUsIGFsbG93UG9zaXRpb25hbHM6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBkaWUoZXJyTWVzc2FnZShlKSwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgICBoaW50OiBgbm8gY29tbWFuZCBnaXZlbiDigJQgY29tbWFuZHM6ICR7dmVyYnMuam9pbihcIiBcIil9IChydW46ICR7Y2xpTmFtZX0gaGVscClgLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgIH1cbiAgICAgIGNhbmQgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICAgIC8vIEEgdmVyYiBmb3VuZCByaWdodCBhZnRlciBhIGAtLWAgbGVhdmVzIHRoYXQgYC0tYCBpbiBwbGFjZSwgc28gdGhlXG4gICAgICAvLyByZXN0IG9mIHRoZSBhcmd2IHN0YXlzIHBvc2l0aW9uYWwuXG4gICAgICByZXN0ID0gd2l0aG91dChhcmd2LCBpKTtcbiAgICB9XG4gICAgc2V0Q3VycmVudENvbW1hbmQoY2FuZCk7XG4gICAgY29uc3QgciA9IHJlc29sdmUoY2FuZCwgcmVzdCk7XG4gICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgfTtcblxuICBjb25zdCBtYWluID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICAgIC8vIFRoZSBob3VzZSBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS4gQSBzcGVsbCB0aGF0XG4gICAgICAvLyB0cmlhZ2VzIGl0cyBvd24gKGdsYW1vdXIncyBFTk9FTlQg4oaSIHVzYWdlKSBjYWxscyBgZGlzcGF0Y2hgIGluc3RlYWQuXG4gICAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgZXJyTWVzc2FnZShlKSkpID8/IDE7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHZpZXcgPSAocjogUm93KTogUm93VmlldyA9PiAoe1xuICAgIG5hbWU6IHIubmFtZSxcbiAgICBhbGlhc2VzOiByLmFsaWFzZXMsXG4gICAgZmxhZ3M6IHIuZmxhZ3MsXG4gICAgYWNjZXB0ZWQ6IHIuYWNjZXB0ZWQsXG4gICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMsXG4gICAgZGVzY3JpYmU6IHIuZGVzY3JpYmUsXG4gICAgYXV0bzogci5hdXRvLFxuICB9KTtcblxuICBPYmplY3QuYXNzaWduKGNsaSwge1xuICAgIG5hbWU6IGNsaU5hbWUsXG4gICAgbWFpbixcbiAgICBkaXNwYXRjaCxcbiAgICBkZWNsYXJhdGlvbixcbiAgICByZW5kZXJIZWxwLFxuICAgIHJlbmRlclZlcmJIZWxwLFxuICAgIHVzYWdlT2Y6IChwYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHIgPSByb3dGb3IocGF0aCk7XG4gICAgICByZXR1cm4gciA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IHVzYWdlTGluZShyKTtcbiAgICB9LFxuICAgIHZlcmJzLFxuICAgIHBhdGhzLFxuICAgIGZsYWdzRm9yLFxuICAgIHJlY29nbml6ZWRGbGFnczogb3B0aW9uS2V5cy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICByb3dzOiByb3dzLm1hcCh2aWV3KSxcbiAgfSBzYXRpc2ZpZXMgQ2xpKTtcbiAgcmV0dXJuIGNsaTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRlcGVuZGVuY3ktZnJlZSBhbmQgZGVsaWJlcmF0ZWx5IGR1bGw6IGl0IGlzIGJ1bmRsZWQgSU5UTyBlYWNoXG4gKiBzcGVsbCdzIGVtaXR0ZWQgQ0xJIChDb250cmFjdCA0J3MgYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLCBzbyBhbnl0aGluZyBpdFxuICogcmVhY2hlZCBmb3Igd291bGQgYmVjb21lIGEgZGVwZW5kZW5jeSBvZiB0d28gc2hpcHBlZCBhcnRpZmFjdHMgYXQgb25jZS5cbiAqXG4gKiBUaGUgd2lyZSBjb250cmFjdCBpdCBlbmNvZGVzOiBleGFjdGx5IG9uZSBKU09OIGRvY3VtZW50LCBvbmUgdHJhaWxpbmdcbiAqIG5ld2xpbmUsIG5vdGhpbmcgZWxzZSBvbiBzdGRvdXQuIEEgY2FsbGVyIHJlYWRpbmcgb3VyIHN0ZG91dCB3aXRoIGFcbiAqIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBkZXBlbmRzIG9uIHRoYXQgbmV3bGluZTsgYSBjYWxsZXIgcmVhZGluZyB0byBFT0ZcbiAqIGRlcGVuZHMgb24gdGhlcmUgYmVpbmcgbm8gc2Vjb25kIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pOiB2b2lkIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLy8gU2Vzc2lvbiBlbmRpbmdzIGFyZSBvdXRjb21lcywgbm90IGZhaWx1cmVzLCBhbmQgc3RheSBvdXRzaWRlIHRoZSB0YXhvbm9teTpcbi8vIGFuIGFnZW50IHJlYWRzIHRoZW0gYXMgXCJ0aGUgc2Vzc2lvbiBlbmRlZCB0aGlzIHdheVwiLCBub3QgXCJ0aGUgdmVyYiBicm9rZVwiLlxuLy8gVGhlIG51bWJlcnMgYXJlIHRoZSBzaGVsbCdzIChgdGltZW91dGAncyAxMjQsIFNJR0lOVCdzIDEyOCArIDIpLCBzbyBhXG4vLyB3cmFwcGVyIHRoYXQgYWxyZWFkeSBrbm93cyB0aGVtIG5lZWRzIG5vIHRhYmxlLlxuLyoqIEEgZGFlbW9uIHRoYXQgY2xvc2VkIGl0c2VsZiBhZnRlciBpdHMgaWRsZSB0aW1lb3V0LiBBbiBvdXRjb21lLCBub3QgYSBmYWlsdXJlLiAqL1xuZXhwb3J0IGNvbnN0IEVYSVRfSURMRV9USU1FT1VUID0gMTI0O1xuLyoqIFRoZSB1c2VyIGNhbmNlbGxlZC4gQW4gb3V0Y29tZSwgbm90IGEgZmFpbHVyZS4gKi9cbmV4cG9ydCBjb25zdCBFWElUX0NBTkNFTExFRCA9IDEzMDtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYHRva2VuYCBpcyBhIHN0YWJsZSBtYWNoaW5lLXJlYWRhYmxlIG5hbWVcbiAqIGZvciB0aGUgY2F1c2UgKGBub19zZXNzaW9uYCksIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IHRva2VuPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAvLyBPbmx5IHByZXNlbnQgd2hlbiBnaXZlbiwgc28gYW4gZW52ZWxvcGUgd2l0aG91dCBvbmUga2VlcHMgaXRzIGJ5dGVzLlxuICAgICAgLi4uKGV4dHJhPy50b2tlbiA/IHsgdG9rZW46IGV4dHJhLnRva2VuIH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaXRlbXMvdGFpbC1yZWFkZXItY29udmVyZ2VuY2Uvd3JpdGUtdXAubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLlxuICAgKlxuICAgKiAg4puUIEFORCBXSEVOIFRIRSBORVcgTE9HIFdBUyBBTFJFQURZIFBBU1QgVEhFIEJPT0tNQVJLLCBUSEUgQ0xJRU5UXG4gICAqICBSRUNPTk5FQ1RTIEZST00gSVRTIFNUQVJULiBBIGRhZW1vbiB0aGF0IGJlbGlldmVzIHRoZSBjdXJzb3Igc2VuZHMgb25seVxuICAgKiAgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hbiBtZXNzYWdlIGF0XG4gICAqICBuZXcgaWQgMiB1bmRlciBhbiBvbGQgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHNpbGVudGx5LiBFdmVyeXRoaW5nIGluXG4gICAqICBhIG5ldyBlcG9jaCBpcyBuZXcgdG8gdGhpcyByZWFkZXIsIHNvIHRoZSBhdHRlbXB0IGlzIGRyb3BwZWQgYW5kIHJlLW1hZGVcbiAgICogIGZyb20gMCBhdCBvbmNlIChubyBiYWNrb2ZmKS4gQSBmcmFtZSBBVCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIG1lYW5zXG4gICAqICB0aGUgZGFlbW9uIGlzIGFscmVhZHkgcmVwbGF5aW5nIHdob2xlLCBhbmQgaXMga2VwdC4gKFJldmlld2VyJ3MgRDIgZ2FwLFxuICAgKiAgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYuKSAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBlcG9jaCB0aGUgc3RhcnRpbmcgYHNpbmNlYCBjYW1lIGZyb20sIHdoZW4gdGhlIGNhbGxlciBoYXMgb25lIChhXG4gICAqICBib29rbWFyayBwcmludGVkIGFzIGBOQDxlcG9jaD5gLCBgLi90YWlsSGFuZG9mZi50c2ApLiBUaGUgZmlyc3QgZnJhbWUgb2YgYVxuICAgKiAgZGlmZmVyZW50IGVwb2NoIGlzIHRoZW4gYW4gZXBvY2ggY2hhbmdlIGxpa2UgYW55IG90aGVyIOKAlCB3aGljaCBpcyB3aGF0XG4gICAqICBzdG9wcyBhIGJvb2ttYXJrIG91dGxpdmluZyBpdHMgbG9nIGFjcm9zcyBwcm9jZXNzZXMuICovXG4gIHNpbmNlRXBvY2g/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSZWFkIGEgZnJhbWUgd2hvc2UgaWQgaXMgQVQgT1IgQkVMT1cgdGhlIGN1cnNvciB0aGlzIGNvbm5lY3Rpb24gYXNrZWRcbiAgICogZnJvbSBhcyBcInRoZSBsb2cgcmVzdGFydGVkXCIsIHJlc2V0IHRoZSBjdXJzb3IgdG8gMCwgYW5kIGNhbGxcbiAgICogYG9uRXBvY2hDaGFuZ2VgICh3aXRoIHRoZSBmcmFtZSdzIGVwb2NoLCBvciBgXCJ1bmtub3duXCJgKS4gRGVmYXVsdCBmYWxzZS5cbiAgICpcbiAgICog4puUIFdIWSBJVCBJUyBIT05FU1Q6IHRoZSBraXQncyBldmVudCBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93blxuICAgKiBieSByZXBsYXlpbmcgV0hPTEUgKGAuL2V2ZW50TG9nLnRzYCwgcG9pbnQgMyksIGFuZCBvdGhlcndpc2Ugc2VuZHMgb25seVxuICAgKiBpZHMgYWJvdmUgdGhlIGN1cnNvci4gU28gYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGV4aXN0cyBvbmx5XG4gICAqIHdoZW4gdGhlIGRhZW1vbiBqdWRnZWQgdGhlIGN1cnNvciBmb3JlaWduIOKAlCBhIHJlc3RhcnRlZCBkYWVtb24sIHdob3NlIGlkc1xuICAgKiBiZWdhbiBhZ2FpbiBhdCAxLiBUaGUgZXBvY2ggY2F0Y2hlcyB0aGF0IFdJVEhJTiBvbmUgcHJvY2VzczsgdGhpcyBjYXRjaGVzXG4gICAqIGl0IEFDUk9TUyBwcm9jZXNzZXMsIHdoZXJlIGEgcmUtYXJtZWQgdGFpbCBjYXJyaWVzIGEgYm9va21hcmsgZnJvbSBhIGxvZ1xuICAgKiB0aGF0IG5vIGxvbmdlciBleGlzdHMgYW5kLCB3aXRob3V0IGl0LCBrZXB0IHRoYXQgYm9va21hcmsgZm9yZXZlcjogZXZlcnlcbiAgICogcmUtYXJtIHJlcGxheWVkIHRoZSB3aG9sZSBuZXcgbG9nLCBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcFxuICAgKiAoZm91bmQgYnkgdGhlIHZlcmlmaWVyIG9uIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCBhZnRlciBgdGFpbC5sb3N0YCDihpJcbiAgICogYG9wZW4gLS1yZXN0b3JlYCkuXG4gICAqXG4gICAqIOKaoCBPTkxZIEZPUiBBIERBRU1PTiBPTiBUSEUgS0lUJ1MgRVZFTlQgTE9HLiBHcmFwZXZpbmUncyBpZHMgYXJlIHJlY292ZXJlZFxuICAgKiBhY3Jvc3MgYSByZXN0YXJ0IGFuZCBpdHMgYC0tbGFzdGAgcXVlcnkgb3ZlcnJpZGVzIGBzaW5jZWAsIHNvIGl0IGxlYXZlc1xuICAgKiB0aGlzIG9mZi4gQW5kIHRoZSBibGluZCBzcG90IGlzIHN0YXRlZDogYSBib29rbWFyayB0aGF0IGhhcHBlbnMgdG8gYmUgYXRcbiAgICogb3IgYmVsb3cgdGhlIFJFU1RBUlRFRCBsb2cncyBvd24gbGVuZ3RoIGxvb2tzIHZhbGlkIHRvIHRoZSBkYWVtb24sIHdoaWNoXG4gICAqIHRoZW4gc2VuZHMgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQuIFRoZSBjb21lLWJhY2sgcGF0aCB0aGVyZWZvcmUgZHJvcHNcbiAgICogdGhlIGJvb2ttYXJrIGFsdG9nZXRoZXIgKGAuL3RhaWxIYW5kb2ZmLnRzYCwgRDIpLCBzbyB0aGlzIGlzIHRoZSBuZXQsIG5vdFxuICAgKiB0aGUgcnVsZS5cbiAgICovXG4gIHJlc3RhcnRPblJlcGxheT86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gYGFjY2VwdGVkYCBpcyBgYWNjZXB0YCdzXG4gICAqICB2ZXJkaWN0IG9uIHRoaXMgZnJhbWUsIHdoaWNoIGlzIHdoYXQgbGV0cyBgdGFpbCAtLW9uY2VgIGVuZCBvbiB0aGUgZmlyc3RcbiAgICogIGZyYW1lIGl0IGFjdHVhbGx5IERFTElWRVJTIChgLi90YWlsSGFuZG9mZi50c2ApLlxuICAgKlxuICAgKiAg4puUIEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OIGJlZm9yZSB0aGUgY2xpZW50IHJldHVybnMuIEl0XG4gICAqICB1c2VkIHRvIHJldHVybiBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIHdpdGggdGhlIFNTRSBzdHJlYW0gc3RpbGwgb3BlbixcbiAgICogIHdoaWNoIGtlcHQgdGhlIHByb2Nlc3MgYWxpdmUg4oCUIHVuc2VlbiBmb3IgYGNsb3NlZGAsIGJlY2F1c2UgdGhlIHNlcnZlclxuICAgKiAgZW5kcyB0aGF0IHN0cmVhbSBpdHNlbGYsIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFza1xuICAgKiAgd291bGQgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQuIChBZGp1c3RtZW50IDEgb2YgdGhlXG4gICAqICBNb25pdG9yLWV4cGlyeSBzcGlrZTsgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lLCBhY2NlcHRlZDogYm9vbGVhbikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBhcyB0aGUgdGFpbCBlbmRzLCB3aXRoIHRoZSBmaW5hbCBjdXJzb3IgKHRoZSBib29rbWFyayBhIHJlLWFybVxuICAgKiBwYXNzZXMgYXMgYC0tc2luY2VgKSBhbmQgd2h5IGl0IGVuZGVkLiBBIFJFUE9SVCBTSU5LIGxpa2UgYG9uRGlzY29ubmVjdGAsXG4gICAqIG5vdCBhIGJlaGF2aW91cmFsIGhhdGNoOiBpdCBjaGFuZ2VzIG5vdGhpbmcgdGhlIGNsaWVudCBkb2VzLiBJdCBleGlzdHNcbiAgICogZm9yIGAuL3RhaWxIYW5kb2ZmLnRzYCwgd2hvc2UgbGFzdCBsaW5lIG5hbWVzIHRoZSByZS1hcm0gYW5kIG11c3QgY2FycnlcbiAgICogdGhlIGN1cnNvciBleGFjdGx5IGFzIHRoaXMgbG9vcCBsZWZ0IGl0LCBlcG9jaCByZXNldHMgaW5jbHVkZWQuXG4gICAqL1xuICBvbkVuZD86IChlbmQ6IHtcbiAgICBjdXJzb3I6IG51bWJlcjtcbiAgICAvKiogVGhlIGVwb2NoIG9mIHRoZSBsb2cgdGhlIGN1cnNvciBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZS4gKi9cbiAgICBlcG9jaDogc3RyaW5nIHwgbnVsbDtcbiAgICByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCI7XG4gIH0pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7XG4gIGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7XG4gIGNvbW1lbnRzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBvcHRzLnNpbmNlRXBvY2ggPz8gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG4gIGxldCBlbmRpbmc6IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgPSBcInN0b3BwZWRcIjtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIC8vIOKblCBBIFNUT1AgVEhBVCBMQU5ERUQgV0hJTEUgYHJlc29sdmVgIFdBUyBBV0FJVEVEICh0aGUgaGFuZG9mZidzIHdpbmRvdyxcbiAgICAgIC8vIGEgc2lnbmFsKSBmb3VuZCBubyBhdHRlbXB0IHRvIGFib3J0LiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlIGxvb3Agd2VudFxuICAgICAgLy8gb24gdG8gZmV0Y2gsIHNraXBwZWQgdGhlIHJlYWQsIGFuZCByZXR1cm5lZCB3aXRoIHRoYXQgc3RyZWFtIHN0aWxsXG4gICAgICAvLyBvcGVuIOKAlCB3aGljaCBrZWVwcyBhIHByb2Nlc3MgYWxpdmUgZXhhY3RseSBsaWtlIHRoZSB0ZXJtaW5hbC1mcmFtZVxuICAgICAgLy8gaGFuZy4gKFN1c3BlY3RlZCBieSB0aGUgcmV2aWV3ZXIsIHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKVxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHtcbiAgICAgICAgc2luY2U6IFN0cmluZyhjdXJzb3IpLFxuICAgICAgfTtcbiAgICAgIC8vIFdoYXQgdGhpcyBjb25uZWN0aW9uIGFza2VkIGZyb20sIGZvciBgcmVzdGFydE9uUmVwbGF5YC5cbiAgICAgIGNvbnN0IGFza2VkU2luY2UgPSBjdXJzb3I7XG4gICAgICBsZXQgcmVzdGFydE5vdGVkID0gZmFsc2U7XG4gICAgICAvLyBTZXQgd2hlbiBhbiBlcG9jaCBjaGFuZ2UgZmluZHMgdGhlIG5ldyBsb2cgcGFzdCB0aGUgYm9va21hcmsuXG4gICAgICBsZXQgZnJvbVRvcCA9IGZhbHNlO1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcblxuICAgICAgICAgICAgbGV0IGVwb2NoUmVzZXQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGVwb2NoUmVzZXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICAgIC8vIFRoZSBuZXcgbG9nIGlzIHBhc3QgdGhlIGJvb2ttYXJrOiBpdHMgc3RhcnQgd2FzIHNraXBwZWQuXG4gICAgICAgICAgICAgICAgICAvLyBEcm9wIHRoaXMgYXR0ZW1wdCBhbmQgcmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIDAuXG4gICAgICAgICAgICAgICAgICBpZiAoYXNrZWRTaW5jZSA+IDAgJiYgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgbiA+IGFza2VkU2luY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICAgICAgICBmcm9tVG9wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBvcHRzLnJlc3RhcnRPblJlcGxheSA9PT0gdHJ1ZSAmJlxuICAgICAgICAgICAgICAhZXBvY2hSZXNldCAmJlxuICAgICAgICAgICAgICAhcmVzdGFydE5vdGVkICYmXG4gICAgICAgICAgICAgIGFza2VkU2luY2UgPj0gMCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICBuIDw9IGFza2VkU2luY2VcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyBUaGUgZGFlbW9uIHJlcGxheWVkIFdIT0xFOiBpdHMgbG9nIHJlc3RhcnRlZCAoc2VlIHRoZSBvcHRpb24pLlxuICAgICAgICAgICAgICByZXN0YXJ0Tm90ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4ob3B0cy5lcG9jaE9mPy4oZXYpID8/IFwidW5rbm93blwiKSA/PyBudWxsO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgIC8vIFJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSBpdHMgc3RhcnQsIG5vdzogbm90aGluZyBmYWlsZWQuXG4gICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gICAgb3B0cy5vbkVuZD8uKHsgY3Vyc29yLCBlcG9jaCwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvaXRlbXMvc2NyaXB0b3JpdW0tdGFpbC1tb25pdG9yLWV4cGlyeS13YWtlcy10aGUtYWdlbnQtZm9yLW5vdGhpbmcubWRgKVxuICogYW5kIHRoZSBmb3VyIGFkanVzdG1lbnRzIG9mIGl0cyBmZWFzaWJpbGl0eSBzcGlrZVxuICogKGBkb2NzL2l0ZW1zL21vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC93cml0ZS11cC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgKGFzdHJvbGFiZSwgZ3JhcGV2aW5lKSBhbHdheXMgZ2V0c1xuICogICAgIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsIHdvdWxkIGZsaWNrZXIgdGhlIHByZXNlbmNlIGl0c1xuICogICAgIGNvbm5lY3Rpb24gY2Fycmllcy4gTWluZC1tYXBwZXIgd2FzIG9uZSBhbmQgaXMgbm90IHNpbmNlIDIwMjYtMDktMjRcbiAqICAgICAoc2VlIFwiTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTXCIgYmVsb3cpLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMgYW5kIG1pbmQtbWFwcGVyKSwgZWFjaCBuYW1pbmcgaG93IHRvXG4gKiBjb21lIGJhY2sgaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMsIGBvcGVuIC0tbm8tb3BlbmAgZm9yXG4gKiAgICAgIG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmUgYVxuICogcmVhbC1kYWVtb24gY2VsbCBpbiBgc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdGFpbC1oYW5kb2ZmLmludGVncmF0aW9uLnRlc3QudHNgLlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4tcHJvY2Vzc1xuICogICAgICAgICAgICAoYXN0cm9sYWJlLCBvciBtaW5kLW1hcHBlciB3aGVuIGl0cyBkYWVtb24gaXMgYmFjayBiZWZvcmUgdGhlXG4gKiAgICAgICAgICAgIGxvc3QgcnVsZSBmaXJlcykgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHlcbiAqICAgICAgICAgICAgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBvcGVucyBub1xuICogYnJvd3NlciB0YWIuXG4gKlxuICog4pqgIEtOT1dOIEVER0UsIE5PVCBGSVhFRCAoZm91bmQgYnkgdGhlIHJlLXJldmlldyk6IGEga2V5ZWQgYm91bnR5IEZJUlNUIGFybVxuICogICAoYW4gYW50aGlsbCBzZWF0KSB3aG9zZSB3aW5kb3cgZW5kcyBiZWZvcmUgaXRzIGJvYXJkIGV2ZXIgb3BlbnMgcHJpbnRzIGFcbiAqICAgcmUtYXJtIHBpbm5lZCB0byB0aGUgZGVyaXZlZCBpZCB3aXRoIGFuIGVtcHR5IGJvb2ttYXJrXG4gKiAgIChgLS1zZXNzaW9uIGst4oCmIC0tc2luY2U9LTEgLS1vbmNlYCkuIFRoYXQgcmUtYXJtIGlzIGEgcmUtYXJtIGJ5IEQxJ3MgcnVsZSxcbiAqICAgc28gaWYgdGhlIGJvYXJkIGlzIHN0aWxsIG5vdCB1cCDigJQgdGhlIGxlYWQgbW9yZSB0aGFuIG9uZSB3aW5kb3cgKDI5IG1pbilcbiAqICAgbGF0ZSDigJQgdGhlIHNlYXQgZG9lcyBub3Qgd2FpdC4gTWlub3I6IHRoZSBuZXh0IHN0ZXAgaXQgbmFtZXNcbiAqICAgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApIGlzIHRoZSByaWdodCBvbmUgYW55d2F5LiBTaW5jZSAjOTggKDIwMjYtMDktMjcpXG4gKiAgIGl0IG5vIGxvbmdlciBzYXlzIGB0YWlsLmNsb3NlZGAgYWJvdXQgYSBib2FyZCB0aGF0IG5ldmVyIG9wZW5lZDogYSBuYW1lZFxuICogICBgLS1zZXNzaW9uYCB3aXRoIG5vIHNuYXBzaG90IG9uIGRpc2sgZXhpdHMgYG5vdF9mb3VuZGAgYWZ0ZXIgYSBncmFjZS5cbiAqXG4gKiDilIDilIAgVEhFIENPTU1BTkQgTkFNRVMgTk8gUEFUSCAoQ29sZSdzIHJ1bGluZywgMjAyNi0wOS0yNCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIGxpbmUncyBgY29tbWFuZGAgaXMgdGhlIFZFUkIgQU5EIElUUyBBUkdVTUVOVFMgT05MWVxuICogKGB0YWlsIC0tc2Vzc2lvbiBYIC0tc2luY2UgTkBFIC0tb25jZWApLCBwbHVzIGBzcGVsbGAsIGFuZCB0aGUgYWdlbnQgcnVucyBpdFxuICogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50c2AuIEl0IHVzZWRcbiAqIHRvIGJlIHJ1bm5hYmxlIGFzIHByaW50ZWQsIGhlYWRlZCBieSBgYnVuIDxhcmd2WzFdPmAg4oCUIGFuZCBmb3IgYW4gaW5zdGFsbGVkXG4gKiBwbHVnaW4gYGFyZ3ZbMV1gIGlzIGluc2lkZSBhIFZFUlNJT05FRCBjYWNoZSBkaXJlY3RvcnkuIEFuIHVwZ3JhZGUgbWFya3MgdGhlXG4gKiBvbGQgZGlyZWN0b3J5IG9ycGhhbmVkIGFuZCBkZWxldGVzIGl0IGxhdGVyIChtZWFzdXJlZCBpblxuICogYGRvY3MvaXRlbXMvdGFpbC1yZWFybS1jb21tYW5kLW5hbWVzLWEtdmVyc2lvbmVkLXBsdWdpbi1wYXRoLm1kYCksXG4gKiBzbyBhIGxpbmUgcHJpbnRlZCBiZWZvcmUgYW4gdXBncmFkZSBmaXJzdCByYW4gU1RBTEUgY29kZSBhZ2FpbnN0IGEgbmV3ZXJcbiAqIGRhZW1vbiwgdGhlbiBmYWlsZWQgd2l0aCBcIm1vZHVsZSBub3QgZm91bmRcIiBvbmNlIHRoZSBkaXJlY3Rvcnkgd2FzIGdvbmUuIE5vXG4gKiBzdGFibGUgcGF0aCBleGlzdHMgdG8gcHJpbnQgaW5zdGVhZDogdGhlIGNhY2hlLCBgJENMQVVERV9QTFVHSU5fUk9PVGAgYW5kIHRoZVxuICogaW5zdGFsbCByZWNvcmQgYXJlIGFsbCB2ZXJzaW9uZWQuXG4gKiAgIFRoZSBza2lsbCdzIGxhdW5jaGVyIGlzIGFsd2F5cyB0aGUgdmVyc2lvbiB0aGUgc2Vzc2lvbiBsb2FkZWQuIENvbGUnc1xuICogcmVhc29uaW5nOiB0aGUgd29yc3QgY2FzZSBpcyB0aGF0IHRoZSBDTEkgY2hhbmdlZCBhbmQgdGhlIGFnZW50IGdldHMgYW5cbiAqIGVycm9yIOKAlCBhbmQgaWYgdGhlIHRvb2xzIGFyZSBkZXNpZ25lZCByaWdodCwgdGhhdCBlcnJvciBzYXlzIHdoYXQgd2VudFxuICogd3JvbmcuIFNvIHRoZSBwYXJzZXJzIGFyZSB0aGUgb3RoZXIgaGFsZiBvZiB0aGlzIHJ1bGluZzogYHJlYWRTaW5jZWAgcmVmdXNlc1xuICogYW55IGAtLXNpbmNlYCBmb3JtIGEgdGFpbCBkb2VzIG5vdCBhY2NlcHQgd2l0aCBhIHVzYWdlIGVycm9yIE5BTUlORyB0aGVcbiAqIGZvcm1zIGl0IGRvZXMsIHRoZSBzYW1lIHdheSBvbiBhbGwgZWlnaHQgdGFpbHMsIGluc3RlYWQgb2YgbWlzcGFyc2luZyBpdC5cbiAqICAgTm90IHRha2VuOiBwcmludGluZyB0aGUgcGF0aCBBTkQgdGhlIGFyZ3MgKG9wdGlvbiBBIG9mIHRoZSBpdGVtIOKAlCB0d29cbiAqIGNvbW1hbmRzIHdoZXJlIG9uZSBpcyB3cm9uZyBhZnRlciBhbiB1cGdyYWRlKTsgYSBsYXVuY2hlciB0aGF0IG5vdGljZXMgaXQgaXNcbiAqIG9ycGhhbmVkIGFuZCByZS1leGVjcyBhIG5ld2VyIHNpYmxpbmcgKEIg4oCUIGl0IGxlYW5zIG9uIGEgQ2xhdWRlIENvZGVcbiAqIGludGVybmFsIG1hcmtlciBhbmQgZG9lcyBub3RoaW5nIG9uY2UgdGhlIGRpcmVjdG9yeSBpcyBkZWxldGVkKTsgdmVyc2lvblxuICogbmVnb3RpYXRpb24uXG4gKlxuICog4pSA4pSAIE1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMUyAoQ29sZSdzIHJ1bGluZywgMjAyNi0wOS0yNCkg4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVpbHQgb24gYGZlYXQvbWluZC1tYXBwZXItcXVpZXQtaGFuZG9mZmAuIEl0IFJFVkVSU0VTIHRoZSBpbXBsZW1lbnRlcidzXG4gKiBydWxpbmcgb2YgYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0aGF0IG1pbmQtbWFwcGVyIGlzIGEgcHJlc2VuY2Ugc3BlbGxcbiAqIChpdHMgZGFlbW9uIGNvdW50cyBhbiBvcGVuIFNTRSB0YWlsIGFzIHRoZSBhZ2VudCBwcmVzZW50LCBzbyB0aGUgd2luZG93XG4gKiBhbHdheXMgcmUtYXJtZWQgTW9uaXRvcikuIENvbGUncyByZWFzb25pbmc6IG1pbmQtbWFwcGVyIHNlc3Npb25zIGFyZSB1c2VkXG4gKiBsaWtlIHNjcmlwdG9yaXVtJ3MsIGJ1cnN0cyBvZiBhY3Rpdml0eSB3aXRoIGJyZWFrcywgYW5kIGluIGEgYnJlYWsgdGhlIGFnZW50XG4gKiBzaG91bGQgbm90IGJlIHdva2VuIGV2ZXJ5IDMwIG1pbnV0ZXMuIFNvIG1pbmQtbWFwcGVyIHRha2VzIHRoZSBxdWlldCBoYW5kb2ZmXG4gKiB0byBgLS1vbmNlYCwgdGhlIGxvc3QgY29tZS1iYWNrIChgb3BlbiAtLW5vLW9wZW5gKSwgYW5kIGtlZXBzIGl0c1xuICogYC0tc2luY2UgTkBlcG9jaGAgYm9va21hcmsuIFRocmVlIHRoaW5ncyBoYWQgdG8gYmUgc2V0dGxlZCB0byBtYWtlIHRoYXRcbiAqIGhvbmVzdCwgZWFjaCBwaW5uZWQgaW4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3t0YWlsLHByZXNlbmNlfS50ZXN0LnRzYFxuICogYW5kIG11dGF0aW9uLWNvbmZpcm1lZDpcbiAqXG4gKiBNMSDCtyBQUkVTRU5DRSBMSU5HRVJTIEFDUk9TUyBUSEUgR0FQUyAodGhlIGRhZW1vbiwgYHNlcnZlci50c2BcbiAqICAgICAgYGFkanVzdEFnZW50c2ApLiBBIG9uZS1zaG90IGhvbGRzIGFuIFNTRSBjb25uZWN0aW9uLCBzbyBpdCBDT1VOVFMgYXNcbiAqICAgICAgcHJlc2VudCwgd2hpY2ggaXMgdHJ1ZTogdGhlIGFnZW50IHdpbGwgd2FrZSBvbiB0aGUgbmV4dCBldmVudC4gVGhlIGdhcHNcbiAqICAgICAgYXJlIHRoZSBwcm9ibGVtOiB3aW5kb3cg4oaSIHJlLWFybSwgcXVpZXQg4oaSIGAtLW9uY2VgLCBhbmQgYWJvdmUgYWxsXG4gKiAgICAgIGB0YWlsLndva2VgIOKGkiB0aGUgYWdlbnQgaGFuZGxlcyB0aGUgZXZlbnQg4oaSIE1vbml0b3IsIHdoaWNoIGxhc3RzIHRoZVxuICogICAgICBhZ2VudCdzIHdob2xlIHR1cm4uIFJhdywgdGhlIHN1cmZhY2UncyBoZWFkZXIgZG90ICh0aGUgb25seSB0aGluZ1xuICogICAgICBwcmVzZW5jZSBkcml2ZXMgdGhlcmUsIGJlc2lkZXMgdGhlIGRhZW1vbidzIGF1dG8tYHJlY2VpdmVkYCBmbGlwIG9uIGFcbiAqICAgICAgaHVtYW4gbWVzc2FnZSkgcmVhZCBcImNvbm5lY3RlZCDigJQgbm8gYWdlbnQgb24gdGhpcyBwcm9qZWN0XCIgd2hpbGUgdGhlXG4gKiAgICAgIGFnZW50IHdhcyB3b3JraW5nIHRoZSBib2FyZCwgYW5kIGEgbWVzc2FnZSBzZW50IHRoZW4gZ290IG5vXG4gKiAgICAgIGByZWNlaXZlZGAuIFRoZSBkYWVtb24gaGFzIG5vIGlkbGUgY2xvc2UsIHNvIG5vdGhpbmcgZWxzZSByZWFjdHMuIE5vd1xuICogICAgICB0aGUgY291bnQgSE9MRFMgZm9yIGBNSU5EX01BUFBFUl9QUkVTRU5DRV9MSU5HRVJfTVNgICgxNTAgcywgdGhlIHN0YWxsXG4gKiAgICAgIHdpbmRvdydzIGJlYXQpIGFmdGVyIHRoZSBsYXN0IHRhaWwgY2xvc2VzOiBhIHRhaWwgb3BlbmluZyBpbnNpZGUgaXRcbiAqICAgICAgZW1pdHMgbm90aGluZywgYW4gYWdlbnQtb25seSB3cml0ZSAoYC9hY3Rpdml0eWAsIGFuIGFnZW50IGAvc2VuZGApXG4gKiAgICAgIHJlc3RhcnRzIGl0LCBhbmQgc2lsZW5jZSBwYXN0IGl0IGRyb3BzIHRoZSBjb3VudCB0byAwLlxuICogICAgICDimpYgTm90IHRha2VuOiByZS1hcm1pbmcgTW9uaXRvciBCRUZPUkUgaGFuZGxpbmcgYSB3b2tlbiBldmVudCAodGhhdCBpc1xuICogICAgICB0aGUgc2hhcmVkIHJ1bGUsIHdvcmQtZm9yLXdvcmQgaW4gZXZlcnkgc3BlbGwpOyByZWZyZXNoaW5nIG9uIGV2ZXJ5XG4gKiAgICAgIGJvYXJkIHdyaXRlICh0aGUgYnJvd3NlciBQT1NUcyB0aGUgc2FtZSByb3V0ZXMsIHNvIHRoZSBodW1hbidzIG93blxuICogICAgICBjbGlja3Mgd291bGQga2VlcCB0aGUgZG90IGxpdCkuIENvc3Q6IGFuIGFnZW50IHRoYXQgcmVhbGx5IGxlZnQgcmVhZHNcbiAqICAgICAgXCJoZXJlXCIgZm9yIHVwIHRvIDE1MCBzLlxuICogTTIgwrcgYHByZXNlbmNlLmNoYW5nZWRgIElTIE5PVCBDT1VOVEVEIChtaW5kLW1hcHBlcidzIGBjb3VudHNgKS4gSXQgaXMgT05cbiAqICAgICAgVEhFIExPRywgd2l0aCBhbiBpZCwgYW5kIGEgdGFpbCdzIG93biBjb25uZWN0IGVtaXRzIG9uZSBvbnRvIGl0cyBvd25cbiAqICAgICAgc3RyZWFtLCBzbyBjb3VudGVkIGl0IG1hZGUgZXZlcnkgd2luZG93IFwiYWN0aXZlXCIgYW5kIHdvdWxkIHdha2UgZXZlcnlcbiAqICAgICAgYC0tb25jZWAgb24gaXRzZWxmLiBUaGUgbGluZ2VyIHJlbW92ZXMgbW9zdCBvZiB0aGF0IGNodXJuOyBgY291bnRzYFxuICogICAgICByZW1vdmVzIHRoZSByZXN0IChhIGZpcnN0IGFybSwgYW5vdGhlciBhZ2VudCBjb21pbmcgb3IgZ29pbmcpLlxuICogTTMgwrcgQSBERUFEIERBRU1PTiBJUyBMT1NULCBOT1QgVU5SRVNPTFZFRCAobWluZC1tYXBwZXIncyBgcmVzb2x2ZWApLiBJdHNcbiAqICAgICAgZGlzY292ZXJ5IHByb2JlcyB0aGUgZGFlbW9uJ3MgcGlkLCBzbyBhIGtpbGxlZCBkYWVtb24gbWFkZSBgcmVzb2x2ZWBcbiAqICAgICAgYW5zd2VyIG51bGwgYW5kIGFuIHVucmVzb2x2ZWQgdGFpbCByZXRyaWVzIGZvcmV2ZXI6IGEgYC0tb25jZWAgd291bGRcbiAqICAgICAgaGF2ZSBzbGVwdCBmb3IgZ29vZCAoRDEncyBkZWZlY3QpLiBUaGUgdGFpbCBrZWVwcyB0aGUgbGFzdCBVUkwgaXRcbiAqICAgICAgcmVzb2x2ZWQsIHNvIHRoZSBkZWFkIHBvcnQgcmVmdXNlcyBhbmQgYExPU1RfQUZURVJfUkVGVVNBTFNgIGVuZHMgaXRcbiAqICAgICAgd2l0aCBgdGFpbC5sb3N0YCDihpIgYG9wZW4gLS1uby1vcGVuYCwgdGhlbiBhIHRhaWwgd2l0aCBubyBgLS1zaW5jZWAuXG4gKiAgICAgIE1pbmQtbWFwcGVyIGhhcyBubyBzZXNzaW9uIHRvIGNsb3NlLCBzbyBpdCBuZXZlciBwcmludHMgYHRhaWwuY2xvc2VkYC5cbiAqICAgICAgTWVhc3VyZWQgb24gYSByZWFsIGBraWxsIC05YCB1bmRlciBhIGAtLW9uY2VgOiBgdGFpbC5sb3N0YCA3IHMgbGF0ZXIsXG4gKiAgICAgIG5vdCAwLjc1IHMsIGJlY2F1c2UgbWluZC1tYXBwZXIncyBvd24gYmFja29mZiBzdGFydHMgYXQgMSBzICgxICsgMiArIDQpLlxuICogICAgICBNMeKAk00zIHdlcmUgZHJpdmVuIG9uIGEgcmVhbCBkYWVtb24gd2l0aCBhIDQgcyB3aW5kb3c6IGFjdGl2ZSDihpIgd2luZG93LFxuICogICAgICBxdWlldCDihpIgYC0tb25jZWAsIGEgaHVtYW4gbWVzc2FnZSB3b2tlIGl0LCBiYWNrIHRvIE1vbml0b3I7IHByZXNlbmNlXG4gKiAgICAgIG5ldmVyIGRyb3BwZWQgYWNyb3NzIHRoZSBnYXBzLlxuICpcbiAqIOKaliBgLS1vbmNlYCBFTkRTIE9OIFRIRSBGSVJTVCBGUkFNRSwgd2l0aCBubyBkcmFpbi4gQSBidXJzdCBhcnJpdmVzIHNwbGl0OiB0aGVcbiAqICAgZmlyc3QgZXZlbnQgb24gdGhlIG9uZS1zaG90LCB0aGUgcmVzdCBvbiB0aGUgTW9uaXRvciByZS1hcm0sIHdoaWNoIGxvc2VzXG4gKiAgIG5vdGhpbmcgYmVjYXVzZSBvZiB0aGUgYm9va21hcmsuIFRoZSBzcGlrZSBvZmZlcmVkIGEgfjIwMCBtcyBkcmFpbiBhcyBhblxuICogICBvcHRpb24sIG5vdCBhIHJlcXVpcmVtZW50OyBub3QgdGFrZW4sIGJlY2F1c2UgaXQgYWRkcyBhIHRpbWVyIHRvIHRoZVxuICogICBleGl0IHBhdGggd2hvc2UgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gbWFrZSBpbXBvc3NpYmxlLlxuICog4pqWIFRIRSBMSU5FJ1MgYGNvbW1hbmRgIElTIENPTVBMRVRFIEJVVCBGT1IgVEhFIExBVU5DSEVSOiBwaW5uZWQgdG8gdGhlXG4gKiAgIHNlc3Npb24gdGhpcyB0YWlsIHdhcyBib3VuZCB0bywgd2l0aCBpdHMgc2NvcGUgZmxhZ3MuIFRoZSBza2lsbHMgbmFtZSB0aGVcbiAqICAgcnVsZSBvbmNlLCBsYXVuY2hlciBmb3JtIGluY2x1ZGVkOyB0aGUgbGluZSBjYXJyaWVzIHRoZSBzcGVjaWZpY3MuXG4gKlxuICogUzEgwrcgV0hPIENMT1NFRCBJVCBSSURFUyBUSEUgTElORSAoc2NyaXB0b3JpdW0ncyBFbmQgc2Vzc2lvbiwgMjAyNi0xMC0wMSkuXG4gKiAgICAgIEEgc3BlbGwgd2hvc2UgYGNsb3NlZGAgZnJhbWUgc2F5cyB3aG8gZW5kZWQgdGhlIHNlc3Npb24gcGFzc2VzXG4gKiAgICAgIGBjbG9zZWRCeWAsIGFuZCBgdGFpbC5jbG9zZWRgIGNhcnJpZXMgaXQgYXMgYGJ5YC4gYGJ5OiBcImh1bWFuXCJgIGNoYW5nZXNcbiAqICAgICAgdGhlIGhpbnQ6IHRoZSBodW1hbiBlbmRlZCBpdCBPTiBQVVJQT1NFLCBzbyB0aGUgYWdlbnQgc3RvcHMgYW5kIGRvZXMgbm90XG4gKiAgICAgIHJlb3BlbiB1bmxlc3MgYXNrZWQg4oCUIHRoZSB3YXkgYmFjayBpcyBzdGlsbCBuYW1lZCwgY29uZGl0aW9uZWQgb24gdGhhdC5cbiAqICAgICAgVGhlIGFnZW50IHJvdXRlcyBvbiBgYnlgLCBuZXZlciBvbiB0aGUgaGludCdzIHByb3NlLiBBIHJlLWFybSBhZnRlclxuICogICAgICB0aGUgZW5kIHNlZXMgbm8gY2xvc2luZyBmcmFtZSAoRDEncyBwYXRoKSwgc28gdGhlIHNwZWxsIGFsc28gcGFzc2VzXG4gKiAgICAgIGBnb25lQnlgLCByZWFkIGZyb20gd2hlcmUgdGhlIGZhY3Qgb3V0bGl2ZXMgdGhlIGRhZW1vbjsgd2l0aG91dCBpdCB0aGVcbiAqICAgICAgcmUtYXJtZWQgbGluZSBkcm9wcGVkIGBieWAgYW5kIGludml0ZWQgdGhlIHJlb3BlbiAodmVyaWZpZXIsIDIwMjYtMTAtMDEpLlxuICogICAgICDimpYgT3B0aW9ucyBub3QgdGFrZW46IGEgc3BlbGwtc2lkZSByZXdyaXRlIG9mIHRoZSBwcmludGVkIGxpbmUgKGEgc2Vjb25kXG4gKiAgICAgIHdyaXRlciBvZiB0aGUgc2FtZSBsaW5lKSwgb3IgYSBzcGVsbC1zdXBwbGllZCBoaW50IChlYWNoIHNwZWxsIHdvdWxkXG4gKiAgICAgIHdvcmQgXCJvbiBwdXJwb3NlXCIgaXRzIG93biB3YXkpLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBUaGUgb25lIHNlbnRlbmNlIGV2ZXJ5IGB0YWlsYCdzIGhlbHAgY2Fycmllcywgc28gYSBodW1hbiB3YXRjaGluZyBpbiBhXG4gKiAgdGVybWluYWwgZmluZHMgdGhlIGVzY2FwZSBoYXRjaCB3aGVyZSB0aGV5IGxvb2sgKEQ0KS4gV29yZGVkIG9uY2UgaGVyZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfSEVMUCA9XG4gIFwiZW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyAzMC1taW51dGUgY2FwIHdpdGggYSBsaW5lIG5hbWluZyB0aGUgbmV4dCBhY3Q7IGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCBrZWVwcyBpdCBvcGVuIHdpdGggU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBcIjtcblxuLyoqIENvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3cgdGhhdCBtYWtlIHRoZSBkYWVtb24gXCJsb3N0XCIgKHNlZSBBMikuIFRocmVlXG4gKiAgc3BhbiBhYm91dCAwLjc1IHMgdW5kZXIgdGhlIGtpdCdzIGRlZmF1bHQgYmFja29mZiAoMjUwICsgNTAwIG1zIGJldHdlZW5cbiAqICB0aGVtKTogYSBsaXZlIGRhZW1vbiBuZXZlciByZWZ1c2VzIGl0cyBvd24gcG9ydCwgYW5kIHRoZSB0d28gZXh0cmEgYXR0ZW1wdHNcbiAqICBvbmx5IGJ1eSB0b2xlcmFuY2UgZm9yIGEgcmVzdGFydCB0aGF0IHJlYmluZHMgdGhlIHNhbWUgcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBMT1NUX0FGVEVSX1JFRlVTQUxTID0gMztcblxuLyoqIFRoZSB3aW5kb3cgbGVuZ3RoOiB0aGUgZW52IHZhbHVlIHdoZW4gaXQgaXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZWxzZSB0aGVcbiAqICBkZWZhdWx0LiBgMGAgbWVhbnMgbm8gd2luZG93LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXaW5kb3dNcyhyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcudHJpbSgpID09PSBcIlwiKSByZXR1cm4gREVGQVVMVF9XSU5ET1dfTVM7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIobikgJiYgbiA+PSAwID8gbiA6IERFRkFVTFRfV0lORE9XX01TO1xufVxuXG5leHBvcnQgdHlwZSBUYWlsTW9kZSA9IFwid2F0Y2hcIiB8IFwib25jZVwiO1xuXG4vKiogSG93IGEgdGFpbCBlbmRlZC4gYHdpbmRvd2AgaXMgb3VyIG93biBkZWFkbGluZSwgYGV2ZW50YCBpcyBhIGAtLW9uY2VgJ3NcbiAqICBmaXJzdCBmcmFtZSwgYGNsb3NlZGAgaXMgdGhlIHNlc3Npb24gZW5kaW5nIChhIGBjbG9zZWRgIGZyYW1lIG9yIHRoZSBwaW5uZWRcbiAqICBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcpLCBgbG9zdGAgaXMgdGhlIGRhZW1vbiByZWZ1c2luZyBjb25uZWN0aW9ucyxcbiAqICBhbmQgYHN0b3BwZWRgIGlzIGEgc2lnbmFsLCBhIGNhbGxlcidzIGFib3J0IG9yIGEgY2xvc2VkIHN0ZG91dC4gKi9cbmV4cG9ydCB0eXBlIFRhaWxFbmQgPSBcIndpbmRvd1wiIHwgXCJldmVudFwiIHwgXCJjbG9zZWRcIiB8IFwibG9zdFwiIHwgXCJzdG9wcGVkXCI7XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZJbnB1dCA9IHtcbiAgLyoqIFRoZSBzcGVsbCB3aG9zZSB0YWlsIHRoaXMgaXMsIHNvIHRoZSBhZ2VudCBrbm93cyB3aG9zZSBsYXVuY2hlciBydW5zIGl0LiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBlbmQ6IFRhaWxFbmQ7XG4gIC8qKiBXaG8gZW5kZWQgYSBgY2xvc2VkYCBzZXNzaW9uLCB3aGVuIGl0cyBjbG9zaW5nIGZyYW1lIHNhaWQgKFMxKS4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogVGhlIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaC4gKi9cbiAgZXBvY2g/OiBzdHJpbmc7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiBgZXBvY2hgIGlzIHRoZVxuICAgKiAgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZTogYSBzcGVsbCB3aG9zZVxuICAgKiAgYC0tc2luY2VgIHBhcnNlcyBgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSBwcmludHMgaXQuICovXG4gIHRhaWw6IChvOiB7IHNpbmNlOiBudW1iZXI7IG9uY2U6IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIC8qKiBXaG9zZSBsYXVuY2hlciBydW5zIGBjb21tYW5kYC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZXZlbnRzOiBudW1iZXI7XG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogYHRhaWwuY2xvc2VkYCBvbmx5OiB3aG8gZW5kZWQgdGhlIHNlc3Npb24sIHdoZW4gdGhlIHNwZWxsIHNheXMgKFMxKS4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIC8qKiBgbW9uaXRvcmA6IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggdGhlIGxhdW5jaGVyICsgYGNvbW1hbmRgLlxuICAgKiAgYGJhY2tncm91bmRgOiBydW4gdGhlIGxhdW5jaGVyICsgYGNvbW1hbmRgIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2suXG4gICAqICBgc3RvcGA6IG5vdGhpbmcgdG8gd2F0Y2g7IGBjb21tYW5kYCBpcyBob3cgdG8gY29tZSBiYWNrLCBpZiB3YW50ZWQuICovXG4gIG5leHQ6IFwibW9uaXRvclwiIHwgXCJiYWNrZ3JvdW5kXCIgfCBcInN0b3BcIjtcbiAgLyoqIFRoZSB2ZXJiIGFuZCBpdHMgYXJndW1lbnRzIE9OTFkg4oCUIG5vIGxhdW5jaGVyLCBubyBwYXRoLiBUaGUgYWdlbnQgcnVuc1xuICAgKiAgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+YC4gKi9cbiAgY29tbWFuZDogc3RyaW5nO1xuICBoaW50OiBzdHJpbmc7XG59O1xuXG4vKiogSG93IHRoZSBhZ2VudCBydW5zIGEgcHJpbnRlZCBgY29tbWFuZGA6IHdpdGggSVRTIE9XTiBsYXVuY2hlciwgbmV2ZXIgYSBwYXRoXG4gKiAgdGhpcyBwcm9jZXNzIG5hbWVzICh0aGUgcnVsaW5nIG9uIHRoZSB2ZXJzaW9uZWQgcGx1Z2luIHBhdGgsIGluIHRoZSBoZWFkZXIpLiAqL1xuZXhwb3J0IGNvbnN0IFJVTl9XSVRIX0xBVU5DSEVSID0gXCJidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPlwiO1xuXG4vKiogVGhlIGNvbWUtYmFjayBoaW50LCB3aXRoIGhvdyB0byBSRVNVTUUgYWZ0ZXIgY29taW5nIGJhY2sgKEQyKTogYSByZXN0b3JlZFxuICogIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIG1lYW5zIG5vdGhpbmcgdGhlcmUuICovXG5jb25zdCBDT01FX0JBQ0sgPSAod2h5OiBzdHJpbmcsIGxlYWQgPSBcIlRvIGJyaW5nIGl0IGJhY2tcIikgPT5cbiAgYCR7d2h5fSAke2xlYWR9LCBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn07IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBzcGVsbDogcy5zcGVsbCwgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgLi4uKHMuYnkgPyB7IGJ5OiBzLmJ5IH0gOiB7fSksXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDpcbiAgICAgICAgICBzLmJ5ID09PSBcImh1bWFuXCJcbiAgICAgICAgICAgID8gQ09NRV9CQUNLKFxuICAgICAgICAgICAgICAgIFwidGhlIGh1bWFuIGVuZGVkIHRoaXMgc2Vzc2lvbiBvbiBwdXJwb3NlOyBzdG9wIHdhdGNoaW5nLCBhbmQgZG8gbm90IHJlb3BlbiBpdCB1bmxlc3MgdGhleSBhc2suXCIsXG4gICAgICAgICAgICAgICAgXCJJZiB0aGV5IGFza1wiLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICA6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoe1xuICAgICAgICAgICAgc2luY2U6IHMuY3Vyc29yLFxuICAgICAgICAgICAgb25jZTogZmFsc2UsXG4gICAgICAgICAgICAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoaW50OiBgdGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYG5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9IGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2sgKHJ1bl9pbl9iYWNrZ3JvdW5kKSDigJQgaXQgZXhpdHMgb24gdGhlIG5leHQgZXZlbnRgLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQgYWZ0ZXIgdGhlIGFnZW50J3Mgb3duIGxhdW5jaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoZWxsUXVvdGUoYXJnOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bQS1aYS16MC05X0AlKz06LC4vLV0rJC8udGVzdChhcmcpID8gYXJnIDogYCcke2FyZy5yZXBsYWNlQWxsKFwiJ1wiLCBgJ1xcXFwnJ2ApfSdgO1xufVxuXG4vKipcbiAqIFJlYWQgYSBgLS1zaW5jZWAgdmFsdWU6IGFuIGV2ZW50IGlkLCBvcHRpb25hbGx5IGNhcnJ5aW5nIHRoZSBlcG9jaCBvZiB0aGVcbiAqIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgRDIpLiBOdWxsIHdoZW4gdGhlIGlkIGlzIG5vdCBhbiBpbnRlZ2VyLlxuICogRm9yIHRoZSBzcGVsbHMgd2hvc2UgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaDsgdGhlIHJlc3QgdGFrZSBhIHBsYWluIGlkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCb29rbWFyayh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGF0ID0gdG9rZW4uaW5kZXhPZihcIkBcIik7XG4gIGNvbnN0IGlkID0gYXQgPT09IC0xID8gdG9rZW4gOiB0b2tlbi5zbGljZSgwLCBhdCk7XG4gIGNvbnN0IGVwb2NoID0gYXQgPT09IC0xID8gXCJcIiA6IHRva2VuLnNsaWNlKGF0ICsgMSk7XG4gIGlmICghL14tP1xcZCskLy50ZXN0KGlkLnRyaW0oKSkpIHJldHVybiBudWxsO1xuICBpZiAoYXQgIT09IC0xICYmIGVwb2NoID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc2luY2U6IE51bWJlci5wYXJzZUludChpZCwgMTApLCAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSkgfTtcbn1cblxuLyoqXG4gKiBFdmVyeSB0YWlsJ3MgYC0tc2luY2VgLCByZWFkIHRoZSBzYW1lIHdheTogYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cywgb3IgYVxuICogcmVmdXNhbCB0aGF0IE5BTUVTIHRoZSBhY2NlcHRlZCBmb3Jtcy4g4puUIE5FVkVSIEEgU0lMRU5UIE1JU1BBUlNFLiBUaGUgZm91clxuICogbm8tZXBvY2ggc3BlbGxzIHVzZWQgYHBhcnNlSW50YCwgd2hpY2ggcmVhZCBhbiBlcG9jaCBib29rbWFyayAoYDRAZTFgLCBmcm9tXG4gKiBhIGhhbmRvZmYgbGluZSBhbm90aGVyIHZlcnNpb24gb3Igc3BlbGwgcHJpbnRlZCkgYXMgYDRgIGFuZCBkcm9wcGVkIHRoZVxuICogcmVzdCB3aXRob3V0IGEgd29yZDsgbWluZC1tYXBwZXIgcmVhZCBqdW5rIGFzIDAgYW5kIGFzdHJvbGFiZSBhcyAtMSwgYm90aCBhXG4gKiB3aG9sZSByZXBsYXkuIEEgcHJpbnRlZCBjb21tYW5kIG91dGxpdmVzIHRoZSBDTEkgdGhhdCBwcmludGVkIGl0ICh0aGVcbiAqIGxhdW5jaGVyLWZyZWUgcnVsaW5nLCBpbiB0aGUgaGVhZGVyKSwgc28gdGhlIHBhcnNlciBpcyB3aGVyZSBhbiBvbGRlciBvclxuICogbmV3ZXIgZm9ybSBtdXN0IHNheSB3aGF0IHdlbnQgd3JvbmcuXG4gKlxuICogYGVwb2NoYDogd2hldGhlciB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBvbmUgKHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUsXG4gKiBtaW5kLW1hcHBlcikuIGBtaW5gOiB0aGUgc21hbGxlc3QgaWQgYWNjZXB0ZWQgKGdyYXBldmluZSB0YWtlcyBubyAtMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkU2luY2UoXG4gIHRva2VuOiBzdHJpbmcsXG4gIG86IHsgZXBvY2g6IGJvb2xlYW47IG1pbj86IG51bWJlciB9LFxuKTogeyBvazogdHJ1ZTsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IHsgb2s6IGZhbHNlOyBtZXNzYWdlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1pbiA9IG8ubWluID8/IC0xO1xuICBjb25zdCBiID0gcGFyc2VCb29rbWFyayh0b2tlbik7XG4gIGlmIChiICE9PSBudWxsICYmIGIuc2luY2UgPj0gbWluICYmIChiLmVwb2NoID09PSB1bmRlZmluZWQgfHwgby5lcG9jaCkpXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNpbmNlOiBiLnNpbmNlLCAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSB9O1xuICBjb25zdCBpZCA9XG4gICAgbWluIDwgMFxuICAgICAgPyBcImFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyOyAtLXNpbmNlPS0xIGZvciBldmVyeXRoaW5nKVwiXG4gICAgICA6IGBhbiBldmVudCBpZCAoYW4gaW50ZWdlciwgJHttaW59IG9yIG1vcmUpYDtcbiAgY29uc3QgZm9ybXMgPSBvLmVwb2NoID8gYCR7aWR9LCBvciA8aWQ+QDxlcG9jaD4gYXMgYSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0YCA6IGlkO1xuICBjb25zdCB3aHkgPVxuICAgICFvLmVwb2NoICYmIHRva2VuLmluY2x1ZGVzKFwiQFwiKVxuICAgICAgPyBgOyB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBubyBlcG9jaCwgc28gcGFzcyB0aGUgaWQgd2l0aG91dCB0aGUgXCJA4oCmXCIgcGFydGBcbiAgICAgIDogXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgbWVzc2FnZTogYC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cyDigJQgZ2l2ZSAke2Zvcm1zfSR7d2h5fWAsXG4gIH07XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogVGhlIHJlLWFybSBmb3IgYSBzcGVsbCB3aG9zZSB0YWlsIGlzIGA8cHJlZml44oCmPiAtLXNpbmNlIE5bQGVwb2NoXSBbLS1vbmNlXWAuXG4gKiAgUGFzcyBgZXBvY2hgIG9ubHkgZm9yIGEgc3BlbGwgd2hvc2UgYC0tc2luY2VgIHBhcnNlcyBpdCAoYHBhcnNlQm9va21hcmtgKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChcbiAgcHJlZml4OiByZWFkb25seSBzdHJpbmdbXSxcbiAgc2luY2U6IG51bWJlcixcbiAgb25jZTogYm9vbGVhbixcbiAgZXBvY2g/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICAvLyDimqAgQSBuZWdhdGl2ZSBib29rbWFyayAobm90aGluZyBzZWVuIHlldCkgaXMgc3BlbGxlZCBgLS1zaW5jZT0tMWA6IHRoZVxuICAvLyBwYXJzZXJzIHJlYWQgYSBiYXJlIGAtMWAgYWZ0ZXIgYSBmbGFnIGFzIGFub3RoZXIgZmxhZyBhbmQgcmVmdXNlIGl0LlxuICBjb25zdCBtYXJrID0gZXBvY2ggPyBgJHtzaW5jZX1AJHtlcG9jaH1gIDogU3RyaW5nKHNpbmNlKTtcbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHttYXJrfWBdIDogW1wiLS1zaW5jZVwiLCBtYXJrXTtcbiAgcmV0dXJuIGNvbW1hbmRMaW5lKFsuLi5wcmVmaXgsIC4uLmF0LCAuLi4ob25jZSA/IFtcIi0tb25jZVwiXSA6IFtdKV0pO1xufVxuXG5leHBvcnQgdHlwZSBIYW5kb2ZmT3B0aW9uczxFdj4gPSB7XG4gIC8qKiBUaGUgc3BlbGwncyBuYW1lLCBjYXJyaWVkIG9uIHRoZSBsaW5lICh3aG9zZSBsYXVuY2hlciBydW5zIGl0KS4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIFdobyB0aGUgY2xvc2luZyBmcmFtZSBzYXlzIGVuZGVkIHRoZSBzZXNzaW9uIChTMSk7IGNhcnJpZWQgb24gYHRhaWwuY2xvc2VkYC4gKi9cbiAgY2xvc2VkQnk/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBXaG8gZW5kZWQgYSBzZXNzaW9uIGZvdW5kIEdPTkUgKEQxOiByZS1hcm1lZCBhZnRlciBpdCBjbG9zZWQsIHNvIG5vXG4gICAqICBjbG9zaW5nIGZyYW1lIGlzIGV2ZXIgc2VlbiksIHJlYWQgZnJvbSB3aGVyZXZlciB0aGUgc3BlbGwga2VlcHMgaXQg4oCUIGFcbiAgICogIG1hbmlmZXN0IHRoYXQgb3V0bGl2ZXMgdGhlIGRhZW1vbi4gQ2FycmllZCBvbiBgdGFpbC5jbG9zZWRgIGFzIGBieWAsIHNvXG4gICAqICB0aGUgbGluZSBzYXlzIHdoYXQgdGhlIGxpdmUgcGF0aCdzIGBjbG9zZWRCeWAgd291bGQgaGF2ZSAoUzEpLiAqL1xuICBnb25lQnk/OiAoKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbW1hbmRzOiBIYW5kb2ZmQ29tbWFuZHM7XG59O1xuXG4vKipcbiAqIFJ1biBgdGFpbEV2ZW50c2Agd2l0aCB0aGUgaGFuZG9mZjogdGhlIHdpbmRvdywgYC0tb25jZWAsIHRoZSBsb3N0IHJ1bGUsIGFuZFxuICogdGhlIGZpbmFsIGxpbmUuIFJldHVybnMgdGhlIGV4aXQgY29kZSwgbGlrZSBgdGFpbEV2ZW50c2AsIGFuZCBuZXZlciBleGl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxXaXRoSGFuZG9mZjxFdj4oXG4gIHRhaWw6IFRhaWxPcHRpb25zPEV2PixcbiAgaDogSGFuZG9mZk9wdGlvbnM8RXY+LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gdGFpbC5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IHdpbmRvd01zID0gaC53aW5kb3dNcyA/PyByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pO1xuICBjb25zdCBjb3VudHMgPSBoLmNvdW50cyA/PyAoKCkgPT4gdHJ1ZSk7XG4gIGNvbnN0IGVuZE9uTG9zdCA9ICFoLnByZXNlbmNlO1xuXG4gIGNvbnN0IGFjID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gYWMuYWJvcnQoKTtcbiAgdGFpbC5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKHRhaWwuc2lnbmFsPy5hYm9ydGVkKSBhYy5hYm9ydCgpO1xuXG4gIGxldCBldmVudHMgPSAwO1xuICBsZXQgY3Vyc29yID0gdGFpbC5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB0YWlsLnNpbmNlRXBvY2g7XG4gIGxldCBmcmFtZUhhc0lkID0gZmFsc2U7XG4gIC8qKiBBMyArIEQzOiBhIGZyYW1lIGNvdW50cywgYW5kIHdha2VzIGEgYC0tb25jZWAsIG9ubHkgd2hlbiBpdCBpcyBPTiBUSEVcbiAgICogIExPRyDigJQgaXQgY2FycmllcyBhIGxvZyBpZCDigJQgYW5kIHRoZSBzcGVsbCdzIG93biBgY291bnRzYCBhZ3JlZXMuIEEgdGFiJ3NcbiAgICogIGlkLWxlc3MgYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGAgcGluZyBpcyBub3Qgb24gdGhlIGxvZy4gKi9cbiAgY29uc3QgaXNMb2dGcmFtZSA9IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gZnJhbWVIYXNJZCAmJiBjb3VudHMoZXYsIGZyYW1lKTtcbiAgbGV0IGVuZDogVGFpbEVuZCB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkQnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlZnVzYWxzID0gMDtcblxuICBjb25zdCBmaW5pc2ggPSAoZTogVGFpbEVuZCkgPT4ge1xuICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IGU7XG4gICAgYWMuYWJvcnQoKTtcbiAgfTtcbiAgY29uc3QgdGltZXIgPVxuICAgIGgubW9kZSA9PT0gXCJ3YXRjaFwiICYmIHdpbmRvd01zID4gMCA/IHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKFwid2luZG93XCIpLCB3aW5kb3dNcykgOiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29kZSA9IGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICAgIC4uLnRhaWwsXG4gICAgICBzaWduYWw6IGFjLnNpZ25hbCxcbiAgICAgIC8vIEQyJ3MgbmV0LiBPbiBmb3IgZXZlcnkgc3BlbGw6IGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvclxuICAgICAgLy8gbWVhbnMgYSB3aG9sZSByZXBsYXkgb24gdGhlIGtpdCdzIGxvZywgYW5kIG9uIGdyYXBldmluZSdzIGR1cmFibGUgbG9nXG4gICAgICAvLyBpdCBoYXBwZW5zIG9ubHkgd2hlbiBgLS1sYXN0YCByZWFjaGVzIGJlbG93IGAtLXNpbmNlYCwgd2hlcmVcbiAgICAgIC8vIHJlLXJlYWRpbmcgdGhlIGN1cnNvciBmcm9tIHRoZSBmcmFtZXMgaXMgdGhlIG1vcmUgY29ycmVjdCBhbnN3ZXIuXG4gICAgICByZXN0YXJ0T25SZXBsYXk6IHRydWUsXG4gICAgICAvLyBEMzogcmVtZW1iZXIgd2hldGhlciBUSElTIGZyYW1lIGNhcnJpZXMgYSBsb2cgaWQuIGB0YWlsRXZlbnRzYCByZWFkc1xuICAgICAgLy8gdGhlIGN1cnNvciBvbmNlIHBlciBmcmFtZSwgYmVmb3JlIGBhY2NlcHRgLCBgdGVybWluYWxgIGFuZCBgcmVuZGVyYC5cbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgY29uc3QgbiA9IHRhaWwuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgIGZyYW1lSGFzSWQgPSB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobik7XG4gICAgICAgIHJldHVybiBuO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBEMTogYSB0YWlsIHRoYXQgZ2l2ZXMgdXAgb24gZmluZGluZyBpdHMgc2Vzc2lvbiBpcyB3YXRjaGluZyBhXG4gICAgICAgIC8vIHNlc3Npb24gdGhhdCBpcyBnb25lIOKAlCB3aGV0aGVyIHRoaXMgcHJvY2VzcyBldmVyIHJlYWNoZWQgaXQgKGl0c1xuICAgICAgICAvLyBwb2ludGVyIHZhbmlzaGVkKSBvciBpdCB3YXMgcmUtYXJtZWQgYXQgb25lIHRoYXQgY2xvc2VkIGluIHRoZSBnYXAuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBlbmQgPT09IG51bGwpIHtcbiAgICAgICAgICBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICAgIGNsb3NlZEJ5ID0gaC5nb25lQnk/LigpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIHtcbiAgICAgICAgICAgIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICAgIGlmIChlbmQgPT09IFwiY2xvc2VkXCIpIGNsb3NlZEJ5ID0gaC5jbG9zZWRCeT8uKGV2KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGgubW9kZSA9PT0gXCJvbmNlXCIgJiYgYWNjZXB0ZWQgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgcmV0dXJuIHRhaWwub25Db21tZW50Py4odGV4dCkgPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLm9uRGlzY29ubmVjdD8uKGluZm8pID8/IG51bGw7XG4gICAgICAgIGlmIChpbmZvLmNhdXNlID09PSBcImNvbm5lY3QtZmFpbGVkXCIpIHtcbiAgICAgICAgICByZWZ1c2FscyArPSAxO1xuICAgICAgICAgIGlmIChlbmRPbkxvc3QgJiYgcmVmdXNhbHMgPj0gTE9TVF9BRlRFUl9SRUZVU0FMUykgZmluaXNoKFwibG9zdFwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUaGUgZGFlbW9uIGFuc3dlcmVkIChhIHN0YXR1cywgb3IgYSBzdHJlYW0gdGhhdCBvcGVuZWQgYW5kIHRoZW5cbiAgICAgICAgICAvLyBlbmRlZCk6IGl0IGlzIGFsaXZlLCBzbyB0aGUgcmVmdXNhbHMgd2VyZSBub3QgaW4gYSByb3cuXG4gICAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIG9uRW5kOiAocykgPT4ge1xuICAgICAgICBjdXJzb3IgPSBzLmN1cnNvcjtcbiAgICAgICAgZXBvY2ggPSBzLmVwb2NoID8/IHVuZGVmaW5lZDtcbiAgICAgICAgdGFpbC5vbkVuZD8uKHMpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaW5lID0gaGFuZG9mZihcbiAgICAgIHtcbiAgICAgICAgZW5kOiBlbmQgPz8gXCJzdG9wcGVkXCIsXG4gICAgICAgIC4uLihjbG9zZWRCeSA/IHsgYnk6IGNsb3NlZEJ5IH0gOiB7fSksXG4gICAgICAgIG1vZGU6IGgubW9kZSxcbiAgICAgICAgZXZlbnRzLFxuICAgICAgICBjdXJzb3IsXG4gICAgICAgIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgcHJlc2VuY2U6IGgucHJlc2VuY2UsXG4gICAgICAgIHNwZWxsOiBoLnNwZWxsLFxuICAgICAgfSxcbiAgICAgIGguY29tbWFuZHMsXG4gICAgKTtcbiAgICBpZiAobGluZSAhPT0gbnVsbCkgb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGxpbmUpfVxcbmApO1xuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0YWlsLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBNaW5kLW1hcHBlcidzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgb2YgdGhlIHNwZWxsLCBhbmQgVEhFIE9ORSBQTEFDRSBUSEUgRU5WIElTIFJFQUQuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBUSEUgU0VBTSwgQU5EIEZPUiBNSU5ELU1BUFBFUiBUSEUgU0VBTSBXQVMgUkVBTCBBTkRcbiAqIEhBTkQtTUlSUk9SRUQuIEJlZm9yZSBQaGFzZSA3IHRoZSBrZWVwYWxpdmUgd2FzIGEgbGl0ZXJhbCBgMTVfMDAwYCBpbnNpZGVcbiAqIGBzZXJ2ZXIudHNgJ3MgYGtlZXBhbGl2ZU1zKClgLCBgaWRsZVRpbWVvdXQ6IDI1NWAgd2FzIGEgc2Vjb25kIGxpdGVyYWwgYVxuICogaHVuZHJlZCBsaW5lcyBhd2F5IHdpdGggdGhlIHJlbGF0aW9uc2hpcCB3cml0dGVuIG9ubHkgaW4gcHJvc2UsIGFuZCB0aGVcbiAqIENMSSdzIHRhaWwgY2FycmllZCBhIEhBUkQtQ09ERUQgYDQ1XzAwMGAgd2F0Y2hkb2cgdW5kZXIgYSBjb21tZW50IHNheWluZ1xuICogXCLiiYggMyBtaXNzZWQgc2VydmVyIGtlZXBhbGl2ZXMgKDE1cyB0aWNrLCBDbGFpbSBGKVwiIOKAlCB0aHJlZSBudW1iZXJzLCB0d29cbiAqIGZpbGVzLCBhbmQgdGhlIGFyaXRobWV0aWMgdHlpbmcgdGhlbSB0b2dldGhlciBsaXZpbmcgaW4gYSBzZW50ZW5jZS4gTmVpdGhlclxuICogZmlsZSBjb3VsZCBpbXBvcnQgdGhlIG90aGVyOiB0aGUgQ0xJIHJlYWNoaW5nIGludG8gdGhlIGRhZW1vbiB3b3VsZCBkcmFnIHRoZVxuICogd2hvbGUgMjMtbW9kdWxlIHNlcnZlciBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIEEgbW9kdWxlIHdob3NlIG9ubHkgaW1wb3J0c1xuICogYXJlIHRoZSBraXQncyBkZXJpdmF0aW9ucyBoYXMgbm8gc3VjaCBncmFwaCwgc28gYm90aCBoYWx2ZXMgaW1wb3J0IHRoaXMgb25lLlxuICogKipBIHZhbHVlIHRoYXQgY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQqKiwgYW5kIHRoZVxuICogXCLiiYhcIiBpbiB0aGF0IGNvbW1lbnQgaXMgbm93IGFuIGA9YC5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFdBVENIRE9HIElTIERFUklWRUQgRlJPTSBNSU5ELU1BUFBFUidTIE9XTiBIRUFSVEJFQVQsIE5FVkVSXG4gKiBDT1BJRUQgRlJPTSBBIFNJQkxJTkcuKiogVGhpcyBpcyB0aGUgcnVsZSBhc3Ryb2xhYmUgcGFpZCBmb3I6IGEgaGFyZC1jb2RlZFxuICogNDUgcyB3YXRjaGRvZyBhZ2FpbnN0IGFuIGVudi10dW5lZCBoZWFydGJlYXQgcHJvZHVjZWQgcmVjb25uZWN0cyBhdCArNDcuNCBzLFxuICogKzkyLjYgcyBhbmQgKzEzNy45IHMgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbiwgaGFybWxlc3Mgb25seVxuICogYmVjYXVzZSBhbiB1bnJlbGF0ZWQgdGhpcmQgY29uc3RhbnQgYWJzb3JiZWQgdGhlIGNodXJuLiDimqAgTWluZC1tYXBwZXIgaXMgdGhlXG4gKiBzcGVsbCB0aGF0IHdhcyBPTkUgRU5WIFZBUiBhd2F5IGZyb20gdGhhdCBleGFjdCBkZWZlY3Q6IGl0cyBrZWVwYWxpdmUgYWxyZWFkeVxuICogdG9vayBgTUlORF9NQVBQRVJfS0VFUEFMSVZFX01TYCAoaXRzIG93biBwcmVzZW5jZSBzdWl0ZSBkcml2ZXMgaXQgYXQgMjUgbXMpXG4gKiB3aGlsZSB0aGUgd2F0Y2hkb2cgd2FzIGEgbGl0ZXJhbCwgc28gYW55IGtlZXBhbGl2ZSBhYm92ZSAxNSBzIGFscmVhZHkgYnJva2VcbiAqIGV2ZXJ5IHRhaWwgYW5kIGFueSBrZWVwYWxpdmUgYmVsb3cgaXQgbWFkZSB0aGUgd2F0Y2hkb2cgdG9sZXJhdGUgZmFyIG1vcmVcbiAqIHRoYW4gdGhyZWUgbWlzc2VkIGJlYXRzLiBgdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKWAgY2Fubm90IGRyaWZ0IGZyb20gdGhlXG4gKiBiZWF0IGl0IGlzIHdhdGNoaW5nLCB3aGF0ZXZlciB0aGUgYmVhdCBiZWNvbWVzLlxuICpcbiAqIOKblCAqKlRIRSBFTlYgSVMgUkVTT0xWRUQgSEVSRSBBTkQgTk9XSEVSRSBFTFNFIChENzUpLCBBTkQgRk9SIFRISVMgU1BFTEwgVEhBVFxuICogUlVMRSBJUyBMT0FELUJFQVJJTkcgUkFUSEVSIFRIQU4gVElEWS4qKiBHcmFwZXZpbmUncyBwb3J0IHNoaXBwZWQgdGhlIGJlYXQnc1xuICoga25vYiBpbiBgZGFlbW9uLnRzYCBhbmQgbGVmdCBpdHMgc2VhbSBmaWxlIGRlcml2aW5nIHRoZSB3YXRjaGRvZyBmcm9tIHRoZVxuICogTElURVJBTCBkZWZhdWx0OiB0aGUgZGFlbW9uJ3MgYmVhdCB3YXMgdHVuYWJsZSBhbmQgdGhlIENMSSdzIHdhdGNoZG9nIHdhc1xuICogbm90LCBhbmQgYW55IHZhbHVlIGFib3ZlIHRoZSBkZWZhdWx0IGJyb2tlIGV2ZXJ5IHRhaWwg4oCUIGludmlzaWJsZSBhdCB0aGVcbiAqIGRlZmF1bHQsIHdoaWNoIGlzIHdoeSBpdCBzaGlwcGVkLiBUaGUgZ2VuZXJhbGlzYXRpb246ICoqYW4gZW52IGtub2IgbXVzdCBiZVxuICogcmVzb2x2ZWQgYXQgdGhlIExPV0VTVCBwb2ludCBldmVyeSBjb25zdW1lciBvZiB0aGUgZGVyaXZlZCB2YWx1ZSBjYW4gc2VlLioqXG4gKiBgcHJvY2Vzcy5lbnZgIGlzIGFtYmllbnQgaW4gYm90aCBoYWx2ZXMsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IHRoaXMgZmlsZSDigJQgYW5kXG4gKiBub3QgYHNlcnZlci50c2Ag4oCUIGNhbiBob2xkIHRoZSByZXNvbHV0aW9uLCBhbmQgcmVhZGluZyBpdCBoZXJlIGlzIG5vdCB0aGVcbiAqIGtpbmQgb2YgaW1wb3J0IHRoYXQgY2xvc2VzIHRoZSBzZWFtLlxuICpcbiAqIOKblCAqKkFORCBUSEUgREVSSVZBVElPTiBTVVBQTElFUyBUSEUgREVGQVVMVCwgTk9UIFRIRSBWQUxVRSAoRDgyKS4qKiBUaGUgdHdvXG4gKiB0YWlsIGtub2JzIGJlbG93IGFyZSB0aGUgcmVhc29uOiBgYmFja2VuZC90YWlsLnRlc3QudHNgIGlzIHRoZSByZXBvJ3MgT05MWVxuICogZXhlY3V0YWJsZSB0YWlsIHNwZWNpZmljYXRpb24sIGl0IGlzIHRoaXMgcG9ydCdzIE9SQUNMRSwgYW5kIGFsbCBmb3VyIG9mIGl0c1xuICogY2VsbHMgZHJpdmUgYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NUz0yMDBgIC8gYE1JTkRfTUFQUEVSX1RBSUxfUkVUUllfTVM9NTBgLlxuICogV3JpdHRlbiBnbGFtb3VyJ3Mgd2F5IOKAlCB0aHJlZSBwbGFpbiBgZXhwb3J0IGNvbnN0YHMgd2l0aCBubyBvdmVycmlkZSBhbnl3aGVyZVxuICog4oCUIHRoZSBpZGxlLXdhdGNoZG9nIGNlbGwgRkFJTFMgKGEgNDUsMDAwIG1zIHdhdGNoZG9nIGNhbm5vdCBmaXJlIGluc2lkZSBpdHNcbiAqIDUgcyBkZWFkbGluZSwgYW5kIGl0IHJlYWRzIGFzIGEgYnJva2VuIHdhdGNoZG9nKSBhbmQgdGhlIGtlZXBhbGl2ZSBjZWxsXG4gKiAqKlBBU1NFUyBWQUNVT1VTTFkqKjogaXQgYXNzZXJ0cyB0aGF0IG5vdGhpbmcgd2FzIGFib3J0ZWQsIGFuZCA0NSBzIGNhbm5vdFxuICogYWJvcnQgYW55dGhpbmcgaW5zaWRlIGl0cyA4MDAgbXMgd2luZG93LiBBIGdyZWVuIGNlbGwgdGhhdCBsb3N0IGl0cyBzdWJqZWN0XG4gKiBpcyB3b3JzZSB0aGFuIGEgcmVkIG9uZS4g4pqgIEFuZCB0aGUga25vYiBjYW5ub3QgYmUgcm91dGVkIHRocm91Z2ggdGhlIEJFQVRcbiAqIGluc3RlYWQ6IHRoZSBraXQgZmxvb3JzIGBoZWFydGJlYXRNc2AgYXQgYE1JTl9IRUFSVEJFQVRfTVMgPSA1MDBgIChENzYg4oCUIHRoZVxuICogZmxvb3IgbGl2ZXMgYXQgdGhlIGRlcml2YXRpb24pLCBzbyB0aGUgc21hbGxlc3Qgd2F0Y2hkb2cgcmVhY2hhYmxlIHRocm91Z2hcbiAqIGB0YWlsSWRsZU1zYCBpcyAxLDUwMCBtcyBhbmQgKioyMDAgbXMgaXMgdW5yZWFjaGFibGUgdGhhdCB3YXkgYnlcbiAqIGNvbnN0cnVjdGlvbi4qKiBgdGFpbElkbGVNc2AgY2FycmllcyBubyBmbG9vciBvZiBpdHMgb3duLCBzbyBhIGRpcmVjdFxuICogb3ZlcnJpZGUgcmVhY2hlcyBpdC5cbiAqXG4gKiDimqAgKipUaGUgbWFwcGluZyBiZWxvdyB3YXMgd3JpdHRlbiBlaWdodCBtb250aHMgZWFybHkgYW5kIGFkZHJlc3NlZCB0b1xuICogbm9ib2R5Kiog4oCUIGBwaGFzZS0xLWpvdXJuYWwubWQ6MTUxLTE1NWAgbmFtZWQgYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2Ag4oaSXG4gKiBgaWRsZU1zYCBhbmQgYE1JTkRfTUFQUEVSX1RBSUxfUkVUUllfTVNgIOKGkiBgcmV0cnkuaW5pdGlhbE1zYCBhbmQgY29uY2x1ZGVkXG4gKiBcImEgc3BlbGwgd2hvc2UgdGVzdHMgZHJpdmUgYSBzaG9ydCB3aW5kb3cgd2lsbCBuZWVkIG9uZSwgYW5kIGl0IHNob3VsZCBiZVxuICogdGhhdCBzcGVsbCdzIGVudiB2YXIsIG5vdCB0aGUga2l0J3NcIi4gVGhpcyBpcyB0aGF0IHNwZWxsIChEODQpLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgdGhlIENMSSBpcyBiYWNrIHRvIGRyYWdnaW5nIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgaGVhcnRiZWF0TXMsXG4gIGlkbGVUaW1lb3V0U2VjLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKipcbiAqIEEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgb3IgdGhlIGZhbGxiYWNrLlxuICpcbiAqIOKaoCBUSEUgS0lUJ1MgYGludE9yYCBJUyBOT1QgRVhQT1JURUQsIGRlbGliZXJhdGVseSDigJQgaXQgaXMgdGhlIHByaXZhdGUgcGFyc2VyXG4gKiBiZWhpbmQgYGhlYXJ0YmVhdE1zYC9gaWRsZVRpbWVvdXRTZWNgLCBhbmQgRDc2IHJ1bGVkIHRoYXQgYSBrbm9iIHdpdGggYSBrbm93blxuICogc2FmZSBtaW5pbXVtIGNsYW1wcyBhdCBpdHMgREVSSVZBVElPTiByYXRoZXIgdGhhbiBpbiB0aGUgc2hhcmVkIHBhcnNlci4gU29cbiAqIHRoaXMgaXMgbWluZC1tYXBwZXIncyBvd24gY29weSBvZiB0aGUgc2FtZSB0aHJlZSBsaW5lcywgd2l0aCB0aGUgc2FtZVxuICogYHBhcnNlSW50YCBzZW1hbnRpY3MgdGhlIGtpdCBkb2N1bWVudHMgKGBcIjFlOVwiYCBpcyAxLCBgXCI1YWJjXCJgIGlzIDUpIGFuZCB0aGVcbiAqIHNhbWUgXCJhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUgdGFrZXMgdGhlIGZhbGxiYWNrXCIgcnVsZS5cbiAqIEl0IGlzIHRoZSBleHByZXNzaW9uIHRoZSBDTEkncyBvd24gYGVudk1zYCB1c2VkIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZC5cbiAqXG4gKiDim5QgQU5EIFRIRSBUV08gVEFJTCBLTk9CUyBCRUxPVyBERUxJQkVSQVRFTFkgSEFWRSBOTyBGTE9PUi4gQSB3YXRjaGRvZyBhbmQgYVxuICogcmVjb25uZWN0IGRlbGF5IGFyZSB0aGUgdHdvIHZhbHVlcyB0aGlzIHNwZWxsJ3Mgb3duIHRlc3Qgc3VpdGUgbXVzdCBiZSBhYmxlXG4gKiB0byBkcml2ZSBET1dOIHRvIDIwMCBtcyBhbmQgNTAgbXM7IGEgZmxvb3IgaGVyZSB3b3VsZCBtYWtlIHRoZSBvcmFjbGVcbiAqIHVucmVhY2hhYmxlLCB3aGljaCBpcyB0aGUgZGVmZWN0IEQ4MiB3YXMgd3JpdHRlbiBhYm91dC4gVGhlIGZsb29yIGV4aXN0c1xuICogd2hlcmUgdGhlIGZsb29kIHJpc2sgaXMg4oCUIG9uIHRoZSBCRUFULCBpbiB0aGUga2l0LlxuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqXG4gKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIE1pbmQtbWFwcGVyJ3Mgb3duIG1lYXN1cmVkIHZhbHVlLFxuICogbm90IGFuIGluaGVyaXRlZCBvbmU6IGBzZXJ2ZXIudHNgIGNhcnJpZWQgYGlkbGVUaW1lb3V0OiAyNTVgIHVuZGVyIGEgY29tbWVudFxuICogcmVjb3JkaW5nIHRoYXQgU1NFIGFuZCBXUyBjb25uZWN0aW9ucyBvbiBgL2V2ZW50c2Agc2l0IGlkbGUgYmV0d2VlbiBlbWl0cyBieVxuICogZGVzaWduLCB0aGF0IEJ1bidzIGRlZmF1bHQgMTAgcyB3b3VsZCByZXNldCBhIHF1aWV0IHN0cmVhbSwgYW5kIHRoYXQgYDBgIGlzXG4gKiBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBzdGFsbHMgdGhlIGluaXRpYWwgcmVzcG9uc2Ug4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhXG4gKiBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS5cbiAqXG4gKiDimqAgYE1JTkRfTUFQUEVSX0lETEVfVElNRU9VVF9TRUNgIGlzIGFjY2VwdGVkIHNvIHRoZSBQQUlSIGNhbiBiZSB0dW5lZFxuICogdG9nZXRoZXIsIGFuZCB0aGUgY2xhbXAgaW4gYGhlYXJ0YmVhdE1zYCBiZWxvdyBpcyB3aGF0IGtlZXBzIHRoZW0gYSBwYWlyLlxuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IGlkbGVUaW1lb3V0U2VjKFxuICBwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9JRExFX1RJTUVPVVRfU0VDLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbik7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGFuZCBtaW5kLW1hcHBlcidzIG93biBsaXRlcmFsIChDbGFpbSBGJ3MgMTUgc1xuICogIHRpY2spIGJlZm9yZSB0aGlzIGZpbGUgZXhpc3RlZCDigJQgdGhlIERFRkFVTFQsIGJlZm9yZSB0aGUgZW52IGlzIGNvbnN1bHRlZC4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqXG4gKiBUaGUgU1NFIGtlZXBhbGl2ZSwgaW4gbXMsIGVudi1yZXNvbHZlZCBhbmQgY2xhbXBlZCBhdCBib3RoIGVuZHMgYnkgdGhlIGtpdDpcbiAqIG5ldmVyIGFib3ZlIGBJRExFX1RJTUVPVVRfU0VDIC8gMmAgKG9yIEJ1biBjbG9zZXMgdGhlIGNvbm5lY3Rpb24gdGhlXG4gKiBrZWVwYWxpdmUgd2FzIHByZXNlcnZpbmcpLCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICog4puUIFRIRSBGTE9PUiBJUyBOT1QgREVDT1JBVElPTiAoRDc2KS4gYE1JTkRfTUFQUEVSX0tFRVBBTElWRV9NU2AgaXMgYSBrbm9iXG4gKiBtaW5kLW1hcHBlcidzIG93biBwcmVzZW5jZSBzdWl0ZSBkcml2ZXMsIGFuZCBgcGFyc2VJbnRgIHJlYWRzIGBcIjFlOVwiYCDigJQgdGhlXG4gKiBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXQgaHVnZVwiIOKAlCBhcyAqKjEqKi4gRHJpdmVuIGF0IGdyYXBldmluZSdzXG4gKiByZXBhaXIgYmVmb3JlIHRoZSBmbG9vciBleGlzdGVkOiBhIDEgbXMgYmVhdCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50b1xuICogZXZlcnkgb3BlbiBTU0UgY2xpZW50IGluIDUyOCBtcy5cbiAqXG4gKiDimqAgQU5EIEZPUiBUSElTIFNQRUxMIFRIRSBCRUFUIEFMU08gQk9VTkRTIEEgSFVNQU4tVklTSUJMRSBOVU1CRVIuIFByZXNlbmNlXG4gKiAoQ2xhaW0gQykgaXMgY291bnRlZCBhdCBTU0Ugc3Vic2NyaWJlL3Vuc3Vic2NyaWJlIGFuZCBhIGRlYWQgc29ja2V0IGlzIG9ubHlcbiAqIHJlY2xhaW1lZCB3aGVuIHRoZSBuZXh0IGtlZXBhbGl2ZSB3cml0ZSBmYWlscywgc28gcmFpc2luZyB0aGlzIGtub2IgbWFrZXMgdGhlXG4gKiBhZ2VudCBjb3VudCBpbiB0aGUgYm9hcmQncyBhY3Rpdml0eSBpbmRpY2F0b3Igc3RhbGVyLCBub3QganVzdCBxdWlldGVyLlxuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IGhlYXJ0YmVhdE1zKFxuICBwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9LRUVQQUxJVkVfTVMsXG4gIElETEVfVElNRU9VVF9TRUMsXG4gIERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyxcbik7XG5cbi8qKlxuICogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cywgREVSSVZFRC4gNDUsMDAwIG1zIGF0IHRoZSBkZWZhdWx0IOKAlFxuICogd2hpY2ggaXMgdGhlIG51bWJlciBgY2xpLnRzYCB1c2VkIHRvIGhhcmQtY29kZSwgc28gdGhlIHBvcnQgY2hhbmdlcyBub1xuICogZGVmYXVsdCB3aGlsZSBtYWtpbmcgdGhlIHJlbGF0aW9uc2hpcCB0cnVlIGF0IGV2ZXJ5IG90aGVyIHZhbHVlLlxuICpcbiAqIOKblCBERVJJVkVEIEZST00gVEhFIFJFU09MVkVEIEJFQVQsIE5FVkVSIEZST00gVEhFIERFRkFVTFQg4oCUIGdyYXBldmluZSdzXG4gKiByZXBhaXIgY2hhcHRlciBpcyB3aGF0IHRoZSBkaWZmZXJlbmNlIGNvc3QuIEFuZCB0aGUgZW52IG92ZXJyaWRlIGlzIHRoZVxuICogRkFMTEJBQ0sncyByZXBsYWNlbWVudCwgbm90IHRoZSBkZXJpdmF0aW9uJ3M6IHRoZSBkZXJpdmF0aW9uIGlzIHdoYXQgdGhlIGtub2JcbiAqIGZhbGxzIGJhY2sgdG8sIHNvIGFuIHVudHVuZWQgdGFpbCBzdGlsbCB3YXRjaGVzIHRocmVlIG9mIHRoaXMgZGFlbW9uJ3MgYmVhdHMuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSBpbnRPcihcbiAgcHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfVEFJTF9JRExFX01TLFxuICB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpLFxuKTtcblxuLyoqXG4gKiBUaGUgcmVjb25uZWN0IGJhY2tvZmYncyBGSVJTVCBkZWxheSwgaW4gbXMuIDEsMDAwIHRvZGF5LCB3aGljaCBpcyB3aGF0XG4gKiBgY2xpLnRzYCdzIGByZXRyeU1zYCBkZWZhdWx0ZWQgdG8uXG4gKlxuICog4puUIEFORCBUSEUgU0hBUEUgQ0hBTkdFUyBFVkVOIFRIT1VHSCBUSEUgTlVNQkVSIERPRVMgTk9UOiB0aGUgaGFuZC1yb2xsZWRcbiAqIGxvb3Agc2xlcHQgdGhpcyBsb25nIGFmdGVyIEVWRVJZIGZhaWxlZCBhdHRlbXB0LCBmbGF0LCBmb3JldmVyIOKAlCBhXG4gKiBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0sIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGxcbiAqIGB0YWlsRXZlbnRzYCdzIG93biB3YXJuaW5nIGFib3V0IHRoYXQgYnJhbmNoIHdhcyB3cml0dGVuIGFib3V0LiBUaGUga2l0XG4gKiBkb3VibGVzIGl0IHRvIGBtYXhNc2AgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbiwgc28gYSBkZWFkIGRhZW1vbiBpc1xuICogYmFja2VkIG9mZiBmcm9tIGluc3RlYWQgb2YgaGFtbWVyZWQuXG4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX1JFVFJZX01TID0gaW50T3IocHJvY2Vzcy5lbnYuTUlORF9NQVBQRVJfVEFJTF9SRVRSWV9NUywgMV8wMDApO1xuXG4vKiogVGhlIGJhY2tvZmYgY2VpbGluZywgdGhlIGtpdCdzIGRlZmF1bHQsIHN0YXRlZCBoZXJlIHNvIGJvdGggaGFsdmVzIGNhbiBzZWVcbiAqICB0aGUgd2hvbGUgcmV0cnkgc2hhcGUgaW4gb25lIHBsYWNlIHJhdGhlciB0aGFuIGhhbGYgb2YgaXQuICovXG5leHBvcnQgY29uc3QgVEFJTF9SRVRSWV9NQVhfTVMgPSA1XzAwMDtcbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUE4R0E7QUFDQTtBQUNBO0FBQ0E7OztBQ3pDQTs7O0FDakRPLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBaUNBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQUdaLFNBQVMsaUJBQWlCLEdBQWtCO0FBQUEsRUFDakQsT0FBTztBQUFBO0FBU0YsU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUVJLE9BQU8sUUFBUSxFQUFFLE9BQU8sTUFBTSxNQUFNLElBQUksQ0FBQztBQUFBLFNBQ3pDLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8sVUFBVSxFQUFFLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQztBQUFBLFNBRS9DLE9BQU8sV0FBVyxZQUFZLEVBQUUsUUFBUSxNQUFNLE9BQU8sSUFBSSxDQUFDO0FBQUEsSUFDaEU7QUFBQSxJQUNBLE1B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QUFJLE9BQU87QUFBQSxJQUN4QixVQUFVO0FBQUEsSUFDVixLQUFLLEdBQUcsV0FBVztBQUFBLEVBQ3JCO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLFFBQVEsUUFBUSxVQUFVLGFBQWEsU0FBUyxTQUFTLFNBQVM7QUFBQSxJQUMxRSxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxPQUFPLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDL0QsVUFBVTtBQUFBLElBQ1YsS0FBSyxHQUFHLE9BQU87QUFBQSxFQUNqQjtBQUNGO0FBTU8sSUFBTSxNQUFNLFVBQVU7QUFBQSxFQUMzQixNQUFNO0FBQUEsRUFDTixTQUFTO0FBQUEsRUFDVCxVQUFVO0FBQUEsRUFHVixTQUFTO0FBQUEsRUFJVCxRQUFRLEVBQUUsS0FBSyxFQUFFLFdBQVcsbUJBQW1CLEVBQUU7QUFBQSxFQUNqRCxTQUFTO0FBQUEsRUFDVCxNQUFNLE1BQU07QUFDZCxDQUFDO0FBS00sSUFBTSxRQUEyQixJQUFJO0FBQ3JDLElBQU0sWUFBK0MsT0FBTyxZQUNqRSxJQUFJLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FDMUM7QUFDTyxJQUFNLG1CQUFzQyxJQUFJO0FBb0J2RCxlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxJQUFJLFNBQVMsSUFBSTtBQUFBLElBQzlCLE9BQU8sR0FBRztBQUFBLElBQ1YsTUFBTSxXQUFXLGVBQWUsQ0FBQztBQUFBLElBQ2pDLElBQUksYUFBYTtBQUFBLE1BQU0sT0FBTztBQUFBLElBQzlCLE1BQU0sT0FDSixLQUFLLE9BQU8sTUFBTSxZQUFZLFVBQVUsSUFBSSxPQUFRLEVBQXdCLElBQUksSUFBSTtBQUFBLElBQ3RGLE1BQU0sTUFBTSxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLElBRXJELElBQUksYUFBYTtBQUFBLE1BQWEsT0FBTyxZQUFZLGlCQUFpQixLQUFLO0FBQUEsSUFFdkUsSUFBSSxTQUFTO0FBQUEsTUFBVSxPQUFPLFlBQVksR0FBRztBQUFBLElBRzdDLFFBQVEsT0FBTyxNQUFNLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFBQSxJQUNuRCxPQUFPLFNBQVM7QUFBQTtBQUFBO0FBOEJwQixlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJGRTlGMTZDRTgwODM4NTMxNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
