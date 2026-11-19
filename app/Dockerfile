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
WORKDIR /app
COPY --from=build --chown=bun:bun /app /app
RUN mkdir -p /data /shares && chown bun:bun /data
ENV ONEBASE_DATA=/data PORT=8090 ONEBASE_HOST=0.0.0.0 NODE_ENV=production
USER bun
EXPOSE 8090
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD bun -e "fetch('http://127.0.0.1:8090/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bunx", "onebase", "serve", "--public", "dist"]
