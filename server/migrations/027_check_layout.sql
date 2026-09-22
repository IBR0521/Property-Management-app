/* Where the variable data lands on a company's own cheque stock.

   Stock differs between suppliers: the payee line on one sits a quarter of an
   inch higher than on another, and a cheque printed out of position is
   rejected by the bank's reader. The defaults in lib/checks.js are the common
   US business layout; this is the override for a company whose stock is not.

   JSON rather than columns because it is a handful of coordinates that only
   the PDF writer reads, and adding eight nullable numeric columns to `company`
   for something one company in twenty will touch would be worse. */
ALTER TABLE company ADD COLUMN check_layout TEXT;
