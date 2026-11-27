import type { CardQuery, CardSummary } from "./types";

/** Filtering/sorting shared by both stores (catalogue is small enough to do in memory). */
export function filterCards(cards: CardSummary[], q: CardQuery): CardSummary[] {
  const text = q.q?.trim().toLowerCase();
  let out = cards.filter((c) => {
    if (text && !`${c.name} ${c.setName} ${c.number} ${c.grader} ${c.grade}`.toLowerCase().includes(text)) return false;
    if (q.grader && c.grader !== q.grader) return false;
    if (q.grade && c.grade !== q.grade) return false;
    const p = c.price?.fairValueUsd;
    if (q.minUsd !== undefined && (p === undefined || p < q.minUsd)) return false;
    if (q.maxUsd !== undefined && (p === undefined || p > q.maxUsd)) return false;
    return true;
  });
  const price = (c: CardSummary) => c.price?.fairValueUsd ?? 0;
  const change = (c: CardSummary) => c.price?.change24hPct ?? 0;
  switch (q.sort) {
    case "price_asc":
      out = out.sort((a, b) => price(a) - price(b));
      break;
    case "change_desc":
      out = out.sort((a, b) => change(b) - change(a));
      break;
    case "change_asc":
      out = out.sort((a, b) => change(a) - change(b));
      break;
    case "name":
      out = out.sort((a, b) => a.name.localeCompare(b.name));
      break;
    default:
      out = out.sort((a, b) => price(b) - price(a));
  }
  return out;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
