/* A company's own settings, for the things that are one value rather than a
   table.

   `setting` is a key/value row per company and it predates everything that
   uses it. The read and write were written out twice — once in payments.js
   for the Connect state and once here — which is one time too many for
   fifteen lines that decide how a value is stored. */
import { get, run } from "./db.js";

/* JSON in the column, always. A setting that is a string today is an object
   the first time it needs a second field, and a store that holds both shapes
   is a store every reader has to sniff. */
export async function putSetting(companyId, key, value) {
  if (value === null || value === undefined) {
    await run("DELETE FROM setting WHERE company_id = ? AND key = ?", companyId, key);
    return;
  }
  await run(
    `INSERT INTO setting (company_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    companyId, key, JSON.stringify(value));
}

export async function readSetting(companyId, key, fallback = null) {
  const row = await get(
    "SELECT value FROM setting WHERE company_id = ? AND key = ?", companyId, key);
  if (!row?.value) return fallback;
  try {
    const parsed = JSON.parse(row.value);
    return parsed === null ? fallback : parsed;
  } catch {
    /* Written before this module existed, or by hand. A bare string is a
       legitimate thing to find and losing it would be worse than returning
       it. */
    return row.value;
  }
}
