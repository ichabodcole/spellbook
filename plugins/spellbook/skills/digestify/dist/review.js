#!/usr/bin/env bun
// @bun
var __require = import.meta.require;

// src/digestify/backend/review.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { basename, dirname, join as join2 } from "path";
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
var EXIT_IDLE_TIMEOUT = 124;
var EXIT_CANCELLED = 130;
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

// src/kit/wire/housekeeping.ts
function shouldIdleClose(subscriberCount, idleMs, timeoutMs) {
  if (timeoutMs <= 0)
    return false;
  if (subscriberCount > 0)
    return false;
  return idleMs >= timeoutMs;
}
var TIMER_MAX_S = Math.floor((2 ** 31 - 1) / 1000);

// src/kit/wire/origin.ts
function ours(port) {
  if (typeof port !== "number" || !Number.isFinite(port))
    return [];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}
function sameOrigin(req, port) {
  const origin = req.headers.get("origin");
  if (origin === null)
    return true;
  return ours(port).includes(origin);
}
function refuseForeignOrigin(req, port, boundHost) {
  if (!ownHost(req, port, boundHost))
    return Response.json({ ok: false, error: "foreign host refused" }, { status: 403 });
  if (sameOrigin(req, port))
    return null;
  return Response.json({ ok: false, error: "foreign origin refused" }, { status: 403 });
}
function ownHost(req, port, boundHost) {
  const host = req.headers.get("host");
  if (host === null)
    return true;
  if (typeof port !== "number" || !Number.isFinite(port))
    return false;
  const names = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (boundHost) {
    const bound = boundHost.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    names.push(bound.includes(":") ? `[${bound}]:${port}` : `${bound}:${port}`);
  }
  return names.includes(host.toLowerCase());
}

// src/kit/wire/serveDist.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
function resolveMode(distDir) {
  const override = process.env.SPELLBOOK_SURFACE_MODE;
  if (override === "dev" || override === "release")
    return override;
  return existsSync(join(distDir, "index.html")) ? "release" : "dev";
}
var STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
function contentTypeFor(nameOrExt) {
  const dot = nameOrExt.lastIndexOf(".");
  const ext = dot === -1 ? "" : nameOrExt.slice(dot);
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}
function serveFromDist(distDir, rel) {
  if (!rel || rel.includes("..") || rel.includes("/"))
    return null;
  if (!surfaceWhitelist(distDir).has(rel))
    return null;
  const file = join(distDir, rel);
  if (!existsSync(file))
    return null;
  return new Response(Bun.file(file), { headers: { "Content-Type": contentTypeFor(rel) } });
}
var ENTRY_REF_RE = /(?:src|href)\s*=\s*"(?:\.\/)?([^"]+)"/g;
var RELATIVE_REF_RE = /["'(]\.\/([^"'()\s]+)["')]/g;
var TRANSITIVE_EXTS = [".js", ".css"];
var whitelistCache = new Map;
function refsIn(text, re) {
  return [...text.matchAll(re)].map(([, ref]) => ref).filter((ref) => !!ref && !ref.includes("/") && !ref.includes("..") && !ref.includes(":") && !ref.startsWith("#") && !ref.startsWith("?"));
}
function surfaceWhitelist(distDir) {
  const cached = whitelistCache.get(distDir);
  if (cached)
    return cached;
  const names = new Set;
  const entry = join(distDir, "index.html");
  if (existsSync(entry)) {
    names.add("index.html");
    const html = readFileSync(entry, "utf8");
    const pending = [...refsIn(html, ENTRY_REF_RE), ...refsIn(html, RELATIVE_REF_RE)];
    while (pending.length > 0) {
      const name = pending.pop();
      if (names.has(name))
        continue;
      const file = join(distDir, name);
      if (!existsSync(file))
        continue;
      names.add(name);
      if (!TRANSITIVE_EXTS.some((ext) => name.endsWith(ext)))
        continue;
      pending.push(...refsIn(readFileSync(file, "utf8"), RELATIVE_REF_RE));
    }
  }
  whitelistCache.set(distDir, names);
  return names;
}

// src/digestify/backend/review.ts
var SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
var SKILL_ROOT = join2(SCRIPT_DIR, "..");
var DIST_DIR = join2(SKILL_ROOT, "dist");
function resolveMode2() {
  return resolveMode(DIST_DIR);
}
var TAILWIND_PLUGIN = "bun-plugin-tailwind";
var DEV_SURFACE_ROUTE = "/__surface";
function serveDist(path) {
  const rel = path.slice(1);
  if (rel === "index.html")
    return null;
  return serveFromDist(DIST_DIR, rel);
}
function classifyDeparture(pageServed, departure) {
  if (!pageServed)
    return "never-opened";
  if (departure === null)
    return "opened-then-silent";
  return departure.engaged ? "engaged-then-left" : "read-then-left";
}
var QBLOCK_RE = /^:::\s*question([^\n]*)\n([\s\S]*?)\n:::\s*$/gm;
var ID_RE = /\bid\s*=\s*([A-Za-z0-9_-]*)/;
var PORT_SUFFIX_RE = /-p(\d{2,5})$/;
var VALID_THEMES = ["digestify", "cthulhu", "classic"];
function parseQuestions(markdown) {
  const questions = [];
  const seen = new Set;
  const transformed = markdown.replace(QBLOCK_RE, (_m, attrs, body) => {
    const idMatch = (attrs || "").match(ID_RE);
    if (!idMatch?.[1]) {
      throw new Error("question block missing or has empty id; expected '::: question id=<name>'");
    }
    const qid = idMatch[1];
    if (seen.has(qid))
      throw new Error(`duplicate question id: '${qid}'`);
    seen.add(qid);
    const bodyTrim = body.trim();
    if (!bodyTrim)
      throw new Error(`question id='${qid}' has empty body`);
    questions.push({ id: qid, prompt: bodyTrim });
    return `

<div data-qblock="${qid}"></div>

`;
  });
  return { transformed, questions };
}
function buildPayload(markdown, opts) {
  const { transformed, questions } = parseQuestions(markdown);
  return {
    title: opts.title,
    theme: opts.theme,
    markdown: transformed,
    questions,
    session_id: opts.sessionId,
    timeout_seconds: opts.timeout
  };
}
function parsePortFromSessionId(sid) {
  if (!sid)
    return null;
  const m = sid.match(PORT_SUFFIX_RE);
  if (!m)
    return null;
  const digits = m[1];
  if (digits === undefined)
    return null;
  const port = parseInt(digits, 10);
  return port >= 1 && port <= 65535 ? port : null;
}
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
async function readStdinWithTimeout(ms = 100) {
  if (process.stdin.isTTY)
    return "";
  const reader = Bun.stdin.stream().getReader();
  try {
    const TIMEOUT = Symbol("timeout");
    const timer = new Promise((res) => setTimeout(() => res(TIMEOUT), ms));
    const first = await Promise.race([reader.read(), timer]);
    if (first === TIMEOUT)
      return "";
    if (first.done)
      return "";
    const chunks = [first.value];
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      if (value)
        chunks.push(value);
    }
    let total = 0;
    for (const c of chunks)
      total += c.byteLength;
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder("utf-8").decode(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
async function readInput(args) {
  let referenceContent = "";
  let refLabel = "";
  if (args.reference) {
    referenceContent = await Bun.file(args.reference).text();
    refLabel = basename(args.reference);
  }
  let agentContent = await readStdinWithTimeout(100);
  if (!agentContent && args.file) {
    agentContent = await Bun.file(args.file).text();
  }
  const parts = [];
  if (referenceContent.trim()) {
    parts.push(`> Reference: \`${refLabel}\`

${referenceContent.replace(/\s+$/, "")}`);
  }
  if (agentContent.trim()) {
    if (parts.length > 0) {
      const labelAttr = htmlEscape(refLabel);
      parts.push(`<div data-refboundary="${labelAttr}"></div>

${agentContent.replace(/\s+$/, "")}`);
    } else {
      parts.push(agentContent.replace(/\s+$/, ""));
    }
  }
  return parts.join(`

`);
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn({ cmd, stdout: "ignore", stderr: "ignore" });
  } catch {}
}
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function isoZNoMillis(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
var MIME_BY_EXT = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf"
};
function guessMime(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
var CLI_OPTIONS = {
  file: { type: "string" },
  reference: { type: "string" },
  title: { type: "string", default: "Document Review" },
  theme: { type: "string", default: "digestify" },
  timeout: { type: "string", default: "1800" },
  "no-open": { type: "boolean", default: false },
  port: { type: "string", default: "0" },
  host: { type: "string", default: "127.0.0.1" },
  id: { type: "string" }
};
async function runReview(v) {
  const theme = v.theme;
  if (!VALID_THEMES.includes(theme)) {
    die(`invalid --theme '${theme}'`, "usage", { choices: [...VALID_THEMES] });
  }
  const timeout = parseFloat(v.timeout);
  let port = parseInt(v.port, 10);
  const host = v.host;
  let sessionId = v.id ?? "";
  if (port === 0 && sessionId) {
    const embedded = parsePortFromSessionId(sessionId);
    if (embedded !== null)
      port = embedded;
  }
  let markdown;
  try {
    markdown = await readInput({
      file: v.file,
      reference: v.reference
    });
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      const path = "path" in e ? e.path : undefined;
      die(`file not found: ${path ?? "<unknown>"}`, "not_found");
    }
    throw e;
  }
  if (!markdown.trim()) {
    die("no markdown provided on stdin, --file, or --reference", "usage", {
      hint: "pipe the document on stdin, or pass --file PATH / --reference PATH"
    });
  }
  let payload;
  try {
    payload = buildPayload(markdown, {
      title: v.title,
      theme,
      sessionId: sessionId || "__TBD__",
      timeout
    });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e), "usage");
  }
  const mode = resolveMode2();
  const DEV_SURFACE_CWD = join2(SKILL_ROOT, "..", "..", "..", "..", "src", "digestify");
  let devIndex;
  if (mode === "dev") {
    const bunfig = join2(process.cwd(), "bunfig.toml");
    const loadsTailwind = existsSync2(bunfig) && readFileSync2(bunfig, "utf8").includes(TAILWIND_PLUGIN);
    if (!loadsTailwind) {
      die("digestify: cannot start in dev mode from this directory", "usage", {
        hint: `cwd: ${process.cwd()}
` + `needed: a cwd whose bunfig.toml loads ${TAILWIND_PLUGIN} \u2014 in a checkout of ` + `this repo that is ${DEV_SURFACE_CWD}
` + "why: Bun reads bunfig.toml from the process cwd, at STARTUP \u2014 chdir is too " + "late. Without the plugin the stylesheet never compiles and the page is served " + `unstyled, or as Bun's own build-failure page, with nothing red anywhere.
` + "A published spell ships a built dist/ and resolves to release mode; dev mode " + "needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from that directory."
      });
    }
    try {
      devIndex = (await import("../../../../../src/digestify/surface/index.html")).default;
    } catch (e) {
      die("digestify: cannot start in dev mode \u2014 the surface source is missing", "not_found", {
        hint: `needed: src/digestify/surface/index.html (relative to the repo root)
reason: ${e instanceof Error ? e.message : String(e)}
A published spell ships a built dist/ and resolves to release mode; dev mode needs the repo. Unset SPELLBOOK_SURFACE_MODE, or run from a checkout.`
      });
    }
  }
  const releaseTemplate = mode === "release" ? await Bun.file(join2(DIST_DIR, "index.html")).text() : "";
  const assetsDir = join2(SKILL_ROOT, "assets");
  let substitute = (html) => html;
  let heartbeatAt = performance.now();
  let departure = null;
  let pageServed = false;
  let resolveDone;
  const done = new Promise((res) => {
    resolveDone = res;
  });
  let server;
  try {
    server = Bun.serve({
      port,
      hostname: host,
      routes: devIndex ? { [DEV_SURFACE_ROUTE]: devIndex } : {},
      fetch: async (req, srv) => {
        {
          const refused = refuseForeignOrigin(req, srv.port, srv.hostname);
          if (refused)
            return refused;
        }
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;
        if (method === "GET" && path === "/") {
          pageServed = true;
          const source = mode === "dev" ? await (await fetch(`http://${host}:${server.port}${DEV_SURFACE_ROUTE}`)).text() : releaseTemplate;
          return new Response(substitute(source), {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }
        if (method === "GET" && mode === "release") {
          const asset = serveDist(path);
          if (asset)
            return asset;
        }
        if (method === "GET" && path.startsWith("/assets/")) {
          const assetName = decodeURIComponent(path.slice("/assets/".length));
          if (assetName.includes("..") || assetName.startsWith("/")) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          const f = Bun.file(join2(assetsDir, assetName));
          if (!await f.exists()) {
            return new Response('{"error":"not found"}', {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }
          return new Response(f, { headers: { "Content-Type": guessMime(assetName) } });
        }
        if (method === "POST" && path === "/submit") {
          let body;
          try {
            body = await req.json();
          } catch {
            return new Response('{"error":"invalid json"}', {
              status: 400,
              headers: { "Content-Type": "application/json" }
            });
          }
          resolveDone({ code: 0, data: body });
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        if (method === "POST" && path === "/left") {
          try {
            const b = await req.json();
            const named = typeof b.sessionId === "string" ? b.sessionId : null;
            departure = {
              engaged: b.engaged === true,
              elapsedMs: typeof b.elapsedMs === "number" ? b.elapsedMs : null,
              answered: typeof b.answered === "number" ? b.answered : null,
              commented: typeof b.commented === "number" ? b.commented : null,
              stale: named !== null && named !== sessionId
            };
          } catch {
            departure = {
              engaged: false,
              elapsedMs: null,
              answered: null,
              commented: null,
              stale: false
            };
          }
          return new Response(null, { status: 204 });
        }
        if (method === "POST" && path === "/cancel") {
          let named = null;
          try {
            const b = await req.json();
            if (typeof b.sessionId === "string")
              named = b.sessionId;
          } catch {}
          if (named !== null && named !== sessionId) {
            process.stderr.write(`${JSON.stringify({ event: "stale_cancel_ignored", named, current: sessionId })}
`);
            return new Response('{"ok":true,"ignored":"stale-session"}', {
              headers: { "Content-Type": "application/json" }
            });
          }
          resolveDone({ code: EXIT_CANCELLED, data: null });
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        if (method === "POST" && path === "/heartbeat") {
          heartbeatAt = performance.now();
          process.stderr.write(`${JSON.stringify({ event: "heartbeat", at: Math.round(heartbeatAt / 10) / 100 })}
`);
          return new Response('{"ok":true}', { headers: { "Content-Type": "application/json" } });
        }
        return new Response('{"error":"not found"}', {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    });
  } catch (e) {
    die("could not bind the review server", "conflict", {
      hint: `host=${host} port=${port}: ${e instanceof Error ? e.message : String(e)}`
    });
  }
  const boundPort = server.port;
  if (!sessionId) {
    sessionId = `digestify-${randHex(4)}-p${boundPort}`;
  }
  payload.session_id = sessionId;
  const payloadJson = JSON.stringify(payload).replace(/<\//g, "<\\/");
  const escapedTitle = htmlEscape(payload.title);
  substitute = (html) => html.replace("__TITLE__", escapedTitle).replace("__PAYLOAD__", payloadJson);
  const readyUrl = `http://${host}:${boundPort}`;
  process.stderr.write(`${JSON.stringify({ url: readyUrl, port: boundPort, session_id: sessionId, mode })}
`);
  if (!v["no-open"])
    openBrowser(readyUrl);
  const timeoutMs = timeout * 1000;
  const idleTimer = setInterval(() => {
    if (shouldIdleClose(0, performance.now() - heartbeatAt, timeoutMs)) {
      resolveDone({ code: EXIT_IDLE_TIMEOUT, data: null });
    }
  }, 50);
  const { code, data } = await done;
  clearInterval(idleTimer);
  if (code === 0)
    await new Promise((r) => setTimeout(r, 700));
  await server.stop();
  if (code === 0 && data !== null && typeof data === "object") {
    const response = {
      answers: data.answers ?? {},
      comments: data.comments ?? [],
      submitted_at: isoZNoMillis(new Date)
    };
    process.stdout.write(`${JSON.stringify(response)}
`);
  } else {
    const observed = classifyDeparture(pageServed, departure);
    process.stdout.write(`${JSON.stringify({
      submitted: false,
      exit: code,
      reason: code === EXIT_IDLE_TIMEOUT ? "idle-timeout" : "closed-without-submitting",
      observed,
      pageServed,
      departure,
      timeoutSeconds: timeout,
      ended_at: isoZNoMillis(new Date)
    })}
`);
  }
  return code;
}
function versionInfo() {
  try {
    const raw = readFileSync2(join2(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "digestify", version: pkg.version };
  } catch {}
  return { name: "digestify", version: "unknown" };
}
var cli = defineCli({
  name: "digestify",
  summary: "a one-shot browser review; prints the human's answers as JSON.",
  options: CLI_OPTIONS,
  root: {
    flags: Object.keys(CLI_OPTIONS),
    positionals: [],
    allowPositionals: false,
    describe: "review the markdown on stdin (or --file / --reference) in the browser",
    run: (inv) => {
      setCurrentCommand("review");
      return runReview(inv.flags);
    }
  },
  version: versionInfo,
  helpFooter: `  Reads the document on stdin unless --file is given; --reference prepends a
  file's body. Serves a local page, waits for the human to submit, then prints
  ONE JSON document on stdout: {answers, comments, submitted_at}.

  Flags: --file PATH, --reference PATH, --title TEXT (default "Document Review"),
  --theme <digestify|cthulhu|classic>, --timeout SECONDS (idle; default 1800,
  0 = never), --no-open, --port N (default: a free port), --host HOST
  (default: loopback), --id SLUG (a session id to recover).

  Exit codes: 0 submitted, 124 idle timeout, 130 tab closed after typing
  (session outcomes, one JSON line on stdout). Failures are one JSON envelope on
  stderr: 2 usage, 5 not found, 6 the server could not start. 1 is an
  unclassified throw, with its stack and no envelope.`
});
var RECOGNIZED_FLAGS = cli.flagsFor("");
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
async function run() {
  return await main(process.argv.slice(2));
}
export {
  RECOGNIZED_FLAGS,
  buildPayload,
  classifyDeparture,
  cli,
  htmlEscape,
  isoZNoMillis,
  main,
  parsePortFromSessionId,
  parseQuestions,
  resolveMode2 as resolveMode,
  run
};
