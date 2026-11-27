import { config } from "../config";
import { toUsd } from "../fx";
import { searchQuery, titleMatches } from "../match";
import type { Collector } from "./types";

/** Carousell Singapore asks (scraped). Sold prices are not public, so these count as listings. */
export const carousell: Collector = {
  name: "carousell",
  enabled: () => config.scrapers,
  async collect(card) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(`https://www.carousell.sg/search/${encodeURIComponent(searchQuery(card))}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(3000);
      const rows = await page.$$eval("[data-testid^='listing-card-']", (items) =>
        items.map((el) => ({
          id: el.getAttribute("data-testid")?.replace("listing-card-", "") ?? "",
          text: (el as HTMLElement).innerText,
          url: el.querySelector("a[href*='/p/']")?.getAttribute("href") ?? "",
        })),
      );
      const out = [];
      for (const row of rows) {
        const price = row.text.match(/S\$\s?([\d,]+(?:\.\d+)?)/);
        const title = row.text.split("\n").find((l) => l.length > 12) ?? "";
        if (!row.id || !price || !titleMatches(card, title)) continue;
        const original = Number(price[1]!.replace(/,/g, ""));
        out.push({
          source: "carousell",
          kind: "listing" as const,
          externalId: `${row.id}:${new Date().toISOString().slice(0, 10)}`,
          priceUsd: await toUsd(original, "SGD"),
          originalPrice: original,
          currency: "SGD",
          title,
          url: row.url ? `https://www.carousell.sg${row.url}` : undefined,
          observedAt: new Date(),
        });
      }
      await new Promise((r) => setTimeout(r, config.scraperDelayMs));
      return out;
    } finally {
      await browser.close();
    }
  },
};
