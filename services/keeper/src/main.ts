import { BaseError, ContractFunctionRevertedError, keccak256, toBytes, type Abi, type Address, type Hex } from "viem";
import { swapEscrowAbi, vaultEscrowAbi } from "@vaultchain/shared";
import { chainContext, walletFromKey } from "@vaultchain/chain";
import { getDb, migrate, type Db } from "@vaultchain/db";
import { HspClient } from "@vaultchain/hsp";

/**
 * Keeper (holds RELAYER_ROLE on both escrows):
 *  1. HSP reconciliation — polls query_payment for submitted HSP payments every 15s; once a
 *     payment is `payment-finalized` it calls recordHspPayment(id, payer, amount, keccak(payment_request_id)).
 *     The contract only accepts USDC that has actually arrived and is not yet owed to anyone.
 *  2. Deadline sweeper — anyone may settle an expired stage; the keeper does it so funds never sit
 *     idle when users forget (cancelUnfunded, claimSellerNoShow, claimBuyerDefault, claimShipDefault,
 *     escalateInspectionTimeout). Every call is simulated first.
 * Reads order/swap state indexed by services/api into Postgres.
 */

const HSP_POLL_MS = 15_000;
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[keeper]", ...a);

const { publicClient, deployment } = chainContext();
const { account, wallet } = walletFromKey("RELAYER_KEY");
const hsp = new HspClient();

async function send(address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hex | undefined> {
  try {
    const { request } = await publicClient.simulateContract({ account, address, abi, functionName, args });
    const hash = await wallet.writeContract(request);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : undefined;
    const name = revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined;
    throw new Error(name ?? (e as Error).message.split("\n")[0]);
  }
}

// ------------------------------------------------------------------ 1. HSP reconciliation

async function reconcileHsp(db: Db) {
  const pending = await db.query(
    "SELECT * FROM hsp_payments WHERE status IN ('submitted','finalized') ORDER BY created_at LIMIT 50",
  );
  for (const p of pending.rows) {
    try {
      if (p.status === "submitted") {
        const q = await hsp.queryPayment(p.flow_id, p.payment_request_id);
        if (q.status === "payment-failed") {
          await db.query("UPDATE hsp_payments SET status = 'failed', last_error = $2, updated_at = now() WHERE payment_request_id = $1", [
            p.payment_request_id,
            q.payment?.status_reason ?? "payment-failed",
          ]);
          log(`HSP ${p.payment_request_id} failed: ${q.payment?.status_reason}`);
          continue;
        }
        // submitted / verified / processing / included / timeout / safe: keep polling. Only finalized is irreversible.
        if (q.status !== "payment-finalized") continue;
        if (q.attribution_verified === false) {
          log(`HSP ${p.payment_request_id} finalized but attribution not verified; holding`);
          continue;
        }
        await db.query("UPDATE hsp_payments SET status = 'finalized', hsp_order = $2, updated_at = now() WHERE payment_request_id = $1", [
          p.payment_request_id,
          JSON.stringify(q),
        ]);
        p.status = "finalized";
      }
      if (p.status === "finalized") {
        const escrow = p.target === "order" ? deployment.escrow : deployment.swapEscrow;
        const abi = (p.target === "order" ? vaultEscrowAbi : swapEscrowAbi) as Abi;
        const ref = keccak256(toBytes(p.payment_request_id));
        const tx = await send(escrow, abi, "recordHspPayment", [p.target_id, p.payer, BigInt(p.amount_usd6), ref]);
        await db.query("UPDATE hsp_payments SET status = 'recorded', record_tx = $2, updated_at = now() WHERE payment_request_id = $1", [
          p.payment_request_id,
          tx,
        ]);
        log(`recorded HSP ${p.payment_request_id} → ${p.target} ${p.target_id} tx ${tx}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      await db.query("UPDATE hsp_payments SET last_error = $2, updated_at = now() WHERE payment_request_id = $1", [p.payment_request_id, msg]);
      // A payment for a stage that already moved on (e.g. order cancelled) needs manual refund via rescueUnallocated.
      if (msg === "NothingExpected" || msg === "AmountMismatch") {
        await db.query("UPDATE hsp_payments SET status = 'failed' WHERE payment_request_id = $1", [p.payment_request_id]);
        log(`HSP ${p.payment_request_id} cannot be attributed (${msg}); flag for refund`);
      } else {
        log(`HSP ${p.payment_request_id}: ${msg}`);
      }
    }
  }
}

// ------------------------------------------------------------------ 2. deadline sweeper

const ORDER_ACTION: Record<string, string> = {
  Signed: "cancelUnfunded",
  Locked: "claimSellerNoShow",
  Inspecting: "escalateInspectionTimeout",
  PaymentWindow: "claimBuyerDefault",
};
const SWAP_ACTION: Record<string, string> = {
  Signed: "cancelUnfunded",
  Locked: "claimShipDefault",
  Inspecting: "escalateInspectionTimeout",
};

async function sweep(db: Db) {
  const orders = await db.query("SELECT order_id, status FROM orders WHERE deadline IS NOT NULL AND deadline < now() - interval '30 seconds'");
  for (const o of orders.rows) {
    const fn = ORDER_ACTION[o.status];
    if (!fn) continue;
    try {
      const tx = await send(deployment.escrow, vaultEscrowAbi as Abi, fn, [o.order_id]);
      log(`order ${o.order_id}: ${fn} tx ${tx}`);
    } catch (e) {
      log(`order ${o.order_id}: ${fn} skipped (${(e as Error).message})`);
    }
  }
  const swaps = await db.query("SELECT swap_id, status FROM swaps WHERE deadline IS NOT NULL AND deadline < now() - interval '30 seconds'");
  for (const s of swaps.rows) {
    const fn = SWAP_ACTION[s.status];
    if (!fn) continue;
    try {
      const tx = await send(deployment.swapEscrow, swapEscrowAbi as Abi, fn, [s.swap_id]);
      log(`swap ${s.swap_id}: ${fn} tx ${tx}`);
    } catch (e) {
      log(`swap ${s.swap_id}: ${fn} skipped (${(e as Error).message})`);
    }
  }
}

const db = getDb();
await migrate(db);
log(`relayer ${account.address}; escrow ${deployment.escrow}; swapEscrow ${deployment.swapEscrow}`);

const loop = (name: string, ms: number, fn: () => Promise<void>) =>
  (async () => {
    for (;;) {
      await fn().catch((e) => log(`${name} failed:`, (e as Error).message));
      await new Promise((r) => setTimeout(r, ms));
    }
  })();

await Promise.all([loop("hsp", HSP_POLL_MS, () => reconcileHsp(db)), loop("sweep", SWEEP_MS, () => sweep(db))]);
