import { X } from "lucide-react";
import type { ClientToServer } from "../state/types";

interface FooterProps {
  send: (m: ClientToServer) => void;
}

export function Footer({ send }: FooterProps) {
  function handleClose() {
    if (confirm("Close without submitting? The agent won't receive the final spec.")) {
      send({ type: "cancel" });
    }
  }

  return (
    <div className="px-6 py-3 flex items-center justify-between border-t border-[#241d33]">
      <span className="text-faint">
        hit a snag, or something feel off? tell the agent — that's how glamour gets better.
      </span>
      <button type="button" className="btn-ghost" onClick={handleClose}>
        <X className="w-3 h-3" /> close without submitting
      </button>
    </div>
  );
}
