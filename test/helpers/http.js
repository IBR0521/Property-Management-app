/* A real server on an ephemeral port, driven with fetch.

   The alternative is calling handle(req, res) with hand-built mock objects.
   That skips the parts most likely to be wrong — header casing, cookie
   round-trips, redirect handling, multipart parsing — so it tests the handler
   rather than the application. A real socket costs milliseconds and exercises
   all of it. */
import { createServer } from "node:http";
import { handle } from "../../server/app.js";

export async function startApp() {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* fetch has no cookie jar, and every interesting path here is a session plus a
   double-submit CSRF token. This is that jar, plus the form-posting the app's
   own pages do. */
export function client(origin) {
  const jar = new Map();

  const cookieHeader = () =>
    [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");

  const absorb = (res) => {
    for (const raw of res.headers.getSetCookie?.() || []) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === "" || /Max-Age=0/i.test(raw)) jar.delete(name);
      else jar.set(name, value);
    }
  };

  async function raw(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (jar.size) headers.cookie = cookieHeader();
    const res = await fetch(`${origin}${path}`, { ...opts, headers, redirect: "manual" });
    absorb(res);
    return res;
  }

  return {
    jar,
    raw,

    async get(path, opts = {}) {
      return await raw(path, { method: "GET", ...opts });
    },

    async text(path, opts = {}) {
      const res = await raw(path, { method: "GET", ...opts });
      return { res, body: await res.text() };
    },

    /* Reads the CSRF token out of the page that carries the form, the way a
       browser would, rather than minting one — so a broken CSRF pipeline fails
       the test instead of being bypassed by it. */
    async csrf(path) {
      const { body } = await this.text(path);
      const m = body.match(/name="_csrf"\s+value="([^"]*)"/);
      return m ? m[1] : null;
    },

    async post(path, fields, { csrfFrom, headers = {}, csrf } = {}) {
      const token = csrf !== undefined ? csrf : await this.csrf(csrfFrom || path);
      const body = new URLSearchParams();
      if (token) body.set("_csrf", token);
      for (const [k, v] of Object.entries(fields || {})) {
        if (Array.isArray(v)) v.forEach((x) => body.append(k, String(x)));
        else if (v != null) body.set(k, String(v));
      }
      return await raw(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: body.toString(),
      });
    },

    async signIn(email, password) {
      const token = await this.csrf("/app/sign-in");
      const res = await this.post("/app/sign-in", { email, password }, { csrf: token });
      /* Both outcomes are a 303: to /app on success, back to the form carrying
         an error on failure. Reading the status alone would call every
         rejection a success, so the Location is what decides. */
      const location = res.headers.get("location") || "";
      /* Not called "ok": Response.ok is a read-only getter on the prototype,
         so assigning to it does nothing and every caller silently reads the
         native value instead. */
      const signedIn = res.status === 303 && !/\/app\/sign-in/.test(location);
      return { status: res.status, headers: res.headers, signedIn, location, res,
               text: () => res.text() };
    },

    /* Follows one redirect and returns the page a browser would land on.
       Sign-in errors live there, not in the empty body of the 303. */
    async follow(res) {
      const location = res.headers.get("location");
      if (!location) return { res, body: await res.text() };
      return await this.text(location.replace(origin, ""));
    },
  };
}
