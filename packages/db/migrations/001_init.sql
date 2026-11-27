-- VaultChain schema. Money columns are USD numeric(14,2); on-chain amounts use 6 decimals.

CREATE TABLE IF NOT EXISTS cards (
  card_key     text PRIMARY KEY,           -- 0x… keccak256(canonical)
  canonical    text NOT NULL UNIQUE,       -- pokemon|base1|4/102|EN|holo|PSA|10
  name         text NOT NULL,
  set_name     text NOT NULL,
  number       text NOT NULL,
  language     text NOT NULL,
  variant      text NOT NULL DEFAULT '',
  grader       text NOT NULL,
  grade        text NOT NULL,
  image_url    text NOT NULL DEFAULT '',
  year         int,
  tracked      boolean NOT NULL DEFAULT true,  -- price indexer collects this card
  search_query text,                          -- override for marketplace searches
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Raw observations from every source. (source, external_id) dedupes re-scrapes.
CREATE TABLE IF NOT EXISTS price_samples (
  id             bigserial PRIMARY KEY,
  card_key       text NOT NULL REFERENCES cards(card_key),
  source         text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('sold','listing','reference')),
  external_id    text NOT NULL,
  price_usd      numeric(14,2) NOT NULL,
  original_price numeric(14,2),
  currency       text NOT NULL DEFAULT 'USD',
  title          text,
  url            text,
  observed_at    timestamptz NOT NULL,
  collected_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS price_samples_card_time ON price_samples (card_key, observed_at DESC);

-- Aggregated fair value history (one row per aggregation run).
CREATE TABLE IF NOT EXISTS price_points (
  id             bigserial PRIMARY KEY,
  card_key       text NOT NULL REFERENCES cards(card_key),
  fair_value_usd numeric(14,2) NOT NULL,
  volatility_bps int NOT NULL,
  sample_count   int NOT NULL,
  confidence     int NOT NULL,
  evidence_hash  text NOT NULL,
  evidence       jsonb NOT NULL,            -- sample ids + rejected ids, reproducible
  computed_at    timestamptz NOT NULL DEFAULT now(),
  published_tx   text,
  published_at   timestamptz
);
CREATE INDEX IF NOT EXISTS price_points_card_time ON price_points (card_key, computed_at DESC);

-- Off-chain marketplace objects (on-chain state is authoritative for settlement).
CREATE TABLE IF NOT EXISTS listings (
  id            text PRIMARY KEY,
  type          text NOT NULL CHECK (type IN ('vault','escrow')),
  slab_id       text NOT NULL,
  token_id      text,
  card_key      text NOT NULL REFERENCES cards(card_key),
  cert_number   text NOT NULL,
  seller        text NOT NULL,
  price_usd     numeric(14,2) NOT NULL,
  accepts_swap  boolean NOT NULL DEFAULT false,
  swap_wants    text,
  images        jsonb NOT NULL DEFAULT '[]',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','sold','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listings_active ON listings (status, card_key);

CREATE TABLE IF NOT EXISTS offers (
  id          text PRIMARY KEY,
  listing_id  text NOT NULL REFERENCES listings(id),
  buyer       text NOT NULL,
  price_usd   numeric(14,2) NOT NULL,
  counter_usd numeric(14,2),
  status      text NOT NULL DEFAULT 'open',
  via_agent   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Escrow order / swap terms signed by one side, waiting for the counterparty's signature.
CREATE TABLE IF NOT EXISTS proposals (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('order','swap')),
  proposer    text NOT NULL,
  counterparty text NOT NULL,
  terms       jsonb NOT NULL,               -- OrderTerms | SwapTerms (bigints as strings)
  proposer_sig text NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Indexed from chain events.
CREATE TABLE IF NOT EXISTS orders (
  order_id     text PRIMARY KEY,
  buyer        text NOT NULL,
  seller       text NOT NULL,
  card_key     text,
  slab_id      text NOT NULL,
  price_usd    numeric(14,2) NOT NULL,
  deposit_usd  numeric(14,2) NOT NULL,
  status       text NOT NULL,
  deadline     timestamptz,
  fulfillment  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS swaps (
  swap_id      text PRIMARY KEY,
  party_a      text NOT NULL,
  party_b      text NOT NULL,
  slab_a       text NOT NULL,
  slab_b       text NOT NULL,
  card_key_a   text,
  card_key_b   text,
  deposit_usd  numeric(14,2) NOT NULL,
  top_up_usd   numeric(14,2) NOT NULL,
  top_up_from  int NOT NULL,
  status       text NOT NULL,
  leg_state    jsonb NOT NULL DEFAULT '["Pending","Pending"]',
  deadline     timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vault_swap_offers (
  offer_id     text PRIMARY KEY,
  maker        text NOT NULL,
  give_token   text NOT NULL,
  want_token   text,
  want_card_key text,
  top_up_usd   numeric(14,2) NOT NULL,
  maker_pays   boolean NOT NULL,
  expires_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS assets (
  token_id     text PRIMARY KEY,
  slab_id      text NOT NULL,
  card_key     text NOT NULL,
  owner        text NOT NULL,
  custody      text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_owner ON assets (owner);
CREATE TABLE IF NOT EXISTS chain_events (
  chain_id     int NOT NULL,
  tx_hash      text NOT NULL,
  log_index    int NOT NULL,
  block_number bigint NOT NULL,
  contract     text NOT NULL,
  event        text NOT NULL,
  ref_id       text,                       -- orderId / swapId / tokenId / offerId
  args         jsonb NOT NULL,
  block_time   timestamptz,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_ref ON chain_events (ref_id, block_number);

-- Slab registry: physical card intake (vault back office).
CREATE TABLE IF NOT EXISTS slabs (
  slab_id      text PRIMARY KEY,
  card_key     text NOT NULL REFERENCES cards(card_key),
  grader       text NOT NULL,
  cert_number  text NOT NULL,
  metadata     jsonb NOT NULL DEFAULT '{}',  -- PSA cert data, image hashes, location
  metadata_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grader, cert_number)
);

-- HSP payments the keeper must attribute on-chain after payment-finalized.
CREATE TABLE IF NOT EXISTS hsp_payments (
  payment_request_id text PRIMARY KEY,
  flow_id      text NOT NULL,
  target      text NOT NULL CHECK (target IN ('order','swap')),
  target_id    text NOT NULL,
  payer        text NOT NULL,
  amount_usd6  numeric(20,0) NOT NULL,
  status       text NOT NULL DEFAULT 'created',  -- created | finalized | recorded | failed
  hsp_order    jsonb,
  record_tx    text,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_state (
  key   text PRIMARY KEY,
  value text NOT NULL
);
