import { describe, expect, test } from "bun:test";
import { type CommandSpec, defineCli, type Invocation } from "./registry";

// ── harness ────────────────────────────────────────────────────────────────

type Outcome = { code: number; out: string; err: string };

/** Run `fn` with stdout and stderr captured, always restoring them. */
async function capture(fn: () => Promise<number> | number): Promise<Outcome> {
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as unknown as { write: unknown }).write = (s: string) => {
    out += s;
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (s: string) => {
    err += s;
    return true;
  };
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    (process.stdout as unknown as { write: unknown }).write = o;
    (process.stderr as unknown as { write: unknown }).write = e;
  }
}

type Envelope = {
  ok: false;
  error: { kind: string; exit_code: number; message: string; hint?: string; choices?: string[] };
  meta: { command: string | null };
};

/** The one envelope on stderr, with stdout asserted empty. */
function envelope(r: Outcome): Envelope {
  expect(r.out).toBe("");
  const lines = r.err.trim().split("\n");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0] as string) as Envelope;
}

// ── a small fake table: verb-first, globals, aliases, a nested group ──────

const OPTIONS = {
  as: { type: "string" },
  from: { type: "string" },
  force: { type: "boolean" },
  human: { type: "boolean" },
  limit: { type: "string", default: "10" },
  project: { type: "string" },
  quiet: { type: "boolean", default: false },
  since: { type: "string" },
  clear: { type: "boolean" },
} as const;

type F = keyof typeof OPTIONS;

function fakeCli(extra: Partial<Parameters<typeof defineCli<typeof OPTIONS>>[0]> = {}) {
  const calls: Invocation<F>[] = [];
  const rec = (inv: Invocation<F>) => {
    calls.push(inv);
  };
  const commands: CommandSpec<F>[] = [
    {
      name: "list",
      aliases: ["ls"],
      flags: ["limit"],
      positionals: [],
      describe: "list things",
      run: rec,
    },
    {
      name: "close",
      flags: ["force"],
      positionals: [{ name: "id", required: true }],
      describe: "close one",
      run: rec,
    },
    {
      name: "echo",
      flags: [],
      positionals: [{ name: "text", required: true, variadic: true }],
      describe: "print text",
      rejectHint: "for text containing dashes, put it after a bare --",
      run: rec,
    },
    {
      name: "tail",
      flags: ["since"],
      positionals: [],
      describe: "a watch that owns its exit code",
      run: (inv) => {
        rec(inv);
        return 7;
      },
    },
    {
      name: "handoff",
      flags: ["clear"],
      positionals: [{ name: "target", required: false }],
      describe: "hand off to <target>, or --clear",
      check: ({ pos, flags }) =>
        (pos.length === 1) === (flags.clear === true)
          ? "give <target> or --clear, not both"
          : undefined,
      run: rec,
    },
    {
      name: "node edit",
      flags: ["project"],
      positionals: [{ name: "id", required: true }],
      describe: "edit",
      run: rec,
    },
    {
      name: "node move",
      flags: [],
      positionals: [{ name: "id", required: true }],
      describe: "move",
      run: rec,
    },
    {
      name: "doc",
      flags: ["project"],
      positionals: [{ name: "id", required: true }],
      describe: "read a doc",
      run: rec,
    },
    {
      name: "doc delete",
      flags: ["project", "force"],
      positionals: [{ name: "id", required: true }],
      describe: "delete a doc",
      run: rec,
    },
  ];
  const cli = defineCli({
    name: "fake",
    summary: "a fake CLI for the registry's tests",
    options: OPTIONS,
    globalFlags: ["as", "from"],
    groups: { doc: { subVerbAt: "first-positional" } },
    version: () => ({ name: "fake", version: "1.2.3" }),
    commands,
    ...extra,
  });
  return { cli, calls };
}

// ── import is inert ──────────────────────────────────────────────────────

describe("no side effects", () => {
  test("defineCli writes nothing and runs no handler", async () => {
    let ran = false;
    const r = await capture(() => {
      defineCli({
        name: "quiet",
        options: { x: { type: "boolean" } },
        version: () => {
          ran = true;
          return {};
        },
        commands: [
          {
            name: "go",
            flags: ["x"],
            positionals: [],
            describe: "go",
            run: () => {
              ran = true;
            },
          },
        ],
      });
      return 0;
    });
    expect(r.out).toBe("");
    expect(r.err).toBe("");
    expect(ran).toBe(false);
  });

  test("the scanner's views are readable without running anything", () => {
    const { cli, calls } = fakeCli();
    expect(cli.recognizedFlags).toEqual(Object.keys(OPTIONS).map((k) => `--${k}`));
    expect(cli.flagsFor("close")).toEqual(["--as", "--force", "--from"]);
    expect(cli.verbs).toEqual([
      "list",
      "ls",
      "close",
      "echo",
      "tail",
      "handoff",
      "node",
      "doc",
      "version",
      "schema",
      "help",
    ]);
    expect(cli.paths).toContain("node edit");
    expect(cli.declaration().commands.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  test("a malformed table is refused at define time", () => {
    expect(() =>
      defineCli({
        name: "bad",
        options: { x: { type: "boolean" } },
        version: () => ({}),
        // The point is a flag the types refuse, so the cast.
        commands: [
          { name: "go", flags: ["y" as never], positionals: [], describe: "", run: () => {} },
        ],
      }),
    ).toThrow(/not in options/);
    expect(() =>
      defineCli({
        name: "bad",
        options: {},
        version: () => ({}),
        commands: [
          { name: "a", flags: [], positionals: [], describe: "", run: () => {} },
          { name: "b", aliases: ["a"], flags: [], positionals: [], describe: "", run: () => {} },
        ],
      }),
    ).toThrow(/defined twice/);
  });
});

// ── defaults ─────────────────────────────────────────────────────────────

describe("defaults", () => {
  test("a row that does not list a defaulted flag is not refused, and does not see it", async () => {
    const { cli, calls } = fakeCli();
    const r = await capture(() => cli.main(["close", "C1"]));
    expect(r.code).toBe(0);
    expect(calls[0]?.flags).toEqual({});
  });

  test("the auto rows are not refused either", async () => {
    const { cli } = fakeCli();
    for (const verb of ["schema", "help", "version"]) {
      expect((await capture(() => cli.main([verb]))).code).toBe(0);
    }
  });

  test("a row that lists a defaulted flag gets the default, and a given value wins", async () => {
    const { cli, calls } = fakeCli();
    await capture(() => cli.main(["list"]));
    await capture(() => cli.main(["list", "--limit", "3"]));
    expect(calls[0]?.flags).toEqual({ limit: "10" });
    expect(calls[1]?.flags).toEqual({ limit: "3" });
  });

  test("a defaulted flag GIVEN to a row that does not take it is still refused", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["close", "C1", "--limit", "3"])));
    expect(env.error.exit_code).toBe(2);
    expect(env.error.message).toContain("--limit");
    expect(env.error.choices).toEqual(["--as", "--force", "--from"]);
  });
});

// ── grammar ──────────────────────────────────────────────────────────────

describe("verb-first", () => {
  test("a dash-led first token is an unknown ROOT flag, even a global one", async () => {
    const { cli, calls } = fakeCli();
    const env = envelope(await capture(() => cli.main(["--as", "me", "list"])));
    expect(env.error.kind).toBe("usage");
    expect(env.error.message).toBe("unknown flag at the root: --as");
    expect(env.error.choices).toEqual(["--help", "--version", "-h", "-V"]);
    expect(calls).toEqual([]);
  });

  test("flags after the verb are fine", async () => {
    const { cli, calls } = fakeCli();
    expect((await capture(() => cli.main(["list", "--as", "me"]))).code).toBe(0);
    expect(calls[0]?.flags.as).toBe("me");
  });
});

describe("flags-anywhere", () => {
  const OPTS = { session: { type: "string" }, full: { type: "boolean" } } as const;
  const make = () => {
    const calls: Invocation[] = [];
    const cli = defineCli({
      name: "fa",
      options: OPTS,
      grammar: "flags-anywhere",
      verbPositional: "verb",
      version: () => ({ name: "fa", version: "0" }),
      commands: [
        {
          name: "info",
          flags: ["session", "full"],
          positionals: [],
          describe: "info",
          run: (inv) => {
            calls.push(inv);
          },
        },
      ],
    });
    return { cli, calls };
  };

  test("`--session x info` runs info (a string flag consumes its value)", async () => {
    const { cli, calls } = make();
    const r = await capture(() => cli.main(["--session", "x", "info"]));
    expect(r.code).toBe(0);
    expect(calls[0]).toMatchObject({ path: "info", flags: { session: "x" }, pos: [] });
  });

  test("`--full info` and `--session=x info` too", async () => {
    const { cli, calls } = make();
    await capture(() => cli.main(["--full", "info"]));
    await capture(() => cli.main(["--session=x", "info"]));
    expect(calls.map((c) => c.flags)).toEqual([{ full: true }, { session: "x" }]);
  });

  test("no verb and an unknown flag: refused with the root's set", async () => {
    const { cli } = make();
    const env = envelope(await capture(() => cli.main(["--session", "x", "--bogus"])));
    expect(env.error.message).toContain("--bogus");
    expect(env.error.choices).toEqual(["--help", "--version", "-h", "-V"]);
  });

  test("no verb and a clean parse: a bare invocation", async () => {
    const { cli } = make();
    const env = envelope(await capture(() => cli.main(["--session", "x"])));
    expect(env.error.message).toBe("expected a command");
    expect(env.error.choices).toEqual(["info", "version", "schema", "help"]);
  });

  test("A6: `-- --zz` is an unknown command, never an option", async () => {
    const { cli } = make();
    const env = envelope(await capture(() => cli.main(["--", "--zz"])));
    expect(env.error.message).toBe('unknown command "--zz"');
  });

  test("the declaration's root positional takes the given name", () => {
    expect(make().cli.declaration().commands[0]?.positionals).toEqual([
      { name: "verb", required: true },
    ]);
  });
});

// ── interceptors ─────────────────────────────────────────────────────────

describe("interceptors pass the rest on to their row", () => {
  test("`--version --junk` is exit 2 when version takes no flags", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["--version", "--junk"])));
    expect(env.error.exit_code).toBe(2);
    expect(env.error.message).toContain("--junk");
    expect(env.error.choices).toEqual(["--as", "--from"]);
    expect(env.meta.command).toBe("version");
  });

  test("`-V --as me` works: globals reach the auto rows", async () => {
    const { cli } = fakeCli();
    const r = await capture(() => cli.main(["-V", "--as", "me"]));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ name: "fake", version: "1.2.3" });
  });

  test("`--version --human` works when the spell's version row takes --human", async () => {
    const { cli } = fakeCli({
      groups: {},
      commands: [
        {
          name: "version",
          flags: ["human"],
          positionals: [],
          describe: "version",
          run: ({ flags }) => {
            process.stdout.write(flags.human === true ? "fake v1.2.3\n" : '{"v":1}\n');
          },
        },
      ],
    });
    const r = await capture(() => cli.main(["--version", "--human"]));
    expect(r).toEqual({ code: 0, out: "fake v1.2.3\n", err: "" });
  });

  test("`-h` and `--help` print the help on stdout, exit 0", async () => {
    const { cli } = fakeCli();
    for (const t of ["-h", "--help", "help"]) {
      const r = await capture(() => cli.main([t]));
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(r.out).toBe(`${cli.renderHelp()}\n`);
    }
  });
});

// ── the L0 contract ──────────────────────────────────────────────────────

describe("C2/D2: a bare invocation", () => {
  test("is a usage error: stderr envelope, stdout empty, exit 2, choices = verbs", async () => {
    const { cli } = fakeCli();
    const r = await capture(() => cli.main([]));
    expect(r.code).toBe(2);
    const env = envelope(r);
    expect(env.error.kind).toBe("usage");
    expect(env.error.choices).toEqual([...cli.verbs]);
    expect(env.error.hint).toContain("help");
  });
});

describe("D1: --version", () => {
  test("prints the spell's payload as one JSON document, exit 0", async () => {
    const { cli } = fakeCli();
    for (const t of ["--version", "-V", "version"]) {
      const r = await capture(() => cli.main([t]));
      expect(r).toEqual({ code: 0, out: '{"name":"fake","version":"1.2.3"}\n', err: "" });
    }
  });
});

describe("A6: the -- terminator", () => {
  test("a leading `--` makes the next token the verb candidate", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["--", "--zz-value"])));
    expect(env.error.message).toBe('unknown command "--zz-value"');
    expect(env.error.choices).toEqual([...cli.verbs]);
  });

  test("after `--` everything is positional", async () => {
    const { cli, calls } = fakeCli();
    await capture(() => cli.main(["echo", "--", "--force", "-h"]));
    await capture(() => cli.main(["--", "echo", "--as", "x"]));
    expect(calls.map((c) => [c.pos, c.flags])).toEqual([
      [["--force", "-h"], {}],
      [["--as", "x"], {}],
    ]);
  });
});

describe("A1/A3: rejections name the token and the set AT THAT VERB", () => {
  test("an unknown flag: choices are this verb's set, message names the flag", async () => {
    const { cli } = fakeCli();
    const a = envelope(await capture(() => cli.main(["close", "C1", "--nope"])));
    const b = envelope(await capture(() => cli.main(["list", "--nope"])));
    expect(a.error.message).toContain("--nope");
    expect(a.error.choices).toEqual(["--as", "--force", "--from"]);
    expect(b.error.choices).toEqual(["--as", "--from", "--limit"]);
    expect(a.meta.command).toBe("close");
  });

  test("another verb's flag is MISPLACED, with this verb's set", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["list", "--force"])));
    expect(env.error.message).toBe(
      "--force is not accepted by `list` (it is a recognized fake flag, just not this verb's)",
    );
    expect(env.error.choices).toEqual(["--as", "--from", "--limit"]);
  });

  test("an unknown verb: choices are the verbs, aliases and groups included", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["bogus"])));
    expect(env.error.message).toBe('unknown command "bogus"');
    expect(env.error.choices).toContain("ls");
    expect(env.error.choices).toContain("node");
  });

  test("arity names the missing positional and the extra token", async () => {
    const { cli } = fakeCli();
    const missing = envelope(await capture(() => cli.main(["close"])));
    const extra = envelope(await capture(() => cli.main(["close", "C1", "extra-token"])));
    expect(missing.error.message).toBe("close: missing required <id>");
    expect(extra.error.message).toBe('close: unexpected argument "extra-token"');
    expect(extra.error.hint).toBe("expects: close <id> [--force]");
  });

  test("a missing value carries a hint and no choices", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["tail", "--since"])));
    expect(env.error.message).toContain("--since");
    expect(env.error.choices).toBeUndefined();
  });

  test("rejectHint rides the flag rejection", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["echo", "--dashy", "text"])));
    expect(env.error.hint).toContain("after a bare --");
    expect(env.error.choices).toEqual(["--as", "--from"]);
  });
});

// ── nesting ──────────────────────────────────────────────────────────────

describe("nesting", () => {
  test("a two-token verb resolves", async () => {
    const { cli, calls } = fakeCli();
    await capture(() => cli.main(["node", "edit", "N1", "--project", "P"]));
    expect(calls[0]).toMatchObject({ path: "node edit", pos: ["N1"], flags: { project: "P" } });
  });

  test("a group with no row of its own rejects with its sub-verbs", async () => {
    const { cli } = fakeCli();
    const none = envelope(await capture(() => cli.main(["node"])));
    const bad = envelope(await capture(() => cli.main(["node", "zap"])));
    expect(none.error.message).toBe("node: expected a sub-command");
    expect(none.error.choices).toEqual(["edit", "move"]);
    expect(bad.error.message).toBe('unknown node sub-command: "zap"');
    expect(bad.error.choices).toEqual(["edit", "move"]);
  });

  test("an adjacent group does not look past a flag for its sub-verb", async () => {
    const { cli } = fakeCli();
    const env = envelope(await capture(() => cli.main(["node", "--project", "P", "edit", "N1"])));
    expect(env.error.message).toBe("node: expected a sub-command");
  });

  test("first-positional: the sub-verb is found after flags (mind-mapper's doc)", async () => {
    const { cli, calls } = fakeCli();
    const r = await capture(() => cli.main(["doc", "--project", "P", "delete", "D1", "--force"]));
    expect(r.code).toBe(0);
    expect(calls[0]).toMatchObject({
      path: "doc delete",
      pos: ["D1"],
      flags: { project: "P", force: true },
    });
  });

  test("a group with its own row runs it when the token is not a sub-verb", async () => {
    const { cli, calls } = fakeCli();
    await capture(() => cli.main(["doc", "D1"]));
    await capture(() => cli.main(["doc", "--", "delete"]));
    expect(calls.map((c) => [c.path, c.pos])).toEqual([
      ["doc", ["D1"]],
      ["doc", ["delete"]],
    ]);
  });
});

// ── aliases, globals, the check hook, exit codes ────────────────────────

describe("aliases", () => {
  test("an alias dispatches to its row and reports the spelling used", async () => {
    const { cli, calls } = fakeCli();
    await capture(() => cli.main(["ls", "--limit", "2"]));
    expect(calls[0]).toMatchObject({ path: "list", token: "ls", flags: { limit: "2" } });
    expect(cli.flagsFor("ls")).toEqual(cli.flagsFor("list"));
  });
});

describe("globalFlags", () => {
  test("are accepted on every row and appear in every row's set", async () => {
    const { cli } = fakeCli();
    for (const argv of [["list"], ["close", "C1"], ["schema"], ["help"], ["node", "move", "N1"]]) {
      expect((await capture(() => cli.main([...argv, "--from", "me"]))).code).toBe(0);
    }
    for (const p of cli.paths) expect(cli.flagsFor(p)).toContain("--as");
  });
});

describe("check: flag-dependent arity", () => {
  test("refuses the combinations the declaration cannot express", async () => {
    const { cli, calls } = fakeCli();
    expect((await capture(() => cli.main(["handoff", "T"]))).code).toBe(0);
    expect((await capture(() => cli.main(["handoff", "--clear"]))).code).toBe(0);
    const both = envelope(await capture(() => cli.main(["handoff", "T", "--clear"])));
    const neither = envelope(await capture(() => cli.main(["handoff"])));
    expect(both.error.message).toBe("handoff: give <target> or --clear, not both");
    expect(neither.error.exit_code).toBe(2);
    expect(calls.length).toBe(2);
  });
});

describe("exit codes", () => {
  test("a row that returns a number owns its exit code", async () => {
    const { cli } = fakeCli();
    expect((await capture(() => cli.main(["tail"]))).code).toBe(7);
  });

  test("main turns a non-CliError into one internal envelope, exit 1", async () => {
    const cli = defineCli({
      name: "boom",
      options: {},
      version: () => ({}),
      commands: [
        {
          name: "go",
          flags: [],
          positionals: [],
          describe: "",
          run: () => {
            throw new Error("kaput");
          },
        },
      ],
    });
    const r = await capture(() => cli.main(["go"]));
    expect(r.code).toBe(1);
    expect(envelope(r).error).toMatchObject({ kind: "internal", message: "kaput" });
    await expect(cli.dispatch(["go"])).rejects.toThrow("kaput");
  });
});

// ── verbless root ────────────────────────────────────────────────────────

describe("a verbless root (digestify)", () => {
  const ROOT_OPTS = {
    title: { type: "string", default: "Document Review" },
    "no-open": { type: "boolean", default: false },
  } as const;
  const make = (allowPositionals?: false) => {
    const calls: Invocation[] = [];
    const cli = defineCli({
      name: "review",
      options: ROOT_OPTS,
      version: () => ({ name: "review", version: "9" }),
      root: {
        flags: ["title", "no-open"],
        positionals: allowPositionals === false ? [] : [{ name: "file", required: false }],
        allowPositionals,
        describe: "review stdin",
        run: (inv) => {
          calls.push(inv);
        },
      },
    });
    return { cli, calls };
  };

  test("an empty argv runs the root, with its defaults", async () => {
    const { cli, calls } = make(false);
    const r = await capture(() => cli.main([]));
    expect(r.code).toBe(0);
    expect(calls[0]).toMatchObject({
      path: "",
      pos: [],
      flags: { title: "Document Review", "no-open": false },
    });
  });

  test("help, version, schema and the interceptors still answer", async () => {
    const { cli, calls } = make(false);
    for (const t of ["schema", "help", "version", "--help", "-V"]) {
      expect((await capture(() => cli.main([t]))).code).toBe(0);
    }
    expect(calls).toEqual([]);
  });

  test("allowPositionals: false refuses a positional, naming it", async () => {
    const { cli } = make(false);
    const env = envelope(await capture(() => cli.main(["stray"])));
    expect(env.error.exit_code).toBe(2);
    expect(env.error.message).toContain("stray");
  });

  test("a positional spelling a reserved token goes after --", async () => {
    const { cli, calls } = make();
    await capture(() => cli.main(["--", "help"]));
    expect(calls[0]?.pos).toEqual(["help"]);
  });

  test("an unknown flag is refused with the root's set", async () => {
    const { cli } = make(false);
    const env = envelope(await capture(() => cli.main(["--nope"])));
    expect(env.error.message).toContain("--nope");
    expect(env.error.choices).toEqual(["--no-open", "--title"]);
  });

  test("the declaration's root row carries the root's flags and positionals", () => {
    const decl = make().cli.declaration();
    expect(decl.commands[0]).toEqual({
      path: [],
      args: [
        { name: "--help", type: "boolean", status: "valid" },
        { name: "-h", type: "boolean", status: "valid" },
        { name: "--version", type: "boolean", status: "valid" },
        { name: "-V", type: "boolean", status: "valid" },
        { name: "--title", type: "string", status: "valid" },
        { name: "--no-open", type: "boolean", status: "valid" },
      ],
      positionals: [{ name: "file", required: false }],
    });
    expect(decl.commands.slice(1).map((c) => c.path)).toEqual([["version"], ["schema"], ["help"]]);
  });
});

// ── schema ───────────────────────────────────────────────────────────────

describe("schema: the acc declaration, format v0", () => {
  test("the `schema` row prints the declaration, pretty, exit 0", async () => {
    const { cli } = fakeCli();
    const r = await capture(() => cli.main(["schema"]));
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${JSON.stringify(cli.declaration(), null, 2)}\n`);
  });

  test("its shape matches what grapevine, glamour and scriptorium emit", () => {
    const { cli } = fakeCli();
    const d = cli.declaration();
    expect(Object.keys(d)).toEqual(["formatVersion", "provenance", "selfDescription", "commands"]);
    expect(d.formatVersion).toBe("0");
    expect(d.provenance).toBe("emitted");
    expect(d.selfDescription).toEqual({ args: ["schema"] });
    expect(d.commands[0]).toEqual({
      path: [],
      args: [
        { name: "--help", type: "boolean", status: "valid" },
        { name: "-h", type: "boolean", status: "valid" },
        { name: "--version", type: "boolean", status: "valid" },
        { name: "-V", type: "boolean", status: "valid" },
      ],
      positionals: [{ name: "command", required: true }],
    });
    for (const c of d.commands) expect(Object.keys(c)).toEqual(["path", "args", "positionals"]);
  });

  test("one row per name and per alias; nested paths split; args in options order with globals", () => {
    const d = fakeCli().cli.declaration();
    const paths = d.commands.map((c) => c.path.join(" "));
    expect(paths).toEqual([
      "",
      "list",
      "ls",
      "close",
      "echo",
      "tail",
      "handoff",
      "node edit",
      "node move",
      "doc",
      "doc delete",
      "version",
      "schema",
      "help",
    ]);
    const docDelete = d.commands.find((c) => c.path.join(" ") === "doc delete");
    expect(docDelete?.path).toEqual(["doc", "delete"]);
    expect(docDelete?.args.map((a) => a.name)).toEqual(["--as", "--from", "--force", "--project"]);
    const echo = d.commands.find((c) => c.path[0] === "echo");
    expect(echo?.positionals).toEqual([{ name: "text", required: true, variadic: true }]);
  });

  test("the rendered help names schema (acc D3) and every row", () => {
    const { cli } = fakeCli();
    const help = cli.renderHelp();
    expect(help.startsWith("fake — a fake CLI")).toBe(true);
    for (const p of ["schema", "list", "node edit", "doc delete", "close <id> [--force]"]) {
      expect(help).toContain(p);
    }
  });

  test("a spell's own help replaces the rendered one", async () => {
    const { cli } = fakeCli({ help: () => "custom help\n" });
    expect((await capture(() => cli.main(["--help"]))).out).toBe("custom help\n");
  });
});
