/* Web push subscriptions, and where a job was worked.

   A subscription is a capability to send to one device. It is not a secret we
   chose — the browser produced it — but it is worth protecting for the same
   reason a phone number is: it identifies a person's handset, and anybody
   holding it plus our VAPID private key could put a notification on their lock
   screen.

   The staff/person split is the same one portal sessions use, for the same
   reason: a technician and a tenant are different actors with different
   things to be told, and one column holding either would eventually send one
   the other's notification. */

CREATE TABLE push_subscription (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  /* Exactly one. A staff device or a portal device, never both. */
  staff_id      TEXT REFERENCES staff(id) ON DELETE CASCADE,
  person_id     TEXT REFERENCES person(id) ON DELETE CASCADE,

  /* The push service's URL for this device. Unique across the platform: the
     same browser resubscribing produces the same endpoint, and two rows for
     one device would mean two buzzes for one event. */
  endpoint      TEXT NOT NULL UNIQUE,
  /* The device's public key and auth secret, base64url as the browser gives
     them. Both are needed to encrypt; neither is useful alone. */
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,

  /* For a person deciding which of their devices to keep. */
  label         TEXT,
  user_agent    TEXT,

  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  /* Set when a push service says the subscription is gone. The row is deleted
     rather than kept — a dead endpoint has no history worth holding and
     keeping it would mean retrying it forever. */
  last_error    TEXT,
  failures      INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT subscription_belongs_to_one_actor CHECK (
    (staff_id IS NOT NULL AND person_id IS NULL) OR
    (staff_id IS NULL AND person_id IS NOT NULL)
  )
);

CREATE INDEX push_subscription_staff_idx ON push_subscription (staff_id) WHERE staff_id IS NOT NULL;
CREATE INDEX push_subscription_person_idx ON push_subscription (person_id) WHERE person_id IS NOT NULL;

-- --- working a job on a phone ------------------------------------------------

/* When somebody said they arrived and when they said they left.

   Deliberately a time and not a place. The obvious version of this captures
   GPS to prove the technician was where they said they were; that is staff
   surveillance, it needs a permission this application denies outright in its
   Permissions-Policy, and it is a decision for a company to make deliberately
   rather than one to inherit from a default. If location is ever wanted it is
   an addition with its own consent, not a column added quietly here. */
ALTER TABLE work_order ADD COLUMN checked_in_at   TEXT;
ALTER TABLE work_order ADD COLUMN checked_out_at  TEXT;
ALTER TABLE work_order ADD COLUMN checked_in_by   TEXT REFERENCES staff(id) ON DELETE SET NULL;

/* Parts and materials, as a line on the job. Free text and a cost: a parts
   catalogue is a different product, and a technician standing in a hallway
   wants to type "2m of 15mm copper, 14.60" rather than search one. */
CREATE TABLE work_order_part (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  work_order_id TEXT NOT NULL REFERENCES work_order(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  cost_cents    BIGINT NOT NULL DEFAULT 0,
  added_by      TEXT REFERENCES staff(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX work_order_part_idx ON work_order_part (work_order_id);
