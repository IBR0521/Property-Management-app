/* Vercel Node runtime entry.

   Vercel hands a function the same (req, res) pair node:http does, so the
   application handler is used unchanged. Everything Vercel-specific lives in
   vercel.json and in the two environment variables the database needs. */
export { handle as default } from "../server/app.js";
