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
