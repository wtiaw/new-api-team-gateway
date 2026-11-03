#!/bin/sh
set -eu
umask 077
deployment_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$deployment_dir"
test -f compose.server.yaml
test -f .env
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="backups/database-$stamp.dump"
docker compose --env-file .env -f compose.server.yaml exec -T postgres \
  pg_dump -U gateway -d new_api_team_gateway -Fc < /dev/null > "$backup.tmp"
test -s "$backup.tmp"
mv "$backup.tmp" "$backup"
docker compose --env-file .env -f compose.server.yaml exec -T postgres \
  pg_restore --list < "$backup" >/dev/null
echo "Verified database backup: $deployment_dir/$backup"
