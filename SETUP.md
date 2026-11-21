# Running OneSpace: one machine or several

This guide covers where each part of OneSpace runs and how they connect, on one machine or spread over several PCs or VMs. It also covers how to plug in the model servers you already use: Ollama, vLLM, llama.cpp (`llama-server`), LM Studio, or a hosted provider such as OpenRouter.

Installing on a server, the first admin, HTTPS, backups and updates are in [deploy/SETUP.md](deploy/SETUP.md). This guide doesn't repeat them.

## The parts

| Part | What it does | Needs | Port |
|---|---|---|---|
| **app** | The web app, API and database (OneBase), with uploaded files in its data volume. | CPU, 2+ GB RAM, disk for files | 8090, the only one people open |
| **sandbox** | Runs analysis code («تشغيل تحليل») in throwaway containers with no network. | Docker on that machine | 8787, for the app only |
| **model servers** | The models: chat, fast, embedding, and optionally vision, reranking and decisions. | GPU for local models, or an internet connection for a hosted API | your choice |

Rules that hold in every layout:

- **Run exactly one app.** It keeps its database in its own volume (SQLite), so you can't run two copies side by side. To grow, add model capacity, not app copies.
- **The sandbox controls Docker on its machine.** Never expose port 8787 to anyone but the app.
- **Models are chosen in the app**, under **إدارة المنصة ← مزوّدو النماذج**, not in config files. You add each server once, press «افحص», and pick which model plays each role. Changes take effect at once, with no restart.

## Choosing a layout

| Layout | When | Machines |
|---|---|---|
| **A. One machine** | A pilot or a small team; one server with a GPU (or a hosted API) | 1 |
| **B. App + GPU machine** | The GPU box is shared, or kept apart from the web server | 2 |
| **C. Separate sandbox** | You want analysis code off the app machine | 3 |
| **D. Several model machines** | Many users, or big models on one GPU and small ones on another | 3+ |
| **E. Hosted models only** | No GPU; the organization allows a hosted API | 1 (no GPU) |

The layouts combine. For example, C and D together is: an app VM, a sandbox VM, and two GPU machines.

### A. Everything on one machine

```
┌──────────────── one server ────────────────┐
│ app :8090 ── sandbox :8787 (internal)      │
│   │                                        │
│   └── model servers (host or containers)   │
└────────────────────────────────────────────┘
```

1. Follow [deploy/SETUP.md](deploy/SETUP.md) steps 1, 2, 4 and 5.
2. Start your model servers on the same machine (see [The model servers](#the-model-servers)).
   - **The address issue:** the app runs in a container, so `127.0.0.1` inside it is the container, not the host.
   - **Which address to add:** in the app, add servers as `http://host.docker.internal:<port>/v1`.
   - **Where the server must listen:** on the Docker bridge (`172.17.0.1`), or on `0.0.0.0` with a firewall that blocks the port from outside.
3. Or let Compose run llama.cpp for you: put GGUF files in `deploy/models/` and run `docker compose --profile models up -d`. In the app, add them as `http://llm-main:8401/v1`, `http://llm-fast:8402/v1` and `http://embed:8403/v1`.

### B. App on one machine, models on a GPU machine

```
┌─── app VM ───────────┐        ┌─── GPU machine ──────────┐
│ app :8090            │──────▶ │ llama-server / vLLM /    │
│ sandbox :8787 (int.) │  LAN   │ Ollama  :8401 :8402 …    │
└──────────────────────┘        └──────────────────────────┘
```

1. **App VM:** follow [deploy/SETUP.md](deploy/SETUP.md) as usual.
2. **GPU machine:** start the model servers listening on its private address (e.g. `--host 10.0.0.20`), or on `0.0.0.0` behind a firewall.
3. **Firewall on the GPU machine:** open the model ports to the app VM's address only. For example, with `ufw`:
   ```bash
   sudo ufw allow from 10.0.0.10 to any port 8401:8410 proto tcp
   ```
4. **API keys:** give each server one if it supports it (`llama-server --api-key …`, `vllm serve … --api-key …`), and enter the key in the app when you add the provider. Ollama has no key, so rely on the firewall.
5. **In the app:** add each server as `http://10.0.0.20:<port>/v1`.

Between machines, keep model traffic on a private network: the same LAN or VLAN, or a VPN such as WireGuard or Tailscale. Prompts and file passages travel over it in plain HTTP.

### C. The sandbox on its own VM

The sandbox runs code the assistant writes, so some teams keep it off the app machine. It needs Docker on its VM and the analysis image built there.

**On the sandbox VM** (a copy of the repo, the same `.env` with the same `SANDBOX_SECRET`):

```bash
cd onespace/deploy
docker compose --profile setup build sandbox-image
```

Add `deploy/docker-compose.override.yml` to publish the port on the private address only:

```yaml
services:
  sandbox:
    ports:
      - "10.0.0.30:8787:8787"
```

```bash
docker compose up -d sandbox
```

Firewall: port 8787 is for the app VM only (`sudo ufw allow from 10.0.0.10 to any port 8787 proto tcp`).

**On the app VM**, point the app at it with `deploy/docker-compose.override.yml`:

```yaml
services:
  app:
    environment:
      SANDBOX_URL: http://10.0.0.30:8787
```

Then start the app alone: `docker compose up -d --no-deps app`. `--no-deps` stops Compose from also starting a local sandbox.

### D. Several model machines

Spread the roles by size:

- **The main model** (chat, tools, analysis) is the heaviest. Give it the biggest GPU.
- **The fast, embedding, reranking and decision models** are small. They fit together on a second GPU, or even next to the main model.
- **Vision** can be the main model, if it reads images, or its own server.

Each server is a separate provider in the app. Two GPU machines look like this:

| Provider (in the app) | Address | Models → roles |
|---|---|---|
| GPU 1 · llama.cpp | `http://10.0.0.20:8401/v1` | main, vision |
| GPU 2 · llama.cpp router | `http://10.0.0.21:9931/v1` | fast, decision |
| GPU 2 · embeddings | `http://10.0.0.21:8403/v1` | embedding |
| GPU 2 · reranker | `http://10.0.0.21:8404/v1` | (server setting `RERANK_BASE_URL`) |

**More users on one model:** start the server with parallel slots (`llama-server -np 4`), or use vLLM, which batches on its own. Then set `GPU_SLOTS` in `.env` to how many answers may run at once. The app queues the rest and shows each person their place.

### E. Hosted models only

1. Add a provider such as OpenRouter (`https://openrouter.ai/api/v1`) with its API key.
2. Pick the main, fast and vision models from its list.
3. **Embeddings:** you still need an embedding model of the right size (see [Embeddings](#embeddings-fixed-size)). Use a hosted one if the provider offers one of that size, or a small local server. `embeddinggemma` runs on a CPU.

Questions and file passages then leave your network, so check this with your organization's policy first.

## The model servers

Any OpenAI-compatible server works. What differs is what each one can serve and the flags it needs. The app reads each model's kind when you press «افحص», lists only fitting models for each role, and tries a model before saving it. When something is missing, the error says in Arabic what to fix.

| | Chat / fast | Vision | Embeddings | Reranking | Decisions (`/v1/systemone`) |
|---|---|---|---|---|---|
| **llama.cpp** (`llama-server`) | ✅ | with `--mmproj` | with `--embeddings` | with `--reranking` | ✅ models such as d1 |
| **vLLM** | ✅ | ✅ (VLM models) | embedding mode | score mode | — |
| **Ollama** | ✅ | ✅ (vision models) | ✅ | — | — |
| **LM Studio** | ✅ | ✅ | ✅ (load an embedding model) | — | — |
| **OpenRouter / hosted** | ✅ | depends on the model | depends on the provider | rarely | — |

### llama.cpp (`llama-server`)

You can run **one model per server**, each on its own port:

```bash
llama-server -m main.gguf  --host 0.0.0.0 --port 8401 -c 32768 -ngl 999 --jinja -np 4 --alias main
llama-server -m fast.gguf  --host 0.0.0.0 --port 8402 -c 16384 -ngl 999 --jinja -np 4 --alias fast
llama-server -m embed.gguf --host 0.0.0.0 --port 8403 --embeddings -ngl 999 --alias embed
llama-server -m rerank.gguf --host 0.0.0.0 --port 8404 --reranking -ngl 999 --alias rerank
```

Or run **router mode**: one `llama server` that starts each model on demand. Then add it once in the app and pick its models per role.
- **Per-model flags:** set them in that model's preset, such as `--embeddings` for an embedding model and `--mmproj` for vision.
- **Without them:** the router starts the model for chat only. An embedding model then fails with «هذا الخادم لا يدعم التضمين».
- **Decision models** (such as d1-Omni-2B) are served on `/v1/systemone`. The app detects them, so choosing one for «نموذج القرار» is enough.

Unsloth Studio runs llama.cpp underneath, so the same flags apply.

### vLLM

vLLM serves **one model per server**, so start one per role, each on its own port:

```bash
vllm serve Qwen/Qwen3-32B-AWQ --host 0.0.0.0 --port 8000 --api-key "$KEY" --enable-auto-tool-choice --tool-call-parser hermes
vllm serve google/embeddinggemma-300m --host 0.0.0.0 --port 8001 --api-key "$KEY" --task embed
```

- **Tool calls:** the main model must have them on (`--enable-auto-tool-choice` with the parser that fits the model). The assistant's tools depend on it.
- **Version flags:** the embedding flag differs between vLLM versions (`--task embed`, or `--runner pooling` in newer ones). Check `vllm serve --help` for yours.

### Ollama

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
ollama pull qwen3            # chat
ollama pull embeddinggemma   # embeddings
```

- **Adding it:** add it as `http://<host>:11434/v1`.
- **Models:** pull a model before choosing it; otherwise the app says «نزّله أولاً (ollama pull …)».
- **No key:** Ollama has no API key, so keep the port behind the firewall.

### LM Studio

Turn on the local server (port 1234), load the models you want, and add it as `http://<host>:1234/v1`. A model that isn't loaded can't be chosen.

### OpenRouter and other hosted APIs

Add `https://openrouter.ai/api/v1`, or the provider's own URL, with the API key. Credit and rate-limit errors appear in Arabic in the role's card.

## Embeddings: fixed size

File search stores one vector per passage, of the size `EMBED_DIMENSIONS` in `.env` (768 by default, the size of `embeddinggemma`).

- **Set it before the first file is uploaded.** After that it is fixed.
- **Model size:** the embedding model you choose must give vectors of that size, or be able to shorten them. The app tests this before saving.
- **Changing the model later:** files must be indexed again. On «مزوّدو النماذج» that is the «أعد الفهرسة» button, and file search pauses until it finishes.

## System tools the app needs

The app server runs a few programs for files and certificates. The Docker image (`app/Dockerfile`) installs them already. If you run the app without Docker (`bun` on the machine itself), install the same packages. On Debian or Ubuntu:

```bash
sudo apt-get install --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui poppler-utils unzip fontconfig fonts-hosny-amiri fonts-noto-core fonts-kacst-one
```

| Tool | Package | Used for |
|---|---|---|
| `soffice` (LibreOffice, headless) | `libreoffice-writer-nogui`, `libreoffice-calc-nogui` | Reading .doc, .odt, .rtf, .xls and .ods files; turning Word certificate templates into PDF |
| `pdftotext`, `pdftoppm`, `pdfinfo` | `poppler-utils` | Reading PDFs, rendering scanned pages for OCR, certificate previews |
| `unzip` | `unzip` | Reading the contents of .docx and .xlsx files |
| `fc-list` | `fontconfig` | Warning when a Word template uses a font the server doesn't have |
| Arabic fonts | `fonts-hosny-amiri`, `fonts-noto-core`, `fonts-kacst-one` | Certificates print with the right Arabic font (the sample template uses Amiri) |

- **Set `SAL_DISABLE_CUPS=1`** in the app's environment. Without it, LibreOffice waits about 25 seconds per Word file looking for a printer service. The Docker image sets it.
- **A template needs a font the server lacks:** LibreOffice swaps in another font, so the certificate looks different. Install the font on the server (on Docker, add its package to `app/Dockerfile`), then run `fc-cache -f`.
- **PowerPoint files** (.ppt, .pptx) aren't converted today. If that changes, add `libreoffice-impress-nogui`.

## Checking it works

1. **«مزوّدو النماذج»:** each provider shows «يعمل», and each role card names a model. Pressing «جرّب واحفظ» on a role tests it again.
2. **Files:** upload a file to a space. Within a minute it should be ready to search. If it stays processing, the embedding model is the cause.
3. **A chat:** ask about that file. The answer should cite it.
4. **Analysis:** ask for a small calculation «بتشغيل تحليل». If it fails with «بيئة التحليل غير مفعّلة», check `SANDBOX_URL` and `SANDBOX_SECRET` (layout C), and that the sandbox is running.

## Common problems

| Symptom | Cause |
|---|---|
| «تعذّر الوصول إلى الخادم» when adding a provider | From inside the app container, the model server isn't reachable. On the same host, use `host.docker.internal` and don't bind the server to `127.0.0.1`. On another machine, check the firewall and the address. |
| An embedding model fails with «لا يدعم التضمين» | llama.cpp needs `--embeddings`; in router mode, set it in that model's preset. |
| «هذا نموذج قرار» on a chat role | A decision model (such as d1) can only play «نموذج القرار». |
| Answers queue for a long time | Raise the server's parallel slots (`-np`) and `GPU_SLOTS`, or move the small models to another GPU (layout D). |
| Analysis is slow to start on a new sandbox VM | The analysis image wasn't built there yet. Run `docker compose --profile setup build sandbox-image` on the sandbox VM. |
