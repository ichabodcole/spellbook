// R4 R1 → drive7 #2a — the shared node context-menu chassis. The action SET is
// now derived ONCE (state/nodeActions.ts, buildNodeActions) and rendered here
// AND in NodeDetail, so the two can't drift (the mirror-drift class the R7 gate
// caught). This file only maps an ActionItem to the compact context-menu
// vocabulary (items, a "Select ▸" flyout, group separators). drive7 #6A adds
// the selection-aware section: with ≥2 nodes selected, the right-clicked node
// is the designated submap parent/anchor and the multi-node gestures resolve
// inline (no parent-pick modal).

import { FolderTree, Layers } from "lucide-react";
import type { ReactNode } from "react";
import type { MultiSelectActions } from "./state/multiSelect";
import type { ActionItem, ActionTone } from "./state/nodeActions";
import { buildNodeActions } from "./state/nodeActions";
import type { NodeMenuInfo } from "./state/nodeMenu";
import type { BatchRuling } from "./state/submapAppend";
import type { ActionSlot, MapNode, Ruling } from "./types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "./ui/context-menu";

// R6 DEL etc. — the node command vocabulary (born plural per t-609741be).
export type NodeCommand =
  | "Focus"
  | "Select connected"
  | "Select children"
  | "Select parents"
  | "Enter submap"
  | "Explain"
  | "Questions"
  | "Subtopics"
  | "Promote"
  | "Delete";

const NEST_TIERS: BatchRuling[] = ["canon", "thread", "story-local"];

// tone → the compact menu's class vocabulary (semantic tokens only).
const TONE_CLASS: Record<ActionTone, string> = {
  default: "",
  pending: "text-pending",
  danger: "text-attention",
  agent: "text-thread-tier",
  faint: "text-ink-faint",
};

// The groups that open a new section (a separator before their first item),
// matching the pre-extraction menu's rhythm.
const SECTION_BREAK = new Set(["verbs", "slots", "danger"]);

function ItemRow({ item }: { item: ActionItem }) {
  const Icon = item.icon;
  return (
    <ContextMenuItem
      className={`${TONE_CLASS[item.tone]} ${item.suggested ? "font-semibold" : ""}`}
      onClick={() => item.run()}
    >
      <Icon /> {item.label}
    </ContextMenuItem>
  );
}

export function NodeContextMenu({
  node,
  menu,
  promotable,
  onCommand,
  onRule,
  onAction,
  multi,
  selectionCount,
  onGroupSubmap,
  onNestSubmap,
  onGroupZone,
  children,
}: {
  node: MapNode;
  menu?: NodeMenuInfo;
  promotable?: boolean;
  onCommand: (command: NodeCommand) => void;
  onRule?: (proposalId: string, ruling: Ruling) => void;
  onAction?: (action: ActionSlot, node: MapNode) => void;
  // drive7 #6A — the multi-actions valid with THIS node as parent/anchor over
  // the current selection (null = none; single-select keeps today's menu).
  multi?: MultiSelectActions | null;
  selectionCount?: number;
  onGroupSubmap?: (parentId: string) => void;
  onNestSubmap?: (parentId: string, tier: BatchRuling) => void;
  onGroupZone?: () => void;
  children: ReactNode;
}) {
  const items = buildNodeActions(node, menu, promotable, { onCommand, onRule, onAction });
  const showMulti = multi && (selectionCount ?? 0) >= 2;

  let prevGroup = "";
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="truncate">{node.title}</ContextMenuLabel>

        {/* #6A — the selection-aware section: multi-node gestures, the clicked
            node designating the submap parent/anchor. Resolves inline. */}
        {showMulti && (
          <>
            <ContextMenuLabel className="flex items-center gap-1.5 normal-case tracking-normal text-ink-dim">
              <Layers size={10} aria-hidden /> {selectionCount} selected
            </ContextMenuLabel>
            {multi.groupSubmap && onGroupSubmap && (
              <ContextMenuItem onClick={() => onGroupSubmap(node.id)}>
                <FolderTree /> Group under this as submap
              </ContextMenuItem>
            )}
            {multi.nestSubmap && onNestSubmap && (
              <ContextMenuSub>
                <ContextMenuSubTrigger className="text-pending">
                  <FolderTree /> Nest under this as submap
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {NEST_TIERS.map((tier) => (
                    <ContextMenuItem
                      key={tier}
                      className="text-pending"
                      onClick={() => onNestSubmap(node.id, tier)}
                    >
                      Ratify all as {tier}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            )}
            {multi.groupZone && onGroupZone && (
              <ContextMenuItem className="text-pending" onClick={() => onGroupZone()}>
                <Layers /> Group selected into a zone…
              </ContextMenuItem>
            )}
            <ContextMenuSeparator />
          </>
        )}

        {/* Flatten to keyed siblings (no wrapper element) — Base UI's menu
            registers items via context, but arrow-key nav + ARIA want the
            items as direct Popup children, not nested in spans. */}
        {items.flatMap((item) => {
          const rows: ReactNode[] = [];
          if (SECTION_BREAK.has(item.group) && item.group !== prevGroup) {
            rows.push(<ContextMenuSeparator key={`${item.key}-sep`} />);
          }
          if (item.group === "slots" && prevGroup !== "slots") {
            rows.push(
              <ContextMenuLabel
                key={`${item.key}-label`}
                className="flex items-center gap-1.5 normal-case tracking-normal text-thread-tier"
              >
                agent suggests
              </ContextMenuLabel>,
            );
          }
          prevGroup = item.group;
          if (item.submenu) {
            const Icon = item.icon;
            rows.push(
              <ContextMenuSub key={item.key}>
                <ContextMenuSubTrigger>
                  <Icon /> {item.label}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  {item.submenu.map((sub) => (
                    <ItemRow key={sub.key} item={sub} />
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>,
            );
          } else {
            rows.push(<ItemRow key={item.key} item={item} />);
          }
          return rows;
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}
