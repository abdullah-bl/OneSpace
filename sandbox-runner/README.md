# sandbox-runner

A small standalone Bun HTTP service that runs analysis code in a fresh Docker container per run.
It is the **only** process with Docker access: OneBase never gets the Docker socket. OneBase sends
the code plus the bytes of files it already checked with `access.ts`; the runner never sees the
database (plans/02 rule 7).

## Start

```bash
cd sandbox-runner
bun install
bun run build-image                       # docker build -t onespace-sandbox:2 image  (needs internet once)
export SANDBOX_SECRET="$(openssl rand -hex 32)"
bun run start                             # http://127.0.0.1:8787
```

Then give OneBase the same values (Environment page or `onebase env set`):

```bash
onebase env set SANDBOX_URL http://127.0.0.1:8787
onebase env set SANDBOX_SECRET "$SANDBOX_SECRET"
```

The user running the runner must be able to use Docker (member of the `docker` group). Run it as
its own systemd service; OneBase's user should not be in the `docker` group.

| variable | default | |
|---|---|---|
| `SANDBOX_SECRET` | — (required, ≥16 chars) | shared secret, `Authorization: Bearer …` |
| `SANDBOX_HOST` / `SANDBOX_PORT` | `127.0.0.1` / `8787` | keep it on loopback |
| `SANDBOX_IMAGE` | `onespace-sandbox:2` | |
| `SANDBOX_RUNTIME` | `auto` | `auto` uses gVisor (`runsc`) when Docker has it, else `runc`; or force `runc`/`runsc` |
| `SANDBOX_MAX_CONCURRENCY` | `2` | containers at once; extra runs wait |
| `SANDBOX_MAX_TIMEOUT_MS` / `_MEMORY_MB` / `_CPUS` / `_PIDS` / `_OUTPUT_MB` | 120000 / 2048 / 2 / 256 / 50 | ceilings; request limits are clamped to them |
| `SANDBOX_MAX_INPUT_MB` | `100` | total input bytes per run |
| `SANDBOX_WORKDIR` | `$TMPDIR/onespace-sandbox` | per-run input/code dirs, deleted after each run |

## Documents (image 2)

The image also renders outputs as files: `import onespace_doc; onespace_doc.main()` reads
`/input/doc.json` (`{title, kind: "markdown"|"html", content, format: "docx"|"pdf"|"pptx"}`) and writes
`/output/out.<format>`, with Arabic right-to-left (Word bidi paragraphs, PowerPoint `rtl`, PDF via
WeasyPrint/Pango with Noto Naskh Arabic). OneBase sends this fixed code (`app/onebase/lib/docExport.ts`);
the model never writes it. HTML is rendered with only `data:` URLs allowed (no `file://`).
Image 2 adds python-docx, python-pptx, WeasyPrint, markdown-it-py, Noto fonts and Pango; rebuild with
`bun run build-image` after pulling.

## API

- `GET /health` → `{ ok, docker, image, runtime }` (no secret needed).
- `POST /run` with `Authorization: Bearer $SANDBOX_SECRET`, body
  `{ code, files: [{ name, b64 }], limits?: { timeoutMs, memoryMb, cpus, pids, outputMb } }` →
  `{ ok, exitCode, timedOut, oomKilled, durationMs, stdout, stderr, stdoutTruncated, files: [{ name, size, sha256, b64 }], outputBytes, outputTruncated, error?, limits, runtime, image, inputs: [{ name, size, sha256 }] }`.

## Isolation (every run)

`docker run` with: `--network none` (loopback only), `--read-only` root filesystem, tmpfs `/tmp`
(128 MB) and `/output` (size = output limit, `noexec,nosuid,nodev`), user `10001:10001`,
`--cap-drop ALL`, `--security-opt no-new-privileges`, Docker's default seccomp profile,
`--memory` = `--memory-swap` (no swap), `--cpus`, `--pids-limit`, `nofile`/`core` ulimits,
`--ipc none`, `--log-driver none`, `--init`. Inputs are bind-mounted read-only at `/input`
(names reduced to a safe basename), the code read-only at `/code/main.py`.

Inside, `image/entry.py` runs the code in its own process group with a time limit, an output
file-size rlimit and `oom_score_adj=1000` (the OOM killer takes the user code, not the reporter),
captures stdout/stderr (64 KB each), kills every leftover process, and prints one JSON result
with the files from `/output`. The runner kills the container if it outlives the limit + 8 s,
caps what it reads from the container, removes the container and the run directory, and on start
removes containers left by a crashed runner (label `onespace.sandbox=1`).

### gVisor (optional hardening)

Install `runsc` and register it with Docker (`sudo runsc install && sudo systemctl restart docker`).
With `SANDBOX_RUNTIME=auto` (default) the runner detects it from `docker info` and passes
`--runtime runsc`; `/health` reports which runtime is in use. gVisor puts a user-space kernel
between the code and the host kernel, which covers kernel exploits that seccomp/namespaces don't.
Not installed on the development machine (runs used `runc`); the tests pass with either.

## Image

`image/Dockerfile`: `python:3.12.7-slim-bookworm`, numpy 2.1.3, pandas 2.2.3, matplotlib 3.9.2,
openpyxl 3.1.5, arabic-reshaper, python-bidi; fonts Amiri, KACST, DejaVu; a pre-built matplotlib
font cache. `import onespace` gives `onespace.ar(text)` (shapes Arabic for matplotlib) and
`onespace.arabic_plots()`.

## Tests

```bash
bun test tests      # unit tests always; container tests skip themselves without Docker/image
```

Network (no interfaces but `lo`, no DNS, no internet, no host/bridge/OneBase), filesystem (only
`/input` `/code` `/output` `/tmp` mounted, no Docker socket, no `/home`, everything outside tmpfs
read-only, `/input` read-only), identity (uid 10001, no capabilities, `NoNewPrivs`), infinite
loop / signal-ignoring forked loop / memory bomb / fork bomb killed within limits with no
leftover containers, output size cap, stdout flood, killing the reporter, and the image (pandas,
openpyxl, matplotlib with an Arabic font).
