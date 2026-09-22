/* What a tenant sees about their own home.

   Nearly all of this already existed and was reachable only by a token in a
   link. The portal is a signed-in way to the same views, not a second copy of
   them: paying still goes through `/pay/:token`, reporting a repair still
   goes through `/report`, and a signed lease is still read at `/sign/:tok`.
   Two implementations of "what do I owe" would eventually disagree, and the
   one nobody was looking at would be the wrong one.

   What is new is the part a token cannot do: showing somebody *everything*
   they hold, including the tenancy they had two years ago, under one sign-in.

   Every query here is scoped by the company on the session and by the
   person's own links. There is no page that takes a lease id and trusts it —
   `leaseIfHeld` is asked first, and it answers about rows rather than roles. */
import { all, get, one } from "../lib/db.js";
import { usd } from "../lib/money.js";
import { human, humanStamp, monthKey, today } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { NotFound } from "../lib/db.js";
import { html, attr } from "../lib/render.js";
import { portalPage, notice, empty } from "../views/layout.js";
import { balanceFor, blockedReason } from "../lib/payments.js";
import { leasesFor, leaseIfHeld, rolesIn } from "../lib/identity.js";
import { portalTabs } from "./portal.js";

/* The real status values, from the CHECK constraint on work_order. */
const JOB_TONE = {
  new: "warn", triaged: "warn", awaiting_owner: "warn",
  assigned: "", scheduled: "", complete: "ok", cancelled: "",
};

export function registerPortalTenant(router) {
  /* --- where you rent ------------------------------------------------------ */

  router.get("/portal/home/renting", async (ctx) => {
    const { personId, companyId, company } = ctx.person;
    const roles = await rolesIn(personId, companyId);
    if (!roles.isTenant) return redirect(ctx.res, "/portal/home");

    const leases = await leasesFor(personId, companyId);
    const active = leases.filter((l) => l.status === "active");
    const past = leases.filter((l) => l.status !== "active");

    /* The balance for each live tenancy, from the same function the tenant's
       own pay page uses. */
    const balances = new Map();
    for (const lease of active) {
      balances.set(lease.id, await balanceFor(lease.id, monthKey(today())));
    }

    sendHtml(ctx.res, portalPage({
      title: "Where you rent",
      heading: active.length === 1 ? "Your home" : "Where you rent",
      lede: company.name,
      person: ctx.person, company,
      tabs: portalTabs(roles), active: "renting",
      body: html`
        ${ctx.query.m ? notice("ok", null, ctx.query.m) : ""}

        ${active.length === 0 && past.length === 0
          ? html`<div class="panel"><div class="panel__body">
              ${empty("Nothing here yet",
                "No tenancy is linked to this address. If that looks wrong, contact the office.")}
            </div></div>`
          : ""}

        ${active.map((lease) => tenancyCard({ lease, balance: balances.get(lease.id), company }))}

        ${past.length ? html`
          <div class="panel">
            <div class="panel__head">
              <h2>Before that</h2>
              <p>Tenancies that have ended</p>
            </div>
            <div class="panel__body panel__body--flush">
              <div class="tablewrap">
                <table class="data">
                  <thead><tr><th>Home</th><th>From</th><th>To</th><th></th></tr></thead>
                  <tbody>
                    ${past.map((l) => html`
                      <tr>
                        <td>${l.line1}${l.label ? html`<div class="cellsub">Unit ${l.label}</div>` : ""}</td>
                        <td>${human(l.start_date)}</td>
                        <td>${l.end_date ? human(l.end_date) : "—"}</td>
                        <td class="shrink">
                          <a class="pill outline sm" href="/portal/renting/${l.id}">Open</a>
                        </td>
                      </tr>`)}
                  </tbody>
                </table>
              </div>
            </div>
            <div class="panel__foot">
              Kept because you may need a reference or a receipt from one of these later.
            </div>
          </div>` : ""}`,
    }));
  });

  /* --- one tenancy --------------------------------------------------------- */

  router.get("/portal/renting/:leaseId", async (ctx) => {
    const { personId, companyId, company } = ctx.person;

    /* Asked before anything is read. The URL carries an id; the id proves
       nothing. */
    const lease = await leaseIfHeld({ personId, companyId, leaseId: ctx.params.leaseId });
    if (!lease) throw new NotFound("That tenancy is not one of yours.");

    const unit = await one(
      `SELECT u.*, p.line1, p.city, p.state, p.zip FROM unit u
         JOIN property p ON p.id = u.property_id WHERE u.id = ?`, lease.unit_id);

    const balance = lease.status === "active"
      ? await balanceFor(lease.id, monthKey(today())) : null;

    const [ledger, jobs, documents, notices] = await Promise.all([
      all(`SELECT * FROM ledger_entry WHERE lease_id = ?
            ORDER BY date DESC, created_at DESC LIMIT 60`, lease.id),
      all(`SELECT w.*, v.name AS vendor_name FROM work_order w
             LEFT JOIN vendor v ON v.id = w.vendor_id
            WHERE w.lease_id = ? ORDER BY w.created_at DESC LIMIT 20`, lease.id),
      all(`SELECT * FROM lease_document WHERE lease_id = ? AND status <> 'void'
            ORDER BY created_at DESC`, lease.id),
      all(`SELECT n.* FROM notice_log n
             JOIN delinquency d ON d.id = n.delinquency_id
            WHERE d.lease_id = ? ORDER BY n.sent_at DESC LIMIT 20`, lease.id),
    ]);

    const roles = await rolesIn(personId, companyId);
    const blocked = blockedReason(lease);

    sendHtml(ctx.res, portalPage({
      title: unit.line1,
      heading: `${unit.line1}${unit.label ? `, unit ${unit.label}` : ""}`,
      lede: `${unit.city}, ${unit.state} ${unit.zip} · ${lease.status === "active"
        ? `since ${human(lease.start_date)}`
        : `${human(lease.start_date)} to ${lease.end_date ? human(lease.end_date) : "—"}`}`,
      person: ctx.person, company,
      tabs: portalTabs(roles), active: "renting",
      body: html`
        ${lease.status !== "active"
          ? notice("ok", "This tenancy has ended",
              "Your records are kept here so you can find a receipt or a reference later.")
          : ""}

        ${balance ? html`
          <div class="grid grid--3">
            <div class="tile"><span class="tile__label">Rent</span><span class="tile__value">${usd(balance.rentCents)}</span></div>
            <div class="tile"><span class="tile__label">Paid this month</span><span class="tile__value">${usd(balance.paidCents)}</span></div>
            <div class="tile"${attr("data-tone", balance.outstandingCents > 0 ? "warn" : "ok")}>
              <span class="tile__label">${balance.outstandingCents > 0 ? "Still owing" : "Nothing owing"}</span>
              <span class="tile__value">${usd(balance.outstandingCents)}</span>
            </div>
          </div>
          ${balance.pendingCents > 0
            ? notice("ok", "A payment is on its way",
                `${usd(balance.pendingCents)} has been authorised and is still clearing.`)
            : ""}
          <div class="btnrow">
            ${blocked
              ? ""
              : html`<a class="pill solid" href="/pay/${lease.pay_token}">Pay rent</a>`}
            <a class="pill outline" href="/report?u=${unit.report_token}">Report a repair</a>
          </div>
          ${blocked ? notice("warn", "Online payment is not available for this home", blocked) : ""}
        ` : ""}

        ${ledgerPanel(ledger)}
        ${jobsPanel(jobs)}
        ${documentsPanel(documents)}
        ${noticesPanel(notices)}`,
    }));
  });
}

/* --- views ------------------------------------------------------------------ */

function tenancyCard({ lease, balance, company }) {
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>${lease.line1}${lease.label ? `, unit ${lease.label}` : ""}</h2>
        <p>Rent ${usd(lease.rent_cents)} on the ${ordinal(lease.rent_due_day)}</p>
      </div>
      <div class="panel__body">
        <div class="grid grid--3">
          <div class="tile"><span class="tile__label">Rent this month</span><span class="tile__value">${usd(balance.rentCents)}</span></div>
          <div class="tile"><span class="tile__label">Paid</span><span class="tile__value">${usd(balance.paidCents)}</span></div>
          <div class="tile"${attr("data-tone", balance.outstandingCents > 0 ? "warn" : "ok")}>
            <span class="tile__label">${balance.outstandingCents > 0 ? "Still owing" : "Nothing owing"}</span>
            <span class="tile__value">${usd(balance.outstandingCents)}</span>
          </div>
        </div>
      </div>
      <div class="panel__foot">
        <div class="btnrow">
          <a class="pill solid sm" href="/portal/renting/${lease.id}">Open</a>
          ${Number(lease.payments_blocked)
            ? ""
            : html`<a class="pill outline sm" href="/pay/${lease.pay_token}">Pay rent</a>`}
        </div>
      </div>
    </div>`;
}

function ledgerPanel(rows) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Your account</h2><p>Everything charged and paid</p></div>
      <div class="panel__body panel__body--flush">
        ${rows.length === 0
          ? html`<div class="panel__body">${empty("Nothing yet", "Charges and payments appear here.")}</div>`
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Date</th><th>What</th><th class="num">Amount</th></tr></thead>
                <tbody>
                  ${rows.map((r) => html`
                    <tr>
                      <td>${human(r.date)}</td>
                      <td>${r.memo || r.kind.replace(/_/g, " ")}</td>
                      <td class="num">${usd(r.amount_cents)}</td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

function jobsPanel(jobs) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Repairs</h2><p>What you have reported, and where it got to</p></div>
      <div class="panel__body panel__body--flush">
        ${jobs.length === 0
          ? html`<div class="panel__body">${empty("Nothing reported", "Anything you report will show its progress here.")}</div>`
          : html`
            <div class="tablewrap">
              <table class="data">
                <thead><tr><th>Reported</th><th>What</th><th>State</th><th></th></tr></thead>
                <tbody>
                  ${jobs.map((j) => html`
                    <tr>
                      <td>${humanStamp(j.created_at)}</td>
                      <td>${j.summary}<div class="cellsub">${j.category}${j.vendor_name ? ` · ${j.vendor_name}` : ""}</div></td>
                      <td><span class="chip"${attr("data-tone", JOB_TONE[j.status] || "")}>${j.status}</span></td>
                      <td class="shrink"><a class="pill outline sm" href="/t/${j.public_token}">Follow</a></td>
                    </tr>`)}
                </tbody>
              </table>
            </div>`}
      </div>
    </div>`;
}

function documentsPanel(documents) {
  if (documents.length === 0) return "";
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Your documents</h2><p>Your lease and anything you have signed</p></div>
      <div class="panel__body panel__body--flush">
        <div class="tablewrap">
          <table class="data">
            <thead><tr><th>Document</th><th>State</th><th></th></tr></thead>
            <tbody>
              ${documents.map((d) => html`
                <tr>
                  <td>${d.title}<div class="cellsub">${humanStamp(d.created_at)}</div></td>
                  <td><span class="chip"${attr("data-tone", d.status === "complete" ? "ok" : "warn")}>${d.status}</span></td>
                  <td class="shrink"><a class="pill outline sm" href="/sign/${d.token}?as=tenant">Open</a></td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function noticesPanel(notices) {
  if (notices.length === 0) return "";
  return html`
    <div class="panel">
      <div class="panel__head">
        <h2>Notices you have been sent</h2>
        <p>So there is no argument later about what was sent and when</p>
      </div>
      <div class="panel__body panel__body--flush">
        <div class="tablewrap">
          <table class="data">
            <thead><tr><th>Sent</th><th>How</th><th>What</th></tr></thead>
            <tbody>
              ${notices.map((n) => html`
                <tr>
                  <td>${humanStamp(n.sent_at)}</td>
                  <td>${n.channel}</td>
                  <td>${n.template_key.replace(/_/g, " ")}</td>
                </tr>`)}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function ordinal(n) {
  const v = Number(n) || 1;
  const s = ["th", "st", "nd", "rd"][((v % 100) - 20) % 10] || ["th", "st", "nd", "rd"][v % 100] || "th";
  return `${v}${s}`;
}
