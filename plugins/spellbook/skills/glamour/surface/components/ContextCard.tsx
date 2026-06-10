import type { ClientToServer, Context } from "../state/types";

export function ContextCard({ ctx, send }: { ctx: Context; send: (m: ClientToServer) => void }) {
  return (
    <div className="bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 flex items-center gap-2">
      <span className="text-xs text-slate-300 flex-1 truncate">{ctx.name}</span>
      <input
        defaultValue={ctx.note}
        placeholder="note…"
        onBlur={(e) =>
          send({
            type: "context.annotate",
            id: ctx.id,
            patch: { note: e.target.value },
          })
        }
        className="bg-transparent text-[11px] text-slate-400 outline-none w-24"
      />
    </div>
  );
}
