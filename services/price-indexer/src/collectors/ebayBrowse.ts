import { config } from "../config";
import { toUsd } from "../fx";
import { searchQuery, titleMatches } from "../match";
import type { Collector } from "./types";

/**
 * eBay Browse API (official). Returns *active* listings (asks), used as a weak signal.
 * Category 183454 = CCG Individual Cards. OAuth client-credentials token, cached.
 */
let token: { value: string; exp: number } | undefined;

async function appToken(): Promise<string> {
  if (token && Date.now() < token.exp - 60_000) return token.value;
  const basic = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  if (!r.ok) throw new Error(`eBay OAuth ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return token.value;
}

interface ItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  itemWebUrl?: string;
  itemCreationDate?: string;
  buyingOptions?: string[];
}

export const ebayBrowse: Collector = {
  name: "ebay-browse",
  enabled: () => Boolean(config.ebay.clientId && config.ebay.clientSecret),
  async collect(card) {
    const q = encodeURIComponent(searchQuery(card));
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&category_ids=183454&filter=buyingOptions:{FIXED_PRICE}&limit=50`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${await appToken()}`, "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplace },
    });
    if (!r.ok) throw new Error(`eBay Browse ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { itemSummaries?: ItemSummary[] };
    const out = [];
    for (const it of j.itemSummaries ?? []) {
      if (!it.price || !titleMatches(card, it.title)) continue;
      const original = Number(it.price.value);
      out.push({
        source: "ebay-browse",
        kind: "listing" as const,
        externalId: `${it.itemId}:${new Date().toISOString().slice(0, 10)}`, // one observation per listing per day
        priceUsd: await toUsd(original, it.price.currency),
        originalPrice: original,
        currency: it.price.currency,
        title: it.title,
        url: it.itemWebUrl,
        observedAt: new Date(),
      });
    }
    return out;
  },
};
