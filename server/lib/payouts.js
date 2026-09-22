/* Paying owners and vendors.

   The money still never passes through this platform. A run produces a file
   the company uploads to their own bank, or cheques they print on their own
   stock, and records what was issued. The bank moves the funds. This
   orchestrates and records; it is never the custodian.

   Three things shape the code.

   **Assembling is not approving.** A draft can be built, looked at, argued
   over and thrown away. Approval is the moment money is committed: it posts
   the journals, takes the cheque numbers, freezes the file and cannot be
   undone. The two are separate because in a company of any size they are two
   people, and because a run assembled on Thursday is approved on Friday
   against balances that have moved.

   **The file is frozen at approval.** Regenerating it later against changed
   data would produce something that disagrees with what the bank already
   has, and the bank's copy is the one that matters.

   **The compliance barrier applies here like everywhere else.** A contractor
   with lapsed workers' compensation cannot be paid. It is not reimplemented:
   `complianceState` decides who is excluded from a draft with a reason a
   person can read, and `assertPayable` is the gate at approval, so a vendor
   whose certificate expired between the two is caught by the second. */
import { all, get, one, insert, update, run, tx } from "./db.js";
import { id } from "./ids.js";
import { stamp, today } from "./dates.js";
import { seal, tryOpen, sha256 } from "./crypto.js";
import { log } from "./logger.js";
import { buildFile, fileName as achFileName, validRoutingNumber } from "./nacha.js";
import { buildChecks, positivePayCsv, checkFileName } from "./checks.js";

/* --- who is owed what ------------------------------------------------------ */

/* An owner's position: everything on their ledger, less anything already
   committed to them in a run that has not yet been issued.

   Computed from the ledger rather than held as a balance, for the same reason
   every other balance here is: a stored one drifts, and the one nobody is
   looking at is the one that is wrong. */
export async function ownerBalances(companyId, { asOf = today() } = {}) {
  const rows = await all(
    `SELECT o.id, o.name, o.email,
            COALESCE(SUM(e.amount_cents), 0)::bigint AS balance_cents
       FROM owner o
       LEFT JOIN ledger_entry e ON e.owner_id = o.id AND e.date <= ?
      WHERE o.company_id = ?
      GROUP BY o.id, o.name, o.email
      ORDER BY o.name`, asOf, companyId);

  const committed = await all(
    `SELECT i.owner_id, COALESCE(SUM(i.amount_cents), 0)::bigint AS c
       FROM payout_item i JOIN payout_batch b ON b.id = i.batch_id
      WHERE i.company_id = ? AND i.owner_id IS NOT NULL
        AND i.voided_at IS NULL AND b.status IN ('draft', 'approved')
      GROUP BY i.owner_id`, companyId);
  const pending = new Map(committed.map((r) => [r.owner_id, Number(r.c)]));

  const accounts = await payeeAccounts(companyId);

  return rows.map((r) => {
    const balance = Number(r.balance_cents);
    const inFlight = pending.get(r.id) || 0;
    return {
      ownerId: r.id, name: r.name, email: r.email,
      balanceCents: balance,
      pendingCents: inFlight,
      distributableCents: Math.max(0, balance - inFlight),
      account: accounts.owner.get(r.id) || null,
    };
  });
}

/* Vendor invoices approved and not yet paid, with the compliance verdict
   attached rather than applied. The draft shows a blocked contractor and says
   why, because a manager who cannot see the excluded invoice assumes it was
   missed. */
export async function vendorPayables(companyId, { asOf = today() } = {}) {
  const { complianceState } = await import("../features/vendors.js");

  const rows = await all(
    `SELECT vi.*, v.name AS vendor_name, v.wc_expires, v.wc_exempt, v.gl_expires,
            v.license_expires, v.payout_hold, v.payout_hold_reason, v.onboarding_state
       FROM vendor_invoice vi JOIN vendor v ON v.id = vi.vendor_id
      WHERE vi.company_id = ? AND vi.status = 'approved'
      ORDER BY vi.due_date NULLS LAST, vi.invoice_date`, companyId);

  const committed = await all(
    `SELECT i.invoice_id, 1 AS taken FROM payout_item i
       JOIN payout_batch b ON b.id = i.batch_id
      WHERE i.company_id = ? AND i.invoice_id IS NOT NULL
        AND i.voided_at IS NULL AND b.status IN ('draft', 'approved')`, companyId);
  const taken = new Set(committed.map((r) => r.invoice_id));

  const accounts = await payeeAccounts(companyId);

  return rows.map((r) => {
    const state = complianceState(r, asOf);
    return {
      invoiceId: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name,
      invoiceNo: r.invoice_no, invoiceDate: r.invoice_date, dueDate: r.due_date,
      amountCents: Number(r.amount_cents) + Number(r.tax_cents),
      memo: r.memo,
      alreadyInARun: taken.has(r.id),
      payable: state.canBePaid,
      blockedReasons: state.payoutReasons,
      account: accounts.vendor.get(r.vendor_id) || null,
    };
  });
}

async function payeeAccounts(companyId) {
  const rows = await all("SELECT * FROM payee_account WHERE company_id = ?", companyId);
  const owner = new Map();
  const vendor = new Map();
  for (const r of rows) {
    const account = {
      id: r.id, method: r.method, routingNumber: r.routing_number,
      accountLast4: r.account_last4, accountType: r.account_type,
      accountName: r.account_name, mailTo: r.mail_to,
      verifiedAt: r.verified_at,
    };
    if (r.owner_id) owner.set(r.owner_id, account);
    if (r.vendor_id) vendor.set(r.vendor_id, account);
  }
  return { owner, vendor };
}

/* --- recording where money goes -------------------------------------------- */

export async function savePayeeAccount({
  companyId, ownerId = null, vendorId = null, method,
  routingNumber = null, accountNumber = null, accountType = "checking",
  accountName = null, mailTo = null,
}) {
  if (Boolean(ownerId) === Boolean(vendorId)) {
    throw new Error("An account belongs to an owner or to a contractor, not both and not neither.");
  }

  const existing = await get(
    ownerId
      ? "SELECT * FROM payee_account WHERE company_id = ? AND owner_id = ?"
      : "SELECT * FROM payee_account WHERE company_id = ? AND vendor_id = ?",
    companyId, ownerId || vendorId);

  if (method === "ach") {
    if (!validRoutingNumber(routingNumber)) {
      return { ok: false, reason: "That routing number's check digit does not match. It is almost always a typo." };
    }
    /* Required for a new account, and optional for an existing one: the form
       shows the last four and an empty box, so a blank means "unchanged"
       rather than "delete it". Demanding it every time would mean a change
       of postal address could not be saved without retyping the account
       number, which is how people end up keeping it in a spreadsheet. */
    if (!String(accountNumber || "").trim() && !existing?.account_enc) {
      return { ok: false, reason: "An account number is needed to pay by bank transfer." };
    }
  }

  const digits = String(accountNumber || "").replace(/\s/g, "");
  const patch = {
    method, account_type: accountType, account_name: accountName, mail_to: mailTo,
    routing_number: method === "ach" ? String(routingNumber).replace(/\D/g, "") : null,
    updated_at: stamp(),
  };

  /* Only rewrite the sealed number when a new one was supplied: the form
     shows the last four and an empty box, so saving a change of address must
     not wipe the account number. */
  if (digits) {
    patch.account_enc = seal(digits);
    patch.account_last4 = digits.slice(-4);
    /* A changed account is an unverified account. Any prenote sent against
       the old one proves nothing about the new one. */
    patch.verified_at = null;
    patch.prenote_sent_at = null;
  }

  if (existing) {
    await update("payee_account", existing.id, patch);
    return { ok: true, accountId: existing.id };
  }

  const accountId = id();
  await insert("payee_account", {
    id: accountId, company_id: companyId, owner_id: ownerId, vendor_id: vendorId,
    created_at: stamp(), ...patch,
  });
  return { ok: true, accountId };
}

/* --- assembling a run ------------------------------------------------------ */

export async function draftOwnerRun({
  companyId, effectiveDate, method = "ach", ownerIds = null,
  minimumCents = 0, createdBy = null, reference = null,
}) {
  const balances = await ownerBalances(companyId);
  const chosen = balances.filter((o) => {
    if (ownerIds && !ownerIds.includes(o.ownerId)) return false;
    if (o.distributableCents <= 0) return false;
    if (o.distributableCents < minimumCents) return false;
    /* A run of one method at a time. Mixing them in one batch would mean one
       file and one set of cheques from a single approval, which is two
       different things to hand to the bank. */
    return (o.account?.method || "check") === method;
  });

  if (chosen.length === 0) {
    return { ok: false, reason: `No owner is due a ${method === "ach" ? "bank transfer" : "cheque"} today.` };
  }

  const batchId = id();
  return await tx(async () => {
    await insert("payout_batch", {
      id: batchId, company_id: companyId, kind: "owner", method,
      effective_date: effectiveDate, reference, status: "draft",
      total_cents: chosen.reduce((n, o) => n + o.distributableCents, 0),
      item_count: chosen.length,
      created_by: createdBy, created_at: stamp(),
    });

    for (const o of chosen) {
      await insert("payout_item", {
        id: id(), company_id: companyId, batch_id: batchId, owner_id: o.ownerId,
        payee_name: o.account?.accountName || o.name,
        routing_number: o.account?.routingNumber || null,
        account_last4: o.account?.accountLast4 || null,
        amount_cents: o.distributableCents,
        memo: `Owner distribution ${effectiveDate}`,
        detail: JSON.stringify({ balanceCents: o.balanceCents }),
        created_at: stamp(),
      });
    }

    return { ok: true, batchId, count: chosen.length };
  });
}

export async function draftVendorRun({
  companyId, effectiveDate, method = "check", invoiceIds = null,
  createdBy = null, reference = null,
}) {
  const payables = await vendorPayables(companyId, { asOf: effectiveDate });

  const chosen = payables.filter((p) => {
    if (invoiceIds && !invoiceIds.includes(p.invoiceId)) return false;
    if (p.alreadyInARun) return false;
    /* The barrier. A contractor with lapsed workers' compensation is left out
       here and refused again at approval, because a certificate can expire
       between the two. */
    if (!p.payable) return false;
    return (p.account?.method || "check") === method;
  });

  if (chosen.length === 0) {
    const blocked = payables.filter((p) => !p.payable).length;
    return {
      ok: false,
      reason: blocked
        ? `Nothing to pay. ${blocked} invoice${blocked === 1 ? " is" : "s are"} held by a compliance problem.`
        : "No approved invoice is waiting to be paid this way.",
    };
  }

  /* One cheque per vendor, not per invoice. A contractor with four jobs this
     month gets one cheque with four lines on the stub, which is what they
     expect and a quarter of the postage. */
  const byVendor = new Map();
  for (const p of chosen) {
    const bucket = byVendor.get(p.vendorId) || { vendor: p, invoices: [], total: 0 };
    bucket.invoices.push(p);
    bucket.total += p.amountCents;
    byVendor.set(p.vendorId, bucket);
  }

  const batchId = id();
  return await tx(async () => {
    await insert("payout_batch", {
      id: batchId, company_id: companyId, kind: "vendor", method,
      effective_date: effectiveDate, reference, status: "draft",
      total_cents: chosen.reduce((n, p) => n + p.amountCents, 0),
      item_count: byVendor.size,
      created_by: createdBy, created_at: stamp(),
    });

    for (const bucket of byVendor.values()) {
      const v = bucket.vendor;
      await insert("payout_item", {
        id: id(), company_id: companyId, batch_id: batchId,
        vendor_id: v.vendorId,
        /* The first invoice, for a single-invoice cheque. Several invoices
           are named on the stub instead, and the detail carries them all. */
        invoice_id: bucket.invoices.length === 1 ? bucket.invoices[0].invoiceId : null,
        payee_name: v.account?.accountName || v.vendorName,
        routing_number: v.account?.routingNumber || null,
        account_last4: v.account?.accountLast4 || null,
        amount_cents: bucket.total,
        memo: bucket.invoices.length === 1
          ? `Invoice ${bucket.invoices[0].invoiceNo || ""}`.trim()
          : `${bucket.invoices.length} invoices`,
        detail: JSON.stringify({
          invoiceIds: bucket.invoices.map((i) => i.invoiceId),
          lines: bucket.invoices.map((i) => ({
            label: `Invoice ${i.invoiceNo || i.invoiceId.slice(-6)}`,
            amountCents: i.amountCents,
          })),
        }),
        created_at: stamp(),
      });
    }

    return { ok: true, batchId, count: byVendor.size, excluded: payables.filter((p) => !p.payable) };
  });
}

/* --- approving -------------------------------------------------------------

   The moment money is committed. Everything here happens in one transaction:
   the journals, the cheque numbers, the file. A run that posted its journals
   and then failed to produce a file would have taken money off the books that
   nobody was asked to pay. */
export async function approveBatch({ batchId, companyId, by, layout = {} }) {
  const batch = await one(
    "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", batchId, companyId);
  if (batch.status !== "draft") {
    return { ok: false, reason: `That run is already ${batch.status}.` };
  }

  const items = await all(
    "SELECT * FROM payout_item WHERE batch_id = ? AND voided_at IS NULL ORDER BY payee_name", batchId);
  if (items.length === 0) return { ok: false, reason: "That run has nothing in it." };

  const company = await one("SELECT * FROM company WHERE id = ?", companyId);

  /* The barrier again, at the moment it matters. A certificate that expired
     between assembling the run and approving it is caught here, and the whole
     run stops rather than one payment slipping through. */
  const { assertPayable } = await import("../features/vendors.js");
  for (const item of items) {
    if (item.vendor_id) {
      try {
        await assertPayable(item.vendor_id, companyId, batch.effective_date);
      } catch (err) {
        return { ok: false, reason: `${item.payee_name}: ${err.message}` };
      }
    }
  }

  if (batch.method === "ach") {
    const problem = achReadiness(company, items);
    if (problem) return { ok: false, reason: problem };
  }

  return await tx(async () => {
    /* Cheque numbers, taken now and never reused. The register row is locked
       for the length of the transaction, so two runs approved at the same
       moment cannot take the same numbers. */
    let nextNumber = null;
    if (batch.method === "check") {
      const register = await get(
        "SELECT * FROM check_register WHERE company_id = ? FOR UPDATE", companyId);
      if (!register) {
        await insert("check_register", {
          company_id: companyId, next_number: 1001, updated_at: stamp(),
        });
        nextNumber = 1001;
      } else {
        nextNumber = Number(register.next_number);
      }
    }

    const priced = [];
    for (const item of items) {
      const checkNumber = batch.method === "check" ? nextNumber++ : null;
      if (checkNumber) await update("payout_item", item.id, { check_number: checkNumber });
      priced.push({ ...item, check_number: checkNumber });
    }

    if (batch.method === "check") {
      await run(
        "UPDATE check_register SET next_number = ?, updated_at = ? WHERE company_id = ?",
        nextNumber, stamp(), companyId);
    }

    /* The books. An owner distribution reduces what is owed to them; a vendor
       payment settles a payable. Both take cash out. */
    for (const item of priced) {
      const journalId = await postPayoutJournal({ company, batch, item, by });
      await update("payout_item", item.id, { journal_id: journalId });
    }

    const file = await renderBatchFile({ company, batch, items: priced, layout });

    await update("payout_batch", batch.id, {
      status: "approved", approved_by: by, approved_at: stamp(),
      file_name: file.name, file_text: file.text ?? null,
      file_hash: file.text ? sha256(file.text) : null,
      total_cents: priced.reduce((n, i) => n + Number(i.amount_cents), 0),
      item_count: priced.length,
    });

    log.info("payout run approved", {
      batch: batch.id, kind: batch.kind, method: batch.method,
      items: priced.length, by,
    });

    return { ok: true, batchId: batch.id, file, items: priced };
  });
}

function achReadiness(company, items) {
  if (!company.ach_routing_number || !company.ach_account_enc) {
    return "Your own bank details are not on file. Add them before sending a bank transfer run.";
  }
  if (!validRoutingNumber(company.ach_routing_number)) {
    return "Your own routing number's check digit does not match. Correct it before sending a run.";
  }
  const missing = items.filter((i) => !i.routing_number || !i.account_last4);
  if (missing.length) {
    return `${missing.length} payee${missing.length === 1 ? " has" : "s have"} no bank details: `
      + `${missing.slice(0, 3).map((m) => m.payee_name).join(", ")}`
      + `${missing.length > 3 ? ", and others" : ""}.`;
  }
  const bad = items.filter((i) => !validRoutingNumber(i.routing_number));
  if (bad.length) {
    return `${bad.map((b) => b.payee_name).join(", ")}: the routing number's check digit does not match.`;
  }
  return null;
}

async function postPayoutJournal({ company, batch, item, by }) {
  const { postJournal, ACCT } = await import("../features/accounting.js");
  const amount = Number(item.amount_cents);

  const splits = batch.kind === "owner"
    ? [
        { code: ACCT.OWNER_FUNDS, debit: amount, ownerId: item.owner_id, memo: "distribution" },
        { code: ACCT.TRUST_CASH, credit: amount, memo: `${batch.method} ${item.check_number || ""}`.trim() },
      ]
    : [
        { code: ACCT.PAYABLE, debit: amount, vendorId: item.vendor_id, memo: "settling invoice" },
        { code: ACCT.CASH, credit: amount, memo: `${batch.method} ${item.check_number || ""}`.trim() },
      ];

  return await postJournal({
    companyId: company.id, date: batch.effective_date,
    memo: `${batch.kind === "owner" ? "Owner distribution" : "Contractor payment"} — ${item.payee_name}`,
    source: batch.kind === "owner" ? "owner" : "vendor",
    sourceType: "payout_item", sourceId: item.id, postedBy: by,
    splits,
  });
}

/* --- the files -------------------------------------------------------------- */

async function renderBatchFile({ company, batch, items, layout }) {
  if (batch.method === "ach") {
    const accountNumber = tryOpen(company.ach_account_enc);
    const entries = [];
    for (const item of items) {
      const account = await get(
        item.owner_id
          ? "SELECT * FROM payee_account WHERE company_id = ? AND owner_id = ?"
          : "SELECT * FROM payee_account WHERE company_id = ? AND vendor_id = ?",
        company.id, item.owner_id || item.vendor_id);

      entries.push({
        name: item.payee_name,
        routing: item.routing_number,
        account: tryOpen(account?.account_enc) || "",
        accountType: account?.account_type || "checking",
        amountCents: Number(item.amount_cents),
        reference: (item.id || "").slice(-15),
      });
    }

    const built = buildFile({
      entries,
      company: {
        name: company.name,
        id: company.ach_company_id || company.ach_routing_number,
        routing: company.ach_routing_number,
        account: accountNumber || "",
        accountType: company.ach_account_type,
      },
      bank: { routing: company.ach_routing_number, name: company.ach_bank_name || "BANK" },
      effectiveDate: batch.effective_date,
      /* PPD for individuals, CCD for businesses. Owners are usually people
         and contractors usually are not, which is the right default and a
         setting nobody should have to think about. */
      entryClass: batch.kind === "owner" ? "PPD" : "CCD",
      entryDescription: batch.kind === "owner" ? "OWNER DIST" : "AP PAYMENT",
      offsetEntry: Number(company.ach_balanced_file) === 1,
    });

    return {
      kind: "ach",
      name: achFileName({
        companyName: company.name, effectiveDate: batch.effective_date,
        kind: batch.kind === "owner" ? "owners" : "vendors",
      }),
      text: built.text,
      totals: built.totals,
    };
  }

  /* Cheques are a PDF, which is bytes rather than text, so they are rendered
     on demand from the frozen item rows rather than stored. The positive-pay
     CSV is the text that is frozen, because it is the one the bank gets. */
  const register = await get("SELECT * FROM check_register WHERE company_id = ?", company.id);
  const csv = positivePayCsv({
    cheques: items.map((i) => ({
      number: i.check_number, date: batch.effective_date,
      payee: i.payee_name, amountCents: Number(i.amount_cents),
    })),
    account: register?.account_number || "",
  });

  return {
    kind: "check",
    name: checkFileName({
      companyName: company.name, date: batch.effective_date,
      kind: "positive-pay", extension: "csv",
    }),
    text: csv,
  };
}

/* The printable cheques for an approved run, rendered from the frozen rows.
   Reprintable, because printers jam and the numbers must not move when they
   do. */
export async function renderChecks({ batchId, companyId, layout = {} }) {
  const batch = await one(
    "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", batchId, companyId);
  if (batch.method !== "check") throw new Error("That run is a bank transfer, not a cheque run.");
  if (batch.status === "draft") throw new Error("Approve the run before printing cheques.");

  const company = await one("SELECT * FROM company WHERE id = ?", companyId);
  const items = await all(
    "SELECT * FROM payout_item WHERE batch_id = ? AND voided_at IS NULL ORDER BY check_number", batchId);

  return await buildChecks({
    company,
    layout,
    cheques: items.map((i) => ({
      number: i.check_number,
      date: batch.effective_date,
      payee: i.payee_name,
      amountCents: Number(i.amount_cents),
      memo: i.memo,
      lines: parseDetail(i.detail).lines || [],
    })),
  });
}

function parseDetail(json) {
  try { return JSON.parse(json || "{}") || {}; } catch { return {}; }
}

/* --- unwinding -------------------------------------------------------------- */

export async function cancelBatch({ batchId, companyId, reason, by }) {
  const batch = await one(
    "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", batchId, companyId);

  /* An approved run has journals behind it and, if it is a bank transfer, a
     file that may already be with the bank. Undoing that is a reversal, not a
     cancellation, and it is a decision a person makes item by item. */
  if (batch.status !== "draft") {
    return {
      ok: false,
      reason: `That run was already ${batch.status}. Void the individual payments instead — `
        + `the cheque numbers have been used and the bank may already have the file.`,
    };
  }

  await update("payout_batch", batch.id, {
    status: "cancelled", cancelled_at: stamp(),
    cancel_reason: String(reason || "").slice(0, 300),
  });
  log.info("payout run cancelled", { batch: batch.id, by });
  return { ok: true };
}

/* A cheque that was printed and spoiled, or a payment pulled before the file
   went. The row stays and the number stays used — positive pay needs to know
   the number exists so the bank refuses it if it is presented. */
export async function voidItem({ itemId, companyId, reason, by }) {
  const item = await one(
    "SELECT * FROM payout_item WHERE id = ? AND company_id = ?", itemId, companyId);
  if (item.voided_at) return { ok: true, alreadyVoid: true };

  const batch = await one("SELECT * FROM payout_batch WHERE id = ?", item.batch_id);

  return await tx(async () => {
    /* The journal is reversed rather than deleted, because the ledger is
       append-only and the payment did happen on the books even though the
       cheque never reached anybody. */
    if (item.journal_id) {
      const { reverseJournal } = await import("../features/accounting.js");
      await reverseJournal(item.journal_id, {
        companyId, by: by || "void",
        memo: `Voided ${batch.method === "check" ? `cheque ${item.check_number}` : "payment"} — ${item.payee_name}`,
        date: today(),
      });
    }

    await update("payout_item", item.id, {
      voided_at: stamp(), void_reason: String(reason || "").slice(0, 300),
    });

    const remaining = await get(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents), 0)::bigint AS total
         FROM payout_item WHERE batch_id = ? AND voided_at IS NULL`, item.batch_id);
    await update("payout_batch", item.batch_id, {
      item_count: Number(remaining.n), total_cents: Number(remaining.total),
    });

    log.warn("payout item voided", { item: item.id, checkNumber: item.check_number, by });
    return { ok: true };
  });
}

export async function markIssued({ batchId, companyId, by }) {
  const batch = await one(
    "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", batchId, companyId);
  if (batch.status !== "approved") {
    return { ok: false, reason: `That run is ${batch.status}, not approved.` };
  }
  await update("payout_batch", batch.id, { status: "issued", issued_at: stamp() });
  log.info("payout run issued", { batch: batch.id, by });
  return { ok: true };
}
