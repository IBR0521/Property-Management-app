/* Vacancy marketing, and the feed the aggregators crawl.

   A listing is deliberately a separate row from its unit rather than a set of
   flags on it. A unit is a fact about a building; a listing is a marketing
   claim with its own lifecycle, its own copy, and its own decision about
   whether it goes out to Zillow. Conflating them means every unit edit is a
   potential publication. */

CREATE TABLE listing (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,
  unit_id         TEXT NOT NULL UNIQUE REFERENCES unit(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','paused','leased')),
  headline        TEXT NOT NULL,
  description     TEXT,
  rent_cents      INTEGER NOT NULL,
  deposit_cents   INTEGER,
  available_date  TEXT,
  lease_months    INTEGER,
  pets            TEXT CHECK (pets IN ('none','cats','dogs','both','case_by_case')),
  smoking         INTEGER NOT NULL DEFAULT 0,
  laundry         TEXT,
  parking         TEXT,
  utilities_note  TEXT,
  virtual_tour_url TEXT,
  contact_name    TEXT,
  contact_phone   TEXT,
  contact_email   TEXT,
  /* Off by default. Publishing an address to every aggregator on the internet
     is a decision somebody makes on purpose, not a side effect of typing rent
     into a form. */
  syndicate       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX listing_feed_idx ON listing (company_id, status, syndicate);

CREATE TABLE listing_photo (
  id          TEXT PRIMARY KEY,
  listing_id  TEXT NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  caption     TEXT,
  rank        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE INDEX listing_photo_listing_idx ON listing_photo (listing_id, rank);
