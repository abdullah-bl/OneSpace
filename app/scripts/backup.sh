#!/usr/bin/env bash
# One-off backup of OneSpace (SQLite snapshot + uploaded files) to S3-compatible storage.
# Scheduled backups: run the server with --backup "$ONESPACE_BACKUP" --backup-every 1h instead.
#   ONESPACE_BACKUP     s3://bucket/prefix[?endpoint=http://host:port&region=...]   (required)
#   ONESPACE_DATA       data dir (default: ./onebase_data)
#   ONEBASE_SECRET_KEY  >= 32 chars: encrypts snapshots and files (keep it OUTSIDE the bucket)
#   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY / S3_ENDPOINT / S3_REGION as needed
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ONESPACE_BACKUP:?set ONESPACE_BACKUP=s3://bucket/prefix}"
exec ./node_modules/.bin/onebase backup --data "${ONESPACE_DATA:-./onebase_data}" --backup "$ONESPACE_BACKUP"
