// Canvas search (t-934fc210) — the human counterpart of the agent's search
// verb (equal capabilities). Deliberately NOT cmdk (real dep, outside the
// cap) and not Base UI Autocomplete: the query drives live canvas
// highlight/dim, so it lives as controlled state in App; this component is
// just the palette chrome. Round 3 (Claim S1): rows keep their hit KIND —
// proposal rows wear the pending vocabulary (dashed border, text-pending,
// the TIER_BADGE idiom) and carry a zone tag when zoned; the no-results
// state says what was searched and names the doc/message matches that live
// off-board instead of pretending the search found nothing.

import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OffBoardCounts, PaletteRow } from "./state/searchRows";
import type { Tier } from "./types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

const TIER_BADGE: Record<Tier, string> = {
  canon: "border-canon/60 text-canon",
  thread: "border-thread-tier/60 text-thread-tier",
  "story-local": "border-story-local/60 text-story-local",
  background: "border-background-tier/60 text-background-tier",
};

// The pending vocabulary, TIER_BADGE's idiom: dashed + text-pending, same
// marks the canvas card wears.
const PROPOSAL_BADGE = "border-dashed border-pending/60 text-pending";

function offBoardLine(offBoard: OffBoardCounts): string | null {
  const parts: string[] = [];
  if (offBoard.docs > 0) parts.push(`${offBoard.docs} doc${offBoard.docs === 1 ? "" : "s"}`);
  if (offBoard.messages > 0) {
    parts.push(`${offBoard.messages} message${offBoard.messages === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  const verb = offBoard.docs + offBoard.messages === 1 ? "matches" : "match";
  return `${parts.join(" and ")} ${verb} off-board — ask about it in chat.`;
}

export function SearchPalette({
  rows,
  offBoard,
  query,
  onQuery,
  onPick,
  onClose,
}: {
  rows: PaletteRow[];
  offBoard: OffBoardCounts;
  query: string;
  onQuery: (q: string) => void;
  onPick: (row: PaletteRow) => void;
  onClose: () => void;
}) {
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clamp the active row as the result set shrinks under it.
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = rows[activeIndex];
      if (pick) onPick(pick);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const offBoardNote = offBoardLine(offBoard);

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
          {rows.length === 0 ? (
            <div className="space-y-1 px-2 py-1.5 text-xs text-muted-foreground">
              <p>nothing on the map matches “{query}”.</p>
              {offBoardNote && <p>{offBoardNote}</p>}
            </div>
          ) : (
            rows.slice(0, 8).map((row, i) => (
              <Button
                key={row.node.id}
                variant="ghost"
                size="auto"
                onClick={() => onPick(row)}
                onMouseEnter={() => setActive(i)}
                className={`w-full justify-between gap-2 rounded-sm px-2 py-1.5 ${
                  i === activeIndex ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span
                  className={`min-w-0 truncate font-story text-[13px] ${
                    row.kind === "proposal" ? "text-pending" : "text-ink"
                  }`}
                >
                  {row.node.title}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {row.kind === "proposal" ? (
                    <>
                      <Badge className={`px-1.5 py-0 text-[9px] ${PROPOSAL_BADGE}`}>proposed</Badge>
                      {row.zoneId && (
                        <Badge className={`px-1.5 py-0 text-[9px] ${PROPOSAL_BADGE}`}>
                          {row.zoneId}
                        </Badge>
                      )}
                    </>
                  ) : (
                    <Badge className={`px-1.5 py-0 text-[9px] ${TIER_BADGE[row.node.tier]}`}>
                      {row.node.tier}
                    </Badge>
                  )}
                </span>
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
