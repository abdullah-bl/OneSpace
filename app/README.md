# OneSpace (مساحة) — Phase 1: الأساس

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
bun test tests          # starts real onebase servers on temp dirs; ~5 s
```

- `tests/permissions.test.ts`: the matrix — 15 operations × 4 spaces (personal, shared,
  everyone, sensitive) × 8 actors (workspace admin, manager, member, reader, non-member, pending,
  disabled, anonymous), plus every admin-only function × 8 actors, checked against an independent
  role model (`tests/fixture.ts`). A final test asserts every public function is covered.
- `tests/acceptance.test.ts`: one block per Phase 1 acceptance checkbox, the storage-URL finding,
  move/copy with versions, audit log behaviour, guard rails.

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
