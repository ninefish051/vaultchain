import { demoSales } from "@vaultchain/shared";
import { config } from "../config";
import type { Collector } from "./types";

/** Synthetic samples for demo cards when no real source is configured. */
export const demo: Collector = {
  name: "demo",
  enabled: () => config.demoFallback,
  async collect(card) {
    return demoSales(card.cardKey).map((s, i) => ({
      ...s,
      source: `demo:${s.source}`,
      externalId: `demo:${card.cardKey}:${s.source}:${s.observedAt}:${s.priceUsd}`, // stable per observation
      observedAt: new Date(s.observedAt),
    }));
  },
};
