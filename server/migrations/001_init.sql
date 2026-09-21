-- ===========================================================================
-- Property operations schema
-- ---------------------------------------------------------------------------
-- One data model behind all six features, because they are the same data seen
-- from different angles: a work order becomes an owner-statement line, a
-- move-out starts both a turn and a deposit-return clock, a lease end date is
-- a compliance obligation and a turn trigger.
--
-- Conventions:
--   * every tenant-scoped row carries company_id, so this can host more than
--     one management company without a migration
--   * money is INTEGER cents, never a float
--   * dates are TEXT in ISO form (YYYY-MM-DD, or full ISO for timestamps) so
--     they sort and compare correctly in SQLite
--
-- Deliberately absent: trust/escrow accounting and anything that moves funds.
-- ledger_entry below is a REPORTING ledger fed by import or manual entry. It
-- is not a system of record for client money and must not become one.
-- ===========================================================================

-- Postgres enforces foreign keys unconditionally, so the PRAGMA that SQLite
-- needed here is gone. Nothing else in this file is dialect-specific.

-- --- org -------------------------------------------------------------------

CREATE TABLE company (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  phone             TEXT,
  emergency_phone   TEXT,                      -- the after-hours number; see maintenance triage
  timezone          TEXT NOT NULL DEFAULT 'America/New_York',
  created_at        TEXT NOT NULL
);

CREATE TABLE setting (
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  value       TEXT,
  PRIMARY KEY (company_id, key)
);

CREATE TABLE staff (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,                -- scrypt, see lib/auth.js
  role           TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('admin','manager')),
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  UNIQUE (company_id, email)
);

CREATE TABLE session (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

-- --- portfolio -------------------------------------------------------------

CREATE TABLE owner (
  id                  TEXT PRIMARY KEY,
  company_id          TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  email               TEXT,
  phone               TEXT,
  -- Spend above this on a single repair needs the owner's sign-off before a
  -- vendor is dispatched. Drives owner_approval.
  approval_threshold_cents INTEGER NOT NULL DEFAULT 40000,
  statement_day       INTEGER NOT NULL DEFAULT 1,   -- day of month to generate
  notes               TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE property (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL REFERENCES owner(id),
  line1       TEXT NOT NULL,
  city        TEXT NOT NULL,
  state       TEXT NOT NULL,
  zip         TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','multi','condo')),
  year_built  INTEGER,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE unit (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  property_id        TEXT NOT NULL REFERENCES property(id) ON DELETE CASCADE,
  label              TEXT NOT NULL DEFAULT '',   -- '' for a single-family house
  beds               REAL,
  baths              REAL,
  sqft               INTEGER,
  market_rent_cents  INTEGER,
  status             TEXT NOT NULL DEFAULT 'vacant'
                     CHECK (status IN ('occupied','vacant','turn','offline')),
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_unit_property ON unit(property_id);

CREATE TABLE tenant (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE lease (
  id                   TEXT PRIMARY KEY,
  company_id           TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  unit_id              TEXT NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  start_date           TEXT NOT NULL,
  end_date             TEXT,
  rent_cents           INTEGER NOT NULL,
  deposit_cents        INTEGER NOT NULL DEFAULT 0,
  rent_due_day         INTEGER NOT NULL DEFAULT 1,
  grace_days           INTEGER NOT NULL DEFAULT 5,
  status               TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('pending','active','ended')),
  moveout_date         TEXT,                   -- set when keys come back; starts deposit clock
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_lease_unit ON lease(unit_id);
CREATE INDEX idx_lease_status ON lease(company_id, status);

CREATE TABLE lease_tenant (
  lease_id   TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  PRIMARY KEY (lease_id, tenant_id)
);

-- --- vendors and routing ---------------------------------------------------

CREATE TABLE vendor (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  trade       TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  after_hours INTEGER NOT NULL DEFAULT 0,       -- will they take an emergency call
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

-- Maintenance category -> vendor. Lowest rank wins; the next rank is the
-- fallback when the first vendor declines or cannot be reached.
CREATE TABLE routing_rule (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,
  vendor_id   TEXT NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  rank        INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, category, rank)
);

-- ===========================================================================
-- F1  Maintenance intake and triage
-- ===========================================================================

CREATE TABLE work_order (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  unit_id           TEXT NOT NULL REFERENCES unit(id),
  lease_id          TEXT REFERENCES lease(id),
  reference         TEXT NOT NULL,              -- short human handle, e.g. WO-4193
  category          TEXT NOT NULL,
  -- 'emergency' never waits in a queue: it is escalated to a phone call at
  -- intake. See features/maintenance.js.
  severity          TEXT NOT NULL DEFAULT 'normal'
                    CHECK (severity IN ('emergency','urgent','normal')),
  summary           TEXT NOT NULL,
  detail            TEXT,
  triage_answers    TEXT,                       -- JSON of the conditional intake questions
  reported_by_name  TEXT,
  reported_by_phone TEXT,
  reported_channel  TEXT NOT NULL DEFAULT 'web' CHECK (reported_channel IN ('web','phone','staff','email')),
  entry_permission  TEXT CHECK (entry_permission IN ('yes','no','call_first')),
  pets_note         TEXT,
  access_note       TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','triaged','awaiting_owner','assigned','scheduled','complete','cancelled')),
  vendor_id         TEXT REFERENCES vendor(id),
  scheduled_start   TEXT,
  scheduled_end     TEXT,
  estimate_cents    INTEGER,
  actual_cents      INTEGER,
  public_token      TEXT NOT NULL UNIQUE,       -- tenant status page, no login
  created_at        TEXT NOT NULL,
  closed_at         TEXT
);
CREATE INDEX idx_wo_company_status ON work_order(company_id, status);
CREATE INDEX idx_wo_unit ON work_order(unit_id);

CREATE TABLE work_order_photo (
  id             TEXT PRIMARY KEY,
  work_order_id  TEXT NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
  path           TEXT NOT NULL,
  phase          TEXT NOT NULL DEFAULT 'report' CHECK (phase IN ('report','progress','completion')),
  mime           TEXT,
  bytes          INTEGER,
  created_at     TEXT NOT NULL
);

-- Every state change, in order. This is both the audit trail and the source
-- for the tenant-facing status timeline, so a tenant never has to ring to ask.
CREATE TABLE work_order_event (
  id             TEXT PRIMARY KEY,
  work_order_id  TEXT NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
  at             TEXT NOT NULL,
  actor          TEXT NOT NULL,                 -- 'tenant', 'system', or a staff name
  kind           TEXT NOT NULL,
  note           TEXT,
  tenant_visible INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_woe_wo ON work_order_event(work_order_id, at);

-- ===========================================================================
-- F2  Owner communication
-- ===========================================================================

CREATE TABLE owner_approval (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  work_order_id  TEXT NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','approved','declined','expired')),
  token          TEXT NOT NULL UNIQUE,          -- one-click approve/decline, no login
  requested_at   TEXT NOT NULL,
  decided_at     TEXT,
  decided_note   TEXT
);

-- A reporting ledger, not an escrow ledger. Rows arrive by import from
-- whatever the company already uses for accounting, or by manual entry for
-- costs that originate here (a completed work order, say).
CREATE TABLE ledger_entry (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  owner_id       TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  property_id    TEXT REFERENCES property(id),
  unit_id        TEXT REFERENCES unit(id),
  lease_id       TEXT REFERENCES lease(id),
  date           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('rent_charge','rent_payment','expense','management_fee','deposit_held','deposit_returned','other')),
  amount_cents   INTEGER NOT NULL,              -- signed: money to the owner positive
  memo           TEXT,
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','work_order','system')),
  work_order_id  TEXT REFERENCES work_order(id),
  receipt_path   TEXT,                          -- attached receipts defuse markup suspicion
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_ledger_owner_date ON ledger_entry(owner_id, date);
CREATE INDEX idx_ledger_company_date ON ledger_entry(company_id, date);

CREATE TABLE owner_statement (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  owner_id      TEXT NOT NULL REFERENCES owner(id) ON DELETE CASCADE,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  totals        TEXT NOT NULL,                  -- JSON snapshot, so a sent statement never changes
  token         TEXT NOT NULL UNIQUE,           -- tokenised link; owners will not remember a password
  generated_at  TEXT NOT NULL,
  sent_at       TEXT,
  UNIQUE (owner_id, period_start, period_end)
);

-- ===========================================================================
-- F3  Compliance deadlines
-- ===========================================================================

-- The windows are the company's (or their attorney's) to state. This table
-- stores what they told us; it does not assert what any law requires.
CREATE TABLE compliance_rule (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN
                      ('deposit_return','lease_renewal_notice','registration_renewal',
                       'inspection','insurance_expiry','detector_check','custom')),
  label             TEXT NOT NULL,
  window_days       INTEGER NOT NULL,           -- days from the trigger to the deadline
  lead_days         TEXT NOT NULL DEFAULT '[30,7,0]',  -- JSON: when to nag
  authority_note    TEXT,                       -- "per ORC 5321.16, confirmed by counsel 2026-03"
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

CREATE TABLE obligation (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL REFERENCES compliance_rule(id) ON DELETE CASCADE,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('lease','unit','property','company')),
  subject_id    TEXT NOT NULL,
  trigger_date  TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','done','overdue','waived')),
  completed_at  TEXT,
  completed_by  TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (rule_id, subject_type, subject_id, trigger_date)
);
CREATE INDEX idx_obligation_due ON obligation(company_id, status, due_date);

-- ===========================================================================
-- F4  Rent status and the delinquency ladder
-- ===========================================================================

-- The rungs. day_offset counts from the day rent became late.
CREATE TABLE delinquency_step (
  id                TEXT PRIMARY KEY,
  company_id        TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  stage             INTEGER NOT NULL,
  day_offset        INTEGER NOT NULL,
  template_key      TEXT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms','post','hand')),
  requires_attorney INTEGER NOT NULL DEFAULT 0, -- stop here and hand it over
  UNIQUE (company_id, stage)
);

-- Bodies are supplied and approved by the company's attorney. We ship
-- placeholders and refuse to send an unapproved template.
CREATE TABLE notice_template (
  company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  body         TEXT NOT NULL,
  approved_by  TEXT,
  approved_at  TEXT,
  PRIMARY KEY (company_id, key)
);

CREATE TABLE delinquency (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  lease_id      TEXT NOT NULL REFERENCES lease(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,                  -- 'YYYY-MM' the rent was owed for
  late_since    TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  stage         INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','promised','resolved','attorney','waived')),
  opened_at     TEXT NOT NULL,
  resolved_at   TEXT,
  UNIQUE (lease_id, period)
);
CREATE INDEX idx_delinq_open ON delinquency(company_id, status);

-- Proof that every tenant got the same sequence. This is the point of the
-- feature: consistency is the defence.
CREATE TABLE notice_log (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  delinquency_id  TEXT NOT NULL REFERENCES delinquency(id) ON DELETE CASCADE,
  stage           INTEGER NOT NULL,
  template_key    TEXT NOT NULL,
  channel         TEXT NOT NULL,
  to_name         TEXT,
  to_contact      TEXT,
  rendered_body   TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  sent_by         TEXT NOT NULL
);

CREATE TABLE payment_promise (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  delinquency_id  TEXT NOT NULL REFERENCES delinquency(id) ON DELETE CASCADE,
  promised_date   TEXT NOT NULL,
  promised_cents  INTEGER NOT NULL,
  note            TEXT,
  kept            INTEGER,                      -- null until the date passes
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL
);

-- ===========================================================================
-- F5  Turn tracker
-- ===========================================================================

CREATE TABLE turn (
  id                 TEXT PRIMARY KEY,
  company_id         TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  unit_id            TEXT NOT NULL REFERENCES unit(id) ON DELETE CASCADE,
  lease_id           TEXT REFERENCES lease(id),  -- the outgoing lease
  stage              TEXT NOT NULL DEFAULT 'notice' CHECK (stage IN
                       ('notice','moveout','inspected','scoped','in_progress','ready','listed','applied','leased')),
  notice_date        TEXT,
  moveout_date       TEXT,
  target_ready_date  TEXT,
  ready_date         TEXT,
  listed_date        TEXT,
  leased_date        TEXT,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_turn_open ON turn(company_id, status);

-- Where the days actually went. One row per stage entered.
CREATE TABLE turn_stage_event (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  entered_at  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE turn_task (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  vendor_id   TEXT REFERENCES vendor(id),
  cost_cents  INTEGER,
  due_date    TEXT,
  done_at     TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);

-- Move-out and move-in photo record. Also the deposit-dispute defence.
CREATE TABLE turn_photo (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES turn(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('moveout','progress','movein')),
  room        TEXT,
  path        TEXT NOT NULL,
  mime        TEXT,
  bytes       INTEGER,
  created_at  TEXT NOT NULL
);

-- ===========================================================================
-- F6  Application intake
-- ---------------------------------------------------------------------------
-- Intake and a consistency record only. There is deliberately no score and no
-- automated decision: fair-housing rules vary by jurisdiction, and a scoring
-- model would both systematise and document any bias in the criteria. The
-- criteria belong to the company and are applied by a human, uniformly, with
-- the result recorded per item.
-- ===========================================================================

CREATE TABLE criteria_set (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  items         TEXT NOT NULL,                  -- JSON [{key,label,how_checked}]
  active        INTEGER NOT NULL DEFAULT 0,
  reviewed_by   TEXT,                           -- counsel sign-off
  reviewed_at   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE application (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  unit_id          TEXT REFERENCES unit(id),
  criteria_set_id  TEXT REFERENCES criteria_set(id),
  applicant_name   TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  desired_move_in  TEXT,
  occupants        INTEGER,
  monthly_income_cents INTEGER,
  employer         TEXT,
  notes            TEXT,
  status           TEXT NOT NULL DEFAULT 'received' CHECK (status IN
                     ('received','incomplete','screening','approved','declined','withdrawn')),
  received_at      TEXT NOT NULL,
  decided_at       TEXT,
  decided_by       TEXT,
  decision_reason  TEXT,
  token            TEXT NOT NULL UNIQUE,        -- applicant can add documents later
  UNIQUE (company_id, token)
);
CREATE INDEX idx_app_company_status ON application(company_id, status);

CREATE TABLE application_doc (
  id              TEXT PRIMARY KEY,
  application_id  TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  path            TEXT NOT NULL,
  mime            TEXT,
  bytes           INTEGER,
  created_at      TEXT NOT NULL
);

CREATE TABLE application_check (
  id                 TEXT PRIMARY KEY,
  application_id     TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
  criteria_item_key  TEXT NOT NULL,
  result             TEXT NOT NULL CHECK (result IN ('pass','fail','na','pending')),
  note               TEXT,
  checked_by         TEXT NOT NULL,
  checked_at         TEXT NOT NULL,
  UNIQUE (application_id, criteria_item_key)
);

-- ===========================================================================
-- Cross-cutting
-- ===========================================================================

-- Outbound messages, queued rather than sent inline, so a slow provider never
-- blocks a tenant submitting a request. The scheduler drains this.
CREATE TABLE outbox (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('email','sms')),
  to_contact   TEXT NOT NULL,
  subject      TEXT,
  body         TEXT NOT NULL,
  about_type   TEXT,
  about_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','suppressed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  queued_at    TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX idx_outbox_status ON outbox(status, queued_at);

CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   TEXT,
  action      TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_audit_company_at ON audit_log(company_id, at);
