import { config } from "../config";
import { toUsd } from "../fx";
import { searchQuery, titleMatches } from "../match";
import type { Collector } from "./types";

/**
 * eBay completed/sold listings, scraped from the public search page with a headless browser.
 * The Browse API has no sold data (Marketplace Insights is restricted), so this is the main
 * source of real transaction prices. Off by default (ENABLE_SCRAPERS); keep frequency low.
 */
export const ebaySold: Collector = {
  name: "ebay-sold",
  enabled: () => config.scrapers,
  async collect(card) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ locale: "en-US" });
      const q = encodeURIComponent(searchQuery(card));
      await page.goto(`https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=183454&LH_Sold=1&LH_Complete=1&_ipg=60&rt=nc`, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const rows = await page.$$eval("li.s-item, li.s-card", (items) =>
        items.map((el) => ({
          id: el.getAttribute("data-listingid") ?? el.querySelector("a")?.getAttribute("href")?.match(/itm\/(\d+)/)?.[1] ?? "",
          title: (el.querySelector(".s-item__title, .s-card__title") as HTMLElement | null)?.innerText ?? "",
          price: (el.querySelector(".s-item__price, .s-card__price") as HTMLElement | null)?.innerText ?? "",
          sold: (el.querySelector(".s-item__caption--signal, .s-card__caption") as HTMLElement | null)?.innerText ?? "",
          url: el.querySelector("a")?.getAttribute("href") ?? "",
        })),
      );
      const out = [];
      for (const row of rows) {
        if (!row.id || !titleMatches(card, row.title)) continue;
        const m = row.price.match(/([A-Z]{0,3})\s*\$?([\d,]+\.?\d*)/);
        if (!m || row.price.includes(" to ")) continue; // skip ranges (multi-variation listings)
        const currency = m[1] && m[1] !== "US" ? m[1] : "USD";
        const original = Number(m[2]!.replace(/,/g, ""));
        const date = new Date(row.sold.replace(/^Sold\s+/i, ""));
        out.push({
          source: "ebay-sold",
          kind: "sold" as const,
          externalId: row.id,
          priceUsd: await toUsd(original, currency),
          originalPrice: original,
          currency,
          title: row.title,
          url: row.url.split("?")[0],
          observedAt: Number.isNaN(date.getTime()) ? new Date() : date,
        });
      }
      await new Promise((r) => setTimeout(r, config.scraperDelayMs));
      return out;
    } finally {
      await browser.close();
    }
  },
};
