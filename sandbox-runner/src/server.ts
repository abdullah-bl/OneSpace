// sandbox-runner: a small local HTTP service and the only process with Docker access.
// OneBase calls it with a shared secret; it never sees the database, only the files sent per run.
//
//   GET  /health  → { ok, docker, image, runtime }            (no secret needed, no details leaked)
//   POST /run     → RunResult                                 (Authorization: Bearer $SANDBOX_SECRET)
//        body: { code, files: [{ name, b64 }], limits?: { timeoutMs, memoryMb, cpus, pids, outputMb } }

import { timingSafeEqual } from "node:crypto";
import { loadConfig, type Config } from "./config";
import { BadRequest, dockerAvailable, imagePresent, removeStaleContainers, resolveRuntime, runInContainer } from "./docker";

function authorized(req: Request, secret: string): boolean {
  const header = req.headers.get("authorization") ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(secret);
  return given.length === want.length && timingSafeEqual(given, want);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** A counting semaphore: at most `n` containers at once; the rest wait in order. */
function semaphore(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export async function startServer(cfg: Config = loadConfig()) {
  await removeStaleContainers().catch(() => {});
  const limit = semaphore(Math.max(1, cfg.maxConcurrency));
  const maxBody = Math.ceil(cfg.maxInputMb * 1024 * 1024 * 1.4) + 2 * 1024 * 1024;
  return Bun.serve({
    hostname: cfg.host,
    port: cfg.port,
    maxRequestBodySize: maxBody,
    idleTimeout: 0, // runs can take up to the timeout ceiling
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health" && req.method === "GET") {
        const docker = await dockerAvailable();
        const image = docker && (await imagePresent(cfg.image));
        return json({ ok: docker && image, docker, image, runtime: docker ? await resolveRuntime(cfg) : null });
      }
      if (url.pathname === "/run" && req.method === "POST") {
        if (!authorized(req, cfg.secret)) return json({ error: "unauthorized" }, 401);
        let body: any;
        try {
          body = await req.json();
        } catch {
          return json({ error: "invalid JSON" }, 400);
        }
        try {
          return json(await limit(() => runInContainer(cfg, body)));
        } catch (e) {
          if (e instanceof BadRequest) return json({ error: e.message }, 400);
          console.error("run failed:", e);
          return json({ error: "run failed" }, 500);
        }
      }
      return json({ error: "not found" }, 404);
    },
  });
}

if (import.meta.main) {
  const cfg = loadConfig();
  const server = await startServer(cfg);
  console.log(`sandbox-runner on http://${server.hostname}:${server.port} image=${cfg.image} runtime=${await resolveRuntime(cfg).catch(() => "?")}`);
}
