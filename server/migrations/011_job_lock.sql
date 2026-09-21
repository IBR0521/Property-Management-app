/* One live run per job.

   The sweep needs a lock that survives across statements. Postgres advisory
   locks cannot provide one here: Supabase's pooler on 6543 is pgbouncer in
   transaction mode, so a session-scoped lock is taken on a backend connection
   the next statement may not get, and a transaction-scoped one dies at the end
   of the statement that took it. Either way the lock is a no-op that reads
   like a guarantee, which is worse than no lock.

   A partial unique index is the version that actually works: at most one
   unfinished row per job name, enforced by the database, visible to every
   connection, and released by the UPDATE that finishes the run. */
CREATE UNIQUE INDEX job_run_one_active_idx ON job_run (name) WHERE finished_at IS NULL;
