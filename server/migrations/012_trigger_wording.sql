/* lower(TG_OP) yields "update" and "delete", so the refusal read "signatures
   are evidence and cannot be update". This message is shown to a person, so it
   should be written like one. */
CREATE OR REPLACE FUNCTION forbid_signature_rewrite() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'signatures are evidence and cannot be % — void the document instead',
    (CASE TG_OP WHEN 'UPDATE' THEN 'changed' ELSE 'deleted' END)
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
