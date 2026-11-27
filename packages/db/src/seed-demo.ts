// Seeds the demo catalogue, synthetic price history and listings. For local/hackathon use only.
import { keccak256, toBytes } from "viem";
import { DEMO_CARDS, DEMO_LISTINGS, demoPriceHistory, demoSales, demoSnapshot } from "@vaultchain/shared";
import { closeDb, getDb, migrate } from "./index";
import { insertSamples, upsertCard } from "./repo";

const db = getDb();
await migrate(db);
for (const card of DEMO_CARDS) {
  await upsertCard(db, card);
  const sales = demoSales(card.cardKey);
  await insertSamples(db, card.cardKey, sales.map((s, i) => ({
    ...s,
    observedAt: new Date(s.observedAt),
    externalId: `demo:${card.cardKey}:${i}`,
  })));
  const snap = demoSnapshot(card.cardKey)!;
  for (const point of demoPriceHistory(card.cardKey)) {
    await db.query(
      `INSERT INTO price_points (card_key, fair_value_usd, volatility_bps, sample_count, confidence, evidence_hash, evidence, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [card.cardKey, point.fairValueUsd, snap.volatilityBps, snap.sampleCount, snap.confidence,
        keccak256(toBytes(`demo:${card.cardKey}:${point.date}`)), JSON.stringify({ demo: true }), `${point.date}T12:00:00Z`],
    );
  }
}
for (const l of DEMO_LISTINGS) {
  await db.query(
    `INSERT INTO listings (id, type, slab_id, token_id, card_key, cert_number, seller, price_usd, accepts_swap, swap_wants, images, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
    [l.id, l.type, l.slabId, l.tokenId ?? null, l.cardKey, l.certNumber, l.seller.toLowerCase(), l.priceUsd, l.acceptsSwap, l.swapWants ?? null, JSON.stringify(l.images), l.createdAt],
  );
}
console.log(`Seeded ${DEMO_CARDS.length} cards and ${DEMO_LISTINGS.length} listings`);
await closeDb();
