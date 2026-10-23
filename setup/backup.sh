#!/usr/bin/env bash
# Nightly backup (cron, 2:30am): the whole database, and on Sundays the stored files (photos, plans, documents).
# Keeps BACKUP_DAYS days (pestis.env). Copy the folder off the server now and then - see SETUP.md "Backups".
set -euo pipefail
# shellcheck disable=SC1091
source /opt/pestis/pestis.env
# shellcheck disable=SC1091
source /opt/pestis/secrets.env
OUT=/opt/pestis/backups
mkdir -p "$OUT"
stamp=$(date +%Y-%m-%d)
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" supabase-db pg_dump -h 127.0.0.1 -U postgres -d postgres -Fc > "$OUT/db-$stamp.dump"
echo "$(date -Is) database backed up: $OUT/db-$stamp.dump ($(du -h "$OUT/db-$stamp.dump" | cut -f1))"
if [ "$(date +%u)" = 7 ] && [ -d /opt/supabase/volumes/storage ]; then
    tar -czf "$OUT/files-$stamp.tar.gz" -C /opt/supabase/volumes storage
    echo "$(date -Is) files backed up: $OUT/files-$stamp.tar.gz"
fi
find "$OUT" -type f -mtime +"${BACKUP_DAYS:-14}" -delete
# the ubuntu user can copy them off the server (scp)
if id ubuntu >/dev/null 2>&1; then chown -R ubuntu:ubuntu "$OUT"; chmod 700 "$OUT"; fi
