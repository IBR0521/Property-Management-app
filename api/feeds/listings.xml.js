/* The syndication feed, as its own Vercel function.

   vercel.json rewrites everything except /api/* into the main handler, so a
   path under /api needs a real file here. The XML itself is built by the
   listings feature — this file is only the transport, so the feed cannot drift
   between the two URLs it is served at.

   Public and unauthenticated on purpose: an aggregator crawls hourly and holds
   no account. Only listings explicitly marked for syndication appear. */
import { buildListingsXml } from "../../server/features/listings.js";
import { ready } from "../../server/lib/db.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    return res.end("Method not allowed");
  }
  try {
    await ready();
    const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
    const origin = `${proto}://${req.headers.host}`;
    const xml = await buildListingsXml(origin);

    res.writeHead(200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=900, s-maxage=900",
      "X-Robots-Tag": "noindex",
    });
    res.end(req.method === "HEAD" ? undefined : xml);
  } catch (err) {
    console.error("[feed] listings.xml failed", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // Still XML: a crawler that gets HTML here logs a parse error instead of a status.
    res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<error>feed unavailable</error>`);
  }
}
