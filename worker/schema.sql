
PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS ledger;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS genesis;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  pair_id TEXT NOT NULL UNIQUE,
  pair_status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK(pair_status IN ('ACTIVE','LOCKED')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  balance TEXT NOT NULL DEFAULT '0',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE genesis (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  tx_id TEXT NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL,
  total_supply TEXT NOT NULL,
  pair_proof TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(owner_user_id) REFERENCES users(id)
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id TEXT NOT NULL UNIQUE,
  tx_type TEXT NOT NULL CHECK(tx_type IN ('GENESIS','TRANSFER')),
  from_user_id INTEGER,
  to_user_id INTEGER NOT NULL,
  amount TEXT NOT NULL,
  memo TEXT,
  pair_proof TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(from_user_id) REFERENCES users(id),
  FOREIGN KEY(to_user_id) REFERENCES users(id)
);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  counterparty_user_id INTEGER,
  entry_type TEXT NOT NULL CHECK(entry_type IN ('CREDIT','DEBIT')),
  amount TEXT NOT NULL,
  balance_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(tx_id) REFERENCES transactions(tx_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(counterparty_user_id) REFERENCES users(id)
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_transactions_created ON transactions(created_at DESC);
CREATE INDEX idx_ledger_user_created ON ledger(user_id, created_at DESC);
