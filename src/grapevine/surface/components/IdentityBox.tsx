// I2, I5, I6 — the "You" box: the alias input (disabled while joined) and
// the lurk/join toggle.

import { toggleDisabled, toggleLabel } from "../state/identity";
import type { Mode } from "../state/types";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function IdentityBox({
  alias,
  mode,
  onAliasChange,
  onToggle,
}: {
  alias: string;
  mode: Mode;
  onAliasChange: (raw: string) => void;
  onToggle: () => void;
}) {
  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-edge pt-4">
      <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
        You
      </h2>
      <Input
        className="font-mono text-xs"
        defaultValue={alias}
        key={alias}
        placeholder="set an alias"
        disabled={mode === "join"}
        onChange={(e) => onAliasChange(e.target.value)}
        onBlur={(e) => onAliasChange(e.target.value)}
      />
      <Button
        variant={mode === "join" ? "joined" : "accent"}
        size="auto"
        className="px-2 py-1.5 font-mono text-xs"
        disabled={toggleDisabled(mode, alias)}
        onClick={onToggle}
      >
        {toggleLabel(mode)}
      </Button>
    </div>
  );
}
