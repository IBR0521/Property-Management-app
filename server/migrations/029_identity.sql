/* Who a person is, as distinct from what they rent.

   `tenant` is a row per tenancy, not per human. The move-in path inserts a
   fresh one every time, so somebody who moves from unit 1 to unit 3 in the
   same building becomes two unrelated rows carrying the same name and the
   same email address. `owner` is the same shape: a counterparty on a set of
   properties rather than an identity.

   That is fine for a back office where staff look people up by unit, and
   fatal for a portal. "Several leases over time, and owners several
   properties, under one login" is a sentence this schema could not express,
   and building sign-in on top of `tenant` would hand a returning tenant a
   fresh empty portal with none of their history — worse than no portal.

   So: `person` is the human, `person_link` is what they hold, and the two
   existing tables keep meaning exactly what they meant. Nothing below changes
   an existing column or an existing query. */

-- --- the human --------------------------------------------------------------

/* Deliberately platform-level, and the only table here without a company_id.

   The same landlord really can own property managed by two companies on this
   platform, and making them hold two logins to read two statements is the
   kind of thing that makes people ring the office instead.

   What makes that safe is that this row holds almost nothing: an email, a
   name, a phone. No balances, no leases, no documents. Everything attached to
   a person is attached through `person_link`, which is scoped to a company,
   and every portal query goes through it. A person is never the scope of a
   query on its own. */
CREATE TABLE person (
  id            TEXT PRIMARY KEY,
  /* Lower-cased, and the identity itself: one address is one person, which is
     what makes "the same login" mean anything. */
  email         TEXT NOT NULL UNIQUE,
  name          TEXT,
  phone         TEXT,

  /* For an optional SMS code at sign-in. Verified separately from the email,
     because a phone number on a lease was typed by a member of staff and is
     not proof of anything until the person holding it proves it. */
  phone_verified_at TEXT,

  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

-- --- what they hold, and where ----------------------------------------------

/* One row per role a person holds in one company. A tenant with three
   tenancies over four years has three rows; a landlord with property under
   two managers has two.

   `revoked_at` rather than a delete: a former tenant losing portal access
   should not take their payment history with them, and a company needs to be
   able to answer "did they have access in March" a year later. */
CREATE TABLE person_link (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  role          TEXT NOT NULL CHECK (role IN ('tenant', 'owner')),
  tenant_id     TEXT REFERENCES tenant(id) ON DELETE CASCADE,
  owner_id      TEXT REFERENCES owner(id) ON DELETE CASCADE,

  /* How the link came to exist, so a support question about why somebody can
     see something has an answer. */
  source        TEXT NOT NULL DEFAULT 'backfill',

  created_at    TEXT NOT NULL,
  revoked_at    TEXT,
  revoked_by    TEXT,

  /* Exactly one of the two, matching the role. A link that claims to be a
     tenancy while pointing at an owner would be a portal showing the wrong
     person's money. */
  CONSTRAINT link_matches_its_role CHECK (
    (role = 'tenant' AND tenant_id IS NOT NULL AND owner_id IS NULL) OR
    (role = 'owner'  AND owner_id  IS NOT NULL AND tenant_id IS NULL)
  )
);

/* A person holds a given tenancy or portfolio once. */
CREATE UNIQUE INDEX person_link_tenant_idx ON person_link (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX person_link_owner_idx  ON person_link (owner_id)  WHERE owner_id IS NOT NULL;
CREATE INDEX person_link_person_idx ON person_link (person_id, company_id) WHERE revoked_at IS NULL;

-- --- being signed in --------------------------------------------------------

/* A separate table from `session`, which is staff.

   Widening that one is tempting and wrong. A staff session carries
   capabilities and a portal session carries records; the moment they share a
   table, one missing WHERE clause makes a tenant a member of staff. Different
   table, different cookie, different branch in the gate — so the mistake
   cannot be made by omission. */
CREATE TABLE portal_session (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,

  /* The company they are currently looking at. A person with links in two
     companies picks one; there is no merged view, and every query is scoped
     by this rather than by person_id. */
  company_id    TEXT REFERENCES company(id) ON DELETE CASCADE,

  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  last_seen_at  TEXT,
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX portal_session_person_idx ON portal_session (person_id);

-- --- signing in -------------------------------------------------------------

/* A magic link, or an SMS code.

   **Stored hashed.** Every other token in this application is stored in clear
   — a QR sticker, a pay link, a statement link — because each grants access
   to one record and is meant to live on a fridge door for a year. This one is
   different in kind: it authenticates *as a person* and creates a session. A
   database read should not hand somebody a login, so what is stored is a
   SHA-256 of the token and the plaintext exists only in the email. */
CREATE TABLE portal_login_token (
  id            TEXT PRIMARY KEY,
  person_id     TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,

  token_hash    TEXT NOT NULL UNIQUE,
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'sms')),

  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  /* Superseded when a newer one is issued, so a person who clicks "send it
     again" does not leave three working links in three emails. */
  invalidated_at TEXT,

  /* Kept to rate limit and to answer "who asked for this", not to display. */
  requested_ip  TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX portal_login_token_person_idx ON portal_login_token (person_id, created_at DESC);

-- --- backfill ---------------------------------------------------------------

/* Every tenant and owner with an email becomes a person, deduplicated on the
   lower-cased address. Rows without one get no person and keep working exactly
   as they do today — reachable by token, which is how they are reachable now.

   This is the first migration that *infers* something: that two rows sharing
   an address are one human. That is the right inference (an address is a
   login) and it is worth being explicit that it is an inference. */

INSERT INTO person (id, email, name, created_at)
SELECT
  translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_'),
  lower(trim(email)),
  min(name),
  now()::text
FROM (
  SELECT email, name FROM tenant WHERE email IS NOT NULL AND trim(email) <> ''
  UNION ALL
  SELECT email, name FROM owner  WHERE email IS NOT NULL AND trim(email) <> ''
) AS everyone
GROUP BY lower(trim(email));

INSERT INTO person_link (id, person_id, company_id, role, tenant_id, source, created_at)
SELECT
  translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_'),
  p.id, t.company_id, 'tenant', t.id, 'backfill', now()::text
FROM tenant t
JOIN person p ON p.email = lower(trim(t.email))
WHERE t.email IS NOT NULL AND trim(t.email) <> '';

INSERT INTO person_link (id, person_id, company_id, role, owner_id, source, created_at)
SELECT
  translate(encode(gen_random_bytes(18), 'base64'), '+/=', '-_'),
  p.id, o.company_id, 'owner', o.id, 'backfill', now()::text
FROM owner o
JOIN person p ON p.email = lower(trim(o.email))
WHERE o.email IS NOT NULL AND trim(o.email) <> '';

/* A phone on the person, where every row that named them agreed on one.
   Where they disagree, none is taken rather than one being picked. */
UPDATE person p SET phone = c.phone
FROM (
  SELECT lower(trim(email)) AS email, min(phone) AS phone
  FROM (
    SELECT email, phone FROM tenant WHERE email IS NOT NULL AND phone IS NOT NULL
    UNION ALL
    SELECT email, phone FROM owner  WHERE email IS NOT NULL AND phone IS NOT NULL
  ) AS phones
  GROUP BY lower(trim(email))
  HAVING count(DISTINCT phone) = 1
) AS c
WHERE p.email = c.email;
