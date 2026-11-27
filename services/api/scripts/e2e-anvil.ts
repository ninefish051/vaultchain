/**
 * End-to-end check of the escrow sale flow against a local chain + the real API and indexer.
 *
 *   anvil &                                   # chain 31337
 *   (deploy contracts, sync deployments)      # see README
 *   DATABASE_URL=… CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 INDEXER_POLL_MS=1000 PORT=4002 pnpm --filter @vaultchain/api start
 *   API_URL=http://localhost:4002 DATABASE_URL=… pnpm --filter @vaultchain/api e2e
 *
 * Uses anvil's default accounts: #0 deployer (admin, vault, oracle signer, relayer), #1 buyer, #2 seller.
 * Walks: listing → signed order → both deposits → ship → inspect → pay → NFT to buyer → withdraw,
 * and checks the listing goes active → reserved → sold, and shipping-address permissions.
 */
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getDb } from "@vaultchain/db";
import {
  anvil,
  cardPriceOracleAbi,
  DEMO_CARDS,
  DEFAULT_WINDOWS,
  escrowDomain,
  mockUSDCAbi,
  oracleDomain,
  orderTermsTypes,
  pricePointTypes,
  requireDeployment,
  slabIdOf,
  slabMetadataHash,
  swapEscrowAbi,
  swapEscrowDomain,
  swapTermsTypes,
  toUsd6,
  vaultCardNFTAbi,
  vaultEscrowAbi,
} from "@vaultchain/shared";

const API = process.env.API_URL ?? "http://localhost:4002";
const KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const [admin, buyer, seller] = KEYS.map((k) => privateKeyToAccount(k));
const transport = http(process.env.RPC_URL ?? "http://127.0.0.1:8545");
const pub = createPublicClient({ chain: anvil, transport });
const wallet = (a: typeof admin) => createWalletClient({ account: a, chain: anvil, transport });
const d = requireDeployment(31337);
const db = getDb();

let step = 0;
const ok = (msg: string) => console.log(`  ✓ ${++step}. ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`);
}

async function send(a: typeof admin, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: a, address, abi, functionName, args });
  const hash = await wallet(a).writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash });
  assert(r.status === "success", `${functionName} reverted`);
  return hash;
}

async function signedFetch(a: typeof admin, method: "POST" | "GET", path: string, body?: unknown) {
  const raw = body === undefined ? undefined : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const msg = `VaultChain API\n${method} ${path}\n${ts}\n${raw ? keccak256(toBytes(raw)) : "0x0"}`;
  const signature = await a.signMessage({ message: msg });
  return fetch(`${API}${path}`, {
    method,
    body: raw,
    headers: { "content-type": "application/json", "x-vc-address": a.address, "x-vc-timestamp": ts, "x-vc-signature": signature },
  });
}

async function listingStatus(id: string) {
  return (await db.query("SELECT status FROM listings WHERE id = $1", [id])).rows[0]?.status as string | undefined;
}

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const card = DEMO_CARDS.find((c) => c.name === "Blastoise" && c.grade === "10")!;
const cert = String(80_000_000 + (Date.now() % 1_000_000));
const slabId = slabIdOf("PSA", cert);
const PRICE = 3_000;

console.log(`E2E on chain 31337 · escrow ${d.escrow}`);

// 0. funds + oracle price
for (const who of [buyer, seller]) await send(admin, d.usdc, mockUSDCAbi as Abi, "mint", [who.address, toUsd6(100_000)]);
const now = BigInt((await pub.getBlock()).timestamp);
const point = { fairValueUsd: toUsd6(3_050), volatilityBps: 800, sampleCount: 20, confidence: 85, updatedAt: now, evidenceHash: keccak256(toBytes("e2e")) };
const psig = await admin.signTypedData({ domain: oracleDomain(31337, d.oracle), types: pricePointTypes, primaryType: "PricePoint", message: { cardKey: card.cardKey, ...point } });
await send(admin, d.oracle, cardPriceOracleAbi as Abi, "submitPrice", [card.cardKey, point, psig]);
ok("minted test USDC and published a signed oracle price ($3,050, 8% vol)");

// 1. seller lists the slab (escrow)
const lr = await signedFetch(seller, "POST", "/listings", { type: "escrow", grader: "PSA", certNumber: cert, cardKey: card.cardKey, priceUsd: PRICE, acceptsSwap: false, floorUsd: 2_900 });
if (!lr.ok) throw new Error(`create listing: ${lr.status} ${await lr.text()}`);
const listing = (await lr.json()) as { id: string };
assert((await listingStatus(listing.id)) === "active", "listing active");
ok(`seller listed PSA ${cert} for $${PRICE} (listing ${listing.id})`);

// 2. both sign the same EIP-712 terms; createOrder
const terms = {
  buyer: buyer.address,
  seller: seller.address,
  cardKey: card.cardKey,
  slabId,
  metadataHash: slabMetadataHash(card.cardKey, cert),
  priceUsd: toUsd6(PRICE),
  ...DEFAULT_WINDOWS,
  fulfillment: 1,
  nonce: BigInt(Date.now()),
  signDeadline: now + 3600n,
};
const typed = { domain: escrowDomain(31337, d.escrow), types: orderTermsTypes, primaryType: "OrderTerms", message: terms } as const;
const [bs, ss] = await Promise.all([buyer.signTypedData(typed), seller.signTypedData(typed)]);
await send(buyer, d.escrow, vaultEscrowAbi as Abi, "createOrder", [terms, bs, ss]);
const orderId = (await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "hashOrderTerms", args: [terms] })) as Hex;
ok(`order created on-chain ${orderId.slice(0, 12)}…`);

await waitFor("listing reserved", async () => (await listingStatus(listing.id)) === "reserved");
const pubListings = (await (await fetch(`${API}/listings?cardKey=${card.cardKey}`)).json()) as { id: string }[];
assert(!pubListings.some((l) => l.id === listing.id), "reserved listing hidden from marketplace");
ok("indexer reserved the listing; it is hidden from the market");

// 3. a second order on the same slab is rejected by the contract
const t2 = { ...terms, nonce: terms.nonce + 1n };
const typed2 = { ...typed, message: t2 };
const [bs2, ss2] = await Promise.all([buyer.signTypedData(typed2), seller.signTypedData(typed2)]);
let blocked = false;
try {
  await pub.simulateContract({ account: buyer, address: d.escrow, abi: vaultEscrowAbi, functionName: "createOrder", args: [t2, bs2, ss2] });
} catch {
  blocked = true;
}
assert(blocked, "second order on the same slab must revert");
ok("second order for the same slab reverts (SlabBusy)");

// 4. shipping address permissions (buyer yes, seller no)
const addr = { name: "E2E Buyer", phone: "+6590000000", line1: "1 Test St", city: "Singapore", postalCode: "000001", country: "SG" };
assert((await signedFetch(buyer, "POST", "/shipping", { target: "order", targetId: orderId, address: addr })).ok, "buyer can save address");
assert((await signedFetch(seller, "POST", "/shipping", { target: "order", targetId: orderId, address: addr })).status === 403, "seller cannot");
ok("buyer saved an encrypted shipping address; seller was refused (403)");

// 5. deposits
const order0 = await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "getOrder", args: [orderId] });
for (const who of [buyer, seller]) {
  await send(who, d.usdc, mockUSDCAbi as Abi, "approve", [d.escrow, 2n ** 255n]);
  await send(who, d.escrow, vaultEscrowAbi as Abi, "fund", [orderId]);
}
assert(order0.depositUsd % 10_000n === 0n, "deposit in whole cents");
ok(`both deposits locked ($${Number(order0.depositUsd) / 1e6} each)`);

// 6. ship → inspect → pay
await send(seller, d.escrow, vaultEscrowAbi as Abi, "markShipped", [orderId, keccak256(toBytes("SF-E2E-1"))]);
await send(admin, d.escrow, vaultEscrowAbi as Abi, "submitInspection", [orderId, true, keccak256(toBytes("report"))]);
await send(buyer, d.escrow, vaultEscrowAbi as Abi, "fund", [orderId]);
const order1 = await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "getOrder", args: [orderId] });
assert(order1.status === 7, `order completed (status ${order1.status})`);
const owner = await pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabId)] });
assert(owner.toLowerCase() === buyer.address.toLowerCase(), "NFT minted to buyer");
assert((await pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "slabLockedBy", args: [BigInt(slabId)] })) === "0x0000000000000000000000000000000000000000", "slab unlocked");
ok("shipped → inspected → paid in full; order Completed, vault NFT minted to buyer, slab lock released");

await waitFor("listing sold", async () => (await listingStatus(listing.id)) === "sold");
await waitFor("asset indexed", async () => {
  const assets = (await (await fetch(`${API}/assets?owner=${buyer.address}`)).json()) as { tokenId: string }[];
  return assets.some((a) => a.tokenId === BigInt(slabId).toString());
});
ok("indexer marked the listing sold and shows the NFT in the buyer's assets");

// 7. seller withdraws price - 1% fee + deposit
const credit = (await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "credits", args: [seller.address] })) as bigint;
const expected = toUsd6(PRICE) - toUsd6(PRICE) / 100n + order0.depositUsd;
assert(credit === expected, `seller credit ${credit} == ${expected}`);
await send(seller, d.escrow, vaultEscrowAbi as Abi, "withdraw", []);
ok(`seller withdrew $${Number(credit) / 1e6} (price − 1% fee + deposit)`);

// ------------------------------------------------------------------ swap: buyer's physical slab ⇄ seller's vault NFT + top-up
const cardB = DEMO_CARDS.find((c) => c.name === "Venusaur" && c.grade === "10")!;
const certA = String(81_000_000 + (Date.now() % 1_000_000));
const certB = String(82_000_000 + (Date.now() % 1_000_000));
const slabA = slabIdOf("PSA", certA);
const slabB = slabIdOf("PSA", certB);
const now2 = BigInt((await pub.getBlock()).timestamp);
const pointB = { ...point, fairValueUsd: toUsd6(2_900), updatedAt: now2 };
const psigB = await admin.signTypedData({ domain: oracleDomain(31337, d.oracle), types: pricePointTypes, primaryType: "PricePoint", message: { cardKey: cardB.cardKey, ...pointB } });
await send(admin, d.oracle, cardPriceOracleAbi as Abi, "submitPrice", [cardB.cardKey, pointB, psigB]);
await send(admin, d.nft, vaultCardNFTAbi as Abi, "mint", [seller.address, slabB, cardB.cardKey, slabMetadataHash(cardB.cardKey, certB)]);
ok("seller's Venusaur PSA 10 vaulted as an NFT; Venusaur priced at $2,900");

const swapTerms = {
  a: { owner: buyer.address, cardKey: card.cardKey, slabId: slabA, metadataHash: slabMetadataHash(card.cardKey, certA), kind: 0, delivery: 1 },
  b: { owner: seller.address, cardKey: cardB.cardKey, slabId: slabB, metadataHash: slabMetadataHash(cardB.cardKey, certB), kind: 1, delivery: 1 },
  topUpUsd: toUsd6(150),
  topUpFrom: 2, // seller adds $150: $3,050 card ⇄ $2,900 card + $150
  depositWindow: DEFAULT_WINDOWS.depositWindow,
  shipWindow: DEFAULT_WINDOWS.shipWindow,
  inspectWindow: DEFAULT_WINDOWS.inspectWindow,
  nonce: BigInt(Date.now()) + 7n,
  signDeadline: now2 + 3600n,
};
const swapTyped = { domain: swapEscrowDomain(31337, d.swapEscrow), types: swapTermsTypes, primaryType: "SwapTerms", message: swapTerms } as const;
const [sigA, sigB] = await Promise.all([buyer.signTypedData(swapTyped), seller.signTypedData(swapTyped)]);
await send(buyer, d.swapEscrow, swapEscrowAbi as Abi, "createSwap", [swapTerms, sigA, sigB]);
const swapId = (await pub.readContract({ address: d.swapEscrow, abi: swapEscrowAbi, functionName: "hashSwapTerms", args: [swapTerms] })) as Hex;
ok(`swap created ${swapId.slice(0, 12)}…`);

await send(seller, d.nft, vaultCardNFTAbi as Abi, "setApprovalForAll", [d.swapEscrow, true]);
for (const who of [buyer, seller]) {
  await send(who, d.usdc, mockUSDCAbi as Abi, "approve", [d.swapEscrow, 2n ** 255n]);
  await send(who, d.swapEscrow, swapEscrowAbi as Abi, "fund", [swapId]);
}
const nftHolder = await pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabB)] });
assert(nftHolder.toLowerCase() === d.swapEscrow.toLowerCase(), "seller NFT held in escrow");
ok("both deposits locked; seller's NFT moved into escrow, seller's top-up locked");

await send(buyer, d.swapEscrow, swapEscrowAbi as Abi, "markShipped", [swapId, keccak256(toBytes("SF-SWAP-1"))]);
await send(admin, d.swapEscrow, swapEscrowAbi as Abi, "submitInspection", [swapId, 0, true, keccak256(toBytes("swap report"))]);
const swap = await pub.readContract({ address: d.swapEscrow, abi: swapEscrowAbi, functionName: "getSwap", args: [swapId] });
assert(swap.status === 6, `swap completed (status ${swap.status})`);
const [ownA, ownB] = await Promise.all([
  pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabA)] }),
  pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabB)] }),
]);
assert(ownA.toLowerCase() === seller.address.toLowerCase() && ownB.toLowerCase() === buyer.address.toLowerCase(), "cards swapped");
const buyerSwapCredit = (await pub.readContract({ address: d.swapEscrow, abi: swapEscrowAbi, functionName: "credits", args: [buyer.address] })) as bigint;
assert(buyerSwapCredit === swap.depositUsd - toUsd6(29) + toUsd6(150), `buyer credit = deposit − 1% of $2,900 + $150 top-up (got ${buyerSwapCredit})`);
ok("buyer's slab inspected → swap Completed: buyer owns the Venusaur NFT, seller owns a newly minted Blastoise NFT, top-up paid");

await waitFor("swap indexed as Completed", async () => {
  const r = await fetch(`${API}/swaps/${swapId}`);
  return r.ok && ((await r.json()) as { status: string }).status === "Completed";
});
ok("indexer shows the swap as Completed");

console.log("\nE2E passed.");
await db.end();
