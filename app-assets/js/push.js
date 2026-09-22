/* Turning on notifications for this device.

   The one control in this application that needs a script. The list of
   devices and the button that stops each one are plain forms and work
   without this file — which is the right way round, because being able to
   turn something off must never depend on a script loading.

   ## Why it re-subscribes on every load

   A push subscription is not permanent. Browsers rotate them, and when that
   happens the old endpoint stops working and nothing tells the application.
   The service worker gets a `pushsubscriptionchange` event, but it has no
   session and no CSRF token, so it cannot tell the server about the new one.

   So the sync happens here instead, on a page load, where both exist: if the
   browser holds a subscription, it is posted again. Subscribing is
   idempotent — the same endpoint updates the row rather than adding one — so
   this costs one request and closes the window where notifications are
   silently dead.

   ## What it does not do

   It never asks for permission on load. A permission prompt nobody asked for
   is how a person ends up blocking notifications permanently, and "blocked"
   cannot be undone from here — only from browser settings. The prompt happens
   on a click and nowhere else. */
(() => {
  const box = document.querySelector("[data-push]");
  if (!box) return;

  const state = box.querySelector("[data-push-state]");
  const button = box.querySelector("[data-push-enable]");
  const key = box.dataset.key;
  const base = box.dataset.base;
  const csrf = box.dataset.csrf;

  const say = (text) => { state.textContent = text; };

  /* Not `button.hidden`. `.pill` sets `display:inline-flex`, which beats the
     browser's own `[hidden] { display: none }` rule, so setting the attribute
     leaves the button on screen — which is how a "notifications are blocked"
     message ended up sitting directly above a button offering to turn them
     on. The style property is the thing that actually decides. */
  const show = (on) => { button.style.display = on ? "" : "none"; };

  const supported = "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;

  if (!supported) {
    /* Named rather than generic: on an iPhone this is almost always a page
       open in Safari rather than an installed app, and "not supported" would
       send somebody looking for a setting that does not exist. */
    say(/iPhone|iPad/.test(navigator.userAgent)
      ? "To get notifications on an iPhone or iPad, add this to your home screen first, then open it from there."
      : "This browser cannot show notifications.");
    return;
  }

  main().catch(() => say("Something went wrong checking this device."));

  async function main() {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();

    if (Notification.permission === "denied") {
      say("Notifications are blocked for this site. That can only be changed in your browser's settings.");
      return;
    }

    if (existing) {
      /* Held by the browser, so make sure the server holds it too. */
      await send(existing);
      say("This device is set up. It will be notified.");
      return;
    }

    say("This device is not set up yet.");
    show(true);
    button.addEventListener("click", enable, { once: true });
  }

  async function enable() {
    button.disabled = true;
    say("Waiting for you to allow notifications…");

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      button.disabled = false;
      show(permission !== "denied");
      say(permission === "denied"
        ? "Notifications are blocked for this site. That can only be changed in your browser's settings."
        : "Nothing was changed.");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        /* Required by Chrome, and the right promise anyway: every push this
           application sends puts something on the screen. A silent push is a
           way to wake a background script, which is not what this is for. */
        userVisibleOnly: true,
        applicationServerKey: decodeKey(key),
      });

      const ok = await send(subscription);
      if (!ok) {
        /* Rolled back rather than left half-done: a browser holding a
           subscription the server has no record of is a device that will
           never be notified and says it is set up. */
        await subscription.unsubscribe();
        throw new Error("the server did not accept it");
      }

      say("This device is set up. It will be notified.");
      button.remove();
    } catch (err) {
      button.disabled = false;
      say("This device could not be set up. Nothing was changed.");
    }
  }

  async function send(subscription) {
    const res = await fetch(`${base}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ _csrf: csrf, subscription: subscription.toJSON() }),
    });
    return res.ok;
  }

  /* applicationServerKey wants raw bytes, and the key travels as base64url.
     Not `atob` on the string directly: base64url swaps two characters and
     drops the padding, and `atob` on the result either throws or silently
     decodes to the wrong bytes — which then fails much later as an
     unexplained "invalid sender". */
  function decodeKey(base64url) {
    const padded = base64url.replace(/-/g, "+").replace(/_/g, "/")
      + "=".repeat((4 - (base64url.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
})();
