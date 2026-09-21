/* The development provider.

   Writes to the server log and reports success. It is a provider like any
   other so that the drainer has exactly one code path — the moment the drainer
   contains "if log mode, do this instead", the real path stops being the one
   that gets exercised.

   It reports ok:true because the send genuinely succeeded at what it does. It
   is mode.js, not this file, that knows nothing reached a human. */
export const name = "log";

export async function send({ channel, to, subject, body }) {
  const head = `[outbox:${channel}] -> ${to}`;
  console.log(subject ? `${head} :: ${subject}` : head);
  if (body) console.log(`    ${String(body).split("\n").join("\n    ")}`);
  return {
    ok: true,
    providerMessageId: `log-${Date.now().toString(36)}`,
    error: null,
    retryable: false,
  };
}
