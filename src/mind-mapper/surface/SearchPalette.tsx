// Canvas search (t-934fc210) — the human counterpart of the agent's search
// verb (equal capabilities). Deliberately NOT cmdk (real dep, outside the
// cap) and not Base UI Autocomplete: the query drives live canvas
// highlight/dim, so it lives as controlled state in App; this component is
// just the palette chrome. V1 swaps the guts for hybrid search behind the
// same contract.

import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MapNode, Tier } from "./types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const TIER_BADGE: Record<Tier, string> = {
  canon: "border-canon/60 text-canon",
  thread: "border-thread-tier/60 text-thread-tier",
  "story-local": "border-story-local/60 text-story-local",
  background: "border-background-tier/60 text-background-tier",
};

export function SearchPalette({
  matches,
  query,
  onQuery,
  onPick,
  onClose,
}: {
  matches: MapNode[];
  query: string;
  onQuery: (q: string) => void;
  onPick: (node: MapNode) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clamp the active row as the result set shrinks under it.
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = matches[activeIndex];
      if (pick) onPick(pick);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="absolute left-1/2 top-4 z-20 w-80 -translate-x-1/2 rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search size={13} className="shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            onQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="find a node…"
          aria-label="Find a node"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
        <kbd className="rounded border border-border px-1 text-[9px] text-muted-foreground">
          esc
        </kbd>
      </div>
      {query && (
        <div className="max-h-64 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              nothing on the map matches — not on the board yet?
            </p>
          ) : (
            matches.slice(0, 8).map((n, i) => (
              <Button
                key={n.id}
                variant="ghost"
                size="auto"
                onClick={() => onPick(n)}
                onMouseEnter={() => setActive(i)}
                className={`w-full justify-between gap-2 rounded-sm px-2 py-1.5 ${
                  i === activeIndex ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span className="min-w-0 truncate font-story text-[13px] text-ink">{n.title}</span>
                <Badge className={`shrink-0 px-1.5 py-0 text-[9px] ${TIER_BADGE[n.tier]}`}>
                  {n.tier}
                </Badge>
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
