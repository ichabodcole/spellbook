// CONTROL ARMS for type-sentinel-probe.ts — s5-R arm 2.
//
// Five arms: annotated x inferred x honest x dishonest, plus a guard-shaped arm
// the predicate is BLIND to by construction. Anchored on APPLIED MUTATIONS of
// synthetic code rather than on any live defect, so the calibration survives the
// repo changing under it.
//
// EXPECTED:  IN DOMAIN 4 · CONVICTED 2 (dishonestAnnotated, dishonestInferred)
//            DECLARED BLIND 1 (dishonestGuard — no catch; undecidable without intent)
//
// The control fires in both directions. See the probe's header for why that is
// NOT evidence the predicate works.
export function honestAnnotated(p: string): number | null {
  try {
    return JSON.parse(p).n as number;
  } catch {
    return null;
  }
}
// ARM 2 — annotated, DISHONEST: cannot-answer collapses into the domain.
export function dishonestAnnotated(p: string): number {
  try {
    return JSON.parse(p).n as number;
  } catch {
    return 0;
  }
}
// ARM 3 — NO ANNOTATION, honest. Does the checker INFER the union?
export function honestInferred(p: string) {
  try {
    return JSON.parse(p).n as number;
  } catch {
    return null;
  }
}
// ARM 4 — NO ANNOTATION, dishonest.
export function dishonestInferred(p: string) {
  try {
    return JSON.parse(p).n as number;
  } catch {
    return 0;
  }
}
// ARM 5 — dishonest with NO try/catch at all (the guard shape).
export function dishonestGuard(exists: boolean, n: number) {
  return exists ? n : 0;
}
