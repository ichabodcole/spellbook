#!/usr/bin/env bun
// @bun

// src/astrolabe/backend/cli.ts
import { spawn } from "child_process";
import { closeSync, existsSync as existsSync2, openSync, readFileSync as readFileSync2, unlinkSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname as dirname2, join as join2 } from "path";
import { fileURLToPath } from "url";

// plugins/spellbook/skills/astrolabe/scripts/state.ts
function emptyState(title = "Observatory") {
  return { title, projects: [], presence: {}, status: {} };
}
var AVATAR_GLYPHS = ["\uD83D\uDD2D", "\uD83E\uDE84", "\uD83C\uDF3F", "\uD83D\uDD2E", "\u26A1", "\uD83D\uDEF0\uFE0F", "\u2728", "\uD83E\uDDED", "\uD83D\uDCE1", "\uD83D\uDDFA\uFE0F", "\u2B50", "\uD83C\uDF19"];
function hashString(s) {
  let h = 0;
  for (const ch of s)
    h = h * 31 + (ch.codePointAt(0) ?? 0) >>> 0;
  return h;
}
function fallbackAvatar(name) {
  const glyph = AVATAR_GLYPHS[hashString(name.trim().toLowerCase()) % AVATAR_GLYPHS.length];
  if (glyph === undefined)
    return "\uD83D\uDD2D";
  return glyph;
}
function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
var normName = (s) => s.trim().toLowerCase();
var normPath = (s) => s.trim().replace(/\/+$/, "");
function findDuplicate(state, name, path, exceptId) {
  const n = normName(name);
  const p = normPath(path);
  return state.projects.find((pr) => pr.id !== exceptId && (normName(pr.name) === n || normPath(pr.path) === p));
}
var hasProject = (state, id) => state.projects.some((p) => p.id === id);
function validateProject(p) {
  if (!p || typeof p !== "object")
    return null;
  const o = p;
  if (typeof o.name !== "string" || o.name.trim() === "")
    return null;
  if (typeof o.path !== "string" || o.path.trim() === "")
    return null;
  const out = { id: typeof o.id === "string" ? o.id : "", name: o.name, path: o.path };
  if (typeof o.description === "string")
    out.description = o.description;
  if (typeof o.avatar === "string")
    out.avatar = o.avatar;
  return out;
}
function registryShapeError(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    return "not a JSON object";
  if (!Array.isArray(snapshot.projects))
    return "`projects` is not an array";
  return null;
}
function restoreRegistry(snapshot, title = "Observatory") {
  let state = emptyState(title);
  if (!snapshot || typeof snapshot !== "object")
    return state;
  const snap = snapshot;
  if (typeof snap.title === "string")
    state = { ...state, title: snap.title };
  if (Array.isArray(snap.projects)) {
    for (const raw of snap.projects) {
      const p = validateProject(raw);
      if (p)
        state = applyProjectAdd(state, p).state;
    }
  }
  return state;
}
function applyProjectAdd(state, project) {
  const name = project.name?.trim();
  const path = project.path?.trim();
  if (!name || !path) {
    return { state, applied: false, error: "project requires a name and path" };
  }
  const id = project.id?.trim() || slugify(name);
  if (hasProject(state, id)) {
    return { state, applied: false, error: `id '${id}' already registered` };
  }
  const dup = findDuplicate(state, name, path);
  if (dup) {
    return { state, applied: false, error: `duplicate of '${dup.id}' (same name or path)` };
  }
  const registered = {
    ...project,
    id,
    name,
    path,
    avatar: project.avatar?.trim() || fallbackAvatar(name)
  };
  return {
    state: {
      ...state,
      projects: [...state.projects, registered],
      presence: { ...state.presence, [id]: { connected: false } }
    },
    applied: true,
    id
  };
}

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

// src/astrolabe/backend/heartbeat.ts
var IDLE_TIMEOUT_SEC = idleTimeoutSec(process.env.ASTROLABE_IDLE_TIMEOUT);
var SSE_HEARTBEAT_MS = heartbeatMs(process.env.ASTROLABE_HEARTBEAT_MS, IDLE_TIMEOUT_SEC, 1e4);
var TAIL_IDLE_MS = tailIdleMs(SSE_HEARTBEAT_MS);

// src/astrolabe/backend/registryFile.ts
import { existsSync, readdirSync, readFileSync, renameSync } from "fs";
import { basename, dirname, join } from "path";
var errMessage2 = (e) => e instanceof Error ? e.message : String(e);
function causeOfReadError(e) {
  const code = e.code;
  if (code === "EISDIR")
    return "directory";
  if (code === "EACCES" || code === "EPERM")
    return "permissions";
  return "json";
}
function readRegistry(file, title) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT")
      return { ok: true, state: emptyState(title) };
    return { ok: false, reason: errMessage2(e), cause: causeOfReadError(e) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${errMessage2(e)}`, cause: "json" };
  }
  const shape = registryShapeError(parsed);
  if (shape)
    return { ok: false, reason: shape, cause: "json" };
  return { ok: true, state: restoreRegistry(parsed, title) };
}
function repairAct(path, cause) {
  switch (cause) {
    case "permissions":
      return `fix the permissions on ${path} so you can read it (e.g. \`chmod u+rw ${path}\`)`;
    case "directory":
      return `${path} is a directory, not a file: move its contents out (a registry file inside it can be put back in its place) or delete it`;
    case "json":
      return `fix the JSON in ${path}`;
  }
}
var MARK = ".unreadable-";
function listSetAside(file) {
  const prefix = `${basename(file)}${MARK}`;
  try {
    return readdirSync(dirname(file)).filter((n) => n.startsWith(prefix)).sort().map((n) => join(dirname(file), n));
  } catch {
    return [];
  }
}
function recoverAct(aside, file) {
  const read = readRegistry(aside);
  const keep = `or, to keep the current board, delete ${aside}`;
  const back = `(this replaces anything registered since) and run \`cli.ts open\``;
  if (!read.ok && read.cause === "directory")
    return `run \`cli.ts close\`; ${aside} is a directory, not a file: move its contents out (a registry file inside it can be moved to ${file} ${back}); ${keep}`;
  const repair = read.ok ? "" : `${repairAct(aside, read.cause)}, `;
  return `run \`cli.ts close\`, ${repair}then move it back to ${file} ${back}; ${keep}`;
}

// src/astrolabe/backend/cli.ts
var SCRIPT_DIR = dirname2(fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join2(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join2(SCRIPT_DIR, "..");
var DIST_DIR = join2(SKILL_ROOT, "dist");
var SURFACE_CWD = join2(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "astrolabe");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync2(join2(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var ASTROLABE_HOME = process.env.ASTROLABE_HOME ?? join2(homedir(), ".astrolabe");
var PORT_FILE = join2(ASTROLABE_HOME, "daemon.port");
var REGISTRY_FILE = join2(ASTROLABE_HOME, "registry.json");
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function resolveAs(flags) {
  const v = flags.as ?? flags.from;
  if (typeof v === "string" && v.trim())
    return v.trim();
  const env = process.env.ASTROLABE_AS;
  return env?.trim() ? env.trim() : undefined;
}
async function readStdin() {
  return (await Bun.stdin.text()).trim();
}
async function readPort() {
  try {
    const p = Number.parseInt((await Bun.file(PORT_FILE).text()).trim(), 10);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}
async function isUp(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/state`)).ok;
  } catch {
    return false;
  }
}
async function ensureDaemon() {
  const existing = await readPort();
  if (existing && await isUp(existing)) {
    return { base: `http://127.0.0.1:${existing}`, port: existing };
  }
  const bootLog = openBootLog();
  const proc = spawn(process.execPath, ["run", SERVER_SCRIPT, "--no-open"], {
    detached: true,
    stdio: ["ignore", "ignore", bootLog ? bootLog.fd : "ignore"],
    env: process.env,
    cwd: daemonCwd()
  });
  if (bootLog)
    closeSync(bootLog.fd);
  const ended = { how: null };
  proc.on("exit", (code, signal) => {
    ended.how = code !== null ? `exit ${code}` : `signal ${signal}`;
  });
  proc.on("error", (e) => {
    ended.how = `spawn error: ${e.message}`;
  });
  proc.unref();
  const deadline = Date.now() + 45000;
  let up = null;
  while (Date.now() < deadline) {
    await sleep(80);
    const p = await readPort();
    if (p && await isUp(p)) {
      up = p;
      break;
    }
    if (ended.how) {
      const q = await readPort();
      if (q && await isUp(q))
        up = q;
      break;
    }
  }
  const said = bootLog ? takeBootLog(bootLog.path) : "";
  if (up)
    return { base: `http://127.0.0.1:${up}`, port: up };
  const f = startFailure(ended.how, said);
  die(f.message, "internal", f.extra);
}
function openBootLog() {
  const path = join2(tmpdir(), `astrolabe-boot-${process.pid}-${Date.now()}.log`);
  try {
    return { fd: openSync(path, "wx", 384), path };
  } catch {
    return null;
  }
}
function takeBootLog(path) {
  let text = "";
  try {
    text = readFileSync2(path, "utf8");
  } catch {}
  try {
    unlinkSync(path);
  } catch {}
  return text;
}
function startFailure(ended, said) {
  const lines = said.trim().split(`
`).reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.message === "string")
        return {
          message: obj.message,
          extra: { ...typeof obj.hint === "string" ? { hint: obj.hint } : {}, server: obj }
        };
    } catch {}
  }
  const tail = said.trim().slice(-800);
  if (ended)
    return {
      message: `astrolabe daemon stopped (${ended}) before it started${tail ? `: ${tail}` : ", and gave no reason"}`
    };
  return {
    message: "astrolabe daemon failed to start within 45s",
    ...tail ? { extra: { hint: `the daemon said: ${tail}` } } : {}
  };
}
async function coldBoard() {
  const port = await readPort();
  if (port && await isUp(port))
    return null;
  const read = readRegistry(REGISTRY_FILE);
  if (!read.ok)
    die(`${REGISTRY_FILE} could not be read (${read.reason}), so which projects are registered is unknown`, "conflict", {
      hint: `${repairAct(REGISTRY_FILE, read.cause)}, and retry; or run \`cli.ts open --no-open\` to set it aside (renamed to registry.json.unreadable-<time>, never deleted) and start an empty board`
    });
  return read.state;
}
function setAsideClause(asides) {
  return `registry.json could not be read and was set aside at ${asides.join(", ")}`;
}
function recoverHint(asides) {
  return asides.map((a) => recoverAct(a, REGISTRY_FILE)).join("; ");
}
function warnSetAside() {
  const asides = listSetAside(REGISTRY_FILE);
  if (asides.length === 0)
    return;
  process.stderr.write(`# warning: astrolabe: ${setAsideClause(asides)}; projects registered in it are not on the board. To recover: ${recoverHint(asides)}
`);
}
function setAsideField() {
  const asides = listSetAside(REGISTRY_FILE);
  if (asides.length === 0)
    return {};
  return {
    registry_set_aside: asides.map((path) => ({ path, recover: recoverAct(path, REGISTRY_FILE) }))
  };
}
function unknownProject(id) {
  return unknownProjectWords(id, listSetAside(REGISTRY_FILE));
}
function unknownProjectWords(id, asides) {
  const add = "run: cli.ts add <name> --path <p> to register it";
  if (asides.length === 0)
    return { message: `unknown project '${id}'`, hint: add };
  return {
    message: `unknown project '${id}' \u2014 but ${setAsideClause(asides)}, so '${id}' may be registered there`,
    hint: `to recover it: ${recoverHint(asides)}. Or ${add}`
  };
}
function refusalWords(r, asides) {
  if (r.reason === "unknown-project" && typeof r.project === "string") {
    return unknownProjectWords(r.project, asides);
  }
  return { message: r.error };
}
async function ensureDaemonFor(id) {
  const board = await coldBoard();
  if (board && !board.projects.some((p) => p.id === id)) {
    const u = unknownProject(id);
    die(u.message, "usage", {
      hint: u.hint,
      choices: board.projects.map((p) => p.id)
    });
  }
  return await ensureDaemon();
}
async function runningBase() {
  const p = await readPort();
  return p ? `http://127.0.0.1:${p}` : null;
}
async function postCmd(base, body) {
  const res = await fetch(`${base}/cmd`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await res.json();
}
async function cmd(base, body) {
  const r = await postCmd(base, body);
  if (!r.applied && r.error) {
    const w = refusalWords({ ...r, error: r.error }, listSetAside(REGISTRY_FILE));
    die(w.message, "usage", w.hint ? { hint: w.hint } : undefined);
  }
  printJson(r);
  warnSetAside();
}
function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}
async function streamEvents(opts) {
  const inScope = (ev) => {
    if (!opts.scopeId)
      return true;
    if (ev.type === "ready" || ev.type === "closed")
      return true;
    return ev.projectId === opts.scopeId;
  };
  return await tailWithHandoff({
    resolve: runningBase,
    path: "/events",
    since: opts.since,
    ...opts.sinceEpoch ? { sinceEpoch: opts.sinceEpoch } : {},
    cursorOf: (ev) => ev.id,
    query: (cursor) => ({
      since: String(cursor),
      ...opts.project ? { project: opts.project } : {}
    }),
    accept: (ev) => inScope(ev) && !(opts.self !== undefined && ev.by === opts.self),
    terminal: (ev) => ev.type === "closed",
    epochOf: (ev) => ev.epoch,
    onEpochChange: (epoch) => JSON.stringify({ type: "epoch.changed", epoch }),
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": astrolabe-keepalive"
  }, {
    spell: "astrolabe",
    mode: "watch",
    presence: true,
    commands: {
      tail: ({ since, epoch }) => tailCommand(opts.again, since, false, epoch),
      comeBack: () => commandLine(["open", "--no-open"])
    }
  });
}
async function cmdOpen(flags) {
  const { port } = await ensureDaemon();
  if (!flags["no-open"])
    openBrowser(`http://127.0.0.1:${port}`);
  printJson({ ok: true, url: `http://127.0.0.1:${port}`, port });
  warnSetAside();
}
async function cmdAdd(pos, flags) {
  const name = pos.join(" ").trim();
  if (!name)
    die("usage: add <name> --path <p> [--description ..] [--avatar ..] [--id ..]");
  const path = typeof flags.path === "string" ? flags.path.trim() : "";
  if (!path)
    die("add requires --path <p>");
  const description = flags.stdin ? await readStdin() : typeof flags.description === "string" ? flags.description : undefined;
  const avatar = typeof flags.avatar === "string" ? flags.avatar : undefined;
  const id = typeof flags.id === "string" && flags.id.trim() ? flags.id.trim() : undefined;
  const board = await coldBoard();
  if (board) {
    const dry = applyProjectAdd(board, { id: id ?? "", name, path, description, avatar });
    if (!dry.applied && dry.error)
      die(dry.error);
  }
  const { base } = await ensureDaemon();
  await cmd(base, {
    type: "project.add",
    project: { id, name, path, description, avatar },
    as: resolveAs(flags)
  });
}
async function cmdRemove(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: remove <id>");
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "project.remove", id, as: resolveAs(flags) });
}
async function cmdStatus(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: status <id> <summary...> [--phase ..] [--stdin]");
  const summary = flags.stdin ? await readStdin() : pos.slice(1).join(" ").trim();
  if (!summary)
    die("status requires a summary (positional or --stdin)");
  const phase = typeof flags.phase === "string" ? flags.phase : undefined;
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "status", id, summary, phase, as: resolveAs(flags) });
}
async function cmdAttention(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: attention <id> [--clear] [--question ...]");
  const raised = flags.clear !== true;
  const question = typeof flags.question === "string" ? flags.question : pos.slice(1).join(" ").trim() || undefined;
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "attention", id, raised, question, as: resolveAs(flags) });
}
async function cmdPoke(pos, flags) {
  const id = pos[0];
  if (!id)
    die("usage: poke <id>");
  const { base } = await ensureDaemonFor(id);
  await cmd(base, { type: "poke", id, as: resolveAs(flags) });
}
async function cmdState() {
  const base = await runningBase();
  if (!base || !await isUp(Number.parseInt(base.split(":").pop(), 10))) {
    printJson({
      ok: true,
      running: false,
      state: { title: "Observatory", projects: [] },
      ...setAsideField()
    });
    return;
  }
  const res = await fetch(`${base}/state`);
  if (!res.ok)
    die(`state failed (HTTP ${res.status})`);
  printJson({ ...await res.json(), ...setAsideField() });
}
async function cmdList() {
  const base = await runningBase();
  if (!base || !await isUp(Number.parseInt(base.split(":").pop(), 10))) {
    printJson({ ok: true, running: false, projects: [], ...setAsideField() });
    return;
  }
  const { state } = await (await fetch(`${base}/state`)).json();
  printJson({
    ok: true,
    running: true,
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      zone: p.zone,
      connected: p.connected
    })),
    ...setAsideField()
  });
}
var CLOSE_WAIT_MS = 3000;
var CLOSE_POLL_MS = 80;
var CLOSED = { ok: true, applied: false, outcome: "already-closed" };
async function cmdClose(flags) {
  const port = await readPort();
  if (!port || !await isUp(port)) {
    printJson(CLOSED);
    return;
  }
  let r;
  try {
    r = await postCmd(`http://127.0.0.1:${port}`, { type: "close", as: resolveAs(flags) });
  } catch (e) {
    if (!await isUp(port)) {
      printJson(CLOSED);
      return;
    }
    throw e;
  }
  if (!r.applied && r.error)
    die(r.error);
  if (!r.applied) {
    printJson(r);
    return;
  }
  const deadline = Date.now() + CLOSE_WAIT_MS;
  while (Date.now() < deadline) {
    if (!await isUp(port)) {
      printJson(r);
      return;
    }
    await sleep(CLOSE_POLL_MS);
  }
  die(`close was acknowledged but the daemon was still answering after ${CLOSE_WAIT_MS / 1000}s`, "internal", { hint: "check with `info`; re-run `close` once it settles" });
}
async function cmdInfo() {
  const port = await readPort();
  if (port && await isUp(port)) {
    printJson({
      ok: true,
      running: true,
      url: `http://127.0.0.1:${port}`,
      port,
      ...setAsideField()
    });
  } else {
    printJson({ ok: true, running: false, ...setAsideField() });
  }
}
var CLI_OPTIONS = {
  as: { type: "string" },
  from: { type: "string" },
  path: { type: "string" },
  description: { type: "string" },
  avatar: { type: "string" },
  id: { type: "string" },
  phase: { type: "string" },
  question: { type: "string" },
  since: { type: "string" },
  timeout: { type: "string" },
  clear: { type: "boolean", default: false },
  stdin: { type: "boolean", default: false },
  "no-open": { type: "boolean", default: false }
};
var on = (h) => (inv) => h(inv.pos, inv.flags);
var IDENTITY = ["as", "from"];
var NONE = [];
var ID = [{ name: "id", required: true }];
function sinceOf(flags) {
  const read = typeof flags.since === "string" ? readSince(flags.since, { epoch: true }) : null;
  if (read !== null && !read.ok)
    die(read.message, "usage");
  return read?.ok ? { since: read.since, sinceEpoch: read.epoch } : { since: -1 };
}
async function cmdJoin(pos, flags) {
  const id = pos[0];
  const { since, sinceEpoch } = sinceOf(flags);
  const { base } = await ensureDaemonFor(id);
  const { state } = await (await fetch(`${base}/state`)).json();
  if (!state.projects.some((p) => p.id === id)) {
    const u = unknownProject(id);
    die(u.message, "usage", {
      hint: u.hint,
      choices: state.projects.map((p) => p.id)
    });
  }
  const self = resolveAs(flags);
  warnSetAside();
  return await streamEvents({
    since,
    sinceEpoch,
    project: id,
    scopeId: id,
    self,
    again: ["join", id, ...self !== undefined ? ["--as", self] : []]
  });
}
async function cmdTail(flags) {
  const { since, sinceEpoch } = sinceOf(flags);
  await ensureDaemon();
  const self = resolveAs(flags);
  warnSetAside();
  return await streamEvents({
    since,
    sinceEpoch,
    self,
    again: ["tail", ...self !== undefined ? ["--as", self] : []]
  });
}
var ROWS = [
  {
    name: "open",
    flags: ["no-open", "timeout"],
    positionals: NONE,
    describe: "ensure the daemon is up + open the board in the browser",
    run: on((_pos, flags) => cmdOpen(flags))
  },
  {
    name: "add",
    flags: ["path", "description", "avatar", "id", "stdin", ...IDENTITY],
    positionals: [{ name: "name", required: true, variadic: true }],
    describe: "register a project (--path required; dedupe-guarded; id + avatar derived from the name). echoes the derived id for join/status/attention/remove",
    run: on(cmdAdd)
  },
  {
    name: "remove",
    flags: [...IDENTITY],
    positionals: ID,
    describe: "unregister a project",
    run: on(cmdRemove)
  },
  {
    name: "join",
    flags: ["since", ...IDENTITY],
    positionals: ID,
    describe: "activate the card + listen for pokes (scoped tail; wrap with Monitor). end it to idle the card",
    run: on(cmdJoin)
  },
  {
    name: "status",
    flags: ["phase", "stdin", ...IDENTITY],
    positionals: [...ID, { name: "summary", required: false, variadic: true }],
    describe: "replace a project's current status (the summary is positional, or --stdin)",
    check: (inv) => inv.flags.stdin !== true && inv.pos.length < 2 ? "missing required <summary> (or pass --stdin)" : undefined,
    run: on(cmdStatus)
  },
  {
    name: "attention",
    flags: ["clear", "question", ...IDENTITY],
    positionals: [...ID, { name: "question", required: false, variadic: true }],
    describe: "raise / clear (--clear) the needs-you gate (--question attaches the prompt)",
    run: on(cmdAttention)
  },
  {
    name: "poke",
    flags: [...IDENTITY],
    positionals: ID,
    describe: "request a fresh status from the project's agent",
    run: on(cmdPoke)
  },
  {
    name: "state",
    flags: [],
    positionals: NONE,
    describe: "read-back: project cards (each carries a derived zone: attention | active | quiet)",
    run: () => cmdState()
  },
  {
    name: "tail",
    flags: ["since", ...IDENTITY],
    positionals: NONE,
    describe: "unscoped event tail as JSONL (no presence)",
    run: on((_pos, flags) => cmdTail(flags))
  },
  {
    name: "list",
    flags: [],
    positionals: NONE,
    describe: "the registered projects, compact",
    run: () => cmdList()
  },
  {
    name: "close",
    flags: [...IDENTITY],
    positionals: NONE,
    describe: "dismiss the observatory",
    run: on((_pos, flags) => cmdClose(flags))
  },
  {
    name: "info",
    flags: [],
    positionals: NONE,
    describe: "daemon status: running, url, port",
    run: () => cmdInfo()
  }
];
async function versionInfo() {
  try {
    const pkg = await Bun.file(join2(SCRIPT_DIR, "../../../.claude-plugin/plugin.json")).json();
    if (typeof pkg?.version === "string")
      return { name: "astrolabe", version: pkg.version };
  } catch {}
  return { name: "astrolabe", version: "unknown" };
}
var cli = defineCli({
  name: "astrolabe",
  summary: "a standing observatory board for projects in flight.",
  options: CLI_OPTIONS,
  commands: ROWS,
  grammar: "verb-first",
  usageHides: ["timeout"],
  version: versionInfo,
  helpFooter: `  join and tail ${WINDOW_HELP}

  Identity: --as / --from (or $ASTROLABE_AS) stamps the actor + suppresses
  self-echo, on the verbs that list it. --stdin reads a description/summary from
  stdin (shell-quoting-safe). Each verb accepts only the flags on its row; a
  recognized flag on the wrong verb is refused, and the rejection lists the
  verb's own flags.

  Output: every command prints JSON on stdout by default, one line per answer;
  failures put one JSON error envelope on stderr and exit non-zero (2 = usage,
  1 = internal). There is no prose mode to switch out of.`
});
async function main(argv) {
  return await cli.main(argv);
}
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  cli,
  main,
  refusalWords,
  run,
  startFailure
};
