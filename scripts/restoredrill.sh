#!/usr/bin/env bash
# The restore drill.
#
# A backup you have never restored is not a backup. It is a file you hope
# about. This dumps a database, destroys a copy, restores into it, and then
# asks whether what came back is *sound* — not merely present.
#
# Run it against local Postgres before every release, and against a real
# Supabase point-in-time restore before launch and after any change to the
# schema that moves data around (a migration with an UPDATE in it, like 046).
#
#   scripts/restoredrill.sh                 # drill against propops_test
#   scripts/restoredrill.sh propops         # drill against a named database
#   SOURCE_URL=postgres://... scripts/restoredrill.sh   # drill against a remote
#
# It never writes to the source. Everything destructive happens to
# <source>_restoredrill, which it creates and drops itself.
set -euo pipefail

SOURCE_DB="${1:-propops_test}"
DRILL_DB="${SOURCE_DB}_restoredrill"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR="${OUT_DIR:-/tmp/propops-drill}"
DUMP="$OUT_DIR/${SOURCE_DB}-${STAMP}.dump"
mkdir -p "$OUT_DIR"

if [ -n "${SOURCE_URL:-}" ]; then
  SRC=("--dbname=$SOURCE_URL")
  PSQL_SRC=("$SOURCE_URL")
else
  SRC=("--dbname=$SOURCE_DB")
  PSQL_SRC=("$SOURCE_DB")
fi

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mDRILL FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  dropdb --if-exists "$DRILL_DB" 2>/dev/null || true
}
trap cleanup EXIT

# --- 1. the manifest, taken from the source before anything is touched -------
# Row counts per table. The restore has to reproduce these exactly; a restore
# that silently drops rows is the failure this catches.
say "1/5  Manifest from $SOURCE_DB"
MANIFEST="$OUT_DIR/${SOURCE_DB}-${STAMP}.manifest"
psql "${PSQL_SRC[@]}" -At -F'|' -q <<'SQL' > "$MANIFEST"
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;
SQL
# n_live_tup is an estimate. For the tables where being wrong matters, count.
psql "${PSQL_SRC[@]}" -At -F'|' -q <<'SQL' >> "$MANIFEST"
SELECT 'EXACT:journal', COUNT(*) FROM journal
UNION ALL SELECT 'EXACT:journal_split', COUNT(*) FROM journal_split
UNION ALL SELECT 'EXACT:ledger_entry', COUNT(*) FROM ledger_entry
UNION ALL SELECT 'EXACT:lease', COUNT(*) FROM lease
UNION ALL SELECT 'EXACT:tenant', COUNT(*) FROM tenant
UNION ALL SELECT 'EXACT:company', COUNT(*) FROM company
ORDER BY 1;
SQL
wc -l < "$MANIFEST" | xargs printf '     %s lines\n'

# And a soundness baseline. A backup's job is to bring back what was there,
# problems included; without this the drill would fail on whatever the source
# was already carrying and teach everyone to ignore it.
BASELINE="$OUT_DIR/${SOURCE_DB}-${STAMP}.verify.json"
if [ -n "${SOURCE_URL:-}" ]; then
  DATABASE_URL="$SOURCE_URL" node server/lib/verify.js --json > "$BASELINE" || true
else
  DATABASE_URL="postgres://${PGUSER:-$(whoami)}@${PGHOST:-localhost}:${PGPORT:-5432}/$SOURCE_DB" \
    node server/lib/verify.js --json > "$BASELINE" || true
fi
node -e 'const r=require("fs").readFileSync(process.argv[1],"utf8");const j=JSON.parse(r);
  console.log(`     baseline: ${j.errors} error(s), ${j.warnings} warning(s) in the source`)' "$BASELINE"

# --- 2. the dump -------------------------------------------------------------
say "2/5  Dump"
pg_dump "${SRC[@]}" --format=custom --no-owner --no-privileges --file="$DUMP" \
  || fail "pg_dump failed"
ls -lh "$DUMP" | awk '{printf "     %s\n", $5}'

# --- 3. destroy and recreate -------------------------------------------------
# Into a separate database, so a drill can never be the thing that loses the
# data it is meant to prove is safe.
say "3/5  Restore into $DRILL_DB (fresh)"
dropdb --if-exists "$DRILL_DB"
createdb "$DRILL_DB"
pg_restore --dbname="$DRILL_DB" --no-owner --no-privileges --exit-on-error "$DUMP" \
  || fail "pg_restore reported an error"

# --- 4. the manifest again, from the restored copy ---------------------------
say "4/5  Compare row counts"
RESTORED="$OUT_DIR/${DRILL_DB}-${STAMP}.manifest"
psql "$DRILL_DB" -At -F'|' -q <<'SQL' > "$RESTORED"
SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;
SQL
psql "$DRILL_DB" -At -F'|' -q <<'SQL' >> "$RESTORED"
SELECT 'EXACT:journal', COUNT(*) FROM journal
UNION ALL SELECT 'EXACT:journal_split', COUNT(*) FROM journal_split
UNION ALL SELECT 'EXACT:ledger_entry', COUNT(*) FROM ledger_entry
UNION ALL SELECT 'EXACT:lease', COUNT(*) FROM lease
UNION ALL SELECT 'EXACT:tenant', COUNT(*) FROM tenant
UNION ALL SELECT 'EXACT:company', COUNT(*) FROM company
ORDER BY 1;
SQL

# Only the EXACT: lines are compared. n_live_tup is a statistics estimate that
# a freshly restored database has not gathered yet, so comparing it would fail
# every drill for a reason that is not about the data.
if ! diff <(grep '^EXACT:' "$MANIFEST") <(grep '^EXACT:' "$RESTORED"); then
  fail "row counts differ between source and restore (see diff above)"
fi
grep -c '^EXACT:' "$MANIFEST" | xargs printf '     %s counted tables match\n'

# --- 5. is it sound? ---------------------------------------------------------
# The part that distinguishes a restore from a working restore.
say "5/5  Soundness"
DATABASE_URL="postgres://${PGUSER:-$(whoami)}@${PGHOST:-localhost}:${PGPORT:-5432}/$DRILL_DB" \
  node server/lib/verify.js --baseline "$BASELINE" ${DRILL_FILES:+--files} \
  || fail "the restore introduced problems the source did not have"

say "Drill passed."
echo "     source:   $SOURCE_DB"
echo "     dump:     $DUMP"
echo "     restored: $DRILL_DB (dropped on exit)"
echo
echo "What this did NOT prove:"
echo "  - that uploaded files survive. Blob storage is a separate system;"
echo "    run with DRILL_FILES=1 to read every file the database names."
echo "  - that a real Supabase point-in-time restore works. That has to be"
echo "    drilled against Supabase itself; see docs/BACKUPS.md."
