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
  /**
   * Also a button in the set's header, while the set is open, for an action on
   * a set (a target of kind `entry`): a way in that does not hide behind a
   * right-click. Its `icon` is the button and its `label` the tooltip; the
   * row's menu keeps it too. Without an icon it stays in the menu alone. The
   * button honours `disabled` and draws `destructive` as the menu does.
   */
  header?: boolean;
};

/** What an app supplies: the actions for one target. Return none for no extras. */
export type MenuActions = (target: MenuTarget) => MenuAction[];
