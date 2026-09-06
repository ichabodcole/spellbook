// I2, I5, I6 — the "You" box: the alias input (disabled while joined) and
// the lurk/join toggle.
//
// The input is CONTROLLED by a local draft and commits ONLY on change — blur
// or Enter — exactly as the original's `x-model` + `@change` did (watch.html
// 685–691): the field keeps focus while typing, and localStorage is written
// once. The first draft keyed the element by the alias and committed per
// keystroke, which remounted the input on every character and dropped focus
// after the first one (verify finding 1). The toggle's disabled state follows
// the DRAFT, as the original's `x-model` made it, so Join lights up as you
// type; the toggle itself commits through the blur that precedes the click.

import { useEffect, useState } from "react";
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
  const [draft, setDraft] = useState(alias);
  // The committed alias can change from outside the box (/identity resolves
  // after mount, R1; a commit trims, I3) — follow it, never the other way.
  useEffect(() => setDraft(alias), [alias]);
  return (
    <div className="mt-5 flex flex-col gap-2 border-t border-edge pt-4">
      <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
        You
      </h2>
      <Input
        className="font-mono text-xs"
        value={draft}
        placeholder="set an alias"
        disabled={mode === "join"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onAliasChange(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAliasChange(draft);
        }}
      />
      <Button
        variant={mode === "join" ? "joined" : "accent"}
        size="auto"
        className="px-2 py-1.5 font-mono text-xs"
        disabled={toggleDisabled(mode, draft)}
        onClick={onToggle}
      >
        {toggleLabel(mode)}
      </Button>
    </div>
  );
}
