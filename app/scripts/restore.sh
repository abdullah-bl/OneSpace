#!/usr/bin/env bash
# Restores the newest snapshot (or AT=20261118T0300) into a data dir. Stop the server first.
#   ./scripts/restore.sh /path/to/clean-data-dir
# Uses ONESPACE_BACKUP and ONEBASE_SECRET_KEY like backup.sh. Refuses to overwrite an existing
# database unless FORCE=1.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ONESPACE_BACKUP:?set ONESPACE_BACKUP=s3://bucket/prefix}"
TARGET="${1:?usage: restore.sh <data-dir>}"
args=(restore --backup "$ONESPACE_BACKUP" --data "$TARGET")
[[ -n "${AT:-}" ]] && args+=(--at "$AT")
[[ "${FORCE:-}" == "1" ]] && args+=(--force)
exec ./node_modules/.bin/onebase "${args[@]}"
