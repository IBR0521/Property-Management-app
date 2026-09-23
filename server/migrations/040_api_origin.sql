/* Where a record came from, when it came from a caller rather than a person.

   Both of these columns are the honest answer to "how did this get here",
   and the API is a way things get here that neither of them could say. The
   alternative was to have the API claim to be a member of staff, which is
   the kind of small lie that makes an audit trail worthless later.

   `work_order.reported_channel` gains 'api': a job raised by an integration
   is not a job logged at a desk, and the difference matters when somebody is
   working out why nobody rang the tenant back.

   `ledger_entry.source` gains 'api': a payment recorded by an integration is
   not one typed on a screen, and a bookkeeper reconciling an odd figure
   should be able to see which. */

ALTER TABLE work_order DROP CONSTRAINT work_order_reported_channel_check;
ALTER TABLE work_order ADD CONSTRAINT work_order_reported_channel_check
  CHECK (reported_channel IN ('web', 'phone', 'staff', 'email', 'api'));

ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_source_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_source_check
  CHECK (source IN ('manual', 'import', 'work_order', 'system', 'api'));
