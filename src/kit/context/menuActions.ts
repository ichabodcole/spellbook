import type { ReactNode } from "react";
import type { ContextEntry, DocView } from "../workspace/protocol";
import type { MenuTargetKind } from "./model";

/**
 * What a right-click landed on, handed to an app's `menuActions` so it can offer
 * actions that make sense there ("Render this document", "Add a voice").
 *
 * `path` is absolute and always present. `entry` is the context entry the click
 * was in (absent on the list's empty background). `doc` is the document the
 * daemon has open at that path: a node in the tree is a file, and it becomes a
 * document when the human opens it, so a file that was never opened has none.
 */
export type MenuTarget = {
  kind: MenuTargetKind;
  path: string;
  entry?: ContextEntry;
  doc?: DocView;
};

/** One app action in a context menu, below the kit's own. */
export type MenuAction = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Drawn as a destructive choice. */
  destructive?: boolean;
};

/** What an app supplies: the actions for one target. Return none for no extras. */
export type MenuActions = (target: MenuTarget) => MenuAction[];
