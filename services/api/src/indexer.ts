import { parseEventLogs, type Abi, type Address, type Hex, type Log } from "viem";
import {
  CUSTODY,
  ORDER_STATUS,
  SWAP_STATUS,
  fromUsd6,
  swapEscrowAbi,
  vaultCardNFTAbi,
  vaultEscrowAbi,
  vaultMarketAbi,
  vaultSwapAbi,
} from "@vaultchain/shared";
import { blockRanges, chainContext, lower } from "@vaultchain/chain";
import { getState, setState, type Db } from "@vaultchain/db";

/**
 * Mirrors contract events into Postgres (orders, swaps, assets, vault listings, swap offers) so the
 * marketplace can list and search quickly. Chain state stays authoritative: detail pages re-read it.
 */
const POLL_MS = Number(process.env.INDEXER_POLL_MS ?? 15_000);
const CONFIRMATIONS = BigInt(process.env.INDEXER_CONFIRMATIONS ?? 2);

export function startIndexer(db: Db, log: (msg: string) => void) {
  const { chainId, publicClient, deployment } = chainContext();
  const contracts: { name: string; address: Address; abi: Abi }[] = [
    { name: "escrow", address: deployment.escrow, abi: vaultEscrowAbi as Abi },
    { name: "swapEscrow", address: deployment.swapEscrow, abi: swapEscrowAbi as Abi },
    { name: "nft", address: deployment.nft, abi: vaultCardNFTAbi as Abi },
    { name: "market", address: deployment.market, abi: vaultMarketAbi as Abi },
    { name: "vaultSwap", address: deployment.vaultSwap, abi: vaultSwapAbi as Abi },
  ];
  const byAddress = new Map(contracts.map((c) => [c.address.toLowerCase(), c]));
  const stateKey = `indexer:${chainId}:block`;
  const blockTimes = new Map<bigint, Date>();

  async function blockTime(n: bigint) {
    if (!blockTimes.has(n)) {
      const b = await publicClient.getBlock({ blockNumber: n });
      blockTimes.set(n, new Date(Number(b.timestamp) * 1000));
      if (blockTimes.size > 2000) blockTimes.clear();
    }
    return blockTimes.get(n)!;
  }

  async function tick() {
    const head = (await publicClient.getBlockNumber()) - CONFIRMATIONS;
    const from = BigInt((await getState(db, stateKey)) ?? deployment.deployedAtBlock) + 1n;
    if (from > head) return;
    for await (const range of blockRanges(from, head)) {
      const logs = await publicClient.getLogs({ address: contracts.map((c) => c.address), ...range });
      for (const raw of logs) {
        const c = byAddress.get(raw.address.toLowerCase());
        if (!c) continue;
        const [ev] = parseEventLogs({ abi: c.abi, logs: [raw as Log] }) as unknown as { eventName: string; args: Record<string, unknown> }[];
        if (!ev) continue;
        await handle(c.name, ev.eventName, ev.args, raw as Log & { blockNumber: bigint; transactionHash: Hex; logIndex: number });
      }
      await setState(db, stateKey, range.toBlock.toString());
    }
  }

  async function record(contract: string, event: string, refId: string | null, args: Record<string, unknown>, l: Log & { blockNumber: bigint; transactionHash: Hex; logIndex: number }) {
    const json = JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    await db.query(
      `INSERT INTO chain_events (chain_id, tx_hash, log_index, block_number, contract, event, ref_id, args, block_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [chainId, l.transactionHash, l.logIndex, l.blockNumber.toString(), contract, event, refId, json, await blockTime(l.blockNumber)],
    );
  }

  async function handle(contract: string, event: string, a: Record<string, unknown>, l: Log & { blockNumber: bigint; transactionHash: Hex; logIndex: number }) {
    const deadline = (d: unknown) => (d && BigInt(d as bigint) > 0n ? new Date(Number(d) * 1000) : null);

    if (contract === "escrow") {
      const id = a.orderId as Hex;
      if (event === "OrderCreated") {
        const o = await publicClient.readContract({ address: deployment.escrow, abi: vaultEscrowAbi, functionName: "getOrder", args: [id] });
        await db.query(
          `INSERT INTO orders (order_id, buyer, seller, card_key, slab_id, price_usd, deposit_usd, status, fulfillment)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Signed',$8) ON CONFLICT (order_id) DO NOTHING`,
          [id, lower(o.buyer), lower(o.seller), o.cardKey, o.slabId, fromUsd6(o.priceUsd), fromUsd6(o.depositUsd), o.fulfillment === 1 ? "KeepInVault" : "ShipToBuyer"],
        );
      } else if (event === "StatusChanged") {
        const status = ORDER_STATUS[Number(a.status)]!;
        a = { ...a, statusName: status };
        await db.query("UPDATE orders SET status = $2, deadline = $3, updated_at = now() WHERE order_id = $1", [id, status, deadline(a.deadline)]);
      }
      return record(contract, event, id ?? null, a, l);
    }

    if (contract === "swapEscrow") {
      const id = a.swapId as Hex;
      if (event === "SwapCreated") {
        const s = await publicClient.readContract({ address: deployment.swapEscrow, abi: swapEscrowAbi, functionName: "getSwap", args: [id] });
        await db.query(
          `INSERT INTO swaps (swap_id, party_a, party_b, slab_a, slab_b, card_key_a, card_key_b, deposit_usd, top_up_usd, top_up_from, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Signed') ON CONFLICT (swap_id) DO NOTHING`,
          [id, lower(s.legs[0].owner), lower(s.legs[1].owner), s.legs[0].slabId, s.legs[1].slabId, s.legs[0].cardKey, s.legs[1].cardKey,
            fromUsd6(s.depositUsd), fromUsd6(s.topUpUsd), s.topUpFrom],
        );
      } else if (event === "StatusChanged") {
        const status = SWAP_STATUS[Number(a.status)]!;
        a = { ...a, statusName: status };
        const s = await publicClient.readContract({ address: deployment.swapEscrow, abi: swapEscrowAbi, functionName: "getSwap", args: [id] });
        const legs = s.legState.map((x) => ["Pending", "Shipped", "Passed"][x]);
        await db.query("UPDATE swaps SET status = $2, deadline = $3, leg_state = $4, updated_at = now() WHERE swap_id = $1", [id, status, deadline(a.deadline), JSON.stringify(legs)]);
      } else if (event === "LegShipped" || event === "LegInspected") {
        const s = await publicClient.readContract({ address: deployment.swapEscrow, abi: swapEscrowAbi, functionName: "getSwap", args: [id] });
        await db.query("UPDATE swaps SET leg_state = $2, updated_at = now() WHERE swap_id = $1", [id, JSON.stringify(s.legState.map((x) => ["Pending", "Shipped", "Passed"][x]))]);
      }
      return record(contract, event, id ?? null, a, l);
    }

    if (contract === "nft") {
      const tokenId = (a.tokenId as bigint).toString();
      if (event === "SlabMinted") {
        const slabId = `0x${(a.tokenId as bigint).toString(16).padStart(64, "0")}`;
        await db.query(
          `INSERT INTO assets (token_id, slab_id, card_key, owner, custody) VALUES ($1,$2,$3,$4,'InVault')
           ON CONFLICT (token_id) DO UPDATE SET owner = EXCLUDED.owner, custody = 'InVault', updated_at = now()`,
          [tokenId, slabId, a.cardKey, lower(a.to as Address)],
        );
      } else if (event === "Transfer") {
        const to = a.to as Address;
        if (/^0x0+$/.test(to)) await db.query("DELETE FROM assets WHERE token_id = $1", [tokenId]);
        else await db.query("UPDATE assets SET owner = $2, updated_at = now() WHERE token_id = $1", [tokenId, lower(to)]);
        // ownership change invalidates any vault listing by the previous owner
        await db.query("UPDATE listings SET status = 'cancelled' WHERE token_id = $1 AND status = 'active' AND seller <> $2", [tokenId, lower(to)]);
      } else if (event === "CustodyChanged") {
        await db.query("UPDATE assets SET custody = $2, updated_at = now() WHERE token_id = $1", [tokenId, CUSTODY[Number(a.custody)]]);
      }
      return record(contract, event, tokenId, a, l);
    }

    if (contract === "market") {
      const tokenId = (a.tokenId as bigint).toString();
      if (event === "Listed") {
        const asset = (await db.query("SELECT slab_id, card_key FROM assets WHERE token_id = $1", [tokenId])).rows[0];
        const slab = asset ? (await db.query("SELECT cert_number FROM slabs WHERE slab_id = $1", [asset.slab_id])).rows[0] : undefined;
        if (asset) {
          await db.query(
            `INSERT INTO listings (id, type, slab_id, token_id, card_key, cert_number, seller, price_usd)
             VALUES ($1,'vault',$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO UPDATE SET price_usd = EXCLUDED.price_usd, seller = EXCLUDED.seller, status = 'active'`,
            [`vault-${tokenId}`, asset.slab_id, tokenId, asset.card_key, slab?.cert_number ?? "", lower(a.seller as Address), fromUsd6(a.priceUsd as bigint)],
          );
        }
      } else if (event === "Unlisted") {
        await db.query("UPDATE listings SET status = 'cancelled' WHERE id = $1", [`vault-${tokenId}`]);
      } else if (event === "Sold") {
        await db.query("UPDATE listings SET status = 'sold' WHERE id = $1", [`vault-${tokenId}`]);
      }
      return record(contract, event, tokenId, a, l);
    }

    if (contract === "vaultSwap") {
      const offerId = (a.offerId as bigint).toString();
      if (event === "OfferCreated") {
        await db.query(
          `INSERT INTO vault_swap_offers (offer_id, maker, give_token, want_token, want_card_key, top_up_usd, maker_pays, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [offerId, lower(a.maker as Address), (a.giveTokenId as bigint).toString(),
            (a.wantTokenId as bigint) === 0n ? null : (a.wantTokenId as bigint).toString(),
            /^0x0+$/.test(a.wantCardKey as string) ? null : a.wantCardKey,
            fromUsd6(a.topUpUsd as bigint), a.makerPaysTopUp, new Date(Number(a.expiry) * 1000)],
        );
      } else if (event === "OfferCancelled") {
        await db.query("UPDATE vault_swap_offers SET status = 'cancelled' WHERE offer_id = $1", [offerId]);
      } else if (event === "Swapped") {
        await db.query("UPDATE vault_swap_offers SET status = 'accepted' WHERE offer_id = $1", [offerId]);
      }
      return record(contract, event, offerId, a, l);
    }
  }

  let stopped = false;
  (async () => {
    log(`indexer started on chain ${chainId}`);
    while (!stopped) {
      await tick().catch((e) => log(`indexer tick failed: ${(e as Error).message}`));
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })();
  return () => {
    stopped = true;
  };
}
