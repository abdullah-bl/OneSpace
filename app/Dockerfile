# OneSpace app: the OneBase server (functions in ./onebase) serving the built frontend (./dist).
# Data (SQLite, uploaded files, admin key) lives in /data: mount a volume there.

FROM oven/bun:1.4.4 AS build
# git: onebase and onebase-components are git dependencies pinned to commits (package.json).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bunx onebase codegen

FROM oven/bun:1.4.4-slim
# What the server runs (onebase/lib): unzip reads Word/Excel, poppler reads PDF, LibreOffice converts
# old formats and turns Word templates into PDF, fc-list reports a template's missing fonts.
# The fonts are the ones Arabic templates ask for, plus metric twins of Arial, Times and Calibri.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    unzip poppler-utils libreoffice-writer-nogui libreoffice-calc-nogui \
    fontconfig fonts-hosny-amiri fonts-noto-core fonts-dejavu-core fonts-liberation fonts-crosextra-carlito \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
RUN mkdir -p /data /shares && chown bun:bun /data
ENV ONEBASE_DATA=/data PORT=8090 ONEBASE_HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8090
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:8090/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Starts as root only to prepare the data volume (Fly and some hosts mount volumes owned by root;
# an optional /data/restore.tgz is unpacked first), then runs the server as "bun".
CMD ["sh", "scripts/docker-start.sh"]
