/* Mail that leaves as the company's own Gmail address.

   Resend can only stamp a domain it has DNS for. A Gmail address is not one
   of those domains, and the recipient is supposed to see the address the
   company typed. Google is the server that can put that address on the
   message, so this talks SMTP to smtp.gmail.com as that mailbox.

   The app password is the company's, stored sealed on the company row. It is
   never written into an error or a log line. */
import tls from "node:tls";
import { get } from "../db.js";
import { tryOpen } from "../crypto.js";
import { reachesRecipients } from "./mode.js";

export const name = "gmail";

const HOST = "smtp.gmail.com";
const PORT = 465;

export const MISSING_PASSWORD =
  "The sender is a Gmail address, so Google has to send it. Save that mailbox's app password on Company, then send it again.";

export function bareAddress(value) {
  const text = String(value || "").trim();
  const wrapped = text.match(/<([^>]+)>/);
  return (wrapped ? wrapped[1] : text).trim().toLowerCase();
}

export function isGoogleMailbox(value) {
  const domain = bareAddress(value).split("@")[1] || "";
  return domain === "gmail.com" || domain === "googlemail.com";
}

const ADDRESS = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

/* One email address, nothing else. A saved value can be `Name <a@b.com>`,
   `Name a@b.com`, or just the address. Resend rejects anything that is not
   exactly `a@b.com` or `Name <a@b.com>`. */
export function cleanAddress(value) {
  const bare = bareAddress(value);
  if (ADDRESS.test(bare)) return bare.toLowerCase();
  const found = String(value || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return found && ADDRESS.test(found[0]) ? found[0].toLowerCase() : "";
}

function cleanLabel(from) {
  const raw = String(from || "");
  const head = raw.includes("<") ? raw.slice(0, raw.indexOf("<")) : "";
  return head.replace(/[<>"\r\n]/g, "").trim();
}

/* Google will not let another server stamp a Gmail address. The message still
   goes out. The From line is always one clean address, and a reply still
   lands on the Gmail address the company typed. */
export function asDeliverable(from, replyTo, emailFrom) {
  const own = cleanAddress(from);
  const configured = cleanAddress(emailFrom);
  const platform = configured && !isGoogleMailbox(configured) ? configured : "notices@ownerslease.com";
  const address = own && !isGoogleMailbox(own) ? own : platform;
  const label = cleanLabel(from);
  const reply = cleanAddress(replyTo) || (isGoogleMailbox(own) ? own : "");
  return { from: label ? `${label} <${address}>` : address, replyTo: reply || null };
}

export function takeReply(buffer) {
  let start = 0;
  const text = String(buffer);
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return null;
    const line = text.slice(start, nl).replace(/\r$/, "");
    if (!/^\d{3}[ -]/.test(line)) return null;
    if (line[3] === " ") {
      return { code: Number(line.slice(0, 3)), text: text.slice(0, nl + 1), rest: text.slice(nl + 1) };
    }
    start = nl + 1;
  }
  return null;
}

function headerValue(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

export function composeMessage({ from, to, subject, body, replyTo }) {
  const headers = [
    `From: ${headerValue(from)}`,
    `To: ${headerValue(to)}`,
    `Subject: ${headerValue(subject) || "(no subject)"}`,
  ];
  if (replyTo) headers.push(`Reply-To: ${headerValue(replyTo)}`);
  headers.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8");
  const text = String(body || "").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const stuffed = text.split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${stuffed}\r\n.\r\n`;
}

function fail(error, retryable) {
  return { ok: false, providerMessageId: null, error, retryable };
}

function judge(reply) {
  const code = reply.code;
  const text = reply.text.replace(/\s+/g, " ").trim().slice(0, 180);
  const retryable = code === 421 || code === 450 || code === 451 || code === 452 || code === 454;
  return fail(`gmail ${code}: ${text}`, retryable);
}

function connectGmail() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: HOST, port: PORT, servername: HOST });
    const giveUp = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once("secureConnect", () => {
      socket.setTimeout(10_000, () => giveUp(new Error("gmail timed out")));
      resolve(socket);
    });
    socket.once("error", giveUp);
  });
}

function session(socket) {
  let buffer = "";
  let waiter = null;

  const flush = () => {
    if (!waiter) return;
    const reply = takeReply(buffer);
    if (!reply) return;
    buffer = reply.rest;
    const pending = waiter;
    waiter = null;
    pending.resolve(reply);
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    flush();
  });
  socket.on("error", (err) => {
    if (!waiter) return;
    const pending = waiter;
    waiter = null;
    pending.reject(err);
  });

  return {
    read() {
      const ready = takeReply(buffer);
      if (ready) {
        buffer = ready.rest;
        return Promise.resolve(ready);
      }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        flush();
      });
    },
    write(line) {
      socket.write(`${line}\r\n`);
    },
  };
}

async function passwordFor(companyId) {
  if (!companyId) return null;
  const row = await get("SELECT mailbox_secret_sealed FROM company WHERE id = ?", companyId);
  if (!row?.mailbox_secret_sealed) return null;
  return tryOpen(row.mailbox_secret_sealed);
}

export async function send(message, deps = {}) {
  const from = message.from;
  const sender = bareAddress(from);
  if (!isGoogleMailbox(sender)) {
    return fail("this sender is not a Gmail address", false);
  }
  const recipient = bareAddress(message.to);
  if (!recipient.includes("@")) return fail("that recipient is not an email address", false);

  if (!deps.connect && !reachesRecipients(message.mode)) {
    return {
      ok: false, providerMessageId: null, retryable: false, suppressed: true,
      error: "this mode does not hand mail to a mailbox",
    };
  }

  const password = deps.password !== undefined ? deps.password : await passwordFor(message.companyId);
  if (!password) return fail(MISSING_PASSWORD, false);

  const connect = deps.connect || connectGmail;
  let socket;
  try {
    socket = await connect();
    const talk = session(socket);
    const greet = await talk.read();
    if (greet.code !== 220) return judge(greet);

    talk.write("EHLO localhost");
    const ehlo = await talk.read();
    if (ehlo.code !== 250) return judge(ehlo);

    const token = Buffer.from(`\0${sender}\0${password}`, "utf8").toString("base64");
    talk.write(`AUTH PLAIN ${token}`);
    const auth = await talk.read();
    if (auth.code !== 235) {
      const refused = auth.code === 535 || auth.code === 534;
      return fail(
        refused
          ? "Google refused the app password saved for this Gmail address. Create a new one under Google Account, Security, App passwords, and save it on Company."
          : judge(auth).error,
        refused ? false : judge(auth).retryable,
      );
    }

    talk.write(`MAIL FROM:<${sender}>`);
    const mailed = await talk.read();
    if (mailed.code !== 250) return judge(mailed);

    talk.write(`RCPT TO:<${recipient}>`);
    const accepted = await talk.read();
    if (accepted.code !== 250 && accepted.code !== 251) return judge(accepted);

    talk.write("DATA");
    const ready = await talk.read();
    if (ready.code !== 354) return judge(ready);

    socket.write(composeMessage({
      from, to: message.to, subject: message.subject, body: message.body, replyTo: message.replyTo,
    }));
    const queued = await talk.read();
    if (queued.code !== 250) return judge(queued);

    talk.write("QUIT");
    return {
      ok: true,
      providerMessageId: queued.text.replace(/\s+/g, " ").trim().slice(0, 200),
      error: null,
      retryable: false,
    };
  } catch (err) {
    return fail(`gmail unreachable: ${String(err?.message || err).slice(0, 160)}`, true);
  } finally {
    socket?.end?.();
    socket?.destroy?.();
  }
}
