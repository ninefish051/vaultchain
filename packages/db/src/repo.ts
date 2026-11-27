import type { Hex } from "viem";
import type { CardType, PriceSample, PriceSnapshot, PricePointSeries, SaleRecord } from "@vaultchain/shared";
import type { Db } from "./index";

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function upsertCard(db: Db, c: CardType, opts: { searchQuery?: string } = {}) {
  await db.query(
    `INSERT INTO cards (card_key, canonical, name, set_name, number, language, variant, grader, grade, image_url, year, search_query)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (card_key) DO UPDATE SET name = EXCLUDED.name, set_name = EXCLUDED.set_name, image_url = EXCLUDED.image_url,
       year = EXCLUDED.year, search_query = COALESCE(EXCLUDED.search_query, cards.search_query)`,
    [c.cardKey, c.canonical, c.name, c.setName, c.number, c.language, c.variant, c.grader, c.grade, c.imageUrl, c.year ?? null, opts.searchQuery ?? null],
  );
}

interface CardRow {
  card_key: Hex; canonical: string; name: string; set_name: string; number: string; language: string;
  variant: string; grader: CardType["grader"]; grade: string; image_url: string; year: number | null; search_query: string | null;
}

export const rowToCard = (r: CardRow): CardType => ({
  cardKey: r.card_key, canonical: r.canonical, name: r.name, setName: r.set_name, number: r.number, language: r.language,
  variant: r.variant, grader: r.grader, grade: r.grade, imageUrl: r.image_url, year: r.year ?? undefined,
});

export async function listCards(db: Db, opts: { trackedOnly?: boolean } = {}) {
  const r = await db.query<CardRow>(`SELECT * FROM cards ${opts.trackedOnly ? "WHERE tracked" : ""} ORDER BY name, grader, grade DESC`);
  return r.rows.map((row) => ({ ...rowToCard(row), searchQuery: row.search_query ?? undefined }));
}

export async function getCard(db: Db, cardKey: string) {
  const r = await db.query<CardRow>("SELECT * FROM cards WHERE card_key = $1", [cardKey]);
  return r.rows[0] ? rowToCard(r.rows[0]) : undefined;
}

export interface NewSample extends PriceSample {
  externalId: string;
  originalPrice?: number;
  currency?: string;
  title?: string;
}

/** Inserts samples, ignoring ones already stored (same source + external id). Returns inserted count. */
export async function insertSamples(db: Db, cardKey: string, samples: NewSample[]): Promise<number> {
  let n = 0;
  for (const s of samples) {
    const r = await db.query(
      `INSERT INTO price_samples (card_key, source, kind, external_id, price_usd, original_price, currency, title, url, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (source, external_id) DO NOTHING`,
      [cardKey, s.source, s.kind, s.externalId, s.priceUsd, s.originalPrice ?? null, s.currency ?? "USD", s.title ?? null, s.url ?? null, s.observedAt],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}

export async function recentSamples(db: Db, cardKey: string, days = 90) {
  const r = await db.query(
    `SELECT id, source, kind, price_usd, original_price, currency, title, url, observed_at FROM price_samples
     WHERE card_key = $1 AND observed_at > now() - ($2 || ' days')::interval ORDER BY observed_at DESC`,
    [cardKey, String(days)],
  );
  return r.rows.map((x) => ({
    id: String(x.id),
    source: x.source as string,
    kind: x.kind as PriceSample["kind"],
    priceUsd: num(x.price_usd),
    originalPrice: x.original_price === null ? undefined : num(x.original_price),
    currency: x.currency as string,
    title: x.title ?? undefined,
    url: x.url ?? undefined,
    observedAt: new Date(x.observed_at),
  }));
}

export function toSaleRecords(rows: Awaited<ReturnType<typeof recentSamples>>): SaleRecord[] {
  return rows.map((r) => ({ ...r, observedAt: r.observedAt.toISOString() }));
}

export interface NewPricePoint {
  cardKey: string;
  fairValueUsd: number;
  volatilityBps: number;
  sampleCount: number;
  confidence: number;
  evidenceHash: Hex;
  evidence: unknown;
}

export async function insertPricePoint(db: Db, p: NewPricePoint) {
  const r = await db.query<{ id: string; computed_at: Date }>(
    `INSERT INTO price_points (card_key, fair_value_usd, volatility_bps, sample_count, confidence, evidence_hash, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, computed_at`,
    [p.cardKey, p.fairValueUsd, p.volatilityBps, p.sampleCount, p.confidence, p.evidenceHash, JSON.stringify(p.evidence)],
  );
  return r.rows[0]!;
}

export async function latestPricePoints(db: Db) {
  const r = await db.query(
    `SELECT DISTINCT ON (card_key) id, card_key, fair_value_usd, volatility_bps, sample_count, confidence, evidence_hash, computed_at, published_tx, published_at
     FROM price_points ORDER BY card_key, computed_at DESC`,
  );
  return r.rows.map((x) => ({
    id: String(x.id),
    cardKey: x.card_key as Hex,
    fairValueUsd: num(x.fair_value_usd),
    volatilityBps: Number(x.volatility_bps),
    sampleCount: Number(x.sample_count),
    confidence: Number(x.confidence),
    evidenceHash: x.evidence_hash as Hex,
    computedAt: new Date(x.computed_at),
    publishedTx: (x.published_tx ?? undefined) as Hex | undefined,
    publishedAt: x.published_at ? new Date(x.published_at) : undefined,
  }));
}

export async function markPublished(db: Db, id: string, txHash: Hex) {
  await db.query("UPDATE price_points SET published_tx = $2, published_at = now() WHERE id = $1", [id, txHash]);
}

/** Daily fair value series (last point of each day). */
export async function priceHistory(db: Db, cardKey: string, days = 90): Promise<PricePointSeries[]> {
  const r = await db.query(
    `SELECT DISTINCT ON (d) d, fair_value_usd FROM (
       SELECT date_trunc('day', computed_at) AS d, fair_value_usd, computed_at FROM price_points
       WHERE card_key = $1 AND computed_at > now() - ($2 || ' days')::interval) t
     ORDER BY d, computed_at DESC`,
    [cardKey, String(days)],
  );
  return r.rows.map((x) => ({ date: new Date(x.d).toISOString().slice(0, 10), fairValueUsd: num(x.fair_value_usd) }));
}

export async function snapshot(db: Db, cardKey: Hex): Promise<PriceSnapshot | undefined> {
  const hist = await priceHistory(db, cardKey, 31);
  const latest = (await db.query(
    `SELECT fair_value_usd, volatility_bps, sample_count, confidence, computed_at, published_tx, published_at
     FROM price_points WHERE card_key = $1 ORDER BY computed_at DESC LIMIT 1`,
    [cardKey],
  )).rows[0];
  if (!latest) return undefined;
  const last = num(latest.fair_value_usd);
  const pct = (prev?: number) => (prev ? Math.round(((last - prev) / prev) * 10_000) / 100 : 0);
  return {
    cardKey,
    fairValueUsd: last,
    volatilityBps: Number(latest.volatility_bps),
    confidence: Number(latest.confidence),
    sampleCount: Number(latest.sample_count),
    change24hPct: pct(hist.at(-2)?.fairValueUsd),
    change30dPct: pct(hist[0]?.fairValueUsd),
    updatedAt: new Date(latest.computed_at).toISOString(),
    onChain: latest.published_at
      ? { fairValueUsd: last, updatedAt: new Date(latest.published_at).toISOString(), txHash: latest.published_tx }
      : undefined,
  };
}
