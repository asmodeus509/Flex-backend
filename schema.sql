
CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Client FLEX',
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','admin')),
  wallet_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_deposits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  transaction_reference TEXT NOT NULL,
  phone TEXT,
  sender_phone TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','refused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by BIGINT REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_deposits_user_tx
  ON wallet_deposits(user_id, transaction_reference);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deposit_id BIGINT REFERENCES wallet_deposits(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('credit','debit')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14,2) NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  game TEXT NOT NULL,
  pack TEXT NOT NULL,
  plan TEXT,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  uid TEXT,
  player_id TEXT,
  account_name TEXT,
  phone TEXT,
  customer_phone TEXT,
  customer_contact TEXT,
  referral TEXT,
  payment TEXT NOT NULL DEFAULT 'Wallet',
  payment_method TEXT NOT NULL DEFAULT 'Wallet',
  status TEXT NOT NULL DEFAULT 'En attente',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  moncash TEXT NOT NULL DEFAULT '',
  natcash TEXT NOT NULL DEFAULT '50956701079',
  whatsapp TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payment_settings(id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS games (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  image TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS game_packs (
  id BIGSERIAL PRIMARY KEY,
  game_id BIGINT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qty NUMERIC(14,2) NOT NULL DEFAULT 0,
  price NUMERIC(14,2) NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Plans',
  image TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  popular BOOLEAN NOT NULL DEFAULT FALSE,
  premium BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_media (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  home TEXT NOT NULL DEFAULT '',
  games JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO site_media(id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
