import { cn } from "cn";
import { useRef, useState } from "react";
import { type CardBox, dropIndex, dropMarker } from "../state/drag";
import type { Task, TaskStatus } from "../state/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { TaskCard } from "./TaskCard";

/** The per-status panel wash. Todo keeps the base surface. */
const PANEL: Record<TaskStatus, string> = {
  todo: "bg-surface",
  doing: "bg-surface-doing",
  review: "bg-surface-review",
  done: "bg-surface-done",
};

/** The column head's label colour follows the status vocabulary. */
const HEAD: Record<TaskStatus, string> = {
  todo: "text-ink-dim",
  doing: "text-mammoth-ink",
  review: "text-amethyst-ink",
  done: "text-ice-ink",
};

/**
 * One column, and the whole drop interaction for it.
 *
 * ⚠ THE DROP MARKER IS DERIVED, NOT WRITTEN. The old page cleared and stamped
 * classes on DOM nodes imperatively from `dragover`, which is why a frame
 * arriving mid-drag could wipe the hint out from under the pointer. Here the
 * marker is `useState` on this column and the cards read it as a prop, so a
 * re-render preserves it. The geometry — which card, which edge — is
 * `state/drag.ts`, unit-tested without a browser.
 */
export function Column({
  status,
  label,
  cards,
  tasks,
  now,
  overWip,
  draggingId,
  onDragStart,
  onDragEnd,
  onDrop,
  onAdd,
  onToggle,
  onEditTitle,
  onOpenDetail,
  onRemove,
}: {
  status: TaskStatus;
  label: string;
  cards: Task[];
  tasks: Task[];
  now: number;
  overWip: Set<string>;
  draggingId: string | null;
  onDragStart: (task: Task, e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDrop: (status: TaskStatus, index: number) => void;
  onAdd: (status: TaskStatus, title: string) => void;
  onToggle: (task: Task, status: TaskStatus) => void;
  onEditTitle: (task: Task, title: string) => void;
  onOpenDetail: (task: Task) => void;
  onRemove: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [isTarget, setIsTarget] = useState(false);
  const [marker, setMarker] = useState<{ id: string; edge: "before" | "after" } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * The live geometry of every card in this column EXCEPT the one being
   * dragged. The exclusion is what makes a within-column reorder index against
   * its neighbours, and it is faithful to the old page, whose drop index was
   * likewise a position in the reduced list — which is exactly what the
   * daemon's applyTaskMove (remove, then insert) expects.
   */
  const boxes = (): CardBox[] => {
    const list = listRef.current;
    if (!list) return [];
    return Array.from(list.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((n) => n.dataset.taskId !== draggingId)
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { id: n.dataset.taskId as string, top: r.top, height: r.height };
      });
  };

  const clear = () => {
    setIsTarget(false);
    setMarker(null);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag TARGET — dragover/dragleave/drop, never click. The keyboard path to the same move is the four status pills on each card.
    <section
      data-status={status}
      onDragOver={(e) => {
        if (!draggingId) return; // not our drag — do not preview, do not accept
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setIsTarget(true);
        setMarker(dropMarker(boxes(), e.clientY));
      }}
      onDragLeave={(e) => {
        // Only when the pointer really left the column — moving between two
        // cards inside it must not flicker the highlight.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) clear();
      }}
      onDrop={(e) => {
        if (!draggingId) return;
        e.preventDefault();
        const index = dropIndex(boxes(), e.clientY);
        clear();
        onDrop(status, index);
      }}
      className={cn(
        "min-h-32 rounded-lg border border-edge px-3.5 pt-3 pb-4 transition-colors",
        PANEL[status],
        isTarget && "border-ice bg-ice/[0.06]",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className={cn("m-0 text-xs font-semibold tracking-[0.1em] uppercase", HEAD[status])}>
          {label}
        </h2>
        <Badge variant="count">{cards.length}</Badge>
      </div>

      <div
        ref={listRef}
        className={cn(
          "flex min-h-10 flex-col gap-2 rounded-sm border border-dashed border-transparent",
          isTarget && "border-ice",
        )}
      >
        {cards.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            tasks={tasks}
            now={now}
            overWip={overWip}
            dragging={draggingId === task.id}
            marker={marker && marker.id === task.id ? marker.edge : null}
            onDragStart={onDragStart}
            onDragEnd={() => {
              clear();
              onDragEnd();
            }}
            onToggle={onToggle}
            onEditTitle={onEditTitle}
            onOpenDetail={onOpenDetail}
            onRemove={onRemove}
          />
        ))}
      </div>

      <form
        className="mt-3 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd(status, draft);
          if (draft.trim()) setDraft("");
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…"
          aria-label={`Add a task to ${label}`}
          className="flex-1 bg-well text-[0.85rem]"
        />
        <Button type="submit" variant="outline" size="sm" className="text-[0.85rem]">
          Add
        </Button>
      </form>
    </section>
  );
}
