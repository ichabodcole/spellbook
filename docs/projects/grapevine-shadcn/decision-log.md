# Grapevine shadcn — decision log

## 2026-09-05 — orchestrator, with Cole

- **Its own branch, before the UX work.** The conversion's contract was
  behaviour-faithful; this is a no-change refactor; the UX branch changes
  behaviour. Three branches, three different verifiers. Not taken: folding
  shadcn into the conversion (would have blurred its verification); UX first
  (would restyle twice).
- **Real CLI setup, not more hand-vendoring.** Not taken: keeping the
  look-alikes and adding ContextMenu etc. by hand.
- **Dep cap lifted for cva, clsx, tailwind-merge only; kit `cn()` untouched.**
  Not taken: switching the kit's `cn` to twMerge (behaviour change to
  mind-mapper and glamour, outside this branch).
- **Provenance out of component headers; rules into house-style.** Cole's
  observation: provenance in the file ages badly and registry updates overwrite
  it anyway.
