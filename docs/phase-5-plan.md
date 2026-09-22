# Phase 5 — Mobile, PWA first

Plan. Per the roadmap's process rule, nothing is written until you approve it.

---

## What is already true

The app is not starting from a desktop layout. Every screen built so far uses
the same `panel` / `tile` / `tablewrap` furniture, and the wide tables already
scroll inside their own containers — I have been checking new screens at
375px through Phases 3 and 4. So the audit is an audit, not a rewrite, and I
expect to find gaps rather than a wall.

There is also already a technician view at `/app/jobs`, behind
`maintenance.own`, showing the jobs assigned to one person. It lists them; it
cannot be worked from. That is the thing to finish.

---

## The two decisions that shape this phase

### The service worker must never cache anything private

An offline cache is a copy of a page sitting on a device, surviving sign-out,
readable by whoever has the handset. A cached rent balance on a shared phone
is a disclosure, and it is one with no audit trail because the app never knows
it happened.

So the rule is narrow and enforced rather than intended:

- **Cache**: the stylesheet, icons, the manifest, and one offline page.
- **Never cache**: anything under `/app`, `/portal`, `/pay`, `/o/`, `/t/`,
  `/r/`, `/sign/` — which is to say every page that knows who you are.

A network-only fetch handler for those paths, and a test that reads the
service worker source and asserts it. The failure mode is somebody later
adding a "helpful" runtime cache, so the test is on the source rather than on
behaviour.

**[default]** No offline *queueing* of writes either. A repair report composed
on a stairwell with no signal and replayed twenty minutes later is a genuinely
nice feature and a genuinely bad idea to build blind: it duplicates on retry,
it fights the CSRF token, and the tenant is told their report was filed when
it may still fail. The offline page says plainly that nothing was sent.

### A push notification is read on a lock screen

Which means it is read by whoever is holding the phone, including somebody who
should not be. So **no push payload carries money, a balance, a name, or an
address**.

    yes   "A new emergency job"        then open the app to see which
    yes   "An owner approval is waiting"
    no    "Priya Anand owes $1,450"
    no    "Rent received for 412 Maple Grove Dr"

A test asserts the payload builder refuses anything outside a fixed set of
fields. This is the same shape of rule as "the resolver never reads a subject"
— cheap to state, invisible to break.

---

## Web push, by hand

VAPID and the payload encryption are the one genuinely intricate piece. Both
are doable with `node:crypto` and neither is guesswork:

- **VAPID** (RFC 8292): an ECDSA P-256 key pair, a JWT signed ES256, sent as
  `Authorization: vapid t=<jwt>, k=<public key>`. `crypto.sign` does the
  signing; the only fiddly part is that JOSE wants a raw 64-byte `r||s`
  signature where Node emits DER, so it has to be converted.
- **Payload encryption** (RFC 8291, `aes128gcm`): ECDH against the
  subscription's `p256dh` key, HKDF to derive a content-encryption key and
  nonce, AES-128-GCM, then a specific header block. Every primitive is in
  `node:crypto`.

Tested against the **RFC 8291 §5 published test vectors**, which is what makes
this verifiable without a browser: the RFC gives the input keys, the salt and
the expected ciphertext, so the implementation either reproduces them or it is
wrong. That is a better test than any amount of clicking.

What cannot be verified here is whether Apple's, Google's and Mozilla's push
services accept what we send. That needs a real subscription from a real
browser and goes in OPEN-ITEMS.

---

## The technician view

`/app/jobs` becomes something that can be worked from a phone in a stairwell:

| | |
|---|---|
| Today | The jobs assigned to me, emergencies first |
| Directions | A plain `https://maps.google.com/?q=<address>` link — no SDK, no key |
| Check in / out | Two buttons and two timestamps |
| Photos | The existing `storeUpload` path, `capture="environment"` on the input |
| Notes | Appended to `work_order_event`, which already exists |
| Parts used | New, small: a free-text line and a cost |
| Complete | The existing close-out path, reachable in one tap |

**[default] Check-in records a time, not a place.** The obvious version of this
feature captures GPS to prove somebody was where they said. That is staff
surveillance, it needs a permission this app currently denies outright in its
`Permissions-Policy`, and it is a decision for you rather than a default I
slip in. The button records that they said they arrived and when. If you want
location later, it is a deliberate addition with its own consent.

---

## The 375px audit

Every page, at 375 CSS pixels, looking for four faults:

1. horizontal scroll on the page body (as opposed to inside a `tablewrap`)
2. touch targets under about 44px
3. text under 14px
4. a form where the submit button is not reachable without a horizontal scroll

Findings get fixed in the same commit, one page at a time, and the report says
which pages were checked rather than claiming "all of them".

---

## Files

**New**

    app-assets/sw.js                 the service worker
    app-assets/manifest.webmanifest  install metadata
    app-assets/icons/                maskable PNGs, generated
    server/lib/push/vapid.js         ES256 JWT, DER → JOSE signature
    server/lib/push/encrypt.js       RFC 8291 aes128gcm
    server/lib/push/index.js         subscribe, send, prune dead endpoints
    server/lib/push/payload.js       the fixed, safe payload shapes
    server/features/pwa.js           manifest, service worker, offline page
    server/features/tech.js          the technician view
    test/vapid.test.js
    test/pushcrypto.test.js          against the RFC 8291 test vectors
    test/push.test.js
    test/pwa.test.js
    test/tech.test.js
    test/mobile.test.js              the 375px audit, as assertions

**Changed**

    server/lib/http.js               manifest-src and worker-src in the CSP
    server/lib/config.js             VAPID keys, read in one place
    server/features/staff.js         /app/jobs becomes the technician view
    server/views/layout.js           manifest link, theme colour
    server/lib/scheduler.js          prune dead push endpoints

---

## Migrations

    033_push.sql    push_subscription, and where a job was worked

`push_subscription` carries `company_id` and either a `staff_id` or a
`person_id` — the same split as portal sessions, for the same reason. Endpoint
and keys are stored as given; they are a capability to send to one device, so
a `UNIQUE` on the endpoint and a hard delete when a push service reports the
subscription gone.

---

## New env vars

    VAPID_PUBLIC_KEY     base64url P-256 public key
    VAPID_PRIVATE_KEY    base64url P-256 private key
    VAPID_SUBJECT        a mailto: or https: URL identifying the sender

Unset means push is off and every screen says so rather than offering a button
that silently does nothing. I will generate a key pair and print it for you to
put in the environment; I will not commit one.

---

## Risks

**A service worker is sticky.** A bad one caches itself and is hard to dislodge
from a device you do not hold. So: a version constant, `skipWaiting` on
install, `clients.claim` on activate, and a kill path — if the version marker
does not match, the worker unregisters itself and clears its caches. Cheap
insurance against having to tell somebody to clear their browser data.

**Push encryption is the kind of code that looks right and is wrong.** The RFC
test vectors are the answer to that, and they are why I am writing it rather
than pulling `web-push` in — the dependency would be reasonable, but the
roadmap prefers plain `fetch` and the vectors make it verifiable either way.
If the vectors do not reproduce, I will say so and take the dependency rather
than ship crypto I cannot check.

**The audit may find real layout debt** on older screens from Phases 0–2 that
I have not been checking at phone width. If it is more than a handful of
fixes, I will report it rather than quietly expanding the phase.

---

## On a native wrapper

The roadmap asks whether Capacitor is worth it later. I will answer properly
in the report, having built the PWA, rather than guessing now. The short
version I expect to land on: worth it only for two things — push on iOS behaves
better from a real app, and a home-screen install from a browser is a worse
first-run experience than an App Store page — and worth nothing at all for the
rendering, which is already the same HTML.

---

## What will and will not be verified

Verified: the service worker's cache rules, by reading its source and by
driving it; that no push payload can carry money or a name; VAPID JWTs against
their own verification; payload encryption against the RFC 8291 vectors; the
technician flow end to end; every page listed in the report at 375px.

Not verified without your input: whether Apple, Google and Mozilla accept our
push messages, which needs a real subscription from a real device; and
installability on an actual phone, which needs HTTPS on a real domain.
