import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cardPriceOracleAbi, oracleDomain, pricePointTypes, toUsd6, type PricePointMessage } from "@vaultchain/shared";
import { chainContext, walletFromKey } from "@vaultchain/chain";
import { closeDb, getDb, latestPricePoints, markPublished, migrate } from "@vaultchain/db";

/**
 * Pushes aggregated prices on-chain. For every card whose latest price point
 *   - moved more than PUBLISH_DEVIATION_BPS from the on-chain value, or
 *   - is older on-chain than HEARTBEAT_HOURS,
 * it signs the PricePoint (EIP-712, ORACLE_SIGNER_KEY) and relays submitPrice (RELAYER_KEY).
 * The contract rejects jumps above its maxDeviationBps (30%); those are logged for an admin
 * to review and force-set.
 */

const DEVIATION_BPS = Number(process.env.PUBLISH_DEVIATION_BPS ?? 100);
const HEARTBEAT_HOURS = Number(process.env.HEARTBEAT_HOURS ?? 12);
const INTERVAL_MIN = Number(process.env.PUBLISH_INTERVAL_MINUTES ?? 10);
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 30);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[oracle-publisher]", ...a);

const { chainId, publicClient, deployment } = chainContext();
const signerKey = process.env.ORACLE_SIGNER_KEY as Hex | undefined;
if (!signerKey) throw new Error("ORACLE_SIGNER_KEY is not set");
const signer = privateKeyToAccount(signerKey);
const { account: relayer, wallet } = walletFromKey(process.env.RELAYER_KEY ? "RELAYER_KEY" : "ORACLE_SIGNER_KEY");

function deviationBps(next: bigint, prev: bigint): number {
  if (prev === 0n) return Number.POSITIVE_INFINITY;
  const diff = next > prev ? next - prev : prev - next;
  return Number((diff * 10_000n) / prev);
}

async function runOnce() {
  const db = getDb();
  const points = await latestPricePoints(db);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  let published = 0;

  for (const p of points) {
    if (p.publishedTx) continue;
    if (p.confidence < MIN_CONFIDENCE) {
      log(`skip ${p.cardKey}: confidence ${p.confidence} < ${MIN_CONFIDENCE}`);
      continue;
    }
    const onChain = await publicClient.readContract({
      address: deployment.oracle,
      abi: cardPriceOracleAbi,
      functionName: "getPrice",
      args: [p.cardKey],
    });
    const fair6 = toUsd6(p.fairValueUsd);
    const updatedAt = BigInt(Math.floor(p.computedAt.getTime() / 1000));
    if (updatedAt <= onChain.updatedAt) continue;
    const ageHours = Number(nowSec - onChain.updatedAt) / 3600;
    const dev = deviationBps(fair6, onChain.fairValueUsd);
    if (dev < DEVIATION_BPS && ageHours < HEARTBEAT_HOURS) continue;

    const message: PricePointMessage = {
      cardKey: p.cardKey,
      fairValueUsd: fair6,
      volatilityBps: p.volatilityBps,
      sampleCount: Math.min(p.sampleCount, 65_535),
      confidence: Math.min(p.confidence, 100),
      updatedAt,
      evidenceHash: p.evidenceHash,
    };
    const signature = await signer.signTypedData({
      domain: oracleDomain(chainId, deployment.oracle),
      types: pricePointTypes,
      primaryType: "PricePoint",
      message,
    });
    const { cardKey, ...point } = message;
    try {
      const { request } = await publicClient.simulateContract({
        account: relayer,
        address: deployment.oracle,
        abi: cardPriceOracleAbi,
        functionName: "submitPrice",
        args: [cardKey, point, signature],
      });
      const hash = await wallet.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash });
      await markPublished(db, p.id, hash);
      published++;
      log(`published ${p.cardKey} $${p.fairValueUsd} (${Number.isFinite(dev) ? `${dev}bps` : "first price"}) tx ${hash}`);
    } catch (e) {
      const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
      const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
      if (name === "DeviationTooLarge") {
        log(`NEEDS REVIEW ${p.cardKey}: ${dev}bps exceeds the oracle jump limit; an admin must forceSetPrice`);
      } else {
        log(`submit failed for ${p.cardKey}:`, name ?? (e as Error).message);
      }
    }
  }
  log(`checked ${points.length} cards, published ${published}`);
}

await migrate();
if (process.argv.includes("--once")) {
  await runOnce();
  await closeDb();
} else {
  for (;;) {
    await runOnce().catch((e) => log("run failed:", e));
    await new Promise((r) => setTimeout(r, INTERVAL_MIN * 60_000));
  }
}
