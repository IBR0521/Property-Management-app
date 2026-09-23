/* Holding the uploaded files between the preview and the commit.

   The preview and the commit have to be the same act seen twice, and the only
   way to guarantee that is to run the same validator over the same bytes. So
   the upload is kept on the batch until it is committed, the preview screen
   re-validates it every time it is opened, and the commit re-validates it
   again before writing a row. Nothing is carried forward except the file.

   The alternative — validate once, keep the result, write from that — drifts
   the moment anything else changes underneath it. A preview approved on
   Tuesday that referenced an owner deleted on Wednesday would commit against
   a portfolio that no longer matches it.

   **It is deleted the moment it is no longer needed.** This column holds a
   customer's whole portfolio in plain text: names, addresses, what every
   tenant owes. A committed batch has no use for it and an abandoned one has
   no use for it after a week, so neither keeps it. The batch row itself
   stays, because "what did that import do" is a question asked afterwards. */

ALTER TABLE import_batch ADD COLUMN files TEXT;

/* So the sweeper can find the abandoned ones without reading every batch. */
CREATE INDEX import_batch_pending_idx
  ON import_batch (created_at)
  WHERE files IS NOT NULL;
