/* The report registry.

   Eleven reports written as eleven functions, each returning its own shape.
   That is fine until something needs to run one by name — a URL, an export, a
   schedule that fires at six in the morning — at which point every caller has
   to know all eleven shapes. This is the one place that does.

   Each entry says four things:

     what it needs    the parameters, so a screen can build a filter bar and a
                      schedule can be validated before it is saved
     who may run it   the capability, checked once here rather than at three
                      call sites that will drift
     how to run it    one function
     how to lay it    out as columns and rows, which is what CSV and PDF both
                      consume, so an export cannot disagree with the screen

   The last one matters more than it looks. Without it, the CSV of a report and
   the report itself are two renderings of the same data written months apart,
   and the moment they disagree nobody can say which is right. */
import { trialBalance } from "../../features/accounting.js";
import { extract1099 } from "../../features/vendors.js";
import {
  profitAndLoss, profitAndLossByProperty, balanceSheet, cashMovement, generalLedger,
} from "./financial.js";
import { agedReceivables, BUCKETS } from "./receivable.js";
import { trustReconciliation } from "./trust.js";
import {
  rentRoll, vacancy, leaseExpirations, depositsHeld, repairSpend,
} from "./operational.js";
import {
  ownerList, unitList, workOrderList, vendorList,
  payoutList, bankLineList, leaseDocumentList,
} from "./lists.js";
import { today, monthKey, human, humanStamp } from "../dates.js";
import { usd } from "../money.js";
import { can } from "../auth.js";

/* Parameter kinds a screen knows how to render and a schedule knows how to
   validate. Deliberately few: a report with its own bespoke filter is a
   report nobody can schedule. */
export const PARAMS = {
  asOf: { label: "As at", type: "date", default: () => today() },
  from: { label: "From", type: "date", default: () => `${monthKey(today())}-01` },
  to: { label: "To", type: "date", default: () => today() },
  propertyId: { label: "Property", type: "property", optional: true },
  ownerId: { label: "Owner", type: "owner", optional: true },
  code: { label: "Account", type: "account", optional: true },
  withinDays: { label: "Within", type: "days", default: () => 120 },
  year: { label: "Tax year", type: "year", default: () => new Date().getUTCFullYear() - 1 },
};

const money = (key, label, width = 1) => ({ key, label, money: true, width });
const text = (key, label, width = 2) => ({ key, label, width });

export const REPORTS = {
  /* --- the books ---------------------------------------------------------- */

  trial_balance: {
    title: "Trial balance",
    group: "Financial",
    description: "Every account, its debits, its credits and its balance.",
    need: "money.view",
    params: ["from", "to"],
    run: (companyId, p) => trialBalance(companyId, { from: p.from || null, to: p.to || null }),
    table: (rows) => ({
      columns: [text("code", "Code", 1), text("name", "Account", 3),
                money("debits", "Debits"), money("credits", "Credits"), money("balance", "Balance")],
      rows,
      totals: {
        code: "", name: "Total",
        debits: rows.reduce((n, r) => n + r.debits, 0),
        credits: rows.reduce((n, r) => n + r.credits, 0),
        balance: null,
      },
    }),
  },

  profit_and_loss: {
    title: "Profit and loss",
    group: "Financial",
    description: "Income and expenses for a period. Your business, not the owners'.",
    need: "money.view",
    params: ["from", "to", "propertyId"],
    run: (companyId, p) => profitAndLoss(companyId, {
      from: p.from || null, to: p.to || today(), propertyId: p.propertyId || null,
    }),
    table: (r) => ({
      columns: [text("kind", "", 1), text("code", "Code", 1), text("name", "Account", 3),
                money("balance", "Amount")],
      rows: [
        ...r.income.map((x) => ({ ...x, kind: "Income" })),
        ...r.expense.map((x) => ({ ...x, kind: "Expense" })),
      ],
      totals: { kind: "", code: "", name: "Net", balance: r.netCents },
    }),
  },

  profit_and_loss_by_property: {
    title: "Profit and loss by property",
    group: "Financial",
    description: "The same, split by property, with everything that belongs to none of them.",
    need: "money.view",
    params: ["from", "to"],
    run: (companyId, p) => profitAndLossByProperty(companyId, {
      from: p.from || null, to: p.to || today(),
    }),
    table: (r) => ({
      columns: [text("label", "Property", 4), money("incomeCents", "Income"),
                money("expenseCents", "Expenses"), money("netCents", "Net")],
      rows: r.columns,
      totals: { label: "Total", incomeCents: null, expenseCents: null, netCents: r.totalCents },
    }),
    /* Printed on the export so the figure is never read without it. */
    note: (r) => r.unexplainedCents === 0
      ? "Every posting is accounted for in a column above."
      : `${usd(r.unexplainedCents)} is not explained by any column — investigate before relying on this.`,
  },

  balance_sheet: {
    title: "Balance sheet",
    group: "Financial",
    description: "As at a date, with client money marked as restricted.",
    need: "money.view",
    params: ["asOf"],
    run: (companyId, p) => balanceSheet(companyId, { asOf: p.asOf || today() }),
    table: (r) => ({
      columns: [text("section", "", 2), text("code", "Code", 1), text("name", "Account", 3),
                money("balance", "Balance")],
      rows: [
        ...r.assets.restricted.map((x) => ({ ...x, section: "Assets — restricted" })),
        ...r.assets.unrestricted.map((x) => ({ ...x, section: "Assets" })),
        ...r.liabilities.restricted.map((x) => ({ ...x, section: "Liabilities — owed to clients" })),
        ...r.liabilities.unrestricted.map((x) => ({ ...x, section: "Liabilities" })),
        ...r.equity.rows.map((x) => ({ ...x, section: "Equity" })),
        { section: "Equity", code: "", name: "Earnings not yet closed", balance: r.equity.earningsCents },
      ],
      totals: { section: "", code: "", name: "Assets less liabilities and equity", balance: r.outOfBalanceCents },
    }),
    note: (r) => r.outOfBalanceCents === 0
      ? "In balance."
      : `OUT OF BALANCE by ${usd(r.outOfBalanceCents)}. This should be impossible.`,
  },

  cash_movement: {
    title: "Cash movement",
    group: "Financial",
    description: "What came in and went out of each cash account, and against what.",
    need: "money.view",
    params: ["from", "to"],
    run: (companyId, p) => cashMovement(companyId, { from: p.from || null, to: p.to || today() }),
    table: (r) => ({
      columns: [text("account", "Account", 3), text("against", "Against", 3),
                money("inCents", "In"), money("outCents", "Out")],
      rows: r.accounts.flatMap((a) => [
        { account: `${a.code} ${a.name}`, against: "Opening balance",
          inCents: a.openingCents, outCents: null },
        ...a.against.map((x) => ({ account: "", against: `${x.code} ${x.name}`,
          inCents: x.inCents, outCents: x.outCents })),
        { account: "", against: "Closing balance", inCents: a.closingCents, outCents: null },
      ]),
    }),
  },

  general_ledger: {
    title: "General ledger detail",
    group: "Financial",
    description: "Every posting, in order, with a running balance. Where a number came from.",
    need: "money.view",
    params: ["from", "to", "code", "propertyId"],
    landscape: true,
    run: (companyId, p) => generalLedger(companyId, {
      from: p.from || null, to: p.to || today(),
      code: p.code || null, propertyId: p.propertyId || null,
    }),
    table: (r) => ({
      columns: [text("date", "Date", 1), text("code", "Code", 1), text("account", "Account", 2),
                text("memo", "Memo", 4), money("debitCents", "Debit"),
                money("creditCents", "Credit"), money("runningCents", "Balance")],
      rows: r.lines,
      totals: { date: "", code: "", account: "", memo: "Total",
                debitCents: r.debitCents, creditCents: r.creditCents, runningCents: null },
    }),
    note: (r) => r.truncated
      ? "This report was truncated. Narrow the period or the account."
      : null,
  },

  trust_reconciliation: {
    title: "Trust reconciliation",
    group: "Financial",
    description: "Bank against book against the individual client ledgers.",
    need: "money.view",
    params: ["asOf"],
    run: (companyId, p) => trustReconciliation(companyId, { asOf: p.asOf || today() }),
    table: (r) => ({
      columns: [text("leg", "", 3), money("cents", "Amount"), text("detail", "", 4)],
      rows: [
        { leg: "Bank, less payments not yet cleared", cents: r.legs.bank.cents,
          detail: r.legs.bank.unavailable || "" },
        { leg: "Book — trust assets", cents: r.legs.book.cents, detail: "" },
        { leg: "Owed to clients", cents: r.legs.clients.cents, detail: "" },
        { leg: "The individual client ledgers", cents: r.legs.subledger.cents, detail: "" },
        ...r.variances.map((v) => ({
          leg: v.label, cents: v.cents, detail: v.unavailable ? "not checked" : v.question,
        })),
        ...r.findings.map((f) => ({ leg: `— ${f.title}`, cents: f.cents ?? null, detail: f.detail })),
      ],
    }),
    note: (r) => r.balanced
      ? "All three legs agree."
      : r.unchecked.length
      ? "This reconciliation is incomplete: a leg could not be checked."
      : "This reconciliation does not balance.",
  },

  aged_receivables: {
    title: "Aged receivables",
    group: "Rent",
    description: "What tenants owe, aged from the due date. Grace is flagged, not bucketed.",
    need: "money.view",
    params: ["asOf"],
    landscape: true,
    run: (companyId, p) => agedReceivables(companyId, { asOf: p.asOf || today() }),
    table: (r) => ({
      columns: [
        text("where", "Property", 3), text("tenant", "Tenant", 2),
        ...BUCKETS.map((b) => ({ key: b.key, label: b.label, money: true, map: (row) => row.buckets?.[b.key] ?? row[b.key] })),
        money("prepaidCents", "In credit"),
        text("graceNote", "", 1),
      ],
      rows: r.rows.map((row) => ({ ...row, graceNote: row.inGrace ? "in grace" : "" })),
      totals: {
        where: "Total", tenant: "", graceNote: "",
        ...Object.fromEntries(BUCKETS.map((b) => [b.key, r.totals[b.key]])),
        prepaidCents: r.prepaidCents,
      },
    }),
    note: (r) => r.inGraceCents > 0
      ? `${usd(r.inGraceCents)} of the overdue figure is still inside its grace period.`
      : null,
  },

  /* --- the portfolio -------------------------------------------------------- */

  rent_roll: {
    title: "Rent roll",
    group: "Portfolio",
    description: "Every unit, let or empty, and what it earns against what it could.",
    need: "property.view",
    params: ["asOf", "propertyId"],
    landscape: true,
    run: (companyId, p) => rentRoll(companyId, {
      asOf: p.asOf || today(), propertyId: p.propertyId || null,
    }),
    table: (r) => ({
      columns: [text("where", "Property", 3), text("tenants", "Tenant", 2),
                text("startDate", "From", 1), text("endDate", "To", 1),
                money("rentCents", "Rent"), money("marketRentCents", "Market"),
                money("vacancyLossCents", "Vacant")],
      rows: r.rows,
      totals: { where: `${r.occupiedUnits} of ${r.units} let`, tenants: "", startDate: "", endDate: "",
                rentCents: r.rentCents, marketRentCents: r.marketRentCents,
                vacancyLossCents: r.vacancyLossCents },
    }),
    note: (r) => `Contracted rent, not collected rent. ${Math.round(r.occupancyRate * 100)}% of units let.`,
  },

  vacancy: {
    title: "Vacancy",
    group: "Portfolio",
    description: "Every empty unit and how long it has been empty.",
    need: "property.view",
    params: ["asOf"],
    run: (companyId, p) => vacancy(companyId, { asOf: p.asOf || today() }),
    table: (r) => ({
      columns: [text("where", "Property", 4), text("vacantSince", "Empty since", 2),
                text("daysLabel", "Days", 1), money("marketRentCents", "Asking rent")],
      rows: r.rows.map((row) => ({
        ...row,
        vacantSince: row.vacantSince || "—",
        daysLabel: row.neverLet ? "never let" : String(row.daysVacant),
      })),
      totals: { where: `${r.vacantUnits} empty`, vacantSince: "", daysLabel: "",
                marketRentCents: r.lostMonthlyCents },
    }),
    note: (r) => `Days empty are derived from ${r.derivedFrom}.`,
  },

  lease_expirations: {
    title: "Lease expirations",
    group: "Portfolio",
    description: "What ends soon, and what is rolling month to month.",
    need: "property.view",
    params: ["asOf", "withinDays"],
    run: (companyId, p) => leaseExpirations(companyId, {
      asOf: p.asOf || today(), withinDays: Number(p.withinDays) || 120,
    }),
    table: (r) => ({
      columns: [text("where", "Property", 3), text("tenants", "Tenant", 2),
                text("endDate", "Ends", 1), text("state", "", 1), money("rentCents", "Rent")],
      rows: [
        ...r.expiring.map((x) => ({ ...x, state: x.overrun ? "overrun" : `${x.daysRemaining}d` })),
        ...r.rolling.map((x) => ({ ...x, endDate: "—", state: "month to month" })),
      ],
      totals: { where: `${r.expiringCount} expiring, ${r.rollingCount} rolling`,
                tenants: "", endDate: "", state: "", rentCents: r.rentAtRiskCents },
    }),
  },

  deposits_held: {
    title: "Security deposits held",
    group: "Portfolio",
    description: "What the leases say against what the books say.",
    need: "money.view",
    params: ["asOf"],
    run: (companyId, p) => depositsHeld(companyId, { asOf: p.asOf || today() }),
    table: (r) => ({
      columns: [text("where", "Property", 3), text("tenants", "Tenant", 2),
                money("onLeaseCents", "On the lease"), money("inBooksCents", "In the books"),
                money("differenceCents", "Difference")],
      rows: r.rows,
      totals: { where: "Total", tenants: "", onLeaseCents: r.onLeaseCents,
                inBooksCents: r.inBooksCents, differenceCents: r.differenceCents },
    }),
    note: (r) => r.differenceCents === 0
      ? "Every deposit on a lease is posted."
      : `${usd(r.differenceCents)} is recorded on ${r.unpostedCount} lease(s) and posted to no account.`,
  },

  repair_spend: {
    title: "Repair spend",
    group: "Portfolio",
    description: "What was spent on repairs, by contractor and by category.",
    need: "money.view",
    params: ["from", "to", "propertyId"],
    run: (companyId, p) => repairSpend(companyId, {
      from: p.from || null, to: p.to || today(), propertyId: p.propertyId || null,
    }),
    table: (r) => ({
      columns: [text("date", "Date", 1), text("where", "Property", 3),
                text("category", "Category", 1), text("vendor", "Contractor", 2),
                text("summary", "Job", 3), money("cents", "Cost")],
      rows: r.lines,
      totals: { date: "", where: "Total", category: "", vendor: "", summary: "", cents: r.totalCents },
    }),
  },

  /* --- the working lists ----------------------------------------------------
   *
   * The roadmap asks that every table in the application can be exported.
   * Most of the ones carrying data worth exporting are already reports; these
   * are the four working lists that were not. Registry entries rather than
   * export buttons on four screens, so there is one export path and one set
   * of tests — and each gains a PDF and a schedule for nothing. */

  owner_list: {
    title: "Owners",
    group: "Lists",
    description: "Every owner, what they hold, and what the ledger says they are owed.",
    need: "money.view",
    params: [],
    run: (companyId) => ownerList(companyId),
    table: (r) => ({
      columns: [text("name", "Owner", 3), text("email", "Email", 3), text("phone", "Phone", 2),
                text("properties", "Properties", 1), text("units", "Units", 1),
                money("balanceCents", "Balance"), money("thresholdCents", "Approves to")],
      rows: r.rows,
      totals: { name: `${r.owners} owner${r.owners === 1 ? "" : "s"}`, email: "", phone: "",
                properties: "", units: "", balanceCents: r.balanceCents, thresholdCents: null },
    }),
    note: () => "Balance is what the owner's own ledger says, positive towards them.",
  },

  unit_list: {
    title: "Properties and units",
    group: "Lists",
    description: "Every unit, its owner, its state, and what it is let for.",
    need: "property.view",
    params: ["propertyId"],
    landscape: true,
    run: (companyId, p) => unitList(companyId, { propertyId: p.propertyId || null }),
    table: (r) => ({
      columns: [text("where", "Unit", 3), text("owner", "Owner", 2), text("status", "State", 1),
                text("beds", "Beds", 1), text("baths", "Baths", 1), text("sqft", "Sq ft", 1),
                text("tenants", "Tenant", 2),
                money("rentCents", "Rent"), money("marketRentCents", "Market")],
      rows: r.rows,
      totals: { where: `${r.units} unit${r.units === 1 ? "" : "s"}`, owner: "", status: "",
                beds: "", baths: "", sqft: "", tenants: "",
                rentCents: r.rentCents, marketRentCents: r.marketRentCents },
    }),
  },

  work_order_list: {
    title: "Work orders",
    group: "Lists",
    description: "Every job raised in a period, what it cost, and what was billed.",
    need: "maintenance.work",
    params: ["from", "to", "propertyId"],
    landscape: true,
    run: (companyId, p) => workOrderList(companyId, {
      from: p.from || null, to: p.to || today(), propertyId: p.propertyId || null,
    }),
    table: (r) => ({
      columns: [text("reference", "Ref", 1), text("raised", "Raised", 1),
                text("where", "Where", 3), text("category", "Category", 1),
                text("severity", "Severity", 1), text("status", "Status", 1),
                text("vendor", "Contractor", 2), text("summary", "Job", 3),
                money("recordedCents", "Recorded"), money("invoicedCents", "Invoiced")],
      rows: r.rows,
      totals: { reference: "", raised: "", where: `${r.jobs} job${r.jobs === 1 ? "" : "s"}`,
                category: "", severity: "", status: "", vendor: "", summary: "Cost",
                recordedCents: null, invoicedCents: r.costCents },
    }),
    /* Two money columns and they are not the same question. Said on the
       report, because a reader summing the wrong one gets a number that looks
       right. */
    note: (r) => `${r.open} still open, ${r.emergencies} flagged as an emergency. `
      + "Recorded is what was entered on the job; invoiced is what the contractor billed. "
      + "The cost total uses the invoice where there is one.",
  },

  vendor_list: {
    title: "Contractors",
    group: "Lists",
    description: "Every contractor, and whether they may be dispatched or paid.",
    need: "vendor.manage",
    params: ["asOf"],
    landscape: true,
    run: (companyId, p) => vendorList(companyId, { asOf: p.asOf || today() }),
    table: (r) => ({
      columns: [text("name", "Contractor", 3), text("trade", "Trade", 2),
                text("phone", "Phone", 2), text("jobs", "Jobs", 1),
                text("licenceExpires", "Licence", 1), text("liabilityExpires", "Liability", 1),
                text("workersCompExpires", "Workers comp", 1),
                text("state", "", 3)],
      rows: r.rows.map((v) => ({
        ...v,
        state: !v.active ? "inactive"
          : v.blocked ? v.blocked
          : v.warnings ? v.warnings
          : "clear",
      })),
      totals: { name: `${r.vendors} contractor${r.vendors === 1 ? "" : "s"}`, trade: "",
                phone: "", jobs: "", licenceExpires: "", liabilityExpires: "",
                workersCompExpires: "", state: "" },
    }),
    note: (r) => r.blockedFromDispatch || r.blockedFromPayment
      ? `${r.blockedFromDispatch} cannot be dispatched and ${r.blockedFromPayment} cannot be paid.`
      : "Every active contractor may be dispatched and paid.",
  },

  payout_list: {
    title: "Payments out",
    group: "Lists",
    description: "Every payment to an owner or a contractor, and which run it left in.",
    need: "money.view",
    params: ["from", "to"],
    landscape: true,
    run: (companyId, p) => payoutList(companyId, { from: p.from || null, to: p.to || today() }),
    table: (r) => ({
      columns: [text("effectiveDate", "Date", 1), text("payee", "Paid to", 3),
                text("paidTo", "Kind", 1), text("method", "How", 1),
                text("identifier", "Reference", 1), text("runStatus", "Run", 1),
                text("memo", "Memo", 3), money("amountCents", "Amount")],
      rows: r.rows.map((x) => ({ ...x, memo: x.voided ? `VOIDED — ${x.voidReason || "no reason given"}` : x.memo })),
      totals: { effectiveDate: "", payee: `${r.payments} payment${r.payments === 1 ? "" : "s"}`,
                paidTo: "", method: "", identifier: "", runStatus: "", memo: "",
                amountCents: r.amountCents },
    }),
    note: (r) => r.voided
      ? `${r.voided} payment(s) were voided and are not in the total. They are listed so it is visible that somebody removed them.`
      : "Cheque numbers and the last four digits only — never an account number.",
  },

  bank_line_list: {
    title: "Bank lines",
    group: "Lists",
    description: "Every line from the bank, and what each one was matched to.",
    need: "bank.link",
    params: ["from", "to"],
    landscape: true,
    run: (companyId, p) => bankLineList(companyId, { from: p.from || null, to: p.to || today() }),
    table: (r) => ({
      columns: [text("date", "Date", 1), text("account", "Account", 2),
                text("description", "Description", 4), text("state", "State", 1),
                text("matchedTo", "Matched to", 3), money("amountCents", "Amount")],
      rows: r.rows,
      totals: { date: "", account: "", description: `${r.lines} line${r.lines === 1 ? "" : "s"}`,
                state: "", matchedTo: "", amountCents: null },
    }),
    /* The number this report is usually opened to find. */
    note: (r) => r.unmatched
      ? `${r.unmatched} line(s) are unmatched, ${usd(r.unmatchedCents)} in total.`
      : "Every line is matched.",
  },

  lease_document_list: {
    title: "Lease documents",
    group: "Lists",
    description: "Every document, where it has got to, and what is still outstanding.",
    need: "leasing.work",
    params: [],
    landscape: true,
    run: (companyId) => leaseDocumentList(companyId),
    table: (r) => ({
      columns: [text("title", "Document", 3), text("where", "Unit", 3),
                text("tenants", "Tenant", 2), text("status", "Status", 1),
                text("mustSign", "Must sign", 2), text("sent", "Sent", 1),
                text("completed", "Completed", 1),
                text("signatures", "Signed", 1), text("stillToSign", "Still to sign", 1)],
      rows: r.rows,
      totals: { title: `${r.documents} document${r.documents === 1 ? "" : "s"}`,
                where: "", tenants: "", status: "", mustSign: "", sent: "",
                completed: "", signatures: "", stillToSign: r.signaturesOutstanding },
    }),
    note: (r) => r.signaturesOutstanding
      ? `${r.signaturesOutstanding} signature(s) are still owed across ${r.documentsOutstanding} document(s). `
        + "Signatures are counted here and never listed — a signature block carries a typed name, an address and a browser, and none of that belongs in a spreadsheet."
      : "Nothing is waiting on a signature. Signatures are counted here and never listed.",
  },

  tax_1099: {
    title: "1099 summary",
    group: "Tax",
    description: "Contractors paid in a year, and what is missing before filing.",
    need: "money.view",
    params: ["year"],
    run: (companyId, p) => extract1099(companyId, Number(p.year) || new Date().getUTCFullYear() - 1),
    table: (r) => ({
      columns: [text("recipientName", "Recipient", 3), text("taxClassification", "Class", 1),
                text("taxIdLast4", "TIN", 1), money("paidCents", "Paid"),
                text("state", "", 2)],
      rows: r.recipients.map((x) => ({
        ...x,
        taxIdLast4: x.taxIdLast4 ? `•••${x.taxIdLast4}` : "—",
        paidCents: x.paidCents ?? x.paid,
        state: x.reportable
          ? (x.missing?.length ? x.missing.join("; ") : "ready")
          : "under the threshold",
      })),
    }),
    note: () => "Only the last four digits of a taxpayer ID appear here.",
  },
};

/* --- using it ---------------------------------------------------------------- */

export function reportKeys() {
  return Object.keys(REPORTS);
}

/* The ones this person may run. Asked of the capability table rather than of
   a list maintained beside it, for the same reason the navigation is. */
export function reportsFor(staff) {
  return Object.entries(REPORTS)
    .filter(([, r]) => !r.need || can(staff, r.need))
    .map(([key, r]) => ({ key, ...r }));
}

export function reportDefinition(key) {
  const report = REPORTS[key];
  if (!report) throw new Error(`There is no report called ${key}.`);
  return { key, ...report };
}

/* Fills in defaults so a report run with no parameters still answers, rather
   than returning an empty page that reads like "there is nothing". */
export function paramsFor(key, given = {}) {
  const report = reportDefinition(key);
  const out = {};
  for (const name of report.params) {
    const spec = PARAMS[name];
    const value = given[name];
    out[name] = value != null && value !== ""
      ? value
      : (spec?.default ? spec.default() : null);
  }
  return out;
}

export async function runReport(key, companyId, given = {}) {
  const report = reportDefinition(key);
  const params = paramsFor(key, given);
  const result = await report.run(companyId, params);
  return { key, title: report.title, params, result, report };
}

/* One shape, whatever the report. This is what CSV and PDF both consume, so an
   export cannot drift away from what the screen showed. */
export function tableFor(key, result) {
  const report = reportDefinition(key);
  const table = report.table(result);
  return {
    columns: table.columns,
    rows: table.rows || [],
    totals: table.totals || null,
    landscape: Boolean(report.landscape),
    note: typeof report.note === "function" ? report.note(result) : report.note || null,
  };
}

/* The line under the title: what period, or as at when. */
export function subtitleFor(key, params) {
  if (params.asOf) return `As at ${human(params.asOf)}`;
  if (params.from && params.to) return `${human(params.from)} to ${human(params.to)}`;
  if (params.to) return `Up to ${human(params.to)}`;
  if (params.year) return `Tax year ${params.year}`;
  return "All time";
}
