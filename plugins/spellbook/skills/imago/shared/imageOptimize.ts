// shared/imageOptimize.ts
// Browser-safe image-optimization POLICY, used by BOTH sides — the browser drop
// path (surface/state/fileIntake.ts) and the daemon variant path
// (scripts/imageOptimize.server.ts). Two-sided by R1's test, so it lives in
// shared/ rather than with either consumer. No native deps here — safe to
// import into the React bundle. The Bun.Image implementation that applies this
// policy lives in scripts/imageOptimize.server.ts.
export const OPTIMIZE = { maxDim: 1200, quality: 0.85 } as const;
