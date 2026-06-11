#!/usr/bin/env bun
/**
 * Enrich a round's manifest with ACTUAL per-job cost from media-forge.
 *
 *   bun costs.ts <round>        # default: idiomatic
 *
 * For each unique serviceJobId in outputs/<round>/manifest.json, calls
 * `media-forge jobs get <id>` and writes costMicrosUsd + costStatus back onto
 * every entry sharing that job. fal finalizes cost asynchronously, so an entry
 * may read costStatus:"pending" right after generation — just re-run later.
 *
 * Only works for rounds whose manifest captured serviceJobId (idiomatic and
 * later). Older rounds (text, style) fall back to the gallery's price estimates.
 */
import { $ } from "bun";

type CostEntry = {
  serviceJobId?: string;
  file?: string;
  jobN?: number;
  costMicrosUsd?: number | null;
  costStatus?: string;
  costPerImageMicros?: number;
};

const round = process.argv[2] ?? "idiomatic";
const path = `${import.meta.dir}/outputs/${round}/manifest.json`;
const manifest = await Bun.file(path).json();
const entries: CostEntry[] = manifest.entries ?? [];

const jobIds = [...new Set(entries.map((e) => e.serviceJobId).filter(Boolean))] as string[];
if (!jobIds.length) {
  console.log(
    `No serviceJobId in ${round} manifest — cost lookup unavailable (older round). Gallery will estimate.`,
  );
  process.exit(0);
}

const cost = new Map<string, { micros: number | null; status: string }>();
let pending = 0;
for (const id of jobIds) {
  try {
    const res = await $`media-forge jobs get ${id} --format json`.quiet();
    const j = JSON.parse(res.stdout.toString());
    const micros = j.data?.costMicrosUsd ?? null;
    const status = j.data?.costStatus ?? "unknown";
    cost.set(id, { micros, status });
    if (status !== "final" && status !== "finalized" && micros == null) pending++;
  } catch {
    cost.set(id, { micros: null, status: "error" });
  }
}

let total = 0;
let known = 0;
for (const e of entries) {
  const c = e.serviceJobId ? cost.get(e.serviceJobId) : undefined;
  if (c) {
    e.costMicrosUsd = c.micros;
    e.costStatus = c.status;
    if (typeof c.micros === "number") {
      // job cost covers jobN images; attribute per-image
      e.costPerImageMicros = Math.round(c.micros / (e.jobN ?? 1));
      total += e.costPerImageMicros;
      known++;
    }
  }
}
manifest.costRollup = {
  totalMicrosUsd: total,
  knownImages: known,
  totalImages: entries.filter((e) => e.file).length,
  pendingJobs: pending,
};
await Bun.write(path, JSON.stringify(manifest, null, 2));

const usd = (m: number) => `$${(m / 1_000_000).toFixed(4)}`;
console.log(
  `${round}: ${known}/${entries.filter((e) => e.file).length} images priced, ${pending} job(s) still pending.`,
);
console.log(`round actual so far: ${usd(total)}`);
if (pending) console.log(`(re-run \`bun costs.ts ${round}\` in a minute to finalize pending jobs)`);
