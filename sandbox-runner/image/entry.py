"""Container entrypoint: runs /code/main.py once, then reports the result and /output as one JSON line.

Runs as the unprivileged sandbox user inside a container with no network, a read-only root, and
tmpfs /tmp and /output. The user code runs in a child process group with its own time limit; the
outer runner enforces the wall-clock limit again by killing the container.
"""

import base64
import json
import os
import resource
import shutil
import signal
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
