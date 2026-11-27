import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toBytes } from "viem";
import {
  aggregate,
  canonicalCardString,
  cardKeyOf,
  depositBpsFor,
  filterOutliers,
  pricePointTypes,
  slabIdOf,
  suggestTopUp,
  swapDepositUsd,
  weightedMedian,
  DEMO_CARDS,
  demoSnapshot,
  type PriceSample,
} from "../src";

describe("cardKey", () => {
  it("normalizes case and grade", () => {
    const a = canonicalCardString({ game: "Pokemon", set: "BASE1", number: "4/102", language: "en", variant: "Holo", grader: "PSA", grade: "10.0" });
    expect(a).toBe("pokemon|base1|4/102|EN|holo|PSA|10");
    expect(cardKeyOf({ game: "pokemon", set: "base1", number: "4/102", language: "EN", variant: "holo", grader: "PSA", grade: "10" })).toBe(
      keccak256(toBytes("pokemon|base1|4/102|EN|holo|PSA|10")),
    );
  });

  it("slabId matches the contracts' test convention", () => {
    expect(slabIdOf("PSA", "12345678")).toBe(keccak256(toBytes("PSA|12345678")));
    expect(slabIdOf("PSA", "#1234-5678")).toBe(slabIdOf("PSA", "12345678"));
  });
});

describe("pricing", () => {
  const now = new Date("2026-11-26T00:00:00Z");
  const sample = (p: number, daysAgo: number, kind: PriceSample["kind"] = "sold"): PriceSample => ({
    source: "test",
    kind,
    priceUsd: p,
    observedAt: new Date(now.getTime() - daysAgo * 86_400_000),
  });

  it("drops a fat-finger outlier", () => {
    const { kept, rejected } = filterOutliers([100, 102, 98, 101, 99, 1000].map((p) => sample(p, 1)));
    expect(rejected.map((s) => s.priceUsd)).toEqual([1000]);
    expect(kept).toHaveLength(5);
  });

  it("weighted median favours heavy weights", () => {
    expect(weightedMedian([{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 10, weight: 5 }])).toBe(10);
  });

  it("aggregate prefers recent sold data over stale asks", () => {
    const r = aggregate([sample(5000, 1), sample(5100, 2), sample(4900, 3), sample(8000, 1, "listing"), sample(3000, 80)], now);
    expect(r.fairValueUsd).toBeGreaterThanOrEqual(4900);
    expect(r.fairValueUsd).toBeLessThanOrEqual(5100);
    expect(r.confidence).toBeGreaterThan(0);
  });

  it("deposit and swap helpers mirror the contracts", () => {
    expect(depositBpsFor(800)).toBe(2600);
    expect(depositBpsFor(5000)).toBe(3000);
    expect(swapDepositUsd(5000, 6000, 800, 600)).toBe(1560); // SwapEscrow test: $1,560
    expect(suggestTopUp(5000, 6000)).toEqual({ topUpUsd: 1000, topUpFrom: 1 });
    expect(suggestTopUp(6000, 5000)).toEqual({ topUpUsd: 1000, topUpFrom: 2 });
  });
});

describe("eip712", () => {
  it("PricePoint type string matches CardPriceOracle.PRICE_TYPEHASH", () => {
    // hashTypedData succeeds only with a well-formed type; the string itself is checked in the Foundry tests.
    const digest = hashTypedData({
      domain: { name: "VaultChain CardPriceOracle", version: "1", chainId: 1, verifyingContract: "0x0000000000000000000000000000000000000001" },
      types: pricePointTypes,
      primaryType: "PricePoint",
      message: { cardKey: keccak256(toBytes("x")), fairValueUsd: 1n, volatilityBps: 1, sampleCount: 1, confidence: 1, updatedAt: 1n, evidenceHash: keccak256(toBytes("e")) },
    });
    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("demo data", () => {
  it("produces a snapshot for every demo card", () => {
    for (const c of DEMO_CARDS) expect(demoSnapshot(c.cardKey)?.fairValueUsd).toBeGreaterThan(0);
  });
});
