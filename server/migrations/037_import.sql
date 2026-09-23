/* Bringing a portfolio in from somewhere else.

   ## Why every imported row remembers where it came from

   Somebody will upload the same file twice. Their browser will retry a POST
   that already succeeded; they will fix one row in a spreadsheet and upload
   the whole thing again; two people at the same company will each do it once.
   Without a way to recognise a row that is already here, the second upload
   creates a second portfolio and the first anybody hears of it is a rent roll
   with everything on it twice.

   So each imported row carries the source system and that system's own id for
   it, and the pair is unique per company. A second upload updates what is
   already there instead of duplicating it.

   `source_id` is whatever the other system called it — AppFolio's property id,
   a Buildium lease id, or, for a generic spreadsheet, whatever the person put
   in the id column. It is not trusted for anything except recognition.

   ## Why the batch is a row rather than a log line

   An import is the largest single act this application performs on somebody
   else's data, and "what did that import actually do" is a question asked
   afterwards, usually in a hurry. The batch holds what was uploaded, what was
   created, and what the dry run said before anybody committed — so the answer
   is a query rather than an archaeology exercise. */

CREATE TABLE import_batch (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES company(id) ON DELETE CASCADE,

  /* Which system the file came out of, so the column mapping and the
     source ids are interpreted the same way twice. */
  source_system  TEXT NOT NULL DEFAULT 'generic'
                 CHECK (source_system IN ('generic', 'appfolio', 'buildium',
                                          'doorloop', 'rentmanager')),

  /* draft   uploaded and validated, nothing written
     failed  validation found something and nothing was written
     done    committed, in one transaction */
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'failed', 'done')),

  file_name      TEXT,
  /* SHA-256 of the uploaded bytes. The same file uploaded twice is
     recognisable before a single row is parsed. */
  file_hash      TEXT,

  /* What the dry run said, kept whether or not it was committed. A preview
     nobody acted on is still the best record of what the file contained. */
  preview        TEXT,
  /* What the commit did, per table. */
  result         TEXT,
  error          TEXT,

  created_by     TEXT,
  created_at     TEXT NOT NULL,
  committed_at   TEXT
);

CREATE INDEX import_batch_company_idx ON import_batch (company_id, created_at DESC);

-- --- where each imported row came from ---------------------------------------

/* Nullable everywhere: everything already in these tables was created by a
   person and has no source, and a NOT NULL here would mean back-filling a
   fiction. */
ALTER TABLE owner    ADD COLUMN source_system TEXT, ADD COLUMN source_id TEXT;
ALTER TABLE property ADD COLUMN source_system TEXT, ADD COLUMN source_id TEXT;
ALTER TABLE unit     ADD COLUMN source_system TEXT, ADD COLUMN source_id TEXT;
ALTER TABLE tenant   ADD COLUMN source_system TEXT, ADD COLUMN source_id TEXT;
ALTER TABLE lease    ADD COLUMN source_system TEXT, ADD COLUMN source_id TEXT;
ALTER TABLE vendor   ADD COLUMN source_system TEXT, ADD COLUMN source_id TEXT;

/* Partial, so the millions of rows with no source cost nothing and do not
   collide with each other on NULL. The uniqueness is the whole idempotency
   guarantee, and it is in the database rather than in the importer for the
   same reason the rent charge's is: two uploads at once would both pass a
   check in code. */
CREATE UNIQUE INDEX owner_source_idx    ON owner    (company_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX property_source_idx ON property (company_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX unit_source_idx     ON unit     (company_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX tenant_source_idx   ON tenant   (company_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX lease_source_idx    ON lease    (company_id, source_system, source_id) WHERE source_id IS NOT NULL;
CREATE UNIQUE INDEX vendor_source_idx   ON vendor   (company_id, source_system, source_id) WHERE source_id IS NOT NULL;
