/* What "delivery is on" actually means.

   This was three copies of `DELIVERY.mode === "none"` in three files. When
   config.js started defaulting the mode to "off" instead of "none", all three
   comparisons went false at once: the dashboard warning vanished, the Setup
   chip turned green, and the app began quietly claiming that 39 undelivered
   messages were fine. A magic string compared in three places is a promise
   nobody is keeping.

   So the question is a function now, and there is one of it.

   The distinction that matters is not "is a mode set" but "does anything reach
   a human". Three of the four modes do not:

     off      queue, send nothing            nothing reaches anyone
     log      drain to the console           nothing reaches anyone
     sandbox  provider accepts and discards  nothing reaches anyone
     live     provider sends                 it actually arrives

   The old code treated `log` as success and said so on the dashboard. It is
   not success — it is a developer watching text scroll past. Only `live`
   earns silence. */

export const MODES = ["off", "log", "sandbox", "live"];

export function isMode(v) {
  return MODES.includes(v);
}

/* The only thing that may make the UI stop warning. */
export function reachesRecipients(mode) {
  return mode === "live";
}

/* Whether the drainer should do anything at all with a queued row. */
export function drains(mode) {
  return mode !== "off";
}

/* What to tell a person, in their words, about what is happening to their
   messages. Returned rather than formatted so the caller decides the markup. */
export function describe(mode, queued = 0) {
  switch (mode) {
    case "live":
      return {
        tone: "ok",
        title: "Delivery is on",
        detail: queued
          ? `${queued} message${queued === 1 ? " is" : "s are"} waiting to go out.`
          : "Messages are being delivered.",
      };
    case "sandbox":
      return {
        tone: "warn",
        title: "Sandbox — nothing reaches anyone",
        detail:
          "Messages are accepted by the provider's test endpoint and discarded. " +
          "Useful for checking the wiring; nobody receives anything.",
      };
    case "log":
      return {
        tone: "warn",
        title: "Console only — nothing reaches anyone",
        detail:
          "Messages are written to the server log and marked sent. No email or " +
          "SMS leaves this machine.",
      };
    case "off":
    default:
      return {
        tone: "danger",
        title: "Nothing is being sent",
        detail:
          `${queued} message${queued === 1 ? " is" : "s are"} queued and not delivered. ` +
          "Reminders, owner approval requests and rent notices are recorded but " +
          "never arrive.",
      };
  }
}
