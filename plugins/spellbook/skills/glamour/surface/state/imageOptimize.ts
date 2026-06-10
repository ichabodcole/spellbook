// surface/state/imageOptimize.ts
// Browser-safe image-optimization POLICY (shared by the browser drop path and
// the server variant path). No native deps here — safe to import into the
// React bundle. The sharp-based implementation lives in imageOptimize.server.ts.
export const OPTIMIZE = { maxDim: 1200, quality: 0.85 } as const;
