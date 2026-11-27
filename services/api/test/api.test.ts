import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { DEMO_CARDS } from "@vaultchain/shared";
import { signedRequestMessage } from "../src/auth";
import { buildServer } from "../src/main";

delete process.env.DATABASE_URL; // demo store
process.env.CHAIN_ID = "999999"; // no chain
const app = await buildServer();
const seller = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

async function signed(method: "POST" | "DELETE", url: string, body?: unknown) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = await seller.signMessage({ message: signedRequestMessage(method, url, ts, raw) });
  return app.inject({
    method,
    url,
    payload: raw,
    headers: { "content-type": "application/json", "x-vc-address": seller.address, "x-vc-timestamp": ts, "x-vc-signature": signature },
  });
}

beforeAll(async () => app.ready());
afterAll(async () => app.close());

describe("api (demo store)", () => {
  it("lists cards with prices, sorted by price", async () => {
    const r = await app.inject("/cards");
    const cards = r.json();
    expect(r.statusCode).toBe(200);
    expect(cards.length).toBe(DEMO_CARDS.length);
    expect(cards[0].price.fairValueUsd).toBeGreaterThanOrEqual(cards[1].price.fairValueUsd);
  });

  it("returns a card detail with history and sales", async () => {
    const r = await app.inject(`/cards/${DEMO_CARDS[0]!.cardKey}`);
    const d = r.json();
    expect(d.history.length).toBe(90);
    expect(d.sales.length).toBeGreaterThan(0);
  });

  it("quotes a swap with a top-up and a whole-cent deposit", async () => {
    const r = await app.inject({ method: "POST", url: "/quote/swap", payload: { cardKeyA: DEMO_CARDS[2]!.cardKey, cardKeyB: DEMO_CARDS[4]!.cardKey } });
    const q = r.json();
    expect(r.statusCode).toBe(200);
    expect(Math.round(q.depositUsd * 100)).toBe(q.depositUsd * 100);
    expect([0, 1, 2]).toContain(q.topUpFrom);
  });

  it("requires a wallet signature to create a listing and accepts a valid one", async () => {
    const body = { type: "escrow", grader: "PSA", certNumber: "12345678", cardKey: DEMO_CARDS[0]!.cardKey, priceUsd: 12000, acceptsSwap: true };
    const unsigned = await app.inject({ method: "POST", url: "/listings", payload: body });
    expect(unsigned.statusCode).toBe(401);
    const r = await signed("POST", "/listings", body);
    expect(r.statusCode).toBe(200);
    expect(r.json().seller.toLowerCase()).toBe(seller.address.toLowerCase());
  });

  it("rejects bad input", async () => {
    const r = await app.inject("/cards/0x1234");
    expect(r.statusCode).toBe(400);
  });
});
