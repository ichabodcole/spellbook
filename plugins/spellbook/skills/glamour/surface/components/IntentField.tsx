import type { ClientToServer, GlamourState } from "../state/types";

export function IntentField({
  state,
  send,
}: {
  state: GlamourState;
  send: (m: ClientToServer) => void;
}) {
  return (
    <textarea
      defaultValue={state.intent}
      placeholder="what do you want out of this?"
      onBlur={(e) => {
        if (e.target.value !== state.intent) send({ type: "intent.set", text: e.target.value });
      }}
      className="w-full bg-[#140f1d] border border-[#2a2238] rounded-lg p-2 text-sm text-slate-200 outline-none"
      rows={3}
    />
  );
}
