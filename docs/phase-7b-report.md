# Phase 7b — A public API and outbound webhooks. What was built, and what it found.

Four commits, `9a856e0` to `d0fc98c`. Four test files added; **1584 green**, from 1452 at the end of Phase 7a.

Both halves are the same thing from two directions: somebody else's software
asking this application questions, and this application telling somebody
else's software what happened.

---

## The API

`/api/v1`, company-scoped by the key. Nine resources read-first — properties,
units, leases, tenants, owners, work orders, payments, ledger entries and
journals — and two writes: raising a work order and recording a payment
received.

Deliberately less than the application can do. `/api/v1` is a promise:
everything else in this codebase can be changed, and a published endpoint with
somebody's integration pointed at it cannot. Four resources I am sure of beats
twelve I am not, and adding one later breaks nobody.

### One authorisation model, not two

The tempting design is a permission system for the API beside the one the
screens use, and that is how a product ends up with two answers to "may this
caller do this" and no way to tell which is right.

**A key can do what its holder could do, and less.** Every key belongs to a
member of staff; what it may do is its scopes narrowed by that person's role,
resolved from the current `staff` row on every request. Narrowing somebody
narrows their keys in the same moment. Deactivating them stops their keys. A
scope can only take away — a key carrying `money:write` whose holder has no
`money.write` can do nothing with it, because the other way round is an API
that is a privilege escalation with documentation.

**The screens have no "who holds this key" field, and the absence is the
security property.** If a manager could issue a key held by an administrator,
the manager would be holding an administrator's credential. Tying the holder
to the issuer removes the question rather than answering it carefully — and it
means a key dies with the person, which is otherwise the thing everybody
forgets.

### Every route goes through one door

Routes are not registered with the router directly. They are declared through
`endpoint()`, which authenticates, rate-limits, checks the scope, records the
call and turns a thrown error into JSON. **A route that forgot to authenticate
cannot be written**, because there is no way to write one.

That is the same argument as the app-level capability gate, made differently
on purpose: the app's authority is a property of the path, and the API's is a
property of the endpoint. `/api/v1/journals` and `/api/v1/units` share a prefix
and are nothing alike in what they need.

### The specification is generated, not written beside the code

A hand-written OpenAPI document is wrong within two releases and nothing makes
it wrong loudly: the code keeps working, the document keeps being served, and
the first anybody hears is an integrator asking why a promised field is not
there. So each resource names its fields once, the response is built from that
list and so is the document, and a test holds the two against each other.

### Things decided, and said rather than left as absences

- **No CSRF check on the API**, because CSRF exists for cookies. A cookie is
  ambient — a browser attaches it to a request the person did not mean to make.
  An `Authorization` header is not. A token here would be a ritual, and a
  ritual is how the reason gets forgotten and then applied somewhere it does
  not hold.
- **No CORS headers, and there will not be.** Anything a browser can send,
  somebody can read out of the page. A key read out of a page is a key that has
  been given away. On the screen and in the specification, not only here.
- **The request log holds a route and an outcome and never a body.** A log
  holding payloads is a second copy of the customer's data with none of the
  protections the first one has.
- **The specification is also served to a signed-in session**, at
  `/app/setup/api/openapi.json`. Reading the shape before anybody has given you
  a key is the ordinary case, and a link that answers 401 in a browser is a
  link that does not work.

### An emergency is never queued, and it survived the API

The oldest invariant in this application, and the API is the hardest place for
it: a machine raising an emergency is worse than a person doing it, because
nobody is at the screen.

So an emergency work order raised through the API is **not routed to a
contractor**, the company's on-call number is rung inside the request exactly
as the tenant intake does it, and the response says whether that reached
anybody:

    "emergency": {
      "routed_to_a_contractor": false,
      "on_call_alerted": false,
      "on_call_number": "(614) 555-0911",
      "note": "This was not routed to a contractor, and the on-call alert did
               not send — delivery is off. Ring somebody."
    }

Delivery honesty holds through a JSON response as well as through a screen.

---

## Webhooks

Six events, queued from the one place each of them actually happens:
`work_order.raised`, `work_order.completed`, `payment.recorded`,
`payment.returned`, `lease.signed`, `owner_approval.decided`.

`payment.recorded` fires inside `postMoney`, which is the single writer of
owner-visible money — so a screen, the API, a bank import and the autopay run
all reach it without four call sites and four chances to forget.

**Queued in the same transaction as the thing it describes.** Either the work
order exists and the delivery is queued, or neither happened. Emitting after
the commit loses events whenever the process dies in between, silently, and
"silently" is the part that matters.

**The body is frozen when it fires.** Re-deriving it at send time would mean a
delivery and its retry describe different states under the same id, and a
receiver that de-duplicates on id would keep the wrong one.

### The address check, which is the security of this whole feature

A webhook URL is a request this application makes on somebody else's
instruction, from inside our network. That is server-side request forgery with
a form in front of it, and the interesting target is `169.254.169.254`, where
every major cloud keeps the host's own credentials.

**Checking the URL when it is saved is not enough.** A hostname is resolved by
DNS, DNS answers change, and somebody who controls a domain can point it at a
public address on Tuesday and at the metadata service on Wednesday. So:

1. The name is resolved **before every send**.
2. **Every** address it resolves to has to be public — one bad answer among
   several is a name whose owner is trying something.
3. The connection is then **pinned to the address that was checked**.

Step three matters as much as the first two. Without it the HTTP client
resolves the name a second time and can get a different answer, and the gap
between the two resolutions is the whole of DNS rebinding. `fetch` cannot pin
without reaching into undici's dispatcher, so this uses `node:https` with its
own `lookup`.

The classifier is written out rather than pulled from a package, because it is
the list that decides whether a request reaches a metadata service and it
should be readable by whoever is asking that question. It catches the forms
that get past a naive check: IPv4 mapped into IPv6 (`::ffff:127.0.0.1`), the
hex spelling of the same thing (`::ffff:7f00:1`), NAT64 (`64:ff9b::/96`),
carrier-grade NAT, and the rest.

### Signed over `id.timestamp.body`, not `timestamp.body`

The plan said `timestamp.body`. That is wrong in a way worth recording:
signing only the timestamp and the body lets a captured delivery be replayed
as a **different** delivery inside the tolerance window, because nothing in
the signed material says which delivery it is. With the id in it, a replay is
recognisable as the delivery it actually was.

This is the Standard Webhooks shape — `webhook-id`, `webhook-timestamp`,
`webhook-signature` — chosen because a customer has to write the verifying
half and several languages already have a library for it. The verifier is in
the same file, so the test checks a real receiver's work rather than our own
arithmetic.

### What happens when it does not arrive

A 2xx delivers. A 404 stops and says so — a refusal rather than a wobble, and
retrying it for six hours helps nobody. A 429, a 5xx or a network error
retries after 1, 5, 30, 120 and 360 minutes and then gives up. An endpoint
that fails twenty times in a row, or whose URL cannot be sent to at all, turns
itself off and records why.

**The delivery log is the feature.** "Did you send it" is the first question
every integration asks, and the only answer worth having is a record the
customer can read themselves — what was attempted, what came back, why it
stopped, when the next try is, and a button to send the same delivery again
(the same id, so a receiver that de-duplicates is not tricked into handling it
twice).

---

## What this turned up along the way

**`raiseWorkOrder` was inlined in the staff screen's POST handler.** Fine while
that screen was the only way a job could be raised; with the API as a second
way in, two copies of "what happens when a job is raised" is how the routing
rules get applied on one path and not the other, quietly, and only for the
customer whose integration uses the new one. Extracted to
`server/lib/workorders.js`, and the screen now calls it.

**`reported_channel` and `ledger_entry.source` had no value for the API.** The
alternative was to let the API claim to be a member of staff, which is the kind
of small lie that makes an audit trail worthless later. Migration 040 adds
`'api'` to both.

**Rate limiting needed a different shape.** `rate_hit` writes one row per
attempt, which is right for a sign-in form a person uses eight times an hour
and wrong for an API a script uses a thousand times. The API counts into one
row per key per hour with an upsert: the cost of limiting must not grow with
the traffic it is limiting.

**A reversal is not a payment.** `returnPayment` claws a payment back by
posting a `rent_payment` for a *negative* amount, which meant the
`payment.recorded` event fired with minus fourteen hundred dollars in it.
Telling a receiver that is worse than telling them nothing, so the event is
positive amounts only and a return has its own event — which says what
actually happened, and whether the tenancy went cash-only as a result. Found
by writing the returned-payment test, not by reading the code.

### Two bugs the tests caught

**A handler returning a bare record could not be told from one returning
`{status, body}`** — and units, leases, work orders and payments all have a
`status` field. A unit's status of `"occupied"` was read as the HTTP status and
threw. Found by fetching a unit. Responses now carry their status in a class
that cannot be confused with data.

**The request log passed camelCase keys to `insert()`**, so every row was
rejected by the database and swallowed by a silent catch. Nothing was logged
for as long as it took a test to ask. It now says when it cannot log, because a
silent catch is how that lasts.

---

## What I could not verify

- **A real receiver at the other end of a real network.** Deliveries are
  exercised against an injected sender, and the address rules against an
  injected resolver — which is how the private-address cases can be tested at
  all, since a test cannot make DNS answer `169.254.169.254`. What has not
  happened is a real TLS connection to a real endpoint.
- Nothing about redirects: **they are not followed, on purpose.** A redirect is
  a new URL chosen by the endpoint that has had none of the address checking
  done to it, so following one would hand the endpoint a way round the whole
  thing. A 3xx stops the delivery and says to point the endpoint at its final
  URL.
- **An integration written by somebody else.** The signature is checked against
  a verifier in this repository. Whether a third-party Standard Webhooks
  library accepts it is a claim about their code, and the first real
  integration will settle it.
- **Anything on the deployed instance.** The Vercel deployment still runs old
  code — diagnosed in Phase 4, still unfixed, still in OPEN-ITEMS.

---

## What I need from you

Nothing new for this half. The security items in OPEN-ITEMS — rotate the
service-role key and the database password, enforce SSL, load the CA
certificate — are still the most overdue thing in the project.

One thing worth a decision when you are ready: **whether the API should be on
the plan gate.** Today any company can issue keys. Making it a paid tier is a
business decision rather than a technical one, and the place it would go is
`plans.js`, which already knows what each plan includes.
