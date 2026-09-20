/* A small router.

   Routes are matched in registration order against a pattern with :params.
   No regex soup at the call site and no dependency; the whole thing is one
   pass over an array, which for a few dozen routes is faster than anything
   clever would be. */

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/:([A-Za-z_]+)/g, (_, k) => {
            keys.push(k);
            return "([^/]+)";
          })
          .replace(/\*$/, "(.*)") +
        "$"
    );
    if (pattern.endsWith("*")) keys.push("wildcard");
    routes.push({ method, pattern, rx, keys, handler });
  }

  return {
    get: (p, h) => add("GET", p, h),
    post: (p, h) => add("POST", p, h),
    match(method, pathname) {
      for (const route of routes) {
        if (route.method !== method) continue;
        const m = route.rx.exec(pathname);
        if (!m) continue;
        const params = Object.create(null);
        route.keys.forEach((k, i) => { params[k] = safeDecode(m[i + 1]); });
        return { handler: route.handler, params, pattern: route.pattern };
      }
      return null;
    },
    /* Whether a path exists under another method, so we can answer 405
       instead of a misleading 404. */
    methodsFor(pathname) {
      return routes.filter((r) => r.rx.test(pathname)).map((r) => r.method);
    },
    get size() { return routes.length; },
  };
}

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}
