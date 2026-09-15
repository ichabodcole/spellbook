// I2, I5, I6 — the "You" box: the alias input (disabled while joined) and
// the lurk/join toggle.
//
// The input is CONTROLLED by a local draft and commits ONLY on change — blur
// or Enter: the field keeps focus while typing, and localStorage is written
// once. The toggle's disabled state follows the DRAFT, so Join lights up as
// you type; the toggle itself commits through the blur that precedes the
// click.

import { useEffect, useId, useState } from "react";
import { Button } from "@/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/ui/field";
import { Input } from "@/ui/input";
import { Separator } from "@/ui/separator";
import { toggleDisabled, toggleLabel } from "../state/identity";
import type { Mode } from "../state/types";

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
  const aliasId = useId();
  // The committed alias can change from outside the box (/identity resolves
  // after mount, R1; a commit trims, I3) — follow it, never the other way.
  useEffect(() => setDraft(alias), [alias]);
  return (
    <div className="mt-5 flex flex-col gap-2">
      <Separator className="mb-2" />
      <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
        You
      </h2>
      <FieldGroup className="gap-2">
        <Field>
          <FieldLabel htmlFor={aliasId} className="sr-only">
            Alias
          </FieldLabel>
          <Input
            id={aliasId}
            value={draft}
            placeholder="set an alias"
            disabled={mode === "join"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => onAliasChange(draft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onAliasChange(draft);
            }}
          />
        </Field>
        <Field>
          <Button
            variant={mode === "join" ? "joined" : "accent"}
            size="sm"
            disabled={toggleDisabled(mode, draft)}
            onClick={onToggle}
          >
            {toggleLabel(mode)}
          </Button>
        </Field>
      </FieldGroup>
    </div>
  );
}
