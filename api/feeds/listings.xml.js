/* The platform-wide feed URL, as its own Vercel function.

   It carries **no listings**, and that is the point. Feeds are per management
   company — a feed agreement is between one network and one company, and a
   shared document would publish other companies' listings under whichever
   name happened to sort first. This answers with a pointer at the right
   address rather than 404ing, because somebody will hand a network the
   obvious URL and should be told where to look instead.

   The real feeds are at `/feeds/<company>/listings.xml`, served by the main
   handler through vercel.json's rewrite.

   Public and unauthenticated on purpose: an aggregator crawls hourly and
   holds no account. */
import { feedsArePerCompany } from "../../server/lib/listings/mits.js";
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
    const xml = feedsArePerCompany(origin);

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
