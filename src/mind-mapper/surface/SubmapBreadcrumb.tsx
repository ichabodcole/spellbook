// R5 SG2 — the submap breadcrumb strip: a second header row (like ZoneTabs)
// rendered only when a submap is open. Shows the client parent-walk
// (top ▸ root ▸ … ▸ current), each ancestor a click back up; the current
// anchor is the non-clickable tail. Navigation is view-local (setActiveAnchor)
// — no fetch, the inclusive snapshot already holds the whole tree.

import { ChevronRight } from "lucide-react";
import type { MapNode } from "./types";
import { Button } from "./ui/button";

export function SubmapBreadcrumb({
  trail,
  onNavigate,
}: {
  // Root-first (root ▸ … ▸ current anchor), from breadcrumbTrail.
  trail: MapNode[];
  // null = back to the top-level board; a node id = into that ancestor's submap.
  onNavigate: (anchor: string | null) => void;
}) {
  if (trail.length === 0) return null;
  const crumbClass = (isCurrent: boolean) =>
    `px-1.5 py-0.5 text-xs ${isCurrent ? "text-ink" : "text-ink-dim hover:text-ink"}`;
  return (
    <nav
      aria-label="Submap breadcrumb"
      className="flex items-center gap-0.5 border-b border-edge bg-surface px-4 py-0.5"
    >
      <Button
        variant="ghost"
        size="auto"
        className={crumbClass(false)}
        onClick={() => onNavigate(null)}
      >
        top
      </Button>
      {trail.map((node, i) => {
        const isCurrent = i === trail.length - 1;
        return (
          <span key={node.id} className="flex items-center gap-0.5">
            <ChevronRight size={11} aria-hidden className="text-ink-faint" />
            <Button
              variant="ghost"
              size="auto"
              className={crumbClass(isCurrent)}
              aria-current={isCurrent ? "page" : undefined}
              disabled={isCurrent}
              onClick={() => onNavigate(node.id)}
            >
              {node.title}
            </Button>
          </span>
        );
      })}
    </nav>
  );
}
