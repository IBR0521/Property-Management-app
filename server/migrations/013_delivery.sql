/* Delivery: retry, dead letters, provider receipts and consent.

   The outbox has carried `attempts` and `last_error` since 001 and nothing
   ever wrote to them, because nothing ever sent anything. Turning delivery on
   makes four things necessary that a queue-only design never needed.

   A message needs to know when to try again. Retrying on every tick is how a
   provider outage becomes a rate-limit ban; `next_attempt_at` spaces them out.

   A message needs somewhere to stop. Five failures is not a transient problem,
   it is a wrong address or a blocked number, and a queue that retries forever
   is a queue nobody reads. `dead` is that terminus, and it is visible.

   A message needs a receipt. The provider's own id is the only thing that ties
   our row to their delivery record, and without it a bounce webhook has
   nothing to attach to.

   And an address needs to be able to say no. There is no consent storage in
   this schema at all today — `outbox.status` has had a `suppressed` value
   since 001 that nothing has ever set. Sending SMS after somebody replies STOP
   is a TCPA problem, not a missing feature. */

-- --- the outbox learns to retry -------------------------------------------

ALTER TABLE outbox ADD COLUMN provider            TEXT;
ALTER TABLE outbox ADD COLUMN provider_message_id TEXT;
ALTER TABLE outbox ADD COLUMN next_attempt_at     TEXT;
ALTER TABLE outbox ADD COLUMN failed_at           TEXT;

/* Transactional mail cannot be unsubscribed from: a rent notice or an
   emergency alert is not marketing, and letting somebody opt out of it would
   break the thing the notice exists to do. Informational mail can be. The
   producer decides, because only the producer knows what it is sending. */
ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'transactional'
  CHECK (kind IN ('transactional', 'informational'));

/* 'dead' joins the existing states. Dropped by lookup rather than by name,
   because the name is whatever Postgres generated when 001 ran. */
DO $$
DECLARE cn TEXT;
BEGIN
  SELECT conname INTO cn
    FROM pg_constraint
   WHERE conrelid = 'outbox'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%queued%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE outbox DROP CONSTRAINT %I', cn);
  END IF;
END $$;

ALTER TABLE outbox ADD CONSTRAINT outbox_status_check
  CHECK (status IN ('queued', 'sent', 'failed', 'suppressed', 'dead'));

/* The drainer's working query: queued, and due. Partial, because sent rows are
   the overwhelming majority and none of them are ever selected this way. */
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at, queued_at)
  WHERE status = 'queued';

CREATE INDEX outbox_dead_idx ON outbox (company_id, failed_at)
  WHERE status = 'dead';

-- --- what the provider tells us afterwards ---------------------------------

/* Delivery is not the end of the story. A provider accepts a message, then
   minutes or days later reports it delivered, bounced or marked as spam, and
   those later facts are the ones that matter: continuing to send to a hard
   bounce is how a sending domain gets blocked.

   company_id is nullable here and nowhere else. A webhook arrives identified
   only by the provider's own ids, so the company is not known until the event
   is matched to an outbox row — and an unmatched event must still be stored,
   because an event you threw away is one you cannot explain later. */
CREATE TABLE delivery_event (
  id                TEXT PRIMARY KEY,
  company_id        TEXT REFERENCES company(id) ON DELETE CASCADE,
  outbox_id         TEXT REFERENCES outbox(id) ON DELETE SET NULL,
  provider          TEXT NOT NULL,
  -- The provider's id for this delivery attempt, not for the message.
  provider_event_id TEXT NOT NULL,
  kind              TEXT NOT NULL,
  -- The address the event is about, so a bounce can suppress it even when the
  -- outbox row has since been deleted.
  contact           TEXT,
  detail            TEXT,
  received_at       TEXT NOT NULL,
  /* Idempotency. Providers deliver webhooks at least once and replay on any
     non-2xx, so the same event arrives repeatedly; this index is what makes
     that harmless. */
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX delivery_event_outbox_idx ON delivery_event (outbox_id);

-- --- consent ---------------------------------------------------------------

/* One row per address per channel per company. Scoped to the company because
   consent is given to a business, not to a platform: a tenant opting out of
   one management company's texts has not opted out of another's. */
CREATE TABLE contact_consent (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  -- Normalised before storage: lower-cased email, digits-only phone.
  contact      TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('granted', 'revoked', 'bounced', 'complained')),
  -- How we learned it, so a dispute can be answered.
  source       TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (company_id, channel, contact)
);

CREATE INDEX contact_consent_lookup_idx ON contact_consent (company_id, channel, contact, state);

-- --- who the mail is from --------------------------------------------------

/* Per company, because this is multi-company software and mail from a
   property manager must come from that manager. Null falls back to the
   platform defaults in config. */
ALTER TABLE company ADD COLUMN from_email TEXT;
ALTER TABLE company ADD COLUMN from_name  TEXT;
ALTER TABLE company ADD COLUMN reply_to   TEXT;
ALTER TABLE company ADD COLUMN sms_from   TEXT;
