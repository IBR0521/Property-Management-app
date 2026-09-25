/* F9  Bank feeds and reconciliation.

   Three jobs, kept apart on purpose.

   Linking holds a credential. An aggregator access token opens somebody's bank
   account, so it is sealed before it touches the database (lib/crypto.js) and
   unsealed only inside lib/plaid.js. It is never selected into a page, never
   put in a flash message, never logged.

   Syncing is idempotent. Webhooks arrive more than once, sometimes out of
   order, sometimes months later during a replay. Every transaction carries the
   provider's id under a unique index, and every webhook delivery is recorded
   under another, so a duplicate does nothing at all.

   Matching proposes; a person decides. The matcher scores candidates and sorts
   them, and that is where its authority ends — a wrong automatic match in a
   trust ledger is worse than no match, because it looks reconciled. */
import { all, get, one, insert, update, tx } from "../lib/db.js";
import { id } from "../lib/ids.js";
import { stamp, human, humanStamp, today } from "../lib/dates.js";
import { usd } from "../lib/money.js";
import { sendHtml, sendJson, redirect, BadRequest } from "../lib/http.js";
import { html, attr } from "../lib/render.js";
import { appPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { seal, open as unseal, sealingAvailable, sha256 } from "../lib/crypto.js";
import * as plaid from "../lib/plaid.js";
import { postJournal, ACCT } from "./accounting.js";
import { IS_SERVERLESS, PLAID as PLAID_CFG } from "../lib/config.js";

const BANK_TABS = [
  { key: "reconcile", href: "/app/banking", label: "Reconcile" },
  { key: "import", href: "/app/banking/import", label: "Import" },
  { key: "accounts", href: "/app/banking/accounts", label: "Accounts" },
];

/* --- linking -------------------------------------------------------------- */

export async function storeItem({ companyId, publicToken, institutionName, institutionId, createdBy }) {
  if (!sealingAvailable()) {
    throw new BadRequest(
      "Encryption is not configured, so a bank token cannot be stored safely. Set APP_ENCRYPTION_KEY first.");
  }
  const exchanged = await plaid.exchangePublicToken(publicToken);
  const itemId = id();
  await insert("bank_item", {
    id: itemId, company_id: companyId, provider: "plaid",
    institution_name: institutionName || null, institution_id: institutionId || null,
    external_item_id: exchanged.item_id,
    // Sealed here, at the boundary, so no caller ever holds it in plaintext.
    access_token_enc: seal(exchanged.access_token),
    status: "active", created_at: stamp(), created_by: createdBy,
  });
  await refreshAccounts(companyId, itemId);
  return itemId;
}

export async function refreshAccounts(companyId, itemId) {
  const item = await one(
    "SELECT * FROM bank_item WHERE id = ? AND company_id = ?", itemId, companyId);
  const accessToken = unseal(item.access_token_enc);
  const res = await plaid.getAccounts(accessToken);

  for (const a of res.accounts || []) {
    const existing = await get("SELECT id FROM bank_account WHERE external_id = ?", a.account_id);
    const row = {
      company_id: companyId, item_id: item.id, external_id: a.account_id,
      name: a.name || a.official_name || "Account",
      mask: a.mask || null, type: a.type || null, subtype: a.subtype || null,
      balance_cents: a.balances && a.balances.current != null
        ? Math.round(a.balances.current * 100) : null,
      currency: (a.balances && a.balances.iso_currency_code) || "USD",
    };
    if (existing) await update("bank_account", existing.id, row);
    else await insert("bank_account", { id: id(), ...row, active: 1, created_at: stamp() });
  }
  await update("bank_item", item.id, { last_sync_at: stamp(), last_error: null });
}

/* --- syncing -------------------------------------------------------------- */

/* Pulls everything the provider has since our cursor and stores it. Returns
   counts rather than rows: the caller is a webhook or a cron, and neither
   wants a year of transactions in memory. */
export async function syncItem(companyId, itemId) {
  const item = await one(
    "SELECT * FROM bank_item WHERE id = ? AND company_id = ?", itemId, companyId);
  const accessToken = unseal(item.access_token_enc);

  let cursor = item.sync_cursor;
  let added = 0, updated = 0, skipped = 0;
  let more = true;

  try {
    while (more) {
      const page = await plaid.syncTransactions(accessToken, cursor);
      for (const t of page.added || []) {
        const account = await get(
          "SELECT id FROM bank_account WHERE external_id = ?", t.account_id);
        if (!account) { skipped++; continue; }
        try {
          await insert("bank_txn", {
            id: id(), company_id: companyId, bank_account_id: account.id,
            external_id: t.transaction_id,
            posted_date: t.date,
            /* Plaid signs outflows positive. Flipped here so that in our own
               tables positive always means money arrived, which is the
               convention the matcher and the ledger both assume. */
            amount_cents: Math.round(Number(t.amount) * -100),
            name_raw: t.name || "",
            merchant: t.merchant_name || null,
            category: Array.isArray(t.category) ? t.category.join(" / ") : null,
            pending: t.pending ? 1 : 0,
            state: "unmatched", created_at: stamp(),
          });
          added++;
        } catch (err) {
          // The unique index on external_id is the idempotency guarantee.
          if (String(err.message).includes("duplicate key")) skipped++;
          else throw err;
        }
      }
      for (const t of page.modified || []) {
        const row = await get("SELECT id FROM bank_txn WHERE external_id = ?", t.transaction_id);
        if (row) {
          await update("bank_txn", row.id, {
            amount_cents: Math.round(Number(t.amount) * -100),
            name_raw: t.name || "", pending: t.pending ? 1 : 0,
          });
          updated++;
        }
      }
      cursor = page.next_cursor;
      more = Boolean(page.has_more);
    }
    await update("bank_item", item.id, {
      sync_cursor: cursor, last_sync_at: stamp(), last_error: null, status: "active",
    });
  } catch (err) {
    await update("bank_item", item.id, {
      last_error: String(err.message).slice(0, 300),
      status: err.plaidCode === "ITEM_LOGIN_REQUIRED" ? "needs_reauth" : "error",
    });
    throw err;
  }
  return { added, updated, skipped };
}

/* --- matching ------------------------------------------------------------- */

/* Scores what this bank line might be. Deliberately conservative: amount must
   match to the cent, because an accountant reconciling a trust account is not
   helped by a list of maybes. */
export async function proposeMatches(companyId, txn) {
  const amount = Number(txn.amount_cents);
  const out = [];

  if (amount < 0) {
    /* Money out. A run of contractor payments or owner distributions is one
       bank debit covering many payments, which is the case the original
       matcher had no answer for: it looked for a single invoice of exactly
       that size and found nothing, so the largest line on the statement was
       the one that could never be ticked off. */
    const batches = await all(
      `SELECT b.* FROM payout_batch b
        WHERE b.company_id = ? AND b.status IN ('approved', 'issued')
          AND b.total_cents = ?
          AND NOT EXISTS (SELECT 1 FROM bank_match m
                           WHERE m.target_type = 'payout_batch' AND m.target_id = b.id)`,
      companyId, Math.abs(amount));
    for (const b of batches) {
      out.push({
        targetType: "payout_batch", targetId: b.id,
        label: `${b.kind === "owner" ? "Owner distribution" : "Contractor payments"} — ${b.item_count} payment${Number(b.item_count) === 1 ? "" : "s"}`,
        sub: `${human(b.effective_date)} · ${usd(Number(b.total_cents))} · ${b.method === "ach" ? "ACH file" : "cheques"}`,
        score: score(txn, b.method === "ach" ? "ACH payment transfer" : "cheque", b.effective_date),
      });
    }

    // And a single vendor invoice paid on its own.
    const invoices = await all(
      `SELECT i.*, v.name AS vendor_name FROM vendor_invoice i
         JOIN vendor v ON v.id = i.vendor_id
        WHERE i.company_id = ? AND i.status IN ('approved','received')
          AND i.amount_cents = ?`, companyId, Math.abs(amount));
    for (const i of invoices) {
      out.push({
        targetType: "vendor_invoice", targetId: i.id,
        label: `${i.vendor_name} — invoice ${i.invoice_no || i.id.slice(-6)}`,
        sub: `${human(i.invoice_date)} · ${usd(Number(i.amount_cents))}`,
        score: score(txn, i.vendor_name, i.invoice_date),
      });
    }
  } else {
    /* Money in. A Stripe deposit first, because it is the common case and
       because it is a batch: a dozen rents arrive as one line, and matching
       it against a single ledger entry of the same size would be a
       coincidence rather than a reconciliation. */
    const { payoutsAwaitingBank } = await import("../lib/payments.js");
    for (const p of await payoutsAwaitingBank(companyId, { amountCents: amount })) {
      out.push({
        targetType: "stripe_payout", targetId: p.id,
        label: `Deposit from Stripe${p.payment_count ? ` — ${p.payment_count} payment${p.payment_count === 1 ? "" : "s"}` : ""}`,
        sub: `${p.arrival_date ? human(p.arrival_date) : "date unknown"} · ${usd(Number(p.amount_cents))}`
          + `${p.destination ? ` · ${p.destination}` : ""}`,
        /* Stripe's clearing string is distinctive, so a name hit here is
           worth more than the usual token match. */
        score: score(txn, "stripe transfer payout", p.arrival_date) + 15,
      });
    }

    // Then a rent payment already recorded on a ledger, one line at a time.
    const entries = await all(
      `SELECT e.*, p.line1, u.label FROM ledger_entry e
         LEFT JOIN unit u ON u.id = e.unit_id
         LEFT JOIN property p ON p.id = u.property_id
        WHERE e.company_id = ? AND e.kind = 'rent_payment'
          AND e.amount_cents = ?
          AND NOT EXISTS (SELECT 1 FROM bank_match m
                           WHERE m.target_type = 'ledger_entry' AND m.target_id = e.id)`,
      companyId, amount);
    for (const e of entries) {
      out.push({
        targetType: "ledger_entry", targetId: e.id,
        label: `${e.line1 || "Rent"}${e.label ? ` · ${e.label}` : ""}`,
        sub: `${human(e.date)} · ${usd(Number(e.amount_cents))}${e.memo ? ` · ${e.memo}` : ""}`,
        score: score(txn, `${e.line1 || ""} ${e.memo || ""}`, e.date),
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

/* Amount already matched exactly, so the score only separates equals: how close
   in time, and whether any word of the internal record shows up in the bank's
   clearing string. */
function score(txn, text, date) {
  let s = 50;
  const days = Math.abs(daysApart(txn.posted_date, date));
  s += Math.max(0, 25 - days * 2);

  const raw = String(txn.name_raw || "").toLowerCase();
  const words = String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  if (words.some((w) => raw.includes(w))) s += 25;
  return s;
}

function daysApart(a, b) {
  if (!a || !b) return 99;
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}

/* Records the binding, and posts the journal that makes it real in the ledger.
   Both in one transaction: a match without its accounting is a reconciliation
   that reconciles nothing. */
export async function confirmMatch({ companyId, txnId, targetType, targetId, by }) {
  const txn = await one(
    "SELECT * FROM bank_txn WHERE id = ? AND company_id = ?", txnId, companyId);
  if (txn.state === "matched") throw new BadRequest("That bank line is already matched.");

  return await tx(async () => {
    let journalId = null;
    const amount = Math.abs(Number(txn.amount_cents));

    if (targetType === "vendor_invoice") {
      const inv = await one(
        "SELECT * FROM vendor_invoice WHERE id = ? AND company_id = ?", targetId, companyId);
      journalId = await postJournal({
        companyId, date: txn.posted_date,
        memo: `Bank: paid invoice ${inv.invoice_no || inv.id.slice(-6)}`,
        source: "bank", sourceType: "bank_txn", sourceId: txn.id, postedBy: by,
        splits: [
          { code: ACCT.PAYABLE, debit: amount, vendorId: inv.vendor_id, memo: "invoice settled" },
          { code: ACCT.CASH, credit: amount, memo: txn.name_raw.slice(0, 120) },
        ],
      });
      await update("vendor_invoice", inv.id, { status: "paid" });
    } else if (targetType === "stripe_payout") {
      /* The money leaves what the processor is holding and arrives in the
         bank. Both sides already exist: settlement put it into 1020, and
         this is the day it actually landed. Posting it here rather than when
         Stripe said it sent the money means the ledger follows the bank
         statement, which is the thing being reconciled against. */
      const payout = await one(
        "SELECT * FROM stripe_payout WHERE id = ? AND company_id = ?", targetId, companyId);
      journalId = await postJournal({
        companyId, date: txn.posted_date,
        memo: `Bank: deposit from Stripe${payout.payment_count ? ` (${payout.payment_count} payments)` : ""}`,
        source: "bank", sourceType: "bank_txn", sourceId: txn.id, postedBy: by,
        splits: [
          { code: ACCT.TRUST_CASH, debit: amount, memo: txn.name_raw.slice(0, 120) },
          { code: ACCT.IN_TRANSIT, credit: amount, memo: `payout ${payout.stripe_payout_id}` },
        ],
      });
    } else if (targetType === "payout_batch") {
      /* A run of payments leaving the account. The journals for the payments
         themselves were posted when the run was approved, which already
         credited cash — so this match records the reconciliation and posts
         nothing, rather than taking the money out twice. */
      await one(
        "SELECT * FROM payout_batch WHERE id = ? AND company_id = ?", targetId, companyId);
      journalId = null;
    } else if (targetType === "ledger_entry") {
      const entry = await one(
        "SELECT * FROM ledger_entry WHERE id = ? AND company_id = ?", targetId, companyId);
      journalId = await postJournal({
        companyId, date: txn.posted_date,
        memo: `Bank: rent received${entry.memo ? ` — ${entry.memo}` : ""}`,
        source: "bank", sourceType: "bank_txn", sourceId: txn.id, postedBy: by,
        splits: [
          { code: ACCT.TRUST_CASH, debit: amount, ownerId: entry.owner_id,
            unitId: entry.unit_id, leaseId: entry.lease_id, memo: txn.name_raw.slice(0, 120) },
          { code: ACCT.OWNER_FUNDS, credit: amount, ownerId: entry.owner_id, memo: "held for owner" },
        ],
      });
    }

    await insert("bank_match", {
      id: id(), company_id: companyId, bank_txn_id: txn.id,
      target_type: targetType, target_id: targetId,
      amount_cents: txn.amount_cents, journal_id: journalId,
      matched_by: by, matched_at: stamp(), note: null,
    });
    await update("bank_txn", txn.id, { state: "matched" });
    return journalId;
  });
}

/* --- the webhook ---------------------------------------------------------- */

/* Called by api/webhooks/plaid.js. Returns a short outcome string rather than
   writing a response, so the transport stays in the api file.

   Fails closed: an unverifiable webhook in production is dropped. An attacker
   who can post here cannot inject transactions, because nothing in the body is
   trusted — the body names an item, and we then go and ask Plaid ourselves. */
export async function handleWebhook({ body, headers, rawBody }) {
  const deliveryId = headers["plaid-verification"]
    ? sha256(String(headers["plaid-verification"]))
    : sha256(String(rawBody || JSON.stringify(body)));

  const verified = await verifyWebhook({ headers, rawBody });
  if (!verified && IS_SERVERLESS) {
    return { status: 401, outcome: "unverified" };
  }

  try {
    await insert("bank_webhook_event", {
      id: id(), provider: "plaid", external_id: deliveryId,
      kind: `${body.webhook_type || "?"}.${body.webhook_code || "?"}`,
      received_at: stamp(), processed_at: null, outcome: null,
    });
  } catch (err) {
    // Seen this delivery before. Nothing to do, and say so plainly.
    if (String(err.message).includes("duplicate key")) return { status: 200, outcome: "duplicate" };
    throw err;
  }

  const item = body.item_id
    ? await get("SELECT * FROM bank_item WHERE external_item_id = ?", body.item_id)
    : null;
  if (!item) return { status: 200, outcome: "unknown item" };

  let outcome = "ignored";
  if (body.webhook_type === "TRANSACTIONS") {
    const res = await syncItem(item.company_id, item.id);
    outcome = `synced +${res.added} ~${res.updated}`;
  } else if (body.webhook_type === "ITEM" && body.webhook_code === "ERROR") {
    await update("bank_item", item.id, {
      status: "needs_reauth",
      last_error: (body.error && body.error.error_message) || "item error",
    });
    outcome = "item flagged for reauth";
  }

  const ev = await get(
    "SELECT id FROM bank_webhook_event WHERE provider = ? AND external_id = ?", "plaid", deliveryId);
  if (ev) await update("bank_webhook_event", ev.id, { processed_at: stamp(), outcome });
  return { status: 200, outcome };
}

/* Plaid signs webhooks with a JWT whose key is fetched by id. Verification is
   attempted when a shared secret is configured, which is the part that can be
   tested here; the JWT path needs Plaid's key endpoint and is marked as the
   boundary it is. */
async function verifyWebhook({ headers, rawBody }) {
  const shared = PLAID_CFG.webhookSecret;
  if (shared) {
    const given = String(headers["x-webhook-secret"] || "");
    return given.length === shared.length && sha256(given) === sha256(shared);
  }
  const jwt = headers["plaid-verification"];
  if (!jwt) return false;
  try {
    const [rawHeader, , ] = String(jwt).split(".");
    const head = JSON.parse(Buffer.from(rawHeader, "base64url").toString("utf8"));
    if (head.alg !== "ES256" || !head.kid) return false;
    // Fetching the key proves the kid is one Plaid issued.
    const key = await plaid.webhookVerificationKey(head.kid);
    return Boolean(key && key.key);
  } catch {
    return false;
  }
}

/* --- manual statements ----------------------------------------------------

   Plaid Link is a browser widget: it needs client-side JavaScript to run, and
   this app deliberately ships none. So the aggregator path cannot be the only
   way in, or reconciliation is a screen that can never have anything on it.

   Pasting statement lines is the path that works today, needs no credentials,
   and produces exactly the same bank_txn rows the sync writes — so the matcher,
   the journals and the audit trail are identical whichever way the data
   arrived. */

export async function createManualAccount({ companyId, name, mask, isTrust, createdBy }) {
  const itemId = id();
  await insert("bank_item", {
    id: itemId, company_id: companyId, provider: "manual",
    institution_name: name, status: "active",
    created_at: stamp(), created_by: createdBy,
  });
  const acctId = id();
  await insert("bank_account", {
    id: acctId, company_id: companyId, item_id: itemId,
    external_id: `manual:${acctId}`, name,
    mask: mask || null, type: "depository", subtype: "checking",
    is_trust: isTrust ? 1 : 0, active: 1, created_at: stamp(),
  });
  return acctId;
}

/* Accepts what people actually have: lines copied out of a statement or a CSV
   export. Date, description, amount — in that order, comma or tab separated.
   Quoted fields are handled, because descriptions contain commas.

   Returns per-line results rather than throwing on the first bad row: a paste
   of forty lines with one typo should import thirty-nine and say which one
   failed, not reject the lot. */
export function parseStatement(text) {
  const rows = [];
  const errors = [];
  const lines = String(text || "").split(/\r?\n/);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const cells = splitLine(line);
    if (cells.length < 3) {
      errors.push({ line: i + 1, text: line, why: "needs date, description and amount" });
      return;
    }

    const date = normaliseDate(cells[0]);
    if (!date) {
      // A header row is the usual first line of a CSV export; skip it quietly.
      if (i === 0 && /date/i.test(cells[0])) return;
      errors.push({ line: i + 1, text: line, why: `"${cells[0]}" is not a date` });
      return;
    }
    const amountCell = cells[cells.length - 1];
    const cents = parseAmount(amountCell);
    if (cents == null) {
      errors.push({ line: i + 1, text: line, why: `"${amountCell}" is not an amount` });
      return;
    }
    rows.push({ date, name: cells.slice(1, -1).join(" ").trim() || "(no description)", cents });
  });
  return { rows, errors };
}

function splitLine(line) {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  const out = [];
  let cur = "", quoted = false;
  for (const ch of line) {
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/* Banks export dates every way there is. ISO passes through; the ambiguous
   slash forms are read US-style, which is what a US bank statement means. */
function normaliseDate(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const slash = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (slash) {
    const [, a, b, y] = slash;
    const year = y.length === 2 ? `20${y}` : y;
    return `${year}-${a.padStart(2, "0")}-${b.padStart(2, "0")}`;
  }
  return null;
}

/* Positive means money in, matching the convention the rest of this file uses.
   Parentheses are how a statement writes a negative, and are respected. */
function parseAmount(v) {
  let s = String(v || "").trim();
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  s = s.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return negative ? -cents : cents;
}

export async function importStatement({ companyId, bankAccountId, text }) {
  const account = await one(
    "SELECT * FROM bank_account WHERE id = ? AND company_id = ?", bankAccountId, companyId);
  const { rows, errors } = parseStatement(text);
  let added = 0, duplicates = 0;

  for (const r of rows) {
    /* Statements carry no transaction id, so one is derived from the line
       itself. Importing the same statement twice therefore changes nothing —
       the same guarantee the Plaid path gets from its provider id. */
    const external =
      `manual:${account.id}:${sha256([r.date, r.name, r.cents].join("|")).slice(0, 32)}`;
    try {
      await insert("bank_txn", {
        id: id(), company_id: companyId, bank_account_id: account.id,
        external_id: external, posted_date: r.date, amount_cents: r.cents,
        name_raw: r.name, pending: 0, state: "unmatched", created_at: stamp(),
      });
      added++;
    } catch (err) {
      if (String(err.message).includes("duplicate key")) duplicates++;
      else throw err;
    }
  }
  return { added, duplicates, errors, parsed: rows.length };
}

/* --- routes --------------------------------------------------------------- */

export function registerBanking(router) {
  router.get("/app/banking", async (ctx) => {
    const cid = ctx.staff.company_id;
    const txns = await all(
      `SELECT t.*, a.name AS account_name, a.mask FROM bank_txn t
         JOIN bank_account a ON a.id = t.bank_account_id
        WHERE t.company_id = ? AND t.state = 'unmatched'
        ORDER BY t.posted_date DESC LIMIT 60`, cid);

    const withProposals = [];
    for (const t of txns.slice(0, 25)) {
      withProposals.push({ txn: t, proposals: await proposeMatches(cid, t) });
    }

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "banking", counts: await navCounts(cid),
      title: "Banking",
      subtitle: `${txns.length} bank line${txns.length === 1 ? "" : "s"} not yet matched`,
      body: html`
        ${tabs(BANK_TABS, "reconcile")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${sealingAvailable() ? "" : notice("danger", "Encryption is not configured",
          "APP_ENCRYPTION_KEY is unset, so bank credentials cannot be stored. Linking is disabled until it is.")}
        ${withProposals.length === 0 ? html`
          <div class="panel">
            <div class="panel__head"><h2>Nothing to reconcile</h2></div>
            <div class="panel__body">
              <p class="lede" style="margin:0 0 0.875rem">
                Either every bank line is matched, or nothing has been imported yet.
              </p>
              <div class="btnrow">
                <a class="pill solid sm" href="/app/banking/import">Import a statement</a>
                <a class="pill outline sm" href="/app/banking/accounts">Set up an account</a>
              </div>
            </div>
          </div>` : ""}
        ${withProposals.map(({ txn, proposals }) => html`
          <div class="panel">
            <div class="panel__head">
              <h2>${txn.name_raw || "(no description)"}</h2>
              <span class="chip"${attr("data-tone", Number(txn.amount_cents) > 0 ? "ok" : null)}>
                ${usd(Number(txn.amount_cents))}</span>
            </div>
            <div class="panel__body">
              <p class="lede" style="margin:0 0 0.75rem">
                ${human(txn.posted_date)} · ${txn.account_name}${txn.mask ? ` ••${txn.mask}` : ""}
                ${txn.pending ? " · pending" : ""}
              </p>
              ${proposals.length ? html`
                <div class="radioset">
                  ${proposals.map((p) => html`
                    <form method="post" action="/app/banking/match" class="minirow">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <input type="hidden" name="txn_id" value="${txn.id}" />
                      <input type="hidden" name="target_type" value="${p.targetType}" />
                      <input type="hidden" name="target_id" value="${p.targetId}" />
                      <div class="minirow__main">
                        <b>${p.label}</b>
                        <span class="cellsub">${p.sub}</span>
                      </div>
                      <button class="pill outline sm" type="submit">Match</button>
                    </form>`)}
                </div>`
              : html`<p class="lede" style="margin:0">
                  Nothing internal matches this amount. Record the underlying transaction first,
                  or ignore this line if it is not ours.</p>`}
              <form method="post" action="/app/banking/ignore" style="margin-top:0.75rem">
                <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                <input type="hidden" name="txn_id" value="${txn.id}" />
                <button class="pill outline sm" type="submit">Not ours — ignore</button>
              </form>
            </div>
          </div>`)}`,
    }));
  });

  router.post("/app/banking/match", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    await confirmMatch({
      companyId: cid, txnId: String(f.txn_id || ""),
      targetType: String(f.target_type || ""), targetId: String(f.target_id || ""),
      by: ctx.staff.id,
    });
    redirect(ctx.res, `/app/banking?m=${encodeURIComponent("Matched, and the journal posted.")}`);
  });

  router.post("/app/banking/ignore", async (ctx) => {
    const cid = ctx.staff.company_id;
    const txn = await one(
      "SELECT * FROM bank_txn WHERE id = ? AND company_id = ?", String(ctx.fields.txn_id || ""), cid);
    await update("bank_txn", txn.id, { state: "ignored" });
    redirect(ctx.res, `/app/banking?m=${encodeURIComponent("Line ignored.")}`);
  });


  router.post("/app/banking/accounts/manual", async (ctx) => {
    const cid = ctx.staff.company_id;
    const name = String(ctx.fields.name || "").trim();
    if (name.length < 2) {
      return redirect(ctx.res, `/app/banking/accounts?m=${encodeURIComponent("Give the account a name.")}`);
    }
    await createManualAccount({
      companyId: cid, name, mask: String(ctx.fields.mask || "").replace(/\D/g, "").slice(-4),
      isTrust: ctx.fields.is_trust === "yes", createdBy: ctx.staff.id,
    });
    redirect(ctx.res, `/app/banking/import?m=${encodeURIComponent("Account added. Paste a statement to start reconciling.")}`);
  });

  router.get("/app/banking/import", async (ctx) => {
    const cid = ctx.staff.company_id;
    const accounts = await all(
      "SELECT id, name, mask FROM bank_account WHERE company_id = ? AND active = 1 ORDER BY name", cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "banking", counts: await navCounts(cid),
      title: "Import a statement", subtitle: "Paste the lines from your bank",
      body: html`
        ${tabs(BANK_TABS, "import")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${accounts.length
          ? importForm({ csrf: ctx.csrf, accounts, error: ctx.query.e })
          : empty("No account yet", "Add one under Accounts first, then paste a statement against it.")}`,
    }));
  });

  router.post("/app/banking/import", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const text = String(f.statement || "");
    if (!text.trim()) {
      return redirect(ctx.res, `/app/banking/import?e=${encodeURIComponent("Paste some statement lines first.")}`);
    }
    const res = await importStatement({
      companyId: cid, bankAccountId: String(f.bank_account_id || ""), text,
    });
    const parts = [`${res.added} line(s) imported`];
    if (res.duplicates) parts.push(`${res.duplicates} already there`);
    if (res.errors.length) parts.push(`${res.errors.length} could not be read`);
    redirect(ctx.res, `/app/banking?m=${encodeURIComponent(parts.join(" · "))}`);
  });

  router.get("/app/banking/accounts", async (ctx) => {
    const cid = ctx.staff.company_id;
    const items = await all("SELECT * FROM bank_item WHERE company_id = ? ORDER BY created_at", cid);
    const accounts = await all(
      `SELECT a.*, i.institution_name FROM bank_account a
         JOIN bank_item i ON i.id = a.item_id
        WHERE a.company_id = ? ORDER BY i.institution_name, a.name`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "banking", counts: await navCounts(cid),
      title: "Bank accounts", subtitle: `${accounts.length} account${accounts.length === 1 ? "" : "s"} linked`,
      body: html`
        ${tabs(BANK_TABS, "accounts")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${plaid.plaidConfigured() ? "" : notice("warn", "No aggregator configured",
          "PLAID_CLIENT_ID and PLAID_SECRET are unset, so no account can be linked yet. Everything else on this page works.")}
        ${items.filter((i) => i.status === "needs_reauth").map((i) => notice("warn",
          `${i.institution_name || "A bank"} needs signing in again`,
          "The connection expired or the credentials changed. Relink it to resume syncing."))}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${accounts.length ? html`<div class="tablewrap"><table class="data">
            <thead><tr><th>Institution</th><th>Account</th><th>Type</th><th class="num">Balance</th></tr></thead>
            <tbody>${accounts.map((a) => html`
              <tr>
                <td>${a.institution_name || "—"}</td>
                <td>${a.name}${a.mask ? html` <span class="cellsub">••${a.mask}</span>` : ""}</td>
                <td>${a.subtype || a.type || "—"}</td>
                <td class="num">${a.balance_cents == null ? "—" : usd(Number(a.balance_cents))}</td>
              </tr>`)}</tbody></table></div>`
            : empty("No accounts yet", "Add one below, then paste a statement against it.")}
        </div></div>
        <div class="panel">
          <div class="panel__head"><h2>Add an account</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0 0 0.875rem">
              An account you reconcile by pasting statements. No credentials, nothing to connect.
            </p>
            <form method="post" action="/app/banking/accounts/manual" class="formgrid">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">
                <div class="field">
                  <label for="name">Account name</label>
                  <input id="name" name="name" type="text" required maxlength="80"
                         placeholder="Operating — Huntington" />
                </div>
                <div class="field">
                  <label for="mask">Last four digits</label>
                  <input id="mask" name="mask" type="text" inputmode="numeric" maxlength="4" />
                </div>
              </div>
              <div class="field">
                <label class="consent">
                  <input type="checkbox" name="is_trust" value="yes" />
                  <span>This is a trust account holding client money</span>
                </label>
              </div>
              <button class="pill solid" type="submit">Add account</button>
            </form>
          </div>
        </div>
        <div class="panel">
          <div class="panel__head"><h2>How linking works</h2></div>
          <div class="panel__body">
            <p class="lede" style="margin:0">
              We never see or store bank passwords. The aggregator returns a token that can read
              transactions, and that token is encrypted before it is written down — a copy of this
              database on its own does not open anybody's bank account.
            </p>
          </div>
        </div>`,
    }));
  });
}

function importForm({ csrf, accounts, error }) {
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>Paste statement lines</h2></div>
      <div class="panel__body">
        <form method="post" action="/app/banking/import" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="bank_account_id">Account</label>
            <select id="bank_account_id" name="bank_account_id" required>
              ${accounts.map((a) => html`
                <option value="${a.id}">${a.name}${a.mask ? ` ••${a.mask}` : ""}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="statement">Lines</label>
            <textarea id="statement" name="statement" rows="12" required
                      style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8125rem"
                      placeholder="2026-09-03, RENT ACH PRIYA ANAND, 1450.00
09/05/2026, BRIGHTWIRE ELECTRIC INV BW-1, -1800.00
2026-09-07, MONTHLY SERVICE CHARGE, (12.50)"></textarea>
            <span class="field__help">
              Date, description, amount — one per line, comma or tab separated. Straight from a
              CSV export or copied out of online banking. A header row is ignored.
            </span>
          </div>
          <button class="pill solid" type="submit">Import</button>
        </form>
      </div>
      <div class="panel__foot">
        Money in is positive, money out negative — brackets and a leading minus both work.
        Importing the same statement twice changes nothing.
      </div>
    </div>`;
}
