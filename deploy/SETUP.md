# OneSpace (مساحة) setup guide

From an empty Linux server to employees asking questions. It takes about 30 minutes, plus the time to download the models.

## What runs where

| Part | What it does | Port |
|---|---|---|
| `app` | The web app and API (OneBase). Data goes in the `onespace-data` volume: database, files, admin key. | 8090, the only published port |
| `sandbox` | Runs analysis code. Each run gets a throwaway container with no network. | 8787, internal only |
| Model servers | OpenAI-compatible servers: llama.cpp, vLLM, Ollama or a hosted API. | your choice |

## 1. Requirements

- **Server:** Linux with Docker 24+ and Docker Compose v2 (`docker compose version`).
- **Disk:** 20 GB for the app, plus room for uploaded files and the models.
- **Local models (optional):** an NVIDIA GPU with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/). As a guide, a 27B main model in Q4 needs about 20 GB of VRAM. You can use a hosted, OpenAI-compatible API instead.
- **Internet:** needed once, to build the images. After that, nothing has to leave the server.

## 2. Get the code and configure

```bash
git clone git@github.com:abdullah-bl/OneSpace.git onespace
cd onespace/deploy
cp .env.example .env
openssl rand -hex 32        # paste the output into SANDBOX_SECRET in .env
```

Then edit `.env`:

- `ONEBASE_URL`: the address people will open, for example `https://onespace.example.org`.
- `SANDBOX_SECRET`: the random value from above.
- The models: see step 3.

## 3. Models

You need three: a **main** model (chat, tools, analysis), a **fast** one (titles, routing, the «أساسي» level) and an **embedding** model (file search). Reranking and vision are optional.

**A. Servers already running on this machine.** In `.env`, use `http://host.docker.internal:<port>/v1`. A server that listens only on `127.0.0.1` can't be reached from a container. Start it on the Docker bridge address instead (`--host 172.17.0.1`), or on `0.0.0.0` with a firewall that blocks the port from outside.

**B. Let Compose run llama.cpp.** Put the GGUF files in `deploy/models/` and set their file names in `.env` (`MAIN_MODEL_FILE`, …). Point the URLs at the services:

```
LLM_BASE_URL=http://llm-main:8401/v1
LLM_FAST_BASE_URL=http://llm-fast:8402/v1
EMBED_BASE_URL=http://embed:8403/v1
```

Then start them with `docker compose --profile models up -d`.

**C. A hosted API.** Set the URL, `LLM_API_KEY` and the model names.

Later, an admin can add or switch servers in the app without a restart, under **إدارة المنصة ← مزوّدو النماذج**. That page lists each server's models.

> `EMBED_DIMENSIONS` and the embedding model are fixed once files are indexed. Changing them later means re-indexing every file.

## 4. Build and start

```bash
docker compose --profile setup build sandbox-image   # the analysis image, once (~3 GB)
docker compose up -d --build
docker compose ps                                     # app and sandbox: running / healthy
```

Open `http://<server>:8090`.

## 5. The first admin

1. In the app, create an account with your email. It stays «بانتظار التفعيل».
2. On the server, run:
   ```bash
   docker compose exec -e ONESPACE_DATA=/data app bun scripts/bootstrap-admin.ts you@example.org "اسم الجهة"
   ```
3. Sign in again. You are now the workspace admin.
4. Everyone else signs up, and you activate them in **إدارة المنصة ← الموظفون**. Check that the email belongs to the person first, because there is no email verification.

## 6. First steps in the app

In **إدارة المنصة**:

1. **المساحات:** create the shared spaces (departments, teams). Mark one «للجميع» for policies and regulations.
2. **المستويات وحدود الاستخدام:** create levels such as «أساسي» and «متقدم». The first general level becomes the default. Giving a level to a space makes it a team level.
3. **الوكلاء:** «أضف الوكلاء المبدئيين», then review them and publish.
4. **مصادر البيانات** (optional): connect a database, a REST system, a search engine or an MCP server.
5. **مزامنة المجلدات** (optional): copy a network share into a space; see step 8.

## 7. HTTPS

Put a reverse proxy in front of port 8090. It must pass WebSockets through (`/api/sync`). With [Caddy](https://caddyserver.com):

```
onespace.example.org {
    reverse_proxy 127.0.0.1:8090
}
```

Then set `APP_PORT=127.0.0.1:8090` in `.env`, so the app is reachable only through the proxy, and run `docker compose up -d`.

## 8. Folder sync (network shares)

The app reads shared folders from `SHARES_DIR` on the host, mounted read-only at `/shares`. To mount an SMB/Windows share on the host:

```bash
sudo apt install cifs-utils
sudo mkdir -p /srv/onespace-shares/hr
# /etc/fstab (use a read-only service account):
//fileserver/HR  /srv/onespace-shares/hr  cifs  ro,credentials=/root/.smb-onespace,iocharset=utf8,uid=1000,gid=1000  0  0
sudo mount -a
```

Set `SHARES_DIR=/srv/onespace-shares` in `.env`, then run `docker compose up -d`. Next, in **مزامنة المجلدات**, pick the folder and the target space.

- What gets copied: new files are added and changed files become a new version. Nothing is ever deleted from the space.
- Who can read it: the space's members read everything copied there. The share's own permissions are not carried over, so pick a space whose members may see the whole folder.

## 9. Data sources: use read-only accounts

The app runs only one `SELECT` per query, inside a read-only transaction. Give it a read-only account as well:

```sql
-- PostgreSQL
CREATE ROLE onespace_reader LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE hr TO onespace_reader;
GRANT USAGE ON SCHEMA public TO onespace_reader;
GRANT SELECT ON employees, leave_balances TO onespace_reader;   -- only what's needed

-- MySQL / MariaDB
CREATE USER 'onespace_reader'@'%' IDENTIFIED BY '…';
GRANT SELECT ON erp.purchases TO 'onespace_reader'@'%';
```

An MCP server can't promise that its tools only read. Allow only the tools that read.

## 10. Backups

Everything is in the `onespace-data` volume.

- **Simple:** stop the app, copy the volume, and start the app again:
  ```bash
  docker compose stop app
  docker run --rm -v onespace_onespace-data:/data -v "$PWD":/b alpine tar czf /b/onespace-$(date +%F).tgz -C /data .
  docker compose start app
  ```
- **Continuous (S3/MinIO):** add `ONEBASE_BACKUP=s3://bucket/onespace` (and the S3 credentials) to `.env`. OneBase then snapshots the database every hour (`ONEBASE_BACKUP_EVERY`).

## 11. Updates

```bash
git pull
docker compose --profile setup build sandbox-image   # only if sandbox-runner/image changed
docker compose up -d --build
```

## 12. Security notes

- **The sandbox runner is effectively root on the host.** It uses the Docker socket, so never publish its port. Keep `SANDBOX_SECRET` long and private.
- **Each analysis run** has no network, a read-only root filesystem and a non-root user, with every capability dropped and memory, CPU and time limits. For stronger isolation, install gVisor (`runsc`). The runner uses it automatically when Docker has it.
- **Secrets stay on the server.** API keys, connection strings and auth headers entered in the app are kept there and never shown again, in the browser or to the model.
- **The audit log** («سجل التدقيق») records admin actions, file access in sensitive spaces, every data-source query and every assistant action.

## Troubleshooting

| Symptom | Check |
|---|---|
| Answers fail with «نموذج المحادثة غير مضبوط» or time out | **مزوّدو النماذج ← افحص**. From the container: `docker compose exec app bun -e "console.log((await fetch(process.env.LLM_BASE_URL+'/models')).status)"`. A model server bound to 127.0.0.1 on the host is the usual cause (step 3A). |
| Analysis says the sandbox is unavailable | `docker compose logs sandbox`. Check that `docker image ls onespace-sandbox` shows tag `3`, and that `SANDBOX_SECRET` is set. |
| Uploaded files never become searchable (stuck processing) | The embedding server isn't reachable (`EMBED_BASE_URL`). |
| Live updates don't arrive behind a proxy | The proxy must pass WebSocket upgrades on `/api/sync`. |
| «مزامنة المجلدات غير مفعّلة» | The `SHARES_DIR` mount. `SYNC_ROOT=/shares` is set by Compose. |
| The OneBase dashboard | `http://<server>:8090/_admin`, with the key from `docker compose exec app cat /data/admin.key`. |
