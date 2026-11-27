/**
 * Price aggregation used by the price indexer and mirrored by the contracts.
 * All money values here are plain USD numbers; convert with toUsd6 before going on-chain.
 */

export type SaleKind = "sold" | "listing" | "reference";

export interface PriceSample {
  source: string; // "ebay-sold", "ebay-browse", "pricecharting", ...
  kind: SaleKind;
  priceUsd: number;
  observedAt: Date;
  url?: string;
}

export interface AggregateResult {
  fairValueUsd: number;
  volatilityBps: number;
  sampleCount: number;
  confidence: number; // 0-100
  used: PriceSample[];
  rejected: PriceSample[];
}

/** Relative trust per sample kind: completed sales beat asks and third-party references. */
export const KIND_WEIGHT: Record<SaleKind, number> = { sold: 1, reference: 0.6, listing: 0.35 };

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error("median of empty set");
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation outlier filter (modified z-score > threshold is rejected). */
export function filterOutliers(samples: PriceSample[], threshold = 3.5) {
  if (samples.length < 4) return { kept: samples, rejected: [] as PriceSample[] };
  const prices = samples.map((s) => s.priceUsd);
  const med = median(prices);
  const mad = median(prices.map((p) => Math.abs(p - med)));
  if (mad === 0) return { kept: samples, rejected: [] as PriceSample[] };
  const kept: PriceSample[] = [];
  const rejected: PriceSample[] = [];
  for (const s of samples) {
    const z = (0.6745 * Math.abs(s.priceUsd - med)) / mad;
    (z > threshold ? rejected : kept).push(s);
  }
  return { kept, rejected };
}

export function weightedMedian(values: { value: number; weight: number }[]): number {
  const v = values.filter((x) => x.weight > 0).sort((a, b) => a.value - b.value);
  if (v.length === 0) throw new Error("weighted median of empty set");
  const total = v.reduce((a, x) => a + x.weight, 0);
  let acc = 0;
  for (const x of v) {
    acc += x.weight;
    if (acc >= total / 2) return x.value;
  }
  return v[v.length - 1]!.value;
}

/** Sample weight: kind weight x exponential time decay (half-life in days). */
export function sampleWeight(s: PriceSample, now: Date, halfLifeDays = 14): number {
  const ageDays = Math.max(0, (now.getTime() - s.observedAt.getTime()) / 86_400_000);
  return KIND_WEIGHT[s.kind] * Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * 30-day volatility in bps: stdev of log returns between *weekly* median prices, scaled to a
 * 30-day horizon. Weekly buckets damp the cross-sectional noise of individual sales (two PSA 10s
 * sold the same day can differ by 10%), which would otherwise inflate daily returns.
 * Falls back to the dispersion of samples when there are fewer than 5 weekly points.
 */
export function volatilityBps(samples: PriceSample[], now: Date): number {
  const WEEK = 7 * 86_400_000;
  const cutoff = now.getTime() - 120 * 86_400_000;
  const byWeek = new Map<number, number[]>();
  for (const s of samples) {
    if (s.observedAt.getTime() < cutoff) continue;
    const w = Math.floor((now.getTime() - s.observedAt.getTime()) / WEEK);
    byWeek.set(w, [...(byWeek.get(w) ?? []), s.priceUsd]);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => b - a); // oldest first
  const series = weeks.map((w) => median(byWeek.get(w)!));
  if (series.length >= 5) {
    const rets: number[] = [];
    for (let i = 1; i < series.length; i++) {
      const gap = weeks[i - 1]! - weeks[i]!;
      rets.push(Math.log(series[i]! / series[i - 1]!) / Math.sqrt(gap));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
    return Math.round(Math.sqrt(variance) * Math.sqrt(30 / 7) * 10_000);
  }
  // Thin history: use relative MAD of all samples as a conservative proxy.
  const prices = samples.map((s) => s.priceUsd);
  if (prices.length < 2) return 1500;
  const med = median(prices);
  const mad = median(prices.map((p) => Math.abs(p - med)));
  return Math.max(500, Math.round(((1.4826 * mad) / med) * 10_000));
}

/** Confidence 0-100 from sample count, share of real sales and dispersion. */
export function confidenceScore(used: PriceSample[], volBps: number): number {
  if (used.length === 0) return 0;
  const n = Math.min(1, used.length / 15);
  const soldShare = used.filter((s) => s.kind === "sold").length / used.length;
  const disp = Math.max(0, 1 - volBps / 5000);
  return Math.round(100 * (0.45 * n + 0.35 * soldShare + 0.2 * disp));
}

export function aggregate(samples: PriceSample[], now = new Date(), maxAgeDays = 90): AggregateResult {
  const recent = samples.filter((s) => s.priceUsd > 0 && now.getTime() - s.observedAt.getTime() <= maxAgeDays * 86_400_000);
  if (recent.length === 0) throw new Error("no recent samples");
  const { kept, rejected } = filterOutliers(recent);
  const fair = weightedMedian(kept.map((s) => ({ value: s.priceUsd, weight: sampleWeight(s, now) })));
  const vol = volatilityBps(kept.filter((s) => s.kind === "sold").length >= 6 ? kept.filter((s) => s.kind === "sold") : kept, now);
  return {
    fairValueUsd: Math.round(fair * 100) / 100,
    volatilityBps: vol,
    sampleCount: kept.length,
    confidence: confidenceScore(kept, vol),
    used: kept,
    rejected,
  };
}

// ------------------------------------------------------------------ mirrors of on-chain rules

export interface DepositConfig {
  minDepositBps: number;
  maxDepositBps: number;
  volMultiplierBps: number;
}

export const DEFAULT_DEPOSIT_CONFIG: DepositConfig = { minDepositBps: 1000, maxDepositBps: 3000, volMultiplierBps: 20_000 };

/** Same as VaultEscrow.depositBpsFor / SwapEscrow.depositBpsFor. */
export function depositBpsFor(volBps: number, c: DepositConfig = DEFAULT_DEPOSIT_CONFIG): number {
  return Math.min(c.maxDepositBps, c.minDepositBps + Math.floor((volBps * c.volMultiplierBps) / 10_000));
}

/** Contracts round deposits up to a whole cent (HSP carts are USD with 2 decimals). */
const ceilCent = (usd: number) => Math.ceil(Math.round(usd * 1e6) / 1e4) / 100;

export function orderDepositUsd(priceUsd: number, volBps: number, c = DEFAULT_DEPOSIT_CONFIG): number {
  return ceilCent((priceUsd * depositBpsFor(volBps, c)) / 10_000);
}

/** Swap deposit: higher card value x deposit rate of the more volatile card. */
export function swapDepositUsd(fairA: number, fairB: number, volA: number, volB: number, c = DEFAULT_DEPOSIT_CONFIG): number {
  return ceilCent((Math.max(fairA, fairB) * depositBpsFor(Math.max(volA, volB), c)) / 10_000);
}

/** Suggested top-up so both sides give equal fair value. topUpFrom: 1 = A pays, 2 = B pays. */
export function suggestTopUp(fairA: number, fairB: number): { topUpUsd: number; topUpFrom: 0 | 1 | 2 } {
  const diff = Math.round((fairB - fairA) * 100) / 100;
  if (Math.abs(diff) < 0.01) return { topUpUsd: 0, topUpFrom: 0 };
  return diff > 0 ? { topUpUsd: diff, topUpFrom: 1 } : { topUpUsd: -diff, topUpFrom: 2 };
}

export const USDC_DECIMALS = 6;
export const toUsd6 = (usd: number): bigint => BigInt(Math.round(usd * 1e6));
export const fromUsd6 = (v: bigint | number): number => Number(v) / 1e6;
