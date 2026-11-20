// One container per run. This module is the only code that talks to the container engine
// (Docker, or any engine with Docker's API such as kiri: SANDBOX_DOCKER_HOST).
//
// Isolation (every run): --network none, read-only root filesystem, tmpfs /tmp and /output with
// size caps, non-root user 10001, --cap-drop ALL, no-new-privileges, default seccomp profile,
// memory (no swap) / CPU / pids / nofile limits, wall-clock limit enforced here by killing the
// container, no logs kept by Docker. Inputs are bind-mounted read-only at /input, the code at /code.
// gVisor (runsc) is used when configured or detected.
//
// Fail closed: an engine may accept a flag and not apply it. The runner tells the container what it
// asked for (SANDBOX_EXPECT); image/entry.py checks what the kernel actually applied before it runs
// any user code, and a result without `checks: "passed"` is a failed run.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { effectiveLimits, type Config, type Limits } from "./config";

export const MARKER = "@@ONESPACE_RESULT@@";
const CONTAINER_UID = "10001:10001";
const LABEL = "onespace.sandbox=1";
/** Time Docker needs to create/start/stop a container, on top of the code's own limit. */
const STARTUP_GRACE_MS = 8_000;

export type InputFile = { name: string; b64: string };
export type RunRequest = { code: string; files?: InputFile[]; limits?: Partial<Limits> };
export type OutputFile = { name: string; size: number; sha256: string; b64: string };
export type RunResult = {
  ok: boolean;
  /** Exit code of the user code (negative = killed by that signal), null if it never reported. */
  exitCode: number | null;
  timedOut: boolean;
  oomKilled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  files: OutputFile[];
  outputBytes: number;
  outputTruncated: boolean;
  /** Set when the run failed outside the user code (no result from the container). */
  error?: string;
  limits: Limits;
  runtime: string;
  image: string;
  inputs: { name: string; size: number; sha256: string }[];
};

export class BadRequest extends Error {}

export function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

let dockerHost: string | undefined;

/** Which engine the docker CLI talks to (a DOCKER_HOST URL); undefined = the CLI's own default. */
export function setDockerHost(host: string | undefined) {
  if (host !== dockerHost) runtimeCache = null;
  dockerHost = host;
}

/** Environment for every docker CLI call: the configured engine wins over an inherited DOCKER_HOST/DOCKER_CONTEXT. */
export function dockerEnv(): Record<string, string | undefined> {
  if (!dockerHost) return process.env;
  const { DOCKER_CONTEXT: _ignored, ...env } = process.env;
  return { ...env, DOCKER_HOST: dockerHost };
}

async function docker(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: dockerEnv() });
  const timer = setTimeout(() => p.kill(9), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

let runtimeCache: [Config["runtime"], string] | null = null;

export class RuntimeUnavailable extends Error {}

/**
 * The OCI runtime to use, always one the engine lists (engines may accept an unknown --runtime and
 * ignore it: kiri does). "auto": runsc (gVisor) when listed, else the engine's default runtime.
 * A named runtime the engine doesn't list throws: no silent fallback to weaker isolation.
 */
export async function resolveRuntime(cfg: Pick<Config, "runtime">): Promise<string> {
  if (runtimeCache?.[0] === cfg.runtime) return runtimeCache[1];
  const r = await docker(["info", "--format", "{{.DefaultRuntime}}\t{{json .Runtimes}}"]);
  if (r.code !== 0) throw new RuntimeUnavailable(`container engine unavailable: ${r.stderr.trim().slice(0, 200)}`);
  const [defaultRuntime, json] = r.stdout.trim().split("\t");
  let runtimes: Record<string, unknown> = {};
  try {
    runtimes = JSON.parse(json ?? "{}") ?? {};
  } catch {}
  const listed = (name: string | undefined): name is string => !!name && Object.hasOwn(runtimes, name);
  let runtime: string;
  if (cfg.runtime === "auto") {
    runtime = listed("runsc") ? "runsc" : defaultRuntime;
    if (!listed(runtime)) throw new RuntimeUnavailable(`the engine's default runtime "${defaultRuntime}" is not in its runtime list`);
  } else if (listed(cfg.runtime)) {
    runtime = cfg.runtime;
  } else {
    throw new RuntimeUnavailable(`runtime ${cfg.runtime} is not available on this engine (it lists: ${Object.keys(runtimes).join(", ") || "none"})`);
  }
  runtimeCache = [cfg.runtime, runtime];
  return runtime;
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    return (await docker(["version", "--format", "{{.Server.Version}}"], 10_000)).code === 0;
  } catch {
    return false;
  }
}

export async function imagePresent(image: string): Promise<boolean> {
  return (await docker(["image", "inspect", "--format", "{{.Id}}", image])).code === 0;
}

/** Removes containers left behind by a previous runner process (crash, kill -9). */
export async function removeStaleContainers() {
  const r = await docker(["ps", "-aq", "--filter", `label=${LABEL}`]);
  const ids = r.stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await docker(["rm", "-f", ...ids]);
}

/** File names under /input: basename only, safe characters, unique. */
export function safeInputName(name: string, taken: Set<string>): string {
  let n = basename(String(name)).replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").trim();
  if (!n || n === "." || n === "..") n = "input";
  n = n.slice(0, 200);
  let candidate = n;
  for (let i = 2; taken.has(candidate); i++) {
    const dot = n.lastIndexOf(".");
    candidate = dot > 0 ? `${n.slice(0, dot)}-${i}${n.slice(dot)}` : `${n}-${i}`;
  }
  taken.add(candidate);
  return candidate;
}

/** Reads a stream up to `max` bytes; returns what was read and whether more was discarded. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number, onOverflow: () => void) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of stream as any as AsyncIterable<Uint8Array>) {
    if (overflow) continue;
    if (size + chunk.length > max) {
      overflow = true;
      onOverflow();
      continue;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

/** What the container must find applied before it runs user code (checked by image/entry.py). */
export function expectations(limits: Limits, runtime: string) {
  return {
    uid: 10001,
    gid: 10001,
    memoryBytes: limits.memoryMb * 1024 * 1024,
    pids: limits.pids,
    cpus: limits.cpus,
    nofile: 256,
    // Mount size caps (bytes): /tmp, /output, /dev/shm.
    tmpBytes: 128 * 1024 * 1024,
    outputBytes: limits.outputMb * 1024 * 1024,
    shmBytes: 1024 * 1024,
    // gVisor is its own kernel: its seccomp/cgroup view differs and it enforces those from outside.
    kernelChecks: runtime !== "runsc",
  };
}

export async function runInContainer(cfg: Config, req: RunRequest): Promise<RunResult> {
  if (typeof req?.code !== "string" || !req.code.trim()) throw new BadRequest("code is required");
  if (req.code.length > 512 * 1024) throw new BadRequest("code is too long");
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length > 100) throw new BadRequest("too many input files");
  const limits = effectiveLimits(req.limits, cfg);
  const runtime = await resolveRuntime(cfg);

  mkdirSync(cfg.workdir, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(cfg.workdir, "run-"));
  const name = `onespace-sbx-${crypto.randomUUID()}`;
  const started = Date.now();
  const base = { limits, runtime, image: cfg.image };
  try {
    // Inputs and code: owned by the runner, world-readable (the container user only reads them).
    chmodSync(dir, 0o755);
    const inputDir = join(dir, "input");
    const codeDir = join(dir, "code");
    mkdirSync(inputDir, { mode: 0o755 });
    mkdirSync(codeDir, { mode: 0o755 });
    const taken = new Set<string>();
    const inputs: RunResult["inputs"] = [];
    let total = 0;
    for (const f of files) {
      if (typeof f?.b64 !== "string") throw new BadRequest("input file without data");
      const bytes = Buffer.from(f.b64, "base64");
      total += bytes.length;
      if (total > cfg.maxInputMb * 1024 * 1024) throw new BadRequest("inputs are too large");
      const safe = safeInputName(f.name, taken);
      writeFileSync(join(inputDir, safe), bytes, { mode: 0o444 });
      inputs.push({ name: safe, size: bytes.length, sha256: sha256(bytes) });
    }
    writeFileSync(join(codeDir, "main.py"), req.code, { mode: 0o444 });
    chmodSync(inputDir, 0o555);
    chmodSync(codeDir, 0o555);

    const outputBytes = limits.outputMb * 1024 * 1024;
    const args = [
      "run",
      "--name", name,
      "--label", LABEL,
      "--runtime", runtime,
      "--init",
      "--network", "none",
      "--read-only",
      "--user", CONTAINER_UID,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", `${limits.memoryMb}m`,
      "--memory-swap", `${limits.memoryMb}m`,
      "--cpus", String(limits.cpus),
      "--pids-limit", String(limits.pids),
      "--ulimit", "nofile=256:256",
      "--ulimit", "core=0:0",
      "--ipc", "none",
      "--log-driver", "none",
      "--hostname", "sandbox",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
      "--tmpfs", `/output:rw,nosuid,nodev,noexec,size=${limits.outputMb}m,mode=1777`,
      // Some engines (kiri) still give a 64 MB /dev/shm with --ipc none: replace it with a 1 MB one.
      "--tmpfs", "/dev/shm:rw,nosuid,nodev,noexec,size=1m,mode=1777",
      "--mount", `type=bind,source=${inputDir},target=/input,readonly`,
      "--mount", `type=bind,source=${codeDir},target=/code,readonly`,
      "--env", `SANDBOX_TIMEOUT_MS=${limits.timeoutMs}`,
      "--env", `SANDBOX_OUTPUT_MAX=${outputBytes}`,
      "--env", `SANDBOX_EXPECT=${JSON.stringify(expectations(limits, runtime))}`,
      cfg.image,
    ];
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: dockerEnv() });
    let killedByRunner = false;
    const kill = () => {
      if (killedByRunner) return;
      killedByRunner = true;
      void docker(["kill", name]).catch(() => {});
    };
    const wallTimer = setTimeout(kill, limits.timeoutMs + STARTUP_GRACE_MS);
    // Base64 output + stdout/stderr caps + JSON overhead.
    const stdoutCap = Math.ceil(outputBytes * 1.4) + 1024 * 1024;
    const [out, err, exit] = await Promise.all([readCapped(proc.stdout, stdoutCap, kill), readCapped(proc.stderr, 256 * 1024, () => {}), proc.exited]);
    clearTimeout(wallTimer);

    const state = await docker(["inspect", "--format", "{{.State.OOMKilled}} {{.State.ExitCode}}", name]);
    const containerOom = state.stdout.trim().startsWith("true");
    const at = out.text.lastIndexOf(MARKER);
    if (at < 0 || out.overflow) {
      return {
        ok: false,
        exitCode: null,
        timedOut: killedByRunner && !out.overflow,
        oomKilled: containerOom,
        durationMs: Date.now() - started,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        files: [],
        outputBytes: 0,
        outputTruncated: out.overflow,
        error: out.overflow ? "output exceeded the limit" : killedByRunner ? "killed: wall-clock limit" : containerOom ? "killed: out of memory" : `container exited (${exit}) without a result: ${err.text.slice(0, 500)}`,
        inputs,
        ...base,
      };
    }
    const r = JSON.parse(out.text.slice(at + MARKER.length));
    if (r.checks !== "passed") {
      // The container is not isolated the way we asked (or the image predates the check): the user code did not run.
      const failed = Array.isArray(r.checkFailures) ? r.checkFailures.map(String).join("; ") : "the image did not run the isolation check (rebuild it)";
      console.error("sandbox isolation check failed:", failed);
      return {
        ok: false,
        exitCode: null,
        timedOut: false,
        oomKilled: false,
        durationMs: Date.now() - started,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        files: [],
        outputBytes: 0,
        outputTruncated: false,
        error: `sandbox isolation check failed: ${failed}`,
        inputs,
        ...base,
      };
    }
    const outFiles: OutputFile[] = (r.files ?? []).map((f: any) => {
      const bytes = Buffer.from(String(f.b64), "base64");
      return { name: String(f.name), size: bytes.length, sha256: sha256(bytes), b64: String(f.b64) };
    });
    return {
      ok: r.exitCode === 0 && !r.timedOut,
      exitCode: typeof r.exitCode === "number" ? r.exitCode : null,
      timedOut: !!r.timedOut || killedByRunner,
      oomKilled: !!r.oomKilled || containerOom,
      durationMs: typeof r.durationMs === "number" ? r.durationMs : Date.now() - started,
      stdout: String(r.stdout ?? ""),
      stderr: String(r.stderr ?? ""),
      stdoutTruncated: !!r.stdoutTruncated,
      stderrTruncated: !!r.stderrTruncated,
      files: outFiles,
      outputBytes: outFiles.reduce((a, f) => a + f.size, 0),
      outputTruncated: !!r.outputTruncated,
      inputs,
      ...base,
    };
  } finally {
    await docker(["rm", "-f", name]).catch(() => {});
    try {
      chmodSync(dir, 0o755);
      for (const sub of ["input", "code"]) {
        try {
          chmodSync(join(dir, sub), 0o755);
        } catch {}
      }
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
