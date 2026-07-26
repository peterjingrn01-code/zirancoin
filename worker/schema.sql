CREATE TABLE IF NOT EXISTS jule_coin_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jule_coin_wallets_email
ON jule_coin_wallets(email);

CREATE TABLE IF NOT EXISTS jule_coin_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  reason TEXT NOT NULL,
  external_reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'issued',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jule_coin_ledger_email
ON jule_coin_ledger(email);

CREATE INDEX IF NOT EXISTS idx_jule_coin_ledger_reference
ON jule_coin_ledger(external_reference);
