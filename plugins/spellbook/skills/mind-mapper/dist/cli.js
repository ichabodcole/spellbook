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

//# debugId=1912DD18CFCF0E2D64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9taW5kLW1hcHBlci9iYWNrZW5kL2hlYXJ0YmVhdC50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gbWluZC1tYXBwZXIg4oCUIHRoZSBmdWxsIHZlcmIgc2V0IChWMSArIFYxLnggKyBSb3VuZCAzKTpcbi8vICAgb3BlbiAgICAgICAgICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybCwgb3BlbiB0aGUgYnJvd3NlclxuLy8gICAgICAgICAgICAgICAgIC0tcHJvamVjdCA8aWQ+IHNjb3BlcyB0aGUgdXJsICg/cHJvamVjdD0pOyBvcGVuIG5ldmVyIG1pbnRzIOKAlFxuLy8gICAgICAgICAgICAgICAgIGFuIHVua25vd24gaWQgZXJyb3JzICh1c2UgcHJvamVjdHMgLS1jcmVhdGUgZmlyc3QpXG4vLyAgICAgICAgICAgICAgICAgLS1wb3J0IDxuPiBiaW5kcyBhIFNUQUJMRSBwb3J0IHNvIGEgYnJvd3NlciByZWZyZXNoIHJlY29ubmVjdHNcbi8vICAgICAgICAgICAgICAgICBhY3Jvc3MgYW4gZW52aXJvbm1lbnQtcmVhcCArIHJlc3RhcnQuIFR3byB3cmlua2xlczogKDEpIGFnYWluc3Rcbi8vICAgICAgICAgICAgICAgICBhIExJVkUgZGFlbW9uIC0tcG9ydCBOIGlzIElHTk9SRUQgKG9wZW4gcmV0dXJucyB0aGUgZXhpc3Rpbmdcbi8vICAgICAgICAgICAgICAgICBkYWVtb24pIOKAlCB0aGUgc3RhYmxlIHVybCBob2xkcyBvbmx5IGlmIHRoZSBGSVJTVCBvcGVuIHNldCBpdDtcbi8vICAgICAgICAgICAgICAgICAoMikgaWYgcG9ydCBOIGlzIGFscmVhZHkgaW4gdXNlIHRoZSBkYWVtb24gZXhpdHMgYW5kIHRoaXMgcG9sbFxuLy8gICAgICAgICAgICAgICAgIHRpbWVzIG91dCAoXCJkYWVtb24gZGlkIG5vdCBjb21lIHVwXCIpIOKAlCBwaWNrIGEgZnJlZSBwb3J0LlxuLy8gICBzdGF0ZSAgICAgICAgIEdFVCAvc3RhdGUg4oaSIHRoZSByZWFsIHByb2plY3Qgc25hcHNob3Qgb24gc3Rkb3V0XG4vLyAgICAgICAgICAgICAgICAgLS1za2VsZXRvbiByZXR1cm5zIGlkcy90aXRsZXMvZGVncmVlIG9ubHkgKGNvbnRleHQgYnVkZ2V0aW5nKVxuLy8gICAgICAgICAgICAgICAgIGZyZXNoIHN0b3JlIHdpdGggbm8gcHJvamVjdCDihpIgdGhlIG5lZWRzLXByb2plY3QgNDA5IHJpZGVzXG4vLyAgICAgICAgICAgICAgICAgdGhlIGVycm9yIGVudmVsb3BlIChjb25mbGljdCwgZXhpdCA2OyBib2R5IHVuZGVyIGVycm9yLnNlcnZlcilcbi8vICAgdGFpbCAgICAgICAgICBNb25pdG9yLXNoYXBlZDogR0VUIC9ldmVudHM/c2luY2U9PGN1cnNvcj4gU1NFIOKGkiBvbmUgSlNPTlxuLy8gICAgICAgICAgICAgICAgIGxpbmUgcGVyIGV2ZW50IG9uIHN0ZG91dFxuLy8gICAgICAgICAgICAgICAgIC0taW5ib3VuZCBmaWx0ZXJzIHNlcnZlci1zaWRlIHRvIGh1bWFuLW9yaWdpbmF0ZWQgZXZlbnRzXG4vLyAgICAgICAgICAgICAgICAgKGNoYXQgKyBkcm9wcGVkIG5vZGVzKSArIG9wZW5zIHdpdGggYSBraW5kOlwiZ3JvdW5kaW5nXCIgbGluZVxuLy8gICAgICAgICAgICAgICAgIC0tb25jZSBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCwgcHJpbnRzIGl0LCBleGl0c1xuLy8gICAgICAgICAgICAgICAgICh0aGUgcXVpZXQgaGFuZG9mZidzIGJhY2tncm91bmQgb25lLXNob3QpXG4vLyAgIHByb2plY3RzICAgICAgbGlzdCBzYXZlZCBwcm9qZWN0czsgLS1jcmVhdGUgPHRpdGxlPiBtYWtlcyBhIG5ldyBvbmVcbi8vICAgaW5nZXN0ICAgICAgICAtLXRpdGxlIFQgKC0tZmlsZSBQIHwgLS1zdGRpbikg4oaSIFBPU1QgL2luZ2VzdFxuLy8gICBwcm9wb3NlLW5vZGUgIC0tc3RkaW4gSlNPTiB7ZHJhZnQsIGV2aWRlbmNlLCBzdWdnZXN0ZWRUaWVyP30g4oaSIFBPU1QgL3Byb3Bvc2Fsc1xuLy8gICBwcm9wb3NlLWVkZ2UgIHNhbWUgc2hhcGUsIGtpbmQ6IFwiZWRnZVwiIChzb3VyY2UvdGFyZ2V0IG1heSBiZSBhIHJlYWwgbm9kZVxuLy8gICAgICAgICAgICAgICAgIGlkIE9SIGEgcGVuZGluZyBwcm9wb3NhbCdzIGlkIOKAlCByYXRpZnkgcmVzb2x2ZXMgdGhlIGxhdHRlcilcbi8vICAgICAgICAgICAgICAgICAtLXpvbmUgPGlkPiBzdGFnZXMgdGhlIHByb3Bvc2FsIGluIGEgem9uZVxuLy8gICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCAuLi59XSwgZWRnZXM6W3tkcmFmdDp7XG4vLyAgICAgICAgICAgICAgICAgc291cmNlLCB0YXJnZXQsIGxhYmVsP319XX0g4oCUIG9uZSB0cmFuc2FjdGlvbjsgYW4gZWRnZVxuLy8gICAgICAgICAgICAgICAgIGVuZHBvaW50IG1heSBiZSBhIG5vZGUncyBMT0NBTCBSRUYgKHJlc29sdmVkIHRvIHRoZSBtaW50ZWRcbi8vICAgICAgICAgICAgICAgICBpZCBzZXJ2ZXItc2lkZSksIGEgcmVhbCBub2RlIGlkLCBvciBhIHBlbmRpbmcgcHJvcG9zYWwgaWQuXG4vLyAgICAgICAgICAgICAgICAgUmV0dXJucyB7cmVmVG9JZCwgcHJvcG9zYWxzfVxuLy8gICByZWFkIDxpZD4gICAgIEdFVCAvbWVzc2FnZS86aWQg4oaSIHRoZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuLy8gICBub2RlIGFuY2hvciA8aWQ+ICgtLXRvIDxwYXJlbnRJZD4gfCAtLWNsZWFyKSAgUE9TVCAvbm9kZXMvOmlkL2FuY2hvciDigJRcbi8vICAgICAgICAgICAgICAgICBhbmNob3IgYSByZWFsIG5vZGUgdW5kZXIgYSBwYXJlbnQgaW4gdGhlIHN1Ym1hcCB0cmVlLCBvclxuLy8gICAgICAgICAgICAgICAgIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIHRvcC1sZXZlbCAoY3ljbGVzIHJlamVjdGVkKVxuLy8gICB6b25lICAgICAgICAgIGNyZWF0ZSA8bmFtZT4gKHNsdWcgaWQgZGVyaXZlZCkgfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXVxuLy8gICAgICAgICAgICAgICAgIChkZWxldGUgY2FzY2FkZXMgdGhlIHpvbmUncyBwcm9wb3NhbHM7IHBvcHVsYXRlZCB6b25lcyA0MDlcbi8vICAgICAgICAgICAgICAgICB3aXRob3V0IC0teWVzKVxuLy8gICBwcm9tb3RlIDxpZD4gIG1vdmUgYSB6b25lZCBwZW5kaW5nIHByb3Bvc2FsIHRvIHRoZSBtYWluIHJldmlldyBxdWV1ZVxuLy8gICAgICAgICAgICAgICAgIChlZGdlIGVuZHBvaW50cyBtdXN0IHByb21vdGUgZmlyc3Qg4oCUIGVycm9yIG5hbWVzIHRoZW0pXG4vLyAgIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8em9uZUlkPiB8IC0tY2xlYXIpICBQT1NUIC9wcm9wb3NhbHMvOmlkL3pvbmUg4oCUXG4vLyAgICAgICAgICAgICAgICAgbW92ZSBhIFBFTkRJTkcgcHJvcG9zYWwgSU5UTyBhIHpvbmUgKHRoZSBpbnZlcnNlIG9mIHByb21vdGUpLFxuLy8gICAgICAgICAgICAgICAgIG9yIC0tY2xlYXIgdG8gbW92ZSBpdCBiYWNrIHRvIG1haW5cbi8vICAgZG9jIDxpZD4gICAgICBHRVQgL2RvYy86aWQg4oaSIHRoZSBkb2MgZW52ZWxvcGUgb24gc3Rkb3V0LiBGbGFncyBtYXkgY29tZVxuLy8gICAgICAgICAgICAgICAgIGJlZm9yZSBkb2MncyBzdWItdmVyYiAoYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDFgKTsgYSBkb2Ncbi8vICAgICAgICAgICAgICAgICBsaXRlcmFsbHkgbmFtZWQgXCJkZWxldGVcIiBvciBcImtpbmRcIiByZWFkcyBhcyBgZG9jIC0tIGRlbGV0ZWBcbi8vICAgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXSAgREVMRVRFIC9kb2MvOmlkIOKGkiA0MDkge2Vycm9yOlwiY2l0ZWRcIiwgY2l0ZWRCeX1cbi8vICAgICAgICAgICAgICAgICB3aGVuIGNpdGVkIGFuZCB1bmZvcmNlZDsgLS1mb3JjZSBjYXNjYWRlc1xuLy8gICBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kPiBbLS1hdXRob3IgdXNlcnxhZ2VudF0gfCBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJcbi8vICAgICAgICAgICAgICAgICBQT1NUIC9kb2MvOmlkL2tpbmQg4oCUIGFzc2VydCAob3IgY2xlYXIpIGEgZG9jJ3Mga2luZDsgaW5nZXN0XG4vLyAgICAgICAgICAgICAgICAgbmV2ZXIgZ3Vlc3NlcyBvbmUgKHVudHlwZWQgPSBraW5kIG51bGwgb24gdGhlIHdpcmUpXG4vLyAgIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICBQT1NUIC9kb2MvOmlkL21hcmsg4oaSIGFwcGVuZCBhXG4vLyAgICAgICAgICAgICAgICAgc3RhdHVzIG1hcmsgKGRvYy5tYXJrZWQgY2FycmllcyB0aGUgZnVsbCBtYXJrIGlubGluZSlcbi8vICAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgIFBVVC9ERUxFVEVcbi8vICAgICAgICAgICAgICAgICAvYWN0aW9ucy86dGFyZ2V0SWQg4oCUIHJlcGxhY2UgKHdob2xlc2FsZSkgb3IgY2xlYXIgdGhlXG4vLyAgICAgICAgICAgICAgICAgYWN0aW9uIHNsb3RzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuXG4vLyAgICAgICAgICAgICAgICAgYXJyYXkgb2Yge2lkLCBsYWJlbCwgc2VlZH07ID40IGVudHJpZXMgd2FybnMgKHNvZnQgY2FwKVxuLy8gICB0YWdzIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgUFVUL0RFTEVURVxuLy8gICAgICAgICAgICAgICAgIC90YWdzLzp0YXJnZXRJZCDigJQgcmVwbGFjZSAod2hvbGVzYWxlKSBvciBjbGVhciB0aGUgZnJlZWZvcm1cbi8vICAgICAgICAgICAgICAgICB0YWdzIG9uIGEgbm9kZSBvciBQRU5ESU5HIHByb3Bvc2FsOyBqc29uIGlzIGFuIGFycmF5IG9mXG4vLyAgICAgICAgICAgICAgICAgc3RyaW5nczsgdGFncyBhbHNvIHJpZGUgcHJvcG9zZS0qIHN0ZGluIEpTT04gKGEgYHRhZ3NgIGtleSlcbi8vICAgam9iICAgICAgICAgICBjcmVhdGUgLS10aXRsZSBUIFstLXN0YXR1cyBzXSBbLS1kZWxpdmVyYWJsZSByZWZdIFstLWRldGFpbCB4XVxuLy8gICAgICAgICAgICAgICAgIHwgdXBkYXRlIDxpZD4gWy0tdGl0bGUvLS1zdGF0dXMvLS1kZWxpdmVyYWJsZS8tLWRldGFpbF1cbi8vICAgICAgICAgICAgICAgICB8IGNsYWltIDxpZD4gLS1vd25lciA8d2hvPiAoYXRvbWljIGxlYXNlOyA0MDkgaWYgaGVsZCBieVxuLy8gICAgICAgICAgICAgICAgICAgYW5vdGhlciBvd25lcikgfCByZWxlYXNlIDxpZD4gfCBzdWJ0YXNrIDxpZD4gKC0tYWRkIDxsYWJlbD5cbi8vICAgICAgICAgICAgICAgICAgIHwgLS1jaGVjayA8c3VidGFza0lkPiB8IC0tdW5jaGVjayA8c3VidGFza0lkPikgfCBsaXN0XG4vLyAgICAgICAgICAgICAgICAgfCBkZWxldGUgPGlkPi4gQSBwZXJzaXN0ZWQgdW5pdCBvZiBBR0VOVCBXT1JLIChzdGF0dXMgK1xuLy8gICAgICAgICAgICAgICAgIHN1Yi10YXNrcyArIGRlbGl2ZXJhYmxlICsgb3duZXIpOyBjcmVhdGUvdXBkYXRlIGFsc28gdGFrZSBhXG4vLyAgICAgICAgICAgICAgICAgZnVsbCBKU09OIGJvZHkgdmlhIC0tc3RkaW4gLyAtLWJvZHktZmlsZVxuLy8gICBhY3Rpdml0eSA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT4gIFBPU1QgL2FjdGl2aXR5IOKGkiBmaXJlLWFuZC1mb3JnZXRcbi8vICAgICAgICAgICAgICAgICBhZ2VudC5hY3Rpdml0eSBzaWduYWwgKH42MHMgVFRMIGVtaXRzIHN5bnRoZXRpYyBpZGxlKVxuLy8gICBzZWFyY2ggPHEuLi4+IEdFVCAvc2VhcmNoIOKGkiB7aGl0czogW3traW5kOiBub2RlfGRvY3xtZXNzYWdlLCAuLi59XX1cbi8vICAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gIEdFVCAvbmVpZ2hib3JzLzppZCDihpIgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuLy8gICByYXRpZnkgPGlkPiAtLXJ1bGluZyBjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWx8cmVqZWN0IFstLWRvYy1lZGl0IDxmaWxlPl1cbi8vICAgICAgICAgICAgICAgICBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSAgcmF0aWZ5LXRpbWUgZXZpZGVuY2UgYXR0YWNoOlxuLy8gICAgICAgICAgICAgICAgIGZvciBhbiBFVklERU5DRS1MRVNTIG5vZGUgcHJvcG9zYWwgb25seSwgLS1kb2MgbmFtZXMgdGhlIGRvY1xuLy8gICAgICAgICAgICAgICAgIGhvbWUgKG11c3QgZXhpc3Q7IHJlcXVpcmVzIC0tZG9jLWVkaXQpIGFuZCBtaW50cyB0aGUgbm9kZSdzXG4vLyAgICAgICAgICAgICAgICAgc291cmNlcyByb3cgd2l0aCB0aGUgb3B0aW9uYWwgLS1zcGFuIGV4Y2VycHRcbi8vICAgbGVucyBzZXQgKC0tbm9kZSA8aWQ+IFstLWRlcHRoIG5dIHwgLS1kb2MgPGRvY0lkPikgfCBsZW5zIGNsZWFyXG4vLyAgIGxvb2staGVyZSA8bm9kZUlkPiAgZmlyZS1vbmNlIGF0dGVudGlvbiBudWRnZSwgbm90IHBlcnNpc3RlZFxuLy8gICBzZW5kICAgICAgICAgIGJvZHkgY2hhaW46IC0tYm9keS1maWxlIDxwYXRoPiA+IC0tc3RkaW4gPiBpbmxpbmUgPHRleHQuLi4+ID5cbi8vICAgICAgICAgICAgICAgICBwaXBlZCBzdGRpbjsgWy0tcm9sZSB1c2VyfGFnZW50XSBbLS1raW5kXSBbLS1ncm91bmQgYSxiXVxuLy8gICAgICAgICAgICAgICAgIChyZXBlYXRhYmxlIOKAlCByZXBlYXRzIGFjY3VtdWxhdGUsIGNvbW1hcyBzcGxpdCBlaXRoZXIgd2F5KVxuLy8gICAgICAgICAgICAgICAgIFstLWZvcmNlXSDihpIgUE9TVCAvc2VuZC4gRW1wdHkgcmVzb2x2ZWQgYm9keSA9IHVzYWdlIGVycm9yLiBUaGVcbi8vICAgICAgICAgICAgICAgICBwaXBlZCBkZWZhdWx0IEhBTkdTIHdpdGggbm8gcGlwZSB1bmRlciBhZ2VudCBzaGVsbHMg4oCUIGFsd2F5c1xuLy8gICAgICAgICAgICAgICAgIHBhc3MgYSBib2R5ICgtLWJvZHktZmlsZSBwcmVmZXJyZWQgZm9yIHByb3NlKS5cbi8vICAgICAgICAgICAgICAgICBSMTE6IC0ta2luZCBpcyB0aGUgQ0hBTk5FTCB0aGUgbWVzc2FnZSBhcnJpdmVkIHRocm91Z2hcbi8vICAgICAgICAgICAgICAgICAodHVybnxhbmFseXplfGNhbnZhczsgb3BlbiBzZXQg4oCUIGFuIHVua25vd24gb25lIGlzIHN0b3JlZFxuLy8gICAgICAgICAgICAgICAgIHdpdGggYSBzdGRlcnIgYWR2aXNvcnksIG5ldmVyIHJlamVjdGVkKS5cbi8vICAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gIOKGkiBQT1NUIC9hY3Rpdml0eS4gVGhlXG4vLyAgICAgICAgICAgICAgICAgbWVzc2FnZUlkIHRpZXMgdGhlIHNpZ25hbCB0byBPTkUgbWVzc2FnZSBzbyB0aGUgaHVtYW4gc2Vlc1xuLy8gICAgICAgICAgICAgICAgIHdoaWNoIG9uZSBpcyBiZWluZyB3b3JrZWQ7IG9taXR0ZWQsIGl0IGluaGVyaXRzIHRoZSBvcGVuXG4vLyAgICAgICAgICAgICAgICAgbGFkZGVyJ3MgbWVzc2FnZS4gaWRsZSBjbG9zZXMgdGhlIGxhZGRlciAodGhlcmUgaXMgbm8gYGRvbmVgXG4vLyAgICAgICAgICAgICAgICAg4oCUIGFuIGFnZW50IGBzZW5kYCBJUyB0aGUgY29tcGxldGlvbiBzaWduYWwpLlxuLy9cbi8vIC0tcHJvamVjdCA8aWQ+IGlzIGFjY2VwdGVkIGJ5IGV2ZXJ5IHZlcmIgYWJvdmUgZXhjZXB0IHByb2plY3RzIChzY29wZXMgdG8gYVxuLy8gbm9uLWRlZmF1bHQgcHJvamVjdDsgb21pdCBmb3IgdGhlIGRlZmF1bHQgcHJvamVjdCkuXG4vL1xuLy8gRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgc3RhdGVkIE9OQ0Ug4oCUIHBlci12ZXJiIHByb3NlIGFib3ZlIG5hbWVzIEhUVFBcbi8vIHN0YXR1c2VzLCB0aGlzIHRhYmxlIGlzIHdoYXQgdGhlIFBST0NFU1MgZG9lcyB3aXRoIHRoZW0pOiBldmVyeSBmYWlsdXJlIGlzXG4vLyBPTkUgSlNPTiBlbnZlbG9wZSBvbiBzdGRlcnIgd2l0aCBzdGRvdXQgZW1wdHkg4oCUXG4vLyAgIHtvazpmYWxzZSwgZXJyb3I6e2tpbmQsIGV4aXRfY29kZSwgcmV0cnlhYmxlLCBtZXNzYWdlLCBoaW50PywgY2hvaWNlcz8sXG4vLyAgICBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4vLyAgIHVzYWdlIOKGkiBleGl0IDIgwrcgaW50ZXJuYWwg4oaSIDEgwrcgbm90X2ZvdW5kIOKGkiA1IChIVFRQIDQwNCkgwrcgY29uZmxpY3Qg4oaSIDZcbi8vICAgKEhUVFAgNDA5KTsgSFRUUCA0MDAgbWFwcyB0byB1c2FnZS4gQSBkYWVtb24gcmVmdXNhbCBjYXJyaWVzIHRoZSBzZXJ2ZXInc1xuLy8gICBvd24gSlNPTiBib2R5IFZFUkJBVElNIHVuZGVyIGVycm9yLnNlcnZlciAobmVlZHMtcHJvamVjdCwgY2l0ZWQsIHpvbmVkLFxuLy8gICB6b25lLW5vdC1lbXB0eSwgY2xhaW0gY29uZmxpY3RzLCDigKYpIOKAlCBicmFuY2ggb24ga2luZC9zZXJ2ZXIsIG5ldmVyIHByb3NlLlxuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7IGV4aXN0c1N5bmMsIHJlYWRGaWxlU3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQge1xuICB0eXBlIENvbW1hbmRTcGVjLFxuICBkZWZpbmVDbGksXG4gIHR5cGUgSW52b2NhdGlvbixcbiAgdHlwZSBQb3NpdGlvbmFsU3BlYyxcbn0gZnJvbSBcIi4uLy4uL2tpdC9jbGkvcmVnaXN0cnkudHNcIjtcbmltcG9ydCB7XG4gIEVYSVRfRk9SLFxuICBlcnJvckVudmVsb3BlLFxuICBnZXRDdXJyZW50Q29tbWFuZCxcbiAgQ2xpRXJyb3IgYXMgS2l0Q2xpRXJyb3IsXG4gIHR5cGUgRXJyS2luZCBhcyBLaXRFcnJLaW5kLFxuICByZXBvcnRDbGlFcnJvcixcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL2Vycm9ycy50c1wiO1xuaW1wb3J0IHtcbiAgY29tbWFuZExpbmUsXG4gIHJlYWRTaW5jZSxcbiAgdGFpbENvbW1hbmQsXG4gIHRhaWxXaXRoSGFuZG9mZixcbiAgV0lORE9XX0hFTFAsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS90YWlsSGFuZG9mZi50c1wiO1xuaW1wb3J0IHsgVEFJTF9JRExFX01TLCBUQUlMX1JFVFJZX01BWF9NUywgVEFJTF9SRVRSWV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdC50c1wiO1xuXG4vLyDim5QgRVZFUlkgUEFUSCBCRUxPVyBJUyBDT01QVVRFRCBGUk9NIFRIRSBBUlRJRkFDVCdTIEFERFJFU1MsIFdISUNIIElTXG4vLyBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21pbmQtbWFwcGVyL2Rpc3QvY2xpLmpzYCDigJQgTk9UIEZST00gVEhJUyBTT1VSQ0Vcbi8vIEZJTEUuIFRoYXQgaXMgd2hhdCBtYWtlcyB0aGUgYGltcG9ydC5tZXRhLm1haW5gIGJsb2NrJ3MgYWJzZW5jZSBhdCB0aGUgYm90dG9tXG4vLyBvZiB0aGlzIGZpbGUgYSByZXF1aXJlbWVudCByYXRoZXIgdGhhbiBhIHRpZHk6IHJ1biBmcm9tXG4vLyBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvYCB0aGVzZSByZXNvbHZlIGludG8gYHNyYy9taW5kLW1hcHBlci9gLCB3aGljaCBoYXMgbm9cbi8vIGBkaXN0L2luZGV4Lmh0bWxgLCBzbyB0aGUgQ0xJIHdvdWxkIGNob29zZSBERVYgYW5kIHRoZW4gc3Bhd24gYSBkYWVtb24gZnJvbVxuLy8gdGhlIHdyb25nIGFuY2hvci4gYGRpc3QvYCBzaXRzIGF0IHRoZSBzYW1lIGRlcHRoIHVuZGVyIHRoZSBza2lsbCByb290IGFzIHRoZVxuLy8gYHNjcmlwdHMvYCBpdCByZXBsYWNlZCwgc28gZXZlcnkgYW5jZXN0b3IgY2xpbWIgYmVsb3cgaXMgdW5jaGFuZ2VkIOKAlCBhXG4vLyBDT0lOQ0lERU5DRSBPRiBERVBUSCwgYXNzZXJ0ZWQgYnkgYGdyaW1vaXJlL3NwYXduLXBhdGgtd2FyZC50ZXN0LnRzYCByYXRoZXJcbi8vIHRoYW4gdHJ1c3RlZCAocGxheWJvb2sgQjQvQjUpLlxuY29uc3QgU0NSSVBUX0RJUiA9IGltcG9ydC5tZXRhLmRpcjtcbi8vIOKblCBVUCBBTkQgQkFDSyBET1dOLCBOT1QgQSBGTEFUIFNJQkxJTkcuIFRoaXMgd2FzIGBqb2luKFNDUklQVF9ESVIsXG4vLyBcInNlcnZlci50c1wiKWAgdW50aWwgdGhlIGJhY2tlbmQgcG9ydCDigJQgZ2xhbW91cidzIGV4YWN0IHNoaXBwZWQgZGVmZWN0IHNoYXBlLFxuLy8gY29ycmVjdCBvbmx5IHdoaWxlIHRoZSBDTEkgYW5kIHRoZSBkYWVtb24gc2hhcmVkIGEgZm9sZGVyLiBGcm9tIGBkaXN0L2AgdGhlXG4vLyBmbGF0IGZvcm0gbmFtZXMgYGRpc3Qvc2VydmVyLnRzYCwgd2hpY2ggZG9lcyBub3QgZXhpc3Q7IHRoZSBzeW1wdG9tIGlzIG5vdCBhXG4vLyBjcmFzaCBidXQgYGVuc3VyZURhZW1vbmAncyBwb2xsIHJ1bm5pbmcgb3V0IHRvIFwiZGFlbW9uIGRpZCBub3QgY29tZSB1cCB3aXRoaW5cbi8vIDEwc1wiLiBUaGUgbGF1bmNoZXIgaXMgdGhlIHByb2Nlc3MgYSBjYWxsZXIgcnVucywgYW5kIGl0IGxpdmVzIGluIGBzY3JpcHRzL2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2U7IEJ1biByZWFkcyBidW5maWcudG9tbFxuLy8gKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2QgTVVTVCBiZVxuLy8gc3JjL21pbmQtbWFwcGVyLyAoc2VhbXMgQ29udHJhY3QgNSBjd2QtcGluKSDigJQgbGF1bmNoZWQgZWxzZXdoZXJlIHRoZSBkZXZcbi8vIGJ1bmRsZXIgY2Fubm90IGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBwYWdlIDUwMHM7XG4vLyBtaW5kLW1hcHBlcidzIG93biBmYWlsdXJlIHNoYXBlIGlzIHVubWVhc3VyZWQpLiByZWxlYXNlOiBkaXN0LyBpcyBwcmUtYnVpbHQgYW5kIHN0YXRpYyDigJQgbm8gYnVuZmlnXG4vLyByZWFkLCBzbyB0aGlzIHBhdGggbmVlZCBub3QgZXhpc3QgYXQgYWxsIChhIHNvdXJjZS1mcmVlIG1hcmtldHBsYWNlIGNsb25lXG4vLyBoYXMgbm8gdG9wLWxldmVsIHNyYy8pLCBhbmQgcGlubmluZyBjd2QgdGhlcmUgYW55d2F5IHdvdWxkIGJyZWFrIHNwYXduLlxuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1pbmQtbWFwcGVyXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuY29uc3QgSE9NRSA9IHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0hPTUUgPz8gam9pbihob21lZGlyKCksIFwiLm1pbmQtbWFwcGVyXCIpO1xuY29uc3QgUE9SVF9GSUxFID0gam9pbihIT01FLCBcImRhZW1vbi5wb3J0XCIpO1xuY29uc3QgUElEX0ZJTEUgPSBqb2luKEhPTUUsIFwiZGFlbW9uLnBpZFwiKTtcblxuZnVuY3Rpb24gbGl2ZVBvcnQoKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghZXhpc3RzU3luYyhQT1JUX0ZJTEUpIHx8ICFleGlzdHNTeW5jKFBJRF9GSUxFKSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHBpZCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUElEX0ZJTEUsIFwidXRmOFwiKS50cmltKCksIDEwKTtcbiAgY29uc3QgcG9ydCA9IE51bWJlci5wYXJzZUludChyZWFkRmlsZVN5bmMoUE9SVF9GSUxFLCBcInV0ZjhcIikudHJpbSgpLCAxMCk7XG4gIGlmICghTnVtYmVyLmlzRmluaXRlKHBpZCkgfHwgIU51bWJlci5pc0Zpbml0ZShwb3J0KSkgcmV0dXJuIG51bGw7XG4gIHRyeSB7XG4gICAgcHJvY2Vzcy5raWxsKHBpZCwgMCk7IC8vIGxpdmVuZXNzIHByb2JlLCBubyBzaWduYWwgZGVsaXZlcmVkXG4gICAgcmV0dXJuIHBvcnQ7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsOyAvLyBzdGFsZSBkaXNjb3ZlcnkgZmlsZXNcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBlbnN1cmVEYWVtb24ocG9ydD86IHN0cmluZyk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHJ1bm5pbmcgPSBsaXZlUG9ydCgpO1xuICAvLyBSb3VuZCA3IChQT1JUKTogYSBsaXZlIGRhZW1vbiBJR05PUkVTIC0tcG9ydCDigJQgdGhlIHN0YWJsZS11cmwgZ3VhcmFudGVlXG4gIC8vIG9ubHkgaG9sZHMgaWYgdGhlIEZJUlNUIG9wZW4gc2V0IHRoZSBwb3J0ICh0aGUgZGFlbW9uIGJpbmRzIG9uY2UgYXQgYm9vdCkuXG4gIGlmIChydW5uaW5nICE9PSBudWxsKSByZXR1cm4gcnVubmluZztcbiAgY29uc3QgcHJvYyA9IHNwYXduKFxuICAgIHByb2Nlc3MuZXhlY1BhdGgsXG4gICAgW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFQsIFwiLS1uby1vcGVuXCIsIC4uLihwb3J0ID8gW1wiLS1wb3J0XCIsIFN0cmluZyhwb3J0KV0gOiBbXSldLFxuICAgIHtcbiAgICAgIGRldGFjaGVkOiB0cnVlLFxuICAgICAgc3RkaW86IFwiaWdub3JlXCIsXG4gICAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICAgIH0sXG4gICk7XG4gIHByb2MudW5yZWYoKTtcbiAgLy8gUG9sbCBkaXNjb3ZlcnkgdW50aWwgdGhlIGRhZW1vbiB3cml0ZXMgaXRzIHBvcnQgKGNvbGQgQnVuIGJ1bmRsZSBjYW4gbGFnKS5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCAxMDA7IGkrKykge1xuICAgIGF3YWl0IG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIDEwMCkpO1xuICAgIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICAgIGlmIChwb3J0ICE9PSBudWxsKSByZXR1cm4gcG9ydDtcbiAgfVxuICB0aHJvdyBuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBcImRhZW1vbiBkaWQgbm90IGNvbWUgdXAgd2l0aGluIDEwc1wiKTtcbn1cblxuZnVuY3Rpb24gb3BlbkJyb3dzZXIodXJsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY21kID1cbiAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gIHNwYXduKGNtZCwgW3VybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG59XG5cbi8vIOKblCBgZW52TXNgIElTIEdPTkUsIEFORCBJVFMgVFdPIEtOT0JTIE1PVkVEIFJBVEhFUiBUSEFOIERJU0FQUEVBUkVELlxuLy8gYE1JTkRfTUFQUEVSX1RBSUxfSURMRV9NU2AgYW5kIGBNSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TYCBhcmUgcmVzb2x2ZWQgaW5cbi8vIGAuL2hlYXJ0YmVhdC50c2Ag4oCUIHRoZSBzZWFtIGZpbGUgQk9USCBoYWx2ZXMgaW1wb3J0IOKAlCBiZWNhdXNlIHRoZSB3YXRjaGRvZyBpc1xuLy8gREVSSVZFRCBmcm9tIHRoZSBkYWVtb24ncyBiZWF0IGFuZCBhIGtub2IgcmVzb2x2ZWQgYWJvdmUgdGhlIGRlcml2YXRpb24gc3BsaXRzXG4vLyB0aGUgcGFpciBzaWxlbnRseSwgaW52aXNpYmx5IGF0IHRoZSBkZWZhdWx0IChENzUpLlxuXG4vLyDilIDilIAgdGhlIGZhaWx1cmUgY29udHJhY3Q6IFRIRSBIT1VTRSdTIE9ORSBDT1BZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIOKblCBERS1EVVBMSUNBVEVELCBBTkQgTUlORC1NQVBQRVIgSVMgT05FIE9GIFRIRSBUV08gU1BFTExTIFRISVMgTU9EVUxFJ1MgT1dOXG4vLyBIRUFERVIgTkFNRVMgQVMgSEFWSU5HIFJFQUNIRUQgSVRTIFNIQVBFIElOREVQRU5ERU5UTFkgKGBlcnJvcnMudHM6MzNgOlxuLy8gXCJnbGFtb3VyIGFuZCBtaW5kLW1hcHBlciByZWFjaGVkIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDBcbi8vIHBhc3Nlc1wiKS4gVGhlIGRlbHRhIG9uIHRoZSBXSVJFIGlzIE5JTCwgYW5kIHRoYXQgaXMgYSBtZWFzdXJlbWVudCByYXRoZXIgdGhhblxuLy8gYSBob3BlOiB0aGUgYEVycktpbmRgIHVuaW9uIHdhcyBjaGFyYWN0ZXItZm9yLWNoYXJhY3RlciBpZGVudGljYWwsIGBFWElUX0ZPUmBcbi8vIHdhcyB0aGUgc2FtZSBgMi8xLzUvNmAsIGFuZCB0aGUgZW52ZWxvcGUgaGFkIHRoZSBzYW1lIGtleXMgaW4gdGhlIHNhbWUgb3JkZXJcbi8vIOKAlCBge29rOmZhbHNlLCBlcnJvcjp7a2luZCwgZXhpdF9jb2RlLCByZXRyeWFibGUsIG1lc3NhZ2UsIGhpbnQ/LCBjaG9pY2VzPyxcbi8vIHNlcnZlcj99LCBtZXRhOntjb21tYW5kfX1gIOKAlCBpbmNsdWRpbmcgYHNlcnZlcmAgTEFTVCwgd2hpY2ggdGhlIGtpdCdzIG93blxuLy8gY29tbWVudCBzYXlzIGlzIGRlbGliZXJhdGUgc28gYSBzcGVsbCB0aGF0IGFscmVhZHkgZW1pdHRlZCBpdCBrZWVwcyBpdHMgYnl0ZVxuLy8gb3JkZXIuIOKaoCBPTkUgbGF0ZW50IGRpZmZlcmVuY2UsIGNoZWNrZWQgYW5kIGVtcHR5OiB0aGUga2l0IGd1YXJkcyBgaGludGAgYW5kXG4vLyBgY2hvaWNlc2Agb24gVFJVVEhJTkVTUyB3aGVyZSB0aGlzIGZpbGUgZ3VhcmRlZCBvbiBQUkVTRU5DRSwgc28gYVxuLy8gYGhpbnQ6IFwiXCJgIHdvdWxkIHNoaXAgZnJvbSBvbmUgYW5kIG5vdCB0aGUgb3RoZXIuIEdyZXBwZWQ6IHRoaXMgQ0xJIGhhcyBub1xuLy8gZW1wdHktc3RyaW5nIGhpbnQgYXQgYW55IG9mIGl0cyA2NCByYWlzZSBzaXRlcywgc28gdGhlIHBvcHVsYXRpb25zIGFncmVlLlxuLy9cbi8vIG1pbmQtbWFwcGVyIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0XG4vLyBFVkVSWSBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXNcbi8vIHByZXNlbnRhdGlvbiDigJQgcmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0IG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzXG4vLyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLiBEZWxpdmVyeSBpcyBib3VudHkncywgbm90IG1hZ3BpZSdzOiBUSFJPV1xuLy8gYW5kIGxldCBtYWluKCkgY2F0Y2ggYW5kIFJFVFVSTiB0aGUgY29kZSDigJQgdGhpcyBDTEkgc2hpcHMgbGFyZ2Ugc3Rkb3V0XG4vLyBwYXlsb2FkcywgYW5kIGEgYHByb2Nlc3MuZXhpdGAgaW5zaWRlIGEgYGRpZSgpYCB3b3VsZCB0cnVuY2F0ZSB0aGVtIGF0IDY1LDUzNlxuLy8gYnl0ZXMgKHNlZSB0aGUgZHJhaW4gaWRpb20gYXQgdGhlIGJvdHRvbSBvZiB0aGlzIGZpbGUpLiBUaGUga2l0J3MgYGRpZWBcbi8vIHRocm93cyBmb3IgZXhhY3RseSB0aGF0IHJlYXNvbiwgc28gdGhlIGFkb3B0aW9uIGNoYW5nZXMgbm8gZGVsaXZlcnkgZWl0aGVyLlxuLy9cbi8vIOKblCBBTkQgVEhJUyBJUyBUSEUgT05FIFNURVAgT0YgVEhFIFdIT0xFIFBIQVNFIFdIRVJFIFRIRSBLSVQgSVMgTUVBU1VSQUJMWVxuLy8gV0VBS0VSLCBXSElDSCBJUyBXSFkgVEhFIFRSSUFHRSBDSEFJTiBJTiBgbWFpbmAgQkVMT1cgSVMgS0VQVCBBTkQgTk9UXG4vLyBSRVBMQUNFRC4gYGVycm9ycy50c2AgaXMgVFdPIHRoaW5ncyDigJQgYW4gRU5WRUxPUEUgYW5kIGEgQ0xBU1NJRklFUiDigJQgYW5kIG9ubHlcbi8vIHRoZSBlbnZlbG9wZSBjb252ZXJnZWQuIGByZXBvcnRDbGlFcnJvcmAgcmV0dXJucyBgbnVsbGAgZm9yIGFueXRoaW5nIHRoYXQgaXNcbi8vIG5vdCBhIGBDbGlFcnJvcmAgYW5kIGRlbWFuZHMgdGhlIGNhbGxlciByZXRocm93OyB0aGlzIENMSSB0cmlhZ2VzIFRIUkVFXG4vLyBkb2N1bWVudGVkIHVzYWdlIGNsYXNzZXMgb3V0IG9mIHJhdyB0aHJvd3MgKGBFUlJfUEFSU0VfQVJHUypgLCBhXG4vLyBgU3ludGF4RXJyb3JgIGZyb20gYSBKU09OIGJvZHksIGFuZCBgRU5PRU5UYCBvbiBhIG5hbWVkIGZpbGUpLiBBZG9wdGluZyB0aGVcbi8vIGNsYXNzaWZpZXIgbmFpdmVseSB3b3VsZCByZWdyZXNzIGFsbCB0aHJlZSBpbnRvIGEgc3RhY2stdHJhY2UgY3Jhc2gg4oCUIHRoZVxuLy8gZXhhY3QgZGVmZWN0IHRoaXMgZmlsZSdzIG93biBjb21tZW50IHJlY29yZHMgYXMgY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nLFxuLy8gcmUtY3JlYXRlZCBieSB0aGUgYWRvcHRpb24gbWVhbnQgdG8gc3RhbmRhcmRpc2UgaXQuIFNvIGByZXBvcnRDbGlFcnJvcmAgaXNcbi8vIGNhbGxlZCBJTlNJREUgdGhlIGNoYWluLCBhdCB0aGUgcG9zaXRpb24gdGhlIGNoYWluIHJlYWNoZXMgZm9yIGEgdHlwZWRcbi8vIGZhaWx1cmUsIGFuZCB0aGUgY2hhaW4ga2VlcHMgdGhlIHRocmVlIGJyYW5jaGVzIHRoZSBraXQgZG9lcyBub3QgY2FycnkuXG50eXBlIEVycktpbmQgPSBLaXRFcnJLaW5kO1xuXG4vKipcbiAqIG1pbmQtbWFwcGVyJ3MgcmFpc2UgdHlwZSBpcyBub3cgdGhlIGtpdCdzIGBDbGlFcnJvcmAsIHJlLWV4cG9ydGVkIHVuZGVyIHRoZVxuICogbmFtZSA2MiBjYWxsIHNpdGVzIGFscmVhZHkgdXNlLiDimqAgVGhlIEZJRUxEIFNIQVBFIGRpZmZlcnM6IHRoaXMgZmlsZSdzIGNsYXNzXG4gKiBoZWxkIGBoaW50YC9gY2hvaWNlc2AvYHNlcnZlcmAgYXMgb3duIHByb3BlcnRpZXMgYW5kIHRoZSBraXQgaG9sZHMgdGhlbSBpbiBhblxuICogYGV4dHJhYCBiYWcsIHNvIHRoZSBjb25zdHJ1Y3RvciBiZWxvdyBhZGFwdHMgcmF0aGVyIHRoYW4gdGhlIGNhbGwgc2l0ZXNcbiAqIGNoYW5naW5nIOKAlCBhIHJlbG9jYXRpb24tc2hhcGVkIGVkaXQgYXQgNjIgc2l0ZXMgaW5zaWRlIGEgY2hhcHRlciB0aXRsZWRcbiAqIFwiYmVoYXZpb3VyIGNoYW5nZXMsIGFuZCBlYWNoIGNoYW5nZSBpcyBuYW1lZFwiIGlzIGhvdyBhIHJlYWwgY2hhbmdlIGhpZGVzLlxuICovXG5jbGFzcyBDbGlFcnJvciBleHRlbmRzIEtpdENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAga2luZDogRXJyS2luZCxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9LFxuICApIHtcbiAgICBzdXBlcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuY29uc3QgdXNhZ2VFcnJvciA9IChtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkgPT5cbiAgbmV3IENsaUVycm9yKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuXG4vKipcbiAqIFJlcG9ydCBvbmUgb2YgdGhlIHRocmVlIFJBVyB0aHJvd3MgdGhlIGtpdCdzIGNsYXNzaWZpZXIgZG9lcyBub3QgcmVjb2duaXNlIGFzXG4gKiBhIGB1c2FnZWAgZW52ZWxvcGUsIGFuZCBoYW5kIGJhY2sgaXRzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgRVhJU1RTIEJFQ0FVU0UgVEhFIENMQVNTSUZJRVIgSVMgVEhFIEhBTEYgVEhBVCBESUQgTk9UIENPTlZFUkdFLiBUaGVzZVxuICogdGhyZWUgYXJlIG5vdCBgQ2xpRXJyb3JgcyDigJQgdGhleSBhcmUgYSBgbm9kZTp1dGlsYCBwYXJzZSByZWplY3Rpb24sIGFcbiAqIGBTeW50YXhFcnJvcmAgb3V0IG9mIGBKU09OLnBhcnNlYCwgYW5kIGFuIGBFTk9FTlRgIGZyb20gYSBuYW1lZCBwYXRoIOKAlCBhbmRcbiAqIGByZXBvcnRDbGlFcnJvcmAgYW5zd2VycyBgbnVsbGAgZm9yIGFsbCB0aHJlZS4gUm91dGluZyB0aGVtIHRocm91Z2ggdGhlXG4gKiBFTlZFTE9QRSAod2hpY2ggZGlkIGNvbnZlcmdlKSBpcyB0aGUgd2hvbGUgb2YgdGhlIHJlcGFpcjogc2FtZSBieXRlcyBvblxuICogc3RkZXJyLCBzYW1lIGV4aXQgMiwgYW5kIHRoZSB0cmlhZ2Ugc3RheXMgd2hlcmUgdGhlIHNwZWxsIGNhbiBzZWUgaXQuXG4gKi9cbmZ1bmN0aW9uIHJlcG9ydFVzYWdlKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KTogbnVtYmVyIHtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKSk7XG4gIHJldHVybiBFWElUX0ZPUi51c2FnZTtcbn1cblxuLy8gVGhlIG9uZSBleGl0IGZvciBldmVyeSBkYWVtb24gcm91bmQtdHJpcDogb2sg4oaSIHRoZSBib2R5IHRleHQgKGNhbGxlciBwcmludHNcbi8vIGl0IG9uIHN0ZG91dCksIHJlZnVzZWQg4oaSIGEgdHlwZWQgQ2xpRXJyb3Igd2hvc2Uga2luZCBtYXBzIG9mZiB0aGUgSFRUUFxuLy8gc3RhdHVzIGFuZCB3aG9zZSBgc2VydmVyYCBmaWVsZCBjYXJyaWVzIHRoZSBkYWVtb24ncyBvd24gSlNPTiBib2R5LlxuYXN5bmMgZnVuY3Rpb24gcGFzc09yVGhyb3cocmVzOiBSZXNwb25zZSk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpO1xuICBpZiAocmVzLm9rKSByZXR1cm4gdGV4dDtcbiAgbGV0IHNlcnZlcjogdW5rbm93biA9IHRleHQ7XG4gIHRyeSB7XG4gICAgc2VydmVyID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gZGFlbW9uIGJvZHkgcmlkZXMgYXMgdGhlIHJhdyBzdHJpbmcgKi9cbiAgfVxuICBjb25zdCBraW5kOiBFcnJLaW5kID1cbiAgICByZXMuc3RhdHVzID09PSA0MDRcbiAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgOiByZXMuc3RhdHVzID09PSA0MDlcbiAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgOiByZXMuc3RhdHVzID09PSA0MDBcbiAgICAgICAgICA/IFwidXNhZ2VcIlxuICAgICAgICAgIDogXCJpbnRlcm5hbFwiO1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgYCR7Z2V0Q3VycmVudENvbW1hbmQoKSA/PyBcInJlcXVlc3RcIn0gcmVmdXNlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIHtcbiAgICBzZXJ2ZXIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiByZXF1aXJlRGFlbW9uKCk6IG51bWJlciB7XG4gIGNvbnN0IHBvcnQgPSBsaXZlUG9ydCgpO1xuICBpZiAocG9ydCA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBDbGlFcnJvcihcIm5vdF9mb3VuZFwiLCBcIm5vIGRhZW1vbiBydW5uaW5nICh1c2UgYG9wZW5gIGZpcnN0KVwiKTtcbiAgfVxuICByZXR1cm4gcG9ydDtcbn1cblxuLy8gU2tlbGV0b24gcHJvamVjdGlvbiDigJQgaWRzL3RpdGxlcy9kZWdyZWUgb25seSwgbm8gc3lub3BzaXMvY29udGVudC4gS2VwdCBhc1xuLy8gYSBjbGllbnQtc2lkZSB0cmFuc2Zvcm0gKHRoZSBkYWVtb24gc3RheXMgZHVtYiBhbmQgYWx3YXlzIHNlcnZlcyB0aGUgZnVsbFxuLy8gc25hcHNob3Q7IHNrZWxldG9uIGlzIGEgY291cnRlc3kgc2hhcGUgZm9yIGNvbnRleHQtYnVkZ2V0ZWQgYWdlbnQgcmVhZHMpLlxuZnVuY3Rpb24gdG9Ta2VsZXRvbihzdGF0ZToge1xuICBub2RlczogQXJyYXk8eyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBraW5kOiBzdHJpbmc7IHRpZXI6IHN0cmluZyB9PjtcbiAgZWRnZXM6IEFycmF5PHsgaWQ6IHN0cmluZzsgc291cmNlOiBzdHJpbmc7IHRhcmdldDogc3RyaW5nIH0+O1xufSkge1xuICBjb25zdCBkZWdyZWUgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IGUgb2Ygc3RhdGUuZWRnZXMpIHtcbiAgICBkZWdyZWUuc2V0KGUuc291cmNlLCAoZGVncmVlLmdldChlLnNvdXJjZSkgPz8gMCkgKyAxKTtcbiAgICBkZWdyZWUuc2V0KGUudGFyZ2V0LCAoZGVncmVlLmdldChlLnRhcmdldCkgPz8gMCkgKyAxKTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG5vZGVzOiBzdGF0ZS5ub2Rlcy5tYXAoKG4pID0+ICh7XG4gICAgICBpZDogbi5pZCxcbiAgICAgIHRpdGxlOiBuLnRpdGxlLFxuICAgICAga2luZDogbi5raW5kLFxuICAgICAgdGllcjogbi50aWVyLFxuICAgICAgZGVncmVlOiBkZWdyZWUuZ2V0KG4uaWQpID8/IDAsXG4gICAgfSkpLFxuICB9O1xufVxuXG4vLyDilIDilIAgdGhlIGZsYWcgcmVnaXN0cnkgKyB0aGUgY29tbWFuZCB0YWJsZSwgT04gVEhFIEtJVCBSRUdJU1RSWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS4gRXZlcnkgaW52b2NhdGlvbiBpcyBwYXJzZWQgc3RyaWN0XG4vLyBhZ2FpbnN0IHRoaXMgd2hvbGUgdGFibGUsIHNvIGEgdG9rZW4gbWluZC1tYXBwZXIgaGFzIG5ldmVyIGhlYXJkIG9mIGlzXG4vLyByZWZ1c2VkIGFzIFVOS05PV047IHRoZSByZWdpc3RyeSB0aGVuIGFza3MgdGhlIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OlxuLy8gaXMgdGhpcyBmbGFnIGFjY2VwdGVkIEFUIFRISVMgVkVSQi4gQSByZWNvZ25pemVkIGZsYWcgb24gdGhlIHdyb25nIHZlcmIgaXNcbi8vIHJlZnVzZWQgYXMgTUlTUExBQ0VEIChgc3RhdGUgLS1ydWxpbmdgIGlzIG5vdCBhIHR5cG8pLCBhbmQgYm90aCByZWplY3Rpb25zXG4vLyBjYXJyeSB0aGF0IHZlcmIncyBhY2NlcHRlZCBzZXQgYXMgYGNob2ljZXNgLlxuLy9cbi8vIE5PIERFRkFVTFRTIGluIHRoZSB0YWJsZTogcGVyLXZlcmIgZGVmYXVsdHMgbGl2ZSBhdCB0aGUgY29uc3VtcHRpb24gc2l0ZVxuLy8gKGA/PyBcImFnZW50XCJgLCBgPz8gXCIxXCJgKSwgd2hlcmUgdGhlIGRhZW1vbidzIGNvbnRyYWN0IGlzIHdyaXR0ZW4uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYWRkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYW5jaG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYXV0aG9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYmF0Y2g6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY2hlY2s6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjbGVhcjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBjcmVhdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkZWxpdmVyYWJsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRlcHRoOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZGV0YWlsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJkb2MtZWRpdFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZmlsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZvcmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIC8vIHNlbmQgLS1ncm91bmQgaXMgcGFyc2VBcmdzLWBtdWx0aXBsZWAgQlkgU0VBTSAoQ29udHJhY3QgOSBSNDogcmVwZWF0c1xuICAvLyBhY2N1bXVsYXRlLCBjb21tYXMgc3BsaXQpIOKAlCBhbnkgdmVyYiBjb3B5aW5nIHRoZSBwYXR0ZXJuIGNvcGllcyB0aGlzIHRvby5cbiAgZ3JvdW5kOiB7IHR5cGU6IFwic3RyaW5nXCIsIG11bHRpcGxlOiB0cnVlIH0sXG4gIGluYm91bmQ6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1lc3NhZ2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBub2RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbm90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9uY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgb3duZXI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwb3J0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvamVjdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJvbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBydWxpbmc6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNrZWxldG9uOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHNwYW46IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzeW5vcHNpczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB1bmNoZWNrOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgeWVzOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHpvbmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxudHlwZSBPcHRzID0gdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFnID0ga2V5b2YgT3B0cyAmIHN0cmluZztcbi8qKiBUaGUgcGFyc2VkIHZhbHVlcywgdHlwZWQgb2ZmIHRoZSB0YWJsZTogYSBgbXVsdGlwbGVgIGZsYWcgaXMgYW4gYXJyYXksIGFcbiAqICBzdHJpbmcgZmxhZyBhIHN0cmluZywgYSBib29sZWFuIGZsYWcgYSBib29sZWFuLiAqL1xudHlwZSBGbGFncyA9IHtcbiAgLXJlYWRvbmx5IFtLIGluIEZsYWddPzogT3B0c1tLXSBleHRlbmRzIHsgbXVsdGlwbGU6IHRydWUgfVxuICAgID8gc3RyaW5nW11cbiAgICA6IE9wdHNbS11bXCJ0eXBlXCJdIGV4dGVuZHMgXCJzdHJpbmdcIlxuICAgICAgPyBzdHJpbmdcbiAgICAgIDogYm9vbGVhbjtcbn07XG4vKiogV2hhdCBldmVyeSBoYW5kbGVyIGJlbG93IHJlYWRzIOKAlCB0aGUgc2hhcGUgYHBhcnNlQXJnc2AgdXNlZCB0byBoYW5kIHRoZW0sXG4gKiAgc28gZWFjaCBib2R5IG1vdmVkIG9udG8gdGhlIHJlZ2lzdHJ5IHVuY2hhbmdlZC4gKi9cbnR5cGUgUGFyc2VkID0geyB2YWx1ZXM6IEZsYWdzOyBwb3NpdGlvbmFsczogc3RyaW5nW10gfTtcbmNvbnN0IG9uID1cbiAgKGg6IChwYXJzZWQ6IFBhcnNlZCkgPT4gdW5rbm93bikgPT5cbiAgKGludjogSW52b2NhdGlvbjxGbGFnPik6IHVua25vd24gPT5cbiAgICBoKHsgdmFsdWVzOiBpbnYuZmxhZ3MgYXMgRmxhZ3MsIHBvc2l0aW9uYWxzOiBpbnYucG9zIH0pO1xuXG4vKipcbiAqIGBhY3Rpdml0eSA8c3RhdGU+YCdzIGFjY2VwdGVkIHZhbHVlcyDigJQgdGhlIG9uZSBFTlVNRVJBVEVEIFBPU0lUSU9OQUwgaW4gdGhpc1xuICogQ0xJLCBhbmQgdGhlIG9uZSBjbG9zZWQgc2V0IHRoYXQgd2FzIG5vdCBhbHJlYWR5IHB1Ymxpc2hlZCBhcyBgY2hvaWNlc2AuXG4gKi9cbmV4cG9ydCBjb25zdCBBQ1RJVklUWV9TVEFURVMgPSBbXCJyZWNlaXZlZFwiLCBcInRoaW5raW5nXCIsIFwiaWRsZVwiXSBhcyBjb25zdDtcblxuY29uc3QgSEVMUCA9IGBtaW5kLW1hcHBlciDigJQgYSBjby1wcmVzZW50IGtub3dsZWRnZSBtYXA6IGEgZHVtYiBkYWVtb24gaG9sZHMgdGhlIGdyYXBoLCB0aGUgY2FzdGluZyBhZ2VudCBkb2VzIHRoZSB0aGlua2luZy5cblxuICBvcGVuICAgWy0tcHJvamVjdCA8aWQ+XSBbLS1wb3J0IDxuPl0gWy0tbm8tb3Blbl0gICBzcGF3biAob3IgZmluZCkgdGhlIGRhZW1vbiwgcHJpbnQgaXRzIHVybFxuICBzdGF0ZSAgWy0tc2tlbGV0b25dIFstLWJhdGNoIDxpZD5dICAgICAgICAgICAgICAgICB0aGUgcHJvamVjdCBzbmFwc2hvdCAoc2tlbGV0b24gPSBpZHMvdGl0bGVzL2RlZ3JlZSlcbiAgY2hhbmdlcyAtLXNpbmNlIDxlcG9jaFNlY29uZHM+ICAgICAgICAgICAgICAgICAgICAgYm91bmRlZCBkZWx0YSwgQURESVRJT05TIE9OTFkgKG5vdENvdmVyZWQgbmFtZXMgdGhlIHJlc3QpXG4gIHRhaWwgICBbLS1zaW5jZSBOXSBbLS1pbmJvdW5kXSBbLS1vbmNlXSAgICAgICAgICAgIFNTRSBldmVudHMgYXMgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yOyBzZWUgYmVsb3cpXG4gIHByb2plY3RzIFstLWNyZWF0ZSA8dGl0bGU+XSAgICAgICAgICAgICAgICAgICAgICAgIGxpc3QgcHJvamVjdHMgLyBjcmVhdGUgb25lXG4gIGluZ2VzdCAtLXRpdGxlIDx0PiAoLS1maWxlIDxwPiB8IC0tc3RkaW4pICAgICAgICAgIGFkZCBhIGRvY1xuICBwcm9wb3NlLW5vZGUgLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFnZSBhIG5vZGUgcHJvcG9zYWwgKEpTT04ge2RyYWZ0LCBldmlkZW5jZSwgLi4ufSlcbiAgcHJvcG9zZS1lZGdlIC0tc3RkaW4gWy0tem9uZSA8aWQ+XSAgICAgICAgICAgICAgICAgc3RhZ2UgYW4gZWRnZSBwcm9wb3NhbFxuICBwcm9wb3NlLWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzdGFnZSBhIHNldCBpbiBvbmUgdHhuICh7bm9kZXMsIGVkZ2VzfSlcbiAgcmF0aWZ5LWJhdGNoIC0tc3RkaW4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmF0aWZ5IGEgc2V0IGluIG9uZSB0eG4gKHtydWxpbmcsIGlkcywgYW5jaG9ycz99KVxuICBkZWxldGUtYmF0Y2ggLS1zdGRpbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWxldGUgYSBwcm9wb3NhbCBzZXQgaW4gb25lIHR4biAoe2lkc30sIGFsbC1vci1ub3RoaW5nKVxuICByYXRpZnkgPGlkPiAtLXJ1bGluZyA8cj4gWy0tZG9jLWVkaXQgPGZpbGU+XSBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHQ+XSBbLS1hbmNob3IgPHBhcmVudElkPl1cbiAgem9uZSAgIGNyZWF0ZSA8bmFtZT4gfCBsaXN0IHwgZGVsZXRlIDxpZD4gWy0teWVzXSAgc3RhZ2luZyBwZW5zIGZvciBwcm9wb3NhbHNcbiAgcHJvbW90ZSA8aWQ+ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbW92ZSBhIHpvbmVkIHByb3Bvc2FsIHRvIHRoZSBtYWluIHF1ZXVlXG4gIHByb3Bvc2FsIHpvbmUgPGlkPiAoLS10byA8ej4gfCAtLWNsZWFyKSB8IHByb3Bvc2FsIGRlbGV0ZSA8aWQ+XG4gIG5vZGUgICBhbmNob3IgPGlkPiAoLS10byA8cD4gfCAtLWNsZWFyKSB8IGVkaXQgPGlkPiBbLS10aXRsZS8tLXN5bm9wc2lzLy0tc3RkaW5dIHwgZGVsZXRlIDxpZD4gWy0tZm9yY2VdXG4gIGRvYyAgICA8aWQ+IHwgZGVsZXRlIDxpZD4gWy0tZm9yY2VdIHwga2luZCA8ZG9jSWQ+ICg8a2luZD4gWy0tYXV0aG9yIGFdIHwgLS1jbGVhcilcbiAgICAgICAgIGZsYWdzIG1heSBwcmVjZWRlIHRoZSBzdWItdmVyYiAoZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSA8aWQ+KTsgZG9jIC0tIDxpZD4gcmVhZHMgYSBkb2MgbmFtZWQgXCJkZWxldGVcIiBvciBcImtpbmRcIlxuICBtYXJrICAgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dICAgICAgICAgICBhcHBlbmQgYSBkb2Mgc3RhdHVzIG1hcmtcbiAgYWN0aW9ucyA8dGFyZ2V0SWQ+ICgtLXNldCA8anNvbj4gfCAtLXN0ZGluIHwgLS1jbGVhcikgICBhY3Rpb24gc2xvdHMgb24gYSBub2RlL3BlbmRpbmcgcHJvcG9zYWxcbiAgdGFncyAgIDx0YXJnZXRJZD4gKC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyKSAgICBmcmVlZm9ybSB0YWdzLCBzYW1lIHRhcmdldHNcbiAgam9iICAgIGNyZWF0ZXx1cGRhdGV8Y2xhaW18cmVsZWFzZXxzdWJ0YXNrfGxpc3R8ZGVsZXRlICBwZXJzaXN0ZWQgdW5pdHMgb2YgYWdlbnQgd29ya1xuICBzZWFyY2ggPHF1ZXJ5Li4uPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBGVFMgb3ZlciBub2RlcywgZG9jcywgbWVzc2FnZXNcbiAgbmVpZ2hib3JzIDxpZD4gWy0tZGVwdGggMV0gICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWwgaG9vZCArIGVkZ2UgcmVhc29uc1xuICBsZW5zICAgc2V0ICgtLW5vZGUgPGlkPiBbLS1kZXB0aCBuXSB8IC0tZG9jIDxpZD4pIHwgbGVucyBjbGVhclxuICBsb29rLWhlcmUgPG5vZGVJZD4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXG4gIHJlYWQgICA8bWVzc2FnZUlkPiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uZSBmdWxsIG1lc3NhZ2Ugcm93IChhbGlhczogbWVzc2FnZSA8aWQ+KVxuICBzZW5kICAgPHRleHQuLi4+IHwgLS1ib2R5LWZpbGUgPHA+IHwgLS1zdGRpbiAgICAgICBwb3N0IGEgbWVzc2FnZSAoWy0tcm9sZV0gWy0ta2luZF0gWy0tZ3JvdW5kXSlcbiAgYWN0aXZpdHkgPHJlY2VpdmVkfHRoaW5raW5nfGlkbGU+IFstLW1lc3NhZ2UgPGlkPl0gdGhlIGNhc3RpbmctbG9vcCBsaXZlbmVzcyBzaWduYWxcbiAgdmVyc2lvbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVxuICBzY2hlbWEgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGUgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcbiAgaGVscCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaClcblxuICAtLXByb2plY3QgPGlkPiBnb2VzIGFmdGVyIHRoZSB2ZXJiOyBldmVyeSB2ZXJiIHRoYXQgcmVhZHMgYSBtYXAgYWNjZXB0cyBpdCAocHJvamVjdHMsIGhlbHAsXG4gIHZlcnNpb24gYW5kIHNjaGVtYSBkbyBub3QpLiBPbWl0IGl0IGZvciB0aGUgZGVmYXVsdCBwcm9qZWN0LiBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgbGluZTogYSBmbGFnIG9uIHRoZSB3cm9uZyB2ZXJiIGlzXG4gIHJlZnVzZWQsIGFuZCB0aGUgcmVqZWN0aW9uIGxpc3RzIHRoYXQgdmVyYidzIG93biBmbGFncy5cblxuICBPdXRwdXQ6IGV2ZXJ5IHZlcmIgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlFxuICBleGNlcHQgdGFpbCwgYSBzdHJlYW0gdGhhdCBwcmludHMgb25lIEpTT04gbGluZSBwZXIgZXZlbnQsIGFuZCBoZWxwLCB3aGljaCBpc1xuICBwcm9zZS4gUHJvc2UsIHdhcm5pbmdzIGFuZFxuICBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnI7IGZhaWx1cmVzIGV4aXQgbm9uLXplcm8gKDIgPSB1c2FnZSkuXG5cbiAgS2VlcCB3YXRjaGluZyBwYXN0IE1vbml0b3IncyAzMC1taW51dGUgY2FwLiBBcm0gdGhlIHRhaWwgd2l0aCBNb25pdG9yIGF0XG4gIHRpbWVvdXRfbXM6IDE4MDAwMDAuIEl0IGVuZHMgaXRzZWxmIGp1c3QgYmVmb3JlIHRoZSBjYXAsIGFuZCBpdHMgbGFzdCBsaW5lXG4gICh0eXBlOiBcInRhaWwu4oCmXCIpIG5hbWVzIHlvdXIgbmV4dCBhY3QuIFRoYXQgbGluZSdzIGNvbW1hbmQgaXMgdGhlIHZlcmIgYW5kIGl0c1xuICBhcmd1bWVudHMgb25seSwgYm9va21hcmsgKC0tc2luY2UpIGluY2x1ZGVkLCB3aXRoIG5vIGxhdW5jaGVyIGFuZCBubyBwYXRoLlxuICBBbHdheXMgcnVuIGl0IHdpdGggdGhpcyBza2lsbCdzIG93biBsYXVuY2hlciwgdGhlIG9uZSB5b3UgdXNlIGZvciBpdHMgb3RoZXJcbiAgdmVyYnM6IGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+LiBBIGNvbW1hbmQgb2ZcbiAgdGFpbCAtLXNpbmNlIDEyIHJ1bnMgYXMgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyB0YWlsIC0tc2luY2UgMTIuXG4gIE5ldmVyIHJldXNlIGEgbGF1bmNoZXIgcGF0aCBmcm9tIGFuIGVhcmxpZXIgbGluZSBvciBzZXNzaW9uOiB0aGUgcGx1Z2luJ3NcbiAgZGlyZWN0b3J5IGNoYW5nZXMgd2hlbiBpdCB1cGRhdGVzLiBEbyB3aGF0IG5leHQgc2F5czpcblxuICAtIG1vbml0b3I6IGFybSBNb25pdG9yIGFnYWluIHdpdGggdGhlIGxhdW5jaGVyIGFuZCBjb21tYW5kLlxuICAtIGJhY2tncm91bmQ6IG5vdGhpbmcgaGFwcGVuZWQ7IHRoZSBodW1hbiBpcyBhd2F5LiBSdW4gdGhlIGxhdW5jaGVyIGFuZFxuICAgIGNvbW1hbmQgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpLiBJdCBleGl0cyBvbiB0aGVcbiAgICBuZXh0IGV2ZW50LCB3aGljaCB3YWtlcyB5b3UuIEhhbmRsZSB0aGUgZXZlbnQsIHRoZW4gZm9sbG93IGl0cyBsaW5lIGJhY2sgdG9cbiAgICBNb25pdG9yLlxuICAtIHN0b3A6IHRoZSBzZXNzaW9uIGNsb3NlZCBvciBpdHMgZGFlbW9uIGlzIGdvbmUuIERvIG5vdCByZS1hcm07IHRoZSBsYXVuY2hlclxuICAgIGFuZCBjb21tYW5kIGJyaW5nIGl0IGJhY2suIElmIHlvdSBydW4gaXQsIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vXG4gICAgLS1zaW5jZSAoYW5kIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cywgd2hlcmUgdGhlcmUgaXMgb25lKTogYSByZXN0YXJ0ZWRcbiAgICBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZy5cblxuICBJZiBNb25pdG9yIGV4cGlyZXMgYmVmb3JlIHRoYXQgbGluZSBhcnJpdmVzLCByZS1hcm0gc2lsZW50bHkgd2l0aFxuICAtLXNpbmNlIDx0aGUgbGFzdCBpZCB5b3Ugc2F3Piwgd3JpdHRlbiA8aWQ+QDxpdHMgZXBvY2g+IHdoZW4gZXZlbnRzIGNhcnJ5IGFuXG4gIGVwb2NoLiBOZXZlciByZS1hcm0gd2l0aG91dCAtLXNpbmNlOiB0aGF0IHJlcGxheXMgZXZlbnRzIHlvdSBoYXZlIGFscmVhZHlcbiAgaGFuZGxlZC4gSWYgdGhlIGxhdW5jaGVyIHJlZnVzZXMgYSBjb21tYW5kIHdpdGggYSB1c2FnZSBlcnJvciwgaXRzIG1lc3NhZ2VcbiAgbmFtZXMgdGhlIGZvcm1zIGl0IGFjY2VwdHM7IGZpeCB0aGUgYXJndW1lbnRzIHRvIG1hdGNoLlxuICB0YWlsICR7V0lORE9XX0hFTFB9LmA7XG5cbi8vIFRoZSBwbHVnaW4gbWFuaWZlc3QgaXMgdGhlIG9uZSB2ZXJzaW9uIHNvdXJjZTsgdGhlIENMSSByZWFkcyBpdCByYXRoZXIgdGhhblxuLy8gbWlycm9yaW5nIHRoZSBudW1iZXIgKGFzdHJvbGFiZSdzIHBhdHRlcm4pLiBMYXlvdXQtZGVwZW5kZW50LCBzbyBhYnNlbmNlXG4vLyBkZWdyYWRlcyB0byBcInVua25vd25cIiBpbnN0ZWFkIG9mIGludmVudGluZyBvbmUuXG5mdW5jdGlvbiB2ZXJzaW9uSW5mbygpOiB7IG5hbWU6IHN0cmluZzsgdmVyc2lvbjogc3RyaW5nIH0ge1xuICB0cnkge1xuICAgIGNvbnN0IHJhdyA9IHJlYWRGaWxlU3luYyhcbiAgICAgIGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpLFxuICAgICAgXCJ1dGY4XCIsXG4gICAgKTtcbiAgICBjb25zdCBwa2cgPSBKU09OLnBhcnNlKHJhdykgYXMgeyB2ZXJzaW9uPzogdW5rbm93biB9O1xuICAgIGlmICh0eXBlb2YgcGtnLnZlcnNpb24gPT09IFwic3RyaW5nXCIpIHJldHVybiB7IG5hbWU6IFwibWluZC1tYXBwZXJcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoIHRvIHVua25vd24gKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcIm1pbmQtbWFwcGVyXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8vIOKUgOKUgCB0aGUgaGFuZGxlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gT25lIHBlciBjb21tYW5kIHBhdGguIFRoZSByZWdpc3RyeSBoYXMgYWxyZWFkeSByZWZ1c2VkIGFuIHVua25vd24gb3Jcbi8vIG1pc3BsYWNlZCBmbGFnIGFuZCBlbmZvcmNlZCB0aGUgZGVjbGFyZWQgYXJpdHkgYmVmb3JlIGFueSBvZiB0aGVzZSBydW5zLCBzb1xuLy8gYSByZXF1aXJlZCBwb3NpdGlvbmFsIGlzIGFsd2F5cyBwcmVzZW50IGhlcmUuXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBwb3J0ID0gYXdhaXQgZW5zdXJlRGFlbW9uKHBhcnNlZC52YWx1ZXMucG9ydCk7XG4gIC8vIC0tcHJvamVjdCBzY29wZXMgdGhlIHByaW50ZWQgVVJMICsgc3Bhd25lZCBicm93c2VyICg/cHJvamVjdD0gcmlkZXNcbiAgLy8gYWxvbmcpLiBPcGVuIG5ldmVyIG1pbnRzOiBhbiB1bmtub3duIGlkIGlzIGEgdXNhZ2UgZXJyb3IgcG9pbnRpbmcgYXRcbiAgLy8gYHByb2plY3RzIC0tY3JlYXRlYCwgbm90IGEgc2lsZW50IG5ldyBzdG9yZS5cbiAgY29uc3QgcHJvamVjdCA9IHBhcnNlZC52YWx1ZXMucHJvamVjdDtcbiAgaWYgKHByb2plY3QgIT09IHVuZGVmaW5lZCkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvamVjdHNgKTtcbiAgICBjb25zdCBib2R5ID0gKGF3YWl0IHJlcy5qc29uKCkpIGFzIHsgcHJvamVjdHM6IEFycmF5PHsgaWQ6IHN0cmluZyB9PiB9O1xuICAgIGlmICghYm9keS5wcm9qZWN0cy5zb21lKChwKSA9PiBwLmlkID09PSBwcm9qZWN0KSkge1xuICAgICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICAgYHVua25vd24gcHJvamVjdDogJHtwcm9qZWN0fSAob3BlbiBuZXZlciBjcmVhdGVzIG9uZSDigJQgdXNlIFxcYHByb2plY3RzIC0tY3JlYXRlIDx0aXRsZT5cXGAgZmlyc3QpYCxcbiAgICAgICAgeyBjaG9pY2VzOiBib2R5LnByb2plY3RzLm1hcCgocCkgPT4gcC5pZCkgfSxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGNvbnN0IHVybCA9IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3Byb2plY3QgPyBgLz9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHByb2plY3QpfWAgOiBcIlwifWA7XG4gIGlmICghcGFyc2VkLnZhbHVlc1tcIm5vLW9wZW5cIl0pIG9wZW5Ccm93c2VyKHVybCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KHsgb2s6IHRydWUsIHVybCB9KX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcygpO1xuICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICBpZiAocGFyc2VkLnZhbHVlcy5iYXRjaCkgcGFyYW1zLnNldChcImJhdGNoXCIsIHBhcnNlZC52YWx1ZXMuYmF0Y2gpO1xuICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vc3RhdGUke3FzfWApO1xuICAvLyBBIG5vbi1vayAvc3RhdGUgKDQwOSBuZWVkcy1wcm9qZWN0IG9uIGEgZnJlc2ggc3RvcmUsIDQwNCB1bmtub3duXG4gIC8vIHByb2plY3QpIHJpZGVzIHRoZSBlcnJvciBlbnZlbG9wZSB3aXRoIHRoZSBkYWVtb24gYm9keSB1bmRlclxuICAvLyBlcnJvci5zZXJ2ZXIg4oCUIHRoZSBza2VsZXRvbiB0cmFuc2Zvcm0gb25seSBydW5zIG9uIGEgcmVhbCBzbmFwc2hvdC5cbiAgY29uc3Qgc3RhdGVUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc2tlbGV0b24pIHtcbiAgICBjb25zdCBzdGF0ZSA9IEpTT04ucGFyc2Uoc3RhdGVUZXh0KSBhcyBQYXJhbWV0ZXJzPHR5cGVvZiB0b1NrZWxldG9uPlswXTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh0b1NrZWxldG9uKHN0YXRlKSl9XFxuYCk7XG4gIH0gZWxzZSB7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7c3RhdGVUZXh0fVxcbmApO1xuICB9XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCAxMiAoU0VBTSAzKTogYGNoYW5nZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPmAg4oCUIHRoZSBib3VuZGVkIGRlbHRhLlxuLy8gUmVhZCB0aGUgcmVzcG9uc2UncyBub3RDb3ZlcmVkIGJlZm9yZSB0cnVzdGluZyBhbiBlbXB0eSBvbmU6IFwibm90aGluZ1xuLy8gYWRkZWRcIiBpcyBOT1QgXCJub3RoaW5nIGNoYW5nZWRcIiAoZGVsZXRpb25zLCByZWplY3Rpb25zIGFuZCBpbi1wbGFjZSBlZGl0c1xuLy8gYXJlIGludmlzaWJsZSBoZXJlIGJ5IGNvbnN0cnVjdGlvbikuXG5hc3luYyBmdW5jdGlvbiBjbWRDaGFuZ2VzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc2luY2UgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcImNoYW5nZXMgcmVxdWlyZXMgLS1zaW5jZSA8ZXBvY2hTZWNvbmRzPiAodXNlIDAgZm9yIGV2ZXJ5dGhpbmcsIHRoZW4gcGFzcyBiYWNrIHRoZSBgbm93YCBmcm9tIHRoZSBwcmV2aW91cyByZXNwb25zZSlcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogXCJBRERJVElPTlMgT05MWSDigJQgdGhlIHJlc3BvbnNlJ3Mgbm90Q292ZXJlZCBuYW1lcyB3aGF0IGl0IGNhbm5vdCBzZWU7IGEgZnVsbCBgc3RhdGVgIHJlYWQgaXMgc3RpbGwgdGhlIG9ubHkgd2F5IHRvIHJlY29uY2lsZSBkZWxldGlvbnMsIHJlamVjdGlvbnMgYW5kIGluLXBsYWNlIGVkaXRzXCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcGFyYW1zID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7IHNpbmNlOiBwYXJzZWQudmFsdWVzLnNpbmNlIH0pO1xuICBpZiAocGFyc2VkLnZhbHVlcy5wcm9qZWN0KSBwYXJhbXMuc2V0KFwicHJvamVjdFwiLCBwYXJzZWQudmFsdWVzLnByb2plY3QpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2NoYW5nZXM/JHtwYXJhbXN9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaW5ib3VuZCA9IHBhcnNlZC52YWx1ZXMuaW5ib3VuZCA9PT0gdHJ1ZTtcbiAgY29uc3Qgb25jZSA9IHBhcnNlZC52YWx1ZXMub25jZSA9PT0gdHJ1ZTtcbiAgLy8gQSBib29rbWFyaywgYE5gIG9yIGBOQDxlcG9jaD5gIGFzIHRoZSBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0XG4gIC8vIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBEMikuIEEgZm9ybSBpdCBkb2VzIG5vdCBhY2NlcHQgaXMgcmVmdXNlZCB3aXRoXG4gIC8vIHRoZSBhY2NlcHRlZCBmb3JtcyBuYW1lZCDigJQgcmVhZCBCRUZPUkUgdGhlIGRhZW1vbiBjaGVjaywgc28gdGhlIGFuc3dlclxuICAvLyBkb2VzIG5vdCBkZXBlbmQgb24gd2hldGhlciBvbmUgaXMgdXAuXG4gIGNvbnN0IHJlYWQgPVxuICAgIHR5cGVvZiBwYXJzZWQudmFsdWVzLnNpbmNlID09PSBcInN0cmluZ1wiXG4gICAgICA/IHJlYWRTaW5jZShwYXJzZWQudmFsdWVzLnNpbmNlLCB7IGVwb2NoOiB0cnVlIH0pXG4gICAgICA6IG51bGw7XG4gIGlmIChyZWFkICE9PSBudWxsICYmICFyZWFkLm9rKSB0aHJvdyB1c2FnZUVycm9yKHJlYWQubWVzc2FnZSk7XG4gIGNvbnN0IG1hcmsgPSByZWFkPy5vayA/IHJlYWQgOiBudWxsO1xuICBjb25zdCBzaW5jZSA9IG1hcms/LnNpbmNlID8/IE51bWJlci5OYU47XG4gIHJlcXVpcmVEYWVtb24oKTsgLy8gbm8gZGFlbW9uIGF0IHN0YXJ0IGlzIGEgdXNhZ2UgZXJyb3I7IG1pZC10YWlsIGRlYXRoIGlzIHNlbGYtaGVhbGVkIGJlbG93XG4gIC8vIEEgYC0tc2luY2VgIHJlLWFybSBwcmludHMgbm8gZ3JvdW5kaW5nIChga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBBMykuXG4gIGNvbnN0IHNpbmNlR2l2ZW4gPSBwYXJzZWQudmFsdWVzLnNpbmNlICE9PSB1bmRlZmluZWQ7XG4gIC8vIFRoZSBzZXJ2ZXIgKHJlLSllbWl0cyBhIGdyb3VuZGluZyBmcmFtZSBhdCB0aGUgdG9wIG9mIEVWRVJZIGluYm91bmQgU1NFXG4gIC8vIGNvbm5lY3Q7IGZvcndhcmQgb25seSB0aGUgRklSU1Qgc28gdGhlIGFnZW50J3MgTW9uaXRvciBzZWVzIGV4YWN0bHkgb25lXG4gIC8vIGdyb3VuZGluZyBsaW5lLCBub3Qgb25lIHBlciByZWNvbm5lY3QgKEY1OiBmaXJzdC1jb25uZWN0IGxpbmUpLlxuICAvL1xuICAvLyDim5QgVEhFIFNVUFBSRVNTSU9OJ1MgU1RBVEUgTElWRVMgSU4gVEhJUyBDTE9TVVJFLCBPVVRTSURFIFRIRSBUSElORyBUSEFUXG4gIC8vIE9XTlMgVEhFIFJFQ09OTkVDVFMsIEFORCBUSEFUIElTIFRIRSBPTkUgSE9ORVNUIEdBUCBJTiBUSElTIEFET1BUSU9OLlxuICAvLyBgcmVuZGVyYCBpcyBhIGNhbGxlci13cml0dGVuIGNsb3N1cmUsIHNvIGBncm91bmRlZGAgc3Vydml2ZXMgdGhlXG4gIC8vIHJlY29ubmVjdHMgYHRhaWxFdmVudHNgIHBlcmZvcm1zIOKAlCB3aGljaCBpcyBleGFjdGx5IHdoeSBpdCBXT1JLUywgYW5kIGFsc29cbiAgLy8gd2h5IG5vdGhpbmcgaW4gdGhlIGtpdCBndWFyYW50ZWVzIGl0OiB0aGVyZSBpcyBubyBkZWRpY2F0ZWRcbiAgLy8gZmlyc3QtZnJhbWUtb25jZSBhZmZvcmRhbmNlIGFuZCBubyB3b3JrZWQgZXhhbXBsZSBvZiBvbmUsIGFuZCBhIGZ1dHVyZVxuICAvLyBjaGFuZ2UgdG8gd2hlbiBgdGFpbEV2ZW50c2AgcmUtaW52b2tlcyBpdHMgaG9va3Mgd291bGQgbW92ZSB0aGlzXG4gIC8vIGJlaGF2aW91ciB3aXRob3V0IHRvdWNoaW5nIHRoaXMgZmlsZS4gVGhlIGFsdGVybmF0aXZlIHdhcyBhc2tpbmcgdGhlIGtpdFxuICAvLyBmb3IgYSBgZmlyc3RGcmFtZU9uY2VgIG9wdGlvbiwgd2hpY2ggaXMgYSB3aWRlbmluZyBmb3IgYSBjbG9zdXJlIHRoZVxuICAvLyBjYWxsZXIgY2FuIHdyaXRlIGluIHRocmVlIGxpbmVzIChEODIncyBub3QtdGFrZW4pLlxuICBsZXQgZ3JvdW5kZWQgPSBzaW5jZUdpdmVuO1xuXG4gIC8vIOKblCBPTkUgQ0FMTCBJTlRPIFRIRSBIT1VTRSdTIFNIQVJFRCBUQUlMIENMSUVOVFxuICAvLyAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIFJFUExBQ0lORyBBIEhBTkQtUk9MTEVEXG4gIC8vIFRIUkVFLUxFVkVMIExPT1Ag4oCUIGFuZCBtaW5kLW1hcHBlciBpcyB0aGUgc3BlbGwgdGhhdCBtb2R1bGUncyBvd25cbiAgLy8gY29uc3RhbnQtYmFja29mZiB3YXJuaW5nIHdhcyB3cml0dGVuIGFib3V0OiB0aGUgbG9vcCBiZWxvdyB1c2VkIHRvIHNsZWVwXG4gIC8vIGByZXRyeU1zYCBhZnRlciBFVkVSWSBmYWlsZWQgYXR0ZW1wdCwgZmxhdCwgZm9yZXZlciwgd2hpY2ggaXMgYVxuICAvLyByZWNvbm5lY3Qgc3Rvcm0gcmF0aGVyIHRoYW4gYSBiYWNrb2ZmLiBXaGF0IHRoZSBzd2FwIGNsb3NlcyBoZXJlLCBub25lIG9mXG4gIC8vIGl0IGJ5IGFueW9uZSBlZGl0aW5nIGl0OlxuICAvL1xuICAvLyAgIMK3IEJBQ0tPRkYuIDEsMDAwIG1zIGZsYXQgYmVjb21lcyAxLDAwMCDCtyAyLDAwMCDCtyA0LDAwMCDCtyA1LDAwMCDCtyA1LDAwMCxcbiAgLy8gICAgIHJlc2V0IG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBEcml2ZW4gb24gZ2xhbW91ciBiZWZvcmUgYW5kIGFmdGVyXG4gIC8vICAgICBhZ2FpbnN0IGEgc2VydmVyIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgZHJvcHM6IDUxIGF0dGVtcHRzIGluXG4gIC8vICAgICAxNCBzIGF0IGEgZmxhdCB+MjUyIG1zIGJlY2FtZSA2IGF0dGVtcHRzIGF0IDI1MiDCtyA1MDMgwrcgMTAwMSDCtyAyMDAyIMK3XG4gIC8vICAgICA0MDAyLlxuICAvLyAgIMK3IFRIRSBTUEVDLiBUaGUgaGFuZC1yb2xsZWQgZnJhbWUgcGFyc2VyIG1hdGNoZWQgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgXG4gIC8vICAgICBhbmQga2VwdCBvbmx5IHRoZSBGSVJTVCBkYXRhIGxpbmUsIHNvIGEgc3BlYy1sZWdhbCBgZGF0YTp7Li4ufWAgd2FzXG4gIC8vICAgICBzaWxlbnRseSBEUk9QUEVEICoqYW5kIHRoZSBjdXJzb3IgZGlkIG5vdCBhZHZhbmNlKiog4oCUIGEgZnJhbWUgbm9ib2R5XG4gIC8vICAgICBjYW4gcmVhZCBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGUgZGFlbW9uJ3MgbGlmZS5cbiAgLy8gICAgIFRoZSBraXQgc3BsaXRzIGF0IHRoZSBmaXJzdCBjb2xvbiBhbmQgc3RyaXBzIGF0IG1vc3Qgb25lIHNwYWNlLCBwZXJcbiAgLy8gICAgIFdIQVRXRywgd2hpY2ggaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGggZXZlcnkgaG91c2VcbiAgLy8gICAgIGRhZW1vbi5cbiAgLy8gICDCtyBUSEUgU0lHTkFMIEhBTkRMRVJTLiBUaGVyZSB3ZXJlIG5vbmUuIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhXG4gIC8vICAgICByZWFkZXIgbm93IGVuZHMgdGhlIHdhdGNoIGJ5IFJFVFVSTklORywgc28gdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dFxuICAvLyAgICAgZmlyc3Qg4oCUIHRoZSBoYWxmIG9mIHRoZSBQMGYgZHJhaW4gZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gIC8vICAgwrcgVEhFIEVYSVQgQ09ERSBDUk9TU0VTIFRIRSBMT09QUy4gVGhlIGNsaWVudCBSRVRVUk5TIGEgY29kZSBpbnN0ZWFkIG9mXG4gIC8vICAgICBlbmRpbmcgdGhlIHByb2Nlc3MgZnJvbSBpbnNpZGUgdGhyZWUgbmVzdGVkIGxvb3BzLCB3aGljaCBpcyB3aGF0XG4gIC8vICAgICByZXRpcmVzIHRoZSBwZXItc2l0ZSBxdWVzdGlvbiBvZiB3aGV0aGVyIGEgYHJldHVybmAgZXNjYXBlcyB0aGVtIGFsbC5cbiAgLy9cbiAgLy8g4pqgIEFORCBgaWRsZU1zYC9gcmV0cnlgIEFSRSBERVJJVkVELCBOT1QgQ09QSUVEIChCOCdzIG9uZSB1bmNvcHlhYmxlIHJ1bGUpLlxuICAvLyBUaGV5IGNvbWUgZnJvbSBgLi9oZWFydGJlYXQudHNgLCB0aGUgc2VhbSBmaWxlIGJvdGggaGFsdmVzIGltcG9ydCwgd2hlcmVcbiAgLy8gdGhlIHdhdGNoZG9nIGlzIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCDigJQgdGhyZWUgb2YgVEhJUyBkYWVtb24nc1xuICAvLyBiZWF0cywgd2hhdGV2ZXIgdGhlIGJlYXQgYmVjb21lcyDigJQgYW5kIHdoZXJlIHRoZSB0d28gZW52IGtub2JzIHRoaXNcbiAgLy8gc3BlbGwncyBvd24gdGFpbCBzdWl0ZSBkcml2ZXMgYXJlIHJlc29sdmVkIChENzUpLiBUaGUgbnVtYmVyIGlzIDQ1LDAwMCBhdFxuICAvLyB0aGUgZGVmYXVsdCwgd2hpY2ggaXMgd2hhdCB0aGlzIGZpbGUgaGFyZC1jb2RlZDsgdGhlIEVYUFJFU1NJT04gaXMgd2hhdFxuICAvLyBjaGFuZ2VkLlxuICAvL1xuICAvLyDim5QgQU5EIFRIRSBRVUlFVCBIQU5ET0ZGLCBMSUtFIFRIRSBTRVNTSU9OIFNQRUxMUyAoQ29sZSdzIHJ1bGluZyxcbiAgLy8gMjAyNi0wOS0yNDsgYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCwgXCJNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTlxuICAvLyBTUEVMTFNcIikuIEEgcXVpZXQgd2luZG93IG5hbWVzIGEgYmFja2dyb3VuZCBgLS1vbmNlYDsgYSB3b2tlbiBvbmUtc2hvdFxuICAvLyBuYW1lcyBNb25pdG9yOyBhIGRhZW1vbiB0aGF0IGRpZWQgbmFtZXMgYG9wZW4gLS1uby1vcGVuYC4gVGhlIHRhaWwnc1xuICAvLyBzdG9wLXN0YXJ0IGlzIHdoYXQgdGhlIGRhZW1vbidzIHByZXNlbmNlIExJTkdFUiAoYHNlcnZlci50c2AsXG4gIC8vIGBhZGp1c3RBZ2VudHNgKSBleGlzdHMgdG8gaGlkZSBmcm9tIHRoZSBodW1hbi5cbiAgLy9cbiAgLy8g4pqgIFRIRSBMQVNUIFVSTCBJUyBLRVBULCBzbyBhIGRlYWQgZGFlbW9uIGlzIExPU1QgcmF0aGVyIHRoYW4gdW5yZXNvbHZlZC5cbiAgLy8gYGxpdmVQb3J0KClgIGFuc3dlcnMgbnVsbCBvbmNlIHRoZSBkYWVtb24ncyBwaWQgaXMgZGVhZCwgYW5kIGFuXG4gIC8vIHVucmVzb2x2ZWQgdGFpbCByZXRyaWVzIGZvcmV2ZXIg4oCUIGEgYC0tb25jZWAgd291bGQgc2xlZXAgZm9yIGdvb2QgYW5kIGFcbiAgLy8gTW9uaXRvciB3YXRjaCB3b3VsZCBuZXZlciBoZWFyIGl0LiBBc2tpbmcgdGhlIGxhc3QgcG9ydCBpbnN0ZWFkIGdldHNcbiAgLy8gcmVmdXNlZCwgYW5kIHRoZSBraXQncyBsb3N0IHJ1bGUgZW5kcyB0aGUgdGFpbCB3aXRoIHRoZSB3YXkgYmFjay4gQSBsaXZlXG4gIC8vIGRhZW1vbiBvbiBhIE5FVyBwb3J0IChzb21lb25lIHJhbiBgb3BlbmAgYWdhaW4pIGlzIHN0aWxsIGZvdW5kIGZpcnN0LlxuICBsZXQgbGFzdFVybDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIHJldHVybiBhd2FpdCB0YWlsV2l0aEhhbmRvZmY8eyBpZD86IHVua25vd247IGVwb2NoPzogdW5rbm93bjsga2luZD86IHVua25vd24gfT4oXG4gICAge1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBwb3J0ID0gbGl2ZVBvcnQoKTtcbiAgICAgICAgaWYgKHBvcnQgIT09IG51bGwpIGxhc3RVcmwgPSBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9YDtcbiAgICAgICAgcmV0dXJuIGxhc3RVcmw7XG4gICAgICB9LFxuICAgICAgcGF0aDogXCIvZXZlbnRzXCIsXG4gICAgICBzaW5jZTogTnVtYmVyLmlzRmluaXRlKHNpbmNlKSA/IHNpbmNlIDogMCxcbiAgICAgIC4uLihtYXJrPy5lcG9jaCA/IHsgc2luY2VFcG9jaDogbWFyay5lcG9jaCB9IDoge30pLFxuICAgICAgcXVlcnk6IChjdXJzb3IpID0+ICh7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgICAgLi4uKHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IHsgcHJvamVjdDogcGFyc2VkLnZhbHVlcy5wcm9qZWN0IGFzIHN0cmluZyB9IDoge30pLFxuICAgICAgICAuLi4oaW5ib3VuZCA/IHsgaW5ib3VuZDogXCIxXCIgfSA6IHt9KSxcbiAgICAgIH0pLFxuICAgICAgLy8g4puUIGBpZGAsIE5PVCBgc2VxYCDigJQgdGhlIGRhZW1vbidzIGVudmVsb3BlIGZpZWxkIHdhcyByZW5hbWVkIGJ5IHRoZVxuICAgICAgLy8gYGNyZWF0ZUV2ZW50TG9nYCBhZG9wdGlvbiAoRDgxKSwgYW5kIHRoaXMgaXMgdGhlIENMSS1zaWRlIHJlYWRlciBvZiBpdC5cbiAgICAgIC8vIOKaoCBUaGUgQ0xJIGhhbGYgRk9SQ0VEIG5vdGhpbmc6IGBjdXJzb3JPZmAgaXMgY2FsbGVyLXN1cHBsaWVkLCBzb1xuICAgICAgLy8gYChldikgPT4gZXYuc2VxYCB3b3VsZCBoYXZlIGNvbXBpbGVkIGFuZCBydW4uIEl0IHdvdWxkIGFsc28gaGF2ZSByZWFkIGFcbiAgICAgIC8vIGZpZWxkIHRoZSBkYWVtb24gbm8gbG9uZ2VyIGVtaXRzLCBzbyB0aGUgY3Vyc29yIHdvdWxkIG5ldmVyIGFkdmFuY2UgYW5kXG4gICAgICAvLyBldmVyeSByZWNvbm5lY3Qgd291bGQgcmUtcmVxdWVzdCBgc2luY2U9MGAg4oCUIHRoZSB3aG9sZSByZXBsYXkgd2luZG93XG4gICAgICAvLyBpbnRvIGFuIGFnZW50J3MgcGlwZSwgc2lsZW50bHksIGZvcmV2ZXIuICoqQSBjYWxsZXItc3VwcGxpZWQgYWNjZXNzb3IgaXNcbiAgICAgIC8vIHdoZXJlIGEgd2lyZSByZW5hbWUgZ29lcyB3cm9uZyBxdWlldGx5LioqXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiID8gZXYuaWQgOiB1bmRlZmluZWQpLFxuICAgICAgZXBvY2hPZjogKGV2KSA9PiAodHlwZW9mIGV2LmVwb2NoID09PSBcInN0cmluZ1wiID8gZXYuZXBvY2ggOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSByZWNvbm5lY3QgdGhhdCBsYW5kcyBvbiBhIGRpZmZlcmVudCBlcG9jaCBtZWFucyB0aGUgZGFlbW9uIHJlc3RhcnRlZDpcbiAgICAgIC8vIHRoZSBraXQgcmVzZXRzIHRoZSBjdXJzb3IgdG8gMCBhbmQgdGhpcyBsaW5lIHRlbGxzIHRoZSBjYXN0aW5nIGFnZW50IHRvXG4gICAgICAvLyByZWZldGNoIHN0YXRlLiBDTEktc3ludGhlc2l6ZWQgb25seSwgbmV2ZXIgYSBidXMgZXZlbnQgKHRoZSBicm93c2VyIFdTXG4gICAgICAvLyBuZXZlciBzZWVzIGl0KSwgYW5kIGl0IGNhcnJpZXMgbm8gYGlkYCDigJQgc28gaXQgbmV2ZXIgYWR2YW5jZXMgdGhlXG4gICAgICAvLyBjdXJzb3IsIHdoaWNoIGlzIHRoZSBzYW1lIHNlcGFyYXRpb24gdGhlIGdyb3VuZGluZyBsaW5lIG1ha2VzLlxuICAgICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IGtpbmQ6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICAgIC8vIEdyb3VuZGluZyBpcyBhIHN5bnRoZXRpYywgaWQtbGVzcyBmaXJzdC1jb25uZWN0IGZyYW1lOiBmb3J3YXJkIHRoZVxuICAgICAgLy8gZmlyc3QsIHN1cHByZXNzIHJlLWdyb3VuZGluZ3Mgb24gcmVjb25uZWN0IChleGFjdGx5IG9uZSBwZXIgcHJvY2VzcykuXG4gICAgICAvLyBSZXR1cm5pbmcgbnVsbCB3cml0ZXMgbm90aGluZzsgaXQgbmV2ZXIgY2FycmllcyBpZC9lcG9jaCwgc28gdGhlXG4gICAgICAvLyBjdXJzb3IgYW5kIHRoZSBlcG9jaCBhcmUgdW50b3VjaGVkIGVpdGhlciB3YXkuXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgaWYgKGV2LmtpbmQgPT09IFwiZ3JvdW5kaW5nXCIpIHtcbiAgICAgICAgICBpZiAoZ3JvdW5kZWQpIHJldHVybiBudWxsO1xuICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZnJhbWUuZGF0YTtcbiAgICAgIH0sXG4gICAgICAvLyBBIHJlZnVzZWQgY29ubmVjdGlvbiAoNDA5IG5lZWRzLXByb2plY3Qgb24gYSBwcm9qZWN0bGVzcyBzdG9yZSwgNDA0XG4gICAgICAvLyB1bmtub3duIHByb2plY3QpIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIHRyYW5zcG9ydCBibGlwIOKAlCByZXRyeWluZyBpdFxuICAgICAgLy8gZm9yZXZlciB3b3VsZCBqdXN0IHNwaW4gc2lsZW50bHkuIGBwYXNzT3JUaHJvd2AgYWx3YXlzIHRocm93cyBoZXJlLCBhbmRcbiAgICAgIC8vIHRoZSB0aHJvdyBwcm9wYWdhdGVzIG91dCBvZiB0aGUgY2xpZW50IGludG8gYG1haW5gJ3MgY2F0Y2gsIHdoaWNoIGlzXG4gICAgICAvLyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIHJhaXNlIHJlYWNoYWJsZSBmcm9tIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLlxuICAgICAgLy8gQW5ub3RhdGVkOiBhbiBhc3luYyBhcnJvdydzIGByZXR1cm4gXCJyZXRyeVwiYCB3aWRlbnMgdG8gYFByb21pc2U8c3RyaW5nPmBcbiAgICAgIC8vIHVubGVzcyB0aGUgcmV0dXJuIHR5cGUgaXMgc3RhdGVkLCBhbmQgdGhlIGNsaWVudCBhY2NlcHRzIG9ubHkgdGhlXG4gICAgICAvLyBsaXRlcmFsICh0eXBlLWRlYnQgVDM2KS5cbiAgICAgIG9uSHR0cEVycm9yOiBhc3luYyAocmVzKTogUHJvbWlzZTxcInJldHJ5XCI+ID0+IHtcbiAgICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDQwOSB8fCByZXMuc3RhdHVzID09PSA0MDQpIGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gICAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgICB9LFxuICAgICAgLy8g4puUIFRIRSBVTlBBUlNFQUJMRSBMSU5FIEdPRVMgVE8gU1RET1VULCBXSElDSCBJUyBUSElTIFNQRUxMJ1MgT1dOXG4gICAgICAvLyBCRUhBVklPVVIgQU5EIFRIRSBPTkUgVEhFIEtJVCdTIERFRkFVTFQgV09VTEQgSEFWRSBDSEFOR0VELiBUaGVcbiAgICAgIC8vIGhhbmQtcm9sbGVkIGxvb3AgY2F1Z2h0IHRoZSBgSlNPTi5wYXJzZWAgYW5kIHBhc3NlZCB0aGUgcmF3IGxpbmVcbiAgICAgIC8vIHRocm91Z2ggdW50cmFja2VkOyB0aGUga2l0J3MgYG9uTWFsZm9ybWVkYCByZXR1cm4gdmFsdWUgZ29lcyB0byBgZXJyYFxuICAgICAgLy8gaW5zdGVhZCwgYmVjYXVzZSBhIGRpYWdub3N0aWMgYWJvdXQgdGhlIHN0cmVhbSBpcyBub3QgZGF0YS4gbWluZC1tYXBwZXJcbiAgICAgIC8vIGlzIHRoZSBcIm9uZSBzcGVsbFwiIHRoYXQgbW9kdWxlJ3MgaGVhZGVyIG5hbWVzIGFzIGdlbnVpbmVseSB3YW50aW5nIGl0IG9uXG4gICAgICAvLyBzdGRvdXQsIGFuZCB0aGUgd2F5IHRvIGtlZXAgdGhhdCBpcyB0byB3cml0ZSBpdCBmcm9tIGluc2lkZSB0aGUgaG9vayBhbmRcbiAgICAgIC8vIHJldHVybiBudWxsLlxuICAgICAgb25NYWxmb3JtZWQ6IChmcmFtZSkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtmcmFtZS5kYXRhfVxcbmApO1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH0sXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICAgIHJldHJ5OiB7IGluaXRpYWxNczogVEFJTF9SRVRSWV9NUywgbWF4TXM6IFRBSUxfUkVUUllfTUFYX01TIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJtaW5kLW1hcHBlclwiLFxuICAgICAgbW9kZTogb25jZSA/IFwib25jZVwiIDogXCJ3YXRjaFwiLFxuICAgICAgcHJlc2VuY2U6IGZhbHNlLFxuICAgICAgLy8g4puUIGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBPTiBUSEUgTE9HIEFORCBJUyBOT1QgQ09VTlRFRC4gVGhlIGRhZW1vblxuICAgICAgLy8gZW1pdHMgaXQsIHdpdGggYSBsb2cgaWQsIHdoZW4gYSB0YWlsIG9wZW5zIG9yIChwYXN0IHRoZSBsaW5nZXIpIHRoZVxuICAgICAgLy8gbGFzdCBvbmUgY2xvc2VzIOKAlCBzbyBhIHRhaWwncyBPV04gY29ubmVjdCBsYW5kcyBvbiBpdHMgb3duIHN0cmVhbS5cbiAgICAgIC8vIENvdW50ZWQsIGV2ZXJ5IHdpbmRvdyB3b3VsZCBiZSBcImFjdGl2ZVwiIGFuZCBldmVyeSBgLS1vbmNlYCB3b3VsZCB3YWtlXG4gICAgICAvLyBvbiBpdHNlbGYgYXQgb25jZS4gSXQgaXMgY2h1cm4sIG5vdCBhbiBhY3QgdG8gYW5zd2VyLiAoVGhlIGdyb3VuZGluZ1xuICAgICAgLy8gZnJhbWUgY2FycmllcyBubyBsb2cgaWQsIHNvIEQzJ3MgcnVsZSBhbHJlYWR5IGxlYXZlcyBpdCBvdXQuKVxuICAgICAgY291bnRzOiAoZXYpID0+IGV2LmtpbmQgIT09IFwicHJlc2VuY2UuY2hhbmdlZFwiLFxuICAgICAgY29tbWFuZHM6IHtcbiAgICAgICAgdGFpbDogKHsgc2luY2U6IGF0LCBvbmNlOiBuZXh0T25jZSwgZXBvY2ggfSkgPT5cbiAgICAgICAgICB0YWlsQ29tbWFuZChcbiAgICAgICAgICAgIFtcbiAgICAgICAgICAgICAgXCJ0YWlsXCIsXG4gICAgICAgICAgICAgIC4uLihpbmJvdW5kID8gW1wiLS1pbmJvdW5kXCJdIDogW10pLFxuICAgICAgICAgICAgICAuLi4ocGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gW1wiLS1wcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCBhcyBzdHJpbmddIDogW10pLFxuICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIGF0LFxuICAgICAgICAgICAgbmV4dE9uY2UsXG4gICAgICAgICAgICBlcG9jaCxcbiAgICAgICAgICApLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb2plY3RzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuY3JlYXRlKSB7XG4gICAgY29uc3QgdGl0bGUgPSBwYXJzZWQudmFsdWVzLmNyZWF0ZTtcbiAgICBjb25zdCBpZCA9IHRpdGxlXG4gICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCItXCIpXG4gICAgICAucmVwbGFjZSgvXi0rfC0rJC9nLCBcIlwiKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb2plY3RzYCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgaWQsIHRpdGxlIH0pLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9qZWN0c2ApO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSW5nZXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFwYXJzZWQudmFsdWVzLnRpdGxlKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcImluZ2VzdCByZXF1aXJlcyAtLXRpdGxlXCIpO1xuICB9XG4gIGlmICghcGFyc2VkLnZhbHVlcy5maWxlICYmICFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcImluZ2VzdCByZXF1aXJlcyAtLWZpbGUgPHBhdGg+IG9yIC0tc3RkaW5cIik7XG4gIH1cbiAgY29uc3QgdGV4dCA9IHBhcnNlZC52YWx1ZXMuZmlsZVxuICAgID8gcmVhZEZpbGVTeW5jKHBhcnNlZC52YWx1ZXMuZmlsZSwgXCJ1dGY4XCIpXG4gICAgOiBhd2FpdCBCdW4uc3RkaW4udGV4dCgpO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2luZ2VzdCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB0aXRsZTogcGFyc2VkLnZhbHVlcy50aXRsZSwgdGV4dCB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQcm9wb3NlKHZlcmI6IFwicHJvcG9zZS1ub2RlXCIgfCBcInByb3Bvc2UtZWRnZVwiLCBwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGlmICghcGFyc2VkLnZhbHVlcy5zdGRpbikge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBgJHt2ZXJifSByZXF1aXJlcyAtLXN0ZGluIEpTT04ge2RyYWZ0LCBldmlkZW5jZVssIHN1Z2dlc3RlZFRpZXIsIGF1dGhvciwgdGFncywgYmF0Y2hJZF19YCxcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICAncHJvcG9zZS1lZGdlIGVuZHBvaW50czogYSBub2RlIGlkLCBhIHBlbmRpbmcgbm9kZS1wcm9wb3NhbCBpZCwgb3IgXCJ0aXRsZTo8ZXhhY3Qgbm9kZSB0aXRsZT5cIiAnICtcbiAgICAgICAgICBcIih0aXRsZSByZWZzIHJlc29sdmUgYXQgSU5UQUtFIGFnYWluc3QgcmF0aWZpZWQgbm9kZXMgb25seSwgZXhhY3QgKyBjYXNlLXNlbnNpdGl2ZTsgXCIgK1xuICAgICAgICAgIFwiYW4gYW1iaWd1b3VzIHRpdGxlIGVycm9ycyBhbmQgbmFtZXMgZXZlcnkgY2FuZGlkYXRlIGlkKVwiLFxuICAgICAgfSxcbiAgICApO1xuICB9XG4gIGNvbnN0IGlucHV0ID0gSlNPTi5wYXJzZShhd2FpdCBCdW4uc3RkaW4udGV4dCgpKSBhcyB7XG4gICAgZHJhZnQ6IHVua25vd247XG4gICAgZXZpZGVuY2U/OiB7IGRvY0lkPzogc3RyaW5nOyBtZXNzYWdlSWQ/OiBzdHJpbmc7IHNwYW4/OiBzdHJpbmcgfTtcbiAgICBzdWdnZXN0ZWRUaWVyPzogc3RyaW5nO1xuICAgIGF1dGhvcj86IHN0cmluZztcbiAgICAvLyBSb3VuZCA3IChUQUdTKTogcHJvcG9zZS10aW1lIHRhZ3MgcmlkZSB0aGUgc3RkaW4gSlNPTiDigJQgbXVzdCBiZVxuICAgIC8vIGZvcndhcmRlZCBpbnRvIHRoZSBQT1NUIGJvZHksIG9yIHRoZSAvcHJvcG9zYWxzIHJvdXRlIG5ldmVyIHNlZXMgdGhlbVxuICAgIC8vICh0aGUgYmF0Y2ggcGF0aCBmb3J3YXJkcyBpdHMgbm9kZSB0YWdzOyB0aGUgc2luZ2xlIHZlcmIgbXVzdCB0b28pLlxuICAgIHRhZ3M/OiBzdHJpbmdbXTtcbiAgICAvLyBSb3VuZCAxMiAoU0VBTSAxKTogam9pbiBhbiBleGlzdGluZyBzdGFnaW5nIGFjdCAoZnJvbSBwcm9wb3NlLWJhdGNoKS5cbiAgICBiYXRjaElkPzogc3RyaW5nO1xuICB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2FscyR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAga2luZDogdmVyYiA9PT0gXCJwcm9wb3NlLW5vZGVcIiA/IFwibm9kZVwiIDogXCJlZGdlXCIsXG4gICAgICBkcmFmdDogaW5wdXQuZHJhZnQsXG4gICAgICBldmlkZW5jZTogaW5wdXQuZXZpZGVuY2UgPz8ge30sXG4gICAgICBzdWdnZXN0ZWRUaWVyOiBpbnB1dC5zdWdnZXN0ZWRUaWVyLFxuICAgICAgYXV0aG9yOiBpbnB1dC5hdXRob3IsXG4gICAgICAvLyAtLXpvbmUgc3RhZ2VzIHRoZSBwcm9wb3NhbCBpbiBhIHpvbmUgKGZsYWcgd2luczsgdGhlIHN0ZGluIEpTT05cbiAgICAgIC8vIHN0YXlzIHRoZSBkcmFmdC9ldmlkZW5jZSBzaGFwZSDigJQgem9uZSBpcyByb3V0aW5nLCBub3QgY29udGVudCkuXG4gICAgICB6b25lOiBwYXJzZWQudmFsdWVzLnpvbmUsXG4gICAgICAvLyBUQUdTOiBmb3J3YXJkIHRoZSBzdGRpbiB0YWdzICh0aGUgcm91dGUgdmFsaWRhdGVzIHRoZSBzaGFwZSkuXG4gICAgICB0YWdzOiBpbnB1dC50YWdzLFxuICAgICAgLy8gU0VBTSAxOiBmb3J3YXJkIHRoZSBzdGRpbiBiYXRjaElkICh0aGUgYm9keS1taXJyb3IgZGlzY2lwbGluZSDigJQgYVxuICAgICAgLy8gZmllbGQgYWRkZWQgdG8gdGhlIHNoYXJlZCAvcHJvcG9zYWxzIGJvZHkgbXVzdCBiZSB0aHJlYWRlZCBpbnRvIEVWRVJZXG4gICAgICAvLyBDTEkgdmVyYiB0aGF0IHBvc3RzIHRvIGl0OyB0aGUgcHJvcG9zZS1ub2RlLXRhZ3Mgc2NhcikuXG4gICAgICBiYXRjaElkOiBpbnB1dC5iYXRjaElkLFxuICAgIH0pLFxuICB9KTtcbiAgY29uc3QgcmVzcG9uc2VUZXh0ID0gYXdhaXQgcGFzc09yVGhyb3cocmVzKTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVzcG9uc2VUZXh0fVxcbmApO1xuICAvLyBNaXJyb3IgdGhlIGRhZW1vbidzIGFkZGl0aXZlIGVkZ2UtZHJhZnQgd2FybmluZyB0byBzdGRlcnIg4oCUIGEgY29sZFxuICAvLyBhZ2VudCBzY2FubmluZyBmb3IgcHJvYmxlbXMgc2VlcyBpdCBldmVuIGlmIGl0IGRvZXNuJ3QgcGFyc2Ugc3Rkb3V0LlxuICBpZiAodmVyYiA9PT0gXCJwcm9wb3NlLWVkZ2VcIikge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gICAgfVxuICB9XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRQcm9wb3NlQmF0Y2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJwcm9wb3NlLWJhdGNoIHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7bm9kZXM6W3tyZWYsIGRyYWZ0LCBzdWdnZXN0ZWRUaWVyPywgZXZpZGVuY2U/fV0sIGVkZ2VzOlt7ZHJhZnQ6e3NvdXJjZSwgdGFyZ2V0LCBsYWJlbD99fV19XCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgXCJhbiBlZGdlIGVuZHBvaW50IG1heSBiZSBhIG5vZGUgTE9DQUwgUkVGIChtYXRjaGVzIGEgbm9kZSdzIHJlZiBpbiB0aGlzIGJhdGNoKSwgXCIgK1xuICAgICAgICAgICdhIHJlYWwgbm9kZSBpZCwgYSBwZW5kaW5nIHByb3Bvc2FsIGlkLCBvciBcInRpdGxlOjxleGFjdCBub2RlIHRpdGxlPlwiIOKAlCBsb2NhbCByZWZzICcgK1xuICAgICAgICAgIFwicmVzb2x2ZSB0byBtaW50ZWQgaWRzIGFuZCB0aXRsZSByZWZzIHRvIHJhdGlmaWVkIG5vZGUgaWRzLCBib3RoIHNlcnZlci1zaWRlOyBcIiArXG4gICAgICAgICAgXCJvcHRpb25hbCBiYXRjaElkOiBvbWl0IGFuZCBvbmUgaXMgTUlOVEVEICsgcmV0dXJuZWQ7IHN1cHBseSBvbmUgdG8gZXh0ZW5kIHRoYXQgYWN0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICBub2Rlcz86IHVua25vd247XG4gICAgZWRnZXM/OiB1bmtub3duO1xuICAgIGJhdGNoSWQ/OiB1bmtub3duO1xuICB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy9iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbm9kZXM6IGlucHV0Lm5vZGVzID8/IFtdLFxuICAgICAgZWRnZXM6IGlucHV0LmVkZ2VzID8/IFtdLFxuICAgICAgLy8gU0VBTSAxOiBvbWl0dGVkIOKGkiB0aGUgZGFlbW9uIG1pbnRzIGEgYmF0Y2hJZCBhbmQgcmV0dXJucyBpdDsgc3VwcGxpZWRcbiAgICAgIC8vIOKGkiB0aGlzIGNhbGwgam9pbnMgdGhhdCBhY3QgKHRoZSBcIkkgZm9yZ290IHRoZSBlZGdlc1wiIHJlcGFpcikuXG4gICAgICBiYXRjaElkOiBpbnB1dC5iYXRjaElkLFxuICAgIH0pLFxuICB9KTtcbiAgLy8gUmVzcG9uc2UgY2FycmllcyB7YmF0Y2hJZCwgcmVmVG9JZDogezxyZWY+OiA8bWludGVkSWQ+fSwgcHJvcG9zYWxzOiBbLi4uXX1cbiAgLy8g4oCUIHRoZSByZWbihpJpZCBtYXAgaXMgdGhlIHBvaW50IGZvciBUSElTIGNhbGwsIGFuZCBiYXRjaElkIGlzIHRoZSBwb2ludCBmb3JcbiAgLy8gZXZlcnkgbGF0ZXIgb25lIChgc3RhdGUgLS1iYXRjaCA8aWQ+YCByZWNvbmNpbGVzIGEgcGFydGlhbCByYXRpZmljYXRpb24pLlxuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmF0aWZ5QmF0Y2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBpZiAoIXBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgJ3JhdGlmeS1iYXRjaCByZXF1aXJlcyAtLXN0ZGluIEpTT04ge3J1bGluZzogXCJjYW5vbnx0aHJlYWR8c3RvcnktbG9jYWxcIiwgaWRzOiBbcHJvcG9zYWxJZF0sIGFuY2hvcnM/OiBbe25vZGUsIHBhcmVudH1dfScsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgXCJyYXRpZmllcyB0aGUgc2V0IGluIE9ORSBjYWxsL3R4bjsgbm9kZXMgcmF0aWZ5IGJlZm9yZSBlZGdlcyAoYXV0by1wYXJ0aXRpb25lZCksIFwiICtcbiAgICAgICAgICBcImVkZ2UgZW5kcG9pbnRzICsgYW5jaG9yIHJlZnMgcmVzb2x2ZSBvbGQgcHJvcG9zYWwgaWRzIOKGkiBtaW50ZWQgbm9kZSBpZHMgdmlhIHRoZSBcIiArXG4gICAgICAgICAgXCJyZXR1cm5lZCBpZE1hcC4gTk8gYXV0by1pbmNsdWRlIG9mIHVubGlzdGVkIGVkZ2VzOyByZWplY3QgaXMgbm90IGEgYmF0Y2ggYWN0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgaW5wdXQgPSBKU09OLnBhcnNlKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpIGFzIHtcbiAgICBydWxpbmc/OiB1bmtub3duO1xuICAgIGlkcz86IHVua25vd247XG4gICAgYW5jaG9ycz86IHVua25vd247XG4gIH07XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL3JhdGlmeS1iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsaW5nOiBpbnB1dC5ydWxpbmcsXG4gICAgICBpZHM6IGlucHV0LmlkcyA/PyBbXSxcbiAgICAgIGFuY2hvcnM6IGlucHV0LmFuY2hvcnMsXG4gICAgfSksXG4gIH0pO1xuICAvLyBSZXNwb25zZSBjYXJyaWVzIHtpZE1hcDogezxvbGRQcm9wb3NhbElkPjogPG1pbnRlZE5vZGVJZD59LCByYXRpZmllZDpbLi4uXX1cbiAgLy8g4oCUIHRoZSBpZE1hcCBpcyB0aGUgcG9pbnQgKHJlY29ubmVjdCBhbiBlZGdlL2FuY2hvciB0byB0aGUgcmVhbCBub2RlKS5cbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDUpIOKAlCB0aGUgaW52ZXJzZSBvZiByYXRpZnktYmF0Y2g6IGNsZWFyIGEgc2V0IG9mIHByb3Bvc2Fsc1xuLy8gaW4gT05FIHRyYW5zYWN0aW9uYWwgY2FsbCBpbnN0ZWFkIG9mIE4gSFRUUCBkZWxldGVzIGluIGEgbG9vcC5cbmFzeW5jIGZ1bmN0aW9uIGNtZERlbGV0ZUJhdGNoKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgaWYgKCFwYXJzZWQudmFsdWVzLnN0ZGluKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcignZGVsZXRlLWJhdGNoIHJlcXVpcmVzIC0tc3RkaW4gSlNPTiB7aWRzOiBbXCI8cHJvcG9zYWxJZD5cIiwgLi4uXX0nLCB7XG4gICAgICBoaW50OlxuICAgICAgICBcImRlbGV0ZXMgdGhlIHNldCBpbiBPTkUgdHhuIOKAlCBhbGwtb3Itbm90aGluZzogaWYgYW55IGlkIGlzIHVua25vd24sIE5PVEhJTkcgaXMgXCIgK1xuICAgICAgICBcImRlbGV0ZWQgYW5kIHRoZSBlcnJvciBuYW1lcyBldmVyeSB1bmtub3duIGlkLiBUaGVyZSBpcyBkZWxpYmVyYXRlbHkgbm8gXCIgK1xuICAgICAgICBcIntiYXRjaDogPGlkPn0gc2hvcnRoYW5kIOKAlCBydW4gYHN0YXRlIC0tYmF0Y2ggPGlkPmAgYW5kIGxvb2sgYmVmb3JlIHlvdSBzd2VlcCBcIiArXG4gICAgICAgIFwiKGRyaXZlICMxMCdzIGJ1ZyB3YXMgYW4gb3Zlci1icm9hZCBjbGVhbnVwIHRoYXQgdG9vayB0aGUgZWRnZXMgd2l0aCBpdClcIixcbiAgICB9KTtcbiAgfVxuICBjb25zdCBpbnB1dCA9IEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyBpZHM/OiB1bmtub3duIH07XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzL2RlbGV0ZS1iYXRjaCR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBpZHM6IGlucHV0LmlkcyA/PyBbXSB9KSxcbiAgfSk7XG4gIGNvbnN0IGRlbGV0ZUJhdGNoQm9keSA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2RlbGV0ZUJhdGNoQm9keX1cXG5gKTtcbiAgLy8gUjEyIGdhdGUgZmluZGluZyAxOiBtaXJyb3IgdGhlIHN0cmFuZGVkLW5vZGUgYWR2aXNvcnkgdG8gc3RkZXJyLCB0aGUgc2FtZVxuICAvLyB3YXkgcHJvcG9zZS1lZGdlIG1pcnJvcnMgZWRnZURyYWZ0V2FybmluZyDigJQgYSBjb2xkIGFnZW50IHNjYW5uaW5nIGZvclxuICAvLyBwcm9ibGVtcyBzZWVzIGl0IGV2ZW4gaWYgaXQgbmV2ZXIgcGFyc2VzIHN0ZG91dC4gQWR2aXNvcnksIG5vdCBhIGZhaWx1cmU6XG4gIC8vIHRoZSBleGl0IGNvZGUgaXMgdW5jaGFuZ2VkLlxuICB0cnkge1xuICAgIGNvbnN0IHsgd2FybmluZyB9ID0gSlNPTi5wYXJzZShkZWxldGVCYXRjaEJvZHkpIGFzIHsgd2FybmluZz86IHN0cmluZyB9O1xuICAgIGlmICh0eXBlb2Ygd2FybmluZyA9PT0gXCJzdHJpbmdcIikgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYCMgd2FybmluZzogJHt3YXJuaW5nfVxcbmApO1xuICB9IGNhdGNoIHtcbiAgICAvKiBib2R5IGlzIHdoYXQgaXQgaXMgKi9cbiAgfVxuICByZXR1cm4gMDtcbn1cblxuY29uc3QgcHJvamVjdFFzID0gKHBhcnNlZDogUGFyc2VkKTogc3RyaW5nID0+XG4gIHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuXG4vLyBSb3VuZCA2IChERUwpOiBgbm9kZSBkZWxldGUgPGlkPiBbLS1mb3JjZV1gIOKAlCA0MDkge2Vycm9yOlwiY2l0ZWRcIixcbi8vIGNpdGVkQnk6e2VkZ2VzLCBjaGlsZHJlbn19IHdoZW4gY2l0ZWQgYW5kIHVuZm9yY2VkOyAtLWZvcmNlIGNhc2NhZGVzXG4vLyAoZWRnZXMgZ29uZSwgY2hpbGRyZW4gcmUtcGFyZW50ZWQgdG8gdG9wLWxldmVsLCBkZXRyaXR1cyBnb25lKS5cbmFzeW5jIGZ1bmN0aW9uIGNtZE5vZGVEZWxldGUocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoKTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuZm9yY2UpIHBhcmFtcy5zZXQoXCJmb3JjZVwiLCBcIjFcIik7XG4gIGNvbnN0IGRxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbm9kZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDEyIChTRUFNIDQpOiBgbm9kZSBlZGl0IDxpZD4gWy0tdGl0bGUgVF0gWy0tc3lub3BzaXMgU10gfCAtLXN0ZGluYFxuLy8g4oCUIGEgcmF0aWZpZWQgbm9kZSBjYW4gZmluYWxseSBnYWluIGEgc3lub3BzaXMgKEYyKS4gV3JpdGVzIGV4YWN0bHkgd2hhdFxuLy8gaXQgaXMgZ2l2ZW47IHRpZXIgYW5kIGtpbmQgYXJlIE5PVCBlZGl0YWJsZSAoc2VlIGVkaXQudHMgZm9yIHdoeSkuXG5hc3luYyBmdW5jdGlvbiBjbWROb2RlRWRpdChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcGF0Y2g6IHsgdGl0bGU/OiBzdHJpbmc7IHN5bm9wc2lzPzogc3RyaW5nIH0gPSB7fTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc3RkaW4pIHtcbiAgICAvLyBQcm9zZSBiZWxvbmdzIG9uIHN0ZGluIOKAlCBhIHN5bm9wc2lzIGlzIGEgcGFyYWdyYXBoLCBub3QgYSBmbGFnIHZhbHVlLlxuICAgIE9iamVjdC5hc3NpZ24oXG4gICAgICBwYXRjaCxcbiAgICAgIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgeyB0aXRsZT86IHN0cmluZzsgc3lub3BzaXM/OiBzdHJpbmcgfSxcbiAgICApO1xuICB9XG4gIGlmIChwYXJzZWQudmFsdWVzLnRpdGxlICE9PSB1bmRlZmluZWQpIHBhdGNoLnRpdGxlID0gcGFyc2VkLnZhbHVlcy50aXRsZTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMuc3lub3BzaXMgIT09IHVuZGVmaW5lZCkgcGF0Y2guc3lub3BzaXMgPSBwYXJzZWQudmFsdWVzLnN5bm9wc2lzO1xuICBpZiAocGF0Y2gudGl0bGUgPT09IHVuZGVmaW5lZCAmJiBwYXRjaC5zeW5vcHNpcyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgICd1c2FnZTogY2xpLnRzIG5vZGUgZWRpdCA8bm9kZUlkPiAoLS10aXRsZSA8dD4gfCAtLXN5bm9wc2lzIDxzPiB8IC0tc3RkaW4gXFwne1wic3lub3BzaXNcIjogXCIuLi5cIn1cXCcpJyxcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICBcIndyaXRlcyBleGFjdGx5IHdoYXQgaXQgaXMgZ2l2ZW4gKG5vIGluZmVyZW5jZSk7IG9ubHkgdGl0bGUvc3lub3BzaXMgYXJlIGVkaXRhYmxlIOKAlCBcIiArXG4gICAgICAgICAgXCJ0aWVyIGlzIHRoZSBodW1hbidzIHJ1bGluZyBhbmQga2luZCBpcyBhIHJhdGlmaWNhdGlvbi10aW1lIGNsYXNzaWZpY2F0aW9uXCIsXG4gICAgICB9LFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9ub2Rlcy8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgLy8gQm9keS1taXJyb3IgZGlzY2lwbGluZTogdGhyZWFkIGV2ZXJ5IGZpZWxkIGV4cGxpY2l0bHkgKHRoZVxuICAgIC8vIHByb3Bvc2Utbm9kZS10YWdzIHNjYXIpIOKAlCBhbiBvbWl0dGVkIGtleSBtdXN0IHN0YXkgb21pdHRlZCBzbyB0aGVcbiAgICAvLyByb3V0ZSBwYXRjaGVzIGluc3RlYWQgb2YgYmxhbmtpbmcuXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgLi4uKHBhdGNoLnRpdGxlICE9PSB1bmRlZmluZWQgPyB7IHRpdGxlOiBwYXRjaC50aXRsZSB9IDoge30pLFxuICAgICAgLi4uKHBhdGNoLnN5bm9wc2lzICE9PSB1bmRlZmluZWQgPyB7IHN5bm9wc2lzOiBwYXRjaC5zeW5vcHNpcyB9IDoge30pLFxuICAgIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogYC0tdG8gPGlkPiB8IC0tY2xlYXJgLCBleGFjdGx5IG9uZSDigJQgYG5vZGUgYW5jaG9yYCBhbmQgYHByb3Bvc2FsIHpvbmVgLiBBXG4gKiBydWxlIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3Qgc3RhdGUgKGl0IHB1Ymxpc2hlcyBib3RoIGZsYWdzIGFzIHZhbGlkKSwgc28gaXRcbiAqIHJpZGVzIHRoZSByb3cncyBgY2hlY2tgIGFuZCBpcyByZWZ1c2VkIGJlZm9yZSB0aGUgaGFuZGxlciBydW5zLlxuICovXG5jb25zdCB0b1hvckNsZWFyID0gKGludjogSW52b2NhdGlvbjxGbGFnPik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gIGNvbnN0IGhhc1RvID0gaW52LmZsYWdzLnRvICE9PSB1bmRlZmluZWQ7XG4gIGNvbnN0IGNsZWFyID0gaW52LmZsYWdzLmNsZWFyID09PSB0cnVlO1xuICBpZiAoaGFzVG8gJiYgY2xlYXIpIHJldHVybiBcImdpdmUgLS10byA8aWQ+IG9yIC0tY2xlYXIsIG5vdCBib3RoXCI7XG4gIGlmICghaGFzVG8gJiYgIWNsZWFyKSByZXR1cm4gXCJnaXZlIC0tdG8gPGlkPiBvciAtLWNsZWFyXCI7XG4gIHJldHVybiB1bmRlZmluZWQ7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjbWROb2RlQW5jaG9yKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L25vZGVzLyR7aWR9L2FuY2hvciR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBwYXJlbnRJZDogcGFyc2VkLnZhbHVlcy5jbGVhciA/IG51bGwgOiBwYXJzZWQudmFsdWVzLnRvIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFJlYWQocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbWVzc2FnZS8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRab25lQ3JlYXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgbmFtZSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS96b25lcyR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBuYW1lIH0pLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFpvbmVMaXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS96b25lcyR7cHJvamVjdFFzKHBhcnNlZCl9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRab25lRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnllcykgcGFyYW1zLnNldChcInllc1wiLCBcIjFcIik7XG4gIGNvbnN0IGRxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vem9uZXMvJHtpZH0ke2Rxc31gLCB7IG1ldGhvZDogXCJERUxFVEVcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb21vdGUocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vcHJvcG9zYWxzLyR7aWR9L3Byb21vdGUke3Byb2plY3RRcyhwYXJzZWQpfWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb3Bvc2FsWm9uZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9wcm9wb3NhbHMvJHtpZH0vem9uZSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyB6b25lSWQ6IHBhcnNlZC52YWx1ZXMuY2xlYXIgPyBudWxsIDogcGFyc2VkLnZhbHVlcy50byB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCA2IChERUwpOiBgcHJvcG9zYWwgZGVsZXRlIDxpZD5gIOKAlCB0aGluLCBubyBndWFyZCAoZHJvcCByb3cgK1xuLy8gY2FzY2FkZSBub2RlX2FjdGlvbnMpLiBUaGUgbGl0dGVyLWNsZWFyaW5nIHBhdGggKGNsZWFyIGEgcmF3XG4vLyBpbnN0cnVjdGlvbi1ub2RlIHRocm91Z2ggREVMRVRFLCBub3QgcmVqZWN0KS5cbmFzeW5jIGZ1bmN0aW9uIGNtZFByb3Bvc2FsRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke2lkfSR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJERUxFVEVcIixcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBgZG9jIDxpZD5gIHJlYWRzIGFuZCBgZG9jIGRlbGV0ZSA8aWQ+IFstLWZvcmNlXWAgZGVsZXRlcy4gVGhlIGBkb2NgIGdyb3VwXG4vLyBmaW5kcyBpdHMgc3ViLXZlcmIgYXQgdGhlIEZJUlNUIFBPU0lUSU9OQUwsIHNvIGZsYWdzIG1heSBjb21lIGZpcnN0XG4vLyAoYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWApOyBhIGRvYyBsaXRlcmFsbHkgbmFtZWQgXCJkZWxldGVcIiBvclxuLy8gXCJraW5kXCIgaXMgcmVhZCB3aXRoIGBkb2MgLS0gZGVsZXRlYCwgc2luY2UgdGhlIHNjYW4gc3RvcHMgYXQgYSBiYXJlIGAtLWAuXG5hc3luYyBmdW5jdGlvbiBjbWREb2MoaXNEZWxldGU6IGJvb2xlYW4sIHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKCk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGlmIChpc0RlbGV0ZSAmJiBwYXJzZWQudmFsdWVzLmZvcmNlKSBwYXJhbXMuc2V0KFwiZm9yY2VcIiwgXCIxXCIpO1xuICBjb25zdCBxcyA9IHBhcmFtcy5zaXplID4gMCA/IGA/JHtwYXJhbXN9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vZG9jLyR7aWR9JHtxc31gLCB7XG4gICAgbWV0aG9kOiBpc0RlbGV0ZSA/IFwiREVMRVRFXCIgOiBcIkdFVFwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDQgKEsxKTogYGRvYyBraW5kIDxkb2NJZD4gPGtpbmQuLi4+IFstLWF1dGhvciB1c2VyfGFnZW50XWAgc2V0cyxcbi8vIGBkb2Mga2luZCA8ZG9jSWQ+IC0tY2xlYXJgIGNsZWFycyAoYXV0aG9yIG51bGxzIHdpdGggaXQpLiBUaGUgaW5nZXN0XG4vLyBkZWZhdWx0cyBkaWVkIOKAlCB0aGlzIHZlcmIgaXMgaG93IGEgZG9jIGdldHMgdHlwZWQgYXQgYWxsLlxuYXN5bmMgZnVuY3Rpb24gY21kRG9jS2luZChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGRvY0lkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3Qga2luZFdvcmRzID0gcGFyc2VkLnBvc2l0aW9uYWxzLnNsaWNlKDEpLmpvaW4oXCIgXCIpO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2RvYy8ke2RvY0lkfS9raW5kJHtwcm9qZWN0UXMocGFyc2VkKX1gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeShcbiAgICAgIHBhcnNlZC52YWx1ZXMuY2xlYXJcbiAgICAgICAgPyB7IGtpbmQ6IG51bGwgfVxuICAgICAgICA6IHsga2luZDoga2luZFdvcmRzLCBhdXRob3I6IHBhcnNlZC52YWx1ZXMuYXV0aG9yID8/IFwiYWdlbnRcIiB9LFxuICAgICksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTWFyayhwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGRvY0lkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICBpZiAoIWRvY0lkIHx8ICFwYXJzZWQudmFsdWVzLnN0YXR1cykge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG1hcmsgPGRvY0lkPiAtLXN0YXR1cyA8cz4gWy0tbm90ZSA8dD5dXCIpO1xuICB9XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHFzID0gcGFyc2VkLnZhbHVlcy5wcm9qZWN0ID8gYD9wcm9qZWN0PSR7ZW5jb2RlVVJJQ29tcG9uZW50KHBhcnNlZC52YWx1ZXMucHJvamVjdCl9YCA6IFwiXCI7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vZG9jLyR7ZG9jSWR9L21hcmske3FzfWAsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIGF1dGhvcjogcGFyc2VkLnZhbHVlcy5hdXRob3IgPz8gXCJhZ2VudFwiLFxuICAgICAgbm90ZTogcGFyc2VkLnZhbHVlcy5ub3RlLFxuICAgICAgc3RhdHVzOiBwYXJzZWQudmFsdWVzLnN0YXR1cyxcbiAgICB9KSxcbiAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTZWFyY2gocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBxdWVyeSA9IHBhcnNlZC5wb3NpdGlvbmFscy5qb2luKFwiIFwiKTtcbiAgaWYgKCFxdWVyeSkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIHNlYXJjaCA8cXVlcnkuLi4+XCIpO1xuICB9XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHBhcmFtcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMoeyBxOiBxdWVyeSB9KTtcbiAgaWYgKHBhcnNlZC52YWx1ZXMucHJvamVjdCkgcGFyYW1zLnNldChcInByb2plY3RcIiwgcGFyc2VkLnZhbHVlcy5wcm9qZWN0KTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zZWFyY2g/JHtwYXJhbXN9YCk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWROZWlnaGJvcnMocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFpZCkge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXCJ1c2FnZTogY2xpLnRzIG5laWdoYm9ycyA8bm9kZUlkPiBbLS1kZXB0aCAxXVwiKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKHsgZGVwdGg6IHBhcnNlZC52YWx1ZXMuZGVwdGggPz8gXCIxXCIgfSk7XG4gIGlmIChwYXJzZWQudmFsdWVzLnByb2plY3QpIHBhcmFtcy5zZXQoXCJwcm9qZWN0XCIsIHBhcnNlZC52YWx1ZXMucHJvamVjdCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbmVpZ2hib3JzLyR7aWR9PyR7cGFyYW1zfWApO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kUmF0aWZ5KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcHJvcG9zYWxJZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFwcm9wb3NhbElkIHx8ICFwYXJzZWQudmFsdWVzLnJ1bGluZykge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgcmF0aWZ5IDxwcm9wb3NhbElkPiAtLXJ1bGluZyA8cj4gWy0tZG9jLWVkaXQgPGZpbGU+XSBbLS1kb2MgPGRvY0lkPiAtLXNwYW4gPHRleHQ+XSBbLS1hbmNob3IgPHBhcmVudElkPl1cXG5cIixcbiAgICApO1xuICB9XG4gIC8vIC0tZG9jIHJlcXVpcmVzIC0tZG9jLWVkaXQg4oCUIHRoZSBkYWVtb24gZW5mb3JjZXMgaXQgdG9vLCBidXQgYSBsb2NhbFxuICAvLyB1c2FnZSBlcnJvciBiZWF0cyBhIHJvdW5kLXRyaXAgZm9yIHRoZSBjb21tb24gc2xpcC5cbiAgaWYgKHBhcnNlZC52YWx1ZXMuZG9jICYmICFwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl0pIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFwiLS1kb2MgcmVxdWlyZXMgLS1kb2MtZWRpdCAodGhlIGRyYWZ0ZWQgZG9jIGhvbWUpXCIpO1xuICB9XG4gIGNvbnN0IGRvY0VkaXQgPSBwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl1cbiAgICA/IHJlYWRGaWxlU3luYyhwYXJzZWQudmFsdWVzW1wiZG9jLWVkaXRcIl0sIFwidXRmOFwiKVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCBxcyA9IHBhcnNlZC52YWx1ZXMucHJvamVjdCA/IGA/cHJvamVjdD0ke2VuY29kZVVSSUNvbXBvbmVudChwYXJzZWQudmFsdWVzLnByb2plY3QpfWAgOiBcIlwiO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L3Byb3Bvc2Fscy8ke3Byb3Bvc2FsSWR9L3J1bGluZyR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgcnVsaW5nOiBwYXJzZWQudmFsdWVzLnJ1bGluZyxcbiAgICAgIGRvY0VkaXQsXG4gICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICBzcGFuOiBwYXJzZWQudmFsdWVzLnNwYW4sXG4gICAgICAvLyBSb3VuZCA2IChSQik6IC0tYW5jaG9yIDxwYXJlbnRJZD4gcmF0aWZpZXMgdGhlbiBuZXN0cyB0aGUgbWludGVkXG4gICAgICAvLyBub2RlIHVuZGVyIDxwYXJlbnRJZD4gaW4gb25lIGF0b21pYyBjYWxsIChub2RlIHByb3Bvc2FscyBvbmx5KS5cbiAgICAgIGFuY2hvcjogcGFyc2VkLnZhbHVlcy5hbmNob3IsXG4gICAgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuLy8gUm91bmQgMyAoQ2xhaW0gVjIpOiBvbmUgbGVucywgdHdvIG1vZGVzIOKAlCAtLW5vZGUgYW5kIC0tZG9jIGFyZSBleGNsdXNpdmVcbi8vICh0aGUgZGFlbW9uIGVuZm9yY2VzIHRoZSBYT1IgdG9vLCBidXQgdGhlIGNvbW1vbiBzbGlwIHNob3VsZCBmYWlsIGJlZm9yZSBhXG4vLyByb3VuZC10cmlwKS4gVGhlIHJvdydzIGBjaGVja2AgcmVmdXNlcyB0aGUgc2xpcDsgdGhpcyBvbmx5IHBvc3RzLlxuYXN5bmMgZnVuY3Rpb24gY21kTGVuc1NldChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHBvcnQgPSByZXF1aXJlRGFlbW9uKCk7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0vbGVucyR7cHJvamVjdFFzKHBhcnNlZCl9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgb3duZXI6IHBhcnNlZC52YWx1ZXMub3duZXIgPz8gXCJhZ2VudFwiLFxuICAgICAgbm9kZUlkOiBwYXJzZWQudmFsdWVzLm5vZGUsXG4gICAgICBkb2NJZDogcGFyc2VkLnZhbHVlcy5kb2MsXG4gICAgICBkZXB0aDogcGFyc2VkLnZhbHVlcy5kZXB0aCA/IE51bWJlci5wYXJzZUludChwYXJzZWQudmFsdWVzLmRlcHRoLCAxMCkgOiB1bmRlZmluZWQsXG4gICAgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kTGVuc0NsZWFyKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9sZW5zJHtwcm9qZWN0UXMocGFyc2VkKX1gLCB7XG4gICAgbWV0aG9kOiBcIkRFTEVURVwiLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZExvb2tIZXJlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGlmICghaWQpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBsb29rLWhlcmUgPG5vZGVJZD5cIik7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9sb29rLWhlcmUvJHtpZH0ke3FzfWAsIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKlxuICogYC0tc2V0IDxqc29uPiB8IC0tc3RkaW4gfCAtLWNsZWFyYCwgZXhhY3RseSBvbmUg4oCUIGBhY3Rpb25zYCBhbmQgYHRhZ3NgLiBUaGVcbiAqIGRlY2xhcmF0aW9uIHB1Ymxpc2hlcyBhbGwgdGhyZWUgYXMgdmFsaWQ7IHRoZSBydWxlIHJpZGVzIHRoZSByb3cncyBgY2hlY2tgLlxuICovXG5jb25zdCBleGFjdGx5T25lTW9kZSA9IChpbnY6IEludm9jYXRpb248RmxhZz4pOiBzdHJpbmcgfCB1bmRlZmluZWQgPT4ge1xuICBjb25zdCBtb2RlcyA9IFtpbnYuZmxhZ3Muc2V0ICE9PSB1bmRlZmluZWQsIGludi5mbGFncy5zdGRpbiA9PT0gdHJ1ZSwgaW52LmZsYWdzLmNsZWFyID09PSB0cnVlXTtcbiAgcmV0dXJuIG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggPT09IDFcbiAgICA/IHVuZGVmaW5lZFxuICAgIDogXCJnaXZlIGV4YWN0bHkgb25lIG9mIC0tc2V0IDxqc29uPiwgLS1zdGRpbiBvciAtLWNsZWFyXCI7XG59O1xuXG5hc3luYyBmdW5jdGlvbiBjbWRBY3Rpb25zKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdGFyZ2V0SWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGNvbnN0IG1vZGVzID0gW3BhcnNlZC52YWx1ZXMuc2V0ICE9PSB1bmRlZmluZWQsIHBhcnNlZC52YWx1ZXMuc3RkaW4sIHBhcnNlZC52YWx1ZXMuY2xlYXJdO1xuICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIGFjdGlvbnMgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpXFxuXCIgK1xuICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgICcgIHtcImlkXCIsIFwibGFiZWxcIiwgXCJzZWVkXCJ9IOKAlCBlbXB0eSBhcnJheSAob3IgLS1jbGVhcikgcmVtb3ZlcyB0aGUgc2xvdHNcXG4nLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpb25zLyR7dGFyZ2V0SWR9JHtxc31gO1xuICBjb25zdCByZXMgPSBwYXJzZWQudmFsdWVzLmNsZWFyXG4gICAgPyBhd2FpdCBmZXRjaCh0YXJnZXQsIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pXG4gICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBVVFwiLFxuICAgICAgICBib2R5OiBwYXJzZWQudmFsdWVzLnN0ZGluID8gYXdhaXQgQnVuLnN0ZGluLnRleHQoKSA6IChwYXJzZWQudmFsdWVzLnNldCBhcyBzdHJpbmcpLFxuICAgICAgfSk7XG4gIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgLy8gTWlycm9yIHRoZSBkYWVtb24ncyBhZGRpdGl2ZSBzb2Z0LWNhcCB3YXJuaW5nIHRvIHN0ZGVyciAodGhlXG4gIC8vIGVkZ2VEcmFmdFdhcm5pbmcgcGF0dGVybiDigJQgYSBjb2xkIGFnZW50IHNjYW5uaW5nIGZvciBwcm9ibGVtcyBzZWVzIGl0KS5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8vIFJvdW5kIDcgKFRBR1MpIOKAlCB0d2luIG9mIHRoZSBhY3Rpb25zIHZlcmI6IHdob2xlc2FsZSByZXBsYWNlIC8gY2xlYXIgYVxuLy8gdGFyZ2V0J3MgZnJlZWZvcm0gdGFncy4gVGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQuXG5hc3luYyBmdW5jdGlvbiBjbWRUYWdzKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgdGFyZ2V0SWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGNvbnN0IG1vZGVzID0gW3BhcnNlZC52YWx1ZXMuc2V0ICE9PSB1bmRlZmluZWQsIHBhcnNlZC52YWx1ZXMuc3RkaW4sIHBhcnNlZC52YWx1ZXMuY2xlYXJdO1xuICBpZiAoIXRhcmdldElkIHx8IG1vZGVzLmZpbHRlcihCb29sZWFuKS5sZW5ndGggIT09IDEpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIHRhZ3MgPHRhcmdldElkPiAoLS1zZXQgPGpzb24+IHwgLS1zdGRpbiB8IC0tY2xlYXIpXFxuXCIgK1xuICAgICAgICBcIiAgdGFyZ2V0IGlzIGEgbm9kZSBpZCBvciBhIFBFTkRJTkcgcHJvcG9zYWwgaWQ7IGpzb24gaXMgYW4gYXJyYXkgb2ZcXG5cIiArXG4gICAgICAgIFwiICBmcmVlZm9ybSBzdHJpbmdzIOKAlCBlbXB0eSBhcnJheSAob3IgLS1jbGVhcikgcmVtb3ZlcyB0aGUgdGFnc1xcblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgdGFyZ2V0ID0gYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS90YWdzLyR7dGFyZ2V0SWR9JHtxc31gO1xuICBjb25zdCByZXMgPSBwYXJzZWQudmFsdWVzLmNsZWFyXG4gICAgPyBhd2FpdCBmZXRjaCh0YXJnZXQsIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pXG4gICAgOiBhd2FpdCBmZXRjaCh0YXJnZXQsIHtcbiAgICAgICAgbWV0aG9kOiBcIlBVVFwiLFxuICAgICAgICBib2R5OiBwYXJzZWQudmFsdWVzLnN0ZGluID8gYXdhaXQgQnVuLnN0ZGluLnRleHQoKSA6IChwYXJzZWQudmFsdWVzLnNldCBhcyBzdHJpbmcpLFxuICAgICAgfSk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke2F3YWl0IHBhc3NPclRocm93KHJlcyl9XFxuYCk7XG4gIHJldHVybiAwO1xufVxuXG4vLyBSb3VuZCA5IChKb2IgUXVldWUpIOKAlCB0aGUgYGpvYmAgZ3JvdXA6IGNyZWF0ZS91cGRhdGUvY2xhaW0vcmVsZWFzZS9zdWJ0YXNrL1xuLy8gbGlzdC9kZWxldGUsIGNvcHlpbmcgdGhlIGBwcm9wb3NhbCA8c3ViPmAgbGlmZWN5Y2xlIHNoYXBlICsgdGhlIHRhZ3Ncbi8vIGJvZHktYnVpbGRlciBkaXNjaXBsaW5lLiBFVkVSWSBmaWVsZCBpcyB0aHJlYWRlZCBpbnRvIHRoZSBQT1NUIGJvZHkgKHRoZSBSN1xuLy8gZ2F0ZSBzY2FyOiBhIGhhbmQtd3JpdHRlbiBib2R5LWJ1aWxkZXIgaXMgYSBNSVJST1Igb2YgdGhlIHJvdXRlJ3MgZmllbGQgc2V0XG4vLyBhbmQgZHJpZnRzIHNpbGVudGx5IOKAlCBzbyB1cGRhdGUgZm9yd2FyZHMgZWFjaCBwcm92aWRlZCBzY2FsYXIsIHN1YnRhc2tcbi8vIGZvcndhcmRzIG9wICsgbGFiZWx8c3VidGFza0lkLCBjbGFpbSBmb3J3YXJkcyBvd25lcikuXG5jb25zdCBqb2JVcmwgPSAocG9ydDogbnVtYmVyLCBwYXJzZWQ6IFBhcnNlZCwgc3VmZml4ID0gXCJcIik6IHN0cmluZyA9PlxuICBgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9L2pvYnMke3N1ZmZpeH0ke3Byb2plY3RRcyhwYXJzZWQpfWA7XG5cbi8vIEEgSlNPTiBib2R5IGZyb20gLS1ib2R5LWZpbGUgPiAtLXN0ZGluIG92ZXJyaWRlcyB0aGUgZmxhZy1idWlsdCBib2R5ICh0aGVcbi8vIHNlbmQgcHJlY2VkZW5jZSBjaGFpbiksIHNvIGEgZnVsbCBqb2IgY2FuIGJlIHBpcGVkIGluIG9uZSBzaG90LlxuYXN5bmMgZnVuY3Rpb24gam9iQm9keUZyb21Tb3VyY2UocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbD4ge1xuICBpZiAocGFyc2VkLnZhbHVlc1tcImJvZHktZmlsZVwiXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgaWYgKCFleGlzdHNTeW5jKHApKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKGBqb2I6IC0tYm9keS1maWxlIG5vdCBmb3VuZDogJHtwfWApO1xuICAgIH1cbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocCwgXCJ1dGY4XCIpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfVxuICBpZiAocGFyc2VkLnZhbHVlcy5zdGRpbikgcmV0dXJuIEpTT04ucGFyc2UoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBudWxsO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRKb2JMaXN0KHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goam9iVXJsKHBvcnQsIHBhcnNlZCkpO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iQ3JlYXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBqb2JCb2R5RnJvbVNvdXJjZShwYXJzZWQpO1xuICBjb25zdCBib2R5ID0gb3ZlcnJpZGUgPz8ge1xuICAgIHRpdGxlOiBwYXJzZWQudmFsdWVzLnRpdGxlLFxuICAgIHN0YXR1czogcGFyc2VkLnZhbHVlcy5zdGF0dXMsXG4gICAgZGVsaXZlcmFibGU6IHBhcnNlZC52YWx1ZXMuZGVsaXZlcmFibGUsXG4gICAgZGV0YWlsOiBwYXJzZWQudmFsdWVzLmRldGFpbCxcbiAgfTtcbiAgaWYgKHR5cGVvZiBib2R5LnRpdGxlICE9PSBcInN0cmluZ1wiIHx8IGJvZHkudGl0bGUgPT09IFwiXCIpIHtcbiAgICB0aHJvdyB1c2FnZUVycm9yKFxuICAgICAgXCJ1c2FnZTogY2xpLnRzIGpvYiBjcmVhdGUgLS10aXRsZSA8dD4gWy0tc3RhdHVzIDxzPl0gWy0tZGVsaXZlcmFibGUgPHJlZj5dIFstLWRldGFpbCA8eD5dXFxuXCIgK1xuICAgICAgICBcIiAgb3I6IGNsaS50cyBqb2IgY3JlYXRlICgtLXN0ZGluIHwgLS1ib2R5LWZpbGUgPHBhdGg+KSB3aXRoIEpTT04ge3RpdGxlLCBzdGF0dXM/LCBkZWxpdmVyYWJsZT8sIGRldGFpbD99XFxuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkKSwgeyBtZXRob2Q6IFwiUE9TVFwiLCBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYlVwZGF0ZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3Qgb3ZlcnJpZGUgPSBhd2FpdCBqb2JCb2R5RnJvbVNvdXJjZShwYXJzZWQpO1xuICAvLyBGb3J3YXJkIG9ubHkgdGhlIGZsYWdzIHRoYXQgd2VyZSBQUk9WSURFRCAodGhyZWFkIGV2ZXJ5IGZpZWxkIOKAlCB0aGUgUjdcbiAgLy8gYm9keS1taXJyb3Igc2Nhcik7IGEgYmFyZSBgam9iIHVwZGF0ZSA8aWQ+YCB3aXRoIG5vIGZpZWxkcyBpcyBhIHVzYWdlXG4gIC8vIGVycm9yLCBub3QgYSBzaWxlbnQgbm8tb3AgUE9TVC5cbiAgY29uc3QgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPVxuICAgIG92ZXJyaWRlID8/XG4gICAgT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgICAgKFtcInRpdGxlXCIsIFwic3RhdHVzXCIsIFwiZGVsaXZlcmFibGVcIiwgXCJkZXRhaWxcIl0gYXMgY29uc3QpXG4gICAgICAgIC5maWx0ZXIoKGspID0+IHBhcnNlZC52YWx1ZXNba10gIT09IHVuZGVmaW5lZClcbiAgICAgICAgLm1hcCgoaykgPT4gW2ssIHBhcnNlZC52YWx1ZXNba11dKSxcbiAgICApO1xuICBpZiAoT2JqZWN0LmtleXMoYm9keSkubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIFwidXNhZ2U6IGNsaS50cyBqb2IgdXBkYXRlIDxpZD4gKGF0IGxlYXN0IG9uZSBvZiAtLXRpdGxlfC0tc3RhdHVzfC0tZGVsaXZlcmFibGV8LS1kZXRhaWwpXFxuXCIsXG4gICAgKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9YCksIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYkNsYWltKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBpZiAocGFyc2VkLnZhbHVlcy5vd25lciA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcInVzYWdlOiBjbGkudHMgam9iIGNsYWltIDxpZD4gLS1vd25lciA8d2hvPlwiKTtcbiAgfVxuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9L2NsYWltYCksIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgb3duZXI6IHBhcnNlZC52YWx1ZXMub3duZXIgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iUmVsZWFzZShwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IGlkID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdIGFzIHN0cmluZztcbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goam9iVXJsKHBvcnQsIHBhcnNlZCwgYC8ke2lkfS9yZWxlYXNlYCksIHsgbWV0aG9kOiBcIlBPU1RcIiB9KTtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7YXdhaXQgcGFzc09yVGhyb3cocmVzKX1cXG5gKTtcbiAgcmV0dXJuIDA7XG59XG5cbi8qKiBgLS1hZGQgfCAtLWNoZWNrIHwgLS11bmNoZWNrYCwgZXhhY3RseSBvbmUg4oCUIGBqb2Igc3VidGFza2AncyBgY2hlY2tgLiAqL1xuY29uc3Qgb25lU3VidGFza09wID0gKGludjogSW52b2NhdGlvbjxGbGFnPik6IHN0cmluZyB8IHVuZGVmaW5lZCA9PiB7XG4gIGNvbnN0IG1vZGVzID0gW2ludi5mbGFncy5hZGQsIGludi5mbGFncy5jaGVjaywgaW52LmZsYWdzLnVuY2hlY2tdLmZpbHRlcigodikgPT4gdiAhPT0gdW5kZWZpbmVkKTtcbiAgcmV0dXJuIG1vZGVzLmxlbmd0aCA9PT0gMVxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBcImdpdmUgZXhhY3RseSBvbmUgb2YgLS1hZGQgPGxhYmVsPiwgLS1jaGVjayA8c3VidGFza0lkPiBvciAtLXVuY2hlY2sgPHN1YnRhc2tJZD5cIjtcbn07XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZEpvYlN1YnRhc2socGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBpZCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXSBhcyBzdHJpbmc7XG4gIGNvbnN0IGpvYkJvZHkgPVxuICAgIHBhcnNlZC52YWx1ZXMuYWRkICE9PSB1bmRlZmluZWRcbiAgICAgID8geyBvcDogXCJhZGRcIiwgbGFiZWw6IHBhcnNlZC52YWx1ZXMuYWRkIH1cbiAgICAgIDogcGFyc2VkLnZhbHVlcy5jaGVjayAhPT0gdW5kZWZpbmVkXG4gICAgICAgID8geyBvcDogXCJjaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMuY2hlY2sgfVxuICAgICAgICA6IHsgb3A6IFwidW5jaGVja1wiLCBzdWJ0YXNrSWQ6IHBhcnNlZC52YWx1ZXMudW5jaGVjayB9O1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9L3N1YnRhc2tgKSwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoam9iQm9keSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kSm9iRGVsZXRlKHBhcnNlZDogUGFyc2VkKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgaWQgPSBwYXJzZWQucG9zaXRpb25hbHNbMF0gYXMgc3RyaW5nO1xuICBjb25zdCBwb3J0ID0gcmVxdWlyZURhZW1vbigpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChqb2JVcmwocG9ydCwgcGFyc2VkLCBgLyR7aWR9YCksIHsgbWV0aG9kOiBcIkRFTEVURVwiIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWN0aXZpdHkocGFyc2VkOiBQYXJzZWQpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBzdGF0ZSA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFBQ1RJVklUWV9TVEFURVMuaW5jbHVkZXMoc3RhdGUgYXMgKHR5cGVvZiBBQ1RJVklUWV9TVEFURVMpW251bWJlcl0pKSB7XG4gICAgLy8g4puUIE9ORSBBUlJBWSwgQ0hFQ0tFRCBBTkQgUFVCTElTSEVEIChBMSkuIFRoZSBtZW1iZXJzIHdlcmUgYSB0aHJlZS13YXlcbiAgICAvLyBgIT09YCBjaGFpbiBmb3IgdGhlIGNoZWNrIGFuZCB0aGUgc3RyaW5nIGA8cmVjZWl2ZWR8dGhpbmtpbmd8aWRsZT5gIGZvclxuICAgIC8vIHRoZSBtZXNzYWdlIOKAlCB0d28gY29waWVzIG9mIG9uZSBjbG9zZWQgc2V0LCBhbmQgdGhlIG1hY2hpbmUtcmVhZGFibGVcbiAgICAvLyBvbmUgZGlkIG5vdCBleGlzdC4gVGhpcyBpcyB0aGUgTEFTVCBlbnVtZXJhdGVkIHZhbHVlIGluIHRoaXMgZmlsZSB0aGF0XG4gICAgLy8gd2FzIHN0aWxsIHByb3NlLW9ubHk7IGV2ZXJ5IG90aGVyIHJlamVjdGlvbiBoZXJlIGFscmVhZHkgaGFkIGBjaG9pY2VzYC5cbiAgICB0aHJvdyB1c2FnZUVycm9yKFwidXNhZ2U6IGNsaS50cyBhY3Rpdml0eSA8c3RhdGU+IFstLW1lc3NhZ2UgPGlkPl1cIiwge1xuICAgICAgaGludDogXCJzdGF0ZSBpcyB0aGUgZmlyc3QgcG9zaXRpb25hbFwiLFxuICAgICAgY2hvaWNlczogWy4uLkFDVElWSVRZX1NUQVRFU10sXG4gICAgfSk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9hY3Rpdml0eSR7cXN9YCwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBzdGF0ZSwgbWVzc2FnZUlkOiBwYXJzZWQudmFsdWVzLm1lc3NhZ2UgfSksXG4gIH0pO1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHthd2FpdCBwYXNzT3JUaHJvdyhyZXMpfVxcbmApO1xuICByZXR1cm4gMDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU2VuZChwYXJzZWQ6IFBhcnNlZCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vIFJvdW5kIDMgKENsYWltIEMxKTogZ3JhcGV2aW5lJ3MgYm9keS1yZXNvbHV0aW9uIGNoYWluLCBwcmVjZWRlbmNlXG4gIC8vIC0tYm9keS1maWxlID4gLS1zdGRpbiA+IGlubGluZSBwb3NpdGlvbmFsID4gcGlwZWQtc3RkaW4gZGVmYXVsdC5cbiAgLy8gU2hhcnAgZWRnZSAobWVhc3VyZWQsIGhvdXNlLXdpZGUpOiB0aGUgcGlwZWQtc3RkaW4gZGVmYXVsdCBIQU5HU1xuICAvLyBGT1JFVkVSIHVuZGVyIGFnZW50IHNoZWxscyAoaXNUVFkgbnVsbCwgbm8gRU9GKSDigJQgbm8gcmVhZCB0aW1lb3V0IG9uXG4gIC8vIHB1cnBvc2UgKGl0IHdvdWxkIGJyZWFrIHNsb3cgcGlwZXMpOyBhbHdheXMgcGFzcyBhIGJvZHkuXG4gIGNvbnN0IGhhc0lubGluZSA9IHBhcnNlZC5wb3NpdGlvbmFscy5sZW5ndGggPiAwO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBsZXQgZnJvbUlubGluZSA9IGZhbHNlO1xuICBpZiAocGFyc2VkLnZhbHVlc1tcImJvZHktZmlsZVwiXSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgcGF0aCA9IHBhcnNlZC52YWx1ZXNbXCJib2R5LWZpbGVcIl07XG4gICAgaWYgKCFleGlzdHNTeW5jKHBhdGgpKSB7XG4gICAgICB0aHJvdyB1c2FnZUVycm9yKGBzZW5kOiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gKTtcbiAgICB9XG4gICAgLy8gVHJhaWxpbmcgbmV3bGluZSBzdHJpcHBlZCAoZmlsZXMgYW5kIGhlcmVkb2NzIGVuZCB3aXRoIG9uZTsgdGhlXG4gICAgLy8gbWVzc2FnZSBzaG91bGRuJ3QpIOKAlCBtYXRjaGluZyAtLXN0ZGluLCBhbmQgZ3JhcGV2aW5lLlxuICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpLnJlcGxhY2UoL1xcbiQvLCBcIlwiKTtcbiAgfSBlbHNlIGlmIChwYXJzZWQudmFsdWVzLnN0ZGluIHx8ICghaGFzSW5saW5lICYmICFwcm9jZXNzLnN0ZGluLmlzVFRZKSkge1xuICAgIHRleHQgPSAoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkucmVwbGFjZSgvXFxuJC8sIFwiXCIpO1xuICB9IGVsc2Uge1xuICAgIHRleHQgPSBwYXJzZWQucG9zaXRpb25hbHMuam9pbihcIiBcIik7XG4gICAgZnJvbUlubGluZSA9IHRydWU7XG4gIH1cbiAgLy8gQW4gRU1QVFkgcmVzb2x2ZWQgYm9keSBpcyBhIHVzYWdlIGVycm9yIChleGl0IDIpLCB3aGF0ZXZlciBwYXRoXG4gIC8vIHByb2R1Y2VkIGl0IOKAlCBhIGJsYW5rIG1lc3NhZ2UgaGVscHMgbm9ib2R5IGFuZCB1c3VhbGx5IG1lYW5zIGEgZnVtYmxlLlxuICBpZiAodGV4dCA9PT0gXCJcIikge1xuICAgIHRocm93IHVzYWdlRXJyb3IoXG4gICAgICBcInVzYWdlOiBjbGkudHMgc2VuZCA8dGV4dC4uLj4gfCAtLWJvZHktZmlsZSA8cGF0aD4gfCAtLXN0ZGluXFxuXCIgK1xuICAgICAgICBcIm1pbmQtbWFwcGVyOiBzZW5kIHJlc29sdmVkIGFuIGVtcHR5IGJvZHkg4oCUIG5vdGhpbmcgc2VudFxcblwiLFxuICAgICk7XG4gIH1cbiAgLy8gQSBmdW1ibGVkIGhlcmVkb2MgcGlwZXMgdGhlIGxpdGVyYWwgc2VuZCBpbnZvY2F0aW9uIGluIGFzIHRoZSBib2R5IOKAlFxuICAvLyByZWZ1c2UgdG8gcG9zdCB0aGF0IChuYXJyb3dlZCB0byB0aGUgc2VuZCB2ZXJiOyAtLWZvcmNlIG92ZXJyaWRlcyBmb3JcbiAgLy8gYSBib2R5IHRoYXQgZ2VudWluZWx5IHF1b3RlcyB0aGUgY29tbWFuZCkuXG4gIGlmICghcGFyc2VkLnZhbHVlcy5mb3JjZSAmJiAvKD86XnxcXG4pWyBcXHRdKmJ1blxcYlteXFxuXSpcXGJjbGlcXC50c1xcYlteXFxuXSpcXGJzZW5kXFxiLy50ZXN0KHRleHQpKSB7XG4gICAgdGhyb3cgdXNhZ2VFcnJvcihcbiAgICAgIFwibWluZC1tYXBwZXI6IHRoYXQgYm9keSBsb29rcyBsaWtlIGEgbGVha2VkIGNsaSBpbnZvY2F0aW9uIChhIGZ1bWJsZWQgaGVyZWRvYz8pLiBcIiArXG4gICAgICAgIFwiTm90aGluZyB3YXMgc2VudC4gUGlwZSB0aGUgcmVhbCBib2R5IHZpYSAtLXN0ZGluIG9yIC0tYm9keS1maWxlIDxwYXRoPiwgXCIgK1xuICAgICAgICBcIm9yIHBhc3MgLS1mb3JjZSB0byBzZW5kIGl0IGFueXdheS5cXG5cIixcbiAgICApO1xuICB9XG4gIC8vIElubGluZSBib2RpZXMgd2l0aCBzdXJ2aXZpbmcgc2hlbGwgbWV0YWNoYXJhY3RlcnMgbWFkZSBpdCB0aHJvdWdoIFRISVNcbiAgLy8gdGltZSDigJQgd2FybiAoc3RkZXJyLCBuZXZlciBibG9ja3MpIGFuZCBzdGVlciB0byB0aGUgc2hlbGwtZnJlZSBwYXRocy5cbiAgaWYgKGZyb21JbmxpbmUgJiYgL2B8XFwkXFwofFxcJFxcey8udGVzdCh0ZXh0KSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgXCIjIHdhcm5pbmc6IGlubGluZSBib2R5IGNvbnRhaW5zIHNoZWxsIG1ldGFjaGFyYWN0ZXJzIChiYWNrdGljaywgJCgpLCBjdXJseS1icmFjZSB2YXJzKS4gXCIgK1xuICAgICAgICBcIkl0IHdhcyBzZW50IGFzLWlzLCBidXQgdGhlIHNoZWxsIGNhbiBjb21tYW5kLXN1YnN0aXR1dGUgdGhlc2UgZmlyc3Qg4oCUIFwiICtcbiAgICAgICAgXCJ1c2UgLS1ib2R5LWZpbGUgb3IgLS1zdGRpbiBmb3IgY29kZS1iZWFyaW5nIG1lc3NhZ2VzLlxcblwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgcG9ydCA9IHJlcXVpcmVEYWVtb24oKTtcbiAgY29uc3QgcXMgPSBwYXJzZWQudmFsdWVzLnByb2plY3QgPyBgP3Byb2plY3Q9JHtlbmNvZGVVUklDb21wb25lbnQocGFyc2VkLnZhbHVlcy5wcm9qZWN0KX1gIDogXCJcIjtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fS9zZW5kJHtxc31gLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICByb2xlOiBwYXJzZWQudmFsdWVzLnJvbGUgPz8gXCJhZ2VudFwiLFxuICAgICAga2luZDogcGFyc2VkLnZhbHVlcy5raW5kID8/IFwidHVyblwiLFxuICAgICAgdGV4dCxcbiAgICAgIC8vIEZsYXR0ZW4gcmVwZWF0cywgc3BsaXQgY29tbWFzLCBkcm9wIGJsYW5rIGZyYWdtZW50cyDigJQgYW4gZW1wdHlcbiAgICAgIC8vIHJlc29sdmVkIGxpc3QgcG9zdHMgYXMgbm8gZ3JvdW5kIGF0IGFsbCAobmV2ZXIgW1wiXCJdKS5cbiAgICAgIGdyb3VuZDogKCgpID0+IHtcbiAgICAgICAgY29uc3QgcmVmcyA9IChwYXJzZWQudmFsdWVzLmdyb3VuZCA/PyBbXSlcbiAgICAgICAgICAuZmxhdE1hcCgoZykgPT4gZy5zcGxpdChcIixcIikpXG4gICAgICAgICAgLm1hcCgoZykgPT4gZy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcigoZykgPT4gZyAhPT0gXCJcIik7XG4gICAgICAgIHJldHVybiByZWZzLmxlbmd0aCA+IDAgPyByZWZzIDogdW5kZWZpbmVkO1xuICAgICAgfSkoKSxcbiAgICB9KSxcbiAgfSk7XG4gIGNvbnN0IHJlc3BvbnNlVGV4dCA9IGF3YWl0IHBhc3NPclRocm93KHJlcyk7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3Jlc3BvbnNlVGV4dH1cXG5gKTtcbiAgLy8gUm91bmQgMTEgKFNFQU0gMSk6IG1pcnJvciB0aGUgZGFlbW9uJ3MgdW5rbm93bi1jaGFubmVsIGFkdmlzb3J5IHRvIHN0ZGVycixcbiAgLy8gc2FtZSBhcyBwcm9wb3NlLWVkZ2UncyBkcmFmdCB3YXJuaW5nIOKAlCBhIHR5cG8nZCBgLS1raW5kYCBpcyBvdGhlcndpc2UgYVxuICAvLyBtZXNzYWdlIHRoYXQgc2lsZW50bHkgcmVuZGVycyBhcyBhIHBsYWluIGNoYXQgdHVybi5cbiAgdHJ5IHtcbiAgICBjb25zdCB7IHdhcm5pbmcgfSA9IEpTT04ucGFyc2UocmVzcG9uc2VUZXh0KSBhcyB7IHdhcm5pbmc/OiBzdHJpbmcgfTtcbiAgICBpZiAodHlwZW9mIHdhcm5pbmcgPT09IFwic3RyaW5nXCIpIHByb2Nlc3Muc3RkZXJyLndyaXRlKGAjIHdhcm5pbmc6ICR7d2FybmluZ31cXG5gKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogYm9keSBpcyB3aGF0IGl0IGlzICovXG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbi8vIOKUgOKUgCBUSEUgQ09NTUFORCBUQUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgZGlzcGF0Y2hlciwgdGhlIHBlci1wYXRoIGZsYWcgY2hlY2ssIHRoZSByZWplY3Rpb25zJyBgY2hvaWNlc2AsIGFyaXR5LFxuLy8gYC0tdmVyc2lvbmAgYW5kIHRoZSBgc2NoZW1hYCBkZWNsYXJhdGlvbiBhbGwgd2FsayBUSElTLCB0aHJvdWdoIHRoZSBob3VzZSdzXG4vLyBvbmUgcmVnaXN0cnkgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2ApLiBBIHBhdGggYWRkZWQgaGVyZSBpcyBkaXNwYXRjaGVkIGFuZFxuLy8gcHVibGlzaGVkIGJ5IGBzY2hlbWFgIGF0IG9uY2UuIFRoZSBoZWxwIHRleHQgaXMgdGhlIG9uZSBoYW5kLXdyaXR0ZW4gdmlld1xuLy8gKGBIRUxQYCBhYm92ZSk7IGBjbGktY29udHJhY3QudGVzdC50c2AgYmluZHMgaXQgdG8gdGhpcyB0YWJsZS5cblxuY29uc3Qgb25lID0gKG5hbWU6IHN0cmluZyk6IFBvc2l0aW9uYWxTcGVjW10gPT4gW3sgbmFtZSwgcmVxdWlyZWQ6IHRydWUgfV07XG5jb25zdCB3b3JkcyA9IChuYW1lOiBzdHJpbmcpOiBQb3NpdGlvbmFsU3BlY1tdID0+IFt7IG5hbWUsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XTtcbmNvbnN0IE5PTkU6IFBvc2l0aW9uYWxTcGVjW10gPSBbXTtcblxuY29uc3QgUk9XUzogQ29tbWFuZFNwZWM8RmxhZz5bXSA9IFtcbiAge1xuICAgIG5hbWU6IFwib3BlblwiLFxuICAgIGZsYWdzOiBbXCJuby1vcGVuXCIsIFwicG9ydFwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3Bhd24gKG9yIGZpbmQpIHRoZSBkYWVtb24sIHByaW50IGl0cyB1cmxcIixcbiAgICBydW46IG9uKGNtZE9wZW4pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdGF0ZVwiLFxuICAgIGZsYWdzOiBbXCJza2VsZXRvblwiLCBcImJhdGNoXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJ0aGUgcHJvamVjdCBzbmFwc2hvdFwiLFxuICAgIHJ1bjogb24oY21kU3RhdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjaGFuZ2VzXCIsXG4gICAgZmxhZ3M6IFtcInNpbmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJib3VuZGVkIGRlbHRhLCBhZGRpdGlvbnMgb25seVwiLFxuICAgIHJ1bjogb24oY21kQ2hhbmdlcyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogW1wic2luY2VcIiwgXCJpbmJvdW5kXCIsIFwib25jZVwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwiU1NFIGV2ZW50cyBhcyBKU09OTFwiLFxuICAgIHJ1bjogb24oY21kVGFpbCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb2plY3RzXCIsXG4gICAgZmxhZ3M6IFtcImNyZWF0ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJsaXN0IHByb2plY3RzIC8gY3JlYXRlIG9uZVwiLFxuICAgIHJ1bjogb24oY21kUHJvamVjdHMpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbmdlc3RcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJmaWxlXCIsIFwic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImFkZCBhIGRvY1wiLFxuICAgIHJ1bjogb24oY21kSW5nZXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJvcG9zZS1ub2RlXCIsXG4gICAgZmxhZ3M6IFtcInN0ZGluXCIsIFwiem9uZVwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3RhZ2UgYSBub2RlIHByb3Bvc2FsXCIsXG4gICAgcnVuOiBvbigocCkgPT4gY21kUHJvcG9zZShcInByb3Bvc2Utbm9kZVwiLCBwKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb3Bvc2UtZWRnZVwiLFxuICAgIGZsYWdzOiBbXCJzdGRpblwiLCBcInpvbmVcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcInN0YWdlIGFuIGVkZ2UgcHJvcG9zYWxcIixcbiAgICBydW46IG9uKChwKSA9PiBjbWRQcm9wb3NlKFwicHJvcG9zZS1lZGdlXCIsIHApKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicHJvcG9zZS1iYXRjaFwiLFxuICAgIGZsYWdzOiBbXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwic3RhZ2UgYSBzZXQgaW4gb25lIHR4blwiLFxuICAgIHJ1bjogb24oY21kUHJvcG9zZUJhdGNoKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmF0aWZ5LWJhdGNoXCIsXG4gICAgZmxhZ3M6IFtcInN0ZGluXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJyYXRpZnkgYSBzZXQgaW4gb25lIHR4blwiLFxuICAgIHJ1bjogb24oY21kUmF0aWZ5QmF0Y2gpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkZWxldGUtYmF0Y2hcIixcbiAgICBmbGFnczogW1wic3RkaW5cIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIHByb3Bvc2FsIHNldCBpbiBvbmUgdHhuXCIsXG4gICAgcnVuOiBvbihjbWREZWxldGVCYXRjaCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vZGUgYW5jaG9yXCIsXG4gICAgZmxhZ3M6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJub2RlSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiYW5jaG9yIGEgbm9kZSB1bmRlciBhIHBhcmVudCAoLS10bykgb3IgYmFjayB0byB0b3AtbGV2ZWwgKC0tY2xlYXIpXCIsXG4gICAgY2hlY2s6IHRvWG9yQ2xlYXIsXG4gICAgcnVuOiBvbihjbWROb2RlQW5jaG9yKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm9kZSBlZGl0XCIsXG4gICAgZmxhZ3M6IFtcInRpdGxlXCIsIFwic3lub3BzaXNcIiwgXCJzdGRpblwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcIm5vZGVJZFwiKSxcbiAgICBkZXNjcmliZTogXCJlZGl0IGEgbm9kZSdzIHRpdGxlL3N5bm9wc2lzXCIsXG4gICAgcnVuOiBvbihjbWROb2RlRWRpdCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vZGUgZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibm9kZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIG5vZGUgKC0tZm9yY2UgY2FzY2FkZXMpXCIsXG4gICAgcnVuOiBvbihjbWROb2RlRGVsZXRlKSxcbiAgfSxcbiAge1xuICAgIC8vIGBtZXNzYWdlYCBpcyBhbiBhZHZlcnRpc2VkIEFMSUFTIG9mIGByZWFkYCAob25lIG1lc3NhZ2UtZmV0Y2ggdmVyYiwgdHdvXG4gICAgLy8gc3BlbGxpbmdzKTogZGlzcGF0Y2hhYmxlLCBpbiBgdmVyYnNgLCBhbmQgZGVjbGFyZWQgb24gaXRzIG93biByb3cuXG4gICAgbmFtZTogXCJyZWFkXCIsXG4gICAgYWxpYXNlczogW1wibWVzc2FnZVwiXSxcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibWVzc2FnZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcIm9uZSBmdWxsIG1lc3NhZ2Ugcm93XCIsXG4gICAgcnVuOiBvbihjbWRSZWFkKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiem9uZSBjcmVhdGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogd29yZHMoXCJuYW1lXCIpLFxuICAgIGRlc2NyaWJlOiBcImNyZWF0ZSBhIHN0YWdpbmcgem9uZVwiLFxuICAgIHJ1bjogb24oY21kWm9uZUNyZWF0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInpvbmUgbGlzdFwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcImxpc3Qgem9uZXNcIixcbiAgICBydW46IG9uKGNtZFpvbmVMaXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiem9uZSBkZWxldGVcIixcbiAgICBmbGFnczogW1wieWVzXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiem9uZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImRlbGV0ZSBhIHpvbmUgKC0teWVzIHdoZW4gcG9wdWxhdGVkKVwiLFxuICAgIHJ1bjogb24oY21kWm9uZURlbGV0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInByb21vdGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwicHJvcG9zYWxJZFwiKSxcbiAgICBkZXNjcmliZTogXCJtb3ZlIGEgem9uZWQgcHJvcG9zYWwgdG8gdGhlIG1haW4gcXVldWVcIixcbiAgICBydW46IG9uKGNtZFByb21vdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcm9wb3NhbCB6b25lXCIsXG4gICAgZmxhZ3M6IFtcInRvXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJwcm9wb3NhbElkXCIpLFxuICAgIGRlc2NyaWJlOiBcIm1vdmUgYSBwZW5kaW5nIHByb3Bvc2FsIGludG8gYSB6b25lICgtLXRvKSBvciBiYWNrIHRvIG1haW4gKC0tY2xlYXIpXCIsXG4gICAgY2hlY2s6IHRvWG9yQ2xlYXIsXG4gICAgcnVuOiBvbihjbWRQcm9wb3NhbFpvbmUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJwcm9wb3NhbCBkZWxldGVcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwicHJvcG9zYWxJZFwiKSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBwcm9wb3NhbFwiLFxuICAgIHJ1bjogb24oY21kUHJvcG9zYWxEZWxldGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2NcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiZG9jSWRcIiksXG4gICAgZGVzY3JpYmU6IFwidGhlIGRvYyBlbnZlbG9wZVwiLFxuICAgIHJ1bjogb24oKHApID0+IGNtZERvYyhmYWxzZSwgcCkpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkb2MgZGVsZXRlXCIsXG4gICAgZmxhZ3M6IFtcImZvcmNlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiZG9jSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgZG9jICgtLWZvcmNlIGNhc2NhZGVzKVwiLFxuICAgIHJ1bjogb24oKHApID0+IGNtZERvYyh0cnVlLCBwKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvYyBraW5kXCIsXG4gICAgZmxhZ3M6IFtcImF1dGhvclwiLCBcImNsZWFyXCIsIFwicHJvamVjdFwiXSxcbiAgICAvLyDimqAgRkxBRy1ERVBFTkRFTlQgQVJJVFk6IGBkb2Mga2luZCA8ZG9jSWQ+IDxraW5kLi4uPmAgc2V0cywgYGRvYyBraW5kXG4gICAgLy8gPGRvY0lkPiAtLWNsZWFyYCBjbGVhcnMgYW5kIHRha2VzIG5vIGtpbmQuIFRoZSBkZWNsYXJhdGlvbiBjYW5ub3Qgc2F5XG4gICAgLy8gXCJyZXF1aXJlZCB1bmxlc3MgLS1jbGVhclwiLCBzbyBpdCBjYW4gb25seSBtYXJrIDxraW5kPiBvcHRpb25hbDsgYGNoZWNrYFxuICAgIC8vIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiZG9jSWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJraW5kXCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcImFzc2VydCAoPGtpbmQ+KSBvciBjbGVhciAoLS1jbGVhcikgYSBkb2MncyBraW5kXCIsXG4gICAgY2hlY2s6IChpbnYpID0+IHtcbiAgICAgIGNvbnN0IGNsZWFyID0gaW52LmZsYWdzLmNsZWFyID09PSB0cnVlO1xuICAgICAgaWYgKGNsZWFyICYmIGludi5wb3MubGVuZ3RoID4gMSkgcmV0dXJuIFwiLS1jbGVhciB0YWtlcyBubyA8a2luZD5cIjtcbiAgICAgIGlmICghY2xlYXIgJiYgaW52LnBvcy5sZW5ndGggPCAyKSByZXR1cm4gXCJtaXNzaW5nIHJlcXVpcmVkIDxraW5kPiAob3IgcGFzcyAtLWNsZWFyKVwiO1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICAgIHJ1bjogb24oY21kRG9jS2luZCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1hcmtcIixcbiAgICBmbGFnczogW1wic3RhdHVzXCIsIFwibm90ZVwiLCBcImF1dGhvclwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcImRvY0lkXCIpLFxuICAgIGRlc2NyaWJlOiBcImFwcGVuZCBhIGRvYyBzdGF0dXMgbWFya1wiLFxuICAgIHJ1bjogb24oY21kTWFyayksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNlYXJjaFwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiB3b3JkcyhcInF1ZXJ5XCIpLFxuICAgIGRlc2NyaWJlOiBcIkZUUyBvdmVyIG5vZGVzLCBkb2NzLCBtZXNzYWdlc1wiLFxuICAgIHJ1bjogb24oY21kU2VhcmNoKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibmVpZ2hib3JzXCIsXG4gICAgZmxhZ3M6IFtcImRlcHRoXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwibm9kZUlkXCIpLFxuICAgIGRlc2NyaWJlOiBcImxvY2FsIGhvb2QgKyBlZGdlIHJlYXNvbnNcIixcbiAgICBydW46IG9uKGNtZE5laWdoYm9ycyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInJhdGlmeVwiLFxuICAgIGZsYWdzOiBbXCJydWxpbmdcIiwgXCJkb2MtZWRpdFwiLCBcImRvY1wiLCBcInNwYW5cIiwgXCJhbmNob3JcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJwcm9wb3NhbElkXCIpLFxuICAgIGRlc2NyaWJlOiBcInJ1bGUgb24gYSBwcm9wb3NhbFwiLFxuICAgIHJ1bjogb24oY21kUmF0aWZ5KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibGVucyBzZXRcIixcbiAgICBmbGFnczogW1wibm9kZVwiLCBcImRvY1wiLCBcImRlcHRoXCIsIFwib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBOT05FLFxuICAgIGRlc2NyaWJlOiBcInNldCB0aGUgbGVucyBvbiBhIG5vZGUgKC0tbm9kZSkgb3IgYSBkb2MgKC0tZG9jKVwiLFxuICAgIGNoZWNrOiAoaW52KSA9PiB7XG4gICAgICBpZiAoaW52LmZsYWdzLm5vZGUgIT09IHVuZGVmaW5lZCAmJiBpbnYuZmxhZ3MuZG9jICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcmV0dXJuIFwibGVucyBzZXQgdGFrZXMgLS1ub2RlIE9SIC0tZG9jLCBub3QgYm90aFwiO1xuICAgICAgfVxuICAgICAgaWYgKGludi5mbGFncy5kb2MgIT09IHVuZGVmaW5lZCAmJiBpbnYuZmxhZ3MuZGVwdGggIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4gXCItLWRlcHRoIGFwcGxpZXMgdG8gYSBub2RlIGxlbnMgb25seVwiO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9LFxuICAgIHJ1bjogb24oY21kTGVuc1NldCksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImxlbnMgY2xlYXJcIixcbiAgICBmbGFnczogW1wicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJjbGVhciB0aGUgbGVuc1wiLFxuICAgIHJ1bjogb24oY21kTGVuc0NsZWFyKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibG9vay1oZXJlXCIsXG4gICAgZmxhZ3M6IFtcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcIm5vZGVJZFwiKSxcbiAgICBkZXNjcmliZTogXCJmaXJlLW9uY2UgYXR0ZW50aW9uIG51ZGdlXCIsXG4gICAgcnVuOiBvbihjbWRMb29rSGVyZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGlvbnNcIixcbiAgICBmbGFnczogW1wic2V0XCIsIFwic3RkaW5cIiwgXCJjbGVhclwiLCBcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IG9uZShcInRhcmdldElkXCIpLFxuICAgIGRlc2NyaWJlOiBcImFjdGlvbiBzbG90cyBvbiBhIG5vZGUvcGVuZGluZyBwcm9wb3NhbFwiLFxuICAgIGNoZWNrOiBleGFjdGx5T25lTW9kZSxcbiAgICBydW46IG9uKGNtZEFjdGlvbnMpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YWdzXCIsXG4gICAgZmxhZ3M6IFtcInNldFwiLCBcInN0ZGluXCIsIFwiY2xlYXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJ0YXJnZXRJZFwiKSxcbiAgICBkZXNjcmliZTogXCJmcmVlZm9ybSB0YWdzIG9uIGEgbm9kZS9wZW5kaW5nIHByb3Bvc2FsXCIsXG4gICAgY2hlY2s6IGV4YWN0bHlPbmVNb2RlLFxuICAgIHJ1bjogb24oY21kVGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiBjcmVhdGVcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogTk9ORSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBqb2JcIixcbiAgICBydW46IG9uKGNtZEpvYkNyZWF0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiB1cGRhdGVcIixcbiAgICBmbGFnczogW1widGl0bGVcIiwgXCJzdGF0dXNcIiwgXCJkZWxpdmVyYWJsZVwiLCBcImRldGFpbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiam9iSWRcIiksXG4gICAgZGVzY3JpYmU6IFwidXBkYXRlIGEgam9iXCIsXG4gICAgcnVuOiBvbihjbWRKb2JVcGRhdGUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJqb2IgY2xhaW1cIixcbiAgICBmbGFnczogW1wib3duZXJcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJjbGFpbSBhIGpvYiAoYXRvbWljIGxlYXNlKVwiLFxuICAgIHJ1bjogb24oY21kSm9iQ2xhaW0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJqb2IgcmVsZWFzZVwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJyZWxlYXNlIGEgam9iXCIsXG4gICAgcnVuOiBvbihjbWRKb2JSZWxlYXNlKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiam9iIHN1YnRhc2tcIixcbiAgICBmbGFnczogW1wiYWRkXCIsIFwiY2hlY2tcIiwgXCJ1bmNoZWNrXCIsIFwicHJvamVjdFwiXSxcbiAgICBwb3NpdGlvbmFsczogb25lKFwiam9iSWRcIiksXG4gICAgZGVzY3JpYmU6IFwiYWRkLCBjaGVjayBvciB1bmNoZWNrIGEgam9iJ3Mgc3ViLXRhc2tcIixcbiAgICBjaGVjazogb25lU3VidGFza09wLFxuICAgIHJ1bjogb24oY21kSm9iU3VidGFzayksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImpvYiBsaXN0XCIsXG4gICAgZmxhZ3M6IFtcInByb2plY3RcIl0sXG4gICAgcG9zaXRpb25hbHM6IE5PTkUsXG4gICAgZGVzY3JpYmU6IFwibGlzdCBqb2JzXCIsXG4gICAgcnVuOiBvbihjbWRKb2JMaXN0KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiam9iIGRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJqb2JJZFwiKSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBqb2JcIixcbiAgICBydW46IG9uKGNtZEpvYkRlbGV0ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGl2aXR5XCIsXG4gICAgZmxhZ3M6IFtcIm1lc3NhZ2VcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBvbmUoXCJzdGF0ZVwiKSxcbiAgICBkZXNjcmliZTogXCJ0aGUgY2FzdGluZy1sb29wIGxpdmVuZXNzIHNpZ25hbCAocmVjZWl2ZWR8dGhpbmtpbmd8aWRsZSlcIixcbiAgICBydW46IG9uKGNtZEFjdGl2aXR5KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VuZFwiLFxuICAgIGZsYWdzOiBbXCJyb2xlXCIsIFwia2luZFwiLCBcImdyb3VuZFwiLCBcImJvZHktZmlsZVwiLCBcInN0ZGluXCIsIFwiZm9yY2VcIiwgXCJwcm9qZWN0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJwb3N0IGEgbWVzc2FnZVwiLFxuICAgIHJ1bjogb24oY21kU2VuZCksXG4gIH0sXG5dO1xuXG4vLyDim5QgQlVJTERJTkcgVEhFIFRBQkxFIEhBUyBOTyBTSURFIEVGRkVDVFMuIGBkZWZpbmVDbGlgIG9ubHkgdmFsaWRhdGVzIGFuZFxuLy8gaW5kZXhlczsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgcnVucy4gU28gYSBncmltb2lyZVxuLy8gd2FyZCwgb3IgYSB0ZXN0LCBjYW4gaW1wb3J0IHRoaXMgbW9kdWxlIGFuZCByZWFkIGBjbGkucmVjb2duaXplZEZsYWdzYCxcbi8vIGBjbGkuZmxhZ3NGb3JgIGFuZCBgY2xpLmRlY2xhcmF0aW9uKClgIHdpdGhvdXQgcnVubmluZyB0aGUgQ0xJLlxuZXhwb3J0IGNvbnN0IGNsaSA9IGRlZmluZUNsaSh7XG4gIG5hbWU6IFwibWluZC1tYXBwZXJcIixcbiAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gIGNvbW1hbmRzOiBST1dTLFxuICAvLyBUaGUgdmVyYiBpcyB0aGUgZmlyc3QgYXJndW1lbnQ6IGBtaW5kLW1hcHBlciAtLXByb2plY3QgcCBzdGF0ZWAgaXMgcmVmdXNlZFxuICAvLyBhcyBhbiB1bmtub3duIHJvb3QgZmxhZy4gQSBiYXJlIGAtLWAgbWFrZXMgdGhlIG5leHQgdG9rZW4gdGhlIHZlcmIgKGFjYyBBNikuXG4gIGdyYW1tYXI6IFwidmVyYi1maXJzdFwiLFxuICAvLyBgZG9jYCB0YWtlcyBmbGFncyBCRUZPUkUgaXRzIHN1Yi12ZXJiIChgZG9jIC0tcHJvamVjdCBQIGRlbGV0ZSBEMWApLCBzb1xuICAvLyBpdHMgc3ViLXZlcmIgaXMgdGhlIGZpcnN0IHBvc2l0aW9uYWwsIG5vdCB0aGUgYWRqYWNlbnQgdG9rZW4uIFRoZSBvdGhlclxuICAvLyBncm91cHMgKG5vZGUsIHpvbmUsIHByb3Bvc2FsLCBsZW5zLCBqb2IpIGtlZXAgdGhlIGRlZmF1bHQ6IGFkamFjZW50LlxuICBncm91cHM6IHsgZG9jOiB7IHN1YlZlcmJBdDogXCJmaXJzdC1wb3NpdGlvbmFsXCIgfSB9LFxuICB2ZXJzaW9uOiB2ZXJzaW9uSW5mbyxcbiAgaGVscDogKCkgPT4gSEVMUCxcbn0pO1xuXG4vLyBUaGUgZGVyaXZlZCB2aWV3cyB0aGUgdGVzdHMgcmVhZC4gVkVSQlMgaXMgdGhlIHJvc3RlciAodGhlIG1vZHVsZSdzIG93blxuLy8gYHZlcnNpb25gLCBgc2NoZW1hYCBhbmQgYGhlbHBgIHJvd3MgaW5jbHVkZWQpOyBWRVJCX1NQRUMgaXMgZWFjaCBwYXRoJ3Ncbi8vIGFjY2VwdGVkIGZsYWdzLCBrZXllZCBieSBwYXRoIChgXCJub2RlIGVkaXRcImApLlxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS52ZXJicztcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgY2xpLnJvd3MubWFwKChyKSA9PiBbci5uYW1lLCByLmFjY2VwdGVkXSksXG4pO1xuZXhwb3J0IGNvbnN0IFJFQ09HTklaRURfRkxBR1M6IHJlYWRvbmx5IHN0cmluZ1tdID0gY2xpLnJlY29nbml6ZWRGbGFncztcblxuLyoqXG4gKiBUSEUgT05FIFBMQUNFIEEgRkFJTFVSRSBCRUNPTUVTIEFOIEVYSVQgQ09ERS4gRXZlcnkgcmFpc2UgaW4gdGhpcyBmaWxlIFRIUk9XU1xuICogKHRoZSBraXQncyBgZGllYC9gQ2xpRXJyb3JgKSwgYXJyaXZlcyBoZXJlLCBpcyB3cml0dGVuIGFzIE9ORSBKU09OIGVudmVsb3BlXG4gKiBvbiBzdGRlcnIsIGFuZCBiZWNvbWVzIGEgdGF4b25vbXkgZXhpdCBjb2RlIOKAlCBub3RoaW5nIGV4aXRzIGZyb20gaW5zaWRlIGFcbiAqIHZlcmIsIHNvIGEgbGFyZ2Ugc3Rkb3V0IHBheWxvYWQgaXMgbmV2ZXIgdHJ1bmNhdGVkLlxuICpcbiAqIGBjbGkuZGlzcGF0Y2hgLCBub3QgdGhlIHJlZ2lzdHJ5J3MgYG1haW5gLCBiZWNhdXNlIG1pbmQtbWFwcGVyIHRyaWFnZXMgdHdvXG4gKiByYXcgdGhyb3dzIHRoZSByZWdpc3RyeSBjYW5ub3Qga25vdyBhYm91dC5cbiAqXG4gKiDim5QgVEhFIEtJVCdTIFJFUE9SVEVSIFNJVFMgSU5TSURFIFRISVMgQ0hBSU4sIE5PVCBJTiBQTEFDRSBPRiBJVC4gSXQgd3JpdGVzXG4gKiB0aGUgZW52ZWxvcGUgZm9yIGEgdHlwZWQgZmFpbHVyZSBhbmQgcmV0dXJucyBgbnVsbGAgZm9yIGV2ZXJ5dGhpbmcgZWxzZSwgc29cbiAqIHRoZSB0d28gdXNhZ2UgY2xhc3NlcyBiZWxvdyBhcmUgY2xhc3NpZmllZCBIRVJFOiBhIGJvZHkgdGhhdCBmYWlsZWQgdG8gcGFyc2VcbiAqIGFzIEpTT04gKHN0ZGluLy0tYm9keS1maWxlKSwgYW5kIGEgbmFtZWQgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZVxuICogKC0tZmlsZS8tLWRvYy1lZGl0KS4gQSBiYXJlIGByZXBvcnRDbGlFcnJvcihlKSA/PyByZXRocm93YCB3b3VsZCB0dXJuIGJvdGhcbiAqIGludG8gc3RhY2stdHJhY2UgY3Jhc2hlcyAoY2Fzc2FuZHJhJ3MgUDIgZ2F0ZSBmaW5kaW5nKS4gTm9kZSdzIG93biBwYXJzZVxuICogcmVqZWN0aW9ucyBubyBsb25nZXIgcmVhY2ggaGVyZTogdGhlIHJlZ2lzdHJ5IGNhdGNoZXMgdGhlbSBhbmQgYW5zd2VycyB3aXRoXG4gKiB0aGUgdmVyYidzIGFjY2VwdGVkIHNldCBhcyBgY2hvaWNlc2AuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBjbGkuZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIEEgYm9keSB0aGF0IGZhaWxlZCB0byBwYXJzZSAoc3RkaW4vLS1ib2R5LWZpbGUgSlNPTikg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoZSBpbnN0YW5jZW9mIFN5bnRheEVycm9yKSByZXR1cm4gcmVwb3J0VXNhZ2UoYGludmFsaWQgSlNPTjogJHttc2d9YCk7XG4gICAgLy8gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWZpbGUvLS1kb2MtZWRpdCBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydFVzYWdlKG1zZyk7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIG1pbmQtbWFwcGVyJ3Mgb3duIGZhdWx0OiBvbmUgSU5URVJOQUwgZW52ZWxvcGUsIG5ldmVyXG4gICAgLy8gYSBzdGFjayB0cmFjZSDigJQgdGhlIHByb2Nlc3MgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuXG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShcImludGVybmFsXCIsIG1zZykpO1xuICAgIHJldHVybiBFWElUX0ZPUi5pbnRlcm5hbDtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBDTEkncyBvbmUgZW50cnksIGNhbGxlZCBieSB0aGUgbGF1bmNoZXIgYXRcbiAqIGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWluZC1tYXBwZXIvc2NyaXB0cy9jbGkudHNgLlxuICpcbiAqIOKblCBUSEVSRSBJUyBOTyBgaW1wb3J0Lm1ldGEubWFpbmAgQkxPQ0ssIEFORCBUSEFUIElTIFRIRSBQT0lOVC5cbiAqIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnkgdGhlIGxhdW5jaGVyLCBuZXZlciBleGVjdXRlZCBhcyB0aGUgcHJvY2Vzc1xuICogZW50cnksIHNvIGBpbXBvcnQubWV0YS5tYWluYCBpcyBGQUxTRSBpbiB0aGUgYnVuZGxlOiBhIGJsb2NrIGhlcmUgd291bGQgbmV2ZXJcbiAqIHJ1biBhbmQgdGhlIENMSSB3b3VsZCBwcmludCBub3RoaW5nIGFuZCBleGl0IDAgZm9yIGV2ZXJ5IHZlcmIuIFRoaXMgZXhwb3J0IGlzXG4gKiB3aGF0IHJlcGxhY2VzIGl0LiBBbmQgdGhlIHNvdXJjZSBrZWVwcyBubyBzZWNvbmQgZW50cnkgZGVsaWJlcmF0ZWx5IOKAlCB0aGVcbiAqIGFyaXRobWV0aWMgYWJvdmUgaXMgdHJ1ZSBhdCB0aGUgYXJ0aWZhY3QncyBhZGRyZXNzIGFuZCBmYWxzZSBhdCB0aGlzIGZpbGUncyxcbiAqIHNvIG9mZmVyaW5nIGBidW4gc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvY2xpLnRzYCB3b3VsZCBiZSBvZmZlcmluZyBhIHdyb25nXG4gKiBwcm9jZXNzIChwbGF5Ym9vayBCMykuXG4gKlxuICog4puUIElUIFJFVFVSTlMgVEhFIENPREUgUkFUSEVSIFRIQU4gU0VUVElORyBJVC4gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsXG4gKiByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZVxuICogKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhbiBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3RcbiAqIGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seVxuICogdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lXG4gKiBzaGFwZSwgc2FtZSByZWFzb24uIFRoZSBhc3NpZ25tZW50IGhhcHBlbnMgb25jZSwgaW4gdGhlIGxhdW5jaGVyLiBEbyBub3QgdGlkeVxuICogdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAqXG4gKiDim5QgQU5EIElUIFRBS0VTIE5PIEFSR1VNRU5UUzogdGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgUEFSU0VTXG4gKiBpdCwgd2hpY2ggaXMgdGhpcyBvbmUuIEEgbGF1bmNoZXIgcmVhZGluZyB0aGUgYXJndW1lbnQgdmVjdG9yIHdvdWxkIG1hdGNoIHRoZVxuICogYXJnLXBhcnNpbmcgcHJlZGljYXRlIGluIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBUaGUgbW9kdWxlIGFkZHMgYGhlbHBgLCBgdmVyc2lvbmAgYW5kIGBzY2hlbWFgIHJvd3MgdW5sZXNzIHRoZSBzcGVsbCBkZWZpbmVzXG4gKiBhIHJvdyBvZiB0aGF0IG5hbWUgKGdyYXBldmluZSdzIGB2ZXJzaW9uIC0taHVtYW5gKS4gVGhleSBhcmUgb3JkaW5hcnkgcm93czpcbiAqIGRlY2xhcmVkLCBzdHJpY3QsIGFuZCBnaXZlbiBgZ2xvYmFsRmxhZ3NgIGxpa2UgZXZlcnkgb3RoZXIgcm93LlxuICovXG5cbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBDbGlFcnJvciwgZGllLCByZXBvcnRDbGlFcnJvciwgc2V0Q3VycmVudENvbW1hbmQgfSBmcm9tIFwiLi4vd2lyZS9lcnJvcnNcIjtcblxuLy8g4pSA4pSAIHR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgdHlwZSBGbGFnVHlwZSA9IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjtcblxuLyoqIE9uZSBgcGFyc2VBcmdzYCBvcHRpb24sIHBsdXMgdGhlIGBkZWZhdWx0YCBub2RlJ3MgcGFyc2VyIGFsc28gdGFrZXMuICovXG5leHBvcnQgdHlwZSBPcHRpb25TcGVjID0ge1xuICB0eXBlOiBGbGFnVHlwZTtcbiAgbXVsdGlwbGU/OiBib29sZWFuO1xuICBzaG9ydD86IHN0cmluZztcbiAgZGVmYXVsdD86IHN0cmluZyB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHJlYWRvbmx5IGJvb2xlYW5bXTtcbn07XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnNUYWJsZSA9IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIE9wdGlvblNwZWM+PjtcblxuZXhwb3J0IHR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG5leHBvcnQgdHlwZSBGbGFnVmFsdWUgPSBzdHJpbmcgfCBib29sZWFuIHwgKHN0cmluZyB8IGJvb2xlYW4pW107XG5cbmV4cG9ydCB0eXBlIEludm9jYXRpb248RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSB7XG4gIC8qKiBUaGUgcmVzb2x2ZWQgcm93IG5hbWU6IGBcIm9wZW5cImAsIGBcIm5vZGUgZWRpdFwiYCwgb3IgYFwiXCJgIGZvciBhIHZlcmJsZXNzIHJvb3QuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzcGVsbGluZyB0aGUgY2FsbGVyIHVzZWQg4oCUIGFuIGFsaWFzLCB3aGVuIG9uZSB3YXMgdXNlZC4gKi9cbiAgdG9rZW46IHN0cmluZztcbiAgLyoqIFBvc2l0aW9uYWxzIGFmdGVyIHRoZSBwYXRoLiAqL1xuICBwb3M6IHN0cmluZ1tdO1xuICAvKiogRmxhZ3MgZ2l2ZW4sIHBsdXMgdGhlIGRlZmF1bHRzIG9mIHRoZSBmbGFncyB0aGlzIHJvdyBhY2NlcHRzLiAqL1xuICBmbGFnczogUGFydGlhbDxSZWNvcmQ8RiwgRmxhZ1ZhbHVlPj47XG59O1xuXG5leHBvcnQgdHlwZSBDb21tYW5kU3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIGBcIm9wZW5cImA7IG9uZSBzcGFjZSBtZWFucyBvbmUgbGV2ZWwgb2YgbmVzdGluZzogYFwibm9kZSBlZGl0XCJgLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFYWNoIGFsaWFzIGlzIGRpc3BhdGNoYWJsZSwgbGlzdGVkIGluIGB2ZXJic2AsIGFuZCBnZXRzIGl0cyBvd24gZGVjbGFyZWRcbiAgICogIHJvdy4gQW4gYWxpYXMgb2YgYSBuZXN0ZWQgcm93IG11c3Qgc2hhcmUgaXRzIGdyb3VwOiBgXCJub2RlIGNoYW5nZVwiYC4gKi9cbiAgYWxpYXNlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhpcyByb3cncyBvd24gZmxhZ3M7IGBnbG9iYWxGbGFnc2AgYXJlIGFkZGVkIHRvIHRoZW0uICovXG4gIGZsYWdzOiByZWFkb25seSBGW107XG4gIC8qKiBBcml0eSBpcyBlbmZvcmNlZCBmcm9tIHRoaXMsIGFuZCBpdCBpcyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcy4gKi9cbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIC8qKiBPbmUgbGluZSBmb3IgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBBZGRlZCBhcyB0aGUgYGhpbnRgIG9mIHRoaXMgcm93J3MgZmxhZyByZWplY3Rpb25zLiAqL1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICAvKiogYGZhbHNlYCBoYW5kcyBub2RlJ3Mgb3duIFwiVW5leHBlY3RlZCBhcmd1bWVudFwiIHJlZnVzYWwgYW55IHBvc2l0aW9uYWwuICovXG4gIGFsbG93UG9zaXRpb25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogRmxhZy1kZXBlbmRlbnQgYXJpdHkgKGltYWdvIGBoYW5kb2ZmIC0tY2xlYXJgLCBtaW5kLW1hcHBlciBgLS10b3wtLWNsZWFyYClcbiAgICogYW5kIGFueSBvdGhlciBjb21iaW5hdGlvbiBydWxlLiBSdW5zIGFmdGVyIHRoZSBhcml0eSBjaGVjazsgYSByZXR1cm5lZFxuICAgKiBzdHJpbmcgaXMgcmVmdXNlZCBhcyBhIHVzYWdlIGVycm9yIG5hbWluZyB0aGlzIHJvdy4g4pqgIFRoZSBkZWNsYXJhdGlvblxuICAgKiBjYW5ub3QgZXhwcmVzcyBzdWNoIGEgcnVsZTogYSBwb3NpdGlvbmFsIHRoYXQgYC0tY2xlYXJgIG1ha2VzIHVubmVjZXNzYXJ5XG4gICAqIGNhbiBvbmx5IGJlIGRlY2xhcmVkIGByZXF1aXJlZDogZmFsc2VgLCBhbmQgdGhpcyBob29rIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgKi9cbiAgY2hlY2s/OiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIG51bWJlciBpcyB0aGUgZXhpdCBjb2RlOyBhbnl0aGluZyBlbHNlIG1lYW5zIDAuICovXG4gIHJ1bjogKGludjogSW52b2NhdGlvbjxGPikgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBBIHZlcmJsZXNzIENMSSdzIG9uZSByb3cgKGRpZ2VzdGlmeSkuIGBwYXRoOiBbXWAgaW4gdGhlIGRlY2xhcmF0aW9uLiAqL1xuZXhwb3J0IHR5cGUgUm9vdFNwZWM8RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSBPbWl0PENvbW1hbmRTcGVjPEY+LCBcIm5hbWVcIiB8IFwiYWxpYXNlc1wiPjtcblxuLyoqXG4gKiBXaGVyZSBhIGdyb3VwJ3Mgc3ViLXZlcmIgaXMgZm91bmQuXG4gKiAtIGBhZGphY2VudGAgKGRlZmF1bHQpOiB0aGUgdG9rZW4gcmlnaHQgYWZ0ZXIgdGhlIGdyb3VwIChgbm9kZSBlZGl0IFhgKS5cbiAqIC0gYGZpcnN0LXBvc2l0aW9uYWxgOiB0aGUgZmlyc3QgdG9rZW4gYWZ0ZXIgdGhlIGdyb3VwIHRoYXQgaXMgbmVpdGhlciBhIGZsYWdcbiAqICAgbm9yIGEgc3RyaW5nIGZsYWcncyB2YWx1ZSwgc28gZmxhZ3MgbWF5IGNvbWUgZmlyc3Q6XG4gKiAgIGBkb2MgLS1wcm9qZWN0IFAgZGVsZXRlIEQxIC0tZm9yY2VgIHJlc29sdmVzIHRvIGBkb2MgZGVsZXRlYCAobWluZC1tYXBwZXIpLlxuICogICBUaGUgc2NhbiBzdG9wcyBhdCBhIGJhcmUgYC0tYCwgd2hpY2ggaXMgdGhlIGVzY2FwZSBoYXRjaCBmb3IgYSBwb3NpdGlvbmFsXG4gKiAgIGxpdGVyYWxseSBuYW1lZCBsaWtlIGEgc3ViLXZlcmI6IGBkb2MgLS0gZGVsZXRlYCByZWFkcyB0aGUgZG9jIFwiZGVsZXRlXCIuXG4gKi9cbmV4cG9ydCB0eXBlIEdyb3VwU3BlYyA9IHsgc3ViVmVyYkF0PzogXCJhZGphY2VudFwiIHwgXCJmaXJzdC1wb3NpdGlvbmFsXCIgfTtcblxuZXhwb3J0IHR5cGUgQ2xpU3BlYzxPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPiA9IHtcbiAgLyoqIGBcImJvdW50eVwiYCwgdXNlZCBpbiBtZXNzYWdlcyBhbmQgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSByZW5kZXJlZCBoZWxwJ3MgZmlyc3QgbGluZTogYCR7bmFtZX0g4oCUICR7c3VtbWFyeX1gLiAqL1xuICBzdW1tYXJ5Pzogc3RyaW5nO1xuICAvKiogVGhlIGxpdGVyYWwgYENMSV9PUFRJT05TYCBvYmplY3QuICovXG4gIG9wdGlvbnM6IE87XG4gIGNvbW1hbmRzPzogcmVhZG9ubHkgQ29tbWFuZFNwZWM8a2V5b2YgTyAmIHN0cmluZz5bXTtcbiAgLyoqXG4gICAqIEEgdmVyYmxlc3MgQ0xJJ3Mgcm93LiBSZXNlcnZlZCB0b2tlbnMgYXMgYGFyZ3ZbMF1gIHN0aWxsIHNlbGVjdCB0aGVpciByb3dzXG4gICAqIChgaGVscGAsIGB2ZXJzaW9uYCwgYHNjaGVtYWAsIGFueSBgY29tbWFuZHNgLCBhbmQgdGhlIGludGVyY2VwdG9ycyk7IGV2ZXJ5XG4gICAqIG90aGVyIGFyZ3YsIHRoZSBlbXB0eSBvbmUgaW5jbHVkZWQsIGJlbG9uZ3MgdG8gdGhlIHJvb3QuIEEgcG9zaXRpb25hbCB0aGF0XG4gICAqIGhhcHBlbnMgdG8gc3BlbGwgYSByZXNlcnZlZCB0b2tlbiBnb2VzIGFmdGVyIGEgYmFyZSBgLS1gLlxuICAgKi9cbiAgcm9vdD86IFJvb3RTcGVjPGtleW9mIE8gJiBzdHJpbmc+O1xuICAvKiogQWNjZXB0ZWQgYnkgZXZlcnkgcm93LCBieSBjb250cmFjdCAoZ3JhcGV2aW5lJ3MgYC0tYXNgL2AtLWZyb21gKS4gKi9cbiAgZ2xvYmFsRmxhZ3M/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgZ3JhbW1hcj86IFwidmVyYi1maXJzdFwiIHwgXCJmbGFncy1hbnl3aGVyZVwiO1xuICAvKiogUGVyLWdyb3VwIHN1Yi12ZXJiIHBsYWNlbWVudCwga2V5ZWQgYnkgdGhlIGdyb3VwIHRva2VuIChgXCJkb2NcImApLiAqL1xuICBncm91cHM/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBHcm91cFNwZWM+PjtcbiAgLyoqIFRoZSByb290IHJvdydzIHBvc2l0aW9uYWwgbmFtZSBpbiBgc2NoZW1hYCAoYFwiY29tbWFuZFwiYDsgZ2xhbW91cjogYFwidmVyYlwiYCkuICovXG4gIHZlcmJQb3NpdGlvbmFsPzogc3RyaW5nO1xuICAvKiogRmxhZ3MgbGVmdCBvZmYgZXZlcnkgdXNhZ2UgbGluZSAoZ2xhbW91cidzIHBlci12ZXJiIGBzZXNzaW9uYCkuICovXG4gIHVzYWdlSGlkZXM/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgLyoqIFRoZSBgdmVyc2lvbmAgcm93J3MgcGF5bG9hZCwgYHtuYW1lLCB2ZXJzaW9ufWAuICovXG4gIHZlcnNpb246ICgpID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gIC8qKiBSZXBsYWNlcyB0aGUgcmVuZGVyZWQgaGVscCAoZ3JhcGV2aW5lKS4gKi9cbiAgaGVscD86ICgpID0+IHN0cmluZztcbiAgLyoqIEFwcGVuZGVkIGJlbG93IHRoZSByZW5kZXJlZCByb3dzLiAqL1xuICBoZWxwRm9vdGVyPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgRGVjbGFyZWRBcmcgPSB7IG5hbWU6IHN0cmluZzsgdHlwZTogRmxhZ1R5cGU7IHN0YXR1czogXCJ2YWxpZFwiIH07XG5leHBvcnQgdHlwZSBEZWNsYXJlZENvbW1hbmQgPSB7XG4gIHBhdGg6IHN0cmluZ1tdO1xuICBhcmdzOiBEZWNsYXJlZEFyZ1tdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbn07XG5leHBvcnQgdHlwZSBEZWNsYXJhdGlvbiA9IHtcbiAgZm9ybWF0VmVyc2lvbjogXCIwXCI7XG4gIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiO1xuICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogc3RyaW5nW10gfTtcbiAgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdO1xufTtcblxuLyoqIEEgcm93IGFzIHRoZSBtb2R1bGUgaG9sZHMgaXQsIGZvciB0ZXN0cyBhbmQgd2FyZHMuICovXG5leHBvcnQgdHlwZSBSb3dWaWV3ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhlIHJvdydzIG93biBmbGFncywgYXMgZGVjbGFyZWQuICovXG4gIGZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIE93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2AsIGluIG9wdGlvbnMtdGFibGUgb3JkZXIuICovXG4gIGFjY2VwdGVkOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBgdHJ1ZWAgZm9yIGEgYGhlbHBgL2B2ZXJzaW9uYC9gc2NoZW1hYCByb3cgdGhlIG1vZHVsZSBhZGRlZC4gKi9cbiAgYXV0bzogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIENsaSA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogRW52ZWxvcGUgb24gZmFpbHVyZSwgcmV0dXJucyB0aGUgZXhpdCBjb2RlLiBGb3IgdGhlIHNwZWxsJ3MgYHJ1bigpYC4gKi9cbiAgbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPjtcbiAgLyoqIFRocm93cyBgQ2xpRXJyb3JgLCBmb3IgYSBzcGVsbCB3aG9zZSBtYWluIGRvZXMgaXRzIG93biB0cmlhZ2UuICovXG4gIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICBkZWNsYXJhdGlvbigpOiBEZWNsYXJhdGlvbjtcbiAgcmVuZGVySGVscCgpOiBzdHJpbmc7XG4gIC8qKiBBIHJvdydzIHVzYWdlIGxpbmUgKGBcImNsb3NlIDxpZD4gWy0tZm9yY2VdXCJgKTsgYFwiXCJgIGZvciBhbiB1bmtub3duIHBhdGguICovXG4gIHVzYWdlT2YocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogRXZlcnkgZmlyc3QgdG9rZW4gdGhhdCBkaXNwYXRjaGVzOiB2ZXJicywgYWxpYXNlcyBhbmQgZ3JvdXAgdG9rZW5zLiAqL1xuICB2ZXJiczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmdWxsIHBhdGggdGhhdCBkaXNwYXRjaGVzLCBhbGlhc2VzIGluY2x1ZGVkIChgXCJub2RlIGVkaXRcImApLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIHJvdydzIGFjY2VwdGVkIHNldCBhcyBgLS14YCBzcGVsbGluZ3MsIHNvcnRlZC4gYFwiXCJgIGlzIHRoZSByb290LiAqL1xuICBmbGFnc0ZvcihwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZsYWcgaW4gdGhlIG9wdGlvbnMgdGFibGUsIGFzIGAtLXhgLCBpbiB0YWJsZSBvcmRlci4gKi9cbiAgcmVjb2duaXplZEZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcm93czogcmVhZG9ubHkgUm93Vmlld1tdO1xufTtcblxuLy8g4pSA4pSAIGludGVybmFscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxudHlwZSBSb3cgPSBSb3dWaWV3ICYge1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICBhbGxvd1Bvc2l0aW9uYWxzOiBib29sZWFuO1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGNoZWNrOiBjLmNoZWNrIGFzIFJvd1tcImNoZWNrXCJdLFxuICAgICAgcnVuOiBjLnJ1biBhcyBSb3dbXCJydW5cIl0sXG4gICAgfTtcbiAgfTtcblxuICBjb25zdCByb3dzOiBSb3dbXSA9IChzcGVjLmNvbW1hbmRzID8/IFtdKS5tYXAoKGMpID0+IHRvUm93KGMgYXMgQ29tbWFuZFNwZWMsIGZhbHNlKSk7XG5cbiAgLy8gVGhlIGF1dG8gcm93cy4gQWRkZWQgbGFzdCwgaW4gdGhpcyBvcmRlciwgdW5sZXNzIHRoZSBzcGVsbCBoYXMgaXRzIG93bi5cbiAgY29uc3QgY2xpID0ge30gYXMgQ2xpO1xuICBjb25zdCBhdXRvUm93czogQ29tbWFuZFNwZWNbXSA9IFtcbiAgICB7XG4gICAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3Mge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVwiLFxuICAgICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHByaW50SnNvbihhd2FpdCBzcGVjLnZlcnNpb24oKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShjbGkuZGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJoZWxwXCIsXG4gICAgICBmbGFnczogW10sXG4gICAgICBwb3NpdGlvbmFsczogW10sXG4gICAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXCIsXG4gICAgICBydW46ICgpID0+IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGNsaS5yZW5kZXJIZWxwKCk7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHRleHQuZW5kc1dpdGgoXCJcXG5cIikgPyB0ZXh0IDogYCR7dGV4dH1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgXTtcbiAgZm9yIChjb25zdCBhIG9mIGF1dG9Sb3dzKSB7XG4gICAgaWYgKCFyb3dzLnNvbWUoKHIpID0+IHIubmFtZSA9PT0gYS5uYW1lKSkgcm93cy5wdXNoKHRvUm93KGEsIHRydWUpKTtcbiAgfVxuXG4gIGNvbnN0IHJvb3RSb3c6IFJvdyB8IHVuZGVmaW5lZCA9XG4gICAgc3BlYy5yb290ID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB0b1Jvdyh7IC4uLihzcGVjLnJvb3QgYXMgUm9vdFNwZWMpLCBuYW1lOiBcIlwiIH0sIGZhbHNlKTtcblxuICAvLyBJbmRleCBldmVyeSBzcGVsbGluZywgYW5kIGNoZWNrIHRoZSB0YWJsZSBpcyB3ZWxsIGZvcm1lZC5cbiAgY29uc3QgYnlUb2tlbiA9IG5ldyBNYXA8c3RyaW5nLCBSb3c+KCk7XG4gIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgZm9yIChjb25zdCB0IG9mIFtyLm5hbWUsIC4uLnIuYWxpYXNlc10pIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gdC5zcGxpdChcIiBcIik7XG4gICAgICBpZiAodC50cmltKCkgIT09IHQgfHwgcGFydHMubGVuZ3RoID4gMiB8fCBwYXJ0cy5zb21lKChwKSA9PiBwID09PSBcIlwiIHx8IHAuc3RhcnRzV2l0aChcIi1cIikpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBiYWQgY29tbWFuZCBuYW1lIFwiJHt0fVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAodCAhPT0gci5uYW1lICYmIHBhcnRzLmxlbmd0aCAhPT0gci5uYW1lLnNwbGl0KFwiIFwiKS5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3QgbmVzdCBsaWtlIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPT09IDIgJiYgdCAhPT0gci5uYW1lICYmIHBhcnRzWzBdICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpWzBdKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBhbGlhcyBcIiR7dH1cIiBtdXN0IHNoYXJlIHRoZSBncm91cCBvZiBcIiR7ci5uYW1lfVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAoYnlUb2tlbi5oYXModCkpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBcIiR7dH1cIiBpcyBkZWZpbmVkIHR3aWNlYCk7XG4gICAgICBieVRva2VuLnNldCh0LCByKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc3Vic09mID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IHQgb2YgYnlUb2tlbi5rZXlzKCkpIHtcbiAgICBjb25zdCBbZ3JvdXAsIHN1Yl0gPSB0LnNwbGl0KFwiIFwiKTtcbiAgICBpZiAoZ3JvdXAgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgc3Vic09mLnNldChncm91cCwgWy4uLihzdWJzT2YuZ2V0KGdyb3VwKSA/PyBbXSksIHN1Yl0pO1xuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IGcgb2YgT2JqZWN0LmtleXMoc3BlYy5ncm91cHMgPz8ge30pKSB7XG4gICAgaWYgKCFzdWJzT2YuaGFzKGcpKSB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ3JvdXAgXCIke2d9XCIgaGFzIG5vIHN1Yi12ZXJic2ApO1xuICB9XG5cbiAgY29uc3QgcGF0aHMgPSBbLi4uYnlUb2tlbi5rZXlzKCldO1xuICBjb25zdCB2ZXJicyA9IFsuLi5uZXcgU2V0KHBhdGhzLm1hcCgocCkgPT4gcC5zcGxpdChcIiBcIilbMF0gYXMgc3RyaW5nKSldO1xuXG4gIGNvbnN0IHJvd0ZvciA9IChwYXRoOiBzdHJpbmcpOiBSb3cgfCB1bmRlZmluZWQgPT4gKHBhdGggPT09IFwiXCIgPyByb290Um93IDogYnlUb2tlbi5nZXQocGF0aCkpO1xuICBjb25zdCBmbGFnc0ZvciA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICAgIFsuLi4ocm93Rm9yKHBhdGgpPy5hY2NlcHRlZCA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcbiAgY29uc3QgbGFiZWwgPSAocjogUm93KTogc3RyaW5nID0+IHIubmFtZSB8fCBjbGlOYW1lO1xuXG4gIC8qKlxuICAgKiBBIHZlcmJsZXNzIHJvb3QncyByZWplY3Rpb24gYGNob2ljZXNgOiBpdHMgb3duIGZsYWdzIFBMVVMgdGhlIGludGVyY2VwdG9ycyxcbiAgICogYmVjYXVzZSB0aGUgZGVjbGFyYXRpb24gcHVibGlzaGVzIGJvdGggYXQgYHBhdGg6IFtdYCBhbmQgdGhlIHJvb3QgYW5zd2Vyc1xuICAgKiBib3RoICh0aGUgaW50ZXJjZXB0b3JzIGFzIGBhcmd2WzBdYCkuIExlYXZpbmcgdGhlIGludGVyY2VwdG9ycyBvdXQgbWFkZVxuICAgKiBvbmUgcHJvY2VzcyBzYXkgdHdvIHRoaW5ncyBhYm91dCBpdHMgcm9vdCDigJQgYWNjJ3MgY2Vuc3VzIHJlYWQgYC0taGVscGAsXG4gICAqIGAtaGAsIGAtLXZlcnNpb25gIGFuZCBgLVZgIGFzIGRlY2xhcmVkLW5vdC1hY2NlcHRlZC4gTG9uZyBzcGVsbGluZ3MgZmlyc3RcbiAgICogKHNvcnRlZCksIHRoZW4gdGhlIHNob3J0czogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0XG4gICAqIHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcuXG4gICAqL1xuICBjb25zdCByb290Q2hvaWNlczogc3RyaW5nW10gPSAoKCkgPT4ge1xuICAgIGNvbnN0IGFsbCA9IFsuLi5mbGFnc0ZvcihcIlwiKSwgLi4uSU5URVJDRVBUT1JfQ0hPSUNFU107XG4gICAgY29uc3QgbG9uZyA9IGFsbC5maWx0ZXIoKGYpID0+IGYuc3RhcnRzV2l0aChcIi0tXCIpKS5zb3J0KCk7XG4gICAgcmV0dXJuIFsuLi5sb25nLCAuLi5hbGwuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLS1cIikpXTtcbiAgfSkoKTtcblxuICAvLyDilIDilIAgaGVscCDilIDilIBcblxuICBjb25zdCByZW5kZXJQb3NpdGlvbmFsID0gKHA6IFBvc2l0aW9uYWxTcGVjKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBpbm5lciA9IHAudmFyaWFkaWMgPyBgJHtwLm5hbWV9Li4uYCA6IHAubmFtZTtcbiAgICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbiAgfTtcbiAgY29uc3QgcmVuZGVyRmxhZyA9IChrOiBzdHJpbmcpOiBzdHJpbmcgPT5cbiAgICBzcGVjLm9wdGlvbnNba10/LnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG4gIGNvbnN0IHVzYWdlTGluZSA9IChyOiBSb3cpOiBzdHJpbmcgPT5cbiAgICBbXG4gICAgICBsYWJlbChyKSxcbiAgICAgIC4uLnIucG9zaXRpb25hbHMubWFwKHJlbmRlclBvc2l0aW9uYWwpLFxuICAgICAgLi4uci5mbGFncy5maWx0ZXIoKGspID0+ICFoaWRlcy5oYXMoaykpLm1hcChyZW5kZXJGbGFnKSxcbiAgICBdLmpvaW4oXCIgXCIpO1xuICBjb25zdCBleHBlY3RzID0gKHI6IFJvdyk6IHN0cmluZyA9PiBgZXhwZWN0czogJHt1c2FnZUxpbmUocil9YDtcblxuICBjb25zdCByZW5kZXJIZWxwID0gKCk6IHN0cmluZyA9PiB7XG4gICAgaWYgKHNwZWMuaGVscCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gc3BlYy5oZWxwKCk7XG4gICAgY29uc3QgbGlzdGVkID0gWy4uLihyb290Um93ID8gW3Jvb3RSb3ddIDogW10pLCAuLi5yb3dzXTtcbiAgICBjb25zdCBsaW5lcyA9IGxpc3RlZC5tYXAoKHIpID0+IFt1c2FnZUxpbmUociksIHIuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLmxpbmVzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gICAgY29uc3QgYm9keSA9IGxpbmVzXG4gICAgICAubWFwKChbdSwgZF0pID0+XG4gICAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gc3BlYy5zdW1tYXJ5ID8gYCR7Y2xpTmFtZX0g4oCUICR7c3BlYy5zdW1tYXJ5fWAgOiBjbGlOYW1lO1xuICAgIGNvbnN0IHRva2VucyA9IGAgICR7SU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OYDtcbiAgICByZXR1cm4gYCR7aGVhZH1cXG5cXG4ke2JvZHl9XFxuJHt0b2tlbnN9JHtzcGVjLmhlbHBGb290ZXIgPyBgXFxuXFxuJHtzcGVjLmhlbHBGb290ZXJ9YCA6IFwiXCJ9YDtcbiAgfTtcblxuICAvLyDilIDilIAgdGhlIGRlY2xhcmF0aW9uIOKUgOKUgFxuXG4gIGNvbnN0IGRlY2xhcmF0aW9uID0gKCk6IERlY2xhcmF0aW9uID0+IHtcbiAgICBjb25zdCBhcmcgPSAoazogc3RyaW5nKTogRGVjbGFyZWRBcmcgPT4gKHtcbiAgICAgIG5hbWU6IGAtLSR7a31gLFxuICAgICAgdHlwZTogKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS50eXBlLFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXRoOiBbXSxcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgIC4uLklOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICAuLi4ocm9vdFJvdyA/IHJvb3RSb3cuYWNjZXB0ZWQubWFwKGFyZykgOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHBvc2l0aW9uYWxzOiByb290Um93XG4gICAgICAgICAgPyByb290Um93LnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSlcbiAgICAgICAgICA6IFt7IG5hbWU6IHNwZWMudmVyYlBvc2l0aW9uYWwgPz8gXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiB0LnNwbGl0KFwiIFwiKSxcbiAgICAgICAgICBhcmdzOiByLmFjY2VwdGVkLm1hcChhcmcpLFxuICAgICAgICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzY2hlbWFSb3cgPSBieVRva2VuLmdldChcInNjaGVtYVwiKSBhcyBSb3c7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW3NjaGVtYVJvdy5uYW1lXSB9LFxuICAgICAgY29tbWFuZHMsXG4gICAgfTtcbiAgfTtcblxuICAvLyDilIDilIAgZGlzcGF0Y2gg4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSBpbmRleCBvZiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmcgZmxhZydzXG4gICAqIHZhbHVlLCB3YWxraW5nIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsOiBgLS1rIHZgIGNvbnN1bWVzIGB2YCB3aGVuIGBrYCBpcyBhXG4gICAqIHN0cmluZyBmbGFnLCBgLS1rPXZgIGNvbnN1bWVzIG5vdGhpbmcsIGAtcyB2YCBsaWtld2lzZSBieSB0aGUgc2hvcnQncyB0eXBlLlxuICAgKiBBdCBhIGJhcmUgYC0tYDogYC0xYCB3aGVuIGBzdG9wQXRUZXJtaW5hdG9yYCwgZWxzZSB0aGUgaW5kZXggYWZ0ZXIgaXQuXG4gICAqL1xuICBjb25zdCBzY2FuUG9zaXRpb25hbCA9IChhcmdzOiBzdHJpbmdbXSwgc3RvcEF0VGVybWluYXRvcjogYm9vbGVhbik6IG51bWJlciA9PiB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBhID0gYXJnc1tpXSBhcyBzdHJpbmc7XG4gICAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gc3RvcEF0VGVybWluYXRvciB8fCBpICsgMSA+PSBhcmdzLmxlbmd0aCA/IC0xIDogaSArIDE7XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNwZWMub3B0aW9uc1thLnNsaWNlKDIpXT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpICYmIGEubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBrZXkgPSBhLmxlbmd0aCA9PT0gMiA/IHNob3J0VG9LZXkuZ2V0KGEuc2xpY2UoMSkpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgc3BlYy5vcHRpb25zW2tleV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIGNvbnN0IHdpdGhvdXQgPSAoYXJnczogc3RyaW5nW10sIGk6IG51bWJlcik6IHN0cmluZ1tdID0+IFtcbiAgICAuLi5hcmdzLnNsaWNlKDAsIGkpLFxuICAgIC4uLmFyZ3Muc2xpY2UoaSArIDEpLFxuICBdO1xuXG4gIGNvbnN0IG5vQ29tbWFuZCA9ICgpOiBuZXZlciA9PlxuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VgLFxuICAgIH0pO1xuXG4gIC8qKiBBIHZlcmIgY2FuZGlkYXRlIGFuZCB0aGUgYXJncyBhZnRlciBpdCwgdG8gYSByb3cgYW5kIHRoYXQgcm93J3MgYXJncy4gKi9cbiAgY29uc3QgcmVzb2x2ZSA9IChjYW5kOiBzdHJpbmcsIHJlc3Q6IHN0cmluZ1tdKTogeyByb3c6IFJvdzsgdG9rZW46IHN0cmluZzsgYXJnczogc3RyaW5nW10gfSA9PiB7XG4gICAgY29uc3Qgc3VicyA9IHN1YnNPZi5nZXQoY2FuZCk7XG4gICAgaWYgKHN1YnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXQgPSBzcGVjLmdyb3Vwcz8uW2NhbmRdPy5zdWJWZXJiQXQgPz8gXCJhZGphY2VudFwiO1xuICAgICAgbGV0IGkgPSAtMTtcbiAgICAgIGlmIChhdCA9PT0gXCJhZGphY2VudFwiKSB7XG4gICAgICAgIGNvbnN0IG5leHQgPSByZXN0WzBdO1xuICAgICAgICBpID0gbmV4dCAhPT0gdW5kZWZpbmVkICYmICFuZXh0LnN0YXJ0c1dpdGgoXCItXCIpID8gMCA6IC0xO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaSA9IHNjYW5Qb3NpdGlvbmFsKHJlc3QsIHRydWUpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3ViID0gaSA+PSAwID8gKHJlc3RbaV0gYXMgc3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZ1bGwgPSBzdWIgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGJ5VG9rZW4uZ2V0KGAke2NhbmR9ICR7c3VifWApO1xuICAgICAgaWYgKGZ1bGwgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4geyByb3c6IGZ1bGwsIHRva2VuOiBgJHtjYW5kfSAke3N1Yn1gLCBhcmdzOiB3aXRob3V0KHJlc3QsIGkpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBvd24gPSBieVRva2VuLmdldChjYW5kKTtcbiAgICAgIGlmIChvd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcm93OiBvd24sIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gICAgICBjb25zdCBleHRyYSA9IHsgY2hvaWNlczogWy4uLnN1YnNdLCBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgIH07XG4gICAgICBpZiAoc3ViID09PSB1bmRlZmluZWQpIGRpZShgJHtjYW5kfTogZXhwZWN0ZWQgYSBzdWItY29tbWFuZGAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgICAgZGllKGB1bmtub3duICR7Y2FuZH0gc3ViLWNvbW1hbmQ6IFwiJHtzdWJ9XCJgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICB9XG4gICAgY29uc3Qgcm93ID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoYHVua25vd24gY29tbWFuZCBcIiR7Y2FuZH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJvdywgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgfTtcblxuICAvKipcbiAgICogQ29udHJhY3QgNSdzIGAtLWAgbWFkZSB0aGUgY2FsbGVyJ3MgZmxhZyBURVhUOyBzYXkgc28gKGMxLFxuICAgKiBgZG9jcy9pdGVtcy90ZXJtaW5hdG9yLWVhdHMtc2Vzc2lvbi1rZXkubWRgKS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHNcbiAgICogYSBmbGFnIHRoaXMgcm93IGFjY2VwdHMg4oCUIGAtLWtgLCBgLS1rPXZgLCBvciB0aGUgc2hvcnQgYC1zYCBvZiBhbiBhY2NlcHRlZFxuICAgKiBga2AsIGdsb2JhbHMgaW5jbHVkZWQg4oCUIGlzIG5hbWVkIGluIE9ORSBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIsIHdpdGhcbiAgICogdGhlIG1vdmUgdGhhdCByZWNvdmVycyBpdC4gU3Rkb3V0IGFuZCB0aGUgZXhpdCBjb2RlIGRvIG5vdCBjaGFuZ2UsIGFuZCB0aGVcbiAgICogcm93IHN0aWxsIHJ1bnM6IHRleHQgY29udGFpbmluZyBhIGZsYWcgbmFtZSBpcyBsZWdpdGltYXRlLCB3aGljaCBpcyB3aGF0XG4gICAqIGAtLWAgaXMgZm9yLiBBIHRva2VuIHRoZSByb3cgZG9lcyBub3QgYWNjZXB0IGlzIGp1c3QgdGV4dCwgYW5kIHNheXMgbm90aGluZy5cbiAgICpcbiAgICog4pqgIENhbGxlZCBvbmx5IG9uY2UgZXZlcnkgcmVmdXNhbCBoYXMgcGFzc2VkLCBzbyBhIHJlZnVzZWQgaW52b2NhdGlvbidzXG4gICAqIHN0ZGVyciBpcyBzdGlsbCBleGFjdGx5IG9uZSBlbnZlbG9wZS4gVGhlIGAjIGAgcHJlZml4IGlzIHRoZSBob3VzZSdzXG4gICAqIHN1Y2Nlc3MtcGF0aCBzdGRlcnIgZm9ybSAoYCMgd2FybmluZzpgIGluIG1pbmQtbWFwcGVyLCBgIyBwaW5uZWQgYm9hcmRgLFxuICAgKiBgIyDihpIgY2hhbm5lbGApOiBhbiBlbnZlbG9wZSByZWFkZXIgbG9va3MgZm9yIGEgYHtgIGxpbmUgYW5kIHNraXBzIGl0LlxuICAgKi9cbiAgY29uc3Qgd2FybkRlbW90ZWQgPSAoXG4gICAgcm93OiBSb3csXG4gICAgYWNjZXB0ZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gICAgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBlbmQgPSB0b2tlbnM/LmZpbmRJbmRleCgodCkgPT4gdC5raW5kID09PSBcIm9wdGlvbi10ZXJtaW5hdG9yXCIpID8/IC0xO1xuICAgIGlmICh0b2tlbnMgPT09IHVuZGVmaW5lZCB8fCBlbmQgPCAwKSByZXR1cm47XG4gICAgY29uc3QgZGVtb3RlZDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rZW5zLnNsaWNlKGVuZCArIDEpKSB7XG4gICAgICBpZiAodC5raW5kICE9PSBcInBvc2l0aW9uYWxcIikgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gdC52YWx1ZTtcbiAgICAgIGxldCBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICh2LnN0YXJ0c1dpdGgoXCItLVwiKSkga2V5ID0gdi5zbGljZSgyKS5zcGxpdChcIj1cIilbMF07XG4gICAgICBlbHNlIGlmICh2Lmxlbmd0aCA9PT0gMiAmJiB2LnN0YXJ0c1dpdGgoXCItXCIpKSBrZXkgPSBzaG9ydFRvS2V5LmdldCh2LnNsaWNlKDEpKTtcbiAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBrZXkgIT09IFwiXCIgJiYgYWNjZXB0ZWQuaGFzKGtleSkpIGRlbW90ZWQucHVzaCh2KTtcbiAgICB9XG4gICAgaWYgKGRlbW90ZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgd2hpY2ggPSBkZW1vdGVkLmpvaW4oXCIsIFwiKTtcbiAgICBjb25zdCBvbmUgPSBkZW1vdGVkLmxlbmd0aCA9PT0gMTtcbiAgICBjb25zdCBpdCA9IG9uZSA/IFwiaXRcIiA6IFwidGhlbVwiO1xuICAgIGNvbnN0IHdhcyA9IG9uZSA/IFwid2FzXCIgOiBcIndlcmVcIjtcbiAgICBjb25zdCBhc0ZsYWcgPSBvbmUgPyBcImFzIGEgZmxhZ1wiIDogXCJhcyBmbGFnc1wiO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCMgd2FybmluZzogJHtjbGlOYW1lfSR7cm93Lm5hbWUgPT09IFwiXCIgPyBcIlwiIDogYCAke3Jvdy5uYW1lfWB9OiAke3doaWNofSBhZnRlciBcXGAtLVxcYCAke3dhc30gcmVhZCBhcyB0ZXh0LCBub3QgJHthc0ZsYWd9OyB0byB1c2UgJHtpdH0gJHthc0ZsYWd9LCBtb3ZlICR7aXR9IGJlZm9yZSBcXGAtLVxcYFxcbmAsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBydW5Sb3cgPSBhc3luYyAocm93OiBSb3csIHRva2VuOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChyb3cubmFtZSA9PT0gXCJcIiA/IG51bGwgOiByb3cubmFtZSk7XG4gICAgY29uc3QgbmFtZSA9IGxhYmVsKHJvdyk7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBuZXcgU2V0KHJvdy5hY2NlcHRlZCk7XG4gICAgY29uc3QgY2hvaWNlcyA9IHJvdy5uYW1lID09PSBcIlwiID8gcm9vdENob2ljZXMgOiBmbGFnc0Zvcihyb3cubmFtZSk7XG4gICAgY29uc3QgZmxhZ0hpbnQgPSAoKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICBbcm93LnJlamVjdEhpbnQsIGNob2ljZXMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gZmxhZ3NgIDogdW5kZWZpbmVkXVxuICAgICAgICAuZmlsdGVyKChzKTogcyBpcyBzdHJpbmcgPT4gcyAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAuam9pbihcIjsgXCIpIHx8IHVuZGVmaW5lZDtcblxuICAgIGxldCB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGxldCBwb3NpdGlvbmFsczogc3RyaW5nW107XG4gICAgbGV0IHRva2VuczogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPltcInRva2Vuc1wiXTtcbiAgICB0cnkge1xuICAgICAgKHsgdmFsdWVzLCBwb3NpdGlvbmFscywgdG9rZW5zIH0gPSBwYXJzZUFyZ3Moe1xuICAgICAgICBhcmdzLFxuICAgICAgICBvcHRpb25zOiBwYXJzZU9wdGlvbnMsXG4gICAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgICAgYWxsb3dQb3NpdGlvbmFsczogcm93LmFsbG93UG9zaXRpb25hbHMsXG4gICAgICAgIHRva2VuczogdHJ1ZSxcbiAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZXJyQ29kZShlKSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiKSB7XG4gICAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0pO1xuICAgICAgfVxuICAgICAgLy8gQSBtaXNzaW5nIHZhbHVlIGlzIG5vdCBhIGNob2ljZSBmcm9tIGEgc2V0LCBzbyBubyBgY2hvaWNlc2AgaGVyZS5cbiAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBoaW50OiByb3cucmVqZWN0SGludCA/PyBleHBlY3RzKHJvdykgfSk7XG4gICAgfVxuXG4gICAgLy8gU3RhZ2UgMjoga25vd24gdG8gdGhlIHNwZWxsLCBub3QgdGFrZW4gYnkgdGhpcyByb3cg4oCUIE1JU1BMQUNFRCwgbm90XG4gICAgLy8gdW5rbm93bi4gT25seSBmbGFncyB0aGUgY2FsbGVyIEdBVkUgYXJlIGhlcmU6IGRlZmF1bHRzIGFyZSBub3QgYXBwbGllZCB5ZXQuXG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyh2YWx1ZXMpLmZpbmQoKGspID0+ICFhY2NlcHRlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke25hbWV9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgJHtjbGlOYW1lfSBmbGFnLCBqdXN0IG5vdCB0aGlzICR7cm93Lm5hbWUgPT09IFwiXCIgPyBcImNvbW1hbmRcIiA6IFwidmVyYlwifSdzKWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEFyaXR5LCBmcm9tIHRoZSBkZWNsYXJlZCBzaGFwZSwgbmFtaW5nIHRoZSBtaXNzaW5nIG9yIHRoZSBleHRyYSB0b2tlbi5cbiAgICBjb25zdCByZXF1aXJlZCA9IHJvdy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgICBjb25zdCB2YXJpYWRpYyA9IHJvdy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgICBpZiAocG9zaXRpb25hbHMubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSByb3cucG9zaXRpb25hbHNbcG9zaXRpb25hbHMubGVuZ3RoXTtcbiAgICAgIGRpZShgJHtuYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IGV4cGVjdHMocm93KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWxzLmxlbmd0aCA+IHJvdy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYCR7bmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsc1tyb3cucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGhpbnQ6IHJvdy5wb3NpdGlvbmFscy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBhcmd1bWVudHNgIDogZXhwZWN0cyhyb3cpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIERlZmF1bHRzIGxhc3QsIGFuZCBvbmx5IHRoaXMgcm93J3MuXG4gICAgY29uc3QgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4gPSB7IC4uLih2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPikgfTtcbiAgICBmb3IgKGNvbnN0IGsgb2Ygcm93LmFjY2VwdGVkKSB7XG4gICAgICBjb25zdCBkID0gKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS5kZWZhdWx0O1xuICAgICAgaWYgKGZsYWdzW2tdID09PSB1bmRlZmluZWQgJiYgZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZsYWdzW2tdID0gKEFycmF5LmlzQXJyYXkoZCkgPyBbLi4uZF0gOiBkKSBhcyBGbGFnVmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW52OiBJbnZvY2F0aW9uID0geyBwYXRoOiByb3cubmFtZSwgdG9rZW4sIHBvczogcG9zaXRpb25hbHMsIGZsYWdzIH07XG4gICAgY29uc3QgcmVmdXNlZCA9IHJvdy5jaGVjaz8uKGludik7XG4gICAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCkgZGllKGAke25hbWV9OiAke3JlZnVzZWR9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IGV4cGVjdHMocm93KSB9KTtcblxuICAgIHdhcm5EZW1vdGVkKHJvdywgYWNjZXB0ZWQsIHRva2Vucyk7XG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgcm93LnJ1bihpbnYpO1xuICAgIHJldHVybiB0eXBlb2Ygb3V0ID09PSBcIm51bWJlclwiID8gb3V0IDogMDtcbiAgfTtcblxuICBjb25zdCBkaXNwYXRjaCA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgICBjb25zdCBmaXJzdCA9IGFyZ3ZbMF07XG5cbiAgICAvLyAxLiBJbnRlcmNlcHRvcnMgcGFzcyB0aGUgcmVzdCBvZiB0aGUgYXJndiBvbiB0byB0aGVpciByb3cuXG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBJTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBmaXJzdCk7XG4gICAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBydW5Sb3coYnlUb2tlbi5nZXQoaW50ZXJjZXB0b3IucnVucykgYXMgUm93LCBpbnRlcmNlcHRvci5ydW5zLCBhcmd2LnNsaWNlKDEpKTtcbiAgICB9XG5cbiAgICAvLyAyLiBBIHZlcmJsZXNzIHJvb3Qgb3ducyBldmVyeSBhcmd2IHRoYXQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlc2VydmVkIHRva2VuLlxuICAgIGlmIChyb290Um93ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkICYmIChieVRva2VuLmhhcyhmaXJzdCkgfHwgc3Vic09mLmhhcyhmaXJzdCkpKSB7XG4gICAgICAgIGNvbnN0IHIgPSByZXNvbHZlKGZpcnN0LCBhcmd2LnNsaWNlKDEpKTtcbiAgICAgICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBydW5Sb3cocm9vdFJvdywgXCJcIiwgYXJndik7XG4gICAgfVxuXG4gICAgLy8gMy4gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMikuXG4gICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcblxuICAgIC8vIDQuIEZpbmQgdGhlIHZlcmIuXG4gICAgbGV0IGNhbmQ6IHN0cmluZztcbiAgICBsZXQgcmVzdDogc3RyaW5nW107XG4gICAgaWYgKGdyYW1tYXIgPT09IFwidmVyYi1maXJzdFwiKSB7XG4gICAgICBpZiAoZmlyc3QgPT09IFwiLS1cIikge1xuICAgICAgICBpZiAoYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICAgIGNhbmQgPSBhcmd2WzFdO1xuICAgICAgICByZXN0ID0gW1wiLS1cIiwgLi4uYXJndi5zbGljZSgyKV07XG4gICAgICB9IGVsc2UgaWYgKGZpcnN0LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgIHJldHVybiBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtmaXJzdH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke3ZlcmJzLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZCA9IGZpcnN0O1xuICAgICAgICByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IHNjYW5Qb3NpdGlvbmFsKGFyZ3YsIGZhbHNlKTtcbiAgICAgIGlmIChpIDwgMCkge1xuICAgICAgICAvLyBObyB2ZXJiIGFueXdoZXJlOiBhbiB1bmtub3duIGZsYWcgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LFxuICAgICAgICAvLyBhbmQgYSBjbGVhbiBwYXJzZSBpcyBhIGJhcmUgaW52b2NhdGlvbi4gTmVpdGhlciByYW4gYSBjb21tYW5kLCBzb1xuICAgICAgICAvLyB0aGUgZW52ZWxvcGUncyBgbWV0YS5jb21tYW5kYCBpcyBudWxsLCBub3QgdGhlIGZpcnN0IGZsYWcnc1xuICAgICAgICAvLyBzcGVsbGluZyAoYGdsYW1vdXIgLS1ib2d1c2AgbmFtZXMgbm8gdmVyYikuXG4gICAgICAgIHNldEN1cnJlbnRDb21tYW5kKG51bGwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IHBhcnNlT3B0aW9ucywgc3RyaWN0OiB0cnVlLCBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgZGllKGVyck1lc3NhZ2UoZSksIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgICAgaGludDogYG5vIGNvbW1hbmQgZ2l2ZW4g4oCUIGNvbW1hbmRzOiAke3ZlcmJzLmpvaW4oXCIgXCIpfSAocnVuOiAke2NsaU5hbWV9IGhlbHApYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICB9XG4gICAgICBjYW5kID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgICAvLyBBIHZlcmIgZm91bmQgcmlnaHQgYWZ0ZXIgYSBgLS1gIGxlYXZlcyB0aGF0IGAtLWAgaW4gcGxhY2UsIHNvIHRoZVxuICAgICAgLy8gcmVzdCBvZiB0aGUgYXJndiBzdGF5cyBwb3NpdGlvbmFsLlxuICAgICAgcmVzdCA9IHdpdGhvdXQoYXJndiwgaSk7XG4gICAgfVxuICAgIHNldEN1cnJlbnRDb21tYW5kKGNhbmQpO1xuICAgIGNvbnN0IHIgPSByZXNvbHZlKGNhbmQsIHJlc3QpO1xuICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gIH07XG5cbiAgY29uc3QgbWFpbiA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgICAvLyBUaGUgaG91c2UgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuIEEgc3BlbGwgdGhhdFxuICAgICAgLy8gdHJpYWdlcyBpdHMgb3duIChnbGFtb3VyJ3MgRU5PRU5UIOKGkiB1c2FnZSkgY2FsbHMgYGRpc3BhdGNoYCBpbnN0ZWFkLlxuICAgICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIGVyck1lc3NhZ2UoZSkpKSA/PyAxO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2aWV3ID0gKHI6IFJvdyk6IFJvd1ZpZXcgPT4gKHtcbiAgICBuYW1lOiByLm5hbWUsXG4gICAgYWxpYXNlczogci5hbGlhc2VzLFxuICAgIGZsYWdzOiByLmZsYWdzLFxuICAgIGFjY2VwdGVkOiByLmFjY2VwdGVkLFxuICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLFxuICAgIGRlc2NyaWJlOiByLmRlc2NyaWJlLFxuICAgIGF1dG86IHIuYXV0byxcbiAgfSk7XG5cbiAgT2JqZWN0LmFzc2lnbihjbGksIHtcbiAgICBuYW1lOiBjbGlOYW1lLFxuICAgIG1haW4sXG4gICAgZGlzcGF0Y2gsXG4gICAgZGVjbGFyYXRpb24sXG4gICAgcmVuZGVySGVscCxcbiAgICB1c2FnZU9mOiAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByID0gcm93Rm9yKHBhdGgpO1xuICAgICAgcmV0dXJuIHIgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiB1c2FnZUxpbmUocik7XG4gICAgfSxcbiAgICB2ZXJicyxcbiAgICBwYXRocyxcbiAgICBmbGFnc0ZvcixcbiAgICByZWNvZ25pemVkRmxhZ3M6IG9wdGlvbktleXMubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgcm93czogcm93cy5tYXAodmlldyksXG4gIH0gc2F0aXNmaWVzIENsaSk7XG4gIHJldHVybiBjbGk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pdGVtcy90YWlsLXJlYWRlci1jb252ZXJnZW5jZS93cml0ZS11cC5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuXG4gICAqXG4gICAqICDim5QgQU5EIFdIRU4gVEhFIE5FVyBMT0cgV0FTIEFMUkVBRFkgUEFTVCBUSEUgQk9PS01BUkssIFRIRSBDTElFTlRcbiAgICogIFJFQ09OTkVDVFMgRlJPTSBJVFMgU1RBUlQuIEEgZGFlbW9uIHRoYXQgYmVsaWV2ZXMgdGhlIGN1cnNvciBzZW5kcyBvbmx5XG4gICAqICB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuIG1lc3NhZ2UgYXRcbiAgICogIG5ldyBpZCAyIHVuZGVyIGFuIG9sZCBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgc2lsZW50bHkuIEV2ZXJ5dGhpbmcgaW5cbiAgICogIGEgbmV3IGVwb2NoIGlzIG5ldyB0byB0aGlzIHJlYWRlciwgc28gdGhlIGF0dGVtcHQgaXMgZHJvcHBlZCBhbmQgcmUtbWFkZVxuICAgKiAgZnJvbSAwIGF0IG9uY2UgKG5vIGJhY2tvZmYpLiBBIGZyYW1lIEFUIG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgbWVhbnNcbiAgICogIHRoZSBkYWVtb24gaXMgYWxyZWFkeSByZXBsYXlpbmcgd2hvbGUsIGFuZCBpcyBrZXB0LiAoUmV2aWV3ZXIncyBEMiBnYXAsXG4gICAqICBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZi4pICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKiogVGhlIGVwb2NoIHRoZSBzdGFydGluZyBgc2luY2VgIGNhbWUgZnJvbSwgd2hlbiB0aGUgY2FsbGVyIGhhcyBvbmUgKGFcbiAgICogIGJvb2ttYXJrIHByaW50ZWQgYXMgYE5APGVwb2NoPmAsIGAuL3RhaWxIYW5kb2ZmLnRzYCkuIFRoZSBmaXJzdCBmcmFtZSBvZiBhXG4gICAqICBkaWZmZXJlbnQgZXBvY2ggaXMgdGhlbiBhbiBlcG9jaCBjaGFuZ2UgbGlrZSBhbnkgb3RoZXIg4oCUIHdoaWNoIGlzIHdoYXRcbiAgICogIHN0b3BzIGEgYm9va21hcmsgb3V0bGl2aW5nIGl0cyBsb2cgYWNyb3NzIHByb2Nlc3Nlcy4gKi9cbiAgc2luY2VFcG9jaD86IHN0cmluZztcbiAgLyoqXG4gICAqIFJlYWQgYSBmcmFtZSB3aG9zZSBpZCBpcyBBVCBPUiBCRUxPVyB0aGUgY3Vyc29yIHRoaXMgY29ubmVjdGlvbiBhc2tlZFxuICAgKiBmcm9tIGFzIFwidGhlIGxvZyByZXN0YXJ0ZWRcIiwgcmVzZXQgdGhlIGN1cnNvciB0byAwLCBhbmQgY2FsbFxuICAgKiBgb25FcG9jaENoYW5nZWAgKHdpdGggdGhlIGZyYW1lJ3MgZXBvY2gsIG9yIGBcInVua25vd25cImApLiBEZWZhdWx0IGZhbHNlLlxuICAgKlxuICAgKiDim5QgV0hZIElUIElTIEhPTkVTVDogdGhlIGtpdCdzIGV2ZW50IGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duXG4gICAqIGJ5IHJlcGxheWluZyBXSE9MRSAoYC4vZXZlbnRMb2cudHNgLCBwb2ludCAzKSwgYW5kIG90aGVyd2lzZSBzZW5kcyBvbmx5XG4gICAqIGlkcyBhYm92ZSB0aGUgY3Vyc29yLiBTbyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgZXhpc3RzIG9ubHlcbiAgICogd2hlbiB0aGUgZGFlbW9uIGp1ZGdlZCB0aGUgY3Vyc29yIGZvcmVpZ24g4oCUIGEgcmVzdGFydGVkIGRhZW1vbiwgd2hvc2UgaWRzXG4gICAqIGJlZ2FuIGFnYWluIGF0IDEuIFRoZSBlcG9jaCBjYXRjaGVzIHRoYXQgV0lUSElOIG9uZSBwcm9jZXNzOyB0aGlzIGNhdGNoZXNcbiAgICogaXQgQUNST1NTIHByb2Nlc3Nlcywgd2hlcmUgYSByZS1hcm1lZCB0YWlsIGNhcnJpZXMgYSBib29rbWFyayBmcm9tIGEgbG9nXG4gICAqIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cyBhbmQsIHdpdGhvdXQgaXQsIGtlcHQgdGhhdCBib29rbWFyayBmb3JldmVyOiBldmVyeVxuICAgKiByZS1hcm0gcmVwbGF5ZWQgdGhlIHdob2xlIG5ldyBsb2csIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wXG4gICAqIChmb3VuZCBieSB0aGUgdmVyaWZpZXIgb24gZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIGFmdGVyIGB0YWlsLmxvc3RgIOKGklxuICAgKiBgb3BlbiAtLXJlc3RvcmVgKS5cbiAgICpcbiAgICog4pqgIE9OTFkgRk9SIEEgREFFTU9OIE9OIFRIRSBLSVQnUyBFVkVOVCBMT0cuIEdyYXBldmluZSdzIGlkcyBhcmUgcmVjb3ZlcmVkXG4gICAqIGFjcm9zcyBhIHJlc3RhcnQgYW5kIGl0cyBgLS1sYXN0YCBxdWVyeSBvdmVycmlkZXMgYHNpbmNlYCwgc28gaXQgbGVhdmVzXG4gICAqIHRoaXMgb2ZmLiBBbmQgdGhlIGJsaW5kIHNwb3QgaXMgc3RhdGVkOiBhIGJvb2ttYXJrIHRoYXQgaGFwcGVucyB0byBiZSBhdFxuICAgKiBvciBiZWxvdyB0aGUgUkVTVEFSVEVEIGxvZydzIG93biBsZW5ndGggbG9va3MgdmFsaWQgdG8gdGhlIGRhZW1vbiwgd2hpY2hcbiAgICogdGhlbiBzZW5kcyBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdC4gVGhlIGNvbWUtYmFjayBwYXRoIHRoZXJlZm9yZSBkcm9wc1xuICAgKiB0aGUgYm9va21hcmsgYWx0b2dldGhlciAoYC4vdGFpbEhhbmRvZmYudHNgLCBEMiksIHNvIHRoaXMgaXMgdGhlIG5ldCwgbm90XG4gICAqIHRoZSBydWxlLlxuICAgKi9cbiAgcmVzdGFydE9uUmVwbGF5PzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiBgYWNjZXB0ZWRgIGlzIGBhY2NlcHRgJ3NcbiAgICogIHZlcmRpY3Qgb24gdGhpcyBmcmFtZSwgd2hpY2ggaXMgd2hhdCBsZXRzIGB0YWlsIC0tb25jZWAgZW5kIG9uIHRoZSBmaXJzdFxuICAgKiAgZnJhbWUgaXQgYWN0dWFsbHkgREVMSVZFUlMgKGAuL3RhaWxIYW5kb2ZmLnRzYCkuXG4gICAqXG4gICAqICDim5QgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04gYmVmb3JlIHRoZSBjbGllbnQgcmV0dXJucy4gSXRcbiAgICogIHVzZWQgdG8gcmV0dXJuIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3Agd2l0aCB0aGUgU1NFIHN0cmVhbSBzdGlsbCBvcGVuLFxuICAgKiAgd2hpY2gga2VwdCB0aGUgcHJvY2VzcyBhbGl2ZSDigJQgdW5zZWVuIGZvciBgY2xvc2VkYCwgYmVjYXVzZSB0aGUgc2VydmVyXG4gICAqICBlbmRzIHRoYXQgc3RyZWFtIGl0c2VsZiwgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrXG4gICAqICB3b3VsZCBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudC4gKEFkanVzdG1lbnQgMSBvZiB0aGVcbiAgICogIE1vbml0b3ItZXhwaXJ5IHNwaWtlOyBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLikgKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUsIGFjY2VwdGVkOiBib29sZWFuKSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIENhbGxlZCBvbmNlIGFzIHRoZSB0YWlsIGVuZHMsIHdpdGggdGhlIGZpbmFsIGN1cnNvciAodGhlIGJvb2ttYXJrIGEgcmUtYXJtXG4gICAqIHBhc3NlcyBhcyBgLS1zaW5jZWApIGFuZCB3aHkgaXQgZW5kZWQuIEEgUkVQT1JUIFNJTksgbGlrZSBgb25EaXNjb25uZWN0YCxcbiAgICogbm90IGEgYmVoYXZpb3VyYWwgaGF0Y2g6IGl0IGNoYW5nZXMgbm90aGluZyB0aGUgY2xpZW50IGRvZXMuIEl0IGV4aXN0c1xuICAgKiBmb3IgYC4vdGFpbEhhbmRvZmYudHNgLCB3aG9zZSBsYXN0IGxpbmUgbmFtZXMgdGhlIHJlLWFybSBhbmQgbXVzdCBjYXJyeVxuICAgKiB0aGUgY3Vyc29yIGV4YWN0bHkgYXMgdGhpcyBsb29wIGxlZnQgaXQsIGVwb2NoIHJlc2V0cyBpbmNsdWRlZC5cbiAgICovXG4gIG9uRW5kPzogKGVuZDoge1xuICAgIGN1cnNvcjogbnVtYmVyO1xuICAgIC8qKiBUaGUgZXBvY2ggb2YgdGhlIGxvZyB0aGUgY3Vyc29yIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgb25lLiAqL1xuICAgIGVwb2NoOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlYXNvbjogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIjtcbiAgfSkgPT4gdm9pZDtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHtcbiAgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDtcbiAgY29tbWVudHM6IHN0cmluZ1tdO1xufSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG9wdHMuc2luY2VFcG9jaCA/PyBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcbiAgbGV0IGVuZGluZzogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIiA9IFwic3RvcHBlZFwiO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgLy8g4puUIEEgU1RPUCBUSEFUIExBTkRFRCBXSElMRSBgcmVzb2x2ZWAgV0FTIEFXQUlURUQgKHRoZSBoYW5kb2ZmJ3Mgd2luZG93LFxuICAgICAgLy8gYSBzaWduYWwpIGZvdW5kIG5vIGF0dGVtcHQgdG8gYWJvcnQuIFdpdGhvdXQgdGhpcyBjaGVjayB0aGUgbG9vcCB3ZW50XG4gICAgICAvLyBvbiB0byBmZXRjaCwgc2tpcHBlZCB0aGUgcmVhZCwgYW5kIHJldHVybmVkIHdpdGggdGhhdCBzdHJlYW0gc3RpbGxcbiAgICAgIC8vIG9wZW4g4oCUIHdoaWNoIGtlZXBzIGEgcHJvY2VzcyBhbGl2ZSBleGFjdGx5IGxpa2UgdGhlIHRlcm1pbmFsLWZyYW1lXG4gICAgICAvLyBoYW5nLiAoU3VzcGVjdGVkIGJ5IHRoZSByZXZpZXdlciwgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikge1xuICAgICAgICAgIGVuZGluZyA9IFwidW5yZXNvbHZlZFwiO1xuICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8ge1xuICAgICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICB9O1xuICAgICAgLy8gV2hhdCB0aGlzIGNvbm5lY3Rpb24gYXNrZWQgZnJvbSwgZm9yIGByZXN0YXJ0T25SZXBsYXlgLlxuICAgICAgY29uc3QgYXNrZWRTaW5jZSA9IGN1cnNvcjtcbiAgICAgIGxldCByZXN0YXJ0Tm90ZWQgPSBmYWxzZTtcbiAgICAgIC8vIFNldCB3aGVuIGFuIGVwb2NoIGNoYW5nZSBmaW5kcyB0aGUgbmV3IGxvZyBwYXN0IHRoZSBib29rbWFyay5cbiAgICAgIGxldCBmcm9tVG9wID0gZmFsc2U7XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuXG4gICAgICAgICAgICBsZXQgZXBvY2hSZXNldCA9IGZhbHNlO1xuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgZXBvY2hSZXNldCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgICAgLy8gVGhlIG5ldyBsb2cgaXMgcGFzdCB0aGUgYm9va21hcms6IGl0cyBzdGFydCB3YXMgc2tpcHBlZC5cbiAgICAgICAgICAgICAgICAgIC8vIERyb3AgdGhpcyBhdHRlbXB0IGFuZCByZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gMC5cbiAgICAgICAgICAgICAgICAgIGlmIChhc2tlZFNpbmNlID4gMCAmJiB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBuID4gYXNrZWRTaW5jZSkge1xuICAgICAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgICAgICAgIGZyb21Ub3AgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIG9wdHMucmVzdGFydE9uUmVwbGF5ID09PSB0cnVlICYmXG4gICAgICAgICAgICAgICFlcG9jaFJlc2V0ICYmXG4gICAgICAgICAgICAgICFyZXN0YXJ0Tm90ZWQgJiZcbiAgICAgICAgICAgICAgYXNrZWRTaW5jZSA+PSAwICYmXG4gICAgICAgICAgICAgIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmXG4gICAgICAgICAgICAgIG4gPD0gYXNrZWRTaW5jZVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIFRoZSBkYWVtb24gcmVwbGF5ZWQgV0hPTEU6IGl0cyBsb2cgcmVzdGFydGVkIChzZWUgdGhlIG9wdGlvbikuXG4gICAgICAgICAgICAgIHJlc3RhcnROb3RlZCA9IHRydWU7XG4gICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihvcHRzLmVwb2NoT2Y/LihldikgPz8gXCJ1bmtub3duXCIpID8/IG51bGw7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHtcbiAgICAgICAgICAgICAgLy8g4puUIENMT1NFIFRIRSBDT05ORUNUSU9OLiBTZWUgYHRlcm1pbmFsYCdzIGRvYzogd2l0aG91dCB0aGlzIHRoZVxuICAgICAgICAgICAgICAvLyBvcGVuIHN0cmVhbSBrZWVwcyB0aGUgcHJvY2VzcyBhbGl2ZSBhZnRlciB3ZSByZXR1cm4uXG4gICAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgICAgZW5kaW5nID0gXCJ0ZXJtaW5hbFwiO1xuICAgICAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGZyb21Ub3ApIHtcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGZyb21Ub3ApIHtcbiAgICAgICAgLy8gUmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIGl0cyBzdGFydCwgbm93OiBub3RoaW5nIGZhaWxlZC5cbiAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgICBvcHRzLm9uRW5kPy4oeyBjdXJzb3IsIGVwb2NoLCByZWFzb246IGVuZGluZyB9KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSB0YWlsJ3MgSEFORE9GRjogaG93IGEgc3BlbGwncyBgdGFpbGAgZW5kcyBpdHMgb3duIHdhdGNoIGp1c3QgYmVmb3JlIHRoZVxuICogaGFybmVzcydzIE1vbml0b3IgY2FwLCBhbmQgdGhlIG9uZSBzdGRvdXQgbGluZSB0aGF0IG5hbWVzIHRoZSBhZ2VudCdzIG5leHRcbiAqIGFjdCwgYm9va21hcmsgaW5jbHVkZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBUaGlzIG1vZHVsZSBpbXBvcnRzIG9ubHkgaXRzIHNpYmxpbmcgYC4vdGFpbEV2ZW50c2AuXG4gKlxuICogQnVpbHQgb24gYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0byBDb2xlJ3MgcnVsaW5nIG9mIDIwMjYtMDktMjMgKHRoZVxuICogXCJSdWxpbmdcIiBzZWN0aW9uIG9mXG4gKiBgZG9jcy9pdGVtcy9zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaXRlbXMvbW9uaXRvci1leHBpcnktYW5kLXRoZS10YWlsL3dyaXRlLXVwLm1kYCkuXG4gKlxuICog4pSA4pSAIFRIRSBQUk9CTEVNLCBPTkUgUEFSQUdSQVBIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBraWxscyBldmVyeSB3YXRjaCBhdCAxLDgwMCwwMDAgbXMuIEV2ZXJ5IHNwZWxsIHRlbGxzXG4gKiB0aGUgYWdlbnQgdG8gd3JhcCBgdGFpbGAgaW4gTW9uaXRvciwgc28gYW4gaWRsZSBzZXNzaW9uIHdva2UgdGhlIGFnZW50IGV2ZXJ5XG4gKiAzMCBtaW51dGVzIHRvIHJlLWFybSwgYW5kIGEgYmFyZSByZS1hcm0gcmVwbGF5ZWQgdXAgdG8gdGhlIGxhc3QgMTAwMCBldmVudHMsXG4gKiBhbnN3ZXJlZCBodW1hbiBtZXNzYWdlcyBpbmNsdWRlZC4gVGhlIHJlcGxheSBpcyBhIGNvcnJlY3RuZXNzIGJ1ZzsgdGhlIGlkbGVcbiAqIHdha2VzIGFyZSBhIGNvc3QgQ29sZSBydWxlZCBhZ2FpbnN0LlxuICpcbiAqIOKUgOKUgCBUSEUgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVHdvIG1vZGVzLCBvbmUgbGluZSBhdCB0aGUgZW5kIG9mIGVhY2g6XG4gKlxuICogICDigKIgYHdhdGNoYCAodGhlIGRlZmF1bHQsIHJ1biB1bmRlciBNb25pdG9yKTogc3RyZWFtcyB1bnRpbCBpdHMgV0lORE9XIGVuZHMsXG4gKiAgICAgdGhlbiBwcmludHMgYHRhaWwud2luZG93YCAoaXQgc2F3IGV2ZW50cyDihpIgcmUtYXJtIE1vbml0b3IpIG9yXG4gKiAgICAgYHRhaWwucXVpZXRgIChpdCBzYXcgbm9uZSDihpIgcnVuIGB0YWlsIC0tb25jZWAgYXMgYSBiYWNrZ3JvdW5kIEJhc2hcbiAqICAgICB0YXNrKS4gQSBQUkVTRU5DRSBzcGVsbCAoYXN0cm9sYWJlLCBncmFwZXZpbmUpIGFsd2F5cyBnZXRzXG4gKiAgICAgYHRhaWwud2luZG93YDogYSBzdG9wLXN0YXJ0IHRhaWwgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzXG4gKiAgICAgY29ubmVjdGlvbiBjYXJyaWVzLiBNaW5kLW1hcHBlciB3YXMgb25lIGFuZCBpcyBub3Qgc2luY2UgMjAyNi0wOS0yNFxuICogICAgIChzZWUgXCJNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFNcIiBiZWxvdykuXG4gKiAgIOKAoiBgb25jZWAgKHJ1biBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrKTogc2xlZXBzIHVudGlsIHRoZSBmaXJzdCBsb2cgZXZlbnQsXG4gKiAgICAgcHJpbnRzIGl0LCBwcmludHMgYHRhaWwud29rZWAgKOKGkiBiYWNrIHRvIE1vbml0b3IpIGFuZCBFWElUUywgd2hpY2ggaXNcbiAqICAgICB3aGF0IHdha2VzIHRoZSBhZ2VudC5cbiAqXG4gKiBFaXRoZXIgbW9kZSBlbmRzIHdpdGggYHRhaWwuY2xvc2VkYCB3aGVuIHRoZSBzZXNzaW9uIGNsb3NlcyBhbmQgYHRhaWwubG9zdGBcbiAqIHdoZW4gdGhlIGRhZW1vbiBpcyBnb25lIChzZXNzaW9uIHNwZWxscyBhbmQgbWluZC1tYXBwZXIpLCBlYWNoIG5hbWluZyBob3cgdG9cbiAqIGNvbWUgYmFjayBpbnN0ZWFkIG9mIGEgcmUtYXJtLiBBIHNpZ25hbCBvciBhIGNhbGxlcidzIGFib3J0IHByaW50cyBub3RoaW5nLlxuICpcbiAqIEV2ZXJ5IHJlLWFybSBjYXJyaWVzIGAtLXNpbmNlIDxjdXJzb3I+YCwgc28gbm90aGluZyByZXBsYXlzOyB0aGUgZGFlbW9uJ3NcbiAqIGJ1ZmZlciBjb3ZlcnMgd2hhdGV2ZXIgbGFuZHMgYmV0d2VlbiBvbmUgd2F0Y2gncyBleGl0IGFuZCB0aGUgbmV4dCdzIGFybS5cbiAqXG4gKiDilIDilIAgREVDSVNJT04gTE9HIChmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogS2l0IGRlY2lzaW9ucyBsaXZlIGluIG1vZHVsZSBoZWFkZXJzICh0aGUgYXJjaGl0ZWN0dXJlIGRvYydzIMKnNCBydWxlOiBcImVhY2hcbiAqIG1vZHVsZSdzIGhlYWRlciBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhY2NvdW50XCIpLiBSdWxlZCBieSBDb2xlOiB0aGUgaHlicmlkLFxuICogdGhlIGFsd2F5cy1ib29rbWFyaywgcHJlc2VuY2Ugc3BlbGxzIGFsd2F5cyByZS1hcm0gTW9uaXRvciwgYm91bnR5J3MgZXhhbXBsZVxuICogZml4ZWQuIFRoZSBmb3VyIGFkanVzdG1lbnRzIHdlcmUgdGhlIHNwaWtlJ3MgcmVxdWlyZW1lbnRzLiBUaGUgcmVzdCBhcmUgdGhlXG4gKiBpbXBsZW1lbnRlcidzIHJ1bGluZ3MsIG1hcmtlZCDimpYgd2l0aCB0aGUgb3B0aW9ucyBub3QgdGFrZW4uXG4gKlxuICogQTEgwrcgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04uIGB0YWlsRXZlbnRzYCBub3cgYWJvcnRzIHRoZVxuICogICAgICBpbi1mbGlnaHQgZmV0Y2ggYmVmb3JlIGl0IHJldHVybnMgb24gYSB0ZXJtaW5hbCBmcmFtZS4gQmVmb3JlLCBpdFxuICogICAgICByZXR1cm5lZCBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIGFuZCBsZWZ0IHRoZSBTU0Ugc3RyZWFtIG9wZW4sIHNvIHRoZVxuICogICAgICBwcm9jZXNzIHN0YXllZCBhbGl2ZTogdW5zZWVuIGZvciBgY2xvc2VkYCAodGhlIHNlcnZlciBlbmRzIHRoYXRcbiAqICAgICAgc3RyZWFtIGl0c2VsZikgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrIHdvdWxkXG4gKiAgICAgIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LCBzaWxlbnRseS4gUGlubmVkIGluXG4gKiAgICAgIGB0YWlsSGFuZG9mZi50ZXN0LnRzYCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQga2VlcHMgdGhlIHN0cmVhbSBvcGVuLlxuICpcbiAqIEEyIMK3IFRIRSBORVhUIEFDVCBERVBFTkRTIE9OIFNUQVRFLiBgaGFuZG9mZigpYCBiZWxvdyBpcyB0aGUgcHVyZSBkZWNpc2lvbjpcbiAqICAgICAgcXVpZXQg4oaSIGJhY2tncm91bmQsIGFjdGl2ZSBvciBwcmVzZW5jZSDihpIgTW9uaXRvciwgd29rZSDihpIgTW9uaXRvcixcbiAqICAgICAgY2xvc2VkIOKGkiBjb21lIGJhY2ssIGxvc3Qg4oaSIGNvbWUgYmFjay4gQ29tZSBiYWNrIGlzIHRoZSBzcGVsbCdzIG93biB2ZXJiXG4gKiAgICAgIChgb3BlbiAtLXJlc3RvcmUgPGlkPmAgZm9yIHRoZSBzZXNzaW9uIHNwZWxscywgYG9wZW4gLS1uby1vcGVuYCBmb3JcbiAqICAgICAgbWluZC1tYXBwZXIgYW5kIGFzdHJvbGFiZSkuXG4gKiAgICAgIOKaliBUSEUgRElTQ09OTkVDVCBERUNJU0lPTjogZm9yIGEgc2Vzc2lvbiBzcGVsbCwgYSBMT1NUIGRhZW1vbiBlbmRzIHRoZVxuICogICAgICB0YWlsIGluIEJPVEggbW9kZXMgd2l0aCBhIHN0ZG91dCBgdGFpbC5sb3N0YCBsaW5lLiBNb25pdG9yIG5vdGlmaWVzIG9ubHlcbiAqICAgICAgb24gc3Rkb3V0LCBzbyB0aGUgb2xkIHN0ZGVyci1vbmx5IGB0YWlsLmRpc2Nvbm5lY3RlZGAgbGVmdCBhXG4gKiAgICAgIE1vbml0b3Itd3JhcHBlZCBhZ2VudCB1bmF3YXJlIG9mIGEgYGtpbGwgLTlgIChFNTUncyBwdXJwb3NlIHVubWV0KSwgYW5kXG4gKiAgICAgIGEgYC0tb25jZWAgb24gYSBkZWFkIGRhZW1vbiB3b3VsZCBoYXZlIHNsZXB0IGZvcmV2ZXIuIFwiTG9zdFwiIGlzXG4gKiAgICAgIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBjb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93LCBuZXZlciBhIGRyb3BwZWRcbiAqICAgICAgc3RyZWFtIGFsb25lOiBhIGxhcHRvcCB0aGF0IHNsZWVwcyBkcm9wcyB0aGUgc3RyZWFtLCByZWNvbm5lY3RzIG9uIHRoZVxuICogICAgICBmaXJzdCB0cnksIGFuZCBtdXN0IHN0YXkgc2lsZW50LlxuICogICAgICAgIE5vdCB0YWtlbjogKGEpIGtlZXAgcmV0cnlpbmcgYW5kIG9ubHkgTU9WRSB0aGUgZGlzY29ubmVjdCBsaW5lIHRvXG4gKiAgICAgICAgc3Rkb3V0IOKAlCBhIHNlc3Npb24gZGFlbW9uIGlzIG5ldmVyIHJlc3Bhd25lZCBieSBpdHMgdGFpbCwgc28gdGhlXG4gKiAgICAgICAgcmV0cmllcyBidXkgbm90aGluZyBhbmQgdGhlIGFnZW50IGlzIHdva2VuIHRvIGJlIHRvbGQgdG8gd2FpdDsgKGIpXG4gKiAgICAgICAgbGVhdmUgaXQgb24gc3RkZXJyIOKAlCB0aGUgZGVmZWN0LlxuICogICAgICDimpYgUHJlc2VuY2Ugc3BlbGxzIGtlZXAgcmV0cnlpbmcsIGFzIGJlZm9yZTogZ3JhcGV2aW5lJ3MgdGFpbCByZXNwYXduc1xuICogICAgICBpdHMgZGFlbW9uIGFuZCBhc3Ryb2xhYmUncyBgam9pbmAgd2FpdHMgZm9yIHRoZSBodW1hbiB0byByZW9wZW4gdGhlXG4gKiAgICAgIGJvYXJkLCBib3RoIGJ5IGRlc2lnbi4gVGhlaXIgZGlzY29ubmVjdCBub3RlcyBzdGF5IHdoZXJlIHRoZXkgd2VyZS5cbiAqXG4gKiBBMyDCtyBRVUlFVCBJUyBUSEUgVEFJTCdTIE9XTiBDT1VOVC4gYGV2ZW50c2AgY291bnRzIHRoZSBsb2cgZnJhbWVzIHRoaXNcbiAqICAgICAgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQuIFRoZSBncm91bmRpbmcgbGluZSwgYSBzcGVsbCdzIGBzdWJzY3JpYmVkYFxuICogICAgICBtYXJrZXIsIGBlcG9jaC5jaGFuZ2VkYCBhbmQgdGhlIGhhbmRvZmYgbGluZSBpdHNlbGYgYXJlIG5vdCBsb2cgZnJhbWVzXG4gKiAgICAgIGFuZCBhcmUgbm90IGNvdW50ZWQ6IGEgZnJhbWUgY291bnRzIG9ubHkgaWYgaXQgY2FycmllcyBhIGxvZyBpZCAoRDMpLFxuICogICAgICBhbmQgYGNvdW50c2AgbGV0cyBhIHNwZWxsIGV4Y2x1ZGUgYSBmcmFtZSB0aGF0IGRvZXMgKGdyYXBldmluZSdzXG4gKiAgICAgIGBzdWJzY3JpYmVkYCBtYXJrZXIsIHdoaWNoIHNlZWRzIHRoZSBib29rbWFyayBmcm9tIGBsYXRlc3RfaWRgKS4gQW55IGxvZyBmcmFtZSBjb3VudHMsIHRoZSBkYWVtb24ncyBgd2FpdGluZ2AgcmVtaW5kZXJcbiAqICAgICAgaW5jbHVkZWQsIHNvIFwicXVpZXRcIiBtZWFucyBub3RoaW5nIG9uIHRoZSBsb2cuXG4gKiAgICAgIOKaliBBIGZyYW1lIHRoZSB0YWlsJ3Mgb3duIGZpbHRlciByZWplY3RzIChib3VudHkncyBvd25lciBzY29wZSwgYVxuICogICAgICBzZWxmLWVjaG8pIGlzIE5PVCBjb3VudGVkIGFuZCBkb2VzIG5vdCBlbmQgYSBgLS1vbmNlYDogaXQgd2FzIG5ldmVyXG4gKiAgICAgIGRlbGl2ZXJlZCwgYW5kIHdha2luZyBvbiBpdCB3b3VsZCBiZSBhIHdha2Ugd2l0aCBub3RoaW5nIHRvIGFjdCBvbiDigJRcbiAqICAgICAgdGhlIGRlZmVjdCB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcmVtb3ZlLiBUaGUgY3Vyc29yIHN0aWxsIGFkdmFuY2VzXG4gKiAgICAgIHBhc3QgaXQgKHRhaWxFdmVudHMnIHJ1bGUpLCBzbyBpdCBuZXZlciByZXBsYXlzIGVpdGhlci5cbiAqICAgICAgQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTsgdGhhdCBoYWxmIGxpdmVzIGluIGVhY2hcbiAqICAgICAgc3BlbGwncyBgdGFpbGAsIHdoaWNoIGtub3dzIHdoZXRoZXIgYC0tc2luY2VgIHdhcyBnaXZlbi5cbiAqXG4gKiBBNCDCtyBUSEUgV0lORE9XLiBgREVGQVVMVF9XSU5ET1dfTVNgID0gdGhlIGNhcCBtaW51cyBgV0lORE9XX01BUkdJTl9NU2BcbiAqICAgICAgKDYwIHMpLCBzbyAxLDc0MCwwMDAgbXMuIFRoZSBtYXJnaW4gaGFzIHRvIGNvdmVyIHRoZSBnYXAgYmV0d2VlbiB0aGVcbiAqICAgICAgaGFybmVzcyBzdGFydGluZyBpdHMgY2xvY2sgYW5kIHRoaXMgcHJvY2VzcyBzdGFydGluZyBpdHMgb3duIChCdW5cbiAqICAgICAgc3RhcnQtdXAsIGEgc2Vzc2lvbiBsb29rdXAsIGEgZGFlbW9uIHNwYXduIG9uIHRoZSBzcGVsbHMgd2hvc2UgYHJlc29sdmVgXG4gKiAgICAgIHNwYXducyBvbmUg4oCUIGJvdW5kZWQgYnkgdGhlaXIgc3RhcnQgdGltZW91dHMsIHdoaWNoIGFyZSBzZWNvbmRzKSBwbHVzXG4gKiAgICAgIHRoZSBsYXN0IGxpbmUncyBmbHVzaCBhbmQgTW9uaXRvcidzIDIwMCBtcyBiYXRjaGluZy4gQSBtaW51dGUgY292ZXJzXG4gKiAgICAgIGFsbCBvZiB0aGF0IG1hbnkgdGltZXMgb3Zlci4gVGhlIHNwaWtlIG1lYXN1cmVkIGEgMTIgc1xuICogICAgICB3aW5kb3cgdW5kZXIgYSAyMCBzIGNhcCBlbmRpbmcgY2xlYW5seTsgbm90aGluZyBoZXJlIGRlcGVuZHMgb24gYVxuICogICAgICBtYXJnaW4gdGhhdCB0aWdodC4gSWYgdGhlIGNhcCB3aW5zIGFueXdheSwgdGhlIGFnZW50IGdldHMgTW9uaXRvcidzXG4gKiAgICAgIGJhcmUgZXhwaXJ5IG5vdGljZSBhbmQgcmUtYXJtcyBzaWxlbnRseSBmcm9tIHRoZSBsYXN0IGlkIGl0IHNhdyDigJQgdGhlXG4gKiAgICAgIHJ1bGluZydzIGZhbGxiYWNrLCBzdGF0ZWQgaW4gZXZlcnkgc2tpbGwuXG4gKiAgICAgIOKaliBUaGUgd2luZG93IGlzIGluamVjdGFibGUgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gdGhyb3VnaFxuICogICAgICBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TYCAoYSBjb3VudCBvZiBtczsgYDBgIHR1cm5zIHRoZSB3aW5kb3cgb2ZmLFxuICogICAgICBmb3IgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsKS4gQW4gZW52IHZhciBhbmQgbm90IGEgZmxhZzogaXQgaXNcbiAqICAgICAgbm90IGFuIGFnZW50J3MgYWN0LCBzbyBpdCBzdGF5cyBvdXQgb2YgZWlnaHQgdmVyYnMnIHNjaGVtYXMuXG4gKlxuICog4pSA4pSAIFRIRSBWRVJJRklFUidTIERFRkVDVFMsIEZJWEVEIE9OIFRIRSBTQU1FIEJSQU5DSCAoMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIG5vLXN0YWtlIHZlcmlmaWVyIHJhbiBldmVyeSBzcGVsbCdzIHJlYWwgdGFpbCBhbmQgZm91bmQgZm91ciB3YXlzIHRoZVxuICogbG9vcCBicm9rZS4gRWFjaCBoYXMgYSBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYDsgRDEgYW5kIEQyIGFsc28gaGF2ZSBhXG4gKiByZWFsLWRhZW1vbiBjZWxsIGluIGBzcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90YWlsLWhhbmRvZmYuaW50ZWdyYXRpb24udGVzdC50c2AuXG4gKlxuICogRDEgwrcgQSBSRS1BUk0gQVQgQSBTRVNTSU9OIFRIQVQgQ0xPU0VEIElOIFRIRSBHQVAgRU5EUyBgdGFpbC5jbG9zZWRgLiBUaGVcbiAqICAgICAgdHJpZ2dlciBpcyBvcmRpbmFyeTogdGhlIGh1bWFuIHByZXNzZXMgQ2xvc2Ugd2hpbGUgdGhlIGFnZW50IGhhbmRsZXNcbiAqICAgICAgYHRhaWwud29rZWAuIFRoZSBzZXNzaW9uIHNwZWxscyBzdG9wcGVkIG9ubHkgd2hlbiBUSElTIHByb2Nlc3MgaGFkXG4gKiAgICAgIG9uY2UgcmVhY2hlZCB0aGUgc2Vzc2lvbiwgc28gdGhlIHJlLWFybSByZXRyaWVkIFwibm8gc2Vzc2lvbiB5ZXRcIiBvblxuICogICAgICBzdGRlcnIgZm9yZXZlciDigJQgYW5kIGl0cyBgLS1vbmNlYCBuZXZlciBleGl0ZWQuIFJ1bGU6IGEgdGFpbCBnaXZlblxuICogICAgICBgLS1zZXNzaW9uYCBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElORyBzZXNzaW9uLCBzbyBub3RcbiAqICAgICAgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQ7IHRoZSBzcGVsbCdzIGBvblVucmVzb2x2ZWRgIHNheXMgXCJzdG9wXCJcbiAqICAgICAgYW5kIHRoaXMgbW9kdWxlIHJlYWRzIEFOWSBzdG9wIGFzIGNsb3NlZC4gQSBiYXJlIGZpcnN0IGFybSBzdGlsbFxuICogICAgICB3YWl0cyBmb3IgYSBzZXNzaW9uIHRvIGFwcGVhci4g4pqgIFwiR2l2ZW5cIiBtZWFucyBPTiBUSEUgQ09NTUFORCBMSU5FXG4gKiAgICAgIChyZXZpZXcgQjEpOiBib3VudHkgYWxzbyByZXNvbHZlcyBhIHNlc3Npb24gZnJvbVxuICogICAgICBgJEJPVU5UWV9TRVNTSU9OX0tFWWAsIGAkQk9VTlRZX1NFU1NJT05gIG9yIGEgYC5ib3VudHktc2Vzc2lvbmAgZmlsZSxcbiAqICAgICAgd2hpY2ggZXZlcnkgYW50aGlsbCBzZWF0IGhhcywgYW5kIGEgc2VhdCdzIGZpcnN0IGFybSBtdXN0IHdhaXQuIEFcbiAqICAgICAga2V5ZWQgYm91bnR5IGJvYXJkIGNvbWVzIGJhY2sgYnkgaXRzIGtleSAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCk7XG4gKiAgICAgIHJlc3RvcmluZyBpdCBieSBpZCBzcGF3bnMgYW4gdW5rZXllZCBzdHJheS5cbiAqIEQyIMK3IEEgQk9PS01BUksgQ0FOTk9UIE9VVExJVkUgSVRTIExPRy4gQSByZXN0b3JlZCBkYWVtb24ncyBpZHMgYmVnaW4gYXQgMSxcbiAqICAgICAgYW5kIHRoZSBraXQncyBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93biBieSByZXBsYXlpbmcgd2hvbGU7XG4gKiAgICAgIHRoZSB0YWlsIGtlcHQgaXRzIGhpZ2hlciBjdXJzb3IsIHNvIGV2ZXJ5IHJlLWFybSByZXBsYXllZCB0aGUgbmV3IGxvZ1xuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVHdvIGhhbHZlczpcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFRocmVlIHBhcnRzOlxuICogICAgICAgIChhKSB0aGUgbmV0IOKAlCBgdGFpbEV2ZW50c2AnIGByZXN0YXJ0T25SZXBsYXlgLCBvbiBmb3IgZXZlcnkgc3BlbGwsXG4gKiAgICAgICAgICAgIHJlYWRzIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBhcyBhIHJlc3RhcnRlZCBsb2dcbiAqICAgICAgICAgICAgYW5kIHJlc2V0cyB0aGUgY3Vyc29yO1xuICogICAgICAgIChiKSB0aGUgcnVsZSDigJQgdGhlIGB0YWlsLmNsb3NlZGAvYHRhaWwubG9zdGAgaGludCwgYW5kIGV2ZXJ5IHNraWxsLFxuICogICAgICAgICAgICBzYXk6IHJ1biB0aGUgY29tbWFuZCB0aGUgbGluZSBuYW1lcywgdGhlbiB0YWlsIFdJVEggTk9cbiAqICAgICAgICAgICAgYC0tc2luY2VgIChhIHJlc3RvcmVkIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nOyBib3VudHkncyByZXN0b3JlXG4gKiAgICAgICAgICAgIGV2ZW4gbWludHMgYSBuZXcgaWQpO1xuICogICAgICAgIChjKSBUSEUgRVBPQ0ggSU4gVEhFIEJPT0tNQVJLIOKAlCDimpYgQSBSRVZFUlNBTC4gVGhlIGZpcnN0IHZlcnNpb24gb2ZcbiAqICAgICAgICAgICAgdGhpcyBlbnRyeSBsaXN0ZWQgXCJjYXJyeSB0aGUgZXBvY2ggaW4gdGhlIGJvb2ttYXJrXCIgYXMgbm90IHRha2VuXG4gKiAgICAgICAgICAgIChhIG5ldyBmbGFnIG9uIGVpZ2h0IHZlcmJzOyBhbiBlcG9jaCBzZWVuIG9ubHkgb25jZSBhIGZyYW1lXG4gKiAgICAgICAgICAgIGFycml2ZXMpLiBUaGUgcmV2aWV3ZXIgdGhlbiBzaG93ZWQgKGEpJ3MgYmxpbmQgc3BvdCBMSVZFOiBhbiBvbGRcbiAqICAgICAgICAgICAgYm9va21hcmsgYXQgb3IgYmVsb3cgdGhlIE5FVyBsb2cncyBsZW5ndGggbWFrZXMgdGhlIGRhZW1vbiBzZW5kXG4gKiAgICAgICAgICAgIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hblxuICogICAgICAgICAgICBtZXNzYWdlIGF0IG5ldyBpZCAyIHVuZGVyIGEgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHdpdGggbm9cbiAqICAgICAgICAgICAgbm90aWNlLiBUaHJlZSBwYXRocyByZWFjaCBpdDogY29taW5nIGJhY2sgd2l0aG91dCBmb2xsb3dpbmcgKGIpO1xuICogICAgICAgICAgICB0aGUgTW9uaXRvci1jYXAgZmFsbGJhY2sgKFwicmUtYXJtIGZyb20gdGhlIGxhc3QgaWQgeW91IHNhd1wiKVxuICogICAgICAgICAgICBhY3Jvc3MgYSByZXN0YXJ0OyBhbmQgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbi1wcm9jZXNzXG4gKiAgICAgICAgICAgIChhc3Ryb2xhYmUsIG9yIG1pbmQtbWFwcGVyIHdoZW4gaXRzIGRhZW1vbiBpcyBiYWNrIGJlZm9yZSB0aGVcbiAqICAgICAgICAgICAgbG9zdCBydWxlIGZpcmVzKSB3aG9zZSBmaXJzdCBmcmFtZSBhZnRlciBhIHJlc3RhcnQgaXMgYWxyZWFkeVxuICogICAgICAgICAgICBwYXN0IGl0cyBib29rbWFyay5cbiAqICAgICAgICAgICAgVGhlIGZpeCBuZWVkcyBubyBuZXcgZmxhZyBhbmQgbm8gd2lyZSBjaGFuZ2U6IHRoZSBib29rbWFyayBpc1xuICogICAgICAgICAgICBwcmludGVkIGAtLXNpbmNlIE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCksIHRoZSBjbGllbnQgc3RhcnRzXG4gKiAgICAgICAgICAgIHdpdGggdGhhdCBlcG9jaCAoYHNpbmNlRXBvY2hgKSwgYW5kIGFuIGVwb2NoIGNoYW5nZSB3aG9zZSBmcmFtZVxuICogICAgICAgICAgICBpcyBwYXN0IHRoZSBhc2tlZCBjdXJzb3IgcmUtcmVhZHMgdGhlIG5ldyBsb2cgZnJvbSAwLiBUaGUgc2FtZVxuICogICAgICAgICAgICByZWNvbm5lY3QgY292ZXJzIHRoZSBpbi1wcm9jZXNzIHByZXNlbmNlIGNhc2UuXG4gKiAgICAgIOKaoCBTVEFURUQgTElNSVQ6IG9ubHkgZGFlbW9ucyB0aGF0IHN0YW1wIGFuIGVwb2NoIGdldCAoYykg4oCUXG4gKiAgICAgIHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUgYW5kIG1pbmQtbWFwcGVyLiBHbGFtb3VyLCBpbWFnbywgbWFncGllIGFuZFxuICogICAgICBib3VudHkgc3RhbXAgbm9uZSAoc2Vzc2lvbi1zY29wZWQgbG9ncywgcnVsZWQgc28gaW4gRDM5L0I4OyBib3VudHknc1xuICogICAgICBzZXJ2ZXIgaGVhZGVyIG5hbWVzIHRoaXMgcmVzaWR1ZSksIHNvIGZvciB0aGVtIHRoZSBnYXAgc3RheXMgb3BlbiBvblxuICogICAgICB0aGUgZmFsbGJhY2sgcGF0aCwgKGEpIGNvdmVycyB0aGUgd2hvbGUtcmVwbGF5IGNhc2UgYW5kIChiKSB0aGVcbiAqICAgICAgY29tZS1iYWNrIHBhdGguIENsb3NpbmcgaXQgdGhlcmUgaXMgYSBkYWVtb24gY2hhbmdlOiBhbiBlcG9jaCBvblxuICogICAgICBgY3JlYXRlRXZlbnRMb2dgLiBFdmVyeSBzcGVsbCBwcmludHMgdGhlIG5ldCdzIHJlc2V0IGFzXG4gKiAgICAgIGBlcG9jaC5jaGFuZ2VkYCAoYFwiZXBvY2hcIjogXCJ1bmtub3duXCJgIHdoZXJlIHRoZXJlIGlzIG5vbmUpLlxuICogRDMgwrcgT05MWSBBIEZSQU1FIFdJVEggQSBMT0cgSUQgQ09VTlRTLiBHbGFtb3VyJ3MgYW5kIGltYWdvJ3MgdGFiIHBpbmdzXG4gKiAgICAgIChgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCkgY2Fycnkgbm8gaWQ6IG5vdCBvbiB0aGUgbG9nLCBzbyBhIGxhcHRvcFxuICogICAgICBsaWQgbm8gbG9uZ2VyIHdha2VzIGEgYC0tb25jZWAsIGFuZCBpbWFnbydzIGdyZXAgbm8gbG9uZ2VyIHNob3dzIGFcbiAqICAgICAgYHRhaWwud29rZWAgd2l0aCBub3RoaW5nIGFib3ZlIGl0LlxuICogRDQgwrcgQSBIVU1BTidTIFdBVENIIEhBUyBOTyBXSU5ET1cuIGBncmFwZXZpbmUgdGFpbCAtLWh1bWFuYCBwYXNzZXNcbiAqICAgICAgYHdpbmRvd01zOiAwYDsgbm8gb3RoZXIgc3BlbGwgaGFzIGEgaHVtYW4gbW9kZS4gRXZlcnkgYHRhaWxgJ3MgaGVscFxuICogICAgICBjYXJyaWVzIGBXSU5ET1dfSEVMUGAsIHdoaWNoIG5hbWVzIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MGAuXG4gKiBBbHNvOiBldmVyeSBjb21lLWJhY2sgY29tbWFuZCBjYXJyaWVzIGAtLW5vLW9wZW5gLCBzbyBydW5uaW5nIGl0IG9wZW5zIG5vXG4gKiBicm93c2VyIHRhYi5cbiAqXG4gKiDimqAgS05PV04gRURHRSwgTk9UIEZJWEVEIChmb3VuZCBieSB0aGUgcmUtcmV2aWV3KTogYSBrZXllZCBib3VudHkgRklSU1QgYXJtXG4gKiAgIChhbiBhbnRoaWxsIHNlYXQpIHdob3NlIHdpbmRvdyBlbmRzIGJlZm9yZSBpdHMgYm9hcmQgZXZlciBvcGVucyBwcmludHMgYVxuICogICByZS1hcm0gcGlubmVkIHRvIHRoZSBkZXJpdmVkIGlkIHdpdGggYW4gZW1wdHkgYm9va21hcmtcbiAqICAgKGAtLXNlc3Npb24gay3igKYgLS1zaW5jZT0tMSAtLW9uY2VgKS4gVGhhdCByZS1hcm0gaXMgYSByZS1hcm0gYnkgRDEncyBydWxlLFxuICogICBzbyBpZiB0aGUgYm9hcmQgaXMgc3RpbGwgbm90IHVwIOKAlCB0aGUgbGVhZCBtb3JlIHRoYW4gb25lIHdpbmRvdyAoMjkgbWluKVxuICogICBsYXRlIOKAlCB0aGUgc2VhdCBkb2VzIG5vdCB3YWl0LiBNaW5vcjogdGhlIG5leHQgc3RlcCBpdCBuYW1lc1xuICogICAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCkgaXMgdGhlIHJpZ2h0IG9uZSBhbnl3YXkuIFNpbmNlICM5OCAoMjAyNi0wOS0yNylcbiAqICAgaXQgbm8gbG9uZ2VyIHNheXMgYHRhaWwuY2xvc2VkYCBhYm91dCBhIGJvYXJkIHRoYXQgbmV2ZXIgb3BlbmVkOiBhIG5hbWVkXG4gKiAgIGAtLXNlc3Npb25gIHdpdGggbm8gc25hcHNob3Qgb24gZGlzayBleGl0cyBgbm90X2ZvdW5kYCBhZnRlciBhIGdyYWNlLlxuICpcbiAqIOKUgOKUgCBUSEUgQ09NTUFORCBOQU1FUyBOTyBQQVRIIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbGluZSdzIGBjb21tYW5kYCBpcyB0aGUgVkVSQiBBTkQgSVRTIEFSR1VNRU5UUyBPTkxZXG4gKiAoYHRhaWwgLS1zZXNzaW9uIFggLS1zaW5jZSBOQEUgLS1vbmNlYCksIHBsdXMgYHNwZWxsYCwgYW5kIHRoZSBhZ2VudCBydW5zIGl0XG4gKiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzYC4gSXQgdXNlZFxuICogdG8gYmUgcnVubmFibGUgYXMgcHJpbnRlZCwgaGVhZGVkIGJ5IGBidW4gPGFyZ3ZbMV0+YCDigJQgYW5kIGZvciBhbiBpbnN0YWxsZWRcbiAqIHBsdWdpbiBgYXJndlsxXWAgaXMgaW5zaWRlIGEgVkVSU0lPTkVEIGNhY2hlIGRpcmVjdG9yeS4gQW4gdXBncmFkZSBtYXJrcyB0aGVcbiAqIG9sZCBkaXJlY3Rvcnkgb3JwaGFuZWQgYW5kIGRlbGV0ZXMgaXQgbGF0ZXIgKG1lYXN1cmVkIGluXG4gKiBgZG9jcy9pdGVtcy90YWlsLXJlYXJtLWNvbW1hbmQtbmFtZXMtYS12ZXJzaW9uZWQtcGx1Z2luLXBhdGgubWRgKSxcbiAqIHNvIGEgbGluZSBwcmludGVkIGJlZm9yZSBhbiB1cGdyYWRlIGZpcnN0IHJhbiBTVEFMRSBjb2RlIGFnYWluc3QgYSBuZXdlclxuICogZGFlbW9uLCB0aGVuIGZhaWxlZCB3aXRoIFwibW9kdWxlIG5vdCBmb3VuZFwiIG9uY2UgdGhlIGRpcmVjdG9yeSB3YXMgZ29uZS4gTm9cbiAqIHN0YWJsZSBwYXRoIGV4aXN0cyB0byBwcmludCBpbnN0ZWFkOiB0aGUgY2FjaGUsIGAkQ0xBVURFX1BMVUdJTl9ST09UYCBhbmQgdGhlXG4gKiBpbnN0YWxsIHJlY29yZCBhcmUgYWxsIHZlcnNpb25lZC5cbiAqICAgVGhlIHNraWxsJ3MgbGF1bmNoZXIgaXMgYWx3YXlzIHRoZSB2ZXJzaW9uIHRoZSBzZXNzaW9uIGxvYWRlZC4gQ29sZSdzXG4gKiByZWFzb25pbmc6IHRoZSB3b3JzdCBjYXNlIGlzIHRoYXQgdGhlIENMSSBjaGFuZ2VkIGFuZCB0aGUgYWdlbnQgZ2V0cyBhblxuICogZXJyb3Ig4oCUIGFuZCBpZiB0aGUgdG9vbHMgYXJlIGRlc2lnbmVkIHJpZ2h0LCB0aGF0IGVycm9yIHNheXMgd2hhdCB3ZW50XG4gKiB3cm9uZy4gU28gdGhlIHBhcnNlcnMgYXJlIHRoZSBvdGhlciBoYWxmIG9mIHRoaXMgcnVsaW5nOiBgcmVhZFNpbmNlYCByZWZ1c2VzXG4gKiBhbnkgYC0tc2luY2VgIGZvcm0gYSB0YWlsIGRvZXMgbm90IGFjY2VwdCB3aXRoIGEgdXNhZ2UgZXJyb3IgTkFNSU5HIHRoZVxuICogZm9ybXMgaXQgZG9lcywgdGhlIHNhbWUgd2F5IG9uIGFsbCBlaWdodCB0YWlscywgaW5zdGVhZCBvZiBtaXNwYXJzaW5nIGl0LlxuICogICBOb3QgdGFrZW46IHByaW50aW5nIHRoZSBwYXRoIEFORCB0aGUgYXJncyAob3B0aW9uIEEgb2YgdGhlIGl0ZW0g4oCUIHR3b1xuICogY29tbWFuZHMgd2hlcmUgb25lIGlzIHdyb25nIGFmdGVyIGFuIHVwZ3JhZGUpOyBhIGxhdW5jaGVyIHRoYXQgbm90aWNlcyBpdCBpc1xuICogb3JwaGFuZWQgYW5kIHJlLWV4ZWNzIGEgbmV3ZXIgc2libGluZyAoQiDigJQgaXQgbGVhbnMgb24gYSBDbGF1ZGUgQ29kZVxuICogaW50ZXJuYWwgbWFya2VyIGFuZCBkb2VzIG5vdGhpbmcgb25jZSB0aGUgZGlyZWN0b3J5IGlzIGRlbGV0ZWQpOyB2ZXJzaW9uXG4gKiBuZWdvdGlhdGlvbi5cbiAqXG4gKiDilIDilIAgTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC9taW5kLW1hcHBlci1xdWlldC1oYW5kb2ZmYC4gSXQgUkVWRVJTRVMgdGhlIGltcGxlbWVudGVyJ3NcbiAqIHJ1bGluZyBvZiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRoYXQgbWluZC1tYXBwZXIgaXMgYSBwcmVzZW5jZSBzcGVsbFxuICogKGl0cyBkYWVtb24gY291bnRzIGFuIG9wZW4gU1NFIHRhaWwgYXMgdGhlIGFnZW50IHByZXNlbnQsIHNvIHRoZSB3aW5kb3dcbiAqIGFsd2F5cyByZS1hcm1lZCBNb25pdG9yKS4gQ29sZSdzIHJlYXNvbmluZzogbWluZC1tYXBwZXIgc2Vzc2lvbnMgYXJlIHVzZWRcbiAqIGxpa2Ugc2NyaXB0b3JpdW0ncywgYnVyc3RzIG9mIGFjdGl2aXR5IHdpdGggYnJlYWtzLCBhbmQgaW4gYSBicmVhayB0aGUgYWdlbnRcbiAqIHNob3VsZCBub3QgYmUgd29rZW4gZXZlcnkgMzAgbWludXRlcy4gU28gbWluZC1tYXBwZXIgdGFrZXMgdGhlIHF1aWV0IGhhbmRvZmZcbiAqIHRvIGAtLW9uY2VgLCB0aGUgbG9zdCBjb21lLWJhY2sgKGBvcGVuIC0tbm8tb3BlbmApLCBhbmQga2VlcHMgaXRzXG4gKiBgLS1zaW5jZSBOQGVwb2NoYCBib29rbWFyay4gVGhyZWUgdGhpbmdzIGhhZCB0byBiZSBzZXR0bGVkIHRvIG1ha2UgdGhhdFxuICogaG9uZXN0LCBlYWNoIHBpbm5lZCBpbiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQve3RhaWwscHJlc2VuY2V9LnRlc3QudHNgXG4gKiBhbmQgbXV0YXRpb24tY29uZmlybWVkOlxuICpcbiAqIE0xIMK3IFBSRVNFTkNFIExJTkdFUlMgQUNST1NTIFRIRSBHQVBTICh0aGUgZGFlbW9uLCBgc2VydmVyLnRzYFxuICogICAgICBgYWRqdXN0QWdlbnRzYCkuIEEgb25lLXNob3QgaG9sZHMgYW4gU1NFIGNvbm5lY3Rpb24sIHNvIGl0IENPVU5UUyBhc1xuICogICAgICBwcmVzZW50LCB3aGljaCBpcyB0cnVlOiB0aGUgYWdlbnQgd2lsbCB3YWtlIG9uIHRoZSBuZXh0IGV2ZW50LiBUaGUgZ2Fwc1xuICogICAgICBhcmUgdGhlIHByb2JsZW06IHdpbmRvdyDihpIgcmUtYXJtLCBxdWlldCDihpIgYC0tb25jZWAsIGFuZCBhYm92ZSBhbGxcbiAqICAgICAgYHRhaWwud29rZWAg4oaSIHRoZSBhZ2VudCBoYW5kbGVzIHRoZSBldmVudCDihpIgTW9uaXRvciwgd2hpY2ggbGFzdHMgdGhlXG4gKiAgICAgIGFnZW50J3Mgd2hvbGUgdHVybi4gUmF3LCB0aGUgc3VyZmFjZSdzIGhlYWRlciBkb3QgKHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgIHByZXNlbmNlIGRyaXZlcyB0aGVyZSwgYmVzaWRlcyB0aGUgZGFlbW9uJ3MgYXV0by1gcmVjZWl2ZWRgIGZsaXAgb24gYVxuICogICAgICBodW1hbiBtZXNzYWdlKSByZWFkIFwiY29ubmVjdGVkIOKAlCBubyBhZ2VudCBvbiB0aGlzIHByb2plY3RcIiB3aGlsZSB0aGVcbiAqICAgICAgYWdlbnQgd2FzIHdvcmtpbmcgdGhlIGJvYXJkLCBhbmQgYSBtZXNzYWdlIHNlbnQgdGhlbiBnb3Qgbm9cbiAqICAgICAgYHJlY2VpdmVkYC4gVGhlIGRhZW1vbiBoYXMgbm8gaWRsZSBjbG9zZSwgc28gbm90aGluZyBlbHNlIHJlYWN0cy4gTm93XG4gKiAgICAgIHRoZSBjb3VudCBIT0xEUyBmb3IgYE1JTkRfTUFQUEVSX1BSRVNFTkNFX0xJTkdFUl9NU2AgKDE1MCBzLCB0aGUgc3RhbGxcbiAqICAgICAgd2luZG93J3MgYmVhdCkgYWZ0ZXIgdGhlIGxhc3QgdGFpbCBjbG9zZXM6IGEgdGFpbCBvcGVuaW5nIGluc2lkZSBpdFxuICogICAgICBlbWl0cyBub3RoaW5nLCBhbiBhZ2VudC1vbmx5IHdyaXRlIChgL2FjdGl2aXR5YCwgYW4gYWdlbnQgYC9zZW5kYClcbiAqICAgICAgcmVzdGFydHMgaXQsIGFuZCBzaWxlbmNlIHBhc3QgaXQgZHJvcHMgdGhlIGNvdW50IHRvIDAuXG4gKiAgICAgIOKaliBOb3QgdGFrZW46IHJlLWFybWluZyBNb25pdG9yIEJFRk9SRSBoYW5kbGluZyBhIHdva2VuIGV2ZW50ICh0aGF0IGlzXG4gKiAgICAgIHRoZSBzaGFyZWQgcnVsZSwgd29yZC1mb3Itd29yZCBpbiBldmVyeSBzcGVsbCk7IHJlZnJlc2hpbmcgb24gZXZlcnlcbiAqICAgICAgYm9hcmQgd3JpdGUgKHRoZSBicm93c2VyIFBPU1RzIHRoZSBzYW1lIHJvdXRlcywgc28gdGhlIGh1bWFuJ3Mgb3duXG4gKiAgICAgIGNsaWNrcyB3b3VsZCBrZWVwIHRoZSBkb3QgbGl0KS4gQ29zdDogYW4gYWdlbnQgdGhhdCByZWFsbHkgbGVmdCByZWFkc1xuICogICAgICBcImhlcmVcIiBmb3IgdXAgdG8gMTUwIHMuXG4gKiBNMiDCtyBgcHJlc2VuY2UuY2hhbmdlZGAgSVMgTk9UIENPVU5URUQgKG1pbmQtbWFwcGVyJ3MgYGNvdW50c2ApLiBJdCBpcyBPTlxuICogICAgICBUSEUgTE9HLCB3aXRoIGFuIGlkLCBhbmQgYSB0YWlsJ3Mgb3duIGNvbm5lY3QgZW1pdHMgb25lIG9udG8gaXRzIG93blxuICogICAgICBzdHJlYW0sIHNvIGNvdW50ZWQgaXQgbWFkZSBldmVyeSB3aW5kb3cgXCJhY3RpdmVcIiBhbmQgd291bGQgd2FrZSBldmVyeVxuICogICAgICBgLS1vbmNlYCBvbiBpdHNlbGYuIFRoZSBsaW5nZXIgcmVtb3ZlcyBtb3N0IG9mIHRoYXQgY2h1cm47IGBjb3VudHNgXG4gKiAgICAgIHJlbW92ZXMgdGhlIHJlc3QgKGEgZmlyc3QgYXJtLCBhbm90aGVyIGFnZW50IGNvbWluZyBvciBnb2luZykuXG4gKiBNMyDCtyBBIERFQUQgREFFTU9OIElTIExPU1QsIE5PVCBVTlJFU09MVkVEIChtaW5kLW1hcHBlcidzIGByZXNvbHZlYCkuIEl0c1xuICogICAgICBkaXNjb3ZlcnkgcHJvYmVzIHRoZSBkYWVtb24ncyBwaWQsIHNvIGEga2lsbGVkIGRhZW1vbiBtYWRlIGByZXNvbHZlYFxuICogICAgICBhbnN3ZXIgbnVsbCBhbmQgYW4gdW5yZXNvbHZlZCB0YWlsIHJldHJpZXMgZm9yZXZlcjogYSBgLS1vbmNlYCB3b3VsZFxuICogICAgICBoYXZlIHNsZXB0IGZvciBnb29kIChEMSdzIGRlZmVjdCkuIFRoZSB0YWlsIGtlZXBzIHRoZSBsYXN0IFVSTCBpdFxuICogICAgICByZXNvbHZlZCwgc28gdGhlIGRlYWQgcG9ydCByZWZ1c2VzIGFuZCBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgZW5kcyBpdFxuICogICAgICB3aXRoIGB0YWlsLmxvc3RgIOKGkiBgb3BlbiAtLW5vLW9wZW5gLCB0aGVuIGEgdGFpbCB3aXRoIG5vIGAtLXNpbmNlYC5cbiAqICAgICAgTWluZC1tYXBwZXIgaGFzIG5vIHNlc3Npb24gdG8gY2xvc2UsIHNvIGl0IG5ldmVyIHByaW50cyBgdGFpbC5jbG9zZWRgLlxuICogICAgICBNZWFzdXJlZCBvbiBhIHJlYWwgYGtpbGwgLTlgIHVuZGVyIGEgYC0tb25jZWA6IGB0YWlsLmxvc3RgIDcgcyBsYXRlcixcbiAqICAgICAgbm90IDAuNzUgcywgYmVjYXVzZSBtaW5kLW1hcHBlcidzIG93biBiYWNrb2ZmIHN0YXJ0cyBhdCAxIHMgKDEgKyAyICsgNCkuXG4gKiAgICAgIE0x4oCTTTMgd2VyZSBkcml2ZW4gb24gYSByZWFsIGRhZW1vbiB3aXRoIGEgNCBzIHdpbmRvdzogYWN0aXZlIOKGkiB3aW5kb3csXG4gKiAgICAgIHF1aWV0IOKGkiBgLS1vbmNlYCwgYSBodW1hbiBtZXNzYWdlIHdva2UgaXQsIGJhY2sgdG8gTW9uaXRvcjsgcHJlc2VuY2VcbiAqICAgICAgbmV2ZXIgZHJvcHBlZCBhY3Jvc3MgdGhlIGdhcHMuXG4gKlxuICog4pqWIGAtLW9uY2VgIEVORFMgT04gVEhFIEZJUlNUIEZSQU1FLCB3aXRoIG5vIGRyYWluLiBBIGJ1cnN0IGFycml2ZXMgc3BsaXQ6IHRoZVxuICogICBmaXJzdCBldmVudCBvbiB0aGUgb25lLXNob3QsIHRoZSByZXN0IG9uIHRoZSBNb25pdG9yIHJlLWFybSwgd2hpY2ggbG9zZXNcbiAqICAgbm90aGluZyBiZWNhdXNlIG9mIHRoZSBib29rbWFyay4gVGhlIHNwaWtlIG9mZmVyZWQgYSB+MjAwIG1zIGRyYWluIGFzIGFuXG4gKiAgIG9wdGlvbiwgbm90IGEgcmVxdWlyZW1lbnQ7IG5vdCB0YWtlbiwgYmVjYXVzZSBpdCBhZGRzIGEgdGltZXIgdG8gdGhlXG4gKiAgIGV4aXQgcGF0aCB3aG9zZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byBtYWtlIGltcG9zc2libGUuXG4gKiDimpYgVEhFIExJTkUnUyBgY29tbWFuZGAgSVMgQ09NUExFVEUgQlVUIEZPUiBUSEUgTEFVTkNIRVI6IHBpbm5lZCB0byB0aGVcbiAqICAgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlIHNraWxscyBuYW1lIHRoZVxuICogICBydWxlIG9uY2UsIGxhdW5jaGVyIGZvcm0gaW5jbHVkZWQ7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqXG4gKiBTMSDCtyBXSE8gQ0xPU0VEIElUIFJJREVTIFRIRSBMSU5FIChzY3JpcHRvcml1bSdzIEVuZCBzZXNzaW9uLCAyMDI2LTEwLTAxKS5cbiAqICAgICAgQSBzcGVsbCB3aG9zZSBgY2xvc2VkYCBmcmFtZSBzYXlzIHdobyBlbmRlZCB0aGUgc2Vzc2lvbiBwYXNzZXNcbiAqICAgICAgYGNsb3NlZEJ5YCwgYW5kIGB0YWlsLmNsb3NlZGAgY2FycmllcyBpdCBhcyBgYnlgLiBgYnk6IFwiaHVtYW5cImAgY2hhbmdlc1xuICogICAgICB0aGUgaGludDogdGhlIGh1bWFuIGVuZGVkIGl0IE9OIFBVUlBPU0UsIHNvIHRoZSBhZ2VudCBzdG9wcyBhbmQgZG9lcyBub3RcbiAqICAgICAgcmVvcGVuIHVubGVzcyBhc2tlZCDigJQgdGhlIHdheSBiYWNrIGlzIHN0aWxsIG5hbWVkLCBjb25kaXRpb25lZCBvbiB0aGF0LlxuICogICAgICBUaGUgYWdlbnQgcm91dGVzIG9uIGBieWAsIG5ldmVyIG9uIHRoZSBoaW50J3MgcHJvc2UuIEEgcmUtYXJtIGFmdGVyXG4gKiAgICAgIHRoZSBlbmQgc2VlcyBubyBjbG9zaW5nIGZyYW1lIChEMSdzIHBhdGgpLCBzbyB0aGUgc3BlbGwgYWxzbyBwYXNzZXNcbiAqICAgICAgYGdvbmVCeWAsIHJlYWQgZnJvbSB3aGVyZSB0aGUgZmFjdCBvdXRsaXZlcyB0aGUgZGFlbW9uOyB3aXRob3V0IGl0IHRoZVxuICogICAgICByZS1hcm1lZCBsaW5lIGRyb3BwZWQgYGJ5YCBhbmQgaW52aXRlZCB0aGUgcmVvcGVuICh2ZXJpZmllciwgMjAyNi0xMC0wMSkuXG4gKiAgICAgIOKaliBPcHRpb25zIG5vdCB0YWtlbjogYSBzcGVsbC1zaWRlIHJld3JpdGUgb2YgdGhlIHByaW50ZWQgbGluZSAoYSBzZWNvbmRcbiAqICAgICAgd3JpdGVyIG9mIHRoZSBzYW1lIGxpbmUpLCBvciBhIHNwZWxsLXN1cHBsaWVkIGhpbnQgKGVhY2ggc3BlbGwgd291bGRcbiAqICAgICAgd29yZCBcIm9uIHB1cnBvc2VcIiBpdHMgb3duIHdheSkuXG4gKi9cbmltcG9ydCB7IHR5cGUgU3NlRnJhbWUsIHR5cGUgVGFpbE9wdGlvbnMsIHRhaWxFdmVudHMgfSBmcm9tIFwiLi90YWlsRXZlbnRzXCI7XG5cbi8qKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3IgY2FwLCBwZXIgdGhlIHRvb2wncyBzY2hlbWEgKFwiRGVhZGxpbmVzIGFib3ZlXG4gKiAgMTgwMDAwMG1zIGFyZSBjYXBwZWQgdG8gMTgwMDAwMG1zXCIpLiBBIGhhcm5lc3MgbnVtYmVyOiBpZiBpdCBjaGFuZ2VzLCB0aGlzXG4gKiAgY2hhbmdlcywgYW5kIHNvIGRvZXMgdGhlIHNraWxscycgYHRpbWVvdXRfbXNgLiAqL1xuZXhwb3J0IGNvbnN0IE1PTklUT1JfQ0FQX01TID0gMV84MDBfMDAwO1xuLyoqIFNlZSBBNCBpbiB0aGUgaGVhZGVyIGZvciB3aHkgYSBtaW51dGUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX01BUkdJTl9NUyA9IDYwXzAwMDtcbmV4cG9ydCBjb25zdCBERUZBVUxUX1dJTkRPV19NUyA9IE1PTklUT1JfQ0FQX01TIC0gV0lORE9XX01BUkdJTl9NUztcbi8qKiBUaGUgaW5qZWN0aW9uIHBvaW50IGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIChzZWUgQTQpLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19FTlYgPSBcIlNQRUxMQk9PS19UQUlMX1dJTkRPV19NU1wiO1xuLyoqIFRoZSBvbmUgc2VudGVuY2UgZXZlcnkgYHRhaWxgJ3MgaGVscCBjYXJyaWVzLCBzbyBhIGh1bWFuIHdhdGNoaW5nIGluIGFcbiAqICB0ZXJtaW5hbCBmaW5kcyB0aGUgZXNjYXBlIGhhdGNoIHdoZXJlIHRoZXkgbG9vayAoRDQpLiBXb3JkZWQgb25jZSBoZXJlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19IRUxQID1cbiAgXCJlbmRzIGl0c2VsZiBiZWZvcmUgTW9uaXRvcidzIDMwLW1pbnV0ZSBjYXAgd2l0aCBhIGxpbmUgbmFtaW5nIHRoZSBuZXh0IGFjdDsgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsIGtlZXBzIGl0IG9wZW4gd2l0aCBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MFwiO1xuXG4vKiogQ29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdyB0aGF0IG1ha2UgdGhlIGRhZW1vbiBcImxvc3RcIiAoc2VlIEEyKS4gVGhyZWVcbiAqICBzcGFuIGFib3V0IDAuNzUgcyB1bmRlciB0aGUga2l0J3MgZGVmYXVsdCBiYWNrb2ZmICgyNTAgKyA1MDAgbXMgYmV0d2VlblxuICogIHRoZW0pOiBhIGxpdmUgZGFlbW9uIG5ldmVyIHJlZnVzZXMgaXRzIG93biBwb3J0LCBhbmQgdGhlIHR3byBleHRyYSBhdHRlbXB0c1xuICogIG9ubHkgYnV5IHRvbGVyYW5jZSBmb3IgYSByZXN0YXJ0IHRoYXQgcmViaW5kcyB0aGUgc2FtZSBwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IExPU1RfQUZURVJfUkVGVVNBTFMgPSAzO1xuXG4vKiogVGhlIHdpbmRvdyBsZW5ndGg6IHRoZSBlbnYgdmFsdWUgd2hlbiBpdCBpcyBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyLCBlbHNlIHRoZVxuICogIGRlZmF1bHQuIGAwYCBtZWFucyBubyB3aW5kb3cuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVdpbmRvd01zKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdy50cmltKCkgPT09IFwiXCIpIHJldHVybiBERUZBVUxUX1dJTkRPV19NUztcbiAgY29uc3QgbiA9IE51bWJlcihyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzSW50ZWdlcihuKSAmJiBuID49IDAgPyBuIDogREVGQVVMVF9XSU5ET1dfTVM7XG59XG5cbmV4cG9ydCB0eXBlIFRhaWxNb2RlID0gXCJ3YXRjaFwiIHwgXCJvbmNlXCI7XG5cbi8qKiBIb3cgYSB0YWlsIGVuZGVkLiBgd2luZG93YCBpcyBvdXIgb3duIGRlYWRsaW5lLCBgZXZlbnRgIGlzIGEgYC0tb25jZWAnc1xuICogIGZpcnN0IGZyYW1lLCBgY2xvc2VkYCBpcyB0aGUgc2Vzc2lvbiBlbmRpbmcgKGEgYGNsb3NlZGAgZnJhbWUgb3IgdGhlIHBpbm5lZFxuICogIHNlc3Npb24ncyBwb2ludGVyIHZhbmlzaGluZyksIGBsb3N0YCBpcyB0aGUgZGFlbW9uIHJlZnVzaW5nIGNvbm5lY3Rpb25zLFxuICogIGFuZCBgc3RvcHBlZGAgaXMgYSBzaWduYWwsIGEgY2FsbGVyJ3MgYWJvcnQgb3IgYSBjbG9zZWQgc3Rkb3V0LiAqL1xuZXhwb3J0IHR5cGUgVGFpbEVuZCA9IFwid2luZG93XCIgfCBcImV2ZW50XCIgfCBcImNsb3NlZFwiIHwgXCJsb3N0XCIgfCBcInN0b3BwZWRcIjtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZklucHV0ID0ge1xuICAvKiogVGhlIHNwZWxsIHdob3NlIHRhaWwgdGhpcyBpcywgc28gdGhlIGFnZW50IGtub3dzIHdob3NlIGxhdW5jaGVyIHJ1bnMgaXQuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGVuZDogVGFpbEVuZDtcbiAgLyoqIFdobyBlbmRlZCBhIGBjbG9zZWRgIHNlc3Npb24sIHdoZW4gaXRzIGNsb3NpbmcgZnJhbWUgc2FpZCAoUzEpLiAqL1xuICBieT86IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBMb2cgZnJhbWVzIHRoaXMgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQgKEEzKS4gKi9cbiAgZXZlbnRzOiBudW1iZXI7XG4gIC8qKiBUaGUgYm9va21hcms6IHRoZSBoaWdoZXN0IGlkIHRoaXMgcHJvY2VzcyBoYXMgc2Vlbi4gKi9cbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBUaGUgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIGFuIGVwb2NoLiAqL1xuICBlcG9jaD86IHN0cmluZztcbiAgcHJlc2VuY2U6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmQ29tbWFuZHMgPSB7XG4gIC8qKiBUaGUgcmUtYXJtLCB3aXRoIHRoZSBib29rbWFyazsgYG9uY2VgIGFkZHMgYC0tb25jZWAuIGBlcG9jaGAgaXMgdGhlXG4gICAqICBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgb25lOiBhIHNwZWxsIHdob3NlXG4gICAqICBgLS1zaW5jZWAgcGFyc2VzIGBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApIHByaW50cyBpdC4gKi9cbiAgdGFpbDogKG86IHsgc2luY2U6IG51bWJlcjsgb25jZTogYm9vbGVhbjsgZXBvY2g/OiBzdHJpbmcgfSkgPT4gc3RyaW5nO1xuICAvKiogSG93IHRvIGNvbWUgYmFjayBmcm9tIGEgc2Vzc2lvbiB0aGF0IGlzIGdvbmUuICovXG4gIGNvbWVCYWNrOiAoKSA9PiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmTGluZSA9IHtcbiAgdHlwZTogXCJ0YWlsLndpbmRvd1wiIHwgXCJ0YWlsLnF1aWV0XCIgfCBcInRhaWwud29rZVwiIHwgXCJ0YWlsLmNsb3NlZFwiIHwgXCJ0YWlsLmxvc3RcIjtcbiAgLyoqIFdob3NlIGxhdW5jaGVyIHJ1bnMgYGNvbW1hbmRgLiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBldmVudHM6IG51bWJlcjtcbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBgdGFpbC5jbG9zZWRgIG9ubHk6IHdobyBlbmRlZCB0aGUgc2Vzc2lvbiwgd2hlbiB0aGUgc3BlbGwgc2F5cyAoUzEpLiAqL1xuICBieT86IHN0cmluZztcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICAvKiogVGhlIHZlcmIgYW5kIGl0cyBhcmd1bWVudHMgT05MWSDigJQgbm8gbGF1bmNoZXIsIG5vIHBhdGguIFRoZSBhZ2VudCBydW5zXG4gICAqICBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5gLiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKiBIb3cgdGhlIGFnZW50IHJ1bnMgYSBwcmludGVkIGBjb21tYW5kYDogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBuZXZlciBhIHBhdGhcbiAqICB0aGlzIHByb2Nlc3MgbmFtZXMgKHRoZSBydWxpbmcgb24gdGhlIHZlcnNpb25lZCBwbHVnaW4gcGF0aCwgaW4gdGhlIGhlYWRlcikuICovXG5leHBvcnQgY29uc3QgUlVOX1dJVEhfTEFVTkNIRVIgPSBcImJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+XCI7XG5cbi8qKiBUaGUgY29tZS1iYWNrIGhpbnQsIHdpdGggaG93IHRvIFJFU1VNRSBhZnRlciBjb21pbmcgYmFjayAoRDIpOiBhIHJlc3RvcmVkXG4gKiAgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgbWVhbnMgbm90aGluZyB0aGVyZS4gKi9cbmNvbnN0IENPTUVfQkFDSyA9ICh3aHk6IHN0cmluZywgbGVhZCA9IFwiVG8gYnJpbmcgaXQgYmFja1wiKSA9PlxuICBgJHt3aHl9ICR7bGVhZH0sIHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfTsgdGhlbiBhcm0gdGhlIHRhaWwgYWdhaW4gd2l0aCBubyAtLXNpbmNlLCBvbiB0aGUgc2Vzc2lvbiBpZCBpdCBwcmludHMgd2hlcmUgdGhlcmUgaXMgb25lIChhIHJlc3RhcnRlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBkb2VzIG5vdCBhcHBseSlgO1xuXG4vKipcbiAqIFRIRSBERUNJU0lPTjogZ2l2ZW4gaG93IHRoZSB0YWlsIGVuZGVkLCB3aGljaCBsaW5lIGl0IHByaW50cy4gUHVyZSwgc28gZXZlcnlcbiAqIHN0YXRlIGlzIGEgbGl0ZXJhbCBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4gUmV0dXJucyBudWxsIGZvciBgc3RvcHBlZGA6XG4gKiBhIGh1bWFuJ3MgQ3RybC1DIG9yIGEgY2FsbGVyJ3MgYWJvcnQgaXMgbm90IGEgaGFuZG9mZi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhbmRvZmYoczogSGFuZG9mZklucHV0LCBjbWQ6IEhhbmRvZmZDb21tYW5kcyk6IEhhbmRvZmZMaW5lIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSB7IHNwZWxsOiBzLnNwZWxsLCBldmVudHM6IHMuZXZlbnRzLCBjdXJzb3I6IHMuY3Vyc29yIH07XG4gIHN3aXRjaCAocy5lbmQpIHtcbiAgICBjYXNlIFwic3RvcHBlZFwiOlxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgY2FzZSBcImNsb3NlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmNsb3NlZFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICAuLi4ocy5ieSA/IHsgYnk6IHMuYnkgfSA6IHt9KSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OlxuICAgICAgICAgIHMuYnkgPT09IFwiaHVtYW5cIlxuICAgICAgICAgICAgPyBDT01FX0JBQ0soXG4gICAgICAgICAgICAgICAgXCJ0aGUgaHVtYW4gZW5kZWQgdGhpcyBzZXNzaW9uIG9uIHB1cnBvc2U7IHN0b3Agd2F0Y2hpbmcsIGFuZCBkbyBub3QgcmVvcGVuIGl0IHVubGVzcyB0aGV5IGFzay5cIixcbiAgICAgICAgICAgICAgICBcIklmIHRoZXkgYXNrXCIsXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIDogQ09NRV9CQUNLKFwidGhlIHNlc3Npb24gY2xvc2VkOyB0aGVyZSBpcyBub3RoaW5nIGxlZnQgdG8gd2F0Y2guXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwibG9zdFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmxvc3RcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBDT01FX0JBQ0soXCJsb3N0IHRoZSBkYWVtb24gKGl0IGNyYXNoZWQgb3Igd2FzIGtpbGxlZCk7IG5vdGhpbmcgaXMgbGlzdGVuaW5nLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImV2ZW50XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwud29rZVwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IGZhbHNlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYGhhbmRsZSB0aGUgZXZlbnQgYWJvdmUsIHRoZW4gYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICB9O1xuICAgIGNhc2UgXCJ3aW5kb3dcIjpcbiAgICAgIGlmIChzLnByZXNlbmNlIHx8IHMuZXZlbnRzID4gMClcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwud2luZG93XCIsXG4gICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7XG4gICAgICAgICAgICBzaW5jZTogcy5jdXJzb3IsXG4gICAgICAgICAgICBvbmNlOiBmYWxzZSxcbiAgICAgICAgICAgIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIGhpbnQ6IGB0aGUgd2luZG93IGVuZGVkIGJlZm9yZSBNb25pdG9yJ3MgY2FwOyBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgICAgfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5xdWlldFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcImJhY2tncm91bmRcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IHRydWUsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgbm90aGluZyBvbiB0aGUgbG9nIHRoaXMgd2luZG93OyBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn0gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpIOKAlCBpdCBleGl0cyBvbiB0aGUgbmV4dCBldmVudGAsXG4gICAgICB9O1xuICB9XG59XG5cbi8qKiBQT1NJWCBzaW5nbGUtcXVvdGUgYW4gYXJndW1lbnQgd2hlbiBpdCBuZWVkcyBpdCwgc28gYSBwcmludGVkIGBjb21tYW5kYFxuICogIHJ1bnMgYXMgcHJpbnRlZCBhZnRlciB0aGUgYWdlbnQncyBvd24gbGF1bmNoZXIuICovXG5leHBvcnQgZnVuY3Rpb24gc2hlbGxRdW90ZShhcmc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltBLVphLXowLTlfQCUrPTosLi8tXSskLy50ZXN0KGFyZykgPyBhcmcgOiBgJyR7YXJnLnJlcGxhY2VBbGwoXCInXCIsIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKlxuICogUmVhZCBhIGAtLXNpbmNlYCB2YWx1ZTogYW4gZXZlbnQgaWQsIG9wdGlvbmFsbHkgY2FycnlpbmcgdGhlIGVwb2NoIG9mIHRoZVxuICogbG9nIGl0IGNhbWUgZnJvbSAoYDEyQDxlcG9jaD5gLCBEMikuIE51bGwgd2hlbiB0aGUgaWQgaXMgbm90IGFuIGludGVnZXIuXG4gKiBGb3IgdGhlIHNwZWxscyB3aG9zZSBkYWVtb24gc3RhbXBzIGFuIGVwb2NoOyB0aGUgcmVzdCB0YWtlIGEgcGxhaW4gaWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJvb2ttYXJrKHRva2VuOiBzdHJpbmcpOiB7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgYXQgPSB0b2tlbi5pbmRleE9mKFwiQFwiKTtcbiAgY29uc3QgaWQgPSBhdCA9PT0gLTEgPyB0b2tlbiA6IHRva2VuLnNsaWNlKDAsIGF0KTtcbiAgY29uc3QgZXBvY2ggPSBhdCA9PT0gLTEgPyBcIlwiIDogdG9rZW4uc2xpY2UoYXQgKyAxKTtcbiAgaWYgKCEvXi0/XFxkKyQvLnRlc3QoaWQudHJpbSgpKSkgcmV0dXJuIG51bGw7XG4gIGlmIChhdCAhPT0gLTEgJiYgZXBvY2ggPT09IFwiXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBzaW5jZTogTnVtYmVyLnBhcnNlSW50KGlkLCAxMCksIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSB9O1xufVxuXG4vKipcbiAqIEV2ZXJ5IHRhaWwncyBgLS1zaW5jZWAsIHJlYWQgdGhlIHNhbWUgd2F5OiBhIGJvb2ttYXJrIHRoaXMgdGFpbCBhY2NlcHRzLCBvciBhXG4gKiByZWZ1c2FsIHRoYXQgTkFNRVMgdGhlIGFjY2VwdGVkIGZvcm1zLiDim5QgTkVWRVIgQSBTSUxFTlQgTUlTUEFSU0UuIFRoZSBmb3VyXG4gKiBuby1lcG9jaCBzcGVsbHMgdXNlZCBgcGFyc2VJbnRgLCB3aGljaCByZWFkIGFuIGVwb2NoIGJvb2ttYXJrIChgNEBlMWAsIGZyb21cbiAqIGEgaGFuZG9mZiBsaW5lIGFub3RoZXIgdmVyc2lvbiBvciBzcGVsbCBwcmludGVkKSBhcyBgNGAgYW5kIGRyb3BwZWQgdGhlXG4gKiByZXN0IHdpdGhvdXQgYSB3b3JkOyBtaW5kLW1hcHBlciByZWFkIGp1bmsgYXMgMCBhbmQgYXN0cm9sYWJlIGFzIC0xLCBib3RoIGFcbiAqIHdob2xlIHJlcGxheS4gQSBwcmludGVkIGNvbW1hbmQgb3V0bGl2ZXMgdGhlIENMSSB0aGF0IHByaW50ZWQgaXQgKHRoZVxuICogbGF1bmNoZXItZnJlZSBydWxpbmcsIGluIHRoZSBoZWFkZXIpLCBzbyB0aGUgcGFyc2VyIGlzIHdoZXJlIGFuIG9sZGVyIG9yXG4gKiBuZXdlciBmb3JtIG11c3Qgc2F5IHdoYXQgd2VudCB3cm9uZy5cbiAqXG4gKiBgZXBvY2hgOiB3aGV0aGVyIHRoaXMgc3BlbGwncyBsb2cgc3RhbXBzIG9uZSAoc2NyaXB0b3JpdW0sIGFzdHJvbGFiZSxcbiAqIG1pbmQtbWFwcGVyKS4gYG1pbmA6IHRoZSBzbWFsbGVzdCBpZCBhY2NlcHRlZCAoZ3JhcGV2aW5lIHRha2VzIG5vIC0xKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRTaW5jZShcbiAgdG9rZW46IHN0cmluZyxcbiAgbzogeyBlcG9jaDogYm9vbGVhbjsgbWluPzogbnVtYmVyIH0sXG4pOiB7IG9rOiB0cnVlOyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgeyBvazogZmFsc2U7IG1lc3NhZ2U6IHN0cmluZyB9IHtcbiAgY29uc3QgbWluID0gby5taW4gPz8gLTE7XG4gIGNvbnN0IGIgPSBwYXJzZUJvb2ttYXJrKHRva2VuKTtcbiAgaWYgKGIgIT09IG51bGwgJiYgYi5zaW5jZSA+PSBtaW4gJiYgKGIuZXBvY2ggPT09IHVuZGVmaW5lZCB8fCBvLmVwb2NoKSlcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgc2luY2U6IGIuc2luY2UsIC4uLihiLmVwb2NoID8geyBlcG9jaDogYi5lcG9jaCB9IDoge30pIH07XG4gIGNvbnN0IGlkID1cbiAgICBtaW4gPCAwXG4gICAgICA/IFwiYW4gZXZlbnQgaWQgKGFuIGludGVnZXI7IC0tc2luY2U9LTEgZm9yIGV2ZXJ5dGhpbmcpXCJcbiAgICAgIDogYGFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyLCAke21pbn0gb3IgbW9yZSlgO1xuICBjb25zdCBmb3JtcyA9IG8uZXBvY2ggPyBgJHtpZH0sIG9yIDxpZD5APGVwb2NoPiBhcyBhIGhhbmRvZmYgbGluZSBwcmludHMgaXRgIDogaWQ7XG4gIGNvbnN0IHdoeSA9XG4gICAgIW8uZXBvY2ggJiYgdG9rZW4uaW5jbHVkZXMoXCJAXCIpXG4gICAgICA/IGA7IHRoaXMgc3BlbGwncyBsb2cgc3RhbXBzIG5vIGVwb2NoLCBzbyBwYXNzIHRoZSBpZCB3aXRob3V0IHRoZSBcIkDigKZcIiBwYXJ0YFxuICAgICAgOiBcIlwiO1xuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBtZXNzYWdlOiBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhIGJvb2ttYXJrIHRoaXMgdGFpbCBhY2NlcHRzIOKAlCBnaXZlICR7Zm9ybXN9JHt3aHl9YCxcbiAgfTtcbn1cblxuLyoqIEpvaW4gYW4gYXJndiBpbnRvIG9uZSBydW5uYWJsZSBjb21tYW5kIGxpbmUuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZExpbmUoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYXJndi5tYXAoc2hlbGxRdW90ZSkuam9pbihcIiBcIik7XG59XG5cbi8qKiBUaGUgcmUtYXJtIGZvciBhIHNwZWxsIHdob3NlIHRhaWwgaXMgYDxwcmVmaXjigKY+IC0tc2luY2UgTltAZXBvY2hdIFstLW9uY2VdYC5cbiAqICBQYXNzIGBlcG9jaGAgb25seSBmb3IgYSBzcGVsbCB3aG9zZSBgLS1zaW5jZWAgcGFyc2VzIGl0IChgcGFyc2VCb29rbWFya2ApLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxDb21tYW5kKFxuICBwcmVmaXg6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBzaW5jZTogbnVtYmVyLFxuICBvbmNlOiBib29sZWFuLFxuICBlcG9jaD86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIC8vIOKaoCBBIG5lZ2F0aXZlIGJvb2ttYXJrIChub3RoaW5nIHNlZW4geWV0KSBpcyBzcGVsbGVkIGAtLXNpbmNlPS0xYDogdGhlXG4gIC8vIHBhcnNlcnMgcmVhZCBhIGJhcmUgYC0xYCBhZnRlciBhIGZsYWcgYXMgYW5vdGhlciBmbGFnIGFuZCByZWZ1c2UgaXQuXG4gIGNvbnN0IG1hcmsgPSBlcG9jaCA/IGAke3NpbmNlfUAke2Vwb2NofWAgOiBTdHJpbmcoc2luY2UpO1xuICBjb25zdCBhdCA9IHNpbmNlIDwgMCA/IFtgLS1zaW5jZT0ke21hcmt9YF0gOiBbXCItLXNpbmNlXCIsIG1hcmtdO1xuICByZXR1cm4gY29tbWFuZExpbmUoWy4uLnByZWZpeCwgLi4uYXQsIC4uLihvbmNlID8gW1wiLS1vbmNlXCJdIDogW10pXSk7XG59XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZPcHRpb25zPEV2PiA9IHtcbiAgLyoqIFRoZSBzcGVsbCdzIG5hbWUsIGNhcnJpZWQgb24gdGhlIGxpbmUgKHdob3NlIGxhdW5jaGVyIHJ1bnMgaXQpLiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIEEgcHJlc2VuY2Ugc3BlbGw6IGFsd2F5cyBgdGFpbC53aW5kb3dgIGF0IHRoZSB3aW5kb3cncyBlbmQsIG5ldmVyIGxvc3QuICovXG4gIHByZXNlbmNlOiBib29sZWFuO1xuICAvKiogRGVmYXVsdDogYHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSlgLiBgMGAgPSBubyB3aW5kb3cuICovXG4gIHdpbmRvd01zPzogbnVtYmVyO1xuICAvKiogV2hldGhlciBhbiBlbWl0dGVkIGZyYW1lIGlzIGEgTE9HIGZyYW1lIChBMykuIERlZmF1bHQ6IGV2ZXJ5IG9uZS4gKi9cbiAgY291bnRzPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogV2hpY2ggdGVybWluYWwgZnJhbWUgbWVhbnMgdGhlIHNlc3Npb24gY2xvc2VkLiBEZWZhdWx0OiBldmVyeSB0ZXJtaW5hbC4gKi9cbiAgaXNDbG9zZWQ/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogV2hvIHRoZSBjbG9zaW5nIGZyYW1lIHNheXMgZW5kZWQgdGhlIHNlc3Npb24gKFMxKTsgY2FycmllZCBvbiBgdGFpbC5jbG9zZWRgLiAqL1xuICBjbG9zZWRCeT86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIFdobyBlbmRlZCBhIHNlc3Npb24gZm91bmQgR09ORSAoRDE6IHJlLWFybWVkIGFmdGVyIGl0IGNsb3NlZCwgc28gbm9cbiAgICogIGNsb3NpbmcgZnJhbWUgaXMgZXZlciBzZWVuKSwgcmVhZCBmcm9tIHdoZXJldmVyIHRoZSBzcGVsbCBrZWVwcyBpdCDigJQgYVxuICAgKiAgbWFuaWZlc3QgdGhhdCBvdXRsaXZlcyB0aGUgZGFlbW9uLiBDYXJyaWVkIG9uIGB0YWlsLmNsb3NlZGAgYXMgYGJ5YCwgc29cbiAgICogIHRoZSBsaW5lIHNheXMgd2hhdCB0aGUgbGl2ZSBwYXRoJ3MgYGNsb3NlZEJ5YCB3b3VsZCBoYXZlIChTMSkuICovXG4gIGdvbmVCeT86ICgpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29tbWFuZHM6IEhhbmRvZmZDb21tYW5kcztcbn07XG5cbi8qKlxuICogUnVuIGB0YWlsRXZlbnRzYCB3aXRoIHRoZSBoYW5kb2ZmOiB0aGUgd2luZG93LCBgLS1vbmNlYCwgdGhlIGxvc3QgcnVsZSwgYW5kXG4gKiB0aGUgZmluYWwgbGluZS4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLCBsaWtlIGB0YWlsRXZlbnRzYCwgYW5kIG5ldmVyIGV4aXRzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbFdpdGhIYW5kb2ZmPEV2PihcbiAgdGFpbDogVGFpbE9wdGlvbnM8RXY+LFxuICBoOiBIYW5kb2ZmT3B0aW9uczxFdj4sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSB0YWlsLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3Qgd2luZG93TXMgPSBoLndpbmRvd01zID8/IHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSk7XG4gIGNvbnN0IGNvdW50cyA9IGguY291bnRzID8/ICgoKSA9PiB0cnVlKTtcbiAgY29uc3QgZW5kT25Mb3N0ID0gIWgucHJlc2VuY2U7XG5cbiAgY29uc3QgYWMgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBhYy5hYm9ydCgpO1xuICB0YWlsLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAodGFpbC5zaWduYWw/LmFib3J0ZWQpIGFjLmFib3J0KCk7XG5cbiAgbGV0IGV2ZW50cyA9IDA7XG4gIGxldCBjdXJzb3IgPSB0YWlsLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZCA9IHRhaWwuc2luY2VFcG9jaDtcbiAgbGV0IGZyYW1lSGFzSWQgPSBmYWxzZTtcbiAgLyoqIEEzICsgRDM6IGEgZnJhbWUgY291bnRzLCBhbmQgd2FrZXMgYSBgLS1vbmNlYCwgb25seSB3aGVuIGl0IGlzIE9OIFRIRVxuICAgKiAgTE9HIOKAlCBpdCBjYXJyaWVzIGEgbG9nIGlkIOKAlCBhbmQgdGhlIHNwZWxsJ3Mgb3duIGBjb3VudHNgIGFncmVlcy4gQSB0YWInc1xuICAgKiAgaWQtbGVzcyBgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCBwaW5nIGlzIG5vdCBvbiB0aGUgbG9nLiAqL1xuICBjb25zdCBpc0xvZ0ZyYW1lID0gKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBmcmFtZUhhc0lkICYmIGNvdW50cyhldiwgZnJhbWUpO1xuICBsZXQgZW5kOiBUYWlsRW5kIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWRCeTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgcmVmdXNhbHMgPSAwO1xuXG4gIGNvbnN0IGZpbmlzaCA9IChlOiBUYWlsRW5kKSA9PiB7XG4gICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gZTtcbiAgICBhYy5hYm9ydCgpO1xuICB9O1xuICBjb25zdCB0aW1lciA9XG4gICAgaC5tb2RlID09PSBcIndhdGNoXCIgJiYgd2luZG93TXMgPiAwID8gc2V0VGltZW91dCgoKSA9PiBmaW5pc2goXCJ3aW5kb3dcIiksIHdpbmRvd01zKSA6IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gYXdhaXQgdGFpbEV2ZW50czxFdj4oe1xuICAgICAgLi4udGFpbCxcbiAgICAgIHNpZ25hbDogYWMuc2lnbmFsLFxuICAgICAgLy8gRDIncyBuZXQuIE9uIGZvciBldmVyeSBzcGVsbDogYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yXG4gICAgICAvLyBtZWFucyBhIHdob2xlIHJlcGxheSBvbiB0aGUga2l0J3MgbG9nLCBhbmQgb24gZ3JhcGV2aW5lJ3MgZHVyYWJsZSBsb2dcbiAgICAgIC8vIGl0IGhhcHBlbnMgb25seSB3aGVuIGAtLWxhc3RgIHJlYWNoZXMgYmVsb3cgYC0tc2luY2VgLCB3aGVyZVxuICAgICAgLy8gcmUtcmVhZGluZyB0aGUgY3Vyc29yIGZyb20gdGhlIGZyYW1lcyBpcyB0aGUgbW9yZSBjb3JyZWN0IGFuc3dlci5cbiAgICAgIHJlc3RhcnRPblJlcGxheTogdHJ1ZSxcbiAgICAgIC8vIEQzOiByZW1lbWJlciB3aGV0aGVyIFRISVMgZnJhbWUgY2FycmllcyBhIGxvZyBpZC4gYHRhaWxFdmVudHNgIHJlYWRzXG4gICAgICAvLyB0aGUgY3Vyc29yIG9uY2UgcGVyIGZyYW1lLCBiZWZvcmUgYGFjY2VwdGAsIGB0ZXJtaW5hbGAgYW5kIGByZW5kZXJgLlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4ge1xuICAgICAgICBjb25zdCBuID0gdGFpbC5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgZnJhbWVIYXNJZCA9IHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKTtcbiAgICAgICAgcmV0dXJuIG47XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAocykgPT4ge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gdGFpbC5vblVucmVzb2x2ZWQ/LihzKSA/PyBcInJldHJ5XCI7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgdGhhdCBnaXZlcyB1cCBvbiBmaW5kaW5nIGl0cyBzZXNzaW9uIGlzIHdhdGNoaW5nIGFcbiAgICAgICAgLy8gc2Vzc2lvbiB0aGF0IGlzIGdvbmUg4oCUIHdoZXRoZXIgdGhpcyBwcm9jZXNzIGV2ZXIgcmVhY2hlZCBpdCAoaXRzXG4gICAgICAgIC8vIHBvaW50ZXIgdmFuaXNoZWQpIG9yIGl0IHdhcyByZS1hcm1lZCBhdCBvbmUgdGhhdCBjbG9zZWQgaW4gdGhlIGdhcC5cbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiICYmIGVuZCA9PT0gbnVsbCkge1xuICAgICAgICAgIGVuZCA9IFwiY2xvc2VkXCI7XG4gICAgICAgICAgY2xvc2VkQnkgPSBoLmdvbmVCeT8uKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZlcmRpY3Q7XG4gICAgICB9LFxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwucmVuZGVyID8gdGFpbC5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgIGlmIChsaW5lICE9PSBudWxsICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkgZXZlbnRzICs9IDE7XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIHRlcm1pbmFsOiAoZXYsIGZyYW1lLCBhY2NlcHRlZCkgPT4ge1xuICAgICAgICBpZiAodGFpbC50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkge1xuICAgICAgICAgICAgZW5kID0gKGguaXNDbG9zZWQgPz8gKCgpID0+IHRydWUpKShldikgPyBcImNsb3NlZFwiIDogXCJldmVudFwiO1xuICAgICAgICAgICAgaWYgKGVuZCA9PT0gXCJjbG9zZWRcIikgY2xvc2VkQnkgPSBoLmNsb3NlZEJ5Py4oZXYpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaC5tb2RlID09PSBcIm9uY2VcIiAmJiBhY2NlcHRlZCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIG9uQ29tbWVudDogKHRleHQpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICByZXR1cm4gdGFpbC5vbkNvbW1lbnQ/Lih0ZXh0KSA/PyBudWxsO1xuICAgICAgfSxcbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwub25EaXNjb25uZWN0Py4oaW5mbykgPz8gbnVsbDtcbiAgICAgICAgaWYgKGluZm8uY2F1c2UgPT09IFwiY29ubmVjdC1mYWlsZWRcIikge1xuICAgICAgICAgIHJlZnVzYWxzICs9IDE7XG4gICAgICAgICAgaWYgKGVuZE9uTG9zdCAmJiByZWZ1c2FscyA+PSBMT1NUX0FGVEVSX1JFRlVTQUxTKSBmaW5pc2goXCJsb3N0XCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRoZSBkYWVtb24gYW5zd2VyZWQgKGEgc3RhdHVzLCBvciBhIHN0cmVhbSB0aGF0IG9wZW5lZCBhbmQgdGhlblxuICAgICAgICAgIC8vIGVuZGVkKTogaXQgaXMgYWxpdmUsIHNvIHRoZSByZWZ1c2FscyB3ZXJlIG5vdCBpbiBhIHJvdy5cbiAgICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgb25FbmQ6IChzKSA9PiB7XG4gICAgICAgIGN1cnNvciA9IHMuY3Vyc29yO1xuICAgICAgICBlcG9jaCA9IHMuZXBvY2ggPz8gdW5kZWZpbmVkO1xuICAgICAgICB0YWlsLm9uRW5kPy4ocyk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGxpbmUgPSBoYW5kb2ZmKFxuICAgICAge1xuICAgICAgICBlbmQ6IGVuZCA/PyBcInN0b3BwZWRcIixcbiAgICAgICAgLi4uKGNsb3NlZEJ5ID8geyBieTogY2xvc2VkQnkgfSA6IHt9KSxcbiAgICAgICAgbW9kZTogaC5tb2RlLFxuICAgICAgICBldmVudHMsXG4gICAgICAgIGN1cnNvcixcbiAgICAgICAgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pLFxuICAgICAgICBwcmVzZW5jZTogaC5wcmVzZW5jZSxcbiAgICAgICAgc3BlbGw6IGguc3BlbGwsXG4gICAgICB9LFxuICAgICAgaC5jb21tYW5kcyxcbiAgICApO1xuICAgIGlmIChsaW5lICE9PSBudWxsKSBvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkobGluZSl9XFxuYCk7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHRhaWwuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIE1pbmQtbWFwcGVyJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyBvZiB0aGUgc3BlbGwsIGFuZCBUSEUgT05FIFBMQUNFIFRIRSBFTlYgSVMgUkVBRC5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIFRIRSBTRUFNLCBBTkQgRk9SIE1JTkQtTUFQUEVSIFRIRSBTRUFNIFdBUyBSRUFMIEFORFxuICogSEFORC1NSVJST1JFRC4gQmVmb3JlIFBoYXNlIDcgdGhlIGtlZXBhbGl2ZSB3YXMgYSBsaXRlcmFsIGAxNV8wMDBgIGluc2lkZVxuICogYHNlcnZlci50c2AncyBga2VlcGFsaXZlTXMoKWAsIGBpZGxlVGltZW91dDogMjU1YCB3YXMgYSBzZWNvbmQgbGl0ZXJhbCBhXG4gKiBodW5kcmVkIGxpbmVzIGF3YXkgd2l0aCB0aGUgcmVsYXRpb25zaGlwIHdyaXR0ZW4gb25seSBpbiBwcm9zZSwgYW5kIHRoZVxuICogQ0xJJ3MgdGFpbCBjYXJyaWVkIGEgSEFSRC1DT0RFRCBgNDVfMDAwYCB3YXRjaGRvZyB1bmRlciBhIGNvbW1lbnQgc2F5aW5nXG4gKiBcIuKJiCAzIG1pc3NlZCBzZXJ2ZXIga2VlcGFsaXZlcyAoMTVzIHRpY2ssIENsYWltIEYpXCIg4oCUIHRocmVlIG51bWJlcnMsIHR3b1xuICogZmlsZXMsIGFuZCB0aGUgYXJpdGhtZXRpYyB0eWluZyB0aGVtIHRvZ2V0aGVyIGxpdmluZyBpbiBhIHNlbnRlbmNlLiBOZWl0aGVyXG4gKiBmaWxlIGNvdWxkIGltcG9ydCB0aGUgb3RoZXI6IHRoZSBDTEkgcmVhY2hpbmcgaW50byB0aGUgZGFlbW9uIHdvdWxkIGRyYWcgdGhlXG4gKiB3aG9sZSAyMy1tb2R1bGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gQSBtb2R1bGUgd2hvc2Ugb25seSBpbXBvcnRzXG4gKiBhcmUgdGhlIGtpdCdzIGRlcml2YXRpb25zIGhhcyBubyBzdWNoIGdyYXBoLCBzbyBib3RoIGhhbHZlcyBpbXBvcnQgdGhpcyBvbmUuXG4gKiAqKkEgdmFsdWUgdGhhdCBjb3VsZCBub3QgcHJldmlvdXNseSBjcm9zcyB0aGUgc2VhbSBub3cgY3Jvc3NlcyBpdCoqLCBhbmQgdGhlXG4gKiBcIuKJiFwiIGluIHRoYXQgY29tbWVudCBpcyBub3cgYW4gYD1gLlxuICpcbiAqIOKblCAqKkFORCBUSEUgV0FUQ0hET0cgSVMgREVSSVZFRCBGUk9NIE1JTkQtTUFQUEVSJ1MgT1dOIEhFQVJUQkVBVCwgTkVWRVJcbiAqIENPUElFRCBGUk9NIEEgU0lCTElORy4qKiBUaGlzIGlzIHRoZSBydWxlIGFzdHJvbGFiZSBwYWlkIGZvcjogYSBoYXJkLWNvZGVkXG4gKiA0NSBzIHdhdGNoZG9nIGFnYWluc3QgYW4gZW52LXR1bmVkIGhlYXJ0YmVhdCBwcm9kdWNlZCByZWNvbm5lY3RzIGF0ICs0Ny40IHMsXG4gKiArOTIuNiBzIGFuZCArMTM3LjkgcyBhZ2FpbnN0IGEgcGVyZmVjdGx5IGhlYWx0aHkgZGFlbW9uLCBoYXJtbGVzcyBvbmx5XG4gKiBiZWNhdXNlIGFuIHVucmVsYXRlZCB0aGlyZCBjb25zdGFudCBhYnNvcmJlZCB0aGUgY2h1cm4uIOKaoCBNaW5kLW1hcHBlciBpcyB0aGVcbiAqIHNwZWxsIHRoYXQgd2FzIE9ORSBFTlYgVkFSIGF3YXkgZnJvbSB0aGF0IGV4YWN0IGRlZmVjdDogaXRzIGtlZXBhbGl2ZSBhbHJlYWR5XG4gKiB0b29rIGBNSU5EX01BUFBFUl9LRUVQQUxJVkVfTVNgIChpdHMgb3duIHByZXNlbmNlIHN1aXRlIGRyaXZlcyBpdCBhdCAyNSBtcylcbiAqIHdoaWxlIHRoZSB3YXRjaGRvZyB3YXMgYSBsaXRlcmFsLCBzbyBhbnkga2VlcGFsaXZlIGFib3ZlIDE1IHMgYWxyZWFkeSBicm9rZVxuICogZXZlcnkgdGFpbCBhbmQgYW55IGtlZXBhbGl2ZSBiZWxvdyBpdCBtYWRlIHRoZSB3YXRjaGRvZyB0b2xlcmF0ZSBmYXIgbW9yZVxuICogdGhhbiB0aHJlZSBtaXNzZWQgYmVhdHMuIGB0YWlsSWRsZU1zKFNTRV9IRUFSVEJFQVRfTVMpYCBjYW5ub3QgZHJpZnQgZnJvbSB0aGVcbiAqIGJlYXQgaXQgaXMgd2F0Y2hpbmcsIHdoYXRldmVyIHRoZSBiZWF0IGJlY29tZXMuXG4gKlxuICog4puUICoqVEhFIEVOViBJUyBSRVNPTFZFRCBIRVJFIEFORCBOT1dIRVJFIEVMU0UgKEQ3NSksIEFORCBGT1IgVEhJUyBTUEVMTCBUSEFUXG4gKiBSVUxFIElTIExPQUQtQkVBUklORyBSQVRIRVIgVEhBTiBUSURZLioqIEdyYXBldmluZSdzIHBvcnQgc2hpcHBlZCB0aGUgYmVhdCdzXG4gKiBrbm9iIGluIGBkYWVtb24udHNgIGFuZCBsZWZ0IGl0cyBzZWFtIGZpbGUgZGVyaXZpbmcgdGhlIHdhdGNoZG9nIGZyb20gdGhlXG4gKiBMSVRFUkFMIGRlZmF1bHQ6IHRoZSBkYWVtb24ncyBiZWF0IHdhcyB0dW5hYmxlIGFuZCB0aGUgQ0xJJ3Mgd2F0Y2hkb2cgd2FzXG4gKiBub3QsIGFuZCBhbnkgdmFsdWUgYWJvdmUgdGhlIGRlZmF1bHQgYnJva2UgZXZlcnkgdGFpbCDigJQgaW52aXNpYmxlIGF0IHRoZVxuICogZGVmYXVsdCwgd2hpY2ggaXMgd2h5IGl0IHNoaXBwZWQuIFRoZSBnZW5lcmFsaXNhdGlvbjogKiphbiBlbnYga25vYiBtdXN0IGJlXG4gKiByZXNvbHZlZCBhdCB0aGUgTE9XRVNUIHBvaW50IGV2ZXJ5IGNvbnN1bWVyIG9mIHRoZSBkZXJpdmVkIHZhbHVlIGNhbiBzZWUuKipcbiAqIGBwcm9jZXNzLmVudmAgaXMgYW1iaWVudCBpbiBib3RoIGhhbHZlcywgd2hpY2ggaXMgZXhhY3RseSB3aHkgdGhpcyBmaWxlIOKAlCBhbmRcbiAqIG5vdCBgc2VydmVyLnRzYCDigJQgY2FuIGhvbGQgdGhlIHJlc29sdXRpb24sIGFuZCByZWFkaW5nIGl0IGhlcmUgaXMgbm90IHRoZVxuICoga2luZCBvZiBpbXBvcnQgdGhhdCBjbG9zZXMgdGhlIHNlYW0uXG4gKlxuICog4puUICoqQU5EIFRIRSBERVJJVkFUSU9OIFNVUFBMSUVTIFRIRSBERUZBVUxULCBOT1QgVEhFIFZBTFVFIChEODIpLioqIFRoZSB0d29cbiAqIHRhaWwga25vYnMgYmVsb3cgYXJlIHRoZSByZWFzb246IGBiYWNrZW5kL3RhaWwudGVzdC50c2AgaXMgdGhlIHJlcG8ncyBPTkxZXG4gKiBleGVjdXRhYmxlIHRhaWwgc3BlY2lmaWNhdGlvbiwgaXQgaXMgdGhpcyBwb3J0J3MgT1JBQ0xFLCBhbmQgYWxsIGZvdXIgb2YgaXRzXG4gKiBjZWxscyBkcml2ZSBgTUlORF9NQVBQRVJfVEFJTF9JRExFX01TPTIwMGAgLyBgTUlORF9NQVBQRVJfVEFJTF9SRVRSWV9NUz01MGAuXG4gKiBXcml0dGVuIGdsYW1vdXIncyB3YXkg4oCUIHRocmVlIHBsYWluIGBleHBvcnQgY29uc3RgcyB3aXRoIG5vIG92ZXJyaWRlIGFueXdoZXJlXG4gKiDigJQgdGhlIGlkbGUtd2F0Y2hkb2cgY2VsbCBGQUlMUyAoYSA0NSwwMDAgbXMgd2F0Y2hkb2cgY2Fubm90IGZpcmUgaW5zaWRlIGl0c1xuICogNSBzIGRlYWRsaW5lLCBhbmQgaXQgcmVhZHMgYXMgYSBicm9rZW4gd2F0Y2hkb2cpIGFuZCB0aGUga2VlcGFsaXZlIGNlbGxcbiAqICoqUEFTU0VTIFZBQ1VPVVNMWSoqOiBpdCBhc3NlcnRzIHRoYXQgbm90aGluZyB3YXMgYWJvcnRlZCwgYW5kIDQ1IHMgY2Fubm90XG4gKiBhYm9ydCBhbnl0aGluZyBpbnNpZGUgaXRzIDgwMCBtcyB3aW5kb3cuIEEgZ3JlZW4gY2VsbCB0aGF0IGxvc3QgaXRzIHN1YmplY3RcbiAqIGlzIHdvcnNlIHRoYW4gYSByZWQgb25lLiDimqAgQW5kIHRoZSBrbm9iIGNhbm5vdCBiZSByb3V0ZWQgdGhyb3VnaCB0aGUgQkVBVFxuICogaW5zdGVhZDogdGhlIGtpdCBmbG9vcnMgYGhlYXJ0YmVhdE1zYCBhdCBgTUlOX0hFQVJUQkVBVF9NUyA9IDUwMGAgKEQ3NiDigJQgdGhlXG4gKiBmbG9vciBsaXZlcyBhdCB0aGUgZGVyaXZhdGlvbiksIHNvIHRoZSBzbWFsbGVzdCB3YXRjaGRvZyByZWFjaGFibGUgdGhyb3VnaFxuICogYHRhaWxJZGxlTXNgIGlzIDEsNTAwIG1zIGFuZCAqKjIwMCBtcyBpcyB1bnJlYWNoYWJsZSB0aGF0IHdheSBieVxuICogY29uc3RydWN0aW9uLioqIGB0YWlsSWRsZU1zYCBjYXJyaWVzIG5vIGZsb29yIG9mIGl0cyBvd24sIHNvIGEgZGlyZWN0XG4gKiBvdmVycmlkZSByZWFjaGVzIGl0LlxuICpcbiAqIOKaoCAqKlRoZSBtYXBwaW5nIGJlbG93IHdhcyB3cml0dGVuIGVpZ2h0IG1vbnRocyBlYXJseSBhbmQgYWRkcmVzc2VkIHRvXG4gKiBub2JvZHkqKiDigJQgYHBoYXNlLTEtam91cm5hbC5tZDoxNTEtMTU1YCBuYW1lZCBgTUlORF9NQVBQRVJfVEFJTF9JRExFX01TYCDihpJcbiAqIGBpZGxlTXNgIGFuZCBgTUlORF9NQVBQRVJfVEFJTF9SRVRSWV9NU2Ag4oaSIGByZXRyeS5pbml0aWFsTXNgIGFuZCBjb25jbHVkZWRcbiAqIFwiYSBzcGVsbCB3aG9zZSB0ZXN0cyBkcml2ZSBhIHNob3J0IHdpbmRvdyB3aWxsIG5lZWQgb25lLCBhbmQgaXQgc2hvdWxkIGJlXG4gKiB0aGF0IHNwZWxsJ3MgZW52IHZhciwgbm90IHRoZSBraXQnc1wiLiBUaGlzIGlzIHRoYXQgc3BlbGwgKEQ4NCkuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCB0aGUgQ0xJIGlzIGJhY2sgdG8gZHJhZ2dpbmcgdGhlIHNlcnZlciBncmFwaCBhbmQgdGhlIHNlYW0gY2xvc2VzLlxuICovXG5cbmltcG9ydCB7XG4gIERFRkFVTFRfSEVBUlRCRUFUX01TLFxuICBoZWFydGJlYXRNcyxcbiAgaWRsZVRpbWVvdXRTZWMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKlxuICogQSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBvciB0aGUgZmFsbGJhY2suXG4gKlxuICog4pqgIFRIRSBLSVQnUyBgaW50T3JgIElTIE5PVCBFWFBPUlRFRCwgZGVsaWJlcmF0ZWx5IOKAlCBpdCBpcyB0aGUgcHJpdmF0ZSBwYXJzZXJcbiAqIGJlaGluZCBgaGVhcnRiZWF0TXNgL2BpZGxlVGltZW91dFNlY2AsIGFuZCBENzYgcnVsZWQgdGhhdCBhIGtub2Igd2l0aCBhIGtub3duXG4gKiBzYWZlIG1pbmltdW0gY2xhbXBzIGF0IGl0cyBERVJJVkFUSU9OIHJhdGhlciB0aGFuIGluIHRoZSBzaGFyZWQgcGFyc2VyLiBTb1xuICogdGhpcyBpcyBtaW5kLW1hcHBlcidzIG93biBjb3B5IG9mIHRoZSBzYW1lIHRocmVlIGxpbmVzLCB3aXRoIHRoZSBzYW1lXG4gKiBgcGFyc2VJbnRgIHNlbWFudGljcyB0aGUga2l0IGRvY3VtZW50cyAoYFwiMWU5XCJgIGlzIDEsIGBcIjVhYmNcImAgaXMgNSkgYW5kIHRoZVxuICogc2FtZSBcImFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZSB0YWtlcyB0aGUgZmFsbGJhY2tcIiBydWxlLlxuICogSXQgaXMgdGhlIGV4cHJlc3Npb24gdGhlIENMSSdzIG93biBgZW52TXNgIHVzZWQgYmVmb3JlIHRoaXMgZmlsZSBleGlzdGVkLlxuICpcbiAqIOKblCBBTkQgVEhFIFRXTyBUQUlMIEtOT0JTIEJFTE9XIERFTElCRVJBVEVMWSBIQVZFIE5PIEZMT09SLiBBIHdhdGNoZG9nIGFuZCBhXG4gKiByZWNvbm5lY3QgZGVsYXkgYXJlIHRoZSB0d28gdmFsdWVzIHRoaXMgc3BlbGwncyBvd24gdGVzdCBzdWl0ZSBtdXN0IGJlIGFibGVcbiAqIHRvIGRyaXZlIERPV04gdG8gMjAwIG1zIGFuZCA1MCBtczsgYSBmbG9vciBoZXJlIHdvdWxkIG1ha2UgdGhlIG9yYWNsZVxuICogdW5yZWFjaGFibGUsIHdoaWNoIGlzIHRoZSBkZWZlY3QgRDgyIHdhcyB3cml0dGVuIGFib3V0LiBUaGUgZmxvb3IgZXhpc3RzXG4gKiB3aGVyZSB0aGUgZmxvb2QgcmlzayBpcyDigJQgb24gdGhlIEJFQVQsIGluIHRoZSBraXQuXG4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKipcbiAqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gTWluZC1tYXBwZXIncyBvd24gbWVhc3VyZWQgdmFsdWUsXG4gKiBub3QgYW4gaW5oZXJpdGVkIG9uZTogYHNlcnZlci50c2AgY2FycmllZCBgaWRsZVRpbWVvdXQ6IDI1NWAgdW5kZXIgYSBjb21tZW50XG4gKiByZWNvcmRpbmcgdGhhdCBTU0UgYW5kIFdTIGNvbm5lY3Rpb25zIG9uIGAvZXZlbnRzYCBzaXQgaWRsZSBiZXR3ZWVuIGVtaXRzIGJ5XG4gKiBkZXNpZ24sIHRoYXQgQnVuJ3MgZGVmYXVsdCAxMCBzIHdvdWxkIHJlc2V0IGEgcXVpZXQgc3RyZWFtLCBhbmQgdGhhdCBgMGAgaXNcbiAqIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IHN0YWxscyB0aGUgaW5pdGlhbCByZXNwb25zZSDigJQgc28gdGhlIHdheSB0byBob2xkIGFcbiAqIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLlxuICpcbiAqIOKaoCBgTUlORF9NQVBQRVJfSURMRV9USU1FT1VUX1NFQ2AgaXMgYWNjZXB0ZWQgc28gdGhlIFBBSVIgY2FuIGJlIHR1bmVkXG4gKiB0b2dldGhlciwgYW5kIHRoZSBjbGFtcCBpbiBgaGVhcnRiZWF0TXNgIGJlbG93IGlzIHdoYXQga2VlcHMgdGhlbSBhIHBhaXIuXG4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gaWRsZVRpbWVvdXRTZWMoXG4gIHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0lETEVfVElNRU9VVF9TRUMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuKTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgYW5kIG1pbmQtbWFwcGVyJ3Mgb3duIGxpdGVyYWwgKENsYWltIEYncyAxNSBzXG4gKiAgdGljaykgYmVmb3JlIHRoaXMgZmlsZSBleGlzdGVkIOKAlCB0aGUgREVGQVVMVCwgYmVmb3JlIHRoZSBlbnYgaXMgY29uc3VsdGVkLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfU1NFX0hFQVJUQkVBVF9NUyA9IERFRkFVTFRfSEVBUlRCRUFUX01TO1xuXG4vKipcbiAqIFRoZSBTU0Uga2VlcGFsaXZlLCBpbiBtcywgZW52LXJlc29sdmVkIGFuZCBjbGFtcGVkIGF0IGJvdGggZW5kcyBieSB0aGUga2l0OlxuICogbmV2ZXIgYWJvdmUgYElETEVfVElNRU9VVF9TRUMgLyAyYCAob3IgQnVuIGNsb3NlcyB0aGUgY29ubmVjdGlvbiB0aGVcbiAqIGtlZXBhbGl2ZSB3YXMgcHJlc2VydmluZyksIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiDim5QgVEhFIEZMT09SIElTIE5PVCBERUNPUkFUSU9OIChENzYpLiBgTUlORF9NQVBQRVJfS0VFUEFMSVZFX01TYCBpcyBhIGtub2JcbiAqIG1pbmQtbWFwcGVyJ3Mgb3duIHByZXNlbmNlIHN1aXRlIGRyaXZlcywgYW5kIGBwYXJzZUludGAgcmVhZHMgYFwiMWU5XCJgIOKAlCB0aGVcbiAqIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdCBodWdlXCIg4oCUIGFzICoqMSoqLiBEcml2ZW4gYXQgZ3JhcGV2aW5lJ3NcbiAqIHJlcGFpciBiZWZvcmUgdGhlIGZsb29yIGV4aXN0ZWQ6IGEgMSBtcyBiZWF0IHB1dCB+NTI4IGtlZXBhbGl2ZSBjb21tZW50cyBpbnRvXG4gKiBldmVyeSBvcGVuIFNTRSBjbGllbnQgaW4gNTI4IG1zLlxuICpcbiAqIOKaoCBBTkQgRk9SIFRISVMgU1BFTEwgVEhFIEJFQVQgQUxTTyBCT1VORFMgQSBIVU1BTi1WSVNJQkxFIE5VTUJFUi4gUHJlc2VuY2VcbiAqIChDbGFpbSBDKSBpcyBjb3VudGVkIGF0IFNTRSBzdWJzY3JpYmUvdW5zdWJzY3JpYmUgYW5kIGEgZGVhZCBzb2NrZXQgaXMgb25seVxuICogcmVjbGFpbWVkIHdoZW4gdGhlIG5leHQga2VlcGFsaXZlIHdyaXRlIGZhaWxzLCBzbyByYWlzaW5nIHRoaXMga25vYiBtYWtlcyB0aGVcbiAqIGFnZW50IGNvdW50IGluIHRoZSBib2FyZCdzIGFjdGl2aXR5IGluZGljYXRvciBzdGFsZXIsIG5vdCBqdXN0IHF1aWV0ZXIuXG4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gaGVhcnRiZWF0TXMoXG4gIHByb2Nlc3MuZW52Lk1JTkRfTUFQUEVSX0tFRVBBTElWRV9NUyxcbiAgSURMRV9USU1FT1VUX1NFQyxcbiAgREVGQVVMVF9TU0VfSEVBUlRCRUFUX01TLFxuKTtcblxuLyoqXG4gKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzLCBERVJJVkVELiA0NSwwMDAgbXMgYXQgdGhlIGRlZmF1bHQg4oCUXG4gKiB3aGljaCBpcyB0aGUgbnVtYmVyIGBjbGkudHNgIHVzZWQgdG8gaGFyZC1jb2RlLCBzbyB0aGUgcG9ydCBjaGFuZ2VzIG5vXG4gKiBkZWZhdWx0IHdoaWxlIG1ha2luZyB0aGUgcmVsYXRpb25zaGlwIHRydWUgYXQgZXZlcnkgb3RoZXIgdmFsdWUuXG4gKlxuICog4puUIERFUklWRUQgRlJPTSBUSEUgUkVTT0xWRUQgQkVBVCwgTkVWRVIgRlJPTSBUSEUgREVGQVVMVCDigJQgZ3JhcGV2aW5lJ3NcbiAqIHJlcGFpciBjaGFwdGVyIGlzIHdoYXQgdGhlIGRpZmZlcmVuY2UgY29zdC4gQW5kIHRoZSBlbnYgb3ZlcnJpZGUgaXMgdGhlXG4gKiBGQUxMQkFDSydzIHJlcGxhY2VtZW50LCBub3QgdGhlIGRlcml2YXRpb24nczogdGhlIGRlcml2YXRpb24gaXMgd2hhdCB0aGUga25vYlxuICogZmFsbHMgYmFjayB0bywgc28gYW4gdW50dW5lZCB0YWlsIHN0aWxsIHdhdGNoZXMgdGhyZWUgb2YgdGhpcyBkYWVtb24ncyBiZWF0cy5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IGludE9yKFxuICBwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9UQUlMX0lETEVfTVMsXG4gIHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyksXG4pO1xuXG4vKipcbiAqIFRoZSByZWNvbm5lY3QgYmFja29mZidzIEZJUlNUIGRlbGF5LCBpbiBtcy4gMSwwMDAgdG9kYXksIHdoaWNoIGlzIHdoYXRcbiAqIGBjbGkudHNgJ3MgYHJldHJ5TXNgIGRlZmF1bHRlZCB0by5cbiAqXG4gKiDim5QgQU5EIFRIRSBTSEFQRSBDSEFOR0VTIEVWRU4gVEhPVUdIIFRIRSBOVU1CRVIgRE9FUyBOT1Q6IHRoZSBoYW5kLXJvbGxlZFxuICogbG9vcCBzbGVwdCB0aGlzIGxvbmcgYWZ0ZXIgRVZFUlkgZmFpbGVkIGF0dGVtcHQsIGZsYXQsIGZvcmV2ZXIg4oCUIGFcbiAqIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSwgYW5kIG1pbmQtbWFwcGVyIGlzIHRoZSBzcGVsbFxuICogYHRhaWxFdmVudHNgJ3Mgb3duIHdhcm5pbmcgYWJvdXQgdGhhdCBicmFuY2ggd2FzIHdyaXR0ZW4gYWJvdXQuIFRoZSBraXRcbiAqIGRvdWJsZXMgaXQgdG8gYG1heE1zYCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLCBzbyBhIGRlYWQgZGFlbW9uIGlzXG4gKiBiYWNrZWQgb2ZmIGZyb20gaW5zdGVhZCBvZiBoYW1tZXJlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfUkVUUllfTVMgPSBpbnRPcihwcm9jZXNzLmVudi5NSU5EX01BUFBFUl9UQUlMX1JFVFJZX01TLCAxXzAwMCk7XG5cbi8qKiBUaGUgYmFja29mZiBjZWlsaW5nLCB0aGUga2l0J3MgZGVmYXVsdCwgc3RhdGVkIGhlcmUgc28gYm90aCBoYWx2ZXMgY2FuIHNlZVxuICogIHRoZSB3aG9sZSByZXRyeSBzaGFwZSBpbiBvbmUgcGxhY2UgcmF0aGVyIHRoYW4gaGFsZiBvZiBpdC4gKi9cbmV4cG9ydCBjb25zdCBUQUlMX1JFVFJZX01BWF9NUyA9IDVfMDAwO1xuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQThHQTtBQUNBO0FBQ0E7QUFDQTs7O0FDaERBOzs7QUMxQ08sU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBOzs7QUM2QjNDLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBR1osU0FBUyxpQkFBaUIsR0FBa0I7QUFBQSxFQUNqRCxPQUFPO0FBQUE7QUFTRixTQUFTLGFBQWEsQ0FBQyxNQUFlLFNBQWlCLE9BQTBCO0FBQUEsRUFDdEYsT0FBTyxHQUFHLEtBQUssVUFBVTtBQUFBLElBQ3ZCLElBQUk7QUFBQSxJQUNKLE9BQU87QUFBQSxNQUNMO0FBQUEsTUFDQSxXQUFXLFNBQVM7QUFBQSxNQUVwQixXQUFXO0FBQUEsTUFDWDtBQUFBLFNBQ0ksT0FBTyxPQUFPLEVBQUUsTUFBTSxNQUFNLEtBQUssSUFBSSxDQUFDO0FBQUEsU0FDdEMsT0FBTyxVQUFVLEVBQUUsU0FBUyxNQUFNLFFBQVEsSUFBSSxDQUFDO0FBQUEsU0FFL0MsT0FBTyxXQUFXLFlBQVksRUFBRSxRQUFRLE1BQU0sT0FBTyxJQUFJLENBQUM7QUFBQSxJQUNoRTtBQUFBLElBQ0EsTUFBTSxFQUFFLFNBQVMsZUFBZTtBQUFBLEVBQ2xDLENBQUM7QUFBQTtBQUFBO0FBQUE7QUFJSSxN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S0FBSyxHQUFHLFdBQVc7QUFBQSxFQUNyQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxRQUFRLFFBQVEsVUFBVSxhQUFhLFNBQVMsU0FBUyxTQUFTO0FBQUEsSUFDMUUsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsT0FBTyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQy9ELFVBQVU7QUFBQSxJQUNWLEtBQUssR0FBRyxPQUFPO0FBQUEsRUFDakI7QUFDRjtBQU1PLElBQU0sTUFBTSxVQUFVO0FBQUEsRUFDM0IsTUFBTTtBQUFBLEVBQ04sU0FBUztBQUFBLEVBQ1QsVUFBVTtBQUFBLEVBR1YsU0FBUztBQUFBLEVBSVQsUUFBUSxFQUFFLEtBQUssRUFBRSxXQUFXLG1CQUFtQixFQUFFO0FBQUEsRUFDakQsU0FBUztBQUFBLEVBQ1QsTUFBTSxNQUFNO0FBQ2QsQ0FBQztBQUtNLElBQU0sUUFBMkIsSUFBSTtBQUNyQyxJQUFNLFlBQStDLE9BQU8sWUFDakUsSUFBSSxLQUFLLElBQUksQ0FBQyxNQUFNLENBQUMsRUFBRSxNQUFNLEVBQUUsUUFBUSxDQUFDLENBQzFDO0FBQ08sSUFBTSxtQkFBc0MsSUFBSTtBQW9CdkQsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sSUFBSSxTQUFTLElBQUk7QUFBQSxJQUM5QixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sV0FBVyxlQUFlLENBQUM7QUFBQSxJQUNqQyxJQUFJLGFBQWE7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUM5QixNQUFNLE9BQ0osS0FBSyxPQUFPLE1BQU0sWUFBWSxVQUFVLElBQUksT0FBUSxFQUF3QixJQUFJLElBQUk7QUFBQSxJQUN0RixNQUFNLE1BQU0sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxJQUVyRCxJQUFJLGFBQWE7QUFBQSxNQUFhLE9BQU8sWUFBWSxpQkFBaUIsS0FBSztBQUFBLElBRXZFLElBQUksU0FBUztBQUFBLE1BQVUsT0FBTyxZQUFZLEdBQUc7QUFBQSxJQUc3QyxRQUFRLE9BQU8sTUFBTSxjQUFjLFlBQVksR0FBRyxDQUFDO0FBQUEsSUFDbkQsT0FBTyxTQUFTO0FBQUE7QUFBQTtBQThCcEIsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiMTkxMkREMThDRkNGMEUyRDY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
