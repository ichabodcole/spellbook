// `pdocs set <ref> --<field> <value> … [--unset <keys>]` — change a feature's,
// an item's or a cycle's frontmatter in place.
//
// It edits only the keys it is given: every other line of the block keeps its
// text, comments and order, and the body is not touched. A value is checked
// before anything is written, through the same code the lint runs — the row's
// vocabulary, the row's `validate` predicate (which resolves references the
// lint's way and writes their full form), then `documentProblems` and the
// corpus rules over the changed tree. A change that would make the next
// `pdocs check` report something new is refused.
//
// There is no triage flag (D8): moving an item out of `triage` is an ordinary
// `--lifecycle` change. The safeguard is the `triage-items` skill, which shows
// the user its proposal first.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, Invocation, Option } from "../cli.ts";
import { parseFrontmatter, yamlList } from "../docs-lint/index.ts";
import { ConflictError, ExitCode, UsageError, printEnvelope } from "../envelope.ts";
import {
  FIELD_VALUES,
  type RegistryRow,
  defaultRegistryIndex,
  registryIndex,
} from "../lint/registry.ts";
import { OKF_STATUS, documentProblems, workbenchDocuments } from "../lint/rules.ts";
import { workProblems } from "../lint/work.ts";
import { collectWork, modelIds, resolveRef, scalar as unquote, shortenIds } from "../work.ts";
import { existingDocuments, flagFor, rewriteFrontmatter, scalar } from "./new.ts";

export interface SetChange {
  key: string;
  before: string | null;
  after: string | null;
  /** False when the key already held the value: it is reported as already
   *  set, and its line in the file is left exactly as it was. */
  changed: boolean;
}

export interface SetData {
  /** Repo-relative. */
  path: string;
  changes: SetChange[];
}

/** Keys every entity carries that `set` may change. */
const COMMON_KEYS = ["title", "description", "status", "lifecycle"];

/** The work rows `set` edits. */
const WORK_TYPES = ["feature", "item", "cycle"];

/**
 * Every field any work row declares, beyond the common ones. Projected from
 * the registry, like `new`'s flags; `id` is never set — it names the item.
 */
const EXTRA_KEYS = [
  ...new Set(
    WORK_TYPES.flatMap((t) => defaultRegistryIndex().get(t)?.extra ?? [])
  ),
]
  .filter((k) => k !== "id")
  .sort();

/** Keys written as a YAML flow list. */
const LIST_KEYS = new Set(["blocked_by", "tags"]);

/** The frontmatter block with `keys` (and their continuation lines) removed. */
export function removeFrontmatterKeys(block: string, keys: ReadonlySet<string>): string {
  const lines = block.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):/.exec(lines[i] as string);
    if (m && keys.has(m[1] as string)) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] as string)) i++;
      continue;
    }
    out.push(lines[i] as string);
  }
  return out.join("\n");
}

function vocabulary(row: RegistryRow, key: string): readonly string[] | null {
  if (key === "lifecycle") return row.lifecycle;
  if (key === "status") return OKF_STATUS;
  return FIELD_VALUES[key] ?? null;
}

const OPTIONS: Option[] = [
  ...COMMON_KEYS.map((key) => ({
    flag: `--${key}`,
    metavar: "<value>",
    summary: `\`${key}:\``,
  })),
  ...EXTRA_KEYS.map((key) => ({
    flag: flagFor(key),
    metavar: key === "blocked_by" ? "<ref,ref>" : "<value>",
    summary: `\`${key}:\` — only on a type that declares it.`,
  })),
  {
    flag: "--unset",
    metavar: "<key,key>",
    summary: "Remove these keys. A key the lint requires cannot be removed.",
  },
];

export const set: Command = {
  name: "set",
  summary: "Change a feature's, an item's or a cycle's fields, validated like the lint.",
  usage: "pdocs set <ref> [--lifecycle <l>] [--cycle <slug>] [--<field> <value> …] [--unset <keys>]",
  positionals: [{ name: "ref", required: true }],
  options: OPTIONS,

  run({ ctx, format, flags, positionals }: Invocation): number {
    const [ref] = positionals;
    if (ref === undefined)
      throw new UsageError("set needs a reference — `pdocs set item/<slug> --lifecycle active`.");

    const model = collectWork(ctx);
    const entity = resolveRef(model, ref);
    const row = registryIndex(ctx.config).get(entity.entity) as RegistryRow;
    const abs = join(ctx.repoRoot, entity.path);
    const raw = readFileSync(abs, "utf8");
    const m = /^---\n([\s\S]*?)\n---/.exec(raw);
    if (!m) throw new UsageError(`${entity.path} has no frontmatter block to set fields in.`);
    const block = m[1] as string;
    const before = parseFrontmatter(block);

    // ---- what the caller asked for ---------------------------------------------------
    const rowKeys = [...COMMON_KEYS, ...row.extra.filter((k) => k !== "id")];
    const fills = new Map<string, string>();
    const order: string[] = [];
    for (const [flag, value] of Object.entries(flags)) {
      if (flag === "--unset") continue;
      const key = [...COMMON_KEYS, ...EXTRA_KEYS].find((k) => flagFor(k) === flag);
      if (key === undefined) continue; // a global flag
      if (value === true) throw new UsageError(`${flag} needs a value.`);
      if (!rowKeys.includes(key))
        throw new UsageError(
          `${flag} is not a field of \`${row.type}\` — it takes ${rowKeys.map(flagFor).join(", ")}.`,
          { token: flag, choices: rowKeys.map(flagFor) }
        );
      if (key === "lifecycle" && row.lifecycle === null)
        throw new UsageError(`a \`${row.type}\` carries no lifecycle.`);
      const allowed = vocabulary(row, key);
      if (allowed && !allowed.includes(value))
        throw new UsageError(
          `${flag}: \`${value}\` is not a ${row.type} ${key} — ${allowed.join(" | ")}.`,
          { token: value, choices: [...allowed] }
        );
      fills.set(
        key,
        LIST_KEYS.has(key)
          ? `[${value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
              .join(", ")}]`
          : scalar(value)
      );
      order.push(key);
    }

    const unsetRaw = flags["--unset"];
    if (unsetRaw === true) throw new UsageError("--unset needs a key.");
    const unset = (unsetRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const key of unset) {
      if (!rowKeys.includes(key))
        throw new UsageError(
          `--unset: \`${key}\` is not a field \`set\` can change on a ${row.type} — ${rowKeys.join(", ")}.`,
          { token: key, choices: rowKeys }
        );
      if (fills.has(key)) throw new UsageError(`\`${key}\` is both set and unset.`);
    }
    if (fills.size === 0 && unset.length === 0)
      throw new UsageError(
        `nothing to set — pass a field (${rowKeys.map(flagFor).join(", ")}) or --unset.`
      );

    // ---- the row's own predicate: resolves references, writes their full form ---------
    // Handed only the keys being changed: a value already in the file is the
    // lint's to judge, and must not stop an unrelated change.
    const canonical = new Map<string, string>();
    for (const problem of row.validate?.({
      type: row.type,
      fields: fills,
      documents: existingDocuments(ctx).filter((d) => d.path !== entity.path),
      resolve: (r, kinds) => resolveRef(model, r, kinds),
      scopes: ctx.config.lint.scopes,
      set: (k, v) => {
        if (fills.has(k)) canonical.set(k, v);
      },
    }) ?? [])
      throw problem.kind === "conflict"
        ? new ConflictError(problem.message)
        : new UsageError(problem.message);
    for (const [k, v] of canonical) fills.set(k, v);

    // A key that already holds the value is not a change. It is reported as
    // already set and its line is not rewritten — not even to drop a comment —
    // so a `set` that changes nothing leaves the file byte-identical.
    const same = (key: string, next: string): boolean => {
      const now = before.get(key);
      if (now === undefined) return false;
      const written = parseFrontmatter(`${key}: ${next}`).get(key) ?? "";
      return LIST_KEYS.has(key)
        ? yamlList(now).join("\n") === yamlList(written).join("\n")
        : now === written;
    };
    const unchanged = new Set([...fills].filter(([k, v]) => same(k, v)).map(([k]) => k));
    for (const key of unchanged) fills.delete(key);
    const absent = new Set(unset.filter((k) => !before.has(k)));

    const newBlock = removeFrontmatterKeys(rewriteFrontmatter(block, fills), new Set(unset));
    const newRaw = `---\n${newBlock}\n---${raw.slice(m[0].length)}`;

    // ---- the lint's own rules, before and after ------------------------------------------
    const file = { path: abs, rel: entity.path, type: row.type };
    const docProblems = (text: string) =>
      new Set(documentProblems(file, text, ctx.config.docsRoot, false, registryIndex(ctx.config)).problems);
    const documents = workbenchDocuments(ctx);
    const changed = documents.map((d) =>
      d.rel === entity.path ? { ...d, fields: parseFrontmatter(newBlock) } : d
    );
    const was = new Set([...docProblems(raw), ...workProblems(ctx, documents)]);
    const introduced = [...docProblems(newRaw), ...workProblems(ctx, changed)].filter(
      (p) => !was.has(p)
    );
    if (introduced.length)
      throw new UsageError(
        `refusing: the change would make \`pdocs check\` report ${introduced.length === 1 ? "this" : "these"}:\n  ${introduced.join("\n  ")}`
      );

    if (newRaw !== raw) writeFileSync(abs, newRaw);

    const after = parseFrontmatter(newBlock);
    const value = (map: ReadonlyMap<string, string>, k: string) =>
      map.has(k) ? unquote(map.get(k)) : null;
    const data: SetData = {
      path: entity.path,
      changes: [...order, ...unset].map((key) => ({
        key,
        before: value(before, key),
        after: value(after, key),
        changed: !unchanged.has(key) && !absent.has(key),
      })),
    };

    if (format === "json") printEnvelope("set", data);
    else {
      console.log(data.path);
      for (const c of data.changes)
        console.log(
          shortenIds(
            c.changed
              ? `  ${c.key}: ${c.before ?? "(none)"} -> ${c.after ?? "(none)"}`
              : `  ${c.key}: ${c.after ?? "(none)"} (already ${c.after === null ? "unset" : "set"})`,
            modelIds(model)
          )
        );
    }
    return ExitCode.Success;
  },
};
