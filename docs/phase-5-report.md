# Phase 5 — Mobile, PWA first. What was built, and what is not settled.

Six commits, `4702156` to `e1e3e51`. 127 tests added; 966 green.

---

## What was built

| | |
|---|---|
| **Web push, by hand** | VAPID (RFC 8292) and payload encryption (RFC 8291, `aes128gcm`), written against `node:crypto`. No dependency. |
| **Sending** | Subscribe, send, and what each answer from a push service means. Dead endpoints deleted, failing ones counted and swept. |
| **Installable** | Two manifests, a service worker, generated icons, an offline page. |
| **Turning it on** | Subscribe and stop, on the back office and on the portal. |
| **The technician's view** | Today's jobs, directions, arriving and leaving, photos, notes, parts, close-out. |
| **The 375px audit** | Twenty-nine pages measured in a browser. |

---

## The decisions inside it

**Nothing that knows who you are is ever cached.** A cached page is a copy on a
handset: it survives signing out, it is readable by whoever picks the phone up,
and the application never learns it happened — so a disclosure has occurred with
no audit trail of it.

The plan proposed a denylist of private prefixes. It is an allowlist instead,
because the denylist has to be updated every time a route gains a prefix and
fails silently when somebody forgets. The worker holds exactly one write to a
cache, in `install`, of seven static files. There is no `cache.put` anywhere and
a successful response is never written back.

The test for it reads the worker's **source**, not its behaviour. The thing
being guarded against is not a bug — it is somebody adding a runtime cache in
six months so the portal loads faster. That change would pass every behavioural
test anyone would think to write, because it makes the product better.

**No offline write queue.** A repair report composed in a stairwell and replayed
twenty minutes later duplicates on retry, fights the CSRF token, and tells
somebody their report was filed when it may still fail. The offline page says
plainly that nothing was sent, and to use a phone call for anything unsafe.

**A notification says that something happened and never what.** It is read on a
lock screen by whoever is holding the phone. The payload builder refuses a fixed
list — money, an address, an email, a phone number — applied to the finished
text rather than to anybody's intention.

**Check-in records a time and deliberately not a place.** The obvious version
captures GPS to prove the technician was where they said. That is staff
surveillance, it needs a permission this application denies outright, and it is
a decision to take deliberately rather than inherit from a default. There is no
column for a coordinate and a test asserts there is still no column for a
coordinate.

---

## How it was verified

**Against the specifications, where they exist.** The encryption reproduces the
RFC 8291 §5 vector byte for byte, with every constant taken from the RFC text.
That check earned its keep: the first version used an expected value written
from memory, reported a mismatch, and the mismatch was the memory. VAPID tokens
are verified against their own key, not merely produced without throwing.

**In a browser, for everything that renders.** The service worker registers at
root scope and activates; after signing in and visiting the queue, properties
and the trial balance, the cache still holds exactly the seven shell files and
nothing private; with the server stopped, a navigation to `/app/rent` renders
the offline page, styled from the cached stylesheet. The technician flow was
walked at 375px: signed in, opened a job, recorded an arrival — which flipped
the button and put "Arrived on site" on the tenant's own status page — and added
a part, which totalled and prefilled the final cost.

**The audit was measured, not estimated.** Twenty-nine pages at 375 CSS pixels,
reading real computed layout.

---

## What the browser found that reading would not have

Three of these were only visible by using the product as the person it is for.

**The first screen was a 403.** Sign-in always redirected to `/app`, the
company's queue, which needs `queue.view`. A technician has never had it. So the
very first screen of the product, on the phone this role exists for, was an
error page — whose "back to the app" link went to the same place.

**The role's capabilities contradicted its own docstring.** The comment said a
technician sees "not the rest of the queue, not the portfolio, not a tenant they
are not visiting". The set carried `property.view`, which gates exactly
`/app/portfolio` and `/app/compliance`.

**The sidebar offered four links that answer 403.** `layout.js` says in its own
comment that "a nav full of links that 403 is worse than a shorter nav", and the
annotations beside it had drifted. The nav now asks `requiredCapability`, the
same function the gate asks, so it cannot drift again.

**And a button that was lying.** The enable button for notifications was hidden
with the `hidden` attribute. `.pill` sets `display:inline-flex`, which beats the
browser's own `[hidden] { display: none }`, and this stylesheet has no `[hidden]`
rule of its own — so the attribute is inert on every pill in this application.
The page printed "notifications are blocked for this site" directly above a
button offering to turn them on.

---

## The audit, in full

| Fault | Result |
|---|---|
| Page-level horizontal scroll | **None**, on any of the 29 pages. Every table already sits in a container that scrolls on its own. |
| Touch targets under 44px | **Found and fixed.** The compact pill renders 33–35px and a navigation link 35px — the action controls. |
| Text under 14px | **Found, not fixed.** 11px, 12px and 13px in places. |
| A submit reached only by scrolling sideways | **`/app/setup`.** Three Save buttons in a table that scrolls inside its own container. |

The touch-target fix changes nothing visible: an `::after` centred on the
control carries the tap to 44px while the control renders exactly as it did.
Phones only. It is in `app-assets/app.css`; nothing in pindrop's `styles.css`
was touched.

**The two I did not fix are design decisions, not defects.** Raising the type
scale changes the information density of every screen, and so would relaying
`/app/setup`'s table. A mis-tap is a defect and I fixed it; a font size is a
design and it is not mine to change. Both are in OPEN-ITEMS with the measured
numbers, as P5 and P6.

Pages checked: `/app`, `portfolio`, `inbox`, `owners`, `accounting`,
`accounting/journals`, `accounting/trust`, `banking`, `payments`, `payouts`,
`vendors`, `vendors/1099`, `listings`, `leases`, `leases/new`, `jobs`,
`jobs/:id`, `messages`, `staff`, `company`, `billing`, `setup`, `account`,
`maintenance`, `maintenance/new`, `rent`, `compliance`, `turns`, `applications`,
`owners/new`, `portfolio/new`, plus `/report`, `/apply`, `/portal/sign-in`,
`/app/sign-in` and `/offline`.

---

## What could not be verified

**Whether Apple, Google and Mozilla accept what we send.** The encryption
reproduces the published vectors and the tokens verify, and neither of those
proves a push service accepts the result. It needs one real subscription from a
real browser and one real send. The browser pane denies notification permission,
so no real subscription could be created here. **OPEN-ITEMS P2.**

**Installing on an actual phone.** Needs HTTPS on a real domain. `localhost` is
a secure context and the worker, manifests, icons and offline page all work
there, but a home-screen install from it is not the same first run.
**OPEN-ITEMS P3.**

---

## What you need to supply

| | |
|---|---|
| 1 | **Run `npm run vapid`** and put the three values in the deployment environment. Unset means push is off and every screen says so; half-set is refused at boot. The public key is handed to browsers, so replacing it later invalidates every subscription anybody has made. |
| 2 | **Subscribe one real device** once the keys are in, and tell me whether a notification arrives. That is the only way to close P2. |
| 3 | **Decide on type size** (OPEN-ITEMS P5) and on `/app/setup`'s table (P6), or hand both to pindrop. The measured numbers are in OPEN-ITEMS. |
| 4 | **Decide whether the manifests should carry a company name** (P4). They are generic today because a manifest is fetched without credentials, so the server cannot know who is installing. |

---

## On a native wrapper

The roadmap asked whether a thin wrapper — Capacitor — is worth it later, and
said to answer having built the PWA rather than guessing first. Having built it:

**Not now, and probably not for the back office ever.**

What a wrapper would buy:

- **iOS push that behaves.** Safari supports web push, but only for a site the
  person has already added to their home screen, and the permission prompt is
  reachable only from there. A real app asks on first launch like everything
  else on the phone. This is the single strongest argument and it is entirely
  about iOS.
- **A first run people recognise.** "Add to home screen" from a Safari share
  sheet is a worse introduction than an App Store page, for tenants especially.
- **The camera and files, properly.** `capture="environment"` works. A native
  picker is better, and the gap is small.

What it would cost:

- **Two release channels with review latency.** Today a fix reaches every device
  on the next navigation. Through an App Store it reaches them when Apple says
  so, and the version somebody is running becomes a variable.
- **Apple's 30% question.** The tenant rent path is Stripe Checkout in a browser
  for goods and services outside the app, which is not in-app purchase — but it
  becomes an argument worth having rather than a non-question, and the answer is
  Apple's.
- **Nothing at all for the rendering.** It is the same HTML either way. The
  375px work in this phase is the work, and a wrapper does not change a pixel of
  it.

**What I would actually do**, in order:

1. Ship the PWA. It is done, it installs, and it costs nothing to run.
2. Put the VAPID keys in and find out whether iOS push works well enough once a
   tenant has installed. That is one measurement and it decides most of this.
3. If iOS push proves to be the blocker for *tenants* — and only then — wrap the
   **portal** alone, not the back office. A manager at a desk has a browser. A
   tenant who needs to be told their rent was received is the case a wrapper
   serves, and it is a much smaller thing to ship and maintain than the whole
   application.

Phase 9 is where this becomes urgent, because that is where the domain and the
product name get settled and an App Store listing needs both.
