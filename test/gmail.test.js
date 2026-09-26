/* A Gmail sender address has to leave through that mailbox.

   The recipient sees the address the company typed. These tests drive a fake
   SMTP conversation so they can assert the From line without contacting Google. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  bareAddress, isGoogleMailbox, takeReply, composeMessage, send, MISSING_PASSWORD,
} from "../server/lib/delivery/gmail.js";
import { emailRoute } from "../server/lib/delivery/index.js";

describe("gmail sender", () => {
  test("a gmail address is the company's mailbox, and any other domain is not", () => {
    assert.equal(isGoogleMailbox("Property Pro <office@gmail.com>"), true);
    assert.equal(isGoogleMailbox("office@googlemail.com"), true);
    assert.equal(isGoogleMailbox("notices@ownerslease.com"), false);
    assert.equal(bareAddress("Property Pro <office@gmail.com>"), "office@gmail.com");
  });

  test("live mail from a gmail address is handed to that mailbox", () => {
    assert.equal(emailRoute("Property Pro <office@gmail.com>", "live"), "gmail");
    assert.equal(emailRoute("notices@ownerslease.com", "live"), "resend");
    assert.equal(emailRoute("office@gmail.com", "log"), "log");
    assert.equal(emailRoute("office@gmail.com", "off"), "off");
  });

  test("the message the recipient gets is from the gmail address", () => {
    const raw = composeMessage({
      from: "Property Pro <office@gmail.com>",
      to: "tenant@example.com",
      subject: "Rent",
      body: "Hello.\n.hidden",
      replyTo: "office@gmail.com",
    });
    assert.match(raw, /^From: Property Pro <office@gmail.com>\r\n/);
    assert.doesNotMatch(raw, /ownerslease\.com/);
    assert.match(raw, /\r\n\.\.hidden\r\n/);
  });

  test("a multi-line SMTP greeting is one reply", () => {
    const reply = takeReply("250-AUTH PLAIN\r\n250 OK\r\nleftover");
    assert.equal(reply.code, 250);
    assert.equal(reply.rest, "leftover");
    assert.equal(takeReply("250-AUTH PLAIN\r\n"), null);
  });

  test("without an app password nothing is sent and the error names that password", async () => {
    const result = await send({
      from: "Property Pro <office@gmail.com>",
      to: "tenant@example.com",
      subject: "Rent",
      body: "Hello",
      mode: "live",
      password: "",
    }, { password: "" });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(result.error, MISSING_PASSWORD);
    assert.doesNotMatch(result.error, /resend|verify your domain/i);
  });

  test("the SMTP conversation sends as the gmail address", async () => {
    const writes = [];
    const replies = [
      "250-smtp.gmail.com\r\n250 AUTH PLAIN\r\n",
      "235 Accepted\r\n",
      "250 OK\r\n",
      "250 OK\r\n",
      "354 Go ahead\r\n",
      "250 queued\r\n",
    ];
    const result = await send({
      from: "Property Pro <office@gmail.com>",
      to: "tenant@example.com",
      subject: "Rent",
      body: "Hello",
      mode: "live",
    }, {
      password: "abcdefghijklmnop",
      connect() {
        const socket = new EventEmitter();
        socket.write = (line) => {
          writes.push(String(line));
          const next = replies.shift();
          if (next != null) process.nextTick(() => socket.emit("data", next));
          return true;
        };
        socket.end = () => {};
        socket.destroy = () => {};
        process.nextTick(() => socket.emit("data", "220 smtp.gmail.com ESMTP\r\n"));
        return socket;
      },
    });

    assert.equal(result.ok, true);
    const transcript = writes.join("\n");
    assert.match(transcript, /MAIL FROM:<office@gmail.com>/);
    assert.match(transcript, /From: Property Pro <office@gmail.com>/);
    assert.doesNotMatch(transcript, /ownerslease\.com/);
    assert.doesNotMatch(transcript, /abcdefghijklmnop/);
  });

  test("a refused app password is permanent and does not echo the password", async () => {
    const result = await send({
      from: "office@gmail.com",
      to: "tenant@example.com",
      subject: "Rent",
      body: "Hello",
      mode: "live",
    }, {
      password: "abcdefghijklmnop",
      connect() {
        const socket = new EventEmitter();
        const replies = ["250 AUTH PLAIN\r\n", "535 Username and Password not accepted\r\n"];
        socket.write = () => {
          const next = replies.shift();
          if (next != null) process.nextTick(() => socket.emit("data", next));
          return true;
        };
        socket.end = () => {};
        socket.destroy = () => {};
        process.nextTick(() => socket.emit("data", "220 ready\r\n"));
        return socket;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, /app password/);
    assert.doesNotMatch(result.error, /abcdefghijklmnop/);
  });
});
