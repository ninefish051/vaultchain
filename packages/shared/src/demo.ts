import type { Address, Hex } from "viem";
import { cardKeyOf, canonicalCardString, slabIdOf, type CardIdentity, type Grader } from "./cardKey";
import { aggregate, type PriceSample } from "./pricing";
import type { CardType, Listing, PricePointSeries, PriceSnapshot, SaleRecord } from "./types";

/**
 * Demo catalogue for the hackathon build and for running the web app without a backend.
 * Prices are synthetic (seeded random walk around a base price), clearly labelled "demo" in the UI.
 */

interface DemoSeed {
  name: string;
  setName: string;
  set: string; // pokemontcg.io set id
  number: string;
  variant: string;
  grader: Grader;
  grade: string;
  base: number; // USD
  vol: number; // daily volatility (fraction)
  year: number;
}

const SEEDS: DemoSeed[] = [
  { name: "Charizard", setName: "Base Set", set: "base1", number: "4/102", variant: "holo", grader: "PSA", grade: "10", base: 12000, vol: 0.018, year: 1999 },
  { name: "Charizard", setName: "Base Set", set: "base1", number: "4/102", variant: "holo", grader: "PSA", grade: "9", base: 2400, vol: 0.02, year: 1999 },
  { name: "Blastoise", setName: "Base Set", set: "base1", number: "2/102", variant: "holo", grader: "PSA", grade: "10", base: 3200, vol: 0.016, year: 1999 },
  { name: "Blastoise", setName: "Base Set", set: "base1", number: "2/102", variant: "holo", grader: "PSA", grade: "9", base: 700, vol: 0.02, year: 1999 },
  { name: "Venusaur", setName: "Base Set", set: "base1", number: "15/102", variant: "holo", grader: "PSA", grade: "10", base: 2600, vol: 0.017, year: 1999 },
  { name: "Mewtwo", setName: "Base Set", set: "base1", number: "10/102", variant: "holo", grader: "PSA", grade: "10", base: 1400, vol: 0.015, year: 1999 },
  { name: "Mewtwo", setName: "Base Set", set: "base1", number: "10/102", variant: "holo", grader: "CGC", grade: "9.5", base: 450, vol: 0.022, year: 1999 },
  { name: "Alakazam", setName: "Base Set", set: "base1", number: "1/102", variant: "holo", grader: "PSA", grade: "10", base: 1100, vol: 0.015, year: 1999 },
  { name: "Gyarados", setName: "Base Set", set: "base1", number: "6/102", variant: "holo", grader: "PSA", grade: "10", base: 900, vol: 0.016, year: 1999 },
  { name: "Pikachu", setName: "Base Set", set: "base1", number: "58/102", variant: "", grader: "PSA", grade: "10", base: 650, vol: 0.02, year: 1999 },
  { name: "Gengar", setName: "Fossil", set: "base3", number: "5/62", variant: "holo", grader: "PSA", grade: "10", base: 1500, vol: 0.018, year: 1999 },
  { name: "Dragonite", setName: "Fossil", set: "base3", number: "4/62", variant: "holo", grader: "PSA", grade: "10", base: 1300, vol: 0.017, year: 1999 },
  { name: "Lugia", setName: "Neo Genesis", set: "neo1", number: "9/111", variant: "holo", grader: "PSA", grade: "10", base: 9500, vol: 0.02, year: 2000 },
  { name: "Umbreon", setName: "Neo Discovery", set: "neo2", number: "13/75", variant: "holo", grader: "PSA", grade: "10", base: 2800, vol: 0.019, year: 2001 },
  { name: "Espeon", setName: "Neo Discovery", set: "neo2", number: "1/75", variant: "holo", grader: "PSA", grade: "10", base: 1800, vol: 0.019, year: 2001 },
  { name: "Charizard EX", setName: "Evolutions", set: "xy12", number: "12/108", variant: "holo", grader: "PSA", grade: "10", base: 220, vol: 0.025, year: 2016 },
  { name: "Pikachu VMAX", setName: "Vivid Voltage", set: "swsh4", number: "44/185", variant: "", grader: "PSA", grade: "10", base: 260, vol: 0.024, year: 2020 },
  { name: "Umbreon VMAX (Alt Art)", setName: "Evolving Skies", set: "swsh7", number: "215/203", variant: "alt-art", grader: "PSA", grade: "10", base: 1900, vol: 0.028, year: 2021 },
  { name: "Umbreon VMAX (Alt Art)", setName: "Evolving Skies", set: "swsh7", number: "215/203", variant: "alt-art", grader: "BGS", grade: "9.5", base: 1300, vol: 0.028, year: 2021 },
  { name: "Rayquaza VMAX (Alt Art)", setName: "Evolving Skies", set: "swsh7", number: "218/203", variant: "alt-art", grader: "PSA", grade: "10", base: 1100, vol: 0.027, year: 2021 },
  { name: "Giratina V (Alt Art)", setName: "Lost Origin", set: "swsh11", number: "186/196", variant: "alt-art", grader: "PSA", grade: "10", base: 700, vol: 0.026, year: 2022 },
  { name: "Lugia V (Alt Art)", setName: "Silver Tempest", set: "swsh12", number: "186/195", variant: "alt-art", grader: "PSA", grade: "10", base: 650, vol: 0.026, year: 2022 },
  { name: "Charizard ex (SIR)", setName: "Scarlet & Violet 151", set: "sv3pt5", number: "199/165", variant: "sir", grader: "PSA", grade: "10", base: 380, vol: 0.03, year: 2023 },
  { name: "Mew ex (SIR)", setName: "Scarlet & Violet 151", set: "sv3pt5", number: "205/165", variant: "sir", grader: "PSA", grade: "10", base: 220, vol: 0.03, year: 2023 },
];

function identityOf(s: DemoSeed): CardIdentity {
  return { game: "pokemon", set: s.set, number: s.number, language: "EN", variant: s.variant, grader: s.grader, grade: s.grade };
}

export const DEMO_CARDS: CardType[] = SEEDS.map((s) => {
  const id = identityOf(s);
  return {
    cardKey: cardKeyOf(id),
    canonical: canonicalCardString(id),
    name: s.name,
    setName: s.setName,
    number: s.number,
    language: "EN",
    variant: s.variant,
    grader: s.grader,
    grade: s.grade,
    imageUrl: `https://images.pokemontcg.io/${s.set}/${s.number.split("/")[0]}_hires.png`,
    year: s.year,
  };
});

const seedByKey = new Map<string, DemoSeed>(SEEDS.map((s, i) => [DEMO_CARDS[i]!.cardKey, s]));

/** Deterministic PRNG so every process renders the same demo history. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const DAY = 86_400_000;
const startOfToday = () => Math.floor(Date.now() / DAY) * DAY;

export function demoPriceHistory(cardKey: Hex, days = 90): PricePointSeries[] {
  const s = seedByKey.get(cardKey);
  if (!s) return [];
  const rnd = mulberry32(Number.parseInt(cardKey.slice(2, 10), 16));
  let p = s.base * (0.85 + rnd() * 0.15);
  const out: PricePointSeries[] = [];
  const today = startOfToday();
  for (let i = days - 1; i >= 0; i--) {
    p = p * Math.exp(0.5 * s.vol * gauss(rnd) + (s.base - p) / s.base / 40);
    out.push({ date: new Date(today - i * DAY).toISOString().slice(0, 10), fairValueUsd: Math.round(p * 100) / 100 });
  }
  return out;
}

const SOURCES: { source: string; kind: SaleRecord["kind"]; currency: string; fx: number; spread: number }[] = [
  { source: "ebay-sold", kind: "sold", currency: "USD", fx: 1, spread: 0.04 },
  { source: "ebay-sold", kind: "sold", currency: "USD", fx: 1, spread: 0.04 },
  { source: "ebay-browse", kind: "listing", currency: "USD", fx: 1, spread: 0.1 },
  { source: "pricecharting", kind: "reference", currency: "USD", fx: 1, spread: 0.03 },
  { source: "carousell", kind: "sold", currency: "SGD", fx: 1.34, spread: 0.05 },
  { source: "jihuanshe", kind: "sold", currency: "CNY", fx: 7.2, spread: 0.05 },
];

export function demoSales(cardKey: Hex, count = 120): SaleRecord[] {
  const history = demoPriceHistory(cardKey);
  if (history.length === 0) return [];
  const rnd = mulberry32(Number.parseInt(cardKey.slice(10, 18), 16));
  const card = DEMO_CARDS.find((c) => c.cardKey === cardKey)!;
  const out: SaleRecord[] = [];
  for (let i = 0; i < count; i++) {
    const day = Math.floor(rnd() * history.length);
    const point = history[day]!;
    const src = SOURCES[Math.floor(rnd() * SOURCES.length)]!;
    const usd = point.fairValueUsd * (1 + src.spread * gauss(rnd) + (src.kind === "listing" ? 0.08 : 0));
    out.push({
      source: src.source,
      kind: src.kind,
      priceUsd: Math.round(usd * 100) / 100,
      originalPrice: Math.round(usd * src.fx * 100) / 100,
      currency: src.currency,
      observedAt: new Date(`${point.date}T${String(Math.floor(rnd() * 24)).padStart(2, "0")}:00:00Z`).toISOString(),
      title: `${card.year} Pokemon ${card.setName} ${card.name} #${card.number.split("/")[0]} ${card.grader} ${card.grade}`,
    });
  }
  return out.sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

export function demoSnapshot(cardKey: Hex): PriceSnapshot | undefined {
  const history = demoPriceHistory(cardKey);
  if (history.length < 31) return undefined;
  const samples: PriceSample[] = demoSales(cardKey).map((s) => ({
    source: s.source,
    kind: s.kind,
    priceUsd: s.priceUsd,
    observedAt: new Date(s.observedAt),
  }));
  const agg = aggregate(samples);
  const last = history[history.length - 1]!.fairValueUsd;
  const prev = history[history.length - 2]!.fairValueUsd;
  const prev30 = history[history.length - 31]!.fairValueUsd;
  return {
    cardKey,
    fairValueUsd: last,
    volatilityBps: agg.volatilityBps,
    confidence: agg.confidence,
    sampleCount: agg.sampleCount,
    change24hPct: Math.round(((last - prev) / prev) * 10_000) / 100,
    change30dPct: Math.round(((last - prev30) / prev30) * 10_000) / 100,
    updatedAt: new Date().toISOString(),
  };
}

const DEMO_SELLERS: Address[] = [
  "0x8B3f5393bA08c24cc7ff5A66a832562aAB7bC95f",
  "0x2d3a3E8B4f0c1e1E2b4C6B0C9a5e9F7C8d1a2b3C",
  "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
];

export const DEMO_LISTINGS: Listing[] = DEMO_CARDS.flatMap((card, i) => {
  const snap = demoPriceHistory(card.cardKey).at(-1)!;
  const cert = String(70_000_000 + i * 7919);
  const slabId = slabIdOf(card.grader, cert);
  const markup = 0.96 + ((i * 37) % 11) / 100;
  return [
    {
      id: `demo-${i}`,
      type: i % 3 === 2 ? ("escrow" as const) : ("vault" as const),
      slabId,
      tokenId: i % 3 === 2 ? undefined : BigInt(slabId).toString(),
      cardKey: card.cardKey,
      certNumber: cert,
      seller: DEMO_SELLERS[i % DEMO_SELLERS.length]!,
      priceUsd: Math.round(snap.fairValueUsd * markup),
      acceptsSwap: i % 2 === 0,
      swapWants: i % 2 === 0 ? `Any ${card.grader} ${card.grade} of similar value` : undefined,
      images: [card.imageUrl],
      createdAt: new Date(Date.now() - i * 3_600_000 * 7).toISOString(),
    },
  ];
});
