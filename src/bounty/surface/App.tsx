import { useState } from "react";
import { BoardFooter } from "./components/BoardFooter";
import { Column } from "./components/Column";
import { DetailDialog } from "./components/DetailDialog";
import { FilterBar } from "./components/FilterBar";
import { Header } from "./components/Header";
import { RestoreFailedBanner } from "./components/RestoreFailedBanner";
import { Toasts } from "./components/Toasts";
import { ownersOverWip } from "./state/cards";
import type { DropHint } from "./state/drag";
import { tasksByStatus } from "./state/filters";
import { COLUMNS, type Task, type TaskStatus, WIP_THRESHOLD } from "./state/types";
import { useBoard } from "./state/useBoard";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "./ui/empty";

export function App() {
  const board = useBoard();
  const [detail, setDetail] = useState<Task | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // ONE hint for the whole board: a dragover anywhere replaces it, which is
  // what the old page's board-wide clearDropMarkers() did on every dragover.
  // Per-column state leaves two columns lit when a dragleave is missed.
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  const over = ownersOverWip(board.tasks, WIP_THRESHOLD);

  return (
    // `ended` makes the WHOLE board inert, not merely dim — the session is over
    // and every control would silently drop its frame anyway.
    <div className={board.ended ? "pointer-events-none opacity-60" : undefined}>
      <Header
        title={board.title}
        conn={board.conn}
        statusText={board.statusText}
        sessionId={board.sessionId}
      />

      {board.restoreFailed && <RestoreFailedBanner info={board.restoreFailed} />}

      <FilterBar
        tasks={board.tasks}
        filters={board.filters}
        onToggleTag={board.toggleTag}
        onToggleOwner={board.toggleOwner}
        onClear={board.clearFilters}
      />

      <div className="grid max-w-[1200px] grid-cols-4 gap-4">
        {COLUMNS.map((col) => (
          <Column
            key={col.status}
            status={col.status}
            label={col.label}
            cards={tasksByStatus(board.tasks, col.status, board.filters)}
            tasks={board.tasks}
            now={board.now}
            overWip={over}
            draggingId={draggingId}
            hint={dropHint}
            onHint={setDropHint}
            onDragStart={(task, e) => {
              // A mousedown inside the title turned this off so a text
              // selection is not a drag; honour it and abort.
              if (e.currentTarget.getAttribute("draggable") !== "true") {
                e.preventDefault();
                return;
              }
              // Best-effort: a browser that refuses the payload still drags,
              // because the drop reads component state, not the DataTransfer.
              try {
                e.dataTransfer.setData("text/plain", task.id);
              } catch {}
              e.dataTransfer.effectAllowed = "move";
              setDraggingId(task.id);
            }}
            onDragEnd={() => {
              setDraggingId(null);
              setDropHint(null);
            }}
            onDrop={(status: TaskStatus, index: number) => {
              const id = draggingId;
              setDraggingId(null);
              setDropHint(null);
              // A drop back on the card's own slot still sends: the DAEMON
              // suppresses it (isNoOpMove), so no event and no broadcast.
              if (id) board.moveTask(id, status, index);
            }}
            onAdd={board.addTask}
            onToggle={board.toggleStatus}
            onEditTitle={board.editTitle}
            onOpenDetail={setDetail}
            onRemove={board.removeTask}
          />
        ))}
      </div>

      {/* Keyed on the UNFILTERED count, faithfully: filtering every card away
          leaves four empty columns and no empty state, because the board is not
          empty — the lens is narrow. */}
      {board.tasks.length === 0 && (
        <Empty className="max-w-[1200px] px-4 py-16 text-ink-faint">
          <EmptyHeader>
            {/* A runtime style, not a Tailwind arbitrary value — see
                BoardFooter: an url() in the sheet is a build input. */}
            <EmptyMedia
              aria-hidden="true"
              style={{ backgroundImage: "url(/assets/mascot-large.webp)" }}
              className="mx-auto mb-4 size-50 bg-contain bg-center bg-no-repeat opacity-70"
            />
          </EmptyHeader>
          <EmptyDescription className="text-[0.95rem]">
            No tasks yet — add one below, or wait for the agent to drop some in.
          </EmptyDescription>
        </Empty>
      )}

      <BoardFooter onClose={board.closeBoard} />
      <Toasts toasts={board.toasts} />
      <DetailDialog task={detail} onClose={() => setDetail(null)} onSave={board.editNotes} />
    </div>
  );
}
