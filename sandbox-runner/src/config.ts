// Runner configuration from the environment, and the hard ceilings every request is clamped to.

import { tmpdir } from "node:os";
import { join } from "node:path";

export type Limits = {
  /** Wall-clock limit for the user code, in ms. */
  timeoutMs: number;
  /** Memory (RAM, no swap) for the whole container, in MB. */
  memoryMb: number;
  /** CPU cores (fractional allowed). */
  cpus: number;
  /** Max processes/threads in the container. */
  pids: number;
  /** Max total size of /output (and of any single file the code writes), in MB. */
  outputMb: number;
};

export type Config = {
  secret: string;
  host: string;
  port: number;
  image: string;
  /** Container engine's API socket (DOCKER_HOST for the docker CLI), e.g. unix:///run/kiri/docker.sock. Unset: the CLI's default. */
  dockerHost?: string;
  /** "auto" picks gVisor (runsc) when the engine has it registered, else the engine's default runtime.
   *  A runtime named here that the engine doesn't list is refused (no silent fallback). */
  runtime: "auto" | "runc" | "runsc";
  workdir: string;
  maxConcurrency: number;
  maxInputMb: number;
  defaults: Limits;
  ceilings: Limits;
};

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const secret = env.SANDBOX_SECRET ?? "";
  if (secret.length < 16) throw new Error("SANDBOX_SECRET must be set (at least 16 characters)");
  const dockerHost = env.SANDBOX_DOCKER_HOST;
  if (dockerHost && !/^(unix|tcp|ssh|npipe):\/\//.test(dockerHost)) throw new Error("SANDBOX_DOCKER_HOST must be a URL like unix:///run/kiri/docker.sock");
  const runtime = (env.SANDBOX_RUNTIME ?? "auto") as Config["runtime"];
  if (!["auto", "runc", "runsc"].includes(runtime)) throw new Error("SANDBOX_RUNTIME must be auto, runc or runsc");
  const ceilings: Limits = {
    timeoutMs: num(env.SANDBOX_MAX_TIMEOUT_MS, 120_000),
    memoryMb: num(env.SANDBOX_MAX_MEMORY_MB, 2048),
    cpus: num(env.SANDBOX_MAX_CPUS, 2),
    pids: num(env.SANDBOX_MAX_PIDS, 256),
    outputMb: num(env.SANDBOX_MAX_OUTPUT_MB, 50),
  };
  return {
    secret,
    host: env.SANDBOX_HOST ?? "127.0.0.1",
    port: num(env.SANDBOX_PORT, 8787),
    image: env.SANDBOX_IMAGE ?? "onespace-sandbox:4",
    dockerHost: env.SANDBOX_DOCKER_HOST || undefined,
    runtime,
    workdir: env.SANDBOX_WORKDIR ?? join(tmpdir(), "onespace-sandbox"),
    maxConcurrency: Math.floor(num(env.SANDBOX_MAX_CONCURRENCY, 2)),
    maxInputMb: num(env.SANDBOX_MAX_INPUT_MB, 100),
    defaults: clamp({ timeoutMs: 30_000, memoryMb: 512, cpus: 1, pids: 64, outputMb: 20 }, ceilings),
    ceilings,
  };
}

/** Request limits → effective limits: missing values take the default, everything is capped by the ceiling. */
export function effectiveLimits(req: Partial<Limits> | undefined, cfg: Pick<Config, "defaults" | "ceilings">): Limits {
  const merged = { ...cfg.defaults };
  for (const k of Object.keys(merged) as (keyof Limits)[]) {
    const v = req?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) merged[k] = v;
  }
  return clamp(merged, cfg.ceilings);
}

function clamp(l: Limits, c: Limits): Limits {
  return {
    timeoutMs: Math.max(100, Math.min(Math.floor(l.timeoutMs), c.timeoutMs)),
    memoryMb: Math.max(64, Math.min(Math.floor(l.memoryMb), c.memoryMb)),
    cpus: Math.max(0.1, Math.min(l.cpus, c.cpus)),
    pids: Math.max(16, Math.min(Math.floor(l.pids), c.pids)),
    outputMb: Math.max(1, Math.min(Math.floor(l.outputMb), c.outputMb)),
  };
}
