# Phase 1 — Message delivery and scheduling

Plan only. No code until you approve it.

---

## First: I broke delivery honesty in Phase 0

Before anything else, because it is live right now and it is mine.

`config.js` defaults `DELIVERY_MODE` to `"off"`. The old code defaulted to
`"none"`, and three places still compare against that string:

    scheduler.js:379   if (DELIVERY.mode === "none") return 0;
    queue.js:50        DELIVERY.mode === "none" && queued > 0   -> the dashboard warning
    setup.js:44        DELIVERY.mode === "none" ? "warn" : "ok" -> the status chip

So on the live app today:

- **39 messages are queued and undelivered.**
- **The dashboard warning is gone.** It used to say "Nothing is being sent —
  N messages are queued and not delivered."
- **Setup shows a green chip.** Mode "off", tone `ok`.

The app is now quietly claiming everything is fine while sending nothing. That
is the exact failure the delivery-honesty invariant exists to prevent, and the
README says it in as many words: *"A queue that silently claims to have sent a
late-rent notice is worse than one that admits it has not."*

My Phase 0 suite did not catch it because I never wrote a test for that
invariant. The roadmap lists it and I missed it. Two consequences for this
phase: the fix is the first commit, and delivery honesty gets a test before the
provider work starts.

---

## What I read

`lib/scheduler.js` (393 lines), the `outbox` table, all twelve outbox
producers across `maintenance.js`, `owners.js`, `applications.js` and the
scheduler, the emergency path in `maintenance.js`, `queue.js` and `setup.js`
where delivery state is displayed, `job_run`, and `vercel.json`.

Findings that shaped the plan:

**`drainOutbox` is a stub with a dead guard.** Six lines that log and mark
sent. Nothing else.

**The emergency SMS is queued, so today it is never sent.** `maintenance.js`
writes the on-call alert to the outbox like everything else. The tenant still
gets the stop card and is told to call, so the guarantee is not broken — but
the backup rests entirely on the tenant dialling. The roadmap is right that
this one must leave during the request.

**There is no consent storage of any kind.** No opt-out table, no unsubscribe.
`outbox.status` has a `suppressed` value that nothing ever sets. Sending SMS
without honouring STOP is a TCPA problem, not a feature gap.

**Nothing records that the scheduler ran.** `job_run` exists but only the
late-fee sweep writes to it, so there is no way to know the tick is stale.

**`company` has no sender identity** — no from-address, no reply-to, no
messaging-service id. Per-company sending needs them.

---

## Provider choice

**Email: Resend.** The deciding factor is webhook verification. The roadmap
says to verify signatures with `node:crypto`, and Resend signs with Svix —
HMAC-SHA256 over `id.timestamp.body`, base64, with a `whsec_` secret. That is
forty lines of `node:crypto` and fully testable. Postmark does not sign
webhooks at all; it authenticates the callback with HTTP basic auth, which
means the "signature verification" would be a password comparison. Resend is
also simpler to send with (one POST) and cheaper at this volume.

**SMS: Twilio.** No real alternative at this scale for US A2P. Signs with
`X-Twilio-Signature`: base64 HMAC-SHA1 over the full URL plus the POST
parameters sorted and concatenated. Also `node:crypto`, also testable.

Both are called with `fetch`. No SDKs.

**`DELIVERY_MODE` stays the switch**, with four values rather than the current
two: `off` (queue, send nothing, say so), `log` (drain to the console),
`live` (real providers), and `sandbox` (Twilio test credentials and Resend's
test address, which accept and discard). Default stays `off`.

---

## Design

### The provider interface

    server/lib/delivery/index.js     pick a provider, send, normalise errors
    server/lib/delivery/resend.js    email
    server/lib/delivery/twilio.js    sms
    server/lib/delivery/log.js       console, for development

One method: `send({ channel, to, subject, body, from, companyId })` returning
`{ ok, providerMessageId, error, retryable }`. **Retryable is the interesting
field.** A 500 from Twilio is worth retrying; "this number is not a mobile" is
not, and retrying it twenty times is how an outbox fills with garbage that
hides the real failures. Each provider maps its own error codes onto that
boolean, because only the provider adapter knows what its codes mean.

### Retry and the dead letter

`attempts` and `last_error` already exist. Adding `next_attempt_at` and a
`dead` status.

Backoff: 1m, 5m, 25m, 2h, 10h — five attempts over about half a day, then
dead-lettered. Not infinite: a message that has failed five times is a message
somebody needs to look at, and a queue that retries forever is a queue nobody
reads.

Dead letters get a screen with the error and a retry button. The count goes on
the dashboard beside the queued count, because an invisible dead letter is the
same as a lost message.

### The emergency path

A new `sendNow()` that calls the provider inside the request, with a 5-second
timeout, and writes the outbox row as a record of what happened rather than as
a thing to be drained later.

Three outcomes, and the tenant sees the same stop card in all three:

1. Provider accepts — row `sent`, provider id recorded.
2. Provider rejects or times out — row `failed`, logged at error level with the
   request id, **and the work-order event says the alert failed**, so the queue
   shows a manager that the on-call number was not reached.
3. Delivery is off — row stays `queued`, and the work-order event says so.

The tenant is never shown a failure they cannot act on: they have already been
told to call, which is the actual guarantee.

### Consent

New `contact_consent`: company, channel, address, state (`granted`,
`revoked`, `bounced`, `complained`), source, timestamps.

- **SMS:** an inbound `STOP`/`UNSTOP`/`HELP` webhook from Twilio records the
  state. `send()` refuses a revoked address and marks the row `suppressed` —
  the status that has been sitting unused in the schema since 001.
- **Email:** a signed unsubscribe link on non-transactional mail. Rent notices
  and emergency alerts are transactional and are not unsubscribable; marketing
  and reminders are. The distinction is a column on the outbox row
  (`kind: 'transactional' | 'informational'`), set by the producer.
- **Bounces and complaints** from the Resend webhook mark the address, because
  continuing to send to a hard bounce is how a sending domain gets blocked.

### Webhooks

    /api/webhooks/resend     delivery, bounce, complaint
    /api/webhooks/twilio     status callbacks, and inbound STOP/HELP

Both signature-verified before the body is read as anything but bytes, both
idempotent on the provider's event id via a unique index, both returning 200 to
a duplicate so the provider stops retrying.

They live under `api/` as their own functions because `vercel.json` rewrites
everything except `/api/*` into the app, and a webhook should not carry the
session and CSRF machinery.

### Scheduling

- Re-add the `crons` block to `vercel.json`: `0 9 * * *`, daily, which is what
  Hobby allows. This broke a deploy once by exceeding the plan limit; one entry
  is within it.
- `tick()` records to `job_run`, so lastRun is a fact rather than a guess.
- Dashboard indicator: green under 26 hours, **red over 26**, with the age and
  the manual re-check button beside it. 26 rather than 24 so a daily cron that
  drifts by an hour does not cry wolf.
- Document the external pinger (cron-job.org, GitHub Actions schedule) for
  anyone wanting hourly without paying for Pro.

### Send a test

A button per channel in Setup that sends to the signed-in staff member's own
address, showing the provider's actual response — including the failure.
Sending to yourself is the one test that cannot spam somebody else.

---

## Files

**New**

    server/lib/delivery/index.js        provider selection, send, suppression
    server/lib/delivery/resend.js       email over fetch
    server/lib/delivery/twilio.js       sms over fetch
    server/lib/delivery/log.js          development
    server/lib/delivery/signatures.js   Svix and Twilio verification, node:crypto
    server/features/messages.js         outbox screen, dead letters, retry, test send
    api/webhooks/resend.js
    api/webhooks/twilio.js
    test/delivery.test.js               honesty, retry, backoff, suppression
    test/webhooks.test.js               signatures, replay, idempotency
    docs/phase-1-plan.md                this file

**Changed**

    server/lib/scheduler.js       real drainOutbox, job_run recording, dead guard fixed
    server/features/maintenance.js  emergency sends in-request via sendNow()
    server/features/queue.js      delivery warning restored, scheduler staleness
    server/features/setup.js      delivery status, test buttons
    server/lib/config.js          provider vars, DELIVERY_MODE values
    server/views/layout.js        dead-letter count in the nav
    vercel.json                   the crons block
    test/invariants.test.js       the delivery-honesty invariant I missed

---

## Migrations

    013_delivery.sql

- `outbox` gains `provider`, `provider_message_id`, `next_attempt_at`,
  `kind`, and `dead` in the status CHECK.
- `delivery_event` — provider event id (unique), outbox id, type, payload,
  received_at. The idempotency key and the audit trail.
- `contact_consent` — company, channel, address, state, source, timestamps.
  Unique on (company_id, channel, address).
- `company` gains `from_email`, `from_name`, `reply_to`, `sms_from`.

Every new table carries `company_id` and is swept by `migrate()`. `delivery_event`
is the exception worth stating: a webhook arrives before we know which company
it belongs to, so `company_id` is nullable and filled in on resolution. The
isolation test's parent-scoped list will name it with that reason.

---

## New environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DELIVERY_MODE` | no | `off` (default), `log`, `sandbox`, `live` |
| `EMAIL_PROVIDER` | for live email | `resend` |
| `RESEND_API_KEY` | for live email | |
| `RESEND_WEBHOOK_SECRET` | for webhooks | `whsec_…`, Svix signing key |
| `EMAIL_FROM` | for live email | Fallback sender; per-company overrides it |
| `TWILIO_ACCOUNT_SID` | for live SMS | |
| `TWILIO_AUTH_TOKEN` | for live SMS | Also the webhook signing key |
| `TWILIO_FROM_NUMBER` | for live SMS | Or `TWILIO_MESSAGING_SERVICE_SID` |
| `APP_BASE_URL` | for webhooks | Twilio signs over the full URL, so it must match exactly |

`config.js` will refuse `DELIVERY_MODE=live` without the keys for the channels
in use — a mode that claims to send and cannot is the failure this phase exists
to remove.

---

## What I will and will not be able to verify

**Fully verified, no credentials needed:**

- Signature verification against vectors I generate with the documented
  algorithms, plus rejection of a tampered body, a wrong key, and a replayed
  timestamp outside the tolerance window.
- Retry, backoff timing, dead-lettering and suppression, driven by an injected
  clock and a fake provider.
- The emergency path's three outcomes, with a provider stubbed to succeed,
  fail and time out.
- Idempotency: the same webhook delivered twice changes nothing.
- Delivery honesty: the UI states the truth in every mode.

**Verified only against sandbox, if you supply free-tier credentials:**

- Resend's test API key and Twilio's magic test credentials both accept
  requests and discard them. That exercises the real HTTP path, real auth, and
  real error shapes without sending anything or costing anything.

**Cannot be verified without a live account, and I will say so rather than
claim it works:**

- That Resend's live signature header matches my reading of the Svix spec.
- That Twilio's live status callbacks arrive in the shape documented.
- Actual deliverability, SPF/DKIM/DMARC alignment, and A2P 10DLC registration.

---

## Risks

**A2P 10DLC.** US carriers require brand and campaign registration before
sending application-to-person SMS. Unregistered traffic is filtered — silently.
This is paperwork and a fee, it takes days to weeks, and it is a prerequisite
for SMS working at all in production. It is the single biggest schedule risk in
this phase and it is not a coding task.

**A sending domain has to be warmed and authenticated.** SPF, DKIM and DMARC
on the domain you send from, or rent notices land in spam. Also not a coding
task.

**Sending is irreversible.** 39 messages are queued right now, some of them
weeks old. Turning delivery on would send all of them at once, including
late-rent notices whose dates have passed. **The first live run must start from
an empty or deliberately reviewed queue.** I will build the dead-letter screen
so the existing 39 can be reviewed and discarded rather than sent, and I will
not drain them.

**Cron re-enablement previously broke a deploy.** One daily entry is within
Hobby limits; I will confirm the deploy succeeds rather than assume.

---

## What I need from you

1. **Resend and Twilio accounts**, and their test/sandbox credentials. Free
   tier is enough. If you would rather not yet, I will build against the local
   fake and the sandbox path stays unexercised — I will say so in the report.
2. **The sending domain** for `EMAIL_FROM`, and confirmation you can set DNS on
   it.
3. **A decision on the 39 queued messages:** review and discard, or send. My
   recommendation is discard — they are stale, and the first thing a new
   delivery system should not do is send a month of backdated notices.
4. **`APP_BASE_URL`** — the production URL, which Twilio's signature is
   computed over. Still outstanding from Phase 0: I do not know your production
   Vercel URL, only a preview one.
