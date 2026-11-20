# 13 — Building apps («تطبيقات»)

## Why

Asked «سوّ لي اختبار تحديد مستوى وانشره للطلاب», the assistant could only use a feature built for that one case. Publishing (plans/11, step 4) had a quiz mode: a key in `form.quiz`, marking in `markQuiz`, shuffling in `seededShuffle`, and a check for leaked answers in `answersShown`. It worked for quizzes only.

A registration with seat limits, a price calculator, a sign-up with validation, or a quiz that marks open answers would each need another mode. That breaks the platform's rule: we ship general tools, and the assistant builds what each request needs.

Claude Code works from a few general tools and a loop:
1. write files;
2. run them;
3. look at the result;
4. fix and repeat.

This plan gives the assistant the same loop for small web apps that people open from a link.

## What

### 1. An app is an output with files

An **app** is an output (`artifacts`) of kind `app`. It is versioned, placed and audited like any output. A version's content is JSON:

```json
{ "files": { "index.html": "…", "app.js": "…", "style.css": "…", "data/questions.json": "…",
             "server/mark.py": "…", "server/key.json": "…" },
  "data":  { "results": { "listId": "…", "write": "handler", "read": "none", "columns": ["الاسم", "الدرجة"], "sender": "المرسل" } } }
```

- **Files:**
  - text files only;
  - paths of letters, digits, `_ . / -`, with no `..`;
  - at most 40 files and 500 KB per version;
  - `index.html` is the entry.
- **`server/…` files are private:**
  - handlers (`server/<name>.py`);
  - their data, such as an answer key, prices or rules.

  They are never served, never put into the page, and never sent to the visitor's browser.
- **Every other file is public:**
  - `index.html`, plus any `.js` and `.css` it links, are inlined into the page;
  - data files reach the page's code as `onespace.file(path)` and `onespace.json(path)`.
- **`data` (grants):** which lists the app may touch, and how. See §2.

### 2. Data grants: what the app may do with lists

An app reaches lists only through the **data API**, by an alias it declares. Each alias is one list of the app's own space, with:

| | values | meaning |
|---|---|---|
| `write` | `none` · `page` · `handler` | who may add rows:<br>• `page`: the page's code (`onespace.append`);<br>• `handler`: only server-side handlers.<br>Rows a visitor must not forge, such as a score or a price, use `handler`. |
| `read` | `none` · `own` · `aggregate` | • `own`: the rows this visitor added through this page;<br>• `aggregate`: counts per option and number statistics, never rows. |
| `columns` | names (optional) | the only columns it may write or aggregate (default: all but person columns) |
| `sender` | a person column (optional) | the server fills it with the signed-in visitor; the page can't set it |

- **Nothing else:**
  - no update, no delete;
  - no reading other visitors' rows;
  - no list outside the grants.
- **Enforcement:** checked on the server on every call, against the grants of the **published version**. The grants a draft declares only matter in a test (§4), where nothing is written.
- **The publish card lists them** in words, for example «يضيف صفوفاً إلى «نتائج الاختبار» عبر منطق الخادم فقط · لا يقرأ شيئاً». The card pins the version, so what is approved is exactly what goes live. A later edit needs «حدّث المنشور», and a member's update waits for a manager again (plans/11).
- **Publishing checks:**
  - a granted list must be in the app's space;
  - the publisher must be able to write it (for `write`) or read it (for `read`);
  - a list in a sensitive space keeps the app inside its space, the same rule as a sensitive output.

### 3. Server-side handlers

A handler is Python the assistant writes in `server/<name>.py`, with `def handle(request):`. The page calls it with `await onespace.call("<name>", payload)`. It runs in the existing sandbox: a fresh container, no network, 10 s, 256 MB.

- **What `request` holds:**
  - `payload`: what the page sent (untrusted);
  - `visitor`: `{ signedIn, name, rows }`, where `rows` is how many rows this visitor already added through this page, for «once per person»;
  - `test`: true in a self-test.
- **What it can read:** the app's `server/` files, at `/input/<name>`.
- **What it returns:** `{ "response": …, "rows": [{ "list": "<alias>", "cells": { "<column>": value } }] }`.
  - `response` goes back to the page.
  - `rows` are written only if the alias grants `write` (`page` or `handler`), only to its columns, and through the same cell checks as the list page.
- **Errors:**
  - the visitor sees «تعذّر إكمال الطلب»;
  - a self-test shows the traceback.

A quiz is marked by a handler the assistant writes for that quiz: the key sits in `server/key.json`, and the score and level are rows it returns. Pricing, seat limits and validation are done the same way.

### 4. Self-test: `test_app`

The assistant opens its own app in a headless browser (Chrome over the DevTools protocol, run by the server) and drives it:
- steps such as `fill`, `click`, `select`, `check`, `wait`;
- `expect`, which checks that some text is shown.

It gets back:
- console errors and warnings, uncaught exceptions and CSP violations;
- failed requests;
- each data-API call with its result, and handler tracebacks;
- the rows that **would** be written;
- the page's visible text, at the end and after any step that fails.

- **The draft runs from a short-lived test link** (`/t/<token>`, 10 minutes) on the content origin. It runs under the same CSP and bundle as a published page.
- **Writes are dry-run:** nothing is added to any list, and «own» reads return only the test's own dry-run rows. Handlers do run, in the sandbox.
- **The browser leaves the content origin for nothing:** every request goes through CDP interception, and anything that isn't the test page or its API is blocked and reported.
- **No card:** `test_app` changes nothing, so the loop (write → test → fix → test) runs inside one answer, within the turn's tool-round and time limits.

### 5. Serving an app (the content origin, plans/11 §2 unchanged)

`/p/<slug>` of an app publication serves **one HTML document** built by the server:
- the app's `index.html`, with its `<meta>` tags removed;
- its linked local `.js` and `.css` inlined;
- our small bootstrap first, which defines `onespace` and its token.

Headers:
- `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none'; script-src 'sha256-…' (each inline script of this response); style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src <origin>/a/<slug>; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`.
  - Scripts the app wrote run.
  - Scripts injected later (stored rows rendered as HTML) and inline `on…=` handlers don't, because they have no hash.
  - The page can talk only to its own API.
- **The data API:** `POST <origin>/a/<slug>`, with a `text/plain` JSON body (a simple request, no preflight).
  - The page is sandboxed (an opaque origin, no cookies), so it carries a token embedded in the page, the same scheme as forms:
    - private pages: derived from the reader's page session;
    - public pages: from a per-page secret, the hour and a per-load visitor key.
  - Rate limits per address and per page apply to public pages.
- **Unchanged:** tickets, audiences, policy, revoking and 410.

### 6. The assistant's tools

| tool | what | tier |
|---|---|---|
| `write_app` | creates an app, or writes, replaces or deletes (`null`) some of its files and its `data`, as a new version. With `fromSkill`, it starts from a saved skill's app. | like `create_artifact` and `update_artifact`: tier 1 in my personal space (with «تراجع»), else a card |
| `read_app` | the app's files (all, or one) and its grants | read |
| `test_app` | §4 | read (dry-run) |
| `publish_output` | publishes an output; for an app, its pinned version and grants | 2, or 3 for `public` |

- Edits of one app don't count towards the per-answer cap of five actions: it is one output with versions.
- **A longer turn budget.** A turn that calls `write_app` gets 8 minutes and 40K completion tokens (`APP_TURN_BUDGET_MS`, `APP_TURN_MAX_COMPLETION_TOKENS`) instead of 150 s and 16K, because the local model writes about 13 tokens a second and a whole app is several thousand. This stays under the GPU queue's 10-minute job limit.
- **Leak check.** `write_app` and `test_app` report any record of a `server/` file copied into a public file when it carries a short value field besides what a page shows (ids, texts, options), which is the shape of a copied answer, internal price or rule. `test_app` doesn't give ✅ while one is reported.
  - Found in the first real-model run: the model put the questions in `app.js` with their answer index while also keeping the key in `server/`.
  - In the second run, the warning was quiet for questions repeated next to a separate key, and the key stayed in `server/` only.
- The prompt teaches the loop: plan the files → `create_list` for results → `write_app` → `test_app` with realistic steps → fix until clean → `publish_output`.

### 7. Skills

«احفظ كمهارة» after building an app keeps the latest app of the chat, with its files and handlers (including `server/`), as skill files under `app/…`. Secrets are masked, and a sensitive space's app stays in that space, as other captured files do.
- `use_skill` lists them.
- `write_app` with `fromSkill: "<name>"` starts a new app from them. The assistant then changes what the new request needs: questions, key, list.
- Grants are not kept. A new app gets its own lists.

### 8. In the app

- **The side panel shows an app as its files:**
  - a tab per file, with `server/` files marked «خاص بالخادم»;
  - its grants;
  - «جرّبه», which opens a test link on the content origin, where nothing is saved.
- **«انشر» and «منشوراتي»** show an app publication's grants.
- **The form editor** keeps plain declared forms (plans/11 §3). Its quiz part is gone.

## Rules (each covered by tests)

1. `server/` files never reach the browser: not in the page, not through `onespace.file`, and not over any URL.
2. The data API enforces the published version's grants. Concretely:
   - `append` only on a `write: page` alias;
   - handler rows only on a `write` alias;
   - only granted columns;
   - `sender` set by the server only;
   - `own` returns only that visitor's rows;
   - `aggregate` never returns rows.
3. Every API call checks the publication is live and the token is valid for that page (and that reader), and applies rate limits on public pages.
4. A test writes nothing, and its link expires. Its browser can't reach anything outside the test page and its API.
5. A page's scripts run only by hash. Its only connection is its own API. It is never framed, and never shares the app's origin.
6. Publishing an app shows and pins its grants. The lists must be in its space, with the publisher's own write or read access.
7. The permission matrix covers every new public function (`apps:*`).

## Migration of quiz publications

Publications made with the old quiz mode are **migrated**, not kept on old code. `apps.migrateQuizForms` runs from a cron every 30 minutes, and does nothing once there are none. It turns each one into an app with:
- the old intro page;
- the same questions (the list's columns, the same options);
- `server/mark.py` and `server/key.json`, with the same key, points and levels;
- the same list, with `write: handler` and the same «المرسل» column;
- once per reader, if it was set.

The publication keeps its slug, so links still work.

## Build order

1. App outputs, the page bundle, the data API and grants. `write_app` and `read_app`.
2. Handlers in the sandbox.
3. `test_app` (Chrome over CDP).
4. Skills keep apps. `fromSkill`.
5. Remove the quiz mode, and migrate.
6. A real-model check: «سوّ لي اختبار تحديد مستوى في الإنجليزي من 10 أسئلة وانشره للطلاب».

## Later

- Binary assets (images, fonts) in apps.
- Updating rows (for example a registration's status) through a handler grant.
- Handlers in JavaScript as well as Python.
- A warm sandbox pool, if handler latency (one container per call) becomes a problem.
- `@onebase/static-hosting` once it has `siteId` and an app-callable publish (plans/06).
