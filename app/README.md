# OneSpace (مساحة) — Phases 1–2: الأساس، RAG والمحادثة

Workspace with users, personal/shared spaces, files with versions, permissions and an audit log.
No AI yet. Backend: OneBase (`onebase/`). Frontend: React 19 + Vite + Tailwind 4, Arabic/RTL,
all assets bundled locally (font: Readex Pro from `@fontsource/readex-pro`, no CDN).

## Dependencies

`onebase` and the component monorepo are git dependencies pinned to commits (see `package.json`):

| | repo | commit |
|---|---|---|
| `onebase` | github.com/abdullah-bl/onebase | `da26936` |
| `onebase-components` | github.com/abdullah-bl/onebase-components | `50b98c2` |

Bun can't install a subdirectory of a git repo, so `@onebase/teams` is imported by its path inside
the monorepo: `onebase-components/packages/teams/src/index.ts` (see `onebase/components.ts`).

## Run

```bash
bun install
bun run build                 # frontend -> dist/
bun run serve                 # onebase serve --port 8090 --public dist   (http://localhost:8090)
```

Development: `bun run dev:backend` (onebase dev on :8090) and `bun run dev:web` (Vite on :5173,
proxies `/api` + WebSocket + `/download` to :8090).

### First admin (bootstrap)

1. Start the server, open the app, and create an account (it is born `pending`).
2. With the server running, on the server machine:
   ```bash
   bun scripts/bootstrap-admin.ts admin@example.org "اسم الإدارة"
   # ONESPACE_URL=http://127.0.0.1:8090, admin key from ONEBASE_ADMIN_KEY or ./onebase_data/admin.key
   ```
   This calls the internal mutation `admin:bootstrap` through the admin API (admin key required).
   It creates the workspace (a `@onebase/teams` team with roles `admin|member`), makes that account
   the workspace admin and creates its personal space. It refuses once a workspace exists.
3. Everyone else signs up and waits on the "pending" screen until the admin clicks
   "إضافة لمساحة العمل" (which also creates their personal space). Check the person behind an email
   before activating: there is no email verification.

## Permission model (where it lives)

- `onebase/access.ts` — the only checkpoint: `requireActive`, `requireAdmin`,
  `assertCan(ctx, userId, spaceId, "read"|"write"|"manage")`, `readableSpaceIds(ctx, userId)`.
  Fail-closed: missing status = pending, unknown role/space/error = denied; "not found" and
  "forbidden" give the same message so ids can't be probed.
- Identity only from `getAuthUserId`. No public function takes a "who am I" userId (the `userId`
  args that exist are targets: the member to add, the audit filter).
- Roles: personal space → owner (read/write); shared → manager (read/write/manage), member
  (read/write), reader (read); `everyone` space → every active workspace member reads.
  The workspace admin sees shared spaces' existence + managers (`admin:spaces`) but not their
  files unless a member. Files leave a `sensitive` space only by its manager.
- Downloads: **OneBase serves `/api/storage/<id>` to anyone who has the id (verified; see tests)**,
  so storage ids/URLs are never sent to the client. Downloads go through `GET /download`
  (`onebase/http.ts`): either a one-time ticket from `files:requestDownload` (60 s, single use) or
  `?fileId=` with `Authorization: Bearer <session>`. Access is checked again at download time, and
  opens/downloads in sensitive spaces are audited. Files are served as attachments (`nosniff`, CSP
  sandbox), inline only for images/PDF/plain text.
- `auditLog` is append-only (only `writeAudit` inserts). Admin sees everything with filters
  (user/space/period); file names in spaces the admin can't read are shown as `•••`. A space
  manager sees their space's log.

## Tests

```bash
bun test tests          # starts real onebase servers on temp dirs (+ a fake model server); ~25 s
```

- `tests/permissions.test.ts`: the matrix — 15 operations × 4 spaces (personal, shared,
  everyone, sensitive) × 8 actors (workspace admin, manager, member, reader, non-member, pending,
  disabled, anonymous), plus every admin-only function × 8 actors, checked against an independent
  role model (`tests/fixture.ts`). A final test asserts every public function is covered.
- `tests/acceptance.test.ts`: one block per Phase 1 acceptance checkbox, the storage-URL finding,
  move/copy with versions, audit log behaviour, guard rails.

## Phase 2: RAG and chat

Chat on the documents a user may read, with numbered citations (plans/03-rag.md).

### Model servers (environment)

Read by `onebase/ai.ts` on every call (set with `onebase env set` or the process environment).
`EMBED_DIMENSIONS`, `GPU_SLOTS`, `CHAT_BURST`, `CHAT_RATE_PER_MIN` are read when `components.ts`
is loaded, so they must be in the server's **process** environment at start-up.

| var | bench/servers.sh value | |
|---|---|---|
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | `http://127.0.0.1:8401/v1`, `qwen3.8-27b` | answers, tools, OCR (mmproj) |
| `LLM_FAST_BASE_URL`, `LLM_FAST_MODEL` | `http://127.0.0.1:8402/v1`, `lfm3-1.7b` | follow-up rewriting (JSON-schema constrained) |
| `EMBED_BASE_URL`, `EMBED_MODEL`, `EMBED_DIMENSIONS` | `http://127.0.0.1:8403/v1`, `embeddinggemma-2`, `768` | measured: 768 |
| `EMBED_QUERY_PREFIX`, `EMBED_DOC_PREFIX` | defaults: `task: search result \| query: ` / `title: none \| text: ` | set to empty to turn off |
| `RERANK_BASE_URL`, `RERANK_MODEL` | `http://127.0.0.1:8404/v1`, `qwen3-reranker-0.6b` | optional; unset = no rerank |
| `RAG_ABSTAIN_SCORE` | `0.01` (measured, see eval) | best rerank score below this → "لم أجد هذا…" |
| `GPU_SLOTS` | `4` (= llama-server `-np`) | work-queue parallelism for chat turns |
| `CHAT_BURST`, `CHAT_RATE_PER_MIN` | `6`, `10` | per-user token bucket |
| `LLM_THINKING=1`, `VISION_BASE_URL/MODEL`, `OCR_MAX_PAGES` | off, main model, 50 | |

The status dot in the chat screen calls `ai:status` (each server's `/models`). Without
`EMBED_BASE_URL` uploads still work; their index state shows "فشل: الفهرسة غير مفعّلة".

**Embedding model pin.** The first ingest stores the embedding model, size and prefixes in
`aiSettings`; ingest and search refuse to run if the environment differs (a different model means a
full re-index). To change model on purpose: set the new env (and `EMBED_DIMENSIONS`, then restart),
run `ai:repinEmbedding` then `ingest:reindexAll` with the admin key.

### Pipeline (`onebase/ingest.ts`, `onebase/lib/*`)

`files:create|uploadVersion|copy` → `scheduleIngest` → a `workflow` run: extract (pdftotext per page
with repeated header/footer removal; pages without text → `pdftoppm` → vision model, file marked
OCR; `.docx` via `unzip` with heading styles, tables and Word's rendered page breaks; `.xlsx/.csv`
described — sheets, columns, row count — not chunked; `.doc/.xls/.odt` converted by LibreOffice) →
normalize (diacritics, tatweel, digits) → structural chunks (`الباب › الفصل › المادة`, long articles
split on sentences with overlap, tables kept whole) each starting with
`[document | section | ص n]` → `chunks` table (with a folded, prefix-stripped shadow for Arabic
keyword search) + the `rag` component (namespace = space id, vectors) → wait for embeddings → ready.
Server needs `poppler-utils`, `unzip`, and `libreoffice` for legacy formats.
`files:remove` deletes from the index in the same mutation; `files:move` takes the file out of the
old namespace at once and re-embeds it into the new one; a new version `replace`s (old chunks
serve until the new ones are ready). Space membership needs nothing: search reads
`readableSpaceIds` on every question.

### Answering (`onebase/chat.ts`, `onebase/search.ts`, `onebase/tools/`)

`chat:send` (owner check, per-user rate limit) saves the question and queues `runTurn` on the
`gpu` work-queue (`maxParallelism = GPU_SLOTS`; others see "في الانتظار — أمامك n"). `runTurn`:
rewrite a follow-up with the fast model → **mandatory** `searchDocuments` (spaces =
`readableSpaceIds ∩ thread scope`, recomputed per call; vector per namespace + keyword per space
filter → RRF → rerank top 30 → top 6) → abstain if nothing passes `RAG_ABSTAIN_SCORE` (naming
the nearest documents) → stream the answer (`createStream/addDelta`) with numbered sources and the
tool registry (`search_documents`, `read_file`, …) running with the user's `ToolContext`; write
tools (`requiresConfirmation`) are never run from the model → save the message +
`messageMeta` (citations `{n, fileId, fileName, page, section, quote}`, tool runs, abstained,
usage) → `ai.turn` audit row per space whose content was used. Threads are private: every
`chat:*` function checks `threadMeta.userId` before a threadId reaches the agent component.

### Tests and evaluation

`tests/fake-ai.ts` is a deterministic OpenAI-compatible fake (hashed bag-of-words embeddings,
keyword-overlap rerank, a chat model that echoes its sources with `[n]` and **obeys**
`CALL_TOOL` instructions found in documents). `tests/rag.test.ts` (pipeline, versions/moves/
deletes, abstention, rewrite, streaming, queue, rate limit, model pin) and
`tests/rag-security.test.ts` (matrix for every new public function, 20-phrasing leak test ×4
users, injection test, removal test).

```bash
bun scripts/build-golden.ts ../bench/data   # eval/golden.json: 12 docs, 120 + 15 unanswerable questions
bun scripts/eval-rag.ts --turns 60          # needs bench/servers.sh running; writes eval/results-<date>.json
```

## Backup and restore

OneBase backs up SQLite (consistent `VACUUM INTO` snapshot) and the files dir to any S3-compatible
store. Set `ONEBASE_SECRET_KEY` (≥32 chars) to encrypt snapshots and files; keep it outside the bucket.

```bash
./scripts/local-s3.sh                                   # local SeaweedFS S3 (Docker), prints an s3:// URL
export ONESPACE_BACKUP='s3://onespace-backups/onespace?endpoint=http://127.0.0.1:18333&region=us-east-1&accessKeyId=local&secretAccessKey=local'
./scripts/backup.sh                                     # one-off backup
onebase serve --public dist --backup "$ONESPACE_BACKUP" --backup-every 1h   # scheduled
./scripts/restore.sh /srv/onespace/onebase_data         # stop the server first; AT=... FORCE=1 optional
bun scripts/backup-restore-test.ts                      # full drill (below)
```

`scripts/backup-restore-test.ts` builds a workspace, backs it up (encrypted), restores into a
**clean, non-existent directory**, starts a second server on it and checks sign-in, spaces, file
bytes for current and old versions, permissions and the audit log. Passed on 2026-11-18.
For production, point the backup at a second disk or machine (MinIO/SeaweedFS), not the same disk.

## AD/LDAP (not built yet — decision note)

OneBase has no LDAP; it supports OIDC providers (`oidc({ issuer, clientId, clientSecret })` as a
sign-in method, or JWT `providers`) and a custom `authenticate(token, ctx)` hook.

| | OIDC bridge (Keycloak/Authentik/Dex federating AD) | Custom login against AD |
|---|---|---|
| OneBase side | `oidc()` method; nothing custom. Users land in `users` like any sign-in | An action that does an LDAP bind (e.g. `ldapts`) and then needs to **issue a OneBase session** |
| Gap | none in OneBase; one more service to run | OneBase has no API for a function to mint a built-in session. `authenticate` only verifies tokens, so we'd have to sign our own JWTs (custom JWT provider + JWKS) and then users are identified by `tokenIdentifier`, not `getAuthUserId` |
| Recommendation | **Preferred**: standard, MFA/SSO for free, no secrets in the app | Only if no extra service is allowed; propose upstream `ctx.auth.createSession(userId)` first |

Either way a directory login never implies membership: new accounts stay `pending` until the
workspace admin activates them (same `profile` hook / status check).

## Known limits / next

- No email verification and sign-up can't be closed (OneBase has no switch): mitigated by `pending`.
- Disabling a user blocks all functions immediately, but their OneBase session isn't revoked
  (no API from functions); they just see the "disabled" screen.
- Download tickets are bearer links for 60 s / one use, bound to the issuing user's access.
- `ONEBASE_SECRET_KEY`, disk encryption (LUKS) and TLS are deployment tasks (plans/02).
