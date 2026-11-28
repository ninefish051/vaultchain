/**
 * End-to-end check of the escrow sale and the card-for-card swap on HSK testnet, against the live
 * API and indexer (https://api.vaultchain.asia). Testnet counterpart of e2e-anvil.ts.
 *
 *   ./infra/aws/create-e2e-wallets.sh                       # once: buyer, seller, test vault operator
 *   forge script script/SetupE2E.s.sol …                     # once, by the admin: roles + testnet gas
 *   AWS_PROFILE=vaultchain pnpm --filter @vaultchain/api e2e:testnet
 *
 * Wallet keys come from the Secrets Manager secret vaultchain/e2e and are never printed. Prices are
 * the ones oracle-publisher already put on chain; this script does not sign prices. Listing and
 * order state is read through the public API (the database is in a private subnet).
 */
import { execFileSync } from "node:child_process";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  cardPriceOracleAbi,
  DEMO_CARDS,
  DEFAULT_WINDOWS,
  escrowDomain,
  hskTestnet,
  mockUSDCAbi,
  orderTermsTypes,
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

const CHAIN_ID = 133;
const API = process.env.API_URL ?? "https://api.vaultchain.asia";
const secret = JSON.parse(
  execFileSync("aws", ["secretsmanager", "get-secret-value", "--secret-id", process.env.E2E_SECRET_ID ?? "vaultchain/e2e",
    "--region", process.env.AWS_REGION ?? "ap-southeast-2", "--query", "SecretString", "--output", "text"], { encoding: "utf8" }),
) as Record<string, Hex | undefined>;
const key = (name: string): Hex => {
  const k = secret[name];
  if (!k) throw new Error(`${name} missing from vaultchain/e2e (run infra/aws/create-e2e-wallets.sh)`);
  return k;
};
const buyer = privateKeyToAccount(key("BUYER_KEY"));
const seller = privateKeyToAccount(key("SELLER_KEY"));
const vault = privateKeyToAccount(key("VAULT_KEY"));
type Account = typeof buyer;

const transport = http(process.env.RPC_URL ?? "https://testnet.hsk.xyz", { retryCount: 5, timeout: 30_000 });
const pub = createPublicClient({ chain: hskTestnet, transport });
const wallet = (a: Account) => createWalletClient({ account: a, chain: hskTestnet, transport });
const d = requireDeployment(CHAIN_ID);

let step = 0;
const ok = (msg: string) => console.log(`  ✓ ${++step}. ${msg}`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${msg}`);
}

async function send(a: Account, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  const { request } = await pub.simulateContract({ account: a, address, abi, functionName, args });
  const hash = await wallet(a).writeContract(request);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  assert(r.status === "success", `${functionName} reverted (${hash})`);
  return hash;
}

async function signedFetch(a: Account, method: "POST" | "GET", path: string, body?: unknown) {
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

const getJson = async <T>(path: string) => (await (await fetch(`${API}${path}`)).json()) as T;
const listed = async (id: string, cardKey: Hex) => (await getJson<{ id: string }[]>(`/listings?cardKey=${cardKey}`)).some((l) => l.id === id);

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 180_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function fairValue(cardKey: Hex) {
  const p = (await pub.readContract({ address: d.oracle, abi: cardPriceOracleAbi, functionName: "getPrice", args: [cardKey] })) as {
    fairValueUsd: bigint;
  };
  assert(p.fairValueUsd > 0n, `oracle has a price for ${cardKey}`);
  return p.fairValueUsd;
}

const run = Date.now();
const card = DEMO_CARDS.find((c) => c.name === "Blastoise" && c.grade === "10")!;
const cardB = DEMO_CARDS.find((c) => c.name === "Venusaur" && c.grade === "10")!;
const cert = String(80_000_000 + (run % 1_000_000));
const slabId = slabIdOf("PSA", cert);

console.log(`E2E on HSK testnet (${CHAIN_ID}) · API ${API} · escrow ${d.escrow}`);
console.log(`  buyer ${buyer.address} · seller ${seller.address} · vault ${vault.address}`);

// 0. gas, roles, test USDC, on-chain prices
for (const a of [buyer, seller, vault]) {
  assert((await pub.getBalance({ address: a.address })) > 0n, `${a.address} has testnet gas (run SetupE2E.s.sol)`);
}
const vaultRole = (await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "VAULT_ROLE" })) as Hex;
assert(
  await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "hasRole", args: [vaultRole, vault.address] }),
  "test vault operator has VAULT_ROLE (run SetupE2E.s.sol)",
);
for (const who of [buyer, seller]) await send(who, d.usdc, mockUSDCAbi as Abi, "mint", [who.address, toUsd6(100_000)]);
const fairA = await fairValue(card.cardKey);
const fairB = await fairValue(cardB.cardKey);
const PRICE = Math.round(Number(fairA) / 1e6);
ok(`minted test USDC; oracle prices on chain: Blastoise $${Number(fairA) / 1e6}, Venusaur $${Number(fairB) / 1e6}`);

// 1. seller lists the slab (escrow)
const lr = await signedFetch(seller, "POST", "/listings", {
  type: "escrow", grader: "PSA", certNumber: cert, cardKey: card.cardKey, priceUsd: PRICE, acceptsSwap: false, floorUsd: Math.round(PRICE * 0.95),
});
if (!lr.ok) throw new Error(`create listing: ${lr.status} ${await lr.text()}`);
const listing = (await lr.json()) as { id: string };
assert(await listed(listing.id, card.cardKey), "listing visible on the market");
ok(`seller listed PSA ${cert} for $${PRICE} (listing ${listing.id})`);

// 2. both sign the same EIP-712 terms; createOrder
const now = BigInt((await pub.getBlock()).timestamp);
const terms = {
  buyer: buyer.address,
  seller: seller.address,
  cardKey: card.cardKey,
  slabId,
  metadataHash: slabMetadataHash(card.cardKey, cert),
  priceUsd: toUsd6(PRICE),
  ...DEFAULT_WINDOWS,
  fulfillment: 1,
  nonce: BigInt(run),
  signDeadline: now + 3600n,
};
const typed = { domain: escrowDomain(CHAIN_ID, d.escrow), types: orderTermsTypes, primaryType: "OrderTerms", message: terms } as const;
const [bs, ss] = await Promise.all([buyer.signTypedData(typed), seller.signTypedData(typed)]);
await send(buyer, d.escrow, vaultEscrowAbi as Abi, "createOrder", [terms, bs, ss]);
const orderId = (await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "hashOrderTerms", args: [terms] })) as Hex;
ok(`order created on-chain ${orderId.slice(0, 12)}…`);

await waitFor("listing reserved", async () => !(await listed(listing.id, card.cardKey)));
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
await waitFor("order indexed", async () => (await fetch(`${API}/orders/${orderId}`)).ok);
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
await send(seller, d.escrow, vaultEscrowAbi as Abi, "markShipped", [orderId, keccak256(toBytes(`SF-E2E-${run}`))]);
await send(vault, d.escrow, vaultEscrowAbi as Abi, "submitInspection", [orderId, true, keccak256(toBytes("report"))]);
await send(buyer, d.escrow, vaultEscrowAbi as Abi, "fund", [orderId]);
const order1 = await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "getOrder", args: [orderId] });
assert(order1.status === 7, `order completed (status ${order1.status})`);
const owner = await pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabId)] });
assert(owner.toLowerCase() === buyer.address.toLowerCase(), "NFT minted to buyer");
assert((await pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "slabLockedBy", args: [BigInt(slabId)] })) === "0x0000000000000000000000000000000000000000", "slab unlocked");
ok("shipped → inspected → paid in full; order Completed, vault NFT minted to buyer, slab lock released");

await waitFor("order indexed as Completed", async () => (await getJson<{ status: string }>(`/orders/${orderId}`)).status === "Completed");
await waitFor("asset indexed", async () =>
  (await getJson<{ tokenId: string }[]>(`/assets?owner=${buyer.address}`)).some((a) => a.tokenId === BigInt(slabId).toString()),
);
ok("indexer shows the order Completed and the NFT in the buyer's assets");

// 7. seller withdraws price - 1% fee + deposit
const credit = (await pub.readContract({ address: d.escrow, abi: vaultEscrowAbi, functionName: "credits", args: [seller.address] })) as bigint;
const expected = toUsd6(PRICE) - toUsd6(PRICE) / 100n + order0.depositUsd;
assert(credit === expected, `seller credit ${credit} == ${expected}`);
await send(seller, d.escrow, vaultEscrowAbi as Abi, "withdraw", []);
ok(`seller withdrew $${Number(credit) / 1e6} (price − 1% fee + deposit)`);

// ------------------------------------------------------------------ swap: buyer's physical slab ⇄ seller's vault NFT + top-up
const certA = String(81_000_000 + (run % 1_000_000));
const certB = String(82_000_000 + (run % 1_000_000));
const slabA = slabIdOf("PSA", certA);
const slabB = slabIdOf("PSA", certB);
await send(vault, d.nft, vaultCardNFTAbi as Abi, "mint", [seller.address, slabB, cardB.cardKey, slabMetadataHash(cardB.cardKey, certB)]);
ok("seller's Venusaur PSA 10 vaulted as an NFT by the test vault operator");

// the side with the cheaper card adds the difference
const topUpFrom = fairA >= fairB ? 2 : 1;
const topUpUsd = fairA >= fairB ? fairA - fairB : fairB - fairA;
const now2 = BigInt((await pub.getBlock()).timestamp);
const swapTerms = {
  a: { owner: buyer.address, cardKey: card.cardKey, slabId: slabA, metadataHash: slabMetadataHash(card.cardKey, certA), kind: 0, delivery: 1 },
  b: { owner: seller.address, cardKey: cardB.cardKey, slabId: slabB, metadataHash: slabMetadataHash(cardB.cardKey, certB), kind: 1, delivery: 1 },
  topUpUsd,
  topUpFrom,
  depositWindow: DEFAULT_WINDOWS.depositWindow,
  shipWindow: DEFAULT_WINDOWS.shipWindow,
  inspectWindow: DEFAULT_WINDOWS.inspectWindow,
  nonce: BigInt(run) + 7n,
  signDeadline: now2 + 3600n,
};
const swapTyped = { domain: swapEscrowDomain(CHAIN_ID, d.swapEscrow), types: swapTermsTypes, primaryType: "SwapTerms", message: swapTerms } as const;
const [sigA, sigB] = await Promise.all([buyer.signTypedData(swapTyped), seller.signTypedData(swapTyped)]);
await send(buyer, d.swapEscrow, swapEscrowAbi as Abi, "createSwap", [swapTerms, sigA, sigB]);
const swapId = (await pub.readContract({ address: d.swapEscrow, abi: swapEscrowAbi, functionName: "hashSwapTerms", args: [swapTerms] })) as Hex;
ok(`swap created ${swapId.slice(0, 12)}… (top-up $${Number(topUpUsd) / 1e6} from ${topUpFrom === 2 ? "seller" : "buyer"})`);

await send(seller, d.nft, vaultCardNFTAbi as Abi, "setApprovalForAll", [d.swapEscrow, true]);
for (const who of [buyer, seller]) {
  await send(who, d.usdc, mockUSDCAbi as Abi, "approve", [d.swapEscrow, 2n ** 255n]);
  await send(who, d.swapEscrow, swapEscrowAbi as Abi, "fund", [swapId]);
}
const nftHolder = await pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabB)] });
assert(nftHolder.toLowerCase() === d.swapEscrow.toLowerCase(), "seller NFT held in escrow");
ok("both deposits locked; seller's NFT moved into escrow, top-up locked");

await send(buyer, d.swapEscrow, swapEscrowAbi as Abi, "markShipped", [swapId, keccak256(toBytes(`SF-SWAP-${run}`))]);
await send(vault, d.swapEscrow, swapEscrowAbi as Abi, "submitInspection", [swapId, 0, true, keccak256(toBytes("swap report"))]);
const swap = await pub.readContract({ address: d.swapEscrow, abi: swapEscrowAbi, functionName: "getSwap", args: [swapId] });
assert(swap.status === 6, `swap completed (status ${swap.status})`);
const [ownA, ownB] = await Promise.all([
  pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabA)] }),
  pub.readContract({ address: d.nft, abi: vaultCardNFTAbi, functionName: "ownerOf", args: [BigInt(slabB)] }),
]);
assert(ownA.toLowerCase() === seller.address.toLowerCase() && ownB.toLowerCase() === buyer.address.toLowerCase(), "cards swapped");
const buyerSwapCredit = (await pub.readContract({ address: d.swapEscrow, abi: swapEscrowAbi, functionName: "credits", args: [buyer.address] })) as bigint;
const expectedBuyer = swap.depositUsd - fairB / 100n + (topUpFrom === 2 ? topUpUsd : 0n);
assert(buyerSwapCredit === expectedBuyer, `buyer credit ${buyerSwapCredit} == deposit − 1% of Venusaur + top-up received ${expectedBuyer}`);
ok("buyer's slab inspected → swap Completed: buyer owns the Venusaur NFT, seller owns a newly minted Blastoise NFT, top-up settled");

await waitFor("swap indexed as Completed", async () => (await getJson<{ status: string }>(`/swaps/${swapId}`)).status === "Completed");
ok("indexer shows the swap as Completed");

console.log("\nE2E on HSK testnet passed.");
