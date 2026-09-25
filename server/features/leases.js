/* F8  Lease documents, templates and electronic signatures.

   What makes an electronic signature hold up is not a cursive font. It is
   being able to show, years later, exactly which bytes somebody agreed to and
   what was recorded at the moment they agreed. Three things follow from that,
   and they are the reason this file is shaped the way it is.

   The document is compiled once and frozen. A template is an author's working
   copy and changes whenever they like; the moment a document goes out for
   signature its text is fixed and hashed, and it is never re-rendered from the
   template again.

   A document with unresolved tokens cannot be sent. A lease that still says
   {{rent_amount}} is not a lease, and the compiler reports what is missing
   rather than quietly leaving the braces in.

   Every signature stores the document hash it was applied to. If the stored
   body is ever altered the hashes stop matching, and the page says so instead
   of showing a tampered document as though it were signed. */
import { all, get, one, insert, update, tx, NotFound } from "../lib/db.js";
import { id, token } from "../lib/ids.js";
import { stamp, human, humanStamp, today } from "../lib/dates.js";
import { usd } from "../lib/money.js";
import { sendHtml, redirect, BadRequest } from "../lib/http.js";
import { html, raw, attr } from "../lib/render.js";
import { appPage, publicPage, notice, empty, tabs } from "../views/layout.js";
import { navCounts } from "../lib/counts.js";
import { compile, markdownToHtml, tokensUsed } from "../lib/template.js";
import { sha256, hashesMatch } from "../lib/crypto.js";
import { clientIp } from "../lib/ratelimit.js";

const PARTY_LABEL = {
  tenant: "Tenant", manager: "Property manager", owner: "Owner",
  guarantor: "Guarantor", witness: "Witness",
};

const LEASE_TABS = [
  { key: "documents", href: "/app/leases", label: "Documents" },
  { key: "templates", href: "/app/leases/templates", label: "Templates" },
];

/* --- the variables a template may use ------------------------------------- */

/* Assembled from the live rows at compile time. Everything is pre-formatted:
   a template author should never have to think about cents, and a lease that
   says 98500 instead of $985.00 is a lease that goes back to the lawyer. */
export async function leaseVars(companyId, leaseId) {
  const lease = await one(
    `SELECT l.*, u.label, u.beds, u.baths, u.sqft,
            p.line1, p.city, p.state, p.zip,
            o.name AS owner_name, o.email AS owner_email,
            c.name AS company_name, c.phone AS company_phone
       FROM lease l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       JOIN owner o ON o.id = p.owner_id
       JOIN company c ON c.id = l.company_id
      WHERE l.id = ? AND l.company_id = ?`, leaseId, companyId);

  const tenants = await all(
    `SELECT t.* FROM tenant t JOIN lease_tenant lt ON lt.tenant_id = t.id
      WHERE lt.lease_id = ?`, leaseId);

  const address = `${lease.line1}${lease.label ? `, Unit ${lease.label}` : ""}`;
  return {
    vars: {
      company_name: lease.company_name,
      company_phone: lease.company_phone || "",
      owner_name: lease.owner_name,
      tenant_name: tenants.map((t) => t.name).join(" and ") || "",
      tenant_email: tenants.map((t) => t.email).filter(Boolean).join(", ") || "",
      tenant_phone: tenants.map((t) => t.phone).filter(Boolean).join(", ") || "",
      unit_address: address,
      unit_city: lease.city,
      unit_state: lease.state,
      unit_zip: lease.zip,
      unit_full_address: `${address}, ${lease.city}, ${lease.state} ${lease.zip}`,
      unit_beds: lease.beds == null ? "" : String(lease.beds),
      unit_baths: lease.baths == null ? "" : String(lease.baths),
      unit_sqft: lease.sqft == null ? "" : String(lease.sqft),
      rent_amount: usd(lease.rent_cents),
      deposit_amount: usd(lease.deposit_cents),
      rent_due_day: String(lease.rent_due_day),
      grace_days: String(lease.grace_days),
      lease_start: human(lease.start_date),
      lease_end: lease.end_date ? human(lease.end_date) : "month to month",
      today: human(today()),
    },
    lease, tenants,
  };
}

/* --- documents ------------------------------------------------------------ */

/* Compiles, hashes and stores. Refuses to produce a document with unresolved
   tokens unless the caller explicitly wants a draft to keep working on. */
export async function buildDocument({
  companyId, leaseId, templateId, title, createdBy, allowIncomplete = false,
}) {
  const tpl = await one(
    "SELECT * FROM lease_template WHERE id = ? AND company_id = ?", templateId, companyId);
  const { vars, lease } = await leaseVars(companyId, leaseId);
  const { text, missing } = compile(tpl.body_md, vars);

  if (missing.length && !allowIncomplete) {
    throw new BadRequest(
      `This document still has unfilled fields: ${missing.map((m) => `{{${m}}}`).join(", ")}. ` +
      `Fill in the missing record first — a lease with a placeholder in it is not a lease.`);
  }

  const docId = id();
  await insert("lease_document", {
    id: docId, company_id: companyId, lease_id: leaseId, unit_id: lease.unit_id,
    template_id: tpl.id, title: title || tpl.name,
    body_md: text, body_hash: sha256(text),
    status: "draft", token: null,
    required: JSON.stringify(["tenant", "manager"]),
    created_by: createdBy, created_at: stamp(),
  });
  return { docId, missing };
}

/* Has the stored body been altered since it was hashed? Signatures are
   worthless if this is ever true, so it is checked on every read rather than
   trusted. */
export function documentIntact(doc) {
  return hashesMatch(sha256(doc.body_md), doc.body_hash);
}

async function signatureState(doc) {
  const signatures = await all(
    "SELECT * FROM lease_signature WHERE document_id = ? ORDER BY signed_at", doc.id);
  /* Parsed *and* shaped. The catch alone was not enough: `JSON.parse` is
     happy with `1` or `"tenant"` or `null`, all of which are valid JSON and
     none of which has `.filter`, so a row whose column held anything but an
     array took the page down with a TypeError rather than falling back.
     Nothing in the application writes one — the default is a JSON array and
     so is every insert — but an import, a migration or a hand-run UPDATE can,
     and the fallback exists precisely for the case nobody planned. */
  const DEFAULT_REQUIRED = ["tenant", "manager"];
  let required;
  try {
    const parsed = JSON.parse(doc.required);
    required = Array.isArray(parsed) && parsed.every((r) => typeof r === "string")
      ? parsed : DEFAULT_REQUIRED;
  } catch { required = DEFAULT_REQUIRED; }
  const signed = new Set(signatures.map((s) => s.party_type));
  const outstanding = required.filter((r) => !signed.has(r));
  return { signatures, required, outstanding, complete: outstanding.length === 0 };
}

export function registerLeases(router) {
  /* --- public signing page, no account ---------------------------------- */

  /* Registered before the /app routes for the same reason every other public
     page is: this URL is what a tenant is sent, and it must not sit behind a
     staff session. */
  router.get("/sign/:tok", async (ctx) => {
    const doc = await get(
      `SELECT d.*, c.name AS company_name, c.phone AS company_phone
         FROM lease_document d JOIN company c ON c.id = d.company_id
        WHERE d.token = ?`, ctx.params.tok);
    if (!doc || doc.status === "void") throw new NotFound("That signing link is no longer valid.");

    const company = { name: doc.company_name, phone: doc.company_phone };
    const state = await signatureState(doc);
    const party = String(ctx.query.as || "tenant");

    if (!documentIntact(doc)) {
      return sendHtml(ctx.res, publicPage({
        company, title: "Document unavailable", heading: "We cannot show this document",
        body: notice("danger", "This document failed its integrity check",
          "Its contents no longer match what was recorded when it was prepared. Nobody should sign it. Please contact us."),
      }), 409);
    }

    const alreadySigned = state.signatures.find((s) => s.party_type === party);

    sendHtml(ctx.res, publicPage({
      company, title: `${doc.title} · ${company.name}`,
      heading: doc.title,
      lede: state.complete
        ? "This document is fully signed. Your copy is below."
        : "Read this in full, then sign at the bottom.",
      body: html`
        ${ctx.query.e ? notice("warn", null, decodeURIComponent(ctx.query.e)) : ""}
        ${state.complete ? notice("ok", "Fully signed",
          `Completed ${doc.completed_at ? humanStamp(doc.completed_at) : ""}.`) : ""}
        <div class="panel">
          <div class="panel__body doc">${raw(markdownToHtml(doc.body_md))}</div>
          <div class="panel__foot">
            Document reference ${doc.id.slice(-8)} · fingerprint ${doc.body_hash.slice(0, 16)}…
          </div>
        </div>

        ${state.signatures.length ? html`
          <div class="panel">
            <div class="panel__head"><h2>Signed by</h2></div>
            <div class="panel__body">
              <div class="sig">
                ${state.signatures.map((s) => html`
                  <div class="sig__row">
                    <div class="sig__who">
                      <b>${s.typed_name}</b>
                      <span class="sig__role">${PARTY_LABEL[s.party_type] || s.party_type}</span>
                    </div>
                    <div class="sig__meta">
                      <span>${humanStamp(s.signed_at)}</span>
                      <span>${s.party_email}</span>
                    </div>
                  </div>`)}
              </div>
            </div>
          </div>` : ""}

        ${alreadySigned ? notice("ok", "You have signed this",
            `Recorded ${humanStamp(alreadySigned.signed_at)}. Keep this link for your records.`)
          : state.complete ? ""
          : signForm({ doc, party, csrf: ctx.csrf })}`,
    }));
  });

  router.post("/sign/:tok", async (ctx) => {
    const doc = await get("SELECT * FROM lease_document WHERE token = ?", ctx.params.tok);
    if (!doc || doc.status === "void") throw new NotFound("That signing link is no longer valid.");

    const back = (m) => redirect(ctx.res,
      `/sign/${ctx.params.tok}?as=${encodeURIComponent(ctx.fields.party_type || "tenant")}&e=${encodeURIComponent(m)}`);

    /* Refuse to record a signature against a document whose text has changed
       since it was prepared. Signing an altered document is the exact failure
       this whole design exists to prevent. */
    if (!documentIntact(doc)) return back("This document failed its integrity check and cannot be signed.");

    const f = ctx.fields;
    const partyType = String(f.party_type || "");
    if (!PARTY_LABEL[partyType]) return back("Pick who you are signing as.");

    const typed = String(f.typed_name || "").trim();
    if (typed.length < 2) return back("Type your full legal name to sign.");
    const email = String(f.party_email || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back("We need a valid email address for your copy.");
    /* ESIGN and UETA both turn on the signer having agreed to transact
       electronically. Recorded as its own field, because "they clicked the
       button" is not the same fact. */
    if (f.consent !== "yes") return back("Tick the box to agree to sign electronically.");

    const signedAt = stamp();
    const ip = clientIp(ctx.req) || "unknown";
    const ua = String(ctx.req.headers["user-agent"] || "unknown").slice(0, 400);

    /* The mark itself: a hash binding the exact document, the party, what they
       typed, when, and from where. Any one of those changing produces a
       different hash, which is what makes the record checkable later. */
    const signatureHash = sha256(
      [doc.body_hash, partyType, typed.toLowerCase(), email.toLowerCase(), signedAt, ip].join("|"));

    try {
      await tx(async () => {
        await insert("lease_signature", {
          id: id(), document_id: doc.id, party_type: partyType,
          party_name: typed, party_email: email, typed_name: typed,
          signature_hash: signatureHash, document_hash: doc.body_hash,
          signed_at: signedAt, ip, user_agent: ua,
          consent_esign: 1, created_at: signedAt,
        });

        const state = await signatureState(doc);
        if (state.complete) {
          await update("lease_document", doc.id, { status: "signed", completed_at: signedAt });
          /* Only when the last party has signed. A webhook per signature would
             fire three times for one lease and mean nothing on any of them. */
          const [{ emit }, { leaseSignedPayload }] = await Promise.all([
            import("../lib/webhooks/events.js"), import("../lib/webhooks/payloads.js")]);
          await emit({
            companyId: doc.company_id, event: "lease.signed",
            data: await leaseSignedPayload(doc.id),
          });
        }
      });
    } catch (err) {
      // The unique index is what stops a double submission becoming two marks.
      if (String(err.message).includes("duplicate key")) return back("You have already signed this document.");
      throw err;
    }

    redirect(ctx.res, `/sign/${ctx.params.tok}?as=${encodeURIComponent(partyType)}`);
  });

  /* --- staff: documents -------------------------------------------------- */

  router.get("/app/leases", async (ctx) => {
    const cid = ctx.staff.company_id;
    const docs = await all(
      `SELECT d.*, p.line1, u.label,
              (SELECT COUNT(*) FROM lease_signature s WHERE s.document_id = d.id)::int AS signatures
         FROM lease_document d
         LEFT JOIN unit u ON u.id = d.unit_id
         LEFT JOIN property p ON p.id = u.property_id
        WHERE d.company_id = ? ORDER BY d.created_at DESC LIMIT 100`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "leases", counts: await navCounts(cid),
      title: "Lease documents", subtitle: `${docs.length} document${docs.length === 1 ? "" : "s"}`,
      actions: html`<a class="pill solid sm" href="/app/leases/new">New document</a>`,
      body: html`
        ${tabs(LEASE_TABS, "documents")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${docs.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Document</th><th>Property</th><th>Status</th><th class="num">Signatures</th><th class="shrink"></th></tr></thead>
            <tbody>${docs.map((d) => html`
              <tr>
                <td><a href="/app/leases/d/${d.id}">${d.title}</a>
                  <span class="cellsub">${humanStamp(d.created_at)}</span></td>
                <td>${d.line1 || "—"}${d.label ? ` · ${d.label}` : ""}</td>
                <td><span class="chip"${attr("data-tone",
                  d.status === "signed" ? "ok" : d.status === "void" ? null : "warn")}>${d.status.replace(/_/g, " ")}</span></td>
                <td class="num">${d.signatures}</td>
                <td class="shrink"><a class="pill outline sm" href="/app/leases/d/${d.id}"
                  ${attr("aria-label", `Open the document ${d.title}`)}>Open</a></td>
              </tr>`)}</tbody></table></div>`
            : empty("No documents yet", "Create a template first, then build a document from it.")}
        </div></div>`,
    }));
  });

  router.get("/app/leases/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const templates = await all(
      "SELECT id, name, kind FROM lease_template WHERE company_id = ? AND active = 1 ORDER BY name", cid);
    const leases = await all(
      `SELECT l.id, p.line1, u.label,
              (SELECT string_agg(t.name, ' and ') FROM tenant t
                 JOIN lease_tenant lt ON lt.tenant_id = t.id WHERE lt.lease_id = l.id) AS tenants
         FROM lease l JOIN unit u ON u.id = l.unit_id JOIN property p ON p.id = u.property_id
        WHERE l.company_id = ? AND l.status = 'active' ORDER BY p.line1, u.label`, cid);

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "leases", counts: await navCounts(cid),
      title: "New document", subtitle: "A template, filled in from a tenancy",
      body: templates.length && leases.length
        ? newDocumentForm({ csrf: ctx.csrf, templates, leases, error: ctx.query.e })
        : empty(
            !templates.length ? "No templates yet" : "No active tenancies",
            !templates.length
              ? "A document is a template filled in from a tenancy. Write the template first."
              : "Move somebody in first — a lease document needs a tenancy to draw its details from."),
    }));
  });

  router.post("/app/leases/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    try {
      const { docId, missing } = await buildDocument({
        companyId: cid, leaseId: String(f.lease_id || ""), templateId: String(f.template_id || ""),
        title: String(f.title || "").trim(), createdBy: ctx.staff.id,
        allowIncomplete: f.allow_incomplete === "yes",
      });
      const note = missing.length
        ? `Document created, but ${missing.length} field(s) are still unfilled.`
        : "Document created and every field filled.";
      redirect(ctx.res, `/app/leases/d/${docId}?m=${encodeURIComponent(note)}`);
    } catch (err) {
      return redirect(ctx.res, `/app/leases/new?e=${encodeURIComponent(err.message)}`);
    }
  });

  router.get("/app/leases/d/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const doc = await one(
      "SELECT * FROM lease_document WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const state = await signatureState(doc);
    const intact = documentIntact(doc);
    const unresolved = tokensUsed(doc.body_md);
    const origin = `${ctx.url.protocol}//${ctx.url.host}`;

    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "leases", counts: await navCounts(cid),
      title: doc.title,
      subtitle: `${doc.status.replace(/_/g, " ")} · created ${humanStamp(doc.created_at)}`,
      actions: html`<a class="pill outline sm" href="/app/leases">All documents</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${intact ? "" : notice("danger", "Integrity check failed",
          "The stored text no longer matches the fingerprint recorded when this document was created. Do not rely on any signature on it.")}
        ${unresolved.length ? notice("warn", "Unfilled fields",
          html`This document still contains ${unresolved.map((t) => html`<code>{{${t}}}</code> `)} — it cannot be sent until the underlying records are complete.`) : ""}

        <div class="hub">
          <div class="hub__col">
            <div class="panel">
              <div class="panel__head"><h2>Document</h2>
                <span class="chip"${attr("data-tone", doc.status === "signed" ? "ok" : "warn")}>${doc.status.replace(/_/g, " ")}</span></div>
              <div class="panel__body doc">${raw(markdownToHtml(doc.body_md))}</div>
            </div>
          </div>

          <div class="hub__col">
            <div class="panel">
              <div class="panel__head"><h2>Signatures</h2><p>${state.signatures.length} of ${state.required.length}</p></div>
              <div class="panel__body">
                ${state.signatures.length ? html`<div class="sig">
                  ${state.signatures.map((s) => {
                    const ok = hashesMatch(s.document_hash, doc.body_hash);
                    return html`
                    <div class="sig__row">
                      <div class="sig__who">
                        <b>${s.typed_name}</b>
                        <span class="sig__role">${PARTY_LABEL[s.party_type] || s.party_type}</span>
                      </div>
                      <div class="sig__meta">
                        <span>${humanStamp(s.signed_at)}</span>
                        <span>${s.party_email}</span>
                        <span>IP ${s.ip}</span>
                        <span class="sig__mark">mark ${s.signature_hash.slice(0, 24)}…</span>
                      </div>
                      <div style="margin-top:0.5rem">
                        ${ok
                          ? html`<span class="chip" data-tone="ok">matches this document</span>`
                          : html`<span class="chip" data-tone="danger">signed a different version</span>`}
                      </div>
                    </div>`;
                  })}
                </div>` : html`<p class="lede" style="margin:0">Nobody has signed yet.</p>`}
                ${state.outstanding.length ? html`
                  <p class="lede" style="margin:0.75rem 0 0">
                    Waiting on: ${state.outstanding.map((o) => PARTY_LABEL[o] || o).join(", ")}
                  </p>` : ""}
              </div>
            </div>

            <div class="panel">
              <div class="panel__head"><h2>Signing link</h2></div>
              <div class="panel__body">
                ${doc.token ? html`
                  <p class="lede" style="margin:0 0 0.5rem">Send this to whoever still has to sign.</p>
                  <span class="longval">${origin}/sign/${doc.token}</span>`
                : html`
                  <p class="lede" style="margin:0 0 0.75rem">
                    No link yet. Issuing one freezes this text as the version being signed.
                  </p>
                  ${unresolved.length || !intact ? html`
                    <p class="lede" style="margin:0"><b>Cannot be sent</b> until the problems above are resolved.</p>`
                  : html`
                    <form method="post" action="/app/leases/d/${doc.id}/send">
                      <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                      <button class="pill solid" type="submit">Issue signing link</button>
                    </form>`}`}
              </div>
              <div class="panel__foot">Fingerprint ${doc.body_hash.slice(0, 24)}…</div>
            </div>

            ${doc.status === "void" ? "" : html`
              <div class="panel">
                <div class="panel__head"><h2>Void this document</h2></div>
                <div class="panel__body">
                  <form method="post" action="/app/leases/d/${doc.id}/void" class="formgrid">
                    <input type="hidden" name="_csrf" value="${ctx.csrf}" />
                    <div class="field">
                      <label for="reason">Reason</label>
                      <input id="reason" name="reason" type="text" required maxlength="200" />
                      <span class="field__help">Voiding cannot be undone. The document and
                        any signatures on it stay on the record, marked void with this
                        reason — send a fresh one to replace it.</span>
                    </div>
                    <button class="pill outline" type="submit">Void</button>
                  </form>
                  <span class="field__help" style="display:block;margin-top:0.5rem">
                    Voiding stops the link working. Signatures already recorded stay on the record —
                    they are evidence, and the database will not delete them.
                  </span>
                </div>
              </div>`}
          </div>
        </div>`,
    }));
  });

  router.post("/app/leases/d/:id/send", async (ctx) => {
    const cid = ctx.staff.company_id;
    const doc = await one(
      "SELECT * FROM lease_document WHERE id = ? AND company_id = ?", ctx.params.id, cid);

    const unresolved = tokensUsed(doc.body_md);
    if (unresolved.length) {
      throw new BadRequest("This document still has unfilled fields and cannot be sent.");
    }
    if (!documentIntact(doc)) {
      throw new BadRequest("This document failed its integrity check and cannot be sent.");
    }

    await update("lease_document", doc.id, {
      token: doc.token || token(), status: "out_for_signature", sent_at: stamp(),
    });
    redirect(ctx.res, `/app/leases/d/${doc.id}?m=${encodeURIComponent("Signing link issued. This text is now the version being signed.")}`);
  });

  router.post("/app/leases/d/:id/void", async (ctx) => {
    const cid = ctx.staff.company_id;
    const doc = await one(
      "SELECT * FROM lease_document WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    await update("lease_document", doc.id, {
      status: "void", token: null,
      void_reason: String(ctx.fields.reason || "").trim() || "no reason given",
    });
    redirect(ctx.res, `/app/leases/d/${doc.id}?m=${encodeURIComponent("Document voided. Existing signatures remain on the record.")}`);
  });

  /* --- staff: templates -------------------------------------------------- */

  router.get("/app/leases/templates", async (ctx) => {
    const cid = ctx.staff.company_id;
    const rows = await all(
      "SELECT * FROM lease_template WHERE company_id = ? ORDER BY name", cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "leases", counts: await navCounts(cid),
      title: "Templates", subtitle: `${rows.length} template${rows.length === 1 ? "" : "s"}`,
      actions: html`<a class="pill solid sm" href="/app/leases/templates/new">New template</a>`,
      body: html`
        ${tabs(LEASE_TABS, "templates")}
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        <div class="panel"><div class="panel__body panel__body--flush">
          ${rows.length ? html`<div class="tablewrap tablewrap--narrow"><table class="data">
            <thead><tr><th>Name</th><th>Kind</th><th>Fields used</th><th class="shrink"></th></tr></thead>
            <tbody>${rows.map((t) => html`
              <tr>
                <td><a href="/app/leases/templates/${t.id}">${t.name}</a></td>
                <td>${t.kind}</td>
                <td><span class="cellsub">${tokensUsed(t.body_md).length} fields</span></td>
                <td class="shrink"><a class="pill outline sm" href="/app/leases/templates/${t.id}"
                  ${attr("aria-label", `Edit the template ${t.name}`)}>Edit</a></td>
              </tr>`)}</tbody></table></div>`
            : empty("No templates yet", "A template is the lease text with {{fields}} where the details go.")}
        </div></div>`,
    }));
  });

  router.get("/app/leases/templates/new", async (ctx) => {
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "leases", counts: await navCounts(ctx.staff.company_id),
      title: "New template", subtitle: "Markdown, with {{fields}} for the details",
      body: templateForm({ csrf: ctx.csrf, tpl: null, error: ctx.query.e }),
    }));
  });

  router.post("/app/leases/templates/new", async (ctx) => {
    const cid = ctx.staff.company_id;
    const f = ctx.fields;
    const name = String(f.name || "").trim();
    const body = String(f.body_md || "").trim();
    if (name.length < 2 || body.length < 20) {
      return redirect(ctx.res, `/app/leases/templates/new?e=${encodeURIComponent("A template needs a name and a body.")}`);
    }
    const tid = id();
    await insert("lease_template", {
      id: tid, company_id: cid, name,
      kind: ["lease", "addendum", "notice", "renewal"].includes(f.kind) ? f.kind : "lease",
      body_md: body, active: 1, created_at: stamp(), updated_at: stamp(),
    });
    redirect(ctx.res, `/app/leases/templates/${tid}?m=${encodeURIComponent("Template saved.")}`);
  });

  router.get("/app/leases/templates/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const tpl = await one(
      "SELECT * FROM lease_template WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    sendHtml(ctx.res, appPage({
      staff: ctx.staff, csrf: ctx.csrf, active: "leases", counts: await navCounts(cid),
      title: tpl.name, subtitle: `${tpl.kind} · ${tokensUsed(tpl.body_md).length} fields used`,
      actions: html`<a class="pill outline sm" href="/app/leases/templates">All templates</a>`,
      body: html`
        ${ctx.flash ? notice("ok", null, ctx.flash) : ""}
        ${templateForm({ csrf: ctx.csrf, tpl, error: ctx.query.e })}`,
    }));
  });

  router.post("/app/leases/templates/:id", async (ctx) => {
    const cid = ctx.staff.company_id;
    const tpl = await one(
      "SELECT * FROM lease_template WHERE id = ? AND company_id = ?", ctx.params.id, cid);
    const f = ctx.fields;
    await update("lease_template", tpl.id, {
      name: String(f.name || tpl.name).trim(),
      kind: ["lease", "addendum", "notice", "renewal"].includes(f.kind) ? f.kind : tpl.kind,
      body_md: String(f.body_md || tpl.body_md),
      active: f.active === "no" ? 0 : 1,
      updated_at: stamp(),
    });
    /* Documents already built from this template keep their own frozen text —
       editing here changes nothing that has already gone out. */
    redirect(ctx.res, `/app/leases/templates/${tpl.id}?m=${encodeURIComponent("Template updated. Documents already created keep the text they were built with.")}`);
  });
}

/* --- views ---------------------------------------------------------------- */

const FIELD_HELP = [
  "company_name", "owner_name", "tenant_name", "tenant_email", "tenant_phone",
  "unit_address", "unit_full_address", "unit_city", "unit_state", "unit_zip",
  "unit_beds", "unit_baths", "unit_sqft",
  "rent_amount", "deposit_amount", "rent_due_day", "grace_days",
  "lease_start", "lease_end", "today",
];

function templateForm({ csrf, tpl, error }) {
  const action = tpl ? `/app/leases/templates/${tpl.id}` : "/app/leases/templates/new";
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>${tpl ? "Edit template" : "New template"}</h2></div>
      <div class="panel__body">
        <form method="post" action="${action}" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="name">Name</label>
              <input id="name" name="name" type="text" required maxlength="120"
                     value="${tpl ? tpl.name : ""}" placeholder="Standard 12-month residential lease" />
            </div>
            <div class="field">
              <label for="kind">Kind</label>
              <select id="kind" name="kind">
                ${["lease", "addendum", "notice", "renewal"].map((k) => html`
                  <option value="${k}"${attr("selected", tpl && tpl.kind === k)}>${k}</option>`)}
              </select>
            </div>
          </div>
          <div class="field">
            <label for="body_md">Body</label>
            <textarea id="body_md" name="body_md" rows="22" required
                      style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.8125rem"
            >${tpl ? tpl.body_md : ""}</textarea>
            <span class="field__help">
              Markdown. <b>#</b> for headings, <b>**bold**</b>, <b>1.</b> for numbered clauses.
            </span>
          </div>
          ${tpl ? html`
            <div class="field">
              <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">Available</span>
              <div class="radioset">
                <label class="radiotile"><input type="radio" name="active" value="yes"${attr("checked", tpl.active)} /><span>In use</span></label>
                <label class="radiotile"><input type="radio" name="active" value="no"${attr("checked", !tpl.active)} /><span>Retired</span></label>
              </div>
            </div>` : ""}
          <div class="btnrow">
            <button class="pill solid" type="submit">${tpl ? "Save template" : "Create template"}</button>
            <a class="pill outline" href="/app/leases/templates">Cancel</a>
          </div>
        </form>
      </div>
    </div>

    <div class="panel">
      <div class="panel__head"><h2>Fields you can use</h2></div>
      <div class="panel__body">
        <p class="lede" style="margin:0 0 0.75rem">
          Type these anywhere in the body. Each one is replaced with the real value when a
          document is built. A field with no value left to fill blocks the document from being sent.
        </p>
        <div class="btnrow">
          ${FIELD_HELP.map((f) => html`<span class="chip chip--plain">{{${f}}}</span>`)}
        </div>
      </div>
    </div>`;
}

function newDocumentForm({ csrf, templates, leases, error }) {
  return html`
    ${error ? notice("warn", null, decodeURIComponent(error)) : ""}
    <div class="panel">
      <div class="panel__head"><h2>Build a document</h2></div>
      <div class="panel__body">
        <form method="post" action="/app/leases/new" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <label for="template_id">Template</label>
            <select id="template_id" name="template_id" required>
              <option value="">Choose a template…</option>
              ${templates.map((t) => html`<option value="${t.id}">${t.name} (${t.kind})</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="lease_id">Tenancy</label>
            <select id="lease_id" name="lease_id" required>
              <option value="">Choose the tenancy…</option>
              ${leases.map((l) => html`
                <option value="${l.id}">${l.line1}${l.label ? ` · ${l.label}` : ""} — ${l.tenants || "no tenant recorded"}</option>`)}
            </select>
            <span class="field__help">Every {{field}} is filled from this tenancy's records.</span>
          </div>
          <div class="field">
            <label for="title">Title <span style="color:var(--ink-soft);font-weight:400">(optional)</span></label>
            <input id="title" name="title" type="text" maxlength="160" placeholder="Defaults to the template name" />
          </div>
          <div class="field">
            <label class="consent">
              <input type="checkbox" name="allow_incomplete" value="yes" />
              <span>Create it even if some fields cannot be filled — I will fix the records and rebuild</span>
            </label>
          </div>
          <div class="btnrow">
            <button class="pill solid" type="submit">Build document</button>
            <a class="pill outline" href="/app/leases">Cancel</a>
          </div>
        </form>
      </div>
    </div>`;
}

function signForm({ doc, party, csrf }) {
  return html`
    <div class="panel">
      <div class="panel__head"><h2>Sign this document</h2></div>
      <div class="panel__body">
        <form method="post" action="/sign/${doc.token}" class="formgrid">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <div class="field">
            <span style="display:block;font-size:0.8125rem;font-weight:600;margin-bottom:0.4375rem">I am signing as</span>
            <div class="radioset">
              ${["tenant", "manager", "owner", "guarantor"].map((p) => html`
                <label class="radiotile">
                  <input type="radio" name="party_type" value="${p}"${attr("checked", party === p)} required />
                  <span>${PARTY_LABEL[p]}</span>
                </label>`)}
            </div>
          </div>
          <div class="formgrid formgrid--2">
            <div class="field">
              <label for="typed_name">Your full legal name</label>
              <input id="typed_name" name="typed_name" type="text" required maxlength="120" autocomplete="name" />
              <span class="field__help">Typing your name here is your signature.</span>
            </div>
            <div class="field">
              <label for="party_email">Email</label>
              <input id="party_email" name="party_email" type="email" required maxlength="160" autocomplete="email" />
              <span class="field__help">Where your copy goes.</span>
            </div>
          </div>
          <div class="field">
            <label class="consent">
              <input type="checkbox" name="consent" value="yes" required />
              <span>I agree to sign this document electronically, and I have read it in full.</span>
            </label>
          </div>
          <button class="pill solid" type="submit">Sign</button>
        </form>
      </div>
      <div class="panel__foot">
        For your protection we record the date and time, your IP address and your browser
        with this signature, along with a fingerprint of the exact document you signed.
      </div>
    </div>`;
}
