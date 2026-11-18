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

## Phase 3: tasks, notifications, space instructions

- `onebase/tasks.ts` — a task lives in one **shared** space (`spaceId`, title, body, assignee, due,
  priority `low|normal|high|urgent`, status `new → inProgress → review → done`, links, threadId) with
  `taskComments`. Checks go through `access.ts` (`assertTaskCan`, `canBeAssignee`), fail-closed, and
  every lookup by id answers with the same "not found" message.

  | | view | comment | attach / thread | forward (new→inProgress→review) | close / return / reopen | create / assign / edit / delete |
  |---|---|---|---|---|---|---|
  | space manager | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
  | assignee | ✓ | ✓ | ✓ | ✓ | – | – |
  | member | ✓ | ✓ | – | – | – | – |
  | reader | ✓ | – | – | – | – | – |
  | "everyone" readers, workspace admin (unless named), non-members | – (not even existence) | | | | | |

  Decisions: readers *see* tasks (they are named members) but don't comment; tasks are **not** shown
  to the implicit readers of an "everyone" space (it's for publishing, not work allocation); personal
  spaces have no tasks. A task is assigned only to an active **manager or member** of its space
  (readers can't write, so they couldn't attach output). Removing someone from the space removes the
  task (and its notifications) from them at once; the board flags the assignee as no longer a member.
  Closed tasks are locked for attachments until a manager reopens them.
- **Links** are `{type: "file" | "artifact", id}` and must be in the task's own space: checked when
  added (a file from another space gets the same answer as a missing one) and again on every read (a
  file moved out later shows as "unavailable", no name). `artifact` resolves against an `artifacts`
  table with `spaceId` + `title` (Phase 4); until that exists, artifact links are refused.
  `threadId` is a generic string for the Phase 2 chat thread (`tasks:setThread`); it grants nothing.
- "اعمل عليها مع الوكيل" links to `/chat?taskId=<id>` (placeholder; Phase 2's chat reads it).
- **Notifications**: `@onebase/notifications` mounted as `notes`; `onebase/notifications.ts` wraps it
  (subject = session user only; the component's functions are not public). Sent on: assigned
  (assignee), status → review (space managers), closed / returned / reopened (assignee), comment
  (assignee + managers), never to the actor and only to people who can still view the task. The feed
  hides notifications for tasks the reader can no longer see. No email channel.
- **Audit**: `task.assign` (create and reassign), `task.close`, `task.reopen`, `task.delete`,
  `space.instructions`. `taskTitle` is redacted (`•••`) for viewers who can't read the space.
- **Space instructions** (`spaces:setInstructions`, returned by `spaces:get`): optional text for the
  space as a "project", set by its manager, read by anyone who reads the space.
- UI: `src/TasksView.tsx` (مهامي, board, detail), `src/NotificationBell.tsx`,
  `src/SpaceInstructions.tsx`; one nav entry + the bell in `App.tsx`, two tabs in `SpaceView.tsx`.

**`@onebase/email` resolution (upstream issue).** `@onebase/notifications` imports its sibling
`@onebase/email` by package name, which only resolves inside the monorepo's own workspace, not when
the repo is installed as a git dependency. `onebase/components.ts` registers `@onebase/email` as a Bun
virtual module (pointing at `onebase-components/packages/email/src/index.ts`) and then imports
notifications dynamically; `tsconfig.json` has a matching `paths` entry for `tsc`.

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
- `tests/tasks.test.ts`: one block per Phase 3 acceptance checkbox (assign → notified → attach →
  review → close; visibility and assignment limits; same-space attachments), status rules,
  notifications, space instructions. The matrix covers every task function with a separate task
  role model (`taskView|taskComment|taskManage|taskWork` in `tests/fixture.ts`).


## Phase 5: sandbox analysis and ranking (المفاضلة)

**Sandbox.** `../sandbox-runner` (see its README) is a separate local service and the only thing
with Docker access. OneBase reads `SANDBOX_URL` + `SANDBOX_SECRET` from its environment.

- `onebase/tools/run_analysis.ts` — the agent tool (`requiresConfirmation: true`). `run(t, {code, fileIds, targetSpaceId?, timeoutSeconds?})`:
  `analysis:begin` (internal mutation) checks every file with `assertCan(read)` **for the user**,
  requires it to be in `t.scopeSpaceIds`, checks `write` on the target, keeps outputs of a
  `sensitive` space in that space unless the user manages it, records the `runs` row and audits
  `sandbox.export` (per file) + `sandbox.run`. Only then are those files' bytes read from storage
  and sent to the runner. `analysis:finish` re-checks `write` and stores `/output` files as regular
  files in the target space (audited `file.upload` via sandbox).
  **Phase 4 integration point:** outputs are plain files for now; after the merge `finish` should
  also create an artifact (`artifactVersions.runId`) and the tool should return `artifactIds`.
- `analysis:run` (public action, the UI's "شغّل"), `analysis:myRuns`, `analysis:getRun` (runs are
  private to who ran them: a run names inputs from spaces others may not read).
  `analysis:runToolAs` (internal) calls `tool.run()` with a ToolContext — used by tests and by the
  Phase 6 agent loop.
- `runs`: kind, user, target space, code + sha256, inputs (file id, name, hex sha256 of the exact
  bytes sent), outputs (file id, sha256), limits, exit (code, timedOut, oomKilled, duration), stdout/stderr.

**Ranking.** The model never ranks and never proposes weights.

- `onebase/lib/ranking.ts` — the pure function: per criterion `w × (v − min) ÷ (max − min)`
  (or `(max − v)` when lower is better), values clamped to the declared scale, missing = 0 (flagged),
  rounded to 6 decimals in a fixed order; sort by total, then the tie-break fields, shared rank when
  everything is equal (1, 2, 2, 4), display order by id code points (no locale).
- `rankingCriteria` — name, version, `seriesId`, fields, weights, direction, scale, tie-breaks,
  `specHash`; draft (editable by writers) → approved (by the space manager, or the owner of a
  personal space) → frozen; changes are `newCriteriaVersion`.
- `rankingSnapshots` — the parsed input table as canonical JSON in storage + sha256 + source file
  id/version. `rankingRuns` — criteria id/version/hash, snapshot id/hash, results hash, algorithm
  version, draft → approved; `approveRun` only moves draft → approved and nothing else patches a run.
  Corrections are `rerun` (same snapshot, verified by hash, optionally a newer approved criteria
  version) → a new draft with `correctsRunId`. `rankingResults` — per student rank, total, per-criterion breakdown.
- `ranking:justification` — the per-student page: their data as in the snapshot, the formula, each
  criterion's line (`60 × (4.5 − 0) ÷ (5 − 0) = 54`), total, rank of N, ties, hashes, approval.
- Input: a CSV/XLSX file in the criteria's space, parsed by code (`lib/tabular.ts`, no deps).
  `lib/records.ts` is the seam for Phase 4's `records_*` tables (add a `RecordRef` kind; nothing else changes).

UI: `src/AnalysisView.tsx` (🧪 التحليل) and `src/RankingView.tsx` (⚖️ المفاضلة, with the
justification page). Tests: `tests/phase5.test.ts` (acceptance), `tests/phase5.permissions.test.ts`
(matrix for every Phase 5 function), `tests/ranking.unit.test.ts`. Sandbox tests start the real
runner (`tests/sandbox.ts`) and skip themselves when Docker or the image is missing.

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
