/** USD conversion with a daily cached rate table; falls back to static rates offline. */
const FALLBACK: Record<string, number> = { USD: 1, SGD: 1.34, CNY: 7.2, HKD: 7.8, JPY: 150, EUR: 0.92, GBP: 0.79, KRW: 1380 };
let cache: { at: number; rates: Record<string, number> } | undefined;

export async function usdRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.at < 86_400_000) return cache.rates;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(10_000) });
    const j = (await r.json()) as { result?: string; rates?: Record<string, number> };
    if (j.result === "success" && j.rates) {
      cache = { at: Date.now(), rates: j.rates };
      return j.rates;
    }
  } catch {
    /* offline: use fallback */
  }
  return FALLBACK;
}

export async function toUsd(amount: number, currency: string): Promise<number> {
  const rates = await usdRates();
  const rate = rates[currency.toUpperCase()] ?? FALLBACK[currency.toUpperCase()];
  if (!rate) throw new Error(`No FX rate for ${currency}`);
  return Math.round((amount / rate) * 100) / 100;
}
