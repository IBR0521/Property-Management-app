/* What a company gets when they ask for their data, table by table.

   ## Why this is a list and not a query

   "Everything with a company_id" is the obvious implementation and it is
   wrong twice over. It exports session tokens, password hashes and recovery
   codes — credentials, which are not records of anything — and it misses the
   child tables that carry no company_id at all: the splits under a journal,
   the signatures under a lease document, the photographs on a work order.
   Half the substance of a portfolio hangs off a parent.

   So every table in the database is named here with a decision attached, and
   a test fails when a migration adds one that nobody has decided about. That
   test is the point of the file. An export that silently stops being complete
   is worse than one that never existed, because the customer believes they
   have taken everything.

   ## The three decisions

   `by: "company"`   the table has a company_id; take those rows.
   `by: "parent"`    it does not; take the rows whose parent belongs to them.
   `skip: "..."`     it is not theirs to take, and the reason is written into
                     the README of every archive rather than only here.

   `redact` removes named columns from a table that is otherwise exported.
   Credentials and provider tokens, never figures: an amount is never
   withheld from the person whose money it is. */

export const TABLES = {
  /* --- the portfolio ------------------------------------------------------ */
  company: { by: "self", label: "The company record" },
  owner: { by: "company" },
  property: { by: "company" },
  unit: { by: "company" },
  tenant: { by: "company" },
  lease: { by: "company" },
  lease_tenant: { by: "parent", parent: "lease", on: "lease_id" },
  vendor: { by: "company" },

  /* --- maintenance -------------------------------------------------------- */
  work_order: { by: "company" },
  work_order_event: { by: "parent", parent: "work_order", on: "work_order_id" },
  work_order_photo: { by: "parent", parent: "work_order", on: "work_order_id" },
  work_order_part: { by: "company" },
  routing_rule: { by: "company" },
  compliance_rule: { by: "company" },
  turn: { by: "company" },
  turn_task: { by: "parent", parent: "turn", on: "turn_id" },
  turn_stage_event: { by: "parent", parent: "turn", on: "turn_id" },
  turn_photo: { by: "parent", parent: "turn", on: "turn_id" },

  /* --- leasing ------------------------------------------------------------ */
  listing: { by: "company" },
  listing_photo: { by: "parent", parent: "listing", on: "listing_id" },
  application: { by: "company" },
  application_check: { by: "parent", parent: "application", on: "application_id" },
  application_doc: { by: "parent", parent: "application", on: "application_id" },
  criteria_set: { by: "company" },
  lease_template: { by: "company" },
  lease_document: { by: "company" },
  lease_signature: { by: "parent", parent: "lease_document", on: "document_id" },
  renters_insurance: { by: "company" },

  /* Screening. All three are the company's own compliance trail and all three
     are here — what somebody consented to, what was read, and what notice was
     sent. `screening_request.report_path` points at a file that is deleted on
     the company's own retention schedule, and after that it is null, which is
     the honest state rather than a gap. The report itself is never in
     `files/`: see FILE_COLUMNS, which deliberately does not list it. */
  screening_consent: { by: "company" },
  screening_request: { by: "company" },
  /* No redaction needed and none possible: the notice is `rendered_body`, and
     any credit score that was part of the decision is in that prose rather
     than in a column. See 043. */
  adverse_action: { by: "company" },

  /* --- money -------------------------------------------------------------- */
  account: { by: "company" },
  journal: { by: "company" },
  journal_split: { by: "parent", parent: "journal", on: "journal_id" },
  ledger_entry: { by: "company" },
  obligation: { by: "company" },
  late_fee: { by: "company" },
  delinquency: { by: "company" },
  delinquency_step: { by: "company" },
  payment_promise: { by: "company" },
  owner_approval: { by: "company" },
  owner_statement: { by: "company" },
  trust_reconciliation: { by: "company" },
  vendor_invoice: { by: "company" },
  vendor_payout: { by: "company" },
  payout_batch: { by: "company" },
  payout_item: { by: "company" },
  check_register: { by: "company" },
  autopay: { by: "company" },
  tenant_payment: { by: "company" },
  subscription: { by: "company" },
  stripe_payout: { by: "company" },

  /* --- banking ------------------------------------------------------------ */
  /* The account itself, its name, its mask, its balance and every transaction
     under it are all here. The connection's access token is not: it is the
     platform's key to somebody else's bank, it is not a record of anything
     that happened, and it lives on the item rather than on the account. */
  bank_account: { by: "company" },
  bank_item: { by: "company", redact: ["access_token_enc"] },
  bank_txn: { by: "company" },
  bank_match: { by: "company" },
  payee_account: {
    by: "company",
    /* The last four digits stay, which is what a person uses to recognise an
       account. The full number and the routing number do not: a CSV in an
       email attachment is how those get used by somebody else. */
    redact: ["account_enc", "routing_number"],
  },
  tenant_payment_method: {
    by: "company",
    /* The token is the processor's, not the company's, and it does not work
       outside this platform. The label and last four are what a person needs
       to know which card this was. */
    redact: ["stripe_payment_method_id"],
  },

  /* --- people and messages ------------------------------------------------ */
  staff: {
    by: "company",
    /* A password hash is a credential. So is a TOTP secret — an exported one
       would still generate valid codes, which is the whole problem with it. */
    redact: ["password_hash", "totp_secret_enc", "totp_last_step"],
  },
  /* `on` is the column on this table; `parentKey` the column on the parent it
     matches. Everywhere else the parent is matched on its own id, and a
     person is the one record reached the other way round. */
  person: { by: "parent", parent: "person_link", on: "id", parentKey: "person_id" },
  person_link: { by: "company" },
  contact_consent: { by: "company" },
  thread: { by: "company" },
  thread_event: { by: "company" },
  message: { by: "company" },
  message_template: { by: "company" },
  notice_template: { by: "company" },
  notice_log: { by: "company" },
  outbox: { by: "company" },
  delivery_event: { by: "company" },
  push_subscription: {
    by: "company",
    /* The endpoint and the two keys together are the ability to push to
       somebody's browser. The record that a device was registered is theirs;
       the ability to send to it is not transferable anyway. */
    redact: ["endpoint", "p256dh", "auth"],
  },

  /* --- their own settings and history ------------------------------------- */
  setting: { by: "company" },
  saved_report: { by: "company" },
  report_schedule: { by: "company" },
  audit_log: { by: "company" },
  /* Where a company's data is sent, and every attempt to send it. Theirs:
     "did you send it" is a question they should be able to settle from their
     own export. The signing secret is not — it is a credential, and it is one
     we hold rather than one they chose. */
  webhook_endpoint: { by: "company", redact: ["secret"] },
  webhook_delivery: { by: "company" },

  api_key: {
    by: "company",
    /* The record that a key exists — what it is called, what it may do, when
       it was last used — is the company's and is here. The hash of the secret
       is not useful to anybody and is one step from a credential. */
    redact: ["secret_hash"],
  },
  api_request: { by: "company" },
  api_rate: {
    skip: "API rate-limiting counters. Platform machinery, scoped through the key, "
      + "and nothing happened in them.",
  },
  import_batch: {
    by: "company",
    /* The uploaded file itself, which is a copy of a spreadsheet they already
       have and is deleted a week after the import anyway. */
    redact: ["files"],
  },

  /* --- not theirs to take ------------------------------------------------- */
  session: { skip: "Sign-in sessions. A session is a credential, not a record." },
  portal_session: { skip: "Portal sign-in sessions, for the same reason." },
  portal_login_token: { skip: "One-time sign-in links, live or spent." },
  email_verification: { skip: "One-time verification tokens." },
  staff_invite: { skip: "Invitation tokens, which are sign-in links until they are used." },
  staff_recovery_code: { skip: "Two-factor recovery codes." },
  rate_hit: {
    skip: "Rate-limiting counters. Platform machinery, and nothing happened in them.",
  },
  job_run: { skip: "The platform's scheduler log, which covers every company at once." },
  schema_migration: { skip: "Which migrations this database has applied." },
  impersonation: {
    skip: "Support-access records. Kept and auditable, but they belong to the "
      + "platform's own accountability rather than to the company's data.",
  },
  stripe_event: { skip: "Raw webhook payloads from the payment processor." },
  connect_event: { skip: "Raw webhook payloads from the payment processor." },
  bank_webhook_event: { skip: "Raw webhook payloads from the banking provider." },
};

/* Where a file lives, so the archive can carry the bytes and not only a
   filename that means nothing outside this database. */
/* Uploads carried into the archive.

   `screening_request.report_path` is deliberately not here. A tenant
   screening report is somebody's credit file; the company has a retention
   rule that deletes it, and copying it into an archive that leaves the
   platform would quietly outlive that rule. The record that screening
   happened, what it said and what notice went out are all in `data/`. */
export const FILE_COLUMNS = [
  { table: "work_order_photo", column: "path", folder: "files/work-orders" },
  { table: "turn_photo", column: "path", folder: "files/turns" },
  { table: "listing_photo", column: "path", folder: "files/listings" },
  { table: "application_doc", column: "path", folder: "files/applications" },
  { table: "ledger_entry", column: "receipt_path", folder: "files/receipts" },
  { table: "vendor", column: "coi_path", folder: "files/vendor-insurance" },
  { table: "vendor_invoice", column: "doc_path", folder: "files/vendor-invoices" },
  { table: "renters_insurance", column: "doc_path", folder: "files/renters-insurance" },
  { table: "company", column: "logo_path", folder: "files" },
];

export const exported = () =>
  Object.entries(TABLES).filter(([, t]) => !t.skip).map(([name]) => name);

export const skipped = () =>
  Object.entries(TABLES).filter(([, t]) => t.skip).map(([name, t]) => ({ name, why: t.skip }));

/* Names in the database that this file has not decided about. Empty is the
   only acceptable answer and a test says so. */
export function undecided(tableNames) {
  return tableNames.filter((name) => !TABLES[name]);
}

/* And the other direction: a decision about a table that no longer exists is
   a decision nobody will notice has stopped applying. */
export function stale(tableNames) {
  const present = new Set(tableNames);
  return Object.keys(TABLES).filter((name) => !present.has(name));
}
