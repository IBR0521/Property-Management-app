/* Security deposits: taking one, returning one, and what comes out of it.

   ## The money is the journal, not the lease row

   `lease.deposit_cents` is what somebody typed when the tenancy was set up.
   What is *held* is `2100 Deposits held` for that lease, in the journal the
   trust reconciliation reads. Everything here works from the second one,
   because a return that disagreed with the books would be paying out money
   the books do not think exists.

   For most companies those two numbers are currently different, and that is
   the finding this file exists because of: the posting rules for
   `deposit_held` and `deposit_returned` have been in `ledger.js` since Phase
   1 and nothing has ever invoked them. `planConversion()` and
   `commitConversion()` at the bottom close that gap for a company that has
   been running without them.

   ## Every deduction credits the owner

       Dr 2100 Deposits held        the whole deposit stops being held
       Cr 1010 Trust cash           what goes back to the tenant
       Cr 2200 Owner funds held     every deduction

   A deduction for damage is not the manager's income. It reimburses whoever
   paid to put the damage right, which is the owner — and a management fee on
   that, if the agreement provides for one, is a separate posting somebody
   makes deliberately rather than something hidden inside a deposit return.

   Booking it as income would be the Phase 6 mistake again: an owner's money
   landing on the manager's books, invisible for months. Settled with the
   customer before this was written.

   ## Nothing here is a deadline this application invented

   `due_by` comes from the company's own `deposit_return` compliance rule,
   which is where their attorney's window lives. A company that has not
   written one gets a return with no deadline and a screen that says so,
   because asserting what a statute requires is the one thing the compliance
   feature has always refused to do. */
import { all, get, one, insert, run, tx } from "./db.js";
import { id } from "./ids.js";
import { stamp, today, addDays } from "./dates.js";
import { usd } from "./money.js";

export class DepositRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "DepositRefused";
  }
}

/* --- what is held ------------------------------------------------------------ */

/* From the journal, per lease. Credits minus debits on 2100, because it is a
   liability: a credit is money held. */
export async function heldFor(companyId, leaseId) {
  const row = await get(
    `SELECT COALESCE(SUM(s.credit_cents - s.debit_cents), 0)::bigint AS cents
       FROM journal_split s
       JOIN account a ON a.id = s.account_id
      WHERE a.company_id = ? AND a.code = '2100' AND s.lease_id = ?`,
    companyId, leaseId);
  return Number(row?.cents || 0);
}

/* Taking one. Through `postMoney`, like every other movement of somebody
   else's money, so the owner's statement and the journal are written together
   or not at all.

   A deposit is the tenant's money held, and it shows on the owner's statement
   because it is in the trust account the owner's funds are in — it is not
   income to them and the posting says so: `2100` is a liability to the
   tenant, not a credit to `2200`. */
export async function takeDeposit({
  companyId, leaseId, amountCents, date = today(), memo = null, by = "system",
}) {
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new DepositRefused("A deposit has to be a positive amount.");
  }

  const lease = await one(
    `SELECT l.*, u.property_id, p.owner_id
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE l.id = ? AND l.company_id = ?`, leaseId, companyId);

  const { postMoney } = await import("./ledger.js");
  return await postMoney({
    companyId, ownerId: lease.owner_id, propertyId: lease.property_id,
    unitId: lease.unit_id, leaseId: lease.id,
    date, kind: "deposit_held", amountCents: cents,
    memo: memo || "Security deposit received",
    source: "manual", sourceType: "deposit", sourceId: lease.id, postedBy: by,
  });
}

/* --- the return --------------------------------------------------------------- */

/* Opened when the tenancy ends. Reads what is held and what the company's own
   rule says the deadline is. */
export async function openReturn({
  companyId, leaseId, moveoutDate = null, by = "system", now = stamp,
}) {
  const lease = await one(
    "SELECT * FROM lease WHERE id = ? AND company_id = ?", leaseId, companyId);

  const existing = await get(
    "SELECT * FROM deposit_return WHERE lease_id = ? AND status = 'open'", leaseId);
  if (existing) return existing;

  const held = await heldFor(companyId, leaseId);
  const out = String(moveoutDate || lease.moveout_date || today()).slice(0, 10);

  /* The company's own window, and the basis they recorded for it. Null when
     they have not written one — this application does not supply a statutory
     deadline it was not given. */
  const rule = await get(
    `SELECT * FROM compliance_rule
      WHERE company_id = ? AND kind = 'deposit_return' AND active = 1
      ORDER BY created_at LIMIT 1`, companyId);

  const returnId = id();
  await insert("deposit_return", {
    id: returnId, company_id: companyId, lease_id: leaseId,
    held_cents: held,
    moveout_date: out,
    due_by: rule ? addDays(out, Number(rule.window_days)) : null,
    basis: rule ? (rule.authority_note || rule.label) : null,
    status: "open", opened_by: by, opened_at: now(),
  });

  return await one("SELECT * FROM deposit_return WHERE id = ?", returnId);
}

export async function addDeduction({
  companyId, returnId, reason, amountCents,
  workOrderId = null, inspectionItemId = null, by, now = stamp,
}) {
  const ret = await one(
    "SELECT * FROM deposit_return WHERE id = ? AND company_id = ?", returnId, companyId);
  if (ret.status !== "open") {
    throw new DepositRefused(
      "This return has already been settled. A deduction after the fact would change a "
      + "statement the tenant has already been given.");
  }

  const words = String(reason || "").trim();
  if (words.length < 3) {
    throw new DepositRefused(
      "Every deduction needs a reason in the words the tenant will read. Most states "
      + "require it in writing, and one without a reason cannot be defended.");
  }

  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new DepositRefused("A deduction has to be a positive amount.");
  }

  const already = await deductedFrom(returnId);
  /* Against what the books hold now, for the same reason the settlement uses
     it: a deposit posted after the return opened is still that tenant's. */
  const held = await heldFor(companyId, ret.lease_id);
  if (already + cents > held) {
    throw new DepositRefused(
      `Deductions would come to ${usd(already + cents)} against ${usd(held)} held. `
      + "A deposit cannot be overdrawn — anything beyond it is a debt to pursue separately, "
      + "not a deduction.");
  }

  const deductionId = id();
  await insert("deposit_deduction", {
    id: deductionId, company_id: companyId, return_id: returnId,
    reason: words, amount_cents: cents,
    work_order_id: workOrderId || null,
    inspection_item_id: inspectionItemId || null,
    created_by: by, created_at: now(),
  });
  return await one("SELECT * FROM deposit_deduction WHERE id = ?", deductionId);
}

export async function removeDeduction({ companyId, deductionId }) {
  const deduction = await one(
    "SELECT * FROM deposit_deduction WHERE id = ? AND company_id = ?", deductionId, companyId);
  const ret = await one("SELECT * FROM deposit_return WHERE id = ?", deduction.return_id);
  if (ret.status !== "open") {
    throw new DepositRefused("This return has been settled. Its deductions are part of the record.");
  }
  await run("DELETE FROM deposit_deduction WHERE id = ?", deductionId);
  return ret;
}

export async function deductedFrom(returnId) {
  const row = await get(
    "SELECT COALESCE(SUM(amount_cents), 0)::bigint AS cents FROM deposit_deduction WHERE return_id = ?",
    returnId);
  return Number(row?.cents || 0);
}

export async function deductionsFor(returnId) {
  return await all(
    `SELECT d.*, w.reference, w.summary AS work_order_summary,
            i.room AS inspection_room, i.label AS inspection_label,
            i.condition AS inspection_condition,
            b.condition AS inspection_before
       FROM deposit_deduction d
       LEFT JOIN work_order w ON w.id = d.work_order_id
       LEFT JOIN inspection_item i ON i.id = d.inspection_item_id
       LEFT JOIN inspection_item b ON b.id = i.compares_to
      WHERE d.return_id = ? ORDER BY d.created_at`, returnId);
}

/* The lines a move-out inspection found worse than the move-in, that have not
   been turned into a deduction yet.

   This is the join the inspection feature exists for. A deduction that says
   "carpet, second bedroom, good at move-in and damaged at move-out, with
   photographs of both" is a deduction that survives being disputed; one that
   says "damages" is not. */
export async function deductibleFrom({ companyId, returnId }) {
  const ret = await one(
    "SELECT * FROM deposit_return WHERE id = ? AND company_id = ?", returnId, companyId);

  const inspection = await get(
    `SELECT * FROM inspection
      WHERE company_id = ? AND lease_id = ? AND kind = 'moveout' AND status <> 'draft'
      ORDER BY performed_on DESC LIMIT 1`, companyId, ret.lease_id);
  if (!inspection) return { inspection: null, items: [] };

  const rows = await all(
    `SELECT i.*, b.condition AS before_condition, b.note AS before_note,
            (SELECT COUNT(*) FROM inspection_photo p WHERE p.item_id = i.id)::int AS photos,
            EXISTS (SELECT 1 FROM deposit_deduction d
                     WHERE d.inspection_item_id = i.id AND d.return_id = ?) AS taken
       FROM inspection_item i
       LEFT JOIN inspection_item b ON b.id = i.compares_to
      WHERE i.inspection_id = ?
      ORDER BY i.position`, returnId, inspection.id);

  const { worsened } = await import("./inspections.js");
  return {
    inspection,
    items: rows
      .filter((r) => worsened(r.before_condition, r.condition))
      .map((r) => ({ ...r, taken: Boolean(r.taken) })),
  };
}

/* Everything a return is, in one read, for the screen and for the
   itemisation. */
export async function returnDetail({ companyId, returnId }) {
  const ret = await one(
    `SELECT r.*, l.rent_cents, u.label, p.line1, p.city, p.state, p.zip, p.owner_id
       FROM deposit_return r
       JOIN lease l ON l.id = r.lease_id
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
      WHERE r.id = ? AND r.company_id = ?`, returnId, companyId);

  const deductions = await deductionsFor(returnId);
  const deducted = deductions.reduce((n, d) => n + Number(d.amount_cents), 0);

  /* What is held *now*, from the journal.

     `held_cents` on the row is what the books said when the return opened, and
     a deposit posted afterwards — by the conversion, or by somebody catching
     up — would leave it stale. Settling against a stale figure would release
     less than `2100` holds and leave the difference stranded there for ever.
     Once settled the row records what was actually released, so the history
     stays true. */
  const live = ret.status === "open"
    ? await heldFor(companyId, ret.lease_id)
    : Number(ret.held_cents);
  const tenants = await all(
    `SELECT t.name, t.email FROM lease_tenant lt JOIN tenant t ON t.id = lt.tenant_id
      WHERE lt.lease_id = ?`, ret.lease_id);

  return {
    ...ret,
    held_cents: live,
    openedWith: Number(ret.held_cents),
    deductions, deducted,
    balance: live - deducted,
    tenants,
    overdue: Boolean(ret.due_by && ret.status === "open" && today() > ret.due_by),
  };
}

/* --- settling ------------------------------------------------------------------ */

/* Posts once, freezes the itemisation, and returns the row.

       Dr 2100 Deposits held        the whole deposit
       Cr 1010 Trust cash           the balance going back
       Cr 2200 Owner funds held     every deduction

   The itemisation is rendered here and stored, and the outbox row that
   delivers it is recorded on the return — so nothing in this table claims a
   delivery the delivery system did not make. */
export async function settleReturn({
  companyId, returnId, date = today(), by, send = true, now = stamp,
}) {
  const detail = await returnDetail({ companyId, returnId });
  if (detail.status !== "open") {
    throw new DepositRefused("This return has already been settled.");
  }
  if (detail.balance < 0) {
    /* Cannot happen: `addDeduction` refuses it. Checked because posting a
       negative credit would silently invert the entry. */
    throw new DepositRefused("Deductions come to more than the deposit held.");
  }

  const { postJournal, ACCT } = await import("../features/accounting.js");
  const company = await one("SELECT * FROM company WHERE id = ?", companyId);
  const at = now();

  const splits = [];
  const dims = {
    leaseId: detail.lease_id, unitId: detail.unit_id,
    propertyId: detail.property_id, ownerId: detail.owner_id,
  };

  if (Number(detail.held_cents) > 0) {
    splits.push({
      code: ACCT.DEPOSITS_HELD, debit: Number(detail.held_cents), ...dims,
      memo: "deposit no longer held",
    });
  }
  if (detail.balance > 0) {
    splits.push({
      code: ACCT.TRUST_CASH, credit: detail.balance, ...dims,
      memo: "returned to the tenant",
    });
  }
  for (const deduction of detail.deductions) {
    splits.push({
      code: ACCT.OWNER_FUNDS, credit: Number(deduction.amount_cents), ...dims,
      /* Truncated, because a memo is a line on a statement rather than a
         paragraph. The full reason is on the deduction and in the
         itemisation. */
      memo: `deduction: ${deduction.reason}`.slice(0, 120),
    });
  }

  const itemisation = renderItemisation({ detail, company, date });
  let journalId = null;
  let outboxId = null;

  await tx(async () => {
    if (splits.length) {
      journalId = await postJournal({
        companyId, date,
        memo: `Deposit returned — ${detail.line1}${detail.label ? `, unit ${detail.label}` : ""}`,
        source: "owner", sourceType: "deposit_return", sourceId: returnId,
        postedBy: by, splits,
      });
    }

    const to = detail.tenants.find((t) => t.email)?.email || null;
    if (send && to) {
      outboxId = id();
      await insert("outbox", {
        id: outboxId, company_id: companyId, channel: "email", to_contact: to,
        subject: "Your security deposit",
        body: itemisation,
        about_type: "deposit_return", about_id: returnId,
        status: "queued", kind: "transactional", queued_at: at,
      });
    }

    await run(
      `UPDATE deposit_return
          SET status = 'settled', held_cents = ?, returned_cents = ?, journal_id = ?,
              itemisation = ?, itemisation_outbox_id = ?,
              settled_by = ?, settled_at = ?
        WHERE id = ?`,
      detail.held_cents, detail.balance, journalId, itemisation, outboxId,
      by, at, returnId);
  });

  return await one("SELECT * FROM deposit_return WHERE id = ?", returnId);
}

/* The statement the tenant is given.

   Plain text and plainly laid out, because the person reading it may be
   about to dispute it and the arithmetic should be checkable at a glance.
   Every deduction is listed with its reason — a lump sum labelled "damages"
   is the thing this is supposed to prevent. */
export function renderItemisation({ detail, company, date = today() }) {
  const lines = [];
  const where = `${detail.line1}${detail.label ? `, unit ${detail.label}` : ""}`;

  lines.push(`${company.name}`);
  lines.push(`Security deposit — ${where}`);
  lines.push(`Statement dated ${date}`);
  lines.push("");
  lines.push(`Tenancy ended ${detail.moveout_date}.`);
  lines.push("");
  lines.push(`Deposit held                 ${usd(detail.held_cents).padStart(14)}`);

  if (detail.deductions.length) {
    lines.push("");
    lines.push("Deductions");
    for (const d of detail.deductions) {
      lines.push(`  ${String(d.reason).slice(0, 44).padEnd(44)}${usd(d.amount_cents).padStart(12)}`);
      if (d.reference) lines.push(`    (repair ${d.reference})`);
      /* What the inspections were for. A tenant reading this can see which
         room, what it was when they moved in and what it was when they left,
         which is a far better answer than "damages". */
      if (d.inspection_label) {
        lines.push(`    ${d.inspection_room} — ${d.inspection_label}: `
          + `${conditionWord(d.inspection_before)} at move-in, `
          + `${conditionWord(d.inspection_condition)} at move-out`);
      }
    }
    lines.push(`  ${"".padEnd(44)}${"".padStart(12, "-")}`);
    lines.push(`  ${"Total deducted".padEnd(44)}${usd(detail.deducted).padStart(12)}`);
  } else {
    lines.push("");
    lines.push("No deductions have been made.");
  }

  lines.push("");
  lines.push(`Returned to you              ${usd(detail.balance).padStart(14)}`);
  lines.push("");

  if (detail.due_by) {
    lines.push(`This statement is due by ${detail.due_by}${detail.basis ? ` (${detail.basis})` : ""}.`);
    lines.push("");
  }
  lines.push("If you think any of this is wrong, please get in touch and say which line.");
  lines.push("");
  lines.push(company.name);
  if (company.phone) lines.push(company.phone);

  return lines.join("\n");
}

/* Plain words for a condition, without importing the inspections module into
   a rendering function that has no other reason to know about it. */
function conditionWord(key) {
  return ({
    good: "good", fair: "fair", poor: "poor",
    damaged: "damaged", not_present: "not there",
  })[key] || "not recorded";
}

/* --- the conversion ------------------------------------------------------------ */

/* Deposits recorded on leases and posted nowhere.

   Every company that has been running before this file existed has some: the
   number is on `lease.deposit_cents` and the books have never known about it,
   which is exactly what the trust reconciliation has been reporting as
   `deposits_vs_leases` every month.

   Same shape as `correct.js`: `plan()` says what it would do and `commit()`
   needs a confirmation string, because this posts journals against somebody
   else's books. */
export async function planConversion({ companyId = null } = {}) {
  const companies = companyId
    ? await all("SELECT id, name, books_closed_through FROM company WHERE id = ?", companyId)
    : await all("SELECT id, name, books_closed_through FROM company ORDER BY name");

  const out = [];
  for (const company of companies) {
    /* Active tenancies with a deposit on the row and nothing on 2100. A lease
       that has some of it posted is left alone: a partial posting is a
       question rather than a gap, and guessing at the difference is how a
       conversion makes things worse. */
    const rows = await all(
      `SELECT l.id, l.deposit_cents, u.label, u.property_id, p.line1, p.owner_id,
              COALESCE((SELECT SUM(s.credit_cents - s.debit_cents)
                          FROM journal_split s
                          JOIN account a ON a.id = s.account_id
                         WHERE a.company_id = l.company_id AND a.code = '2100'
                           AND s.lease_id = l.id), 0)::bigint AS posted
         FROM lease l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
        WHERE l.company_id = ? AND l.status = 'active' AND l.deposit_cents > 0
        ORDER BY p.line1, u.label`, company.id);

    const missing = rows.filter((r) => Number(r.posted) === 0);
    const partial = rows.filter((r) => Number(r.posted) > 0
      && Number(r.posted) !== Number(r.deposit_cents));

    if (!missing.length && !partial.length) continue;

    out.push({
      companyId: company.id, name: company.name,
      closedThrough: company.books_closed_through || null,
      missing: missing.map((r) => ({
        leaseId: r.id, where: `${r.line1}${r.label ? `, unit ${r.label}` : ""}`,
        cents: Number(r.deposit_cents),
      })),
      cents: missing.reduce((n, r) => n + Number(r.deposit_cents), 0),
      /* Named rather than folded in. Somebody has to look at these. */
      partial: partial.map((r) => ({
        leaseId: r.id, where: `${r.line1}${r.label ? `, unit ${r.label}` : ""}`,
        onTheLease: Number(r.deposit_cents), inTheBooks: Number(r.posted),
      })),
    });
  }
  return out;
}

export function describeConversion(planned) {
  if (!planned.length) return "Every deposit on an active lease is already in the books.";
  const lines = [];
  for (const company of planned) {
    lines.push(`${company.name}`);
    lines.push(`  ${company.missing.length} deposit(s) on leases and not in the books, `
      + `${usd(company.cents)} in total.`);
    if (company.closedThrough) {
      lines.push(`  Books are closed through ${company.closedThrough}; the posting is dated `
        + "after that, so nothing reopens a closed period.");
    }
    for (const m of company.missing) lines.push(`    ${m.where.padEnd(44)}${usd(m.cents)}`);
    if (company.partial.length) {
      lines.push(`  ${company.partial.length} lease(s) have part of a deposit posted. `
        + "These are NOT touched — a partial posting is a question, and guessing at the "
        + "difference is how a conversion makes things worse:");
      for (const p of company.partial) {
        lines.push(`    ${p.where.padEnd(36)}lease says ${usd(p.onTheLease)}, `
          + `books say ${usd(p.inTheBooks)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function commitConversion({
  confirm, companyId = null, date = null, postedBy = "deposit-conversion",
} = {}) {
  if (confirm !== "post-held-deposits") {
    throw new Error(
      "deposits.commitConversion needs { confirm: 'post-held-deposits' }. "
      + "Run planConversion() and read describeConversion() first.");
  }

  const { postMoney } = await import("./ledger.js");
  const planned = await planConversion({ companyId });
  const results = [];

  for (const company of planned) {
    /* Never behind a close. The books being closed through a date means
       somebody has signed off on the figures up to it, and a conversion that
       reopened that would be the worst possible way to find out. */
    const on = date
      || (company.closedThrough ? addDays(company.closedThrough, 1) : today());

    let posted = 0, cents = 0;
    for (const entry of company.missing) {
      const lease = await one(
        `SELECT l.*, u.property_id, p.owner_id
           FROM lease l JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
          WHERE l.id = ?`, entry.leaseId);

      await postMoney({
        companyId: company.companyId, ownerId: lease.owner_id,
        propertyId: lease.property_id, unitId: lease.unit_id, leaseId: lease.id,
        date: on, kind: "deposit_held", amountCents: entry.cents,
        memo: "Deposit held, carried into the books",
        source: "system", sourceType: "deposit_conversion", sourceId: lease.id,
        postedBy,
      });
      posted += 1;
      cents += entry.cents;
    }

    results.push({
      company: company.name, companyId: company.companyId,
      posted, cents, date: on,
      untouched: company.partial.length,
    });
  }

  return results;
}
