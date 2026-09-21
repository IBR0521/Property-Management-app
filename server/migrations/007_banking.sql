/* Bank feeds and reconciliation.

   Written against Plaid's shape because that is what the brief names, but the
   provider is a column rather than an assumption — the tables describe "an
   aggregator gave us transactions", which is true of every one of them.

   Access tokens are long-lived credentials to somebody's bank account. They are
   stored sealed (AES-256-GCM, see lib/crypto.js) so that a database dump, a
   leaked backup, or a read-only SQL injection yields ciphertext. The key lives
   in the environment and never in this database. */

CREATE TABLE bank_item (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'plaid' CHECK (provider IN ('plaid','manual')),
  institution_name  TEXT,
  institution_id    TEXT,
  -- Provider's own id for the link. Not secret, and needed to route webhooks.
  external_item_id  TEXT UNIQUE,
  -- Sealed. Never selected into a page, never logged.
  access_token_enc  TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','needs_reauth','disconnected','error')),
  -- Provider sync cursor, so each sync asks only for what changed.
  sync_cursor       TEXT,
  last_sync_at      TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  created_by        TEXT
);

CREATE TABLE bank_account (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL REFERENCES bank_item(id) ON DELETE CASCADE,
  external_id     TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  mask            TEXT,                       -- last four only; never the full number
  type            TEXT,
  subtype         TEXT,
  balance_cents   BIGINT,
  currency        TEXT NOT NULL DEFAULT 'USD',
  -- Which account in our own chart this bank account is the real-world half of.
  account_id      TEXT REFERENCES account(id),
  is_trust        INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);

CREATE TABLE bank_txn (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL REFERENCES bank_account(id) ON DELETE CASCADE,
  -- The aggregator's id. Unique so a replayed webhook cannot double-insert.
  external_id     TEXT NOT NULL UNIQUE,
  posted_date     TEXT NOT NULL,
  -- Positive is money in. Providers differ on sign; normalised on the way in.
  amount_cents    BIGINT NOT NULL,
  -- The raw clearing string, exactly as the bank sent it. This is what the
  -- matcher reads and what a human squints at, so it is never cleaned up.
  name_raw        TEXT NOT NULL,
  merchant        TEXT,
  category        TEXT,
  pending         INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'unmatched'
                  CHECK (state IN ('unmatched','matched','ignored')),
  created_at      TEXT NOT NULL
);

CREATE INDEX bank_txn_state_idx ON bank_txn (company_id, state, posted_date);
CREATE INDEX bank_txn_account_idx ON bank_txn (bank_account_id, posted_date);

CREATE TABLE bank_match (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  bank_txn_id   TEXT NOT NULL REFERENCES bank_txn(id) ON DELETE CASCADE,
  -- What it was matched against, by table name and id.
  target_type   TEXT NOT NULL CHECK (target_type IN ('ledger_entry','vendor_invoice','journal','delinquency')),
  target_id     TEXT NOT NULL,
  amount_cents  BIGINT NOT NULL,
  -- The journal this match posted, if it posted one.
  journal_id    TEXT REFERENCES journal(id),
  matched_by    TEXT,
  matched_at    TEXT NOT NULL,
  note          TEXT,
  UNIQUE (bank_txn_id, target_type, target_id)
);

/* Webhooks arrive more than once. The provider's delivery id is the idempotency
   key: seen it, do nothing. */
CREATE TABLE bank_webhook_event (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  kind          TEXT,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  outcome       TEXT,
  UNIQUE (provider, external_id)
);
