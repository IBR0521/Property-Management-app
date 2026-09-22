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
import { all, get, one, insert, update, run } from "../lib/db.js";
import { usd, parseMoney } from "../lib/money.js";
import { human, humanStamp, monthKey, today, stamp } from "../lib/dates.js";
import { sendHtml, redirect } from "../lib/http.js";
import { NotFound } from "../lib/db.js";
import { html, attr } from "../lib/render.js";
import { portalPage, notice, empty } from "../views/layout.js";
import { notificationsPanel } from "./push.js";
import { balanceFor, blockedReason } from "../lib/payments.js";
import { leasesFor, leaseIfHeld, rolesIn } from "../lib/identity.js";
import { portalTabs } from "./portal.js";
import { id } from "../lib/ids.js";
import { storeUpload } from "../lib/files.js";
import { DOC_TYPES } from "../lib/http.js";
import { stateFor, record } from "../lib/delivery/consent.js";

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

      /* Only where the lease actually asks for it. Nagging a tenant whose
         lease does not require cover is noise they cannot act on. */
      if (Number(lease.insurance_required) === 1) {
        const live = await get(
          `SELECT id FROM renters_insurance
            WHERE lease_id = ? AND status IN ('pending', 'accepted') AND expires_on > ?`,
          lease.id, today());
        lease.needsInsurance = !live;
      }
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
            <a class="pill outline" href="/portal/renting/${lease.id}/insurance">Renters insurance</a>
            <a class="pill outline" href="/portal/details">Your details</a>
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
      ${lease.needsInsurance
        ? notice("warn", "Your lease requires renters insurance",
            html`We have nothing on file.
                 <a href="/portal/renting/${lease.id}/insurance">Send us the certificate</a>.`)
        : ""}
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

/* ==========================================================================
   What a tenant does for themselves
   --------------------------------------------------------------------------
   Two things, and the restraint in both is the same: the application records
   what the tenant told it and never decides on their behalf.
   ========================================================================== */

export function registerPortalTenantSelfService(router) {
  /* --- renters insurance --------------------------------------------------- */

  router.get("/portal/renting/:leaseId/insurance", async (ctx) => {
    const { personId, companyId, company } = ctx.person;
    const lease = await leaseIfHeld({ personId, companyId, leaseId: ctx.params.leaseId });
    if (!lease) throw new NotFound("That tenancy is not one of yours.");

    const unit = await one(
      `SELECT u.label, p.line1 FROM unit u JOIN property p ON p.id = u.property_id
        WHERE u.id = ?`, lease.unit_id);
    const policies = await all(
      `SELECT * FROM renters_insurance WHERE lease_id = ? ORDER BY uploaded_at DESC`, lease.id);
    const roles = await rolesIn(personId, companyId);

    sendHtml(ctx.res, portalPage({
      title: "Renters insurance",
      heading: "Renters insurance",
      lede: `${unit.line1}${unit.label ? `, unit ${unit.label}` : ""}`,
      person: ctx.person, company,
      tabs: portalTabs(roles), active: "renting",
      body: html`
        ${ctx.query.e ? notice("warn", null, ctx.query.e) : ""}
        ${ctx.query.m ? notice("ok", null, ctx.query.m) : ""}

        ${insuranceState({ lease, policies, company })}

        <div class="panel">
          <div class="panel__head">
            <h2>Upload your policy</h2>
            <p>A PDF or a photo of the certificate</p>
          </div>
          <div class="panel__body">
            <form method="post" action="/portal/renting/${lease.id}/insurance"
                  enctype="multipart/form-data">
              <input type="hidden" name="_csrf" value="${ctx.csrf}" />
              <div class="formgrid formgrid--2">

              <div class="field">
                <label for="carrier">Insurer</label>
                <input id="carrier" name="carrier" type="text" maxlength="120" required />
              </div>
              <div class="field">
                <label for="policy_no">Policy number</label>
                <input id="policy_no" name="policy_no" type="text" maxlength="60" />
              </div>
              <div class="field">
                <label for="expires_on">Expires</label>
                <input id="expires_on" name="expires_on" type="date" required />
                <span class="field__help">
                  We will remind you before this date. Take it from the certificate rather
                  than guessing — it is the date that matters.
                </span>
              </div>
              <div class="field">
                <label for="liability">Liability cover</label>
                <input id="liability" name="liability" type="text" inputmode="decimal"
                       placeholder="100000.00" />
                ${lease.insurance_min_liability_cents
                  ? html`<span class="field__help">
                      Your lease asks for at least ${usd(lease.insurance_min_liability_cents)}.
                    </span>`
                  : ""}
              </div>

              <div class="field">
                <label for="doc">The certificate</label>
                <input id="doc" name="doc" type="file" accept=".pdf,image/*" required />
                <span class="field__help">PDF or a photo, up to 10MB.</span>
              </div>
              </div>

              <div class="btnrow" style="margin-top:1rem">
                <button class="pill solid" type="submit">Send it in</button>
              </div>
            </form>
          </div>
          <div class="panel__foot">
            ${company.name} checks it and confirms. We do not read the document
            automatically — somebody looks at it, so what you type above is what we go by
            until they do.
          </div>
        </div>`,
    }));
  });

  router.post("/portal/renting/:leaseId/insurance", async (ctx) => {
    const { personId, companyId } = ctx.person;
    const lease = await leaseIfHeld({ personId, companyId, leaseId: ctx.params.leaseId });
    if (!lease) throw new NotFound("That tenancy is not one of yours.");

    const back = (q) => redirect(ctx.res, `/portal/renting/${lease.id}/insurance?${q}`);
    const fail = (m) => back(`e=${encodeURIComponent(m)}`);

    const f = ctx.fields;
    const expires = String(f.expires_on || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) return fail("Enter the date the policy expires.");
    if (expires <= today()) {
      return fail("That date has already passed. Check the certificate — we need a policy that is still in force.");
    }

    const file = (ctx.files || []).find((x) => x.field === "doc" && x.bytes > 0);
    if (!file) return fail("Attach the certificate — a PDF or a photo of it.");

    let stored;
    try {
      stored = await storeUpload(file, { allow: DOC_TYPES });
    } catch (err) {
      return fail(err.message);
    }

    /* Everything earlier becomes superseded rather than deleted: a company
       asked "was this tenant insured last March" needs the one that was
       current then, not only the one that is current now. */
    await run(
      `UPDATE renters_insurance SET status = 'superseded'
        WHERE lease_id = ? AND status IN ('pending', 'accepted')`, lease.id);

    await insert("renters_insurance", {
      id: id(), company_id: companyId, lease_id: lease.id,
      carrier: String(f.carrier || "").trim().slice(0, 120) || null,
      policy_no: String(f.policy_no || "").trim().slice(0, 60) || null,
      liability_cents: parseMoney(f.liability) ?? null,
      expires_on: expires,
      doc_path: stored.path, doc_mime: stored.mime,
      status: "pending", uploaded_by: "tenant",
      uploaded_at: stamp(), created_at: stamp(),
    });

    return back(`m=${encodeURIComponent(
      "Thank you — that is with the office now. They will confirm it.")}`);
  });

  /* --- contact details ------------------------------------------------------ */

  router.get("/portal/details", async (ctx) => {
    const { personId, companyId, company } = ctx.person;
    const roles = await rolesIn(personId, companyId);

    /* The phone on the tenancy, which is what the office actually rings — not
       the one on the person, which is platform-level. */
    const tenancies = roles.tenantIds.length
      ? await all(
          `SELECT t.id, t.name, t.phone, u.label, p.line1
             FROM tenant t
             JOIN lease_tenant lt ON lt.tenant_id = t.id
             JOIN lease l ON l.id = lt.lease_id
             JOIN unit u ON u.id = l.unit_id
             JOIN property p ON p.id = u.property_id
            WHERE t.id = ANY(?::text[]) AND l.status = 'active'
            ORDER BY p.line1`, roles.tenantIds)
      : [];

    const consent = await Promise.all(tenancies.map(async (t) => ({
      tenantId: t.id,
      sms: t.phone ? await stateFor(companyId, "sms", t.phone) : null,
    })));
    const smsState = new Map(consent.map((c) => [c.tenantId, c.sms]));

    sendHtml(ctx.res, portalPage({
      title: "Your details", heading: "Your details",
      person: ctx.person, company,
      tabs: portalTabs(roles), active: null,
      body: html`
        ${ctx.query.m ? notice("ok", null, ctx.query.m) : ""}
        ${ctx.query.e ? notice("warn", null, ctx.query.e) : ""}

        <div class="panel">
          <div class="panel__head"><h2>How you sign in</h2></div>
          <div class="panel__body">
            <dl class="dl">
              <div><dt>Email</dt><dd>${ctx.person.email}</dd></div>
            </dl>
            ${notice("ok", "This one cannot be changed here",
              html`Your email address is how you sign in, so changing it needs to be
                   confirmed from the new address. Ask ${company.name}
                   ${company.phone ? html`on <a href="tel:${company.phone}">${company.phone}</a>` : ""}
                   and they will change it for you.`)}
          </div>
        </div>

        ${tenancies.map((t) => html`
          <form method="post" action="/portal/details">
            <input type="hidden" name="_csrf" value="${ctx.csrf}" />
            <input type="hidden" name="tenant_id" value="${t.id}" />
            <div class="panel">
              <div class="panel__head">
                <h2>${t.line1}${t.label ? `, unit ${t.label}` : ""}</h2>
                <p>What the office uses to reach you about this home</p>
              </div>
              <div class="panel__body">
                <div class="field">
                  <label for="phone-${t.id}">Phone number</label>
                  <input id="phone-${t.id}" name="phone" type="tel" inputmode="tel"
                         value="${t.phone || ""}" maxlength="30" />
                  <span class="field__help">
                    The number somebody rings if there is a leak at eleven at night.
                  </span>
                </div>

                <div class="field">
                  <div class="radioset">
                    <label class="radiotile">
                      <input type="checkbox" name="sms_ok"${attr("checked", smsAllowed(smsState.get(t.id)))} />
                      <span>Text me about this home
                        <small>Rent reminders, repair updates and, if it ever happens, an
                        emergency. Untick and we will only email you — except that you can
                        always be texted back if you text us first.</small>
                      </span>
                    </label>
                  </div>
                  ${smsState.get(t.id)?.state === "revoked"
                    ? notice("warn", "Texts are off because you replied STOP",
                        "Ticking the box above turns them back on. You can reply STOP again at any time.")
                    : ""}
                </div>
              </div>
              <div class="panel__foot">
                <button class="pill solid sm" type="submit">Save</button>
              </div>
            </div>
          </form>`)}

        ${tenancies.length === 0
          ? html`<div class="panel"><div class="panel__body">
              ${empty("Nothing to change", "You have no live tenancy with this company.")}
            </div></div>`
          : ""}

        ${await notificationsPanel({ csrf: ctx.csrf, personId, base: "/portal/push" })}
        <script src="/app-assets/js/push.js" defer></script>`,
    }));
  });

  router.post("/portal/details", async (ctx) => {
    const { personId, companyId } = ctx.person;
    const roles = await rolesIn(personId, companyId);
    const tenantId = String(ctx.fields.tenant_id || "");

    /* Their own tenancy, or nothing. The form carries an id; the id proves
       nothing. */
    if (!roles.tenantIds.includes(tenantId)) {
      throw new NotFound("That is not one of your tenancies.");
    }

    const before = await one("SELECT * FROM tenant WHERE id = ?", tenantId);
    const phone = String(ctx.fields.phone || "").trim().slice(0, 30) || null;
    const wantsSms = Boolean(ctx.fields.sms_ok);

    await update("tenant", tenantId, { phone });

    /* Consent is keyed by the number, not by the person, so a new number
       starts with no record of its own — which the sender treats as allowed.
       That would quietly undo an opt-out every time somebody changed their
       phone, so the answer is taken from the box they just ticked and
       recorded against whichever number they are now on. Either way it
       becomes a deliberate act rather than a side effect. */
    if (phone) {
      await record(
        companyId, "sms", phone,
        wantsSms ? "granted" : "revoked",
        "portal",
        `set by the tenant on their own details page`);
    }

    /* The old number, if it changed, is left exactly as it was. They may be
       changing away from it precisely because it was somebody else's. */

    return redirect(ctx.res, `/portal/details?m=${encodeURIComponent("Saved.")}`);
  });
}

/* Ticked when texts may go. No record at all means allowed, which is what the
   sender does, so the box reflects what would actually happen. */
function smsAllowed(state) {
  if (!state) return true;
  return state.state === "granted";
}

function insuranceState({ lease, policies, company }) {
  const live = policies.find((p) => p.status === "accepted" || p.status === "pending");
  const required = Number(lease.insurance_required) === 1;

  const head = !required
    ? notice("ok", "Your lease does not require this",
        "You can still keep a copy here if you want to.")
    : !live
      ? notice("warn", "Nothing on file",
          `Your lease requires renters insurance. Upload the certificate and ${company.name} will confirm it.`)
      : live.status === "pending"
        ? notice("ok", "With the office",
            `Uploaded ${humanStamp(live.uploaded_at)}. Nobody has confirmed it yet.`)
        : live.expires_on <= today()
          ? notice("warn", "That policy has expired", `It ran out on ${human(live.expires_on)}.`)
          : notice("ok", "On file and confirmed", `Runs until ${human(live.expires_on)}.`);

  return html`
    ${head}
    ${policies.length ? html`
      <div class="panel">
        <div class="panel__head"><h2>What you have sent</h2></div>
        <div class="panel__body panel__body--flush">
          <div class="tablewrap">
            <table class="data">
              <thead><tr><th>Sent</th><th>Insurer</th><th>Expires</th><th>State</th></tr></thead>
              <tbody>
                ${policies.map((p) => html`
                  <tr${attr("style", p.status === "superseded" ? "opacity:0.55" : null)}>
                    <td>${humanStamp(p.uploaded_at)}</td>
                    <td>${p.carrier || "—"}${p.policy_no ? html`<div class="cellsub">${p.policy_no}</div>` : ""}</td>
                    <td>${human(p.expires_on)}</td>
                    <td>
                      <span class="chip"${attr("data-tone",
                        p.status === "accepted" ? "ok" : p.status === "rejected" ? "danger"
                        : p.status === "pending" ? "warn" : "")}>${p.status}</span>
                      ${p.status === "rejected" && p.review_note
                        ? html`<div class="cellsub">${p.review_note}</div>` : ""}
                    </td>
                  </tr>`)}
              </tbody>
            </table>
          </div>
        </div>
      </div>` : ""}`;
}
