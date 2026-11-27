import { DEMO_CARDS } from "@vaultchain/shared";
import { closeDb, getDb, insertSamples, listCards, migrate, upsertCard } from "@vaultchain/db";
import { aggregateCard } from "./aggregate";
import { REAL_COLLECTORS, demo, type Collector } from "./collectors";
import { config } from "./config";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[price-indexer]", ...a);

async function runOnce() {
  const db = getDb();
  let cards = await listCards(db, { trackedOnly: true });
  if (cards.length === 0) {
    log("no tracked cards; seeding the demo catalogue");
    for (const c of DEMO_CARDS) await upsertCard(db, c);
    cards = await listCards(db, { trackedOnly: true });
  }
  const active = REAL_COLLECTORS.filter((c) => c.enabled());
  log(`collectors: ${active.map((c) => c.name).join(", ") || "(none configured)"}${config.demoFallback ? " + demo fallback" : ""}`);

  for (const card of cards) {
    let real = 0;
    for (const collector of active) real += await collectSafely(collector, card);
    if (real === 0 && demo.enabled()) await collectSafely(demo, card);
    try {
      const r = await aggregateCard(db, card.cardKey);
      if (r) log(`${card.canonical}: $${r.fairValueUsd} vol ${r.volatilityBps}bps conf ${r.confidence} (${r.sampleCount} samples, ${r.rejected.length} outliers)`);
    } catch (e) {
      log(`aggregate failed for ${card.canonical}:`, (e as Error).message);
    }
  }

  async function collectSafely(collector: Collector, card: (typeof cards)[number]) {
    try {
      const samples = await collector.collect(card);
      const n = await insertSamples(db, card.cardKey, samples);
      if (samples.length) log(`${collector.name} ${card.canonical}: ${samples.length} matched, ${n} new`);
      return samples.length;
    } catch (e) {
      log(`${collector.name} failed for ${card.canonical}:`, (e as Error).message);
      return 0;
    }
  }
}

await migrate();
if (process.argv.includes("--once")) {
  await runOnce();
  await closeDb();
} else {
  for (;;) {
    await runOnce().catch((e) => log("run failed:", e));
    await new Promise((r) => setTimeout(r, config.intervalMinutes * 60_000));
  }
}
