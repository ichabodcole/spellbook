/**
 * Scriptorium's own verbs on the kit path, beside the kit's. Each posts one of
 * the kit's structure ops: the behaviour, its undo and its chat line are the
 * kit's, so Story Studio gets the same act by wiring the same op.
 *
 * - `make-set <path>`: the shipped `make-set` (E22) on the kit's `set.make`. A
 *   document listed on its own becomes a set: a folder named for it beside it,
 *   the document moved in, the same entry (by id) now mirroring the folder.
 * - `add-folder <path>`: a new, empty folder at a path the caller names, on the
 *   kit's `folder.add`. Outside every set it is a new set in the context; where
 *   a set shows folders, a folder there. This is how a new place for files is
 *   made without a default workspace (`scriptorium-no-default-workspace`).
 *
 * ⛔ Shared by the CLI's bundle: no daemon code here.
 */

import { resolve } from "node:path";
import type { CommandSpec } from "../../../kit/cli/registry";
import type { CliHelpers } from "../../../kit/workspace/verbs";

export function scriptoriumKitCommands(h: CliHelpers): readonly CommandSpec<string>[] {
  return [
    {
      name: "make-set",
      flags: [...h.SESSION],
      positionals: [{ name: "path", required: true }],
      describe:
        "turn a document listed on its own into a set: a folder named for it beside it, the document moved in, the same entry; prints `broken`, the links the move broke, which it does not rewrite",
      run: async (inv) => {
        h.printJson(
          await h.postCmd(h.sessionOf(inv), {
            op: "set.make",
            path: resolve(inv.pos[0] as string),
          }),
        );
      },
    },
    {
      name: "add-folder",
      flags: [...h.SESSION],
      positionals: [{ name: "path", required: true }],
      describe:
        "create an empty folder at <path>, anywhere on disk whose parent exists: a new set in the context, or a folder inside the set that shows that place",
      run: async (inv) => {
        h.printJson(
          await h.postCmd(h.sessionOf(inv), {
            op: "folder.add",
            path: resolve(inv.pos[0] as string),
          }),
        );
      },
    },
  ];
}
