/* Retiring `4000 Rent income`.

   Under the agency model the rent is the owner's income, not the manager's.
   Nothing has credited this account since the Phase 6 correction — a rent
   charge credits `2400 Rent due to owners` and the receipt moves it to
   `2200`, because an agent collecting rent is holding somebody else's money
   rather than earning revenue.

   So the account has sat in every company's chart, offered on the journal
   form, posting to nothing. OPEN-ITEMS A2: "leaving an account nobody posts
   to is a trap for whoever reads the chart next." The trap is specific — it
   is the account a person reaches for when they are looking for where rent
   went, and it is the wrong answer.

   ## Retired, not deleted

   `active = 0` takes it off the journal form, which is the only place new
   postings are chosen. It keeps the account, its name and anything ever
   posted to it, because a company that used this application before the
   correction has rent income on it and that history is real.

   This is safe now and was not before. Every report in `reports/financial.js`
   filtered on `active = 1`, so retiring an account with postings removed them
   from the profit and loss and put the balance sheet out by the same amount.
   That filter now keeps any account carrying history. Tested both ways.

   Repurposing it for owner-level reporting was the other option A2 offered.
   Not taken: an account that means one thing in old journals and another in
   new ones is worse than one nobody posts to. */

UPDATE account SET active = 0
 WHERE code = '4000'
   AND active = 1;
