import type { ClientToServer, Influence } from "../state/types";

export function InfluenceCard({
  inf,
  send,
}: {
  inf: Influence;
  send: (m: ClientToServer) => void;
}) {
  return (
    <div className="bg-[#1b1626] border border-[#2e2640] rounded-lg p-2">
      <img src={inf.src} alt={inf.name} className="w-full h-28 object-cover rounded" />
      <input
        defaultValue={inf.note}
        placeholder="add a note…"
        onBlur={(e) =>
          send({
            type: "influence.annotate",
            id: inf.id,
            patch: { note: e.target.value },
          })
        }
        className="mt-1 w-full bg-transparent text-xs text-slate-300 outline-none"
      />
      {inf.read && <p className="mt-1 text-[11px] text-slate-400">{inf.read}</p>}
    </div>
  );
}
