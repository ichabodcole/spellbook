// `pdocs backlinks <target>` — what cites this.
//
// The question asked before moving, rewriting or archiving a page, and the one
// nothing in this repository could answer without grepping for two different
// spellings of the same document.
//
// TWO KINDS OF INBOUND EDGE, KEPT APART, because they mean different things.
// A `related:` edge is a claim about the documents' RELATIONSHIP, written by
// hand in the frontmatter and addressed by `type/slug` so it survives the page
// moving folders. A body link is a citation in prose, addressed by path, and it
// breaks the moment the file moves. Collapsing them into one list would hide
// exactly the distinction that decides what a rename costs.
//
// The target may be written either way for the same reason: an agent that just
// read a `find` result has a path, and an agent that just read a `related:`
// list has a key. Refusing one of them would mean the caller has to convert
// between two vocabularies this command already knows how to read.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command, Invocation } from "../cli.ts";
import { parseFrontmatter } from "../docs-lint/index.ts";
import {
  ExitCode,
  NotFoundError,
  UsageError,
  printEnvelope,
} from "../envelope.ts";
import {
  type Page,
  collectPages,
  pageAliasKeys,
  pageKey,
} from "../pages.ts";

/** A citing document, named the way its reader will want it. */
export interface Backlink {
  path: string;
  title: string | null;
}

/** What the argument resolved to. Not necessarily a `Page`: see
 *  `resolveTarget`. */
export interface BacklinkTarget {
  path: string;
  type: string;
  /** `type/slug`, or `null` for a document whose folder declares no type —
   *  such a page cannot be the endpoint of a `related:` edge at all. */
  key: string | null;
  title: string | null;
}

export interface BacklinksData {
  target: BacklinkTarget;
  /** Pages whose `related:` list names the target's key. */
  related: Backlink[];
  /** Pages whose body links the target's path. */
  links: Backlink[];
  count: number;
}

/**
 * The target, as a path or as a `type/slug` key.
 *
 * A path is tried first and matched exactly, because a path is unambiguous and
 * a key is not: every project folder holds a `proposal.md`, so the key
 * `proposal/proposal` names a dozen documents. That case is a USAGE error, not
 * a not-found — the request is answerable, the caller just has to say which one
 * — and the diagnostic lists the candidates so they can.
 *
 * `project/<name>` is the third form, and it is what a caller reaching for
 * `proposal/<name>` actually wants. See `pageAliasKeys` for why `type/slug`
 * cannot name a project, and the note at its use below for why the
 * `proposal/<name>` spelling is not also accepted.
 *
 * A PATH MAY NAME A FILE THAT IS NOT A `Page`, and that is on purpose.
 * `collectPages` skips contract pages (`SCHEMA.md`, the folder `README`s) and
 * templates, because those are documents ABOUT the tree rather than entries in
 * it — but `docs/SCHEMA.md` is the single most-cited file in the repository and
 * "what breaks if I move this" is exactly the question asked about it. So a
 * path that resolves on disk is answerable whether or not the lint types it.
 * Such a target has no `type/slug` key, so it reports no `related` edges — and
 * correctly: nothing can write a `related:` edge to a contract page.
 */
export function resolveTarget(
  repoRoot: string,
  pages: Page[],
  target: string
): BacklinkTarget {
  const wanted = target.replace(/^\.\//, "");

  const byPath = pages.find((p) => p.path === wanted);
  if (byPath)
    return {
      path: byPath.path,
      type: byPath.type,
      key: pageKey(byPath),
      title: byPath.title,
    };

  const slash = wanted.lastIndexOf("/");
  if (slash > 0) {
    const type = wanted.slice(0, slash);
    const slug = wanted.slice(slash + 1);

    // `project/<name>` FIRST, because it is the more specific of the two and
    // the only one that can name a project at all. It is the same form
    // `pdocs new cycle --scope` takes and the same form the cycle template
    // writes — accepting it in one place and not the other would leave a caller
    // converting between two spellings this command already understands.
    //
    // `proposal/<name>` is deliberately NOT accepted. `pages.ts` never emits
    // it, nothing in the tree writes it, and inventing it would be a third
    // spelling of the thing `project/<name>` already says. The ambiguity
    // diagnostic below is what a caller who tries `proposal/proposal` gets, and
    // it points at the paths.
    const byAlias = pages.filter((p) => pageAliasKeys(p).includes(wanted));
    if (byAlias.length === 1) {
      const page = byAlias[0] as Page;
      return {
        path: page.path,
        type: page.type,
        key: pageKey(page),
        title: page.title,
      };
    }

    const byKey = pages.filter(
      (p) => p.type === type && basename(p.path, ".md") === slug
    );
    if (byKey.length === 1) {
      const page = byKey[0] as Page;
      return {
        path: page.path,
        type: page.type,
        key: pageKey(page),
        title: page.title,
      };
    }
    if (byKey.length > 1) {
      // Named, but bounded: `proposal/proposal` matches every project in the
      // tree, and a diagnostic that pastes forty paths into stderr is one
      // nobody reads.
      const shown = byKey.slice(0, 5).map((p) => p.path);
      const rest = byKey.length - shown.length;
      throw new UsageError(
        `\`${target}\` names ${byKey.length} documents — ${shown.join(", ")}` +
          `${rest > 0 ? `, and ${rest} more` : ""}. Pass the path instead.`
      );
    }
  }

  const abs = join(repoRoot, wanted);
  if (wanted.endsWith(".md") && existsSync(abs)) {
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(abs, "utf8"));
    const fields = m
      ? parseFrontmatter(m[1] as string)
      : new Map<string, string>();
    return {
      path: wanted,
      type: "",
      key: null,
      title: fields.get("title") ?? null,
    };
  }

  throw new NotFoundError(
    `no document \`${target}\` — expected a repo-relative path ` +
      `(docs/playbooks/foo-playbook.md), a \`type/slug\` key ` +
      `(playbook/foo-playbook), or \`project/<name>\` for a project.`
  );
}

export function backlinksData(
  pages: Page[],
  target: BacklinkTarget
): BacklinksData {
  const key = target.key;
  const cite = (p: Page): Backlink => ({ path: p.path, title: p.title });

  const related =
    key === null
      ? []
      : pages.filter((p) => p.path !== target.path && p.related.includes(key));
  const links = pages.filter(
    (p) => p.path !== target.path && p.linksOut.includes(target.path)
  );

  return {
    target,
    related: related.map(cite),
    links: links.map(cite),
    count: related.length + links.length,
  };
}

function renderText(data: BacklinksData): void {
  console.log(
    `${data.target.path}${data.target.key ? `  (${data.target.key})` : ""}`
  );

  if (data.count === 0) {
    console.log("\nno inbound edges");
    return;
  }

  const section = (label: string, rows: Backlink[]) => {
    if (rows.length === 0) return;
    console.log(`\n  ${label}  (${rows.length})`);
    for (const row of rows) console.log(`    ${row.path}`);
  };

  section("related", data.related);
  section("links", data.links);
}

export const backlinks: Command = {
  name: "backlinks",
  summary:
    "What cites a document — `related:` edges and body links, kept apart.",
  usage: "pdocs backlinks <target> [--root <path>] [--format text|json]",
  options: [],
  positionals: [{ name: "target", required: true }],

  run({ ctx, format, positionals }: Invocation): number {
    const target = positionals[0];
    if (target === undefined)
      throw new UsageError(
        "backlinks needs a target — `pdocs backlinks docs/playbooks/foo-playbook.md`, " +
          "`pdocs backlinks playbook/foo-playbook` or `pdocs backlinks project/oauth-upgrade`."
      );

    const pages = collectPages(ctx);
    const data = backlinksData(
      pages,
      resolveTarget(ctx.repoRoot, pages, target)
    );

    if (format === "json") printEnvelope("backlinks", data);
    else renderText(data);

    // Zero even when nothing cites it. "Nothing links here" is the answer the
    // caller came for as often as the list is.
    return ExitCode.Success;
  },
};
