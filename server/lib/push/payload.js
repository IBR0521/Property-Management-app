/* What a push notification is allowed to say.

   A notification is read on a lock screen. That means it is read by whoever
   is holding the phone — a colleague, a partner, somebody on a train looking
   over a shoulder — and by anybody who picks the handset up later. It is the
   one surface in this application where content reaches a person who has not
   signed in to anything.

   So the rule is that **no payload carries money, a balance, a name or an
   address**:

     yes   "A new emergency job"          then open the app to see which
     yes   "An owner approval is waiting"
     no    "Priya Anand owes $1,450"
     no    "Rent received for 412 Maple Grove Dr"

   This is enforced rather than intended. A payload is built only from the
   shapes below, every one is a fixed string plus an opaque id, and `build`
   refuses anything else. The failure mode being guarded against is somebody
   later adding `${tenant.name}` to a title because it would be more useful —
   which it would, and which is exactly the problem. */

/* Every notification this application can send. The title and body are
   constants; `url` is where tapping it goes, and the app asks the person to
   sign in before showing anything there. */
export const KINDS = {
  emergency: {
    title: "Emergency job",
    body: "Somebody has reported an emergency. Open the app.",
    url: "/app",
    urgency: "high",
  },
  job_assigned: {
    title: "A job was assigned to you",
    body: "Open the app to see it.",
    url: "/app/jobs",
    urgency: "normal",
  },
  approval_waiting: {
    title: "An approval is waiting",
    body: "Work cannot start until you decide. Open the app.",
    url: "/portal/home/owning",
    urgency: "normal",
  },
  message_received: {
    title: "New message",
    body: "Somebody has written to you. Open the app to read it.",
    url: "/app/inbox",
    urgency: "normal",
  },
  payment_receipt: {
    title: "Payment received",
    body: "A payment has cleared. Open the app for the detail.",
    url: "/app/payments",
    urgency: "normal",
  },
};

/* Anything that could identify a person or an amount. Checked against the
   finished payload rather than against the inputs, so a field added later
   without thought is caught by the same net. */
const FORBIDDEN = [
  { name: "an amount of money", test: /[$£€]\s*\d|\d+\.\d{2}\b/ },
  /* A number, then one to three capitalised words, then a street type.
     "412 Maple Grove Dr" has two words before the type and an earlier
     version of this only allowed one — which let a real address through. */
  { name: "what looks like an address",
    test: /\b\d+\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Terrace|Close)\b/ },
  { name: "an email address", test: /[^@\s]+@[^@\s]+\.[^@\s]+/ },
  { name: "a phone number", test: /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/ },
];

export function build(kind, { url = null, tag = null } = {}) {
  const shape = KINDS[kind];
  if (!shape) {
    throw new Error(
      `"${kind}" is not a notification this application sends. `
      + `Add it to KINDS, where somebody will read the wording, rather than passing a string.`);
  }

  const payload = {
    title: shape.title,
    body: shape.body,
    /* A relative path only. An absolute URL here would let a notification
       send somebody to another origin. */
    url: safePath(url) || shape.url,
    /* Collapses repeats on the device: five new messages are one badge
       rather than five buzzes. */
    tag: tag ? String(tag).slice(0, 60) : kind,
  };

  const text = `${payload.title} ${payload.body}`;
  for (const rule of FORBIDDEN) {
    if (rule.test.test(text)) {
      throw new Error(
        `That notification contains ${rule.name}. Push payloads are read on a `
        + `lock screen by whoever holds the phone — say that something happened `
        + `and let the app show what, behind a sign-in.`);
    }
  }

  return payload;
}

/* A path within this application, or nothing. */
export function safePath(url) {
  if (!url) return null;
  const value = String(url);
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value.slice(0, 200);
}

export function urgencyOf(kind) {
  return KINDS[kind]?.urgency || "normal";
}
