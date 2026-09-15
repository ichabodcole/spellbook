// Browser-safe image-optimization POLICY (shared by the browser drop path and
// the server path). No native deps — safe to import into the React bundle.
// The Bun.Image implementation lives in imageOptimize.server.ts.
export const OPTIMIZE = { maxDim: 1200, quality: 0.85 } as const;
