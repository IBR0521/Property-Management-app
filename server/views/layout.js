/* Page shells.

   Every app document links the marketing stylesheet first and app.css second,
   so the app inherits the site's palette, type and components verbatim and
   only adds layout on top. */
import { html, doc, raw, attr } from "../lib/render.js";
import { icons } from "./icons.js";
import { can, roleLabel, requiredCapability } from "../lib/auth.js";
import { reportsFor } from "../lib/reports/index.js";
import { manifestUrl } from "../lib/manifest.js";

/* Imported lazily through a function rather than at the top of the file:
   the registry imports the features, and the features import this. */
const hasAnyReport = (staff) => reportsFor(staff).length > 0;

/* The generic fallbacks. A page that knows its company passes a per-company
   URL instead — see `lib/manifest.js` — so the installed icon carries the
   company's own name rather than "Operations". */
const APP_MANIFEST = "/app-assets/manifest.webmanifest";
export const PORTAL_MANIFEST = "/app-assets/portal.webmanifest";

/* `install` is the manifest to offer, or null for a page nobody should be
   installing. It also gates the service worker registration, because the two
   belong together: the worker exists to make an installed copy open offline,
   and a one-off tokenised page has no business leaving one behind on a
   device. */
const HEAD = (title, { install = null } = {}) => html`
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="#1b184e" />
<link rel="icon" href="/app-assets/icons/icon-192.png" sizes="192x192" type="image/png" />
<link rel="apple-touch-icon" href="/app-assets/icons/icon-192.png" />
${install ? html`<link rel="manifest" href="${install}" />
<script src="/app-assets/js/register-sw.js" defer></script>` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/assets/css/styles.css" />
<link rel="stylesheet" href="/app-assets/app.css" />`;

/* --- navigation ----------------------------------------------------------- */

/* Four destinations, plus the two sections that only some roles hold. Items
   carry the capability they need so the sidebar shows a person what they can
   actually open — a nav full of links that 403 is worse than a shorter nav. */
/* Exported so a test can hold it against the capability table. The comment
   above says the routing gate is the enforcement and this only stops showing
   people doors that will not open — which stayed true of most of it and
   silently stopped being true of three entries. */
export const NAV = [
  { group: null, items: [
    { href: "/app", key: "queue", icon: "inbox", label: "Queue", badge: "queue" },
    { href: "/app/portfolio", key: "properties", icon: "home", label: "Properties", badge: "properties" },
    { href: "/app/inbox", key: "inbox", icon: "send", label: "Inbox", badge: "inbox" },
    { href: "/app/owners", key: "people", icon: "users", label: "Owners", badge: "people", need: "money.view" },
  ] },
  { group: "Money", items: [
    { href: "/app/accounting", key: "accounting", icon: "cash", label: "Accounting", need: "money.view" },
    { href: "/app/banking", key: "banking", icon: "loop", label: "Banking", need: "bank.link" },
    { href: "/app/payments", key: "payments", icon: "cash", label: "Tenant payments", need: "money.view" },
    { href: "/app/payouts", key: "payouts", icon: "send", label: "Payments out", need: "money.view" },
    { href: "/app/deposits", key: "deposits", icon: "cash", label: "Deposits", need: "money.view" },
    { href: "/app/vendors", key: "vendors", icon: "wrench", label: "Contractors", need: "vendor.manage" },
  ] },
  { group: "Leasing", items: [
    { href: "/app/listings", key: "listings", icon: "key", label: "Vacancies", need: "leasing.work" },
    { href: "/app/leases", key: "leases", icon: "doc", label: "Lease documents", need: "leasing.work" },
  ] },
  { group: null, items: [
    { href: "/app/reports", key: "reports", icon: "doc", label: "Reports", when: hasAnyReport },
    { href: "/app/jobs", key: "jobs", icon: "wrench", label: "Your jobs", need: "maintenance.own" },
    { href: "/app/messages", key: "messages", icon: "send", label: "Messages" },
  ] },
  /* The five settings pages, which were loose in the list above. "Where do I
     change the company address" was answered by reading all twenty items,
     because nothing said which of them were settings. */
  { group: "Settings", items: [
    { href: "/app/staff", key: "staff", icon: "users", label: "Your team", need: "staff.manage" },
    { href: "/app/company", key: "company", icon: "home", label: "Company", need: "settings.manage" },
    { href: "/app/billing", key: "billing", icon: "cash", label: "Billing", need: "settings.manage" },
    { href: "/app/company/access", key: "access", icon: "shield", label: "Support access", need: "settings.manage" },
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
  { key: "inspections", href: "/app/inspections", label: "Inspections" },
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

/* What the folded menu is hiding. Without it a phone shows a closed "Menu"
   and no sign that four things are waiting inside it. */
function navTotal(staff, counts) {
  let n = 0;
  for (const group of NAV) {
    for (const item of group.items) {
      if (!item.badge) continue;
      const c = counts && counts[item.badge];
      if (c && c.n) n += Number(c.n);
    }
  }
  return n || "";
}

function navBadge(counts, key) {
  const c = counts && counts[key];
  if (!c || !c.n) return "";
  return html`<span class="navlink__count"${attr("data-tone", c.tone)}>${c.n}</span>`;
}

export function appPage({ staff, active, title, subtitle, actions, body, counts = {}, csrf }) {
  const impersonation = staff?.impersonation || null;
  return doc(html`
<html lang="en">
<head>${HEAD(`${title} · ${staff.company_name}`,
  { install: manifestUrl("app", { name: staff.company_name, slug: staff.company_slug }) })}</head>
<body class="antialiased">
${impersonation ? html`
  <div class="impersonating">
    <span>
      <b>Support is viewing this account.</b>
      ${impersonation.operator} &mdash; ${impersonation.reason}. Read-only.
    </span>
    <a class="pill outline sm" href="/app/platform/stop">End session</a>
  </div>` : ""}
<div class="shell">
  <nav class="shell__nav" aria-label="Sections">
    <div class="shell__brand">
      ${icons.logo}
      <span><b>${staff.company_name}</b><span>Property operations</span></span>
    </div>

    <!-- On a phone this column stacks above the page, so an administrator's
         twenty-one links pushed the content 1.6 screens down and every visit
         began with a scroll past sections they had not come for. Folded below
         60rem, always open above it.

         A checkbox rather than <details>, and rather than a script. <details>
         was tried first and cannot work here: the browser hides a closed
         disclosure's content itself, so there is no way to force it open on a
         desktop — the sidebar vanished. A checkbox can be overridden by a
         media query, needs no JavaScript, and is operated by the keyboard for
         nothing. It is visually hidden rather than display:none so that it
         stays focusable. -->
    <input type="checkbox" id="shellmenu" class="shell__toggle" />
    <label class="shell__menubtn" for="shellmenu">
      ${icons.inbox}<span>Menu</span>
      <span class="shell__menucount">${navTotal(staff, counts)}</span>
    </label>
    <div class="shell__links">

    ${NAV.map((group) => {
      // Hidden, not disabled: the routing gate is the enforcement, this just
      // stops showing people doors that will not open for them.
      /* Asked of the same function the gate asks, rather than of a `need`
         field maintained by hand beside it. The hand-kept version had drifted:
         Queue, Properties, Inbox and Messages carried no `need` at all, so a
         technician — who holds none of those capabilities — was shown four
         links that answer 403. `item.need` is still honoured where it is
         stricter than the route's own requirement. */
      const items = group.items.filter((item) => {
        /* For the one destination whose access is not a single capability.
           Reports are gated per report, so "may this person reach the
           section" is "is there anything in it for them". */
        if (item.when && !item.when(staff)) return false;
        if (item.need && !can(staff, item.need)) return false;
        const gate = requiredCapability(item.href);
        return !gate || can(staff, gate);
      });
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
    </div>

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

/* The portal: a tenant or an owner, signed in as themselves.

   Deliberately not the staff shell. A person signed into the place they pay
   rent should not be looking at something that resembles an operations
   console — it is a handful of things about their own home, so it gets a
   narrow page and a short bar rather than a sidebar of sections they will
   never open.

   Built from `publicPage`'s furniture rather than `appPage`'s, so the two
   cannot drift into each other. */
export function portalPage({ title, heading, lede, body, person, company, tabs: items, active }) {
  return doc(html`
<html lang="en">
<head>${HEAD(`${title} · ${company?.name || "Your account"}`,
  { install: manifestUrl("portal", company) })}</head>
<body class="antialiased">
<div class="pub" role="main" style="max-width:52rem">
  <div class="pub__brand" style="justify-content:space-between">
    <span style="display:inline-flex;align-items:center;gap:0.5rem">
      ${icons.logo}<b>${company?.name || "Your account"}</b>
    </span>
    ${person ? html`
      <span class="cellsub" style="display:inline-flex;align-items:center;gap:0.75rem">
        ${person.name || person.email}
        <a href="/portal/sign-out">Sign out</a>
      </span>` : ""}
  </div>

  ${items && items.length > 1 ? html`
    <nav class="tabs" aria-label="Your account">
      ${items.map((t) => html`
        <a class="tab" href="${t.href}"${attr("aria-current", t.key === active ? "page" : null)}>${t.label}</a>`)}
    </nav>` : ""}

  ${heading ? html`<h1>${heading}</h1>` : ""}
  ${lede ? html`<p class="lede">${lede}</p>` : ""}
  ${body}
  <p class="pub__foot">
    ${company?.name || ""}${company?.phone ? html` · <a href="tel:${company.phone}">${company.phone}</a>` : ""}
  </p>
</div>
</body>
</html>`);
}

/* Public pages: tenants, owners and applicants. No shell, no nav, no account
   — they arrive on a tokenised link and should see one thing.

   `install` defaults to nothing, which is the right default: somebody who
   followed a one-off link to report a leak should not come away with a
   service worker on their phone. The portal's own sign-in pages pass it,
   because that is where a tenant would install from. */
export function publicPage({ title, heading, lede, body, company, foot, install = null }) {
  return doc(html`
<html lang="en">
<head>${HEAD(title, { install })}</head>
<body class="antialiased">
<div class="pub" role="main">
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
<head>${HEAD("Sign in", { install: APP_MANIFEST })}</head>
<body class="antialiased">
<div class="pub" role="main" style="max-width:24rem">
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
