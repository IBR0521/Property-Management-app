/* Page shells.

   Every app document links the marketing stylesheet first and app.css second,
   so the app inherits the site's palette, type and components verbatim and
   only adds layout on top. */
import { html, doc, raw, attr } from "../lib/render.js";
import { icons } from "./icons.js";
import { can, roleLabel } from "../lib/auth.js";

const HEAD = (title) => html`
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/css/styles.css" />
<link rel="stylesheet" href="/app-assets/app.css" />`;

/* --- navigation ----------------------------------------------------------- */

/* Four destinations, plus the two sections that only some roles hold. Items
   carry the capability they need so the sidebar shows a person what they can
   actually open — a nav full of links that 403 is worse than a shorter nav. */
const NAV = [
  { group: null, items: [
    { href: "/app", key: "queue", icon: "inbox", label: "Queue", badge: "queue" },
    { href: "/app/portfolio", key: "properties", icon: "home", label: "Properties", badge: "properties" },
    { href: "/app/owners", key: "people", icon: "users", label: "People", badge: "people", need: "money.view" },
  ] },
  { group: "Money", items: [
    { href: "/app/accounting", key: "accounting", icon: "cash", label: "Accounting", need: "money.view" },
    { href: "/app/banking", key: "banking", icon: "loop", label: "Banking", need: "bank.link" },
    { href: "/app/vendors", key: "vendors", icon: "wrench", label: "Contractors", need: "vendor.manage" },
  ] },
  { group: "Leasing", items: [
    { href: "/app/listings", key: "listings", icon: "key", label: "Vacancies", need: "leasing.work" },
    { href: "/app/leases", key: "leases", icon: "doc", label: "Lease documents", need: "leasing.work" },
  ] },
  { group: null, items: [
    { href: "/app/jobs", key: "jobs", icon: "wrench", label: "Your jobs", need: "maintenance.own" },
    { href: "/app/messages", key: "messages", icon: "send", label: "Messages" },
    { href: "/app/staff", key: "staff", icon: "users", label: "People", need: "staff.manage" },
    { href: "/app/company", key: "company", icon: "home", label: "Company", need: "settings.manage" },
    { href: "/app/setup", key: "setup", icon: "cog", label: "Setup", need: "settings.manage" },
  ] },
];

/* Secondary views. These used to be top-level destinations, which meant a
   manager had to visit six screens to find out whether anything was wrong. */
export const PROPERTY_TABS = [
  { key: "units", href: "/app/portfolio", label: "Units" },
  { key: "rent", href: "/app/rent", label: "Rent" },
  { key: "deadlines", href: "/app/compliance", label: "Deadlines" },
  { key: "turns", href: "/app/turns", label: "Turns" },
  { key: "repairs", href: "/app/maintenance", label: "Repairs" },
];

export const PEOPLE_TABS = [
  { key: "owners", href: "/app/owners", label: "Owners" },
  { key: "applicants", href: "/app/applications", label: "Applicants" },
];

export const tabs = (items, current) => html`
  <nav class="tabs" aria-label="Views">
    ${items.map((t) => html`
      <a class="tab" href="${t.href}"${attr("aria-current", t.key === current ? "page" : null)}>${t.label}</a>`)}
  </nav>`;

function navBadge(counts, key) {
  const c = counts && counts[key];
  if (!c || !c.n) return "";
  return html`<span class="navlink__count"${attr("data-tone", c.tone)}>${c.n}</span>`;
}

export function appPage({ staff, active, title, subtitle, actions, body, counts = {}, csrf }) {
  return doc(html`
<html lang="en">
<head>${HEAD(`${title} · ${staff.company_name}`)}</head>
<body class="antialiased">
<div class="shell">
  <nav class="shell__nav" aria-label="Sections">
    <div class="shell__brand">
      ${icons.logo}
      <span><b>${staff.company_name}</b><span>Property operations</span></span>
    </div>

    ${NAV.map((group) => {
      // Hidden, not disabled: the routing gate is the enforcement, this just
      // stops showing people doors that will not open for them.
      const items = group.items.filter((item) => !item.need || can(staff, item.need));
      if (!items.length) return "";
      return html`
      <div class="navgroup">
        ${group.group ? html`<h3>${group.group}</h3>` : ""}
        ${items.map(
          (item) => html`
          <a class="navlink" href="${item.href}"${attr("aria-current", active === item.key ? "page" : null)}>
            ${icons[item.icon]}<span>${item.label}</span>${item.badge ? navBadge(counts, item.badge) : ""}
          </a>`
        )}
      </div>`;
    })}

    <div class="shell__foot">
      <a class="shell__who" href="/app/account" style="display:block;text-decoration:none">
        <b>${staff.name}</b>${roleLabel(staff.role)}
      </a>
      <form method="post" action="/app/sign-out">
        <input type="hidden" name="_csrf" value="${csrf}" />
        <button class="navlink" type="submit" style="width:100%;text-align:left">${icons.out}<span>Sign out</span></button>
      </form>
    </div>
  </nav>

  <div class="shell__main">
    <header class="topbar">
      <div class="topbar__titles">
        <h1>${title}</h1>
        ${subtitle ? html`<p>${subtitle}</p>` : ""}
      </div>
      ${actions ? html`<div class="topbar__actions">${actions}</div>` : ""}
    </header>
    <main class="page">${body}</main>
  </div>
</div>
</body>
</html>`);
}

/* Public pages: tenants, owners and applicants. No shell, no nav, no account
   — they arrive on a tokenised link and should see one thing. */
export function publicPage({ title, heading, lede, body, company, foot }) {
  return doc(html`
<html lang="en">
<head>${HEAD(title)}</head>
<body class="antialiased">
<div class="pub">
  <div class="pub__brand">${icons.logo}<b>${company?.name || "Property operations"}</b></div>
  ${heading ? html`<h1>${heading}</h1>` : ""}
  ${lede ? html`<p class="lede">${lede}</p>` : ""}
  ${body}
  <p class="pub__foot">${foot || html`${company?.name || ""}${company?.phone ? html` · <a href="tel:${company.phone}">${company.phone}</a>` : ""}`}</p>
</div>
</body>
</html>`);
}

/* Sign-in is its own minimal page. */
export function signInPage({ error, company, csrf, next }) {
  return doc(html`
<html lang="en">
<head>${HEAD("Sign in")}</head>
<body class="antialiased">
<div class="pub" style="max-width:24rem">
  <div class="pub__brand">${icons.logo}<b>${company?.name || "Property operations"}</b></div>
  <h1>Sign in</h1>
  <div class="panel">
    <div class="panel__body">
      ${error ? html`<div class="notice" data-tone="danger" style="margin-bottom:1rem">${icons.alert}<div>${error}</div></div>` : ""}
      <form method="post" action="/app/sign-in" class="formgrid">
        <input type="hidden" name="_csrf" value="${csrf}" />
        ${next ? html`<input type="hidden" name="next" value="${next}" />` : ""}
        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required />
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="pill solid" type="submit">Sign in</button>
      </form>
    </div>
  </div>
</div>
</body>
</html>`);
}

export const notice = (tone, title, body) => html`
<div class="notice"${attr("data-tone", tone)}>
  ${tone === "ok" ? icons.check : tone === "danger" || tone === "warn" ? icons.alert : icons.clock}
  <div>${title ? html`<b class="notice__t">${title}</b>` : ""}${body}</div>
</div>`;

export const empty = (title, body) => html`<div class="empty"><b>${title}</b>${body}</div>`;

export { raw };
