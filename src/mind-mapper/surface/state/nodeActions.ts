// drive7 #2a — the ONE declarative node-action model, rendered by BOTH the
// right-click context menu (NodeContextMenu) and the detail panel (NodeDetail)
// so the two can't drift (the mirror-drift class the R7 gate caught: two
// hand-written copies of the same action set WILL diverge). The set, its order,
// its conditions, and its tier-picker rules live HERE once; each renderer only
// maps an ActionItem to its own element vocabulary (compact menu item vs roomy
// detail button). The `run` closures capture the caller's dispatch props — the
// handlers are pure dispatchers (onCommand/onRule/onAction), so the extraction
// is mechanical and nothing menu-only leaks (SEAM 2 ratified).

import {
  ArrowUpFromLine,
  Check,
  ChevronsDown,
  ChevronsUp,
  Crosshair,
  FolderTree,
  HelpCircle,
  ListTree,
  type LucideIcon,
  ScrollText,
  Sparkles,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import type { NodeCommand } from "../NodeContextMenu";
import type { ActionSlot, MapNode, Ruling } from "../types";
import type { NodeMenuInfo } from "./nodeMenu";

export type ActionTone = "default" | "pending" | "danger" | "agent" | "faint";
// Groups let a renderer place separators at boundaries without hard-coding the
// item order twice.
export type ActionGroup = "focus" | "select" | "navigate" | "ratify" | "verbs" | "slots" | "danger";

export type ActionItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  tone: ActionTone;
  group: ActionGroup;
  // drive7 #1 — true on the suggested tier's fast-pick (the one to highlight);
  // the OTHER tiers are always offered too, killing the "mis-tagged nodes get
  // more options" inversion.
  suggested?: boolean;
  // drive7 #2b — a flyout: the directional-select cluster nests here so the
  // compact menu stays short. Renderers that have room (the detail panel) may
  // splay it inline instead.
  submenu?: ActionItem[];
  run: () => void;
};

export type NodeActionDispatch = {
  onCommand: (command: NodeCommand) => void;
  onRule?: (proposalId: string, ruling: Ruling) => void;
  onAction?: (action: ActionSlot, node: MapNode) => void;
};

// The three tiers that are valid accept-rulings, in canonical order.
const TIER_ORDER: Exclude<Ruling, "reject">[] = ["canon", "thread", "story-local"];

// drive7 #1 — the uniform tier picker: ALWAYS the three tiers, with the
// suggested one first and flagged (a fast-pick) when it's a valid ruling. A
// null suggestion (background / an unrecognized "cast" slip) just yields the
// three in canonical order with nothing pre-highlighted — never a Reject-only
// dead end, and never "1 only" for a correctly-tagged node. Pure + tested.
export function ratifyTierOptions(
  ratifyAs: Exclude<Ruling, "reject"> | null,
): { tier: Exclude<Ruling, "reject">; suggested: boolean }[] {
  if (ratifyAs && TIER_ORDER.includes(ratifyAs)) {
    return [
      { tier: ratifyAs, suggested: true },
      ...TIER_ORDER.filter((t) => t !== ratifyAs).map((t) => ({ tier: t, suggested: false })),
    ];
  }
  return TIER_ORDER.map((t) => ({ tier: t, suggested: false }));
}

// The shared builder. Returns a FLAT, ordered ActionItem[] tagged by group;
// renderers insert separators at group changes. The "select" flyout is a single
// item carrying its trio as `submenu`.
export function buildNodeActions(
  node: MapNode,
  menu: NodeMenuInfo | undefined,
  promotable: boolean | undefined,
  dispatch: NodeActionDispatch,
): ActionItem[] {
  const { onCommand, onRule, onAction } = dispatch;
  const items: ActionItem[] = [];

  items.push({
    key: "focus",
    label: "Focus",
    icon: Crosshair,
    tone: "default",
    group: "focus",
    run: () => onCommand("Focus"),
  });

  // #2b — the directional-select cluster as one "Select ▸" flyout.
  items.push({
    key: "select",
    label: "Select",
    icon: Waypoints,
    tone: "default",
    group: "select",
    submenu: [
      {
        key: "select-connected",
        label: "Connected",
        icon: Waypoints,
        tone: "default",
        group: "select",
        run: () => onCommand("Select connected"),
      },
      {
        key: "select-children",
        label: "Children",
        icon: ChevronsDown,
        tone: "default",
        group: "select",
        run: () => onCommand("Select children"),
      },
      {
        key: "select-parents",
        label: "Parents",
        icon: ChevronsUp,
        tone: "default",
        group: "select",
        run: () => onCommand("Select parents"),
      },
    ],
    run: () => {},
  });

  if ((node.submapChildCount ?? 0) > 0) {
    items.push({
      key: "enter-submap",
      label: "Enter submap",
      icon: FolderTree,
      tone: "default",
      group: "navigate",
      run: () => onCommand("Enter submap"),
    });
  }

  if (promotable) {
    items.push({
      key: "promote",
      label: "Promote to main",
      icon: ArrowUpFromLine,
      tone: "default",
      group: "navigate",
      run: () => onCommand("Promote"),
    });
  }

  // Ruling verbs — a pending proposal only. Agent proposals get the uniform
  // tier picker (#1) + Reject; user sketches await their doc home, so the only
  // ruling on offer is taking the sketch back (the Claim-D asymmetry).
  const ruling = menu?.ruling;
  if (ruling && onRule) {
    if (ruling.author === "agent") {
      for (const { tier, suggested } of ratifyTierOptions(ruling.ratifyAs)) {
        items.push({
          key: `ratify-${tier}`,
          label: `Ratify as ${tier}`,
          icon: Check,
          tone: "pending",
          group: "ratify",
          suggested,
          run: () => onRule(ruling.proposalId, tier),
        });
      }
      items.push({
        key: "reject",
        label: "Reject",
        icon: X,
        tone: "faint",
        group: "ratify",
        run: () => onRule(ruling.proposalId, "reject"),
      });
    } else {
      items.push({
        key: "withdraw",
        label: "Withdraw sketch",
        icon: X,
        tone: "faint",
        group: "ratify",
        run: () => onRule(ruling.proposalId, "reject"),
      });
    }
  }

  for (const [label, icon, command] of [
    ["Explain", ScrollText, "Explain"],
    ["Questions", HelpCircle, "Questions"],
    ["Subtopics", ListTree, "Subtopics"],
  ] as const) {
    items.push({
      key: `verb-${command}`,
      label,
      icon,
      tone: "default",
      group: "verbs",
      run: () => onCommand(command),
    });
  }

  if (menu?.actions && onAction) {
    for (const action of menu.actions) {
      items.push({
        key: `slot-${action.id}`,
        label: action.label,
        icon: Sparkles,
        tone: "agent",
        group: "slots",
        run: () => onAction(action, node),
      });
    }
  }

  items.push({
    key: "delete",
    label: "Delete",
    icon: Trash2,
    tone: "danger",
    group: "danger",
    run: () => onCommand("Delete"),
  });

  return items;
}
