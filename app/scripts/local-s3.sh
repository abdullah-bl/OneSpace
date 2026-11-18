#!/usr/bin/env bash
# Starts a local S3-compatible store (SeaweedFS, from the local Docker image) for backups, and
# creates the bucket. For production use a second disk/machine (MinIO, SeaweedFS, ...).
#   ./scripts/local-s3.sh            -> s3 on http://127.0.0.1:18333, bucket onespace-backups
set -euo pipefail
NAME="${S3_CONTAINER:-onespace-s3}"
PORT="${S3_PORT:-18333}"
DATA="${S3_DATA_DIR:-$HOME/onespace-s3-data}"
mkdir -p "$DATA"
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8333" -v "$DATA:/data" chrislusf/seaweedfs:latest server -s3 -dir=/data >/dev/null
fi
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 1; done
curl -sf -X PUT "http://127.0.0.1:$PORT/onespace-backups" >/dev/null || true
echo "s3://onespace-backups/onespace?endpoint=http://127.0.0.1:$PORT&region=us-east-1&accessKeyId=local&secretAccessKey=local"
