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

//# debugId=B3D0BC051659796264756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL3NjcmlwdG9yaXVtL2JhY2tlbmQvY2xpLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvbGliL3ByaW50SnNvbi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvZXJyb3JzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9raXQvd2lyZS90YWlsSGFuZG9mZi50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvaGVhcnRiZWF0LnRzIiwgIi4uLy4uLy4uLy4uLy4uL3NyYy9zY3JpcHRvcml1bS9iYWNrZW5kL2hlYXJ0YmVhdC50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90cmVlLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWwogICAgIi8qKlxuICogc2NyaXB0b3JpdW0gQ0xJIOKAlCB0aGUgYWdlbnQncyBoYWxmLiBBIHRoaW4gY2xpZW50IG9mIHRoZSBwZXItc2Vzc2lvbiBkYWVtb25cbiAqIChgc2VydmVyLnRzYCk6IGBvcGVuYCBzcGF3bnMgb25lLCBldmVyeSBvdGhlciB2ZXJiIGZpbmRzIGl0IHRocm91Z2ggdGhlXG4gKiBzZXNzaW9uIHBvaW50ZXIgaW4gdG1wZGlyIChFMTMpIGFuZCBzcGVha3MgSFRUUC4gYHRhaWxgIHN0cmVhbXMgdGhlIGh1bWFuJ3NcbiAqIG1lc3NhZ2VzIGFzIEpTT04gbGluZXMgZm9yIE1vbml0b3IgdG8gd3JhcC5cbiAqXG4gKiDilIDilIAgVEhFIEVJR0hUIFFVRVNUSU9OUyAoc2NhZmZvbGRpbmcgcGxheWJvb2sgTjEpLCBBTlNXRVJFRCBBUyBERVNJR04g4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogMS4gQXJpdGhtZXRpYzogTk9ORSBjYXJyaWVkIGJleW9uZCB3aGF0IGlzIHRydWUgYXQgdGhlIGVtaXR0ZWQgYWRkcmVzcy5cbiAqICAgIEZyb20gYGRpc3QvY2xpLmpzYCwgYC4uYCBpcyB0aGUgc2tpbGwgZm9sZGVyLCBzbyB0aGUgZGFlbW9uIGxhdW5jaGVyIGlzXG4gKiAgICBgLi4vc2NyaXB0cy9zZXJ2ZXIudHNgICh1cCBhbmQgYmFjayBkb3duIOKAlCBuZXZlciBhIGZsYXQgc2libGluZyksIGFuZCB0aGVcbiAqICAgIGRldiBjd2QgaXMgYHNyYy9zY3JpcHRvcml1bS9gIGZpdmUgbGV2ZWxzIHVwIChDb250cmFjdCA1KSwgdXNlZCBvbmx5IHdoZW5cbiAqICAgIGRldiBtb2RlIGlzIHJlc29sdmVkLlxuICogMi4gU2VydmVzOiBuby5cbiAqIDMuIFNlY29uZCBoYWxmOiBZRVMg4oCUIHNoYXJlcyBgLi9oZWFydGJlYXQudHNgIHdpdGggdGhlIGRhZW1vbiAodGhlIHRhaWxcbiAqICAgIHdhdGNoZG9nIGlzIGRlcml2ZWQgZnJvbSB0aGUgZGFlbW9uJ3MgaGVhcnRiZWF0LCBuZXZlciBjb3BpZWQpLlxuICogNC4gTGlmZWN5Y2xlOiBzaW5nbGUtc2hvdCBwZXIgdmVyYjsgYHRhaWxgIGlzIGxvbmctcnVubmluZyBhbmQgcmV0dXJucyBpdHNcbiAqICAgIG93biBleGl0IGNvZGUuXG4gKiA1LiBgbWFpbigpYCByZXR1cm5zIHdoaWxlIHRoZSBwcm9jZXNzIG11c3QgbGl2ZT8gTk8g4oaSIE5BVFVSQUwtUkVUVVJOXG4gKiAgICBsYXVuY2hlciAoYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBydW4oKWApOiBzdGRvdXQgaXMgYSBwaXBlIHRoZSBhZ2VudFxuICogICAgcGFyc2VzLCBhbmQgYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgaXQgYXQgNjQgS2lCLiBgb3BlbmAgcmVsZWFzZXMgdGhlXG4gKiAgICBkYWVtb24ncyBzdGRvdXQgcGlwZSBzbyB0aGUgbmF0dXJhbCByZXR1cm4gaXMgbm90IGhlbGQgb3BlbiBieSBpdC5cbiAqIDYuIEV2ZW50IGlkcyBhY3Jvc3MgcmVzdGFydDogdGhlIGRhZW1vbidzIGFyZSBwZXItYm9vdCBhbmQgZXBvY2gtc3RhbXBlZDtcbiAqICAgIHRoaXMgc2lkZSByZXNldHMgaXRzIGN1cnNvciBvbiBhbiBlcG9jaCBjaGFuZ2UgYW5kIHNheXMgc28gaW4gb25lIGxpbmUuXG4gKiA3LiBBIGtpdCBzdWJqZWN0IGluIGEgZGlmZmVyZW50IHNoYXBlPyBOby5cbiAqIDguIEEga2l0IG1vZHVsZSBuYW1lcyB0aGlzIHNwZWxsIGFzIGl0cyBzb3VyY2U/IFN0cnVjdHVyYWxseSBuby5cbiAqXG4gKiDilIDilIAgRVJST1IgQ09OVFJBQ1QgKGFjYyBMMCwgYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBFdmVyeSBmYWlsdXJlIGlzIE9ORSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgc3Rkb3V0IGVtcHR5IOKAlFxuICogICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LCBzZXJ2ZXI/fSwgbWV0YTp7Y29tbWFuZH19XG4gKiAgIHVzYWdlIOKGkiAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuICogQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCwgNDA5XG4gKiBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCk7IHRoZSBkYWVtb24ncyBib2R5IHJpZGVzIHZlcmJhdGltIHVuZGVyXG4gKiBgZXJyb3Iuc2VydmVyYCwgYW5kIHdoZW4gdGhlIGRhZW1vbiBuYW1lZCB0aGUgdmFsaWQgc2V0IChhIGRvYyBzbHVnLCBhXG4gKiB2ZXJzaW9uKSB0aGF0IHNldCBpcyBBTFNPIGxpZnRlZCBpbnRvIGBjaG9pY2VzYCDigJQgQTE6IHRoZSBzZXQgaXMgaW4gaGFuZCBhdFxuICogdGhlIHJhaXNlLCBiZWNhdXNlIHRoZSBkYWVtb24gaGFuZGVkIGl0IG92ZXIuXG4gKlxuICog4puUIFRoZSBraXQgY2FycmllcyB0aGUgRU5WRUxPUEUsIG5vdCB0aGUgQ0xBU1NJRklFUjogYHJlcG9ydENsaUVycm9yYFxuICogcmV0dXJucyBudWxsIGZvciBhIG5vbi1DbGlFcnJvciwgYW5kIGBtYWluYCBiZWxvdyB0cmlhZ2VzIEVOT0VOVCAoYSBuYW1lZFxuICogZmlsZSB0aGUgY2FsbGVyIGdhdmUpIGludG8gdXNhZ2UgYW5kIGV2ZXJ5dGhpbmcgZWxzZSBpbnRvIGludGVybmFsLlxuICpcbiAqIEQ4IHJlYWNoYWJpbGl0eSwgYXVkaXRlZCBieSBjYWxsIGdyYXBoOiBldmVyeSBgZGllYCBoZXJlIGlzIHJlYWNoZWQgZnJvbSBhXG4gKiB2ZXJiIGhhbmRsZXIgKHRoZSBraXQgcmVnaXN0cnkgZGlzcGF0Y2hlcyksIG5vbmUgZnJvbSBpbnNpZGUgYSBzd2FsbG93aW5nIGBjYXRjaGAuIFRoZVxuICogc3dhbGxvd2luZyBjYXRjaGVzIChgYXBpYCdzIG5vbi1KU09OIGJvZHksIGB2ZXJzaW9uSW5mb2AsIGBwb3N0Q21kYCdzIGNsb3NlXG4gKiBFQ09OTlJFU0VUKSBjb250YWluIG5vIGRpZS1yZWFjaGFibGUgY2FsbC5cbiAqL1xuXG5pbXBvcnQgeyBzcGF3biB9IGZyb20gXCJub2RlOmNoaWxkX3Byb2Nlc3NcIjtcbmltcG9ydCB7XG4gIGNsb3NlU3luYyxcbiAgZXhpc3RzU3luYyxcbiAgbWtkaXJTeW5jLFxuICBvcGVuU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgc3RhdFN5bmMsXG4gIHVubGlua1N5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyBob21lZGlyLCB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyB0eXBlIENvbW1hbmRTcGVjLCBkZWZpbmVDbGksIHR5cGUgSW52b2NhdGlvbiB9IGZyb20gXCIuLi8uLi9raXQvY2xpL3JlZ2lzdHJ5XCI7XG5pbXBvcnQgeyBwcmludEpzb24gfSBmcm9tIFwiLi4vLi4va2l0L2xpYi9wcmludEpzb25cIjtcbmltcG9ydCB7IENsaUVycm9yLCBkaWUsIHR5cGUgRXJyRXh0cmEsIHR5cGUgRXJyS2luZCwgcmVwb3J0Q2xpRXJyb3IgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvZXJyb3JzXCI7XG5pbXBvcnQge1xuICBjb21tYW5kTGluZSxcbiAgcmVhZFNpbmNlLFxuICB0YWlsQ29tbWFuZCxcbiAgdGFpbFdpdGhIYW5kb2ZmLFxuICBXSU5ET1dfSEVMUCxcbn0gZnJvbSBcIi4uLy4uL2tpdC93aXJlL3RhaWxIYW5kb2ZmXCI7XG5pbXBvcnQgeyBUQUlMX0lETEVfTVMgfSBmcm9tIFwiLi9oZWFydGJlYXRcIjtcbmltcG9ydCB7IERPQ19FWFRFTlNJT05TLCBpc0RvY05hbWUgfSBmcm9tIFwiLi90cmVlXCI7XG5cbi8vIOKaoCBERUNMQVJFRCBGSVJTVCwgQUJPVkUgRVZFUlkgT1RIRVIgRlVOQ1RJT04sIE9OIFBVUlBPU0UuIFRoZSBgY2hvaWNlc2Bcbi8vIGNlbnN1cydzIHJhaXNlciBydWxlIChhKSAoYGdyaW1vaXJlL2xpYi9lcnJvci1zaXRlcy50c2ApIG1hdGNoZXNcbi8vIGBmdW5jdGlvbiBOQU1FKGAgbGF6aWx5IHVwIHRvIHRoZSBuZXh0IGApOiBuZXZlcmAgd2l0aGluIDYwMCBjaGFyYWN0ZXJzLCBzb1xuLy8gQU5ZIGZ1bmN0aW9uIGRlY2xhcmVkIHNob3J0bHkgYWJvdmUgdGhpcyBvbmUg4oCUIGBhcGlgLCB0aGVuIGByZXF1aXJlU2Vzc2lvbmAg4oCUXG4vLyB3YXMgcmVhZCBhcyBhIHJhaXNlciBhbmQgaXRzIGNhbGxzIGNvdW50ZWQgYXMgcmFpc2Ugc2l0ZXMgKGZvdW5kIDIwMjYtMDktMTEsXG4vLyByZXBvcnRlZCBpbiB0aGUgc2xpY2UtQSBqb3VybmFsIGFzIGFuIGluc3RydW1lbnQgZGVmZWN0LCBub3QgZml4ZWQgaGVyZSkuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIGNvbnN0IGJvZHkgPSAoZGF0YSA/PyB7fSkgYXMgeyBlcnJvcj86IHVua25vd247IGNob2ljZXM/OiB1bmtub3duOyBoaW50PzogdW5rbm93biB9O1xuICBjb25zdCBjaG9pY2VzID0gQXJyYXkuaXNBcnJheShib2R5LmNob2ljZXMpID8gYm9keS5jaG9pY2VzLm1hcChTdHJpbmcpIDogdW5kZWZpbmVkO1xuICAvLyDimqAgVGhlIGRhZW1vbidzIG93biBoaW50LCBmb3J3YXJkZWQuIEEgcmVmdXNhbCB0aGF0IGtub3dzIHdoYXQgdG8gZG8gbmV4dFxuICAvLyB1c2VkIHRvIGRyb3AgdGhhdCBrbm93bGVkZ2Ugb24gdGhlIGZsb29yIGF0IHRoaXMgbGluZS5cbiAgY29uc3QgaGludCA9IHR5cGVvZiBib2R5LmhpbnQgPT09IFwic3RyaW5nXCIgPyBib2R5LmhpbnQgOiB1bmRlZmluZWQ7XG4gIGRpZSh0eXBlb2YgYm9keS5lcnJvciA9PT0gXCJzdHJpbmdcIiA/IGJvZHkuZXJyb3IgOiBgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIGtpbmQsIHtcbiAgICAuLi4oaGludCA/IHsgaGludCB9IDoge30pLFxuICAgIC4uLihjaG9pY2VzID8geyBjaG9pY2VzIH0gOiB7fSksXG4gICAgLi4uKGRhdGEgIT09IG51bGwgJiYgZGF0YSAhPT0gdW5kZWZpbmVkID8geyBzZXJ2ZXI6IGRhdGEgfSA6IHt9KSxcbiAgfSk7XG59XG5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCJzcmNcIiwgXCJzY3JpcHRvcml1bVwiKTtcblxuLyoqIENvbnRyYWN0IDU6IGEgZGV2IGRhZW1vbiBtdXN0IHJ1biB3aXRoIGN3ZCBhdCBgc3JjL3NjcmlwdG9yaXVtL2AgKGJ1bmZpZy50b21sKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLyoqIGAkU0NSSVBUT1JJVU1fSE9NRWAsIGRlZmF1bHQgYH4vLnNjcmlwdG9yaXVtYCDigJQgdGhlIHNhbWUgcnVsZSBhcyB0aGUgZGFlbW9uJ3MuICovXG5mdW5jdGlvbiBzY3JpcHRvcml1bUhvbWUoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlc29sdmUocHJvY2Vzcy5lbnYuU0NSSVBUT1JJVU1fSE9NRSA/PyBqb2luKGhvbWVkaXIoKSwgXCIuc2NyaXB0b3JpdW1cIikpO1xufVxuXG50eXBlIFNlc3Npb25Qb2ludGVyID0geyB1cmw6IHN0cmluZzsgcG9ydDogbnVtYmVyOyBzZXNzaW9uX2lkOiBzdHJpbmc7IGhvbWU6IHN0cmluZzsgZGlyOiBzdHJpbmcgfTtcblxuLyoqXG4gKiBTZXNzaW9ucyB3aG9zZSB3b3JrIGlzIHN0aWxsIG9uIGRpc2ssIG5ld2VzdCBmaXJzdCAoRTU2KS5cbiAqXG4gKiDim5QgQSBERUFEIFNFU1NJT04gSVMgTk9UIEEgTE9TVCBPTkUsIGFuZCB0aGUgQ0xJIHVzZWQgdG8gaW1wbHkgb3RoZXJ3aXNlLiBUaGVcbiAqIG1hbmlmZXN0IGFuZCBldmVyeSB2ZXJzaW9uIGZpbGUgbGl2ZSB1bmRlciB0aGUgaG9tZSwgc28gYSBkYWVtb24gdGhhdCBoYXNcbiAqIGV4aXRlZCDigJQgdGhlIDMwLW1pbnV0ZSBpZGxlIHRpbWVvdXQsIGEgY3Jhc2gsIGEgcmVib290IOKAlCBjb3N0cyB0aGUgVVJMIGFuZFxuICogbm90aGluZyBlbHNlLiBDb2xlIGhpdCBleGFjdGx5IHRoaXMgKFwidGhhdCBsaW5rIGRvZXNuJ3Qgc2VlbSB0byBiZSBsaXZlXG4gKiBhbnltb3JlXCIpIGFuZCB0aGUgb25seSB0aGluZyB0aGUgdG9vbGluZyBzYWlkIHdhcyBcIm5vIHJ1bm5pbmcgc2NyaXB0b3JpdW1cbiAqIHNlc3Npb25cIiwgd2hpY2ggcmVhZHMgbGlrZSB0aGUgd29yayBpcyBnb25lLlxuICovXG5mdW5jdGlvbiByZXN0b3JhYmxlKCk6IHN0cmluZ1tdIHtcbiAgY29uc3QgZGlyID0gam9pbihzY3JpcHRvcml1bUhvbWUoKSwgXCJzZXNzaW9uc1wiKTtcbiAgdHJ5IHtcbiAgICByZXR1cm4gcmVhZGRpclN5bmMoZGlyLCB7IHdpdGhGaWxlVHlwZXM6IHRydWUgfSlcbiAgICAgIC5maWx0ZXIoKGUpID0+IGUuaXNEaXJlY3RvcnkoKSAmJiBleGlzdHNTeW5jKGpvaW4oZGlyLCBlLm5hbWUsIFwibWFuaWZlc3QuanNvblwiKSkpXG4gICAgICAubWFwKChlKSA9PiAoeyBpZDogZS5uYW1lLCBhdDogc3RhdFN5bmMoam9pbihkaXIsIGUubmFtZSwgXCJtYW5pZmVzdC5qc29uXCIpKS5tdGltZU1zIH0pKVxuICAgICAgLnNvcnQoKGEsIGIpID0+IGIuYXQgLSBhLmF0KVxuICAgICAgLm1hcCgoZSkgPT4gZS5pZCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG4vKiogV2hvIGVuZGVkIGEgc2F2ZWQgc2Vzc2lvbiwgcmVhZCBmcm9tIGl0cyBtYW5pZmVzdCAod2hpY2ggb3V0bGl2ZXMgdGhlIGRhZW1vbikuICovXG5mdW5jdGlvbiBlbmRlZEJ5KGlkOiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIGNvbnN0IG0gPSBKU09OLnBhcnNlKFxuICAgICAgcmVhZEZpbGVTeW5jKGpvaW4oc2NyaXB0b3JpdW1Ib21lKCksIFwic2Vzc2lvbnNcIiwgaWQsIFwibWFuaWZlc3QuanNvblwiKSwgXCJ1dGY4XCIpLFxuICAgICkgYXMgeyBlbmRlZD86IHsgYnk/OiB1bmtub3duIH0gfTtcbiAgICByZXR1cm4gdHlwZW9mIG0uZW5kZWQ/LmJ5ID09PSBcInN0cmluZ1wiID8gbS5lbmRlZC5ieSA6IHVuZGVmaW5lZDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIFdoYXQgdG8gc2F5IHdoZW4gbm8gZGFlbW9uIGFuc3dlcnMg4oCUIGFib3V0IHRoZSBzZXNzaW9uIEFTS0VEIGFib3V0XG4gKiAoYC0tc2Vzc2lvbmApLCBvciB0aGUgbmV3ZXN0IHNhdmVkIG9uZSB3aGVuIG5vbmUgd2FzIG5hbWVkLlxuICpcbiAqIOKblCBBIE5BTUVEIFNFU1NJT04gSVMgVEhFIE9ORSBUSEUgSElOVCBOQU1FUy4gVGhpcyB1c2VkIHRvIG9mZmVyIHRoZSBuZXdlc3RcbiAqIHNhdmVkIHNlc3Npb24gd2hhdGV2ZXIgd2FzIGFza2VkLCBzbyBgc2F5IC0tc2Vzc2lvbiA3ODZiY2IwOWAgYWZ0ZXIgdGhlXG4gKiBodW1hbiBlbmRlZCBpdCBzYWlkIFwiYnJpbmcgaXQgYmFjayB3aXRoOiBvcGVuIC0tcmVzdG9yZSBiM2Y0MjlkM1wiIOKAlCBhbm90aGVyXG4gKiBzZXNzaW9uLCBsaXZlIGF0IHRoZSB0aW1lICh2ZXJpZmllciwgMjAyNi0xMC0wMSkuXG4gKlxuICog4puUIEEgSFVNQU4gRU5EIElTIFJPVVRFRCBPTiBUSEUgTUFOSUZFU1QnUyBgZW5kZWQuYnlgLCBOT1QgT04gUFJPU0U6IHRoZVxuICogaHVtYW4gZW5kZWQgaXQgb24gcHVycG9zZSwgc28gdGhlIHJlZnVzYWwgc2F5cyBzbyBhbmQgZG9lcyBub3Qgb2ZmZXIgdGhlXG4gKiByZW9wZW4gYXMgdGhlIG5leHQgYWN0IChgY2hvaWNlc2Agd291bGQgaW52aXRlIGl0IHRvbywgc28gdGhlcmUgYXJlIG5vbmUpLlxuICovXG5mdW5jdGlvbiBub1Nlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IHsgbWVzc2FnZTogc3RyaW5nOyBleHRyYTogRXJyRXh0cmEgfSB7XG4gIGNvbnN0IGlkcyA9IHJlc3RvcmFibGUoKTtcbiAgY29uc3QgaWQgPSBzZXNzaW9uID8/IGlkc1swXTtcbiAgaWYgKGlkID09PSB1bmRlZmluZWQpXG4gICAgcmV0dXJuIHtcbiAgICAgIG1lc3NhZ2U6IFwibm8gcnVubmluZyBzY3JpcHRvcml1bSBzZXNzaW9uXCIsXG4gICAgICBleHRyYTogeyBoaW50OiBcIm5vIHNlc3Npb24gaGFzIGJlZW4gb3BlbmVkIGluIHRoaXMgaG9tZSB5ZXQg4oCUIHJ1bjogY2xpLnRzIG9wZW4gPHBhdGg+XCIgfSxcbiAgICB9O1xuICBpZiAoIWlkcy5pbmNsdWRlcyhpZCkpXG4gICAgcmV0dXJuIHtcbiAgICAgIG1lc3NhZ2U6IGBubyBzY3JpcHRvcml1bSBzZXNzaW9uICR7aWR9IGluIHRoaXMgaG9tZWAsXG4gICAgICBleHRyYToge1xuICAgICAgICBoaW50OlxuICAgICAgICAgIGlkcy5sZW5ndGggPT09IDBcbiAgICAgICAgICAgID8gXCJubyBzYXZlZCBzZXNzaW9ucyBpbiB0aGlzIGhvbWUg4oCUIHJ1bjogY2xpLnRzIG9wZW4gPHBhdGg+XCJcbiAgICAgICAgICAgIDogXCJwYXNzIC0tc2Vzc2lvbiBvbmUgb2YgdGhlIHNhdmVkIHNlc3Npb25zLCBvciBkcm9wIGl0IGZvciB0aGUgbW9zdCByZWNlbnRcIixcbiAgICAgICAgY2hvaWNlczogaWRzLnNsaWNlKDAsIDEwKSxcbiAgICAgIH0sXG4gICAgfTtcbiAgaWYgKGVuZGVkQnkoaWQpID09PSBcImh1bWFuXCIpXG4gICAgcmV0dXJuIHtcbiAgICAgIG1lc3NhZ2U6IGB0aGUgaHVtYW4gZW5kZWQgc2Vzc2lvbiAke2lkfWAsXG4gICAgICBleHRyYToge1xuICAgICAgICBoaW50OiBgdGhlIGh1bWFuIGVuZGVkIHRoaXMgc2Vzc2lvbiBvbiBwdXJwb3NlOyBkbyBub3QgcmVvcGVuIGl0IHVubGVzcyB0aGV5IGFzay4gSWYgdGhleSBhc2s6IGNsaS50cyBvcGVuIC0tcmVzdG9yZSAke2lkfWAsXG4gICAgICB9LFxuICAgIH07XG4gIHJldHVybiB7XG4gICAgbWVzc2FnZTogYG5vIHJ1bm5pbmcgc2NyaXB0b3JpdW0gc2Vzc2lvbiAke2lkfWAsXG4gICAgZXh0cmE6IHtcbiAgICAgIC8vIOKaoCBUaGUgQ09NTUFORCwgd2l0aCB0aGUgaWQgYWxyZWFkeSBpbiBpdC4gQSBoaW50IHRoYXQgc2F5cyBcInlvdSBjYW5cbiAgICAgIC8vIHJlc3RvcmUgYSBzZXNzaW9uXCIgbGVhdmVzIHRoZSByZWFkZXIgdG8gZmluZCB0aGUgaWQgYW5kIGd1ZXNzIHRoZSBmbGFnLlxuICAgICAgaGludDogYG5vIGRhZW1vbiBpcyBydW5uaW5nIGZvciBzZXNzaW9uICR7aWR9LCBidXQgaXRzIHdvcmsgaXMgb24gZGlzayDigJQgYnJpbmcgaXQgYmFjayB3aXRoOiBjbGkudHMgb3BlbiAtLXJlc3RvcmUgJHtpZH1gLFxuICAgICAgY2hvaWNlczogaWRzLnNsaWNlKDAsIDEwKSxcbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBqb2luKHRtcGRpcigpLCBzZXNzaW9uID8gYHNjcmlwdG9yaXVtLSR7c2Vzc2lvbn0uanNvbmAgOiBcInNjcmlwdG9yaXVtLWxhdGVzdC5qc29uXCIpO1xufVxuXG4vKiogTlVMTCBNRUFOUyBcIk5PIFNFU1NJT05cIiwgQU5EIE5PVEhJTkcgRUxTRSDigJQgRU5PRU5UIGlzIHRoZSBvbmx5IGFic2VuY2UuICovXG5mdW5jdGlvbiByZWFkU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvblBvaW50ZXIgfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gbnVsbDtcbiAgICBkaWUoYGNhbm5vdCByZWFkIHRoZSBzZXNzaW9uIHBvaW50ZXIgKCR7Y29kZSA/PyBcInVua25vd24gZXJyb3JcIn0pOiAke3BhdGh9YCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJhdykgYXMgU2Vzc2lvblBvaW50ZXI7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb25Qb2ludGVyIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIHtcbiAgICBjb25zdCB7IG1lc3NhZ2UsIGV4dHJhIH0gPSBub1Nlc3Npb24oc2Vzc2lvbik7XG4gICAgZGllKG1lc3NhZ2UsIFwibm90X2ZvdW5kXCIsIGV4dHJhKTtcbiAgfVxuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7XG4gICAgLyogbm9uLUpTT04gYm9keSAqL1xuICB9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGxldCBzdGF0dXM6IG51bWJlcjtcbiAgbGV0IGRhdGE6IHVua25vd247XG4gIHRyeSB7XG4gICAgKHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIG1zZykpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBgY2xvc2VgIHN0b3BzIHRoZSBzZXJ2ZXI7IGEgUkVTRVQgaXMgaXRzIHN1Y2Nlc3MuIEEgcmVmdXNlZCBjb25uZWN0aW9uXG4gICAgLy8gKGEgc3RhbGUgcG9pbnRlcikgaXMgYSB0cmFuc3BvcnQgZmFpbHVyZSBsaWtlIGFueSBvdGhlci5cbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGNvbnN0IGNvZGUgPSBlcnIgJiYgdHlwZW9mIGVyciA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlcnIgPyBTdHJpbmcoZXJyLmNvZGUpIDogXCJcIjtcbiAgICBpZiAobXNnLnR5cGUgPT09IFwiY2xvc2VcIiAmJiAoY29kZSA9PT0gXCJFQ09OTlJFU0VUXCIgfHwgbWVzc2FnZS5pbmNsdWRlcyhcIkVDT05OUkVTRVRcIikpKVxuICAgICAgcmV0dXJuIHsgb2s6IHRydWUgfTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFN0cmluZyhtc2cudHlwZSksIHN0YXR1cywgZGF0YSk7XG4gIHJldHVybiBkYXRhIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG4vLyDilIDilIAgdGhlIGZsYWcgcmVnaXN0cnkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gVGhlIG9wdGlvbnMgdGFibGUgdGhlIGtpdCdzIHBhcnNlciByZWFkcyAoYHNyYy9raXQvY2xpL3JlZ2lzdHJ5LnRzYCwgdGhyb3VnaFxuLy8gYGRlZmluZUNsaWAgYmVsb3cpLiBFeHBvcnRlZCBzbyBhIHRlc3QgY2FuIGJ1aWxkIHRoZSBzYW1lIHBhcnNlIHRoZSBDTEkgZG9lcy5cblxuZXhwb3J0IGNvbnN0IENMSV9PUFRJT05TID0ge1xuICBcImJvZHktZmlsZVwiOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjb250ZXh0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZG9jOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZW50cnk6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmb3I6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmcm9tOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBxdW90ZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlb3BlbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBodW5rczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludG86IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaWZlY3ljbGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsaW1pdDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgb25jZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBwYXRjaDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgXCJzdGFydC10aW1lb3V0XCI6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGF0dXM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICB0YWc6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdHlwZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIENsaUVycm9yIHtcbiAgY29uc3RydWN0b3IobWVzc2FnZTogc3RyaW5nLCBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0pIHtcbiAgICBzdXBlcihcInVzYWdlXCIsIG1lc3NhZ2UsIGV4dHJhKTtcbiAgfVxufVxuXG4vKipcbiAqIGB0YWlsIC0tc2luY2VgIGlzIGEgQk9PS01BUks6IGFuIGV2ZW50IGlkICgtMSBmb3IgXCJldmVyeXRoaW5nXCIpLCBvcHRpb25hbGx5XG4gKiB3aXRoIHRoZSBlcG9jaCBvZiB0aGUgbG9nIGl0IGNhbWUgZnJvbSAoYDEyQDxlcG9jaD5gLCBhcyB0aGUgdGFpbCdzIG93biBoYW5kb2ZmIGxpbmUgcHJpbnRzIGl0IOKAlFxuICogYGtpdC93aXJlL3RhaWxIYW5kb2ZmLnRzYCwgRDIpLiBUaGUgZXBvY2ggaXMgd2hhdCBsZXRzIHRoZSB0YWlsIG5vdGljZSBhXG4gKiByZXN0YXJ0ZWQgZGFlbW9uIHdob3NlIG5ldyBsb2cgaXMgYWxyZWFkeSBwYXN0IHRoZSBpZC4gVmVyaWZ5LXBhc3MgZml4IDlcbiAqIHN0aWxsIGhvbGRzOiBgLS1zaW5jZSBhYmNgIHVzZWQgdG8gcGFyc2UgdG8gTmFOLCB3aGljaCB0aGUgbG9nIHJlYWRzIGFzIFwiZnJvbVxuICogdGhlIHN0YXJ0XCIsIHNvIGEgdHlwbyByZXBsYXllZCB0aGUgd2hvbGUgYnVmZmVyIGF0IGV4aXQgMCDigJQgaXQgaXMgcmVmdXNlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVGFpbFNpbmNlKHRva2VuOiBzdHJpbmcpOiB7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0ge1xuICBjb25zdCByID0gcmVhZFNpbmNlKHRva2VuLCB7IGVwb2NoOiB0cnVlIH0pO1xuICBpZiAoIXIub2spIGRpZShyLm1lc3NhZ2UsIFwidXNhZ2VcIik7XG4gIHJldHVybiByLmVwb2NoID8geyBzaW5jZTogci5zaW5jZSwgZXBvY2g6IHIuZXBvY2ggfSA6IHsgc2luY2U6IHIuc2luY2UgfTtcbn1cblxuLyoqXG4gKiBgZmluZCAtLXNpbmNlYCBpcyBhIERBVEUsIHdoZXJlIGB0YWlsIC0tc2luY2VgIGlzIGFuIGV2ZW50IGlkIOKAlCB0aGUgZmxhZyBpc1xuICogc2hhcmVkLCB0aGUgbWVhbmluZyBpcyB0aGUgdmVyYidzLCBhbmQgcGRvY3Mgc3BlbGxzIHRoaXMgb25lIGAtLXNpbmNlYCB0b28uXG4gKiBBIHR5cG8gbXVzdCBub3Qgc2lsZW50bHkgd2lkZW4gdGhlIHNlYXJjaCwgc28gYSBub24tZGF0ZSBpcyBhIHVzYWdlIGVycm9yLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VTaW5jZURhdGUodG9rZW46IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHQgPSB0b2tlbi50cmltKCk7XG4gIGlmICghL15cXGR7NH0tXFxkezJ9LVxcZHsyfSQvLnRlc3QodCkgfHwgTnVtYmVyLmlzTmFOKERhdGUucGFyc2UodCkpKVxuICAgIGRpZShgZmluZCAtLXNpbmNlOiBcIiR7dG9rZW59XCIgaXMgbm90IGEgZGF0ZSDigJQgd3JpdGUgaXQgYXMgWVlZWS1NTS1ERGAsIFwidXNhZ2VcIik7XG4gIHJldHVybiB0O1xufVxuXG4vKiogYHYyYCBvciBgMmAg4oaSIDIuIEEgdmVyc2lvbiBudW1iZXIgaXMgYW4gb3BlbiBzZXQsIHNvIHRoZSByZWplY3Rpb24gY2FycmllcyBhIGhpbnQsIG5vdCBjaG9pY2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVmVyc2lvbih0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIge1xuICBjb25zdCBtID0gL152PyhcXGQrKSQvLmV4ZWModG9rZW4udHJpbSgpKTtcbiAgaWYgKCFtIHx8IE51bWJlcihtWzFdKSA8IDEpXG4gICAgZGllKGAke3doYXR9OiBcIiR7dG9rZW59XCIgaXMgbm90IGEgdmVyc2lvbiDigJQgd3JpdGUgdjEsIHYyLCDigKZgLCBcInVzYWdlXCIsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgc3RhdGUgKGVhY2ggZG9jIGxpc3RzIGl0cyB2ZXJzaW9ucylcIixcbiAgICB9KTtcbiAgcmV0dXJuIE51bWJlcihtWzFdKTtcbn1cblxuLyoqIEEgbm9uLW5lZ2F0aXZlIHdob2xlIG51bWJlciBmcm9tIGEgZmxhZywgcmVmdXNlZCByYXRoZXIgdGhhbiBjb2VyY2VkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ291bnQodG9rZW46IHN0cmluZywgd2hhdDogc3RyaW5nKTogbnVtYmVyIHtcbiAgY29uc3QgdCA9IHRva2VuLnRyaW0oKTtcbiAgaWYgKCEvXlxcZCskLy50ZXN0KHQpKSBkaWUoYCR7d2hhdH06IFwiJHt0b2tlbn1cIiBpcyBub3QgYSB3aG9sZSBudW1iZXJgLCBcInVzYWdlXCIpO1xuICByZXR1cm4gTnVtYmVyKHQpO1xufVxuXG4vKipcbiAqIEEgY29tcGFyaXNvbiBzaWRlOiBhIHZlcnNpb24sIG9yIHRoZSBmaWxlIG9mIHJlY29yZC4gYG9yaWdpbmFsYCBpcyBzcGVsbGVkXG4gKiBvdXQgcmF0aGVyIHRoYW4gb2ZmZXJlZCBhcyBgdjBgIOKAlCBhIHplcm90aCB2ZXJzaW9uIHdvdWxkIHJlYWQgbGlrZSB0aGVcbiAqIGVhcmxpZXN0IG9uZSwgYW5kIHRoZSBvcmlnaW5hbCBpcyBub3QgcGFydCBvZiB0aGUgdmVyc2lvbiBsaW5lIGF0IGFsbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU2lkZSh0b2tlbjogc3RyaW5nLCB3aGF0OiBzdHJpbmcpOiBudW1iZXIgfCBcIm9yaWdpbmFsXCIge1xuICBjb25zdCB0ID0gdG9rZW4udHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gIC8vIGBzYXZlZGAgaXMgdGhlIHdvcmQgdGhlIFNVUkZBQ0UgdXNlcyBmb3IgdGhpcyBzaWRlIChFNDMpOyBgb3JpZ2luYWxgIGFuZFxuICAvLyBgZmlsZWAga2VlcCB3b3JraW5nIGJlY2F1c2UgdGhleSBhcmUgd2hhdCBlYXJsaWVyIHNlc3Npb25zIGFuZCBub3RlcyBzYXkuXG4gIGlmICh0ID09PSBcIm9yaWdpbmFsXCIgfHwgdCA9PT0gXCJmaWxlXCIgfHwgdCA9PT0gXCJzYXZlZFwiKSByZXR1cm4gXCJvcmlnaW5hbFwiO1xuICByZXR1cm4gcGFyc2VWZXJzaW9uKHRva2VuLCB3aGF0KTtcbn1cblxuLy8g4pSA4pSAIHZlcmJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIOKblCBWRVJJRlktUEFTUyBGSVggNTogZXZlcnkgcGF0aCBpcyBjaGVja2VkIEhFUkUsIGJlZm9yZSBhbnkgZGFlbW9uIGV4aXN0cy5cbiAqIGBvcGVuIGRvYy5tZCBwaWMucG5nYCB1c2VkIHRvIHNwYXduIGEgc2Vzc2lvbiwgdGhlbiBmYWlsIG9uIHRoZSBzZWNvbmQgcGF0aFxuICogaW5zaWRlIGl0IOKAlCBsZWF2aW5nIGEgcnVubmluZyBkYWVtb24gYW5kIGEgbGl2ZSBwb2ludGVyIGJlaGluZCBhIGZhaWxlZFxuICogY29tbWFuZC4gQSBmb2xkZXIgb3IgYSBkb2N1bWVudCBpcyBhY2NlcHRlZDsgYSBtaXNzaW5nIHBhdGggaXMgbm90X2ZvdW5kLCBhXG4gKiBub24tZG9jdW1lbnQgZmlsZSBpcyB1c2FnZSB3aXRoIHRoZSBhY2NlcHRlZCBleHRlbnNpb25zIGFzIGBjaG9pY2VzYC5cbiAqL1xuZnVuY3Rpb24gY29udGV4dFBhdGhzKHBvczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IHBhdGhzID0gcG9zLm1hcCgocCkgPT4gcmVzb2x2ZShwKSk7XG4gIGZvciAoY29uc3QgcCBvZiBwYXRocykge1xuICAgIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICAgIHRyeSB7XG4gICAgICBzdCA9IHN0YXRTeW5jKHApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgZGllKGBubyBzdWNoIGZpbGUgb3IgZm9sZGVyOiAke3B9YCwgXCJub3RfZm91bmRcIik7XG4gICAgfVxuICAgIGlmICghc3QuaXNEaXJlY3RvcnkoKSAmJiAhaXNEb2NOYW1lKHApKVxuICAgICAgZGllKGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVuczogJHtwfWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBcImFkZCBhIGZvbGRlciwgb3IgYSBmaWxlIHdpdGggb25lIG9mIHRoZXNlIGV4dGVuc2lvbnNcIixcbiAgICAgICAgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSxcbiAgICAgIH0pO1xuICB9XG4gIHJldHVybiBwYXRocztcbn1cblxuLyoqXG4gKiBgLS1kb2NgIGFzIHRoZSBDTEkncyBjYWxsZXIgbWVhbnQgaXQgKHZlcmlmeS1wYXNzIGZpeCA4KTogYSB0b2tlbiB3aXRoIGEgcGF0aFxuICogc2VwYXJhdG9yLCBvciBvbmUgbmFtaW5nIGEgZmlsZSBpbiBUSElTIHByb2Nlc3MncyBjd2QsIGlzIHJlc29sdmVkIGhlcmUgdG8gYW5cbiAqIGFic29sdXRlIHBhdGgg4oCUIHRoZSBkYWVtb24ncyBjd2QgaXMgbm90IHRoZSBjYWxsZXIncy4gQW55dGhpbmcgZWxzZSAoYSBzbHVnLFxuICogYSB1bmlxdWUgZmlsZSBuYW1lKSBnb2VzIGFzIHR5cGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jQXJnKHRva2VuOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodG9rZW4uaW5jbHVkZXMoXCIvXCIpIHx8IGV4aXN0c1N5bmMocmVzb2x2ZSh0b2tlbikpKSByZXR1cm4gcmVzb2x2ZSh0b2tlbik7XG4gIHJldHVybiB0b2tlbjtcbn1cblxuLyoqIEtlZXAgdGhlIG5ld2VzdCBgTE9HX0tFRVAgLSAxYCBkYWVtb24gbG9ncywgc28gdGhlIG9uZSBhYm91dCB0byBiZSB3cml0dGVuIG1ha2VzIGBMT0dfS0VFUGAuICovXG5jb25zdCBMT0dfS0VFUCA9IDEwO1xuZnVuY3Rpb24gcHJ1bmVMb2dzKGxvZ0Rpcjogc3RyaW5nKTogdm9pZCB7XG4gIGxldCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgdHJ5IHtcbiAgICBuYW1lcyA9IHJlYWRkaXJTeW5jKGxvZ0RpcikuZmlsdGVyKChuKSA9PiAvXmRhZW1vbi1cXGQrLVxcZCtcXC5sb2ckLy50ZXN0KG4pKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGJ5QWdlID0gbmFtZXMuc29ydCgoYSwgYikgPT4gTnVtYmVyKGEuc3BsaXQoXCItXCIpWzFdKSAtIE51bWJlcihiLnNwbGl0KFwiLVwiKVsxXSkpO1xuICBmb3IgKGNvbnN0IG4gb2YgYnlBZ2Uuc2xpY2UoMCwgTWF0aC5tYXgoMCwgYnlBZ2UubGVuZ3RoIC0gKExPR19LRUVQIC0gMSkpKSkge1xuICAgIHRyeSB7XG4gICAgICB1bmxpbmtTeW5jKGpvaW4obG9nRGlyLCBuKSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvKiBhbHJlYWR5IGdvbmUgKi9cbiAgICB9XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kT3Blbihwb3M6IHN0cmluZ1tdLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcGF0aHMgPSBjb250ZXh0UGF0aHMocG9zKTtcblxuICBpZiAodHlwZW9mIGZsYWdzLnJlc3RvcmUgPT09IFwic3RyaW5nXCIpIHtcbiAgICBjb25zdCBob21lID0gc2NyaXB0b3JpdW1Ib21lKCk7XG4gICAgY29uc3QgbWFuaWZlc3QgPSBqb2luKGhvbWUsIFwic2Vzc2lvbnNcIiwgZmxhZ3MucmVzdG9yZSwgXCJtYW5pZmVzdC5qc29uXCIpO1xuICAgIGlmICghZXhpc3RzU3luYyhtYW5pZmVzdCkpIHtcbiAgICAgIGxldCBzYXZlZDogc3RyaW5nW10gPSBbXTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHNhdmVkID0gKFxuICAgICAgICAgIGF3YWl0IEFycmF5LmZyb21Bc3luYyhuZXcgQnVuLkdsb2IoXCIqL21hbmlmZXN0Lmpzb25cIikuc2Nhbihqb2luKGhvbWUsIFwic2Vzc2lvbnNcIikpKVxuICAgICAgICApLm1hcCgocCkgPT4gcC5zcGxpdChcIi9cIilbMF0gYXMgc3RyaW5nKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBubyBzZXNzaW9ucyBmb2xkZXI6IHRoZSBzZXQgaXMgZW1wdHksIGFuZCBzYXlzIHNvICovXG4gICAgICB9XG4gICAgICBkaWUoYG5vIHNhdmVkIHNlc3Npb24gXCIke2ZsYWdzLnJlc3RvcmV9XCIgdW5kZXIgJHtob21lfWAsIFwibm90X2ZvdW5kXCIsIHtcbiAgICAgICAgY2hvaWNlczogc2F2ZWQuc29ydCgpLFxuICAgICAgICAuLi4oc2F2ZWQubGVuZ3RoID09PSAwID8geyBoaW50OiBcIm5vIHNhdmVkIHNlc3Npb25zIGluIHRoaXMgaG9tZVwiIH0gOiB7fSksXG4gICAgICB9KTtcbiAgICB9XG4gICAgY29uc3QgbGl2ZSA9IHJlYWRTZXNzaW9uKGZsYWdzLnJlc3RvcmUpO1xuICAgIGlmIChsaXZlKSB7XG4gICAgICBjb25zdCBhbGl2ZSA9IGF3YWl0IGFwaShsaXZlLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpLnRoZW4oXG4gICAgICAgIChyKSA9PiByLnN0YXR1cyA9PT0gMjAwLFxuICAgICAgICAoKSA9PiBmYWxzZSxcbiAgICAgICk7XG4gICAgICBpZiAoYWxpdmUpXG4gICAgICAgIGRpZShgc2Vzc2lvbiAke2ZsYWdzLnJlc3RvcmV9IGlzIGFscmVhZHkgcnVubmluZyBhdCAke2xpdmUudXJsfWAsIFwiY29uZmxpY3RcIiwge1xuICAgICAgICAgIGhpbnQ6IGB1c2UgaXQ6IGNsaS50cyBzdGF0ZSAtLXNlc3Npb24gJHtmbGFncy5yZXN0b3JlfWAsXG4gICAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGRhZW1vbkFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmICh0eXBlb2YgZmxhZ3MudGltZW91dCA9PT0gXCJzdHJpbmdcIikgZGFlbW9uQXJncy5wdXNoKFwiLS10aW1lb3V0XCIsIGZsYWdzLnRpbWVvdXQpO1xuICBpZiAodHlwZW9mIGZsYWdzLnJlc3RvcmUgPT09IFwic3RyaW5nXCIpIGRhZW1vbkFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBmbGFncy5yZXN0b3JlKTtcbiAgLy8gRTIzOiBhIG5ldyBzZXNzaW9uJ3Mgd29ya3NwYWNlIGlzIHdoZXJlIGBvcGVuYCByYW4uIEEgcmVzdG9yZWQgb25lIGtlZXBzIGl0cyBvd24uXG4gIGVsc2UgZGFlbW9uQXJncy5wdXNoKFwiLS13b3Jrc3BhY2VcIiwgcHJvY2Vzcy5jd2QoKSk7XG5cbiAgY29uc3QgY3dkID0gZGFlbW9uQ3dkKCk7XG4gIGlmICghZXhpc3RzU3luYyhjd2QpKVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBjYW5ub3Qgc3RhcnQgaXRzIGRhZW1vbjogdGhlIHdvcmtpbmcgZGlyZWN0b3J5IGl0IG5lZWRzIGlzIG1pc3Npbmcg4oCUICR7Y3dkfWAsXG4gICAgICBcImludGVybmFsXCIsXG4gICAgICB7XG4gICAgICAgIGhpbnQ6IFwiZGV2IG1vZGUgd2FzIHJlc29sdmVkIChubyBkaXN0L2luZGV4Lmh0bWwgYW5kIG5vIFNQRUxMQk9PS19TVVJGQUNFX01PREU9cmVsZWFzZSksIHdoaWNoIG5lZWRzIHNyYy9zY3JpcHRvcml1bS8g4oCUIHJlaW5zdGFsbCB0aGUgc3BlbGwgb3IgYnVpbGQgaXRcIixcbiAgICAgIH0sXG4gICAgKTtcbiAgLy8gVGhlIGRhZW1vbidzIHN0ZGVyciBnb2VzIHRvIGEgTE9HIEZJTEUsIG5vdCB0byB0aGlzIENMSSdzIHN0ZGVyci4gQW5cbiAgLy8gaW5oZXJpdGVkIHN0ZGVyciBvdXRsaXZlcyB0aGUgQ0xJIGluc2lkZSB0aGUgZGV0YWNoZWQgZGFlbW9uLCBzbyBhbnkgY2FsbGVyXG4gIC8vIHRoYXQgcmVhZHMgYG9wZW5gJ3Mgc3RkZXJyIHRvIEVPRiAoYSB0ZXN0IGhhcm5lc3MsIGEgdG9vbCBydW5uZXIpIHdhaXRzIGZvclxuICAvLyB0aGUgd2hvbGUgc2Vzc2lvbiDigJQgbWVhc3VyZWQ6IHRoZSBpbnRlZ3JhdGlvbiBjZWxsIGh1bmcgYXQgaXRzIDYwIHMgdGltZW91dC5cbiAgLy8gQSBmaWxlIGhvbGRzIG5vIHBpcGUsIGFuZCBhIHN0YXJ0IGZhaWx1cmUgYmVsb3cgcXVvdGVzIGl0cyB0YWlsLlxuICBjb25zdCBsb2dEaXIgPSBqb2luKHNjcmlwdG9yaXVtSG9tZSgpLCBcImxvZ3NcIik7XG4gIG1rZGlyU3luYyhsb2dEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAvLyBWZXJpZnktcGFzcyBmaXggNjogdGhlIGxvZ3MgdXNlZCB0byBwaWxlIHVwLCBvbmUgcGVyIGBvcGVuYCwgZm9yZXZlci5cbiAgcHJ1bmVMb2dzKGxvZ0Rpcik7XG4gIGNvbnN0IGxvZ1BhdGggPSBqb2luKGxvZ0RpciwgYGRhZW1vbi0ke0RhdGUubm93KCl9LSR7cHJvY2Vzcy5waWR9LmxvZ2ApO1xuICBkYWVtb25BcmdzLnB1c2goXCItLWxvZ1wiLCBsb2dQYXRoKTtcbiAgY29uc3QgbG9nRmQgPSBvcGVuU3luYyhsb2dQYXRoLCBcImFcIik7XG4gIGNvbnN0IGNoaWxkID0gc3Bhd24oXCJidW5cIiwgZGFlbW9uQXJncywge1xuICAgIGN3ZCxcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwicGlwZVwiLCBsb2dGZF0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgfSk7XG4gIGNsb3NlU3luYyhsb2dGZCk7XG4gIGNoaWxkLnVucmVmKCk7XG5cbiAgY29uc3Qgc3RhcnRUaW1lb3V0TXMgPVxuICAgIHR5cGVvZiBmbGFnc1tcInN0YXJ0LXRpbWVvdXRcIl0gPT09IFwic3RyaW5nXCJcbiAgICAgID8gTWF0aC5tYXgoNTAwMCwgTnVtYmVyLnBhcnNlSW50KGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSwgMTApICogMTAwMClcbiAgICAgIDogNDUwMDA7XG4gIGNvbnN0IGxpbmUgPSBhd2FpdCBuZXcgUHJvbWlzZTxzdHJpbmc+KChyZXMsIHJlaikgPT4ge1xuICAgIGxldCBidWYgPSBcIlwiO1xuICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChcbiAgICAgICgpID0+XG4gICAgICAgIHJlaihcbiAgICAgICAgICBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgZGFlbW9uIHN0YXJ0IHRpbWVvdXQgKCR7c3RhcnRUaW1lb3V0TXMgLyAxMDAwfXMpIOKAlCBwYXNzIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz5gLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICBzdGFydFRpbWVvdXRNcyxcbiAgICApO1xuICAgIGNoaWxkLnN0ZG91dD8ub24oXCJkYXRhXCIsIChjaHVuazogQnVmZmVyKSA9PiB7XG4gICAgICBidWYgKz0gY2h1bmsudG9TdHJpbmcoKTtcbiAgICAgIGNvbnN0IG5sID0gYnVmLmluZGV4T2YoXCJcXG5cIik7XG4gICAgICBpZiAobmwgPj0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICByZXMoYnVmLnNsaWNlKDAsIG5sKS50cmltKCkpO1xuICAgICAgfVxuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXJyb3JcIiwgKGVycikgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihlcnIpO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgIHJlaihuZXcgRXJyb3IoYGRhZW1vbiBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX0gYmVmb3JlIGl0cyBoYW5kc2hha2VgKSk7XG4gICAgfSk7XG4gIH0pLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICBsZXQgdGFpbCA9IFwiXCI7XG4gICAgdHJ5IHtcbiAgICAgIHRhaWwgPSByZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGY4XCIpLnRyaW0oKS5zbGljZSgtODAwKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIG5vIGxvZyB3cml0dGVuICovXG4gICAgfVxuICAgIGRpZShcbiAgICAgIGBzY3JpcHRvcml1bSBkYWVtb24gZmFpbGVkIHRvIHN0YXJ0OiAke2VyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKX1gLFxuICAgICAgXCJpbnRlcm5hbFwiLFxuICAgICAgeyBoaW50OiB0YWlsID8gYGRhZW1vbiBsb2cgKCR7bG9nUGF0aH0pOiAke3RhaWx9YCA6IGBkYWVtb24gbG9nOiAke2xvZ1BhdGh9YCB9LFxuICAgICk7XG4gIH0pO1xuXG4gIC8vIFJlbGVhc2UgdGhlIGRhZW1vbidzIHN0ZG91dCBwaXBlLCBvciB0aGlzIENMSSdzIG5hdHVyYWwgcmV0dXJuIHdhaXRzIG9uIGFcbiAgLy8gc3RyZWFtIHRoYXQgbmV2ZXIgY2xvc2VzIChnbGFtb3VyIG1lYXN1cmVkIDkxIHMg4oaSIDEgcykuIENoZWNrZWQgZm9yIHRoZVxuICAvLyBNRVRIT0Q6IHVuZGVyIEJ1biB0aGlzIHBpcGUgaXMgYSBwbGFpbiBSZWFkYWJsZSB0aGF0IG5vbmV0aGVsZXNzIGhhcyB1bnJlZi5cbiAgY29uc3Qgb3V0ID0gY2hpbGQuc3Rkb3V0O1xuICBpZiAoIW91dCB8fCAhKFwidW5yZWZcIiBpbiBvdXQpIHx8IHR5cGVvZiBvdXQudW5yZWYgIT09IFwiZnVuY3Rpb25cIilcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcInNjcmlwdG9yaXVtOiB0aGUgZGFlbW9uJ3Mgc3Rkb3V0IHBpcGUgaGFzIG5vIHVucmVmKCk7IGBvcGVuYCB3b3VsZCBuZXZlciBleGl0XCIsXG4gICAgKTtcbiAgb3V0LnVucmVmKCk7XG5cbiAgbGV0IGhzOiB7XG4gICAgdXJsOiBzdHJpbmc7XG4gICAgcG9ydDogbnVtYmVyO1xuICAgIHNlc3Npb25faWQ6IHN0cmluZztcbiAgICBvaz86IGJvb2xlYW47XG4gICAgc3RhdHVzPzogbnVtYmVyO1xuICAgIGVycm9yPzogc3RyaW5nO1xuICB9O1xuICB0cnkge1xuICAgIGhzID0gSlNPTi5wYXJzZShsaW5lKTtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB1bmV4cGVjdGVkIG91dHB1dCBmcm9tIGRhZW1vbjogJHtsaW5lfWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgaWYgKGhzLm9rID09PSBmYWxzZSkgZGFlbW9uUmVmdXNlZChcIm9wZW5cIiwgaHMuc3RhdHVzID8/IDUwMCwgaHMpO1xuXG4gIGxldCBlbnRyaWVzOiB1bmtub3duW10gPSBbXTtcbiAgaWYgKHBhdGhzLmxlbmd0aCA+IDApIHtcbiAgICBjb25zdCByID0gYXdhaXQgcG9zdENtZChocy5zZXNzaW9uX2lkLCB7IHR5cGU6IFwiY29udGV4dC5hZGRcIiwgcGF0aHMgfSk7XG4gICAgZW50cmllcyA9IChyLmVudHJpZXMgYXMgdW5rbm93bltdKSA/PyBbXTtcbiAgfVxuICBwcmludEpzb24oeyAuLi5ocywgLi4uKHBhdGhzLmxlbmd0aCA+IDAgPyB7IGVudHJpZXMgfSA6IHt9KSB9KTtcblxuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkge1xuICAgIGNvbnN0IG9wZW5lciA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gICAgc3Bhd24ob3BlbmVyLCBbaHMudXJsXSwgeyBkZXRhY2hlZDogdHJ1ZSwgc3RkaW86IFwiaWdub3JlXCIgfSkudW5yZWYoKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRBZGQocG9zOiBzdHJpbmdbXSwgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkKSB7XG4gIGNvbnN0IHBhdGhzID0gY29udGV4dFBhdGhzKHBvcyk7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjb250ZXh0LmFkZFwiLCBwYXRocyB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZnVsbDogYm9vbGVhbikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCI/ZnVsbD0xXCIgOiBcIlwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJzdGF0ZVwiLCBzdGF0dXMsIGRhdGEpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbi8qKlxuICogVGhlIE9ORSBwcm9zZSByZWFkZXI6IGFyZ3VtZW50cywgYC0tc3RkaW5gIG9yIGAtLWJvZHktZmlsZWAsIGV4YWN0bHkgb25lIG9mXG4gKiB0aGVtLiBgc2F5YC9gdGFza2AvYG5vdGVgIG5lZWQgYSBtZXNzYWdlIGFuZCB0cmltIGl0OyBgdmVyc2lvbi1uZXdgICgjMTE3KVxuICogbWF5IGhhdmUgbm9uZSAodGhlbiBpdCBjb3BpZXMpIGFuZCBrZWVwcyBpdHMgYm9keSBieXRlIGZvciBieXRlLCBiZWNhdXNlIGFcbiAqIHZlcnNpb24ncyB0ZXh0IGlzIGEgZG9jdW1lbnQsIG5vdCBhIGNoYXQgbGluZS5cbiAqXG4gKiBBIGJvZHkgZmlsZSB0aGF0IGlzIG5vdCB0aGVyZSBpcyBgdXNhZ2VgICgyKSBieSBkZWZhdWx0IOKAlCB3aGF0IGBzYXlgL2B0YXNrYC9cbiAqIGBub3RlYC9gbm90ZS1lZGl0YCBoYXZlIGFsd2F5cyBhbnN3ZXJlZCDigJQgYW5kIGBub3RfZm91bmRgICg1KSB3aGVyZSB0aGVcbiAqIGNhbGxlciBhc2tzIChgdmVyc2lvbi1uZXdgLCBuZXcgaW4gIzExNykuIOKaoCBBbGlnbmluZyB0aGUgb2xkZXIgdmVyYnMgb24gNSBpc1xuICogYSBjYWxsZXItdmlzaWJsZSBleGl0LWNvZGUgY2hhbmdlLCBoZWxkIGZvciBhIHJlbGVhc2UgdGhhdCBjYW4gY2FycnkgYVxuICogYnJlYWtpbmctY2hhbmdlcyBub3RlOyBjbGktY29udHJhY3QgcGlucyB0aGVpciAyIHVudGlsIHRoZW4uXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYWRQcm9zZShcbiAgdmVyYjogc3RyaW5nLFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4gIG86IHsgb3B0aW9uYWw/OiBib29sZWFuOyBtaXNzaW5nRmlsZT86IFwidXNhZ2VcIiB8IFwibm90X2ZvdW5kXCIgfSA9IHt9LFxuKTogUHJvbWlzZTxzdHJpbmcgfCB1bmRlZmluZWQ+IHtcbiAgY29uc3Qgc291cmNlcyA9IFtcbiAgICBwb3MubGVuZ3RoID4gMCxcbiAgICBmbGFncy5zdGRpbiA9PT0gdHJ1ZSxcbiAgICB0eXBlb2YgZmxhZ3NbXCJib2R5LWZpbGVcIl0gPT09IFwic3RyaW5nXCIsXG4gIF0uZmlsdGVyKEJvb2xlYW4pLmxlbmd0aDtcbiAgaWYgKHNvdXJjZXMgPT09IDAgJiYgby5vcHRpb25hbCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgaWYgKHNvdXJjZXMgIT09IDEpXG4gICAgZGllKFxuICAgICAgc291cmNlcyA9PT0gMFxuICAgICAgICA/IGAke3ZlcmJ9IG5lZWRzIGEgbWVzc2FnZWBcbiAgICAgICAgOiBvLm9wdGlvbmFsXG4gICAgICAgICAgPyBgJHt2ZXJifSB0YWtlcyBpdHMgYm9keSBmcm9tIG9uZSBwbGFjZTogLS1zdGRpbiBvciAtLWJvZHktZmlsZSwgbm90IGJvdGhgXG4gICAgICAgICAgOiBgJHt2ZXJifSB0YWtlcyBpdHMgbWVzc2FnZSBmcm9tIGV4YWN0bHkgb25lIHBsYWNlOiBhcmd1bWVudHMsIC0tc3RkaW4gb3IgLS1ib2R5LWZpbGVgLFxuICAgICAgXCJ1c2FnZVwiLFxuICAgICAge1xuICAgICAgICBoaW50OiBvLm9wdGlvbmFsXG4gICAgICAgICAgPyBcImdpdmUgdGhlIHRleHQgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbiAobmV2ZXIgYW4gdW5xdW90ZWQgaGVyZWRvYylcIlxuICAgICAgICAgIDogXCJnaXZlIHRoZSB0ZXh0IGFzIGFyZ3VtZW50cywgb3IgcHJvc2UgdGhyb3VnaCAtLWJvZHktZmlsZSA8cGF0aD4gLyAtLXN0ZGluIChuZXZlciBhbiB1bnF1b3RlZCBoZXJlZG9jKVwiLFxuICAgICAgICBjaG9pY2VzOiBbXCItLXN0ZGluXCIsIFwiLS1ib2R5LWZpbGVcIl0sXG4gICAgICB9LFxuICAgICk7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIGlmIChmbGFncy5zdGRpbiA9PT0gdHJ1ZSkgdGV4dCA9IGF3YWl0IG5ldyBSZXNwb25zZShCdW4uc3RkaW4uc3RyZWFtKCkpLnRleHQoKTtcbiAgZWxzZSBpZiAodHlwZW9mIGZsYWdzW1wiYm9keS1maWxlXCJdID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgcGF0aCA9IGZsYWdzW1wiYm9keS1maWxlXCJdO1xuICAgIGlmICghZXhpc3RzU3luYyhwYXRoKSkgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBub3QgZm91bmQ6ICR7cGF0aH1gLCBvLm1pc3NpbmdGaWxlID8/IFwidXNhZ2VcIik7XG4gICAgLy8gQSBkaXJlY3RvcnkgaXMgdGhlIGNhbGxlcidzIG1pc3Rha2UsIHRoZSBzYW1lIGZvciBldmVyeSB2ZXJiIOKAlCBpdCB1c2VkXG4gICAgLy8gdG8gcmVhY2ggcmVhZEZpbGVTeW5jIGFuZCBjb21lIG91dCBhcyBhbiBpbnRlcm5hbCBFSVNESVIgKGV4aXQgMSkuXG4gICAgaWYgKHN0YXRTeW5jKHBhdGgpLmlzRGlyZWN0b3J5KCkpXG4gICAgICBkaWUoYCR7dmVyYn06IC0tYm9keS1maWxlIGlzIGEgZGlyZWN0b3J5LCBub3QgYSBmaWxlOiAke3BhdGh9YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IFwicGFzcyB0aGUgcGF0aCBvZiB0aGUgZmlsZSB0aGF0IGhvbGRzIHRoZSB0ZXh0XCIsXG4gICAgICB9KTtcbiAgICAvLyBTbyBpcyBhIGZpbGUgdGhpcyBwcm9jZXNzIG1heSBub3QgcmVhZCAoY2htb2QgMDAwKTogaXQgdXNlZCB0byBjb21lIG91dFxuICAgIC8vIGFzIGFuIGludGVybmFsIHJhdyBFQUNDRVMgKGV4aXQgMSkuIEl0IGlzIHRoZXJlIGFuZCBpcyBhIGZpbGUsIHNvIGFueVxuICAgIC8vIGZhaWx1cmUgdG8gcmVhZCBpdCBpcyBcImNhbm5vdCBiZSByZWFkXCIg4oCUIHRoZSBjYWxsZXIncyB0byBmaXguXG4gICAgdHJ5IHtcbiAgICAgIHRleHQgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgZGllKGAke3ZlcmJ9OiAtLWJvZHktZmlsZSBjYW5ub3QgYmUgcmVhZDogJHtwYXRofWAsIFwidXNhZ2VcIiwge1xuICAgICAgICBoaW50OiBcImNoZWNrIHRoYXQgdGhlIGZpbGUncyBwZXJtaXNzaW9ucyBsZXQgeW91IHJlYWQgaXQsIG9yIHBhc3MgYW5vdGhlciBmaWxlXCIsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSB0ZXh0ID0gcG9zLmpvaW4oXCIgXCIpO1xuICBpZiAoIXRleHQudHJpbSgpKVxuICAgIGRpZShcbiAgICAgIG8ub3B0aW9uYWwgPyBgJHt2ZXJifTogdGhlIGJvZHkgaXMgZW1wdHlgIDogYCR7dmVyYn06IHRoZSBtZXNzYWdlIGlzIGVtcHR5YCxcbiAgICAgIFwidXNhZ2VcIixcbiAgICAgIG8ub3B0aW9uYWwgPyB7IGhpbnQ6IGBkcm9wIC0tYm9keS1maWxlLy0tc3RkaW4gdG8gY29weSB0aGUgc291cmNlIHZlcnNpb24gaW5zdGVhZGAgfSA6IHt9LFxuICAgICk7XG4gIHJldHVybiB0ZXh0O1xufVxuXG5hc3luYyBmdW5jdGlvbiByZWFkU2F5Qm9keShcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuICB2ZXJiOiBzdHJpbmcsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKChhd2FpdCByZWFkUHJvc2UodmVyYiwgcG9zLCBmbGFncykpID8/IFwiXCIpLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIHRoZSB0YWlsIGhhcyBhbHJlYWR5IHJlcG9ydGVkIHRoYXQgaXQgbG9zdCB0aGUgZGFlbW9uIChFNTUpLiBNb2R1bGVcbiAqIHNjb3BlIGJlY2F1c2UgYSB0YWlsIGlzIG9uZSBwcm9jZXNzIGRvaW5nIG9uZSB0aGluZywgYW5kIHRoZSB0d28gaG9va3MgdGhhdFxuICogcmVhZCBpdCBhcmUgaGFuZGVkIHRvIGEgY2xpZW50IHRoYXQgb3ducyBpdHMgb3duIGxvb3AuXG4gKi9cbmxldCBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcblxuLyoqXG4gKiBUaGUgd2F0Y2guIEVuZHMgaXRzZWxmIGJlZm9yZSBNb25pdG9yJ3MgY2FwIHdpdGggb25lIGxpbmUgbmFtaW5nIHRoZSBuZXh0XG4gKiBhY3QgKGBzcmMva2l0L3dpcmUvdGFpbEhhbmRvZmYudHNgKTogcmUtYXJtIE1vbml0b3IsIGdvIHRvIGEgYmFja2dyb3VuZFxuICogYC0tb25jZWAsIG9yIGNvbWUgYmFjayBmcm9tIGEgY2xvc2VkIG9yIGxvc3Qgc2Vzc2lvbiB3aXRoIGBvcGVuIC0tcmVzdG9yZWAuXG4gKiBBIGAtLXNpbmNlYCByZS1hcm0gcHJpbnRzIG5vIGdyb3VuZGluZyBsaW5lOiB0aGUgYWdlbnQgYWxyZWFkeSBrbm93cyB0aGVcbiAqIHNlc3Npb24sIGFuZCB0aGUgbGluZSB3b3VsZCBjb3VudCBhcyBub2lzZSBpbiB0aGUgd2luZG93J3Mgd2FrZS5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChcbiAgc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBzaW5jZTogbnVtYmVyLFxuICBvOiB7IG9uY2U6IGJvb2xlYW47IHNpbmNlR2l2ZW46IGJvb2xlYW47IGVwb2NoPzogc3RyaW5nIH0sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGNvbnN0IHJlQXJtID0gc2Vzc2lvbiAhPT0gdW5kZWZpbmVkIHx8IG8uc2luY2VHaXZlbjtcbiAgbGV0IGdyb3VuZGVkID0gby5zaW5jZUdpdmVuO1xuICBjb25zdCBwaW4gPSAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gW1wiLS1zZXNzaW9uXCIsIGJvdW5kSWRdIDogW10pO1xuICByZXR1cm4gYXdhaXQgdGFpbFdpdGhIYW5kb2ZmPHsgaWQ/OiBudW1iZXI7IGVwb2NoPzogc3RyaW5nOyB0eXBlPzogc3RyaW5nOyBieT86IHN0cmluZyB9PihcbiAgICB7XG4gICAgICByZXNvbHZlOiAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkO1xuICAgICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fWA7XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgICAvLyBEMTogYSB0YWlsIGdpdmVuIC0tc2Vzc2lvbiBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElOR1xuICAgICAgICAvLyBzZXNzaW9uLCBzbyBub3QgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQgKGluIHRoZSBnYXAsIHNheSkg4oCUIHRoZVxuICAgICAgICAvLyBoYW5kb2ZmIHNheXMgYHRhaWwuY2xvc2VkYCwgbmV2ZXIgYSBzaWxlbnQgcmV0cnktZm9yZXZlci5cbiAgICAgICAgaWYgKGV2ZXJSZXNvbHZlZCB8fCByZUFybSkgcmV0dXJuIFwic3RvcFwiO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgICByZXR1cm4gXCJyZXRyeVwiO1xuICAgICAgfSxcbiAgICAgIHBhdGg6IFwiL2V2ZW50c1wiLFxuICAgICAgc2luY2UsXG4gICAgICAuLi4oby5lcG9jaCA/IHsgc2luY2VFcG9jaDogby5lcG9jaCB9IDoge30pLFxuICAgICAgY3Vyc29yT2Y6IChldikgPT4gKHR5cGVvZiBldi5pZCA9PT0gXCJudW1iZXJcIiA/IGV2LmlkIDogdW5kZWZpbmVkKSxcbiAgICAgIGVwb2NoT2Y6IChldikgPT4gKHR5cGVvZiBldi5lcG9jaCA9PT0gXCJzdHJpbmdcIiA/IGV2LmVwb2NoIDogdW5kZWZpbmVkKSxcbiAgICAgIC8vIEEgZGlmZmVyZW50IGVwb2NoIG9uIHJlY29ubmVjdCA9IHRoZSBkYWVtb24gcmVzdGFydGVkOyBpZHMgYmVnYW4gYWdhaW4uXG4gICAgICBvbkVwb2NoQ2hhbmdlOiAoZXBvY2gpID0+IEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJlcG9jaC5jaGFuZ2VkXCIsIGVwb2NoIH0pLFxuICAgICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICAgIGlkbGVNczogVEFJTF9JRExFX01TLFxuICAgICAgLy8g4puUIEEgS0VFUEFMSVZFIElTIFBST09GIE9GIExJRkUsIHNvIGl0IGlzIGFsc28gd2hhdCBjbGVhcnMgYSByZXBvcnRlZFxuICAgICAgLy8gZGlzY29ubmVjdGlvbi4gVGhlcmUgaXMgbm8gYG9uQ29ubmVjdGAgaG9vayBhbmQgdGhpcyBpcyB0aGUgaG9uZXN0XG4gICAgICAvLyBzdWJzdGl0dXRlOiB0aGUgZGFlbW9uIG9ubHkgc2VuZHMgY29tbWVudHMgZG93biBhIGxpdmUgc3RyZWFtLlxuICAgICAgb25Db21tZW50OiAoKSA9PiB7XG4gICAgICAgIGlmICghZGlzY29ubmVjdGVkKSByZXR1cm4gXCI6IHNjcmlwdG9yaXVtLWtlZXBhbGl2ZVwiO1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSBmYWxzZTtcbiAgICAgICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJ0YWlsLnJlY29ubmVjdGVkXCIgfSk7XG4gICAgICB9LFxuICAgICAgLy8g4puUIE9ORSBMSU5FIFBFUiBFUElTT0RFLCBOT1QgUEVSIEFUVEVNUFQuIFRoZSBjbGllbnQgcmVjb25uZWN0cyB3aXRoXG4gICAgICAvLyBiYWNrb2ZmIGZvcmV2ZXIsIHNvIGEgaG9vayB0aGF0IHNwb2tlIGV2ZXJ5IHRpbWUgd291bGQgZW1pdCBhIGxpbmUgZXZlcnlcbiAgICAgIC8vIGZldyBzZWNvbmRzIGZvciBhcyBsb25nIGFzIHRoZSBkYWVtb24gc3RheWVkIGRvd24g4oCUIHdoaWNoIGlzIGhvdyBhXG4gICAgICAvLyB3YXRjaGVyIGdldHMgbXV0ZWQsIGFuZCB0aGVuIG5vYm9keSBoZWFycyB0aGUgbmV4dCByZWFsIHRoaW5nLlxuICAgICAgLy9cbiAgICAgIC8vIOKaoCBXSFkgVEhJUyBFWElTVFMgQVQgQUxMOiB3aXRob3V0IGl0IGEgREVBRCBkYWVtb24gYW5kIGEgUVVJRVQgb25lIGFyZVxuICAgICAgLy8gdGhlIHNhbWUgdGhpbmcgZnJvbSBvdXQgaGVyZS4gQSBncmFjZWZ1bCBjbG9zZSBlbWl0cyBgY2xvc2VkYCBhbmQgZW5kc1xuICAgICAgLy8gdGhlIHRhaWw7IGEgY3Jhc2gsIGEga2lsbCAtOSBvciBhIHNsZWVwaW5nIGxhcHRvcCBlbWl0cyBub3RoaW5nLCB0aGVcbiAgICAgIC8vIGNsaWVudCByZXRyaWVzIGluIHNpbGVuY2UsIGFuZCB0aGUgYWJzZW5jZSBvZiBldmVudHMgaXMgbm90IGFuIGV2ZW50LiBBXG4gICAgICAvLyB3YXRjaGVyIHdhaXRpbmcgZm9yIHRoZSBodW1hbidzIG5leHQgbWVzc2FnZSB3b3VsZCB3YWl0IGZvcmV2ZXIgYW5kXG4gICAgICAvLyBuZXZlciBsZWFybiBpdCBoYWQgc3RvcHBlZCBsaXN0ZW5pbmcuIChGb3VuZCAyMDI2LTA5LTE0IHdoaWxlIGFuc3dlcmluZ1xuICAgICAgLy8gQ29sZSdzIHF1ZXN0aW9uIGFib3V0IHdoZXRoZXIgYSB0aW1lb3V0IHdvdWxkIG5vdGlmeSBtZS4gSXQgd291bGQgbm90LilcbiAgICAgIG9uRGlzY29ubmVjdDogKHsgY2F1c2UsIHN0YXR1cyB9KSA9PiB7XG4gICAgICAgIGlmIChkaXNjb25uZWN0ZWQpIHJldHVybiBudWxsO1xuICAgICAgICBkaXNjb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHR5cGU6IFwidGFpbC5kaXNjb25uZWN0ZWRcIixcbiAgICAgICAgICBjYXVzZSxcbiAgICAgICAgICAuLi4oc3RhdHVzICE9PSB1bmRlZmluZWQgPyB7IHN0YXR1cyB9IDoge30pLFxuICAgICAgICAgIG5vdGU6IFwicmV0cnlpbmc7IHRoZSBzZXNzaW9uIG1heSBoYXZlIGNsb3NlZCBvciBjcmFzaGVkXCIsXG4gICAgICAgIH0pO1xuICAgICAgfSxcbiAgICB9LFxuICAgIHtcbiAgICAgIHNwZWxsOiBcInNjcmlwdG9yaXVtXCIsXG4gICAgICBtb2RlOiBvLm9uY2UgPyBcIm9uY2VcIiA6IFwid2F0Y2hcIixcbiAgICAgIHByZXNlbmNlOiBmYWxzZSxcbiAgICAgIC8vIFRoZSBgY2xvc2VkYCBldmVudCBzYXlzIHdobyBlbmRlZCBpdDsgYHRhaWwuY2xvc2VkYCBjYXJyaWVzIGl0IGFzXG4gICAgICAvLyBgYnlgLCBhbmQgYSBodW1hbiBlbmQgdGVsbHMgdGhlIGFnZW50IHRvIHN0b3AgYW5kIG5vdCByZW9wZW4uXG4gICAgICBjbG9zZWRCeTogKGV2KSA9PiAodHlwZW9mIGV2LmJ5ID09PSBcInN0cmluZ1wiID8gZXYuYnkgOiB1bmRlZmluZWQpLFxuICAgICAgLy8gQSByZS1hcm0gYWZ0ZXIgdGhlIGVuZCBuZXZlciBzZWVzIGBjbG9zZWRgIChEMSk7IHRoZSBtYW5pZmVzdCdzXG4gICAgICAvLyBgZW5kZWQuYnlgIGlzIHRoZSBzYW1lIGZhY3QsIGFuZCBpdCBvdXRsaXZlcyB0aGUgZGFlbW9uLlxuICAgICAgZ29uZUJ5OiAoKSA9PiAoYm91bmRJZCAhPT0gdW5kZWZpbmVkID8gZW5kZWRCeShib3VuZElkKSA6IHVuZGVmaW5lZCksXG4gICAgICBjb21tYW5kczoge1xuICAgICAgICB0YWlsOiAoeyBzaW5jZTogYXQsIG9uY2UsIGVwb2NoIH0pID0+IHRhaWxDb21tYW5kKFtcInRhaWxcIiwgLi4ucGluKCldLCBhdCwgb25jZSwgZXBvY2gpLFxuICAgICAgICBjb21lQmFjazogKCkgPT4gY29tbWFuZExpbmUoW1wib3BlblwiLCBcIi0tcmVzdG9yZVwiLCBib3VuZElkID8/IFwiPGlkPlwiLCBcIi0tbm8tb3BlblwiXSksXG4gICAgICB9LFxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIHZlcnNpb25JbmZvKCk6IHsgbmFtZTogc3RyaW5nOyB2ZXJzaW9uOiBzdHJpbmcgfSB7XG4gIHRyeSB7XG4gICAgY29uc3QgcmF3ID0gcmVhZEZpbGVTeW5jKGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKSwgXCJ1dGY4XCIpO1xuICAgIGNvbnN0IHBrZyA9IEpTT04ucGFyc2UocmF3KSBhcyB7IHZlcnNpb24/OiB1bmtub3duIH07XG4gICAgaWYgKHR5cGVvZiBwa2cudmVyc2lvbiA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIHsgbmFtZTogXCJzY3JpcHRvcml1bVwiLCB2ZXJzaW9uOiBwa2cudmVyc2lvbiB9O1xuICB9IGNhdGNoIHtcbiAgICAvKiBmYWxsIHRocm91Z2ggKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcInNjcmlwdG9yaXVtXCIsIHZlcnNpb246IFwidW5rbm93blwiIH07XG59XG5cbi8qKlxuICogRTI0J3MgdmVyYnM6IHRoZSBhZ2VudCdzIGhhbGYgb2YgdGhlIHN0cnVjdHVyZSBvcHMgdGhlIGh1bWFuIHJlYWNoZXMgYnkgbWVudXNcbiAqIGFuZCBkcmFnIGFuZCBkcm9wLiBFYWNoIHJlc29sdmVzIGl0cyBwYXRocyBhZ2FpbnN0IFRISVMgcHJvY2VzcydzIGN3ZCBhbmRcbiAqIHBvc3RzIG9uZSBvcDsgdGhlIGRhZW1vbiBkb2VzIHRoZSBjaGFuZ2UgYW5kIGFubm91bmNlcyBpdCBpbiB0aGUgY2hhdC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RydWN0dXJlQ21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgb3A6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG9wKSk7XG59XG5cbi8qKiBgaW1wb3J0IDxmaWxlPmA6IHRoZSBmaWxlJ3MgVEVYVCBpcyBzZW50LCBzbyB0aGUgZGFlbW9uIHdyaXRlcyBhIGNvcHkgKEUyMykuICovXG5hc3luYyBmdW5jdGlvbiBjbWRJbXBvcnQoZmlsZTogc3RyaW5nLCBpbnRvOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBhYnMgPSByZXNvbHZlKGZpbGUpO1xuICBsZXQgc3Q6IFJldHVyblR5cGU8dHlwZW9mIHN0YXRTeW5jPjtcbiAgdHJ5IHtcbiAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgbm8gc3VjaCBmaWxlOiAke2Fic31gLCBcIm5vdF9mb3VuZFwiKTtcbiAgfVxuICBpZiAoIXN0LmlzRmlsZSgpIHx8ICFpc0RvY05hbWUoYWJzKSlcbiAgICBkaWUoYG5vdCBhIGRvY3VtZW50IHNjcmlwdG9yaXVtIG9wZW5zOiAke2Fic31gLCBcInVzYWdlXCIsIHsgY2hvaWNlczogWy4uLkRPQ19FWFRFTlNJT05TXSB9KTtcbiAgYXdhaXQgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcImltcG9ydFwiLFxuICAgIG5hbWU6IGFicy5zcGxpdChcIi9cIikucG9wKCkgYXMgc3RyaW5nLFxuICAgIHRleHQ6IHJlYWRGaWxlU3luYyhhYnMsIFwidXRmOFwiKSxcbiAgICAuLi4oaW50byAhPT0gdW5kZWZpbmVkID8geyBpbnRvOiByZXNvbHZlKGludG8pIH0gOiB7fSksXG4gIH0pO1xufVxuXG4vKiogYHdvcmtzcGFjZWAgYWxvbmUgcHJpbnRzIGl0OyBgd29ya3NwYWNlIDxkaXI+YCBzZXRzIGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kV29ya3NwYWNlKGRpcjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgaWYgKGRpciAhPT0gdW5kZWZpbmVkKVxuICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIndvcmtzcGFjZS5zZXRcIiwgcGF0aDogcmVzb2x2ZShkaXIpIH0pO1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwid29ya3NwYWNlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbih7IHdvcmtzcGFjZTogKGRhdGEgYXMgeyB3b3Jrc3BhY2U/OiB1bmtub3duIH0pLndvcmtzcGFjZSB9KTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFIOKAlCBkaXNwYXRjaCwgaGVscCwgYHNjaGVtYWAgYW5kIGV2ZXJ5IGBjaG9pY2VzYCB3YWxrIGl0IOKUgOKUgFxuLy9cbi8vIFRocm91Z2ggdGhlIGhvdXNlJ3Mgb25lIHJlZ2lzdHJ5IChgc3JjL2tpdC9jbGkvcmVnaXN0cnkudHNgKS4gc2NyaXB0b3JpdW0nc1xuLy8gb3duIGRpc3BhdGNoZXIsIGhlbHAgcmVuZGVyZXIgYW5kIGRlY2xhcmF0aW9uIGVtaXR0ZXIg4oCUIGEgY29weSBvZiBnbGFtb3VyJ3Mg4oCUXG4vLyB3ZXJlIGRlbGV0ZWQgd2hlbiBpdCBtb3ZlZCBvbnRvIHRoZSBtb2R1bGUuIGBoZWxwYCwgYHZlcnNpb25gIGFuZCBgc2NoZW1hYFxuLy8gYXJlIHRoZSBtb2R1bGUncyByb3dzOiBkZWNsYXJlZCBhbmQgc3RyaWN0LCBzbyBgdmVyc2lvbiAtLWJvZ3VzYCBpcyByZWZ1c2VkXG4vLyAoaXQgZXhpdGVkIDAgd2hpbGUgYHZlcnNpb25gIHdhcyBhbnN3ZXJlZCBiZWZvcmUgdGhlIHRhYmxlKS5cblxudHlwZSBGbGFnID0ga2V5b2YgdHlwZW9mIENMSV9PUFRJT05TO1xudHlwZSBGbGFncyA9IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuLyoqIEEgcm93IGFzIHNjcmlwdG9yaXVtIHdyaXRlcyBpdDogdGhlIGhhbmRsZXIgdGFrZXMgYChwb3MsIGZsYWdzLCBzZXNzaW9uKWAsXG4gKiAgYW5kIGBvbmAgYWRhcHRzIGl0IHRvIHRoZSBraXQncyBgcnVuKGludilgLiBBIG51bWJlciByZXR1cm5lZCBpcyB0aGUgZXhpdFxuICogIGNvZGUgKGB0YWlsYCk7IGFueXRoaW5nIGVsc2UgaXMgMC4gKi9cbnR5cGUgUm93ID0gT21pdDxDb21tYW5kU3BlYzxGbGFnPiwgXCJydW5cIiB8IFwicmVqZWN0SGludFwiPiAmIHtcbiAgcnVuOiAocG9zOiBzdHJpbmdbXSwgZmxhZ3M6IEZsYWdzLCBzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQpID0+IHVua25vd247XG59O1xuXG4vKiogc2NyaXB0b3JpdW0gZGVjbGFyZXMgbm8gYG11bHRpcGxlYCBmbGFnLCBzbyBldmVyeSB2YWx1ZSBpcyBhIHN0cmluZyBvciBhXG4gKiAgYm9vbGVhbiDigJQgdGhlIGBGbGFnc2AgdGhlIGhhbmRsZXJzIHRha2UuICovXG5jb25zdCBvbiA9XG4gIChoOiBSb3dbXCJydW5cIl0pID0+XG4gIChpbnY6IEludm9jYXRpb248RmxhZz4pOiB1bmtub3duID0+IHtcbiAgICBjb25zdCBmbGFncyA9IGludi5mbGFncyBhcyBGbGFncztcbiAgICByZXR1cm4gaChpbnYucG9zLCBmbGFncywgdHlwZW9mIGZsYWdzLnNlc3Npb24gPT09IFwic3RyaW5nXCIgPyBmbGFncy5zZXNzaW9uIDogdW5kZWZpbmVkKTtcbiAgfTtcblxuLyoqIEV2ZXJ5IGZsYWcgcmVqZWN0aW9uJ3MgaGludDogdGhlIG9uZSByZXBhaXIgZm9yIHByb3NlIGluIHdoaWNoIGEgd29yZFxuICogIGhhcHBlbnMgdG8gc3RhcnQgd2l0aCBgLS1gLiAqL1xuY29uc3QgREFTSF9ISU5UID0gXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCI7XG5cbmNvbnN0IFNFU1NJT04gPSBbXCJzZXNzaW9uXCJdIGFzIGNvbnN0IHNhdGlzZmllcyByZWFkb25seSBGbGFnW107XG5cbmNvbnN0IFJPV1M6IFJvd1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcIm5vLW9wZW5cIiwgXCJyZXN0b3JlXCIsIFwidGltZW91dFwiLCBcInN0YXJ0LXRpbWVvdXRcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJzcGF3biBhIHNlc3Npb24gKG9wZW5zIHRoZSBicm93c2VyKSwgYWRkaW5nIHBhdGhzOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH0uIC0tdGltZW91dCA8c2Vjb25kcz4gc2V0cyB0aGUgaWRsZSBjbG9zZSAoZGVmYXVsdCAxODAwKTsgLS10aW1lb3V0IDAgc3RhbmRzIHVudGlsIGNsb3NlZFwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MpID0+IGNtZE9wZW4ocG9zLCBmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImFkZFwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImFkZCBmaWxlcyBvciBmb2xkZXJzIHRvIHRoZSBjb250ZXh0IGxpc3RcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kQWRkKHBvcywgc2Vzc2lvbiksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBzZXNzaW9uOiBjb250ZXh0LCBkb2NzICsgdmVyc2lvbnMgKHdpdGggcGF0aHMpLCBhY3RpdmUsIGRpcnR5LCBzZWxlY3Rpb25cIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT4gY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIiwgXCJvbmNlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwidGhlIGh1bWFuJ3MgbWVzc2FnZXMgKHdpdGggc2VsZWN0aW9uICsgYWN0aXZlIHBhdGgpIGFzIEpTT04gbGluZXMg4oCUIHdyYXAgd2l0aCBNb25pdG9yOyBpdHMgbGFzdCBsaW5lIG5hbWVzIHRoZSBuZXh0IGFjdFwiLFxuICAgIHJ1bjogKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBiID0gdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VUYWlsU2luY2UoZmxhZ3Muc2luY2UpIDogeyBzaW5jZTogLTEgfTtcbiAgICAgIHJldHVybiBjbWRUYWlsKHNlc3Npb24sIGIuc2luY2UsIHtcbiAgICAgICAgb25jZTogZmxhZ3Mub25jZSA9PT0gdHJ1ZSxcbiAgICAgICAgc2luY2VHaXZlbjogdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiLFxuICAgICAgICAuLi4oYi5lcG9jaCA/IHsgZXBvY2g6IGIuZXBvY2ggfSA6IHt9KSxcbiAgICAgIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInZlcnNpb24tbmV3XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZyb21cIiwgXCJsYWJlbFwiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwicHJvcG9zZSBhIG5ldyB2ZXJzaW9uIGhvbGRpbmcgeW91ciB0ZXh0ICgtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbik7IHdpdGhvdXQgb25lLCBjb3BpZXMgYSB2ZXJzaW9uIChkZWZhdWx0OiB0aGUgYWN0aXZlIG9uZSkgYW5kIHByaW50cyBpdHMgcGF0aCB0byBlZGl0XCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZyb20gPSB0eXBlb2YgZmxhZ3MuZnJvbSA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlVmVyc2lvbihmbGFncy5mcm9tLCBcIi0tZnJvbVwiKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZWFkUHJvc2UoXCJ2ZXJzaW9uLW5ld1wiLCBbXSwgZmxhZ3MsIHtcbiAgICAgICAgb3B0aW9uYWw6IHRydWUsXG4gICAgICAgIG1pc3NpbmdGaWxlOiBcIm5vdF9mb3VuZFwiLFxuICAgICAgfSk7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5uZXdcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIC4uLihmcm9tICE9PSB1bmRlZmluZWQgPyB7IGZyb20gfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8geyBsYWJlbDogZmxhZ3MubGFiZWwgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odGV4dCAhPT0gdW5kZWZpbmVkID8geyB0ZXh0IH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYSBjaGF0IG1lc3NhZ2UgZnJvbSB0aGUgYWdlbnQgKHByb3NlOiAtLWJvZHktZmlsZSA8cGF0aD4gb3IgLS1zdGRpbilcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNheVwiLCB0ZXh0OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcInNheVwiKSB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidmVyc2lvbi1kZWxldGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZOXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIHZlcnNpb24gYW5kIGl0cyBmaWxlIChuZXZlciB0aGUgYWN0aXZlIG9uZSDigJQgYWN0aXZhdGUgYW5vdGhlciBmaXJzdClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwidmVyc2lvbi5kZWxldGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwidmVyc2lvbi1kZWxldGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2tcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic3RkaW5cIiwgXCJib2R5LWZpbGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInNheSB5b3UgaGF2ZSBzdGFydGVkIHNvbWV0aGluZzsgcHJpbnRzIHRoZSBpZCB0byBmaW5pc2ggaXQgd2l0aFwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwidGFzay5zdGFydFwiLCB0ZXh0OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcInRhc2tcIikgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhc2stc3RhdHVzXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgICAgeyBuYW1lOiBcInN0YXR1c1wiLCByZXF1aXJlZDogdHJ1ZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInNheSB3aGF0IHN0ZXAgYSB0YXNrIGlzIG9uIChmb3Igd29yayB3b3J0aCB3YXRjaGluZylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suc3RhdHVzXCIsXG4gICAgICAgICAgaWQ6IHBvc1swXSBhcyBzdHJpbmcsXG4gICAgICAgICAgc3RhdHVzOiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIiksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLWRvbmVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwib3V0Y29tZVwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgdGFzayBmaW5pc2hlZCwgb3B0aW9uYWxseSBzYXlpbmcgd2hhdCBjYW1lIG9mIGl0XCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IG91dGNvbWUgPSBwb3Muc2xpY2UoMSkuam9pbihcIiBcIikudHJpbSgpO1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcInRhc2suZG9uZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLihvdXRjb21lID8geyBvdXRjb21lIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0YXNrLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImlkXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcImZvcmdldCBhIHRhc2sgZW50aXJlbHkg4oCUIGZvciBvbmUgc3RhcnRlZCBieSBtaXN0YWtlXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrLnJlbW92ZVwiLCBpZDogcG9zWzBdIGFzIHN0cmluZyB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwidGFza3MtY2xlYXJcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwiZm9yZ2V0IGV2ZXJ5IGZpbmlzaGVkIHRhc2s7IG91dHN0YW5kaW5nIG9uZXMgYXJlIGxlZnQgYWxvbmVcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJ0YXNrcy5jbGVhclwiIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3JraW5nXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZvclwiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwic2F5IHlvdSBhcmUgc3RpbGwgb24gaXQg4oCUIHNpbGVuY2VzIHRoZSB3YWl0aW5nIG51ZGdlLCBrZWVwcyB0aGUgaHVtYW4ncyBwdWxzZVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBzZWNvbmRzID1cbiAgICAgICAgdHlwZW9mIGZsYWdzLmZvciA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MuZm9yLCBcIndvcmtpbmcgLS1mb3JcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwid29ya2luZ1wiLFxuICAgICAgICAgIC4uLihzZWNvbmRzICE9PSB1bmRlZmluZWQgPyB7IHNlY29uZHMgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZG9jXCIsIFwicXVvdGVcIiwgXCJzdGRpblwiLCBcImJvZHktZmlsZVwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcIm5vdGUgYSBwYXNzYWdlIG9mIHRoZSBhY3RpdmUgdmVyc2lvbiAoLS1xdW90ZSAnZXhhY3QgdGV4dCc7IHByb3NlOiAtLWJvZHktZmlsZSBvciAtLXN0ZGluKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3MucXVvdGUgIT09IFwic3RyaW5nXCIgfHwgZmxhZ3MucXVvdGUudHJpbSgpID09PSBcIlwiKVxuICAgICAgICBkaWUoXCJub3RlOiAtLXF1b3RlIGlzIHJlcXVpcmVkIOKAlCB0aGUgZXhhY3QgdGV4dCB0aGUgbm90ZSBpcyBhYm91dFwiLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIHN0YXRlIC0tZnVsbCAodGhlIGFjdGl2ZSB2ZXJzaW9uJ3MgdGV4dCBpcyBvbiBkaXNrOyBxdW90ZSBmcm9tIGl0KVwiLFxuICAgICAgICB9KTtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmFkZFwiLFxuICAgICAgICAgIHF1b3RlOiBmbGFncy5xdW90ZSxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3MsIGZsYWdzLCBcIm5vdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5vdGVzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcInRoZSBub3RlcyBvbiBhIGRvY3VtZW50LCBwbGFjZWQgaW4gdGhlIGFjdGl2ZSB2ZXJzaW9uICgtLWZ1bGwgaW5jbHVkZXMgcmVzb2x2ZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3Rlc1wiLFxuICAgICAgICAgIC4uLihmbGFncy5mdWxsID8geyBhbGw6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1lZGl0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInN0ZGluXCIsIFwiYm9keS1maWxlXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiBmYWxzZSwgdmFyaWFkaWM6IHRydWUgfSxcbiAgICBdLFxuICAgIGRlc2NyaWJlOiBcInJld3JpdGUgd2hhdCBhIG5vdGUgc2F5cyAoaXRzIHBhc3NhZ2UgaXMgdW5jaGFuZ2VkKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLmVkaXRcIixcbiAgICAgICAgICBpZDogcG9zWzBdIGFzIHN0cmluZyxcbiAgICAgICAgICBib2R5OiBhd2FpdCByZWFkU2F5Qm9keShwb3Muc2xpY2UoMSksIGZsYWdzLCBcIm5vdGUtZWRpdFwiKSxcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibm90ZS1yZXNvbHZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcInJlb3BlblwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJtYXJrIGEgbm90ZSBkZWFsdCB3aXRoICgtLXJlb3BlbiBwdXRzIGl0IGJhY2spXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm5vdGUucmVzb2x2ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIHJlc29sdmVkOiAhZmxhZ3MucmVvcGVuLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJub3RlLXJlbW92ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiZGVsZXRlIGEgbm90ZVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJub3RlLnJlbW92ZVwiLFxuICAgICAgICAgIGlkOiBwb3NbMF0gYXMgc3RyaW5nLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJkaWZmXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiLCBcImNvbnRleHRcIiwgXCJwYXRjaFwiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjb21wYXJlIHRoZSBhY3RpdmUgdmVyc2lvbiB3aXRoIGFub3RoZXIgKHZOIG9yICdzYXZlZCcgZm9yIHRoZSBmaWxlIG9uIGRpc2spOyAtLXBhdGNoIGZvciBwbGFpbiB1bmlmaWVkIHRleHRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCByID0gKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgYWdhaW5zdDogcGFyc2VTaWRlKHBvc1swXSA/PyBcIlwiLCBcImRpZmZcIiksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuY29udGV4dCA9PT0gXCJzdHJpbmdcIlxuICAgICAgICAgID8geyBjb250ZXh0OiBwYXJzZUNvdW50KGZsYWdzLmNvbnRleHQsIFwiLS1jb250ZXh0XCIpIH1cbiAgICAgICAgICA6IHt9KSxcbiAgICAgIH0pKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIGlmIChmbGFncy5wYXRjaCkgcHJvY2Vzcy5zdGRvdXQud3JpdGUoU3RyaW5nKHIudW5pZmllZCA/PyBcIlwiKSk7XG4gICAgICBlbHNlIHByaW50SnNvbihyKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXJnZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIiwgXCJodW5rc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJhZ2FpbnN0XCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJ0YWtlIGNoYW5nZXMgZnJvbSBhbm90aGVyIHZlcnNpb24gaW50byB0aGUgYWN0aXZlIG9uZSAoLS1odW5rcyAxLDM7IGRlZmF1bHQ6IGFsbCBvZiB0aGVtKVwiLFxuICAgIHJ1bjogYXN5bmMgKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGFnYWluc3QgPSBwYXJzZVNpZGUocG9zWzBdID8/IFwiXCIsIFwibWVyZ2VcIik7XG4gICAgICAvLyDim5QgV2l0aG91dCAtLWh1bmtzIHRoaXMgdGFrZXMgRVZFUlkgaHVuaywgd2hpY2ggaXMgdGhlIHdob2xlLWRvY3VtZW50XG4gICAgICAvLyBtZXJnZS4gVGhlIGlkcyBjb21lIGZyb20gYGRpZmZgIGFuZCBhcmUgb25seSB2YWxpZCBhZ2FpbnN0IHRoZSB0ZXh0IGl0XG4gICAgICAvLyBzYXc6IHRoZSBkYWVtb24gcmUtZGlmZnMgYW5kIHJlZnVzZXMgaWRzIGl0IGNhbm5vdCBmaW5kIHJhdGhlciB0aGFuXG4gICAgICAvLyBhcHBseWluZyBhIG51bWJlciB0byBhIGRvY3VtZW50IHRoYXQgaGFzIG1vdmVkIHVuZGVybmVhdGggaXQuXG4gICAgICBjb25zdCBsaXN0ZWQgPVxuICAgICAgICB0eXBlb2YgZmxhZ3MuaHVua3MgPT09IFwic3RyaW5nXCJcbiAgICAgICAgICA/IGZsYWdzLmh1bmtzLnNwbGl0KFwiLFwiKS5tYXAoKGgpID0+IHBhcnNlQ291bnQoaCwgXCItLWh1bmtzXCIpKVxuICAgICAgICAgIDogbnVsbDtcbiAgICAgIGNvbnN0IGh1bmtzID1cbiAgICAgICAgbGlzdGVkID8/XG4gICAgICAgIChcbiAgICAgICAgICAoYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgICB0eXBlOiBcImRpZmZcIixcbiAgICAgICAgICAgIGFnYWluc3QsXG4gICAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICAgIH0pKSBhcyB7IGh1bmtzPzogeyBpZDogbnVtYmVyIH1bXSB9XG4gICAgICAgICkuaHVua3M/Lm1hcCgoaCkgPT4gaC5pZCkgPz9cbiAgICAgICAgW107XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwibWVyZ2VcIixcbiAgICAgICAgICBhZ2FpbnN0LFxuICAgICAgICAgIGh1bmtzLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZG9jID09PSBcInN0cmluZ1wiID8geyBkb2M6IGRvY0FyZyhmbGFncy5kb2MpIH0gOiB7fSksXG4gICAgICAgIH0pLFxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJhY3RpdmF0ZVwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJkb2NcIl0sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwidk5cIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwibWFrZSBhIHZlcnNpb24gdGhlIGFjdGl2ZSBvbmUgKHRoZSBvbmUgdGhlIGh1bWFuIGVkaXRzIGFuZCBTYXZlIHdyaXRlcylcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiYWN0aXZhdGVcIixcbiAgICAgICAgICB2ZXJzaW9uOiBwYXJzZVZlcnNpb24ocG9zWzBdID8/IFwiXCIsIFwiYWN0aXZhdGVcIiksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy5kb2MgPT09IFwic3RyaW5nXCIgPyB7IGRvYzogZG9jQXJnKGZsYWdzLmRvYykgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm5ldy1kb2NcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJjcmVhdGUgYW4gZW1wdHkgZG9jdW1lbnQgKGl0cyBmb2xkZXIgbXVzdCBiZSBhIHNldCwgYSBmb2xkZXIgaW4gb25lLCBvciB0aGUgd29ya3NwYWNlKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBhYnMgPSByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpO1xuICAgICAgcmV0dXJuIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiZG9jLmNyZWF0ZVwiLCBkaXI6IGRpcm5hbWUoYWJzKSwgbmFtZTogYmFzZW5hbWUoYWJzKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJuZXctZm9sZGVyXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjcmVhdGUgYSBmb2xkZXIg4oCUIGluc2lkZSBhIHNldCwgb3IgaW4gdGhlIHdvcmtzcGFjZSBhcyBhIG5ldyBzZXRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgY29uc3QgYWJzID0gcmVzb2x2ZShwb3NbMF0gYXMgc3RyaW5nKTtcbiAgICAgIHJldHVybiBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcImZvbGRlci5jcmVhdGVcIixcbiAgICAgICAgZGlyOiBkaXJuYW1lKGFicyksXG4gICAgICAgIG5hbWU6IGJhc2VuYW1lKGFicyksXG4gICAgICB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtb3ZlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwiaW50b1wiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwibW92ZSBhIGRvY3VtZW50IG9yIGZvbGRlciBpbnRvIGFub3RoZXIgZm9sZGVyIChhIHJlYWwgbW92ZSBvbiBkaXNrKVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PlxuICAgICAgc3RydWN0dXJlQ21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJtb3ZlXCIsXG4gICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgIGludG86IHJlc29sdmUocG9zWzFdIGFzIHN0cmluZyksXG4gICAgICB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwicmVuYW1lXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFtcbiAgICAgIHsgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwibmFtZVwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIF0sXG4gICAgZGVzY3JpYmU6IFwicmVuYW1lIGEgZG9jdW1lbnQgb3IgZm9sZGVyIGluIHBsYWNlXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInJlbmFtZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBuYW1lOiBwb3NbMV0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJwYXRoXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgIGRlc2NyaWJlOiBcInJlbW92ZSBhIGRvY3VtZW50LCBmb2xkZXIgb3Igc2V0IGZyb20gU2NyaXB0b3JpdW0g4oCUIHRoZSBmaWxlcyBzdGF5IG9uIGRpc2tcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwiaGlkZVwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ1bmhpZGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJlbnRyeVwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJicmluZyBiYWNrIGV2ZXJ5dGhpbmcgaGlkZGVuIGluIGEgc2V0IChpdHMgZW50cnkgaWQsIGZyb20gc3RhdGUpXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHN0cnVjdHVyZUNtZChzZXNzaW9uLCB7IHR5cGU6IFwidW5oaWRlXCIsIGVudHJ5OiBwb3NbMF0gfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcIm1ha2Utc2V0XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJ0dXJuIGEgc2luZ2xlIGRvY3VtZW50IGludG8gYSBzZXQ6IGEgZm9sZGVyIG5hbWVkIGZvciBpdCwgdGhlIGRvY3VtZW50IG1vdmVkIGluXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+XG4gICAgICBzdHJ1Y3R1cmVDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNldC5tYWtlXCIsIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZykgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImltcG9ydFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJpbnRvXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImZpbGVcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwiY29weSBhIGRvY3VtZW50IGluIChkZWZhdWx0OiBpbnRvIHRoZSB3b3Jrc3BhY2UpIGFuZCBzaG93IHRoZSBjb3B5XCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZEltcG9ydChwb3NbMF0gYXMgc3RyaW5nLCB0eXBlb2YgZmxhZ3MuaW50byA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmludG8gOiB1bmRlZmluZWQsIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ3b3Jrc3BhY2VcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJkaXJcIiwgcmVxdWlyZWQ6IGZhbHNlIH1dLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSB3b3Jrc3BhY2UgKHdoZXJlIGRyb3BzIGFuZCBuZXcgdG9wLWxldmVsIGRvY3VtZW50cyBsYW5kKSwgb3Igc2V0IGl0XCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IGNtZFdvcmtzcGFjZShwb3NbMF0sIHNlc3Npb24pLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFt7IG5hbWU6IFwicGF0aFwiLCByZXF1aXJlZDogZmFsc2UgfV0sXG4gICAgZGVzY3JpYmU6IFwiYSBkb2N1bWVudCdzIGZyb250bWF0dGVyIGFzIHRoZSBkYWVtb24gcmVhZCBpdCAobm8gcGF0aDogZXZlcnkgY29udGV4dCBkb2N1bWVudClcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGFcIixcbiAgICAgICAgICAuLi4ocG9zWzBdICE9PSB1bmRlZmluZWQgPyB7IHBhdGg6IHJlc29sdmUocG9zWzBdKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZmluZFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCIsIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJkb2N1bWVudHMgYnkgZnJvbnRtYXR0ZXIg4oCUIGZpbHRlcnMgQU5ELCBhbGwgb3B0aW9uYWw7IGFuIGVtcHR5IHJlc3VsdCBpcyBhbiBhbnN3ZXIgKGNvdW50KVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBmaWx0ZXI6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgICAgIGZvciAoY29uc3QgayBvZiBbXCJ0eXBlXCIsIFwic3RhdHVzXCIsIFwibGlmZWN5Y2xlXCIsIFwidGFnXCJdIGFzIGNvbnN0KVxuICAgICAgICBpZiAodHlwZW9mIGZsYWdzW2tdID09PSBcInN0cmluZ1wiKSBmaWx0ZXJba10gPSBmbGFnc1trXTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIpIGZpbHRlci5zaW5jZSA9IHBhcnNlU2luY2VEYXRlKGZsYWdzLnNpbmNlKTtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJmaW5kXCIsIGZpbHRlciB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VhcmNoXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImxpbWl0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInF1ZXJ5XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwic2VhcmNoIHRoZSBjb250ZXh0OiBmdXp6eSBvbiBuYW1lcywgZXhhY3QgaW4gdGV4dCDigJQgc2VhcmNoZXMgdGhlIEFDVElWRSB2ZXJzaW9uIG9mIG9wZW4gZG9jdW1lbnRzLCB3aGljaCBncmVwIGNhbm5vdCBzZWVcIixcbiAgICBydW46IGFzeW5jIChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBsaW1pdCA9XG4gICAgICAgIHR5cGVvZiBmbGFncy5saW1pdCA9PT0gXCJzdHJpbmdcIiA/IHBhcnNlQ291bnQoZmxhZ3MubGltaXQsIFwic2VhcmNoIC0tbGltaXRcIikgOiB1bmRlZmluZWQ7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwic2VhcmNoXCIsXG4gICAgICAgICAgcXVlcnk6IHBvcy5qb2luKFwiIFwiKSxcbiAgICAgICAgICAuLi4obGltaXQgIT09IHVuZGVmaW5lZCA/IHsgbGltaXQgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImRvY3RvclwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTpcbiAgICAgIFwid2hhdCBpcyB3b3J0aCBsb29raW5nIGF0IGluIHRoaXMgc2Vzc2lvbiDigJQgZWFjaCBmaW5kaW5nIG5hbWVzIHRoZSB2ZXJiIHRoYXQgZml4ZXMgaXRcIixcbiAgICBydW46IGFzeW5jIChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJkb2N0b3JcIiB9KSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZm9yZ2V0XCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImRvY1wiXSxcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImZvcmdldCBhIGRvY3VtZW50IHdob3NlIGZpbGUgb2YgcmVjb3JkIGlzIGdvbmUgKHJlZnVzZWQgd2hpbGUgdGhlIGZpbGUgZXhpc3RzIOKAlCB1c2UgaGlkZSB0byB0YWtlIG9uZSBvdXQgb2YgdGhlIGNvbnRleHQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJmb3JnZXRcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmRvYyA9PT0gXCJzdHJpbmdcIiA/IHsgZG9jOiBkb2NBcmcoZmxhZ3MuZG9jKSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZGFuZ2xpbmdcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOiBcImxpbmtzIGluIGEgc2V0IHRoYXQgbm90aGluZyBhbnN3ZXJzIOKAlCBmaWxlLCBsaW5lLCBhbmQgdGhlIHRhcmdldCBhcyB3cml0dGVuXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIHByaW50SnNvbihcbiAgICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgICAgdHlwZTogXCJkYW5nbGluZ1wiLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuZW50cnkgPT09IFwic3RyaW5nXCIgPyB7IGVudHJ5OiBmbGFncy5lbnRyeSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ3JhcGhcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwiZW50cnlcIl0sXG4gICAgcG9zaXRpb25hbHM6IFtdLFxuICAgIGRlc2NyaWJlOlxuICAgICAgXCJhIHNldCdzIG1hcCBhcyBKU09OIOKAlCBub2RlcywgZWRnZXMgKGJvZHkgbGlua3MgYW5kIGZyb250bWF0dGVyIGtlcHQgYXBhcnQpLCBkYW5nbGluZ1wiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBwcmludEpzb24oXG4gICAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICAgIHR5cGU6IFwiZ3JhcGhcIixcbiAgICAgICAgICAuLi4odHlwZW9mIGZsYWdzLmVudHJ5ID09PSBcInN0cmluZ1wiID8geyBlbnRyeTogZmxhZ3MuZW50cnkgfSA6IHt9KSxcbiAgICAgICAgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImJhY2tsaW5rc1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6IFwid2hhdCBjaXRlcyBhIGRvY3VtZW50IOKAlCBgcmVsYXRlZGAgKGZyb250bWF0dGVyKSBhbmQgYGxpbmtzYCAoYm9keSksIGtlcHQgYXBhcnRcIixcbiAgICBydW46IGFzeW5jIChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImJhY2tsaW5rc1wiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpIH0pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJtZXRhLWluaXRcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwidHlwZVwiLCBcImJ5XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6XG4gICAgICBcImFkZCBhIGZyb250bWF0dGVyIGJsb2NrIHRvIGEgZG9jdW1lbnQgdGhhdCBoYXMgbm9uZSAodHlwZSBndWVzc2VkIGZyb20gaXRzIG5laWdoYm91cnMpXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgICB0eXBlOiBcIm1ldGEuaW5pdFwiLFxuICAgICAgICAgIHBhdGg6IHJlc29sdmUocG9zWzBdIGFzIHN0cmluZyksXG4gICAgICAgICAgLi4uKHR5cGVvZiBmbGFncy50eXBlID09PSBcInN0cmluZ1wiID8geyBtZXRhVHlwZTogZmxhZ3MudHlwZSB9IDoge30pLFxuICAgICAgICAgIC4uLih0eXBlb2YgZmxhZ3MuYnkgPT09IFwic3RyaW5nXCIgPyB7IGJ5OiBmbGFncy5ieSB9IDoge30pLFxuICAgICAgICB9KSxcbiAgICAgICk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwibWV0YS1zZXRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW1xuICAgICAgeyBuYW1lOiBcInBhdGhcIiwgcmVxdWlyZWQ6IHRydWUgfSxcbiAgICAgIHsgbmFtZTogXCJrZXk9dmFsdWVcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzZXQgZnJvbnRtYXR0ZXIga2V5cyDigJQgb25lIGxpbmUgZWRpdCBlYWNoLCBldmVyeXRoaW5nIGVsc2UgdW50b3VjaGVkXCIsXG4gICAgcnVuOiBhc3luYyAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgICAgZm9yIChjb25zdCBwYWlyIG9mIHBvcy5zbGljZSgxKSkge1xuICAgICAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgICAgIGlmIChlcSA8PSAwKVxuICAgICAgICAgIGRpZShgXCIke3BhaXJ9XCIgaXMgbm90IGtleT12YWx1ZWAsIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgaGludDogXCJtZXRhLXNldCA8cGF0aD4gc3RhdHVzPXN0YWJsZSBsaWZlY3ljbGU9bGl2ZVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICBmaWVsZHNbcGFpci5zbGljZSgwLCBlcSldID0gcGFpci5zbGljZShlcSArIDEpO1xuICAgICAgfVxuICAgICAgcHJpbnRKc29uKFxuICAgICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJtZXRhLnNldFwiLCBwYXRoOiByZXNvbHZlKHBvc1swXSBhcyBzdHJpbmcpLCBmaWVsZHMgfSksXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogW10sXG4gICAgZGVzY3JpYmU6IFwicHJpbnQgdGhlIHJlc29sdmVkIHNlc3Npb24gcG9pbnRlclwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgcHJpbnRKc29uKHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJjbG9zZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICBkZXNjcmliZTogXCJzaHV0IHRoZSBzZXNzaW9uIGRvd24gKHRoZSBtYW5pZmVzdCBzdGF5cywgZm9yIG9wZW4gLS1yZXN0b3JlKVwiLFxuICAgIHJ1bjogYXN5bmMgKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4ge1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgfSxcbiAgfSxcbl07XG5cbi8vIOKblCBCVUlMRElORyBUSEUgVEFCTEUgSEFTIE5PIFNJREUgRUZGRUNUUzogYGRlZmluZUNsaWAgb25seSB2YWxpZGF0ZXMgYW5kXG4vLyBpbmRleGVzLCBzbyBhIHdhcmQgb3IgYSB0ZXN0IGNhbiBpbXBvcnQgdGhpcyBtb2R1bGUgYW5kIHJlYWQgdGhlIHRhYmxlLlxuZXhwb3J0IGNvbnN0IGNsaSA9IGRlZmluZUNsaSh7XG4gIG5hbWU6IFwic2NyaXB0b3JpdW1cIixcbiAgc3VtbWFyeTogXCJhIGNvLXByZXNlbnQgbWFya2Rvd24gZWRpdG9yOiB0aGUgaHVtYW4gZWRpdHMsIHlvdSB3cml0ZSBuZXcgdmVyc2lvbnMuXCIsXG4gIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICBjb21tYW5kczogUk9XUy5tYXAoKHIpID0+ICh7IC4uLnIsIHJ1bjogb24oci5ydW4pLCByZWplY3RIaW50OiBEQVNIX0hJTlQgfSkpLFxuICAvLyBgc2NyaXB0b3JpdW0gLS1zZXNzaW9uIHggc3RhdGVgIHJ1bnMgYHN0YXRlYDsgYSBiYXJlIGAtLWAgbWFrZXMgdGhlIG5leHRcbiAgLy8gdG9rZW4gdGhlIHZlcmIgKGFjYyBBNikuXG4gIGdyYW1tYXI6IFwiZmxhZ3MtYW55d2hlcmVcIixcbiAgdmVyYlBvc2l0aW9uYWw6IFwidmVyYlwiLFxuICB1c2FnZUhpZGVzOiBbXCJzZXNzaW9uXCJdLFxuICB2ZXJzaW9uOiB2ZXJzaW9uSW5mbyxcbiAgaGVscEZvb3RlcjogYCAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIGFueSB2ZXJiIHRoYXQgdGFsa3MgdG8gYSBzZXNzaW9uIChkZWZhdWx0OiBtb3N0IHJlY2VudCkuXG4gIEVhY2ggdmVyYiBhY2NlcHRzIG9ubHkgdGhlIGZsYWdzIG9uIGl0cyByb3cuXG5cbiAgT3V0cHV0OiBKU09OIG9uIHN0ZG91dCwgb25lIGRvY3VtZW50IHBlciBhbnN3ZXIg4oCUIGV4Y2VwdCB0YWlsIChvbmUgSlNPTiBsaW5lXG4gIHBlciBldmVudCkgYW5kIGhlbHAgKHByb3NlKS4gRmFpbHVyZXM6IG9uZSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciwgZXhpdFxuICAyID0gdXNhZ2UsIDEgPSBpbnRlcm5hbCwgNSA9IG5vdCBmb3VuZCwgNiA9IGNvbmZsaWN0LiB0YWlsIHdhaXRzIGZvciBhXG4gIHNlc3Npb24gcmF0aGVyIHRoYW4gZmFpbGluZywgYW5kIGVuZHMgMCB3aGVuIGl0cyBzZXNzaW9uIGNsb3Nlcy4gdGFpbFxuICAke1dJTkRPV19IRUxQfS5gLFxufSk7XG5cbmV4cG9ydCBjb25zdCBWRVJCUzogcmVhZG9ubHkgc3RyaW5nW10gPSBjbGkudmVyYnM7XG5leHBvcnQgY29uc3QgVkVSQl9TUEVDOiBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSBzdHJpbmdbXT4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gIGNsaS5yb3dzLm1hcCgocikgPT4gW3IubmFtZSwgci5hY2NlcHRlZF0pLFxuKTtcbmV4cG9ydCBjb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBzdHJpbmcpOiBzdHJpbmdbXSA9PiBjbGkuZmxhZ3NGb3IodmVyYik7XG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUzogcmVhZG9ubHkgc3RyaW5nW10gPSBjbGkucmVjb2duaXplZEZsYWdzO1xuXG4vLyBgZGlzcGF0Y2hgLCBub3QgdGhlIHJlZ2lzdHJ5J3MgYG1haW5gOiB0aGUga2l0IGRvZXMgbm90IHRyaWFnZSBhIG5vbi1DbGlFcnJvcjtcbi8vIHRoaXMgZG9lcy4gQSBuYW1lZCBmaWxlIHRoYXQgaXMgbm90IHRoZXJlICgtLWJvZHktZmlsZSkgaXMgdGhlIGNhbGxlcidzO1xuLy8gZXZlcnl0aGluZyBlbHNlIGlzIG91cnMuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgY2xpLmRpc3BhdGNoKGFyZ3YpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgcmVwb3J0ZWQgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAocmVwb3J0ZWQgIT09IG51bGwpIHJldHVybiByZXBvcnRlZDtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBVc2FnZUVycm9yKG1zZykpID8/IDI7XG4gICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIG1zZykpID8/IDE7XG4gIH1cbn1cblxuLyoqXG4gKiBUaGUgQ0xJJ3MgZW50cnksIGZvciB0aGUgTEFVTkNIRVIuIFJldHVybnMgdGhlIGNvZGUgcmF0aGVyIHRoYW4gZXhpdGluZ1xuICogKHN0ZG91dCBpcyBhIHBpcGU7IGFuIGV4cGxpY2l0IGV4aXQgdHJ1bmNhdGVzIGl0KSwgYW5kIHRha2VzIG5vIGFyZ3VtZW50c1xuICogKHRoZSBjb21tYW5kIGxpbmUgYmVsb25ncyB0byB0aGUgZmlsZSB0aGF0IHBhcnNlcyBpdCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgcmVnaXN0cnk6IG9uZSB0YWJsZSBkcml2ZXMgdGhlIHBhcnNlciwgdGhlIGRpc3BhdGNoZXIsXG4gKiBoZWxwLCB0aGUgcmVqZWN0aW9ucycgYGNob2ljZXNgLCBgLS12ZXJzaW9uYCBhbmQgdGhlIGFjYyBkZWNsYXJhdGlvblxuICogKGBzY2hlbWFgLCBmb3JtYXQgdjApLlxuICpcbiAqIEdlbmVyYWxpc2VkIGZyb20gdGhlIHRocmVlIGhhbmQtYnVpbHQgcmVnaXN0cmllcyAoZ3JhcGV2aW5lLCBnbGFtb3VyLFxuICogc2NyaXB0b3JpdW0pIHBlciBgZG9jcy9pdGVtcy9zaGFyZWQtY2xpLXJlZ2lzdHJ5LWluLXRoZS1raXQvd3JpdGUtdXAubWRgLCBhc1xuICogYW1lbmRlZCBieSBpdHMgY29sZCByZWFkIChg4oCmL2FydGlmYWN0cy9jb2xkLXJlYWQubWRgKS4gV2hlcmUgdGhleSBkaXNhZ3JlZWQsXG4gKiB0aGUgY29sZCByZWFkIHdvbi5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIFRoaXMgbW9kdWxlIGltcG9ydHMgb25seSBgbm9kZTp1dGlsYCBhbmQgb3RoZXIga2l0XG4gKiBtb2R1bGVzIChgLi4vd2lyZS9lcnJvcnNgLCBgLi4vbGliL3ByaW50SnNvbmApLlxuICpcbiAqIOKblCBOTyBTSURFIEVGRkVDVFMgQVQgSU1QT1JULCBBTkQgTk9ORSBJTiBgZGVmaW5lQ2xpYC4gQnVpbGRpbmcgdGhlIHRhYmxlIG9ubHlcbiAqIHZhbGlkYXRlcyBhbmQgaW5kZXhlcyBpdDsgbm90aGluZyBpcyBwYXJzZWQsIHByaW50ZWQgb3IgcmVhZCB1bnRpbCBgbWFpbmAgb3JcbiAqIGBkaXNwYXRjaGAgaXMgY2FsbGVkLiBBIGdyaW1vaXJlIHdhcmQgY2FuIGltcG9ydCBhIHNwZWxsJ3MgdGFibGUgYW5kIHJlYWRcbiAqIGByZWNvZ25pemVkRmxhZ3NgLCBgZmxhZ3NGb3JgLCBgdmVyYnNgIGFuZCBgZGVjbGFyYXRpb24oKWAgd2l0aG91dCBydW5uaW5nIGl0LlxuICpcbiAqIOKUgOKUgCBUSEUgQ09OVFJBQ1QgQSBTUEVMTCBDQU5OT1QgQ0hBTkdFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIDEuIGAtLWhlbHBgL2AtaGAgYW5kIGAtLXZlcnNpb25gL2AtVmAgYXMgYGFyZ3ZbMF1gIHJ1biB0aGUgYGhlbHBgIG9yXG4gKiAgICBgdmVyc2lvbmAgcm93IGFuZCBQQVNTIFRIRSBSRU1BSU5JTkcgQVJHVU1FTlRTIE9OIHRvIGl0LCBzbyB0aGF0IHJvdydzIG93blxuICogICAgZmxhZyBjaGVjayBhcHBsaWVzOiBgLS12ZXJzaW9uIC0taHVtYW5gIHdvcmtzIHdoZXJlIGB2ZXJzaW9uYCBhY2NlcHRzXG4gKiAgICBgLS1odW1hbmAsIGFuZCBgLS12ZXJzaW9uIC0tanVua2AgaXMgZXhpdCAyIHdoZXJlIGl0IGRvZXMgbm90LlxuICogMi4gRW1wdHkgYXJndiBpcyBhIHVzYWdlIGVycm9yIChhY2MgQzIvRDI6IG9uZSBlbnZlbG9wZSBvbiBzdGRlcnIsIGV4aXQgMixcbiAqICAgIGBjaG9pY2VzYCA9IHRoZSB2ZXJicykg4oCUIHVubGVzcyB0aGUgQ0xJIGhhcyBhIHZlcmJsZXNzIGByb290YCByb3cgdGhhdFxuICogICAgYWNjZXB0cyBhbiBlbXB0eSBhcmd2IChubyByZXF1aXJlZCBwb3NpdGlvbmFsczsgZmxhZ3MgZGVmYXVsdGVkKS5cbiAqIDMuIFRoZSB2ZXJiIGlzIGZvdW5kIHBlciB0aGUgZ3JhbW1hcjpcbiAqICAgIC0gYHZlcmItZmlyc3RgIChkZWZhdWx0KTogYGFyZ3ZbMF1gLiBBIGRhc2gtbGVkIGBhcmd2WzBdYCB0aGF0IGlzIG5vdCBhblxuICogICAgICBpbnRlcmNlcHRvciBpcyBhbiB1bmtub3duIFJPT1QgZmxhZyAoYGNob2ljZXNgID0gdGhlIGludGVyY2VwdG9ycywgbG9uZ1xuICogICAgICBmaXJzdCkuIEZsYWdzIGJlZm9yZSB0aGUgdmVyYiBhcmUgcmVmdXNlZCwgaW5jbHVkaW5nIGdsb2JhbCBvbmVzLlxuICogICAgLSBgZmxhZ3MtYW55d2hlcmVgOiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmdcbiAqICAgICAgZmxhZydzIHZhbHVlIChgZ2xhbW91ciAtLXNlc3Npb24geCBpbmZvYCBydW5zIGBpbmZvYCkuIFRoZVxuICogICAgICB1bmtub3duLXJvb3QtZmxhZyBydWxlIGRvZXMgTk9UIGFwcGx5OyBhbiBhcmd2IHdpdGggbm8gdmVyYiBpbiBpdCBpc1xuICogICAgICBwYXJzZWQgd2hvbGUsIHNvIGFuIHVua25vd24gZmxhZyB0aGVyZSBpcyByZWZ1c2VkIHdpdGggdGhlIHJvb3QncyBzZXQuXG4gKiAgICBJbiBib3RoLCBhIGJhcmUgYC0tYCBiZWZvcmUgdGhlIHZlcmIgbWFrZXMgdGhlIE5FWFQgdG9rZW4gdGhlIHZlcmJcbiAqICAgIGNhbmRpZGF0ZSBhbmQgZXZlcnl0aGluZyBhZnRlciBpdCBwb3NpdGlvbmFsIChhY2MgQTYpOiBgY2xpIC0tIC0teGAgaXNcbiAqICAgIGB1bmtub3duIGNvbW1hbmQgXCItLXhcImAsIG5ldmVyIGFuIG9wdGlvbi5cbiAqIDQuIE5lc3RpbmcgaXMgb25lIGxldmVsOiBhIHJvdyBuYW1lZCBgXCJub2RlIGVkaXRcImAuIFRoZSBzdWItdmVyYiBvZiBhIGdyb3VwXG4gKiAgICBpcyBmb3VuZCBieSB0aGUgZ3JvdXAncyBgc3ViVmVyYkF0YCAoc2VlIGBHcm91cFNwZWNgKS4gQSBncm91cCB3aXRoIG5vIHJvd1xuICogICAgb2YgaXRzIG93biByZWplY3RzIGEgbWlzc2luZyBvciB1bmtub3duIHN1Yi12ZXJiIHdpdGggaXRzIHN1Yi12ZXJicyBhc1xuICogICAgYGNob2ljZXNgOyBhIGdyb3VwIFdJVEggaXRzIG93biByb3cgKGBkb2MgPGlkPmApIHJ1bnMgdGhhdCByb3cgaW5zdGVhZC5cbiAqIDUuIFRoZSByb3cncyBhcmdzIGFyZSBwYXJzZWQgc3RyaWN0IGFnYWluc3QgdGhlIFdIT0xFIG9wdGlvbnMgdGFibGUgKHdpdGhcbiAqICAgIGBkZWZhdWx0YHMgc3RyaXBwZWQpLCBzbyBhIGZsYWcgdGhlIHNwZWxsIGtub3dzIGJ1dCB0aGlzIHJvdyBkb2VzIG5vdCB0YWtlXG4gKiAgICBpcyByZWZ1c2VkIGFzIE1JU1BMQUNFRCAoYC0teCBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgdmVyYlxcYGApLCBhbmQgb25lIHRoZVxuICogICAgc3BlbGwgZG9lcyBub3Qga25vdyBhcyBVTktOT1dOLiBCb3RoIGNhcnJ5IGBjaG9pY2VzYCA9IHRoaXMgcm93J3MgYWNjZXB0ZWRcbiAqICAgIHNldCAoaXRzIG93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2A7IGEgdmVyYmxlc3Mgcm9vdCdzIGFkZHMgdGhlXG4gKiAgICBpbnRlcmNlcHRvcnMsIGFzIGl0cyBkZWNsYXJlZCByb3cgZG9lcykuIEFmdGVyIGEgYC0tYCBldmVyeXRoaW5nIGlzIGFcbiAqICAgIHBvc2l0aW9uYWwgKG5vZGUncyBwYXJzZXIgaG9ub3VycyBpdCkuIEEgcG9zdC1gLS1gIHRva2VuIHRoYXQgc3BlbGxzIGFcbiAqICAgIGZsYWcgdGhpcyByb3cgYWNjZXB0cyBpcyBzdGlsbCBhIHBvc2l0aW9uYWwsIGJ1dCBpdCBlYXJucyBvbmVcbiAqICAgIGAjIHdhcm5pbmc6YCBsaW5lIG9uIHN0ZGVyciBuYW1pbmcgdGhlIHJlY292ZXJ5IChgd2FybkRlbW90ZWRgKTsgc3Rkb3V0XG4gKiAgICBhbmQgdGhlIGV4aXQgY29kZSBhcmUgdW5jaGFuZ2VkLlxuICogNi4gRGVmYXVsdHMgYXJlIGFwcGxpZWQgQUZURVIgdGhlIHBlci1yb3cgY2hlY2ssIGFuZCBvbmx5IGZvciBmbGFncyB0aGUgcm93XG4gKiAgICBhY2NlcHRzIOKAlCBzbyBhIGRlZmF1bHRlZCBmbGFnIG5ldmVyIHRyaXBzIHRoZSBtaXNwbGFjZWQtZmxhZyBjaGVjaywgYW5kIGFcbiAqICAgIHJvdyBuZXZlciBzZWVzIGFub3RoZXIgcm93J3MgZGVmYXVsdC5cbiAqIDcuIEFyaXR5IGlzIGVuZm9yY2VkIGZyb20gYHBvc2l0aW9uYWxzYDsgdGhlIHJlamVjdGlvbiBuYW1lcyB0aGUgbWlzc2luZ1xuICogICAgYDxwb3NpdGlvbmFsPmAgb3IgdGhlIGV4dHJhIHRva2VuLiBBIHJvdydzIGBjaGVja2AgbWF5IHRoZW4gcmVmdXNlIGFcbiAqICAgIGNvbWJpbmF0aW9uIHRoZSBkZWNsYXJhdGlvbiBjYW5ub3QgZXhwcmVzcyAoZmxhZy1kZXBlbmRlbnQgYXJpdHkpLlxuICogOC4gVGhlIHJvdyBydW5zOyBhIG51bWJlciBpdCByZXR1cm5zIGlzIHRoZSBleGl0IGNvZGUsIGFueXRoaW5nIGVsc2UgaXMgMC5cbiAqXG4gKiBUaGUgbW9kdWxlIGFkZHMgYGhlbHBgLCBgdmVyc2lvbmAgYW5kIGBzY2hlbWFgIHJvd3MgdW5sZXNzIHRoZSBzcGVsbCBkZWZpbmVzXG4gKiBhIHJvdyBvZiB0aGF0IG5hbWUgKGdyYXBldmluZSdzIGB2ZXJzaW9uIC0taHVtYW5gKS4gVGhleSBhcmUgb3JkaW5hcnkgcm93czpcbiAqIGRlY2xhcmVkLCBzdHJpY3QsIGFuZCBnaXZlbiBgZ2xvYmFsRmxhZ3NgIGxpa2UgZXZlcnkgb3RoZXIgcm93LlxuICovXG5cbmltcG9ydCB7IHBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBDbGlFcnJvciwgZGllLCByZXBvcnRDbGlFcnJvciwgc2V0Q3VycmVudENvbW1hbmQgfSBmcm9tIFwiLi4vd2lyZS9lcnJvcnNcIjtcblxuLy8g4pSA4pSAIHR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgdHlwZSBGbGFnVHlwZSA9IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjtcblxuLyoqIE9uZSBgcGFyc2VBcmdzYCBvcHRpb24sIHBsdXMgdGhlIGBkZWZhdWx0YCBub2RlJ3MgcGFyc2VyIGFsc28gdGFrZXMuICovXG5leHBvcnQgdHlwZSBPcHRpb25TcGVjID0ge1xuICB0eXBlOiBGbGFnVHlwZTtcbiAgbXVsdGlwbGU/OiBib29sZWFuO1xuICBzaG9ydD86IHN0cmluZztcbiAgZGVmYXVsdD86IHN0cmluZyB8IGJvb2xlYW4gfCByZWFkb25seSBzdHJpbmdbXSB8IHJlYWRvbmx5IGJvb2xlYW5bXTtcbn07XG5cbmV4cG9ydCB0eXBlIE9wdGlvbnNUYWJsZSA9IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIE9wdGlvblNwZWM+PjtcblxuZXhwb3J0IHR5cGUgUG9zaXRpb25hbFNwZWMgPSB7IG5hbWU6IHN0cmluZzsgcmVxdWlyZWQ6IGJvb2xlYW47IHZhcmlhZGljPzogYm9vbGVhbiB9O1xuXG5leHBvcnQgdHlwZSBGbGFnVmFsdWUgPSBzdHJpbmcgfCBib29sZWFuIHwgKHN0cmluZyB8IGJvb2xlYW4pW107XG5cbmV4cG9ydCB0eXBlIEludm9jYXRpb248RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSB7XG4gIC8qKiBUaGUgcmVzb2x2ZWQgcm93IG5hbWU6IGBcIm9wZW5cImAsIGBcIm5vZGUgZWRpdFwiYCwgb3IgYFwiXCJgIGZvciBhIHZlcmJsZXNzIHJvb3QuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzcGVsbGluZyB0aGUgY2FsbGVyIHVzZWQg4oCUIGFuIGFsaWFzLCB3aGVuIG9uZSB3YXMgdXNlZC4gKi9cbiAgdG9rZW46IHN0cmluZztcbiAgLyoqIFBvc2l0aW9uYWxzIGFmdGVyIHRoZSBwYXRoLiAqL1xuICBwb3M6IHN0cmluZ1tdO1xuICAvKiogRmxhZ3MgZ2l2ZW4sIHBsdXMgdGhlIGRlZmF1bHRzIG9mIHRoZSBmbGFncyB0aGlzIHJvdyBhY2NlcHRzLiAqL1xuICBmbGFnczogUGFydGlhbDxSZWNvcmQ8RiwgRmxhZ1ZhbHVlPj47XG59O1xuXG5leHBvcnQgdHlwZSBDb21tYW5kU3BlYzxGIGV4dGVuZHMgc3RyaW5nID0gc3RyaW5nPiA9IHtcbiAgLyoqIGBcIm9wZW5cImA7IG9uZSBzcGFjZSBtZWFucyBvbmUgbGV2ZWwgb2YgbmVzdGluZzogYFwibm9kZSBlZGl0XCJgLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBFYWNoIGFsaWFzIGlzIGRpc3BhdGNoYWJsZSwgbGlzdGVkIGluIGB2ZXJic2AsIGFuZCBnZXRzIGl0cyBvd24gZGVjbGFyZWRcbiAgICogIHJvdy4gQW4gYWxpYXMgb2YgYSBuZXN0ZWQgcm93IG11c3Qgc2hhcmUgaXRzIGdyb3VwOiBgXCJub2RlIGNoYW5nZVwiYC4gKi9cbiAgYWxpYXNlcz86IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhpcyByb3cncyBvd24gZmxhZ3M7IGBnbG9iYWxGbGFnc2AgYXJlIGFkZGVkIHRvIHRoZW0uICovXG4gIGZsYWdzOiByZWFkb25seSBGW107XG4gIC8qKiBBcml0eSBpcyBlbmZvcmNlZCBmcm9tIHRoaXMsIGFuZCBpdCBpcyB3aGF0IGBzY2hlbWFgIHB1Ymxpc2hlcy4gKi9cbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIC8qKiBPbmUgbGluZSBmb3IgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBBZGRlZCBhcyB0aGUgYGhpbnRgIG9mIHRoaXMgcm93J3MgZmxhZyByZWplY3Rpb25zLiAqL1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICAvKiogYGZhbHNlYCBoYW5kcyBub2RlJ3Mgb3duIFwiVW5leHBlY3RlZCBhcmd1bWVudFwiIHJlZnVzYWwgYW55IHBvc2l0aW9uYWwuICovXG4gIGFsbG93UG9zaXRpb25hbHM/OiBib29sZWFuO1xuICAvKipcbiAgICogRmxhZy1kZXBlbmRlbnQgYXJpdHkgKGltYWdvIGBoYW5kb2ZmIC0tY2xlYXJgLCBtaW5kLW1hcHBlciBgLS10b3wtLWNsZWFyYClcbiAgICogYW5kIGFueSBvdGhlciBjb21iaW5hdGlvbiBydWxlLiBSdW5zIGFmdGVyIHRoZSBhcml0eSBjaGVjazsgYSByZXR1cm5lZFxuICAgKiBzdHJpbmcgaXMgcmVmdXNlZCBhcyBhIHVzYWdlIGVycm9yIG5hbWluZyB0aGlzIHJvdy4g4pqgIFRoZSBkZWNsYXJhdGlvblxuICAgKiBjYW5ub3QgZXhwcmVzcyBzdWNoIGEgcnVsZTogYSBwb3NpdGlvbmFsIHRoYXQgYC0tY2xlYXJgIG1ha2VzIHVubmVjZXNzYXJ5XG4gICAqIGNhbiBvbmx5IGJlIGRlY2xhcmVkIGByZXF1aXJlZDogZmFsc2VgLCBhbmQgdGhpcyBob29rIGVuZm9yY2VzIHRoZSByZXN0LlxuICAgKi9cbiAgY2hlY2s/OiAoaW52OiBJbnZvY2F0aW9uPEY+KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIG51bWJlciBpcyB0aGUgZXhpdCBjb2RlOyBhbnl0aGluZyBlbHNlIG1lYW5zIDAuICovXG4gIHJ1bjogKGludjogSW52b2NhdGlvbjxGPikgPT4gdW5rbm93bjtcbn07XG5cbi8qKiBBIHZlcmJsZXNzIENMSSdzIG9uZSByb3cgKGRpZ2VzdGlmeSkuIGBwYXRoOiBbXWAgaW4gdGhlIGRlY2xhcmF0aW9uLiAqL1xuZXhwb3J0IHR5cGUgUm9vdFNwZWM8RiBleHRlbmRzIHN0cmluZyA9IHN0cmluZz4gPSBPbWl0PENvbW1hbmRTcGVjPEY+LCBcIm5hbWVcIiB8IFwiYWxpYXNlc1wiPjtcblxuLyoqXG4gKiBXaGVyZSBhIGdyb3VwJ3Mgc3ViLXZlcmIgaXMgZm91bmQuXG4gKiAtIGBhZGphY2VudGAgKGRlZmF1bHQpOiB0aGUgdG9rZW4gcmlnaHQgYWZ0ZXIgdGhlIGdyb3VwIChgbm9kZSBlZGl0IFhgKS5cbiAqIC0gYGZpcnN0LXBvc2l0aW9uYWxgOiB0aGUgZmlyc3QgdG9rZW4gYWZ0ZXIgdGhlIGdyb3VwIHRoYXQgaXMgbmVpdGhlciBhIGZsYWdcbiAqICAgbm9yIGEgc3RyaW5nIGZsYWcncyB2YWx1ZSwgc28gZmxhZ3MgbWF5IGNvbWUgZmlyc3Q6XG4gKiAgIGBkb2MgLS1wcm9qZWN0IFAgZGVsZXRlIEQxIC0tZm9yY2VgIHJlc29sdmVzIHRvIGBkb2MgZGVsZXRlYCAobWluZC1tYXBwZXIpLlxuICogICBUaGUgc2NhbiBzdG9wcyBhdCBhIGJhcmUgYC0tYCwgd2hpY2ggaXMgdGhlIGVzY2FwZSBoYXRjaCBmb3IgYSBwb3NpdGlvbmFsXG4gKiAgIGxpdGVyYWxseSBuYW1lZCBsaWtlIGEgc3ViLXZlcmI6IGBkb2MgLS0gZGVsZXRlYCByZWFkcyB0aGUgZG9jIFwiZGVsZXRlXCIuXG4gKi9cbmV4cG9ydCB0eXBlIEdyb3VwU3BlYyA9IHsgc3ViVmVyYkF0PzogXCJhZGphY2VudFwiIHwgXCJmaXJzdC1wb3NpdGlvbmFsXCIgfTtcblxuZXhwb3J0IHR5cGUgQ2xpU3BlYzxPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPiA9IHtcbiAgLyoqIGBcImJvdW50eVwiYCwgdXNlZCBpbiBtZXNzYWdlcyBhbmQgdGhlIHJlbmRlcmVkIGhlbHAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIFRoZSByZW5kZXJlZCBoZWxwJ3MgZmlyc3QgbGluZTogYCR7bmFtZX0g4oCUICR7c3VtbWFyeX1gLiAqL1xuICBzdW1tYXJ5Pzogc3RyaW5nO1xuICAvKiogVGhlIGxpdGVyYWwgYENMSV9PUFRJT05TYCBvYmplY3QuICovXG4gIG9wdGlvbnM6IE87XG4gIGNvbW1hbmRzPzogcmVhZG9ubHkgQ29tbWFuZFNwZWM8a2V5b2YgTyAmIHN0cmluZz5bXTtcbiAgLyoqXG4gICAqIEEgdmVyYmxlc3MgQ0xJJ3Mgcm93LiBSZXNlcnZlZCB0b2tlbnMgYXMgYGFyZ3ZbMF1gIHN0aWxsIHNlbGVjdCB0aGVpciByb3dzXG4gICAqIChgaGVscGAsIGB2ZXJzaW9uYCwgYHNjaGVtYWAsIGFueSBgY29tbWFuZHNgLCBhbmQgdGhlIGludGVyY2VwdG9ycyk7IGV2ZXJ5XG4gICAqIG90aGVyIGFyZ3YsIHRoZSBlbXB0eSBvbmUgaW5jbHVkZWQsIGJlbG9uZ3MgdG8gdGhlIHJvb3QuIEEgcG9zaXRpb25hbCB0aGF0XG4gICAqIGhhcHBlbnMgdG8gc3BlbGwgYSByZXNlcnZlZCB0b2tlbiBnb2VzIGFmdGVyIGEgYmFyZSBgLS1gLlxuICAgKi9cbiAgcm9vdD86IFJvb3RTcGVjPGtleW9mIE8gJiBzdHJpbmc+O1xuICAvKiogQWNjZXB0ZWQgYnkgZXZlcnkgcm93LCBieSBjb250cmFjdCAoZ3JhcGV2aW5lJ3MgYC0tYXNgL2AtLWZyb21gKS4gKi9cbiAgZ2xvYmFsRmxhZ3M/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgZ3JhbW1hcj86IFwidmVyYi1maXJzdFwiIHwgXCJmbGFncy1hbnl3aGVyZVwiO1xuICAvKiogUGVyLWdyb3VwIHN1Yi12ZXJiIHBsYWNlbWVudCwga2V5ZWQgYnkgdGhlIGdyb3VwIHRva2VuIChgXCJkb2NcImApLiAqL1xuICBncm91cHM/OiBSZWFkb25seTxSZWNvcmQ8c3RyaW5nLCBHcm91cFNwZWM+PjtcbiAgLyoqIFRoZSByb290IHJvdydzIHBvc2l0aW9uYWwgbmFtZSBpbiBgc2NoZW1hYCAoYFwiY29tbWFuZFwiYDsgZ2xhbW91cjogYFwidmVyYlwiYCkuICovXG4gIHZlcmJQb3NpdGlvbmFsPzogc3RyaW5nO1xuICAvKiogRmxhZ3MgbGVmdCBvZmYgZXZlcnkgdXNhZ2UgbGluZSAoZ2xhbW91cidzIHBlci12ZXJiIGBzZXNzaW9uYCkuICovXG4gIHVzYWdlSGlkZXM/OiByZWFkb25seSAoa2V5b2YgTyAmIHN0cmluZylbXTtcbiAgLyoqIFRoZSBgdmVyc2lvbmAgcm93J3MgcGF5bG9hZCwgYHtuYW1lLCB2ZXJzaW9ufWAuICovXG4gIHZlcnNpb246ICgpID0+IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47XG4gIC8qKiBSZXBsYWNlcyB0aGUgcmVuZGVyZWQgaGVscCAoZ3JhcGV2aW5lKS4gKi9cbiAgaGVscD86ICgpID0+IHN0cmluZztcbiAgLyoqIEFwcGVuZGVkIGJlbG93IHRoZSByZW5kZXJlZCByb3dzLiAqL1xuICBoZWxwRm9vdGVyPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgRGVjbGFyZWRBcmcgPSB7IG5hbWU6IHN0cmluZzsgdHlwZTogRmxhZ1R5cGU7IHN0YXR1czogXCJ2YWxpZFwiIH07XG5leHBvcnQgdHlwZSBEZWNsYXJlZENvbW1hbmQgPSB7XG4gIHBhdGg6IHN0cmluZ1tdO1xuICBhcmdzOiBEZWNsYXJlZEFyZ1tdO1xuICBwb3NpdGlvbmFsczogUG9zaXRpb25hbFNwZWNbXTtcbn07XG5leHBvcnQgdHlwZSBEZWNsYXJhdGlvbiA9IHtcbiAgZm9ybWF0VmVyc2lvbjogXCIwXCI7XG4gIHByb3ZlbmFuY2U6IFwiZW1pdHRlZFwiO1xuICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogc3RyaW5nW10gfTtcbiAgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdO1xufTtcblxuLyoqIEEgcm93IGFzIHRoZSBtb2R1bGUgaG9sZHMgaXQsIGZvciB0ZXN0cyBhbmQgd2FyZHMuICovXG5leHBvcnQgdHlwZSBSb3dWaWV3ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGFsaWFzZXM6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICAvKiogVGhlIHJvdydzIG93biBmbGFncywgYXMgZGVjbGFyZWQuICovXG4gIGZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgLyoqIE93biBmbGFncyBwbHVzIGBnbG9iYWxGbGFnc2AsIGluIG9wdGlvbnMtdGFibGUgb3JkZXIuICovXG4gIGFjY2VwdGVkOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcG9zaXRpb25hbHM6IHJlYWRvbmx5IFBvc2l0aW9uYWxTcGVjW107XG4gIGRlc2NyaWJlOiBzdHJpbmc7XG4gIC8qKiBgdHJ1ZWAgZm9yIGEgYGhlbHBgL2B2ZXJzaW9uYC9gc2NoZW1hYCByb3cgdGhlIG1vZHVsZSBhZGRlZC4gKi9cbiAgYXV0bzogYm9vbGVhbjtcbn07XG5cbmV4cG9ydCB0eXBlIENsaSA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICAvKiogRW52ZWxvcGUgb24gZmFpbHVyZSwgcmV0dXJucyB0aGUgZXhpdCBjb2RlLiBGb3IgdGhlIHNwZWxsJ3MgYHJ1bigpYC4gKi9cbiAgbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPjtcbiAgLyoqIFRocm93cyBgQ2xpRXJyb3JgLCBmb3IgYSBzcGVsbCB3aG9zZSBtYWluIGRvZXMgaXRzIG93biB0cmlhZ2UuICovXG4gIGRpc3BhdGNoKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+O1xuICBkZWNsYXJhdGlvbigpOiBEZWNsYXJhdGlvbjtcbiAgcmVuZGVySGVscCgpOiBzdHJpbmc7XG4gIC8qKiBBIHJvdydzIHVzYWdlIGxpbmUgKGBcImNsb3NlIDxpZD4gWy0tZm9yY2VdXCJgKTsgYFwiXCJgIGZvciBhbiB1bmtub3duIHBhdGguICovXG4gIHVzYWdlT2YocGF0aDogc3RyaW5nKTogc3RyaW5nO1xuICAvKiogRXZlcnkgZmlyc3QgdG9rZW4gdGhhdCBkaXNwYXRjaGVzOiB2ZXJicywgYWxpYXNlcyBhbmQgZ3JvdXAgdG9rZW5zLiAqL1xuICB2ZXJiczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBFdmVyeSBmdWxsIHBhdGggdGhhdCBkaXNwYXRjaGVzLCBhbGlhc2VzIGluY2x1ZGVkIChgXCJub2RlIGVkaXRcImApLiAqL1xuICBwYXRoczogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBBIHJvdydzIGFjY2VwdGVkIHNldCBhcyBgLS14YCBzcGVsbGluZ3MsIHNvcnRlZC4gYFwiXCJgIGlzIHRoZSByb290LiAqL1xuICBmbGFnc0ZvcihwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXTtcbiAgLyoqIEV2ZXJ5IGZsYWcgaW4gdGhlIG9wdGlvbnMgdGFibGUsIGFzIGAtLXhgLCBpbiB0YWJsZSBvcmRlci4gKi9cbiAgcmVjb2duaXplZEZsYWdzOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcm93czogcmVhZG9ubHkgUm93Vmlld1tdO1xufTtcblxuLy8g4pSA4pSAIGludGVybmFscyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxudHlwZSBSb3cgPSBSb3dWaWV3ICYge1xuICByZWplY3RIaW50Pzogc3RyaW5nO1xuICBhbGxvd1Bvc2l0aW9uYWxzOiBib29sZWFuO1xuICBjaGVjaz86IChpbnY6IEludm9jYXRpb24pID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgcnVuOiAoaW52OiBJbnZvY2F0aW9uKSA9PiB1bmtub3duO1xufTtcblxuLyoqIFRoZSB0b2tlbnMgdGhlIHJvb3QgYW5zd2VycyBpdHNlbGYuIERlY2xhcmVkIGF0IGBwYXRoOiBbXWAuICovXG5jb25zdCBJTlRFUkNFUFRPUlMgPSBbXG4gIHsgbmFtZTogXCItLWhlbHBcIiwgcnVuczogXCJoZWxwXCIgfSxcbiAgeyBuYW1lOiBcIi1oXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItLXZlcnNpb25cIiwgcnVuczogXCJ2ZXJzaW9uXCIgfSxcbiAgeyBuYW1lOiBcIi1WXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG5dIGFzIGNvbnN0O1xuXG4vKiogTG9uZyBmaXJzdDogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0IHN0b3BzIGF0IHRoZSBmaXJzdFxuICogIHRva2VuIHRoYXQgaXMgbm90IGEgYC0tbG9uZ2AgZmxhZy4gKi9cbmNvbnN0IElOVEVSQ0VQVE9SX0NIT0lDRVMgPSBJTlRFUkNFUFRPUlMubWFwKChpKSA9PiBpLm5hbWUpLnNvcnQoXG4gIChhLCBiKSA9PiBOdW1iZXIoYi5zdGFydHNXaXRoKFwiLS1cIikpIC0gTnVtYmVyKGEuc3RhcnRzV2l0aChcIi0tXCIpKSxcbik7XG5cbmNvbnN0IGVyckNvZGUgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PlxuICBlICYmIHR5cGVvZiBlID09PSBcIm9iamVjdFwiICYmIFwiY29kZVwiIGluIGUgPyBTdHJpbmcoKGUgYXMgeyBjb2RlOiB1bmtub3duIH0pLmNvZGUpIDogXCJcIjtcbmNvbnN0IGVyck1lc3NhZ2UgPSAoZTogdW5rbm93bik6IHN0cmluZyA9PiAoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmluZUNsaTxjb25zdCBPIGV4dGVuZHMgT3B0aW9uc1RhYmxlPihzcGVjOiBDbGlTcGVjPE8+KTogQ2xpIHtcbiAgY29uc3QgY2xpTmFtZSA9IHNwZWMubmFtZTtcbiAgY29uc3Qgb3B0aW9uS2V5cyA9IE9iamVjdC5rZXlzKHNwZWMub3B0aW9ucyk7XG4gIGNvbnN0IGtub3duID0gbmV3IFNldChvcHRpb25LZXlzKTtcbiAgY29uc3QgZ3JhbW1hciA9IHNwZWMuZ3JhbW1hciA/PyBcInZlcmItZmlyc3RcIjtcbiAgY29uc3QgZ2xvYmFscyA9IFsuLi4oc3BlYy5nbG9iYWxGbGFncyA/PyBbXSldIGFzIHN0cmluZ1tdO1xuICBjb25zdCBoaWRlcyA9IG5ldyBTZXQ8c3RyaW5nPigoc3BlYy51c2FnZUhpZGVzID8/IFtdKSBhcyBzdHJpbmdbXSk7XG5cbiAgZm9yIChjb25zdCBnIG9mIGdsb2JhbHMpIHtcbiAgICBpZiAoIWtub3duLmhhcyhnKSlcbiAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBnbG9iYWwgZmxhZyBcIiR7Z31cIiBpcyBub3QgaW4gb3B0aW9uc2ApO1xuICB9XG4gIGlmICgoc3BlYy5jb21tYW5kcz8ubGVuZ3RoID8/IDApID09PSAwICYmIHNwZWMucm9vdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGdpdmUgY29tbWFuZHMsIGEgcm9vdCwgb3IgYm90aGApO1xuICB9XG5cbiAgLy8gYHBhcnNlQXJnc2AgZ2V0cyB0aGUgdGFibGUgV0lUSE9VVCBkZWZhdWx0czogd2hpY2ggZmxhZ3MgdGhlIGNhbGxlciBnYXZlIGlzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGVyLXJvdyBjaGVjayBhc2tzLCBhbmQgYSBkZWZhdWx0IGlzIG5vdCBzb21ldGhpbmcgZ2l2ZW4uXG4gIGNvbnN0IHBhcnNlT3B0aW9ucyA9IE9iamVjdC5mcm9tRW50cmllcyhcbiAgICBvcHRpb25LZXlzLm1hcCgoaykgPT4ge1xuICAgICAgY29uc3QgeyBkZWZhdWx0OiBfZCwgLi4ucmVzdCB9ID0gc3BlYy5vcHRpb25zW2tdIGFzIE9wdGlvblNwZWM7XG4gICAgICByZXR1cm4gW2ssIHJlc3RdO1xuICAgIH0pLFxuICApIGFzIFJlY29yZDxzdHJpbmcsIHsgdHlwZTogRmxhZ1R5cGU7IG11bHRpcGxlPzogYm9vbGVhbjsgc2hvcnQ/OiBzdHJpbmcgfT47XG4gIGNvbnN0IHNob3J0VG9LZXkgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGsgb2Ygb3B0aW9uS2V5cykge1xuICAgIGNvbnN0IHMgPSBzcGVjLm9wdGlvbnNba10/LnNob3J0O1xuICAgIGlmIChzICE9PSB1bmRlZmluZWQpIHNob3J0VG9LZXkuc2V0KHMsIGspO1xuICB9XG5cbiAgY29uc3QgYWNjZXB0ZWRPZiA9IChvd246IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10gPT4ge1xuICAgIGNvbnN0IHNldCA9IG5ldyBTZXQoWy4uLmdsb2JhbHMsIC4uLm93bl0pO1xuICAgIHJldHVybiBvcHRpb25LZXlzLmZpbHRlcigoaykgPT4gc2V0LmhhcyhrKSk7XG4gIH07XG5cbiAgY29uc3QgdG9Sb3cgPSAoXG4gICAgYzogT21pdDxDb21tYW5kU3BlYywgXCJydW5cIj4gJiB7IHJ1bjogKGludjogSW52b2NhdGlvbikgPT4gdW5rbm93biB9LFxuICAgIGF1dG86IGJvb2xlYW4sXG4gICk6IFJvdyA9PiB7XG4gICAgZm9yIChjb25zdCBmIG9mIGMuZmxhZ3MpIHtcbiAgICAgIGlmICgha25vd24uaGFzKGYpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiByb3cgXCIke2MubmFtZX1cIiBuYW1lcyBmbGFnIFwiJHtmfVwiLCBub3QgaW4gb3B0aW9uc2ApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4ge1xuICAgICAgbmFtZTogYy5uYW1lLFxuICAgICAgYWxpYXNlczogWy4uLihjLmFsaWFzZXMgPz8gW10pXSxcbiAgICAgIGZsYWdzOiBbLi4uYy5mbGFnc10sXG4gICAgICBhY2NlcHRlZDogYWNjZXB0ZWRPZihjLmZsYWdzKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICBkZXNjcmliZTogYy5kZXNjcmliZSxcbiAgICAgIGF1dG8sXG4gICAgICByZWplY3RIaW50OiBjLnJlamVjdEhpbnQsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiBjLmFsbG93UG9zaXRpb25hbHMgPz8gdHJ1ZSxcbiAgICAgIGNoZWNrOiBjLmNoZWNrIGFzIFJvd1tcImNoZWNrXCJdLFxuICAgICAgcnVuOiBjLnJ1biBhcyBSb3dbXCJydW5cIl0sXG4gICAgfTtcbiAgfTtcblxuICBjb25zdCByb3dzOiBSb3dbXSA9IChzcGVjLmNvbW1hbmRzID8/IFtdKS5tYXAoKGMpID0+IHRvUm93KGMgYXMgQ29tbWFuZFNwZWMsIGZhbHNlKSk7XG5cbiAgLy8gVGhlIGF1dG8gcm93cy4gQWRkZWQgbGFzdCwgaW4gdGhpcyBvcmRlciwgdW5sZXNzIHRoZSBzcGVsbCBoYXMgaXRzIG93bi5cbiAgY29uc3QgY2xpID0ge30gYXMgQ2xpO1xuICBjb25zdCBhdXRvUm93czogQ29tbWFuZFNwZWNbXSA9IFtcbiAgICB7XG4gICAgICBuYW1lOiBcInZlcnNpb25cIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3Mge25hbWUsIHZlcnNpb259IGFzIEpTT04gKGFsaWFzOiAtLXZlcnNpb24sIC1WKVwiLFxuICAgICAgcnVuOiBhc3luYyAoKSA9PiB7XG4gICAgICAgIHByaW50SnNvbihhd2FpdCBzcGVjLnZlcnNpb24oKSk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJzY2hlbWFcIixcbiAgICAgIGZsYWdzOiBbXSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbXSxcbiAgICAgIGRlc2NyaWJlOiBcInRoaXMgQ0xJJ3MgbWFjaGluZS1yZWFkYWJsZSBpbnRlcmZhY2UgKGFjYyBkZWNsYXJhdGlvbiB2MClcIixcbiAgICAgIHJ1bjogKCkgPT4ge1xuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShjbGkuZGVjbGFyYXRpb24oKSwgbnVsbCwgMil9XFxuYCk7XG4gICAgICB9LFxuICAgIH0sXG4gICAge1xuICAgICAgbmFtZTogXCJoZWxwXCIsXG4gICAgICBmbGFnczogW10sXG4gICAgICBwb3NpdGlvbmFsczogW10sXG4gICAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZSAoYWxpYXM6IC0taGVscCwgLWgpXCIsXG4gICAgICBydW46ICgpID0+IHtcbiAgICAgICAgY29uc3QgdGV4dCA9IGNsaS5yZW5kZXJIZWxwKCk7XG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKHRleHQuZW5kc1dpdGgoXCJcXG5cIikgPyB0ZXh0IDogYCR7dGV4dH1cXG5gKTtcbiAgICAgIH0sXG4gICAgfSxcbiAgXTtcbiAgZm9yIChjb25zdCBhIG9mIGF1dG9Sb3dzKSB7XG4gICAgaWYgKCFyb3dzLnNvbWUoKHIpID0+IHIubmFtZSA9PT0gYS5uYW1lKSkgcm93cy5wdXNoKHRvUm93KGEsIHRydWUpKTtcbiAgfVxuXG4gIGNvbnN0IHJvb3RSb3c6IFJvdyB8IHVuZGVmaW5lZCA9XG4gICAgc3BlYy5yb290ID09PSB1bmRlZmluZWQgPyB1bmRlZmluZWQgOiB0b1Jvdyh7IC4uLihzcGVjLnJvb3QgYXMgUm9vdFNwZWMpLCBuYW1lOiBcIlwiIH0sIGZhbHNlKTtcblxuICAvLyBJbmRleCBldmVyeSBzcGVsbGluZywgYW5kIGNoZWNrIHRoZSB0YWJsZSBpcyB3ZWxsIGZvcm1lZC5cbiAgY29uc3QgYnlUb2tlbiA9IG5ldyBNYXA8c3RyaW5nLCBSb3c+KCk7XG4gIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgZm9yIChjb25zdCB0IG9mIFtyLm5hbWUsIC4uLnIuYWxpYXNlc10pIHtcbiAgICAgIGNvbnN0IHBhcnRzID0gdC5zcGxpdChcIiBcIik7XG4gICAgICBpZiAodC50cmltKCkgIT09IHQgfHwgcGFydHMubGVuZ3RoID4gMiB8fCBwYXJ0cy5zb21lKChwKSA9PiBwID09PSBcIlwiIHx8IHAuc3RhcnRzV2l0aChcIi1cIikpKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBiYWQgY29tbWFuZCBuYW1lIFwiJHt0fVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAodCAhPT0gci5uYW1lICYmIHBhcnRzLmxlbmd0aCAhPT0gci5uYW1lLnNwbGl0KFwiIFwiKS5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBkZWZpbmVDbGkoJHtjbGlOYW1lfSk6IGFsaWFzIFwiJHt0fVwiIG11c3QgbmVzdCBsaWtlIFwiJHtyLm5hbWV9XCJgKTtcbiAgICAgIH1cbiAgICAgIGlmIChwYXJ0cy5sZW5ndGggPT09IDIgJiYgdCAhPT0gci5uYW1lICYmIHBhcnRzWzBdICE9PSByLm5hbWUuc3BsaXQoXCIgXCIpWzBdKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBhbGlhcyBcIiR7dH1cIiBtdXN0IHNoYXJlIHRoZSBncm91cCBvZiBcIiR7ci5uYW1lfVwiYCk7XG4gICAgICB9XG4gICAgICBpZiAoYnlUb2tlbi5oYXModCkpIHRocm93IG5ldyBFcnJvcihgZGVmaW5lQ2xpKCR7Y2xpTmFtZX0pOiBcIiR7dH1cIiBpcyBkZWZpbmVkIHR3aWNlYCk7XG4gICAgICBieVRva2VuLnNldCh0LCByKTtcbiAgICB9XG4gIH1cbiAgY29uc3Qgc3Vic09mID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IHQgb2YgYnlUb2tlbi5rZXlzKCkpIHtcbiAgICBjb25zdCBbZ3JvdXAsIHN1Yl0gPSB0LnNwbGl0KFwiIFwiKTtcbiAgICBpZiAoZ3JvdXAgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgc3Vic09mLnNldChncm91cCwgWy4uLihzdWJzT2YuZ2V0KGdyb3VwKSA/PyBbXSksIHN1Yl0pO1xuICAgIH1cbiAgfVxuICBmb3IgKGNvbnN0IGcgb2YgT2JqZWN0LmtleXMoc3BlYy5ncm91cHMgPz8ge30pKSB7XG4gICAgaWYgKCFzdWJzT2YuaGFzKGcpKSB0aHJvdyBuZXcgRXJyb3IoYGRlZmluZUNsaSgke2NsaU5hbWV9KTogZ3JvdXAgXCIke2d9XCIgaGFzIG5vIHN1Yi12ZXJic2ApO1xuICB9XG5cbiAgY29uc3QgcGF0aHMgPSBbLi4uYnlUb2tlbi5rZXlzKCldO1xuICBjb25zdCB2ZXJicyA9IFsuLi5uZXcgU2V0KHBhdGhzLm1hcCgocCkgPT4gcC5zcGxpdChcIiBcIilbMF0gYXMgc3RyaW5nKSldO1xuXG4gIGNvbnN0IHJvd0ZvciA9IChwYXRoOiBzdHJpbmcpOiBSb3cgfCB1bmRlZmluZWQgPT4gKHBhdGggPT09IFwiXCIgPyByb290Um93IDogYnlUb2tlbi5nZXQocGF0aCkpO1xuICBjb25zdCBmbGFnc0ZvciA9IChwYXRoOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICAgIFsuLi4ocm93Rm9yKHBhdGgpPy5hY2NlcHRlZCA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcbiAgY29uc3QgbGFiZWwgPSAocjogUm93KTogc3RyaW5nID0+IHIubmFtZSB8fCBjbGlOYW1lO1xuXG4gIC8qKlxuICAgKiBBIHZlcmJsZXNzIHJvb3QncyByZWplY3Rpb24gYGNob2ljZXNgOiBpdHMgb3duIGZsYWdzIFBMVVMgdGhlIGludGVyY2VwdG9ycyxcbiAgICogYmVjYXVzZSB0aGUgZGVjbGFyYXRpb24gcHVibGlzaGVzIGJvdGggYXQgYHBhdGg6IFtdYCBhbmQgdGhlIHJvb3QgYW5zd2Vyc1xuICAgKiBib3RoICh0aGUgaW50ZXJjZXB0b3JzIGFzIGBhcmd2WzBdYCkuIExlYXZpbmcgdGhlIGludGVyY2VwdG9ycyBvdXQgbWFkZVxuICAgKiBvbmUgcHJvY2VzcyBzYXkgdHdvIHRoaW5ncyBhYm91dCBpdHMgcm9vdCDigJQgYWNjJ3MgY2Vuc3VzIHJlYWQgYC0taGVscGAsXG4gICAqIGAtaGAsIGAtLXZlcnNpb25gIGFuZCBgLVZgIGFzIGRlY2xhcmVkLW5vdC1hY2NlcHRlZC4gTG9uZyBzcGVsbGluZ3MgZmlyc3RcbiAgICogKHNvcnRlZCksIHRoZW4gdGhlIHNob3J0czogYSBmbGFnLXNldCBleHRyYWN0b3IgcmVhZGluZyBsZWZ0IHRvIHJpZ2h0XG4gICAqIHN0b3BzIGF0IHRoZSBmaXJzdCB0b2tlbiB0aGF0IGlzIG5vdCBhIGAtLWxvbmdgIGZsYWcuXG4gICAqL1xuICBjb25zdCByb290Q2hvaWNlczogc3RyaW5nW10gPSAoKCkgPT4ge1xuICAgIGNvbnN0IGFsbCA9IFsuLi5mbGFnc0ZvcihcIlwiKSwgLi4uSU5URVJDRVBUT1JfQ0hPSUNFU107XG4gICAgY29uc3QgbG9uZyA9IGFsbC5maWx0ZXIoKGYpID0+IGYuc3RhcnRzV2l0aChcIi0tXCIpKS5zb3J0KCk7XG4gICAgcmV0dXJuIFsuLi5sb25nLCAuLi5hbGwuZmlsdGVyKChmKSA9PiAhZi5zdGFydHNXaXRoKFwiLS1cIikpXTtcbiAgfSkoKTtcblxuICAvLyDilIDilIAgaGVscCDilIDilIBcblxuICBjb25zdCByZW5kZXJQb3NpdGlvbmFsID0gKHA6IFBvc2l0aW9uYWxTcGVjKTogc3RyaW5nID0+IHtcbiAgICBjb25zdCBpbm5lciA9IHAudmFyaWFkaWMgPyBgJHtwLm5hbWV9Li4uYCA6IHAubmFtZTtcbiAgICByZXR1cm4gcC5yZXF1aXJlZCA/IGA8JHtpbm5lcn0+YCA6IGBbJHtpbm5lcn1dYDtcbiAgfTtcbiAgY29uc3QgcmVuZGVyRmxhZyA9IChrOiBzdHJpbmcpOiBzdHJpbmcgPT5cbiAgICBzcGVjLm9wdGlvbnNba10/LnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG4gIGNvbnN0IHVzYWdlTGluZSA9IChyOiBSb3cpOiBzdHJpbmcgPT5cbiAgICBbXG4gICAgICBsYWJlbChyKSxcbiAgICAgIC4uLnIucG9zaXRpb25hbHMubWFwKHJlbmRlclBvc2l0aW9uYWwpLFxuICAgICAgLi4uci5mbGFncy5maWx0ZXIoKGspID0+ICFoaWRlcy5oYXMoaykpLm1hcChyZW5kZXJGbGFnKSxcbiAgICBdLmpvaW4oXCIgXCIpO1xuICBjb25zdCBleHBlY3RzID0gKHI6IFJvdyk6IHN0cmluZyA9PiBgZXhwZWN0czogJHt1c2FnZUxpbmUocil9YDtcblxuICBjb25zdCByZW5kZXJIZWxwID0gKCk6IHN0cmluZyA9PiB7XG4gICAgaWYgKHNwZWMuaGVscCAhPT0gdW5kZWZpbmVkKSByZXR1cm4gc3BlYy5oZWxwKCk7XG4gICAgY29uc3QgbGlzdGVkID0gWy4uLihyb290Um93ID8gW3Jvb3RSb3ddIDogW10pLCAuLi5yb3dzXTtcbiAgICBjb25zdCBsaW5lcyA9IGxpc3RlZC5tYXAoKHIpID0+IFt1c2FnZUxpbmUociksIHIuZGVzY3JpYmVdIGFzIGNvbnN0KTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLmxpbmVzLm1hcCgoW3VdKSA9PiB1Lmxlbmd0aCkpLCA0NCk7XG4gICAgY29uc3QgYm9keSA9IGxpbmVzXG4gICAgICAubWFwKChbdSwgZF0pID0+XG4gICAgICAgIHUubGVuZ3RoIDw9IHdpZHRoID8gYCAgJHt1LnBhZEVuZCh3aWR0aCl9ICAke2R9YCA6IGAgICR7dX1cXG4gICR7XCJcIi5wYWRFbmQod2lkdGgpfSAgJHtkfWAsXG4gICAgICApXG4gICAgICAuam9pbihcIlxcblwiKTtcbiAgICBjb25zdCBoZWFkID0gc3BlYy5zdW1tYXJ5ID8gYCR7Y2xpTmFtZX0g4oCUICR7c3BlYy5zdW1tYXJ5fWAgOiBjbGlOYW1lO1xuICAgIGNvbnN0IHRva2VucyA9IGAgICR7SU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKS5qb2luKFwiIHwgXCIpfSAgcm9vdCB0b2tlbnM6IGhlbHAsIG9yIHtuYW1lLCB2ZXJzaW9ufSBhcyBKU09OYDtcbiAgICByZXR1cm4gYCR7aGVhZH1cXG5cXG4ke2JvZHl9XFxuJHt0b2tlbnN9JHtzcGVjLmhlbHBGb290ZXIgPyBgXFxuXFxuJHtzcGVjLmhlbHBGb290ZXJ9YCA6IFwiXCJ9YDtcbiAgfTtcblxuICAvLyDilIDilIAgdGhlIGRlY2xhcmF0aW9uIOKUgOKUgFxuXG4gIGNvbnN0IGRlY2xhcmF0aW9uID0gKCk6IERlY2xhcmF0aW9uID0+IHtcbiAgICBjb25zdCBhcmcgPSAoazogc3RyaW5nKTogRGVjbGFyZWRBcmcgPT4gKHtcbiAgICAgIG5hbWU6IGAtLSR7a31gLFxuICAgICAgdHlwZTogKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS50eXBlLFxuICAgICAgc3RhdHVzOiBcInZhbGlkXCIsXG4gICAgfSk7XG4gICAgY29uc3QgY29tbWFuZHM6IERlY2xhcmVkQ29tbWFuZFtdID0gW1xuICAgICAge1xuICAgICAgICBwYXRoOiBbXSxcbiAgICAgICAgYXJnczogW1xuICAgICAgICAgIC4uLklOVEVSQ0VQVE9SUy5tYXAoKGkpID0+ICh7XG4gICAgICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgICAgICB0eXBlOiBcImJvb2xlYW5cIiBhcyBjb25zdCxcbiAgICAgICAgICAgIHN0YXR1czogXCJ2YWxpZFwiIGFzIGNvbnN0LFxuICAgICAgICAgIH0pKSxcbiAgICAgICAgICAuLi4ocm9vdFJvdyA/IHJvb3RSb3cuYWNjZXB0ZWQubWFwKGFyZykgOiBbXSksXG4gICAgICAgIF0sXG4gICAgICAgIHBvc2l0aW9uYWxzOiByb290Um93XG4gICAgICAgICAgPyByb290Um93LnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSlcbiAgICAgICAgICA6IFt7IG5hbWU6IHNwZWMudmVyYlBvc2l0aW9uYWwgPz8gXCJjb21tYW5kXCIsIHJlcXVpcmVkOiB0cnVlIH1dLFxuICAgICAgfSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgciBvZiByb3dzKSB7XG4gICAgICBmb3IgKGNvbnN0IHQgb2YgW3IubmFtZSwgLi4uci5hbGlhc2VzXSkge1xuICAgICAgICBjb21tYW5kcy5wdXNoKHtcbiAgICAgICAgICBwYXRoOiB0LnNwbGl0KFwiIFwiKSxcbiAgICAgICAgICBhcmdzOiByLmFjY2VwdGVkLm1hcChhcmcpLFxuICAgICAgICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLm1hcCgocCkgPT4gKHsgLi4ucCB9KSksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBzY2hlbWFSb3cgPSBieVRva2VuLmdldChcInNjaGVtYVwiKSBhcyBSb3c7XG4gICAgcmV0dXJuIHtcbiAgICAgIGZvcm1hdFZlcnNpb246IFwiMFwiLFxuICAgICAgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCIsXG4gICAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW3NjaGVtYVJvdy5uYW1lXSB9LFxuICAgICAgY29tbWFuZHMsXG4gICAgfTtcbiAgfTtcblxuICAvLyDilIDilIAgZGlzcGF0Y2gg4pSA4pSAXG5cbiAgLyoqXG4gICAqIFRoZSBpbmRleCBvZiB0aGUgZmlyc3QgdG9rZW4gdGhhdCBpcyBuZWl0aGVyIGEgZmxhZyBub3IgYSBzdHJpbmcgZmxhZydzXG4gICAqIHZhbHVlLCB3YWxraW5nIHRoZSB3YXkgdGhlIHBhcnNlciB3aWxsOiBgLS1rIHZgIGNvbnN1bWVzIGB2YCB3aGVuIGBrYCBpcyBhXG4gICAqIHN0cmluZyBmbGFnLCBgLS1rPXZgIGNvbnN1bWVzIG5vdGhpbmcsIGAtcyB2YCBsaWtld2lzZSBieSB0aGUgc2hvcnQncyB0eXBlLlxuICAgKiBBdCBhIGJhcmUgYC0tYDogYC0xYCB3aGVuIGBzdG9wQXRUZXJtaW5hdG9yYCwgZWxzZSB0aGUgaW5kZXggYWZ0ZXIgaXQuXG4gICAqL1xuICBjb25zdCBzY2FuUG9zaXRpb25hbCA9IChhcmdzOiBzdHJpbmdbXSwgc3RvcEF0VGVybWluYXRvcjogYm9vbGVhbik6IG51bWJlciA9PiB7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhcmdzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBhID0gYXJnc1tpXSBhcyBzdHJpbmc7XG4gICAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gc3RvcEF0VGVybWluYXRvciB8fCBpICsgMSA+PSBhcmdzLmxlbmd0aCA/IC0xIDogaSArIDE7XG4gICAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgICAgaWYgKGEuaW5jbHVkZXMoXCI9XCIpKSBjb250aW51ZTtcbiAgICAgICAgaWYgKHNwZWMub3B0aW9uc1thLnNsaWNlKDIpXT8udHlwZSA9PT0gXCJzdHJpbmdcIikgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChhLnN0YXJ0c1dpdGgoXCItXCIpICYmIGEubGVuZ3RoID4gMSkge1xuICAgICAgICBjb25zdCBrZXkgPSBhLmxlbmd0aCA9PT0gMiA/IHNob3J0VG9LZXkuZ2V0KGEuc2xpY2UoMSkpIDogdW5kZWZpbmVkO1xuICAgICAgICBpZiAoa2V5ICE9PSB1bmRlZmluZWQgJiYgc3BlYy5vcHRpb25zW2tleV0/LnR5cGUgPT09IFwic3RyaW5nXCIpIGkrKztcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICByZXR1cm4gaTtcbiAgICB9XG4gICAgcmV0dXJuIC0xO1xuICB9O1xuXG4gIGNvbnN0IHdpdGhvdXQgPSAoYXJnczogc3RyaW5nW10sIGk6IG51bWJlcik6IHN0cmluZ1tdID0+IFtcbiAgICAuLi5hcmdzLnNsaWNlKDAsIGkpLFxuICAgIC4uLmFyZ3Muc2xpY2UoaSArIDEpLFxuICBdO1xuXG4gIGNvbnN0IG5vQ29tbWFuZCA9ICgpOiBuZXZlciA9PlxuICAgIGRpZShcImV4cGVjdGVkIGEgY29tbWFuZFwiLCBcInVzYWdlXCIsIHtcbiAgICAgIGNob2ljZXM6IFsuLi52ZXJic10sXG4gICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCAob3IgLS1oZWxwKSBmb3IgdXNhZ2VgLFxuICAgIH0pO1xuXG4gIC8qKiBBIHZlcmIgY2FuZGlkYXRlIGFuZCB0aGUgYXJncyBhZnRlciBpdCwgdG8gYSByb3cgYW5kIHRoYXQgcm93J3MgYXJncy4gKi9cbiAgY29uc3QgcmVzb2x2ZSA9IChjYW5kOiBzdHJpbmcsIHJlc3Q6IHN0cmluZ1tdKTogeyByb3c6IFJvdzsgdG9rZW46IHN0cmluZzsgYXJnczogc3RyaW5nW10gfSA9PiB7XG4gICAgY29uc3Qgc3VicyA9IHN1YnNPZi5nZXQoY2FuZCk7XG4gICAgaWYgKHN1YnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgYXQgPSBzcGVjLmdyb3Vwcz8uW2NhbmRdPy5zdWJWZXJiQXQgPz8gXCJhZGphY2VudFwiO1xuICAgICAgbGV0IGkgPSAtMTtcbiAgICAgIGlmIChhdCA9PT0gXCJhZGphY2VudFwiKSB7XG4gICAgICAgIGNvbnN0IG5leHQgPSByZXN0WzBdO1xuICAgICAgICBpID0gbmV4dCAhPT0gdW5kZWZpbmVkICYmICFuZXh0LnN0YXJ0c1dpdGgoXCItXCIpID8gMCA6IC0xO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaSA9IHNjYW5Qb3NpdGlvbmFsKHJlc3QsIHRydWUpO1xuICAgICAgfVxuICAgICAgY29uc3Qgc3ViID0gaSA+PSAwID8gKHJlc3RbaV0gYXMgc3RyaW5nKSA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IGZ1bGwgPSBzdWIgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGJ5VG9rZW4uZ2V0KGAke2NhbmR9ICR7c3VifWApO1xuICAgICAgaWYgKGZ1bGwgIT09IHVuZGVmaW5lZCAmJiBzdWIgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICByZXR1cm4geyByb3c6IGZ1bGwsIHRva2VuOiBgJHtjYW5kfSAke3N1Yn1gLCBhcmdzOiB3aXRob3V0KHJlc3QsIGkpIH07XG4gICAgICB9XG4gICAgICBjb25zdCBvd24gPSBieVRva2VuLmdldChjYW5kKTtcbiAgICAgIGlmIChvd24gIT09IHVuZGVmaW5lZCkgcmV0dXJuIHsgcm93OiBvd24sIHRva2VuOiBjYW5kLCBhcmdzOiByZXN0IH07XG4gICAgICBjb25zdCBleHRyYSA9IHsgY2hvaWNlczogWy4uLnN1YnNdLCBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgIH07XG4gICAgICBpZiAoc3ViID09PSB1bmRlZmluZWQpIGRpZShgJHtjYW5kfTogZXhwZWN0ZWQgYSBzdWItY29tbWFuZGAsIFwidXNhZ2VcIiwgZXh0cmEpO1xuICAgICAgZGllKGB1bmtub3duICR7Y2FuZH0gc3ViLWNvbW1hbmQ6IFwiJHtzdWJ9XCJgLCBcInVzYWdlXCIsIGV4dHJhKTtcbiAgICB9XG4gICAgY29uc3Qgcm93ID0gYnlUb2tlbi5nZXQoY2FuZCk7XG4gICAgaWYgKHJvdyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoYHVua25vd24gY29tbWFuZCBcIiR7Y2FuZH1cImAsIFwidXNhZ2VcIiwge1xuICAgICAgICBjaG9pY2VzOiBbLi4udmVyYnNdLFxuICAgICAgICBoaW50OiBgcnVuIFxcYCR7Y2xpTmFtZX0gaGVscFxcYCBmb3IgdXNhZ2VgLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiB7IHJvdywgdG9rZW46IGNhbmQsIGFyZ3M6IHJlc3QgfTtcbiAgfTtcblxuICAvKipcbiAgICogQ29udHJhY3QgNSdzIGAtLWAgbWFkZSB0aGUgY2FsbGVyJ3MgZmxhZyBURVhUOyBzYXkgc28gKGMxLFxuICAgKiBgZG9jcy9pdGVtcy90ZXJtaW5hdG9yLWVhdHMtc2Vzc2lvbi1rZXkubWRgKS4gQSBwb3N0LWAtLWAgdG9rZW4gdGhhdCBzcGVsbHNcbiAgICogYSBmbGFnIHRoaXMgcm93IGFjY2VwdHMg4oCUIGAtLWtgLCBgLS1rPXZgLCBvciB0aGUgc2hvcnQgYC1zYCBvZiBhbiBhY2NlcHRlZFxuICAgKiBga2AsIGdsb2JhbHMgaW5jbHVkZWQg4oCUIGlzIG5hbWVkIGluIE9ORSBgIyB3YXJuaW5nOmAgbGluZSBvbiBzdGRlcnIsIHdpdGhcbiAgICogdGhlIG1vdmUgdGhhdCByZWNvdmVycyBpdC4gU3Rkb3V0IGFuZCB0aGUgZXhpdCBjb2RlIGRvIG5vdCBjaGFuZ2UsIGFuZCB0aGVcbiAgICogcm93IHN0aWxsIHJ1bnM6IHRleHQgY29udGFpbmluZyBhIGZsYWcgbmFtZSBpcyBsZWdpdGltYXRlLCB3aGljaCBpcyB3aGF0XG4gICAqIGAtLWAgaXMgZm9yLiBBIHRva2VuIHRoZSByb3cgZG9lcyBub3QgYWNjZXB0IGlzIGp1c3QgdGV4dCwgYW5kIHNheXMgbm90aGluZy5cbiAgICpcbiAgICog4pqgIENhbGxlZCBvbmx5IG9uY2UgZXZlcnkgcmVmdXNhbCBoYXMgcGFzc2VkLCBzbyBhIHJlZnVzZWQgaW52b2NhdGlvbidzXG4gICAqIHN0ZGVyciBpcyBzdGlsbCBleGFjdGx5IG9uZSBlbnZlbG9wZS4gVGhlIGAjIGAgcHJlZml4IGlzIHRoZSBob3VzZSdzXG4gICAqIHN1Y2Nlc3MtcGF0aCBzdGRlcnIgZm9ybSAoYCMgd2FybmluZzpgIGluIG1pbmQtbWFwcGVyLCBgIyBwaW5uZWQgYm9hcmRgLFxuICAgKiBgIyDihpIgY2hhbm5lbGApOiBhbiBlbnZlbG9wZSByZWFkZXIgbG9va3MgZm9yIGEgYHtgIGxpbmUgYW5kIHNraXBzIGl0LlxuICAgKi9cbiAgY29uc3Qgd2FybkRlbW90ZWQgPSAoXG4gICAgcm93OiBSb3csXG4gICAgYWNjZXB0ZWQ6IFJlYWRvbmx5U2V0PHN0cmluZz4sXG4gICAgdG9rZW5zOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+W1widG9rZW5zXCJdLFxuICApOiB2b2lkID0+IHtcbiAgICBjb25zdCBlbmQgPSB0b2tlbnM/LmZpbmRJbmRleCgodCkgPT4gdC5raW5kID09PSBcIm9wdGlvbi10ZXJtaW5hdG9yXCIpID8/IC0xO1xuICAgIGlmICh0b2tlbnMgPT09IHVuZGVmaW5lZCB8fCBlbmQgPCAwKSByZXR1cm47XG4gICAgY29uc3QgZGVtb3RlZDogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHQgb2YgdG9rZW5zLnNsaWNlKGVuZCArIDEpKSB7XG4gICAgICBpZiAodC5raW5kICE9PSBcInBvc2l0aW9uYWxcIikgY29udGludWU7XG4gICAgICBjb25zdCB2ID0gdC52YWx1ZTtcbiAgICAgIGxldCBrZXk6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICAgIGlmICh2LnN0YXJ0c1dpdGgoXCItLVwiKSkga2V5ID0gdi5zbGljZSgyKS5zcGxpdChcIj1cIilbMF07XG4gICAgICBlbHNlIGlmICh2Lmxlbmd0aCA9PT0gMiAmJiB2LnN0YXJ0c1dpdGgoXCItXCIpKSBrZXkgPSBzaG9ydFRvS2V5LmdldCh2LnNsaWNlKDEpKTtcbiAgICAgIGlmIChrZXkgIT09IHVuZGVmaW5lZCAmJiBrZXkgIT09IFwiXCIgJiYgYWNjZXB0ZWQuaGFzKGtleSkpIGRlbW90ZWQucHVzaCh2KTtcbiAgICB9XG4gICAgaWYgKGRlbW90ZWQubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgd2hpY2ggPSBkZW1vdGVkLmpvaW4oXCIsIFwiKTtcbiAgICBjb25zdCBvbmUgPSBkZW1vdGVkLmxlbmd0aCA9PT0gMTtcbiAgICBjb25zdCBpdCA9IG9uZSA/IFwiaXRcIiA6IFwidGhlbVwiO1xuICAgIGNvbnN0IHdhcyA9IG9uZSA/IFwid2FzXCIgOiBcIndlcmVcIjtcbiAgICBjb25zdCBhc0ZsYWcgPSBvbmUgPyBcImFzIGEgZmxhZ1wiIDogXCJhcyBmbGFnc1wiO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYCMgd2FybmluZzogJHtjbGlOYW1lfSR7cm93Lm5hbWUgPT09IFwiXCIgPyBcIlwiIDogYCAke3Jvdy5uYW1lfWB9OiAke3doaWNofSBhZnRlciBcXGAtLVxcYCAke3dhc30gcmVhZCBhcyB0ZXh0LCBub3QgJHthc0ZsYWd9OyB0byB1c2UgJHtpdH0gJHthc0ZsYWd9LCBtb3ZlICR7aXR9IGJlZm9yZSBcXGAtLVxcYFxcbmAsXG4gICAgKTtcbiAgfTtcblxuICBjb25zdCBydW5Sb3cgPSBhc3luYyAocm93OiBSb3csIHRva2VuOiBzdHJpbmcsIGFyZ3M6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+ID0+IHtcbiAgICBzZXRDdXJyZW50Q29tbWFuZChyb3cubmFtZSA9PT0gXCJcIiA/IG51bGwgOiByb3cubmFtZSk7XG4gICAgY29uc3QgbmFtZSA9IGxhYmVsKHJvdyk7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBuZXcgU2V0KHJvdy5hY2NlcHRlZCk7XG4gICAgY29uc3QgY2hvaWNlcyA9IHJvdy5uYW1lID09PSBcIlwiID8gcm9vdENob2ljZXMgOiBmbGFnc0Zvcihyb3cubmFtZSk7XG4gICAgY29uc3QgZmxhZ0hpbnQgPSAoKTogc3RyaW5nIHwgdW5kZWZpbmVkID0+XG4gICAgICBbcm93LnJlamVjdEhpbnQsIGNob2ljZXMubGVuZ3RoID09PSAwID8gYCR7bmFtZX0gdGFrZXMgbm8gZmxhZ3NgIDogdW5kZWZpbmVkXVxuICAgICAgICAuZmlsdGVyKChzKTogcyBpcyBzdHJpbmcgPT4gcyAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAuam9pbihcIjsgXCIpIHx8IHVuZGVmaW5lZDtcblxuICAgIGxldCB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGxldCBwb3NpdGlvbmFsczogc3RyaW5nW107XG4gICAgbGV0IHRva2VuczogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPltcInRva2Vuc1wiXTtcbiAgICB0cnkge1xuICAgICAgKHsgdmFsdWVzLCBwb3NpdGlvbmFscywgdG9rZW5zIH0gPSBwYXJzZUFyZ3Moe1xuICAgICAgICBhcmdzLFxuICAgICAgICBvcHRpb25zOiBwYXJzZU9wdGlvbnMsXG4gICAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgICAgYWxsb3dQb3NpdGlvbmFsczogcm93LmFsbG93UG9zaXRpb25hbHMsXG4gICAgICAgIHRva2VuczogdHJ1ZSxcbiAgICAgIH0pKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpZiAoZXJyQ29kZShlKSA9PT0gXCJFUlJfUEFSU0VfQVJHU19VTktOT1dOX09QVElPTlwiKSB7XG4gICAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0pO1xuICAgICAgfVxuICAgICAgLy8gQSBtaXNzaW5nIHZhbHVlIGlzIG5vdCBhIGNob2ljZSBmcm9tIGEgc2V0LCBzbyBubyBgY2hvaWNlc2AgaGVyZS5cbiAgICAgIGRpZShgJHtuYW1lfTogJHtlcnJNZXNzYWdlKGUpfWAsIFwidXNhZ2VcIiwgeyBoaW50OiByb3cucmVqZWN0SGludCA/PyBleHBlY3RzKHJvdykgfSk7XG4gICAgfVxuXG4gICAgLy8gU3RhZ2UgMjoga25vd24gdG8gdGhlIHNwZWxsLCBub3QgdGFrZW4gYnkgdGhpcyByb3cg4oCUIE1JU1BMQUNFRCwgbm90XG4gICAgLy8gdW5rbm93bi4gT25seSBmbGFncyB0aGUgY2FsbGVyIEdBVkUgYXJlIGhlcmU6IGRlZmF1bHRzIGFyZSBub3QgYXBwbGllZCB5ZXQuXG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyh2YWx1ZXMpLmZpbmQoKGspID0+ICFhY2NlcHRlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkaWUoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke25hbWV9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgJHtjbGlOYW1lfSBmbGFnLCBqdXN0IG5vdCB0aGlzICR7cm93Lm5hbWUgPT09IFwiXCIgPyBcImNvbW1hbmRcIiA6IFwidmVyYlwifSdzKWAsXG4gICAgICAgIFwidXNhZ2VcIixcbiAgICAgICAgeyBjaG9pY2VzLCBoaW50OiBmbGFnSGludCgpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIEFyaXR5LCBmcm9tIHRoZSBkZWNsYXJlZCBzaGFwZSwgbmFtaW5nIHRoZSBtaXNzaW5nIG9yIHRoZSBleHRyYSB0b2tlbi5cbiAgICBjb25zdCByZXF1aXJlZCA9IHJvdy5wb3NpdGlvbmFscy5maWx0ZXIoKHApID0+IHAucmVxdWlyZWQpLmxlbmd0aDtcbiAgICBjb25zdCB2YXJpYWRpYyA9IHJvdy5wb3NpdGlvbmFscy5zb21lKChwKSA9PiBwLnZhcmlhZGljKTtcbiAgICBpZiAocG9zaXRpb25hbHMubGVuZ3RoIDwgcmVxdWlyZWQpIHtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSByb3cucG9zaXRpb25hbHNbcG9zaXRpb25hbHMubGVuZ3RoXTtcbiAgICAgIGRpZShgJHtuYW1lfTogbWlzc2luZyByZXF1aXJlZCA8JHttaXNzaW5nPy5uYW1lID8/IFwiYXJndW1lbnRcIn0+YCwgXCJ1c2FnZVwiLCB7XG4gICAgICAgIGhpbnQ6IGV4cGVjdHMocm93KSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAoIXZhcmlhZGljICYmIHBvc2l0aW9uYWxzLmxlbmd0aCA+IHJvdy5wb3NpdGlvbmFscy5sZW5ndGgpIHtcbiAgICAgIGRpZShcbiAgICAgICAgYCR7bmFtZX06IHVuZXhwZWN0ZWQgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShwb3NpdGlvbmFsc1tyb3cucG9zaXRpb25hbHMubGVuZ3RoXSl9YCxcbiAgICAgICAgXCJ1c2FnZVwiLFxuICAgICAgICB7IGhpbnQ6IHJvdy5wb3NpdGlvbmFscy5sZW5ndGggPT09IDAgPyBgJHtuYW1lfSB0YWtlcyBubyBhcmd1bWVudHNgIDogZXhwZWN0cyhyb3cpIH0sXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIERlZmF1bHRzIGxhc3QsIGFuZCBvbmx5IHRoaXMgcm93J3MuXG4gICAgY29uc3QgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIEZsYWdWYWx1ZT4gPSB7IC4uLih2YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgRmxhZ1ZhbHVlPikgfTtcbiAgICBmb3IgKGNvbnN0IGsgb2Ygcm93LmFjY2VwdGVkKSB7XG4gICAgICBjb25zdCBkID0gKHNwZWMub3B0aW9uc1trXSBhcyBPcHRpb25TcGVjKS5kZWZhdWx0O1xuICAgICAgaWYgKGZsYWdzW2tdID09PSB1bmRlZmluZWQgJiYgZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGZsYWdzW2tdID0gKEFycmF5LmlzQXJyYXkoZCkgPyBbLi4uZF0gOiBkKSBhcyBGbGFnVmFsdWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgaW52OiBJbnZvY2F0aW9uID0geyBwYXRoOiByb3cubmFtZSwgdG9rZW4sIHBvczogcG9zaXRpb25hbHMsIGZsYWdzIH07XG4gICAgY29uc3QgcmVmdXNlZCA9IHJvdy5jaGVjaz8uKGludik7XG4gICAgaWYgKHJlZnVzZWQgIT09IHVuZGVmaW5lZCkgZGllKGAke25hbWV9OiAke3JlZnVzZWR9YCwgXCJ1c2FnZVwiLCB7IGhpbnQ6IGV4cGVjdHMocm93KSB9KTtcblxuICAgIHdhcm5EZW1vdGVkKHJvdywgYWNjZXB0ZWQsIHRva2Vucyk7XG4gICAgY29uc3Qgb3V0ID0gYXdhaXQgcm93LnJ1bihpbnYpO1xuICAgIHJldHVybiB0eXBlb2Ygb3V0ID09PSBcIm51bWJlclwiID8gb3V0IDogMDtcbiAgfTtcblxuICBjb25zdCBkaXNwYXRjaCA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgc2V0Q3VycmVudENvbW1hbmQoYXJndlswXSA/PyBudWxsKTtcbiAgICBjb25zdCBmaXJzdCA9IGFyZ3ZbMF07XG5cbiAgICAvLyAxLiBJbnRlcmNlcHRvcnMgcGFzcyB0aGUgcmVzdCBvZiB0aGUgYXJndiBvbiB0byB0aGVpciByb3cuXG4gICAgY29uc3QgaW50ZXJjZXB0b3IgPSBJTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBmaXJzdCk7XG4gICAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiBydW5Sb3coYnlUb2tlbi5nZXQoaW50ZXJjZXB0b3IucnVucykgYXMgUm93LCBpbnRlcmNlcHRvci5ydW5zLCBhcmd2LnNsaWNlKDEpKTtcbiAgICB9XG5cbiAgICAvLyAyLiBBIHZlcmJsZXNzIHJvb3Qgb3ducyBldmVyeSBhcmd2IHRoYXQgZG9lcyBub3Qgc3RhcnQgd2l0aCBhIHJlc2VydmVkIHRva2VuLlxuICAgIGlmIChyb290Um93ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChmaXJzdCAhPT0gdW5kZWZpbmVkICYmIChieVRva2VuLmhhcyhmaXJzdCkgfHwgc3Vic09mLmhhcyhmaXJzdCkpKSB7XG4gICAgICAgIGNvbnN0IHIgPSByZXNvbHZlKGZpcnN0LCBhcmd2LnNsaWNlKDEpKTtcbiAgICAgICAgcmV0dXJuIHJ1blJvdyhyLnJvdywgci50b2tlbiwgci5hcmdzKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBydW5Sb3cocm9vdFJvdywgXCJcIiwgYXJndik7XG4gICAgfVxuXG4gICAgLy8gMy4gQmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IgKGFjYyBDMi9EMikuXG4gICAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBub0NvbW1hbmQoKTtcblxuICAgIC8vIDQuIEZpbmQgdGhlIHZlcmIuXG4gICAgbGV0IGNhbmQ6IHN0cmluZztcbiAgICBsZXQgcmVzdDogc3RyaW5nW107XG4gICAgaWYgKGdyYW1tYXIgPT09IFwidmVyYi1maXJzdFwiKSB7XG4gICAgICBpZiAoZmlyc3QgPT09IFwiLS1cIikge1xuICAgICAgICBpZiAoYXJndlsxXSA9PT0gdW5kZWZpbmVkKSByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICAgIGNhbmQgPSBhcmd2WzFdO1xuICAgICAgICByZXN0ID0gW1wiLS1cIiwgLi4uYXJndi5zbGljZSgyKV07XG4gICAgICB9IGVsc2UgaWYgKGZpcnN0LnN0YXJ0c1dpdGgoXCItXCIpKSB7XG4gICAgICAgIHJldHVybiBkaWUoYHVua25vd24gZmxhZyBhdCB0aGUgcm9vdDogJHtmaXJzdH1gLCBcInVzYWdlXCIsIHtcbiAgICAgICAgICBjaG9pY2VzOiBbLi4uSU5URVJDRVBUT1JfQ0hPSUNFU10sXG4gICAgICAgICAgaGludDogYGNvbW1hbmRzIChlYWNoIHRha2VzIGl0cyBvd24gZmxhZ3MpOiAke3ZlcmJzLmpvaW4oXCIgXCIpfWAsXG4gICAgICAgIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY2FuZCA9IGZpcnN0O1xuICAgICAgICByZXN0ID0gYXJndi5zbGljZSgxKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IHNjYW5Qb3NpdGlvbmFsKGFyZ3YsIGZhbHNlKTtcbiAgICAgIGlmIChpIDwgMCkge1xuICAgICAgICAvLyBObyB2ZXJiIGFueXdoZXJlOiBhbiB1bmtub3duIGZsYWcgaXMgcmVmdXNlZCB3aXRoIHRoZSByb290J3Mgc2V0LFxuICAgICAgICAvLyBhbmQgYSBjbGVhbiBwYXJzZSBpcyBhIGJhcmUgaW52b2NhdGlvbi4gTmVpdGhlciByYW4gYSBjb21tYW5kLCBzb1xuICAgICAgICAvLyB0aGUgZW52ZWxvcGUncyBgbWV0YS5jb21tYW5kYCBpcyBudWxsLCBub3QgdGhlIGZpcnN0IGZsYWcnc1xuICAgICAgICAvLyBzcGVsbGluZyAoYGdsYW1vdXIgLS1ib2d1c2AgbmFtZXMgbm8gdmVyYikuXG4gICAgICAgIHNldEN1cnJlbnRDb21tYW5kKG51bGwpO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlQXJncyh7IGFyZ3M6IGFyZ3YsIG9wdGlvbnM6IHBhcnNlT3B0aW9ucywgc3RyaWN0OiB0cnVlLCBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlIH0pO1xuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgZGllKGVyck1lc3NhZ2UoZSksIFwidXNhZ2VcIiwge1xuICAgICAgICAgICAgY2hvaWNlczogWy4uLklOVEVSQ0VQVE9SX0NIT0lDRVNdLFxuICAgICAgICAgICAgaGludDogYG5vIGNvbW1hbmQgZ2l2ZW4g4oCUIGNvbW1hbmRzOiAke3ZlcmJzLmpvaW4oXCIgXCIpfSAocnVuOiAke2NsaU5hbWV9IGhlbHApYCxcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbm9Db21tYW5kKCk7XG4gICAgICB9XG4gICAgICBjYW5kID0gYXJndltpXSBhcyBzdHJpbmc7XG4gICAgICAvLyBBIHZlcmIgZm91bmQgcmlnaHQgYWZ0ZXIgYSBgLS1gIGxlYXZlcyB0aGF0IGAtLWAgaW4gcGxhY2UsIHNvIHRoZVxuICAgICAgLy8gcmVzdCBvZiB0aGUgYXJndiBzdGF5cyBwb3NpdGlvbmFsLlxuICAgICAgcmVzdCA9IHdpdGhvdXQoYXJndiwgaSk7XG4gICAgfVxuICAgIHNldEN1cnJlbnRDb21tYW5kKGNhbmQpO1xuICAgIGNvbnN0IHIgPSByZXNvbHZlKGNhbmQsIHJlc3QpO1xuICAgIHJldHVybiBydW5Sb3coci5yb3csIHIudG9rZW4sIHIuYXJncyk7XG4gIH07XG5cbiAgY29uc3QgbWFpbiA9IGFzeW5jIChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCByZXBvcnRlZCA9IHJlcG9ydENsaUVycm9yKGUpO1xuICAgICAgaWYgKHJlcG9ydGVkICE9PSBudWxsKSByZXR1cm4gcmVwb3J0ZWQ7XG4gICAgICAvLyBUaGUgaG91c2UgY29udHJhY3QgaXMgSlNPTiBvbiBzdGRlcnIgZm9yIEVWRVJZIGZhaWx1cmUuIEEgc3BlbGwgdGhhdFxuICAgICAgLy8gdHJpYWdlcyBpdHMgb3duIChnbGFtb3VyJ3MgRU5PRU5UIOKGkiB1c2FnZSkgY2FsbHMgYGRpc3BhdGNoYCBpbnN0ZWFkLlxuICAgICAgcmV0dXJuIHJlcG9ydENsaUVycm9yKG5ldyBDbGlFcnJvcihcImludGVybmFsXCIsIGVyck1lc3NhZ2UoZSkpKSA/PyAxO1xuICAgIH1cbiAgfTtcblxuICBjb25zdCB2aWV3ID0gKHI6IFJvdyk6IFJvd1ZpZXcgPT4gKHtcbiAgICBuYW1lOiByLm5hbWUsXG4gICAgYWxpYXNlczogci5hbGlhc2VzLFxuICAgIGZsYWdzOiByLmZsYWdzLFxuICAgIGFjY2VwdGVkOiByLmFjY2VwdGVkLFxuICAgIHBvc2l0aW9uYWxzOiByLnBvc2l0aW9uYWxzLFxuICAgIGRlc2NyaWJlOiByLmRlc2NyaWJlLFxuICAgIGF1dG86IHIuYXV0byxcbiAgfSk7XG5cbiAgT2JqZWN0LmFzc2lnbihjbGksIHtcbiAgICBuYW1lOiBjbGlOYW1lLFxuICAgIG1haW4sXG4gICAgZGlzcGF0Y2gsXG4gICAgZGVjbGFyYXRpb24sXG4gICAgcmVuZGVySGVscCxcbiAgICB1c2FnZU9mOiAocGF0aDogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCByID0gcm93Rm9yKHBhdGgpO1xuICAgICAgcmV0dXJuIHIgPT09IHVuZGVmaW5lZCA/IFwiXCIgOiB1c2FnZUxpbmUocik7XG4gICAgfSxcbiAgICB2ZXJicyxcbiAgICBwYXRocyxcbiAgICBmbGFnc0ZvcixcbiAgICByZWNvZ25pemVkRmxhZ3M6IG9wdGlvbktleXMubWFwKChrKSA9PiBgLS0ke2t9YCksXG4gICAgcm93czogcm93cy5tYXAodmlldyksXG4gIH0gc2F0aXNmaWVzIENsaSk7XG4gIHJldHVybiBjbGk7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKlxuICogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLlxuICpcbiAqIOKaoCAqKmBzZXJ2ZXJgIEFSUklWRUQgSU4gUEhBU0UgMiwgQU5EIElUIElTIEEgRklORElORyBBQk9VVCBUSElTIE1PRFVMRS4qKiBUaGVcbiAqIGNvbnRyYWN0IHdhcyBleHRyYWN0ZWQgZnJvbSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZSwgYW5kIEJPVEggb2YgdGhlbSBmcm9udCBhXG4gKiBkYWVtb24gYW5kIEJPVEggb2YgdGhlbSB0aHJvdyBhd2F5IHdoYXQgdGhlIGRhZW1vbiBzYWlkOiBtYWdwaWUnc1xuICogYGRpZShcInN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pXCIsIFwiaW50ZXJuYWxcIilgIGtlZXBzIHRoZSBudW1iZXIgYW5kIGRyb3BzXG4gKiB0aGUgYm9keS4gZ2xhbW91ciBkb2VzIG5vdCDigJQgaXRzIHJlZnVzYWxzIGNhcnJ5IHRoZSBkYWVtb24ncyBvd24gSlNPTiB2ZXJiYXRpbVxuICogdW5kZXIgYGVycm9yLnNlcnZlcmAsIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gdGhlIHVwc3RyZWFtJ3MgcmVhc29uIGluc3RlYWRcbiAqIG9mIG9uIHRoZSBDTEkncyBwcm9zZSBhYm91dCBpdCwgYW5kIGB0ZXN0cy9jbGktY29udHJhY3QudGVzdC50c2AgYXNzZXJ0cyBpdCBmb3JcbiAqIDQwMCwgNDA0IGFuZCA0MDkuIFNldmVuIG9mIHRoZSBlaWdodCBzcGVsbHMgcHV0IGEgQ0xJIGluIGZyb250IG9mIGEgZGFlbW9uLCBzb1xuICogdGhpcyBpcyB0aGUgZ2VuZXJhbCBzaGFwZSBhbmQgdGhlIHR3by1zcGVsbCBib3VuZGFyeSB3YXMgdGhlIG5hcnJvdyBvbmUuXG4gKlxuICog4puUIElUIElTIFRIRSBVUFNUUkVBTSdTIEJPRFksIFZFUkJBVElNLCBBTkQgTk9USElORyBFTFNFLiBOb3QgYSBwbGFjZSB0byBzdGFzaFxuICogYXJiaXRyYXJ5IGNvbnRleHQ6IHRoZSB3aG9sZSB2YWx1ZSBvZiB0aGUgZmllbGQgaXMgdGhhdCBhIGNhbGxlciBjYW4gdHJ1c3QgaXRcbiAqIGlzIHdoYXQgdGhlIG90aGVyIHNpZGUgYWN0dWFsbHkgc2FpZC5cbiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXTsgc2VydmVyPzogdW5rbm93biB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgICAvLyBMYXN0LCBzbyBhIHNwZWxsIHRoYXQgYWxyZWFkeSBlbWl0dGVkIHRoaXMga2V5IGtlZXBzIGl0cyBieXRlIG9yZGVyLlxuICAgICAgLi4uKGV4dHJhPy5zZXJ2ZXIgIT09IHVuZGVmaW5lZCA/IHsgc2VydmVyOiBleHRyYS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogY3VycmVudENvbW1hbmQgfSxcbiAgfSl9XFxuYDtcbn1cblxuLyoqIEEgZmFpbHVyZSB3aXRoIGEgdGF4b25vbXkgYGtpbmRgLCByYWlzZWQgYnkgYGRpZWAgYW5kIGNhdWdodCBieSBgbWFpbmAuICovXG5leHBvcnQgY2xhc3MgQ2xpRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IGtpbmQ6IEVycktpbmQ7XG4gIHJlYWRvbmx5IGV4dHJhPzogRXJyRXh0cmE7XG5cbiAgY29uc3RydWN0b3Ioa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJDbGlFcnJvclwiO1xuICAgIHRoaXMua2luZCA9IGtpbmQ7XG4gICAgdGhpcy5leHRyYSA9IGV4dHJhO1xuICB9XG5cbiAgZ2V0IGV4aXRDb2RlKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIEVYSVRfRk9SW3RoaXMua2luZF07XG4gIH1cbn1cblxuLyoqIFJhaXNlIGEgdGF4b25vbXkgZmFpbHVyZS4gUmV0dXJucyBgbmV2ZXJgLCBzbyBkZWZpbml0ZS1hc3NpZ25tZW50IGFuYWx5c2lzXG4gKiAgc3RpbGwgbmFycm93cyBhZnRlciBpdCDigJQgdGhlIHByb3BlcnR5IHRoYXQgbGV0IHRoZSBvbGQgZXhpdGluZyBmb3JtIHNpdCBpblxuICogIGEgYGNhdGNoYCBhbmQgbGVhdmUgdGhlIHZhcmlhYmxlIGl0IGd1YXJkcyBhc3NpZ25lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaWUobWVzc2FnZTogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IEVyckV4dHJhKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbWVzc2FnZSwgZXh0cmEpO1xufVxuXG4vKipcbiAqIFJlcG9ydCBhIGNhdWdodCBlcnJvciBhcyB0aGUgaG91c2UgZW52ZWxvcGUgYW5kIGhhbmQgYmFjayBhbiBleGl0IGNvZGUsIG9yXG4gKiBgbnVsbGAgd2hlbiB0aGUgZXJyb3IgaXMgTk9UIGEgYENsaUVycm9yYCDigJQgd2hpY2ggdGhlIGNhbGxlciBtdXN0IHJldGhyb3cuXG4gKiBTd2FsbG93aW5nIGFuIHVua25vd24gdGhyb3cgaGVyZSB3b3VsZCByZXBvcnQgYW4gaW50ZXJuYWwgZmF1bHQgYXMgYSB0aWR5XG4gKiB0YXhvbm9teSBmYWlsdXJlIGFuZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlcG9ydENsaUVycm9yKFxuICBlOiB1bmtub3duLFxuICBlcnI6IHsgd3JpdGUoY2h1bms6IHN0cmluZyk6IHVua25vd24gfSA9IHByb2Nlc3Muc3RkZXJyLFxuKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICghKGUgaW5zdGFuY2VvZiBDbGlFcnJvcikpIHJldHVybiBudWxsO1xuICBlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShlLmtpbmQsIGUubWVzc2FnZSwgZS5leHRyYSkpO1xuICByZXR1cm4gZS5leGl0Q29kZTtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBPTkUgU1NFIHRhaWwgY2xpZW50IOKAlCB0aGUgc3RhbmRpbmcsIHNlbGYtaGVhbGluZyByZWFkIGxvb3AgZXZlcnlcbiAqIHNwZWxsJ3MgYHRhaWxgL2Bqb2luYCB2ZXJiIHJ1bnMuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGUgaW50byBhbnkgc3BlbGwnc1xuICogYnVuZGxlLiBJdCByZWFjaGVzIGZvciBub3RoaW5nLCBub3QgZXZlbiB0aGUgc2libGluZyBlcnJvciBjb250cmFjdC5cbiAqXG4gKiBEZXNpZ25lZCBhZ2FpbnN0IGFsbCBzZXZlbiBvZiB0aGUgaG91c2UncyBoYW5kLXdyaXR0ZW4gdGFpbHMgKHRoZSBjb252ZXJnZW5jZVxuICogZGVzaWduLCBgZG9jcy9pdGVtcy90YWlsLXJlYWRlci1jb252ZXJnZW5jZS93cml0ZS11cC5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQgSU5UTyBUSElTIE1PRFVMRSwgZGVsaWJlcmF0ZWx5OiBtaW5kLW1hcHBlcidzIG1lYXN1cmVkIEJ1blxuICogMS4zLjE0IGZpbmRpbmcgdGhhdCBgY29udHJvbGxlci5lbnF1ZXVlKClgIG9uIGFuIG9ycGhhbmVkIHN0cmVhbSBuZXZlciB0aHJvd3MuXG4gKiBJdCBpcyBhIERBRU1PTi1zaWRlIGZhY3QgYWJvdXQgZGVhZC1zb2NrZXQgZGV0ZWN0aW9uIGFuZCBiZWFycyBvblxuICogYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueSBjbGllbnQuXG4gKlxuICog4puUIEFORCBJVCBESUQgR0VUIEEgSE9NRSDigJQgU0FZIFNPLCBCRUNBVVNFIFRISVMgU0VOVEVOQ0UgVVNFRCBUTyBFTkQgXCJpdCBzdGF5c1xuICogd2hlcmUgaXQgd2FzIG1lYXN1cmVkXCIgQU5EIFRIQVQgSVMgRkFMU0UuIFJlYWQgYXQgcG9ydCB0aW1lIGl0IHBvaW50ZWQgYVxuICogcmVhZGVyIGF0IGBtaW5kLW1hcHBlci9zY3JpcHRzL3NlcnZlci50c2AsIGEgZmlsZSB3aG9zZSBsb2NhbCBgc3NlUmVzcG9uc2VgXG4gKiB0aGUgYmFja2VuZCBwb3J0IG1pZ2h0IHJlcGxhY2UsIHNvIHRoZSBtZWFzdXJlbWVudCBsb29rZWQgYXQgcmlzay4gSXQgd2FzXG4gKiBub3Q6IHRoZSBkYWVtb24gaGFsZiBsYW5kZWQgaW4gYC4vc3NlLnRzYCB0aGUgc2FtZSBkYXksIHVuZGVyIGl0cyBvd24gaGVhZGluZ1xuICogKFwiVEhFIFNDQVIsIFJFLUhPTUVEOiBgdHJ5IHsgZW5xdWV1ZSB9IGNhdGNoYCBET0VTIE5PVCBERVRFQ1QgQSBERUFEXG4gKiBDTElFTlRcIiksIHdpdGggdGhlIHRlYXJkb3duLWZ1bm5lbCBydWxpbmcgYW5kIHRoZSBzYW1lIGtub3duIGhvbGUuXG4gKlxuICog4pqgICoqQU5EIFRIRSBQT1JUIEhBUyBTSU5DRSBIQVBQRU5FRCwgV0hJQ0ggU0VUVExFUyBJVC4qKiBtaW5kLW1hcHBlcidzIGRhZW1vblxuICogaXMgbm93IGBzcmMvbWluZC1tYXBwZXIvYmFja2VuZC9zZXJ2ZXIudHNgIGFuZCBpdCBESUQgcmVwbGFjZSBpdHMgbG9jYWxcbiAqIGBzc2VSZXNwb25zZWAgd2l0aCBgLi9zc2UudHNgJ3MgKFBoYXNlIDcsIDIwMjYtMDktMDkpIOKAlCBzbyB0aGUgb25seSBjb3BpZXMgb2ZcbiAqIHRoYXQgbWVhc3VyZW1lbnQgYXJlIHRoZSBraXQncyBhbmQgdGhlIHR3byB0ZXN0IGZpbGVzIHRoYXQgUFJPVkUgaXQsXG4gKiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQvcHJlc2VuY2UudGVzdC50c2AgYW5kIGBzc2Uta2VlcGFsaXZlLnRlc3QudHNgLiBUaGVcbiAqIHJpc2sgdGhpcyBwYXJhZ3JhcGggZGVzY3JpYmVkIGlzIGNsb3NlZCwgaW4gdGhlIGRpcmVjdGlvbiBpdCBob3BlZCBmb3IuXG4gKlxuICogVGhlIGdlbmVyYWwgc2hhcGUsIHdvcnRoIHRoZSBmb3VyIGxpbmVzIChEODMpOiBhIHJlZnVzYWwgcmVjb3JkZWQgaW4gT05FXG4gKiBtb2R1bGUncyBoZWFkZXIgY2Fubm90IGJlIHJlYWQgZnJvbSB0aGUgbW9kdWxlIGl0IHBvaW50cyBBVC4gV2hlbiBhIHJlZnVzYWxcbiAqIG5hbWVzIGFub3RoZXIgbW9kdWxlIGFzIHRoZSByaWdodCBob21lLCBzYXkgd2hldGhlciBpdCBnb3QgdGhlcmUuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuXG4gICAqXG4gICAqICDim5QgQU5EIFdIRU4gVEhFIE5FVyBMT0cgV0FTIEFMUkVBRFkgUEFTVCBUSEUgQk9PS01BUkssIFRIRSBDTElFTlRcbiAgICogIFJFQ09OTkVDVFMgRlJPTSBJVFMgU1RBUlQuIEEgZGFlbW9uIHRoYXQgYmVsaWV2ZXMgdGhlIGN1cnNvciBzZW5kcyBvbmx5XG4gICAqICB3aGF0IGxpZXMgYWJvdmUgaXQsIHNvIHRoZSBuZXcgbG9nJ3MgZWFybHkgZnJhbWVzIOKAlCBhIGh1bWFuIG1lc3NhZ2UgYXRcbiAgICogIG5ldyBpZCAyIHVuZGVyIGFuIG9sZCBib29rbWFyayBvZiA0IOKAlCB3ZXJlIHNraXBwZWQgc2lsZW50bHkuIEV2ZXJ5dGhpbmcgaW5cbiAgICogIGEgbmV3IGVwb2NoIGlzIG5ldyB0byB0aGlzIHJlYWRlciwgc28gdGhlIGF0dGVtcHQgaXMgZHJvcHBlZCBhbmQgcmUtbWFkZVxuICAgKiAgZnJvbSAwIGF0IG9uY2UgKG5vIGJhY2tvZmYpLiBBIGZyYW1lIEFUIG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgbWVhbnNcbiAgICogIHRoZSBkYWVtb24gaXMgYWxyZWFkeSByZXBsYXlpbmcgd2hvbGUsIGFuZCBpcyBrZXB0LiAoUmV2aWV3ZXIncyBEMiBnYXAsXG4gICAqICBmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZi4pICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuICAvKiogVGhlIGVwb2NoIHRoZSBzdGFydGluZyBgc2luY2VgIGNhbWUgZnJvbSwgd2hlbiB0aGUgY2FsbGVyIGhhcyBvbmUgKGFcbiAgICogIGJvb2ttYXJrIHByaW50ZWQgYXMgYE5APGVwb2NoPmAsIGAuL3RhaWxIYW5kb2ZmLnRzYCkuIFRoZSBmaXJzdCBmcmFtZSBvZiBhXG4gICAqICBkaWZmZXJlbnQgZXBvY2ggaXMgdGhlbiBhbiBlcG9jaCBjaGFuZ2UgbGlrZSBhbnkgb3RoZXIg4oCUIHdoaWNoIGlzIHdoYXRcbiAgICogIHN0b3BzIGEgYm9va21hcmsgb3V0bGl2aW5nIGl0cyBsb2cgYWNyb3NzIHByb2Nlc3Nlcy4gKi9cbiAgc2luY2VFcG9jaD86IHN0cmluZztcbiAgLyoqXG4gICAqIFJlYWQgYSBmcmFtZSB3aG9zZSBpZCBpcyBBVCBPUiBCRUxPVyB0aGUgY3Vyc29yIHRoaXMgY29ubmVjdGlvbiBhc2tlZFxuICAgKiBmcm9tIGFzIFwidGhlIGxvZyByZXN0YXJ0ZWRcIiwgcmVzZXQgdGhlIGN1cnNvciB0byAwLCBhbmQgY2FsbFxuICAgKiBgb25FcG9jaENoYW5nZWAgKHdpdGggdGhlIGZyYW1lJ3MgZXBvY2gsIG9yIGBcInVua25vd25cImApLiBEZWZhdWx0IGZhbHNlLlxuICAgKlxuICAgKiDim5QgV0hZIElUIElTIEhPTkVTVDogdGhlIGtpdCdzIGV2ZW50IGxvZyBhbnN3ZXJzIGEgY3Vyc29yIGJleW9uZCBpdHMgb3duXG4gICAqIGJ5IHJlcGxheWluZyBXSE9MRSAoYC4vZXZlbnRMb2cudHNgLCBwb2ludCAzKSwgYW5kIG90aGVyd2lzZSBzZW5kcyBvbmx5XG4gICAqIGlkcyBhYm92ZSB0aGUgY3Vyc29yLiBTbyBhIGZyYW1lIGF0IG9yIGJlbG93IHRoZSBhc2tlZCBjdXJzb3IgZXhpc3RzIG9ubHlcbiAgICogd2hlbiB0aGUgZGFlbW9uIGp1ZGdlZCB0aGUgY3Vyc29yIGZvcmVpZ24g4oCUIGEgcmVzdGFydGVkIGRhZW1vbiwgd2hvc2UgaWRzXG4gICAqIGJlZ2FuIGFnYWluIGF0IDEuIFRoZSBlcG9jaCBjYXRjaGVzIHRoYXQgV0lUSElOIG9uZSBwcm9jZXNzOyB0aGlzIGNhdGNoZXNcbiAgICogaXQgQUNST1NTIHByb2Nlc3Nlcywgd2hlcmUgYSByZS1hcm1lZCB0YWlsIGNhcnJpZXMgYSBib29rbWFyayBmcm9tIGEgbG9nXG4gICAqIHRoYXQgbm8gbG9uZ2VyIGV4aXN0cyBhbmQsIHdpdGhvdXQgaXQsIGtlcHQgdGhhdCBib29rbWFyayBmb3JldmVyOiBldmVyeVxuICAgKiByZS1hcm0gcmVwbGF5ZWQgdGhlIHdob2xlIG5ldyBsb2csIGFuZCBhIGAtLW9uY2VgIHdva2UgYXQgb25jZSwgaW4gYSBsb29wXG4gICAqIChmb3VuZCBieSB0aGUgdmVyaWZpZXIgb24gZmVhdC90YWlsLXF1aWV0LWhhbmRvZmYsIGFmdGVyIGB0YWlsLmxvc3RgIOKGklxuICAgKiBgb3BlbiAtLXJlc3RvcmVgKS5cbiAgICpcbiAgICog4pqgIE9OTFkgRk9SIEEgREFFTU9OIE9OIFRIRSBLSVQnUyBFVkVOVCBMT0cuIEdyYXBldmluZSdzIGlkcyBhcmUgcmVjb3ZlcmVkXG4gICAqIGFjcm9zcyBhIHJlc3RhcnQgYW5kIGl0cyBgLS1sYXN0YCBxdWVyeSBvdmVycmlkZXMgYHNpbmNlYCwgc28gaXQgbGVhdmVzXG4gICAqIHRoaXMgb2ZmLiBBbmQgdGhlIGJsaW5kIHNwb3QgaXMgc3RhdGVkOiBhIGJvb2ttYXJrIHRoYXQgaGFwcGVucyB0byBiZSBhdFxuICAgKiBvciBiZWxvdyB0aGUgUkVTVEFSVEVEIGxvZydzIG93biBsZW5ndGggbG9va3MgdmFsaWQgdG8gdGhlIGRhZW1vbiwgd2hpY2hcbiAgICogdGhlbiBzZW5kcyBvbmx5IHdoYXQgbGllcyBhYm92ZSBpdC4gVGhlIGNvbWUtYmFjayBwYXRoIHRoZXJlZm9yZSBkcm9wc1xuICAgKiB0aGUgYm9va21hcmsgYWx0b2dldGhlciAoYC4vdGFpbEhhbmRvZmYudHNgLCBEMiksIHNvIHRoaXMgaXMgdGhlIG5ldCwgbm90XG4gICAqIHRoZSBydWxlLlxuICAgKi9cbiAgcmVzdGFydE9uUmVwbGF5PzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIOKblCBUSEUgUkVUVVJORUQgTElORVxuICAgKiBHT0VTIFRPIGBlcnJgLCBOT1QgYG91dGAg4oCUIGl0IGlzIGEgZGlhZ25vc3RpYyBhYm91dCB0aGUgc3RyZWFtLCBhbmQgc3Rkb3V0XG4gICAqIGNhcnJpZXMgZGF0YS4gQSBzcGVsbCB0aGF0IGdlbnVpbmVseSB3YW50cyB0aGUgdW5wYXJzZWQgbGluZSBvbiBzdGRvdXRcbiAgICogKG9uZSBkb2VzKSB3cml0ZXMgaXQgZnJvbSBpbnNpZGUgdGhpcyBob29rIGFuZCByZXR1cm5zIG51bGwuXG4gICAqXG4gICAqIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGEgUEVSTUFORU5UTFlcbiAgICogbWFsZm9ybWVkIGZyYW1lIGlzIHJlLWRlbGl2ZXJlZCBvbiBldmVyeSByZWNvbm5lY3QgZm9yIHRoZSBkYWVtb24ncyBsaWZlLlxuICAgKi9cbiAgb25NYWxmb3JtZWQ/OiAoZnJhbWU6IFNzZUZyYW1lLCBlcnJvcjogdW5rbm93bikgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRU5EIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogVGhlIGZyYW1lIHRoYXQgZW5kcyB0aGUgd2F0Y2ggKGEgYGNsb3NlZGAgbGlmZWN5Y2xlIGV2ZW50KS4gT3B0aW9uYWwsIGFuZFxuICAgKiAgdGhhdCBpcyB0aGUgYWN0dWFsIHNoYXBlIG9mIHRoZSByb3N0ZXIgcmF0aGVyIHRoYW4gYSBoZWRnZTogc29tZSB0YWlscyBydW5cbiAgICogIGZvcmV2ZXIgYW5kIGhhdmUgbm8gdGVybWluYWwgZnJhbWUgYXQgYWxsLiBgYWNjZXB0ZWRgIGlzIGBhY2NlcHRgJ3NcbiAgICogIHZlcmRpY3Qgb24gdGhpcyBmcmFtZSwgd2hpY2ggaXMgd2hhdCBsZXRzIGB0YWlsIC0tb25jZWAgZW5kIG9uIHRoZSBmaXJzdFxuICAgKiAgZnJhbWUgaXQgYWN0dWFsbHkgREVMSVZFUlMgKGAuL3RhaWxIYW5kb2ZmLnRzYCkuXG4gICAqXG4gICAqICDim5QgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04gYmVmb3JlIHRoZSBjbGllbnQgcmV0dXJucy4gSXRcbiAgICogIHVzZWQgdG8gcmV0dXJuIGZyb20gaW5zaWRlIHRoZSByZWFkIGxvb3Agd2l0aCB0aGUgU1NFIHN0cmVhbSBzdGlsbCBvcGVuLFxuICAgKiAgd2hpY2gga2VwdCB0aGUgcHJvY2VzcyBhbGl2ZSDigJQgdW5zZWVuIGZvciBgY2xvc2VkYCwgYmVjYXVzZSB0aGUgc2VydmVyXG4gICAqICBlbmRzIHRoYXQgc3RyZWFtIGl0c2VsZiwgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrXG4gICAqICB3b3VsZCBuZXZlciBleGl0IGFuZCBzbyBuZXZlciB3YWtlIHRoZSBhZ2VudC4gKEFkanVzdG1lbnQgMSBvZiB0aGVcbiAgICogIE1vbml0b3ItZXhwaXJ5IHNwaWtlOyBwaW5uZWQgaW4gYHRhaWxIYW5kb2ZmLnRlc3QudHNgLikgKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUsIGFjY2VwdGVkOiBib29sZWFuKSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgIOKAlCB0aGUgc2VudGluZWxcbiAgICogIHRoYXQgbGV0cyBhIGAyPiYxYCBjb25zdW1lciB0ZWxsIFwiaWRsZVwiIGZyb20gXCJ3ZWRnZWRcIiDigJQgb3IgbnVsbC5cbiAgICogIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuIHRob3VnaCBvbmx5IGRhdGEgZnJhbWVzIHN1cnZpdmUgdGhlXG4gICAqICBzZWxlY3Rpb24gYmVsb3cg4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpcyBob29rIGlzIGNhbGxlZC4gKi9cbiAgb25Db21tZW50PzogKHRleHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIE9uZSBjb25uZWN0aW9uIGF0dGVtcHQgZW5kZWQuIFJldHVybiBhIGxpbmUgZm9yIGBlcnJgLCBvciBudWxsLlxuICAgKlxuICAgKiDim5QgVEhJUyBJUyBBIERJQUdOT1NUSUNTIFNJTkssIE5PVCBBIEZJRlRIIEVTQ0FQRSBIQVRDSCDigJQgYW5kIHRoZVxuICAgKiBkaXN0aW5jdGlvbiBpcyBhIHJ1bGluZywgbm90IGEgcHJlZmVyZW5jZS4gVGhlIGhhdGNoZXMgdGhpcyBjbGllbnQgb2ZmZXJzXG4gICAqIChgYWNjZXB0YCwgYHJlbmRlcmAsIGBxdWVyeWAsIGByZXNvbHZlYCkgYXJlIEJFSEFWSU9VUkFMOiB0aGV5IGNoYW5nZSB3aGF0XG4gICAqIHRoZSBjbGllbnQgRE9FUy4gVGhpcyBvbmUgY2hhbmdlcyBvbmx5IHdoYXQgdGhlIENBTExFUiBSRVBPUlRTLCB3aGljaCBpc1xuICAgKiB3aGF0IGBlcnJgIHdhcyBpbiB0aGUgc2lnbmF0dXJlIGZvci4gVGhlIGRlc2lnbidzIHRyaXAtd2lyZSDigJQgXCJhIGZpZnRoXG4gICAqIGVzY2FwZSBoYXRjaCBtZWFucyBncmFwZXZpbmUga2VlcHMgaXRzIG93biBsb29wXCIg4oCUIGlzIG5vdCB0cmlwcGVkIGJ5IGl0LlxuICAgKlxuICAgKiBJdCBleGlzdHMgYmVjYXVzZSBhIHRhaWwgdGhhdCByZWNvbm5lY3RzIGluIHNpbGVuY2UgaXMgaW5kaXN0aW5ndWlzaGFibGVcbiAgICogZnJvbSBhIHRhaWwgdGhhdCBpcyB3b3JraW5nLCBhbmQgb25lIHNwZWxsIHdyaXRlcyBmb3VyIGRpc3RpbmN0IGxpbmVzIGhlcmUuXG4gICAqIGBjYXVzZWAgc2F5cyB3aGljaDsgYGVycm9yYCBhbmQgYHN0YXR1c2AgY2Fycnkgd2hhdCB0aGUgbGluZSBuZWVkcy5cbiAgICovXG4gIG9uRGlzY29ubmVjdD86IChpbmZvOiB7XG4gICAgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiB8IFwiaHR0cFwiIHwgXCJuby1ib2R5XCIgfCBcInN0cmVhbS1lcnJvclwiIHwgXCJzdHJlYW0tZW5kXCI7XG4gICAgZXJyb3I/OiB1bmtub3duO1xuICAgIHN0YXR1cz86IG51bWJlcjtcbiAgfSkgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgUExVTUJJTkcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBXaGVyZSBEQVRBIGdvZXMuIERlZmF1bHQgYHByb2Nlc3Muc3Rkb3V0YC4gKi9cbiAgb3V0PzogU2luaztcbiAgLyoqIFdoZXJlIERJQUdOT1NUSUNTIGdvIOKAlCBrZWVwYWxpdmUgc2VudGluZWxzLCBkaXNjb25uZWN0IG5vdGVzLCB1bnBhcnNlYWJsZVxuICAgKiAgZnJhbWVzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZGVycmAuIE5ldmVyIG1peGVkIHdpdGggYG91dGA6IGEgY2FsbGVyIHJlYWRpbmdcbiAgICogIG91ciBzdGRvdXQgd2l0aCBhIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBtdXN0IG5ldmVyIG1lZXQgYSBub3RlLiAqL1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbiAgLyoqXG4gICAqIENhbGxlZCBvbmNlIGFzIHRoZSB0YWlsIGVuZHMsIHdpdGggdGhlIGZpbmFsIGN1cnNvciAodGhlIGJvb2ttYXJrIGEgcmUtYXJtXG4gICAqIHBhc3NlcyBhcyBgLS1zaW5jZWApIGFuZCB3aHkgaXQgZW5kZWQuIEEgUkVQT1JUIFNJTksgbGlrZSBgb25EaXNjb25uZWN0YCxcbiAgICogbm90IGEgYmVoYXZpb3VyYWwgaGF0Y2g6IGl0IGNoYW5nZXMgbm90aGluZyB0aGUgY2xpZW50IGRvZXMuIEl0IGV4aXN0c1xuICAgKiBmb3IgYC4vdGFpbEhhbmRvZmYudHNgLCB3aG9zZSBsYXN0IGxpbmUgbmFtZXMgdGhlIHJlLWFybSBhbmQgbXVzdCBjYXJyeVxuICAgKiB0aGUgY3Vyc29yIGV4YWN0bHkgYXMgdGhpcyBsb29wIGxlZnQgaXQsIGVwb2NoIHJlc2V0cyBpbmNsdWRlZC5cbiAgICovXG4gIG9uRW5kPzogKGVuZDoge1xuICAgIGN1cnNvcjogbnVtYmVyO1xuICAgIC8qKiBUaGUgZXBvY2ggb2YgdGhlIGxvZyB0aGUgY3Vyc29yIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgb25lLiAqL1xuICAgIGVwb2NoOiBzdHJpbmcgfCBudWxsO1xuICAgIHJlYXNvbjogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIjtcbiAgfSkgPT4gdm9pZDtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHtcbiAgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDtcbiAgY29tbWVudHM6IHN0cmluZ1tdO1xufSB7XG4gIGNvbnN0IGNvbW1lbnRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gIGxldCBldmVudCA9IFwibWVzc2FnZVwiO1xuICBsZXQgc2F3RGF0YSA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgIGlmIChsaW5lID09PSBcIlwiKSBjb250aW51ZTtcbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgY29tbWVudHMucHVzaChsaW5lLnNsaWNlKDEpKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBjb2xvbiA9IGxpbmUuaW5kZXhPZihcIjpcIik7XG4gICAgY29uc3QgZmllbGQgPSBjb2xvbiA9PT0gLTEgPyBsaW5lIDogbGluZS5zbGljZSgwLCBjb2xvbik7XG4gICAgbGV0IHZhbHVlID0gY29sb24gPT09IC0xID8gXCJcIiA6IGxpbmUuc2xpY2UoY29sb24gKyAxKTtcbiAgICBpZiAodmFsdWUuc3RhcnRzV2l0aChcIiBcIikpIHZhbHVlID0gdmFsdWUuc2xpY2UoMSk7XG4gICAgaWYgKGZpZWxkID09PSBcImRhdGFcIikge1xuICAgICAgZGF0YUxpbmVzLnB1c2godmFsdWUpO1xuICAgICAgc2F3RGF0YSA9IHRydWU7XG4gICAgfSBlbHNlIGlmIChmaWVsZCA9PT0gXCJldmVudFwiKSB7XG4gICAgICBldmVudCA9IHZhbHVlO1xuICAgIH1cbiAgICAvLyBgaWQ6YCBhbmQgYHJldHJ5OmAgYXJlIGRlbGliZXJhdGVseSBpZ25vcmVkIOKAlCBzZWUgdGhlIGhlYWRlci5cbiAgfVxuXG4gIGlmICghc2F3RGF0YSkgcmV0dXJuIHsgZnJhbWU6IG51bGwsIGNvbW1lbnRzIH07XG4gIHJldHVybiB7IGZyYW1lOiB7IGV2ZW50LCBkYXRhOiBkYXRhTGluZXMuam9pbihcIlxcblwiKSB9LCBjb21tZW50cyB9O1xufVxuXG4vKipcbiAqIFJ1biBhIHN0YW5kaW5nIFNTRSB0YWlsIHVudGlsIGl0IGVuZHMsIGFuZCByZXR1cm4gdGhlIHByb2Nlc3MgZXhpdCBjb2RlLlxuICpcbiAqIOKblCBJVCBORVZFUiBDQUxMUyBgcHJvY2Vzcy5leGl0YC4gVGhlIGNhbGxlciBkb2VzIGBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXRcbiAqIHRhaWxFdmVudHMoLi4uKWAgYW5kIHJldHVybnMgbmF0dXJhbGx5LiBTZWUgdGhlIFAwZiBzY2FyIGluIHRoaXMgZmlsZSdzXG4gKiBoZWFkZXIgZm9yIHdoeSB0aGF0IGlzIHRoZSB3aG9sZSBkZXNpZ24gYW5kIG5vdCBhIHN0eWxlIHByZWZlcmVuY2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB0YWlsRXZlbnRzPEV2PihvcHRzOiBUYWlsT3B0aW9uczxFdj4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSBvcHRzLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3QgZXJyID0gb3B0cy5lcnIgPz8gcHJvY2Vzcy5zdGRlcnI7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG9wdHMuc2luY2VFcG9jaCA/PyBudWxsO1xuICBsZXQgZXZlclJlc29sdmVkID0gZmFsc2U7XG4gIGxldCBldmVyQ29ubmVjdGVkID0gZmFsc2U7XG4gIGxldCBmaXJzdENvbm5lY3QgPSB0cnVlO1xuICBsZXQgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gIGxldCBjb2RlID0gMDtcbiAgbGV0IGVuZGluZzogXCJ0ZXJtaW5hbFwiIHwgXCJ1bnJlc29sdmVkXCIgfCBcInN0b3BwZWRcIiA9IFwic3RvcHBlZFwiO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCwgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdCBBTkQgV0FLRVMgVEhFIEJBQ0tPRkY7IHRoZSBsb29wIHRoZW4gZmFsbHMgb3V0IGFuZFxuICAvLyBSRVRVUk5TLlxuICAvL1xuICAvLyDim5QgV0FLSU5HIFRIRSBCQUNLT0ZGIElTIE5PVCBBIERFVEFJTCDigJQgSVQgSVMgVEhFIEN0cmwtQyBQQVRILiBJbnN0YWxsaW5nIGFcbiAgLy8gU0lHSU5UIGxpc3RlbmVyIFNVUFBSRVNTRVMgdGhlIHJ1bnRpbWUncyBkZWZhdWx0IHRlcm1pbmF0ZSwgc28gd2hhdGV2ZXJcbiAgLy8gdGhpcyBjbGllbnQgZG9lcyBvbiBhIHNpZ25hbCBpcyBub3cgdGhlIHdob2xlIG9mIHdoYXQgaGFwcGVucy4gQSBmaXJzdFxuICAvLyB2ZXJzaW9uIGFib3J0ZWQgdGhlIGF0dGVtcHQgYW5kIGxlZnQgdGhlIHJlY29ubmVjdCBzbGVlcGluZyBvbiBhIGJhcmVcbiAgLy8gdGltZXI6IEN0cmwtQyBkdXJpbmcgYmFja29mZiB0b29rIHVwIHRvIGByZXRyeS5tYXhNc2AgaW5zdGVhZCBvZiBlbmRpbmcgYXRcbiAgLy8gb25jZSwgbWVhc3VyZWQgYXQgMi44MHMgYWdhaW5zdCBhIGRlYWQgcG9ydCB3aGVyZSB0aGUgaGFuZC13cml0dGVuIGxvb3BcbiAgLy8gdG9vayAwLjEzcyDigJQgYW5kIGhhbW1lcmluZyBDdHJsLUMgZGlkIG5vdCBoZWxwLCBiZWNhdXNlIGV2ZXJ5IHJlcGVhdCBoaXRcbiAgLy8gdGhlIHNhbWUgc2xlZXBpbmcgdGltZXIuIEEgdGFpbCBzcGVuZHMgbW9zdCBvZiBhIGRlYWQgZGFlbW9uJ3MgbGlmZXRpbWVcbiAgLy8gaW5zaWRlIHRoaXMgc2xlZXAsIHNvIHRoYXQgaXMgdGhlIHN0YXRlIGEgaHVtYW4gaW50ZXJydXB0cy5cbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGF0dGVtcHQ6IEFib3J0Q29udHJvbGxlciB8IG51bGwgPSBudWxsO1xuICBsZXQgd2FrZUJhY2tvZmY6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xuICBjb25zdCBzdG9wID0gKGV4aXRDb2RlOiBudW1iZXIpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBjb2RlID0gZXhpdENvZGU7XG4gICAgYXR0ZW1wdD8uYWJvcnQoKTtcbiAgICB3YWtlQmFja29mZj8uKCk7XG4gIH07XG5cbiAgLyoqIFNsZWVwLCBidXQgcmV0dXJuIEFUIE9OQ0UgaWYgdGhlIHRhaWwgaXMgc3RvcHBlZCBtZWFud2hpbGUuICovXG4gIGNvbnN0IGJhY2tvZmYgPSAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4gPT5cbiAgICBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZVNsZWVwKSA9PiB7XG4gICAgICBpZiAoc3RvcHBlZCkgcmV0dXJuIHJlc29sdmVTbGVlcCgpO1xuICAgICAgY29uc3QgZmluaXNoID0gKCkgPT4ge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICB3YWtlQmFja29mZiA9IG51bGw7XG4gICAgICAgIHJlc29sdmVTbGVlcCgpO1xuICAgICAgfTtcbiAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dChmaW5pc2gsIG1zKTtcbiAgICAgIHdha2VCYWNrb2ZmID0gZmluaXNoO1xuICAgIH0pO1xuXG4gIGNvbnN0IG9uU2lnbmFsID0gKCkgPT4gc3RvcCgwKTtcbiAgY29uc3QgdXNlU2lnbmFscyA9IG9wdHMuc2lnbmFscyAhPT0gZmFsc2U7XG4gIGlmICh1c2VTaWduYWxzKSB7XG4gICAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICB9XG5cbiAgLy8gQSBkb3duc3RyZWFtIGBoZWFkYC9yZWFkZXIgY2xvc2luZyBvdXIgc3Rkb3V0IGlzIGEgY29tcGxldGVkIHJlYWQsIG5vdCBhXG4gIC8vIGNyYXNoOiBlbmQgYXQgMCBpbnN0ZWFkIG9mIGR5aW5nIG9uIEVQSVBFLlxuICBjb25zdCBvbk91dEVycm9yID0gKGU6IHVua25vd24pID0+IHtcbiAgICBpZiAoKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uIHwgdW5kZWZpbmVkKT8uY29kZSA9PT0gXCJFUElQRVwiKSBzdG9wKDApO1xuICB9O1xuICBjb25zdCBvdXRFbWl0dGVyID0gb3V0IGFzIHVua25vd24gYXMge1xuICAgIG9uPzogKGV2OiBzdHJpbmcsIGZuOiAoZTogdW5rbm93bikgPT4gdm9pZCkgPT4gdm9pZDtcbiAgICBvZmY/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICB9O1xuICBvdXRFbWl0dGVyLm9uPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcblxuICBjb25zdCBvbkNhbGxlckFib3J0ID0gKCkgPT4gc3RvcCgwKTtcbiAgb3B0cy5zaWduYWw/LmFkZEV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgaWYgKG9wdHMuc2lnbmFsPy5hYm9ydGVkKSBzdG9wKDApO1xuXG4gIGNvbnN0IGVtaXQgPSAobGluZTogc3RyaW5nKSA9PiB7XG4gICAgb3V0LndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG4gIC8qKiBFdmVyeSBkaWFnbm9zdGljIHRoZSBjbGllbnQgcHJvZHVjZXMgZ29lcyBoZXJlIGFuZCBOT1dIRVJFIGVsc2UsIHNvIGFcbiAgICogIGNhbGxlciBwYXJzaW5nIG91ciBzdGRvdXQgbmV2ZXIgbWVldHMgYSBub3RlIGFib3V0IG91ciBzdGRvdXQuICovXG4gIGNvbnN0IG5vdGUgPSAobGluZTogc3RyaW5nIHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xuICAgIGlmIChsaW5lICE9PSBudWxsICYmIGxpbmUgIT09IHVuZGVmaW5lZCkgZXJyLndyaXRlKGAke2xpbmV9XFxuYCk7XG4gIH07XG5cbiAgdHJ5IHtcbiAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgIC8vIOKaoCBERUxJQkVSQVRFTFkgVU5HVUFSREVELiBgcmVzb2x2ZWAgbWF5IHNwYXduLCBwcm9iZSwgb3IgcmFpc2UgYVxuICAgICAgLy8gdGF4b25vbXkgZmFpbHVyZSwgYW5kIHRoYXQgdGhyb3cgaXMgdGhlIENBTExFUidzIHRvIGFuc3dlciDigJQgd2hpY2ggaXNcbiAgICAgIC8vIHN0cmljdGx5IGJldHRlciB0aGFuIHRoZSBjb3BpZXMnIHNoYXBlLCB3aGVyZSBhIGBkaWVgIHdhcyByZWFjaGFibGVcbiAgICAgIC8vIGZyb20gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AgYW5kIGVuZGVkIHRoZSBwcm9jZXNzIGZyb20gdGhyZWUgZnJhbWVzXG4gICAgICAvLyBkb3duLlxuICAgICAgY29uc3QgYmFzZSA9IGF3YWl0IG9wdHMucmVzb2x2ZSgpO1xuICAgICAgLy8g4puUIEEgU1RPUCBUSEFUIExBTkRFRCBXSElMRSBgcmVzb2x2ZWAgV0FTIEFXQUlURUQgKHRoZSBoYW5kb2ZmJ3Mgd2luZG93LFxuICAgICAgLy8gYSBzaWduYWwpIGZvdW5kIG5vIGF0dGVtcHQgdG8gYWJvcnQuIFdpdGhvdXQgdGhpcyBjaGVjayB0aGUgbG9vcCB3ZW50XG4gICAgICAvLyBvbiB0byBmZXRjaCwgc2tpcHBlZCB0aGUgcmVhZCwgYW5kIHJldHVybmVkIHdpdGggdGhhdCBzdHJlYW0gc3RpbGxcbiAgICAgIC8vIG9wZW4g4oCUIHdoaWNoIGtlZXBzIGEgcHJvY2VzcyBhbGl2ZSBleGFjdGx5IGxpa2UgdGhlIHRlcm1pbmFsLWZyYW1lXG4gICAgICAvLyBoYW5nLiAoU3VzcGVjdGVkIGJ5IHRoZSByZXZpZXdlciwgcGlubmVkIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4pXG4gICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikge1xuICAgICAgICAgIGVuZGluZyA9IFwidW5yZXNvbHZlZFwiO1xuICAgICAgICAgIHJldHVybiBjb2RlO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8ge1xuICAgICAgICBzaW5jZTogU3RyaW5nKGN1cnNvciksXG4gICAgICB9O1xuICAgICAgLy8gV2hhdCB0aGlzIGNvbm5lY3Rpb24gYXNrZWQgZnJvbSwgZm9yIGByZXN0YXJ0T25SZXBsYXlgLlxuICAgICAgY29uc3QgYXNrZWRTaW5jZSA9IGN1cnNvcjtcbiAgICAgIGxldCByZXN0YXJ0Tm90ZWQgPSBmYWxzZTtcbiAgICAgIC8vIFNldCB3aGVuIGFuIGVwb2NoIGNoYW5nZSBmaW5kcyB0aGUgbmV3IGxvZyBwYXN0IHRoZSBib29rbWFyay5cbiAgICAgIGxldCBmcm9tVG9wID0gZmFsc2U7XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIGF0dGVtcHQgPSBudWxsO1xuICAgICAgICBpZiAoc3RvcHBlZCkgYnJlYWs7XG4gICAgICAgIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICB0cnkge1xuICAgICAgICBpZiAoIXJlcy5vaykge1xuICAgICAgICAgIC8vIE1heSB0aHJvdyDigJQgYSB0eXBlZCByZWZ1c2FsIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGJsaXAuXG4gICAgICAgICAgYXdhaXQgb3B0cy5vbkh0dHBFcnJvcj8uKHJlcyk7XG4gICAgICAgICAgLy8g4puUIENBTkNFTCBUSEUgQk9EWSBCRUZPUkUgTE9PUElORy4gQW4gdW5yZWFkIHJlc3BvbnNlIGJvZHkgaG9sZHMgYVxuICAgICAgICAgIC8vIHN0cmVhbSBvcGVuLCBhbmQgdGhpcyBicmFuY2ggcnVucyBvbmNlIHBlciBmYWlsZWQgYXR0ZW1wdCBmb3IgYXNcbiAgICAgICAgICAvLyBsb25nIGFzIHRoZSBkYWVtb24gaXMgdW5oYXBweSDigJQgd2hpY2ggaXMgZXhhY3RseSB0aGUgbG9uZy1ydW5uaW5nXG4gICAgICAgICAgLy8gY2FzZS4gVGhlIGhvb2sgbWF5IGFscmVhZHkgaGF2ZSByZWFkIGl0OyBjYW5jZWwgaXMgYSBuby1vcCB0aGVuLlxuICAgICAgICAgIGF3YWl0IHJlcy5ib2R5Py5jYW5jZWwoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiaHR0cFwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXMuYm9keSkge1xuICAgICAgICAgIC8vIOKblCBBIDIwMCBXSVRIIE5PIEJPRFkgTVVTVCBHUk9XIFRIRSBCQUNLT0ZGIGxpa2UgZXZlcnkgb3RoZXIgZmFpbGVkXG4gICAgICAgICAgLy8gYXR0ZW1wdC4gT25lIHNwZWxsIHNwbGl0IHRoaXMgZ3VhcmQgZnJvbSBpdHMgc2libGluZyBhbmQgdGhlIHNlY29uZFxuICAgICAgICAgIC8vIGhhbGYgbG9zdCB0aGUgZ3Jvd3RoIGxpbmUg4oCUIGEgcmVjb25uZWN0IHN0b3JtIGF0IGEgY29uc3RhbnQgMjUwbXMuXG4gICAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwibm8tYm9keVwiLCBzdGF0dXM6IHJlcy5zdGF0dXMgfSkpO1xuICAgICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcblxuICAgICAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICAgICAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgICBsZXQgYnVmID0gXCJcIjtcblxuICAgICAgICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICAgICAgICBsZXQgY2h1bms6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgcmVhZGVyLnJlYWQ+PjtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGlmICghc3RvcHBlZCkgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwic3RyZWFtLWVycm9yXCIsIGVycm9yOiBlIH0pKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkge1xuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZW5kXCIgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIOKblCBUSEUgQkFDS09GRiBSRVNFVFMgT04gVEhFIEZJUlNUIEJZVEUsIE5PVCBPTiBBIFNVQ0NFU1NGVUwgT1BFTiDigJRcbiAgICAgICAgICAvLyBhbmQgdGhhdCBpcyBXSURFUiB0aGFuIHRoZSBkZWZlY3QgaXQgd2FzIHdyaXR0ZW4gZm9yLiBCNSBpc1xuICAgICAgICAgIC8vIHJlY29yZGVkIGFzIFwiYSAyMDAgd2l0aCBubyBib2R5IHNsZWVwcyB3aXRob3V0IGdyb3dpbmcgdGhlXG4gICAgICAgICAgLy8gYmFja29mZlwiOyByZXNldHRpbmcgYXQgdGhlIG9wZW4gaGFzIHRoZSBzYW1lIHNoYXBlIGZvciBBTllcbiAgICAgICAgICAvLyBjb25uZWN0aW9uIHRoYXQgaXMgYWNjZXB0ZWQgYW5kIHRoZW4geWllbGRzIG5vdGhpbmcsIHdoaWNoIGlzIHdoYXRcbiAgICAgICAgICAvLyBhIGRhZW1vbiBtaWQtcmVzdGFydCBkb2VzLiBEcml2ZW46IHJlc2V0LWF0LW9wZW4gZ2l2ZXMgYSBjb25zdGFudFxuICAgICAgICAgIC8vIDQxbXMgcmVjb25uZWN0IGFnYWluc3QgYSBzZXJ2ZXIgdGhhdCBhY2NlcHRzIGFuZCBjbG9zZXM7IHJlc2V0LWF0LVxuICAgICAgICAgIC8vIGZpcnN0LWJ5dGUgZ2l2ZXMgNDAsIDgwLCAxNjAuIEEgYnl0ZSBpcyB0aGUgb25seSBldmlkZW5jZSB0aGVcbiAgICAgICAgICAvLyBkYWVtb24gaXMgYWN0dWFsbHkgdGFsa2luZyB0byB1cy5cbiAgICAgICAgICBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgICAgICAgICAvLyDim5QgQkVGT1JFIEZSQU1FIFBBUlNJTkcuIEEga2VlcGFsaXZlIGNvbW1lbnQgY2FycmllcyBubyBkYXRhIGFuZCBpc1xuICAgICAgICAgIC8vIGRpc2NhcmRlZCB3aGVuIGRhdGEgZnJhbWVzIGFyZSBzZWxlY3RlZCBiZWxvdywgYnV0IGl0IGlzIHRoZSBwcm9vZiB0aGUgc29ja2V0IGlzXG4gICAgICAgICAgLy8gYWxpdmUg4oCUIGZlZWRpbmcgdGhlIHdhdGNoZG9nIG9ubHkgb24gREFUQSBhYm9ydHMgZXZlcnkgaGVhbHRoeSBidXRcbiAgICAgICAgICAvLyBxdWlldCBjb25uZWN0aW9uLlxuICAgICAgICAgIHJlc2V0V2F0Y2hkb2coKTtcbiAgICAgICAgICBidWYgKz0gZGVjb2Rlci5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuXG4gICAgICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgICAgIGNvbnN0IHsgZnJhbWUsIGNvbW1lbnRzIH0gPSBwYXJzZVNzZUZyYW1lKGJsb2NrKTtcbiAgICAgICAgICAgIGZvciAoY29uc3QgdGV4dCBvZiBjb21tZW50cykgbm90ZShvcHRzLm9uQ29tbWVudD8uKHRleHQpKTtcbiAgICAgICAgICAgIGlmICghZnJhbWUpIGNvbnRpbnVlO1xuXG4gICAgICAgICAgICBsZXQgZXY6IEV2O1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgZXYgPSBKU09OLnBhcnNlKGZyYW1lLmRhdGEpIGFzIEV2O1xuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBub3RlKG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkpO1xuICAgICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuXG4gICAgICAgICAgICBsZXQgZXBvY2hSZXNldCA9IGZhbHNlO1xuICAgICAgICAgICAgaWYgKG9wdHMuZXBvY2hPZikge1xuICAgICAgICAgICAgICBjb25zdCBuZXh0ID0gb3B0cy5lcG9jaE9mKGV2KTtcbiAgICAgICAgICAgICAgaWYgKHR5cGVvZiBuZXh0ID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVwb2NoICE9PSBudWxsICYmIG5leHQgIT09IGVwb2NoKSB7XG4gICAgICAgICAgICAgICAgICBjdXJzb3IgPSAwO1xuICAgICAgICAgICAgICAgICAgZXBvY2hSZXNldCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgICAgLy8gVGhlIG5ldyBsb2cgaXMgcGFzdCB0aGUgYm9va21hcms6IGl0cyBzdGFydCB3YXMgc2tpcHBlZC5cbiAgICAgICAgICAgICAgICAgIC8vIERyb3AgdGhpcyBhdHRlbXB0IGFuZCByZS1yZWFkIHRoZSBuZXcgbG9nIGZyb20gMC5cbiAgICAgICAgICAgICAgICAgIGlmIChhc2tlZFNpbmNlID4gMCAmJiB0eXBlb2YgbiA9PT0gXCJudW1iZXJcIiAmJiBuID4gYXNrZWRTaW5jZSkge1xuICAgICAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgICAgICAgIGZyb21Ub3AgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZXBvY2ggPSBuZXh0O1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgIG9wdHMucmVzdGFydE9uUmVwbGF5ID09PSB0cnVlICYmXG4gICAgICAgICAgICAgICFlcG9jaFJlc2V0ICYmXG4gICAgICAgICAgICAgICFyZXN0YXJ0Tm90ZWQgJiZcbiAgICAgICAgICAgICAgYXNrZWRTaW5jZSA+PSAwICYmXG4gICAgICAgICAgICAgIHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmXG4gICAgICAgICAgICAgIG4gPD0gYXNrZWRTaW5jZVxuICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgIC8vIFRoZSBkYWVtb24gcmVwbGF5ZWQgV0hPTEU6IGl0cyBsb2cgcmVzdGFydGVkIChzZWUgdGhlIG9wdGlvbikuXG4gICAgICAgICAgICAgIHJlc3RhcnROb3RlZCA9IHRydWU7XG4gICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLm9uRXBvY2hDaGFuZ2U/LihvcHRzLmVwb2NoT2Y/LihldikgPz8gXCJ1bmtub3duXCIpID8/IG51bGw7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYsIGZyYW1lLCBhY2NlcHRlZCkgPz8gZmFsc2U7XG5cbiAgICAgICAgICAgIGlmIChhY2NlcHRlZCB8fCAoaXNUZXJtaW5hbCAmJiBvcHRzLnRlcm1pbmFsRW1pdHNGaWx0ZXJlZCA9PT0gdHJ1ZSkpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMucmVuZGVyID8gb3B0cy5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzVGVybWluYWwpIHtcbiAgICAgICAgICAgICAgLy8g4puUIENMT1NFIFRIRSBDT05ORUNUSU9OLiBTZWUgYHRlcm1pbmFsYCdzIGRvYzogd2l0aG91dCB0aGlzIHRoZVxuICAgICAgICAgICAgICAvLyBvcGVuIHN0cmVhbSBrZWVwcyB0aGUgcHJvY2VzcyBhbGl2ZSBhZnRlciB3ZSByZXR1cm4uXG4gICAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgICAgZW5kaW5nID0gXCJ0ZXJtaW5hbFwiO1xuICAgICAgICAgICAgICByZXR1cm4gY29kZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKGZyb21Ub3ApIHtcbiAgICAgICAgICAgIGNvbnRyb2xsZXIuYWJvcnQoKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgaWYgKHdhdGNoZG9nICE9PSBudWxsKSBjbGVhclRpbWVvdXQod2F0Y2hkb2cpO1xuICAgICAgICBhdHRlbXB0ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0b3BwZWQpIGJyZWFrO1xuICAgICAgaWYgKGZyb21Ub3ApIHtcbiAgICAgICAgLy8gUmUtcmVhZCB0aGUgbmV3IGxvZyBmcm9tIGl0cyBzdGFydCwgbm93OiBub3RoaW5nIGZhaWxlZC5cbiAgICAgICAgZGVsYXkgPSByZXRyeS5pbml0aWFsTXM7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuICAgICAgLy8g4puUIEFORCBUSEUgR1JPV1RIIExJTkUgQkVMT05HUyBIRVJFIFRPTy4gRXZlcnkgYGNvbnRpbnVlYCBhYm92ZSBncm93c1xuICAgICAgLy8gdGhlIGRlbGF5OyB0aGUgcGF0aCB0aGF0IGZhbGxzIHRocm91Z2gg4oCUIGEgY29ubmVjdGlvbiB0aGF0IE9QRU5FRCBhbmRcbiAgICAgIC8vIHRoZW4gZW5kZWQg4oCUIGRpZCBub3QsIGluIGFueSBvZiB0aGUgc2V2ZW4gaGFuZC13cml0dGVuIGxvb3BzLiBBZ2FpbnN0IGFcbiAgICAgIC8vIGRhZW1vbiB0aGF0IGFjY2VwdHMgYW5kIGltbWVkaWF0ZWx5IGNsb3NlcywgdGhhdCBpcyBhIHJlY29ubmVjdCBhdCBhXG4gICAgICAvLyBjb25zdGFudCAyNTBtcyBmb3IgYXMgbG9uZyBhcyBpdCBzdGF5cyBzaWNrLCB3aGljaCBpcyBCNSdzIHNoYXBlXG4gICAgICAvLyByZWFjaGVkIGJ5IGEgZGlmZmVyZW50IGRvb3IuIFRoZSByZXNldCBvbiB0aGUgZmlyc3QgYnl0ZSAoYWJvdmUpIGlzXG4gICAgICAvLyB3aGF0IGtlZXBzIHRoaXMgZnJvbSBzbG93aW5nIGEgaGVhbHRoeSB0YWlsIGRvd24uXG4gICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgfVxuICAgIHJldHVybiBjb2RlO1xuICB9IGZpbmFsbHkge1xuICAgIGlmICh1c2VTaWduYWxzKSB7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR0lOVFwiLCBvblNpZ25hbCk7XG4gICAgICBwcm9jZXNzLm9mZihcIlNJR1RFUk1cIiwgb25TaWduYWwpO1xuICAgIH1cbiAgICBvdXRFbWl0dGVyLm9mZj8uKFwiZXJyb3JcIiwgb25PdXRFcnJvcik7XG4gICAgb3B0cy5zaWduYWw/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJhYm9ydFwiLCBvbkNhbGxlckFib3J0KTtcbiAgICBvcHRzLm9uRW5kPy4oeyBjdXJzb3IsIGVwb2NoLCByZWFzb246IGVuZGluZyB9KTtcbiAgfVxufVxuIiwKICAgICIvKipcbiAqIFRoZSB0YWlsJ3MgSEFORE9GRjogaG93IGEgc3BlbGwncyBgdGFpbGAgZW5kcyBpdHMgb3duIHdhdGNoIGp1c3QgYmVmb3JlIHRoZVxuICogaGFybmVzcydzIE1vbml0b3IgY2FwLCBhbmQgdGhlIG9uZSBzdGRvdXQgbGluZSB0aGF0IG5hbWVzIHRoZSBhZ2VudCdzIG5leHRcbiAqIGFjdCwgYm9va21hcmsgaW5jbHVkZWQuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBUaGlzIG1vZHVsZSBpbXBvcnRzIG9ubHkgaXRzIHNpYmxpbmcgYC4vdGFpbEV2ZW50c2AuXG4gKlxuICogQnVpbHQgb24gYGZlYXQvdGFpbC1xdWlldC1oYW5kb2ZmYCB0byBDb2xlJ3MgcnVsaW5nIG9mIDIwMjYtMDktMjMgKHRoZVxuICogXCJSdWxpbmdcIiBzZWN0aW9uIG9mXG4gKiBgZG9jcy9pdGVtcy9zY3JpcHRvcml1bS10YWlsLW1vbml0b3ItZXhwaXJ5LXdha2VzLXRoZS1hZ2VudC1mb3Itbm90aGluZy5tZGApXG4gKiBhbmQgdGhlIGZvdXIgYWRqdXN0bWVudHMgb2YgaXRzIGZlYXNpYmlsaXR5IHNwaWtlXG4gKiAoYGRvY3MvaXRlbXMvbW9uaXRvci1leHBpcnktYW5kLXRoZS10YWlsL3dyaXRlLXVwLm1kYCkuXG4gKlxuICog4pSA4pSAIFRIRSBQUk9CTEVNLCBPTkUgUEFSQUdSQVBIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIENsYXVkZSBDb2RlJ3MgTW9uaXRvciBraWxscyBldmVyeSB3YXRjaCBhdCAxLDgwMCwwMDAgbXMuIEV2ZXJ5IHNwZWxsIHRlbGxzXG4gKiB0aGUgYWdlbnQgdG8gd3JhcCBgdGFpbGAgaW4gTW9uaXRvciwgc28gYW4gaWRsZSBzZXNzaW9uIHdva2UgdGhlIGFnZW50IGV2ZXJ5XG4gKiAzMCBtaW51dGVzIHRvIHJlLWFybSwgYW5kIGEgYmFyZSByZS1hcm0gcmVwbGF5ZWQgdXAgdG8gdGhlIGxhc3QgMTAwMCBldmVudHMsXG4gKiBhbnN3ZXJlZCBodW1hbiBtZXNzYWdlcyBpbmNsdWRlZC4gVGhlIHJlcGxheSBpcyBhIGNvcnJlY3RuZXNzIGJ1ZzsgdGhlIGlkbGVcbiAqIHdha2VzIGFyZSBhIGNvc3QgQ29sZSBydWxlZCBhZ2FpbnN0LlxuICpcbiAqIOKUgOKUgCBUSEUgU0hBUEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVHdvIG1vZGVzLCBvbmUgbGluZSBhdCB0aGUgZW5kIG9mIGVhY2g6XG4gKlxuICogICDigKIgYHdhdGNoYCAodGhlIGRlZmF1bHQsIHJ1biB1bmRlciBNb25pdG9yKTogc3RyZWFtcyB1bnRpbCBpdHMgV0lORE9XIGVuZHMsXG4gKiAgICAgdGhlbiBwcmludHMgYHRhaWwud2luZG93YCAoaXQgc2F3IGV2ZW50cyDihpIgcmUtYXJtIE1vbml0b3IpIG9yXG4gKiAgICAgYHRhaWwucXVpZXRgIChpdCBzYXcgbm9uZSDihpIgcnVuIGB0YWlsIC0tb25jZWAgYXMgYSBiYWNrZ3JvdW5kIEJhc2hcbiAqICAgICB0YXNrKS4gQSBQUkVTRU5DRSBzcGVsbCAoYXN0cm9sYWJlLCBncmFwZXZpbmUpIGFsd2F5cyBnZXRzXG4gKiAgICAgYHRhaWwud2luZG93YDogYSBzdG9wLXN0YXJ0IHRhaWwgd291bGQgZmxpY2tlciB0aGUgcHJlc2VuY2UgaXRzXG4gKiAgICAgY29ubmVjdGlvbiBjYXJyaWVzLiBNaW5kLW1hcHBlciB3YXMgb25lIGFuZCBpcyBub3Qgc2luY2UgMjAyNi0wOS0yNFxuICogICAgIChzZWUgXCJNSU5ELU1BUFBFUiBKT0lOUyBUSEUgU0VTU0lPTiBTUEVMTFNcIiBiZWxvdykuXG4gKiAgIOKAoiBgb25jZWAgKHJ1biBhcyBhIGJhY2tncm91bmQgQmFzaCB0YXNrKTogc2xlZXBzIHVudGlsIHRoZSBmaXJzdCBsb2cgZXZlbnQsXG4gKiAgICAgcHJpbnRzIGl0LCBwcmludHMgYHRhaWwud29rZWAgKOKGkiBiYWNrIHRvIE1vbml0b3IpIGFuZCBFWElUUywgd2hpY2ggaXNcbiAqICAgICB3aGF0IHdha2VzIHRoZSBhZ2VudC5cbiAqXG4gKiBFaXRoZXIgbW9kZSBlbmRzIHdpdGggYHRhaWwuY2xvc2VkYCB3aGVuIHRoZSBzZXNzaW9uIGNsb3NlcyBhbmQgYHRhaWwubG9zdGBcbiAqIHdoZW4gdGhlIGRhZW1vbiBpcyBnb25lIChzZXNzaW9uIHNwZWxscyBhbmQgbWluZC1tYXBwZXIpLCBlYWNoIG5hbWluZyBob3cgdG9cbiAqIGNvbWUgYmFjayBpbnN0ZWFkIG9mIGEgcmUtYXJtLiBBIHNpZ25hbCBvciBhIGNhbGxlcidzIGFib3J0IHByaW50cyBub3RoaW5nLlxuICpcbiAqIEV2ZXJ5IHJlLWFybSBjYXJyaWVzIGAtLXNpbmNlIDxjdXJzb3I+YCwgc28gbm90aGluZyByZXBsYXlzOyB0aGUgZGFlbW9uJ3NcbiAqIGJ1ZmZlciBjb3ZlcnMgd2hhdGV2ZXIgbGFuZHMgYmV0d2VlbiBvbmUgd2F0Y2gncyBleGl0IGFuZCB0aGUgbmV4dCdzIGFybS5cbiAqXG4gKiDilIDilIAgREVDSVNJT04gTE9HIChmZWF0L3RhaWwtcXVpZXQtaGFuZG9mZiwgMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogS2l0IGRlY2lzaW9ucyBsaXZlIGluIG1vZHVsZSBoZWFkZXJzICh0aGUgYXJjaGl0ZWN0dXJlIGRvYydzIMKnNCBydWxlOiBcImVhY2hcbiAqIG1vZHVsZSdzIGhlYWRlciBpcyB0aGUgYXV0aG9yaXRhdGl2ZSBhY2NvdW50XCIpLiBSdWxlZCBieSBDb2xlOiB0aGUgaHlicmlkLFxuICogdGhlIGFsd2F5cy1ib29rbWFyaywgcHJlc2VuY2Ugc3BlbGxzIGFsd2F5cyByZS1hcm0gTW9uaXRvciwgYm91bnR5J3MgZXhhbXBsZVxuICogZml4ZWQuIFRoZSBmb3VyIGFkanVzdG1lbnRzIHdlcmUgdGhlIHNwaWtlJ3MgcmVxdWlyZW1lbnRzLiBUaGUgcmVzdCBhcmUgdGhlXG4gKiBpbXBsZW1lbnRlcidzIHJ1bGluZ3MsIG1hcmtlZCDimpYgd2l0aCB0aGUgb3B0aW9ucyBub3QgdGFrZW4uXG4gKlxuICogQTEgwrcgQSBURVJNSU5BTCBGUkFNRSBDTE9TRVMgVEhFIENPTk5FQ1RJT04uIGB0YWlsRXZlbnRzYCBub3cgYWJvcnRzIHRoZVxuICogICAgICBpbi1mbGlnaHQgZmV0Y2ggYmVmb3JlIGl0IHJldHVybnMgb24gYSB0ZXJtaW5hbCBmcmFtZS4gQmVmb3JlLCBpdFxuICogICAgICByZXR1cm5lZCBmcm9tIGluc2lkZSB0aGUgcmVhZCBsb29wIGFuZCBsZWZ0IHRoZSBTU0Ugc3RyZWFtIG9wZW4sIHNvIHRoZVxuICogICAgICBwcm9jZXNzIHN0YXllZCBhbGl2ZTogdW5zZWVuIGZvciBgY2xvc2VkYCAodGhlIHNlcnZlciBlbmRzIHRoYXRcbiAqICAgICAgc3RyZWFtIGl0c2VsZikgYW5kIGZhdGFsIGZvciBgLS1vbmNlYCwgd2hvc2UgYmFja2dyb3VuZCB0YXNrIHdvdWxkXG4gKiAgICAgIG5ldmVyIGV4aXQgYW5kIHNvIG5ldmVyIHdha2UgdGhlIGFnZW50LCBzaWxlbnRseS4gUGlubmVkIGluXG4gKiAgICAgIGB0YWlsSGFuZG9mZi50ZXN0LnRzYCBhZ2FpbnN0IGEgc2VydmVyIHRoYXQga2VlcHMgdGhlIHN0cmVhbSBvcGVuLlxuICpcbiAqIEEyIMK3IFRIRSBORVhUIEFDVCBERVBFTkRTIE9OIFNUQVRFLiBgaGFuZG9mZigpYCBiZWxvdyBpcyB0aGUgcHVyZSBkZWNpc2lvbjpcbiAqICAgICAgcXVpZXQg4oaSIGJhY2tncm91bmQsIGFjdGl2ZSBvciBwcmVzZW5jZSDihpIgTW9uaXRvciwgd29rZSDihpIgTW9uaXRvcixcbiAqICAgICAgY2xvc2VkIOKGkiBjb21lIGJhY2ssIGxvc3Qg4oaSIGNvbWUgYmFjay4gQ29tZSBiYWNrIGlzIHRoZSBzcGVsbCdzIG93biB2ZXJiXG4gKiAgICAgIChgb3BlbiAtLXJlc3RvcmUgPGlkPmAgZm9yIHRoZSBzZXNzaW9uIHNwZWxscywgYG9wZW4gLS1uby1vcGVuYCBmb3JcbiAqICAgICAgbWluZC1tYXBwZXIgYW5kIGFzdHJvbGFiZSkuXG4gKiAgICAgIOKaliBUSEUgRElTQ09OTkVDVCBERUNJU0lPTjogZm9yIGEgc2Vzc2lvbiBzcGVsbCwgYSBMT1NUIGRhZW1vbiBlbmRzIHRoZVxuICogICAgICB0YWlsIGluIEJPVEggbW9kZXMgd2l0aCBhIHN0ZG91dCBgdGFpbC5sb3N0YCBsaW5lLiBNb25pdG9yIG5vdGlmaWVzIG9ubHlcbiAqICAgICAgb24gc3Rkb3V0LCBzbyB0aGUgb2xkIHN0ZGVyci1vbmx5IGB0YWlsLmRpc2Nvbm5lY3RlZGAgbGVmdCBhXG4gKiAgICAgIE1vbml0b3Itd3JhcHBlZCBhZ2VudCB1bmF3YXJlIG9mIGEgYGtpbGwgLTlgIChFNTUncyBwdXJwb3NlIHVubWV0KSwgYW5kXG4gKiAgICAgIGEgYC0tb25jZWAgb24gYSBkZWFkIGRhZW1vbiB3b3VsZCBoYXZlIHNsZXB0IGZvcmV2ZXIuIFwiTG9zdFwiIGlzXG4gKiAgICAgIGBMT1NUX0FGVEVSX1JFRlVTQUxTYCBjb25uZWN0aW9uIHJlZnVzYWxzIGluIGEgcm93LCBuZXZlciBhIGRyb3BwZWRcbiAqICAgICAgc3RyZWFtIGFsb25lOiBhIGxhcHRvcCB0aGF0IHNsZWVwcyBkcm9wcyB0aGUgc3RyZWFtLCByZWNvbm5lY3RzIG9uIHRoZVxuICogICAgICBmaXJzdCB0cnksIGFuZCBtdXN0IHN0YXkgc2lsZW50LlxuICogICAgICAgIE5vdCB0YWtlbjogKGEpIGtlZXAgcmV0cnlpbmcgYW5kIG9ubHkgTU9WRSB0aGUgZGlzY29ubmVjdCBsaW5lIHRvXG4gKiAgICAgICAgc3Rkb3V0IOKAlCBhIHNlc3Npb24gZGFlbW9uIGlzIG5ldmVyIHJlc3Bhd25lZCBieSBpdHMgdGFpbCwgc28gdGhlXG4gKiAgICAgICAgcmV0cmllcyBidXkgbm90aGluZyBhbmQgdGhlIGFnZW50IGlzIHdva2VuIHRvIGJlIHRvbGQgdG8gd2FpdDsgKGIpXG4gKiAgICAgICAgbGVhdmUgaXQgb24gc3RkZXJyIOKAlCB0aGUgZGVmZWN0LlxuICogICAgICDimpYgUHJlc2VuY2Ugc3BlbGxzIGtlZXAgcmV0cnlpbmcsIGFzIGJlZm9yZTogZ3JhcGV2aW5lJ3MgdGFpbCByZXNwYXduc1xuICogICAgICBpdHMgZGFlbW9uIGFuZCBhc3Ryb2xhYmUncyBgam9pbmAgd2FpdHMgZm9yIHRoZSBodW1hbiB0byByZW9wZW4gdGhlXG4gKiAgICAgIGJvYXJkLCBib3RoIGJ5IGRlc2lnbi4gVGhlaXIgZGlzY29ubmVjdCBub3RlcyBzdGF5IHdoZXJlIHRoZXkgd2VyZS5cbiAqXG4gKiBBMyDCtyBRVUlFVCBJUyBUSEUgVEFJTCdTIE9XTiBDT1VOVC4gYGV2ZW50c2AgY291bnRzIHRoZSBsb2cgZnJhbWVzIHRoaXNcbiAqICAgICAgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQuIFRoZSBncm91bmRpbmcgbGluZSwgYSBzcGVsbCdzIGBzdWJzY3JpYmVkYFxuICogICAgICBtYXJrZXIsIGBlcG9jaC5jaGFuZ2VkYCBhbmQgdGhlIGhhbmRvZmYgbGluZSBpdHNlbGYgYXJlIG5vdCBsb2cgZnJhbWVzXG4gKiAgICAgIGFuZCBhcmUgbm90IGNvdW50ZWQ6IGEgZnJhbWUgY291bnRzIG9ubHkgaWYgaXQgY2FycmllcyBhIGxvZyBpZCAoRDMpLFxuICogICAgICBhbmQgYGNvdW50c2AgbGV0cyBhIHNwZWxsIGV4Y2x1ZGUgYSBmcmFtZSB0aGF0IGRvZXMgKGdyYXBldmluZSdzXG4gKiAgICAgIGBzdWJzY3JpYmVkYCBtYXJrZXIsIHdoaWNoIHNlZWRzIHRoZSBib29rbWFyayBmcm9tIGBsYXRlc3RfaWRgKS4gQW55IGxvZyBmcmFtZSBjb3VudHMsIHRoZSBkYWVtb24ncyBgd2FpdGluZ2AgcmVtaW5kZXJcbiAqICAgICAgaW5jbHVkZWQsIHNvIFwicXVpZXRcIiBtZWFucyBub3RoaW5nIG9uIHRoZSBsb2cuXG4gKiAgICAgIOKaliBBIGZyYW1lIHRoZSB0YWlsJ3Mgb3duIGZpbHRlciByZWplY3RzIChib3VudHkncyBvd25lciBzY29wZSwgYVxuICogICAgICBzZWxmLWVjaG8pIGlzIE5PVCBjb3VudGVkIGFuZCBkb2VzIG5vdCBlbmQgYSBgLS1vbmNlYDogaXQgd2FzIG5ldmVyXG4gKiAgICAgIGRlbGl2ZXJlZCwgYW5kIHdha2luZyBvbiBpdCB3b3VsZCBiZSBhIHdha2Ugd2l0aCBub3RoaW5nIHRvIGFjdCBvbiDigJRcbiAqICAgICAgdGhlIGRlZmVjdCB0aGlzIG1vZHVsZSBleGlzdHMgdG8gcmVtb3ZlLiBUaGUgY3Vyc29yIHN0aWxsIGFkdmFuY2VzXG4gKiAgICAgIHBhc3QgaXQgKHRhaWxFdmVudHMnIHJ1bGUpLCBzbyBpdCBuZXZlciByZXBsYXlzIGVpdGhlci5cbiAqICAgICAgQSBgLS1zaW5jZWAgcmUtYXJtIHByaW50cyBubyBncm91bmRpbmcgbGluZTsgdGhhdCBoYWxmIGxpdmVzIGluIGVhY2hcbiAqICAgICAgc3BlbGwncyBgdGFpbGAsIHdoaWNoIGtub3dzIHdoZXRoZXIgYC0tc2luY2VgIHdhcyBnaXZlbi5cbiAqXG4gKiBBNCDCtyBUSEUgV0lORE9XLiBgREVGQVVMVF9XSU5ET1dfTVNgID0gdGhlIGNhcCBtaW51cyBgV0lORE9XX01BUkdJTl9NU2BcbiAqICAgICAgKDYwIHMpLCBzbyAxLDc0MCwwMDAgbXMuIFRoZSBtYXJnaW4gaGFzIHRvIGNvdmVyIHRoZSBnYXAgYmV0d2VlbiB0aGVcbiAqICAgICAgaGFybmVzcyBzdGFydGluZyBpdHMgY2xvY2sgYW5kIHRoaXMgcHJvY2VzcyBzdGFydGluZyBpdHMgb3duIChCdW5cbiAqICAgICAgc3RhcnQtdXAsIGEgc2Vzc2lvbiBsb29rdXAsIGEgZGFlbW9uIHNwYXduIG9uIHRoZSBzcGVsbHMgd2hvc2UgYHJlc29sdmVgXG4gKiAgICAgIHNwYXducyBvbmUg4oCUIGJvdW5kZWQgYnkgdGhlaXIgc3RhcnQgdGltZW91dHMsIHdoaWNoIGFyZSBzZWNvbmRzKSBwbHVzXG4gKiAgICAgIHRoZSBsYXN0IGxpbmUncyBmbHVzaCBhbmQgTW9uaXRvcidzIDIwMCBtcyBiYXRjaGluZy4gQSBtaW51dGUgY292ZXJzXG4gKiAgICAgIGFsbCBvZiB0aGF0IG1hbnkgdGltZXMgb3Zlci4gVGhlIHNwaWtlIG1lYXN1cmVkIGEgMTIgc1xuICogICAgICB3aW5kb3cgdW5kZXIgYSAyMCBzIGNhcCBlbmRpbmcgY2xlYW5seTsgbm90aGluZyBoZXJlIGRlcGVuZHMgb24gYVxuICogICAgICBtYXJnaW4gdGhhdCB0aWdodC4gSWYgdGhlIGNhcCB3aW5zIGFueXdheSwgdGhlIGFnZW50IGdldHMgTW9uaXRvcidzXG4gKiAgICAgIGJhcmUgZXhwaXJ5IG5vdGljZSBhbmQgcmUtYXJtcyBzaWxlbnRseSBmcm9tIHRoZSBsYXN0IGlkIGl0IHNhdyDigJQgdGhlXG4gKiAgICAgIHJ1bGluZydzIGZhbGxiYWNrLCBzdGF0ZWQgaW4gZXZlcnkgc2tpbGwuXG4gKiAgICAgIOKaliBUaGUgd2luZG93IGlzIGluamVjdGFibGUgZm9yIHRlc3RzIGFuZCB2ZXJpZmljYXRpb24gdGhyb3VnaFxuICogICAgICBgU1BFTExCT09LX1RBSUxfV0lORE9XX01TYCAoYSBjb3VudCBvZiBtczsgYDBgIHR1cm5zIHRoZSB3aW5kb3cgb2ZmLFxuICogICAgICBmb3IgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsKS4gQW4gZW52IHZhciBhbmQgbm90IGEgZmxhZzogaXQgaXNcbiAqICAgICAgbm90IGFuIGFnZW50J3MgYWN0LCBzbyBpdCBzdGF5cyBvdXQgb2YgZWlnaHQgdmVyYnMnIHNjaGVtYXMuXG4gKlxuICog4pSA4pSAIFRIRSBWRVJJRklFUidTIERFRkVDVFMsIEZJWEVEIE9OIFRIRSBTQU1FIEJSQU5DSCAoMjAyNi0wOS0yMykg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogVGhlIG5vLXN0YWtlIHZlcmlmaWVyIHJhbiBldmVyeSBzcGVsbCdzIHJlYWwgdGFpbCBhbmQgZm91bmQgZm91ciB3YXlzIHRoZVxuICogbG9vcCBicm9rZS4gRWFjaCBoYXMgYSBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYDsgRDEgYW5kIEQyIGFsc28gaGF2ZSBhXG4gKiByZWFsLWRhZW1vbiBjZWxsIGluIGBzcmMvc2NyaXB0b3JpdW0vYmFja2VuZC90YWlsLWhhbmRvZmYuaW50ZWdyYXRpb24udGVzdC50c2AuXG4gKlxuICogRDEgwrcgQSBSRS1BUk0gQVQgQSBTRVNTSU9OIFRIQVQgQ0xPU0VEIElOIFRIRSBHQVAgRU5EUyBgdGFpbC5jbG9zZWRgLiBUaGVcbiAqICAgICAgdHJpZ2dlciBpcyBvcmRpbmFyeTogdGhlIGh1bWFuIHByZXNzZXMgQ2xvc2Ugd2hpbGUgdGhlIGFnZW50IGhhbmRsZXNcbiAqICAgICAgYHRhaWwud29rZWAuIFRoZSBzZXNzaW9uIHNwZWxscyBzdG9wcGVkIG9ubHkgd2hlbiBUSElTIHByb2Nlc3MgaGFkXG4gKiAgICAgIG9uY2UgcmVhY2hlZCB0aGUgc2Vzc2lvbiwgc28gdGhlIHJlLWFybSByZXRyaWVkIFwibm8gc2Vzc2lvbiB5ZXRcIiBvblxuICogICAgICBzdGRlcnIgZm9yZXZlciDigJQgYW5kIGl0cyBgLS1vbmNlYCBuZXZlciBleGl0ZWQuIFJ1bGU6IGEgdGFpbCBnaXZlblxuICogICAgICBgLS1zZXNzaW9uYCBvciBhIGJvb2ttYXJrIGlzIHJlLWFybWluZyBhbiBFWElTVElORyBzZXNzaW9uLCBzbyBub3RcbiAqICAgICAgZmluZGluZyBpdCBtZWFucyBpdCBjbG9zZWQ7IHRoZSBzcGVsbCdzIGBvblVucmVzb2x2ZWRgIHNheXMgXCJzdG9wXCJcbiAqICAgICAgYW5kIHRoaXMgbW9kdWxlIHJlYWRzIEFOWSBzdG9wIGFzIGNsb3NlZC4gQSBiYXJlIGZpcnN0IGFybSBzdGlsbFxuICogICAgICB3YWl0cyBmb3IgYSBzZXNzaW9uIHRvIGFwcGVhci4g4pqgIFwiR2l2ZW5cIiBtZWFucyBPTiBUSEUgQ09NTUFORCBMSU5FXG4gKiAgICAgIChyZXZpZXcgQjEpOiBib3VudHkgYWxzbyByZXNvbHZlcyBhIHNlc3Npb24gZnJvbVxuICogICAgICBgJEJPVU5UWV9TRVNTSU9OX0tFWWAsIGAkQk9VTlRZX1NFU1NJT05gIG9yIGEgYC5ib3VudHktc2Vzc2lvbmAgZmlsZSxcbiAqICAgICAgd2hpY2ggZXZlcnkgYW50aGlsbCBzZWF0IGhhcywgYW5kIGEgc2VhdCdzIGZpcnN0IGFybSBtdXN0IHdhaXQuIEFcbiAqICAgICAga2V5ZWQgYm91bnR5IGJvYXJkIGNvbWVzIGJhY2sgYnkgaXRzIGtleSAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCk7XG4gKiAgICAgIHJlc3RvcmluZyBpdCBieSBpZCBzcGF3bnMgYW4gdW5rZXllZCBzdHJheS5cbiAqIEQyIMK3IEEgQk9PS01BUksgQ0FOTk9UIE9VVExJVkUgSVRTIExPRy4gQSByZXN0b3JlZCBkYWVtb24ncyBpZHMgYmVnaW4gYXQgMSxcbiAqICAgICAgYW5kIHRoZSBraXQncyBsb2cgYW5zd2VycyBhIGN1cnNvciBiZXlvbmQgaXRzIG93biBieSByZXBsYXlpbmcgd2hvbGU7XG4gKiAgICAgIHRoZSB0YWlsIGtlcHQgaXRzIGhpZ2hlciBjdXJzb3IsIHNvIGV2ZXJ5IHJlLWFybSByZXBsYXllZCB0aGUgbmV3IGxvZ1xuICogICAgICBhbmQgYSBgLS1vbmNlYCB3b2tlIGF0IG9uY2UsIGluIGEgbG9vcC4gVHdvIGhhbHZlczpcbiAqICAgICAgYW5kIGEgYC0tb25jZWAgd29rZSBhdCBvbmNlLCBpbiBhIGxvb3AuIFRocmVlIHBhcnRzOlxuICogICAgICAgIChhKSB0aGUgbmV0IOKAlCBgdGFpbEV2ZW50c2AnIGByZXN0YXJ0T25SZXBsYXlgLCBvbiBmb3IgZXZlcnkgc3BlbGwsXG4gKiAgICAgICAgICAgIHJlYWRzIGEgZnJhbWUgYXQgb3IgYmVsb3cgdGhlIGFza2VkIGN1cnNvciBhcyBhIHJlc3RhcnRlZCBsb2dcbiAqICAgICAgICAgICAgYW5kIHJlc2V0cyB0aGUgY3Vyc29yO1xuICogICAgICAgIChiKSB0aGUgcnVsZSDigJQgdGhlIGB0YWlsLmNsb3NlZGAvYHRhaWwubG9zdGAgaGludCwgYW5kIGV2ZXJ5IHNraWxsLFxuICogICAgICAgICAgICBzYXk6IHJ1biB0aGUgY29tbWFuZCB0aGUgbGluZSBuYW1lcywgdGhlbiB0YWlsIFdJVEggTk9cbiAqICAgICAgICAgICAgYC0tc2luY2VgIChhIHJlc3RvcmVkIGRhZW1vbiBzdGFydHMgYSBuZXcgbG9nOyBib3VudHkncyByZXN0b3JlXG4gKiAgICAgICAgICAgIGV2ZW4gbWludHMgYSBuZXcgaWQpO1xuICogICAgICAgIChjKSBUSEUgRVBPQ0ggSU4gVEhFIEJPT0tNQVJLIOKAlCDimpYgQSBSRVZFUlNBTC4gVGhlIGZpcnN0IHZlcnNpb24gb2ZcbiAqICAgICAgICAgICAgdGhpcyBlbnRyeSBsaXN0ZWQgXCJjYXJyeSB0aGUgZXBvY2ggaW4gdGhlIGJvb2ttYXJrXCIgYXMgbm90IHRha2VuXG4gKiAgICAgICAgICAgIChhIG5ldyBmbGFnIG9uIGVpZ2h0IHZlcmJzOyBhbiBlcG9jaCBzZWVuIG9ubHkgb25jZSBhIGZyYW1lXG4gKiAgICAgICAgICAgIGFycml2ZXMpLiBUaGUgcmV2aWV3ZXIgdGhlbiBzaG93ZWQgKGEpJ3MgYmxpbmQgc3BvdCBMSVZFOiBhbiBvbGRcbiAqICAgICAgICAgICAgYm9va21hcmsgYXQgb3IgYmVsb3cgdGhlIE5FVyBsb2cncyBsZW5ndGggbWFrZXMgdGhlIGRhZW1vbiBzZW5kXG4gKiAgICAgICAgICAgIG9ubHkgd2hhdCBsaWVzIGFib3ZlIGl0LCBzbyB0aGUgbmV3IGxvZydzIGVhcmx5IGZyYW1lcyDigJQgYSBodW1hblxuICogICAgICAgICAgICBtZXNzYWdlIGF0IG5ldyBpZCAyIHVuZGVyIGEgYm9va21hcmsgb2YgNCDigJQgd2VyZSBza2lwcGVkIHdpdGggbm9cbiAqICAgICAgICAgICAgbm90aWNlLiBUaHJlZSBwYXRocyByZWFjaCBpdDogY29taW5nIGJhY2sgd2l0aG91dCBmb2xsb3dpbmcgKGIpO1xuICogICAgICAgICAgICB0aGUgTW9uaXRvci1jYXAgZmFsbGJhY2sgKFwicmUtYXJtIGZyb20gdGhlIGxhc3QgaWQgeW91IHNhd1wiKVxuICogICAgICAgICAgICBhY3Jvc3MgYSByZXN0YXJ0OyBhbmQgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbi1wcm9jZXNzXG4gKiAgICAgICAgICAgIChhc3Ryb2xhYmUsIG9yIG1pbmQtbWFwcGVyIHdoZW4gaXRzIGRhZW1vbiBpcyBiYWNrIGJlZm9yZSB0aGVcbiAqICAgICAgICAgICAgbG9zdCBydWxlIGZpcmVzKSB3aG9zZSBmaXJzdCBmcmFtZSBhZnRlciBhIHJlc3RhcnQgaXMgYWxyZWFkeVxuICogICAgICAgICAgICBwYXN0IGl0cyBib29rbWFyay5cbiAqICAgICAgICAgICAgVGhlIGZpeCBuZWVkcyBubyBuZXcgZmxhZyBhbmQgbm8gd2lyZSBjaGFuZ2U6IHRoZSBib29rbWFyayBpc1xuICogICAgICAgICAgICBwcmludGVkIGAtLXNpbmNlIE5APGVwb2NoPmAgKGBwYXJzZUJvb2ttYXJrYCksIHRoZSBjbGllbnQgc3RhcnRzXG4gKiAgICAgICAgICAgIHdpdGggdGhhdCBlcG9jaCAoYHNpbmNlRXBvY2hgKSwgYW5kIGFuIGVwb2NoIGNoYW5nZSB3aG9zZSBmcmFtZVxuICogICAgICAgICAgICBpcyBwYXN0IHRoZSBhc2tlZCBjdXJzb3IgcmUtcmVhZHMgdGhlIG5ldyBsb2cgZnJvbSAwLiBUaGUgc2FtZVxuICogICAgICAgICAgICByZWNvbm5lY3QgY292ZXJzIHRoZSBpbi1wcm9jZXNzIHByZXNlbmNlIGNhc2UuXG4gKiAgICAgIOKaoCBTVEFURUQgTElNSVQ6IG9ubHkgZGFlbW9ucyB0aGF0IHN0YW1wIGFuIGVwb2NoIGdldCAoYykg4oCUXG4gKiAgICAgIHNjcmlwdG9yaXVtLCBhc3Ryb2xhYmUgYW5kIG1pbmQtbWFwcGVyLiBHbGFtb3VyLCBpbWFnbywgbWFncGllIGFuZFxuICogICAgICBib3VudHkgc3RhbXAgbm9uZSAoc2Vzc2lvbi1zY29wZWQgbG9ncywgcnVsZWQgc28gaW4gRDM5L0I4OyBib3VudHknc1xuICogICAgICBzZXJ2ZXIgaGVhZGVyIG5hbWVzIHRoaXMgcmVzaWR1ZSksIHNvIGZvciB0aGVtIHRoZSBnYXAgc3RheXMgb3BlbiBvblxuICogICAgICB0aGUgZmFsbGJhY2sgcGF0aCwgKGEpIGNvdmVycyB0aGUgd2hvbGUtcmVwbGF5IGNhc2UgYW5kIChiKSB0aGVcbiAqICAgICAgY29tZS1iYWNrIHBhdGguIENsb3NpbmcgaXQgdGhlcmUgaXMgYSBkYWVtb24gY2hhbmdlOiBhbiBlcG9jaCBvblxuICogICAgICBgY3JlYXRlRXZlbnRMb2dgLiBFdmVyeSBzcGVsbCBwcmludHMgdGhlIG5ldCdzIHJlc2V0IGFzXG4gKiAgICAgIGBlcG9jaC5jaGFuZ2VkYCAoYFwiZXBvY2hcIjogXCJ1bmtub3duXCJgIHdoZXJlIHRoZXJlIGlzIG5vbmUpLlxuICogRDMgwrcgT05MWSBBIEZSQU1FIFdJVEggQSBMT0cgSUQgQ09VTlRTLiBHbGFtb3VyJ3MgYW5kIGltYWdvJ3MgdGFiIHBpbmdzXG4gKiAgICAgIChgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCkgY2Fycnkgbm8gaWQ6IG5vdCBvbiB0aGUgbG9nLCBzbyBhIGxhcHRvcFxuICogICAgICBsaWQgbm8gbG9uZ2VyIHdha2VzIGEgYC0tb25jZWAsIGFuZCBpbWFnbydzIGdyZXAgbm8gbG9uZ2VyIHNob3dzIGFcbiAqICAgICAgYHRhaWwud29rZWAgd2l0aCBub3RoaW5nIGFib3ZlIGl0LlxuICogRDQgwrcgQSBIVU1BTidTIFdBVENIIEhBUyBOTyBXSU5ET1cuIGBncmFwZXZpbmUgdGFpbCAtLWh1bWFuYCBwYXNzZXNcbiAqICAgICAgYHdpbmRvd01zOiAwYDsgbm8gb3RoZXIgc3BlbGwgaGFzIGEgaHVtYW4gbW9kZS4gRXZlcnkgYHRhaWxgJ3MgaGVscFxuICogICAgICBjYXJyaWVzIGBXSU5ET1dfSEVMUGAsIHdoaWNoIG5hbWVzIGBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MGAuXG4gKiBBbHNvOiBldmVyeSBjb21lLWJhY2sgY29tbWFuZCBjYXJyaWVzIGAtLW5vLW9wZW5gLCBzbyBydW5uaW5nIGl0IG9wZW5zIG5vXG4gKiBicm93c2VyIHRhYi5cbiAqXG4gKiDimqAgS05PV04gRURHRSwgTk9UIEZJWEVEIChmb3VuZCBieSB0aGUgcmUtcmV2aWV3KTogYSBrZXllZCBib3VudHkgRklSU1QgYXJtXG4gKiAgIChhbiBhbnRoaWxsIHNlYXQpIHdob3NlIHdpbmRvdyBlbmRzIGJlZm9yZSBpdHMgYm9hcmQgZXZlciBvcGVucyBwcmludHMgYVxuICogICByZS1hcm0gcGlubmVkIHRvIHRoZSBkZXJpdmVkIGlkIHdpdGggYW4gZW1wdHkgYm9va21hcmtcbiAqICAgKGAtLXNlc3Npb24gay3igKYgLS1zaW5jZT0tMSAtLW9uY2VgKS4gVGhhdCByZS1hcm0gaXMgYSByZS1hcm0gYnkgRDEncyBydWxlLFxuICogICBzbyBpZiB0aGUgYm9hcmQgaXMgc3RpbGwgbm90IHVwIOKAlCB0aGUgbGVhZCBtb3JlIHRoYW4gb25lIHdpbmRvdyAoMjkgbWluKVxuICogICBsYXRlIOKAlCB0aGUgc2VhdCBkb2VzIG5vdCB3YWl0LiBNaW5vcjogdGhlIG5leHQgc3RlcCBpdCBuYW1lc1xuICogICAoYG9wZW4gLS1zZXNzaW9uLWtleSBLYCkgaXMgdGhlIHJpZ2h0IG9uZSBhbnl3YXkuIFNpbmNlICM5OCAoMjAyNi0wOS0yNylcbiAqICAgaXQgbm8gbG9uZ2VyIHNheXMgYHRhaWwuY2xvc2VkYCBhYm91dCBhIGJvYXJkIHRoYXQgbmV2ZXIgb3BlbmVkOiBhIG5hbWVkXG4gKiAgIGAtLXNlc3Npb25gIHdpdGggbm8gc25hcHNob3Qgb24gZGlzayBleGl0cyBgbm90X2ZvdW5kYCBhZnRlciBhIGdyYWNlLlxuICpcbiAqIOKUgOKUgCBUSEUgQ09NTUFORCBOQU1FUyBOTyBQQVRIIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgbGluZSdzIGBjb21tYW5kYCBpcyB0aGUgVkVSQiBBTkQgSVRTIEFSR1VNRU5UUyBPTkxZXG4gKiAoYHRhaWwgLS1zZXNzaW9uIFggLS1zaW5jZSBOQEUgLS1vbmNlYCksIHBsdXMgYHNwZWxsYCwgYW5kIHRoZSBhZ2VudCBydW5zIGl0XG4gKiB3aXRoIElUUyBPV04gbGF1bmNoZXIsIGBidW4gPHRoaXMgc2tpbGwncyBkaXJlY3Rvcnk+L3NjcmlwdHMvY2xpLnRzYC4gSXQgdXNlZFxuICogdG8gYmUgcnVubmFibGUgYXMgcHJpbnRlZCwgaGVhZGVkIGJ5IGBidW4gPGFyZ3ZbMV0+YCDigJQgYW5kIGZvciBhbiBpbnN0YWxsZWRcbiAqIHBsdWdpbiBgYXJndlsxXWAgaXMgaW5zaWRlIGEgVkVSU0lPTkVEIGNhY2hlIGRpcmVjdG9yeS4gQW4gdXBncmFkZSBtYXJrcyB0aGVcbiAqIG9sZCBkaXJlY3Rvcnkgb3JwaGFuZWQgYW5kIGRlbGV0ZXMgaXQgbGF0ZXIgKG1lYXN1cmVkIGluXG4gKiBgZG9jcy9pdGVtcy90YWlsLXJlYXJtLWNvbW1hbmQtbmFtZXMtYS12ZXJzaW9uZWQtcGx1Z2luLXBhdGgubWRgKSxcbiAqIHNvIGEgbGluZSBwcmludGVkIGJlZm9yZSBhbiB1cGdyYWRlIGZpcnN0IHJhbiBTVEFMRSBjb2RlIGFnYWluc3QgYSBuZXdlclxuICogZGFlbW9uLCB0aGVuIGZhaWxlZCB3aXRoIFwibW9kdWxlIG5vdCBmb3VuZFwiIG9uY2UgdGhlIGRpcmVjdG9yeSB3YXMgZ29uZS4gTm9cbiAqIHN0YWJsZSBwYXRoIGV4aXN0cyB0byBwcmludCBpbnN0ZWFkOiB0aGUgY2FjaGUsIGAkQ0xBVURFX1BMVUdJTl9ST09UYCBhbmQgdGhlXG4gKiBpbnN0YWxsIHJlY29yZCBhcmUgYWxsIHZlcnNpb25lZC5cbiAqICAgVGhlIHNraWxsJ3MgbGF1bmNoZXIgaXMgYWx3YXlzIHRoZSB2ZXJzaW9uIHRoZSBzZXNzaW9uIGxvYWRlZC4gQ29sZSdzXG4gKiByZWFzb25pbmc6IHRoZSB3b3JzdCBjYXNlIGlzIHRoYXQgdGhlIENMSSBjaGFuZ2VkIGFuZCB0aGUgYWdlbnQgZ2V0cyBhblxuICogZXJyb3Ig4oCUIGFuZCBpZiB0aGUgdG9vbHMgYXJlIGRlc2lnbmVkIHJpZ2h0LCB0aGF0IGVycm9yIHNheXMgd2hhdCB3ZW50XG4gKiB3cm9uZy4gU28gdGhlIHBhcnNlcnMgYXJlIHRoZSBvdGhlciBoYWxmIG9mIHRoaXMgcnVsaW5nOiBgcmVhZFNpbmNlYCByZWZ1c2VzXG4gKiBhbnkgYC0tc2luY2VgIGZvcm0gYSB0YWlsIGRvZXMgbm90IGFjY2VwdCB3aXRoIGEgdXNhZ2UgZXJyb3IgTkFNSU5HIHRoZVxuICogZm9ybXMgaXQgZG9lcywgdGhlIHNhbWUgd2F5IG9uIGFsbCBlaWdodCB0YWlscywgaW5zdGVhZCBvZiBtaXNwYXJzaW5nIGl0LlxuICogICBOb3QgdGFrZW46IHByaW50aW5nIHRoZSBwYXRoIEFORCB0aGUgYXJncyAob3B0aW9uIEEgb2YgdGhlIGl0ZW0g4oCUIHR3b1xuICogY29tbWFuZHMgd2hlcmUgb25lIGlzIHdyb25nIGFmdGVyIGFuIHVwZ3JhZGUpOyBhIGxhdW5jaGVyIHRoYXQgbm90aWNlcyBpdCBpc1xuICogb3JwaGFuZWQgYW5kIHJlLWV4ZWNzIGEgbmV3ZXIgc2libGluZyAoQiDigJQgaXQgbGVhbnMgb24gYSBDbGF1ZGUgQ29kZVxuICogaW50ZXJuYWwgbWFya2VyIGFuZCBkb2VzIG5vdGhpbmcgb25jZSB0aGUgZGlyZWN0b3J5IGlzIGRlbGV0ZWQpOyB2ZXJzaW9uXG4gKiBuZWdvdGlhdGlvbi5cbiAqXG4gKiDilIDilIAgTUlORC1NQVBQRVIgSk9JTlMgVEhFIFNFU1NJT04gU1BFTExTIChDb2xlJ3MgcnVsaW5nLCAyMDI2LTA5LTI0KSDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBCdWlsdCBvbiBgZmVhdC9taW5kLW1hcHBlci1xdWlldC1oYW5kb2ZmYC4gSXQgUkVWRVJTRVMgdGhlIGltcGxlbWVudGVyJ3NcbiAqIHJ1bGluZyBvZiBgZmVhdC90YWlsLXF1aWV0LWhhbmRvZmZgIHRoYXQgbWluZC1tYXBwZXIgaXMgYSBwcmVzZW5jZSBzcGVsbFxuICogKGl0cyBkYWVtb24gY291bnRzIGFuIG9wZW4gU1NFIHRhaWwgYXMgdGhlIGFnZW50IHByZXNlbnQsIHNvIHRoZSB3aW5kb3dcbiAqIGFsd2F5cyByZS1hcm1lZCBNb25pdG9yKS4gQ29sZSdzIHJlYXNvbmluZzogbWluZC1tYXBwZXIgc2Vzc2lvbnMgYXJlIHVzZWRcbiAqIGxpa2Ugc2NyaXB0b3JpdW0ncywgYnVyc3RzIG9mIGFjdGl2aXR5IHdpdGggYnJlYWtzLCBhbmQgaW4gYSBicmVhayB0aGUgYWdlbnRcbiAqIHNob3VsZCBub3QgYmUgd29rZW4gZXZlcnkgMzAgbWludXRlcy4gU28gbWluZC1tYXBwZXIgdGFrZXMgdGhlIHF1aWV0IGhhbmRvZmZcbiAqIHRvIGAtLW9uY2VgLCB0aGUgbG9zdCBjb21lLWJhY2sgKGBvcGVuIC0tbm8tb3BlbmApLCBhbmQga2VlcHMgaXRzXG4gKiBgLS1zaW5jZSBOQGVwb2NoYCBib29rbWFyay4gVGhyZWUgdGhpbmdzIGhhZCB0byBiZSBzZXR0bGVkIHRvIG1ha2UgdGhhdFxuICogaG9uZXN0LCBlYWNoIHBpbm5lZCBpbiBgc3JjL21pbmQtbWFwcGVyL2JhY2tlbmQve3RhaWwscHJlc2VuY2V9LnRlc3QudHNgXG4gKiBhbmQgbXV0YXRpb24tY29uZmlybWVkOlxuICpcbiAqIE0xIMK3IFBSRVNFTkNFIExJTkdFUlMgQUNST1NTIFRIRSBHQVBTICh0aGUgZGFlbW9uLCBgc2VydmVyLnRzYFxuICogICAgICBgYWRqdXN0QWdlbnRzYCkuIEEgb25lLXNob3QgaG9sZHMgYW4gU1NFIGNvbm5lY3Rpb24sIHNvIGl0IENPVU5UUyBhc1xuICogICAgICBwcmVzZW50LCB3aGljaCBpcyB0cnVlOiB0aGUgYWdlbnQgd2lsbCB3YWtlIG9uIHRoZSBuZXh0IGV2ZW50LiBUaGUgZ2Fwc1xuICogICAgICBhcmUgdGhlIHByb2JsZW06IHdpbmRvdyDihpIgcmUtYXJtLCBxdWlldCDihpIgYC0tb25jZWAsIGFuZCBhYm92ZSBhbGxcbiAqICAgICAgYHRhaWwud29rZWAg4oaSIHRoZSBhZ2VudCBoYW5kbGVzIHRoZSBldmVudCDihpIgTW9uaXRvciwgd2hpY2ggbGFzdHMgdGhlXG4gKiAgICAgIGFnZW50J3Mgd2hvbGUgdHVybi4gUmF3LCB0aGUgc3VyZmFjZSdzIGhlYWRlciBkb3QgKHRoZSBvbmx5IHRoaW5nXG4gKiAgICAgIHByZXNlbmNlIGRyaXZlcyB0aGVyZSwgYmVzaWRlcyB0aGUgZGFlbW9uJ3MgYXV0by1gcmVjZWl2ZWRgIGZsaXAgb24gYVxuICogICAgICBodW1hbiBtZXNzYWdlKSByZWFkIFwiY29ubmVjdGVkIOKAlCBubyBhZ2VudCBvbiB0aGlzIHByb2plY3RcIiB3aGlsZSB0aGVcbiAqICAgICAgYWdlbnQgd2FzIHdvcmtpbmcgdGhlIGJvYXJkLCBhbmQgYSBtZXNzYWdlIHNlbnQgdGhlbiBnb3Qgbm9cbiAqICAgICAgYHJlY2VpdmVkYC4gVGhlIGRhZW1vbiBoYXMgbm8gaWRsZSBjbG9zZSwgc28gbm90aGluZyBlbHNlIHJlYWN0cy4gTm93XG4gKiAgICAgIHRoZSBjb3VudCBIT0xEUyBmb3IgYE1JTkRfTUFQUEVSX1BSRVNFTkNFX0xJTkdFUl9NU2AgKDE1MCBzLCB0aGUgc3RhbGxcbiAqICAgICAgd2luZG93J3MgYmVhdCkgYWZ0ZXIgdGhlIGxhc3QgdGFpbCBjbG9zZXM6IGEgdGFpbCBvcGVuaW5nIGluc2lkZSBpdFxuICogICAgICBlbWl0cyBub3RoaW5nLCBhbiBhZ2VudC1vbmx5IHdyaXRlIChgL2FjdGl2aXR5YCwgYW4gYWdlbnQgYC9zZW5kYClcbiAqICAgICAgcmVzdGFydHMgaXQsIGFuZCBzaWxlbmNlIHBhc3QgaXQgZHJvcHMgdGhlIGNvdW50IHRvIDAuXG4gKiAgICAgIOKaliBOb3QgdGFrZW46IHJlLWFybWluZyBNb25pdG9yIEJFRk9SRSBoYW5kbGluZyBhIHdva2VuIGV2ZW50ICh0aGF0IGlzXG4gKiAgICAgIHRoZSBzaGFyZWQgcnVsZSwgd29yZC1mb3Itd29yZCBpbiBldmVyeSBzcGVsbCk7IHJlZnJlc2hpbmcgb24gZXZlcnlcbiAqICAgICAgYm9hcmQgd3JpdGUgKHRoZSBicm93c2VyIFBPU1RzIHRoZSBzYW1lIHJvdXRlcywgc28gdGhlIGh1bWFuJ3Mgb3duXG4gKiAgICAgIGNsaWNrcyB3b3VsZCBrZWVwIHRoZSBkb3QgbGl0KS4gQ29zdDogYW4gYWdlbnQgdGhhdCByZWFsbHkgbGVmdCByZWFkc1xuICogICAgICBcImhlcmVcIiBmb3IgdXAgdG8gMTUwIHMuXG4gKiBNMiDCtyBgcHJlc2VuY2UuY2hhbmdlZGAgSVMgTk9UIENPVU5URUQgKG1pbmQtbWFwcGVyJ3MgYGNvdW50c2ApLiBJdCBpcyBPTlxuICogICAgICBUSEUgTE9HLCB3aXRoIGFuIGlkLCBhbmQgYSB0YWlsJ3Mgb3duIGNvbm5lY3QgZW1pdHMgb25lIG9udG8gaXRzIG93blxuICogICAgICBzdHJlYW0sIHNvIGNvdW50ZWQgaXQgbWFkZSBldmVyeSB3aW5kb3cgXCJhY3RpdmVcIiBhbmQgd291bGQgd2FrZSBldmVyeVxuICogICAgICBgLS1vbmNlYCBvbiBpdHNlbGYuIFRoZSBsaW5nZXIgcmVtb3ZlcyBtb3N0IG9mIHRoYXQgY2h1cm47IGBjb3VudHNgXG4gKiAgICAgIHJlbW92ZXMgdGhlIHJlc3QgKGEgZmlyc3QgYXJtLCBhbm90aGVyIGFnZW50IGNvbWluZyBvciBnb2luZykuXG4gKiBNMyDCtyBBIERFQUQgREFFTU9OIElTIExPU1QsIE5PVCBVTlJFU09MVkVEIChtaW5kLW1hcHBlcidzIGByZXNvbHZlYCkuIEl0c1xuICogICAgICBkaXNjb3ZlcnkgcHJvYmVzIHRoZSBkYWVtb24ncyBwaWQsIHNvIGEga2lsbGVkIGRhZW1vbiBtYWRlIGByZXNvbHZlYFxuICogICAgICBhbnN3ZXIgbnVsbCBhbmQgYW4gdW5yZXNvbHZlZCB0YWlsIHJldHJpZXMgZm9yZXZlcjogYSBgLS1vbmNlYCB3b3VsZFxuICogICAgICBoYXZlIHNsZXB0IGZvciBnb29kIChEMSdzIGRlZmVjdCkuIFRoZSB0YWlsIGtlZXBzIHRoZSBsYXN0IFVSTCBpdFxuICogICAgICByZXNvbHZlZCwgc28gdGhlIGRlYWQgcG9ydCByZWZ1c2VzIGFuZCBgTE9TVF9BRlRFUl9SRUZVU0FMU2AgZW5kcyBpdFxuICogICAgICB3aXRoIGB0YWlsLmxvc3RgIOKGkiBgb3BlbiAtLW5vLW9wZW5gLCB0aGVuIGEgdGFpbCB3aXRoIG5vIGAtLXNpbmNlYC5cbiAqICAgICAgTWluZC1tYXBwZXIgaGFzIG5vIHNlc3Npb24gdG8gY2xvc2UsIHNvIGl0IG5ldmVyIHByaW50cyBgdGFpbC5jbG9zZWRgLlxuICogICAgICBNZWFzdXJlZCBvbiBhIHJlYWwgYGtpbGwgLTlgIHVuZGVyIGEgYC0tb25jZWA6IGB0YWlsLmxvc3RgIDcgcyBsYXRlcixcbiAqICAgICAgbm90IDAuNzUgcywgYmVjYXVzZSBtaW5kLW1hcHBlcidzIG93biBiYWNrb2ZmIHN0YXJ0cyBhdCAxIHMgKDEgKyAyICsgNCkuXG4gKiAgICAgIE0x4oCTTTMgd2VyZSBkcml2ZW4gb24gYSByZWFsIGRhZW1vbiB3aXRoIGEgNCBzIHdpbmRvdzogYWN0aXZlIOKGkiB3aW5kb3csXG4gKiAgICAgIHF1aWV0IOKGkiBgLS1vbmNlYCwgYSBodW1hbiBtZXNzYWdlIHdva2UgaXQsIGJhY2sgdG8gTW9uaXRvcjsgcHJlc2VuY2VcbiAqICAgICAgbmV2ZXIgZHJvcHBlZCBhY3Jvc3MgdGhlIGdhcHMuXG4gKlxuICog4pqWIGAtLW9uY2VgIEVORFMgT04gVEhFIEZJUlNUIEZSQU1FLCB3aXRoIG5vIGRyYWluLiBBIGJ1cnN0IGFycml2ZXMgc3BsaXQ6IHRoZVxuICogICBmaXJzdCBldmVudCBvbiB0aGUgb25lLXNob3QsIHRoZSByZXN0IG9uIHRoZSBNb25pdG9yIHJlLWFybSwgd2hpY2ggbG9zZXNcbiAqICAgbm90aGluZyBiZWNhdXNlIG9mIHRoZSBib29rbWFyay4gVGhlIHNwaWtlIG9mZmVyZWQgYSB+MjAwIG1zIGRyYWluIGFzIGFuXG4gKiAgIG9wdGlvbiwgbm90IGEgcmVxdWlyZW1lbnQ7IG5vdCB0YWtlbiwgYmVjYXVzZSBpdCBhZGRzIGEgdGltZXIgdG8gdGhlXG4gKiAgIGV4aXQgcGF0aCB3aG9zZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byBtYWtlIGltcG9zc2libGUuXG4gKiDimpYgVEhFIExJTkUnUyBgY29tbWFuZGAgSVMgQ09NUExFVEUgQlVUIEZPUiBUSEUgTEFVTkNIRVI6IHBpbm5lZCB0byB0aGVcbiAqICAgc2Vzc2lvbiB0aGlzIHRhaWwgd2FzIGJvdW5kIHRvLCB3aXRoIGl0cyBzY29wZSBmbGFncy4gVGhlIHNraWxscyBuYW1lIHRoZVxuICogICBydWxlIG9uY2UsIGxhdW5jaGVyIGZvcm0gaW5jbHVkZWQ7IHRoZSBsaW5lIGNhcnJpZXMgdGhlIHNwZWNpZmljcy5cbiAqXG4gKiBTMSDCtyBXSE8gQ0xPU0VEIElUIFJJREVTIFRIRSBMSU5FIChzY3JpcHRvcml1bSdzIEVuZCBzZXNzaW9uLCAyMDI2LTEwLTAxKS5cbiAqICAgICAgQSBzcGVsbCB3aG9zZSBgY2xvc2VkYCBmcmFtZSBzYXlzIHdobyBlbmRlZCB0aGUgc2Vzc2lvbiBwYXNzZXNcbiAqICAgICAgYGNsb3NlZEJ5YCwgYW5kIGB0YWlsLmNsb3NlZGAgY2FycmllcyBpdCBhcyBgYnlgLiBgYnk6IFwiaHVtYW5cImAgY2hhbmdlc1xuICogICAgICB0aGUgaGludDogdGhlIGh1bWFuIGVuZGVkIGl0IE9OIFBVUlBPU0UsIHNvIHRoZSBhZ2VudCBzdG9wcyBhbmQgZG9lcyBub3RcbiAqICAgICAgcmVvcGVuIHVubGVzcyBhc2tlZCDigJQgdGhlIHdheSBiYWNrIGlzIHN0aWxsIG5hbWVkLCBjb25kaXRpb25lZCBvbiB0aGF0LlxuICogICAgICBUaGUgYWdlbnQgcm91dGVzIG9uIGBieWAsIG5ldmVyIG9uIHRoZSBoaW50J3MgcHJvc2UuIEEgcmUtYXJtIGFmdGVyXG4gKiAgICAgIHRoZSBlbmQgc2VlcyBubyBjbG9zaW5nIGZyYW1lIChEMSdzIHBhdGgpLCBzbyB0aGUgc3BlbGwgYWxzbyBwYXNzZXNcbiAqICAgICAgYGdvbmVCeWAsIHJlYWQgZnJvbSB3aGVyZSB0aGUgZmFjdCBvdXRsaXZlcyB0aGUgZGFlbW9uOyB3aXRob3V0IGl0IHRoZVxuICogICAgICByZS1hcm1lZCBsaW5lIGRyb3BwZWQgYGJ5YCBhbmQgaW52aXRlZCB0aGUgcmVvcGVuICh2ZXJpZmllciwgMjAyNi0xMC0wMSkuXG4gKiAgICAgIOKaliBPcHRpb25zIG5vdCB0YWtlbjogYSBzcGVsbC1zaWRlIHJld3JpdGUgb2YgdGhlIHByaW50ZWQgbGluZSAoYSBzZWNvbmRcbiAqICAgICAgd3JpdGVyIG9mIHRoZSBzYW1lIGxpbmUpLCBvciBhIHNwZWxsLXN1cHBsaWVkIGhpbnQgKGVhY2ggc3BlbGwgd291bGRcbiAqICAgICAgd29yZCBcIm9uIHB1cnBvc2VcIiBpdHMgb3duIHdheSkuXG4gKi9cbmltcG9ydCB7IHR5cGUgU3NlRnJhbWUsIHR5cGUgVGFpbE9wdGlvbnMsIHRhaWxFdmVudHMgfSBmcm9tIFwiLi90YWlsRXZlbnRzXCI7XG5cbi8qKiBDbGF1ZGUgQ29kZSdzIE1vbml0b3IgY2FwLCBwZXIgdGhlIHRvb2wncyBzY2hlbWEgKFwiRGVhZGxpbmVzIGFib3ZlXG4gKiAgMTgwMDAwMG1zIGFyZSBjYXBwZWQgdG8gMTgwMDAwMG1zXCIpLiBBIGhhcm5lc3MgbnVtYmVyOiBpZiBpdCBjaGFuZ2VzLCB0aGlzXG4gKiAgY2hhbmdlcywgYW5kIHNvIGRvZXMgdGhlIHNraWxscycgYHRpbWVvdXRfbXNgLiAqL1xuZXhwb3J0IGNvbnN0IE1PTklUT1JfQ0FQX01TID0gMV84MDBfMDAwO1xuLyoqIFNlZSBBNCBpbiB0aGUgaGVhZGVyIGZvciB3aHkgYSBtaW51dGUuICovXG5leHBvcnQgY29uc3QgV0lORE9XX01BUkdJTl9NUyA9IDYwXzAwMDtcbmV4cG9ydCBjb25zdCBERUZBVUxUX1dJTkRPV19NUyA9IE1PTklUT1JfQ0FQX01TIC0gV0lORE9XX01BUkdJTl9NUztcbi8qKiBUaGUgaW5qZWN0aW9uIHBvaW50IGZvciB0ZXN0cyBhbmQgdmVyaWZpY2F0aW9uIChzZWUgQTQpLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19FTlYgPSBcIlNQRUxMQk9PS19UQUlMX1dJTkRPV19NU1wiO1xuLyoqIFRoZSBvbmUgc2VudGVuY2UgZXZlcnkgYHRhaWxgJ3MgaGVscCBjYXJyaWVzLCBzbyBhIGh1bWFuIHdhdGNoaW5nIGluIGFcbiAqICB0ZXJtaW5hbCBmaW5kcyB0aGUgZXNjYXBlIGhhdGNoIHdoZXJlIHRoZXkgbG9vayAoRDQpLiBXb3JkZWQgb25jZSBoZXJlLiAqL1xuZXhwb3J0IGNvbnN0IFdJTkRPV19IRUxQID1cbiAgXCJlbmRzIGl0c2VsZiBiZWZvcmUgTW9uaXRvcidzIDMwLW1pbnV0ZSBjYXAgd2l0aCBhIGxpbmUgbmFtaW5nIHRoZSBuZXh0IGFjdDsgYSBodW1hbiB3YXRjaGluZyBhIHRlcm1pbmFsIGtlZXBzIGl0IG9wZW4gd2l0aCBTUEVMTEJPT0tfVEFJTF9XSU5ET1dfTVM9MFwiO1xuXG4vKiogQ29ubmVjdGlvbiByZWZ1c2FscyBpbiBhIHJvdyB0aGF0IG1ha2UgdGhlIGRhZW1vbiBcImxvc3RcIiAoc2VlIEEyKS4gVGhyZWVcbiAqICBzcGFuIGFib3V0IDAuNzUgcyB1bmRlciB0aGUga2l0J3MgZGVmYXVsdCBiYWNrb2ZmICgyNTAgKyA1MDAgbXMgYmV0d2VlblxuICogIHRoZW0pOiBhIGxpdmUgZGFlbW9uIG5ldmVyIHJlZnVzZXMgaXRzIG93biBwb3J0LCBhbmQgdGhlIHR3byBleHRyYSBhdHRlbXB0c1xuICogIG9ubHkgYnV5IHRvbGVyYW5jZSBmb3IgYSByZXN0YXJ0IHRoYXQgcmViaW5kcyB0aGUgc2FtZSBwb3J0LiAqL1xuZXhwb3J0IGNvbnN0IExPU1RfQUZURVJfUkVGVVNBTFMgPSAzO1xuXG4vKiogVGhlIHdpbmRvdyBsZW5ndGg6IHRoZSBlbnYgdmFsdWUgd2hlbiBpdCBpcyBhIG5vbi1uZWdhdGl2ZSBpbnRlZ2VyLCBlbHNlIHRoZVxuICogIGRlZmF1bHQuIGAwYCBtZWFucyBubyB3aW5kb3cuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVdpbmRvd01zKHJhdzogc3RyaW5nIHwgdW5kZWZpbmVkKTogbnVtYmVyIHtcbiAgaWYgKHJhdyA9PT0gdW5kZWZpbmVkIHx8IHJhdy50cmltKCkgPT09IFwiXCIpIHJldHVybiBERUZBVUxUX1dJTkRPV19NUztcbiAgY29uc3QgbiA9IE51bWJlcihyYXcpO1xuICByZXR1cm4gTnVtYmVyLmlzSW50ZWdlcihuKSAmJiBuID49IDAgPyBuIDogREVGQVVMVF9XSU5ET1dfTVM7XG59XG5cbmV4cG9ydCB0eXBlIFRhaWxNb2RlID0gXCJ3YXRjaFwiIHwgXCJvbmNlXCI7XG5cbi8qKiBIb3cgYSB0YWlsIGVuZGVkLiBgd2luZG93YCBpcyBvdXIgb3duIGRlYWRsaW5lLCBgZXZlbnRgIGlzIGEgYC0tb25jZWAnc1xuICogIGZpcnN0IGZyYW1lLCBgY2xvc2VkYCBpcyB0aGUgc2Vzc2lvbiBlbmRpbmcgKGEgYGNsb3NlZGAgZnJhbWUgb3IgdGhlIHBpbm5lZFxuICogIHNlc3Npb24ncyBwb2ludGVyIHZhbmlzaGluZyksIGBsb3N0YCBpcyB0aGUgZGFlbW9uIHJlZnVzaW5nIGNvbm5lY3Rpb25zLFxuICogIGFuZCBgc3RvcHBlZGAgaXMgYSBzaWduYWwsIGEgY2FsbGVyJ3MgYWJvcnQgb3IgYSBjbG9zZWQgc3Rkb3V0LiAqL1xuZXhwb3J0IHR5cGUgVGFpbEVuZCA9IFwid2luZG93XCIgfCBcImV2ZW50XCIgfCBcImNsb3NlZFwiIHwgXCJsb3N0XCIgfCBcInN0b3BwZWRcIjtcblxuZXhwb3J0IHR5cGUgSGFuZG9mZklucHV0ID0ge1xuICAvKiogVGhlIHNwZWxsIHdob3NlIHRhaWwgdGhpcyBpcywgc28gdGhlIGFnZW50IGtub3dzIHdob3NlIGxhdW5jaGVyIHJ1bnMgaXQuICovXG4gIHNwZWxsOiBzdHJpbmc7XG4gIGVuZDogVGFpbEVuZDtcbiAgLyoqIFdobyBlbmRlZCBhIGBjbG9zZWRgIHNlc3Npb24sIHdoZW4gaXRzIGNsb3NpbmcgZnJhbWUgc2FpZCAoUzEpLiAqL1xuICBieT86IHN0cmluZztcbiAgbW9kZTogVGFpbE1vZGU7XG4gIC8qKiBMb2cgZnJhbWVzIHRoaXMgcHJvY2VzcyB3cm90ZSB0byBzdGRvdXQgKEEzKS4gKi9cbiAgZXZlbnRzOiBudW1iZXI7XG4gIC8qKiBUaGUgYm9va21hcms6IHRoZSBoaWdoZXN0IGlkIHRoaXMgcHJvY2VzcyBoYXMgc2Vlbi4gKi9cbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBUaGUgbG9nIHRoZSBib29rbWFyayBiZWxvbmdzIHRvLCB3aGVuIHRoZSBkYWVtb24gc3RhbXBzIGFuIGVwb2NoLiAqL1xuICBlcG9jaD86IHN0cmluZztcbiAgcHJlc2VuY2U6IGJvb2xlYW47XG59O1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmQ29tbWFuZHMgPSB7XG4gIC8qKiBUaGUgcmUtYXJtLCB3aXRoIHRoZSBib29rbWFyazsgYG9uY2VgIGFkZHMgYC0tb25jZWAuIGBlcG9jaGAgaXMgdGhlXG4gICAqICBsb2cgdGhlIGJvb2ttYXJrIGJlbG9uZ3MgdG8sIHdoZW4gdGhlIGRhZW1vbiBzdGFtcHMgb25lOiBhIHNwZWxsIHdob3NlXG4gICAqICBgLS1zaW5jZWAgcGFyc2VzIGBOQDxlcG9jaD5gIChgcGFyc2VCb29rbWFya2ApIHByaW50cyBpdC4gKi9cbiAgdGFpbDogKG86IHsgc2luY2U6IG51bWJlcjsgb25jZTogYm9vbGVhbjsgZXBvY2g/OiBzdHJpbmcgfSkgPT4gc3RyaW5nO1xuICAvKiogSG93IHRvIGNvbWUgYmFjayBmcm9tIGEgc2Vzc2lvbiB0aGF0IGlzIGdvbmUuICovXG4gIGNvbWVCYWNrOiAoKSA9PiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBIYW5kb2ZmTGluZSA9IHtcbiAgdHlwZTogXCJ0YWlsLndpbmRvd1wiIHwgXCJ0YWlsLnF1aWV0XCIgfCBcInRhaWwud29rZVwiIHwgXCJ0YWlsLmNsb3NlZFwiIHwgXCJ0YWlsLmxvc3RcIjtcbiAgLyoqIFdob3NlIGxhdW5jaGVyIHJ1bnMgYGNvbW1hbmRgLiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBldmVudHM6IG51bWJlcjtcbiAgY3Vyc29yOiBudW1iZXI7XG4gIC8qKiBgdGFpbC5jbG9zZWRgIG9ubHk6IHdobyBlbmRlZCB0aGUgc2Vzc2lvbiwgd2hlbiB0aGUgc3BlbGwgc2F5cyAoUzEpLiAqL1xuICBieT86IHN0cmluZztcbiAgLyoqIGBtb25pdG9yYDogYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgd2l0aCB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAuXG4gICAqICBgYmFja2dyb3VuZGA6IHJ1biB0aGUgbGF1bmNoZXIgKyBgY29tbWFuZGAgYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzay5cbiAgICogIGBzdG9wYDogbm90aGluZyB0byB3YXRjaDsgYGNvbW1hbmRgIGlzIGhvdyB0byBjb21lIGJhY2ssIGlmIHdhbnRlZC4gKi9cbiAgbmV4dDogXCJtb25pdG9yXCIgfCBcImJhY2tncm91bmRcIiB8IFwic3RvcFwiO1xuICAvKiogVGhlIHZlcmIgYW5kIGl0cyBhcmd1bWVudHMgT05MWSDigJQgbm8gbGF1bmNoZXIsIG5vIHBhdGguIFRoZSBhZ2VudCBydW5zXG4gICAqICBgYnVuIDx0aGlzIHNraWxsJ3MgZGlyZWN0b3J5Pi9zY3JpcHRzL2NsaS50cyA8Y29tbWFuZD5gLiAqL1xuICBjb21tYW5kOiBzdHJpbmc7XG4gIGhpbnQ6IHN0cmluZztcbn07XG5cbi8qKiBIb3cgdGhlIGFnZW50IHJ1bnMgYSBwcmludGVkIGBjb21tYW5kYDogd2l0aCBJVFMgT1dOIGxhdW5jaGVyLCBuZXZlciBhIHBhdGhcbiAqICB0aGlzIHByb2Nlc3MgbmFtZXMgKHRoZSBydWxpbmcgb24gdGhlIHZlcnNpb25lZCBwbHVnaW4gcGF0aCwgaW4gdGhlIGhlYWRlcikuICovXG5leHBvcnQgY29uc3QgUlVOX1dJVEhfTEFVTkNIRVIgPSBcImJ1biA8dGhpcyBza2lsbCdzIGRpcmVjdG9yeT4vc2NyaXB0cy9jbGkudHMgPGNvbW1hbmQ+XCI7XG5cbi8qKiBUaGUgY29tZS1iYWNrIGhpbnQsIHdpdGggaG93IHRvIFJFU1VNRSBhZnRlciBjb21pbmcgYmFjayAoRDIpOiBhIHJlc3RvcmVkXG4gKiAgZGFlbW9uIHN0YXJ0cyBhIG5ldyBsb2csIHNvIHRoZSBvbGQgYm9va21hcmsgbWVhbnMgbm90aGluZyB0aGVyZS4gKi9cbmNvbnN0IENPTUVfQkFDSyA9ICh3aHk6IHN0cmluZywgbGVhZCA9IFwiVG8gYnJpbmcgaXQgYmFja1wiKSA9PlxuICBgJHt3aHl9ICR7bGVhZH0sIHJ1biAke1JVTl9XSVRIX0xBVU5DSEVSfTsgdGhlbiBhcm0gdGhlIHRhaWwgYWdhaW4gd2l0aCBubyAtLXNpbmNlLCBvbiB0aGUgc2Vzc2lvbiBpZCBpdCBwcmludHMgd2hlcmUgdGhlcmUgaXMgb25lIChhIHJlc3RhcnRlZCBkYWVtb24gc3RhcnRzIGEgbmV3IGV2ZW50IGxvZywgc28gdGhlIG9sZCBib29rbWFyayBkb2VzIG5vdCBhcHBseSlgO1xuXG4vKipcbiAqIFRIRSBERUNJU0lPTjogZ2l2ZW4gaG93IHRoZSB0YWlsIGVuZGVkLCB3aGljaCBsaW5lIGl0IHByaW50cy4gUHVyZSwgc28gZXZlcnlcbiAqIHN0YXRlIGlzIGEgbGl0ZXJhbCBjZWxsIGluIGB0YWlsSGFuZG9mZi50ZXN0LnRzYC4gUmV0dXJucyBudWxsIGZvciBgc3RvcHBlZGA6XG4gKiBhIGh1bWFuJ3MgQ3RybC1DIG9yIGEgY2FsbGVyJ3MgYWJvcnQgaXMgbm90IGEgaGFuZG9mZi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhbmRvZmYoczogSGFuZG9mZklucHV0LCBjbWQ6IEhhbmRvZmZDb21tYW5kcyk6IEhhbmRvZmZMaW5lIHwgbnVsbCB7XG4gIGNvbnN0IGJhc2UgPSB7IHNwZWxsOiBzLnNwZWxsLCBldmVudHM6IHMuZXZlbnRzLCBjdXJzb3I6IHMuY3Vyc29yIH07XG4gIHN3aXRjaCAocy5lbmQpIHtcbiAgICBjYXNlIFwic3RvcHBlZFwiOlxuICAgICAgcmV0dXJuIG51bGw7XG4gICAgY2FzZSBcImNsb3NlZFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmNsb3NlZFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICAuLi4ocy5ieSA/IHsgYnk6IHMuYnkgfSA6IHt9KSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OlxuICAgICAgICAgIHMuYnkgPT09IFwiaHVtYW5cIlxuICAgICAgICAgICAgPyBDT01FX0JBQ0soXG4gICAgICAgICAgICAgICAgXCJ0aGUgaHVtYW4gZW5kZWQgdGhpcyBzZXNzaW9uIG9uIHB1cnBvc2U7IHN0b3Agd2F0Y2hpbmcsIGFuZCBkbyBub3QgcmVvcGVuIGl0IHVubGVzcyB0aGV5IGFzay5cIixcbiAgICAgICAgICAgICAgICBcIklmIHRoZXkgYXNrXCIsXG4gICAgICAgICAgICAgIClcbiAgICAgICAgICAgIDogQ09NRV9CQUNLKFwidGhlIHNlc3Npb24gY2xvc2VkOyB0aGVyZSBpcyBub3RoaW5nIGxlZnQgdG8gd2F0Y2guXCIpLFxuICAgICAgfTtcbiAgICBjYXNlIFwibG9zdFwiOlxuICAgICAgcmV0dXJuIHtcbiAgICAgICAgdHlwZTogXCJ0YWlsLmxvc3RcIixcbiAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgbmV4dDogXCJzdG9wXCIsXG4gICAgICAgIGNvbW1hbmQ6IGNtZC5jb21lQmFjaygpLFxuICAgICAgICBoaW50OiBDT01FX0JBQ0soXCJsb3N0IHRoZSBkYWVtb24gKGl0IGNyYXNoZWQgb3Igd2FzIGtpbGxlZCk7IG5vdGhpbmcgaXMgbGlzdGVuaW5nLlwiKSxcbiAgICAgIH07XG4gICAgY2FzZSBcImV2ZW50XCI6XG4gICAgICByZXR1cm4ge1xuICAgICAgICB0eXBlOiBcInRhaWwud29rZVwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IGZhbHNlLCAuLi4ocy5lcG9jaCA/IHsgZXBvY2g6IHMuZXBvY2ggfSA6IHt9KSB9KSxcbiAgICAgICAgaGludDogYGhhbmRsZSB0aGUgZXZlbnQgYWJvdmUsIHRoZW4gYXJtIE1vbml0b3IgKHRpbWVvdXRfbXMgMTgwMDAwMCkgcnVubmluZyAke1JVTl9XSVRIX0xBVU5DSEVSfWAsXG4gICAgICB9O1xuICAgIGNhc2UgXCJ3aW5kb3dcIjpcbiAgICAgIGlmIChzLnByZXNlbmNlIHx8IHMuZXZlbnRzID4gMClcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICB0eXBlOiBcInRhaWwud2luZG93XCIsXG4gICAgICAgICAgLi4uYmFzZSxcbiAgICAgICAgICBuZXh0OiBcIm1vbml0b3JcIixcbiAgICAgICAgICBjb21tYW5kOiBjbWQudGFpbCh7XG4gICAgICAgICAgICBzaW5jZTogcy5jdXJzb3IsXG4gICAgICAgICAgICBvbmNlOiBmYWxzZSxcbiAgICAgICAgICAgIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pLFxuICAgICAgICAgIH0pLFxuICAgICAgICAgIGhpbnQ6IGB0aGUgd2luZG93IGVuZGVkIGJlZm9yZSBNb25pdG9yJ3MgY2FwOyBhcm0gTW9uaXRvciAodGltZW91dF9tcyAxODAwMDAwKSBydW5uaW5nICR7UlVOX1dJVEhfTEFVTkNIRVJ9YCxcbiAgICAgICAgfTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHR5cGU6IFwidGFpbC5xdWlldFwiLFxuICAgICAgICAuLi5iYXNlLFxuICAgICAgICBuZXh0OiBcImJhY2tncm91bmRcIixcbiAgICAgICAgY29tbWFuZDogY21kLnRhaWwoeyBzaW5jZTogcy5jdXJzb3IsIG9uY2U6IHRydWUsIC4uLihzLmVwb2NoID8geyBlcG9jaDogcy5lcG9jaCB9IDoge30pIH0pLFxuICAgICAgICBoaW50OiBgbm90aGluZyBvbiB0aGUgbG9nIHRoaXMgd2luZG93OyBydW4gJHtSVU5fV0lUSF9MQVVOQ0hFUn0gYXMgYSBiYWNrZ3JvdW5kIEJhc2ggdGFzayAocnVuX2luX2JhY2tncm91bmQpIOKAlCBpdCBleGl0cyBvbiB0aGUgbmV4dCBldmVudGAsXG4gICAgICB9O1xuICB9XG59XG5cbi8qKiBQT1NJWCBzaW5nbGUtcXVvdGUgYW4gYXJndW1lbnQgd2hlbiBpdCBuZWVkcyBpdCwgc28gYSBwcmludGVkIGBjb21tYW5kYFxuICogIHJ1bnMgYXMgcHJpbnRlZCBhZnRlciB0aGUgYWdlbnQncyBvd24gbGF1bmNoZXIuICovXG5leHBvcnQgZnVuY3Rpb24gc2hlbGxRdW90ZShhcmc6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAvXltBLVphLXowLTlfQCUrPTosLi8tXSskLy50ZXN0KGFyZykgPyBhcmcgOiBgJyR7YXJnLnJlcGxhY2VBbGwoXCInXCIsIGAnXFxcXCcnYCl9J2A7XG59XG5cbi8qKlxuICogUmVhZCBhIGAtLXNpbmNlYCB2YWx1ZTogYW4gZXZlbnQgaWQsIG9wdGlvbmFsbHkgY2FycnlpbmcgdGhlIGVwb2NoIG9mIHRoZVxuICogbG9nIGl0IGNhbWUgZnJvbSAoYDEyQDxlcG9jaD5gLCBEMikuIE51bGwgd2hlbiB0aGUgaWQgaXMgbm90IGFuIGludGVnZXIuXG4gKiBGb3IgdGhlIHNwZWxscyB3aG9zZSBkYWVtb24gc3RhbXBzIGFuIGVwb2NoOyB0aGUgcmVzdCB0YWtlIGEgcGxhaW4gaWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJvb2ttYXJrKHRva2VuOiBzdHJpbmcpOiB7IHNpbmNlOiBudW1iZXI7IGVwb2NoPzogc3RyaW5nIH0gfCBudWxsIHtcbiAgY29uc3QgYXQgPSB0b2tlbi5pbmRleE9mKFwiQFwiKTtcbiAgY29uc3QgaWQgPSBhdCA9PT0gLTEgPyB0b2tlbiA6IHRva2VuLnNsaWNlKDAsIGF0KTtcbiAgY29uc3QgZXBvY2ggPSBhdCA9PT0gLTEgPyBcIlwiIDogdG9rZW4uc2xpY2UoYXQgKyAxKTtcbiAgaWYgKCEvXi0/XFxkKyQvLnRlc3QoaWQudHJpbSgpKSkgcmV0dXJuIG51bGw7XG4gIGlmIChhdCAhPT0gLTEgJiYgZXBvY2ggPT09IFwiXCIpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBzaW5jZTogTnVtYmVyLnBhcnNlSW50KGlkLCAxMCksIC4uLihlcG9jaCA/IHsgZXBvY2ggfSA6IHt9KSB9O1xufVxuXG4vKipcbiAqIEV2ZXJ5IHRhaWwncyBgLS1zaW5jZWAsIHJlYWQgdGhlIHNhbWUgd2F5OiBhIGJvb2ttYXJrIHRoaXMgdGFpbCBhY2NlcHRzLCBvciBhXG4gKiByZWZ1c2FsIHRoYXQgTkFNRVMgdGhlIGFjY2VwdGVkIGZvcm1zLiDim5QgTkVWRVIgQSBTSUxFTlQgTUlTUEFSU0UuIFRoZSBmb3VyXG4gKiBuby1lcG9jaCBzcGVsbHMgdXNlZCBgcGFyc2VJbnRgLCB3aGljaCByZWFkIGFuIGVwb2NoIGJvb2ttYXJrIChgNEBlMWAsIGZyb21cbiAqIGEgaGFuZG9mZiBsaW5lIGFub3RoZXIgdmVyc2lvbiBvciBzcGVsbCBwcmludGVkKSBhcyBgNGAgYW5kIGRyb3BwZWQgdGhlXG4gKiByZXN0IHdpdGhvdXQgYSB3b3JkOyBtaW5kLW1hcHBlciByZWFkIGp1bmsgYXMgMCBhbmQgYXN0cm9sYWJlIGFzIC0xLCBib3RoIGFcbiAqIHdob2xlIHJlcGxheS4gQSBwcmludGVkIGNvbW1hbmQgb3V0bGl2ZXMgdGhlIENMSSB0aGF0IHByaW50ZWQgaXQgKHRoZVxuICogbGF1bmNoZXItZnJlZSBydWxpbmcsIGluIHRoZSBoZWFkZXIpLCBzbyB0aGUgcGFyc2VyIGlzIHdoZXJlIGFuIG9sZGVyIG9yXG4gKiBuZXdlciBmb3JtIG11c3Qgc2F5IHdoYXQgd2VudCB3cm9uZy5cbiAqXG4gKiBgZXBvY2hgOiB3aGV0aGVyIHRoaXMgc3BlbGwncyBsb2cgc3RhbXBzIG9uZSAoc2NyaXB0b3JpdW0sIGFzdHJvbGFiZSxcbiAqIG1pbmQtbWFwcGVyKS4gYG1pbmA6IHRoZSBzbWFsbGVzdCBpZCBhY2NlcHRlZCAoZ3JhcGV2aW5lIHRha2VzIG5vIC0xKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRTaW5jZShcbiAgdG9rZW46IHN0cmluZyxcbiAgbzogeyBlcG9jaDogYm9vbGVhbjsgbWluPzogbnVtYmVyIH0sXG4pOiB7IG9rOiB0cnVlOyBzaW5jZTogbnVtYmVyOyBlcG9jaD86IHN0cmluZyB9IHwgeyBvazogZmFsc2U7IG1lc3NhZ2U6IHN0cmluZyB9IHtcbiAgY29uc3QgbWluID0gby5taW4gPz8gLTE7XG4gIGNvbnN0IGIgPSBwYXJzZUJvb2ttYXJrKHRva2VuKTtcbiAgaWYgKGIgIT09IG51bGwgJiYgYi5zaW5jZSA+PSBtaW4gJiYgKGIuZXBvY2ggPT09IHVuZGVmaW5lZCB8fCBvLmVwb2NoKSlcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgc2luY2U6IGIuc2luY2UsIC4uLihiLmVwb2NoID8geyBlcG9jaDogYi5lcG9jaCB9IDoge30pIH07XG4gIGNvbnN0IGlkID1cbiAgICBtaW4gPCAwXG4gICAgICA/IFwiYW4gZXZlbnQgaWQgKGFuIGludGVnZXI7IC0tc2luY2U9LTEgZm9yIGV2ZXJ5dGhpbmcpXCJcbiAgICAgIDogYGFuIGV2ZW50IGlkIChhbiBpbnRlZ2VyLCAke21pbn0gb3IgbW9yZSlgO1xuICBjb25zdCBmb3JtcyA9IG8uZXBvY2ggPyBgJHtpZH0sIG9yIDxpZD5APGVwb2NoPiBhcyBhIGhhbmRvZmYgbGluZSBwcmludHMgaXRgIDogaWQ7XG4gIGNvbnN0IHdoeSA9XG4gICAgIW8uZXBvY2ggJiYgdG9rZW4uaW5jbHVkZXMoXCJAXCIpXG4gICAgICA/IGA7IHRoaXMgc3BlbGwncyBsb2cgc3RhbXBzIG5vIGVwb2NoLCBzbyBwYXNzIHRoZSBpZCB3aXRob3V0IHRoZSBcIkDigKZcIiBwYXJ0YFxuICAgICAgOiBcIlwiO1xuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBtZXNzYWdlOiBgLS1zaW5jZTogXCIke3Rva2VufVwiIGlzIG5vdCBhIGJvb2ttYXJrIHRoaXMgdGFpbCBhY2NlcHRzIOKAlCBnaXZlICR7Zm9ybXN9JHt3aHl9YCxcbiAgfTtcbn1cblxuLyoqIEpvaW4gYW4gYXJndiBpbnRvIG9uZSBydW5uYWJsZSBjb21tYW5kIGxpbmUuICovXG5leHBvcnQgZnVuY3Rpb24gY29tbWFuZExpbmUoYXJndjogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmcge1xuICByZXR1cm4gYXJndi5tYXAoc2hlbGxRdW90ZSkuam9pbihcIiBcIik7XG59XG5cbi8qKiBUaGUgcmUtYXJtIGZvciBhIHNwZWxsIHdob3NlIHRhaWwgaXMgYDxwcmVmaXjigKY+IC0tc2luY2UgTltAZXBvY2hdIFstLW9uY2VdYC5cbiAqICBQYXNzIGBlcG9jaGAgb25seSBmb3IgYSBzcGVsbCB3aG9zZSBgLS1zaW5jZWAgcGFyc2VzIGl0IChgcGFyc2VCb29rbWFya2ApLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxDb21tYW5kKFxuICBwcmVmaXg6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBzaW5jZTogbnVtYmVyLFxuICBvbmNlOiBib29sZWFuLFxuICBlcG9jaD86IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIC8vIOKaoCBBIG5lZ2F0aXZlIGJvb2ttYXJrIChub3RoaW5nIHNlZW4geWV0KSBpcyBzcGVsbGVkIGAtLXNpbmNlPS0xYDogdGhlXG4gIC8vIHBhcnNlcnMgcmVhZCBhIGJhcmUgYC0xYCBhZnRlciBhIGZsYWcgYXMgYW5vdGhlciBmbGFnIGFuZCByZWZ1c2UgaXQuXG4gIGNvbnN0IG1hcmsgPSBlcG9jaCA/IGAke3NpbmNlfUAke2Vwb2NofWAgOiBTdHJpbmcoc2luY2UpO1xuICBjb25zdCBhdCA9IHNpbmNlIDwgMCA/IFtgLS1zaW5jZT0ke21hcmt9YF0gOiBbXCItLXNpbmNlXCIsIG1hcmtdO1xuICByZXR1cm4gY29tbWFuZExpbmUoWy4uLnByZWZpeCwgLi4uYXQsIC4uLihvbmNlID8gW1wiLS1vbmNlXCJdIDogW10pXSk7XG59XG5cbmV4cG9ydCB0eXBlIEhhbmRvZmZPcHRpb25zPEV2PiA9IHtcbiAgLyoqIFRoZSBzcGVsbCdzIG5hbWUsIGNhcnJpZWQgb24gdGhlIGxpbmUgKHdob3NlIGxhdW5jaGVyIHJ1bnMgaXQpLiAqL1xuICBzcGVsbDogc3RyaW5nO1xuICBtb2RlOiBUYWlsTW9kZTtcbiAgLyoqIEEgcHJlc2VuY2Ugc3BlbGw6IGFsd2F5cyBgdGFpbC53aW5kb3dgIGF0IHRoZSB3aW5kb3cncyBlbmQsIG5ldmVyIGxvc3QuICovXG4gIHByZXNlbmNlOiBib29sZWFuO1xuICAvKiogRGVmYXVsdDogYHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSlgLiBgMGAgPSBubyB3aW5kb3cuICovXG4gIHdpbmRvd01zPzogbnVtYmVyO1xuICAvKiogV2hldGhlciBhbiBlbWl0dGVkIGZyYW1lIGlzIGEgTE9HIGZyYW1lIChBMykuIERlZmF1bHQ6IGV2ZXJ5IG9uZS4gKi9cbiAgY291bnRzPzogKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBib29sZWFuO1xuICAvKiogV2hpY2ggdGVybWluYWwgZnJhbWUgbWVhbnMgdGhlIHNlc3Npb24gY2xvc2VkLiBEZWZhdWx0OiBldmVyeSB0ZXJtaW5hbC4gKi9cbiAgaXNDbG9zZWQ/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogV2hvIHRoZSBjbG9zaW5nIGZyYW1lIHNheXMgZW5kZWQgdGhlIHNlc3Npb24gKFMxKTsgY2FycmllZCBvbiBgdGFpbC5jbG9zZWRgLiAqL1xuICBjbG9zZWRCeT86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIFdobyBlbmRlZCBhIHNlc3Npb24gZm91bmQgR09ORSAoRDE6IHJlLWFybWVkIGFmdGVyIGl0IGNsb3NlZCwgc28gbm9cbiAgICogIGNsb3NpbmcgZnJhbWUgaXMgZXZlciBzZWVuKSwgcmVhZCBmcm9tIHdoZXJldmVyIHRoZSBzcGVsbCBrZWVwcyBpdCDigJQgYVxuICAgKiAgbWFuaWZlc3QgdGhhdCBvdXRsaXZlcyB0aGUgZGFlbW9uLiBDYXJyaWVkIG9uIGB0YWlsLmNsb3NlZGAgYXMgYGJ5YCwgc29cbiAgICogIHRoZSBsaW5lIHNheXMgd2hhdCB0aGUgbGl2ZSBwYXRoJ3MgYGNsb3NlZEJ5YCB3b3VsZCBoYXZlIChTMSkuICovXG4gIGdvbmVCeT86ICgpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgY29tbWFuZHM6IEhhbmRvZmZDb21tYW5kcztcbn07XG5cbi8qKlxuICogUnVuIGB0YWlsRXZlbnRzYCB3aXRoIHRoZSBoYW5kb2ZmOiB0aGUgd2luZG93LCBgLS1vbmNlYCwgdGhlIGxvc3QgcnVsZSwgYW5kXG4gKiB0aGUgZmluYWwgbGluZS4gUmV0dXJucyB0aGUgZXhpdCBjb2RlLCBsaWtlIGB0YWlsRXZlbnRzYCwgYW5kIG5ldmVyIGV4aXRzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbFdpdGhIYW5kb2ZmPEV2PihcbiAgdGFpbDogVGFpbE9wdGlvbnM8RXY+LFxuICBoOiBIYW5kb2ZmT3B0aW9uczxFdj4sXG4pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBvdXQgPSB0YWlsLm91dCA/PyBwcm9jZXNzLnN0ZG91dDtcbiAgY29uc3Qgd2luZG93TXMgPSBoLndpbmRvd01zID8/IHJlc29sdmVXaW5kb3dNcyhwcm9jZXNzLmVudltXSU5ET1dfRU5WXSk7XG4gIGNvbnN0IGNvdW50cyA9IGguY291bnRzID8/ICgoKSA9PiB0cnVlKTtcbiAgY29uc3QgZW5kT25Mb3N0ID0gIWgucHJlc2VuY2U7XG5cbiAgY29uc3QgYWMgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBhYy5hYm9ydCgpO1xuICB0YWlsLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAodGFpbC5zaWduYWw/LmFib3J0ZWQpIGFjLmFib3J0KCk7XG5cbiAgbGV0IGV2ZW50cyA9IDA7XG4gIGxldCBjdXJzb3IgPSB0YWlsLnNpbmNlO1xuICBsZXQgZXBvY2g6IHN0cmluZyB8IHVuZGVmaW5lZCA9IHRhaWwuc2luY2VFcG9jaDtcbiAgbGV0IGZyYW1lSGFzSWQgPSBmYWxzZTtcbiAgLyoqIEEzICsgRDM6IGEgZnJhbWUgY291bnRzLCBhbmQgd2FrZXMgYSBgLS1vbmNlYCwgb25seSB3aGVuIGl0IGlzIE9OIFRIRVxuICAgKiAgTE9HIOKAlCBpdCBjYXJyaWVzIGEgbG9nIGlkIOKAlCBhbmQgdGhlIHNwZWxsJ3Mgb3duIGBjb3VudHNgIGFncmVlcy4gQSB0YWInc1xuICAgKiAgaWQtbGVzcyBgY29ubmVjdGVkYC9gZGlzY29ubmVjdGVkYCBwaW5nIGlzIG5vdCBvbiB0aGUgbG9nLiAqL1xuICBjb25zdCBpc0xvZ0ZyYW1lID0gKGV2OiBFdiwgZnJhbWU6IFNzZUZyYW1lKSA9PiBmcmFtZUhhc0lkICYmIGNvdW50cyhldiwgZnJhbWUpO1xuICBsZXQgZW5kOiBUYWlsRW5kIHwgbnVsbCA9IG51bGw7XG4gIGxldCBjbG9zZWRCeTogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICBsZXQgcmVmdXNhbHMgPSAwO1xuXG4gIGNvbnN0IGZpbmlzaCA9IChlOiBUYWlsRW5kKSA9PiB7XG4gICAgaWYgKGVuZCA9PT0gbnVsbCkgZW5kID0gZTtcbiAgICBhYy5hYm9ydCgpO1xuICB9O1xuICBjb25zdCB0aW1lciA9XG4gICAgaC5tb2RlID09PSBcIndhdGNoXCIgJiYgd2luZG93TXMgPiAwID8gc2V0VGltZW91dCgoKSA9PiBmaW5pc2goXCJ3aW5kb3dcIiksIHdpbmRvd01zKSA6IG51bGw7XG5cbiAgdHJ5IHtcbiAgICBjb25zdCBjb2RlID0gYXdhaXQgdGFpbEV2ZW50czxFdj4oe1xuICAgICAgLi4udGFpbCxcbiAgICAgIHNpZ25hbDogYWMuc2lnbmFsLFxuICAgICAgLy8gRDIncyBuZXQuIE9uIGZvciBldmVyeSBzcGVsbDogYSBmcmFtZSBhdCBvciBiZWxvdyB0aGUgYXNrZWQgY3Vyc29yXG4gICAgICAvLyBtZWFucyBhIHdob2xlIHJlcGxheSBvbiB0aGUga2l0J3MgbG9nLCBhbmQgb24gZ3JhcGV2aW5lJ3MgZHVyYWJsZSBsb2dcbiAgICAgIC8vIGl0IGhhcHBlbnMgb25seSB3aGVuIGAtLWxhc3RgIHJlYWNoZXMgYmVsb3cgYC0tc2luY2VgLCB3aGVyZVxuICAgICAgLy8gcmUtcmVhZGluZyB0aGUgY3Vyc29yIGZyb20gdGhlIGZyYW1lcyBpcyB0aGUgbW9yZSBjb3JyZWN0IGFuc3dlci5cbiAgICAgIHJlc3RhcnRPblJlcGxheTogdHJ1ZSxcbiAgICAgIC8vIEQzOiByZW1lbWJlciB3aGV0aGVyIFRISVMgZnJhbWUgY2FycmllcyBhIGxvZyBpZC4gYHRhaWxFdmVudHNgIHJlYWRzXG4gICAgICAvLyB0aGUgY3Vyc29yIG9uY2UgcGVyIGZyYW1lLCBiZWZvcmUgYGFjY2VwdGAsIGB0ZXJtaW5hbGAgYW5kIGByZW5kZXJgLlxuICAgICAgY3Vyc29yT2Y6IChldikgPT4ge1xuICAgICAgICBjb25zdCBuID0gdGFpbC5jdXJzb3JPZj8uKGV2KTtcbiAgICAgICAgZnJhbWVIYXNJZCA9IHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKTtcbiAgICAgICAgcmV0dXJuIG47XG4gICAgICB9LFxuICAgICAgb25VbnJlc29sdmVkOiAocykgPT4ge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gdGFpbC5vblVucmVzb2x2ZWQ/LihzKSA/PyBcInJldHJ5XCI7XG4gICAgICAgIC8vIEQxOiBhIHRhaWwgdGhhdCBnaXZlcyB1cCBvbiBmaW5kaW5nIGl0cyBzZXNzaW9uIGlzIHdhdGNoaW5nIGFcbiAgICAgICAgLy8gc2Vzc2lvbiB0aGF0IGlzIGdvbmUg4oCUIHdoZXRoZXIgdGhpcyBwcm9jZXNzIGV2ZXIgcmVhY2hlZCBpdCAoaXRzXG4gICAgICAgIC8vIHBvaW50ZXIgdmFuaXNoZWQpIG9yIGl0IHdhcyByZS1hcm1lZCBhdCBvbmUgdGhhdCBjbG9zZWQgaW4gdGhlIGdhcC5cbiAgICAgICAgaWYgKHZlcmRpY3QgPT09IFwic3RvcFwiICYmIGVuZCA9PT0gbnVsbCkge1xuICAgICAgICAgIGVuZCA9IFwiY2xvc2VkXCI7XG4gICAgICAgICAgY2xvc2VkQnkgPSBoLmdvbmVCeT8uKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZlcmRpY3Q7XG4gICAgICB9LFxuICAgICAgcmVuZGVyOiAoZXYsIGZyYW1lKSA9PiB7XG4gICAgICAgIHJlZnVzYWxzID0gMDtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwucmVuZGVyID8gdGFpbC5yZW5kZXIoZXYsIGZyYW1lKSA6IGZyYW1lLmRhdGE7XG4gICAgICAgIGlmIChsaW5lICE9PSBudWxsICYmIGlzTG9nRnJhbWUoZXYsIGZyYW1lKSkgZXZlbnRzICs9IDE7XG4gICAgICAgIHJldHVybiBsaW5lO1xuICAgICAgfSxcbiAgICAgIHRlcm1pbmFsOiAoZXYsIGZyYW1lLCBhY2NlcHRlZCkgPT4ge1xuICAgICAgICBpZiAodGFpbC50ZXJtaW5hbD8uKGV2LCBmcmFtZSwgYWNjZXB0ZWQpKSB7XG4gICAgICAgICAgaWYgKGVuZCA9PT0gbnVsbCkge1xuICAgICAgICAgICAgZW5kID0gKGguaXNDbG9zZWQgPz8gKCgpID0+IHRydWUpKShldikgPyBcImNsb3NlZFwiIDogXCJldmVudFwiO1xuICAgICAgICAgICAgaWYgKGVuZCA9PT0gXCJjbG9zZWRcIikgY2xvc2VkQnkgPSBoLmNsb3NlZEJ5Py4oZXYpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoaC5tb2RlID09PSBcIm9uY2VcIiAmJiBhY2NlcHRlZCAmJiBpc0xvZ0ZyYW1lKGV2LCBmcmFtZSkpIHtcbiAgICAgICAgICBpZiAoZW5kID09PSBudWxsKSBlbmQgPSBcImV2ZW50XCI7XG4gICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfSxcbiAgICAgIG9uQ29tbWVudDogKHRleHQpID0+IHtcbiAgICAgICAgcmVmdXNhbHMgPSAwO1xuICAgICAgICByZXR1cm4gdGFpbC5vbkNvbW1lbnQ/Lih0ZXh0KSA/PyBudWxsO1xuICAgICAgfSxcbiAgICAgIG9uRGlzY29ubmVjdDogKGluZm8pID0+IHtcbiAgICAgICAgY29uc3QgbGluZSA9IHRhaWwub25EaXNjb25uZWN0Py4oaW5mbykgPz8gbnVsbDtcbiAgICAgICAgaWYgKGluZm8uY2F1c2UgPT09IFwiY29ubmVjdC1mYWlsZWRcIikge1xuICAgICAgICAgIHJlZnVzYWxzICs9IDE7XG4gICAgICAgICAgaWYgKGVuZE9uTG9zdCAmJiByZWZ1c2FscyA+PSBMT1NUX0FGVEVSX1JFRlVTQUxTKSBmaW5pc2goXCJsb3N0XCIpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIFRoZSBkYWVtb24gYW5zd2VyZWQgKGEgc3RhdHVzLCBvciBhIHN0cmVhbSB0aGF0IG9wZW5lZCBhbmQgdGhlblxuICAgICAgICAgIC8vIGVuZGVkKTogaXQgaXMgYWxpdmUsIHNvIHRoZSByZWZ1c2FscyB3ZXJlIG5vdCBpbiBhIHJvdy5cbiAgICAgICAgICByZWZ1c2FscyA9IDA7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGxpbmU7XG4gICAgICB9LFxuICAgICAgb25FbmQ6IChzKSA9PiB7XG4gICAgICAgIGN1cnNvciA9IHMuY3Vyc29yO1xuICAgICAgICBlcG9jaCA9IHMuZXBvY2ggPz8gdW5kZWZpbmVkO1xuICAgICAgICB0YWlsLm9uRW5kPy4ocyk7XG4gICAgICB9LFxuICAgIH0pO1xuICAgIGNvbnN0IGxpbmUgPSBoYW5kb2ZmKFxuICAgICAge1xuICAgICAgICBlbmQ6IGVuZCA/PyBcInN0b3BwZWRcIixcbiAgICAgICAgLi4uKGNsb3NlZEJ5ID8geyBieTogY2xvc2VkQnkgfSA6IHt9KSxcbiAgICAgICAgbW9kZTogaC5tb2RlLFxuICAgICAgICBldmVudHMsXG4gICAgICAgIGN1cnNvcixcbiAgICAgICAgLi4uKGVwb2NoID8geyBlcG9jaCB9IDoge30pLFxuICAgICAgICBwcmVzZW5jZTogaC5wcmVzZW5jZSxcbiAgICAgICAgc3BlbGw6IGguc3BlbGwsXG4gICAgICB9LFxuICAgICAgaC5jb21tYW5kcyxcbiAgICApO1xuICAgIGlmIChsaW5lICE9PSBudWxsKSBvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkobGluZSl9XFxuYCk7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHRpbWVyICE9PSBudWxsKSBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIHRhaWwuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4gIH1cbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaGVhcnRiZWF0IC8gaWRsZS10aW1lb3V0IC8gdGFpbC13YXRjaGRvZyB0cmlwbGUg4oCUIHRocmVlIG51bWJlcnMgdGhhdCBhcmVcbiAqIE9ORSBpbnZhcmlhbnQsIHdyaXR0ZW4gb25jZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gLlxuICpcbiAqIOKUgOKUgCBXSFkgVEhJUyBNT0RVTEUgRVhJU1RTIEFUIEFMTCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBUaGUgdGhyZWUgbnVtYmVycyBhcmUgY2hhaW5lZCwgYW5kIHRoZSBjaGFpbiBpcyB3aGF0IG5vYm9keSBjb3VsZCBzZWU6XG4gKlxuICogICAgIHNlcnZlciBpZGxlVGltZW91dCAgPiAgU1NFIGhlYXJ0YmVhdCAgwrcgIHRhaWwgd2F0Y2hkb2cgID4gIFNTRSBoZWFydGJlYXRcbiAqXG4gKiAtICoqYGlkbGVUaW1lb3V0YCA+IGhlYXJ0YmVhdCoqLCBvciBCdW4gY2xvc2VzIGEgaGVsZCBTU0UgY29ubmVjdGlvbiBiZWZvcmVcbiAqICAgdGhlIGtlZXBhbGl2ZSB0aGF0IHdhcyBzdXBwb3NlZCB0byBwcmVzZXJ2ZSBpdCBldmVyIGZpcmVzLiBNRUFTVVJFRDogQnVuJ3NcbiAqICAgZGVmYXVsdCByZXF1ZXN0IGBpZGxlVGltZW91dGAgaXMgMTAgcyBhbmQgYSBTRVJWRVItU0VOVCBoZWFydGJlYXQgZG9lcyBub3RcbiAqICAgcmVzZXQgaXQsIHNvIGEgMTUgcyBgOiBoYmAgYXJyaXZlcyBmaXZlIHNlY29uZHMgYWZ0ZXIgdGhlIHRoaW5nIGl0IHdhc1xuICogICBrZWVwaW5nIGFsaXZlIGlzIGdvbmUg4oCUIHdoaWNoIGlzIHdoeSByYWlzaW5nIHRoZSBoZWFydGJlYXQgUkFURSB3b3VsZCBub3RcbiAqICAgaGF2ZSBoZWxwZWQuIEZvdXIgc3BlbGxzIGhhZCBoaXQgdGhpcyBhbmQgcmVwYWlyZWQgaXQsIHRocmVlIGhhZCBub3QuXG4gKiAtICoqd2F0Y2hkb2cgPiBoZWFydGJlYXQqKiwgb3IgYSBoZWFsdGh5LWJ1dC1xdWlldCB0YWlsIGFib3J0cyBhbmQgcmVjb25uZWN0c1xuICogICBmb3JldmVyLiBNRUFTVVJFRCBvbiBhc3Ryb2xhYmU6IHdpdGggYSBoYXJkLWNvZGVkIDQ1IHMgd2F0Y2hkb2cgYW5kIGFuXG4gKiAgIGVudi10dW5lZCBoZWFydGJlYXQsIHJlY29ubmVjdHMgbGFuZGVkIGF0ICs0Ny40IHMsICs5Mi42IHMgYW5kICsxMzcuOSBzXG4gKiAgIGFnYWluc3QgYSBwZXJmZWN0bHkgaGVhbHRoeSBkYWVtb24uIEl0IHdhcyBoYXJtbGVzcyBvbmx5IGJlY2F1c2UgYSBUSElSRFxuICogICBjb25zdGFudCDigJQgYSBwcmVzZW5jZSBkZWJvdW5jZSB3aXRoIG5vIHJlbGF0aW9uc2hpcCB0byBlaXRoZXIg4oCUIGhhcHBlbmVkIHRvXG4gKiAgIGFic29yYiB0aGUgY2h1cm4uXG4gKlxuICog4puUICoqQU5EIFRIRSBTRUFNIElTIFRIRSBQT0lOVC4qKiBVbnRpbCBQaGFzZSAxYiB0aGUgd2F0Y2hkb2cgbGl2ZWQgaW4gZWFjaFxuICogc3BlbGwncyBDTEkgYW5kIHRoZSBoZWFydGJlYXQgaW4gZWFjaCBzcGVsbCdzIGRhZW1vbiwgYW5kIEJPVEggZmlsZXMgY2FycmllZCBhXG4gKiBjb21tZW50IHNheWluZyB0aGUgZXhwcmVzc2lvbnMgd2VyZSBoYW5kLW1pcnJvcmVkIGFjcm9zcyBhIGJvdW5kYXJ5IHRoZSBDTElcbiAqIGNvdWxkIG5vdCBjcm9zcyDigJQgaW1wb3J0aW5nIHRoZSBkYWVtb24gd291bGQgaGF2ZSBkcmFnZ2VkIHRoZSB3aG9sZSBzZXJ2ZXJcbiAqIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gVGhpcyBtb2R1bGUgaXMgdGhlIGNyb3NzaW5nOiBpdCBob2xkcyBubyBzcGVsbCdzXG4gKiBudW1iZXJzLCBvbmx5IHRoZSBkZXJpdmF0aW9ucywgYW5kIGVhY2ggc3BlbGwncyBvd24gdGlueSBgaGVhcnRiZWF0LnRzYFxuICogYmVzaWRlIGl0cyBkYWVtb24gaG9sZHMgdGhlIHZhbHVlcyB0aGF0IEJPVEggaGFsdmVzIHRoZW4gaW1wb3J0LiBBIHZhbHVlIHRoYXRcbiAqIGNvdWxkIG5vdCBwcmV2aW91c2x5IGNyb3NzIHRoZSBzZWFtIG5vdyBjcm9zc2VzIGl0LlxuICovXG5cbi8qKiBCdW4ncyBtYXhpbXVtIGBpZGxlVGltZW91dGAsIGluIHNlY29uZHMuIGAwYCBpcyBub3QgXCJkaXNhYmxlZFwiIOKAlCBpdCBpcyB0aGVcbiAqICBkZWZhdWx0IOKAlCBzbyB0aGUgd2F5IHRvIGhvbGQgYSBjb25uZWN0aW9uIG9wZW4gaXMgdG8gYXNrIGZvciB0aGUgbWF4aW11bS4gKi9cbmV4cG9ydCBjb25zdCBNQVhfSURMRV9USU1FT1VUX1NFQyA9IDI1NTtcblxuLyoqIFRoZSBob3VzZSBkZWZhdWx0IGhlYXJ0YmVhdCwgaW4gbXMuIFNpeCBvZiB0aGUgZWlnaHQgZGFlbW9ucyB3cml0ZSAxNSBzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuXG4vKiogSG93IG1hbnkgbWlzc2VkIGJlYXRzIHRoZSB0YWlsIHdhdGNoZG9nIHRvbGVyYXRlcyBiZWZvcmUgaXQgYWJvcnRzIGFuZFxuICogIHJlY29ubmVjdHMuIFRocmVlLCBldmVyeXdoZXJlLCBhbmQgaXQgaXMgYSBmbG9vciBub3QgYSB0YXN0ZTogaG9sZGluZyB0aGVcbiAqICBjb25uZWN0aW9uIG9wZW4gSVMgYSBgam9pbmAncyBwcmVzZW5jZSBzaWduYWwsIHNvIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYVxuICogIGNhcmQgaW4gYSBodW1hbidzIHZpZXcuIEl0IHN0aWxsIHdhbnRzIGEgd2F0Y2hkb2cg4oCUIGEgd2VkZ2VkIGhhbGYtb3BlbiBzb2NrZXRcbiAqICBzaG93cyBhIGNhcmQgYXMgcGVybWFuZW50bHkgcHJlc2VudCwgd2hpY2ggaXMgdGhlIHdvcnNlIGxpZS4gKi9cbmV4cG9ydCBjb25zdCBNSVNTRURfQkVBVFMgPSAzO1xuXG4vKipcbiAqIFRoZSBzbWFsbGVzdCBiZWF0IHRoaXMgbW9kdWxlIHdpbGwgaGFuZCBiYWNrLCBpbiBtcyDigJQgdGhlIEZMT09SIGhhbGYgb2YgdGhlXG4gKiBjbGFtcCB3aG9zZSBjZWlsaW5nIGlzIGBpZGxlVGltZW91dCAvIDJgLlxuICpcbiAqIOKblCBJVCBFWElTVFMgQkVDQVVTRSBgaW50T3JgIFBBUlNFUyBXSVRIIGBwYXJzZUludGAsIEFORCBgcGFyc2VJbnRgIElTIExFTklFTlRcbiAqIFdIRVJFIElUIE1BVFRFUlMgTU9TVC4gYGludE9yYCBmYWxscyBiYWNrIHNhZmVseSBvbiBldmVyeXRoaW5nIHRoYXQgTE9PS1NcbiAqIGhvc3RpbGUg4oCUIGBcIlwiYCwgYFwiMFwiYCwgYFwiLTFcImAsIGBcImFiY1wiYCwgYFwiTmFOXCJgLCBgXCJJbmZpbml0eVwiYCBhbGwgdGFrZSB0aGVcbiAqIGZhbGxiYWNrIOKAlCBhbmQgdGhlbiByZWFkcyBgXCIxZTlcImAsIHRoZSBtb3N0IHBsYXVzaWJsZSBzcGVsbGluZyBvZiBcIm1ha2UgaXRcbiAqIGh1Z2VcIiwgYXMgKioxKiouIE1FQVNVUkVEIGF0IGdyYXBldmluZSdzIFBoYXNlIDYgcmVwYWlyLCBiZWZvcmUgdGhpcyBmbG9vcjpcbiAqIGBHUkFQRVZJTkVfSEVBUlRCRUFUX01TPTFlOWAgcHV0IH41Mjgga2VlcGFsaXZlIGNvbW1lbnRzIGludG8gZXZlcnkgb3BlbiBTU0VcbiAqIGNsaWVudCBpbiA1MjggbXMuIGBcIjMuOVwiYCBnaXZlcyAzIG1zIGFuZCBgXCI1YWJjXCJgIGdpdmVzIDUgbXMgdGhlIHNhbWUgd2F5LlxuICogQSBrbm9iIHdob3NlIGZhc3Rlc3Qgc2V0dGluZyBpcyBzcGVsbGVkIGxpa2UgaXRzIHNsb3dlc3QgaXMgYSBmbG9vZC5cbiAqXG4gKiDimqAgKipUSEUgRkxPT1IgSVMgSEVSRSBBTkQgTk9UIElOIGBpbnRPcmAg4oCUIHRoYXQgaXMgdGhlIHJ1bGluZywgbm90IGFuXG4gKiBhY2NpZGVudCBvZiB3aGVyZSBpdCB3YXMgZWFzeSB0byB3cml0ZSoqIChENzYpLiBgaW50T3JgIGlzIHRoZSBnZW5lcmFsIHBhcnNlclxuICogYmVoaW5kIGV2ZXJ5IGVudiBrbm9iIGluIHRoZSBraXQ7IHRoZXJlIGlzIG5vIHNpbmdsZSByb3N0ZXItY29ycmVjdCBtaW5pbXVtXG4gKiBmb3IgXCJhIHBvc2l0aXZlIGludGVnZXJcIiwgYW5kIHRpZ2h0ZW5pbmcgaXRzIFBBUlNFIChyZWplY3RpbmcgYDFlOWAgb3V0cmlnaHQpXG4gKiB3b3VsZCBjaGFuZ2Ugd2hhdCBldmVyeSBvdGhlciBrbm9iIGFjY2VwdHMsIHNpbGVudGx5LCBmb3IgdmFsdWVzIG5vYm9keSBoYXNcbiAqIGF1ZGl0ZWQuIGBoZWFydGJlYXRNc2AgYWxyZWFkeSBvd25zIG9uZSBlbmQgb2YgdGhpcyBpbnZhcmlhbnQsIGFuZCA1MDAgd2FzXG4gKiBhbHJlYWR5IHdyaXR0ZW4gaW50byBpdCBhcyB0aGUgc21hbGxlc3QgY2VpbGluZyBpdCB3b3VsZCBjb21wdXRlLiBUaGUgZmxvb3JcbiAqIGJlbG9uZ3MgYmVzaWRlIHRoZSBjZWlsaW5nLCB3aGVyZSB0aGUgcXVhbnRpdHkgaXMga25vd24uXG4gKi9cbmV4cG9ydCBjb25zdCBNSU5fSEVBUlRCRUFUX01TID0gNTAwO1xuXG4vKiogUGFyc2UgYSBwb3NpdGl2ZSBpbnRlZ2VyIGZyb20gYW4gZW52IHZhbHVlLCBmYWxsaW5nIGJhY2sgb24gYW55dGhpbmcgdGhhdCBpc1xuICogIGFic2VudCwgZW1wdHksIG5vbi1udW1lcmljIG9yIG5vbi1wb3NpdGl2ZS4g4pqgIGBwYXJzZUludGAgc2VtYW50aWNzOiBgXCIxZTlcImBcbiAqICBpcyAxIGFuZCBgXCI1YWJjXCJgIGlzIDUuIEFueSBjYWxsZXIgd2l0aCBhIGtub3duIHNhZmUgbWluaW11bSBtdXN0IGNsYW1wIOKAlFxuICogIHNlZSBgTUlOX0hFQVJUQkVBVF9NU2AuICovXG5mdW5jdGlvbiBpbnRPcihyYXc6IHN0cmluZyB8IHVuZGVmaW5lZCwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIucGFyc2VJbnQocmF3ID8/IFwiXCIsIDEwKTtcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSAmJiBuID4gMCA/IG4gOiBmYWxsYmFjaztcbn1cblxuLyoqIFRoZSBzZXJ2ZXIncyBgaWRsZVRpbWVvdXRgLCBpbiBTRUNPTkRTLCBjbGFtcGVkIHRvIHdoYXQgQnVuIGFjY2VwdHMuICovXG5leHBvcnQgZnVuY3Rpb24gaWRsZVRpbWVvdXRTZWMocmF3Pzogc3RyaW5nIHwgdW5kZWZpbmVkLCBmYWxsYmFjayA9IE1BWF9JRExFX1RJTUVPVVRfU0VDKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KDEsIE1hdGgubWluKE1BWF9JRExFX1RJTUVPVVRfU0VDLCBpbnRPcihyYXcsIGZhbGxiYWNrKSkpO1xufVxuXG4vKipcbiAqIFRoZSBTU0UgaGVhcnRiZWF0LCBpbiBtcywgQ0xBTVBFRCBBVCBCT1RIIEVORFM6IG5ldmVyIGFib3ZlIGhhbGYgdGhlIGlkbGVcbiAqIHRpbWVvdXQsIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYC5cbiAqXG4gKiBUaGUgY2VpbGluZyBpcyBhc3Ryb2xhYmUncywgYW5kIHRoZSBjZW5zdXMgbmFtZWQgaXQgY29udmVyZ2VuY2UgdGFyZ2V0ICM0OlxuICogdGhlIG90aGVyIGRhZW1vbnMgaGFyZC1jb2RlIDE1IHMgYWdhaW5zdCAyNTUgcyBhbmQgd3JpdGUgdGhlIHJlbGF0aW9uc2hpcFxuICogb25seSBpbiBwcm9zZSwgd2hpY2ggaG9sZHMgYXQgdGhlIGRlZmF1bHQgYW5kIGF0IG5vIG90aGVyIHZhbHVlLiBFbmZvcmNpbmdcbiAqIGBoZWFydGJlYXQgPD0gaWRsZVRpbWVvdXQgLyAyYCBtYWtlcyB0aGUgaW52YXJpYW50IHRydWUgZm9yIEFOWSBjb25maWd1cmVkXG4gKiBwYWlyLCB3aGljaCBpcyBleGFjdGx5IHRoZSBpbnZhcmlhbnQgd2hvc2UgdmlvbGF0aW9uIGNhdXNlZCB0aGUgYnVnIGFib3ZlLlxuICpcbiAqIOKaoCBUaGUgZmxvb3IgY2Fubm90IGZpZ2h0IHRoZSBjZWlsaW5nOiB0aGUgY2VpbGluZyBleHByZXNzaW9uIGlzIGl0c2VsZlxuICogYE1hdGgubWF4KDUwMCwg4oCmKWAsIHNvIGl0IGlzIG5ldmVyIGJlbG93IGBNSU5fSEVBUlRCRUFUX01TYCBhbmQgdGhlIHR3b1xuICogY2xhbXBzIGNhbiBuZXZlciBjcm9zcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhlYXJ0YmVhdE1zKFxuICByYXc6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgaWRsZVNlYzogbnVtYmVyLFxuICBmYWxsYmFjayA9IERFRkFVTFRfSEVBUlRCRUFUX01TLFxuKTogbnVtYmVyIHtcbiAgY29uc3QgY2VpbGluZyA9IE1hdGgubWF4KE1JTl9IRUFSVEJFQVRfTVMsIE1hdGguZmxvb3IoKGlkbGVTZWMgKiAxMDAwKSAvIDIpKTtcbiAgcmV0dXJuIE1hdGgubWluKE1hdGgubWF4KGludE9yKHJhdywgZmFsbGJhY2spLCBNSU5fSEVBUlRCRUFUX01TKSwgY2VpbGluZyk7XG59XG5cbi8qKiBUaGUgdGFpbC1zaWRlIHdhdGNoZG9nIGZvciBhIGdpdmVuIGhlYXJ0YmVhdDogdGhyZWUgbWlzc2VkIGJlYXRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRhaWxJZGxlTXMoYmVhdE1zOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gYmVhdE1zICogTUlTU0VEX0JFQVRTO1xufVxuIiwKICAgICIvKipcbiAqIHNjcmlwdG9yaXVtJ3MgY29ubmVjdGlvbi10aW1pbmcgY29uc3RhbnRzIOKAlCBUSEUgT05FIENPUFksIGltcG9ydGVkIGJ5IGJvdGhcbiAqIGhhbHZlcyAoYGNsaS50c2AncyB0YWlsIHdhdGNoZG9nLCBgc2VydmVyLnRzYCdzIFNTRSBoZWFydGJlYXQgYW5kIGlkbGVcbiAqIHRpbWVvdXQpLiBLaXQgdmVyZGljdCBgaGVhcnRiZWF0YDogU1VCSkVDVCDigJQgdGhlIHNlYW0gZXhpc3RzIGJlY2F1c2UgdGhlIENMSVxuICogYW5kIHRoZSBkYWVtb24gYXJlIHR3byBwcm9jZXNzZXMgdGhhdCBtdXN0IGFncmVlIG9uIG9uZSBpbnZhcmlhbnRcbiAqIChgaWRsZVRpbWVvdXQgPiBoZWFydGJlYXRgLCBgd2F0Y2hkb2cgPiBoZWFydGJlYXRgKSwgYW5kIG5laXRoZXIgbWF5IGltcG9ydFxuICogdGhlIG90aGVyLlxuICpcbiAqIOKaoCBLRUVQIElUIEEgTEVBRi1TSEFQRUQgRklMRS4gVGhlIG1vbWVudCB0aGlzIGltcG9ydHMgYW55dGhpbmcgb2YgdGhlXG4gKiBkYWVtb24ncywgYGRpc3QvY2xpLmpzYCBkcmFncyB0aGUgc2VydmVyIGdyYXBoIGFuZCB0aGUgc2VhbSBjbG9zZXMuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9IRUFSVEJFQVRfTVMsXG4gIE1BWF9JRExFX1RJTUVPVVRfU0VDLFxuICB0YWlsSWRsZU1zLFxufSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvaGVhcnRiZWF0LnRzXCI7XG5cbi8qKiBCdW4ncyBtYXhpbXVtOiBhIGhlbGQgU1NFIHRhaWwgbXVzdCBvdXRsaXZlIEJ1bidzIDEwIHMgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBJRExFX1RJTUVPVVRfU0VDID0gTUFYX0lETEVfVElNRU9VVF9TRUM7XG5cbi8qKiBUaGUgaG91c2UgZGVmYXVsdC4gKi9cbmV4cG9ydCBjb25zdCBTU0VfSEVBUlRCRUFUX01TID0gREVGQVVMVF9IRUFSVEJFQVRfTVM7XG5cbi8qKiBUaGUgdGFpbCB3YXRjaGRvZzogdGhyZWUgbWlzc2VkIGJlYXRzIG9mIFRISVMgZGFlbW9uJ3MgaGVhcnRiZWF0LCBkZXJpdmVkLiAqL1xuZXhwb3J0IGNvbnN0IFRBSUxfSURMRV9NUyA9IHRhaWxJZGxlTXMoU1NFX0hFQVJUQkVBVF9NUyk7XG4iLAogICAgIi8qKlxuICogQ29udGV4dCBlbnRyaWVzIG9uIGRpc2sg4oCUIGJ1aWxkaW5nIGFuIGVudHJ5IGZyb20gYSBwYXRoIChFMTUncyBvbmUgbW9kZWwpLFxuICogbWlycm9yaW5nIGEgZm9sZGVyIGludG8gYSBub2RlIHRyZWUsIGFuZCBsaXN0aW5nIGEgZGlyZWN0b3J5IGZvciB0aGVcbiAqIHN1cmZhY2UncyBwYXRoIGNvbXBsZXRpb24gKGBmcy5saXN0YCkuXG4gKlxuICogUHVyZSBvdmVyIHRoZSBmaWxlc3lzdGVtOiBubyBkYWVtb24gc3RhdGUsIHNvIHRoZSB1bml0IGNlbGxzIGRyaXZlIGl0IHdpdGggYVxuICogdGVtcCBkaXJlY3RvcnkgYW5kIG5vdGhpbmcgZWxzZS5cbiAqL1xuXG5pbXBvcnQgeyByZWFkZGlyU3luYywgc3RhdFN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4sIHJlbGF0aXZlLCBzZXAgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IENvbnRleHRFbnRyeSwgQ29udGV4dE5vZGUsIEZzTGlzdEVudHJ5IH0gZnJvbSBcIi4vcHJvdG9jb2xcIjtcblxuLyoqIFdoYXQgc2NyaXB0b3JpdW0gb3BlbnMgYXMgYSBkb2N1bWVudC4gRXZlcnl0aGluZyBlbHNlIGlzIG5vdCBzaG93bi4gKi9cbmV4cG9ydCBjb25zdCBET0NfRVhURU5TSU9OUyA9IFtcIi5tZFwiLCBcIi5tYXJrZG93blwiLCBcIi5tZHhcIiwgXCIudHh0XCJdIGFzIGNvbnN0O1xuXG5leHBvcnQgZnVuY3Rpb24gaXNEb2NOYW1lKG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBsb3dlciA9IG5hbWUudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIERPQ19FWFRFTlNJT05TLnNvbWUoKGV4dCkgPT4gbG93ZXIuZW5kc1dpdGgoZXh0KSk7XG59XG5cbi8qKiBEaXJlY3RvcmllcyBhIG1pcnJvciBuZXZlciBkZXNjZW5kcyBpbnRvIOKAlCBub2lzZSwgbm90IGRvY3VtZW50cy4gKi9cbmNvbnN0IFNLSVBfRElSUyA9IG5ldyBTZXQoW1wibm9kZV9tb2R1bGVzXCIsIFwiLmdpdFwiLCBcImRpc3RcIiwgXCJvdXRcIiwgXCJjb3ZlcmFnZVwiXSk7XG5cbi8qKlxuICogVGhlIG1vc3Qgbm9kZXMgb25lIG1pcnJvcmVkIHNjYW4gd2lsbCBob2xkLiBBIGZvbGRlciBlbnRyeSBwb2ludGVkIGF0IGEgaHVnZVxuICogdHJlZSBtdXN0IG5vdCBzdGFsbCB0aGUgZGFlbW9uIG9yIGZsb29kIGV2ZXJ5IHN0YXRlIGJyb2FkY2FzdDsgaGl0dGluZyB0aGVcbiAqIGNhcCBzZXRzIGB0cnVuY2F0ZWRgIG9uIHRoZSBlbnRyeSBzbyB0aGUgc3VyZmFjZSBjYW4gU0FZIHRoZSBsaXN0IGlzIHNob3J0XG4gKiByYXRoZXIgdGhhbiByZW5kZXIgYSBzaG9ydCBsaXN0IGFzIGEgY29tcGxldGUgb25lLlxuICovXG5leHBvcnQgY29uc3QgTUlSUk9SX05PREVfQ0FQID0gMjAwMDtcblxuZXhwb3J0IGNvbnN0IHRvUG9zaXggPSAocDogc3RyaW5nKSA9PiBwLnNwbGl0KHNlcCkuam9pbihcIi9cIik7XG5cbi8qKlxuICogTWlycm9yIGByb290YCBpbnRvIGEgc29ydGVkIG5vZGUgdHJlZTogZ3JvdXBzIGZpcnN0LCB0aGVuIGRvY3MsIGJ5IG5hbWUuXG4gKiBgaGlkZGVuYCByZWxzIChFMjQncyBcIlJlbW92ZSBmcm9tIFNjcmlwdG9yaXVtXCIpIGFyZSBza2lwcGVkLCBhIGZvbGRlciB3aXRoXG4gKiBldmVyeXRoaW5nIHVuZGVyIGl0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2NhblRyZWUoXG4gIHJvb3Q6IHN0cmluZyxcbiAgY2FwID0gTUlSUk9SX05PREVfQ0FQLFxuICBoaWRkZW46IHJlYWRvbmx5IHN0cmluZ1tdID0gW10sXG4pOiB7IG5vZGVzOiBDb250ZXh0Tm9kZVtdOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCB0cnVuY2F0ZWQgPSBmYWxzZTtcbiAgY29uc3Qgc2tpcCA9IG5ldyBTZXQoaGlkZGVuKTtcbiAgY29uc3Qgd2FsayA9IChkaXI6IHN0cmluZyk6IENvbnRleHROb2RlW10gPT4ge1xuICAgIGxldCBuYW1lczogc3RyaW5nW107XG4gICAgdHJ5IHtcbiAgICAgIG5hbWVzID0gcmVhZGRpclN5bmMoZGlyKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBbXTtcbiAgICB9XG4gICAgY29uc3QgZ3JvdXBzOiBDb250ZXh0Tm9kZVtdID0gW107XG4gICAgY29uc3QgZG9jczogQ29udGV4dE5vZGVbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBuYW1lcy5zb3J0KChhLCBiKSA9PiBhLmxvY2FsZUNvbXBhcmUoYikpKSB7XG4gICAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgICBpZiAoY291bnQgPj0gY2FwKSB7XG4gICAgICAgIHRydW5jYXRlZCA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgICAgbGV0IHN0OiBSZXR1cm5UeXBlPHR5cGVvZiBzdGF0U3luYz47XG4gICAgICB0cnkge1xuICAgICAgICBzdCA9IHN0YXRTeW5jKGFicyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCByZWwgPSB0b1Bvc2l4KHJlbGF0aXZlKHJvb3QsIGFicykpO1xuICAgICAgaWYgKHNraXAuaGFzKHJlbCkpIGNvbnRpbnVlO1xuICAgICAgaWYgKHN0LmlzRGlyZWN0b3J5KCkpIHtcbiAgICAgICAgaWYgKFNLSVBfRElSUy5oYXMobmFtZSkpIGNvbnRpbnVlO1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBjb25zdCBjaGlsZHJlbiA9IHdhbGsoYWJzKTtcbiAgICAgICAgLy8gQSBmb2xkZXIgaG9sZGluZyBvbmx5IG5vbi1kb2N1bWVudHMgKGltYWdlcywgYXNzZXRzKSBpcyBub2lzZSBpbiBhXG4gICAgICAgIC8vIGRvY3MgbWlycm9yIGFuZCBpcyBsZWZ0IG91dC4gQSBUUlVMWSBFTVBUWSBmb2xkZXIgaXMga2VwdDogaXQgaXMgb25lXG4gICAgICAgIC8vIHNvbWVib2R5IGp1c3QgbWFkZSB0byBwdXQgZG9jdW1lbnRzIGluIChcIk5ldyBmb2xkZXJcIiwgRTI0KSwgYW5kXG4gICAgICAgIC8vIGxlYXZpbmcgaXQgb3V0IG1hZGUgaXQgdmFuaXNoIHRoZSBtb21lbnQgaXQgd2FzIGNyZWF0ZWQuXG4gICAgICAgIGlmIChjaGlsZHJlbi5sZW5ndGggPiAwIHx8IGlzRW1wdHlEaXIoYWJzKSkgZ3JvdXBzLnB1c2goeyBraW5kOiBcImdyb3VwXCIsIHJlbCwgY2hpbGRyZW4gfSk7XG4gICAgICB9IGVsc2UgaWYgKHN0LmlzRmlsZSgpICYmIGlzRG9jTmFtZShuYW1lKSkge1xuICAgICAgICBjb3VudCsrO1xuICAgICAgICBkb2NzLnB1c2goeyBraW5kOiBcImRvY1wiLCByZWwgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBbLi4uZ3JvdXBzLCAuLi5kb2NzXTtcbiAgfTtcbiAgY29uc3Qgbm9kZXMgPSB3YWxrKHJvb3QpO1xuICByZXR1cm4geyBub2RlcywgdHJ1bmNhdGVkIH07XG59XG5cbi8qKiBOb3RoaW5nIGluIGl0IGJ1dCBkb3RmaWxlcyAoYSBgLkRTX1N0b3JlYCBkb2VzIG5vdCBtYWtlIGEgZm9sZGVyIGZ1bGwpLiAqL1xuZnVuY3Rpb24gaXNFbXB0eURpcihkaXI6IHN0cmluZyk6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIHJldHVybiByZWFkZGlyU3luYyhkaXIpLmV2ZXJ5KChuKSA9PiBuLnN0YXJ0c1dpdGgoXCIuXCIpKTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUaGUgbm9kZSBhdCBgcmVsYCBpbiBhIHRyZWUsIG9yIHVuZGVmaW5lZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTm9kZShub2RlczogcmVhZG9ubHkgQ29udGV4dE5vZGVbXSwgcmVsOiBzdHJpbmcpOiBDb250ZXh0Tm9kZSB8IHVuZGVmaW5lZCB7XG4gIGZvciAoY29uc3QgbiBvZiBub2Rlcykge1xuICAgIGlmIChuLnJlbCA9PT0gcmVsKSByZXR1cm4gbjtcbiAgICBpZiAobi5raW5kID09PSBcImdyb3VwXCIgJiYgcmVsLnN0YXJ0c1dpdGgoYCR7bi5yZWx9L2ApKSByZXR1cm4gZmluZE5vZGUobi5jaGlsZHJlbiwgcmVsKTtcbiAgfVxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5leHBvcnQgY2xhc3MgUGF0aEVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICAgcmVhZG9ubHkgY29kZTogXCJtaXNzaW5nXCIgfCBcIm5vdC1hLWRvY1wiLFxuICApIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgfVxufVxuXG4vKipcbiAqIEFuIGVudHJ5IGZvciBhbiBhYnNvbHV0ZSBwYXRoLiBBIGRpcmVjdG9yeSBpcyBgbWlycm9yZWRgOyBhIGRvY3VtZW50IGZpbGUgaXNcbiAqIGBsaXN0ZWRgLCByb290ZWQgYXQgaXRzIHBhcmVudCwgaG9sZGluZyBvbmx5IGl0c2VsZiAoRTE1KS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVudHJ5Rm9yUGF0aChhYnM6IHN0cmluZywgaWQ6IHN0cmluZyk6IENvbnRleHRFbnRyeSB7XG4gIGxldCBzdDogUmV0dXJuVHlwZTx0eXBlb2Ygc3RhdFN5bmM+O1xuICB0cnkge1xuICAgIHN0ID0gc3RhdFN5bmMoYWJzKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihgbm8gc3VjaCBmaWxlIG9yIGZvbGRlcjogJHthYnN9YCwgXCJtaXNzaW5nXCIpO1xuICB9XG4gIGlmIChzdC5pc0RpcmVjdG9yeSgpKSB7XG4gICAgY29uc3QgeyBub2RlcywgdHJ1bmNhdGVkIH0gPSBzY2FuVHJlZShhYnMpO1xuICAgIHJldHVybiB7XG4gICAgICBpZCxcbiAgICAgIGxhYmVsOiBiYXNlbmFtZShhYnMpIHx8IGFicyxcbiAgICAgIHJvb3Q6IGFicyxcbiAgICAgIG1lbWJlcnNoaXA6IFwibWlycm9yZWRcIixcbiAgICAgIG5vZGVzLFxuICAgICAgLi4uKHRydW5jYXRlZCA/IHsgdHJ1bmNhdGVkIH0gOiB7fSksXG4gICAgfTtcbiAgfVxuICBpZiAoIWlzRG9jTmFtZShhYnMpKSB7XG4gICAgdGhyb3cgbmV3IFBhdGhFcnJvcihcbiAgICAgIGBub3QgYSBkb2N1bWVudCBzY3JpcHRvcml1bSBvcGVucyAoJHtET0NfRVhURU5TSU9OUy5qb2luKFwiIFwiKX0pOiAke2Fic31gLFxuICAgICAgXCJub3QtYS1kb2NcIixcbiAgICApO1xuICB9XG4gIHJldHVybiB7XG4gICAgaWQsXG4gICAgbGFiZWw6IGJhc2VuYW1lKGFicyksXG4gICAgcm9vdDogZGlybmFtZShhYnMpLFxuICAgIG1lbWJlcnNoaXA6IFwibGlzdGVkXCIsXG4gICAgbm9kZXM6IFt7IGtpbmQ6IFwiZG9jXCIsIHJlbDogYmFzZW5hbWUoYWJzKSB9XSxcbiAgfTtcbn1cblxuLyoqIEV2ZXJ5IGRvYyBub2RlJ3MgYWJzb2x1dGUgcGF0aCwgZGVwdGgtZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gZG9jUGF0aHMoZW50cnk6IENvbnRleHRFbnRyeSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgb3V0OiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCB3YWxrID0gKG5vZGVzOiBDb250ZXh0Tm9kZVtdKSA9PiB7XG4gICAgZm9yIChjb25zdCBuIG9mIG5vZGVzKSB7XG4gICAgICBpZiAobi5raW5kID09PSBcImRvY1wiKSBvdXQucHVzaChqb2luKGVudHJ5LnJvb3QsIG4ucmVsKSk7XG4gICAgICBlbHNlIHdhbGsobi5jaGlsZHJlbik7XG4gICAgfVxuICB9O1xuICB3YWxrKGVudHJ5Lm5vZGVzKTtcbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIFdoaWNoIGVudHJ5IChpZiBhbnkpIGhvbGRzIGBhYnNgLCBhbmQgYXQgd2hhdCBgcmVsYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb2NhdGUoXG4gIGVudHJpZXM6IENvbnRleHRFbnRyeVtdLFxuICBhYnM6IHN0cmluZyxcbik6IHsgZW50cnlJZDogc3RyaW5nOyByZWw6IHN0cmluZyB9IHwgbnVsbCB7XG4gIGZvciAoY29uc3QgZSBvZiBlbnRyaWVzKSB7XG4gICAgaWYgKGRvY1BhdGhzKGUpLmluY2x1ZGVzKGFicykpIHJldHVybiB7IGVudHJ5SWQ6IGUuaWQsIHJlbDogdG9Qb3NpeChyZWxhdGl2ZShlLnJvb3QsIGFicykpIH07XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKlxuICogT25lIGRpcmVjdG9yeSwgZm9yIHRoZSBzdXJmYWNlJ3MgYWRkLWJ5LXBhdGggY29tcGxldGlvbjogc3ViZGlyZWN0b3JpZXMgYW5kXG4gKiBkb2N1bWVudHMgb25seSwgZGlyZWN0b3JpZXMgZmlyc3QuIGB+YCBpcyBleHBhbmRlZCBieSB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlzdERpcihkaXI6IHN0cmluZyk6IEZzTGlzdEVudHJ5W10ge1xuICBjb25zdCBuYW1lcyA9IHJlYWRkaXJTeW5jKGRpcik7XG4gIGNvbnN0IG91dDogRnNMaXN0RW50cnlbXSA9IFtdO1xuICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHtcbiAgICBpZiAobmFtZS5zdGFydHNXaXRoKFwiLlwiKSkgY29udGludWU7XG4gICAgY29uc3QgYWJzID0gam9pbihkaXIsIG5hbWUpO1xuICAgIGxldCBpc0RpciA9IGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBpc0RpciA9IHN0YXRTeW5jKGFicykuaXNEaXJlY3RvcnkoKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNEaXIgfHwgaXNEb2NOYW1lKG5hbWUpKSBvdXQucHVzaCh7IG5hbWUsIHBhdGg6IGFicywgZGlyOiBpc0RpciB9KTtcbiAgfVxuICByZXR1cm4gb3V0LnNvcnQoKGEsIGIpID0+IChhLmRpciA9PT0gYi5kaXIgPyBhLm5hbWUubG9jYWxlQ29tcGFyZShiLm5hbWUpIDogYS5kaXIgPyAtMSA6IDEpKTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7O0FBZ0RBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFVQTtBQUNBOzs7QUNLQTs7O0FDMUNPLFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FDNkIzQyxJQUFNLFdBQW9DO0FBQUEsRUFDL0MsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBdUJBLElBQUksaUJBQWdDO0FBRTdCLFNBQVMsaUJBQWlCLENBQUMsU0FBOEI7QUFBQSxFQUM5RCxpQkFBaUI7QUFBQTtBQWFaLFNBQVMsYUFBYSxDQUFDLE1BQWUsU0FBaUIsT0FBMEI7QUFBQSxFQUN0RixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxTQUUvQyxPQUFPLFdBQVcsWUFBWSxFQUFFLFFBQVEsTUFBTSxPQUFPLElBQUksQ0FBQztBQUFBLElBQ2hFO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxlQUFlO0FBQUEsRUFDbEMsQ0FBQztBQUFBO0FBQUE7QUFBQTtBQUlJLE1BQU0saUJBQWlCLE1BQU07QUFBQSxFQUN6QjtBQUFBLEVBQ0E7QUFBQSxFQUVULFdBQVcsQ0FBQyxNQUFlLFNBQWlCLE9BQWtCO0FBQUEsSUFDNUQsTUFBTSxPQUFPO0FBQUEsSUFDYixLQUFLLE9BQU87QUFBQSxJQUNaLEtBQUssT0FBTztBQUFBLElBQ1osS0FBSyxRQUFRO0FBQUE7QUFBQSxNQUdYLFFBQVEsR0FBVztBQUFBLElBQ3JCLE9BQU8sU0FBUyxLQUFLO0FBQUE7QUFFekI7QUFLTyxTQUFTLEdBQUcsQ0FBQyxTQUFpQixPQUFnQixTQUFTLE9BQXlCO0FBQUEsRUFDckYsTUFBTSxJQUFJLFNBQVMsTUFBTSxTQUFTLEtBQUs7QUFBQTtBQVNsQyxTQUFTLGNBQWMsQ0FDNUIsR0FDQSxNQUF5QyxRQUFRLFFBQ2xDO0FBQUEsRUFDZixJQUFJLEVBQUUsYUFBYTtBQUFBLElBQVcsT0FBTztBQUFBLEVBQ3JDLElBQUksTUFBTSxjQUFjLEVBQUUsTUFBTSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUM7QUFBQSxFQUNuRCxPQUFPLEVBQUU7QUFBQTs7O0FGK0VYLElBQU0sZUFBZTtBQUFBLEVBQ25CLEVBQUUsTUFBTSxVQUFVLE1BQU0sT0FBTztBQUFBLEVBQy9CLEVBQUUsTUFBTSxNQUFNLE1BQU0sT0FBTztBQUFBLEVBQzNCLEVBQUUsTUFBTSxhQUFhLE1BQU0sVUFBVTtBQUFBLEVBQ3JDLEVBQUUsTUFBTSxNQUFNLE1BQU0sVUFBVTtBQUNoQztBQUlBLElBQU0sc0JBQXNCLGFBQWEsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FDMUQsQ0FBQyxHQUFHLE1BQU0sT0FBTyxFQUFFLFdBQVcsSUFBSSxDQUFDLElBQUksT0FBTyxFQUFFLFdBQVcsSUFBSSxDQUFDLENBQ2xFO0FBRUEsSUFBTSxVQUFVLENBQUMsTUFDZixLQUFLLE9BQU8sTUFBTSxhQUFZLFVBQVUsS0FBSSxPQUFRLEVBQXdCLElBQUksSUFBSTtBQUN0RixJQUFNLGFBQWEsQ0FBQyxNQUF3QixhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUU5RSxTQUFTLFNBQXVDLENBQUMsTUFBdUI7QUFBQSxFQUM3RSxNQUFNLFVBQVUsS0FBSztBQUFBLEVBQ3JCLE1BQU0sYUFBYSxPQUFPLEtBQUssS0FBSyxPQUFPO0FBQUEsRUFDM0MsTUFBTSxRQUFRLElBQUksSUFBSSxVQUFVO0FBQUEsRUFDaEMsTUFBTSxVQUFVLEtBQUssV0FBVztBQUFBLEVBQ2hDLE1BQU0sVUFBVSxDQUFDLEdBQUksS0FBSyxlQUFlLENBQUMsQ0FBRTtBQUFBLEVBQzVDLE1BQU0sUUFBUSxJQUFJLElBQWEsS0FBSyxjQUFjLENBQUMsQ0FBYztBQUFBLEVBRWpFLFdBQVcsS0FBSyxTQUFTO0FBQUEsSUFDdkIsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDO0FBQUEsTUFDZCxNQUFNLElBQUksTUFBTSxhQUFhLDBCQUEwQixzQkFBc0I7QUFBQSxFQUNqRjtBQUFBLEVBQ0EsS0FBSyxLQUFLLFVBQVUsVUFBVSxPQUFPLEtBQUssS0FBSyxTQUFTLFdBQVc7QUFBQSxJQUNqRSxNQUFNLElBQUksTUFBTSxhQUFhLDBDQUEwQztBQUFBLEVBQ3pFO0FBQUEsRUFJQSxNQUFNLGVBQWUsT0FBTyxZQUMxQixXQUFXLElBQUksQ0FBQyxNQUFNO0FBQUEsSUFDcEIsUUFBUSxTQUFTLE9BQU8sU0FBUyxLQUFLLFFBQVE7QUFBQSxJQUM5QyxPQUFPLENBQUMsR0FBRyxJQUFJO0FBQUEsR0FDaEIsQ0FDSDtBQUFBLEVBQ0EsTUFBTSxhQUFhLElBQUk7QUFBQSxFQUN2QixXQUFXLEtBQUssWUFBWTtBQUFBLElBQzFCLE1BQU0sSUFBSSxLQUFLLFFBQVEsSUFBSTtBQUFBLElBQzNCLElBQUksTUFBTTtBQUFBLE1BQVcsV0FBVyxJQUFJLEdBQUcsQ0FBQztBQUFBLEVBQzFDO0FBQUEsRUFFQSxNQUFNLGFBQWEsQ0FBQyxRQUFxQztBQUFBLElBQ3ZELE1BQU0sTUFBTSxJQUFJLElBQUksQ0FBQyxHQUFHLFNBQVMsR0FBRyxHQUFHLENBQUM7QUFBQSxJQUN4QyxPQUFPLFdBQVcsT0FBTyxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsQ0FBQztBQUFBO0FBQUEsRUFHNUMsTUFBTSxRQUFRLENBQ1osR0FDQSxTQUNRO0FBQUEsSUFDUixXQUFXLEtBQUssRUFBRSxPQUFPO0FBQUEsTUFDdkIsSUFBSSxDQUFDLE1BQU0sSUFBSSxDQUFDLEdBQUc7QUFBQSxRQUNqQixNQUFNLElBQUksTUFBTSxhQUFhLGtCQUFrQixFQUFFLHFCQUFxQixvQkFBb0I7QUFBQSxNQUM1RjtBQUFBLElBQ0Y7QUFBQSxJQUNBLE9BQU87QUFBQSxNQUNMLE1BQU0sRUFBRTtBQUFBLE1BQ1IsU0FBUyxDQUFDLEdBQUksRUFBRSxXQUFXLENBQUMsQ0FBRTtBQUFBLE1BQzlCLE9BQU8sQ0FBQyxHQUFHLEVBQUUsS0FBSztBQUFBLE1BQ2xCLFVBQVUsV0FBVyxFQUFFLEtBQUs7QUFBQSxNQUM1QixhQUFhLEVBQUUsWUFBWSxJQUFJLENBQUMsT0FBTyxLQUFLLEVBQUUsRUFBRTtBQUFBLE1BQ2hELFVBQVUsRUFBRTtBQUFBLE1BQ1o7QUFBQSxNQUNBLFlBQVksRUFBRTtBQUFBLE1BQ2Qsa0JBQWtCLEVBQUUsb0JBQW9CO0FBQUEsTUFDeEMsT0FBTyxFQUFFO0FBQUEsTUFDVCxLQUFLLEVBQUU7QUFBQSxJQUNUO0FBQUE7QUFBQSxFQUdGLE1BQU0sUUFBZSxLQUFLLFlBQVksQ0FBQyxHQUFHLElBQUksQ0FBQyxNQUFNLE1BQU0sR0FBa0IsS0FBSyxDQUFDO0FBQUEsRUFHbkYsTUFBTSxNQUFNLENBQUM7QUFBQSxFQUNiLE1BQU0sV0FBMEI7QUFBQSxJQUM5QjtBQUFBLE1BQ0UsTUFBTTtBQUFBLE1BQ04sT0FBTyxDQUFDO0FBQUEsTUFDUixhQUFhLENBQUM7QUFBQSxNQUNkLFVBQVU7QUFBQSxNQUNWLEtBQUssWUFBWTtBQUFBLFFBQ2YsVUFBVSxNQUFNLEtBQUssUUFBUSxDQUFDO0FBQUE7QUFBQSxJQUVsQztBQUFBLElBQ0E7QUFBQSxNQUNFLE1BQU07QUFBQSxNQUNOLE9BQU8sQ0FBQztBQUFBLE1BQ1IsYUFBYSxDQUFDO0FBQUEsTUFDZCxVQUFVO0FBQUEsTUFDVixLQUFLLE1BQU07QUFBQSxRQUNULFFBQVEsT0FBTyxNQUFNLEdBQUcsS0FBSyxVQUFVLElBQUksWUFBWSxHQUFHLE1BQU0sQ0FBQztBQUFBLENBQUs7QUFBQTtBQUFBLElBRTFFO0FBQUEsSUFDQTtBQUFBLE1BQ0UsTUFBTTtBQUFBLE1BQ04sT0FBTyxDQUFDO0FBQUEsTUFDUixhQUFhLENBQUM7QUFBQSxNQUNkLFVBQVU7QUFBQSxNQUNWLEtBQUssTUFBTTtBQUFBLFFBQ1QsTUFBTSxPQUFPLElBQUksV0FBVztBQUFBLFFBQzVCLFFBQVEsT0FBTyxNQUFNLEtBQUssU0FBUztBQUFBLENBQUksSUFBSSxPQUFPLEdBQUc7QUFBQSxDQUFRO0FBQUE7QUFBQSxJQUVqRTtBQUFBLEVBQ0Y7QUFBQSxFQUNBLFdBQVcsS0FBSyxVQUFVO0FBQUEsSUFDeEIsSUFBSSxDQUFDLEtBQUssS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLEVBQUUsSUFBSTtBQUFBLE1BQUcsS0FBSyxLQUFLLE1BQU0sR0FBRyxJQUFJLENBQUM7QUFBQSxFQUNwRTtBQUFBLEVBRUEsTUFBTSxVQUNKLEtBQUssU0FBUyxZQUFZLFlBQVksTUFBTSxLQUFNLEtBQUssTUFBbUIsTUFBTSxHQUFHLEdBQUcsS0FBSztBQUFBLEVBRzdGLE1BQU0sVUFBVSxJQUFJO0FBQUEsRUFDcEIsV0FBVyxLQUFLLE1BQU07QUFBQSxJQUNwQixXQUFXLEtBQUssQ0FBQyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sR0FBRztBQUFBLE1BQ3RDLE1BQU0sUUFBUSxFQUFFLE1BQU0sR0FBRztBQUFBLE1BQ3pCLElBQUksRUFBRSxLQUFLLE1BQU0sS0FBSyxNQUFNLFNBQVMsS0FBSyxNQUFNLEtBQUssQ0FBQyxNQUFNLE1BQU0sTUFBTSxFQUFFLFdBQVcsR0FBRyxDQUFDLEdBQUc7QUFBQSxRQUMxRixNQUFNLElBQUksTUFBTSxhQUFhLCtCQUErQixJQUFJO0FBQUEsTUFDbEU7QUFBQSxNQUNBLElBQUksTUFBTSxFQUFFLFFBQVEsTUFBTSxXQUFXLEVBQUUsS0FBSyxNQUFNLEdBQUcsRUFBRSxRQUFRO0FBQUEsUUFDN0QsTUFBTSxJQUFJLE1BQU0sYUFBYSxvQkFBb0Isc0JBQXNCLEVBQUUsT0FBTztBQUFBLE1BQ2xGO0FBQUEsTUFDQSxJQUFJLE1BQU0sV0FBVyxLQUFLLE1BQU0sRUFBRSxRQUFRLE1BQU0sT0FBTyxFQUFFLEtBQUssTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUFBLFFBQzNFLE1BQU0sSUFBSSxNQUFNLGFBQWEsb0JBQW9CLCtCQUErQixFQUFFLE9BQU87QUFBQSxNQUMzRjtBQUFBLE1BQ0EsSUFBSSxRQUFRLElBQUksQ0FBQztBQUFBLFFBQUcsTUFBTSxJQUFJLE1BQU0sYUFBYSxjQUFjLHFCQUFxQjtBQUFBLE1BQ3BGLFFBQVEsSUFBSSxHQUFHLENBQUM7QUFBQSxJQUNsQjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLE1BQU0sU0FBUyxJQUFJO0FBQUEsRUFDbkIsV0FBVyxLQUFLLFFBQVEsS0FBSyxHQUFHO0FBQUEsSUFDOUIsT0FBTyxPQUFPLE9BQU8sRUFBRSxNQUFNLEdBQUc7QUFBQSxJQUNoQyxJQUFJLFVBQVUsYUFBYSxRQUFRLFdBQVc7QUFBQSxNQUM1QyxPQUFPLElBQUksT0FBTyxDQUFDLEdBQUksT0FBTyxJQUFJLEtBQUssS0FBSyxDQUFDLEdBQUksR0FBRyxDQUFDO0FBQUEsSUFDdkQ7QUFBQSxFQUNGO0FBQUEsRUFDQSxXQUFXLEtBQUssT0FBTyxLQUFLLEtBQUssVUFBVSxDQUFDLENBQUMsR0FBRztBQUFBLElBQzlDLElBQUksQ0FBQyxPQUFPLElBQUksQ0FBQztBQUFBLE1BQUcsTUFBTSxJQUFJLE1BQU0sYUFBYSxvQkFBb0IscUJBQXFCO0FBQUEsRUFDNUY7QUFBQSxFQUVBLE1BQU0sUUFBUSxDQUFDLEdBQUcsUUFBUSxLQUFLLENBQUM7QUFBQSxFQUNoQyxNQUFNLFFBQVEsQ0FBQyxHQUFHLElBQUksSUFBSSxNQUFNLElBQUksQ0FBQyxNQUFNLEVBQUUsTUFBTSxHQUFHLEVBQUUsRUFBWSxDQUFDLENBQUM7QUFBQSxFQUV0RSxNQUFNLFNBQVMsQ0FBQyxTQUFtQyxTQUFTLEtBQUssVUFBVSxRQUFRLElBQUksSUFBSTtBQUFBLEVBQzNGLE1BQU0sV0FBVyxDQUFDLFNBQ2hCLENBQUMsR0FBSSxPQUFPLElBQUksR0FBRyxZQUFZLENBQUMsQ0FBRSxFQUFFLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRyxFQUFFLEtBQUs7QUFBQSxFQUNoRSxNQUFNLFFBQVEsQ0FBQyxNQUFtQixFQUFFLFFBQVE7QUFBQSxFQVc1QyxNQUFNLGVBQXlCLE1BQU07QUFBQSxJQUNuQyxNQUFNLE1BQU0sQ0FBQyxHQUFHLFNBQVMsRUFBRSxHQUFHLEdBQUcsbUJBQW1CO0FBQUEsSUFDcEQsTUFBTSxPQUFPLElBQUksT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLElBQUksQ0FBQyxFQUFFLEtBQUs7QUFBQSxJQUN4RCxPQUFPLENBQUMsR0FBRyxNQUFNLEdBQUcsSUFBSSxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsV0FBVyxJQUFJLENBQUMsQ0FBQztBQUFBLEtBQ3pEO0FBQUEsRUFJSCxNQUFNLG1CQUFtQixDQUFDLE1BQThCO0FBQUEsSUFDdEQsTUFBTSxRQUFRLEVBQUUsV0FBVyxHQUFHLEVBQUUsWUFBWSxFQUFFO0FBQUEsSUFDOUMsT0FBTyxFQUFFLFdBQVcsSUFBSSxXQUFXLElBQUk7QUFBQTtBQUFBLEVBRXpDLE1BQU0sYUFBYSxDQUFDLE1BQ2xCLEtBQUssUUFBUSxJQUFJLFNBQVMsWUFBWSxNQUFNLE9BQU8sTUFBTTtBQUFBLEVBQzNELE1BQU0sWUFBWSxDQUFDLE1BQ2pCO0FBQUEsSUFDRSxNQUFNLENBQUM7QUFBQSxJQUNQLEdBQUcsRUFBRSxZQUFZLElBQUksZ0JBQWdCO0FBQUEsSUFDckMsR0FBRyxFQUFFLE1BQU0sT0FBTyxDQUFDLE1BQU0sQ0FBQyxNQUFNLElBQUksQ0FBQyxDQUFDLEVBQUUsSUFBSSxVQUFVO0FBQUEsRUFDeEQsRUFBRSxLQUFLLEdBQUc7QUFBQSxFQUNaLE1BQU0sVUFBVSxDQUFDLE1BQW1CLFlBQVksVUFBVSxDQUFDO0FBQUEsRUFFM0QsTUFBTSxhQUFhLE1BQWM7QUFBQSxJQUMvQixJQUFJLEtBQUssU0FBUztBQUFBLE1BQVcsT0FBTyxLQUFLLEtBQUs7QUFBQSxJQUM5QyxNQUFNLFNBQVMsQ0FBQyxHQUFJLFVBQVUsQ0FBQyxPQUFPLElBQUksQ0FBQyxHQUFJLEdBQUcsSUFBSTtBQUFBLElBQ3RELE1BQU0sUUFBUSxPQUFPLElBQUksQ0FBQyxNQUFNLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxRQUFRLENBQVU7QUFBQSxJQUNuRSxNQUFNLFFBQVEsS0FBSyxJQUFJLEtBQUssSUFBSSxHQUFHLE1BQU0sSUFBSSxFQUFFLE9BQU8sRUFBRSxNQUFNLENBQUMsR0FBRyxFQUFFO0FBQUEsSUFDcEUsTUFBTSxPQUFPLE1BQ1YsSUFBSSxFQUFFLEdBQUcsT0FDUixFQUFFLFVBQVUsUUFBUSxLQUFLLEVBQUUsT0FBTyxLQUFLLE1BQU0sTUFBTSxLQUFLO0FBQUEsSUFBUSxHQUFHLE9BQU8sS0FBSyxNQUFNLEdBQ3ZGLEVBQ0MsS0FBSztBQUFBLENBQUk7QUFBQSxJQUNaLE1BQU0sT0FBTyxLQUFLLFVBQVUsR0FBRyxrQkFBYSxLQUFLLFlBQVk7QUFBQSxJQUM3RCxNQUFNLFNBQVMsS0FBSyxhQUFhLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxFQUFFLEtBQUssS0FBSztBQUFBLElBQzlELE9BQU8sR0FBRztBQUFBO0FBQUEsRUFBVztBQUFBLEVBQVMsU0FBUyxLQUFLLGFBQWE7QUFBQTtBQUFBLEVBQU8sS0FBSyxlQUFlO0FBQUE7QUFBQSxFQUt0RixNQUFNLGNBQWMsTUFBbUI7QUFBQSxJQUNyQyxNQUFNLE1BQU0sQ0FBQyxPQUE0QjtBQUFBLE1BQ3ZDLE1BQU0sS0FBSztBQUFBLE1BQ1gsTUFBTyxLQUFLLFFBQVEsR0FBa0I7QUFBQSxNQUN0QyxRQUFRO0FBQUEsSUFDVjtBQUFBLElBQ0EsTUFBTSxXQUE4QjtBQUFBLE1BQ2xDO0FBQUEsUUFDRSxNQUFNLENBQUM7QUFBQSxRQUNQLE1BQU07QUFBQSxVQUNKLEdBQUcsYUFBYSxJQUFJLENBQUMsT0FBTztBQUFBLFlBQzFCLE1BQU0sRUFBRTtBQUFBLFlBQ1IsTUFBTTtBQUFBLFlBQ04sUUFBUTtBQUFBLFVBQ1YsRUFBRTtBQUFBLFVBQ0YsR0FBSSxVQUFVLFFBQVEsU0FBUyxJQUFJLEdBQUcsSUFBSSxDQUFDO0FBQUEsUUFDN0M7QUFBQSxRQUNBLGFBQWEsVUFDVCxRQUFRLFlBQVksSUFBSSxDQUFDLE9BQU8sS0FBSyxFQUFFLEVBQUUsSUFDekMsQ0FBQyxFQUFFLE1BQU0sS0FBSyxrQkFBa0IsV0FBVyxVQUFVLEtBQUssQ0FBQztBQUFBLE1BQ2pFO0FBQUEsSUFDRjtBQUFBLElBQ0EsV0FBVyxLQUFLLE1BQU07QUFBQSxNQUNwQixXQUFXLEtBQUssQ0FBQyxFQUFFLE1BQU0sR0FBRyxFQUFFLE9BQU8sR0FBRztBQUFBLFFBQ3RDLFNBQVMsS0FBSztBQUFBLFVBQ1osTUFBTSxFQUFFLE1BQU0sR0FBRztBQUFBLFVBQ2pCLE1BQU0sRUFBRSxTQUFTLElBQUksR0FBRztBQUFBLFVBQ3hCLGFBQWEsRUFBRSxZQUFZLElBQUksQ0FBQyxPQUFPLEtBQUssRUFBRSxFQUFFO0FBQUEsUUFDbEQsQ0FBQztBQUFBLE1BQ0g7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLFlBQVksUUFBUSxJQUFJLFFBQVE7QUFBQSxJQUN0QyxPQUFPO0FBQUEsTUFDTCxlQUFlO0FBQUEsTUFDZixZQUFZO0FBQUEsTUFDWixpQkFBaUIsRUFBRSxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUU7QUFBQSxNQUMxQztBQUFBLElBQ0Y7QUFBQTtBQUFBLEVBV0YsTUFBTSxpQkFBaUIsQ0FBQyxNQUFnQixxQkFBc0M7QUFBQSxJQUM1RSxTQUFTLElBQUksRUFBRyxJQUFJLEtBQUssUUFBUSxLQUFLO0FBQUEsTUFDcEMsTUFBTSxJQUFJLEtBQUs7QUFBQSxNQUNmLElBQUksTUFBTTtBQUFBLFFBQU0sT0FBTyxvQkFBb0IsSUFBSSxLQUFLLEtBQUssU0FBUyxLQUFLLElBQUk7QUFBQSxNQUMzRSxJQUFJLEVBQUUsV0FBVyxJQUFJLEdBQUc7QUFBQSxRQUN0QixJQUFJLEVBQUUsU0FBUyxHQUFHO0FBQUEsVUFBRztBQUFBLFFBQ3JCLElBQUksS0FBSyxRQUFRLEVBQUUsTUFBTSxDQUFDLElBQUksU0FBUztBQUFBLFVBQVU7QUFBQSxRQUNqRDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLElBQUksRUFBRSxXQUFXLEdBQUcsS0FBSyxFQUFFLFNBQVMsR0FBRztBQUFBLFFBQ3JDLE1BQU0sTUFBTSxFQUFFLFdBQVcsSUFBSSxXQUFXLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQyxJQUFJO0FBQUEsUUFDMUQsSUFBSSxRQUFRLGFBQWEsS0FBSyxRQUFRLE1BQU0sU0FBUztBQUFBLFVBQVU7QUFBQSxRQUMvRDtBQUFBLE1BQ0Y7QUFBQSxNQUNBLE9BQU87QUFBQSxJQUNUO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUdULE1BQU0sVUFBVSxDQUFDLE1BQWdCLE1BQXdCO0FBQUEsSUFDdkQsR0FBRyxLQUFLLE1BQU0sR0FBRyxDQUFDO0FBQUEsSUFDbEIsR0FBRyxLQUFLLE1BQU0sSUFBSSxDQUFDO0FBQUEsRUFDckI7QUFBQSxFQUVBLE1BQU0sWUFBWSxNQUNoQixJQUFJLHNCQUFzQixTQUFTO0FBQUEsSUFDakMsU0FBUyxDQUFDLEdBQUcsS0FBSztBQUFBLElBQ2xCLE1BQU0sU0FBUztBQUFBLEVBQ2pCLENBQUM7QUFBQSxFQUdILE1BQU0sVUFBVSxDQUFDLE1BQWMsU0FBZ0U7QUFBQSxJQUM3RixNQUFNLE9BQU8sT0FBTyxJQUFJLElBQUk7QUFBQSxJQUM1QixJQUFJLFNBQVMsV0FBVztBQUFBLE1BQ3RCLE1BQU0sS0FBSyxLQUFLLFNBQVMsT0FBTyxhQUFhO0FBQUEsTUFDN0MsSUFBSSxJQUFJO0FBQUEsTUFDUixJQUFJLE9BQU8sWUFBWTtBQUFBLFFBQ3JCLE1BQU0sT0FBTyxLQUFLO0FBQUEsUUFDbEIsSUFBSSxTQUFTLGFBQWEsQ0FBQyxLQUFLLFdBQVcsR0FBRyxJQUFJLElBQUk7QUFBQSxNQUN4RCxFQUFPO0FBQUEsUUFDTCxJQUFJLGVBQWUsTUFBTSxJQUFJO0FBQUE7QUFBQSxNQUUvQixNQUFNLE1BQU0sS0FBSyxJQUFLLEtBQUssS0FBZ0I7QUFBQSxNQUMzQyxNQUFNLE9BQU8sUUFBUSxZQUFZLFlBQVksUUFBUSxJQUFJLEdBQUcsUUFBUSxLQUFLO0FBQUEsTUFDekUsSUFBSSxTQUFTLGFBQWEsUUFBUSxXQUFXO0FBQUEsUUFDM0MsT0FBTyxFQUFFLEtBQUssTUFBTSxPQUFPLEdBQUcsUUFBUSxPQUFPLE1BQU0sUUFBUSxNQUFNLENBQUMsRUFBRTtBQUFBLE1BQ3RFO0FBQUEsTUFDQSxNQUFNLE1BQU0sUUFBUSxJQUFJLElBQUk7QUFBQSxNQUM1QixJQUFJLFFBQVE7QUFBQSxRQUFXLE9BQU8sRUFBRSxLQUFLLEtBQUssT0FBTyxNQUFNLE1BQU0sS0FBSztBQUFBLE1BQ2xFLE1BQU0sUUFBUSxFQUFFLFNBQVMsQ0FBQyxHQUFHLElBQUksR0FBRyxNQUFNLFNBQVMsMkJBQTJCO0FBQUEsTUFDOUUsSUFBSSxRQUFRO0FBQUEsUUFBVyxJQUFJLEdBQUcsZ0NBQWdDLFNBQVMsS0FBSztBQUFBLE1BQzVFLElBQUksV0FBVyxzQkFBc0IsUUFBUSxTQUFTLEtBQUs7QUFBQSxJQUM3RDtBQUFBLElBQ0EsTUFBTSxNQUFNLFFBQVEsSUFBSSxJQUFJO0FBQUEsSUFDNUIsSUFBSSxRQUFRLFdBQVc7QUFBQSxNQUNyQixJQUFJLG9CQUFvQixTQUFTLFNBQVM7QUFBQSxRQUN4QyxTQUFTLENBQUMsR0FBRyxLQUFLO0FBQUEsUUFDbEIsTUFBTSxTQUFTO0FBQUEsTUFDakIsQ0FBQztBQUFBLElBQ0g7QUFBQSxJQUNBLE9BQU8sRUFBRSxLQUFLLE9BQU8sTUFBTSxNQUFNLEtBQUs7QUFBQTtBQUFBLEVBaUJ4QyxNQUFNLGNBQWMsQ0FDbEIsS0FDQSxVQUNBLFdBQ1M7QUFBQSxJQUNULE1BQU0sTUFBTSxRQUFRLFVBQVUsQ0FBQyxNQUFNLEVBQUUsU0FBUyxtQkFBbUIsS0FBSztBQUFBLElBQ3hFLElBQUksV0FBVyxhQUFhLE1BQU07QUFBQSxNQUFHO0FBQUEsSUFDckMsTUFBTSxVQUFvQixDQUFDO0FBQUEsSUFDM0IsV0FBVyxLQUFLLE9BQU8sTUFBTSxNQUFNLENBQUMsR0FBRztBQUFBLE1BQ3JDLElBQUksRUFBRSxTQUFTO0FBQUEsUUFBYztBQUFBLE1BQzdCLE1BQU0sSUFBSSxFQUFFO0FBQUEsTUFDWixJQUFJO0FBQUEsTUFDSixJQUFJLEVBQUUsV0FBVyxJQUFJO0FBQUEsUUFBRyxNQUFNLEVBQUUsTUFBTSxDQUFDLEVBQUUsTUFBTSxHQUFHLEVBQUU7QUFBQSxNQUMvQyxTQUFJLEVBQUUsV0FBVyxLQUFLLEVBQUUsV0FBVyxHQUFHO0FBQUEsUUFBRyxNQUFNLFdBQVcsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDN0UsSUFBSSxRQUFRLGFBQWEsUUFBUSxNQUFNLFNBQVMsSUFBSSxHQUFHO0FBQUEsUUFBRyxRQUFRLEtBQUssQ0FBQztBQUFBLElBQzFFO0FBQUEsSUFDQSxJQUFJLFFBQVEsV0FBVztBQUFBLE1BQUc7QUFBQSxJQUMxQixNQUFNLFFBQVEsUUFBUSxLQUFLLElBQUk7QUFBQSxJQUMvQixNQUFNLE1BQU0sUUFBUSxXQUFXO0FBQUEsSUFDL0IsTUFBTSxLQUFLLE1BQU0sT0FBTztBQUFBLElBQ3hCLE1BQU0sTUFBTSxNQUFNLFFBQVE7QUFBQSxJQUMxQixNQUFNLFNBQVMsTUFBTSxjQUFjO0FBQUEsSUFDbkMsUUFBUSxPQUFPLE1BQ2IsY0FBYyxVQUFVLElBQUksU0FBUyxLQUFLLEtBQUssSUFBSSxJQUFJLFdBQVcsc0JBQXNCLHlCQUF5QixrQkFBa0IsTUFBTSxnQkFBZ0I7QUFBQSxDQUMzSjtBQUFBO0FBQUEsRUFHRixNQUFNLFNBQVMsT0FBTyxLQUFVLE9BQWUsU0FBb0M7QUFBQSxJQUNqRixrQkFBa0IsSUFBSSxTQUFTLEtBQUssT0FBTyxJQUFJLElBQUk7QUFBQSxJQUNuRCxNQUFNLE9BQU8sTUFBTSxHQUFHO0FBQUEsSUFDdEIsTUFBTSxXQUFXLElBQUksSUFBSSxJQUFJLFFBQVE7QUFBQSxJQUNyQyxNQUFNLFVBQVUsSUFBSSxTQUFTLEtBQUssY0FBYyxTQUFTLElBQUksSUFBSTtBQUFBLElBQ2pFLE1BQU0sV0FBVyxNQUNmLENBQUMsSUFBSSxZQUFZLFFBQVEsV0FBVyxJQUFJLEdBQUcsd0JBQXdCLFNBQVMsRUFDekUsT0FBTyxDQUFDLE1BQW1CLE1BQU0sU0FBUyxFQUMxQyxLQUFLLElBQUksS0FBSztBQUFBLElBRW5CLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxPQUNELEVBQUUsUUFBUSxhQUFhLE9BQU8sSUFBSSxVQUFVO0FBQUEsUUFDM0M7QUFBQSxRQUNBLFNBQVM7QUFBQSxRQUNULFFBQVE7QUFBQSxRQUNSLGtCQUFrQixJQUFJO0FBQUEsUUFDdEIsUUFBUTtBQUFBLE1BQ1YsQ0FBQztBQUFBLE1BQ0QsT0FBTyxHQUFHO0FBQUEsTUFDVixJQUFJLFFBQVEsQ0FBQyxNQUFNLGlDQUFpQztBQUFBLFFBQ2xELElBQUksR0FBRyxTQUFTLFdBQVcsQ0FBQyxLQUFLLFNBQVMsRUFBRSxTQUFTLE1BQU0sU0FBUyxFQUFFLENBQUM7QUFBQSxNQUN6RTtBQUFBLE1BRUEsSUFBSSxHQUFHLFNBQVMsV0FBVyxDQUFDLEtBQUssU0FBUyxFQUFFLE1BQU0sSUFBSSxjQUFjLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFBQTtBQUFBLElBS3BGLE1BQU0sUUFBUSxPQUFPLEtBQUssTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsU0FBUyxJQUFJLENBQUMsQ0FBQztBQUFBLElBQzlELElBQUksVUFBVSxXQUFXO0FBQUEsTUFDdkIsSUFDRSxLQUFLLDhCQUE4Qiw4QkFBOEIsK0JBQStCLElBQUksU0FBUyxLQUFLLFlBQVksYUFDOUgsU0FDQSxFQUFFLFNBQVMsTUFBTSxTQUFTLEVBQUUsQ0FDOUI7QUFBQSxJQUNGO0FBQUEsSUFHQSxNQUFNLFdBQVcsSUFBSSxZQUFZLE9BQU8sQ0FBQyxNQUFNLEVBQUUsUUFBUSxFQUFFO0FBQUEsSUFDM0QsTUFBTSxXQUFXLElBQUksWUFBWSxLQUFLLENBQUMsTUFBTSxFQUFFLFFBQVE7QUFBQSxJQUN2RCxJQUFJLFlBQVksU0FBUyxVQUFVO0FBQUEsTUFDakMsTUFBTSxVQUFVLElBQUksWUFBWSxZQUFZO0FBQUEsTUFDNUMsSUFBSSxHQUFHLDJCQUEyQixTQUFTLFFBQVEsZUFBZSxTQUFTO0FBQUEsUUFDekUsTUFBTSxRQUFRLEdBQUc7QUFBQSxNQUNuQixDQUFDO0FBQUEsSUFDSDtBQUFBLElBQ0EsSUFBSSxDQUFDLFlBQVksWUFBWSxTQUFTLElBQUksWUFBWSxRQUFRO0FBQUEsTUFDNUQsSUFDRSxHQUFHLDZCQUE2QixLQUFLLFVBQVUsWUFBWSxJQUFJLFlBQVksT0FBTyxLQUNsRixTQUNBLEVBQUUsTUFBTSxJQUFJLFlBQVksV0FBVyxJQUFJLEdBQUcsNEJBQTRCLFFBQVEsR0FBRyxFQUFFLENBQ3JGO0FBQUEsSUFDRjtBQUFBLElBR0EsTUFBTSxRQUFtQyxLQUFNLE9BQXFDO0FBQUEsSUFDcEYsV0FBVyxLQUFLLElBQUksVUFBVTtBQUFBLE1BQzVCLE1BQU0sSUFBSyxLQUFLLFFBQVEsR0FBa0I7QUFBQSxNQUMxQyxJQUFJLE1BQU0sT0FBTyxhQUFhLE1BQU0sV0FBVztBQUFBLFFBQzdDLE1BQU0sS0FBTSxNQUFNLFFBQVEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUk7QUFBQSxNQUMxQztBQUFBLElBQ0Y7QUFBQSxJQUVBLE1BQU0sTUFBa0IsRUFBRSxNQUFNLElBQUksTUFBTSxPQUFPLEtBQUssYUFBYSxNQUFNO0FBQUEsSUFDekUsTUFBTSxVQUFVLElBQUksUUFBUSxHQUFHO0FBQUEsSUFDL0IsSUFBSSxZQUFZO0FBQUEsTUFBVyxJQUFJLEdBQUcsU0FBUyxXQUFXLFNBQVMsRUFBRSxNQUFNLFFBQVEsR0FBRyxFQUFFLENBQUM7QUFBQSxJQUVyRixZQUFZLEtBQUssVUFBVSxNQUFNO0FBQUEsSUFDakMsTUFBTSxNQUFNLE1BQU0sSUFBSSxJQUFJLEdBQUc7QUFBQSxJQUM3QixPQUFPLE9BQU8sUUFBUSxXQUFXLE1BQU07QUFBQTtBQUFBLEVBR3pDLE1BQU0sV0FBVyxPQUFPLFNBQW9DO0FBQUEsSUFDMUQsa0JBQWtCLEtBQUssTUFBTSxJQUFJO0FBQUEsSUFDakMsTUFBTSxRQUFRLEtBQUs7QUFBQSxJQUduQixNQUFNLGNBQWMsYUFBYSxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsS0FBSztBQUFBLElBQzdELElBQUksZ0JBQWdCLFdBQVc7QUFBQSxNQUM3QixPQUFPLE9BQU8sUUFBUSxJQUFJLFlBQVksSUFBSSxHQUFVLFlBQVksTUFBTSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsSUFDckY7QUFBQSxJQUdBLElBQUksWUFBWSxXQUFXO0FBQUEsTUFDekIsSUFBSSxVQUFVLGNBQWMsUUFBUSxJQUFJLEtBQUssS0FBSyxPQUFPLElBQUksS0FBSyxJQUFJO0FBQUEsUUFDcEUsTUFBTSxLQUFJLFFBQVEsT0FBTyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsUUFDdEMsT0FBTyxPQUFPLEdBQUUsS0FBSyxHQUFFLE9BQU8sR0FBRSxJQUFJO0FBQUEsTUFDdEM7QUFBQSxNQUNBLE9BQU8sT0FBTyxTQUFTLElBQUksSUFBSTtBQUFBLElBQ2pDO0FBQUEsSUFHQSxJQUFJLFVBQVU7QUFBQSxNQUFXLE9BQU8sVUFBVTtBQUFBLElBRzFDLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxJQUNKLElBQUksWUFBWSxjQUFjO0FBQUEsTUFDNUIsSUFBSSxVQUFVLE1BQU07QUFBQSxRQUNsQixJQUFJLEtBQUssT0FBTztBQUFBLFVBQVcsT0FBTyxVQUFVO0FBQUEsUUFDNUMsT0FBTyxLQUFLO0FBQUEsUUFDWixPQUFPLENBQUMsTUFBTSxHQUFHLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQSxNQUNoQyxFQUFPLFNBQUksTUFBTSxXQUFXLEdBQUcsR0FBRztBQUFBLFFBQ2hDLE9BQU8sSUFBSSw2QkFBNkIsU0FBUyxTQUFTO0FBQUEsVUFDeEQsU0FBUyxDQUFDLEdBQUcsbUJBQW1CO0FBQUEsVUFDaEMsTUFBTSx3Q0FBd0MsTUFBTSxLQUFLLEdBQUc7QUFBQSxRQUM5RCxDQUFDO0FBQUEsTUFDSCxFQUFPO0FBQUEsUUFDTCxPQUFPO0FBQUEsUUFDUCxPQUFPLEtBQUssTUFBTSxDQUFDO0FBQUE7QUFBQSxJQUV2QixFQUFPO0FBQUEsTUFDTCxNQUFNLElBQUksZUFBZSxNQUFNLEtBQUs7QUFBQSxNQUNwQyxJQUFJLElBQUksR0FBRztBQUFBLFFBS1Qsa0JBQWtCLElBQUk7QUFBQSxRQUN0QixJQUFJO0FBQUEsVUFDRixVQUFVLEVBQUUsTUFBTSxNQUFNLFNBQVMsY0FBYyxRQUFRLE1BQU0sa0JBQWtCLEtBQUssQ0FBQztBQUFBLFVBQ3JGLE9BQU8sR0FBRztBQUFBLFVBQ1YsSUFBSSxXQUFXLENBQUMsR0FBRyxTQUFTO0FBQUEsWUFDMUIsU0FBUyxDQUFDLEdBQUcsbUJBQW1CO0FBQUEsWUFDaEMsTUFBTSxxQ0FBZ0MsTUFBTSxLQUFLLEdBQUcsV0FBVztBQUFBLFVBQ2pFLENBQUM7QUFBQTtBQUFBLFFBRUgsT0FBTyxVQUFVO0FBQUEsTUFDbkI7QUFBQSxNQUNBLE9BQU8sS0FBSztBQUFBLE1BR1osT0FBTyxRQUFRLE1BQU0sQ0FBQztBQUFBO0FBQUEsSUFFeEIsa0JBQWtCLElBQUk7QUFBQSxJQUN0QixNQUFNLElBQUksUUFBUSxNQUFNLElBQUk7QUFBQSxJQUM1QixPQUFPLE9BQU8sRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLElBQUk7QUFBQTtBQUFBLEVBR3RDLE1BQU0sT0FBTyxPQUFPLFNBQW9DO0FBQUEsSUFDdEQsSUFBSTtBQUFBLE1BQ0YsT0FBTyxNQUFNLFNBQVMsSUFBSTtBQUFBLE1BQzFCLE9BQU8sR0FBRztBQUFBLE1BQ1YsTUFBTSxXQUFXLGVBQWUsQ0FBQztBQUFBLE1BQ2pDLElBQUksYUFBYTtBQUFBLFFBQU0sT0FBTztBQUFBLE1BRzlCLE9BQU8sZUFBZSxJQUFJLFNBQVMsWUFBWSxXQUFXLENBQUMsQ0FBQyxDQUFDLEtBQUs7QUFBQTtBQUFBO0FBQUEsRUFJdEUsTUFBTSxPQUFPLENBQUMsT0FBcUI7QUFBQSxJQUNqQyxNQUFNLEVBQUU7QUFBQSxJQUNSLFNBQVMsRUFBRTtBQUFBLElBQ1gsT0FBTyxFQUFFO0FBQUEsSUFDVCxVQUFVLEVBQUU7QUFBQSxJQUNaLGFBQWEsRUFBRTtBQUFBLElBQ2YsVUFBVSxFQUFFO0FBQUEsSUFDWixNQUFNLEVBQUU7QUFBQSxFQUNWO0FBQUEsRUFFQSxPQUFPLE9BQU8sS0FBSztBQUFBLElBQ2pCLE1BQU07QUFBQSxJQUNOO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBO0FBQUEsSUFDQSxTQUFTLENBQUMsU0FBaUI7QUFBQSxNQUN6QixNQUFNLElBQUksT0FBTyxJQUFJO0FBQUEsTUFDckIsT0FBTyxNQUFNLFlBQVksS0FBSyxVQUFVLENBQUM7QUFBQTtBQUFBLElBRTNDO0FBQUEsSUFDQTtBQUFBLElBQ0E7QUFBQSxJQUNBLGlCQUFpQixXQUFXLElBQUksQ0FBQyxNQUFNLEtBQUssR0FBRztBQUFBLElBQy9DLE1BQU0sS0FBSyxJQUFJLElBQUk7QUFBQSxFQUNyQixDQUFlO0FBQUEsRUFDZixPQUFPO0FBQUE7OztBR3ZiVCxJQUFNLGtCQUFrQjtBQUN4QixJQUFNLGdCQUFnQixFQUFFLFdBQVcsS0FBSyxPQUFPLEtBQUs7QUFVN0MsU0FBUyxhQUFhLENBQUMsT0FHNUI7QUFBQSxFQUNBLE1BQU0sV0FBcUIsQ0FBQztBQUFBLEVBQzVCLE1BQU0sWUFBc0IsQ0FBQztBQUFBLEVBQzdCLElBQUksUUFBUTtBQUFBLEVBQ1osSUFBSSxVQUFVO0FBQUEsRUFFZCxXQUFXLFFBQVEsTUFBTSxNQUFNO0FBQUEsQ0FBSSxHQUFHO0FBQUEsSUFDcEMsSUFBSSxTQUFTO0FBQUEsTUFBSTtBQUFBLElBQ2pCLElBQUksS0FBSyxXQUFXLEdBQUcsR0FBRztBQUFBLE1BQ3hCLFNBQVMsS0FBSyxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUEsTUFDM0I7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLFFBQVEsS0FBSyxRQUFRLEdBQUc7QUFBQSxJQUM5QixNQUFNLFFBQVEsVUFBVSxLQUFLLE9BQU8sS0FBSyxNQUFNLEdBQUcsS0FBSztBQUFBLElBQ3ZELElBQUksUUFBUSxVQUFVLEtBQUssS0FBSyxLQUFLLE1BQU0sUUFBUSxDQUFDO0FBQUEsSUFDcEQsSUFBSSxNQUFNLFdBQVcsR0FBRztBQUFBLE1BQUcsUUFBUSxNQUFNLE1BQU0sQ0FBQztBQUFBLElBQ2hELElBQUksVUFBVSxRQUFRO0FBQUEsTUFDcEIsVUFBVSxLQUFLLEtBQUs7QUFBQSxNQUNwQixVQUFVO0FBQUEsSUFDWixFQUFPLFNBQUksVUFBVSxTQUFTO0FBQUEsTUFDNUIsUUFBUTtBQUFBLElBQ1Y7QUFBQSxFQUVGO0FBQUEsRUFFQSxJQUFJLENBQUM7QUFBQSxJQUFTLE9BQU8sRUFBRSxPQUFPLE1BQU0sU0FBUztBQUFBLEVBQzdDLE9BQU8sRUFBRSxPQUFPLEVBQUUsT0FBTyxNQUFNLFVBQVUsS0FBSztBQUFBLENBQUksRUFBRSxHQUFHLFNBQVM7QUFBQTtBQVVsRSxlQUFzQixVQUFjLENBQUMsTUFBd0M7QUFBQSxFQUMzRSxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLE1BQU0sS0FBSyxPQUFPLFFBQVE7QUFBQSxFQUNoQyxNQUFNLFNBQVMsS0FBSyxVQUFVO0FBQUEsRUFDOUIsTUFBTSxRQUFRLEtBQUssU0FBUztBQUFBLEVBQzVCLE1BQU0sZUFBZSxLQUFLLGdCQUFnQjtBQUFBLEVBRTFDLElBQUksU0FBUyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxRQUF1QixLQUFLLGNBQWM7QUFBQSxFQUM5QyxJQUFJLGVBQWU7QUFBQSxFQUNuQixJQUFJLGdCQUFnQjtBQUFBLEVBQ3BCLElBQUksZUFBZTtBQUFBLEVBQ25CLElBQUksUUFBUSxNQUFNO0FBQUEsRUFDbEIsSUFBSSxPQUFPO0FBQUEsRUFDWCxJQUFJLFNBQWdEO0FBQUEsRUFnQnBELElBQUksVUFBVTtBQUFBLEVBQ2QsSUFBSSxVQUFrQztBQUFBLEVBQ3RDLElBQUksY0FBbUM7QUFBQSxFQUN2QyxNQUFNLE9BQU8sQ0FBQyxhQUFxQjtBQUFBLElBQ2pDLFVBQVU7QUFBQSxJQUNWLE9BQU87QUFBQSxJQUNQLFNBQVMsTUFBTTtBQUFBLElBQ2YsY0FBYztBQUFBO0FBQUEsRUFJaEIsTUFBTSxVQUFVLENBQUMsT0FDZixJQUFJLFFBQWMsQ0FBQyxpQkFBaUI7QUFBQSxJQUNsQyxJQUFJO0FBQUEsTUFBUyxPQUFPLGFBQWE7QUFBQSxJQUNqQyxNQUFNLFNBQVMsTUFBTTtBQUFBLE1BQ25CLGFBQWEsS0FBSztBQUFBLE1BQ2xCLGNBQWM7QUFBQSxNQUNkLGFBQWE7QUFBQTtBQUFBLElBRWYsTUFBTSxRQUFRLFdBQVcsUUFBUSxFQUFFO0FBQUEsSUFDbkMsY0FBYztBQUFBLEdBQ2Y7QUFBQSxFQUVILE1BQU0sV0FBVyxNQUFNLEtBQUssQ0FBQztBQUFBLEVBQzdCLE1BQU0sYUFBYSxLQUFLLFlBQVk7QUFBQSxFQUNwQyxJQUFJLFlBQVk7QUFBQSxJQUNkLFFBQVEsR0FBRyxVQUFVLFFBQVE7QUFBQSxJQUM3QixRQUFRLEdBQUcsV0FBVyxRQUFRO0FBQUEsRUFDaEM7QUFBQSxFQUlBLE1BQU0sYUFBYSxDQUFDLE1BQWU7QUFBQSxJQUNqQyxJQUFLLEdBQXlDLFNBQVM7QUFBQSxNQUFTLEtBQUssQ0FBQztBQUFBO0FBQUEsRUFFeEUsTUFBTSxhQUFhO0FBQUEsRUFJbkIsV0FBVyxLQUFLLFNBQVMsVUFBVTtBQUFBLEVBRW5DLE1BQU0sZ0JBQWdCLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDbEMsS0FBSyxRQUFRLGlCQUFpQixTQUFTLGFBQWE7QUFBQSxFQUNwRCxJQUFJLEtBQUssUUFBUTtBQUFBLElBQVMsS0FBSyxDQUFDO0FBQUEsRUFFaEMsTUFBTSxPQUFPLENBQUMsU0FBaUI7QUFBQSxJQUM3QixJQUFJLE1BQU0sR0FBRztBQUFBLENBQVE7QUFBQTtBQUFBLEVBSXZCLE1BQU0sT0FBTyxDQUFDLFNBQW9DO0FBQUEsSUFDaEQsSUFBSSxTQUFTLFFBQVEsU0FBUztBQUFBLE1BQVcsSUFBSSxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUE7QUFBQSxFQUdoRSxJQUFJO0FBQUEsSUFDRixPQUFPLENBQUMsU0FBUztBQUFBLE1BTWYsTUFBTSxPQUFPLE1BQU0sS0FBSyxRQUFRO0FBQUEsTUFNaEMsSUFBSTtBQUFBLFFBQVM7QUFBQSxNQUNiLElBQUksU0FBUyxNQUFNO0FBQUEsUUFDakIsTUFBTSxVQUFVLEtBQUssZUFBZSxFQUFFLGNBQWMsY0FBYyxDQUFDLEtBQUs7QUFBQSxRQUN4RSxJQUFJLFlBQVksUUFBUTtBQUFBLFVBQ3RCLFNBQVM7QUFBQSxVQUNULE9BQU87QUFBQSxRQUNUO0FBQUEsUUFDQSxNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxRQUN2QztBQUFBLE1BQ0Y7QUFBQSxNQUNBLGVBQWU7QUFBQSxNQUVmLE1BQU0sU0FBUyxLQUFLLFFBQVEsUUFBUSxZQUFZLEtBQUs7QUFBQSxRQUNuRCxPQUFPLE9BQU8sTUFBTTtBQUFBLE1BQ3RCO0FBQUEsTUFFQSxNQUFNLGFBQWE7QUFBQSxNQUNuQixJQUFJLGVBQWU7QUFBQSxNQUVuQixJQUFJLFVBQVU7QUFBQSxNQUNkLE1BQU0sS0FBSyxJQUFJLGdCQUFnQixNQUFNLEVBQUUsU0FBUztBQUFBLE1BQ2hELE1BQU0sTUFBTSxHQUFHLE9BQU8sS0FBSyxPQUFPLEtBQUssSUFBSSxPQUFPO0FBQUEsTUFFbEQsVUFBVSxJQUFJO0FBQUEsTUFDZCxNQUFNLGFBQWE7QUFBQSxNQUNuQixJQUFJLFdBQWlEO0FBQUEsTUFDckQsTUFBTSxnQkFBZ0IsTUFBTTtBQUFBLFFBQzFCLElBQUksVUFBVTtBQUFBLFVBQUc7QUFBQSxRQUNqQixJQUFJLGFBQWE7QUFBQSxVQUFNLGFBQWEsUUFBUTtBQUFBLFFBQzVDLFdBQVcsV0FBVyxNQUFNLFdBQVcsTUFBTSxHQUFHLE1BQU07QUFBQTtBQUFBLE1BVXhELElBQUk7QUFBQSxNQUNKLElBQUk7QUFBQSxRQUNGLE1BQU0sTUFBTSxNQUFNLEtBQUssRUFBRSxRQUFRLFdBQVcsT0FBTyxDQUFDO0FBQUEsUUFDcEQsT0FBTyxHQUFHO0FBQUEsUUFDVixJQUFJLGFBQWE7QUFBQSxVQUFNLGFBQWEsUUFBUTtBQUFBLFFBQzVDLFVBQVU7QUFBQSxRQUNWLElBQUk7QUFBQSxVQUFTO0FBQUEsUUFDYixLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sa0JBQWtCLE9BQU8sRUFBRSxDQUFDLENBQUM7QUFBQSxRQUMvRCxNQUFNLFFBQVEsS0FBSztBQUFBLFFBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxRQUN2QztBQUFBO0FBQUEsTUFHRixJQUFJO0FBQUEsUUFDRixJQUFJLENBQUMsSUFBSSxJQUFJO0FBQUEsVUFFWCxNQUFNLEtBQUssY0FBYyxHQUFHO0FBQUEsVUFLNUIsTUFBTSxJQUFJLE1BQU0sT0FBTyxFQUFFLE1BQU0sTUFBTSxFQUFFO0FBQUEsVUFDdkMsS0FBSyxLQUFLLGVBQWUsRUFBRSxPQUFPLFFBQVEsUUFBUSxJQUFJLE9BQU8sQ0FBQyxDQUFDO0FBQUEsVUFDL0QsTUFBTSxRQUFRLEtBQUs7QUFBQSxVQUNuQixRQUFRLEtBQUssSUFBSSxRQUFRLEdBQUcsTUFBTSxLQUFLO0FBQUEsVUFDdkM7QUFBQSxRQUNGO0FBQUEsUUFDQSxJQUFJLENBQUMsSUFBSSxNQUFNO0FBQUEsVUFJYixLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sV0FBVyxRQUFRLElBQUksT0FBTyxDQUFDLENBQUM7QUFBQSxVQUNsRSxNQUFNLFFBQVEsS0FBSztBQUFBLFVBQ25CLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxNQUFNLEtBQUs7QUFBQSxVQUN2QztBQUFBLFFBQ0Y7QUFBQSxRQUVBLGdCQUFnQjtBQUFBLFFBQ2hCLGVBQWU7QUFBQSxRQUNmLGNBQWM7QUFBQSxRQUVkLE1BQU0sU0FBUyxJQUFJLEtBQUssVUFBVTtBQUFBLFFBQ2xDLE1BQU0sVUFBVSxJQUFJO0FBQUEsUUFDcEIsSUFBSSxNQUFNO0FBQUEsUUFFVixPQUFPLENBQUMsU0FBUztBQUFBLFVBQ2YsSUFBSTtBQUFBLFVBQ0osSUFBSTtBQUFBLFlBQ0YsUUFBUSxNQUFNLE9BQU8sS0FBSztBQUFBLFlBQzFCLE9BQU8sR0FBRztBQUFBLFlBR1YsSUFBSSxDQUFDO0FBQUEsY0FBUyxLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sZ0JBQWdCLE9BQU8sRUFBRSxDQUFDLENBQUM7QUFBQSxZQUMzRTtBQUFBO0FBQUEsVUFFRixJQUFJLE1BQU0sTUFBTTtBQUFBLFlBQ2QsSUFBSSxDQUFDO0FBQUEsY0FBUyxLQUFLLEtBQUssZUFBZSxFQUFFLE9BQU8sYUFBYSxDQUFDLENBQUM7QUFBQSxZQUMvRDtBQUFBLFVBQ0Y7QUFBQSxVQVVBLFFBQVEsTUFBTTtBQUFBLFVBS2QsY0FBYztBQUFBLFVBQ2QsT0FBTyxRQUFRLE9BQU8sTUFBTSxPQUFPLEVBQUUsUUFBUSxLQUFLLENBQUM7QUFBQSxVQUVuRCxTQUFTLE1BQU0sSUFBSSxRQUFRO0FBQUE7QUFBQSxDQUFNLEVBQUcsT0FBTyxHQUFHLE1BQU0sSUFBSSxRQUFRO0FBQUE7QUFBQSxDQUFNLEdBQUc7QUFBQSxZQUN2RSxNQUFNLFFBQVEsSUFBSSxNQUFNLEdBQUcsR0FBRztBQUFBLFlBQzlCLE1BQU0sSUFBSSxNQUFNLE1BQU0sQ0FBQztBQUFBLFlBQ3ZCLFFBQVEsT0FBTyxhQUFhLGNBQWMsS0FBSztBQUFBLFlBQy9DLFdBQVcsUUFBUTtBQUFBLGNBQVUsS0FBSyxLQUFLLFlBQVksSUFBSSxDQUFDO0FBQUEsWUFDeEQsSUFBSSxDQUFDO0FBQUEsY0FBTztBQUFBLFlBRVosSUFBSTtBQUFBLFlBQ0osSUFBSTtBQUFBLGNBQ0YsS0FBSyxLQUFLLE1BQU0sTUFBTSxJQUFJO0FBQUEsY0FDMUIsT0FBTyxHQUFHO0FBQUEsY0FDVixLQUFLLEtBQUssY0FBYyxPQUFPLENBQUMsQ0FBQztBQUFBLGNBQ2pDO0FBQUE7QUFBQSxZQU9GLE1BQU0sSUFBSSxLQUFLLFdBQVcsRUFBRTtBQUFBLFlBRTVCLElBQUksYUFBYTtBQUFBLFlBQ2pCLElBQUksS0FBSyxTQUFTO0FBQUEsY0FDaEIsTUFBTSxPQUFPLEtBQUssUUFBUSxFQUFFO0FBQUEsY0FDNUIsSUFBSSxPQUFPLFNBQVMsVUFBVTtBQUFBLGdCQUM1QixJQUFJLFVBQVUsUUFBUSxTQUFTLE9BQU87QUFBQSxrQkFDcEMsU0FBUztBQUFBLGtCQUNULGFBQWE7QUFBQSxrQkFDYixNQUFNLE9BQU8sS0FBSyxnQkFBZ0IsSUFBSSxLQUFLO0FBQUEsa0JBQzNDLElBQUksU0FBUztBQUFBLG9CQUFNLEtBQUssSUFBSTtBQUFBLGtCQUc1QixJQUFJLGFBQWEsS0FBSyxPQUFPLE1BQU0sWUFBWSxJQUFJLFlBQVk7QUFBQSxvQkFDN0QsUUFBUTtBQUFBLG9CQUNSLFVBQVU7QUFBQSxvQkFDVjtBQUFBLGtCQUNGO0FBQUEsZ0JBQ0Y7QUFBQSxnQkFDQSxRQUFRO0FBQUEsY0FDVjtBQUFBLFlBQ0Y7QUFBQSxZQUNBLElBQ0UsS0FBSyxvQkFBb0IsUUFDekIsQ0FBQyxjQUNELENBQUMsZ0JBQ0QsY0FBYyxLQUNkLE9BQU8sTUFBTSxZQUNiLEtBQUssWUFDTDtBQUFBLGNBRUEsZUFBZTtBQUFBLGNBQ2YsU0FBUztBQUFBLGNBQ1QsTUFBTSxPQUFPLEtBQUssZ0JBQWdCLEtBQUssVUFBVSxFQUFFLEtBQUssU0FBUyxLQUFLO0FBQUEsY0FDdEUsSUFBSSxTQUFTO0FBQUEsZ0JBQU0sS0FBSyxJQUFJO0FBQUEsWUFDOUI7QUFBQSxZQUNBLElBQUksT0FBTyxNQUFNLFlBQVksT0FBTyxTQUFTLENBQUMsR0FBRztBQUFBLGNBQy9DLFNBQVMsaUJBQWlCLFdBQVcsSUFBSSxLQUFLLElBQUksUUFBUSxDQUFDO0FBQUEsWUFDN0Q7QUFBQSxZQUVBLE1BQU0sV0FBVyxLQUFLLFNBQVMsSUFBSSxLQUFLLEtBQUs7QUFBQSxZQUM3QyxNQUFNLGFBQWEsS0FBSyxXQUFXLElBQUksT0FBTyxRQUFRLEtBQUs7QUFBQSxZQUUzRCxJQUFJLFlBQWEsY0FBYyxLQUFLLDBCQUEwQixNQUFPO0FBQUEsY0FDbkUsTUFBTSxPQUFPLEtBQUssU0FBUyxLQUFLLE9BQU8sSUFBSSxLQUFLLElBQUksTUFBTTtBQUFBLGNBQzFELElBQUksU0FBUztBQUFBLGdCQUFNLEtBQUssSUFBSTtBQUFBLFlBQzlCO0FBQUEsWUFDQSxJQUFJLFlBQVk7QUFBQSxjQUdkLFdBQVcsTUFBTTtBQUFBLGNBQ2pCLFNBQVM7QUFBQSxjQUNULE9BQU87QUFBQSxZQUNUO0FBQUEsVUFDRjtBQUFBLFVBQ0EsSUFBSSxTQUFTO0FBQUEsWUFDWCxXQUFXLE1BQU07QUFBQSxZQUNqQjtBQUFBLFVBQ0Y7QUFBQSxRQUNGO0FBQUEsZ0JBQ0E7QUFBQSxRQUNBLElBQUksYUFBYTtBQUFBLFVBQU0sYUFBYSxRQUFRO0FBQUEsUUFDNUMsVUFBVTtBQUFBO0FBQUEsTUFHWixJQUFJO0FBQUEsUUFBUztBQUFBLE1BQ2IsSUFBSSxTQUFTO0FBQUEsUUFFWCxRQUFRLE1BQU07QUFBQSxRQUNkO0FBQUEsTUFDRjtBQUFBLE1BUUEsTUFBTSxRQUFRLEtBQUs7QUFBQSxNQUNuQixRQUFRLEtBQUssSUFBSSxRQUFRLEdBQUcsTUFBTSxLQUFLO0FBQUEsSUFDekM7QUFBQSxJQUNBLE9BQU87QUFBQSxZQUNQO0FBQUEsSUFDQSxJQUFJLFlBQVk7QUFBQSxNQUNkLFFBQVEsSUFBSSxVQUFVLFFBQVE7QUFBQSxNQUM5QixRQUFRLElBQUksV0FBVyxRQUFRO0FBQUEsSUFDakM7QUFBQSxJQUNBLFdBQVcsTUFBTSxTQUFTLFVBQVU7QUFBQSxJQUNwQyxLQUFLLFFBQVEsb0JBQW9CLFNBQVMsYUFBYTtBQUFBLElBQ3ZELEtBQUssUUFBUSxFQUFFLFFBQVEsT0FBTyxRQUFRLE9BQU8sQ0FBQztBQUFBO0FBQUE7OztBQ3JaM0MsSUFBTSxpQkFBaUI7QUFFdkIsSUFBTSxtQkFBbUI7QUFDekIsSUFBTSxvQkFBb0IsaUJBQWlCO0FBRTNDLElBQU0sYUFBYTtBQUduQixJQUFNLGNBQ1g7QUFNSyxJQUFNLHNCQUFzQjtBQUk1QixTQUFTLGVBQWUsQ0FBQyxLQUFpQztBQUFBLEVBQy9ELElBQUksUUFBUSxhQUFhLElBQUksS0FBSyxNQUFNO0FBQUEsSUFBSSxPQUFPO0FBQUEsRUFDbkQsTUFBTSxJQUFJLE9BQU8sR0FBRztBQUFBLEVBQ3BCLE9BQU8sT0FBTyxVQUFVLENBQUMsS0FBSyxLQUFLLElBQUksSUFBSTtBQUFBO0FBd0R0QyxJQUFNLG9CQUFvQjtBQUlqQyxJQUFNLFlBQVksQ0FBQyxLQUFhLE9BQU8sdUJBQ3JDLEdBQUcsT0FBTyxhQUFhO0FBT2xCLFNBQVMsT0FBTyxDQUFDLEdBQWlCLEtBQTBDO0FBQUEsRUFDakYsTUFBTSxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sUUFBUSxFQUFFLFFBQVEsUUFBUSxFQUFFLE9BQU87QUFBQSxFQUNsRSxRQUFRLEVBQUU7QUFBQSxTQUNIO0FBQUEsTUFDSCxPQUFPO0FBQUEsU0FDSjtBQUFBLE1BQ0gsT0FBTztBQUFBLFFBQ0wsTUFBTTtBQUFBLFdBQ0g7QUFBQSxXQUNDLEVBQUUsS0FBSyxFQUFFLElBQUksRUFBRSxHQUFHLElBQUksQ0FBQztBQUFBLFFBQzNCLE1BQU07QUFBQSxRQUNOLFNBQVMsSUFBSSxTQUFTO0FBQUEsUUFDdEIsTUFDRSxFQUFFLE9BQU8sVUFDTCxVQUNFLGlHQUNBLGFBQ0YsSUFDQSxVQUFVLHFEQUFxRDtBQUFBLE1BQ3ZFO0FBQUEsU0FDRztBQUFBLE1BQ0gsT0FBTztBQUFBLFFBQ0wsTUFBTTtBQUFBLFdBQ0g7QUFBQSxRQUNILE1BQU07QUFBQSxRQUNOLFNBQVMsSUFBSSxTQUFTO0FBQUEsUUFDdEIsTUFBTSxVQUFVLG1FQUFtRTtBQUFBLE1BQ3JGO0FBQUEsU0FDRztBQUFBLE1BQ0gsT0FBTztBQUFBLFFBQ0wsTUFBTTtBQUFBLFdBQ0g7QUFBQSxRQUNILE1BQU07QUFBQSxRQUNOLFNBQVMsSUFBSSxLQUFLLEVBQUUsT0FBTyxFQUFFLFFBQVEsTUFBTSxVQUFXLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxNQUFNLElBQUksQ0FBQyxFQUFHLENBQUM7QUFBQSxRQUMxRixNQUFNLHlFQUF5RTtBQUFBLE1BQ2pGO0FBQUEsU0FDRztBQUFBLE1BQ0gsSUFBSSxFQUFFLFlBQVksRUFBRSxTQUFTO0FBQUEsUUFDM0IsT0FBTztBQUFBLFVBQ0wsTUFBTTtBQUFBLGFBQ0g7QUFBQSxVQUNILE1BQU07QUFBQSxVQUNOLFNBQVMsSUFBSSxLQUFLO0FBQUEsWUFDaEIsT0FBTyxFQUFFO0FBQUEsWUFDVCxNQUFNO0FBQUEsZUFDRixFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxJQUFJLENBQUM7QUFBQSxVQUN0QyxDQUFDO0FBQUEsVUFDRCxNQUFNLG1GQUFtRjtBQUFBLFFBQzNGO0FBQUEsTUFDRixPQUFPO0FBQUEsUUFDTCxNQUFNO0FBQUEsV0FDSDtBQUFBLFFBQ0gsTUFBTTtBQUFBLFFBQ04sU0FBUyxJQUFJLEtBQUssRUFBRSxPQUFPLEVBQUUsUUFBUSxNQUFNLFNBQVUsRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLE1BQU0sSUFBSSxDQUFDLEVBQUcsQ0FBQztBQUFBLFFBQ3pGLE1BQU0sdUNBQXVDO0FBQUEsTUFDL0M7QUFBQTtBQUFBO0FBTUMsU0FBUyxVQUFVLENBQUMsS0FBcUI7QUFBQSxFQUM5QyxPQUFPLDJCQUEyQixLQUFLLEdBQUcsSUFBSSxNQUFNLElBQUksSUFBSSxXQUFXLEtBQUssT0FBTztBQUFBO0FBUTlFLFNBQVMsYUFBYSxDQUFDLE9BQXlEO0FBQUEsRUFDckYsTUFBTSxLQUFLLE1BQU0sUUFBUSxHQUFHO0FBQUEsRUFDNUIsTUFBTSxLQUFLLE9BQU8sS0FBSyxRQUFRLE1BQU0sTUFBTSxHQUFHLEVBQUU7QUFBQSxFQUNoRCxNQUFNLFFBQVEsT0FBTyxLQUFLLEtBQUssTUFBTSxNQUFNLEtBQUssQ0FBQztBQUFBLEVBQ2pELElBQUksQ0FBQyxVQUFVLEtBQUssR0FBRyxLQUFLLENBQUM7QUFBQSxJQUFHLE9BQU87QUFBQSxFQUN2QyxJQUFJLE9BQU8sTUFBTSxVQUFVO0FBQUEsSUFBSSxPQUFPO0FBQUEsRUFDdEMsT0FBTyxFQUFFLE9BQU8sT0FBTyxTQUFTLElBQUksRUFBRSxNQUFPLFFBQVEsRUFBRSxNQUFNLElBQUksQ0FBQyxFQUFHO0FBQUE7QUFnQmhFLFNBQVMsU0FBUyxDQUN2QixPQUNBLEdBQzhFO0FBQUEsRUFDOUUsTUFBTSxNQUFNLEVBQUUsT0FBTztBQUFBLEVBQ3JCLE1BQU0sSUFBSSxjQUFjLEtBQUs7QUFBQSxFQUM3QixJQUFJLE1BQU0sUUFBUSxFQUFFLFNBQVMsUUFBUSxFQUFFLFVBQVUsYUFBYSxFQUFFO0FBQUEsSUFDOUQsT0FBTyxFQUFFLElBQUksTUFBTSxPQUFPLEVBQUUsVUFBVyxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxJQUFJLENBQUMsRUFBRztBQUFBLEVBQzVFLE1BQU0sS0FDSixNQUFNLElBQ0Ysd0RBQ0EsNEJBQTRCO0FBQUEsRUFDbEMsTUFBTSxRQUFRLEVBQUUsUUFBUSxHQUFHLG9EQUFvRDtBQUFBLEVBQy9FLE1BQU0sTUFDSixDQUFDLEVBQUUsU0FBUyxNQUFNLFNBQVMsR0FBRyxJQUMxQixrRkFDQTtBQUFBLEVBQ04sT0FBTztBQUFBLElBQ0wsSUFBSTtBQUFBLElBQ0osU0FBUyxhQUFhLDBEQUFxRCxRQUFRO0FBQUEsRUFDckY7QUFBQTtBQUlLLFNBQVMsV0FBVyxDQUFDLE1BQWlDO0FBQUEsRUFDM0QsT0FBTyxLQUFLLElBQUksVUFBVSxFQUFFLEtBQUssR0FBRztBQUFBO0FBSy9CLFNBQVMsV0FBVyxDQUN6QixRQUNBLE9BQ0EsTUFDQSxPQUNRO0FBQUEsRUFHUixNQUFNLE9BQU8sUUFBUSxHQUFHLFNBQVMsVUFBVSxPQUFPLEtBQUs7QUFBQSxFQUN2RCxNQUFNLEtBQUssUUFBUSxJQUFJLENBQUMsV0FBVyxNQUFNLElBQUksQ0FBQyxXQUFXLElBQUk7QUFBQSxFQUM3RCxPQUFPLFlBQVksQ0FBQyxHQUFHLFFBQVEsR0FBRyxJQUFJLEdBQUksT0FBTyxDQUFDLFFBQVEsSUFBSSxDQUFDLENBQUUsQ0FBQztBQUFBO0FBNkJwRSxlQUFzQixlQUFtQixDQUN2QyxNQUNBLEdBQ2lCO0FBQUEsRUFDakIsTUFBTSxNQUFNLEtBQUssT0FBTyxRQUFRO0FBQUEsRUFDaEMsTUFBTSxXQUFXLEVBQUUsWUFBWSxnQkFBZ0IsUUFBUSxJQUFJLFdBQVc7QUFBQSxFQUN0RSxNQUFNLFNBQVMsRUFBRSxXQUFXLE1BQU07QUFBQSxFQUNsQyxNQUFNLFlBQVksQ0FBQyxFQUFFO0FBQUEsRUFFckIsTUFBTSxLQUFLLElBQUk7QUFBQSxFQUNmLE1BQU0sZ0JBQWdCLE1BQU0sR0FBRyxNQUFNO0FBQUEsRUFDckMsS0FBSyxRQUFRLGlCQUFpQixTQUFTLGFBQWE7QUFBQSxFQUNwRCxJQUFJLEtBQUssUUFBUTtBQUFBLElBQVMsR0FBRyxNQUFNO0FBQUEsRUFFbkMsSUFBSSxTQUFTO0FBQUEsRUFDYixJQUFJLFNBQVMsS0FBSztBQUFBLEVBQ2xCLElBQUksUUFBNEIsS0FBSztBQUFBLEVBQ3JDLElBQUksYUFBYTtBQUFBLEVBSWpCLE1BQU0sYUFBYSxDQUFDLElBQVEsVUFBb0IsY0FBYyxPQUFPLElBQUksS0FBSztBQUFBLEVBQzlFLElBQUksTUFBc0I7QUFBQSxFQUMxQixJQUFJO0FBQUEsRUFDSixJQUFJLFdBQVc7QUFBQSxFQUVmLE1BQU0sU0FBUyxDQUFDLE1BQWU7QUFBQSxJQUM3QixJQUFJLFFBQVE7QUFBQSxNQUFNLE1BQU07QUFBQSxJQUN4QixHQUFHLE1BQU07QUFBQTtBQUFBLEVBRVgsTUFBTSxRQUNKLEVBQUUsU0FBUyxXQUFXLFdBQVcsSUFBSSxXQUFXLE1BQU0sT0FBTyxRQUFRLEdBQUcsUUFBUSxJQUFJO0FBQUEsRUFFdEYsSUFBSTtBQUFBLElBQ0YsTUFBTSxPQUFPLE1BQU0sV0FBZTtBQUFBLFNBQzdCO0FBQUEsTUFDSCxRQUFRLEdBQUc7QUFBQSxNQUtYLGlCQUFpQjtBQUFBLE1BR2pCLFVBQVUsQ0FBQyxPQUFPO0FBQUEsUUFDaEIsTUFBTSxJQUFJLEtBQUssV0FBVyxFQUFFO0FBQUEsUUFDNUIsYUFBYSxPQUFPLE1BQU0sWUFBWSxPQUFPLFNBQVMsQ0FBQztBQUFBLFFBQ3ZELE9BQU87QUFBQTtBQUFBLE1BRVQsY0FBYyxDQUFDLE1BQU07QUFBQSxRQUNuQixNQUFNLFVBQVUsS0FBSyxlQUFlLENBQUMsS0FBSztBQUFBLFFBSTFDLElBQUksWUFBWSxVQUFVLFFBQVEsTUFBTTtBQUFBLFVBQ3RDLE1BQU07QUFBQSxVQUNOLFdBQVcsRUFBRSxTQUFTO0FBQUEsUUFDeEI7QUFBQSxRQUNBLE9BQU87QUFBQTtBQUFBLE1BRVQsUUFBUSxDQUFDLElBQUksVUFBVTtBQUFBLFFBQ3JCLFdBQVc7QUFBQSxRQUNYLE1BQU0sUUFBTyxLQUFLLFNBQVMsS0FBSyxPQUFPLElBQUksS0FBSyxJQUFJLE1BQU07QUFBQSxRQUMxRCxJQUFJLFVBQVMsUUFBUSxXQUFXLElBQUksS0FBSztBQUFBLFVBQUcsVUFBVTtBQUFBLFFBQ3RELE9BQU87QUFBQTtBQUFBLE1BRVQsVUFBVSxDQUFDLElBQUksT0FBTyxhQUFhO0FBQUEsUUFDakMsSUFBSSxLQUFLLFdBQVcsSUFBSSxPQUFPLFFBQVEsR0FBRztBQUFBLFVBQ3hDLElBQUksUUFBUSxNQUFNO0FBQUEsWUFDaEIsT0FBTyxFQUFFLGFBQWEsTUFBTSxPQUFPLEVBQUUsSUFBSSxXQUFXO0FBQUEsWUFDcEQsSUFBSSxRQUFRO0FBQUEsY0FBVSxXQUFXLEVBQUUsV0FBVyxFQUFFO0FBQUEsVUFDbEQ7QUFBQSxVQUNBLE9BQU87QUFBQSxRQUNUO0FBQUEsUUFDQSxJQUFJLEVBQUUsU0FBUyxVQUFVLFlBQVksV0FBVyxJQUFJLEtBQUssR0FBRztBQUFBLFVBQzFELElBQUksUUFBUTtBQUFBLFlBQU0sTUFBTTtBQUFBLFVBQ3hCLE9BQU87QUFBQSxRQUNUO0FBQUEsUUFDQSxPQUFPO0FBQUE7QUFBQSxNQUVULFdBQVcsQ0FBQyxTQUFTO0FBQUEsUUFDbkIsV0FBVztBQUFBLFFBQ1gsT0FBTyxLQUFLLFlBQVksSUFBSSxLQUFLO0FBQUE7QUFBQSxNQUVuQyxjQUFjLENBQUMsU0FBUztBQUFBLFFBQ3RCLE1BQU0sUUFBTyxLQUFLLGVBQWUsSUFBSSxLQUFLO0FBQUEsUUFDMUMsSUFBSSxLQUFLLFVBQVUsa0JBQWtCO0FBQUEsVUFDbkMsWUFBWTtBQUFBLFVBQ1osSUFBSSxhQUFhLFlBQVk7QUFBQSxZQUFxQixPQUFPLE1BQU07QUFBQSxRQUNqRSxFQUFPO0FBQUEsVUFHTCxXQUFXO0FBQUE7QUFBQSxRQUViLE9BQU87QUFBQTtBQUFBLE1BRVQsT0FBTyxDQUFDLE1BQU07QUFBQSxRQUNaLFNBQVMsRUFBRTtBQUFBLFFBQ1gsUUFBUSxFQUFFLFNBQVM7QUFBQSxRQUNuQixLQUFLLFFBQVEsQ0FBQztBQUFBO0FBQUEsSUFFbEIsQ0FBQztBQUFBLElBQ0QsTUFBTSxPQUFPLFFBQ1g7QUFBQSxNQUNFLEtBQUssT0FBTztBQUFBLFNBQ1IsV0FBVyxFQUFFLElBQUksU0FBUyxJQUFJLENBQUM7QUFBQSxNQUNuQyxNQUFNLEVBQUU7QUFBQSxNQUNSO0FBQUEsTUFDQTtBQUFBLFNBQ0ksUUFBUSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQUEsTUFDekIsVUFBVSxFQUFFO0FBQUEsTUFDWixPQUFPLEVBQUU7QUFBQSxJQUNYLEdBQ0EsRUFBRSxRQUNKO0FBQUEsSUFDQSxJQUFJLFNBQVM7QUFBQSxNQUFNLElBQUksTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBLElBQ3hELE9BQU87QUFBQSxZQUNQO0FBQUEsSUFDQSxJQUFJLFVBQVU7QUFBQSxNQUFNLGFBQWEsS0FBSztBQUFBLElBQ3RDLEtBQUssUUFBUSxvQkFBb0IsU0FBUyxhQUFhO0FBQUE7QUFBQTs7O0FDN21CcEQsSUFBTSx1QkFBdUI7QUFPN0IsSUFBTSxlQUFlO0FBZ0VyQixTQUFTLFVBQVUsQ0FBQyxRQUF3QjtBQUFBLEVBQ2pELE9BQU8sU0FBUztBQUFBOzs7QUMxRlgsSUFBTSxtQkFBbUI7QUFHekIsSUFBTSxlQUFlLFdBQVcsZ0JBQWdCOzs7QUNYaEQsSUFBTSxpQkFBaUIsQ0FBQyxPQUFPLGFBQWEsUUFBUSxNQUFNO0FBRTFELFNBQVMsU0FBUyxDQUFDLE1BQXVCO0FBQUEsRUFDL0MsTUFBTSxRQUFRLEtBQUssWUFBWTtBQUFBLEVBQy9CLE9BQU8sZUFBZSxLQUFLLENBQUMsUUFBUSxNQUFNLFNBQVMsR0FBRyxDQUFDO0FBQUE7QUFJekQsSUFBTSxZQUFZLElBQUksSUFBSSxDQUFDLGdCQUFnQixRQUFRLFFBQVEsT0FBTyxVQUFVLENBQUM7OztBUjBEN0UsU0FBUyxhQUFhLENBQUMsTUFBYyxRQUFnQixNQUFzQjtBQUFBLEVBQ3pFLE1BQU0sT0FDSixXQUFXLE1BQ1AsVUFDQSxXQUFXLE1BQ1QsY0FDQSxXQUFXLE1BQ1QsYUFDQTtBQUFBLEVBQ1YsTUFBTSxPQUFRLFFBQVEsQ0FBQztBQUFBLEVBQ3ZCLE1BQU0sVUFBVSxNQUFNLFFBQVEsS0FBSyxPQUFPLElBQUksS0FBSyxRQUFRLElBQUksTUFBTSxJQUFJO0FBQUEsRUFHekUsTUFBTSxPQUFPLE9BQU8sS0FBSyxTQUFTLFdBQVcsS0FBSyxPQUFPO0FBQUEsRUFDekQsSUFBSSxPQUFPLEtBQUssVUFBVSxXQUFXLEtBQUssUUFBUSxHQUFHLHFCQUFxQixXQUFXLE1BQU07QUFBQSxPQUNyRixPQUFPLEVBQUUsS0FBSyxJQUFJLENBQUM7QUFBQSxPQUNuQixVQUFVLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFBQSxPQUN6QixTQUFTLFFBQVEsU0FBUyxZQUFZLEVBQUUsUUFBUSxLQUFLLElBQUksQ0FBQztBQUFBLEVBQ2hFLENBQUM7QUFBQTtBQUdILElBQU0sYUFBYSxRQUFRLElBQUksY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUM3RCxJQUFNLGFBQWEsS0FBSyxZQUFZLElBQUk7QUFDeEMsSUFBTSxXQUFXLEtBQUssWUFBWSxNQUFNO0FBQ3hDLElBQU0sZ0JBQWdCLEtBQUssWUFBWSxNQUFNLFdBQVcsV0FBVztBQUNuRSxJQUFNLGNBQWMsS0FBSyxZQUFZLE1BQU0sTUFBTSxNQUFNLE1BQU0sTUFBTSxPQUFPLGFBQWE7QUFHaEYsU0FBUyxTQUFTLEdBQVc7QUFBQSxFQUNsQyxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFXLE9BQU87QUFBQSxFQUM3RCxJQUFJLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxJQUFPLE9BQU87QUFBQSxFQUN6RCxPQUFPLFdBQVcsS0FBSyxVQUFVLFlBQVksQ0FBQyxJQUFJLGFBQWE7QUFBQTtBQUlqRSxTQUFTLGVBQWUsR0FBVztBQUFBLEVBQ2pDLE9BQU8sUUFBUSxRQUFRLElBQUksb0JBQW9CLEtBQUssUUFBUSxHQUFHLGNBQWMsQ0FBQztBQUFBO0FBZWhGLFNBQVMsVUFBVSxHQUFhO0FBQUEsRUFDOUIsTUFBTSxNQUFNLEtBQUssZ0JBQWdCLEdBQUcsVUFBVTtBQUFBLEVBQzlDLElBQUk7QUFBQSxJQUNGLE9BQU8sWUFBWSxLQUFLLEVBQUUsZUFBZSxLQUFLLENBQUMsRUFDNUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxZQUFZLEtBQUssV0FBVyxLQUFLLEtBQUssRUFBRSxNQUFNLGVBQWUsQ0FBQyxDQUFDLEVBQy9FLElBQUksQ0FBQyxPQUFPLEVBQUUsSUFBSSxFQUFFLE1BQU0sSUFBSSxTQUFTLEtBQUssS0FBSyxFQUFFLE1BQU0sZUFBZSxDQUFDLEVBQUUsUUFBUSxFQUFFLEVBQ3JGLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxLQUFLLEVBQUUsRUFBRSxFQUMxQixJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUU7QUFBQSxJQUNsQixNQUFNO0FBQUEsSUFDTixPQUFPLENBQUM7QUFBQTtBQUFBO0FBS1osU0FBUyxPQUFPLENBQUMsSUFBZ0M7QUFBQSxFQUMvQyxJQUFJO0FBQUEsSUFDRixNQUFNLElBQUksS0FBSyxNQUNiLGFBQWEsS0FBSyxnQkFBZ0IsR0FBRyxZQUFZLElBQUksZUFBZSxHQUFHLE1BQU0sQ0FDL0U7QUFBQSxJQUNBLE9BQU8sT0FBTyxFQUFFLE9BQU8sT0FBTyxXQUFXLEVBQUUsTUFBTSxLQUFLO0FBQUEsSUFDdEQsTUFBTTtBQUFBLElBQ047QUFBQTtBQUFBO0FBaUJKLFNBQVMsU0FBUyxDQUFDLFNBQXdEO0FBQUEsRUFDekUsTUFBTSxNQUFNLFdBQVc7QUFBQSxFQUN2QixNQUFNLEtBQUssV0FBVyxJQUFJO0FBQUEsRUFDMUIsSUFBSSxPQUFPO0FBQUEsSUFDVCxPQUFPO0FBQUEsTUFDTCxTQUFTO0FBQUEsTUFDVCxPQUFPLEVBQUUsTUFBTSw2RUFBd0U7QUFBQSxJQUN6RjtBQUFBLEVBQ0YsSUFBSSxDQUFDLElBQUksU0FBUyxFQUFFO0FBQUEsSUFDbEIsT0FBTztBQUFBLE1BQ0wsU0FBUywwQkFBMEI7QUFBQSxNQUNuQyxPQUFPO0FBQUEsUUFDTCxNQUNFLElBQUksV0FBVyxJQUNYLGtFQUNBO0FBQUEsUUFDTixTQUFTLElBQUksTUFBTSxHQUFHLEVBQUU7QUFBQSxNQUMxQjtBQUFBLElBQ0Y7QUFBQSxFQUNGLElBQUksUUFBUSxFQUFFLE1BQU07QUFBQSxJQUNsQixPQUFPO0FBQUEsTUFDTCxTQUFTLDJCQUEyQjtBQUFBLE1BQ3BDLE9BQU87QUFBQSxRQUNMLE1BQU0saUhBQWlIO0FBQUEsTUFDekg7QUFBQSxJQUNGO0FBQUEsRUFDRixPQUFPO0FBQUEsSUFDTCxTQUFTLGtDQUFrQztBQUFBLElBQzNDLE9BQU87QUFBQSxNQUdMLE1BQU0sb0NBQW9DLGdGQUEyRTtBQUFBLE1BQ3JILFNBQVMsSUFBSSxNQUFNLEdBQUcsRUFBRTtBQUFBLElBQzFCO0FBQUEsRUFDRjtBQUFBO0FBR0YsU0FBUyxlQUFlLENBQUMsU0FBMEI7QUFBQSxFQUNqRCxPQUFPLEtBQUssT0FBTyxHQUFHLFVBQVUsZUFBZSxpQkFBaUIseUJBQXlCO0FBQUE7QUFJM0YsU0FBUyxXQUFXLENBQUMsU0FBeUM7QUFBQSxFQUM1RCxNQUFNLE9BQU8sZ0JBQWdCLE9BQU87QUFBQSxFQUNwQyxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixNQUFNLGFBQWEsTUFBTSxNQUFNO0FBQUEsSUFDL0IsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLE9BQVEsRUFBNEI7QUFBQSxJQUMxQyxJQUFJLFNBQVM7QUFBQSxNQUFVLE9BQU87QUFBQSxJQUM5QixJQUFJLG9DQUFvQyxRQUFRLHFCQUFxQixRQUFRLFVBQVU7QUFBQTtBQUFBLEVBRXpGLElBQUk7QUFBQSxJQUNGLE9BQU8sS0FBSyxNQUFNLEdBQUc7QUFBQSxJQUNyQixNQUFNO0FBQUEsSUFDTixJQUFJLDBDQUEwQyxRQUFRLFVBQVU7QUFBQTtBQUFBO0FBSXBFLFNBQVMsY0FBYyxDQUFDLFNBQWtDO0FBQUEsRUFDeEQsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLEVBQzdCLElBQUksQ0FBQyxHQUFHO0FBQUEsSUFDTixRQUFRLFNBQVMsVUFBVSxVQUFVLE9BQU87QUFBQSxJQUM1QyxJQUFJLFNBQVMsYUFBYSxLQUFLO0FBQUEsRUFDakM7QUFBQSxFQUNBLE9BQU87QUFBQTtBQUdULGVBQWUsR0FBRyxDQUNoQixNQUNBLFFBQ0EsTUFDQSxNQUM0QztBQUFBLEVBQzVDLE1BQU0sTUFBTSxNQUFNLE1BQU0sb0JBQW9CLE9BQU8sUUFBUTtBQUFBLElBQ3pEO0FBQUEsSUFDQSxTQUFTLFNBQVMsWUFBWSxFQUFFLGdCQUFnQixtQkFBbUIsSUFBSTtBQUFBLElBQ3ZFLE1BQU0sU0FBUyxZQUFZLEtBQUssVUFBVSxJQUFJLElBQUk7QUFBQSxFQUNwRCxDQUFDO0FBQUEsRUFDRCxJQUFJLE9BQWdCO0FBQUEsRUFDcEIsSUFBSTtBQUFBLElBQ0YsT0FBTyxNQUFNLElBQUksS0FBSztBQUFBLElBQ3RCLE1BQU07QUFBQSxFQUdSLE9BQU8sRUFBRSxRQUFRLElBQUksUUFBUSxLQUFLO0FBQUE7QUFHcEMsZUFBZSxPQUFPLENBQUMsU0FBNkIsS0FBOEI7QUFBQSxFQUNoRixNQUFNLElBQUksZUFBZSxPQUFPO0FBQUEsRUFDaEMsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLEtBQ0QsRUFBRSxRQUFRLEtBQUssSUFBSSxNQUFNLElBQUksRUFBRSxNQUFNLFFBQVEsUUFBUSxHQUFHO0FBQUEsSUFDekQsT0FBTyxLQUFLO0FBQUEsSUFHWixNQUFNLFVBQVUsZUFBZSxRQUFRLElBQUksVUFBVSxPQUFPLEdBQUc7QUFBQSxJQUMvRCxNQUFNLE9BQU8sT0FBTyxPQUFPLFFBQVEsWUFBWSxVQUFVLE1BQU0sT0FBTyxJQUFJLElBQUksSUFBSTtBQUFBLElBQ2xGLElBQUksSUFBSSxTQUFTLFlBQVksU0FBUyxnQkFBZ0IsUUFBUSxTQUFTLFlBQVk7QUFBQSxNQUNqRixPQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDcEIsTUFBTTtBQUFBO0FBQUEsRUFFUixJQUFJLFdBQVc7QUFBQSxJQUFLLGNBQWMsT0FBTyxJQUFJLElBQUksR0FBRyxRQUFRLElBQUk7QUFBQSxFQUNoRSxPQUFPO0FBQUE7QUFRRixJQUFNLGNBQWM7QUFBQSxFQUN6QixhQUFhLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDOUIsSUFBSSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3JCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixLQUFLLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdEIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsTUFBTSxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3hCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixRQUFRLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDMUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixXQUFXLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDNUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixXQUFXLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDN0IsTUFBTSxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3hCLE9BQU8sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN6QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixpQkFBaUIsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUNsQyxRQUFRLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDekIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3pCLEtBQUssRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN0QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUN6QjtBQUFBO0FBRU8sTUFBTSxtQkFBbUIsU0FBUztBQUFBLEVBQ3ZDLFdBQVcsQ0FBQyxTQUFpQixPQUErQztBQUFBLElBQzFFLE1BQU0sU0FBUyxTQUFTLEtBQUs7QUFBQTtBQUVqQztBQVVPLFNBQVMsY0FBYyxDQUFDLE9BQWtEO0FBQUEsRUFDL0UsTUFBTSxJQUFJLFVBQVUsT0FBTyxFQUFFLE9BQU8sS0FBSyxDQUFDO0FBQUEsRUFDMUMsSUFBSSxDQUFDLEVBQUU7QUFBQSxJQUFJLElBQUksRUFBRSxTQUFTLE9BQU87QUFBQSxFQUNqQyxPQUFPLEVBQUUsUUFBUSxFQUFFLE9BQU8sRUFBRSxPQUFPLE9BQU8sRUFBRSxNQUFNLElBQUksRUFBRSxPQUFPLEVBQUUsTUFBTTtBQUFBO0FBUWxFLFNBQVMsY0FBYyxDQUFDLE9BQXVCO0FBQUEsRUFDcEQsTUFBTSxJQUFJLE1BQU0sS0FBSztBQUFBLEVBQ3JCLElBQUksQ0FBQyxzQkFBc0IsS0FBSyxDQUFDLEtBQUssT0FBTyxNQUFNLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQSxJQUM5RCxJQUFJLGtCQUFrQixzREFBaUQsT0FBTztBQUFBLEVBQ2hGLE9BQU87QUFBQTtBQUlGLFNBQVMsWUFBWSxDQUFDLE9BQWUsTUFBc0I7QUFBQSxFQUNoRSxNQUFNLElBQUksWUFBWSxLQUFLLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDdkMsSUFBSSxDQUFDLEtBQUssT0FBTyxFQUFFLEVBQUUsSUFBSTtBQUFBLElBQ3ZCLElBQUksR0FBRyxVQUFVLHVEQUE2QyxTQUFTO0FBQUEsTUFDckUsTUFBTTtBQUFBLElBQ1IsQ0FBQztBQUFBLEVBQ0gsT0FBTyxPQUFPLEVBQUUsRUFBRTtBQUFBO0FBSWIsU0FBUyxVQUFVLENBQUMsT0FBZSxNQUFzQjtBQUFBLEVBQzlELE1BQU0sSUFBSSxNQUFNLEtBQUs7QUFBQSxFQUNyQixJQUFJLENBQUMsUUFBUSxLQUFLLENBQUM7QUFBQSxJQUFHLElBQUksR0FBRyxVQUFVLGdDQUFnQyxPQUFPO0FBQUEsRUFDOUUsT0FBTyxPQUFPLENBQUM7QUFBQTtBQVFWLFNBQVMsU0FBUyxDQUFDLE9BQWUsTUFBbUM7QUFBQSxFQUMxRSxNQUFNLElBQUksTUFBTSxLQUFLLEVBQUUsWUFBWTtBQUFBLEVBR25DLElBQUksTUFBTSxjQUFjLE1BQU0sVUFBVSxNQUFNO0FBQUEsSUFBUyxPQUFPO0FBQUEsRUFDOUQsT0FBTyxhQUFhLE9BQU8sSUFBSTtBQUFBO0FBWWpDLFNBQVMsWUFBWSxDQUFDLEtBQXlCO0FBQUEsRUFDN0MsTUFBTSxRQUFRLElBQUksSUFBSSxDQUFDLE1BQU0sUUFBUSxDQUFDLENBQUM7QUFBQSxFQUN2QyxXQUFXLEtBQUssT0FBTztBQUFBLElBQ3JCLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxNQUNGLEtBQUssU0FBUyxDQUFDO0FBQUEsTUFDZixNQUFNO0FBQUEsTUFDTixJQUFJLDJCQUEyQixLQUFLLFdBQVc7QUFBQTtBQUFBLElBRWpELElBQUksQ0FBQyxHQUFHLFlBQVksS0FBSyxDQUFDLFVBQVUsQ0FBQztBQUFBLE1BQ25DLElBQUkscUNBQXFDLEtBQUssU0FBUztBQUFBLFFBQ3JELE1BQU07QUFBQSxRQUNOLFNBQVMsQ0FBQyxHQUFHLGNBQWM7QUFBQSxNQUM3QixDQUFDO0FBQUEsRUFDTDtBQUFBLEVBQ0EsT0FBTztBQUFBO0FBU0YsU0FBUyxNQUFNLENBQUMsT0FBdUI7QUFBQSxFQUM1QyxJQUFJLE1BQU0sU0FBUyxHQUFHLEtBQUssV0FBVyxRQUFRLEtBQUssQ0FBQztBQUFBLElBQUcsT0FBTyxRQUFRLEtBQUs7QUFBQSxFQUMzRSxPQUFPO0FBQUE7QUFJVCxJQUFNLFdBQVc7QUFDakIsU0FBUyxTQUFTLENBQUMsUUFBc0I7QUFBQSxFQUN2QyxJQUFJLFFBQWtCLENBQUM7QUFBQSxFQUN2QixJQUFJO0FBQUEsSUFDRixRQUFRLFlBQVksTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNLHdCQUF3QixLQUFLLENBQUMsQ0FBQztBQUFBLElBQ3pFLE1BQU07QUFBQSxJQUNOO0FBQUE7QUFBQSxFQUVGLE1BQU0sUUFBUSxNQUFNLEtBQUssQ0FBQyxHQUFHLE1BQU0sT0FBTyxFQUFFLE1BQU0sR0FBRyxFQUFFLEVBQUUsSUFBSSxPQUFPLEVBQUUsTUFBTSxHQUFHLEVBQUUsRUFBRSxDQUFDO0FBQUEsRUFDcEYsV0FBVyxLQUFLLE1BQU0sTUFBTSxHQUFHLEtBQUssSUFBSSxHQUFHLE1BQU0sVUFBVSxXQUFXLEVBQUUsQ0FBQyxHQUFHO0FBQUEsSUFDMUUsSUFBSTtBQUFBLE1BQ0YsV0FBVyxLQUFLLFFBQVEsQ0FBQyxDQUFDO0FBQUEsTUFDMUIsTUFBTTtBQUFBLEVBR1Y7QUFBQTtBQUdGLGVBQWUsT0FBTyxDQUFDLEtBQWUsT0FBeUM7QUFBQSxFQUM3RSxNQUFNLFFBQVEsYUFBYSxHQUFHO0FBQUEsRUFFOUIsSUFBSSxPQUFPLE1BQU0sWUFBWSxVQUFVO0FBQUEsSUFDckMsTUFBTSxPQUFPLGdCQUFnQjtBQUFBLElBQzdCLE1BQU0sV0FBVyxLQUFLLE1BQU0sWUFBWSxNQUFNLFNBQVMsZUFBZTtBQUFBLElBQ3RFLElBQUksQ0FBQyxXQUFXLFFBQVEsR0FBRztBQUFBLE1BQ3pCLElBQUksUUFBa0IsQ0FBQztBQUFBLE1BQ3ZCLElBQUk7QUFBQSxRQUNGLFNBQ0UsTUFBTSxNQUFNLFVBQVUsSUFBSSxJQUFJLEtBQUssaUJBQWlCLEVBQUUsS0FBSyxLQUFLLE1BQU0sVUFBVSxDQUFDLENBQUMsR0FDbEYsSUFBSSxDQUFDLE1BQU0sRUFBRSxNQUFNLEdBQUcsRUFBRSxFQUFZO0FBQUEsUUFDdEMsTUFBTTtBQUFBLE1BR1IsSUFBSSxxQkFBcUIsTUFBTSxrQkFBa0IsUUFBUSxhQUFhO0FBQUEsUUFDcEUsU0FBUyxNQUFNLEtBQUs7QUFBQSxXQUNoQixNQUFNLFdBQVcsSUFBSSxFQUFFLE1BQU0saUNBQWlDLElBQUksQ0FBQztBQUFBLE1BQ3pFLENBQUM7QUFBQSxJQUNIO0FBQUEsSUFDQSxNQUFNLE9BQU8sWUFBWSxNQUFNLE9BQU87QUFBQSxJQUN0QyxJQUFJLE1BQU07QUFBQSxNQUNSLE1BQU0sUUFBUSxNQUFNLElBQUksS0FBSyxNQUFNLE9BQU8sUUFBUSxFQUFFLEtBQ2xELENBQUMsTUFBTSxFQUFFLFdBQVcsS0FDcEIsTUFBTSxLQUNSO0FBQUEsTUFDQSxJQUFJO0FBQUEsUUFDRixJQUFJLFdBQVcsTUFBTSxpQ0FBaUMsS0FBSyxPQUFPLFlBQVk7QUFBQSxVQUM1RSxNQUFNLGtDQUFrQyxNQUFNO0FBQUEsUUFDaEQsQ0FBQztBQUFBLElBQ0w7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLGFBQWEsQ0FBQyxPQUFPLGFBQWE7QUFBQSxFQUN4QyxJQUFJLE9BQU8sTUFBTSxZQUFZO0FBQUEsSUFBVSxXQUFXLEtBQUssYUFBYSxNQUFNLE9BQU87QUFBQSxFQUNqRixJQUFJLE9BQU8sTUFBTSxZQUFZO0FBQUEsSUFBVSxXQUFXLEtBQUssYUFBYSxNQUFNLE9BQU87QUFBQSxFQUU1RTtBQUFBLGVBQVcsS0FBSyxlQUFlLFFBQVEsSUFBSSxDQUFDO0FBQUEsRUFFakQsTUFBTSxNQUFNLFVBQVU7QUFBQSxFQUN0QixJQUFJLENBQUMsV0FBVyxHQUFHO0FBQUEsSUFDakIsSUFDRSx5RkFBb0YsT0FDcEYsWUFDQTtBQUFBLE1BQ0UsTUFBTTtBQUFBLElBQ1IsQ0FDRjtBQUFBLEVBTUYsTUFBTSxTQUFTLEtBQUssZ0JBQWdCLEdBQUcsTUFBTTtBQUFBLEVBQzdDLFVBQVUsUUFBUSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsRUFFckMsVUFBVSxNQUFNO0FBQUEsRUFDaEIsTUFBTSxVQUFVLEtBQUssUUFBUSxVQUFVLEtBQUssSUFBSSxLQUFLLFFBQVEsU0FBUztBQUFBLEVBQ3RFLFdBQVcsS0FBSyxTQUFTLE9BQU87QUFBQSxFQUNoQyxNQUFNLFFBQVEsU0FBUyxTQUFTLEdBQUc7QUFBQSxFQUNuQyxNQUFNLFFBQVEsTUFBTSxPQUFPLFlBQVk7QUFBQSxJQUNyQztBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsT0FBTyxDQUFDLFVBQVUsUUFBUSxLQUFLO0FBQUEsSUFDL0IsS0FBSyxRQUFRO0FBQUEsRUFDZixDQUFDO0FBQUEsRUFDRCxVQUFVLEtBQUs7QUFBQSxFQUNmLE1BQU0sTUFBTTtBQUFBLEVBRVosTUFBTSxpQkFDSixPQUFPLE1BQU0scUJBQXFCLFdBQzlCLEtBQUssSUFBSSxNQUFNLE9BQU8sU0FBUyxNQUFNLGtCQUFrQixFQUFFLElBQUksSUFBSSxJQUNqRTtBQUFBLEVBQ04sTUFBTSxPQUFPLE1BQU0sSUFBSSxRQUFnQixDQUFDLEtBQUssUUFBUTtBQUFBLElBQ25ELElBQUksTUFBTTtBQUFBLElBQ1YsTUFBTSxRQUFRLFdBQ1osTUFDRSxJQUNFLElBQUksTUFDRix5QkFBeUIsaUJBQWlCLDhDQUM1QyxDQUNGLEdBQ0YsY0FDRjtBQUFBLElBQ0EsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLFVBQWtCO0FBQUEsTUFDMUMsT0FBTyxNQUFNLFNBQVM7QUFBQSxNQUN0QixNQUFNLEtBQUssSUFBSSxRQUFRO0FBQUEsQ0FBSTtBQUFBLE1BQzNCLElBQUksTUFBTSxHQUFHO0FBQUEsUUFDWCxhQUFhLEtBQUs7QUFBQSxRQUNsQixJQUFJLElBQUksTUFBTSxHQUFHLEVBQUUsRUFBRSxLQUFLLENBQUM7QUFBQSxNQUM3QjtBQUFBLEtBQ0Q7QUFBQSxJQUNELE1BQU0sR0FBRyxTQUFTLENBQUMsUUFBUTtBQUFBLE1BQ3pCLGFBQWEsS0FBSztBQUFBLE1BQ2xCLElBQUksR0FBRztBQUFBLEtBQ1I7QUFBQSxJQUNELE1BQU0sR0FBRyxRQUFRLENBQUMsU0FBUztBQUFBLE1BQ3pCLGFBQWEsS0FBSztBQUFBLE1BQ2xCLElBQUksSUFBSSxNQUFNLDJCQUEyQiwyQkFBMkIsQ0FBQztBQUFBLEtBQ3RFO0FBQUEsR0FDRixFQUFFLE1BQU0sQ0FBQyxRQUFpQjtBQUFBLElBQ3pCLElBQUksT0FBTztBQUFBLElBQ1gsSUFBSTtBQUFBLE1BQ0YsT0FBTyxhQUFhLFNBQVMsTUFBTSxFQUFFLEtBQUssRUFBRSxNQUFNLElBQUk7QUFBQSxNQUN0RCxNQUFNO0FBQUEsSUFHUixJQUNFLHVDQUF1QyxlQUFlLFFBQVEsSUFBSSxVQUFVLE9BQU8sR0FBRyxLQUN0RixZQUNBLEVBQUUsTUFBTSxPQUFPLGVBQWUsYUFBYSxTQUFTLGVBQWUsVUFBVSxDQUMvRTtBQUFBLEdBQ0Q7QUFBQSxFQUtELE1BQU0sTUFBTSxNQUFNO0FBQUEsRUFDbEIsSUFBSSxDQUFDLE9BQU8sRUFBRSxXQUFXLFFBQVEsT0FBTyxJQUFJLFVBQVU7QUFBQSxJQUNwRCxNQUFNLElBQUksTUFDUiwrRUFDRjtBQUFBLEVBQ0YsSUFBSSxNQUFNO0FBQUEsRUFFVixJQUFJO0FBQUEsRUFRSixJQUFJO0FBQUEsSUFDRixLQUFLLEtBQUssTUFBTSxJQUFJO0FBQUEsSUFDcEIsTUFBTTtBQUFBLElBQ04sSUFBSSxrQ0FBa0MsUUFBUSxVQUFVO0FBQUE7QUFBQSxFQUUxRCxJQUFJLEdBQUcsT0FBTztBQUFBLElBQU8sY0FBYyxRQUFRLEdBQUcsVUFBVSxLQUFLLEVBQUU7QUFBQSxFQUUvRCxJQUFJLFVBQXFCLENBQUM7QUFBQSxFQUMxQixJQUFJLE1BQU0sU0FBUyxHQUFHO0FBQUEsSUFDcEIsTUFBTSxJQUFJLE1BQU0sUUFBUSxHQUFHLFlBQVksRUFBRSxNQUFNLGVBQWUsTUFBTSxDQUFDO0FBQUEsSUFDckUsVUFBVyxFQUFFLFdBQXlCLENBQUM7QUFBQSxFQUN6QztBQUFBLEVBQ0EsVUFBVSxLQUFLLE9BQVEsTUFBTSxTQUFTLElBQUksRUFBRSxRQUFRLElBQUksQ0FBQyxFQUFHLENBQUM7QUFBQSxFQUU3RCxJQUFJLENBQUMsTUFBTSxZQUFZO0FBQUEsSUFDckIsTUFBTSxTQUNKLFFBQVEsYUFBYSxXQUFXLFNBQVMsUUFBUSxhQUFhLFVBQVUsVUFBVTtBQUFBLElBQ3BGLE1BQU0sUUFBUSxDQUFDLEdBQUcsR0FBRyxHQUFHLEVBQUUsVUFBVSxNQUFNLE9BQU8sU0FBUyxDQUFDLEVBQUUsTUFBTTtBQUFBLEVBQ3JFO0FBQUE7QUFHRixlQUFlLE1BQU0sQ0FBQyxLQUFlLFNBQTZCO0FBQUEsRUFDaEUsTUFBTSxRQUFRLGFBQWEsR0FBRztBQUFBLEVBQzlCLFVBQVUsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGVBQWUsTUFBTSxDQUFDLENBQUM7QUFBQTtBQUdsRSxlQUFlLFFBQVEsQ0FBQyxTQUE2QixNQUFlO0FBQUEsRUFDbEUsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE1BQU0sT0FBTyxTQUFTLE9BQU8sWUFBWSxJQUFJO0FBQUEsRUFDbEYsSUFBSSxXQUFXO0FBQUEsSUFBSyxjQUFjLFNBQVMsUUFBUSxJQUFJO0FBQUEsRUFDdkQsVUFBVSxJQUFJO0FBQUE7QUFlaEIsZUFBZSxTQUFTLENBQ3RCLE1BQ0EsS0FDQSxPQUNBLElBQWlFLENBQUMsR0FDckM7QUFBQSxFQUM3QixNQUFNLFVBQVU7QUFBQSxJQUNkLElBQUksU0FBUztBQUFBLElBQ2IsTUFBTSxVQUFVO0FBQUEsSUFDaEIsT0FBTyxNQUFNLGlCQUFpQjtBQUFBLEVBQ2hDLEVBQUUsT0FBTyxPQUFPLEVBQUU7QUFBQSxFQUNsQixJQUFJLFlBQVksS0FBSyxFQUFFO0FBQUEsSUFBVTtBQUFBLEVBQ2pDLElBQUksWUFBWTtBQUFBLElBQ2QsSUFDRSxZQUFZLElBQ1IsR0FBRyx5QkFDSCxFQUFFLFdBQ0EsR0FBRyx5RUFDSCxHQUFHLG9GQUNULFNBQ0E7QUFBQSxNQUNFLE1BQU0sRUFBRSxXQUNKLG9GQUNBO0FBQUEsTUFDSixTQUFTLENBQUMsV0FBVyxhQUFhO0FBQUEsSUFDcEMsQ0FDRjtBQUFBLEVBQ0YsSUFBSTtBQUFBLEVBQ0osSUFBSSxNQUFNLFVBQVU7QUFBQSxJQUFNLE9BQU8sTUFBTSxJQUFJLFNBQVMsSUFBSSxNQUFNLE9BQU8sQ0FBQyxFQUFFLEtBQUs7QUFBQSxFQUN4RSxTQUFJLE9BQU8sTUFBTSxpQkFBaUIsVUFBVTtBQUFBLElBQy9DLE1BQU0sT0FBTyxNQUFNO0FBQUEsSUFDbkIsSUFBSSxDQUFDLFdBQVcsSUFBSTtBQUFBLE1BQUcsSUFBSSxHQUFHLGdDQUFnQyxRQUFRLEVBQUUsZUFBZSxPQUFPO0FBQUEsSUFHOUYsSUFBSSxTQUFTLElBQUksRUFBRSxZQUFZO0FBQUEsTUFDN0IsSUFBSSxHQUFHLGlEQUFpRCxRQUFRLFNBQVM7QUFBQSxRQUN2RSxNQUFNO0FBQUEsTUFDUixDQUFDO0FBQUEsSUFJSCxJQUFJO0FBQUEsTUFDRixPQUFPLGFBQWEsTUFBTSxNQUFNO0FBQUEsTUFDaEMsTUFBTTtBQUFBLE1BQ04sSUFBSSxHQUFHLHFDQUFxQyxRQUFRLFNBQVM7QUFBQSxRQUMzRCxNQUFNO0FBQUEsTUFDUixDQUFDO0FBQUE7QUFBQSxFQUVMLEVBQU87QUFBQSxXQUFPLElBQUksS0FBSyxHQUFHO0FBQUEsRUFDMUIsSUFBSSxDQUFDLEtBQUssS0FBSztBQUFBLElBQ2IsSUFDRSxFQUFFLFdBQVcsR0FBRyw0QkFBNEIsR0FBRyw4QkFDL0MsU0FDQSxFQUFFLFdBQVcsRUFBRSxNQUFNLDhEQUE4RCxJQUFJLENBQUMsQ0FDMUY7QUFBQSxFQUNGLE9BQU87QUFBQTtBQUdULGVBQWUsV0FBVyxDQUN4QixLQUNBLE9BQ0EsTUFDaUI7QUFBQSxFQUNqQixRQUFTLE1BQU0sVUFBVSxNQUFNLEtBQUssS0FBSyxLQUFNLElBQUksS0FBSztBQUFBO0FBUTFELElBQUksZUFBZTtBQVNuQixlQUFlLE9BQU8sQ0FDcEIsU0FDQSxPQUNBLEdBQ2lCO0FBQUEsRUFDakIsSUFBSSxVQUFVO0FBQUEsRUFDZCxNQUFNLFFBQVEsWUFBWSxhQUFhLEVBQUU7QUFBQSxFQUN6QyxJQUFJLFdBQVcsRUFBRTtBQUFBLEVBQ2pCLE1BQU0sTUFBTSxNQUFPLFlBQVksWUFBWSxDQUFDLGFBQWEsT0FBTyxJQUFJLENBQUM7QUFBQSxFQUNyRSxPQUFPLE1BQU0sZ0JBQ1g7QUFBQSxJQUNFLFNBQVMsTUFBTTtBQUFBLE1BQ2IsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLE1BQzdCLElBQUksQ0FBQztBQUFBLFFBQUcsT0FBTztBQUFBLE1BQ2YsSUFBSSxDQUFDO0FBQUEsUUFBUyxVQUFVLEVBQUU7QUFBQSxNQUMxQixJQUFJLENBQUMsVUFBVTtBQUFBLFFBQ2IsV0FBVztBQUFBLFFBQ1gsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxNQUFNLGFBQWEsWUFBWSxFQUFFLFlBQVksTUFBTSxFQUFFLEtBQUssQ0FBQztBQUFBLENBQ2pGO0FBQUEsTUFDRjtBQUFBLE1BQ0EsT0FBTyxvQkFBb0IsRUFBRTtBQUFBO0FBQUEsSUFFL0IsY0FBYyxHQUFHLG1CQUFtQjtBQUFBLE1BSWxDLElBQUksZ0JBQWdCO0FBQUEsUUFBTyxPQUFPO0FBQUEsTUFDbEMsUUFBUSxPQUFPLE1BQU07QUFBQSxDQUErQjtBQUFBLE1BQ3BELE9BQU87QUFBQTtBQUFBLElBRVQsTUFBTTtBQUFBLElBQ047QUFBQSxPQUNJLEVBQUUsUUFBUSxFQUFFLFlBQVksRUFBRSxNQUFNLElBQUksQ0FBQztBQUFBLElBQ3pDLFVBQVUsQ0FBQyxPQUFRLE9BQU8sR0FBRyxPQUFPLFdBQVcsR0FBRyxLQUFLO0FBQUEsSUFDdkQsU0FBUyxDQUFDLE9BQVEsT0FBTyxHQUFHLFVBQVUsV0FBVyxHQUFHLFFBQVE7QUFBQSxJQUU1RCxlQUFlLENBQUMsVUFBVSxLQUFLLFVBQVUsRUFBRSxNQUFNLGlCQUFpQixNQUFNLENBQUM7QUFBQSxJQUN6RSxVQUFVLENBQUMsT0FBTyxHQUFHLFNBQVM7QUFBQSxJQUM5QixRQUFRO0FBQUEsSUFJUixXQUFXLE1BQU07QUFBQSxNQUNmLElBQUksQ0FBQztBQUFBLFFBQWMsT0FBTztBQUFBLE1BQzFCLGVBQWU7QUFBQSxNQUNmLE9BQU8sS0FBSyxVQUFVLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUFBO0FBQUEsSUFjcEQsY0FBYyxHQUFHLE9BQU8sYUFBYTtBQUFBLE1BQ25DLElBQUk7QUFBQSxRQUFjLE9BQU87QUFBQSxNQUN6QixlQUFlO0FBQUEsTUFDZixPQUFPLEtBQUssVUFBVTtBQUFBLFFBQ3BCLE1BQU07QUFBQSxRQUNOO0FBQUEsV0FDSSxXQUFXLFlBQVksRUFBRSxPQUFPLElBQUksQ0FBQztBQUFBLFFBQ3pDLE1BQU07QUFBQSxNQUNSLENBQUM7QUFBQTtBQUFBLEVBRUwsR0FDQTtBQUFBLElBQ0UsT0FBTztBQUFBLElBQ1AsTUFBTSxFQUFFLE9BQU8sU0FBUztBQUFBLElBQ3hCLFVBQVU7QUFBQSxJQUdWLFVBQVUsQ0FBQyxPQUFRLE9BQU8sR0FBRyxPQUFPLFdBQVcsR0FBRyxLQUFLO0FBQUEsSUFHdkQsUUFBUSxNQUFPLFlBQVksWUFBWSxRQUFRLE9BQU8sSUFBSTtBQUFBLElBQzFELFVBQVU7QUFBQSxNQUNSLE1BQU0sR0FBRyxPQUFPLElBQUksTUFBTSxZQUFZLFlBQVksQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLEdBQUcsSUFBSSxNQUFNLEtBQUs7QUFBQSxNQUNyRixVQUFVLE1BQU0sWUFBWSxDQUFDLFFBQVEsYUFBYSxXQUFXLFFBQVEsV0FBVyxDQUFDO0FBQUEsSUFDbkY7QUFBQSxFQUNGLENBQ0Y7QUFBQTtBQUdGLFNBQVMsV0FBVyxHQUFzQztBQUFBLEVBQ3hELElBQUk7QUFBQSxJQUNGLE1BQU0sTUFBTSxhQUFhLEtBQUssWUFBWSxNQUFNLE1BQU0sa0JBQWtCLGFBQWEsR0FBRyxNQUFNO0FBQUEsSUFDOUYsTUFBTSxNQUFNLEtBQUssTUFBTSxHQUFHO0FBQUEsSUFDMUIsSUFBSSxPQUFPLElBQUksWUFBWTtBQUFBLE1BQVUsT0FBTyxFQUFFLE1BQU0sZUFBZSxTQUFTLElBQUksUUFBUTtBQUFBLElBQ3hGLE1BQU07QUFBQSxFQUdSLE9BQU8sRUFBRSxNQUFNLGVBQWUsU0FBUyxVQUFVO0FBQUE7QUFRbkQsZUFBZSxZQUFZLENBQUMsU0FBNkIsSUFBNkI7QUFBQSxFQUNwRixVQUFVLE1BQU0sUUFBUSxTQUFTLEVBQUUsQ0FBQztBQUFBO0FBSXRDLGVBQWUsU0FBUyxDQUFDLE1BQWMsTUFBMEIsU0FBNkI7QUFBQSxFQUM1RixNQUFNLE1BQU0sUUFBUSxJQUFJO0FBQUEsRUFDeEIsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsS0FBSyxTQUFTLEdBQUc7QUFBQSxJQUNqQixNQUFNO0FBQUEsSUFDTixJQUFJLGlCQUFpQixPQUFPLFdBQVc7QUFBQTtBQUFBLEVBRXpDLElBQUksQ0FBQyxHQUFHLE9BQU8sS0FBSyxDQUFDLFVBQVUsR0FBRztBQUFBLElBQ2hDLElBQUkscUNBQXFDLE9BQU8sU0FBUyxFQUFFLFNBQVMsQ0FBQyxHQUFHLGNBQWMsRUFBRSxDQUFDO0FBQUEsRUFDM0YsTUFBTSxhQUFhLFNBQVM7QUFBQSxJQUMxQixNQUFNO0FBQUEsSUFDTixNQUFNLElBQUksTUFBTSxHQUFHLEVBQUUsSUFBSTtBQUFBLElBQ3pCLE1BQU0sYUFBYSxLQUFLLE1BQU07QUFBQSxPQUMxQixTQUFTLFlBQVksRUFBRSxNQUFNLFFBQVEsSUFBSSxFQUFFLElBQUksQ0FBQztBQUFBLEVBQ3RELENBQUM7QUFBQTtBQUlILGVBQWUsWUFBWSxDQUFDLEtBQXlCLFNBQTZCO0FBQUEsRUFDaEYsSUFBSSxRQUFRO0FBQUEsSUFDVixPQUFPLGFBQWEsU0FBUyxFQUFFLE1BQU0saUJBQWlCLE1BQU0sUUFBUSxHQUFHLEVBQUUsQ0FBQztBQUFBLEVBQzVFLE1BQU0sSUFBSSxlQUFlLE9BQU87QUFBQSxFQUNoQyxRQUFRLFFBQVEsU0FBUyxNQUFNLElBQUksRUFBRSxNQUFNLE9BQU8sUUFBUTtBQUFBLEVBQzFELElBQUksV0FBVztBQUFBLElBQUssY0FBYyxhQUFhLFFBQVEsSUFBSTtBQUFBLEVBQzNELFVBQVUsRUFBRSxXQUFZLEtBQWlDLFVBQVUsQ0FBQztBQUFBO0FBc0J0RSxJQUFNLEtBQ0osQ0FBQyxNQUNELENBQUMsUUFBbUM7QUFBQSxFQUNsQyxNQUFNLFFBQVEsSUFBSTtBQUFBLEVBQ2xCLE9BQU8sRUFBRSxJQUFJLEtBQUssT0FBTyxPQUFPLE1BQU0sWUFBWSxXQUFXLE1BQU0sVUFBVSxTQUFTO0FBQUE7QUFLMUYsSUFBTSxZQUFZO0FBRWxCLElBQU0sVUFBVSxDQUFDLFNBQVM7QUFFMUIsSUFBTSxPQUFjO0FBQUEsRUFDbEI7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxXQUFXLFdBQVcsV0FBVyxlQUFlO0FBQUEsSUFDeEQsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsT0FBTyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQy9ELFVBQ0U7QUFBQSxJQUNGLEtBQUssQ0FBQyxLQUFLLFVBQVUsUUFBUSxLQUFLLEtBQUs7QUFBQSxFQUN6QztBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLE1BQU0sVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5RCxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxRQUFRLFlBQVksT0FBTyxLQUFLLE9BQU87QUFBQSxFQUNwRDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsTUFBTTtBQUFBLElBQzFCLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLE1BQU0sT0FBTyxZQUFZLFNBQVMsU0FBUyxNQUFNLFNBQVMsSUFBSTtBQUFBLEVBQ3RFO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxTQUFTLE1BQU07QUFBQSxJQUNuQyxhQUFhLENBQUM7QUFBQSxJQUNkLFVBQ0U7QUFBQSxJQUNGLEtBQUssQ0FBQyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQzdCLE1BQU0sSUFBSSxPQUFPLE1BQU0sVUFBVSxXQUFXLGVBQWUsTUFBTSxLQUFLLElBQUksRUFBRSxPQUFPLEdBQUc7QUFBQSxNQUN0RixPQUFPLFFBQVEsU0FBUyxFQUFFLE9BQU87QUFBQSxRQUMvQixNQUFNLE1BQU0sU0FBUztBQUFBLFFBQ3JCLFlBQVksT0FBTyxNQUFNLFVBQVU7QUFBQSxXQUMvQixFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsTUFBTSxJQUFJLENBQUM7QUFBQSxNQUN0QyxDQUFDO0FBQUE7QUFBQSxFQUVMO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxPQUFPLFFBQVEsU0FBUyxTQUFTLFdBQVc7QUFBQSxJQUNoRSxhQUFhLENBQUM7QUFBQSxJQUNkLFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQ25DLE1BQU0sT0FBTyxPQUFPLE1BQU0sU0FBUyxXQUFXLGFBQWEsTUFBTSxNQUFNLFFBQVEsSUFBSTtBQUFBLE1BQ25GLE1BQU0sT0FBTyxNQUFNLFVBQVUsZUFBZSxDQUFDLEdBQUcsT0FBTztBQUFBLFFBQ3JELFVBQVU7QUFBQSxRQUNWLGFBQWE7QUFBQSxNQUNmLENBQUM7QUFBQSxNQUNELFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsV0FDRixPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLFdBQzlELFNBQVMsWUFBWSxFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsV0FDakMsT0FBTyxNQUFNLFVBQVUsV0FBVyxFQUFFLE9BQU8sTUFBTSxNQUFNLElBQUksQ0FBQztBQUFBLFdBQzVELFNBQVMsWUFBWSxFQUFFLEtBQUssSUFBSSxDQUFDO0FBQUEsTUFDdkMsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxTQUFTLFdBQVc7QUFBQSxJQUN4QyxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxPQUFPLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDL0QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFDbEMsVUFDRSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sT0FBTyxNQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sS0FBSyxFQUFFLENBQUMsQ0FDcEY7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLEtBQUs7QUFBQSxJQUN6QixhQUFhLENBQUMsRUFBRSxNQUFNLE1BQU0sVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM1QyxVQUFVO0FBQUEsSUFDVixLQUFLLE9BQU8sS0FBSyxPQUFPLFlBQVk7QUFBQSxNQUNsQyxVQUNFLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sU0FBUyxhQUFhLElBQUksTUFBTSxJQUFJLGdCQUFnQjtBQUFBLFdBQ2hELE9BQU8sTUFBTSxRQUFRLFdBQVcsRUFBRSxLQUFLLE9BQU8sTUFBTSxHQUFHLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDcEUsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxTQUFTLFdBQVc7QUFBQSxJQUN4QyxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxPQUFPLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDL0QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFDbEMsVUFDRSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sY0FBYyxNQUFNLE1BQU0sWUFBWSxLQUFLLE9BQU8sTUFBTSxFQUFFLENBQUMsQ0FDNUY7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsTUFDWCxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUs7QUFBQSxNQUM3QixFQUFFLE1BQU0sVUFBVSxVQUFVLE1BQU0sVUFBVSxLQUFLO0FBQUEsSUFDbkQ7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQ25DLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixJQUFJLElBQUk7QUFBQSxRQUNSLFFBQVEsSUFBSSxNQUFNLENBQUMsRUFBRSxLQUFLLEdBQUc7QUFBQSxNQUMvQixDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsTUFDWCxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUs7QUFBQSxNQUM3QixFQUFFLE1BQU0sV0FBVyxVQUFVLE9BQU8sVUFBVSxLQUFLO0FBQUEsSUFDckQ7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQ25DLE1BQU0sVUFBVSxJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRyxFQUFFLEtBQUs7QUFBQSxNQUM1QyxVQUNFLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sSUFBSSxJQUFJO0FBQUEsV0FDSixVQUFVLEVBQUUsUUFBUSxJQUFJLENBQUM7QUFBQSxNQUMvQixDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUMsRUFBRSxNQUFNLE1BQU0sVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM1QyxVQUFVO0FBQUEsSUFDVixLQUFLLE9BQU8sS0FBSyxRQUFRLFlBQVk7QUFBQSxNQUNuQyxVQUFVLE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxlQUFlLElBQUksSUFBSSxHQUFhLENBQUMsQ0FBQztBQUFBO0FBQUEsRUFFbkY7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUM7QUFBQSxJQUNkLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxNQUFNLFFBQVEsWUFBWTtBQUFBLE1BQ3BDLFVBQVUsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGNBQWMsQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUU3RDtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsS0FBSztBQUFBLElBQ3pCLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLE1BQU0sT0FBTyxZQUFZO0FBQUEsTUFDbkMsTUFBTSxVQUNKLE9BQU8sTUFBTSxRQUFRLFdBQVcsV0FBVyxNQUFNLEtBQUssZUFBZSxJQUFJO0FBQUEsTUFDM0UsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxXQUNGLFlBQVksWUFBWSxFQUFFLFFBQVEsSUFBSSxDQUFDO0FBQUEsTUFDN0MsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxPQUFPLFNBQVMsU0FBUyxXQUFXO0FBQUEsSUFDeEQsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsT0FBTyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQy9ELFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLElBQUksT0FBTyxNQUFNLFVBQVUsWUFBWSxNQUFNLE1BQU0sS0FBSyxNQUFNO0FBQUEsUUFDNUQsSUFBSSxxRUFBZ0UsU0FBUztBQUFBLFVBQzNFLE1BQU07QUFBQSxRQUNSLENBQUM7QUFBQSxNQUNILFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixPQUFPLE1BQU07QUFBQSxRQUNiLE1BQU0sTUFBTSxZQUFZLEtBQUssT0FBTyxNQUFNO0FBQUEsV0FDdEMsT0FBTyxNQUFNLFFBQVEsV0FBVyxFQUFFLEtBQUssT0FBTyxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUNwRSxDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE9BQU8sTUFBTTtBQUFBLElBQ2pDLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLE1BQU0sT0FBTyxZQUFZO0FBQUEsTUFDbkMsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxXQUNGLE1BQU0sT0FBTyxFQUFFLEtBQUssS0FBSyxJQUFJLENBQUM7QUFBQSxXQUM5QixPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ3BFLENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsT0FBTyxTQUFTLFdBQVc7QUFBQSxJQUMvQyxhQUFhO0FBQUEsTUFDWCxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUs7QUFBQSxNQUM3QixFQUFFLE1BQU0sUUFBUSxVQUFVLE9BQU8sVUFBVSxLQUFLO0FBQUEsSUFDbEQ7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixJQUFJLElBQUk7QUFBQSxRQUNSLE1BQU0sTUFBTSxZQUFZLElBQUksTUFBTSxDQUFDLEdBQUcsT0FBTyxXQUFXO0FBQUEsV0FDcEQsT0FBTyxNQUFNLFFBQVEsV0FBVyxFQUFFLEtBQUssT0FBTyxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUNwRSxDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE9BQU8sUUFBUTtBQUFBLElBQ25DLGFBQWEsQ0FBQyxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzVDLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixJQUFJLElBQUk7QUFBQSxRQUNSLFVBQVUsQ0FBQyxNQUFNO0FBQUEsV0FDYixPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ3BFLENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsS0FBSztBQUFBLElBQ3pCLGFBQWEsQ0FBQyxFQUFFLE1BQU0sTUFBTSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzVDLFVBQVU7QUFBQSxJQUNWLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixJQUFJLElBQUk7QUFBQSxXQUNKLE9BQU8sTUFBTSxRQUFRLFdBQVcsRUFBRSxLQUFLLE9BQU8sTUFBTSxHQUFHLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDcEUsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxPQUFPLFdBQVcsT0FBTztBQUFBLElBQzdDLGFBQWEsQ0FBQyxFQUFFLE1BQU0sV0FBVyxVQUFVLEtBQUssQ0FBQztBQUFBLElBQ2pELFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLE1BQU0sSUFBSyxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ2hDLE1BQU07QUFBQSxRQUNOLFNBQVMsVUFBVSxJQUFJLE1BQU0sSUFBSSxNQUFNO0FBQUEsV0FDbkMsT0FBTyxNQUFNLFFBQVEsV0FBVyxFQUFFLEtBQUssT0FBTyxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFBQSxXQUM5RCxPQUFPLE1BQU0sWUFBWSxXQUN6QixFQUFFLFNBQVMsV0FBVyxNQUFNLFNBQVMsV0FBVyxFQUFFLElBQ2xELENBQUM7QUFBQSxNQUNQLENBQUM7QUFBQSxNQUNELElBQUksTUFBTTtBQUFBLFFBQU8sUUFBUSxPQUFPLE1BQU0sT0FBTyxFQUFFLFdBQVcsRUFBRSxDQUFDO0FBQUEsTUFDeEQ7QUFBQSxrQkFBVSxDQUFDO0FBQUE7QUFBQSxFQUVwQjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsT0FBTyxPQUFPO0FBQUEsSUFDbEMsYUFBYSxDQUFDLEVBQUUsTUFBTSxXQUFXLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDakQsVUFDRTtBQUFBLElBQ0YsS0FBSyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFDbEMsTUFBTSxVQUFVLFVBQVUsSUFBSSxNQUFNLElBQUksT0FBTztBQUFBLE1BSy9DLE1BQU0sU0FDSixPQUFPLE1BQU0sVUFBVSxXQUNuQixNQUFNLE1BQU0sTUFBTSxHQUFHLEVBQUUsSUFBSSxDQUFDLE1BQU0sV0FBVyxHQUFHLFNBQVMsQ0FBQyxJQUMxRDtBQUFBLE1BQ04sTUFBTSxRQUNKLFdBRUcsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUN0QixNQUFNO0FBQUEsUUFDTjtBQUFBLFdBQ0ksT0FBTyxNQUFNLFFBQVEsV0FBVyxFQUFFLEtBQUssT0FBTyxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUNwRSxDQUFDLEdBQ0QsT0FBTyxJQUFJLENBQUMsTUFBTSxFQUFFLEVBQUUsS0FDeEIsQ0FBQztBQUFBLE1BQ0gsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxRQUNOO0FBQUEsUUFDQTtBQUFBLFdBQ0ksT0FBTyxNQUFNLFFBQVEsV0FBVyxFQUFFLEtBQUssT0FBTyxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUM7QUFBQSxNQUNwRSxDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLEtBQUs7QUFBQSxJQUN6QixhQUFhLENBQUMsRUFBRSxNQUFNLE1BQU0sVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM1QyxVQUFVO0FBQUEsSUFDVixLQUFLLE9BQU8sS0FBSyxPQUFPLFlBQVk7QUFBQSxNQUNsQyxVQUNFLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sU0FBUyxhQUFhLElBQUksTUFBTSxJQUFJLFVBQVU7QUFBQSxXQUMxQyxPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ3BFLENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLFVBQ0U7QUFBQSxJQUNGLEtBQUssQ0FBQyxLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQzdCLE1BQU0sTUFBTSxRQUFRLElBQUksRUFBWTtBQUFBLE1BQ3BDLE9BQU8sYUFBYSxTQUFTLEVBQUUsTUFBTSxjQUFjLEtBQUssUUFBUSxHQUFHLEdBQUcsTUFBTSxTQUFTLEdBQUcsRUFBRSxDQUFDO0FBQUE7QUFBQSxFQUUvRjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQzlDLFVBQVU7QUFBQSxJQUNWLEtBQUssQ0FBQyxLQUFLLFFBQVEsWUFBWTtBQUFBLE1BQzdCLE1BQU0sTUFBTSxRQUFRLElBQUksRUFBWTtBQUFBLE1BQ3BDLE9BQU8sYUFBYSxTQUFTO0FBQUEsUUFDM0IsTUFBTTtBQUFBLFFBQ04sS0FBSyxRQUFRLEdBQUc7QUFBQSxRQUNoQixNQUFNLFNBQVMsR0FBRztBQUFBLE1BQ3BCLENBQUM7QUFBQTtBQUFBLEVBRUw7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhO0FBQUEsTUFDWCxFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUs7QUFBQSxNQUMvQixFQUFFLE1BQU0sUUFBUSxVQUFVLEtBQUs7QUFBQSxJQUNqQztBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUNqQixhQUFhLFNBQVM7QUFBQSxNQUNwQixNQUFNO0FBQUEsTUFDTixNQUFNLFFBQVEsSUFBSSxFQUFZO0FBQUEsTUFDOUIsTUFBTSxRQUFRLElBQUksRUFBWTtBQUFBLElBQ2hDLENBQUM7QUFBQSxFQUNMO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYTtBQUFBLE1BQ1gsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLO0FBQUEsTUFDL0IsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLO0FBQUEsSUFDakM7QUFBQSxJQUNBLFVBQVU7QUFBQSxJQUNWLEtBQUssQ0FBQyxLQUFLLFFBQVEsWUFDakIsYUFBYSxTQUFTLEVBQUUsTUFBTSxVQUFVLE1BQU0sUUFBUSxJQUFJLEVBQVksR0FBRyxNQUFNLElBQUksR0FBRyxDQUFDO0FBQUEsRUFDM0Y7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5QyxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxRQUFRLFlBQ2pCLGFBQWEsU0FBUyxFQUFFLE1BQU0sUUFBUSxNQUFNLFFBQVEsSUFBSSxFQUFZLEVBQUUsQ0FBQztBQUFBLEVBQzNFO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDLEVBQUUsTUFBTSxTQUFTLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDL0MsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssUUFBUSxZQUFZLGFBQWEsU0FBUyxFQUFFLE1BQU0sVUFBVSxPQUFPLElBQUksR0FBRyxDQUFDO0FBQUEsRUFDeEY7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxLQUFLLENBQUM7QUFBQSxJQUM5QyxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsS0FBSyxRQUFRLFlBQ2pCLGFBQWEsU0FBUyxFQUFFLE1BQU0sWUFBWSxNQUFNLFFBQVEsSUFBSSxFQUFZLEVBQUUsQ0FBQztBQUFBLEVBQy9FO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxNQUFNO0FBQUEsSUFDMUIsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFBVTtBQUFBLElBQ1YsS0FBSyxDQUFDLEtBQUssT0FBTyxZQUNoQixVQUFVLElBQUksSUFBYyxPQUFPLE1BQU0sU0FBUyxXQUFXLE1BQU0sT0FBTyxXQUFXLE9BQU87QUFBQSxFQUNoRztBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQyxFQUFFLE1BQU0sT0FBTyxVQUFVLE1BQU0sQ0FBQztBQUFBLElBQzlDLFVBQVU7QUFBQSxJQUNWLEtBQUssQ0FBQyxLQUFLLFFBQVEsWUFBWSxhQUFhLElBQUksSUFBSSxPQUFPO0FBQUEsRUFDN0Q7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUEsSUFDUCxhQUFhLENBQUMsRUFBRSxNQUFNLFFBQVEsVUFBVSxNQUFNLENBQUM7QUFBQSxJQUMvQyxVQUFVO0FBQUEsSUFDVixLQUFLLE9BQU8sS0FBSyxRQUFRLFlBQVk7QUFBQSxNQUNuQyxVQUNFLE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFdBQ0YsSUFBSSxPQUFPLFlBQVksRUFBRSxNQUFNLFFBQVEsSUFBSSxFQUFFLEVBQUUsSUFBSSxDQUFDO0FBQUEsTUFDMUQsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxRQUFRLFVBQVUsYUFBYSxPQUFPLE9BQU87QUFBQSxJQUNqRSxhQUFhLENBQUM7QUFBQSxJQUNkLFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQ25DLE1BQU0sU0FBaUMsQ0FBQztBQUFBLE1BQ3hDLFdBQVcsS0FBSyxDQUFDLFFBQVEsVUFBVSxhQUFhLEtBQUs7QUFBQSxRQUNuRCxJQUFJLE9BQU8sTUFBTSxPQUFPO0FBQUEsVUFBVSxPQUFPLEtBQUssTUFBTTtBQUFBLE1BQ3RELElBQUksT0FBTyxNQUFNLFVBQVU7QUFBQSxRQUFVLE9BQU8sUUFBUSxlQUFlLE1BQU0sS0FBSztBQUFBLE1BQzlFLFVBQVUsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLFFBQVEsT0FBTyxDQUFDLENBQUM7QUFBQTtBQUFBLEVBRTlEO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTyxDQUFDLEdBQUcsU0FBUyxPQUFPO0FBQUEsSUFDM0IsYUFBYSxDQUFDLEVBQUUsTUFBTSxTQUFTLFVBQVUsTUFBTSxVQUFVLEtBQUssQ0FBQztBQUFBLElBQy9ELFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxLQUFLLE9BQU8sWUFBWTtBQUFBLE1BQ2xDLE1BQU0sUUFDSixPQUFPLE1BQU0sVUFBVSxXQUFXLFdBQVcsTUFBTSxPQUFPLGdCQUFnQixJQUFJO0FBQUEsTUFDaEYsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxRQUNOLE9BQU8sSUFBSSxLQUFLLEdBQUc7QUFBQSxXQUNmLFVBQVUsWUFBWSxFQUFFLE1BQU0sSUFBSSxDQUFDO0FBQUEsTUFDekMsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDO0FBQUEsSUFDZCxVQUNFO0FBQUEsSUFDRixLQUFLLE9BQU8sTUFBTSxRQUFRLFlBQVk7QUFBQSxNQUNwQyxVQUFVLE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxTQUFTLENBQUMsQ0FBQztBQUFBO0FBQUEsRUFFeEQ7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLEtBQUs7QUFBQSxJQUN6QixhQUFhLENBQUM7QUFBQSxJQUNkLFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQ25DLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsV0FDRixPQUFPLE1BQU0sUUFBUSxXQUFXLEVBQUUsS0FBSyxPQUFPLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQztBQUFBLE1BQ3BFLENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsT0FBTztBQUFBLElBQzNCLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLE1BQU0sT0FBTyxZQUFZO0FBQUEsTUFDbkMsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxXQUNGLE9BQU8sTUFBTSxVQUFVLFdBQVcsRUFBRSxPQUFPLE1BQU0sTUFBTSxJQUFJLENBQUM7QUFBQSxNQUNsRSxDQUFDLENBQ0g7QUFBQTtBQUFBLEVBRUo7QUFBQSxFQUNBO0FBQUEsSUFDRSxNQUFNO0FBQUEsSUFDTixPQUFPLENBQUMsR0FBRyxTQUFTLE9BQU87QUFBQSxJQUMzQixhQUFhLENBQUM7QUFBQSxJQUNkLFVBQ0U7QUFBQSxJQUNGLEtBQUssT0FBTyxNQUFNLE9BQU8sWUFBWTtBQUFBLE1BQ25DLFVBQ0UsTUFBTSxRQUFRLFNBQVM7QUFBQSxRQUNyQixNQUFNO0FBQUEsV0FDRixPQUFPLE1BQU0sVUFBVSxXQUFXLEVBQUUsT0FBTyxNQUFNLE1BQU0sSUFBSSxDQUFDO0FBQUEsTUFDbEUsQ0FBQyxDQUNIO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLEtBQUssUUFBUSxZQUFZO0FBQUEsTUFDbkMsVUFBVSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sYUFBYSxNQUFNLFFBQVEsSUFBSSxFQUFZLEVBQUUsQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUU1RjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU8sQ0FBQyxHQUFHLFNBQVMsUUFBUSxJQUFJO0FBQUEsSUFDaEMsYUFBYSxDQUFDLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSyxDQUFDO0FBQUEsSUFDOUMsVUFDRTtBQUFBLElBQ0YsS0FBSyxPQUFPLEtBQUssT0FBTyxZQUFZO0FBQUEsTUFDbEMsVUFDRSxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxRQUNOLE1BQU0sUUFBUSxJQUFJLEVBQVk7QUFBQSxXQUMxQixPQUFPLE1BQU0sU0FBUyxXQUFXLEVBQUUsVUFBVSxNQUFNLEtBQUssSUFBSSxDQUFDO0FBQUEsV0FDN0QsT0FBTyxNQUFNLE9BQU8sV0FBVyxFQUFFLElBQUksTUFBTSxHQUFHLElBQUksQ0FBQztBQUFBLE1BQ3pELENBQUMsQ0FDSDtBQUFBO0FBQUEsRUFFSjtBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWE7QUFBQSxNQUNYLEVBQUUsTUFBTSxRQUFRLFVBQVUsS0FBSztBQUFBLE1BQy9CLEVBQUUsTUFBTSxhQUFhLFVBQVUsTUFBTSxVQUFVLEtBQUs7QUFBQSxJQUN0RDtBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLEtBQUssUUFBUSxZQUFZO0FBQUEsTUFDbkMsTUFBTSxTQUFpQyxDQUFDO0FBQUEsTUFDeEMsV0FBVyxRQUFRLElBQUksTUFBTSxDQUFDLEdBQUc7QUFBQSxRQUMvQixNQUFNLEtBQUssS0FBSyxRQUFRLEdBQUc7QUFBQSxRQUMzQixJQUFJLE1BQU07QUFBQSxVQUNSLElBQUksSUFBSSwwQkFBMEIsU0FBUztBQUFBLFlBQ3pDLE1BQU07QUFBQSxVQUNSLENBQUM7QUFBQSxRQUNILE9BQU8sS0FBSyxNQUFNLEdBQUcsRUFBRSxLQUFLLEtBQUssTUFBTSxLQUFLLENBQUM7QUFBQSxNQUMvQztBQUFBLE1BQ0EsVUFDRSxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sWUFBWSxNQUFNLFFBQVEsSUFBSSxFQUFZLEdBQUcsT0FBTyxDQUFDLENBQ3RGO0FBQUE7QUFBQSxFQUVKO0FBQUEsRUFDQTtBQUFBLElBQ0UsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBLElBQ1AsYUFBYSxDQUFDO0FBQUEsSUFDZCxVQUFVO0FBQUEsSUFDVixLQUFLLENBQUMsTUFBTSxRQUFRLFlBQVk7QUFBQSxNQUM5QixVQUFVLGVBQWUsT0FBTyxDQUFDO0FBQUE7QUFBQSxFQUVyQztBQUFBLEVBQ0E7QUFBQSxJQUNFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLGFBQWEsQ0FBQztBQUFBLElBQ2QsVUFBVTtBQUFBLElBQ1YsS0FBSyxPQUFPLE1BQU0sUUFBUSxZQUFZO0FBQUEsTUFDcEMsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUFBLE1BQ3hDLFVBQVUsRUFBRSxJQUFJLE1BQU0sTUFBTSxRQUFRLENBQUM7QUFBQTtBQUFBLEVBRXpDO0FBQ0Y7QUFJTyxJQUFNLE1BQU0sVUFBVTtBQUFBLEVBQzNCLE1BQU07QUFBQSxFQUNOLFNBQVM7QUFBQSxFQUNULFNBQVM7QUFBQSxFQUNULFVBQVUsS0FBSyxJQUFJLENBQUMsT0FBTyxLQUFLLEdBQUcsS0FBSyxHQUFHLEVBQUUsR0FBRyxHQUFHLFlBQVksVUFBVSxFQUFFO0FBQUEsRUFHM0UsU0FBUztBQUFBLEVBQ1QsZ0JBQWdCO0FBQUEsRUFDaEIsWUFBWSxDQUFDLFNBQVM7QUFBQSxFQUN0QixTQUFTO0FBQUEsRUFDVCxZQUFZO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsSUFPVjtBQUNKLENBQUM7QUFFTSxJQUFNLFFBQTJCLElBQUk7QUFDckMsSUFBTSxZQUErQyxPQUFPLFlBQ2pFLElBQUksS0FBSyxJQUFJLENBQUMsTUFBTSxDQUFDLEVBQUUsTUFBTSxFQUFFLFFBQVEsQ0FBQyxDQUMxQztBQUNPLElBQU0sV0FBVyxDQUFDLFNBQTJCLElBQUksU0FBUyxJQUFJO0FBQzlELElBQU0sbUJBQXNDLElBQUk7QUFLdkQsZUFBZSxJQUFJLENBQUMsTUFBaUM7QUFBQSxFQUNuRCxJQUFJO0FBQUEsSUFDRixPQUFPLE1BQU0sSUFBSSxTQUFTLElBQUk7QUFBQSxJQUM5QixPQUFPLEdBQUc7QUFBQSxJQUNWLE1BQU0sV0FBVyxlQUFlLENBQUM7QUFBQSxJQUNqQyxJQUFJLGFBQWE7QUFBQSxNQUFNLE9BQU87QUFBQSxJQUM5QixNQUFNLE9BQ0osS0FBSyxPQUFPLE1BQU0sWUFBWSxVQUFVLElBQUksT0FBUSxFQUF3QixJQUFJLElBQUk7QUFBQSxJQUN0RixNQUFNLE1BQU0sYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxJQUNyRCxJQUFJLFNBQVM7QUFBQSxNQUFVLE9BQU8sZUFBZSxJQUFJLFdBQVcsR0FBRyxDQUFDLEtBQUs7QUFBQSxJQUNyRSxPQUFPLGVBQWUsSUFBSSxTQUFTLFlBQVksR0FBRyxDQUFDLEtBQUs7QUFBQTtBQUFBO0FBUzVELGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkIzRDBCQzA1MTY1OTc5NjI2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
