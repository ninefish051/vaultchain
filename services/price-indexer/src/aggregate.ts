import { keccak256, toBytes } from "viem";
import { aggregate } from "@vaultchain/shared";
import { insertPricePoint, recentSamples, type Db } from "@vaultchain/db";

/**
 * Recomputes the fair value for one card from the last 90 days of samples and stores it with an
 * evidence hash: keccak256 of the canonical JSON of the sample ids used/rejected and the result.
 * Anyone with DB access can recompute the same hash, which is also what goes on-chain.
 */
export async function aggregateCard(db: Db, cardKey: string, now = new Date()) {
  const rows = await recentSamples(db, cardKey, 90);
  if (rows.length === 0) return undefined;
  const byId = new Map(rows.map((r) => [r, r.id]));
  const result = aggregate(rows, now);
  const evidence = {
    cardKey,
    computedAt: now.toISOString(),
    method: "mad3.5+time-decay-weighted-median/v1",
    fairValueUsd: result.fairValueUsd,
    volatilityBps: result.volatilityBps,
    used: result.used.map((s) => byId.get(s as (typeof rows)[number])).sort(),
    rejected: result.rejected.map((s) => byId.get(s as (typeof rows)[number])).sort(),
  };
  const evidenceHash = keccak256(toBytes(JSON.stringify(evidence)));
  await insertPricePoint(db, {
    cardKey,
    fairValueUsd: result.fairValueUsd,
    volatilityBps: result.volatilityBps,
    sampleCount: result.sampleCount,
    confidence: result.confidence,
    evidenceHash,
    evidence,
  });
  return { ...result, evidenceHash };
}
