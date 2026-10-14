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
  realpathSync,
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
function endedBy(id) {
  try {
    const m = JSON.parse(readFileSync(join(scriptoriumHome(), "sessions", id, "manifest.json"), "utf8"));
    return typeof m.ended?.by === "string" ? m.ended.by : undefined;
  } catch {
    return;
  }
}
function noSession(session) {
  const ids = restorable();
  const id = session ?? ids[0];
  if (id === undefined)
    return {
      message: "no running scriptorium session",
      extra: { hint: "no session has been opened in this home yet \u2014 run: cli.ts open <path>" }
    };
  if (!ids.includes(id))
    return {
      message: `no scriptorium session ${id} in this home`,
      extra: {
        hint: ids.length === 0 ? "no saved sessions in this home \u2014 run: cli.ts open <path>" : "pass --session one of the saved sessions, or drop it for the most recent",
        choices: ids.slice(0, 10)
      }
    };
  if (endedBy(id) === "human")
    return {
      message: `the human ended session ${id}`,
      extra: {
        hint: `the human ended this session on purpose; do not reopen it unless they ask. If they ask: cli.ts open --restore ${id}`
      }
    };
  return {
    message: `no running scriptorium session ${id}`,
    extra: {
      hint: `no daemon is running for session ${id}, but its work is on disk \u2014 bring it back with: cli.ts open --restore ${id}`,
      choices: ids.slice(0, 10)
    }
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
  if (!s) {
    const { message, extra } = noSession(session);
    die(message, "not_found", extra);
  }
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
function defaultWorkspace(paths, cwd) {
  const distinct = new Map;
  for (const p of paths) {
    const key = realpathSync(p);
    if (!distinct.has(key))
      distinct.set(key, p);
  }
  const only = distinct.size === 1 ? [...distinct.values()][0] : undefined;
  if (only !== undefined && statSync(only).isDirectory())
    return only;
  return cwd;
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
    daemonArgs.push("--workspace", defaultWorkspace(paths, process.cwd()));
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
async function readProse(verb, pos, flags, o = {}) {
  const sources = [
    pos.length > 0,
    flags.stdin === true,
    typeof flags["body-file"] === "string"
  ].filter(Boolean).length;
  if (sources === 0 && o.optional)
    return;
  if (sources !== 1)
    die(sources === 0 ? `${verb} needs a message` : o.optional ? `${verb} takes its body from one place: --stdin or --body-file, not both` : `${verb} takes its message from exactly one place: arguments, --stdin or --body-file`, "usage", {
      hint: o.optional ? "give the text through --body-file <path> or --stdin (never an unquoted heredoc)" : "give the text as arguments, or prose through --body-file <path> / --stdin (never an unquoted heredoc)",
      choices: ["--stdin", "--body-file"]
    });
  let text;
  if (flags.stdin === true)
    text = await new Response(Bun.stdin.stream()).text();
  else if (typeof flags["body-file"] === "string") {
    const path = flags["body-file"];
    if (!existsSync(path))
      die(`${verb}: --body-file not found: ${path}`, o.missingFile ?? "usage");
    if (statSync(path).isDirectory())
      die(`${verb}: --body-file is a directory, not a file: ${path}`, "usage", {
        hint: "pass the path of the file that holds the text"
      });
    try {
      text = readFileSync(path, "utf8");
    } catch {
      die(`${verb}: --body-file cannot be read: ${path}`, "usage", {
        hint: "check that the file's permissions let you read it, or pass another file"
      });
    }
  } else
    text = pos.join(" ");
  if (!text.trim())
    die(o.optional ? `${verb}: the body is empty` : `${verb}: the message is empty`, "usage", o.optional ? { hint: `drop --body-file/--stdin to copy the source version instead` } : {});
  return text;
}
async function readSayBody(pos, flags, verb) {
  return (await readProse(verb, pos, flags) ?? "").trim();
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
    closedBy: (ev) => typeof ev.by === "string" ? ev.by : undefined,
    goneBy: () => boundId !== undefined ? endedBy(boundId) : undefined,
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
    describe: "spawn a session (opens the browser), adding paths; prints {url, port, session_id, workspace}; the workspace is the one folder given, else the current folder. --timeout <seconds> sets the idle close (default 1800); --timeout 0 stands until closed",
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
    flags: [...SESSION, "doc", "from", "label", "stdin", "body-file"],
    positionals: [],
    describe: "propose a new version holding your text (--body-file <path> or --stdin); without one, copies a version (default: the active one) and prints its path to edit",
    run: async (_pos, flags, session) => {
      const from = typeof flags.from === "string" ? parseVersion(flags.from, "--from") : undefined;
      const text = await readProse("version-new", [], flags, {
        optional: true,
        missingFile: "not_found"
      });
      printJson(await postCmd(session, {
        type: "version.new",
        ...typeof flags.doc === "string" ? { doc: docArg(flags.doc) } : {},
        ...from !== undefined ? { from } : {},
        ...typeof flags.label === "string" ? { label: flags.label } : {},
        ...text !== undefined ? { text } : {}
      }));
    }
  },
  {
    name: "say",
    flags: [...SESSION, "stdin", "body-file"],
    positionals: [{ name: "text", required: false, variadic: true }],
    describe: "post a chat message from the agent (prose: --body-file <path> or --stdin)",
    run: async (pos, flags, session) => {
      printJson(await postCmd(session, { type: "say", text: await readSayBody(pos, flags, "say") }));
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
      printJson(await postCmd(session, { type: "task.start", text: await readSayBody(pos, flags, "task") }));
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
        body: await readSayBody(pos, flags, "note"),
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
        body: await readSayBody(pos.slice(1), flags, "note-edit"),
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
  defaultWorkspace,
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

//# debugId=018768D62D06EFC164756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgKHRoZSBraXQgcmVnaXN0cnkgZGlzcGF0Y2hlcyksIG5vbmUgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAuIFRoZVxuICogc3dhbGxvd2luZyBjYXRjaGVzIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2AsIGBwb3N0Q21kYCdzIGNsb3NlXG4gKiBFQ09OTlJFU0VUKSBjb250YWluIG5vIGRpZS1yZWFjaGFibGUgY2FsbC5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHR5cGUgQ29tbWFuZFNwZWMsIGRlZmluZUNsaSwgdHlwZSBJbnZvY2F0aW9uIH0gZnJvbSBcIi4uLy4uL2tpdC9jbGkvcmVnaXN0cnlcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuaW1wb3J0IHsgQ2xpRXJyb3IsIGRpZSwgdHlwZSBFcnJFeHRyYSwgdHlwZSBFcnJLaW5kLCByZXBvcnRDbGlFcnJvciB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRMaW5lLFxuICByZWFkU2luY2UsXG4gIHRhaWxDb21tYW5kLFxuICB0YWlsV2l0aEhhbmRvZmYsXG4gIFdJTkRPV19IRUxQLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEhhbmRvZmZcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgRE9DX0VYVEVOU0lPTlMsIGlzRG9jTmFtZSB9IGZyb20gXCIuL3RyZWVcIjtcblxuLy8g4pqgIERFQ0xBUkVEIEZJUlNULCBBQk9WRSBFVkVSWSBPVEhFUiBGVU5DVElPTiwgT04gUFVSUE9TRS4gVGhlIGBjaG9pY2VzYFxuLy8gY2Vuc3VzJ3MgcmFpc2VyIHJ1bGUgKGEpIChgZ3JpbW9pcmUvbGliL2Vycm9yLXNpdGVzLnRzYCkgbWF0Y2hlc1xuLy8gYGZ1bmN0aW9uIE5BTUUoYCBsYXppbHkgdXAgdG8gdGhlIG5leHQgYCk6IG5ldmVyYCB3aXRoaW4gNjAwIGNoYXJhY3RlcnMsIHNvXG4vLyBBTlkgZnVuY3Rpb24gZGVjbGFyZWQgc2hvcnRseSBhYm92ZSB0aGlzIG9uZSDigJQgYGFwaWAsIHRoZW4gYHJlcXVpcmVTZXNzaW9uYCDigJRcbi8vIHdhcyByZWFkIGFzIGEgcmFpc2VyIGFuZCBpdHMgY2FsbHMgY291bnRlZCBhcyByYWlzZSBzaXRlcyAoZm91bmQgMjAyNi0wOS0xMSxcbi8vIHJlcG9ydGVkIGluIHRoZSBzbGljZS1BIGpvdXJuYWwgYXMgYW4gaW5zdHJ1bWVudCBkZWZlY3QsIG5vdCBmaXhlZCBoZXJlKS5cbmZ1bmN0aW9uIGRhZW1vblJlZnVzZWQod2hhdDogc3RyaW5nLCBzdGF0dXM6IG51bWJlciwgZGF0YTogdW5rbm93bik6IG5ldmVyIHtcbiAgY29uc3Qga2luZDogRXJyS2luZCA9XG4gICAgc3RhdHVzID09PSA0MDBcbiAgICAgID8gXCJ1c2FnZVwiXG4gICAgICA6IHN0YXR1cyA9PT0gNDA0XG4gICAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgICA6IHN0YXR1cyA9PT0gNDA5XG4gICAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgICA6IFwiaW50ZXJuYWxcIjtcbiAgY29uc3QgYm9keSA9IChkYXRhID8/IHt9KSBhcyB7IGVycm9yPzogdW5rbm93bjsgY2hvaWNlcz86IHVua25vd247IGhpbnQ/OiB1bmtub3duIH07XG4gIGNvbnN0IGNob2ljZXMgPSBBcnJheS5pc0FycmF5KGJvZHkuY2hvaWNlcykgPyBib2R5LmNob2ljZXMubWFwKFN0cmluZykgOiB1bmRlZmluZWQ7XG4gIC8vIOKaoCBUaGUgZGFlbW9uJ3Mgb3duIGhpbnQsIGZvcndhcmRlZC4gQSByZWZ1c2FsIHRoYXQga25vd3Mgd2hhdCB0byBkbyBuZXh0XG4gIC8vIHVzZWQgdG8gZHJvcCB0aGF0IGtub3dsZWRnZSBvbiB0aGUgZmxvb3IgYXQgdGhpcyBsaW5lLlxuICBjb25zdCBoaW50ID0gdHlwZW9mIGJvZHkuaGludCA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuaGludCA6IHVuZGVmaW5lZDtcbiAgZGllKHR5cGVvZiBib2R5LmVycm9yID09PSBcInN0cmluZ1wiID8gYm9keS5lcnJvciA6IGAke3doYXR9IGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwga2luZCwge1xuICAgIC4uLihoaW50ID8geyBoaW50IH0gOiB7fSksXG4gICAgLi4uKGNob2ljZXMgPyB7IGNob2ljZXMgfSA6IHt9KSxcbiAgICAuLi4oZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoQnVuLmZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcInNjcmlwdG9yaXVtXCIpO1xuXG4vKiogQ29udHJhY3QgNTogYSBkZXYgZGFlbW9uIG11c3QgcnVuIHdpdGggY3dkIGF0IGBzcmMvc2NyaXB0b3JpdW0vYCAoYnVuZmlnLnRvbWwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vKiogYCRTQ1JJUFRPUklVTV9IT01FYCwgZGVmYXVsdCBgfi8uc2NyaXB0b3JpdW1gIOKAlCB0aGUgc2FtZSBydWxlIGFzIHRoZSBkYWVtb24ncy4gKi9cbmZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbnR5cGUgU2Vzc2lvblBvaW50ZXIgPSB7IHVybDogc3RyaW5nOyBwb3J0OiBudW1iZXI7IHNlc3Npb25faWQ6IHN0cmluZzsgaG9tZTogc3RyaW5nOyBkaXI6IHN0cmluZyB9O1xuXG4vKipcbiAqIFNlc3Npb25zIHdob3NlIHdvcmsgaXMgc3RpbGwgb24gZGlzaywgbmV3ZXN0IGZpcnN0IChFNTYpLlxuICpcbiAqIOKblCBBIERFQUQgU0VTU0lPTiBJUyBOT1QgQSBMT1NUIE9ORSwgYW5kIHRoZSBDTEkgdXNlZCB0byBpbXBseSBvdGhlcndpc2UuIFRoZVxuICogbWFuaWZlc3QgYW5kIGV2ZXJ5IHZlcnNpb24gZmlsZSBsaXZlIHVuZGVyIHRoZSBob21lLCBzbyBhIGRhZW1vbiB0aGF0IGhhc1xuICogZXhpdGVkIOKAlCB0aGUgMzAtbWludXRlIGlkbGUgdGltZW91dCwgYSBjcmFzaCwgYSByZWJvb3Qg4oCUIGNvc3RzIHRoZSBVUkwgYW5kXG4gKiBub3RoaW5nIGVsc2UuIENvbGUgaGl0IGV4YWN0bHkgdGhpcyAoXCJ0aGF0IGxpbmsgZG9lc24ndCBzZWVtIHRvIGJlIGxpdmVcbiAqIGFueW1vcmVcIikgYW5kIHRoZSBvbmx5IHRoaW5nIHRoZSB0b29saW5nIHNhaWQgd2FzIFwibm8gcnVubmluZyBzY3JpcHRvcml1bVxuICogc2Vzc2lvblwiLCB3aGljaCByZWFkcyBsaWtlIHRoZSB3b3JrIGlzIGdvbmUuXG4gKi9cbmZ1bmN0aW9uIHJlc3RvcmFibGUoKTogc3RyaW5nW10ge1xuICBjb25zdCBkaXIgPSBqb2luKHNjcmlwdG9yaXVtSG9tZSgpLCBcInNlc3Npb25zXCIpO1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgLmZpbHRlcigoZSkgPT4gZS5pc0RpcmVjdG9yeSgpICYmIGV4aXN0c1N5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKSlcbiAgICAgIC5tYXAoKGUpID0+ICh7IGlkOiBlLm5hbWUsIGF0OiBzdGF0U3luYyhqb2luKGRpciwgZS5uYW1lLCBcIm1hbmlmZXN0Lmpzb25cIikpLm10aW1lTXMgfSkpXG4gICAgICAuc29ydCgoYSwgYikgPT4gYi5hdCAtIGEuYXQpXG4gICAgICAubWFwKChlKSA9PiBlLmlkKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBXaG8gZW5kZWQgYSBzYXZlZCBzZXNzaW9uLCByZWFkIGZyb20gaXRzIG1hbmlmZXN0ICh3aGljaCBvdXRsaXZlcyB0aGUgZGFlbW9uKS4gKi9cbmZ1bmN0aW9uIGVuZGVkQnkoaWQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgY29uc3QgbSA9IEpTT04ucGFyc2UoXG4gICAgICByZWFkRmlsZVN5bmMoam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiLCBpZCwgXCJtYW5pZmVzdC5qc29uXCIpLCBcInV0ZjhcIiksXG4gICAgKSBhcyB7IGVuZGVkPzogeyBieT86IHVua25vd24gfSB9O1xuICAgIHJldHVybiB0eXBlb2YgbS5lbmRlZD8uYnkgPT09IFwic3RyaW5nXCIgPyBtLmVuZGVkLmJ5IDogdW5kZWZpbmVkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogV2hhdCB0byBzYXkgd2hlbiBubyBkYWVtb24gYW5zd2VycyDigJQgYWJvdXQgdGhlIHNlc3Npb24gQVNLRUQgYWJvdXRcbiAqIChgLS1zZXNzaW9uYCksIG9yIHRoZSBuZXdlc3Qgc2F2ZWQgb25lIHdoZW4gbm9uZSB3YXMgbmFtZWQuXG4gKlxuICog4puUIEEgTkFNRUQgU0VTU0lPTiBJUyBUSEUgT05FIFRIRSBISU5UIE5BTUVTLiBUaGlzIHVzZWQgdG8gb2ZmZXIgdGhlIG5ld2VzdFxuICogc2F2ZWQgc2Vzc2lvbiB3aGF0ZXZlciB3YXMgYXNrZWQsIHNvIGBzYXkgLS1zZXNzaW9uIDc4NmJjYjA5YCBhZnRlciB0aGVcbiAqIGh1bWFuIGVuZGVkIGl0IHNhaWQgXCJicmluZyBpdCBiYWNrIHdpdGg6IG9wZW4gLS1yZXN0b3JlIGIzZjQyOWQzXCIg4oCUIGFub3RoZXJcbiAqIHNlc3Npb24sIGxpdmUgYXQgdGhlIHRpbWUgKHZlcmlmaWVyLCAyMDI2LTEwLTAxKS5cbiAqXG4gKiDim5QgQSBIVU1BTiBFTkQgSVMgUk9VVEVEIE9OIFRIRSBNQU5JRkVTVCdTIGBlbmRlZC5ieWAsIE5PVCBPTiBQUk9TRTogdGhlXG4gKiBodW1hbiBlbmRlZCBpdCBvbiBwdXJwb3NlLCBzbyB0aGUgcmVmdXNhbCBzYXlzIHNvIGFuZCBkb2VzIG5vdCBvZmZlciB0aGVcbiAqIHJlb3BlbiBhcyB0aGUgbmV4dCBhY3QgKGBjaG9pY2VzYCB3b3VsZCBpbnZpdGUgaXQgdG9vLCBzbyB0aGVyZSBhcmUgbm9uZSkuXG4gKi9cbmZ1bmN0aW9uIG5vU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogeyBtZXNzYWdlOiBzdHJpbmc7IGV4dHJhOiBFcnJFeHRyYSB9IHtcbiAgY29uc3QgaWRzID0gcmVzdG9yYWJsZSgpO1xuICBjb25zdCBpZCA9IHNlc3Npb24gPz8gaWRzWzBdO1xuICBpZiAoaWQgPT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIixcbiAgICAgIGV4dHJhOiB7IGhpbnQ6IFwibm8gc2Vzc2lvbiBoYXMgYmVlbiBvcGVuZWQgaW4gdGhpcyBob21lIHlldCDigJQgcnVuOiBjbGkudHMgb3BlbiA8cGF0aD5cIiB9LFxuICAgIH07XG4gIGlmICghaWRzLmluY2x1ZGVzKGlkKSlcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogYG5vIHNjcmlwdG9yaXVtIHNlc3Npb24gJHtpZH0gaW4gdGhpcyBob21lYCxcbiAgICAgIGV4dHJhOiB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgaWRzLmxlbmd0aCA9PT0gMFxuICAgICAgICAgICAgPyBcIm5vIHNhdmVkIHNlc3Npb25zIGluIHRoaXMgaG9tZSDigJQgcnVuOiBjbGkudHMgb3BlbiA8cGF0aD5cIlxuICAgICAgICAgICAgOiBcInBhc3MgLS1zZXNzaW9uIG9uZSBvZiB0aGUgc2F2ZWQgc2Vzc2lvbnMsIG9yIGRyb3AgaXQgZm9yIHRoZSBtb3N0IHJlY2VudFwiLFxuICAgICAgICBjaG9pY2VzOiBpZHMuc2xpY2UoMCwgMTApLFxuICAgICAgfSxcbiAgICB9O1xuICBpZiAoZW5kZWRCeShpZCkgPT09IFwiaHVtYW5cIilcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogYHRoZSBodW1hbiBlbmRlZCBzZXNzaW9uICR7aWR9YCxcbiAgICAgIGV4dHJhOiB7XG4gICAgICAgIGhpbnQ6IGB0aGUgaHVtYW4gZW5kZWQgdGhpcyBzZXNzaW9uIG9uIHB1cnBvc2U7IGRvIG5vdCByZW9wZW4gaXQgdW5sZXNzIHRoZXkgYXNrLiBJZiB0aGV5IGFzazogY2xpLnRzIG9wZW4gLS1yZXN0b3JlICR7aWR9YCxcbiAgICAgIH0sXG4gICAgfTtcbiAgcmV0dXJuIHtcbiAgICBtZXNzYWdlOiBgbm8gcnVubmluZyBzY3JpcHRvcml1bSBzZXNzaW9uICR7aWR9YCxcbiAgICBleHRyYToge1xuICAgICAgLy8g4pqgIFRoZSBDT01NQU5ELCB3aXRoIHRoZSBpZCBhbHJlYWR5IGluIGl0LiBBIGhpbnQgdGhhdCBzYXlzIFwieW91IGNhblxuICAgICAgLy8gcmVzdG9yZSBhIHNlc3Npb25cIiBsZWF2ZXMgdGhlIHJlYWRlciB0byBmaW5kIHRoZSBpZCBhbmQgZ3Vlc3MgdGhlIGZsYWcuXG4gICAgICBoaW50OiBgbm8gZGFlbW9uIGlzIHJ1bm5pbmcgZm9yIHNlc3Npb24gJHtpZH0sIGJ1dCBpdHMgd29yayBpcyBvbiBkaXNrIOKAlCBicmluZyBpdCBiYWNrIHdpdGg6IGNsaS50cyBvcGVuIC0tcmVzdG9yZSAke2lkfWAsXG4gICAgICBjaG9pY2VzOiBpZHMuc2xpY2UoMCwgMTApLFxuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4odG1wZGlyKCksIHNlc3Npb24gPyBgc2NyaXB0b3JpdW0tJHtzZXNzaW9ufS5qc29uYCA6IFwic2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25cIik7XG59XG5cbi8qKiBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFIOKAlCBFTk9FTlQgaXMgdGhlIG9ubHkgYWJzZW5jZS4gKi9cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uUG9pbnRlcjtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB0aGUgc2Vzc2lvbiBwb2ludGVyIGlzIG5vdCB2YWxpZCBKU09OOiAke3BhdGh9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXF1aXJlU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvblBvaW50ZXIge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykge1xuICAgIGNvbnN0IHsgbWVzc2FnZSwgZXh0cmEgfSA9IG5vU2Vzc2lvbihzZXNzaW9uKTtcbiAgICBkaWUobWVzc2FnZSwgXCJub3RfZm91bmRcIiwgZXh0cmEpO1xuICB9XG4gIHJldHVybiBzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBub24tSlNPTiBib2R5ICovXG4gIH1cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgbGV0IHN0YXR1czogbnVtYmVyO1xuICBsZXQgZGF0YTogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICAoeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgbXNnKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIGBjbG9zZWAgc3RvcHMgdGhlIHNlcnZlcjsgYSBSRVNFVCBpcyBpdHMgc3VjY2Vzcy4gQSByZWZ1c2VkIGNvbm5lY3Rpb25cbiAgICAvLyAoYSBzdGFsZSBwb2ludGVyKSBpcyBhIHRyYW5zcG9ydCBmYWlsdXJlIGxpa2UgYW55IG90aGVyLlxuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY29uc3QgY29kZSA9IGVyciAmJiB0eXBlb2YgZXJyID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGVyciA/IFN0cmluZyhlcnIuY29kZSkgOiBcIlwiO1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiICYmIChjb2RlID09PSBcIkVDT05OUkVTRVRcIiB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiRUNPTk5SRVNFVFwiKSkpXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIHRocm93IGVycjtcbiAgfVxuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoU3RyaW5nKG1zZy50eXBlKSwgc3RhdHVzLCBkYXRhKTtcbiAgcmV0dXJuIGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbi8vIOKUgOKUgCB0aGUgZmxhZyByZWdpc3RyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgb3B0aW9ucyB0YWJsZSB0aGUga2l0J3MgcGFyc2VyIHJlYWRzIChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgLCB0aHJvdWdoXG4vLyBgZGVmaW5lQ2xpYCBiZWxvdykuIEV4cG9ydGVkIHNvIGEgdGVzdCBjYW4gYnVpbGQgdGhlIHNhbWUgcGFyc2UgdGhlIENMSSBkb2VzLlxuXG5leHBvcnQgY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBieTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNvbnRleHQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkb2M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBlbnRyeTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZvcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmdWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHF1b3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVvcGVuOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGh1bmtzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaW50bzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxpZmVjeWNsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxpbWl0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFiZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBvbmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHBhdGNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0eXBlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgQ2xpRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkge1xuICAgIHN1cGVyKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuICB9XG59XG5cbi8qKlxuICogYHRhaWwgLS1zaW5jZWAgaXMgYSBCT09LTUFSSzogYW4gZXZlbnQgaWQgKC0xIGZvciBcImV2ZXJ5dGhpbmdcIiksIG9wdGlvbmFsbHlcbiAqIHdpdGggdGhlIGVwb2NoIG9mIHRoZSBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIGFzIHRoZSB0YWlsJ3Mgb3duIGhhbmRvZmYgbGluZSBwcmludHMgaXQg4oCUXG4gKiBga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBEMikuIFRoZSBlcG9jaCBpcyB3aGF0IGxldHMgdGhlIHRhaWwgbm90aWNlIGFcbiAqIHJlc3RhcnRlZCBkYWVtb24gd2hvc2UgbmV3IGxvZyBpcyBhbHJlYWR5IHBhc3QgdGhlIGlkLiBWZXJpZnktcGFzcyBmaXggOVxuICogc3RpbGwgaG9sZHM6IGAtLXNpbmNlIGFiY2AgdXNlZCB0byBwYXJzZSB0byBOYU4sIHdoaWNoIHRoZSBsb2cgcmVhZHMgYXMgXCJmcm9tXG4gKiB0aGUgc3RhcnRcIiwgc28gYSB0eXBvIHJlcGxheWVkIHRoZSB3aG9sZSBidWZmZXIgYXQgZXhpdCAwIOKAlCBpdCBpcyByZWZ1c2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUYWlsU2luY2UodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHIgPSByZWFkU2luY2UodG9rZW4sIHsgZXBvY2g6IHRydWUgfSk7XG4gIGlmICghci5vaykgZGllKHIubWVzc2FnZSwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHIuZXBvY2ggPyB7IHNpbmNlOiByLnNpbmNlLCBlcG9jaDogci5lcG9jaCB9IDogeyBzaW5jZTogci5zaW5jZSB9O1xufVxuXG4vKipcbiAqIGBmaW5kIC0tc2luY2VgIGlzIGEgREFURSwgd2hlcmUgYHRhaWwgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQg4oCUIHRoZSBmbGFnIGlzXG4gKiBzaGFyZWQsIHRoZSBtZWFuaW5nIGlzIHRoZSB2ZXJiJ3MsIGFuZCBwZG9jcyBzcGVsbHMgdGhpcyBvbmUgYC0tc2luY2VgIHRvby5cbiAqIEEgdHlwbyBtdXN0IG5vdCBzaWxlbnRseSB3aWRlbiB0aGUgc2VhcmNoLCBzbyBhIG5vbi1kYXRlIGlzIGEgdXNhZ2UgZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlRGF0ZSh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh0KSB8fCBOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZSh0KSkpXG4gICAgZGllKGBmaW5kIC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBkYXRlIOKAlCB3cml0ZSBpdCBhcyBZWVlZLU1NLUREYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHQ7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vKiogQSBub24tbmVnYXRpdmUgd2hvbGUgbnVtYmVyIGZyb20gYSBmbGFnLCByZWZ1c2VkIHJhdGhlciB0aGFuIGNvZXJjZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb3VudCh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QodCkpIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHdob2xlIG51bWJlcmAsIFwidXNhZ2VcIik7XG4gIHJldHVybiBOdW1iZXIodCk7XG59XG5cbi8qKlxuICogQSBjb21wYXJpc29uIHNpZGU6IGEgdmVyc2lvbiwgb3IgdGhlIGZpbGUgb2YgcmVjb3JkLiBgb3JpZ2luYWxgIGlzIHNwZWxsZWRcbiAqIG91dCByYXRoZXIgdGhhbiBvZmZlcmVkIGFzIGB2MGAg4oCUIGEgemVyb3RoIHZlcnNpb24gd291bGQgcmVhZCBsaWtlIHRoZVxuICogZWFybGllc3Qgb25lLCBhbmQgdGhlIG9yaWdpbmFsIGlzIG5vdCBwYXJ0IG9mIHRoZSB2ZXJzaW9uIGxpbmUgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaWRlKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB8IFwib3JpZ2luYWxcIiB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgLy8gYHNhdmVkYCBpcyB0aGUgd29yZCB0aGUgU1VSRkFDRSB1c2VzIGZvciB0aGlzIHNpZGUgKEU0Myk7IGBvcmlnaW5hbGAgYW5kXG4gIC8vIGBmaWxlYCBrZWVwIHdvcmtpbmcgYmVjYXVzZSB0aGV5IGFyZSB3aGF0IGVhcmxpZXIgc2Vzc2lvbnMgYW5kIG5vdGVzIHNheS5cbiAgaWYgKHQgPT09IFwib3JpZ2luYWxcIiB8fCB0ID09PSBcImZpbGVcIiB8fCB0ID09PSBcInNhdmVkXCIpIHJldHVybiBcIm9yaWdpbmFsXCI7XG4gIHJldHVybiBwYXJzZVZlcnNpb24odG9rZW4sIHdoYXQpO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog4puUIFZFUklGWS1QQVNTIEZJWCA1OiBldmVyeSBwYXRoIGlzIGNoZWNrZWQgSEVSRSwgYmVmb3JlIGFueSBkYWVtb24gZXhpc3RzLlxuICogYG9wZW4gZG9jLm1kIHBpYy5wbmdgIHVzZWQgdG8gc3Bhd24gYSBzZXNzaW9uLCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBwYXRoXG4gKiBpbnNpZGUgaXQg4oCUIGxlYXZpbmcgYSBydW5uaW5nIGRhZW1vbiBhbmQgYSBsaXZlIHBvaW50ZXIgYmVoaW5kIGEgZmFpbGVkXG4gKiBjb21tYW5kLiBBIGZvbGRlciBvciBhIGRvY3VtZW50IGlzIGFjY2VwdGVkOyBhIG1pc3NpbmcgcGF0aCBpcyBub3RfZm91bmQsIGFcbiAqIG5vbi1kb2N1bWVudCBmaWxlIGlzIHVzYWdlIHdpdGggdGhlIGFjY2VwdGVkIGV4dGVuc2lvbnMgYXMgYGNob2ljZXNgLlxuICovXG5mdW5jdGlvbiBjb250ZXh0UGF0aHMocG9zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcGF0aHMgPSBwb3MubWFwKChwKSA9PiByZXNvbHZlKHApKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG4gICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgdHJ5IHtcbiAgICAgIHN0ID0gc3RhdFN5bmMocCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBkaWUoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7cH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICB9XG4gICAgaWYgKCFzdC5pc0RpcmVjdG9yeSgpICYmICFpc0RvY05hbWUocCkpXG4gICAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke3B9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwiYWRkIGEgZm9sZGVyLCBvciBhIGZpbGUgd2l0aCBvbmUgb2YgdGhlc2UgZXh0ZW5zaW9uc1wiLFxuICAgICAgICBjaG9pY2VzOiBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIHBhdGhzO1xufVxuXG4vKipcbiAqIFdoZXJlIGEgTkVXIHNlc3Npb24ncyB3b3Jrc3BhY2UgZ29lcyAoRTIzLCByZWZpbmVkIGJ5IEU2Nyk6IHRoZSBvbmUgZm9sZGVyXG4gKiBgb3BlbmAgd2FzIGdpdmVuLCBzbyBhIHNlc3Npb24gb3ZlciBhIHdvcmxkIG9wZW5lZCBmcm9tIGFueXdoZXJlIHB1dHMgbmV3XG4gKiBkb2N1bWVudHMgaW4gdGhhdCB3b3JsZDsgb3RoZXJ3aXNlIChzZXZlcmFsIGVudHJpZXMsIGEgbG9uZSBmaWxlLCBub3RoaW5nKVxuICogdGhlIGZvbGRlciBgb3BlbmAgcmFuIGluLiBgcGF0aHNgIGFyZSBgY29udGV4dFBhdGhzYCdzLCBhbHJlYWR5IGFic29sdXRlIGFuZFxuICogYWxyZWFkeSBjaGVja2VkIHRvIGV4aXN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFdvcmtzcGFjZShwYXRoczogcmVhZG9ubHkgc3RyaW5nW10sIGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8g4puUIFRIRSBSVUxFIElTIEFCT1VUIERJU1RJTkNUIEZPTERFUlMsIE5PVCBBUkdVTUVOVFMuIGBvcGVuIHdvcmxkIHdvcmxkYFxuICAvLyAob3IgYHdvcmxkYCBhbmQgYSBzeW1saW5rIHRvIGl0KSBvcGVucyBvbmUgZm9sZGVyLCBhbmQgY291bnRlZCBhcyB0d28gaXRcbiAgLy8gbGVmdCB0aGUgd29ya3NwYWNlIGluIHRoZSBjd2QuIENvbXBhcmVkIGJ5IHJlYWxwYXRoOyB0aGUgZmlyc3Qgc3BlbGxpbmdcbiAgLy8gZ2l2ZW4gaXMgdGhlIG9uZSBrZXB0LlxuICBjb25zdCBkaXN0aW5jdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuICAgIGNvbnN0IGtleSA9IHJlYWxwYXRoU3luYyhwKTtcbiAgICBpZiAoIWRpc3RpbmN0LmhhcyhrZXkpKSBkaXN0aW5jdC5zZXQoa2V5LCBwKTtcbiAgfVxuICBjb25zdCBvbmx5ID0gZGlzdGluY3Quc2l6ZSA9PT0gMSA/IFsuLi5kaXN0aW5jdC52YWx1ZXMoKV1bMF0gOiB1bmRlZmluZWQ7XG4gIGlmIChvbmx5ICE9PSB1bmRlZmluZWQgJiYgc3RhdFN5bmMob25seSkuaXNEaXJlY3RvcnkoKSkgcmV0dXJuIG9ubHk7XG4gIHJldHVybiBjd2Q7XG59XG5cbi8qKlxuICogYC0tZG9jYCBhcyB0aGUgQ0xJJ3MgY2FsbGVyIG1lYW50IGl0ICh2ZXJpZnktcGFzcyBmaXggOCk6IGEgdG9rZW4gd2l0aCBhIHBhdGhcbiAqIHNlcGFyYXRvciwgb3Igb25lIG5hbWluZyBhIGZpbGUgaW4gVEhJUyBwcm9jZXNzJ3MgY3dkLCBpcyByZXNvbHZlZCBoZXJlIHRvIGFuXG4gKiBhYnNvbHV0ZSBwYXRoIOKAlCB0aGUgZGFlbW9uJ3MgY3dkIGlzIG5vdCB0aGUgY2FsbGVyJ3MuIEFueXRoaW5nIGVsc2UgKGEgc2x1ZyxcbiAqIGEgdW5pcXVlIGZpbGUgbmFtZSkgZ29lcyBhcyB0eXBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY0FyZyh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHRva2VuLmluY2x1ZGVzKFwiL1wiKSB8fCBleGlzdHNTeW5jKHJlc29sdmUodG9rZW4pKSkgcmV0dXJuIHJlc29sdmUodG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbi8qKiBLZWVwIHRoZSBuZXdlc3QgYExPR19LRUVQIC0gMWAgZGFlbW9uIGxvZ3MsIHNvIHRoZSBvbmUgYWJvdXQgdG8gYmUgd3JpdHRlbiBtYWtlcyBgTE9HX0tFRVBgLiAqL1xuY29uc3QgTE9HX0tFRVAgPSAxMDtcbmZ1bmN0aW9uIHBydW5lTG9ncyhsb2dEaXI6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgbmFtZXMgPSByZWFkZGlyU3luYyhsb2dEaXIpLmZpbHRlcigobikgPT4gL15kYWVtb24tXFxkKy1cXGQrXFwubG9nJC8udGVzdChuKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBieUFnZSA9IG5hbWVzLnNvcnQoKGEsIGIpID0+IE51bWJlcihhLnNwbGl0KFwiLVwiKVsxXSkgLSBOdW1iZXIoYi5zcGxpdChcIi1cIilbMV0pKTtcbiAgZm9yIChjb25zdCBuIG9mIGJ5QWdlLnNsaWNlKDAsIE1hdGgubWF4KDAsIGJ5QWdlLmxlbmd0aCAtIChMT0dfS0VFUCAtIDEpKSkpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhqb2luKGxvZ0RpciwgbikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG5cbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIGZsYWdzLnJlc3RvcmUsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWFuaWZlc3QpKSB7XG4gICAgICBsZXQgc2F2ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICB0cnkge1xuICAgICAgICBzYXZlZCA9IChcbiAgICAgICAgICBhd2FpdCBBcnJheS5mcm9tQXN5bmMobmV3IEJ1bi5HbG9iKFwiKi9tYW5pZmVzdC5qc29uXCIpLnNjYW4oam9pbihob21lLCBcInNlc3Npb25zXCIpKSlcbiAgICAgICAgKS5tYXAoKHApID0+IHAuc3BsaXQoXCIvXCIpWzBdIGFzIHN0cmluZyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm8gc2Vzc2lvbnMgZm9sZGVyOiB0aGUgc2V0IGlzIGVtcHR5LCBhbmQgc2F5cyBzbyAqL1xuICAgICAgfVxuICAgICAgZGllKGBubyBzYXZlZCBzZXNzaW9uIFwiJHtmbGFncy5yZXN0b3JlfVwiIHVuZGVyICR7aG9tZX1gLCBcIm5vdF9mb3VuZFwiLCB7XG4gICAgICAgIGNob2ljZXM6IHNhdmVkLnNvcnQoKSxcbiAgICAgICAgLi4uKHNhdmVkLmxlbmd0aCA9PT0gMCA/IHsgaGludDogXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWVcIiB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxpdmUgPSByZWFkU2Vzc2lvbihmbGFncy5yZXN0b3JlKTtcbiAgICBpZiAobGl2ZSkge1xuICAgICAgY29uc3QgYWxpdmUgPSBhd2FpdCBhcGkobGl2ZS5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKS50aGVuKFxuICAgICAgICAocikgPT4gci5zdGF0dXMgPT09IDIwMCxcbiAgICAgICAgKCkgPT4gZmFsc2UsXG4gICAgICApO1xuICAgICAgaWYgKGFsaXZlKVxuICAgICAgICBkaWUoYHNlc3Npb24gJHtmbGFncy5yZXN0b3JlfSBpcyBhbHJlYWR5IHJ1bm5pbmcgYXQgJHtsaXZlLnVybH1gLCBcImNvbmZsaWN0XCIsIHtcbiAgICAgICAgICBoaW50OiBgdXNlIGl0OiBjbGkudHMgc3RhdGUgLS1zZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX1gLFxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBkYWVtb25BcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAodHlwZW9mIGZsYWdzLnRpbWVvdXQgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBmbGFncy50aW1lb3V0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgZmxhZ3MucmVzdG9yZSk7XG4gIC8vIEUyMyArIEU2NzogYSBuZXcgc2Vzc2lvbidzIHdvcmtzcGFjZSBpcyB0aGUgb25lIGZvbGRlciBpdCB3YXMgZ2l2ZW4sIGVsc2VcbiAgLy8gd2hlcmUgYG9wZW5gIHJhbiAoYGRlZmF1bHRXb3Jrc3BhY2VgKS4gQSByZXN0b3JlZCBvbmUga2VlcHMgaXRzIG93bi5cbiAgZWxzZSBkYWVtb25BcmdzLnB1c2goXCItLXdvcmtzcGFjZVwiLCBkZWZhdWx0V29ya3NwYWNlKHBhdGhzLCBwcm9jZXNzLmN3ZCgpKSk7XG5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfWAsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZGV2IG1vZGUgd2FzIHJlc29sdmVkIChubyBkaXN0L2luZGV4Lmh0bWwgYW5kIG5vIFNQRUxMQk9PS19TVVJGQUNFX01PREU9cmVsZWFzZSksIHdoaWNoIG5lZWRzIHNyYy9zY3JpcHRvcml1bS8g4oCUIHJlaW5zdGFsbCB0aGUgc3BlbGwgb3IgYnVpbGQgaXRcIixcbiAgICAgIH0sXG4gICAgKTtcbiAgLy8gVGhlIGRhZW1vbidzIHN0ZGVyciBnb2VzIHRvIGEgTE9HIEZJTEUsIG5vdCB0byB0aGlzIENMSSdzIHN0ZGVyci4gQW5cbiAgLy8gaW5oZXJpdGVkIHN0ZGVyciBvdXRsaXZlcyB0aGUgQ0xJIGluc2lkZSB0aGUgZGV0YWNoZWQgZGFlbW9uLCBzbyBhbnkgY2FsbGVyXG4gIC8vIHRoYXQgcmVhZHMgYG9wZW5gJ3Mgc3RkZXJyIHRvIEVPRiAoYSB0ZXN0IGhhcm5lc3MsIGEgdG9vbCBydW5uZXIpIHdhaXRzIGZvclxuICAvLyB0aGUgd2hvbGUgc2Vzc2lvbiDigJQgbWVhc3VyZWQ6IHRoZSBpbnRlZ3JhdGlvbiBjZWxsIGh1bmcgYXQgaXRzIDYwIHMgdGltZW91dC5cbiAgLy8gQSBmaWxlIGhvbGRzIG5vIHBpcGUsIGFuZCBhIHN0YXJ0IGZhaWx1cmUgYmVsb3cgcXVvdGVzIGl0cyB0YWlsLlxuICBjb25zdCBsb2dEaXIgPSBqb2luKHNjcmlwdG9yaXVtSG9tZSgpLCBcImxvZ3NcIik7XG4gIG1rZGlyU3luYyhsb2dEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogdGhlIGxvZ3MgdXNlZCB0byBwaWxlIHVwLCBvbmUgcGVyIGBvcGVuYCwgZm9yZXZlci5cbiAgcHJ1bmVMb2dzKGxvZ0Rpcik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKGxvZ0RpciwgYGRhZW1vbi0ke0RhdGUubm93KCl9LSR7cHJvY2Vzcy5waWR9LmxvZ2ApO1xuICBkYWVtb25BcmdzLnB1c2goXCItLWxvZ1wiLCBsb2dQYXRoKTtcbiAgY29uc3QgbG9nRmQgPSBvcGVuU3luYyhsb2dQYXRoLCBcImFcIik7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJidW5cIiwgZGFlbW9uQXJncywge1xuICAgIGN3ZCxcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBsb2dGZF0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgfSk7XG4gIGNsb3NlU3luYyhsb2dGZCk7XG4gIGNoaWxkLnVucmVmKCk7XG5cbiAgY29uc3Qgc3RhcnRUaW1lb3V0TXMgPVxuICAgIHR5cGVvZiBmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0gPT09IFwic3RyaW5nXCJcbiAgICAgID8gTWF0aC5tYXgoNTAwMCwgTnVtYmVyLnBhcnNlSW50KGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSwgMTApICogMTAwMClcbiAgICAgIDogNDUwMDA7XG4gIGNvbnN0IGxpbmUgPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXMsIHJlaikgPT4ge1xuICAgIGxldCBidWYgPSBcIlwiO1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChcbiAgICAgICgpID0+XG4gICAgICAgIHJlaihcbiAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgZGFlbW9uIHN0YXJ0IHRpbWVvdXQgKCR7c3RhcnRUaW1lb3V0TXMgLyAxMDAwfXMpIOKAlCBwYXNzIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz5gLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICBzdGFydFRpbWVvdXRNcyxcbiAgICApO1xuICAgIGNoaWxkLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICBidWYgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IG5sID0gYnVmLmluZGV4T2YoXCJcXG5cIik7XG4gICAgICBpZiAobmwgPj0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICByZXMoYnVmLnNsaWNlKDAsIG5sKS50cmltKCkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihlcnIpO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihuZXcgRXJyb3IoYGRhZW1vbiBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0gYmVmb3JlIGl0cyBoYW5kc2hha2VgKSk7XG4gICAgfSk7XG4gIH0pLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICBsZXQgdGFpbCA9IFwiXCI7XG4gICAgdHJ5IHtcbiAgICAgIHRhaWwgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGY4XCIpLnRyaW0oKS5zbGljZSgtODAwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIGxvZyB3cml0dGVuICovXG4gICAgfVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAgeyBoaW50OiB0YWlsID8gYGRhZW1vbiBsb2cgKCR7bG9nUGF0aH0pOiAke3RhaWx9YCA6IGBkYWVtb24gbG9nOiAke2xvZ1BhdGh9YCB9LFxuICAgICk7XG4gIH0pO1xuXG4gIC8vIFJlbGVhc2UgdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlLCBvciB0aGlzIENMSSdzIG5hdHVyYWwgcmV0dXJuIHdhaXRzIG9uIGFcbiAgLy8gc3RyZWFtIHRoYXQgbmV2ZXIgY2xvc2VzIChnbGFtb3VyIG1lYXN1cmVkIDkxIHMg4oaSIDEgcykuIENoZWNrZWQgZm9yIHRoZVxuICAvLyBNRVRIT0Q6IHVuZGVyIEJ1biB0aGlzIHBpcGUgaXMgYSBwbGFpbiBSZWFkYWJsZSB0aGF0IG5vbmV0aGVsZXNzIGhhcyB1bnJlZi5cbiAgY29uc3Qgb3V0ID0gY2hpbGQuc3Rkb3V0O1xuICBpZiAoIW91dCB8fCAhKFwidW5yZWZcIiBpbiBvdXQpIHx8IHR5cGVvZiBvdXQudW5yZWYgIT09IFwiZnVuY3Rpb25cIilcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInNjcmlwdG9yaXVtOiB0aGUgZGFlbW9uJ3Mgc3Rkb3V0IHBpcGUgaGFzIG5vIHVucmVmKCk7IGBvcGVuYCB3b3VsZCBuZXZlciBleGl0XCIsXG4gICAgKTtcbiAgb3V0LnVucmVmKCk7XG5cbiAgbGV0IGhzOiB7XG4gICAgdXJsOiBzdHJpbmc7XG4gICAgcG9ydDogbnVtYmVyO1xuICAgIHNlc3Npb25faWQ6IHN0cmluZztcbiAgICAvKiogV2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQ6IG5hbWVkIHNvIHRoZSBhZ2VudCBzZWVzIGl0IChFNjcpLiAqL1xuICAgIHdvcmtzcGFjZT86IHN0cmluZztcbiAgICBvaz86IGJvb2xlYW47XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9O1xuICB0cnkge1xuICAgIGhzID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB1bmV4cGVjdGVkIG91dHB1dCBmcm9tIGRhZW1vbjogJHtsaW5lfWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgaWYgKGhzLm9rID09PSBmYWxzZSkgZGFlbW9uUmVmdXNlZChcIm9wZW5cIiwgaHMuc3RhdHVzID8/IDUwMCwgaHMpO1xuXG4gIGxldCBlbnRyaWVzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCByID0gYXdhaXQgcG9zdENtZChocy5zZXNzaW9uX2lkLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSk7XG4gICAgZW50cmllcyA9IChyLmVudHJpZXMgYXMgdW5rbm93bltdKSA/PyBbXTtcbiAgfVxuICBwcmludEpzb24oeyAuLi5ocywgLi4uKHBhdGhzLmxlbmd0aCA+IDAgPyB7IGVudHJpZXMgfSA6IHt9KSB9KTtcblxuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkge1xuICAgIGNvbnN0IG9wZW5lciA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gICAgc3Bhd24ob3BlbmVyLCBbaHMudXJsXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86IFwiaWdub3JlXCIgfSkudW5yZWYoKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjb250ZXh0LmFkZFwiLCBwYXRocyB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZnVsbDogYm9vbGVhbikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCI/ZnVsbD0xXCIgOiBcIlwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJzdGF0ZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbi8qKlxuICogVGhlIE9ORSBwcm9zZSByZWFkZXI6IGFyZ3VtZW50cywgYC0tc3RkaW5gIG9yIGAtLWJvZHktZmlsZWAsIGV4YWN0bHkgb25lIG9mXG4gKiB0aGVtLiBgc2F5YC9gdGFza2AvYG5vdGVgIG5lZWQgYSBtZXNzYWdlIGFuZCB0cmltIGl0OyBgdmVyc2lvbi1uZXdgICgjMTE3KVxuICogbWF5IGhhdmUgbm9uZSAodGhlbiBpdCBjb3BpZXMpIGFuZCBrZWVwcyBpdHMgYm9keSBieXRlIGZvciBieXRlLCBiZWNhdXNlIGFcbiAqIHZlcnNpb24ncyB0ZXh0IGlzIGEgZG9jdW1lbnQsIG5vdCBhIGNoYXQgbGluZS5cbiAqXG4gKiBBIGJvZHkgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZSBpcyBgdXNhZ2VgICgyKSBieSBkZWZhdWx0IOKAlCB3aGF0IGBzYXlgL2B0YXNrYC9cbiAqIGBub3RlYC9gbm90ZS1lZGl0YCBoYXZlIGFsd2F5cyBhbnN3ZXJlZCDigJQgYW5kIGBub3RfZm91bmRgICg1KSB3aGVyZSB0aGVcbiAqIGNhbGxlciBhc2tzIChgdmVyc2lvbi1uZXdgLCBuZXcgaW4gIzExNykuIOKaoCBBbGlnbmluZyB0aGUgb2xkZXIgdmVyYnMgb24gNSBpc1xuICogYSBjYWxsZXItdmlzaWJsZSBleGl0LWNvZGUgY2hhbmdlLCBoZWxkIGZvciBhIHJlbGVhc2UgdGhhdCBjYW4gY2FycnkgYVxuICogYnJlYWtpbmctY2hhbmdlcyBub3RlOyBjbGktY29udHJhY3QgcGlucyB0aGVpciAyIHVudGlsIHRoZW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRQcm9zZShcbiAgdmVyYjogc3RyaW5nLFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4gIG86IHsgb3B0aW9uYWw/OiBib29sZWFuOyBtaXNzaW5nRmlsZT86IFwidXNhZ2VcIiB8IFwibm90X2ZvdW5kXCIgfSA9IHt9LFxuKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgPT09IDAgJiYgby5vcHRpb25hbCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IGAke3ZlcmJ9IG5lZWRzIGEgbWVzc2FnZWBcbiAgICAgICAgOiBvLm9wdGlvbmFsXG4gICAgICAgICAgPyBgJHt2ZXJifSB0YWtlcyBpdHMgYm9keSBmcm9tIG9uZSBwbGFjZTogLS1zdGRpbiBvciAtLWJvZHktZmlsZSwgbm90IGJvdGhgXG4gICAgICAgICAgOiBgJHt2ZXJifSB0YWtlcyBpdHMgbWVzc2FnZSBmcm9tIGV4YWN0bHkgb25lIHBsYWNlOiBhcmd1bWVudHMsIC0tc3RkaW4gb3IgLS1ib2R5LWZpbGVgLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBvLm9wdGlvbmFsXG4gICAgICAgICAgPyBcImdpdmUgdGhlIHRleHQgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIlxuICAgICAgICAgIDogXCJnaXZlIHRoZSB0ZXh0IGFzIGFyZ3VtZW50cywgb3IgcHJvc2UgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gLyAtLXN0ZGluIChuZXZlciBhbiB1bnF1b3RlZCBoZXJlZG9jKVwiLFxuICAgICAgICBjaG9pY2VzOiBbXCItLXN0ZGluXCIsIFwiLS1ib2R5LWZpbGVcIl0sXG4gICAgICB9LFxuICAgICk7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIGlmIChmbGFncy5zdGRpbiA9PT0gdHJ1ZSkgdGV4dCA9IGF3YWl0IG5ldyBSZXNwb25zZShCdW4uc3RkaW4uc3RyZWFtKCkpLnRleHQoKTtcbiAgZWxzZSBpZiAodHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgcGF0aCA9IGZsYWdzW1wiYm9keS1maWxlXCJdO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBvLm1pc3NpbmdGaWxlID8/IFwidXNhZ2VcIik7XG4gICAgLy8gQSBkaXJlY3RvcnkgaXMgdGhlIGNhbGxlcidzIG1pc3Rha2UsIHRoZSBzYW1lIGZvciBldmVyeSB2ZXJiIOKAlCBpdCB1c2VkXG4gICAgLy8gdG8gcmVhY2ggcmVhZEZpbGVTeW5jIGFuZCBjb21lIG91dCBhcyBhbiBpbnRlcm5hbCBFSVNESVIgKGV4aXQgMSkuXG4gICAgaWYgKHN0YXRTeW5jKHBhdGgpLmlzRGlyZWN0b3J5KCkpXG4gICAgICBkaWUoYCR7dmVyYn06IC0tYm9keS1maWxlIGlzIGEgZGlyZWN0b3J5LCBub3QgYSBmaWxlOiAke3BhdGh9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwicGFzcyB0aGUgcGF0aCBvZiB0aGUgZmlsZSB0aGF0IGhvbGRzIHRoZSB0ZXh0XCIsXG4gICAgICB9KTtcbiAgICAvLyBTbyBpcyBhIGZpbGUgdGhpcyBwcm9jZXNzIG1heSBub3QgcmVhZCAoY2htb2QgMDAwKTogaXQgdXNlZCB0byBjb21lIG91dFxuICAgIC8vIGFzIGFuIGludGVybmFsIHJhdyBFQUNDRVMgKGV4aXQgMSkuIEl0IGlzIHRoZXJlIGFuZCBpcyBhIGZpbGUsIHNvIGFueVxuICAgIC8vIGZhaWx1cmUgdG8gcmVhZCBpdCBpcyBcImNhbm5vdCBiZSByZWFkXCIg4oCUIHRoZSBjYWxsZXIncyB0byBmaXguXG4gICAgdHJ5IHtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBjYW5ub3QgYmUgcmVhZDogJHtwYXRofWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBcImNoZWNrIHRoYXQgdGhlIGZpbGUncyBwZXJtaXNzaW9ucyBsZXQgeW91IHJlYWQgaXQsIG9yIHBhc3MgYW5vdGhlciBmaWxlXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSB0ZXh0ID0gcG9zLmpvaW4oXCIgXCIpO1xuICBpZiAoIXRleHQudHJpbSgpKVxuICAgIGRpZShcbiAgICAgIG8ub3B0aW9uYWwgPyBgJHt2ZXJifTogdGhlIGJvZHkgaXMgZW1wdHlgIDogYCR7dmVyYn06IHRoZSBtZXNzYWdlIGlzIGVtcHR5YCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIG8ub3B0aW9uYWwgPyB7IGhpbnQ6IGBkcm9wIC0tYm9keS1maWxlLy0tc3RkaW4gdG8gY29weSB0aGUgc291cmNlIHZlcnNpb24gaW5zdGVhZGAgfSA6IHt9LFxuICAgICk7XG4gIHJldHVybiB0ZXh0O1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuICB2ZXJiOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKChhd2FpdCByZWFkUHJvc2UodmVyYiwgcG9zLCBmbGFncykpID8/IFwiXCIpLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRoZSB0YWlsIGhhcyBhbHJlYWR5IHJlcG9ydGVkIHRoYXQgaXQgbG9zdCB0aGUgZGFlbW9uIChFNTUpLiBNb2R1bGVcbiAqIHNjb3BlIGJlY2F1c2UgYSB0YWlsIGlzIG9uZSBwcm9jZXNzIGRvaW5nIG9uZSB0aGluZywgYW5kIHRoZSB0d28gaG9va3MgdGhhdFxuICogcmVhZCBpdCBhcmUgaGFuZGVkIHRvIGEgY2xpZW50IHRoYXQgb3ducyBpdHMgb3duIGxvb3AuXG4gKi9cbmxldCBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcblxuLyoqXG4gKiBUaGUgd2F0Y2guIEVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgY2FwIHdpdGggb25lIGxpbmUgbmFtaW5nIHRoZSBuZXh0XG4gKiBhY3QgKGBzcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgKTogcmUtYXJtIE1vbml0b3IsIGdvIHRvIGEgYmFja2dyb3VuZFxuICogYC0tb25jZWAsIG9yIGNvbWUgYmFjayBmcm9tIGEgY2xvc2VkIG9yIGxvc3Qgc2Vzc2lvbiB3aXRoIGBvcGVuIC0tcmVzdG9yZWAuXG4gKiBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOiB0aGUgYWdlbnQgYWxyZWFkeSBrbm93cyB0aGVcbiAqIHNlc3Npb24sIGFuZCB0aGUgbGluZSB3b3VsZCBjb3VudCBhcyBub2lzZSBpbiB0aGUgd2luZG93J3Mgd2FrZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICBvOiB7IG9uY2U6IGJvb2xlYW47IHNpbmNlR2l2ZW46IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGNvbnN0IHJlQXJtID0gc2Vzc2lvbiAhPT0gdW5kZWZpbmVkIHx8IG8uc2luY2VHaXZlbjtcbiAgbGV0IGdyb3VuZGVkID0gby5zaW5jZUdpdmVuO1xuICBjb25zdCBwaW4gPSAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gW1wiLS1zZXNzaW9uXCIsIGJvdW5kSWRdIDogW10pO1xuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZyB9PihcbiAgICB7XG4gICAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgICAvLyBEMTogYSB0YWlsIGdpdmVuIC0tc2Vzc2lvbiBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElOR1xuICAgICAgICAvLyBzZXNzaW9uLCBzbyBub3QgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQgKGluIHRoZSBnYXAsIHNheSkg4oCUIHRoZVxuICAgICAgICAvLyBoYW5kb2ZmIHNheXMgYHRhaWwuY2xvc2VkYCwgbmV2ZXIgYSBzaWxlbnQgcmV0cnktZm9yZXZlci5cbiAgICAgICAgaWYgKGV2ZXJSZXNvbHZlZCB8fCByZUFybSkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgICAgfSxcbiAgICAgIHBhdGg6IFwiL2V2ZW50c1wiLFxuICAgICAgc2luY2UsXG4gICAgICAuLi4oby5lcG9jaCA/IHsgc2luY2VFcG9jaDogby5lcG9jaCB9IDoge30pLFxuICAgICAgY3Vyc29yT2Y6IChldikgPT4gKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiA/IGV2LmlkIDogdW5kZWZpbmVkKSxcbiAgICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAgIC8vIEEgZGlmZmVyZW50IGVwb2NoIG9uIHJlY29ubmVjdCA9IHRoZSBkYWVtb24gcmVzdGFydGVkOyBpZHMgYmVnYW4gYWdhaW4uXG4gICAgICBvbkVwb2NoQ2hhbmdlOiAoZXBvY2gpID0+IEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJlcG9jaC5jaGFuZ2VkXCIsIGVwb2NoIH0pLFxuICAgICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgICAgLy8g4puUIEEgS0VFUEFMSVZFIElTIFBST09GIE9GIExJRkUsIHNvIGl0IGlzIGFsc28gd2hhdCBjbGVhcnMgYSByZXBvcnRlZFxuICAgICAgLy8gZGlzY29ubmVjdGlvbi4gVGhlcmUgaXMgbm8gYG9uQ29ubmVjdGAgaG9vayBhbmQgdGhpcyBpcyB0aGUgaG9uZXN0XG4gICAgICAvLyBzdWJzdGl0dXRlOiB0aGUgZGFlbW9uIG9ubHkgc2VuZHMgY29tbWVudHMgZG93biBhIGxpdmUgc3RyZWFtLlxuICAgICAgb25Db21tZW50OiAoKSA9PiB7XG4gICAgICAgIGlmICghZGlzY29ubmVjdGVkKSByZXR1cm4gXCI6IHNjcmlwdG9yaXVtLWtlZXBhbGl2ZVwiO1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJ0YWlsLnJlY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgICAgLy8g4puUIE9ORSBMSU5FIFBFUiBFUElTT0RFLCBOT1QgUEVSIEFUVEVNUFQuIFRoZSBjbGllbnQgcmVjb25uZWN0cyB3aXRoXG4gICAgICAvLyBiYWNrb2ZmIGZvcmV2ZXIsIHNvIGEgaG9vayB0aGF0IHNwb2tlIGV2ZXJ5IHRpbWUgd291bGQgZW1pdCBhIGxpbmUgZXZlcnlcbiAgICAgIC8vIGZldyBzZWNvbmRzIGZvciBhcyBsb25nIGFzIHRoZSBkYWVtb24gc3RheWVkIGRvd24g4oCUIHdoaWNoIGlzIGhvdyBhXG4gICAgICAvLyB3YXRjaGVyIGdldHMgbXV0ZWQsIGFuZCB0aGVuIG5vYm9keSBoZWFycyB0aGUgbmV4dCByZWFsIHRoaW5nLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBXSFkgVEhJUyBFWElTVFMgQVQgQUxMOiB3aXRob3V0IGl0IGEgREVBRCBkYWVtb24gYW5kIGEgUVVJRVQgb25lIGFyZVxuICAgICAgLy8gdGhlIHNhbWUgdGhpbmcgZnJvbSBvdXQgaGVyZS4gQSBncmFjZWZ1bCBjbG9zZSBlbWl0cyBgY2xvc2VkYCBhbmQgZW5kc1xuICAgICAgLy8gdGhlIHRhaWw7IGEgY3Jhc2gsIGEga2lsbCAtOSBvciBhIHNsZWVwaW5nIGxhcHRvcCBlbWl0cyBub3RoaW5nLCB0aGVcbiAgICAgIC8vIGNsaWVudCByZXRyaWVzIGluIHNpbGVuY2UsIGFuZCB0aGUgYWJzZW5jZSBvZiBldmVudHMgaXMgbm90IGFuIGV2ZW50LiBBXG4gICAgICAvLyB3YXRjaGVyIHdhaXRpbmcgZm9yIHRoZSBodW1hbidzIG5leHQgbWVzc2FnZSB3b3VsZCB3YWl0IGZvcmV2ZXIgYW5kXG4gICAgICAvLyBuZXZlciBsZWFybiBpdCBoYWQgc3RvcHBlZCBsaXN0ZW5pbmcuIChGb3VuZCAyMDI2LTA5LTE0IHdoaWxlIGFuc3dlcmluZ1xuICAgICAgLy8gQ29sZSdzIHF1ZXN0aW9uIGFib3V0IHdoZXRoZXIgYSB0aW1lb3V0IHdvdWxkIG5vdGlmeSBtZS4gSXQgd291bGQgbm90LilcbiAgICAgIG9uRGlzY29ubmVjdDogKHsgY2F1c2UsIHN0YXR1cyB9KSA9PiB7XG4gICAgICAgIGlmIChkaXNjb25uZWN0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHR5cGU6IFwidGFpbC5kaXNjb25uZWN0ZWRcIixcbiAgICAgICAgICBjYXVzZSxcbiAgICAgICAgICAuLi4oc3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IHN0YXR1cyB9IDoge30pLFxuICAgICAgICAgIG5vdGU6IFwicmV0cnlpbmc7IHRoZSBzZXNzaW9uIG1heSBoYXZlIGNsb3NlZCBvciBjcmFzaGVkXCIsXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHNwZWxsOiBcInNjcmlwdG9yaXVtXCIsXG4gICAgICBtb2RlOiBvLm9uY2UgPyBcIm9uY2VcIiA6IFwid2F0Y2hcIixcbiAgICAgIHByZXNlbmNlOiBmYWxzZSxcbiAgICAgIC8vIFRoZSBgY2xvc2VkYCBldmVudCBzYXlzIHdobyBlbmRlZCBpdDsgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzXG4gICAgICAvLyBgYnlgLCBhbmQgYSBodW1hbiBlbmQgdGVsbHMgdGhlIGFnZW50IHRvIHN0b3AgYW5kIG5vdCByZW9wZW4uXG4gICAgICBjbG9zZWRCeTogKGV2KSA9PiAodHlwZW9mIGV2LmJ5ID09PSBcInN0cmluZ1wiID8gZXYuYnkgOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSByZS1hcm0gYWZ0ZXIgdGhlIGVuZCBuZXZlciBzZWVzIGBjbG9zZWRgIChEMSk7IHRoZSBtYW5pZmVzdCdzXG4gICAgICAvLyBgZW5kZWQuYnlgIGlzIHRoZSBzYW1lIGZhY3QsIGFuZCBpdCBvdXRsaXZlcyB0aGUgZGFlbW9uLlxuICAgICAgZ29uZUJ5OiAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gZW5kZWRCeShib3VuZElkKSA6IHVuZGVmaW5lZCksXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQsIG9uY2UsIGVwb2NoIH0pID0+IHRhaWxDb21tYW5kKFtcInRhaWxcIiwgLi4ucGluKCldLCBhdCwgb25jZSwgZXBvY2gpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tcmVzdG9yZVwiLCBib3VuZElkID8/IFwiPGlkPlwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuLy9cbi8vIFRocm91Z2ggdGhlIGhvdXNlJ3Mgb25lIHJlZ2lzdHJ5IChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgKS4gc2NyaXB0b3JpdW0nc1xuLy8gb3duIGRpc3BhdGNoZXIsIGhlbHAgcmVuZGVyZXIgYW5kIGRlY2xhcmF0aW9uIGVtaXR0ZXIg4oCUIGEgY29weSBvZiBnbGFtb3VyJ3Mg4oCUXG4vLyB3ZXJlIGRlbGV0ZWQgd2hlbiBpdCBtb3ZlZCBvbnRvIHRoZSBtb2R1bGUuIGBoZWxwYCwgYHZlcnNpb25gIGFuZCBgc2NoZW1hYFxuLy8gYXJlIHRoZSBtb2R1bGUncyByb3dzOiBkZWNsYXJlZCBhbmQgc3RyaWN0LCBzbyBgdmVyc2lvbiAtLWJvZ3VzYCBpcyByZWZ1c2VkXG4vLyAoaXQgZXhpdGVkIDAgd2hpbGUgYHZlcnNpb25gIHdhcyBhbnN3ZXJlZCBiZWZvcmUgdGhlIHRhYmxlKS5cblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuLyoqIEEgcm93IGFzIHNjcmlwdG9yaXVtIHdyaXRlcyBpdDogdGhlIGhhbmRsZXIgdGFrZXMgYChwb3MsIGZsYWdzLCBzZXNzaW9uKWAsXG4gKiAgYW5kIGBvbmAgYWRhcHRzIGl0IHRvIHRoZSBraXQncyBgcnVuKGludilgLiBBIG51bWJlciByZXR1cm5lZCBpcyB0aGUgZXhpdFxuICogIGNvZGUgKGB0YWlsYCk7IGFueXRoaW5nIGVsc2UgaXMgMC4gKi9cbnR5cGUgUm93ID0gT21pdDxDb21tYW5kU3BlYzxGbGFnPiwgXCJydW5cIiB8IFwicmVqZWN0SGludFwiPiAmIHtcbiAgcnVuOiAocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHVua25vd247XG59O1xuXG4vKiogc2NyaXB0b3JpdW0gZGVjbGFyZXMgbm8gYG11bHRpcGxlYCBmbGFnLCBzbyBldmVyeSB2YWx1ZSBpcyBhIHN0cmluZyBvciBhXG4gKiAgYm9vbGVhbiDigJQgdGhlIGBGbGFnc2AgdGhlIGhhbmRsZXJzIHRha2UuICovXG5jb25zdCBvbiA9XG4gIChoOiBSb3dbXCJydW5cIl0pID0+XG4gIChpbnY6IEludm9jYXRpb248RmxhZz4pOiB1bmtub3duID0+IHtcbiAgICBjb25zdCBmbGFncyA9IGludi5mbGFncyBhcyBGbGFncztcbiAgICByZXR1cm4gaChpbnYucG9zLCBmbGFncywgdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkKTtcbiAgfTtcblxuLyoqIEV2ZXJ5IGZsYWcgcmVqZWN0aW9uJ3MgaGludDogdGhlIG9uZSByZXBhaXIgZm9yIHByb3NlIGluIHdoaWNoIGEgd29yZFxuICogIGhhcHBlbnMgdG8gc3RhcnQgd2l0aCBgLS1gLiAqL1xuY29uc3QgREFTSF9ISU5UID0gXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCI7XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IFJPV1M6IFJvd1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKSwgYWRkaW5nIHBhdGhzOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZCwgd29ya3NwYWNlfTsgdGhlIHdvcmtzcGFjZSBpcyB0aGUgb25lIGZvbGRlciBnaXZlbiwgZWxzZSB0aGUgY3VycmVudCBmb2xkZXIuIC0tdGltZW91dCA8c2Vjb25kcz4gc2V0cyB0aGUgaWRsZSBjbG9zZSAoZGVmYXVsdCAxODAwKTsgLS10aW1lb3V0IDAgc3RhbmRzIHVudGlsIGNsb3NlZFwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIiwgXCJvbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwidGhlIGh1bWFuJ3MgbWVzc2FnZXMgKHdpdGggc2VsZWN0aW9uICsgYWN0aXZlIHBhdGgpIGFzIEpTT04gbGluZXMg4oCUIHdyYXAgd2l0aCBNb25pdG9yOyBpdHMgbGFzdCBsaW5lIG5hbWVzIHRoZSBuZXh0IGFjdFwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBiID0gdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VUYWlsU2luY2UoZmxhZ3Muc2luY2UpIDogeyBzaW5jZTogLTEgfTtcbiAgICAgIHJldHVybiBjbWRUYWlsKHNlc3Npb24sIGIuc2luY2UsIHtcbiAgICAgICAgb25jZTogZmxhZ3Mub25jZSA9PT0gdHJ1ZSxcbiAgICAgICAgc2luY2VHaXZlbjogdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiLFxuICAgICAgICAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tbmV3XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZyb21cIiwgXCJsYWJlbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwicHJvcG9zZSBhIG5ldyB2ZXJzaW9uIGhvbGRpbmcgeW91ciB0ZXh0ICgtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbik7IHdpdGhvdXQgb25lLCBjb3BpZXMgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgYW5kIHByaW50cyBpdHMgcGF0aCB0byBlZGl0XCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSB0eXBlb2YgZmxhZ3MuZnJvbSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlVmVyc2lvbihmbGFncy5mcm9tLCBcIi0tZnJvbVwiKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZWFkUHJvc2UoXCJ2ZXJzaW9uLW5ld1wiLCBbXSwgZmxhZ3MsIHtcbiAgICAgICAgb3B0aW9uYWw6IHRydWUsXG4gICAgICAgIG1pc3NpbmdGaWxlOiBcIm5vdF9mb3VuZFwiLFxuICAgICAgfSk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIC4uLihmcm9tICE9PSB1bmRlZmluZWQgPyB7IGZyb20gfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8geyBsYWJlbDogZmxhZ3MubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odGV4dCAhPT0gdW5kZWZpbmVkID8geyB0ZXh0IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNheVwiLCB0ZXh0OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcInNheVwiKSB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidmVyc2lvbi1kZWxldGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZOXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIHZlcnNpb24gYW5kIGl0cyBmaWxlIChuZXZlciB0aGUgYWN0aXZlIG9uZSDigJQgYWN0aXZhdGUgYW5vdGhlciBmaXJzdClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5kZWxldGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwidmVyc2lvbi1kZWxldGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2tcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInNheSB5b3UgaGF2ZSBzdGFydGVkIHNvbWV0aGluZzsgcHJpbnRzIHRoZSBpZCB0byBmaW5pc2ggaXQgd2l0aFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5zdGFydFwiLCB0ZXh0OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcInRhc2tcIikgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2stc3RhdHVzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInN0YXR1c1wiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNheSB3aGF0IHN0ZXAgYSB0YXNrIGlzIG9uIChmb3Igd29yayB3b3J0aCB3YXRjaGluZylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suc3RhdHVzXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgc3RhdHVzOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIiksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLWRvbmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwib3V0Y29tZVwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgdGFzayBmaW5pc2hlZCwgb3B0aW9uYWxseSBzYXlpbmcgd2hhdCBjYW1lIG9mIGl0XCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IG91dGNvbWUgPSBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suZG9uZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLihvdXRjb21lID8geyBvdXRjb21lIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnJlbW92ZVwiLCBpZDogcG9zWzBdIGFzIHN0cmluZyB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza3MtY2xlYXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiZm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2s7IG91dHN0YW5kaW5nIG9uZXMgYXJlIGxlZnQgYWxvbmVcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrcy5jbGVhclwiIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3JraW5nXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZvclwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBhcmUgc3RpbGwgb24gaXQg4oCUIHNpbGVuY2VzIHRoZSB3YWl0aW5nIG51ZGdlLCBrZWVwcyB0aGUgaHVtYW4ncyBwdWxzZVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBzZWNvbmRzID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLmZvciA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MuZm9yLCBcIndvcmtpbmcgLS1mb3JcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwid29ya2luZ1wiLFxuICAgICAgICAgIC4uLihzZWNvbmRzICE9PSB1bmRlZmluZWQgPyB7IHNlY29uZHMgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwicXVvdGVcIiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcIm5vdGUgYSBwYXNzYWdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbiAoLS1xdW90ZSAnZXhhY3QgdGV4dCc7IHByb3NlOiAtLWJvZHktZmlsZSBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MucXVvdGUgIT09IFwic3RyaW5nXCIgfHwgZmxhZ3MucXVvdGUudHJpbSgpID09PSBcIlwiKVxuICAgICAgICBkaWUoXCJub3RlOiAtLXF1b3RlIGlzIHJlcXVpcmVkIOKAlCB0aGUgZXhhY3QgdGV4dCB0aGUgbm90ZSBpcyBhYm91dFwiLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIHN0YXRlIC0tZnVsbCAodGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBpcyBvbiBkaXNrOyBxdW90ZSBmcm9tIGl0KVwiLFxuICAgICAgICB9KTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZFwiLFxuICAgICAgICAgIHF1b3RlOiBmbGFncy5xdW90ZSxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcIm5vdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBub3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLWZ1bGwgaW5jbHVkZXMgcmVzb2x2ZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3Rlc1wiLFxuICAgICAgICAgIC4uLihmbGFncy5mdWxsID8geyBhbGw6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1lZGl0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInJld3JpdGUgd2hhdCBhIG5vdGUgc2F5cyAoaXRzIHBhc3NhZ2UgaXMgdW5jaGFuZ2VkKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmVkaXRcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3Muc2xpY2UoMSksIGZsYWdzLCBcIm5vdGUtZWRpdFwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1yZXNvbHZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInJlb3BlblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgbm90ZSBkZWFsdCB3aXRoICgtLXJlb3BlbiBwdXRzIGl0IGJhY2spXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVzb2x2ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHJlc29sdmVkOiAhZmxhZ3MucmVvcGVuLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgbm90ZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLnJlbW92ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdzYXZlZCcgZm9yIHRoZSBmaWxlIG9uIGRpc2spOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VhcmNoXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImxpbWl0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInF1ZXJ5XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic2VhcmNoIHRoZSBjb250ZXh0OiBmdXp6eSBvbiBuYW1lcywgZXhhY3QgaW4gdGV4dCDigJQgc2VhcmNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uIG9mIG9wZW4gZG9jdW1lbnRzLCB3aGljaCBncmVwIGNhbm5vdCBzZWVcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5saW1pdCA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MubGltaXQsIFwic2VhcmNoIC0tbGltaXRcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICAgICAgcXVlcnk6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgICAgICAuLi4obGltaXQgIT09IHVuZGVmaW5lZCA/IHsgbGltaXQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwid2hhdCBpcyB3b3J0aCBsb29raW5nIGF0IGluIHRoaXMgc2Vzc2lvbiDigJQgZWFjaCBmaW5kaW5nIG5hbWVzIHRoZSB2ZXJiIHRoYXQgZml4ZXMgaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2N0b3JcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9yZ2V0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKHJlZnVzZWQgd2hpbGUgdGhlIGZpbGUgZXhpc3RzIOKAlCB1c2UgaGlkZSB0byB0YWtlIG9uZSBvdXQgb2YgdGhlIGNvbnRleHQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJmb3JnZXRcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZGFuZ2xpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImxpbmtzIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCBmaWxlLCBsaW5lLCBhbmQgdGhlIHRhcmdldCBhcyB3cml0dGVuXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJkYW5nbGluZ1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbl07XG5cbi8vIOKblCBCVUlMRElORyBUSEUgVEFCTEUgSEFTIE5PIFNJREUgRUZGRUNUUzogYGRlZmluZUNsaWAgb25seSB2YWxpZGF0ZXMgYW5kXG4vLyBpbmRleGVzLCBzbyBhIHdhcmQgb3IgYSB0ZXN0IGNhbiBpbXBvcnQgdGhpcyBtb2R1bGUgYW5kIHJlYWQgdGhlIHRhYmxlLlxuZXhwb3J0IGNvbnN0IGNsaSA9IGRlZmluZUNsaSh7XG4gIG5hbWU6IFwic2NyaXB0b3JpdW1cIixcbiAgc3VtbWFyeTogXCJhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXCIsXG4gIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICBjb21tYW5kczogUk9XUy5tYXAoKHIpID0+ICh7IC4uLnIsIHJ1bjogb24oci5ydW4pLCByZWplY3RIaW50OiBEQVNIX0hJTlQgfSkpLFxuICAvLyBgc2NyaXB0b3JpdW0gLS1zZXNzaW9uIHggc3RhdGVgIHJ1bnMgYHN0YXRlYDsgYSBiYXJlIGAtLWAgbWFrZXMgdGhlIG5leHRcbiAgLy8gdG9rZW4gdGhlIHZlcmIgKGFjYyBBNikuXG4gIGdyYW1tYXI6IFwiZmxhZ3MtYW55d2hlcmVcIixcbiAgdmVyYlBvc2l0aW9uYWw6IFwidmVyYlwiLFxuICB1c2FnZUhpZGVzOiBbXCJzZXNzaW9uXCJdLFxuICB2ZXJzaW9uOiB2ZXJzaW9uSW5mbyxcbiAgaGVscEZvb3RlcjogYCAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIGFueSB2ZXJiIHRoYXQgdGFsa3MgdG8gYSBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuXG4gIEVhY2ggdmVyYiBhY2NlcHRzIG9ubHkgdGhlIGZsYWdzIG9uIGl0cyByb3cuXG5cbiAgT3V0cHV0OiBKU09OIG9uIHN0ZG91dCwgb25lIGRvY3VtZW50IHBlciBhbnN3ZXIg4oCUIGV4Y2VwdCB0YWlsIChvbmUgSlNPTiBsaW5lXG4gIHBlciBldmVudCkgYW5kIGhlbHAgKHByb3NlKS4gRmFpbHVyZXM6IG9uZSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgZXhpdFxuICAyID0gdXNhZ2UsIDEgPSBpbnRlcm5hbCwgNSA9IG5vdCBmb3VuZCwgNiA9IGNvbmZsaWN0LiB0YWlsIHdhaXRzIGZvciBhXG4gIHNlc3Npb24gcmF0aGVyIHRoYW4gZmFpbGluZywgYW5kIGVuZHMgMCB3aGVuIGl0cyBzZXNzaW9uIGNsb3Nlcy4gdGFpbFxuICAke1dJTkRPV19IRUxQfS5gLFxufSk7XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBjbGkudmVyYnM7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBzdHJpbmdbXT4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gIGNsaS5yb3dzLm1hcCgocikgPT4gW3IubmFtZSwgci5hY2NlcHRlZF0pLFxuKTtcbmV4cG9ydCBjb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiBjbGkuZmxhZ3NGb3IodmVyYik7XG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUzogcmVhZG9ubHkgc3RyaW5nW10gPSBjbGkucmVjb2duaXplZEZsYWdzO1xuXG4vLyBgZGlzcGF0Y2hgLCBub3QgdGhlIHJlZ2lzdHJ5J3MgYG1haW5gOiB0aGUga2l0IGRvZXMgbm90IHRyaWFnZSBhIG5vbi1DbGlFcnJvcjtcbi8vIHRoaXMgZG9lcy4gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzO1xuLy8gZXZlcnl0aGluZyBlbHNlIGlzIG91cnMuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgY2xpLmRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgcmVwb3J0ZWQgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgQ0xJJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIFJldHVybnMgdGhlIGNvZGUgcmF0aGVyIHRoYW4gZXhpdGluZ1xuICogKHN0ZG91dCBpcyBhIHBpcGU7IGFuIGV4cGxpY2l0IGV4aXQgdHJ1bmNhdGVzIGl0KSwgYW5kIHRha2VzIG5vIGFyZ3VtZW50c1xuICogKHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBQZXItdmVyYiBoZWxwIChwb3J0ZWQgZnJvbSBTdG9yeSBTdHVkaW8ncyBraXQpOiBgaGVscCA8dmVyYj5gIGFuZFxuICogYDx2ZXJiPiAtLWhlbHBgIChvciBgLWhgLCB3aGVuIG5vIGZsYWcgY2xhaW1zIHRoYXQgc2hvcnQpIHByaW50IG9uZSByb3cnc1xuICogdXNhZ2UsIGl0cyBsaW5lLCBlYWNoIGFjY2VwdGVkIGZsYWcgd2l0aCBpdHMgYGZsYWdIZWxwYCBsaW5lLCBhbmQgaXRzXG4gKiBgZXhhbXBsZXNgLiBUaGUgYC0taGVscGAgY2hlY2sgcnVucyBiZWZvcmUgY29udHJhY3QgNSwgb24gdGhlIHRva2VucyBiZWZvcmVcbiAqIGFueSBgLS1gLiBBIHJvdydzIGByZXF1aXJlZEZsYWdzYCBkcm9wIHRoZWlyIGJyYWNrZXRzIGluIGl0cyB1c2FnZSBhbmQgYXJlXG4gKiByZWZ1c2VkIGFzIG1pc3NpbmcgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrLlxuICpcbiAqIFRoZSBtb2R1bGUgYWRkcyBgaGVscGAsIGB2ZXJzaW9uYCBhbmQgYHNjaGVtYWAgcm93cyB1bmxlc3MgdGhlIHNwZWxsIGRlZmluZXNcbiAqIGEgcm93IG9mIHRoYXQgbmFtZSAoZ3JhcGV2aW5lJ3MgYHZlcnNpb24gLS1odW1hbmApLiBUaGV5IGFyZSBvcmRpbmFyeSByb3dzOlxuICogZGVjbGFyZWQsIHN0cmljdCwgYW5kIGdpdmVuIGBnbG9iYWxGbGFnc2AgbGlrZSBldmVyeSBvdGhlciByb3cuXG4gKi9cblxuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uL2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi93aXJlL2Vycm9yc1wiO1xuXG4vLyDilIDilIAgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZsYWdUeXBlID0gXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiO1xuXG4vKiogT25lIGBwYXJzZUFyZ3NgIG9wdGlvbiwgcGx1cyB0aGUgYGRlZmF1bHRgIG5vZGUncyBwYXJzZXIgYWxzbyB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIE9wdGlvblNwZWMgPSB7XG4gIHR5cGU6IEZsYWdUeXBlO1xuICBtdWx0aXBsZT86IGJvb2xlYW47XG4gIHNob3J0Pzogc3RyaW5nO1xuICBkZWZhdWx0Pzogc3RyaW5nIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgcmVhZG9ubHkgYm9vbGVhbltdO1xufTtcblxuZXhwb3J0IHR5cGUgT3B0aW9uc1RhYmxlID0gUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgT3B0aW9uU3BlYz4+O1xuXG5leHBvcnQgdHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbmV4cG9ydCB0eXBlIEZsYWdWYWx1ZSA9IHN0cmluZyB8IGJvb2xlYW4gfCAoc3RyaW5nIHwgYm9vbGVhbilbXTtcblxuZXhwb3J0IHR5cGUgSW52b2NhdGlvbjxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIFRoZSByZXNvbHZlZCByb3cgbmFtZTogYFwib3BlblwiYCwgYFwibm9kZSBlZGl0XCJgLCBvciBgXCJcImAgZm9yIGEgdmVyYmxlc3Mgcm9vdC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHNwZWxsaW5nIHRoZSBjYWxsZXIgdXNlZCDigJQgYW4gYWxpYXMsIHdoZW4gb25lIHdhcyB1c2VkLiAqL1xuICB0b2tlbjogc3RyaW5nO1xuICAvKiogUG9zaXRpb25hbHMgYWZ0ZXIgdGhlIHBhdGguICovXG4gIHBvczogc3RyaW5nW107XG4gIC8qKiBGbGFncyBnaXZlbiwgcGx1cyB0aGUgZGVmYXVsdHMgb2YgdGhlIGZsYWdzIHRoaXMgcm93IGFjY2VwdHMuICovXG4gIGZsYWdzOiBQYXJ0aWFsPFJlY29yZDxGLCBGbGFnVmFsdWU+Pjtcbn07XG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogYFwib3BlblwiYDsgb25lIHNwYWNlIG1lYW5zIG9uZSBsZXZlbCBvZiBuZXN0aW5nOiBgXCJub2RlIGVkaXRcImAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVhY2ggYWxpYXMgaXMgZGlzcGF0Y2hhYmxlLCBsaXN0ZWQgaW4gYHZlcmJzYCwgYW5kIGdldHMgaXRzIG93biBkZWNsYXJlZFxuICAgKiAgcm93LiBBbiBhbGlhcyBvZiBhIG5lc3RlZCByb3cgbXVzdCBzaGFyZSBpdHMgZ3JvdXA6IGBcIm5vZGUgY2hhbmdlXCJgLiAqL1xuICBhbGlhc2VzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGlzIHJvdydzIG93biBmbGFnczsgYGdsb2JhbEZsYWdzYCBhcmUgYWRkZWQgdG8gdGhlbS4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IEZbXTtcbiAgLyoqIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gdGhpcywgYW5kIGl0IGlzIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLiAqL1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIEFkZGVkIGFzIHRoZSBgaGludGAgb2YgdGhpcyByb3cncyBmbGFnIHJlamVjdGlvbnMuICovXG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIC8qKiBgZmFsc2VgIGhhbmRzIG5vZGUncyBvd24gXCJVbmV4cGVjdGVkIGFyZ3VtZW50XCIgcmVmdXNhbCBhbnkgcG9zaXRpb25hbC4gKi9cbiAgYWxsb3dQb3NpdGlvbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGF0IGVhY2ggb2YgdGhpcyByb3cncyBmbGFncyBkb2VzLCBvbmUgbGluZSBlYWNoLCBmb3IgYGhlbHAgPHZlcmI+YC4gQVxuICAgKiBmbGFnIHdpdGggbm8gbGluZSBpcyBsaXN0ZWQgYnkgbmFtZSBvbmx5LlxuICAgKi9cbiAgZmxhZ0hlbHA/OiBSZWFkb25seTxQYXJ0aWFsPFJlY29yZDxGLCBzdHJpbmc+Pj47XG4gIC8qKiBXaG9sZSBjb21tYW5kIGxpbmVzIHRoYXQgc2hvdyB0aGUgcm93IGluIHVzZSwgZm9yIGBoZWxwIDx2ZXJiPmAuICovXG4gIGV4YW1wbGVzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKlxuICAgKiBGbGFncyBvZiB0aGlzIHJvdyB0aGF0IG11c3QgYmUgZ2l2ZW46IHNob3duIHdpdGhvdXQgYnJhY2tldHMgaW4gaXRzXG4gICAqIHVzYWdlLCBhbmQgcmVmdXNlZCBhcyBtaXNzaW5nLCBsaWtlIGEgcmVxdWlyZWQgcG9zaXRpb25hbC5cbiAgICovXG4gIHJlcXVpcmVkRmxhZ3M/OiByZWFkb25seSBGW107XG4gIC8qKlxuICAgKiBGbGFnLWRlcGVuZGVudCBhcml0eSAoaW1hZ28gYGhhbmRvZmYgLS1jbGVhcmAsIG1pbmQtbWFwcGVyIGAtLXRvfC0tY2xlYXJgKVxuICAgKiBhbmQgYW55IG90aGVyIGNvbWJpbmF0aW9uIHJ1bGUuIFJ1bnMgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrOyBhIHJldHVybmVkXG4gICAqIHN0cmluZyBpcyByZWZ1c2VkIGFzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIHRoaXMgcm93LiDimqAgVGhlIGRlY2xhcmF0aW9uXG4gICAqIGNhbm5vdCBleHByZXNzIHN1Y2ggYSBydWxlOiBhIHBvc2l0aW9uYWwgdGhhdCBgLS1jbGVhcmAgbWFrZXMgdW5uZWNlc3NhcnlcbiAgICogY2FuIG9ubHkgYmUgZGVjbGFyZWQgYHJlcXVpcmVkOiBmYWxzZWAsIGFuZCB0aGlzIGhvb2sgZW5mb3JjZXMgdGhlIHJlc3QuXG4gICAqL1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb248Rj4pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgbnVtYmVyIGlzIHRoZSBleGl0IGNvZGU7IGFueXRoaW5nIGVsc2UgbWVhbnMgMC4gKi9cbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiB1bmtub3duO1xufTtcblxuLyoqIEEgdmVyYmxlc3MgQ0xJJ3Mgb25lIHJvdyAoZGlnZXN0aWZ5KS4gYHBhdGg6IFtdYCBpbiB0aGUgZGVjbGFyYXRpb24uICovXG5leHBvcnQgdHlwZSBSb290U3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IE9taXQ8Q29tbWFuZFNwZWM8Rj4sIFwibmFtZVwiIHwgXCJhbGlhc2VzXCI+O1xuXG4vKipcbiAqIFdoZXJlIGEgZ3JvdXAncyBzdWItdmVyYiBpcyBmb3VuZC5cbiAqIC0gYGFkamFjZW50YCAoZGVmYXVsdCk6IHRoZSB0b2tlbiByaWdodCBhZnRlciB0aGUgZ3JvdXAgKGBub2RlIGVkaXQgWGApLlxuICogLSBgZmlyc3QtcG9zaXRpb25hbGA6IHRoZSBmaXJzdCB0b2tlbiBhZnRlciB0aGUgZ3JvdXAgdGhhdCBpcyBuZWl0aGVyIGEgZmxhZ1xuICogICBub3IgYSBzdHJpbmcgZmxhZydzIHZhbHVlLCBzbyBmbGFncyBtYXkgY29tZSBmaXJzdDpcbiAqICAgYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWAgcmVzb2x2ZXMgdG8gYGRvYyBkZWxldGVgIChtaW5kLW1hcHBlcikuXG4gKiAgIFRoZSBzY2FuIHN0b3BzIGF0IGEgYmFyZSBgLS1gLCB3aGljaCBpcyB0aGUgZXNjYXBlIGhhdGNoIGZvciBhIHBvc2l0aW9uYWxcbiAqICAgbGl0ZXJhbGx5IG5hbWVkIGxpa2UgYSBzdWItdmVyYjogYGRvYyAtLSBkZWxldGVgIHJlYWRzIHRoZSBkb2MgXCJkZWxldGVcIi5cbiAqL1xuZXhwb3J0IHR5cGUgR3JvdXBTcGVjID0geyBzdWJWZXJiQXQ/OiBcImFkamFjZW50XCIgfCBcImZpcnN0LXBvc2l0aW9uYWxcIiB9O1xuXG5leHBvcnQgdHlwZSBDbGlTcGVjPE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+ID0ge1xuICAvKiogYFwiYm91bnR5XCJgLCB1c2VkIGluIG1lc3NhZ2VzIGFuZCB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogVGhlIHJlbmRlcmVkIGhlbHAncyBmaXJzdCBsaW5lOiBgJHtuYW1lfSDigJQgJHtzdW1tYXJ5fWAuICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIC8qKiBUaGUgbGl0ZXJhbCBgQ0xJX09QVElPTlNgIG9iamVjdC4gKi9cbiAgb3B0aW9uczogTztcbiAgY29tbWFuZHM/OiByZWFkb25seSBDb21tYW5kU3BlYzxrZXlvZiBPICYgc3RyaW5nPltdO1xuICAvKipcbiAgICogQSB2ZXJibGVzcyBDTEkncyByb3cuIFJlc2VydmVkIHRva2VucyBhcyBgYXJndlswXWAgc3RpbGwgc2VsZWN0IHRoZWlyIHJvd3NcbiAgICogKGBoZWxwYCwgYHZlcnNpb25gLCBgc2NoZW1hYCwgYW55IGBjb21tYW5kc2AsIGFuZCB0aGUgaW50ZXJjZXB0b3JzKTsgZXZlcnlcbiAgICogb3RoZXIgYXJndiwgdGhlIGVtcHR5IG9uZSBpbmNsdWRlZCwgYmVsb25ncyB0byB0aGUgcm9vdC4gQSBwb3NpdGlvbmFsIHRoYXRcbiAgICogaGFwcGVucyB0byBzcGVsbCBhIHJlc2VydmVkIHRva2VuIGdvZXMgYWZ0ZXIgYSBiYXJlIGAtLWAuXG4gICAqL1xuICByb290PzogUm9vdFNwZWM8a2V5b2YgTyAmIHN0cmluZz47XG4gIC8qKiBBY2NlcHRlZCBieSBldmVyeSByb3csIGJ5IGNvbnRyYWN0IChncmFwZXZpbmUncyBgLS1hc2AvYC0tZnJvbWApLiAqL1xuICBnbG9iYWxGbGFncz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICBncmFtbWFyPzogXCJ2ZXJiLWZpcnN0XCIgfCBcImZsYWdzLWFueXdoZXJlXCI7XG4gIC8qKiBQZXItZ3JvdXAgc3ViLXZlcmIgcGxhY2VtZW50LCBrZXllZCBieSB0aGUgZ3JvdXAgdG9rZW4gKGBcImRvY1wiYCkuICovXG4gIGdyb3Vwcz86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEdyb3VwU3BlYz4+O1xuICAvKiogVGhlIHJvb3Qgcm93J3MgcG9zaXRpb25hbCBuYW1lIGluIGBzY2hlbWFgIChgXCJjb21tYW5kXCJgOyBnbGFtb3VyOiBgXCJ2ZXJiXCJgKS4gKi9cbiAgdmVyYlBvc2l0aW9uYWw/OiBzdHJpbmc7XG4gIC8qKiBGbGFncyBsZWZ0IG9mZiBldmVyeSB1c2FnZSBsaW5lIChnbGFtb3VyJ3MgcGVyLXZlcmIgYHNlc3Npb25gKS4gKi9cbiAgdXNhZ2VIaWRlcz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICAvKiogVGhlIGB2ZXJzaW9uYCByb3cncyBwYXlsb2FkLCBge25hbWUsIHZlcnNpb259YC4gKi9cbiAgdmVyc2lvbjogKCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqIFJlcGxhY2VzIHRoZSByZW5kZXJlZCBoZWxwIChncmFwZXZpbmUpLiAqL1xuICBoZWxwPzogKCkgPT4gc3RyaW5nO1xuICAvKiogQXBwZW5kZWQgYmVsb3cgdGhlIHJlbmRlcmVkIHJvd3MuICovXG4gIGhlbHBGb290ZXI/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBEZWNsYXJlZEFyZyA9IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBGbGFnVHlwZTsgc3RhdHVzOiBcInZhbGlkXCIgfTtcbmV4cG9ydCB0eXBlIERlY2xhcmVkQ29tbWFuZCA9IHtcbiAgcGF0aDogc3RyaW5nW107XG4gIGFyZ3M6IERlY2xhcmVkQXJnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xufTtcbmV4cG9ydCB0eXBlIERlY2xhcmF0aW9uID0ge1xuICBmb3JtYXRWZXJzaW9uOiBcIjBcIjtcbiAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCI7XG4gIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBzdHJpbmdbXSB9O1xuICBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW107XG59O1xuXG4vKiogQSByb3cgYXMgdGhlIG1vZHVsZSBob2xkcyBpdCwgZm9yIHRlc3RzIGFuZCB3YXJkcy4gKi9cbmV4cG9ydCB0eXBlIFJvd1ZpZXcgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcm93J3Mgb3duIGZsYWdzLCBhcyBkZWNsYXJlZC4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogT3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCwgaW4gb3B0aW9ucy10YWJsZSBvcmRlci4gKi9cbiAgYWNjZXB0ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIGB0cnVlYCBmb3IgYSBgaGVscGAvYHZlcnNpb25gL2BzY2hlbWFgIHJvdyB0aGUgbW9kdWxlIGFkZGVkLiAqL1xuICBhdXRvOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQ2xpID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFbnZlbG9wZSBvbiBmYWlsdXJlLCByZXR1cm5zIHRoZSBleGl0IGNvZGUuIEZvciB0aGUgc3BlbGwncyBgcnVuKClgLiAqL1xuICBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhyb3dzIGBDbGlFcnJvcmAsIGZvciBhIHNwZWxsIHdob3NlIG1haW4gZG9lcyBpdHMgb3duIHRyaWFnZS4gKi9cbiAgZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIGRlY2xhcmF0aW9uKCk6IERlY2xhcmF0aW9uO1xuICByZW5kZXJIZWxwKCk6IHN0cmluZztcbiAgLyoqIE9uZSB2ZXJiJ3MgaGVscCAoYGhlbHAgPHZlcmI+YCk7IGEgdXNhZ2UgZXJyb3IgZm9yIGEgdmVyYiB0aGF0IGlzIG5vdCB0aGVyZS4gKi9cbiAgcmVuZGVyVmVyYkhlbHAocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogQSByb3cncyB1c2FnZSBsaW5lIChgXCJjbG9zZSA8aWQ+IFstLWZvcmNlXVwiYCk7IGBcIlwiYCBmb3IgYW4gdW5rbm93biBwYXRoLiAqL1xuICB1c2FnZU9mKHBhdGg6IHN0cmluZyk6IHN0cmluZztcbiAgLyoqIEV2ZXJ5IGZpcnN0IHRva2VuIHRoYXQgZGlzcGF0Y2hlczogdmVyYnMsIGFsaWFzZXMgYW5kIGdyb3VwIHRva2Vucy4gKi9cbiAgdmVyYnM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogRXZlcnkgZnVsbCBwYXRoIHRoYXQgZGlzcGF0Y2hlcywgYWxpYXNlcyBpbmNsdWRlZCAoYFwibm9kZSBlZGl0XCJgKS4gKi9cbiAgcGF0aHM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogQSByb3cncyBhY2NlcHRlZCBzZXQgYXMgYC0teGAgc3BlbGxpbmdzLCBzb3J0ZWQuIGBcIlwiYCBpcyB0aGUgcm9vdC4gKi9cbiAgZmxhZ3NGb3IocGF0aDogc3RyaW5nKTogc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmbGFnIGluIHRoZSBvcHRpb25zIHRhYmxlLCBhcyBgLS14YCwgaW4gdGFibGUgb3JkZXIuICovXG4gIHJlY29nbml6ZWRGbGFnczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJvd3M6IHJlYWRvbmx5IFJvd1ZpZXdbXTtcbn07XG5cbi8vIOKUgOKUgCBpbnRlcm5hbHMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbnR5cGUgUm93ID0gUm93VmlldyAmIHtcbiAgcmVqZWN0SGludD86IHN0cmluZztcbiAgYWxsb3dQb3NpdGlvbmFsczogYm9vbGVhbjtcbiAgZmxhZ0hlbHA6IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4+O1xuICBleGFtcGxlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIHJlcXVpcmVkOiBSZWFkb25seVNldDxzdHJpbmc+O1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5yZXF1aXJlZEZsYWdzID8/IFtdKSB7XG4gICAgICBpZiAoIWMuZmxhZ3MuaW5jbHVkZXMoZikpXG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiByZXF1aXJlcyBmbGFnIFwiJHtmfVwiLCBub3Qgb25lIG9mIGl0cyBvd25gLFxuICAgICAgICApO1xuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGZsYWdIZWxwOiB7IC4uLihjLmZsYWdIZWxwID8/IHt9KSB9IGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IHVuZGVmaW5lZD4sXG4gICAgICBleGFtcGxlczogWy4uLihjLmV4YW1wbGVzID8/IFtdKV0sXG4gICAgICByZXF1aXJlZDogbmV3IFNldChjLnJlcXVpcmVkRmxhZ3MgPz8gW10pLFxuICAgICAgY2hlY2s6IGMuY2hlY2sgYXMgUm93W1wiY2hlY2tcIl0sXG4gICAgICBydW46IGMucnVuIGFzIFJvd1tcInJ1blwiXSxcbiAgICB9O1xuICB9O1xuXG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gKHNwZWMuY29tbWFuZHMgPz8gW10pLm1hcCgoYykgPT4gdG9Sb3coYyBhcyBDb21tYW5kU3BlYywgZmFsc2UpKTtcblxuICAvLyBUaGUgYXV0byByb3dzLiBBZGRlZCBsYXN0LCBpbiB0aGlzIG9yZGVyLCB1bmxlc3MgdGhlIHNwZWxsIGhhcyBpdHMgb3duLlxuICBjb25zdCBjbGkgPSB7fSBhcyBDbGk7XG4gIGNvbnN0IGF1dG9Sb3dzOiBDb21tYW5kU3BlY1tdID0gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTiAoYWxpYXM6IC0tdmVyc2lvbiwgLVYpXCIsXG4gICAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgICAgcHJpbnRKc29uKGF3YWl0IHNwZWMudmVyc2lvbigpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSAoYWNjIGRlY2xhcmF0aW9uIHYwKVwiLFxuICAgICAgcnVuOiAoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGNsaS5kZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcImhlbHBcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICAgIGRlc2NyaWJlOlxuICAgICAgICBcInNob3cgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaCk7IGBoZWxwIDx2ZXJiPmAgc2hvd3Mgb25lIHZlcmI6IGl0cyB1c2FnZSwgZWFjaCBmbGFnLCBhbmQgZXhhbXBsZXNcIixcbiAgICAgIHJ1bjogKGludikgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0ID0gaW52LnBvcy5sZW5ndGggPiAwID8gY2xpLnJlbmRlclZlcmJIZWxwKGludi5wb3Muam9pbihcIiBcIikpIDogY2xpLnJlbmRlckhlbHAoKTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUodGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGEgb2YgYXV0b1Jvd3MpIHtcbiAgICBpZiAoIXJvd3Muc29tZSgocikgPT4gci5uYW1lID09PSBhLm5hbWUpKSByb3dzLnB1c2godG9Sb3coYSwgdHJ1ZSkpO1xuICB9XG5cbiAgY29uc3Qgcm9vdFJvdzogUm93IHwgdW5kZWZpbmVkID1cbiAgICBzcGVjLnJvb3QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvUm93KHsgLi4uKHNwZWMucm9vdCBhcyBSb290U3BlYyksIG5hbWU6IFwiXCIgfSwgZmFsc2UpO1xuXG4gIC8vIEluZGV4IGV2ZXJ5IHNwZWxsaW5nLCBhbmQgY2hlY2sgdGhlIHRhYmxlIGlzIHdlbGwgZm9ybWVkLlxuICBjb25zdCBieVRva2VuID0gbmV3IE1hcDxzdHJpbmcsIFJvdz4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgY29uc3QgcGFydHMgPSB0LnNwbGl0KFwiIFwiKTtcbiAgICAgIGlmICh0LnRyaW0oKSAhPT0gdCB8fCBwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+IHAgPT09IFwiXCIgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGJhZCBjb21tYW5kIG5hbWUgXCIke3R9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0ICE9PSByLm5hbWUgJiYgcGFydHMubGVuZ3RoICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBuZXN0IGxpa2UgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMiAmJiB0ICE9PSByLm5hbWUgJiYgcGFydHNbMF0gIT09IHIubmFtZS5zcGxpdChcIiBcIilbMF0pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3Qgc2hhcmUgdGhlIGdyb3VwIG9mIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChieVRva2VuLmhhcyh0KSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IFwiJHt0fVwiIGlzIGRlZmluZWQgdHdpY2VgKTtcbiAgICAgIGJ5VG9rZW4uc2V0KHQsIHIpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzdWJzT2YgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBieVRva2VuLmtleXMoKSkge1xuICAgIGNvbnN0IFtncm91cCwgc3ViXSA9IHQuc3BsaXQoXCIgXCIpO1xuICAgIGlmIChncm91cCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdWJzT2Yuc2V0KGdyb3VwLCBbLi4uKHN1YnNPZi5nZXQoZ3JvdXApID8/IFtdKSwgc3ViXSk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgZyBvZiBPYmplY3Qua2V5cyhzcGVjLmdyb3VwcyA/PyB7fSkpIHtcbiAgICBpZiAoIXN1YnNPZi5oYXMoZykpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBncm91cCBcIiR7Z31cIiBoYXMgbm8gc3ViLXZlcmJzYCk7XG4gIH1cblxuICBjb25zdCBwYXRocyA9IFsuLi5ieVRva2VuLmtleXMoKV07XG4gIGNvbnN0IHZlcmJzID0gWy4uLm5ldyBTZXQocGF0aHMubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbiAgY29uc3Qgcm93Rm9yID0gKHBhdGg6IHN0cmluZyk6IFJvdyB8IHVuZGVmaW5lZCA9PiAocGF0aCA9PT0gXCJcIiA/IHJvb3RSb3cgOiBieVRva2VuLmdldChwYXRoKSk7XG4gIGNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gICAgWy4uLihyb3dGb3IocGF0aCk/LmFjY2VwdGVkID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuICBjb25zdCBsYWJlbCA9IChyOiBSb3cpOiBzdHJpbmcgPT4gci5uYW1lIHx8IGNsaU5hbWU7XG5cbiAgLyoqXG4gICAqIEEgdmVyYmxlc3Mgcm9vdCdzIHJlamVjdGlvbiBgY2hvaWNlc2A6IGl0cyBvd24gZmxhZ3MgUExVUyB0aGUgaW50ZXJjZXB0b3JzLFxuICAgKiBiZWNhdXNlIHRoZSBkZWNsYXJhdGlvbiBwdWJsaXNoZXMgYm90aCBhdCBgcGF0aDogW11gIGFuZCB0aGUgcm9vdCBhbnN3ZXJzXG4gICAqIGJvdGggKHRoZSBpbnRlcmNlcHRvcnMgYXMgYGFyZ3ZbMF1gKS4gTGVhdmluZyB0aGUgaW50ZXJjZXB0b3JzIG91dCBtYWRlXG4gICAqIG9uZSBwcm9jZXNzIHNheSB0d28gdGhpbmdzIGFib3V0IGl0cyByb290IOKAlCBhY2MncyBjZW5zdXMgcmVhZCBgLS1oZWxwYCxcbiAgICogYC1oYCwgYC0tdmVyc2lvbmAgYW5kIGAtVmAgYXMgZGVjbGFyZWQtbm90LWFjY2VwdGVkLiBMb25nIHNwZWxsaW5ncyBmaXJzdFxuICAgKiAoc29ydGVkKSwgdGhlbiB0aGUgc2hvcnRzOiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHRcbiAgICogc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy5cbiAgICovXG4gIGNvbnN0IHJvb3RDaG9pY2VzOiBzdHJpbmdbXSA9ICgoKSA9PiB7XG4gICAgY29uc3QgYWxsID0gWy4uLmZsYWdzRm9yKFwiXCIpLCAuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXTtcbiAgICBjb25zdCBsb25nID0gYWxsLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKFwiLS1cIikpLnNvcnQoKTtcbiAgICByZXR1cm4gWy4uLmxvbmcsIC4uLmFsbC5maWx0ZXIoKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCItLVwiKSldO1xuICB9KSgpO1xuXG4gIC8vIOKUgOKUgCBoZWxwIOKUgOKUgFxuXG4gIGNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICAgIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xuICB9O1xuICBjb25zdCByZW5kZXJGbGFnID0gKGs6IHN0cmluZywgcmVxdWlyZWQgPSBmYWxzZSk6IHN0cmluZyA9PiB7XG4gICAgY29uc3QgZmxhZyA9IHNwZWMub3B0aW9uc1trXT8udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgLS0ke2t9YCA6IGAtLSR7a30gLi5gO1xuICAgIHJldHVybiByZXF1aXJlZCA/IGZsYWcgOiBgWyR7ZmxhZ31dYDtcbiAgfTtcbiAgY29uc3QgdXNhZ2VMaW5lID0gKHI6IFJvdyk6IHN0cmluZyA9PlxuICAgIFtcbiAgICAgIGxhYmVsKHIpLFxuICAgICAgLi4uci5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgICAuLi5yLmZsYWdzLmZpbHRlcigoaykgPT4gIWhpZGVzLmhhcyhrKSkubWFwKChrKSA9PiByZW5kZXJGbGFnKGssIHIucmVxdWlyZWQuaGFzKGspKSksXG4gICAgXS5qb2luKFwiIFwiKTtcbiAgY29uc3QgZXhwZWN0cyA9IChyOiBSb3cpOiBzdHJpbmcgPT4gYGV4cGVjdHM6ICR7dXNhZ2VMaW5lKHIpfWA7XG5cbiAgY29uc3QgcmVuZGVySGVscCA9ICgpOiBzdHJpbmcgPT4ge1xuICAgIGlmIChzcGVjLmhlbHAgIT09IHVuZGVmaW5lZCkgcmV0dXJuIHNwZWMuaGVscCgpO1xuICAgIGNvbnN0IGxpc3RlZCA9IFsuLi4ocm9vdFJvdyA/IFtyb290Um93XSA6IFtdKSwgLi4ucm93c107XG4gICAgY29uc3QgbGluZXMgPSBsaXN0ZWQubWFwKChyKSA9PiBbdXNhZ2VMaW5lKHIpLCByLmRlc2NyaWJlXSBhcyBjb25zdCk7XG4gICAgY29uc3Qgd2lkdGggPSBNYXRoLm1pbihNYXRoLm1heCguLi5saW5lcy5tYXAoKFt1XSkgPT4gdS5sZW5ndGgpKSwgNDQpO1xuICAgIGNvbnN0IGJvZHkgPSBsaW5lc1xuICAgICAgLm1hcCgoW3UsIGRdKSA9PlxuICAgICAgICB1Lmxlbmd0aCA8PSB3aWR0aCA/IGAgICR7dS5wYWRFbmQod2lkdGgpfSAgJHtkfWAgOiBgICAke3V9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICAgKVxuICAgICAgLmpvaW4oXCJcXG5cIik7XG4gICAgY29uc3QgaGVhZCA9IHNwZWMuc3VtbWFyeSA/IGAke2NsaU5hbWV9IOKAlCAke3NwZWMuc3VtbWFyeX1gIDogY2xpTmFtZTtcbiAgICBjb25zdCB0b2tlbnMgPSBgICAke0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTmA7XG4gICAgcmV0dXJuIGAke2hlYWR9XFxuXFxuJHtib2R5fVxcbiR7dG9rZW5zfSR7c3BlYy5oZWxwRm9vdGVyID8gYFxcblxcbiR7c3BlYy5oZWxwRm9vdGVyfWAgOiBcIlwifWA7XG4gIH07XG5cbiAgLyoqXG4gICAqIE9uZSB2ZXJiJ3MgaGVscDogaXRzIHVzYWdlIGxpbmUsIHdoYXQgaXQgZG9lcywgZWFjaCBmbGFnIGl0IHRha2VzIHdpdGhcbiAgICogd2hhdCBpdCBkb2VzLCBhbmQgaXRzIGV4YW1wbGVzLiBBbiB1bmtub3duIHZlcmIgaXMgYSB1c2FnZSBlcnJvciB0aGF0XG4gICAqIGxpc3RzIHRoZSB2ZXJicyB0aGVyZSBhcmUuXG4gICAqL1xuICBjb25zdCByZW5kZXJWZXJiSGVscCA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IHIgPSBieVRva2VuLmdldChwYXRoKTtcbiAgICBpZiAociA9PT0gdW5kZWZpbmVkKVxuICAgICAgcmV0dXJuIGRpZShgaGVscDogbm8gdmVyYiBcIiR7cGF0aH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBwYXRocyxcbiAgICAgICAgaGludDogXCJoZWxwIHdpdGggbm8gdmVyYiBsaXN0cyB0aGVtIGFsbFwiLFxuICAgICAgfSk7XG4gICAgY29uc3QgZmxhZ3MgPSByLmFjY2VwdGVkLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzcGVjLm9wdGlvbnNba10/LnR5cGUgPT09IFwiYm9vbGVhblwiID8gYC0tJHtrfWAgOiBgLS0ke2t9IDwke2t9PmA7XG4gICAgICByZXR1cm4gW3ZhbHVlLCByLmZsYWdIZWxwW2tdID8/IFwiXCJdIGFzIGNvbnN0O1xuICAgIH0pO1xuICAgIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoMCwgLi4uZmxhZ3MubWFwKChbZl0pID0+IGYubGVuZ3RoKSksIDI4KTtcbiAgICBjb25zdCBmbGFnTGluZXMgPSBmbGFncy5tYXAoKFtmLCBkXSkgPT5cbiAgICAgIGQgPT09IFwiXCJcbiAgICAgICAgPyBgICAke2Z9YFxuICAgICAgICA6IGYubGVuZ3RoIDw9IHdpZHRoXG4gICAgICAgICAgPyBgICAke2YucGFkRW5kKHdpZHRoKX0gICR7ZH1gXG4gICAgICAgICAgOiBgICAke2Z9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZH1gLFxuICAgICk7XG4gICAgcmV0dXJuIFtcbiAgICAgIGB1c2FnZTogJHt1c2FnZUxpbmUocil9YCxcbiAgICAgIFwiXCIsXG4gICAgICByLmRlc2NyaWJlLFxuICAgICAgLi4uKGZsYWdMaW5lcy5sZW5ndGggPiAwID8gW1wiXCIsIFwiZmxhZ3M6XCIsIC4uLmZsYWdMaW5lc10gOiBbXSksXG4gICAgICAuLi4oci5leGFtcGxlcy5sZW5ndGggPiAwID8gW1wiXCIsIFwiZXhhbXBsZXM6XCIsIC4uLnIuZXhhbXBsZXMubWFwKChlKSA9PiBgICAke2V9YCldIDogW10pLFxuICAgIF0uam9pbihcIlxcblwiKTtcbiAgfTtcblxuICAvLyDilIDilIAgdGhlIGRlY2xhcmF0aW9uIOKUgOKUgFxuXG4gIGNvbnN0IGRlY2xhcmF0aW9uID0gKCk6IERlY2xhcmF0aW9uID0+IHtcbiAgICBjb25zdCBhcmcgPSAoazogc3RyaW5nKTogRGVjbGFyZWRBcmcgPT4gKHtcbiAgICAgIG5hbWU6IGAtLSR7a31gLFxuICAgICAgdHlwZTogKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS50eXBlLFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXRoOiBbXSxcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgIC4uLklOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICAuLi4ocm9vdFJvdyA/IHJvb3RSb3cuYWNjZXB0ZWQubWFwKGFyZykgOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHBvc2l0aW9uYWxzOiByb290Um93XG4gICAgICAgICAgPyByb290Um93LnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSlcbiAgICAgICAgICA6IFt7IG5hbWU6IHNwZWMudmVyYlBvc2l0aW9uYWwgPz8gXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiB0LnNwbGl0KFwiIFwiKSxcbiAgICAgICAgICBhcmdzOiByLmFjY2VwdGVkLm1hcChhcmcpLFxuICAgICAgICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzY2hlbWFSb3cgPSBieVRva2VuLmdldChcInNjaGVtYVwiKSBhcyBSb3c7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW3NjaGVtYVJvdy5uYW1lXSB9LFxuICAgICAgY29tbWFuZHMsXG4gICAgfTtcbiAgfTtcblxuICAvLyDilIDilIAgZGlzcGF0Y2gg4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSBpbmRleCBvZiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmcgZmxhZydzXG4gICAqIHZhbHVlLCB3YWxraW5nIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsOiBgLS1rIHZgIGNvbnN1bWVzIGB2YCB3aGVuIGBrYCBpcyBhXG4gICAqIHN0cmluZyBmbGFnLCBgLS1rPXZgIGNvbnN1bWVzIG5vdGhpbmcsIGAtcyB2YCBsaWtld2lzZSBieSB0aGUgc2hvcnQncyB0eXBlLlxuICAgKiBBdCBhIGJhcmUgYC0tYDogYC0xYCB3aGVuIGBzdG9wQXRUZXJtaW5hdG9yYCwgZWxzZSB0aGUgaW5kZXggYWZ0ZXIgaXQuXG4gICAqL1xuICBjb25zdCBzY2FuUG9zaXRpb25hbCA9IChhcmdzOiBzdHJpbmdbXSwgc3RvcEF0VGVybWluYXRvcjogYm9vbGVhbik6IG51bWJlciA9PiB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBhID0gYXJnc1tpXSBhcyBzdHJpbmc7XG4gICAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gc3RvcEF0VGVybWluYXRvciB8fCBpICsgMSA+PSBhcmdzLmxlbmd0aCA/IC0xIDogaSArIDE7XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNwZWMub3B0aW9uc1thLnNsaWNlKDIpXT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpICYmIGEubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBrZXkgPSBhLmxlbmd0aCA9PT0gMiA/IHNob3J0VG9LZXkuZ2V0KGEuc2xpY2UoMSkpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgc3BlYy5vcHRpb25zW2tleV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIGNvbnN0IHdpdGhvdXQgPSAoYXJnczogc3RyaW5nW10sIGk6IG51bWJlcik6IHN0cmluZ1tdID0+IFtcbiAgICAuLi5hcmdzLnNsaWNlKDAsIGkpLFxuICAgIC4uLmFyZ3Muc2xpY2UoaSArIDEpLFxuICBdO1xuXG4gIGNvbnN0IG5vQ29tbWFuZCA9ICgpOiBuZXZlciA9PlxuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VgLFxuICAgIH0pO1xuXG4gIC8qKiBBIHZlcmIgY2FuZGlkYXRlIGFuZCB0aGUgYXJncyBhZnRlciBpdCwgdG8gYSByb3cgYW5kIHRoYXQgcm93J3MgYXJncy4gKi9cbiAgY29uc3QgcmVzb2x2ZSA9IChjYW5kOiBzdHJpbmcsIHJlc3Q6IHN0cmluZ1tdKTogeyByb3c6IFJvdzsgdG9rZW46IHN0cmluZzsgYXJnczogc3RyaW5nW10gfSA9PiB7XG4gICAgY29uc3Qgc3VicyA9IHN1YnNPZi5nZXQoY2FuZCk7XG4gICAgaWYgKHN1YnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXQgPSBzcGVjLmdyb3Vwcz8uW2NhbmRdPy5zdWJWZXJiQXQgPz8gXCJhZGphY2VudFwiO1xuICAgICAgbGV0IGkgPSAtMTtcbiAgICAgIGlmIChhdCA9PT0gXCJhZGphY2VudFwiKSB7XG4gICAgICAgIGNvbnN0IG5leHQgPSByZXN0WzBdO1xuICAgICAgICBpID0gbmV4dCAhPT0gdW5kZWZpbmVkICYmICFuZXh0LnN0YXJ0c1dpdGgoXCItXCIpID8gMCA6IC0xO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaSA9IHNjYW5Qb3NpdGlvbmFsKHJlc3QsIHRydWUpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3ViID0gaSA+PSAwID8gKHJlc3RbaV0gYXMgc3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZ1bGwgPSBzdWIgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGJ5VG9rZW4uZ2V0KGAke2NhbmR9ICR7c3VifWApO1xuICAgICAgaWYgKGZ1bGwgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4geyByb3c6IGZ1bGwsIHRva2VuOiBgJHtjYW5kfSAke3N1Yn1gLCBhcmdzOiB3aXRob3V0KHJlc3QsIGkpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBvd24gPSBieVRva2VuLmdldChjYW5kKTtcbiAgICAgIGlmIChvd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcm93OiBvd24sIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gICAgICBjb25zdCBleHRyYSA9IHsgY2hvaWNlczogWy4uLnN1YnNdLCBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgIH07XG4gICAgICBpZiAoc3ViID09PSB1bmRlZmluZWQpIGRpZShgJHtjYW5kfTogZXhwZWN0ZWQgYSBzdWItY29tbWFuZGAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgICAgZGllKGB1bmtub3duICR7Y2FuZH0gc3ViLWNvbW1hbmQ6IFwiJHtzdWJ9XCJgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICB9XG4gICAgY29uc3Qgcm93ID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoYHVua25vd24gY29tbWFuZCBcIiR7Y2FuZH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJvdywgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgfTtcblxuICAvKipcbiAgICogQ29udHJhY3QgNSdzIGAtLWAgbWFkZSB0aGUgY2FsbGVyJ3MgZmxhZyBURVhUOyBzYXkgc28gKGMxLFxuICAgKiBgZG9jcy9pdGVtcy90ZXJtaW5hdG9yLWVhdHMtc2Vzc2lvbi1rZXkubWRgKS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHNcbiAgICogYSBmbGFnIHRoaXMgcm93IGFjY2VwdHMg4oCUIGAtLWtgLCBgLS1rPXZgLCBvciB0aGUgc2hvcnQgYC1zYCBvZiBhbiBhY2NlcHRlZFxuICAgKiBga2AsIGdsb2JhbHMgaW5jbHVkZWQg4oCUIGlzIG5hbWVkIGluIE9ORSBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIsIHdpdGhcbiAgICogdGhlIG1vdmUgdGhhdCByZWNvdmVycyBpdC4gU3Rkb3V0IGFuZCB0aGUgZXhpdCBjb2RlIGRvIG5vdCBjaGFuZ2UsIGFuZCB0aGVcbiAgICogcm93IHN0aWxsIHJ1bnM6IHRleHQgY29udGFpbmluZyBhIGZsYWcgbmFtZSBpcyBsZWdpdGltYXRlLCB3aGljaCBpcyB3aGF0XG4gICAqIGAtLWAgaXMgZm9yLiBBIHRva2VuIHRoZSByb3cgZG9lcyBub3QgYWNjZXB0IGlzIGp1c3QgdGV4dCwgYW5kIHNheXMgbm90aGluZy5cbiAgICpcbiAgICog4pqgIENhbGxlZCBvbmx5IG9uY2UgZXZlcnkgcmVmdXNhbCBoYXMgcGFzc2VkLCBzbyBhIHJlZnVzZWQgaW52b2NhdGlvbidzXG4gICAqIHN0ZGVyciBpcyBzdGlsbCBleGFjdGx5IG9uZSBlbnZlbG9wZS4gVGhlIGAjIGAgcHJlZml4IGlzIHRoZSBob3VzZSdzXG4gICAqIHN1Y2Nlc3MtcGF0aCBzdGRlcnIgZm9ybSAoYCMgd2FybmluZzpgIGluIG1pbmQtbWFwcGVyLCBgIyBwaW5uZWQgYm9hcmRgLFxuICAgKiBgIyDihpIgY2hhbm5lbGApOiBhbiBlbnZlbG9wZSByZWFkZXIgbG9va3MgZm9yIGEgYHtgIGxpbmUgYW5kIHNraXBzIGl0LlxuICAgKi9cbiAgY29uc3Qgd2FybkRlbW90ZWQgPSAoXG4gICAgcm93OiBSb3csXG4gICAgYWNjZXB0ZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gICAgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBlbmQgPSB0b2tlbnM/LmZpbmRJbmRleCgodCkgPT4gdC5raW5kID09PSBcIm9wdGlvbi10ZXJtaW5hdG9yXCIpID8/IC0xO1xuICAgIGlmICh0b2tlbnMgPT09IHVuZGVmaW5lZCB8fCBlbmQgPCAwKSByZXR1cm47XG4gICAgY29uc3QgZGVtb3RlZDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rZW5zLnNsaWNlKGVuZCArIDEpKSB7XG4gICAgICBpZiAodC5raW5kICE9PSBcInBvc2l0aW9uYWxcIikgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gdC52YWx1ZTtcbiAgICAgIGxldCBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICh2LnN0YXJ0c1dpdGgoXCItLVwiKSkga2V5ID0gdi5zbGljZSgyKS5zcGxpdChcIj1cIilbMF07XG4gICAgICBlbHNlIGlmICh2Lmxlbmd0aCA9PT0gMiAmJiB2LnN0YXJ0c1dpdGgoXCItXCIpKSBrZXkgPSBzaG9ydFRvS2V5LmdldCh2LnNsaWNlKDEpKTtcbiAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBrZXkgIT09IFwiXCIgJiYgYWNjZXB0ZWQuaGFzKGtleSkpIGRlbW90ZWQucHVzaCh2KTtcbiAgICB9XG4gICAgaWYgKGRlbW90ZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgd2hpY2ggPSBkZW1vdGVkLmpvaW4oXCIsIFwiKTtcbiAgICBjb25zdCBvbmUgPSBkZW1vdGVkLmxlbmd0aCA9PT0gMTtcbiAgICBjb25zdCBpdCA9IG9uZSA/IFwiaXRcIiA6IFwidGhlbVwiO1xuICAgIGNvbnN0IHdhcyA9IG9uZSA/IFwid2FzXCIgOiBcIndlcmVcIjtcbiAgICBjb25zdCBhc0ZsYWcgPSBvbmUgPyBcImFzIGEgZmxhZ1wiIDogXCJhcyBmbGFnc1wiO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCMgd2FybmluZzogJHtjbGlOYW1lfSR7cm93Lm5hbWUgPT09IFwiXCIgPyBcIlwiIDogYCAke3Jvdy5uYW1lfWB9OiAke3doaWNofSBhZnRlciBcXGAtLVxcYCAke3dhc30gcmVhZCBhcyB0ZXh0LCBub3QgJHthc0ZsYWd9OyB0byB1c2UgJHtpdH0gJHthc0ZsYWd9LCBtb3ZlICR7aXR9IGJlZm9yZSBcXGAtLVxcYFxcbmAsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBydW5Sb3cgPSBhc3luYyAocm93OiBSb3csIHRva2VuOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChyb3cubmFtZSA9PT0gXCJcIiA/IG51bGwgOiByb3cubmFtZSk7XG4gICAgY29uc3QgbmFtZSA9IGxhYmVsKHJvdyk7XG4gICAgLy8gYDx2ZXJiPiAtLWhlbHBgIChvciBgLWhgLCB1bmxlc3MgdGhlIHNwZWxsIGdhdmUgYC1oYCBhIGZsYWcgb2YgaXRzIG93bikgaXNcbiAgICAvLyBgaGVscCA8dmVyYj5gOiBhc2tlZCBiZWZvcmUgYW55dGhpbmcgZWxzZSBpcyBjaGVja2VkLlxuICAgIGNvbnN0IGVuZCA9IGFyZ3MuaW5kZXhPZihcIi0tXCIpO1xuICAgIGNvbnN0IGJlZm9yZSA9IGVuZCA9PT0gLTEgPyBhcmdzIDogYXJncy5zbGljZSgwLCBlbmQpO1xuICAgIGlmIChcbiAgICAgIHJvdy5uYW1lICE9PSBcIlwiICYmXG4gICAgICAhcm93LmF1dG8gJiZcbiAgICAgIChiZWZvcmUuaW5jbHVkZXMoXCItLWhlbHBcIikgfHwgKGJlZm9yZS5pbmNsdWRlcyhcIi1oXCIpICYmICFzaG9ydFRvS2V5LmhhcyhcImhcIikpKVxuICAgICkge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVyVmVyYkhlbHAocm93Lm5hbWUpfVxcbmApO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICAgIGNvbnN0IGFjY2VwdGVkID0gbmV3IFNldChyb3cuYWNjZXB0ZWQpO1xuICAgIGNvbnN0IGNob2ljZXMgPSByb3cubmFtZSA9PT0gXCJcIiA/IHJvb3RDaG9pY2VzIDogZmxhZ3NGb3Iocm93Lm5hbWUpO1xuICAgIGNvbnN0IGZsYWdIaW50ID0gKCk6IHN0cmluZyB8IHVuZGVmaW5lZCA9PlxuICAgICAgW3Jvdy5yZWplY3RIaW50LCBjaG9pY2VzLmxlbmd0aCA9PT0gMCA/IGAke25hbWV9IHRha2VzIG5vIGZsYWdzYCA6IHVuZGVmaW5lZF1cbiAgICAgICAgLmZpbHRlcigocyk6IHMgaXMgc3RyaW5nID0+IHMgIT09IHVuZGVmaW5lZClcbiAgICAgICAgLmpvaW4oXCI7IFwiKSB8fCB1bmRlZmluZWQ7XG5cbiAgICBsZXQgdmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBsZXQgcG9zaXRpb25hbHM6IHN0cmluZ1tdO1xuICAgIGxldCB0b2tlbnM6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz5bXCJ0b2tlbnNcIl07XG4gICAgdHJ5IHtcbiAgICAgICh7IHZhbHVlcywgcG9zaXRpb25hbHMsIHRva2VucyB9ID0gcGFyc2VBcmdzKHtcbiAgICAgICAgYXJncyxcbiAgICAgICAgb3B0aW9uczogcGFyc2VPcHRpb25zLFxuICAgICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICAgIGFsbG93UG9zaXRpb25hbHM6IHJvdy5hbGxvd1Bvc2l0aW9uYWxzLFxuICAgICAgICB0b2tlbnM6IHRydWUsXG4gICAgICB9KSk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgaWYgKGVyckNvZGUoZSkgPT09IFwiRVJSX1BBUlNFX0FSR1NfVU5LTk9XTl9PUFRJT05cIikge1xuICAgICAgICBkaWUoYCR7bmFtZX06ICR7ZXJyTWVzc2FnZShlKX1gLCBcInVzYWdlXCIsIHsgY2hvaWNlcywgaGludDogZmxhZ0hpbnQoKSB9KTtcbiAgICAgIH1cbiAgICAgIC8vIEEgbWlzc2luZyB2YWx1ZSBpcyBub3QgYSBjaG9pY2UgZnJvbSBhIHNldCwgc28gbm8gYGNob2ljZXNgIGhlcmUuXG4gICAgICBkaWUoYCR7bmFtZX06ICR7ZXJyTWVzc2FnZShlKX1gLCBcInVzYWdlXCIsIHsgaGludDogcm93LnJlamVjdEhpbnQgPz8gZXhwZWN0cyhyb3cpIH0pO1xuICAgIH1cblxuICAgIC8vIFN0YWdlIDI6IGtub3duIHRvIHRoZSBzcGVsbCwgbm90IHRha2VuIGJ5IHRoaXMgcm93IOKAlCBNSVNQTEFDRUQsIG5vdFxuICAgIC8vIHVua25vd24uIE9ubHkgZmxhZ3MgdGhlIGNhbGxlciBHQVZFIGFyZSBoZXJlOiBkZWZhdWx0cyBhcmUgbm90IGFwcGxpZWQgeWV0LlxuICAgIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXModmFsdWVzKS5maW5kKChrKSA9PiAhYWNjZXB0ZWQuaGFzKGspKTtcbiAgICBpZiAoc3RyYXkgIT09IHVuZGVmaW5lZCkge1xuICAgICAgZGllKFxuICAgICAgICBgLS0ke3N0cmF5fSBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgJHtuYW1lfVxcYCAoaXQgaXMgYSByZWNvZ25pemVkICR7Y2xpTmFtZX0gZmxhZywganVzdCBub3QgdGhpcyAke3Jvdy5uYW1lID09PSBcIlwiID8gXCJjb21tYW5kXCIgOiBcInZlcmJcIn0ncylgLFxuICAgICAgICBcInVzYWdlXCIsXG4gICAgICAgIHsgY2hvaWNlcywgaGludDogZmxhZ0hpbnQoKSB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBBcml0eSwgZnJvbSB0aGUgZGVjbGFyZWQgc2hhcGUsIG5hbWluZyB0aGUgbWlzc2luZyBvciB0aGUgZXh0cmEgdG9rZW4uXG4gICAgY29uc3QgcmVxdWlyZWQgPSByb3cucG9zaXRpb25hbHMuZmlsdGVyKChwKSA9PiBwLnJlcXVpcmVkKS5sZW5ndGg7XG4gICAgY29uc3QgdmFyaWFkaWMgPSByb3cucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gICAgaWYgKHBvc2l0aW9uYWxzLmxlbmd0aCA8IHJlcXVpcmVkKSB7XG4gICAgICBjb25zdCBtaXNzaW5nID0gcm93LnBvc2l0aW9uYWxzW3Bvc2l0aW9uYWxzLmxlbmd0aF07XG4gICAgICBkaWUoYCR7bmFtZX06IG1pc3NpbmcgcmVxdWlyZWQgPCR7bWlzc2luZz8ubmFtZSA/PyBcImFyZ3VtZW50XCJ9PmAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBleHBlY3RzKHJvdyksXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKCF2YXJpYWRpYyAmJiBwb3NpdGlvbmFscy5sZW5ndGggPiByb3cucG9zaXRpb25hbHMubGVuZ3RoKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAke25hbWV9OiB1bmV4cGVjdGVkIGFyZ3VtZW50ICR7SlNPTi5zdHJpbmdpZnkocG9zaXRpb25hbHNbcm93LnBvc2l0aW9uYWxzLmxlbmd0aF0pfWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBoaW50OiByb3cucG9zaXRpb25hbHMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gYXJndW1lbnRzYCA6IGV4cGVjdHMocm93KSB9LFxuICAgICAgKTtcbiAgICB9XG5cbiAgICAvLyBEZWZhdWx0cyBsYXN0LCBhbmQgb25seSB0aGlzIHJvdydzLlxuICAgIGNvbnN0IGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBGbGFnVmFsdWU+ID0geyAuLi4odmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4pIH07XG4gICAgZm9yIChjb25zdCBrIG9mIHJvdy5hY2NlcHRlZCkge1xuICAgICAgY29uc3QgZCA9IChzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYykuZGVmYXVsdDtcbiAgICAgIGlmIChmbGFnc1trXSA9PT0gdW5kZWZpbmVkICYmIGQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBmbGFnc1trXSA9IChBcnJheS5pc0FycmF5KGQpID8gWy4uLmRdIDogZCkgYXMgRmxhZ1ZhbHVlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGZvciAoY29uc3QgayBvZiByb3cucmVxdWlyZWQpXG4gICAgICBpZiAoZmxhZ3Nba10gPT09IHVuZGVmaW5lZClcbiAgICAgICAgZGllKGAke25hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIC0tJHtrfWAsIFwidXNhZ2VcIiwgeyBoaW50OiBleHBlY3RzKHJvdykgfSk7XG5cbiAgICBjb25zdCBpbnY6IEludm9jYXRpb24gPSB7IHBhdGg6IHJvdy5uYW1lLCB0b2tlbiwgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3MgfTtcbiAgICBjb25zdCByZWZ1c2VkID0gcm93LmNoZWNrPy4oaW52KTtcbiAgICBpZiAocmVmdXNlZCAhPT0gdW5kZWZpbmVkKSBkaWUoYCR7bmFtZX06ICR7cmVmdXNlZH1gLCBcInVzYWdlXCIsIHsgaGludDogZXhwZWN0cyhyb3cpIH0pO1xuXG4gICAgd2FybkRlbW90ZWQocm93LCBhY2NlcHRlZCwgdG9rZW5zKTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCByb3cucnVuKGludik7XG4gICAgcmV0dXJuIHR5cGVvZiBvdXQgPT09IFwibnVtYmVyXCIgPyBvdXQgOiAwO1xuICB9O1xuXG4gIGNvbnN0IGRpc3BhdGNoID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChhcmd2WzBdID8/IG51bGwpO1xuICAgIGNvbnN0IGZpcnN0ID0gYXJndlswXTtcblxuICAgIC8vIDEuIEludGVyY2VwdG9ycyBwYXNzIHRoZSByZXN0IG9mIHRoZSBhcmd2IG9uIHRvIHRoZWlyIHJvdy5cbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IElOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGZpcnN0KTtcbiAgICBpZiAoaW50ZXJjZXB0b3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHJ1blJvdyhieVRva2VuLmdldChpbnRlcmNlcHRvci5ydW5zKSBhcyBSb3csIGludGVyY2VwdG9yLnJ1bnMsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgIH1cblxuICAgIC8vIDIuIEEgdmVyYmxlc3Mgcm9vdCBvd25zIGV2ZXJ5IGFyZ3YgdGhhdCBkb2VzIG5vdCBzdGFydCB3aXRoIGEgcmVzZXJ2ZWQgdG9rZW4uXG4gICAgaWYgKHJvb3RSb3cgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpcnN0ICE9PSB1bmRlZmluZWQgJiYgKGJ5VG9rZW4uaGFzKGZpcnN0KSB8fCBzdWJzT2YuaGFzKGZpcnN0KSkpIHtcbiAgICAgICAgY29uc3QgciA9IHJlc29sdmUoZmlyc3QsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgICAgICByZXR1cm4gcnVuUm93KHIucm93LCByLnRva2VuLCByLmFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJ1blJvdyhyb290Um93LCBcIlwiLCBhcmd2KTtcbiAgICB9XG5cbiAgICAvLyAzLiBCYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciAoYWNjIEMyL0QyKS5cbiAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vQ29tbWFuZCgpO1xuXG4gICAgLy8gNC4gRmluZCB0aGUgdmVyYi5cbiAgICBsZXQgY2FuZDogc3RyaW5nO1xuICAgIGxldCByZXN0OiBzdHJpbmdbXTtcbiAgICBpZiAoZ3JhbW1hciA9PT0gXCJ2ZXJiLWZpcnN0XCIpIHtcbiAgICAgIGlmIChmaXJzdCA9PT0gXCItLVwiKSB7XG4gICAgICAgIGlmIChhcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgICAgY2FuZCA9IGFyZ3ZbMV07XG4gICAgICAgIHJlc3QgPSBbXCItLVwiLCAuLi5hcmd2LnNsaWNlKDIpXTtcbiAgICAgIH0gZWxzZSBpZiAoZmlyc3Quc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICAgICAgcmV0dXJuIGRpZShgdW5rbm93biBmbGFnIGF0IHRoZSByb290OiAke2ZpcnN0fWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGNob2ljZXM6IFsuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXSxcbiAgICAgICAgICBoaW50OiBgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7dmVyYnMuam9pbihcIiBcIil9YCxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjYW5kID0gZmlyc3Q7XG4gICAgICAgIHJlc3QgPSBhcmd2LnNsaWNlKDEpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpID0gc2NhblBvc2l0aW9uYWwoYXJndiwgZmFsc2UpO1xuICAgICAgaWYgKGkgPCAwKSB7XG4gICAgICAgIC8vIE5vIHZlcmIgYW55d2hlcmU6IGFuIHVua25vd24gZmxhZyBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQsXG4gICAgICAgIC8vIGFuZCBhIGNsZWFuIHBhcnNlIGlzIGEgYmFyZSBpbnZvY2F0aW9uLiBOZWl0aGVyIHJhbiBhIGNvbW1hbmQsIHNvXG4gICAgICAgIC8vIHRoZSBlbnZlbG9wZSdzIGBtZXRhLmNvbW1hbmRgIGlzIG51bGwsIG5vdCB0aGUgZmlyc3QgZmxhZydzXG4gICAgICAgIC8vIHNwZWxsaW5nIChgZ2xhbW91ciAtLWJvZ3VzYCBuYW1lcyBubyB2ZXJiKS5cbiAgICAgICAgc2V0Q3VycmVudENvbW1hbmQobnVsbCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogcGFyc2VPcHRpb25zLCBzdHJpY3Q6IHRydWUsIGFsbG93UG9zaXRpb25hbHM6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBkaWUoZXJyTWVzc2FnZShlKSwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgICBoaW50OiBgbm8gY29tbWFuZCBnaXZlbiDigJQgY29tbWFuZHM6ICR7dmVyYnMuam9pbihcIiBcIil9IChydW46ICR7Y2xpTmFtZX0gaGVscClgLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgIH1cbiAgICAgIGNhbmQgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICAgIC8vIEEgdmVyYiBmb3VuZCByaWdodCBhZnRlciBhIGAtLWAgbGVhdmVzIHRoYXQgYC0tYCBpbiBwbGFjZSwgc28gdGhlXG4gICAgICAvLyByZXN0IG9mIHRoZSBhcmd2IHN0YXlzIHBvc2l0aW9uYWwuXG4gICAgICByZXN0ID0gd2l0aG91dChhcmd2LCBpKTtcbiAgICB9XG4gICAgc2V0Q3VycmVudENvbW1hbmQoY2FuZCk7XG4gICAgY29uc3QgciA9IHJlc29sdmUoY2FuZCwgcmVzdCk7XG4gICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgfTtcblxuICBjb25zdCBtYWluID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICAgIC8vIFRoZSBob3VzZSBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS4gQSBzcGVsbCB0aGF0XG4gICAgICAvLyB0cmlhZ2VzIGl0cyBvd24gKGdsYW1vdXIncyBFTk9FTlQg4oaSIHVzYWdlKSBjYWxscyBgZGlzcGF0Y2hgIGluc3RlYWQuXG4gICAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgZXJyTWVzc2FnZShlKSkpID8/IDE7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHZpZXcgPSAocjogUm93KTogUm93VmlldyA9PiAoe1xuICAgIG5hbWU6IHIubmFtZSxcbiAgICBhbGlhc2VzOiByLmFsaWFzZXMsXG4gICAgZmxhZ3M6IHIuZmxhZ3MsXG4gICAgYWNjZXB0ZWQ6IHIuYWNjZXB0ZWQsXG4gICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMsXG4gICAgZGVzY3JpYmU6IHIuZGVzY3JpYmUsXG4gICAgYXV0bzogci5hdXRvLFxuICB9KTtcblxuICBPYmplY3QuYXNzaWduKGNsaSwge1xuICAgIG5hbWU6IGNsaU5hbWUsXG4gICAgbWFpbixcbiAgICBkaXNwYXRjaCxcbiAgICBkZWNsYXJhdGlvbixcbiAgICByZW5kZXJIZWxwLFxuICAgIHJlbmRlclZlcmJIZWxwLFxuICAgIHVzYWdlT2Y6IChwYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHIgPSByb3dGb3IocGF0aCk7XG4gICAgICByZXR1cm4gciA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IHVzYWdlTGluZShyKTtcbiAgICB9LFxuICAgIHZlcmJzLFxuICAgIHBhdGhzLFxuICAgIGZsYWdzRm9yLFxuICAgIHJlY29nbml6ZWRGbGFnczogb3B0aW9uS2V5cy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICByb3dzOiByb3dzLm1hcCh2aWV3KSxcbiAgfSBzYXRpc2ZpZXMgQ2xpKTtcbiAgcmV0dXJuIGNsaTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRlcGVuZGVuY3ktZnJlZSBhbmQgZGVsaWJlcmF0ZWx5IGR1bGw6IGl0IGlzIGJ1bmRsZWQgSU5UTyBlYWNoXG4gKiBzcGVsbCdzIGVtaXR0ZWQgQ0xJIChDb250cmFjdCA0J3MgYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLCBzbyBhbnl0aGluZyBpdFxuICogcmVhY2hlZCBmb3Igd291bGQgYmVjb21lIGEgZGVwZW5kZW5jeSBvZiB0d28gc2hpcHBlZCBhcnRpZmFjdHMgYXQgb25jZS5cbiAqXG4gKiBUaGUgd2lyZSBjb250cmFjdCBpdCBlbmNvZGVzOiBleGFjdGx5IG9uZSBKU09OIGRvY3VtZW50LCBvbmUgdHJhaWxpbmdcbiAqIG5ld2xpbmUsIG5vdGhpbmcgZWxzZSBvbiBzdGRvdXQuIEEgY2FsbGVyIHJlYWRpbmcgb3VyIHN0ZG91dCB3aXRoIGFcbiAqIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBkZXBlbmRzIG9uIHRoYXQgbmV3bGluZTsgYSBjYWxsZXIgcmVhZGluZyB0byBFT0ZcbiAqIGRlcGVuZHMgb24gdGhlcmUgYmVpbmcgbm8gc2Vjb25kIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pOiB2b2lkIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLy8gU2Vzc2lvbiBlbmRpbmdzIGFyZSBvdXRjb21lcywgbm90IGZhaWx1cmVzLCBhbmQgc3RheSBvdXRzaWRlIHRoZSB0YXhvbm9teTpcbi8vIGFuIGFnZW50IHJlYWRzIHRoZW0gYXMgXCJ0aGUgc2Vzc2lvbiBlbmRlZCB0aGlzIHdheVwiLCBub3QgXCJ0aGUgdmVyYiBicm9rZVwiLlxuLy8gVGhlIG51bWJlcnMgYXJlIHRoZSBzaGVsbCdzIChgdGltZW91dGAncyAxMjQsIFNJR0lOVCdzIDEyOCArIDIpLCBzbyBhXG4vLyB3cmFwcGVyIHRoYXQgYWxyZWFkeSBrbm93cyB0aGVtIG5lZWRzIG5vIHRhYmxlLlxuLyoqIEEgZGFlbW9uIHRoYXQgY2xvc2VkIGl0c2VsZiBhZnRlciBpdHMgaWRsZSB0aW1lb3V0LiBBbiBvdXRjb21lLCBub3QgYSBmYWlsdXJlLiAqL1xuZXhwb3J0IGNvbnN0IEVYSVRfSURMRV9USU1FT1VUID0gMTI0O1xuLyoqIFRoZSB1c2VyIGNhbmNlbGxlZC4gQW4gb3V0Y29tZSwgbm90IGEgZmFpbHVyZS4gKi9cbmV4cG9ydCBjb25zdCBFWElUX0NBTkNFTExFRCA9IDEzMDtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYHRva2VuYCBpcyBhIHN0YWJsZSBtYWNoaW5lLXJlYWRhYmxlIG5hbWVcbiAqIGZvciB0aGUgY2F1c2UgKGBub19zZXNzaW9uYCksIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IHRva2VuPzogc3RyaW5nOyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAvLyBPbmx5IHByZXNlbnQgd2hlbiBnaXZlbiwgc28gYW4gZW52ZWxvcGUgd2l0aG91dCBvbmUga2VlcHMgaXRzIGJ5dGVzLlxuICAgICAgLi4uKGV4dHJhPy50b2tlbiA/IHsgdG9rZW46IGV4dHJhLnRva2VuIH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgICAgLy8gTGFzdCwgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCB0aGlzIGtleSBrZWVwcyBpdHMgYnl0ZSBvcmRlci5cbiAgICAgIC4uLihleHRyYT8uc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZXh0cmEuc2VydmVyIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaXRlbXMvdGFpbC1yZWFkZXItY29udmVyZ2VuY2Uvd3JpdGUtdXAubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkIElOVE8gVEhJUyBNT0RVTEUsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW5cbiAqIDEuMy4xNCBmaW5kaW5nIHRoYXQgYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLlxuICogSXQgaXMgYSBEQUVNT04tc2lkZSBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb25cbiAqIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnkgY2xpZW50LlxuICpcbiAqIOKblCBBTkQgSVQgRElEIEdFVCBBIEhPTUUg4oCUIFNBWSBTTywgQkVDQVVTRSBUSElTIFNFTlRFTkNFIFVTRUQgVE8gRU5EIFwiaXQgc3RheXNcbiAqIHdoZXJlIGl0IHdhcyBtZWFzdXJlZFwiIEFORCBUSEFUIElTIEZBTFNFLiBSZWFkIGF0IHBvcnQgdGltZSBpdCBwb2ludGVkIGFcbiAqIHJlYWRlciBhdCBgbWluZC1tYXBwZXIvc2NyaXB0cy9zZXJ2ZXIudHNgLCBhIGZpbGUgd2hvc2UgbG9jYWwgYHNzZVJlc3BvbnNlYFxuICogdGhlIGJhY2tlbmQgcG9ydCBtaWdodCByZXBsYWNlLCBzbyB0aGUgbWVhc3VyZW1lbnQgbG9va2VkIGF0IHJpc2suIEl0IHdhc1xuICogbm90OiB0aGUgZGFlbW9uIGhhbGYgbGFuZGVkIGluIGAuL3NzZS50c2AgdGhlIHNhbWUgZGF5LCB1bmRlciBpdHMgb3duIGhlYWRpbmdcbiAqIChcIlRIRSBTQ0FSLCBSRS1IT01FRDogYHRyeSB7IGVucXVldWUgfSBjYXRjaGAgRE9FUyBOT1QgREVURUNUIEEgREVBRFxuICogQ0xJRU5UXCIpLCB3aXRoIHRoZSB0ZWFyZG93bi1mdW5uZWwgcnVsaW5nIGFuZCB0aGUgc2FtZSBrbm93biBob2xlLlxuICpcbiAqIOKaoCAqKkFORCBUSEUgUE9SVCBIQVMgU0lOQ0UgSEFQUEVORUQsIFdISUNIIFNFVFRMRVMgSVQuKiogbWluZC1tYXBwZXIncyBkYWVtb25cbiAqIGlzIG5vdyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvc2VydmVyLnRzYCBhbmQgaXQgRElEIHJlcGxhY2UgaXRzIGxvY2FsXG4gKiBgc3NlUmVzcG9uc2VgIHdpdGggYC4vc3NlLnRzYCdzIChQaGFzZSA3LCAyMDI2LTA5LTA5KSDigJQgc28gdGhlIG9ubHkgY29waWVzIG9mXG4gKiB0aGF0IG1lYXN1cmVtZW50IGFyZSB0aGUga2l0J3MgYW5kIHRoZSB0d28gdGVzdCBmaWxlcyB0aGF0IFBST1ZFIGl0LFxuICogYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3ByZXNlbmNlLnRlc3QudHNgIGFuZCBgc3NlLWtlZXBhbGl2ZS50ZXN0LnRzYC4gVGhlXG4gKiByaXNrIHRoaXMgcGFyYWdyYXBoIGRlc2NyaWJlZCBpcyBjbG9zZWQsIGluIHRoZSBkaXJlY3Rpb24gaXQgaG9wZWQgZm9yLlxuICpcbiAqIFRoZSBnZW5lcmFsIHNoYXBlLCB3b3J0aCB0aGUgZm91ciBsaW5lcyAoRDgzKTogYSByZWZ1c2FsIHJlY29yZGVkIGluIE9ORVxuICogbW9kdWxlJ3MgaGVhZGVyIGNhbm5vdCBiZSByZWFkIGZyb20gdGhlIG1vZHVsZSBpdCBwb2ludHMgQVQuIFdoZW4gYSByZWZ1c2FsXG4gKiBuYW1lcyBhbm90aGVyIG1vZHVsZSBhcyB0aGUgcmlnaHQgaG9tZSwgc2F5IHdoZXRoZXIgaXQgZ290IHRoZXJlLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLlxuICAgKlxuICAgKiAg4puUIEFORCBXSEVOIFRIRSBORVcgTE9HIFdBUyBBTFJFQURZIFBBU1QgVEhFIEJPT0tNQVJLLCBUSEUgQ0xJRU5UXG4gICAqICBSRUNPTk5FQ1RTIEZST00gSVRTIFNUQVJULiBBIGRhZW1vbiB0aGF0IGJlbGlldmVzIHRoZSBjdXJzb3Igc2VuZHMgb25seVxuICAgKiAgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hbiBtZXNzYWdlIGF0XG4gICAqICBuZXcgaWQgMiB1bmRlciBhbiBvbGQgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHNpbGVudGx5LiBFdmVyeXRoaW5nIGluXG4gICAqICBhIG5ldyBlcG9jaCBpcyBuZXcgdG8gdGhpcyByZWFkZXIsIHNvIHRoZSBhdHRlbXB0IGlzIGRyb3BwZWQgYW5kIHJlLW1hZGVcbiAgICogIGZyb20gMCBhdCBvbmNlIChubyBiYWNrb2ZmKS4gQSBmcmFtZSBBVCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIG1lYW5zXG4gICAqICB0aGUgZGFlbW9uIGlzIGFscmVhZHkgcmVwbGF5aW5nIHdob2xlLCBhbmQgaXMga2VwdC4gKFJldmlld2VyJ3MgRDIgZ2FwLFxuICAgKiAgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYuKSAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqIFRoZSBlcG9jaCB0aGUgc3RhcnRpbmcgYHNpbmNlYCBjYW1lIGZyb20sIHdoZW4gdGhlIGNhbGxlciBoYXMgb25lIChhXG4gICAqICBib29rbWFyayBwcmludGVkIGFzIGBOQDxlcG9jaD5gLCBgLi90YWlsSGFuZG9mZi50c2ApLiBUaGUgZmlyc3QgZnJhbWUgb2YgYVxuICAgKiAgZGlmZmVyZW50IGVwb2NoIGlzIHRoZW4gYW4gZXBvY2ggY2hhbmdlIGxpa2UgYW55IG90aGVyIOKAlCB3aGljaCBpcyB3aGF0XG4gICAqICBzdG9wcyBhIGJvb2ttYXJrIG91dGxpdmluZyBpdHMgbG9nIGFjcm9zcyBwcm9jZXNzZXMuICovXG4gIHNpbmNlRXBvY2g/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSZWFkIGEgZnJhbWUgd2hvc2UgaWQgaXMgQVQgT1IgQkVMT1cgdGhlIGN1cnNvciB0aGlzIGNvbm5lY3Rpb24gYXNrZWRcbiAgICogZnJvbSBhcyBcInRoZSBsb2cgcmVzdGFydGVkXCIsIHJlc2V0IHRoZSBjdXJzb3IgdG8gMCwgYW5kIGNhbGxcbiAgICogYG9uRXBvY2hDaGFuZ2VgICh3aXRoIHRoZSBmcmFtZSdzIGVwb2NoLCBvciBgXCJ1bmtub3duXCJgKS4gRGVmYXVsdCBmYWxzZS5cbiAgICpcbiAgICog4puUIFdIWSBJVCBJUyBIT05FU1Q6IHRoZSBraXQncyBldmVudCBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93blxuICAgKiBieSByZXBsYXlpbmcgV0hPTEUgKGAuL2V2ZW50TG9nLnRzYCwgcG9pbnQgMyksIGFuZCBvdGhlcndpc2Ugc2VuZHMgb25seVxuICAgKiBpZHMgYWJvdmUgdGhlIGN1cnNvci4gU28gYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGV4aXN0cyBvbmx5XG4gICAqIHdoZW4gdGhlIGRhZW1vbiBqdWRnZWQgdGhlIGN1cnNvciBmb3JlaWduIOKAlCBhIHJlc3RhcnRlZCBkYWVtb24sIHdob3NlIGlkc1xuICAgKiBiZWdhbiBhZ2FpbiBhdCAxLiBUaGUgZXBvY2ggY2F0Y2hlcyB0aGF0IFdJVEhJTiBvbmUgcHJvY2VzczsgdGhpcyBjYXRjaGVzXG4gICAqIGl0IEFDUk9TUyBwcm9jZXNzZXMsIHdoZXJlIGEgcmUtYXJtZWQgdGFpbCBjYXJyaWVzIGEgYm9va21hcmsgZnJvbSBhIGxvZ1xuICAgKiB0aGF0IG5vIGxvbmdlciBleGlzdHMgYW5kLCB3aXRob3V0IGl0LCBrZXB0IHRoYXQgYm9va21hcmsgZm9yZXZlcjogZXZlcnlcbiAgICogcmUtYXJtIHJlcGxheWVkIHRoZSB3aG9sZSBuZXcgbG9nLCBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcFxuICAgKiAoZm91bmQgYnkgdGhlIHZlcmlmaWVyIG9uIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCBhZnRlciBgdGFpbC5sb3N0YCDihpJcbiAgICogYG9wZW4gLS1yZXN0b3JlYCkuXG4gICAqXG4gICAqIOKaoCBPTkxZIEZPUiBBIERBRU1PTiBPTiBUSEUgS0lUJ1MgRVZFTlQgTE9HLiBHcmFwZXZpbmUncyBpZHMgYXJlIHJlY292ZXJlZFxuICAgKiBhY3Jvc3MgYSByZXN0YXJ0IGFuZCBpdHMgYC0tbGFzdGAgcXVlcnkgb3ZlcnJpZGVzIGBzaW5jZWAsIHNvIGl0IGxlYXZlc1xuICAgKiB0aGlzIG9mZi4gQW5kIHRoZSBibGluZCBzcG90IGlzIHN0YXRlZDogYSBib29rbWFyayB0aGF0IGhhcHBlbnMgdG8gYmUgYXRcbiAgICogb3IgYmVsb3cgdGhlIFJFU1RBUlRFRCBsb2cncyBvd24gbGVuZ3RoIGxvb2tzIHZhbGlkIHRvIHRoZSBkYWVtb24sIHdoaWNoXG4gICAqIHRoZW4gc2VuZHMgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQuIFRoZSBjb21lLWJhY2sgcGF0aCB0aGVyZWZvcmUgZHJvcHNcbiAgICogdGhlIGJvb2ttYXJrIGFsdG9nZXRoZXIgKGAuL3RhaWxIYW5kb2ZmLnRzYCwgRDIpLCBzbyB0aGlzIGlzIHRoZSBuZXQsIG5vdFxuICAgKiB0aGUgcnVsZS5cbiAgICovXG4gIHJlc3RhcnRPblJlcGxheT86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIEZJTFRFUiBhbmQgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBTY29wZSDiiKcgwqxzZWxmLWVjaG8uIEEgcmVqZWN0ZWQgZXZlbnQgc3RpbGwgQURWQU5DRVMgVEhFIENVUlNPUi4gKi9cbiAgYWNjZXB0PzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogVGhlIGxpbmUgdG8gd3JpdGUgZm9yIGFuIGFjY2VwdGVkIGV2ZW50LCBvciBudWxsIHRvIHdyaXRlIG5vdGhpbmcuXG4gICAqICBEZWZhdWx0OiB0aGUgZnJhbWUncyBkYXRhIHZlcmJhdGltLiBSZWNlaXZlcyB0aGUgZnJhbWUsIHNvIGEgY2xpZW50IHRoYXRcbiAgICogIGJyYW5jaGVzIG9uIGEgbmFtZWQgbm9uLWRhdGEgZnJhbWUgKGBldmVudDogc3Vic2NyaWJlZGApIGlzIHNlcnZlZCBoZXJlXG4gICAqICByYXRoZXIgdGhhbiBuZWVkaW5nIGEgaGF0Y2ggb2YgaXRzIG93bi4gKi9cbiAgcmVuZGVyPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogQSBmcmFtZSB3aG9zZSBkYXRhIHdpbGwgbm90IHBhcnNlLiBEZWZhdWx0OiBza2lwIGl0LiDim5QgVEhFIFJFVFVSTkVEIExJTkVcbiAgICogR09FUyBUTyBgZXJyYCwgTk9UIGBvdXRgIOKAlCBpdCBpcyBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSwgYW5kIHN0ZG91dFxuICAgKiBjYXJyaWVzIGRhdGEuIEEgc3BlbGwgdGhhdCBnZW51aW5lbHkgd2FudHMgdGhlIHVucGFyc2VkIGxpbmUgb24gc3Rkb3V0XG4gICAqIChvbmUgZG9lcykgd3JpdGVzIGl0IGZyb20gaW5zaWRlIHRoaXMgaG9vayBhbmQgcmV0dXJucyBudWxsLlxuICAgKlxuICAgKiDimqAgVGhlIGN1cnNvciBjYW5ub3QgYWR2YW5jZSBwYXN0IGEgZnJhbWUgbm9ib2R5IGNhbiByZWFkLCBzbyBhIFBFUk1BTkVOVExZXG4gICAqIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gYGFjY2VwdGVkYCBpcyBgYWNjZXB0YCdzXG4gICAqICB2ZXJkaWN0IG9uIHRoaXMgZnJhbWUsIHdoaWNoIGlzIHdoYXQgbGV0cyBgdGFpbCAtLW9uY2VgIGVuZCBvbiB0aGUgZmlyc3RcbiAgICogIGZyYW1lIGl0IGFjdHVhbGx5IERFTElWRVJTIChgLi90YWlsSGFuZG9mZi50c2ApLlxuICAgKlxuICAgKiAg4puUIEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OIGJlZm9yZSB0aGUgY2xpZW50IHJldHVybnMuIEl0XG4gICAqICB1c2VkIHRvIHJldHVybiBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIHdpdGggdGhlIFNTRSBzdHJlYW0gc3RpbGwgb3BlbixcbiAgICogIHdoaWNoIGtlcHQgdGhlIHByb2Nlc3MgYWxpdmUg4oCUIHVuc2VlbiBmb3IgYGNsb3NlZGAsIGJlY2F1c2UgdGhlIHNlcnZlclxuICAgKiAgZW5kcyB0aGF0IHN0cmVhbSBpdHNlbGYsIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFza1xuICAgKiAgd291bGQgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQuIChBZGp1c3RtZW50IDEgb2YgdGhlXG4gICAqICBNb25pdG9yLWV4cGlyeSBzcGlrZTsgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lLCBhY2NlcHRlZDogYm9vbGVhbikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBDYWxsZWQgb25jZSBhcyB0aGUgdGFpbCBlbmRzLCB3aXRoIHRoZSBmaW5hbCBjdXJzb3IgKHRoZSBib29rbWFyayBhIHJlLWFybVxuICAgKiBwYXNzZXMgYXMgYC0tc2luY2VgKSBhbmQgd2h5IGl0IGVuZGVkLiBBIFJFUE9SVCBTSU5LIGxpa2UgYG9uRGlzY29ubmVjdGAsXG4gICAqIG5vdCBhIGJlaGF2aW91cmFsIGhhdGNoOiBpdCBjaGFuZ2VzIG5vdGhpbmcgdGhlIGNsaWVudCBkb2VzLiBJdCBleGlzdHNcbiAgICogZm9yIGAuL3RhaWxIYW5kb2ZmLnRzYCwgd2hvc2UgbGFzdCBsaW5lIG5hbWVzIHRoZSByZS1hcm0gYW5kIG11c3QgY2FycnlcbiAgICogdGhlIGN1cnNvciBleGFjdGx5IGFzIHRoaXMgbG9vcCBsZWZ0IGl0LCBlcG9jaCByZXNldHMgaW5jbHVkZWQuXG4gICAqL1xuICBvbkVuZD86IChlbmQ6IHtcbiAgICBjdXJzb3I6IG51bWJlcjtcbiAgICAvKiogVGhlIGVwb2NoIG9mIHRoZSBsb2cgdGhlIGN1cnNvciBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZS4gKi9cbiAgICBlcG9jaDogc3RyaW5nIHwgbnVsbDtcbiAgICByZWFzb246IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCI7XG4gIH0pID0+IHZvaWQ7XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7XG4gIGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7XG4gIGNvbW1lbnRzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGVyciA9IG9wdHMuZXJyID8/IHByb2Nlc3Muc3RkZXJyO1xuICBjb25zdCBpZGxlTXMgPSBvcHRzLmlkbGVNcyA/PyBERUZBVUxUX0lETEVfTVM7XG4gIGNvbnN0IHJldHJ5ID0gb3B0cy5yZXRyeSA/PyBERUZBVUxUX1JFVFJZO1xuICBjb25zdCBjdXJzb3JQb2xpY3kgPSBvcHRzLmN1cnNvclBvbGljeSA/PyBcIm1vbm90b25pY1wiO1xuXG4gIGxldCBjdXJzb3IgPSBvcHRzLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IG51bGwgPSBvcHRzLnNpbmNlRXBvY2ggPz8gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG4gIGxldCBlbmRpbmc6IFwidGVybWluYWxcIiB8IFwidW5yZXNvbHZlZFwiIHwgXCJzdG9wcGVkXCIgPSBcInN0b3BwZWRcIjtcblxuICAvLyBPbmUgc3RvcCBzd2l0Y2ggZm9yIGV2ZXJ5IHdheSB0aGlzIGxvb3AgY2FuIGVuZDogYSBzaWduYWwsIGEgY2FsbGVyJ3NcbiAgLy8gYWJvcnQsIGEgZG93bnN0cmVhbSByZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0LiBFYWNoIHNldHMgaXQsIGFib3J0cyB0aGVcbiAgLy8gaW4tZmxpZ2h0IGF0dGVtcHQgQU5EIFdBS0VTIFRIRSBCQUNLT0ZGOyB0aGUgbG9vcCB0aGVuIGZhbGxzIG91dCBhbmRcbiAgLy8gUkVUVVJOUy5cbiAgLy9cbiAgLy8g4puUIFdBS0lORyBUSEUgQkFDS09GRiBJUyBOT1QgQSBERVRBSUwg4oCUIElUIElTIFRIRSBDdHJsLUMgUEFUSC4gSW5zdGFsbGluZyBhXG4gIC8vIFNJR0lOVCBsaXN0ZW5lciBTVVBQUkVTU0VTIHRoZSBydW50aW1lJ3MgZGVmYXVsdCB0ZXJtaW5hdGUsIHNvIHdoYXRldmVyXG4gIC8vIHRoaXMgY2xpZW50IGRvZXMgb24gYSBzaWduYWwgaXMgbm93IHRoZSB3aG9sZSBvZiB3aGF0IGhhcHBlbnMuIEEgZmlyc3RcbiAgLy8gdmVyc2lvbiBhYm9ydGVkIHRoZSBhdHRlbXB0IGFuZCBsZWZ0IHRoZSByZWNvbm5lY3Qgc2xlZXBpbmcgb24gYSBiYXJlXG4gIC8vIHRpbWVyOiBDdHJsLUMgZHVyaW5nIGJhY2tvZmYgdG9vayB1cCB0byBgcmV0cnkubWF4TXNgIGluc3RlYWQgb2YgZW5kaW5nIGF0XG4gIC8vIG9uY2UsIG1lYXN1cmVkIGF0IDIuODBzIGFnYWluc3QgYSBkZWFkIHBvcnQgd2hlcmUgdGhlIGhhbmQtd3JpdHRlbiBsb29wXG4gIC8vIHRvb2sgMC4xM3Mg4oCUIGFuZCBoYW1tZXJpbmcgQ3RybC1DIGRpZCBub3QgaGVscCwgYmVjYXVzZSBldmVyeSByZXBlYXQgaGl0XG4gIC8vIHRoZSBzYW1lIHNsZWVwaW5nIHRpbWVyLiBBIHRhaWwgc3BlbmRzIG1vc3Qgb2YgYSBkZWFkIGRhZW1vbidzIGxpZmV0aW1lXG4gIC8vIGluc2lkZSB0aGlzIHNsZWVwLCBzbyB0aGF0IGlzIHRoZSBzdGF0ZSBhIGh1bWFuIGludGVycnVwdHMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgbGV0IHdha2VCYWNrb2ZmOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gICAgd2FrZUJhY2tvZmY/LigpO1xuICB9O1xuXG4gIC8qKiBTbGVlcCwgYnV0IHJldHVybiBBVCBPTkNFIGlmIHRoZSB0YWlsIGlzIHN0b3BwZWQgbWVhbndoaWxlLiAqL1xuICBjb25zdCBiYWNrb2ZmID0gKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+ID0+XG4gICAgbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmVTbGVlcCkgPT4ge1xuICAgICAgaWYgKHN0b3BwZWQpIHJldHVybiByZXNvbHZlU2xlZXAoKTtcbiAgICAgIGNvbnN0IGZpbmlzaCA9ICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgd2FrZUJhY2tvZmYgPSBudWxsO1xuICAgICAgICByZXNvbHZlU2xlZXAoKTtcbiAgICAgIH07XG4gICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoZmluaXNoLCBtcyk7XG4gICAgICB3YWtlQmFja29mZiA9IGZpbmlzaDtcbiAgICB9KTtcblxuICBjb25zdCBvblNpZ25hbCA9ICgpID0+IHN0b3AoMCk7XG4gIGNvbnN0IHVzZVNpZ25hbHMgPSBvcHRzLnNpZ25hbHMgIT09IGZhbHNlO1xuICBpZiAodXNlU2lnbmFscykge1xuICAgIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgfVxuXG4gIC8vIEEgZG93bnN0cmVhbSBgaGVhZGAvcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dCBpcyBhIGNvbXBsZXRlZCByZWFkLCBub3QgYVxuICAvLyBjcmFzaDogZW5kIGF0IDAgaW5zdGVhZCBvZiBkeWluZyBvbiBFUElQRS5cbiAgY29uc3Qgb25PdXRFcnJvciA9IChlOiB1bmtub3duKSA9PiB7XG4gICAgaWYgKChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbiB8IHVuZGVmaW5lZCk/LmNvZGUgPT09IFwiRVBJUEVcIikgc3RvcCgwKTtcbiAgfTtcbiAgY29uc3Qgb3V0RW1pdHRlciA9IG91dCBhcyB1bmtub3duIGFzIHtcbiAgICBvbj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gICAgb2ZmPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgfTtcbiAgb3V0RW1pdHRlci5vbj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG5cbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IHN0b3AoMCk7XG4gIG9wdHMuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmIChvcHRzLnNpZ25hbD8uYWJvcnRlZCkgc3RvcCgwKTtcblxuICBjb25zdCBlbWl0ID0gKGxpbmU6IHN0cmluZykgPT4ge1xuICAgIG91dC53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuICAvKiogRXZlcnkgZGlhZ25vc3RpYyB0aGUgY2xpZW50IHByb2R1Y2VzIGdvZXMgaGVyZSBhbmQgTk9XSEVSRSBlbHNlLCBzbyBhXG4gICAqICBjYWxsZXIgcGFyc2luZyBvdXIgc3Rkb3V0IG5ldmVyIG1lZXRzIGEgbm90ZSBhYm91dCBvdXIgc3Rkb3V0LiAqL1xuICBjb25zdCBub3RlID0gKGxpbmU6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQpID0+IHtcbiAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBsaW5lICE9PSB1bmRlZmluZWQpIGVyci53cml0ZShgJHtsaW5lfVxcbmApO1xuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAvLyDimqAgREVMSUJFUkFURUxZIFVOR1VBUkRFRC4gYHJlc29sdmVgIG1heSBzcGF3biwgcHJvYmUsIG9yIHJhaXNlIGFcbiAgICAgIC8vIHRheG9ub215IGZhaWx1cmUsIGFuZCB0aGF0IHRocm93IGlzIHRoZSBDQUxMRVIncyB0byBhbnN3ZXIg4oCUIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiB0aGUgY29waWVzJyBzaGFwZSwgd2hlcmUgYSBgZGllYCB3YXMgcmVhY2hhYmxlXG4gICAgICAvLyBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wIGFuZCBlbmRlZCB0aGUgcHJvY2VzcyBmcm9tIHRocmVlIGZyYW1lc1xuICAgICAgLy8gZG93bi5cbiAgICAgIGNvbnN0IGJhc2UgPSBhd2FpdCBvcHRzLnJlc29sdmUoKTtcbiAgICAgIC8vIOKblCBBIFNUT1AgVEhBVCBMQU5ERUQgV0hJTEUgYHJlc29sdmVgIFdBUyBBV0FJVEVEICh0aGUgaGFuZG9mZidzIHdpbmRvdyxcbiAgICAgIC8vIGEgc2lnbmFsKSBmb3VuZCBubyBhdHRlbXB0IHRvIGFib3J0LiBXaXRob3V0IHRoaXMgY2hlY2sgdGhlIGxvb3Agd2VudFxuICAgICAgLy8gb24gdG8gZmV0Y2gsIHNraXBwZWQgdGhlIHJlYWQsIGFuZCByZXR1cm5lZCB3aXRoIHRoYXQgc3RyZWFtIHN0aWxsXG4gICAgICAvLyBvcGVuIOKAlCB3aGljaCBrZWVwcyBhIHByb2Nlc3MgYWxpdmUgZXhhY3RseSBsaWtlIHRoZSB0ZXJtaW5hbC1mcmFtZVxuICAgICAgLy8gaGFuZy4gKFN1c3BlY3RlZCBieSB0aGUgcmV2aWV3ZXIsIHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKVxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGJhc2UgPT09IG51bGwpIHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IG9wdHMub25VbnJlc29sdmVkPy4oeyBldmVyUmVzb2x2ZWQsIGV2ZXJDb25uZWN0ZWQgfSkgPz8gXCJyZXRyeVwiO1xuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIpIHtcbiAgICAgICAgICBlbmRpbmcgPSBcInVucmVzb2x2ZWRcIjtcbiAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgfVxuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHtcbiAgICAgICAgc2luY2U6IFN0cmluZyhjdXJzb3IpLFxuICAgICAgfTtcbiAgICAgIC8vIFdoYXQgdGhpcyBjb25uZWN0aW9uIGFza2VkIGZyb20sIGZvciBgcmVzdGFydE9uUmVwbGF5YC5cbiAgICAgIGNvbnN0IGFza2VkU2luY2UgPSBjdXJzb3I7XG4gICAgICBsZXQgcmVzdGFydE5vdGVkID0gZmFsc2U7XG4gICAgICAvLyBTZXQgd2hlbiBhbiBlcG9jaCBjaGFuZ2UgZmluZHMgdGhlIG5ldyBsb2cgcGFzdCB0aGUgYm9va21hcmsuXG4gICAgICBsZXQgZnJvbVRvcCA9IGZhbHNlO1xuICAgICAgY29uc3QgcXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHBhcmFtcykudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IHVybCA9IGAke2Jhc2V9JHtvcHRzLnBhdGh9JHtxcyA/IGA/JHtxc31gIDogXCJcIn1gO1xuXG4gICAgICBhdHRlbXB0ID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICAgICAgY29uc3QgY29udHJvbGxlciA9IGF0dGVtcHQ7XG4gICAgICBsZXQgd2F0Y2hkb2c6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG4gICAgICBjb25zdCByZXNldFdhdGNoZG9nID0gKCkgPT4ge1xuICAgICAgICBpZiAoaWRsZU1zIDw9IDApIHJldHVybjtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICB3YXRjaGRvZyA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCBpZGxlTXMpO1xuICAgICAgfTtcblxuICAgICAgLy8g4puUIFRIRSBUUlkgSVMgQVJPVU5EIFRIRSBUUkFOU1BPUlQgQ0FMTFMgT05MWSDigJQgYGZldGNoYCBhbmRcbiAgICAgIC8vIGByZWFkZXIucmVhZCgpYCDigJQgYW5kIE5FVkVSIGFyb3VuZCB0aGUgY2FsbGVyJ3MgaG9va3MuIEEgYmxhbmtldFxuICAgICAgLy8gdHJ5L2NhdGNoIGhlcmUgcmVhZHMgYSBob29rJ3MgdGhyb3cgYXMgYSBkcm9wcGVkIGNvbm5lY3Rpb24gYW5kXG4gICAgICAvLyByZWNvbm5lY3RzIGZvcmV2ZXI6IHRoZSB0YWlsIHNwaW5zIHNpbGVudGx5IG9uIGFuIGVycm9yIG5vYm9keSBjYW5cbiAgICAgIC8vIHNlZSwgd2hpY2ggaXMgdGhlIGV4YWN0IGZhaWx1cmUgdGhpcyBjbGllbnQgZXhpc3RzIHRvIG1ha2VcbiAgICAgIC8vIHVucmVhY2hhYmxlLiAoQ2F1Z2h0IGJ5IGl0cyBvd24gdGVzdDogYSByZWZ1c2FsIGhvb2sgdGhhdCB0aHJvd3MgaHVuZ1xuICAgICAgLy8gdGhlIHN1aXRlIHVudGlsIHRoZSBjYXRjaCB3YXMgbmFycm93ZWQuKVxuICAgICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgICB0cnkge1xuICAgICAgICByZXMgPSBhd2FpdCBmZXRjaCh1cmwsIHsgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCB9KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIC8vIOKblCBDQU5DRUwgVEhFIEJPRFkgQkVGT1JFIExPT1BJTkcuIEFuIHVucmVhZCByZXNwb25zZSBib2R5IGhvbGRzIGFcbiAgICAgICAgICAvLyBzdHJlYW0gb3BlbiwgYW5kIHRoaXMgYnJhbmNoIHJ1bnMgb25jZSBwZXIgZmFpbGVkIGF0dGVtcHQgZm9yIGFzXG4gICAgICAgICAgLy8gbG9uZyBhcyB0aGUgZGFlbW9uIGlzIHVuaGFwcHkg4oCUIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGxvbmctcnVubmluZ1xuICAgICAgICAgIC8vIGNhc2UuIFRoZSBob29rIG1heSBhbHJlYWR5IGhhdmUgcmVhZCBpdDsgY2FuY2VsIGlzIGEgbm8tb3AgdGhlbi5cbiAgICAgICAgICBhd2FpdCByZXMuYm9keT8uY2FuY2VsKCkuY2F0Y2goKCkgPT4ge30pO1xuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImh0dHBcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lIOKAlCBhIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50IDI1MG1zLlxuICAgICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcIm5vLWJvZHlcIiwgc3RhdHVzOiByZXMuc3RhdHVzIH0pKTtcbiAgICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgZXZlckNvbm5lY3RlZCA9IHRydWU7XG4gICAgICAgIGZpcnN0Q29ubmVjdCA9IGZhbHNlO1xuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAvLyBXYXRjaGRvZyBhYm9ydCwgY2FsbGVyIGFib3J0LCBvciBhIGRyb3BwZWQgY29ubmVjdGlvbi4gQWxsIHRocmVlXG4gICAgICAgICAgICAvLyBtZWFuIHRoZSBzYW1lIHRoaW5nIGhlcmU6IHRoaXMgYXR0ZW1wdCBpcyBvdmVyLCByZWNvbm5lY3QgYmVsb3cuXG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lcnJvclwiLCBlcnJvcjogZSB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGNodW5rLmRvbmUpIHtcbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVuZFwiIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICAvLyDim5QgVEhFIEJBQ0tPRkYgUkVTRVRTIE9OIFRIRSBGSVJTVCBCWVRFLCBOT1QgT04gQSBTVUNDRVNTRlVMIE9QRU4g4oCUXG4gICAgICAgICAgLy8gYW5kIHRoYXQgaXMgV0lERVIgdGhhbiB0aGUgZGVmZWN0IGl0IHdhcyB3cml0dGVuIGZvci4gQjUgaXNcbiAgICAgICAgICAvLyByZWNvcmRlZCBhcyBcImEgMjAwIHdpdGggbm8gYm9keSBzbGVlcHMgd2l0aG91dCBncm93aW5nIHRoZVxuICAgICAgICAgIC8vIGJhY2tvZmZcIjsgcmVzZXR0aW5nIGF0IHRoZSBvcGVuIGhhcyB0aGUgc2FtZSBzaGFwZSBmb3IgQU5ZXG4gICAgICAgICAgLy8gY29ubmVjdGlvbiB0aGF0IGlzIGFjY2VwdGVkIGFuZCB0aGVuIHlpZWxkcyBub3RoaW5nLCB3aGljaCBpcyB3aGF0XG4gICAgICAgICAgLy8gYSBkYWVtb24gbWlkLXJlc3RhcnQgZG9lcy4gRHJpdmVuOiByZXNldC1hdC1vcGVuIGdpdmVzIGEgY29uc3RhbnRcbiAgICAgICAgICAvLyA0MW1zIHJlY29ubmVjdCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgY2xvc2VzOyByZXNldC1hdC1cbiAgICAgICAgICAvLyBmaXJzdC1ieXRlIGdpdmVzIDQwLCA4MCwgMTYwLiBBIGJ5dGUgaXMgdGhlIG9ubHkgZXZpZGVuY2UgdGhlXG4gICAgICAgICAgLy8gZGFlbW9uIGlzIGFjdHVhbGx5IHRhbGtpbmcgdG8gdXMuXG4gICAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG5vdGUob3B0cy5vbkNvbW1lbnQ/Lih0ZXh0KSk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgbm90ZShvcHRzLm9uTWFsZm9ybWVkPy4oZnJhbWUsIGUpKTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIOKblCBUSEUgQ1VSU09SIEFEVkFOQ0VTIE9OIEVWRVJZIEVWRU5ULCBJTkNMVURJTkcgQSBGSUxURVJFRCBPTkUuXG4gICAgICAgICAgICAvLyBBIHNjb3BlIHByZWRpY2F0ZSBpcyBhYm91dCB3aGF0IHRoZSBDQUxMRVIgcmVhZHMsIG5ldmVyIGFib3V0IHdoYXRcbiAgICAgICAgICAgIC8vIHRoZSBkYWVtb24gaGFzIGRlbGl2ZXJlZDsgYWR2YW5jaW5nIG9ubHkgb24gZW1pdHRlZCBldmVudHMgbWFrZXNcbiAgICAgICAgICAgIC8vIGV2ZXJ5IHJlY29ubmVjdCByZS1yZXF1ZXN0IHRoZSBmaWx0ZXJlZCBvbmVzIGZvcmV2ZXIuXG4gICAgICAgICAgICBjb25zdCBuID0gb3B0cy5jdXJzb3JPZj8uKGV2KTtcblxuICAgICAgICAgICAgbGV0IGVwb2NoUmVzZXQgPSBmYWxzZTtcbiAgICAgICAgICAgIGlmIChvcHRzLmVwb2NoT2YpIHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dCA9IG9wdHMuZXBvY2hPZihldik7XG4gICAgICAgICAgICAgIGlmICh0eXBlb2YgbmV4dCA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgICAgIGlmIChlcG9jaCAhPT0gbnVsbCAmJiBuZXh0ICE9PSBlcG9jaCkge1xuICAgICAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgICAgIGVwb2NoUmVzZXQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG5leHQpID8/IG51bGw7XG4gICAgICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgICAgICAgIC8vIFRoZSBuZXcgbG9nIGlzIHBhc3QgdGhlIGJvb2ttYXJrOiBpdHMgc3RhcnQgd2FzIHNraXBwZWQuXG4gICAgICAgICAgICAgICAgICAvLyBEcm9wIHRoaXMgYXR0ZW1wdCBhbmQgcmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIDAuXG4gICAgICAgICAgICAgICAgICBpZiAoYXNrZWRTaW5jZSA+IDAgJiYgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgbiA+IGFza2VkU2luY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICAgICAgICBmcm9tVG9wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKFxuICAgICAgICAgICAgICBvcHRzLnJlc3RhcnRPblJlcGxheSA9PT0gdHJ1ZSAmJlxuICAgICAgICAgICAgICAhZXBvY2hSZXNldCAmJlxuICAgICAgICAgICAgICAhcmVzdGFydE5vdGVkICYmXG4gICAgICAgICAgICAgIGFza2VkU2luY2UgPj0gMCAmJlxuICAgICAgICAgICAgICB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICAgICAgICBuIDw9IGFza2VkU2luY2VcbiAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAvLyBUaGUgZGFlbW9uIHJlcGxheWVkIFdIT0xFOiBpdHMgbG9nIHJlc3RhcnRlZCAoc2VlIHRoZSBvcHRpb24pLlxuICAgICAgICAgICAgICByZXN0YXJ0Tm90ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4ob3B0cy5lcG9jaE9mPy4oZXYpID8/IFwidW5rbm93blwiKSA/PyBudWxsO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmICh0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobikpIHtcbiAgICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yUG9saWN5ID09PSBcImFzc2lnblwiID8gbiA6IE1hdGgubWF4KGN1cnNvciwgbik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGFjY2VwdGVkID0gb3B0cy5hY2NlcHQ/LihldiwgZnJhbWUpID8/IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpc1Rlcm1pbmFsID0gb3B0cy50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSB7XG4gICAgICAgICAgICAgIC8vIOKblCBDTE9TRSBUSEUgQ09OTkVDVElPTi4gU2VlIGB0ZXJtaW5hbGAncyBkb2M6IHdpdGhvdXQgdGhpcyB0aGVcbiAgICAgICAgICAgICAgLy8gb3BlbiBzdHJlYW0ga2VlcHMgdGhlIHByb2Nlc3MgYWxpdmUgYWZ0ZXIgd2UgcmV0dXJuLlxuICAgICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICAgIGVuZGluZyA9IFwidGVybWluYWxcIjtcbiAgICAgICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgICAgICBjb250cm9sbGVyLmFib3J0KCk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChmcm9tVG9wKSB7XG4gICAgICAgIC8vIFJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSBpdHMgc3RhcnQsIG5vdzogbm90aGluZyBmYWlsZWQuXG4gICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gICAgb3B0cy5vbkVuZD8uKHsgY3Vyc29yLCBlcG9jaCwgcmVhc29uOiBlbmRpbmcgfSk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgdGFpbCdzIEhBTkRPRkY6IGhvdyBhIHNwZWxsJ3MgYHRhaWxgIGVuZHMgaXRzIG93biB3YXRjaCBqdXN0IGJlZm9yZSB0aGVcbiAqIGhhcm5lc3MncyBNb25pdG9yIGNhcCwgYW5kIHRoZSBvbmUgc3Rkb3V0IGxpbmUgdGhhdCBuYW1lcyB0aGUgYWdlbnQncyBuZXh0XG4gKiBhY3QsIGJvb2ttYXJrIGluY2x1ZGVkLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGl0cyBzaWJsaW5nIGAuL3RhaWxFdmVudHNgLlxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdG8gQ29sZSdzIHJ1bGluZyBvZiAyMDI2LTA5LTIzICh0aGVcbiAqIFwiUnVsaW5nXCIgc2VjdGlvbiBvZlxuICogYGRvY3MvaXRlbXMvc2NyaXB0b3JpdW0tdGFpbC1tb25pdG9yLWV4cGlyeS13YWtlcy10aGUtYWdlbnQtZm9yLW5vdGhpbmcubWRgKVxuICogYW5kIHRoZSBmb3VyIGFkanVzdG1lbnRzIG9mIGl0cyBmZWFzaWJpbGl0eSBzcGlrZVxuICogKGBkb2NzL2l0ZW1zL21vbml0b3ItZXhwaXJ5LWFuZC10aGUtdGFpbC93cml0ZS11cC5tZGApLlxuICpcbiAqIOKUgOKUgCBUSEUgUFJPQkxFTSwgT05FIFBBUkFHUkFQSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3Iga2lsbHMgZXZlcnkgd2F0Y2ggYXQgMSw4MDAsMDAwIG1zLiBFdmVyeSBzcGVsbCB0ZWxsc1xuICogdGhlIGFnZW50IHRvIHdyYXAgYHRhaWxgIGluIE1vbml0b3IsIHNvIGFuIGlkbGUgc2Vzc2lvbiB3b2tlIHRoZSBhZ2VudCBldmVyeVxuICogMzAgbWludXRlcyB0byByZS1hcm0sIGFuZCBhIGJhcmUgcmUtYXJtIHJlcGxheWVkIHVwIHRvIHRoZSBsYXN0IDEwMDAgZXZlbnRzLFxuICogYW5zd2VyZWQgaHVtYW4gbWVzc2FnZXMgaW5jbHVkZWQuIFRoZSByZXBsYXkgaXMgYSBjb3JyZWN0bmVzcyBidWc7IHRoZSBpZGxlXG4gKiB3YWtlcyBhcmUgYSBjb3N0IENvbGUgcnVsZWQgYWdhaW5zdC5cbiAqXG4gKiDilIDilIAgVEhFIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFR3byBtb2Rlcywgb25lIGxpbmUgYXQgdGhlIGVuZCBvZiBlYWNoOlxuICpcbiAqICAg4oCiIGB3YXRjaGAgKHRoZSBkZWZhdWx0LCBydW4gdW5kZXIgTW9uaXRvcik6IHN0cmVhbXMgdW50aWwgaXRzIFdJTkRPVyBlbmRzLFxuICogICAgIHRoZW4gcHJpbnRzIGB0YWlsLndpbmRvd2AgKGl0IHNhdyBldmVudHMg4oaSIHJlLWFybSBNb25pdG9yKSBvclxuICogICAgIGB0YWlsLnF1aWV0YCAoaXQgc2F3IG5vbmUg4oaSIHJ1biBgdGFpbCAtLW9uY2VgIGFzIGEgYmFja2dyb3VuZCBCYXNoXG4gKiAgICAgdGFzaykuIEEgUFJFU0VOQ0Ugc3BlbGwgKGFzdHJvbGFiZSwgZ3JhcGV2aW5lKSBhbHdheXMgZ2V0c1xuICogICAgIGB0YWlsLndpbmRvd2A6IGEgc3RvcC1zdGFydCB0YWlsIHdvdWxkIGZsaWNrZXIgdGhlIHByZXNlbmNlIGl0c1xuICogICAgIGNvbm5lY3Rpb24gY2Fycmllcy4gTWluZC1tYXBwZXIgd2FzIG9uZSBhbmQgaXMgbm90IHNpbmNlIDIwMjYtMDktMjRcbiAqICAgICAoc2VlIFwiTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTXCIgYmVsb3cpLlxuICogICDigKIgYG9uY2VgIChydW4gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayk6IHNsZWVwcyB1bnRpbCB0aGUgZmlyc3QgbG9nIGV2ZW50LFxuICogICAgIHByaW50cyBpdCwgcHJpbnRzIGB0YWlsLndva2VgICjihpIgYmFjayB0byBNb25pdG9yKSBhbmQgRVhJVFMsIHdoaWNoIGlzXG4gKiAgICAgd2hhdCB3YWtlcyB0aGUgYWdlbnQuXG4gKlxuICogRWl0aGVyIG1vZGUgZW5kcyB3aXRoIGB0YWlsLmNsb3NlZGAgd2hlbiB0aGUgc2Vzc2lvbiBjbG9zZXMgYW5kIGB0YWlsLmxvc3RgXG4gKiB3aGVuIHRoZSBkYWVtb24gaXMgZ29uZSAoc2Vzc2lvbiBzcGVsbHMgYW5kIG1pbmQtbWFwcGVyKSwgZWFjaCBuYW1pbmcgaG93IHRvXG4gKiBjb21lIGJhY2sgaW5zdGVhZCBvZiBhIHJlLWFybS4gQSBzaWduYWwgb3IgYSBjYWxsZXIncyBhYm9ydCBwcmludHMgbm90aGluZy5cbiAqXG4gKiBFdmVyeSByZS1hcm0gY2FycmllcyBgLS1zaW5jZSA8Y3Vyc29yPmAsIHNvIG5vdGhpbmcgcmVwbGF5czsgdGhlIGRhZW1vbidzXG4gKiBidWZmZXIgY292ZXJzIHdoYXRldmVyIGxhbmRzIGJldHdlZW4gb25lIHdhdGNoJ3MgZXhpdCBhbmQgdGhlIG5leHQncyBhcm0uXG4gKlxuICog4pSA4pSAIERFQ0lTSU9OIExPRyAoZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEtpdCBkZWNpc2lvbnMgbGl2ZSBpbiBtb2R1bGUgaGVhZGVycyAodGhlIGFyY2hpdGVjdHVyZSBkb2MncyDCpzQgcnVsZTogXCJlYWNoXG4gKiBtb2R1bGUncyBoZWFkZXIgaXMgdGhlIGF1dGhvcml0YXRpdmUgYWNjb3VudFwiKS4gUnVsZWQgYnkgQ29sZTogdGhlIGh5YnJpZCxcbiAqIHRoZSBhbHdheXMtYm9va21hcmssIHByZXNlbmNlIHNwZWxscyBhbHdheXMgcmUtYXJtIE1vbml0b3IsIGJvdW50eSdzIGV4YW1wbGVcbiAqIGZpeGVkLiBUaGUgZm91ciBhZGp1c3RtZW50cyB3ZXJlIHRoZSBzcGlrZSdzIHJlcXVpcmVtZW50cy4gVGhlIHJlc3QgYXJlIHRoZVxuICogaW1wbGVtZW50ZXIncyBydWxpbmdzLCBtYXJrZWQg4pqWIHdpdGggdGhlIG9wdGlvbnMgbm90IHRha2VuLlxuICpcbiAqIEExIMK3IEEgVEVSTUlOQUwgRlJBTUUgQ0xPU0VTIFRIRSBDT05ORUNUSU9OLiBgdGFpbEV2ZW50c2Agbm93IGFib3J0cyB0aGVcbiAqICAgICAgaW4tZmxpZ2h0IGZldGNoIGJlZm9yZSBpdCByZXR1cm5zIG9uIGEgdGVybWluYWwgZnJhbWUuIEJlZm9yZSwgaXRcbiAqICAgICAgcmV0dXJuZWQgZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCBhbmQgbGVmdCB0aGUgU1NFIHN0cmVhbSBvcGVuLCBzbyB0aGVcbiAqICAgICAgcHJvY2VzcyBzdGF5ZWQgYWxpdmU6IHVuc2VlbiBmb3IgYGNsb3NlZGAgKHRoZSBzZXJ2ZXIgZW5kcyB0aGF0XG4gKiAgICAgIHN0cmVhbSBpdHNlbGYpIGFuZCBmYXRhbCBmb3IgYC0tb25jZWAsIHdob3NlIGJhY2tncm91bmQgdGFzayB3b3VsZFxuICogICAgICBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudCwgc2lsZW50bHkuIFBpbm5lZCBpblxuICogICAgICBgdGFpbEhhbmRvZmYudGVzdC50c2AgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGtlZXBzIHRoZSBzdHJlYW0gb3Blbi5cbiAqXG4gKiBBMiDCtyBUSEUgTkVYVCBBQ1QgREVQRU5EUyBPTiBTVEFURS4gYGhhbmRvZmYoKWAgYmVsb3cgaXMgdGhlIHB1cmUgZGVjaXNpb246XG4gKiAgICAgIHF1aWV0IOKGkiBiYWNrZ3JvdW5kLCBhY3RpdmUgb3IgcHJlc2VuY2Ug4oaSIE1vbml0b3IsIHdva2Ug4oaSIE1vbml0b3IsXG4gKiAgICAgIGNsb3NlZCDihpIgY29tZSBiYWNrLCBsb3N0IOKGkiBjb21lIGJhY2suIENvbWUgYmFjayBpcyB0aGUgc3BlbGwncyBvd24gdmVyYlxuICogICAgICAoYG9wZW4gLS1yZXN0b3JlIDxpZD5gIGZvciB0aGUgc2Vzc2lvbiBzcGVsbHMsIGBvcGVuIC0tbm8tb3BlbmAgZm9yXG4gKiAgICAgIG1pbmQtbWFwcGVyIGFuZCBhc3Ryb2xhYmUpLlxuICogICAgICDimpYgVEhFIERJU0NPTk5FQ1QgREVDSVNJT046IGZvciBhIHNlc3Npb24gc3BlbGwsIGEgTE9TVCBkYWVtb24gZW5kcyB0aGVcbiAqICAgICAgdGFpbCBpbiBCT1RIIG1vZGVzIHdpdGggYSBzdGRvdXQgYHRhaWwubG9zdGAgbGluZS4gTW9uaXRvciBub3RpZmllcyBvbmx5XG4gKiAgICAgIG9uIHN0ZG91dCwgc28gdGhlIG9sZCBzdGRlcnItb25seSBgdGFpbC5kaXNjb25uZWN0ZWRgIGxlZnQgYVxuICogICAgICBNb25pdG9yLXdyYXBwZWQgYWdlbnQgdW5hd2FyZSBvZiBhIGBraWxsIC05YCAoRTU1J3MgcHVycG9zZSB1bm1ldCksIGFuZFxuICogICAgICBhIGAtLW9uY2VgIG9uIGEgZGVhZCBkYWVtb24gd291bGQgaGF2ZSBzbGVwdCBmb3JldmVyLiBcIkxvc3RcIiBpc1xuICogICAgICBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgY29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdywgbmV2ZXIgYSBkcm9wcGVkXG4gKiAgICAgIHN0cmVhbSBhbG9uZTogYSBsYXB0b3AgdGhhdCBzbGVlcHMgZHJvcHMgdGhlIHN0cmVhbSwgcmVjb25uZWN0cyBvbiB0aGVcbiAqICAgICAgZmlyc3QgdHJ5LCBhbmQgbXVzdCBzdGF5IHNpbGVudC5cbiAqICAgICAgICBOb3QgdGFrZW46IChhKSBrZWVwIHJldHJ5aW5nIGFuZCBvbmx5IE1PVkUgdGhlIGRpc2Nvbm5lY3QgbGluZSB0b1xuICogICAgICAgIHN0ZG91dCDigJQgYSBzZXNzaW9uIGRhZW1vbiBpcyBuZXZlciByZXNwYXduZWQgYnkgaXRzIHRhaWwsIHNvIHRoZVxuICogICAgICAgIHJldHJpZXMgYnV5IG5vdGhpbmcgYW5kIHRoZSBhZ2VudCBpcyB3b2tlbiB0byBiZSB0b2xkIHRvIHdhaXQ7IChiKVxuICogICAgICAgIGxlYXZlIGl0IG9uIHN0ZGVyciDigJQgdGhlIGRlZmVjdC5cbiAqICAgICAg4pqWIFByZXNlbmNlIHNwZWxscyBrZWVwIHJldHJ5aW5nLCBhcyBiZWZvcmU6IGdyYXBldmluZSdzIHRhaWwgcmVzcGF3bnNcbiAqICAgICAgaXRzIGRhZW1vbiBhbmQgYXN0cm9sYWJlJ3MgYGpvaW5gIHdhaXRzIGZvciB0aGUgaHVtYW4gdG8gcmVvcGVuIHRoZVxuICogICAgICBib2FyZCwgYm90aCBieSBkZXNpZ24uIFRoZWlyIGRpc2Nvbm5lY3Qgbm90ZXMgc3RheSB3aGVyZSB0aGV5IHdlcmUuXG4gKlxuICogQTMgwrcgUVVJRVQgSVMgVEhFIFRBSUwnUyBPV04gQ09VTlQuIGBldmVudHNgIGNvdW50cyB0aGUgbG9nIGZyYW1lcyB0aGlzXG4gKiAgICAgIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0LiBUaGUgZ3JvdW5kaW5nIGxpbmUsIGEgc3BlbGwncyBgc3Vic2NyaWJlZGBcbiAqICAgICAgbWFya2VyLCBgZXBvY2guY2hhbmdlZGAgYW5kIHRoZSBoYW5kb2ZmIGxpbmUgaXRzZWxmIGFyZSBub3QgbG9nIGZyYW1lc1xuICogICAgICBhbmQgYXJlIG5vdCBjb3VudGVkOiBhIGZyYW1lIGNvdW50cyBvbmx5IGlmIGl0IGNhcnJpZXMgYSBsb2cgaWQgKEQzKSxcbiAqICAgICAgYW5kIGBjb3VudHNgIGxldHMgYSBzcGVsbCBleGNsdWRlIGEgZnJhbWUgdGhhdCBkb2VzIChncmFwZXZpbmUnc1xuICogICAgICBgc3Vic2NyaWJlZGAgbWFya2VyLCB3aGljaCBzZWVkcyB0aGUgYm9va21hcmsgZnJvbSBgbGF0ZXN0X2lkYCkuIEFueSBsb2cgZnJhbWUgY291bnRzLCB0aGUgZGFlbW9uJ3MgYHdhaXRpbmdgIHJlbWluZGVyXG4gKiAgICAgIGluY2x1ZGVkLCBzbyBcInF1aWV0XCIgbWVhbnMgbm90aGluZyBvbiB0aGUgbG9nLlxuICogICAgICDimpYgQSBmcmFtZSB0aGUgdGFpbCdzIG93biBmaWx0ZXIgcmVqZWN0cyAoYm91bnR5J3Mgb3duZXIgc2NvcGUsIGFcbiAqICAgICAgc2VsZi1lY2hvKSBpcyBOT1QgY291bnRlZCBhbmQgZG9lcyBub3QgZW5kIGEgYC0tb25jZWA6IGl0IHdhcyBuZXZlclxuICogICAgICBkZWxpdmVyZWQsIGFuZCB3YWtpbmcgb24gaXQgd291bGQgYmUgYSB3YWtlIHdpdGggbm90aGluZyB0byBhY3Qgb24g4oCUXG4gKiAgICAgIHRoZSBkZWZlY3QgdGhpcyBtb2R1bGUgZXhpc3RzIHRvIHJlbW92ZS4gVGhlIGN1cnNvciBzdGlsbCBhZHZhbmNlc1xuICogICAgICBwYXN0IGl0ICh0YWlsRXZlbnRzJyBydWxlKSwgc28gaXQgbmV2ZXIgcmVwbGF5cyBlaXRoZXIuXG4gKiAgICAgIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIGxpbmU7IHRoYXQgaGFsZiBsaXZlcyBpbiBlYWNoXG4gKiAgICAgIHNwZWxsJ3MgYHRhaWxgLCB3aGljaCBrbm93cyB3aGV0aGVyIGAtLXNpbmNlYCB3YXMgZ2l2ZW4uXG4gKlxuICogQTQgwrcgVEhFIFdJTkRPVy4gYERFRkFVTFRfV0lORE9XX01TYCA9IHRoZSBjYXAgbWludXMgYFdJTkRPV19NQVJHSU5fTVNgXG4gKiAgICAgICg2MCBzKSwgc28gMSw3NDAsMDAwIG1zLiBUaGUgbWFyZ2luIGhhcyB0byBjb3ZlciB0aGUgZ2FwIGJldHdlZW4gdGhlXG4gKiAgICAgIGhhcm5lc3Mgc3RhcnRpbmcgaXRzIGNsb2NrIGFuZCB0aGlzIHByb2Nlc3Mgc3RhcnRpbmcgaXRzIG93biAoQnVuXG4gKiAgICAgIHN0YXJ0LXVwLCBhIHNlc3Npb24gbG9va3VwLCBhIGRhZW1vbiBzcGF3biBvbiB0aGUgc3BlbGxzIHdob3NlIGByZXNvbHZlYFxuICogICAgICBzcGF3bnMgb25lIOKAlCBib3VuZGVkIGJ5IHRoZWlyIHN0YXJ0IHRpbWVvdXRzLCB3aGljaCBhcmUgc2Vjb25kcykgcGx1c1xuICogICAgICB0aGUgbGFzdCBsaW5lJ3MgZmx1c2ggYW5kIE1vbml0b3IncyAyMDAgbXMgYmF0Y2hpbmcuIEEgbWludXRlIGNvdmVyc1xuICogICAgICBhbGwgb2YgdGhhdCBtYW55IHRpbWVzIG92ZXIuIFRoZSBzcGlrZSBtZWFzdXJlZCBhIDEyIHNcbiAqICAgICAgd2luZG93IHVuZGVyIGEgMjAgcyBjYXAgZW5kaW5nIGNsZWFubHk7IG5vdGhpbmcgaGVyZSBkZXBlbmRzIG9uIGFcbiAqICAgICAgbWFyZ2luIHRoYXQgdGlnaHQuIElmIHRoZSBjYXAgd2lucyBhbnl3YXksIHRoZSBhZ2VudCBnZXRzIE1vbml0b3Inc1xuICogICAgICBiYXJlIGV4cGlyeSBub3RpY2UgYW5kIHJlLWFybXMgc2lsZW50bHkgZnJvbSB0aGUgbGFzdCBpZCBpdCBzYXcg4oCUIHRoZVxuICogICAgICBydWxpbmcncyBmYWxsYmFjaywgc3RhdGVkIGluIGV2ZXJ5IHNraWxsLlxuICogICAgICDimpYgVGhlIHdpbmRvdyBpcyBpbmplY3RhYmxlIGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIHRocm91Z2hcbiAqICAgICAgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NU2AgKGEgY291bnQgb2YgbXM7IGAwYCB0dXJucyB0aGUgd2luZG93IG9mZixcbiAqICAgICAgZm9yIGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCkuIEFuIGVudiB2YXIgYW5kIG5vdCBhIGZsYWc6IGl0IGlzXG4gKiAgICAgIG5vdCBhbiBhZ2VudCdzIGFjdCwgc28gaXQgc3RheXMgb3V0IG9mIGVpZ2h0IHZlcmJzJyBzY2hlbWFzLlxuICpcbiAqIOKUgOKUgCBUSEUgVkVSSUZJRVInUyBERUZFQ1RTLCBGSVhFRCBPTiBUSEUgU0FNRSBCUkFOQ0ggKDIwMjYtMDktMjMpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBuby1zdGFrZSB2ZXJpZmllciByYW4gZXZlcnkgc3BlbGwncyByZWFsIHRhaWwgYW5kIGZvdW5kIGZvdXIgd2F5cyB0aGVcbiAqIGxvb3AgYnJva2UuIEVhY2ggaGFzIGEgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2A7IEQxIGFuZCBEMiBhbHNvIGhhdmUgYVxuICogcmVhbC1kYWVtb24gY2VsbCBpbiBgc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvdGFpbC1oYW5kb2ZmLmludGVncmF0aW9uLnRlc3QudHNgLlxuICpcbiAqIEQxIMK3IEEgUkUtQVJNIEFUIEEgU0VTU0lPTiBUSEFUIENMT1NFRCBJTiBUSEUgR0FQIEVORFMgYHRhaWwuY2xvc2VkYC4gVGhlXG4gKiAgICAgIHRyaWdnZXIgaXMgb3JkaW5hcnk6IHRoZSBodW1hbiBwcmVzc2VzIENsb3NlIHdoaWxlIHRoZSBhZ2VudCBoYW5kbGVzXG4gKiAgICAgIGB0YWlsLndva2VgLiBUaGUgc2Vzc2lvbiBzcGVsbHMgc3RvcHBlZCBvbmx5IHdoZW4gVEhJUyBwcm9jZXNzIGhhZFxuICogICAgICBvbmNlIHJlYWNoZWQgdGhlIHNlc3Npb24sIHNvIHRoZSByZS1hcm0gcmV0cmllZCBcIm5vIHNlc3Npb24geWV0XCIgb25cbiAqICAgICAgc3RkZXJyIGZvcmV2ZXIg4oCUIGFuZCBpdHMgYC0tb25jZWAgbmV2ZXIgZXhpdGVkLiBSdWxlOiBhIHRhaWwgZ2l2ZW5cbiAqICAgICAgYC0tc2Vzc2lvbmAgb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkcgc2Vzc2lvbiwgc28gbm90XG4gKiAgICAgIGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkOyB0aGUgc3BlbGwncyBgb25VbnJlc29sdmVkYCBzYXlzIFwic3RvcFwiXG4gKiAgICAgIGFuZCB0aGlzIG1vZHVsZSByZWFkcyBBTlkgc3RvcCBhcyBjbG9zZWQuIEEgYmFyZSBmaXJzdCBhcm0gc3RpbGxcbiAqICAgICAgd2FpdHMgZm9yIGEgc2Vzc2lvbiB0byBhcHBlYXIuIOKaoCBcIkdpdmVuXCIgbWVhbnMgT04gVEhFIENPTU1BTkQgTElORVxuICogICAgICAocmV2aWV3IEIxKTogYm91bnR5IGFsc28gcmVzb2x2ZXMgYSBzZXNzaW9uIGZyb21cbiAqICAgICAgYCRCT1VOVFlfU0VTU0lPTl9LRVlgLCBgJEJPVU5UWV9TRVNTSU9OYCBvciBhIGAuYm91bnR5LXNlc3Npb25gIGZpbGUsXG4gKiAgICAgIHdoaWNoIGV2ZXJ5IGFudGhpbGwgc2VhdCBoYXMsIGFuZCBhIHNlYXQncyBmaXJzdCBhcm0gbXVzdCB3YWl0LiBBXG4gKiAgICAgIGtleWVkIGJvdW50eSBib2FyZCBjb21lcyBiYWNrIGJ5IGl0cyBrZXkgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApO1xuICogICAgICByZXN0b3JpbmcgaXQgYnkgaWQgc3Bhd25zIGFuIHVua2V5ZWQgc3RyYXkuXG4gKiBEMiDCtyBBIEJPT0tNQVJLIENBTk5PVCBPVVRMSVZFIElUUyBMT0cuIEEgcmVzdG9yZWQgZGFlbW9uJ3MgaWRzIGJlZ2luIGF0IDEsXG4gKiAgICAgIGFuZCB0aGUga2l0J3MgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd24gYnkgcmVwbGF5aW5nIHdob2xlO1xuICogICAgICB0aGUgdGFpbCBrZXB0IGl0cyBoaWdoZXIgY3Vyc29yLCBzbyBldmVyeSByZS1hcm0gcmVwbGF5ZWQgdGhlIG5ldyBsb2dcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFR3byBoYWx2ZXM6XG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUaHJlZSBwYXJ0czpcbiAqICAgICAgICAoYSkgdGhlIG5ldCDigJQgYHRhaWxFdmVudHNgJyBgcmVzdGFydE9uUmVwbGF5YCwgb24gZm9yIGV2ZXJ5IHNwZWxsLFxuICogICAgICAgICAgICByZWFkcyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgYXMgYSByZXN0YXJ0ZWQgbG9nXG4gKiAgICAgICAgICAgIGFuZCByZXNldHMgdGhlIGN1cnNvcjtcbiAqICAgICAgICAoYikgdGhlIHJ1bGUg4oCUIHRoZSBgdGFpbC5jbG9zZWRgL2B0YWlsLmxvc3RgIGhpbnQsIGFuZCBldmVyeSBza2lsbCxcbiAqICAgICAgICAgICAgc2F5OiBydW4gdGhlIGNvbW1hbmQgdGhlIGxpbmUgbmFtZXMsIHRoZW4gdGFpbCBXSVRIIE5PXG4gKiAgICAgICAgICAgIGAtLXNpbmNlYCAoYSByZXN0b3JlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZzsgYm91bnR5J3MgcmVzdG9yZVxuICogICAgICAgICAgICBldmVuIG1pbnRzIGEgbmV3IGlkKTtcbiAqICAgICAgICAoYykgVEhFIEVQT0NIIElOIFRIRSBCT09LTUFSSyDigJQg4pqWIEEgUkVWRVJTQUwuIFRoZSBmaXJzdCB2ZXJzaW9uIG9mXG4gKiAgICAgICAgICAgIHRoaXMgZW50cnkgbGlzdGVkIFwiY2FycnkgdGhlIGVwb2NoIGluIHRoZSBib29rbWFya1wiIGFzIG5vdCB0YWtlblxuICogICAgICAgICAgICAoYSBuZXcgZmxhZyBvbiBlaWdodCB2ZXJiczsgYW4gZXBvY2ggc2VlbiBvbmx5IG9uY2UgYSBmcmFtZVxuICogICAgICAgICAgICBhcnJpdmVzKS4gVGhlIHJldmlld2VyIHRoZW4gc2hvd2VkIChhKSdzIGJsaW5kIHNwb3QgTElWRTogYW4gb2xkXG4gKiAgICAgICAgICAgIGJvb2ttYXJrIGF0IG9yIGJlbG93IHRoZSBORVcgbG9nJ3MgbGVuZ3RoIG1ha2VzIHRoZSBkYWVtb24gc2VuZFxuICogICAgICAgICAgICBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW5cbiAqICAgICAgICAgICAgbWVzc2FnZSBhdCBuZXcgaWQgMiB1bmRlciBhIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCB3aXRoIG5vXG4gKiAgICAgICAgICAgIG5vdGljZS4gVGhyZWUgcGF0aHMgcmVhY2ggaXQ6IGNvbWluZyBiYWNrIHdpdGhvdXQgZm9sbG93aW5nIChiKTtcbiAqICAgICAgICAgICAgdGhlIE1vbml0b3ItY2FwIGZhbGxiYWNrIChcInJlLWFybSBmcm9tIHRoZSBsYXN0IGlkIHlvdSBzYXdcIilcbiAqICAgICAgICAgICAgYWNyb3NzIGEgcmVzdGFydDsgYW5kIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4tcHJvY2Vzc1xuICogICAgICAgICAgICAoYXN0cm9sYWJlLCBvciBtaW5kLW1hcHBlciB3aGVuIGl0cyBkYWVtb24gaXMgYmFjayBiZWZvcmUgdGhlXG4gKiAgICAgICAgICAgIGxvc3QgcnVsZSBmaXJlcykgd2hvc2UgZmlyc3QgZnJhbWUgYWZ0ZXIgYSByZXN0YXJ0IGlzIGFscmVhZHlcbiAqICAgICAgICAgICAgcGFzdCBpdHMgYm9va21hcmsuXG4gKiAgICAgICAgICAgIFRoZSBmaXggbmVlZHMgbm8gbmV3IGZsYWcgYW5kIG5vIHdpcmUgY2hhbmdlOiB0aGUgYm9va21hcmsgaXNcbiAqICAgICAgICAgICAgcHJpbnRlZCBgLS1zaW5jZSBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApLCB0aGUgY2xpZW50IHN0YXJ0c1xuICogICAgICAgICAgICB3aXRoIHRoYXQgZXBvY2ggKGBzaW5jZUVwb2NoYCksIGFuZCBhbiBlcG9jaCBjaGFuZ2Ugd2hvc2UgZnJhbWVcbiAqICAgICAgICAgICAgaXMgcGFzdCB0aGUgYXNrZWQgY3Vyc29yIHJlLXJlYWRzIHRoZSBuZXcgbG9nIGZyb20gMC4gVGhlIHNhbWVcbiAqICAgICAgICAgICAgcmVjb25uZWN0IGNvdmVycyB0aGUgaW4tcHJvY2VzcyBwcmVzZW5jZSBjYXNlLlxuICogICAgICDimqAgU1RBVEVEIExJTUlUOiBvbmx5IGRhZW1vbnMgdGhhdCBzdGFtcCBhbiBlcG9jaCBnZXQgKGMpIOKAlFxuICogICAgICBzY3JpcHRvcml1bSwgYXN0cm9sYWJlIGFuZCBtaW5kLW1hcHBlci4gR2xhbW91ciwgaW1hZ28sIG1hZ3BpZSBhbmRcbiAqICAgICAgYm91bnR5IHN0YW1wIG5vbmUgKHNlc3Npb24tc2NvcGVkIGxvZ3MsIHJ1bGVkIHNvIGluIEQzOS9CODsgYm91bnR5J3NcbiAqICAgICAgc2VydmVyIGhlYWRlciBuYW1lcyB0aGlzIHJlc2lkdWUpLCBzbyBmb3IgdGhlbSB0aGUgZ2FwIHN0YXlzIG9wZW4gb25cbiAqICAgICAgdGhlIGZhbGxiYWNrIHBhdGgsIChhKSBjb3ZlcnMgdGhlIHdob2xlLXJlcGxheSBjYXNlIGFuZCAoYikgdGhlXG4gKiAgICAgIGNvbWUtYmFjayBwYXRoLiBDbG9zaW5nIGl0IHRoZXJlIGlzIGEgZGFlbW9uIGNoYW5nZTogYW4gZXBvY2ggb25cbiAqICAgICAgYGNyZWF0ZUV2ZW50TG9nYC4gRXZlcnkgc3BlbGwgcHJpbnRzIHRoZSBuZXQncyByZXNldCBhc1xuICogICAgICBgZXBvY2guY2hhbmdlZGAgKGBcImVwb2NoXCI6IFwidW5rbm93blwiYCB3aGVyZSB0aGVyZSBpcyBub25lKS5cbiAqIEQzIMK3IE9OTFkgQSBGUkFNRSBXSVRIIEEgTE9HIElEIENPVU5UUy4gR2xhbW91cidzIGFuZCBpbWFnbydzIHRhYiBwaW5nc1xuICogICAgICAoYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGApIGNhcnJ5IG5vIGlkOiBub3Qgb24gdGhlIGxvZywgc28gYSBsYXB0b3BcbiAqICAgICAgbGlkIG5vIGxvbmdlciB3YWtlcyBhIGAtLW9uY2VgLCBhbmQgaW1hZ28ncyBncmVwIG5vIGxvbmdlciBzaG93cyBhXG4gKiAgICAgIGB0YWlsLndva2VgIHdpdGggbm90aGluZyBhYm92ZSBpdC5cbiAqIEQ0IMK3IEEgSFVNQU4nUyBXQVRDSCBIQVMgTk8gV0lORE9XLiBgZ3JhcGV2aW5lIHRhaWwgLS1odW1hbmAgcGFzc2VzXG4gKiAgICAgIGB3aW5kb3dNczogMGA7IG5vIG90aGVyIHNwZWxsIGhhcyBhIGh1bWFuIG1vZGUuIEV2ZXJ5IGB0YWlsYCdzIGhlbHBcbiAqICAgICAgY2FycmllcyBgV0lORE9XX0hFTFBgLCB3aGljaCBuYW1lcyBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBgLlxuICogQWxzbzogZXZlcnkgY29tZS1iYWNrIGNvbW1hbmQgY2FycmllcyBgLS1uby1vcGVuYCwgc28gcnVubmluZyBpdCBvcGVucyBub1xuICogYnJvd3NlciB0YWIuXG4gKlxuICog4pqgIEtOT1dOIEVER0UsIE5PVCBGSVhFRCAoZm91bmQgYnkgdGhlIHJlLXJldmlldyk6IGEga2V5ZWQgYm91bnR5IEZJUlNUIGFybVxuICogICAoYW4gYW50aGlsbCBzZWF0KSB3aG9zZSB3aW5kb3cgZW5kcyBiZWZvcmUgaXRzIGJvYXJkIGV2ZXIgb3BlbnMgcHJpbnRzIGFcbiAqICAgcmUtYXJtIHBpbm5lZCB0byB0aGUgZGVyaXZlZCBpZCB3aXRoIGFuIGVtcHR5IGJvb2ttYXJrXG4gKiAgIChgLS1zZXNzaW9uIGst4oCmIC0tc2luY2U9LTEgLS1vbmNlYCkuIFRoYXQgcmUtYXJtIGlzIGEgcmUtYXJtIGJ5IEQxJ3MgcnVsZSxcbiAqICAgc28gaWYgdGhlIGJvYXJkIGlzIHN0aWxsIG5vdCB1cCDigJQgdGhlIGxlYWQgbW9yZSB0aGFuIG9uZSB3aW5kb3cgKDI5IG1pbilcbiAqICAgbGF0ZSDigJQgdGhlIHNlYXQgZG9lcyBub3Qgd2FpdC4gTWlub3I6IHRoZSBuZXh0IHN0ZXAgaXQgbmFtZXNcbiAqICAgKGBvcGVuIC0tc2Vzc2lvbi1rZXkgS2ApIGlzIHRoZSByaWdodCBvbmUgYW55d2F5LiBTaW5jZSAjOTggKDIwMjYtMDktMjcpXG4gKiAgIGl0IG5vIGxvbmdlciBzYXlzIGB0YWlsLmNsb3NlZGAgYWJvdXQgYSBib2FyZCB0aGF0IG5ldmVyIG9wZW5lZDogYSBuYW1lZFxuICogICBgLS1zZXNzaW9uYCB3aXRoIG5vIHNuYXBzaG90IG9uIGRpc2sgZXhpdHMgYG5vdF9mb3VuZGAgYWZ0ZXIgYSBncmFjZS5cbiAqXG4gKiDilIDilIAgVEhFIENPTU1BTkQgTkFNRVMgTk8gUEFUSCAoQ29sZSdzIHJ1bGluZywgMjAyNi0wOS0yNCkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIGxpbmUncyBgY29tbWFuZGAgaXMgdGhlIFZFUkIgQU5EIElUUyBBUkdVTUVOVFMgT05MWVxuICogKGB0YWlsIC0tc2Vzc2lvbiBYIC0tc2luY2UgTkBFIC0tb25jZWApLCBwbHVzIGBzcGVsbGAsIGFuZCB0aGUgYWdlbnQgcnVucyBpdFxuICogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50c2AuIEl0IHVzZWRcbiAqIHRvIGJlIHJ1bm5hYmxlIGFzIHByaW50ZWQsIGhlYWRlZCBieSBgYnVuIDxhcmd2WzFdPmAg4oCUIGFuZCBmb3IgYW4gaW5zdGFsbGVkXG4gKiBwbHVnaW4gYGFyZ3ZbMV1gIGlzIGluc2lkZSBhIFZFUlNJT05FRCBjYWNoZSBkaXJlY3RvcnkuIEFuIHVwZ3JhZGUgbWFya3MgdGhlXG4gKiBvbGQgZGlyZWN0b3J5IG9ycGhhbmVkIGFuZCBkZWxldGVzIGl0IGxhdGVyIChtZWFzdXJlZCBpblxuICogYGRvY3MvaXRlbXMvdGFpbC1yZWFybS1jb21tYW5kLW5hbWVzLWEtdmVyc2lvbmVkLXBsdWdpbi1wYXRoLm1kYCksXG4gKiBzbyBhIGxpbmUgcHJpbnRlZCBiZWZvcmUgYW4gdXBncmFkZSBmaXJzdCByYW4gU1RBTEUgY29kZSBhZ2FpbnN0IGEgbmV3ZXJcbiAqIGRhZW1vbiwgdGhlbiBmYWlsZWQgd2l0aCBcIm1vZHVsZSBub3QgZm91bmRcIiBvbmNlIHRoZSBkaXJlY3Rvcnkgd2FzIGdvbmUuIE5vXG4gKiBzdGFibGUgcGF0aCBleGlzdHMgdG8gcHJpbnQgaW5zdGVhZDogdGhlIGNhY2hlLCBgJENMQVVERV9QTFVHSU5fUk9PVGAgYW5kIHRoZVxuICogaW5zdGFsbCByZWNvcmQgYXJlIGFsbCB2ZXJzaW9uZWQuXG4gKiAgIFRoZSBza2lsbCdzIGxhdW5jaGVyIGlzIGFsd2F5cyB0aGUgdmVyc2lvbiB0aGUgc2Vzc2lvbiBsb2FkZWQuIENvbGUnc1xuICogcmVhc29uaW5nOiB0aGUgd29yc3QgY2FzZSBpcyB0aGF0IHRoZSBDTEkgY2hhbmdlZCBhbmQgdGhlIGFnZW50IGdldHMgYW5cbiAqIGVycm9yIOKAlCBhbmQgaWYgdGhlIHRvb2xzIGFyZSBkZXNpZ25lZCByaWdodCwgdGhhdCBlcnJvciBzYXlzIHdoYXQgd2VudFxuICogd3JvbmcuIFNvIHRoZSBwYXJzZXJzIGFyZSB0aGUgb3RoZXIgaGFsZiBvZiB0aGlzIHJ1bGluZzogYHJlYWRTaW5jZWAgcmVmdXNlc1xuICogYW55IGAtLXNpbmNlYCBmb3JtIGEgdGFpbCBkb2VzIG5vdCBhY2NlcHQgd2l0aCBhIHVzYWdlIGVycm9yIE5BTUlORyB0aGVcbiAqIGZvcm1zIGl0IGRvZXMsIHRoZSBzYW1lIHdheSBvbiBhbGwgZWlnaHQgdGFpbHMsIGluc3RlYWQgb2YgbWlzcGFyc2luZyBpdC5cbiAqICAgTm90IHRha2VuOiBwcmludGluZyB0aGUgcGF0aCBBTkQgdGhlIGFyZ3MgKG9wdGlvbiBBIG9mIHRoZSBpdGVtIOKAlCB0d29cbiAqIGNvbW1hbmRzIHdoZXJlIG9uZSBpcyB3cm9uZyBhZnRlciBhbiB1cGdyYWRlKTsgYSBsYXVuY2hlciB0aGF0IG5vdGljZXMgaXQgaXNcbiAqIG9ycGhhbmVkIGFuZCByZS1leGVjcyBhIG5ld2VyIHNpYmxpbmcgKEIg4oCUIGl0IGxlYW5zIG9uIGEgQ2xhdWRlIENvZGVcbiAqIGludGVybmFsIG1hcmtlciBhbmQgZG9lcyBub3RoaW5nIG9uY2UgdGhlIGRpcmVjdG9yeSBpcyBkZWxldGVkKTsgdmVyc2lvblxuICogbmVnb3RpYXRpb24uXG4gKlxuICog4pSA4pSAIE1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMUyAoQ29sZSdzIHJ1bGluZywgMjAyNi0wOS0yNCkg4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVpbHQgb24gYGZlYXQvbWluZC1tYXBwZXItcXVpZXQtaGFuZG9mZmAuIEl0IFJFVkVSU0VTIHRoZSBpbXBsZW1lbnRlcidzXG4gKiBydWxpbmcgb2YgYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0aGF0IG1pbmQtbWFwcGVyIGlzIGEgcHJlc2VuY2Ugc3BlbGxcbiAqIChpdHMgZGFlbW9uIGNvdW50cyBhbiBvcGVuIFNTRSB0YWlsIGFzIHRoZSBhZ2VudCBwcmVzZW50LCBzbyB0aGUgd2luZG93XG4gKiBhbHdheXMgcmUtYXJtZWQgTW9uaXRvcikuIENvbGUncyByZWFzb25pbmc6IG1pbmQtbWFwcGVyIHNlc3Npb25zIGFyZSB1c2VkXG4gKiBsaWtlIHNjcmlwdG9yaXVtJ3MsIGJ1cnN0cyBvZiBhY3Rpdml0eSB3aXRoIGJyZWFrcywgYW5kIGluIGEgYnJlYWsgdGhlIGFnZW50XG4gKiBzaG91bGQgbm90IGJlIHdva2VuIGV2ZXJ5IDMwIG1pbnV0ZXMuIFNvIG1pbmQtbWFwcGVyIHRha2VzIHRoZSBxdWlldCBoYW5kb2ZmXG4gKiB0byBgLS1vbmNlYCwgdGhlIGxvc3QgY29tZS1iYWNrIChgb3BlbiAtLW5vLW9wZW5gKSwgYW5kIGtlZXBzIGl0c1xuICogYC0tc2luY2UgTkBlcG9jaGAgYm9va21hcmsuIFRocmVlIHRoaW5ncyBoYWQgdG8gYmUgc2V0dGxlZCB0byBtYWtlIHRoYXRcbiAqIGhvbmVzdCwgZWFjaCBwaW5uZWQgaW4gYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3t0YWlsLHByZXNlbmNlfS50ZXN0LnRzYFxuICogYW5kIG11dGF0aW9uLWNvbmZpcm1lZDpcbiAqXG4gKiBNMSDCtyBQUkVTRU5DRSBMSU5HRVJTIEFDUk9TUyBUSEUgR0FQUyAodGhlIGRhZW1vbiwgYHNlcnZlci50c2BcbiAqICAgICAgYGFkanVzdEFnZW50c2ApLiBBIG9uZS1zaG90IGhvbGRzIGFuIFNTRSBjb25uZWN0aW9uLCBzbyBpdCBDT1VOVFMgYXNcbiAqICAgICAgcHJlc2VudCwgd2hpY2ggaXMgdHJ1ZTogdGhlIGFnZW50IHdpbGwgd2FrZSBvbiB0aGUgbmV4dCBldmVudC4gVGhlIGdhcHNcbiAqICAgICAgYXJlIHRoZSBwcm9ibGVtOiB3aW5kb3cg4oaSIHJlLWFybSwgcXVpZXQg4oaSIGAtLW9uY2VgLCBhbmQgYWJvdmUgYWxsXG4gKiAgICAgIGB0YWlsLndva2VgIOKGkiB0aGUgYWdlbnQgaGFuZGxlcyB0aGUgZXZlbnQg4oaSIE1vbml0b3IsIHdoaWNoIGxhc3RzIHRoZVxuICogICAgICBhZ2VudCdzIHdob2xlIHR1cm4uIFJhdywgdGhlIHN1cmZhY2UncyBoZWFkZXIgZG90ICh0aGUgb25seSB0aGluZ1xuICogICAgICBwcmVzZW5jZSBkcml2ZXMgdGhlcmUsIGJlc2lkZXMgdGhlIGRhZW1vbidzIGF1dG8tYHJlY2VpdmVkYCBmbGlwIG9uIGFcbiAqICAgICAgaHVtYW4gbWVzc2FnZSkgcmVhZCBcImNvbm5lY3RlZCDigJQgbm8gYWdlbnQgb24gdGhpcyBwcm9qZWN0XCIgd2hpbGUgdGhlXG4gKiAgICAgIGFnZW50IHdhcyB3b3JraW5nIHRoZSBib2FyZCwgYW5kIGEgbWVzc2FnZSBzZW50IHRoZW4gZ290IG5vXG4gKiAgICAgIGByZWNlaXZlZGAuIFRoZSBkYWVtb24gaGFzIG5vIGlkbGUgY2xvc2UsIHNvIG5vdGhpbmcgZWxzZSByZWFjdHMuIE5vd1xuICogICAgICB0aGUgY291bnQgSE9MRFMgZm9yIGBNSU5EX01BUFBFUl9QUkVTRU5DRV9MSU5HRVJfTVNgICgxNTAgcywgdGhlIHN0YWxsXG4gKiAgICAgIHdpbmRvdydzIGJlYXQpIGFmdGVyIHRoZSBsYXN0IHRhaWwgY2xvc2VzOiBhIHRhaWwgb3BlbmluZyBpbnNpZGUgaXRcbiAqICAgICAgZW1pdHMgbm90aGluZywgYW4gYWdlbnQtb25seSB3cml0ZSAoYC9hY3Rpdml0eWAsIGFuIGFnZW50IGAvc2VuZGApXG4gKiAgICAgIHJlc3RhcnRzIGl0LCBhbmQgc2lsZW5jZSBwYXN0IGl0IGRyb3BzIHRoZSBjb3VudCB0byAwLlxuICogICAgICDimpYgTm90IHRha2VuOiByZS1hcm1pbmcgTW9uaXRvciBCRUZPUkUgaGFuZGxpbmcgYSB3b2tlbiBldmVudCAodGhhdCBpc1xuICogICAgICB0aGUgc2hhcmVkIHJ1bGUsIHdvcmQtZm9yLXdvcmQgaW4gZXZlcnkgc3BlbGwpOyByZWZyZXNoaW5nIG9uIGV2ZXJ5XG4gKiAgICAgIGJvYXJkIHdyaXRlICh0aGUgYnJvd3NlciBQT1NUcyB0aGUgc2FtZSByb3V0ZXMsIHNvIHRoZSBodW1hbidzIG93blxuICogICAgICBjbGlja3Mgd291bGQga2VlcCB0aGUgZG90IGxpdCkuIENvc3Q6IGFuIGFnZW50IHRoYXQgcmVhbGx5IGxlZnQgcmVhZHNcbiAqICAgICAgXCJoZXJlXCIgZm9yIHVwIHRvIDE1MCBzLlxuICogTTIgwrcgYHByZXNlbmNlLmNoYW5nZWRgIElTIE5PVCBDT1VOVEVEIChtaW5kLW1hcHBlcidzIGBjb3VudHNgKS4gSXQgaXMgT05cbiAqICAgICAgVEhFIExPRywgd2l0aCBhbiBpZCwgYW5kIGEgdGFpbCdzIG93biBjb25uZWN0IGVtaXRzIG9uZSBvbnRvIGl0cyBvd25cbiAqICAgICAgc3RyZWFtLCBzbyBjb3VudGVkIGl0IG1hZGUgZXZlcnkgd2luZG93IFwiYWN0aXZlXCIgYW5kIHdvdWxkIHdha2UgZXZlcnlcbiAqICAgICAgYC0tb25jZWAgb24gaXRzZWxmLiBUaGUgbGluZ2VyIHJlbW92ZXMgbW9zdCBvZiB0aGF0IGNodXJuOyBgY291bnRzYFxuICogICAgICByZW1vdmVzIHRoZSByZXN0IChhIGZpcnN0IGFybSwgYW5vdGhlciBhZ2VudCBjb21pbmcgb3IgZ29pbmcpLlxuICogTTMgwrcgQSBERUFEIERBRU1PTiBJUyBMT1NULCBOT1QgVU5SRVNPTFZFRCAobWluZC1tYXBwZXIncyBgcmVzb2x2ZWApLiBJdHNcbiAqICAgICAgZGlzY292ZXJ5IHByb2JlcyB0aGUgZGFlbW9uJ3MgcGlkLCBzbyBhIGtpbGxlZCBkYWVtb24gbWFkZSBgcmVzb2x2ZWBcbiAqICAgICAgYW5zd2VyIG51bGwgYW5kIGFuIHVucmVzb2x2ZWQgdGFpbCByZXRyaWVzIGZvcmV2ZXI6IGEgYC0tb25jZWAgd291bGRcbiAqICAgICAgaGF2ZSBzbGVwdCBmb3IgZ29vZCAoRDEncyBkZWZlY3QpLiBUaGUgdGFpbCBrZWVwcyB0aGUgbGFzdCBVUkwgaXRcbiAqICAgICAgcmVzb2x2ZWQsIHNvIHRoZSBkZWFkIHBvcnQgcmVmdXNlcyBhbmQgYExPU1RfQUZURVJfUkVGVVNBTFNgIGVuZHMgaXRcbiAqICAgICAgd2l0aCBgdGFpbC5sb3N0YCDihpIgYG9wZW4gLS1uby1vcGVuYCwgdGhlbiBhIHRhaWwgd2l0aCBubyBgLS1zaW5jZWAuXG4gKiAgICAgIE1pbmQtbWFwcGVyIGhhcyBubyBzZXNzaW9uIHRvIGNsb3NlLCBzbyBpdCBuZXZlciBwcmludHMgYHRhaWwuY2xvc2VkYC5cbiAqICAgICAgTWVhc3VyZWQgb24gYSByZWFsIGBraWxsIC05YCB1bmRlciBhIGAtLW9uY2VgOiBgdGFpbC5sb3N0YCA3IHMgbGF0ZXIsXG4gKiAgICAgIG5vdCAwLjc1IHMsIGJlY2F1c2UgbWluZC1tYXBwZXIncyBvd24gYmFja29mZiBzdGFydHMgYXQgMSBzICgxICsgMiArIDQpLlxuICogICAgICBNMeKAk00zIHdlcmUgZHJpdmVuIG9uIGEgcmVhbCBkYWVtb24gd2l0aCBhIDQgcyB3aW5kb3c6IGFjdGl2ZSDihpIgd2luZG93LFxuICogICAgICBxdWlldCDihpIgYC0tb25jZWAsIGEgaHVtYW4gbWVzc2FnZSB3b2tlIGl0LCBiYWNrIHRvIE1vbml0b3I7IHByZXNlbmNlXG4gKiAgICAgIG5ldmVyIGRyb3BwZWQgYWNyb3NzIHRoZSBnYXBzLlxuICpcbiAqIOKaliBgLS1vbmNlYCBFTkRTIE9OIFRIRSBGSVJTVCBGUkFNRSwgd2l0aCBubyBkcmFpbi4gQSBidXJzdCBhcnJpdmVzIHNwbGl0OiB0aGVcbiAqICAgZmlyc3QgZXZlbnQgb24gdGhlIG9uZS1zaG90LCB0aGUgcmVzdCBvbiB0aGUgTW9uaXRvciByZS1hcm0sIHdoaWNoIGxvc2VzXG4gKiAgIG5vdGhpbmcgYmVjYXVzZSBvZiB0aGUgYm9va21hcmsuIFRoZSBzcGlrZSBvZmZlcmVkIGEgfjIwMCBtcyBkcmFpbiBhcyBhblxuICogICBvcHRpb24sIG5vdCBhIHJlcXVpcmVtZW50OyBub3QgdGFrZW4sIGJlY2F1c2UgaXQgYWRkcyBhIHRpbWVyIHRvIHRoZVxuICogICBleGl0IHBhdGggd2hvc2UgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gbWFrZSBpbXBvc3NpYmxlLlxuICog4pqWIFRIRSBMSU5FJ1MgYGNvbW1hbmRgIElTIENPTVBMRVRFIEJVVCBGT1IgVEhFIExBVU5DSEVSOiBwaW5uZWQgdG8gdGhlXG4gKiAgIHNlc3Npb24gdGhpcyB0YWlsIHdhcyBib3VuZCB0bywgd2l0aCBpdHMgc2NvcGUgZmxhZ3MuIFRoZSBza2lsbHMgbmFtZSB0aGVcbiAqICAgcnVsZSBvbmNlLCBsYXVuY2hlciBmb3JtIGluY2x1ZGVkOyB0aGUgbGluZSBjYXJyaWVzIHRoZSBzcGVjaWZpY3MuXG4gKlxuICogUzEgwrcgV0hPIENMT1NFRCBJVCBSSURFUyBUSEUgTElORSAoc2NyaXB0b3JpdW0ncyBFbmQgc2Vzc2lvbiwgMjAyNi0xMC0wMSkuXG4gKiAgICAgIEEgc3BlbGwgd2hvc2UgYGNsb3NlZGAgZnJhbWUgc2F5cyB3aG8gZW5kZWQgdGhlIHNlc3Npb24gcGFzc2VzXG4gKiAgICAgIGBjbG9zZWRCeWAsIGFuZCBgdGFpbC5jbG9zZWRgIGNhcnJpZXMgaXQgYXMgYGJ5YC4gYGJ5OiBcImh1bWFuXCJgIGNoYW5nZXNcbiAqICAgICAgdGhlIGhpbnQ6IHRoZSBodW1hbiBlbmRlZCBpdCBPTiBQVVJQT1NFLCBzbyB0aGUgYWdlbnQgc3RvcHMgYW5kIGRvZXMgbm90XG4gKiAgICAgIHJlb3BlbiB1bmxlc3MgYXNrZWQg4oCUIHRoZSB3YXkgYmFjayBpcyBzdGlsbCBuYW1lZCwgY29uZGl0aW9uZWQgb24gdGhhdC5cbiAqICAgICAgVGhlIGFnZW50IHJvdXRlcyBvbiBgYnlgLCBuZXZlciBvbiB0aGUgaGludCdzIHByb3NlLiBBIHJlLWFybSBhZnRlclxuICogICAgICB0aGUgZW5kIHNlZXMgbm8gY2xvc2luZyBmcmFtZSAoRDEncyBwYXRoKSwgc28gdGhlIHNwZWxsIGFsc28gcGFzc2VzXG4gKiAgICAgIGBnb25lQnlgLCByZWFkIGZyb20gd2hlcmUgdGhlIGZhY3Qgb3V0bGl2ZXMgdGhlIGRhZW1vbjsgd2l0aG91dCBpdCB0aGVcbiAqICAgICAgcmUtYXJtZWQgbGluZSBkcm9wcGVkIGBieWAgYW5kIGludml0ZWQgdGhlIHJlb3BlbiAodmVyaWZpZXIsIDIwMjYtMTAtMDEpLlxuICogICAgICDimpYgT3B0aW9ucyBub3QgdGFrZW46IGEgc3BlbGwtc2lkZSByZXdyaXRlIG9mIHRoZSBwcmludGVkIGxpbmUgKGEgc2Vjb25kXG4gKiAgICAgIHdyaXRlciBvZiB0aGUgc2FtZSBsaW5lKSwgb3IgYSBzcGVsbC1zdXBwbGllZCBoaW50IChlYWNoIHNwZWxsIHdvdWxkXG4gKiAgICAgIHdvcmQgXCJvbiBwdXJwb3NlXCIgaXRzIG93biB3YXkpLlxuICovXG5pbXBvcnQgeyB0eXBlIFNzZUZyYW1lLCB0eXBlIFRhaWxPcHRpb25zLCB0YWlsRXZlbnRzIH0gZnJvbSBcIi4vdGFpbEV2ZW50c1wiO1xuXG4vKiogQ2xhdWRlIENvZGUncyBNb25pdG9yIGNhcCwgcGVyIHRoZSB0b29sJ3Mgc2NoZW1hIChcIkRlYWRsaW5lcyBhYm92ZVxuICogIDE4MDAwMDBtcyBhcmUgY2FwcGVkIHRvIDE4MDAwMDBtc1wiKS4gQSBoYXJuZXNzIG51bWJlcjogaWYgaXQgY2hhbmdlcywgdGhpc1xuICogIGNoYW5nZXMsIGFuZCBzbyBkb2VzIHRoZSBza2lsbHMnIGB0aW1lb3V0X21zYC4gKi9cbmV4cG9ydCBjb25zdCBNT05JVE9SX0NBUF9NUyA9IDFfODAwXzAwMDtcbi8qKiBTZWUgQTQgaW4gdGhlIGhlYWRlciBmb3Igd2h5IGEgbWludXRlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19NQVJHSU5fTVMgPSA2MF8wMDA7XG5leHBvcnQgY29uc3QgREVGQVVMVF9XSU5ET1dfTVMgPSBNT05JVE9SX0NBUF9NUyAtIFdJTkRPV19NQVJHSU5fTVM7XG4vKiogVGhlIGluamVjdGlvbiBwb2ludCBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiAoc2VlIEE0KS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfRU5WID0gXCJTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNcIjtcbi8qKiBUaGUgb25lIHNlbnRlbmNlIGV2ZXJ5IGB0YWlsYCdzIGhlbHAgY2Fycmllcywgc28gYSBodW1hbiB3YXRjaGluZyBpbiBhXG4gKiAgdGVybWluYWwgZmluZHMgdGhlIGVzY2FwZSBoYXRjaCB3aGVyZSB0aGV5IGxvb2sgKEQ0KS4gV29yZGVkIG9uY2UgaGVyZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfSEVMUCA9XG4gIFwiZW5kcyBpdHNlbGYgYmVmb3JlIE1vbml0b3IncyAzMC1taW51dGUgY2FwIHdpdGggYSBsaW5lIG5hbWluZyB0aGUgbmV4dCBhY3Q7IGEgaHVtYW4gd2F0Y2hpbmcgYSB0ZXJtaW5hbCBrZWVwcyBpdCBvcGVuIHdpdGggU1BFTExCT09LX1RBSUxfV0lORE9XX01TPTBcIjtcblxuLyoqIENvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3cgdGhhdCBtYWtlIHRoZSBkYWVtb24gXCJsb3N0XCIgKHNlZSBBMikuIFRocmVlXG4gKiAgc3BhbiBhYm91dCAwLjc1IHMgdW5kZXIgdGhlIGtpdCdzIGRlZmF1bHQgYmFja29mZiAoMjUwICsgNTAwIG1zIGJldHdlZW5cbiAqICB0aGVtKTogYSBsaXZlIGRhZW1vbiBuZXZlciByZWZ1c2VzIGl0cyBvd24gcG9ydCwgYW5kIHRoZSB0d28gZXh0cmEgYXR0ZW1wdHNcbiAqICBvbmx5IGJ1eSB0b2xlcmFuY2UgZm9yIGEgcmVzdGFydCB0aGF0IHJlYmluZHMgdGhlIHNhbWUgcG9ydC4gKi9cbmV4cG9ydCBjb25zdCBMT1NUX0FGVEVSX1JFRlVTQUxTID0gMztcblxuLyoqIFRoZSB3aW5kb3cgbGVuZ3RoOiB0aGUgZW52IHZhbHVlIHdoZW4gaXQgaXMgYSBub24tbmVnYXRpdmUgaW50ZWdlciwgZWxzZSB0aGVcbiAqICBkZWZhdWx0LiBgMGAgbWVhbnMgbm8gd2luZG93LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVXaW5kb3dNcyhyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCk6IG51bWJlciB7XG4gIGlmIChyYXcgPT09IHVuZGVmaW5lZCB8fCByYXcudHJpbSgpID09PSBcIlwiKSByZXR1cm4gREVGQVVMVF9XSU5ET1dfTVM7XG4gIGNvbnN0IG4gPSBOdW1iZXIocmF3KTtcbiAgcmV0dXJuIE51bWJlci5pc0ludGVnZXIobikgJiYgbiA+PSAwID8gbiA6IERFRkFVTFRfV0lORE9XX01TO1xufVxuXG5leHBvcnQgdHlwZSBUYWlsTW9kZSA9IFwid2F0Y2hcIiB8IFwib25jZVwiO1xuXG4vKiogSG93IGEgdGFpbCBlbmRlZC4gYHdpbmRvd2AgaXMgb3VyIG93biBkZWFkbGluZSwgYGV2ZW50YCBpcyBhIGAtLW9uY2VgJ3NcbiAqICBmaXJzdCBmcmFtZSwgYGNsb3NlZGAgaXMgdGhlIHNlc3Npb24gZW5kaW5nIChhIGBjbG9zZWRgIGZyYW1lIG9yIHRoZSBwaW5uZWRcbiAqICBzZXNzaW9uJ3MgcG9pbnRlciB2YW5pc2hpbmcpLCBgbG9zdGAgaXMgdGhlIGRhZW1vbiByZWZ1c2luZyBjb25uZWN0aW9ucyxcbiAqICBhbmQgYHN0b3BwZWRgIGlzIGEgc2lnbmFsLCBhIGNhbGxlcidzIGFib3J0IG9yIGEgY2xvc2VkIHN0ZG91dC4gKi9cbmV4cG9ydCB0eXBlIFRhaWxFbmQgPSBcIndpbmRvd1wiIHwgXCJldmVudFwiIHwgXCJjbG9zZWRcIiB8IFwibG9zdFwiIHwgXCJzdG9wcGVkXCI7XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZJbnB1dCA9IHtcbiAgLyoqIFRoZSBzcGVsbCB3aG9zZSB0YWlsIHRoaXMgaXMsIHNvIHRoZSBhZ2VudCBrbm93cyB3aG9zZSBsYXVuY2hlciBydW5zIGl0LiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBlbmQ6IFRhaWxFbmQ7XG4gIC8qKiBXaG8gZW5kZWQgYSBgY2xvc2VkYCBzZXNzaW9uLCB3aGVuIGl0cyBjbG9zaW5nIGZyYW1lIHNhaWQgKFMxKS4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogTG9nIGZyYW1lcyB0aGlzIHByb2Nlc3Mgd3JvdGUgdG8gc3Rkb3V0IChBMykuICovXG4gIGV2ZW50czogbnVtYmVyO1xuICAvKiogVGhlIGJvb2ttYXJrOiB0aGUgaGlnaGVzdCBpZCB0aGlzIHByb2Nlc3MgaGFzIHNlZW4uICovXG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogVGhlIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaC4gKi9cbiAgZXBvY2g/OiBzdHJpbmc7XG4gIHByZXNlbmNlOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkNvbW1hbmRzID0ge1xuICAvKiogVGhlIHJlLWFybSwgd2l0aCB0aGUgYm9va21hcms7IGBvbmNlYCBhZGRzIGAtLW9uY2VgLiBgZXBvY2hgIGlzIHRoZVxuICAgKiAgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIG9uZTogYSBzcGVsbCB3aG9zZVxuICAgKiAgYC0tc2luY2VgIHBhcnNlcyBgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSBwcmludHMgaXQuICovXG4gIHRhaWw6IChvOiB7IHNpbmNlOiBudW1iZXI7IG9uY2U6IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0pID0+IHN0cmluZztcbiAgLyoqIEhvdyB0byBjb21lIGJhY2sgZnJvbSBhIHNlc3Npb24gdGhhdCBpcyBnb25lLiAqL1xuICBjb21lQmFjazogKCkgPT4gc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZkxpbmUgPSB7XG4gIHR5cGU6IFwidGFpbC53aW5kb3dcIiB8IFwidGFpbC5xdWlldFwiIHwgXCJ0YWlsLndva2VcIiB8IFwidGFpbC5jbG9zZWRcIiB8IFwidGFpbC5sb3N0XCI7XG4gIC8qKiBXaG9zZSBsYXVuY2hlciBydW5zIGBjb21tYW5kYC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZXZlbnRzOiBudW1iZXI7XG4gIGN1cnNvcjogbnVtYmVyO1xuICAvKiogYHRhaWwuY2xvc2VkYCBvbmx5OiB3aG8gZW5kZWQgdGhlIHNlc3Npb24sIHdoZW4gdGhlIHNwZWxsIHNheXMgKFMxKS4gKi9cbiAgYnk/OiBzdHJpbmc7XG4gIC8qKiBgbW9uaXRvcmA6IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHdpdGggdGhlIGxhdW5jaGVyICsgYGNvbW1hbmRgLlxuICAgKiAgYGJhY2tncm91bmRgOiBydW4gdGhlIGxhdW5jaGVyICsgYGNvbW1hbmRgIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2suXG4gICAqICBgc3RvcGA6IG5vdGhpbmcgdG8gd2F0Y2g7IGBjb21tYW5kYCBpcyBob3cgdG8gY29tZSBiYWNrLCBpZiB3YW50ZWQuICovXG4gIG5leHQ6IFwibW9uaXRvclwiIHwgXCJiYWNrZ3JvdW5kXCIgfCBcInN0b3BcIjtcbiAgLyoqIFRoZSB2ZXJiIGFuZCBpdHMgYXJndW1lbnRzIE9OTFkg4oCUIG5vIGxhdW5jaGVyLCBubyBwYXRoLiBUaGUgYWdlbnQgcnVuc1xuICAgKiAgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+YC4gKi9cbiAgY29tbWFuZDogc3RyaW5nO1xuICBoaW50OiBzdHJpbmc7XG59O1xuXG4vKiogSG93IHRoZSBhZ2VudCBydW5zIGEgcHJpbnRlZCBgY29tbWFuZGA6IHdpdGggSVRTIE9XTiBsYXVuY2hlciwgbmV2ZXIgYSBwYXRoXG4gKiAgdGhpcyBwcm9jZXNzIG5hbWVzICh0aGUgcnVsaW5nIG9uIHRoZSB2ZXJzaW9uZWQgcGx1Z2luIHBhdGgsIGluIHRoZSBoZWFkZXIpLiAqL1xuZXhwb3J0IGNvbnN0IFJVTl9XSVRIX0xBVU5DSEVSID0gXCJidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPlwiO1xuXG4vKiogVGhlIGNvbWUtYmFjayBoaW50LCB3aXRoIGhvdyB0byBSRVNVTUUgYWZ0ZXIgY29taW5nIGJhY2sgKEQyKTogYSByZXN0b3JlZFxuICogIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIG1lYW5zIG5vdGhpbmcgdGhlcmUuICovXG5jb25zdCBDT01FX0JBQ0sgPSAod2h5OiBzdHJpbmcsIGxlYWQgPSBcIlRvIGJyaW5nIGl0IGJhY2tcIikgPT5cbiAgYCR7d2h5fSAke2xlYWR9LCBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn07IHRoZW4gYXJtIHRoZSB0YWlsIGFnYWluIHdpdGggbm8gLS1zaW5jZSwgb24gdGhlIHNlc3Npb24gaWQgaXQgcHJpbnRzIHdoZXJlIHRoZXJlIGlzIG9uZSAoYSByZXN0YXJ0ZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBldmVudCBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgZG9lcyBub3QgYXBwbHkpYDtcblxuLyoqXG4gKiBUSEUgREVDSVNJT046IGdpdmVuIGhvdyB0aGUgdGFpbCBlbmRlZCwgd2hpY2ggbGluZSBpdCBwcmludHMuIFB1cmUsIHNvIGV2ZXJ5XG4gKiBzdGF0ZSBpcyBhIGxpdGVyYWwgY2VsbCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuIFJldHVybnMgbnVsbCBmb3IgYHN0b3BwZWRgOlxuICogYSBodW1hbidzIEN0cmwtQyBvciBhIGNhbGxlcidzIGFib3J0IGlzIG5vdCBhIGhhbmRvZmYuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYW5kb2ZmKHM6IEhhbmRvZmZJbnB1dCwgY21kOiBIYW5kb2ZmQ29tbWFuZHMpOiBIYW5kb2ZmTGluZSB8IG51bGwge1xuICBjb25zdCBiYXNlID0geyBzcGVsbDogcy5zcGVsbCwgZXZlbnRzOiBzLmV2ZW50cywgY3Vyc29yOiBzLmN1cnNvciB9O1xuICBzd2l0Y2ggKHMuZW5kKSB7XG4gICAgY2FzZSBcInN0b3BwZWRcIjpcbiAgICAgIHJldHVybiBudWxsO1xuICAgIGNhc2UgXCJjbG9zZWRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5jbG9zZWRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgLi4uKHMuYnkgPyB7IGJ5OiBzLmJ5IH0gOiB7fSksXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDpcbiAgICAgICAgICBzLmJ5ID09PSBcImh1bWFuXCJcbiAgICAgICAgICAgID8gQ09NRV9CQUNLKFxuICAgICAgICAgICAgICAgIFwidGhlIGh1bWFuIGVuZGVkIHRoaXMgc2Vzc2lvbiBvbiBwdXJwb3NlOyBzdG9wIHdhdGNoaW5nLCBhbmQgZG8gbm90IHJlb3BlbiBpdCB1bmxlc3MgdGhleSBhc2suXCIsXG4gICAgICAgICAgICAgICAgXCJJZiB0aGV5IGFza1wiLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICA6IENPTUVfQkFDSyhcInRoZSBzZXNzaW9uIGNsb3NlZDsgdGhlcmUgaXMgbm90aGluZyBsZWZ0IHRvIHdhdGNoLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImxvc3RcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5sb3N0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwic3RvcFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQuY29tZUJhY2soKSxcbiAgICAgICAgaGludDogQ09NRV9CQUNLKFwibG9zdCB0aGUgZGFlbW9uIChpdCBjcmFzaGVkIG9yIHdhcyBraWxsZWQpOyBub3RoaW5nIGlzIGxpc3RlbmluZy5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJldmVudFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLndva2VcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiBmYWxzZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBoYW5kbGUgdGhlIGV2ZW50IGFib3ZlLCB0aGVuIGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgfTtcbiAgICBjYXNlIFwid2luZG93XCI6XG4gICAgICBpZiAocy5wcmVzZW5jZSB8fCBzLmV2ZW50cyA+IDApXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgdHlwZTogXCJ0YWlsLndpbmRvd1wiLFxuICAgICAgICAgIC4uLmJhc2UsXG4gICAgICAgICAgbmV4dDogXCJtb25pdG9yXCIsXG4gICAgICAgICAgY29tbWFuZDogY21kLnRhaWwoe1xuICAgICAgICAgICAgc2luY2U6IHMuY3Vyc29yLFxuICAgICAgICAgICAgb25jZTogZmFsc2UsXG4gICAgICAgICAgICAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgICBoaW50OiBgdGhlIHdpbmRvdyBlbmRlZCBiZWZvcmUgTW9uaXRvcidzIGNhcDsgYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICAgIH07XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwucXVpZXRcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJiYWNrZ3JvdW5kXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHsgc2luY2U6IHMuY3Vyc29yLCBvbmNlOiB0cnVlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYG5vdGhpbmcgb24gdGhlIGxvZyB0aGlzIHdpbmRvdzsgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9IGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2sgKHJ1bl9pbl9iYWNrZ3JvdW5kKSDigJQgaXQgZXhpdHMgb24gdGhlIG5leHQgZXZlbnRgLFxuICAgICAgfTtcbiAgfVxufVxuXG4vKiogUE9TSVggc2luZ2xlLXF1b3RlIGFuIGFyZ3VtZW50IHdoZW4gaXQgbmVlZHMgaXQsIHNvIGEgcHJpbnRlZCBgY29tbWFuZGBcbiAqICBydW5zIGFzIHByaW50ZWQgYWZ0ZXIgdGhlIGFnZW50J3Mgb3duIGxhdW5jaGVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNoZWxsUXVvdGUoYXJnOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gL15bQS1aYS16MC05X0AlKz06LC4vLV0rJC8udGVzdChhcmcpID8gYXJnIDogYCcke2FyZy5yZXBsYWNlQWxsKFwiJ1wiLCBgJ1xcXFwnJ2ApfSdgO1xufVxuXG4vKipcbiAqIFJlYWQgYSBgLS1zaW5jZWAgdmFsdWU6IGFuIGV2ZW50IGlkLCBvcHRpb25hbGx5IGNhcnJ5aW5nIHRoZSBlcG9jaCBvZiB0aGVcbiAqIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgRDIpLiBOdWxsIHdoZW4gdGhlIGlkIGlzIG5vdCBhbiBpbnRlZ2VyLlxuICogRm9yIHRoZSBzcGVsbHMgd2hvc2UgZGFlbW9uIHN0YW1wcyBhbiBlcG9jaDsgdGhlIHJlc3QgdGFrZSBhIHBsYWluIGlkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCb29rbWFyayh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgbnVsbCB7XG4gIGNvbnN0IGF0ID0gdG9rZW4uaW5kZXhPZihcIkBcIik7XG4gIGNvbnN0IGlkID0gYXQgPT09IC0xID8gdG9rZW4gOiB0b2tlbi5zbGljZSgwLCBhdCk7XG4gIGNvbnN0IGVwb2NoID0gYXQgPT09IC0xID8gXCJcIiA6IHRva2VuLnNsaWNlKGF0ICsgMSk7XG4gIGlmICghL14tP1xcZCskLy50ZXN0KGlkLnRyaW0oKSkpIHJldHVybiBudWxsO1xuICBpZiAoYXQgIT09IC0xICYmIGVwb2NoID09PSBcIlwiKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgc2luY2U6IE51bWJlci5wYXJzZUludChpZCwgMTApLCAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSkgfTtcbn1cblxuLyoqXG4gKiBFdmVyeSB0YWlsJ3MgYC0tc2luY2VgLCByZWFkIHRoZSBzYW1lIHdheTogYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cywgb3IgYVxuICogcmVmdXNhbCB0aGF0IE5BTUVTIHRoZSBhY2NlcHRlZCBmb3Jtcy4g4puUIE5FVkVSIEEgU0lMRU5UIE1JU1BBUlNFLiBUaGUgZm91clxuICogbm8tZXBvY2ggc3BlbGxzIHVzZWQgYHBhcnNlSW50YCwgd2hpY2ggcmVhZCBhbiBlcG9jaCBib29rbWFyayAoYDRAZTFgLCBmcm9tXG4gKiBhIGhhbmRvZmYgbGluZSBhbm90aGVyIHZlcnNpb24gb3Igc3BlbGwgcHJpbnRlZCkgYXMgYDRgIGFuZCBkcm9wcGVkIHRoZVxuICogcmVzdCB3aXRob3V0IGEgd29yZDsgbWluZC1tYXBwZXIgcmVhZCBqdW5rIGFzIDAgYW5kIGFzdHJvbGFiZSBhcyAtMSwgYm90aCBhXG4gKiB3aG9sZSByZXBsYXkuIEEgcHJpbnRlZCBjb21tYW5kIG91dGxpdmVzIHRoZSBDTEkgdGhhdCBwcmludGVkIGl0ICh0aGVcbiAqIGxhdW5jaGVyLWZyZWUgcnVsaW5nLCBpbiB0aGUgaGVhZGVyKSwgc28gdGhlIHBhcnNlciBpcyB3aGVyZSBhbiBvbGRlciBvclxuICogbmV3ZXIgZm9ybSBtdXN0IHNheSB3aGF0IHdlbnQgd3JvbmcuXG4gKlxuICogYGVwb2NoYDogd2hldGhlciB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBvbmUgKHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUsXG4gKiBtaW5kLW1hcHBlcikuIGBtaW5gOiB0aGUgc21hbGxlc3QgaWQgYWNjZXB0ZWQgKGdyYXBldmluZSB0YWtlcyBubyAtMSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWFkU2luY2UoXG4gIHRva2VuOiBzdHJpbmcsXG4gIG86IHsgZXBvY2g6IGJvb2xlYW47IG1pbj86IG51bWJlciB9LFxuKTogeyBvazogdHJ1ZTsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IHsgb2s6IGZhbHNlOyBtZXNzYWdlOiBzdHJpbmcgfSB7XG4gIGNvbnN0IG1pbiA9IG8ubWluID8/IC0xO1xuICBjb25zdCBiID0gcGFyc2VCb29rbWFyayh0b2tlbik7XG4gIGlmIChiICE9PSBudWxsICYmIGIuc2luY2UgPj0gbWluICYmIChiLmVwb2NoID09PSB1bmRlZmluZWQgfHwgby5lcG9jaCkpXG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHNpbmNlOiBiLnNpbmNlLCAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSB9O1xuICBjb25zdCBpZCA9XG4gICAgbWluIDwgMFxuICAgICAgPyBcImFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyOyAtLXNpbmNlPS0xIGZvciBldmVyeXRoaW5nKVwiXG4gICAgICA6IGBhbiBldmVudCBpZCAoYW4gaW50ZWdlciwgJHttaW59IG9yIG1vcmUpYDtcbiAgY29uc3QgZm9ybXMgPSBvLmVwb2NoID8gYCR7aWR9LCBvciA8aWQ+QDxlcG9jaD4gYXMgYSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0YCA6IGlkO1xuICBjb25zdCB3aHkgPVxuICAgICFvLmVwb2NoICYmIHRva2VuLmluY2x1ZGVzKFwiQFwiKVxuICAgICAgPyBgOyB0aGlzIHNwZWxsJ3MgbG9nIHN0YW1wcyBubyBlcG9jaCwgc28gcGFzcyB0aGUgaWQgd2l0aG91dCB0aGUgXCJA4oCmXCIgcGFydGBcbiAgICAgIDogXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBvazogZmFsc2UsXG4gICAgbWVzc2FnZTogYC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBib29rbWFyayB0aGlzIHRhaWwgYWNjZXB0cyDigJQgZ2l2ZSAke2Zvcm1zfSR7d2h5fWAsXG4gIH07XG59XG5cbi8qKiBKb2luIGFuIGFyZ3YgaW50byBvbmUgcnVubmFibGUgY29tbWFuZCBsaW5lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbW1hbmRMaW5lKGFyZ3Y6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGFyZ3YubWFwKHNoZWxsUXVvdGUpLmpvaW4oXCIgXCIpO1xufVxuXG4vKiogVGhlIHJlLWFybSBmb3IgYSBzcGVsbCB3aG9zZSB0YWlsIGlzIGA8cHJlZml44oCmPiAtLXNpbmNlIE5bQGVwb2NoXSBbLS1vbmNlXWAuXG4gKiAgUGFzcyBgZXBvY2hgIG9ubHkgZm9yIGEgc3BlbGwgd2hvc2UgYC0tc2luY2VgIHBhcnNlcyBpdCAoYHBhcnNlQm9va21hcmtgKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsQ29tbWFuZChcbiAgcHJlZml4OiByZWFkb25seSBzdHJpbmdbXSxcbiAgc2luY2U6IG51bWJlcixcbiAgb25jZTogYm9vbGVhbixcbiAgZXBvY2g/OiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICAvLyDimqAgQSBuZWdhdGl2ZSBib29rbWFyayAobm90aGluZyBzZWVuIHlldCkgaXMgc3BlbGxlZCBgLS1zaW5jZT0tMWA6IHRoZVxuICAvLyBwYXJzZXJzIHJlYWQgYSBiYXJlIGAtMWAgYWZ0ZXIgYSBmbGFnIGFzIGFub3RoZXIgZmxhZyBhbmQgcmVmdXNlIGl0LlxuICBjb25zdCBtYXJrID0gZXBvY2ggPyBgJHtzaW5jZX1AJHtlcG9jaH1gIDogU3RyaW5nKHNpbmNlKTtcbiAgY29uc3QgYXQgPSBzaW5jZSA8IDAgPyBbYC0tc2luY2U9JHttYXJrfWBdIDogW1wiLS1zaW5jZVwiLCBtYXJrXTtcbiAgcmV0dXJuIGNvbW1hbmRMaW5lKFsuLi5wcmVmaXgsIC4uLmF0LCAuLi4ob25jZSA/IFtcIi0tb25jZVwiXSA6IFtdKV0pO1xufVxuXG5leHBvcnQgdHlwZSBIYW5kb2ZmT3B0aW9uczxFdj4gPSB7XG4gIC8qKiBUaGUgc3BlbGwncyBuYW1lLCBjYXJyaWVkIG9uIHRoZSBsaW5lICh3aG9zZSBsYXVuY2hlciBydW5zIGl0KS4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBBIHByZXNlbmNlIHNwZWxsOiBhbHdheXMgYHRhaWwud2luZG93YCBhdCB0aGUgd2luZG93J3MgZW5kLCBuZXZlciBsb3N0LiAqL1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbiAgLyoqIERlZmF1bHQ6IGByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pYC4gYDBgID0gbm8gd2luZG93LiAqL1xuICB3aW5kb3dNcz86IG51bWJlcjtcbiAgLyoqIFdoZXRoZXIgYW4gZW1pdHRlZCBmcmFtZSBpcyBhIExPRyBmcmFtZSAoQTMpLiBEZWZhdWx0OiBldmVyeSBvbmUuICovXG4gIGNvdW50cz86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFdoaWNoIHRlcm1pbmFsIGZyYW1lIG1lYW5zIHRoZSBzZXNzaW9uIGNsb3NlZC4gRGVmYXVsdDogZXZlcnkgdGVybWluYWwuICovXG4gIGlzQ2xvc2VkPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIFdobyB0aGUgY2xvc2luZyBmcmFtZSBzYXlzIGVuZGVkIHRoZSBzZXNzaW9uIChTMSk7IGNhcnJpZWQgb24gYHRhaWwuY2xvc2VkYC4gKi9cbiAgY2xvc2VkQnk/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBXaG8gZW5kZWQgYSBzZXNzaW9uIGZvdW5kIEdPTkUgKEQxOiByZS1hcm1lZCBhZnRlciBpdCBjbG9zZWQsIHNvIG5vXG4gICAqICBjbG9zaW5nIGZyYW1lIGlzIGV2ZXIgc2VlbiksIHJlYWQgZnJvbSB3aGVyZXZlciB0aGUgc3BlbGwga2VlcHMgaXQg4oCUIGFcbiAgICogIG1hbmlmZXN0IHRoYXQgb3V0bGl2ZXMgdGhlIGRhZW1vbi4gQ2FycmllZCBvbiBgdGFpbC5jbG9zZWRgIGFzIGBieWAsIHNvXG4gICAqICB0aGUgbGluZSBzYXlzIHdoYXQgdGhlIGxpdmUgcGF0aCdzIGBjbG9zZWRCeWAgd291bGQgaGF2ZSAoUzEpLiAqL1xuICBnb25lQnk/OiAoKSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGNvbW1hbmRzOiBIYW5kb2ZmQ29tbWFuZHM7XG59O1xuXG4vKipcbiAqIFJ1biBgdGFpbEV2ZW50c2Agd2l0aCB0aGUgaGFuZG9mZjogdGhlIHdpbmRvdywgYC0tb25jZWAsIHRoZSBsb3N0IHJ1bGUsIGFuZFxuICogdGhlIGZpbmFsIGxpbmUuIFJldHVybnMgdGhlIGV4aXQgY29kZSwgbGlrZSBgdGFpbEV2ZW50c2AsIGFuZCBuZXZlciBleGl0cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxXaXRoSGFuZG9mZjxFdj4oXG4gIHRhaWw6IFRhaWxPcHRpb25zPEV2PixcbiAgaDogSGFuZG9mZk9wdGlvbnM8RXY+LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gdGFpbC5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IHdpbmRvd01zID0gaC53aW5kb3dNcyA/PyByZXNvbHZlV2luZG93TXMocHJvY2Vzcy5lbnZbV0lORE9XX0VOVl0pO1xuICBjb25zdCBjb3VudHMgPSBoLmNvdW50cyA/PyAoKCkgPT4gdHJ1ZSk7XG4gIGNvbnN0IGVuZE9uTG9zdCA9ICFoLnByZXNlbmNlO1xuXG4gIGNvbnN0IGFjID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gYWMuYWJvcnQoKTtcbiAgdGFpbC5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKHRhaWwuc2lnbmFsPy5hYm9ydGVkKSBhYy5hYm9ydCgpO1xuXG4gIGxldCBldmVudHMgPSAwO1xuICBsZXQgY3Vyc29yID0gdGFpbC5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCB1bmRlZmluZWQgPSB0YWlsLnNpbmNlRXBvY2g7XG4gIGxldCBmcmFtZUhhc0lkID0gZmFsc2U7XG4gIC8qKiBBMyArIEQzOiBhIGZyYW1lIGNvdW50cywgYW5kIHdha2VzIGEgYC0tb25jZWAsIG9ubHkgd2hlbiBpdCBpcyBPTiBUSEVcbiAgICogIExPRyDigJQgaXQgY2FycmllcyBhIGxvZyBpZCDigJQgYW5kIHRoZSBzcGVsbCdzIG93biBgY291bnRzYCBhZ3JlZXMuIEEgdGFiJ3NcbiAgICogIGlkLWxlc3MgYGNvbm5lY3RlZGAvYGRpc2Nvbm5lY3RlZGAgcGluZyBpcyBub3Qgb24gdGhlIGxvZy4gKi9cbiAgY29uc3QgaXNMb2dGcmFtZSA9IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gZnJhbWVIYXNJZCAmJiBjb3VudHMoZXYsIGZyYW1lKTtcbiAgbGV0IGVuZDogVGFpbEVuZCB8IG51bGwgPSBudWxsO1xuICBsZXQgY2xvc2VkQnk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlZnVzYWxzID0gMDtcblxuICBjb25zdCBmaW5pc2ggPSAoZTogVGFpbEVuZCkgPT4ge1xuICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IGU7XG4gICAgYWMuYWJvcnQoKTtcbiAgfTtcbiAgY29uc3QgdGltZXIgPVxuICAgIGgubW9kZSA9PT0gXCJ3YXRjaFwiICYmIHdpbmRvd01zID4gMCA/IHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKFwid2luZG93XCIpLCB3aW5kb3dNcykgOiBudWxsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY29kZSA9IGF3YWl0IHRhaWxFdmVudHM8RXY+KHtcbiAgICAgIC4uLnRhaWwsXG4gICAgICBzaWduYWw6IGFjLnNpZ25hbCxcbiAgICAgIC8vIEQyJ3MgbmV0LiBPbiBmb3IgZXZlcnkgc3BlbGw6IGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvclxuICAgICAgLy8gbWVhbnMgYSB3aG9sZSByZXBsYXkgb24gdGhlIGtpdCdzIGxvZywgYW5kIG9uIGdyYXBldmluZSdzIGR1cmFibGUgbG9nXG4gICAgICAvLyBpdCBoYXBwZW5zIG9ubHkgd2hlbiBgLS1sYXN0YCByZWFjaGVzIGJlbG93IGAtLXNpbmNlYCwgd2hlcmVcbiAgICAgIC8vIHJlLXJlYWRpbmcgdGhlIGN1cnNvciBmcm9tIHRoZSBmcmFtZXMgaXMgdGhlIG1vcmUgY29ycmVjdCBhbnN3ZXIuXG4gICAgICByZXN0YXJ0T25SZXBsYXk6IHRydWUsXG4gICAgICAvLyBEMzogcmVtZW1iZXIgd2hldGhlciBUSElTIGZyYW1lIGNhcnJpZXMgYSBsb2cgaWQuIGB0YWlsRXZlbnRzYCByZWFkc1xuICAgICAgLy8gdGhlIGN1cnNvciBvbmNlIHBlciBmcmFtZSwgYmVmb3JlIGBhY2NlcHRgLCBgdGVybWluYWxgIGFuZCBgcmVuZGVyYC5cbiAgICAgIGN1cnNvck9mOiAoZXYpID0+IHtcbiAgICAgICAgY29uc3QgbiA9IHRhaWwuY3Vyc29yT2Y/Lihldik7XG4gICAgICAgIGZyYW1lSGFzSWQgPSB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBOdW1iZXIuaXNGaW5pdGUobik7XG4gICAgICAgIHJldHVybiBuO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHMpID0+IHtcbiAgICAgICAgY29uc3QgdmVyZGljdCA9IHRhaWwub25VbnJlc29sdmVkPy4ocykgPz8gXCJyZXRyeVwiO1xuICAgICAgICAvLyBEMTogYSB0YWlsIHRoYXQgZ2l2ZXMgdXAgb24gZmluZGluZyBpdHMgc2Vzc2lvbiBpcyB3YXRjaGluZyBhXG4gICAgICAgIC8vIHNlc3Npb24gdGhhdCBpcyBnb25lIOKAlCB3aGV0aGVyIHRoaXMgcHJvY2VzcyBldmVyIHJlYWNoZWQgaXQgKGl0c1xuICAgICAgICAvLyBwb2ludGVyIHZhbmlzaGVkKSBvciBpdCB3YXMgcmUtYXJtZWQgYXQgb25lIHRoYXQgY2xvc2VkIGluIHRoZSBnYXAuXG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIiAmJiBlbmQgPT09IG51bGwpIHtcbiAgICAgICAgICBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICAgIGNsb3NlZEJ5ID0gaC5nb25lQnk/LigpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiB2ZXJkaWN0O1xuICAgICAgfSxcbiAgICAgIHJlbmRlcjogKGV2LCBmcmFtZSkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLnJlbmRlciA/IHRhaWwucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICBpZiAobGluZSAhPT0gbnVsbCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIGV2ZW50cyArPSAxO1xuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICB0ZXJtaW5hbDogKGV2LCBmcmFtZSwgYWNjZXB0ZWQpID0+IHtcbiAgICAgICAgaWYgKHRhaWwudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIHtcbiAgICAgICAgICAgIGVuZCA9IChoLmlzQ2xvc2VkID8/ICgoKSA9PiB0cnVlKSkoZXYpID8gXCJjbG9zZWRcIiA6IFwiZXZlbnRcIjtcbiAgICAgICAgICAgIGlmIChlbmQgPT09IFwiY2xvc2VkXCIpIGNsb3NlZEJ5ID0gaC5jbG9zZWRCeT8uKGV2KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKGgubW9kZSA9PT0gXCJvbmNlXCIgJiYgYWNjZXB0ZWQgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gXCJldmVudFwiO1xuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH0sXG4gICAgICBvbkNvbW1lbnQ6ICh0ZXh0KSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgcmV0dXJuIHRhaWwub25Db21tZW50Py4odGV4dCkgPz8gbnVsbDtcbiAgICAgIH0sXG4gICAgICBvbkRpc2Nvbm5lY3Q6IChpbmZvKSA9PiB7XG4gICAgICAgIGNvbnN0IGxpbmUgPSB0YWlsLm9uRGlzY29ubmVjdD8uKGluZm8pID8/IG51bGw7XG4gICAgICAgIGlmIChpbmZvLmNhdXNlID09PSBcImNvbm5lY3QtZmFpbGVkXCIpIHtcbiAgICAgICAgICByZWZ1c2FscyArPSAxO1xuICAgICAgICAgIGlmIChlbmRPbkxvc3QgJiYgcmVmdXNhbHMgPj0gTE9TVF9BRlRFUl9SRUZVU0FMUykgZmluaXNoKFwibG9zdFwiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBUaGUgZGFlbW9uIGFuc3dlcmVkIChhIHN0YXR1cywgb3IgYSBzdHJlYW0gdGhhdCBvcGVuZWQgYW5kIHRoZW5cbiAgICAgICAgICAvLyBlbmRlZCk6IGl0IGlzIGFsaXZlLCBzbyB0aGUgcmVmdXNhbHMgd2VyZSBub3QgaW4gYSByb3cuXG4gICAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIG9uRW5kOiAocykgPT4ge1xuICAgICAgICBjdXJzb3IgPSBzLmN1cnNvcjtcbiAgICAgICAgZXBvY2ggPSBzLmVwb2NoID8/IHVuZGVmaW5lZDtcbiAgICAgICAgdGFpbC5vbkVuZD8uKHMpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBjb25zdCBsaW5lID0gaGFuZG9mZihcbiAgICAgIHtcbiAgICAgICAgZW5kOiBlbmQgPz8gXCJzdG9wcGVkXCIsXG4gICAgICAgIC4uLihjbG9zZWRCeSA/IHsgYnk6IGNsb3NlZEJ5IH0gOiB7fSksXG4gICAgICAgIG1vZGU6IGgubW9kZSxcbiAgICAgICAgZXZlbnRzLFxuICAgICAgICBjdXJzb3IsXG4gICAgICAgIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSxcbiAgICAgICAgcHJlc2VuY2U6IGgucHJlc2VuY2UsXG4gICAgICAgIHNwZWxsOiBoLnNwZWxsLFxuICAgICAgfSxcbiAgICAgIGguY29tbWFuZHMsXG4gICAgKTtcbiAgICBpZiAobGluZSAhPT0gbnVsbCkgb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGxpbmUpfVxcbmApO1xuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh0aW1lciAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0YWlsLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhlYXJ0YmVhdCAvIGlkbGUtdGltZW91dCAvIHRhaWwtd2F0Y2hkb2cgdHJpcGxlIOKAlCB0aHJlZSBudW1iZXJzIHRoYXQgYXJlXG4gKiBPTkUgaW52YXJpYW50LCB3cml0dGVuIG9uY2UuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYC5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgTU9EVUxFIEVYSVNUUyBBVCBBTEwg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIHRocmVlIG51bWJlcnMgYXJlIGNoYWluZWQsIGFuZCB0aGUgY2hhaW4gaXMgd2hhdCBub2JvZHkgY291bGQgc2VlOlxuICpcbiAqICAgICBzZXJ2ZXIgaWRsZVRpbWVvdXQgID4gIFNTRSBoZWFydGJlYXQgIMK3ICB0YWlsIHdhdGNoZG9nICA+ICBTU0UgaGVhcnRiZWF0XG4gKlxuICogLSAqKmBpZGxlVGltZW91dGAgPiBoZWFydGJlYXQqKiwgb3IgQnVuIGNsb3NlcyBhIGhlbGQgU1NFIGNvbm5lY3Rpb24gYmVmb3JlXG4gKiAgIHRoZSBrZWVwYWxpdmUgdGhhdCB3YXMgc3VwcG9zZWQgdG8gcHJlc2VydmUgaXQgZXZlciBmaXJlcy4gTUVBU1VSRUQ6IEJ1bidzXG4gKiAgIGRlZmF1bHQgcmVxdWVzdCBgaWRsZVRpbWVvdXRgIGlzIDEwIHMgYW5kIGEgU0VSVkVSLVNFTlQgaGVhcnRiZWF0IGRvZXMgbm90XG4gKiAgIHJlc2V0IGl0LCBzbyBhIDE1IHMgYDogaGJgIGFycml2ZXMgZml2ZSBzZWNvbmRzIGFmdGVyIHRoZSB0aGluZyBpdCB3YXNcbiAqICAga2VlcGluZyBhbGl2ZSBpcyBnb25lIOKAlCB3aGljaCBpcyB3aHkgcmFpc2luZyB0aGUgaGVhcnRiZWF0IFJBVEUgd291bGQgbm90XG4gKiAgIGhhdmUgaGVscGVkLiBGb3VyIHNwZWxscyBoYWQgaGl0IHRoaXMgYW5kIHJlcGFpcmVkIGl0LCB0aHJlZSBoYWQgbm90LlxuICogLSAqKndhdGNoZG9nID4gaGVhcnRiZWF0KiosIG9yIGEgaGVhbHRoeS1idXQtcXVpZXQgdGFpbCBhYm9ydHMgYW5kIHJlY29ubmVjdHNcbiAqICAgZm9yZXZlci4gTUVBU1VSRUQgb24gYXN0cm9sYWJlOiB3aXRoIGEgaGFyZC1jb2RlZCA0NSBzIHdhdGNoZG9nIGFuZCBhblxuICogICBlbnYtdHVuZWQgaGVhcnRiZWF0LCByZWNvbm5lY3RzIGxhbmRlZCBhdCArNDcuNCBzLCArOTIuNiBzIGFuZCArMTM3Ljkgc1xuICogICBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLiBJdCB3YXMgaGFybWxlc3Mgb25seSBiZWNhdXNlIGEgVEhJUkRcbiAqICAgY29uc3RhbnQg4oCUIGEgcHJlc2VuY2UgZGVib3VuY2Ugd2l0aCBubyByZWxhdGlvbnNoaXAgdG8gZWl0aGVyIOKAlCBoYXBwZW5lZCB0b1xuICogICBhYnNvcmIgdGhlIGNodXJuLlxuICpcbiAqIOKblCAqKkFORCBUSEUgU0VBTSBJUyBUSEUgUE9JTlQuKiogVW50aWwgUGhhc2UgMWIgdGhlIHdhdGNoZG9nIGxpdmVkIGluIGVhY2hcbiAqIHNwZWxsJ3MgQ0xJIGFuZCB0aGUgaGVhcnRiZWF0IGluIGVhY2ggc3BlbGwncyBkYWVtb24sIGFuZCBCT1RIIGZpbGVzIGNhcnJpZWQgYVxuICogY29tbWVudCBzYXlpbmcgdGhlIGV4cHJlc3Npb25zIHdlcmUgaGFuZC1taXJyb3JlZCBhY3Jvc3MgYSBib3VuZGFyeSB0aGUgQ0xJXG4gKiBjb3VsZCBub3QgY3Jvc3Mg4oCUIGltcG9ydGluZyB0aGUgZGFlbW9uIHdvdWxkIGhhdmUgZHJhZ2dlZCB0aGUgd2hvbGUgc2VydmVyXG4gKiBncmFwaCBpbnRvIGBkaXN0L2NsaS5qc2AuIFRoaXMgbW9kdWxlIGlzIHRoZSBjcm9zc2luZzogaXQgaG9sZHMgbm8gc3BlbGwnc1xuICogbnVtYmVycywgb25seSB0aGUgZGVyaXZhdGlvbnMsIGFuZCBlYWNoIHNwZWxsJ3Mgb3duIHRpbnkgYGhlYXJ0YmVhdC50c2BcbiAqIGJlc2lkZSBpdHMgZGFlbW9uIGhvbGRzIHRoZSB2YWx1ZXMgdGhhdCBCT1RIIGhhbHZlcyB0aGVuIGltcG9ydC4gQSB2YWx1ZSB0aGF0XG4gKiBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdC5cbiAqL1xuXG4vKiogQnVuJ3MgbWF4aW11bSBgaWRsZVRpbWVvdXRgLCBpbiBzZWNvbmRzLiBgMGAgaXMgbm90IFwiZGlzYWJsZWRcIiDigJQgaXQgaXMgdGhlXG4gKiAgZGVmYXVsdCDigJQgc28gdGhlIHdheSB0byBob2xkIGEgY29ubmVjdGlvbiBvcGVuIGlzIHRvIGFzayBmb3IgdGhlIG1heGltdW0uICovXG5leHBvcnQgY29uc3QgTUFYX0lETEVfVElNRU9VVF9TRUMgPSAyNTU7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdCBoZWFydGJlYXQsIGluIG1zLiBTaXggb2YgdGhlIGVpZ2h0IGRhZW1vbnMgd3JpdGUgMTUgcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0hFQVJUQkVBVF9NUyA9IDE1XzAwMDtcblxuLyoqIEhvdyBtYW55IG1pc3NlZCBiZWF0cyB0aGUgdGFpbCB3YXRjaGRvZyB0b2xlcmF0ZXMgYmVmb3JlIGl0IGFib3J0cyBhbmRcbiAqICByZWNvbm5lY3RzLiBUaHJlZSwgZXZlcnl3aGVyZSwgYW5kIGl0IGlzIGEgZmxvb3Igbm90IGEgdGFzdGU6IGhvbGRpbmcgdGhlXG4gKiAgY29ubmVjdGlvbiBvcGVuIElTIGEgYGpvaW5gJ3MgcHJlc2VuY2Ugc2lnbmFsLCBzbyBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGFcbiAqICBjYXJkIGluIGEgaHVtYW4ncyB2aWV3LiBJdCBzdGlsbCB3YW50cyBhIHdhdGNoZG9nIOKAlCBhIHdlZGdlZCBoYWxmLW9wZW4gc29ja2V0XG4gKiAgc2hvd3MgYSBjYXJkIGFzIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHRoZSB3b3JzZSBsaWUuICovXG5leHBvcnQgY29uc3QgTUlTU0VEX0JFQVRTID0gMztcblxuLyoqXG4gKiBUaGUgc21hbGxlc3QgYmVhdCB0aGlzIG1vZHVsZSB3aWxsIGhhbmQgYmFjaywgaW4gbXMg4oCUIHRoZSBGTE9PUiBoYWxmIG9mIHRoZVxuICogY2xhbXAgd2hvc2UgY2VpbGluZyBpcyBgaWRsZVRpbWVvdXQgLyAyYC5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgYGludE9yYCBQQVJTRVMgV0lUSCBgcGFyc2VJbnRgLCBBTkQgYHBhcnNlSW50YCBJUyBMRU5JRU5UXG4gKiBXSEVSRSBJVCBNQVRURVJTIE1PU1QuIGBpbnRPcmAgZmFsbHMgYmFjayBzYWZlbHkgb24gZXZlcnl0aGluZyB0aGF0IExPT0tTXG4gKiBob3N0aWxlIOKAlCBgXCJcImAsIGBcIjBcImAsIGBcIi0xXCJgLCBgXCJhYmNcImAsIGBcIk5hTlwiYCwgYFwiSW5maW5pdHlcImAgYWxsIHRha2UgdGhlXG4gKiBmYWxsYmFjayDigJQgYW5kIHRoZW4gcmVhZHMgYFwiMWU5XCJgLCB0aGUgbW9zdCBwbGF1c2libGUgc3BlbGxpbmcgb2YgXCJtYWtlIGl0XG4gKiBodWdlXCIsIGFzICoqMSoqLiBNRUFTVVJFRCBhdCBncmFwZXZpbmUncyBQaGFzZSA2IHJlcGFpciwgYmVmb3JlIHRoaXMgZmxvb3I6XG4gKiBgR1JBUEVWSU5FX0hFQVJUQkVBVF9NUz0xZTlgIHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvIGV2ZXJ5IG9wZW4gU1NFXG4gKiBjbGllbnQgaW4gNTI4IG1zLiBgXCIzLjlcImAgZ2l2ZXMgMyBtcyBhbmQgYFwiNWFiY1wiYCBnaXZlcyA1IG1zIHRoZSBzYW1lIHdheS5cbiAqIEEga25vYiB3aG9zZSBmYXN0ZXN0IHNldHRpbmcgaXMgc3BlbGxlZCBsaWtlIGl0cyBzbG93ZXN0IGlzIGEgZmxvb2QuXG4gKlxuICog4pqgICoqVEhFIEZMT09SIElTIEhFUkUgQU5EIE5PVCBJTiBgaW50T3JgIOKAlCB0aGF0IGlzIHRoZSBydWxpbmcsIG5vdCBhblxuICogYWNjaWRlbnQgb2Ygd2hlcmUgaXQgd2FzIGVhc3kgdG8gd3JpdGUqKiAoRDc2KS4gYGludE9yYCBpcyB0aGUgZ2VuZXJhbCBwYXJzZXJcbiAqIGJlaGluZCBldmVyeSBlbnYga25vYiBpbiB0aGUga2l0OyB0aGVyZSBpcyBubyBzaW5nbGUgcm9zdGVyLWNvcnJlY3QgbWluaW11bVxuICogZm9yIFwiYSBwb3NpdGl2ZSBpbnRlZ2VyXCIsIGFuZCB0aWdodGVuaW5nIGl0cyBQQVJTRSAocmVqZWN0aW5nIGAxZTlgIG91dHJpZ2h0KVxuICogd291bGQgY2hhbmdlIHdoYXQgZXZlcnkgb3RoZXIga25vYiBhY2NlcHRzLCBzaWxlbnRseSwgZm9yIHZhbHVlcyBub2JvZHkgaGFzXG4gKiBhdWRpdGVkLiBgaGVhcnRiZWF0TXNgIGFscmVhZHkgb3ducyBvbmUgZW5kIG9mIHRoaXMgaW52YXJpYW50LCBhbmQgNTAwIHdhc1xuICogYWxyZWFkeSB3cml0dGVuIGludG8gaXQgYXMgdGhlIHNtYWxsZXN0IGNlaWxpbmcgaXQgd291bGQgY29tcHV0ZS4gVGhlIGZsb29yXG4gKiBiZWxvbmdzIGJlc2lkZSB0aGUgY2VpbGluZywgd2hlcmUgdGhlIHF1YW50aXR5IGlzIGtub3duLlxuICovXG5leHBvcnQgY29uc3QgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMDtcblxuLyoqIFBhcnNlIGEgcG9zaXRpdmUgaW50ZWdlciBmcm9tIGFuIGVudiB2YWx1ZSwgZmFsbGluZyBiYWNrIG9uIGFueXRoaW5nIHRoYXQgaXNcbiAqICBhYnNlbnQsIGVtcHR5LCBub24tbnVtZXJpYyBvciBub24tcG9zaXRpdmUuIOKaoCBgcGFyc2VJbnRgIHNlbWFudGljczogYFwiMWU5XCJgXG4gKiAgaXMgMSBhbmQgYFwiNWFiY1wiYCBpcyA1LiBBbnkgY2FsbGVyIHdpdGggYSBrbm93biBzYWZlIG1pbmltdW0gbXVzdCBjbGFtcCDigJRcbiAqICBzZWUgYE1JTl9IRUFSVEJFQVRfTVNgLiAqL1xuZnVuY3Rpb24gaW50T3IocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCBuID0gTnVtYmVyLnBhcnNlSW50KHJhdyA/PyBcIlwiLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgJiYgbiA+IDAgPyBuIDogZmFsbGJhY2s7XG59XG5cbi8qKiBUaGUgc2VydmVyJ3MgYGlkbGVUaW1lb3V0YCwgaW4gU0VDT05EUywgY2xhbXBlZCB0byB3aGF0IEJ1biBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlkbGVUaW1lb3V0U2VjKHJhdz86IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2sgPSBNQVhfSURMRV9USU1FT1VUX1NFQyk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLm1pbihNQVhfSURMRV9USU1FT1VUX1NFQywgaW50T3IocmF3LCBmYWxsYmFjaykpKTtcbn1cblxuLyoqXG4gKiBUaGUgU1NFIGhlYXJ0YmVhdCwgaW4gbXMsIENMQU1QRUQgQVQgQk9USCBFTkRTOiBuZXZlciBhYm92ZSBoYWxmIHRoZSBpZGxlXG4gKiB0aW1lb3V0LCBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AuXG4gKlxuICogVGhlIGNlaWxpbmcgaXMgYXN0cm9sYWJlJ3MsIGFuZCB0aGUgY2Vuc3VzIG5hbWVkIGl0IGNvbnZlcmdlbmNlIHRhcmdldCAjNDpcbiAqIHRoZSBvdGhlciBkYWVtb25zIGhhcmQtY29kZSAxNSBzIGFnYWluc3QgMjU1IHMgYW5kIHdyaXRlIHRoZSByZWxhdGlvbnNoaXBcbiAqIG9ubHkgaW4gcHJvc2UsIHdoaWNoIGhvbGRzIGF0IHRoZSBkZWZhdWx0IGFuZCBhdCBubyBvdGhlciB2YWx1ZS4gRW5mb3JjaW5nXG4gKiBgaGVhcnRiZWF0IDw9IGlkbGVUaW1lb3V0IC8gMmAgbWFrZXMgdGhlIGludmFyaWFudCB0cnVlIGZvciBBTlkgY29uZmlndXJlZFxuICogcGFpciwgd2hpY2ggaXMgZXhhY3RseSB0aGUgaW52YXJpYW50IHdob3NlIHZpb2xhdGlvbiBjYXVzZWQgdGhlIGJ1ZyBhYm92ZS5cbiAqXG4gKiDimqAgVGhlIGZsb29yIGNhbm5vdCBmaWdodCB0aGUgY2VpbGluZzogdGhlIGNlaWxpbmcgZXhwcmVzc2lvbiBpcyBpdHNlbGZcbiAqIGBNYXRoLm1heCg1MDAsIOKApilgLCBzbyBpdCBpcyBuZXZlciBiZWxvdyBgTUlOX0hFQVJUQkVBVF9NU2AgYW5kIHRoZSB0d29cbiAqIGNsYW1wcyBjYW4gbmV2ZXIgY3Jvc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoZWFydGJlYXRNcyhcbiAgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGlkbGVTZWM6IG51bWJlcixcbiAgZmFsbGJhY2sgPSBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbik6IG51bWJlciB7XG4gIGNvbnN0IGNlaWxpbmcgPSBNYXRoLm1heChNSU5fSEVBUlRCRUFUX01TLCBNYXRoLmZsb29yKChpZGxlU2VjICogMTAwMCkgLyAyKSk7XG4gIHJldHVybiBNYXRoLm1pbihNYXRoLm1heChpbnRPcihyYXcsIGZhbGxiYWNrKSwgTUlOX0hFQVJUQkVBVF9NUyksIGNlaWxpbmcpO1xufVxuXG4vKiogVGhlIHRhaWwtc2lkZSB3YXRjaGRvZyBmb3IgYSBnaXZlbiBoZWFydGJlYXQ6IHRocmVlIG1pc3NlZCBiZWF0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0YWlsSWRsZU1zKGJlYXRNczogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIGJlYXRNcyAqIE1JU1NFRF9CRUFUUztcbn1cbiIsCiAgICAiLyoqXG4gKiBzY3JpcHRvcml1bSdzIGNvbm5lY3Rpb24tdGltaW5nIGNvbnN0YW50cyDigJQgVEhFIE9ORSBDT1BZLCBpbXBvcnRlZCBieSBib3RoXG4gKiBoYWx2ZXMgKGBjbGkudHNgJ3MgdGFpbCB3YXRjaGRvZywgYHNlcnZlci50c2AncyBTU0UgaGVhcnRiZWF0IGFuZCBpZGxlXG4gKiB0aW1lb3V0KS4gS2l0IHZlcmRpY3QgYGhlYXJ0YmVhdGA6IFNVQkpFQ1Qg4oCUIHRoZSBzZWFtIGV4aXN0cyBiZWNhdXNlIHRoZSBDTElcbiAqIGFuZCB0aGUgZGFlbW9uIGFyZSB0d28gcHJvY2Vzc2VzIHRoYXQgbXVzdCBhZ3JlZSBvbiBvbmUgaW52YXJpYW50XG4gKiAoYGlkbGVUaW1lb3V0ID4gaGVhcnRiZWF0YCwgYHdhdGNoZG9nID4gaGVhcnRiZWF0YCksIGFuZCBuZWl0aGVyIG1heSBpbXBvcnRcbiAqIHRoZSBvdGhlci5cbiAqXG4gKiDimqAgS0VFUCBJVCBBIExFQUYtU0hBUEVEIEZJTEUuIFRoZSBtb21lbnQgdGhpcyBpbXBvcnRzIGFueXRoaW5nIG9mIHRoZVxuICogZGFlbW9uJ3MsIGBkaXN0L2NsaS5qc2AgZHJhZ3MgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBNQVhfSURMRV9USU1FT1VUX1NFQyxcbiAgdGFpbElkbGVNcyxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2hlYXJ0YmVhdC50c1wiO1xuXG4vKiogQnVuJ3MgbWF4aW11bTogYSBoZWxkIFNTRSB0YWlsIG11c3Qgb3V0bGl2ZSBCdW4ncyAxMCBzIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgSURMRV9USU1FT1VUX1NFQyA9IE1BWF9JRExFX1RJTUVPVVRfU0VDO1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQuICovXG5leHBvcnQgY29uc3QgU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKiogVGhlIHRhaWwgd2F0Y2hkb2c6IHRocmVlIG1pc3NlZCBiZWF0cyBvZiBUSElTIGRhZW1vbidzIGhlYXJ0YmVhdCwgZGVyaXZlZC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX0lETEVfTVMgPSB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpO1xuIiwKICAgICIvKipcbiAqIENvbnRleHQgZW50cmllcyBvbiBkaXNrIOKAlCBidWlsZGluZyBhbiBlbnRyeSBmcm9tIGEgcGF0aCAoRTE1J3Mgb25lIG1vZGVsKSxcbiAqIG1pcnJvcmluZyBhIGZvbGRlciBpbnRvIGEgbm9kZSB0cmVlLCBhbmQgbGlzdGluZyBhIGRpcmVjdG9yeSBmb3IgdGhlXG4gKiBzdXJmYWNlJ3MgcGF0aCBjb21wbGV0aW9uIChgZnMubGlzdGApLlxuICpcbiAqIFB1cmUgb3ZlciB0aGUgZmlsZXN5c3RlbTogbm8gZGFlbW9uIHN0YXRlLCBzbyB0aGUgdW5pdCBjZWxscyBkcml2ZSBpdCB3aXRoIGFcbiAqIHRlbXAgZGlyZWN0b3J5IGFuZCBub3RoaW5nIGVsc2UuXG4gKi9cblxuaW1wb3J0IHsgcmVhZGRpclN5bmMsIHN0YXRTeW5jIH0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGJhc2VuYW1lLCBkaXJuYW1lLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBDb250ZXh0RW50cnksIENvbnRleHROb2RlLCBGc0xpc3RFbnRyeSB9IGZyb20gXCIuL3Byb3RvY29sXCI7XG5cbi8qKiBXaGF0IHNjcmlwdG9yaXVtIG9wZW5zIGFzIGEgZG9jdW1lbnQuIEV2ZXJ5dGhpbmcgZWxzZSBpcyBub3Qgc2hvd24uICovXG5leHBvcnQgY29uc3QgRE9DX0VYVEVOU0lPTlMgPSBbXCIubWRcIiwgXCIubWFya2Rvd25cIiwgXCIubWR4XCIsIFwiLnR4dFwiXSBhcyBjb25zdDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzRG9jTmFtZShuYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgbG93ZXIgPSBuYW1lLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBET0NfRVhURU5TSU9OUy5zb21lKChleHQpID0+IGxvd2VyLmVuZHNXaXRoKGV4dCkpO1xufVxuXG4vKiogRGlyZWN0b3JpZXMgYSBtaXJyb3IgbmV2ZXIgZGVzY2VuZHMgaW50byDigJQgbm9pc2UsIG5vdCBkb2N1bWVudHMuICovXG5jb25zdCBTS0lQX0RJUlMgPSBuZXcgU2V0KFtcIm5vZGVfbW9kdWxlc1wiLCBcIi5naXRcIiwgXCJkaXN0XCIsIFwib3V0XCIsIFwiY292ZXJhZ2VcIl0pO1xuXG4vKipcbiAqIFRoZSBtb3N0IG5vZGVzIG9uZSBtaXJyb3JlZCBzY2FuIHdpbGwgaG9sZC4gQSBmb2xkZXIgZW50cnkgcG9pbnRlZCBhdCBhIGh1Z2VcbiAqIHRyZWUgbXVzdCBub3Qgc3RhbGwgdGhlIGRhZW1vbiBvciBmbG9vZCBldmVyeSBzdGF0ZSBicm9hZGNhc3Q7IGhpdHRpbmcgdGhlXG4gKiBjYXAgc2V0cyBgdHJ1bmNhdGVkYCBvbiB0aGUgZW50cnkgc28gdGhlIHN1cmZhY2UgY2FuIFNBWSB0aGUgbGlzdCBpcyBzaG9ydFxuICogcmF0aGVyIHRoYW4gcmVuZGVyIGEgc2hvcnQgbGlzdCBhcyBhIGNvbXBsZXRlIG9uZS5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JUlJPUl9OT0RFX0NBUCA9IDIwMDA7XG5cbmV4cG9ydCBjb25zdCB0b1Bvc2l4ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdChzZXApLmpvaW4oXCIvXCIpO1xuXG4vKipcbiAqIE1pcnJvciBgcm9vdGAgaW50byBhIHNvcnRlZCBub2RlIHRyZWU6IGdyb3VwcyBmaXJzdCwgdGhlbiBkb2NzLCBieSBuYW1lLlxuICogYGhpZGRlbmAgcmVscyAoRTI0J3MgXCJSZW1vdmUgZnJvbSBTY3JpcHRvcml1bVwiKSBhcmUgc2tpcHBlZCwgYSBmb2xkZXIgd2l0aFxuICogZXZlcnl0aGluZyB1bmRlciBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjYW5UcmVlKFxuICByb290OiBzdHJpbmcsXG4gIGNhcCA9IE1JUlJPUl9OT0RFX0NBUCxcbiAgaGlkZGVuOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogeyBub2RlczogQ29udGV4dE5vZGVbXTsgdHJ1bmNhdGVkOiBib29sZWFuIH0ge1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgdHJ1bmNhdGVkID0gZmFsc2U7XG4gIGNvbnN0IHNraXAgPSBuZXcgU2V0KGhpZGRlbik7XG4gIGNvbnN0IHdhbGsgPSAoZGlyOiBzdHJpbmcpOiBDb250ZXh0Tm9kZVtdID0+IHtcbiAgICBsZXQgbmFtZXM6IHN0cmluZ1tdO1xuICAgIHRyeSB7XG4gICAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4gW107XG4gICAgfVxuICAgIGNvbnN0IGdyb3VwczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGNvbnN0IGRvY3M6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMuc29ydCgoYSwgYikgPT4gYS5sb2NhbGVDb21wYXJlKGIpKSkge1xuICAgICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGNvdW50ID49IGNhcCkge1xuICAgICAgICB0cnVuY2F0ZWQgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgY29uc3QgcmVsID0gdG9Qb3NpeChyZWxhdGl2ZShyb290LCBhYnMpKTtcbiAgICAgIGlmIChza2lwLmhhcyhyZWwpKSBjb250aW51ZTtcbiAgICAgIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgICAgIGlmIChTS0lQX0RJUlMuaGFzKG5hbWUpKSBjb250aW51ZTtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgY29uc3QgY2hpbGRyZW4gPSB3YWxrKGFicyk7XG4gICAgICAgIC8vIEEgZm9sZGVyIGhvbGRpbmcgb25seSBub24tZG9jdW1lbnRzIChpbWFnZXMsIGFzc2V0cykgaXMgbm9pc2UgaW4gYVxuICAgICAgICAvLyBkb2NzIG1pcnJvciBhbmQgaXMgbGVmdCBvdXQuIEEgVFJVTFkgRU1QVFkgZm9sZGVyIGlzIGtlcHQ6IGl0IGlzIG9uZVxuICAgICAgICAvLyBzb21lYm9keSBqdXN0IG1hZGUgdG8gcHV0IGRvY3VtZW50cyBpbiAoXCJOZXcgZm9sZGVyXCIsIEUyNCksIGFuZFxuICAgICAgICAvLyBsZWF2aW5nIGl0IG91dCBtYWRlIGl0IHZhbmlzaCB0aGUgbW9tZW50IGl0IHdhcyBjcmVhdGVkLlxuICAgICAgICBpZiAoY2hpbGRyZW4ubGVuZ3RoID4gMCB8fCBpc0VtcHR5RGlyKGFicykpIGdyb3Vwcy5wdXNoKHsga2luZDogXCJncm91cFwiLCByZWwsIGNoaWxkcmVuIH0pO1xuICAgICAgfSBlbHNlIGlmIChzdC5pc0ZpbGUoKSAmJiBpc0RvY05hbWUobmFtZSkpIHtcbiAgICAgICAgY291bnQrKztcbiAgICAgICAgZG9jcy5wdXNoKHsga2luZDogXCJkb2NcIiwgcmVsIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gWy4uLmdyb3VwcywgLi4uZG9jc107XG4gIH07XG4gIGNvbnN0IG5vZGVzID0gd2Fsayhyb290KTtcbiAgcmV0dXJuIHsgbm9kZXMsIHRydW5jYXRlZCB9O1xufVxuXG4vKiogTm90aGluZyBpbiBpdCBidXQgZG90ZmlsZXMgKGEgYC5EU19TdG9yZWAgZG9lcyBub3QgbWFrZSBhIGZvbGRlciBmdWxsKS4gKi9cbmZ1bmN0aW9uIGlzRW1wdHlEaXIoZGlyOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyKS5ldmVyeSgobikgPT4gbi5zdGFydHNXaXRoKFwiLlwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIG5vZGUgYXQgYHJlbGAgaW4gYSB0cmVlLCBvciB1bmRlZmluZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZmluZE5vZGUobm9kZXM6IHJlYWRvbmx5IENvbnRleHROb2RlW10sIHJlbDogc3RyaW5nKTogQ29udGV4dE5vZGUgfCB1bmRlZmluZWQge1xuICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICBpZiAobi5yZWwgPT09IHJlbCkgcmV0dXJuIG47XG4gICAgaWYgKG4ua2luZCA9PT0gXCJncm91cFwiICYmIHJlbC5zdGFydHNXaXRoKGAke24ucmVsfS9gKSkgcmV0dXJuIGZpbmROb2RlKG4uY2hpbGRyZW4sIHJlbCk7XG4gIH1cbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGNsYXNzIFBhdGhFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIHJlYWRvbmx5IGNvZGU6IFwibWlzc2luZ1wiIHwgXCJub3QtYS1kb2NcIixcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBBbiBlbnRyeSBmb3IgYW4gYWJzb2x1dGUgcGF0aC4gQSBkaXJlY3RvcnkgaXMgYG1pcnJvcmVkYDsgYSBkb2N1bWVudCBmaWxlIGlzXG4gKiBgbGlzdGVkYCwgcm9vdGVkIGF0IGl0cyBwYXJlbnQsIGhvbGRpbmcgb25seSBpdHNlbGYgKEUxNSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbnRyeUZvclBhdGgoYWJzOiBzdHJpbmcsIGlkOiBzdHJpbmcpOiBDb250ZXh0RW50cnkge1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7YWJzfWAsIFwibWlzc2luZ1wiKTtcbiAgfVxuICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgIGNvbnN0IHsgbm9kZXMsIHRydW5jYXRlZCB9ID0gc2NhblRyZWUoYWJzKTtcbiAgICByZXR1cm4ge1xuICAgICAgaWQsXG4gICAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSB8fCBhYnMsXG4gICAgICByb290OiBhYnMsXG4gICAgICBtZW1iZXJzaGlwOiBcIm1pcnJvcmVkXCIsXG4gICAgICBub2RlcyxcbiAgICAgIC4uLih0cnVuY2F0ZWQgPyB7IHRydW5jYXRlZCB9IDoge30pLFxuICAgIH07XG4gIH1cbiAgaWYgKCFpc0RvY05hbWUoYWJzKSkge1xuICAgIHRocm93IG5ldyBQYXRoRXJyb3IoXG4gICAgICBgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnMgKCR7RE9DX0VYVEVOU0lPTlMuam9pbihcIiBcIil9KTogJHthYnN9YCxcbiAgICAgIFwibm90LWEtZG9jXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpLFxuICAgIHJvb3Q6IGRpcm5hbWUoYWJzKSxcbiAgICBtZW1iZXJzaGlwOiBcImxpc3RlZFwiLFxuICAgIG5vZGVzOiBbeyBraW5kOiBcImRvY1wiLCByZWw6IGJhc2VuYW1lKGFicykgfV0sXG4gIH07XG59XG5cbi8qKiBFdmVyeSBkb2Mgbm9kZSdzIGFic29sdXRlIHBhdGgsIGRlcHRoLWZpcnN0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY1BhdGhzKGVudHJ5OiBDb250ZXh0RW50cnkpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG91dDogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgd2FsayA9IChub2RlczogQ29udGV4dE5vZGVbXSkgPT4ge1xuICAgIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgICAgaWYgKG4ua2luZCA9PT0gXCJkb2NcIikgb3V0LnB1c2goam9pbihlbnRyeS5yb290LCBuLnJlbCkpO1xuICAgICAgZWxzZSB3YWxrKG4uY2hpbGRyZW4pO1xuICAgIH1cbiAgfTtcbiAgd2FsayhlbnRyeS5ub2Rlcyk7XG4gIHJldHVybiBvdXQ7XG59XG5cbi8qKiBXaGljaCBlbnRyeSAoaWYgYW55KSBob2xkcyBgYWJzYCwgYW5kIGF0IHdoYXQgYHJlbGAuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYXRlKFxuICBlbnRyaWVzOiBDb250ZXh0RW50cnlbXSxcbiAgYWJzOiBzdHJpbmcsXG4pOiB7IGVudHJ5SWQ6IHN0cmluZzsgcmVsOiBzdHJpbmcgfSB8IG51bGwge1xuICBmb3IgKGNvbnN0IGUgb2YgZW50cmllcykge1xuICAgIGlmIChkb2NQYXRocyhlKS5pbmNsdWRlcyhhYnMpKSByZXR1cm4geyBlbnRyeUlkOiBlLmlkLCByZWw6IHRvUG9zaXgocmVsYXRpdmUoZS5yb290LCBhYnMpKSB9O1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKipcbiAqIE9uZSBkaXJlY3RvcnksIGZvciB0aGUgc3VyZmFjZSdzIGFkZC1ieS1wYXRoIGNvbXBsZXRpb246IHN1YmRpcmVjdG9yaWVzIGFuZFxuICogZG9jdW1lbnRzIG9ubHksIGRpcmVjdG9yaWVzIGZpcnN0LiBgfmAgaXMgZXhwYW5kZWQgYnkgdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxpc3REaXIoZGlyOiBzdHJpbmcpOiBGc0xpc3RFbnRyeVtdIHtcbiAgY29uc3QgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICBjb25zdCBvdXQ6IEZzTGlzdEVudHJ5W10gPSBbXTtcbiAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzKSB7XG4gICAgaWYgKG5hbWUuc3RhcnRzV2l0aChcIi5cIikpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGFicyA9IGpvaW4oZGlyLCBuYW1lKTtcbiAgICBsZXQgaXNEaXIgPSBmYWxzZTtcbiAgICB0cnkge1xuICAgICAgaXNEaXIgPSBzdGF0U3luYyhhYnMpLmlzRGlyZWN0b3J5KCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGlzRGlyIHx8IGlzRG9jTmFtZShuYW1lKSkgb3V0LnB1c2goeyBuYW1lLCBwYXRoOiBhYnMsIGRpcjogaXNEaXIgfSk7XG4gIH1cbiAgcmV0dXJuIG91dC5zb3J0KChhLCBiKSA9PiAoYS5kaXIgPT09IGIuZGlyID8gYS5uYW1lLmxvY2FsZUNvbXBhcmUoYi5uYW1lKSA6IGEuZGlyID8gLTEgOiAxKSk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOztBQWdEQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFXQTtBQUNBOzs7QUNXQTs7O0FDakRPLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0Ms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QU0sUUFBUSxDQUFDO0FBQUE7QUFBQSxFQUV6QztBQUNGO0FBSU8sSUFBTSxNQUFNLFVBQVU7QUFBQSxFQUMzQixNQUFNO0FBQUEsRUFDTixTQUFTO0FBQUEsRUFDVCxTQUFTO0FBQUEsRUFDVCxVQUFVLEtBQUssSUFBSSxDQUFDLE9BQU8sS0FBSyxHQUFHLEtBQUssR0FBRyxFQUFFLEdBQUcsR0FBRyxZQUFZLFVBQVUsRUFBRTtBQUFBLEVBRzNFLFNBQVM7QUFBQSxFQUNULGdCQUFnQjtBQUFBLEVBQ2hCLFlBQVksQ0FBQyxTQUFTO0FBQUEsRUFDdEIsU0FBUztBQUFBLEVBQ1QsWUFBWTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLElBT1Y7QUFDSixDQUFDO0FBRU0sSUFBTSxRQUEyQixJQUFJO0FBQ3JDLElBQU0sWUFBK0MsT0FBTyxZQUNqRSxJQUFJLEtBQUssSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLE1BQU0sRUFBRSxRQUFRLENBQUMsQ0FDMUM7QUFDTyxJQUFNLFdBQVcsQ0FBQyxTQUEyQixJQUFJLFNBQVMsSUFBSTtBQUM5RCxJQUFNLG1CQUFzQyxJQUFJO0FBS3ZELGVBQWUsSUFBSSxDQUFDLE1BQWlDO0FBQUEsRUFDbkQsSUFBSTtBQUFBLElBQ0YsT0FBTyxNQUFNLElBQUksU0FBUyxJQUFJO0FBQUEsSUFDOUIsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLFdBQVcsZUFBZSxDQUFDO0FBQUEsSUFDakMsSUFBSSxhQUFhO0FBQUEsTUFBTSxPQUFPO0FBQUEsSUFDOUIsTUFBTSxPQUNKLEtBQUssT0FBTyxNQUFNLFlBQVksVUFBVSxJQUFJLE9BQVEsRUFBd0IsSUFBSSxJQUFJO0FBQUEsSUFDdEYsTUFBTSxNQUFNLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsSUFDckQsSUFBSSxTQUFTO0FBQUEsTUFBVSxPQUFPLGVBQWUsSUFBSSxXQUFXLEdBQUcsQ0FBQyxLQUFLO0FBQUEsSUFDckUsT0FBTyxlQUFlLElBQUksU0FBUyxZQUFZLEdBQUcsQ0FBQyxLQUFLO0FBQUE7QUFBQTtBQVM1RCxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICIwMTg3NjhENjJEMDZFRkMxNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
