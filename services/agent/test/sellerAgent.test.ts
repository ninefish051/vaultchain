import { describe, expect, it } from "vitest";
import { respondToOffer, sellerFloor } from "../src/sellerAgent";

describe("seller agent", () => {
  const policy = { askUsd: 5000, fairValueUsd: 4800 };

  it("derives the floor from ask and fair value", () => {
    expect(sellerFloor(policy)).toBe(4750); // max(95% of 5000, 97% of 4800 = 4656)
    expect(sellerFloor({ ...policy, sellerFloorUsd: 4900 })).toBe(4900);
  });

  it("accepts at or above the floor", () => {
    expect(respondToOffer(policy, 4750)).toMatchObject({ decision: "accept", priceUsd: 4750 });
  });

  it("counters near the floor, never below it", () => {
    const r = respondToOffer(policy, 4200);
    expect(r.decision).toBe("counter");
    if (r.decision === "counter") expect(r.priceUsd).toBeGreaterThanOrEqual(4750);
  });

  it("rejects lowball offers", () => {
    expect(respondToOffer(policy, 3000).decision).toBe("reject");
  });
});
