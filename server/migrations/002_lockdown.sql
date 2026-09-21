-- ===========================================================================
-- Lock the public schema away from the REST API
-- ---------------------------------------------------------------------------
-- Supabase exposes every table in `public` through PostgREST, reachable with
-- the publishable key — a key that is meant to be public and typically ships
-- in client code. By default anon and authenticated hold full privileges on
-- every table, which for this app means anyone holding that key could read
-- session ids and impersonate a signed-in manager, read staff password
-- hashes, read every tenant's name, email and phone, read the token columns
-- that ARE the credentials for tenant and owner links, and write to any of it.
--
-- This application never uses PostgREST. It connects directly as `postgres`,
-- which owns these tables and has rolbypassrls, so everything below is
-- invisible to it and nothing here can break the app.
--
-- Two independent layers, deliberately:
--   1. RLS on with no policies  -> the API returns nothing
--   2. Grants revoked           -> the API has no privilege to begin with,
--                                  so a permissive policy added later by
--                                  accident still exposes nothing
-- ===========================================================================

-- 1. RLS on every table. No policies are created, so for any role that does
--    not bypass RLS the answer is always zero rows.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

-- 2. Take the privileges away entirely, and stop future tables inheriting
--    them. Guarded on role existence so this file also runs on a plain
--    Postgres that has never heard of Supabase.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;
