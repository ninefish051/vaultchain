-- Listings: reserved while an on-chain order/swap is active; seller floor for the seller agent;
-- verification flag for escrow listings (PSA cert checked).
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE listings ADD CONSTRAINT listings_status_check CHECK (status IN ('active','reserved','sold','cancelled'));
ALTER TABLE listings ADD COLUMN IF NOT EXISTS floor_usd numeric(14,2);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS reserved_by text;   -- orderId / swapId
CREATE INDEX IF NOT EXISTS listings_slab ON listings (slab_id);

-- Shipping addresses, encrypted at rest (AES-256-GCM, key from Secrets Manager).
-- target: order | swap | redeem; target_id: orderId / swapId / tokenId.
CREATE TABLE IF NOT EXISTS shipping_addresses (
  target      text NOT NULL CHECK (target IN ('order','swap','redeem')),
  target_id   text NOT NULL,
  wallet      text NOT NULL,
  ciphertext  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target, target_id, wallet)
);
