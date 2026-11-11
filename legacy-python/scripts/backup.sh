#!/bin/sh
# Daily database backup. Add to crontab (crontab -e):
#   15 2 * * * /opt/car-gateway/scripts/backup.sh
# Keeps 14 days. Copy the backups folder off the server too (for example to S3).
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose exec -T db pg_dump -U car -d car --format=custom > "backups/car-$(date +%F).dump"
find backups -name 'car-*.dump' -mtime +14 -delete
