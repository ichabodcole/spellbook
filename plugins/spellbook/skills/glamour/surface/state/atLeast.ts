// surface/state/atLeast.ts
import { type Phase, VALID_PHASE } from "./types";

// True when `current` is at or beyond `target` in the canonical phase order.
export function atLeast(current: Phase, target: Phase): boolean {
  return VALID_PHASE.indexOf(current) >= VALID_PHASE.indexOf(target);
}
