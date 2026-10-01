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
    text = readFileSync(path, "utf8");
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

//# debugId=BE0E929291B7AC2564756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgKHRoZSBraXQgcmVnaXN0cnkgZGlzcGF0Y2hlcyksIG5vbmUgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAuIFRoZVxuICogc3dhbGxvd2luZyBjYXRjaGVzIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2AsIGBwb3N0Q21kYCdzIGNsb3NlXG4gKiBFQ09OTlJFU0VUKSBjb250YWluIG5vIGRpZS1yZWFjaGFibGUgY2FsbC5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgc3RhdFN5bmMsXG4gIHVubGlua1N5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0eXBlIENvbW1hbmRTcGVjLCBkZWZpbmVDbGksIHR5cGUgSW52b2NhdGlvbiB9IGZyb20gXCIuLi8uLi9raXQvY2xpL3JlZ2lzdHJ5XCI7XG5pbXBvcnQgeyBwcmludEpzb24gfSBmcm9tIFwiLi4vLi4va2l0L2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHR5cGUgRXJyS2luZCwgcmVwb3J0Q2xpRXJyb3IgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQge1xuICBjb21tYW5kTGluZSxcbiAgcmVhZFNpbmNlLFxuICB0YWlsQ29tbWFuZCxcbiAgdGFpbFdpdGhIYW5kb2ZmLFxuICBXSU5ET1dfSEVMUCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IERPQ19FWFRFTlNJT05TLCBpc0RvY05hbWUgfSBmcm9tIFwiLi90cmVlXCI7XG5cbi8vIOKaoCBERUNMQVJFRCBGSVJTVCwgQUJPVkUgRVZFUlkgT1RIRVIgRlVOQ1RJT04sIE9OIFBVUlBPU0UuIFRoZSBgY2hvaWNlc2Bcbi8vIGNlbnN1cydzIHJhaXNlciBydWxlIChhKSAoYGdyaW1vaXJlL2xpYi9lcnJvci1zaXRlcy50c2ApIG1hdGNoZXNcbi8vIGBmdW5jdGlvbiBOQU1FKGAgbGF6aWx5IHVwIHRvIHRoZSBuZXh0IGApOiBuZXZlcmAgd2l0aGluIDYwMCBjaGFyYWN0ZXJzLCBzb1xuLy8gQU5ZIGZ1bmN0aW9uIGRlY2xhcmVkIHNob3J0bHkgYWJvdmUgdGhpcyBvbmUg4oCUIGBhcGlgLCB0aGVuIGByZXF1aXJlU2Vzc2lvbmAg4oCUXG4vLyB3YXMgcmVhZCBhcyBhIHJhaXNlciBhbmQgaXRzIGNhbGxzIGNvdW50ZWQgYXMgcmFpc2Ugc2l0ZXMgKGZvdW5kIDIwMjYtMDktMTEsXG4vLyByZXBvcnRlZCBpbiB0aGUgc2xpY2UtQSBqb3VybmFsIGFzIGFuIGluc3RydW1lbnQgZGVmZWN0LCBub3QgZml4ZWQgaGVyZSkuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGNvbnN0IGJvZHkgPSAoZGF0YSA/PyB7fSkgYXMgeyBlcnJvcj86IHVua25vd247IGNob2ljZXM/OiB1bmtub3duOyBoaW50PzogdW5rbm93biB9O1xuICBjb25zdCBjaG9pY2VzID0gQXJyYXkuaXNBcnJheShib2R5LmNob2ljZXMpID8gYm9keS5jaG9pY2VzLm1hcChTdHJpbmcpIDogdW5kZWZpbmVkO1xuICAvLyDimqAgVGhlIGRhZW1vbidzIG93biBoaW50LCBmb3J3YXJkZWQuIEEgcmVmdXNhbCB0aGF0IGtub3dzIHdoYXQgdG8gZG8gbmV4dFxuICAvLyB1c2VkIHRvIGRyb3AgdGhhdCBrbm93bGVkZ2Ugb24gdGhlIGZsb29yIGF0IHRoaXMgbGluZS5cbiAgY29uc3QgaGludCA9IHR5cGVvZiBib2R5LmhpbnQgPT09IFwic3RyaW5nXCIgPyBib2R5LmhpbnQgOiB1bmRlZmluZWQ7XG4gIGRpZSh0eXBlb2YgYm9keS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuZXJyb3IgOiBgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBTZXNzaW9ucyB3aG9zZSB3b3JrIGlzIHN0aWxsIG9uIGRpc2ssIG5ld2VzdCBmaXJzdCAoRTU2KS5cbiAqXG4gKiDim5QgQSBERUFEIFNFU1NJT04gSVMgTk9UIEEgTE9TVCBPTkUsIGFuZCB0aGUgQ0xJIHVzZWQgdG8gaW1wbHkgb3RoZXJ3aXNlLiBUaGVcbiAqIG1hbmlmZXN0IGFuZCBldmVyeSB2ZXJzaW9uIGZpbGUgbGl2ZSB1bmRlciB0aGUgaG9tZSwgc28gYSBkYWVtb24gdGhhdCBoYXNcbiAqIGV4aXRlZCDigJQgdGhlIDMwLW1pbnV0ZSBpZGxlIHRpbWVvdXQsIGEgY3Jhc2gsIGEgcmVib290IOKAlCBjb3N0cyB0aGUgVVJMIGFuZFxuICogbm90aGluZyBlbHNlLiBDb2xlIGhpdCBleGFjdGx5IHRoaXMgKFwidGhhdCBsaW5rIGRvZXNuJ3Qgc2VlbSB0byBiZSBsaXZlXG4gKiBhbnltb3JlXCIpIGFuZCB0aGUgb25seSB0aGluZyB0aGUgdG9vbGluZyBzYWlkIHdhcyBcIm5vIHJ1bm5pbmcgc2NyaXB0b3JpdW1cbiAqIHNlc3Npb25cIiwgd2hpY2ggcmVhZHMgbGlrZSB0aGUgd29yayBpcyBnb25lLlxuICovXG5mdW5jdGlvbiByZXN0b3JhYmxlKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoKGUpID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCBlLm5hbWUsIFwibWFuaWZlc3QuanNvblwiKSkpXG4gICAgICAubWFwKChlKSA9PiAoeyBpZDogZS5uYW1lLCBhdDogc3RhdFN5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKS5tdGltZU1zIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYXQgLSBhLmF0KVxuICAgICAgLm1hcCgoZSkgPT4gZS5pZCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogV2hhdCB0byBzYXkgd2hlbiBubyBkYWVtb24gYW5zd2VycyDigJQgaW5jbHVkaW5nIHRoZSB3YXkgYmFjaywgd2hlbiB0aGVyZSBpcyBvbmUuICovXG5mdW5jdGlvbiBub1Nlc3Npb25IaW50KCk6IHsgaGludDogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSB7XG4gIGNvbnN0IGlkcyA9IHJlc3RvcmFibGUoKTtcbiAgY29uc3QgbmV3ZXN0ID0gaWRzWzBdO1xuICBpZiAobmV3ZXN0ID09PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHsgaGludDogXCJubyBzZXNzaW9uIGhhcyBiZWVuIG9wZW5lZCBpbiB0aGlzIGhvbWUgeWV0IOKAlCBydW46IGNsaS50cyBvcGVuIDxwYXRoPlwiIH07XG4gIHJldHVybiB7XG4gICAgLy8g4pqgIFRoZSBDT01NQU5ELCB3aXRoIHRoZSBpZCBhbHJlYWR5IGluIGl0LiBBIGhpbnQgdGhhdCBzYXlzIFwieW91IGNhblxuICAgIC8vIHJlc3RvcmUgYSBzZXNzaW9uXCIgbGVhdmVzIHRoZSByZWFkZXIgdG8gZmluZCB0aGUgaWQgYW5kIGd1ZXNzIHRoZSBmbGFnLlxuICAgIGhpbnQ6IGBubyBkYWVtb24gaXMgcnVubmluZywgYnV0IHRoZSB3b3JrIGlzIG9uIGRpc2sg4oCUIGJyaW5nIGl0IGJhY2sgd2l0aDogY2xpLnRzIG9wZW4gLS1yZXN0b3JlICR7bmV3ZXN0fWAsXG4gICAgY2hvaWNlczogaWRzLnNsaWNlKDAsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gam9pbih0bXBkaXIoKSwgc2Vzc2lvbiA/IGBzY3JpcHRvcml1bS0ke3Nlc3Npb259Lmpzb25gIDogXCJzY3JpcHRvcml1bS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0Ug4oCUIEVOT0VOVCBpcyB0aGUgb25seSBhYnNlbmNlLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb25Qb2ludGVyO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uUG9pbnRlciB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIHNjcmlwdG9yaXVtIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgbm9TZXNzaW9uSGludCgpKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBsZXQgc3RhdHVzOiBudW1iZXI7XG4gIGxldCBkYXRhOiB1bmtub3duO1xuICB0cnkge1xuICAgICh7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgLy8gYGNsb3NlYCBzdG9wcyB0aGUgc2VydmVyOyBhIFJFU0VUIGlzIGl0cyBzdWNjZXNzLiBBIHJlZnVzZWQgY29ubmVjdGlvblxuICAgIC8vIChhIHN0YWxlIHBvaW50ZXIpIGlzIGEgdHJhbnNwb3J0IGZhaWx1cmUgbGlrZSBhbnkgb3RoZXIuXG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBjb25zdCBjb2RlID0gZXJyICYmIHR5cGVvZiBlcnIgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZXJyID8gU3RyaW5nKGVyci5jb2RlKSA6IFwiXCI7XG4gICAgaWYgKG1zZy50eXBlID09PSBcImNsb3NlXCIgJiYgKGNvZGUgPT09IFwiRUNPTk5SRVNFVFwiIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJFQ09OTlJFU0VUXCIpKSlcbiAgICAgIHJldHVybiB7IG9rOiB0cnVlIH07XG4gICAgdGhyb3cgZXJyO1xuICB9XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChTdHJpbmcobXNnLnR5cGUpLCBzdGF0dXMsIGRhdGEpO1xuICByZXR1cm4gZGF0YSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbn1cblxuLy8g4pSA4pSAIHRoZSBmbGFnIHJlZ2lzdHJ5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIFRoZSBvcHRpb25zIHRhYmxlIHRoZSBraXQncyBwYXJzZXIgcmVhZHMgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2AsIHRocm91Z2hcbi8vIGBkZWZpbmVDbGlgIGJlbG93KS4gRXhwb3J0ZWQgc28gYSB0ZXN0IGNhbiBidWlsZCB0aGUgc2FtZSBwYXJzZSB0aGUgQ0xJIGRvZXMuXG5cbmV4cG9ydCBjb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgXCJib2R5LWZpbGVcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJ5OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY29udGV4dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGRvYzogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGVudHJ5OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZm9yOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnJvbTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcXVvdGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZW9wZW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgaHVua3M6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbnRvOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGlmZWN5Y2xlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGltaXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIG9uY2U6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcGF0Y2g6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlc3Npb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIFwic3RhcnQtdGltZW91dFwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RhdHVzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdGFnOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHR5cGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxufSBhcyBjb25zdDtcblxuZXhwb3J0IGNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBDbGlFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSB7XG4gICAgc3VwZXIoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuLyoqXG4gKiBgdGFpbCAtLXNpbmNlYCBpcyBhIEJPT0tNQVJLOiBhbiBldmVudCBpZCAoLTEgZm9yIFwiZXZlcnl0aGluZ1wiKSwgb3B0aW9uYWxseVxuICogd2l0aCB0aGUgZXBvY2ggb2YgdGhlIGxvZyBpdCBjYW1lIGZyb20gKGAxMkA8ZXBvY2g+YCwgYXMgdGhlIHRhaWwncyBvd24gaGFuZG9mZiBsaW5lIHByaW50cyBpdCDigJRcbiAqIGBraXQvd2lyZS90YWlsSGFuZG9mZi50c2AsIEQyKS4gVGhlIGVwb2NoIGlzIHdoYXQgbGV0cyB0aGUgdGFpbCBub3RpY2UgYVxuICogcmVzdGFydGVkIGRhZW1vbiB3aG9zZSBuZXcgbG9nIGlzIGFscmVhZHkgcGFzdCB0aGUgaWQuIFZlcmlmeS1wYXNzIGZpeCA5XG4gKiBzdGlsbCBob2xkczogYC0tc2luY2UgYWJjYCB1c2VkIHRvIHBhcnNlIHRvIE5hTiwgd2hpY2ggdGhlIGxvZyByZWFkcyBhcyBcImZyb21cbiAqIHRoZSBzdGFydFwiLCBzbyBhIHR5cG8gcmVwbGF5ZWQgdGhlIHdob2xlIGJ1ZmZlciBhdCBleGl0IDAg4oCUIGl0IGlzIHJlZnVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVRhaWxTaW5jZSh0b2tlbjogc3RyaW5nKTogeyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHtcbiAgY29uc3QgciA9IHJlYWRTaW5jZSh0b2tlbiwgeyBlcG9jaDogdHJ1ZSB9KTtcbiAgaWYgKCFyLm9rKSBkaWUoci5tZXNzYWdlLCBcInVzYWdlXCIpO1xuICByZXR1cm4gci5lcG9jaCA/IHsgc2luY2U6IHIuc2luY2UsIGVwb2NoOiByLmVwb2NoIH0gOiB7IHNpbmNlOiByLnNpbmNlIH07XG59XG5cbi8qKlxuICogYGZpbmQgLS1zaW5jZWAgaXMgYSBEQVRFLCB3aGVyZSBgdGFpbCAtLXNpbmNlYCBpcyBhbiBldmVudCBpZCDigJQgdGhlIGZsYWcgaXNcbiAqIHNoYXJlZCwgdGhlIG1lYW5pbmcgaXMgdGhlIHZlcmIncywgYW5kIHBkb2NzIHNwZWxscyB0aGlzIG9uZSBgLS1zaW5jZWAgdG9vLlxuICogQSB0eXBvIG11c3Qgbm90IHNpbGVudGx5IHdpZGVuIHRoZSBzZWFyY2gsIHNvIGEgbm9uLWRhdGUgaXMgYSB1c2FnZSBlcnJvci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2luY2VEYXRlKHRva2VuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpO1xuICBpZiAoIS9eXFxkezR9LVxcZHsyfS1cXGR7Mn0kLy50ZXN0KHQpIHx8IE51bWJlci5pc05hTihEYXRlLnBhcnNlKHQpKSlcbiAgICBkaWUoYGZpbmQgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhIGRhdGUg4oCUIHdyaXRlIGl0IGFzIFlZWVktTU0tRERgLCBcInVzYWdlXCIpO1xuICByZXR1cm4gdDtcbn1cblxuLyoqIGB2MmAgb3IgYDJgIOKGkiAyLiBBIHZlcnNpb24gbnVtYmVyIGlzIGFuIG9wZW4gc2V0LCBzbyB0aGUgcmVqZWN0aW9uIGNhcnJpZXMgYSBoaW50LCBub3QgY2hvaWNlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVZlcnNpb24odG9rZW46IHN0cmluZywgd2hhdDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgbSA9IC9edj8oXFxkKykkLy5leGVjKHRva2VuLnRyaW0oKSk7XG4gIGlmICghbSB8fCBOdW1iZXIobVsxXSkgPCAxKVxuICAgIGRpZShgJHt3aGF0fTogXCIke3Rva2VufVwiIGlzIG5vdCBhIHZlcnNpb24g4oCUIHdyaXRlIHYxLCB2Miwg4oCmYCwgXCJ1c2FnZVwiLCB7XG4gICAgICBoaW50OiBcInJ1bjogY2xpLnRzIHN0YXRlIChlYWNoIGRvYyBsaXN0cyBpdHMgdmVyc2lvbnMpXCIsXG4gICAgfSk7XG4gIHJldHVybiBOdW1iZXIobVsxXSk7XG59XG5cbi8qKiBBIG5vbi1uZWdhdGl2ZSB3aG9sZSBudW1iZXIgZnJvbSBhIGZsYWcsIHJlZnVzZWQgcmF0aGVyIHRoYW4gY29lcmNlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUNvdW50KHRva2VuOiBzdHJpbmcsIHdoYXQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCk7XG4gIGlmICghL15cXGQrJC8udGVzdCh0KSkgZGllKGAke3doYXR9OiBcIiR7dG9rZW59XCIgaXMgbm90IGEgd2hvbGUgbnVtYmVyYCwgXCJ1c2FnZVwiKTtcbiAgcmV0dXJuIE51bWJlcih0KTtcbn1cblxuLyoqXG4gKiBBIGNvbXBhcmlzb24gc2lkZTogYSB2ZXJzaW9uLCBvciB0aGUgZmlsZSBvZiByZWNvcmQuIGBvcmlnaW5hbGAgaXMgc3BlbGxlZFxuICogb3V0IHJhdGhlciB0aGFuIG9mZmVyZWQgYXMgYHYwYCDigJQgYSB6ZXJvdGggdmVyc2lvbiB3b3VsZCByZWFkIGxpa2UgdGhlXG4gKiBlYXJsaWVzdCBvbmUsIGFuZCB0aGUgb3JpZ2luYWwgaXMgbm90IHBhcnQgb2YgdGhlIHZlcnNpb24gbGluZSBhdCBhbGwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNpZGUodG9rZW46IHN0cmluZywgd2hhdDogc3RyaW5nKTogbnVtYmVyIHwgXCJvcmlnaW5hbFwiIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAvLyBgc2F2ZWRgIGlzIHRoZSB3b3JkIHRoZSBTVVJGQUNFIHVzZXMgZm9yIHRoaXMgc2lkZSAoRTQzKTsgYG9yaWdpbmFsYCBhbmRcbiAgLy8gYGZpbGVgIGtlZXAgd29ya2luZyBiZWNhdXNlIHRoZXkgYXJlIHdoYXQgZWFybGllciBzZXNzaW9ucyBhbmQgbm90ZXMgc2F5LlxuICBpZiAodCA9PT0gXCJvcmlnaW5hbFwiIHx8IHQgPT09IFwiZmlsZVwiIHx8IHQgPT09IFwic2F2ZWRcIikgcmV0dXJuIFwib3JpZ2luYWxcIjtcbiAgcmV0dXJuIHBhcnNlVmVyc2lvbih0b2tlbiwgd2hhdCk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLyoqXG4gKiDim5QgVkVSSUZZLVBBU1MgRklYIDU6IGV2ZXJ5IHBhdGggaXMgY2hlY2tlZCBIRVJFLCBiZWZvcmUgYW55IGRhZW1vbiBleGlzdHMuXG4gKiBgb3BlbiBkb2MubWQgcGljLnBuZ2AgdXNlZCB0byBzcGF3biBhIHNlc3Npb24sIHRoZW4gZmFpbCBvbiB0aGUgc2Vjb25kIHBhdGhcbiAqIGluc2lkZSBpdCDigJQgbGVhdmluZyBhIHJ1bm5pbmcgZGFlbW9uIGFuZCBhIGxpdmUgcG9pbnRlciBiZWhpbmQgYSBmYWlsZWRcbiAqIGNvbW1hbmQuIEEgZm9sZGVyIG9yIGEgZG9jdW1lbnQgaXMgYWNjZXB0ZWQ7IGEgbWlzc2luZyBwYXRoIGlzIG5vdF9mb3VuZCwgYVxuICogbm9uLWRvY3VtZW50IGZpbGUgaXMgdXNhZ2Ugd2l0aCB0aGUgYWNjZXB0ZWQgZXh0ZW5zaW9ucyBhcyBgY2hvaWNlc2AuXG4gKi9cbmZ1bmN0aW9uIGNvbnRleHRQYXRocyhwb3M6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBwYXRocyA9IHBvcy5tYXAoKHApID0+IHJlc29sdmUocCkpO1xuICBmb3IgKGNvbnN0IHAgb2YgcGF0aHMpIHtcbiAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICB0cnkge1xuICAgICAgc3QgPSBzdGF0U3luYyhwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGRpZShgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHtwfWAsIFwibm90X2ZvdW5kXCIpO1xuICAgIH1cbiAgICBpZiAoIXN0LmlzRGlyZWN0b3J5KCkgJiYgIWlzRG9jTmFtZShwKSlcbiAgICAgIGRpZShgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7cH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogXCJhZGQgYSBmb2xkZXIsIG9yIGEgZmlsZSB3aXRoIG9uZSBvZiB0aGVzZSBleHRlbnNpb25zXCIsXG4gICAgICAgIGNob2ljZXM6IFsuLi5ET0NfRVhURU5TSU9OU10sXG4gICAgICB9KTtcbiAgfVxuICByZXR1cm4gcGF0aHM7XG59XG5cbi8qKlxuICogYC0tZG9jYCBhcyB0aGUgQ0xJJ3MgY2FsbGVyIG1lYW50IGl0ICh2ZXJpZnktcGFzcyBmaXggOCk6IGEgdG9rZW4gd2l0aCBhIHBhdGhcbiAqIHNlcGFyYXRvciwgb3Igb25lIG5hbWluZyBhIGZpbGUgaW4gVEhJUyBwcm9jZXNzJ3MgY3dkLCBpcyByZXNvbHZlZCBoZXJlIHRvIGFuXG4gKiBhYnNvbHV0ZSBwYXRoIOKAlCB0aGUgZGFlbW9uJ3MgY3dkIGlzIG5vdCB0aGUgY2FsbGVyJ3MuIEFueXRoaW5nIGVsc2UgKGEgc2x1ZyxcbiAqIGEgdW5pcXVlIGZpbGUgbmFtZSkgZ29lcyBhcyB0eXBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRvY0FyZyh0b2tlbjogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHRva2VuLmluY2x1ZGVzKFwiL1wiKSB8fCBleGlzdHNTeW5jKHJlc29sdmUodG9rZW4pKSkgcmV0dXJuIHJlc29sdmUodG9rZW4pO1xuICByZXR1cm4gdG9rZW47XG59XG5cbi8qKiBLZWVwIHRoZSBuZXdlc3QgYExPR19LRUVQIC0gMWAgZGFlbW9uIGxvZ3MsIHNvIHRoZSBvbmUgYWJvdXQgdG8gYmUgd3JpdHRlbiBtYWtlcyBgTE9HX0tFRVBgLiAqL1xuY29uc3QgTE9HX0tFRVAgPSAxMDtcbmZ1bmN0aW9uIHBydW5lTG9ncyhsb2dEaXI6IHN0cmluZyk6IHZvaWQge1xuICBsZXQgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIHRyeSB7XG4gICAgbmFtZXMgPSByZWFkZGlyU3luYyhsb2dEaXIpLmZpbHRlcigobikgPT4gL15kYWVtb24tXFxkKy1cXGQrXFwubG9nJC8udGVzdChuKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBieUFnZSA9IG5hbWVzLnNvcnQoKGEsIGIpID0+IE51bWJlcihhLnNwbGl0KFwiLVwiKVsxXSkgLSBOdW1iZXIoYi5zcGxpdChcIi1cIilbMV0pKTtcbiAgZm9yIChjb25zdCBuIG9mIGJ5QWdlLnNsaWNlKDAsIE1hdGgubWF4KDAsIGJ5QWdlLmxlbmd0aCAtIChMT0dfS0VFUCAtIDEpKSkpIHtcbiAgICB0cnkge1xuICAgICAgdW5saW5rU3luYyhqb2luKGxvZ0RpciwgbikpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogYWxyZWFkeSBnb25lICovXG4gICAgfVxuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4ocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG5cbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgaG9tZSA9IHNjcmlwdG9yaXVtSG9tZSgpO1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gam9pbihob21lLCBcInNlc3Npb25zXCIsIGZsYWdzLnJlc3RvcmUsIFwibWFuaWZlc3QuanNvblwiKTtcbiAgICBpZiAoIWV4aXN0c1N5bmMobWFuaWZlc3QpKSB7XG4gICAgICBsZXQgc2F2ZWQ6IHN0cmluZ1tdID0gW107XG4gICAgICB0cnkge1xuICAgICAgICBzYXZlZCA9IChcbiAgICAgICAgICBhd2FpdCBBcnJheS5mcm9tQXN5bmMobmV3IEJ1bi5HbG9iKFwiKi9tYW5pZmVzdC5qc29uXCIpLnNjYW4oam9pbihob21lLCBcInNlc3Npb25zXCIpKSlcbiAgICAgICAgKS5tYXAoKHApID0+IHAuc3BsaXQoXCIvXCIpWzBdIGFzIHN0cmluZyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm8gc2Vzc2lvbnMgZm9sZGVyOiB0aGUgc2V0IGlzIGVtcHR5LCBhbmQgc2F5cyBzbyAqL1xuICAgICAgfVxuICAgICAgZGllKGBubyBzYXZlZCBzZXNzaW9uIFwiJHtmbGFncy5yZXN0b3JlfVwiIHVuZGVyICR7aG9tZX1gLCBcIm5vdF9mb3VuZFwiLCB7XG4gICAgICAgIGNob2ljZXM6IHNhdmVkLnNvcnQoKSxcbiAgICAgICAgLi4uKHNhdmVkLmxlbmd0aCA9PT0gMCA/IHsgaGludDogXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWVcIiB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGNvbnN0IGxpdmUgPSByZWFkU2Vzc2lvbihmbGFncy5yZXN0b3JlKTtcbiAgICBpZiAobGl2ZSkge1xuICAgICAgY29uc3QgYWxpdmUgPSBhd2FpdCBhcGkobGl2ZS5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKS50aGVuKFxuICAgICAgICAocikgPT4gci5zdGF0dXMgPT09IDIwMCxcbiAgICAgICAgKCkgPT4gZmFsc2UsXG4gICAgICApO1xuICAgICAgaWYgKGFsaXZlKVxuICAgICAgICBkaWUoYHNlc3Npb24gJHtmbGFncy5yZXN0b3JlfSBpcyBhbHJlYWR5IHJ1bm5pbmcgYXQgJHtsaXZlLnVybH1gLCBcImNvbmZsaWN0XCIsIHtcbiAgICAgICAgICBoaW50OiBgdXNlIGl0OiBjbGkudHMgc3RhdGUgLS1zZXNzaW9uICR7ZmxhZ3MucmVzdG9yZX1gLFxuICAgICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBkYWVtb25BcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAodHlwZW9mIGZsYWdzLnRpbWVvdXQgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBmbGFncy50aW1lb3V0KTtcbiAgaWYgKHR5cGVvZiBmbGFncy5yZXN0b3JlID09PSBcInN0cmluZ1wiKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgZmxhZ3MucmVzdG9yZSk7XG4gIC8vIEUyMzogYSBuZXcgc2Vzc2lvbidzIHdvcmtzcGFjZSBpcyB3aGVyZSBgb3BlbmAgcmFuLiBBIHJlc3RvcmVkIG9uZSBrZWVwcyBpdHMgb3duLlxuICBlbHNlIGRhZW1vbkFyZ3MucHVzaChcIi0td29ya3NwYWNlXCIsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSlcbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gY2Fubm90IHN0YXJ0IGl0cyBkYWVtb246IHRoZSB3b3JraW5nIGRpcmVjdG9yeSBpdCBuZWVkcyBpcyBtaXNzaW5nIOKAlCAke2N3ZH1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCB3aGljaCBuZWVkcyBzcmMvc2NyaXB0b3JpdW0vIOKAlCByZWluc3RhbGwgdGhlIHNwZWxsIG9yIGJ1aWxkIGl0XCIsXG4gICAgICB9LFxuICAgICk7XG4gIC8vIFRoZSBkYWVtb24ncyBzdGRlcnIgZ29lcyB0byBhIExPRyBGSUxFLCBub3QgdG8gdGhpcyBDTEkncyBzdGRlcnIuIEFuXG4gIC8vIGluaGVyaXRlZCBzdGRlcnIgb3V0bGl2ZXMgdGhlIENMSSBpbnNpZGUgdGhlIGRldGFjaGVkIGRhZW1vbiwgc28gYW55IGNhbGxlclxuICAvLyB0aGF0IHJlYWRzIGBvcGVuYCdzIHN0ZGVyciB0byBFT0YgKGEgdGVzdCBoYXJuZXNzLCBhIHRvb2wgcnVubmVyKSB3YWl0cyBmb3JcbiAgLy8gdGhlIHdob2xlIHNlc3Npb24g4oCUIG1lYXN1cmVkOiB0aGUgaW50ZWdyYXRpb24gY2VsbCBodW5nIGF0IGl0cyA2MCBzIHRpbWVvdXQuXG4gIC8vIEEgZmlsZSBob2xkcyBubyBwaXBlLCBhbmQgYSBzdGFydCBmYWlsdXJlIGJlbG93IHF1b3RlcyBpdHMgdGFpbC5cbiAgY29uc3QgbG9nRGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJsb2dzXCIpO1xuICBta2RpclN5bmMobG9nRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgLy8gVmVyaWZ5LXBhc3MgZml4IDY6IHRoZSBsb2dzIHVzZWQgdG8gcGlsZSB1cCwgb25lIHBlciBgb3BlbmAsIGZvcmV2ZXIuXG4gIHBydW5lTG9ncyhsb2dEaXIpO1xuICBjb25zdCBsb2dQYXRoID0gam9pbihsb2dEaXIsIGBkYWVtb24tJHtEYXRlLm5vdygpfS0ke3Byb2Nlc3MucGlkfS5sb2dgKTtcbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1sb2dcIiwgbG9nUGF0aCk7XG4gIGNvbnN0IGxvZ0ZkID0gb3BlblN5bmMobG9nUGF0aCwgXCJhXCIpO1xuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgbG9nRmRdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjbG9zZVN5bmMobG9nRmQpO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIGNvbnN0IHN0YXJ0VGltZW91dE1zID1cbiAgICB0eXBlb2YgZmxhZ3NbXCJzdGFydC10aW1lb3V0XCJdID09PSBcInN0cmluZ1wiXG4gICAgICA/IE1hdGgubWF4KDUwMDAsIE51bWJlci5wYXJzZUludChmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0sIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBsaW5lID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzLCByZWopID0+IHtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWooXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgcGFzcyAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+YCxcbiAgICAgICAgICApLFxuICAgICAgICApLFxuICAgICAgc3RhcnRUaW1lb3V0TXMsXG4gICAgKTtcbiAgICBjaGlsZC5zdGRvdXQ/Lm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgcmVzKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWooZXJyKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImV4aXRcIiwgKGNvZGUpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICByZWoobmV3IEVycm9yKGBkYWVtb24gZXhpdGVkIHdpdGggY29kZSAke2NvZGV9IGJlZm9yZSBpdHMgaGFuZHNoYWtlYCkpO1xuICAgIH0pO1xuICB9KS5jYXRjaCgoZXJyOiB1bmtub3duKSA9PiB7XG4gICAgbGV0IHRhaWwgPSBcIlwiO1xuICAgIHRyeSB7XG4gICAgICB0YWlsID0gcmVhZEZpbGVTeW5jKGxvZ1BhdGgsIFwidXRmOFwiKS50cmltKCkuc2xpY2UoLTgwMCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBubyBsb2cgd3JpdHRlbiAqL1xuICAgIH1cbiAgICBkaWUoXG4gICAgICBgc2NyaXB0b3JpdW0gZGFlbW9uIGZhaWxlZCB0byBzdGFydDogJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHsgaGludDogdGFpbCA/IGBkYWVtb24gbG9nICgke2xvZ1BhdGh9KTogJHt0YWlsfWAgOiBgZGFlbW9uIGxvZzogJHtsb2dQYXRofWAgfSxcbiAgICApO1xuICB9KTtcblxuICAvLyBSZWxlYXNlIHRoZSBkYWVtb24ncyBzdGRvdXQgcGlwZSwgb3IgdGhpcyBDTEkncyBuYXR1cmFsIHJldHVybiB3YWl0cyBvbiBhXG4gIC8vIHN0cmVhbSB0aGF0IG5ldmVyIGNsb3NlcyAoZ2xhbW91ciBtZWFzdXJlZCA5MSBzIOKGkiAxIHMpLiBDaGVja2VkIGZvciB0aGVcbiAgLy8gTUVUSE9EOiB1bmRlciBCdW4gdGhpcyBwaXBlIGlzIGEgcGxhaW4gUmVhZGFibGUgdGhhdCBub25ldGhlbGVzcyBoYXMgdW5yZWYuXG4gIGNvbnN0IG91dCA9IGNoaWxkLnN0ZG91dDtcbiAgaWYgKCFvdXQgfHwgIShcInVucmVmXCIgaW4gb3V0KSB8fCB0eXBlb2Ygb3V0LnVucmVmICE9PSBcImZ1bmN0aW9uXCIpXG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJzY3JpcHRvcml1bTogdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlIGhhcyBubyB1bnJlZigpOyBgb3BlbmAgd291bGQgbmV2ZXIgZXhpdFwiLFxuICAgICk7XG4gIG91dC51bnJlZigpO1xuXG4gIGxldCBoczoge1xuICAgIHVybDogc3RyaW5nO1xuICAgIHBvcnQ6IG51bWJlcjtcbiAgICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gICAgb2s/OiBib29sZWFuO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgICBlcnJvcj86IHN0cmluZztcbiAgfTtcbiAgdHJ5IHtcbiAgICBocyA9IEpTT04ucGFyc2UobGluZSk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdW5leHBlY3RlZCBvdXRwdXQgZnJvbSBkYWVtb246ICR7bGluZX1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIGlmIChocy5vayA9PT0gZmFsc2UpIGRhZW1vblJlZnVzZWQoXCJvcGVuXCIsIGhzLnN0YXR1cyA/PyA1MDAsIGhzKTtcblxuICBsZXQgZW50cmllczogdW5rbm93bltdID0gW107XG4gIGlmIChwYXRocy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgciA9IGF3YWl0IHBvc3RDbWQoaHMuc2Vzc2lvbl9pZCwgeyB0eXBlOiBcImNvbnRleHQuYWRkXCIsIHBhdGhzIH0pO1xuICAgIGVudHJpZXMgPSAoci5lbnRyaWVzIGFzIHVua25vd25bXSkgPz8gW107XG4gIH1cbiAgcHJpbnRKc29uKHsgLi4uaHMsIC4uLihwYXRocy5sZW5ndGggPiAwID8geyBlbnRyaWVzIH0gOiB7fSkgfSk7XG5cbiAgaWYgKCFmbGFnc1tcIm5vLW9wZW5cIl0pIHtcbiAgICBjb25zdCBvcGVuZXIgPVxuICAgICAgcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJkYXJ3aW5cIiA/IFwib3BlblwiIDogcHJvY2Vzcy5wbGF0Zm9ybSA9PT0gXCJ3aW4zMlwiID8gXCJzdGFydFwiIDogXCJ4ZGctb3BlblwiO1xuICAgIHNwYXduKG9wZW5lciwgW2hzLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kQWRkKHBvczogc3RyaW5nW10sIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBwYXRocyA9IGNvbnRleHRQYXRocyhwb3MpO1xuICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSkpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZ1bGw6IGJvb2xlYW4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiP2Z1bGw9MVwiIDogXCJcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwic3RhdGVcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG4vKipcbiAqIFRoZSBPTkUgcHJvc2UgcmVhZGVyOiBhcmd1bWVudHMsIGAtLXN0ZGluYCBvciBgLS1ib2R5LWZpbGVgLCBleGFjdGx5IG9uZSBvZlxuICogdGhlbS4gYHNheWAvYHRhc2tgL2Bub3RlYCBuZWVkIGEgbWVzc2FnZSBhbmQgdHJpbSBpdDsgYHZlcnNpb24tbmV3YCAoIzExNylcbiAqIG1heSBoYXZlIG5vbmUgKHRoZW4gaXQgY29waWVzKSBhbmQga2VlcHMgaXRzIGJvZHkgYnl0ZSBmb3IgYnl0ZSwgYmVjYXVzZSBhXG4gKiB2ZXJzaW9uJ3MgdGV4dCBpcyBhIGRvY3VtZW50LCBub3QgYSBjaGF0IGxpbmUuXG4gKlxuICogQSBib2R5IGZpbGUgdGhhdCBpcyBub3QgdGhlcmUgaXMgYHVzYWdlYCAoMikgYnkgZGVmYXVsdCDigJQgd2hhdCBgc2F5YC9gdGFza2AvXG4gKiBgbm90ZWAvYG5vdGUtZWRpdGAgaGF2ZSBhbHdheXMgYW5zd2VyZWQg4oCUIGFuZCBgbm90X2ZvdW5kYCAoNSkgd2hlcmUgdGhlXG4gKiBjYWxsZXIgYXNrcyAoYHZlcnNpb24tbmV3YCwgbmV3IGluICMxMTcpLiDimqAgQWxpZ25pbmcgdGhlIG9sZGVyIHZlcmJzIG9uIDUgaXNcbiAqIGEgY2FsbGVyLXZpc2libGUgZXhpdC1jb2RlIGNoYW5nZSwgaGVsZCBmb3IgYSByZWxlYXNlIHRoYXQgY2FuIGNhcnJ5IGFcbiAqIGJyZWFraW5nLWNoYW5nZXMgbm90ZTsgY2xpLWNvbnRyYWN0IHBpbnMgdGhlaXIgMiB1bnRpbCB0aGVuLlxuICovXG5hc3luYyBmdW5jdGlvbiByZWFkUHJvc2UoXG4gIHZlcmI6IHN0cmluZyxcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuICBvOiB7IG9wdGlvbmFsPzogYm9vbGVhbjsgbWlzc2luZ0ZpbGU/OiBcInVzYWdlXCIgfCBcIm5vdF9mb3VuZFwiIH0gPSB7fSxcbik6IFByb21pc2U8c3RyaW5nIHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IHNvdXJjZXMgPSBbXG4gICAgcG9zLmxlbmd0aCA+IDAsXG4gICAgZmxhZ3Muc3RkaW4gPT09IHRydWUsXG4gICAgdHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiLFxuICBdLmZpbHRlcihCb29sZWFuKS5sZW5ndGg7XG4gIGlmIChzb3VyY2VzID09PSAwICYmIG8ub3B0aW9uYWwpIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmIChzb3VyY2VzICE9PSAxKVxuICAgIGRpZShcbiAgICAgIHNvdXJjZXMgPT09IDBcbiAgICAgICAgPyBgJHt2ZXJifSBuZWVkcyBhIG1lc3NhZ2VgXG4gICAgICAgIDogby5vcHRpb25hbFxuICAgICAgICAgID8gYCR7dmVyYn0gdGFrZXMgaXRzIGJvZHkgZnJvbSBvbmUgcGxhY2U6IC0tc3RkaW4gb3IgLS1ib2R5LWZpbGUsIG5vdCBib3RoYFxuICAgICAgICAgIDogYCR7dmVyYn0gdGFrZXMgaXRzIG1lc3NhZ2UgZnJvbSBleGFjdGx5IG9uZSBwbGFjZTogYXJndW1lbnRzLCAtLXN0ZGluIG9yIC0tYm9keS1maWxlYCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIHtcbiAgICAgICAgaGludDogby5vcHRpb25hbFxuICAgICAgICAgID8gXCJnaXZlIHRoZSB0ZXh0IHRocm91Z2ggLS1ib2R5LWZpbGUgPHBhdGg+IG9yIC0tc3RkaW4gKG5ldmVyIGFuIHVucXVvdGVkIGhlcmVkb2MpXCJcbiAgICAgICAgICA6IFwiZ2l2ZSB0aGUgdGV4dCBhcyBhcmd1bWVudHMsIG9yIHByb3NlIHRocm91Z2ggLS1ib2R5LWZpbGUgPHBhdGg+IC8gLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIixcbiAgICAgICAgY2hvaWNlczogW1wiLS1zdGRpblwiLCBcIi0tYm9keS1maWxlXCJdLFxuICAgICAgfSxcbiAgICApO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBpZiAoZmxhZ3Muc3RkaW4gPT09IHRydWUpIHRleHQgPSBhd2FpdCBuZXcgUmVzcG9uc2UoQnVuLnN0ZGluLnN0cmVhbSgpKS50ZXh0KCk7XG4gIGVsc2UgaWYgKHR5cGVvZiBmbGFnc1tcImJvZHktZmlsZVwiXSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IHBhdGggPSBmbGFnc1tcImJvZHktZmlsZVwiXTtcbiAgICBpZiAoIWV4aXN0c1N5bmMocGF0aCkpIGRpZShgJHt2ZXJifTogLS1ib2R5LWZpbGUgbm90IGZvdW5kOiAke3BhdGh9YCwgby5taXNzaW5nRmlsZSA/PyBcInVzYWdlXCIpO1xuICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGVsc2UgdGV4dCA9IHBvcy5qb2luKFwiIFwiKTtcbiAgaWYgKCF0ZXh0LnRyaW0oKSlcbiAgICBkaWUoXG4gICAgICBvLm9wdGlvbmFsID8gYCR7dmVyYn06IHRoZSBib2R5IGlzIGVtcHR5YCA6IGAke3ZlcmJ9OiB0aGUgbWVzc2FnZSBpcyBlbXB0eWAsXG4gICAgICBcInVzYWdlXCIsXG4gICAgICBvLm9wdGlvbmFsID8geyBoaW50OiBgZHJvcCAtLWJvZHktZmlsZS8tLXN0ZGluIHRvIGNvcHkgdGhlIHNvdXJjZSB2ZXJzaW9uIGluc3RlYWRgIH0gOiB7fSxcbiAgICApO1xuICByZXR1cm4gdGV4dDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcmVhZFNheUJvZHkoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbiAgdmVyYjogc3RyaW5nLFxuKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgcmV0dXJuICgoYXdhaXQgcmVhZFByb3NlKHZlcmIsIHBvcywgZmxhZ3MpKSA/PyBcIlwiKS50cmltKCk7XG59XG5cbi8qKlxuICogV2hldGhlciB0aGUgdGFpbCBoYXMgYWxyZWFkeSByZXBvcnRlZCB0aGF0IGl0IGxvc3QgdGhlIGRhZW1vbiAoRTU1KS4gTW9kdWxlXG4gKiBzY29wZSBiZWNhdXNlIGEgdGFpbCBpcyBvbmUgcHJvY2VzcyBkb2luZyBvbmUgdGhpbmcsIGFuZCB0aGUgdHdvIGhvb2tzIHRoYXRcbiAqIHJlYWQgaXQgYXJlIGhhbmRlZCB0byBhIGNsaWVudCB0aGF0IG93bnMgaXRzIG93biBsb29wLlxuICovXG5sZXQgZGlzY29ubmVjdGVkID0gZmFsc2U7XG5cbi8qKlxuICogVGhlIHdhdGNoLiBFbmRzIGl0c2VsZiBiZWZvcmUgTW9uaXRvcidzIGNhcCB3aXRoIG9uZSBsaW5lIG5hbWluZyB0aGUgbmV4dFxuICogYWN0IChgc3JjL2tpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCk6IHJlLWFybSBNb25pdG9yLCBnbyB0byBhIGJhY2tncm91bmRcbiAqIGAtLW9uY2VgLCBvciBjb21lIGJhY2sgZnJvbSBhIGNsb3NlZCBvciBsb3N0IHNlc3Npb24gd2l0aCBgb3BlbiAtLXJlc3RvcmVgLlxuICogQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTogdGhlIGFnZW50IGFscmVhZHkga25vd3MgdGhlXG4gKiBzZXNzaW9uLCBhbmQgdGhlIGxpbmUgd291bGQgY291bnQgYXMgbm9pc2UgaW4gdGhlIHdpbmRvdydzIHdha2UuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoXG4gIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgc2luY2U6IG51bWJlcixcbiAgbzogeyBvbmNlOiBib29sZWFuOyBzaW5jZUdpdmVuOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9LFxuKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgbGV0IGJvdW5kSWQgPSBzZXNzaW9uO1xuICBjb25zdCByZUFybSA9IHNlc3Npb24gIT09IHVuZGVmaW5lZCB8fCBvLnNpbmNlR2l2ZW47XG4gIGxldCBncm91bmRlZCA9IG8uc2luY2VHaXZlbjtcbiAgY29uc3QgcGluID0gKCkgPT4gKGJvdW5kSWQgIT09IHVuZGVmaW5lZCA/IFtcIi0tc2Vzc2lvblwiLCBib3VuZElkXSA6IFtdKTtcbiAgcmV0dXJuIGF3YWl0IHRhaWxXaXRoSGFuZG9mZjx7IGlkPzogbnVtYmVyOyBlcG9jaD86IHN0cmluZzsgdHlwZT86IHN0cmluZzsgYnk/OiBzdHJpbmcgfT4oXG4gICAge1xuICAgICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICAgIGlmICghcykgcmV0dXJuIG51bGw7XG4gICAgICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDtcbiAgICAgICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgICAgfSxcbiAgICAgIG9uVW5yZXNvbHZlZDogKHsgZXZlclJlc29sdmVkIH0pID0+IHtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCBnaXZlbiAtLXNlc3Npb24gb3IgYSBib29rbWFyayBpcyByZS1hcm1pbmcgYW4gRVhJU1RJTkdcbiAgICAgICAgLy8gc2Vzc2lvbiwgc28gbm90IGZpbmRpbmcgaXQgbWVhbnMgaXQgY2xvc2VkIChpbiB0aGUgZ2FwLCBzYXkpIOKAlCB0aGVcbiAgICAgICAgLy8gaGFuZG9mZiBzYXlzIGB0YWlsLmNsb3NlZGAsIG5ldmVyIGEgc2lsZW50IHJldHJ5LWZvcmV2ZXIuXG4gICAgICAgIGlmIChldmVyUmVzb2x2ZWQgfHwgcmVBcm0pIHJldHVybiBcInN0b3BcIjtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgICAgcmV0dXJuIFwicmV0cnlcIjtcbiAgICAgIH0sXG4gICAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICAgIHNpbmNlLFxuICAgICAgLi4uKG8uZXBvY2ggPyB7IHNpbmNlRXBvY2g6IG8uZXBvY2ggfSA6IHt9KSxcbiAgICAgIGN1cnNvck9mOiAoZXYpID0+ICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgPyBldi5pZCA6IHVuZGVmaW5lZCksXG4gICAgICBlcG9jaE9mOiAoZXYpID0+ICh0eXBlb2YgZXYuZXBvY2ggPT09IFwic3RyaW5nXCIgPyBldi5lcG9jaCA6IHVuZGVmaW5lZCksXG4gICAgICAvLyBBIGRpZmZlcmVudCBlcG9jaCBvbiByZWNvbm5lY3QgPSB0aGUgZGFlbW9uIHJlc3RhcnRlZDsgaWRzIGJlZ2FuIGFnYWluLlxuICAgICAgb25FcG9jaENoYW5nZTogKGVwb2NoKSA9PiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZXBvY2guY2hhbmdlZFwiLCBlcG9jaCB9KSxcbiAgICAgIHRlcm1pbmFsOiAoZXYpID0+IGV2LnR5cGUgPT09IFwiY2xvc2VkXCIsXG4gICAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICAgIC8vIOKblCBBIEtFRVBBTElWRSBJUyBQUk9PRiBPRiBMSUZFLCBzbyBpdCBpcyBhbHNvIHdoYXQgY2xlYXJzIGEgcmVwb3J0ZWRcbiAgICAgIC8vIGRpc2Nvbm5lY3Rpb24uIFRoZXJlIGlzIG5vIGBvbkNvbm5lY3RgIGhvb2sgYW5kIHRoaXMgaXMgdGhlIGhvbmVzdFxuICAgICAgLy8gc3Vic3RpdHV0ZTogdGhlIGRhZW1vbiBvbmx5IHNlbmRzIGNvbW1lbnRzIGRvd24gYSBsaXZlIHN0cmVhbS5cbiAgICAgIG9uQ29tbWVudDogKCkgPT4ge1xuICAgICAgICBpZiAoIWRpc2Nvbm5lY3RlZCkgcmV0dXJuIFwiOiBzY3JpcHRvcml1bS1rZWVwYWxpdmVcIjtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwidGFpbC5yZWNvbm5lY3RlZFwiIH0pO1xuICAgICAgfSxcbiAgICAgIC8vIOKblCBPTkUgTElORSBQRVIgRVBJU09ERSwgTk9UIFBFUiBBVFRFTVBULiBUaGUgY2xpZW50IHJlY29ubmVjdHMgd2l0aFxuICAgICAgLy8gYmFja29mZiBmb3JldmVyLCBzbyBhIGhvb2sgdGhhdCBzcG9rZSBldmVyeSB0aW1lIHdvdWxkIGVtaXQgYSBsaW5lIGV2ZXJ5XG4gICAgICAvLyBmZXcgc2Vjb25kcyBmb3IgYXMgbG9uZyBhcyB0aGUgZGFlbW9uIHN0YXllZCBkb3duIOKAlCB3aGljaCBpcyBob3cgYVxuICAgICAgLy8gd2F0Y2hlciBnZXRzIG11dGVkLCBhbmQgdGhlbiBub2JvZHkgaGVhcnMgdGhlIG5leHQgcmVhbCB0aGluZy5cbiAgICAgIC8vXG4gICAgICAvLyDimqAgV0hZIFRISVMgRVhJU1RTIEFUIEFMTDogd2l0aG91dCBpdCBhIERFQUQgZGFlbW9uIGFuZCBhIFFVSUVUIG9uZSBhcmVcbiAgICAgIC8vIHRoZSBzYW1lIHRoaW5nIGZyb20gb3V0IGhlcmUuIEEgZ3JhY2VmdWwgY2xvc2UgZW1pdHMgYGNsb3NlZGAgYW5kIGVuZHNcbiAgICAgIC8vIHRoZSB0YWlsOyBhIGNyYXNoLCBhIGtpbGwgLTkgb3IgYSBzbGVlcGluZyBsYXB0b3AgZW1pdHMgbm90aGluZywgdGhlXG4gICAgICAvLyBjbGllbnQgcmV0cmllcyBpbiBzaWxlbmNlLCBhbmQgdGhlIGFic2VuY2Ugb2YgZXZlbnRzIGlzIG5vdCBhbiBldmVudC4gQVxuICAgICAgLy8gd2F0Y2hlciB3YWl0aW5nIGZvciB0aGUgaHVtYW4ncyBuZXh0IG1lc3NhZ2Ugd291bGQgd2FpdCBmb3JldmVyIGFuZFxuICAgICAgLy8gbmV2ZXIgbGVhcm4gaXQgaGFkIHN0b3BwZWQgbGlzdGVuaW5nLiAoRm91bmQgMjAyNi0wOS0xNCB3aGlsZSBhbnN3ZXJpbmdcbiAgICAgIC8vIENvbGUncyBxdWVzdGlvbiBhYm91dCB3aGV0aGVyIGEgdGltZW91dCB3b3VsZCBub3RpZnkgbWUuIEl0IHdvdWxkIG5vdC4pXG4gICAgICBvbkRpc2Nvbm5lY3Q6ICh7IGNhdXNlLCBzdGF0dXMgfSkgPT4ge1xuICAgICAgICBpZiAoZGlzY29ubmVjdGVkKSByZXR1cm4gbnVsbDtcbiAgICAgICAgZGlzY29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwuZGlzY29ubmVjdGVkXCIsXG4gICAgICAgICAgY2F1c2UsXG4gICAgICAgICAgLi4uKHN0YXR1cyAhPT0gdW5kZWZpbmVkID8geyBzdGF0dXMgfSA6IHt9KSxcbiAgICAgICAgICBub3RlOiBcInJldHJ5aW5nOyB0aGUgc2Vzc2lvbiBtYXkgaGF2ZSBjbG9zZWQgb3IgY3Jhc2hlZFwiLFxuICAgICAgICB9KTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBzcGVsbDogXCJzY3JpcHRvcml1bVwiLFxuICAgICAgbW9kZTogby5vbmNlID8gXCJvbmNlXCIgOiBcIndhdGNoXCIsXG4gICAgICBwcmVzZW5jZTogZmFsc2UsXG4gICAgICAvLyBUaGUgYGNsb3NlZGAgZXZlbnQgc2F5cyB3aG8gZW5kZWQgaXQ7IGB0YWlsLmNsb3NlZGAgY2FycmllcyBpdCBhc1xuICAgICAgLy8gYGJ5YCwgYW5kIGEgaHVtYW4gZW5kIHRlbGxzIHRoZSBhZ2VudCB0byBzdG9wIGFuZCBub3QgcmVvcGVuLlxuICAgICAgY2xvc2VkQnk6IChldikgPT4gKHR5cGVvZiBldi5ieSA9PT0gXCJzdHJpbmdcIiA/IGV2LmJ5IDogdW5kZWZpbmVkKSxcbiAgICAgIGNvbW1hbmRzOiB7XG4gICAgICAgIHRhaWw6ICh7IHNpbmNlOiBhdCwgb25jZSwgZXBvY2ggfSkgPT4gdGFpbENvbW1hbmQoW1widGFpbFwiLCAuLi5waW4oKV0sIGF0LCBvbmNlLCBlcG9jaCksXG4gICAgICAgIGNvbWVCYWNrOiAoKSA9PiBjb21tYW5kTGluZShbXCJvcGVuXCIsIFwiLS1yZXN0b3JlXCIsIGJvdW5kSWQgPz8gXCI8aWQ+XCIsIFwiLS1uby1vcGVuXCJdKSxcbiAgICAgIH0sXG4gICAgfSxcbiAgKTtcbn1cblxuZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihTS0lMTF9ST09ULCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpLCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcbiAgICBpZiAodHlwZW9mIHBrZy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IHBrZy52ZXJzaW9uIH07XG4gIH0gY2F0Y2gge1xuICAgIC8qIGZhbGwgdGhyb3VnaCAqL1xuICB9XG4gIHJldHVybiB7IG5hbWU6IFwic2NyaXB0b3JpdW1cIiwgdmVyc2lvbjogXCJ1bmtub3duXCIgfTtcbn1cblxuLyoqXG4gKiBFMjQncyB2ZXJiczogdGhlIGFnZW50J3MgaGFsZiBvZiB0aGUgc3RydWN0dXJlIG9wcyB0aGUgaHVtYW4gcmVhY2hlcyBieSBtZW51c1xuICogYW5kIGRyYWcgYW5kIGRyb3AuIEVhY2ggcmVzb2x2ZXMgaXRzIHBhdGhzIGFnYWluc3QgVEhJUyBwcm9jZXNzJ3MgY3dkIGFuZFxuICogcG9zdHMgb25lIG9wOyB0aGUgZGFlbW9uIGRvZXMgdGhlIGNoYW5nZSBhbmQgYW5ub3VuY2VzIGl0IGluIHRoZSBjaGF0LlxuICovXG5hc3luYyBmdW5jdGlvbiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgb3ApKTtcbn1cblxuLyoqIGBpbXBvcnQgPGZpbGU+YDogdGhlIGZpbGUncyBURVhUIGlzIHNlbnQsIHNvIHRoZSBkYWVtb24gd3JpdGVzIGEgY29weSAoRTIzKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNtZEltcG9ydChmaWxlOiBzdHJpbmcsIGludG86IHN0cmluZyB8IHVuZGVmaW5lZCwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGNvbnN0IGFicyA9IHJlc29sdmUoZmlsZSk7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGBubyBzdWNoIGZpbGU6ICR7YWJzfWAsIFwibm90X2ZvdW5kXCIpO1xuICB9XG4gIGlmICghc3QuaXNGaWxlKCkgfHwgIWlzRG9jTmFtZShhYnMpKVxuICAgIGRpZShgbm90IGEgZG9jdW1lbnQgc2NyaXB0b3JpdW0gb3BlbnM6ICR7YWJzfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzOiBbLi4uRE9DX0VYVEVOU0lPTlNdIH0pO1xuICBhd2FpdCBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgIHR5cGU6IFwiaW1wb3J0XCIsXG4gICAgbmFtZTogYWJzLnNwbGl0KFwiL1wiKS5wb3AoKSBhcyBzdHJpbmcsXG4gICAgdGV4dDogcmVhZEZpbGVTeW5jKGFicywgXCJ1dGY4XCIpLFxuICAgIC4uLihpbnRvICE9PSB1bmRlZmluZWQgPyB7IGludG86IHJlc29sdmUoaW50bykgfSA6IHt9KSxcbiAgfSk7XG59XG5cbi8qKiBgd29ya3NwYWNlYCBhbG9uZSBwcmludHMgaXQ7IGB3b3Jrc3BhY2UgPGRpcj5gIHNldHMgaXQuICovXG5hc3luYyBmdW5jdGlvbiBjbWRXb3Jrc3BhY2UoZGlyOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBpZiAoZGlyICE9PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwid29ya3NwYWNlLnNldFwiLCBwYXRoOiByZXNvbHZlKGRpcikgfSk7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJ3b3Jrc3BhY2VcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKHsgd29ya3NwYWNlOiAoZGF0YSBhcyB7IHdvcmtzcGFjZT86IHVua25vd24gfSkud29ya3NwYWNlIH0pO1xufVxuXG4vLyDilIDilIAgVEhFIENPTU1BTkQgVEFCTEUg4oCUIGRpc3BhdGNoLCBoZWxwLCBgc2NoZW1hYCBhbmQgZXZlcnkgYGNob2ljZXNgIHdhbGsgaXQg4pSA4pSAXG4vL1xuLy8gVGhyb3VnaCB0aGUgaG91c2UncyBvbmUgcmVnaXN0cnkgKGBzcmMva2l0L2NsaS9yZWdpc3RyeS50c2ApLiBzY3JpcHRvcml1bSdzXG4vLyBvd24gZGlzcGF0Y2hlciwgaGVscCByZW5kZXJlciBhbmQgZGVjbGFyYXRpb24gZW1pdHRlciDigJQgYSBjb3B5IG9mIGdsYW1vdXIncyDigJRcbi8vIHdlcmUgZGVsZXRlZCB3aGVuIGl0IG1vdmVkIG9udG8gdGhlIG1vZHVsZS4gYGhlbHBgLCBgdmVyc2lvbmAgYW5kIGBzY2hlbWFgXG4vLyBhcmUgdGhlIG1vZHVsZSdzIHJvd3M6IGRlY2xhcmVkIGFuZCBzdHJpY3QsIHNvIGB2ZXJzaW9uIC0tYm9ndXNgIGlzIHJlZnVzZWRcbi8vIChpdCBleGl0ZWQgMCB3aGlsZSBgdmVyc2lvbmAgd2FzIGFuc3dlcmVkIGJlZm9yZSB0aGUgdGFibGUpLlxuXG50eXBlIEZsYWcgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4vKiogQSByb3cgYXMgc2NyaXB0b3JpdW0gd3JpdGVzIGl0OiB0aGUgaGFuZGxlciB0YWtlcyBgKHBvcywgZmxhZ3MsIHNlc3Npb24pYCxcbiAqICBhbmQgYG9uYCBhZGFwdHMgaXQgdG8gdGhlIGtpdCdzIGBydW4oaW52KWAuIEEgbnVtYmVyIHJldHVybmVkIGlzIHRoZSBleGl0XG4gKiAgY29kZSAoYHRhaWxgKTsgYW55dGhpbmcgZWxzZSBpcyAwLiAqL1xudHlwZSBSb3cgPSBPbWl0PENvbW1hbmRTcGVjPEZsYWc+LCBcInJ1blwiIHwgXCJyZWplY3RIaW50XCI+ICYge1xuICBydW46IChwb3M6IHN0cmluZ1tdLCBmbGFnczogRmxhZ3MsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBzY3JpcHRvcml1bSBkZWNsYXJlcyBubyBgbXVsdGlwbGVgIGZsYWcsIHNvIGV2ZXJ5IHZhbHVlIGlzIGEgc3RyaW5nIG9yIGFcbiAqICBib29sZWFuIOKAlCB0aGUgYEZsYWdzYCB0aGUgaGFuZGxlcnMgdGFrZS4gKi9cbmNvbnN0IG9uID1cbiAgKGg6IFJvd1tcInJ1blwiXSkgPT5cbiAgKGludjogSW52b2NhdGlvbjxGbGFnPik6IHVua25vd24gPT4ge1xuICAgIGNvbnN0IGZsYWdzID0gaW52LmZsYWdzIGFzIEZsYWdzO1xuICAgIHJldHVybiBoKGludi5wb3MsIGZsYWdzLCB0eXBlb2YgZmxhZ3Muc2Vzc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnNlc3Npb24gOiB1bmRlZmluZWQpO1xuICB9O1xuXG4vKiogRXZlcnkgZmxhZyByZWplY3Rpb24ncyBoaW50OiB0aGUgb25lIHJlcGFpciBmb3IgcHJvc2UgaW4gd2hpY2ggYSB3b3JkXG4gKiAgaGFwcGVucyB0byBzdGFydCB3aXRoIGAtLWAuICovXG5jb25zdCBEQVNIX0hJTlQgPSBcImZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMsIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1cIjtcblxuY29uc3QgU0VTU0lPTiA9IFtcInNlc3Npb25cIl0gYXMgY29uc3Qgc2F0aXNmaWVzIHJlYWRvbmx5IEZsYWdbXTtcblxuY29uc3QgUk9XUzogUm93W10gPSBbXG4gIHtcbiAgICBuYW1lOiBcIm9wZW5cIixcbiAgICBmbGFnczogW1wibm8tb3BlblwiLCBcInJlc3RvcmVcIiwgXCJ0aW1lb3V0XCIsIFwic3RhcnQtdGltZW91dFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInNwYXduIGEgc2Vzc2lvbiAob3BlbnMgdGhlIGJyb3dzZXIpLCBhZGRpbmcgcGF0aHM7IHByaW50cyB7dXJsLCBwb3J0LCBzZXNzaW9uX2lkfS4gLS10aW1lb3V0IDxzZWNvbmRzPiBzZXRzIHRoZSBpZGxlIGNsb3NlIChkZWZhdWx0IDE4MDApOyAtLXRpbWVvdXQgMCBzdGFuZHMgdW50aWwgY2xvc2VkXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncykgPT4gY21kT3Blbihwb3MsIGZsYWdzKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYWRkXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiYWRkIGZpbGVzIG9yIGZvbGRlcnMgdG8gdGhlIGNvbnRleHQgbGlzdFwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiBjbWRBZGQocG9zLCBzZXNzaW9uKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3RhdGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZnVsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwidGhlIHNlc3Npb246IGNvbnRleHQsIGRvY3MgKyB2ZXJzaW9ucyAod2l0aCBwYXRocyksIGFjdGl2ZSwgZGlydHksIHNlbGVjdGlvblwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBjbWRTdGF0ZShzZXNzaW9uLCBmbGFncy5mdWxsID09PSB0cnVlKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFpbFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzaW5jZVwiLCBcIm9uY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0aGUgaHVtYW4ncyBtZXNzYWdlcyAod2l0aCBzZWxlY3Rpb24gKyBhY3RpdmUgcGF0aCkgYXMgSlNPTiBsaW5lcyDigJQgd3JhcCB3aXRoIE1vbml0b3I7IGl0cyBsYXN0IGxpbmUgbmFtZXMgdGhlIG5leHQgYWN0XCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGIgPSB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBwYXJzZVRhaWxTaW5jZShmbGFncy5zaW5jZSkgOiB7IHNpbmNlOiAtMSB9O1xuICAgICAgcmV0dXJuIGNtZFRhaWwoc2Vzc2lvbiwgYi5zaW5jZSwge1xuICAgICAgICBvbmNlOiBmbGFncy5vbmNlID09PSB0cnVlLFxuICAgICAgICBzaW5jZUdpdmVuOiB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIsXG4gICAgICAgIC4uLihiLmVwb2NoID8geyBlcG9jaDogYi5lcG9jaCB9IDoge30pLFxuICAgICAgfSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidmVyc2lvbi1uZXdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwiZnJvbVwiLCBcImxhYmVsXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJwcm9wb3NlIGEgbmV3IHZlcnNpb24gaG9sZGluZyB5b3VyIHRleHQgKC0tYm9keS1maWxlIDxwYXRoPiBvciAtLXN0ZGluKTsgd2l0aG91dCBvbmUsIGNvcGllcyBhIHZlcnNpb24gKGRlZmF1bHQ6IHRoZSBhY3RpdmUgb25lKSBhbmQgcHJpbnRzIGl0cyBwYXRoIHRvIGVkaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZnJvbSA9IHR5cGVvZiBmbGFncy5mcm9tID09PSBcInN0cmluZ1wiID8gcGFyc2VWZXJzaW9uKGZsYWdzLmZyb20sIFwiLS1mcm9tXCIpIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlYWRQcm9zZShcInZlcnNpb24tbmV3XCIsIFtdLCBmbGFncywge1xuICAgICAgICBvcHRpb25hbDogdHJ1ZSxcbiAgICAgICAgbWlzc2luZ0ZpbGU6IFwibm90X2ZvdW5kXCIsXG4gICAgICB9KTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLm5ld1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgICAgLi4uKGZyb20gIT09IHVuZGVmaW5lZCA/IHsgZnJvbSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MubGFiZWwgPT09IFwic3RyaW5nXCIgPyB7IGxhYmVsOiBmbGFncy5sYWJlbCB9IDoge30pLFxuICAgICAgICAgIC4uLih0ZXh0ICE9PSB1bmRlZmluZWQgPyB7IHRleHQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInNheVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicG9zdCBhIGNoYXQgbWVzc2FnZSBmcm9tIHRoZSBhZ2VudCAocHJvc2U6IC0tYm9keS1maWxlIDxwYXRoPiBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MsIFwic2F5XCIpIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ2ZXJzaW9uLWRlbGV0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgdmVyc2lvbiBhbmQgaXRzIGZpbGUgKG5ldmVyIHRoZSBhY3RpdmUgb25lIOKAlCBhY3RpdmF0ZSBhbm90aGVyIGZpcnN0KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ2ZXJzaW9uLmRlbGV0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJ2ZXJzaW9uLWRlbGV0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBoYXZlIHN0YXJ0ZWQgc29tZXRoaW5nOyBwcmludHMgdGhlIGlkIHRvIGZpbmlzaCBpdCB3aXRoXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnN0YXJ0XCIsIHRleHQ6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MsIFwidGFza1wiKSB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFzay1zdGF0dXNcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwic3RhdHVzXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwic2F5IHdoYXQgc3RlcCBhIHRhc2sgaXMgb24gKGZvciB3b3JrIHdvcnRoIHdhdGNoaW5nKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidGFzay5zdGF0dXNcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBzdGF0dXM6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2stZG9uZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJvdXRjb21lXCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcIm1hcmsgYSB0YXNrIGZpbmlzaGVkLCBvcHRpb25hbGx5IHNheWluZyB3aGF0IGNhbWUgb2YgaXRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3Qgb3V0Y29tZSA9IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKS50cmltKCk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidGFzay5kb25lXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgLi4uKG91dGNvbWUgPyB7IG91dGNvbWUgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2stcmVtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZm9yZ2V0IGEgdGFzayBlbnRpcmVseSDigJQgZm9yIG9uZSBzdGFydGVkIGJ5IG1pc3Rha2VcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInRhc2sucmVtb3ZlXCIsIGlkOiBwb3NbMF0gYXMgc3RyaW5nIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrcy1jbGVhclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJmb3JnZXQgZXZlcnkgZmluaXNoZWQgdGFzazsgb3V0c3RhbmRpbmcgb25lcyBhcmUgbGVmdCBhbG9uZVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInRhc2tzLmNsZWFyXCIgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndvcmtpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZm9yXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzYXkgeW91IGFyZSBzdGlsbCBvbiBpdCDigJQgc2lsZW5jZXMgdGhlIHdhaXRpbmcgbnVkZ2UsIGtlZXBzIHRoZSBodW1hbidzIHB1bHNlXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IHNlY29uZHMgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuZm9yID09PSBcInN0cmluZ1wiID8gcGFyc2VDb3VudChmbGFncy5mb3IsIFwid29ya2luZyAtLWZvclwiKSA6IHVuZGVmaW5lZDtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJ3b3JraW5nXCIsXG4gICAgICAgICAgLi4uKHNlY29uZHMgIT09IHVuZGVmaW5lZCA/IHsgc2Vjb25kcyB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJxdW90ZVwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwibm90ZSBhIHBhc3NhZ2Ugb2YgdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLXF1b3RlICdleGFjdCB0ZXh0JzsgcHJvc2U6IC0tYm9keS1maWxlIG9yIC0tc3RkaW4pXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5xdW90ZSAhPT0gXCJzdHJpbmdcIiB8fCBmbGFncy5xdW90ZS50cmltKCkgPT09IFwiXCIpXG4gICAgICAgIGRpZShcIm5vdGU6IC0tcXVvdGUgaXMgcmVxdWlyZWQg4oCUIHRoZSBleGFjdCB0ZXh0IHRoZSBub3RlIGlzIGFib3V0XCIsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgc3RhdGUgLS1mdWxsICh0aGUgYWN0aXZlIHZlcnNpb24ncyB0ZXh0IGlzIG9uIGRpc2s7IHF1b3RlIGZyb20gaXQpXCIsXG4gICAgICAgIH0pO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuYWRkXCIsXG4gICAgICAgICAgcXVvdGU6IGZsYWdzLnF1b3RlLFxuICAgICAgICAgIGJvZHk6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcywgZmxhZ3MsIFwibm90ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZXNcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwiZnVsbFwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwidGhlIG5vdGVzIG9uIGEgZG9jdW1lbnQsIHBsYWNlZCBpbiB0aGUgYWN0aXZlIHZlcnNpb24gKC0tZnVsbCBpbmNsdWRlcyByZXNvbHZlZClcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGVzXCIsXG4gICAgICAgICAgLi4uKGZsYWdzLmZ1bGwgPyB7IGFsbDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLWVkaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInRleHRcIiwgcmVxdWlyZWQ6IGZhbHNlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmV3cml0ZSB3aGF0IGEgbm90ZSBzYXlzIChpdHMgcGFzc2FnZSBpcyB1bmNoYW5nZWQpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUuZWRpdFwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIGJvZHk6IGF3YWl0IHJlYWRTYXlCb2R5KHBvcy5zbGljZSgxKSwgZmxhZ3MsIFwibm90ZS1lZGl0XCIpLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlc29sdmVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwicmVvcGVuXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcIm1hcmsgYSBub3RlIGRlYWx0IHdpdGggKC0tcmVvcGVuIHB1dHMgaXQgYmFjaylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibm90ZS5yZXNvbHZlXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgcmVzb2x2ZWQ6ICFmbGFncy5yZW9wZW4sXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGUtcmVtb3ZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJkZWxldGUgYSBub3RlXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVtb3ZlXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRpZmZcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwiY29udGV4dFwiLCBcInBhdGNoXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImFnYWluc3RcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImNvbXBhcmUgdGhlIGFjdGl2ZSB2ZXJzaW9uIHdpdGggYW5vdGhlciAodk4gb3IgJ3NhdmVkJyBmb3IgdGhlIGZpbGUgb24gZGlzayk7IC0tcGF0Y2ggZm9yIHBsYWluIHVuaWZpZWQgdGV4dFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IHIgPSAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiZGlmZlwiLFxuICAgICAgICBhZ2FpbnN0OiBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwiZGlmZlwiKSxcbiAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5jb250ZXh0ID09PSBcInN0cmluZ1wiXG4gICAgICAgICAgPyB7IGNvbnRleHQ6IHBhcnNlQ291bnQoZmxhZ3MuY29udGV4dCwgXCItLWNvbnRleHRcIikgfVxuICAgICAgICAgIDoge30pLFxuICAgICAgfSkpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgaWYgKGZsYWdzLnBhdGNoKSBwcm9jZXNzLnN0ZG91dC53cml0ZShTdHJpbmcoci51bmlmaWVkID8/IFwiXCIpKTtcbiAgICAgIGVsc2UgcHJpbnRKc29uKHIpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1lcmdlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImh1bmtzXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImFnYWluc3RcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInRha2UgY2hhbmdlcyBmcm9tIGFub3RoZXIgdmVyc2lvbiBpbnRvIHRoZSBhY3RpdmUgb25lICgtLWh1bmtzIDEsMzsgZGVmYXVsdDogYWxsIG9mIHRoZW0pXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWdhaW5zdCA9IHBhcnNlU2lkZShwb3NbMF0gPz8gXCJcIiwgXCJtZXJnZVwiKTtcbiAgICAgIC8vIOKblCBXaXRob3V0IC0taHVua3MgdGhpcyB0YWtlcyBFVkVSWSBodW5rLCB3aGljaCBpcyB0aGUgd2hvbGUtZG9jdW1lbnRcbiAgICAgIC8vIG1lcmdlLiBUaGUgaWRzIGNvbWUgZnJvbSBgZGlmZmAgYW5kIGFyZSBvbmx5IHZhbGlkIGFnYWluc3QgdGhlIHRleHQgaXRcbiAgICAgIC8vIHNhdzogdGhlIGRhZW1vbiByZS1kaWZmcyBhbmQgcmVmdXNlcyBpZHMgaXQgY2Fubm90IGZpbmQgcmF0aGVyIHRoYW5cbiAgICAgIC8vIGFwcGx5aW5nIGEgbnVtYmVyIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbW92ZWQgdW5kZXJuZWF0aCBpdC5cbiAgICAgIGNvbnN0IGxpc3RlZCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5odW5rcyA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8gZmxhZ3MuaHVua3Muc3BsaXQoXCIsXCIpLm1hcCgoaCkgPT4gcGFyc2VDb3VudChoLCBcIi0taHVua3NcIikpXG4gICAgICAgICAgOiBudWxsO1xuICAgICAgY29uc3QgaHVua3MgPVxuICAgICAgICBsaXN0ZWQgPz9cbiAgICAgICAgKFxuICAgICAgICAgIChhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICAgIHR5cGU6IFwiZGlmZlwiLFxuICAgICAgICAgICAgYWdhaW5zdCxcbiAgICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgICAgfSkpIGFzIHsgaHVua3M/OiB7IGlkOiBudW1iZXIgfVtdIH1cbiAgICAgICAgKS5odW5rcz8ubWFwKChoKSA9PiBoLmlkKSA/P1xuICAgICAgICBbXTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJtZXJnZVwiLFxuICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgaHVua3MsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFjdGl2YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ2TlwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYWtlIGEgdmVyc2lvbiB0aGUgYWN0aXZlIG9uZSAodGhlIG9uZSB0aGUgaHVtYW4gZWRpdHMgYW5kIFNhdmUgd3JpdGVzKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJhY3RpdmF0ZVwiLFxuICAgICAgICAgIHZlcnNpb246IHBhcnNlVmVyc2lvbihwb3NbMF0gPz8gXCJcIiwgXCJhY3RpdmF0ZVwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibmV3LWRvY1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImNyZWF0ZSBhbiBlbXB0eSBkb2N1bWVudCAoaXRzIGZvbGRlciBtdXN0IGJlIGEgc2V0LCBhIGZvbGRlciBpbiBvbmUsIG9yIHRoZSB3b3Jrc3BhY2UpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFicyA9IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyk7XG4gICAgICByZXR1cm4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2MuY3JlYXRlXCIsIGRpcjogZGlybmFtZShhYnMpLCBuYW1lOiBiYXNlbmFtZShhYnMpIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1mb2xkZXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImNyZWF0ZSBhIGZvbGRlciDigJQgaW5zaWRlIGEgc2V0LCBvciBpbiB0aGUgd29ya3NwYWNlIGFzIGEgbmV3IHNldFwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwiZm9sZGVyLmNyZWF0ZVwiLFxuICAgICAgICBkaXI6IGRpcm5hbWUoYWJzKSxcbiAgICAgICAgbmFtZTogYmFzZW5hbWUoYWJzKSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1vdmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJpbnRvXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtb3ZlIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGludG8gYW5vdGhlciBmb2xkZXIgKGEgcmVhbCBtb3ZlIG9uIGRpc2spXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcIm1vdmVcIixcbiAgICAgICAgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSxcbiAgICAgICAgaW50bzogcmVzb2x2ZShwb3NbMV0gYXMgc3RyaW5nKSxcbiAgICAgIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJyZW5hbWVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJuYW1lXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJyZW5hbWUgYSBkb2N1bWVudCBvciBmb2xkZXIgaW4gcGxhY2VcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwicmVuYW1lXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksIG5hbWU6IHBvc1sxXSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaGlkZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwicmVtb3ZlIGEgZG9jdW1lbnQsIGZvbGRlciBvciBzZXQgZnJvbSBTY3JpcHRvcml1bSDigJQgdGhlIGZpbGVzIHN0YXkgb24gZGlza1wiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJoaWRlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInVuaGlkZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImVudHJ5XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImJyaW5nIGJhY2sgZXZlcnl0aGluZyBoaWRkZW4gaW4gYSBzZXQgKGl0cyBlbnRyeSBpZCwgZnJvbSBzdGF0ZSlcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gc3RydWN0dXJlQ21kKHNlc3Npb24sIHsgdHlwZTogXCJ1bmhpZGVcIiwgZW50cnk6IHBvc1swXSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWFrZS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInR1cm4gYSBzaW5nbGUgZG9jdW1lbnQgaW50byBhIHNldDogYSBmb2xkZXIgbmFtZWQgZm9yIGl0LCB0aGUgZG9jdW1lbnQgbW92ZWQgaW5cIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwic2V0Lm1ha2VcIiwgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW1wb3J0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImludG9cIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiZmlsZVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjb3B5IGEgZG9jdW1lbnQgaW4gKGRlZmF1bHQ6IGludG8gdGhlIHdvcmtzcGFjZSkgYW5kIHNob3cgdGhlIGNvcHlcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgY21kSW1wb3J0KHBvc1swXSBhcyBzdHJpbmcsIHR5cGVvZiBmbGFncy5pbnRvID09PSBcInN0cmluZ1wiID8gZmxhZ3MuaW50byA6IHVuZGVmaW5lZCwgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIndvcmtzcGFjZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImRpclwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHdvcmtzcGFjZSAod2hlcmUgZHJvcHMgYW5kIG5ldyB0b3AtbGV2ZWwgZG9jdW1lbnRzIGxhbmQpLCBvciBzZXQgaXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kV29ya3NwYWNlKHBvc1swXSwgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ldGFcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiBmYWxzZSB9XSxcbiAgICBkZXNjcmliZTogXCJhIGRvY3VtZW50J3MgZnJvbnRtYXR0ZXIgYXMgdGhlIGRhZW1vbiByZWFkIGl0IChubyBwYXRoOiBldmVyeSBjb250ZXh0IGRvY3VtZW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWV0YVwiLFxuICAgICAgICAgIC4uLihwb3NbMF0gIT09IHVuZGVmaW5lZCA/IHsgcGF0aDogcmVzb2x2ZShwb3NbMF0pIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmaW5kXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInR5cGVcIiwgXCJzdGF0dXNcIiwgXCJsaWZlY3ljbGVcIiwgXCJ0YWdcIiwgXCJzaW5jZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImRvY3VtZW50cyBieSBmcm9udG1hdHRlciDigJQgZmlsdGVycyBBTkQsIGFsbCBvcHRpb25hbDsgYW4gZW1wdHkgcmVzdWx0IGlzIGFuIGFuc3dlciAoY291bnQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpbHRlcjogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBrIG9mIFtcInR5cGVcIiwgXCJzdGF0dXNcIiwgXCJsaWZlY3ljbGVcIiwgXCJ0YWdcIl0gYXMgY29uc3QpXG4gICAgICAgIGlmICh0eXBlb2YgZmxhZ3Nba10gPT09IFwic3RyaW5nXCIpIGZpbHRlcltrXSA9IGZsYWdzW2tdO1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5zaW5jZSA9PT0gXCJzdHJpbmdcIikgZmlsdGVyLnNpbmNlID0gcGFyc2VTaW5jZURhdGUoZmxhZ3Muc2luY2UpO1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImZpbmRcIiwgZmlsdGVyIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzZWFyY2hcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwibGltaXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicXVlcnlcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzZWFyY2ggdGhlIGNvbnRleHQ6IGZ1enp5IG9uIG5hbWVzLCBleGFjdCBpbiB0ZXh0IOKAlCBzZWFyY2hlcyB0aGUgQUNUSVZFIHZlcnNpb24gb2Ygb3BlbiBkb2N1bWVudHMsIHdoaWNoIGdyZXAgY2Fubm90IHNlZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGxpbWl0ID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLmxpbWl0ID09PSBcInN0cmluZ1wiID8gcGFyc2VDb3VudChmbGFncy5saW1pdCwgXCJzZWFyY2ggLS1saW1pdFwiKSA6IHVuZGVmaW5lZDtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJzZWFyY2hcIixcbiAgICAgICAgICBxdWVyeTogcG9zLmpvaW4oXCIgXCIpLFxuICAgICAgICAgIC4uLihsaW1pdCAhPT0gdW5kZWZpbmVkID8geyBsaW1pdCB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZG9jdG9yXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ3aGF0IGlzIHdvcnRoIGxvb2tpbmcgYXQgaW4gdGhpcyBzZXNzaW9uIOKAlCBlYWNoIGZpbmRpbmcgbmFtZXMgdGhlIHZlcmIgdGhhdCBmaXhlcyBpdFwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImRvY3RvclwiIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJmb3JnZXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwiZm9yZ2V0IGEgZG9jdW1lbnQgd2hvc2UgZmlsZSBvZiByZWNvcmQgaXMgZ29uZSAocmVmdXNlZCB3aGlsZSB0aGUgZmlsZSBleGlzdHMg4oCUIHVzZSBoaWRlIHRvIHRha2Ugb25lIG91dCBvZiB0aGUgY29udGV4dClcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcImZvcmdldFwiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkYW5nbGluZ1wiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJlbnRyeVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwibGlua3MgaW4gYSBzZXQgdGhhdCBub3RoaW5nIGFuc3dlcnMg4oCUIGZpbGUsIGxpbmUsIGFuZCB0aGUgdGFyZ2V0IGFzIHdyaXR0ZW5cIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcImRhbmdsaW5nXCIsXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5lbnRyeSA9PT0gXCJzdHJpbmdcIiA/IHsgZW50cnk6IGZsYWdzLmVudHJ5IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJncmFwaFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJlbnRyeVwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImEgc2V0J3MgbWFwIGFzIEpTT04g4oCUIG5vZGVzLCBlZGdlcyAoYm9keSBsaW5rcyBhbmQgZnJvbnRtYXR0ZXIga2VwdCBhcGFydCksIGRhbmdsaW5nXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJncmFwaFwiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYmFja2xpbmtzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ3aGF0IGNpdGVzIGEgZG9jdW1lbnQg4oCUIGByZWxhdGVkYCAoZnJvbnRtYXR0ZXIpIGFuZCBgbGlua3NgIChib2R5KSwga2VwdCBhcGFydFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiYmFja2xpbmtzXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSkpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ldGEtaW5pdFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwiYnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwiYWRkIGEgZnJvbnRtYXR0ZXIgYmxvY2sgdG8gYSBkb2N1bWVudCB0aGF0IGhhcyBub25lICh0eXBlIGd1ZXNzZWQgZnJvbSBpdHMgbmVpZ2hib3VycylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWV0YS5pbml0XCIsXG4gICAgICAgICAgcGF0aDogcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLnR5cGUgPT09IFwic3RyaW5nXCIgPyB7IG1ldGFUeXBlOiBmbGFncy50eXBlIH0gOiB7fSksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5ieSA9PT0gXCJzdHJpbmdcIiA/IHsgYnk6IGZsYWdzLmJ5IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLXNldFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcImtleT12YWx1ZVwiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNldCBmcm9udG1hdHRlciBrZXlzIOKAlCBvbmUgbGluZSBlZGl0IGVhY2gsIGV2ZXJ5dGhpbmcgZWxzZSB1bnRvdWNoZWRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgICBmb3IgKGNvbnN0IHBhaXIgb2YgcG9zLnNsaWNlKDEpKSB7XG4gICAgICAgIGNvbnN0IGVxID0gcGFpci5pbmRleE9mKFwiPVwiKTtcbiAgICAgICAgaWYgKGVxIDw9IDApXG4gICAgICAgICAgZGllKGBcIiR7cGFpcn1cIiBpcyBub3Qga2V5PXZhbHVlYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBoaW50OiBcIm1ldGEtc2V0IDxwYXRoPiBzdGF0dXM9c3RhYmxlIGxpZmVjeWNsZT1saXZlXCIsXG4gICAgICAgICAgfSk7XG4gICAgICAgIGZpZWxkc1twYWlyLnNsaWNlKDAsIGVxKV0gPSBwYWlyLnNsaWNlKGVxICsgMSk7XG4gICAgICB9XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIm1ldGEuc2V0XCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksIGZpZWxkcyB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiaW5mb1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJwcmludCB0aGUgcmVzb2x2ZWQgc2Vzc2lvbiBwb2ludGVyXCIsXG4gICAgcnVuOiAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24ocmVxdWlyZVNlc3Npb24oc2Vzc2lvbikpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInNodXQgdGhlIHNlc3Npb24gZG93biAodGhlIG1hbmlmZXN0IHN0YXlzLCBmb3Igb3BlbiAtLXJlc3RvcmUpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pO1xuICAgICAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IFwiY2xvc2VcIiB9KTtcbiAgICB9LFxuICB9LFxuXTtcblxuLy8g4puUIEJVSUxESU5HIFRIRSBUQUJMRSBIQVMgTk8gU0lERSBFRkZFQ1RTOiBgZGVmaW5lQ2xpYCBvbmx5IHZhbGlkYXRlcyBhbmRcbi8vIGluZGV4ZXMsIHNvIGEgd2FyZCBvciBhIHRlc3QgY2FuIGltcG9ydCB0aGlzIG1vZHVsZSBhbmQgcmVhZCB0aGUgdGFibGUuXG5leHBvcnQgY29uc3QgY2xpID0gZGVmaW5lQ2xpKHtcbiAgbmFtZTogXCJzY3JpcHRvcml1bVwiLFxuICBzdW1tYXJ5OiBcImEgY28tcHJlc2VudCBtYXJrZG93biBlZGl0b3I6IHRoZSBodW1hbiBlZGl0cywgeW91IHdyaXRlIG5ldyB2ZXJzaW9ucy5cIixcbiAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gIGNvbW1hbmRzOiBST1dTLm1hcCgocikgPT4gKHsgLi4uciwgcnVuOiBvbihyLnJ1biksIHJlamVjdEhpbnQ6IERBU0hfSElOVCB9KSksXG4gIC8vIGBzY3JpcHRvcml1bSAtLXNlc3Npb24geCBzdGF0ZWAgcnVucyBgc3RhdGVgOyBhIGJhcmUgYC0tYCBtYWtlcyB0aGUgbmV4dFxuICAvLyB0b2tlbiB0aGUgdmVyYiAoYWNjIEE2KS5cbiAgZ3JhbW1hcjogXCJmbGFncy1hbnl3aGVyZVwiLFxuICB2ZXJiUG9zaXRpb25hbDogXCJ2ZXJiXCIsXG4gIHVzYWdlSGlkZXM6IFtcInNlc3Npb25cIl0sXG4gIHZlcnNpb246IHZlcnNpb25JbmZvLFxuICBoZWxwRm9vdGVyOiBgICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gYW55IHZlcmIgdGhhdCB0YWxrcyB0byBhIHNlc3Npb24gKGRlZmF1bHQ6IG1vc3QgcmVjZW50KS5cbiAgRWFjaCB2ZXJiIGFjY2VwdHMgb25seSB0aGUgZmxhZ3Mgb24gaXRzIHJvdy5cblxuICBPdXRwdXQ6IEpTT04gb24gc3Rkb3V0LCBvbmUgZG9jdW1lbnQgcGVyIGFuc3dlciDigJQgZXhjZXB0IHRhaWwgKG9uZSBKU09OIGxpbmVcbiAgcGVyIGV2ZW50KSBhbmQgaGVscCAocHJvc2UpLiBGYWlsdXJlczogb25lIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyLCBleGl0XG4gIDIgPSB1c2FnZSwgMSA9IGludGVybmFsLCA1ID0gbm90IGZvdW5kLCA2ID0gY29uZmxpY3QuIHRhaWwgd2FpdHMgZm9yIGFcbiAgc2Vzc2lvbiByYXRoZXIgdGhhbiBmYWlsaW5nLCBhbmQgZW5kcyAwIHdoZW4gaXRzIHNlc3Npb24gY2xvc2VzLiB0YWlsXG4gICR7V0lORE9XX0hFTFB9LmAsXG59KTtcblxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS52ZXJicztcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IHN0cmluZ1tdPiA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgY2xpLnJvd3MubWFwKChyKSA9PiBbci5uYW1lLCByLmFjY2VwdGVkXSksXG4pO1xuZXhwb3J0IGNvbnN0IGZsYWdzRm9yID0gKHZlcmI6IHN0cmluZyk6IHN0cmluZ1tdID0+IGNsaS5mbGFnc0Zvcih2ZXJiKTtcbmV4cG9ydCBjb25zdCBSRUNPR05JWkVEX0ZMQUdTOiByZWFkb25seSBzdHJpbmdbXSA9IGNsaS5yZWNvZ25pemVkRmxhZ3M7XG5cbi8vIGBkaXNwYXRjaGAsIG5vdCB0aGUgcmVnaXN0cnkncyBgbWFpbmA6IHRoZSBraXQgZG9lcyBub3QgdHJpYWdlIGEgbm9uLUNsaUVycm9yO1xuLy8gdGhpcyBkb2VzLiBBIG5hbWVkIGZpbGUgdGhhdCBpcyBub3QgdGhlcmUgKC0tYm9keS1maWxlKSBpcyB0aGUgY2FsbGVyJ3M7XG4vLyBldmVyeXRoaW5nIGVsc2UgaXMgb3Vycy5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBjbGkuZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgIGlmIChyZXBvcnRlZCAhPT0gbnVsbCkgcmV0dXJuIHJlcG9ydGVkO1xuICAgIGNvbnN0IGNvZGUgPVxuICAgICAgZSAmJiB0eXBlb2YgZSA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlID8gU3RyaW5nKChlIGFzIHsgY29kZTogdW5rbm93biB9KS5jb2RlKSA6IFwiXCI7XG4gICAgY29uc3QgbXNnID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IFVzYWdlRXJyb3IobXNnKSkgPz8gMjtcbiAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgbXNnKSkgPz8gMTtcbiAgfVxufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUi4gUmV0dXJucyB0aGUgY29kZSByYXRoZXIgdGhhbiBleGl0aW5nXG4gKiAoc3Rkb3V0IGlzIGEgcGlwZTsgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQpLCBhbmQgdGFrZXMgbm8gYXJndW1lbnRzXG4gKiAodGhlIGNvbW1hbmQgbGluZSBiZWxvbmdzIHRvIHRoZSBmaWxlIHRoYXQgcGFyc2VzIGl0KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSByZWdpc3RyeTogb25lIHRhYmxlIGRyaXZlcyB0aGUgcGFyc2VyLCB0aGUgZGlzcGF0Y2hlcixcbiAqIGhlbHAsIHRoZSByZWplY3Rpb25zJyBgY2hvaWNlc2AsIGAtLXZlcnNpb25gIGFuZCB0aGUgYWNjIGRlY2xhcmF0aW9uXG4gKiAoYHNjaGVtYWAsIGZvcm1hdCB2MCkuXG4gKlxuICogR2VuZXJhbGlzZWQgZnJvbSB0aGUgdGhyZWUgaGFuZC1idWlsdCByZWdpc3RyaWVzIChncmFwZXZpbmUsIGdsYW1vdXIsXG4gKiBzY3JpcHRvcml1bSkgcGVyIGBkb2NzL2l0ZW1zL3NoYXJlZC1jbGktcmVnaXN0cnktaW4tdGhlLWtpdC93cml0ZS11cC5tZGAsIGFzXG4gKiBhbWVuZGVkIGJ5IGl0cyBjb2xkIHJlYWQgKGDigKYvYXJ0aWZhY3RzL2NvbGQtcmVhZC5tZGApLiBXaGVyZSB0aGV5IGRpc2FncmVlZCxcbiAqIHRoZSBjb2xkIHJlYWQgd29uLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gVGhpcyBtb2R1bGUgaW1wb3J0cyBvbmx5IGBub2RlOnV0aWxgIGFuZCBvdGhlciBraXRcbiAqIG1vZHVsZXMgKGAuLi93aXJlL2Vycm9yc2AsIGAuLi9saWIvcHJpbnRKc29uYCkuXG4gKlxuICog4puUIE5PIFNJREUgRUZGRUNUUyBBVCBJTVBPUlQsIEFORCBOT05FIElOIGBkZWZpbmVDbGlgLiBCdWlsZGluZyB0aGUgdGFibGUgb25seVxuICogdmFsaWRhdGVzIGFuZCBpbmRleGVzIGl0OyBub3RoaW5nIGlzIHBhcnNlZCwgcHJpbnRlZCBvciByZWFkIHVudGlsIGBtYWluYCBvclxuICogYGRpc3BhdGNoYCBpcyBjYWxsZWQuIEEgZ3JpbW9pcmUgd2FyZCBjYW4gaW1wb3J0IGEgc3BlbGwncyB0YWJsZSBhbmQgcmVhZFxuICogYHJlY29nbml6ZWRGbGFnc2AsIGBmbGFnc0ZvcmAsIGB2ZXJic2AgYW5kIGBkZWNsYXJhdGlvbigpYCB3aXRob3V0IHJ1bm5pbmcgaXQuXG4gKlxuICog4pSA4pSAIFRIRSBDT05UUkFDVCBBIFNQRUxMIENBTk5PVCBDSEFOR0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gYC0taGVscGAvYC1oYCBhbmQgYC0tdmVyc2lvbmAvYC1WYCBhcyBgYXJndlswXWAgcnVuIHRoZSBgaGVscGAgb3JcbiAqICAgIGB2ZXJzaW9uYCByb3cgYW5kIFBBU1MgVEhFIFJFTUFJTklORyBBUkdVTUVOVFMgT04gdG8gaXQsIHNvIHRoYXQgcm93J3Mgb3duXG4gKiAgICBmbGFnIGNoZWNrIGFwcGxpZXM6IGAtLXZlcnNpb24gLS1odW1hbmAgd29ya3Mgd2hlcmUgYHZlcnNpb25gIGFjY2VwdHNcbiAqICAgIGAtLWh1bWFuYCwgYW5kIGAtLXZlcnNpb24gLS1qdW5rYCBpcyBleGl0IDIgd2hlcmUgaXQgZG9lcyBub3QuXG4gKiAyLiBFbXB0eSBhcmd2IGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMjogb25lIGVudmVsb3BlIG9uIHN0ZGVyciwgZXhpdCAyLFxuICogICAgYGNob2ljZXNgID0gdGhlIHZlcmJzKSDigJQgdW5sZXNzIHRoZSBDTEkgaGFzIGEgdmVyYmxlc3MgYHJvb3RgIHJvdyB0aGF0XG4gKiAgICBhY2NlcHRzIGFuIGVtcHR5IGFyZ3YgKG5vIHJlcXVpcmVkIHBvc2l0aW9uYWxzOyBmbGFncyBkZWZhdWx0ZWQpLlxuICogMy4gVGhlIHZlcmIgaXMgZm91bmQgcGVyIHRoZSBncmFtbWFyOlxuICogICAgLSBgdmVyYi1maXJzdGAgKGRlZmF1bHQpOiBgYXJndlswXWAuIEEgZGFzaC1sZWQgYGFyZ3ZbMF1gIHRoYXQgaXMgbm90IGFuXG4gKiAgICAgIGludGVyY2VwdG9yIGlzIGFuIHVua25vd24gUk9PVCBmbGFnIChgY2hvaWNlc2AgPSB0aGUgaW50ZXJjZXB0b3JzLCBsb25nXG4gKiAgICAgIGZpcnN0KS4gRmxhZ3MgYmVmb3JlIHRoZSB2ZXJiIGFyZSByZWZ1c2VkLCBpbmNsdWRpbmcgZ2xvYmFsIG9uZXMuXG4gKiAgICAtIGBmbGFncy1hbnl3aGVyZWA6IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5laXRoZXIgYSBmbGFnIG5vciBhIHN0cmluZ1xuICogICAgICBmbGFnJ3MgdmFsdWUgKGBnbGFtb3VyIC0tc2Vzc2lvbiB4IGluZm9gIHJ1bnMgYGluZm9gKS4gVGhlXG4gKiAgICAgIHVua25vd24tcm9vdC1mbGFnIHJ1bGUgZG9lcyBOT1QgYXBwbHk7IGFuIGFyZ3Ygd2l0aCBubyB2ZXJiIGluIGl0IGlzXG4gKiAgICAgIHBhcnNlZCB3aG9sZSwgc28gYW4gdW5rbm93biBmbGFnIHRoZXJlIGlzIHJlZnVzZWQgd2l0aCB0aGUgcm9vdCdzIHNldC5cbiAqICAgIEluIGJvdGgsIGEgYmFyZSBgLS1gIGJlZm9yZSB0aGUgdmVyYiBtYWtlcyB0aGUgTkVYVCB0b2tlbiB0aGUgdmVyYlxuICogICAgY2FuZGlkYXRlIGFuZCBldmVyeXRoaW5nIGFmdGVyIGl0IHBvc2l0aW9uYWwgKGFjYyBBNik6IGBjbGkgLS0gLS14YCBpc1xuICogICAgYHVua25vd24gY29tbWFuZCBcIi0teFwiYCwgbmV2ZXIgYW4gb3B0aW9uLlxuICogNC4gTmVzdGluZyBpcyBvbmUgbGV2ZWw6IGEgcm93IG5hbWVkIGBcIm5vZGUgZWRpdFwiYC4gVGhlIHN1Yi12ZXJiIG9mIGEgZ3JvdXBcbiAqICAgIGlzIGZvdW5kIGJ5IHRoZSBncm91cCdzIGBzdWJWZXJiQXRgIChzZWUgYEdyb3VwU3BlY2ApLiBBIGdyb3VwIHdpdGggbm8gcm93XG4gKiAgICBvZiBpdHMgb3duIHJlamVjdHMgYSBtaXNzaW5nIG9yIHVua25vd24gc3ViLXZlcmIgd2l0aCBpdHMgc3ViLXZlcmJzIGFzXG4gKiAgICBgY2hvaWNlc2A7IGEgZ3JvdXAgV0lUSCBpdHMgb3duIHJvdyAoYGRvYyA8aWQ+YCkgcnVucyB0aGF0IHJvdyBpbnN0ZWFkLlxuICogNS4gVGhlIHJvdydzIGFyZ3MgYXJlIHBhcnNlZCBzdHJpY3QgYWdhaW5zdCB0aGUgV0hPTEUgb3B0aW9ucyB0YWJsZSAod2l0aFxuICogICAgYGRlZmF1bHRgcyBzdHJpcHBlZCksIHNvIGEgZmxhZyB0aGUgc3BlbGwga25vd3MgYnV0IHRoaXMgcm93IGRvZXMgbm90IHRha2VcbiAqICAgIGlzIHJlZnVzZWQgYXMgTUlTUExBQ0VEIChgLS14IGlzIG5vdCBhY2NlcHRlZCBieSBcXGB2ZXJiXFxgYCksIGFuZCBvbmUgdGhlXG4gKiAgICBzcGVsbCBkb2VzIG5vdCBrbm93IGFzIFVOS05PV04uIEJvdGggY2FycnkgYGNob2ljZXNgID0gdGhpcyByb3cncyBhY2NlcHRlZFxuICogICAgc2V0IChpdHMgb3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYDsgYSB2ZXJibGVzcyByb290J3MgYWRkcyB0aGVcbiAqICAgIGludGVyY2VwdG9ycywgYXMgaXRzIGRlY2xhcmVkIHJvdyBkb2VzKS4gQWZ0ZXIgYSBgLS1gIGV2ZXJ5dGhpbmcgaXMgYVxuICogICAgcG9zaXRpb25hbCAobm9kZSdzIHBhcnNlciBob25vdXJzIGl0KS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHMgYVxuICogICAgZmxhZyB0aGlzIHJvdyBhY2NlcHRzIGlzIHN0aWxsIGEgcG9zaXRpb25hbCwgYnV0IGl0IGVhcm5zIG9uZVxuICogICAgYCMgd2FybmluZzpgIGxpbmUgb24gc3RkZXJyIG5hbWluZyB0aGUgcmVjb3ZlcnkgKGB3YXJuRGVtb3RlZGApOyBzdGRvdXRcbiAqICAgIGFuZCB0aGUgZXhpdCBjb2RlIGFyZSB1bmNoYW5nZWQuXG4gKiA2LiBEZWZhdWx0cyBhcmUgYXBwbGllZCBBRlRFUiB0aGUgcGVyLXJvdyBjaGVjaywgYW5kIG9ubHkgZm9yIGZsYWdzIHRoZSByb3dcbiAqICAgIGFjY2VwdHMg4oCUIHNvIGEgZGVmYXVsdGVkIGZsYWcgbmV2ZXIgdHJpcHMgdGhlIG1pc3BsYWNlZC1mbGFnIGNoZWNrLCBhbmQgYVxuICogICAgcm93IG5ldmVyIHNlZXMgYW5vdGhlciByb3cncyBkZWZhdWx0LlxuICogNy4gQXJpdHkgaXMgZW5mb3JjZWQgZnJvbSBgcG9zaXRpb25hbHNgOyB0aGUgcmVqZWN0aW9uIG5hbWVzIHRoZSBtaXNzaW5nXG4gKiAgICBgPHBvc2l0aW9uYWw+YCBvciB0aGUgZXh0cmEgdG9rZW4uIEEgcm93J3MgYGNoZWNrYCBtYXkgdGhlbiByZWZ1c2UgYVxuICogICAgY29tYmluYXRpb24gdGhlIGRlY2xhcmF0aW9uIGNhbm5vdCBleHByZXNzIChmbGFnLWRlcGVuZGVudCBhcml0eSkuXG4gKiA4LiBUaGUgcm93IHJ1bnM7IGEgbnVtYmVyIGl0IHJldHVybnMgaXMgdGhlIGV4aXQgY29kZSwgYW55dGhpbmcgZWxzZSBpcyAwLlxuICpcbiAqIFRoZSBtb2R1bGUgYWRkcyBgaGVscGAsIGB2ZXJzaW9uYCBhbmQgYHNjaGVtYWAgcm93cyB1bmxlc3MgdGhlIHNwZWxsIGRlZmluZXNcbiAqIGEgcm93IG9mIHRoYXQgbmFtZSAoZ3JhcGV2aW5lJ3MgYHZlcnNpb24gLS1odW1hbmApLiBUaGV5IGFyZSBvcmRpbmFyeSByb3dzOlxuICogZGVjbGFyZWQsIHN0cmljdCwgYW5kIGdpdmVuIGBnbG9iYWxGbGFnc2AgbGlrZSBldmVyeSBvdGhlciByb3cuXG4gKi9cblxuaW1wb3J0IHsgcGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uL2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi93aXJlL2Vycm9yc1wiO1xuXG4vLyDilIDilIAgdHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCB0eXBlIEZsYWdUeXBlID0gXCJzdHJpbmdcIiB8IFwiYm9vbGVhblwiO1xuXG4vKiogT25lIGBwYXJzZUFyZ3NgIG9wdGlvbiwgcGx1cyB0aGUgYGRlZmF1bHRgIG5vZGUncyBwYXJzZXIgYWxzbyB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIE9wdGlvblNwZWMgPSB7XG4gIHR5cGU6IEZsYWdUeXBlO1xuICBtdWx0aXBsZT86IGJvb2xlYW47XG4gIHNob3J0Pzogc3RyaW5nO1xuICBkZWZhdWx0Pzogc3RyaW5nIHwgYm9vbGVhbiB8IHJlYWRvbmx5IHN0cmluZ1tdIHwgcmVhZG9ubHkgYm9vbGVhbltdO1xufTtcblxuZXhwb3J0IHR5cGUgT3B0aW9uc1RhYmxlID0gUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgT3B0aW9uU3BlYz4+O1xuXG5leHBvcnQgdHlwZSBQb3NpdGlvbmFsU3BlYyA9IHsgbmFtZTogc3RyaW5nOyByZXF1aXJlZDogYm9vbGVhbjsgdmFyaWFkaWM/OiBib29sZWFuIH07XG5cbmV4cG9ydCB0eXBlIEZsYWdWYWx1ZSA9IHN0cmluZyB8IGJvb2xlYW4gfCAoc3RyaW5nIHwgYm9vbGVhbilbXTtcblxuZXhwb3J0IHR5cGUgSW52b2NhdGlvbjxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIFRoZSByZXNvbHZlZCByb3cgbmFtZTogYFwib3BlblwiYCwgYFwibm9kZSBlZGl0XCJgLCBvciBgXCJcImAgZm9yIGEgdmVyYmxlc3Mgcm9vdC4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHNwZWxsaW5nIHRoZSBjYWxsZXIgdXNlZCDigJQgYW4gYWxpYXMsIHdoZW4gb25lIHdhcyB1c2VkLiAqL1xuICB0b2tlbjogc3RyaW5nO1xuICAvKiogUG9zaXRpb25hbHMgYWZ0ZXIgdGhlIHBhdGguICovXG4gIHBvczogc3RyaW5nW107XG4gIC8qKiBGbGFncyBnaXZlbiwgcGx1cyB0aGUgZGVmYXVsdHMgb2YgdGhlIGZsYWdzIHRoaXMgcm93IGFjY2VwdHMuICovXG4gIGZsYWdzOiBQYXJ0aWFsPFJlY29yZDxGLCBGbGFnVmFsdWU+Pjtcbn07XG5cbmV4cG9ydCB0eXBlIENvbW1hbmRTcGVjPEYgZXh0ZW5kcyBzdHJpbmcgPSBzdHJpbmc+ID0ge1xuICAvKiogYFwib3BlblwiYDsgb25lIHNwYWNlIG1lYW5zIG9uZSBsZXZlbCBvZiBuZXN0aW5nOiBgXCJub2RlIGVkaXRcImAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEVhY2ggYWxpYXMgaXMgZGlzcGF0Y2hhYmxlLCBsaXN0ZWQgaW4gYHZlcmJzYCwgYW5kIGdldHMgaXRzIG93biBkZWNsYXJlZFxuICAgKiAgcm93LiBBbiBhbGlhcyBvZiBhIG5lc3RlZCByb3cgbXVzdCBzaGFyZSBpdHMgZ3JvdXA6IGBcIm5vZGUgY2hhbmdlXCJgLiAqL1xuICBhbGlhc2VzPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGlzIHJvdydzIG93biBmbGFnczsgYGdsb2JhbEZsYWdzYCBhcmUgYWRkZWQgdG8gdGhlbS4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IEZbXTtcbiAgLyoqIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gdGhpcywgYW5kIGl0IGlzIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzLiAqL1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgLyoqIE9uZSBsaW5lIGZvciB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIEFkZGVkIGFzIHRoZSBgaGludGAgb2YgdGhpcyByb3cncyBmbGFnIHJlamVjdGlvbnMuICovXG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIC8qKiBgZmFsc2VgIGhhbmRzIG5vZGUncyBvd24gXCJVbmV4cGVjdGVkIGFyZ3VtZW50XCIgcmVmdXNhbCBhbnkgcG9zaXRpb25hbC4gKi9cbiAgYWxsb3dQb3NpdGlvbmFscz86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBGbGFnLWRlcGVuZGVudCBhcml0eSAoaW1hZ28gYGhhbmRvZmYgLS1jbGVhcmAsIG1pbmQtbWFwcGVyIGAtLXRvfC0tY2xlYXJgKVxuICAgKiBhbmQgYW55IG90aGVyIGNvbWJpbmF0aW9uIHJ1bGUuIFJ1bnMgYWZ0ZXIgdGhlIGFyaXR5IGNoZWNrOyBhIHJldHVybmVkXG4gICAqIHN0cmluZyBpcyByZWZ1c2VkIGFzIGEgdXNhZ2UgZXJyb3IgbmFtaW5nIHRoaXMgcm93LiDimqAgVGhlIGRlY2xhcmF0aW9uXG4gICAqIGNhbm5vdCBleHByZXNzIHN1Y2ggYSBydWxlOiBhIHBvc2l0aW9uYWwgdGhhdCBgLS1jbGVhcmAgbWFrZXMgdW5uZWNlc3NhcnlcbiAgICogY2FuIG9ubHkgYmUgZGVjbGFyZWQgYHJlcXVpcmVkOiBmYWxzZWAsIGFuZCB0aGlzIGhvb2sgZW5mb3JjZXMgdGhlIHJlc3QuXG4gICAqL1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb248Rj4pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgbnVtYmVyIGlzIHRoZSBleGl0IGNvZGU7IGFueXRoaW5nIGVsc2UgbWVhbnMgMC4gKi9cbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiB1bmtub3duO1xufTtcblxuLyoqIEEgdmVyYmxlc3MgQ0xJJ3Mgb25lIHJvdyAoZGlnZXN0aWZ5KS4gYHBhdGg6IFtdYCBpbiB0aGUgZGVjbGFyYXRpb24uICovXG5leHBvcnQgdHlwZSBSb290U3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IE9taXQ8Q29tbWFuZFNwZWM8Rj4sIFwibmFtZVwiIHwgXCJhbGlhc2VzXCI+O1xuXG4vKipcbiAqIFdoZXJlIGEgZ3JvdXAncyBzdWItdmVyYiBpcyBmb3VuZC5cbiAqIC0gYGFkamFjZW50YCAoZGVmYXVsdCk6IHRoZSB0b2tlbiByaWdodCBhZnRlciB0aGUgZ3JvdXAgKGBub2RlIGVkaXQgWGApLlxuICogLSBgZmlyc3QtcG9zaXRpb25hbGA6IHRoZSBmaXJzdCB0b2tlbiBhZnRlciB0aGUgZ3JvdXAgdGhhdCBpcyBuZWl0aGVyIGEgZmxhZ1xuICogICBub3IgYSBzdHJpbmcgZmxhZydzIHZhbHVlLCBzbyBmbGFncyBtYXkgY29tZSBmaXJzdDpcbiAqICAgYGRvYyAtLXByb2plY3QgUCBkZWxldGUgRDEgLS1mb3JjZWAgcmVzb2x2ZXMgdG8gYGRvYyBkZWxldGVgIChtaW5kLW1hcHBlcikuXG4gKiAgIFRoZSBzY2FuIHN0b3BzIGF0IGEgYmFyZSBgLS1gLCB3aGljaCBpcyB0aGUgZXNjYXBlIGhhdGNoIGZvciBhIHBvc2l0aW9uYWxcbiAqICAgbGl0ZXJhbGx5IG5hbWVkIGxpa2UgYSBzdWItdmVyYjogYGRvYyAtLSBkZWxldGVgIHJlYWRzIHRoZSBkb2MgXCJkZWxldGVcIi5cbiAqL1xuZXhwb3J0IHR5cGUgR3JvdXBTcGVjID0geyBzdWJWZXJiQXQ/OiBcImFkamFjZW50XCIgfCBcImZpcnN0LXBvc2l0aW9uYWxcIiB9O1xuXG5leHBvcnQgdHlwZSBDbGlTcGVjPE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+ID0ge1xuICAvKiogYFwiYm91bnR5XCJgLCB1c2VkIGluIG1lc3NhZ2VzIGFuZCB0aGUgcmVuZGVyZWQgaGVscC4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogVGhlIHJlbmRlcmVkIGhlbHAncyBmaXJzdCBsaW5lOiBgJHtuYW1lfSDigJQgJHtzdW1tYXJ5fWAuICovXG4gIHN1bW1hcnk/OiBzdHJpbmc7XG4gIC8qKiBUaGUgbGl0ZXJhbCBgQ0xJX09QVElPTlNgIG9iamVjdC4gKi9cbiAgb3B0aW9uczogTztcbiAgY29tbWFuZHM/OiByZWFkb25seSBDb21tYW5kU3BlYzxrZXlvZiBPICYgc3RyaW5nPltdO1xuICAvKipcbiAgICogQSB2ZXJibGVzcyBDTEkncyByb3cuIFJlc2VydmVkIHRva2VucyBhcyBgYXJndlswXWAgc3RpbGwgc2VsZWN0IHRoZWlyIHJvd3NcbiAgICogKGBoZWxwYCwgYHZlcnNpb25gLCBgc2NoZW1hYCwgYW55IGBjb21tYW5kc2AsIGFuZCB0aGUgaW50ZXJjZXB0b3JzKTsgZXZlcnlcbiAgICogb3RoZXIgYXJndiwgdGhlIGVtcHR5IG9uZSBpbmNsdWRlZCwgYmVsb25ncyB0byB0aGUgcm9vdC4gQSBwb3NpdGlvbmFsIHRoYXRcbiAgICogaGFwcGVucyB0byBzcGVsbCBhIHJlc2VydmVkIHRva2VuIGdvZXMgYWZ0ZXIgYSBiYXJlIGAtLWAuXG4gICAqL1xuICByb290PzogUm9vdFNwZWM8a2V5b2YgTyAmIHN0cmluZz47XG4gIC8qKiBBY2NlcHRlZCBieSBldmVyeSByb3csIGJ5IGNvbnRyYWN0IChncmFwZXZpbmUncyBgLS1hc2AvYC0tZnJvbWApLiAqL1xuICBnbG9iYWxGbGFncz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICBncmFtbWFyPzogXCJ2ZXJiLWZpcnN0XCIgfCBcImZsYWdzLWFueXdoZXJlXCI7XG4gIC8qKiBQZXItZ3JvdXAgc3ViLXZlcmIgcGxhY2VtZW50LCBrZXllZCBieSB0aGUgZ3JvdXAgdG9rZW4gKGBcImRvY1wiYCkuICovXG4gIGdyb3Vwcz86IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIEdyb3VwU3BlYz4+O1xuICAvKiogVGhlIHJvb3Qgcm93J3MgcG9zaXRpb25hbCBuYW1lIGluIGBzY2hlbWFgIChgXCJjb21tYW5kXCJgOyBnbGFtb3VyOiBgXCJ2ZXJiXCJgKS4gKi9cbiAgdmVyYlBvc2l0aW9uYWw/OiBzdHJpbmc7XG4gIC8qKiBGbGFncyBsZWZ0IG9mZiBldmVyeSB1c2FnZSBsaW5lIChnbGFtb3VyJ3MgcGVyLXZlcmIgYHNlc3Npb25gKS4gKi9cbiAgdXNhZ2VIaWRlcz86IHJlYWRvbmx5IChrZXlvZiBPICYgc3RyaW5nKVtdO1xuICAvKiogVGhlIGB2ZXJzaW9uYCByb3cncyBwYXlsb2FkLCBge25hbWUsIHZlcnNpb259YC4gKi9cbiAgdmVyc2lvbjogKCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PjtcbiAgLyoqIFJlcGxhY2VzIHRoZSByZW5kZXJlZCBoZWxwIChncmFwZXZpbmUpLiAqL1xuICBoZWxwPzogKCkgPT4gc3RyaW5nO1xuICAvKiogQXBwZW5kZWQgYmVsb3cgdGhlIHJlbmRlcmVkIHJvd3MuICovXG4gIGhlbHBGb290ZXI/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBEZWNsYXJlZEFyZyA9IHsgbmFtZTogc3RyaW5nOyB0eXBlOiBGbGFnVHlwZTsgc3RhdHVzOiBcInZhbGlkXCIgfTtcbmV4cG9ydCB0eXBlIERlY2xhcmVkQ29tbWFuZCA9IHtcbiAgcGF0aDogc3RyaW5nW107XG4gIGFyZ3M6IERlY2xhcmVkQXJnW107XG4gIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xufTtcbmV4cG9ydCB0eXBlIERlY2xhcmF0aW9uID0ge1xuICBmb3JtYXRWZXJzaW9uOiBcIjBcIjtcbiAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCI7XG4gIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBzdHJpbmdbXSB9O1xuICBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW107XG59O1xuXG4vKiogQSByb3cgYXMgdGhlIG1vZHVsZSBob2xkcyBpdCwgZm9yIHRlc3RzIGFuZCB3YXJkcy4gKi9cbmV4cG9ydCB0eXBlIFJvd1ZpZXcgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgYWxpYXNlczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgcm93J3Mgb3duIGZsYWdzLCBhcyBkZWNsYXJlZC4gKi9cbiAgZmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogT3duIGZsYWdzIHBsdXMgYGdsb2JhbEZsYWdzYCwgaW4gb3B0aW9ucy10YWJsZSBvcmRlci4gKi9cbiAgYWNjZXB0ZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBwb3NpdGlvbmFsczogcmVhZG9ubHkgUG9zaXRpb25hbFNwZWNbXTtcbiAgZGVzY3JpYmU6IHN0cmluZztcbiAgLyoqIGB0cnVlYCBmb3IgYSBgaGVscGAvYHZlcnNpb25gL2BzY2hlbWFgIHJvdyB0aGUgbW9kdWxlIGFkZGVkLiAqL1xuICBhdXRvOiBib29sZWFuO1xufTtcblxuZXhwb3J0IHR5cGUgQ2xpID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFbnZlbG9wZSBvbiBmYWlsdXJlLCByZXR1cm5zIHRoZSBleGl0IGNvZGUuIEZvciB0aGUgc3BlbGwncyBgcnVuKClgLiAqL1xuICBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICAvKiogVGhyb3dzIGBDbGlFcnJvcmAsIGZvciBhIHNwZWxsIHdob3NlIG1haW4gZG9lcyBpdHMgb3duIHRyaWFnZS4gKi9cbiAgZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj47XG4gIGRlY2xhcmF0aW9uKCk6IERlY2xhcmF0aW9uO1xuICByZW5kZXJIZWxwKCk6IHN0cmluZztcbiAgLyoqIEEgcm93J3MgdXNhZ2UgbGluZSAoYFwiY2xvc2UgPGlkPiBbLS1mb3JjZV1cImApOyBgXCJcImAgZm9yIGFuIHVua25vd24gcGF0aC4gKi9cbiAgdXNhZ2VPZihwYXRoOiBzdHJpbmcpOiBzdHJpbmc7XG4gIC8qKiBFdmVyeSBmaXJzdCB0b2tlbiB0aGF0IGRpc3BhdGNoZXM6IHZlcmJzLCBhbGlhc2VzIGFuZCBncm91cCB0b2tlbnMuICovXG4gIHZlcmJzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZ1bGwgcGF0aCB0aGF0IGRpc3BhdGNoZXMsIGFsaWFzZXMgaW5jbHVkZWQgKGBcIm5vZGUgZWRpdFwiYCkuICovXG4gIHBhdGhzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIEEgcm93J3MgYWNjZXB0ZWQgc2V0IGFzIGAtLXhgIHNwZWxsaW5ncywgc29ydGVkLiBgXCJcImAgaXMgdGhlIHJvb3QuICovXG4gIGZsYWdzRm9yKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdO1xuICAvKiogRXZlcnkgZmxhZyBpbiB0aGUgb3B0aW9ucyB0YWJsZSwgYXMgYC0teGAsIGluIHRhYmxlIG9yZGVyLiAqL1xuICByZWNvZ25pemVkRmxhZ3M6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICByb3dzOiByZWFkb25seSBSb3dWaWV3W107XG59O1xuXG4vLyDilIDilIAgaW50ZXJuYWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG50eXBlIFJvdyA9IFJvd1ZpZXcgJiB7XG4gIHJlamVjdEhpbnQ/OiBzdHJpbmc7XG4gIGFsbG93UG9zaXRpb25hbHM6IGJvb2xlYW47XG4gIGNoZWNrPzogKGludjogSW52b2NhdGlvbikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBydW46IChpbnY6IEludm9jYXRpb24pID0+IHVua25vd247XG59O1xuXG4vKiogVGhlIHRva2VucyB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi4gRGVjbGFyZWQgYXQgYHBhdGg6IFtdYC4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SUyA9IFtcbiAgeyBuYW1lOiBcIi0taGVscFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLWhcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi0tdmVyc2lvblwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuICB7IG5hbWU6IFwiLVZcIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbl0gYXMgY29uc3Q7XG5cbi8qKiBMb25nIGZpcnN0OiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHQgc3RvcHMgYXQgdGhlIGZpcnN0XG4gKiAgdG9rZW4gdGhhdCBpcyBub3QgYSBgLS1sb25nYCBmbGFnLiAqL1xuY29uc3QgSU5URVJDRVBUT1JfQ0hPSUNFUyA9IElOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuc29ydChcbiAgKGEsIGIpID0+IE51bWJlcihiLnN0YXJ0c1dpdGgoXCItLVwiKSkgLSBOdW1iZXIoYS5zdGFydHNXaXRoKFwiLS1cIikpLFxuKTtcblxuY29uc3QgZXJyQ29kZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+XG4gIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuY29uc3QgZXJyTWVzc2FnZSA9IChlOiB1bmtub3duKTogc3RyaW5nID0+IChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmaW5lQ2xpPGNvbnN0IE8gZXh0ZW5kcyBPcHRpb25zVGFibGU+KHNwZWM6IENsaVNwZWM8Tz4pOiBDbGkge1xuICBjb25zdCBjbGlOYW1lID0gc3BlYy5uYW1lO1xuICBjb25zdCBvcHRpb25LZXlzID0gT2JqZWN0LmtleXMoc3BlYy5vcHRpb25zKTtcbiAgY29uc3Qga25vd24gPSBuZXcgU2V0KG9wdGlvbktleXMpO1xuICBjb25zdCBncmFtbWFyID0gc3BlYy5ncmFtbWFyID8/IFwidmVyYi1maXJzdFwiO1xuICBjb25zdCBnbG9iYWxzID0gWy4uLihzcGVjLmdsb2JhbEZsYWdzID8/IFtdKV0gYXMgc3RyaW5nW107XG4gIGNvbnN0IGhpZGVzID0gbmV3IFNldDxzdHJpbmc+KChzcGVjLnVzYWdlSGlkZXMgPz8gW10pIGFzIHN0cmluZ1tdKTtcblxuICBmb3IgKGNvbnN0IGcgb2YgZ2xvYmFscykge1xuICAgIGlmICgha25vd24uaGFzKGcpKVxuICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdsb2JhbCBmbGFnIFwiJHtnfVwiIGlzIG5vdCBpbiBvcHRpb25zYCk7XG4gIH1cbiAgaWYgKChzcGVjLmNvbW1hbmRzPy5sZW5ndGggPz8gMCkgPT09IDAgJiYgc3BlYy5yb290ID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ2l2ZSBjb21tYW5kcywgYSByb290LCBvciBib3RoYCk7XG4gIH1cblxuICAvLyBgcGFyc2VBcmdzYCBnZXRzIHRoZSB0YWJsZSBXSVRIT1VUIGRlZmF1bHRzOiB3aGljaCBmbGFncyB0aGUgY2FsbGVyIGdhdmUgaXNcbiAgLy8gdGhlIHF1ZXN0aW9uIHRoZSBwZXItcm93IGNoZWNrIGFza3MsIGFuZCBhIGRlZmF1bHQgaXMgbm90IHNvbWV0aGluZyBnaXZlbi5cbiAgY29uc3QgcGFyc2VPcHRpb25zID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIG9wdGlvbktleXMubWFwKChrKSA9PiB7XG4gICAgICBjb25zdCB7IGRlZmF1bHQ6IF9kLCAuLi5yZXN0IH0gPSBzcGVjLm9wdGlvbnNba10gYXMgT3B0aW9uU3BlYztcbiAgICAgIHJldHVybiBbaywgcmVzdF07XG4gICAgfSksXG4gICkgYXMgUmVjb3JkPHN0cmluZywgeyB0eXBlOiBGbGFnVHlwZTsgbXVsdGlwbGU/OiBib29sZWFuOyBzaG9ydD86IHN0cmluZyB9PjtcbiAgY29uc3Qgc2hvcnRUb0tleSA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgayBvZiBvcHRpb25LZXlzKSB7XG4gICAgY29uc3QgcyA9IHNwZWMub3B0aW9uc1trXT8uc2hvcnQ7XG4gICAgaWYgKHMgIT09IHVuZGVmaW5lZCkgc2hvcnRUb0tleS5zZXQocywgayk7XG4gIH1cblxuICBjb25zdCBhY2NlcHRlZE9mID0gKG93bjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSA9PiB7XG4gICAgY29uc3Qgc2V0ID0gbmV3IFNldChbLi4uZ2xvYmFscywgLi4ub3duXSk7XG4gICAgcmV0dXJuIG9wdGlvbktleXMuZmlsdGVyKChrKSA9PiBzZXQuaGFzKGspKTtcbiAgfTtcblxuICBjb25zdCB0b1JvdyA9IChcbiAgICBjOiBPbWl0PENvbW1hbmRTcGVjLCBcInJ1blwiPiAmIHsgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duIH0sXG4gICAgYXV0bzogYm9vbGVhbixcbiAgKTogUm93ID0+IHtcbiAgICBmb3IgKGNvbnN0IGYgb2YgYy5mbGFncykge1xuICAgICAgaWYgKCFrbm93bi5oYXMoZikpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IHJvdyBcIiR7Yy5uYW1lfVwiIG5hbWVzIGZsYWcgXCIke2Z9XCIsIG5vdCBpbiBvcHRpb25zYCk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiBjLm5hbWUsXG4gICAgICBhbGlhc2VzOiBbLi4uKGMuYWxpYXNlcyA/PyBbXSldLFxuICAgICAgZmxhZ3M6IFsuLi5jLmZsYWdzXSxcbiAgICAgIGFjY2VwdGVkOiBhY2NlcHRlZE9mKGMuZmxhZ3MpLFxuICAgICAgcG9zaXRpb25hbHM6IGMucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgIGRlc2NyaWJlOiBjLmRlc2NyaWJlLFxuICAgICAgYXV0byxcbiAgICAgIHJlamVjdEhpbnQ6IGMucmVqZWN0SGludCxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IGMuYWxsb3dQb3NpdGlvbmFscyA/PyB0cnVlLFxuICAgICAgY2hlY2s6IGMuY2hlY2sgYXMgUm93W1wiY2hlY2tcIl0sXG4gICAgICBydW46IGMucnVuIGFzIFJvd1tcInJ1blwiXSxcbiAgICB9O1xuICB9O1xuXG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gKHNwZWMuY29tbWFuZHMgPz8gW10pLm1hcCgoYykgPT4gdG9Sb3coYyBhcyBDb21tYW5kU3BlYywgZmFsc2UpKTtcblxuICAvLyBUaGUgYXV0byByb3dzLiBBZGRlZCBsYXN0LCBpbiB0aGlzIG9yZGVyLCB1bmxlc3MgdGhlIHNwZWxsIGhhcyBpdHMgb3duLlxuICBjb25zdCBjbGkgPSB7fSBhcyBDbGk7XG4gIGNvbnN0IGF1dG9Sb3dzOiBDb21tYW5kU3BlY1tdID0gW1xuICAgIHtcbiAgICAgIG5hbWU6IFwidmVyc2lvblwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTiAoYWxpYXM6IC0tdmVyc2lvbiwgLVYpXCIsXG4gICAgICBydW46IGFzeW5jICgpID0+IHtcbiAgICAgICAgcHJpbnRKc29uKGF3YWl0IHNwZWMudmVyc2lvbigpKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcInNjaGVtYVwiLFxuICAgICAgZmxhZ3M6IFtdLFxuICAgICAgcG9zaXRpb25hbHM6IFtdLFxuICAgICAgZGVzY3JpYmU6IFwidGhpcyBDTEkncyBtYWNoaW5lLXJlYWRhYmxlIGludGVyZmFjZSAoYWNjIGRlY2xhcmF0aW9uIHYwKVwiLFxuICAgICAgcnVuOiAoKSA9PiB7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGNsaS5kZWNsYXJhdGlvbigpLCBudWxsLCAyKX1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgICB7XG4gICAgICBuYW1lOiBcImhlbHBcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInNob3cgdGhpcyBtZXNzYWdlIChhbGlhczogLS1oZWxwLCAtaClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBjb25zdCB0ZXh0ID0gY2xpLnJlbmRlckhlbHAoKTtcbiAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUodGV4dC5lbmRzV2l0aChcIlxcblwiKSA/IHRleHQgOiBgJHt0ZXh0fVxcbmApO1xuICAgICAgfSxcbiAgICB9LFxuICBdO1xuICBmb3IgKGNvbnN0IGEgb2YgYXV0b1Jvd3MpIHtcbiAgICBpZiAoIXJvd3Muc29tZSgocikgPT4gci5uYW1lID09PSBhLm5hbWUpKSByb3dzLnB1c2godG9Sb3coYSwgdHJ1ZSkpO1xuICB9XG5cbiAgY29uc3Qgcm9vdFJvdzogUm93IHwgdW5kZWZpbmVkID1cbiAgICBzcGVjLnJvb3QgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IHRvUm93KHsgLi4uKHNwZWMucm9vdCBhcyBSb290U3BlYyksIG5hbWU6IFwiXCIgfSwgZmFsc2UpO1xuXG4gIC8vIEluZGV4IGV2ZXJ5IHNwZWxsaW5nLCBhbmQgY2hlY2sgdGhlIHRhYmxlIGlzIHdlbGwgZm9ybWVkLlxuICBjb25zdCBieVRva2VuID0gbmV3IE1hcDxzdHJpbmcsIFJvdz4oKTtcbiAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgY29uc3QgcGFydHMgPSB0LnNwbGl0KFwiIFwiKTtcbiAgICAgIGlmICh0LnRyaW0oKSAhPT0gdCB8fCBwYXJ0cy5sZW5ndGggPiAyIHx8IHBhcnRzLnNvbWUoKHApID0+IHAgPT09IFwiXCIgfHwgcC5zdGFydHNXaXRoKFwiLVwiKSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGJhZCBjb21tYW5kIG5hbWUgXCIke3R9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmICh0ICE9PSByLm5hbWUgJiYgcGFydHMubGVuZ3RoICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpLmxlbmd0aCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogYWxpYXMgXCIke3R9XCIgbXVzdCBuZXN0IGxpa2UgXCIke3IubmFtZX1cImApO1xuICAgICAgfVxuICAgICAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMiAmJiB0ICE9PSByLm5hbWUgJiYgcGFydHNbMF0gIT09IHIubmFtZS5zcGxpdChcIiBcIilbMF0pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3Qgc2hhcmUgdGhlIGdyb3VwIG9mIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChieVRva2VuLmhhcyh0KSkgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IFwiJHt0fVwiIGlzIGRlZmluZWQgdHdpY2VgKTtcbiAgICAgIGJ5VG9rZW4uc2V0KHQsIHIpO1xuICAgIH1cbiAgfVxuICBjb25zdCBzdWJzT2YgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3QgdCBvZiBieVRva2VuLmtleXMoKSkge1xuICAgIGNvbnN0IFtncm91cCwgc3ViXSA9IHQuc3BsaXQoXCIgXCIpO1xuICAgIGlmIChncm91cCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBzdWJzT2Yuc2V0KGdyb3VwLCBbLi4uKHN1YnNPZi5nZXQoZ3JvdXApID8/IFtdKSwgc3ViXSk7XG4gICAgfVxuICB9XG4gIGZvciAoY29uc3QgZyBvZiBPYmplY3Qua2V5cyhzcGVjLmdyb3VwcyA/PyB7fSkpIHtcbiAgICBpZiAoIXN1YnNPZi5oYXMoZykpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBncm91cCBcIiR7Z31cIiBoYXMgbm8gc3ViLXZlcmJzYCk7XG4gIH1cblxuICBjb25zdCBwYXRocyA9IFsuLi5ieVRva2VuLmtleXMoKV07XG4gIGNvbnN0IHZlcmJzID0gWy4uLm5ldyBTZXQocGF0aHMubWFwKChwKSA9PiBwLnNwbGl0KFwiIFwiKVswXSBhcyBzdHJpbmcpKV07XG5cbiAgY29uc3Qgcm93Rm9yID0gKHBhdGg6IHN0cmluZyk6IFJvdyB8IHVuZGVmaW5lZCA9PiAocGF0aCA9PT0gXCJcIiA/IHJvb3RSb3cgOiBieVRva2VuLmdldChwYXRoKSk7XG4gIGNvbnN0IGZsYWdzRm9yID0gKHBhdGg6IHN0cmluZyk6IHN0cmluZ1tdID0+XG4gICAgWy4uLihyb3dGb3IocGF0aCk/LmFjY2VwdGVkID8/IFtdKV0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuICBjb25zdCBsYWJlbCA9IChyOiBSb3cpOiBzdHJpbmcgPT4gci5uYW1lIHx8IGNsaU5hbWU7XG5cbiAgLyoqXG4gICAqIEEgdmVyYmxlc3Mgcm9vdCdzIHJlamVjdGlvbiBgY2hvaWNlc2A6IGl0cyBvd24gZmxhZ3MgUExVUyB0aGUgaW50ZXJjZXB0b3JzLFxuICAgKiBiZWNhdXNlIHRoZSBkZWNsYXJhdGlvbiBwdWJsaXNoZXMgYm90aCBhdCBgcGF0aDogW11gIGFuZCB0aGUgcm9vdCBhbnN3ZXJzXG4gICAqIGJvdGggKHRoZSBpbnRlcmNlcHRvcnMgYXMgYGFyZ3ZbMF1gKS4gTGVhdmluZyB0aGUgaW50ZXJjZXB0b3JzIG91dCBtYWRlXG4gICAqIG9uZSBwcm9jZXNzIHNheSB0d28gdGhpbmdzIGFib3V0IGl0cyByb290IOKAlCBhY2MncyBjZW5zdXMgcmVhZCBgLS1oZWxwYCxcbiAgICogYC1oYCwgYC0tdmVyc2lvbmAgYW5kIGAtVmAgYXMgZGVjbGFyZWQtbm90LWFjY2VwdGVkLiBMb25nIHNwZWxsaW5ncyBmaXJzdFxuICAgKiAoc29ydGVkKSwgdGhlbiB0aGUgc2hvcnRzOiBhIGZsYWctc2V0IGV4dHJhY3RvciByZWFkaW5nIGxlZnQgdG8gcmlnaHRcbiAgICogc3RvcHMgYXQgdGhlIGZpcnN0IHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy5cbiAgICovXG4gIGNvbnN0IHJvb3RDaG9pY2VzOiBzdHJpbmdbXSA9ICgoKSA9PiB7XG4gICAgY29uc3QgYWxsID0gWy4uLmZsYWdzRm9yKFwiXCIpLCAuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXTtcbiAgICBjb25zdCBsb25nID0gYWxsLmZpbHRlcigoZikgPT4gZi5zdGFydHNXaXRoKFwiLS1cIikpLnNvcnQoKTtcbiAgICByZXR1cm4gWy4uLmxvbmcsIC4uLmFsbC5maWx0ZXIoKGYpID0+ICFmLnN0YXJ0c1dpdGgoXCItLVwiKSldO1xuICB9KSgpO1xuXG4gIC8vIOKUgOKUgCBoZWxwIOKUgOKUgFxuXG4gIGNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGlubmVyID0gcC52YXJpYWRpYyA/IGAke3AubmFtZX0uLi5gIDogcC5uYW1lO1xuICAgIHJldHVybiBwLnJlcXVpcmVkID8gYDwke2lubmVyfT5gIDogYFske2lubmVyfV1gO1xuICB9O1xuICBjb25zdCByZW5kZXJGbGFnID0gKGs6IHN0cmluZyk6IHN0cmluZyA9PlxuICAgIHNwZWMub3B0aW9uc1trXT8udHlwZSA9PT0gXCJib29sZWFuXCIgPyBgWy0tJHtrfV1gIDogYFstLSR7a30gLi5dYDtcbiAgY29uc3QgdXNhZ2VMaW5lID0gKHI6IFJvdyk6IHN0cmluZyA9PlxuICAgIFtcbiAgICAgIGxhYmVsKHIpLFxuICAgICAgLi4uci5wb3NpdGlvbmFscy5tYXAocmVuZGVyUG9zaXRpb25hbCksXG4gICAgICAuLi5yLmZsYWdzLmZpbHRlcigoaykgPT4gIWhpZGVzLmhhcyhrKSkubWFwKHJlbmRlckZsYWcpLFxuICAgIF0uam9pbihcIiBcIik7XG4gIGNvbnN0IGV4cGVjdHMgPSAocjogUm93KTogc3RyaW5nID0+IGBleHBlY3RzOiAke3VzYWdlTGluZShyKX1gO1xuXG4gIGNvbnN0IHJlbmRlckhlbHAgPSAoKTogc3RyaW5nID0+IHtcbiAgICBpZiAoc3BlYy5oZWxwICE9PSB1bmRlZmluZWQpIHJldHVybiBzcGVjLmhlbHAoKTtcbiAgICBjb25zdCBsaXN0ZWQgPSBbLi4uKHJvb3RSb3cgPyBbcm9vdFJvd10gOiBbXSksIC4uLnJvd3NdO1xuICAgIGNvbnN0IGxpbmVzID0gbGlzdGVkLm1hcCgocikgPT4gW3VzYWdlTGluZShyKSwgci5kZXNjcmliZV0gYXMgY29uc3QpO1xuICAgIGNvbnN0IHdpZHRoID0gTWF0aC5taW4oTWF0aC5tYXgoLi4ubGluZXMubWFwKChbdV0pID0+IHUubGVuZ3RoKSksIDQ0KTtcbiAgICBjb25zdCBib2R5ID0gbGluZXNcbiAgICAgIC5tYXAoKFt1LCBkXSkgPT5cbiAgICAgICAgdS5sZW5ndGggPD0gd2lkdGggPyBgICAke3UucGFkRW5kKHdpZHRoKX0gICR7ZH1gIDogYCAgJHt1fVxcbiAgJHtcIlwiLnBhZEVuZCh3aWR0aCl9ICAke2R9YCxcbiAgICAgIClcbiAgICAgIC5qb2luKFwiXFxuXCIpO1xuICAgIGNvbnN0IGhlYWQgPSBzcGVjLnN1bW1hcnkgPyBgJHtjbGlOYW1lfSDigJQgJHtzcGVjLnN1bW1hcnl9YCA6IGNsaU5hbWU7XG4gICAgY29uc3QgdG9rZW5zID0gYCAgJHtJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLmpvaW4oXCIgfCBcIil9ICByb290IHRva2VuczogaGVscCwgb3Ige25hbWUsIHZlcnNpb259IGFzIEpTT05gO1xuICAgIHJldHVybiBgJHtoZWFkfVxcblxcbiR7Ym9keX1cXG4ke3Rva2Vuc30ke3NwZWMuaGVscEZvb3RlciA/IGBcXG5cXG4ke3NwZWMuaGVscEZvb3Rlcn1gIDogXCJcIn1gO1xuICB9O1xuXG4gIC8vIOKUgOKUgCB0aGUgZGVjbGFyYXRpb24g4pSA4pSAXG5cbiAgY29uc3QgZGVjbGFyYXRpb24gPSAoKTogRGVjbGFyYXRpb24gPT4ge1xuICAgIGNvbnN0IGFyZyA9IChrOiBzdHJpbmcpOiBEZWNsYXJlZEFyZyA9PiAoe1xuICAgICAgbmFtZTogYC0tJHtrfWAsXG4gICAgICB0eXBlOiAoc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWMpLnR5cGUsXG4gICAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgICB9KTtcbiAgICBjb25zdCBjb21tYW5kczogRGVjbGFyZWRDb21tYW5kW10gPSBbXG4gICAgICB7XG4gICAgICAgIHBhdGg6IFtdLFxuICAgICAgICBhcmdzOiBbXG4gICAgICAgICAgLi4uSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gKHtcbiAgICAgICAgICAgIG5hbWU6IGkubmFtZSxcbiAgICAgICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICAgICAgc3RhdHVzOiBcInZhbGlkXCIgYXMgY29uc3QsXG4gICAgICAgICAgfSkpLFxuICAgICAgICAgIC4uLihyb290Um93ID8gcm9vdFJvdy5hY2NlcHRlZC5tYXAoYXJnKSA6IFtdKSxcbiAgICAgICAgXSxcbiAgICAgICAgcG9zaXRpb25hbHM6IHJvb3RSb3dcbiAgICAgICAgICA/IHJvb3RSb3cucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKVxuICAgICAgICAgIDogW3sgbmFtZTogc3BlYy52ZXJiUG9zaXRpb25hbCA/PyBcImNvbW1hbmRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgICB9LFxuICAgIF07XG4gICAgZm9yIChjb25zdCByIG9mIHJvd3MpIHtcbiAgICAgIGZvciAoY29uc3QgdCBvZiBbci5uYW1lLCAuLi5yLmFsaWFzZXNdKSB7XG4gICAgICAgIGNvbW1hbmRzLnB1c2goe1xuICAgICAgICAgIHBhdGg6IHQuc3BsaXQoXCIgXCIpLFxuICAgICAgICAgIGFyZ3M6IHIuYWNjZXB0ZWQubWFwKGFyZyksXG4gICAgICAgICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMubWFwKChwKSA9PiAoeyAuLi5wIH0pKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGNvbnN0IHNjaGVtYVJvdyA9IGJ5VG9rZW4uZ2V0KFwic2NoZW1hXCIpIGFzIFJvdztcbiAgICByZXR1cm4ge1xuICAgICAgZm9ybWF0VmVyc2lvbjogXCIwXCIsXG4gICAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICAgIHNlbGZEZXNjcmlwdGlvbjogeyBhcmdzOiBbc2NoZW1hUm93Lm5hbWVdIH0sXG4gICAgICBjb21tYW5kcyxcbiAgICB9O1xuICB9O1xuXG4gIC8vIOKUgOKUgCBkaXNwYXRjaCDilIDilIBcblxuICAvKipcbiAgICogVGhlIGluZGV4IG9mIHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5laXRoZXIgYSBmbGFnIG5vciBhIHN0cmluZyBmbGFnJ3NcbiAgICogdmFsdWUsIHdhbGtpbmcgdGhlIHdheSB0aGUgcGFyc2VyIHdpbGw6IGAtLWsgdmAgY29uc3VtZXMgYHZgIHdoZW4gYGtgIGlzIGFcbiAgICogc3RyaW5nIGZsYWcsIGAtLWs9dmAgY29uc3VtZXMgbm90aGluZywgYC1zIHZgIGxpa2V3aXNlIGJ5IHRoZSBzaG9ydCdzIHR5cGUuXG4gICAqIEF0IGEgYmFyZSBgLS1gOiBgLTFgIHdoZW4gYHN0b3BBdFRlcm1pbmF0b3JgLCBlbHNlIHRoZSBpbmRleCBhZnRlciBpdC5cbiAgICovXG4gIGNvbnN0IHNjYW5Qb3NpdGlvbmFsID0gKGFyZ3M6IHN0cmluZ1tdLCBzdG9wQXRUZXJtaW5hdG9yOiBib29sZWFuKTogbnVtYmVyID0+IHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGFyZ3MubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGEgPSBhcmdzW2ldIGFzIHN0cmluZztcbiAgICAgIGlmIChhID09PSBcIi0tXCIpIHJldHVybiBzdG9wQXRUZXJtaW5hdG9yIHx8IGkgKyAxID49IGFyZ3MubGVuZ3RoID8gLTEgOiBpICsgMTtcbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItLVwiKSkge1xuICAgICAgICBpZiAoYS5pbmNsdWRlcyhcIj1cIikpIGNvbnRpbnVlO1xuICAgICAgICBpZiAoc3BlYy5vcHRpb25zW2Euc2xpY2UoMildPy50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgaWYgKGEuc3RhcnRzV2l0aChcIi1cIikgJiYgYS5sZW5ndGggPiAxKSB7XG4gICAgICAgIGNvbnN0IGtleSA9IGEubGVuZ3RoID09PSAyID8gc2hvcnRUb0tleS5nZXQoYS5zbGljZSgxKSkgOiB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBzcGVjLm9wdGlvbnNba2V5XT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBpO1xuICAgIH1cbiAgICByZXR1cm4gLTE7XG4gIH07XG5cbiAgY29uc3Qgd2l0aG91dCA9IChhcmdzOiBzdHJpbmdbXSwgaTogbnVtYmVyKTogc3RyaW5nW10gPT4gW1xuICAgIC4uLmFyZ3Muc2xpY2UoMCwgaSksXG4gICAgLi4uYXJncy5zbGljZShpICsgMSksXG4gIF07XG5cbiAgY29uc3Qgbm9Db21tYW5kID0gKCk6IG5ldmVyID0+XG4gICAgZGllKFwiZXhwZWN0ZWQgYSBjb21tYW5kXCIsIFwidXNhZ2VcIiwge1xuICAgICAgY2hvaWNlczogWy4uLnZlcmJzXSxcbiAgICAgIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIChvciAtLWhlbHApIGZvciB1c2FnZWAsXG4gICAgfSk7XG5cbiAgLyoqIEEgdmVyYiBjYW5kaWRhdGUgYW5kIHRoZSBhcmdzIGFmdGVyIGl0LCB0byBhIHJvdyBhbmQgdGhhdCByb3cncyBhcmdzLiAqL1xuICBjb25zdCByZXNvbHZlID0gKGNhbmQ6IHN0cmluZywgcmVzdDogc3RyaW5nW10pOiB7IHJvdzogUm93OyB0b2tlbjogc3RyaW5nOyBhcmdzOiBzdHJpbmdbXSB9ID0+IHtcbiAgICBjb25zdCBzdWJzID0gc3Vic09mLmdldChjYW5kKTtcbiAgICBpZiAoc3VicyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25zdCBhdCA9IHNwZWMuZ3JvdXBzPy5bY2FuZF0/LnN1YlZlcmJBdCA/PyBcImFkamFjZW50XCI7XG4gICAgICBsZXQgaSA9IC0xO1xuICAgICAgaWYgKGF0ID09PSBcImFkamFjZW50XCIpIHtcbiAgICAgICAgY29uc3QgbmV4dCA9IHJlc3RbMF07XG4gICAgICAgIGkgPSBuZXh0ICE9PSB1bmRlZmluZWQgJiYgIW5leHQuc3RhcnRzV2l0aChcIi1cIikgPyAwIDogLTE7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBpID0gc2NhblBvc2l0aW9uYWwocmVzdCwgdHJ1ZSk7XG4gICAgICB9XG4gICAgICBjb25zdCBzdWIgPSBpID49IDAgPyAocmVzdFtpXSBhcyBzdHJpbmcpIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgZnVsbCA9IHN1YiA9PT0gdW5kZWZpbmVkID8gdW5kZWZpbmVkIDogYnlUb2tlbi5nZXQoYCR7Y2FuZH0gJHtzdWJ9YCk7XG4gICAgICBpZiAoZnVsbCAhPT0gdW5kZWZpbmVkICYmIHN1YiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiB7IHJvdzogZnVsbCwgdG9rZW46IGAke2NhbmR9ICR7c3VifWAsIGFyZ3M6IHdpdGhvdXQocmVzdCwgaSkgfTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IG93biA9IGJ5VG9rZW4uZ2V0KGNhbmQpO1xuICAgICAgaWYgKG93biAhPT0gdW5kZWZpbmVkKSByZXR1cm4geyByb3c6IG93biwgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgICAgIGNvbnN0IGV4dHJhID0geyBjaG9pY2VzOiBbLi4uc3Vic10sIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIGZvciB1c2FnZWAgfTtcbiAgICAgIGlmIChzdWIgPT09IHVuZGVmaW5lZCkgZGllKGAke2NhbmR9OiBleHBlY3RlZCBhIHN1Yi1jb21tYW5kYCwgXCJ1c2FnZVwiLCBleHRyYSk7XG4gICAgICBkaWUoYHVua25vd24gJHtjYW5kfSBzdWItY29tbWFuZDogXCIke3N1Yn1cImAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgIH1cbiAgICBjb25zdCByb3cgPSBieVRva2VuLmdldChjYW5kKTtcbiAgICBpZiAocm93ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIGRpZShgdW5rbm93biBjb21tYW5kIFwiJHtjYW5kfVwiYCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICAgIGhpbnQ6IGBydW4gXFxgJHtjbGlOYW1lfSBoZWxwXFxgIGZvciB1c2FnZWAsXG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIHsgcm93LCB0b2tlbjogY2FuZCwgYXJnczogcmVzdCB9O1xuICB9O1xuXG4gIC8qKlxuICAgKiBDb250cmFjdCA1J3MgYC0tYCBtYWRlIHRoZSBjYWxsZXIncyBmbGFnIFRFWFQ7IHNheSBzbyAoYzEsXG4gICAqIGBkb2NzL2l0ZW1zL3Rlcm1pbmF0b3ItZWF0cy1zZXNzaW9uLWtleS5tZGApLiBBIHBvc3QtYC0tYCB0b2tlbiB0aGF0IHNwZWxsc1xuICAgKiBhIGZsYWcgdGhpcyByb3cgYWNjZXB0cyDigJQgYC0ta2AsIGAtLWs9dmAsIG9yIHRoZSBzaG9ydCBgLXNgIG9mIGFuIGFjY2VwdGVkXG4gICAqIGBrYCwgZ2xvYmFscyBpbmNsdWRlZCDigJQgaXMgbmFtZWQgaW4gT05FIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciwgd2l0aFxuICAgKiB0aGUgbW92ZSB0aGF0IHJlY292ZXJzIGl0LiBTdGRvdXQgYW5kIHRoZSBleGl0IGNvZGUgZG8gbm90IGNoYW5nZSwgYW5kIHRoZVxuICAgKiByb3cgc3RpbGwgcnVuczogdGV4dCBjb250YWluaW5nIGEgZmxhZyBuYW1lIGlzIGxlZ2l0aW1hdGUsIHdoaWNoIGlzIHdoYXRcbiAgICogYC0tYCBpcyBmb3IuIEEgdG9rZW4gdGhlIHJvdyBkb2VzIG5vdCBhY2NlcHQgaXMganVzdCB0ZXh0LCBhbmQgc2F5cyBub3RoaW5nLlxuICAgKlxuICAgKiDimqAgQ2FsbGVkIG9ubHkgb25jZSBldmVyeSByZWZ1c2FsIGhhcyBwYXNzZWQsIHNvIGEgcmVmdXNlZCBpbnZvY2F0aW9uJ3NcbiAgICogc3RkZXJyIGlzIHN0aWxsIGV4YWN0bHkgb25lIGVudmVsb3BlLiBUaGUgYCMgYCBwcmVmaXggaXMgdGhlIGhvdXNlJ3NcbiAgICogc3VjY2Vzcy1wYXRoIHN0ZGVyciBmb3JtIChgIyB3YXJuaW5nOmAgaW4gbWluZC1tYXBwZXIsIGAjIHBpbm5lZCBib2FyZGAsXG4gICAqIGAjIOKGkiBjaGFubmVsYCk6IGFuIGVudmVsb3BlIHJlYWRlciBsb29rcyBmb3IgYSBge2AgbGluZSBhbmQgc2tpcHMgaXQuXG4gICAqL1xuICBjb25zdCB3YXJuRGVtb3RlZCA9IChcbiAgICByb3c6IFJvdyxcbiAgICBhY2NlcHRlZDogUmVhZG9ubHlTZXQ8c3RyaW5nPixcbiAgICB0b2tlbnM6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz5bXCJ0b2tlbnNcIl0sXG4gICk6IHZvaWQgPT4ge1xuICAgIGNvbnN0IGVuZCA9IHRva2Vucz8uZmluZEluZGV4KCh0KSA9PiB0LmtpbmQgPT09IFwib3B0aW9uLXRlcm1pbmF0b3JcIikgPz8gLTE7XG4gICAgaWYgKHRva2VucyA9PT0gdW5kZWZpbmVkIHx8IGVuZCA8IDApIHJldHVybjtcbiAgICBjb25zdCBkZW1vdGVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgdCBvZiB0b2tlbnMuc2xpY2UoZW5kICsgMSkpIHtcbiAgICAgIGlmICh0LmtpbmQgIT09IFwicG9zaXRpb25hbFwiKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHYgPSB0LnZhbHVlO1xuICAgICAgbGV0IGtleTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgICAgaWYgKHYuc3RhcnRzV2l0aChcIi0tXCIpKSBrZXkgPSB2LnNsaWNlKDIpLnNwbGl0KFwiPVwiKVswXTtcbiAgICAgIGVsc2UgaWYgKHYubGVuZ3RoID09PSAyICYmIHYuc3RhcnRzV2l0aChcIi1cIikpIGtleSA9IHNob3J0VG9LZXkuZ2V0KHYuc2xpY2UoMSkpO1xuICAgICAgaWYgKGtleSAhPT0gdW5kZWZpbmVkICYmIGtleSAhPT0gXCJcIiAmJiBhY2NlcHRlZC5oYXMoa2V5KSkgZGVtb3RlZC5wdXNoKHYpO1xuICAgIH1cbiAgICBpZiAoZGVtb3RlZC5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCB3aGljaCA9IGRlbW90ZWQuam9pbihcIiwgXCIpO1xuICAgIGNvbnN0IG9uZSA9IGRlbW90ZWQubGVuZ3RoID09PSAxO1xuICAgIGNvbnN0IGl0ID0gb25lID8gXCJpdFwiIDogXCJ0aGVtXCI7XG4gICAgY29uc3Qgd2FzID0gb25lID8gXCJ3YXNcIiA6IFwid2VyZVwiO1xuICAgIGNvbnN0IGFzRmxhZyA9IG9uZSA/IFwiYXMgYSBmbGFnXCIgOiBcImFzIGZsYWdzXCI7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgIyB3YXJuaW5nOiAke2NsaU5hbWV9JHtyb3cubmFtZSA9PT0gXCJcIiA/IFwiXCIgOiBgICR7cm93Lm5hbWV9YH06ICR7d2hpY2h9IGFmdGVyIFxcYC0tXFxgICR7d2FzfSByZWFkIGFzIHRleHQsIG5vdCAke2FzRmxhZ307IHRvIHVzZSAke2l0fSAke2FzRmxhZ30sIG1vdmUgJHtpdH0gYmVmb3JlIFxcYC0tXFxgXFxuYCxcbiAgICApO1xuICB9O1xuXG4gIGNvbnN0IHJ1blJvdyA9IGFzeW5jIChyb3c6IFJvdywgdG9rZW46IHN0cmluZywgYXJnczogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4gPT4ge1xuICAgIHNldEN1cnJlbnRDb21tYW5kKHJvdy5uYW1lID09PSBcIlwiID8gbnVsbCA6IHJvdy5uYW1lKTtcbiAgICBjb25zdCBuYW1lID0gbGFiZWwocm93KTtcbiAgICBjb25zdCBhY2NlcHRlZCA9IG5ldyBTZXQocm93LmFjY2VwdGVkKTtcbiAgICBjb25zdCBjaG9pY2VzID0gcm93Lm5hbWUgPT09IFwiXCIgPyByb290Q2hvaWNlcyA6IGZsYWdzRm9yKHJvdy5uYW1lKTtcbiAgICBjb25zdCBmbGFnSGludCA9ICgpOiBzdHJpbmcgfCB1bmRlZmluZWQgPT5cbiAgICAgIFtyb3cucmVqZWN0SGludCwgY2hvaWNlcy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBmbGFnc2AgOiB1bmRlZmluZWRdXG4gICAgICAgIC5maWx0ZXIoKHMpOiBzIGlzIHN0cmluZyA9PiBzICE9PSB1bmRlZmluZWQpXG4gICAgICAgIC5qb2luKFwiOyBcIikgfHwgdW5kZWZpbmVkO1xuXG4gICAgbGV0IHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgbGV0IHBvc2l0aW9uYWxzOiBzdHJpbmdbXTtcbiAgICBsZXQgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdO1xuICAgIHRyeSB7XG4gICAgICAoeyB2YWx1ZXMsIHBvc2l0aW9uYWxzLCB0b2tlbnMgfSA9IHBhcnNlQXJncyh7XG4gICAgICAgIGFyZ3MsXG4gICAgICAgIG9wdGlvbnM6IHBhcnNlT3B0aW9ucyxcbiAgICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgICBhbGxvd1Bvc2l0aW9uYWxzOiByb3cuYWxsb3dQb3NpdGlvbmFscyxcbiAgICAgICAgdG9rZW5zOiB0cnVlLFxuICAgICAgfSkpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlmIChlcnJDb2RlKGUpID09PSBcIkVSUl9QQVJTRV9BUkdTX1VOS05PV05fT1BUSU9OXCIpIHtcbiAgICAgICAgZGllKGAke25hbWV9OiAke2Vyck1lc3NhZ2UoZSl9YCwgXCJ1c2FnZVwiLCB7IGNob2ljZXMsIGhpbnQ6IGZsYWdIaW50KCkgfSk7XG4gICAgICB9XG4gICAgICAvLyBBIG1pc3NpbmcgdmFsdWUgaXMgbm90IGEgY2hvaWNlIGZyb20gYSBzZXQsIHNvIG5vIGBjaG9pY2VzYCBoZXJlLlxuICAgICAgZGllKGAke25hbWV9OiAke2Vyck1lc3NhZ2UoZSl9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IHJvdy5yZWplY3RIaW50ID8/IGV4cGVjdHMocm93KSB9KTtcbiAgICB9XG5cbiAgICAvLyBTdGFnZSAyOiBrbm93biB0byB0aGUgc3BlbGwsIG5vdCB0YWtlbiBieSB0aGlzIHJvdyDigJQgTUlTUExBQ0VELCBub3RcbiAgICAvLyB1bmtub3duLiBPbmx5IGZsYWdzIHRoZSBjYWxsZXIgR0FWRSBhcmUgaGVyZTogZGVmYXVsdHMgYXJlIG5vdCBhcHBsaWVkIHlldC5cbiAgICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKHZhbHVlcykuZmluZCgoaykgPT4gIWFjY2VwdGVkLmhhcyhrKSk7XG4gICAgaWYgKHN0cmF5ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7bmFtZX1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCAke2NsaU5hbWV9IGZsYWcsIGp1c3Qgbm90IHRoaXMgJHtyb3cubmFtZSA9PT0gXCJcIiA/IFwiY29tbWFuZFwiIDogXCJ2ZXJiXCJ9J3MpYCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGNob2ljZXMsIGhpbnQ6IGZsYWdIaW50KCkgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gQXJpdHksIGZyb20gdGhlIGRlY2xhcmVkIHNoYXBlLCBuYW1pbmcgdGhlIG1pc3Npbmcgb3IgdGhlIGV4dHJhIHRva2VuLlxuICAgIGNvbnN0IHJlcXVpcmVkID0gcm93LnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICAgIGNvbnN0IHZhcmlhZGljID0gcm93LnBvc2l0aW9uYWxzLnNvbWUoKHApID0+IHAudmFyaWFkaWMpO1xuICAgIGlmIChwb3NpdGlvbmFscy5sZW5ndGggPCByZXF1aXJlZCkge1xuICAgICAgY29uc3QgbWlzc2luZyA9IHJvdy5wb3NpdGlvbmFsc1twb3NpdGlvbmFscy5sZW5ndGhdO1xuICAgICAgZGllKGAke25hbWV9OiBtaXNzaW5nIHJlcXVpcmVkIDwke21pc3Npbmc/Lm5hbWUgPz8gXCJhcmd1bWVudFwifT5gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgaGludDogZXhwZWN0cyhyb3cpLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmICghdmFyaWFkaWMgJiYgcG9zaXRpb25hbHMubGVuZ3RoID4gcm93LnBvc2l0aW9uYWxzLmxlbmd0aCkge1xuICAgICAgZGllKFxuICAgICAgICBgJHtuYW1lfTogdW5leHBlY3RlZCBhcmd1bWVudCAke0pTT04uc3RyaW5naWZ5KHBvc2l0aW9uYWxzW3Jvdy5wb3NpdGlvbmFscy5sZW5ndGhdKX1gLFxuICAgICAgICBcInVzYWdlXCIsXG4gICAgICAgIHsgaGludDogcm93LnBvc2l0aW9uYWxzLmxlbmd0aCA9PT0gMCA/IGAke25hbWV9IHRha2VzIG5vIGFyZ3VtZW50c2AgOiBleHBlY3RzKHJvdykgfSxcbiAgICAgICk7XG4gICAgfVxuXG4gICAgLy8gRGVmYXVsdHMgbGFzdCwgYW5kIG9ubHkgdGhpcyByb3cncy5cbiAgICBjb25zdCBmbGFnczogUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPiA9IHsgLi4uKHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBGbGFnVmFsdWU+KSB9O1xuICAgIGZvciAoY29uc3QgayBvZiByb3cuYWNjZXB0ZWQpIHtcbiAgICAgIGNvbnN0IGQgPSAoc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWMpLmRlZmF1bHQ7XG4gICAgICBpZiAoZmxhZ3Nba10gPT09IHVuZGVmaW5lZCAmJiBkICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgZmxhZ3Nba10gPSAoQXJyYXkuaXNBcnJheShkKSA/IFsuLi5kXSA6IGQpIGFzIEZsYWdWYWx1ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBjb25zdCBpbnY6IEludm9jYXRpb24gPSB7IHBhdGg6IHJvdy5uYW1lLCB0b2tlbiwgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3MgfTtcbiAgICBjb25zdCByZWZ1c2VkID0gcm93LmNoZWNrPy4oaW52KTtcbiAgICBpZiAocmVmdXNlZCAhPT0gdW5kZWZpbmVkKSBkaWUoYCR7bmFtZX06ICR7cmVmdXNlZH1gLCBcInVzYWdlXCIsIHsgaGludDogZXhwZWN0cyhyb3cpIH0pO1xuXG4gICAgd2FybkRlbW90ZWQocm93LCBhY2NlcHRlZCwgdG9rZW5zKTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCByb3cucnVuKGludik7XG4gICAgcmV0dXJuIHR5cGVvZiBvdXQgPT09IFwibnVtYmVyXCIgPyBvdXQgOiAwO1xuICB9O1xuXG4gIGNvbnN0IGRpc3BhdGNoID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChhcmd2WzBdID8/IG51bGwpO1xuICAgIGNvbnN0IGZpcnN0ID0gYXJndlswXTtcblxuICAgIC8vIDEuIEludGVyY2VwdG9ycyBwYXNzIHRoZSByZXN0IG9mIHRoZSBhcmd2IG9uIHRvIHRoZWlyIHJvdy5cbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IElOVEVSQ0VQVE9SUy5maW5kKChpKSA9PiBpLm5hbWUgPT09IGZpcnN0KTtcbiAgICBpZiAoaW50ZXJjZXB0b3IgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIHJ1blJvdyhieVRva2VuLmdldChpbnRlcmNlcHRvci5ydW5zKSBhcyBSb3csIGludGVyY2VwdG9yLnJ1bnMsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgIH1cblxuICAgIC8vIDIuIEEgdmVyYmxlc3Mgcm9vdCBvd25zIGV2ZXJ5IGFyZ3YgdGhhdCBkb2VzIG5vdCBzdGFydCB3aXRoIGEgcmVzZXJ2ZWQgdG9rZW4uXG4gICAgaWYgKHJvb3RSb3cgIT09IHVuZGVmaW5lZCkge1xuICAgICAgaWYgKGZpcnN0ICE9PSB1bmRlZmluZWQgJiYgKGJ5VG9rZW4uaGFzKGZpcnN0KSB8fCBzdWJzT2YuaGFzKGZpcnN0KSkpIHtcbiAgICAgICAgY29uc3QgciA9IHJlc29sdmUoZmlyc3QsIGFyZ3Yuc2xpY2UoMSkpO1xuICAgICAgICByZXR1cm4gcnVuUm93KHIucm93LCByLnRva2VuLCByLmFyZ3MpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHJ1blJvdyhyb290Um93LCBcIlwiLCBhcmd2KTtcbiAgICB9XG5cbiAgICAvLyAzLiBCYXJlIGludm9jYXRpb24gaXMgYSB1c2FnZSBlcnJvciAoYWNjIEMyL0QyKS5cbiAgICBpZiAoZmlyc3QgPT09IHVuZGVmaW5lZCkgcmV0dXJuIG5vQ29tbWFuZCgpO1xuXG4gICAgLy8gNC4gRmluZCB0aGUgdmVyYi5cbiAgICBsZXQgY2FuZDogc3RyaW5nO1xuICAgIGxldCByZXN0OiBzdHJpbmdbXTtcbiAgICBpZiAoZ3JhbW1hciA9PT0gXCJ2ZXJiLWZpcnN0XCIpIHtcbiAgICAgIGlmIChmaXJzdCA9PT0gXCItLVwiKSB7XG4gICAgICAgIGlmIChhcmd2WzFdID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgICAgY2FuZCA9IGFyZ3ZbMV07XG4gICAgICAgIHJlc3QgPSBbXCItLVwiLCAuLi5hcmd2LnNsaWNlKDIpXTtcbiAgICAgIH0gZWxzZSBpZiAoZmlyc3Quc3RhcnRzV2l0aChcIi1cIikpIHtcbiAgICAgICAgcmV0dXJuIGRpZShgdW5rbm93biBmbGFnIGF0IHRoZSByb290OiAke2ZpcnN0fWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgIGNob2ljZXM6IFsuLi5JTlRFUkNFUFRPUl9DSE9JQ0VTXSxcbiAgICAgICAgICBoaW50OiBgY29tbWFuZHMgKGVhY2ggdGFrZXMgaXRzIG93biBmbGFncyk6ICR7dmVyYnMuam9pbihcIiBcIil9YCxcbiAgICAgICAgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjYW5kID0gZmlyc3Q7XG4gICAgICAgIHJlc3QgPSBhcmd2LnNsaWNlKDEpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpID0gc2NhblBvc2l0aW9uYWwoYXJndiwgZmFsc2UpO1xuICAgICAgaWYgKGkgPCAwKSB7XG4gICAgICAgIC8vIE5vIHZlcmIgYW55d2hlcmU6IGFuIHVua25vd24gZmxhZyBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQsXG4gICAgICAgIC8vIGFuZCBhIGNsZWFuIHBhcnNlIGlzIGEgYmFyZSBpbnZvY2F0aW9uLiBOZWl0aGVyIHJhbiBhIGNvbW1hbmQsIHNvXG4gICAgICAgIC8vIHRoZSBlbnZlbG9wZSdzIGBtZXRhLmNvbW1hbmRgIGlzIG51bGwsIG5vdCB0aGUgZmlyc3QgZmxhZydzXG4gICAgICAgIC8vIHNwZWxsaW5nIChgZ2xhbW91ciAtLWJvZ3VzYCBuYW1lcyBubyB2ZXJiKS5cbiAgICAgICAgc2V0Q3VycmVudENvbW1hbmQobnVsbCk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgcGFyc2VBcmdzKHsgYXJnczogYXJndiwgb3B0aW9uczogcGFyc2VPcHRpb25zLCBzdHJpY3Q6IHRydWUsIGFsbG93UG9zaXRpb25hbHM6IHRydWUgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICBkaWUoZXJyTWVzc2FnZShlKSwgXCJ1c2FnZVwiLCB7XG4gICAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgICBoaW50OiBgbm8gY29tbWFuZCBnaXZlbiDigJQgY29tbWFuZHM6ICR7dmVyYnMuam9pbihcIiBcIil9IChydW46ICR7Y2xpTmFtZX0gaGVscClgLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBub0NvbW1hbmQoKTtcbiAgICAgIH1cbiAgICAgIGNhbmQgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICAgIC8vIEEgdmVyYiBmb3VuZCByaWdodCBhZnRlciBhIGAtLWAgbGVhdmVzIHRoYXQgYC0tYCBpbiBwbGFjZSwgc28gdGhlXG4gICAgICAvLyByZXN0IG9mIHRoZSBhcmd2IHN0YXlzIHBvc2l0aW9uYWwuXG4gICAgICByZXN0ID0gd2l0aG91dChhcmd2LCBpKTtcbiAgICB9XG4gICAgc2V0Q3VycmVudENvbW1hbmQoY2FuZCk7XG4gICAgY29uc3QgciA9IHJlc29sdmUoY2FuZCwgcmVzdCk7XG4gICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgfTtcblxuICBjb25zdCBtYWluID0gYXN5bmMgKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIGF3YWl0IGRpc3BhdGNoKGFyZ3YpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnN0IHJlcG9ydGVkID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICAgIC8vIFRoZSBob3VzZSBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS4gQSBzcGVsbCB0aGF0XG4gICAgICAvLyB0cmlhZ2VzIGl0cyBvd24gKGdsYW1vdXIncyBFTk9FTlQg4oaSIHVzYWdlKSBjYWxscyBgZGlzcGF0Y2hgIGluc3RlYWQuXG4gICAgICByZXR1cm4gcmVwb3J0Q2xpRXJyb3IobmV3IENsaUVycm9yKFwiaW50ZXJuYWxcIiwgZXJyTWVzc2FnZShlKSkpID8/IDE7XG4gICAgfVxuICB9O1xuXG4gIGNvbnN0IHZpZXcgPSAocjogUm93KTogUm93VmlldyA9PiAoe1xuICAgIG5hbWU6IHIubmFtZSxcbiAgICBhbGlhc2VzOiByLmFsaWFzZXMsXG4gICAgZmxhZ3M6IHIuZmxhZ3MsXG4gICAgYWNjZXB0ZWQ6IHIuYWNjZXB0ZWQsXG4gICAgcG9zaXRpb25hbHM6IHIucG9zaXRpb25hbHMsXG4gICAgZGVzY3JpYmU6IHIuZGVzY3JpYmUsXG4gICAgYXV0bzogci5hdXRvLFxuICB9KTtcblxuICBPYmplY3QuYXNzaWduKGNsaSwge1xuICAgIG5hbWU6IGNsaU5hbWUsXG4gICAgbWFpbixcbiAgICBkaXNwYXRjaCxcbiAgICBkZWNsYXJhdGlvbixcbiAgICByZW5kZXJIZWxwLFxuICAgIHVzYWdlT2Y6IChwYXRoOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IHIgPSByb3dGb3IocGF0aCk7XG4gICAgICByZXR1cm4gciA9PT0gdW5kZWZpbmVkID8gXCJcIiA6IHVzYWdlTGluZShyKTtcbiAgICB9LFxuICAgIHZlcmJzLFxuICAgIHBhdGhzLFxuICAgIGZsYWdzRm9yLFxuICAgIHJlY29nbml6ZWRGbGFnczogb3B0aW9uS2V5cy5tYXAoKGspID0+IGAtLSR7a31gKSxcbiAgICByb3dzOiByb3dzLm1hcCh2aWV3KSxcbiAgfSBzYXRpc2ZpZXMgQ2xpKTtcbiAgcmV0dXJuIGNsaTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3MgYXJ0aWZhY3QuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRlcGVuZGVuY3ktZnJlZSBhbmQgZGVsaWJlcmF0ZWx5IGR1bGw6IGl0IGlzIGJ1bmRsZWQgSU5UTyBlYWNoXG4gKiBzcGVsbCdzIGVtaXR0ZWQgQ0xJIChDb250cmFjdCA0J3MgYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLCBzbyBhbnl0aGluZyBpdFxuICogcmVhY2hlZCBmb3Igd291bGQgYmVjb21lIGEgZGVwZW5kZW5jeSBvZiB0d28gc2hpcHBlZCBhcnRpZmFjdHMgYXQgb25jZS5cbiAqXG4gKiBUaGUgd2lyZSBjb250cmFjdCBpdCBlbmNvZGVzOiBleGFjdGx5IG9uZSBKU09OIGRvY3VtZW50LCBvbmUgdHJhaWxpbmdcbiAqIG5ld2xpbmUsIG5vdGhpbmcgZWxzZSBvbiBzdGRvdXQuIEEgY2FsbGVyIHJlYWRpbmcgb3VyIHN0ZG91dCB3aXRoIGFcbiAqIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBkZXBlbmRzIG9uIHRoYXQgbmV3bGluZTsgYSBjYWxsZXIgcmVhZGluZyB0byBFT0ZcbiAqIGRlcGVuZHMgb24gdGhlcmUgYmVpbmcgbm8gc2Vjb25kIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pOiB2b2lkIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIENMSSBmYWlsdXJlIGNvbnRyYWN0IOKAlCB0aGUgdGF4b25vbXksIHRoZSBleGl0IGNvZGVzLCB0aGVcbiAqIGVudmVsb3BlLCBhbmQgdGhlIGBkaWVgIHRoYXQgcmFpc2VzIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZVxuICogaW50byBhbnkgc3BlbGwncyBidW5kbGUgKHNlZSBgLi4vbGliL3ByaW50SnNvbi50c2AsIHRoZSBraXQncyBmaXJzdFxuICogaW5oYWJpdGFudCwgZm9yIHRoZSBmdWxsIGFjY291bnQpLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBJUyBBIENPTlRSQUNUIEFORCBOT1QgQSBVVElMSVRZIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIGBraW5kYCBpcyB0aGUgY29udHJhY3Q7IGBtZXNzYWdlYCBpcyBwcmVzZW50YXRpb24uIFJld29yZGluZyBhIG1lc3NhZ2UgbXVzdFxuICogbmV2ZXIgYnJlYWsgYSBjYWxsZXIsIHdoaWNoIGl0IGRvZXMgdGhlIG1vbWVudCBhbnlvbmUgbWF0Y2hlcyBvbiBwcm9zZS4gQW5cbiAqIGFnZW50IHJvdXRlcyBvbiBga2luZGAgYW5kIG9uIHRoZSBleGl0IGNvZGUsIHNvIGNoYW5naW5nIGVpdGhlciBpcyBhIGNoYW5nZVxuICogYW4gYWdlbnQgT0JTRVJWRVMgYW5kIHRoZSBzcGVsbCBuZWVkcyBhbiBhY2MgcmUtZ3JhZGUuIFRoYXQgaXMgdGhlIGN1dCB0aGlzXG4gKiBkaXJlY3RvcnkgaXMgbmFtZWQgZm9yLlxuICpcbiAqIOKUgOKUgCDim5QgYGRpZWAgVEhST1dTLiBJVCBET0VTIE5PVCBFWElULCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzb1xuICogYHByb2Nlc3MuZXhpdCgpYCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAqIDY1LDUzNiBieXRlcywgYW5kIHRoZSBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wc1xuICogbWlkLXN0cmluZy4gUmVwcm9kdWNlZCwgcmVwYWlyZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpLlxuICpcbiAqIFRoZSBvbGQgc2hhcGUgd3JvdGUgb25lIHNob3J0IGVudmVsb3BlIHRvIHN0ZGVyciBhbmQgZXhpdGVkIGltbWVkaWF0ZWx5LFxuICogd2hpY2ggaXMgc2FmZSBPTkxZIHdoaWxlIHRoZSBwYXlsb2FkIGZpdHMgdGhlIDY0IEtpQiBwaXBlIGJ1ZmZlciDigJQgc3RkZXJyXG4gKiBpcyBjdXQgc2hvcnQgZXhhY3RseSBsaWtlIHN0ZG91dCAobWVhc3VyZWQpLiBJdCBhbHNvIG1lYW50IGV2ZXJ5IGBkaWVgIHdhcyBhXG4gKiBzZWNvbmQgcGxhY2UgdGhlIHByb2Nlc3MgY291bGQgZW5kLCBvcGFxdWUgdG8gd2hhdGV2ZXIgdGhlIHZlcmIgaGFkXG4gKiBhbHJlYWR5IHdyaXR0ZW4gdG8gc3Rkb3V0LlxuICpcbiAqIFNvOiBgZGllYCByYWlzZXMgYSBgQ2xpRXJyb3JgLCB0aGUgc3BlbGwncyBgbWFpbmAgY2F0Y2hlcyBpdCB3aXRoXG4gKiBgcmVwb3J0Q2xpRXJyb3JgLCBhbmQgdGhlIHByb2Nlc3MgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zIOKAlFxuICogYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYSBuYXR1cmFsIHJldHVybi4gZ2xhbW91ciBhbmQgbWluZC1tYXBwZXIgcmVhY2hlZFxuICogdGhpcyBzaGFwZSBpbmRlcGVuZGVudGx5IGF0IHRoZWlyIGFjYyBMMCBwYXNzZXM7IHRoaXMgbW9kdWxlIGlzIHdoZXJlIHRoZVxuICogdGhyZWUgY29waWVzIHN0b3AgYmVpbmcgdGhyZWUuXG4gKlxuICog4pqgIEEgYGRpZWAgUkVBQ0hBQkxFIGZyb20gaW5zaWRlIGEgYHRyeWAgd2hvc2UgYGNhdGNoYCBTV0FMTE9XUyBpcyBub3cgYVxuICogc2lsZW50IGNvbnRpbnVlIHJhdGhlciB0aGFuIGFuIGV4aXQuIOKblCBSRUFDSEFCSUxJVFksIE5PVCBDQUxMIFNJVEVTOiBhXG4gKiBIRUxQRVIgdGhhdCBkaWVzLCBpbnZva2VkIGZyb20gaW5zaWRlIGEgc3dhbGxvd2luZyBgY2F0Y2hgLCBoYXMgaXRzIGBkaWVgIGF0XG4gKiBhIHNpdGUgdGhhdCByZWFkcyBhcyBwZXJmZWN0bHkgc2FmZS4gQW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBmb2xsb3cgdGhlIGNhbGxcbiAqIGdyYXBoLCBub3QgZ3JlcCBmb3IgYGRpZShgLiBBdWRpdGVkIHRoYXQgd2F5IG9uIGFkb3B0aW9uIOKAlCAxNSBzaXRlcyBpblxuICogYXN0cm9sYWJlLCAyOSBpbiBtYWdwaWUsIHBsdXMgdGhlIGhlbHBlcnMgcmVhY2hhYmxlIGZyb20gdGhlbSDigJQgYW5kIGV2ZXJ5XG4gKiBwYXRoIGlzIGVpdGhlciBvdXRzaWRlIGEgYHRyeWAgb3IgaW5zaWRlIGEgYGNhdGNoYCwgZnJvbSB3aGljaCB0aGUgdGhyb3dcbiAqIHByb3BhZ2F0ZXMuXG4gKi9cblxuLyoqXG4gKiBUaGUgZmFpbHVyZSB0YXhvbm9teS4gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyBzdGFuZGFyZDogYSB1c2FnZSBlcnJvciBpc1xuICogdGhlIGNhbGxlcidzIHRvIGZpeCBieSBjaGFuZ2luZyB0aGUgY29tbWFuZCwgYW4gaW50ZXJuYWwgZmF1bHQgaXMgbm90LCBhbmRcbiAqIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZSBudW1iZXIgbGVhdmVzIGFuIGFnZW50IHdpdGggbm90aGluZyB0byByb3V0ZSBvbi5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyS2luZCA9IFwidXNhZ2VcIiB8IFwiaW50ZXJuYWxcIiB8IFwibm90X2ZvdW5kXCIgfCBcImNvbmZsaWN0XCI7XG5cbmV4cG9ydCBjb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gdGhlIHNwZWxsIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLyoqXG4gKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogYGNob2ljZXNgIGVudW1lcmF0ZXMgd2hhdCBXT1VMRCBoYXZlIGJlZW4gYWNjZXB0ZWQuXG4gKlxuICog4pqgICoqYHNlcnZlcmAgQVJSSVZFRCBJTiBQSEFTRSAyLCBBTkQgSVQgSVMgQSBGSU5ESU5HIEFCT1VUIFRISVMgTU9EVUxFLioqIFRoZVxuICogY29udHJhY3Qgd2FzIGV4dHJhY3RlZCBmcm9tIGFzdHJvbGFiZSBhbmQgbWFncGllLCBhbmQgQk9USCBvZiB0aGVtIGZyb250IGFcbiAqIGRhZW1vbiBhbmQgQk9USCBvZiB0aGVtIHRocm93IGF3YXkgd2hhdCB0aGUgZGFlbW9uIHNhaWQ6IG1hZ3BpZSdzXG4gKiBgZGllKFwic3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlcIiwgXCJpbnRlcm5hbFwiKWAga2VlcHMgdGhlIG51bWJlciBhbmQgZHJvcHNcbiAqIHRoZSBib2R5LiBnbGFtb3VyIGRvZXMgbm90IOKAlCBpdHMgcmVmdXNhbHMgY2FycnkgdGhlIGRhZW1vbidzIG93biBKU09OIHZlcmJhdGltXG4gKiB1bmRlciBgZXJyb3Iuc2VydmVyYCwgc28gYSBjYWxsZXIgY2FuIGJyYW5jaCBvbiB0aGUgdXBzdHJlYW0ncyByZWFzb24gaW5zdGVhZFxuICogb2Ygb24gdGhlIENMSSdzIHByb3NlIGFib3V0IGl0LCBhbmQgYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCBhc3NlcnRzIGl0IGZvclxuICogNDAwLCA0MDQgYW5kIDQwOS4gU2V2ZW4gb2YgdGhlIGVpZ2h0IHNwZWxscyBwdXQgYSBDTEkgaW4gZnJvbnQgb2YgYSBkYWVtb24sIHNvXG4gKiB0aGlzIGlzIHRoZSBnZW5lcmFsIHNoYXBlIGFuZCB0aGUgdHdvLXNwZWxsIGJvdW5kYXJ5IHdhcyB0aGUgbmFycm93IG9uZS5cbiAqXG4gKiDim5QgSVQgSVMgVEhFIFVQU1RSRUFNJ1MgQk9EWSwgVkVSQkFUSU0sIEFORCBOT1RISU5HIEVMU0UuIE5vdCBhIHBsYWNlIHRvIHN0YXNoXG4gKiBhcmJpdHJhcnkgY29udGV4dDogdGhlIHdob2xlIHZhbHVlIG9mIHRoZSBmaWVsZCBpcyB0aGF0IGEgY2FsbGVyIGNhbiB0cnVzdCBpdFxuICogaXMgd2hhdCB0aGUgb3RoZXIgc2lkZSBhY3R1YWxseSBzYWlkLlxuICovXG5leHBvcnQgdHlwZSBFcnJFeHRyYSA9IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdOyBzZXJ2ZXI/OiB1bmtub3duIH07XG5cbi8qKiBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIGFuIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBgbWFpbmAuICovXG5sZXQgY3VycmVudENvbW1hbmQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0Q3VycmVudENvbW1hbmQoY29tbWFuZDogc3RyaW5nIHwgbnVsbCk6IHZvaWQge1xuICBjdXJyZW50Q29tbWFuZCA9IGNvbW1hbmQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRDdXJyZW50Q29tbWFuZCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgcmV0dXJuIGN1cnJlbnRDb21tYW5kO1xufVxuXG4vKipcbiAqIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSDigJQgc3Rkb3V0IGNhcnJpZXMgZGF0YVxuICogYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYSB2ZXJiIGFuZFxuICogcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCwgYW5kIHRoZVxuICogZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgdGhlIGhvdXNlIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgIC8vIExhc3QsIHNvIGEgc3BlbGwgdGhhdCBhbHJlYWR5IGVtaXR0ZWQgdGhpcyBrZXkga2VlcHMgaXRzIGJ5dGUgb3JkZXIuXG4gICAgICAuLi4oZXh0cmE/LnNlcnZlciAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGV4dHJhLnNlcnZlciB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2l0ZW1zL3RhaWwtcmVhZGVyLWNvbnZlcmdlbmNlL3dyaXRlLXVwLm1kYCkgYW5kXG4gKiBhZG9wdGVkIGZpcnN0IGJ5IGFzdHJvbGFiZSBhbmQgbWFncGllLlxuICpcbiAqIOKUgOKUgCBUSEUgVFdPIERFQ0lTSU9OUyBUSEFUIE1BS0UgT05FIENMSUVOVCBQT1NTSUJMRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiAqKjEuIFwiV2hlcmUgaXMgdGhlIGRhZW1vblwiIGlzIGEgQ0FMTEJBQ0ssIG5vdCBhIFVSTC4qKiBgcmVzb2x2ZWAgaXMgY2FsbGVkXG4gKiBiZWZvcmUgRVZFUlkgY29ubmVjdCBhdHRlbXB0IGFuZCBpdHMgYW5zd2VyIGlzIG5ldmVyIGNhcHR1cmVkLiBUaGF0IHNpbmdsZVxuICogY2hhbmdlIHVuaWZpZXMgZm91ciBpbmNvbXBhdGlibGUgZGlzY292ZXJ5IG1vZGVscyDigJQgc2Vzc2lvbi1wb2ludGVyIHJlLXJlYWQsXG4gKiBwaWQtY2hlY2tlZCBwb3J0IGZpbGUsIHJlc3Bhd24taWYtYWJzZW50IOKAlCBhbmQgaXQgcmVwYWlycyBhIGRlZmVjdCBieVxuICogY29uc3RydWN0aW9uIHJhdGhlciB0aGFuIGJ5IGFueW9uZSBmaXhpbmcgaXQ6IGFzdHJvbGFiZSByZXNvbHZlZCBpdHMgZGFlbW9uXG4gKiBiYXNlIE9OQ0UgYW5kIHJlY29ubmVjdGVkIHRvIHRoYXQgb25lIGNhcHR1cmVkIHBvcnQgZm9yZXZlciwgc28gYGpvaW5gIOKAlCB0aGUgdmVyYlxuICogZGVzaWduZWQgdG8gcnVuIGZvciBob3VycyBjYXJyeWluZyBwcmVzZW5jZSDigJQgc3B1biBzaWxlbnRseSBhZ2FpbnN0IGEgZGVhZFxuICogcG9ydCBhZnRlciBhbnkgZGFlbW9uIHJlc3RhcnQsIGFuZCBhc3Ryb2xhYmUgYmluZHMgYW4gZXBoZW1lcmFsIHBvcnQuXG4gKlxuICogKioyLiBUaGlzIGNsaWVudCBORVZFUiBjYWxscyBgcHJvY2Vzcy5leGl0YC4gSXQgUkVUVVJOUyBhbiBleGl0IGNvZGUuKiogU2VlXG4gKiB0aGUgc2NhciBiZWxvdzsgdGhhdCBpcyB0aGUgd2hvbGUgb2YgaXQuXG4gKlxuICog4pSA4pSAIOKblCBUSEUgU0NBUjogUDBmLCBTSEFQRSBCIOKAlCBSRS1IT01FRCBIRVJFLCBXUklUVEVOIE9OQ0Ug4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogRml2ZSBzcGVsbHMgZWFjaCBjYXJyaWVkIGEgY29weSBvZiB0aGlzIHBhcmFncmFwaCwgYmVjYXVzZSBmaXZlIHNpdGVzIGVhY2hcbiAqIGhhZCB0byBwcm92ZSBMT0NBTExZIHRoYXQgZW5kaW5nIGEgdGFpbCBkb2VzIG5vdCBjdXQgaXRzIG93biBsYXN0IGxpbmUgc2hvcnQuXG4gKiBJdCBkb2N1bWVudHMgYSAyMy1taW51dGUgaGFuZyB0aGF0IHNoaXBwZWQuIFRoZSByZWFzb25pbmcgbm93IGxpdmVzIGluIG9uZVxuICogcGxhY2U7IHRoZSBjb3BpZXMgYXJlIGdvbmUsIGFuZCB0aGlzIGlzIHdoYXQgdGhleSBzYWlkLlxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBhIGZpbGUpLiBBblxuICogZXhwbGljaXQgYHByb2Nlc3MuZXhpdCgpYCB0aGVyZWZvcmUgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlFxuICogbWVhc3VyZWQgYXQgZXhhY3RseSA2NSw1MzYgYnl0ZXMsIG9uZSBwaXBlIGJ1ZmZlci4gVGhlIHBheWxvYWQgaXMgY29tcGxldGVcbiAqIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyBhIGNhbGxlciByZWNlaXZlcyB3ZWxsLWZvcm1lZC1MT09LSU5HIEpTT05cbiAqIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gTWVhc3VyZWQsIEJ1biAxLjMuMTQsIDMwMEtCIHdyaXRlczpcbiAqXG4gKiAgICAgd3JpdGUoYmlnLCBjYiAtPiBleGl0KSAgICAgICAgICAgICAgICAgICAg4pyFIDMwMDAwMSBieXRlcyBhcnJpdmVcbiAqICAgICBhd2FpdCBCdW4ud3JpdGUoQnVuLnN0ZG91dCwgYmlnKSAgICAgICAgICDinIVcbiAqICAgICBuYXR1cmFsIHJldHVybiwgcHJvY2Vzcy5leGl0Q29kZSAgICAgICAgICDinIVcbiAqICAgICB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgICAgIOKdjCA2NTUzNlxuICogICAgIDV4IHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAg4p2MIGV4YWN0bHkgNXg2NTUzNlxuICpcbiAqIOKblCBUaGUgbGFzdCB0d28gcm93cyBhcmUgd2h5IGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAgaXMgTk9UIGEgYmFycmllcjogYVxuICogZHJhaW4gY2FsbGJhY2sgY292ZXJzIE9OTFkgSVRTIE9XTiBXUklURS4gVGhhdCBpcyBleGFjdGx5IHRoZSBoZWxwZXIgYVxuICogd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMsIGFuZCBpdCBtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBub1xuICogZml4IGF0IGFsbC4gRG8gbm90IHJlaW50cm9kdWNlIGl0LlxuICpcbiAqIFRoZSBmaXZlIGNvcGllcyB0aGVuIGVhY2ggaGFkIHRvIGVzdGFibGlzaCBhIFBFUi1TSVRFIFBSRUNPTkRJVElPTiDigJQgd2hldGhlclxuICogYSBgcmV0dXJuYCBlc2NhcGVzIHRoZSB0aHJlZSBuZXN0ZWQgbG9vcHMgKG91dGVyIHJlY29ubmVjdCwgaW5uZXIgcmVhZCwgZnJhbWVcbiAqIGRyYWluKSBvciBtZXJlbHkgZmFsbHMgdGhyb3VnaCBpbnRvIGFub3RoZXIgcmV0cnkuIFRoZXkgZGlkIG5vdCBhZ3JlZTogdHdvXG4gKiBuZWVkZWQgYW4gZXhwbGljaXQgYHJldHVybmAsIG9uZSBuZWVkZWQgYSBgc3RvcHBlZGAgZmxhZyBhcyB3ZWxsLCBhbmRcbiAqIGFzdHJvbGFiZSdzIHNpdGUgY291bGQgYHJldHVybmAgb25seSBiZWNhdXNlIGl0cyBjYWxsZXIgcmV0dXJuZWQgc3RyYWlnaHRcbiAqIGFmdGVyLiDirZAgKipSRVRVUk5JTkcgQU4gRVhJVCBDT0RFIFJFVElSRVMgVEhBVCBRVUVTVElPTiBFTlRJUkVMWS4qKiBUaGVyZSBpc1xuICogb25lIGxvb3Agbm93OyBpdCBicmVha3MgdG8gb25lIHBsYWNlOyB0aGUgY2FsbGVyIGFzc2lnbnMgYHByb2Nlc3MuZXhpdENvZGVgXG4gKiBhbmQgcmV0dXJucyBuYXR1cmFsbHksIGFuZCB0aGUgcnVudGltZSBkcmFpbnMgc3Rkb3V0IGJlZm9yZSB0aGUgcHJvY2VzcyBlbmRzLlxuICogTm90aGluZyBoZXJlIG5lZWRzIHRvIGtub3cgd2hhdCBpdHMgY2FsbGVyIGRvZXMgbmV4dC5cbiAqXG4gKiBUaGF0IGFsc28gcmVwYWlycyBhIGRlZmVjdCB0aGUgY29waWVzIHNoYXJlZDogdGhlIGRyYWluIGZpeCB3YXMgYXBwbGllZCB0b1xuICogdGhlIHRlcm1pbmFsIGZyYW1lIGJ1dCBOT1QgdG8gdGhlIHNpZ25hbCBoYW5kbGVyIHR3ZWx2ZSBsaW5lcyBhYm92ZSBpdCwgc29cbiAqIEN0cmwtQyBvbiBhIHRhaWwgcGlwZWQgaW50byBhIHJlYWRlciBkaXNjYXJkZWQgdW5kcmFpbmVkIHN0ZG91dC4gU2FtZSBsb29wLFxuICogc2FtZSBleGl0IHBhdGgsIG9uZSBhbnN3ZXIuXG4gKlxuICog4pqgIE5PVCByZS1ob21lZCBJTlRPIFRISVMgTU9EVUxFLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuXG4gKiAxLjMuMTQgZmluZGluZyB0aGF0IGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy5cbiAqIEl0IGlzIGEgREFFTU9OLXNpZGUgZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uXG4gKiBgc3NlUmVzcG9uc2VgLCBub3Qgb24gYW55IGNsaWVudC5cbiAqXG4gKiDim5QgQU5EIElUIERJRCBHRVQgQSBIT01FIOKAlCBTQVkgU08sIEJFQ0FVU0UgVEhJUyBTRU5URU5DRSBVU0VEIFRPIEVORCBcIml0IHN0YXlzXG4gKiB3aGVyZSBpdCB3YXMgbWVhc3VyZWRcIiBBTkQgVEhBVCBJUyBGQUxTRS4gUmVhZCBhdCBwb3J0IHRpbWUgaXQgcG9pbnRlZCBhXG4gKiByZWFkZXIgYXQgYG1pbmQtbWFwcGVyL3NjcmlwdHMvc2VydmVyLnRzYCwgYSBmaWxlIHdob3NlIGxvY2FsIGBzc2VSZXNwb25zZWBcbiAqIHRoZSBiYWNrZW5kIHBvcnQgbWlnaHQgcmVwbGFjZSwgc28gdGhlIG1lYXN1cmVtZW50IGxvb2tlZCBhdCByaXNrLiBJdCB3YXNcbiAqIG5vdDogdGhlIGRhZW1vbiBoYWxmIGxhbmRlZCBpbiBgLi9zc2UudHNgIHRoZSBzYW1lIGRheSwgdW5kZXIgaXRzIG93biBoZWFkaW5nXG4gKiAoXCJUSEUgU0NBUiwgUkUtSE9NRUQ6IGB0cnkgeyBlbnF1ZXVlIH0gY2F0Y2hgIERPRVMgTk9UIERFVEVDVCBBIERFQURcbiAqIENMSUVOVFwiKSwgd2l0aCB0aGUgdGVhcmRvd24tZnVubmVsIHJ1bGluZyBhbmQgdGhlIHNhbWUga25vd24gaG9sZS5cbiAqXG4gKiDimqAgKipBTkQgVEhFIFBPUlQgSEFTIFNJTkNFIEhBUFBFTkVELCBXSElDSCBTRVRUTEVTIElULioqIG1pbmQtbWFwcGVyJ3MgZGFlbW9uXG4gKiBpcyBub3cgYHNyYy9taW5kLW1hcHBlci9iYWNrZW5kL3NlcnZlci50c2AgYW5kIGl0IERJRCByZXBsYWNlIGl0cyBsb2NhbFxuICogYHNzZVJlc3BvbnNlYCB3aXRoIGAuL3NzZS50c2AncyAoUGhhc2UgNywgMjAyNi0wOS0wOSkg4oCUIHNvIHRoZSBvbmx5IGNvcGllcyBvZlxuICogdGhhdCBtZWFzdXJlbWVudCBhcmUgdGhlIGtpdCdzIGFuZCB0aGUgdHdvIHRlc3QgZmlsZXMgdGhhdCBQUk9WRSBpdCxcbiAqIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9wcmVzZW5jZS50ZXN0LnRzYCBhbmQgYHNzZS1rZWVwYWxpdmUudGVzdC50c2AuIFRoZVxuICogcmlzayB0aGlzIHBhcmFncmFwaCBkZXNjcmliZWQgaXMgY2xvc2VkLCBpbiB0aGUgZGlyZWN0aW9uIGl0IGhvcGVkIGZvci5cbiAqXG4gKiBUaGUgZ2VuZXJhbCBzaGFwZSwgd29ydGggdGhlIGZvdXIgbGluZXMgKEQ4Myk6IGEgcmVmdXNhbCByZWNvcmRlZCBpbiBPTkVcbiAqIG1vZHVsZSdzIGhlYWRlciBjYW5ub3QgYmUgcmVhZCBmcm9tIHRoZSBtb2R1bGUgaXQgcG9pbnRzIEFULiBXaGVuIGEgcmVmdXNhbFxuICogbmFtZXMgYW5vdGhlciBtb2R1bGUgYXMgdGhlIHJpZ2h0IGhvbWUsIHNheSB3aGV0aGVyIGl0IGdvdCB0aGVyZS5cbiAqXG4gKiDilIDilIAgVEhFIFdJUkUgRk9STUFULCBBTkQgVEhFIGBcImRhdGE6IFwiYCBRVUVTVElPTiBSRVNPTFZFRCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBQZXIgV0hBVFdHIEhUTUwsIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBlYWNoIGxpbmUgYXQgdGhlIEZJUlNUXG4gKiBjb2xvbjsgaWYgdGhlIHZhbHVlIGJlZ2lucyB3aXRoIEVYQUNUTFkgT05FIHNwYWNlLCByZW1vdmUgdGhhdCBvbmUgc3BhY2U7XG4gKiBhcHBlbmQgZWFjaCBkYXRhIHZhbHVlIHBsdXMgYSBuZXdsaW5lLCB0aGVuIHN0cmlwIHRoZSBmaW5hbCBuZXdsaW5lLlxuICpcbiAqIFRoZSBob3VzZSdzIHNldmVuIHRhaWxzIHNwbGl0IGludG8gdHdvIG5vbi1jb25mb3JtYW50IGNhbXBzLCBhbmQgbmVpdGhlciBpc1xuICogY3VycmVudGx5IHdyb25nIGluIHByb2R1Y3Rpb24sIGJlY2F1c2UgZXZlcnkgaG91c2UgZGFlbW9uIGVtaXRzIG9uZSBkYXRhIGxpbmVcbiAqIHBlciBmcmFtZSBXSVRIIHRoZSBzcGFjZTpcbiAqXG4gKiAgIOKAoiBgc3RhcnRzV2l0aChcImRhdGE6IFwiKWAg4oCUIHRoZSBtb3JlIGRhbmdlcm91cyBlcnJvci4gQSBzcGVjLWxlZ2FsXG4gKiAgICAgYGRhdGE6ey4uLn1gIG1hdGNoZXMgbm90aGluZywgc28gdGhlIGZyYW1lIGlzIHNpbGVudGx5IGRyb3BwZWQgQU5EIFRIRVxuICogICAgIENVUlNPUiBET0VTIE5PVCBBRFZBTkNFLiBJdCBhbHNvIGtlZXBzIG9ubHkgdGhlIGZpcnN0IGRhdGEgbGluZS5cbiAqICAg4oCiIGAuc2xpY2UoNSkudHJpbSgpYCDigJQgdGhlIG1vcmUgZm9yZ2l2aW5nIGVycm9yLiBJdCBhY2NlcHRzIGJvdGggZm9ybXMgYnV0XG4gKiAgICAgc3RyaXBzIEFMTCB3aGl0ZXNwYWNlIHJhdGhlciB0aGFuIG9uZSBsZWFkaW5nIHNwYWNlLCB3aGljaCB3b3VsZCBjb3JydXB0XG4gKiAgICAgYSBwYXlsb2FkIHdpdGggbWVhbmluZ2Z1bCBpbmRlbnRhdGlvbi5cbiAqXG4gKiBUaGlzIGNsaWVudCBkb2VzIG5laXRoZXIuIFNwZWMtY29ycmVjdCBpcyBzaW11bHRhbmVvdXNseSBieXRlLWNvbXBhdGlibGUgd2l0aFxuICogYWxsIHNldmVuIGRhZW1vbnMg4oCUIHRoZSByYXJlIGNhc2Ugd2hlcmUgdGhlIHJpZ2h0IGFuc3dlciBjb3N0cyBub3RoaW5nLlxuICpcbiAqIGBpZDpgIC8gTGFzdC1FdmVudC1JRCAvIGByZXRyeTpgIGFyZSBOT1QgaW1wbGVtZW50ZWQsIGFuZCB0aGF0IGlzIGEgc3RhdGVkXG4gKiBob3VzZSBjaG9pY2UgcmF0aGVyIHRoYW4gYW4gb21pc3Npb246IHJlc3VtZSBpcyBhIHF1ZXJ5LXBhcmFtIGN1cnNvciwgc28gdGhlXG4gKiBzZXJ2ZXIncyByZXBsYXkgd2luZG93IGFuZCB0aGUgY2xpZW50J3MgYHNpbmNlYCBhcmUgdGhlIG9uZSBtZWNoYW5pc20uXG4gKi9cblxuLyoqIE9uZSBwYXJzZWQgU1NFIGZyYW1lLiBgZXZlbnRgIGRlZmF1bHRzIHRvIFwibWVzc2FnZVwiIHBlciB0aGUgc3BlYy4gKi9cbmV4cG9ydCB0eXBlIFNzZUZyYW1lID0ge1xuICBldmVudDogc3RyaW5nO1xuICAvKiogVGhlIGFjY3VtdWxhdGVkIGBkYXRhYCB2YWx1ZTogZmllbGRzIGpvaW5lZCB3aXRoIFwiXFxuXCIsIGZpbmFsIG5ld2xpbmUgc3RyaXBwZWQuICovXG4gIGRhdGE6IHN0cmluZztcbn07XG5cbi8qKiBBIHdyaXRhYmxlIHNpbmsuIE5hcnJvdyBvbiBwdXJwb3NlIOKAlCBgcHJvY2Vzcy5zdGRvdXRgIGFuZCBhIHRlc3QgZG91YmxlXG4gKiAgYm90aCBzYXRpc2Z5IGl0LCBhbmQgdGhlIGtpdCBtYXkgbm90IG5hbWUgYSBub2RlIHR5cGUgaXQgZG9lcyBub3QgaW1wb3J0LiAqL1xuZXhwb3J0IHR5cGUgU2luayA9IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfTtcblxuZXhwb3J0IHR5cGUgVGFpbE9wdGlvbnM8RXY+ID0ge1xuICAvLyDilIDilIAgV0hFUkUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgZGFlbW9uJ3MgYmFzZSBVUkwgKG5vIHRyYWlsaW5nIHNsYXNoKSwgb3IgYG51bGxgIHdoZW4gaXQgY2Fubm90IGJlXG4gICAqIGZvdW5kIHJpZ2h0IG5vdy4g4puUIENBTExFRCBCRUZPUkUgRVZFUlkgQ09OTkVDVCBBVFRFTVBUIEFORCBORVZFUiBDQVBUVVJFRFxuICAgKiDigJQgYSB0YWlsIG91dGxpdmVzIHRoZSBkYWVtb24gaXQgc3RhcnRlZCBhZ2FpbnN0LCBhbmQgYSBjYXB0dXJlZCBiYXNlIGlzXG4gICAqIHRoZSBkZWZlY3QgdGhpcyBwYXJhbWV0ZXIgZXhpc3RzIHRvIG1ha2UgdW5yZWFjaGFibGUuIEl0IG1heSByZS1yZWFkIGFcbiAgICogcG9pbnRlciBmaWxlLCBwcm9iZSBsaXZlbmVzcywgb3Igc3Bhd247IGl0IG1heSB0aHJvdywgYW5kIHRoZSB0aHJvdyBpcyB0aGVcbiAgICogY2FsbGVyJ3MgdG8gYW5zd2VyICh3aGljaCBpcyBzdHJpY3RseSBiZXR0ZXIgdGhhbiBhIGBkaWVgIHJlYWNoYWJsZSBmcm9tXG4gICAqIGluc2lkZSBhIHJlY29ubmVjdCBsb29wKS5cbiAgICovXG4gIHJlc29sdmU6ICgpID0+IHN0cmluZyB8IG51bGwgfCBQcm9taXNlPHN0cmluZyB8IG51bGw+O1xuICAvKipcbiAgICogV2hhdCB0byBkbyB3aGVuIGByZXNvbHZlYCBzYXlzIFwibm90IGZvdW5kXCIuIERlZmF1bHQgYFwicmV0cnlcImAgZm9yZXZlci5cbiAgICogYFwic3RvcFwiYCBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwIOKAlCB0aGUgc2hhcGUgYSBzcGVsbCB3YW50cyB3aGVuIHRoZVxuICAgKiBzZXNzaW9uIGl0IFBJTk5FRCBoYXMgZ29uZSBhd2F5LCB3aGljaCBpcyBhIGNvbXBsZXRlZCB3YXRjaCBhbmQgbm90IGFcbiAgICogZmFpbHVyZS4gVGhlIGZsYWdzIGRpc3Rpbmd1aXNoIFwibmV2ZXIgZm91bmQgb25lXCIgZnJvbSBcImhhZCBvbmUsIGxvc3QgaXRcIi5cbiAgICovXG4gIG9uVW5yZXNvbHZlZD86IChzOiB7IGV2ZXJSZXNvbHZlZDogYm9vbGVhbjsgZXZlckNvbm5lY3RlZDogYm9vbGVhbiB9KSA9PiBcInJldHJ5XCIgfCBcInN0b3BcIjtcblxuICAvLyDilIDilIAgV0hBVCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFBhdGggb24gdGhlIGRhZW1vbiwgZS5nLiBgXCIvZXZlbnRzXCJgLiBKb2luZWQgdG8gYHJlc29sdmVgJ3MgYW5zd2VyLiAqL1xuICBwYXRoOiBzdHJpbmc7XG4gIC8qKiBUaGUgc3RhcnRpbmcgY3Vyc29yLiBTZW50IGFzIGBzaW5jZWAgdW5sZXNzIGBxdWVyeWAgc2F5cyBvdGhlcndpc2UuICovXG4gIHNpbmNlOiBudW1iZXI7XG4gIC8qKiBSZWFkIHRoZSBjdXJzb3Igb2ZmIGFuIGV2ZW50IChgZXYuaWRgLCBgZXYuc2VxYCwgYHBheWxvYWQuaWRgLCDigKYpLiAqL1xuICBjdXJzb3JPZj86IChldjogRXYpID0+IG51bWJlciB8IHVuZGVmaW5lZDtcbiAgLyoqXG4gICAqIGBcIm1vbm90b25pY1wiYCAoZGVmYXVsdCkgdGFrZXMgdGhlIG1heCwgc28gYSByZXBsYXllZCBvciBvdXQtb2Ytb3JkZXIgZnJhbWVcbiAgICogY2Fubm90IHJlZ3Jlc3MgdGhlIGN1cnNvciBhbmQgbWFrZSB0aGUgbmV4dCByZWNvbm5lY3QgcmUtcmVxdWVzdCBldmVudHNcbiAgICogYWxyZWFkeSBzZWVuLiBgXCJhc3NpZ25cImAgdGFrZXMgdGhlIHZhbHVlIGFzIGdpdmVuIOKAlCBhdmFpbGFibGUgYmVjYXVzZSBvbmVcbiAgICogc3BlbGwgZG9lcyB0aGF0IHRvZGF5IGFuZCBub2JvZHkgaGFzIHJ1bGVkIHdoZXRoZXIgaXQgd2FzIGludGVuZGVkLlxuICAgKi9cbiAgY3Vyc29yUG9saWN5PzogXCJtb25vdG9uaWNcIiB8IFwiYXNzaWduXCI7XG4gIC8qKiBQZXItYXR0ZW1wdCBxdWVyeSBwYXJhbWV0ZXJzLiBEZWZhdWx0IGB7IHNpbmNlOiBTdHJpbmcoY3Vyc29yKSB9YC5cbiAgICogIGBmaXJzdENvbm5lY3RgIGlzIHdoYXQgbGV0cyBhIGAtLWxhc3QgTmAgd2luZG93IHJpZGUgdGhlIGZpcnN0IGNvbm5lY3Rpb25cbiAgICogIG9ubHksIG5ldmVyIHJlLWJhY2tmaWxsaW5nIG9uIGEgcmVjb25uZWN0LiAqL1xuICBxdWVyeT86IChjdXJzb3I6IG51bWJlciwgZmlyc3RDb25uZWN0OiBib29sZWFuKSA9PiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuXG4gIC8vIOKUgOKUgCBFUE9DSCAob3B0LWluOyByZXF1aXJlcyBhIGRhZW1vbiB0aGF0IHN0YW1wcyBvbmUpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUmVhZCB0aGUgZGFlbW9uJ3MgZXBvY2ggb2ZmIGFuIGV2ZW50LiAqL1xuICBlcG9jaE9mPzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogQSByZWNvbm5lY3QgbGFuZGVkIG9uIGEgRElGRkVSRU5UIGVwb2NoOiB0aGUgZGFlbW9uIHJlc3RhcnRlZCwgc28gdGhlXG4gICAqICBjdXJzb3IgcmVzZXRzIHRvIDAuIFJldHVybiBhIGxpbmUgdG8gZW1pdCAoYSBzeW50aGVzaXplZCBub3RpY2UsIG5ldmVyIGFcbiAgICogIGJ1cyBldmVudCkgb3IgbnVsbC5cbiAgICpcbiAgICogIOKblCBBTkQgV0hFTiBUSEUgTkVXIExPRyBXQVMgQUxSRUFEWSBQQVNUIFRIRSBCT09LTUFSSywgVEhFIENMSUVOVFxuICAgKiAgUkVDT05ORUNUUyBGUk9NIElUUyBTVEFSVC4gQSBkYWVtb24gdGhhdCBiZWxpZXZlcyB0aGUgY3Vyc29yIHNlbmRzIG9ubHlcbiAgICogIHdoYXQgbGllcyBhYm92ZSBpdCwgc28gdGhlIG5ldyBsb2cncyBlYXJseSBmcmFtZXMg4oCUIGEgaHVtYW4gbWVzc2FnZSBhdFxuICAgKiAgbmV3IGlkIDIgdW5kZXIgYW4gb2xkIGJvb2ttYXJrIG9mIDQg4oCUIHdlcmUgc2tpcHBlZCBzaWxlbnRseS4gRXZlcnl0aGluZyBpblxuICAgKiAgYSBuZXcgZXBvY2ggaXMgbmV3IHRvIHRoaXMgcmVhZGVyLCBzbyB0aGUgYXR0ZW1wdCBpcyBkcm9wcGVkIGFuZCByZS1tYWRlXG4gICAqICBmcm9tIDAgYXQgb25jZSAobm8gYmFja29mZikuIEEgZnJhbWUgQVQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBtZWFuc1xuICAgKiAgdGhlIGRhZW1vbiBpcyBhbHJlYWR5IHJlcGxheWluZyB3aG9sZSwgYW5kIGlzIGtlcHQuIChSZXZpZXdlcidzIEQyIGdhcCxcbiAgICogIGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLikgKi9cbiAgb25FcG9jaENoYW5nZT86IChuZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBUaGUgZXBvY2ggdGhlIHN0YXJ0aW5nIGBzaW5jZWAgY2FtZSBmcm9tLCB3aGVuIHRoZSBjYWxsZXIgaGFzIG9uZSAoYVxuICAgKiAgYm9va21hcmsgcHJpbnRlZCBhcyBgTkA8ZXBvY2g+YCwgYC4vdGFpbEhhbmRvZmYudHNgKS4gVGhlIGZpcnN0IGZyYW1lIG9mIGFcbiAgICogIGRpZmZlcmVudCBlcG9jaCBpcyB0aGVuIGFuIGVwb2NoIGNoYW5nZSBsaWtlIGFueSBvdGhlciDigJQgd2hpY2ggaXMgd2hhdFxuICAgKiAgc3RvcHMgYSBib29rbWFyayBvdXRsaXZpbmcgaXRzIGxvZyBhY3Jvc3MgcHJvY2Vzc2VzLiAqL1xuICBzaW5jZUVwb2NoPzogc3RyaW5nO1xuICAvKipcbiAgICogUmVhZCBhIGZyYW1lIHdob3NlIGlkIGlzIEFUIE9SIEJFTE9XIHRoZSBjdXJzb3IgdGhpcyBjb25uZWN0aW9uIGFza2VkXG4gICAqIGZyb20gYXMgXCJ0aGUgbG9nIHJlc3RhcnRlZFwiLCByZXNldCB0aGUgY3Vyc29yIHRvIDAsIGFuZCBjYWxsXG4gICAqIGBvbkVwb2NoQ2hhbmdlYCAod2l0aCB0aGUgZnJhbWUncyBlcG9jaCwgb3IgYFwidW5rbm93blwiYCkuIERlZmF1bHQgZmFsc2UuXG4gICAqXG4gICAqIOKblCBXSFkgSVQgSVMgSE9ORVNUOiB0aGUga2l0J3MgZXZlbnQgbG9nIGFuc3dlcnMgYSBjdXJzb3IgYmV5b25kIGl0cyBvd25cbiAgICogYnkgcmVwbGF5aW5nIFdIT0xFIChgLi9ldmVudExvZy50c2AsIHBvaW50IDMpLCBhbmQgb3RoZXJ3aXNlIHNlbmRzIG9ubHlcbiAgICogaWRzIGFib3ZlIHRoZSBjdXJzb3IuIFNvIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBleGlzdHMgb25seVxuICAgKiB3aGVuIHRoZSBkYWVtb24ganVkZ2VkIHRoZSBjdXJzb3IgZm9yZWlnbiDigJQgYSByZXN0YXJ0ZWQgZGFlbW9uLCB3aG9zZSBpZHNcbiAgICogYmVnYW4gYWdhaW4gYXQgMS4gVGhlIGVwb2NoIGNhdGNoZXMgdGhhdCBXSVRISU4gb25lIHByb2Nlc3M7IHRoaXMgY2F0Y2hlc1xuICAgKiBpdCBBQ1JPU1MgcHJvY2Vzc2VzLCB3aGVyZSBhIHJlLWFybWVkIHRhaWwgY2FycmllcyBhIGJvb2ttYXJrIGZyb20gYSBsb2dcbiAgICogdGhhdCBubyBsb25nZXIgZXhpc3RzIGFuZCwgd2l0aG91dCBpdCwga2VwdCB0aGF0IGJvb2ttYXJrIGZvcmV2ZXI6IGV2ZXJ5XG4gICAqIHJlLWFybSByZXBsYXllZCB0aGUgd2hvbGUgbmV3IGxvZywgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3BcbiAgICogKGZvdW5kIGJ5IHRoZSB2ZXJpZmllciBvbiBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgYWZ0ZXIgYHRhaWwubG9zdGAg4oaSXG4gICAqIGBvcGVuIC0tcmVzdG9yZWApLlxuICAgKlxuICAgKiDimqAgT05MWSBGT1IgQSBEQUVNT04gT04gVEhFIEtJVCdTIEVWRU5UIExPRy4gR3JhcGV2aW5lJ3MgaWRzIGFyZSByZWNvdmVyZWRcbiAgICogYWNyb3NzIGEgcmVzdGFydCBhbmQgaXRzIGAtLWxhc3RgIHF1ZXJ5IG92ZXJyaWRlcyBgc2luY2VgLCBzbyBpdCBsZWF2ZXNcbiAgICogdGhpcyBvZmYuIEFuZCB0aGUgYmxpbmQgc3BvdCBpcyBzdGF0ZWQ6IGEgYm9va21hcmsgdGhhdCBoYXBwZW5zIHRvIGJlIGF0XG4gICAqIG9yIGJlbG93IHRoZSBSRVNUQVJURUQgbG9nJ3Mgb3duIGxlbmd0aCBsb29rcyB2YWxpZCB0byB0aGUgZGFlbW9uLCB3aGljaFxuICAgKiB0aGVuIHNlbmRzIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LiBUaGUgY29tZS1iYWNrIHBhdGggdGhlcmVmb3JlIGRyb3BzXG4gICAqIHRoZSBib29rbWFyayBhbHRvZ2V0aGVyIChgLi90YWlsSGFuZG9mZi50c2AsIEQyKSwgc28gdGhpcyBpcyB0aGUgbmV0LCBub3RcbiAgICogdGhlIHJ1bGUuXG4gICAqL1xuICByZXN0YXJ0T25SZXBsYXk/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuIGBhY2NlcHRlZGAgaXMgYGFjY2VwdGAnc1xuICAgKiAgdmVyZGljdCBvbiB0aGlzIGZyYW1lLCB3aGljaCBpcyB3aGF0IGxldHMgYHRhaWwgLS1vbmNlYCBlbmQgb24gdGhlIGZpcnN0XG4gICAqICBmcmFtZSBpdCBhY3R1YWxseSBERUxJVkVSUyAoYC4vdGFpbEhhbmRvZmYudHNgKS5cbiAgICpcbiAgICogIOKblCBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTiBiZWZvcmUgdGhlIGNsaWVudCByZXR1cm5zLiBJdFxuICAgKiAgdXNlZCB0byByZXR1cm4gZnJvbSBpbnNpZGUgdGhlIHJlYWQgbG9vcCB3aXRoIHRoZSBTU0Ugc3RyZWFtIHN0aWxsIG9wZW4sXG4gICAqICB3aGljaCBrZXB0IHRoZSBwcm9jZXNzIGFsaXZlIOKAlCB1bnNlZW4gZm9yIGBjbG9zZWRgLCBiZWNhdXNlIHRoZSBzZXJ2ZXJcbiAgICogIGVuZHMgdGhhdCBzdHJlYW0gaXRzZWxmLCBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2tcbiAgICogIHdvdWxkIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LiAoQWRqdXN0bWVudCAxIG9mIHRoZVxuICAgKiAgTW9uaXRvci1leHBpcnkgc3Bpa2U7IHBpbm5lZCBpbiBgdGFpbEhhbmRvZmYudGVzdC50c2AuKSAqL1xuICB0ZXJtaW5hbD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSwgYWNjZXB0ZWQ6IGJvb2xlYW4pID0+IGJvb2xlYW47XG4gIC8qKiBFbWl0IHRoZSB0ZXJtaW5hbCBmcmFtZSBldmVuIHdoZW4gYGFjY2VwdGAgcmVqZWN0ZWQgaXQuIERlZmF1bHQgZmFsc2UuICovXG4gIHRlcm1pbmFsRW1pdHNGaWx0ZXJlZD86IGJvb2xlYW47XG5cbiAgLy8g4pSA4pSAIFRSQU5TUE9SVCBIRUFMVEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKlxuICAgKiBUaGUgaWRsZSB3YXRjaGRvZywgaW4gbXMuIERlZmF1bHQgNDVfMDAwIOKJiCB0aHJlZSBtaXNzZWQgMTVzIGhlYXJ0YmVhdHMuXG4gICAqIDAgZGlzYWJsZXMgaXQuIFdpdGhvdXQgb25lLCBgYXdhaXQgcmVhZGVyLnJlYWQoKWAgcGFya3MgRk9SRVZFUiBvbiBhXG4gICAqIGhhbGYtb3BlbiBzb2NrZXQgYWZ0ZXIgbGFwdG9wIHNsZWVwLCBhIE5BVCByZWJpbmQsIG9yIGEgU0lHS0lMTGVkIGRhZW1vbi5cbiAgICpcbiAgICog4pqgIEhvbGQgaXQgd2VsbCBhYm92ZSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LiBXaGVyZSBob2xkaW5nIHRoZSBjb25uZWN0aW9uXG4gICAqIG9wZW4gSVMgdGhlIHByZXNlbmNlIHNpZ25hbCwgZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhIGNhcmQgaW4gYSBodW1hbidzXG4gICAqIHZpZXcg4oCUIHRoYXQgaXMgdGhlIG9uZSBwbGFjZSB0aGlzIGNvbnZlcmdlbmNlIHNob3dzIHVwIGZvciBhIHBlcnNvbi4gSXRcbiAgICogc3RpbGwgd2FudHMgdGhlIHdhdGNoZG9nOiBhIHdlZGdlZCBoYWxmLW9wZW4gY29ubmVjdGlvbiBzaG93cyBhIGNhcmQgYXNcbiAgICogcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgd29yc2UuXG4gICAqL1xuICBpZGxlTXM/OiBudW1iZXI7XG4gIC8qKiBSZWNvbm5lY3QgYmFja29mZi4gRGVmYXVsdCBgeyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfWA7IGRvdWJsZXMgb25cbiAgICogIGV2ZXJ5IGZhaWxlZCBhdHRlbXB0IGFuZCBSRVNFVFMgb24gYSBzdWNjZXNzZnVsIG9wZW4uIEEgYnJhbmNoIHRoYXQgc2xlZXBzXG4gICAqICB3aXRob3V0IGdyb3dpbmcgdGhlIGRlbGF5IGlzIGEgY29uc3RhbnQtaW50ZXJ2YWwgcmVjb25uZWN0IHN0b3JtIOKAlCB0aGF0IGlzIGFcbiAgICogIGxpdmUgZGVmZWN0IGluIG9uZSBzcGVsbCB0b2RheSwgYW5kIHRoZXJlIGlzIG9uZSBjb2RlIHBhdGggaGVyZS4gKi9cbiAgcmV0cnk/OiB7IGluaXRpYWxNczogbnVtYmVyOyBtYXhNczogbnVtYmVyIH07XG4gIC8qKiBBIG5vbi0yeHggcmVzcG9uc2UuIERlZmF1bHQ6IHJldHJ5IHdpdGggYmFja29mZi4gTWF5IHRocm93IOKAlCBhIHJlZnVzZWRcbiAgICogIGNvbm5lY3Rpb24gKGFuIHVua25vd24gcHJvamVjdCwgYSBzdG9yZSB0aGF0IG5lZWRzIG9uZSkgaXMgYSB1c2FnZSBlcnJvcixcbiAgICogIG5vdCBhIHRyYW5zcG9ydCBibGlwLCBhbmQgcmV0cnlpbmcgaXQgZm9yZXZlciBqdXN0IHNwaW5zIHNpbGVudGx5LiAqL1xuICBvbkh0dHBFcnJvcj86IChyZXM6IFJlc3BvbnNlKSA9PiBcInJldHJ5XCIgfCBQcm9taXNlPFwicmV0cnlcIj47XG4gIC8qKiBBIGA6YCBjb21tZW50IGxpbmUgKGEga2VlcGFsaXZlKS4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAg4oCUIHRoZSBzZW50aW5lbFxuICAgKiAgdGhhdCBsZXRzIGEgYDI+JjFgIGNvbnN1bWVyIHRlbGwgXCJpZGxlXCIgZnJvbSBcIndlZGdlZFwiIOKAlCBvciBudWxsLlxuICAgKiAg4puUIENvbW1lbnRzIEZFRUQgVEhFIFdBVENIRE9HIGV2ZW4gdGhvdWdoIG9ubHkgZGF0YSBmcmFtZXMgc3Vydml2ZSB0aGVcbiAgICogIHNlbGVjdGlvbiBiZWxvdyDigJQgdGhhdCBpcyBoYW5kbGVkIGhlcmUsIGJlZm9yZSB0aGlzIGhvb2sgaXMgY2FsbGVkLiAqL1xuICBvbkNvbW1lbnQ/OiAodGV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKipcbiAgICogT25lIGNvbm5lY3Rpb24gYXR0ZW1wdCBlbmRlZC4gUmV0dXJuIGEgbGluZSBmb3IgYGVycmAsIG9yIG51bGwuXG4gICAqXG4gICAqIOKblCBUSElTIElTIEEgRElBR05PU1RJQ1MgU0lOSywgTk9UIEEgRklGVEggRVNDQVBFIEhBVENIIOKAlCBhbmQgdGhlXG4gICAqIGRpc3RpbmN0aW9uIGlzIGEgcnVsaW5nLCBub3QgYSBwcmVmZXJlbmNlLiBUaGUgaGF0Y2hlcyB0aGlzIGNsaWVudCBvZmZlcnNcbiAgICogKGBhY2NlcHRgLCBgcmVuZGVyYCwgYHF1ZXJ5YCwgYHJlc29sdmVgKSBhcmUgQkVIQVZJT1VSQUw6IHRoZXkgY2hhbmdlIHdoYXRcbiAgICogdGhlIGNsaWVudCBET0VTLiBUaGlzIG9uZSBjaGFuZ2VzIG9ubHkgd2hhdCB0aGUgQ0FMTEVSIFJFUE9SVFMsIHdoaWNoIGlzXG4gICAqIHdoYXQgYGVycmAgd2FzIGluIHRoZSBzaWduYXR1cmUgZm9yLiBUaGUgZGVzaWduJ3MgdHJpcC13aXJlIOKAlCBcImEgZmlmdGhcbiAgICogZXNjYXBlIGhhdGNoIG1lYW5zIGdyYXBldmluZSBrZWVwcyBpdHMgb3duIGxvb3BcIiDigJQgaXMgbm90IHRyaXBwZWQgYnkgaXQuXG4gICAqXG4gICAqIEl0IGV4aXN0cyBiZWNhdXNlIGEgdGFpbCB0aGF0IHJlY29ubmVjdHMgaW4gc2lsZW5jZSBpcyBpbmRpc3Rpbmd1aXNoYWJsZVxuICAgKiBmcm9tIGEgdGFpbCB0aGF0IGlzIHdvcmtpbmcsIGFuZCBvbmUgc3BlbGwgd3JpdGVzIGZvdXIgZGlzdGluY3QgbGluZXMgaGVyZS5cbiAgICogYGNhdXNlYCBzYXlzIHdoaWNoOyBgZXJyb3JgIGFuZCBgc3RhdHVzYCBjYXJyeSB3aGF0IHRoZSBsaW5lIG5lZWRzLlxuICAgKi9cbiAgb25EaXNjb25uZWN0PzogKGluZm86IHtcbiAgICBjYXVzZTogXCJjb25uZWN0LWZhaWxlZFwiIHwgXCJodHRwXCIgfCBcIm5vLWJvZHlcIiB8IFwic3RyZWFtLWVycm9yXCIgfCBcInN0cmVhbS1lbmRcIjtcbiAgICBlcnJvcj86IHVua25vd247XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICB9KSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBQTFVNQklORyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFdoZXJlIERBVEEgZ29lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRvdXRgLiAqL1xuICBvdXQ/OiBTaW5rO1xuICAvKiogV2hlcmUgRElBR05PU1RJQ1MgZ28g4oCUIGtlZXBhbGl2ZSBzZW50aW5lbHMsIGRpc2Nvbm5lY3Qgbm90ZXMsIHVucGFyc2VhYmxlXG4gICAqICBmcmFtZXMuIERlZmF1bHQgYHByb2Nlc3Muc3RkZXJyYC4gTmV2ZXIgbWl4ZWQgd2l0aCBgb3V0YDogYSBjYWxsZXIgcmVhZGluZ1xuICAgKiAgb3VyIHN0ZG91dCB3aXRoIGEgbGluZS1kZWxpbWl0ZWQgcGFyc2VyIG11c3QgbmV2ZXIgbWVldCBhIG5vdGUuICovXG4gIGVycj86IFNpbms7XG4gIC8qKiBDYWxsZXItb3duZWQgYWJvcnQuIEFib3J0aW5nIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAuICovXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsO1xuICAvKipcbiAgICogSW5zdGFsbCBTSUdJTlQvU0lHVEVSTSBoYW5kbGVycyB0aGF0IGVuZCB0aGUgdGFpbCBjbGVhbmx5IChkZWZhdWx0IHRydWUpLlxuICAgKiDim5QgVGhleSBlbmQgaXQgYnkgUkVUVVJOSU5HLCBub3QgYnkgZXhpdGluZyDigJQgc2VlIHRoZSBQMGYgc2NhcjogYSBzaWduYWxcbiAgICogaGFuZGxlciB0aGF0IGNhbGxzIGBwcm9jZXNzLmV4aXRgIGRpc2NhcmRzIHVuZHJhaW5lZCBzdGRvdXQsIHdoaWNoIGlzIHRoZVxuICAgKiBoYWxmIG9mIHRoZSBmaXggZml2ZSBzcGVsbHMgZGlkIG5vdCBhcHBseS5cbiAgICovXG4gIHNpZ25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogQ2FsbGVkIG9uY2UgYXMgdGhlIHRhaWwgZW5kcywgd2l0aCB0aGUgZmluYWwgY3Vyc29yICh0aGUgYm9va21hcmsgYSByZS1hcm1cbiAgICogcGFzc2VzIGFzIGAtLXNpbmNlYCkgYW5kIHdoeSBpdCBlbmRlZC4gQSBSRVBPUlQgU0lOSyBsaWtlIGBvbkRpc2Nvbm5lY3RgLFxuICAgKiBub3QgYSBiZWhhdmlvdXJhbCBoYXRjaDogaXQgY2hhbmdlcyBub3RoaW5nIHRoZSBjbGllbnQgZG9lcy4gSXQgZXhpc3RzXG4gICAqIGZvciBgLi90YWlsSGFuZG9mZi50c2AsIHdob3NlIGxhc3QgbGluZSBuYW1lcyB0aGUgcmUtYXJtIGFuZCBtdXN0IGNhcnJ5XG4gICAqIHRoZSBjdXJzb3IgZXhhY3RseSBhcyB0aGlzIGxvb3AgbGVmdCBpdCwgZXBvY2ggcmVzZXRzIGluY2x1ZGVkLlxuICAgKi9cbiAgb25FbmQ/OiAoZW5kOiB7XG4gICAgY3Vyc29yOiBudW1iZXI7XG4gICAgLyoqIFRoZSBlcG9jaCBvZiB0aGUgbG9nIHRoZSBjdXJzb3IgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmUuICovXG4gICAgZXBvY2g6IHN0cmluZyB8IG51bGw7XG4gICAgcmVhc29uOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiO1xuICB9KSA9PiB2b2lkO1xufTtcblxuY29uc3QgREVGQVVMVF9JRExFX01TID0gNDVfMDAwO1xuY29uc3QgREVGQVVMVF9SRVRSWSA9IHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH07XG5cbi8qKlxuICogUGFyc2UgYSBjb21wbGV0ZSBTU0UgZnJhbWUgYm9keSAodGhlIHRleHQgYmV0d2VlbiBibGFuayBsaW5lcykgcGVyIHRoZSBzcGVjJ3NcbiAqIFwiSW50ZXJwcmV0aW5nIGFuIGV2ZW50IHN0cmVhbVwiOiBzcGxpdCBhdCB0aGUgRklSU1QgY29sb24sIHN0cmlwIEFUIE1PU1QgT05FXG4gKiBsZWFkaW5nIHNwYWNlIGZyb20gdGhlIHZhbHVlLCBhY2N1bXVsYXRlIGBkYXRhYCBmaWVsZHMgd2l0aCBcIlxcblwiLlxuICpcbiAqIFJldHVybnMgbnVsbCBmb3IgYSBjb21tZW50LW9ubHkgZnJhbWU7IGBjb21tZW50c2AgY2FycmllcyB0aGVpciB0ZXh0IHNvIHRoZVxuICogY2FsbGVyIGNhbiBzdXJmYWNlIGEga2VlcGFsaXZlIHNlbnRpbmVsLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTc2VGcmFtZShibG9jazogc3RyaW5nKToge1xuICBmcmFtZTogU3NlRnJhbWUgfCBudWxsO1xuICBjb21tZW50czogc3RyaW5nW107XG59IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gb3B0cy5zaW5jZUVwb2NoID8/IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuICBsZXQgZW5kaW5nOiBcInRlcm1pbmFsXCIgfCBcInVucmVzb2x2ZWRcIiB8IFwic3RvcHBlZFwiID0gXCJzdG9wcGVkXCI7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICAvLyDim5QgQSBTVE9QIFRIQVQgTEFOREVEIFdISUxFIGByZXNvbHZlYCBXQVMgQVdBSVRFRCAodGhlIGhhbmRvZmYncyB3aW5kb3csXG4gICAgICAvLyBhIHNpZ25hbCkgZm91bmQgbm8gYXR0ZW1wdCB0byBhYm9ydC4gV2l0aG91dCB0aGlzIGNoZWNrIHRoZSBsb29wIHdlbnRcbiAgICAgIC8vIG9uIHRvIGZldGNoLCBza2lwcGVkIHRoZSByZWFkLCBhbmQgcmV0dXJuZWQgd2l0aCB0aGF0IHN0cmVhbSBzdGlsbFxuICAgICAgLy8gb3BlbiDigJQgd2hpY2gga2VlcHMgYSBwcm9jZXNzIGFsaXZlIGV4YWN0bHkgbGlrZSB0aGUgdGVybWluYWwtZnJhbWVcbiAgICAgIC8vIGhhbmcuIChTdXNwZWN0ZWQgYnkgdGhlIHJldmlld2VyLCBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLilcbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGlmIChiYXNlID09PSBudWxsKSB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSBvcHRzLm9uVW5yZXNvbHZlZD8uKHsgZXZlclJlc29sdmVkLCBldmVyQ29ubmVjdGVkIH0pID8/IFwicmV0cnlcIjtcbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiKSB7XG4gICAgICAgICAgZW5kaW5nID0gXCJ1bnJlc29sdmVkXCI7XG4gICAgICAgICAgcmV0dXJuIGNvZGU7XG4gICAgICAgIH1cbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgZXZlclJlc29sdmVkID0gdHJ1ZTtcblxuICAgICAgY29uc3QgcGFyYW1zID0gb3B0cy5xdWVyeT8uKGN1cnNvciwgZmlyc3RDb25uZWN0KSA/PyB7XG4gICAgICAgIHNpbmNlOiBTdHJpbmcoY3Vyc29yKSxcbiAgICAgIH07XG4gICAgICAvLyBXaGF0IHRoaXMgY29ubmVjdGlvbiBhc2tlZCBmcm9tLCBmb3IgYHJlc3RhcnRPblJlcGxheWAuXG4gICAgICBjb25zdCBhc2tlZFNpbmNlID0gY3Vyc29yO1xuICAgICAgbGV0IHJlc3RhcnROb3RlZCA9IGZhbHNlO1xuICAgICAgLy8gU2V0IHdoZW4gYW4gZXBvY2ggY2hhbmdlIGZpbmRzIHRoZSBuZXcgbG9nIHBhc3QgdGhlIGJvb2ttYXJrLlxuICAgICAgbGV0IGZyb21Ub3AgPSBmYWxzZTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyDim5QgVEhFIENVUlNPUiBBRFZBTkNFUyBPTiBFVkVSWSBFVkVOVCwgSU5DTFVESU5HIEEgRklMVEVSRUQgT05FLlxuICAgICAgICAgICAgLy8gQSBzY29wZSBwcmVkaWNhdGUgaXMgYWJvdXQgd2hhdCB0aGUgQ0FMTEVSIHJlYWRzLCBuZXZlciBhYm91dCB3aGF0XG4gICAgICAgICAgICAvLyB0aGUgZGFlbW9uIGhhcyBkZWxpdmVyZWQ7IGFkdmFuY2luZyBvbmx5IG9uIGVtaXR0ZWQgZXZlbnRzIG1ha2VzXG4gICAgICAgICAgICAvLyBldmVyeSByZWNvbm5lY3QgcmUtcmVxdWVzdCB0aGUgZmlsdGVyZWQgb25lcyBmb3JldmVyLlxuICAgICAgICAgICAgY29uc3QgbiA9IG9wdHMuY3Vyc29yT2Y/Lihldik7XG5cbiAgICAgICAgICAgIGxldCBlcG9jaFJlc2V0ID0gZmFsc2U7XG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBlcG9jaFJlc2V0ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihuZXh0KSA/PyBudWxsO1xuICAgICAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgICAgICAvLyBUaGUgbmV3IGxvZyBpcyBwYXN0IHRoZSBib29rbWFyazogaXRzIHN0YXJ0IHdhcyBza2lwcGVkLlxuICAgICAgICAgICAgICAgICAgLy8gRHJvcCB0aGlzIGF0dGVtcHQgYW5kIHJlLXJlYWQgdGhlIG5ldyBsb2cgZnJvbSAwLlxuICAgICAgICAgICAgICAgICAgaWYgKGFza2VkU2luY2UgPiAwICYmIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIG4gPiBhc2tlZFNpbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGVwb2NoID0gbmV4dDtcbiAgICAgICAgICAgICAgICAgICAgZnJvbVRvcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICAgb3B0cy5yZXN0YXJ0T25SZXBsYXkgPT09IHRydWUgJiZcbiAgICAgICAgICAgICAgIWVwb2NoUmVzZXQgJiZcbiAgICAgICAgICAgICAgIXJlc3RhcnROb3RlZCAmJlxuICAgICAgICAgICAgICBhc2tlZFNpbmNlID49IDAgJiZcbiAgICAgICAgICAgICAgdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiZcbiAgICAgICAgICAgICAgbiA8PSBhc2tlZFNpbmNlXG4gICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiByZXBsYXllZCBXSE9MRTogaXRzIGxvZyByZXN0YXJ0ZWQgKHNlZSB0aGUgb3B0aW9uKS5cbiAgICAgICAgICAgICAgcmVzdGFydE5vdGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25FcG9jaENoYW5nZT8uKG9wdHMuZXBvY2hPZj8uKGV2KSA/PyBcInVua25vd25cIikgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAodHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pKSB7XG4gICAgICAgICAgICAgIGN1cnNvciA9IGN1cnNvclBvbGljeSA9PT0gXCJhc3NpZ25cIiA/IG4gOiBNYXRoLm1heChjdXJzb3IsIG4pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBhY2NlcHRlZCA9IG9wdHMuYWNjZXB0Py4oZXYsIGZyYW1lKSA/PyB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaXNUZXJtaW5hbCA9IG9wdHMudGVybWluYWw/LihldiwgZnJhbWUsIGFjY2VwdGVkKSA/PyBmYWxzZTtcblxuICAgICAgICAgICAgaWYgKGFjY2VwdGVkIHx8IChpc1Rlcm1pbmFsICYmIG9wdHMudGVybWluYWxFbWl0c0ZpbHRlcmVkID09PSB0cnVlKSkge1xuICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5yZW5kZXIgPyBvcHRzLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNUZXJtaW5hbCkge1xuICAgICAgICAgICAgICAvLyDim5QgQ0xPU0UgVEhFIENPTk5FQ1RJT04uIFNlZSBgdGVybWluYWxgJ3MgZG9jOiB3aXRob3V0IHRoaXMgdGhlXG4gICAgICAgICAgICAgIC8vIG9wZW4gc3RyZWFtIGtlZXBzIHRoZSBwcm9jZXNzIGFsaXZlIGFmdGVyIHdlIHJldHVybi5cbiAgICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgICBlbmRpbmcgPSBcInRlcm1pbmFsXCI7XG4gICAgICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAgICAgY29udHJvbGxlci5hYm9ydCgpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoZnJvbVRvcCkge1xuICAgICAgICAvLyBSZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gaXRzIHN0YXJ0LCBub3c6IG5vdGhpbmcgZmFpbGVkLlxuICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICAvLyDim5QgQU5EIFRIRSBHUk9XVEggTElORSBCRUxPTkdTIEhFUkUgVE9PLiBFdmVyeSBgY29udGludWVgIGFib3ZlIGdyb3dzXG4gICAgICAvLyB0aGUgZGVsYXk7IHRoZSBwYXRoIHRoYXQgZmFsbHMgdGhyb3VnaCDigJQgYSBjb25uZWN0aW9uIHRoYXQgT1BFTkVEIGFuZFxuICAgICAgLy8gdGhlbiBlbmRlZCDigJQgZGlkIG5vdCwgaW4gYW55IG9mIHRoZSBzZXZlbiBoYW5kLXdyaXR0ZW4gbG9vcHMuIEFnYWluc3QgYVxuICAgICAgLy8gZGFlbW9uIHRoYXQgYWNjZXB0cyBhbmQgaW1tZWRpYXRlbHkgY2xvc2VzLCB0aGF0IGlzIGEgcmVjb25uZWN0IGF0IGFcbiAgICAgIC8vIGNvbnN0YW50IDI1MG1zIGZvciBhcyBsb25nIGFzIGl0IHN0YXlzIHNpY2ssIHdoaWNoIGlzIEI1J3Mgc2hhcGVcbiAgICAgIC8vIHJlYWNoZWQgYnkgYSBkaWZmZXJlbnQgZG9vci4gVGhlIHJlc2V0IG9uIHRoZSBmaXJzdCBieXRlIChhYm92ZSkgaXNcbiAgICAgIC8vIHdoYXQga2VlcHMgdGhpcyBmcm9tIHNsb3dpbmcgYSBoZWFsdGh5IHRhaWwgZG93bi5cbiAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICAgIG9wdHMub25FbmQ/Lih7IGN1cnNvciwgZXBvY2gsIHJlYXNvbjogZW5kaW5nIH0pO1xuICB9XG59XG4iLAogICAgIi8qKlxuICogVGhlIHRhaWwncyBIQU5ET0ZGOiBob3cgYSBzcGVsbCdzIGB0YWlsYCBlbmRzIGl0cyBvd24gd2F0Y2gganVzdCBiZWZvcmUgdGhlXG4gKiBoYXJuZXNzJ3MgTW9uaXRvciBjYXAsIGFuZCB0aGUgb25lIHN0ZG91dCBsaW5lIHRoYXQgbmFtZXMgdGhlIGFnZW50J3MgbmV4dFxuICogYWN0LCBib29rbWFyayBpbmNsdWRlZC5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBpdHMgc2libGluZyBgLi90YWlsRXZlbnRzYC5cbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRvIENvbGUncyBydWxpbmcgb2YgMjAyNi0wOS0yMyAodGhlXG4gKiBcIlJ1bGluZ1wiIHNlY3Rpb24gb2ZcbiAqIGBkb2NzL2l0ZW1zL3NjcmlwdG9yaXVtLXRhaWwtbW9uaXRvci1leHBpcnktd2FrZXMtdGhlLWFnZW50LWZvci1ub3RoaW5nLm1kYClcbiAqIGFuZCB0aGUgZm91ciBhZGp1c3RtZW50cyBvZiBpdHMgZmVhc2liaWxpdHkgc3Bpa2VcbiAqIChgZG9jcy9pdGVtcy9tb25pdG9yLWV4cGlyeS1hbmQtdGhlLXRhaWwvd3JpdGUtdXAubWRgKS5cbiAqXG4gKiDilIDilIAgVEhFIFBST0JMRU0sIE9ORSBQQVJBR1JBUEgg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogQ2xhdWRlIENvZGUncyBNb25pdG9yIGtpbGxzIGV2ZXJ5IHdhdGNoIGF0IDEsODAwLDAwMCBtcy4gRXZlcnkgc3BlbGwgdGVsbHNcbiAqIHRoZSBhZ2VudCB0byB3cmFwIGB0YWlsYCBpbiBNb25pdG9yLCBzbyBhbiBpZGxlIHNlc3Npb24gd29rZSB0aGUgYWdlbnQgZXZlcnlcbiAqIDMwIG1pbnV0ZXMgdG8gcmUtYXJtLCBhbmQgYSBiYXJlIHJlLWFybSByZXBsYXllZCB1cCB0byB0aGUgbGFzdCAxMDAwIGV2ZW50cyxcbiAqIGFuc3dlcmVkIGh1bWFuIG1lc3NhZ2VzIGluY2x1ZGVkLiBUaGUgcmVwbGF5IGlzIGEgY29ycmVjdG5lc3MgYnVnOyB0aGUgaWRsZVxuICogd2FrZXMgYXJlIGEgY29zdCBDb2xlIHJ1bGVkIGFnYWluc3QuXG4gKlxuICog4pSA4pSAIFRIRSBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUd28gbW9kZXMsIG9uZSBsaW5lIGF0IHRoZSBlbmQgb2YgZWFjaDpcbiAqXG4gKiAgIOKAoiBgd2F0Y2hgICh0aGUgZGVmYXVsdCwgcnVuIHVuZGVyIE1vbml0b3IpOiBzdHJlYW1zIHVudGlsIGl0cyBXSU5ET1cgZW5kcyxcbiAqICAgICB0aGVuIHByaW50cyBgdGFpbC53aW5kb3dgIChpdCBzYXcgZXZlbnRzIOKGkiByZS1hcm0gTW9uaXRvcikgb3JcbiAqICAgICBgdGFpbC5xdWlldGAgKGl0IHNhdyBub25lIOKGkiBydW4gYHRhaWwgLS1vbmNlYCBhcyBhIGJhY2tncm91bmQgQmFzaFxuICogICAgIHRhc2spLiBBIFBSRVNFTkNFIHNwZWxsIChhc3Ryb2xhYmUsIGdyYXBldmluZSkgYWx3YXlzIGdldHNcbiAqICAgICBgdGFpbC53aW5kb3dgOiBhIHN0b3Atc3RhcnQgdGFpbCB3b3VsZCBmbGlja2VyIHRoZSBwcmVzZW5jZSBpdHNcbiAqICAgICBjb25uZWN0aW9uIGNhcnJpZXMuIE1pbmQtbWFwcGVyIHdhcyBvbmUgYW5kIGlzIG5vdCBzaW5jZSAyMDI2LTA5LTI0XG4gKiAgICAgKHNlZSBcIk1JTkQtTUFQUEVSIEpPSU5TIFRIRSBTRVNTSU9OIFNQRUxMU1wiIGJlbG93KS5cbiAqICAg4oCiIGBvbmNlYCAocnVuIGFzIGEgYmFja2dyb3VuZCBCYXNoIHRhc2spOiBzbGVlcHMgdW50aWwgdGhlIGZpcnN0IGxvZyBldmVudCxcbiAqICAgICBwcmludHMgaXQsIHByaW50cyBgdGFpbC53b2tlYCAo4oaSIGJhY2sgdG8gTW9uaXRvcikgYW5kIEVYSVRTLCB3aGljaCBpc1xuICogICAgIHdoYXQgd2FrZXMgdGhlIGFnZW50LlxuICpcbiAqIEVpdGhlciBtb2RlIGVuZHMgd2l0aCBgdGFpbC5jbG9zZWRgIHdoZW4gdGhlIHNlc3Npb24gY2xvc2VzIGFuZCBgdGFpbC5sb3N0YFxuICogd2hlbiB0aGUgZGFlbW9uIGlzIGdvbmUgKHNlc3Npb24gc3BlbGxzIGFuZCBtaW5kLW1hcHBlciksIGVhY2ggbmFtaW5nIGhvdyB0b1xuICogY29tZSBiYWNrIGluc3RlYWQgb2YgYSByZS1hcm0uIEEgc2lnbmFsIG9yIGEgY2FsbGVyJ3MgYWJvcnQgcHJpbnRzIG5vdGhpbmcuXG4gKlxuICogRXZlcnkgcmUtYXJtIGNhcnJpZXMgYC0tc2luY2UgPGN1cnNvcj5gLCBzbyBub3RoaW5nIHJlcGxheXM7IHRoZSBkYWVtb24nc1xuICogYnVmZmVyIGNvdmVycyB3aGF0ZXZlciBsYW5kcyBiZXR3ZWVuIG9uZSB3YXRjaCdzIGV4aXQgYW5kIHRoZSBuZXh0J3MgYXJtLlxuICpcbiAqIOKUgOKUgCBERUNJU0lPTiBMT0cgKGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmLCAyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBLaXQgZGVjaXNpb25zIGxpdmUgaW4gbW9kdWxlIGhlYWRlcnMgKHRoZSBhcmNoaXRlY3R1cmUgZG9jJ3Mgwqc0IHJ1bGU6IFwiZWFjaFxuICogbW9kdWxlJ3MgaGVhZGVyIGlzIHRoZSBhdXRob3JpdGF0aXZlIGFjY291bnRcIikuIFJ1bGVkIGJ5IENvbGU6IHRoZSBoeWJyaWQsXG4gKiB0aGUgYWx3YXlzLWJvb2ttYXJrLCBwcmVzZW5jZSBzcGVsbHMgYWx3YXlzIHJlLWFybSBNb25pdG9yLCBib3VudHkncyBleGFtcGxlXG4gKiBmaXhlZC4gVGhlIGZvdXIgYWRqdXN0bWVudHMgd2VyZSB0aGUgc3Bpa2UncyByZXF1aXJlbWVudHMuIFRoZSByZXN0IGFyZSB0aGVcbiAqIGltcGxlbWVudGVyJ3MgcnVsaW5ncywgbWFya2VkIOKaliB3aXRoIHRoZSBvcHRpb25zIG5vdCB0YWtlbi5cbiAqXG4gKiBBMSDCtyBBIFRFUk1JTkFMIEZSQU1FIENMT1NFUyBUSEUgQ09OTkVDVElPTi4gYHRhaWxFdmVudHNgIG5vdyBhYm9ydHMgdGhlXG4gKiAgICAgIGluLWZsaWdodCBmZXRjaCBiZWZvcmUgaXQgcmV0dXJucyBvbiBhIHRlcm1pbmFsIGZyYW1lLiBCZWZvcmUsIGl0XG4gKiAgICAgIHJldHVybmVkIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3AgYW5kIGxlZnQgdGhlIFNTRSBzdHJlYW0gb3Blbiwgc28gdGhlXG4gKiAgICAgIHByb2Nlc3Mgc3RheWVkIGFsaXZlOiB1bnNlZW4gZm9yIGBjbG9zZWRgICh0aGUgc2VydmVyIGVuZHMgdGhhdFxuICogICAgICBzdHJlYW0gaXRzZWxmKSBhbmQgZmF0YWwgZm9yIGAtLW9uY2VgLCB3aG9zZSBiYWNrZ3JvdW5kIHRhc2sgd291bGRcbiAqICAgICAgbmV2ZXIgZXhpdCBhbmQgc28gbmV2ZXIgd2FrZSB0aGUgYWdlbnQsIHNpbGVudGx5LiBQaW5uZWQgaW5cbiAqICAgICAgYHRhaWxIYW5kb2ZmLnRlc3QudHNgIGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBrZWVwcyB0aGUgc3RyZWFtIG9wZW4uXG4gKlxuICogQTIgwrcgVEhFIE5FWFQgQUNUIERFUEVORFMgT04gU1RBVEUuIGBoYW5kb2ZmKClgIGJlbG93IGlzIHRoZSBwdXJlIGRlY2lzaW9uOlxuICogICAgICBxdWlldCDihpIgYmFja2dyb3VuZCwgYWN0aXZlIG9yIHByZXNlbmNlIOKGkiBNb25pdG9yLCB3b2tlIOKGkiBNb25pdG9yLFxuICogICAgICBjbG9zZWQg4oaSIGNvbWUgYmFjaywgbG9zdCDihpIgY29tZSBiYWNrLiBDb21lIGJhY2sgaXMgdGhlIHNwZWxsJ3Mgb3duIHZlcmJcbiAqICAgICAgKGBvcGVuIC0tcmVzdG9yZSA8aWQ+YCBmb3IgdGhlIHNlc3Npb24gc3BlbGxzLCBgb3BlbiAtLW5vLW9wZW5gIGZvclxuICogICAgICBtaW5kLW1hcHBlciBhbmQgYXN0cm9sYWJlKS5cbiAqICAgICAg4pqWIFRIRSBESVNDT05ORUNUIERFQ0lTSU9OOiBmb3IgYSBzZXNzaW9uIHNwZWxsLCBhIExPU1QgZGFlbW9uIGVuZHMgdGhlXG4gKiAgICAgIHRhaWwgaW4gQk9USCBtb2RlcyB3aXRoIGEgc3Rkb3V0IGB0YWlsLmxvc3RgIGxpbmUuIE1vbml0b3Igbm90aWZpZXMgb25seVxuICogICAgICBvbiBzdGRvdXQsIHNvIHRoZSBvbGQgc3RkZXJyLW9ubHkgYHRhaWwuZGlzY29ubmVjdGVkYCBsZWZ0IGFcbiAqICAgICAgTW9uaXRvci13cmFwcGVkIGFnZW50IHVuYXdhcmUgb2YgYSBga2lsbCAtOWAgKEU1NSdzIHB1cnBvc2UgdW5tZXQpLCBhbmRcbiAqICAgICAgYSBgLS1vbmNlYCBvbiBhIGRlYWQgZGFlbW9uIHdvdWxkIGhhdmUgc2xlcHQgZm9yZXZlci4gXCJMb3N0XCIgaXNcbiAqICAgICAgYExPU1RfQUZURVJfUkVGVVNBTFNgIGNvbm5lY3Rpb24gcmVmdXNhbHMgaW4gYSByb3csIG5ldmVyIGEgZHJvcHBlZFxuICogICAgICBzdHJlYW0gYWxvbmU6IGEgbGFwdG9wIHRoYXQgc2xlZXBzIGRyb3BzIHRoZSBzdHJlYW0sIHJlY29ubmVjdHMgb24gdGhlXG4gKiAgICAgIGZpcnN0IHRyeSwgYW5kIG11c3Qgc3RheSBzaWxlbnQuXG4gKiAgICAgICAgTm90IHRha2VuOiAoYSkga2VlcCByZXRyeWluZyBhbmQgb25seSBNT1ZFIHRoZSBkaXNjb25uZWN0IGxpbmUgdG9cbiAqICAgICAgICBzdGRvdXQg4oCUIGEgc2Vzc2lvbiBkYWVtb24gaXMgbmV2ZXIgcmVzcGF3bmVkIGJ5IGl0cyB0YWlsLCBzbyB0aGVcbiAqICAgICAgICByZXRyaWVzIGJ1eSBub3RoaW5nIGFuZCB0aGUgYWdlbnQgaXMgd29rZW4gdG8gYmUgdG9sZCB0byB3YWl0OyAoYilcbiAqICAgICAgICBsZWF2ZSBpdCBvbiBzdGRlcnIg4oCUIHRoZSBkZWZlY3QuXG4gKiAgICAgIOKaliBQcmVzZW5jZSBzcGVsbHMga2VlcCByZXRyeWluZywgYXMgYmVmb3JlOiBncmFwZXZpbmUncyB0YWlsIHJlc3Bhd25zXG4gKiAgICAgIGl0cyBkYWVtb24gYW5kIGFzdHJvbGFiZSdzIGBqb2luYCB3YWl0cyBmb3IgdGhlIGh1bWFuIHRvIHJlb3BlbiB0aGVcbiAqICAgICAgYm9hcmQsIGJvdGggYnkgZGVzaWduLiBUaGVpciBkaXNjb25uZWN0IG5vdGVzIHN0YXkgd2hlcmUgdGhleSB3ZXJlLlxuICpcbiAqIEEzIMK3IFFVSUVUIElTIFRIRSBUQUlMJ1MgT1dOIENPVU5ULiBgZXZlbnRzYCBjb3VudHMgdGhlIGxvZyBmcmFtZXMgdGhpc1xuICogICAgICBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dC4gVGhlIGdyb3VuZGluZyBsaW5lLCBhIHNwZWxsJ3MgYHN1YnNjcmliZWRgXG4gKiAgICAgIG1hcmtlciwgYGVwb2NoLmNoYW5nZWRgIGFuZCB0aGUgaGFuZG9mZiBsaW5lIGl0c2VsZiBhcmUgbm90IGxvZyBmcmFtZXNcbiAqICAgICAgYW5kIGFyZSBub3QgY291bnRlZDogYSBmcmFtZSBjb3VudHMgb25seSBpZiBpdCBjYXJyaWVzIGEgbG9nIGlkIChEMyksXG4gKiAgICAgIGFuZCBgY291bnRzYCBsZXRzIGEgc3BlbGwgZXhjbHVkZSBhIGZyYW1lIHRoYXQgZG9lcyAoZ3JhcGV2aW5lJ3NcbiAqICAgICAgYHN1YnNjcmliZWRgIG1hcmtlciwgd2hpY2ggc2VlZHMgdGhlIGJvb2ttYXJrIGZyb20gYGxhdGVzdF9pZGApLiBBbnkgbG9nIGZyYW1lIGNvdW50cywgdGhlIGRhZW1vbidzIGB3YWl0aW5nYCByZW1pbmRlclxuICogICAgICBpbmNsdWRlZCwgc28gXCJxdWlldFwiIG1lYW5zIG5vdGhpbmcgb24gdGhlIGxvZy5cbiAqICAgICAg4pqWIEEgZnJhbWUgdGhlIHRhaWwncyBvd24gZmlsdGVyIHJlamVjdHMgKGJvdW50eSdzIG93bmVyIHNjb3BlLCBhXG4gKiAgICAgIHNlbGYtZWNobykgaXMgTk9UIGNvdW50ZWQgYW5kIGRvZXMgbm90IGVuZCBhIGAtLW9uY2VgOiBpdCB3YXMgbmV2ZXJcbiAqICAgICAgZGVsaXZlcmVkLCBhbmQgd2FraW5nIG9uIGl0IHdvdWxkIGJlIGEgd2FrZSB3aXRoIG5vdGhpbmcgdG8gYWN0IG9uIOKAlFxuICogICAgICB0aGUgZGVmZWN0IHRoaXMgbW9kdWxlIGV4aXN0cyB0byByZW1vdmUuIFRoZSBjdXJzb3Igc3RpbGwgYWR2YW5jZXNcbiAqICAgICAgcGFzdCBpdCAodGFpbEV2ZW50cycgcnVsZSksIHNvIGl0IG5ldmVyIHJlcGxheXMgZWl0aGVyLlxuICogICAgICBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOyB0aGF0IGhhbGYgbGl2ZXMgaW4gZWFjaFxuICogICAgICBzcGVsbCdzIGB0YWlsYCwgd2hpY2gga25vd3Mgd2hldGhlciBgLS1zaW5jZWAgd2FzIGdpdmVuLlxuICpcbiAqIEE0IMK3IFRIRSBXSU5ET1cuIGBERUZBVUxUX1dJTkRPV19NU2AgPSB0aGUgY2FwIG1pbnVzIGBXSU5ET1dfTUFSR0lOX01TYFxuICogICAgICAoNjAgcyksIHNvIDEsNzQwLDAwMCBtcy4gVGhlIG1hcmdpbiBoYXMgdG8gY292ZXIgdGhlIGdhcCBiZXR3ZWVuIHRoZVxuICogICAgICBoYXJuZXNzIHN0YXJ0aW5nIGl0cyBjbG9jayBhbmQgdGhpcyBwcm9jZXNzIHN0YXJ0aW5nIGl0cyBvd24gKEJ1blxuICogICAgICBzdGFydC11cCwgYSBzZXNzaW9uIGxvb2t1cCwgYSBkYWVtb24gc3Bhd24gb24gdGhlIHNwZWxscyB3aG9zZSBgcmVzb2x2ZWBcbiAqICAgICAgc3Bhd25zIG9uZSDigJQgYm91bmRlZCBieSB0aGVpciBzdGFydCB0aW1lb3V0cywgd2hpY2ggYXJlIHNlY29uZHMpIHBsdXNcbiAqICAgICAgdGhlIGxhc3QgbGluZSdzIGZsdXNoIGFuZCBNb25pdG9yJ3MgMjAwIG1zIGJhdGNoaW5nLiBBIG1pbnV0ZSBjb3ZlcnNcbiAqICAgICAgYWxsIG9mIHRoYXQgbWFueSB0aW1lcyBvdmVyLiBUaGUgc3Bpa2UgbWVhc3VyZWQgYSAxMiBzXG4gKiAgICAgIHdpbmRvdyB1bmRlciBhIDIwIHMgY2FwIGVuZGluZyBjbGVhbmx5OyBub3RoaW5nIGhlcmUgZGVwZW5kcyBvbiBhXG4gKiAgICAgIG1hcmdpbiB0aGF0IHRpZ2h0LiBJZiB0aGUgY2FwIHdpbnMgYW55d2F5LCB0aGUgYWdlbnQgZ2V0cyBNb25pdG9yJ3NcbiAqICAgICAgYmFyZSBleHBpcnkgbm90aWNlIGFuZCByZS1hcm1zIHNpbGVudGx5IGZyb20gdGhlIGxhc3QgaWQgaXQgc2F3IOKAlCB0aGVcbiAqICAgICAgcnVsaW5nJ3MgZmFsbGJhY2ssIHN0YXRlZCBpbiBldmVyeSBza2lsbC5cbiAqICAgICAg4pqWIFRoZSB3aW5kb3cgaXMgaW5qZWN0YWJsZSBmb3IgdGVzdHMgYW5kIHZlcmlmaWNhdGlvbiB0aHJvdWdoXG4gKiAgICAgIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVNgIChhIGNvdW50IG9mIG1zOyBgMGAgdHVybnMgdGhlIHdpbmRvdyBvZmYsXG4gKiAgICAgIGZvciBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwpLiBBbiBlbnYgdmFyIGFuZCBub3QgYSBmbGFnOiBpdCBpc1xuICogICAgICBub3QgYW4gYWdlbnQncyBhY3QsIHNvIGl0IHN0YXlzIG91dCBvZiBlaWdodCB2ZXJicycgc2NoZW1hcy5cbiAqXG4gKiDilIDilIAgVEhFIFZFUklGSUVSJ1MgREVGRUNUUywgRklYRUQgT04gVEhFIFNBTUUgQlJBTkNIICgyMDI2LTA5LTIzKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbm8tc3Rha2UgdmVyaWZpZXIgcmFuIGV2ZXJ5IHNwZWxsJ3MgcmVhbCB0YWlsIGFuZCBmb3VuZCBmb3VyIHdheXMgdGhlXG4gKiBsb29wIGJyb2tlLiBFYWNoIGhhcyBhIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgOyBEMSBhbmQgRDIgYWxzbyBoYXZlIGFcbiAqIHJlYWwtZGFlbW9uIGNlbGwgaW4gYHNyYy9zY3JpcHRvcml1bS9iYWNrZW5kL3RhaWwtaGFuZG9mZi5pbnRlZ3JhdGlvbi50ZXN0LnRzYC5cbiAqXG4gKiBEMSDCtyBBIFJFLUFSTSBBVCBBIFNFU1NJT04gVEhBVCBDTE9TRUQgSU4gVEhFIEdBUCBFTkRTIGB0YWlsLmNsb3NlZGAuIFRoZVxuICogICAgICB0cmlnZ2VyIGlzIG9yZGluYXJ5OiB0aGUgaHVtYW4gcHJlc3NlcyBDbG9zZSB3aGlsZSB0aGUgYWdlbnQgaGFuZGxlc1xuICogICAgICBgdGFpbC53b2tlYC4gVGhlIHNlc3Npb24gc3BlbGxzIHN0b3BwZWQgb25seSB3aGVuIFRISVMgcHJvY2VzcyBoYWRcbiAqICAgICAgb25jZSByZWFjaGVkIHRoZSBzZXNzaW9uLCBzbyB0aGUgcmUtYXJtIHJldHJpZWQgXCJubyBzZXNzaW9uIHlldFwiIG9uXG4gKiAgICAgIHN0ZGVyciBmb3JldmVyIOKAlCBhbmQgaXRzIGAtLW9uY2VgIG5ldmVyIGV4aXRlZC4gUnVsZTogYSB0YWlsIGdpdmVuXG4gKiAgICAgIGAtLXNlc3Npb25gIG9yIGEgYm9va21hcmsgaXMgcmUtYXJtaW5nIGFuIEVYSVNUSU5HIHNlc3Npb24sIHNvIG5vdFxuICogICAgICBmaW5kaW5nIGl0IG1lYW5zIGl0IGNsb3NlZDsgdGhlIHNwZWxsJ3MgYG9uVW5yZXNvbHZlZGAgc2F5cyBcInN0b3BcIlxuICogICAgICBhbmQgdGhpcyBtb2R1bGUgcmVhZHMgQU5ZIHN0b3AgYXMgY2xvc2VkLiBBIGJhcmUgZmlyc3QgYXJtIHN0aWxsXG4gKiAgICAgIHdhaXRzIGZvciBhIHNlc3Npb24gdG8gYXBwZWFyLiDimqAgXCJHaXZlblwiIG1lYW5zIE9OIFRIRSBDT01NQU5EIExJTkVcbiAqICAgICAgKHJldmlldyBCMSk6IGJvdW50eSBhbHNvIHJlc29sdmVzIGEgc2Vzc2lvbiBmcm9tXG4gKiAgICAgIGAkQk9VTlRZX1NFU1NJT05fS0VZYCwgYCRCT1VOVFlfU0VTU0lPTmAgb3IgYSBgLmJvdW50eS1zZXNzaW9uYCBmaWxlLFxuICogICAgICB3aGljaCBldmVyeSBhbnRoaWxsIHNlYXQgaGFzLCBhbmQgYSBzZWF0J3MgZmlyc3QgYXJtIG11c3Qgd2FpdC4gQVxuICogICAgICBrZXllZCBib3VudHkgYm9hcmQgY29tZXMgYmFjayBieSBpdHMga2V5IChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKTtcbiAqICAgICAgcmVzdG9yaW5nIGl0IGJ5IGlkIHNwYXducyBhbiB1bmtleWVkIHN0cmF5LlxuICogRDIgwrcgQSBCT09LTUFSSyBDQU5OT1QgT1VUTElWRSBJVFMgTE9HLiBBIHJlc3RvcmVkIGRhZW1vbidzIGlkcyBiZWdpbiBhdCAxLFxuICogICAgICBhbmQgdGhlIGtpdCdzIGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duIGJ5IHJlcGxheWluZyB3aG9sZTtcbiAqICAgICAgdGhlIHRhaWwga2VwdCBpdHMgaGlnaGVyIGN1cnNvciwgc28gZXZlcnkgcmUtYXJtIHJlcGxheWVkIHRoZSBuZXcgbG9nXG4gKiAgICAgIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wLiBUd28gaGFsdmVzOlxuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVGhyZWUgcGFydHM6XG4gKiAgICAgICAgKGEpIHRoZSBuZXQg4oCUIGB0YWlsRXZlbnRzYCcgYHJlc3RhcnRPblJlcGxheWAsIG9uIGZvciBldmVyeSBzcGVsbCxcbiAqICAgICAgICAgICAgcmVhZHMgYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yIGFzIGEgcmVzdGFydGVkIGxvZ1xuICogICAgICAgICAgICBhbmQgcmVzZXRzIHRoZSBjdXJzb3I7XG4gKiAgICAgICAgKGIpIHRoZSBydWxlIOKAlCB0aGUgYHRhaWwuY2xvc2VkYC9gdGFpbC5sb3N0YCBoaW50LCBhbmQgZXZlcnkgc2tpbGwsXG4gKiAgICAgICAgICAgIHNheTogcnVuIHRoZSBjb21tYW5kIHRoZSBsaW5lIG5hbWVzLCB0aGVuIHRhaWwgV0lUSCBOT1xuICogICAgICAgICAgICBgLS1zaW5jZWAgKGEgcmVzdG9yZWQgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2c7IGJvdW50eSdzIHJlc3RvcmVcbiAqICAgICAgICAgICAgZXZlbiBtaW50cyBhIG5ldyBpZCk7XG4gKiAgICAgICAgKGMpIFRIRSBFUE9DSCBJTiBUSEUgQk9PS01BUksg4oCUIOKaliBBIFJFVkVSU0FMLiBUaGUgZmlyc3QgdmVyc2lvbiBvZlxuICogICAgICAgICAgICB0aGlzIGVudHJ5IGxpc3RlZCBcImNhcnJ5IHRoZSBlcG9jaCBpbiB0aGUgYm9va21hcmtcIiBhcyBub3QgdGFrZW5cbiAqICAgICAgICAgICAgKGEgbmV3IGZsYWcgb24gZWlnaHQgdmVyYnM7IGFuIGVwb2NoIHNlZW4gb25seSBvbmNlIGEgZnJhbWVcbiAqICAgICAgICAgICAgYXJyaXZlcykuIFRoZSByZXZpZXdlciB0aGVuIHNob3dlZCAoYSkncyBibGluZCBzcG90IExJVkU6IGFuIG9sZFxuICogICAgICAgICAgICBib29rbWFyayBhdCBvciBiZWxvdyB0aGUgTkVXIGxvZydzIGxlbmd0aCBtYWtlcyB0aGUgZGFlbW9uIHNlbmRcbiAqICAgICAgICAgICAgb25seSB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuXG4gKiAgICAgICAgICAgIG1lc3NhZ2UgYXQgbmV3IGlkIDIgdW5kZXIgYSBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgd2l0aCBub1xuICogICAgICAgICAgICBub3RpY2UuIFRocmVlIHBhdGhzIHJlYWNoIGl0OiBjb21pbmcgYmFjayB3aXRob3V0IGZvbGxvd2luZyAoYik7XG4gKiAgICAgICAgICAgIHRoZSBNb25pdG9yLWNhcCBmYWxsYmFjayAoXCJyZS1hcm0gZnJvbSB0aGUgbGFzdCBpZCB5b3Ugc2F3XCIpXG4gKiAgICAgICAgICAgIGFjcm9zcyBhIHJlc3RhcnQ7IGFuZCBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluLXByb2Nlc3NcbiAqICAgICAgICAgICAgKGFzdHJvbGFiZSwgb3IgbWluZC1tYXBwZXIgd2hlbiBpdHMgZGFlbW9uIGlzIGJhY2sgYmVmb3JlIHRoZVxuICogICAgICAgICAgICBsb3N0IHJ1bGUgZmlyZXMpIHdob3NlIGZpcnN0IGZyYW1lIGFmdGVyIGEgcmVzdGFydCBpcyBhbHJlYWR5XG4gKiAgICAgICAgICAgIHBhc3QgaXRzIGJvb2ttYXJrLlxuICogICAgICAgICAgICBUaGUgZml4IG5lZWRzIG5vIG5ldyBmbGFnIGFuZCBubyB3aXJlIGNoYW5nZTogdGhlIGJvb2ttYXJrIGlzXG4gKiAgICAgICAgICAgIHByaW50ZWQgYC0tc2luY2UgTkA8ZXBvY2g+YCAoYHBhcnNlQm9va21hcmtgKSwgdGhlIGNsaWVudCBzdGFydHNcbiAqICAgICAgICAgICAgd2l0aCB0aGF0IGVwb2NoIChgc2luY2VFcG9jaGApLCBhbmQgYW4gZXBvY2ggY2hhbmdlIHdob3NlIGZyYW1lXG4gKiAgICAgICAgICAgIGlzIHBhc3QgdGhlIGFza2VkIGN1cnNvciByZS1yZWFkcyB0aGUgbmV3IGxvZyBmcm9tIDAuIFRoZSBzYW1lXG4gKiAgICAgICAgICAgIHJlY29ubmVjdCBjb3ZlcnMgdGhlIGluLXByb2Nlc3MgcHJlc2VuY2UgY2FzZS5cbiAqICAgICAg4pqgIFNUQVRFRCBMSU1JVDogb25seSBkYWVtb25zIHRoYXQgc3RhbXAgYW4gZXBvY2ggZ2V0IChjKSDigJRcbiAqICAgICAgc2NyaXB0b3JpdW0sIGFzdHJvbGFiZSBhbmQgbWluZC1tYXBwZXIuIEdsYW1vdXIsIGltYWdvLCBtYWdwaWUgYW5kXG4gKiAgICAgIGJvdW50eSBzdGFtcCBub25lIChzZXNzaW9uLXNjb3BlZCBsb2dzLCBydWxlZCBzbyBpbiBEMzkvQjg7IGJvdW50eSdzXG4gKiAgICAgIHNlcnZlciBoZWFkZXIgbmFtZXMgdGhpcyByZXNpZHVlKSwgc28gZm9yIHRoZW0gdGhlIGdhcCBzdGF5cyBvcGVuIG9uXG4gKiAgICAgIHRoZSBmYWxsYmFjayBwYXRoLCAoYSkgY292ZXJzIHRoZSB3aG9sZS1yZXBsYXkgY2FzZSBhbmQgKGIpIHRoZVxuICogICAgICBjb21lLWJhY2sgcGF0aC4gQ2xvc2luZyBpdCB0aGVyZSBpcyBhIGRhZW1vbiBjaGFuZ2U6IGFuIGVwb2NoIG9uXG4gKiAgICAgIGBjcmVhdGVFdmVudExvZ2AuIEV2ZXJ5IHNwZWxsIHByaW50cyB0aGUgbmV0J3MgcmVzZXQgYXNcbiAqICAgICAgYGVwb2NoLmNoYW5nZWRgIChgXCJlcG9jaFwiOiBcInVua25vd25cImAgd2hlcmUgdGhlcmUgaXMgbm9uZSkuXG4gKiBEMyDCtyBPTkxZIEEgRlJBTUUgV0lUSCBBIExPRyBJRCBDT1VOVFMuIEdsYW1vdXIncyBhbmQgaW1hZ28ncyB0YWIgcGluZ3NcbiAqICAgICAgKGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgKSBjYXJyeSBubyBpZDogbm90IG9uIHRoZSBsb2csIHNvIGEgbGFwdG9wXG4gKiAgICAgIGxpZCBubyBsb25nZXIgd2FrZXMgYSBgLS1vbmNlYCwgYW5kIGltYWdvJ3MgZ3JlcCBubyBsb25nZXIgc2hvd3MgYVxuICogICAgICBgdGFpbC53b2tlYCB3aXRoIG5vdGhpbmcgYWJvdmUgaXQuXG4gKiBENCDCtyBBIEhVTUFOJ1MgV0FUQ0ggSEFTIE5PIFdJTkRPVy4gYGdyYXBldmluZSB0YWlsIC0taHVtYW5gIHBhc3Nlc1xuICogICAgICBgd2luZG93TXM6IDBgOyBubyBvdGhlciBzcGVsbCBoYXMgYSBodW1hbiBtb2RlLiBFdmVyeSBgdGFpbGAncyBoZWxwXG4gKiAgICAgIGNhcnJpZXMgYFdJTkRPV19IRUxQYCwgd2hpY2ggbmFtZXMgYFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wYC5cbiAqIEFsc286IGV2ZXJ5IGNvbWUtYmFjayBjb21tYW5kIGNhcnJpZXMgYC0tbm8tb3BlbmAsIHNvIHJ1bm5pbmcgaXQgb3BlbnMgbm9cbiAqIGJyb3dzZXIgdGFiLlxuICpcbiAqIOKaoCBLTk9XTiBFREdFLCBOT1QgRklYRUQgKGZvdW5kIGJ5IHRoZSByZS1yZXZpZXcpOiBhIGtleWVkIGJvdW50eSBGSVJTVCBhcm1cbiAqICAgKGFuIGFudGhpbGwgc2VhdCkgd2hvc2Ugd2luZG93IGVuZHMgYmVmb3JlIGl0cyBib2FyZCBldmVyIG9wZW5zIHByaW50cyBhXG4gKiAgIHJlLWFybSBwaW5uZWQgdG8gdGhlIGRlcml2ZWQgaWQgd2l0aCBhbiBlbXB0eSBib29rbWFya1xuICogICAoYC0tc2Vzc2lvbiBrLeKApiAtLXNpbmNlPS0xIC0tb25jZWApLiBUaGF0IHJlLWFybSBpcyBhIHJlLWFybSBieSBEMSdzIHJ1bGUsXG4gKiAgIHNvIGlmIHRoZSBib2FyZCBpcyBzdGlsbCBub3QgdXAg4oCUIHRoZSBsZWFkIG1vcmUgdGhhbiBvbmUgd2luZG93ICgyOSBtaW4pXG4gKiAgIGxhdGUg4oCUIHRoZSBzZWF0IGRvZXMgbm90IHdhaXQuIE1pbm9yOiB0aGUgbmV4dCBzdGVwIGl0IG5hbWVzXG4gKiAgIChgb3BlbiAtLXNlc3Npb24ta2V5IEtgKSBpcyB0aGUgcmlnaHQgb25lIGFueXdheS4gU2luY2UgIzk4ICgyMDI2LTA5LTI3KVxuICogICBpdCBubyBsb25nZXIgc2F5cyBgdGFpbC5jbG9zZWRgIGFib3V0IGEgYm9hcmQgdGhhdCBuZXZlciBvcGVuZWQ6IGEgbmFtZWRcbiAqICAgYC0tc2Vzc2lvbmAgd2l0aCBubyBzbmFwc2hvdCBvbiBkaXNrIGV4aXRzIGBub3RfZm91bmRgIGFmdGVyIGEgZ3JhY2UuXG4gKlxuICog4pSA4pSAIFRIRSBDT01NQU5EIE5BTUVTIE5PIFBBVEggKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSBsaW5lJ3MgYGNvbW1hbmRgIGlzIHRoZSBWRVJCIEFORCBJVFMgQVJHVU1FTlRTIE9OTFlcbiAqIChgdGFpbCAtLXNlc3Npb24gWCAtLXNpbmNlIE5ARSAtLW9uY2VgKSwgcGx1cyBgc3BlbGxgLCBhbmQgdGhlIGFnZW50IHJ1bnMgaXRcbiAqIHdpdGggSVRTIE9XTiBsYXVuY2hlciwgYGJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHNgLiBJdCB1c2VkXG4gKiB0byBiZSBydW5uYWJsZSBhcyBwcmludGVkLCBoZWFkZWQgYnkgYGJ1biA8YXJndlsxXT5gIOKAlCBhbmQgZm9yIGFuIGluc3RhbGxlZFxuICogcGx1Z2luIGBhcmd2WzFdYCBpcyBpbnNpZGUgYSBWRVJTSU9ORUQgY2FjaGUgZGlyZWN0b3J5LiBBbiB1cGdyYWRlIG1hcmtzIHRoZVxuICogb2xkIGRpcmVjdG9yeSBvcnBoYW5lZCBhbmQgZGVsZXRlcyBpdCBsYXRlciAobWVhc3VyZWQgaW5cbiAqIGBkb2NzL2l0ZW1zL3RhaWwtcmVhcm0tY29tbWFuZC1uYW1lcy1hLXZlcnNpb25lZC1wbHVnaW4tcGF0aC5tZGApLFxuICogc28gYSBsaW5lIHByaW50ZWQgYmVmb3JlIGFuIHVwZ3JhZGUgZmlyc3QgcmFuIFNUQUxFIGNvZGUgYWdhaW5zdCBhIG5ld2VyXG4gKiBkYWVtb24sIHRoZW4gZmFpbGVkIHdpdGggXCJtb2R1bGUgbm90IGZvdW5kXCIgb25jZSB0aGUgZGlyZWN0b3J5IHdhcyBnb25lLiBOb1xuICogc3RhYmxlIHBhdGggZXhpc3RzIHRvIHByaW50IGluc3RlYWQ6IHRoZSBjYWNoZSwgYCRDTEFVREVfUExVR0lOX1JPT1RgIGFuZCB0aGVcbiAqIGluc3RhbGwgcmVjb3JkIGFyZSBhbGwgdmVyc2lvbmVkLlxuICogICBUaGUgc2tpbGwncyBsYXVuY2hlciBpcyBhbHdheXMgdGhlIHZlcnNpb24gdGhlIHNlc3Npb24gbG9hZGVkLiBDb2xlJ3NcbiAqIHJlYXNvbmluZzogdGhlIHdvcnN0IGNhc2UgaXMgdGhhdCB0aGUgQ0xJIGNoYW5nZWQgYW5kIHRoZSBhZ2VudCBnZXRzIGFuXG4gKiBlcnJvciDigJQgYW5kIGlmIHRoZSB0b29scyBhcmUgZGVzaWduZWQgcmlnaHQsIHRoYXQgZXJyb3Igc2F5cyB3aGF0IHdlbnRcbiAqIHdyb25nLiBTbyB0aGUgcGFyc2VycyBhcmUgdGhlIG90aGVyIGhhbGYgb2YgdGhpcyBydWxpbmc6IGByZWFkU2luY2VgIHJlZnVzZXNcbiAqIGFueSBgLS1zaW5jZWAgZm9ybSBhIHRhaWwgZG9lcyBub3QgYWNjZXB0IHdpdGggYSB1c2FnZSBlcnJvciBOQU1JTkcgdGhlXG4gKiBmb3JtcyBpdCBkb2VzLCB0aGUgc2FtZSB3YXkgb24gYWxsIGVpZ2h0IHRhaWxzLCBpbnN0ZWFkIG9mIG1pc3BhcnNpbmcgaXQuXG4gKiAgIE5vdCB0YWtlbjogcHJpbnRpbmcgdGhlIHBhdGggQU5EIHRoZSBhcmdzIChvcHRpb24gQSBvZiB0aGUgaXRlbSDigJQgdHdvXG4gKiBjb21tYW5kcyB3aGVyZSBvbmUgaXMgd3JvbmcgYWZ0ZXIgYW4gdXBncmFkZSk7IGEgbGF1bmNoZXIgdGhhdCBub3RpY2VzIGl0IGlzXG4gKiBvcnBoYW5lZCBhbmQgcmUtZXhlY3MgYSBuZXdlciBzaWJsaW5nIChCIOKAlCBpdCBsZWFucyBvbiBhIENsYXVkZSBDb2RlXG4gKiBpbnRlcm5hbCBtYXJrZXIgYW5kIGRvZXMgbm90aGluZyBvbmNlIHRoZSBkaXJlY3RvcnkgaXMgZGVsZXRlZCk7IHZlcnNpb25cbiAqIG5lZ290aWF0aW9uLlxuICpcbiAqIOKUgOKUgCBNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFMgKENvbGUncyBydWxpbmcsIDIwMjYtMDktMjQpIOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1aWx0IG9uIGBmZWF0L21pbmQtbWFwcGVyLXF1aWV0LWhhbmRvZmZgLiBJdCBSRVZFUlNFUyB0aGUgaW1wbGVtZW50ZXInc1xuICogcnVsaW5nIG9mIGBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZmAgdGhhdCBtaW5kLW1hcHBlciBpcyBhIHByZXNlbmNlIHNwZWxsXG4gKiAoaXRzIGRhZW1vbiBjb3VudHMgYW4gb3BlbiBTU0UgdGFpbCBhcyB0aGUgYWdlbnQgcHJlc2VudCwgc28gdGhlIHdpbmRvd1xuICogYWx3YXlzIHJlLWFybWVkIE1vbml0b3IpLiBDb2xlJ3MgcmVhc29uaW5nOiBtaW5kLW1hcHBlciBzZXNzaW9ucyBhcmUgdXNlZFxuICogbGlrZSBzY3JpcHRvcml1bSdzLCBidXJzdHMgb2YgYWN0aXZpdHkgd2l0aCBicmVha3MsIGFuZCBpbiBhIGJyZWFrIHRoZSBhZ2VudFxuICogc2hvdWxkIG5vdCBiZSB3b2tlbiBldmVyeSAzMCBtaW51dGVzLiBTbyBtaW5kLW1hcHBlciB0YWtlcyB0aGUgcXVpZXQgaGFuZG9mZlxuICogdG8gYC0tb25jZWAsIHRoZSBsb3N0IGNvbWUtYmFjayAoYG9wZW4gLS1uby1vcGVuYCksIGFuZCBrZWVwcyBpdHNcbiAqIGAtLXNpbmNlIE5AZXBvY2hgIGJvb2ttYXJrLiBUaHJlZSB0aGluZ3MgaGFkIHRvIGJlIHNldHRsZWQgdG8gbWFrZSB0aGF0XG4gKiBob25lc3QsIGVhY2ggcGlubmVkIGluIGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC97dGFpbCxwcmVzZW5jZX0udGVzdC50c2BcbiAqIGFuZCBtdXRhdGlvbi1jb25maXJtZWQ6XG4gKlxuICogTTEgwrcgUFJFU0VOQ0UgTElOR0VSUyBBQ1JPU1MgVEhFIEdBUFMgKHRoZSBkYWVtb24sIGBzZXJ2ZXIudHNgXG4gKiAgICAgIGBhZGp1c3RBZ2VudHNgKS4gQSBvbmUtc2hvdCBob2xkcyBhbiBTU0UgY29ubmVjdGlvbiwgc28gaXQgQ09VTlRTIGFzXG4gKiAgICAgIHByZXNlbnQsIHdoaWNoIGlzIHRydWU6IHRoZSBhZ2VudCB3aWxsIHdha2Ugb24gdGhlIG5leHQgZXZlbnQuIFRoZSBnYXBzXG4gKiAgICAgIGFyZSB0aGUgcHJvYmxlbTogd2luZG93IOKGkiByZS1hcm0sIHF1aWV0IOKGkiBgLS1vbmNlYCwgYW5kIGFib3ZlIGFsbFxuICogICAgICBgdGFpbC53b2tlYCDihpIgdGhlIGFnZW50IGhhbmRsZXMgdGhlIGV2ZW50IOKGkiBNb25pdG9yLCB3aGljaCBsYXN0cyB0aGVcbiAqICAgICAgYWdlbnQncyB3aG9sZSB0dXJuLiBSYXcsIHRoZSBzdXJmYWNlJ3MgaGVhZGVyIGRvdCAodGhlIG9ubHkgdGhpbmdcbiAqICAgICAgcHJlc2VuY2UgZHJpdmVzIHRoZXJlLCBiZXNpZGVzIHRoZSBkYWVtb24ncyBhdXRvLWByZWNlaXZlZGAgZmxpcCBvbiBhXG4gKiAgICAgIGh1bWFuIG1lc3NhZ2UpIHJlYWQgXCJjb25uZWN0ZWQg4oCUIG5vIGFnZW50IG9uIHRoaXMgcHJvamVjdFwiIHdoaWxlIHRoZVxuICogICAgICBhZ2VudCB3YXMgd29ya2luZyB0aGUgYm9hcmQsIGFuZCBhIG1lc3NhZ2Ugc2VudCB0aGVuIGdvdCBub1xuICogICAgICBgcmVjZWl2ZWRgLiBUaGUgZGFlbW9uIGhhcyBubyBpZGxlIGNsb3NlLCBzbyBub3RoaW5nIGVsc2UgcmVhY3RzLiBOb3dcbiAqICAgICAgdGhlIGNvdW50IEhPTERTIGZvciBgTUlORF9NQVBQRVJfUFJFU0VOQ0VfTElOR0VSX01TYCAoMTUwIHMsIHRoZSBzdGFsbFxuICogICAgICB3aW5kb3cncyBiZWF0KSBhZnRlciB0aGUgbGFzdCB0YWlsIGNsb3NlczogYSB0YWlsIG9wZW5pbmcgaW5zaWRlIGl0XG4gKiAgICAgIGVtaXRzIG5vdGhpbmcsIGFuIGFnZW50LW9ubHkgd3JpdGUgKGAvYWN0aXZpdHlgLCBhbiBhZ2VudCBgL3NlbmRgKVxuICogICAgICByZXN0YXJ0cyBpdCwgYW5kIHNpbGVuY2UgcGFzdCBpdCBkcm9wcyB0aGUgY291bnQgdG8gMC5cbiAqICAgICAg4pqWIE5vdCB0YWtlbjogcmUtYXJtaW5nIE1vbml0b3IgQkVGT1JFIGhhbmRsaW5nIGEgd29rZW4gZXZlbnQgKHRoYXQgaXNcbiAqICAgICAgdGhlIHNoYXJlZCBydWxlLCB3b3JkLWZvci13b3JkIGluIGV2ZXJ5IHNwZWxsKTsgcmVmcmVzaGluZyBvbiBldmVyeVxuICogICAgICBib2FyZCB3cml0ZSAodGhlIGJyb3dzZXIgUE9TVHMgdGhlIHNhbWUgcm91dGVzLCBzbyB0aGUgaHVtYW4ncyBvd25cbiAqICAgICAgY2xpY2tzIHdvdWxkIGtlZXAgdGhlIGRvdCBsaXQpLiBDb3N0OiBhbiBhZ2VudCB0aGF0IHJlYWxseSBsZWZ0IHJlYWRzXG4gKiAgICAgIFwiaGVyZVwiIGZvciB1cCB0byAxNTAgcy5cbiAqIE0yIMK3IGBwcmVzZW5jZS5jaGFuZ2VkYCBJUyBOT1QgQ09VTlRFRCAobWluZC1tYXBwZXIncyBgY291bnRzYCkuIEl0IGlzIE9OXG4gKiAgICAgIFRIRSBMT0csIHdpdGggYW4gaWQsIGFuZCBhIHRhaWwncyBvd24gY29ubmVjdCBlbWl0cyBvbmUgb250byBpdHMgb3duXG4gKiAgICAgIHN0cmVhbSwgc28gY291bnRlZCBpdCBtYWRlIGV2ZXJ5IHdpbmRvdyBcImFjdGl2ZVwiIGFuZCB3b3VsZCB3YWtlIGV2ZXJ5XG4gKiAgICAgIGAtLW9uY2VgIG9uIGl0c2VsZi4gVGhlIGxpbmdlciByZW1vdmVzIG1vc3Qgb2YgdGhhdCBjaHVybjsgYGNvdW50c2BcbiAqICAgICAgcmVtb3ZlcyB0aGUgcmVzdCAoYSBmaXJzdCBhcm0sIGFub3RoZXIgYWdlbnQgY29taW5nIG9yIGdvaW5nKS5cbiAqIE0zIMK3IEEgREVBRCBEQUVNT04gSVMgTE9TVCwgTk9UIFVOUkVTT0xWRUQgKG1pbmQtbWFwcGVyJ3MgYHJlc29sdmVgKS4gSXRzXG4gKiAgICAgIGRpc2NvdmVyeSBwcm9iZXMgdGhlIGRhZW1vbidzIHBpZCwgc28gYSBraWxsZWQgZGFlbW9uIG1hZGUgYHJlc29sdmVgXG4gKiAgICAgIGFuc3dlciBudWxsIGFuZCBhbiB1bnJlc29sdmVkIHRhaWwgcmV0cmllcyBmb3JldmVyOiBhIGAtLW9uY2VgIHdvdWxkXG4gKiAgICAgIGhhdmUgc2xlcHQgZm9yIGdvb2QgKEQxJ3MgZGVmZWN0KS4gVGhlIHRhaWwga2VlcHMgdGhlIGxhc3QgVVJMIGl0XG4gKiAgICAgIHJlc29sdmVkLCBzbyB0aGUgZGVhZCBwb3J0IHJlZnVzZXMgYW5kIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBlbmRzIGl0XG4gKiAgICAgIHdpdGggYHRhaWwubG9zdGAg4oaSIGBvcGVuIC0tbm8tb3BlbmAsIHRoZW4gYSB0YWlsIHdpdGggbm8gYC0tc2luY2VgLlxuICogICAgICBNaW5kLW1hcHBlciBoYXMgbm8gc2Vzc2lvbiB0byBjbG9zZSwgc28gaXQgbmV2ZXIgcHJpbnRzIGB0YWlsLmNsb3NlZGAuXG4gKiAgICAgIE1lYXN1cmVkIG9uIGEgcmVhbCBga2lsbCAtOWAgdW5kZXIgYSBgLS1vbmNlYDogYHRhaWwubG9zdGAgNyBzIGxhdGVyLFxuICogICAgICBub3QgMC43NSBzLCBiZWNhdXNlIG1pbmQtbWFwcGVyJ3Mgb3duIGJhY2tvZmYgc3RhcnRzIGF0IDEgcyAoMSArIDIgKyA0KS5cbiAqICAgICAgTTHigJNNMyB3ZXJlIGRyaXZlbiBvbiBhIHJlYWwgZGFlbW9uIHdpdGggYSA0IHMgd2luZG93OiBhY3RpdmUg4oaSIHdpbmRvdyxcbiAqICAgICAgcXVpZXQg4oaSIGAtLW9uY2VgLCBhIGh1bWFuIG1lc3NhZ2Ugd29rZSBpdCwgYmFjayB0byBNb25pdG9yOyBwcmVzZW5jZVxuICogICAgICBuZXZlciBkcm9wcGVkIGFjcm9zcyB0aGUgZ2Fwcy5cbiAqXG4gKiDimpYgYC0tb25jZWAgRU5EUyBPTiBUSEUgRklSU1QgRlJBTUUsIHdpdGggbm8gZHJhaW4uIEEgYnVyc3QgYXJyaXZlcyBzcGxpdDogdGhlXG4gKiAgIGZpcnN0IGV2ZW50IG9uIHRoZSBvbmUtc2hvdCwgdGhlIHJlc3Qgb24gdGhlIE1vbml0b3IgcmUtYXJtLCB3aGljaCBsb3Nlc1xuICogICBub3RoaW5nIGJlY2F1c2Ugb2YgdGhlIGJvb2ttYXJrLiBUaGUgc3Bpa2Ugb2ZmZXJlZCBhIH4yMDAgbXMgZHJhaW4gYXMgYW5cbiAqICAgb3B0aW9uLCBub3QgYSByZXF1aXJlbWVudDsgbm90IHRha2VuLCBiZWNhdXNlIGl0IGFkZHMgYSB0aW1lciB0byB0aGVcbiAqICAgZXhpdCBwYXRoIHdob3NlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIG1ha2UgaW1wb3NzaWJsZS5cbiAqIOKaliBUSEUgTElORSdTIGBjb21tYW5kYCBJUyBDT01QTEVURSBCVVQgRk9SIFRIRSBMQVVOQ0hFUjogcGlubmVkIHRvIHRoZVxuICogICBzZXNzaW9uIHRoaXMgdGFpbCB3YXMgYm91bmQgdG8sIHdpdGggaXRzIHNjb3BlIGZsYWdzLiBUaGUgc2tpbGxzIG5hbWUgdGhlXG4gKiAgIHJ1bGUgb25jZSwgbGF1bmNoZXIgZm9ybSBpbmNsdWRlZDsgdGhlIGxpbmUgY2FycmllcyB0aGUgc3BlY2lmaWNzLlxuICpcbiAqIFMxIMK3IFdITyBDTE9TRUQgSVQgUklERVMgVEhFIExJTkUgKHNjcmlwdG9yaXVtJ3MgRW5kIHNlc3Npb24sIDIwMjYtMTAtMDEpLlxuICogICAgICBBIHNwZWxsIHdob3NlIGBjbG9zZWRgIGZyYW1lIHNheXMgd2hvIGVuZGVkIHRoZSBzZXNzaW9uIHBhc3Nlc1xuICogICAgICBgY2xvc2VkQnlgLCBhbmQgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzIGBieWAuIGBieTogXCJodW1hblwiYCBjaGFuZ2VzXG4gKiAgICAgIHRoZSBoaW50OiB0aGUgaHVtYW4gZW5kZWQgaXQgT04gUFVSUE9TRSwgc28gdGhlIGFnZW50IHN0b3BzIGFuZCBkb2VzIG5vdFxuICogICAgICByZW9wZW4gdW5sZXNzIGFza2VkIOKAlCB0aGUgd2F5IGJhY2sgaXMgc3RpbGwgbmFtZWQsIGNvbmRpdGlvbmVkIG9uIHRoYXQuXG4gKiAgICAgIFRoZSBhZ2VudCByb3V0ZXMgb24gYGJ5YCwgbmV2ZXIgb24gdGhlIGhpbnQncyBwcm9zZS5cbiAqICAgICAg4pqWIE9wdGlvbnMgbm90IHRha2VuOiBhIHNwZWxsLXNpZGUgcmV3cml0ZSBvZiB0aGUgcHJpbnRlZCBsaW5lIChhIHNlY29uZFxuICogICAgICB3cml0ZXIgb2YgdGhlIHNhbWUgbGluZSksIG9yIGEgc3BlbGwtc3VwcGxpZWQgaGludCAoZWFjaCBzcGVsbCB3b3VsZFxuICogICAgICB3b3JkIFwib24gcHVycG9zZVwiIGl0cyBvd24gd2F5KS5cbiAqL1xuaW1wb3J0IHsgdHlwZSBTc2VGcmFtZSwgdHlwZSBUYWlsT3B0aW9ucywgdGFpbEV2ZW50cyB9IGZyb20gXCIuL3RhaWxFdmVudHNcIjtcblxuLyoqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBjYXAsIHBlciB0aGUgdG9vbCdzIHNjaGVtYSAoXCJEZWFkbGluZXMgYWJvdmVcbiAqICAxODAwMDAwbXMgYXJlIGNhcHBlZCB0byAxODAwMDAwbXNcIikuIEEgaGFybmVzcyBudW1iZXI6IGlmIGl0IGNoYW5nZXMsIHRoaXNcbiAqICBjaGFuZ2VzLCBhbmQgc28gZG9lcyB0aGUgc2tpbGxzJyBgdGltZW91dF9tc2AuICovXG5leHBvcnQgY29uc3QgTU9OSVRPUl9DQVBfTVMgPSAxXzgwMF8wMDA7XG4vKiogU2VlIEE0IGluIHRoZSBoZWFkZXIgZm9yIHdoeSBhIG1pbnV0ZS4gKi9cbmV4cG9ydCBjb25zdCBXSU5ET1dfTUFSR0lOX01TID0gNjBfMDAwO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfV0lORE9XX01TID0gTU9OSVRPUl9DQVBfTVMgLSBXSU5ET1dfTUFSR0lOX01TO1xuLyoqIFRoZSBpbmplY3Rpb24gcG9pbnQgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gKHNlZSBBNCkuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0VOViA9IFwiU1BFTExCT09LX1RBSUxfV0lORE9XX01TXCI7XG4vKiogVGhlIG9uZSBzZW50ZW5jZSBldmVyeSBgdGFpbGAncyBoZWxwIGNhcnJpZXMsIHNvIGEgaHVtYW4gd2F0Y2hpbmcgaW4gYVxuICogIHRlcm1pbmFsIGZpbmRzIHRoZSBlc2NhcGUgaGF0Y2ggd2hlcmUgdGhleSBsb29rIChENCkuIFdvcmRlZCBvbmNlIGhlcmUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX0hFTFAgPVxuICBcImVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgMzAtbWludXRlIGNhcCB3aXRoIGEgbGluZSBuYW1pbmcgdGhlIG5leHQgYWN0OyBhIGh1bWFuIHdhdGNoaW5nIGEgdGVybWluYWwga2VlcHMgaXQgb3BlbiB3aXRoIFNQRUxMQk9PS19UQUlMX1dJTkRPV19NUz0wXCI7XG5cbi8qKiBDb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93IHRoYXQgbWFrZSB0aGUgZGFlbW9uIFwibG9zdFwiIChzZWUgQTIpLiBUaHJlZVxuICogIHNwYW4gYWJvdXQgMC43NSBzIHVuZGVyIHRoZSBraXQncyBkZWZhdWx0IGJhY2tvZmYgKDI1MCArIDUwMCBtcyBiZXR3ZWVuXG4gKiAgdGhlbSk6IGEgbGl2ZSBkYWVtb24gbmV2ZXIgcmVmdXNlcyBpdHMgb3duIHBvcnQsIGFuZCB0aGUgdHdvIGV4dHJhIGF0dGVtcHRzXG4gKiAgb25seSBidXkgdG9sZXJhbmNlIGZvciBhIHJlc3RhcnQgdGhhdCByZWJpbmRzIHRoZSBzYW1lIHBvcnQuICovXG5leHBvcnQgY29uc3QgTE9TVF9BRlRFUl9SRUZVU0FMUyA9IDM7XG5cbi8qKiBUaGUgd2luZG93IGxlbmd0aDogdGhlIGVudiB2YWx1ZSB3aGVuIGl0IGlzIGEgbm9uLW5lZ2F0aXZlIGludGVnZXIsIGVsc2UgdGhlXG4gKiAgZGVmYXVsdC4gYDBgIG1lYW5zIG5vIHdpbmRvdy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlV2luZG93TXMocmF3OiBzdHJpbmcgfCB1bmRlZmluZWQpOiBudW1iZXIge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3LnRyaW0oKSA9PT0gXCJcIikgcmV0dXJuIERFRkFVTFRfV0lORE9XX01TO1xuICBjb25zdCBuID0gTnVtYmVyKHJhdyk7XG4gIHJldHVybiBOdW1iZXIuaXNJbnRlZ2VyKG4pICYmIG4gPj0gMCA/IG4gOiBERUZBVUxUX1dJTkRPV19NUztcbn1cblxuZXhwb3J0IHR5cGUgVGFpbE1vZGUgPSBcIndhdGNoXCIgfCBcIm9uY2VcIjtcblxuLyoqIEhvdyBhIHRhaWwgZW5kZWQuIGB3aW5kb3dgIGlzIG91ciBvd24gZGVhZGxpbmUsIGBldmVudGAgaXMgYSBgLS1vbmNlYCdzXG4gKiAgZmlyc3QgZnJhbWUsIGBjbG9zZWRgIGlzIHRoZSBzZXNzaW9uIGVuZGluZyAoYSBgY2xvc2VkYCBmcmFtZSBvciB0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbidzIHBvaW50ZXIgdmFuaXNoaW5nKSwgYGxvc3RgIGlzIHRoZSBkYWVtb24gcmVmdXNpbmcgY29ubmVjdGlvbnMsXG4gKiAgYW5kIGBzdG9wcGVkYCBpcyBhIHNpZ25hbCwgYSBjYWxsZXIncyBhYm9ydCBvciBhIGNsb3NlZCBzdGRvdXQuICovXG5leHBvcnQgdHlwZSBUYWlsRW5kID0gXCJ3aW5kb3dcIiB8IFwiZXZlbnRcIiB8IFwiY2xvc2VkXCIgfCBcImxvc3RcIiB8IFwic3RvcHBlZFwiO1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmSW5wdXQgPSB7XG4gIC8qKiBUaGUgc3BlbGwgd2hvc2UgdGFpbCB0aGlzIGlzLCBzbyB0aGUgYWdlbnQga25vd3Mgd2hvc2UgbGF1bmNoZXIgcnVucyBpdC4gKi9cbiAgc3BlbGw6IHN0cmluZztcbiAgZW5kOiBUYWlsRW5kO1xuICAvKiogV2hvIGVuZGVkIGEgYGNsb3NlZGAgc2Vzc2lvbiwgd2hlbiBpdHMgY2xvc2luZyBmcmFtZSBzYWlkIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIExvZyBmcmFtZXMgdGhpcyBwcm9jZXNzIHdyb3RlIHRvIHN0ZG91dCAoQTMpLiAqL1xuICBldmVudHM6IG51bWJlcjtcbiAgLyoqIFRoZSBib29rbWFyazogdGhlIGhpZ2hlc3QgaWQgdGhpcyBwcm9jZXNzIGhhcyBzZWVuLiAqL1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIFRoZSBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2guICovXG4gIGVwb2NoPzogc3RyaW5nO1xuICBwcmVzZW5jZTogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZDb21tYW5kcyA9IHtcbiAgLyoqIFRoZSByZS1hcm0sIHdpdGggdGhlIGJvb2ttYXJrOyBgb25jZWAgYWRkcyBgLS1vbmNlYC4gYGVwb2NoYCBpcyB0aGVcbiAgICogIGxvZyB0aGUgYm9va21hcmsgYmVsb25ncyB0bywgd2hlbiB0aGUgZGFlbW9uIHN0YW1wcyBvbmU6IGEgc3BlbGwgd2hvc2VcbiAgICogIGAtLXNpbmNlYCBwYXJzZXMgYE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCkgcHJpbnRzIGl0LiAqL1xuICB0YWlsOiAobzogeyBzaW5jZTogbnVtYmVyOyBvbmNlOiBib29sZWFuOyBlcG9jaD86IHN0cmluZyB9KSA9PiBzdHJpbmc7XG4gIC8qKiBIb3cgdG8gY29tZSBiYWNrIGZyb20gYSBzZXNzaW9uIHRoYXQgaXMgZ29uZS4gKi9cbiAgY29tZUJhY2s6ICgpID0+IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZMaW5lID0ge1xuICB0eXBlOiBcInRhaWwud2luZG93XCIgfCBcInRhaWwucXVpZXRcIiB8IFwidGFpbC53b2tlXCIgfCBcInRhaWwuY2xvc2VkXCIgfCBcInRhaWwubG9zdFwiO1xuICAvKiogV2hvc2UgbGF1bmNoZXIgcnVucyBgY29tbWFuZGAuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGV2ZW50czogbnVtYmVyO1xuICBjdXJzb3I6IG51bWJlcjtcbiAgLyoqIGB0YWlsLmNsb3NlZGAgb25seTogd2hvIGVuZGVkIHRoZSBzZXNzaW9uLCB3aGVuIHRoZSBzcGVsbCBzYXlzIChTMSkuICovXG4gIGJ5Pzogc3RyaW5nO1xuICAvKiogYG1vbml0b3JgOiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSB3aXRoIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYC5cbiAgICogIGBiYWNrZ3JvdW5kYDogcnVuIHRoZSBsYXVuY2hlciArIGBjb21tYW5kYCBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrLlxuICAgKiAgYHN0b3BgOiBub3RoaW5nIHRvIHdhdGNoOyBgY29tbWFuZGAgaXMgaG93IHRvIGNvbWUgYmFjaywgaWYgd2FudGVkLiAqL1xuICBuZXh0OiBcIm1vbml0b3JcIiB8IFwiYmFja2dyb3VuZFwiIHwgXCJzdG9wXCI7XG4gIC8qKiBUaGUgdmVyYiBhbmQgaXRzIGFyZ3VtZW50cyBPTkxZIOKAlCBubyBsYXVuY2hlciwgbm8gcGF0aC4gVGhlIGFnZW50IHJ1bnNcbiAgICogIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzIDxjb21tYW5kPmAuICovXG4gIGNvbW1hbmQ6IHN0cmluZztcbiAgaGludDogc3RyaW5nO1xufTtcblxuLyoqIEhvdyB0aGUgYWdlbnQgcnVucyBhIHByaW50ZWQgYGNvbW1hbmRgOiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIG5ldmVyIGEgcGF0aFxuICogIHRoaXMgcHJvY2VzcyBuYW1lcyAodGhlIHJ1bGluZyBvbiB0aGUgdmVyc2lvbmVkIHBsdWdpbiBwYXRoLCBpbiB0aGUgaGVhZGVyKS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fV0lUSF9MQVVOQ0hFUiA9IFwiYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5cIjtcblxuLyoqIFRoZSBjb21lLWJhY2sgaGludCwgd2l0aCBob3cgdG8gUkVTVU1FIGFmdGVyIGNvbWluZyBiYWNrIChEMik6IGEgcmVzdG9yZWRcbiAqICBkYWVtb24gc3RhcnRzIGEgbmV3IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBtZWFucyBub3RoaW5nIHRoZXJlLiAqL1xuY29uc3QgQ09NRV9CQUNLID0gKHdoeTogc3RyaW5nLCBsZWFkID0gXCJUbyBicmluZyBpdCBiYWNrXCIpID0+XG4gIGAke3doeX0gJHtsZWFkfSwgcnVuICR7UlVOX1dJVEhfTEFVTkNIRVJ9OyB0aGVuIGFybSB0aGUgdGFpbCBhZ2FpbiB3aXRoIG5vIC0tc2luY2UsIG9uIHRoZSBzZXNzaW9uIGlkIGl0IHByaW50cyB3aGVyZSB0aGVyZSBpcyBvbmUgKGEgcmVzdGFydGVkIGRhZW1vbiBzdGFydHMgYSBuZXcgZXZlbnQgbG9nLCBzbyB0aGUgb2xkIGJvb2ttYXJrIGRvZXMgbm90IGFwcGx5KWA7XG5cbi8qKlxuICogVEhFIERFQ0lTSU9OOiBnaXZlbiBob3cgdGhlIHRhaWwgZW5kZWQsIHdoaWNoIGxpbmUgaXQgcHJpbnRzLiBQdXJlLCBzbyBldmVyeVxuICogc3RhdGUgaXMgYSBsaXRlcmFsIGNlbGwgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLiBSZXR1cm5zIG51bGwgZm9yIGBzdG9wcGVkYDpcbiAqIGEgaHVtYW4ncyBDdHJsLUMgb3IgYSBjYWxsZXIncyBhYm9ydCBpcyBub3QgYSBoYW5kb2ZmLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGFuZG9mZihzOiBIYW5kb2ZmSW5wdXQsIGNtZDogSGFuZG9mZkNvbW1hbmRzKTogSGFuZG9mZkxpbmUgfCBudWxsIHtcbiAgY29uc3QgYmFzZSA9IHsgc3BlbGw6IHMuc3BlbGwsIGV2ZW50czogcy5ldmVudHMsIGN1cnNvcjogcy5jdXJzb3IgfTtcbiAgc3dpdGNoIChzLmVuZCkge1xuICAgIGNhc2UgXCJzdG9wcGVkXCI6XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICBjYXNlIFwiY2xvc2VkXCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwuY2xvc2VkXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIC4uLihzLmJ5ID8geyBieTogcy5ieSB9IDoge30pLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6XG4gICAgICAgICAgcy5ieSA9PT0gXCJodW1hblwiXG4gICAgICAgICAgICA/IENPTUVfQkFDSyhcbiAgICAgICAgICAgICAgICBcInRoZSBodW1hbiBlbmRlZCB0aGlzIHNlc3Npb24gb24gcHVycG9zZTsgc3RvcCB3YXRjaGluZywgYW5kIGRvIG5vdCByZW9wZW4gaXQgdW5sZXNzIHRoZXkgYXNrLlwiLFxuICAgICAgICAgICAgICAgIFwiSWYgdGhleSBhc2tcIixcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgOiBDT01FX0JBQ0soXCJ0aGUgc2Vzc2lvbiBjbG9zZWQ7IHRoZXJlIGlzIG5vdGhpbmcgbGVmdCB0byB3YXRjaC5cIiksXG4gICAgICB9O1xuICAgIGNhc2UgXCJsb3N0XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwubG9zdFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcInN0b3BcIixcbiAgICAgICAgY29tbWFuZDogY21kLmNvbWVCYWNrKCksXG4gICAgICAgIGhpbnQ6IENPTUVfQkFDSyhcImxvc3QgdGhlIGRhZW1vbiAoaXQgY3Jhc2hlZCBvciB3YXMga2lsbGVkKTsgbm90aGluZyBpcyBsaXN0ZW5pbmcuXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwiZXZlbnRcIjpcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC53b2tlXCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogZmFsc2UsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgaGFuZGxlIHRoZSBldmVudCBhYm92ZSwgdGhlbiBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgIH07XG4gICAgY2FzZSBcIndpbmRvd1wiOlxuICAgICAgaWYgKHMucHJlc2VuY2UgfHwgcy5ldmVudHMgPiAwKVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgIHR5cGU6IFwidGFpbC53aW5kb3dcIixcbiAgICAgICAgICAuLi5iYXNlLFxuICAgICAgICAgIG5leHQ6IFwibW9uaXRvclwiLFxuICAgICAgICAgIGNvbW1hbmQ6IGNtZC50YWlsKHtcbiAgICAgICAgICAgIHNpbmNlOiBzLmN1cnNvcixcbiAgICAgICAgICAgIG9uY2U6IGZhbHNlLFxuICAgICAgICAgICAgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgaGludDogYHRoZSB3aW5kb3cgZW5kZWQgYmVmb3JlIE1vbml0b3IncyBjYXA7IGFybSBNb25pdG9yICh0aW1lb3V0X21zIDE4MDAwMDApIHJ1bm5pbmcgJHtSVU5fV0lUSF9MQVVOQ0hFUn1gLFxuICAgICAgICB9O1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLnF1aWV0XCIsXG4gICAgICAgIC4uLmJhc2UsXG4gICAgICAgIG5leHQ6IFwiYmFja2dyb3VuZFwiLFxuICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7IHNpbmNlOiBzLmN1cnNvciwgb25jZTogdHJ1ZSwgLi4uKHMuZXBvY2ggPyB7IGVwb2NoOiBzLmVwb2NoIH0gOiB7fSkgfSksXG4gICAgICAgIGhpbnQ6IGBub3RoaW5nIG9uIHRoZSBsb2cgdGhpcyB3aW5kb3c7IHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfSBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrIChydW5faW5fYmFja2dyb3VuZCkg4oCUIGl0IGV4aXRzIG9uIHRoZSBuZXh0IGV2ZW50YCxcbiAgICAgIH07XG4gIH1cbn1cblxuLyoqIFBPU0lYIHNpbmdsZS1xdW90ZSBhbiBhcmd1bWVudCB3aGVuIGl0IG5lZWRzIGl0LCBzbyBhIHByaW50ZWQgYGNvbW1hbmRgXG4gKiAgcnVucyBhcyBwcmludGVkIGFmdGVyIHRoZSBhZ2VudCdzIG93biBsYXVuY2hlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaGVsbFF1b3RlKGFyZzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIC9eW0EtWmEtejAtOV9AJSs9OiwuLy1dKyQvLnRlc3QoYXJnKSA/IGFyZyA6IGAnJHthcmcucmVwbGFjZUFsbChcIidcIiwgYCdcXFxcJydgKX0nYDtcbn1cblxuLyoqXG4gKiBSZWFkIGEgYC0tc2luY2VgIHZhbHVlOiBhbiBldmVudCBpZCwgb3B0aW9uYWxseSBjYXJyeWluZyB0aGUgZXBvY2ggb2YgdGhlXG4gKiBsb2cgaXQgY2FtZSBmcm9tIChgMTJAPGVwb2NoPmAsIEQyKS4gTnVsbCB3aGVuIHRoZSBpZCBpcyBub3QgYW4gaW50ZWdlci5cbiAqIEZvciB0aGUgc3BlbGxzIHdob3NlIGRhZW1vbiBzdGFtcHMgYW4gZXBvY2g7IHRoZSByZXN0IHRha2UgYSBwbGFpbiBpZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQm9va21hcmsodG9rZW46IHN0cmluZyk6IHsgc2luY2U6IG51bWJlcjsgZXBvY2g/OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBhdCA9IHRva2VuLmluZGV4T2YoXCJAXCIpO1xuICBjb25zdCBpZCA9IGF0ID09PSAtMSA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgYXQpO1xuICBjb25zdCBlcG9jaCA9IGF0ID09PSAtMSA/IFwiXCIgOiB0b2tlbi5zbGljZShhdCArIDEpO1xuICBpZiAoIS9eLT9cXGQrJC8udGVzdChpZC50cmltKCkpKSByZXR1cm4gbnVsbDtcbiAgaWYgKGF0ICE9PSAtMSAmJiBlcG9jaCA9PT0gXCJcIikgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IHNpbmNlOiBOdW1iZXIucGFyc2VJbnQoaWQsIDEwKSwgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pIH07XG59XG5cbi8qKlxuICogRXZlcnkgdGFpbCdzIGAtLXNpbmNlYCwgcmVhZCB0aGUgc2FtZSB3YXk6IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMsIG9yIGFcbiAqIHJlZnVzYWwgdGhhdCBOQU1FUyB0aGUgYWNjZXB0ZWQgZm9ybXMuIOKblCBORVZFUiBBIFNJTEVOVCBNSVNQQVJTRS4gVGhlIGZvdXJcbiAqIG5vLWVwb2NoIHNwZWxscyB1c2VkIGBwYXJzZUludGAsIHdoaWNoIHJlYWQgYW4gZXBvY2ggYm9va21hcmsgKGA0QGUxYCwgZnJvbVxuICogYSBoYW5kb2ZmIGxpbmUgYW5vdGhlciB2ZXJzaW9uIG9yIHNwZWxsIHByaW50ZWQpIGFzIGA0YCBhbmQgZHJvcHBlZCB0aGVcbiAqIHJlc3Qgd2l0aG91dCBhIHdvcmQ7IG1pbmQtbWFwcGVyIHJlYWQganVuayBhcyAwIGFuZCBhc3Ryb2xhYmUgYXMgLTEsIGJvdGggYVxuICogd2hvbGUgcmVwbGF5LiBBIHByaW50ZWQgY29tbWFuZCBvdXRsaXZlcyB0aGUgQ0xJIHRoYXQgcHJpbnRlZCBpdCAodGhlXG4gKiBsYXVuY2hlci1mcmVlIHJ1bGluZywgaW4gdGhlIGhlYWRlciksIHNvIHRoZSBwYXJzZXIgaXMgd2hlcmUgYW4gb2xkZXIgb3JcbiAqIG5ld2VyIGZvcm0gbXVzdCBzYXkgd2hhdCB3ZW50IHdyb25nLlxuICpcbiAqIGBlcG9jaGA6IHdoZXRoZXIgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgb25lIChzY3JpcHRvcml1bSwgYXN0cm9sYWJlLFxuICogbWluZC1tYXBwZXIpLiBgbWluYDogdGhlIHNtYWxsZXN0IGlkIGFjY2VwdGVkIChncmFwZXZpbmUgdGFrZXMgbm8gLTEpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFNpbmNlKFxuICB0b2tlbjogc3RyaW5nLFxuICBvOiB7IGVwb2NoOiBib29sZWFuOyBtaW4/OiBudW1iZXIgfSxcbik6IHsgb2s6IHRydWU7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCB7IG9rOiBmYWxzZTsgbWVzc2FnZTogc3RyaW5nIH0ge1xuICBjb25zdCBtaW4gPSBvLm1pbiA/PyAtMTtcbiAgY29uc3QgYiA9IHBhcnNlQm9va21hcmsodG9rZW4pO1xuICBpZiAoYiAhPT0gbnVsbCAmJiBiLnNpbmNlID49IG1pbiAmJiAoYi5lcG9jaCA9PT0gdW5kZWZpbmVkIHx8IG8uZXBvY2gpKVxuICAgIHJldHVybiB7IG9rOiB0cnVlLCBzaW5jZTogYi5zaW5jZSwgLi4uKGIuZXBvY2ggPyB7IGVwb2NoOiBiLmVwb2NoIH0gOiB7fSkgfTtcbiAgY29uc3QgaWQgPVxuICAgIG1pbiA8IDBcbiAgICAgID8gXCJhbiBldmVudCBpZCAoYW4gaW50ZWdlcjsgLS1zaW5jZT0tMSBmb3IgZXZlcnl0aGluZylcIlxuICAgICAgOiBgYW4gZXZlbnQgaWQgKGFuIGludGVnZXIsICR7bWlufSBvciBtb3JlKWA7XG4gIGNvbnN0IGZvcm1zID0gby5lcG9jaCA/IGAke2lkfSwgb3IgPGlkPkA8ZXBvY2g+IGFzIGEgaGFuZG9mZiBsaW5lIHByaW50cyBpdGAgOiBpZDtcbiAgY29uc3Qgd2h5ID1cbiAgICAhby5lcG9jaCAmJiB0b2tlbi5pbmNsdWRlcyhcIkBcIilcbiAgICAgID8gYDsgdGhpcyBzcGVsbCdzIGxvZyBzdGFtcHMgbm8gZXBvY2gsIHNvIHBhc3MgdGhlIGlkIHdpdGhvdXQgdGhlIFwiQOKAplwiIHBhcnRgXG4gICAgICA6IFwiXCI7XG4gIHJldHVybiB7XG4gICAgb2s6IGZhbHNlLFxuICAgIG1lc3NhZ2U6IGAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgYm9va21hcmsgdGhpcyB0YWlsIGFjY2VwdHMg4oCUIGdpdmUgJHtmb3Jtc30ke3doeX1gLFxuICB9O1xufVxuXG4vKiogSm9pbiBhbiBhcmd2IGludG8gb25lIHJ1bm5hYmxlIGNvbW1hbmQgbGluZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21tYW5kTGluZShhcmd2OiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZyB7XG4gIHJldHVybiBhcmd2Lm1hcChzaGVsbFF1b3RlKS5qb2luKFwiIFwiKTtcbn1cblxuLyoqIFRoZSByZS1hcm0gZm9yIGEgc3BlbGwgd2hvc2UgdGFpbCBpcyBgPHByZWZpeOKApj4gLS1zaW5jZSBOW0BlcG9jaF0gWy0tb25jZV1gLlxuICogIFBhc3MgYGVwb2NoYCBvbmx5IGZvciBhIHNwZWxsIHdob3NlIGAtLXNpbmNlYCBwYXJzZXMgaXQgKGBwYXJzZUJvb2ttYXJrYCkuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbENvbW1hbmQoXG4gIHByZWZpeDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHNpbmNlOiBudW1iZXIsXG4gIG9uY2U6IGJvb2xlYW4sXG4gIGVwb2NoPzogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgLy8g4pqgIEEgbmVnYXRpdmUgYm9va21hcmsgKG5vdGhpbmcgc2VlbiB5ZXQpIGlzIHNwZWxsZWQgYC0tc2luY2U9LTFgOiB0aGVcbiAgLy8gcGFyc2VycyByZWFkIGEgYmFyZSBgLTFgIGFmdGVyIGEgZmxhZyBhcyBhbm90aGVyIGZsYWcgYW5kIHJlZnVzZSBpdC5cbiAgY29uc3QgbWFyayA9IGVwb2NoID8gYCR7c2luY2V9QCR7ZXBvY2h9YCA6IFN0cmluZyhzaW5jZSk7XG4gIGNvbnN0IGF0ID0gc2luY2UgPCAwID8gW2AtLXNpbmNlPSR7bWFya31gXSA6IFtcIi0tc2luY2VcIiwgbWFya107XG4gIHJldHVybiBjb21tYW5kTGluZShbLi4ucHJlZml4LCAuLi5hdCwgLi4uKG9uY2UgPyBbXCItLW9uY2VcIl0gOiBbXSldKTtcbn1cblxuZXhwb3J0IHR5cGUgSGFuZG9mZk9wdGlvbnM8RXY+ID0ge1xuICAvKiogVGhlIHNwZWxsJ3MgbmFtZSwgY2FycmllZCBvbiB0aGUgbGluZSAod2hvc2UgbGF1bmNoZXIgcnVucyBpdCkuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIG1vZGU6IFRhaWxNb2RlO1xuICAvKiogQSBwcmVzZW5jZSBzcGVsbDogYWx3YXlzIGB0YWlsLndpbmRvd2AgYXQgdGhlIHdpbmRvdydzIGVuZCwgbmV2ZXIgbG9zdC4gKi9cbiAgcHJlc2VuY2U6IGJvb2xlYW47XG4gIC8qKiBEZWZhdWx0OiBgcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKWAuIGAwYCA9IG5vIHdpbmRvdy4gKi9cbiAgd2luZG93TXM/OiBudW1iZXI7XG4gIC8qKiBXaGV0aGVyIGFuIGVtaXR0ZWQgZnJhbWUgaXMgYSBMT0cgZnJhbWUgKEEzKS4gRGVmYXVsdDogZXZlcnkgb25lLiAqL1xuICBjb3VudHM/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBXaGljaCB0ZXJtaW5hbCBmcmFtZSBtZWFucyB0aGUgc2Vzc2lvbiBjbG9zZWQuIERlZmF1bHQ6IGV2ZXJ5IHRlcm1pbmFsLiAqL1xuICBpc0Nsb3NlZD86IChldjogRXYpID0+IGJvb2xlYW47XG4gIC8qKiBXaG8gdGhlIGNsb3NpbmcgZnJhbWUgc2F5cyBlbmRlZCB0aGUgc2Vzc2lvbiAoUzEpOyBjYXJyaWVkIG9uIGB0YWlsLmNsb3NlZGAuICovXG4gIGNsb3NlZEJ5PzogKGV2OiBFdikgPT4gc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBjb21tYW5kczogSGFuZG9mZkNvbW1hbmRzO1xufTtcblxuLyoqXG4gKiBSdW4gYHRhaWxFdmVudHNgIHdpdGggdGhlIGhhbmRvZmY6IHRoZSB3aW5kb3csIGAtLW9uY2VgLCB0aGUgbG9zdCBydWxlLCBhbmRcbiAqIHRoZSBmaW5hbCBsaW5lLiBSZXR1cm5zIHRoZSBleGl0IGNvZGUsIGxpa2UgYHRhaWxFdmVudHNgLCBhbmQgbmV2ZXIgZXhpdHMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsV2l0aEhhbmRvZmY8RXY+KFxuICB0YWlsOiBUYWlsT3B0aW9uczxFdj4sXG4gIGg6IEhhbmRvZmZPcHRpb25zPEV2Pixcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IHRhaWwub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCB3aW5kb3dNcyA9IGgud2luZG93TXMgPz8gcmVzb2x2ZVdpbmRvd01zKHByb2Nlc3MuZW52W1dJTkRPV19FTlZdKTtcbiAgY29uc3QgY291bnRzID0gaC5jb3VudHMgPz8gKCgpID0+IHRydWUpO1xuICBjb25zdCBlbmRPbkxvc3QgPSAhaC5wcmVzZW5jZTtcblxuICBjb25zdCBhYyA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3Qgb25DYWxsZXJBYm9ydCA9ICgpID0+IGFjLmFib3J0KCk7XG4gIHRhaWwuc2lnbmFsPy5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIGlmICh0YWlsLnNpZ25hbD8uYWJvcnRlZCkgYWMuYWJvcnQoKTtcblxuICBsZXQgZXZlbnRzID0gMDtcbiAgbGV0IGN1cnNvciA9IHRhaWwuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgdW5kZWZpbmVkID0gdGFpbC5zaW5jZUVwb2NoO1xuICBsZXQgZnJhbWVIYXNJZCA9IGZhbHNlO1xuICAvKiogQTMgKyBEMzogYSBmcmFtZSBjb3VudHMsIGFuZCB3YWtlcyBhIGAtLW9uY2VgLCBvbmx5IHdoZW4gaXQgaXMgT04gVEhFXG4gICAqICBMT0cg4oCUIGl0IGNhcnJpZXMgYSBsb2cgaWQg4oCUIGFuZCB0aGUgc3BlbGwncyBvd24gYGNvdW50c2AgYWdyZWVzLiBBIHRhYidzXG4gICAqICBpZC1sZXNzIGBjb25uZWN0ZWRgL2BkaXNjb25uZWN0ZWRgIHBpbmcgaXMgbm90IG9uIHRoZSBsb2cuICovXG4gIGNvbnN0IGlzTG9nRnJhbWUgPSAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGZyYW1lSGFzSWQgJiYgY291bnRzKGV2LCBmcmFtZSk7XG4gIGxldCBlbmQ6IFRhaWxFbmQgfCBudWxsID0gbnVsbDtcbiAgbGV0IGNsb3NlZEJ5OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIGxldCByZWZ1c2FscyA9IDA7XG5cbiAgY29uc3QgZmluaXNoID0gKGU6IFRhaWxFbmQpID0+IHtcbiAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBlO1xuICAgIGFjLmFib3J0KCk7XG4gIH07XG4gIGNvbnN0IHRpbWVyID1cbiAgICBoLm1vZGUgPT09IFwid2F0Y2hcIiAmJiB3aW5kb3dNcyA+IDAgPyBzZXRUaW1lb3V0KCgpID0+IGZpbmlzaChcIndpbmRvd1wiKSwgd2luZG93TXMpIDogbnVsbDtcblxuICB0cnkge1xuICAgIGNvbnN0IGNvZGUgPSBhd2FpdCB0YWlsRXZlbnRzPEV2Pih7XG4gICAgICAuLi50YWlsLFxuICAgICAgc2lnbmFsOiBhYy5zaWduYWwsXG4gICAgICAvLyBEMidzIG5ldC4gT24gZm9yIGV2ZXJ5IHNwZWxsOiBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3JcbiAgICAgIC8vIG1lYW5zIGEgd2hvbGUgcmVwbGF5IG9uIHRoZSBraXQncyBsb2csIGFuZCBvbiBncmFwZXZpbmUncyBkdXJhYmxlIGxvZ1xuICAgICAgLy8gaXQgaGFwcGVucyBvbmx5IHdoZW4gYC0tbGFzdGAgcmVhY2hlcyBiZWxvdyBgLS1zaW5jZWAsIHdoZXJlXG4gICAgICAvLyByZS1yZWFkaW5nIHRoZSBjdXJzb3IgZnJvbSB0aGUgZnJhbWVzIGlzIHRoZSBtb3JlIGNvcnJlY3QgYW5zd2VyLlxuICAgICAgcmVzdGFydE9uUmVwbGF5OiB0cnVlLFxuICAgICAgLy8gRDM6IHJlbWVtYmVyIHdoZXRoZXIgVEhJUyBmcmFtZSBjYXJyaWVzIGEgbG9nIGlkLiBgdGFpbEV2ZW50c2AgcmVhZHNcbiAgICAgIC8vIHRoZSBjdXJzb3Igb25jZSBwZXIgZnJhbWUsIGJlZm9yZSBgYWNjZXB0YCwgYHRlcm1pbmFsYCBhbmQgYHJlbmRlcmAuXG4gICAgICBjdXJzb3JPZjogKGV2KSA9PiB7XG4gICAgICAgIGNvbnN0IG4gPSB0YWlsLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICBmcmFtZUhhc0lkID0gdHlwZW9mIG4gPT09IFwibnVtYmVyXCIgJiYgTnVtYmVyLmlzRmluaXRlKG4pO1xuICAgICAgICByZXR1cm4gbjtcbiAgICAgIH0sXG4gICAgICBvblVucmVzb2x2ZWQ6IChzKSA9PiB7XG4gICAgICAgIGNvbnN0IHZlcmRpY3QgPSB0YWlsLm9uVW5yZXNvbHZlZD8uKHMpID8/IFwicmV0cnlcIjtcbiAgICAgICAgLy8gRDE6IGEgdGFpbCB0aGF0IGdpdmVzIHVwIG9uIGZpbmRpbmcgaXRzIHNlc3Npb24gaXMgd2F0Y2hpbmcgYVxuICAgICAgICAvLyBzZXNzaW9uIHRoYXQgaXMgZ29uZSDigJQgd2hldGhlciB0aGlzIHByb2Nlc3MgZXZlciByZWFjaGVkIGl0IChpdHNcbiAgICAgICAgLy8gcG9pbnRlciB2YW5pc2hlZCkgb3IgaXQgd2FzIHJlLWFybWVkIGF0IG9uZSB0aGF0IGNsb3NlZCBpbiB0aGUgZ2FwLlxuICAgICAgICBpZiAodmVyZGljdCA9PT0gXCJzdG9wXCIgJiYgZW5kID09PSBudWxsKSBlbmQgPSBcImNsb3NlZFwiO1xuICAgICAgICByZXR1cm4gdmVyZGljdDtcbiAgICAgIH0sXG4gICAgICByZW5kZXI6IChldiwgZnJhbWUpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5yZW5kZXIgPyB0YWlsLnJlbmRlcihldiwgZnJhbWUpIDogZnJhbWUuZGF0YTtcbiAgICAgICAgaWYgKGxpbmUgIT09IG51bGwgJiYgaXNMb2dGcmFtZShldiwgZnJhbWUpKSBldmVudHMgKz0gMTtcbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgdGVybWluYWw6IChldiwgZnJhbWUsIGFjY2VwdGVkKSA9PiB7XG4gICAgICAgIGlmICh0YWlsLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSB7XG4gICAgICAgICAgICBlbmQgPSAoaC5pc0Nsb3NlZCA/PyAoKCkgPT4gdHJ1ZSkpKGV2KSA/IFwiY2xvc2VkXCIgOiBcImV2ZW50XCI7XG4gICAgICAgICAgICBpZiAoZW5kID09PSBcImNsb3NlZFwiKSBjbG9zZWRCeSA9IGguY2xvc2VkQnk/Lihldik7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmIChoLm1vZGUgPT09IFwib25jZVwiICYmIGFjY2VwdGVkICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkge1xuICAgICAgICAgIGlmIChlbmQgPT09IG51bGwpIGVuZCA9IFwiZXZlbnRcIjtcbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICB9LFxuICAgICAgb25Db21tZW50OiAodGV4dCkgPT4ge1xuICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIHJldHVybiB0YWlsLm9uQ29tbWVudD8uKHRleHQpID8/IG51bGw7XG4gICAgICB9LFxuICAgICAgb25EaXNjb25uZWN0OiAoaW5mbykgPT4ge1xuICAgICAgICBjb25zdCBsaW5lID0gdGFpbC5vbkRpc2Nvbm5lY3Q/LihpbmZvKSA/PyBudWxsO1xuICAgICAgICBpZiAoaW5mby5jYXVzZSA9PT0gXCJjb25uZWN0LWZhaWxlZFwiKSB7XG4gICAgICAgICAgcmVmdXNhbHMgKz0gMTtcbiAgICAgICAgICBpZiAoZW5kT25Mb3N0ICYmIHJlZnVzYWxzID49IExPU1RfQUZURVJfUkVGVVNBTFMpIGZpbmlzaChcImxvc3RcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gVGhlIGRhZW1vbiBhbnN3ZXJlZCAoYSBzdGF0dXMsIG9yIGEgc3RyZWFtIHRoYXQgb3BlbmVkIGFuZCB0aGVuXG4gICAgICAgICAgLy8gZW5kZWQpOiBpdCBpcyBhbGl2ZSwgc28gdGhlIHJlZnVzYWxzIHdlcmUgbm90IGluIGEgcm93LlxuICAgICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbGluZTtcbiAgICAgIH0sXG4gICAgICBvbkVuZDogKHMpID0+IHtcbiAgICAgICAgY3Vyc29yID0gcy5jdXJzb3I7XG4gICAgICAgIGVwb2NoID0gcy5lcG9jaCA/PyB1bmRlZmluZWQ7XG4gICAgICAgIHRhaWwub25FbmQ/LihzKTtcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgY29uc3QgbGluZSA9IGhhbmRvZmYoXG4gICAgICB7XG4gICAgICAgIGVuZDogZW5kID8/IFwic3RvcHBlZFwiLFxuICAgICAgICAuLi4oY2xvc2VkQnkgPyB7IGJ5OiBjbG9zZWRCeSB9IDoge30pLFxuICAgICAgICBtb2RlOiBoLm1vZGUsXG4gICAgICAgIGV2ZW50cyxcbiAgICAgICAgY3Vyc29yLFxuICAgICAgICAuLi4oZXBvY2ggPyB7IGVwb2NoIH0gOiB7fSksXG4gICAgICAgIHByZXNlbmNlOiBoLnByZXNlbmNlLFxuICAgICAgICBzcGVsbDogaC5zcGVsbCxcbiAgICAgIH0sXG4gICAgICBoLmNvbW1hbmRzLFxuICAgICk7XG4gICAgaWYgKGxpbmUgIT09IG51bGwpIG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShsaW5lKX1cXG5gKTtcbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodGltZXIgIT09IG51bGwpIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgdGFpbC5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSBoZWFydGJlYXQgLyBpZGxlLXRpbWVvdXQgLyB0YWlsLXdhdGNoZG9nIHRyaXBsZSDigJQgdGhyZWUgbnVtYmVycyB0aGF0IGFyZVxuICogT05FIGludmFyaWFudCwgd3JpdHRlbiBvbmNlLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2AuXG4gKlxuICog4pSA4pSAIFdIWSBUSElTIE1PRFVMRSBFWElTVFMgQVQgQUxMIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFRoZSB0aHJlZSBudW1iZXJzIGFyZSBjaGFpbmVkLCBhbmQgdGhlIGNoYWluIGlzIHdoYXQgbm9ib2R5IGNvdWxkIHNlZTpcbiAqXG4gKiAgICAgc2VydmVyIGlkbGVUaW1lb3V0ICA+ICBTU0UgaGVhcnRiZWF0ICDCtyAgdGFpbCB3YXRjaGRvZyAgPiAgU1NFIGhlYXJ0YmVhdFxuICpcbiAqIC0gKipgaWRsZVRpbWVvdXRgID4gaGVhcnRiZWF0KiosIG9yIEJ1biBjbG9zZXMgYSBoZWxkIFNTRSBjb25uZWN0aW9uIGJlZm9yZVxuICogICB0aGUga2VlcGFsaXZlIHRoYXQgd2FzIHN1cHBvc2VkIHRvIHByZXNlcnZlIGl0IGV2ZXIgZmlyZXMuIE1FQVNVUkVEOiBCdW4nc1xuICogICBkZWZhdWx0IHJlcXVlc3QgYGlkbGVUaW1lb3V0YCBpcyAxMCBzIGFuZCBhIFNFUlZFUi1TRU5UIGhlYXJ0YmVhdCBkb2VzIG5vdFxuICogICByZXNldCBpdCwgc28gYSAxNSBzIGA6IGhiYCBhcnJpdmVzIGZpdmUgc2Vjb25kcyBhZnRlciB0aGUgdGhpbmcgaXQgd2FzXG4gKiAgIGtlZXBpbmcgYWxpdmUgaXMgZ29uZSDigJQgd2hpY2ggaXMgd2h5IHJhaXNpbmcgdGhlIGhlYXJ0YmVhdCBSQVRFIHdvdWxkIG5vdFxuICogICBoYXZlIGhlbHBlZC4gRm91ciBzcGVsbHMgaGFkIGhpdCB0aGlzIGFuZCByZXBhaXJlZCBpdCwgdGhyZWUgaGFkIG5vdC5cbiAqIC0gKip3YXRjaGRvZyA+IGhlYXJ0YmVhdCoqLCBvciBhIGhlYWx0aHktYnV0LXF1aWV0IHRhaWwgYWJvcnRzIGFuZCByZWNvbm5lY3RzXG4gKiAgIGZvcmV2ZXIuIE1FQVNVUkVEIG9uIGFzdHJvbGFiZTogd2l0aCBhIGhhcmQtY29kZWQgNDUgcyB3YXRjaGRvZyBhbmQgYW5cbiAqICAgZW52LXR1bmVkIGhlYXJ0YmVhdCwgcmVjb25uZWN0cyBsYW5kZWQgYXQgKzQ3LjQgcywgKzkyLjYgcyBhbmQgKzEzNy45IHNcbiAqICAgYWdhaW5zdCBhIHBlcmZlY3RseSBoZWFsdGh5IGRhZW1vbi4gSXQgd2FzIGhhcm1sZXNzIG9ubHkgYmVjYXVzZSBhIFRISVJEXG4gKiAgIGNvbnN0YW50IOKAlCBhIHByZXNlbmNlIGRlYm91bmNlIHdpdGggbm8gcmVsYXRpb25zaGlwIHRvIGVpdGhlciDigJQgaGFwcGVuZWQgdG9cbiAqICAgYWJzb3JiIHRoZSBjaHVybi5cbiAqXG4gKiDim5QgKipBTkQgVEhFIFNFQU0gSVMgVEhFIFBPSU5ULioqIFVudGlsIFBoYXNlIDFiIHRoZSB3YXRjaGRvZyBsaXZlZCBpbiBlYWNoXG4gKiBzcGVsbCdzIENMSSBhbmQgdGhlIGhlYXJ0YmVhdCBpbiBlYWNoIHNwZWxsJ3MgZGFlbW9uLCBhbmQgQk9USCBmaWxlcyBjYXJyaWVkIGFcbiAqIGNvbW1lbnQgc2F5aW5nIHRoZSBleHByZXNzaW9ucyB3ZXJlIGhhbmQtbWlycm9yZWQgYWNyb3NzIGEgYm91bmRhcnkgdGhlIENMSVxuICogY291bGQgbm90IGNyb3NzIOKAlCBpbXBvcnRpbmcgdGhlIGRhZW1vbiB3b3VsZCBoYXZlIGRyYWdnZWQgdGhlIHdob2xlIHNlcnZlclxuICogZ3JhcGggaW50byBgZGlzdC9jbGkuanNgLiBUaGlzIG1vZHVsZSBpcyB0aGUgY3Jvc3Npbmc6IGl0IGhvbGRzIG5vIHNwZWxsJ3NcbiAqIG51bWJlcnMsIG9ubHkgdGhlIGRlcml2YXRpb25zLCBhbmQgZWFjaCBzcGVsbCdzIG93biB0aW55IGBoZWFydGJlYXQudHNgXG4gKiBiZXNpZGUgaXRzIGRhZW1vbiBob2xkcyB0aGUgdmFsdWVzIHRoYXQgQk9USCBoYWx2ZXMgdGhlbiBpbXBvcnQuIEEgdmFsdWUgdGhhdFxuICogY291bGQgbm90IHByZXZpb3VzbHkgY3Jvc3MgdGhlIHNlYW0gbm93IGNyb3NzZXMgaXQuXG4gKi9cblxuLyoqIEJ1bidzIG1heGltdW0gYGlkbGVUaW1lb3V0YCwgaW4gc2Vjb25kcy4gYDBgIGlzIG5vdCBcImRpc2FibGVkXCIg4oCUIGl0IGlzIHRoZVxuICogIGRlZmF1bHQg4oCUIHNvIHRoZSB3YXkgdG8gaG9sZCBhIGNvbm5lY3Rpb24gb3BlbiBpcyB0byBhc2sgZm9yIHRoZSBtYXhpbXVtLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9JRExFX1RJTUVPVVRfU0VDID0gMjU1O1xuXG4vKiogVGhlIGhvdXNlIGRlZmF1bHQgaGVhcnRiZWF0LCBpbiBtcy4gU2l4IG9mIHRoZSBlaWdodCBkYWVtb25zIHdyaXRlIDE1IHMuICovXG5leHBvcnQgY29uc3QgREVGQVVMVF9IRUFSVEJFQVRfTVMgPSAxNV8wMDA7XG5cbi8qKiBIb3cgbWFueSBtaXNzZWQgYmVhdHMgdGhlIHRhaWwgd2F0Y2hkb2cgdG9sZXJhdGVzIGJlZm9yZSBpdCBhYm9ydHMgYW5kXG4gKiAgcmVjb25uZWN0cy4gVGhyZWUsIGV2ZXJ5d2hlcmUsIGFuZCBpdCBpcyBhIGZsb29yIG5vdCBhIHRhc3RlOiBob2xkaW5nIHRoZVxuICogIGNvbm5lY3Rpb24gb3BlbiBJUyBhIGBqb2luYCdzIHByZXNlbmNlIHNpZ25hbCwgc28gZXZlcnkgd2F0Y2hkb2cgZmlyZSBmbGFwcyBhXG4gKiAgY2FyZCBpbiBhIGh1bWFuJ3Mgdmlldy4gSXQgc3RpbGwgd2FudHMgYSB3YXRjaGRvZyDigJQgYSB3ZWRnZWQgaGFsZi1vcGVuIHNvY2tldFxuICogIHNob3dzIGEgY2FyZCBhcyBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB0aGUgd29yc2UgbGllLiAqL1xuZXhwb3J0IGNvbnN0IE1JU1NFRF9CRUFUUyA9IDM7XG5cbi8qKlxuICogVGhlIHNtYWxsZXN0IGJlYXQgdGhpcyBtb2R1bGUgd2lsbCBoYW5kIGJhY2ssIGluIG1zIOKAlCB0aGUgRkxPT1IgaGFsZiBvZiB0aGVcbiAqIGNsYW1wIHdob3NlIGNlaWxpbmcgaXMgYGlkbGVUaW1lb3V0IC8gMmAuXG4gKlxuICog4puUIElUIEVYSVNUUyBCRUNBVVNFIGBpbnRPcmAgUEFSU0VTIFdJVEggYHBhcnNlSW50YCwgQU5EIGBwYXJzZUludGAgSVMgTEVOSUVOVFxuICogV0hFUkUgSVQgTUFUVEVSUyBNT1NULiBgaW50T3JgIGZhbGxzIGJhY2sgc2FmZWx5IG9uIGV2ZXJ5dGhpbmcgdGhhdCBMT09LU1xuICogaG9zdGlsZSDigJQgYFwiXCJgLCBgXCIwXCJgLCBgXCItMVwiYCwgYFwiYWJjXCJgLCBgXCJOYU5cImAsIGBcIkluZmluaXR5XCJgIGFsbCB0YWtlIHRoZVxuICogZmFsbGJhY2sg4oCUIGFuZCB0aGVuIHJlYWRzIGBcIjFlOVwiYCwgdGhlIG1vc3QgcGxhdXNpYmxlIHNwZWxsaW5nIG9mIFwibWFrZSBpdFxuICogaHVnZVwiLCBhcyAqKjEqKi4gTUVBU1VSRUQgYXQgZ3JhcGV2aW5lJ3MgUGhhc2UgNiByZXBhaXIsIGJlZm9yZSB0aGlzIGZsb29yOlxuICogYEdSQVBFVklORV9IRUFSVEJFQVRfTVM9MWU5YCBwdXQgfjUyOCBrZWVwYWxpdmUgY29tbWVudHMgaW50byBldmVyeSBvcGVuIFNTRVxuICogY2xpZW50IGluIDUyOCBtcy4gYFwiMy45XCJgIGdpdmVzIDMgbXMgYW5kIGBcIjVhYmNcImAgZ2l2ZXMgNSBtcyB0aGUgc2FtZSB3YXkuXG4gKiBBIGtub2Igd2hvc2UgZmFzdGVzdCBzZXR0aW5nIGlzIHNwZWxsZWQgbGlrZSBpdHMgc2xvd2VzdCBpcyBhIGZsb29kLlxuICpcbiAqIOKaoCAqKlRIRSBGTE9PUiBJUyBIRVJFIEFORCBOT1QgSU4gYGludE9yYCDigJQgdGhhdCBpcyB0aGUgcnVsaW5nLCBub3QgYW5cbiAqIGFjY2lkZW50IG9mIHdoZXJlIGl0IHdhcyBlYXN5IHRvIHdyaXRlKiogKEQ3NikuIGBpbnRPcmAgaXMgdGhlIGdlbmVyYWwgcGFyc2VyXG4gKiBiZWhpbmQgZXZlcnkgZW52IGtub2IgaW4gdGhlIGtpdDsgdGhlcmUgaXMgbm8gc2luZ2xlIHJvc3Rlci1jb3JyZWN0IG1pbmltdW1cbiAqIGZvciBcImEgcG9zaXRpdmUgaW50ZWdlclwiLCBhbmQgdGlnaHRlbmluZyBpdHMgUEFSU0UgKHJlamVjdGluZyBgMWU5YCBvdXRyaWdodClcbiAqIHdvdWxkIGNoYW5nZSB3aGF0IGV2ZXJ5IG90aGVyIGtub2IgYWNjZXB0cywgc2lsZW50bHksIGZvciB2YWx1ZXMgbm9ib2R5IGhhc1xuICogYXVkaXRlZC4gYGhlYXJ0YmVhdE1zYCBhbHJlYWR5IG93bnMgb25lIGVuZCBvZiB0aGlzIGludmFyaWFudCwgYW5kIDUwMCB3YXNcbiAqIGFscmVhZHkgd3JpdHRlbiBpbnRvIGl0IGFzIHRoZSBzbWFsbGVzdCBjZWlsaW5nIGl0IHdvdWxkIGNvbXB1dGUuIFRoZSBmbG9vclxuICogYmVsb25ncyBiZXNpZGUgdGhlIGNlaWxpbmcsIHdoZXJlIHRoZSBxdWFudGl0eSBpcyBrbm93bi5cbiAqL1xuZXhwb3J0IGNvbnN0IE1JTl9IRUFSVEJFQVRfTVMgPSA1MDA7XG5cbi8qKiBQYXJzZSBhIHBvc2l0aXZlIGludGVnZXIgZnJvbSBhbiBlbnYgdmFsdWUsIGZhbGxpbmcgYmFjayBvbiBhbnl0aGluZyB0aGF0IGlzXG4gKiAgYWJzZW50LCBlbXB0eSwgbm9uLW51bWVyaWMgb3Igbm9uLXBvc2l0aXZlLiDimqAgYHBhcnNlSW50YCBzZW1hbnRpY3M6IGBcIjFlOVwiYFxuICogIGlzIDEgYW5kIGBcIjVhYmNcImAgaXMgNS4gQW55IGNhbGxlciB3aXRoIGEga25vd24gc2FmZSBtaW5pbXVtIG11c3QgY2xhbXAg4oCUXG4gKiAgc2VlIGBNSU5fSEVBUlRCRUFUX01TYC4gKi9cbmZ1bmN0aW9uIGludE9yKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlci5wYXJzZUludChyYXcgPz8gXCJcIiwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pICYmIG4gPiAwID8gbiA6IGZhbGxiYWNrO1xufVxuXG4vKiogVGhlIHNlcnZlcidzIGBpZGxlVGltZW91dGAsIGluIFNFQ09ORFMsIGNsYW1wZWQgdG8gd2hhdCBCdW4gYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpZGxlVGltZW91dFNlYyhyYXc/OiBzdHJpbmcgfCB1bmRlZmluZWQsIGZhbGxiYWNrID0gTUFYX0lETEVfVElNRU9VVF9TRUMpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoMSwgTWF0aC5taW4oTUFYX0lETEVfVElNRU9VVF9TRUMsIGludE9yKHJhdywgZmFsbGJhY2spKSk7XG59XG5cbi8qKlxuICogVGhlIFNTRSBoZWFydGJlYXQsIGluIG1zLCBDTEFNUEVEIEFUIEJPVEggRU5EUzogbmV2ZXIgYWJvdmUgaGFsZiB0aGUgaWRsZVxuICogdGltZW91dCwgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgLlxuICpcbiAqIFRoZSBjZWlsaW5nIGlzIGFzdHJvbGFiZSdzLCBhbmQgdGhlIGNlbnN1cyBuYW1lZCBpdCBjb252ZXJnZW5jZSB0YXJnZXQgIzQ6XG4gKiB0aGUgb3RoZXIgZGFlbW9ucyBoYXJkLWNvZGUgMTUgcyBhZ2FpbnN0IDI1NSBzIGFuZCB3cml0ZSB0aGUgcmVsYXRpb25zaGlwXG4gKiBvbmx5IGluIHByb3NlLCB3aGljaCBob2xkcyBhdCB0aGUgZGVmYXVsdCBhbmQgYXQgbm8gb3RoZXIgdmFsdWUuIEVuZm9yY2luZ1xuICogYGhlYXJ0YmVhdCA8PSBpZGxlVGltZW91dCAvIDJgIG1ha2VzIHRoZSBpbnZhcmlhbnQgdHJ1ZSBmb3IgQU5ZIGNvbmZpZ3VyZWRcbiAqIHBhaXIsIHdoaWNoIGlzIGV4YWN0bHkgdGhlIGludmFyaWFudCB3aG9zZSB2aW9sYXRpb24gY2F1c2VkIHRoZSBidWcgYWJvdmUuXG4gKlxuICog4pqgIFRoZSBmbG9vciBjYW5ub3QgZmlnaHQgdGhlIGNlaWxpbmc6IHRoZSBjZWlsaW5nIGV4cHJlc3Npb24gaXMgaXRzZWxmXG4gKiBgTWF0aC5tYXgoNTAwLCDigKYpYCwgc28gaXQgaXMgbmV2ZXIgYmVsb3cgYE1JTl9IRUFSVEJFQVRfTVNgIGFuZCB0aGUgdHdvXG4gKiBjbGFtcHMgY2FuIG5ldmVyIGNyb3NzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaGVhcnRiZWF0TXMoXG4gIHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBpZGxlU2VjOiBudW1iZXIsXG4gIGZhbGxiYWNrID0gREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4pOiBudW1iZXIge1xuICBjb25zdCBjZWlsaW5nID0gTWF0aC5tYXgoTUlOX0hFQVJUQkVBVF9NUywgTWF0aC5mbG9vcigoaWRsZVNlYyAqIDEwMDApIC8gMikpO1xuICByZXR1cm4gTWF0aC5taW4oTWF0aC5tYXgoaW50T3IocmF3LCBmYWxsYmFjayksIE1JTl9IRUFSVEJFQVRfTVMpLCBjZWlsaW5nKTtcbn1cblxuLyoqIFRoZSB0YWlsLXNpZGUgd2F0Y2hkb2cgZm9yIGEgZ2l2ZW4gaGVhcnRiZWF0OiB0aHJlZSBtaXNzZWQgYmVhdHMuICovXG5leHBvcnQgZnVuY3Rpb24gdGFpbElkbGVNcyhiZWF0TXM6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBiZWF0TXMgKiBNSVNTRURfQkVBVFM7XG59XG4iLAogICAgIi8qKlxuICogc2NyaXB0b3JpdW0ncyBjb25uZWN0aW9uLXRpbWluZyBjb25zdGFudHMg4oCUIFRIRSBPTkUgQ09QWSwgaW1wb3J0ZWQgYnkgYm90aFxuICogaGFsdmVzIChgY2xpLnRzYCdzIHRhaWwgd2F0Y2hkb2csIGBzZXJ2ZXIudHNgJ3MgU1NFIGhlYXJ0YmVhdCBhbmQgaWRsZVxuICogdGltZW91dCkuIEtpdCB2ZXJkaWN0IGBoZWFydGJlYXRgOiBTVUJKRUNUIOKAlCB0aGUgc2VhbSBleGlzdHMgYmVjYXVzZSB0aGUgQ0xJXG4gKiBhbmQgdGhlIGRhZW1vbiBhcmUgdHdvIHByb2Nlc3NlcyB0aGF0IG11c3QgYWdyZWUgb24gb25lIGludmFyaWFudFxuICogKGBpZGxlVGltZW91dCA+IGhlYXJ0YmVhdGAsIGB3YXRjaGRvZyA+IGhlYXJ0YmVhdGApLCBhbmQgbmVpdGhlciBtYXkgaW1wb3J0XG4gKiB0aGUgb3RoZXIuXG4gKlxuICog4pqgIEtFRVAgSVQgQSBMRUFGLVNIQVBFRCBGSUxFLiBUaGUgbW9tZW50IHRoaXMgaW1wb3J0cyBhbnl0aGluZyBvZiB0aGVcbiAqIGRhZW1vbidzLCBgZGlzdC9jbGkuanNgIGRyYWdzIHRoZSBzZXJ2ZXIgZ3JhcGggYW5kIHRoZSBzZWFtIGNsb3Nlcy5cbiAqL1xuXG5pbXBvcnQge1xuICBERUZBVUxUX0hFQVJUQkVBVF9NUyxcbiAgTUFYX0lETEVfVElNRU9VVF9TRUMsXG4gIHRhaWxJZGxlTXMsXG59IGZyb20gXCIuLi8uLi9raXQvd2lyZS9oZWFydGJlYXQudHNcIjtcblxuLyoqIEJ1bidzIG1heGltdW06IGEgaGVsZCBTU0UgdGFpbCBtdXN0IG91dGxpdmUgQnVuJ3MgMTAgcyBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IElETEVfVElNRU9VVF9TRUMgPSBNQVhfSURMRV9USU1FT1VUX1NFQztcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0LiAqL1xuZXhwb3J0IGNvbnN0IFNTRV9IRUFSVEJFQVRfTVMgPSBERUZBVUxUX0hFQVJUQkVBVF9NUztcblxuLyoqIFRoZSB0YWlsIHdhdGNoZG9nOiB0aHJlZSBtaXNzZWQgYmVhdHMgb2YgVEhJUyBkYWVtb24ncyBoZWFydGJlYXQsIGRlcml2ZWQuICovXG5leHBvcnQgY29uc3QgVEFJTF9JRExFX01TID0gdGFpbElkbGVNcyhTU0VfSEVBUlRCRUFUX01TKTtcbiIsCiAgICAiLyoqXG4gKiBDb250ZXh0IGVudHJpZXMgb24gZGlzayDigJQgYnVpbGRpbmcgYW4gZW50cnkgZnJvbSBhIHBhdGggKEUxNSdzIG9uZSBtb2RlbCksXG4gKiBtaXJyb3JpbmcgYSBmb2xkZXIgaW50byBhIG5vZGUgdHJlZSwgYW5kIGxpc3RpbmcgYSBkaXJlY3RvcnkgZm9yIHRoZVxuICogc3VyZmFjZSdzIHBhdGggY29tcGxldGlvbiAoYGZzLmxpc3RgKS5cbiAqXG4gKiBQdXJlIG92ZXIgdGhlIGZpbGVzeXN0ZW06IG5vIGRhZW1vbiBzdGF0ZSwgc28gdGhlIHVuaXQgY2VsbHMgZHJpdmUgaXQgd2l0aCBhXG4gKiB0ZW1wIGRpcmVjdG9yeSBhbmQgbm90aGluZyBlbHNlLlxuICovXG5cbmltcG9ydCB7IHJlYWRkaXJTeW5jLCBzdGF0U3luYyB9IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiwgcmVsYXRpdmUsIHNlcCB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQ29udGV4dEVudHJ5LCBDb250ZXh0Tm9kZSwgRnNMaXN0RW50cnkgfSBmcm9tIFwiLi9wcm90b2NvbFwiO1xuXG4vKiogV2hhdCBzY3JpcHRvcml1bSBvcGVucyBhcyBhIGRvY3VtZW50LiBFdmVyeXRoaW5nIGVsc2UgaXMgbm90IHNob3duLiAqL1xuZXhwb3J0IGNvbnN0IERPQ19FWFRFTlNJT05TID0gW1wiLm1kXCIsIFwiLm1hcmtkb3duXCIsIFwiLm1keFwiLCBcIi50eHRcIl0gYXMgY29uc3Q7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0RvY05hbWUobmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGxvd2VyID0gbmFtZS50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gRE9DX0VYVEVOU0lPTlMuc29tZSgoZXh0KSA9PiBsb3dlci5lbmRzV2l0aChleHQpKTtcbn1cblxuLyoqIERpcmVjdG9yaWVzIGEgbWlycm9yIG5ldmVyIGRlc2NlbmRzIGludG8g4oCUIG5vaXNlLCBub3QgZG9jdW1lbnRzLiAqL1xuY29uc3QgU0tJUF9ESVJTID0gbmV3IFNldChbXCJub2RlX21vZHVsZXNcIiwgXCIuZ2l0XCIsIFwiZGlzdFwiLCBcIm91dFwiLCBcImNvdmVyYWdlXCJdKTtcblxuLyoqXG4gKiBUaGUgbW9zdCBub2RlcyBvbmUgbWlycm9yZWQgc2NhbiB3aWxsIGhvbGQuIEEgZm9sZGVyIGVudHJ5IHBvaW50ZWQgYXQgYSBodWdlXG4gKiB0cmVlIG11c3Qgbm90IHN0YWxsIHRoZSBkYWVtb24gb3IgZmxvb2QgZXZlcnkgc3RhdGUgYnJvYWRjYXN0OyBoaXR0aW5nIHRoZVxuICogY2FwIHNldHMgYHRydW5jYXRlZGAgb24gdGhlIGVudHJ5IHNvIHRoZSBzdXJmYWNlIGNhbiBTQVkgdGhlIGxpc3QgaXMgc2hvcnRcbiAqIHJhdGhlciB0aGFuIHJlbmRlciBhIHNob3J0IGxpc3QgYXMgYSBjb21wbGV0ZSBvbmUuXG4gKi9cbmV4cG9ydCBjb25zdCBNSVJST1JfTk9ERV9DQVAgPSAyMDAwO1xuXG5leHBvcnQgY29uc3QgdG9Qb3NpeCA9IChwOiBzdHJpbmcpID0+IHAuc3BsaXQoc2VwKS5qb2luKFwiL1wiKTtcblxuLyoqXG4gKiBNaXJyb3IgYHJvb3RgIGludG8gYSBzb3J0ZWQgbm9kZSB0cmVlOiBncm91cHMgZmlyc3QsIHRoZW4gZG9jcywgYnkgbmFtZS5cbiAqIGBoaWRkZW5gIHJlbHMgKEUyNCdzIFwiUmVtb3ZlIGZyb20gU2NyaXB0b3JpdW1cIikgYXJlIHNraXBwZWQsIGEgZm9sZGVyIHdpdGhcbiAqIGV2ZXJ5dGhpbmcgdW5kZXIgaXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FuVHJlZShcbiAgcm9vdDogc3RyaW5nLFxuICBjYXAgPSBNSVJST1JfTk9ERV9DQVAsXG4gIGhpZGRlbjogcmVhZG9ubHkgc3RyaW5nW10gPSBbXSxcbik6IHsgbm9kZXM6IENvbnRleHROb2RlW107IHRydW5jYXRlZDogYm9vbGVhbiB9IHtcbiAgbGV0IGNvdW50ID0gMDtcbiAgbGV0IHRydW5jYXRlZCA9IGZhbHNlO1xuICBjb25zdCBza2lwID0gbmV3IFNldChoaWRkZW4pO1xuICBjb25zdCB3YWxrID0gKGRpcjogc3RyaW5nKTogQ29udGV4dE5vZGVbXSA9PiB7XG4gICAgbGV0IG5hbWVzOiBzdHJpbmdbXTtcbiAgICB0cnkge1xuICAgICAgbmFtZXMgPSByZWFkZGlyU3luYyhkaXIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIFtdO1xuICAgIH1cbiAgICBjb25zdCBncm91cHM6IENvbnRleHROb2RlW10gPSBbXTtcbiAgICBjb25zdCBkb2NzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIG5hbWVzLnNvcnQoKGEsIGIpID0+IGEubG9jYWxlQ29tcGFyZShiKSkpIHtcbiAgICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICAgIGlmIChjb3VudCA+PSBjYXApIHtcbiAgICAgICAgdHJ1bmNhdGVkID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlbCA9IHRvUG9zaXgocmVsYXRpdmUocm9vdCwgYWJzKSk7XG4gICAgICBpZiAoc2tpcC5oYXMocmVsKSkgY29udGludWU7XG4gICAgICBpZiAoc3QuaXNEaXJlY3RvcnkoKSkge1xuICAgICAgICBpZiAoU0tJUF9ESVJTLmhhcyhuYW1lKSkgY29udGludWU7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGNvbnN0IGNoaWxkcmVuID0gd2FsayhhYnMpO1xuICAgICAgICAvLyBBIGZvbGRlciBob2xkaW5nIG9ubHkgbm9uLWRvY3VtZW50cyAoaW1hZ2VzLCBhc3NldHMpIGlzIG5vaXNlIGluIGFcbiAgICAgICAgLy8gZG9jcyBtaXJyb3IgYW5kIGlzIGxlZnQgb3V0LiBBIFRSVUxZIEVNUFRZIGZvbGRlciBpcyBrZXB0OiBpdCBpcyBvbmVcbiAgICAgICAgLy8gc29tZWJvZHkganVzdCBtYWRlIHRvIHB1dCBkb2N1bWVudHMgaW4gKFwiTmV3IGZvbGRlclwiLCBFMjQpLCBhbmRcbiAgICAgICAgLy8gbGVhdmluZyBpdCBvdXQgbWFkZSBpdCB2YW5pc2ggdGhlIG1vbWVudCBpdCB3YXMgY3JlYXRlZC5cbiAgICAgICAgaWYgKGNoaWxkcmVuLmxlbmd0aCA+IDAgfHwgaXNFbXB0eURpcihhYnMpKSBncm91cHMucHVzaCh7IGtpbmQ6IFwiZ3JvdXBcIiwgcmVsLCBjaGlsZHJlbiB9KTtcbiAgICAgIH0gZWxzZSBpZiAoc3QuaXNGaWxlKCkgJiYgaXNEb2NOYW1lKG5hbWUpKSB7XG4gICAgICAgIGNvdW50Kys7XG4gICAgICAgIGRvY3MucHVzaCh7IGtpbmQ6IFwiZG9jXCIsIHJlbCB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIFsuLi5ncm91cHMsIC4uLmRvY3NdO1xuICB9O1xuICBjb25zdCBub2RlcyA9IHdhbGsocm9vdCk7XG4gIHJldHVybiB7IG5vZGVzLCB0cnVuY2F0ZWQgfTtcbn1cblxuLyoqIE5vdGhpbmcgaW4gaXQgYnV0IGRvdGZpbGVzIChhIGAuRFNfU3RvcmVgIGRvZXMgbm90IG1ha2UgYSBmb2xkZXIgZnVsbCkuICovXG5mdW5jdGlvbiBpc0VtcHR5RGlyKGRpcjogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHJlYWRkaXJTeW5jKGRpcikuZXZlcnkoKG4pID0+IG4uc3RhcnRzV2l0aChcIi5cIikpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIFRoZSBub2RlIGF0IGByZWxgIGluIGEgdHJlZSwgb3IgdW5kZWZpbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbmROb2RlKG5vZGVzOiByZWFkb25seSBDb250ZXh0Tm9kZVtdLCByZWw6IHN0cmluZyk6IENvbnRleHROb2RlIHwgdW5kZWZpbmVkIHtcbiAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgaWYgKG4ucmVsID09PSByZWwpIHJldHVybiBuO1xuICAgIGlmIChuLmtpbmQgPT09IFwiZ3JvdXBcIiAmJiByZWwuc3RhcnRzV2l0aChgJHtuLnJlbH0vYCkpIHJldHVybiBmaW5kTm9kZShuLmNoaWxkcmVuLCByZWwpO1xuICB9XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmV4cG9ydCBjbGFzcyBQYXRoRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICByZWFkb25seSBjb2RlOiBcIm1pc3NpbmdcIiB8IFwibm90LWEtZG9jXCIsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKlxuICogQW4gZW50cnkgZm9yIGFuIGFic29sdXRlIHBhdGguIEEgZGlyZWN0b3J5IGlzIGBtaXJyb3JlZGA7IGEgZG9jdW1lbnQgZmlsZSBpc1xuICogYGxpc3RlZGAsIHJvb3RlZCBhdCBpdHMgcGFyZW50LCBob2xkaW5nIG9ubHkgaXRzZWxmIChFMTUpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZW50cnlGb3JQYXRoKGFiczogc3RyaW5nLCBpZDogc3RyaW5nKTogQ29udGV4dEVudHJ5IHtcbiAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gIHRyeSB7XG4gICAgc3QgPSBzdGF0U3luYyhhYnMpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke2Fic31gLCBcIm1pc3NpbmdcIik7XG4gIH1cbiAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICBjb25zdCB7IG5vZGVzLCB0cnVuY2F0ZWQgfSA9IHNjYW5UcmVlKGFicyk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGlkLFxuICAgICAgbGFiZWw6IGJhc2VuYW1lKGFicykgfHwgYWJzLFxuICAgICAgcm9vdDogYWJzLFxuICAgICAgbWVtYmVyc2hpcDogXCJtaXJyb3JlZFwiLFxuICAgICAgbm9kZXMsXG4gICAgICAuLi4odHJ1bmNhdGVkID8geyB0cnVuY2F0ZWQgfSA6IHt9KSxcbiAgICB9O1xuICB9XG4gIGlmICghaXNEb2NOYW1lKGFicykpIHtcbiAgICB0aHJvdyBuZXcgUGF0aEVycm9yKFxuICAgICAgYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zICgke0RPQ19FWFRFTlNJT05TLmpvaW4oXCIgXCIpfSk6ICR7YWJzfWAsXG4gICAgICBcIm5vdC1hLWRvY1wiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBpZCxcbiAgICBsYWJlbDogYmFzZW5hbWUoYWJzKSxcbiAgICByb290OiBkaXJuYW1lKGFicyksXG4gICAgbWVtYmVyc2hpcDogXCJsaXN0ZWRcIixcbiAgICBub2RlczogW3sga2luZDogXCJkb2NcIiwgcmVsOiBiYXNlbmFtZShhYnMpIH1dLFxuICB9O1xufVxuXG4vKiogRXZlcnkgZG9jIG5vZGUncyBhYnNvbHV0ZSBwYXRoLCBkZXB0aC1maXJzdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkb2NQYXRocyhlbnRyeTogQ29udGV4dEVudHJ5KTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhbGsgPSAobm9kZXM6IENvbnRleHROb2RlW10pID0+IHtcbiAgICBmb3IgKGNvbnN0IG4gb2Ygbm9kZXMpIHtcbiAgICAgIGlmIChuLmtpbmQgPT09IFwiZG9jXCIpIG91dC5wdXNoKGpvaW4oZW50cnkucm9vdCwgbi5yZWwpKTtcbiAgICAgIGVsc2Ugd2FsayhuLmNoaWxkcmVuKTtcbiAgICB9XG4gIH07XG4gIHdhbGsoZW50cnkubm9kZXMpO1xuICByZXR1cm4gb3V0O1xufVxuXG4vKiogV2hpY2ggZW50cnkgKGlmIGFueSkgaG9sZHMgYGFic2AsIGFuZCBhdCB3aGF0IGByZWxgLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvY2F0ZShcbiAgZW50cmllczogQ29udGV4dEVudHJ5W10sXG4gIGFiczogc3RyaW5nLFxuKTogeyBlbnRyeUlkOiBzdHJpbmc7IHJlbDogc3RyaW5nIH0gfCBudWxsIHtcbiAgZm9yIChjb25zdCBlIG9mIGVudHJpZXMpIHtcbiAgICBpZiAoZG9jUGF0aHMoZSkuaW5jbHVkZXMoYWJzKSkgcmV0dXJuIHsgZW50cnlJZDogZS5pZCwgcmVsOiB0b1Bvc2l4KHJlbGF0aXZlKGUucm9vdCwgYWJzKSkgfTtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBPbmUgZGlyZWN0b3J5LCBmb3IgdGhlIHN1cmZhY2UncyBhZGQtYnktcGF0aCBjb21wbGV0aW9uOiBzdWJkaXJlY3RvcmllcyBhbmRcbiAqIGRvY3VtZW50cyBvbmx5LCBkaXJlY3RvcmllcyBmaXJzdC4gYH5gIGlzIGV4cGFuZGVkIGJ5IHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaXN0RGlyKGRpcjogc3RyaW5nKTogRnNMaXN0RW50cnlbXSB7XG4gIGNvbnN0IG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgY29uc3Qgb3V0OiBGc0xpc3RFbnRyeVtdID0gW107XG4gIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcykge1xuICAgIGlmIChuYW1lLnN0YXJ0c1dpdGgoXCIuXCIpKSBjb250aW51ZTtcbiAgICBjb25zdCBhYnMgPSBqb2luKGRpciwgbmFtZSk7XG4gICAgbGV0IGlzRGlyID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGlzRGlyID0gc3RhdFN5bmMoYWJzKS5pc0RpcmVjdG9yeSgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpc0RpciB8fCBpc0RvY05hbWUobmFtZSkpIG91dC5wdXNoKHsgbmFtZSwgcGF0aDogYWJzLCBkaXI6IGlzRGlyIH0pO1xuICB9XG4gIHJldHVybiBvdXQuc29ydCgoYSwgYikgPT4gKGEuZGlyID09PSBiLmRpciA/IGEubmFtZS5sb2NhbGVDb21wYXJlKGIubmFtZSkgOiBhLmRpciA/IC0xIDogMSkpO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7QUFnREE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVVBO0FBQ0E7OztBQ0tBOzs7QUMxQ08sU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBOzs7QUM2QjNDLElBQU0sV0FBb0M7QUFBQSxFQUMvQyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUF1QkEsSUFBSSxpQkFBZ0M7QUFFN0IsU0FBUyxpQkFBaUIsQ0FBQyxTQUE4QjtBQUFBLEVBQzlELGlCQUFpQjtBQUFBO0FBYVosU0FBUyxhQUFhLENBQUMsTUFBZSxTQUFpQixPQUEwQjtBQUFBLEVBQ3RGLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8s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QUFJLE1BQU0sTUFBTSxRQUFRLENBQUM7QUFBQTtBQUFBLEVBRXpDO0FBQ0Y7QUFJTyxJQUFNLE1BQU0sVUFBVTtBQUFBLEVBQzNCLE1BQU07QUFBQSxFQUNOLFNBQVM7QUFBQSxFQUNULFNBQVM7QUFBQSxFQUNULFVBQVUsS0FBSyxJQUFJLENBQUMsT0FBTyxLQUFLLEdBQUcsS0FBSyxHQUFHLEVBQUUsR0FBRyxHQUFHLFlBQVksVUFBVSxFQUFFO0FBQUEsRUFHM0UsU0FBUztBQUFBLEVBQ1QsZ0JBQWdCO0FBQUEsRUFDaEIsWUFBWSxDQUFDLFNBQVM7QUFBQSxFQUN0QixTQUFTO0FBQUEsRUFDVCxZQUFZO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFPVjtBQUNKLENBQUM7QUFFTSxJQUFNLFFBQTJCLElBQUk7QUFDckMsSUFBTSxZQUErQyxPQUFPLFlBQ2pFLElBQUksS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUMxQztBQUNPLElBQU0sV0FBVyxDQUFDLFNBQTJCLElBQUksU0FBUyxJQUFJO0FBQzlELElBQU0sbUJBQXNDLElBQUk7QUFLdkQsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sSUFBSSxTQUFTLElBQUk7QUFBQSxJQUM5QixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sV0FBVyxlQUFlLENBQUM7QUFBQSxJQUNqQyxJQUFJLGFBQWE7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUM5QixNQUFNLE9BQ0osS0FBSyxPQUFPLE1BQU0sWUFBWSxVQUFVLElBQUksT0FBUSxFQUF3QixJQUFJLElBQUk7QUFBQSxJQUN0RixNQUFNLE1BQU0sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxJQUNyRCxJQUFJLFNBQVM7QUFBQSxNQUFVLE9BQU8sZUFBZSxJQUFJLFdBQVcsR0FBRyxDQUFDLEtBQUs7QUFBQSxJQUNyRSxPQUFPLGVBQWUsSUFBSSxTQUFTLFlBQVksR0FBRyxDQUFDLEtBQUs7QUFBQTtBQUFBO0FBUzVELGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkJFMEU5MjkyOTFCN0FDMjU2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
