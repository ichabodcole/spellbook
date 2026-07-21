// R4 R1 — the shared node context-menu chassis, extracted from IdeaNode so
// the canvas and the card grid wrap the SAME menu (built once; A1's action
// slots land here too). The standard verbs are unchanged; pending proposals
// additionally get the queue's ruling verbs (menuInfoFor decides which,
// state/nodeMenu.ts) — ratify-from-menu accepts at suggestedTier, one
// keystroke, and the Claim-D asymmetry holds: user sketches offer withdraw
// only, never a ratify the daemon refuses.

import {
  ArrowUpFromLine,
  Check,
  Crosshair,
  HelpCircle,
  ListTree,
  ScrollText,
  Sparkles,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import type { NodeMenuInfo } from "./state/nodeMenu";
import type { ActionSlot, MapNode, Ruling } from "./types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";

// The node command vocabulary (born plural per t-609741be — future commands
// include agent actions). Promote appears in zone context only (Claim Z3).
export type NodeCommand = "Focus" | "Explain" | "Questions" | "Subtopics" | "Promote";

export function NodeContextMenu({
  node,
  menu,
  promotable,
  onCommand,
  onRule,
  onAction,
  children,
}: {
  node: MapNode;
  menu?: NodeMenuInfo;
  // Zone context only: every node there is a zoned proposal, so the menu
  // gains Promote (a MOVE to the main review queue).
  promotable?: boolean;
  onCommand: (command: NodeCommand) => void;
  onRule?: (proposalId: string, ruling: Ruling) => void;
  // A1 — a slot click SEEDS the composer (seed text + this node as ground),
  // never auto-sends; the caller owns that grammar.
  onAction?: (action: ActionSlot, node: MapNode) => void;
  children: ReactNode;
}) {
  const ruling = menu?.ruling;
  // Captured so the click closure keeps the non-null narrowing.
  const ratifyAs = ruling?.ratifyAs ?? null;
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{node.title}</ContextMenuLabel>
        <ContextMenuItem onClick={() => onCommand("Focus")}>
          <Crosshair /> Focus
        </ContextMenuItem>
        {promotable && (
          <ContextMenuItem onClick={() => onCommand("Promote")}>
            <ArrowUpFromLine /> Promote to main
          </ContextMenuItem>
        )}
        {ruling &&
          onRule &&
          (ruling.author === "agent" ? (
            <>
              {ratifyAs && (
                <ContextMenuItem
                  className="text-pending"
                  onClick={() => onRule(ruling.proposalId, ratifyAs)}
                >
                  <Check /> Ratify as {ratifyAs}
                </ContextMenuItem>
              )}
              <ContextMenuItem
                className="text-ink-faint"
                onClick={() => onRule(ruling.proposalId, "reject")}
              >
                <X /> Reject
              </ContextMenuItem>
            </>
          ) : (
            // A user sketch awaits its doc home (Claim D) — the agent drafts
            // that before it can ratify, so the only ruling on offer here is
            // taking the sketch back.
            <ContextMenuItem
              className="text-ink-faint"
              onClick={() => onRule(ruling.proposalId, "reject")}
            >
              <X /> Withdraw sketch
            </ContextMenuItem>
          ))}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => onCommand("Explain")}>
          <ScrollText /> Explain
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCommand("Questions")}>
          <HelpCircle /> Questions
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCommand("Subtopics")}>
          <ListTree /> Subtopics
        </ContextMenuItem>
        {menu?.actions && onAction && (
          <>
            <ContextMenuSeparator />
            {/* Visibly agent-suggested: the agent's color on this surface is
                thread-tier (FocusBar / ActivityIndicator vocabulary). */}
            <ContextMenuLabel className="flex items-center gap-1.5 normal-case tracking-normal text-thread-tier">
              <Sparkles size={10} aria-hidden /> agent suggests
            </ContextMenuLabel>
            {/* Soft cap, rendered: ~4 items visible, the rest scroll inside
                the menu (cap the visible, never the list — the daemon stores
                the full array). */}
            <div className="max-h-32 overflow-y-auto">
              {menu.actions.map((action) => (
                <ContextMenuItem
                  key={action.id}
                  className="text-thread-tier"
                  onClick={() => onAction(action, node)}
                >
                  <Sparkles /> {action.label}
                </ContextMenuItem>
              ))}
            </div>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
