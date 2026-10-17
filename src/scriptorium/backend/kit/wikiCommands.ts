/**
 * The wiki verbs on the kit path, CLI side (scriptorium-kit-wiki-verbs): the
 * shipped rows (S/backend/cli.ts), with the shipped names, flags and words,
 * each posting its `scriptorium.*` op (`./wiki.ts`). `move-plan` is new: the
 * shipped move plan was the surface's alone.
 *
 * ⛔ Shared by the CLI's bundle: no daemon code here.
 */

import { resolve } from "node:path";
import type { CommandSpec } from "../../../kit/cli/registry";
import { CliError } from "../../../kit/wire/errors";
import type { CliHelpers } from "../../../kit/workspace/verbs";

/** The wiki verbs' flags the kit's table does not have (`find`'s filters, `meta-init --type --by`). */
export const WIKI_OPTIONS = {
  type: { type: "string" },
  status: { type: "string" },
  lifecycle: { type: "string" },
  tag: { type: "string" },
  by: { type: "string" },
} as const;

/** `YYYY-MM-DD`, refused otherwise (the shipped `parseSinceDate`). */
function sinceDate(token: string): string {
  const t = token.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || Number.isNaN(Date.parse(t)))
    throw new CliError("usage", `find --since: "${token}" is not a date — write it as YYYY-MM-DD`);
  return t;
}

export function scriptoriumWikiCommands(h: CliHelpers): readonly CommandSpec<string>[] {
  const { SESSION, postCmd, printJson, sessionOf, docArg } = h;
  return [
    {
      name: "meta",
      flags: [...SESSION],
      positionals: [{ name: "path", required: false }],
      describe:
        "a document's frontmatter as the daemon read it (no path: every context document), with its trust tier and stale",
      run: async (inv) => {
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.meta",
            ...(inv.pos[0] !== undefined ? { path: resolve(inv.pos[0]) } : {}),
          }),
        );
      },
    },
    {
      name: "find",
      flags: [...SESSION, "type", "status", "lifecycle", "tag", "since"],
      positionals: [],
      describe:
        "documents by frontmatter — filters AND, all optional; an empty result is an answer (count)",
      run: async (inv) => {
        const filter: Record<string, string> = {};
        for (const k of ["type", "status", "lifecycle", "tag"] as const) {
          const v = inv.flags[k];
          if (typeof v === "string") filter[k] = v;
        }
        if (typeof inv.flags.since === "string") filter.since = sinceDate(inv.flags.since);
        printJson(await postCmd(sessionOf(inv), { op: "scriptorium.find", filter }));
      },
    },
    {
      name: "meta-init",
      flags: [...SESSION, "type", "by"],
      positionals: [{ name: "path", required: true }],
      describe:
        "add a frontmatter block to a document that has none (type guessed from its neighbours)",
      run: async (inv) => {
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.meta.init",
            path: resolve(inv.pos[0] as string),
            ...(typeof inv.flags.type === "string" ? { metaType: inv.flags.type } : {}),
            ...(typeof inv.flags.by === "string" ? { by: inv.flags.by } : {}),
          }),
        );
      },
    },
    {
      name: "meta-set",
      flags: [...SESSION],
      positionals: [
        { name: "path", required: true },
        { name: "key=value", required: true, variadic: true },
      ],
      describe: "set frontmatter keys — one line edit each, everything else untouched",
      run: async (inv) => {
        const fields: Record<string, string> = {};
        for (const pair of inv.pos.slice(1)) {
          const eq = pair.indexOf("=");
          if (eq <= 0)
            throw new CliError("usage", `"${pair}" is not key=value`, {
              hint: "meta-set <path> status=stable lifecycle=live",
            });
          fields[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.meta.set",
            path: resolve(inv.pos[0] as string),
            fields,
          }),
        );
      },
    },
    {
      name: "forget",
      flags: [...SESSION, "doc"],
      positionals: [],
      describe:
        "forget a document whose file of record is gone (refused while the file exists — use hide to take one out of the context)",
      run: async (inv) => {
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.forget",
            ...(typeof inv.flags.doc === "string" ? { doc: docArg(inv.flags.doc) } : {}),
          }),
        );
      },
    },
    {
      name: "move-plan",
      flags: [...SESSION],
      positionals: [
        { name: "path", required: true },
        { name: "into", required: true },
      ],
      describe:
        "what move <path> <into> would do, without doing it: what moves (docs), whether it leaves its git working tree (leavesRepo), and links, the links it would break, each with the rewrite move --update-links would offer; refuses what move refuses; writes nothing",
      run: async (inv) => {
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.move.plan",
            path: resolve(inv.pos[0] as string),
            into: resolve(inv.pos[1] as string),
          }),
        );
      },
    },
    {
      name: "note-remove",
      flags: [...SESSION, "doc"],
      positionals: [{ name: "id", required: true }],
      describe: "delete a note",
      run: async (inv) => {
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.note.remove",
            id: inv.pos[0] as string,
            ...(typeof inv.flags.doc === "string" ? { doc: docArg(inv.flags.doc) } : {}),
          }),
        );
      },
    },
    {
      name: "task-remove",
      flags: [...SESSION],
      positionals: [{ name: "id", required: true }],
      describe:
        "forget a finished task entirely — for one started by mistake, cancel it first (task-cancel)",
      run: async (inv) => {
        printJson(
          await postCmd(sessionOf(inv), {
            op: "scriptorium.task.remove",
            id: inv.pos[0] as string,
          }),
        );
      },
    },
    {
      name: "tasks-clear",
      flags: [...SESSION],
      positionals: [],
      describe: "forget every finished task; outstanding ones are left alone",
      run: async (inv) => {
        printJson(await postCmd(sessionOf(inv), { op: "scriptorium.tasks.clear" }));
      },
    },
    {
      name: "info",
      flags: [...SESSION],
      positionals: [],
      describe: "print the resolved session pointer",
      run: (inv) => {
        printJson(h.requireSession(sessionOf(inv)));
      },
    },
  ];
}
