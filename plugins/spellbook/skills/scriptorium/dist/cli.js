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

//# debugId=D7569B96F938526B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgKHRoZSBraXQgcmVnaXN0cnkgZGlzcGF0Y2hlcyksIG5vbmUgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAuIFRoZVxuICogc3dhbGxvd2luZyBjYXRjaGVzIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2AsIGBwb3N0Q21kYCdzIGNsb3NlXG4gKiBFQ09OTlJFU0VUKSBjb250YWluIG5vIGRpZS1yZWFjaGFibGUgY2FsbC5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcmVhbHBhdGhTeW5jLFxuICBzdGF0U3luYyxcbiAgdW5saW5rU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IGhvbWVkaXIsIHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IHR5cGUgQ29tbWFuZFNwZWMsIGRlZmluZUNsaSwgdHlwZSBJbnZvY2F0aW9uIH0gZnJvbSBcIi4uLy4uL2tpdC9jbGkvcmVnaXN0cnlcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuaW1wb3J0IHsgQ2xpRXJyb3IsIGRpZSwgdHlwZSBFcnJFeHRyYSwgdHlwZSBFcnJLaW5kLCByZXBvcnRDbGlFcnJvciB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7XG4gIGNvbW1hbmRMaW5lLFxuICByZWFkU2luY2UsXG4gIHRhaWxDb21tYW5kLFxuICB0YWlsV2l0aEhhbmRvZmYsXG4gIFdJTkRPV19IRUxQLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEhhbmRvZmZcIjtcbmltcG9ydCB7IFRBSUxfSURMRV9NUyB9IGZyb20gXCIuL2hlYXJ0YmVhdFwiO1xuaW1wb3J0IHsgRE9DX0VYVEVOU0lPTlMsIGlzRG9jTmFtZSB9IGZyb20gXCIuL3RyZWVcIjtcblxuLy8g4pqgIERFQ0xBUkVEIEZJUlNULCBBQk9WRSBFVkVSWSBPVEhFUiBGVU5DVElPTiwgT04gUFVSUE9TRS4gVGhlIGBjaG9pY2VzYFxuLy8gY2Vuc3VzJ3MgcmFpc2VyIHJ1bGUgKGEpIChgZ3JpbW9pcmUvbGliL2Vycm9yLXNpdGVzLnRzYCkgbWF0Y2hlc1xuLy8gYGZ1bmN0aW9uIE5BTUUoYCBsYXppbHkgdXAgdG8gdGhlIG5leHQgYCk6IG5ldmVyYCB3aXRoaW4gNjAwIGNoYXJhY3RlcnMsIHNvXG4vLyBBTlkgZnVuY3Rpb24gZGVjbGFyZWQgc2hvcnRseSBhYm92ZSB0aGlzIG9uZSDigJQgYGFwaWAsIHRoZW4gYHJlcXVpcmVTZXNzaW9uYCDigJRcbi8vIHdhcyByZWFkIGFzIGEgcmFpc2VyIGFuZCBpdHMgY2FsbHMgY291bnRlZCBhcyByYWlzZSBzaXRlcyAoZm91bmQgMjAyNi0wOS0xMSxcbi8vIHJlcG9ydGVkIGluIHRoZSBzbGljZS1BIGpvdXJuYWwgYXMgYW4gaW5zdHJ1bWVudCBkZWZlY3QsIG5vdCBmaXhlZCBoZXJlKS5cbmZ1bmN0aW9uIGRhZW1vblJlZnVzZWQod2hhdDogc3RyaW5nLCBzdGF0dXM6IG51bWJlciwgZGF0YTogdW5rbm93bik6IG5ldmVyIHtcbiAgY29uc3Qga2luZDogRXJyS2luZCA9XG4gICAgc3RhdHVzID09PSA0MDBcbiAgICAgID8gXCJ1c2FnZVwiXG4gICAgICA6IHN0YXR1cyA9PT0gNDA0XG4gICAgICAgID8gXCJub3RfZm91bmRcIlxuICAgICAgICA6IHN0YXR1cyA9PT0gNDA5XG4gICAgICAgICAgPyBcImNvbmZsaWN0XCJcbiAgICAgICAgICA6IFwiaW50ZXJuYWxcIjtcbiAgY29uc3QgYm9keSA9IChkYXRhID8/IHt9KSBhcyB7IGVycm9yPzogdW5rbm93bjsgY2hvaWNlcz86IHVua25vd247IGhpbnQ/OiB1bmtub3duIH07XG4gIGNvbnN0IGNob2ljZXMgPSBBcnJheS5pc0FycmF5KGJvZHkuY2hvaWNlcykgPyBib2R5LmNob2ljZXMubWFwKFN0cmluZykgOiB1bmRlZmluZWQ7XG4gIC8vIOKaoCBUaGUgZGFlbW9uJ3Mgb3duIGhpbnQsIGZvcndhcmRlZC4gQSByZWZ1c2FsIHRoYXQga25vd3Mgd2hhdCB0byBkbyBuZXh0XG4gIC8vIHVzZWQgdG8gZHJvcCB0aGF0IGtub3dsZWRnZSBvbiB0aGUgZmxvb3IgYXQgdGhpcyBsaW5lLlxuICBjb25zdCBoaW50ID0gdHlwZW9mIGJvZHkuaGludCA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuaGludCA6IHVuZGVmaW5lZDtcbiAgZGllKHR5cGVvZiBib2R5LmVycm9yID09PSBcInN0cmluZ1wiID8gYm9keS5lcnJvciA6IGAke3doYXR9IGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwga2luZCwge1xuICAgIC4uLihoaW50ID8geyBoaW50IH0gOiB7fSksXG4gICAgLi4uKGNob2ljZXMgPyB7IGNob2ljZXMgfSA6IHt9KSxcbiAgICAuLi4oZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoQnVuLmZpbGVVUkxUb1BhdGgoaW1wb3J0Lm1ldGEudXJsKSk7XG5jb25zdCBTS0lMTF9ST09UID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpO1xuY29uc3QgRElTVF9ESVIgPSBqb2luKFNLSUxMX1JPT1QsIFwiZGlzdFwiKTtcbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU1VSRkFDRV9DV0QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcInNjcmlwdG9yaXVtXCIpO1xuXG4vKiogQ29udHJhY3QgNTogYSBkZXYgZGFlbW9uIG11c3QgcnVuIHdpdGggY3dkIGF0IGBzcmMvc2NyaXB0b3JpdW0vYCAoYnVuZmlnLnRvbWwpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuXG4vKiogYCRTQ1JJUFRPUklVTV9IT01FYCwgZGVmYXVsdCBgfi8uc2NyaXB0b3JpdW1gIOKAlCB0aGUgc2FtZSBydWxlIGFzIHRoZSBkYWVtb24ncy4gKi9cbmZ1bmN0aW9uIHNjcmlwdG9yaXVtSG9tZSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVzb2x2ZShwcm9jZXNzLmVudi5TQ1JJUFRPUklVTV9IT01FID8/IGpvaW4oaG9tZWRpcigpLCBcIi5zY3JpcHRvcml1bVwiKSk7XG59XG5cbnR5cGUgU2Vzc2lvblBvaW50ZXIgPSB7IHVybDogc3RyaW5nOyBwb3J0OiBudW1iZXI7IHNlc3Npb25faWQ6IHN0cmluZzsgaG9tZTogc3RyaW5nOyBkaXI6IHN0cmluZyB9O1xuXG4vKipcbiAqIFNlc3Npb25zIHdob3NlIHdvcmsgaXMgc3RpbGwgb24gZGlzaywgbmV3ZXN0IGZpcnN0IChFNTYpLlxuICpcbiAqIOKblCBBIERFQUQgU0VTU0lPTiBJUyBOT1QgQSBMT1NUIE9ORSwgYW5kIHRoZSBDTEkgdXNlZCB0byBpbXBseSBvdGhlcndpc2UuIFRoZVxuICogbWFuaWZlc3QgYW5kIGV2ZXJ5IHZlcnNpb24gZmlsZSBsaXZlIHVuZGVyIHRoZSBob21lLCBzbyBhIGRhZW1vbiB0aGF0IGhhc1xuICogZXhpdGVkIOKAlCB0aGUgMzAtbWludXRlIGlkbGUgdGltZW91dCwgYSBjcmFzaCwgYSByZWJvb3Qg4oCUIGNvc3RzIHRoZSBVUkwgYW5kXG4gKiBub3RoaW5nIGVsc2UuIENvbGUgaGl0IGV4YWN0bHkgdGhpcyAoXCJ0aGF0IGxpbmsgZG9lc24ndCBzZWVtIHRvIGJlIGxpdmVcbiAqIGFueW1vcmVcIikgYW5kIHRoZSBvbmx5IHRoaW5nIHRoZSB0b29saW5nIHNhaWQgd2FzIFwibm8gcnVubmluZyBzY3JpcHRvcml1bVxuICogc2Vzc2lvblwiLCB3aGljaCByZWFkcyBsaWtlIHRoZSB3b3JrIGlzIGdvbmUuXG4gKi9cbmZ1bmN0aW9uIHJlc3RvcmFibGUoKTogc3RyaW5nW10ge1xuICBjb25zdCBkaXIgPSBqb2luKHNjcmlwdG9yaXVtSG9tZSgpLCBcInNlc3Npb25zXCIpO1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIsIHsgd2l0aEZpbGVUeXBlczogdHJ1ZSB9KVxuICAgICAgLmZpbHRlcigoZSkgPT4gZS5pc0RpcmVjdG9yeSgpICYmIGV4aXN0c1N5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKSlcbiAgICAgIC5tYXAoKGUpID0+ICh7IGlkOiBlLm5hbWUsIGF0OiBzdGF0U3luYyhqb2luKGRpciwgZS5uYW1lLCBcIm1hbmlmZXN0Lmpzb25cIikpLm10aW1lTXMgfSkpXG4gICAgICAuc29ydCgoYSwgYikgPT4gYi5hdCAtIGEuYXQpXG4gICAgICAubWFwKChlKSA9PiBlLmlkKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG5cbi8qKiBXaG8gZW5kZWQgYSBzYXZlZCBzZXNzaW9uLCByZWFkIGZyb20gaXRzIG1hbmlmZXN0ICh3aGljaCBvdXRsaXZlcyB0aGUgZGFlbW9uKS4gKi9cbmZ1bmN0aW9uIGVuZGVkQnkoaWQ6IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgY29uc3QgbSA9IEpTT04ucGFyc2UoXG4gICAgICByZWFkRmlsZVN5bmMoam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiLCBpZCwgXCJtYW5pZmVzdC5qc29uXCIpLCBcInV0ZjhcIiksXG4gICAgKSBhcyB7IGVuZGVkPzogeyBieT86IHVua25vd24gfSB9O1xuICAgIHJldHVybiB0eXBlb2YgbS5lbmRlZD8uYnkgPT09IFwic3RyaW5nXCIgPyBtLmVuZGVkLmJ5IDogdW5kZWZpbmVkO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKlxuICogV2hhdCB0byBzYXkgd2hlbiBubyBkYWVtb24gYW5zd2VycyDigJQgYWJvdXQgdGhlIHNlc3Npb24gQVNLRUQgYWJvdXRcbiAqIChgLS1zZXNzaW9uYCksIG9yIHRoZSBuZXdlc3Qgc2F2ZWQgb25lIHdoZW4gbm9uZSB3YXMgbmFtZWQuXG4gKlxuICog4puUIEEgTkFNRUQgU0VTU0lPTiBJUyBUSEUgT05FIFRIRSBISU5UIE5BTUVTLiBUaGlzIHVzZWQgdG8gb2ZmZXIgdGhlIG5ld2VzdFxuICogc2F2ZWQgc2Vzc2lvbiB3aGF0ZXZlciB3YXMgYXNrZWQsIHNvIGBzYXkgLS1zZXNzaW9uIDc4NmJjYjA5YCBhZnRlciB0aGVcbiAqIGh1bWFuIGVuZGVkIGl0IHNhaWQgXCJicmluZyBpdCBiYWNrIHdpdGg6IG9wZW4gLS1yZXN0b3JlIGIzZjQyOWQzXCIg4oCUIGFub3RoZXJcbiAqIHNlc3Npb24sIGxpdmUgYXQgdGhlIHRpbWUgKHZlcmlmaWVyLCAyMDI2LTEwLTAxKS5cbiAqXG4gKiDim5QgQSBIVU1BTiBFTkQgSVMgUk9VVEVEIE9OIFRIRSBNQU5JRkVTVCdTIGBlbmRlZC5ieWAsIE5PVCBPTiBQUk9TRTogdGhlXG4gKiBodW1hbiBlbmRlZCBpdCBvbiBwdXJwb3NlLCBzbyB0aGUgcmVmdXNhbCBzYXlzIHNvIGFuZCBkb2VzIG5vdCBvZmZlciB0aGVcbiAqIHJlb3BlbiBhcyB0aGUgbmV4dCBhY3QgKGBjaG9pY2VzYCB3b3VsZCBpbnZpdGUgaXQgdG9vLCBzbyB0aGVyZSBhcmUgbm9uZSkuXG4gKi9cbmZ1bmN0aW9uIG5vU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogeyBtZXNzYWdlOiBzdHJpbmc7IGV4dHJhOiBFcnJFeHRyYSB9IHtcbiAgY29uc3QgaWRzID0gcmVzdG9yYWJsZSgpO1xuICBjb25zdCBpZCA9IHNlc3Npb24gPz8gaWRzWzBdO1xuICBpZiAoaWQgPT09IHVuZGVmaW5lZClcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIixcbiAgICAgIGV4dHJhOiB7IGhpbnQ6IFwibm8gc2Vzc2lvbiBoYXMgYmVlbiBvcGVuZWQgaW4gdGhpcyBob21lIHlldCDigJQgcnVuOiBjbGkudHMgb3BlbiA8cGF0aD5cIiB9LFxuICAgIH07XG4gIGlmICghaWRzLmluY2x1ZGVzKGlkKSlcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogYG5vIHNjcmlwdG9yaXVtIHNlc3Npb24gJHtpZH0gaW4gdGhpcyBob21lYCxcbiAgICAgIGV4dHJhOiB7XG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgaWRzLmxlbmd0aCA9PT0gMFxuICAgICAgICAgICAgPyBcIm5vIHNhdmVkIHNlc3Npb25zIGluIHRoaXMgaG9tZSDigJQgcnVuOiBjbGkudHMgb3BlbiA8cGF0aD5cIlxuICAgICAgICAgICAgOiBcInBhc3MgLS1zZXNzaW9uIG9uZSBvZiB0aGUgc2F2ZWQgc2Vzc2lvbnMsIG9yIGRyb3AgaXQgZm9yIHRoZSBtb3N0IHJlY2VudFwiLFxuICAgICAgICBjaG9pY2VzOiBpZHMuc2xpY2UoMCwgMTApLFxuICAgICAgfSxcbiAgICB9O1xuICBpZiAoZW5kZWRCeShpZCkgPT09IFwiaHVtYW5cIilcbiAgICByZXR1cm4ge1xuICAgICAgbWVzc2FnZTogYHRoZSBodW1hbiBlbmRlZCBzZXNzaW9uICR7aWR9YCxcbiAgICAgIGV4dHJhOiB7XG4gICAgICAgIGhpbnQ6IGB0aGUgaHVtYW4gZW5kZWQgdGhpcyBzZXNzaW9uIG9uIHB1cnBvc2U7IGRvIG5vdCByZW9wZW4gaXQgdW5sZXNzIHRoZXkgYXNrLiBJZiB0aGV5IGFzazogY2xpLnRzIG9wZW4gLS1yZXN0b3JlICR7aWR9YCxcbiAgICAgIH0sXG4gICAgfTtcbiAgcmV0dXJuIHtcbiAgICBtZXNzYWdlOiBgbm8gcnVubmluZyBzY3JpcHRvcml1bSBzZXNzaW9uICR7aWR9YCxcbiAgICBleHRyYToge1xuICAgICAgLy8g4pqgIFRoZSBDT01NQU5ELCB3aXRoIHRoZSBpZCBhbHJlYWR5IGluIGl0LiBBIGhpbnQgdGhhdCBzYXlzIFwieW91IGNhblxuICAgICAgLy8gcmVzdG9yZSBhIHNlc3Npb25cIiBsZWF2ZXMgdGhlIHJlYWRlciB0byBmaW5kIHRoZSBpZCBhbmQgZ3Vlc3MgdGhlIGZsYWcuXG4gICAgICBoaW50OiBgbm8gZGFlbW9uIGlzIHJ1bm5pbmcgZm9yIHNlc3Npb24gJHtpZH0sIGJ1dCBpdHMgd29yayBpcyBvbiBkaXNrIOKAlCBicmluZyBpdCBiYWNrIHdpdGg6IGNsaS50cyBvcGVuIC0tcmVzdG9yZSAke2lkfWAsXG4gICAgICBjaG9pY2VzOiBpZHMuc2xpY2UoMCwgMTApLFxuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGpvaW4odG1wZGlyKCksIHNlc3Npb24gPyBgc2NyaXB0b3JpdW0tJHtzZXNzaW9ufS5qc29uYCA6IFwic2NyaXB0b3JpdW0tbGF0ZXN0Lmpzb25cIik7XG59XG5cbi8qKiBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFIOKAlCBFTk9FTlQgaXMgdGhlIG9ubHkgYWJzZW5jZS4gKi9cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uUG9pbnRlcjtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB0aGUgc2Vzc2lvbiBwb2ludGVyIGlzIG5vdCB2YWxpZCBKU09OOiAke3BhdGh9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXF1aXJlU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvblBvaW50ZXIge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykge1xuICAgIGNvbnN0IHsgbWVzc2FnZSwgZXh0cmEgfSA9IG5vU2Vzc2lvbihzZXNzaW9uKTtcbiAgICBkaWUobWVzc2FnZSwgXCJub3RfZm91bmRcIiwgZXh0cmEpO1xuICB9XG4gIHJldHVybiBzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHtcbiAgICAvKiBub24tSlNPTiBib2R5ICovXG4gIH1cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgbGV0IHN0YXR1czogbnVtYmVyO1xuICBsZXQgZGF0YTogdW5rbm93bjtcbiAgdHJ5IHtcbiAgICAoeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgbXNnKSk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIC8vIGBjbG9zZWAgc3RvcHMgdGhlIHNlcnZlcjsgYSBSRVNFVCBpcyBpdHMgc3VjY2Vzcy4gQSByZWZ1c2VkIGNvbm5lY3Rpb25cbiAgICAvLyAoYSBzdGFsZSBwb2ludGVyKSBpcyBhIHRyYW5zcG9ydCBmYWlsdXJlIGxpa2UgYW55IG90aGVyLlxuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgY29uc3QgY29kZSA9IGVyciAmJiB0eXBlb2YgZXJyID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGVyciA/IFN0cmluZyhlcnIuY29kZSkgOiBcIlwiO1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiICYmIChjb2RlID09PSBcIkVDT05OUkVTRVRcIiB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiRUNPTk5SRVNFVFwiKSkpXG4gICAgICByZXR1cm4geyBvazogdHJ1ZSB9O1xuICAgIHRocm93IGVycjtcbiAgfVxuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoU3RyaW5nKG1zZy50eXBlKSwgc3RhdHVzLCBkYXRhKTtcbiAgcmV0dXJuIGRhdGEgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbi8vIOKUgOKUgCB0aGUgZmxhZyByZWdpc3RyeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgb3B0aW9ucyB0YWJsZSB0aGUga2l0J3MgcGFyc2VyIHJlYWRzIChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgLCB0aHJvdWdoXG4vLyBgZGVmaW5lQ2xpYCBiZWxvdykuIEV4cG9ydGVkIHNvIGEgdGVzdCBjYW4gYnVpbGQgdGhlIHNhbWUgcGFyc2UgdGhlIENMSSBkb2VzLlxuXG5leHBvcnQgY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIFwiYm9keS1maWxlXCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBieTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNvbnRleHQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBkb2M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBlbnRyeTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZvcjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZyb206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmdWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHF1b3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVvcGVuOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIGh1bmtzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaW50bzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxpZmVjeWNsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxpbWl0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFiZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBvbmNlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHBhdGNoOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHRhZzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0eXBlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbn0gYXMgY29uc3Q7XG5cbmV4cG9ydCBjbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgQ2xpRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSkge1xuICAgIHN1cGVyKFwidXNhZ2VcIiwgbWVzc2FnZSwgZXh0cmEpO1xuICB9XG59XG5cbi8qKlxuICogYHRhaWwgLS1zaW5jZWAgaXMgYSBCT09LTUFSSzogYW4gZXZlbnQgaWQgKC0xIGZvciBcImV2ZXJ5dGhpbmdcIiksIG9wdGlvbmFsbHlcbiAqIHdpdGggdGhlIGVwb2NoIG9mIHRoZSBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIGFzIHRoZSB0YWlsJ3Mgb3duIGhhbmRvZmYgbGluZSBwcmludHMgaXQg4oCUXG4gKiBga2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgLCBEMikuIFRoZSBlcG9jaCBpcyB3aGF0IGxldHMgdGhlIHRhaWwgbm90aWNlIGFcbiAqIHJlc3RhcnRlZCBkYWVtb24gd2hvc2UgbmV3IGxvZyBpcyBhbHJlYWR5IHBhc3QgdGhlIGlkLiBWZXJpZnktcGFzcyBmaXggOVxuICogc3RpbGwgaG9sZHM6IGAtLXNpbmNlIGFiY2AgdXNlZCB0byBwYXJzZSB0byBOYU4sIHdoaWNoIHRoZSBsb2cgcmVhZHMgYXMgXCJmcm9tXG4gKiB0aGUgc3RhcnRcIiwgc28gYSB0eXBvIHJlcGxheWVkIHRoZSB3aG9sZSBidWZmZXIgYXQgZXhpdCAwIOKAlCBpdCBpcyByZWZ1c2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VUYWlsU2luY2UodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHIgPSByZWFkU2luY2UodG9rZW4sIHsgZXBvY2g6IHRydWUgfSk7XG4gIGlmICghci5vaykgZGllKHIubWVzc2FnZSwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHIuZXBvY2ggPyB7IHNpbmNlOiByLnNpbmNlLCBlcG9jaDogci5lcG9jaCB9IDogeyBzaW5jZTogci5zaW5jZSB9O1xufVxuXG4vKipcbiAqIGBmaW5kIC0tc2luY2VgIGlzIGEgREFURSwgd2hlcmUgYHRhaWwgLS1zaW5jZWAgaXMgYW4gZXZlbnQgaWQg4oCUIHRoZSBmbGFnIGlzXG4gKiBzaGFyZWQsIHRoZSBtZWFuaW5nIGlzIHRoZSB2ZXJiJ3MsIGFuZCBwZG9jcyBzcGVsbHMgdGhpcyBvbmUgYC0tc2luY2VgIHRvby5cbiAqIEEgdHlwbyBtdXN0IG5vdCBzaWxlbnRseSB3aWRlbiB0aGUgc2VhcmNoLCBzbyBhIG5vbi1kYXRlIGlzIGEgdXNhZ2UgZXJyb3IuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpbmNlRGF0ZSh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9JC8udGVzdCh0KSB8fCBOdW1iZXIuaXNOYU4oRGF0ZS5wYXJzZSh0KSkpXG4gICAgZGllKGBmaW5kIC0tc2luY2U6IFwiJHt0b2tlbn1cIiBpcyBub3QgYSBkYXRlIOKAlCB3cml0ZSBpdCBhcyBZWVlZLU1NLUREYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIHQ7XG59XG5cbi8qKiBgdjJgIG9yIGAyYCDihpIgMi4gQSB2ZXJzaW9uIG51bWJlciBpcyBhbiBvcGVuIHNldCwgc28gdGhlIHJlamVjdGlvbiBjYXJyaWVzIGEgaGludCwgbm90IGNob2ljZXMuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VWZXJzaW9uKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IG0gPSAvXnY/KFxcZCspJC8uZXhlYyh0b2tlbi50cmltKCkpO1xuICBpZiAoIW0gfHwgTnVtYmVyKG1bMV0pIDwgMSlcbiAgICBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB2ZXJzaW9uIOKAlCB3cml0ZSB2MSwgdjIsIOKApmAsIFwidXNhZ2VcIiwge1xuICAgICAgaGludDogXCJydW46IGNsaS50cyBzdGF0ZSAoZWFjaCBkb2MgbGlzdHMgaXRzIHZlcnNpb25zKVwiLFxuICAgIH0pO1xuICByZXR1cm4gTnVtYmVyKG1bMV0pO1xufVxuXG4vKiogQSBub24tbmVnYXRpdmUgd2hvbGUgbnVtYmVyIGZyb20gYSBmbGFnLCByZWZ1c2VkIHJhdGhlciB0aGFuIGNvZXJjZWQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDb3VudCh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkKyQvLnRlc3QodCkpIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHdob2xlIG51bWJlcmAsIFwidXNhZ2VcIik7XG4gIHJldHVybiBOdW1iZXIodCk7XG59XG5cbi8qKlxuICogQSBjb21wYXJpc29uIHNpZGU6IGEgdmVyc2lvbiwgb3IgdGhlIGZpbGUgb2YgcmVjb3JkLiBgb3JpZ2luYWxgIGlzIHNwZWxsZWRcbiAqIG91dCByYXRoZXIgdGhhbiBvZmZlcmVkIGFzIGB2MGAg4oCUIGEgemVyb3RoIHZlcnNpb24gd291bGQgcmVhZCBsaWtlIHRoZVxuICogZWFybGllc3Qgb25lLCBhbmQgdGhlIG9yaWdpbmFsIGlzIG5vdCBwYXJ0IG9mIHRoZSB2ZXJzaW9uIGxpbmUgYXQgYWxsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaWRlKHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB8IFwib3JpZ2luYWxcIiB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCkudG9Mb3dlckNhc2UoKTtcbiAgLy8gYHNhdmVkYCBpcyB0aGUgd29yZCB0aGUgU1VSRkFDRSB1c2VzIGZvciB0aGlzIHNpZGUgKEU0Myk7IGBvcmlnaW5hbGAgYW5kXG4gIC8vIGBmaWxlYCBrZWVwIHdvcmtpbmcgYmVjYXVzZSB0aGV5IGFyZSB3aGF0IGVhcmxpZXIgc2Vzc2lvbnMgYW5kIG5vdGVzIHNheS5cbiAgaWYgKHQgPT09IFwib3JpZ2luYWxcIiB8fCB0ID09PSBcImZpbGVcIiB8fCB0ID09PSBcInNhdmVkXCIpIHJldHVybiBcIm9yaWdpbmFsXCI7XG4gIHJldHVybiBwYXJzZVZlcnNpb24odG9rZW4sIHdoYXQpO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8qKlxuICog4puUIFZFUklGWS1QQVNTIEZJWCA1OiBldmVyeSBwYXRoIGlzIGNoZWNrZWQgSEVSRSwgYmVmb3JlIGFueSBkYWVtb24gZXhpc3RzLlxuICogYG9wZW4gZG9jLm1kIHBpYy5wbmdgIHVzZWQgdG8gc3Bhd24gYSBzZXNzaW9uLCB0aGVuIGZhaWwgb24gdGhlIHNlY29uZCBwYXRoXG4gKiBpbnNpZGUgaXQg4oCUIGxlYXZpbmcgYSBydW5uaW5nIGRhZW1vbiBhbmQgYSBsaXZlIHBvaW50ZXIgYmVoaW5kIGEgZmFpbGVkXG4gKiBjb21tYW5kLiBBIGZvbGRlciBvciBhIGRvY3VtZW50IGlzIGFjY2VwdGVkOyBhIG1pc3NpbmcgcGF0aCBpcyBub3RfZm91bmQsIGFcbiAqIG5vbi1kb2N1bWVudCBmaWxlIGlzIHVzYWdlIHdpdGggdGhlIGFjY2VwdGVkIGV4dGVuc2lvbnMgYXMgYGNob2ljZXNgLlxuICovXG5mdW5jdGlvbiBjb250ZXh0UGF0aHMocG9zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3QgcGF0aHMgPSBwb3MubWFwKChwKSA9PiByZXNvbHZlKHApKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhdGhzKSB7XG4gICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgdHJ5IHtcbiAgICAgIHN0ID0gc3RhdFN5bmMocCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBkaWUoYG5vIHN1Y2ggZmlsZSBvciBmb2xkZXI6ICR7cH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgICB9XG4gICAgaWYgKCFzdC5pc0RpcmVjdG9yeSgpICYmICFpc0RvY05hbWUocCkpXG4gICAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke3B9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwiYWRkIGEgZm9sZGVyLCBvciBhIGZpbGUgd2l0aCBvbmUgb2YgdGhlc2UgZXh0ZW5zaW9uc1wiLFxuICAgICAgICBjaG9pY2VzOiBbLi4uRE9DX0VYVEVOU0lPTlNdLFxuICAgICAgfSk7XG4gIH1cbiAgcmV0dXJuIHBhdGhzO1xufVxuXG4vKipcbiAqIFdoZXJlIGEgTkVXIHNlc3Npb24ncyB3b3Jrc3BhY2UgZ29lcyAoRTIzLCByZWZpbmVkIGJ5IEU2Nyk6IHRoZSBvbmUgZm9sZGVyXG4gKiBgb3BlbmAgd2FzIGdpdmVuLCBzbyBhIHNlc3Npb24gb3ZlciBhIHdvcmxkIG9wZW5lZCBmcm9tIGFueXdoZXJlIHB1dHMgbmV3XG4gKiBkb2N1bWVudHMgaW4gdGhhdCB3b3JsZDsgb3RoZXJ3aXNlIChzZXZlcmFsIGVudHJpZXMsIGEgbG9uZSBmaWxlLCBub3RoaW5nKVxuICogdGhlIGZvbGRlciBgb3BlbmAgcmFuIGluLiBgcGF0aHNgIGFyZSBgY29udGV4dFBhdGhzYCdzLCBhbHJlYWR5IGFic29sdXRlIGFuZFxuICogYWxyZWFkeSBjaGVja2VkIHRvIGV4aXN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFdvcmtzcGFjZShwYXRoczogcmVhZG9ubHkgc3RyaW5nW10sIGN3ZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgLy8g4puUIFRIRSBSVUxFIElTIEFCT1VUIERJU1RJTkNUIEZPTERFUlMsIE5PVCBBUkdVTUVOVFMuIGBvcGVuIHdvcmxkIHdvcmxkYFxuICAvLyAob3IgYHdvcmxkYCBhbmQgYSBzeW1saW5rIHRvIGl0KSBvcGVucyBvbmUgZm9sZGVyLCBhbmQgY291bnRlZCBhcyB0d28gaXRcbiAgLy8gbGVmdCB0aGUgd29ya3NwYWNlIGluIHRoZSBjd2QuIENvbXBhcmVkIGJ5IHJlYWxwYXRoOyB0aGUgZmlyc3Qgc3BlbGxpbmdcbiAgLy8gZ2l2ZW4gaXMgdGhlIG9uZSBrZXB0LlxuICBjb25zdCBkaXN0aW5jdCA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuICAgIGNvbnN0IGtleSA9IHJlYWxwYXRoU3luYyhwKTtcbiAgICBpZiAoIWRpc3RpbmN0LmhhcyhrZXkpKSBkaXN0aW5jdC5zZXQoa2V5LCBwKTtcbiAgfVxuICBjb25zdCBvbmx5ID0gZGlzdGluY3Quc2l6ZSA9PT0gMSA/IFsuLi5kaXN0aW5jdC52YWx1ZXMoKV1bMF0gOiB1bmRlZmluZWQ7XG4gIGlmIChvbmx5ICE9PSB1bmRlZmluZWQgJiYgc3RhdFN5bmMob25seSkuaXNEaXJlY3RvcnkoKSkgcmV0dXJuIG9ubHk7XG4gIHJldHVybiBjd2Q7XG59XG5cbi8qKlxuICogYC0tZG9jYCBhcyB0aGUgQ0xJJ3MgY2FsbGVyIG1lYW50IGl0ICh2ZXJpZnktcGFzcyBmaXggOCk6IGEgdG9rZW4gd2l0aCBhIHBhdGhcbiAqIHNlcGFyYXRvciwgb3Igb25lIG5hbWluZyBhIGZpbGUgaW4gVEhJUyBwcm9jZXNzJ3MgY3dkLCBpcyByZXNvbHZlZCBoZXJlIHRvIGFuXG4gKiBhYnNvbHV0ZSBwYXRoIOKAlCB0aGUgZGFlbW9uJ3MgY3dkIGlzIG5vdCB0aGUgY2FsbGVyJ3MuIEFueXRoaW5nIGVsc2UgKGEgc2x1ZyxcbiAqIGEgdW5pcXVlIGZpbGUgbmFtZSkgZ29lcyBhcyB0eXBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY0FyZyh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHRva2VuLmluY2x1ZGVzKFwiL1wiKSB8fCBleGlzdHNTeW5jKHJlc29sdmUodG9rZW4pKSkgcmV0dXJuIHJlc29sdmUodG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbi8qKiBLZWVwIHRoZSBuZXdlc3QgYExPR19LRUVQIC0gMWAgZGFlbW9uIGxvZ3MsIHNvIHRoZSBvbmUgYWJvdXQgdG8gYmUgd3JpdHRlbiBtYWtlcyBgTE9HX0tFRVBgLiAqL1xuY29uc3QgTE9HX0tFRVAgPSAxMDtcbmZ1bmN0aW9uIHBydW5lTG9ncyhsb2dEaXI6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgbmFtZXMgPSByZWFkZGlyU3luYyhsb2dEaXIpLmZpbHRlcigobikgPT4gL15kYWVtb24tXFxkKy1cXGQrXFwubG9nJC8udGVzdChuKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBieUFnZSA9IG5hbWVzLnNvcnQoKGEsIGIpID0+IE51bWJlcihhLnNwbGl0KFwiLVwiKVsxXSkgLSBOdW1iZXIoYi5zcGxpdChcIi1cIilbMV0pKTtcbiAgZm9yIChjb25zdCBuIG9mIGJ5QWdlLnNsaWNlKDAsIE1hdGgubWF4KDAsIGJ5QWdlLmxlbmd0aCAtIChMT0dfS0VFUCAtIDEpKSkpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhqb2luKGxvZ0RpciwgbikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG5cbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIGZsYWdzLnJlc3RvcmUsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWFuaWZlc3QpKSB7XG4gICAgICBsZXQgc2F2ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICB0cnkge1xuICAgICAgICBzYXZlZCA9IChcbiAgICAgICAgICBhd2FpdCBBcnJheS5mcm9tQXN5bmMobmV3IEJ1bi5HbG9iKFwiKi9tYW5pZmVzdC5qc29uXCIpLnNjYW4oam9pbihob21lLCBcInNlc3Npb25zXCIpKSlcbiAgICAgICAgKS5tYXAoKHApID0+IHAuc3BsaXQoXCIvXCIpWzBdIGFzIHN0cmluZyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm8gc2Vzc2lvbnMgZm9sZGVyOiB0aGUgc2V0IGlzIGVtcHR5LCBhbmQgc2F5cyBzbyAqL1xuICAgICAgfVxuICAgICAgZGllKGBubyBzYXZlZCBzZXNzaW9uIFwiJHtmbGFncy5yZXN0b3JlfVwiIHVuZGVyICR7aG9tZX1gLCBcIm5vdF9mb3VuZFwiLCB7XG4gICAgICAgIGNob2ljZXM6IHNhdmVkLnNvcnQoKSxcbiAgICAgICAgLi4uKHNhdmVkLmxlbmd0aCA9PT0gMCA/IHsgaGludDogXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWVcIiB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxpdmUgPSByZWFkU2Vzc2lvbihmbGFncy5yZXN0b3JlKTtcbiAgICBpZiAobGl2ZSkge1xuICAgICAgY29uc3QgYWxpdmUgPSBhd2FpdCBhcGkobGl2ZS5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKS50aGVuKFxuICAgICAgICAocikgPT4gci5zdGF0dXMgPT09IDIwMCxcbiAgICAgICAgKCkgPT4gZmFsc2UsXG4gICAgICApO1xuICAgICAgaWYgKGFsaXZlKVxuICAgICAgICBkaWUoYHNlc3Npb24gJHtmbGFncy5yZXN0b3JlfSBpcyBhbHJlYWR5IHJ1bm5pbmcgYXQgJHtsaXZlLnVybH1gLCBcImNvbmZsaWN0XCIsIHtcbiAgICAgICAgICBoaW50OiBgdXNlIGl0OiBjbGkudHMgc3RhdGUgLS1zZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX1gLFxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBkYWVtb25BcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAodHlwZW9mIGZsYWdzLnRpbWVvdXQgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBmbGFncy50aW1lb3V0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgZmxhZ3MucmVzdG9yZSk7XG4gIC8vIEUyMyArIEU2NzogYSBuZXcgc2Vzc2lvbidzIHdvcmtzcGFjZSBpcyB0aGUgb25lIGZvbGRlciBpdCB3YXMgZ2l2ZW4sIGVsc2VcbiAgLy8gd2hlcmUgYG9wZW5gIHJhbiAoYGRlZmF1bHRXb3Jrc3BhY2VgKS4gQSByZXN0b3JlZCBvbmUga2VlcHMgaXRzIG93bi5cbiAgZWxzZSBkYWVtb25BcmdzLnB1c2goXCItLXdvcmtzcGFjZVwiLCBkZWZhdWx0V29ya3NwYWNlKHBhdGhzLCBwcm9jZXNzLmN3ZCgpKSk7XG5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfWAsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZGV2IG1vZGUgd2FzIHJlc29sdmVkIChubyBkaXN0L2luZGV4Lmh0bWwgYW5kIG5vIFNQRUxMQk9PS19TVVJGQUNFX01PREU9cmVsZWFzZSksIHdoaWNoIG5lZWRzIHNyYy9zY3JpcHRvcml1bS8g4oCUIHJlaW5zdGFsbCB0aGUgc3BlbGwgb3IgYnVpbGQgaXRcIixcbiAgICAgIH0sXG4gICAgKTtcbiAgLy8gVGhlIGRhZW1vbidzIHN0ZGVyciBnb2VzIHRvIGEgTE9HIEZJTEUsIG5vdCB0byB0aGlzIENMSSdzIHN0ZGVyci4gQW5cbiAgLy8gaW5oZXJpdGVkIHN0ZGVyciBvdXRsaXZlcyB0aGUgQ0xJIGluc2lkZSB0aGUgZGV0YWNoZWQgZGFlbW9uLCBzbyBhbnkgY2FsbGVyXG4gIC8vIHRoYXQgcmVhZHMgYG9wZW5gJ3Mgc3RkZXJyIHRvIEVPRiAoYSB0ZXN0IGhhcm5lc3MsIGEgdG9vbCBydW5uZXIpIHdhaXRzIGZvclxuICAvLyB0aGUgd2hvbGUgc2Vzc2lvbiDigJQgbWVhc3VyZWQ6IHRoZSBpbnRlZ3JhdGlvbiBjZWxsIGh1bmcgYXQgaXRzIDYwIHMgdGltZW91dC5cbiAgLy8gQSBmaWxlIGhvbGRzIG5vIHBpcGUsIGFuZCBhIHN0YXJ0IGZhaWx1cmUgYmVsb3cgcXVvdGVzIGl0cyB0YWlsLlxuICBjb25zdCBsb2dEaXIgPSBqb2luKHNjcmlwdG9yaXVtSG9tZSgpLCBcImxvZ3NcIik7XG4gIG1rZGlyU3luYyhsb2dEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogdGhlIGxvZ3MgdXNlZCB0byBwaWxlIHVwLCBvbmUgcGVyIGBvcGVuYCwgZm9yZXZlci5cbiAgcHJ1bmVMb2dzKGxvZ0Rpcik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKGxvZ0RpciwgYGRhZW1vbi0ke0RhdGUubm93KCl9LSR7cHJvY2Vzcy5waWR9LmxvZ2ApO1xuICBkYWVtb25BcmdzLnB1c2goXCItLWxvZ1wiLCBsb2dQYXRoKTtcbiAgY29uc3QgbG9nRmQgPSBvcGVuU3luYyhsb2dQYXRoLCBcImFcIik7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJidW5cIiwgZGFlbW9uQXJncywge1xuICAgIGN3ZCxcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBsb2dGZF0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgfSk7XG4gIGNsb3NlU3luYyhsb2dGZCk7XG4gIGNoaWxkLnVucmVmKCk7XG5cbiAgY29uc3Qgc3RhcnRUaW1lb3V0TXMgPVxuICAgIHR5cGVvZiBmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0gPT09IFwic3RyaW5nXCJcbiAgICAgID8gTWF0aC5tYXgoNTAwMCwgTnVtYmVyLnBhcnNlSW50KGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSwgMTApICogMTAwMClcbiAgICAgIDogNDUwMDA7XG4gIGNvbnN0IGxpbmUgPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXMsIHJlaikgPT4ge1xuICAgIGxldCBidWYgPSBcIlwiO1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChcbiAgICAgICgpID0+XG4gICAgICAgIHJlaihcbiAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgZGFlbW9uIHN0YXJ0IHRpbWVvdXQgKCR7c3RhcnRUaW1lb3V0TXMgLyAxMDAwfXMpIOKAlCBwYXNzIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz5gLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICBzdGFydFRpbWVvdXRNcyxcbiAgICApO1xuICAgIGNoaWxkLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICBidWYgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IG5sID0gYnVmLmluZGV4T2YoXCJcXG5cIik7XG4gICAgICBpZiAobmwgPj0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICByZXMoYnVmLnNsaWNlKDAsIG5sKS50cmltKCkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihlcnIpO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihuZXcgRXJyb3IoYGRhZW1vbiBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0gYmVmb3JlIGl0cyBoYW5kc2hha2VgKSk7XG4gICAgfSk7XG4gIH0pLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICBsZXQgdGFpbCA9IFwiXCI7XG4gICAgdHJ5IHtcbiAgICAgIHRhaWwgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGY4XCIpLnRyaW0oKS5zbGljZSgtODAwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIGxvZyB3cml0dGVuICovXG4gICAgfVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAgeyBoaW50OiB0YWlsID8gYGRhZW1vbiBsb2cgKCR7bG9nUGF0aH0pOiAke3RhaWx9YCA6IGBkYWVtb24gbG9nOiAke2xvZ1BhdGh9YCB9LFxuICAgICk7XG4gIH0pO1xuXG4gIC8vIFJlbGVhc2UgdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlLCBvciB0aGlzIENMSSdzIG5hdHVyYWwgcmV0dXJuIHdhaXRzIG9uIGFcbiAgLy8gc3RyZWFtIHRoYXQgbmV2ZXIgY2xvc2VzIChnbGFtb3VyIG1lYXN1cmVkIDkxIHMg4oaSIDEgcykuIENoZWNrZWQgZm9yIHRoZVxuICAvLyBNRVRIT0Q6IHVuZGVyIEJ1biB0aGlzIHBpcGUgaXMgYSBwbGFpbiBSZWFkYWJsZSB0aGF0IG5vbmV0aGVsZXNzIGhhcyB1bnJlZi5cbiAgY29uc3Qgb3V0ID0gY2hpbGQuc3Rkb3V0O1xuICBpZiAoIW91dCB8fCAhKFwidW5yZWZcIiBpbiBvdXQpIHx8IHR5cGVvZiBvdXQudW5yZWYgIT09IFwiZnVuY3Rpb25cIilcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInNjcmlwdG9yaXVtOiB0aGUgZGFlbW9uJ3Mgc3Rkb3V0IHBpcGUgaGFzIG5vIHVucmVmKCk7IGBvcGVuYCB3b3VsZCBuZXZlciBleGl0XCIsXG4gICAgKTtcbiAgb3V0LnVucmVmKCk7XG5cbiAgbGV0IGhzOiB7XG4gICAgdXJsOiBzdHJpbmc7XG4gICAgcG9ydDogbnVtYmVyO1xuICAgIHNlc3Npb25faWQ6IHN0cmluZztcbiAgICAvKiogV2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQ6IG5hbWVkIHNvIHRoZSBhZ2VudCBzZWVzIGl0IChFNjcpLiAqL1xuICAgIHdvcmtzcGFjZT86IHN0cmluZztcbiAgICBvaz86IGJvb2xlYW47XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9O1xuICB0cnkge1xuICAgIGhzID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB1bmV4cGVjdGVkIG91dHB1dCBmcm9tIGRhZW1vbjogJHtsaW5lfWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgaWYgKGhzLm9rID09PSBmYWxzZSkgZGFlbW9uUmVmdXNlZChcIm9wZW5cIiwgaHMuc3RhdHVzID8/IDUwMCwgaHMpO1xuXG4gIGxldCBlbnRyaWVzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCByID0gYXdhaXQgcG9zdENtZChocy5zZXNzaW9uX2lkLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSk7XG4gICAgZW50cmllcyA9IChyLmVudHJpZXMgYXMgdW5rbm93bltdKSA/PyBbXTtcbiAgfVxuICBwcmludEpzb24oeyAuLi5ocywgLi4uKHBhdGhzLmxlbmd0aCA+IDAgPyB7IGVudHJpZXMgfSA6IHt9KSB9KTtcblxuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkge1xuICAgIGNvbnN0IG9wZW5lciA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gICAgc3Bhd24ob3BlbmVyLCBbaHMudXJsXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86IFwiaWdub3JlXCIgfSkudW5yZWYoKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjb250ZXh0LmFkZFwiLCBwYXRocyB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZnVsbDogYm9vbGVhbikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCI/ZnVsbD0xXCIgOiBcIlwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJzdGF0ZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbi8qKlxuICogVGhlIE9ORSBwcm9zZSByZWFkZXI6IGFyZ3VtZW50cywgYC0tc3RkaW5gIG9yIGAtLWJvZHktZmlsZWAsIGV4YWN0bHkgb25lIG9mXG4gKiB0aGVtLiBgc2F5YC9gdGFza2AvYG5vdGVgIG5lZWQgYSBtZXNzYWdlIGFuZCB0cmltIGl0OyBgdmVyc2lvbi1uZXdgICgjMTE3KVxuICogbWF5IGhhdmUgbm9uZSAodGhlbiBpdCBjb3BpZXMpIGFuZCBrZWVwcyBpdHMgYm9keSBieXRlIGZvciBieXRlLCBiZWNhdXNlIGFcbiAqIHZlcnNpb24ncyB0ZXh0IGlzIGEgZG9jdW1lbnQsIG5vdCBhIGNoYXQgbGluZS5cbiAqXG4gKiBBIGJvZHkgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZSBpcyBgdXNhZ2VgICgyKSBieSBkZWZhdWx0IOKAlCB3aGF0IGBzYXlgL2B0YXNrYC9cbiAqIGBub3RlYC9gbm90ZS1lZGl0YCBoYXZlIGFsd2F5cyBhbnN3ZXJlZCDigJQgYW5kIGBub3RfZm91bmRgICg1KSB3aGVyZSB0aGVcbiAqIGNhbGxlciBhc2tzIChgdmVyc2lvbi1uZXdgLCBuZXcgaW4gIzExNykuIOKaoCBBbGlnbmluZyB0aGUgb2xkZXIgdmVyYnMgb24gNSBpc1xuICogYSBjYWxsZXItdmlzaWJsZSBleGl0LWNvZGUgY2hhbmdlLCBoZWxkIGZvciBhIHJlbGVhc2UgdGhhdCBjYW4gY2FycnkgYVxuICogYnJlYWtpbmctY2hhbmdlcyBub3RlOyBjbGktY29udHJhY3QgcGlucyB0aGVpciAyIHVudGlsIHRoZW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRQcm9zZShcbiAgdmVyYjogc3RyaW5nLFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4gIG86IHsgb3B0aW9uYWw/OiBib29sZWFuOyBtaXNzaW5nRmlsZT86IFwidXNhZ2VcIiB8IFwibm90X2ZvdW5kXCIgfSA9IHt9LFxuKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgPT09IDAgJiYgby5vcHRpb25hbCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IGAke3ZlcmJ9IG5lZWRzIGEgbWVzc2FnZWBcbiAgICAgICAgOiBvLm9wdGlvbmFsXG4gICAgICAgICAgPyBgJHt2ZXJifSB0YWtlcyBpdHMgYm9keSBmcm9tIG9uZSBwbGFjZTogLS1zdGRpbiBvciAtLWJvZHktZmlsZSwgbm90IGJvdGhgXG4gICAgICAgICAgOiBgJHt2ZXJifSB0YWtlcyBpdHMgbWVzc2FnZSBmcm9tIGV4YWN0bHkgb25lIHBsYWNlOiBhcmd1bWVudHMsIC0tc3RkaW4gb3IgLS1ib2R5LWZpbGVgLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBvLm9wdGlvbmFsXG4gICAgICAgICAgPyBcImdpdmUgdGhlIHRleHQgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIlxuICAgICAgICAgIDogXCJnaXZlIHRoZSB0ZXh0IGFzIGFyZ3VtZW50cywgb3IgcHJvc2UgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gLyAtLXN0ZGluIChuZXZlciBhbiB1bnF1b3RlZCBoZXJlZG9jKVwiLFxuICAgICAgICBjaG9pY2VzOiBbXCItLXN0ZGluXCIsIFwiLS1ib2R5LWZpbGVcIl0sXG4gICAgICB9LFxuICAgICk7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIGlmIChmbGFncy5zdGRpbiA9PT0gdHJ1ZSkgdGV4dCA9IGF3YWl0IG5ldyBSZXNwb25zZShCdW4uc3RkaW4uc3RyZWFtKCkpLnRleHQoKTtcbiAgZWxzZSBpZiAodHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgcGF0aCA9IGZsYWdzW1wiYm9keS1maWxlXCJdO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBvLm1pc3NpbmdGaWxlID8/IFwidXNhZ2VcIik7XG4gICAgLy8gQSBkaXJlY3RvcnkgaXMgdGhlIGNhbGxlcidzIG1pc3Rha2UsIHRoZSBzYW1lIGZvciBldmVyeSB2ZXJiIOKAlCBpdCB1c2VkXG4gICAgLy8gdG8gcmVhY2ggcmVhZEZpbGVTeW5jIGFuZCBjb21lIG91dCBhcyBhbiBpbnRlcm5hbCBFSVNESVIgKGV4aXQgMSkuXG4gICAgaWYgKHN0YXRTeW5jKHBhdGgpLmlzRGlyZWN0b3J5KCkpXG4gICAgICBkaWUoYCR7dmVyYn06IC0tYm9keS1maWxlIGlzIGEgZGlyZWN0b3J5LCBub3QgYSBmaWxlOiAke3BhdGh9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwicGFzcyB0aGUgcGF0aCBvZiB0aGUgZmlsZSB0aGF0IGhvbGRzIHRoZSB0ZXh0XCIsXG4gICAgICB9KTtcbiAgICAvLyBTbyBpcyBhIGZpbGUgdGhpcyBwcm9jZXNzIG1heSBub3QgcmVhZCAoY2htb2QgMDAwKTogaXQgdXNlZCB0byBjb21lIG91dFxuICAgIC8vIGFzIGFuIGludGVybmFsIHJhdyBFQUNDRVMgKGV4aXQgMSkuIEl0IGlzIHRoZXJlIGFuZCBpcyBhIGZpbGUsIHNvIGFueVxuICAgIC8vIGZhaWx1cmUgdG8gcmVhZCBpdCBpcyBcImNhbm5vdCBiZSByZWFkXCIg4oCUIHRoZSBjYWxsZXIncyB0byBmaXguXG4gICAgdHJ5IHtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBjYW5ub3QgYmUgcmVhZDogJHtwYXRofWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBcImNoZWNrIHRoYXQgdGhlIGZpbGUncyBwZXJtaXNzaW9ucyBsZXQgeW91IHJlYWQgaXQsIG9yIHBhc3MgYW5vdGhlciBmaWxlXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSB0ZXh0ID0gcG9zLmpvaW4oXCIgXCIpO1xuICBpZiAoIXRleHQudHJpbSgpKVxuICAgIGRpZShcbiAgICAgIG8ub3B0aW9uYWwgPyBgJHt2ZXJifTogdGhlIGJvZHkgaXMgZW1wdHlgIDogYCR7dmVyYn06IHRoZSBtZXNzYWdlIGlzIGVtcHR5YCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIG8ub3B0aW9uYWwgPyB7IGhpbnQ6IGBkcm9wIC0tYm9keS1maWxlLy0tc3RkaW4gdG8gY29weSB0aGUgc291cmNlIHZlcnNpb24gaW5zdGVhZGAgfSA6IHt9LFxuICAgICk7XG4gIHJldHVybiB0ZXh0O1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuICB2ZXJiOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKChhd2FpdCByZWFkUHJvc2UodmVyYiwgcG9zLCBmbGFncykpID8/IFwiXCIpLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRoZSB0YWlsIGhhcyBhbHJlYWR5IHJlcG9ydGVkIHRoYXQgaXQgbG9zdCB0aGUgZGFlbW9uIChFNTUpLiBNb2R1bGVcbiAqIHNjb3BlIGJlY2F1c2UgYSB0YWlsIGlzIG9uZSBwcm9jZXNzIGRvaW5nIG9uZSB0aGluZywgYW5kIHRoZSB0d28gaG9va3MgdGhhdFxuICogcmVhZCBpdCBhcmUgaGFuZGVkIHRvIGEgY2xpZW50IHRoYXQgb3ducyBpdHMgb3duIGxvb3AuXG4gKi9cbmxldCBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcblxuLyoqXG4gKiBUaGUgd2F0Y2guIEVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgY2FwIHdpdGggb25lIGxpbmUgbmFtaW5nIHRoZSBuZXh0XG4gKiBhY3QgKGBzcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgKTogcmUtYXJtIE1vbml0b3IsIGdvIHRvIGEgYmFja2dyb3VuZFxuICogYC0tb25jZWAsIG9yIGNvbWUgYmFjayBmcm9tIGEgY2xvc2VkIG9yIGxvc3Qgc2Vzc2lvbiB3aXRoIGBvcGVuIC0tcmVzdG9yZWAuXG4gKiBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOiB0aGUgYWdlbnQgYWxyZWFkeSBrbm93cyB0aGVcbiAqIHNlc3Npb24sIGFuZCB0aGUgbGluZSB3b3VsZCBjb3VudCBhcyBub2lzZSBpbiB0aGUgd2luZG93J3Mgd2FrZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICBvOiB7IG9uY2U6IGJvb2xlYW47IHNpbmNlR2l2ZW46IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGNvbnN0IHJlQXJtID0gc2Vzc2lvbiAhPT0gdW5kZWZpbmVkIHx8IG8uc2luY2VHaXZlbjtcbiAgbGV0IGdyb3VuZGVkID0gby5zaW5jZUdpdmVuO1xuICBjb25zdCBwaW4gPSAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gW1wiLS1zZXNzaW9uXCIsIGJvdW5kSWRdIDogW10pO1xuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZyB9PihcbiAgICB7XG4gICAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgICAvLyBEMTogYSB0YWlsIGdpdmVuIC0tc2Vzc2lvbiBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElOR1xuICAgICAgICAvLyBzZXNzaW9uLCBzbyBub3QgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQgKGluIHRoZSBnYXAsIHNheSkg4oCUIHRoZVxuICAgICAgICAvLyBoYW5kb2ZmIHNheXMgYHRhaWwuY2xvc2VkYCwgbmV2ZXIgYSBzaWxlbnQgcmV0cnktZm9yZXZlci5cbiAgICAgICAgaWYgKGV2ZXJSZXNvbHZlZCB8fCByZUFybSkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgICAgfSxcbiAgICAgIHBhdGg6IFwiL2V2ZW50c1wiLFxuICAgICAgc2luY2UsXG4gICAgICAuLi4oby5lcG9jaCA/IHsgc2luY2VFcG9jaDogby5lcG9jaCB9IDoge30pLFxuICAgICAgY3Vyc29yT2Y6IChldikgPT4gKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiA/IGV2LmlkIDogdW5kZWZpbmVkKSxcbiAgICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAgIC8vIEEgZGlmZmVyZW50IGVwb2NoIG9uIHJlY29ubmVjdCA9IHRoZSBkYWVtb24gcmVzdGFydGVkOyBpZHMgYmVnYW4gYWdhaW4uXG4gICAgICBvbkVwb2NoQ2hhbmdlOiAoZXBvY2gpID0+IEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJlcG9jaC5jaGFuZ2VkXCIsIGVwb2NoIH0pLFxuICAgICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgICAgLy8g4puUIEEgS0VFUEFMSVZFIElTIFBST09GIE9GIExJRkUsIHNvIGl0IGlzIGFsc28gd2hhdCBjbGVhcnMgYSByZXBvcnRlZFxuICAgICAgLy8gZGlzY29ubmVjdGlvbi4gVGhlcmUgaXMgbm8gYG9uQ29ubmVjdGAgaG9vayBhbmQgdGhpcyBpcyB0aGUgaG9uZXN0XG4gICAgICAvLyBzdWJzdGl0dXRlOiB0aGUgZGFlbW9uIG9ubHkgc2VuZHMgY29tbWVudHMgZG93biBhIGxpdmUgc3RyZWFtLlxuICAgICAgb25Db21tZW50OiAoKSA9PiB7XG4gICAgICAgIGlmICghZGlzY29ubmVjdGVkKSByZXR1cm4gXCI6IHNjcmlwdG9yaXVtLWtlZXBhbGl2ZVwiO1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJ0YWlsLnJlY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgICAgLy8g4puUIE9ORSBMSU5FIFBFUiBFUElTT0RFLCBOT1QgUEVSIEFUVEVNUFQuIFRoZSBjbGllbnQgcmVjb25uZWN0cyB3aXRoXG4gICAgICAvLyBiYWNrb2ZmIGZvcmV2ZXIsIHNvIGEgaG9vayB0aGF0IHNwb2tlIGV2ZXJ5IHRpbWUgd291bGQgZW1pdCBhIGxpbmUgZXZlcnlcbiAgICAgIC8vIGZldyBzZWNvbmRzIGZvciBhcyBsb25nIGFzIHRoZSBkYWVtb24gc3RheWVkIGRvd24g4oCUIHdoaWNoIGlzIGhvdyBhXG4gICAgICAvLyB3YXRjaGVyIGdldHMgbXV0ZWQsIGFuZCB0aGVuIG5vYm9keSBoZWFycyB0aGUgbmV4dCByZWFsIHRoaW5nLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBXSFkgVEhJUyBFWElTVFMgQVQgQUxMOiB3aXRob3V0IGl0IGEgREVBRCBkYWVtb24gYW5kIGEgUVVJRVQgb25lIGFyZVxuICAgICAgLy8gdGhlIHNhbWUgdGhpbmcgZnJvbSBvdXQgaGVyZS4gQSBncmFjZWZ1bCBjbG9zZSBlbWl0cyBgY2xvc2VkYCBhbmQgZW5kc1xuICAgICAgLy8gdGhlIHRhaWw7IGEgY3Jhc2gsIGEga2lsbCAtOSBvciBhIHNsZWVwaW5nIGxhcHRvcCBlbWl0cyBub3RoaW5nLCB0aGVcbiAgICAgIC8vIGNsaWVudCByZXRyaWVzIGluIHNpbGVuY2UsIGFuZCB0aGUgYWJzZW5jZSBvZiBldmVudHMgaXMgbm90IGFuIGV2ZW50LiBBXG4gICAgICAvLyB3YXRjaGVyIHdhaXRpbmcgZm9yIHRoZSBodW1hbidzIG5leHQgbWVzc2FnZSB3b3VsZCB3YWl0IGZvcmV2ZXIgYW5kXG4gICAgICAvLyBuZXZlciBsZWFybiBpdCBoYWQgc3RvcHBlZCBsaXN0ZW5pbmcuIChGb3VuZCAyMDI2LTA5LTE0IHdoaWxlIGFuc3dlcmluZ1xuICAgICAgLy8gQ29sZSdzIHF1ZXN0aW9uIGFib3V0IHdoZXRoZXIgYSB0aW1lb3V0IHdvdWxkIG5vdGlmeSBtZS4gSXQgd291bGQgbm90LilcbiAgICAgIG9uRGlzY29ubmVjdDogKHsgY2F1c2UsIHN0YXR1cyB9KSA9PiB7XG4gICAgICAgIGlmIChkaXNjb25uZWN0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHR5cGU6IFwidGFpbC5kaXNjb25uZWN0ZWRcIixcbiAgICAgICAgICBjYXVzZSxcbiAgICAgICAgICAuLi4oc3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IHN0YXR1cyB9IDoge30pLFxuICAgICAgICAgIG5vdGU6IFwicmV0cnlpbmc7IHRoZSBzZXNzaW9uIG1heSBoYXZlIGNsb3NlZCBvciBjcmFzaGVkXCIsXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHNwZWxsOiBcInNjcmlwdG9yaXVtXCIsXG4gICAgICBtb2RlOiBvLm9uY2UgPyBcIm9uY2VcIiA6IFwid2F0Y2hcIixcbiAgICAgIHByZXNlbmNlOiBmYWxzZSxcbiAgICAgIC8vIFRoZSBgY2xvc2VkYCBldmVudCBzYXlzIHdobyBlbmRlZCBpdDsgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzXG4gICAgICAvLyBgYnlgLCBhbmQgYSBodW1hbiBlbmQgdGVsbHMgdGhlIGFnZW50IHRvIHN0b3AgYW5kIG5vdCByZW9wZW4uXG4gICAgICBjbG9zZWRCeTogKGV2KSA9PiAodHlwZW9mIGV2LmJ5ID09PSBcInN0cmluZ1wiID8gZXYuYnkgOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSByZS1hcm0gYWZ0ZXIgdGhlIGVuZCBuZXZlciBzZWVzIGBjbG9zZWRgIChEMSk7IHRoZSBtYW5pZmVzdCdzXG4gICAgICAvLyBgZW5kZWQuYnlgIGlzIHRoZSBzYW1lIGZhY3QsIGFuZCBpdCBvdXRsaXZlcyB0aGUgZGFlbW9uLlxuICAgICAgZ29uZUJ5OiAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gZW5kZWRCeShib3VuZElkKSA6IHVuZGVmaW5lZCksXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQsIG9uY2UsIGVwb2NoIH0pID0+IHRhaWxDb21tYW5kKFtcInRhaWxcIiwgLi4ucGluKCldLCBhdCwgb25jZSwgZXBvY2gpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tcmVzdG9yZVwiLCBib3VuZElkID8/IFwiPGlkPlwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuLy9cbi8vIFRocm91Z2ggdGhlIGhvdXNlJ3Mgb25lIHJlZ2lzdHJ5IChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgKS4gc2NyaXB0b3JpdW0nc1xuLy8gb3duIGRpc3BhdGNoZXIsIGhlbHAgcmVuZGVyZXIgYW5kIGRlY2xhcmF0aW9uIGVtaXR0ZXIg4oCUIGEgY29weSBvZiBnbGFtb3VyJ3Mg4oCUXG4vLyB3ZXJlIGRlbGV0ZWQgd2hlbiBpdCBtb3ZlZCBvbnRvIHRoZSBtb2R1bGUuIGBoZWxwYCwgYHZlcnNpb25gIGFuZCBgc2NoZW1hYFxuLy8gYXJlIHRoZSBtb2R1bGUncyByb3dzOiBkZWNsYXJlZCBhbmQgc3RyaWN0LCBzbyBgdmVyc2lvbiAtLWJvZ3VzYCBpcyByZWZ1c2VkXG4vLyAoaXQgZXhpdGVkIDAgd2hpbGUgYHZlcnNpb25gIHdhcyBhbnN3ZXJlZCBiZWZvcmUgdGhlIHRhYmxlKS5cblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuLyoqIEEgcm93IGFzIHNjcmlwdG9yaXVtIHdyaXRlcyBpdDogdGhlIGhhbmRsZXIgdGFrZXMgYChwb3MsIGZsYWdzLCBzZXNzaW9uKWAsXG4gKiAgYW5kIGBvbmAgYWRhcHRzIGl0IHRvIHRoZSBraXQncyBgcnVuKGludilgLiBBIG51bWJlciByZXR1cm5lZCBpcyB0aGUgZXhpdFxuICogIGNvZGUgKGB0YWlsYCk7IGFueXRoaW5nIGVsc2UgaXMgMC4gKi9cbnR5cGUgUm93ID0gT21pdDxDb21tYW5kU3BlYzxGbGFnPiwgXCJydW5cIiB8IFwicmVqZWN0SGludFwiPiAmIHtcbiAgcnVuOiAocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHVua25vd247XG59O1xuXG4vKiogc2NyaXB0b3JpdW0gZGVjbGFyZXMgbm8gYG11bHRpcGxlYCBmbGFnLCBzbyBldmVyeSB2YWx1ZSBpcyBhIHN0cmluZyBvciBhXG4gKiAgYm9vbGVhbiDigJQgdGhlIGBGbGFnc2AgdGhlIGhhbmRsZXJzIHRha2UuICovXG5jb25zdCBvbiA9XG4gIChoOiBSb3dbXCJydW5cIl0pID0+XG4gIChpbnY6IEludm9jYXRpb248RmxhZz4pOiB1bmtub3duID0+IHtcbiAgICBjb25zdCBmbGFncyA9IGludi5mbGFncyBhcyBGbGFncztcbiAgICByZXR1cm4gaChpbnYucG9zLCBmbGFncywgdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkKTtcbiAgfTtcblxuLyoqIEV2ZXJ5IGZsYWcgcmVqZWN0aW9uJ3MgaGludDogdGhlIG9uZSByZXBhaXIgZm9yIHByb3NlIGluIHdoaWNoIGEgd29yZFxuICogIGhhcHBlbnMgdG8gc3RhcnQgd2l0aCBgLS1gLiAqL1xuY29uc3QgREFTSF9ISU5UID0gXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCI7XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IFJPV1M6IFJvd1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKSwgYWRkaW5nIHBhdGhzOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZCwgd29ya3NwYWNlfTsgdGhlIHdvcmtzcGFjZSBpcyB0aGUgb25lIGZvbGRlciBnaXZlbiwgZWxzZSB0aGUgY3VycmVudCBmb2xkZXIuIC0tdGltZW91dCA8c2Vjb25kcz4gc2V0cyB0aGUgaWRsZSBjbG9zZSAoZGVmYXVsdCAxODAwKTsgLS10aW1lb3V0IDAgc3RhbmRzIHVudGlsIGNsb3NlZFwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIiwgXCJvbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwidGhlIGh1bWFuJ3MgbWVzc2FnZXMgKHdpdGggc2VsZWN0aW9uICsgYWN0aXZlIHBhdGgpIGFzIEpTT04gbGluZXMg4oCUIHdyYXAgd2l0aCBNb25pdG9yOyBpdHMgbGFzdCBsaW5lIG5hbWVzIHRoZSBuZXh0IGFjdFwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBiID0gdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VUYWlsU2luY2UoZmxhZ3Muc2luY2UpIDogeyBzaW5jZTogLTEgfTtcbiAgICAgIHJldHVybiBjbWRUYWlsKHNlc3Npb24sIGIuc2luY2UsIHtcbiAgICAgICAgb25jZTogZmxhZ3Mub25jZSA9PT0gdHJ1ZSxcbiAgICAgICAgc2luY2VHaXZlbjogdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiLFxuICAgICAgICAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tbmV3XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZyb21cIiwgXCJsYWJlbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwicHJvcG9zZSBhIG5ldyB2ZXJzaW9uIGhvbGRpbmcgeW91ciB0ZXh0ICgtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbik7IHdpdGhvdXQgb25lLCBjb3BpZXMgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgYW5kIHByaW50cyBpdHMgcGF0aCB0byBlZGl0XCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSB0eXBlb2YgZmxhZ3MuZnJvbSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlVmVyc2lvbihmbGFncy5mcm9tLCBcIi0tZnJvbVwiKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZWFkUHJvc2UoXCJ2ZXJzaW9uLW5ld1wiLCBbXSwgZmxhZ3MsIHtcbiAgICAgICAgb3B0aW9uYWw6IHRydWUsXG4gICAgICAgIG1pc3NpbmdGaWxlOiBcIm5vdF9mb3VuZFwiLFxuICAgICAgfSk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIC4uLihmcm9tICE9PSB1bmRlZmluZWQgPyB7IGZyb20gfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8geyBsYWJlbDogZmxhZ3MubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odGV4dCAhPT0gdW5kZWZpbmVkID8geyB0ZXh0IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNheVwiLCB0ZXh0OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcInNheVwiKSB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidmVyc2lvbi1kZWxldGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZOXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIHZlcnNpb24gYW5kIGl0cyBmaWxlIChuZXZlciB0aGUgYWN0aXZlIG9uZSDigJQgYWN0aXZhdGUgYW5vdGhlciBmaXJzdClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5kZWxldGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwidmVyc2lvbi1kZWxldGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2tcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInNheSB5b3UgaGF2ZSBzdGFydGVkIHNvbWV0aGluZzsgcHJpbnRzIHRoZSBpZCB0byBmaW5pc2ggaXQgd2l0aFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5zdGFydFwiLCB0ZXh0OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcInRhc2tcIikgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2stc3RhdHVzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInN0YXR1c1wiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNheSB3aGF0IHN0ZXAgYSB0YXNrIGlzIG9uIChmb3Igd29yayB3b3J0aCB3YXRjaGluZylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suc3RhdHVzXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgc3RhdHVzOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIiksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLWRvbmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwib3V0Y29tZVwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgdGFzayBmaW5pc2hlZCwgb3B0aW9uYWxseSBzYXlpbmcgd2hhdCBjYW1lIG9mIGl0XCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IG91dGNvbWUgPSBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suZG9uZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLihvdXRjb21lID8geyBvdXRjb21lIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnJlbW92ZVwiLCBpZDogcG9zWzBdIGFzIHN0cmluZyB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza3MtY2xlYXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiZm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2s7IG91dHN0YW5kaW5nIG9uZXMgYXJlIGxlZnQgYWxvbmVcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrcy5jbGVhclwiIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3JraW5nXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZvclwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBhcmUgc3RpbGwgb24gaXQg4oCUIHNpbGVuY2VzIHRoZSB3YWl0aW5nIG51ZGdlLCBrZWVwcyB0aGUgaHVtYW4ncyBwdWxzZVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBzZWNvbmRzID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLmZvciA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MuZm9yLCBcIndvcmtpbmcgLS1mb3JcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwid29ya2luZ1wiLFxuICAgICAgICAgIC4uLihzZWNvbmRzICE9PSB1bmRlZmluZWQgPyB7IHNlY29uZHMgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwicXVvdGVcIiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcIm5vdGUgYSBwYXNzYWdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbiAoLS1xdW90ZSAnZXhhY3QgdGV4dCc7IHByb3NlOiAtLWJvZHktZmlsZSBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MucXVvdGUgIT09IFwic3RyaW5nXCIgfHwgZmxhZ3MucXVvdGUudHJpbSgpID09PSBcIlwiKVxuICAgICAgICBkaWUoXCJub3RlOiAtLXF1b3RlIGlzIHJlcXVpcmVkIOKAlCB0aGUgZXhhY3QgdGV4dCB0aGUgbm90ZSBpcyBhYm91dFwiLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIHN0YXRlIC0tZnVsbCAodGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBpcyBvbiBkaXNrOyBxdW90ZSBmcm9tIGl0KVwiLFxuICAgICAgICB9KTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZFwiLFxuICAgICAgICAgIHF1b3RlOiBmbGFncy5xdW90ZSxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcIm5vdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBub3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLWZ1bGwgaW5jbHVkZXMgcmVzb2x2ZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3Rlc1wiLFxuICAgICAgICAgIC4uLihmbGFncy5mdWxsID8geyBhbGw6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1lZGl0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInJld3JpdGUgd2hhdCBhIG5vdGUgc2F5cyAoaXRzIHBhc3NhZ2UgaXMgdW5jaGFuZ2VkKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmVkaXRcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3Muc2xpY2UoMSksIGZsYWdzLCBcIm5vdGUtZWRpdFwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1yZXNvbHZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInJlb3BlblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgbm90ZSBkZWFsdCB3aXRoICgtLXJlb3BlbiBwdXRzIGl0IGJhY2spXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVzb2x2ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHJlc29sdmVkOiAhZmxhZ3MucmVvcGVuLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgbm90ZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLnJlbW92ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdzYXZlZCcgZm9yIHRoZSBmaWxlIG9uIGRpc2spOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VhcmNoXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImxpbWl0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInF1ZXJ5XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic2VhcmNoIHRoZSBjb250ZXh0OiBmdXp6eSBvbiBuYW1lcywgZXhhY3QgaW4gdGV4dCDigJQgc2VhcmNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uIG9mIG9wZW4gZG9jdW1lbnRzLCB3aGljaCBncmVwIGNhbm5vdCBzZWVcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5saW1pdCA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MubGltaXQsIFwic2VhcmNoIC0tbGltaXRcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICAgICAgcXVlcnk6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgICAgICAuLi4obGltaXQgIT09IHVuZGVmaW5lZCA/IHsgbGltaXQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwid2hhdCBpcyB3b3J0aCBsb29raW5nIGF0IGluIHRoaXMgc2Vzc2lvbiDigJQgZWFjaCBmaW5kaW5nIG5hbWVzIHRoZSB2ZXJiIHRoYXQgZml4ZXMgaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2N0b3JcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9yZ2V0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKHJlZnVzZWQgd2hpbGUgdGhlIGZpbGUgZXhpc3RzIOKAlCB1c2UgaGlkZSB0byB0YWtlIG9uZSBvdXQgb2YgdGhlIGNvbnRleHQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJmb3JnZXRcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZGFuZ2xpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImxpbmtzIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCBmaWxlLCBsaW5lLCBhbmQgdGhlIHRhcmdldCBhcyB3cml0dGVuXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJkYW5nbGluZ1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbl07XG5cbi8vIOKblCBCVUlMRElORyBUSEUgVEFCTEUgSEFTIE5PIFNJREUgRUZGRUNUUzogYGRlZmluZUNsaWAgb25seSB2YWxpZGF0ZXMgYW5kXG4vLyBpbmRleGVzLCBzbyBhIHdhcmQgb3IgYSB0ZXN0IGNhbiBpbXBvcnQgdGhpcyBtb2R1bGUgYW5kIHJlYWQgdGhlIHRhYmxlLlxuZXhwb3J0IGNvbnN0IGNsaSA9IGRlZmluZUNsaSh7XG4gIG5hbWU6IFwic2NyaXB0b3JpdW1cIixcbiAgc3VtbWFyeTogXCJhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXCIsXG4gIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICBjb21tYW5kczogUk9XUy5tYXAoKHIpID0+ICh7IC4uLnIsIHJ1bjogb24oci5ydW4pLCByZWplY3RIaW50OiBEQVNIX0hJTlQgfSkpLFxuICAvLyBgc2NyaXB0b3JpdW0gLS1zZXNzaW9uIHggc3RhdGVgIHJ1bnMgYHN0YXRlYDsgYSBiYXJlIGAtLWAgbWFrZXMgdGhlIG5leHRcbiAgLy8gdG9rZW4gdGhlIHZlcmIgKGFjYyBBNikuXG4gIGdyYW1tYXI6IFwiZmxhZ3MtYW55d2hlcmVcIixcbiAgdmVyYlBvc2l0aW9uYWw6IFwidmVyYlwiLFxuICB1c2FnZUhpZGVzOiBbXCJzZXNzaW9uXCJdLFxuICB2ZXJzaW9uOiB2ZXJzaW9uSW5mbyxcbiAgaGVscEZvb3RlcjogYCAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIGFueSB2ZXJiIHRoYXQgdGFsa3MgdG8gYSBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuXG4gIEVhY2ggdmVyYiBhY2NlcHRzIG9ubHkgdGhlIGZsYWdzIG9uIGl0cyByb3cuXG5cbiAgT3V0cHV0OiBKU09OIG9uIHN0ZG91dCwgb25lIGRvY3VtZW50IHBlciBhbnN3ZXIg4oCUIGV4Y2VwdCB0YWlsIChvbmUgSlNPTiBsaW5lXG4gIHBlciBldmVudCkgYW5kIGhlbHAgKHByb3NlKS4gRmFpbHVyZXM6IG9uZSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgZXhpdFxuICAyID0gdXNhZ2UsIDEgPSBpbnRlcm5hbCwgNSA9IG5vdCBmb3VuZCwgNiA9IGNvbmZsaWN0LiB0YWlsIHdhaXRzIGZvciBhXG4gIHNlc3Npb24gcmF0aGVyIHRoYW4gZmFpbGluZywgYW5kIGVuZHMgMCB3aGVuIGl0cyBzZXNzaW9uIGNsb3Nlcy4gdGFpbFxuICAke1dJTkRPV19IRUxQfS5gLFxufSk7XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBjbGkudmVyYnM7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBzdHJpbmdbXT4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gIGNsaS5yb3dzLm1hcCgocikgPT4gW3IubmFtZSwgci5hY2NlcHRlZF0pLFxuKTtcbmV4cG9ydCBjb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiBjbGkuZmxhZ3NGb3IodmVyYik7XG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUzogcmVhZG9ubHkgc3RyaW5nW10gPSBjbGkucmVjb2duaXplZEZsYWdzO1xuXG4vLyBgZGlzcGF0Y2hgLCBub3QgdGhlIHJlZ2lzdHJ5J3MgYG1haW5gOiB0aGUga2l0IGRvZXMgbm90IHRyaWFnZSBhIG5vbi1DbGlFcnJvcjtcbi8vIHRoaXMgZG9lcy4gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzO1xuLy8gZXZlcnl0aGluZyBlbHNlIGlzIG91cnMuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgY2xpLmRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgcmVwb3J0ZWQgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgQ0xJJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIFJldHVybnMgdGhlIGNvZGUgcmF0aGVyIHRoYW4gZXhpdGluZ1xuICogKHN0ZG91dCBpcyBhIHBpcGU7IGFuIGV4cGxpY2l0IGV4aXQgdHJ1bmNhdGVzIGl0KSwgYW5kIHRha2VzIG5vIGFyZ3VtZW50c1xuICogKHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBUaGUgbW9kdWxlIGFkZHMgYGhlbHBgLCBgdmVyc2lvbmAgYW5kIGBzY2hlbWFgIHJvd3MgdW5sZXNzIHRoZSBzcGVsbCBkZWZpbmVzXG4gKiBhIHJvdyBvZiB0aGF0IG5hbWUgKGdyYXBldmluZSdzIGB2ZXJzaW9uIC0taHVtYW5gKS4gVGhleSBhcmUgb3JkaW5hcnkgcm93czpcbiAqIGRlY2xhcmVkLCBzdHJpY3QsIGFuZCBnaXZlbiBgZ2xvYmFsRmxhZ3NgIGxpa2UgZXZlcnkgb3RoZXIgcm93LlxuICovXG5cbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBDbGlFcnJvciwgZGllLCByZXBvcnRDbGlFcnJvciwgc2V0Q3VycmVudENvbW1hbmQgfSBmcm9tIFwiLi4vd2lyZS9lcnJvcnNcIjtcblxuLy8g4pSA4pSAIHR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgdHlwZSBGbGFnVHlwZSA9IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjtcblxuLyoqIE9uZSBgcGFyc2VBcmdzYCBvcHRpb24sIHBsdXMgdGhlIGBkZWZhdWx0YCBub2RlJ3MgcGFyc2VyIGFsc28gdGFrZXMuICovXG5leHBvcnQgdHlwZSBPcHRpb25TcGVjID0ge1xuICB0eXBlOiBGbGFnVHlwZTtcbiAgbXVsdGlwbGU/OiBib29sZWFuO1xuICBzaG9ydD86IHN0cmluZztcbiAgZGVmYXVsdD86IHN0cmluZyB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHJlYWRvbmx5IGJvb2xlYW5bXTtcbn07XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnNUYWJsZSA9IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIE9wdGlvblNwZWM+PjtcblxuZXhwb3J0IHR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG5leHBvcnQgdHlwZSBGbGFnVmFsdWUgPSBzdHJpbmcgfCBib29sZWFuIHwgKHN0cmluZyB8IGJvb2xlYW4pW107XG5cbmV4cG9ydCB0eXBlIEludm9jYXRpb248RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSB7XG4gIC8qKiBUaGUgcmVzb2x2ZWQgcm93IG5hbWU6IGBcIm9wZW5cImAsIGBcIm5vZGUgZWRpdFwiYCwgb3IgYFwiXCJgIGZvciBhIHZlcmJsZXNzIHJvb3QuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzcGVsbGluZyB0aGUgY2FsbGVyIHVzZWQg4oCUIGFuIGFsaWFzLCB3aGVuIG9uZSB3YXMgdXNlZC4gKi9cbiAgdG9rZW46IHN0cmluZztcbiAgLyoqIFBvc2l0aW9uYWxzIGFmdGVyIHRoZSBwYXRoLiAqL1xuICBwb3M6IHN0cmluZ1tdO1xuICAvKiogRmxhZ3MgZ2l2ZW4sIHBsdXMgdGhlIGRlZmF1bHRzIG9mIHRoZSBmbGFncyB0aGlzIHJvdyBhY2NlcHRzLiAqL1xuICBmbGFnczogUGFydGlhbDxSZWNvcmQ8RiwgRmxhZ1ZhbHVlPj47XG59O1xuXG5leHBvcnQgdHlwZSBDb21tYW5kU3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIGBcIm9wZW5cImA7IG9uZSBzcGFjZSBtZWFucyBvbmUgbGV2ZWwgb2YgbmVzdGluZzogYFwibm9kZSBlZGl0XCJgLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFYWNoIGFsaWFzIGlzIGRpc3BhdGNoYWJsZSwgbGlzdGVkIGluIGB2ZXJic2AsIGFuZCBnZXRzIGl0cyBvd24gZGVjbGFyZWRcbiAgICogIHJvdy4gQW4gYWxpYXMgb2YgYSBuZXN0ZWQgcm93IG11c3Qgc2hhcmUgaXRzIGdyb3VwOiBgXCJub2RlIGNoYW5nZVwiYC4gKi9cbiAgYWxpYXNlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhpcyByb3cncyBvd24gZmxhZ3M7IGBnbG9iYWxGbGFnc2AgYXJlIGFkZGVkIHRvIHRoZW0uICovXG4gIGZsYWdzOiByZWFkb25seSBGW107XG4gIC8qKiBBcml0eSBpcyBlbmZvcmNlZCBmcm9tIHRoaXMsIGFuZCBpdCBpcyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcy4gKi9cbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIC8qKiBPbmUgbGluZSBmb3IgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBBZGRlZCBhcyB0aGUgYGhpbnRgIG9mIHRoaXMgcm93J3MgZmxhZyByZWplY3Rpb25zLiAqL1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICAvKiogYGZhbHNlYCBoYW5kcyBub2RlJ3Mgb3duIFwiVW5leHBlY3RlZCBhcmd1bWVudFwiIHJlZnVzYWwgYW55IHBvc2l0aW9uYWwuICovXG4gIGFsbG93UG9zaXRpb25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogRmxhZy1kZXBlbmRlbnQgYXJpdHkgKGltYWdvIGBoYW5kb2ZmIC0tY2xlYXJgLCBtaW5kLW1hcHBlciBgLS10b3wtLWNsZWFyYClcbiAgICogYW5kIGFueSBvdGhlciBjb21iaW5hdGlvbiBydWxlLiBSdW5zIGFmdGVyIHRoZSBhcml0eSBjaGVjazsgYSByZXR1cm5lZFxuICAgKiBzdHJpbmcgaXMgcmVmdXNlZCBhcyBhIHVzYWdlIGVycm9yIG5hbWluZyB0aGlzIHJvdy4g4pqgIFRoZSBkZWNsYXJhdGlvblxuICAgKiBjYW5ub3QgZXhwcmVzcyBzdWNoIGEgcnVsZTogYSBwb3NpdGlvbmFsIHRoYXQgYC0tY2xlYXJgIG1ha2VzIHVubmVjZXNzYXJ5XG4gICAqIGNhbiBvbmx5IGJlIGRlY2xhcmVkIGByZXF1aXJlZDogZmFsc2VgLCBhbmQgdGhpcyBob29rIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgKi9cbiAgY2hlY2s/OiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIG51bWJlciBpcyB0aGUgZXhpdCBjb2RlOyBhbnl0aGluZyBlbHNlIG1lYW5zIDAuICovXG4gIHJ1bjogKGludjogSW52b2NhdGlvbjxGPikgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBBIHZlcmJsZXNzIENMSSdzIG9uZSByb3cgKGRpZ2VzdGlmeSkuIGBwYXRoOiBbXWAgaW4gdGhlIGRlY2xhcmF0aW9uLiAqL1xuZXhwb3J0IHR5cGUgUm9vdFNwZWM8RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSBPbWl0PENvbW1hbmRTcGVjPEY+LCBcIm5hbWVcIiB8IFwiYWxpYXNlc1wiPjtcblxuLyoqXG4gKiBXaGVyZSBhIGdyb3VwJ3Mgc3ViLXZlcmIgaXMgZm91bmQuXG4gKiAtIGBhZGphY2VudGAgKGRlZmF1bHQpOiB0aGUgdG9rZW4gcmlnaHQgYWZ0ZXIgdGhlIGdyb3VwIChgbm9kZSBlZGl0IFhgKS5cbiAqIC0gYGZpcnN0LXBvc2l0aW9uYWxgOiB0aGUgZmlyc3QgdG9rZW4gYWZ0ZXIgdGhlIGdyb3VwIHRoYXQgaXMgbmVpdGhlciBhIGZsYWdcbiAqICAgbm9yIGEgc3RyaW5nIGZsYWcncyB2YWx1ZSwgc28gZmxhZ3MgbWF5IGNvbWUgZmlyc3Q6XG4gKiAgIGBkb2MgLS1wcm9qZWN0IFAgZGVsZXRlIEQxIC0tZm9yY2VgIHJlc29sdmVzIHRvIGBkb2MgZGVsZXRlYCAobWluZC1tYXBwZXIpLlxuICogICBUaGUgc2NhbiBzdG9wcyBhdCBhIGJhcmUgYC0tYCwgd2hpY2ggaXMgdGhlIGVzY2FwZSBoYXRjaCBmb3IgYSBwb3NpdGlvbmFsXG4gKiAgIGxpdGVyYWxseSBuYW1lZCBsaWtlIGEgc3ViLXZlcmI6IGBkb2MgLS0gZGVsZXRlYCByZWFkcyB0aGUgZG9jIFwiZGVsZXRlXCIuXG4gKi9cbmV4cG9ydCB0eXBlIEdyb3VwU3BlYyA9IHsgc3ViVmVyYkF0PzogXCJhZGphY2VudFwiIHwgXCJmaXJzdC1wb3NpdGlvbmFsXCIgfTtcblxuZXhwb3J0IHR5cGUgQ2xpU3BlYzxPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPiA9IHtcbiAgLyoqIGBcImJvdW50eVwiYCwgdXNlZCBpbiBtZXNzYWdlcyBhbmQgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSByZW5kZXJlZCBoZWxwJ3MgZmlyc3QgbGluZTogYCR7bmFtZX0g4oCUICR7c3VtbWFyeX1gLiAqL1xuICBzdW1tYXJ5Pzogc3RyaW5nO1xuICAvKiogVGhlIGxpdGVyYWwgYENMSV9PUFRJT05TYCBvYmplY3QuICovXG4gIG9wdGlvbnM6IE87XG4gIGNvbW1hbmRzPzogcmVhZG9ubHkgQ29tbWFuZFNwZWM8a2V5b2YgTyAmIHN0cmluZz5bXTtcbiAgLyoqXG4gICAqIEEgdmVyYmxlc3MgQ0xJJ3Mgcm93LiBSZXNlcnZlZCB0b2tlbnMgYXMgYGFyZ3ZbMF1gIHN0aWxsIHNlbGVjdCB0aGVpciByb3dzXG4gICAqIChgaGVscGAsIGB2ZXJzaW9uYCwgYHNjaGVtYWAsIGFueSBgY29tbWFuZHNgLCBhbmQgdGhlIGludGVyY2VwdG9ycyk7IGV2ZXJ5XG4gICAqIG90aGVyIGFyZ3YsIHRoZSBlbXB0eSBvbmUgaW5jbHVkZWQsIGJlbG9uZ3MgdG8gdGhlIHJvb3QuIEEgcG9zaXRpb25hbCB0aGF0XG4gICAqIGhhcHBlbnMgdG8gc3BlbGwgYSByZXNlcnZlZCB0b2tlbiBnb2VzIGFmdGVyIGEgYmFyZSBgLS1gLlxuICAgKi9cbiAgcm9vdD86IFJvb3RTcGVjPGtleW9mIE8gJiBzdHJpbmc+O1xuICAvKiogQWNjZXB0ZWQgYnkgZXZlcnkgcm93LCBieSBjb250cmFjdCAoZ3JhcGV2aW5lJ3MgYC0tYXNgL2AtLWZyb21gKS4gKi9cbiAgZ2xvYmFsRmxhZ3M/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgZ3JhbW1hcj86IFwidmVyYi1maXJzdFwiIHwgXCJmbGFncy1hbnl3aGVyZVwiO1xuICAvKiogUGVyLWdyb3VwIHN1Yi12ZXJiIHBsYWNlbWVudCwga2V5ZWQgYnkgdGhlIGdyb3VwIHRva2VuIChgXCJkb2NcImApLiAqL1xuICBncm91cHM/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBHcm91cFNwZWM+PjtcbiAgLyoqIFRoZSByb290IHJvdydzIHBvc2l0aW9uYWwgbmFtZSBpbiBgc2NoZW1hYCAoYFwiY29tbWFuZFwiYDsgZ2xhbW91cjogYFwidmVyYlwiYCkuICovXG4gIHZlcmJQb3NpdGlvbmFsPzogc3RyaW5nO1xuICAvKiogRmxhZ3MgbGVmdCBvZmYgZXZlcnkgdXNhZ2UgbGluZSAoZ2xhbW91cidzIHBlci12ZXJiIGBzZXNzaW9uYCkuICovXG4gIHVzYWdlSGlkZXM/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgLyoqIFRoZSBgdmVyc2lvbmAgcm93J3MgcGF5bG9hZCwgYHtuYW1lLCB2ZXJzaW9ufWAuICovXG4gIHZlcnNpb246ICgpID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gIC8qKiBSZXBsYWNlcyB0aGUgcmVuZGVyZWQgaGVscCAoZ3JhcGV2aW5lKS4gKi9cbiAgaGVscD86ICgpID0+IHN0cmluZztcbiAgLyoqIEFwcGVuZGVkIGJlbG93IHRoZSByZW5kZXJlZCByb3dzLiAqL1xuICBoZWxwRm9vdGVyPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgRGVjbGFyZWRBcmcgPSB7IG5hbWU6IHN0cmluZzsgdHlwZTogRmxhZ1R5cGU7IHN0YXR1czogXCJ2YWxpZFwiIH07XG5leHBvcnQgdHlwZSBEZWNsYXJlZENvbW1hbmQgPSB7XG4gIHBhdGg6IHN0cmluZ1tdO1xuICBhcmdzOiBEZWNsYXJlZEFyZ1tdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbn07XG5leHBvcnQgdHlwZSBEZWNsYXJhdGlvbiA9IHtcbiAgZm9ybWF0VmVyc2lvbjogXCIwXCI7XG4gIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiO1xuICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogc3RyaW5nW10gfTtcbiAgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdO1xufTtcblxuLyoqIEEgcm93IGFzIHRoZSBtb2R1bGUgaG9sZHMgaXQsIGZvciB0ZXN0cyBhbmQgd2FyZHMuICovXG5leHBvcnQgdHlwZSBSb3dWaWV3ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhlIHJvdydzIG93biBmbGFncywgYXMgZGVjbGFyZWQuICovXG4gIGZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIE93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2AsIGluIG9wdGlvbnMtdGFibGUgb3JkZXIuICovXG4gIGFjY2VwdGVkOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBgdHJ1ZWAgZm9yIGEgYGhlbHBgL2B2ZXJzaW9uYC9gc2NoZW1hYCByb3cgdGhlIG1vZHVsZSBhZGRlZC4gKi9cbiAgYXV0bzogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIENsaSA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogRW52ZWxvcGUgb24gZmFpbHVyZSwgcmV0dXJucyB0aGUgZXhpdCBjb2RlLiBGb3IgdGhlIHNwZWxsJ3MgYHJ1bigpYC4gKi9cbiAgbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPjtcbiAgLyoqIFRocm93cyBgQ2xpRXJyb3JgLCBmb3IgYSBzcGVsbCB3aG9zZSBtYWluIGRvZXMgaXRzIG93biB0cmlhZ2UuICovXG4gIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICBkZWNsYXJhdGlvbigpOiBEZWNsYXJhdGlvbjtcbiAgcmVuZGVySGVscCgpOiBzdHJpbmc7XG4gIC8qKiBBIHJvdydzIHVzYWdlIGxpbmUgKGBcImNsb3NlIDxpZD4gWy0tZm9yY2VdXCJgKTsgYFwiXCJgIGZvciBhbiB1bmtub3duIHBhdGguICovXG4gIHVzYWdlT2YocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogRXZlcnkgZmlyc3QgdG9rZW4gdGhhdCBkaXNwYXRjaGVzOiB2ZXJicywgYWxpYXNlcyBhbmQgZ3JvdXAgdG9rZW5zLiAqL1xuICB2ZXJiczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmdWxsIHBhdGggdGhhdCBkaXNwYXRjaGVzLCBhbGlhc2VzIGluY2x1ZGVkIChgXCJub2RlIGVkaXRcImApLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIHJvdydzIGFjY2VwdGVkIHNldCBhcyBgLS14YCBzcGVsbGluZ3MsIHNvcnRlZC4gYFwiXCJgIGlzIHRoZSByb290LiAqL1xuICBmbGFnc0ZvcihwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZsYWcgaW4gdGhlIG9wdGlvbnMgdGFibGUsIGFzIGAtLXhgLCBpbiB0YWJsZSBvcmRlci4gKi9cbiAgcmVjb2duaXplZEZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcm93czogcmVhZG9ubHkgUm93Vmlld1tdO1xufTtcblxuLy8g4pSA4pSAIGludGVybmFscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxudHlwZSBSb3cgPSBSb3dWaWV3ICYge1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICBhbGxvd1Bvc2l0aW9uYWxzOiBib29sZWFuO1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGNoZWNrOiBjLmNoZWNrIGFzIFJvd1tcImNoZWNrXCJdLFxuICAgICAgcnVuOiBjLnJ1biBhcyBSb3dbXCJydW5cIl0sXG4gICAgfTtcbiAgfTtcblxuICBjb25zdCByb3dzOiBSb3dbXSA9IChzcGVjLmNvbW1hbmRzID8/IFtdKS5tYXAoKGMpID0+IHRvUm93KGMgYXMgQ29tbWFuZFNwZWMsIGZhbHNlKSk7XG5cbiAgLy8gVGhlIGF1dG8gcm93cy4gQWRkZWQgbGFzdCwgaW4gdGhpcyBvcmRlciwgdW5sZXNzIHRoZSBzcGVsbCBoYXMgaXRzIG93bi5cbiAgY29uc3QgY2xpID0ge30gYXMgQ2xpO1xuICBjb25zdCBhdXRvUm93czogQ29tbWFuZFNwZWNbXSA9IFtcbiAgICB7XG4gICAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3Mge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVwiLFxuICAgICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHByaW50SnNvbihhd2FpdCBzcGVjLnZlcnNpb24oKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShjbGkuZGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJoZWxwXCIsXG4gICAgICBmbGFnczogW10sXG4gICAgICBwb3NpdGlvbmFsczogW10sXG4gICAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXCIsXG4gICAgICBydW46ICgpID0+IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGNsaS5yZW5kZXJIZWxwKCk7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHRleHQuZW5kc1dpdGgoXCJcXG5cIikgPyB0ZXh0IDogYCR7dGV4dH1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgXTtcbiAgZm9yIChjb25zdCBhIG9mIGF1dG9Sb3dzKSB7XG4gICAgaWYgKCFyb3dzLnNvbWUoKHIpID0+IHIubmFtZSA9PT0gYS5uYW1lKSkgcm93cy5wdXNoKHRvUm93KGEsIHRydWUpKTtcbiAgfVxuXG4gIGNvbnN0IHJvb3RSb3c6IFJvdyB8IHVuZGVmaW5lZCA9XG4gICAgc3BlYy5yb290ID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB0b1Jvdyh7IC4uLihzcGVjLnJvb3QgYXMgUm9vdFNwZWMpLCBuYW1lOiBcIlwiIH0sIGZhbHNlKTtcblxuICAvLyBJbmRleCBldmVyeSBzcGVsbGluZywgYW5kIGNoZWNrIHRoZSB0YWJsZSBpcyB3ZWxsIGZvcm1lZC5cbiAgY29uc3QgYnlUb2tlbiA9IG5ldyBNYXA8c3RyaW5nLCBSb3c+KCk7XG4gIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgZm9yIChjb25zdCB0IG9mIFtyLm5hbWUsIC4uLnIuYWxpYXNlc10pIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gdC5zcGxpdChcIiBcIik7XG4gICAgICBpZiAodC50cmltKCkgIT09IHQgfHwgcGFydHMubGVuZ3RoID4gMiB8fCBwYXJ0cy5zb21lKChwKSA9PiBwID09PSBcIlwiIHx8IHAuc3RhcnRzV2l0aChcIi1cIikpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBiYWQgY29tbWFuZCBuYW1lIFwiJHt0fVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAodCAhPT0gci5uYW1lICYmIHBhcnRzLmxlbmd0aCAhPT0gci5uYW1lLnNwbGl0KFwiIFwiKS5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3QgbmVzdCBsaWtlIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPT09IDIgJiYgdCAhPT0gci5uYW1lICYmIHBhcnRzWzBdICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpWzBdKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBhbGlhcyBcIiR7dH1cIiBtdXN0IHNoYXJlIHRoZSBncm91cCBvZiBcIiR7ci5uYW1lfVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAoYnlUb2tlbi5oYXModCkpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBcIiR7dH1cIiBpcyBkZWZpbmVkIHR3aWNlYCk7XG4gICAgICBieVRva2VuLnNldCh0LCByKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc3Vic09mID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IHQgb2YgYnlUb2tlbi5rZXlzKCkpIHtcbiAgICBjb25zdCBbZ3JvdXAsIHN1Yl0gPSB0LnNwbGl0KFwiIFwiKTtcbiAgICBpZiAoZ3JvdXAgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgc3Vic09mLnNldChncm91cCwgWy4uLihzdWJzT2YuZ2V0KGdyb3VwKSA/PyBbXSksIHN1Yl0pO1xuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IGcgb2YgT2JqZWN0LmtleXMoc3BlYy5ncm91cHMgPz8ge30pKSB7XG4gICAgaWYgKCFzdWJzT2YuaGFzKGcpKSB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ3JvdXAgXCIke2d9XCIgaGFzIG5vIHN1Yi12ZXJic2ApO1xuICB9XG5cbiAgY29uc3QgcGF0aHMgPSBbLi4uYnlUb2tlbi5rZXlzKCldO1xuICBjb25zdCB2ZXJicyA9IFsuLi5uZXcgU2V0KHBhdGhzLm1hcCgocCkgPT4gcC5zcGxpdChcIiBcIilbMF0gYXMgc3RyaW5nKSldO1xuXG4gIGNvbnN0IHJvd0ZvciA9IChwYXRoOiBzdHJpbmcpOiBSb3cgfCB1bmRlZmluZWQgPT4gKHBhdGggPT09IFwiXCIgPyByb290Um93IDogYnlUb2tlbi5nZXQocGF0aCkpO1xuICBjb25zdCBmbGFnc0ZvciA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICAgIFsuLi4ocm93Rm9yKHBhdGgpPy5hY2NlcHRlZCA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcbiAgY29uc3QgbGFiZWwgPSAocjogUm93KTogc3RyaW5nID0+IHIubmFtZSB8fCBjbGlOYW1lO1xuXG4gIC8qKlxuICAgKiBBIHZlcmJsZXNzIHJvb3QncyByZWplY3Rpb24gYGNob2ljZXNgOiBpdHMgb3duIGZsYWdzIFBMVVMgdGhlIGludGVyY2VwdG9ycyxcbiAgICogYmVjYXVzZSB0aGUgZGVjbGFyYXRpb24gcHVibGlzaGVzIGJvdGggYXQgYHBhdGg6IFtdYCBhbmQgdGhlIHJvb3QgYW5zd2Vyc1xuICAgKiBib3RoICh0aGUgaW50ZXJjZXB0b3JzIGFzIGBhcmd2WzBdYCkuIExlYXZpbmcgdGhlIGludGVyY2VwdG9ycyBvdXQgbWFkZVxuICAgKiBvbmUgcHJvY2VzcyBzYXkgdHdvIHRoaW5ncyBhYm91dCBpdHMgcm9vdCDigJQgYWNjJ3MgY2Vuc3VzIHJlYWQgYC0taGVscGAsXG4gICAqIGAtaGAsIGAtLXZlcnNpb25gIGFuZCBgLVZgIGFzIGRlY2xhcmVkLW5vdC1hY2NlcHRlZC4gTG9uZyBzcGVsbGluZ3MgZmlyc3RcbiAgICogKHNvcnRlZCksIHRoZW4gdGhlIHNob3J0czogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0XG4gICAqIHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcuXG4gICAqL1xuICBjb25zdCByb290Q2hvaWNlczogc3RyaW5nW10gPSAoKCkgPT4ge1xuICAgIGNvbnN0IGFsbCA9IFsuLi5mbGFnc0ZvcihcIlwiKSwgLi4uSU5URVJDRVBUT1JfQ0hPSUNFU107XG4gICAgY29uc3QgbG9uZyA9IGFsbC5maWx0ZXIoKGYpID0+IGYuc3RhcnRzV2l0aChcIi0tXCIpKS5zb3J0KCk7XG4gICAgcmV0dXJuIFsuLi5sb25nLCAuLi5hbGwuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLS1cIikpXTtcbiAgfSkoKTtcblxuICAvLyDilIDilIAgaGVscCDilIDilIBcblxuICBjb25zdCByZW5kZXJQb3NpdGlvbmFsID0gKHA6IFBvc2l0aW9uYWxTcGVjKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBpbm5lciA9IHAudmFyaWFkaWMgPyBgJHtwLm5hbWV9Li4uYCA6IHAubmFtZTtcbiAgICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbiAgfTtcbiAgY29uc3QgcmVuZGVyRmxhZyA9IChrOiBzdHJpbmcpOiBzdHJpbmcgPT5cbiAgICBzcGVjLm9wdGlvbnNba10/LnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG4gIGNvbnN0IHVzYWdlTGluZSA9IChyOiBSb3cpOiBzdHJpbmcgPT5cbiAgICBbXG4gICAgICBsYWJlbChyKSxcbiAgICAgIC4uLnIucG9zaXRpb25hbHMubWFwKHJlbmRlclBvc2l0aW9uYWwpLFxuICAgICAgLi4uci5mbGFncy5maWx0ZXIoKGspID0+ICFoaWRlcy5oYXMoaykpLm1hcChyZW5kZXJGbGFnKSxcbiAgICBdLmpvaW4oXCIgXCIpO1xuICBjb25zdCBleHBlY3RzID0gKHI6IFJvdyk6IHN0cmluZyA9PiBgZXhwZWN0czogJHt1c2FnZUxpbmUocil9YDtcblxuICBjb25zdCByZW5kZXJIZWxwID0gKCk6IHN0cmluZyA9PiB7XG4gICAgaWYgKHNwZWMuaGVscCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gc3BlYy5oZWxwKCk7XG4gICAgY29uc3QgbGlzdGVkID0gWy4uLihyb290Um93ID8gW3Jvb3RSb3ddIDogW10pLCAuLi5yb3dzXTtcbiAgICBjb25zdCBsaW5lcyA9IGxpc3RlZC5tYXAoKHIpID0+IFt1c2FnZUxpbmUociksIHIuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLmxpbmVzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gICAgY29uc3QgYm9keSA9IGxpbmVzXG4gICAgICAubWFwKChbdSwgZF0pID0+XG4gICAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gc3BlYy5zdW1tYXJ5ID8gYCR7Y2xpTmFtZX0g4oCUICR7c3BlYy5zdW1tYXJ5fWAgOiBjbGlOYW1lO1xuICAgIGNvbnN0IHRva2VucyA9IGAgICR7SU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OYDtcbiAgICByZXR1cm4gYCR7aGVhZH1cXG5cXG4ke2JvZHl9XFxuJHt0b2tlbnN9JHtzcGVjLmhlbHBGb290ZXIgPyBgXFxuXFxuJHtzcGVjLmhlbHBGb290ZXJ9YCA6IFwiXCJ9YDtcbiAgfTtcblxuICAvLyDilIDilIAgdGhlIGRlY2xhcmF0aW9uIOKUgOKUgFxuXG4gIGNvbnN0IGRlY2xhcmF0aW9uID0gKCk6IERlY2xhcmF0aW9uID0+IHtcbiAgICBjb25zdCBhcmcgPSAoazogc3RyaW5nKTogRGVjbGFyZWRBcmcgPT4gKHtcbiAgICAgIG5hbWU6IGAtLSR7a31gLFxuICAgICAgdHlwZTogKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS50eXBlLFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXRoOiBbXSxcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgIC4uLklOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICAuLi4ocm9vdFJvdyA/IHJvb3RSb3cuYWNjZXB0ZWQubWFwKGFyZykgOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHBvc2l0aW9uYWxzOiByb290Um93XG4gICAgICAgICAgPyByb290Um93LnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSlcbiAgICAgICAgICA6IFt7IG5hbWU6IHNwZWMudmVyYlBvc2l0aW9uYWwgPz8gXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiB0LnNwbGl0KFwiIFwiKSxcbiAgICAgICAgICBhcmdzOiByLmFjY2VwdGVkLm1hcChhcmcpLFxuICAgICAgICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzY2hlbWFSb3cgPSBieVRva2VuLmdldChcInNjaGVtYVwiKSBhcyBSb3c7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW3NjaGVtYVJvdy5uYW1lXSB9LFxuICAgICAgY29tbWFuZHMsXG4gICAgfTtcbiAgfTtcblxuICAvLyDilIDilIAgZGlzcGF0Y2gg4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSBpbmRleCBvZiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmcgZmxhZydzXG4gICAqIHZhbHVlLCB3YWxraW5nIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsOiBgLS1rIHZgIGNvbnN1bWVzIGB2YCB3aGVuIGBrYCBpcyBhXG4gICAqIHN0cmluZyBmbGFnLCBgLS1rPXZgIGNvbnN1bWVzIG5vdGhpbmcsIGAtcyB2YCBsaWtld2lzZSBieSB0aGUgc2hvcnQncyB0eXBlLlxuICAgKiBBdCBhIGJhcmUgYC0tYDogYC0xYCB3aGVuIGBzdG9wQXRUZXJtaW5hdG9yYCwgZWxzZSB0aGUgaW5kZXggYWZ0ZXIgaXQuXG4gICAqL1xuICBjb25zdCBzY2FuUG9zaXRpb25hbCA9IChhcmdzOiBzdHJpbmdbXSwgc3RvcEF0VGVybWluYXRvcjogYm9vbGVhbik6IG51bWJlciA9PiB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBhID0gYXJnc1tpXSBhcyBzdHJpbmc7XG4gICAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gc3RvcEF0VGVybWluYXRvciB8fCBpICsgMSA+PSBhcmdzLmxlbmd0aCA/IC0xIDogaSArIDE7XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNwZWMub3B0aW9uc1thLnNsaWNlKDIpXT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpICYmIGEubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBrZXkgPSBhLmxlbmd0aCA9PT0gMiA/IHNob3J0VG9LZXkuZ2V0KGEuc2xpY2UoMSkpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgc3BlYy5vcHRpb25zW2tleV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIGNvbnN0IHdpdGhvdXQgPSAoYXJnczogc3RyaW5nW10sIGk6IG51bWJlcik6IHN0cmluZ1tdID0+IFtcbiAgICAuLi5hcmdzLnNsaWNlKDAsIGkpLFxuICAgIC4uLmFyZ3Muc2xpY2UoaSArIDEpLFxuICBdO1xuXG4gIGNvbnN0IG5vQ29tbWFuZCA9ICgpOiBuZXZlciA9PlxuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VgLFxuICAgIH0pO1xuXG4gIC8qKiBBIHZlcmIgY2FuZGlkYXRlIGFuZCB0aGUgYXJncyBhZnRlciBpdCwgdG8gYSByb3cgYW5kIHRoYXQgcm93J3MgYXJncy4gKi9cbiAgY29uc3QgcmVzb2x2ZSA9IChjYW5kOiBzdHJpbmcsIHJlc3Q6IHN0cmluZ1tdKTogeyByb3c6IFJvdzsgdG9rZW46IHN0cmluZzsgYXJnczogc3RyaW5nW10gfSA9PiB7XG4gICAgY29uc3Qgc3VicyA9IHN1YnNPZi5nZXQoY2FuZCk7XG4gICAgaWYgKHN1YnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXQgPSBzcGVjLmdyb3Vwcz8uW2NhbmRdPy5zdWJWZXJiQXQgPz8gXCJhZGphY2VudFwiO1xuICAgICAgbGV0IGkgPSAtMTtcbiAgICAgIGlmIChhdCA9PT0gXCJhZGphY2VudFwiKSB7XG4gICAgICAgIGNvbnN0IG5leHQgPSByZXN0WzBdO1xuICAgICAgICBpID0gbmV4dCAhPT0gdW5kZWZpbmVkICYmICFuZXh0LnN0YXJ0c1dpdGgoXCItXCIpID8gMCA6IC0xO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaSA9IHNjYW5Qb3NpdGlvbmFsKHJlc3QsIHRydWUpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3ViID0gaSA+PSAwID8gKHJlc3RbaV0gYXMgc3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZ1bGwgPSBzdWIgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGJ5VG9rZW4uZ2V0KGAke2NhbmR9ICR7c3VifWApO1xuICAgICAgaWYgKGZ1bGwgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4geyByb3c6IGZ1bGwsIHRva2VuOiBgJHtjYW5kfSAke3N1Yn1gLCBhcmdzOiB3aXRob3V0KHJlc3QsIGkpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBvd24gPSBieVRva2VuLmdldChjYW5kKTtcbiAgICAgIGlmIChvd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcm93OiBvd24sIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gICAgICBjb25zdCBleHRyYSA9IHsgY2hvaWNlczogWy4uLnN1YnNdLCBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgIH07XG4gICAgICBpZiAoc3ViID09PSB1bmRlZmluZWQpIGRpZShgJHtjYW5kfTogZXhwZWN0ZWQgYSBzdWItY29tbWFuZGAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgICAgZGllKGB1bmtub3duICR7Y2FuZH0gc3ViLWNvbW1hbmQ6IFwiJHtzdWJ9XCJgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICB9XG4gICAgY29uc3Qgcm93ID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoYHVua25vd24gY29tbWFuZCBcIiR7Y2FuZH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJvdywgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgfTtcblxuICAvKipcbiAgICogQ29udHJhY3QgNSdzIGAtLWAgbWFkZSB0aGUgY2FsbGVyJ3MgZmxhZyBURVhUOyBzYXkgc28gKGMxLFxuICAgKiBgZG9jcy9pdGVtcy90ZXJtaW5hdG9yLWVhdHMtc2Vzc2lvbi1rZXkubWRgKS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHNcbiAgICogYSBmbGFnIHRoaXMgcm93IGFjY2VwdHMg4oCUIGAtLWtgLCBgLS1rPXZgLCBvciB0aGUgc2hvcnQgYC1zYCBvZiBhbiBhY2NlcHRlZFxuICAgKiBga2AsIGdsb2JhbHMgaW5jbHVkZWQg4oCUIGlzIG5hbWVkIGluIE9ORSBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIsIHdpdGhcbiAgICogdGhlIG1vdmUgdGhhdCByZWNvdmVycyBpdC4gU3Rkb3V0IGFuZCB0aGUgZXhpdCBjb2RlIGRvIG5vdCBjaGFuZ2UsIGFuZCB0aGVcbiAgICogcm93IHN0aWxsIHJ1bnM6IHRleHQgY29udGFpbmluZyBhIGZsYWcgbmFtZSBpcyBsZWdpdGltYXRlLCB3aGljaCBpcyB3aGF0XG4gICAqIGAtLWAgaXMgZm9yLiBBIHRva2VuIHRoZSByb3cgZG9lcyBub3QgYWNjZXB0IGlzIGp1c3QgdGV4dCwgYW5kIHNheXMgbm90aGluZy5cbiAgICpcbiAgICog4pqgIENhbGxlZCBvbmx5IG9uY2UgZXZlcnkgcmVmdXNhbCBoYXMgcGFzc2VkLCBzbyBhIHJlZnVzZWQgaW52b2NhdGlvbidzXG4gICAqIHN0ZGVyciBpcyBzdGlsbCBleGFjdGx5IG9uZSBlbnZlbG9wZS4gVGhlIGAjIGAgcHJlZml4IGlzIHRoZSBob3VzZSdzXG4gICAqIHN1Y2Nlc3MtcGF0aCBzdGRlcnIgZm9ybSAoYCMgd2FybmluZzpgIGluIG1pbmQtbWFwcGVyLCBgIyBwaW5uZWQgYm9hcmRgLFxuICAgKiBgIyDihpIgY2hhbm5lbGApOiBhbiBlbnZlbG9wZSByZWFkZXIgbG9va3MgZm9yIGEgYHtgIGxpbmUgYW5kIHNraXBzIGl0LlxuICAgKi9cbiAgY29uc3Qgd2FybkRlbW90ZWQgPSAoXG4gICAgcm93OiBSb3csXG4gICAgYWNjZXB0ZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gICAgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBlbmQgPSB0b2tlbnM/LmZpbmRJbmRleCgodCkgPT4gdC5raW5kID09PSBcIm9wdGlvbi10ZXJtaW5hdG9yXCIpID8/IC0xO1xuICAgIGlmICh0b2tlbnMgPT09IHVuZGVmaW5lZCB8fCBlbmQgPCAwKSByZXR1cm47XG4gICAgY29uc3QgZGVtb3RlZDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rZW5zLnNsaWNlKGVuZCArIDEpKSB7XG4gICAgICBpZiAodC5raW5kICE9PSBcInBvc2l0aW9uYWxcIikgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gdC52YWx1ZTtcbiAgICAgIGxldCBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICh2LnN0YXJ0c1dpdGgoXCItLVwiKSkga2V5ID0gdi5zbGljZSgyKS5zcGxpdChcIj1cIilbMF07XG4gICAgICBlbHNlIGlmICh2Lmxlbmd0aCA9PT0gMiAmJiB2LnN0YXJ0c1dpdGgoXCItXCIpKSBrZXkgPSBzaG9ydFRvS2V5LmdldCh2LnNsaWNlKDEpKTtcbiAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBrZXkgIT09IFwiXCIgJiYgYWNjZXB0ZWQuaGFzKGtleSkpIGRlbW90ZWQucHVzaCh2KTtcbiAgICB9XG4gICAgaWYgKGRlbW90ZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgd2hpY2ggPSBkZW1vdGVkLmpvaW4oXCIsIFwiKTtcbiAgICBjb25zdCBvbmUgPSBkZW1vdGVkLmxlbmd0aCA9PT0gMTtcbiAgICBjb25zdCBpdCA9IG9uZSA/IFwiaXRcIiA6IFwidGhlbVwiO1xuICAgIGNvbnN0IHdhcyA9IG9uZSA/IFwid2FzXCIgOiBcIndlcmVcIjtcbiAgICBjb25zdCBhc0ZsYWcgPSBvbmUgPyBcImFzIGEgZmxhZ1wiIDogXCJhcyBmbGFnc1wiO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCMgd2FybmluZzogJHtjbGlOYW1lfSR7cm93Lm5hbWUgPT09IFwiXCIgPyBcIlwiIDogYCAke3Jvdy5uYW1lfWB9OiAke3doaWNofSBhZnRlciBcXGAtLVxcYCAke3dhc30gcmVhZCBhcyB0ZXh0LCBub3QgJHthc0ZsYWd9OyB0byB1c2UgJHtpdH0gJHthc0ZsYWd9LCBtb3ZlICR7aXR9IGJlZm9yZSBcXGAtLVxcYFxcbmAsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBydW5Sb3cgPSBhc3luYyAocm93OiBSb3csIHRva2VuOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChyb3cubmFtZSA9PT0gXCJcIiA/IG51bGwgOiByb3cubmFtZSk7XG4gICAgY29uc3QgbmFtZSA9IGxhYmVsKHJvdyk7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBuZXcgU2V0KHJvdy5hY2NlcHRlZCk7XG4gICAgY29uc3QgY2hvaWNlcyA9IHJvdy5uYW1lID09PSBcIlwiID8gcm9vdENob2ljZXMgOiBmbGFnc0Zvcihyb3cubmFtZSk7XG4gICAgY29uc3QgZmxhZ0hpbnQgPSAoKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICBbcm93LnJlamVjdEhpbnQsIGNob2ljZXMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gZmxhZ3NgIDogdW5kZWZpbmVkXVxuICAgICAgICAuZmlsdGVyKChzKTogcyBpcyBzdHJpbmcgPT4gcyAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAuam9pbihcIjsgXCIpIHx8IHVuZGVmaW5lZDtcblxuICAgIGxldCB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGxldCBwb3NpdGlvbmFsczogc3RyaW5nW107XG4gICAgbGV0IHRva2VuczogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPltcInRva2Vuc1wiXTtcbiAgICB0cnkge1xuICAgICAgKHsgdmFsdWVzLCBwb3NpdGlvbmFscywgdG9rZW5zIH0gPSBwYXJzZUFyZ3Moe1xuICAgICAgICBhcmdzLFxuICAgICAgICBvcHRpb25zOiBwYXJzZU9wdGlvbnMsXG4gICAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgICAgYWxsb3dQb3NpdGlvbmFsczogcm93LmFsbG93UG9zaXRpb25hbHMsXG4gICAgICAgIHRva2VuczogdHJ1ZSxcbiAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZXJyQ29kZShlKSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiKSB7XG4gICAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0pO1xuICAgICAgfVxuICAgICAgLy8gQSBtaXNzaW5nIHZhbHVlIGlzIG5vdCBhIGNob2ljZSBmcm9tIGEgc2V0LCBzbyBubyBgY2hvaWNlc2AgaGVyZS5cbiAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBoaW50OiByb3cucmVqZWN0SGludCA/PyBleHBlY3RzKHJvdykgfSk7XG4gICAgfVxuXG4gICAgLy8gU3RhZ2UgMjoga25vd24gdG8gdGhlIHNwZWxsLCBub3QgdGFrZW4gYnkgdGhpcyByb3cg4oCUIE1JU1BMQUNFRCwgbm90XG4gICAgLy8gdW5rbm93bi4gT25seSBmbGFncyB0aGUgY2FsbGVyIEdBVkUgYXJlIGhlcmU6IGRlZmF1bHRzIGFyZSBub3QgYXBwbGllZCB5ZXQuXG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyh2YWx1ZXMpLmZpbmQoKGspID0+ICFhY2NlcHRlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke25hbWV9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgJHtjbGlOYW1lfSBmbGFnLCBqdXN0IG5vdCB0aGlzICR7cm93Lm5hbWUgPT09IFwiXCIgPyBcImNvbW1hbmRcIiA6IFwidmVyYlwifSdzKWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEFyaXR5LCBmcm9tIHRoZSBkZWNsYXJlZCBzaGFwZSwgbmFtaW5nIHRoZSBtaXNzaW5nIG9yIHRoZSBleHRyYSB0b2tlbi5cbiAgICBjb25zdCByZXF1aXJlZCA9IHJvdy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgICBjb25zdCB2YXJpYWRpYyA9IHJvdy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgICBpZiAocG9zaXRpb25hbHMubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSByb3cucG9zaXRpb25hbHNbcG9zaXRpb25hbHMubGVuZ3RoXTtcbiAgICAgIGRpZShgJHtuYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IGV4cGVjdHMocm93KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWxzLmxlbmd0aCA+IHJvdy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYCR7bmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsc1tyb3cucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGhpbnQ6IHJvdy5wb3NpdGlvbmFscy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBhcmd1bWVudHNgIDogZXhwZWN0cyhyb3cpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIERlZmF1bHRzIGxhc3QsIGFuZCBvbmx5IHRoaXMgcm93J3MuXG4gICAgY29uc3QgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4gPSB7IC4uLih2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPikgfTtcbiAgICBmb3IgKGNvbnN0IGsgb2Ygcm93LmFjY2VwdGVkKSB7XG4gICAgICBjb25zdCBkID0gKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS5kZWZhdWx0O1xuICAgICAgaWYgKGZsYWdzW2tdID09PSB1bmRlZmluZWQgJiYgZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZsYWdzW2tdID0gKEFycmF5LmlzQXJyYXkoZCkgPyBbLi4uZF0gOiBkKSBhcyBGbGFnVmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW52OiBJbnZvY2F0aW9uID0geyBwYXRoOiByb3cubmFtZSwgdG9rZW4sIHBvczogcG9zaXRpb25hbHMsIGZsYWdzIH07XG4gICAgY29uc3QgcmVmdXNlZCA9IHJvdy5jaGVjaz8uKGludik7XG4gICAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCkgZGllKGAke25hbWV9OiAke3JlZnVzZWR9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IGV4cGVjdHMocm93KSB9KTtcblxuICAgIHdhcm5EZW1vdGVkKHJvdywgYWNjZXB0ZWQsIHRva2Vucyk7XG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgcm93LnJ1bihpbnYpO1xuICAgIHJldHVybiB0eXBlb2Ygb3V0ID09PSBcIm51bWJlclwiID8gb3V0IDogMDtcbiAgfTtcblxuICBjb25zdCBkaXNwYXRjaCA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgICBjb25zdCBmaXJzdCA9IGFyZ3ZbMF07XG5cbiAgICAvLyAxLiBJbnRlcmNlcHRvcnMgcGFzcyB0aGUgcmVzdCBvZiB0aGUgYXJndiBvbiB0byB0aGVpciByb3cuXG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBJTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBmaXJzdCk7XG4gICAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBydW5Sb3coYnlUb2tlbi5nZXQoaW50ZXJjZXB0b3IucnVucykgYXMgUm93LCBpbnRlcmNlcHRvci5ydW5zLCBhcmd2LnNsaWNlKDEpKTtcbiAgICB9XG5cbiAgICAvLyAyLiBBIHZlcmJsZXNzIHJvb3Qgb3ducyBldmVyeSBhcmd2IHRoYXQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlc2VydmVkIHRva2VuLlxuICAgIGlmIChyb290Um93ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkICYmIChieVRva2VuLmhhcyhmaXJzdCkgfHwgc3Vic09mLmhhcyhmaXJzdCkpKSB7XG4gICAgICAgIGNvbnN0IHIgPSByZXNvbHZlKGZpcnN0LCBhcmd2LnNsaWNlKDEpKTtcbiAgICAgICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBydW5Sb3cocm9vdFJvdywgXCJcIiwgYXJndik7XG4gICAgfVxuXG4gICAgLy8gMy4gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMikuXG4gICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcblxuICAgIC8vIDQuIEZpbmQgdGhlIHZlcmIuXG4gICAgbGV0IGNhbmQ6IHN0cmluZztcbiAgICBsZXQgcmVzdDogc3RyaW5nW107XG4gICAgaWYgKGdyYW1tYXIgPT09IFwidmVyYi1maXJzdFwiKSB7XG4gICAgICBpZiAoZmlyc3QgPT09IFwiLS1cIikge1xuICAgICAgICBpZiAoYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICAgIGNhbmQgPSBhcmd2WzFdO1xuICAgICAgICByZXN0ID0gW1wiLS1cIiwgLi4uYXJndi5zbGljZSgyKV07XG4gICAgICB9IGVsc2UgaWYgKGZpcnN0LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgIHJldHVybiBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtmaXJzdH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke3ZlcmJzLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZCA9IGZpcnN0O1xuICAgICAgICByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IHNjYW5Qb3NpdGlvbmFsKGFyZ3YsIGZhbHNlKTtcbiAgICAgIGlmIChpIDwgMCkge1xuICAgICAgICAvLyBObyB2ZXJiIGFueXdoZXJlOiBhbiB1bmtub3duIGZsYWcgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LFxuICAgICAgICAvLyBhbmQgYSBjbGVhbiBwYXJzZSBpcyBhIGJhcmUgaW52b2NhdGlvbi4gTmVpdGhlciByYW4gYSBjb21tYW5kLCBzb1xuICAgICAgICAvLyB0aGUgZW52ZWxvcGUncyBgbWV0YS5jb21tYW5kYCBpcyBudWxsLCBub3QgdGhlIGZpcnN0IGZsYWcnc1xuICAgICAgICAvLyBzcGVsbGluZyAoYGdsYW1vdXIgLS1ib2d1c2AgbmFtZXMgbm8gdmVyYikuXG4gICAgICAgIHNldEN1cnJlbnRDb21tYW5kKG51bGwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IHBhcnNlT3B0aW9ucywgc3RyaWN0OiB0cnVlLCBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgZGllKGVyck1lc3NhZ2UoZSksIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgICAgaGludDogYG5vIGNvbW1hbmQgZ2l2ZW4g4oCUIGNvbW1hbmRzOiAke3ZlcmJzLmpvaW4oXCIgXCIpfSAocnVuOiAke2NsaU5hbWV9IGhlbHApYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICB9XG4gICAgICBjYW5kID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgICAvLyBBIHZlcmIgZm91bmQgcmlnaHQgYWZ0ZXIgYSBgLS1gIGxlYXZlcyB0aGF0IGAtLWAgaW4gcGxhY2UsIHNvIHRoZVxuICAgICAgLy8gcmVzdCBvZiB0aGUgYXJndiBzdGF5cyBwb3NpdGlvbmFsLlxuICAgICAgcmVzdCA9IHdpdGhvdXQoYXJndiwgaSk7XG4gICAgfVxuICAgIHNldEN1cnJlbnRDb21tYW5kKGNhbmQpO1xuICAgIGNvbnN0IHIgPSByZXNvbHZlKGNhbmQsIHJlc3QpO1xuICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gIH07XG5cbiAgY29uc3QgbWFpbiA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgICAvLyBUaGUgaG91c2UgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuIEEgc3BlbGwgdGhhdFxuICAgICAgLy8gdHJpYWdlcyBpdHMgb3duIChnbGFtb3VyJ3MgRU5PRU5UIOKGkiB1c2FnZSkgY2FsbHMgYGRpc3BhdGNoYCBpbnN0ZWFkLlxuICAgICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIGVyck1lc3NhZ2UoZSkpKSA/PyAxO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2aWV3ID0gKHI6IFJvdyk6IFJvd1ZpZXcgPT4gKHtcbiAgICBuYW1lOiByLm5hbWUsXG4gICAgYWxpYXNlczogci5hbGlhc2VzLFxuICAgIGZsYWdzOiByLmZsYWdzLFxuICAgIGFjY2VwdGVkOiByLmFjY2VwdGVkLFxuICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLFxuICAgIGRlc2NyaWJlOiByLmRlc2NyaWJlLFxuICAgIGF1dG86IHIuYXV0byxcbiAgfSk7XG5cbiAgT2JqZWN0LmFzc2lnbihjbGksIHtcbiAgICBuYW1lOiBjbGlOYW1lLFxuICAgIG1haW4sXG4gICAgZGlzcGF0Y2gsXG4gICAgZGVjbGFyYXRpb24sXG4gICAgcmVuZGVySGVscCxcbiAgICB1c2FnZU9mOiAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByID0gcm93Rm9yKHBhdGgpO1xuICAgICAgcmV0dXJuIHIgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiB1c2FnZUxpbmUocik7XG4gICAgfSxcbiAgICB2ZXJicyxcbiAgICBwYXRocyxcbiAgICBmbGFnc0ZvcixcbiAgICByZWNvZ25pemVkRmxhZ3M6IG9wdGlvbktleXMubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgcm93czogcm93cy5tYXAodmlldyksXG4gIH0gc2F0aXNmaWVzIENsaSk7XG4gIHJldHVybiBjbGk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8vIFNlc3Npb24gZW5kaW5ncyBhcmUgb3V0Y29tZXMsIG5vdCBmYWlsdXJlcywgYW5kIHN0YXkgb3V0c2lkZSB0aGUgdGF4b25vbXk6XG4vLyBhbiBhZ2VudCByZWFkcyB0aGVtIGFzIFwidGhlIHNlc3Npb24gZW5kZWQgdGhpcyB3YXlcIiwgbm90IFwidGhlIHZlcmIgYnJva2VcIi5cbi8vIFRoZSBudW1iZXJzIGFyZSB0aGUgc2hlbGwncyAoYHRpbWVvdXRgJ3MgMTI0LCBTSUdJTlQncyAxMjggKyAyKSwgc28gYVxuLy8gd3JhcHBlciB0aGF0IGFscmVhZHkga25vd3MgdGhlbSBuZWVkcyBubyB0YWJsZS5cbi8qKiBBIGRhZW1vbiB0aGF0IGNsb3NlZCBpdHNlbGYgYWZ0ZXIgaXRzIGlkbGUgdGltZW91dC4gQW4gb3V0Y29tZSwgbm90IGEgZmFpbHVyZS4gKi9cbmV4cG9ydCBjb25zdCBFWElUX0lETEVfVElNRU9VVCA9IDEyNDtcbi8qKiBUaGUgdXNlciBjYW5jZWxsZWQuIEFuIG91dGNvbWUsIG5vdCBhIGZhaWx1cmUuICovXG5leHBvcnQgY29uc3QgRVhJVF9DQU5DRUxMRUQgPSAxMzA7XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGB0b2tlbmAgaXMgYSBzdGFibGUgbWFjaGluZS1yZWFkYWJsZSBuYW1lXG4gKiBmb3IgdGhlIGNhdXNlIChgbm9fc2Vzc2lvbmApLCBgaGludGAgaXMgcHJvc2UgZm9yIGEgaHVtYW4gb3IgYW4gYWdlbnQ7XG4gKiBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC5cbiAqXG4gKiDimqAgKipgc2VydmVyYCBBUlJJVkVEIElOIFBIQVNFIDIsIEFORCBJVCBJUyBBIEZJTkRJTkcgQUJPVVQgVEhJUyBNT0RVTEUuKiogVGhlXG4gKiBjb250cmFjdCB3YXMgZXh0cmFjdGVkIGZyb20gYXN0cm9sYWJlIGFuZCBtYWdwaWUsIGFuZCBCT1RIIG9mIHRoZW0gZnJvbnQgYVxuICogZGFlbW9uIGFuZCBCT1RIIG9mIHRoZW0gdGhyb3cgYXdheSB3aGF0IHRoZSBkYWVtb24gc2FpZDogbWFncGllJ3NcbiAqIGBkaWUoXCJzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KVwiLCBcImludGVybmFsXCIpYCBrZWVwcyB0aGUgbnVtYmVyIGFuZCBkcm9wc1xuICogdGhlIGJvZHkuIGdsYW1vdXIgZG9lcyBub3Qg4oCUIGl0cyByZWZ1c2FscyBjYXJyeSB0aGUgZGFlbW9uJ3Mgb3duIEpTT04gdmVyYmF0aW1cbiAqIHVuZGVyIGBlcnJvci5zZXJ2ZXJgLCBzbyBhIGNhbGxlciBjYW4gYnJhbmNoIG9uIHRoZSB1cHN0cmVhbSdzIHJlYXNvbiBpbnN0ZWFkXG4gKiBvZiBvbiB0aGUgQ0xJJ3MgcHJvc2UgYWJvdXQgaXQsIGFuZCBgdGVzdHMvY2xpLWNvbnRyYWN0LnRlc3QudHNgIGFzc2VydHMgaXQgZm9yXG4gKiA0MDAsIDQwNCBhbmQgNDA5LiBTZXZlbiBvZiB0aGUgZWlnaHQgc3BlbGxzIHB1dCBhIENMSSBpbiBmcm9udCBvZiBhIGRhZW1vbiwgc29cbiAqIHRoaXMgaXMgdGhlIGdlbmVyYWwgc2hhcGUgYW5kIHRoZSB0d28tc3BlbGwgYm91bmRhcnkgd2FzIHRoZSBuYXJyb3cgb25lLlxuICpcbiAqIOKblCBJVCBJUyBUSEUgVVBTVFJFQU0nUyBCT0RZLCBWRVJCQVRJTSwgQU5EIE5PVEhJTkcgRUxTRS4gTm90IGEgcGxhY2UgdG8gc3Rhc2hcbiAqIGFyYml0cmFyeSBjb250ZXh0OiB0aGUgd2hvbGUgdmFsdWUgb2YgdGhlIGZpZWxkIGlzIHRoYXQgYSBjYWxsZXIgY2FuIHRydXN0IGl0XG4gKiBpcyB3aGF0IHRoZSBvdGhlciBzaWRlIGFjdHVhbGx5IHNhaWQuXG4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyB0b2tlbj86IHN0cmluZzsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLy8gT25seSBwcmVzZW50IHdoZW4gZ2l2ZW4sIHNvIGFuIGVudmVsb3BlIHdpdGhvdXQgb25lIGtlZXBzIGl0cyBieXRlcy5cbiAgICAgIC4uLihleHRyYT8udG9rZW4gPyB7IHRva2VuOiBleHRyYS50b2tlbiB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2l0ZW1zL3RhaWwtcmVhZGVyLWNvbnZlcmdlbmNlL3dyaXRlLXVwLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2l0ZW1zL3NjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pdGVtcy9tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwvd3JpdGUtdXAubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIChhc3Ryb2xhYmUsIGdyYXBldmluZSkgYWx3YXlzIGdldHNcbiAqICAgICBgdGFpbC53aW5kb3dgOiBhIHN0b3Atc3RhcnQgdGFpbCB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHNcbiAqICAgICBjb25uZWN0aW9uIGNhcnJpZXMuIE1pbmQtbWFwcGVyIHdhcyBvbmUgYW5kIGlzIG5vdCBzaW5jZSAyMDI2LTA5LTI0XG4gKiAgICAgKHNlZSBcIk1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMU1wiIGJlbG93KS5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzIGFuZCBtaW5kLW1hcHBlciksIGVhY2ggbmFtaW5nIGhvdyB0b1xuICogY29tZSBiYWNrIGluc3RlYWQgb2YgYSByZS1hcm0uIEEgc2lnbmFsIG9yIGEgY2FsbGVyJ3MgYWJvcnQgcHJpbnRzIG5vdGhpbmcuXG4gKlxuICogRXZlcnkgcmUtYXJtIGNhcnJpZXMgYC0tc2luY2UgPGN1cnNvcj5gLCBzbyBub3RoaW5nIHJlcGxheXM7IHRoZSBkYWVtb24nc1xuICogYnVmZmVyIGNvdmVycyB3aGF0ZXZlciBsYW5kcyBiZXR3ZWVuIG9uZSB3YXRjaCdzIGV4aXQgYW5kIHRoZSBuZXh0J3MgYXJtLlxuICpcbiAqIOKUgOKUgCBERUNJU0lPTiBMT0cgKGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCAyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBLaXQgZGVjaXNpb25zIGxpdmUgaW4gbW9kdWxlIGhlYWRlcnMgKHRoZSBhcmNoaXRlY3R1cmUgZG9jJ3Mgwqc0IHJ1bGU6IFwiZWFjaFxuICogbW9kdWxlJ3MgaGVhZGVyIGlzIHRoZSBhdXRob3JpdGF0aXZlIGFjY291bnRcIikuIFJ1bGVkIGJ5IENvbGU6IHRoZSBoeWJyaWQsXG4gKiB0aGUgYWx3YXlzLWJvb2ttYXJrLCBwcmVzZW5jZSBzcGVsbHMgYWx3YXlzIHJlLWFybSBNb25pdG9yLCBib3VudHkncyBleGFtcGxlXG4gKiBmaXhlZC4gVGhlIGZvdXIgYWRqdXN0bWVudHMgd2VyZSB0aGUgc3Bpa2UncyByZXF1aXJlbWVudHMuIFRoZSByZXN0IGFyZSB0aGVcbiAqIGltcGxlbWVudGVyJ3MgcnVsaW5ncywgbWFya2VkIOKaliB3aXRoIHRoZSBvcHRpb25zIG5vdCB0YWtlbi5cbiAqXG4gKiBBMSDCtyBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTi4gYHRhaWxFdmVudHNgIG5vdyBhYm9ydHMgdGhlXG4gKiAgICAgIGluLWZsaWdodCBmZXRjaCBiZWZvcmUgaXQgcmV0dXJucyBvbiBhIHRlcm1pbmFsIGZyYW1lLiBCZWZvcmUsIGl0XG4gKiAgICAgIHJldHVybmVkIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3AgYW5kIGxlZnQgdGhlIFNTRSBzdHJlYW0gb3Blbiwgc28gdGhlXG4gKiAgICAgIHByb2Nlc3Mgc3RheWVkIGFsaXZlOiB1bnNlZW4gZm9yIGBjbG9zZWRgICh0aGUgc2VydmVyIGVuZHMgdGhhdFxuICogICAgICBzdHJlYW0gaXRzZWxmKSBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2sgd291bGRcbiAqICAgICAgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQsIHNpbGVudGx5LiBQaW5uZWQgaW5cbiAqICAgICAgYHRhaWxIYW5kb2ZmLnRlc3QudHNgIGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBrZWVwcyB0aGUgc3RyZWFtIG9wZW4uXG4gKlxuICogQTIgwrcgVEhFIE5FWFQgQUNUIERFUEVORFMgT04gU1RBVEUuIGBoYW5kb2ZmKClgIGJlbG93IGlzIHRoZSBwdXJlIGRlY2lzaW9uOlxuICogICAgICBxdWlldCDihpIgYmFja2dyb3VuZCwgYWN0aXZlIG9yIHByZXNlbmNlIOKGkiBNb25pdG9yLCB3b2tlIOKGkiBNb25pdG9yLFxuICogICAgICBjbG9zZWQg4oaSIGNvbWUgYmFjaywgbG9zdCDihpIgY29tZSBiYWNrLiBDb21lIGJhY2sgaXMgdGhlIHNwZWxsJ3Mgb3duIHZlcmJcbiAqICAgICAgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCBmb3IgdGhlIHNlc3Npb24gc3BlbGxzLCBgb3BlbiAtLW5vLW9wZW5gIGZvclxuICogICAgICBtaW5kLW1hcHBlciBhbmQgYXN0cm9sYWJlKS5cbiAqICAgICAg4pqWIFRIRSBESVNDT05ORUNUIERFQ0lTSU9OOiBmb3IgYSBzZXNzaW9uIHNwZWxsLCBhIExPU1QgZGFlbW9uIGVuZHMgdGhlXG4gKiAgICAgIHRhaWwgaW4gQk9USCBtb2RlcyB3aXRoIGEgc3Rkb3V0IGB0YWlsLmxvc3RgIGxpbmUuIE1vbml0b3Igbm90aWZpZXMgb25seVxuICogICAgICBvbiBzdGRvdXQsIHNvIHRoZSBvbGQgc3RkZXJyLW9ubHkgYHRhaWwuZGlzY29ubmVjdGVkYCBsZWZ0IGFcbiAqICAgICAgTW9uaXRvci13cmFwcGVkIGFnZW50IHVuYXdhcmUgb2YgYSBga2lsbCAtOWAgKEU1NSdzIHB1cnBvc2UgdW5tZXQpLCBhbmRcbiAqICAgICAgYSBgLS1vbmNlYCBvbiBhIGRlYWQgZGFlbW9uIHdvdWxkIGhhdmUgc2xlcHQgZm9yZXZlci4gXCJMb3N0XCIgaXNcbiAqICAgICAgYExPU1RfQUZURVJfUkVGVVNBTFNgIGNvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3csIG5ldmVyIGEgZHJvcHBlZFxuICogICAgICBzdHJlYW0gYWxvbmU6IGEgbGFwdG9wIHRoYXQgc2xlZXBzIGRyb3BzIHRoZSBzdHJlYW0sIHJlY29ubmVjdHMgb24gdGhlXG4gKiAgICAgIGZpcnN0IHRyeSwgYW5kIG11c3Qgc3RheSBzaWxlbnQuXG4gKiAgICAgICAgTm90IHRha2VuOiAoYSkga2VlcCByZXRyeWluZyBhbmQgb25seSBNT1ZFIHRoZSBkaXNjb25uZWN0IGxpbmUgdG9cbiAqICAgICAgICBzdGRvdXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24gaXMgbmV2ZXIgcmVzcGF3bmVkIGJ5IGl0cyB0YWlsLCBzbyB0aGVcbiAqICAgICAgICByZXRyaWVzIGJ1eSBub3RoaW5nIGFuZCB0aGUgYWdlbnQgaXMgd29rZW4gdG8gYmUgdG9sZCB0byB3YWl0OyAoYilcbiAqICAgICAgICBsZWF2ZSBpdCBvbiBzdGRlcnIg4oCUIHRoZSBkZWZlY3QuXG4gKiAgICAgIOKaliBQcmVzZW5jZSBzcGVsbHMga2VlcCByZXRyeWluZywgYXMgYmVmb3JlOiBncmFwZXZpbmUncyB0YWlsIHJlc3Bhd25zXG4gKiAgICAgIGl0cyBkYWVtb24gYW5kIGFzdHJvbGFiZSdzIGBqb2luYCB3YWl0cyBmb3IgdGhlIGh1bWFuIHRvIHJlb3BlbiB0aGVcbiAqICAgICAgYm9hcmQsIGJvdGggYnkgZGVzaWduLiBUaGVpciBkaXNjb25uZWN0IG5vdGVzIHN0YXkgd2hlcmUgdGhleSB3ZXJlLlxuICpcbiAqIEEzIMK3IFFVSUVUIElTIFRIRSBUQUlMJ1MgT1dOIENPVU5ULiBgZXZlbnRzYCBjb3VudHMgdGhlIGxvZyBmcmFtZXMgdGhpc1xuICogICAgICBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dC4gVGhlIGdyb3VuZGluZyBsaW5lLCBhIHNwZWxsJ3MgYHN1YnNjcmliZWRgXG4gKiAgICAgIG1hcmtlciwgYGVwb2NoLmNoYW5nZWRgIGFuZCB0aGUgaGFuZG9mZiBsaW5lIGl0c2VsZiBhcmUgbm90IGxvZyBmcmFtZXNcbiAqICAgICAgYW5kIGFyZSBub3QgY291bnRlZDogYSBmcmFtZSBjb3VudHMgb25seSBpZiBpdCBjYXJyaWVzIGEgbG9nIGlkIChEMyksXG4gKiAgICAgIGFuZCBgY291bnRzYCBsZXRzIGEgc3BlbGwgZXhjbHVkZSBhIGZyYW1lIHRoYXQgZG9lcyAoZ3JhcGV2aW5lJ3NcbiAqICAgICAgYHN1YnNjcmliZWRgIG1hcmtlciwgd2hpY2ggc2VlZHMgdGhlIGJvb2ttYXJrIGZyb20gYGxhdGVzdF9pZGApLiBBbnkgbG9nIGZyYW1lIGNvdW50cywgdGhlIGRhZW1vbidzIGB3YWl0aW5nYCByZW1pbmRlclxuICogICAgICBpbmNsdWRlZCwgc28gXCJxdWlldFwiIG1lYW5zIG5vdGhpbmcgb24gdGhlIGxvZy5cbiAqICAgICAg4pqWIEEgZnJhbWUgdGhlIHRhaWwncyBvd24gZmlsdGVyIHJlamVjdHMgKGJvdW50eSdzIG93bmVyIHNjb3BlLCBhXG4gKiAgICAgIHNlbGYtZWNobykgaXMgTk9UIGNvdW50ZWQgYW5kIGRvZXMgbm90IGVuZCBhIGAtLW9uY2VgOiBpdCB3YXMgbmV2ZXJcbiAqICAgICAgZGVsaXZlcmVkLCBhbmQgd2FraW5nIG9uIGl0IHdvdWxkIGJlIGEgd2FrZSB3aXRoIG5vdGhpbmcgdG8gYWN0IG9uIOKAlFxuICogICAgICB0aGUgZGVmZWN0IHRoaXMgbW9kdWxlIGV4aXN0cyB0byByZW1vdmUuIFRoZSBjdXJzb3Igc3RpbGwgYWR2YW5jZXNcbiAqICAgICAgcGFzdCBpdCAodGFpbEV2ZW50cycgcnVsZSksIHNvIGl0IG5ldmVyIHJlcGxheXMgZWl0aGVyLlxuICogICAgICBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOyB0aGF0IGhhbGYgbGl2ZXMgaW4gZWFjaFxuICogICAgICBzcGVsbCdzIGB0YWlsYCwgd2hpY2gga25vd3Mgd2hldGhlciBgLS1zaW5jZWAgd2FzIGdpdmVuLlxuICpcbiAqIEE0IMK3IFRIRSBXSU5ET1cuIGBERUZBVUxUX1dJTkRPV19NU2AgPSB0aGUgY2FwIG1pbnVzIGBXSU5ET1dfTUFSR0lOX01TYFxuICogICAgICAoNjAgcyksIHNvIDEsNzQwLDAwMCBtcy4gVGhlIG1hcmdpbiBoYXMgdG8gY292ZXIgdGhlIGdhcCBiZXR3ZWVuIHRoZVxuICogICAgICBoYXJuZXNzIHN0YXJ0aW5nIGl0cyBjbG9jayBhbmQgdGhpcyBwcm9jZXNzIHN0YXJ0aW5nIGl0cyBvd24gKEJ1blxuICogICAgICBzdGFydC11cCwgYSBzZXNzaW9uIGxvb2t1cCwgYSBkYWVtb24gc3Bhd24gb24gdGhlIHNwZWxscyB3aG9zZSBgcmVzb2x2ZWBcbiAqICAgICAgc3Bhd25zIG9uZSDigJQgYm91bmRlZCBieSB0aGVpciBzdGFydCB0aW1lb3V0cywgd2hpY2ggYXJlIHNlY29uZHMpIHBsdXNcbiAqICAgICAgdGhlIGxhc3QgbGluZSdzIGZsdXNoIGFuZCBNb25pdG9yJ3MgMjAwIG1zIGJhdGNoaW5nLiBBIG1pbnV0ZSBjb3ZlcnNcbiAqICAgICAgYWxsIG9mIHRoYXQgbWFueSB0aW1lcyBvdmVyLiBUaGUgc3Bpa2UgbWVhc3VyZWQgYSAxMiBzXG4gKiAgICAgIHdpbmRvdyB1bmRlciBhIDIwIHMgY2FwIGVuZGluZyBjbGVhbmx5OyBub3RoaW5nIGhlcmUgZGVwZW5kcyBvbiBhXG4gKiAgICAgIG1hcmdpbiB0aGF0IHRpZ2h0LiBJZiB0aGUgY2FwIHdpbnMgYW55d2F5LCB0aGUgYWdlbnQgZ2V0cyBNb25pdG9yJ3NcbiAqICAgICAgYmFyZSBleHBpcnkgbm90aWNlIGFuZCByZS1hcm1zIHNpbGVudGx5IGZyb20gdGhlIGxhc3QgaWQgaXQgc2F3IOKAlCB0aGVcbiAqICAgICAgcnVsaW5nJ3MgZmFsbGJhY2ssIHN0YXRlZCBpbiBldmVyeSBza2lsbC5cbiAqICAgICAg4pqWIFRoZSB3aW5kb3cgaXMgaW5qZWN0YWJsZSBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiB0aHJvdWdoXG4gKiAgICAgIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNgIChhIGNvdW50IG9mIG1zOyBgMGAgdHVybnMgdGhlIHdpbmRvdyBvZmYsXG4gKiAgICAgIGZvciBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwpLiBBbiBlbnYgdmFyIGFuZCBub3QgYSBmbGFnOiBpdCBpc1xuICogICAgICBub3QgYW4gYWdlbnQncyBhY3QsIHNvIGl0IHN0YXlzIG91dCBvZiBlaWdodCB2ZXJicycgc2NoZW1hcy5cbiAqXG4gKiDilIDilIAgVEhFIFZFUklGSUVSJ1MgREVGRUNUUywgRklYRUQgT04gVEhFIFNBTUUgQlJBTkNIICgyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbm8tc3Rha2UgdmVyaWZpZXIgcmFuIGV2ZXJ5IHNwZWxsJ3MgcmVhbCB0YWlsIGFuZCBmb3VuZCBmb3VyIHdheXMgdGhlXG4gKiBsb29wIGJyb2tlLiBFYWNoIGhhcyBhIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgOyBEMSBhbmQgRDIgYWxzbyBoYXZlIGFcbiAqIHJlYWwtZGFlbW9uIGNlbGwgaW4gYHNyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RhaWwtaGFuZG9mZi5pbnRlZ3JhdGlvbi50ZXN0LnRzYC5cbiAqXG4gKiBEMSDCtyBBIFJFLUFSTSBBVCBBIFNFU1NJT04gVEhBVCBDTE9TRUQgSU4gVEhFIEdBUCBFTkRTIGB0YWlsLmNsb3NlZGAuIFRoZVxuICogICAgICB0cmlnZ2VyIGlzIG9yZGluYXJ5OiB0aGUgaHVtYW4gcHJlc3NlcyBDbG9zZSB3aGlsZSB0aGUgYWdlbnQgaGFuZGxlc1xuICogICAgICBgdGFpbC53b2tlYC4gVGhlIHNlc3Npb24gc3BlbGxzIHN0b3BwZWQgb25seSB3aGVuIFRISVMgcHJvY2VzcyBoYWRcbiAqICAgICAgb25jZSByZWFjaGVkIHRoZSBzZXNzaW9uLCBzbyB0aGUgcmUtYXJtIHJldHJpZWQgXCJubyBzZXNzaW9uIHlldFwiIG9uXG4gKiAgICAgIHN0ZGVyciBmb3JldmVyIOKAlCBhbmQgaXRzIGAtLW9uY2VgIG5ldmVyIGV4aXRlZC4gUnVsZTogYSB0YWlsIGdpdmVuXG4gKiAgICAgIGAtLXNlc3Npb25gIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HIHNlc3Npb24sIHNvIG5vdFxuICogICAgICBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZDsgdGhlIHNwZWxsJ3MgYG9uVW5yZXNvbHZlZGAgc2F5cyBcInN0b3BcIlxuICogICAgICBhbmQgdGhpcyBtb2R1bGUgcmVhZHMgQU5ZIHN0b3AgYXMgY2xvc2VkLiBBIGJhcmUgZmlyc3QgYXJtIHN0aWxsXG4gKiAgICAgIHdhaXRzIGZvciBhIHNlc3Npb24gdG8gYXBwZWFyLiDimqAgXCJHaXZlblwiIG1lYW5zIE9OIFRIRSBDT01NQU5EIExJTkVcbiAqICAgICAgKHJldmlldyBCMSk6IGJvdW50eSBhbHNvIHJlc29sdmVzIGEgc2Vzc2lvbiBmcm9tXG4gKiAgICAgIGAkQk9VTlRZX1NFU1NJT05fS0VZYCwgYCRCT1VOVFlfU0VTU0lPTmAgb3IgYSBgLmJvdW50eS1zZXNzaW9uYCBmaWxlLFxuICogICAgICB3aGljaCBldmVyeSBhbnRoaWxsIHNlYXQgaGFzLCBhbmQgYSBzZWF0J3MgZmlyc3QgYXJtIG11c3Qgd2FpdC4gQVxuICogICAgICBrZXllZCBib3VudHkgYm9hcmQgY29tZXMgYmFjayBieSBpdHMga2V5IChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKTtcbiAqICAgICAgcmVzdG9yaW5nIGl0IGJ5IGlkIHNwYXducyBhbiB1bmtleWVkIHN0cmF5LlxuICogRDIgwrcgQSBCT09LTUFSSyBDQU5OT1QgT1VUTElWRSBJVFMgTE9HLiBBIHJlc3RvcmVkIGRhZW1vbidzIGlkcyBiZWdpbiBhdCAxLFxuICogICAgICBhbmQgdGhlIGtpdCdzIGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duIGJ5IHJlcGxheWluZyB3aG9sZTtcbiAqICAgICAgdGhlIHRhaWwga2VwdCBpdHMgaGlnaGVyIGN1cnNvciwgc28gZXZlcnkgcmUtYXJtIHJlcGxheWVkIHRoZSBuZXcgbG9nXG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUd28gaGFsdmVzOlxuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVGhyZWUgcGFydHM6XG4gKiAgICAgICAgKGEpIHRoZSBuZXQg4oCUIGB0YWlsRXZlbnRzYCcgYHJlc3RhcnRPblJlcGxheWAsIG9uIGZvciBldmVyeSBzcGVsbCxcbiAqICAgICAgICAgICAgcmVhZHMgYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGFzIGEgcmVzdGFydGVkIGxvZ1xuICogICAgICAgICAgICBhbmQgcmVzZXRzIHRoZSBjdXJzb3I7XG4gKiAgICAgICAgKGIpIHRoZSBydWxlIOKAlCB0aGUgYHRhaWwuY2xvc2VkYC9gdGFpbC5sb3N0YCBoaW50LCBhbmQgZXZlcnkgc2tpbGwsXG4gKiAgICAgICAgICAgIHNheTogcnVuIHRoZSBjb21tYW5kIHRoZSBsaW5lIG5hbWVzLCB0aGVuIHRhaWwgV0lUSCBOT1xuICogICAgICAgICAgICBgLS1zaW5jZWAgKGEgcmVzdG9yZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2c7IGJvdW50eSdzIHJlc3RvcmVcbiAqICAgICAgICAgICAgZXZlbiBtaW50cyBhIG5ldyBpZCk7XG4gKiAgICAgICAgKGMpIFRIRSBFUE9DSCBJTiBUSEUgQk9PS01BUksg4oCUIOKaliBBIFJFVkVSU0FMLiBUaGUgZmlyc3QgdmVyc2lvbiBvZlxuICogICAgICAgICAgICB0aGlzIGVudHJ5IGxpc3RlZCBcImNhcnJ5IHRoZSBlcG9jaCBpbiB0aGUgYm9va21hcmtcIiBhcyBub3QgdGFrZW5cbiAqICAgICAgICAgICAgKGEgbmV3IGZsYWcgb24gZWlnaHQgdmVyYnM7IGFuIGVwb2NoIHNlZW4gb25seSBvbmNlIGEgZnJhbWVcbiAqICAgICAgICAgICAgYXJyaXZlcykuIFRoZSByZXZpZXdlciB0aGVuIHNob3dlZCAoYSkncyBibGluZCBzcG90IExJVkU6IGFuIG9sZFxuICogICAgICAgICAgICBib29rbWFyayBhdCBvciBiZWxvdyB0aGUgTkVXIGxvZydzIGxlbmd0aCBtYWtlcyB0aGUgZGFlbW9uIHNlbmRcbiAqICAgICAgICAgICAgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuXG4gKiAgICAgICAgICAgIG1lc3NhZ2UgYXQgbmV3IGlkIDIgdW5kZXIgYSBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgd2l0aCBub1xuICogICAgICAgICAgICBub3RpY2UuIFRocmVlIHBhdGhzIHJlYWNoIGl0OiBjb21pbmcgYmFjayB3aXRob3V0IGZvbGxvd2luZyAoYik7XG4gKiAgICAgICAgICAgIHRoZSBNb25pdG9yLWNhcCBmYWxsYmFjayAoXCJyZS1hcm0gZnJvbSB0aGUgbGFzdCBpZCB5b3Ugc2F3XCIpXG4gKiAgICAgICAgICAgIGFjcm9zcyBhIHJlc3RhcnQ7IGFuZCBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluLXByb2Nlc3NcbiAqICAgICAgICAgICAgKGFzdHJvbGFiZSwgb3IgbWluZC1tYXBwZXIgd2hlbiBpdHMgZGFlbW9uIGlzIGJhY2sgYmVmb3JlIHRoZVxuICogICAgICAgICAgICBsb3N0IHJ1bGUgZmlyZXMpIHdob3NlIGZpcnN0IGZyYW1lIGFmdGVyIGEgcmVzdGFydCBpcyBhbHJlYWR5XG4gKiAgICAgICAgICAgIHBhc3QgaXRzIGJvb2ttYXJrLlxuICogICAgICAgICAgICBUaGUgZml4IG5lZWRzIG5vIG5ldyBmbGFnIGFuZCBubyB3aXJlIGNoYW5nZTogdGhlIGJvb2ttYXJrIGlzXG4gKiAgICAgICAgICAgIHByaW50ZWQgYC0tc2luY2UgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSwgdGhlIGNsaWVudCBzdGFydHNcbiAqICAgICAgICAgICAgd2l0aCB0aGF0IGVwb2NoIChgc2luY2VFcG9jaGApLCBhbmQgYW4gZXBvY2ggY2hhbmdlIHdob3NlIGZyYW1lXG4gKiAgICAgICAgICAgIGlzIHBhc3QgdGhlIGFza2VkIGN1cnNvciByZS1yZWFkcyB0aGUgbmV3IGxvZyBmcm9tIDAuIFRoZSBzYW1lXG4gKiAgICAgICAgICAgIHJlY29ubmVjdCBjb3ZlcnMgdGhlIGluLXByb2Nlc3MgcHJlc2VuY2UgY2FzZS5cbiAqICAgICAg4pqgIFNUQVRFRCBMSU1JVDogb25seSBkYWVtb25zIHRoYXQgc3RhbXAgYW4gZXBvY2ggZ2V0IChjKSDigJRcbiAqICAgICAgc2NyaXB0b3JpdW0sIGFzdHJvbGFiZSBhbmQgbWluZC1tYXBwZXIuIEdsYW1vdXIsIGltYWdvLCBtYWdwaWUgYW5kXG4gKiAgICAgIGJvdW50eSBzdGFtcCBub25lIChzZXNzaW9uLXNjb3BlZCBsb2dzLCBydWxlZCBzbyBpbiBEMzkvQjg7IGJvdW50eSdzXG4gKiAgICAgIHNlcnZlciBoZWFkZXIgbmFtZXMgdGhpcyByZXNpZHVlKSwgc28gZm9yIHRoZW0gdGhlIGdhcCBzdGF5cyBvcGVuIG9uXG4gKiAgICAgIHRoZSBmYWxsYmFjayBwYXRoLCAoYSkgY292ZXJzIHRoZSB3aG9sZS1yZXBsYXkgY2FzZSBhbmQgKGIpIHRoZVxuICogICAgICBjb21lLWJhY2sgcGF0aC4gQ2xvc2luZyBpdCB0aGVyZSBpcyBhIGRhZW1vbiBjaGFuZ2U6IGFuIGVwb2NoIG9uXG4gKiAgICAgIGBjcmVhdGVFdmVudExvZ2AuIEV2ZXJ5IHNwZWxsIHByaW50cyB0aGUgbmV0J3MgcmVzZXQgYXNcbiAqICAgICAgYGVwb2NoLmNoYW5nZWRgIChgXCJlcG9jaFwiOiBcInVua25vd25cImAgd2hlcmUgdGhlcmUgaXMgbm9uZSkuXG4gKiBEMyDCtyBPTkxZIEEgRlJBTUUgV0lUSCBBIExPRyBJRCBDT1VOVFMuIEdsYW1vdXIncyBhbmQgaW1hZ28ncyB0YWIgcGluZ3NcbiAqICAgICAgKGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgKSBjYXJyeSBubyBpZDogbm90IG9uIHRoZSBsb2csIHNvIGEgbGFwdG9wXG4gKiAgICAgIGxpZCBubyBsb25nZXIgd2FrZXMgYSBgLS1vbmNlYCwgYW5kIGltYWdvJ3MgZ3JlcCBubyBsb25nZXIgc2hvd3MgYVxuICogICAgICBgdGFpbC53b2tlYCB3aXRoIG5vdGhpbmcgYWJvdmUgaXQuXG4gKiBENCDCtyBBIEhVTUFOJ1MgV0FUQ0ggSEFTIE5PIFdJTkRPVy4gYGdyYXBldmluZSB0YWlsIC0taHVtYW5gIHBhc3Nlc1xuICogICAgICBgd2luZG93TXM6IDBgOyBubyBvdGhlciBzcGVsbCBoYXMgYSBodW1hbiBtb2RlLiBFdmVyeSBgdGFpbGAncyBoZWxwXG4gKiAgICAgIGNhcnJpZXMgYFdJTkRPV19IRUxQYCwgd2hpY2ggbmFtZXMgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wYC5cbiAqIEFsc286IGV2ZXJ5IGNvbWUtYmFjayBjb21tYW5kIGNhcnJpZXMgYC0tbm8tb3BlbmAsIHNvIHJ1bm5pbmcgaXQgb3BlbnMgbm9cbiAqIGJyb3dzZXIgdGFiLlxuICpcbiAqIOKaoCBLTk9XTiBFREdFLCBOT1QgRklYRUQgKGZvdW5kIGJ5IHRoZSByZS1yZXZpZXcpOiBhIGtleWVkIGJvdW50eSBGSVJTVCBhcm1cbiAqICAgKGFuIGFudGhpbGwgc2VhdCkgd2hvc2Ugd2luZG93IGVuZHMgYmVmb3JlIGl0cyBib2FyZCBldmVyIG9wZW5zIHByaW50cyBhXG4gKiAgIHJlLWFybSBwaW5uZWQgdG8gdGhlIGRlcml2ZWQgaWQgd2l0aCBhbiBlbXB0eSBib29rbWFya1xuICogICAoYC0tc2Vzc2lvbiBrLeKApiAtLXNpbmNlPS0xIC0tb25jZWApLiBUaGF0IHJlLWFybSBpcyBhIHJlLWFybSBieSBEMSdzIHJ1bGUsXG4gKiAgIHNvIGlmIHRoZSBib2FyZCBpcyBzdGlsbCBub3QgdXAg4oCUIHRoZSBsZWFkIG1vcmUgdGhhbiBvbmUgd2luZG93ICgyOSBtaW4pXG4gKiAgIGxhdGUg4oCUIHRoZSBzZWF0IGRvZXMgbm90IHdhaXQuIE1pbm9yOiB0aGUgbmV4dCBzdGVwIGl0IG5hbWVzXG4gKiAgIChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKSBpcyB0aGUgcmlnaHQgb25lIGFueXdheS4gU2luY2UgIzk4ICgyMDI2LTA5LTI3KVxuICogICBpdCBubyBsb25nZXIgc2F5cyBgdGFpbC5jbG9zZWRgIGFib3V0IGEgYm9hcmQgdGhhdCBuZXZlciBvcGVuZWQ6IGEgbmFtZWRcbiAqICAgYC0tc2Vzc2lvbmAgd2l0aCBubyBzbmFwc2hvdCBvbiBkaXNrIGV4aXRzIGBub3RfZm91bmRgIGFmdGVyIGEgZ3JhY2UuXG4gKlxuICog4pSA4pSAIFRIRSBDT01NQU5EIE5BTUVTIE5PIFBBVEggKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBsaW5lJ3MgYGNvbW1hbmRgIGlzIHRoZSBWRVJCIEFORCBJVFMgQVJHVU1FTlRTIE9OTFlcbiAqIChgdGFpbCAtLXNlc3Npb24gWCAtLXNpbmNlIE5ARSAtLW9uY2VgKSwgcGx1cyBgc3BlbGxgLCBhbmQgdGhlIGFnZW50IHJ1bnMgaXRcbiAqIHdpdGggSVRTIE9XTiBsYXVuY2hlciwgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHNgLiBJdCB1c2VkXG4gKiB0byBiZSBydW5uYWJsZSBhcyBwcmludGVkLCBoZWFkZWQgYnkgYGJ1biA8YXJndlsxXT5gIOKAlCBhbmQgZm9yIGFuIGluc3RhbGxlZFxuICogcGx1Z2luIGBhcmd2WzFdYCBpcyBpbnNpZGUgYSBWRVJTSU9ORUQgY2FjaGUgZGlyZWN0b3J5LiBBbiB1cGdyYWRlIG1hcmtzIHRoZVxuICogb2xkIGRpcmVjdG9yeSBvcnBoYW5lZCBhbmQgZGVsZXRlcyBpdCBsYXRlciAobWVhc3VyZWQgaW5cbiAqIGBkb2NzL2l0ZW1zL3RhaWwtcmVhcm0tY29tbWFuZC1uYW1lcy1hLXZlcnNpb25lZC1wbHVnaW4tcGF0aC5tZGApLFxuICogc28gYSBsaW5lIHByaW50ZWQgYmVmb3JlIGFuIHVwZ3JhZGUgZmlyc3QgcmFuIFNUQUxFIGNvZGUgYWdhaW5zdCBhIG5ld2VyXG4gKiBkYWVtb24sIHRoZW4gZmFpbGVkIHdpdGggXCJtb2R1bGUgbm90IGZvdW5kXCIgb25jZSB0aGUgZGlyZWN0b3J5IHdhcyBnb25lLiBOb1xuICogc3RhYmxlIHBhdGggZXhpc3RzIHRvIHByaW50IGluc3RlYWQ6IHRoZSBjYWNoZSwgYCRDTEFVREVfUExVR0lOX1JPT1RgIGFuZCB0aGVcbiAqIGluc3RhbGwgcmVjb3JkIGFyZSBhbGwgdmVyc2lvbmVkLlxuICogICBUaGUgc2tpbGwncyBsYXVuY2hlciBpcyBhbHdheXMgdGhlIHZlcnNpb24gdGhlIHNlc3Npb24gbG9hZGVkLiBDb2xlJ3NcbiAqIHJlYXNvbmluZzogdGhlIHdvcnN0IGNhc2UgaXMgdGhhdCB0aGUgQ0xJIGNoYW5nZWQgYW5kIHRoZSBhZ2VudCBnZXRzIGFuXG4gKiBlcnJvciDigJQgYW5kIGlmIHRoZSB0b29scyBhcmUgZGVzaWduZWQgcmlnaHQsIHRoYXQgZXJyb3Igc2F5cyB3aGF0IHdlbnRcbiAqIHdyb25nLiBTbyB0aGUgcGFyc2VycyBhcmUgdGhlIG90aGVyIGhhbGYgb2YgdGhpcyBydWxpbmc6IGByZWFkU2luY2VgIHJlZnVzZXNcbiAqIGFueSBgLS1zaW5jZWAgZm9ybSBhIHRhaWwgZG9lcyBub3QgYWNjZXB0IHdpdGggYSB1c2FnZSBlcnJvciBOQU1JTkcgdGhlXG4gKiBmb3JtcyBpdCBkb2VzLCB0aGUgc2FtZSB3YXkgb24gYWxsIGVpZ2h0IHRhaWxzLCBpbnN0ZWFkIG9mIG1pc3BhcnNpbmcgaXQuXG4gKiAgIE5vdCB0YWtlbjogcHJpbnRpbmcgdGhlIHBhdGggQU5EIHRoZSBhcmdzIChvcHRpb24gQSBvZiB0aGUgaXRlbSDigJQgdHdvXG4gKiBjb21tYW5kcyB3aGVyZSBvbmUgaXMgd3JvbmcgYWZ0ZXIgYW4gdXBncmFkZSk7IGEgbGF1bmNoZXIgdGhhdCBub3RpY2VzIGl0IGlzXG4gKiBvcnBoYW5lZCBhbmQgcmUtZXhlY3MgYSBuZXdlciBzaWJsaW5nIChCIOKAlCBpdCBsZWFucyBvbiBhIENsYXVkZSBDb2RlXG4gKiBpbnRlcm5hbCBtYXJrZXIgYW5kIGRvZXMgbm90aGluZyBvbmNlIHRoZSBkaXJlY3RvcnkgaXMgZGVsZXRlZCk7IHZlcnNpb25cbiAqIG5lZ290aWF0aW9uLlxuICpcbiAqIOKUgOKUgCBNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFMgKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L21pbmQtbWFwcGVyLXF1aWV0LWhhbmRvZmZgLiBJdCBSRVZFUlNFUyB0aGUgaW1wbGVtZW50ZXInc1xuICogcnVsaW5nIG9mIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdGhhdCBtaW5kLW1hcHBlciBpcyBhIHByZXNlbmNlIHNwZWxsXG4gKiAoaXRzIGRhZW1vbiBjb3VudHMgYW4gb3BlbiBTU0UgdGFpbCBhcyB0aGUgYWdlbnQgcHJlc2VudCwgc28gdGhlIHdpbmRvd1xuICogYWx3YXlzIHJlLWFybWVkIE1vbml0b3IpLiBDb2xlJ3MgcmVhc29uaW5nOiBtaW5kLW1hcHBlciBzZXNzaW9ucyBhcmUgdXNlZFxuICogbGlrZSBzY3JpcHRvcml1bSdzLCBidXJzdHMgb2YgYWN0aXZpdHkgd2l0aCBicmVha3MsIGFuZCBpbiBhIGJyZWFrIHRoZSBhZ2VudFxuICogc2hvdWxkIG5vdCBiZSB3b2tlbiBldmVyeSAzMCBtaW51dGVzLiBTbyBtaW5kLW1hcHBlciB0YWtlcyB0aGUgcXVpZXQgaGFuZG9mZlxuICogdG8gYC0tb25jZWAsIHRoZSBsb3N0IGNvbWUtYmFjayAoYG9wZW4gLS1uby1vcGVuYCksIGFuZCBrZWVwcyBpdHNcbiAqIGAtLXNpbmNlIE5AZXBvY2hgIGJvb2ttYXJrLiBUaHJlZSB0aGluZ3MgaGFkIHRvIGJlIHNldHRsZWQgdG8gbWFrZSB0aGF0XG4gKiBob25lc3QsIGVhY2ggcGlubmVkIGluIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC97dGFpbCxwcmVzZW5jZX0udGVzdC50c2BcbiAqIGFuZCBtdXRhdGlvbi1jb25maXJtZWQ6XG4gKlxuICogTTEgwrcgUFJFU0VOQ0UgTElOR0VSUyBBQ1JPU1MgVEhFIEdBUFMgKHRoZSBkYWVtb24sIGBzZXJ2ZXIudHNgXG4gKiAgICAgIGBhZGp1c3RBZ2VudHNgKS4gQSBvbmUtc2hvdCBob2xkcyBhbiBTU0UgY29ubmVjdGlvbiwgc28gaXQgQ09VTlRTIGFzXG4gKiAgICAgIHByZXNlbnQsIHdoaWNoIGlzIHRydWU6IHRoZSBhZ2VudCB3aWxsIHdha2Ugb24gdGhlIG5leHQgZXZlbnQuIFRoZSBnYXBzXG4gKiAgICAgIGFyZSB0aGUgcHJvYmxlbTogd2luZG93IOKGkiByZS1hcm0sIHF1aWV0IOKGkiBgLS1vbmNlYCwgYW5kIGFib3ZlIGFsbFxuICogICAgICBgdGFpbC53b2tlYCDihpIgdGhlIGFnZW50IGhhbmRsZXMgdGhlIGV2ZW50IOKGkiBNb25pdG9yLCB3aGljaCBsYXN0cyB0aGVcbiAqICAgICAgYWdlbnQncyB3aG9sZSB0dXJuLiBSYXcsIHRoZSBzdXJmYWNlJ3MgaGVhZGVyIGRvdCAodGhlIG9ubHkgdGhpbmdcbiAqICAgICAgcHJlc2VuY2UgZHJpdmVzIHRoZXJlLCBiZXNpZGVzIHRoZSBkYWVtb24ncyBhdXRvLWByZWNlaXZlZGAgZmxpcCBvbiBhXG4gKiAgICAgIGh1bWFuIG1lc3NhZ2UpIHJlYWQgXCJjb25uZWN0ZWQg4oCUIG5vIGFnZW50IG9uIHRoaXMgcHJvamVjdFwiIHdoaWxlIHRoZVxuICogICAgICBhZ2VudCB3YXMgd29ya2luZyB0aGUgYm9hcmQsIGFuZCBhIG1lc3NhZ2Ugc2VudCB0aGVuIGdvdCBub1xuICogICAgICBgcmVjZWl2ZWRgLiBUaGUgZGFlbW9uIGhhcyBubyBpZGxlIGNsb3NlLCBzbyBub3RoaW5nIGVsc2UgcmVhY3RzLiBOb3dcbiAqICAgICAgdGhlIGNvdW50IEhPTERTIGZvciBgTUlORF9NQVBQRVJfUFJFU0VOQ0VfTElOR0VSX01TYCAoMTUwIHMsIHRoZSBzdGFsbFxuICogICAgICB3aW5kb3cncyBiZWF0KSBhZnRlciB0aGUgbGFzdCB0YWlsIGNsb3NlczogYSB0YWlsIG9wZW5pbmcgaW5zaWRlIGl0XG4gKiAgICAgIGVtaXRzIG5vdGhpbmcsIGFuIGFnZW50LW9ubHkgd3JpdGUgKGAvYWN0aXZpdHlgLCBhbiBhZ2VudCBgL3NlbmRgKVxuICogICAgICByZXN0YXJ0cyBpdCwgYW5kIHNpbGVuY2UgcGFzdCBpdCBkcm9wcyB0aGUgY291bnQgdG8gMC5cbiAqICAgICAg4pqWIE5vdCB0YWtlbjogcmUtYXJtaW5nIE1vbml0b3IgQkVGT1JFIGhhbmRsaW5nIGEgd29rZW4gZXZlbnQgKHRoYXQgaXNcbiAqICAgICAgdGhlIHNoYXJlZCBydWxlLCB3b3JkLWZvci13b3JkIGluIGV2ZXJ5IHNwZWxsKTsgcmVmcmVzaGluZyBvbiBldmVyeVxuICogICAgICBib2FyZCB3cml0ZSAodGhlIGJyb3dzZXIgUE9TVHMgdGhlIHNhbWUgcm91dGVzLCBzbyB0aGUgaHVtYW4ncyBvd25cbiAqICAgICAgY2xpY2tzIHdvdWxkIGtlZXAgdGhlIGRvdCBsaXQpLiBDb3N0OiBhbiBhZ2VudCB0aGF0IHJlYWxseSBsZWZ0IHJlYWRzXG4gKiAgICAgIFwiaGVyZVwiIGZvciB1cCB0byAxNTAgcy5cbiAqIE0yIMK3IGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBOT1QgQ09VTlRFRCAobWluZC1tYXBwZXIncyBgY291bnRzYCkuIEl0IGlzIE9OXG4gKiAgICAgIFRIRSBMT0csIHdpdGggYW4gaWQsIGFuZCBhIHRhaWwncyBvd24gY29ubmVjdCBlbWl0cyBvbmUgb250byBpdHMgb3duXG4gKiAgICAgIHN0cmVhbSwgc28gY291bnRlZCBpdCBtYWRlIGV2ZXJ5IHdpbmRvdyBcImFjdGl2ZVwiIGFuZCB3b3VsZCB3YWtlIGV2ZXJ5XG4gKiAgICAgIGAtLW9uY2VgIG9uIGl0c2VsZi4gVGhlIGxpbmdlciByZW1vdmVzIG1vc3Qgb2YgdGhhdCBjaHVybjsgYGNvdW50c2BcbiAqICAgICAgcmVtb3ZlcyB0aGUgcmVzdCAoYSBmaXJzdCBhcm0sIGFub3RoZXIgYWdlbnQgY29taW5nIG9yIGdvaW5nKS5cbiAqIE0zIMK3IEEgREVBRCBEQUVNT04gSVMgTE9TVCwgTk9UIFVOUkVTT0xWRUQgKG1pbmQtbWFwcGVyJ3MgYHJlc29sdmVgKS4gSXRzXG4gKiAgICAgIGRpc2NvdmVyeSBwcm9iZXMgdGhlIGRhZW1vbidzIHBpZCwgc28gYSBraWxsZWQgZGFlbW9uIG1hZGUgYHJlc29sdmVgXG4gKiAgICAgIGFuc3dlciBudWxsIGFuZCBhbiB1bnJlc29sdmVkIHRhaWwgcmV0cmllcyBmb3JldmVyOiBhIGAtLW9uY2VgIHdvdWxkXG4gKiAgICAgIGhhdmUgc2xlcHQgZm9yIGdvb2QgKEQxJ3MgZGVmZWN0KS4gVGhlIHRhaWwga2VlcHMgdGhlIGxhc3QgVVJMIGl0XG4gKiAgICAgIHJlc29sdmVkLCBzbyB0aGUgZGVhZCBwb3J0IHJlZnVzZXMgYW5kIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBlbmRzIGl0XG4gKiAgICAgIHdpdGggYHRhaWwubG9zdGAg4oaSIGBvcGVuIC0tbm8tb3BlbmAsIHRoZW4gYSB0YWlsIHdpdGggbm8gYC0tc2luY2VgLlxuICogICAgICBNaW5kLW1hcHBlciBoYXMgbm8gc2Vzc2lvbiB0byBjbG9zZSwgc28gaXQgbmV2ZXIgcHJpbnRzIGB0YWlsLmNsb3NlZGAuXG4gKiAgICAgIE1lYXN1cmVkIG9uIGEgcmVhbCBga2lsbCAtOWAgdW5kZXIgYSBgLS1vbmNlYDogYHRhaWwubG9zdGAgNyBzIGxhdGVyLFxuICogICAgICBub3QgMC43NSBzLCBiZWNhdXNlIG1pbmQtbWFwcGVyJ3Mgb3duIGJhY2tvZmYgc3RhcnRzIGF0IDEgcyAoMSArIDIgKyA0KS5cbiAqICAgICAgTTHigJNNMyB3ZXJlIGRyaXZlbiBvbiBhIHJlYWwgZGFlbW9uIHdpdGggYSA0IHMgd2luZG93OiBhY3RpdmUg4oaSIHdpbmRvdyxcbiAqICAgICAgcXVpZXQg4oaSIGAtLW9uY2VgLCBhIGh1bWFuIG1lc3NhZ2Ugd29rZSBpdCwgYmFjayB0byBNb25pdG9yOyBwcmVzZW5jZVxuICogICAgICBuZXZlciBkcm9wcGVkIGFjcm9zcyB0aGUgZ2Fwcy5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBDT01QTEVURSBCVVQgRk9SIFRIRSBMQVVOQ0hFUjogcGlubmVkIHRvIHRoZVxuICogICBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGUgc2tpbGxzIG5hbWUgdGhlXG4gKiAgIHJ1bGUgb25jZSwgbGF1bmNoZXIgZm9ybSBpbmNsdWRlZDsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICpcbiAqIFMxIMK3IFdITyBDTE9TRUQgSVQgUklERVMgVEhFIExJTkUgKHNjcmlwdG9yaXVtJ3MgRW5kIHNlc3Npb24sIDIwMjYtMTAtMDEpLlxuICogICAgICBBIHNwZWxsIHdob3NlIGBjbG9zZWRgIGZyYW1lIHNheXMgd2hvIGVuZGVkIHRoZSBzZXNzaW9uIHBhc3Nlc1xuICogICAgICBgY2xvc2VkQnlgLCBhbmQgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzIGBieWAuIGBieTogXCJodW1hblwiYCBjaGFuZ2VzXG4gKiAgICAgIHRoZSBoaW50OiB0aGUgaHVtYW4gZW5kZWQgaXQgT04gUFVSUE9TRSwgc28gdGhlIGFnZW50IHN0b3BzIGFuZCBkb2VzIG5vdFxuICogICAgICByZW9wZW4gdW5sZXNzIGFza2VkIOKAlCB0aGUgd2F5IGJhY2sgaXMgc3RpbGwgbmFtZWQsIGNvbmRpdGlvbmVkIG9uIHRoYXQuXG4gKiAgICAgIFRoZSBhZ2VudCByb3V0ZXMgb24gYGJ5YCwgbmV2ZXIgb24gdGhlIGhpbnQncyBwcm9zZS4gQSByZS1hcm0gYWZ0ZXJcbiAqICAgICAgdGhlIGVuZCBzZWVzIG5vIGNsb3NpbmcgZnJhbWUgKEQxJ3MgcGF0aCksIHNvIHRoZSBzcGVsbCBhbHNvIHBhc3Nlc1xuICogICAgICBgZ29uZUJ5YCwgcmVhZCBmcm9tIHdoZXJlIHRoZSBmYWN0IG91dGxpdmVzIHRoZSBkYWVtb247IHdpdGhvdXQgaXQgdGhlXG4gKiAgICAgIHJlLWFybWVkIGxpbmUgZHJvcHBlZCBgYnlgIGFuZCBpbnZpdGVkIHRoZSByZW9wZW4gKHZlcmlmaWVyLCAyMDI2LTEwLTAxKS5cbiAqICAgICAg4pqWIE9wdGlvbnMgbm90IHRha2VuOiBhIHNwZWxsLXNpZGUgcmV3cml0ZSBvZiB0aGUgcHJpbnRlZCBsaW5lIChhIHNlY29uZFxuICogICAgICB3cml0ZXIgb2YgdGhlIHNhbWUgbGluZSksIG9yIGEgc3BlbGwtc3VwcGxpZWQgaGludCAoZWFjaCBzcGVsbCB3b3VsZFxuICogICAgICB3b3JkIFwib24gcHVycG9zZVwiIGl0cyBvd24gd2F5KS5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICAvKiogV2hvIGVuZGVkIGEgYGNsb3NlZGAgc2Vzc2lvbiwgd2hlbiBpdHMgY2xvc2luZyBmcmFtZSBzYWlkIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGB0YWlsLmNsb3NlZGAgb25seTogd2hvIGVuZGVkIHRoZSBzZXNzaW9uLCB3aGVuIHRoZSBzcGVsbCBzYXlzIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICAvKiogYG1vbml0b3JgOiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYC5cbiAgICogIGBiYWNrZ3JvdW5kYDogcnVuIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrLlxuICAgKiAgYHN0b3BgOiBub3RoaW5nIHRvIHdhdGNoOyBgY29tbWFuZGAgaXMgaG93IHRvIGNvbWUgYmFjaywgaWYgd2FudGVkLiAqL1xuICBuZXh0OiBcIm1vbml0b3JcIiB8IFwiYmFja2dyb3VuZFwiIHwgXCJzdG9wXCI7XG4gIC8qKiBUaGUgdmVyYiBhbmQgaXRzIGFyZ3VtZW50cyBPTkxZIOKAlCBubyBsYXVuY2hlciwgbm8gcGF0aC4gVGhlIGFnZW50IHJ1bnNcbiAgICogIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPmAuICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgaGludDogc3RyaW5nO1xufTtcblxuLyoqIEhvdyB0aGUgYWdlbnQgcnVucyBhIHByaW50ZWQgYGNvbW1hbmRgOiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIG5ldmVyIGEgcGF0aFxuICogIHRoaXMgcHJvY2VzcyBuYW1lcyAodGhlIHJ1bGluZyBvbiB0aGUgdmVyc2lvbmVkIHBsdWdpbiBwYXRoLCBpbiB0aGUgaGVhZGVyKS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fV0lUSF9MQVVOQ0hFUiA9IFwiYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5cIjtcblxuLyoqIFRoZSBjb21lLWJhY2sgaGludCwgd2l0aCBob3cgdG8gUkVTVU1FIGFmdGVyIGNvbWluZyBiYWNrIChEMik6IGEgcmVzdG9yZWRcbiAqICBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBtZWFucyBub3RoaW5nIHRoZXJlLiAqL1xuY29uc3QgQ09NRV9CQUNLID0gKHdoeTogc3RyaW5nLCBsZWFkID0gXCJUbyBicmluZyBpdCBiYWNrXCIpID0+XG4gIGAke3doeX0gJHtsZWFkfSwgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9OyB0aGVuIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vIC0tc2luY2UsIG9uIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cyB3aGVyZSB0aGVyZSBpcyBvbmUgKGEgcmVzdGFydGVkIGRhZW1vbiBzdGFydHMgYSBuZXcgZXZlbnQgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIGRvZXMgbm90IGFwcGx5KWA7XG5cbi8qKlxuICogVEhFIERFQ0lTSU9OOiBnaXZlbiBob3cgdGhlIHRhaWwgZW5kZWQsIHdoaWNoIGxpbmUgaXQgcHJpbnRzLiBQdXJlLCBzbyBldmVyeVxuICogc3RhdGUgaXMgYSBsaXRlcmFsIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLiBSZXR1cm5zIG51bGwgZm9yIGBzdG9wcGVkYDpcbiAqIGEgaHVtYW4ncyBDdHJsLUMgb3IgYSBjYWxsZXIncyBhYm9ydCBpcyBub3QgYSBoYW5kb2ZmLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFuZG9mZihzOiBIYW5kb2ZmSW5wdXQsIGNtZDogSGFuZG9mZkNvbW1hbmRzKTogSGFuZG9mZkxpbmUgfCBudWxsIHtcbiAgY29uc3QgYmFzZSA9IHsgc3BlbGw6IHMuc3BlbGwsIGV2ZW50czogcy5ldmVudHMsIGN1cnNvcjogcy5jdXJzb3IgfTtcbiAgc3dpdGNoIChzLmVuZCkge1xuICAgIGNhc2UgXCJzdG9wcGVkXCI6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBjYXNlIFwiY2xvc2VkXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwuY2xvc2VkXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIC4uLihzLmJ5ID8geyBieTogcy5ieSB9IDoge30pLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgcy5ieSA9PT0gXCJodW1hblwiXG4gICAgICAgICAgICA/IENPTUVfQkFDSyhcbiAgICAgICAgICAgICAgICBcInRoZSBodW1hbiBlbmRlZCB0aGlzIHNlc3Npb24gb24gcHVycG9zZTsgc3RvcCB3YXRjaGluZywgYW5kIGRvIG5vdCByZW9wZW4gaXQgdW5sZXNzIHRoZXkgYXNrLlwiLFxuICAgICAgICAgICAgICAgIFwiSWYgdGhleSBhc2tcIixcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgOiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLS1zaW5jZT0tMSBmb3IgZXZlcnl0aGluZylcIlxuICAgICAgOiBgYW4gZXZlbnQgaWQgKGFuIGludGVnZXIsICR7bWlufSBvciBtb3JlKWA7XG4gIGNvbnN0IGZvcm1zID0gby5lcG9jaCA/IGAke2lkfSwgb3IgPGlkPkA8ZXBvY2g+IGFzIGEgaGFuZG9mZiBsaW5lIHByaW50cyBpdGAgOiBpZDtcbiAgY29uc3Qgd2h5ID1cbiAgICAhby5lcG9jaCAmJiB0b2tlbi5pbmNsdWRlcyhcIkBcIilcbiAgICAgID8gYDsgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgbm8gZXBvY2gsIHNvIHBhc3MgdGhlIGlkIHdpdGhvdXQgdGhlIFwiQOKAplwiIHBhcnRgXG4gICAgICA6IFwiXCI7XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIG1lc3NhZ2U6IGAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMg4oCUIGdpdmUgJHtmb3Jtc30ke3doeX1gLFxuICB9O1xufVxuXG4vKiogSm9pbiBhbiBhcmd2IGludG8gb25lIHJ1bm5hYmxlIGNvbW1hbmQgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kTGluZShhcmd2OiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBhcmd2Lm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOW0BlcG9jaF0gWy0tb25jZV1gLlxuICogIFBhc3MgYGVwb2NoYCBvbmx5IGZvciBhIHNwZWxsIHdob3NlIGAtLXNpbmNlYCBwYXJzZXMgaXQgKGBwYXJzZUJvb2ttYXJrYCkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQoXG4gIHByZWZpeDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHNpbmNlOiBudW1iZXIsXG4gIG9uY2U6IGJvb2xlYW4sXG4gIGVwb2NoPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgbWFyayA9IGVwb2NoID8gYCR7c2luY2V9QCR7ZXBvY2h9YCA6IFN0cmluZyhzaW5jZSk7XG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7bWFya31gXSA6IFtcIi0tc2luY2VcIiwgbWFya107XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICAvKiogVGhlIHNwZWxsJ3MgbmFtZSwgY2FycmllZCBvbiB0aGUgbGluZSAod2hvc2UgbGF1bmNoZXIgcnVucyBpdCkuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogQSBwcmVzZW5jZSBzcGVsbDogYWx3YXlzIGB0YWlsLndpbmRvd2AgYXQgdGhlIHdpbmRvdydzIGVuZCwgbmV2ZXIgbG9zdC4gKi9cbiAgcHJlc2VuY2U6IGJvb2xlYW47XG4gIC8qKiBEZWZhdWx0OiBgcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKWAuIGAwYCA9IG5vIHdpbmRvdy4gKi9cbiAgd2luZG93TXM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIGFuIGVtaXR0ZWQgZnJhbWUgaXMgYSBMT0cgZnJhbWUgKEEzKS4gRGVmYXVsdDogZXZlcnkgb25lLiAqL1xuICBjb3VudHM/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBXaGljaCB0ZXJtaW5hbCBmcmFtZSBtZWFucyB0aGUgc2Vzc2lvbiBjbG9zZWQuIERlZmF1bHQ6IGV2ZXJ5IHRlcm1pbmFsLiAqL1xuICBpc0Nsb3NlZD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBXaG8gdGhlIGNsb3NpbmcgZnJhbWUgc2F5cyBlbmRlZCB0aGUgc2Vzc2lvbiAoUzEpOyBjYXJyaWVkIG9uIGB0YWlsLmNsb3NlZGAuICovXG4gIGNsb3NlZEJ5PzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogV2hvIGVuZGVkIGEgc2Vzc2lvbiBmb3VuZCBHT05FIChEMTogcmUtYXJtZWQgYWZ0ZXIgaXQgY2xvc2VkLCBzbyBub1xuICAgKiAgY2xvc2luZyBmcmFtZSBpcyBldmVyIHNlZW4pLCByZWFkIGZyb20gd2hlcmV2ZXIgdGhlIHNwZWxsIGtlZXBzIGl0IOKAlCBhXG4gICAqICBtYW5pZmVzdCB0aGF0IG91dGxpdmVzIHRoZSBkYWVtb24uIENhcnJpZWQgb24gYHRhaWwuY2xvc2VkYCBhcyBgYnlgLCBzb1xuICAgKiAgdGhlIGxpbmUgc2F5cyB3aGF0IHRoZSBsaXZlIHBhdGgncyBgY2xvc2VkQnlgIHdvdWxkIGhhdmUgKFMxKS4gKi9cbiAgZ29uZUJ5PzogKCkgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gdGFpbC5zaW5jZUVwb2NoO1xuICBsZXQgZnJhbWVIYXNJZCA9IGZhbHNlO1xuICAvKiogQTMgKyBEMzogYSBmcmFtZSBjb3VudHMsIGFuZCB3YWtlcyBhIGAtLW9uY2VgLCBvbmx5IHdoZW4gaXQgaXMgT04gVEhFXG4gICAqICBMT0cg4oCUIGl0IGNhcnJpZXMgYSBsb2cgaWQg4oCUIGFuZCB0aGUgc3BlbGwncyBvd24gYGNvdW50c2AgYWdyZWVzLiBBIHRhYidzXG4gICAqICBpZC1sZXNzIGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgIHBpbmcgaXMgbm90IG9uIHRoZSBsb2cuICovXG4gIGNvbnN0IGlzTG9nRnJhbWUgPSAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGZyYW1lSGFzSWQgJiYgY291bnRzKGV2LCBmcmFtZSk7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZEJ5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICAvLyBEMidzIG5ldC4gT24gZm9yIGV2ZXJ5IHNwZWxsOiBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3JcbiAgICAgIC8vIG1lYW5zIGEgd2hvbGUgcmVwbGF5IG9uIHRoZSBraXQncyBsb2csIGFuZCBvbiBncmFwZXZpbmUncyBkdXJhYmxlIGxvZ1xuICAgICAgLy8gaXQgaGFwcGVucyBvbmx5IHdoZW4gYC0tbGFzdGAgcmVhY2hlcyBiZWxvdyBgLS1zaW5jZWAsIHdoZXJlXG4gICAgICAvLyByZS1yZWFkaW5nIHRoZSBjdXJzb3IgZnJvbSB0aGUgZnJhbWVzIGlzIHRoZSBtb3JlIGNvcnJlY3QgYW5zd2VyLlxuICAgICAgcmVzdGFydE9uUmVwbGF5OiB0cnVlLFxuICAgICAgLy8gRDM6IHJlbWVtYmVyIHdoZXRoZXIgVEhJUyBmcmFtZSBjYXJyaWVzIGEgbG9nIGlkLiBgdGFpbEV2ZW50c2AgcmVhZHNcbiAgICAgIC8vIHRoZSBjdXJzb3Igb25jZSBwZXIgZnJhbWUsIGJlZm9yZSBgYWNjZXB0YCwgYHRlcm1pbmFsYCBhbmQgYHJlbmRlcmAuXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGNvbnN0IG4gPSB0YWlsLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICBmcmFtZUhhc0lkID0gdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pO1xuICAgICAgICByZXR1cm4gbjtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCB0aGF0IGdpdmVzIHVwIG9uIGZpbmRpbmcgaXRzIHNlc3Npb24gaXMgd2F0Y2hpbmcgYVxuICAgICAgICAvLyBzZXNzaW9uIHRoYXQgaXMgZ29uZSDigJQgd2hldGhlciB0aGlzIHByb2Nlc3MgZXZlciByZWFjaGVkIGl0IChpdHNcbiAgICAgICAgLy8gcG9pbnRlciB2YW5pc2hlZCkgb3IgaXQgd2FzIHJlLWFybWVkIGF0IG9uZSB0aGF0IGNsb3NlZCBpbiB0aGUgZ2FwLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgZW5kID0gXCJjbG9zZWRcIjtcbiAgICAgICAgICBjbG9zZWRCeSA9IGguZ29uZUJ5Py4oKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSBldmVudHMgKz0gMTtcbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgdGVybWluYWw6IChldiwgZnJhbWUsIGFjY2VwdGVkKSA9PiB7XG4gICAgICAgIGlmICh0YWlsLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgICBlbmQgPSAoaC5pc0Nsb3NlZCA/PyAoKCkgPT4gdHJ1ZSkpKGV2KSA/IFwiY2xvc2VkXCIgOiBcImV2ZW50XCI7XG4gICAgICAgICAgICBpZiAoZW5kID09PSBcImNsb3NlZFwiKSBjbG9zZWRCeSA9IGguY2xvc2VkQnk/Lihldik7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIGVwb2NoID0gcy5lcG9jaCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICAuLi4oY2xvc2VkQnkgPyB7IGJ5OiBjbG9zZWRCeSB9IDoge30pLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSksXG4gICAgICAgIHByZXNlbmNlOiBoLnByZXNlbmNlLFxuICAgICAgICBzcGVsbDogaC5zcGVsbCxcbiAgICAgIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7QUFnREE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBV0E7QUFDQTs7O0FDSUE7OztBQzFDTyxTQUFTLFNBQVMsQ0FBQyxNQUFxQjtBQUFBLEVBQzdDLFFBQVEsT0FBTyxNQUFNLEdBQUcsS0FBSyxVQUFVLElBQUk7QUFBQSxDQUFLO0FBQUE7OztBQzZCM0MsSUFBTSxXQUFvQztBQUFBLEVBQy9DLE9BQU87QUFBQSxFQUNQLFVBQVU7QUFBQSxFQUNWLFdBQVc7QUFBQSxFQUNYLFVBQVU7QUFDWjtBQWlDQSxJQUFJLGlCQUFnQztBQUU3QixTQUFTLGlCQUFp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
