import { boardOwners, boardTags, type Filters, hasActiveFilters } from "../state/filters";
import type { Task } from "../state/types";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

/**
 * The human's view lens — a thin view-narrowing bar above the columns (the
 * agent already has --mine/--owner/--tag). An active chip uses the SAME warm
 * gold the "doing" status pill uses for its active state; no net-new language.
 * Non-matching cards are HIDDEN, not dimmed — dim is card-aging's language.
 *
 * Renders nothing at all when the board has neither tags nor owners.
 */
export function FilterBar({
  tasks,
  filters,
  onToggleTag,
  onToggleOwner,
  onClear,
}: {
  tasks: Task[];
  filters: Filters;
  onToggleTag: (tag: string) => void;
  onToggleOwner: (owner: string) => void;
  onClear: () => void;
}) {
  const tags = boardTags(tasks, filters.tags);
  const owners = boardOwners(tasks, filters.owners);
  if (tags.length === 0 && owners.length === 0) return null;

  return (
    <div className="mb-4 flex max-w-[1200px] flex-wrap items-center gap-1.5 text-[0.7rem] text-ink-faint">
      {tags.length > 0 && <span className="tracking-[0.08em] uppercase">tags</span>}
      {tags.map((tag) => (
        <Button
          key={`ft-${tag}`}
          variant="chip"
          size="chip"
          aria-pressed={filters.tags.includes(tag)}
          onClick={() => onToggleTag(tag)}
        >
          {tag}
        </Button>
      ))}
      {tags.length > 0 && owners.length > 0 && (
        <Separator orientation="vertical" className="mx-1.5 self-stretch bg-edge" />
      )}
      {owners.length > 0 && <span className="tracking-[0.08em] uppercase">owners</span>}
      {owners.map((o) => (
        <Button
          key={`fo-${o}`}
          variant="chip"
          size="chip"
          aria-pressed={filters.owners.includes(o)}
          onClick={() => onToggleOwner(o)}
        >
          @{o}
        </Button>
      ))}
      {hasActiveFilters(filters) && (
        <Button variant="link" size="chip" className="ml-1 text-ink-faint" onClick={onClear}>
          clear
        </Button>
      )}
    </div>
  );
}
