/* Installing the application on a phone.

   Three small routes and nothing clever.

   `/sw.js` is served from the root rather than from `/app-assets/` because a
   service worker's scope is its own directory: one served at
   `/app-assets/sw.js` could only ever control `/app-assets/`, which is the
   part of the site that needs it least. The file itself lives with the other
   assets; only the URL is at the root.

   `/offline` is the page the worker falls back to when a navigation fails. It
   exists as a real page rather than a string inside the worker so that it
   looks like the rest of the application — it is rendered by the same shell
   as every other public page, which is also why it is cached rather than
   generated: the worker stores the finished HTML at install.

   The manifests are static files. There are two, because a tenant should not
   be offered "Operations" and a manager should not be offered "Your home".
   Neither carries the company's name: a manifest is fetched without
   credentials, so the server cannot know which company is installing, and an
   icon labelled with the wrong company would be worse than a generic one. */
import { sendHtml, sendText } from "../lib/http.js";
import { serveFromRoot } from "../lib/static.js";
import { html } from "../lib/render.js";
import { publicPage } from "../views/layout.js";

export function registerPwa(router) {
  router.get("/sw.js", async (ctx) => {
    /* `no-cache` from the static server, so a replacement reaches installed
       devices on the next navigation. This is the removal path for a worker
       that turns out to be wrong, and it only works if this is never cached
       hard. */
    if (serveFromRoot(ctx.res, "app-assets/sw.js")) return;
    return sendText(ctx.res, "Not found", 404);
  });

  router.get("/offline", async (ctx) => {
    sendHtml(ctx.res, offlinePage());
  });
}

/* Deliberately flat about what did and did not happen. The failure this page
   guards against is somebody typing a repair report, seeing a friendly
   "we'll send this when you're back online", and believing it. */
function offlinePage() {
  return publicPage({
    title: "Offline",
    heading: "You are offline",
    lede: "This device has no connection, so this page could not be loaded.",
    body: html`
      <div class="panel">
        <div class="panel__body">
          <p><b>Nothing you typed was sent.</b> There is no queue holding it and
          nothing will be submitted later. If you were part way through a form,
          it will need doing again once you have signal.</p>
          <p style="margin-top:.75rem">If this is an emergency — a leak, no heat,
          no power, anything unsafe — use a phone call rather than this app.</p>
          <p style="margin-top:1.5rem">
            <a class="pill solid" href="/app">Try again</a>
          </p>
        </div>
      </div>`,
    foot: "This page was stored on your device. Everything else needs a connection.",
  });
}
