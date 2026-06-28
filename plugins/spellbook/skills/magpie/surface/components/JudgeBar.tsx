// surface/components/JudgeBar.tsx
// STUB — the per-element judgment strip: confirm / drop the focused element's
// cutout. Wired to the real element.judge gesture so the skeleton is exercisable;
// the rich judgment shape (rating, notes) is being designed in parallel.
import type { ClientToServer, Element, MagpieState } from "../state/types";

export function JudgeBar({
  state,
  send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  // TODO(mock): a real focused-element model + the judgment fields. For now,
  // list elements with confirm/drop so the gesture round-trips end-to-end.
  return (
    <div className="card p-3 flex flex-col gap-2 min-h-0">
      <span className="section-title">Judge</span>
      {state.elements.length === 0 ? (
        <p className="text-faint text-xs">no elements to judge yet</p>
      ) : (
        <ul className="flex flex-col gap-1 overflow-y-auto">
          {state.elements.map((el) => (
            <Row key={el.id} el={el} send={send} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ el, send }: { el: Element; send: (m: ClientToServer) => void }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="flex-1 truncate text-ink">
        {el.name} <span className="text-faint">· {el.type}</span>
      </span>
      <span className="text-faint">{el.status}</span>
      <button
        type="button"
        className="chip"
        onClick={() => send({ type: "element.judge", id: el.id, status: "confirmed" })}
      >
        keep
      </button>
      <button
        type="button"
        className="chip"
        onClick={() => send({ type: "element.judge", id: el.id, status: "dropped" })}
      >
        drop
      </button>
    </li>
  );
}
