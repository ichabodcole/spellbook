import { cn } from "cn";
import { type KeyboardEvent, useRef } from "react";
import { blockedLabel, liveBlockerCount, staleLabel, wipCued, wipLabel } from "../state/cards";
import { STATUSES, type Task, type TaskStatus } from "../state/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * One card. Everything it decides about itself — blocked, stale, over-WIP — is
 * decided by a predicate in the skill's shared/ folder, the same one the daemon
 * runs. The card owns the WORDING and the layout, nothing else.
 *
 * ⚠ The title is a contenteditable, and the drag interaction rides on it: a
 * mousedown inside the title turns the card's `draggable` OFF so a text
 * selection is not a drag, and the blur turns it back on. That handshake is the
 * reason `draggable` is a DOM attribute written imperatively rather than a
 * React prop — a controlled prop would fight the mousedown.
 */
export function TaskCard({
  task,
  tasks,
  now,
  overWip,
  dragging,
  marker,
  onDragStart,
  onDragEnd,
  onToggle,
  onEditTitle,
  onOpenDetail,
  onRemove,
}: {
  task: Task;
  tasks: Task[];
  now: number;
  overWip: Set<string>;
  dragging: boolean;
  marker: "before" | "after" | null;
  onDragStart: (task: Task, e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onToggle: (task: Task, status: TaskStatus) => void;
  onEditTitle: (task: Task, title: string) => void;
  onOpenDetail: (task: Task) => void;
  onRemove: (id: string) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);

  const blocked = liveBlockerCount(task, tasks);
  const stale = staleLabel(task, tasks, now);
  const cued = wipCued(task, overWip);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag SOURCE — dragstart/dragend, never click. Every action on this card is a real control inside it.
    <div
      ref={cardRef}
      data-task-id={task.id}
      data-task-status={task.status}
      draggable="true"
      onDragStart={(e) => onDragStart(task, e)}
      onDragEnd={() => {
        cardRef.current?.setAttribute("draggable", "true");
        onDragEnd();
      }}
      className={cn(
        "cursor-grab rounded-md border border-edge bg-surface-raised px-2.5 py-2 shadow-[0_1px_2px_var(--color-well)] transition-colors hover:border-edge-hover hover:bg-surface-hover",
        blocked > 0 && "border-l-2 border-l-danger opacity-[0.82]",
        stale && "opacity-[0.82]",
        dragging && "cursor-grabbing opacity-40",
        marker === "before" && "border-t-2 border-t-ice pt-[calc(0.5rem-2px)]",
        marker === "after" && "border-b-2 border-b-ice pb-[calc(0.5rem-2px)]",
      )}
    >
      {/* The title edits in place. A contenteditable is natively focusable and a
          real editing host, so it takes the ARIA role that describes one. */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <input>/<textarea> cannot be this — the title is the card's heading, it wraps, and it grows with its content */}
      <div
        ref={titleRef}
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label="Task title"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        className="title-empty min-h-[1.2em] text-[0.92rem] break-words text-ink outline-none focus:-mx-1.5 focus:-my-0.5 focus:rounded-sm focus:bg-surface-editing focus:px-1.5 focus:py-0.5"
        onMouseDown={() => cardRef.current?.setAttribute("draggable", "false")}
        onBlur={(e) => {
          cardRef.current?.setAttribute("draggable", "true");
          const next = e.currentTarget.textContent ?? "";
          // An empty title is REVERTED: the daemon rejects it, and the visible
          // text would otherwise diverge from canonical state.
          if (next.trim() === "") e.currentTarget.textContent = task.title;
          else onEditTitle(task, next);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.textContent = task.title;
            e.currentTarget.blur();
          }
        }}
      >
        {task.title}
      </div>

      {blocked > 0 && (
        <div className="mt-1 inline-flex items-center gap-1 text-[0.7rem] font-medium text-danger">
          {blockedLabel(blocked)}
        </div>
      )}

      {stale && (
        <div className="mt-1 inline-flex items-center gap-1 text-[0.7rem] text-ink-dim">
          {stale}
        </div>
      )}

      {cued && (
        <div className="mt-1 inline-flex items-center gap-1.5 text-[0.7rem] text-ice-ink before:size-1.5 before:rounded-full before:bg-ice before:opacity-85 before:content-['']">
          {wipLabel(task, tasks)}
        </div>
      )}

      {task.notes && (
        <button
          type="button"
          title="View / edit description"
          onClick={() => onOpenDetail(task)}
          // ⛔ NO `block` HERE. `line-clamp-2` IS a display utility — it sets
          // `display: -webkit-box` along with the orient and the line count —
          // so `block` beside it is a display conflict, tailwind-merge keeps the
          // last one, and the clamp silently dies. Shipped that way and caught
          // by measuring `scrollHeight > clientHeight` rather than by reading
          // the class list, which looks correct.
          className="mt-1 w-full cursor-pointer text-left text-[0.78rem] whitespace-pre-wrap text-ink-dim line-clamp-2 hover:text-ink"
        >
          {task.notes}
        </button>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {STATUSES.map((s) => (
          <Button
            key={s}
            variant="pill"
            size="chip"
            tone={task.status === s ? s : undefined}
            onClick={() => onToggle(task, s)}
          >
            {s}
          </Button>
        ))}
        <Button
          variant="outline"
          size="chip"
          title="Details / edit description"
          aria-label="Details / edit description"
          className="rounded-sm px-1.5 text-[0.85rem] text-ink-faint"
          onClick={() => onOpenDetail(task)}
        >
          ⋯
        </Button>
        <Button
          variant="ghost"
          size="chip"
          className="ml-auto rounded-sm text-ink-faint hover:bg-transparent hover:text-danger"
          onClick={() => onRemove(task.id)}
        >
          delete
        </Button>
      </div>

      {task.tags && task.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {task.tags.map((tag) => (
            <Badge key={tag} variant="chip">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {task.owner && (
        <div className="mt-1.5 text-[0.7rem] tracking-[0.01em] text-loam-ink">@{task.owner}</div>
      )}
    </div>
  );
}
