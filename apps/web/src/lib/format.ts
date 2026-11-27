import type { CardType } from "@vaultchain/shared";

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdFmt2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const usd = (v?: number, cents = false) => (v === undefined || Number.isNaN(v) ? "—" : (cents ? usdFmt2 : usdFmt).format(v));
export const pct = (v?: number) => (v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
export const bps = (v?: number) => (v === undefined ? "—" : `${(v / 100).toFixed(1)}%`);
export const short = (a?: string, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "—");
export const cardTitle = (c: Pick<CardType, "name" | "setName" | "number">) => `${c.name} · ${c.setName} #${c.number.split("/")[0]}`;
export const gradeLabel = (c: Pick<CardType, "grader" | "grade">) => `${c.grader} ${c.grade}`;

export function timeLeft(iso?: string): string {
  if (!iso) return "—";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

export const ago = (iso: string) => {
  const d = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.floor(d)}d ago`;
};

export const SOURCE_LABEL: Record<string, string> = {
  "ebay-sold": "eBay sold",
  "ebay-browse": "eBay ask",
  pricecharting: "PriceCharting",
  carousell: "Carousell",
  jihuanshe: "集换社",
};
export const sourceLabel = (s: string) => SOURCE_LABEL[s.replace(/^demo:/, "")] ?? s;
