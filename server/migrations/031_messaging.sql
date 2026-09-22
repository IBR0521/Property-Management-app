/* Two-way messaging: one shared inbox, threaded per person.

   The hard part is not storing messages. It is deciding, when something
   arrives, which conversation it belongs to — and the cost of guessing wrong
   is showing one tenant another tenant's correspondence.

   So the resolution order is by how certain each signal is, and the least
   certain of all is deliberately not used:

     1. a reply token in the address we sent from   certain
     2. In-Reply-To / References headers            near certain
     3. the sender's phone or email, plus an open
        thread with them inside a window            probable
     4. otherwise a new thread                      safe

   **Never by subject line.** "Re: Rent" from two different tenants is two
   conversations, and a subject match would merge them. That is the one rule
   here that exists to prevent a disclosure rather than an annoyance.

   Outbound goes through the existing `outbox`, so the delivery-honesty
   invariant holds without new machinery: a message reads as queued until the
   provider accepts it, and the inbox shows what the outbox says rather than
   what somebody hoped. */

-- --- a conversation ---------------------------------------------------------

CREATE TABLE thread (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  subject       TEXT,

  /* Who it is with. At most one of the three ids is set; `person_id` is the
     portal identity where we have one, and is independent of the others — a
     tenant has both a tenant_id and a person_id. `unknown` is a real and
     important state: somebody texted a number we own and we cannot say who
     they are. Dropping those would lose a tenant whose number changed. */
  party_type    TEXT NOT NULL DEFAULT 'unknown'
                CHECK (party_type IN ('tenant', 'owner', 'vendor', 'unknown')),
  tenant_id     TEXT REFERENCES tenant(id) ON DELETE SET NULL,
  owner_id      TEXT REFERENCES owner(id) ON DELETE SET NULL,
  vendor_id     TEXT REFERENCES vendor(id) ON DELETE SET NULL,
  person_id     TEXT REFERENCES person(id) ON DELETE SET NULL,

  /* What it is about, where that is known: a work order, a lease, an
     invoice. This is what "every message is attached to the relevant record"
     means — a conversation that started from a repair stays attached to it. */
  about_type    TEXT,
  about_id      TEXT,

  /* The far end, normalised the same way consent normalises. These are what
     rule 3 matches on. */
  contact_email TEXT,
  contact_phone TEXT,

  /* The token that makes rule 1 certain. Put in the reply-to address of every
     outbound email on this thread, so a reply lands here and nowhere else.
     Unique across the platform because it arrives with no other context. */
  reply_token   TEXT UNIQUE,

  /* open      somebody still has to do something
     waiting   replied to, waiting on them
     resolved  finished
     Reopened by an inbound message, always: a conversation the other person
     is still having is not resolved, whatever a member of staff decided. */
  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open', 'waiting', 'resolved')),
  assigned_to   TEXT REFERENCES staff(id) ON DELETE SET NULL,

  last_message_at   TEXT,
  last_direction    TEXT CHECK (last_direction IN ('in', 'out')),
  /* Cleared when a member of staff opens it. Drives the count in the nav. */
  unread            INTEGER NOT NULL DEFAULT 0,

  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT
);

CREATE INDEX thread_company_state_idx ON thread (company_id, state, last_message_at DESC);
CREATE INDEX thread_contact_idx ON thread (company_id, contact_email, contact_phone);
CREATE INDEX thread_about_idx ON thread (about_type, about_id);
CREATE INDEX thread_assigned_idx ON thread (company_id, assigned_to) WHERE state <> 'resolved';

-- --- one message ------------------------------------------------------------

CREATE TABLE message (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,

  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'portal', 'note')),

  subject       TEXT,
  body          TEXT NOT NULL,

  from_contact  TEXT,
  to_contact    TEXT,

  /* Exactly one author for anything we sent or a person typed. An inbound
     email from an address we cannot place has neither, which is correct. */
  author_staff_id  TEXT REFERENCES staff(id) ON DELETE SET NULL,
  author_person_id TEXT REFERENCES person(id) ON DELETE SET NULL,

  /* Outbound: the delivery record. The inbox reads its status rather than
     asserting one, which is the delivery-honesty rule applied here. A note
     has no outbox row because it was never sent anywhere. */
  outbox_id     TEXT REFERENCES outbox(id) ON DELETE SET NULL,

  /* Email threading. Kept verbatim; rule 2 matches on them. */
  message_id_header TEXT,
  in_reply_to       TEXT,

  /* The provider's id for an inbound message, so the same webhook delivered
     twice does not become two messages in the conversation. */
  provider_message_id TEXT,

  created_at    TEXT NOT NULL,

  UNIQUE (company_id, provider_message_id)
);

CREATE INDEX message_thread_idx ON message (thread_id, created_at);
CREATE INDEX message_in_reply_idx ON message (message_id_header) WHERE message_id_header IS NOT NULL;

-- --- what happened to the thread --------------------------------------------

/* Assignment, resolution, reopening. Separate from `message` because these are
   not things anybody said, and rendering "Dana assigned this to Marcus" as a
   message in a conversation a tenant can read would be a disclosure. */
CREATE TABLE thread_event (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  thread_id     TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
  at            TEXT NOT NULL,
  actor         TEXT,
  kind          TEXT NOT NULL,
  detail        TEXT
);

CREATE INDEX thread_event_thread_idx ON thread_event (thread_id, at);

-- --- linking outbound back ---------------------------------------------------

/* So a delivery webhook about an outbox row can find the message it belongs
   to without a scan. */
ALTER TABLE outbox ADD COLUMN message_id TEXT REFERENCES message(id) ON DELETE SET NULL;
CREATE INDEX outbox_message_idx ON outbox (message_id) WHERE message_id IS NOT NULL;
