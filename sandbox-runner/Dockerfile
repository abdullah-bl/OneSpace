# sandbox-runner: starts one throwaway container per analysis run (image onespace-sandbox:3).
# It talks to the host's Docker through the mounted socket, so it is effectively root on the host:
# keep it on the internal network only (never publish its port) and protect SANDBOX_SECRET.

FROM docker:29-cli AS dockercli

FROM oven/bun:1.4.4-slim
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /runner
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
ENV SANDBOX_HOST=0.0.0.0 SANDBOX_PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD bun -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server.ts"]
