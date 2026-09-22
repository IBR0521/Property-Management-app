/* The service worker.

   Its entire job is to make the application open when there is no signal and
   to say so plainly when it cannot. It is not a cache layer and it is not an
   offline database.

   ## The rule

   **Nothing that knows who you are is ever written to a cache.**

   A cached page is a copy sitting on a handset. It survives signing out, it is
   readable by whoever picks the phone up, and the application never learns it
   happened — so there is no audit trail for a disclosure that has already
   occurred. A rent balance cached on a shared phone is exactly that.

   The rule is enforced by construction rather than by a list of private paths
   to avoid. There is **one** write to the cache in this file, in `install`, of
   a fixed list of static assets. There is no `cache.put` anywhere else, so
   there is no code path — present or future, absent an edit to this file —
   that can put a response from `/app`, `/portal`, `/pay`, `/o/`, `/t/`, `/r/`
   or `/sign/` into storage.

   A denylist of private prefixes was the obvious alternative and is weaker:
   it has to be updated every time a new prefix is added, and the failure when
   somebody forgets is silent and invisible. An allowlist of four stylesheets
   and some icons fails the other way, which is the right way.

   ## What it does

   Every request goes to the network first. The cache is read only when the
   network fails, which means an online device always gets the current page and
   the current stylesheet — there is no staleness to reason about. The cost is
   nothing, because the shell is served `Cache-Control: no-cache` and the
   browser's own HTTP cache handles the revalidation.

   A navigation that fails falls back to `/offline`, which says that nothing
   was sent. There is no write queue. Composing a repair report in a stairwell
   with no signal and having it replay twenty minutes later is a genuinely nice
   feature and a bad one to build blind: it duplicates on retry, it fights the
   CSRF token, and it tells somebody their report was filed when it may still
   fail.

   ## Getting rid of it

   A service worker is sticky, and the device is not one you hold. The reliable
   removal is to deploy a `/sw.js` whose `install` calls `unregister()` and
   deletes every cache — browsers revalidate the worker script itself on
   navigation rather than serving it from any cache, so a replacement reaches
   installed devices without anybody clearing site data.

   Bumping VERSION is the lesser version of that: `activate` deletes every
   cache this origin holds except the current one. */

const VERSION = "1";
const CACHE = `propops-shell-${VERSION}`;

/* The whole of what may ever be stored. Adding a path here is a decision about
   what may sit on a handset indefinitely; it must be something that is the
   same for every company and every person. */
const SHELL = [
  "/assets/css/styles.css",
  "/app-assets/app.css",
  "/app-assets/icons/icon-192.png",
  "/app-assets/icons/icon-512.png",
  "/app-assets/icons/maskable-192.png",
  "/app-assets/icons/maskable-512.png",
  "/offline",
];

const OFFLINE = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* Individually rather than addAll, which rejects the whole install if any
       single asset 404s — and an install that fails leaves the previous
       worker in place with no indication why. */
    await Promise.all(SHELL.map((path) =>
      cache.add(new Request(path, { cache: "reload" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  /* Only GET, and only this origin. A POST must never be answered from
     anywhere but the server, and another origin's responses are not ours to
     hold. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (SHELL.includes(url.pathname)) {
    event.respondWith(networkThenCache(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkThenOffline(request));
    return;
  }

  /* Everything else is left alone entirely — not fetched through here, not
     inspected, not stored. */
});

/* The network, and the cached copy only if there is no network. Note what is
   missing: the successful response is not written back. The cache holds what
   `install` put there and nothing else, for as long as VERSION is unchanged. */
async function networkThenCache(request) {
  try {
    return await fetch(request);
  } catch (err) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

/* --- notifications --------------------------------------------------------

   What arrives here has already been through the payload builder on the
   server, which refuses anything carrying money, a name or an address. This
   end does not get to add any: it renders the title and body it was given and
   nothing from the request, the URL or the device. */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    /* Undecryptable or not ours. Chrome requires a notification for every
       push that arrives, and a silent failure here shows the browser's own
       "This site has been updated in the background" — which is worse than
       saying plainly that something happened. */
    payload = {};
  }

  event.waitUntil(self.registration.showNotification(
    typeof payload.title === "string" ? payload.title : "Property operations",
    {
      body: typeof payload.body === "string" ? payload.body : "Open the app to see.",
      /* Five new messages should be one badge, not five buzzes. */
      tag: typeof payload.tag === "string" ? payload.tag : "general",
      icon: "/app-assets/icons/icon-192.png",
      data: { url: safePath(payload.url) },
    }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data && event.notification.data.url);

  event.waitUntil((async () => {
    /* An open window is focused and navigated rather than a second one
       opened, so tapping four notifications does not leave four copies of the
       application running. */
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ("navigate" in client) await client.navigate(path);
      return;
    }
    await self.clients.openWindow(path);
  })());
});

/* A notification that can send somebody to another origin is a phishing
   primitive arriving with our name on it, so the destination is reduced to a
   path on this origin or discarded. The server already does this; doing it
   again here means a payload that reached the device by some other route
   still cannot. */
function safePath(value) {
  if (typeof value !== "string") return "/app";
  if (!value.startsWith("/") || value.startsWith("//")) return "/app";
  return value;
}

/* A page. If the network is gone, the offline page — never a cached copy of
   the page that was asked for, which is the whole point. */
async function networkThenOffline(request) {
  try {
    return await fetch(request);
  } catch {
    const hit = await caches.match(OFFLINE);
    if (hit) return hit;
    return new Response(
      "You are offline, and nothing was sent.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
