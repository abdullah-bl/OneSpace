// sandbox-runner tests. Unit tests always run; container tests need Docker and the image
// (`bun run build-image`) and are skipped automatically when either is missing.
// Another engine with Docker's API: SANDBOX_DOCKER_HOST=unix:///run/kiri/docker.sock bun test tests

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { effectiveLimits, loadConfig } from "../src/config";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER, RuntimeUnavailable, dockerAvailable, dockerEnv, expectations, imagePresent, resolveRuntime, safeInputName, setDockerHost } from "../src/docker";
import { startServer } from "../src/server";

const SECRET = "test-secret-" + crypto.randomUUID();
const IMAGE = process.env.SANDBOX_IMAGE ?? "onespace-sandbox:4";
const ENGINE = process.env.SANDBOX_DOCKER_HOST || undefined;
setDockerHost(ENGINE);
const canRun = (await dockerAvailable()) && (await imagePresent(IMAGE));
if (!canRun) console.warn(`[sandbox-runner tests] Docker or image ${IMAGE} missing: container tests skipped`);

describe("config and input names", () => {
  test("a secret is required", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ SANDBOX_SECRET: "short" })).toThrow();
  });
  test("request limits are clamped to the ceilings", () => {
    const cfg = loadConfig({ SANDBOX_SECRET: SECRET });
    const l = effectiveLimits({ timeoutMs: 10 ** 9, memoryMb: 10 ** 9, cpus: 64, pids: 10 ** 6, outputMb: 10 ** 6 }, cfg);
    expect(l).toEqual(cfg.ceilings);
    expect(effectiveLimits({ timeoutMs: -5, memoryMb: Number.NaN } as any, cfg)).toEqual(cfg.defaults);
  });
  test("the engine socket must be a URL", () => {
    expect(() => loadConfig({ SANDBOX_SECRET: SECRET, SANDBOX_DOCKER_HOST: "/run/kiri/docker.sock" })).toThrow();
    expect(loadConfig({ SANDBOX_SECRET: SECRET, SANDBOX_DOCKER_HOST: "unix:///run/kiri/docker.sock" }).dockerHost).toBe("unix:///run/kiri/docker.sock");
    expect(loadConfig({ SANDBOX_SECRET: SECRET }).dockerHost).toBeUndefined();
  });
  test("input names can't escape /input", () => {
    const taken = new Set<string>();
    expect(safeInputName("../../etc/passwd", taken)).toBe("passwd");
    expect(safeInputName("..", taken)).toBe("input");
    expect(safeInputName("passwd", taken)).toBe("passwd-2");
    expect(safeInputName("a\u0000b.csv", taken)).toBe("a_b.csv");
  });
});

let server: Awaited<ReturnType<typeof startServer>> | undefined;
let base = "";

beforeAll(async () => {
  if (!canRun) return;
  const port = 30000 + Math.floor(Math.random() * 20000);
  server = await startServer(loadConfig({ SANDBOX_SECRET: SECRET, SANDBOX_PORT: String(port), SANDBOX_IMAGE: IMAGE, ...(ENGINE ? { SANDBOX_DOCKER_HOST: ENGINE } : {}) }));
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => server?.stop(true));

async function run(code: string, opts: { files?: { name: string; content: string }[]; limits?: any; secret?: string } = {}) {
  const res = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.secret ?? SECRET}` },
    body: JSON.stringify({
      code,
      files: (opts.files ?? []).map((f) => ({ name: f.name, b64: Buffer.from(f.content).toString("base64") })),
      limits: opts.limits,
    }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Runs Python that prints one JSON line of probe results. */
async function probe(code: string, opts: Parameters<typeof run>[1] = {}) {
  const r = await run(`import json\nres = {}\n${code}\nprint(json.dumps(res))`, opts);
  expect(r.status).toBe(200);
  if (r.body.exitCode !== 0) throw new Error(r.body.stderr || r.body.error);
  return JSON.parse(r.body.stdout.trim().split("\n").pop()!);
}

async function leftoverContainers() {
  const p = Bun.spawn(["docker", "ps", "-aq", "--filter", "label=onespace.sandbox=1"], { stdout: "pipe", env: dockerEnv() });
  return (await new Response(p.stdout).text()).trim();
}

const T = 60_000;

describe.skipIf(!canRun)("HTTP service", () => {
  test("health is public, /run needs the shared secret", async () => {
    const h: any = await (await fetch(`${base}/health`)).json();
    expect(h).toMatchObject({ ok: true, docker: true, image: true });
    expect((await run("print(1)", { secret: "wrong" })).status).toBe(401);
    const none = await fetch(`${base}/run`, { method: "POST", body: "{}" });
    expect(none.status).toBe(401);
    expect((await run("")).status).toBe(400);
  });
});

describe.skipIf(!canRun)("isolation", () => {
  test(
    "no network at all: only loopback, no DNS, no internet, no host or Docker bridge",
    async () => {
      const port = new URL(base).port;
      const res = await probe(
        `
import os, socket
res["ifaces"] = sorted(os.listdir("/sys/class/net"))
def tcp(host, port):
    try:
        s = socket.create_connection((host, port), timeout=3); s.close(); return "connected"
    except Exception as e:
        return type(e).__name__
try:
    socket.gethostbyname("example.com"); res["dns"] = "resolved"
except Exception as e:
    res["dns"] = type(e).__name__
res["internet"] = tcp("1.1.1.1", 443)
res["bridge"] = tcp("172.17.0.1", ${port})
res["host_runner"] = tcp("127.0.0.1", ${port})
res["onebase"] = tcp("172.17.0.1", 8090)
`,
      );
      expect(res.ifaces).toEqual(["lo"]);
      expect(res.dns).not.toBe("resolved");
      for (const k of ["internet", "bridge", "host_runner", "onebase"]) expect(res[k]).not.toBe("connected");
    },
    T,
  );

  test(
    "no database or host files: only /input, /code and tmpfs are mounted; no Docker socket; read-only everywhere else",
    async () => {
      const res = await probe(
        `
import os
res["uid"] = os.getuid(); res["gid"] = os.getgid()
st = open("/proc/self/status").read()
res["capeff"] = [l.split()[1] for l in st.splitlines() if l.startswith("CapEff")][0]
res["nonewprivs"] = [l.split()[1] for l in st.splitlines() if l.startswith("NoNewPrivs")][0]
res["input"] = sorted(os.listdir("/input"))
res["mounts"] = sorted({l.split()[1] for l in open("/proc/mounts") if l.split()[1].startswith(("/input", "/code", "/output", "/tmp", "/home", "/var", "/srv", "/data"))})
res["docker_sock"] = os.path.exists("/var/run/docker.sock") or os.path.exists("/run/docker.sock")
res["home"] = os.path.exists("/home/abdullah") or any(os.scandir("/home")) if os.path.exists("/home") else False
res["onebase_data"] = any("onebase" in n for n in os.listdir("/"))
def writable(p):
    try:
        with open(p, "w") as f: f.write("x")
        return True
    except OSError:
        return False
res["w_input"] = writable("/input/new.txt")
res["w_input_existing"] = writable("/input/data.csv")
res["w_code"] = writable("/code/main.py")
res["w_root"] = writable("/evil")
res["w_etc"] = writable("/etc/passwd")
res["w_usr"] = writable("/usr/local/lib/x.py")
res["w_tmp"] = writable("/tmp/ok")
res["w_output"] = writable("/output/ok.txt")
res["read_input"] = open("/input/data.csv").read()
`,
        { files: [{ name: "data.csv", content: "a,b\n1,2\n" }] },
      );
      expect(res.uid).toBe(10001);
      expect(res.gid).toBe(10001);
      expect(res.capeff).toBe("0000000000000000");
      expect(res.nonewprivs).toBe("1");
      expect(res.input).toEqual(["data.csv"]);
      expect(res.mounts).toEqual(["/code", "/input", "/output", "/tmp"]);
      expect(res.docker_sock).toBe(false);
      expect(res.home).toBe(false);
      expect(res.onebase_data).toBe(false);
      for (const k of ["w_input", "w_input_existing", "w_code", "w_root", "w_etc", "w_usr"]) expect([k, res[k]]).toEqual([k, false]);
      expect(res.w_tmp).toBe(true);
      expect(res.w_output).toBe(true);
      expect(res.read_input).toBe("a,b\n1,2\n");
    },
    T,
  );
});

describe.skipIf(!canRun)("limits", () => {
  test(
    "an infinite loop is killed at the time limit and the host is unaffected",
    async () => {
      const t0 = Date.now();
      const r = await run("while True:\n    pass", { limits: { timeoutMs: 2000 } });
      const elapsed = Date.now() - t0;
      expect(r.status).toBe(200);
      expect(r.body.timedOut).toBe(true);
      expect(r.body.ok).toBe(false);
      expect(elapsed).toBeLessThan(2000 + 8000);
      expect(((await (await fetch(`${base}/health`)).json()) as any).ok).toBe(true);
      expect(await leftoverContainers()).toBe("");
    },
    T,
  );

  test(
    "Arabic in charts just works: shaped, in visual order, with a font fallback for Latin and symbols",
    async () => {
      const res = await probe(
        [
          "import matplotlib.pyplot as plt, onespace",
          "fig, ax = plt.subplots()",
          "t = ax.set_title('تطور الراتب (ريال) 7%')",
          "res['shaped'] = any(0xFE70 <= ord(c) <= 0xFEFF for c in t.get_text())",
          "res['base_left'] = any(0x0600 <= ord(c) <= 0x06FF for c in t.get_text())",
          "pre = onespace.ar('الراتب')",
          "res['twice'] = ax.set_xlabel(pre).get_text() == pre",
          "res['latin'] = ax.set_ylabel('Salary').get_text()",
          "import matplotlib",
          "res['family'] = list(matplotlib.rcParams['font.family'])",
          "fig.savefig('/output/a.png')",
        ].join("\n"),
      );
      expect(res.shaped).toBe(true);
      expect(res.base_left).toBe(false);
      expect(res.twice).toBe(true);
      expect(res.latin).toBe("Salary");
      expect(res.family).toEqual(["Noto Sans Arabic", "DejaVu Sans"]);
    },
    T,
  );

  test(
    "a loop that ignores signals in a forked child is still killed",
    async () => {
      const t0 = Date.now();
      const r = await run("import os, signal\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nif os.fork() == 0:\n    os.setsid()\n    while True: pass\nwhile True: pass", { limits: { timeoutMs: 1500 } });
      expect(r.body.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(1500 + 8000);
      expect(await leftoverContainers()).toBe("");
    },
    T,
  );

  test(
    "a memory bomb is killed at the memory limit and the host is unaffected",
    async () => {
      const t0 = Date.now();
      const r = await run("chunks = []\nwhile True:\n    chunks.append(bytearray(16 * 1024 * 1024))", { limits: { memoryMb: 256, timeoutMs: 30_000 } });
      expect(r.status).toBe(200);
      expect(r.body.oomKilled).toBe(true);
      expect(r.body.ok).toBe(false);
      expect(r.body.timedOut).toBe(false);
      expect(Date.now() - t0).toBeLessThan(20_000);
      expect(((await (await fetch(`${base}/health`)).json()) as any).ok).toBe(true);
      expect(await leftoverContainers()).toBe("");
    },
    T,
  );

  test(
    "a fork bomb hits the pids limit",
    async () => {
      const r = await run(
        "import os\nn = 0\nerr = None\ntry:\n    for _ in range(10000):\n        if os.fork() == 0:\n            import time; time.sleep(30); os._exit(0)\n        n += 1\nexcept OSError as e:\n    err = type(e).__name__\nprint(n, err)",
        { limits: { pids: 32, timeoutMs: 5000 } },
      );
      expect(r.status).toBe(200);
      const [n, err] = r.body.stdout.trim().split(" ");
      expect(Number(n)).toBeLessThan(32);
      expect(err).not.toBe("None");
      expect(await leftoverContainers()).toBe("");
    },
    T,
  );

  test(
    "outputs are capped in size",
    async () => {
      const r = await run(
        "import os\nopen('/output/small.txt', 'w').write('ok')\ntry:\n    with open('/output/big.bin', 'wb') as f:\n        f.write(os.urandom(5 * 1024 * 1024))\nexcept OSError as e:\n    print('blocked', type(e).__name__)",
        { limits: { outputMb: 1 } },
      );
      expect(r.status).toBe(200);
      expect(r.body.stdout).toContain("blocked");
      expect(r.body.outputBytes).toBeLessThanOrEqual(1024 * 1024);
      const small = r.body.files.find((f: any) => f.name === "small.txt");
      expect(small && Buffer.from(small.b64, "base64").toString()).toBe("ok");
    },
    T,
  );

  test(
    "stdout floods are truncated, not buffered without bound",
    async () => {
      const r = await run("import sys\nfor _ in range(200000):\n    sys.stdout.write('x' * 100 + '\\n')", { limits: { timeoutMs: 20_000 } });
      expect(r.body.ok).toBe(true);
      expect(r.body.stdoutTruncated).toBe(true);
      expect(r.body.stdout.length).toBeLessThanOrEqual(64 * 1024);
    },
    T,
  );

  test(
    "killing the wrapper only ends the run",
    async () => {
      const r = await run("import os, signal\nos.kill(os.getppid(), signal.SIGKILL)\nimport time; time.sleep(60)", { limits: { timeoutMs: 5000 } });
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(false);
      expect(await leftoverContainers()).toBe("");
    },
    T,
  );
});

describe.skipIf(!canRun)("image", () => {
  test(
    "pandas, numpy, openpyxl, matplotlib with an Arabic font; outputs come back with hashes",
    async () => {
      const r = await run(
        `
import pandas as pd, numpy as np, matplotlib.pyplot as plt, onespace
from matplotlib import font_manager
df = pd.read_csv("/input/grades.csv")
df.to_excel("/output/grades.xlsx", index=False)
back = pd.read_excel("/output/grades.xlsx")
print("mean", float(np.mean(back["score"])))
print("amiri", "Amiri" in font_manager.findfont("Amiri", fallback_to_default=False))
onespace.arabic_plots()
plt.bar([onespace.ar(n) for n in df["name"]], df["score"])
plt.title(onespace.ar("الدرجات"))
plt.savefig("/output/chart.png")
`,
        { files: [{ name: "grades.csv", content: "name,score\nسارة,90\nأحمد,80\n" }] },
      );
      expect(r.body.exitCode).toBe(0);
      expect(r.body.stdout).toContain("mean 85.0");
      expect(r.body.stdout).toContain("amiri True");
      expect(r.body.stderr).not.toContain("missing from font");
      const names = r.body.files.map((f: any) => f.name).sort();
      expect(names).toEqual(["chart.png", "grades.xlsx"]);
      const png = r.body.files.find((f: any) => f.name === "chart.png");
      expect(Buffer.from(png.b64, "base64").subarray(1, 4).toString()).toBe("PNG");
      expect(png.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.body.inputs[0]).toMatchObject({ name: "grades.csv" });
    },
    T,
  );
});

/** Runs the image directly (not through the runner) with the given SANDBOX_EXPECT, code that prints RAN. */
async function runImageWith(expect: unknown | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "sbx-check-"));
  try {
    for (const sub of ["code", "input"]) {
      const d = join(dir, sub);
      mkdirSync(d);
      chmodSync(d, 0o755);
    }
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "code", "main.py"), 'print("RAN")', { mode: 0o444 });
    const args = [
      "run", "--rm", "--network", "none", "--read-only", "--user", "10001:10001", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1",
      "--pids-limit", "64", "--ulimit", "nofile=256:256", "--ulimit", "core=0:0", "--ipc", "none",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777",
      "--tmpfs", "/output:rw,nosuid,nodev,noexec,size=20m,mode=1777",
      "--tmpfs", "/dev/shm:rw,nosuid,nodev,noexec,size=1m,mode=1777",
      "--mount", `type=bind,source=${join(dir, "input")},target=/input,readonly`,
      "--mount", `type=bind,source=${join(dir, "code")},target=/code,readonly`,
      ...(expect === undefined ? [] : ["--env", `SANDBOX_EXPECT=${JSON.stringify(expect)}`]),
      IMAGE,
    ];
    const p = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: dockerEnv() });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return { raw: out, result: JSON.parse(out.slice(out.lastIndexOf(MARKER) + MARKER.length)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!canRun)("fail closed (the engine may ignore a flag)", () => {
  const asked = expectations({ timeoutMs: 30_000, memoryMb: 512, cpus: 1, pids: 64, outputMb: 20 }, "runc");

  test(
    "the isolation check passes when the container got what was asked",
    async () => {
      const { result, raw } = await runImageWith(asked);
      expect(result.checkFailures).toBeUndefined();
      expect(result.checks).toBe("passed");
      expect(raw).toContain("RAN");
    },
    T,
  );

  test(
    "a limit the container didn't get stops the run before any user code",
    async () => {
      // Ask for less than the container has: as if the engine had ignored --memory / --pids-limit / tmpfs size.
      const { result, raw } = await runImageWith({ ...asked, memoryBytes: 256 * 1024 * 1024, pids: 32, shmBytes: 1024, nofile: 64 });
      expect(result.checks).toBe("failed");
      expect(result.checkFailures).toEqual(expect.arrayContaining(["memory limit", "pids limit", "/dev/shm size", "nofile limit"]));
      expect(raw).not.toContain("RAN");
    },
    T,
  );

  test(
    "no expectations (an old runner) also refuses to run",
    async () => {
      const { result, raw } = await runImageWith(undefined);
      expect(result.checks).toBe("failed");
      expect(raw).not.toContain("RAN");
    },
    T,
  );

  test(
    "a runtime the engine doesn't list is refused, not silently replaced",
    async () => {
      const info = Bun.spawnSync(["docker", "info", "--format", "{{json .Runtimes}}"], { env: dockerEnv() });
      const listed = Object.keys(JSON.parse(info.stdout.toString() || "{}"));
      for (const runtime of ["runc", "runsc"] as const) {
        if (listed.includes(runtime)) expect(await resolveRuntime({ runtime })).toBe(runtime);
        else await expect(resolveRuntime({ runtime })).rejects.toBeInstanceOf(RuntimeUnavailable);
      }
      expect(listed).toContain(await resolveRuntime({ runtime: "auto" }));
    },
    T,
  );

  test(
    "/dev/shm is at most 1 MB through the runner",
    async () => {
      const res = await probe(`
import os
res["shm"] = os.statvfs("/dev/shm").f_blocks * os.statvfs("/dev/shm").f_frsize if os.path.exists("/dev/shm") else 0
`);
      expect(res.shm).toBeLessThanOrEqual(1024 * 1024);
    },
    T,
  );
});
