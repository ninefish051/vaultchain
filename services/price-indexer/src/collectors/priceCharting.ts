import { config } from "../config";
import { searchQuery } from "../match";
import type { Collector } from "./types";

/**
 * PriceCharting API (paid). Prices are in cents and bucketed by grade:
 * graded-price = 9, box-only-price = 9.5, manual-only-price = PSA 10, bgs-10-price = BGS 10.
 */
const FIELD_BY_GRADE: Record<string, string> = { "9": "graded-price", "9.5": "box-only-price", "10": "manual-only-price" };

export const priceCharting: Collector = {
  name: "pricecharting",
  enabled: () => Boolean(config.priceChartingToken),
  async collect(card) {
    const field = card.grader === "BGS" && card.grade === "10" ? "bgs-10-price" : FIELD_BY_GRADE[card.grade];
    if (!field) return [];
    const q = encodeURIComponent(searchQuery(card).replace(/\b(PSA|BGS|CGC)\s*[\d.]+/, "").trim());
    const r = await fetch(`https://www.pricecharting.com/api/product?t=${config.priceChartingToken}&q=${q}`);
    if (!r.ok) throw new Error(`PriceCharting ${r.status}`);
    const j = (await r.json()) as Record<string, unknown> & { id?: string; "product-name"?: string };
    const cents = Number(j[field]);
    if (!cents) return [];
    const day = new Date().toISOString().slice(0, 10);
    return [{
      source: "pricecharting",
      kind: "reference" as const,
      externalId: `${j.id}:${field}:${day}`,
      priceUsd: cents / 100,
      originalPrice: cents / 100,
      currency: "USD",
      title: j["product-name"],
      url: j.id ? `https://www.pricecharting.com/offers?product=${j.id}` : undefined,
      observedAt: new Date(),
    }];
  },
};
