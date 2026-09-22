/* Registering the service worker.

   The first script this application has ever loaded. It is an external file
   rather than an inline block because the Content-Security-Policy is
   `script-src 'self'` with no nonce and no 'unsafe-inline', which means an
   injected <script> tag has nothing to execute. Keeping it that way is worth
   more than the two lines this file saves.

   Failure is silent on purpose. A browser without service workers, a private
   window that refuses registration, an insecure origin during local
   development — none of those are conditions a person needs to be told about,
   and none of them stop a single page working. */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}
