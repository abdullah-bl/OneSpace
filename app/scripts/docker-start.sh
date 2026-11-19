#!/bin/sh
# Container start (app/Dockerfile). Runs as root only to prepare /data, then serves as "bun".
#
# Restore: an operator who puts a tar.gz of a data directory at /data/restore.tgz (for example
# with `fly ssh sftp`) and restarts gets it unpacked over /data before the server opens the
# database; the archive is then removed. The previous data is kept in /data/.before-restore-<time>.
set -e
if [ -f /data/restore.tgz ]; then
  keep="/data/.before-restore-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$keep"
  find /data -mindepth 1 -maxdepth 1 ! -name restore.tgz ! -name '.before-restore-*' -exec mv {} "$keep"/ \;
  tar xzf /data/restore.tgz -C /data
  rm -f /data/restore.tgz
  echo "restored /data from restore.tgz (previous data in $keep)"
fi
chown -R bun:bun /data
exec setpriv --reuid=bun --regid=bun --init-groups bunx onebase serve --public dist
