/* Sending, behind one interface.

   Every caller asks the same thing — send this, to this address, on this
   channel — and every provider answers the same shape. The drainer therefore
   has one code path rather than a branch per mode, which matters because a
   branch per mode means the production path is the one least often run.

   The answer shape:

     { ok, providerMessageId, error, retryable }

   `retryable` is the field that earns its place. A 500 from a provider is
   worth trying again; "that is not a mobile number" never will be, and
   retrying it five times is how a queue fills with noise that hides the real
   failures. Only a provider's own adapter knows which of its codes mean
   which, so each one decides for itself. */
import { DELIVERY_MODE } from "../config.js";
import { drains, reachesRecipients, describe } from "./mode.js";
import * as logProvider from "./log.js";
import * as resend from "./resend.js";
import * as gmail from "./gmail.js";
import { isGoogleMailbox } from "./gmail.js";
import * as twilio from "./twilio.js";
import { blockedReason } from "./consent.js";

export { drains, reachesRecipients, describe };

/* Resolved per call rather than at import, so a test can hand in a fake
   without reloading the module, and so an unknown mode fails at the moment of
   sending — where the failure is attributable to a message — rather than at
   boot.

   A Gmail address is sent by Google as that mailbox. Everything else on the
   email channel stays with Resend, which can only stamp a domain it holds
   DNS for. Log mode never opens either connection. */
export function emailRoute(from, forMode = DELIVERY_MODE) {
  if (!drains(forMode)) return "off";
  if (forMode === "log") return "log";
  if (isGoogleMailbox(from)) return "gmail";
  return "resend";
}

export function providerFor(channel, forMode = DELIVERY_MODE) {
  if (!drains(forMode)) return null;
  if (forMode === "log") return logProvider;

  /* sandbox and live use the same adapters. The difference is entirely in the
     credentials: a Resend test key and Twilio's magic test SID accept requests
     and discard them, which exercises the real HTTP path, the real auth and
     the real error shapes without anything being delivered or charged. Having
     sandbox take a different code path would defeat the purpose of having it. */
  if (channel === "email") return resend;
  if (channel === "sms") return twilio;
  return logProvider;
}

/* One send. Never throws: a provider being unreachable is an outcome to record
   against this message, not an exception that aborts the drain of the fifty
   behind it.

   Consent is checked here rather than at each of the twelve call sites that
   write to the outbox, because a check every producer has to remember is a
   check one of them will not. */
export async function deliver(
  { channel, to, subject, body, from, replyTo, companyId, kind = "transactional" },
  forMode = DELIVERY_MODE
) {
  if (companyId) {
    const blocked = await blockedReason(companyId, channel, to, kind);
    if (blocked) {
      return {
        ok: false, providerMessageId: null, error: blocked,
        /* Not retryable and not a failure: the message did what it should
           have, which was not to go. */
        retryable: false, suppressed: true, provider: null,
      };
    }
  }

  const route = channel === "email" ? emailRoute(from, forMode) : null;
  const provider = route === "gmail" ? gmail
    : route === "log" ? logProvider
    : route === "off" ? null
    : providerFor(channel, forMode);
  if (!provider) {
    return { ok: false, providerMessageId: null, error: "delivery is off", retryable: true, provider: null };
  }
  try {
    const result = await provider.send({ channel, to, subject, body, from, replyTo, companyId, mode: forMode });
    return { ...result, provider: provider.name };
  } catch (err) {
    return {
      ok: false,
      providerMessageId: null,
      error: String(err?.message || err).slice(0, 300),
      /* An exception here is a transport failure — DNS, a socket, a timeout —
         rather than the provider judging the message. Those are worth another
         attempt. */
      retryable: true,
      provider: provider.name,
    };
  }
}
