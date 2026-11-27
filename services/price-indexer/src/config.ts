const bool = (v: string | undefined, d = false) => (v === undefined ? d : ["1", "true", "yes"].includes(v.toLowerCase()));

export const config = {
  intervalMinutes: Number(process.env.INDEXER_INTERVAL_MINUTES ?? 60),
  ebay: {
    clientId: process.env.EBAY_CLIENT_ID,
    clientSecret: process.env.EBAY_CLIENT_SECRET,
    marketplace: process.env.EBAY_MARKETPLACE ?? "EBAY_US",
  },
  priceChartingToken: process.env.PRICECHARTING_TOKEN,
  /** Browser scrapers (eBay sold pages, Carousell). Off by default: respect robots/ToS, low frequency. */
  scrapers: bool(process.env.ENABLE_SCRAPERS),
  scraperDelayMs: Number(process.env.SCRAPER_DELAY_MS ?? 8000),
  /** Seed synthetic samples for cards with no real data (demo / hackathon). */
  demoFallback: bool(process.env.DEMO_FALLBACK, true),
};
