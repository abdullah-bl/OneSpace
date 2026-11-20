"""Container entrypoint: runs /code/main.py once, then reports the result and /output as one JSON line.

Runs as the unprivileged sandbox user inside a container with no network, a read-only root, and
tmpfs /tmp and /output. The user code runs in a child process group with its own time limit; the
outer runner enforces the wall-clock limit again by killing the container.

Before any user code runs, check_isolation() compares what the kernel actually applied with what the
runner asked for (SANDBOX_EXPECT). A container engine may accept a flag and ignore it; if anything is
missing, the user code never runs and the result says which checks failed (fail closed).
"""

import base64
import json
import os
import resource
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

MARKER = "@@ONESPACE_RESULT@@"
TIMEOUT_MS = int(os.environ.get("SANDBOX_TIMEOUT_MS", "30000"))
OUTPUT_MAX = int(os.environ.get("SANDBOX_OUTPUT_MAX", str(20 * 1024 * 1024)))
OUTPUT_FILES_MAX = int(os.environ.get("SANDBOX_OUTPUT_FILES_MAX", "50"))
STREAM_MAX = int(os.environ.get("SANDBOX_STREAM_MAX", str(64 * 1024)))


def oom_kills():
    try:
        with open("/sys/fs/cgroup/memory.events") as f:
            for line in f:
                k, _, val = line.partition(" ")
                if k == "oom_kill":
                    return int(val)
    except OSError:
        pass
    return 0


def _status():
    out = {}
    with open("/proc/self/status") as f:
        for line in f:
            k, _, v = line.partition(":")
            out[k] = v.strip()
    return out


def _mounts():
    """Mount point → options of the topmost mount there (later lines are mounted over earlier ones)."""
    out = {}
    with open("/proc/self/mounts") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 4:
                out[parts[1]] = set(parts[3].split(","))
    return out


def _read(path):
    with open(path) as f:
        return f.read().strip()


def check_isolation(expect):
    """Returns the list of isolation checks that failed (empty = safe to run the user code)."""
    failed = []

    def check(name, fn):
        try:
            if not fn():
                failed.append(name)
        except Exception as e:  # a check that can't be evaluated counts as failed
            failed.append(f"{name} ({type(e).__name__})")

    st = _status()
    mounts = _mounts()

    def size_at_most(path, limit):
        v = os.statvfs(path)
        return v.f_blocks * v.f_frsize <= limit

    check("uid/gid", lambda: os.getuid() == expect["uid"] and os.getgid() == expect["gid"])
    check("no capabilities", lambda: int(st["CapEff"], 16) == 0 and int(st["CapPrm"], 16) == 0 and int(st["CapBnd"], 16) == 0)
    check("no-new-privileges", lambda: st["NoNewPrivs"] == "1")
    check("network: loopback only", lambda: [n for _, n in socket.if_nameindex()] == ["lo"])
    check("read-only root", lambda: "ro" in mounts["/"])
    check("read-only /input", lambda: "ro" in mounts["/input"])
    check("read-only /code", lambda: "ro" in mounts["/code"])
    check("/tmp size", lambda: size_at_most("/tmp", expect["tmpBytes"]))
    check("/output size", lambda: size_at_most("/output", expect["outputBytes"]))
    check("/dev/shm size", lambda: not os.path.exists("/dev/shm") or size_at_most("/dev/shm", expect["shmBytes"]))
    check("nofile limit", lambda: max(resource.getrlimit(resource.RLIMIT_NOFILE)) <= expect["nofile"])
    check("no core dumps", lambda: resource.getrlimit(resource.RLIMIT_CORE)[1] == 0)
    if expect.get("kernelChecks", True):
        check("seccomp filter", lambda: st["Seccomp"] == "2")
        check("memory limit", lambda: int(_read("/sys/fs/cgroup/memory.max")) <= expect["memoryBytes"])
        check("no swap", lambda: _read("/sys/fs/cgroup/memory.swap.max") == "0")
        check("pids limit", lambda: int(_read("/sys/fs/cgroup/pids.max")) <= expect["pids"])

        def cpu_ok():
            quota, period = _read("/sys/fs/cgroup/cpu.max").split()
            return quota != "max" and int(quota) / int(period) <= expect["cpus"] * 1.01

        check("cpu limit", cpu_ok)
    return failed


def reader(pipe, sink):
    kept = bytearray()
    total = 0
    while True:
        chunk = pipe.read(65536)
        if not chunk:
            break
        total += len(chunk)
        room = STREAM_MAX - len(kept)
        if room > 0:
            kept += chunk[:room]
    sink["text"] = kept.decode("utf-8", "replace")
    sink["truncated"] = total > STREAM_MAX


def child_setup():
    os.setsid()
    try:
        with open("/proc/self/oom_score_adj", "w") as f:  # the OOM killer takes the user code first
            f.write("1000")
    except OSError:
        pass
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_MAX, OUTPUT_MAX))


def kill_others():
    me = os.getpid()
    for entry in os.listdir("/proc"):
        if entry.isdigit() and int(entry) not in (1, me):
            try:
                os.kill(int(entry), signal.SIGKILL)
            except OSError:
                pass


def collect_outputs():
    files, total, truncated = [], 0, False
    for root, dirs, names in os.walk("/output", followlinks=False):
        dirs.sort()
        for name in sorted(names):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, "/output")
            if os.path.islink(path) or not os.path.isfile(path):
                continue
            size = os.path.getsize(path)
            if len(files) >= OUTPUT_FILES_MAX or total + size > OUTPUT_MAX:
                truncated = True
                continue
            with open(path, "rb") as f:
                data = f.read(OUTPUT_MAX + 1)
            total += len(data)
            files.append({"name": rel, "size": len(data), "b64": base64.b64encode(data).decode("ascii")})
    return files, total, truncated


def main():
    try:
        expect = json.loads(os.environ["SANDBOX_EXPECT"])
        failures = check_isolation(expect)
    except Exception as e:
        failures = [f"no usable SANDBOX_EXPECT ({type(e).__name__})"]
    if failures:
        sys.stdout.write("\n" + MARKER + json.dumps({"checks": "failed", "checkFailures": failures, "exitCode": None}) + "\n")
        sys.stdout.flush()
        return
    for d in ("/tmp/work", "/tmp/home"):
        os.makedirs(d, exist_ok=True)
    try:
        shutil.copytree("/opt/mplconfig", "/tmp/mpl", dirs_exist_ok=True)
    except OSError:
        os.makedirs("/tmp/mpl", exist_ok=True)
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/tmp/home",
        "LANG": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONPATH": "/opt/sandbox/lib",
        "PYTHONDONTWRITEBYTECODE": "1",
        "MPLCONFIGDIR": "/tmp/mpl",
        "MPLBACKEND": "Agg",
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
    }
    oom_before = oom_kills()
    started = time.monotonic()
    proc = subprocess.Popen(
        [sys.executable, "-B", "-s", "/code/main.py"],
        cwd="/tmp/work",
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=child_setup,
    )
    out, err = {}, {}
    threads = [threading.Thread(target=reader, args=(proc.stdout, out)), threading.Thread(target=reader, args=(proc.stderr, err))]
    for t in threads:
        t.start()
    timed_out = False
    try:
        code = proc.wait(timeout=TIMEOUT_MS / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        code = proc.wait()
    # Leftover processes (the group, or ones that escaped it with setsid) may hold the pipes open:
    # kill every process in the container except PID 1 (init) and this wrapper.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except OSError:
        pass
    kill_others()
    for t in threads:
        t.join(timeout=5)
    duration = int((time.monotonic() - started) * 1000)
    oom = oom_kills() > oom_before
    files, total, truncated = collect_outputs()
    result = {
        "checks": "passed",
        "exitCode": code,
        "timedOut": timed_out,
        "oomKilled": oom,
        "durationMs": duration,
        "stdout": out.get("text", ""),
        "stderr": err.get("text", ""),
        "stdoutTruncated": out.get("truncated", False),
        "stderrTruncated": err.get("truncated", False),
        "files": files,
        "outputBytes": total,
        "outputTruncated": truncated,
    }
    sys.stdout.write("\n" + MARKER + json.dumps(result) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
